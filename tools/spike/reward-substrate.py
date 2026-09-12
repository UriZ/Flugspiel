"""Spike: does #7's dopamine substrate exist in this connectome, and is it wired to the
game readout? Deterministic — no LIF dynamics, no RNG, load-insensitive.

    PYTHONPATH=. python tools/spike/reward-substrate.py

Expected output (MaleCNS v1.0, data/brain.npz + data/weights.npz):

    PAM11          n=15   nt=dopamine   sides L=8 R=7
    PPL101         n=2    nt=dopamine   sides L=1 R=1
    KC (12 types)  n=4064 MBON (36 types) n=97
    KC->MBON       nnz=61210  sum|w|=56.178
    PAM11 compartment  MBON07 0.2859  MBON06 0.0130
    PPL101 compartment MBON25,MBON34 0.1291  MBON11 0.0982  MBON20 0.0156  MBON30 0.0109
    MBON -> DN: 170/1314 DNs receive any MBON input; best DNp52 0.0705
      DNa02 0.0065/0.0039   DNp01 0.0000   DNg100 0.0000   MDN ~0.004
    ALIAS csc->csc same dtype shares data: True      <- FlyBrain.__init__ hazard
"""
from __future__ import annotations

import collections
from pathlib import Path

import numpy as np
from scipy import sparse

from src.brain.connectome import load

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    W, m = load(ROOT / "data")
    ct = m.cell_type
    kc = np.flatnonzero(np.char.startswith(ct, "KC"))
    mb = np.flatnonzero(np.char.startswith(ct, "MBON"))
    dn = np.flatnonzero(m.superclass == "descending_neuron")

    for t in ("PAM11", "PPL101"):
        i = np.flatnonzero(ct == t)
        sides = collections.Counter(m.side[i].tolist())
        print(f"{t:14s} n={len(i):<5d} nt={sorted(set(m.nt[i].tolist()))} "
              f"sides L={sides['L']} R={sides['R']}")
    print(f"KC ({len(set(ct[kc].tolist()))} types)  n={len(kc)} "
          f"MBON ({len(set(ct[mb].tolist()))} types) n={len(mb)}")

    Wr = W.tocsr()
    S = Wr[np.ix_(mb, kc)]
    print(f"KC->MBON       nnz={S.nnz}  sum|w|={np.abs(S.data).sum():.3f}")

    # A compartment is the set of MBONs a DAN innervates. Rows of W are input-normalised,
    # so the number is the fraction of that MBON's total input arriving from the DAN.
    for dan in ("PAM11", "PPL101"):
        pre = np.flatnonzero(ct == dan)
        s = np.abs(Wr[np.ix_(mb, pre)]).sum(axis=1).A.ravel()
        agg: collections.Counter = collections.Counter()
        for j, v in zip(mb, s):
            agg[ct[j]] += float(v)
        top = [f"{t} {v:.4f}" for t, v in agg.most_common(4) if v > 0.01]
        print(f"{dan} compartment  " + "  ".join(top))

    fr = np.abs(Wr[np.ix_(dn, mb)]).sum(axis=1).A.ravel()
    best = int(np.argmax(fr))
    print(f"MBON -> DN: {int((fr > 0).sum())}/{len(dn)} DNs receive any MBON input; "
          f"best {ct[dn[best]]} {fr[best]:.4f}")
    parts = []
    for t in ("DNa02", "DNp01", "DNg100", "MDN"):
        parts.append(f"{t} " + "/".join(f"{v:.4f}" for v in fr[ct[dn] == t]))
    print("  " + "   ".join(parts))

    d = np.ones(3, np.float32)
    A = sparse.csc_matrix((d, ([0, 1, 2], [0, 1, 2])), shape=(3, 3), dtype=np.float32)
    print("ALIAS csc->csc same dtype shares data:",
          np.shares_memory(A.data, sparse.csc_matrix(A, dtype=np.float32).data))


if __name__ == "__main__":
    main()
