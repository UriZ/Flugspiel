"""Spike — the numeric contract the #3 decoder spec states as normative.

Run:  .venv/bin/python tools/spike/decoder-contract.py       (~3 min, needs data/*.npz)

Expected output (MaleCNS v1.0, LIFParams defaults, tau_d=0.5 s, k_turn=1.0 /s, dead=0.15):

  aim zero (u=0, 3 seeds x 12 s):        0.451 / 0.278 / 0.259  -> Z = 0.330, sd 0.09
  sign accuracy of (index - Z) vs u:     |u|>=0.2 -> 0.93..1.00
  saturated traverse x 0.0 -> 0.95:      1.54 s, identical on all 3 seeds
  no-signal random walk of x over 12 s:  sd 0.16..0.36, reaches both rails
  fire Schmitt (on 3 Hz / off 1 Hz):     0-1 events / 10 s with no looming (1 of 3 seeds);
                                         3/3 seeds latched before the first measured step
                                         with looming +0.3
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.brain.lif import FlyBrain  # noqa: E402

TAU_D, TAU_F, K_TURN, DEAD = 0.5, 0.25, 1.0, 0.15
FIRE_ON, FIRE_OFF, A_TOT = 3.0, 1.0, 2.0


def main():
    b = FlyBrain.load(seed=0)
    dt = b.params.dt
    pl, pr = b.cells(["PFL3"], side="L"), b.cells(["PFL3"], side="R")
    al, ar = b.cells(["DNa02"], side="L"), b.cells(["DNa02"], side="R")
    p01 = b.cells(["DNp01"])
    loom = np.concatenate([b.cells(["LC4"]), b.cells(["LPLC2"])])
    a_d, a_f = 1 - np.exp(-dt / TAU_D), 1 - np.exp(-dt / TAU_F)

    def trace(u, seed, steps, settle, loom_amp=0.0):
        """Yield (index, fire_ema) per step after `settle`. u>0 biases PFL3 right."""
        inj = [(pl, np.float32(A_TOT * (1 - u) / 2)), (pr, np.float32(A_TOT * (1 + u) / 2))]
        if loom_amp:
            inj.append((loom, np.float32(loom_amp)))
        b.reset(seed)
        el = er = ef = 0.0
        out = []
        for i in range(settle + steps):
            f = b.step(inject=inj)
            msk = np.zeros(b.n, bool)
            msk[f] = True
            el += a_d * (msk[al].sum() / dt - el)
            er += a_d * (msk[ar].sum() / dt - er)
            ef += a_f * (msk[p01].sum() / dt - ef)
            if i >= settle:
                out.append(((el - er) / (el + er + 1e-3), ef))
        return np.array(out)

    zeros = [float(trace(0.0, s, 600, 150)[:, 0].mean()) for s in (0, 1, 2)]
    z = float(np.mean(zeros))
    print(f"aim zero: {np.round(zeros, 3)} -> Z={z:.3f}")
    print(" u  | mean(idx-Z) | sign accuracy outside dead zone")
    for u in (-1.0, -0.5, -0.2, 0.0, 0.2, 0.5, 1.0):
        d = np.concatenate([trace(u, s, 600, 150)[:, 0] for s in (0, 1)]) - z
        act = np.abs(d) > DEAD
        acc = np.mean(np.sign(d[act]) == np.sign(u)) if u and act.any() else float("nan")
        print(f"{u:+4.1f} | {d.mean():+11.3f} | {acc:.3f}")

    def integrate(idx_series, x0):
        x, xs = x0, []
        for idx in idx_series:
            c = idx - z
            c = 0.0 if abs(c) < DEAD else np.sign(c) * (abs(c) - DEAD) / (1 - DEAD)
            x = min(1.0, max(0.0, x + K_TURN * dt * float(np.clip(c, -1, 1))))
            xs.append(x)
        return np.array(xs)

    for s in (0, 1, 2):
        xs = integrate(trace(+1.0, s, 600, 150)[:, 0], 0.0)
        hit = int(np.argmax(xs > 0.95)) if (xs > 0.95).any() else -1
        print(f"traverse seed{s}: 0.0 -> 0.95 in {hit * dt if hit > 0 else -1:.2f} s")

    for s in (0, 1, 2):
        b.reset(s)
        el = er = 0.0
        idxs = []
        for _ in range(600):
            f = b.step()
            msk = np.zeros(b.n, bool)
            msk[f] = True
            el += a_d * (msk[al].sum() / dt - el)
            er += a_d * (msk[ar].sum() / dt - er)
            idxs.append((el - er) / (el + er + 1e-3))
        xs = integrate(np.array(idxs), 0.5)
        print(f"no-signal walk seed{s}: sd={xs.std():.3f} range=[{xs.min():.3f},{xs.max():.3f}]")

    for amp, label in ((0.0, "no looming"), (0.3, "looming +0.3")):
        for s in (0, 1, 2):
            ef = trace(0.0, s, 500, 150, loom_amp=amp)[:, 1]
            on, lat, n = False, None, 0
            for i, v in enumerate(ef):
                hot = v >= FIRE_ON if not on else v > FIRE_OFF
                if hot and not on:
                    n += 1
                    lat = lat if lat is not None else i * dt
                on = hot
            print(f"fire {label:12s} seed{s}: {n} events / 10 s, first at {lat}")


if __name__ == "__main__":
    main()
