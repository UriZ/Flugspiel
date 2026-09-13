// #53 — is a firing descending neuron distinguishable from an idle one in the DN strip?
//
//   node tools/spike/viz-dn-strip.mjs [--widths 900,720,500] [--samples 60] [--legacy]
//
// Drives the REAL `createPanel` one DN at a time and asks the only question that
// matters: does the strip change at all when that neuron fires? Geometry-free by
// design — a probe that recomputes where the tick should land can agree with a broken
// renderer, because both would be using the same wrong arithmetic.
//
// `--legacy` serves `git show HEAD:src/viz/descending.js` in place of the working tree's
// copy, so the before/after comparison needs no edit on disk. Nothing is ever written to
// the tree; a mutation left behind by a timed-out run is a defect this avoids by
// construction.
//
// Samples are spaced past the 300 ms afterglow so the previous neuron is dark. That is
// what makes the run take a minute per width rather than a second, and skipping it would
// make every neuron look visible.
//
// Reports, per width: plotW, the DNs that share a pixel column (predicted from the
// artifact), and the measured invisible fraction. Exit 0 always — this is a
// measurement, not a gate.

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require_('puppeteer');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const WIDTHS = arg('widths', '900,720,500').split(',').map(Number);
const SAMPLES = +arg('samples', 60);
const SETTLE_MS = +arg('settle', 340);        // > DECAY_MS (300) in descending.js
const LEGACY = argv.includes('--legacy');
const HEIGHT = +arg('height', 872);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.bin': 'application/octet-stream', '.json': 'application/json' };

const FIXTURE = await fs.readFile(path.join(ROOT, 'tools/spike/viz-dn-strip.html'), 'utf8');
// Every file this change touches, so `--legacy` is the whole pre-change viz rather than
// one module of it wired to five new ones.
const LEGACY_PATHS = ['src/viz/descending.js', 'src/viz/activity.js', 'src/viz/raster.js',
                      'src/viz/palette.js', 'src/viz/dopamine.js', 'src/ui/spike-codec.js'];
const legacySrc = new Map(LEGACY ? LEGACY_PATHS.map((f) =>
  [`/${f}`, execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, encoding: 'utf8' })]) : []);

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__strip.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FIXTURE); }
  if (legacySrc.has(p)) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(legacySrc.get(p));
  }
  try {
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT)) throw new Error('escape');
    const body = await fs.readFile(f);
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
// dpr 1 so device pixels and css pixels are the same number and the reported widths are
// the widths a reader can compare against the issue.
await page.setViewport({ width: 1100, height: HEIGHT + 40, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${base}/__strip.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__strip && window.__strip.ready', { timeout: 20000 });

console.log(`descending.js: ${LEGACY ? 'HEAD (pre-fix)' : 'working tree'} · `
  + `${SAMPLES} DNs per width · settle ${SETTLE_MS} ms · dpr 1 · `
  + `loadavg ${os.loadavg()[0].toFixed(2)}`);

if (argv.includes('--cost')) {
  // AC3: the fix must not have made cost scale with the lit count. Same panel, same
  // frames, only the amount of activity differs.
  await page.evaluate((w, h) => window.__strip.setSize(w, h), 720, HEIGHT);
  await page.evaluate(() => window.__strip.prepare());
  // The middle row is the one that answers AC3. A quiet map with EVERY descending
  // neuron lit isolates the cost that scales with the lit count from the map's own
  // burst cost, which this change does not touch — comparing the two burst rows alone
  // measures mostly `putImageData` and the 1,314 marker arcs, under whatever else the
  // machine is doing.
  const rows = [['quiet map, 0 DN active   ', 0.005, false],
                ['quiet map, 1314 DN active', 0.005, true],
                ['burst map, 1314 DN active', 0.99, true]];
  const out = [];
  for (const [label, firing, all] of rows) {
    const r = await page.evaluate((f, a) => window.__strip.cost(f, a, 200), firing, all);
    out.push(r);
    console.log(`${label}  push ${r.push.toFixed(2)} ms   render `
      + `${r.render.toFixed(2)} ms   (popcount ${r.popcount}, active ${r.active})`);
  }
  console.log(`DN-lit-proportional render cost: ${(out[1].render - out[0].render).toFixed(2)} ms `
    + 'for 0 -> 1314 lit');
  await browser.close();
  server.close();
  process.exit(0);
}

const results = [];
for (const cssW of WIDTHS) {
  await page.evaluate((w, h) => window.__strip.setSize(w, h), cssW, HEIGHT);
  const info = await page.evaluate(() => window.__strip.prepare());
  if (!info) { console.log(`cssW=${cssW}: no strip drawn at this size — skipped`); continue; }
  if (process.env.STRIP_DEBUG) console.log('  box', JSON.stringify(info));
  // The strip's own arithmetic: 14px for the midline block plus a 6px gap (descending.js
  // `renderStrip`). Reported so the threshold `plotW < dnCols` can be read directly.
  const plotW = Math.max(1, info.box.w - 14 - 6);
  const { shared, buckets } = await page.evaluate((p) => window.__strip.collisions(p), plotW);

  // A fixed stride, so `--legacy` and the working tree are asked about the same neurons.
  const stride = Math.max(1, Math.floor(info.nDn / SAMPLES));
  const slots = [];
  for (let k = 0; k < info.nDn && slots.length < SAMPLES; k += stride) slots.push(k);

  let invisible = 0;
  const missed = [];
  for (const k of slots) {
    const seen = await page.evaluate((s) => window.__strip.sample(s), k);
    if (!seen) { invisible++; missed.push(k); }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
  const frac = invisible / slots.length;
  results.push({ cssW, plotW, dnCols: info.dnCols, shared, buckets, invisible,
                 sampled: slots.length, frac, missed });
  console.log(`cssW=${cssW}  plotW=${plotW}  dnCols=${info.dnCols}  `
    + `${plotW < info.dnCols ? 'BELOW' : 'above'} threshold  ·  `
    + `share a column: ${shared}/${info.nDn} over ${buckets} buckets  ·  `
    + `invisible ${invisible}/${slots.length} = ${(100 * frac).toFixed(1)}%`
    + (missed.length ? `  slots ${missed.slice(0, 10).join(',')}${missed.length > 10 ? '…' : ''}` : ''));
}

await browser.close();
server.close();
console.log(JSON.stringify(results.map(({ missed, ...r }) => r)));
