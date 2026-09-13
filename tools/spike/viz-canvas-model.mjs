// Canvas-model spike for #6 — which rendering model reaches 30+ fps with 166,700
// neurons, measured rather than reasoned.
//
//   node tools/spike/viz-canvas-model.mjs [--rounds 3] [--seconds 4] [--headful]
//
// #6's own Notes assert "Canvas 2D per-neuron drawing will not reach this". That is the
// claim under test, not an input. Six models render the SAME synthetic frames into a
// panel the size of #5's viz panel, with the REAL game running in an iframe alongside so
// the rAF contention is the one #6 will actually face:
//
//   aggregate-2d   64x32 cells, popcount per cell          (#5's stub — the floor)
//   fillrect-2d    one fillRect per LIT neuron (~14,160)   (arbitrary positions)
//   imagedata-2d   166,700-px ImageData -> putImageData -> drawImage (packed grid only)
//   webgl-points   166,700 gl.POINTS, per-vertex brightness via bufferSubData
//   worker-2d      OffscreenCanvas + worker running imagedata-2d
//   fillrect-lit-2d one fillRect per lit neuron only, unlit undrawn
//   worker-webgl   OffscreenCanvas + worker running webgl-points
//
// The panel redraws on EVERY rAF by default (`--redraw ondata` for the 20 Hz variant):
// #5's contract calls render() once per animation frame so a raster keeps scrolling past
// a stalled link, and AC6's "30+ fps" is a redraw rate, not the data rate. Measuring
// only on new data understates the cost by 3x.
//
// Models are interleaved ROUND-ROBIN, not run one after another: on this project a
// sequential A-then-B comparison has twice attributed machine-load drift to the variant.
// Every fps figure is printed with the loadavg it was taken under.
//
// Expected output — Darwin 23.6.0, 16 logical / 8 physical cores, node v22.22.0,
// puppeteer 25.10.0 headless Chrome (SwiftShader software GL — see the RENDERER line;
// real hardware will be faster for the WebGL rows and identical for the 2D rows),
// 1600x900, panel 797x872 @ dpr 1, 20 Hz frames at 8.5% firing, 2026-09-13:
//   see the issue #6 comment for the full table. Headline: every model except
//   fillrect-2d holds 60/60; fillrect-2d holds >=30 but eats the budget.
// Exit 0 always — this is a measurement, not a gate.

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

const MODELS = ['aggregate-2d', 'fillrect-2d', 'fillrect-lit-2d', 'imagedata-2d', 'webgl-points', 'worker-2d', 'worker-webgl'];
const REDRAW = arg('redraw', 'every');   // 'every' = per rAF (#5's contract); 'ondata' = 20 Hz

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

const FIXTURE = await fs.readFile(path.join(ROOT, 'tools/spike/viz-canvas-model.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__viz.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FIXTURE); }
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

const load = () => os.loadavg().map((n) => n.toFixed(2)).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: !HEADFUL, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
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
await page.goto(`http://localhost:${port}/__viz.html`, { waitUntil: 'networkidle2' });
await sleep(1500);

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
console.log(`cores: ${os.cpus().length} logical / ${env.hw} hardwareConcurrency   game phase: ${phase}   redraw=${REDRAW}\n`);
console.log(`codec on this machine: decode+popcount ${env.decodeMs.toFixed(3)} ms median, unpack-to-166700 ${env.unpackMs.toFixed(3)} ms median\n`);

const stat = (t) => { const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  if (d.length < 3) return { fps: 0, p95: Infinity }; d.sort((a, b) => a - b);
  return { fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p95: +d[Math.floor(0.95 * d.length)].toFixed(1) }; };

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
    await page.evaluate(() => window.__stop());
    rows.push({ round, model, shell, game, panel, load: before });
    console.log(`r${round} ${model.padEnd(14)} shell ${String(shell.fps).padEnd(5)} game ${String(game.fps).padEnd(5)} ` +
      `panel ${String(panel.fps).padEnd(5)} render med ${panel.med.toFixed(2)} p95 ${panel.p95.toFixed(2)} ms  loadavg ${before}`);
  }
}

console.log('\n=== median across rounds (fps: shell / game / panel; render ms median) ===');
console.log('model           shell  game   panel  render-med  render-p95');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const summary = {};
for (const m of MODELS) {
  const r = rows.filter((x) => x.model === m);
  const s = { shell: median(r.map((x) => x.shell.fps)), game: median(r.map((x) => x.game.fps)),
              panel: median(r.map((x) => x.panel.fps)), med: median(r.map((x) => x.panel.med)),
              p95: median(r.map((x) => x.panel.p95)) };
  summary[m] = s;
  console.log(`${m.padEnd(15)} ${String(s.shell).padEnd(6)} ${String(s.game).padEnd(6)} ${String(s.panel).padEnd(6)} ` +
    `${s.med.toFixed(2).padEnd(11)} ${s.p95.toFixed(2)}`);
}

// The transferControlToOffscreen() consequence, confirmed by execution rather than cited.
console.log('\n=== transferControlToOffscreen(): what becomes illegal on the main thread ===');
const otc = await page.evaluate(() => window.__offscreenConsequences());
for (const [op, r] of Object.entries(otc)) console.log(`  ${op.padEnd(34)} ${r}`);

console.log(`\nloadavg now ${load()}   (16 logical / 8 physical cores)`);
if (pageErrors.length) { console.log('\npage errors:'); for (const e of [...new Set(pageErrors)]) console.log('  ' + e); }
await browser.close();
server.close();
process.exit(0);
