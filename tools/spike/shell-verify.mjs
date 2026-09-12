// Verification-by-execution for #5 — drives the REAL shell (`/index.html`) and reads
// its own status bar. Testing is suspended; this is not a test, it is the observation
// harness for §11's restated acceptance criteria.
//
//   node tools/spike/shell-verify.mjs [--brain-port 8456] [--seconds 12] [--no-brain]
//
// Distinct from `shell-e2e.mjs`, which proves the *design* against an inline fixture
// document: that probe opens its own socket and installs its own bridge transport, so
// pointing it at the real shell would fight the shell's client and evict it with 4409.
// This one touches nothing — it clicks the shell's own buttons and asserts on the DOM
// the shell produced.
//
//   A1  three column tracks; DOM order viz / divider / game; the iframe really is the
//       vendored game (contentWindow.game.state is a string)
//   A1b dragging [data-role="divider"] widens #viz-panel monotonically and clamps both
//       panels at --min-panel
//   A2  with a brain: #stat-conn reads "live · <backend>", #stat-step strictly
//       increases over 1 s, #stat-score matches the last observed state, #stat-spikes
//       equals fmtRate(mean popcount x meta.sim_hz)
//   A2b kill the socket: #stat-conn becomes "reconnecting in Ns" and #stat-step FREEZES
//       rather than blanking
//   A3  768 -> 3 column tracks; 767 -> 1 column / 4 row tracks and viz above game;
//       crossing both ways re-creates neither the canvas nor the game window
//   A4  body and #app background are rgb(10, 10, 10)
//   A5  both rAF loops >= 30 fps while frames are arriving  (load-sensitive: report
//       loadavg alongside, a busy machine invalidates this one and only this one)
//   A6  ?brain= pointing off-loopback is refused and falls back to the default
//
// Exit 0 iff every check passes. --no-brain skips A2/A2b/A5 and reports them SKIP.

import { spawn } from 'node:child_process';
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
const BRAIN_PORT = +arg('brain-port', 8456);
const SECONDS = +arg('seconds', 12);
const NO_BRAIN = argv.includes('--no-brain');
const HEADFUL = argv.includes('--headful');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

// Directory listings matter: the vendored audio loader discovers radio chatter by
// fetching `assets/radio/` and scraping <a href>.
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

