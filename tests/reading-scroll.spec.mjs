import {test,expect} from '@playwright/test';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import fs from 'node:fs/promises';
const appURL=process.env.LINEA_TEST_URL||'http://127.0.0.1:4173';
test.use({browserName:'chromium',headless:true,viewport:{width:1100,height:740},deviceScaleFactor:1,
 launchOptions:{executablePath:process.env.CHROME_EXECUTABLE}});
test.setTimeout(60000);
let fixture;
async function bytes(){
 if(fixture)return fixture;
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let chapter=1;chapter<=3;chapter++){
  const page=pdf.addPage([600,800]);
  for(let row=1;row<=34;row++)page.drawText(`Chapter ${chapter} row ${String(row).padStart(2,'0')}: follow this sentence at a comfortable pace.`,{x:55,y:755-(row-1)*21,size:11,font});
 }
 return fixture=Buffer.from(await pdf.save());
}
async function settled(page){
 await page.locator('#scroll-area').evaluate(area=>new Promise((resolve,reject)=>{
  let previous=area.scrollTop,count=0;const until=performance.now()+3000;
  const frame=()=>{count=Math.abs(area.scrollTop-previous)<.05?count+1:0;previous=area.scrollTop;
   if(count>=6)resolve();else if(performance.now()>until)reject(Error('Reading scroll did not settle'));else requestAnimationFrame(frame)};
  requestAnimationFrame(frame);
 }));
}
async function open(page){
 await page.goto(appURL);
 await page.locator('#file-input').setInputFiles({name:'reading-motion.pdf',mimeType:'application/pdf',buffer:await bytes()});
 await expect(page.locator('#busy')).toBeHidden();
 await expect(page.locator('#page-number')).toHaveValue('1');
 await expect(page.locator('#text-layer span')).toHaveCount(34);
 await settled(page);
}
async function atBand(page,row=20,ratio=.63){
 const target=page.locator('.pdf-page[data-page-index="0"] .textLayer span').filter({hasText:`Chapter 1 row ${String(row).padStart(2,'0')}:`});
 await target.evaluate((node,ratio)=>{const area=document.getElementById('scroll-area'),view=area.getBoundingClientRect(),r=node.getBoundingClientRect();area.scrollTop+=(r.top+r.bottom)/2-view.top-area.clientHeight*ratio},ratio);
 await settled(page);
 const r=await target.boundingBox();await page.mouse.click(r.x+12,r.y+r.height/2);
 await expect(page.locator('#line-position')).toHaveText(new RegExp(`^${row} / 34`));
 await expect(page.locator('#scroll-area')).toBeFocused();
 return page.locator('#scroll-area').evaluate(area=>area.scrollTop);
}
async function startTrace(page,duration=850){
 await page.evaluate(duration=>{
  const area=document.getElementById('scroll-area'),start=performance.now();window.__readingMotion=[];
  window.__readingMotionDone=new Promise(resolve=>{const frame=()=>{
   window.__readingMotion.push({ms:performance.now()-start,top:area.scrollTop,left:area.scrollLeft,line:document.getElementById('line-position').textContent,page:document.getElementById('page-number').value});
   if(performance.now()-start>=duration)resolve(window.__readingMotion);else requestAnimationFrame(frame);
  };frame()});
 },duration);
}
async function trace(page,info,name){
 const samples=await page.evaluate(()=>window.__readingMotionDone);
 await fs.mkdir(info.outputDir,{recursive:true});const file=info.outputPath(`${name}.json`);
 await fs.writeFile(file,JSON.stringify(samples,null,2));await info.attach(name,{path:file,contentType:'application/json'});
 return samples;
}
async function focusRatio(page){return page.evaluate(()=>{const area=document.getElementById('scroll-area'),a=area.getBoundingClientRect(),r=document.getElementById('line-outline').getBoundingClientRect();return ((r.top+r.bottom)/2-a.top-area.clientTop)/area.clientHeight})}

