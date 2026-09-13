// Panel palette and lookup tables — #6 §5.1, §5.2.
//
// The shell's tokens (`--ok`, `--warn`, `--bad`) are reused verbatim so the panel and
// the status bar read as one instrument.
//
// The ordering constraint that matters: the anatomy floor's brightest value sits below
// the activity ramp's dimmest, so a dense quiet region can never be mistaken for a
// sparse active one. Tune the hex values within that ordering, not across it.
//
// The ramp is single-hue on purpose. Position carries identity; brightness carries
// activity alone. Amber, magenta and red are reserved for descending neurons, the
// prosthesis and valence, so a non-teal pixel in this panel always means something.

export const C = {
  ground: '#0a0a0a',
  rule: '#1c1c1c',
  chromeDim: '#5a5a5a',
  chrome: '#8a8a8a',
  text: '#c8c8c8',
  key: '#6a6a6a',
  idle: '#2a2a2a',
  tickIdle: '#1f1f1f',
  ok: '#3fa88a',
  warn: '#d2a24c',
  bad: '#d05a4a',
  dn: '#d2a24c',
  dnReadout: '#f0c674',
  prosthetic: '#c77bd4',
};

export const FONT = (px) => `${px}px ui-monospace, SFMono-Regular, Menlo, monospace`;

/** '#rrggbb' -> 0xAABBGGRR, the byte order of a Uint32 view over ImageData. */
export const rgba32 = (hex, a = 255) => {
  const v = parseInt(hex.slice(1), 16);
  return ((a << 24) | (((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff))) >>> 0;
};

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Piecewise-linear ramp through `stops`, as 0xAABBGGRR, `steps` entries. */
function rampLUT(stops, steps) {
  const rgb = stops.map((h) => {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  });
  const out = new Uint32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const f = t - k;
    const r = lerp(rgb[k][0], rgb[k + 1][0], f);
    const g = lerp(rgb[k][1], rgb[k + 1][1], f);
    const b = lerp(rgb[k][2], rgb[k + 1][2], f);
    out[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
}

/** Static per-pixel density of the anatomy — the map with no data on the wire. */
export const FLOOR_LUT = rampLUT(['#0e1a18', '#17332c'], 16);

/** Firing. Its top is a bright mint, never white: whiteout is structurally impossible
 *  and a 50% burst has to look different from 8.5%, not merely saturated. */
export const RAMP_LUT = rampLUT(['#2c7f68', '#3fa88a', '#62cfa6', '#8ff0d0'], 64);

/** Peak-hold decay, applied once per received snapshot. A spike flashes to full and
 *  falls below the ramp floor in ~8 frames; a binary-per-frame map at 19 Hz is a 52 ms
 *  flash that reads as scintillation rather than as a wave moving across the anatomy. */
export const DECAY = 0.72;
export const DECAY_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  // Forced strictly downward. `Math.round(1 * 0.72)` is 1, a fixed point, and a level
  // that sticks at 1 paints the ramp's dimmest teal over the anatomy floor forever —
  // every pixel that ever fired would stay lit, and an idle or disconnected panel would
  // keep showing activity it is no longer receiving.
  const v = Math.round(i * DECAY);
  DECAY_LUT[i] = v >= i ? Math.max(0, i - 1) : v;
}

/** CSS string for an activity level, for the zones that draw with `fillStyle` rather
 *  than into an ImageData — today that is the raster.
 *
 *  Takes the same 0..255 level the ImageData path takes and quantises it the same way,
 *  `>> 2`. That is not a detail: the raster's rows are fractions chosen so a brightness
 *  means the same thing there as on the map, and a ramp that rounded instead of
 *  truncating would move some levels one LUT step away from the map's colour for the
 *  same value. One ramp, one quantisation, or the comparison the raster exists for is
 *  off by a step nobody can see. */
export const rampCss = (v) => {
  const u = RAMP_LUT[Math.max(0, Math.min(63, v >> 2))];
  return `rgb(${u & 0xff}, ${(u >> 8) & 0xff}, ${(u >> 16) & 0xff})`;
};

export const GROUND32 = rgba32(C.ground);
