"""#40 AC4 — effective dimensionality of the reservoir, and whether the visual signal
survives into it.

Three measurements:

1. **Participation ratio of the free-running state over time.** PR = (sum lam)^2 / sum lam^2
   over the PCA spectrum of the centred spike matrix (steps x neurons).
   **PR is capped by the number of samples**: a T-step recording has at most T-1 nonzero
   eigenvalues, so a PR quoted from a short recording is a property of the recording, not
   of the brain. This probe sweeps T and prints the sweep, so the cap is visible rather
   than mistaken for a result. (A pilot at 150 trials read 90.8 and the same brain at 900
   trials read 190.2 -- neither is the brain's dimensionality.)

2. **Kenyon-cell saturation (#29)**: fraction of the 4,064 KCs firing per step.

3. **Stimulus-locked variance fraction per population** -- the direct test of "the visual
   signal is drowned before it propagates". The same S stimuli are presented R times each in
   a seeded random order; for each neuron, signal variance is the variance of its
   per-stimulus means and noise variance is the mean within-stimulus variance. The ratio is
   the fraction of that population's activity that the stimulus explains. This is the
   quantity a readout can use; everything else is intrinsic network noise.

Run:

    .venv/bin/python tools/spike/state-dimensionality.py

Output shape (values live in issue #40 and SESSION_LOG.md):

    PR sweep (free-running):  T=250 PR=..  T=500 PR=..  T=1000 PR=..  T=2000 PR=..
    KC: 4064 cells, firing per step mean=..  min=..  max=..  frac_always_firing=..
    population           n      signal_frac   median_neuron_frac
    ...
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from scipy import sparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.brain.connectome import PHOTORECEPTOR_TYPES          # noqa: E402
from src.brain.encoder import Encoder                         # noqa: E402
from src.brain.lif import FlyBrain                            # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping   # noqa: E402

SETTLE = 4
RECORD = 8


def mapping_no_prosthesis() -> Mapping:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for site in raw["sites"]:
        if site["name"].startswith("aim_bias"):
            site["enabled"] = False
    return Mapping.load(raw)


def frame(az: float) -> dict:
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [],
            "missiles": [{"x": az, "y": 0.55, "vx": 0.0, "vy": 0.45}]}


def participation_ratio(rows: list[np.ndarray], n: int) -> float:
    """PR of the centred sample x neuron spike matrix, built from fired-index rows."""
    T = len(rows)
    indptr = np.zeros(T + 1, dtype=np.int64)
    indptr[1:] = np.cumsum([len(r) for r in rows])
    X = sparse.csr_matrix((np.ones(indptr[-1], dtype=np.float32),
                           np.concatenate(rows) if T else np.empty(0, dtype=np.int64),
                           indptr), shape=(T, n))
    K = np.asarray((X @ X.T).todense(), dtype=np.float64)
    # Double-centre: HKH with H = I - 11^T/T. Equivalent to centring the features.
    rm = K.mean(axis=1, keepdims=True)
    K = K - rm - rm.T + K.mean()
    ev = np.clip(np.linalg.eigvalsh(K), 0.0, None)
    return float(ev.sum() ** 2 / (ev ** 2).sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr-steps", type=int, default=2000)
    ap.add_argument("--stimuli", type=int, default=8)
    ap.add_argument("--repeats", type=int, default=40)
    ap.add_argument("--seed", type=int, default=23)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    m = brain.meta
    n = brain.n
    results: dict = {}

    # ---------------------------------------------------------------- 1. PR over time
    brain.reset(64)
    for _ in range(200):
        brain.step()
    t0 = time.perf_counter()
    rows = [brain.step() for _ in range(args.pr_steps)]
    print(f"free-running: {args.pr_steps} steps in {time.perf_counter() - t0:.0f}s, "
          f"mean firing {np.mean([len(r) for r in rows]) / n * 100:.2f}%", flush=True)
    sweep = {}
    for T in (250, 500, 1000, args.pr_steps):
        if T <= args.pr_steps:
            sweep[T] = participation_ratio(rows[:T], n)
    print("PR sweep (free-running): " +
          "  ".join(f"T={T} PR={v:.1f}" for T, v in sweep.items()), flush=True)
    results["pr_sweep_free"] = {str(k): v for k, v in sweep.items()}

    # ---------------------------------------------------------------- 2. KC saturation
    kc = np.flatnonzero(np.char.startswith(m.cell_type.astype(str), "KC"))
    hit = np.zeros(n, dtype=bool)
    per_step = []
    for r in rows:
        hit[:] = False
        hit[r] = True
        per_step.append(int(hit[kc].sum()))
    per_step = np.array(per_step)
    always = np.ones(len(kc), dtype=bool)
    for r in rows:
        hit[:] = False
        hit[r] = True
        always &= hit[kc]
    print(f"KC: {len(kc)} cells, firing per step mean={per_step.mean():.1f} "
          f"({per_step.mean() / len(kc) * 100:.1f}%) min={per_step.min()} max={per_step.max()} "
          f"cells firing on every one of {args.pr_steps} steps={int(always.sum())}", flush=True)
    results["kc"] = {"n": int(len(kc)), "mean_per_step": float(per_step.mean()),
                     "frac_per_step": float(per_step.mean() / len(kc)),
                     "min": int(per_step.min()), "max": int(per_step.max()),
                     "always_firing": int(always.sum())}

    # ------------------------------------------- 3. stimulus-locked variance fraction
    enc = Encoder(brain, mapping_no_prosthesis())
    az = np.linspace(0.05, 0.95, args.stimuli)
    inj = [enc.encode(frame(a)).inject for a in az]
    order = np.repeat(np.arange(args.stimuli), args.repeats)
    np.random.default_rng(args.seed).shuffle(order)
    counts = np.zeros((len(order), n), dtype=np.uint8)
    acc = np.zeros(n, dtype=np.uint8)
    brain.reset(64)
    for _ in range(200):
        brain.step()
    t0 = time.perf_counter()
    for k, s in enumerate(order):
        for _ in range(SETTLE):
            brain.step(inject=inj[s])
        acc[:] = 0
        for _ in range(RECORD):
            acc[brain.step(inject=inj[s])] += 1
        counts[k] = acc
    print(f"stimulus set: {args.stimuli} azimuths x {args.repeats} repeats in "
          f"{time.perf_counter() - t0:.0f}s", flush=True)

    X = counts.astype(np.float32)
    means = np.stack([X[order == s].mean(axis=0) for s in range(args.stimuli)])
    sig = means.var(axis=0, ddof=1)
    noi = np.stack([X[order == s].var(axis=0, ddof=1) for s in range(args.stimuli)]).mean(axis=0)
    frac = np.where(sig + noi > 0, sig / np.maximum(sig + noi, 1e-12), 0.0)

    pops = {
        "photoreceptors": np.flatnonzero(np.isin(m.cell_type, list(PHOTORECEPTOR_TYPES))),
        "ol_intrinsic": np.flatnonzero(m.superclass == "ol_intrinsic"),
        "visual_projection": np.flatnonzero(m.superclass == "visual_projection"),
        "cb_intrinsic": np.flatnonzero(m.superclass == "cb_intrinsic"),
        "kenyon_cells": kc,
        "descending": np.flatnonzero(m.superclass == "descending_neuron"),
        "whole_brain": np.arange(n),
    }
    print(f"{'population':<20}{'n':>8}{'pooled_signal_frac':>20}{'median_neuron':>15}"
          f"{'p95_neuron':>12}")
    for name, idx in pops.items():
        pooled = float(sig[idx].sum() / max(sig[idx].sum() + noi[idx].sum(), 1e-12))
        print(f"{name:<20}{len(idx):>8}{pooled:>20.4f}{np.median(frac[idx]):>15.4f}"
              f"{np.percentile(frac[idx], 95):>12.4f}", flush=True)
        results.setdefault("signal_frac", {})[name] = {
            "n": int(len(idx)), "pooled": pooled,
            "median_neuron": float(np.median(frac[idx])),
            "p95_neuron": float(np.percentile(frac[idx], 95)),
        }

    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
