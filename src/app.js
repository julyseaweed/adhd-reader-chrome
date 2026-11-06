import './style.css';
import {loadPDF,exportAnnotatedPdf,viewportRectToPdf,pdfRectToViewport} from './pdf-engine.js';
import {putDocument,getDocument,recentDocuments,fingerprint} from './storage.js';
import {translate,cancelTranslation} from './translate.js';
import {focusRect,readingLineAtPoint,anchoredLineIndex} from './focus-geometry.js';
import {selectionRectsFromRange,canonicalizePdfRects,underlinePdfRects} from './selection-geometry.js';
import {createPdfZoom} from './pdf-zoom.js';
import {createReadingScroll,readingScrollTarget} from './reading-scroll.js';
import {ContinuousDocument} from './continuous-document.js';
import {selectWordAtPoint} from './word-selection.js';
import {HIGHLIGHT_COLORS as palette,HIGHLIGHT_OPACITY,underlineMetrics} from './annotation-style.js';
document.documentElement.style.setProperty('--highlight-opacity',HIGHLIGHT_OPACITY);
const paletteColor=value=>palette.includes(value?.toLowerCase())?value.toLowerCase():value==='#90b9db'?palette[1]:palette[0];
function normalizeDraft(annotations){return annotations.map(a=>({...a,rects:(a.type==='underline'?underlinePdfRects:canonicalizePdfRects)(a.rects,a.rotation||0),color:a.type==='underline'?'#000000':paletteColor(a.color)}))}

const $=id=>document.getElementById(id);
function focusReader(){if(!$('reader').hidden&&!document.querySelector('dialog[open]'))$('scroll-area').focus({preventScroll:true})}
document.addEventListener('keydown',e=>{if(e.key==='Tab')document.documentElement.dataset.keyboardNavigation=''},true);
document.addEventListener('pointerdown',()=>{delete document.documentElement.dataset.keyboardNavigation;interruptReadingNavigation()},true);
const icons={folder:'M3 6h6l2 2h10v11H3z M3 6V4h6l2 2',moon:'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',sliders:'M4 7h7m5 0h4M4 17h2m5 0h9 M11 4v6m5-6v6 M6 14v6m5-6v6',download:'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',plus:'M12 5v14M5 12h14',minus:'M5 12h14',focus:'M4 5h16M4 19h16M3 9h18v6H3z',cursor:'m5 3 14 9-7 1-4 7z',highlight:'m14 3 7 7-9 9-7-7zM5 12l-2 7h7M3 22h18',underline:'M6 3v8a6 6 0 0 0 12 0V3M4 21h16',comment:'M4 4h16v12H9l-5 4z',sidebar:'M3 4h18v16H3zM15 4v16',close:'m6 6 12 12M6 18 18 6',left:'m15 6-6 6 6 6',right:'m9 6 6 6-6 6',translate:'M3 5h12M9 3v2M5 8c1 4 4 7 8 8M13 5c-1 5-5 9-10 11M14 21l4-11 4 11m-6-4h4',copy:'M8 8h12v13H8zM16 8V3H3v13h5'};
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name]||icons.folder}"/></svg>`}
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const settings=(()=>{try{return JSON.parse(localStorage.getItem('linea-settings')||'{}')}catch{return {}}})();
const s={doc:null,bytes:null,id:null,name:'',pageIndex:0,page:null,viewport:null,lines:[],lineIndex:0,readingAnchor:null,annotations:[],nativeAnnotations:[],nativeByPage:new Map(),undo:[],redo:[],zoom:null,focus:true,dim:settings.dim??72,tool:'select',color:paletteColor(settings.color),theme:settings.theme||'light',selection:null,renderGeneration:0,savedSignature:'[]',persistTimer:null,storageFailed:false,draftPending:false,persistRevision:0,canExport:true};
let toastTimer,commentEditing=null,commentTarget=null,selectionClickTimer,press=null,translationGeneration=0,openGeneration=0,documentEpoch=0,persistChain=Promise.resolve();
// A navigation belongs to one document session, even when the same PDF is reopened.
let navigationOwner=null;
let readingIntent=0,readingNavigationOwner=null,readingRenderWait=null;
let passwordRequest=null;
function beginOpenIntent(){interruptReadingNavigation();openGeneration++;passwordRequest?.cancel();return openGeneration}
function beginNavigation(){const owner={epoch:documentEpoch};navigationOwner=owner;s.navigationLock=true;return owner}
function ownsNavigation(owner){return navigationOwner===owner&&owner.epoch===documentEpoch}
function endNavigation(owner){if(ownsNavigation(owner)){navigationOwner=null;s.navigationLock=false;refreshVisible()}}
const signature=()=>JSON.stringify(s.annotations);
const busy=(value,label='正在打开')=>{$('busy').hidden=!value;$('busy-label').textContent=label};
function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3800)}
function persistSettings(){localStorage.setItem('linea-settings',JSON.stringify({dim:s.dim,color:s.color,theme:s.theme}))}
function updateTheme(){document.body.classList.toggle('dark',s.theme==='dark');$('theme').innerHTML=icon(s.theme==='dark'?'sun':'moon');$('theme').title=$('theme').ariaLabel=s.theme==='dark'?'白天模式':'夜间模式';document.querySelector('meta[name=theme-color]').content=s.theme==='dark'?'#1b1b1b':'#fafafa'}
updateTheme();$('dim').value=s.dim;$('dim-value').value=s.dim+'%';document.documentElement.style.setProperty('--dim',s.dim/100);document.documentElement.style.setProperty('--note',s.color);

