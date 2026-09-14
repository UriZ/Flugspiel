"""#40 AC3 — fit the linear readout the project claims to have, and test it honestly.

AC1 established that azimuth is decodable from the descending population **only to the
precision of which hemifield**. This probe answers the remaining question: does that
survive the move from the AC1 measurement setting to the setting a decoder actually runs
in? Four things change and each could cost the signal:

1. **Feature definition.** AC1 used an 8-step spike-count window. The decoder has no such
   window -- it keeps a leaky EMA updated in `observe()`. Fitting on one and deploying on
   the other is a train/deploy mismatch, so this probe fits on the EMA.
2. **Temporal holdout, not a random split.** An EMA is autocorrelated across ticks, so a
   random row split leaks the test rows into training. The holdout here is a contiguous
   *later* stretch of the same session.
3. **A different brain seed.** A readout fitted to one seed's noise realisation is a
   memorised trace, not a readout. `--test-seed` re-runs the whole session on another seed
   and scores the *same* coefficients on it.
4. **Realistic dwell.** Azimuth is piecewise-constant with a random dwell, as a missile
   drifting down the screen produces, rather than i.i.d. per tick.

Run:

    .venv/bin/python tools/spike/aim-readout-fit.py --ticks 3000

Output shape (values live in issue #40 and SESSION_LOG.md):

    fit on 1314 DN features, lambda=..
    R2 train=..  R2 temporal-holdout=..  R2 other-seed=..  R2 shuffled=..
    hemifield accuracy: holdout=..  other-seed=..
    within-hemifield R2 (holdout)=..
    projected |crosshair-target| / shuffled = ..
    top coefficients: ...
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.brain.encoder import Encoder                         # noqa: E402
from src.brain.lif import FlyBrain                            # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping   # noqa: E402

STEPS_PER_TICK = 5        # 0.1 s of brain time per decode tick at dt = 0.020
TAU = 0.25                # s, EMA time constant of the per-neuron readout trace
LAMBDAS = np.logspace(-3, 6, 28)


def mapping_no_prosthesis() -> Mapping:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for site in raw["sites"]:
        if site["name"].startswith("aim_bias"):
            site["enabled"] = False
    return Mapping.load(raw)


def frame(az: float, y: float, vy: float) -> dict:
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [],
            "missiles": [{"x": az, "y": y, "vx": 0.0, "vy": vy}]}


def session(brain: FlyBrain, enc: Encoder, dn: np.ndarray, ticks: int, seed: int,
            brain_seed: int = 64):
    """Run one session; return (features (ticks, |dn|) float32, azimuth (ticks,))."""
    rng = np.random.default_rng(seed)
    dt = brain.params.dt
    a = 1.0 - np.exp(-dt / TAU)
    trace = np.zeros(len(dn), dtype=np.float64)
    hit = np.zeros(brain.n, dtype=bool)
    X = np.zeros((ticks, len(dn)), dtype=np.float32)
    y = np.zeros(ticks)
    brain.reset(brain_seed)
    for _ in range(200):
        brain.step()
    az, dwell, inj = 0.5, 0, None
    for t in range(ticks):
        if dwell == 0:                       # a new missile takes over the threat slot
            az = rng.uniform(0.02, 0.98)
            dwell = int(rng.integers(4, 25))
            inj = enc.encode(frame(az, rng.uniform(0.30, 0.70),
                                   rng.uniform(0.15, 0.50))).inject
        dwell -= 1
        for _ in range(STEPS_PER_TICK):
            hit[:] = False
            hit[brain.step(inject=inj)] = True
            trace += a * (hit[dn] / dt - trace)
        X[t] = trace
        y[t] = az
    return X, y


def fit(X: np.ndarray, y: np.ndarray, lam: float) -> tuple[np.ndarray, float]:
    mu, ym = X.mean(axis=0), y.mean()
    Xc = X - mu
    G = Xc.T @ Xc + lam * np.eye(X.shape[1])
    w = np.linalg.solve(G, Xc.T @ (y - ym))
    return w, float(ym - mu @ w)


def r2(y: np.ndarray, p: np.ndarray) -> float:
    return float(1.0 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticks", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=31)
    ap.add_argument("--test-seed", type=int, default=32)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    enc = Encoder(brain, mapping_no_prosthesis())
    dn = np.flatnonzero(brain.meta.superclass == "descending_neuron")

    t0 = time.perf_counter()
    X, y = session(brain, enc, dn, args.ticks, args.seed)
    print(f"session A: {args.ticks} ticks x {STEPS_PER_TICK} steps in "
          f"{time.perf_counter() - t0:.0f}s", flush=True)
    # A second, independent session: different stimulus seed AND a different brain seed,
    # so nothing the readout memorised about one noise realisation can transfer.
    t0 = time.perf_counter()
    Xb, yb = session(brain, enc, dn, args.ticks // 2, args.test_seed,
                     brain_seed=args.test_seed)
    print(f"session B: {args.ticks // 2} ticks in {time.perf_counter() - t0:.0f}s", flush=True)

    # Effective sample size is the number of DWELLS, not ticks: azimuth is constant for
    # 4-25 ticks, so ~2400 ticks is only ~200 independent episodes against 1,314 features.
    # That is why --ticks defaults high and why the feature-count sweep below exists.
    ntr = int(0.7 * args.ticks)
    Xtr, ytr, Xte, yte = X[:ntr], y[:ntr], X[ntr:], y[ntr:]

    # lambda by a contiguous inner holdout of the training stretch -- never random, and
    # never the test stretch.
    ninner = int(0.8 * ntr)
    best, best_lam = -np.inf, LAMBDAS[0]
    for lam in LAMBDAS:
        w, b = fit(Xtr[:ninner], ytr[:ninner], lam)
        s = r2(ytr[ninner:], Xtr[ninner:] @ w + b)
        if s > best:
            best, best_lam = s, lam
    w, b = fit(Xtr, ytr, best_lam)

    pred_te, pred_b = Xte @ w + b, Xb @ w + b
    ws, bs = fit(Xtr, np.random.default_rng(5).permutation(ytr), best_lam)
    print(f"fit on {len(dn)} DN features, lambda={best_lam:.3g} (inner R2={best:+.4f})")
    print(f"R2 train={r2(ytr, Xtr @ w + b):+.4f}  temporal-holdout={r2(yte, pred_te):+.4f}  "
          f"other-seed={r2(yb, pred_b):+.4f}  shuffled-label={r2(yte, Xte @ ws + bs):+.4f}",
          flush=True)

    for name, yy, pp in (("holdout", yte, pred_te), ("other-seed", yb, pred_b)):
        acc = float(((pp >= 0.5) == (yy >= 0.5)).mean())
        m = yy >= 0.5
        within = r2(yy[m], pp[m]) if m.sum() > 20 else float("nan")
        print(f"{name:12s} hemifield accuracy={acc:.4f}  within-right-hemifield R2={within:+.4f}",
              flush=True)

    # Projected open-loop aim error against a shuffled control, with a perfect servo.
    # This is a PROJECTION, not a closed-loop measurement: no crosshair rate limit, no
    # decode lag, no target motion during the tick.
    cross = np.clip(pred_te, 0.0, 1.0)
    shuf = np.random.default_rng(9).permutation(yte)
    print(f"projected open-loop |crosshair-target| / shuffled = "
          f"{np.abs(cross - yte).mean() / np.abs(cross - shuf).mean():.3f}", flush=True)

    # How many neurons does the readout actually need? Selection uses the TRAINING rows
    # only -- ranking on the holdout would leak it.
    c = np.array([abs(np.corrcoef(Xtr[:, j], ytr)[0, 1]) if Xtr[:, j].std() > 0 else 0.0
                  for j in range(Xtr.shape[1])])
    rankf = np.argsort(-c)
    print(f"{'K':>6}{'holdout R2':>13}{'other-seed R2':>15}{'hemifield acc':>15}")
    for K in (len(dn), 256, 64, 16, 4, 2):
        sel = rankf[:K]
        bl, bs_ = -np.inf, LAMBDAS[0]
        for lam in LAMBDAS:
            wk, bk = fit(Xtr[:ninner][:, sel], ytr[:ninner], lam)
            sc = r2(ytr[ninner:], Xtr[ninner:][:, sel] @ wk + bk)
            if sc > bl:
                bl, bs_ = sc, lam
        wk, bk = fit(Xtr[:, sel], ytr, bs_)
        pk, pkb = Xte[:, sel] @ wk + bk, Xb[:, sel] @ wk + bk
        print(f"{K:>6}{r2(yte, pk):>13.4f}{r2(yb, pkb):>15.4f}"
              f"{float(((pk >= 0.5) == (yte >= 0.5)).mean()):>15.4f}", flush=True)

    order = np.argsort(-np.abs(w))[:15]
    print("top coefficients: " + ", ".join(
        f"{brain.meta.cell_type[dn[i]]}-{brain.meta.side[dn[i]]}:{w[i]:+.4f}" for i in order),
        flush=True)
    print(f"nonzero-ish coefficients (|w| > 1% of max): "
          f"{int((np.abs(w) > 0.01 * np.abs(w).max()).sum())} of {len(dn)}")

    if args.out:
        args.out.write_text(json.dumps({
            "lambda": float(best_lam), "n_features": int(len(dn)),
            "r2_train": r2(ytr, Xtr @ w + b), "r2_holdout": r2(yte, pred_te),
            "r2_other_seed": r2(yb, pred_b), "r2_shuffled": r2(yte, Xte @ ws + bs),
            "hemifield_acc_holdout": float(((pred_te >= 0.5) == (yte >= 0.5)).mean()),
            "hemifield_acc_other_seed": float(((pred_b >= 0.5) == (yb >= 0.5)).mean()),
            "top": [{"type": str(brain.meta.cell_type[dn[i]]),
                     "side": str(brain.meta.side[dn[i]]), "w": float(w[i])} for i in order],
        }, indent=2))


if __name__ == "__main__":
    main()
