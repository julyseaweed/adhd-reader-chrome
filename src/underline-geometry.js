import {underlineMetrics} from './annotation-style.js';

const median=(items,value)=>{
  const sorted=items.map(item=>({value:value(item),weight:Math.max(.01,item.right-item.left)})).sort((a,b)=>a.value-b.value);
  const half=sorted.reduce((sum,item)=>sum+item.weight,0)/2;
  let total=0;for(const item of sorted){total+=item.weight;if(total>=half)return item.value}
};
const cardinal=angle=>{
  const quarter=Math.round(angle/(Math.PI/2));
  return Math.abs(angle-quarter*Math.PI/2)<.025?((quarter%4)+4)%4:null;
};
function frame(rect,quarter){
  const {x,y,width:w,height:h}=rect;
  if(quarter===1)return {x:y,y:-x-w,width:h,height:w};
  if(quarter===2)return {x:-x-w,y:-y-h,width:w,height:h};
  if(quarter===3)return {x:-y-h,y:x,width:h,height:w};
  return {...rect};
}
const unframe=(rect,quarter)=>frame(rect,(4-quarter)%4);

/** All selectable text participates, including figures and tables. Navigation
 * units intentionally do not define annotation rows: formulas may span several
 * baselines, and a selected word must not change its row's baseline or size. */
export function createUnderlineModel(items,scale=1){
  const seen=new Set(),entries=[];
  for(const item of items){
    if(seen.has(item.index))continue;seen.add(item.index);
    const quarter=cardinal(item.angle||0);
    if(quarter===null||!(item.fontHeight>0))continue;
    const box=frame(item,quarter),baseline=frame({x:item.baselineX,y:item.baselineY,width:0,height:0},quarter).y;
    if(!Number.isFinite(baseline))continue;
    entries.push({item,quarter,baseline,em:item.fontHeight,left:box.x,right:box.x+box.width,bottom:box.y+box.height});
  }
  const bands=[];
  // Main-size text owns the row before smaller raised/lowered scripts join it.
  for(const entry of entries.sort((a,b)=>b.em-a.em||a.baseline-b.baseline||a.left-b.left)){
    let best=null,score=Infinity;
    for(const band of bands){
      if(band.quarter!==entry.quarter)continue;
      const distance=Math.abs(entry.baseline-band.baseline),script=entry.em<band.em*.95;
      if(script&&entry.em<band.em*.4)continue;
      if(distance>band.em*(script?.6:.14))continue;
      if(script&&Math.max(band.left-entry.right,entry.left-band.right)>band.em*2.2)continue;
      if(distance<score){best=band;score=distance}
    }
    if(best){best.entries.push(entry);best.left=Math.min(best.left,entry.left);best.right=Math.max(best.right,entry.right)}
    else bands.push({...entry,entries:[entry]});
  }
  const rows=[],byItem=new Map();
  for(const band of bands){
    const segments=[];
    for(const entry of band.entries.sort((a,b)=>a.left-b.left)){
      const tail=segments.at(-1);
      if(tail&&entry.left-tail.right<=Math.max(18*scale,band.em*2.2)){tail.entries.push(entry);tail.right=Math.max(tail.right,entry.right)}
      else segments.push({entries:[entry],right:entry.right});
    }
    for(const segment of segments){
      const em=median(segment.entries,entry=>entry.em);
      const main=segment.entries.filter(entry=>entry.em>=em*.8);
      const baseline=median(main,entry=>entry.baseline);
      const thickness=underlineMetrics(em/scale).thickness*scale;
      const offset=Math.max(em*.28,...segment.entries.map(entry=>entry.bottom-baseline+em*.04+thickness/2));
      const row={quarter:band.quarter,baseline,em,offset,left:Math.min(...segment.entries.map(entry=>entry.left)),right:segment.right,
        top:Math.min(...segment.entries.map(entry=>frame(entry.item,band.quarter).y)),bottom:Math.max(...segment.entries.map(entry=>entry.bottom))};
      rows.push(row);for(const entry of segment.entries)byItem.set(entry.item.textDivIndex,row);
    }
  }
  return {rows,byItem,scale};
}

function rowRects(selected,model){
  const result=[];
  for(const [row,fragments] of selected){
    const intervals=fragments.map(rect=>frame(rect,row.quarter)).sort((a,b)=>a.x-b.x),runs=[];
    for(const rect of intervals){
      const tail=runs.at(-1);
      if(tail&&rect.x-tail.right<=row.em*1.25){tail.right=Math.max(tail.right,rect.x+rect.width)}
      else runs.push({left:rect.x,right:rect.x+rect.width});
    }
    const inset=underlineMetrics(row.em/model.scale).inset*model.scale;
    for(const run of runs)result.push({quarter:row.quarter,rect:unframe({x:run.left,y:row.baseline+row.offset+inset-row.em,width:run.right-run.left,height:row.em},row.quarter)});
  }
  return result;
}

/** DOM ranges supply only selected endpoints. Their font-box Y coordinates
 * cannot affect either the baseline, the clearance, or the stroke thickness. */
export function underlineSelection(fragments,model){
  const selected=new Map(),unmatched=[];
  for(const fragment of fragments){
    const row=model.byItem.get(fragment.textDivIndex);if(!row){if(fragment.selectedText?.trim()!=='')unmatched.push(fragment);continue}
    if(!selected.has(row))selected.set(row,[]);selected.get(row).push(fragment);
  }
  return {resolved:rowRects(selected,model),unmatched};
}

/** Old drafts contain boxes only. Repair a box only when one physical PDF row
 * clearly owns it; ambiguous/no-text boxes keep their original coordinates. */
export function repairUnderlineRects(rects,model){
  const selected=new Map(),unmatched=[];
  for(const rect of rects){
    const candidates=[];
    for(const row of model.rows){
      const box=frame(rect,row.quarter),horizontal=Math.min(box.x+box.width,row.right)-Math.max(box.x,row.left);
      const vertical=Math.min(box.y+box.height,row.bottom)-Math.max(box.y,row.top);
      if(horizontal<=0||vertical<=Math.min(box.height,row.bottom-row.top)*.3)continue;
      const distance=Math.abs(box.y+box.height/2-(row.top+row.bottom)/2)/row.em;
      candidates.push({row,score:distance});
    }
    candidates.sort((a,b)=>a.score-b.score);
    if(!candidates.length||candidates[1]&&candidates[1].score-candidates[0].score<.2){unmatched.push(rect);continue}
    const row=candidates[0].row;if(!selected.has(row))selected.set(row,[]);selected.get(row).push(rect);
  }
  return {resolved:rowRects(selected,model),unmatched};
}
