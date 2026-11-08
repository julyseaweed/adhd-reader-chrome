import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), dist = path.join(root, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    let file = path.resolve(dist, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (file !== dist && !file.startsWith(dist + path.sep)) throw Error('Outside preview root');
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404).end('Not found'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const args = process.argv.slice(2);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...(args.length ? args : ['tests/table-reading.spec.mjs', 'tests/locked-reading.spec.mjs', 'tests/reading-scroll.spec.mjs', 'tests/figure-navigation.spec.mjs', 'tests/annotation-editing.spec.mjs']), '--workers=1', '--reporter=line'], {
      cwd: root, env: { ...process.env, LINEA_TEST_URL: `http://127.0.0.1:${server.address().port}` }, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
