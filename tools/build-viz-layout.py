"""Build the static layout artifact the #6 visualization panel fetches once.

    python3 tools/build-viz-layout.py [-o assets/viz-layout.bin]

Promoted out of `tools/spike/viz-positions.py`, which was a measurement aid. This is a
build artifact: `src/viz/layout.js` parses it and refuses to draw the map if the magic,
the version or `n` disagree with `ready.n`.

Why a binary fetched once rather than a field on the wire: the client needs a screen
coordinate and a class for all 166,700 neurons plus identity for 1,314 descending
neurons. Putting that in `ready` would re-send ~890 KB of base64 on every reconnect.

Coordinates
-----------
Source is `BrainMeta.position` — `somaLocation` from the MaleCNS v1.0 body annotations,
falling back to the soma-tract point. 140,638 of 166,700 neurons carry one.

Projection is X (medio-lateral) against Z (the axis running brain -> ventral nerve cord).
Y is discarded; this is a flat dorsal-up view, no rotation and no perspective.

The neurons are split into two independently-framed panes because a single frame cannot
show both: nearly all of the somas sit in the top fraction of the Z extent, and the neck
connective between brain and VNC is empty. Each pane is normalised into its OWN bounding
box, so the client contain-fits each into its own rect. The two panes are therefore at
DIFFERENT scales, which is why `pane_um` exists — the client must draw a scale bar on
each, or the difference is invisible and misleading.

VOXEL_NM is an assumption this file makes explicit rather than burying. `somaLocation` is
stored as integer voxel coordinates with no units recorded anywhere in the feather
schema. 8 nm/voxel is the imaging resolution of the MaleCNS v1.0 EM volume. The check
that it is not merely plausible but discriminating: at 8 nm the derived CNS length and
brain width land squarely on known Drosophila anatomy, while the neighbouring candidates
(4 nm, 16 nm) put them off by a factor of two in either direction, well outside the
biological range. If this constant is ever shown to be wrong, the scale bars are wrong
with it and nothing else in the artifact changes.

Binary layout (little-endian throughout; every array starts 4-byte aligned)
--------------------------------------------------------------------------
    header, 72 bytes, zero-padded
        u8[6]   magic  b"FSVIZL"
        u16     version
        u32     n, n_super, n_dn, n_dn_type, n_seg, dn_cols, names_bytes, n_mark, n_grp
        f32[3]  pane_aspect   w/h of each pane's bbox, for the contain-fit
        f32[3]  pane_um       bbox width in micrometres, for the scale bars
    u16[2n]     uv            normalised WITHIN the neuron's own pane, [0,65535]
    u32[n_dn]   dn_slot       global neuron index of descending slot k
    u32[n_seg]  seg_count
    f32[n_seg]  seg_u0, seg_u1
    u16[n_dn]   dn_type       index into the DN type-name table
    u16[n_dn]   dn_col        tick column for slot k, shared by the L and R members of
                              a type so bilateral firing reads as a vertical pair
    u8[n]       pane          0 = brain, 1 = vnc, 2 = no soma position
    u8[n]       super_idx     index into the class-name table
    u8[n_dn]    dn_side       0 = L, 1 = R, 2 = M
    u8[n_seg]   seg_super     index into the class-name table, 255 = "other"
    u32[n_mark] mark_idx      neuron indices of every marked group, concatenated
    u32[n_grp]  grp_off, grp_count
    u16[n_grp]  grp_name      index into the group-name table
    u8[n_grp]   grp_role      0 = game readout channel, 1 = prosthetic injection site
    u8[n_grp]   grp_enabled   0 = declared in the mapping but switched off
    u8[n_grp]   grp_side      0 = L, 1 = R, 2 = M, 3 = either
    u8[names_bytes]           n_super, then n_dn_type, then n_grp NUL-terminated names

Marked groups exist so the panel never hardcodes a descending slot number or a cell
type. Which neurons a game channel reads and which are driven by a prosthesis are
properties of `src/brain/mappings/*.json` against this connectome, and resolving them
here means a mapping edit re-resolves on the next build instead of silently leaving the
panel labelling the wrong neurons.

Index i is `BrainMeta.ids[i]` order — the same order as both axes of W and of the packed
spike vector, so `uv[i]` belongs to the neuron whose bit is `i` in a snapshot.

Run it to see the summary it prints; the figures belong on the issue, not in this file.
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

MAGIC = b"FSVIZL"
VERSION = 2
HEADER_BYTES = 72
VOXEL_NM = 8.0                 # see module docstring
BRAIN_VNC_SPLIT = 0.30         # normalised Z; the band around it holds ~1 soma
PANE_BRAIN, PANE_VNC, PANE_NONE = 0, 1, 2
UNPLACED_COLS = 168            # lattice columns in the "no soma position" strip
SEG_GAP = 0.004                # normalised gap between strip segments
SEG_OTHER = 255
ROLE_READOUT, ROLE_PROSTHESIS = 0, 1
SIDE_ANY = 3


def _align4(b: bytearray) -> None:
    while len(b) % 4:
        b.append(0)


def build(npz: Path, mapping_path: Path | None = None) -> tuple[bytes, dict]:
    mapping = json.loads(mapping_path.read_text()) if mapping_path and mapping_path.exists() else None
    z = np.load(npz, allow_pickle=True)
    pos, sup, ctype, side = z["position"], z["superclass"], z["cell_type"], z["side"]
    n = len(pos)

    classes = sorted(set(sup.tolist()))
    if len(classes) > 255:
        raise SystemExit(f"{len(classes)} superclasses exceeds the uint8 class index")
    super_idx = np.searchsorted(np.array(classes), sup).astype(np.uint8)

    x, zc = pos[:, 0].astype(np.float64), pos[:, 2].astype(np.float64)
    placed = ~np.isnan(pos).any(1)
    if not placed.any():
        raise SystemExit("no neuron carries a soma position")

    # Pane assignment. The split is on Z normalised across the placed neurons only —
    # an unplaced neuron has no Z at all and cannot be classified by it.
    z0, z1 = zc[placed].min(), zc[placed].max()
    nz = np.zeros(n)
    nz[placed] = (zc[placed] - z0) / (z1 - z0)
    pane = np.full(n, PANE_NONE, dtype=np.uint8)
    pane[placed & (nz < BRAIN_VNC_SPLIT)] = PANE_BRAIN
    pane[placed & (nz >= BRAIN_VNC_SPLIT)] = PANE_VNC

    u = np.zeros(n)
    v = np.zeros(n)
    aspect = np.zeros(3, dtype=np.float32)
    pane_um = np.zeros(3, dtype=np.float32)

    for p in (PANE_BRAIN, PANE_VNC):
        m = pane == p
        w = x[m].max() - x[m].min()
        h = zc[m].max() - zc[m].min()
        # Normalised within the pane's own bbox. The client owns the rect and does the
        # isotropic contain-fit; the generator owns the anatomy and nothing else.
        u[m] = (x[m] - x[m].min()) / w
        v[m] = (zc[m] - zc[m].min()) / h
        aspect[p] = w / h
        pane_um[p] = w * VOXEL_NM / 1000.0

    # The neurons with no soma position are laid out on a deliberately regular lattice,
    # grouped by class, so the strip reads as a list and can never be mistaken for
    # anatomy. They are never dropped and never scattered into the two real panes.
    none_idx = np.flatnonzero(pane == PANE_NONE)
    counts = {c: int((super_idx[none_idx] == classes.index(c)).sum()) for c in classes}
    counts = {c: k for c, k in counts.items() if k}
    major = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
    major_names = {c for c, _ in major}
    other_total = sum(k for c, k in counts.items() if c not in major_names)
    segments = [(classes.index(c), k) for c, k in major]
    if other_total:
        segments.append((SEG_OTHER, other_total))

    seg_super = np.array([s for s, _ in segments], dtype=np.uint8)
    seg_count = np.array([k for _, k in segments], dtype=np.uint32)
    widths = seg_count / seg_count.sum()
    seg_u0 = np.zeros(len(segments), dtype=np.float32)
    seg_u1 = np.zeros(len(segments), dtype=np.float32)
    span = 1.0 - SEG_GAP * (len(segments) - 1)
    cursor = 0.0
    for s, frac in enumerate(widths):
        seg_u0[s] = cursor
        cursor += frac * span
        seg_u1[s] = cursor
        cursor += SEG_GAP

    # Order within the strip: segment, then class, then global index — deterministic, so
    # a neuron keeps its cell across rebuilds of the same data.
    seg_of = {}
    for s, (sidx, _) in enumerate(segments):
        for c in classes:
            ci = classes.index(c)
            if sidx == SEG_OTHER and c not in major_names and counts.get(c):
                seg_of[ci] = s
            elif ci == sidx:
                seg_of[ci] = s
    order = sorted(none_idx.tolist(), key=lambda i: (seg_of[int(super_idx[i])], int(super_idx[i]), i))
    filled = {s: 0 for s in range(len(segments))}
    for i in order:
        s = seg_of[int(super_idx[i])]
        k = filled[s]
        filled[s] += 1
        rows = max(1, -(-int(seg_count[s]) // UNPLACED_COLS))
        cols = min(UNPLACED_COLS, int(seg_count[s]))
        u[i] = seg_u0[s] + (seg_u1[s] - seg_u0[s]) * ((k % cols) + 0.5) / cols
        v[i] = ((k // cols) + 0.5) / rows
    aspect[PANE_NONE] = 0.0     # the strip is not anatomy; it has no meaningful aspect
    pane_um[PANE_NONE] = 0.0    # and no scale

    uv = np.empty(2 * n, dtype=np.uint16)
    uv[0::2] = np.rint(np.clip(u, 0, 1) * 65535)
    uv[1::2] = np.rint(np.clip(v, 0, 1) * 65535)

    # ---- descending neurons -------------------------------------------------------
    # `descending.active` on the wire is a list of positions into THIS array, so its
    # construction must match `ws_server.py`'s `flatnonzero(superclass == ...)` exactly.
    dn_slot = np.flatnonzero(sup == "descending_neuron").astype(np.uint32)
    dn_ct = ctype[dn_slot]
    dn_types = sorted(set(dn_ct.tolist()))
    if len(dn_types) > 65535:
        raise SystemExit("DN type table exceeds the uint16 index")
    dn_type = np.searchsorted(np.array(dn_types), dn_ct).astype(np.uint16)
    side_code = {"L": 0, "R": 1}
    dn_side = np.array([side_code.get(s, 2) for s in side[dn_slot]], dtype=np.uint8)

    # One column per (type, within-side rank), SHARED by that type's L and R members, so
    # a bilaterally firing type draws one tick directly above the other. Allocating a
    # column per neuron instead would slide the two rows out of register wherever a type
    # has an unequal number on each side, and the vertical pairing is the whole point of
    # the two-row strip.
    dn_col = np.zeros(len(dn_slot), dtype=np.uint16)
    col = 0
    for t in range(len(dn_types)):
        members = np.flatnonzero(dn_type == t)
        rank: dict[int, int] = {}
        for k in members:
            s = int(dn_side[k])
            if s == 2:
                continue
            dn_col[k] = col + rank.get(s, 0)
            rank[s] = rank.get(s, 0) + 1
        col += max(rank.values()) if rank else 0
    dn_cols = col
    for j, k in enumerate(np.flatnonzero(dn_side == 2)):   # midline: its own short row
        dn_col[k] = j

    # ---- marked groups: game readout channels and prosthetic injection sites -------
    groups: list[tuple[str, int, int, int, np.ndarray]] = []   # name, role, enabled, side, idx
    side_code_any = {"L": 0, "R": 1, "M": 2, None: SIDE_ANY}

    def cells(types, want_side):
        # `Brain.cells` is np.isin(cell_type, types) with an optional side filter; this
        # must agree with it exactly or the panel marks neurons the decoder never reads.
        m = np.isin(ctype, list(types))
        if want_side is not None:
            m &= side == want_side
        return np.flatnonzero(m).astype(np.uint32)

    if mapping is not None:
        aim = mapping.get("aim", {})
        for s_ in ("L", "R"):
            groups.append((f"aim_{s_}", ROLE_READOUT, 1, side_code_any[s_],
                           cells(aim.get("types", []), s_)))
        # `fire.enabled` is a real supported configuration -- `Mapping.load` accepts it
        # and `decoder` refuses to act on the channel when it is false. Hardcoding 1 here
        # would draw a disabled FIRE at full opacity with a live readout, which is the
        # exact condition the readout treatment exists to prevent. (`aim` is different:
        # `Mapping.load` rejects `enabled` on it outright, so 1 is correct there.)
        fire = mapping.get("fire", {})
        groups.append(("fire", ROLE_READOUT, int(bool(fire.get("enabled", True))),
                       SIDE_ANY, cells(fire.get("types", []), None)))
        weapon = mapping.get("weapon", {})
        groups.append(("weapon", ROLE_READOUT, int(bool(weapon.get("enabled", True))),
                       SIDE_ANY, cells(weapon.get("types", []), None)))
        for site in mapping.get("sites", []):
            if not site.get("prosthesis"):
                continue
            groups.append((site["name"], ROLE_PROSTHESIS, int(bool(site.get("enabled", True))),
                           side_code_any.get(site.get("side"), SIDE_ANY),
                           cells(site.get("types", []), site.get("side"))))

    group_names = [g[0] for g in groups]
    mark_idx = np.concatenate([g[4] for g in groups]) if groups else np.zeros(0, np.uint32)
    grp_off = np.zeros(len(groups), dtype=np.uint32)
    grp_count = np.zeros(len(groups), dtype=np.uint32)
    cursor = 0
    for gi, g in enumerate(groups):
        grp_off[gi] = cursor
        grp_count[gi] = len(g[4])
        cursor += len(g[4])
    grp_name = np.arange(len(groups), dtype=np.uint16)
    grp_role = np.array([g[1] for g in groups], dtype=np.uint8)
    grp_enabled = np.array([g[2] for g in groups], dtype=np.uint8)
    grp_side = np.array([g[3] for g in groups], dtype=np.uint8)

    names = b"".join(s.encode() + b"\0" for s in classes + dn_types + group_names)

    out = bytearray()
    out += struct.pack("<6sH", MAGIC, VERSION)
    out += struct.pack("<9I", n, len(classes), len(dn_slot), len(dn_types),
                       len(segments), dn_cols, len(names), len(mark_idx), len(groups))
    out += aspect.astype("<f4").tobytes()
    out += pane_um.astype("<f4").tobytes()
    out += b"\0" * (HEADER_BYTES - len(out))
    assert len(out) == HEADER_BYTES, len(out)

    for arr in (uv.astype("<u2"), dn_slot.astype("<u4"), seg_count.astype("<u4"),
                seg_u0.astype("<f4"), seg_u1.astype("<f4"),
                mark_idx.astype("<u4"), grp_off, grp_count,
                dn_type.astype("<u2"), dn_col.astype("<u2"), grp_name,
                pane, super_idx, dn_side, seg_super, grp_role, grp_enabled, grp_side):
        out += arr.tobytes()
        _align4(out)
    out += names

    stats = {
        "n": n, "placed": int(placed.sum()),
        "brain": int((pane == PANE_BRAIN).sum()), "vnc": int((pane == PANE_VNC).sum()),
        "none": int((pane == PANE_NONE).sum()),
        "aspect": aspect.tolist(), "pane_um": pane_um.tolist(),
        "dn": len(dn_slot), "dn_types": len(dn_types), "dn_cols": dn_cols,
        "segments": [(classes[s] if s != SEG_OTHER else "other", int(k))
                     for s, k in zip(seg_super, seg_count)],
        "bytes": len(out),
        "groups": [(g[0], "readout" if g[1] == ROLE_READOUT else "prosthesis",
                    "on" if g[2] else "OFF", int(len(g[4]))) for g in groups],
    }
    return bytes(out), stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-o", "--out", default="assets/viz-layout.bin", type=Path)
    ap.add_argument("--npz", default="data/brain.npz", type=Path)
    ap.add_argument("--mapping", default="src/brain/mappings/missile_attack.json", type=Path)
    a = ap.parse_args()
    blob, s = build(a.npz, a.mapping)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_bytes(blob)
    print(f"{a.out}: {s['bytes']:,} bytes  v{VERSION}")
    print(f"  n={s['n']:,}  placed={s['placed']:,}  "
          f"brain={s['brain']:,}  vnc={s['vnc']:,}  no-position={s['none']:,}")
    print(f"  pane aspect  brain {s['aspect'][0]:.3f}  vnc {s['aspect'][1]:.3f}")
    print(f"  pane width   brain {s['pane_um'][0]:.0f} um  vnc {s['pane_um'][1]:.0f} um")
    print(f"  dn={s['dn']:,} over {s['dn_types']} types in {s['dn_cols']} shared columns")
    print(f"  strip segments: {', '.join(f'{c} {k:,}' for c, k in s['segments'])}")
    for nm, role, en, k in s["groups"]:
        print(f"  {role:<10} {nm:<14} {en:<3} {k:>3} neurons")


if __name__ == "__main__":
    main()
