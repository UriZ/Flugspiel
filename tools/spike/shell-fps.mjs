// Frame-rate harness for the split-panel shell (#5 AC5).
//
//   node tools/spike/shell-fps.mjs [--url /index.html] [--w 1600] [--h 900] [--seconds 5]
//
// Measures two independent rAF loops simultaneously — the shell's (parent document)
// and the game's (inside the <iframe>) — and reports the frame-interval distribution
// for three phases: steady, during a divider drag, and stacked (<768px viewport).
// Exits 1 if any phase falls below 30 fps mean or exceeds a 50 ms p95 interval.
//
// Instrumentation is external: rAF is wrapped via evaluateOnNewDocument, so the shell
// needs no test-only hook. The only contract it relies on is `[data-role="divider"]`.
//
// Expected output — 3 runs on Darwin 23.6.0 (macOS), node v22.22.0, puppeteer
// 25.10.0, headless Chrome, 1600x900, 5 s windows, 2026-09-12, against
// tools/spike/shell-probe.html. Range across the 3 runs, shell and game loops
// tracked each other to within 0.1 fps in every run:
//   steady   59.6 - 60.0 fps   p95 16.7 - 16.8 ms
//   drag     40.7 - 59.2 fps   p95 16.7 - 33.4 ms
//   stacked  54.0 - 60.0 fps   p95 16.7 - 33.4 ms
// The drag low of 40.7 fps was a single run under machine load; the bar is set at
// 30 fps / 50 ms p95 to sit clear of that. Headless numbers are a floor, not a
// prediction of a real display — rerun with --headful on the target machine before
// claiming AC5 on real hardware.
//
// Expected output — against the real shell, `--url /index.html`, same environment,
// 2026-09-13, #5 AC5. All three phases and both loops PASS:
//   steady   59.2 - 60.0 fps   p95 16.8 ms
//   drag     38.3 - 59.6 fps   p95 16.7 - 33.4 ms
//   stacked  53.8 - 60.0 fps   p95 16.8 ms
// The drag low of 38.3 was taken at loadavg 27.8 with five other agents running, and
// still cleared the bar — treat it as the floor, not the expectation.
//
// **What the shell costs over shell-probe.html: below what this method can resolve
// here, and NOT the ~6 fps a single pair of runs appears to show.** Measured by
// interleaving the two URLs round-robin rather than running one after the other
// (loadavg fell 25 -> 12 across the four runs, which a sequential A-then-B would have
// attributed to the variant):
//   round 1   probe drag 59.6   index drag 52.9
//   round 2   probe drag 48.8   index drag 59.6      <- the order flips
// The variant with the lower number changes between rounds, so the 48.8-59.6 drag
// spread is machine load. Steady and stacked sit at or within 2 fps of the 60 fps cap
// for both URLs, where a cost this small cannot be resolved at all. Do not quote a
// per-phase delta from a single pair of runs.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const puppeteer = require_('puppeteer');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MEAN_FPS_BAR = 30;
const P95_MS_BAR = 50;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const URL_PATH = arg('url', '/index.html');
const W = +arg('w', 1600), H = +arg('h', 900), SECONDS = +arg('seconds', 5);
const HEADFUL = argv.includes('--headful');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

// Directory listings matter: the vendored audio loader discovers radio chatter by
// fetching `assets/radio/` and scraping <a href>. Without listings it silently falls
// back to a hardcoded set — not fatal, but the harness should not change that path.
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, p);
  try {
    const st = await fs.stat(f);
    if (st.isDirectory()) {
      const names = await fs.readdir(f);
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(names.map((n) => `<a href="${p.replace(/\/$/, '')}/${n}">${n}</a>`).join('\n'));
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(await fs.readFile(f));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const stats = (times) => {
  const d = [];
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  if (d.length < 2) return { fps: 0, p95: Infinity, n: d.length };
  d.sort((a, b) => a - b);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  return { fps: +(1000 / mean).toFixed(1), p95: +d[Math.floor(0.95 * d.length)].toFixed(1), n: d.length + 1 };
};

const browser = await puppeteer.launch({ headless: !HEADFUL, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
await page.evaluateOnNewDocument(() => {
  window.__raf = [];
  const orig = window.requestAnimationFrame.bind(window);
  // Dedupe on the rAF timestamp: a page may schedule several callbacks per frame
  // (a render loop plus a coalesced layout write), and counting callbacks instead of
  // frames reports a frame rate higher than the display ever produced.
  window.requestAnimationFrame = (cb) => orig((t) => {
    if (window.__raf[window.__raf.length - 1] !== t) window.__raf.push(t);
    return cb(t);
  });
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`http://localhost:${port}${URL_PATH}`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1500));

const frame = page.frames().find((f) => f.url().includes('game.html'));
if (!frame) { console.error(`no game iframe at ${URL_PATH}`); await browser.close(); server.close(); process.exit(1); }

// Leave the start screen so the game is under real load, not drawing a title card.
await frame.evaluate(() => {
  const c = window.game.renderer.canvas, x = innerWidth / 2, y = innerHeight / 2;
  for (const type of ['mousedown', 'mouseup']) {
    c.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 6000));
const phase = await frame.evaluate(() => window.game.state);
if (phase !== 'playing') console.warn(`warning: game phase is "${phase}", not "playing" — load is not representative`);

const reset = async () => {
  await page.evaluate(() => { window.__raf.length = 0; });
  await frame.evaluate(() => { window.__raf.length = 0; });
};
const collect = async () => ({
  shell: stats(await page.evaluate(() => window.__raf)),
  game: stats(await frame.evaluate(() => window.__raf)),
});

const results = {};
await reset();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
results.steady = await collect();

const divider = await page.$('[data-role="divider"]');
if (divider) {
  const box = await divider.boundingBox();
  await reset();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const steps = SECONDS * 60;
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(W * 0.25 + (W * 0.5 * i) / steps, box.y + box.height / 2);
  }
  await page.mouse.up();
  results.drag = await collect();
} else {
  console.warn('warning: no [data-role="divider"] — drag phase skipped');
}

await page.setViewport({ width: 600, height: 900 });
await new Promise((r) => setTimeout(r, 1000));
await reset();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
results.stacked = await collect();

let failed = false;
console.log(`\nurl=${URL_PATH} viewport=${W}x${H} window=${SECONDS}s headless=${!HEADFUL}\n`);
console.log('phase    loop    fps     p95(ms)  frames  verdict');
for (const [name, r] of Object.entries(results)) {
  for (const [loop, s] of Object.entries(r)) {
    const ok = s.fps >= MEAN_FPS_BAR && s.p95 <= P95_MS_BAR;
    if (!ok) failed = true;
    console.log(`${name.padEnd(8)} ${loop.padEnd(7)} ${String(s.fps).padEnd(7)} ${String(s.p95).padEnd(8)} ${String(s.n).padEnd(7)} ${ok ? 'PASS' : 'FAIL'}`);
  }
}
if (errors.length) { console.log('\npage errors:'); for (const e of errors) console.log('  ' + e); failed = true; }
console.log(`\nbar: mean >= ${MEAN_FPS_BAR} fps and p95 interval <= ${P95_MS_BAR} ms, both loops, every phase`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
