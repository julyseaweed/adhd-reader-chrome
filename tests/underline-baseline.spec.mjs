import {test,expect} from '@playwright/test';
import {PDFDocument,PDFArray,PDFDict,PDFName,PDFRawStream,StandardFonts,degrees,decodePDFRawStream,beginMarkedContent,endMarkedContent} from 'pdf-lib';
import fs from 'node:fs/promises';

const url=process.env.LINEA_TEST_URL||'http://127.0.0.1:4173';
const executablePath=process.env.LINEA_CHROME||process.env.CHROME_EXECUTABLE;
test.use({browserName:'chromium',headless:true,viewport:{width:1300,height:1000},deviceScaleFactor:1,
 reducedMotion:'reduce',launchOptions:executablePath?{executablePath}:{}});
test.setTimeout(90000);

// The oracle is the PDF writer's original baseline, never a DOM selection box
// or one of the reader's underline helpers. All fixture text is original.
const size=16,expectedGap=4.48,expectedThickness=.56,viewWidth=600,viewHeight=700;
function pdfPoint(x,y,rotation,width,height){
 if(rotation===90)return[y,x];
 if(rotation===180)return[width-x,y];
 if(rotation===270)return[width-y,height-x];
 return[x,height-y];
}
function viewPoint(x,y,{rotation,width,height}){
 if(rotation===90)return[y,x];
 if(rotation===180)return[width-x,y];
 if(rotation===270)return[height-y,width-x];
 return[x,height-y];
}
async function fixture(rotation=0){
 const pdf=await PDFDocument.create(),quarter=rotation%180!==0,width=quarter?viewHeight:viewWidth,height=quarter?viewWidth:viewHeight;
 const sheet=pdf.addPage([width,height]);sheet.setRotation(degrees(rotation));
 const fonts={roman:await pdf.embedFont(StandardFonts.TimesRoman),italic:await pdf.embedFont(StandardFonts.TimesRomanItalic),bold:await pdf.embedFont(StandardFonts.TimesRomanBold),sans:await pdf.embedFont(StandardFonts.Helvetica)};
 const descriptions=[
  [{text:'Calm still letters rest beside the stone.'}],
  [{text:'A gray puppy jogs quietly past a sleepy pond.'}],
  [{text:'Mixed faces keep '},{text:'italic words',face:'italic'},{text:' and bold words ',face:'bold'},{text:'on one line.'}],
  [{text:'Split drawing runs must share one baseline.',split:true}],
  [{text:'Small scripts '},{text:'2',em:9,rise:6},{text:' remain within one physical row.'}],
  [{text:'Mixed families '},{text:'share one baseline ',face:'sans'},{text:'through this sentence.'}],
 ];
 const rows=descriptions.map((runs,index)=>{
  const row={baseline:174+index*34,x:44,size,text:runs.map(run=>run.text).join(''),runs:[]};let cursor=row.x;
  for(const source of runs){
   const font=fonts[source.face||'roman'],em=source.em||size,rise=source.rise||0;
   const runWidth=[...source.text].reduce((sum,char)=>sum+font.widthOfTextAtSize(char,em),0);
   row.runs.push({...source,x:cursor,width:runWidth,size:em,baseline:row.baseline-rise,
    firstWidth:font.widthOfTextAtSize(source.text[0],em),lastWidth:font.widthOfTextAtSize(source.text.at(-1),em)});
   const pieces=source.split?[...source.text]:[source.text];let along=cursor;
   for(const text of pieces){
    const[x,y]=pdfPoint(along,row.baseline-rise,rotation,width,height);
    sheet.pushOperators(beginMarkedContent('Span'));sheet.drawText(text,{x,y,size:em,font,rotate:degrees(rotation)});sheet.pushOperators(endMarkedContent());
    along+=[...text].reduce((sum,char)=>sum+font.widthOfTextAtSize(char,em),0);
   }
   cursor+=runWidth;
  }
  row.width=cursor-row.x;row.firstWidth=row.runs[0].firstWidth;row.lastWidth=row.runs.at(-1).lastWidth;
  const firstWord=row.text.split(' ')[0],font=fonts.roman;
  row.spaceX=row.x+font.widthOfTextAtSize(firstWord,size)+font.widthOfTextAtSize(' ',size)/2;
  return row;
 });
 return{bytes:Buffer.from(await pdf.save()),rotation,width,height,viewWidth,viewHeight,rows};
}
async function ready(page){
 await expect(page.locator('#busy')).toBeHidden();await expect(page.locator('#page-wrap')).toHaveAttribute('data-ready','true');
 await expect(page.locator('#document-pages')).not.toHaveCSS('pointer-events','none');
}
async function importPDF(page,data,name='underline-baseline-fixture.pdf'){
 await page.locator('#file-input').setInputFiles({name,mimeType:'application/pdf',buffer:data.bytes});await ready(page);
}
async function zoomTo(page,target){
 while(Math.abs(parseFloat(await page.locator('#zoom-fit').textContent())-target)>1){
  const old=await page.locator('#pdf-canvas').evaluate(canvas=>canvas.width),current=parseFloat(await page.locator('#zoom-fit').textContent());
  await page.locator(current<target?'#zoom-in':'#zoom-out').click();
  await expect.poll(()=>page.locator('#pdf-canvas').evaluate(canvas=>canvas.width)).not.toBe(old);await ready(page);
 }
}
async function nativeDrag(page,data,first,last=first){
 await page.keyboard.press('Escape');
 const endpoints=await page.locator('#page-wrap').evaluate((node,{data,first,last})=>{
  const box=node.getBoundingClientRect(),scale=box.width/data.viewWidth;
  return{start:{x:box.left+(first.x+first.firstWidth*.1)*scale,y:box.top+(first.baseline-first.size*.3)*scale},
   end:{x:box.left+(last.x+last.width-last.lastWidth*.1)*scale,y:box.top+(last.baseline-last.size*.3)*scale}};
 },{data,first,last});
 await page.mouse.move(endpoints.start.x,endpoints.start.y);await page.mouse.down();
 await page.mouse.move(endpoints.end.x,endpoints.end.y,{steps:16});await page.mouse.up();
 await expect(page.locator('#selection-menu')).toBeVisible();
}
async function markRows(page,data,first,last=first){
 await nativeDrag(page,data,first,last);await page.locator('[data-action="underline"]').click();
 await expect(page.locator('.annotation-group.underline').last()).toBeAttached();
}
async function previewGeometry(page,data,selector='.annotation-mark.underline'){
 return page.locator(selector).evaluateAll((nodes,data)=>{
  const page=nodes[0]?.closest('.pdf-page'),box=page?.getBoundingClientRect(),scale=box?.width/data.viewWidth;
  return nodes.map(node=>{const r=node.getBoundingClientRect(),after=getComputedStyle(node,'::after'),thickness=parseFloat(after.height);
   const top=parseFloat(after.top),left=parseFloat(after.left)||0,length=parseFloat(after.width);
   return{x:(r.left+left-box.left)/scale,right:(r.left+left+length-box.left)/scale,
    y:(r.top+top-box.top)/scale,
    thickness:thickness/scale,color:after.backgroundColor};}).sort((a,b)=>a.y-b.y||a.x-b.x);
 },data);
}
function assertRows(actual,rows){
 expect(actual).toHaveLength(rows.length);
 for(let index=0;index<rows.length;index++){
  const observed=actual[index],row=rows[index];
  expect(Math.abs(observed.y-row.baseline-expectedGap),`row ${index+1} distance from independently authored PDF baseline`).toBeLessThan(.22);
  expect(Math.abs(observed.thickness-expectedThickness),`row ${index+1} thin stroke in PDF points`).toBeLessThan(.08);
  expect(Math.abs(observed.x-row.x)).toBeLessThan(.5);expect(Math.abs(observed.right-row.x-row.width)).toBeLessThan(.5);
  if(observed.color)expect(observed.color).toBe('rgb(0, 0, 0)');
 }
 const offsets=actual.map((line,index)=>line.y-rows[index].baseline);
 expect(Math.max(...offsets)-Math.min(...offsets),'font face, descenders and split runs do not change the gap').toBeLessThan(.22);
}
async function exportPDF(page,info,data,pageIndex=0){
 const pending=page.waitForEvent('download');await page.locator('#save').click();
 const file=info.outputPath(`underlines-${data.rotation}.pdf`);await(await pending).saveAs(file);
 const bytes=await fs.readFile(file),pdf=await PDFDocument.load(bytes),sheet=pdf.getPage(pageIndex),refs=sheet.node.lookup(PDFName.of('Annots'),PDFArray),strokes=[];
 for(const ref of refs.asArray()){
  const dict=pdf.context.lookup(ref,PDFDict);if(dict.get(PDFName.of('Subtype')).toString()!=='/Underline')continue;
  expect(dict.lookup(PDFName.of('C'),PDFArray).asArray().map(value=>value.asNumber())).toEqual([0,0,0]);
  const bounds=dict.lookup(PDFName.of('Rect'),PDFArray).asArray().map(value=>value.asNumber());
  const ap=dict.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N'),PDFRawStream),commands=new TextDecoder().decode(decodePDFRawStream(ap).decode());
  for(const match of commands.matchAll(/([-\d.]+) w\s+([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l S/g)){
   const start=viewPoint(Number(match[2])+bounds[0],Number(match[3])+bounds[1],data),end=viewPoint(Number(match[4])+bounds[0],Number(match[5])+bounds[1],data);
   expect(Math.abs(start[1]-end[1]),'PDF appearance remains one horizontal stroke in the reading frame').toBeLessThan(.001);
   strokes.push({x:Math.min(start[0],end[0]),right:Math.max(start[0],end[0]),y:(start[1]+end[1])/2,thickness:Number(match[1])});
  }
 }
 return{bytes,strokes:strokes.sort((a,b)=>a.y-b.y||a.x-b.x)};
}
async function reimportInk(page,data){
 return page.locator('#pdf-canvas').evaluate((canvas,data)=>{
  const context=canvas.getContext('2d'),scale=canvas.width/data.viewWidth;
  return data.rows.map(row=>{
   // Sample a known word space, where the source PDF has no glyph ink. The
   // only dark pixels here must come from the reimported annotation appearance.
   const x=Math.round(row.spaceX*scale),center=(row.baseline+4.48)*scale,top=Math.floor(center)-3;
   const pixels=context.getImageData(x,top,1,7).data;let mass=0,weighted=0;
   for(let index=0;index<7;index++){const darkness=1-(pixels[index*4]+pixels[index*4+1]+pixels[index*4+2])/(3*255);mass+=darkness;weighted+=(top+index+.5)*darkness;}
   return{mass,offset:(weighted/mass)/scale-row.baseline};
  });
 },data);
}
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await page.screenshot({path:info.outputPath('failure.png'),scale:'css'});});

