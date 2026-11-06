// Selection geometry has one owner: text-node ranges -> canonical row regions.
// The same regions are used for drafts, browser overlays and PDF QuadPoints.
const point = number => Math.round(number * 1e6) / 1e6;
const end = (rect, axis) => rect[axis] + rect[axis === 'x' ? 'width' : 'height'];

function cleanRect(rect) {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new TypeError('选区坐标无效');
  const x = Math.min(rect.x, rect.x + rect.width), y = Math.min(rect.y, rect.y + rect.height);
  return { x: point(x), y: point(y), width: point(Math.abs(rect.width)), height: point(Math.abs(rect.height)) };
}

function mergePhysicalRows(rects, vertical, tolerance) {
  const along = vertical ? 'y' : 'x', across = vertical ? 'x' : 'y';
  const extent = vertical ? 'width' : 'height';
  const result = [];
  for (const rect of [...rects].sort((a, b) => a[across] - b[across] || a[along] - b[along])) {
    let current = rect;
    // Joining only touching/overlapping intervals preserves paragraph/column
    // gaps. Different font em boxes on the same selected row share one band.
    for (let index = result.length - 1; index >= 0; index--) {
      const other = result[index];
      const overlap = Math.min(end(current, across), end(other, across)) - Math.max(current[across], other[across]);
      const centerDistance = Math.abs(current[across] + current[extent] / 2 - other[across] - other[extent] / 2);
      const sameRow = overlap >= Math.min(current[extent], other[extent]) * .6
        && centerDistance <= Math.max(current[extent], other[extent]) * .4;
      const touching = current[along] <= end(other, along) + tolerance && other[along] <= end(current, along) + tolerance;
      if (!sameRow || !touching) continue;
      const x = Math.min(current.x, other.x), y = Math.min(current.y, other.y);
      current = { x, y, width: Math.max(end(current, 'x'), end(other, 'x')) - x,
        height: Math.max(end(current, 'y'), end(other, 'y')) - y };
      result.splice(index, 1);
      index = result.length; // A merged band can now connect an earlier interval.
    }
    result.push(current);
  }
  return result;
}

/** Produce non-overlapping regions, preserving separate physical text rows.
 * `vertical` describes text direction in this coordinate system.
 * Set mergeRows:false for an exact mathematical rectangle union.
 */
export function canonicalizeRects(input, { vertical = false, tolerance = .25, mergeRows = true } = {}) {
  let rects = input.map(cleanRect).filter(rect => rect.width > 1e-6 && rect.height > 1e-6);
  if (!rects.length) return [];
  if (mergeRows) rects = mergePhysicalRows(rects, vertical, tolerance);
  // Sweep orthogonal strips so no pair of final rectangles can paint the same
  // pixel. This also repairs partially overlapping rectangles in old drafts.
  const edges = [...new Set(rects.flatMap(rect => [point(rect.y), point(end(rect, 'y'))]))].sort((a, b) => a - b);
  const result = [];
  let previous = new Map();
  for (let n = 1; n < edges.length; n++) {
    const top = edges[n - 1], bottom = edges[n];
    if (bottom - top <= 1e-6) continue;
    const middle = (top + bottom) / 2;
    const intervals = rects.filter(rect => rect.y < middle && end(rect, 'y') > middle)
      .map(rect => [point(rect.x), point(end(rect, 'x'))]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const interval of intervals) {
      const tail = merged.at(-1);
      if (tail && interval[0] <= tail[1] + 1e-6) tail[1] = Math.max(tail[1], interval[1]);
      else merged.push([...interval]);
    }
    const current = new Map();
    for (const [left, right] of merged) {
      const key = `${left},${right}`;
      const prior = previous.get(key);
      if (prior && Math.abs(end(prior, 'y') - top) <= 1e-6) {
        prior.height = point(bottom - prior.y); current.set(key, prior);
      } else {
        const rect = { x: left, y: top, width: point(right - left), height: point(bottom - top) };
        result.push(rect); current.set(key, rect);
      }
    }
    previous = current;
  }
  return result.sort((a, b) => vertical ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x);
}

/** Normalize unrotated PDF rectangles; rotation is the selection viewport's angle. */
export function canonicalizePdfRects(rects, rotation = 0) {
  const normalized = rects.map(rect => {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) throw new TypeError('选区坐标无效');
    return { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
  });
  const quarterTurn = ((rotation % 360) + 360) % 360;
  const readingPosition = rect => {
    if (quarterTurn === 90) return [rect[0], rect[1]];
    if (quarterTurn === 180) return [rect[1], -rect[2]];
    if (quarterTurn === 270) return [-rect[2], -rect[3]];
    return [-rect[3], rect[0]];
  };
  return canonicalizeRects(normalized, { vertical: Math.abs(Math.sin(rotation * Math.PI / 180)) > .7 })
    .map(rect => [rect.x, rect.y, point(rect.x + rect.width), point(rect.y + rect.height)])
    .sort((a, b) => { const first = readingPosition(a), second = readingPosition(b); return first[0] - second[0] || first[1] - second[1]; });
}

