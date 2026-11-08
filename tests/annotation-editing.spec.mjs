import { test, expect } from '@playwright/test';
import { PDFDocument, PDFArray, PDFDict, PDFName } from 'pdf-lib';
import fs from 'node:fs/promises';
import { buildAnnotationEditingFixture } from './annotation-editing-fixture.mjs';

const appURL = process.env.LINEA_TEST_URL || 'http://127.0.0.1:4173';
const executablePath = process.env.CHROME_EXECUTABLE || process.env.LINEA_CHROME;
test.use({ browserName: 'chromium', headless: true, viewport: { width: 1280, height: 950 }, deviceScaleFactor: 1,
  hasTouch: true, reducedMotion: 'reduce', launchOptions: executablePath ? { executablePath } : {} });
test.setTimeout(90000);

async function ready(page) {
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#page-wrap')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#document-pages')).not.toHaveCSS('pointer-events', 'none');
}
async function importBytes(page, bytes, name = 'annotation-editing.pdf') {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await ready(page);
}
async function open(page, options) {
  const fixture = await buildAnnotationEditingFixture(options);
  await page.goto(appURL); await importBytes(page, fixture.bytes); return fixture;
}
const rowSpan = (page, fixture, row, pageIndex = 0) => page.locator(`.pdf-page[data-page-index="${pageIndex}"] .textLayer span`).filter({ hasText: fixture.pages[pageIndex].rows[row].text }).first();
async function tool(page, key) {
  await page.locator('#scroll-area').focus(); await page.keyboard.press(key);
  const name = { v: 'select', h: 'highlight', u: 'underline', n: 'comment', e: 'erase' }[key];
  await expect(page.locator(`button[data-tool="${name}"]`)).toHaveAttribute('aria-pressed', 'true');
}
async function selectRows(page, fixture, first, last = first) {
  const start = rowSpan(page, fixture, first), end = rowSpan(page, fixture, last);
  await start.scrollIntoViewIfNeeded();
  const a = await start.boundingBox(), b = await end.boundingBox();
  await page.mouse.move(a.x + .5, a.y + a.height * .45); await page.mouse.down();
  await page.mouse.move(b.x + b.width - .5, b.y + b.height * .45, { steps: 16 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() || '')).toContain(fixture.pages[0].rows[first].text.slice(6).trim());
}
async function createDraft(page, fixture, type, first, last = first, comment = '测试评论：值得继续思考。') {
  await tool(page, 'v'); await selectRows(page, fixture, first, last);
  await expect(page.locator('#selection-menu')).toBeVisible(); await page.locator(`[data-action="${type}"]`).click();
  if (type === 'comment') {
    await expect(page.locator('#comment-dialog')).toBeVisible();
    await page.locator('#comment-text').fill(comment); await page.locator('#comment-save').click();
    await expect(page.locator('#comment-dialog')).toBeHidden();
  }
  await expect(page.locator(`.annotation-group.${type}`).last()).toBeAttached();
  return page.locator(`.annotation-group.${type}`).last().locator('.annotation-mark').first().getAttribute('data-annotation-id');
}
const marks = (page, id) => page.locator(`.annotation-mark[data-annotation-id="${id}"]`);
async function markPoint(page, id) {
  const locator = marks(page, id).first(); await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox(); return { x: box.x + Math.min(20, box.width / 2), y: box.y + box.height / 2 };
}
async function authoredPoint(page, fixture, x, y, row = 0) {
  // Native deletion atomically replaces the text layer when the new bitmap is
  // ready. Re-resolve this locator if that harmless replacement lands mid-read.
  await expect(async () => { await rowSpan(page, fixture, row).scrollIntoViewIfNeeded(); }).toPass({ timeout: 5000 });
  return page.locator('.pdf-page[data-page-index="0"]').evaluate((node, point) => {
    const rect = node.getBoundingClientRect(), scale = rect.width / point.width;
    return { x: rect.left + point.x * scale, y: rect.top + (point.height - point.y) * scale };
  }, { x, y, width: fixture.pages[0].width, height: fixture.pages[0].height });
}
async function clickPoint(page, point) { await page.mouse.click(point.x, point.y); }
async function exportPDF(page, info, label) {
  const pending = page.waitForEvent('download'); await page.locator('#save').click();
  const file = info.outputPath(`${label}.pdf`); await (await pending).saveAs(file);
  const bytes = await fs.readFile(file), pdf = await PDFDocument.load(bytes);
  const annotations = pdf.getPages().flatMap((sheet, pageIndex) => {
    const refs = sheet.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return (refs?.asArray() || []).map(ref => {
      const dict = pdf.context.lookup(ref, PDFDict);
      const text = name => { const value = dict.get(PDFName.of(name)); return value?.decodeText?.() || ''; };
      const array = name => dict.lookupMaybe(PDFName.of(name), PDFArray)?.asArray().map(value => value.asNumber()) || [];
      return { pageIndex, type: dict.get(PDFName.of('Subtype'))?.toString().slice(1), name: text('NM'), comment: text('Contents'), color: array('C'), quads: array('QuadPoints') };
    });
  });
  return { bytes, annotations, editable: annotations.filter(a => ['Highlight','Underline','Text'].includes(a.type)) };
}
async function nativePixel(page, fixture) {
  return page.locator('.pdf-page[data-page-index="0"] canvas').evaluate((canvas, point) => {
    const data = canvas.getContext('2d').getImageData(Math.round(point.x / point.width * canvas.width), Math.round((point.height - point.y) / point.height * canvas.height), 1, 1).data;
    return [...data];
  }, { x: 480, y: fixture.pages[0].rows[1].y + 6, width: 612, height: 900 });
}
async function undo(page, redo = false) { await page.locator('#scroll-area').focus(); await page.keyboard.press(redo ? 'Control+Shift+Z' : 'Control+Z'); }
async function chooseMark(page, id) {
  await tool(page, 'v'); await clickPoint(page, await markPoint(page, id));
  await expect(page.locator('#annotation-menu')).toBeVisible();
  await expect(page.locator('#annotation-menu')).toHaveAttribute('data-annotation-id', id);
}
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure.png'), scale: 'css' });
});

