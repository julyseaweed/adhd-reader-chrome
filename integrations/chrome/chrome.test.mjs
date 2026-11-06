import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readerTarget, looksLikePDF, normalizeSource, pdfName, hostPattern } from './url-utils.js';
import { fetchPDF, requestAccess } from './bridge.js';

test('toolbar detects normal, query-based and built-in viewer PDFs', () => {
  assert.equal(looksLikePDF('https://example.com/PAPER.PDF?download=1'), true);
  assert.equal(looksLikePDF('https://example.com/export?format=pdf'), true);
  assert.equal(looksLikePDF('https://example.com/download/1', 'paper.pdf'), true);
  assert.equal(looksLikePDF('https://example.com/page'), false);
  assert.equal(normalizeSource('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=https%3A%2F%2Fexample.com%2Fa.pdf').href, 'https://example.com/a.pdf');
});

test('only user-selected supported PDF URLs are passed to reader', () => {
  assert.equal(readerTarget('https://example.com/a.pdf'), '?url=https%3A%2F%2Fexample.com%2Fa.pdf');
  assert.equal(readerTarget('https://example.com/download/1', true), '?url=https%3A%2F%2Fexample.com%2Fdownload%2F1');
  assert.equal(readerTarget('https://example.com/page'), '');
  assert.equal(readerTarget('file:///example/paper.pdf'), '?local=1');
  for (const input of ['javascript:alert(1)', 'data:application/pdf;base64,AAAA', 'https://user:password@example.com/a.pdf', 'chrome://settings']) {
    assert.equal(readerTarget(input, true), '');
  }
});

test('file names and origin scopes are safe and deterministic', () => {
  assert.equal(pdfName('https://example.com/a.pdf'), 'a.pdf');
  assert.equal(pdfName('https://example.com/download', "attachment; filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf"), '论文.pdf');
  assert.equal(pdfName('https://example.com/', 'attachment; filename="../../a.pdf"'), '.._.._a.pdf');
  assert.equal(pdfName('https://example.com/download'), 'document.pdf');
  assert.equal(hostPattern(new URL('https://example.com:8443/a.pdf')), 'https://example.com/*');
});

test('manifest keeps website access optional and all executable resources local', async () => {
  const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'contextMenus']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /blob:/);
});

test('bridge validates PDF bytes and requests just the selected origin', async (t) => {
  let requested;
  t.mock.method(globalThis, 'fetch', async () => new Response('%PDF-1.7\n%example', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="paper.pdf"' } }));
  globalThis.chrome = { permissions: {
    request: async (value) => { requested = value; return true; },
    contains: async () => false,
  } };
  t.after(() => { delete globalThis.chrome; });
  assert.equal(await requestAccess('https://example.com/a.pdf'), true);
  assert.deepEqual(requested, { origins: ['https://example.com/*'] });
  const pdf = await fetchPDF('https://example.com/a.pdf');
  assert.equal(pdf.name, 'paper.pdf');
  assert.equal(new TextDecoder().decode(pdf.bytes).startsWith('%PDF-'), true);
  globalThis.fetch = async () => new Response('<html>Log in</html>');
  await assert.rejects(fetchPDF('https://example.com/a.pdf'), { code: 'NOT_PDF' });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(fetchPDF('https://example.com/a.pdf'), { code: 'HOST_PERMISSION_REQUIRED', origin: 'https://example.com/*' });
  chrome.permissions.contains = async () => true;
  await assert.rejects(fetchPDF('https://example.com/a.pdf'), { code: 'FETCH_FAILED' });
  await assert.rejects(fetchPDF('file:///example/a.pdf'), { code: 'LOCAL_FILE' });
});
