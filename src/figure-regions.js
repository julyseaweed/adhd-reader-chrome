// Reading order is separate from PDF text selection. Use the PDF's graphics
// containers first; captions only locate ungrouped drawings, never define a
// list of words that should disappear from the document.
const right = r => r.right ?? r.x + r.width;
const bottom = r => r.bottom ?? r.y + r.height;
const area = r => Math.max(0, right(r) - r.x) * Math.max(0, bottom(r) - r.y);
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] || 10;
const bounds = r => r && [r.x, r.y, right(r), bottom(r)].every(Number.isFinite)
  ? { x:r.x, y:r.y, width:right(r)-r.x, height:bottom(r)-r.y, right:right(r), bottom:bottom(r) } : null;
const overlap = (a, b) => Math.max(0, Math.min(right(a), right(b))-Math.max(a.x,b.x))
  * Math.max(0, Math.min(bottom(a), bottom(b))-Math.max(a.y,b.y));
const union = rs => bounds({ x:Math.min(...rs.map(r=>r.x)), y:Math.min(...rs.map(r=>r.y)),
  right:Math.max(...rs.map(right)), bottom:Math.max(...rs.map(bottom)) });
const inside = (a,b,tolerance=0) => a.x >= b.x-tolerance && right(a) <= right(b)+tolerance
  && a.y >= b.y-tolerance && bottom(a) <= bottom(b)+tolerance;
const caption = text => /^\s*(?:fig(?:ure)?s?\.?|figura|abb(?:ildung)?\.?|图|圖|図|그림)\s*[\d一二三四五六七八九十IVX]+(?:\b|[.:：、\s])/iu.test(text);
const white = color => {
  if (typeof color === 'string') return /^#f{3}(?:f{3})?$/i.test(color) || color === 'white';
  return Array.isArray(color) && color.length >= 3 && color.slice(0,3).every(v=>v >= (Math.max(...color)>1 ? 250 : .98));
};
const visibleGraphic = g => g.bounds && !g.whiteBackground && !(g.fill && !g.stroke && white(g.fillColor));
const project = (r,angle,inverse=false) => {
  const c=Math.cos(angle),s=Math.sin(angle),pts=[[r.x,r.y],[right(r),r.y],[r.x,bottom(r)],[right(r),bottom(r)]];
  const xs=pts.map(([x,y])=>inverse?x*c-y*s:x*c+y*s),ys=pts.map(([x,y])=>inverse?x*s+y*c:-x*s+y*c);
  return bounds({x:Math.min(...xs),y:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)});
};

// Extraction baselines can contain text from several columns. Caption evidence
// belongs to a contiguous text run, not to everything sharing its screen Y.
const captionRuns = lines => lines.flatMap(line => {
  const angle=line.angle||0, em=median(line.items.map(item=>item.fontHeight)), groups=[];
  for(const item of [...line.items].sort((a,b)=>project(a,angle).x-project(b,angle).x)) {
    const box=project(item,angle),previous=groups.at(-1);
    if(previous && box.x-previous.right<=em*2.2) {previous.items.push(item);previous.right=Math.max(previous.right,box.right);}
    else groups.push({items:[item],right:box.right});
  }
  return groups.map(group=>({...union(group.items),angle,items:group.items,text:group.items.map(item=>item.str).join(' ')}));
});

