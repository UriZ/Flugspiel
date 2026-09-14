"""#59 AC1 — what is downstream of the mushroom body output neurons?

    .venv/bin/python tools/spike/mbon-fanout.py            # ~40 s, needs data/weights.npz

#7 concluded the reward loop cannot reach the game because there is no MBON->DNp01 edge.
DNp01 was a choice, so this asks the prior question: rank EVERY neuron by MBON input and
find out whether any descending neuron is a plausible readout. Anatomy only — no
behavioural test, because choosing a readout that the loop is known to move would select
on the outcome (#59 AC3).

`W` is `W[post, pre]`, input-normalised: each row's |w| sums to 1 (connectome.py:220).
So "MBON input fraction" f_w(j) = sum|w| from MBONs into j, and it is already a share.

Three controls, because a fraction with no scale means nothing:
  * ORACLE      - a size-matched random cb_intrinsic set. MBONs project 2.6x more than the
                  median cb_intrinsic neuron, so the naive version is under-powered; the
                  one that decides is matched on total |w| SENT.
  * KNOWN-POSITIVE - KC->MBON, the strongest pathway in this circuit, in the same units.
  * MULTI-HOP   - A @ A @ m, in case MBONs reach DNs through an interneuron.

EXPECTED OUTPUT (HEAD 38c74ee, MaleCNS v1.0, 166,700 neurons / 25,582,938 edges):

    MBON set                        97 neurons, 36 types, all cb_intrinsic
    neurons receiving ANY MBON      11,342 of 166,700 (6.80%)
    descending_neuron               170 of 1,314 receive any; mean f_w 0.00064, max 0.07053
                                    (reproduces #7's figure exactly)
    strongest DN                    DNp52 bodyId 11121, f_w 0.0705, 22 of 352 inputs
    strongest target anywhere       CB1079 bodyId 141597, f_w 0.4281  (cb_intrinsic)
    DRIVE-MATCHED NULL, DN max      observed 0.07053 vs null 0.1207 +/- 0.0384, p(null>=obs) 92.5%
    DRIVE-MATCHED NULL, DN mean     observed 0.00064 vs null 0.00367 +/- 0.00086, p 100.0%
    KC->MBON median                 0.5672  (the best MBON->DN edge is 8.0x weaker than this)
    DNs with zero MBON input        1,144 of 1,314
    two-hop DN max                  0.02276 -- LOWER than one-hop; null p 31% / mean p 100%

CONCLUSION: matched for total output drive, the MBONs reach the descending population
LESS than every one of 200 random central-brain sets. Adding hops dilutes rather than
concentrates. AC1 is answered NO and #59 stops here.

Exit 0 always - this is a measurement, not a gate.
"""
import sys
from pathlib import Path

import numpy as np
import scipy.sparse as sp

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.brain import connectome as C          # noqa: E402
from src.brain.lif import LIFParams            # noqa: E402

DRAWS = 200
SEED = 64


def _shares(Wc, colof, rows, absd, total_w, n, src):
    """Input-weight share contributed by `src` to every neuron."""
    m = np.zeros(n, dtype=bool)
    m[src] = True
    keep = m[colof]
    w = np.bincount(rows[keep], weights=absd[keep], minlength=n)
    return np.divide(w, total_w, out=np.zeros(n), where=total_w > 0)


def _matched_draw(rng, pool, logp, logm, used_width=12):
    """97 neurons matched to the MBONs on total |w| sent, so total drive is equal."""
    pick, used = [], set()
    for t in logm:
        cand = np.argsort(np.abs(logp - t))[:used_width]
        cand = [c for c in cand if c not in used] or list(cand)
        c = rng.choice(cand)
        used.add(c)
        pick.append(pool[c])
    return np.array(pick)


