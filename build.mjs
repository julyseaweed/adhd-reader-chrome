import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
async function resetOutput(name) {
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root || (await lstat(target).catch(() => null))?.isSymbolicLink()) throw Error('Unsafe build output');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}
await resetOutput('dist');
await resetOutput('extension');
await mkdir('dist/assets', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', target: 'chrome120', outdir: 'dist/assets', minify: true, sourcemap: false, loader: { '.css': 'css' } });
await copyFile('index.html', 'dist/index.html');
await copyFile('public/icon.svg', 'dist/icon.svg');
await cp('public/dictionary', 'dist/dictionary', { recursive: true });
await mkdir('dist/vendor/licenses', { recursive: true });
await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'dist/vendor/pdf.worker.min.mjs');
for (const name of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${name}`, `dist/vendor/${name}`, { recursive: true });
const licenses = {
  'pdfjs-dist/LICENSE': 'PDFJS-LICENSE', 'pdf-lib/LICENSE.md': 'PDFLIB-LICENSE.md',
  '@pdf-lib/standard-fonts/LICENSE.md': 'pdf-lib-standard-fonts-LICENSE.md', '@pdf-lib/upng/LICENSE': 'pdf-lib-upng-LICENSE',
  'pako/LICENSE': 'pako-LICENSE', 'tslib/LICENSE.txt': 'tslib-LICENSE.txt', 'tslib/CopyrightNotice.txt': 'tslib-CopyrightNotice.txt',
  'iso-639-3/license': 'iso-639-3-LICENSE', 'trigram-utils/license': 'trigram-utils-LICENSE',
  'n-gram/license': 'n-gram-LICENSE', 'collapse-white-space/license': 'collapse-white-space-LICENSE',
};
for (const [source, name] of Object.entries(licenses)) await copyFile(`node_modules/${source}`, `dist/vendor/licenses/${name}`);
await copyFile('vendor-licenses/franc-LICENSE', 'dist/vendor/licenses/franc-LICENSE');
for (const name of ['manifest.json', 'background.js', 'bridge.js', 'url-utils.js']) await copyFile(`integrations/chrome/${name}`, `extension/${name}`);
await cp('integrations/chrome/icons', 'extension/icons', { recursive: true });
await cp('dist', 'extension/reader', { recursive: true });
for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md']) await copyFile(name, `extension/${name}`);
console.log('Built dist/ and extension/. Load extension/ as an unpacked Chrome extension.');
