// #52 — is the caption honesty check REACHED, and does it change what the panel draws?
//
//   node tools/spike/viz-honesty.mjs [--poison off]
//
// `captionIsSafe()` shipped with zero call sites: the mechanism enforcing #7's honesty
// clause in the UI never executed, so a claim that drifted into a caption was caught by
// nothing. Proving the fix needs both arms driven through the real `createPanel` — that
// the clean captions pass, and that a poisoned one is caught — because a guard that only
// works when called directly is the defect, not the fix.
//
// `--poison KEY` rewrites one caption in the SERVED copy of `src/viz/dopamine.js`. The
// working tree is never touched: a probe that edits the module it is testing can leave a
// mutation behind when it dies mid-run.
//
// The poisoned key defaults to `off`, which is NOT the state the panel renders first.
// That is the point: a render-time check would only ever see the caption for the current
// state, so a claim sitting in an unselected one would go unnoticed until the reward loop
// was disabled. The module-load check sees all four.
//
// Exit 0 always — this is a measurement, not a gate.

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require_('puppeteer');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const POISON_KEY = arg('poison', 'off');
// Two forbidden words at once, so a regex that lost one alternative still fails the run.
const POISON_TEXT = 'Reward loop disabled — training improves the fly.';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.bin': 'application/octet-stream', '.json': 'application/json' };

const FIXTURE = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>#52</title>
<style>html,body{margin:0;height:100%;background:#111}#p{width:900px;height:872px}
canvas{display:block;width:100%;height:100%}</style></head>
<body><div id="p"><canvas id="c"></canvas></div><script type="module">
import { createPanel } from '/src/viz/panel.js';
const N = 166700;
const ready = { type:'ready', protocol:1, n:N, backend:'numba', sim_hz:50, step_dt:0.02,
  ac2_capable:true, regions:[], populations:{}, prosthetic_sites:[] };
const canvas = document.getElementById('c');
const host = document.getElementById('p');
const ctx = canvas.getContext('2d');
const panel = createPanel(canvas, ready);
let step = 1000;
const frame = (reward) => ({ step: (step += 3), ackSeq:null, session:1, action:null,
  spikes:{ n:N, bytes:new Uint8Array(Math.ceil(N/8)), popcount:0 }, regions:{},
  descending:{ active: [] }, reward,
  meta:{ sim_hz:50, dropped:0, rejected:0, unassigned:0, errors:{} }, recvMs: performance.now() });
const geo = () => { const r = host.getBoundingClientRect(); const d = 1;
  canvas.width = r.width; canvas.height = r.height;
  panel.resize({ cssW:r.width, cssH:r.height, dpr:d, w:canvas.width, h:canvas.height }); };
geo();
/** Every string the panel draws in one render, captured from the real fillText calls. */
window.__texts = (reward) => {
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.fillText;
  const seen = [];
  proto.fillText = function patched(t, x, y, m) { if (this === ctx) seen.push({ t, fill: this.fillStyle }); return orig.call(this, t, x, y, m); };
  try { panel.push(frame(reward)); panel.render(performance.now()); } finally { proto.fillText = orig; }
  return seen;
};
window.__ready = true;
</script></body></html>`;

let dopamineSrc = await fs.readFile(path.join(ROOT, 'src/viz/dopamine.js'), 'utf8');
const CAPTION_RE = new RegExp(`(\\n\\s*${POISON_KEY}:\\s*)'[^']*'`);
if (!CAPTION_RE.test(dopamineSrc)) {
  console.error(`no caption named ${POISON_KEY} in dopamine.js — nothing to poison`);
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__honesty.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FIXTURE); }
  if (p === '/src/viz/dopamine.js' && poisoned) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(dopamineSrc.replace(CAPTION_RE, `$1'${POISON_TEXT}'`));
  }
  try {
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT)) throw new Error('escape');
    const body = await fs.readFile(f);
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
let poisoned = false;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

const REWARDS = {
  unimplemented: { value: 0, source: 'unimplemented', session_changed: false },
  off: { enabled: false, value: 0, cumulative: 0, source: 'disabled', session_changed: false,
         events: { reward: 0, punish: 0 }, prosthetic_sites: [] },
};

async function arm(label) {
  const page = await browser.newPage();
  const errors = [];
  // A missing favicon is a browser fetch, not the module under test.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 960, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${base}/__honesty.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__ready', { timeout: 20000 });

  const out = {};
  for (const [state, reward] of Object.entries(REWARDS)) {
    const texts = await page.evaluate((r) => window.__texts(r), reward);
    // By the caption's own opening words, not by a keyword: "DOPAMINE" is the zone
    // title and is drawn first, so a loose match reports the title as the caption.
    const cap = texts.find((t) => /^(#7 not implemented|Reward loop disabled|Injected dopamine|Caption withheld)/.test(t.t));
    out[state] = cap ? { text: cap.t, fill: cap.fill } : null;
  }
  await page.close();
  console.log(`[${label}] console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  for (const [state, cap] of Object.entries(out)) {
    console.log(`[${label}] state=${state.padEnd(14)} caption=${cap ? `"${cap.text}" ${cap.fill}` : '(none drawn)'}`);
  }
  return { errors, out };
}

console.log(`poisoning CAPTION.${POISON_KEY} with "${POISON_TEXT}" · `
  + `loadavg ${os.loadavg()[0].toFixed(2)}`);
poisoned = false;
const clean = await arm('clean');
poisoned = true;
const dirty = await arm('poisoned');

await browser.close();
server.close();

const ok = clean.errors.length === 0
  && dirty.errors.length === 1
  && /caption\(s\)/.test(dirty.errors[0])
  && !/withheld/i.test(clean.out[POISON_KEY]?.text ?? '')
  && /withheld/i.test(dirty.out[POISON_KEY]?.text ?? '');
console.log(ok
  ? 'BOTH ARMS as designed: clean loads silently and draws its caption; the poisoned one '
    + 'is caught at module load, reported once, and drawn as withheld.'
  : 'UNEXPECTED — read the two arms above.');