function updateSaveStatus(){const dirty=signature()!==s.savedSignature;$('dirty-dot').hidden=!dirty;$('save-status').textContent=!s.canExport?'只读':s.storageFailed?'草稿保存失败':dirty?(s.draftPending?'保存中':'未导出'):'';$('save').title=dirty?'保存含标注的 PDF · Ctrl S':'保存 PDF · Ctrl S'}
function readingAnchor(){return s.readingAnchor?structuredClone(s.readingAnchor):null}
function rememberReadingLine(record,index){const line=record?.lines[index];s.readingAnchor={pageIndex:record.index,lineIndex:Math.max(0,index),items:line?.items.map(({index})=>({index}))||[],text:line?.text||''}}
function readingLineIndex(record,anchor=s.readingAnchor){
 if(!anchor||record?.index!==anchor.pageIndex)return -1;
 if(anchor.items?.length){const indices=new Set(anchor.items.map(item=>item.index));return record.lines.findIndex(line=>line.items.some(item=>indices.has(item.index)))}
 return record.lines.length?anchoredLineIndex(record.lines,null,anchor.lineIndex):-1;
}
function excludedTableStep(record,anchor,direction){
 const indices=new Set(anchor.items?.map(item=>item.index));
 const excluded=record.layout?.excludedLines.find(line=>line.readingRole==='table'&&line.items.some(item=>indices.has(item.index)));
 const region=excluded&&record.layout.tableRegions?.find(region=>region.id===excluded.tableRegionId);
 if(!region?.readingNeighbors)return null;
 const neighbor=region.readingNeighbors[direction>0?'next':'previous'];
 if(neighbor===null)return {adjacentPage:true,index:-1};
 if(!Array.isArray(neighbor))return null;
 const targets=new Set(neighbor),index=record.lines.findIndex(line=>line.items.some(item=>targets.has(item.index)));
 return index>=0?{adjacentPage:false,index}:null;
}
function persist(immediate=false){clearTimeout(s.persistTimer);if(!s.id)return Promise.resolve();s.draftPending=true;const revision=++s.persistRevision;updateSaveStatus();const run=()=>{const anchor=readingAnchor();const record={id:s.id,name:s.name,bytes:s.bytes,annotations:structuredClone(s.annotations),pageIndex:anchor?.pageIndex??0,lineIndex:anchor?.lineIndex??0,lineAnchor:anchor,savedSignature:s.savedSignature,updated:Date.now()};persistChain=persistChain.catch(()=>{}).then(()=>putDocument(record)).then(()=>{if(record.id===s.id&&revision===s.persistRevision){s.storageFailed=false;s.draftPending=false;updateSaveStatus()}}).catch(()=>{if(record.id===s.id){s.storageFailed=true;s.draftPending=false;updateSaveStatus();toast('本地存储空间不足，请保存 PDF')}});return persistChain};if(immediate)return run();s.persistTimer=setTimeout(run,350)}
async function showRecent(){try{const list=await recentDocuments();$('recent-list').replaceChildren();list.forEach(item=>{const btn=document.createElement('button');btn.className='recent-row';const name=document.createElement('span');name.className='recent-name';name.textContent=item.name.replace(/\.pdf$/i,'');const page=document.createElement('small');page.textContent=`第 ${(item.pageIndex||0)+1} 页`;btn.innerHTML=icon('folder');btn.append(name,page);btn.onclick=async()=>{const importId=beginOpenIntent();busy(true);try{const saved=await getDocument(item.id,true);if(importId!==openGeneration)return;if(!saved?.bytes)throw Error('原文件未找到，请重新导入');await openBytes(saved.bytes,saved.name,saved,importId)}catch(e){if(importId===openGeneration)toast(e.message)}finally{if(importId===openGeneration)busy(false)}};$('recent-list').append(btn)})}catch{}}
showRecent();
function closeFloating(){ $('selection-menu').hidden=true;$('translation').hidden=true;cancelTranslation();translationGeneration++ }
function clearSelection(){window.getSelection()?.removeAllRanges();s.selection=null;closeFloating();updateFocus(false)}
function requestPassword(){
 passwordRequest?.cancel();busy(false);$('password').value='';const dialog=$('password-dialog');
 return new Promise(resolve=>{
  const request={cancel:()=>done(null)};
  function done(value){if(passwordRequest!==request)return;passwordRequest=null;dialog.close();resolve(value)}
  passwordRequest=request;dialog.querySelector('form').onsubmit=e=>{e.preventDefault();done($('password').value)};
  $('password-cancel').onclick=()=>done(null);dialog.oncancel=e=>{e.preventDefault();done(null)};
  dialog.showModal();$('password').focus();
 });
}
function resetDocumentSession(){
 interruptReadingNavigation();
 documentEpoch++;s.renderGeneration++;navigationOwner=null;navigation=Promise.resolve();
 zoom.reset();flow.destroy();cancelAnimationFrame(visibleFrame);clearTimeout(resizeTimer);clearTimeout(selectionClickTimer);
 initializingDocument=null;initializingFlow=null;press=null;commentTarget=null;commentEditing=null;
 window.getSelection()?.removeAllRanges();closeFloating();
 $('comment-dialog').close();$('settings').hidden=true;
 const area=$('scroll-area');area.scrollTo({top:0,left:0,behavior:'instant'});
 Object.assign(s,{page:null,viewport:null,layout:null,lines:[],readingAnchor:null,textLineMap:new WeakMap(),excludedText:new WeakSet(),selection:null,nativeAnnotations:[],renderedDocumentId:null,renderedPageIndex:null,rendering:false,navigationLock:false,scrollingToLine:false,scrollDestination:null,lockedScrollTop:null,focus:true,draftPending:false});
 $('line-position').textContent='';$('page-message').hidden=true;
 $('focus').classList.add('active');$('focus').setAttribute('aria-pressed','true');
 setTool('select');
}
async function openBytes(input,name,stored,importId=beginOpenIntent()){
 if(importId!==openGeneration)return;if(s.doc)await persist(true);if(importId!==openGeneration)return;closeFloating();busy(true);let next;
 try{const bytes=input instanceof Uint8Array?input:new Uint8Array(input);let password;for(;;){if(importId!==openGeneration)return;try{next=await loadPDF(bytes,password);break}catch(e){if(importId!==openGeneration)return;if(e.name!=='PasswordException')throw e;password=await requestPassword();if(password===null||importId!==openGeneration)return;busy(true)}}
 const id=await fingerprint(bytes);stored=stored||await getDocument(id).catch(()=>null);if(importId!==openGeneration){await next.destroy();return}const previous=s.doc;resetDocumentSession();Object.assign(s,{doc:next,bytes:bytes.slice(),id,name,pageIndex:Math.min(stored?.pageIndex||0,next.numPages-1),lineIndex:stored?.lineIndex||0,restoredLine:stored?.lineAnchor||null,annotations:normalizeDraft(stored?.annotations||[]),nativeByPage:new Map(),undo:[],redo:[],zoom:null,savedSignature:stored?.savedSignature||'[]',storageFailed:false});if(previous)Promise.resolve(previous.destroy()).catch(console.error);
 s.canExport=next.canExportAnnotations!==false;$('save').disabled=!s.canExport;document.querySelectorAll('button[data-tool]:not([data-tool=select]),#selection-menu [data-action=highlight],#selection-menu [data-action=underline],#selection-menu [data-action=comment]').forEach(b=>b.disabled=!s.canExport);if(!s.canExport){setTool('select');toast(next.exportLimitation||'此 PDF 暂不支持写入标注')}
 s.readingAnchor={lineIndex:s.lineIndex,...(stored?.lineAnchor||{}),pageIndex:s.pageIndex};
 $('welcome').hidden=true;$('reader').hidden=false;$('save').hidden=false;$('open').hidden=false;$('doc-title').textContent=name.replace(/\.pdf$/i,'');document.title=name.replace(/\.pdf$/i,'')+' · ADHD Reader';$('page-count').textContent='/ '+next.numPages;
 const owner=beginNavigation();try{if(!await renderPage()||!ownsNavigation(owner)||importId!==openGeneration)return;const record=flow.getRecord(s.pageIndex),index=readingLineIndex(record);if(index>=0)rememberReadingLine(record,index);$('scroll-area').scrollTop=Math.max(0,pageTop(record)-parseFloat(getComputedStyle($('scroll-area')).paddingTop));updateFocus(true);$('scroll-area').focus({preventScroll:true});persist();if(!$('notes-panel').hidden)loadAllNativeAnnotations()}finally{endNavigation(owner)}
 }catch(e){if(importId===openGeneration){console.error(e);toast(e.name==='InvalidPDFException'?'这个文件不是有效的 PDF':e.message||'PDF 未能打开')}if(next&&next!==s.doc)await next.destroy()}finally{if(importId===openGeneration)busy(false)}
}
async function openFile(file){if(!file){focusReader();return}if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast('请选择 PDF 文件');focusReader();return}const importId=beginOpenIntent();busy(true);try{const bytes=new Uint8Array(await file.arrayBuffer());if(importId===openGeneration)await openBytes(bytes,file.name,undefined,importId)}catch(e){if(importId===openGeneration)toast(e.message||'PDF 未能打开')}finally{if(importId===openGeneration){busy(false);focusReader()}}}
$('open').onclick=$('drop-zone').onclick=()=>$('file-input').click();$('file-input').onchange=e=>{openFile(e.target.files[0]);e.target.value=''};$('file-input').addEventListener('cancel',focusReader);
$('home').onclick=async()=>{const intent=beginOpenIntent();documentEpoch++;s.renderGeneration++;navigationOwner=null;s.navigationLock=false;s.rendering=false;zoom.reset();flow.cancel();busy(false);await persist(true);if(intent!==openGeneration)return;clearSelection();$('reader').hidden=true;$('save').hidden=true;$('open').hidden=true;$('welcome').hidden=false;$('doc-title').textContent='';document.title='ADHD Reader';showRecent()};
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;document.body.classList.add('dragging')}});document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault()});document.addEventListener('dragleave',()=>{if(--dragDepth<=0)document.body.classList.remove('dragging')});document.addEventListener('drop',e=>{if(e.dataTransfer?.files.length){e.preventDefault();dragDepth=0;document.body.classList.remove('dragging');openFile(e.dataTransfer.files[0])}});

