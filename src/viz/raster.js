// Population raster — #6 §7. Driven entirely by `snapshot.regions`.
//
// `regions` is a per-superclass count of neurons that fired on the emitted step, already
// on the wire for free. Nothing here scans the bit vector.
//
// Rows are FRACTIONS of each class, not raw counts: `ol_intrinsic` has 89,403 neurons
// and `vnc_motor` has 708, so raw counts would make one row the entire display. The
// fraction is also what lets the raster share the map's ramp and `K` treatment, so a
// given brightness means the same thing in both — that coupling is deliberate.
//
// Backed by a ring buffer rather than a `drawImage(canvas, -1, 0)` self-blit: a self-blit
// accumulates resampling artifacts at fractional dpr and cannot survive a resize, while
// a ring re-renders exactly at any size.
//
// A stalled link writes gap columns and keeps the time axis honest. The raster never
// freezes and never repeats its last value — a gap in the data has to look like a gap.

import { C, FONT, RAMP_LUT } from './palette.js';

/** 15 of the 27 classes have fewer than 500 neurons; a row for an 8-neuron class is
 *  noise at any height. They merge into `other` and the sum is preserved. */
export const ROWS = [
  { key: 'ol_sensory', group: 'SENSORY' },
  { key: 'cb_sensory', group: null },
  { key: 'vnc_sensory', group: null },
  { key: 'sensory_ascending', group: null },
  { key: 'ol_intrinsic', group: 'VISUAL' },
  { key: 'visual_projection', group: null },
  { key: 'visual_centrifugal', group: null },
  { key: 'cb_intrinsic', group: 'CENTRAL' },
  { key: 'descending_neuron', group: 'OUTPUT', emphasis: true },
  { key: 'ascending_neuron', group: 'VNC' },
  { key: 'vnc_intrinsic', group: null },
  { key: 'vnc_motor', group: 'MOTOR' },
  { key: null, group: null, label: 'other' },     // every class not named above
];

const K_REFERENCE = 0.4;      // same saturation reference as the map (§5.2)
const GAP = 250;              // the value written into a gap column

