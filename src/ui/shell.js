// Shell entry point — #5 §5.4. Builds everything and owns the single rAF loop.
//
// One requestAnimationFrame chain for the whole document. Two independent loops (one in
// the panel, one for the bar) would read layout twice per frame and make the AC5
// measurement ambiguous — `shell-fps.mjs` dedupes on the rAF timestamp precisely because
// counting callbacks over-reports. The game's loop is the vendored one inside the
// iframe and is not ours.

import { createBrainClient, resolveUrl } from './brain-client.js';
import { createGameHost } from './game-host.js';
import { createSplit } from './split.js';
import { createStatusBar } from './status-bar.js';
import { createPanel } from '../viz/panel.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const vizPanel = $('viz-panel');
const canvas = $('viz-canvas');
const gamePanel = $('game-panel');
const gameFrame = $('game-frame');

let panel = null;
let statusBar = null;
let host = null;
let geometryDirty = true;
let raf = 0;

const client = createBrainClient({
  url: resolveUrl(),
  onReady(ready) {
    statusBar?.setReady(ready);
    // Created once, after the first `ready`, so #6 has n / regions / populations before
    // it allocates. Survives a reconnect: the panel outlives the socket (§7.4).
    if (!panel) {
      panel = createPanel(canvas, ready);
      panel.setConnection(client.state());
      geometryDirty = true;
    }
  },
  onFrame(f) {
    panel?.push(f);
    host?.applyAction(f);
  },
  onConn(c) {
    panel?.setConnection(c);
  },
  onError(e) {
    statusBar?.observeError(e);
  },
});

host = await createGameHost({
  frame: gameFrame,
  client,
  onState: (s) => statusBar?.observeState(s),
});

statusBar = createStatusBar({ root: $('status-bar'), client, host });

const split = createSplit({ app, divider: $('divider'), onResize: () => { geometryDirty = true; } });
const narrow = matchMedia('(max-width: 767px)');
split.setAxis(narrow.matches);
narrow.addEventListener('change', (e) => {
  split.setAxis(e.matches);
  geometryDirty = true;
});

// The observer fires continuously during a divider drag, so it only raises a flag; the
// work happens once per frame in the loop. A panel reallocating a 166k-element buffer
// per observation would stall the drag.
new ResizeObserver(() => { geometryDirty = true; }).observe(vizPanel);

// The game only receives keys once its frame has focus — check F is the feature (a
// keystroke aimed at the shell must not switch the game's weapon), check O is the price.
gamePanel.addEventListener('pointerdown', () => host.focusGame());

function applyGeometry() {
  if (!panel || !geometryDirty) return;
  geometryDirty = false;
  const r = vizPanel.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  // Backing store first, then resize(): setting canvas.width clears the canvas and
  // resets the 2D context, so a panel can never draw into a stale buffer (§5.2).
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  panel.resize({ cssW: r.width, cssH: r.height, dpr, w, h });
}

const tick = (now) => {
  applyGeometry();
  panel?.render(now);
  statusBar.render(now);
  raf = requestAnimationFrame(tick);
};

client.connect();
raf = requestAnimationFrame(tick);

addEventListener('pagehide', () => {
  cancelAnimationFrame(raf);
  client.close();
  panel?.destroy();
});

/** Console / QA handle, analogous to #2's `window.bridge` (§2.4). */
window.flugspiel = {
  client,
  host,
  split,
  get panel() { return panel; },
  get bridge() { return host.bridge; },
};
