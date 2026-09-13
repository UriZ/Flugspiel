// Per-pixel activity accumulation for one map pane — #6 §5.2.
//
// The property this exists to guarantee: **cost never scales with the number of firing
// neurons.** Both passes are bounded — one over the pane's members, one over its
// occupied pixels. The obvious alternative (bake the anatomy once, redraw only the lit
// neurons) is cheaper at a typical firing rate and collapses under a burst, which is a
// worse failure than being uniformly slower because it only appears when the brain is
// busy. See the spike on #6.
//
// Accumulate, never overwrite. Several neurons share a pixel at these densities, so
// last-writer-wins would silently drop most of them; here every neuron in a pixel
// contributes to that pixel's value, and "hidden" never means "dropped".
//
// Everything in the hot loop is integer against a lookup table. `rebuild()` is called
// only from the panel's `resize()`, which is why that is a separate method in #5's
// contract: it is the one place these buffers are allocated.

import { DECAY_LUT, FLOOR_LUT, GROUND32, RAMP_LUT } from './palette.js';

/** Fraction of a pixel's population that counts as full brightness. A single-neuron
 *  pixel is then binary, which is correct — it *is* one neuron — while dense pixels
 *  gain real gradation instead of flattening at the top of the ramp. */
const K_REFERENCE = 0.4;

export function createAccumulator() {
  let w = 0;
  let h = 0;
  let member = null;       // neuron indices belonging to this pane, ascending
  let memberPx = null;     // where each lands in this pane's buffer
  let total = null;        // neurons per pixel
  let occupied = null;     // pixels with total > 0
  let dens = null;         // floor-LUT index per occupied pixel
  let kRef = null;         // saturation reference per occupied pixel
  let level = null;        // current held value per occupied pixel, 0..255
  let lit = null;          // firing count per pixel, this snapshot
  let img = null;
  let u32 = null;

  const free = () => {
    member = memberPx = total = occupied = dens = kRef = level = lit = null;
    img = u32 = null;
  };

  return {
    get width() { return w; },
    get height() { return h; },
    get occupiedCount() { return occupied ? occupied.length : 0; },
    get image() { return img; },

    /**
     * Allocate for a pane rect in device pixels.
     * @param {CanvasRenderingContext2D} ctx only to mint the ImageData
     * @param {number} pw @param {number} ph pane size in device px
     * @param {Int32Array} indices neuron indices in this pane
     * @param {Uint16Array} uv normalised coordinates, 2 per neuron
     */
    rebuild(ctx, pw, ph, indices, uv) {
      free();
      w = Math.max(1, pw | 0);
      h = Math.max(1, ph | 0);
      const px = w * h;
      img = ctx.createImageData(w, h);
      u32 = new Uint32Array(img.data.buffer);
      u32.fill(GROUND32);

      member = indices;
      memberPx = new Uint32Array(indices.length);
      total = new Uint16Array(px);
      for (let j = 0; j < indices.length; j++) {
        const i = indices[j];
        const x = Math.min(w - 1, (uv[2 * i] / 65535) * w) | 0;
        const y = Math.min(h - 1, (uv[2 * i + 1] / 65535) * h) | 0;
        const p = y * w + x;
        memberPx[j] = p;
        if (total[p] < 65535) total[p]++;
      }

      let count = 0;
      for (let p = 0; p < px; p++) if (total[p]) count++;
      occupied = new Uint32Array(count);
      dens = new Uint8Array(count);
      kRef = new Uint16Array(count);
      level = new Uint8Array(count);
      let k = 0;
      for (let p = 0; p < px; p++) {
        if (!total[p]) continue;
        occupied[k] = p;
        const d = Math.min(15, Math.floor(Math.log2(total[p]) * 4));
        dens[k] = d;
        kRef[k] = Math.max(1, Math.round(K_REFERENCE * total[p]));
        u32[p] = FLOOR_LUT[d];
        k++;
      }
      lit = new Uint16Array(px);
    },

    /** The anatomy with no data — what `connecting` and `ready` show. Static, so it
     *  needs no wire data, and the real fly CNS from the first paint beats a spinner. */
    resetToFloor() {
      if (!occupied) return;
      for (let k = 0; k < occupied.length; k++) {
        level[k] = 0;
        u32[occupied[k]] = FLOOR_LUT[dens[k]];
      }
    },

    /**
     * Fold one snapshot in. Called once per *received* frame, not once per rAF.
     * @param {Uint8Array} bytes packed spike vector, `np.packbits` bit order
     */
    push(bytes) {
      if (!occupied) return;
      lit.fill(0);
      for (let j = 0; j < member.length; j++) {
        const i = member[j];
        if ((bytes[i >> 3] >> (7 - (i & 7))) & 1) lit[memberPx[j]]++;
      }
      for (let k = 0; k < occupied.length; k++) {
        const p = occupied[k];
        const c = lit[p];
        let v = DECAY_LUT[level[k]];
        if (c) {
          const ref = kRef[k];
          const s = c >= ref ? 255 : ((c * 255) / ref) | 0;
          if (s > v) v = s;
        }
        level[k] = v;
        u32[p] = v ? RAMP_LUT[v >> 2] : FLOOR_LUT[dens[k]];
      }
    },

    /** Advance the decay without new data — what keeps a `stale` link visibly fading
     *  to floor instead of freezing on its last frame. */
    decayOnly() {
      if (!occupied) return;
      for (let k = 0; k < occupied.length; k++) {
        const v = DECAY_LUT[level[k]];
        level[k] = v;
        u32[occupied[k]] = v ? RAMP_LUT[v >> 2] : FLOOR_LUT[dens[k]];
      }
    },

    blit(ctx, x, y) {
      if (img) ctx.putImageData(img, x, y);
    },

    destroy: free,
  };
}

/** Split neuron indices by pane, once per artifact load. */
export function paneMembers(pane, paneId) {
  let count = 0;
  for (let i = 0; i < pane.length; i++) if (pane[i] === paneId) count++;
  const out = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < pane.length; i++) if (pane[i] === paneId) out[k++] = i;
  return out;
}
