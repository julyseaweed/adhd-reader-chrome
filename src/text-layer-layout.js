/** Bind selectable DOM text to the PDF's authoritative advance widths.
 * Canvas and DOM do not have identical font hinting/kerning, especially at
 * different DPRs. Measure the actual connected spans before publishing a page.
 */
export function alignTextLayer(container, textDivs, textContent, viewport) {
  const document=container.ownerDocument, host=document.createElement('div');
  host.setAttribute('aria-hidden','true');
  host.style.cssText='position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style;';
  host.style.width=viewport.width+'px';host.style.height=viewport.height+'px';
  host.append(container);document.body.append(host);
  try {
    const scale=Math.hypot(viewport.transform[0],viewport.transform[1]);
    const minimum=parseFloat(document.defaultView.getComputedStyle(container).getPropertyValue('--min-font-size'))||1;
    const updates=[];let divIndex=0;
    for(const item of textContent.items){
      if(typeof item.str!=='string')continue;
      const div=textDivs[divIndex++];
      if(!div?.isConnected||!item.str)continue;
      const style=textContent.styles[item.fontName];
      const advance=Math.abs(style?.vertical?item.height:item.width)*scale;
      // Computed width is the untransformed, fractional DOM advance. Reading it
      // is independent of page rotation and the previous PDF.js scale estimate.
      const width=parseFloat(document.defaultView.getComputedStyle(div).width);
      if(advance>0&&width>0&&Number.isFinite(advance/width))updates.push([div,advance*minimum/width]);
    }
    // Batch reads before writes: one layout for a page, never one per glyph.
    for(const [div,factor] of updates)div.style.setProperty('--scale-x',String(factor));
  } finally {
    container.remove();host.remove();
  }
}
