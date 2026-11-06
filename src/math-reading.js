import { mergeItems, readingFrameRect, attachScriptFragments } from './reading-lines.js';
import { rowMarkerLinks } from './row-markers.js';
import { physicalRowGroups } from './physical-row-layout.js';
import { partitionFigureContent } from './figure-regions.js';
import { partitionTableContent } from './table-regions.js';
import { createReadingRegions } from './column-regions.js';

const right = box => box.x + box.width;
const bottom = box => box.y + box.height;
const midpoint = box => [box.x + box.width / 2, box.y + box.height / 2];
const overlap = (a, b) => Math.min(right(a), right(b)) - Math.max(a.x, b.x);
const intervalGap = (a, b) => Math.max(a.x - right(b), b.x - right(a), 0);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 1;
const prose = text => (text.match(/\p{L}{3,}/gu) || []).length >= 3;
// Uncased scripts (including CJK, Thai and Arabic) need no spaces to establish
// a text flow. Keep this separate from the math/prose classifier above.
function textFlowEvidence(line) {
  const unspaced=(line.text.match(/\p{Lo}/gu)||[]).length;
  if(unspaced>=8)return 3;
  // PDF text items may be whole paragraphs, individual words or glyphs. Form
  // continuous typographic runs first; concatenating all mathematical fonts
  // and raised identifiers can manufacture apparent words such as pdata/Xtdt.
  const runs=[];
  for(const item of [...line.items].sort((a,b)=>a.along-b.along)){
    const box=readingFrameRect(item,line.angle||0);
    const run=runs.find(run=>run.font===item.fontName && Math.abs(run.baseline-item.baselineOffset)<item.fontHeight*.15
      &&Math.abs(run.em-item.fontHeight)<item.fontHeight*.05 && box.x-run.end>=-item.fontHeight*.15 && box.x-run.end<item.fontHeight*.75);
    if(run){run.text+=(box.x-run.end>item.fontHeight*.12?' ':'')+item.str;run.end=right(box);}
    else runs.push({font:item.fontName,baseline:item.baselineOffset,em:item.fontHeight,end:right(box),text:item.str});
  }
  return Math.max(unspaced>=4?2:0,...runs.map(run=>(run.text.match(/\p{L}{3,}/gu)||[]).length));
}
const textFlow=line=>textFlowEvidence(line)>=3;
const tag = text => /^\s*(?:[([{][\p{L}\p{N}.–−-]{1,12}[)\]}]|\d{1,4}[a-z]?)\s*$/u.test(text);
const mathematical = text => /[\p{Sm}]/u.test(text) && !prose(text);
function delimiterKind(value) {
  if (/^[([{⟨⌈⌊⎛⎜⎝⎡⎢⎣⎧⎪⎩]$/u.test(value)) return { open: true, close: false, brace: /[{⎧⎪⎩]/u.test(value) };
  if (/^[)\]}⟩⌉⌋⎞⎟⎠⎤⎥⎦⎫⎭]$/u.test(value)) return { open: false, close: true };
  if (/^[\u0000-\u001f]+\p{L}?$/u.test(value) || /^[\u0000-\u001f\s]+$/u.test(value) && /[\u0000-\u001f]/u.test(value)) return { open: true, close: true };
  // Extensible symbol fonts often map tall brackets to punctuation slots.
  // The caller additionally requires tall ink and a matching opposite edge.
  if (/^[!"#$%&'*,.:;?@\\^_`~]$/u.test(value)) return { open: true, close: true };
  return null;
}
const union = boxes => {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y };
};
function weightedMedian(items, value) {
  const sorted = items.map(item => ({ value: value(item), weight: Math.max(.01,
    Math.abs(Math.cos(item.angle || 0)) * item.width + Math.abs(Math.sin(item.angle || 0)) * item.height) })).sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2;
  let total = 0;
  for (const item of sorted) { total += item.weight; if (total >= half) return item.value; }
  return sorted.at(-1)?.value || 0;
}

/** Build physical reading units from text runs AND the page's drawn structure.
 * Coordinates and primitive identities are kept intact. Components are JSON
 * records, so callers can independently audit every grouping decision.
 */
export function buildReadingUnits({ items, baselineLines, structures = {}, viewport }) {
  const figures=partitionFigureContent({items,baselineLines,structures,viewport});
  const figureIds=new Set(figures.excludedItems.map(({item})=>item.index));
  const figureFreeLines=baselineLines.flatMap(line=>{const kept=line.items.filter(item=>!figureIds.has(item.index));return kept.length?[kept.length===line.items.length?line:mergeItems(kept)]:[];});
  const tables=partitionTableContent({items:figures.items,baselineLines:figureFreeLines,structures,viewport});
  const excludedRegions=[...figures.regions,...tables.regions];
  const excluded=new Set([...figures.excludedItems,...tables.excludedItems].map(({item})=>item.index));
  const bodyLines=baselineLines.flatMap(line=>{
    const kept=line.items.filter(item=>!excluded.has(item.index));
    return kept.length ? [kept.length===line.items.length?line:mergeItems(kept)] : [];
  });
  const bodyStructures={...structures,rules:(structures.rules||[]).filter(rule=>!excludedRegions.some(r=>
    rule.x1>=r.x&&rule.x1<=r.right&&rule.x2>=r.x&&rule.x2<=r.right
    &&rule.y1>=r.y&&rule.y1<=r.bottom&&rule.y2>=r.y&&rule.y2<=r.bottom))};
  const body=buildTextReadingUnits({items:tables.items,baselineLines:bodyLines,structures:bodyStructures,viewport,tableRegions:tables.regions});
  const excludedUnits=figures.excludedItems.map(({item,regionId})=>({...mergeItems([item]),
    readingRole:'figure',exclusionReason:'figure-interior',figureRegionId:regionId}));
  excludedUnits.push(...tables.excludedItems.map(({item,regionId})=>({...mergeItems([item]),
    readingRole:'table',exclusionReason:'table-interior',tableRegionId:regionId})));
  return {...body,excludedUnits,figureRegions:figures.regions,tableRegions:tables.regions,excludedRegions};
}

function buildTextReadingUnits({ items, baselineLines, structures = {}, viewport, tableRegions=[] }) {
  for(const region of tableRegions)region.readingNeighbors={previous:null,next:null};
  if (!items.length) return { units: [], rawLines: baselineLines, components: [], regions: [] };
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const dominant = baselineLines.reduce((best, line) => line.items.length > best.items.length ? line : best, baselineLines[0]);
  const angle = dominant.angle || 0, cos = Math.cos(angle), sin = Math.sin(angle);
  const projectPoint = (x, y) => [cos * x + sin * y, -sin * x + cos * y];
  const frame = value => readingFrameRect(value, angle);
  const em = median(items.map(item => item.fontHeight));
  const nodes = items.map(item => ({ item, box: frame(item), baseline: projectPoint(item.baselineX, item.baselineY)[1] }));
  const displacedLetter = node => /^\p{L}$/u.test(node.item.str) && node.box.y >= node.baseline-node.item.fontHeight*.15
    && node.box.height>node.item.fontHeight*.9 && node.box.width<em*1.6;
  const structuralGlyphs = new Set(nodes.flatMap((node, index) => {
    const value = node.item.str;
    return (delimiterKind(value) && (node.box.height > node.item.fontHeight * 1.1 || /[\u239b-\u23ad\uf8eb-\uf8fe]/u.test(value)))
      || displacedLetter(node) ? [index] : [];
  }));
  const byIndex = new Map(nodes.map((node, index) => [node.item.index, index]));
  const parents = nodes.map((_, index) => index);
  const find = index => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const join = members => { if (members.length) { const first = find(members[0]); for (const member of members) parents[find(member)] = first; } };
  // A narrow gutter can be smaller than the text extractor's word-joining
  // threshold. Keep two complete natural-language runs as provisional pieces;
  // the final region model will reunite them unless repeated column evidence
  // confirms that the gap separates independent text flows.
  const continuousFlowAnchors=[];
  const provisionalLines=baselineLines.flatMap(source=>{
    const chunks=[];let chunk=[],end=-Infinity;
    for(const item of [...source.items].sort((a,b)=>a.along-b.along)){
      const box=readingFrameRect(item,source.angle||0);
      if(chunk.length&&box.x-end>item.fontHeight*.75){chunks.push(mergeItems(chunk));chunk=[];}
      chunk.push(item);end=Math.max(end,right(box));
    }
    if(chunk.length)chunks.push(mergeItems(chunk));
    // Unspaced scripts can reach paragraph evidence across two adjacent runs
    // even though neither fragment alone contains a complete phrase. Keep that
    // continuous run as layout evidence, without committing its item ownership.
    if(chunks.length>1&&!chunks.some(textFlow)&&textFlowEvidence(source)>=2){
      const boxes=chunks.map(line=>frame(line));
      if(boxes.every((box,index)=>!index||box.x-right(boxes[index-1])<=source.fontHeight*2.2))continuousFlowAnchors.push(source);
    }
    return chunks;
  });
  // Extensible delimiters carry artificial font baselines. They must not bind
  // neighboring rows before their actual two-dimensional structure is known.
  const lineData = provisionalLines.flatMap(source => {
    const retained = source.items.filter(item => !structuralGlyphs.has(byIndex.get(item.index)));
    if (!retained.length) return [];
    const line = mergeItems(retained);
    const localEm=Math.max(...line.items.map(item=>item.fontHeight));
    const baseItems=line.items.filter(item=>item.fontHeight>=localEm*.86);
    const flowEvidence=textFlowEvidence(line);
    return [{ line, box: frame(line), flow:flowEvidence>=3, flowEvidence, members: line.items.map(item => byIndex.get(item.index)),
    baseline: weightedMedian(baseItems, item => projectPoint(item.baselineX, item.baselineY)[1]), em:localEm }];
  });
  // A paragraph remains a text flow when its next line is short or contains
  // inline math. Extend strong prose evidence only through aligned, same-size
  // neighboring lines, rather than requiring three plain words on every row.
  let continued=true;
  while(continued){
    continued=false;
    for(const row of lineData){
      if(row.flow||row.flowEvidence<2)continue;
      if(lineData.some(other=>other.flow && Math.abs(row.em-other.em)<row.em*.1
        &&Math.abs(row.box.x-other.box.x)<row.em*.5
        &&Math.abs(row.baseline-other.baseline)>row.em*.8
        &&Math.abs(row.baseline-other.baseline)<row.em*1.8)){
        row.flow=true;continued=true;
      }
    }
  }
  for (const line of lineData) join(line.members);
  for (const { markerIndex, hostIndex } of rowMarkerLinks(baselineLines)) {
    join([...baselineLines[markerIndex].items, ...baselineLines[hostIndex].items].map(item => byIndex.get(item.index)));
  }
  const ruleData = (structures.rules || []).map(rule => {
    const a = projectPoint(rule.x1, rule.y1), b = projectPoint(rule.x2, rule.y2);
    return { ...rule, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
      width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]),
      viewportBounds: { x: Math.min(rule.x1, rule.x2) - rule.thickness / 2, y: Math.min(rule.y1, rule.y2) - rule.thickness / 2,
        width: Math.abs(rule.x1 - rule.x2) + rule.thickness, height: Math.abs(rule.y1 - rule.y2) + rule.thickness } };
  });
  const horizontal = ruleData.filter(rule => rule.width > rule.height * 20 && rule.thickness <= em * .18);
  const vertical = ruleData.filter(rule => rule.height > rule.width * 20 && rule.thickness <= em * .18);
  vertical.sort((a,b)=>Math.round(a.x/em*1000)-Math.round(b.x/em*1000)||a.y-b.y);
  for(let index=0;index<vertical.length;index++)for(let next=index+1;next<vertical.length;next++){
    const a=vertical[index],b=vertical[next];
    if(Math.abs(a.x-b.x)>em*.05||b.y>bottom(a)+em*.15||b.y<a.y)continue;
    a.parts=[...(a.parts||[a.id]),...(b.parts||[b.id])];
    a.viewportBounds=union([a.viewportBounds,b.viewportBounds]);a.height=Math.max(bottom(a),bottom(b))-a.y;
    vertical.splice(next--,1);
  }
  const pageBox = frame({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  const textBox = union(nodes.map(node => node.box));
  const anchorData=continuousFlowAnchors.map(line=>({line,box:frame(line),flow:textFlow(line),em:line.fontHeight,
    baseline:weightedMedian(line.items,item=>projectPoint(item.baselineX,item.baselineY)[1])}));
  // Inline symbols can split the plain-font words in a caption. Its complete
  // typographic row inherits an established paragraph's alignment and measure;
  // a row extending into the adjacent column cannot inherit that paragraph.
  let anchorsChanged=true;
  while(anchorsChanged){anchorsChanged=false;
    for(const row of anchorData)if(!row.flow&&[...lineData,...anchorData].some(other=>other.flow
      &&Math.abs(row.em-other.em)<row.em*.1&&Math.abs(row.box.x-other.box.x)<row.em*.5
      &&row.box.width<=other.box.width+row.em*.75
      &&Math.abs(row.baseline-other.baseline)>row.em*.8&&Math.abs(row.baseline-other.baseline)<row.em*1.8)){
      row.flow=true;anchorsChanged=true;
    }
  }
  const regionLayout=createReadingRegions([...lineData,...anchorData.filter(row=>row.flow)],{bounds:{x:textBox.x,y:pageBox.y,width:textBox.width,height:pageBox.height},em,scale});
  const regionAt=regionLayout.regionAt;
  const inRegion = (box, region) => midpoint(box)[0] >= region.x - em * .2 && midpoint(box)[0] <= right(region) + em * .2;
  const components = [];
  function component(type, members, rules = [], extra = {}) {
    members = [...new Set(members)];
    if (!members.length) return null;
    join(members);
    const bounds = union([...members.map(index => nodes[index].item), ...rules.map(rule => rule.viewportBounds)]);
    const result = { id: `math-${components.length}`, type, itemIndices: members.map(index => nodes[index].item.index),
      ruleIds: rules.flatMap(rule => rule.parts||[rule.id]), bounds, ...extra };
    components.push(result); return result;
  }
  function hostRows(members, box, targetBaseline, localEm, evidence) {
    const region = regionAt(box), roots = new Set(members.map(find));
    const reach = evidence.type === 'relation-label' ? 3 : 2.2;
    const openRelation = lineData.filter(row=>!row.members.some(member=>roots.has(find(member))) && inRegion(row.box,region)
      && /[=←→↦≈∼]\s*$/u.test(row.line.text) && right(row.box)<=box.x
      && Math.abs(row.baseline-targetBaseline)<=localEm*.6)
      .sort((a,b)=>right(b.box)-right(a.box))[0];
    const choices = lineData.filter(row => !row.members.some(member => roots.has(find(member))) && !tag(row.line.text)
      && inRegion(row.box, region) && Math.abs(row.baseline - targetBaseline) <= localEm * .6
      && (intervalGap(row.box, box) <= localEm * reach || row===openRelation));
    choices.sort((a, b) => Math.abs(a.baseline - targetBaseline) - Math.abs(b.baseline - targetBaseline)
      || b.box.width - a.box.width);
    const primary = choices[0];
    if (!primary) return;
    const candidates = lineData.filter(row => !tag(row.line.text) && inRegion(row.box, region)
      && Math.abs(row.baseline - primary.baseline) <= Math.min(row.em, primary.em) * .3);
    const band = [primary]; let reached = union([box, primary.box]), changed = true;
    while (changed) {
      changed = false;
      for (const row of candidates) if (!band.includes(row) && intervalGap(row.box, reached) <= Math.min(localEm, row.em) * reach) {
        band.push(row); reached = union([reached, row.box]); changed = true;
      }
    }
    // A displayed relation can deliberately leave a wide math spacing before
    // a fraction or matrix. Its unfinished left side connects to the nearest
    // structural expression in the same column; unrelated rows do not bridge.
    if(openRelation && !band.includes(openRelation))band.push(openRelation);
    join([...members, ...band.flatMap(row => row.members)]);
    evidence.anchorBaseline = primary.baseline;
    evidence.anchorItemIndex = primary.line.items.reduce((best, item) =>
      Math.abs(projectPoint(item.baselineX, item.baselineY)[1] - primary.baseline) < Math.abs(projectPoint(best.baselineX, best.baselineY)[1] - primary.baseline) ? item : best,
    primary.line.items[0]).index;
  }

  // A compact labelled matrix may be drawn as crossing row/column rules rather
  // than brackets. Both arms must cross inside the grid, not form a table edge.
  for(const across of horizontal)for(const down of vertical){
    if(across.width>em*12||down.height>em*8||across.width<em*2||down.height<em*2
      ||down.x-across.x<em*.7||right(across)-down.x<em*.7
      ||across.y-down.y<em*.7||bottom(down)-across.y<em*.7)continue;
    const box=union([across,down]);
    const members=nodes.flatMap((node,index)=>node.box.x>=box.x-em*.2&&right(node.box)<=right(box)+em*.2
      &&node.box.y>=box.y-em*.2&&bottom(node.box)<=bottom(box)+em*.2&&!prose(node.item.str)?[index]:[]);
    if(members.length<6)continue;
    const part=component('matrix-grid',members,[across,down]);
    hostRows(members,box,midpoint(box)[1]+em*.25,em,part);
  }

  // A bar is a fraction only when it tightly separates two locally aligned
  // tiers. Page rules, underlines and table dividers do not establish that relation.
  const fractionRules = new Set();
  for (const rule of [...horizontal].sort((a, b) => a.width - b.width)) {
    const candidates = nodes.map((node, index) => ({ ...node, index })).filter(node => {
      const tolerance = node.item.fontHeight * .3;
      return node.box.x >= rule.x - tolerance && right(node.box) <= right(rule) + tolerance
        && overlap(node.box, rule) > Math.min(node.box.width, rule.width) * .35
        && Math.abs(node.baseline - rule.y) < node.item.fontHeight * 1.7;
    });
    const above = candidates.filter(node => node.baseline < rule.y - node.item.fontHeight * .12
      && bottom(node.box) <= rule.y + node.item.fontHeight * .12);
    const below = candidates.filter(node => node.baseline > rule.y + node.item.fontHeight * .25
      && node.box.y >= rule.y - node.item.fontHeight * .15);
    if (!above.length || !below.length) continue;
    const upperBase = Math.max(...above.map(node => node.baseline)), lowerBase = Math.min(...below.map(node => node.baseline));
    const upper = above.filter(node => upperBase - node.baseline < node.item.fontHeight * .3);
    const lower = below.filter(node => node.baseline - lowerBase < node.item.fontHeight * .3);
    if (prose(upper.map(node => node.item.str).join(' ')) || prose(lower.map(node => node.item.str).join(' '))) continue;
    const localEm = median([...upper, ...lower].map(node => node.item.fontHeight));
    // A rule may overlap only an inline symbol in a complete prose caption.
    // That clipped fragment cannot turn the whole caption into a denominator.
    // Small inline fractions can already share a provisional row with prose;
    // their raised/lowered tier baseline is distinct from that prose baseline.
    if(lineData.some(row=>row.flow&&[...upper,...lower].some(node=>row.members.includes(node.index)
      &&Math.abs(row.baseline-node.baseline)<node.item.fontHeight*.3)))continue;
    const ruleCenter=rule.x+rule.width/2;
    const tiers=[upper,lower].map(tier=>union(tier.map(node=>node.box)));
    if(tiers.some(box=>Math.abs(midpoint(box)[0]-ruleCenter)>Math.max(localEm*.6,rule.width*.1)))continue;
    const tierWidth = Math.max(union(upper.map(node => node.box)).width, union(lower.map(node => node.box)).width);
    if (rule.width - tierWidth > localEm * 2.4) continue;
    if (vertical.some(border => Math.abs(border.x - rule.x) < localEm * .2 || Math.abs(border.x - right(rule)) < localEm * .2)) continue;
    const members = [...upper, ...lower].map(node => node.index);
    const part = component('fraction', members, [rule]);
    fractionRules.add(rule.id);
    hostRows(members, rule, rule.y + localEm * .25, localEm, part);
  }

  // Radicals can have incomplete/misleading Unicode. A narrow glyph connected
  // to an overbar, enclosing text below it, is stronger evidence than its name.
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], box = node.box, known = /^[√∛∜]$/u.test(node.item.str.trim());
    if (!known && ([...node.item.str.trim()].length !== 1 || box.width > node.item.fontHeight * 1.4
      || box.height < node.item.fontHeight * .65 || delimiterKind(node.item.str))) continue;
    const bars = horizontal.filter(rule => !fractionRules.has(rule.id)
      && Math.abs(rule.x - right(box)) <= node.item.fontHeight * .4
      && Math.abs(rule.y - box.y) <= node.item.fontHeight * .4);
    for (const bar of bars) {
      const members = nodes.map((other, member) => ({ ...other, member })).filter(other => other.member !== index
        && overlap(other.box, bar) > Math.min(other.box.width, bar.width) * .2
        && other.box.y >= bar.y - em * .2 && midpoint(other.box)[1] <= Math.max(bottom(box), bar.y + em * 2.5)
        && other.box.width <= bar.width + em).map(other => other.member);
      if (!members.length) continue;
      const part = component('radical', [index, ...members], [bar]);
      const core = frame(part.bounds);
      hostRows([index, ...members], core, midpoint(core)[1] + em * .25, em, part);
    }
    if (known && !bars.length) {
      const next = nodes.map((other, member) => ({ ...other, member })).filter(other => other.member !== index
        && other.box.x >= right(box) - em * .2 && other.box.x - right(box) < em * .7
        && Math.min(bottom(box), bottom(other.box)) - Math.max(box.y, other.box.y) > Math.min(box.height, other.box.height) * .25)
        .sort((a, b) => a.box.x - b.box.x)[0];
      if (next) component('radical', [index, next.member]);
    }
  }

  const delimiters = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], kind = delimiterKind(node.item.str) || (displacedLetter(node)?{open:true,close:true}:null);
    if (!kind || !structuralGlyphs.has(index) || node.box.width > em * 1.5) continue;
    delimiters.push({ box: node.box, members: [index], rules: [], ...kind, font: node.item.fontName });
  }
  // TeX brackets/braces are stacks of top, extender, middle and bottom glyphs.
  // Join only touching ink in the same vertical track, never nearby baselines.
  delimiters.sort((a, b) => a.box.y - b.box.y);
  for (let index = 0; index < delimiters.length; index++) {
    const current = delimiters[index];
    for (let next = index + 1; next < delimiters.length; next++) {
      const other = delimiters[next];
      if (current.font !== other.font || current.open !== other.open || current.close !== other.close
        || Math.abs(current.box.x - other.box.x) > em * .12
        || Math.abs(current.box.width - other.box.width) > em * .15
        || other.box.y > bottom(current.box) + em * .12 || other.box.y < current.box.y) continue;
      current.box = union([current.box, other.box]); current.members.push(...other.members);
      current.brace ||= other.brace;
      delimiters.splice(next--, 1);
    }
  }
  for (let index = delimiters.length - 1; index >= 0; index--) if (delimiters[index].box.height < em * 1.4) delimiters.splice(index, 1);
  for (const stroke of vertical) {
    if (stroke.height < em * 1.4) continue;
    const arms = horizontal.filter(rule => rule.width <= em && Math.min(Math.abs(rule.y - stroke.y), Math.abs(rule.y - bottom(stroke))) < em * .2
      && Math.min(Math.abs(rule.x - stroke.x), Math.abs(right(rule) - stroke.x)) < em * .2);
    if (arms.length < 2) continue;
    const open = arms.every(arm => right(arm) > stroke.x + em * .2);
    const close = arms.every(arm => arm.x < stroke.x - em * .2);
    if (open || close) delimiters.push({ box: stroke, members: [], rules: [stroke, ...arms], open, close });
  }
  const usedDelimiters = new Set();
  for (const left of delimiters.filter(delimiter => delimiter.open).sort((a, b) => a.box.x - b.box.x)) {
    if (usedDelimiters.has(left)) continue;
    const region = regionAt(left.box);
    const choices = delimiters.filter(other => other !== left && other.close && !usedDelimiters.has(other)
      && other.box.x > right(left.box) && inRegion(other.box, region)
      && Math.min(left.box.height,other.box.height)>Math.max(left.box.height,other.box.height)*.9
      && !(left.members.length===1&&other.members.length===1&&left.open&&left.close&&other.open&&other.close
        &&nodes[left.members[0]].item.str===nodes[other.members[0]].item.str)
      && Boolean(left.members.length===1&&displacedLetter(nodes[left.members[0]]))===Boolean(other.members.length===1&&displacedLetter(nodes[other.members[0]]))
      && !(left.members.length===1&&other.members.length===1&&displacedLetter(nodes[left.members[0]])
        &&displacedLetter(nodes[other.members[0]])&&nodes[left.members[0]].item.str===nodes[other.members[0]].item.str)
      && Math.abs(left.box.y - other.box.y) < em * .3 && Math.abs(bottom(left.box) - bottom(other.box)) < em * .3)
      .sort((a, b) => a.box.x - b.box.x);
    for (const candidate of choices) {
      const box = union([left.box, candidate.box]);
      const members = nodes.map((node, index) => ({ ...node, index })).filter(node => node.box.x >= left.box.x - em * .2
        && right(node.box) <= right(candidate.box) + em * .2 && node.box.y >= box.y - em * .2
        && bottom(node.box) <= bottom(box) + em * .2).map(node => node.index);
      if (members.length < 2) continue;
      const part = component('enclosure', [...members, ...left.members, ...candidate.members], [...left.rules, ...candidate.rules]);
      hostRows(members, box, midpoint(box)[1] + em * .25, em, part);
      usedDelimiters.add(left); usedDelimiters.add(candidate); break;
    }
  }
  for (const left of delimiters.filter(delimiter => delimiter.open && delimiter.brace && !usedDelimiters.has(delimiter))) {
    const region = regionAt(left.box);
    const content = nodes.map((node,index)=>({...node,index})).filter(node => node.box.x >= right(left.box) - em * .25
      && inRegion(node.box, region) && node.box.y >= left.box.y - em * .2 && bottom(node.box) <= bottom(left.box) + em * .2);
    const baselines = content.filter(node=>node.item.fontHeight>=em*.86).map(node=>node.baseline);
    if (baselines.length < 2 || Math.max(...baselines)-Math.min(...baselines)<em) continue;
    const members = [...left.members, ...content.map(node=>node.index)];
    const part = component('cases', members, left.rules);
    hostRows(members, left.box, midpoint(left.box)[1] + em * .25, em, part);
  }

  // Some PDF ToUnicode maps encode an opening bracket as whitespace, so the
  // text extractor omits it entirely. A remaining tall closing edge plus two
  // vertically aligned rows still defines a matrix's physical enclosure.
  for(const edge of delimiters.filter(delimiter=>delimiter.close&&!usedDelimiters.has(delimiter)
    &&!delimiter.members.some(index=>displacedLetter(nodes[index])))){
    const region=regionAt(edge.box);
    const candidates=nodes.map((node,index)=>({...node,index})).filter(node=>!structuralGlyphs.has(node.index)
      &&right(node.box)<=edge.box.x+em*.2&&inRegion(node.box,region)
      &&node.box.y>=edge.box.y-em*.2&&bottom(node.box)<=bottom(edge.box)+em*.2);
    const aligned=candidates.filter(node=>candidates.some(other=>other.index!==node.index
      &&Math.abs(other.box.x-node.box.x)<em*.7&&Math.abs(other.baseline-node.baseline)>em*.65));
    if(aligned.length<4)continue;
    const minX=Math.min(...aligned.map(node=>node.box.x));
    const enclosed=candidates.filter(node=>node.box.x>=minX-em*.2);
    if(enclosed.some(node=>prose(node.item.str)))continue;
    const members=[...edge.members,...enclosed.map(node=>node.index)];
    const part=component('enclosure',members,edge.rules);
    hostRows(members,union([edge.box,...enclosed.map(node=>node.box)]),midpoint(edge.box)[1]+em*.25,em,part);
    usedDelimiters.add(edge);
  }

  // An extensible horizontal brace is two rules joined through three short
  // curved glyph pieces. Its small caption belongs to the expression above.
  const shallow = nodes.map((node, index) => ({ ...node, index })).filter(node => node.box.height < node.item.fontHeight * .55
    && node.box.width < node.item.fontHeight * 1.3 && node.item.str.trim());
  const braceRules = horizontal.filter(rule => rule.width > em * .3 && !fractionRules.has(rule.id));
  const handledBraces = new Set();
  for (const first of braceRules) {
    if (handledBraces.has(first.id)) continue;
    for (const second of braceRules) {
      if (second.x <= right(first) || second.x - right(first) > em * 1.3 || Math.abs(first.y - second.y) > em * .15) continue;
      const ends = [first.x, (right(first) + second.x) / 2, right(second)].map(x => shallow.filter(node =>
        x >= node.box.x - em * .15 && x <= right(node.box) + em * .15
        && first.y >= node.box.y - em * .15 && first.y <= bottom(node.box) + em * .15)[0]);
      if (ends.some(node => !node) || new Set(ends.map(node => node.index)).size !== 3
        || new Set(ends.map(node => node.item.fontName)).size !== 1) continue;
      const span = union([first, second, ...ends.map(node => node.box)]);
      const labels = nodes.map((node, index) => ({ ...node, index })).filter(node => node.box.y >= bottom(span) - em * .1
        && node.box.y - bottom(span) < em && node.item.fontHeight <= em * .86
        && overlap(node.box, span) > Math.min(node.box.width, span.width) * .25);
      const terms = nodes.map((node, index) => ({ ...node, index })).filter(node => bottom(node.box) <= span.y + em * .2
        && span.y - bottom(node.box) < em * 1.4 && overlap(node.box, span) > Math.min(node.box.width, span.width) * .4);
      if (!labels.length || !terms.length) continue;
      const members = [...ends, ...labels, ...terms].map(node => node.index);
      const part = component('underbrace', members, [first, second]);
      const target = weightedMedian(terms.map(node => node.item), item => projectPoint(item.baselineX, item.baselineY)[1]);
      hostRows(members, span, target, em, part);
      handledBraces.add(first.id); handledBraces.add(second.id); break;
    }
  }
  for (let index=0;index<nodes.length;index++) {
    const node=nodes[index];
    if (!(node.item.str.includes('{')&&node.item.str.includes('}') || /^[⏟⏞]$/u.test(node.item.str))
      || node.box.height>em*.7 || node.box.width<em) continue;
    const labels=nodes.map((n,i)=>({...n,index:i})).filter(n=>n.box.y>=bottom(node.box)-em*.1&&n.box.y-bottom(node.box)<em
      && n.item.fontHeight<=em*.86&&overlap(n.box,node.box)>Math.min(n.box.width,node.box.width)*.25);
    const terms=nodes.map((n,i)=>({...n,index:i})).filter(n=>bottom(n.box)<=node.box.y+em*.2&&node.box.y-bottom(n.box)<em*1.4
      &&overlap(n.box,node.box)>Math.min(n.box.width,node.box.width)*.4);
    if(!labels.length||!terms.length)continue;
    const members=[index,...labels.map(n=>n.index),...terms.map(n=>n.index)];
    const part=component('underbrace',members);
    hostRows(members,node.box,weightedMedian(terms.map(n=>n.item),i=>projectPoint(i.baselineX,i.baselineY)[1]),em,part);
  }

  // Extensible-font integrals/sums can decode as Latin letters. Tall actual
  // ink and aligned upper/lower limits still supply the operator relationship.
  const operators = nodes.map((node, index) => ({ ...node, index })).filter(node => {
    const known = /^[∫∬∭∮∯∰∑∏⋂⋃]$/u.test(node.item.str.trim());
    const unknown = displacedLetter(node);
    return (known || unknown) && !delimiterKind(node.item.str)
      && ![...usedDelimiters].some(delimiter=>delimiter.members.includes(node.index));
  });
  const limitScore = (limit, operator) => Math.max(operator.y-bottom(limit),limit.y-bottom(operator),0)
    + Math.abs(midpoint(limit)[0] - midpoint(operator)[0]) * .35;
  for (const node of operators) {
    const { index, box } = node;
    const compatibleOwner = other => {
      if(find(other.member)===find(index))return true;
      const bases=nodes.filter((candidate,member)=>find(member)===find(other.member)
        && candidate.item.fontHeight>other.item.fontHeight*1.15 && !structuralGlyphs.has(member));
      if(!bases.length)return true;
      const baseline=weightedMedian(bases.map(candidate=>candidate.item),item=>projectPoint(item.baselineX,item.baselineY)[1]);
      return Math.abs(baseline-(midpoint(box)[1]+em*.25))<em*.65;
    };
    const limits = nodes.map((other, member) => ({ ...other, member })).filter(other => other.member !== index
      && other.item.fontHeight <= Math.min(em * .86, node.item.fontHeight * .86)
      && other.box.height < em * 1.3 && !delimiterKind(other.item.str)
      && intervalGap(other.box, box) < em * .7 && other.box.width < em * 4
      && midpoint(other.box)[0] >= box.x - em * .2 && midpoint(other.box)[0] <= right(box) + em * .6
      && Math.min(Math.abs(bottom(other.box) - box.y), Math.abs(other.box.y - bottom(box))) < em * .9
      && !operators.some(operator => operator.index !== index
        && intervalGap(other.box, operator.box) < em * .7
        && limitScore(other.box, operator.box) + em * .01 < limitScore(other.box, box))
      && compatibleOwner(other)
      && !prose(other.item.str));
    const members = [index, ...limits.map(other => other.member)];
    const part = component('large-operator', members);
    hostRows(members, box, midpoint(box)[1] + em * .25, em, part);
  }

  // A single-sided delimiter may enclose an inline subexpression, so it need
  // not have a partner. Assign its actual vertical centre to the intersecting
  // physical row, instead of using the extensible font's artificial baseline.
  for (const index of structuralGlyphs) {
    if (components.some(part => part.itemIndices.includes(nodes[index].item.index))) continue;
    const node = nodes[index];
    const part = component('delimiter-fragment', [index]);
    hostRows([index], node.box, midpoint(node.box)[1] + em * .25, em, part);
  }

  function assemble() {
    const groups = new Map();
    for (let index = 0; index < nodes.length; index++) {
      const root = find(index); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(index);
    }
    return [...groups.values()].map(members => {
      const memberSet = new Set(members.map(index => nodes[index].item.index));
      const parts = components.filter(part => part.itemIndices.some(index => memberSet.has(index)));
      const source = members.map(index => nodes[index].item).sort((a, b) => a.along - b.along || a.baselineOffset - b.baselineOffset);
      const line = mergeItems(source), coreBounds = parts.length ? union([line, ...parts.map(part => part.bounds)]) : { x: line.x, y: line.y, width: line.width, height: line.height };
      const anchor = parts.map(part => part.anchorItemIndex).find(index => index !== undefined);
      const ordinary = source.filter(item=>!structuralGlyphs.has(byIndex.get(item.index)) && !operators.some(node=>node.item.index===item.index));
      const fontHeight = ordinary.length ? Math.max(...ordinary.map(item=>item.fontHeight)) : weightedMedian(source,item=>item.fontHeight);
      const baseItems = (ordinary.length?ordinary:source).filter(item=>item.fontHeight>=fontHeight*.86);
      const mainBaseline = weightedMedian(baseItems, value=>value.baselineOffset);
      const main = anchor !== undefined ? nodes[byIndex.get(anchor)].item : baseItems.reduce((best, item) =>
        Math.abs(item.baselineOffset-mainBaseline)<Math.abs(best.baselineOffset-mainBaseline)?item:best,baseItems[0]);
      Object.assign(line, coreBounds, { baseline: main.baseline, baselineX: main.baselineX, baselineY: main.baselineY,
        baselineOffset: main.baselineOffset, fontHeight,
        kind: parts.some(part=>part.type!=='physical-row') || mathematical(line.text) ? 'equation' : 'text', components: parts.map(part => part.id), coreBounds });
      const region=regionAt(frame(line));
      line.regionId=region.id;
      line.regionBounds={x:region.x,y:region.y,width:region.width,height:region.height};
      return { line, members };
    });
  }
  let units = assemble();
  // Resolve one-sided/compound brackets against complete fraction/enclosure
  // geometry. Their centre can lie between numerator and denominator baselines.
  for (const unit of units) {
    if (!unit.members.every(index=>structuralGlyphs.has(index))) continue;
    const box=frame(unit.line);
    const candidates=units.filter(other=>other!==unit && other.line.kind==='equation'
      && other.members.some(index=>!structuralGlyphs.has(index))
      && inRegion(frame(other.line),regionAt(box))
      && intervalGap(box,frame(other.line))<em*1.5
      && Math.min(bottom(box),bottom(frame(other.line)))-Math.max(box.y,frame(other.line).y)>Math.min(box.height,frame(other.line).height)*.6)
      .sort((a,b)=>Math.abs(midpoint(frame(a.line))[1]-midpoint(box)[1])-Math.abs(midpoint(frame(b.line))[1]-midpoint(box)[1]));
    if(candidates.length && (candidates.length===1 || Math.abs(midpoint(frame(candidates[1].line))[1]-midpoint(box)[1])
      -Math.abs(midpoint(frame(candidates[0].line))[1]-midpoint(box)[1])>em*.3))join([...unit.members,...candidates[0].members]);
  }
  units=assemble();
  for(const unit of units.filter(unit=>unit.line.fontHeight<=em*.86)){
    const box=frame(unit.line);
    const relation=tag(unit.line.text) && nodes.map((node,index)=>({...node,index})).filter(node=>/^\p{Sm}$/u.test(node.item.str)
      && node.item.fontHeight>=unit.line.fontHeight/ .86 && Math.abs(midpoint(box)[0]-midpoint(node.box)[0])<em*.5
      && bottom(box)<=node.box.y+em*.2 && node.box.y-bottom(box)<em*.7)
      .sort((a,b)=>a.box.y-b.box.y)[0];
    if(relation){const members=[...unit.members,relation.index],part=component('relation-label',members);
      hostRows(members,relation.box,relation.baseline,relation.item.fontHeight,part);continue;}
    const named=nodes.map((node,index)=>({...node,index})).filter(node=>/(?:\barg\s*)?\b(?:min|max|lim|sup|inf)\s*$/u.test(node.item.str)
      && midpoint(box)[0]>=node.box.x && midpoint(box)[0]<=right(node.box)
      && box.y>=bottom(node.box)-em*.2 && box.y-bottom(node.box)<em*.7)[0];
    if(named){component('operator-limit',[...unit.members,named.index]);continue;}
    const edge=nodes.map((node,index)=>({...node,index})).filter(node=>structuralGlyphs.has(node.index)
      && node.box.height>em*1.4 && box.x>=right(node.box)-em*.2 && box.x-right(node.box)<em*.5
      && Math.abs(box.y-bottom(node.box))<em*.5 && bottom(box)>=bottom(node.box))
      .sort((a,b)=>Math.abs(box.y-bottom(a.box))-Math.abs(box.y-bottom(b.box)))[0];
    if(edge)component('evaluation-script',[...unit.members,edge.index]);
  }
  units=assemble();
  // Small scripts initially attached to an extensible glyph's false baseline
  // can now be attached to the resolved mathematical row using actual ink.
  const repairRegionByItem=new Map(units.flatMap(unit=>unit.line.items.map(item=>[item.index,unit.line.regionId])));
  const repairRows=units.map(unit=>({...unit.line,items:[...unit.line.items]}));
  const canRepair=(first,second)=>{
    const a=new Set(first.items.map(item=>repairRegionByItem.get(item.index)));
    const b=new Set(second.items.map(item=>repairRegionByItem.get(item.index)));
    return [...a].every(left=>[...b].every(right=>regionLayout.permitsLocalConnection(left,right)));
  };
  const repairedRows=attachScriptFragments(repairRows,scale,canRepair);
  for (const row of repairedRows) join(row.items.map(item => byIndex.get(item.index)));
  units = assemble();
  for(const unit of units.filter(unit=>/^[=≠≈≃≅≤≥<>→←↔⇒⇔↦∝∼]$/u.test(unit.line.text))){
    const box=frame(unit.line),baseline=projectPoint(unit.line.baselineX,unit.line.baselineY)[1];
    const nearby=units.filter(other=>other!==unit && inRegion(frame(other.line),regionAt(box))
      && Math.abs(projectPoint(other.line.baselineX,other.line.baselineY)[1]-baseline)<em*.3
      && intervalGap(frame(other.line),box)<em*3);
    const before=nearby.filter(other=>right(frame(other.line))<=box.x).sort((a,b)=>right(frame(b.line))-right(frame(a.line)))[0];
    const after=nearby.filter(other=>frame(other.line).x>=right(box)).sort((a,b)=>frame(a.line).x-frame(b.line).x)[0];
    if(before&&after)component('relation',[...before.members,...unit.members,...after.members]);
  }
  units=assemble();
  const equations = units.filter(unit => (unit.line.kind === 'equation' || /\p{Sm}/u.test(unit.line.text)) && !tag(unit.line.text));
  for (const label of units.filter(unit => tag(unit.line.text))) {
    const box = frame(label.line);
    let candidates = equations.filter(unit => {
      const core = frame(unit.line), region = regionAt(core);
      const labelBaseline = projectPoint(label.line.baselineX, label.line.baselineY)[1];
      const sameBaseline = Math.abs(labelBaseline - projectPoint(unit.line.baselineX, unit.line.baselineY)[1]) < Math.min(label.line.fontHeight, unit.line.fontHeight) * .4;
      const insideStructure = unit.line.components.length && labelBaseline >= core.y && labelBaseline <= bottom(core);
      return inRegion(box, region) && box.x >= right(core) + em && (sameBaseline || insideStructure);
    }).sort((a, b) => frame(b.line).x - frame(a.line).x);
    let placement='beside';
    // A long display can push its right-aligned number onto a short line just
    // below the expression. This is still one formula, not a new reading stop.
    if(!candidates.length&&/^\s*[([{]\d+[\p{L}.–−-]*[)\]}]\s*$/u.test(label.line.text)){
      candidates=equations.filter(unit=>{
        const core=frame(unit.line),region=regionAt(core),localEm=Math.min(unit.line.fontHeight,label.line.fontHeight);
        if(unit.line.kind!=='equation'||unit.line.components.some(id=>components.find(part=>part.id===id)?.type==='equation-label'))return false;
        if(!inRegion(box,region)||!regionLayout.permitsLocalConnection(unit.line.regionId,label.line.regionId)
          ||Math.abs(right(box)-right(region))>localEm*1.8
          ||box.x<right(core)-Math.max(localEm*2.5,core.width*.1)
          ||box.y<bottom(core)-localEm*.4||box.y-bottom(core)>localEm*1.5)return false;
        return !units.some(other=>other!==unit&&other!==label&&inRegion(frame(other.line),region)
          &&midpoint(frame(other.line))[1]>bottom(core)+localEm*.1
          &&midpoint(frame(other.line))[1]<midpoint(box)[1]);
      }).sort((a,b)=>Math.abs(box.y-bottom(frame(a.line)))-Math.abs(box.y-bottom(frame(b.line))));
      placement='below';
    }
    if (!candidates.length) continue;
    const closest = candidates[0];
    // A marginal equation label belongs to the nearest preceding core within
    // its column, even when another independent expression shares the band.
    component('equation-label', [...closest.members, ...label.members], [], { labelPlacement:placement,labelItemIndices: label.members.map(index => nodes[index].item.index),
      anchorItemIndex: closest.line.items.find(item => item.baselineOffset === closest.line.baselineOffset)?.index ?? closest.line.items[0].index });
  }
  units = assemble();
  // Math structure establishes vertical membership; this final layout pass
  // establishes horizontal membership for every row, including plain prose.
  // Run after labels: a wide formula-to-number hull must not contain a second
  // navigation stop for its intervening explanation.
  const rowRegions=new Map(units.map(({line})=>{const box=frame(line);return[line,regionAt({...box,
    y:line.baselineOffset-line.fontHeight*.5,height:line.fontHeight})];}));
  for(const {line}of units){
    const child=rowRegions.get(line);
    for(const {line:other}of units){
      if(other===line||Math.abs(Math.sin(other.angle-line.angle))>.03
        ||Math.abs(other.baselineOffset-line.baselineOffset)>Math.min(other.fontHeight,line.fontHeight)*.25)continue;
      const parent=rowRegions.get(other),box=frame(other),padding=Math.min(other.fontHeight,line.fontHeight);
      // Compare quantized point boundaries, not reconstructed floating sums:
      // at 180° and fractional zoom, x + width can differ by one ULP.
      const parentStart=Math.round(parent.x/scale*100),parentEnd=Math.round(right(parent)/scale*100);
      const childStart=Math.round(child.x/scale*100),childEnd=Math.round(right(child)/scale*100);
      if(parent.width<=child.width+padding||parentStart>childStart||parentEnd<childEnd)continue;
      const boundaries=[child.x,right(child)].filter(cut=>cut>parent.x+padding&&cut<right(parent)-padding);
      // A genuine spanning unit (for example a formula below a wrapped figure)
      // establishes the parent region for its whole physical row, including a
      // separate qualifier or label on the former child-column side.
      if(boundaries.some(cut=>box.x<cut-padding&&right(box)>cut+padding))rowRegions.set(line,parent);
    }
  }
  for(const group of physicalRowGroups(units.map(unit=>unit.line),line=>rowRegions.get(line))){
    if(group.length<2)continue;
    const members=group.flatMap(index=>units[index].members);
    const anchor=units[group[0]].line;
    component('physical-row',members,[],{anchorItemIndex:anchor.items.find(item=>item.baselineOffset===anchor.baselineOffset)?.index??anchor.items[0].index});
  }
  units=assemble();
  for (const { line } of units) {
    const labels = components.filter(part => part.type === 'equation-label' && line.components.includes(part.id));
    if (labels.length) {
      const labelIndices = new Set(labels.flatMap(part => part.labelItemIndices));
      line.labelBounds = union(line.items.filter(item => labelIndices.has(item.index)));
      line.coreBounds = union(line.items.filter(item => !labelIndices.has(item.index)));
    }
  }
  regionLayout.assignOrder(units.map(unit=>unit.line),line=>{const box=frame(line);return {...box,y:line.baselineOffset-line.fontHeight*.5,height:line.fontHeight};});
  if(tableRegions.length){
    // An old saved source anchor can now belong to a skipped table. Resolve its
    // neighbors in the same hierarchy that orders prose, without giving table
    // cells navigation stops or using the PDF's arbitrary content-stream order.
    const entries=units.map(({line})=>({...line}));
    const placeholders=tableRegions.map(region=>({tableRegion:region,...(region.contentBounds||region)}));
    regionLayout.assignOrder([...entries,...placeholders],line=>{
      const box=frame(line);
      return line.tableRegion?box:{...box,y:line.baselineOffset-line.fontHeight*.5,height:line.fontHeight};
    });
    entries.sort((a,b)=>a.readingOrder-b.readingOrder);
    for(const placeholder of placeholders){
      const before=entries.filter(line=>line.readingOrder<placeholder.readingOrder).at(-1);
      const after=entries.find(line=>line.readingOrder>placeholder.readingOrder);
      placeholder.tableRegion.readingNeighbors={previous:before?.items.map(item=>item.index)||null,next:after?.items.map(item=>item.index)||null};
    }
  }
  return { units: units.map(unit => unit.line), rawLines: baselineLines, components, regions: regionLayout.regions.map(node=>({...node,children:node.children.map(child=>child.id)})) };
}
