"""Spike — evidence for the #3 encoder/decoder spec: every neuron-type claim in the
acceptance criteria, checked against the built connectome.

Run:  .venv/bin/python tools/spike/encoder-channels.py       (~90 s, needs data/*.npz)

Expected output (MaleCNS v1.0, seed 0, LIFParams defaults) — abridged:

  R1-6 3377 (L 1112 / R 2265)   R7 1300   R8 1329   all histamine  -> 6006 total
  LC4 126   LPLC2 185   DNa02 2   DNp01 2   DNg100 2   MDN 4
  azimuth: modal ol_hex1 vote assigns 5861/6006 photoreceptors, voter spread <= 0.05 columns
  DNp01 input mass: LC4 0.16-0.18, LPLC2 0.13-0.14   DNa02/DNg100/MDN from LC4+LPLC2: 0.000
  inject LC4+LPLC2 L +0.3  -> DNp01-L 17.5 Hz  vs DNp01-R 0.13 Hz
  inject PFL3 R +1.0       -> DNa02-L 4.19 Hz  vs DNa02-R 0.00 Hz   (contralateral)
  inject DNpe023 +1.0      -> MDN 5.9/6.3 Hz
  inject photoreceptors +2.0 -> LC4/LPLC2/DNa02/DNp01 unchanged within noise
  DNg100: 0.00 Hz under every condition, including its own top-40 input pool at +3.0
"""
import collections
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.brain.connectome import load  # noqa: E402
from src.brain.lif import FlyBrain  # noqa: E402

PHOTO = ("R1-6", "R7", "R8")


def census(m):
    print("== census")
    for t in PHOTO + ("LC4", "LPLC2", "DNa02", "DNp01", "DNg100", "MDN", "PFL3", "DNpe023"):
        i = np.flatnonzero(m.cell_type == t)
        print(f"  {t:8s} n={len(i):5d} sides={dict(collections.Counter(m.side[i].tolist()))} "
              f"nt={dict(collections.Counter(m.nt[i].tolist()))}")


def azimuth(W, m):
    """Photoreceptor azimuth = weighted-modal assignedOlHex1 of its hex-carrying targets."""
    print("== azimuth (modal ol_hex1 vote)")
    Wc, hex1 = W.tocsc(), m.ol_hex[:, 0]
    az = np.full(m.n, np.nan, np.float32)
    for cls in PHOTO:
        idx, spread = np.flatnonzero(m.cell_type == cls), []
        for j in idx:
            s, e = Wc.indptr[j], Wc.indptr[j + 1]
            tgt, w = Wc.indices[s:e], np.abs(Wc.data[s:e])
            ok = np.isfinite(hex1[tgt])
            if not ok.any():
                continue
            t, ww = hex1[tgt[ok]].astype(int), w[ok]
            az[j] = int(np.argmax(np.bincount(t, weights=ww, minlength=40)))
            spread.append(float(np.average((t - az[j]) ** 2, weights=ww)) ** 0.5)
        got = int(np.isfinite(az[idx]).sum())
        print(f"  {cls:5s} {got}/{len(idx)} assigned, voter spread mean={np.mean(spread):.2f} cols")
    print(f"  total {int(np.isfinite(az).sum())}/6006")
    return az


def input_mass(W, m):
    print("== fraction of each DN's input |w| coming from the looming types")
    A = abs(W).tocsr()
    for dn in ("DNa02", "DNp01", "DNg100", "MDN"):
        for d in np.flatnonzero(m.cell_type == dn):
            r = A.getrow(d)
            tot = r.data.sum()
            out = []
            for src in ("LC4", "LPLC2"):
                s = set(np.flatnonzero(m.cell_type == src).tolist())
                out.append(f"{src}={sum(w for p, w in zip(r.indices, r.data) if p in s) / tot:.3f}")
            print(f"  {dn} idx{d} side={m.side[d]}: " + " ".join(out))


def drive(b):
    print("== does injecting at each candidate site reach the AC4 readouts?")
    pop = {f"{t}-{s}": b.cells([t], side=s)
           for t in ("DNa02", "DNp01", "DNg100", "MDN") for s in ("L", "R")}

    def run(inj, tag, settle=150, measure=400, seeds=(0, 1)):
        agg = {k: [] for k in pop}
        for sd in seeds:
            b.reset(sd)
            c = {k: 0 for k in pop}
            for i in range(settle + measure):
                f = b.step(inject=inj)
                if i >= settle:
                    msk = np.zeros(b.n, bool)
                    msk[f] = True
                    for k, ix in pop.items():
                        c[k] += int(msk[ix].sum())
            for k in pop:
                agg[k].append(c[k] / measure / max(len(pop[k]), 1) / b.params.dt)
        print(f"  {tag:34s} " + " ".join(f"{k}={np.mean(agg[k]):6.2f}" for k in pop))

    photo = b.cells(list(PHOTO))
    loom_l = np.concatenate([b.cells(["LC4"], side="L"), b.cells(["LPLC2"], side="L")])
    loom_r = np.concatenate([b.cells(["LC4"], side="R"), b.cells(["LPLC2"], side="R")])
    run((), "baseline")
    run([(photo, np.float32(2.0))], "photoreceptors +2.0")
    run([(loom_l, np.float32(0.3))], "LC4+LPLC2 L +0.3")
    run([(loom_r, np.float32(0.3))], "LC4+LPLC2 R +0.3")
    run([(b.cells(["PFL3"], side="L"), np.float32(1.0))], "PFL3 L +1.0")
    run([(b.cells(["PFL3"], side="R"), np.float32(1.0))], "PFL3 R +1.0")
    run([(b.cells(["DNpe023"]), np.float32(1.0))], "DNpe023 +1.0")
    run([(b.cells(["NPFL1-I", "Hugin-RG", "CRZ", "CRZ01,CRZ02", "DH44", "LK",
                   "IPC", "ISN", "AstA1", "DSKMP3"]), np.float32(3.0))], "drive/hunger pool +3.0")


if __name__ == "__main__":
    W, m = load()
    census(m)
    azimuth(W, m)
    input_mass(W, m)
    drive(FlyBrain.load(seed=0))
