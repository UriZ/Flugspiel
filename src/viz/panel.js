// The brain visualization panel — #5 §5. **This body is #6's, not #5's.**
//
// #5 defines the interface and ships the placeholder below so the contract compiles and
// AC5 is measurable. #6 replaces the body of `createPanel`; the signature and the six
// methods are the contract and must not change.
//
// The data drawn here is real spike data from the real connectome — a placeholder
// *panel* is fine, a placeholder *brain* is not (`criteria.md`'s project bar). It is
// still not a neuron map: the cells are arbitrary slices of the packed vector, in
// packed order, and must not be presented as anatomy.

const COLS = 64;
const ROWS = 32;

/**
 * @param {HTMLCanvasElement} canvas owned by the shell, which sets .width/.height
 * @param {object} ready #4's `ready` message, verbatim. `ready.n` is authoritative
 *                       for the neuron count — read it, never hardcode 166700.
 * @returns {{resize:Function, push:Function, render:Function, setConnection:Function, destroy:Function}}
 */
export function createPanel(canvas, ready) {
  const ctx = canvas.getContext('2d');
  let geo = { cssW: 1, cssH: 1, dpr: 1, w: 1, h: 1 };
  let snapshot = null;
  let conn = 'connecting';

  return {
    /** Setting canvas.width resets 2D context state, so the shell writes the backing
     *  store first and this is the cue to rebuild transforms (§5.3). */
    resize(g) {
      geo = g;
      ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    },
    /** Must return promptly and must not draw — at ~19 Hz in and ~60 fps out the same
     *  snapshot is rendered about three times. */
    push(s) {
      snapshot = s;
    },
    render() {
      const { cssW: w, cssH: h } = geo;
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      if (snapshot) {
        const bytes = snapshot.spikes.bytes;
        const per = Math.max(1, Math.floor(bytes.length / (COLS * ROWS)));
        const cw = w / COLS;
        const ch = (h - 18) / ROWS;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            let bits = 0;
            const start = (r * COLS + c) * per;
            for (let i = start; i < start + per && i < bytes.length; i++) {
              // popcount of one byte, inline: this placeholder does not import the
              // codec's table, so #6 deleting the body deletes the whole dependency.
              let b = bytes[i];
              while (b) { bits += b & 1; b >>= 1; }
            }
            if (!bits) continue;
            ctx.fillStyle = `rgba(63, 168, 138, ${Math.min(1, bits / (per * 2))})`;
            ctx.fillRect(c * cw, 18 + r * ch, Math.max(1, cw - 1), Math.max(1, ch - 1));
          }
        }
      }

      ctx.fillStyle = '#6a6a6a';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const label = snapshot
        ? `${conn} · n=${ready.n} · step ${snapshot.step} · ${snapshot.spikes.popcount} firing`
        : `${conn} · n=${ready.n} · awaiting frames`;
      ctx.fillText(label, 6, 12);
    },
    setConnection(c) {
      conn = c;
    },
    destroy() {
      snapshot = null;
    },
  };
}