test('color belongs only to highlight mode and underline exports black after color changes', async ({ page }, info) => {
  const fixture = await open(page);
  await expect(page.locator('#color')).toBeHidden(); await tool(page, 'h');
  await expect(page.locator('#color')).toBeVisible(); await page.locator('#color').click();
  for (const key of ['u', 'n', 'e', 'v']) { await tool(page, key); await expect(page.locator('#color')).toBeHidden(); }
  const id = await createDraft(page, fixture, 'underline', 3);
  expect(await marks(page, id).first().evaluate(node => getComputedStyle(node, '::after').backgroundColor)).toBe('rgb(0, 0, 0)');
  const saved = await exportPDF(page, info, 'black-underline');
  expect(saved.editable).toHaveLength(1); expect(saved.editable[0].type).toBe('Underline'); expect(saved.editable[0].color).toEqual([0,0,0]);
});

test('erasing one quad deletes the whole draft highlight, preserves siblings, and supports undo redo and reimport', async ({ page }, info) => {
  const fixture = await open(page);
  const highlight = await createDraft(page, fixture, 'highlight', 1, 2);
  const underline = await createDraft(page, fixture, 'underline', 4);
  const comment = await createDraft(page, fixture, 'comment', 6);
  expect(await marks(page, highlight).count()).toBeGreaterThan(1);
  await tool(page, 'e'); await clickPoint(page, await markPoint(page, highlight));
  await expect(marks(page, highlight)).toHaveCount(0); await expect(marks(page, underline)).toHaveCount(1); await expect(marks(page, comment)).toHaveCount(1);
  await undo(page); await expect.poll(() => marks(page, highlight).count()).toBeGreaterThan(1);
  await undo(page, true); await expect(marks(page, highlight)).toHaveCount(0);
  await page.locator('#home').click(); await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('#recent-list button').first().click(); await ready(page);
  const saved = await exportPDF(page, info, 'draft-erased'); expect(saved.editable.map(a => a.type).sort()).toEqual(['Text','Underline']);
  await importBytes(page, saved.bytes, 'draft-erased-reopened.pdf');
  const reopened = await exportPDF(page, info, 'draft-erased-roundtrip'); expect(reopened.editable.map(a => a.type).sort()).toEqual(['Text','Underline']);
  await page.screenshot({ path: info.outputPath('draft-erased-reopened.png'), scale: 'css' });
});

test('a mouse eraser stroke across three draft annotations is one undo operation', async ({ page }) => {
  const fixture = await open(page);
  const ids = [await createDraft(page, fixture, 'highlight', 1), await createDraft(page, fixture, 'underline', 2), await createDraft(page, fixture, 'comment', 3)];
  await tool(page, 'e');
  const points = []; for (const id of ids) points.push(await markPoint(page, id));
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.mouse.up();
  for (const id of ids) await expect(marks(page, id)).toHaveCount(0);
  await undo(page); for (const id of ids) await expect(marks(page, id)).toHaveCount(1);
  await undo(page, true); for (const id of ids) await expect(marks(page, id)).toHaveCount(0);
});

