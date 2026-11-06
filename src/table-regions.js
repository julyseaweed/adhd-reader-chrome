// Table cells are selectable PDF content, but not stops in the prose reading
// path. Classify the two-dimensional cell layout before equation/column joins.
import { readingFrameRect } from './reading-lines.js';

const end = r => r.x + r.width;
const bottom = r => r.y + r.height;
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)] || 1;
const union = rs => {const x=Math.min(...rs.map(r=>r.x)),y=Math.min(...rs.map(r=>r.y));return {x,y,width:Math.max(...rs.map(end))-x,height:Math.max(...rs.map(bottom))-y};};
const overlap = (a,b) => Math.max(0,Math.min(end(a),end(b))-Math.max(a.x,b.x));
const contains = (outer,inner,t=0) => inner.x>=outer.x-t && end(inner)<=end(outer)+t && inner.y>=outer.y-t && bottom(inner)<=bottom(outer)+t;
const words = s => (s.match(/[\p{L}\p{N}]+/gu)||[]).length;
const prose = s => words(s)>=6 || (s.match(/\p{Lo}/gu)||[]).length>=16;
const caption = s => /^\s*(?:(?:table|tab\.?|表|表格)\s*[\p{N}IVX一二三四五六七八九十]+(?:\b|[.:：、\s])|(?:note|notes|source|sources|注|来源|資料來源)\s*[:：]|\([a-z]\)\s+\p{L})/iu.test(s);
const math = s => /[=∫∑∏√∇∂∈∉≈≡≤≥←→⇒∀∃\u0000-\u001f\u239b-\u23ad\uf8eb-\uf8fe]/u.test(s)
  || /\p{L}\s*\([^)]*\)/u.test(s) && !/\([^)]{3,}\)/u.test(s);
const numeric = s => /^[\s\d.,%+−\-±()/×eE]+$/u.test(s) && /\d/u.test(s);
const short = c => !prose(c.text) && c.box.width<=c.em*15 && c.text.length<=65;
const aligned = (a,b) => Math.min(Math.abs(a.box.x-b.box.x),Math.abs(end(a.box)-end(b.box)),Math.abs(a.box.x+a.box.width/2-b.box.x-b.box.width/2))<=Math.min(a.em,b.em)*.45;

function cellsForLines(lines, angle) {
  const cells=[];
  for(const line of lines) {
    if(Math.abs(Math.sin((line.angle||0)-angle))>.12)continue;
    let current;
    const flush=()=>{if(current){
      current.box=union(current.items.map(i=>readingFrameRect(i,angle)));
      current.text=current.items.reduce((text,item,index)=>{
        const previous=current.items[index-1],gap=previous?readingFrameRect(item,angle).x-end(readingFrameRect(previous,angle)):0;
        return text+(index&&gap>Math.min(previous.fontHeight,item.fontHeight)*.12&&!/\s$/u.test(text)&&!/^\s/u.test(item.str)?' ':'')+item.str;
      },'').trim();cells.push(current);current=null;
    }};
    for(const item of [...line.items].filter(i=>i.str?.trim()).sort((a,b)=>readingFrameRect(a,angle).x-readingFrameRect(b,angle).x)) {
      const box=readingFrameRect(item,angle),em=item.fontHeight||box.height;
      if(current && box.x-current.right>Math.min(current.em,em)*.8)flush();
      if(!current)current={items:[],em,right:-Infinity};
      current.items.push(item);current.em=Math.max(current.em,em);current.right=Math.max(current.right,end(box));
    }
    flush();
  }
  return cells;
}

function physicalRows(cells) {
  const rows=[];
  for(const cell of [...cells].sort((a,b)=>a.box.y+a.box.height/2-b.box.y-b.box.height/2||a.box.x-b.box.x)) {
    const center=cell.box.y+cell.box.height/2;
    let row=rows.find(r=>Math.abs(r.center-center)<=Math.min(r.em,cell.em)*.42);
    if(!row){row={cells:[],center,em:cell.em};rows.push(row);}
    row.cells.push(cell);row.em=Math.min(row.em,cell.em);
  }
  for(const row of rows){row.cells.sort((a,b)=>a.box.x-b.box.x);row.box=union(row.cells.map(c=>c.box));}
  return rows.sort((a,b)=>a.center-b.center);
}

