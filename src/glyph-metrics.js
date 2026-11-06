// Shared PDF text metrics for the web reader and the Zotero reader adapter.
// `document` must be the viewer document whose embedded font faces are loaded.
const measuredFontMetrics = new WeakMap();
const pageGlyphMaps = new WeakMap();
const fontMeasureContexts = new WeakMap();
const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
function validMetrics(style) {
  return Number.isFinite(style?.ascent) && style.ascent > 0 && style.ascent < 2
    && Number.isFinite(style.descent) && style.descent <= 0 && style.descent > -1
    && style.ascent - style.descent > 0.25;
}
export function ordinaryMetrics(style) {
  return validMetrics(style) && style.descent >= -.5 && style.ascent - style.descent <= 1.4;
}

export async function glyphMapForPage(page, ops) {
  if (!page.getOperatorList || !ops) return new Map();
  if (pageGlyphMaps.has(page)) return pageGlyphMaps.get(page);
  const promise = (async () => {
    const operators = await page.getOperatorList(), maps = new Map(), stack = [];
    let fontName;
    for (let index = 0; index < operators.fnArray.length; index++) {
      const op = operators.fnArray[index], args = operators.argsArray[index];
      if (op === ops.setFont) { fontName = args[0]; continue; }
      if (op === ops.save) { stack.push(fontName); continue; }
      if (op === ops.restore) { fontName = stack.pop(); continue; }
      if (op !== ops.showText || !fontName) continue;
      let map = maps.get(fontName);
      if (!map) maps.set(fontName, map = new Map());
      for (const glyph of args[0]) {
        if (!glyph?.unicode || !glyph.fontChar) continue;
        let characters = map.get(glyph.unicode);
        if (!characters) map.set(glyph.unicode, characters = new Set());
        characters.add(glyph.fontChar);
      }
    }
    return maps;
  })().catch(() => new Map());
  pageGlyphMaps.set(page, promise);
  return promise;
}

function pathMetrics(page, font, characters) {
  let low = Infinity, high = -Infinity;
  for (const character of characters) {
    const key = `${font.loadedName}_path_${character}`;
    if (!page.commonObjs?.has(key)) return null;
    const path = page.commonObjs.get(key).path;
    if (!path?.length) return null;
    for (let index = 0; index < path.length;) {
      // PDF.js exposes paths in em units; Bézier control bounds conservatively
      // enclose the ink and avoid the unrelated full-font bounding box.
      const op = path[index++], pairs = [1, 1, 3, 2, 0][op];
      if (pairs === undefined) return null;
      for (let point = 0; point < pairs; point++) {
        index++; const y = path[index++];
        low = Math.min(low, y); high = Math.max(high, y);
      }
    }
  }
  return Number.isFinite(low) && high > low ? { ascent: Math.max(0, high), descent: Math.max(0, -low) } : null;
}

export function fontMetrics(page, fontName, style, styles, sample, glyphMaps, document = globalThis.document) {
  if (ordinaryMetrics(style)) return { ascent: style.ascent, descent: -style.descent };
  let cache = measuredFontMetrics.get(page);
  if (!cache) measuredFontMetrics.set(page, cache = new Map());
  const cacheKey = `${fontName}\0${sample}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const characters = new Set();
  for (const [unicode, mapped] of glyphMaps?.get(fontName) || []) {
    if (sample.includes(unicode)) for (const character of mapped) characters.add(character);
  }
  let font;
  try { font = page.commonObjs?.get(fontName); } catch { /* No rendered font in a plain text extraction. */ }
  if (font && characters.size) {
    const metrics = pathMetrics(page, font, characters);
    if (metrics) { cache.set(cacheKey, metrics); return metrics; }
  }
  // Some embedded fonts report ascent=descent=0. A nullish fallback accepts
  // those zeroes and puts the complete selection below the text baseline.
  // Measure the actual loaded face when available, not the generic TextLayer font.
  if (typeof document !== 'undefined' && document.fonts) {
    try {
      const family = font?.loadedName;
      const loaded = family && Array.from(document.fonts).some(face =>
        face.status === 'loaded' && face.family.replace(/^["']|["']$/g, '') === family);
      if (loaded && characters.size) {
        let fontMeasureContext = fontMeasureContexts.get(document);
        if (!fontMeasureContext) {
          fontMeasureContext = document.createElement('canvas').getContext('2d');
          fontMeasureContexts.set(document, fontMeasureContext);
        }
        fontMeasureContext.font = `100px "${family}"`;
        // Embedded PDF fonts often map Unicode to private-use fontChar values.
        // Measuring Unicode directly would silently use a system fallback face.
        const measured = fontMeasureContext.measureText([...characters].join(''));
        const ascent = Math.max(0, measured.actualBoundingBoxAscent / 100);
        const descent = Math.max(0, measured.actualBoundingBoxDescent / 100);
        // Extensible brackets and large operators legitimately extend several
        // ems below their artificial font baseline. Their loaded-face ink must
        // use the same contract as pathMetrics, without a body-font size cap.
        if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0) {
          const metrics = { ascent, descent };
          cache.set(cacheKey, metrics); return metrics;
        }
      }
    } catch { /* Fonts can still be loading when extraction runs without rendering. */ }
  }
  // Related valid faces on the same page provide a better fallback for mixed
  // regular/italic text than assigning every damaged font a full-em rectangle.
  const peers = Object.values(styles).filter(other => ordinaryMetrics(other)
    && other.fontFamily === style?.fontFamily && Boolean(other.vertical) === Boolean(style?.vertical));
  const metrics = peers.length
    ? { ascent: median(peers.map(peer => peer.ascent)), descent: median(peers.map(peer => -peer.descent)) }
    : { ascent: 0.8, descent: 0.2 };
  return metrics;
}


export { attachScriptFragments, orderReadingLines } from './reading-lines.js';
export { extractDrawingStructures } from './pdf-structure.js';
export { buildReadingUnits } from './math-reading.js';
export { createReadingScroll, readingScrollTarget } from './reading-scroll.js';
export { chooseVisibleReadingLine } from './visible-reading-line.js';