let latestRender=Promise.resolve();
function renderPage(scrollToLine=false){latestRender=renderPageNow(scrollToLine);return latestRender}
const flow=new ContinuousDocument({container:$('document-pages'),onRendered:record=>{
 if(flow.doc!==s.doc||flow.getRecord(record.index)!==record)return;
 drawRecordAnnotations(record);
 if(record.index===s.pageIndex&&flow.doc===s.doc&&record.ready)adoptPage(record);
},onVisible:index=>{
 if(s.navigationLock||s.scrollingToLine||s.rendering||zoom.active||press||s.selection||$('reader').hidden||!$('busy').hidden)return;
 if(s.lockedScrollTop!=null){if(Math.abs($('scroll-area').scrollTop-s.lockedScrollTop)<1)return;s.lockedScrollTop=null}
 if(index===s.pageIndex)return;
 const record=flow.getRecord(index);if(!record?.ready)return;
 activatePage(record,true);
},onError:error=>console.error(error)});
let visibleFrame,initializingDocument,initializingFlow;
function refreshVisible(){cancelAnimationFrame(visibleFrame);visibleFrame=requestAnimationFrame(()=>{if(!s.doc||flow.doc!==s.doc||$('reader').hidden||zoom.active)return;flow.ensureVisible($('scroll-area')).catch(console.error)})}
function pageTop(record){const area=$('scroll-area');return record.element.getBoundingClientRect().top-area.getBoundingClientRect().top+area.scrollTop}
function lockReadingPosition(){s.lockedScrollTop=$('scroll-area').scrollTop}
const readingScroll=createReadingScroll({
 read:()=>({top:$('scroll-area').scrollTop,left:$('scroll-area').scrollLeft}),
 write:(top,left)=>{const area=$('scroll-area');area.scrollLeft=left;area.scrollTop=top},
 isValid:()=>Boolean(s.doc)&&!$('reader').hidden&&!document.hidden&&!zoom.active,
 reducedMotion:()=>matchMedia('(prefers-reduced-motion: reduce)').matches,
 onFrame:()=>refreshVisible(),
 onFinish:completed=>{s.scrollingToLine=false;s.scrollDestination=null;if(completed)lockReadingPosition();refreshVisible()},
});
function interruptReadingNavigation(){
 readingIntent++;readingRenderWait=null;readingScroll.cancel();s.scrollingToLine=false;s.scrollDestination=null;s.lockedScrollTop=null;
 // Only a pending reading-key render belongs to this queue. Other imports,
 // zoom renders and explicit page navigation keep their independent owners.
 if(readingNavigationOwner&&ownsNavigation(readingNavigationOwner)){
  const browseIndex=readingNavigationOwner.browsePageIndex;
  s.renderGeneration++;s.rendering=false;s.navigationLock=false;navigationOwner=null;
  $('document-pages').style.pointerEvents='';
  // A late render of the locked page must not replace the page being browsed.
  if(Number.isInteger(browseIndex)&&flow.doc===s.doc){
   const record=flow.getRecord(browseIndex);s.pageIndex=browseIndex;
   if(record?.ready)adoptPage(record);
  }
 }
 readingNavigationOwner=null;navigation=Promise.resolve();refreshVisible();
}
function readingViewportMoved(owner=readingNavigationOwner){const expected=owner?.scrollPosition,area=$('scroll-area');return Boolean(expected&&ownsNavigation(owner)&&(Math.abs(area.scrollTop-expected.top)>1||Math.abs(area.scrollLeft-expected.left)>1))}
function waitingReadingViewportMoved(){const wait=readingRenderWait,area=$('scroll-area');return Boolean(wait&&wait.epoch===documentEpoch&&wait.intent===readingIntent&&(Math.abs(area.scrollTop-wait.top)>1||Math.abs(area.scrollLeft-wait.left)>1))}
function acceptNavigationViewport(){if(readingRenderWait){const area=$('scroll-area');readingRenderWait.top=area.scrollTop;readingRenderWait.left=area.scrollLeft}}
async function renderReadingPage(owner){
 const pending=renderPage(false),area=$('scroll-area');
 // Snapshot after synchronous layout/zoom writes, before the cold render waits.
 owner.scrollPosition={top:area.scrollTop,left:area.scrollLeft};
 const rendered=await pending;
 if(readingViewportMoved(owner)){interruptReadingNavigation();return false}
 return rendered;
}
function adoptPage(record){
 if(flow.doc!==s.doc||flow.getRecord(record.index)!==record||!record.ready)return;
 const previous=s.readingAnchor?.pageIndex===record.index?s.readingAnchor:s.renderedDocumentId===s.id&&s.renderedPageIndex===record.index?s.lines[s.lineIndex]:null;
 flow.activate(record.index);
 const lines=record.lines;
 Object.assign(s,{page:record.page,viewport:record.viewport,layout:record.layout,lines,textLineMap:record.textLineMap,excludedText:record.excludedText,restoredLine:null,renderedDocumentId:s.id,renderedPageIndex:record.index,lineIndex:anchoredLineIndex(lines,previous,s.readingAnchor?.pageIndex===record.index?s.readingAnchor.lineIndex:record.lastLineIndex??s.lineIndex),nativeAnnotations:record.nativeAnnotations});
 s.nativeByPage.set(record.index,record.nativeAnnotations);
 $('page-number').value=record.index+1;$('prev-page').disabled=record.index===0;$('next-page').disabled=record.index===s.doc.numPages-1;
 $('page-message').hidden=Boolean(record.textLayer.textContent.trim());$('page-message').textContent='此页没有可选文字，可先进行 OCR';
 if(!zoom.active)$('zoom-fit').textContent=Math.round(flow.scale*100)+'%';updateFocus(false);renderNotes();updateSaveStatus();
}
function activatePage(record,fromScroll=false){
 const old=flow.getRecord(s.pageIndex);if(old)old.lastLineIndex=s.lineIndex;
 s.pageIndex=record.index;s.lineIndex=record.lastLineIndex??0;adoptPage(record);
 if(!fromScroll)lockReadingPosition();
}
async function renderPageNow(scrollToLine=false){
 if(!s.doc)return false;const generation=++s.renderGeneration,epoch=documentEpoch,doc=s.doc;s.rendering=true;
 s.selection=null;window.getSelection()?.removeAllRanges();closeFloating();
 try{
  if(flow.doc!==s.doc||initializingDocument===s.doc){
   if(initializingDocument!==s.doc){const doc=initializingDocument=s.doc;initializingFlow=flow.initialize(doc,1,s.pageIndex).finally(()=>{if(initializingDocument===doc)initializingDocument=null})}
   await initializingFlow;
  }
  if(generation!==s.renderGeneration||epoch!==documentEpoch||doc!==s.doc)return false;
  const available=$('scroll-area').clientWidth-(innerWidth<760?24:76);
  const widest=Math.max(...flow.records.map(r=>r.base.width));
  const scale=s.zoom||Math.min(1.35,Math.max(.35,available/widest));
  flow.setScale(scale);
  zoom.painted({width:parseFloat($('document-pages').style.width),height:parseFloat($('document-pages').style.height),scale});
  $('document-pages').style.pointerEvents='none';
  const record=await flow.ensure(s.pageIndex);if(generation!==s.renderGeneration||epoch!==documentEpoch||flow.doc!==doc||doc!==s.doc)return false;
  adoptPage(record);drawAnnotations();updateFocus(scrollToLine);lockReadingPosition();return true;
 }catch(e){if(generation===s.renderGeneration&&epoch===documentEpoch&&!['RenderingCancelledException','AbortException','AbortError'].includes(e.name)){console.error(e);toast('这一页未能显示，请重试')}return false}finally{if(generation===s.renderGeneration&&epoch===documentEpoch){s.rendering=false;$('document-pages').style.pointerEvents='';refreshVisible()}}
}
function paintRecordFocus(record){
 const layer=record.focusLayer,anchor=s.readingAnchor;layer.hidden=!s.focus;
 const index=readingLineIndex(record,anchor);
 const rect=index>=0&&record.lines[index]?focusRect(record.lines,index,1,record.viewport):null;
 record.outline.hidden=!rect;
 if(!rect){layer.querySelector('.top').style.height=record.viewport.height+'px';for(const side of ['bottom','left','right'])layer.querySelector('.'+side).style.height='0px';return}
 const {x,y,width,height}=rect,right=x+width,bottom=y+height;
 Object.assign(layer.querySelector('.top').style,{height:y+'px'});Object.assign(layer.querySelector('.bottom').style,{top:bottom+'px',height:Math.max(0,record.viewport.height-bottom)+'px'});Object.assign(layer.querySelector('.left').style,{top:y+'px',height:height+'px',width:x+'px'});Object.assign(layer.querySelector('.right').style,{top:y+'px',height:height+'px',width:Math.max(0,record.viewport.width-right)+'px'});Object.assign(record.outline.style,{left:x+'px',top:y+'px',width:width+'px',height:height+'px'});
}
function updateFocus(scroll=false,{direction=0}={}){
 for(const record of flow.records)paintRecordFocus(record);
 const anchor=s.readingAnchor,record=anchor&&flow.getRecord(anchor.pageIndex);
 const index=readingLineIndex(record,anchor);
 $('line-position').textContent=record?.lines[index]?`${index+1} / ${record.lines.length} 行`:'';
 if(!record?.lines[index])return;
 const {x,y,width,height}=focusRect(record.lines,index,1,record.viewport);
 if(scroll){
  const area=$('scroll-area'),view=area.getBoundingClientRect(),page=record.element.getBoundingClientRect();
  const left=view.left+area.clientLeft,top=view.top+area.clientTop;
  const position={top:area.scrollTop,left:area.scrollLeft};
  const planned=scroll!=='center'&&readingScroll.active?readingScroll.target:position;
  const dy=position.top-planned.top,dx=position.left-planned.left;
  const destination=readingScrollTarget({top:page.top+y+dy,bottom:page.top+y+height+dy,left:page.left+x+dx,right:page.left+x+width+dx},
   {top,left,bottom:top+area.clientHeight,right:left+area.clientWidth,height:area.clientHeight,width:area.clientWidth},planned,{center:scroll==='center',direction});
  destination.top=Math.max(0,Math.min(destination.top,Math.max(0,area.scrollHeight-area.clientHeight)));
  destination.left=Math.max(0,Math.min(destination.left,Math.max(0,area.scrollWidth-area.clientWidth)));
  // Test the latest line against the animation's final viewport. Repeated keys
  // can keep a useful destination instead of stopping the motion halfway.
  if(readingScroll.active||Math.abs(position.top-destination.top)>1||Math.abs(position.left-destination.left)>1){
   s.scrollingToLine=true;s.scrollDestination=destination.top;readingScroll.retarget(destination.top,destination.left);
  }
 }
}
function nearestLine(x,y,target){const span=target?.closest?.('span');if(span&&s.excludedText?.has(span))return -1;return readingLineAtPoint(s.layout,x,y,s.textLineMap?.get(span))}
function setLine(index,scroll=true,{direction=0}={}){clearSelection();if(index<0||!s.lines.length)return;s.lineIndex=Math.max(0,Math.min(index,s.lines.length-1));rememberReadingLine(flow.getRecord(s.pageIndex),s.lineIndex);updateFocus(scroll,{direction});persist()}
let navigation=Promise.resolve();
function moveLine(delta){
 clearTimeout(selectionClickTimer);press=null;
 const epoch=documentEpoch,intent=readingIntent;
 navigation=navigation.then(async()=>{
  if(epoch!==documentEpoch||intent!==readingIntent)return;
  while(s.rendering){
   const pending=latestRender,area=$('scroll-area'),wait={epoch,intent,top:area.scrollTop,left:area.scrollLeft};readingRenderWait=wait;
   await pending;
   if(epoch!==documentEpoch||intent!==readingIntent)return;
   if(readingRenderWait===wait&&waitingReadingViewportMoved()){interruptReadingNavigation();return}
   if(readingRenderWait===wait)readingRenderWait=null;
   if(pending===latestRender)break;
  }
  if(!s.doc||!s.readingAnchor||epoch!==documentEpoch||intent!==readingIntent)return;
  if(zoom.active)zoom.reset();
  const anchor=s.readingAnchor,browsePageIndex=s.pageIndex;let owner=null;
  try{
   if(s.pageIndex!==anchor.pageIndex||s.renderedPageIndex!==anchor.pageIndex||!flow.getRecord(anchor.pageIndex)?.ready){
    owner=readingNavigationOwner=beginNavigation();owner.browsePageIndex=browsePageIndex;zoom.reset();s.pageIndex=anchor.pageIndex;s.lineIndex=anchor.lineIndex;
    if(!await renderReadingPage(owner)||!ownsNavigation(owner)||intent!==readingIntent)return;
   }
   s.lineIndex=readingLineIndex(flow.getRecord(s.pageIndex),anchor);
   let tableStep=null;
   if(s.lineIndex<0&&(s.lines.length||anchor.items?.length)){
    tableStep=excludedTableStep(flow.getRecord(s.pageIndex),anchor,delta);
    if(!tableStep)return;
    if(tableStep.index>=0){setLine(tableStep.index,true,{direction:delta});return}
   }
   const next=tableStep?-1:s.lineIndex+delta;
   if(next>=0&&next<s.lines.length){setLine(next,true,{direction:delta});return}
   for(let index=s.pageIndex+(delta>0?1:-1);index>=0&&index<s.doc.numPages;index+=delta>0?1:-1){
    readingScroll.cancel();zoom.reset();s.pageIndex=index;s.lineIndex=delta>0?0:Infinity;
    const record=flow.getRecord(index);if(record)record.lastLineIndex=s.lineIndex;
    if(!owner){owner=readingNavigationOwner=beginNavigation();owner.browsePageIndex=browsePageIndex}
    if(!await renderReadingPage(owner)||!ownsNavigation(owner)||intent!==readingIntent)return;
    if(!s.lines.length)continue;
    rememberReadingLine(flow.getRecord(index),s.lineIndex);updateFocus('center',{direction:delta});persist();return;
   }
   if(s.pageIndex!==anchor.pageIndex){
    s.pageIndex=anchor.pageIndex;s.lineIndex=anchor.lineIndex;
    const record=flow.getRecord(anchor.pageIndex);
    if(record.ready)activatePage(record);
    else if(!await renderReadingPage(owner)||!ownsNavigation(owner)||intent!==readingIntent)return;
   }
   updateFocus(true,{direction:delta});
  }finally{if(owner){if(readingNavigationOwner===owner)readingNavigationOwner=null;endNavigation(owner)}}
 }).catch(console.error);
}
async function goPage(index){
 if(!s.doc||index<0||index>=s.doc.numPages)return false;
 interruptReadingNavigation();
 zoom.reset();s.scrollingToLine=false;s.scrollDestination=null;clearSelection();s.pageIndex=index;s.lineIndex=0;
 const target=flow.getRecord(index);if(target)target.lastLineIndex=0;
 const owner=beginNavigation();try{
  if(!await renderPage()||!ownsNavigation(owner))return false;
  const record=flow.getRecord(index);s.lineIndex=0;rememberReadingLine(record,0);updateFocus(false);$('scroll-area').scrollTop=Math.max(0,pageTop(record)-parseFloat(getComputedStyle($('scroll-area')).paddingTop));acceptNavigationViewport();lockReadingPosition();persist();return true;
 }finally{endNavigation(owner)}
}
$('prev-page').onclick=()=>goPage(s.pageIndex-1);$('next-page').onclick=()=>goPage(s.pageIndex+1);
async function commitPageNumber(resume=false){
 const input=$('page-number'),raw=input.value.trim();
 const index=/^\d+$/.test(raw)?Math.max(0,Math.min(Number(raw)-1,s.doc.numPages-1)):s.pageIndex;
 const epoch=documentEpoch;
 if(index!==s.pageIndex&&!await goPage(index))return;
 if(epoch!==documentEpoch)return;
 input.value=s.pageIndex+1;if(resume)focusReader();
}
$('page-number').onchange=()=>commitPageNumber();
$('page-number').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commitPageNumber(true)}else if(e.key==='Escape'){e.preventDefault();$('page-number').value=s.pageIndex+1;focusReader()}};
const zoom=createPdfZoom({area:$('scroll-area'),shell:$('page-shell'),page:$('document-pages'),label:$('zoom-fit'),enabled:()=>Boolean(s.viewport)&&!$('reader').hidden&&$('busy').hidden&&s.renderedDocumentId===s.id&&s.renderedPageIndex===s.pageIndex,scale:()=>flow.scale,render:async(value,options={})=>{s.zoom=options.fit?null:value;return await renderPage(false)},interrupt:()=>{interruptReadingNavigation();press=null;clearTimeout(selectionClickTimer);clearSelection()}});
function fitDocumentWidth(){const available=$('scroll-area').clientWidth-(innerWidth<760?24:76);zoom.fit(Math.min(1.35,Math.max(.35,available/Math.max(...flow.records.map(r=>r.base.width)))))}
$('zoom-out').onclick=()=>zoom.step(-.15);$('zoom-in').onclick=()=>zoom.step(.15);$('zoom-fit').onclick=fitDocumentWidth;
let resizeTimer;window.addEventListener('resize',()=>{interruptReadingNavigation();clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(s.doc&&!$('reader').hidden&&!s.zoom)fitDocumentWidth()},180)});
$('focus').onclick=()=>{s.focus=!s.focus;$('focus').classList.toggle('active',s.focus);$('focus').setAttribute('aria-pressed',s.focus);updateFocus(false)};
function setTool(tool){if(tool!=='select'&&!s.canExport){toast(s.doc?.exportLimitation||'此文档仅可阅读');return}s.tool=tool;document.body.dataset.tool=tool;document.querySelectorAll('button[data-tool]').forEach(b=>{b.classList.toggle('active',b.dataset.tool===tool);b.setAttribute('aria-pressed',b.dataset.tool===tool)});clearSelection()}
document.querySelectorAll('button[data-tool]').forEach(b=>{
 b.onpointerdown=e=>{if(b.dataset.tool!=='select'&&(s.selection||captureSelection()))e.preventDefault()};
 b.onclick=()=>{const tool=b.dataset.tool;if(tool!=='select'&&(captureSelection()||s.selection))performAction(tool);else setTool(tool)};
});
$('color').onpointerdown=e=>{if(s.selection)e.preventDefault()};
$('color').onclick=()=>{s.color=palette[(palette.indexOf(s.color)+1)%palette.length];document.documentElement.style.setProperty('--note',s.color);persistSettings()};
$('theme').onclick=()=>{s.theme=s.theme==='dark'?'light':'dark';updateTheme();persistSettings()};$('settings-toggle').onclick=()=>$('settings').hidden=!$('settings').hidden;$('settings-close').onclick=()=>$('settings').hidden=true;
$('dim').oninput=e=>{s.dim=Number(e.target.value);$('dim-value').value=s.dim+'%';document.documentElement.style.setProperty('--dim',s.dim/100);persistSettings()};
let notesLoadingDoc;
async function loadAllNativeAnnotations(){const doc=s.doc;if(!doc||notesLoadingDoc===doc)return;notesLoadingDoc=doc;try{for(let i=0;i<doc.numPages;i++){if(s.doc!==doc)return;if(!s.nativeByPage.has(i)){const page=await doc.getPage(i+1);const annotations=await page.getAnnotations({intent:'display'});if(s.doc!==doc)return;s.nativeByPage.set(i,annotations)}}if(s.doc===doc)renderNotes()}catch{if(notesLoadingDoc===doc)notesLoadingDoc=null}}
function toggleNotes(open){interruptReadingNavigation();$('notes-panel').hidden=open===undefined?!$('notes-panel').hidden:!open;if(s.doc&&!s.zoom&&innerWidth>760)fitDocumentWidth();if(!$('notes-panel').hidden)loadAllNativeAnnotations();return Promise.resolve(true)}$('notes-toggle').onclick=()=>toggleNotes();$('notes-close').onclick=()=>toggleNotes(false);

