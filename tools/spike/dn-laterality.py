"""#40 AC2 — rank every descending neuron by laterality under left vs right looming.

#3 measured four DNs chosen by name from the literature. This measures all 1,314 chosen
by response. Blocks of left-looming and right-looming stimulation are interleaved in a
seeded random order (not alternating -- alternation aliases against any slow drift in the
network), each DN's per-block spike count is collected, and the separation is scored as
Cohen's d between the two block sets.

The margin that matters is **selection-corrected**: with 1,314 neurons the largest |d| is
large by chance alone, so the null here is the distribution of `max |d| over all DNs` under
permuted block labels. A candidate is only real if it clears that ceiling.

Run:

    .venv/bin/python tools/spike/dn-laterality.py --blocks 80 --perms 400

Output shape (values are in issue #40 and SESSION_LOG.md, never here):

    blocks=.. per_block_steps=.. dn=1314
    null: max|d| over DNs, permuted labels: p50=..  p95=..  p99=..  max=..
    rank  type          side  n   d       LI      hz_L     hz_R
    ...
    candidates clearing the p99 selection ceiling: ..

Deterministic given the seeds; wall time is load-sensitive.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.brain.encoder import Encoder                        # noqa: E402
from src.brain.lif import FlyBrain                           # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping  # noqa: E402

SETTLE = 4
RECORD = 12


def mapping_no_prosthesis() -> Mapping:
    """Looming + retina as shipped, PFL3 off: the sweep must not find the prosthesis."""
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for site in raw["sites"]:
        if site["name"].startswith("aim_bias"):
            site["enabled"] = False
    return Mapping.load(raw)


def frame(side: str) -> dict:
    """One missile bearing down, hard left or hard right. vy puts loom at its ceiling."""
    x = 0.12 if side == "L" else 0.88
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [],
            "missiles": [{"x": x, "y": 0.55, "vx": 0.0, "vy": 0.45}]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", type=int, default=80)     # half L, half R
    ap.add_argument("--perms", type=int, default=400)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    enc = Encoder(brain, mapping_no_prosthesis())
    dn = np.flatnonzero(brain.meta.superclass == "descending_neuron")
    dt = brain.params.dt

    rng = np.random.default_rng(args.seed)
    order = np.array(["L"] * (args.blocks // 2) + ["R"] * (args.blocks // 2))
    rng.shuffle(order)

    inj = {s: enc.encode(frame(s)).inject for s in ("L", "R")}
    counts = np.zeros((args.blocks, len(dn)), dtype=np.int32)
    brain.reset(64)
    for _ in range(200):
        brain.step()
    t0 = time.perf_counter()
    mask = np.zeros(brain.n, dtype=np.int32)
    for b, s in enumerate(order):
        for _ in range(SETTLE):
            brain.step(inject=inj[s])
        for _ in range(RECORD):
            np.add.at(mask, brain.step(inject=inj[s]), 1)
        counts[b] = mask[dn]
        mask[:] = 0
    print(f"blocks={args.blocks} per_block_steps={SETTLE + RECORD} dn={len(dn)} "
          f"recorded in {time.perf_counter() - t0:.0f}s", flush=True)

    is_L = order == "L"

    def cohens_d(sel: np.ndarray) -> np.ndarray:
        a, b = counts[sel], counts[~sel]
        va, vb = a.var(axis=0, ddof=1), b.var(axis=0, ddof=1)
        pooled = np.sqrt((va + vb) / 2.0)
        return np.where(pooled > 0, (a.mean(axis=0) - b.mean(axis=0)) / np.maximum(pooled, 1e-12), 0.0)

    d = cohens_d(is_L)
    hz_L = counts[is_L].mean(axis=0) / (RECORD * dt)
    hz_R = counts[~is_L].mean(axis=0) / (RECORD * dt)
    LI = (hz_L - hz_R) / (hz_L + hz_R + 1e-3)

    # Selection-corrected null: the biggest |d| the sweep would report on pure noise.
    nrng = np.random.default_rng(args.seed + 1)
    null_max = np.array([np.abs(cohens_d(nrng.permutation(is_L))).max()
                         for _ in range(args.perms)])
    p50, p95, p99 = np.percentile(null_max, [50, 95, 99])
    print(f"null: max|d| over {len(dn)} DNs, {args.perms} permuted labellings: "
          f"p50={p50:.3f} p95={p95:.3f} p99={p99:.3f} max={null_max.max():.3f}", flush=True)

    rank = np.argsort(-np.abs(d))
    print(f"{'rank':>4} {'type':<16}{'side':<5}{'d':>8}{'LI':>8}{'hz_L':>9}{'hz_R':>9}"
          f"{'clears_p99':>12}")
    for r, i in enumerate(rank[:args.top]):
        g = dn[i]
        print(f"{r + 1:>4} {str(brain.meta.cell_type[g]):<16}{str(brain.meta.side[g]):<5}"
              f"{d[i]:>+8.3f}{LI[i]:>+8.3f}{hz_L[i]:>9.2f}{hz_R[i]:>9.2f}"
              f"{str(abs(d[i]) > p99):>12}")
    n_clear = int((np.abs(d) > p99).sum())
    print(f"candidates clearing the p99 selection ceiling: {n_clear} of {len(dn)}", flush=True)

    # The four DNs #3 measured by name, for comparison.
    for want in ("DNa02", "DNp01", "DNg100", "MDN"):
        sel = np.flatnonzero(brain.meta.cell_type[dn] == want)
        if sel.size:
            print(f"named: {want:<8} n={sel.size:<4} |d| max={np.abs(d[sel]).max():.3f} "
                  f"pooled hz_L={hz_L[sel].sum():.2f} hz_R={hz_R[sel].sum():.2f}", flush=True)

    if args.out:
        args.out.write_text(json.dumps({
            "blocks": args.blocks, "perms": args.perms, "n_dn": int(len(dn)),
            "null_p50": p50, "null_p95": p95, "null_p99": p99,
            "null_max": float(null_max.max()), "n_clearing_p99": n_clear,
            "top": [{"rank": r + 1, "type": str(brain.meta.cell_type[dn[i]]),
                     "side": str(brain.meta.side[dn[i]]), "d": float(d[i]),
                     "LI": float(LI[i]), "hz_L": float(hz_L[i]), "hz_R": float(hz_R[i])}
                    for r, i in enumerate(rank[:args.top])],
        }, indent=2))


if __name__ == "__main__":
    main()
