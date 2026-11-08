// PDF glyph advances, rather than a system font's relative character widths,
// define the selectable text's horizontal caret positions. Unicode stays intact.
const cachedGlyphs = new WeakMap();
const cachedMappings = new WeakMap();
const identity = () => [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
  a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const point = (matrix, x, y) => [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]];
const matrixArg = args => args?.length === 1 && args[0]?.length === 6 ? Array.from(args[0]) : args?.length === 6 ? Array.from(args) : null;
const finiteMatrix = value => value?.length === 6 && value.every(Number.isFinite);
const whitespace = value => /^\s+$/u.test(value);
const getFont = (fonts, name) => typeof fonts?.get === 'function' ? fonts.get(name) : fonts?.[name];

/** Replay PDF.js's normalized text operators in PDF coordinates, once per page.
 * The caller supplies OPS and resolved font objects; this function has no DOM.
 */
export function glyphAdvancesFromOperators(operators, fonts, ops) {
  const glyphs = [], stack = [];
  let state = { ctm: identity(), matrix: identity(), x: 0, y: 0, lineX: 0, lineY: 0,
    fontName: null, font: null, size: 0, direction: 1, hScale: 1, charSpacing: 0, wordSpacing: 0, rise: 0, leading: 0, known: true };
  const save = () => stack.push({ ...state, ctm: [...state.ctm], matrix: [...state.matrix] });
  const restore = () => { if (stack.length) state = stack.pop(); else state.known = false; };
  const transform = matrix => {
    if (!finiteMatrix(matrix)) { state.known = false; return; }
    state.ctm = multiply(state.ctm, matrix);
  };
  const font = (name, size) => {
    state.fontName = name; state.size = Math.abs(size); state.direction = size < 0 ? -1 : 1;
    try { state.font = getFont(fonts, name) || null; } catch { state.font = null; }
  };
  const move = (x, y) => { state.x = state.lineX += x; state.y = state.lineY += y; };
  for (let index = 0; index < (operators?.fnArray?.length || 0); index++) {
    const op = operators.fnArray[index], args = operators.argsArray[index] || [];
    if (op === ops.save || op === ops.beginGroup) { save(); continue; }
    if (op === ops.restore || op === ops.endGroup) { restore(); continue; }
    if (op === ops.transform) { transform(matrixArg(args)); continue; }
    if (op === ops.paintFormXObjectBegin) { save(); if (args[0]) transform(Array.from(args[0])); continue; }
    if (op === ops.paintFormXObjectEnd) { restore(); continue; }
    if (op === ops.beginText) { state.matrix = identity(); state.x = state.y = state.lineX = state.lineY = 0; continue; }
    if (op === ops.setTextMatrix) {
      const matrix = matrixArg(args);
      if (finiteMatrix(matrix)) { state.matrix = matrix; state.x = state.y = state.lineX = state.lineY = 0; }
      else state.known = false;
      continue;
    }
    if (op === ops.setFont) { font(args[0], args[1]); continue; }
    if (op === ops.setGState) { for (const entry of args[0] || []) if (entry[0] === 'Font') font(...entry[1]); continue; }
    if (op === ops.setCharSpacing) { state.charSpacing = args[0]; continue; }
    if (op === ops.setWordSpacing) { state.wordSpacing = args[0]; continue; }
    if (op === ops.setHScale) { state.hScale = args[0] / 100; continue; }
    if (op === ops.setTextRise) { state.rise = args[0]; continue; }
    if (op === ops.setLeading) { state.leading = -args[0]; continue; }
    if (op === ops.moveText) { move(args[0], args[1]); continue; }
    if (op === ops.setLeadingMoveText) { state.leading = args[1]; move(args[0], args[1]); continue; }
    if (op === ops.nextLine) { move(0, state.leading); continue; }
    if (op !== ops.showText) continue;
    const f = state.font, vertical = Boolean(f?.vertical), fontMatrix = f?.fontMatrix || [.001, 0, 0, .001, 0, 0];
    const matrix = multiply(state.ctm, state.matrix), horizontalScale = state.hScale * state.direction;
    const em = Math.hypot(matrix[2], matrix[3]) * state.size;
    const supported = state.known && f && !vertical && !f.isType3Font && !f.isInvalidPDFjsFont && state.direction > 0 && state.hScale > 0
      && finiteMatrix(matrix) && finiteMatrix(fontMatrix) && fontMatrix[0] > 0 && em > 0;
    const firstGlyph = glyphs.length;
    let advance = 0;
    for (const glyph of args[0] || []) {
      if (typeof glyph === 'number') { advance += (vertical ? 1 : -1) * glyph * state.size / 1000; continue; }
      if (!glyph || !Number.isFinite(glyph.width)) { state.known = false; continue; }
      const width = (vertical ? -(glyph.vmetric?.[0] || 0) : glyph.width) * state.size * fontMatrix[0];
      const spacing = state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0);
      if (supported && state.known && typeof glyph.unicode === 'string' && glyph.unicode) {
        const start = point(matrix, state.x + advance * horizontalScale, state.y + state.rise);
        const end = point(matrix, state.x + (advance + width) * horizontalScale, state.y + state.rise);
        if ([...start, ...end].every(Number.isFinite)) glyphs.push({ fontName: state.fontName, unicode: glyph.unicode,
          start, end, em, operatorIndex: index, sequence: glyphs.length });
      }
      advance += width + spacing * (vertical ? -state.direction : state.direction);
    }
    if (!state.known) glyphs.length = firstGlyph;
    if (vertical) state.y -= advance; else state.x += advance * horizontalScale;
  }
  return glyphs;
}

