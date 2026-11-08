import {test,expect} from '@playwright/test';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import fs from 'node:fs/promises';
const url=process.env.LINEA_TEST_URL||'http://127.0.0.1:4173';
test.use({browserName:'chromium',headless:true,viewport:{width:1180,height:820},hasTouch:true,
 launchOptions:{executablePath:process.env.CHROME_EXECUTABLE}});
test.setTimeout(90000);
const slot=(page,index)=>page.locator(`.pdf-page[data-page-index="${index}"]`);
let bytes;
async function fixture(splitFirstPage=false){
 if(bytes&&!splitFirstPage)return bytes;
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),alternate=splitFirstPage?await pdf.embedFont(StandardFonts.HelveticaOblique):font;
 for(let index=0;index<12;index++){
  const sheet=pdf.addPage([600,800]);if(index===3)continue;
  for(let row=1;row<=30;row++){
   const prefix=`Anchor page ${index+1} row ${String(row).padStart(2,'0')}:`,tail=' a stable place to continue reading.',y=755-(row-1)*24;
   if(splitFirstPage&&index===0){
    // Independently drawn font runs make a realistic expensive text layer.
    // The visible text and its 30 reading rows remain the same.
    sheet.drawText(prefix,{x:60,y,size:11,font});let x=60+font.widthOfTextAtSize(prefix,11);
    for(let i=0;i<tail.length;i++){const face=i%2?alternate:font;sheet.drawText(tail[i],{x,y,size:11,font:face});x+=face.widthOfTextAtSize(tail[i],11)}
   }else sheet.drawText(prefix+tail,{x:60,y,size:11,font});
  }
 }
 const result=Buffer.from(await pdf.save());if(!splitFirstPage)bytes=result;return result;
}
async function settle(page){await page.locator('#scroll-area').evaluate(area=>new Promise((resolve,reject)=>{
 let previous=area.scrollTop,stable=0;const until=performance.now()+4000;
 const frame=()=>{stable=Math.abs(area.scrollTop-previous)<.1?stable+1:0;previous=area.scrollTop;if(stable>=8)resolve();else if(performance.now()>until)reject(Error('Scroll did not settle'));else requestAnimationFrame(frame)};requestAnimationFrame(frame);
}))}
async function ready(page,index){
 await expect(page.locator('#busy')).toBeHidden();await expect(slot(page,index)).toHaveAttribute('data-ready','true');
 await expect(page.locator('#document-pages')).not.toHaveCSS('pointer-events','none');await settle(page);
}
async function open(page,splitFirstPage=false){await page.goto(url);await page.locator('#file-input').setInputFiles({name:'anchor-fixture.pdf',mimeType:'application/pdf',buffer:await fixture(splitFirstPage)});await ready(page,0)}
async function clickLine(page,index,row){
 const text=slot(page,index).locator('.textLayer span').filter({hasText:`Anchor page ${index+1} row ${String(row).padStart(2,'0')}:`});
 await text.scrollIntoViewIfNeeded();await settle(page);const b=await text.boundingBox();await page.mouse.click(b.x+25,b.y+b.height/2);
 await expect.poll(()=>anchorGeometry(page)).toMatchObject({page:index});
 await expect(page.locator('#line-position')).toHaveText(new RegExp(`^${row} / 30`));
}
async function browse(page,index,mode='wheel'){
 const delta=await slot(page,index).evaluate(node=>{const area=document.querySelector('#scroll-area'),a=area.getBoundingClientRect(),b=node.getBoundingClientRect();return b.top+100-a.top-area.clientHeight*.35});
 if(mode==='wheel'){const a=await page.locator('#scroll-area').boundingBox();await page.mouse.move(a.x+a.width*.8,a.y+a.height*.6);await page.mouse.wheel(0,delta)}
 else await page.locator('#scroll-area').evaluate((area,delta)=>area.scrollTop+=delta,delta);
 await expect(page.locator('#page-number')).toHaveValue(String(index+1));await ready(page,index);
}
async function anchorGeometry(page){return page.evaluate(()=>{
 const apertures=[...document.querySelectorAll('.line-outline')].filter(node=>!node.hidden&&node.getBoundingClientRect().width>0);
 if(apertures.length!==1)return {count:apertures.length};
 const outline=apertures[0],sheet=outline.closest('.pdf-page'),r=outline.getBoundingClientRect(),b=sheet.getBoundingClientRect();
 return {count:1,page:Number(sheet.dataset.pageIndex),x:(r.x-b.x)/b.width,y:(r.y-b.y)/b.height,width:r.width/b.width,height:r.height/b.height};
})}
async function sourceAnchor(page){return page.evaluate(()=>new Promise((resolve,reject)=>{
 const request=indexedDB.open('linea',2);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('documents'),get=tx.objectStore('documents').getAll();get.onsuccess=()=>resolve(get.result.find(record=>record.name==='anchor-fixture.pdf')?.lineAnchor);get.onerror=()=>reject(get.error);tx.oncomplete=()=>db.close()};
}))}
async function expectSource(page,index,row){await expect.poll(()=>sourceAnchor(page)).toMatchObject({pageIndex:index,text:expect.stringContaining(`Anchor page ${index+1} row ${String(row).padStart(2,'0')}:`)})}
async function sameAnchor(page,expected){const actual=await anchorGeometry(page);expect(actual).toMatchObject({count:1,page:expected.page});for(const key of ['x','y','width','height'])expect(actual[key]).toBeCloseTo(expected[key],4)}
async function fullyDim(page,index){const state=await slot(page,index).evaluate(node=>{const layer=node.querySelector('.focus-layer'),shade=layer.querySelector('.top');return {hidden:layer.hidden,outlineHidden:layer.querySelector('.line-outline').hidden,shade:shade.getBoundingClientRect().height,page:node.getBoundingClientRect().height}});expect(state.hidden).toBe(false);expect(state.outlineHidden).toBe(true);expect(Math.abs(state.shade-state.page)).toBeLessThan(1)}
async function record(page,info,name){await fs.mkdir(info.outputDir,{recursive:true});await page.screenshot({path:info.outputPath(`${name}.png`)});await fs.writeFile(info.outputPath(`${name}.json`),JSON.stringify({anchor:await sourceAnchor(page),geometry:await anchorGeometry(page),page:await page.locator('#page-number').inputValue(),scroll:await page.locator('#scroll-area').evaluate(node=>node.scrollTop)},null,2))}