function cellEvidence(cells,{ruled=false,captioned=false,grid=false}={}) {
  const rows=physicalRows(cells),multi=rows.filter(row=>row.cells.length>=2);
  if(multi.length<2)return null;
  const lengths=multi.map(r=>r.cells.length),columns=median(lengths);
  if(columns<2)return null;
  const selected=multi.flatMap(row=>row.cells),nonempty=selected.filter(c=>c.text);
  const definitions=columns===2 && (ruled||captioned) && multi.every(row=>short(row.cells[0])&&!math(row.cells[0].text));
  if(!definitions && nonempty.filter(c=>short(c)).length<nonempty.length*.72)return null;
  // Equations, cases and algorithm instructions use mathematical relationships,
  // not a header/value grid. Numeric tables can still contain signs and +/-.
  if(nonempty.filter(c=>math(c.text)).length>Math.max(1,nonempty.length*.18))return null;
  const textual=nonempty.filter(c=>/\p{L}/u.test(c.text)&&!numeric(c.text));
  if(textual.length<2&&!grid)return null; // A bare numeric matrix is not a data table.
  if(!ruled&&!captioned&&nonempty.filter(c=>numeric(c.text)).length<nonempty.length*.25){
    // Short text can also be verse or fragmented paragraph columns. An
    // uncaptioned text-only grid needs a distinct header tier, not just gaps.
    const bodyFonts=new Set(multi.slice(1).flatMap(row=>row.cells.flatMap(cell=>cell.items.map(item=>item.fontName))));
    const headers=multi[0].cells.filter(cell=>cell.items.some(item=>item.fontName&&!bodyFonts.has(item.fontName)));
    if(headers.length<2)return null;
  }
  const consistency=multi.slice(1).filter(row=>row.cells.filter(c=>multi.slice(0,-1).some(other=>other!==row&&other.cells.some(d=>aligned(c,d)))).length>=2).length;
  if(consistency<Math.max(1,(multi.length-1)*.6))return null;
  if(columns===2) {
    const first=multi.map(r=>r.cells[0].text),last=multi.map(r=>r.cells.at(-1).text);
    if(first.filter(s=>/^\s*(?:\d+[.:)]?|[•●▪–-])\s*$/u.test(s)).length>=first.length*.5)return null;
    // Contents pages and numbered lists have a trailing page-number track, not
    // independent data columns. Ruled tables have separate structural evidence.
    if(!ruled && !captioned && (last.filter(s=>/^\d{1,4}$/u.test(s)).length>=last.length*.65 || !last.some(numeric)))return null;
  }
  if(!ruled && multi.length<3)return null;
  return {rows,multi,columns,definitions,em:median(nonempty.map(c=>c.em))};
}

