import {HIGHLIGHT_OPACITY,underlineMetrics} from './annotation-style.js';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString, PDFString } from 'pdf-lib';
import { canonicalizePdfRects, underlinePdfRects } from './selection-geometry.js';
import { ordinaryMetrics, glyphMapForPage, fontMetrics } from './glyph-metrics.js';
import { mergeItems, attachScriptFragments, readingFrameRect, orderReadingLines } from './reading-lines.js';
import { extractDrawingStructures } from './pdf-structure.js';
import { buildReadingUnits } from './math-reading.js';

// The application stores geometry in the PDF's unrotated coordinate system.
// Display coordinates must always go through the viewport, including CropBox offsets.
export let pdfjsLib;
let workerSource;
const pageStructures = new WeakMap();
export function setPDFWorkerSource(url) {
  workerSource = String(url);
  if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = workerSource;
}

export async function loadPDF(bytes, password) {
  pdfjsLib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (workerSource) pdfjsLib.GlobalWorkerOptions.workerSrc = workerSource;
  else if (typeof location !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
  }
  const options = {
    data: bytes instanceof Uint8Array ? Uint8Array.from(bytes) : new Uint8Array(bytes.slice(0)),
    password,
    isEvalSupported: false,
    useSystemFonts: true,
  };
  if (typeof location !== 'undefined') {
    options.cMapUrl = new URL('./vendor/cmaps/', location.href).href;
    options.cMapPacked = true;
    options.standardFontDataUrl = new URL('./vendor/standard_fonts/', location.href).href;
    options.wasmUrl = new URL('./vendor/wasm/', location.href).href;
  }
  const task = pdfjsLib.getDocument(options);
  let document;
  try { document = await task.promise; }
  catch (error) { await task.destroy().catch(() => {}); throw error; }
  // PDF.js 6 moved teardown to the loading task; keep a stable reader-facing API.
  if (typeof document.destroy !== 'function') document.destroy = () => task.destroy();
  // Reading and writing have separate capabilities. Check the writer at import,
  // so a readable encrypted/unsupported file never accumulates unexportable edits.
  try {
    const writable = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    document.canExportAnnotations = !writable.isEncrypted;
    document.exportLimitation = writable.isEncrypted
      ? '此 PDF 已加密；保存一份未加密的副本后即可标注。' : '';
  } catch {
    document.canExportAnnotations = false;
    document.exportLimitation = '此 PDF 暂不支持写入标注；另存为新的 PDF 后重试。';
  }
  return document;
}

function normalRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) {
    throw new TypeError('标注坐标无效');
  }
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