test('manual wheel browsing across pages and back never moves the locked source row',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);const original=await anchorGeometry(page);
 await browse(page,1);await sameAnchor(page,original);await fullyDim(page,1);await fullyDim(page,2);
 await browse(page,0);await sameAnchor(page,original);await expectSource(page,0,12);
 await record(page,info,'wheel-return-original-row');
 await clickLine(page,0,30);await expectSource(page,0,30);await browse(page,1);
 const aperture=await slot(page,0).locator('.line-outline').boundingBox(),viewport=await page.locator('#scroll-area').boundingBox();
 expect(aperture.y).toBeGreaterThanOrEqual(viewport.y);expect(aperture.y+aperture.height).toBeLessThanOrEqual(viewport.y+viewport.height);
 await expect(slot(page,0)).not.toHaveClass(/active/);
 await expect(slot(page,0).locator('.focus-layer .top')).not.toHaveCSS('display','none');
 expect(await slot(page,0).locator('.focus-layer').evaluate(node=>getComputedStyle(node,'::after').content)).toBe('none');
 await fullyDim(page,1);await expectSource(page,0,30);await record(page,info,'dual-visible-pages-locked-aperture');
});

test('touch panning and scrollbar offsets browse blank and text pages without choosing another row',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);const original=await anchorGeometry(page);
 const session=await page.context().newCDPSession(page),a=await page.locator('#scroll-area').boundingBox(),x=a.x+a.width*.65,y=a.y+a.height*.8;
 const start=await page.locator('#scroll-area').evaluate(node=>node.scrollTop);
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=8;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*35}]});
 await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(page);
 expect(await page.locator('#scroll-area').evaluate(node=>node.scrollTop)).toBeGreaterThan(start+100);await sameAnchor(page,original);
 await browse(page,3,'offset');await fullyDim(page,3);await sameAnchor(page,original);await expectSource(page,0,12);
 await browse(page,1,'offset');await sameAnchor(page,original);await fullyDim(page,1);await record(page,info,'touch-and-blank-page');
 await session.detach();
});

