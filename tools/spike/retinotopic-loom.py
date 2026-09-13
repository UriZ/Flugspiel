"""#40 follow-up — does a RETINOTOPIC looming injection rescue fine azimuth at the DNs?

AC1 found that azimuth is decodable at the descending layer only to the precision of
*which hemifield*. The reason is visible in the encoder, not the brain: the shipped
`looming_L`/`looming_R` sites collapse the whole visual field into **two scalars** and
inject each into every LC4/LPLC2 on one side. Azimuth is destroyed at the injection, not
in the network.

The fly's own LC4/LPLC2 are retinotopic. This connectome gives them no `ol_hex` of their
own, but their *presynaptic* partners carry it, so a |w|-weighted modal vote over the
**rows** of W assigns each one an azimuth column. (`encoder.photoreceptor_columns` votes
over the **columns** of W, i.e. postsynaptic partners -- correct for a photoreceptor,
wrong for a projection neuron whose targets are hexless central-brain cells.) The vote is
validated by running it on neurons that DO carry hex: it recovers their own value with
corr +1.000 and >=99.8% exact.

This probe replaces the two scalars with a per-column looming profile -- a Gaussian bump
at each threat's azimuth, scaled by its looming strength -- delivered to each LC4/LPLC2 at
its assigned column, and re-runs the AC1 decode. The decisive cell is
**retinotopic + hemifield-restricted**: the shipped encoder scores chance there.

Run:

    .venv/bin/python tools/spike/retinotopic-loom.py --trials 600

Output shape (values live in issue #40 and SESSION_LOG.md):

    LC4/LPLC2 assigned: ../311, columns spanned ..
    cond=shipped_full     set=dn  R2=..  shuffled=..  margin=..sd
    cond=retino_full      set=dn  R2=..
    cond=shipped_hemi     set=dn  R2=..
    cond=retino_hemi      set=dn  R2=..      <- the decisive cell
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

from src.brain.encoder import Encoder                         # noqa: E402
from src.brain.lif import FlyBrain                            # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping, column, loom  # noqa: E402


SETTLE, RECORD = 4, 8
COLUMNS = 36
SPREAD = 1.5          # columns, same as the retina site's `spread_cols`
LOOM_GAIN = 0.30      # the shipped `looming_*` gain, unchanged
LAMBDAS = np.logspace(-2, 9, 23)


def lc_columns(W, meta, types=("LC4", "LPLC2"), columns: int = COLUMNS) -> dict[int, int]:
    """Neuron index -> azimuth column, by |w|-weighted modal hex1 of PRESYNAPTIC partners."""
    Wr = sparse.csr_matrix(W)
    hex1 = meta.ol_hex[:, 0]
    known = np.isfinite(hex1)
    binned = np.where(known, hex1, 0.0).astype(np.int64)
    nb = int(binned.max()) + 1
    lo, hi = int(binned[known].min()), int(binned[known].max())
    out = {}
    for i in np.flatnonzero(np.isin(meta.cell_type, list(types))):
        row = Wr[i]
        t, w = row.indices, np.abs(row.data)
        ok = known[t]
        if not ok.any():
            continue
        h = int(np.argmax(np.bincount(binned[t[ok]], weights=w[ok], minlength=nb)))
        c = round((h - lo) / (hi - lo) * (columns - 1))
        # hex1 runs the opposite way on the right eye -- the same flip `hex_flip` applies.
        out[int(i)] = (columns - 1 - c) if str(meta.side[i]) == "R" else c
    return out


def mapping_variant(loom_on: bool, loom_gain: float | None = None) -> Mapping:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    for site in raw["sites"]:
        if site["name"].startswith("aim_bias"):
            site["enabled"] = False
        # The scalar pair only, and `looming_code` off in every arm. This probe injects
        # its own coded profile, so leaving the shipped coded site enabled would double
        # it — and a bare `startswith("looming")` did exactly that once the site shipped,
        # which would have made this probe's own published numbers unreproducible (#40).
        if site["name"] == "looming_code":
            site["enabled"] = False
        if site["name"] in ("looming_L", "looming_R"):
            site["enabled"] = loom_on
            if loom_gain is not None:
                site["gain"] = loom_gain
    return Mapping.load(raw)


def frame(az, y, vy):
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": 1.0, "launchers_alive": 6},
            "launchers": [], "interceptors": [],
            "missiles": [{"x": az, "y": y, "vx": 0.0, "vy": vy}]}


def loom_profile(az, y, vy, cfg) -> np.ndarray:
    """Per-column looming strength: a Gaussian bump at the threat's column, scaled by its
    time-to-contact looming value. The 1-D analogue of `Encoder._luminance`."""
    strength = float(loom(np.asarray([y]), np.asarray([vy]), cfg)[0])
    d = np.arange(COLUMNS) - float(column(np.asarray([az]), COLUMNS)[0])
    return np.clip(strength * np.exp(-(d ** 2) / (2.0 * SPREAD ** 2)), 0.0, 1.0).astype(np.float32)


def gram(X, block=20000):
    n, f = X.shape
    K = np.zeros((n, n))
    for lo in range(0, f, block):
        B = X[:, lo:lo + block].astype(np.float32)
        B -= B.mean(axis=0, keepdims=True)
        K += (B @ B.T).astype(np.float64)
    return K


def _solve(w, U, ytr, lam):
    return U @ ((U.T @ (ytr - ytr.mean())) / (w + lam))


def _r2(y, p):
    return float(1.0 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum())


def ridge_eval(K, y, labels, splits, rng):
    n = len(y)
    scores = [[] for _ in range(1 + len(labels))]
    for _ in range(splits):
        perm = rng.permutation(n)
        ntr = int(0.7 * n)
        tr, te = perm[:ntr], perm[ntr:]
        w_tr, U_tr = np.linalg.eigh(K[np.ix_(tr, tr)])
        Kte = K[np.ix_(te, tr)]
        inner = []
        for f in np.array_split(rng.permutation(ntr), 5):
            keep = np.setdiff1d(np.arange(ntr), f)
            wv, Uv = np.linalg.eigh(K[np.ix_(tr[keep], tr[keep])])
            inner.append((f, keep, wv, Uv, K[np.ix_(tr[f], tr[keep])]))
        for j, yv in enumerate([y] + labels):
            best, best_lam = -np.inf, LAMBDAS[0]
            for lam in LAMBDAS:
                pred = np.empty(ntr)
                for f, keep, wv, Uv, Kf in inner:
                    ytr = yv[tr[keep]]
                    pred[f] = Kf @ _solve(wv, Uv, ytr, lam) + ytr.mean()
                s = _r2(yv[tr], pred)
                if s > best:
                    best, best_lam = s, lam
            ytr = yv[tr]
            scores[j].append(_r2(yv[te], Kte @ _solve(w_tr, U_tr, ytr, best_lam) + ytr.mean()))
    return [float(np.mean(s)) for s in scores]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=600)
    ap.add_argument("--splits", type=int, default=4)
    ap.add_argument("--shuffles", type=int, default=15)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--combined", action="store_true")
    ap.add_argument("--addon", action="store_true")
    ap.add_argument("--sided", action="store_true")
    ap.add_argument("--sided-map", choices=("rand", "anat"), default="rand")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    m = brain.meta
    assign = lc_columns(brain.W, m)
    lc_idx = np.array(sorted(assign), dtype=np.int64)
    lc_col = np.array([assign[int(i)] for i in lc_idx], dtype=np.int64)
    total_lc = int(np.isin(m.cell_type, ["LC4", "LPLC2"]).sum())
    print(f"LC4/LPLC2 assigned: {len(lc_idx)}/{total_lc}, columns spanned "
          f"{lc_col.min()}..{lc_col.max()}, distinct={len(set(lc_col.tolist()))}", flush=True)

    sets = {"dn": np.flatnonzero(m.superclass == "descending_neuron"),
            "vproj": np.flatnonzero(m.superclass == "visual_projection"),
            "cb": np.flatnonzero(m.superclass == "cb_intrinsic")}
    # `retina` stays on in every condition so the only thing that changes is how the
    # looming signal is delivered.
    enc_ship = Encoder(brain, mapping_variant(loom_on=True))
    enc_ret = Encoder(brain, mapping_variant(loom_on=False))
    enc_half = Encoder(brain, mapping_variant(loom_on=True, loom_gain=LOOM_GAIN / 2))
    cfg = enc_ship.mapping.loom
    max_inject = enc_ship.mapping.max_inject

    # GOTCHA, and it cost a wrong conclusion once: a per-column Gaussian bump delivers
    # ~10x less total current than the shipped site, which injects the same scalar into all
    # ~155 LC4/LPLC2 on a side. Measured at the shipped gain: injection sum 4.9 vs 49.5, and
    # the descending readouts drop to 0.25-2.5 Hz against 7-14 Hz. The retinotopic condition
    # then scores chance at the DNs *because nothing is driving them*, which looks exactly
    # like the interesting negative result. `match_drive` rescales the profile so the total
    # injected current equals the shipped site's, making the two conditions differ only in
    # how that current is DISTRIBUTED. Both arms are reported.
    # The `random_*` arms are the point of this probe, not an afterthought. The anatomical
    # column map is a HYPOTHESIS: LC4/LPLC2 carry no `ol_hex`, the presynaptic vote leans on
    # 4-8% of their input weight, and its correlation with soma X (+0.13..+0.21) does not
    # reproduce the negative sign the right eye shows for hex-carrying cells. So a negative
    # result under that map would be ambiguous -- "the DNs pool" and "my map is wrong" look
    # identical. A seeded RANDOM tiling answers the question the map cannot: if the
    # descending layer can decode azimuth from *any* fixed spatial pattern over LC4/LPLC2,
    # then the pathway carries spatial structure and only the map is in doubt. If it cannot
    # even then, the DNs pool over the population and no assignment rescues it.
    #   name,          shipped, azimuth range, drive-matched, column map
    #   name,          shipped, azimuth range, drive-matched, column map
    conds = [("shipped_full", True,  (0.02, 0.98), False, None),
             ("retino_full",  False, (0.02, 0.98), True,  "anat"),
             ("retino_hemi",  False, (0.52, 0.98), True,  "anat"),
             ("random_hemi",  False, (0.52, 0.98), True,  "rand"),
             ("random_full",  False, (0.02, 0.98), True,  "rand")]
    if args.sided:
        cm = "sided_anat" if args.sided_map == "anat" else "sided"
        conds = [(f"{args.sided_map}_full", False, (0.02, 0.98), True, cm),
                 (f"{args.sided_map}_hemi", False, (0.52, 0.98), True, cm)]
    elif args.addon:
        # Half/half costs more left/right accuracy than the code buys back: at half gain
        # the lateralised sites stop resolving side cleanly, and on the full field the side
        # cue is worth far more (a perfect side detector alone scores R^2 = 0.75). This arm
        # keeps the lateralised sites at their SHIPPED gain and ADDS the code site on top,
        # so total injected current rises rather than being split.
        conds = [("addon_full", True, (0.02, 0.98), True, "rand"),
                 ("addon_hemi", True, (0.52, 0.98), True, "rand")]
    elif args.combined:
        # The encoder a spec would actually ship: the lateralised sites AND a retinotopic
        # one, each at half strength so the TOTAL injected current is unchanged. Neither
        # arm alone is the recommendation -- shipped wins the full field (side cue) and
        # retinotopic wins within a hemifield, so the question is whether one encoder can
        # hold both at once or whether they interfere.
        # "rand", not "anat": a seeded RANDOM azimuth code over LC4/LPLC2 measured BETTER
        # within a hemifield than the anatomical column map (0.4163 vs 0.2612). What the
        # descending layer needs is that different LC cells receive different amounts as a
        # function of azimuth -- any fixed spatial code does that, and the anatomical guess
        # is not the best one. Do not claim retinotopy for this.
        conds = [("combined_full", "half", (0.02, 0.98), "half", "rand"),
                 ("combined_hemi", "half", (0.52, 0.98), "half", "rand")]
    results = {}
    lc_all = np.flatnonzero(np.isin(m.cell_type, ["LC4", "LPLC2"]))
    rand_col = np.random.default_rng(99).integers(0, COLUMNS, len(lc_idx))
    # SIDE-AWARE code. Measured: a scalar lateralised site and an unsided spatial code
    # INTERFERE rather than add -- run together at half strength each, within-hemifield R^2
    # collapses from 0.4163 (code alone) to 0.0542, because the scalar site drives all ~155
    # LC on a side with a large common signal that swamps the spatial pattern at the DNs.
    # So the two cues have to come from ONE site: constrain each LC cell's column to the
    # half of the azimuth axis matching its own side, exactly as the shipped `looming_L` /
    # `looming_R` routing does, and let position within that half carry the rest.
    _srng = np.random.default_rng(101)
    half = COLUMNS // 2
    sided_col = np.array([
        int(_srng.integers(0, half) if str(m.side[i]) == "L" else _srng.integers(half, COLUMNS))
        for i in lc_idx], dtype=np.int64)
    # The same side constraint applied to the ANATOMICAL column (presynaptic hex vote)
    # instead of a random draw: rank each side's cells by their anatomical column and deal
    # them across that side's half of the azimuth axis, so the anatomical ORDER is kept and
    # the side routing is identical to the random arm. Selected with --sided-map anat.
    sided_anat = np.zeros(len(lc_idx), dtype=np.int64)
    for side, lo in (("L", 0), ("R", half)):
        sel = np.flatnonzero(np.array([str(m.side[i]) for i in lc_idx]) == side)
        if sel.size:
            order = sel[np.argsort(lc_col[sel], kind="stable")]
            sided_anat[order] = lo + (np.arange(order.size) * half // order.size)
    for name, shipped, rng_az, match_drive, colmap in conds:
        cols = {"rand": rand_col, "sided": sided_col,
                "sided_anat": sided_anat}.get(colmap, lc_col)
        enc = enc_half if shipped == "half" else (enc_ship if shipped else enc_ret)
        add_retino = shipped in (False, "half") or args.addon
        half = shipped == "half"
        rng = np.random.default_rng(args.seed)
        az = rng.uniform(*rng_az, args.trials)
        ys = rng.uniform(0.30, 0.70, args.trials)
        vys = rng.uniform(0.15, 0.50, args.trials)
        X = np.zeros((args.trials, brain.n), dtype=np.uint8)
        brain.reset(64)
        for _ in range(200):
            brain.step()
        t0 = time.perf_counter()
        for t in range(args.trials):
            inj = list(enc.encode(frame(az[t], ys[t], vys[t])).inject)
            if add_retino:
                prof = loom_profile(az[t], ys[t], vys[t], cfg)
                amt = (LOOM_GAIN * prof[cols]).astype(np.float32)
                if match_drive:
                    ship = sum(float(a.sum()) for i, a in
                               enc_ship.encode(frame(az[t], ys[t], vys[t])).inject
                               if len(i) and np.isin(i, lc_all).all())
                    if amt.sum() > 0:
                        amt *= np.float32(ship / amt.sum() * (0.5 if half else 1.0))
                amt = np.clip(amt, 0.0, max_inject).astype(np.float32)
                inj.append((lc_idx, amt))
            for _ in range(SETTLE):
                brain.step(inject=inj)
            acc = np.zeros(brain.n, dtype=np.uint8)
            for _ in range(RECORD):
                acc[brain.step(inject=inj)] += 1
            X[t] = acc
        print(f"[{name}] recorded in {time.perf_counter() - t0:.0f}s "
              f"mean_count={X.mean():.3f}", flush=True)
        nulls = [np.random.default_rng(1000 + k).permutation(az) for k in range(args.shuffles)]
        for sname, idx in sets.items():
            got = ridge_eval(gram(X[:, idx]), az, nulls, args.splits,
                             np.random.default_rng(args.seed + 1))
            r2, null = got[0], got[1:]
            mu, sd = float(np.mean(null)), float(np.std(null))
            print(f"cond={name:14s} set={sname:7s} n_feat={len(idx):6d} R2={r2:+.4f}  "
                  f"shuffled={mu:+.4f}+-{sd:.4f}  margin={(r2 - mu) / sd:+.1f}sd", flush=True)
            results[f"{name}/{sname}"] = {"r2": r2, "shuffled_mean": mu, "shuffled_sd": sd}
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