export function viewportRectToPdf(viewport, { x, y, width, height }) {
  const points = [
    viewport.convertToPdfPoint(x, y), viewport.convertToPdfPoint(x + width, y),
    viewport.convertToPdfPoint(x, y + height), viewport.convertToPdfPoint(x + width, y + height),
  ];
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

export function pdfRectToViewport(viewport, rect) {
  const r = normalRect(rect);
  const first = viewport.convertToViewportPoint(r[0], r[1]);
  const second = viewport.convertToViewportPoint(r[2], r[3]);
  const [x1, y1, x2, y2] = normalRect([...first, ...second]);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

function textItemBounds(item, style, metrics, viewport, index, textDivIndex) {
  const tx = multiply(viewport.transform, item.transform);
  let angle = Math.atan2(tx[1], tx[0]);
  if (style?.vertical) angle += Math.PI / 2;
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const ascent = metrics.ascent * fontHeight;
  const descent = metrics.descent * fontHeight;
  const pageScale = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const width = Math.abs((style?.vertical ? item.height : item.width) * pageScale);
  const left = tx[4] + ascent * Math.sin(angle);
  const top = tx[5] - ascent * Math.cos(angle);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const points = [[left, top], [left + width * cos, top + width * sin],
    [left - (ascent + descent) * sin, top + (ascent + descent) * cos],
    [left + width * cos - (ascent + descent) * sin, top + width * sin + (ascent + descent) * cos]];
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return {
    str: item.str, x: Math.min(...xs), y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    baseline: tx[5], baselineX: tx[4], baselineY: tx[5],
    baselineOffset: -sin * tx[4] + cos * tx[5], along: cos * tx[4] + sin * tx[5],
    angle, fontHeight, ascent, descent, fontName: item.fontName,
    transform: tx, dir: item.dir, index, textDivIndex, hasEOL: item.hasEOL,
  };
}

// Find a persistent gutter, then read each column completely. Full-width headings
// split the page into independent bands, so a title and a later section stay in order.
export { orderReadingLines } from './reading-lines.js';

/** Classify navigation text independently from all selectable PDF text.
 * A perpendicular line is excluded only with strong page-wide orientation
 * consensus AND positive spatial evidence that it is isolated in a page margin.
 */
export function classifyReadingLines(allLines, viewport) {
  if (!allLines.length) return { lines: [], excludedLines: [], orientation: { angle: 0, support: 0, lineCount: 0 } };
  const angleTolerance = Math.sin(Math.PI / 18);
  const clusters = [];
  for (const line of allLines) {
    const angle = line.angle || 0;
    // Each physical line has a bounded vote. A single long rotated stamp cannot
    // outweigh a page of short headings, table-of-contents entries or verse.
    const weight = 1 + Math.min(80, [...line.text.replace(/\s/gu, '')].length) / 80;
    let cluster = clusters.find(candidate => Math.abs(Math.sin(angle - candidate.angle)) < angleTolerance);
    if (!cluster) clusters.push(cluster = { angle, weight: 0, lines: [], cos: 0, sin: 0 });
    cluster.weight += weight; cluster.lines.push(line);
    cluster.cos += Math.cos(angle) * weight; cluster.sin += Math.sin(angle) * weight;
  }
  clusters.sort((a, b) => b.weight - a.weight || b.lines.length - a.lines.length);
  const main = clusters[0], total = clusters.reduce((sum, cluster) => sum + cluster.weight, 0);
  const angle = Math.hypot(main.cos, main.sin) > 1e-6 ? Math.atan2(main.sin, main.cos) : main.angle;
  const orientation = { angle, support: main.weight / total, lineCount: main.lines.length };
  if (main.lines.length < 3 || orientation.support < .65) return { lines: allLines, excludedLines: [], orientation };
  const scale = viewport.transform ? Math.hypot(viewport.transform[0], viewport.transform[1]) : (viewport.scale || 1) * (viewport.userUnit || 1);
  const page = readingFrameRect({ x: 0, y: 0, width: viewport.width, height: viewport.height }, angle, scale);
  const bodyRects = main.lines.map(line => readingFrameRect(line, angle, scale));
  const body = { x: Math.min(...bodyRects.map(rect => rect.x)), y: Math.min(...bodyRects.map(rect => rect.y)),
    right: Math.max(...bodyRects.map(rect => rect.x + rect.width)), bottom: Math.max(...bodyRects.map(rect => rect.y + rect.height)) };
  const em = median(main.lines.map(line => (line.fontHeight || Math.min(line.width, line.height)) / scale));
  const separation = Math.max(em * 1.2, Math.min(page.width, page.height) * .015);
  const excluded = new Set();
  for (const line of allLines) {
    if (Math.abs(Math.sin((line.angle || 0) - angle)) < .94) continue;
    const rect = readingFrameRect(line, angle, scale);
    const right = rect.x + rect.width, bottom = rect.y + rect.height;
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    const isolatedPeripheral = (
      right <= body.x - separation && cx <= page.x + page.width * .12
      || rect.x >= body.right + separation && cx >= page.x + page.width * .88
      || bottom <= body.y - separation && cy <= page.y + page.height * .12
      || rect.y >= body.bottom + separation && cy >= page.y + page.height * .88
    );
    if (isolatedPeripheral) excluded.add(line);
  }
  return { lines: allLines.filter(line => !excluded.has(line)),
    excludedLines: allLines.filter(line => excluded.has(line)), orientation };
}

export async function extractReadingLayout(page, viewport, textContent) {
  const content = textContent || await page.getTextContent();
  const pageScale = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const glyphMaps = Object.values(content.styles).some(style => !ordinaryMetrics(style))
    ? await glyphMapForPage(page, pdfjsLib?.OPS) : new Map();
  const items = [];
  let textDivIndex = 0;
  for (let index = 0; index < content.items.length; index++) {
    const item = content.items[index];
    if (typeof item.str !== 'string') continue;
    const divIndex = textDivIndex++;
    if (!item.str.trim()) continue;
    const style = content.styles[item.fontName];
    // Unusually tall global font boxes must be resolved for this glyph, not
    // spread to every symbol from that font on the page.
    const metrics = fontMetrics(page, item.fontName, style, content.styles, item.str, glyphMaps);
    const bound = textItemBounds(item, style, metrics, viewport, index, divIndex);
    if (bound.width > 0.1 * pageScale && bound.height > 0.1 * pageScale) items.push(bound);
  }
  const rows = [];
  for (const item of items.sort((a, b) => a.baselineOffset - b.baselineOffset || a.along - b.along)) {
    let row = rows.find(r => Math.abs(r.baseline - item.baselineOffset) <= Math.max(2 * pageScale, item.fontHeight * 0.3)
      && Math.abs(r.angle - item.angle) < 0.1);
    if (!row) rows.push(row = { baseline: item.baselineOffset, angle: item.angle, items: [] });
    row.items.push(item);
  }
  let lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.along - b.along);
    let segment = [];
    for (const item of row.items) {
      const previous = segment.at(-1);
      const previousWidth = previous && (Math.abs(Math.cos(previous.angle)) * previous.width + Math.abs(Math.sin(previous.angle)) * previous.height);
      if (previous && item.along - previous.along - previousWidth > Math.max(18 * pageScale, item.fontHeight * 2.2)) {
        lines.push(mergeItems(segment)); segment = [];
      }
      segment.push(item);
    }
    if (segment.length) lines.push(mergeItems(segment));
  }
  lines = attachScriptFragments(lines, pageScale);
  if (!lines.length) return { lines: [], excludedLines: [], allLines: [], orientation: { angle: 0, support: 0, lineCount: 0 } };
  let structures = { rules: [] };
  if (page.getOperatorList && pdfjsLib) {
    if (!pageStructures.has(page)) pageStructures.set(page, page.getOperatorList().catch(() => null));
    const operators = await pageStructures.get(page);
    if (operators) structures = extractDrawingStructures(operators, pdfjsLib.OPS, viewport);
  }
  const reading = buildReadingUnits({ items, baselineLines: lines, structures, viewport });
  lines = reading.units;
  const layout = classifyReadingLines(lines, viewport);
  const dominant = layout.orientation.angle;
  // Run layout heuristics in point units and in the main text's reading frame.
  // The same page must keep its line membership and order at every zoom/rotation.
  const ordered = orderReadingLines(layout.lines.map(line => ({ line, ...readingFrameRect(line, dominant, pageScale),
    regionId:line.regionId, regionPath:line.regionPath, flowId:line.flowId, readingOrder:line.readingOrder,
    regionBounds:line.regionBounds?Object.fromEntries(Object.entries(line.regionBounds).map(([key,value])=>[key,value/pageScale])):undefined })));
  const readingLines = ordered.map(({ line }, index) => ({ ...line, id: `${page.pageNumber}-${index}`, readingRole: 'body' }));
  const excludedLines = layout.excludedLines.map((line, index) => ({ ...line,
    id: `${page.pageNumber}-margin-${index}`, readingRole: 'margin', exclusionReason: 'isolated-perpendicular-margin' }));
  excludedLines.push(...reading.excludedUnits.map((line,index)=>({...line,id:`${page.pageNumber}-${line.readingRole}-${index}`})));
  return { lines: readingLines, excludedLines, allLines: [...readingLines, ...excludedLines], orientation: layout.orientation,
    rawLines: reading.rawLines, components: reading.components, regions: reading.regions, figureRegions:reading.figureRegions,
    tableRegions:reading.tableRegions,excludedRegions:reading.excludedRegions,structures };
}

