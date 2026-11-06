// One page layout model for membership, traversal and viewport following.
// Inputs are typographic pieces, before irreversible same-row joins.
const right = box => box.x + box.width;
const bottom = box => box.y + box.height;
const centerY = box => box.y + box.height / 2;
const round = value => Math.round(value * 100) / 100;
const boundsOf = records => ({
  x: Math.min(...records.map(row => row.box.x)), y: Math.min(...records.map(row => row.box.y)),
  width: Math.max(...records.map(row => right(row.box))) - Math.min(...records.map(row => row.box.x)),
  height: Math.max(...records.map(row => bottom(row.box))) - Math.min(...records.map(row => row.box.y)),
});
function distinctRows(rows) {
  const baselines=[];
  for(const row of rows)if(!baselines.some(value=>Math.abs(value-row.baseline)<row.em*.3))baselines.push(row.baseline);
  return baselines.length;
}

export function createReadingRegions(rows, { bounds, em, scale = 1 }) {
  const records=rows.map(row=>({...row, box:Object.fromEntries(Object.entries(row.box).map(([key,value])=>[key,round(value/scale)])),
    baseline:round(row.baseline/scale),em:row.em/scale}));
  const pageBounds=Object.fromEntries(Object.entries(bounds).map(([key,value])=>[key,round(value/scale)]));
  const typical=em/scale, all=[];
  function make(kind,box,path,parent,flowId) {
    const node={id:path,parentId:parent?.id??null,kind,...box,flowId,children:[]};
    all.push(node);return node;
  }
  function candidates(part,box) {
    const anchors=part.filter(row=>row.flow && row.box.width>=row.em*4);
    if(anchors.length<4)return [];
    const edges=[...new Set(anchors.flatMap(row=>[row.box.x,right(row.box)]).map(round))].sort((a,b)=>a-b);
    const found=new Map();
    for(let i=1;i<edges.length;i++){
      const probe=(edges[i-1]+edges[i])/2;
      const left=anchors.filter(row=>right(row.box)<=probe+.001),after=anchors.filter(row=>row.box.x>=probe-.001);
      if(distinctRows(left)<2||distinctRows(after)<2)continue;
      const leftEdge=Math.max(...left.map(row=>right(row.box))),rightEdge=Math.min(...after.map(row=>row.box.x));
      const gap=rightEdge-leftEdge;
      const supportSizes=[...left,...after].map(row=>row.em).sort((a,b)=>a-b);
      const supportEm=supportSizes[Math.floor(supportSizes.length/2)]||typical;
      if(gap<supportEm*.75)continue;
      if(gap<supportEm*1.8 && (distinctRows(left.filter(row=>leftEdge-right(row.box)<row.em*.25))<2
        ||distinctRows(after.filter(row=>row.box.x-rightEdge<row.em*.25))<2))continue;
      const cut=round((leftEdge+rightEdge)/2), crossing=anchors.filter(row=>row.box.x<cut && right(row.box)>cut);
      const value={cut,left,after,crossing,gap,score:Math.min(left.length,after.length)+gap/Math.max(1,box.width)};
      if(!found.has(cut)||found.get(cut).score<value.score)found.set(cut,value);
    }
    return [...found.values()];
  }
  function sequence(part,groups,box,path,parent,flowId) {
    groups=groups.filter(group=>group.length).sort((a,b)=>boundsOf(a).y-boundsOf(b).y);
    if(groups.length<2)return null;
    const node=make('sequence',box,path,parent,flowId), boxes=groups.map(boundsOf);
    let top=box.y;
    for(let i=0;i<groups.length;i++){
      const end=i===groups.length-1?bottom(box):round((bottom(boxes[i])+boxes[i+1].y)/2);
      node.children.push(build(groups[i],{x:box.x,y:top,width:box.width,height:end-top},`${path}/s${i}`,node,flowId));top=end;
    }
    return node;
  }
  function splitSpans(part,spans,box,path,parent,flowId) {
    if(!spans.length)return null;
    const bands=[];
    for(const row of [...spans].sort((a,b)=>a.box.y-b.box.y)){
      const band=bands.at(-1);
      if(band && row.box.y-band.bottom<Math.max(typical*.8,row.em*.8)){
        band.bottom=Math.max(band.bottom,bottom(row.box));band.members.push(row);
      } else bands.push({top:row.box.y,bottom:bottom(row.box),members:[row]});
    }
    const groups=[];let remaining=[...part];
    for(const band of bands){
      const before=remaining.filter(row=>centerY(row.box)<band.top);
      const inside=remaining.filter(row=>centerY(row.box)>=band.top&&centerY(row.box)<=band.bottom);
      groups.push(before,inside);const used=new Set([...before,...inside]);remaining=remaining.filter(row=>!used.has(row));
    }
    groups.push(remaining);
    return sequence(part,groups,box,path,parent,flowId);
  }
  function build(part,box,path,parent,flowId) {
    const cuts=candidates(part,box);
    if(!cuts.length)return make('flow',box,path,parent,flowId);
    const flowSizes=part.filter(row=>row.flow&&row.box.width>=row.em*4).map(row=>row.em).sort((a,b)=>a-b);
    const bodyEm=flowSizes[Math.floor(flowSizes.length/2)]||typical;
    const low=Math.min(...cuts.map(cut=>cut.cut)),high=Math.max(...cuts.map(cut=>cut.cut));
    const spanning=row=>row.box.x<low-typical*.4 && right(row.box)>high+typical*.4;
    // Choose a persistent gutter first. A subtitle spanning only two of three
    // columns then lives inside that two-column child, not across the third.
    // Small explanatory labels (for example under a displayed equation) do not
    // redefine the body gutter. Their actual crossing ink still forms its own
    // local spanning band below, rather than being assigned to either column.
    const smallLabel=row=>row.em<bodyEm*.86&&!part.some(other=>other!==row&&other.flow
      &&Math.abs(other.em-row.em)<row.em*.1&&Math.abs(other.box.x-row.box.x)<row.em*.5
      &&Math.abs(other.baseline-row.baseline)>row.em*.8&&Math.abs(other.baseline-row.baseline)<row.em*1.8);
    const stable=cuts.filter(cut=>cut.crossing.every(row=>spanning(row)||smallLabel(row))).sort((a,b)=>b.score-a.score||a.cut-b.cut)[0];
    if(stable){
      const spans=part.filter(row=>row.box.x<stable.cut-typical*.4&&right(row.box)>stable.cut+typical*.4);
      const divided=splitSpans(part,spans,box,path,parent,flowId);
      if(divided)return divided;
      const before=part.filter(row=>row.box.x+row.box.width/2<stable.cut),after=part.filter(row=>!before.includes(row));
      if(before.length&&after.length){
        const node=make('columns',box,path,parent,flowId);
        node.cut=stable.cut;
        node.children.push(build(before,{x:box.x,y:box.y,width:stable.cut-box.x,height:box.height},`${path}/c0`,node,`${path}/c0`));
        node.children.push(build(after,{x:stable.cut,y:box.y,width:right(box)-stable.cut,height:box.height},`${path}/c1`,node,`${path}/c1`));
        return node;
      }
    }
    // A topology change (for example two columns followed by three) cannot
    // have one page-long gutter. Genuine spanning text separates those blocks.
    const divided=splitSpans(part,part.filter(spanning),box,path,parent,flowId);
    if(divided)return divided;
    // A full-width gap can separate layout blocks when there is no heading.
    // It never splits already established continuous columns.
    const sorted=[...part].sort((a,b)=>a.box.y-b.box.y);let end=-Infinity,bestGap=typical*1.8,split;
    for(const row of sorted){const gap=row.box.y-end;if(Number.isFinite(end)&&gap>bestGap){bestGap=gap;split=(row.box.y+end)/2;}end=Math.max(end,bottom(row.box));}
    if(split!==undefined)return sequence(part,[part.filter(row=>centerY(row.box)<split),part.filter(row=>centerY(row.box)>=split)],box,path,parent,flowId);
    return make('flow',box,path,parent,flowId);
  }
  // Running matter occupies a small outer page band separated from all body
  // columns by whitespace. Its left alignment does not make it a continuation
  // of the left column. Ordinary paragraph gaps inside the body are untouched.
  function runningBands(part) {
    const sorted=[...part].sort((a,b)=>a.box.y-b.box.y);let end=-Infinity;
    const cuts=[];
    const runningEvidence=group=>group.some(row=>{
      const text=String(row.line?.text??row.text??'').trim();
      const folio=/^\d{1,6}$/u.test(text)&&row.box.width<row.em*3
        &&Math.abs(row.box.x+row.box.width/2-(pageBounds.x+pageBounds.width/2))<pageBounds.width*.12;
      return folio||/[©®]/u.test(text);
    });
    for(let i=0;i<sorted.length;i++){
      const row=sorted[i],gap=row.box.y-end;
      if(i&&gap>typical*2.8){
        const before=sorted.slice(0,i),after=sorted.slice(i),a=boundsOf(before),b=boundsOf(after);
        const footer=b.y>bottom(pageBounds)-pageBounds.height*.1&&b.height<typical*3.5&&distinctRows(after)<=4&&runningEvidence(after);
        const header=bottom(a)<pageBounds.y+pageBounds.height*.1&&a.height<typical*3.5&&distinctRows(before)<=4&&runningEvidence(before);
        if(footer||header)cuts.push((end+row.box.y)/2);
      }
      end=Math.max(end,bottom(row.box));
    }
    if(!cuts.length)return null;
    const groups=Array.from({length:cuts.length+1},()=>[]);
    for(const row of part){let index=0;while(index<cuts.length&&centerY(row.box)>cuts[index])index++;groups[index].push(row);}
    return sequence(part,groups,pageBounds,'page',null,null);
  }
  const root=runningBands(records)||build(records,pageBounds,'page',null,null);
  const pathFor=node=>{const path=[];for(let current=node;current;current=all.find(value=>value.id===current.parentId))path.unshift(current.id);return path;};
  for(const node of all){node.path=pathFor(node);node.x*=scale;node.y*=scale;node.width*=scale;node.height*=scale;if(node.cut!==undefined)node.cut*=scale;}
  const byId=new Map(all.map(node=>[node.id,node]));
  // Sequence boundaries describe traversal, not mathematical ownership. A
  // raised glyph may lie just above its expression's provisional band. Only
  // divergence into different children of a column node forbids a local link.
  function permitsLocalConnection(first,second){
    const a=typeof first==='string'?byId.get(first):first,b=typeof second==='string'?byId.get(second):second;
    if(!a||!b)return false;
    let index=0;while(index<Math.min(a.path.length,b.path.length)&&a.path[index]===b.path[index])index++;
    if(index===a.path.length||index===b.path.length)return true;
    return byId.get(a.path[index-1])?.kind!=='columns';
  }
  // Query uses viewport coordinates after publication.
  function lookup(box){
    let node=root;
    while(node.children.length){
      if(node.kind==='columns'){
        if(box.x<node.cut-em*.4&&right(box)>node.cut+em*.4)break;
        node=node.children[midpointX(box)<node.cut?0:1];
      }else{const cy=centerY(box);node=node.children.find(child=>cy>=child.y&&cy<bottom(child))||node.children[cy<node.y?0:node.children.length-1];}
    }
    return node;
  }
  function midpointX(box){return box.x+box.width/2;}
  function assignOrder(lines, boxFor=line=>line) {
    const buckets=new Map();
    for(const line of lines){const node=lookup(boxFor(line));if(!buckets.has(node.id))buckets.set(node.id,[]);buckets.get(node.id).push(line);
      line.regionId=node.id;line.regionPath=node.path;line.flowId=node.flowId||node.id;line.regionBounds={x:node.x,y:node.y,width:node.width,height:node.height};}
    let rank=0;
    const visit=(node,allowed=null)=>{
      const direct=(buckets.get(node.id)||[]).filter(line=>!allowed||allowed.has(line));
      // Direct parent members are real spanning units; order them as separators
      // only inside their own subtree, never across an unrelated column.
      if(!node.children.length){for(const line of direct.sort((a,b)=>centerY(boxFor(a))-centerY(boxFor(b))||boxFor(a).x-boxFor(b).x))line.readingOrder=rank++;return;}
      if(!direct.length){for(const child of node.children)visit(child,allowed);return;}
      const descendants=[];
      const collect=current=>{descendants.push(...(buckets.get(current.id)||[]).filter(line=>!allowed||allowed.has(line)));for(const child of current.children)collect(child);};
      for(const child of node.children)collect(child);
      // Parent units normally live in explicit sequence leaves. This branch is
      // for a compound whose completed ink crosses a provisional gutter.
      let remaining=new Set(descendants);
      for(const line of direct.sort((a,b)=>centerY(boxFor(a))-centerY(boxFor(b)))){
        const before=new Set([...remaining].filter(other=>centerY(boxFor(other))<centerY(boxFor(line))));
        for(const child of node.children)visit(child,before);
        for(const other of before)remaining.delete(other);
        line.readingOrder=rank++;
      }
      for(const child of node.children)visit(child,remaining);
    };
    visit(root);return lines;
  }
  return {root,regionAt:lookup,assignOrder,permitsLocalConnection,regions:all};
}