test('eviction, offscreen zoom, sidebar and resize preserve both the locked row and browsed viewport',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);const original=await anchorGeometry(page);
 await browse(page,8);await expect.poll(()=>slot(page,0).locator('.pdf-canvas').evaluate(canvas=>canvas.width)).toBe(0);
 await sameAnchor(page,original);await fullyDim(page,8);
 await page.locator('#zoom-in').click();await ready(page,8);await expect(page.locator('#page-number')).toHaveValue('9');await sameAnchor(page,original);
 await page.locator('#zoom-fit').click();await ready(page,8);await page.locator('#notes-toggle').click();await ready(page,8);
 await expect(page.locator('#page-number')).toHaveValue('9');await sameAnchor(page,original);await fullyDim(page,8);
 await page.setViewportSize({width:920,height:820});await expect.poll(()=>slot(page,8).evaluate(node=>node.getBoundingClientRect().width)).toBeLessThan(810);await ready(page,8);
 await expect(page.locator('#page-number')).toHaveValue('9');await sameAnchor(page,original);await expectSource(page,0,12);
 await record(page,info,'offscreen-zoom-sidebar-resize');
 await page.locator('#home').click();await expect(page.locator('.recent-row').first()).toContainText('第 1 页');
 await page.locator('.recent-row').first().click();await ready(page,0);await sameAnchor(page,original);await expectSource(page,0,12);
 await browse(page,8);await page.keyboard.press('Enter');await expect(page.locator('#page-number')).toHaveValue('1');await ready(page,0);
 await expectSource(page,0,13);await expect(page.locator('#line-position')).toHaveText(/^13 \/ 30/);await record(page,info,'keyboard-resumes-original-source');
});

test('only a completed text click changes the anchor after browsing, and subsequent keys resume it',async({page},info)=>{
 await open(page);await clickLine(page,0,12);const previous=await anchorGeometry(page);await browse(page,2);await expectSource(page,0,12);
 // Pressing blank page space prepares interaction, but is not a text reading decision.
 const b=await slot(page,2).boundingBox();await page.mouse.click(b.x+b.width-15,Math.max(140,b.y+40));await sameAnchor(page,previous);await expectSource(page,0,12);
 await clickLine(page,2,9);await expectSource(page,2,9);await fullyDim(page,0);const original=await anchorGeometry(page);
 await browse(page,7);await sameAnchor(page,original);await page.keyboard.press('ArrowUp');await expect(page.locator('#page-number')).toHaveValue('3');await ready(page,2);
 await expectSource(page,2,8);await record(page,info,'explicit-click-new-anchor');
});

test('a reading key supersedes a queued old click and skips blank pages in one step',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);
 await slot(page,0).locator('.textLayer span').filter({hasText:'Anchor page 1 row 09:'}).evaluate(node=>{
  const b=node.getBoundingClientRect(),event={bubbles:true,button:0,clientX:b.x+20,clientY:b.y+b.height/2};
  node.dispatchEvent(new PointerEvent('pointerdown',event));node.dispatchEvent(new PointerEvent('pointerup',event));
  document.querySelector('#scroll-area').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
 });
 await expectSource(page,0,13);await expect(page.locator('#line-position')).toHaveText(/^13 \/ 30/);
 await browse(page,2);await clickLine(page,2,30);await page.keyboard.press('ArrowDown');
 await expect(page.locator('#page-number')).toHaveValue('5');await ready(page,4);await expectSource(page,4,1);await fullyDim(page,3);
 await page.keyboard.press('ArrowUp');await expect(page.locator('#page-number')).toHaveValue('3');await ready(page,2);await expectSource(page,2,30);
 await record(page,info,'queued-click-and-blank-page-skip');
});

test('restoring an unmatched old source anchor never opens a hole on an unrelated numeric row',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);await page.locator('#home').click();
 await page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('linea',2);open.onsuccess=()=>{const db=open.result,tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents'),get=store.getAll();get.onsuccess=()=>{const value=get.result.find(row=>row.name==='anchor-fixture.pdf');value.lineAnchor={...value.lineAnchor,items:[{index:999999}],text:'A source unit that is no longer in the reading layout'};store.put(value)};tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}}));
 await page.locator('.recent-row').first().click();await ready(page,0);await fullyDim(page,0);
 expect(await anchorGeometry(page)).toEqual({count:0});await expect.poll(()=>sourceAnchor(page)).toMatchObject({items:[{index:999999}],text:'A source unit that is no longer in the reading layout'});
 await page.keyboard.press('ArrowDown');await expect(page.locator('#page-number')).toHaveValue('1');expect(await anchorGeometry(page)).toEqual({count:0});
 await page.locator('#home').click();
 await page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('linea',2);open.onsuccess=()=>{const db=open.result,tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents'),get=store.getAll();get.onsuccess=()=>{const value=get.result.find(row=>row.name==='anchor-fixture.pdf');value.pageIndex=3;value.lineAnchor.pageIndex=3;store.put(value)};tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}}));
 await page.locator('.recent-row').first().click();await ready(page,3);await page.keyboard.press('ArrowDown');await settle(page);
 await expect(page.locator('#page-number')).toHaveValue('4');await fullyDim(page,3);
 await expect.poll(()=>sourceAnchor(page)).toMatchObject({pageIndex:3,items:[{index:999999}],text:'A source unit that is no longer in the reading layout'});
 await browse(page,4);await clickLine(page,4,8);await expectSource(page,4,8);await record(page,info,'unmatched-source-needs-explicit-click');
});