/** Detect table bodies; table titles, captions and notes remain prose. */
export function partitionTableContent({items,baselineLines,structures={},viewport}) {
  if(!items.length)return {items,excludedItems:[],regions:[]};
  const scale=Math.hypot(...(viewport.transform||[1,0]).slice(0,2))||1;
  const dominant=[...baselineLines].sort((a,b)=>b.items.reduce((n,i)=>n+(i.str?.length||0),0)-a.items.reduce((n,i)=>n+(i.str?.length||0),0))[0];
  const angle=dominant?.angle||0,c=Math.cos(angle),s=Math.sin(angle);
  const point=(x,y)=>[x*c+y*s,-x*s+y*c];
  const inverse=box=>{const points=[[box.x,box.y],[end(box),box.y],[end(box),bottom(box)],[box.x,bottom(box)]].map(([x,y])=>({x:x*c-y*s,y:x*s+y*c,width:0,height:0}));const r=union(points);return {...r,right:end(r),bottom:bottom(r)};};
  const cells=cellsForLines(baselineLines,angle),em=median(cells.map(cell=>cell.em));
  const independentNeighbor=cell=>cells.some(other=>other!==cell
    &&Math.abs(other.box.y+other.box.height/2-cell.box.y-cell.box.height/2)<Math.min(cell.em,other.em)*.42
    &&Math.max(other.box.x-end(cell.box),cell.box.x-end(other.box))>Math.min(cell.em,other.em)*2.2);
  // A label in an ordinary cell (for example "Source:") is still table data.
  // Captions/notes occupy a prose band rather than one slot in a multi-cell row.
  const protectedCells=cells.filter(cell=>caption(cell.text)
    &&(!independentNeighbor(cell)||cell.box.width>cell.em*10||prose(cell.text)));
  for(const seed of [...protectedCells]){
    let previous=seed;
    for(const next of cells.filter(cell=>cell.box.y>seed.box.y).sort((a,b)=>a.box.y-b.box.y)){
      if(next.box.y-bottom(previous.box)>previous.em*1.2)break;
      if(next.box.y<bottom(previous.box)-previous.em*.1||independentNeighbor(next)
        ||Math.abs(next.box.x-seed.box.x)>seed.em||!prose(next.text)
        ||Math.abs(next.em-seed.em)>seed.em*.15)continue;
      if(!protectedCells.includes(next))protectedCells.push(next);
      previous=next;
    }
  }
  const tableCaptionCells=protectedCells.filter(cell=>/^\s*(?:table|tab\.?|表|表格)\s*[\p{N}IVX一二三四五六七八九十]+/iu.test(cell.text));
  const nearTableCaption=box=>tableCaptionCells.some(cell=>overlap(box,cell.box)>Math.min(box.width,cell.box.width)*.5
    && Math.max(box.y-bottom(cell.box),cell.box.y-bottom(box),0)<cell.em*14);
  // Following prose stays outside table regions because candidates end at the
  // last rule/data row, not at the next title or neighboring column paragraph.
  const protectedIds=new Set(protectedCells.flatMap(cell=>cell.items.map(i=>i.index)));
  const edges=[];
  const add=(x1,y1,x2,y2)=>{
    const a=point(x1,y1),b=point(x2,y2),dx=Math.abs(b[0]-a[0]),dy=Math.abs(b[1]-a[1]);
    if(dx>em*3.5&&dy<Math.max(.5*scale,dx*.005))edges.push({axis:'h',x:Math.min(a[0],b[0]),y:(a[1]+b[1])/2,width:dx,height:0});
    else if(dy>em*2&&dx<Math.max(.5*scale,dy*.005))edges.push({axis:'v',x:(a[0]+b[0])/2,y:Math.min(a[1],b[1]),width:0,height:dy});
  };
  for(const r of structures.rules||[])add(r.x1,r.y1,r.x2,r.y2);
  for(const g of structures.graphics||[]) {
    if(!g.stroke&&!g.fill||g.whiteBackground)continue;
    for(const edge of g.segments||[])add(edge.x1,edge.y1,edge.x2,edge.y2);
    if(!(g.segments?.length)&&g.bounds){const b=readingFrameRect(g.bounds,angle);if(b.height<em*.2)add(g.bounds.x,g.bounds.y,g.bounds.x+g.bounds.width,g.bounds.y+g.bounds.height);}
  }
  const horizontal=[];
  for(const edge of edges.filter(e=>e.axis==='h').sort((a,b)=>a.y-b.y))if(!horizontal.some(h=>Math.abs(h.x-edge.x)<scale*.3&&Math.abs(h.y-edge.y)<scale*.3&&Math.abs(h.width-edge.width)<scale*.3))horizontal.push(edge);
  const groups=[];
  for(const edge of horizontal) {
    let group=groups.find(group=>Math.abs(group[0].x-edge.x)<em*.65&&Math.abs(end(group[0])-end(edge))<em*.65);
    if(!group)groups.push(group=[]);group.push(edge);
  }
  const candidates=[];
  const accept=(box,evidence,values)=>{
    const excluded=values.filter(cell=>!protectedIds.has(cell.items[0].index)&&contains(box,cell.box,cell.em*.18));
    if(!excluded.length)return;
    candidates.push({box,evidence,cells:excluded});
  };
  for(const group of groups) {
    let part=[];
    const flush=()=>{
      if(part.length>=2){const a=part[0],b=part.at(-1),box={x:Math.min(...part.map(r=>r.x)),y:a.y,width:Math.max(...part.map(end))-Math.min(...part.map(r=>r.x)),height:b.y-a.y};
        const own=cells.filter(cell=>contains(box,cell.box,cell.em*.18)&&!protectedIds.has(cell.items[0].index));
        const vertical=edges.filter(edge=>edge.axis==='v'&&edge.x>=box.x-em*.1&&edge.x<=end(box)+em*.1&&edge.y<=box.y+em*.2&&bottom(edge)>=bottom(box)-em*.2);
        const grid=part.length>=3&&new Set(vertical.map(edge=>Math.round(edge.x/scale*10))).size>=3;
        const evidence=cellEvidence(own,{ruled:true,grid});
        if(evidence && box.height>evidence.em*1.5)accept(box,'ruled-cell-grid',own);
      }part=[];
    };
    for(const edge of group.sort((a,b)=>a.y-b.y)) {
      const prior=part.at(-1);
      if(prior){const between={x:edge.x,y:prior.y,width:edge.width,height:edge.y-prior.y};
        if(protectedCells.some(cell=>cell.box.y>=between.y-em*.1&&bottom(cell.box)<=bottom(between)+em*.1
          &&overlap(between,cell.box)>=Math.min(between.width,cell.box.width)*.5)||edge.y-prior.y>em*18)flush();
      }
      part.push(edge);
    }
    flush();
  }
  // Text-only tables need repeated aligned short cells. A page's paragraph
  // columns contain long text runs and cannot establish this data-grid model.
  const occupied=new Set(candidates.flatMap(candidate=>candidate.cells.flatMap(cell=>cell.items.map(i=>i.index))));
  const free=cells.filter(cell=>!cell.items.some(i=>occupied.has(i.index))&&!protectedIds.has(cell.items[0].index));
  const rows=physicalRows(free),grids=[];
  for(const row of rows) {
    const establishedDefinition=grids.some(grid=>grid.at(-1).cells.length===2&&nearTableCaption(grid[0].box)
      &&row.cells.length===2&&row.cells.every((cell,index)=>aligned(cell,grid.at(-1).cells[index])));
    const values=(nearTableCaption(row.box)||establishedDefinition)&&row.cells.length===2&&short(row.cells[0])?row.cells:row.cells.filter(short);
    if(values.length<2||values.some(cell=>math(cell.text)))continue;
    const prior=grids.filter(grid=>row.center-grid.at(-1).center>0 && row.center-grid.at(-1).center<Math.min(row.em,grid.at(-1).em)*4.5
      && !protectedCells.some(cell=>cell.box.y>grid.at(-1).box.y&&bottom(cell.box)<row.box.y&&overlap(cell.box,row.box)>Math.min(cell.box.width,row.box.width)*.5)
      &&values.filter(cell=>grid.at(-1).cells.some(previous=>aligned(cell,previous))).length>=2)
      .sort((a,b)=>b.at(-1).center-a.at(-1).center)[0];
    if(prior)prior.push({...row,cells:values});else grids.push([{...row,cells:values}]);
  }
  for(const grid of grids) {
    const values=grid.flatMap(row=>row.cells),evidence=cellEvidence(values,{captioned:nearTableCaption(union(values.map(cell=>cell.box)))});
    if(!evidence)continue;
    let box=union(values.map(cell=>cell.box));
    // Tall delimiters adjoining a numeric grid belong to a matrix/cases unit.
    const enclosed=items.some(item=>{const b=readingFrameRect(item,angle);return b.height>evidence.em*1.6&&b.height>=box.height*.65
      &&b.y<bottom(box)&&bottom(b)>box.y&&Math.min(Math.abs(end(b)-box.x),Math.abs(b.x-end(box)))<evidence.em*1.4;});
    if(enclosed)continue;
    if(rows.some(row=>row.box.y>box.y&&bottom(row.box)<bottom(box)&&row.cells.some(cell=>prose(cell.text)&&overlap(cell.box,box)>box.width*.65
      &&!(evidence.definitions&&grid.some(source=>Math.abs(source.cells[1].box.x-cell.box.x)<evidence.em*.4)))))continue;
    // Wrapped definitions can continue below the final row's label. Continue
    // only within the existing value-column track and typography, never into
    // a full-width note or the following paragraph.
    const last=grid.at(-1),tracks=last.cells.slice(1);
    for(const row of rows.filter(row=>row.box.y>=bottom(box)-evidence.em*.2).sort((a,b)=>a.box.y-b.box.y)){
      if(row.box.y-bottom(box)>evidence.em*.9)break;
      if(row.cells.length!==1||!tracks.some(cell=>Math.abs(cell.box.x-row.cells[0].box.x)<evidence.em*.4&&Math.abs(cell.em-row.cells[0].em)<evidence.em*.1))continue;
      box=union([box,row.box]);
    }
    accept(box,'aligned-cell-grid',free.filter(cell=>contains(box,cell.box,cell.em*.18)));
  }
  // Bare panel letters immediately adjoining a confirmed table label its data
  // panels. Descriptive "(a) ..." prose remains protected above.
  for(const candidate of candidates){
    const labels=cells.filter(cell=>/^\([a-z]\)$/iu.test(cell.text)
      &&cell.box.y>=bottom(candidate.box)&&cell.box.y-bottom(candidate.box)<cell.em*1.5
      &&Math.abs(cell.box.x+cell.box.width/2-candidate.box.x-candidate.box.width/2)<Math.max(cell.em*2,candidate.box.width*.15)
      &&!independentNeighbor(cell));
    if(labels.length){candidate.cells.push(...labels);candidate.box=union([candidate.box,...labels.map(cell=>cell.box)]);}
  }
  const regions=[],excludedById=new Map();
  for(const candidate of candidates.sort((a,b)=>b.box.width*b.box.height-a.box.width*a.box.height)) {
    if(regions.some(region=>contains(region.frameBounds,candidate.box,em*.1)))continue;
    // The click exclusion must match cell ownership. An internal note can be
    // inside the outer drawn border; carve its complete prose band out rather
    // than retaining its text behind an unclickable table rectangle.
    let boxes=[candidate.box];
    for(const cell of protectedCells.filter(cell=>overlap(cell.box,candidate.box)>0
      &&cell.box.y<bottom(candidate.box)&&bottom(cell.box)>candidate.box.y)){
      const top=cell.box.y-cell.em*.15,endY=bottom(cell.box)+cell.em*.15;
      boxes=boxes.flatMap(box=>{
        if(top>=bottom(box)||endY<=box.y)return[box];
        return [{...box,height:Math.max(0,top-box.y)},
          {...box,y:Math.max(box.y,endY),height:Math.max(0,bottom(box)-Math.max(box.y,endY))}].filter(box=>box.height>0);
      });
    }
    for(const box of boxes){
      const own=candidate.cells.filter(cell=>contains(box,cell.box,cell.em*.1));
      if(!own.length)continue;
      const id=`table-${regions.length}`,region={...inverse(box),id,kind:'table',source:'table-layout',evidence:candidate.evidence,frameBounds:box,contentBounds:inverse(union(own.map(cell=>cell.box))),angle};
      regions.push(region);
      for(const cell of own)for(const item of cell.items)if(!protectedIds.has(item.index))excludedById.set(item.index,{item,regionId:id});
    }
  }
  return {items:items.filter(item=>!excludedById.has(item.index)),excludedItems:[...excludedById.values()],regions};
}
