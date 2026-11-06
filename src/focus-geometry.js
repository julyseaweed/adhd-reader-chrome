// Keep a guide inside the whitespace between real neighboring text rows.
// All coordinates are viewport coordinates; browser/device pixel ratios do not
// enter these calculations.
const end = (rect, axis) => rect[axis] + rect[axis === 'x' ? 'width' : 'height'];
const center = (rect, axis) => (rect[axis] + end(rect, axis)) / 2;
const gap = (value, low, high) => Math.max(low - value, value - high, 0);
const overlap = (a, b, axis) => Math.min(end(a, axis), end(b, axis)) - Math.max(a[axis], b[axis]);
const axes = line => Math.abs(Math.sin(line.angle || 0)) > .7 ? ['y', 'x'] : ['x', 'y'];

export function hitTestLine(lines, x, y, preferredIndex = -1) {
  if (!lines.length) return -1;
  const point = { x, y };
  let winner = 0, best = Infinity;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const [along, across] = axes(line);
    const inlineGap = gap(point[along], line[along], end(line, along));
    const crossGap = gap(point[across], line[across], end(line, across));
    const distanceToCenter = Math.abs(point[across] - center(line, across));
    // Direct text-span hits win only within that row's corrected bounds.
    // Otherwise score distance to the row, breaking overlapping-box ties by
    // proximity to its center instead of whichever row was extracted first.
    if (index === preferredIndex && inlineGap === 0 && crossGap === 0) return index;
    const score = crossGap ** 2 + inlineGap ** 2 * .2 + distanceToCenter ** 2 * .025;
    if (score < best) { best = score; winner = index; }
  }
  return winner;
}

export function readingLineAtPoint(layout, x, y, preferredIndex = -1) {
  // Text excluded by the page-layout model is still available for selection
  // and annotation. It is never a target of the separate reading navigator.
  const regions = layout.excludedRegions || [...(layout.figureRegions || []), ...(layout.tableRegions || [])];
  const excluded = [...(layout.excludedLines||[]), ...regions].some(rect =>
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
  return excluded ? -1 : hitTestLine(layout.lines, x, y, preferredIndex);
}

function continuesReadingRun(previous, next) {
  const angle = previous.angle || 0;
  // Keep opposite-direction and perpendicular labels out of the same run.
  if (Math.cos((next.angle || 0) - angle) < Math.cos(Math.PI / 18)) return false;
  const [along] = axes(previous);
  const sharedWidth = overlap(previous, next, along);
  const previousWidth = end(previous, along) - previous[along];
  const nextWidth = end(next, along) - next[along];
  if (sharedWidth <= Math.min(previousWidth, nextWidth) * .15) return false;
  // Reading order restarts near the top at a column transition. Comparing
  // adjacent rows, rather than every row with a spanning title, prevents the
  // title from accidentally joining both columns into one giant aperture.
  const progress = -Math.sin(angle) * (center(next, 'x') - center(previous, 'x'))
    + Math.cos(angle) * (center(next, 'y') - center(previous, 'y'));
  const em = Math.max(previous.fontHeight || Math.min(previous.width, previous.height),
    next.fontHeight || Math.min(next.width, next.height));
  return progress >= -em * .35;
}

/** Exact-size window within the current contiguous column/orientation run. */
export function focusLineGroup(lines, index, count) {
  if (!lines[index]) return [];
  const requested = Math.max(1, Math.min(10, Math.round(Number(count) || 1)));
  let first = index, last = index;
  while (first > 0 && continuesReadingRun(lines[first - 1], lines[first])) first--;
  while (last + 1 < lines.length && continuesReadingRun(lines[last], lines[last + 1])) last++;
  const size = Math.min(requested, last - first + 1);
  const preceding = Math.floor((size - 1) / 2);
  const start = Math.max(first, Math.min(index - preceding, last - size + 1));
  return lines.slice(start, start + size);
}

export function focusRect(lines, index, count, viewport) {
  const line = lines[index];
  if (!line) return null;
  const [along, across] = axes(line);
  const group = focusLineGroup(lines, index, count);
  const members = new Set(group);
  const fontHeight = line.fontHeight || Math.min(line.width, line.height);
  const inlinePadding = Math.min(8, Math.max(2, fontHeight * .35));
  const crossPadding = Math.min(3, Math.max(.5, fontHeight * .12));
  const bounds = {
    x: Math.min(...group.map(l => l.x)),
    y: Math.min(...group.map(l => l.y)),
    width: 0, height: 0,
  };
  bounds.width = Math.max(...group.map(l => end(l, 'x'))) - bounds.x;
  bounds.height = Math.max(...group.map(l => end(l, 'y'))) - bounds.y;
  let start = bounds[across] - crossPadding;
  let finish = end(bounds, across) + crossPadding;
  for (const other of lines) {
    if (members.has(other) || axes(other)[0] !== along || overlap(other, bounds, along) <= 0) continue;
    const otherCenter = center(other, across);
    if (otherCenter < bounds[across]) {
      // Put the edge halfway through the available gap, never over the next
      // row simply because this row's font has a tall em box.
      start = Math.max(start, Math.min(bounds[across], (end(other, across) + bounds[across]) / 2));
    } else if (otherCenter > end(bounds, across)) {
      finish = Math.min(finish, Math.max(end(bounds, across), (other[across] + end(bounds, across)) / 2));
    }
  }
  const inlineStart = Math.max(0, bounds[along] - inlinePadding);
  const inlineEnd = Math.min(along === 'x' ? viewport.width : viewport.height, end(bounds, along) + inlinePadding);
  start = Math.max(0, start);
  finish = Math.min(across === 'x' ? viewport.width : viewport.height, finish);
  return along === 'x'
    ? { x: inlineStart, y: start, width: inlineEnd - inlineStart, height: Math.max(1, finish - start) }
    : { x: start, y: inlineStart, width: Math.max(1, finish - start), height: inlineEnd - inlineStart };
}

export function anchoredLineIndex(lines, previousLine, fallbackIndex) {
  if (previousLine) {
    const indices = new Set(previousLine.items?.map(item => item.index));
    const anchored = lines.findIndex(line => line.items?.some(item => indices.has(item.index)));
    if (anchored >= 0) return anchored;
  }
  return Math.max(0, Math.min(fallbackIndex === Infinity ? lines.length - 1 : fallbackIndex, lines.length - 1));
}
