// The spikes/second estimator — #5 §4.2, shared by the status bar and #6's panel footer.
//
// NORMATIVE: the rate is `mean(popcount) * sim_hz`, **not** `mean(popcount) * observed
// frame rate`. The UI samples roughly 19 of the brain's ~50 steps per second, so the
// obvious version under-reports by about 2.6x and looks entirely plausible doing it.
//
// It lives in its own module because two places now put a spike rate on screen. A second
// implementation that drifted from this one would show two different rates for the same
// brain on the same screen, and it would read as a fault in the brain rather than in the
// UI.

const WINDOW = 20;          // frames in the ring, ~1.04 s at the measured 19.2 Hz

export function createSpikeRate() {
  const ring = [];
  let lastStep = -1;

  return {
    get size() { return ring.length; },

    /** Idempotent per step: the same snapshot is rendered about three times. */
    observe(frame) {
      if (!frame || frame.step === lastStep) return;
      lastStep = frame.step;
      ring.push({ pop: frame.spikes.popcount, recvMs: frame.recvMs, simHz: frame.meta.sim_hz });
      if (ring.length > WINDOW) ring.shift();
    },

    /** @returns {number|null} spikes per second, or null with no samples */
    perSecond() {
      if (!ring.length) return null;
      const mean = ring.reduce((a, r) => a + r.pop, 0) / ring.length;
      return mean * ring[ring.length - 1].simHz;
    },

    /** The tooltip both call sites show, so the caveat travels with the number. */
    explain() {
      if (!ring.length) return '';
      const simHz = ring[ring.length - 1].simHz;
      const span = ring.length > 1 ? (ring[ring.length - 1].recvMs - ring[0].recvMs) / 1000 : 0;
      const observed = span > 0 ? (ring.length - 1) / span : 0;
      return `estimated from ${Math.round(observed)} of ${Math.round(simHz)} steps/s `
           + '— the brain steps faster than the UI samples it';
    },

    reset() { ring.length = 0; lastStep = -1; },
  };
}