function selectWord(x,y){return selectWordAtPoint(flow.getRecord(s.pageIndex)?.wordIndex,document,x,y)}
$('scroll-area').addEventListener('pointerdown',e=>{
 const element=e.target.closest('.pdf-page');if(!element)return;
 const record=flow.getRecord(Number(element.dataset.pageIndex));if(!record?.ready)return;
 if(record.index!==s.pageIndex)activatePage(record);
 if(e.button!==0||zoom.active||e.target.closest('.annotation-mark'))return;
 closeFloating();s.selection=null;press={x:e.clientX,y:e.clientY,moved:false};
});
window.addEventListener('pointermove',e=>{if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>7)press.moved=true});
window.addEventListener('pointerup',e=>{
 if(!press)return;const p=press,epoch=documentEpoch,intent=readingIntent;press=null;clearTimeout(selectionClickTimer);
 selectionClickTimer=setTimeout(()=>{
  if(epoch!==documentEpoch||intent!==readingIntent||s.rendering||zoom.active)return;
  if(captureSelection()){if(s.tool!=='select')performAction(s.tool);else showSelectionMenu();return}
  if(!p.moved&&$('page-wrap').contains(e.target)){const b=$('page-wrap').getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top,index=nearestLine(x,y,e.target),rect=index>=0&&focusRect(s.lines,index,1,s.viewport);if(rect&&x>=rect.x&&x<=rect.x+rect.width&&y>=rect.y&&y<=rect.y+rect.height)setLine(index,false);$('scroll-area').focus({preventScroll:true})}
 },0);
});
window.addEventListener('pointercancel',()=>{press=null});
$('scroll-area').addEventListener('dblclick',e=>{if(!e.target.closest('.pdf-page'))return;clearTimeout(selectionClickTimer);if(selectWord(e.clientX,e.clientY)&&captureSelection())showSelectionMenu()});