for(const rotation of[0,90,180,270])test(`underlines use authored baselines through zoom, export and reimport at rotation ${rotation}`,async({page},info)=>{
 const data=await fixture(rotation);await page.goto(url);await importPDF(page,data);await zoomTo(page,135);
 await markRows(page,data,data.rows[0],data.rows.at(-1));
 const report=[];
 for(const zoom of[135,75,180]){
  await zoomTo(page,zoom);const actual=await previewGeometry(page,data);report.push({zoom,actual});
  await fs.writeFile(info.outputPath('baseline-geometry.json'),JSON.stringify({rotation,rows:data.rows,expectedGap,expectedThickness,report},null,2));
  await page.screenshot({path:info.outputPath(`underlines-${zoom}.png`),scale:'css'});assertRows(actual,data.rows);
 }
 const saved=await exportPDF(page,info,data);assertRows(saved.strokes,data.rows);
 await importPDF(page,{...data,bytes:saved.bytes},'reimported-uniform-underlines.pdf');await zoomTo(page,135);
 await expect(page.locator('.annotation-group.underline')).toHaveCount(0);
 const ink=await reimportInk(page,data);await fs.writeFile(info.outputPath('reimport-ink.json'),JSON.stringify(ink,null,2));
 for(const row of ink){expect(row.mass,'the imported PDF paints its underline in a source word space').toBeGreaterThan(.15);expect(Math.abs(row.offset-expectedGap)).toBeLessThan(.55);}
 await page.screenshot({path:info.outputPath('reimported-underlines.png'),scale:'css'});
});