// Existing callers receive only the navigable reading path. Selection and
// explicit excluded-span hit testing should use extractReadingLayout instead.
export async function extractLines(page, viewport) {
  return (await extractReadingLayout(page, viewport)).lines;
}

function colorComponents(hex = '#F5CB5C') {
  if (!/^#[\da-f]{6}$/i.test(hex)) hex = '#F5CB5C';
  return [1, 3, 5].map(n => parseInt(hex.slice(n, n + 2), 16) / 255);
}
const number = value => Number(value.toFixed(4));
const union = rects => [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])),
  Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];

function quadForRect(r, rotation = 0) {
  const [x1, y1, x2, y2] = r;
  switch (((rotation % 360) + 360) % 360) {
    case 0: return [x1, y2, x2, y2, x1, y1, x2, y1];
    case 90: return [x1, y1, x1, y2, x2, y1, x2, y2];
    case 180: return [x2, y1, x1, y1, x2, y2, x1, y2];
    case 270: return [x2, y2, x2, y1, x1, y2, x1, y1];
    default: throw new Error('标注旋转角度无效');
  }
}

function makeAppearance(context, type, rects, bounds, color, rotation) {
  const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
  const rgb = color.map(number).join(' ');
  const commands = ['q', '/GS0 gs', `${rgb} rg`, `${rgb} RG`];
  if (type === 'comment') {
    commands.push('0 0 18 18 re f', '0.27 0.23 0.15 RG', '0.8 w',
      '4 6 m 14 6 l S', '4 9 m 14 9 l S', '4 12 m 11 12 l S');
  } else {
    for (const r of rects) {
      const x = number(r[0] - bounds[0]), y = number(r[1] - bounds[1]);
      const w = number(r[2] - r[0]), h = number(r[3] - r[1]);
      if (type === 'highlight') commands.push(`${x} ${y} ${w} ${h} re`);
      else {
        // Underline the bottom of the selection as the reader saw it, including
        // pages whose /Rotate makes PDF x/y differ from screen horizontal/vertical.
        const q = quadForRect(r, rotation);
        const height = Math.hypot(q[0] - q[4], q[1] - q[5]);
        const metrics = underlineMetrics(height);
        const inset = metrics.inset / height;
        const dx = (q[0] - q[4]) * inset, dy = (q[1] - q[5]) * inset;
        const x1 = number(q[4] + dx - bounds[0]), y1 = number(q[5] + dy - bounds[1]);
        const x2 = number(q[6] + dx - bounds[0]), y2 = number(q[7] + dy - bounds[1]);
        commands.push(`${number(metrics.thickness)} w`,
          `${x1} ${y1} m ${x2} ${y2} l S`);
      }
    }
    // One annotation is one transparency operation, regardless of how many
    // source Range rectangles its selection originally produced.
    if (type === 'highlight') commands.push('f');
  }
  commands.push('Q');
  return context.register(context.flateStream(commands.join('\n'), {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, width, height], Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: type === 'highlight' ? HIGHLIGHT_OPACITY : 1,
      CA: 1, BM: type === 'highlight' ? 'Multiply' : 'Normal' } } },
  }));
}

