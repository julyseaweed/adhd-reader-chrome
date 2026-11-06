import './check-release.mjs';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url)), folder = path.join(root, 'extension');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json')));
const table = Uint32Array.from({ length: 256 }, (_, number) => { let value = number; for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
const files = [];
async function visit(directory, prefix = '') { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
  const name = prefix + entry.name, file = path.join(directory, entry.name);
  if (entry.isDirectory()) await visit(file, name + '/'); else files.push({ name, bytes: await readFile(file) });
} }
await visit(folder);
const chunks = [], central = []; let offset = 0;
for (const { name, bytes } of files) {
  const filename = Buffer.from(name), data = deflateRawSync(bytes, { level: 9 }), crc = crc32(bytes);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
  const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
  chunks.push(local, filename, data); central.push(header, filename); offset += local.length + filename.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, directory, end]), name = 'ADHD-Reader-Chrome.zip', artifacts = path.join(root, 'release-artifacts');
await mkdir(artifacts, { recursive: true }); await writeFile(path.join(artifacts, name), zip);
const hash = createHash('sha256').update(zip).digest('hex'); await writeFile(path.join(artifacts, 'SHA256SUMS'), `${hash}  ${name}\n`);
console.log(`Packaged release-artifacts/${name} (version ${version}, ${zip.length} bytes).`);
