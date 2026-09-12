"""Spike: can a KC->MBON weight change be observed anywhere the game reads? #7 §3.

Runs the real brain under the one encoder channel that drives a readout (LC4+LPLC2-L at
+0.30, the looming site), scales the KC->MBON block of W, and measures MBON and
descending-neuron rates over 5 seeds. Also reports which populations are rate-saturated.

    PYTHONPATH=. python tools/spike/reward-reachability.py        # ~6 min, numba backend

Rates below are deterministic per (seed, backend, params) and are NOT load-sensitive;
only wall-clock throughput is. Expected output (numba, seeds 64,1,2,3,4, 400 steps,
100 warm-up, pooled spikes/s over the whole named population):

    saturation: 7543/166700 neurons fire on every step; KC 4064/4064; MBON 78/97
    PAM11 and PPL101 fire on EVERY step at baseline, and injecting +2.0 or +5.0
      into PAM11 leaves its rate at the 750.00 Hz ceiling (15 cells x 50 Hz)
    KC->MBON scale   MBON25,MBON34      DNp01
              x0.0    42.4 +/- 1.4     17.73 +/- 0.38
              x0.5   140.4 +/- 2.2     17.83 +/- 0.20
              x1.0   246.1 +/- 0.4     17.60 +/- 0.25
              x2.0   284.6 +/- 0.5     17.80 +/- 0.25

    => MBON25,MBON34 is graded and monotone (40-70 sd between adjacent levels).
    => DNp01 is flat across a 4x weight range (< 1 sd). The mushroom body output does
       not reach the game readout; DNp01 receives 0.0000 of its input from MBONs.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from src.brain.connectome import load
from src.brain.lif import FlyBrain

ROOT = Path(__file__).resolve().parents[2]
SEEDS = (64, 1, 2, 3, 4)
STEPS, WARM = 400, 100
# PPL101's compartment: the only one with dynamic range in both directions (PAM11's
# MBON07 sits at the 50 Hz ceiling, so upward modulation there is invisible).
PUNISH_MBON = ("MBON25,MBON34", "MBON20", "MBON30", "MBON11")


def main() -> None:
    W, m = load(ROOT / "data")
    ct = m.cell_type
    kc = np.flatnonzero(np.char.startswith(ct, "KC"))
    mb = np.flatnonzero(np.char.startswith(ct, "MBON"))
    loom = np.flatnonzero(np.isin(ct, ["LC4", "LPLC2"]) & (m.side == "L"))
    pam11, ppl101 = np.flatnonzero(ct == "PAM11"), np.flatnonzero(ct == "PPL101")
    watch = {"MBON25,MBON34": np.flatnonzero(ct == "MBON25,MBON34"),
             "DNp01": np.flatnonzero(ct == "DNp01")}

    Wc = W.tocsc()
    col = np.repeat(np.arange(m.n), np.diff(Wc.indptr))
    is_kc = np.zeros(m.n, bool); is_kc[kc] = True
    post = np.zeros(m.n, bool); post[np.isin(ct, PUNISH_MBON)] = True
    sel = np.flatnonzero(is_kc[col] & post[Wc.indices])

    def run(scale, seed, inject_pam=0.0):
        Wm = Wc.copy()
        Wm.data[sel] *= np.float32(scale)
        b = FlyBrain(Wm, m, seed=seed)
        inj = [(loom, np.float32(0.30))]
        if inject_pam:
            inj.append((pam11, np.float32(inject_pam)))
        counts = {k: 0 for k in watch} | {"pam11": 0}
        per = np.zeros(m.n, np.int32)
        mask = np.zeros(m.n, bool)
        for s in range(STEPS):
            f = b.step(inject=inj)
            if s < WARM:
                continue
            per[f] += 1
            mask[f] = True
            for k, v in watch.items():
                counts[k] += int(mask[v].sum())
            counts["pam11"] += int(mask[pam11].sum())
            mask[f] = False
        T = (STEPS - WARM) * b.params.dt
        return {k: v / T for k, v in counts.items()}, per / (STEPS - WARM)

    _, frac = run(1.0, 64)
    sat = frac >= 0.999
    print(f"saturation: {int(sat.sum())}/{m.n} neurons fire on every step; "
          f"KC {int(sat[kc].sum())}/{len(kc)}; MBON {int(sat[mb].sum())}/{len(mb)}")
    print(f"PAM11 every-step: {bool(sat[pam11].all())}  PPL101 every-step: {bool(sat[ppl101].all())}")
    for amt in (0.0, 2.0, 5.0):
        r, _ = run(1.0, 64, inject_pam=amt)
        print(f"  PAM11 pooled rate with inject +{amt}: {r['pam11']:.2f} Hz (ceiling {len(pam11)*50:.2f})")

    print("KC->MBON scale   " + "   ".join(f"{k:>16s}" for k in watch))
    for scale in (0.0, 0.5, 1.0, 2.0):
        rows = [run(scale, s)[0] for s in SEEDS]
        cells = []
        for k in watch:
            v = np.array([r[k] for r in rows])
            cells.append(f"{v.mean():10.2f} +/- {v.std(ddof=1):5.2f}")
        print(f"          x{scale:<4} " + "   ".join(cells))


if __name__ == "__main__":
    main()