test('a scroll without a new pointer or wheel event cancels an unpainted keyboard resume',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);await browse(page,8);
 await expect.poll(()=>slot(page,0).locator('.pdf-canvas').evaluate(canvas=>canvas.width)).toBe(0);
 const probe=await page.evaluate(()=>new Promise(resolve=>{
  const area=document.querySelector('#scroll-area'),before=area.scrollTop;
  area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  queueMicrotask(()=>{
   const pending=document.querySelector('.pdf-page[data-page-index="0"]').dataset.ready==='false';
   area.scrollTop=before+180;
   const manual=area.scrollTop,start=performance.now(),samples=[];
   const frame=()=>{samples.push({ms:performance.now()-start,top:area.scrollTop,page:document.querySelector('#page-number').value});if(performance.now()-start>1100)resolve({pending,before,manual,samples});else requestAnimationFrame(frame)};requestAnimationFrame(frame);
  });
 }));
 await fs.mkdir(info.outputDir,{recursive:true});await fs.writeFile(info.outputPath('pending-scroll-without-input-trace.json'),JSON.stringify(probe,null,2));
 await record(page,info,'pending-scroll-without-input');
 expect(probe.pending,'the manual change occurs before the cold anchor page finishes rendering').toBe(true);
 expect(probe.samples.at(-1).top).toBeCloseTo(probe.manual,0);await expectSource(page,0,12);
 await expect(page.locator('#page-number')).toHaveValue('9');
});

test('native PageDown takes over a pending cold-page reading resume',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);const original=await anchorGeometry(page);await browse(page,8);
 await expect.poll(()=>slot(page,0).locator('.pdf-canvas').evaluate(canvas=>canvas.width)).toBe(0);
 await page.evaluate(()=>{window.__pageDownProbe=[];document.addEventListener('keydown',event=>{if(event.key==='PageDown')window.__pageDownProbe.push({pending:document.querySelector('.pdf-page[data-page-index="0"]').dataset.ready==='false',before:document.querySelector('#scroll-area').scrollTop,trusted:event.isTrusted})},true)});
 const session=await page.context().newCDPSession(page);await session.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.keyboard.down('Enter');await page.keyboard.press('PageDown');await page.keyboard.up('Enter');await settle(page);
 await session.send('Emulation.setCPUThrottlingRate',{rate:1});await session.detach();
 const inputs=await page.evaluate(()=>window.__pageDownProbe);await fs.writeFile(info.outputPath('trusted-pagedown-input.json'),JSON.stringify(inputs,null,2));
 await record(page,info,'native-pagedown-takeover');
 expect(inputs).toHaveLength(1);expect(inputs[0]).toMatchObject({pending:true,trusted:true});
 expect(await page.locator('#scroll-area').evaluate(node=>node.scrollTop)).toBeGreaterThan(inputs[0].before+100);
 await sameAnchor(page,original);await expectSource(page,0,12);
});

