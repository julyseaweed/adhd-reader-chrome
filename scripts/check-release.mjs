import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
if (manifest.version !== pkg.version || manifest.manifest_version !== 3) throw Error('Manifest version mismatch');
for (const name of ['background.js', 'bridge.js', 'url-utils.js', 'reader/index.html', 'reader/assets/app.js', 'reader/assets/app.css', 'reader/vendor/pdf.worker.min.mjs', 'reader/vendor/cmaps', 'reader/vendor/standard_fonts', 'reader/vendor/wasm', 'reader/dictionary/index.json', 'reader/dictionary/LICENSE.txt', 'reader/vendor/licenses/PDFJS-LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) await stat(path.join(root, 'extension', name));
let count = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Release must not contain symbolic links');
    if (entry.isDirectory()) await inspect(file);
    else { if (/\.(pdf|log|db|sqlite|map)$/i.test(entry.name) || entry.name.startsWith('.')) throw Error(`Unexpected release file: ${entry.name}`); count++; }
  }
}
await inspect(path.join(root, 'extension'));
console.log(`Release resources verified: ${count} files, version ${pkg.version}.`);