test('selected draft menu edits Chinese comments and menu Delete Backspace share reversible deletion', async ({ page }, info) => {
  const fixture = await open(page), id = await createDraft(page, fixture, 'highlight', 1);
  await chooseMark(page, id); await page.screenshot({ path: info.outputPath('selected-annotation-menu.png'), scale: 'css' }); await page.locator('#annotation-comment').click();
  await page.locator('#comment-text').fill('中文评论：这里的论证需要补充。'); await page.locator('#comment-save').click();
  expect((await exportPDF(page, info, 'edited-comment')).editable[0].comment).toBe('中文评论：这里的论证需要补充。');
  await chooseMark(page, id); await page.locator('#annotation-delete').click(); await expect(marks(page, id)).toHaveCount(0);
  await undo(page); await expect(marks(page, id)).toHaveCount(1);
  for (const key of ['Delete', 'Backspace']) {
    await chooseMark(page, id); await page.keyboard.press(key); await expect(marks(page, id)).toHaveCount(0);
    await undo(page); await expect(marks(page, id)).toHaveCount(1);
  }
});

test('native standard highlight underline and Text erase from canvas and exported PDF without reviving', async ({ page }, info) => {
  const fixture = await open(page, { native: 'standard' });
  await page.screenshot({ path: info.outputPath('native-before-erasing.png'), scale: 'css' });
  const colored = await nativePixel(page, fixture); expect(colored[2]).toBeLessThan(245);
  await tool(page, 'e'); await clickPoint(page, await authoredPoint(page, fixture, 100, fixture.pages[0].rows[1].y + 5, 1));
  await expect.poll(async () => (await nativePixel(page, fixture))[2]).toBeGreaterThan(250);
  await undo(page); await expect.poll(async () => (await nativePixel(page, fixture))[2]).toBeLessThan(245);
  await undo(page, true); await expect.poll(async () => (await nativePixel(page, fixture))[2]).toBeGreaterThan(250);
  await tool(page, 'v'); await clickPoint(page, await authoredPoint(page, fixture, 519, fixture.pages[0].rows[6].y + 6, 6));
  await expect(page.locator('#annotation-menu')).toBeVisible(); await expect(page.locator('#annotation-comment')).toBeHidden();
  await page.keyboard.press('Delete'); await ready(page);
  await tool(page, 'e'); await clickPoint(page, await authoredPoint(page, fixture, 100, fixture.pages[0].rows[4].y + 5, 4));
  const saved = await exportPDF(page, info, 'native-erased'); expect(saved.editable).toEqual([]); expect(saved.annotations.map(a => a.name)).toContain('untouched-link');
  await importBytes(page, saved.bytes, 'native-erased-reopened.pdf');
  expect((await nativePixel(page, fixture))[2]).toBeGreaterThan(250);
  const reopened = await exportPDF(page, info, 'native-erased-roundtrip'); expect(reopened.editable).toEqual([]); expect(reopened.annotations.map(a => a.name)).toContain('untouched-link');
  await page.screenshot({ path: info.outputPath('native-erased-reopened.png'), scale: 'css' });
});

test('one continuous native eraser stroke survives page repaint and undo restores every crossed annotation', async ({ page }, info) => {
  const fixture = await open(page, { native: 'standard' }); await tool(page, 'e');
  const points = [
    await authoredPoint(page, fixture, 100, fixture.pages[0].rows[1].y + 5, 1),
    await authoredPoint(page, fixture, 100, fixture.pages[0].rows[4].y + 5, 4),
    await authoredPoint(page, fixture, 519, fixture.pages[0].rows[6].y + 6, 6),
  ];
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 16 });
  await page.mouse.up();
  expect((await exportPDF(page, info, 'native-stroke-erased')).editable).toHaveLength(0);
  await undo(page);
  const restored = await exportPDF(page, info, 'native-stroke-undo'); expect(restored.editable.map(a => a.name).sort()).toEqual(['native-comment','native-highlight','native-underline']);
  await undo(page, true); expect((await exportPDF(page, info, 'native-stroke-redo')).editable).toHaveLength(0);
});

