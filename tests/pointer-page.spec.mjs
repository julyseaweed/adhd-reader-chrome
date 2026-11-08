import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const url = process.env.LINEA_TEST_URL || 'http://127.0.0.1:4173';
const executablePath = process.env.LINEA_CHROME || process.env.CHROME_EXECUTABLE;
test.use({ browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1060 },
  reducedMotion: 'reduce', launchOptions: executablePath ? { executablePath } : {} });
test.setTimeout(60000);

async function fixture() {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const page = document.addPage([612, 792]);
    for (let row = 0; row < 7; row++) page.drawText(`Page ${index + 1} row ${row + 1}: A separate reading choice.`,
      { x: 50, y: 720 - row * 18, font, size: 12 });
  }
  return Buffer.from(await document.save());
}

async function settle(page) {
  await page.locator('#scroll-area').evaluate(area => new Promise(resolve => {
    let previous = area.scrollTop, stable = 0;
    const frame = () => { const value = area.scrollTop; stable = Math.abs(value - previous) < .05 ? stable + 1 : 0; previous = value;
      if (stable >= 4) resolve(); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }));
}

async function assertRow(page, row) {
  await expect.poll(() => page.locator('.pdf-page[data-page-index="1"]').evaluate((sheet, row) => {
    const box = sheet.getBoundingClientRect(), guide = sheet.querySelector('.line-outline').getBoundingClientRect();
    const scale = box.width / 612, x = box.left + 70 * scale, y = box.top + (792 - (720 - row * 18) - 3.6) * scale;
    return guide.width > 0 && x >= guide.left && x <= guide.right && y >= guide.top && y <= guide.bottom;
  }, row)).toBe(true);
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('#line-position')).toHaveText(`${row + 1} / 7 行`);
}

for (const defer of [false, true]) test(`text clicks keep their source page when two pages share the viewport (${defer ? 'frame before deferred click' : 'native scheduling'})`, async ({ page }) => {
  if (defer) await page.addInitScript(() => {
    // Both timer-before-frame and frame-before-timer are legal browser orders.
    // Exercise the latter explicitly without accessing application state.
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => window.deferClickTimer && delay === 0
      ? timeout(callback, 45, ...args) : timeout(callback, delay, ...args);
  });
  await page.goto(url);
  await page.locator('#file-input').setInputFiles({ name: 'pointer-pages.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  await expect(page.locator('#busy')).toBeHidden();
  const second = page.locator('.pdf-page[data-page-index="1"]');
  await expect(second).toHaveAttribute('data-ready', 'true');
  // The viewport's browsing cursor remains on page one, while page two's text
  // is comfortably visible below it. A click is an explicit reading decision.
  await second.evaluate(sheet => {
    const area = document.querySelector('#scroll-area');
    area.scrollTop += sheet.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientHeight * .45;
  });
  await settle(page);
  await expect(page.locator('#page-number')).toHaveValue('1');
  const point = row => second.evaluate((sheet, row) => {
    const box = sheet.getBoundingClientRect(), scale = box.width / 612;
    return { x: box.left + 90 * scale, y: box.top + (792 - (720 - row * 18) - 3.6) * scale };
  }, row);
  const first = await point(0); await page.mouse.click(first.x, first.y); await assertRow(page, 0);
  if (defer) await page.evaluate(() => { window.deferClickTimer = true; });
  for (const row of [5, 1, 6, 2, 5, 0]) {
    const position = await point(row); await page.mouse.click(position.x, position.y);
    await assertRow(page, row);
  }
});
