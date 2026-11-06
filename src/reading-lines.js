// Shared physical-row geometry. Item indices and real glyph bounds survive
// attachment so browser and native readers use the same navigation stops.
export function mergeItems(items) {
  const x = Math.min(...items.map(i => i.x)), y = Math.min(...items.map(i => i.y));
  const right = Math.max(...items.map(i => i.x + i.width));
  const bottom = Math.max(...items.map(i => i.y + i.height));
  let text = '';
  for (let n = 0; n < items.length; n++) {
    const previous = items[n - 1], item = items[n];
    const previousWidth = previous && Math.abs(Math.cos(previous.angle)) * previous.width
      + (previous ? Math.abs(Math.sin(previous.angle)) * previous.height : 0);
    if (previous && item.along - previous.along - previousWidth > item.fontHeight * 0.12
      && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
    text += item.str;
  }
  const main = items.reduce((largest, item) => item.fontHeight > largest.fontHeight ? item : largest, items[0]);
  return { text: text.trim(), x, y, width: right - x, height: bottom - y,
    baseline: main.baseline, baselineX: main.baselineX, baselineY: main.baselineY,
    baselineOffset: main.baselineOffset, angle: main.angle, fontHeight: main.fontHeight, items };
}

export function attachScriptFragments(lines, pageScale = 1, canJoin = () => true) {
  const remaining = new Set(lines);
  // Baseline clusters describe typographic runs, not physical reading rows.
  // Attach a raised/lowered small run to its locally adjacent larger glyphs;
  // keep independent small-print rows and neighboring columns separate.
  for (const script of [...lines].sort((a, b) => a.fontHeight - b.fontHeight || a.x - b.x)) {
    if (!remaining.has(script)) continue;
    const textItems=script.items.filter(item=>{const box=readingFrameRect(item,script.angle);
      return !(item.str.length===1&&box.width>item.fontHeight*1.5&&box.height<item.fontHeight*.55);});
    const scriptSize=textItems.length?Math.max(...textItems.map(item=>item.fontHeight)):script.fontHeight;
    let target = null, best = Infinity;
    for (const line of remaining) {
      if (line === script || scriptSize > line.fontHeight * .86
        || Math.abs(line.angle - script.angle) > .1 || !canJoin(script,line)) continue;
      const scriptBox = readingFrameRect(script, line.angle);
      for (const item of line.items) {
        if (scriptSize > item.fontHeight * .86) continue;
        const baselineGap = Math.abs(script.baselineOffset - item.baselineOffset);
        if (baselineGap > item.fontHeight * .75) continue;
        const box = readingFrameRect(item, line.angle);
        const inlineGap = Math.max(box.x - scriptBox.x - scriptBox.width,
          scriptBox.x - box.x - box.width, 0);
        const overlap = Math.min(box.y + box.height, scriptBox.y + scriptBox.height) - Math.max(box.y, scriptBox.y);
        if (inlineGap > item.fontHeight * .75 || overlap < Math.min(box.height, scriptBox.height) * .1) continue;
        const inkAlignment = overlap / Math.min(box.height, scriptBox.height);
        const score = 1 - inkAlignment + (inlineGap / item.fontHeight + baselineGap / item.fontHeight) * .25;
        if (score < best) { target = line; best = score; }
      }
    }
    if (target) {
      const items = [...target.items, ...script.items].sort((a, b) => a.along - b.along || a.baselineOffset - b.baselineOffset);
      Object.assign(target, mergeItems(items));
      remaining.delete(script);
    }
  }
  // A long exponent can occupy a gap that initially split the surrounding
  // baseline into two runs. Rejoin those runs once its actual ink is included.
  const result = [...remaining];
  for (let index = 0; index < result.length; index++) {
    const line = result[index];
    for (let otherIndex = index + 1; otherIndex < result.length; otherIndex++) {
      const other = result[otherIndex];
      if (Math.abs(line.angle - other.angle) > .1
        || Math.abs(line.baselineOffset - other.baselineOffset) > Math.max(2 * pageScale, Math.min(line.fontHeight, other.fontHeight) * .3)
        || !canJoin(line,other)) continue;
      const first = readingFrameRect(line, line.angle), second = readingFrameRect(other, line.angle);
      const inlineGap = Math.max(first.x - second.x - second.width, second.x - first.x - first.width, 0);
      if (inlineGap > Math.max(18 * pageScale, Math.min(line.fontHeight, other.fontHeight) * 2.2)) continue;
      Object.assign(line, mergeItems([...line.items, ...other.items].sort((a, b) => a.along - b.along || a.baselineOffset - b.baselineOffset)));
      result.splice(otherIndex, 1);
      otherIndex = index; // The filled interval can now reach an earlier run.
    }
  }
  return result;
}

export function readingFrameRect(rect, angle, scale = 1) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]];
  const xs = corners.map(([x, y]) => (cos * x + sin * y) / scale);
  const ys = corners.map(([x, y]) => (-sin * x + cos * y) / scale);
  const point = value => Math.round(value * 1e6) / 1e6;
  return { x: point(Math.min(...xs)), y: point(Math.min(...ys)),
    width: point(Math.max(...xs) - Math.min(...xs)), height: point(Math.max(...ys) - Math.min(...ys)) };
}