test('selecting only italic text or a small superscript uses the complete physical row baseline',async({page},info)=>{
 const data=await fixture();await page.goto(url);await importPDF(page,data);await zoomTo(page,135);
 for(const[rowIndex,runIndex]of[[2,1],[4,1]]){
  const row=data.rows[rowIndex],run=row.runs[runIndex];await markRows(page,data,run);
  const actual=await previewGeometry(page,data,'.annotation-group.underline:last-child .annotation-mark');
  await fs.writeFile(info.outputPath(`partial-row-${rowIndex}.json`),JSON.stringify({row,run,actual},null,2));
  assertRows(actual,[{...row,x:run.x,width:run.width}]);
 }
});

test('overlapping selections on the same physical row do not create staggered double underlines',async({page},info)=>{
 const data=await fixture();await page.goto(url);await importPDF(page,data);await zoomTo(page,135);
 const row=data.rows[2],italic=row.runs[1];
 await markRows(page,data,italic);await markRows(page,data,row);
 await expect(page.locator('.annotation-group.underline')).toHaveCount(2);
 const actual=await previewGeometry(page,data);expect(actual).toHaveLength(2);
 for(const stroke of actual){
  expect(Math.abs(stroke.y-row.baseline-expectedGap)).toBeLessThan(.22);
  expect(Math.abs(stroke.thickness-expectedThickness)).toBeLessThan(.08);
 }
 expect(Math.abs(actual[0].y-actual[1].y),'overlapping portions share exactly one stroke center').toBeLessThan(.03);
 const saved=await exportPDF(page,info,data);expect(saved.strokes).toHaveLength(2);
 expect(Math.abs(saved.strokes[0].y-saved.strokes[1].y),'the PDF appearance keeps the same shared stroke center').toBeLessThan(.001);
 await page.screenshot({path:info.outputPath('overlapping-underlines.png'),scale:'css'});
});

