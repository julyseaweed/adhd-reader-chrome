import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../src/pdf-zoom.js', import.meta.url), 'utf8'))
  .replace(/^export function /m, 'function ');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function harness({initialScale=1, height=1600, reduced=false, renderResult=true}={}) {
  let clock=0, nextTimer=0, currentScale=initialScale, top=height>500?300:0, left=0, allowed=true;
  const timers=new Map(), docEvents=new Map(), areaEvents=new Map(), renders=[];
  const shell={style:{width:600*initialScale+'px',height:height*initialScale+'px',marginTop:'0px'}};
  const page={style:{width:600*initialScale+'px',height:height*initialScale+'px',transform:''}};
  const area={clientWidth:800,clientHeight:500,clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:20,top:30,width:800,height:500}),
    contains:target=>target===area,
    addEventListener:(name,handler)=>areaEvents.set(name,handler),
    get scrollTop(){return top},set scrollTop(value){top=Math.max(0,Math.min(value,Math.max(0,parseFloat(shell.style.height)+(parseFloat(shell.style.marginTop)||0)-500)))},
    get scrollLeft(){return left},set scrollLeft(value){left=Math.max(0,Math.min(value,Math.max(0,parseFloat(shell.style.width)-800)))},
  };
  page.getBoundingClientRect=()=>{
    const factor=Number(/scale\(([^)]+)\)/.exec(page.style.transform)?.[1]||1);
    return{left:20+Math.max(0,(800-parseFloat(shell.style.width))/2)-left,
      top:30+(parseFloat(shell.style.marginTop)||0)-top,
      width:parseFloat(page.style.width)*factor,height:parseFloat(page.style.height)*factor};
  };
  const label={textContent:'100%'}, toolbar=Object.freeze({width:800,fontSize:14});
  const scope=vm.createContext({
    document:{addEventListener:(name,handler)=>docEvents.set(name,handler)},
    getComputedStyle:()=>({marginTop:shell.style.marginTop}),
    matchMedia:()=>({matches:reduced}),
    ResizeObserver:class{observe(){}},
    setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,at:clock+delay});return id},
    clearTimeout:id=>timers.delete(id),
  });
  vm.runInContext(source,scope);
  const zoom=scope.createPdfZoom({area,shell,page,label,enabled:()=>allowed,scale:()=>currentScale,
    interrupt(){},render:async(value,options)=>{
      renders.push({value,options});
      if(typeof renderResult==='function')return renderResult(value,options);
      if(renderResult===false)return false;
      currentScale=value;page.style.width=600*value+'px';page.style.height=height*value+'px';
      zoom.painted({width:600*value,height:height*value,scale:value});page.style.pointerEvents='';
      return true;
    }});
  const emit=(map,name,extra={})=>{
    const event={ctrlKey:true,deltaMode:0,deltaY:0,clientX:100,clientY:220,target:area,prevented:false,
      preventDefault(){this.prevented=true},...extra};map.get(name)?.(event);return event;
  };
  return{zoom,area,shell,page,label,toolbar,renders,timers,
    wheel:extra=>emit(docEvents,'wheel',extra),touch:(name,touches)=>emit(areaEvents,name,{touches}),
    previewScale:()=>currentScale*Number(/scale\(([^)]+)\)/.exec(page.style.transform)?.[1]||1),
    block(){allowed=false},
    async tick(ms){clock+=ms;const due=[...timers].filter(([,timer])=>timer.at<=clock);for(const[id,timer]of due){timers.delete(id);await timer.fn()}await Promise.resolve()},
  };
}

test('precision pinch has 1.5 times logarithmic gain and previews immediately before rendering',async()=>{
  const h=harness(),pointY=220,before=h.page.getBoundingClientRect(),v=(pointY-before.top)/before.height;
  const event=h.wheel({deltaY:-40});
  assert.equal(event.prevented,true);near(h.previewScale(),Math.exp(.12));
  near(Math.log(h.previewScale())/Math.log(Math.exp(.08)),1.5);
  assert.equal(h.label.textContent,'113%');assert.equal(h.renders.length,0);
  const after=h.page.getBoundingClientRect();near(after.top+v*after.height,pointY);
  near(after.left+after.width/2,420);assert.equal(h.toolbar.fontSize,14);
  await h.tick(79);assert.equal(h.renders.length,0);
  await h.tick(1);assert.equal(h.renders.length,1);near(h.renders[0].value,Math.exp(.12));
  assert.equal(h.zoom.active,false);
});