test('an auxiliary scroll also cancels a reading key queued behind an existing zoom render',async({page},info)=>{
 await page.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(kind,...args){
   const result=original.call(this,kind,...args),stage=document.querySelector('#document-pages');
   if(kind==='2d'&&this.classList.contains('pdf-canvas')&&window.__afterZoomRaster&&stage?.style.willChange==='transform'&&!stage.style.transform){
    const callback=window.__afterZoomRaster;window.__afterZoomRaster=null;queueMicrotask(callback);
   }
   return result;
  };
 });
 for(const manual of [false,true]){
  await open(page);await clickLine(page,0,12);await expectSource(page,0,12);const original=await anchorGeometry(page);await browse(page,8);
  await page.evaluate(manual=>{
   window.__queuedZoomDone=new Promise(resolve=>{window.__afterZoomRaster=()=>{
    const area=document.querySelector('#scroll-area'),stage=document.querySelector('#document-pages');
    const pending=getComputedStyle(stage).pointerEvents==='none',transform=stage.style.transform;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    queueMicrotask(()=>{const before=area.scrollTop;if(manual)area.scrollTop+=180;const expected=area.scrollTop,start=performance.now(),samples=[];
     const frame=()=>{samples.push({ms:performance.now()-start,top:area.scrollTop,page:document.querySelector('#page-number').value});if(performance.now()-start>1100)resolve({manual,pending,transform,before,expected,samples});else requestAnimationFrame(frame)};requestAnimationFrame(frame);
    });
   }});
  },manual);
  await page.locator('#zoom-in').click();const probe=await page.evaluate(()=>window.__queuedZoomDone);
  await fs.mkdir(info.outputDir,{recursive:true});await fs.writeFile(info.outputPath(`zoom-queued-${manual?'manual':'control'}-trace.json`),JSON.stringify(probe,null,2));await record(page,info,`zoom-queued-${manual?'manual':'control'}`);
  expect(probe.pending).toBe(true);expect(probe.transform).toBe('');
  if(manual){expect(probe.samples.at(-1).top).toBeCloseTo(probe.expected,0);await sameAnchor(page,original);await expectSource(page,0,12);await expect(page.locator('#page-number')).toHaveValue('9')}
  else {await expectSource(page,0,13);await expect(page.locator('#page-number')).toHaveValue('1')}
 }
});


for(const gesture of ['page-key','text-click'])test(`${gesture==='page-key'?'native page keys':'a text click'} take over while a cold text layer is suspended for preparation`,async({page},info)=>{
 await open(page,true);await clickLine(page,0,12);await expectSource(page,0,12);
 const original=await anchorGeometry(page);await browse(page,8);
 await expect.poll(()=>slot(page,0).locator('.pdf-canvas').evaluate(canvas=>canvas.width)).toBe(0);
 await page.evaluate(()=>{
  const original=scheduler.yield.bind(scheduler);
  window.__measurementPause={restore:()=>{scheduler.yield=original;}};
  scheduler.yield=()=>{
   const host=[...document.body.children].find(node=>node.getAttribute('aria-hidden')==='true');
   if(!__measurementPause.host&&host?.querySelector('.textLayer')&&document.querySelector('.pdf-page[data-page-index="0"]').dataset.ready==='false'){
    __measurementPause.host=host;
    return new Promise(resolve=>{__measurementPause.release=resolve;});
   }
   return original();
  };
 });
 const session=await page.context().newCDPSession(page);
 await session.send('Emulation.setCPUThrottlingRate',{rate:4});
 try{
  await page.keyboard.down('Enter');
  await expect.poll(()=>page.evaluate(()=>Boolean(window.__measurementPause.release))).toBe(true);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const before=await page.locator('#scroll-area').evaluate(node=>node.scrollTop);
  expect(await page.evaluate(()=>__measurementPause.host.isConnected)).toBe(true);
  if(gesture==='page-key'){
   await page.keyboard.press('PageDown');await page.keyboard.up('Enter');
   await expect.poll(()=>page.locator('#scroll-area').evaluate(node=>node.scrollTop)).toBeGreaterThan(before+100);
   await settle(page);const below=await page.locator('#scroll-area').evaluate(node=>node.scrollTop);
   await page.keyboard.press('PageUp');
   await expect.poll(()=>page.locator('#scroll-area').evaluate(node=>node.scrollTop)).toBeLessThan(below-100);
   await settle(page);await sameAnchor(page,original);await expectSource(page,0,12);
  }else{
   const text=slot(page,8).locator('.textLayer span').filter({hasText:'Anchor page 9 row 08:'});
   const b=await text.boundingBox();await page.mouse.click(b.x+25,b.y+b.height/2);
   await page.keyboard.up('Enter');await expectSource(page,8,8);
  }
 }finally{
  await page.keyboard.up('Enter');
  await page.evaluate(()=>{__measurementPause.restore();__measurementPause.release?.();});
  await session.send('Emulation.setCPUThrottlingRate',{rate:1});await session.detach();
 }
 await expect.poll(()=>page.evaluate(()=>__measurementPause.host?.isConnected)).toBe(false);
 await record(page,info,'native-page-keys-during-measurement');
});