export function orderReadingLines(lines, depth = 0) {
  const rank=line=>line.readingOrder??line.line?.readingOrder??line.row?.readingOrder;
  if(lines.length&&lines.every(line=>Number.isFinite(rank(line))))return [...lines].sort((a,b)=>rank(a)-rank(b));
  const byRows = (a, b) => Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.35
    ? a.x - b.x : a.y - b.y;
  if (lines.length < 2 || depth > 8) return [...lines].sort(byRows);
  let best;
  const regionEdges=[...new Set(lines.flatMap(line=>line.regionBounds?[line.regionBounds.x,line.regionBounds.x+line.regionBounds.width]:[]))];
  for(const cut of regionEdges){
    const before=[],after=[],crossing=[];
    for(const line of lines){
      const box=line.regionBounds||line;
      if(box.x+box.width<=cut+1e-5)before.push(line);
      else if(box.x>=cut-1e-5)after.push(line);
      else crossing.push(line);
    }
    if(!before.length||!after.length)continue;
    // The gutter can move between sections (for example after a spanning
    // heading). Another section's leaf region may straddle this cut by a few
    // points; that does not make every row in that column a spanning heading.
    for(let index=crossing.length-1;index>=0;index--){
      const line=crossing[index],region=line.regionBounds;
      if(!region)continue;
      const contains=other=>{const box=other.regionBounds||other;return box.x>=region.x-1e-5&&box.x+box.width<=region.x+region.width+1e-5;};
      if(before.some(contains)&&after.some(contains))continue;
      if(line.x+line.width<=cut+1e-5){before.push(line);crossing.splice(index,1);}
      else if(line.x>=cut-1e-5){after.push(line);crossing.splice(index,1);}
    }
    const score=Math.min(before.length,after.length);
    if(!best||score>best.score)best={cut,before,after,crossing,score,established:true};
  }
  const typicalHeight = [...lines.map(l => l.height)].sort((a, b) => a - b)[Math.floor(lines.length / 2)];
  // Separate running headers/footers and major vertical sections before finding
  // columns; a left-aligned footer must not be read halfway through a two-column page.
  const bands = [];
  let band = [], bandBottom = -Infinity;
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    if (band.length && line.y - bandBottom > Math.max(18, typicalHeight * 2.2)) {
      bands.push(band); band = [];
    }
    band.push(line); bandBottom = Math.max(bandBottom, line.y + line.height);
  }
  if (band.length) bands.push(band);
  if (!best && bands.length > 1) return bands.flatMap(items => orderReadingLines(items, depth + 1));
  const left = Math.min(...lines.map(l => l.x)), right = Math.max(...lines.map(l => l.x + l.width));
  const edges = [...new Set(lines.flatMap(l => [l.x, l.x + l.width]))].sort((a, b) => a - b);
  // Read the layout model's established columns before falling back to visual
  // whitespace. Re-discovering them with another row-count/crossing threshold
  // changes a genuine two-column block back into alternating left/right rows.
  if (!best && lines.length < 6) return [...lines].sort(byRows);
  for (let n = 1; n < edges.length; n++) {
    if(best?.established)break;
    const cut = (edges[n - 1] + edges[n]) / 2;
    if (cut < left + (right - left) * 0.18 || cut > left + (right - left) * 0.82) continue;
    const before = lines.filter(l => l.x + l.width <= cut);
    const after = lines.filter(l => l.x >= cut);
    const crossing = lines.filter(l => l.x < cut && l.x + l.width > cut);
    if (before.length < 3 || after.length < 3 || crossing.length > lines.length * 0.22) continue;
    const gap = Math.min(...after.map(l => l.x)) - Math.max(...before.map(l => l.x + l.width));
    if (gap < typicalHeight * 0.9) continue;
    const score = Math.min(before.length, after.length) / lines.length - crossing.length / lines.length + gap / (right - left) * 0.2;
    if (!best || score > best.score) best = { cut, before, after, crossing, score };
  }
  if (!best) return [...lines].sort(byRows);
  const leftSide=new Set(best.before),rightSide=new Set(best.after);
  const result = [], spans = best.crossing.sort((a, b) => a.y - b.y || a.x - b.x);
  let remaining = [...best.before, ...best.after];
  for (const span of spans) {
    const band = remaining.filter(l => l.y + l.height / 2 < span.y + span.height / 2);
    result.push(...orderReadingLines(band.filter(l => leftSide.has(l)), depth + 1),
      ...orderReadingLines(band.filter(l => rightSide.has(l)), depth + 1), span);
    const taken = new Set(band);
    remaining = remaining.filter(l => !taken.has(l));
  }
  result.push(...orderReadingLines(remaining.filter(l => leftSide.has(l)), depth + 1),
    ...orderReadingLines(remaining.filter(l => rightSide.has(l)), depth + 1));
  return result;
}