/** Export standard, editable annotations with explicit appearance streams.
 * @param {Uint8Array|ArrayBuffer} originalBytes Original imported PDF, never a previous export.
 * @param {Array<{id:string,pageIndex:number,type:string,rects:number[][],rotation?:number,comment?:string,color?:string,text?:string}>} annotations
 */
export async function exportAnnotatedPdf(originalBytes, annotations) {
  let document;
  try { document = await PDFDocument.load(originalBytes, { updateMetadata: false }); }
  catch (error) {
    if (/encrypt/i.test(error.message)) throw new Error('此 PDF 已加密。请先保存一份未加密的副本，再导出标注。');
    throw error;
  }
  const pages = document.getPages(), context = document.context;
  const stamp = PDFString.fromDate(new Date());
  const usedIds = new Set();
  for (const annotation of annotations) {
    if (!['highlight', 'underline', 'comment'].includes(annotation.type)) throw new Error('未知标注类型');
    if (!Number.isInteger(annotation.pageIndex) || !pages[annotation.pageIndex]) throw new Error('标注页码无效');
    if (!annotation.id || usedIds.has(annotation.id)) throw new Error('标注 ID 重复或缺失');
    usedIds.add(annotation.id);
    const page = pages[annotation.pageIndex];
    const rotation = annotation.rotation ?? 0;
    const canonicalize = annotation.type === 'underline' ? underlinePdfRects : canonicalizePdfRects;
    const rects = canonicalize((annotation.rects || []).map(normalRect), rotation);
    if (!rects.length) throw new Error('标注缺少选区');
    const bounds = annotation.type === 'comment'
      ? [rects[0][0], rects[0][3] - 18, rects[0][0] + 18, rects[0][3]] : union(rects);
    const color = colorComponents(annotation.color ?? (annotation.type === 'underline' ? '#000000' : undefined));
    const quads = rects.flatMap(r => quadForRect(r, rotation));
    const appearance = makeAppearance(context, annotation.type, rects, bounds, color, rotation);
    const name = `linea:${annotation.id}`;
    const dictionary = context.obj({
      Type: 'Annot', Subtype: { highlight: 'Highlight', underline: 'Underline', comment: 'Text' }[annotation.type],
      Rect: bounds, P: page.ref, F: 4, C: color,
      NM: PDFHexString.fromText(name), T: PDFHexString.fromText(annotation.author || 'ADHD Reader'),
      Contents: PDFHexString.fromText(annotation.comment || ''),
      M: stamp, CreationDate: stamp,
      AP: { N: appearance },
    });
    if (annotation.type === 'comment') {
      dictionary.set(PDFName.of('Name'), PDFName.of('Comment'));
      dictionary.set(PDFName.of('Open'), context.obj(false));
    } else {
      dictionary.set(PDFName.of('QuadPoints'), context.obj(quads));
      dictionary.set(PDFName.of('CA'), context.obj(annotation.type === 'highlight' ? HIGHLIGHT_OPACITY : 1));
    }
    const ref = context.register(dictionary);
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) { annots = context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
    // Updating a known ID is deterministic, including when a previously exported file is reimported.
    for (let index = annots.size() - 1; index >= 0; index--) {
      const old = context.lookup(annots.get(index));
      if (!(old instanceof PDFDict)) continue;
      const oldName = old.lookupMaybe(PDFName.of('NM'), PDFHexString, PDFString)?.decodeText();
      if (oldName === name) annots.remove(index);
    }
    annots.push(ref);
  }
  return document.save({ useObjectStreams: true });
}
