// Canvas-model spike for #6 — which rendering model reaches 30+ fps with 166,700
// neurons, measured rather than reasoned.
//
//   node tools/spike/viz-canvas-model.mjs [--rounds 3] [--seconds 4] [--headful]
//                                         [--redraw every|ondata] [--dpr 1|2] [--firing 0.085]
//
// #6's own Notes assert "Canvas 2D per-neuron drawing will not reach this". That is the
// claim under test, not an input. Eight models render the SAME synthetic frames into a
// canvas the size of #5's viz panel, at the REAL anatomical positions from
// data/brain.npz, with the REAL game running in an iframe alongside so the rAF
// contention is the one #6 will actually face:
//
//   aggregate-2d      64x32 cells, popcount per cell           (#5's stub — the floor)
//   fillrect-all-2d   one fillRect per neuron, 166,700 + lit   (the claim under test)
//   cachedbg-lit-2d   dim anatomy baked once; ~14,160 lit fillRects per frame
//   imagedata-map-2d  166,700 indexed writes into a panel-sized ImageData, putImageData
//   webgl-points      166,700 gl.POINTS, brightness via bufferSubData
//   worker-imagedata  OffscreenCanvas + worker running imagedata-map
//   worker-webgl      OffscreenCanvas + worker running webgl-points
//   composite-2d      imagedata-map PLUS raster, DN markers+labels, reward tint, stats
//
// composite-2d is the one that answers AC6: "30+ fps with full 166k neuron data" is a
// claim about the PANEL, not about a neuron map in isolation.
//
// The panel redraws on EVERY rAF by default (`--redraw ondata` for the 20 Hz variant):
// #5's contract calls render() once per animation frame so a raster keeps scrolling past
// a stalled link, and AC6's "30+ fps" is a redraw rate, not the data rate. Measuring
// only on new data understates the cost by ~3x.
//
// Models are interleaved ROUND-ROBIN, not run one after another: on this project a
// sequential A-then-B comparison has twice attributed machine-load drift to the variant.
// Every fps figure is printed with the loadavg it was taken under.
//
// The worker rows print `drawn/posted`. A worker that cannot keep up does not slow the
// main thread down — postMessage just queues — so worker fps alone would hide a growing
// backlog. drawn < posted is the tell.
//
// Expected output — Darwin 23.6.0, 8 physical / 16 logical cores, node v22.22.0,
// puppeteer 25.10.0, 1600x900, panel 797x872 css, 20 Hz frames, loadavg 2.6-5.1,
// 2026-09-13. Headless Chrome here gets REAL hardware GL, not SwiftShader: the RENDERER
// line printed "ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630)". Check
// that line before trusting the WebGL rows; a SwiftShader run is a different measurement.
//
//   render-ms median, by run          dpr1/8.5%   dpr2/8.5%   dpr2/50%
//   aggregate-2d                        1.10        1.20        0.80
//   fillrect-all-2d                    65.80       68.50       89.00   <- 13.3 / 12.7 / 8.5 fps
//   cachedbg-lit-2d                     2.50        2.70       34.00   <- 60 / 60 / 23.1 fps
//   imagedata-map-2d                    1.60        4.50        6.10
//   webgl-points                        0.50        0.50        0.40
//   worker-imagedata                    1.90        6.60        5.90
//   worker-webgl                        0.40        0.40        0.50
//   composite-2d                        1.80        5.10        6.50
//
// Every model holds 60 fps shell / 60 fps game except the two marked, and those two are
// the two whose cost scales with the number of LIT neurons. fillrect-all-2d misses 30 fps
// everywhere; cachedbg-lit-2d passes at the measured 8.5% firing and misses at 50%, which
// is the trap: it looks fine until the brain gets busy.
//
// Exit 0 always — this is a measurement, not a gate.

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire('/Users/urizonens/dev/Flugspiel/package.json');
const puppeteer = require_('puppeteer');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const ROUNDS = +arg('rounds', 3);
const SECONDS = +arg('seconds', 4);
const HEADFUL = argv.includes('--headful');
const DPR = +arg('dpr', 1);
const FIRING = +arg('firing', 0.085);   // 8.50% is the measured wire rate
const REDRAW = arg('redraw', 'every');   // 'every' = per rAF (#5's contract); 'ondata' = 20 Hz