def main() -> int:
    W, meta = C.load()
    n, ct, sc = meta.n, meta.cell_type, meta.superclass
    Wc = W.tocsc()
    rows, absd = Wc.indices, np.abs(Wc.data)
    colof = np.repeat(np.arange(n), np.diff(Wc.indptr))
    total_w = np.bincount(rows, weights=absd, minlength=n)
    total_k = np.bincount(rows, minlength=n)
    outw = np.bincount(colof, weights=absd, minlength=n)

    up = np.char.upper(ct.astype(str))
    mbon = np.flatnonzero(np.char.startswith(up, 'MBON'))
    kc = np.flatnonzero(np.char.startswith(up, 'KC'))
    dn = np.flatnonzero(sc == 'descending_neuron')
    cb = np.flatnonzero(sc == 'cb_intrinsic')

    fw = _shares(Wc, colof, rows, absd, total_w, n, mbon)
    k_mb = np.bincount(rows[np.isin(colof, mbon)], minlength=n)

    print(f'MBON set: {len(mbon)} neurons, {len(set(ct[mbon].tolist()))} types, '
          f'superclasses {sorted(set(sc[mbon].tolist()))}')
    print(f'receiving ANY MBON input: {int((k_mb > 0).sum())} of {n} '
          f'({100 * (k_mb > 0).mean():.2f}%)\n')

    print(f'{"superclass":<24}{"size":>7}{"recv":>7}{"mean f_w":>11}{"max f_w":>10}')
    for s in sorted(set(sc.tolist())):
        idx = np.flatnonzero(sc == s)
        r = int((k_mb[idx] > 0).sum())
        if r:
            print(f'{s:<24}{len(idx):>7}{r:>7}{fw[idx].mean():>11.5f}{fw[idx].max():>10.5f}')

    best = dn[np.argmax(fw[dn])]
    print(f'\nstrongest DN      : {ct[best]} bodyId {meta.ids[best]} side {meta.side[best]} '
          f'f_w {fw[best]:.4f} ({k_mb[best]}/{total_k[best]} inputs)')
    top = int(np.argmax(fw))
    print(f'strongest anywhere: {ct[top]} bodyId {meta.ids[top]} f_w {fw[top]:.4f} ({sc[top]})')
    print(f'DNs with zero MBON input: {int((fw[dn] == 0).sum())} of {len(dn)}')

    print(f'\nMBON out-|w| median {np.median(outw[mbon]):.4f} vs cb_intrinsic median '
          f'{np.median(outw[cb]):.4f}  -> MBONs project '
          f'{np.median(outw[mbon]) / np.median(outw[cb]):.1f}x more than a typical cb neuron')

    rng = np.random.default_rng(SEED)
    pool = np.setdiff1d(cb, mbon)
    logp = np.log10(np.maximum(outw[pool], 1e-6))
    logm = np.log10(np.maximum(outw[mbon], 1e-6))
    mx, mn, sent = [], [], []
    for _ in range(DRAWS):
        pick = _matched_draw(rng, pool, logp, logm)
        f = _shares(Wc, colof, rows, absd, total_w, n, pick)
        mx.append(f[dn].max())
        mn.append(f[dn].mean())
        sent.append(outw[pick].sum())
    mx, mn, sent = np.array(mx), np.array(mn), np.array(sent)
    print(f'\nDRIVE-MATCHED NULL ({DRAWS} draws): MBON sends {outw[mbon].sum():.1f}, '
          f'null sends {sent.mean():.1f} +/- {sent.std():.1f}')
    print(f'  DN max  observed {fw[dn].max():.5f} | null {mx.mean():.5f} +/- {mx.std():.5f}  '
          f'p(null>=obs) {100 * (mx >= fw[dn].max()).mean():.1f}%')
    print(f'  DN mean observed {fw[dn].mean():.5f} | null {mn.mean():.5f} +/- {mn.std():.5f}  '
          f'p(null>=obs) {100 * (mn >= fw[dn].mean()).mean():.1f}%')

    f_kc = _shares(Wc, colof, rows, absd, total_w, n, kc)
    print(f'\nKNOWN-POSITIVE  KC->MBON median {np.median(f_kc[mbon]):.4f}; the best MBON->DN '
          f'edge ({fw[dn].max():.4f}) is {np.median(f_kc[mbon]) / fw[dn].max():.1f}x weaker')

    Aw = W.copy()
    Aw.data = np.abs(Aw.data)
    A = Aw.tocsr()
    rn = np.asarray(A.sum(axis=1)).ravel()
    rn[rn == 0] = 1.0
    A = sp.diags(1.0 / rn).tocsr() @ A
    m = np.zeros(n)
    m[mbon] = 1.0
    f1 = A @ m
    assert np.abs(f1 - fw).max() < 1e-6, 'A orientation is wrong'   # CSC arrays into csr_matrix transpose
    f2 = A @ f1
    print(f'\nMULTI-HOP  DN max: 1-hop {f1[dn].max():.5f} -> 2-hop {f2[dn].max():.5f} '
          f'(adding a hop DILUTES); 2-hop mean {f2[dn].mean():.5f}')

    p = LIFParams()
    drive = p.gain * fw[best] * total_w[best]
    print(f'\nDYNAMICS  if all {len(mbon)} MBONs fired on one step, {ct[best]} gains {drive:.4f} V '
          f'against threshold {p.threshold} — {drive / p.noise_amp:.2f} of ONE noise event.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