/** Return complete graphics regions and exact excluded text items. */
export function partitionFigureContent({ items, baselineLines, structures = {}, viewport }) {
  const em = median(items.map(item=>item.fontHeight).filter(n=>n>0));
  const pageArea = viewport.width * viewport.height;
  const images = (structures.images || []).filter(image=>bounds(image.bounds));
  const graphics = (structures.graphics || []).filter(visibleGraphic);
  const textRuns=captionRuns(baselineLines);
  const captions = textRuns.filter(line=>caption(line.text));
  const captionBlocks=captions.map(first=>{
    const angle=first.angle||0, members=[first];let current=project(first,angle);
    const size=median(first.items.map(item=>item.fontHeight));
    const following=textRuns.filter(line=>line!==first&&Math.abs(Math.sin((line.angle||0)-angle))<.05)
      .map(line=>({line,box:project(line,angle)})).sort((a,b)=>a.box.y-b.box.y);
    for(const next of following){
      if(next.box.y<=current.y+size*.3)continue;
      if(next.box.y-current.bottom>size*.8)break;
      const nextSize=median(next.line.items.map(item=>item.fontHeight));
      if(Math.abs(next.box.x-project(first,angle).x)>size*3 || Math.abs(nextSize-size)>size*.15)continue;
      members.push(next.line);current=next.box;
    }
    return {angle,members,bounds:union(members.map(line=>project(line,angle)))};
  });
  const captionItems = new Set(captionBlocks.flatMap(block=>block.members.flatMap(line=>line.items.map(item=>item.index))));
  const captionNear = box => captions.find(line=>{
    const angle=line.angle||0,c=Math.cos(angle),s=Math.sin(angle);
    const project=r=>{const pts=[[r.x,r.y],[right(r),r.y],[r.x,bottom(r)],[right(r),bottom(r)]];
      const xs=pts.map(([x,y])=>x*c+y*s),ys=pts.map(([x,y])=>-x*s+y*c);
      return {x:Math.min(...xs),y:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};};
    const a=project(box),b=project(line);
    const cross=Math.min(a.right,b.right)-Math.max(a.x,b.x),gap=Math.max(b.y-a.bottom,a.y-b.bottom,0);
    return cross>Math.min(a.right-a.x,b.right-b.x)*.4 && gap<em*4 && gap>em*.05;
  });
  const candidates = [];
  const plausible = box => box && box.width > em*2.5 && box.height > em*2.5
    && Math.max(box.width,box.height)>em*5 && area(box)<pageArea*.82;
  const supporting = (container, values, idsKey) => {
    const ids = new Set(container[idsKey] || []);
    return values.filter(value=>ids.has(value.id) || value.formId===container.id || value.groupId===container.id
      || (container.bounds && inside(value.bounds,container.bounds,em*.05)));
  };
  const proseOverlay = box => baselineLines.filter(line=>{
    const a=project(box,line.angle||0),b=project(line,line.angle||0),text=line.text||line.items.map(i=>i.str).join(' ');
    return inside(line,box,em*.1) && b.width>a.width*.55
      && ((text.match(/\p{L}{3,}/gu)||[]).length>=4 || (text.match(/\p{Lo}/gu)||[]).length>=16);
  }).length>=2;
  const containers=[...(structures.forms||[]), ...(structures.groups||[])];
  const marks=values=>values.filter(g=>!g.rectangular && (g.fill||g.closed)
    && g.bounds.width>em*.15 && g.bounds.height>em*.15 && Math.max(g.bounds.width,g.bounds.height)<em*2.4);
  const coordinates=values=>values.sort((a,b)=>a-b).filter((value,index,all)=>!index||value-all[index-1]>em*.3);
  for (const container of containers) {
    const box = bounds(container.bounds || container.clipBounds || container.declaredBounds || container.paintBounds);
    if (!plausible(box)) continue;
    const ownImages = supporting({...container,bounds:box},images,'imageIds').filter(image=>area(image.bounds)>em*em*6);
    const ownGraphics = supporting({...container,bounds:box},graphics,'graphicIds')
      .filter(g=>!(g.fill && area(g.bounds)>area(box)*.65));
    const curved = ownGraphics.filter(g=>g.curved).length;
    const nonRectangular = ownGraphics.filter(g=>!g.rectangular && g.bounds.width>em*1.5 && g.bounds.height>em*1.5).length;
    const painted = ownGraphics.filter(g=>g.fill && area(g.bounds)>em*em).length;
    const points=marks(ownGraphics), spread=points.length?union(points.map(g=>g.bounds)):null;
    const horizontal=ownGraphics.filter(g=>g.bounds.width>em*5&&g.bounds.height<em*.25);
    const vertical=ownGraphics.filter(g=>g.bounds.height>em*5&&g.bounds.width<em*.25);
    const xs=coordinates(points.map(g=>g.bounds.x+g.bounds.width/2)),ys=coordinates(points.map(g=>g.bounds.y+g.bounds.height/2));
    const cells=new Set(points.map(g=>[xs.findIndex(x=>Math.abs(x-g.bounds.x-g.bounds.width/2)<=em*.3),ys.findIndex(y=>Math.abs(y-g.bounds.y-g.bounds.height/2)<=em*.3)].join(':')));
    // A ruled matrix of repeated cell symbols is table data. Axes and a cloud
    // of irregular points are different evidence; a figure caption can also
    // explicitly identify a regular plot such as a heatmap.
    const symbolTable=xs.length>=3 && ys.length>=3 && cells.size>=xs.length*ys.length*.8
      && horizontal.length>=ys.length+1 && vertical.length>=xs.length+1;
    const scatter=points.length>=4 && spread.width>em*4 && spread.height>em*4
      && xs.length>=3 && ys.length>=3 && horizontal.length && vertical.length && !proseOverlay(box);
    if(ownImages.length && ownImages.every(image=>proseOverlay(image.bounds)) && ownGraphics.length<4 && !captionNear(box))continue;
    if(!ownImages.length && symbolTable && !captionNear(box))continue;
    if (!ownImages.length && !(ownGraphics.length>=4 && (curved || nonRectangular>=3 || painted>=3 && captionNear(box) || scatter))) continue;
    const support=[...ownImages,...ownGraphics].map(value=>value.bounds);
    candidates.push({...box,id:container.id,source:container.kind||'form',evidence:'graphics-container',contentBounds:support.length?union(support):box});
  }
  // Some exporters put a chart's title and legend in an adjacent Form. Connect
  // only touching, shallow containers with drawn symbols to a confirmed chart.
  // Plain paragraphs and tables provide no such symbol-strip evidence.
  const angles=baselineLines.map(line=>line.angle||0).sort((a,b)=>a-b);
  const frameAngle=angles[Math.floor(angles.length/2)]??0;
  let extended=true;
  while(extended) {
    extended=false;
    for(const container of containers) {
      if(candidates.some(candidate=>candidate.id===container.id))continue;
      const box=bounds(container.bounds);if(!box||proseOverlay(box))continue;
      const local=project(box,frameAngle);
      if(local.height>em*6||local.width<em*4)continue;
      const own=supporting({...container,bounds:box},graphics,'graphicIds');
      if(!marks(own).length)continue;
      const touches=candidates.some(candidate=>{
        const other=project(candidate,frameAngle),cross=Math.min(local.right,other.right)-Math.max(local.x,other.x);
        const gap=Math.max(local.y-other.bottom,other.y-local.bottom,0);
        return cross>=Math.min(local.width,other.width)*.75 && gap<=em*.2;
      });
      if(touches){candidates.push({...box,id:container.id,source:container.kind||'form',evidence:'adjacent-legend-container',contentBounds:union(own.map(g=>g.bounds))});extended=true;}
    }
  }
  // Standalone images are also graphics, but full-page scan backgrounds are not
  // figure evidence: their overlaid OCR must remain readable.
  for (const image of images) {
    const box = bounds(image.bounds);
    if (plausible(box) && area(box)<pageArea*.65 && (!proseOverlay(box)||captionNear(box))) candidates.push({...box,id:image.id,source:'image',evidence:'image',contentBounds:box});
  }
  // PDFs exported without Form/Group containers still contain painted shapes.
  // Join touching shapes, then require a nearby figure caption to distinguish
  // plots from tables, ruled paragraphs, and mathematical notation.
  const clusters = [];
  for (const graphic of graphics) {
    const box=bounds(graphic.bounds); if(!box || area(box)>pageArea*.82) continue;
    const near = clusters.filter(c=>c.box.x<=right(box)+em*.65 && right(c.box)>=box.x-em*.65
      && c.box.y<=bottom(box)+em*.65 && bottom(c.box)>=box.y-em*.65);
    const members=[graphic,...near.flatMap(c=>c.members)];
    for(const cluster of near) clusters.splice(clusters.indexOf(cluster),1);
    clusters.push({members,box:union(members.map(g=>g.bounds))});
  }
  for (const cluster of clusters) {
    const box=cluster.box;
    if(!plausible(box) || cluster.members.length<3) continue;
    const nearbyCaption=captionNear(box);
    if(nearbyCaption) {
      // Axis ticks sit just outside the painted frame. Expand in the caption's
      // reading frame, stopping before the caption itself, including rotations.
      const angle=nearbyCaption.angle||0,transform=(r,inverse=false)=>project(r,angle,inverse);
      const a=transform(box),cap=transform(nearbyCaption),padding=em*1.4;
      const padded=bounds({x:a.x-padding,y:a.y-padding,right:a.right+padding,bottom:a.bottom+padding});
      if(cap.y>=a.bottom) {padded.bottom=Math.min(padded.bottom,cap.y-em*.15);padded.height=padded.bottom-padded.y;}
      else if(cap.bottom<=a.y) {padded.y=Math.max(padded.y,cap.bottom+em*.15);padded.height=padded.bottom-padded.y;}
      candidates.push({...transform(padded,true),id:`cluster-${cluster.members[0].id}`,source:'drawing',evidence:'caption-adjacent-drawing',contentBounds:box});
    }
  }
  const separated=candidates.map(candidate=>{
    let box=candidate;
    for(const block of captionBlocks){
      const cap=block.bounds,frame=project(box,block.angle),ink=project(candidate.contentBounds,block.angle);
      if(Math.min(frame.right,cap.right)<=Math.max(frame.x,cap.x)||!overlap(frame,cap))continue;
      if(ink.bottom<cap.y && cap.y>frame.y) frame.bottom=Math.min(frame.bottom,cap.y-em*.15);
      else if(ink.y>cap.bottom && cap.bottom<frame.bottom)frame.y=Math.max(frame.y,cap.bottom+em*.15);
      frame.height=frame.bottom-frame.y;
      box={...candidate,...project(frame,block.angle,true)};
    }
    return box;
  });
  const regions=[];
  for(const candidate of separated.sort((a,b)=>area(b)-area(a))) {
    if(regions.some(region=>inside(candidate,region,em*.05))) continue;
    regions.push(candidate);
  }
  const excludedItems=[], retainedItems=[];
  for(const item of items) {
    if(captionItems.has(item.index)) { retainedItems.push(item); continue; }
    const box=bounds(item);
    // A long body line intersecting a wrapped image is not an image label.
    const region=regions.find(region=>overlap(box,region)>=area(box)*.8);
    if(region) excludedItems.push({item,regionId:region.id}); else retainedItems.push(item);
  }
  return {items:retainedItems,excludedItems,regions};
}