function captureSelection(){
 if(s.rendering||zoom.active||s.renderedPageIndex!==s.pageIndex)return false;
 const sel=window.getSelection();if(!sel?.rangeCount||sel.isCollapsed)return false;
 const range=sel.getRangeAt(0),container=$('document-pages');
 if(!container.contains(range.startContainer)||!container.contains(range.endContainer))return false;
 const text=sel.toString().trim();if(!text)return false;
 const segments=[];let firstAnchor,lastAnchor;
 for(const record of flow.records){
  if(!record.ready||!range.intersectsNode(record.textLayer))continue;
  const base=record.element.getBoundingClientRect();
  const rects=canonicalizePdfRects(selectionRectsFromRange(range,record.textLayer,base).map(r=>viewportRectToPdf(record.viewport,r)),record.viewport.rotation);
  if(!rects.length)continue;
  const local=range.cloneRange(),contents=document.createRange();contents.selectNodeContents(record.textLayer);
  if(local.compareBoundaryPoints(Range.START_TO_START,contents)<0)local.setStart(contents.startContainer,contents.startOffset);
  if(local.compareBoundaryPoints(Range.END_TO_END,contents)>0)local.setEnd(contents.endContainer,contents.endOffset);
  segments.push({pageIndex:record.index,rotation:record.viewport.rotation,rects,text:local.toString().trim()});
  const first=pdfRectToViewport(record.viewport,rects[0]),last=pdfRectToViewport(record.viewport,rects.at(-1));
  firstAnchor??={left:base.left+first.x,top:base.top+first.y};lastAnchor=base.top+last.y+last.height;
 }
 if(!segments.length)return false;
 const current=segments.find(a=>a.pageIndex===s.pageIndex);if(current){const first=pdfRectToViewport(s.viewport,current.rects[0]);const selectedLine=nearestLine(first.x+first.width/2,first.y+first.height/2);if(selectedLine>=0){s.lineIndex=selectedLine;rememberReadingLine(flow.getRecord(s.pageIndex),selectedLine);persist()}}
 s.selection={text,rects:segments[0].rects,segments,anchor:{...firstAnchor,bottom:lastAnchor}};updateFocus();return true;
}
function placePopover(el,anchor,above=false){el.hidden=false;const width=el.offsetWidth,height=el.offsetHeight;const left=Math.max(12,Math.min(innerWidth-width-12,anchor.left));let top=above?anchor.top-height-10:anchor.bottom+10;if(top+height>innerHeight-16)top=anchor.top-height-10;top=Math.max(12,top);el.style.left=left+'px';el.style.top=top+'px'}
function showSelectionMenu(){if(s.selection)placePopover($('selection-menu'),s.selection.anchor,true)}
async function showTranslation(){if(!s.selection)return;const selection=s.selection;const generation=++translationGeneration;$('selection-menu').hidden=true;$('translation-word').textContent=selection.text;$('translation-result').textContent='查询中…';placePopover($('translation'),selection.anchor);try{const result=await translate(selection.text,{context:s.lines.slice(Math.max(0,s.lineIndex-4),s.lineIndex+5).map(line=>line.text).join(' ')});if(generation!==translationGeneration)return;$('translation-result').textContent=result;placePopover($('translation'),selection.anchor)}catch(e){if(generation!==translationGeneration)return;$('translation-result').textContent=e.name==='AbortError'?'查询超时，请重试':e.message}}
$('translation-close').onclick=clearSelection;
document.querySelectorAll('[data-action]').forEach(b=>{b.onpointerdown=e=>e.preventDefault();b.onclick=()=>performAction(b.dataset.action)});
function commitChange(fn){if(!s.canExport)return;s.undo.push(structuredClone(s.annotations));if(s.undo.length>100)s.undo.shift();s.redo=[];fn();drawAnnotations();renderNotes();updateSaveStatus();persist()}
function performAction(type){if(s.rendering||s.renderedPageIndex!==s.pageIndex)return;captureSelection();const selection=s.selection;if(!selection)return;if(type==='translate'){showTranslation();return}if(type==='copy'){navigator.clipboard.writeText(selection.text).then(()=>toast('已复制')).catch(()=>toast('复制失败，可用 Ctrl C'));return}if(!s.canExport){toast(s.doc.exportLimitation);return}if(type==='comment'){commentEditing=null;commentTarget={documentId:s.id,pageIndex:selection.segments[0].pageIndex,rotation:selection.segments[0].rotation,selection:structuredClone(selection)};$('comment-quote').textContent=selection.text;$('comment-text').value='';$('comment-dialog').showModal();$('comment-text').focus();return}commitChange(()=>{for(const segment of selection.segments)s.annotations.push({id:crypto.randomUUID(),...segment,rects:type==='underline'?underlinePdfRects(segment.rects,segment.rotation):segment.rects,type,color:type==='underline'?'#000000':s.color,comment:''})});clearSelection()}
$('comment-save').onclick=()=>{const value=$('comment-text').value.trim();const existing=commentEditing&&s.annotations.find(a=>a.id===commentEditing);if(!value&&(!existing||existing.type==='comment')){$('comment-text').focus();return}if(existing){commitChange(()=>existing.comment=value)}else if(commentTarget?.documentId===s.id){const target=commentTarget;commitChange(()=>s.annotations.push({id:crypto.randomUUID(),pageIndex:target.pageIndex,rotation:target.rotation,type:'comment',rects:target.selection.rects,text:target.selection.text,color:s.color,comment:value}))}$('comment-dialog').close();clearSelection()};
$('comment-dialog').addEventListener('close',()=>{commentTarget=null;commentEditing=null;clearSelection()});
function drawAnnotations(){for(const record of flow.records)if(record.ready)drawRecordAnnotations(record)}
function drawRecordAnnotations(record){
 const layer=record.annotationsLayer;layer.replaceChildren();if(!record.viewport)return;
 for(const a of s.annotations.filter(a=>a.pageIndex===record.index)){
  const group=document.createElement('div');group.className='annotation-group '+a.type;
  for(const rect of a.rects){const r=pdfRectToViewport(record.viewport,rect);const el=document.createElement('div');el.className='annotation-mark '+a.type;Object.assign(el.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',background:a.color});el.style.setProperty('--mark-color',a.color);if(a.type==='underline'){const scale=Math.hypot(record.viewport.transform[0],record.viewport.transform[1]);const m=underlineMetrics(r.height/scale);el.style.setProperty('--underline-width',m.thickness*scale+'px');el.style.setProperty('--underline-inset',m.inset*scale+'px')}el.title=a.comment||a.text||'';el.dataset.annotationId=a.id;group.append(el)}
  layer.append(group);
 }
 paintRecordFocus(record);
}
function renderNotes(){const list=$('notes-list');list.replaceChildren();const native=[];for(const [pageIndex,items] of s.nativeByPage)for(const a of items){if(['Highlight','Underline','Text','FreeText','StrikeOut'].includes(a.subtype))native.push({id:'native:'+a.id,pageIndex,type:a.subtype.toLowerCase(),text:a.titleObj?.str||'PDF 原有标注',comment:a.contentsObj?.str||'',color:'#a5b7a1',readonly:true,rects:[a.rect]})}const notes=[...s.annotations,...native].sort((a,b)=>a.pageIndex-b.pageIndex);if(!notes.length){const p=document.createElement('p');p.className='note-empty';p.textContent='暂无标注';list.append(p);return}for(const a of notes){const card=document.createElement('div');card.className='note-card';card.style.setProperty('--note-color',a.color);const quote=document.createElement('button');quote.type='button';quote.className='note-quote';quote.textContent=a.text||'标注';quote.onclick=async()=>{const epoch=documentEpoch;if(innerWidth<=760)await toggleNotes(false);if(epoch!==documentEpoch)return;if(s.pageIndex!==a.pageIndex&&!await goPage(a.pageIndex))return;if(epoch!==documentEpoch)return;const r=pdfRectToViewport(s.viewport,a.rects[0]);setLine(nearestLine(r.x+r.width/2,r.y+r.height/2));focusReader()};card.append(quote);if(a.comment){const p=document.createElement('p');p.className='note-comment';p.textContent=a.comment;card.append(p)}const meta=document.createElement('div');meta.className='note-meta';const page=document.createElement('span');page.textContent=`第 ${a.pageIndex+1} 页${a.readonly?' · PDF 原有':''}`;meta.append(page);if(!a.readonly){const actions=document.createElement('div');const edit=document.createElement('button');edit.textContent='评论';edit.disabled=!s.canExport;edit.onclick=()=>{commentEditing=a.id;$('comment-quote').textContent=a.text||'';$('comment-text').value=a.comment||'';$('comment-dialog').showModal();$('comment-text').focus()};const del=document.createElement('button');del.textContent='删除';del.disabled=!s.canExport;del.onclick=()=>commitChange(()=>s.annotations=s.annotations.filter(n=>n.id!==a.id));actions.append(edit,del);meta.append(actions)}card.append(meta);list.append(card)}}
function undo(redo=false){if(!s.canExport)return;const from=redo?s.redo:s.undo,to=redo?s.undo:s.redo;if(!from.length)return;to.push(structuredClone(s.annotations));s.annotations=from.pop();drawAnnotations();renderNotes();updateSaveStatus();persist()}
async function savePDF(){if(!s.doc||!s.canExport)return;const source={id:s.id,name:s.name,bytes:s.bytes,epoch:documentEpoch,intent:openGeneration};busy(true,'正在保存');try{const annotations=structuredClone(s.annotations);const bytes=await exportAnnotatedPdf(source.bytes,annotations);const blob=new Blob([bytes],{type:'application/pdf'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=source.name.replace(/\.pdf$/i,'')+'-annotated.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);if(documentEpoch===source.epoch){s.savedSignature=JSON.stringify(annotations);await persist(true);updateSaveStatus()}}catch(e){console.error(e);toast(e.message||'保存失败，请重试')}finally{if(openGeneration===source.intent)busy(false)}}$('save').onclick=savePDF;
document.addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229||!document.getElementById('busy').hidden)return;const typing=e.target.closest('input,textarea,select,[contenteditable=true]');const dialog=document.querySelector('dialog[open]');if(e.key==='Escape'){closeFloating();$('settings').hidden=true;if(!dialog)clearSelection();return}if(typing||dialog||(e.target.closest('button')&&e.key==='Enter'))return;const mod=e.ctrlKey||e.metaKey;if(mod&&e.key.toLowerCase()==='o'){e.preventDefault();$('file-input').click();return}if(!s.doc||$('reader').hidden)return;if(e.target.closest('#scroll-area')&&['PageDown','PageUp','Home','End',' '].includes(e.key)){interruptReadingNavigation();return}if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();savePDF();return}if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);return}if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);return}if(mod||e.altKey||e.shiftKey)return;if(e.key==='Enter'&&captureSelection()){e.preventDefault();if(!e.repeat)showTranslation();return}if(['ArrowUp','ArrowDown','Enter'].includes(e.key)){e.preventDefault();moveLine(e.key==='ArrowUp'?-1:1);return}const key=e.key.toLowerCase();if(key==='f')$('focus').click();else if(key==='v')setTool('select');else if(key==='h')s.selection?performAction('highlight'):setTool('highlight');else if(key==='u')s.selection?performAction('underline'):setTool('underline');else if(key==='n')s.selection?performAction('comment'):setTool('comment')});
document.addEventListener('pointerdown',e=>{if(!$('settings').contains(e.target)&&!$('settings-toggle').contains(e.target))$('settings').hidden=true;if(!e.target.closest('#page-wrap,.popover,dialog,[data-tool],#color')&&!$('selection-menu').hidden)clearSelection()});$('scroll-area').addEventListener('scroll',()=>{const area=$('scroll-area');if(readingScroll.active?!readingScroll.isExpectedPosition({top:area.scrollTop,left:area.scrollLeft}):readingViewportMoved()||waitingReadingViewportMoved())interruptReadingNavigation();closeFloating();refreshVisible()},{passive:true});
// Pointer toolbar actions finish in the reader. Tab/Enter activation keeps its
// native button focus so keyboard users can continue through the controls.
document.addEventListener('click',e=>{if(e.detail>0&&!$('reader').hidden&&e.target.closest('button')?.matches('[data-tool],#focus,#theme,#color,#zoom-out,#zoom-in,#zoom-fit,#prev-page,#next-page,#notes-toggle,#notes-close,#settings-close,#save'))focusReader()});
document.addEventListener('visibilitychange',()=>{if(document.hidden)persist(true)});window.addEventListener('pagehide',()=>persist(true));window.addEventListener('beforeunload',e=>{if((s.storageFailed||s.draftPending)&&signature()!==s.savedSignature){e.preventDefault();e.returnValue=''}});