test('viewport browse keys preserve the reading anchor and yield to the wheel',async({page},info)=>{
 await open(page);await clickLine(page,0,12);await expectSource(page,0,12);
 const original=await anchorGeometry(page),area=page.locator('#scroll-area');
 const start=await area.evaluate(node=>node.scrollTop);
 await page.keyboard.press('PageDown');await expect.poll(()=>area.evaluate(node=>node.scrollTop)).toBeGreaterThan(start+100);await settle(page);
 const first=await area.evaluate(node=>node.scrollTop);
 for(let i=0;i<3;i++)await page.keyboard.press('PageDown');
 await expect.poll(()=>area.evaluate(node=>node.scrollTop)).toBeGreaterThan(first+100);await settle(page);
 const beforeWheel=await area.evaluate(node=>node.scrollTop),height=await area.evaluate(node=>node.clientHeight);
 const box=await area.boundingBox();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.5);
 await page.keyboard.press('PageDown');await expect.poll(()=>area.evaluate(node=>node.scrollTop),{intervals:[10]}).toBeGreaterThan(beforeWheel+20);
 await area.evaluate(node=>node.addEventListener('wheel',()=>{window.__browseWheelEntry=node.scrollTop;},{capture:true,once:true}));
 await page.mouse.wheel(0,-280);await settle(page);
 expect(await area.evaluate(node=>node.scrollTop)).toBeLessThan(await page.evaluate(()=>__browseWheelEntry)-80);
 expect(await area.evaluate(node=>node.scrollTop)).toBeLessThan(beforeWheel+height*.875-100);
 const drift=await area.evaluate(node=>new Promise(resolve=>{const start=node.scrollTop,until=performance.now()+250;let maximum=0;const frame=()=>{maximum=Math.max(maximum,Math.abs(node.scrollTop-start));if(performance.now()>=until)resolve(maximum);else requestAnimationFrame(frame)};requestAnimationFrame(frame)}));
 expect(drift).toBeLessThan(2);
 const manual=await area.evaluate(node=>node.scrollTop);await page.mouse.wheel(0,-120);await expect.poll(()=>area.evaluate(node=>node.scrollTop)).toBeLessThan(manual-60);await settle(page);
 const beforeSpace=await area.evaluate(node=>node.scrollTop);await page.keyboard.press('Space');await expect.poll(()=>area.evaluate(node=>node.scrollTop)).toBeGreaterThan(beforeSpace+100);await settle(page);
 const afterSpace=await area.evaluate(node=>node.scrollTop);await page.keyboard.press('Shift+Space');await expect.poll(()=>area.evaluate(node=>node.scrollTop)).toBeLessThan(afterSpace-100);await settle(page);
 await page.keyboard.press('End');await expect.poll(()=>area.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop)).toBeLessThan(2);await settle(page);
 await page.keyboard.press('Home');await expect.poll(()=>area.evaluate(node=>node.scrollTop)).toBeLessThan(2);await settle(page);
 await sameAnchor(page,original);await expectSource(page,0,12);await record(page,info,'viewport-key-and-wheel-ownership');
});

test('viewport browse keys respect reduced motion and preserve native modifier and input behavior',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await open(page);await clickLine(page,0,12);
 const area=page.locator('#scroll-area'),before=await area.evaluate(node=>node.scrollTop);
 await page.keyboard.press('PageDown');expect(await area.evaluate(node=>node.scrollTop)).toBeGreaterThan(before+100);
 await page.keyboard.press('Home');expect(await area.evaluate(node=>node.scrollTop)).toBe(0);
 await page.evaluate(()=>{window.__browseKeyProbe=[];window.addEventListener('keydown',event=>{if(['Home','PageDown'].includes(event.key))__browseKeyProbe.push({key:event.key,prevented:event.defaultPrevented,target:event.target.id,shift:event.shiftKey,ctrl:event.ctrlKey})});});
 await page.keyboard.press('Shift+PageDown');await page.keyboard.press('Control+Home');
 await page.locator('#page-number').focus();await page.keyboard.press('PageDown');
 const events=await page.evaluate(()=>__browseKeyProbe);
 expect(events).toEqual([{key:'PageDown',prevented:false,target:'scroll-area',shift:true,ctrl:false},{key:'Home',prevented:false,target:'scroll-area',shift:false,ctrl:true},{key:'PageDown',prevented:false,target:'page-number',shift:false,ctrl:false}]);
 await expectSource(page,0,12);
});