test('crossing the lower comfort bound smoothly returns reading to the middle',async({page},info)=>{
 await open(page);const before=await atBand(page);
 await startTrace(page);await page.keyboard.press('ArrowDown');
 await expect(page.locator('#line-position')).toHaveText(/^21 \/ 34/);
 const samples=await trace(page,info,'bottom-line-motion'),final=samples.at(-1).top;
 await page.screenshot({path:info.outputPath('middle-reading-after-forward.png')});
 expect(final-before).toBeGreaterThan(50);
 expect(final-before).toBeLessThan(250);
 const moving=samples.filter(s=>s.top>before+1&&s.top<final-1);
 expect(moving.length,'following must have visible intermediate positions').toBeGreaterThanOrEqual(4);
 expect(samples.every((s,i)=>!i||s.top>=samples[i-1].top-1),'downward following is monotone').toBeTruthy();
 expect(moving.at(-1).ms-moving[0].ms).toBeGreaterThan(80);
 expect(await focusRatio(page)).toBeCloseTo(.43,2);
});

test('rapid reading keys keep every step and continue the current smooth trajectory',async({page},info)=>{
 await open(page);const before=await atBand(page);
 await startTrace(page,1100);
 for(let i=0;i<8;i++)await page.keyboard.press('ArrowDown');
 await expect(page.locator('#line-position')).toHaveText(/^28 \/ 34/);
 const samples=await trace(page,info,'rapid-key-motion'),last=samples.at(-1);
 expect(last.top).toBeGreaterThan(before+100);
 expect(samples.every((s,i)=>!i||s.top>=samples[i-1].top-1)).toBeTruthy();
 expect(new Set(samples.map(s=>s.top)).size).toBeGreaterThan(8);
 expect(await focusRatio(page)).toBeGreaterThanOrEqual(.33);
 expect(await focusRatio(page)).toBeLessThanOrEqual(.65);
 await expect(page.locator('#page-number')).toHaveValue('1');
});

test('a manual wheel cancels the animation without a later return to its old destination',async({page},info)=>{
 await open(page);const before=await atBand(page);
 await startTrace(page,1050);await page.keyboard.press('ArrowDown');
 await expect.poll(()=>page.locator('#scroll-area').evaluate(area=>area.scrollTop),{intervals:[10]}).toBeGreaterThan(before+5);
 const box=await page.locator('#scroll-area').boundingBox();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.5);
 await page.mouse.wheel(0,-160);await settled(page);
 const manual=await page.locator('#scroll-area').evaluate(area=>area.scrollTop);
 const samples=await trace(page,info,'wheel-cancellation');
 expect(manual).toBeLessThan(before);
 expect(samples.at(-1).top).toBeCloseTo(manual,0);
 expect(samples.slice(-10).every(sample=>Math.abs(sample.top-manual)<1)).toBeTruthy();
});

test('manual scroll invalidates a pending cross-page reading render and queued keys',async({page},info)=>{
 await open(page);await atBand(page,34);
 await startTrace(page,900);
 const during=await page.evaluate(()=>new Promise(resolve=>{
  const area=document.getElementById('scroll-area'),before=area.scrollTop;
  for(let i=0;i<4;i++)area.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
  queueMicrotask(()=>{
   const pending=getComputedStyle(document.getElementById('document-pages')).pointerEvents==='none';
   area.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-120}));area.scrollTop=before-120;
   resolve({pending,manual:area.scrollTop});
  });
 }));
 expect(during.pending,'wheel interrupts an actual asynchronous page render').toBeTruthy();
 const samples=await trace(page,info,'pending-render-cancellation');
 expect(samples.at(-1).top).toBeCloseTo(during.manual,0);
 await expect(page.locator('#page-number')).toHaveValue('1');
 await expect(page.locator('#document-pages')).not.toHaveCSS('pointer-events','none');
});