// The brain server is OURS: A2b has to make it genuinely go away, and evicting with a
// second socket would exercise 4409 (`superseded`, which must NOT auto-retry) rather
// than the ordinary drop the criterion is about.
let brain = null;
async function startBrain() {
  brain = spawn(path.join(ROOT, '.venv/bin/python'),
    [path.join(ROOT, 'src/server/ws_server.py'), '--port', String(BRAIN_PORT), '--log-level', 'warning'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  const err = [];
  brain.stderr.on('data', (d) => err.push(String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (brain.exitCode !== null) throw new Error(`ws_server exited ${brain.exitCode}: ${err.join('').slice(-400)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${BRAIN_PORT}/healthz`);   // node, not the browser: no CORS here
      const j = await r.json();
      // Somebody else's server on this port answers too, and a 404 body or a directory
      // listing would otherwise be polled for three minutes before failing obscurely.
      if (typeof j.backend !== 'string') {
        throw new Error(`:${BRAIN_PORT} answered /healthz but is not ws_server.py: ${JSON.stringify(j).slice(0, 120)}`);
      }
      if (j.ready) return { ...j, waited_s: +((Date.now() - t0) / 1000).toFixed(1) };
    } catch (e) {
      if (String(e.message).includes('is not ws_server.py')) throw e;
      /* otherwise: uvicorn does not accept until the lifespan handler finishes */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('brain server never became ready');
}
const stopBrain = () => { if (brain && brain.exitCode === null) brain.kill('SIGKILL'); };
process.on('exit', stopBrain);

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${id}  ${detail}\n   -> ${ok ? 'PASS' : 'FAIL'}`); };
const skip = (id, why) => { results.push({ id, ok: true, skip: true, detail: why }); console.log(`${id}  SKIP  ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let health = null;
if (!NO_BRAIN) {
  health = await startBrain();
  console.log(`brain server on :${BRAIN_PORT} ready in ${health.waited_s}s — backend=${health.backend} ac2_capable=${health.ac2_capable} startup_s=${health.startup_s}\n`);
}

const browser = await puppeteer.launch({ headless: !HEADFUL, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
await page.evaluateOnNewDocument(() => {
  window.__raf = [];
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => orig((t) => {
    if (window.__raf[window.__raf.length - 1] !== t) window.__raf.push(t);
    return cb(t);
  });
});

const url = `http://localhost:${port}/index.html?brain=ws://127.0.0.1:${BRAIN_PORT}/brain`;
await page.goto(url, { waitUntil: 'networkidle2' });
await sleep(2000);

// ── A1 layout ────────────────────────────────────────────────────────────────
const a1 = await page.evaluate(() => {
  const app = document.getElementById('app');
  const cols = getComputedStyle(app).gridTemplateColumns.split(/\s+/).length;
  const order = [...app.children].map((c) => c.id);
  const gf = document.getElementById('game-frame');
  return { cols, order, src: gf.getAttribute('src'),
           phase: typeof gf.contentWindow?.game?.state,
           bridge: typeof gf.contentWindow?.bridge?.getMode };
});
check('A1', a1.cols === 3 && a1.order.join(',') === 'viz-panel,divider,game-panel,status-bar'
        && a1.src === 'game.html' && a1.phase === 'string' && a1.bridge === 'function',
  `${a1.cols} column tracks, order [${a1.order}], iframe src="${a1.src}", contentWindow.game.state:${a1.phase}, bridge:${a1.bridge}`);

// ── A1b divider drag ─────────────────────────────────────────────────────────
const box = await (await page.$('[data-role="divider"]')).boundingBox();
const widths = [];
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (const x of [400, 600, 800, 1000, 1100]) {
  await page.mouse.move(x, box.y + box.height / 2);
  await sleep(120);
  widths.push(await page.evaluate(() => document.getElementById('viz-panel').clientWidth));
}
await page.mouse.move(20, box.y + box.height / 2); await sleep(150);
const atMin = await page.evaluate(() => document.getElementById('viz-panel').clientWidth);
await page.mouse.move(1580, box.y + box.height / 2); await sleep(150);
const atMax = await page.evaluate(() => ({
  viz: document.getElementById('viz-panel').clientWidth,
  game: document.getElementById('game-panel').clientWidth }));
await page.mouse.up();
const mono = widths.every((w, i) => i === 0 || w > widths[i - 1]);
check('A1b', mono && atMin === 240 && atMax.game === 240,
  `widths ${widths.join(' -> ')} monotonic=${mono}; clamped low viz=${atMin}px, clamped high game=${atMax.game}px (--min-panel 240)`);

// ── A3 breakpoint ────────────────────────────────────────────────────────────
await page.evaluate(() => {
  document.getElementById('viz-canvas').__tag = 'canvas-identity';
  document.getElementById('game-frame').contentWindow.__tag = 'game-identity';
});
await page.setViewport({ width: 768, height: 900 }); await sleep(400);
const at768 = await page.evaluate(() => getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(/\s+/).length);
await page.setViewport({ width: 767, height: 900 }); await sleep(400);
const at767 = await page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('app'));
  const v = document.getElementById('viz-panel').getBoundingClientRect();
  const g = document.getElementById('game-panel').getBoundingClientRect();
  return { cols: cs.gridTemplateColumns.split(/\s+/).length,
           rows: cs.gridTemplateRows.split(/\s+/).length, stacked: v.bottom <= g.top,
           axis: document.getElementById('divider').getAttribute('aria-orientation') };
});
await page.setViewport({ width: 1600, height: 900 }); await sleep(400);
const survived = await page.evaluate(() => ({
  canvas: document.getElementById('viz-canvas').__tag,
  game: document.getElementById('game-frame').contentWindow.__tag }));
check('A3', at768 === 3 && at767.cols === 1 && at767.rows === 4 && at767.stacked
        && at767.axis === 'horizontal' && survived.canvas === 'canvas-identity'
        && survived.game === 'game-identity',
  `768px -> ${at768} column tracks; 767px -> ${at767.cols} column / ${at767.rows} row tracks, viz above game=${at767.stacked}, aria-orientation=${at767.axis}; after round trip canvas="${survived.canvas}" gameWindow="${survived.game}"`);

// ── A4 dark theme ────────────────────────────────────────────────────────────
const a4 = await page.evaluate(() => ({
  body: getComputedStyle(document.body).backgroundColor,
  app: getComputedStyle(document.getElementById('app')).backgroundColor,
  token: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }));
check('A4', a4.body === 'rgb(10, 10, 10)' && a4.app === 'rgb(10, 10, 10)' && a4.token === '#0a0a0a',
  `body ${a4.body}, #app ${a4.app}, --bg ${a4.token}`);

// ── A6 ?brain= loopback restriction ──────────────────────────────────────────
const a6 = await page.evaluate(async () => {
  const m = await import('/src/ui/brain-client.js');
  const at = (q) => m.resolveUrl(q);
  return { evil: at('?brain=ws://evil.example.com/brain'), http: at('?brain=http://127.0.0.1:9/x'),
           junk: at('?brain=not a url'), none: at(''), ok: at('?brain=ws://127.0.0.1:8456/brain'),
           v6: at('?brain=ws://[::1]:8456/brain') };
});
const DEF = 'ws://127.0.0.1:8000/brain';
check('A6', a6.evil === DEF && a6.http === DEF && a6.junk === DEF && a6.none === DEF
        && a6.ok.startsWith('ws://127.0.0.1:8456') && a6.v6.startsWith('ws://[::1]:8456'),
  `off-loopback -> ${a6.evil} | http: -> ${a6.http} | junk -> ${a6.junk} | loopback kept -> ${a6.ok}, ${a6.v6}`);

// ── A2 / A2b / A5 need a live brain ──────────────────────────────────────────
if (NO_BRAIN) {
  skip('A2', 'no brain server (--no-brain)');
  skip('A2b', 'no brain server (--no-brain)');
  skip('A5', 'no brain server (--no-brain)');
} else {
  const live = await page.evaluate(async (secs) => {
    const fl = window.flugspiel;
    const t0 = performance.now();
    while (fl.client.state() === 'connecting' && performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!fl.client.ready()) return { err: `never became ready (state=${fl.client.state()})` };
    // Drive the shell through its own controls, exactly as a user would.
    const btn = (t) => [...document.querySelectorAll('.controls button')].find((b) => b.textContent.startsWith(t));
    btn('mode').click();
    // `start` is disabled until the bar's next render re-evaluates the mode, and a click
    // on a disabled button does not fire. Clicking both in the same turn silently left
    // the game on the start screen and every action rejected `not_playing` — with the
    // step counter still ticking, which is what made the first version of this check
    // pass while proving nothing.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 120));
    const start = btn('start');
    if (start.disabled) return { err: 'start button still disabled after entering fly mode' };
    start.click();
    const t1 = performance.now();
    while (fl.host.game.state !== 'playing' && performance.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (fl.host.game.state !== 'playing') return { err: `game never reached 'playing' (state=${fl.host.game.state})` };
    const base = fl.bridge.getStats();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const read = () => ({ conn: document.getElementById('stat-conn').textContent,
                          step: document.getElementById('stat-step').textContent,
                          score: document.getElementById('stat-score').textContent,
                          spikes: document.getElementById('stat-spikes').textContent,
                          title: document.getElementById('stat-spikes').title });
    const a = read();
    await new Promise((r) => setTimeout(r, 1000));
    const b = read();
    const f = fl.client.latest();

    // R4: `popcount x sim_hz` is normative and `popcount x observed frame rate` is the
    // plausible-looking wrong answer. Recompute BOTH from frames sampled here and check
    // the bar against the first while confirming the second would read differently —
    // otherwise this check cannot tell the two estimators apart.
    const { fmtRate } = await import('/src/ui/status-bar.js');
    const seen = [];
    let lastStep = -1;
    const t2 = performance.now();
    while (seen.length < 20 && performance.now() - t2 < 4000) {
      const g = fl.client.latest();
      if (g && g.step !== lastStep) { lastStep = g.step; seen.push({ pop: g.spikes.popcount, ms: g.recvMs, simHz: g.meta.sim_hz }); }
      await new Promise((r) => setTimeout(r, 10));
    }
    const meanPop = seen.reduce((x, r) => x + r.pop, 0) / seen.length;
    const simHz = seen[seen.length - 1].simHz;
    const obsHz = (seen.length - 1) / ((seen[seen.length - 1].ms - seen[0].ms) / 1000);
    const formula = { shown: document.getElementById('stat-spikes').textContent,
                      correct: fmtRate(meanPop * simHz), naive: fmtRate(meanPop * obsHz),
                      meanPop: Math.round(meanPop), simHz, obsHz, n: seen.length };
    const bstats = fl.bridge.getStats();
    return { a, b, formula, stats: fl.client.stats(), backend: fl.client.ready().backend,
             simHz: f.meta.sim_hz, pop: f.spikes.popcount, nbytes: f.spikes.bytes.length,
             gameScore: fl.bridge.getState().score,
             accepted: bstats.actionsAccepted - base.actionsAccepted,
             rejected: bstats.actionsRejected - base.actionsRejected,
             emitted: bstats.emitted - base.emitted, sendErrors: bstats.sendErrors,
             mode: fl.bridge.getMode(), phase: fl.host.game.state };
  }, SECONDS);

  if (live.err) {
    check('A2', false, live.err);
    skip('A2b', 'A2 did not connect');
    skip('A5', 'A2 did not connect');
  } else {
    const stepA = +live.a.step, stepB = +live.b.step;
    // A ticking step counter proves the socket is alive, NOT that the loop is closed:
    // the brain steps on its own and the bar looks identical while every action is
    // bouncing off a start screen. `accepted` and `phase` are the discriminator.
    check('A2', live.a.conn === `live · ${live.backend}` && Number.isInteger(stepA) && stepB > stepA
            && live.a.score !== '—' && live.a.spikes !== '—' && live.stats.bad === 0
            && live.phase === 'playing' && live.accepted > 0 && live.rejected === 0
            && live.sendErrors === 0 && live.formula.shown === live.formula.correct
            && live.formula.naive !== live.formula.correct,
      `conn="${live.a.conn}" step ${stepA} -> ${stepB} (+${stepB - stepA} in 1 s) score="${live.a.score}" (game ${live.gameScore}) spikes/s="${live.formula.shown}" == fmtRate(mean popcount ${live.formula.meanPop} over ${live.formula.n} frames x sim_hz ${live.formula.simHz.toFixed(2)}) = ${live.formula.correct}; the naive popcount x observed ${live.formula.obsHz.toFixed(1)} Hz would read ${live.formula.naive} (R4). title="${live.b.title}" | loop: phase=${live.phase} emitted=${live.emitted} accepted=${live.accepted} rejected=${live.rejected} sendErrors=${live.sendErrors} frames=${live.stats.frames} bad=${live.stats.bad}`);

    // A5 before A2b, while frames are still arriving.
    const st = (t) => { const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      if (d.length < 2) return { fps: 0, p95: Infinity }; d.sort((a, b) => a - b);
      return { fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p95: +d[Math.floor(0.95 * d.length)].toFixed(1) }; };
    const gframe = page.frames().find((f) => f.url().includes('game.html'));
    const shellFps = st(await page.evaluate(() => window.__raf.slice(-600)));
    const gameFps = gframe ? st(await gframe.evaluate(() => window.__raf.slice(-600))) : { fps: 0, p95: Infinity };
    check('A5', shellFps.fps >= 30 && gameFps.fps >= 30,
      `shell ${shellFps.fps} fps (p95 ${shellFps.p95} ms) / game ${gameFps.fps} fps (p95 ${gameFps.p95} ms), bar 30, loadavg ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);

    // A2b — drop the socket from under the shell and watch the bar.
    const before = await page.evaluate(() => document.getElementById('stat-step').textContent);
    stopBrain();                       // the real thing: the server goes away mid-loop
    await sleep(2500);
    const after = await page.evaluate(() => ({
      conn: document.getElementById('stat-conn').textContent,
      step: document.getElementById('stat-step').textContent,
      state: window.flugspiel.client.state() }));
    after.before = before;
    check('A2b', /^reconnecting in \d/.test(after.conn) && after.step === after.before && after.step !== '—',
      `after the server goes away: conn="${after.conn}" (state=${after.state}), step "${after.before}" -> "${after.step}" (frozen, not blanked)`);
  }
}

console.log('');
let failed = results.some((r) => !r.ok);
if (pageErrors.length) { failed = true; console.log('page errors:'); for (const e of pageErrors) console.log('  ' + e); }
console.log(`${results.filter((r) => r.ok && !r.skip).length} pass, ${results.filter((r) => !r.ok).length} fail, ${results.filter((r) => r.skip).length} skip`);
await browser.close();
server.close();
stopBrain();
process.exit(failed ? 1 : 0);
