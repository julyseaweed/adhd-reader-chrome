import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const names = (await readdir(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
names.push('integrations/chrome/chrome.test.mjs');
const child = spawn(process.execPath, ['--test', ...names], { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
