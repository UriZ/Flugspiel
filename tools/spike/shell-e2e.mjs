// End-to-end probe for #5 — the shell's closed loop against the REAL #4 server.
//
//   .venv/bin/python src/server/ws_server.py --port 8111 &      # wait for /healthz
//   node tools/spike/shell-e2e.mjs [--brain-port 8111] [--seconds 15]
//
// Proves the browser half of the loop that the #5 spec designs, against a live
// brain rather than a fixture:
//   H  a cross-origin fetch of /healthz from the shell's origin is BLOCKED
//      (#4 mounts no CORSMiddleware) -> the shell must NOT gate on /healthz
//   I  the WebSocket handshake from that same origin is ACCEPTED
//      (WS is not subject to CORS; #4's own Origin allowlist admits localhost:*)
//   J  `ready` arrives with n / backend / sim_hz / populations
//   K  the closed loop runs: bridge state -> ws -> frame{action,snapshot} ->
//      bridge.applyAction -> result -> ws, at the bridge's 20 Hz emit rate
//   L  packbits+base64 spikes decode in the browser; popcount is plausible and
//      the decode cost is a small fraction of a 50 ms frame budget
//   M  the shell's rAF loop and the game's rAF loop both stay >= 30 fps while
//      the loop is running
//   N  a second connection evicts the incumbent with close code 4409 "superseded"
//      -> the shell must NOT auto-reconnect on 4409 (two tabs would storm)
//
// Expected output — Darwin 23.6.0, node v22.22.0, puppeteer 25.10.0, headless
// Chrome, viewport 1600x900, 15 s window, #4 server on numba, 2026-09-13:
//   H  cross-origin fetch /healthz -> blocked: TypeError: Failed to fetch      PASS
//   I  ws handshake from http://localhost:<p> accepted                         PASS
//   J  ready n=166700 backend=numba sim_hz=50 dn=1314 regions=27               PASS
//   K  frames=~280 rate=~19 Hz  actions applied=~280 rejected=0 results sent=~280
//   L  spikes n=166700 bytes=20838 popcount ~6000-20000  decode ~0.05-0.3 ms   PASS
//   M  shell ~60 fps / game ~60 fps, both >= 30                                PASS
//   N  incumbent closed code=4409 reason="superseded", newcomer alive=true      PASS
// Exit 0 iff every check passes. Numbers vary run to run; the bars are the check.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire('/Users/urizonens/dev/Flugspiel/package.json');
const puppeteer = require_('puppeteer');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const BRAIN_PORT = +arg('brain-port', 8111);
const SECONDS = +arg('seconds', 15);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

const DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#0a0a0a}
#app{display:grid;grid-template-columns:var(--split,1fr) 6px 1fr;grid-template-rows:1fr 28px;height:100%}
#viz,#game{position:relative;overflow:hidden}
#status{grid-column:1/-1;color:#ccc;font:12px ui-monospace,monospace;padding:6px}
canvas,iframe{display:block;width:100%;height:100%;border:0}
</style></head><body><div id="app">
<div id="viz"><canvas id="vc"></canvas></div><div id="divider" data-role="divider"></div>
<div id="game"><iframe id="gf" src="/game.html" title="game"></iframe></div>
<div id="status">…</div></div>
<script>
// Synthetic stand-in for #6's panel: draws from the latest packed snapshot only.
const c = document.getElementById('vc'), ctx = c.getContext('2d');
window.__latest = null;
(function loop(){
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,w,h);
  const s = window.__latest;
  if (s) for (let i = 0; i < 1000; i++) {
    ctx.fillStyle = (s.bytes[i % s.bytes.length] & 1) ? '#3fa' : '#173';
    ctx.fillRect((i*37)%w, (i*61)%h, 2, 2);
  }
  requestAnimationFrame(loop);
})();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__shell.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(DOC); }
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

const results = [];
const check = (id, ok, detail) => results.push({ id, ok, detail });

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
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
await page.goto(`http://localhost:${port}/__shell.html`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1500));

// H — cross-origin /healthz
const h = await page.evaluate(async (bp) => {
  try { const r = await fetch(`http://127.0.0.1:${bp}/healthz`); return { ok: true, body: await r.text() }; }
  catch (e) { return { ok: false, err: `${e.name}: ${e.message}` }; }
}, BRAIN_PORT);
check('H', h.ok === false, `cross-origin fetch /healthz -> ${h.ok ? 'ALLOWED ' + h.body : 'blocked: ' + h.err}`);