async function openRemote(){const url=new URLSearchParams(location.search).get('url');if(!url)return;const importId=beginOpenIntent();let bridge;try{if(globalThis.chrome?.runtime?.id){bridge=await import(/* @vite-ignore */chrome.runtime.getURL('bridge.js'));if(importId!==openGeneration)return;const result=await bridge.fetchPDF(url);if(importId===openGeneration)await openBytes(result.bytes,result.name,undefined,importId)}else{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw Error('请导入本地 PDF');const response=await fetch(parsed);if(importId!==openGeneration)return;if(!response.ok)throw Error('链接无法读取，请下载 PDF 后导入');const bytes=new Uint8Array(await response.arrayBuffer());if(importId===openGeneration)await openBytes(bytes,decodeURIComponent(parsed.pathname.split('/').pop())||'document.pdf',undefined,importId)}}catch(e){if(importId!==openGeneration)return;if(e.code==='HOST_PERMISSION_REQUIRED'&&bridge){const button=document.createElement('button');button.className='primary permission-button';button.textContent='允许打开此网站的 PDF';button.onclick=async()=>{const allowed=await bridge.requestAccess(url);if(allowed){button.remove();openRemote()}};$('recent-list').prepend(button)}else toast(e.message||'链接无法读取，请下载 PDF 后导入')}}openRemote();

$('scroll-area').addEventListener('wheel',e=>{if(!e.ctrlKey)interruptReadingNavigation()},{passive:true});
$('scroll-area').addEventListener('touchstart',()=>interruptReadingNavigation(),{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)interruptReadingNavigation()});