test('one eraser click deletes only one overlapping native annotation', async ({ page }, info) => {
  const fixture = await open(page, { native: 'overlap' });
  await tool(page, 'e'); await clickPoint(page, await authoredPoint(page, fixture, 100, fixture.pages[0].rows[8].y + 5, 8));
  const once = await exportPDF(page, info, 'overlap-once'); expect(once.editable).toHaveLength(1);
  expect(['overlap-first','overlap-second']).toContain(once.editable[0].name);
  await tool(page, 'e'); await clickPoint(page, await authoredPoint(page, fixture, 100, fixture.pages[0].rows[8].y + 5, 8));
  expect((await exportPDF(page, info, 'overlap-twice')).editable).toHaveLength(0);
  await undo(page); expect((await exportPDF(page, info, 'overlap-undo-one')).editable).toHaveLength(1);
  await undo(page); expect((await exportPDF(page, info, 'overlap-undo-two')).editable).toHaveLength(2);
});

test('native highlighted text and draft overlays retain native text dragging', async ({ page }) => {
  const fixture = await open(page, { native: 'standard' });
  await tool(page, 'v'); await selectRows(page, fixture, 1, 2);
  await expect(page.locator('#selection-menu')).toBeVisible(); await expect(page.locator('#annotation-menu')).toBeHidden();
  await page.locator('[data-action="highlight"]').click();
  const id = await page.locator('.annotation-mark.highlight').first().getAttribute('data-annotation-id');
  await tool(page, 'v'); await selectRows(page, fixture, 1, 2);
  await expect(page.locator('#selection-menu')).toBeVisible(); await expect(page.locator('#annotation-menu')).toBeHidden();
  await page.keyboard.press('Escape'); await chooseMark(page, id);
  expect(await page.locator('.annotation-selection').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).pointerEvents))).toEqual(['none','none']);
});

test('zoom preserves exact annotation hit targets and switching documents clears stale selected annotations', async ({ page }, info) => {
  const fixture = await open(page), id = await createDraft(page, fixture, 'highlight', 1);
  await chooseMark(page, id); const width = await page.locator('#pdf-canvas').evaluate(node => node.width);
  await page.locator('#zoom-in').click(); await expect.poll(() => page.locator('#pdf-canvas').evaluate(node => node.width)).toBeGreaterThan(width); await ready(page);
  await chooseMark(page, id); await page.keyboard.press('Delete'); await expect(marks(page, id)).toHaveCount(0);
  await undo(page); await chooseMark(page, id);
  const second = await buildAnnotationEditingFixture({ native: 'standard', title: 'A different annotation document' });
  await importBytes(page, second.bytes, 'different-document.pdf');
  await expect(page.locator('#annotation-menu')).toBeHidden(); await expect(page.locator('.annotation-selection')).toHaveCount(0);
  await page.locator('#scroll-area').focus(); await page.keyboard.press('Delete'); await page.keyboard.press('Backspace');
  const saved = await exportPDF(page, info, 'different-document-intact'); expect(saved.editable).toHaveLength(3);
});

test('touch panning from an annotation does not erase it but a touch tap erases one', async ({ page, context }, info) => {
  const fixture = await open(page, { native: 'standard' }); await tool(page, 'e');
  const point = await authoredPoint(page, fixture, 100, fixture.pages[0].rows[1].y + 5, 1);
  const before = await page.locator('#scroll-area').evaluate(node => node.scrollTop);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - step * 18, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.locator('#scroll-area').evaluate(node => node.scrollTop)).toBeGreaterThan(before + 40);
  expect((await exportPDF(page, info, 'touch-pan-preserved')).editable).toHaveLength(3);
  await tool(page, 'e'); const tap = await authoredPoint(page, fixture, 100, fixture.pages[0].rows[1].y + 5, 1);
  await page.touchscreen.tap(tap.x, tap.y);
  await expect.poll(async () => (await nativePixel(page, fixture))[2]).toBeGreaterThan(250);
  const saved = await exportPDF(page, info, 'touch-tap-erased'); expect(saved.editable.map(a => a.type).sort()).toEqual(['Text','Underline']);
});