// I/J/K/L — the closed loop, driven from the parent document through contentWindow.
const run = await page.evaluate(async (bp, seconds) => {
  const gf = document.getElementById('gf');
  const w = gf.contentWindow;
  const stats = { frames: 0, results: 0, applied: 0, rejected: {}, decodeMs: [], pop: [],
                  steps: [], ready: null, closed: null, firstFrameMs: null };

  // base64 -> Uint8Array, plus a popcount over the packed bytes. This is exactly the
  // decode the spec puts in the shell; measured here so the number is not invented.
  const POP = new Uint8Array(256);
  for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];
  const unb64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

  const t0 = performance.now();
  const ws = new WebSocket(`ws://127.0.0.1:${bp}/brain`);
  const opened = await new Promise((res) => {
    ws.addEventListener('open', () => res(true), { once: true });
    ws.addEventListener('error', () => res(false), { once: true });
    setTimeout(() => res(false), 5000);
  });
  if (!opened) return { opened: false, stats };

  ws.addEventListener('close', (e) => { stats.closed = { code: e.code, reason: e.reason }; });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ready') { stats.ready = m; return; }
    if (m.type === 'error') { (stats.rejected[m.code] = (stats.rejected[m.code] || 0) + 1); return; }
    if (m.type !== 'frame') return;
    if (stats.firstFrameMs === null) stats.firstFrameMs = performance.now() - t0;
    stats.frames++;
    stats.steps.push(m.step);
    const sp = m.snapshot && m.snapshot.spikes;
    if (sp) {
      const d0 = performance.now();
      const bytes = unb64(sp.bits);
      let pop = 0;
      for (let i = 0; i < bytes.length; i++) pop += POP[bytes[i]];
      stats.decodeMs.push(performance.now() - d0);
      stats.pop.push(pop);
      window.__latest = { n: sp.n, bytes };
      stats.nbytes = bytes.length; stats.n = sp.n;
    }
    // Close the loop: apply the brain's action and report the outcome back.
    const r = w.bridge.applyAction(m.action);
    stats.applied += r.ok ? 1 : 0;
    if (!r.ok) stats.rejected[r.reason] = (stats.rejected[r.reason] || 0) + 1;
    if (m.ack_seq !== null && m.ack_seq !== undefined) {
      ws.send(JSON.stringify({ type: 'result', seq: m.ack_seq, result: r }));
      stats.results++;
    }
  });

  // Wire the game: fly mode, leave the start screen, stream state over the socket.
  w.bridge.setMode('fly');
  w.bridge.setTransport({ send: (state) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state }));
  } });
  w.bridge.startEmitting();
  w.bridge.startGame();

  await new Promise((r) => setTimeout(r, seconds * 1000));
  const bstats = w.bridge.getStats();
  w.bridge.stopEmitting();
  ws.close();
  return { opened: true, stats, bstats, phase: w.game.state, origin: location.origin };
}, BRAIN_PORT, SECONDS);

const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

check('I', run.opened === true, `ws handshake from ${run.origin || 'http://localhost:' + port} ${run.opened ? 'accepted' : 'REFUSED'}`);
const rd = run.stats.ready;
check('J', !!rd && rd.n === 166700 && typeof rd.sim_hz === 'number' && rd.populations && rd.regions,
  rd ? `ready n=${rd.n} backend=${rd.backend} sim_hz=${rd.sim_hz} dn=${rd.populations.descending} regions=${rd.regions.length} ac2=${rd.ac2_capable}`
     : 'no ready message');
const rate = run.stats.frames / SECONDS;
check('K', run.stats.frames > 0 && rate >= 15 && rate <= 25 && run.stats.results > 0,
  `frames=${run.stats.frames} rate=${rate.toFixed(1)} Hz applied=${run.stats.applied} results=${run.stats.results} rejected=${JSON.stringify(run.stats.rejected)} emitted=${run.bstats ? run.bstats.emitted : '?'} phase=${run.phase} first frame ${run.stats.firstFrameMs === null ? 'n/a' : run.stats.firstFrameMs.toFixed(0) + ' ms'}`);
const dm = med(run.stats.decodeMs), pm = med(run.stats.pop);
check('L', run.stats.n === 166700 && run.stats.nbytes === Math.ceil(166700 / 8) && dm < 5 && pm > 0,
  `spikes n=${run.stats.n} bytes=${run.stats.nbytes} popcount median=${pm} (${(100 * pm / 166700).toFixed(2)}% firing) decode+popcount median=${dm.toFixed(3)} ms`);

// N — eviction. #4 is newest-wins: a second connection closes the incumbent with
// 4409 "superseded". The shell MUST NOT auto-reconnect on 4409, or two open tabs
// evict each other forever in a reconnect storm.
const ev = await page.evaluate(async (bp) => {
  const open = (u) => new Promise((res) => { const w = new WebSocket(u);
    w.addEventListener('open', () => res(w), { once: true });
    w.addEventListener('error', () => res(null), { once: true }); });
  const a = await open(`ws://127.0.0.1:${bp}/brain`);
  if (!a) return { err: 'first socket did not open' };
  const closedA = new Promise((res) => a.addEventListener('close', (e) => res({ code: e.code, reason: e.reason }), { once: true }));
  const b = await open(`ws://127.0.0.1:${bp}/brain`);
  if (!b) return { err: 'second socket did not open' };
  const ca = await Promise.race([closedA, new Promise((r) => setTimeout(() => r({ code: 0, reason: 'timeout' }), 3000))]);
  const bAlive = b.readyState === 1;
  b.close();
  return { ca, bAlive };
}, BRAIN_PORT);
check('N', !ev.err && ev.ca && ev.ca.code === 4409 && ev.bAlive === true,
  ev.err ? ev.err : `incumbent closed code=${ev.ca.code} reason=${JSON.stringify(ev.ca.reason)}, newcomer alive=${ev.bAlive}`);

const stats = (times) => { const d = []; for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  if (d.length < 2) return { fps: 0, p95: Infinity }; d.sort((a, b) => a - b);
  return { fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p95: +d[Math.floor(0.95 * d.length)].toFixed(1) }; };
const frame = page.frames().find((f) => f.url().includes('game.html'));
const shellFps = stats(await page.evaluate(() => window.__raf));
const gameFps = frame ? stats(await frame.evaluate(() => window.__raf.slice(-600))) : { fps: 0, p95: Infinity };
check('M', shellFps.fps >= 30 && gameFps.fps >= 30,
  `shell ${shellFps.fps} fps (p95 ${shellFps.p95} ms) / game ${gameFps.fps} fps (p95 ${gameFps.p95} ms), bar 30`);

console.log('');
let failed = false;
for (const r of results) { if (!r.ok) failed = true; console.log(`${r.id}  ${r.detail}\n   -> ${r.ok ? 'PASS' : 'FAIL'}`); }
if (pageErrors.length) { failed = true; console.log('\npage errors:'); for (const e of pageErrors) console.log('  ' + e); }
console.log('');
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
