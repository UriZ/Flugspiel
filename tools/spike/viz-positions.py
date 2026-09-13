"""Export a 2D screen layout for #6's canvas-model spike (tools/spike/viz-canvas-model.mjs).

    NOT the shipped artifact. `tools/build-viz-layout.py` is the build-time generator
    that produces `assets/viz-layout.bin` for the panel; this file exists only to feed
    the canvas-model benchmark and its format is deliberately simpler. Change the other
    one when the panel needs something.


    python3 tools/spike/viz-positions.py OUT.bin

Reads `data/brain.npz` (BrainMeta) and writes a little-endian binary the fixture fetches:

    uint32 n
    uint32 n_super                      number of superclasses
    uint16[2*n]  xy                     normalised to [0,65535], packed x0,y0,x1,y1,...
    uint8[n]     super_idx              index into the name table
    uint8[n]     placed                 1 = real soma coordinate, 0 = synthesised
    then n_super NUL-terminated UTF-8 superclass names, ascending by index

Projection is X (medio-lateral, the midline is centred) against Z, which is the axis
that separates brain from ventral nerve cord: cb_intrinsic sits at z~26.6k and
vnc_motor at z~101.9k. Aspect of the XZ hull is 0.73 — taller than wide, which is the
shape of #5's viz panel (797x872).

84.4% of neurons (140,638 / 166,700) carry a soma position. The 26,062 that do not are
almost entirely sensory (vnc_sensory 6,368, ol_sensory 6,070, cb_sensory 4,868) plus
7,718 ol_intrinsic. They are NOT scattered into the anatomy — they are laid out in a
grid band under it, per superclass, so the map never invents a location for a neuron
that has none. `placed` marks which is which so the spike can report both counts.

Expected output on the real data, 2026-09-13:
    n=166700 placed=140638 (84.4%) superclasses=27  -> 1000268 bytes
"""
import sys
import numpy as np

out_path = sys.argv[1]
z = np.load("data/brain.npz", allow_pickle=True)
pos, sup = z["position"], z["superclass"]
n = len(pos)

names = sorted(set(sup.tolist()))
assert len(names) < 256, len(names)
sidx = np.searchsorted(np.array(names), sup).astype(np.uint8)

ok = ~np.isnan(pos).any(1)
x, y = pos[:, 0].astype(np.float64), pos[:, 2].astype(np.float64)
x0, x1 = x[ok].min(), x[ok].max()
y0, y1 = y[ok].min(), y[ok].max()
s = min(1.0 / (x1 - x0), 1.0 / (y1 - y0))          # isotropic: no anatomy stretching
nx = np.zeros(n)
ny = np.zeros(n)
nx[ok] = (x[ok] - x0) * s
ny[ok] = (y[ok] - y0) * s
# Centre the anatomy horizontally and leave the bottom 12% for the unplaced band.
nx = 0.5 + (nx - (nx[ok].max() / 2)) if ok.any() else nx
ny = ny * 0.86

# Unplaced neurons: a grid band per superclass, in superclass order then index order.
miss = np.flatnonzero(~ok)
order = miss[np.lexsort((miss, sidx[miss]))]
cols = 560
for k, i in enumerate(order):
    nx[i] = 0.02 + 0.96 * ((k % cols) / cols)
    ny[i] = 0.88 + 0.11 * ((k // cols) / max(1, (len(order) - 1) // cols))

xy = np.empty(2 * n, dtype=np.uint16)
xy[0::2] = np.clip(nx, 0, 1) * 65535
xy[1::2] = np.clip(ny, 0, 1) * 65535

with open(out_path, "wb") as f:
    f.write(np.array([n, len(names)], dtype="<u4").tobytes())
    f.write(xy.astype("<u2").tobytes())
    f.write(sidx.tobytes())
    f.write(ok.astype(np.uint8).tobytes())
    for nm in names:
        f.write(nm.encode() + b"\0")

print(f"n={n} placed={int(ok.sum())} ({100 * ok.mean():.1f}%) superclasses={len(names)}"
      f"  -> {open(out_path, 'rb').seek(0, 2) or __import__('os').path.getsize(out_path)} bytes")
