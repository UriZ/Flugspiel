// Hosting probe for #5 — does the vendored game survive being put in a panel?
//
//   node tools/spike/shell-hosting.mjs
//
// The vendored Renderer sizes its canvas from `window.innerWidth/innerHeight` and
// letterboxes 2560x1440 into it (src/game/vendor/engine/renderer.js:32-47), and
// Input converts pointer events with `screenToLogical(e.clientX, e.clientY)`
// (engine/input.js:39-43) — i.e. it assumes the canvas fills the viewport at the
// origin. `src/game/vendor/` may not be modified (#2 AC6, hash-enforced). So the
// question "iframe or same-document?" is a question about those two assumptions.
//
// Eight checks, each a fact the #5 spec depends on:
//   A same-document: canvas sizes to the WINDOW, not to its panel  -> overflow
//   B iframe:        canvas sizes to the IFRAME content box        -> fits panel
//   C iframe:        the inner window.resize fires when the PARENT resizes the
//                    <iframe> element (divider drag / media query restack)
//   D iframe:        parent reaches window.game / window.bridge through
//                    contentWindow (same-origin) -> #2's console access survives
//   E iframe:        a pointer event at the panel's centre maps to logical
//                    (1280, 720) +/- 1 -> aiming is not offset
//   F iframe:        keydown on the PARENT document does not reach the game's
//                    window-level key listeners -> no cross-panel key leakage
//   G iframe:        the FLY's aim path bypasses the renderer entirely, so aim
//                    precision does not depend on how wide the panel is
//   O iframe:        keys DO reach the game once the panel is focused, by click or
//                    by contentWindow.focus() -> still human-playable
//
// Expected output — Darwin 23.6.0, node v22.22.0, puppeteer 25.10.0, headless
// Chrome, viewport 1600x900, 2026-09-13. All six PASS:
//   A  same-doc canvas css 1600x900 vs panel 797x872 -> overflows            PASS
//   B  iframe inner innerWidth=797 innerHeight=872 == panel 797x872          PASS
//   C  iframe resize fired (1 event); scale 0.3113 -> 0.1930                 PASS
//   D  contentWindow.bridge.getMode()="human" getEmitRate()=20               PASS
//   E  iframe centre(399,436) -> logical 1281.6,720.0 (1280,720 +/- 3.2)     PASS
//   G  fly aim {0.25,0.75} -> virtual 640,1080, phase=playing                PASS
//   F  parent keydown seen by game input: false                              PASS
//   O  keys reach the game after click=true, after contentWindow.focus()=true PASS
// Checks print in completion order (G before F). Exit 0 iff all eight pass.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const puppeteer = require_('puppeteer');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

// Two throwaway pages served from memory so nothing lands in the repo.
const SAME_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box }
html,body { width:100%; height:100%; overflow:hidden; background:#0a0a0a }
#app { display:grid; grid-template-columns:1fr 6px 1fr; grid-template-rows:1fr 28px; height:100% }
#viz,#game { position:relative; overflow:hidden }
#status { grid-column:1/-1 }
canvas { display:block; position:absolute; top:0; left:0 }
</style></head><body><div id="app">
<div id="viz"></div><div id="divider"></div><div id="game"><canvas id="c"></canvas></div><div id="status"></div>
</div><script type="module">
import { createGame } from '/src/game/index.js';
const { game, bridge } = createGame(document.getElementById('c'));
window.game = game; window.bridge = bridge;
</script></body></html>`;

const IFRAME_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box }
html,body { width:100%; height:100%; overflow:hidden; background:#0a0a0a }
#app { display:grid; grid-template-columns:var(--split,1fr) 6px 1fr; grid-template-rows:1fr 28px; height:100% }
#viz,#game { position:relative; overflow:hidden }
#status { grid-column:1/-1 }
iframe { display:block; width:100%; height:100%; border:0 }
</style></head><body><div id="app">
<div id="viz"></div><div id="divider" data-role="divider"></div>
<div id="game"><iframe id="gf" src="/game.html" title="game"></iframe></div><div id="status"></div>
</div></body></html>`;

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__samedoc.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(SAME_DOC); }
  if (p === '/__iframe.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(IFRAME_DOC); }
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

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); };

// ── A: same-document ────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`http://localhost:${port}/__samedoc.html`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500));
  const m = await page.evaluate(() => {
    const c = document.getElementById('c'), panel = document.getElementById('game');
    const cr = c.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    return { cw: Math.round(cr.width), ch: Math.round(cr.height), pw: Math.round(pr.width), ph: Math.round(pr.height) };
  });
  const overflows = m.cw > m.pw + 1 || m.ch > m.ph + 1;
  check('A', overflows, `same-doc canvas css ${m.cw}x${m.ch} vs panel ${m.pw}x${m.ph} -> ${overflows ? 'overflows' : 'fits'}`);
  await page.close();
}