export function createRaster() {
  let cols = 0;
  let cells = null;           // Uint8Array[cols * ROWS.length], 0..255 or GAP
  let head = -1;              // newest column index, -1 = empty
  let filled = 0;
  let sizes = null;           // denominator per row
  let otherKeys = null;

  return {
    get columns() { return cols; },
    get filled() { return filled; },

    /** Denominators come from `ready.regions`, which is authoritative for class sizes. */
    setClasses(regionNames, classSizes) {
      const named = new Set(ROWS.map((r) => r.key).filter(Boolean));
      otherKeys = regionNames.filter((k) => !named.has(k));
      sizes = ROWS.map((r) => (r.key
        ? (classSizes[r.key] || 0)
        : otherKeys.reduce((a, k) => a + (classSizes[k] || 0), 0)));
    },

    resize(nCols) {
      const next = Math.max(1, nCols | 0);
      if (next === cols) return;
      cols = next;
      cells = new Uint8Array(cols * ROWS.length);
      head = -1;
      filled = 0;
    },

    /** One column per RECEIVED frame. At 19 Hz in and 60 fps out the same snapshot is
     *  rendered about three times and must not produce three columns. */
    push(regions) {
      if (!cells || !sizes) return;
      head = (head + 1) % cols;
      filled = Math.min(cols, filled + 1);
      const base = head * ROWS.length;
      for (let r = 0; r < ROWS.length; r++) {
        const n = sizes[r];
        let count = 0;
        if (ROWS[r].key) count = regions[ROWS[r].key] || 0;
        else for (const k of otherKeys) count += regions[k] || 0;
        // Fraction against the class size, then the map's own saturation reference, so
        // brightness carries the same meaning here as in the anatomy.
        const f = n > 0 ? count / n : 0;
        cells[base + r] = Math.max(0, Math.min(255, Math.round((f / K_REFERENCE) * 255)));
      }
    },

    /** A column the data never arrived for. Distinct from a zero column, which means
     *  "the frame arrived and nothing fired". */
    pushGap() {
      if (!cells) return;
      head = (head + 1) % cols;
      filled = Math.min(cols, filled + 1);
      cells.fill(GAP, head * ROWS.length, (head + 1) * ROWS.length);
    },

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{x,y,w,h}} rect zone rect in css px, including the label gutter
     * @param {object} opts `{gutter, labels: 'class'|'group'|'none', axis: boolean,
     *                        windowSec: number}`
     */
    render(ctx, rect, opts) {
      const { gutter, labels, axis, windowSec } = opts;
      const axisH = axis ? 14 : 0;
      const plotX = rect.x + gutter;
      const plotW = Math.max(1, rect.w - gutter);
      const plotH = Math.max(1, rect.h - axisH);
      const rowH = plotH / ROWS.length;

      ctx.fillStyle = '#070707';
      ctx.fillRect(plotX, rect.y, plotW, plotH);

      if (cells && filled) {
        const colW = plotW / cols;
        for (let c = 0; c < filled; c++) {
          // Anchored to the RIGHT edge: the newest column is always at `now`, and a
          // partly-filled ring grows leftwards from it. Anchoring left instead puts
          // fresh data at -30s and leaves `now` permanently blank.
          const idx = (head - (filled - 1 - c) + cols * 2) % cols;
          const x = plotX + plotW - (filled - c) * colW;
          const base = idx * ROWS.length;
          for (let r = 0; r < ROWS.length; r++) {
            const v = cells[base + r];
            if (v === GAP) ctx.fillStyle = '#2a1a1a';
            else if (!v) continue;
            else {
              const u = RAMP_LUT[Math.min(63, v >> 2)];
              ctx.fillStyle = `rgb(${u & 0xff},${(u >> 8) & 0xff},${(u >> 16) & 0xff})`;
            }
            ctx.fillRect(x, rect.y + r * rowH, Math.max(1, colW + 0.5), Math.max(1, rowH));
          }
        }
      }

      // Group separators only — 1px between the six groups, not between every row.
      ctx.fillStyle = C.rule;
      for (let r = 1; r < ROWS.length; r++) {
        if (ROWS[r].group) ctx.fillRect(plotX, Math.round(rect.y + r * rowH), plotW, 1);
      }
      if (ROWS[8].emphasis) {           // the output path is the row that matters
        ctx.fillStyle = '#333';
        ctx.fillRect(plotX, Math.round(rect.y + 8 * rowH), plotW, 1);
        ctx.fillRect(plotX, Math.round(rect.y + 9 * rowH), plotW, 1);
      }

      if (labels !== 'none' && gutter > 8) {
        ctx.textAlign = 'right';
        for (let r = 0; r < ROWS.length; r++) {
          const row = ROWS[r];
          const y = rect.y + r * rowH + rowH / 2 + 3;
          if (labels === 'class') {
            ctx.font = FONT(10);
            ctx.fillStyle = row.emphasis ? C.text : C.key;
            ctx.fillText(row.label || row.key, plotX - 6, y);
          } else if (row.group) {
            ctx.font = FONT(9);
            ctx.fillStyle = C.chromeDim;
            ctx.fillText(row.group, plotX - 6, y);
          }
        }
        ctx.textAlign = 'left';
      }

      if (axis) {
        const y = rect.y + plotH;
        ctx.fillStyle = '#222';
        ctx.font = FONT(9);
        const step = 5;
        for (let s = step; s < windowSec; s += step) {
          const x = plotX + plotW * (1 - s / windowSec);
          ctx.fillRect(Math.round(x), y, 1, 4);
          ctx.fillStyle = C.chromeDim;
          ctx.fillText(`-${s}s`, Math.round(x) + 2, y + 12);
          ctx.fillStyle = '#222';
        }
        ctx.fillStyle = '#8ff0d0';
        ctx.fillRect(plotX + plotW - 1, rect.y, 1, plotH);    // now
      }
    },

    destroy() { cells = null; sizes = null; otherKeys = null; },
  };
}
