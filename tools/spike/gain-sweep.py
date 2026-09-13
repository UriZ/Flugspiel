"""#40 — does the LIF gain set whether the visual signal survives? (TL request)

Sweeps `LIFParams.gain` around the shipped 3.0 and, at each point, measures four things
together so they can be read against one another:

1. **Network firing rate** and **Kenyon-cell saturation** (#29's operating point).
2. **Participation ratio** of the free-running state -- reported WITH its sample count,
   because PR is capped by the number of samples and is meaningless without it.
3. **Retina-only azimuth decodability** at the photoreceptors, at their direct targets
   (`ol_intrinsic`) and at the descending layer. This is the question: does a different
   operating point let the photoreceptor channel propagate?
4. **Loom-only azimuth decodability at the descending layer**, as a POSITIVE CONTROL at
   every gain. Without it, "the retina is dead at gain X" cannot be told apart from "the
   whole network is dead at gain X".

READ-ONLY. Nothing here writes config or data; `brain.params` is rebound in-process only.
The shipped operating point is `gain = 3.0` and #24's trajectory lock pins it -- this probe
measures what WOULD happen, it does not change anything.

Run:

    .venv/bin/python tools/spike/gain-sweep.py --trials 300

Output shape (values live in issue #40 and SESSION_LOG.md):

    gain  fire%   KC%   L1_Hz  L2_Hz   PR(T=500)  retina:photo/ol/dn    loom:dn
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
from src.brain.lif import FlyBrain, LIFParams                 # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping   # noqa: E402

SETTLE, RECORD, PR_STEPS = 4, 8, 500
LAMBDAS = np.logspace(-2, 9, 19)


def variant(retina: bool, loom: bool) -> Mapping:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for s in raw["sites"]:
        if s["name"].startswith("aim_bias"):
            s["enabled"] = False
        if s["name"] == "retina":
            s["enabled"] = retina
        # See the note in `aim-decodability.py`: the scalar pair only, and the coded site
        # off, or this probe silently measures a different encoder than it documents.
        if s["name"] == "looming_code":
            s["enabled"] = False
        if s["name"] in ("looming_L", "looming_R"):
            s["enabled"] = loom
    return Mapping.load(raw)


def frame(az, y, vy):
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [],
            "missiles": [{"x": az, "y": y, "vx": 0.0, "vy": vy}]}


def gram(X, block=20000):
    n, f = X.shape
    K = np.zeros((n, n))
    for lo in range(0, f, block):
        B = X[:, lo:lo + block].astype(np.float32)
        B -= B.mean(axis=0, keepdims=True)
        K += (B @ B.T).astype(np.float64)
    return K


def _r2(y, p):
    return float(1.0 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum())


def ridge(K, y, rng, splits=3):
    n = len(y)
    out = []
    for _ in range(splits):
        perm = rng.permutation(n)
        ntr = int(0.7 * n)
        tr, te = perm[:ntr], perm[ntr:]
        w, U = np.linalg.eigh(K[np.ix_(tr, tr)])
        inner = []
        for f in np.array_split(rng.permutation(ntr), 4):
            keep = np.setdiff1d(np.arange(ntr), f)
            wv, Uv = np.linalg.eigh(K[np.ix_(tr[keep], tr[keep])])
            inner.append((f, keep, wv, Uv, K[np.ix_(tr[f], tr[keep])]))
        best, best_lam = -np.inf, LAMBDAS[0]
        for lam in LAMBDAS:
            pred = np.empty(ntr)
            for f, keep, wv, Uv, Kf in inner:
                yt = y[tr[keep]]
                pred[f] = Kf @ (Uv @ ((Uv.T @ (yt - yt.mean())) / (wv + lam))) + yt.mean()
            s = _r2(y[tr], pred)
            if s > best:
                best, best_lam = s, lam
        yt = y[tr]
        out.append(_r2(y[te], K[np.ix_(te, tr)] @ (U @ ((U.T @ (yt - yt.mean()))
                                                       / (w + best_lam))) + yt.mean()))
    return float(np.mean(out))


def record(brain, enc, trials, rng):
    X = np.zeros((trials, brain.n), dtype=np.uint8)
    az = rng.uniform(0.02, 0.98, trials)
    ys = rng.uniform(0.30, 0.70, trials)
    vys = rng.uniform(0.15, 0.50, trials)
    for t in range(trials):
        inj = enc.encode(frame(az[t], ys[t], vys[t])).inject
        for _ in range(SETTLE):
            brain.step(inject=inj)
        acc = np.zeros(brain.n, dtype=np.uint8)
        for _ in range(RECORD):
            acc[brain.step(inject=inj)] += 1
        X[t] = acc
    return X, az


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=300)
    ap.add_argument("--gains", type=float, nargs="+",
                    default=[1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0])
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    m = brain.meta
    base = brain.params
    kc = np.flatnonzero(np.char.startswith(m.cell_type.astype(str), "KC"))
    L1, L2 = brain.cells(["L1"]), brain.cells(["L2"])
    sets = {"photo": np.flatnonzero(np.isin(m.cell_type, list(PHOTORECEPTOR_TYPES))),
            "ol": np.flatnonzero(m.superclass == "ol_intrinsic"),
            "dn": np.flatnonzero(m.superclass == "descending_neuron")}
    enc_ret = Encoder(brain, variant(retina=True, loom=False))
    enc_loom = Encoder(brain, variant(retina=False, loom=True))

    print(f"{'gain':>6}{'fire%':>8}{'KC%':>8}{'L1_Hz':>8}{'L2_Hz':>8}"
          f"{'PR(T=500)':>11}{'ret:photo':>11}{'ret:ol':>9}{'ret:dn':>9}{'loom:dn':>9}",
          flush=True)
    results = {}
    for g in args.gains:
        # Rebind params in-process. LIFParams is frozen and validated in __post_init__,
        # so this cannot smuggle through an invalid operating point.
        brain.params = LIFParams(dt=base.dt, tau=base.tau, gain=g, tonic=base.tonic,
                                 noise_hz=base.noise_hz, noise_amp=base.noise_amp,
                                 threshold=base.threshold, v_reset=base.v_reset)
        brain.reset(64)
        for _ in range(200):
            brain.step()
        rows = [brain.step() for _ in range(PR_STEPS)]
        fire = np.mean([len(r) for r in rows]) / brain.n * 100
        hit = np.zeros(brain.n, dtype=bool)
        kcf = l1f = l2f = 0
        for r in rows:
            hit[:] = False
            hit[r] = True
            kcf += hit[kc].sum()
            l1f += hit[L1].sum()
            l2f += hit[L2].sum()
        kcpct = kcf / len(kc) / PR_STEPS * 100
        l1hz = l1f / len(L1) / PR_STEPS / base.dt
        l2hz = l2f / len(L2) / PR_STEPS / base.dt
        indptr = np.zeros(PR_STEPS + 1, dtype=np.int64)
        indptr[1:] = np.cumsum([len(r) for r in rows])
        Xs = sparse.csr_matrix((np.ones(indptr[-1], dtype=np.float32),
                                np.concatenate(rows), indptr), shape=(PR_STEPS, brain.n))
        K = np.asarray((Xs @ Xs.T).todense(), dtype=np.float64)
        rm = K.mean(axis=1, keepdims=True)
        K = K - rm - rm.T + K.mean()
        ev = np.clip(np.linalg.eigvalsh(K), 0.0, None)
        pr = float(ev.sum() ** 2 / (ev ** 2).sum()) if ev.sum() > 0 else 0.0

        brain.reset(64)
        for _ in range(200):
            brain.step()
        Xr, az = record(brain, enc_ret, args.trials, np.random.default_rng(args.seed))
        r = {k: ridge(gram(Xr[:, idx]), az, np.random.default_rng(args.seed + 1))
             for k, idx in sets.items()}
        brain.reset(64)
        for _ in range(200):
            brain.step()
        Xl, azl = record(brain, enc_loom, args.trials, np.random.default_rng(args.seed))
        ldn = ridge(gram(Xl[:, sets["dn"]]), azl, np.random.default_rng(args.seed + 1))

        print(f"{g:>6.1f}{fire:>8.2f}{kcpct:>8.1f}{l1hz:>8.2f}{l2hz:>8.2f}{pr:>11.1f}"
              f"{r['photo']:>+11.4f}{r['ol']:>+9.4f}{r['dn']:>+9.4f}{ldn:>+9.4f}", flush=True)
        results[str(g)] = {"fire_pct": fire, "kc_pct": kcpct, "l1_hz": l1hz, "l2_hz": l2hz,
                           "pr_T500": pr, "retina_photo": r["photo"], "retina_ol": r["ol"],
                           "retina_dn": r["dn"], "loom_dn": ldn}
    brain.params = base
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
