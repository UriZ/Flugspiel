"""#40 AC1/AC4 — is target azimuth linearly decodable from the brain state?

Records N trials of (known target azimuth -> brain spike-count vector), fits a ridge
regression in the DUAL form (exact over all 166,700 features, no projection loss), and
reports held-out R^2 against a label-shuffled null. Also reports the participation ratio
of the recorded state (AC4).

Run (from the repo root, ~3 min at N=1800 on an unloaded 8-core box):

    .venv/bin/python tools/spike/aim-decodability.py --trials 1800

Numbers this produced are in issue #40 and SESSION_LOG.md, not here: a measured value in
a docstring rots silently. What the header pins is the *shape* of the output --

    cond=no_prosthesis  set=all      R2=...  shuffled=...+-...  margin=...sd
    cond=no_prosthesis  set=dn       R2=...  ...
    ...
    participation_ratio=...  of 166700

Deterministic: brain seed and stimulus RNG are both fixed, backend is pinned. Wall time
is load-sensitive; the R^2 values are not.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.brain.connectome import PHOTORECEPTOR_TYPES      # noqa: E402
from src.brain.encoder import Encoder                    # noqa: E402
from src.brain.lif import FlyBrain                       # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping  # noqa: E402

SETTLE = 4          # steps of the new frame before recording, so the state is the frame's
RECORD = 8          # steps summed into one feature vector
LAMBDAS = np.logspace(-2, 9, 23)

# (name, retina, loom, prosthesis, azimuth range). The hemifield rows are the decisive
# controls: with a single missile at full loom the LC4/LPLC2 channel carries only WHICH
# SIDE, which a linear decoder converts into R^2 ~ 0.75 against uniform azimuth while
# knowing nothing finer. Restricting the stimulus to one hemifield removes that cue, so
# anything left is genuine within-side azimuth.
# `retina_gain=None` keeps the shipped 0.30. The x10 rows exist to separate "the path is
# too weak" from "there is no path": if azimuth is still at chance downstream when the
# photoreceptors are driven at the config's own `max_inject` ceiling, the failure is
# connectivity, not gain.
CONDITIONS = [
    # name,              retina, loom,  pros,  az range,      retina gain
    ("both_channels",    True,   True,  False, (0.02, 0.98), None),
    ("loom_only",        False,  True,  False, (0.02, 0.98), None),
    ("retina_only",      True,   False, False, (0.02, 0.98), None),
    ("retina_x10",       True,   False, False, (0.02, 0.98), 3.0),
    ("hemifield_both",   True,   True,  False, (0.52, 0.98), None),
    ("hemifield_x10",    True,   False, False, (0.52, 0.98), 3.0),
    ("prosthesis",       True,   True,  True,  (0.02, 0.98), None),
    ("hemi_prosthesis",  True,   True,  True,  (0.52, 0.98), None),
]


def mapping_variant(prosthesis: bool, retina: bool = True, loom: bool = True,
                    retina_gain: float | None = None) -> Mapping:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for site in raw["sites"]:
        if site["name"].startswith("aim_bias"):
            site["enabled"] = prosthesis
        if site["name"] == "retina":
            site["enabled"] = retina
            if retina_gain is not None:
                site["gain"] = retina_gain
        # The scalar pair only. `looming_code` shipped after this probe and is disabled
        # in every arm: with it enabled, `loom=True` would run the scalar sites AND the
        # coded one together, which is the interfering combination #40 measured, not the
        # shipped baseline this probe is about. Prefix-matching "looming" caught it.
        if site["name"] in ("looming_L", "looming_R"):
            site["enabled"] = loom
        if site["name"] == "looming_code":
            site["enabled"] = False
    return Mapping.load(raw)


def frame(az: float, y: float, vy: float) -> dict:
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [],
            "missiles": [{"x": az, "y": y, "vx": 0.0, "vy": vy}]}


def record(brain: FlyBrain, enc: Encoder, trials: int, rng: np.random.Generator,
           az_range: tuple[float, float] = (0.02, 0.98)):
    """-> (counts uint8 (trials, n), azimuth float64 (trials,))."""
    X = np.zeros((trials, brain.n), dtype=np.uint8)
    az = rng.uniform(*az_range, trials)
    ys = rng.uniform(0.30, 0.70, trials)
    vys = rng.uniform(0.15, 0.50, trials)
    for t in range(trials):
        inj = enc.encode(frame(az[t], ys[t], vys[t]), crosshair_x=0.5).inject
        for _ in range(SETTLE):
            brain.step(inject=inj)
        acc = np.zeros(brain.n, dtype=np.uint8)
        for _ in range(RECORD):
            acc[brain.step(inject=inj)] += 1
        X[t] = acc
    return X, az


def gram(X: np.ndarray, block: int = 20000) -> np.ndarray:
    """Centred linear kernel X_c X_c^T, chunked over features so nothing is materialised
    at (trials, 166700) in float32."""
    n, f = X.shape
    K = np.zeros((n, n), dtype=np.float64)
    for lo in range(0, f, block):
        B = X[:, lo:lo + block].astype(np.float32)
        B -= B.mean(axis=0, keepdims=True)
        K += (B @ B.T).astype(np.float64)
    return K


def ridge_eval(K: np.ndarray, y: np.ndarray, labels: list[np.ndarray], splits: int,
               rng: np.random.Generator) -> list[float]:
    """Held-out R^2 for `y` and for each label vector in `labels`, over the SAME splits.

    Each training kernel is eigendecomposed once and reused across every lambda and every
    label vector, so the 20-shuffle null costs a matrix multiply rather than 20 refits.
    Lambda is chosen by 5-fold CV inside the training rows only; the test rows are touched
    exactly once per split, to score.
    """
    n = len(y)
    scores = [[] for _ in range(1 + len(labels))]
    for _ in range(splits):
        perm = rng.permutation(n)
        ntr = int(0.7 * n)
        tr, te = perm[:ntr], perm[ntr:]
        w_tr, U_tr = np.linalg.eigh(K[np.ix_(tr, tr)])
        Kte = K[np.ix_(te, tr)]
        folds = np.array_split(rng.permutation(ntr), 5)
        inner = []
        for f in folds:
            keep = np.setdiff1d(np.arange(ntr), f)
            w, U = np.linalg.eigh(K[np.ix_(tr[keep], tr[keep])])
            inner.append((f, keep, w, U, K[np.ix_(tr[f], tr[keep])]))
        for j, yv in enumerate([y] + labels):
            best_lam, best_cv = LAMBDAS[0], -np.inf
            for lam in LAMBDAS:
                pred = np.empty(ntr)
                for f, keep, w, U, Kf in inner:
                    ytr = yv[tr[keep]]
                    pred[f] = Kf @ _solve(w, U, ytr, lam) + ytr.mean()
                cv = _r2(yv[tr], pred)
                if cv > best_cv:
                    best_cv, best_lam = cv, lam
            ytr = yv[tr]
            scores[j].append(_r2(yv[te], Kte @ _solve(w_tr, U_tr, ytr, best_lam) + ytr.mean()))
    return [float(np.mean(s)) for s in scores]


def _solve(w: np.ndarray, U: np.ndarray, ytr: np.ndarray, lam: float) -> np.ndarray:
    return U @ ((U.T @ (ytr - ytr.mean())) / (w + lam))


def _r2(y: np.ndarray, pred: np.ndarray) -> float:
    return float(1.0 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum())


def participation_ratio(X: np.ndarray) -> tuple[float, np.ndarray]:
    """PR = (sum lam)^2 / sum lam^2 of the covariance of the state across trials."""
    K = gram(X)
    ev = np.linalg.eigvalsh(K)
    ev = np.clip(ev, 0.0, None)
    return float(ev.sum() ** 2 / (ev ** 2).sum()), ev[::-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=1800)
    ap.add_argument("--splits", type=int, default=5)
    ap.add_argument("--shuffles", type=int, default=20)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    m = brain.meta
    sets = {
        "all": np.arange(brain.n),
        "dn": np.flatnonzero(m.superclass == "descending_neuron"),
        "vproj": np.flatnonzero(m.superclass == "visual_projection"),
        "cb": np.flatnonzero(m.superclass == "cb_intrinsic"),
        "post_optic": np.flatnonzero(~np.isin(m.superclass, ["ol_intrinsic", "ol_sensory"])),
        # The hop chain the visual signal would have to survive:
        #   photoreceptors -> ol_intrinsic (lamina/medulla) -> vproj (LC4/LPLC2) -> cb -> dn
        "photorecep": np.flatnonzero(np.isin(m.cell_type, list(PHOTORECEPTOR_TYPES))),
        "ol_intr": np.flatnonzero(m.superclass == "ol_intrinsic"),
    }
    results = {}
    for cond, retina, loom, pros, az_range, rgain in CONDITIONS:
        enc = Encoder(brain, mapping_variant(prosthesis=pros, retina=retina, loom=loom,
                                             retina_gain=rgain))
        brain.reset(64)
        for _ in range(200):
            brain.step()                       # washout of the reset transient
        t0 = time.perf_counter()
        X, az = record(brain, enc, args.trials, np.random.default_rng(args.seed), az_range)
        print(f"[{cond}] retina={retina}(gain={rgain}) loom={loom} prosthesis={pros} az={az_range} "
              f"recorded in {time.perf_counter() - t0:.0f}s mean_count={X.mean():.3f}",
              flush=True)
        nulls = [np.random.default_rng(1000 + k).permutation(az) for k in range(args.shuffles)]
        for name, idx in sets.items():
            K = gram(X[:, idx])
            got = ridge_eval(K, az, nulls, args.splits,
                             np.random.default_rng(args.seed + 1))
            r2, null = got[0], got[1:]
            mu, sd = float(np.mean(null)), float(np.std(null))
            margin = (r2 - mu) / sd if sd > 0 else float("inf")
            print(f"cond={cond:15s} set={name:11s} n_feat={len(idx):6d} R2={r2:+.4f}  "
                  f"shuffled={mu:+.4f}+-{sd:.4f}  margin={margin:+.1f}sd", flush=True)
            results[f"{cond}/{name}"] = {"n_feat": int(len(idx)), "r2": r2,
                                         "shuffled_mean": mu, "shuffled_sd": sd,
                                         "margin_sd": margin}
        pr, ev = participation_ratio(X)
        top = ev[:10] / ev.sum()
        print(f"cond={cond:15s} participation_ratio={pr:.2f} of {brain.n} neurons; "
              f"top10 var frac={np.round(top, 4).tolist()}", flush=True)
        results[f"{cond}/participation_ratio"] = pr
        results[f"{cond}/top10_var_frac"] = top.tolist()
        results[f"{cond}/mean_spike_count"] = float(X.mean())
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
