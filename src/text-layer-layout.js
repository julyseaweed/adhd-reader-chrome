/** Prepare selectable text using the PDF's actual glyph advances.
 * The candidate stays hidden until its complete layer can replace the old one.
 */
export async function alignTextLayer(container, textDivs, textContent, viewport, advancesByItem = new Map(), { check = () => {} } = {}) {
  const document=container.ownerDocument, view=document.defaultView, host=document.createElement('div');
  const now=()=>view.performance.now();
  let deadline=now()+8;
  const yieldWork=async()=>{
    check();
    if(typeof view.scheduler?.yield==='function')await view.scheduler.yield();
    else await new Promise(resolve=>view.setTimeout(resolve,0));
    check();deadline=now()+8;
  };
  host.setAttribute('aria-hidden','true');
  host.style.cssText='position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style;';
  host.style.width=viewport.width+'px';host.style.height=viewport.height+'px';
  host.append(container);document.body.append(host);
  try {
    check();
    const scale=Math.hypot(viewport.transform[0],viewport.transform[1]);
    const minimum=parseFloat(view.getComputedStyle(container).getPropertyValue('--min-font-size'))||1;
    const updates=[],clusters=[],whitespace=[];let divIndex=0,itemIndex=-1;
    for(const item of textContent.items){
      itemIndex++;
      if(typeof item.str!=='string')continue;
      const div=textDivs[divIndex++];
      if(!div?.isConnected||!item.str)continue;
      if(!item.str.trim())whitespace.push(div);
      const style=textContent.styles[item.fontName];
      const advance=Math.abs(style?.vertical?item.height:item.width)*scale;
      const computed=view.getComputedStyle(div),width=parseFloat(computed.width);
      if(!(advance>0&&width>0&&Number.isFinite(advance/width)))continue;
      const mapped=advancesByItem.get(itemIndex);
      if(mapped?.clusters?.length)clusters.push({div,item,mapped,height:computed.height,advance:advance*minimum,fragment:document.createDocumentFragment()});
      else updates.push([div,advance*minimum/width]);
      if(now()>=deadline)await yieldWork();
    }
    container.remove();
    // Separate whitespace remains selectable but cannot steal a drag start.
    for(const div of whitespace)div.style.pointerEvents='none';
    for(const [div,factor] of updates)div.style.setProperty('--scale-x',String(factor));
    for(const {div,height,advance} of clusters){
      div.replaceChildren();div.style.width=advance+'px';div.style.height=height;
      div.style.setProperty('--scale-x','1');
      if(now()>=deadline)await yieldWork();
    }
    const prototype=document.createElement('pdf-glyph');
    // Keep glyphs in the same inline formatting context. Out-of-flow glyphs
    // create an extra native keyboard caret stop between every two letters.
    prototype.style.cssText='position:relative;top:0;display:inline-block;vertical-align:top;font:inherit;color:inherit;white-space:pre;transform-origin:0 0;pointer-events:none;';
    const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),counts=new Map();
    const count=text=>{
      if(text.length===1)return 1;
      if(!counts.has(text))counts.set(text,[...segmenter.segment(text)].length);
      return counts.get(text);
    };
    let batch=[];
    const flowWidths=new WeakMap();
    const finishBatch=async()=>{
      check();
      // Only this bounded batch is connected for measurement. Connecting all
      // glyphs at once would turn the first width read into one long layout.
      host.append(container);
      const measured=batch.map(({glyph,advance})=>[glyph,
        (advance-parseFloat(view.getComputedStyle(glyph).width))/count(glyph.textContent),advance]);
      for(let index=0;index<batch.length;index++){
        const {glyph}=batch[index],[,spacing,advance]=measured[index];
        if(Number.isFinite(spacing)){
          // Real layout width also fixes native caret hit testing; scaleX alone
          // changes paint without reliably changing the browser's caret width.
          glyph.style.letterSpacing=(Math.abs(spacing)<1e-6?0:spacing)+'px';
          glyph.style.width=advance+'px';
          // Negative spacing must not overlap translucent selection paint.
          glyph.style.overflowX='clip';
        }
      }
      const widths=batch.map(({glyph})=>parseFloat(view.getComputedStyle(glyph).width));
      container.remove();
      for(let index=0;index<batch.length;index++){
        const {glyph,fragment,offset}=batch[index],flowWidth=flowWidths.get(fragment)||0;
        // CSS rounds each inline width to subpixels. Correct the visual origin
        // against the PDF after measuring those widths, so errors never accrue.
        glyph.style.left=(offset-flowWidth)+'px';
        flowWidths.set(fragment,flowWidth+widths[index]);fragment.append(glyph);
      }
      batch=[];
      if(now()>=deadline)await yieldWork();
    };
    for(const {div,item,mapped,fragment} of clusters){
      for(const cluster of mapped.clusters){
        const glyph=prototype.cloneNode();glyph.textContent=item.str.slice(cluster.start,cluster.end);
        div.append(glyph);batch.push({glyph,fragment,offset:cluster.offset*scale*minimum,advance:cluster.advance*scale*minimum});
        if(batch.length>=256||now()>=deadline)await finishBatch();
      }
    }
    if(batch.length)await finishBatch();
    for(const {div,fragment} of clusters){
      div.replaceChildren(fragment);
      if(now()>=deadline)await yieldWork();
    }
    check();
  } finally {
    container.remove();host.remove();
  }
}