// ── B-F: iframe ─────────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`http://localhost:${port}/__iframe.html`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500));
  const frame = page.frames().find((f) => f.url().includes('game.html'));
  if (!frame) { check('B', false, 'no game iframe'); }
  else {
    const panel = await page.evaluate(() => {
      const r = document.getElementById('game').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    const inner = await frame.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    check('B', inner.w === panel.w && inner.h === panel.h,
      `iframe inner innerWidth=${inner.w} innerHeight=${inner.h} == panel ${panel.w}x${panel.h}`);

    // C — parent-driven resize must reach the inner window, or the canvas goes stale.
    await frame.evaluate(() => { window.__resizes = 0; addEventListener('resize', () => window.__resizes++); });
    const before = await frame.evaluate(() => ({ w: innerWidth, s: window.game.renderer.scale }));
    await page.evaluate(() => document.getElementById('app').style.setProperty('--split', '1100px'));
    await new Promise((r) => setTimeout(r, 600));
    const after = await frame.evaluate(() => ({ w: innerWidth, s: window.game.renderer.scale, n: window.__resizes }));
    check('C', after.n > 0 && after.w !== before.w && after.s !== before.s,
      `iframe resize fired on parent-driven panel resize (${after.n} event(s)); innerWidth ${before.w}->${after.w}, renderer.scale ${before.s.toFixed(4)}->${after.s.toFixed(4)}`);
    await page.evaluate(() => document.getElementById('app').style.removeProperty('--split'));
    await new Promise((r) => setTimeout(r, 600));

    // D — #2's QA console access must survive the move into a frame.
    const d = await page.evaluate(() => {
      const w = document.getElementById('gf').contentWindow;
      try { return { mode: w.bridge.getMode(), hz: w.bridge.getEmitRate(), phase: w.game.state }; }
      catch (e) { return { err: String(e) }; }
    });
    check('D', d.mode === 'human' && d.hz === 20,
      `contentWindow.bridge.getMode()=${JSON.stringify(d.mode)} getEmitRate()=${d.hz} game.state=${JSON.stringify(d.phase)}`);

    // E — aim must not be offset by the panel's position in the parent document.
    // `MouseEvent.clientX` is a long, so a fractional coordinate is TRUNCATED by the
    // constructor. Dispatch integers and allow one CSS pixel of quantization, which
    // at this panel width is 1/scale logical px -- an artefact of the probe, not of
    // the hosting. (Dispatching innerWidth/2 = 398.5 lands at 398 and reads 1278.4.)
    const e = await frame.evaluate(() => {
      const r = window.game.renderer, c = r.canvas;
      const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
      c.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
      return { x: window.game.input.mouseX, y: window.game.input.mouseY, cx, cy, scale: r.scale,
               ex: (cx - r.offsetX) / r.scale, ey: (cy - r.offsetY) / r.scale };
    });
    const tol = 1 / e.scale; // one CSS px, in logical units
    check('E', Math.abs(e.x - e.ex) < 1e-6 && Math.abs(e.y - e.ey) < 1e-6
            && Math.abs(e.x - 1280) <= tol && Math.abs(e.y - 720) <= tol,
      `iframe centre(${e.cx},${e.cy}) -> logical ${e.x.toFixed(1)},${e.y.toFixed(1)} (1280,720 +/- ${tol.toFixed(1)})`);

    // G — the FLY's aim does not go through the renderer at all:
    // applyAction -> toLogical() -> VirtualInput.aim() -> input.mouseX. So fly aim
    // precision is independent of the panel size, while the human pointer's is not.
    // `applyAction` rejects with `not_playing` outside a live round, so leave the
    // start screen first -- otherwise this measures the seed, not the aim.
    await frame.evaluate(() => { window.bridge.setMode('fly'); window.bridge.startGame(); });
    await new Promise((r) => setTimeout(r, 1500));
    const g = await frame.evaluate(() => {
      const res = window.bridge.applyAction({ action: 'aim', x: 0.25, y: 0.75 });
      const v = { x: window.bridge.virtual.x, y: window.bridge.virtual.y };
      const phase = window.game.state, scale = window.game.renderer.scale;
      window.bridge.setMode('human');
      return { res, v, phase, scale };
    });
    check('G', g.res.ok === true && g.v.x === 640 && g.v.y === 1080,
      `fly aim {0.25,0.75} -> virtual ${g.v.x},${g.v.y} (expect 640,1080) phase=${g.phase} scale=${g.scale.toFixed(4)}`);

    // F — the game's key listeners are on ITS window; a parent keypress must not reach them.
    await frame.evaluate(() => { window.game.input._keysDown.clear(); });
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('ArrowLeft');
    await new Promise((r) => setTimeout(r, 200));
    const leaked = await frame.evaluate(() => window.game.input.arrowLeft || window.game.input._keysDown.size > 0);
    check('F', leaked === false, `parent keydown seen by game input: ${leaked}`);

    // O — the flip side of F: with the game panel focused, keys MUST reach it, or
    // the iframe decision breaks "game stays human-playable" (project criterion).
    // Tested both ways the focus can arrive: a real click in the panel, and an
    // explicit contentWindow.focus() from the shell.
    const keyReaches = async (how) => {
      await frame.evaluate(() => { window.game.input._keysDown.clear(); window.game.input.arrowLeft = false; });
      if (how === 'click') {
        const box = await (await page.$('#gf')).boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await page.evaluate(() => document.getElementById('gf').contentWindow.focus());
      }
      await page.keyboard.down('ArrowLeft');
      await new Promise((r) => setTimeout(r, 200));
      const seen = await frame.evaluate(() => window.game.input.arrowLeft);
      await page.keyboard.up('ArrowLeft');
      return seen;
    };
    const byClick = await keyReaches('click');
    const byFocus = await keyReaches('focus');
    check('O', byClick === true && byFocus === true,
      `keys reach the game after click=${byClick}, after contentWindow.focus()=${byFocus}`);
  }
  await page.close();
}

console.log('');
let failed = false;
for (const r of results) { if (!r.ok) failed = true; console.log(`${r.id}  ${r.detail.padEnd(78)} ${r.ok ? 'PASS' : 'FAIL'}`); }
console.log('');
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