const MODELS = ['aggregate-2d', 'fillrect-all-2d', 'cachedbg-lit-2d', 'imagedata-map-2d',
                'webgl-points', 'worker-imagedata', 'worker-webgl', 'composite-2d'];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

// The real layout, regenerated from data/brain.npz on every run. Kept out of the repo:
// it is a 1,000,610-byte derived artefact, and a stale copy would silently misreport
// the overdraw that separates these models.
const POSFILE = path.join(os.tmpdir(), 'flugspiel-viz-positions.bin');
console.log(execFileSync('python3', ['tools/spike/viz-positions.py', POSFILE],
                         { cwd: ROOT, encoding: 'utf8' }).trim());
const POSBIN = await fs.readFile(POSFILE);
const FIXTURE = await fs.readFile(path.join(ROOT, 'tools/spike/viz-canvas-model.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__viz.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FIXTURE); }
  if (p === '/__positions.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(POSBIN); }
  const f = path.join(ROOT, p);
  try {
    const st = await fs.stat(f);
    if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(await fs.readFile(f));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const load = () => os.loadavg().map((n) => n.toFixed(2)).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: !HEADFUL, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: DPR });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
await page.evaluateOnNewDocument(() => {
  window.__raf = [];
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => orig((t) => {
    if (window.__raf[window.__raf.length - 1] !== t) window.__raf.push(t);
    return cb(t);
  });
});
await page.goto(`http://localhost:${port}/__viz.html?firing=${FIRING}`, { waitUntil: 'networkidle2' });
await sleep(2000);

// Leave the start screen so the game is under real load, not drawing a title card.
const gframe = page.frames().find((f) => f.url().includes('game.html'));
if (!gframe) { console.error('no game iframe'); await browser.close(); server.close(); process.exit(1); }
await gframe.evaluate(() => {
  const c = window.game.renderer.canvas, x = innerWidth / 2, y = innerHeight / 2;
  for (const type of ['mousedown', 'mouseup']) {
    c.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  }
});
await sleep(6000);
const phase = await gframe.evaluate(() => window.game.state);
if (phase !== 'playing') console.warn(`warning: game phase is "${phase}", not "playing" — load is not representative`);

const env = await page.evaluate(() => window.__env());
console.log(`\npanel ${env.panelW}x${env.panelH} css @ dpr ${env.dpr}  n=${env.n}  lit/frame=${env.lit} (${(100 * env.lit / env.n).toFixed(2)}%)  frames at ${env.hz} Hz`);
console.log(`WebGL RENDERER: ${env.renderer}`);
console.log(`cores: ${os.cpus().length} logical / ${env.hw} hardwareConcurrency   game phase: ${phase}   redraw=${REDRAW}   headless=${!HEADFUL}`);
console.log(`codec on this machine: decode+popcount ${env.decodeMs.toFixed(3)} ms median, unpack-to-${env.n} ${env.unpackMs.toFixed(3)} ms median`);
console.log(`layout: ${env.n - env.unplaced} neurons at real soma coords, ${env.unplaced} with none (banded);`);
console.log(`        they land on ${env.distinct} distinct pixels of ${env.canvasPx} (${(100 * env.distinct / env.canvasPx).toFixed(1)}% of canvas)`);
console.log(`        -> ${(env.n / env.distinct).toFixed(2)} neurons per occupied pixel: a 1-px-per-neuron map HIDES ${(100 * (1 - env.distinct / env.n)).toFixed(0)}% of them\n`);

const stat = (t) => { const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  if (d.length < 3) return { fps: 0, p95: Infinity }; d.sort((a, b) => a - b);
  return { fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p95: +d[Math.floor(0.95 * d.length)].toFixed(1) }; };

const SHOTS = process.env.VIZ_SHOTS || path.join(os.tmpdir(), 'flugspiel-viz-shots');
await fs.mkdir(SHOTS, { recursive: true });
const coverage = [];
const rows = [];
for (let round = 1; round <= ROUNDS; round++) {
  for (const model of MODELS) {
    const before = load();
    await page.evaluate((r) => window.__setRedraw(r), REDRAW);
    await page.evaluate((m) => window.__start(m), model);
    await sleep(600);                                   // let the model settle / worker boot
    await page.evaluate(() => { window.__raf.length = 0; window.__resetPanel(); });
    await gframe.evaluate(() => { window.__raf.length = 0; });
    await sleep(SECONDS * 1000);
    const panel = await page.evaluate(() => window.__panelStats());
    const shell = stat(await page.evaluate(() => window.__raf));
    const game = stat(await gframe.evaluate(() => window.__raf));
    if (round === 1) {
      // Vacuity check: the fastest model of all is one that draws nothing. Every model
      // gets a PNG and a non-background pixel count, so a blank winner cannot pass.
      const cov = await page.evaluate(() => window.__coverage());
      const shot = path.join(SHOTS, `${model}.png`);
      await (await page.$('#viz')).screenshot({ path: shot });
      coverage.push({ model, cov, shot });
    }
    await page.evaluate(() => window.__stop());
    rows.push({ round, model, shell, game, panel, load: before });
    const lag = panel.drawn < panel.posted * 0.95 ? `  BEHIND ${panel.drawn}/${panel.posted}` : '';
    console.log(`r${round} ${model.padEnd(16)} shell ${String(shell.fps).padEnd(5)} game ${String(game.fps).padEnd(5)} ` +
      `panel ${String(panel.fps).padEnd(5)} render med ${panel.med.toFixed(2)} p95 ${panel.p95.toFixed(2)} ms  load ${before}${lag}`);
  }
}

console.log('\n=== median across rounds (fps: shell rAF / game rAF / panel draws; render ms) ===');
console.log('model             shell  game   panel  render-med  render-p95  drawn/posted');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (const m of MODELS) {
  const r = rows.filter((x) => x.model === m);
  const s = { shell: median(r.map((x) => x.shell.fps)), game: median(r.map((x) => x.game.fps)),
              panel: median(r.map((x) => x.panel.fps)), med: median(r.map((x) => x.panel.med)),
              p95: median(r.map((x) => x.panel.p95)),
              drawn: median(r.map((x) => x.panel.drawn)), posted: median(r.map((x) => x.panel.posted)) };
  console.log(`${m.padEnd(17)} ${String(s.shell).padEnd(6)} ${String(s.game).padEnd(6)} ${String(s.panel).padEnd(6)} ` +
    `${s.med.toFixed(2).padEnd(11)} ${s.p95.toFixed(2).padEnd(11)} ${s.drawn}/${s.posted}`);
}

console.log('\n=== vacuity check: is anything actually on the canvas? (round 1) ===');
for (const c of coverage) {
  const n = c.cov.nonbg === undefined ? c.cov.note : `${c.cov.nonbg} px non-background (${c.cov.pctNonBg}% of ${c.cov.px})`;
  console.log(`  ${c.model.padEnd(17)} ${String(n).padEnd(46)} ${c.shot}`);
}

// The scrolling raster on its own (AC2): a canvas that drawImage()s itself is the trap.
console.log('\n=== scrolling raster alone, one column per frame (ms per scroll+column) ===');
for (const [w, h] of [[797, 120], [797, 240], [1594, 240]]) {
  const r = await page.evaluate(([a, b]) => window.__rasterCost(a, b), [w, h]);
  console.log(`  ${w}x${h}  med ${r.med.toFixed(3)} ms  p95 ${r.p95.toFixed(3)} ms`);
}

// The transferControlToOffscreen() consequence, confirmed by execution rather than cited.
console.log('\n=== transferControlToOffscreen(): what becomes illegal on the main thread ===');
const otc = await page.evaluate(() => window.__offscreenConsequences());
for (const [op, r] of Object.entries(otc)) console.log(`  ${op.padEnd(38)} ${r}`);

console.log('\n=== resize under a LIVE worker model (does the worker-side path work?) ===');
await page.evaluate(() => window.__start('worker-imagedata'));
await sleep(800);
const rz = await page.evaluate(() => window.__resizeUnderWorker(600, 500));
for (const [k, v] of Object.entries(rz)) console.log(`  ${k.padEnd(38)} ${v}`);
await page.evaluate(() => window.__stop());

console.log(`\nloadavg now ${load()}   (8 physical / 16 logical cores)`);
if (pageErrors.length) { console.log('\npage errors:'); for (const e of [...new Set(pageErrors)]) console.log('  ' + e); }
await browser.close();
server.close();
process.exit(0);
