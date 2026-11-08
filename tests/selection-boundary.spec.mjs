import {test,expect} from '@playwright/test';
import {PDFDocument,PDFArray,PDFDict,PDFName,StandardFonts,beginMarkedContent,endMarkedContent} from 'pdf-lib';
import fs from 'node:fs/promises';

const url=process.env.LINEA_TEST_URL||'http://127.0.0.1:4173';
const executablePath=process.env.LINEA_CHROME||process.env.CHROME_EXECUTABLE;
test.use({browserName:'chromium',headless:true,viewport:{width:1300,height:1000},deviceScaleFactor:1,
 launchOptions:executablePath?{executablePath}:{}});
test.setTimeout(90000);

// Independently authored PDF glyph advances are the oracle. Measuring the DOM
// Range first would reproduce the same fallback-font error as native caret hit tests.
async function fixture({prefix,phrase,suffix,fontName=StandardFonts.TimesRoman,split=false}){
 const doc=await PDFDocument.create(),sheet=doc.addPage([720,840]),font=await doc.embedFont(fontName),size=16,x=48,y=620,text=prefix+phrase+suffix;
 // Deliberately omit document language: the reader's Chinese UI can select a
 // different system fallback font than the original PDF's Latin font.
 sheet.drawText('This English paragraph explains the meaning of the words in a simple story.',{x,y:y+55,size:12,font});
 sheet.drawText('Read the sentence below and choose the exact letters that you want to translate.',{x,y:y+35,size:12,font});
 const advances=[0];for(const char of text)advances.push(advances.at(-1)+font.widthOfTextAtSize(char,size));
 if(split){let cursor=x;for(const segment of [prefix,phrase.slice(0,1),phrase.slice(1,-1),phrase.slice(-1),suffix]){
  sheet.pushOperators(beginMarkedContent('Span'));sheet.drawText(segment,{x:cursor,y,size,font});sheet.pushOperators(endMarkedContent());cursor+=[...segment].reduce((sum,char)=>sum+font.widthOfTextAtSize(char,size),0);
 }}else sheet.drawText(text,{x,y,size,font});
 return{bytes:Buffer.from(await doc.save()),text,phrase,prefix,start:prefix.length,end:prefix.length+phrase.length,x,y,size,advances,width:720,height:840};
}
async function ready(page){await expect(page.locator('#busy')).toBeHidden();await expect(page.locator('#page-wrap')).toHaveAttribute('data-ready','true');await expect(page.locator('#document-pages')).not.toHaveCSS('pointer-events','none');}
async function settle(page){await page.locator('#scroll-area').evaluate(area=>new Promise(resolve=>{let old=area.scrollTop,stable=0;const tick=()=>{const next=area.scrollTop;stable=Math.abs(next-old)<.05?stable+1:0;old=next;if(stable>=5)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick)}));}
async function setup(page,data){
 const requests=[];await page.route('**/dictionary/*.json',route=>route.fulfill({contentType:'application/json',body:'{}'}));
 await page.route('https://api.mymemory.translated.net/**',route=>{requests.push(new URL(route.request().url()).searchParams.get('q'));return route.fulfill({contentType:'application/json',body:JSON.stringify({responseStatus:200,responseData:{translatedText:'测试中文释义'}})});});
 await page.goto(url);await page.locator('#file-input').setInputFiles({name:'original-phrase-boundaries.pdf',mimeType:'application/pdf',buffer:data.bytes});await ready(page);await settle(page);return requests;
}
async function authoredPoints(page,data,start=data.start,end=data.end){
 await page.locator('#text-layer span').last().scrollIntoViewIfNeeded();await settle(page);
 return page.locator('#page-wrap').evaluate((node,{data,start,end})=>{const b=node.getBoundingClientRect(),scale=b.width/data.width,point=(offset,fraction)=>({x:b.left+(data.x+data.advances[offset]+(data.advances[offset+1]-data.advances[offset])*fraction)*scale,y:b.top+(data.height-data.y-data.size*.3)*scale});return{start:point(start,.15),end:point(end-1,.85),scale}}, {data,start,end});
}
async function drag(page,points,reverse=false){const[a,b]=reverse?[points.end,points.start]:[points.start,points.end];
 const before=await page.evaluate(({a,b})=>({a:document.elementFromPoint(a.x,a.y)?.outerHTML,b:document.elementFromPoint(b.x,b.y)?.outerHTML}),{a,b});
 await page.mouse.move(a.x,a.y);await page.mouse.down();const down=await selectionState(page);await page.mouse.move(b.x,b.y,{steps:16});const move=await selectionState(page);await page.mouse.up();await page.waitForTimeout(40);return{before,down,move,after:await selectionState(page)};}
