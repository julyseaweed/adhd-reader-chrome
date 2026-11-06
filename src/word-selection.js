// PDF text items are drawing runs, not word boundaries. Keep the original DOM
// nodes for native selection, and join only typographically adjacent runs.
export function createWordIndex(textDivs, content) {
  const runs = [], byNode = new WeakMap();
  let index = 0;
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const div = textDivs[index++], node = div?.firstChild;
    if (!node || node.nodeType !== 3 || !item.str) continue;
    const [a, b, c, d, x, y] = item.transform;
    const vertical = Boolean(content.styles[item.fontName]?.vertical);
    const angle = Math.atan2(b, a) + (vertical ? Math.PI / 2 : 0);
    const run = { node, text: node.textContent, x, y, angle,
      width: Math.abs(vertical ? item.height : item.width),
      em: Math.hypot(c, d), dir: item.dir, hasEOL: item.hasEOL };
    byNode.set(node, runs.length); runs.push(run);
  }
  return { runs, byNode };
}

export function adjacentWordRuns(left, right) {
  if (!left || !right || left.hasEOL || left.dir !== right.dir
    || /\s$/u.test(left.text) || /^\s/u.test(right.text)
    || Math.cos(right.angle - left.angle) < .9968) return false;
  const em = Math.min(left.em, right.em);
  if (!(em > 0)) return false;
  const dx = right.x - left.x, dy = right.y - left.y;
  const cos = Math.cos(left.angle), sin = Math.sin(left.angle);
  const along = dx * cos + dy * sin;
  const across = Math.abs(-dx * sin + dy * cos);
  const gap = left.dir === 'rtl' ? -along - right.width : along - left.width;
  return across <= em * .18 && gap >= -em * .12 && gap <= em * .15;
}

/** Return native range endpoints for one Unicode word, including split runs. */
export function wordEndpoints(index, node, offset) {
  const at = index?.byNode.get(node);
  if (at === undefined) return null;
  const { runs } = index;
  let first = at, last = at;
  while (first > 0 && adjacentWordRuns(runs[first - 1], runs[first])) first--;
  while (last + 1 < runs.length && adjacentWordRuns(runs[last], runs[last + 1])) last++;
  const parts = runs.slice(first, last + 1);
  const text = parts.map(run => run.text).join('');
  const position = runs.slice(first, at).reduce((sum, run) => sum + run.text.length, 0) + offset;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)];
  // A caret may land just after the final glyph. Prefer its word over the
  // following whitespace, without absorbing punctuation or a neighbouring word.
  const word = segments.find(part => part.isWordLike && position >= part.index && position < part.index + part.segment.length)
    || segments.find(part => part.isWordLike && position === part.index + part.segment.length);
  if (!word) return null;
  const boundary = (position, end) => {
    for (const run of parts) {
      if (position < run.text.length || end && position === run.text.length) return { node: run.node, offset: position };
      position -= run.text.length;
    }
    const run = parts.at(-1); return { node: run.node, offset: run.text.length };
  };
  return { start: boundary(word.index, false), end: boundary(word.index + word.segment.length, true) };
}

export function selectWordAtPoint(index, document, x, y) {
  const caret = document.caretPositionFromPoint?.(x, y);
  const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode || fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  const ends = node && wordEndpoints(index, node, offset);
  if (!ends) return false;
  const range = document.createRange();
  range.setStart(ends.start.node, ends.start.offset); range.setEnd(ends.end.node, ends.end.offset);
  const selection = document.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return !selection.isCollapsed;
}
