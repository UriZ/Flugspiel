// npm test entry point. Discovers the test files itself instead of handing a quoted
// glob to `node --test`: that glob is expanded by the runner only on Node >= 21, so on
// an older runtime the suite ran zero tests and exited 0 — a green build testing nothing.
// Discovery is now explicit, and an empty set is a hard failure.

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

async function collect(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await collect(full));
    else if (e.name.endsWith('.test.js')) out.push(path.relative(ROOT, full));
  }
  return out.sort();
}

const files = await collect(path.join(ROOT, 'tests'));
if (files.length === 0) {
  console.error('no *.test.js files found under tests/ — refusing to report a vacuous pass');
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
