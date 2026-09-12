// Browser WebSocket client for #4's brain server — #5 §6, §7.
//
// Readiness and reconnect are driven by the socket alone. #4 mounts no CORSMiddleware,
// so a cross-origin fetch of `/healthz` from this page fails with `TypeError: Failed to
// fetch` (measured — `tools/spike/shell-e2e.mjs` check H). WebSocket is not subject to
// CORS, so **the handshake is the readiness probe**. Do not add a /healthz poll.

import { decodeSpikes } from './spike-codec.js';

const DEFAULT_URL = 'ws://127.0.0.1:8000/brain';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const STALE_MS = 1000;
const BAD_LOG_EVERY = 100;
const DERIVE_MS = 250;

/** @typedef {'connecting'|'live'|'idle'|'stale'|'closed'|'superseded'|'refused'} ConnState */

/** Server-controlled numbers are coerced at the boundary: a NaN otherwise reaches the
 *  DOM as literal "NaN", and a non-finite sim_hz makes spikes/s meaningless silently. */
const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Resolve the endpoint, honouring `?brain=` but **only for loopback**. Unrestricted,
 * the shell would be a generic WebSocket viewer that any link can aim at a server of
 * the sender's choosing, whose JSON then reaches the renderer (§8).
 */
export function resolveUrl(search = location.search) {
  const raw = new URLSearchParams(search).get('brain');
  if (!raw) return DEFAULT_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    console.warn(`?brain=${raw} is not a URL; using ${DEFAULT_URL}`);
    return DEFAULT_URL;
  }
  if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !LOOPBACK.has(u.hostname)) {
    console.warn(`?brain=${raw} is not ws(s):// on loopback; using ${DEFAULT_URL}`);
    return DEFAULT_URL;
  }
  return u.href;
}

/**
 * @param {object} opts
 * @param {string}   [opts.url]
 * @param {Function} [opts.onReady] `ready` message, verbatim
 * @param {Function} [opts.onFrame] a decoded Snapshot
 * @param {Function} [opts.onConn]  ConnState changed (drives `panel.setConnection`)
 * @param {Function} [opts.onError] a non-fatal `{type:"error"}` from the server
 */
export function createBrainClient({ url = resolveUrl(), onReady, onFrame, onConn, onError } = {}) {
  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {ConnState} */
  let conn = 'connecting';
  let ready = null;
  let latest = null;
  let attempt = 0;
  let retryAt = 0;
  let timer = null;
  let deliberate = false;
  let lastFrameMs = -Infinity;
  let lastStateMs = -Infinity;
  const stats = { frames: 0, bad: 0, lastFrameMs: 0 };

  const setConn = (next) => {
    if (next === conn) return;
    conn = next;
    onConn?.(conn);
  };

  // `idle` vs `stale` is a real distinction, not decoration: before the user starts the
  // loop the bridge emits nothing, so no frames arrive and a single "stale" would accuse
  // a healthy server. 1000 ms is ~19 frame intervals at the measured 19.2 Hz.
  const derive = () => {
    if (!ws || ws.readyState > WebSocket.OPEN) return; // closed states belong to onclose
    if (!ready) return setConn('connecting');
    const now = performance.now();
    if (now - lastFrameMs < STALE_MS) return setConn('live');
    if (now - lastStateMs < STALE_MS) return setConn('stale');
    setConn('idle');
  };

  const bad = (err) => {
    stats.bad++;
    // Throttled: a server stuck emitting bad frames at 19 Hz would flood the console
    // and slow the page, which looks like the defect rather than reporting it.
    if (stats.bad % BAD_LOG_EVERY === 1) console.warn(`bad frame #${stats.bad}:`, err);
  };

  const takeFrame = (m) => {
    const sn = m.snapshot || {};
    const spikes = decodeSpikes(sn.spikes);
    // `n` is authoritative and bounds-checked. packbits pads to a byte, so a length that
    // is not ceil(n/8) means the vector is not the one `ready` promised.
    if (!ready || spikes.n !== ready.n || spikes.bytes.length !== Math.ceil(spikes.n / 8)) {
      throw new Error(`spikes n=${spikes.n} ${spikes.bytes.length}B != ready n=${ready?.n}`);
    }
    latest = {
      step: num(m.step),
      ackSeq: Number.isInteger(m.ack_seq) ? m.ack_seq : null,
      session: num(m.session),
      action: m.action,
      spikes,
      regions: sn.regions || {},
      descending: sn.descending || {},
      reward: sn.reward || {},
      meta: { ...sn.meta, sim_hz: num(sn.meta?.sim_hz) },
      recvMs: performance.now(),
    };
    lastFrameMs = latest.recvMs;
    stats.frames++;
    stats.lastFrameMs = latest.recvMs;
    derive();
    onFrame?.(latest);
  };

  const schedule = () => {
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    // The counter resets on `ready`, not on `open`: a socket that opens and is
    // immediately evicted has not succeeded.
    attempt++;
    const delay = base * (0.75 + Math.random() * 0.5);
    retryAt = performance.now() + delay;
    timer = setTimeout(connect, delay);
  };

  function connect() {
    clearTimeout(timer);
    timer = null;
    deliberate = false;
    ready = null;
    setConn('connecting');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      bad(e);
      return schedule();
    }
    ws.addEventListener('open', derive);
    ws.addEventListener('message', (ev) => {
      // The whole handler is guarded: `atob` throws on bad base64 and `JSON.parse` on
      // bad JSON, and one corrupt frame must not kill the render loop (R3).
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'frame') takeFrame(m);
        else if (m.type === 'ready') { ready = m; attempt = 0; derive(); onReady?.(m); }
        else if (m.type === 'error') onError?.(m);
        // `pong` is ignored: the shell does not ping. The socket's own close is the signal.
      } catch (e) {
        bad(e);
      }
    });
    ws.addEventListener('close', (e) => {
      ready = null;
      if (deliberate) return setConn('closed');
      // Never auto-retry 4409: #4 is newest-wins, so two shell tabs that both reconnect
      // evict each other forever and thrash Decoder.reset() on the server (R5).
      if (e.code === 4409) return setConn('superseded');
      // Never auto-retry 4403: a retry cannot change the Origin header, so it would loop.
      if (e.code === 4403) return setConn('refused');
      schedule();          // before setConn, so a listener can read retryInMs()
      setConn('closed');
    });
    ws.addEventListener('error', () => {}); // 'close' carries the decision; this silences it
  }

  const send = (obj) => {
    // Must never throw: `FlyBridge._afterFrame` swallows a transport throw into a
    // counter (fly-bridge.js:248-255), which is survivable but hides the cause. A
    // dropped state is the correct behaviour for a latest-wins transport.
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  };

  setInterval(derive, DERIVE_MS); // `stale` is a time-based transition, not an event

  return {
    connect,
    close() {
      deliberate = true;
      clearTimeout(timer);
      timer = null;
      ws?.close();
    },
    reconnectNow() {
      clearTimeout(timer);
      attempt = 0;
      ws?.close();
      connect();
    },
    sendState(state) {
      if (send({ type: 'state', state })) lastStateMs = performance.now();
    },
    sendResult(seq, result) {
      send({ type: 'result', seq, result });
    },
    state: () => conn,
    ready: () => ready,
    latest: () => latest,
    retryInMs: () => Math.max(0, retryAt - performance.now()),
    stats: () => ({ ...stats }),
    url,
  };
}
