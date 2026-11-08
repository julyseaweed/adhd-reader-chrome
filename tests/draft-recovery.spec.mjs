import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const url = process.env.LINEA_TEST_URL || 'http://127.0.0.1:4173';
const executablePath = process.env.LINEA_CHROME || process.env.CHROME_EXECUTABLE;
test.use({ browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1060 },
  launchOptions: executablePath ? { executablePath } : {} });
test.setTimeout(60000);

async function fixture() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const sheet = pdf.addPage([612, 792]);
    for (let row = 0; row < 10; row++) sheet.drawText(`Original page ${index + 1}, sentence ${row + 1}: A quiet garden beside the river.`,
      { x: 48, y: 720 - row * 24, size: 12, font });
  }
  return Buffer.from(await pdf.save());
}
async function ready(page) {
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#page-wrap')).toHaveAttribute('data-ready', 'true');
}
test.beforeEach(async ({ page }) => {
  // Hold the ordinary debounced commit to expose the reload window reliably.
  // Explicit initial/flush commits and browser IndexedDB remain unmodified.
  await page.addInitScript(() => {
    const original = window.setTimeout;
    window.setTimeout = function (callback, delay, ...args) { return original.call(this, callback, delay === 350 ? 60000 : delay, ...args); };
  });
  await page.goto(url);
  await page.locator('#file-input').setInputFiles({ name: 'draft-recovery.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  await ready(page);
});

test('a first import remains reopenable immediately after the ready state', async ({ page }) => {
  await page.reload();
  await page.locator('.recent-row').filter({ hasText: 'draft-recovery' }).click();
  await ready(page);
  await expect(page.locator('#page-number')).toHaveValue('1');
  await expect(page.locator('#text-layer')).toContainText('Original page 1');
});

test('a new comment and reading line recover on immediate reload before the delayed commit', async ({ page }) => {
  const target = page.locator('#text-layer span').filter({ hasText: 'Original page 1, sentence 2:' }).first();
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
  await page.locator('[data-action="comment"]').click();
  await page.locator('#comment-text').fill('An original recovery note.');
  await page.locator('#comment-save').click();
  await page.locator('#next-page').click(); await ready(page);
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.locator('#scroll-area').focus();
  const previous = await page.locator('#line-position').textContent();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#line-position')).not.toHaveText(previous);
  const position = await page.locator('#line-position').textContent();
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('linea-draft:')))).toBe(true);
  await page.reload();
  await page.locator('.recent-row').filter({ hasText: 'draft-recovery' }).click(); await ready(page);
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('#line-position')).toHaveText(position);
  await page.locator('#notes-toggle').click();
  await expect(page.locator('.note-comment')).toHaveText('An original recovery note.');
});