function mapItem(item, records, style) {
  if (!item.str || item.dir !== 'ltr' || style?.vertical || /[\p{Script=Arabic}\p{Script=Hebrew}\p{Cf}]/u.test(item.str)) return null;
  const [a, b, c, d, x, y] = item.transform, axisLength = Math.hypot(a, b), em = Math.hypot(c, d);
  if (!(axisLength > 0 && em > 0 && item.width > 0)) return null;
  const ax = a / axisLength, ay = b / axisLength, tolerance = Math.max(.05, em * .005);
  const projected = [];
  for (const glyph of records) {
    if (Math.abs(glyph.em - em) > tolerance) continue;
    const along = p => (p[0] - x) * ax + (p[1] - y) * ay;
    const across = p => -(p[0] - x) * ay + (p[1] - y) * ax;
    const start = along(glyph.start), end = along(glyph.end);
    if (Math.abs(across(glyph.start)) > tolerance || Math.abs(across(glyph.end)) > tolerance
      || start < -tolerance || start > item.width + tolerance || end < start - tolerance || end > item.width + tolerance) continue;
    projected.push({ ...glyph, offset: start, finish: end });
  }
  projected.sort((first, second) => first.offset - second.offset || first.sequence - second.sequence);
  if (!projected.length) return null;
  const raw = [];
  let position = 0, cursor = 0;
  while (cursor < projected.length || position < item.str.length) {
    const spaces = /^\s+/u.exec(item.str.slice(position));
    if (spaces) {
      const firstSpace = projected[cursor];
      const start = firstSpace && whitespace(firstSpace.unicode) ? firstSpace.offset : raw.at(-1)?.finish ?? 0;
      while (cursor < projected.length && whitespace(projected[cursor].unicode)) cursor++;
      const end = projected[cursor]?.offset ?? item.width;
      if (!(end > start)) return null;
      raw.push({ start: position, end: position + spaces[0].length, offset: start, finish: end });
      position += spaces[0].length;
      continue;
    }
    const glyph = projected[cursor++];
    if (!glyph || whitespace(glyph.unicode)) return null;
    let unicode = glyph.unicode;
    if (!item.str.startsWith(unicode, position)) {
      unicode = unicode.normalize('NFKC');
      if (!unicode || !item.str.startsWith(unicode, position)) return null;
    }
    // A multi-letter glyph (e.g. a ligature) remains one indivisible cluster.
    raw.push({ start: position, end: position + unicode.length, offset: glyph.offset, finish: glyph.finish });
    position += unicode.length;
  }
  if (position !== item.str.length || Math.abs(raw[0].offset) > tolerance || Math.abs(raw.at(-1).finish - item.width) > tolerance) return null;
  const boundaries = new Set([0, item.str.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(item.str)) boundaries.add(segment.index);
  const groups = [];
  for (const part of raw) {
    const last = groups.at(-1);
    if (last && !boundaries.has(part.start)) {
      last.end = part.end; last.offset = Math.min(last.offset, part.offset); last.finish = Math.max(last.finish, part.finish);
    } else groups.push({ ...part });
  }
  const clusters = groups.map((part, index) => ({ start: part.start, end: part.end,
    offset: index ? part.offset : 0, advance: (groups[index + 1]?.offset ?? item.width) - (index ? part.offset : 0) }));
  if (clusters.some(cluster => !Number.isFinite(cluster.advance) || cluster.advance <= 0)) return null;
  return { clusters, advance: item.width };
}

/** Map only complete, unambiguous matches to original TextItem UTF-16 offsets.
 * Positions are along each item's own reading axis in PDF points, before zoom.
 */
export function mapTextItemAdvances(glyphs, textContent) {
  const byFont = new Map(), result = new Map();
  for (const glyph of glyphs) {
    let records = byFont.get(glyph.fontName);
    if (!records) byFont.set(glyph.fontName, records = []);
    records.push(glyph);
  }
  textContent.items.forEach((item, index) => {
    if (typeof item.str !== 'string') return;
    const value = mapItem(item, byFont.get(item.fontName) || [], textContent.styles[item.fontName]);
    if (value) result.set(index, value);
  });
  return result;
}

/** Obtain reusable glyph geometry after PDF.js has loaded the page's fonts. */
export async function textAdvancesForPage(page, textContent, ops) {
  if (!page?.getOperatorList || !ops) return new Map();
  if (!cachedGlyphs.has(page)) cachedGlyphs.set(page, (async () => {
    const operators = await page.getOperatorList({ annotationMode: 0 }); // AnnotationMode.DISABLE
    return glyphAdvancesFromOperators(operators, page.commonObjs, ops);
  })().catch(() => []));
  const glyphs = await cachedGlyphs.get(page);
  // Zoom changes the viewport, not these PDF-space text items. PDF.js may hand
  // us a fresh content object, so identity caching alone would repeat the work.
  const signature = JSON.stringify(textContent.items.map(item => typeof item.str === 'string'
    ? [item.str,item.fontName,item.transform,item.width,item.height,item.dir,Boolean(textContent.styles[item.fontName]?.vertical)]
    : [item.type,item.id]));
  const cached = cachedMappings.get(page);
  if (cached?.signature === signature) return cached.advances;
  const advances = mapTextItemAdvances(glyphs, textContent);
  cachedMappings.set(page, { signature, advances });
  return advances;
}
