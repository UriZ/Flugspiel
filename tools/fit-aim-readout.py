"""Fit the aim readout — #40 AC3. Writes `src/brain/readouts/aim_ridge.npz`.

The brain is **frozen**: `W` is never touched and nothing here trains a weight. What is
fitted is the linear map from a leaky per-neuron rate trace over the descending population
to the threat's azimuth — the readout half of reservoir computing, which this project
claimed and had not done.

Four things the naive version of this gets wrong, and what is done instead:

1. **The feature must be what the decoder actually has.** A spike-count window fitted
   offline and an EMA deployed online are different features; the trace here is the same
   EMA `Decoder.observe()` keeps, at the same tau.
2. **The holdout must be contiguous.** An EMA is autocorrelated across ticks, so a random
   row split leaks the test rows into training and every number comes out flattering.
   Both the holdout and the inner holdout that picks lambda are later stretches.
3. **A second brain seed, not just a second stimulus draw.** A readout that memorised one
   noise realisation scores well on held-out rows of the same session. It cannot score
   well on a different brain seed, which is why `--test-seed` re-runs the whole session
   and scores the *same* coefficients on it.
4. **The sky must hold as many missiles as the game's does.** Fitting on one missile and
   deploying into three is the same train/deploy mismatch as (1), one level up, and it is
   the more expensive one: measured, a readout fitted on single-target frames scores 0.73
   of shuffled in a three-missile closed loop against 0.28 open loop on its own
   distribution. The game guarantees at least two missiles per wave and usually more, so
   the session here descends `--missiles` of them, respawning each as it lands, and labels
   every tick with the azimuth of the *strongest looming* one — which is the target both
   the aim signal and `Decoder._coords` name. Azimuth is then piecewise-constant with a
   realistic dwell for free, because it only changes when a new missile takes over as the
   worst threat.

Run (takes a few minutes on the real connectome):

    .venv/bin/python tools/fit-aim-readout.py --ticks 5000

Output shape (values live in issue #40 and SESSION_LOG.md):

    fit on ... DN features, lambda=...
    R2 train=...  temporal-holdout=...  other-seed=...  shuffled-label=...
    K sweep ...
    wrote src/brain/readouts/aim_ridge.npz
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.brain.encoder import Encoder                         # noqa: E402
from src.brain.lif import FlyBrain                            # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping, loom  # noqa: E402
from src.brain.readout import LinearReadout                   # noqa: E402

STEPS_PER_TICK = 5        # 0.1 s of brain time per decode tick at dt = 0.020
TAU = 0.25                # s, EMA time constant of the per-neuron readout trace
LAMBDAS = np.logspace(-8, 6, 43)
"""Wide, and checked against its own edges in `best_lambda`: a hyperparameter chosen at
the boundary of the grid it was searched over is a grid artefact, not a choice."""
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "src" / "brain" / "readouts" / "aim_ridge.npz"


def fitting_mapping() -> tuple[Mapping, dict]:
    """The shipped mapping in `laterality` mode, with every prosthesis off.

    `laterality` because the readout being fitted does not exist yet — loading the
    shipped `readout` mode here would require the file this script writes. Prostheses off
    and asserted rather than assumed: a readout fitted while PFL3 was being injected would
    be reading back a signal the encoder wrote, and the claim it supports is the opposite
    of that.
    """
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for site in raw["sites"]:
        if site.get("prosthesis"):
            site["enabled"] = False
    raw["aim"] = {**raw["aim"], "mode": "laterality"}
    m = Mapping.load(raw)
    enabled = [s for s in m.sites if s.enabled]
    assert not any(s.prosthesis for s in enabled)
    return m, {"sites": [s.name for s in enabled],
               "codes": {s.name: s.code for s in enabled if s.code}}


class Sky:
    """Missiles falling like the game's: random x, random speed, respawned on landing.

    The fit and the closed-loop evaluation **must** draw from one distribution or the
    readout is being scored on a world it was not fitted for, so `aim-closed-loop.py`
    imports this class rather than keeping its own copy of it.
    """

    def __init__(self, seed: int, y_ground: float, n: int) -> None:
        self.rng = np.random.default_rng(seed)
        self.y_ground = y_ground
        self.m = [self._spawn() for _ in range(n)]

    def _spawn(self) -> dict:
        return {"kind": "missile", "x": float(self.rng.uniform(0.02, 0.98)),
                "y": float(self.rng.uniform(0.0, 0.3)), "vx": 0.0,
                "vy": float(self.rng.uniform(0.15, 0.50))}

    def advance(self, dt: float) -> None:
        for i, e in enumerate(self.m):
            e["y"] += e["vy"] * dt
            if e["y"] >= self.y_ground:
                self.m[i] = self._spawn()

    def state(self) -> dict:
        return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
                "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
                "launchers": [], "interceptors": [], "missiles": [dict(e) for e in self.m]}

    def threat_x(self, cfg: dict) -> float:
        """The azimuth of the strongest looming missile — the target being aimed at."""
        st = loom(np.array([e["y"] for e in self.m]),
                  np.array([e["vy"] for e in self.m]), cfg)
        return float(self.m[int(np.argmax(st))]["x"])


def session(brain: FlyBrain, enc: Encoder, dn: np.ndarray, ticks: int, seed: int,
            brain_seed: int, missiles: int) -> tuple[np.ndarray, np.ndarray]:
    """Run one session; return (features (ticks, |dn|) float32, azimuth (ticks,))."""
    dt = brain.params.dt
    tick_dt = STEPS_PER_TICK * dt
    a = 1.0 - np.exp(-dt / TAU)
    trace = np.zeros(len(dn))
    hit = np.zeros(brain.n, dtype=bool)
    X = np.zeros((ticks, len(dn)), dtype=np.float32)
    y = np.zeros(ticks)
    brain.reset(brain_seed)
    for _ in range(200):
        brain.step()
    sky = Sky(seed, enc.mapping.loom["y_ground"], missiles)
    for t in range(ticks):
        inj = enc.encode(sky.state()).inject
        for _ in range(STEPS_PER_TICK):
            hit[:] = False
            hit[brain.step(inject=inj)] = True
            trace += a * (hit[dn] / dt - trace)
        X[t] = trace
        y[t] = sky.threat_x(enc.mapping.loom)
        sky.advance(tick_dt)
    return X, y


def fit(X: np.ndarray, y: np.ndarray, lam: float) -> tuple[np.ndarray, float]:
    mu, ym = X.mean(axis=0), y.mean()
    Xc = X - mu
    w = np.linalg.solve(Xc.T @ Xc + lam * np.eye(X.shape[1]), Xc.T @ (y - ym))
    return w, float(ym - mu @ w)


def r2(y: np.ndarray, p: np.ndarray) -> float:
    return float(1.0 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum())


TOL = 0.002
"""Inner-score slack for the lambda rule below."""


def best_lambda(X: np.ndarray, y: np.ndarray, ninner: int) -> tuple[float, float]:
    """Lambda by a contiguous inner holdout of the training stretch — never a random one.

    Of the lambdas within `TOL` of the best inner score, the **largest** is taken. Taking
    the argmax outright selected the smallest lambda the grid offered, and widening the
    grid by five orders of magnitude moved it down again while changing no held-out number
    past the fourth decimal — i.e. the inner score is flat in this regime and the argmax
    was reading noise off the grid's edge. Where the score cannot distinguish two models,
    the better-conditioned one is the honest choice, and it is a choice this function
    makes visibly rather than one the grid's floor makes silently.
    """
    scores = []
    for lam in LAMBDAS:
        w, b = fit(X[:ninner], y[:ninner], lam)
        scores.append(r2(y[ninner:], X[ninner:] @ w + b))
    scores = np.asarray(scores)
    ok = np.flatnonzero(scores >= scores.max() - TOL)
    pick = int(ok[-1])
    if pick in (0, len(LAMBDAS) - 1):
        print(f"  WARNING: lambda {LAMBDAS[pick]:.3g} is at the edge of the search grid "
              f"[{LAMBDAS[0]:.3g}, {LAMBDAS[-1]:.3g}] — widen it", flush=True)
    return float(LAMBDAS[pick]), float(scores[pick])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticks", type=int, default=5000)
    ap.add_argument("--k", type=int, default=64, help="features kept; 0 = all")
    ap.add_argument("--seed", type=int, default=31, help="stimulus seed of the fit session")
    ap.add_argument("--test-seed", type=int, default=32, help="brain AND stimulus seed of "
                                                              "the cross-seed session")
    ap.add_argument("--brain-seed", type=int, default=64)
    ap.add_argument("--missiles", type=int, default=3, help="concurrent missiles in the sky")
    ap.add_argument("--backend", default="numba")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--dry-run", action="store_true", help="measure, write nothing")
    args = ap.parse_args()

    brain = FlyBrain.load(backend=args.backend)
    mapping, enc_desc = fitting_mapping()
    enc = Encoder(brain, mapping)
    dn = np.flatnonzero(brain.meta.superclass == "descending_neuron")
    print(f"encoder: {enc_desc}", flush=True)

    t0 = time.perf_counter()
    X, y = session(brain, enc, dn, args.ticks, args.seed, args.brain_seed, args.missiles)
    print(f"session A: {args.ticks} ticks x {STEPS_PER_TICK} steps in "
          f"{time.perf_counter() - t0:.0f}s", flush=True)
    t0 = time.perf_counter()
    Xb, yb = session(brain, enc, dn, args.ticks // 2, args.test_seed, args.test_seed,
                     args.missiles)
    print(f"session B: {args.ticks // 2} ticks in {time.perf_counter() - t0:.0f}s", flush=True)

    ntr = int(0.7 * args.ticks)
    Xtr, ytr, Xte, yte = X[:ntr], y[:ntr], X[ntr:], y[ntr:]
    ninner = int(0.8 * ntr)

    # Ranked on the TRAINING rows only. Ranking on the holdout would choose the features
    # that happen to fit it and then score them on it.
    sd = Xtr.std(axis=0)
    c = np.zeros(Xtr.shape[1])
    ok = sd > 0
    c[ok] = np.abs(((Xtr[:, ok] - Xtr[:, ok].mean(0)) * (ytr - ytr.mean())[:, None]).mean(0)
                   / (sd[ok] * ytr.std()))
    rank = np.argsort(-c)

    print(f"{'K':>6}{'holdout R2':>13}{'other-seed R2':>15}{'hemifield acc':>15}", flush=True)
    chosen = None
    for K in (len(dn), 256, 64, 16, 4, 2):
        sel = np.sort(rank[:K])
        lam, _ = best_lambda(Xtr[:, sel], ytr, ninner)
        w, b = fit(Xtr[:, sel], ytr, lam)
        pk, pkb = Xte[:, sel] @ w + b, Xb[:, sel] @ w + b
        print(f"{K:>6}{r2(yte, pk):>13.4f}{r2(yb, pkb):>15.4f}"
              f"{float(((pk >= 0.5) == (yte >= 0.5)).mean()):>15.4f}", flush=True)
        if K == (args.k or len(dn)):
            chosen = (sel, lam, w, b, pk, pkb)
    if chosen is None:      # a K the sweep does not print is still fittable
        sel = np.sort(rank[:args.k])
        lam, _ = best_lambda(Xtr[:, sel], ytr, ninner)
        w, b = fit(Xtr[:, sel], ytr, lam)
        chosen = (sel, lam, w, b, Xte[:, sel] @ w + b, Xb[:, sel] @ w + b)
    sel, lam, w, b, pred_te, pred_b = chosen

    ws, bs = fit(Xtr[:, sel], np.random.default_rng(5).permutation(ytr), lam)
    r2_hold, r2_seed = r2(yte, pred_te), r2(yb, pred_b)
    r2_shuf = r2(yte, Xte[:, sel] @ ws + bs)
    acc = float(((pred_te >= 0.5) == (yte >= 0.5)).mean())
    acc_b = float(((pred_b >= 0.5) == (yb >= 0.5)).mean())
    print(f"\nfit on {len(sel)} DN features, lambda={lam:.3g}")
    print(f"R2 train={r2(ytr, Xtr[:, sel] @ w + b):+.4f}  temporal-holdout={r2_hold:+.4f}  "
          f"other-seed={r2_seed:+.4f}  shuffled-label={r2_shuf:+.4f}", flush=True)
    print(f"hemifield accuracy: holdout={acc:.4f}  other-seed={acc_b:.4f}")
    for name, yy, pp in (("holdout", yte, pred_te), ("other-seed", yb, pred_b)):
        mright = yy >= 0.5
        within = r2(yy[mright], pp[mright]) if mright.sum() > 20 else float("nan")
        print(f"  {name:12s} within-right-hemifield R2={within:+.4f}")

    # A PROJECTION, not a closed-loop measurement: no servo, no rate limit, no decode lag.
    cross = np.clip(pred_te, 0.0, 1.0)
    shuf = np.random.default_rng(9).permutation(yte)
    print(f"projected open-loop |crosshair-target| / shuffled = "
          f"{np.abs(cross - yte).mean() / np.abs(cross - shuf).mean():.3f}", flush=True)
    order = np.argsort(-np.abs(w))[:10]
    print("top coefficients: " + ", ".join(
        f"{brain.meta.cell_type[dn[sel[i]]]}-{brain.meta.side[dn[sel[i]]]}:{w[i]:+.4f}"
        for i in order), flush=True)

    readout = LinearReadout(
        body_ids=brain.meta.ids[dn[sel]].astype(np.int64), weights=w.astype(np.float64),
        intercept=b, tau=TAU, lo=0.0, hi=1.0,
        provenance={
            "fitted": date.today().isoformat(), "brain_seed": args.brain_seed,
            "stimulus_seed": args.seed, "backend": args.backend, "n_ticks": args.ticks,
            "steps_per_tick": STEPS_PER_TICK, "lambda": lam, "k": len(sel),
            "missiles": args.missiles,
            "encoder": enc_desc,
            "held_out": (f"contiguous final {args.ticks - ntr} of {args.ticks} ticks, plus a "
                         f"second session on brain seed {args.test_seed} and stimulus seed "
                         f"{args.test_seed} scored with these same coefficients"),
            "r2_train": r2(ytr, Xtr[:, sel] @ w + b), "r2_temporal_holdout": r2_hold,
            "r2_other_seed": r2_seed, "r2_shuffled_label": r2_shuf,
            "hemifield_accuracy": acc,
            "ceiling": ("hemifield-resolved primarily; within-hemifield azimuth at the "
                        "descending layer depends on the encoder delivering an azimuth "
                        "code, and is at chance without one (#40 AC1)"),
            "prosthesis": False,
        })
    if args.dry_run:
        print("dry run: nothing written")
        return
    readout.save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
