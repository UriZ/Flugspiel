// Headless DOM/Canvas stub — enough for the real upstream `Game` to construct,
// update, render and fire without a browser. Spec #2 §6.1.
//
// Why a hand-rolled Proxy instead of jsdom: jsdom's `canvas.getContext('2d')`
// returns `null` unless the native `canvas` package is installed, and `Renderer`
// dereferences the context in its constructor. Verified by execution against
// upstream 458c3fb — see tools/spike/upstream-seam.mjs.
//
// Import for side effects BEFORE importing any vendored game module:
//   import { makeCanvas } from '../helpers/dom-stub.js';

const NOOP = () => {};

function makeCtx() {
  const gradient = { addColorStop: NOOP };
  return new Proxy({ canvas: null }, {
    get(t, p) {
      if (p in t) return t[p];
      return () => {
        if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return gradient;
        if (p === 'measureText') return { width: 0 };
        if (p === 'getImageData') return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        return undefined;
      };
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

export function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    getContext: () => makeCtx(),
    addEventListener: NOOP, removeEventListener: NOOP,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  };
}

// A recursive no-op Web Audio graph. `Audio.init()` builds real buffers and chains
// nodes (`ctx.createGain().gain.setValueAtTime(...)`), so a bare `{state:'running'}`
// object throws on the first `createBuffer`. Any property is a callable proxy that
// returns another one, so arbitrary node chains are safe; the few members whose
// *value* is read get real ones. Reached via `bridge.startGame()`, which runs the
// game's own `audio.init()` path.
function audioNode(overrides = {}) {
  const cache = new Map();
  return new Proxy(function () {}, {
    get(_t, p) {
      if (p in overrides) return overrides[p];
      if (p === 'then') return undefined;               // must not look thenable
      if (p === Symbol.toPrimitive || p === 'valueOf') return () => 0;
      if (!cache.has(p)) cache.set(p, audioNode());
      return cache.get(p);
    },
    set(_t, p, v) { cache.set(p, v); return true; },
    apply: () => audioNode(),
    construct: () => audioNode(),
  });
}

const AUDIO_CTX = {
  state: 'running',
  currentTime: 0,
  sampleRate: 44100,
  resume: async () => {},
  close: async () => {},
  createBuffer: (numberOfChannels, length, sampleRate) => ({
    numberOfChannels, length, sampleRate, duration: length / sampleRate,
    getChannelData: () => new Float32Array(length),
  }),
  // Resolves rather than throws: `Audio.init()` (reached via bridge.startGame())
  // fetches and decodes its radio/thunder clips, and upstream `console.warn`s every
  // failure. Succeeding silently keeps the suite's output readable.
  decodeAudioData: async () => ({ numberOfChannels: 1, length: 1, sampleRate: 44100, duration: 1 / 44100 }),
};

globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = () => 0;   // the game loop never auto-runs; tests drive update(dt)
globalThis.cancelAnimationFrame = NOOP;
globalThis.document = { createElement: (t) => (t === 'canvas' ? makeCanvas() : {}) };
globalThis.window = {
  innerWidth: 1280, innerHeight: 720,
  addEventListener: NOOP, removeEventListener: NOOP,
  AudioContext: class { constructor() { return audioNode(AUDIO_CTX); } },
};
globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } set src(v) {} get src() { return ''; } };
// Offline by construction: never touches the network, always resolves an empty but
// well-formed response. See decodeAudioData above for why it does not throw.
globalThis.fetch = async () => ({
  ok: true, status: 200,
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
});