async function selectionState(page){return page.evaluate(()=>{const s=getSelection();if(!s?.rangeCount)return{text:''};const r=s.getRangeAt(0);return{text:s.toString(),start:r.startOffset,end:r.endOffset,startText:r.startContainer.textContent,endText:r.endContainer.textContent}});}
async function zoomTo(page,target){
 while(Math.abs(parseFloat(await page.locator('#zoom-fit').textContent())-target)>1){
  const current=parseFloat(await page.locator('#zoom-fit').textContent()),old=await page.locator('#pdf-canvas').evaluate(node=>node.width);
  await page.locator(current<target?'#zoom-in':'#zoom-out').click();
  await expect.poll(()=>page.locator('#pdf-canvas').evaluate(node=>node.width)).not.toBe(old);await ready(page);
 }await settle(page);
}
async function checkGlyphGeometry(page,data){
 const result=await page.locator('#text-layer').evaluate((layer,data)=>{
  const box=layer.closest('.pdf-page').getBoundingClientRect(),scale=box.width/data.width,walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT),chars=[];let text='',offset=0;
  while(walker.nextNode()){
   const node=walker.currentNode,parent=node.parentElement.closest('span'),rect=parent?.getBoundingClientRect(),middle=box.top+(data.height-data.y-data.size*.3)*scale;
   if(!rect||Math.abs(rect.top+rect.height/2-middle)>data.size*scale*.7)continue;
   text+=node.textContent;
   for(let i=0;i<node.length;i++,offset++){
    const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);const b=r.getBoundingClientRect();
    const left=box.left+(data.x+data.advances[offset])*scale,right=box.left+(data.x+data.advances[offset+1])*scale;
    chars.push({char:node.textContent[i],left:b.left,right:b.right,expectedLeft:left,expectedRight:right,error:Math.max(Math.abs(b.left-left),Math.abs(b.right-right))});
   }
  }return{text,chars};
 },data);
 expect(result.text).toBe(data.text);expect(Math.max(...result.chars.map(char=>char.error)),'every glyph caret box follows its authored PDF advance').toBeLessThan(.6);return result;
}

for(const scenario of [
 {name:'leading letter',prefix:'The music ended with a ',phrase:'triumphant flourish',suffix:' before the quiet pause.'},
 {name:'trailing letter',prefix:'A quiet ',phrase:'temptation',suffix:' in a warm summer room.'},
])test(`PDF-authored ${scenario.name} stays in the selected phrase`,async({page},info)=>{
 const data=await fixture(scenario),requests=await setup(page,data),results=[];
 for(const zoom of [135,75,180]){
  await zoomTo(page,zoom);const geometry=await checkGlyphGeometry(page,data);
  for(const reverse of[false,true]){
   await page.keyboard.press('Escape');const points=await authoredPoints(page,data),trace=await drag(page,points,reverse);
   const state=await selectionState(page);results.push({zoom,reverse,points,state,geometry,trace});
   await fs.writeFile(info.outputPath('native-selection.json'),JSON.stringify({data:{...data,bytes:undefined},results},null,2));
   expect(state.text.trim()).toBe(data.phrase);await page.keyboard.press('Enter');await expect(page.locator('#translation-word')).toHaveText(data.phrase);await expect(page.locator('#translation-result')).toHaveText('测试中文释义');
   expect(requests.every(text=>text===data.phrase)).toBeTruthy();
  }
  await page.screenshot({path:info.outputPath(`native-selection-${zoom}.png`),scale:'css'});
 }
});

test('separate drawing runs retain exact first, last and partial-letter ranges',async({page},info)=>{
 const data=await fixture({prefix:'A quiet ',phrase:'temptation',suffix:' in a warm summer room.',split:true});await setup(page,data);
 for(const zoom of[135,75,180]){
  await zoomTo(page,zoom);await checkGlyphGeometry(page,data);expect(await page.locator('#text-layer span').count()).toBeGreaterThan(2);
  for(const reverse of[false,true])for(const[start,end]of[[data.start,data.end],[data.start,data.start+1],[data.start+2,data.start+3],[data.end-1,data.end]]){
   await page.keyboard.press('Escape');await drag(page,await authoredPoints(page,data,start,end),reverse);
   expect((await selectionState(page)).text.trim()).toBe(data.text.slice(start,end));
  }
  for(const offset of[data.start,data.start+3,data.end-1]){
   await page.keyboard.press('Escape');const point=(await authoredPoints(page,data,offset,offset+1)).start;
   await page.mouse.dblclick(point.x,point.y);await expect(page.locator('#selection-menu')).toBeVisible();
   expect((await selectionState(page)).text.trim()).toBe(data.phrase);
  }
 }await page.screenshot({path:info.outputPath('split-word-selection.png'),scale:'css'});
});

for(const fontName of[StandardFonts.Helvetica,StandardFonts.TimesRomanItalic])test(`author glyph bounds remain accurate with ${fontName}`,async({page})=>{
 const data=await fixture({prefix:'The music ended with a ',phrase:'triumphant flourish',suffix:' before the quiet pause.',fontName});await setup(page,data);
 for(const zoom of[135,75,180]){
  await zoomTo(page,zoom);await checkGlyphGeometry(page,data);
  for(const reverse of[false,true]){await page.keyboard.press('Escape');await drag(page,await authoredPoints(page,data),reverse);expect((await selectionState(page)).text.trim()).toBe(data.phrase);}
 }
});