test('legacy draft underlines realign once on reopen and export also repairs an unrendered page',async({page},info)=>{
 const data=await fixture(),pdf=await PDFDocument.load(data.bytes);
 for(let index=0;index<3;index++)pdf.addPage([data.width,data.height]);
 const[copied]=await pdf.copyPages(pdf,[0]);pdf.addPage(copied);data.bytes=Buffer.from(await pdf.save());
 const oldOffsets=[.7,.66,.68,.7,.66,4.69];
 const rects=data.rows.map((row,index)=>[row.x,data.height-row.baseline-oldOffsets[index],row.x+row.width,data.height-row.baseline+14]);
 const annotations=[0,4].map(pageIndex=>({id:`legacy-${pageIndex}`,pageIndex,rotation:0,type:'underline',rects,
  color:'#000000',text:data.rows.map(row=>row.text).join('\n'),comment:''}));
 await page.goto(url);
 await page.evaluate(async({bytes,annotations})=>{
  const data=new Uint8Array(bytes),digest=await crypto.subtle.digest('SHA-256',data);
  const id=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('linea',2);
   request.onupgradeneeded=()=>{const database=request.result;
    if(!database.objectStoreNames.contains('documents'))database.createObjectStore('documents',{keyPath:'id'}).createIndex('updated','updated');
    if(!database.objectStoreNames.contains('files'))database.createObjectStore('files',{keyPath:'id'});
   };request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  await new Promise((resolve,reject)=>{const tx=db.transaction(['documents','files'],'readwrite');
   tx.objectStore('files').put({id,bytes:data});
   tx.objectStore('documents').put({id,name:'legacy-underlines.pdf',annotations,deletedAnnotations:[],pageIndex:0,lineIndex:0,
    savedSignature:JSON.stringify(annotations),updated:Date.now()});
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });db.close();
 },{bytes:Array.from(data.bytes),annotations});
 await importPDF(page,data,'legacy-underlines.pdf');await zoomTo(page,135);
 const before=await previewGeometry(page,data,'.pdf-page[data-page-index="0"] .annotation-mark.underline');assertRows(before,data.rows);
 await expect(page.locator('.pdf-page[data-page-index="4"]')).toHaveAttribute('data-ready','false');
 const saved=await exportPDF(page,info,data,4);assertRows(saved.strokes,data.rows);
 await page.reload();await expect(page.locator('#welcome')).toBeVisible();await page.locator('.recent-row').first().click();await ready(page);await zoomTo(page,135);
 const after=await previewGeometry(page,data,'.pdf-page[data-page-index="0"] .annotation-mark.underline');assertRows(after,data.rows);
 for(let index=0;index<before.length;index++)expect(Math.abs(after[index].y-before[index].y),'loading again does not migrate canonical geometry a second time').toBeLessThan(.03);
 await fs.writeFile(info.outputPath('legacy-migration.json'),JSON.stringify({before,after,exportedOffscreen:saved.strokes},null,2));
});
