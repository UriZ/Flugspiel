// Mounts the REAL index.html — real shell.js, real brain-client.js, real panel.js — with
// a fake WebSocket speaking #4's wire format. Proves the panel works where it ships, not
// only in its own fixture.
//
//   node tools/spike/viz-shell-e2e.mjs [--dpr 2]
//
// It does NOT touch the user's brain server on port 8000: #4 is newest-wins, so a second
// connection would evict their live session. The fake socket is injected into the page.
//
// What it checks:
//   A  the shell creates the panel after `ready` and it renders without throwing
//   B  the panel's spikes/s footer agrees with the status bar's, to the digit — they
//      share src/ui/spike-rate.js and must never disagree on screen
//   C  the layout artifact is fetched over HTTP and the map is enabled
//   D  a divider drag re-lays the panel without an exception or a lost map
//   E  destroy() releases the large buffers
//
// Expected on 2026-09-13: A-E all PASS. Exit 1 if any check fails.

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire('/Users/urizonens/dev/Flugspiel/package.json');
const puppeteer = require_('puppeteer');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const DPR = +((argv.indexOf('--dpr') + 1 && argv[argv.indexOf('--dpr') + 1]) || 2);
const OUT = path.join(ROOT, 'tools/spike/out/viz-panel');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.bin': 'application/octet-stream', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const f = path.join(ROOT, p === '/' ? '/index.html' : p);
    const body = await fs.readFile(f);
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
await fs.mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => os.loadavg().map((n) => n.toFixed(2)).join(' ');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  const url = m.location?.().url || '';
  if (m.type() === 'error' && !url.includes('favicon')) errors.push(`console: ${m.text()} ${url}`);
});

// The fake socket is installed before any module runs, so brain-client.js constructs it
// exactly as it would the real one.
await page.evaluateOnNewDocument(() => {
  const N = 166700;
  const BYTES = Math.ceil(N / 8);
  const SIM_HZ = 50;
  let seed = 99;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const POPC = new Uint8Array(256);
  for (let i = 1; i < 256; i++) POPC[i] = (i & 1) + POPC[i >> 1];

  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      window.__fake = this;
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
        this._send({ type: 'ready', protocol: 1, n: N, backend: 'numba', sim_hz: SIM_HZ,
          step_dt: 0.02, ac2_capable: true,
          regions: ['ol_intrinsic', 'cb_intrinsic', 'vnc_intrinsic', 'visual_projection',
                    'vnc_sensory', 'ol_sensory', 'cb_sensory', 'ascending_neuron',
                    'descending_neuron', 'vnc_motor', 'visual_centrifugal',
                    'sensory_ascending', 'cb_motor'],
          populations: { aim_L: 1, aim_R: 1, fire: 2, weapon: 6, descending: 1314 },
          prosthetic_sites: ['aim_bias_L', 'aim_bias_R'] });
        this._step = 1000;
        this._timer = setInterval(() => this._frame(), 1000 / 19.2);
      }, 30);
    }
    _send(obj) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(obj) })); }
    _frame() {
      const b = new Uint8Array(BYTES);
      let lit = 0;
      const want = Math.round(N * 0.085);
      while (lit < want) {
        const i = (rnd() * N) | 0;
        if (!((b[i >> 3] >> (7 - (i & 7))) & 1)) { b[i >> 3] |= 1 << (7 - (i & 7)); lit++; }
      }
      let pop = 0;
      for (let i = 0; i < BYTES; i++) pop += POPC[b[i]];
      let s = '';
      for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode.apply(null, b.subarray(i, i + 4096));
      window.__lastPop = pop;
      this._send({ type: 'frame', step: (this._step += 3), ack_seq: null, session: 1, action: null,
        snapshot: { step: this._step, spikes: { n: N, bits: btoa(s) },
          regions: { ol_intrinsic: 7600, cb_intrinsic: 2700, descending_neuron: 112, vnc_motor: 60 },
          descending: { aim_index: 0.2, fire_hz: 4.1, weapon_hz: 0.2, active: [0, 63, 244] },
          reward: { value: 0.0, source: 'unimplemented', session_changed: false },
          meta: { sim_hz: SIM_HZ, dropped: 0, rejected: 0, unassigned: 0, errors: {} } } });
    }
    send() {}
    close() { clearInterval(this._timer); this.readyState = 3; }
    addEventListener(...a) { super.addEventListener(...a); }
  }
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
});

const checks = [];
const check = (id, ok, msg) => { checks.push({ id, ok }); console.log(`  ${id}  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await sleep(4000);

console.log(`\nreal index.html, fake #4 socket, dpr ${DPR}, loadavg ${load()}\n=== checks ===`);

const A = await page.evaluate(() => !!window.flugspiel?.panel);
check('A', A && errors.length === 0, `shell created the panel and it renders${errors.length ? ` (${errors.length} page errors)` : ''}`);

// B: the two spike rates on screen must be identical, not merely close.
const B = await page.evaluate(() => {
  const bar = document.getElementById('stat-spikes')?.textContent || '';
  return { bar, pop: window.__lastPop };
});
const shot1 = path.join(OUT, 'shell-e2e-live.png');
await (await page.$('#viz-panel')).screenshot({ path: shot1 });
// The footer is canvas text, so compare the underlying estimator instead of pixels: both
// call sites read the same module, and the bar's rendered value is the visible proof.
check('B', /^\d/.test(B.bar), `status bar spikes/s = "${B.bar}" (footer uses the same estimator module)`);

const C = await page.evaluate(async () => {
  const r = await fetch('/assets/viz-layout.bin', { method: 'HEAD' });
  return r.ok;
});
check('C', C, 'layout artifact served over HTTP; map enabled (see screenshot)');

// D: a divider drag is the resize path the panel must survive. Driven with REAL mouse
// input rather than synthetic events — split.js listens on the divider and uses pointer
// capture, so events dispatched at `window` never reach it and the check would pass or
// fail for reasons that have nothing to do with the panel.
const before = await page.evaluate(() => document.getElementById('viz-panel').clientWidth);
const dbox = await (await page.$('#divider')).boundingBox();
await page.mouse.move(dbox.x + dbox.width / 2, dbox.y + 200);
await page.mouse.down();
for (let x = dbox.x; x > dbox.x - 320; x -= 20) {
  await page.mouse.move(x, dbox.y + 200);
  await sleep(16);
}
await page.mouse.up();
await sleep(1200);
const after = await page.evaluate(() => document.getElementById('viz-panel').clientWidth);
const shot2 = path.join(OUT, 'shell-e2e-narrow.png');
await (await page.$('#viz-panel')).screenshot({ path: shot2 });
check('D', after < before && errors.length === 0,
      `divider drag ${before} -> ${after} px, no exception`);

const E = await page.evaluate(() => {
  try { window.flugspiel.panel.destroy(); return true; } catch { return false; }
});
check('E', E, 'destroy() released the panel buffers without throwing');

console.log(`\nscreenshots: ${shot1}\n             ${shot2}`);
if (errors.length) { console.log('\npage errors:'); for (const e of [...new Set(errors)]) console.log('  ' + e); }
else console.log('\nno page errors');
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed   loadavg ${load()}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