test('rapid trackpad events accumulate from the latest preview and defer only the raster work',async()=>{
  const h=harness();
  h.wheel({deltaY:-30});await h.tick(50);h.wheel({deltaY:10});
  near(h.previewScale(),Math.exp(.06));assert.equal(h.renders.length,0);
  await h.tick(79);assert.equal(h.renders.length,0);
  await h.tick(1);assert.equal(h.renders.length,1);near(h.renders[0].value,Math.exp(.06));
  const restored=h.page.getBoundingClientRect();near(restored.left+restored.width/2,420);
});

test('ordinary wheel remains native and line/page Ctrl-wheel retain their previous gain',()=>{
  const h=harness();assert.equal(h.wheel({ctrlKey:false,deltaY:-100}).prevented,false);
  assert.equal(h.page.style.transform,'');assert.equal(h.timers.size,0);
  const line=harness();line.wheel({deltaMode:1,deltaY:-1});near(line.previewScale(),Math.exp(16*.002));
  const page=harness();page.wheel({deltaMode:2,deltaY:-.1});near(page.previewScale(),Math.exp(50*.002));
});

test('touch pinch uses reciprocal amplified distance and follows its moving vertical midpoint',()=>{
  const h=harness(),touches=(span,y=220)=>[{clientX:420-span/2,clientY:y},{clientX:420+span/2,clientY:y}];
  const before=h.page.getBoundingClientRect(),v=(220-before.top)/before.height;
  h.touch('touchstart',touches(100));h.touch('touchmove',touches(120,250));
  near(h.previewScale(),Math.pow(1.2,1.5));
  const grown=h.page.getBoundingClientRect();near(grown.top+v*grown.height,250);near(grown.left+grown.width/2,420);
  h.touch('touchmove',touches(100));near(h.previewScale(),1);
  h.touch('touchmove',touches(80));near(h.previewScale(),Math.pow(.8,1.5));
  h.touch('touchend',[]);
});

test('strong pinches stay within the existing scale bounds and button increments are unchanged',()=>{
  const h=harness();h.wheel({deltaY:-100000});near(h.previewScale(),3);
  h.wheel({deltaY:100000});near(h.previewScale(),.35);
  const buttons=harness();buttons.zoom.step(.1);near(buttons.previewScale(),1.1);
  buttons.zoom.to(100);near(buttons.previewScale(),3);
  buttons.zoom.to(0);near(buttons.previewScale(),.35);
});

test('short-document inset still preserves vertical anchors when scroll offsets clamp',()=>{
  const h=harness({height:300}),pointY=230,before=h.page.getBoundingClientRect(),v=(pointY-before.top)/before.height;
  h.wheel({deltaY:60,clientY:pointY});
  const after=h.page.getBoundingClientRect();near(after.top+v*after.height,pointY);
  assert.ok(parseFloat(h.shell.style.marginTop)>0);
});

test('reduced motion still receives immediate gesture preview without animation frames',async()=>{
  const h=harness({reduced:true});h.wheel({deltaY:-20});near(h.previewScale(),Math.exp(.06));
  assert.equal(h.renders.length,0);await h.tick(80);near(h.renders[0].value,Math.exp(.06));
});

test('reset during the shorter debounce discards the gesture and unlocks document interaction',async()=>{
  const h=harness();h.wheel({deltaY:-30});await h.tick(60);h.zoom.reset();
  await h.tick(100);assert.equal(h.renders.length,0);assert.equal(h.zoom.active,false);
  assert.equal(h.page.style.transform,'');assert.equal(h.page.style.pointerEvents,'');
});

test('disabled readers and coincident touch points cannot start a zoom',()=>{
  const h=harness();h.block();assert.equal(h.wheel({deltaY:-30}).prevented,false);assert.equal(h.zoom.active,false);
  const touch=harness();touch.touch('touchstart',[{clientX:50,clientY:50},{clientX:50,clientY:50}]);
  touch.touch('touchmove',[{clientX:0,clientY:50},{clientX:100,clientY:50}]);
  assert.equal(touch.zoom.active,false);assert.equal(touch.page.style.transform,'');
});
