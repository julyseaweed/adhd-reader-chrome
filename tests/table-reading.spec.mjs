import { test, expect } from '@playwright/test';
import { PDFDocument, PDFDict, PDFName, degrees } from 'pdf-lib';
import fs from 'node:fs/promises';
import { buildTableFixture } from './table-fixture.mjs';
import { loadPDF } from '../src/pdf-engine.js';

const appURL = process.env.LINEA_TEST_URL || 'http://127.0.0.1:4173';
test.use({ browserName: 'chromium', headless: true, viewport: { width: 1320, height: 1040 }, deviceScaleFactor: 2,
  reducedMotion: 'reduce', launchOptions: { executablePath: process.env.LINEA_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
test.setTimeout(90000);
let fixture;
async function open(page, index, rotation = 0) {
  fixture ||= await buildTableFixture();
  const source = await PDFDocument.load(fixture.bytes), doc = await PDFDocument.create();
  const [sheet] = await doc.copyPages(source, [index]); if (rotation) sheet.setRotation(degrees(rotation)); doc.addPage(sheet);
  await page.goto(appURL);
  await page.locator('#file-input').setInputFiles({ name: 'table-reading.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await ready(page); return fixture.cases[index];
}
async function ready(page) {
  await expect(page.locator('#busy')).toBeHidden(); await expect(page.locator('#page-wrap')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#document-pages')).not.toHaveCSS('pointer-events', 'none');
}
const span = (page, text) => page.locator('#text-layer span').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
async function click(page, item) { await span(page, item.text).click(); await page.locator('#scroll-area').focus(); }
async function snapshot(page, item, rotation = 0) {
  return page.evaluate(({ item, rotation }) => {
    const page = document.querySelector('#page-wrap').getBoundingClientRect(), outline = document.querySelector('#line-outline'), box = outline.getBoundingClientRect();
    const scale = page.width / (rotation % 180 ? item.height : item.width);
    const projected = point => {
      const { x, y } = point;
      const [u, v] = rotation === 90 ? [y, x] : rotation === 180 ? [item.width - x, y]
        : rotation === 270 ? [item.height - y, item.width - x] : [x, item.height - y];
      return { x: page.left + u * scale, y: page.top + v * scale };
    };
    const contains = point => { const p = projected(point); return !outline.hidden && p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom; };
    const points = line => line.points || [{ x: line.x + Math.min(line.width * .35, 25), y: line.y + line.size * .3 }];
    return {
      contained: item.order.filter(line => points(line).every(contains)).map(line => line.text),
      cells: item.cells.filter(line => points(line).some(contains)).map(line => line.text),
      counter: document.querySelector('#line-position').textContent,
      guide: { x: (box.left - page.left) / scale, y: (box.top - page.top) / scale, width: box.width / scale, height: box.height / scale },
    };
  }, { item, rotation });
}
async function expectRow(page, item, index, rotation = 0) {
  await expect.poll(async () => (await snapshot(page, item, rotation)).contained).toEqual([item.order[index].text]);
  const actual = await snapshot(page, item, rotation); expect(actual.cells).toEqual([]); return actual;
}
async function capture(page, info, name, value) {
  await fs.mkdir(info.outputDir, { recursive: true });
  await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css' });
  await fs.writeFile(info.outputPath(`${name}.json`), JSON.stringify(value, null, 2));
}
async function seedOldCellAnchor(page, sourceIndex, text = 'Augmented', pageIndex = 0) {
  await page.locator('#home').click(); await expect(page.locator('.recent-row').first()).toBeVisible();
  await page.evaluate(({ sourceIndex, text, pageIndex }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('linea', 2); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('documents', 'readwrite'), store = tx.objectStore('documents'), records = store.getAll();
      records.onsuccess = () => { const record = records.result.sort((a, b) => b.updated - a.updated)[0]; record.pageIndex = pageIndex; record.lineIndex = 5;
        record.lineAnchor = { pageIndex, lineIndex: 5, items: [{ index: sourceIndex }], text }; store.put(record); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }), { sourceIndex, text, pageIndex });
  await page.locator('.recent-row').first().click(); await ready(page);
  await expect(page.locator('#line-outline')).toBeHidden();
}
async function cellSourceIndex(index, text) {
  fixture ||= await buildTableFixture(); const doc = await loadPDF(fixture.bytes);
  try { const content = await (await doc.getPage(index + 1)).getTextContent(); return content.items.findIndex(item => item.str === text); }
  finally { await doc.destroy(); }
}
async function walk(page, item, info, rotation = 0) {
  await click(page, item.order[0]); const observations = [];
  for (const direction of [1, -1]) {
    const indices = item.order.map((_, index) => index); if (direction < 0) indices.reverse();
    for (const [step, index] of indices.entries()) {
      const actual = await snapshot(page, item, rotation); observations.push({ direction, index, actual });
      if (actual.contained.join('|') !== item.order[index].text || actual.cells.length) await capture(page, info, 'first-order-failure', observations);
      await expectRow(page, item, index, rotation);
      if (step + 1 < indices.length) { await page.keyboard.press(direction > 0 ? 'ArrowDown' : 'ArrowUp'); await expect(page.locator('#line-position')).not.toHaveText(actual.counter); }
    }
  }
  expect((await snapshot(page, item, rotation)).counter).toMatch(new RegExp(`^1 / ${item.order.length}`));
  return observations;
}

for (const [index, name] of [[0, 'bordered'], [1, 'three-rule'], [2, 'borderless plain-text values'], [3, 'table inside a two-column article'], [8, 'boxed table with notes inside the border']]) {
  test(`${name}: keys skip cells while retaining captions, notes and column order`, async ({ page }, info) => {
    const item = await open(page, index); const observations = await walk(page, item, info);
    const captionIndex = item.order.findIndex(line => /Table|Collection overview/.test(line.text));
    // Excluded geometry must not swallow the middle/end of a retained caption
    // or a note, even when an outer table border surrounds those sentences.
    for (const retained of [captionIndex, captionIndex + 1, captionIndex + 2]) {
      const target = span(page, item.order[retained].text);
      for (const fraction of [.08, .5, .92]) {
        await click(page, item.order[0]);
        const b = await target.boundingBox();
        await target.click({ position: { x: b.width * fraction, y: b.height * .45 } });
        await expectRow(page, item, retained);
      }
    }
    await click(page, item.order[captionIndex]); const previous = await expectRow(page, item, captionIndex);
    for (const cell of [item.cells[0], item.cells.at(-1)]) { await span(page, cell.text).click(); expect((await snapshot(page, item)).guide).toEqual(previous.guide); }
    const point = await page.locator('#page-wrap').evaluate((node, item) => { const b = node.getBoundingClientRect(), scale = b.width / item.width; return { x: b.left + item.blankPoint.x * scale, y: b.top + (item.height - item.blankPoint.y) * scale }; }, item);
    await page.mouse.click(point.x, point.y); expect((await snapshot(page, item)).guide).toEqual(previous.guide);
    await page.keyboard.press('ArrowDown'); await expectRow(page, item, captionIndex + 1);
    await page.locator('#zoom-out').click(); await ready(page); await click(page, item.order[captionIndex]); await expectRow(page, item, captionIndex);
    await page.keyboard.press('ArrowDown'); await expectRow(page, item, captionIndex + 1);
    await page.keyboard.press('ArrowUp'); await expectRow(page, item, captionIndex);
    await capture(page, info, 'table-caption-and-cells', { observations, final: await snapshot(page, item) });
  });
}

test('table text remains natively selectable, highlightable and exportable without moving the guide', async ({ page }, info) => {
  const item = await open(page, 0); await click(page, item.order[2]); const original = await expectRow(page, item, 2);
  await span(page, 'Augmented').dblclick(); await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe('Augmented');
  await expect(page.locator('#selection-menu')).toBeVisible(); expect((await snapshot(page, item)).guide).toEqual(original.guide);
  await page.locator('#selection-menu [data-action="highlight"]').click(); await expect(page.locator('.annotation-group.highlight')).toHaveCount(1);
  expect((await snapshot(page, item)).guide).toEqual(original.guide);
  const downloaded = page.waitForEvent('download'); await page.locator('#save').click(); const download = await downloaded;
  const output = info.outputPath('table-highlight.pdf'); await download.saveAs(output);
  const saved = await PDFDocument.load(await fs.readFile(output)), annots = saved.getPage(0).node.Annots();
  expect(annots.size()).toBe(1); expect(annots.lookup(0, PDFDict).get(PDFName.of('Subtype')).toString()).toBe('/Highlight');
  await capture(page, info, 'editable-table-text', { selected: 'Augmented', focus: await snapshot(page, item), exportedAnnotations: annots.size() });
});

for (const [index, name] of [[4, 'two genuine prose columns'], [5, 'a bracketed matrix']]) {
  test(`${name} stays in the reading sequence`, async ({ page }, info) => {
    const item = await open(page, index); const observations = await walk(page, item, info);
    await capture(page, info, 'negative-preserved', observations);
  });
}

test('rotating a three-rule table retains the same caption and note navigation', async ({ page }, info) => {
  const item = await open(page, 1, 90); const observations = await walk(page, item, info, 90);
  await capture(page, info, 'rotated-table', observations);
});

test('a table-only page keeps selectable text without an OCR warning and keys skip it in either direction', async ({ page }, info) => {
  fixture ||= await buildTableFixture();
  const source = await PDFDocument.load(fixture.bytes), doc = await PDFDocument.create();
  for (const sheet of await doc.copyPages(source, [5, 6, 7])) doc.addPage(sheet);
  await page.goto(appURL);
  await page.locator('#file-input').setInputFiles({ name: 'table-only-middle.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }); await ready(page);
  await click(page, fixture.cases[5].order.at(-1));
  await page.keyboard.press('ArrowDown'); await expect(page.locator('#page-number')).toHaveValue('3'); await ready(page);
  await expectRow(page, fixture.cases[7], 0);
  await page.keyboard.press('ArrowUp'); await expect(page.locator('#page-number')).toHaveValue('1'); await ready(page);
  await expectRow(page, fixture.cases[5], 2);
  await page.locator('#page-number').fill('2'); await page.locator('#page-number').press('Enter'); await ready(page);
  await expect(page.locator('#page-message')).toBeHidden(); await expect(page.locator('#line-outline')).toBeHidden();
  const cell = await span(page, 'Augmented').boundingBox();
  await page.mouse.move(cell.x + .1, cell.y + cell.height / 2); await page.mouse.down();
  await page.mouse.move(cell.x + cell.width - .1, cell.y + cell.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe('Augmented'); await expect(page.locator('#selection-menu')).toBeVisible();
  await capture(page, info, 'table-only-selectable-without-ocr', { text: await page.evaluate(() => getSelection().toString()) });
  await page.keyboard.press('Escape'); await page.locator('#scroll-area').focus(); await page.keyboard.press('ArrowDown');
  await expect(page.locator('#page-number')).toHaveValue('3'); await ready(page); await expectRow(page, fixture.cases[7], 0);
});

test('an old table-cell reading anchor moves only on a reading key to the adjacent caption or note', async ({ page }, info) => {
  const evidence = [];
  for (const [caseIndex, word, caption] of [[0, 'Augmented', 2], [3, 'Birch', 4]]) {
    const item = await open(page, caseIndex), sourceIndex = await cellSourceIndex(caseIndex, word); expect(sourceIndex).toBeGreaterThanOrEqual(0);
    for (const [key, target] of [['ArrowDown', caption + 1], ['ArrowUp', caption]]) {
      await seedOldCellAnchor(page, sourceIndex, word); await expect(page.locator('#page-message')).toBeHidden();
      await page.locator('#zoom-out').click(); await ready(page); await expect(page.locator('#line-outline')).toBeHidden();
      await page.locator('#scroll-area').focus(); await page.keyboard.press(key); await expectRow(page, item, target);
      evidence.push({ caseIndex, key, result: await snapshot(page, item) });
    }
  }
  await capture(page, info, 'known-old-table-anchor', evidence);
});

test('an old table-only-page source anchor skips to neighboring pages on explicit reading keys', async ({ page }, info) => {
  fixture ||= await buildTableFixture(); const source = await PDFDocument.load(fixture.bytes), doc = await PDFDocument.create();
  for (const sheet of await doc.copyPages(source, [5, 6, 7])) doc.addPage(sheet);
  await page.goto(appURL); await page.locator('#file-input').setInputFiles({ name: 'old-table-only.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }); await ready(page);
  const sourceIndex = await cellSourceIndex(6, 'Augmented'); expect(sourceIndex).toBeGreaterThanOrEqual(0);
  for (const [key, targetPage, targetCase, targetRow] of [['ArrowDown', 3, 7, 0], ['ArrowUp', 1, 5, 2]]) {
    await seedOldCellAnchor(page, sourceIndex, 'Augmented', 1); await expect(page.locator('#page-number')).toHaveValue('2');
    await page.locator('#scroll-area').focus(); await page.keyboard.press(key); await expect(page.locator('#page-number')).toHaveValue(String(targetPage)); await ready(page);
    await expectRow(page, fixture.cases[targetCase], targetRow);
  }
  await capture(page, info, 'old-table-only-anchor-skip', { page: await page.locator('#page-number').inputValue() });
});