test('reduced motion follows immediately and an explicit page jump has no old animation tail',async({page},info)=>{
 await page.emulateMedia({reducedMotion:'reduce'});await open(page);const before=await atBand(page);
 await startTrace(page,450);await page.keyboard.press('ArrowDown');
 const immediate=await page.locator('#scroll-area').evaluate(area=>area.scrollTop);
 expect(immediate).toBeGreaterThan(before+50);
 const samples=await trace(page,info,'reduced-motion');
 expect(new Set(samples.map(s=>s.top)).size).toBeLessThanOrEqual(2);
 await page.emulateMedia({reducedMotion:'no-preference'});await atBand(page);
 await page.keyboard.press('ArrowDown');await page.locator('#next-page').click();
 await expect(page.locator('#page-number')).toHaveValue('2');await settled(page);
 const after=await page.locator('#scroll-area').evaluate(area=>area.scrollTop);
 await startTrace(page,500);const tail=await trace(page,info,'page-jump-cancellation');
 expect(tail.every(sample=>Math.abs(sample.top-after)<1)).toBeTruthy();
});

test('several lines stay stationary inside the comfort band and upward reading gets room above',async({page},info)=>{
 await open(page);const before=await atBand(page,20,.43);
 const stops=[];
 for(const key of ['ArrowDown','ArrowDown','ArrowDown','ArrowUp','ArrowUp','ArrowUp','ArrowUp']){
  await page.keyboard.press(key);await settled(page);
  stops.push({line:await page.locator('#line-position').textContent(),ratio:await focusRatio(page),top:await page.locator('#scroll-area').evaluate(area=>area.scrollTop)});
 }
 await fs.writeFile(info.outputPath('stationary-reading-band.json'),JSON.stringify(stops,null,2));
 expect(stops.every(stop=>Math.abs(stop.top-before)<1),'normal reading inside the band must not pan on every line').toBeTruthy();
 await expect(page.locator('#line-position')).toHaveText(/^19 \/ 34/);
 await startTrace(page,900);await page.keyboard.press('ArrowUp');
 const samples=await trace(page,info,'upward-return-to-middle');
 await expect(page.locator('#line-position')).toHaveText(/^18 \/ 34/);
 expect(samples.at(-1).top).toBeLessThan(before-50);
 expect(samples.every((sample,i)=>!i||sample.top<=samples[i-1].top+1)).toBeTruthy();
 expect(await focusRatio(page)).toBeCloseTo(.55,2);
 await page.screenshot({path:info.outputPath('middle-reading-after-upward.png')});
});

test('clicking another visible line takes over an unfinished recentering animation',async({page},info)=>{
 await open(page);const before=await atBand(page);
 await page.keyboard.press('ArrowDown');
 await expect.poll(()=>page.locator('#scroll-area').evaluate(area=>area.scrollTop),{intervals:[10]}).toBeGreaterThan(before+5);
 const target=page.locator('.pdf-page[data-page-index="0"] .textLayer span').filter({hasText:'Chapter 1 row 17:'});
 await page.evaluate(()=>{window.__readingClick=null;document.addEventListener('pointerdown',event=>{window.__readingClick={text:event.target.closest('span')?.textContent||'',trusted:event.isTrusted}},{capture:true,once:true})});
 // Resolve the moving span inside one trusted action, instead of carrying a
 // stale rectangle through separate mouse-move/down protocol round trips.
 await target.click({force:true});
 const hit=await page.evaluate(()=>window.__readingClick),clickedRow=Number(hit?.text.match(/row (\d+):/)?.[1]);
 await fs.writeFile(info.outputPath('manual-click-hit.json'),JSON.stringify(hit,null,2));
 expect(hit.trusted).toBe(true);expect(clickedRow).toBeGreaterThan(0);expect(clickedRow).not.toBe(21);
 const stopped=await page.locator('#scroll-area').evaluate(area=>area.scrollTop);
 await expect(page.locator('#line-position')).toHaveText(new RegExp(`^${clickedRow} / 34`));
 await startTrace(page,700);const samples=await trace(page,info,'click-manual-takeover');
 expect(samples.every(sample=>Math.abs(sample.top-stopped)<1),'manual click must not resume the old scroll destination').toBeTruthy();
 await expect(page.locator('#line-position')).toHaveText(new RegExp(`^${clickedRow} / 34`));
});