test('delayed native annotation repaint preserves the live text layer and a newly dragged selection', async ({ page }, info) => {
  await page.addInitScript(() => {
    const schedule = window.requestAnimationFrame.bind(window);
    window.__annotationPaintGate = { armed: false, held: null };
    window.requestAnimationFrame = callback => {
      // Delay only the pinned PDF.js raster continuation, never UI/input frames.
      // This models a slow raster without introducing a product testing hook.
      const gate = window.__annotationPaintGate;
      if (gate.armed && String(callback).includes('_nextBound')) {
        gate.armed = false; gate.held = callback;
        return schedule(() => {});
      }
      return schedule(callback);
    };
    window.__releaseAnnotationPaint = () => {
      const gate = window.__annotationPaintGate, callback = gate.held;
      gate.held = null; if (callback) schedule(callback);
    };
  });
  const fixture = await open(page, { native: 'standard' });
  await expect(page.locator('.pdf-page[data-ready="true"]')).toHaveCount(2);
  await tool(page, 'e');
  const point = await authoredPoint(page, fixture, 100, fixture.pages[0].rows[1].y + 5, 1);
  await page.evaluate(() => {
    window.__preservedTextLayer = document.querySelector('.pdf-page[data-page-index="0"] .textLayer');
    window.__preservedTextSpan = window.__preservedTextLayer.querySelector('span');
    window.__annotationPaintGate.armed = true;
  });
  await clickPoint(page, point);
  await expect.poll(() => page.evaluate(() => Boolean(window.__annotationPaintGate.held))).toBe(true);
  expect((await nativePixel(page, fixture))[2], 'the old bitmap remains while raster is pending').toBeLessThan(245);
  await tool(page, 'v'); await selectRows(page, fixture, 3);
  await expect(page.locator('#selection-menu')).toBeVisible();
  const selected = await page.evaluate(() => getSelection().toString());
  await page.evaluate(() => window.__releaseAnnotationPaint());
  await expect.poll(async () => (await nativePixel(page, fixture))[2]).toBeGreaterThan(250);
  const result = await page.evaluate(() => {
    const layer = document.querySelector('.pdf-page[data-page-index="0"] .textLayer');
    return { sameLayer: layer === window.__preservedTextLayer, sameSpan: layer.querySelector('span') === window.__preservedTextSpan,
      connected: window.__preservedTextSpan.isConnected, selected: getSelection().toString(), anchorInLayer: layer.contains(getSelection().anchorNode) };
  });
  expect(result).toEqual({ sameLayer: true, sameSpan: true, connected: true, selected, anchorInLayer: true });
  await expect(page.locator('#selection-menu')).toBeVisible();
  await page.screenshot({ path: info.outputPath('selection-after-annotation-repaint.png'), scale: 'css' });
  await fs.writeFile(info.outputPath('selection-after-annotation-repaint.json'), JSON.stringify(result, null, 2));
  const saved = await exportPDF(page, info, 'annotation-repaint-selection');
  expect(saved.editable.map(a => a.name).sort()).toEqual(['native-comment','native-underline']);
});

test('a failed annotation-only raster keeps old content and retries its dirty revision on normal scrolling', async ({ page }, info) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    window.__failNextAnnotationRaster = false; window.__annotationRasterFailures = 0;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (kind === '2d' && window.__failNextAnnotationRaster && this.classList.contains('pdf-canvas') && !this.isConnected) {
        window.__failNextAnnotationRaster = false; window.__annotationRasterFailures++;
        const shown = document.querySelector('.pdf-page[data-page-index="0"] canvas');
        const context = getContext.call(shown, '2d');
        window.__bitmapAtRasterFailure = [...context.getImageData(Math.round(480 / 612 * shown.width), Math.round((900 - 758) / 900 * shown.height), 1, 1).data];
        throw new Error('Synthetic one-shot annotation raster failure');
      }
      return getContext.call(this, kind, ...args);
    };
  });
  const fixture = await open(page, { native: 'standard' });
  await expect(page.locator('.pdf-page[data-ready="true"]')).toHaveCount(2);
  await tool(page, 'e'); const point = await authoredPoint(page, fixture, 100, fixture.pages[0].rows[1].y + 5, 1);
  await page.evaluate(() => { window.__failNextAnnotationRaster = true; }); await clickPoint(page, point);
  await expect.poll(() => page.evaluate(() => window.__annotationRasterFailures)).toBe(1);
  // A pending visible-page refresh may already have retried by this point.
  // Inspect the bitmap captured synchronously at failure, not its later state.
  expect((await page.evaluate(() => window.__bitmapAtRasterFailure))[2], 'failure keeps the previous complete bitmap').toBeLessThan(245);
  await expect(rowSpan(page, fixture, 3)).toBeVisible();
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 50);
  await expect.poll(async () => (await nativePixel(page, fixture))[2], { message: 'a dirty annotation revision must retry even though its old page is still ready' }).toBeGreaterThan(250);
  expect(await page.evaluate(() => window.__annotationRasterFailures)).toBe(1);
  const saved = await exportPDF(page, info, 'annotation-raster-retried');
  expect(saved.editable.map(a => a.name).sort()).toEqual(['native-comment','native-underline']);
});
