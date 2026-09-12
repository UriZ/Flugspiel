// T33 — spec #2 §6.2. The machine-checkable form of AC6 ("no changes to core game
// mechanics"): every vendored file must still hash to what upstream 458c3fb shipped,
// and nothing may be added. Offline, no network, no clone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const MANIFEST = new URL('../../src/game/vendor.manifest.json', import.meta.url);
const VENDOR = new URL('../../src/game/vendor/', import.meta.url);

// Added by us for the license grant upstream never shipped (§4.1); it has no hash
// because it does not exist upstream.
const NOT_FROM_UPSTREAM = new Set(['LICENSE']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** @param {URL} dir @returns {Promise<string[]>} paths relative to the vendor root */
async function walk(dir, prefix = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue; // .DS_Store and friends are not vendored content
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...await walk(new URL(`${e.name}/`, dir), `${rel}/`));
    else out.push(rel);
  }
  return out;
}

test('T33 every vendored file matches its manifest hash, and none were added', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  assert.match(manifest.ref, /^[0-9a-f]{40}$/, 'manifest pins a full upstream SHA');
  assert.equal(manifest.source, 'https://github.com/UriZ/missile-attack-aracde-web');

  const expected = Object.keys(manifest.files);
  assert.equal(expected.length, 48, 'upstream src/ is 48 .js files at 458c3fb');

  const mismatched = [];
  for (const rel of expected) {
    const actual = sha256(await readFile(new URL(rel, VENDOR)));
    if (actual !== manifest.files[rel]) mismatched.push(rel);
  }
  assert.deepEqual(mismatched, [], 'vendored files edited since vendoring');

  const onDisk = (await walk(VENDOR)).filter((f) => !NOT_FROM_UPSTREAM.has(f));
  assert.deepEqual(onDisk.sort(), expected.slice().sort(), 'files added to or removed from vendor/');

  // The grant has no manifest entry, so the set-equality check above cannot see it go
  // missing — and tools/vendor-game.sh wipes the tree before every re-vendor.
  const license = await readFile(new URL('LICENSE', VENDOR), 'utf8');
  assert.match(license, /^ISC License/, 'vendor/LICENSE carries the ISC grant (§4.1)');
});
