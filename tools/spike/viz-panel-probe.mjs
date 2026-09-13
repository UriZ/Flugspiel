// Drives the real #6 panel through every state and screenshots each one, without a
// brain server: the user's is on port 8000 and #4 is newest-wins, so connecting to it
// would evict their live session.
//
//   node tools/spike/viz-panel-probe.mjs [--dpr 2] [--seconds 4] [--out DIR]
//
// Synthetic frames match the measured wire: 8.50% firing, 19.2 Hz, `regions` counts
// derived from the artifact's real class sizes, `descending.active` as real slots.
// Screenshots go to a durable directory, not os.tmpdir() — they are the evidence.
//
// Reports fps and render cost with the loadavg they were taken under. AC6 is 30+ fps
// with full 166k data; check the `panel` column, which is the panel's own render rate.
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
const DPR = +arg('dpr', 2);
const SECONDS = +arg('seconds', 4);
const OUT = path.resolve(arg('out', path.join(ROOT, 'tools/spike/out/viz-panel')));
const HEADFUL = argv.includes('--headful');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.bin': 'application/octet-stream', '.json': 'application/json' };

const FIXTURE = await fs.readFile(path.join(ROOT, 'tools/spike/viz-panel-probe.html'), 'utf8');
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__probe.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FIXTURE); }
  try {
    const f = path.join(ROOT, p);
    const body = await fs.readFile(f);
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { if (p !== '/favicon.ico') console.warn(`probe 404: ${p}`);
    res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
await fs.mkdir(OUT, { recursive: true });

const load = () => os.loadavg().map((n) => n.toFixed(2)).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: !HEADFUL, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
// The browser requests /favicon.ico on its own and the probe server has none; that
// 404 is the harness, not the panel.
page.on('console', (m) => {
  // The console message for a failed subresource does not name the URL; the location
  // does. Filtering on the text alone lets the favicon 404 through every time.
  const url = m.location?.().url || '';
  if (m.type() === 'error' && !url.includes('favicon')) errors.push(`console: ${m.text()} ${url}`);
});
page.on('requestfailed', (r) => { if (!r.url().includes('favicon')) errors.push('request failed: ' + r.url()); });
await page.goto(`http://localhost:${port}/__probe.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__probe?.ready === true, { timeout: 20000 });

const env = await page.evaluate(() => window.__probe.env());
console.log(`\npanel ${env.cssW}x${env.cssH} css @ dpr ${env.dpr}   layout v${env.layoutVersion} n=${env.n}`);
console.log(`cores ${os.cpus().length} logical / 8 physical   headless=${!HEADFUL}   loadavg ${load()}`);
console.log(`brain pane ${env.brainPx} device px, ${env.brainOccupied} occupied`);

const shot = async (name) => {
  const p = path.join(OUT, `${name}.png`);
  await (await page.$('#viz-panel')).screenshot({ path: p });
  return p;
};

// ---- states -------------------------------------------------------------------
const STATES = [
  ['connecting-no-frames', { conn: 'connecting', frames: false }],
  ['live-8.5pct', { conn: 'live', frames: true, firing: 0.085 }],
  ['live-50pct-burst', { conn: 'live', frames: true, firing: 0.5 }],
  ['stale-fading', { conn: 'stale', frames: false, after: 'live' }],
  ['idle-disconnected', { conn: 'idle', frames: false, after: 'live' }],
  ['reward-unimplemented', { conn: 'live', frames: true, firing: 0.085, reward: 'unimplemented' }],
  ['reward-live-events', { conn: 'live', frames: true, firing: 0.085, reward: 'live' }],
  ['reward-loop-off', { conn: 'live', frames: true, firing: 0.085, reward: 'off' }],
  ['layout-mismatch', { conn: 'live', frames: true, firing: 0.085, breakLayout: true }],
];

console.log('\n=== states ===');
for (const [name, opts] of STATES) {
  await page.evaluate((o) => window.__probe.setState(o), opts);
  await sleep(opts.after ? 2200 : 1400);
  console.log(`  ${name.padEnd(24)} ${await shot(name)}`);
}

// ---- sizes: the degradation ladder ---------------------------------------------
console.log('\n=== degradation ladder ===');
await page.evaluate(() => window.__probe.setState({ conn: 'live', frames: true, firing: 0.085 }));
for (const [w, h] of [[797, 872], [640, 760], [500, 640], [400, 560], [320, 460], [240, 300]]) {
  await page.evaluate(([a, b]) => window.__probe.setSize(a, b), [w, h]);
  await sleep(900);
  // The ladder is verified by reading the screenshots, not by a self-report: a panel
  // that believes it dropped a zone and still draws it would pass a self-report.
  console.log(`  ${String(w).padStart(3)}x${String(h).padStart(3)}  ${await shot(`size-${w}x${h}`)}`);
}
await page.evaluate(() => window.__probe.setSize(797, 872));
await sleep(600);

// ---- performance ----------------------------------------------------------------
console.log('\n=== performance (AC6: 30+ fps with full 166k data) ===');
console.log('firing  panel-fps  render-med  render-p95  push-med   loadavg');
for (const firing of [0.085, 0.25, 0.5]) {
  await page.evaluate((f) => window.__probe.setState({ conn: 'live', frames: true, firing: f }), firing);
  await sleep(800);
  const before = load();
  await page.evaluate(() => window.__probe.resetStats());
  await sleep(SECONDS * 1000);
  const s = await page.evaluate(() => window.__probe.stats());
  console.log(`${(firing * 100).toFixed(1).padStart(5)}%  ${String(s.fps).padStart(9)}  ` +
    `${s.renderMed.toFixed(2).padStart(10)}  ${s.renderP95.toFixed(2).padStart(10)}  ` +
    `${s.pushMed.toFixed(2).padStart(8)}   ${before}`);
}

console.log(`\nloadavg now ${load()}   (8 physical / 16 logical cores)`);
console.log(`screenshots: ${OUT}`);
if (errors.length) { console.log('\npage errors:'); for (const e of [...new Set(errors)]) console.log('  ' + e); }
else console.log('no page errors');
await browser.close();
server.close();
process.exit(0);
