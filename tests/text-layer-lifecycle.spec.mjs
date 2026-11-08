import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

const executablePath=process.env.LINEA_CHROME||process.env.CHROME_EXECUTABLE;
test.use({browserName:'chromium',headless:true,viewport:{width:1200,height:900},
  launchOptions:executablePath?{executablePath}:{}});
test.setTimeout(60000);

async function prepare(page,fallback=false){
  await page.setContent('<style>.textLayer{position:relative;--min-font-size:1}.textLayer span{position:absolute;font:14px Arial;white-space:pre;height:16px}</style><div id="old">The old selected text stays readable during preparation.</div>');
  const source=await fs.readFile(new URL('../src/text-layer-layout.js',import.meta.url),'utf8');
  await page.addScriptTag({content:source.replace('export async function','async function')});
  await page.evaluate(fallback=>{
    if(fallback)Object.defineProperty(window,'scheduler',{value:undefined,configurable:true});
    const range=document.createRange();range.selectNodeContents(document.querySelector('#old'));
    getSelection().removeAllRanges();getSelection().addRange(range);
    const container=document.createElement('div');container.className='textLayer';
    const items=[],textDivs=[],mapped=new Map(),text='Many independently positioned letters retain their complete original Unicode text. '.repeat(2);
    for(let i=0;i<64;i++){
      const div=document.createElement('span');div.textContent=text;div.style.top=i*18+'px';container.append(div);textDivs.push(div);
      items.push({str:text,width:text.length*8,height:14,fontName:'F',transform:[14,0,0,14,0,750-i*18],dir:'ltr'});
      mapped.set(i,{advance:text.length*8,clusters:[...text].map((_,index)=>({start:index,end:index+1,offset:index*8,advance:8}))});
    }
    const state=window.layerPreparation={container,range,checks:0,cancelled:false,host:null,initial:getSelection().toString(),text,count:items.length,bodyCount:document.body.children.length};
    state.start=()=>{
      state.promise=alignTextLayer(container,textDivs,{items,styles:{F:{}}},{width:1600,height:1400,transform:[1,0,0,-1,0,1400]},mapped,{check(){
        state.checks++;if(container.parentElement?.getAttribute('aria-hidden')==='true')state.host=container.parentElement;
        if(state.cancelled)throw Object.assign(new Error('Preparation cancelled'),{name:'AbortError'});
      }}).then(()=>({status:'complete'}),error=>({status:error.name}));
    };
  },fallback);
}

test('cancelling hidden text preparation cleans its host and preserves the live selection',async({page})=>{
  await prepare(page);
  await page.evaluate(()=>{
    // A new user interaction has priority over the preparation's continuation.
    // Queue it in the same task so the check runs at an actual yield boundary.
    const cancel=()=>{layerPreparation.cancelled=true;};
    if(window.scheduler?.postTask)scheduler.postTask(cancel,{priority:'user-blocking'});
    else setTimeout(cancel,0);
    layerPreparation.start();
  });
  expect(await page.evaluate(()=>layerPreparation.promise)).toEqual({status:'AbortError'});
  const result=await page.evaluate(()=>({checks:layerPreparation.checks,connected:layerPreparation.container.isConnected,
    hostConnected:layerPreparation.host?.isConnected,selection:getSelection().toString(),initial:layerPreparation.initial,
    rangeConnected:layerPreparation.range.startContainer.isConnected,children:document.body.children.length,bodyCount:layerPreparation.bodyCount}));
  expect(result.checks).toBeGreaterThan(1);expect(result.connected).toBe(false);expect(result.hostConnected).toBe(false);
  expect(result.selection).toBe(result.initial);expect(result.rangeConnected).toBe(true);expect(result.children).toBe(result.bodyCount);
});

test('timer-yield fallback completes a long candidate without disturbing the old text',async({page})=>{
  await prepare(page,true);
  await page.evaluate(()=>layerPreparation.start());
  expect(await page.evaluate(()=>layerPreparation.promise)).toEqual({status:'complete'});
  const result=await page.evaluate(()=>({checks:layerPreparation.checks,connected:layerPreparation.container.isConnected,
    hostConnected:layerPreparation.host?.isConnected,selection:getSelection().toString(),initial:layerPreparation.initial,
    strings:[...layerPreparation.container.children].map(node=>node.textContent),text:layerPreparation.text,count:layerPreparation.count}));
  expect(result.checks).toBeGreaterThan(5);expect(result.connected).toBe(false);expect(result.hostConnected).toBe(false);
  expect(result.selection).toBe(result.initial);expect(result.strings).toEqual(Array(result.count).fill(result.text));
});