test('crossing pages in either direction returns to one middle reading anchor',async({page},info)=>{
 await open(page);await atBand(page,34,.5);
 await page.keyboard.press('Enter');await expect(page.locator('#page-number')).toHaveValue('2');await settled(page);
 await expect(page.locator('#line-position')).toHaveText(/^1 \/ 34/);
 expect(await focusRatio(page)).toBeCloseTo(.43,2);
 const forward=await page.locator('#scroll-area').evaluate(area=>area.scrollTop);
 await page.keyboard.press('ArrowDown');await settled(page);await page.keyboard.press('ArrowDown');await settled(page);
 expect(await page.locator('#scroll-area').evaluate(area=>area.scrollTop)).toBeCloseTo(forward,0);
 await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');
 await expect(page.locator('#page-number')).toHaveValue('1');await settled(page);
 await expect(page.locator('#line-position')).toHaveText(/^34 \/ 34/);
 expect(await focusRatio(page)).toBeCloseTo(.43,2);
 await startTrace(page,550);const samples=await trace(page,info,'cross-page-middle-anchor');
 expect(samples.every(sample=>Math.abs(sample.top-samples[0].top)<1)).toBeTruthy();
 await page.screenshot({path:info.outputPath('middle-reading-cross-page.png')});
});

test('a same-page column transition uses reading direction rather than screen direction',async({page},info)=>{
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let chapter=1;chapter<=3;chapter++){
  const sheet=pdf.addPage([600,800]);
  for(const [column,x] of [['L',55],['R',320]])for(let row=1;row<=20;row++)
   sheet.drawText(`Column ${column} row ${String(row).padStart(2,'0')}. Continue reading this text.`,{x,y:750-(row-1)*29,size:10,font});
 }
 await page.goto(appURL);await page.locator('#file-input').setInputFiles({name:'column-motion.pdf',mimeType:'application/pdf',buffer:Buffer.from(await pdf.save())});
 await expect(page.locator('#busy')).toBeHidden();await page.locator('#next-page').click();
 await expect(page.locator('#page-number')).toHaveValue('2');await expect(page.locator('#text-layer span')).toHaveCount(40);await settled(page);
 const target=page.locator('#text-layer span').filter({hasText:'Column L row 20.'});
 await target.evaluate(node=>{const area=document.getElementById('scroll-area'),view=area.getBoundingClientRect(),box=node.getBoundingClientRect();area.scrollTop+=(box.top+box.bottom)/2-view.top-area.clientHeight*.43});
 await settled(page);const box=await target.boundingBox();await page.mouse.click(box.x+20,box.y+box.height/2);
 await expect(page.locator('#line-position')).toHaveText(/^20 \/ 40/);
 await page.keyboard.press('ArrowDown');await settled(page);
 await expect(page.locator('#line-position')).toHaveText(/^21 \/ 40/);
 expect(await focusRatio(page),'forward reading enters the next column near43%, despite moving spatially upward').toBeCloseTo(.43,2);
 await page.screenshot({path:info.outputPath('next-column-reading-anchor.png')});
 await page.keyboard.press('ArrowUp');await settled(page);
 await expect(page.locator('#line-position')).toHaveText(/^20 \/ 40/);
 expect(await focusRatio(page),'backward reading returns to the previous column near55%, despite moving spatially downward').toBeCloseTo(.55,2);
 await page.screenshot({path:info.outputPath('previous-column-reading-anchor.png')});
});