function weightedMedian(rects, value) {
  const sorted = rects.map(rect => ({ value: value(rect), weight: rect.width }))
    .sort((a, b) => a.value - b.value);
  const half = sorted.reduce((total, item) => total + item.weight, 0) / 2;
  let weight = 0;
  for (let index = 0; index < sorted.length; index++) {
    weight += sorted[index].weight;
    if (weight > half + 1e-6) return sorted[index].value;
    if (Math.abs(weight - half) <= 1e-6) return (sorted[index].value + (sorted[index + 1]?.value ?? sorted[index].value)) / 2;
  }
  return sorted.at(-1).value;
}

function rowBand(rects) {
  return { center: weightedMedian(rects, rect => rect.y + rect.height / 2),
    height: weightedMedian(rects, rect => rect.height) };
}

/** One underline per selected physical row, including ordinary word spaces.
 * PDF rectangles remain in the original page coordinates. Only underlines use
 * this operation: highlights keep the exact selected regions above.
 * A width-weighted row band keeps small math/italic font boxes from shifting a
 * whole line's baseline. Large horizontal gaps still separate columns/cells.
 */
export function underlinePdfRects(input, rotation = 0) {
  const quarterTurn = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(quarterTurn)) throw new TypeError('标注旋转角度无效');
  const toReading = ([x1, y1, x2, y2]) => {
    if (quarterTurn === 90) return { x: y1, y: x1, width: y2 - y1, height: x2 - x1 };
    if (quarterTurn === 180) return { x: -x2, y: y1, width: x2 - x1, height: y2 - y1 };
    if (quarterTurn === 270) return { x: -y2, y: -x2, width: y2 - y1, height: x2 - x1 };
    return { x: x1, y: -y2, width: x2 - x1, height: y2 - y1 };
  };
  const fromReading = ({ x, y, width, height }) => {
    if (quarterTurn === 90) return [y, x, y + height, x + width];
    if (quarterTurn === 180) return [-x - width, y, -x, y + height];
    if (quarterTurn === 270) return [-y - height, -x - width, -y, -x];
    return [x, -y - height, x + width, -y];
  };
  const rects = input.map(rect => {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) throw new TypeError('选区坐标无效');
    return cleanRect(toReading([Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]));
  }).filter(rect => rect.width > 1e-6 && rect.height > 1e-6);
  const rows = [];
  // Establish rows with the longest text spans first. A short raised symbol
  // cannot become a bridge between the ordinary text above and below it.
  for (const rect of rects.sort((a, b) => b.width - a.width || a.y - b.y || a.x - b.x || b.height - a.height)) {
    const center = rect.y + rect.height / 2;
    let closest = null, distance = Infinity;
    for (const row of rows) {
      const band = row.band;
      const overlap = Math.min(rect.y + rect.height, band.center + band.height / 2)
        - Math.max(rect.y, band.center - band.height / 2);
      const delta = Math.abs(center - band.center);
      if (overlap < Math.min(rect.height, band.height) * .5
        || delta > Math.max(rect.height, band.height) * .5) continue;
      const score = delta / Math.max(rect.height, band.height);
      if (score < distance) { closest = row; distance = score; }
    }
    if (closest) { closest.rects.push(rect); closest.band = rowBand(closest.rects); }
    else rows.push({ rects: [rect], band: rowBand([rect]) });
  }
  const result = [];
  for (const row of rows) {
    const fragments = row.rects.sort((a, b) => a.x - b.x || a.y - b.y);
    const runs = [];
    for (const rect of fragments) {
      const last = runs.at(-1);
      const wordGap = 1.25 * row.band.height;
      if (last && rect.x - last.right <= wordGap + 1e-6) {
        last.rects.push(rect); last.right = Math.max(last.right, rect.x + rect.width);
      } else runs.push({ rects: [rect], right: rect.x + rect.width });
    }
    for (const run of runs) {
      const left = Math.min(...run.rects.map(rect => rect.x));
      const top = weightedMedian(run.rects, rect => rect.y);
      const bottom = weightedMedian(run.rects, rect => rect.y + rect.height);
      result.push({ x: left, y: top, width: run.right - left, height: bottom - top });
    }
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x).map(rect => fromReading(rect).map(point));
}

/** Read only text-node fragments of a DOM Range, never ancestor element boxes.
 * Output is clipped to baseRect and expressed in page-relative viewport pixels.
 * Convert to PDF space, then canonicalizePdfRects before storing an annotation.
 */
export function selectionRectsFromRange(range, container, baseRect) {
  if (!range || range.collapsed || !range.intersectsNode(container)) return [];
  const document = container.ownerDocument;
  const walker = document.createTreeWalker(container, 4); // NodeFilter.SHOW_TEXT
  const rects = [];
  const right = baseRect.right ?? baseRect.left + baseRect.width;
  const bottom = baseRect.bottom ?? baseRect.top + baseRect.height;
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent || !range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const finish = node === range.endContainer ? range.endOffset : node.textContent.length;
    if (finish <= start) continue;
    const fragment = document.createRange();
    fragment.setStart(node, start); fragment.setEnd(node, finish);
    for (const box of fragment.getClientRects()) {
      const x1 = Math.max(box.left, baseRect.left), y1 = Math.max(box.top, baseRect.top);
      const x2 = Math.min(box.right, right), y2 = Math.min(box.bottom, bottom);
      if (x2 - x1 > 1e-6 && y2 - y1 > 1e-6) rects.push({ x: x1 - baseRect.left, y: y1 - baseRect.top, width: x2 - x1, height: y2 - y1 });
    }
  }
  return rects;
}