test.describe('high-density displays',()=>{
 test.use({deviceScaleFactor:2});
 for(const split of[false,true])test(`native glyph edges remain exact at DPR 2 with ${split?'split':'whole'} drawing runs`,async({page},info)=>{
  const data=await fixture({prefix:'The music ended with a ',phrase:'triumphant flourish',suffix:' before the quiet pause.',split});await setup(page,data);
  for(const zoom of[75,135,180]){
   await zoomTo(page,zoom);await checkGlyphGeometry(page,data);
   for(const reverse of[false,true]){
    await page.keyboard.press('Escape');const points=await authoredPoints(page,data),trace=await drag(page,points,reverse);
    await fs.writeFile(info.outputPath(`selection-${zoom}-${reverse}.json`),JSON.stringify({points,trace},null,2));
    expect((await selectionState(page)).text).toBe(data.phrase);
   }
  }
 });
});

test('copy, highlight and underline retain the exact authored selection boundaries',async({page},info)=>{
 const data=await fixture({prefix:'The music ended with a ',phrase:'triumphant flourish',suffix:' before the quiet pause.',split:true});
 // Capture only this page's copy action; keep the user's system clipboard intact.
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedSelection=text;}}}));
 await setup(page,data);await zoomTo(page,75);
 await drag(page,await authoredPoints(page,data));await page.locator('[data-action="copy"]').click();
 expect(await page.evaluate(()=>window.copiedSelection)).toBe(data.phrase);
 for(const type of['highlight','underline']){
  await page.keyboard.press('Escape');const trace=await drag(page,await authoredPoints(page,data),type==='underline');
  await fs.writeFile(info.outputPath(`selection-${type}.json`),JSON.stringify(trace,null,2));
  expect((await selectionState(page)).text).toBe(data.phrase);
  await page.locator(`[data-action="${type}"]`).click();await expect(page.locator(`.annotation-group.${type}`)).toHaveCount(1);
 }
 const pending=page.waitForEvent('download');await page.locator('#save').click();
 const file=info.outputPath('authored-selection-annotations.pdf');await(await pending).saveAs(file);
 const pdf=await PDFDocument.load(await fs.readFile(file)),refs=pdf.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray);
 const expected=[data.x+data.advances[data.start],data.x+data.advances[data.end]],seen=[];
 for(const ref of refs.asArray()){
  const annotation=pdf.context.lookup(ref,PDFDict),type=annotation.get(PDFName.of('Subtype')).toString().slice(1);
  if(!['Highlight','Underline'].includes(type))continue;
  seen.push(type);const quads=annotation.lookup(PDFName.of('QuadPoints'),PDFArray).asArray().map(value=>value.asNumber()),xs=quads.filter((_,index)=>index%2===0);
  expect(Math.abs(Math.min(...xs)-expected[0])).toBeLessThan(.6);expect(Math.abs(Math.max(...xs)-expected[1])).toBeLessThan(.6);
  if(type==='Underline')expect(annotation.lookup(PDFName.of('C'),PDFArray).asArray().map(value=>value.asNumber())).toEqual([0,0,0]);
 }
 expect(seen.sort()).toEqual(['Highlight','Underline']);await expect(page.locator('#focus')).toHaveAttribute('aria-pressed','true');
});

test('native Shift arrows extend and shrink exactly one character through glyphs and spaces',async({page})=>{
 const data=await fixture({prefix:'The music ended with a ',phrase:'triumphant flourish',suffix:' before the quiet pause.'});await setup(page,data);
 for(const zoom of[75,135,180]){
  await zoomTo(page,zoom);await page.keyboard.press('Escape');
  await drag(page,await authoredPoints(page,data,data.start,data.start+2));
  expect((await selectionState(page)).text).toBe('tr');
  for(let length=3;length<=12;length++){
   await page.keyboard.press('Shift+ArrowRight');
   expect((await selectionState(page)).text).toBe(data.phrase.slice(0,length));
  }
  for(let length=11;length>=2;length--){
   await page.keyboard.press('Shift+ArrowLeft');
   expect((await selectionState(page)).text).toBe(data.phrase.slice(0,length));
  }
  await page.keyboard.press('Escape');
  await drag(page,await authoredPoints(page,data,data.start+data.phrase.length-2,data.end),true);
  expect((await selectionState(page)).text).toBe('sh');
  for(let length=3;length<=12;length++){
   await page.keyboard.press('Shift+ArrowLeft');
   expect((await selectionState(page)).text).toBe(data.phrase.slice(-length));
  }
  for(let length=11;length>=2;length--){
   await page.keyboard.press('Shift+ArrowRight');
   expect((await selectionState(page)).text).toBe(data.phrase.slice(-length));
  }
 }
});
