/** One zoom path for buttons, trackpads and touch; paint a preview before rasterizing. */
export function createPdfZoom({area, shell, page, enabled, scale, render, interrupt, label}) {
  const MIN = .35, MAX = 3;
  let target = null, anchor = null, timer, touch, revision = 0, fit = false;
  const clamp = value => Math.min(MAX, Math.max(MIN, value));
  function center() {
    const r = area.getBoundingClientRect();
    return {x:r.left + area.clientWidth / 2, y:r.top + area.clientHeight / 2};
  }
  function locate(point) {
    const r = page.getBoundingClientRect();
    return {y:point.y, v:(point.y-r.top)/r.height};
  }
  function centerHorizontally() {
    // Horizontal layout has one rule at every scale. Gesture X never changes
    // margins; a wide sheet starts with its middle in the reading viewport.
    shell.style.marginLeft='auto';shell.style.marginRight='auto';
    const view=area.getBoundingClientRect(),sheet=page.getBoundingClientRect();
    area.scrollLeft+=sheet.left+sheet.width/2-(view.left+area.clientLeft+area.clientWidth/2);
  }
  function restore(point) {
    centerHorizontally();
    if (!point) return;
    let r = page.getBoundingClientRect();
    area.scrollTop += r.top + point.v*r.height - point.y;
    // A short document can need a vertical inset when scrolling is clamped.
    r=page.getBoundingClientRect();
    const dy=r.top+point.v*r.height-point.y;
    const style=getComputedStyle(shell);
    if(Math.abs(dy)>.5)shell.style.marginTop=Math.max(0,(parseFloat(style.marginTop)||0)-dy)+'px';
    r=page.getBoundingClientRect();
    area.scrollTop+=r.top+point.v*r.height-point.y;
  }
  function preview(value, point=center(), fixedAnchor, fitWidth=false) {
    if (!enabled() || !Number.isFinite(value)) return;
    interrupt();
    anchor = fixedAnchor || locate(point);
    target = clamp(value);
    fit=fitWidth;
    const factor = target / scale();
    shell.style.width = parseFloat(page.style.width)*factor+'px';
    shell.style.height = parseFloat(page.style.height)*factor+'px';
    page.style.transform = `scale(${factor})`;
    page.style.willChange = 'transform';
    page.style.pointerEvents = 'none';
    label.textContent = Math.round(target*100)+'%';
    restore(anchor);
    clearTimeout(timer);
    const version = ++revision;
    timer = setTimeout(() => commit(version), 110);
  }
  async function commit(version) {
    if (version !== revision || target === null) return;
    const previousScale=scale(),previousAnchor=anchor;
    const painted=await render(target,{fit});
    if(version!==revision)return;
    if(painted===false){
      reset();
      const rollbackVersion=revision;
      const restored=await render(previousScale);
      if(rollbackVersion!==revision||restored===false)return;
      restore(previousAnchor);
      return;
    }
    // A newer gesture may already be previewing a later scale.
    if (version === revision) { target=null; anchor=null; page.style.willChange=''; }
  }
  function painted(viewport) {
    shell.style.width=viewport.width+'px'; shell.style.height=viewport.height+'px';
    page.style.transform='';
    if (target !== null) {
      label.textContent=Math.round(target*100)+'%';
      const factor=target/viewport.scale;
      shell.style.width=viewport.width*factor+'px';shell.style.height=viewport.height*factor+'px';
      page.style.transform=factor===1?'':`scale(${factor})`;
      restore(anchor);
    }else centerHorizontally();
  }
  function reset() {
    clearTimeout(timer);revision++;target=null;anchor=null;touch=null;
    page.style.transform='';page.style.willChange='';page.style.pointerEvents='';shell.style.marginLeft='';shell.style.marginTop='';
  }
  // Chromium reports precision-trackpad pinches as cancelable ctrl-wheel events.
  document.addEventListener('wheel', event => {
    if (!event.ctrlKey || !enabled()) return;
    event.preventDefault();
    const point=area.contains(event.target)?{x:event.clientX,y:event.clientY}:center();
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?area.clientHeight:1);
    preview((target??scale())*Math.exp(-delta*.002),point);
  },{passive:false});
  const midpoint = touches => ({x:(touches[0].clientX+touches[1].clientX)/2,y:(touches[0].clientY+touches[1].clientY)/2});
  const distance = touches => Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
  area.addEventListener('touchstart',event=>{
    if(event.touches.length!==2||!enabled())return;
    event.preventDefault();interrupt();
    const separation=distance(event.touches);
    if(separation<1)return;
    touch={distance:separation,scale:target??scale(),anchor:locate(midpoint(event.touches))};
  },{passive:false});
  area.addEventListener('touchmove',event=>{
    if(!touch||event.touches.length!==2)return;
    event.preventDefault();
    const point=midpoint(event.touches);
    preview(touch.scale*distance(event.touches)/touch.distance,point,{...touch.anchor,...point});
  },{passive:false});
  const end=event=>{if(touch&&event.touches.length<2)touch=null};
  area.addEventListener('touchend',end);area.addEventListener('touchcancel',end);
  new ResizeObserver(()=>{if(enabled())centerHorizontally()}).observe(area);
  return {painted,reset,step:delta=>preview((target??scale())+delta),to:value=>preview(value),fit:value=>preview(value,center(),undefined,true),get active(){return target!==null||Boolean(touch)}};
}
