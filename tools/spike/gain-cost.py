"""#29 — what does moving the LIF gain actually cost? Enumerated by measurement.

#29's body and the TL's comment on it both assert that lowering `gain` "invalidates the
calibration behind #3, #4 and #7". This prices that claim line by line, by re-running the
actual measurements through the **real** `Encoder` and `Decoder` at each operating point,
rather than estimating.

What it measures at every gain:

* **#3 R1** -- DNp01-L vs -R Hz under the shipped 0.30 injection into LC4+LPLC2-L.
* **#25 / #3** -- the fire ladder: fires per brain-minute at looming 0.000 / 0.112 / 0.447 /
  1.000, through `Decoder.decode()` with the shipped Schmitt band and charge integrator.
* **#27** -- pooled DNg100+MDN EMA, maximum at an empty sky and maximum under full looming.
  The question is whether the two distributions SEPARATE at a lower gain, which would make
  #27 fixable rather than impossible.
* **#4** -- fired neurons per step (deterministic) and steps/s (load-sensitive, flagged).
* **#7** -- pooled MBON rates for both reward compartments, and the eligibility-trace
  degeneracy: KC firing fraction and the across-KC variance of that fraction. `e === 1` is
  what makes #7's rule a per-compartment scalar.

READ-ONLY. `brain.params` is rebound in-process only; no config, no data, no trajectory
lock, nothing committed. The shipped point is `gain = 3.0`.

Run:

    .venv/bin/python tools/spike/gain-cost.py --seconds 60

Output shape (values live in issue #29 and SESSION_LOG.md):

    gain  DNp01_L  DNp01_R | fires/min @loom 0.000 0.112 0.447 1.000 | weap_rest weap_loom
    ...
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.brain.decoder import Decoder                         # noqa: E402
from src.brain.encoder import Encoder                         # noqa: E402
from src.brain.lif import FlyBrain, LIFParams                 # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping   # noqa: E402

DECODE_EVERY = 3        # brain steps per decode tick; #25's shipped default is 0.06 s
LOOMS = (0.000, 0.112, 0.447, 1.000)
Y = 0.35


def frame_for(loom_target: float, x: float = 0.12) -> dict:
    """A GameState whose `loom()` equals `loom_target`, via ttc = tau / loom."""
    base = {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [], "missiles": []}
    if loom_target <= 0.0:
        return base                                   # empty sky
    vy = (0.8472 - Y) * loom_target                   # ttc = (y_ground - y)/vy = 1/loom
    base["missiles"] = [{"x": x, "y": Y, "vx": 0.0, "vy": vy}]
    return base


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=60.0, help="brain seconds per cell")
    ap.add_argument("--gains", type=float, nargs="+", default=[1.0, 1.5, 2.0, 3.0])
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    base = brain.params
    dt = base.dt
    steps = int(args.seconds / dt)
    m = brain.meta
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    mapping = Mapping.load(raw)
    kc = np.flatnonzero(np.char.startswith(m.cell_type.astype(str), "KC"))
    dnp01_L, dnp01_R = brain.cells(["DNp01"], side="L"), brain.cells(["DNp01"], side="R")
    lc_L = brain.cells(["LC4", "LPLC2"], side="L")
    mbon = {c["name"]: brain.cells(list(c["mbon_types"]))
            for c in raw["reward"]["compartments"]}

    results = {}
    for g in args.gains:
        brain.params = LIFParams(dt=dt, tau=base.tau, gain=g, tonic=base.tonic,
                                 noise_hz=base.noise_hz, noise_amp=base.noise_amp,
                                 threshold=base.threshold, v_reset=base.v_reset)
        row: dict = {}

        # ---- #3 R1: the ipsi/contra fire drive, exactly the shipped 0.30 into LC4+LPLC2-L
        brain.reset(64)
        for _ in range(150):
            brain.step()
        inj = [(lc_L, np.full(len(lc_L), 0.30, dtype=np.float32))]
        cl = cr = 0
        hit = np.zeros(brain.n, dtype=bool)
        n1 = min(steps, 1500)
        for _ in range(n1):
            hit[:] = False
            hit[brain.step(inject=inj)] = True
            cl += hit[dnp01_L].sum()
            cr += hit[dnp01_R].sum()
        row["dnp01_L_hz"] = cl / len(dnp01_L) / n1 / dt
        row["dnp01_R_hz"] = cr / len(dnp01_R) / n1 / dt

        # ---- #25 fire ladder + #27 weapon separation + #4 work per step + #7 MBON/KC
        enc = Encoder(brain, mapping)
        ladder, weap_max = {}, {}
        for L in LOOMS:
            dec = Decoder(brain, mapping)
            dec.aim_zero = 0.0                 # skip calibrate(): 750 steps we do not need
            brain.reset(64)
            for _ in range(150):
                brain.step()
            dec.reset(readout=True)
            state = frame_for(L)
            inject = enc.encode(state, dec.crosshair_x).inject
            fires, wmax, fired_tot, kc_tot = 0, 0.0, 0, 0
            t0 = time.perf_counter()
            for i in range(steps):
                f = brain.step(inject=inject)
                dec.observe(f, dt)
                fired_tot += len(f)
                hit[:] = False
                hit[f] = True
                kc_tot += hit[kc].sum()
                wmax = max(wmax, dec.rates["weapon"])
                if (i + 1) % DECODE_EVERY == 0:
                    a = dec.decode(state, DECODE_EVERY * dt)
                    dec.on_result({"ok": True})
                    fires += a.get("action") == "fire"
            wall = time.perf_counter() - t0
            ladder[L] = fires / (steps * dt) * 60.0
            weap_max[L] = wmax
            if L == 0.000:
                row["fired_per_step"] = fired_tot / steps
                row["fire_pct"] = fired_tot / steps / brain.n * 100
                row["kc_pct"] = kc_tot / len(kc) / steps * 100
                row["steps_per_s"] = steps / wall           # LOAD-SENSITIVE
        row["ladder"] = {str(k): v for k, v in ladder.items()}
        row["weapon_rest_max_hz"] = weap_max[0.000]
        row["weapon_loom_max_hz"] = weap_max[1.000]

        # ---- #7: MBON pooled rates, and the eligibility trace's degeneracy
        brain.reset(64)
        for _ in range(150):
            brain.step()
        counts = {k: 0 for k in mbon}
        kc_per_step = []
        n2 = min(steps, 1500)
        for _ in range(n2):
            hit[:] = False
            hit[brain.step()] = True
            for k, idx in mbon.items():
                counts[k] += hit[idx].sum()
            kc_per_step.append(int(hit[kc].sum()))
        row["mbon_hz"] = {k: counts[k] / len(mbon[k]) / n2 / dt for k in mbon}
        kc_per_step = np.array(kc_per_step, dtype=np.float64)
        row["kc_frac_mean"] = float(kc_per_step.mean() / len(kc))
        row["kc_frac_sd"] = float(kc_per_step.std() / len(kc))

        print(f"gain={g:<4} DNp01 L/R = {row['dnp01_L_hz']:6.2f}/{row['dnp01_R_hz']:5.2f} Hz | "
              f"fires/min {' '.join(f'{ladder[L]:6.1f}' for L in LOOMS)} | "
              f"weapon rest/loom {row['weapon_rest_max_hz']:.3f}/{row['weapon_loom_max_hz']:.3f} | "
              f"fire {row['fire_pct']:.2f}% KC {row['kc_pct']:.1f}% "
              f"(sd {row['kc_frac_sd'] * 100:.2f}pp) | {row['steps_per_s']:.0f} steps/s | "
              f"MBON " + " ".join(f"{k}={v:.2f}" for k, v in row["mbon_hz"].items()), flush=True)
        results[str(g)] = row

    brain.params = base
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
