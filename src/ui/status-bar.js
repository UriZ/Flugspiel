// The status bar — #5 §4, AC2.
//
// Four fields plus three controls. Everything is written with `textContent`; there is
// no `innerHTML` anywhere in the shell (§8). Every string below that originates on the
// server — `ready.backend`, `error.code` — arrives through that path.

import { createSpikeRate } from './spike-rate.js';

const EMPTY = '—';     // em dash

/**
 * Six digits that must not jitter the bar as they change.
 * Checked across 0, 999, 999.6, 1000, 14168, 707675, 999499, 999500, 1234567, NaN, -1,
 * Infinity -> 0, 999, 1k, 1k, 14k, 708k, 999k, 1.00M, 1.23M, em-dash, em-dash, em-dash.
 */
export const fmtRate = (v) => {
  if (!Number.isFinite(v) || v < 0) return EMPTY;
  const r = Math.round(v);
  return r < 1000 ? String(r) : r < 999500 ? `${Math.round(r / 1e3)}k` : `${(r / 1e6).toFixed(2)}M`;
};

const CONN_CLASS = { live: 'ok', connecting: 'warn', stale: 'warn', idle: 'dim',
                     closed: 'bad', superseded: 'bad', refused: 'bad' };

export function createStatusBar({ root, client, host }) {
  const el = {};
  for (const [id, label] of [['conn', 'brain'], ['step', 'step'],
                             ['score', 'score'], ['spikes', 'spikes/s']]) {
    const wrap = document.createElement('span');
    wrap.className = 'field';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'v';
    v.id = `stat-${id}`;
    v.textContent = EMPTY;
    wrap.append(k, v);
    root.append(wrap);
    el[id] = v;
  }

  const controls = document.createElement('span');
  controls.className = 'controls';
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    controls.append(b);
    return b;
  };
  const modeBtn = button('mode: human', () => {
    const fly = host.bridge.getMode() !== 'fly';
    host.bridge.setMode(fly ? 'fly' : 'human');
    if (fly) host.bridge.startEmitting();
    else host.bridge.stopEmitting();
  });
  const startBtn = button('start', () => host.bridge.startGame());
  const reconnectBtn = button('reconnect', () => client.reconnectNow());
  root.append(controls);

  let ready = null;
  let score = null;
  let detached = false;
  // Shared with #6's panel footer: two implementations would put two different spike
  // rates for the same brain on the same screen.
  const rate = createSpikeRate();
  const shown = {};

  const put = (key, text) => {
    if (shown[key] === text) return; // the DOM write is the expensive half, not the compare
    shown[key] = text;
    el[key].textContent = text;
  };

  const connText = (state) => {
    if (detached) return 'brain halted (bridge detached)';
    switch (state) {
      case 'live': return `live · ${ready?.backend ?? '?'}`;
      case 'connecting': return 'connecting…';
      case 'idle': return 'idle';
      case 'stale': return `stale ${((performance.now() - client.stats().lastFrameMs) / 1000).toFixed(1)}s`;
      case 'superseded': return 'taken by another tab';
      case 'refused': return 'origin refused';
      default: return `reconnecting in ${(client.retryInMs() / 1000).toFixed(1)}s`;
    }
  };

  return {
    setReady(r) {
      ready = r;
    },
    /** Every state the bridge emits passes through the transport, so `score` costs
     *  nothing extra — the shell never calls `bridge.getState()` on its own. */
    observeState(state) {
      score = state?.score;
    },
    observeError(e) {
      // #4 §3.4 makes this terminal: every later decode() is a noop and the server
      // never re-arms. Recovery is a page reload; the shell must not retry.
      if (e?.code === 'bridge_detached') detached = true;
    },
    render() {
      const state = client.state();
      put('conn', connText(state));
      if (el.conn.dataset.state !== CONN_CLASS[state]) el.conn.dataset.state = CONN_CLASS[state];

      const f = client.latest();
      rate.observe(f);
      // Frozen rather than blanked when the link drops: the last value is the evidence
      // of where it stopped, and the connection field already carries the state.
      put('step', f ? String(f.step) : EMPTY);
      put('score', Number.isFinite(score) ? String(score) : EMPTY);

      const spk = rate.perSecond();
      if (spk === null) {
        put('spikes', EMPTY);
      } else {
        put('spikes', fmtRate(spk));
        const title = rate.explain();
        if (el.spikes.title !== title) el.spikes.title = title;
      }

      const fly = host.bridge.getMode() === 'fly';
      const label = `mode: ${fly ? 'fly' : 'human'}`;
      if (modeBtn.textContent !== label) modeBtn.textContent = label;
      // applyAction is rejected outside a live round (`not_playing`), and setMode('fly')
      // alone does not start one — without this button the loop silently does nothing.
      startBtn.disabled = !fly || host.game?.state === 'playing';
      reconnectBtn.disabled = !['superseded', 'refused', 'closed'].includes(state);
    },
  };
}
