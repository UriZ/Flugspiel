"""GameState → voltage injections into named neuron populations — #3 §3.3, §4.

Four channels, all of them config-driven (`src/brain/mappings/missile_attack.json`):

* **retina** (AC1) — a 1D panoramic *luminance* map over `columns` azimuth columns, fed
  to the 6,006 photoreceptors via the modal-hex azimuth assignment in
  `photoreceptor_columns`. Photoreceptors are 100% histamine, i.e. `nt_sign = -1` already
  baked into `W`, so the encoder injects **brightness** and never a sign: a missile is a
  *dark* patch that removes drive, which disinhibits the targets. The intuitive mapping is
  backwards here and this is the only place it matters.
  Measured (§2.2): photoreceptor drive does **not** reach any descending neuron — injecting
  +2.0 into all 6,006 leaves every DN readout unchanged. The channel is built because it is
  the correct sensory representation and #6/#7 need it, not because it moves the decoder.
* **looming** (AC2) — LC4+LPLC2 per side, from time-to-contact. This *is* what drives the
  fire channel: 0.30 into LC4+LPLC2-L takes DNp01-L to 17.6 Hz against 0.12 Hz contra.
* **drive** (AC3) — the peptidergic pool, from aggregate base health. Measured (§2.5):
  driving those 59 neurons at +3.0 moves global firing by 0.018 percentage points and no DN
  readout at all. The literal injection is kept (AC3, and #6 draws it); its measurable path
  is `gain_mod: "drive"`, which scales the looming sites' gain.
* **aim_bias** (§2.3) — PFL3, a heading error. Flagged `prosthesis: true` in config and
  echoed in `EncodedFrame.prosthetic_sites`: DNa02 receives 0.000 of its input from
  LC4/LPLC2 and is drivable only from a premotor site, so aiming is not the fly's visual
  system solving the task. #7 must disclose this in any learning claim.

Injection is **level-held**: one `encode()` per GameState, the same vector applied on every
`brain.step(inject=frame.inject)` until the next state arrives. The measured operating
points are per-step amounts — do not divide by the repeat count.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, Sequence

import numpy as np
from scipy import sparse

from .connectome import PHOTORECEPTOR_TYPES, BrainMeta
from .lif import FlyBrain
from .mapping import Mapping, MappingError, column, loom

NEUTRAL_STATE: dict = {
    "seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1, "weapon": 0,
    "base": {"x": 0.5, "health": 1.0, "launchers_alive": 0},
    "launchers": [], "missiles": [], "interceptors": [],
}
"""An empty sky at full health — what `Decoder.calibrate()` holds the brain at."""


@dataclass(frozen=True)
class EncodedFrame:
    """One encoded GameState. `.inject` goes to `FlyBrain.step`; the rest is telemetry."""

    inject: list[tuple[np.ndarray, np.ndarray]]  # (int64 indices, float32 amounts) per site
    luminance: np.ndarray                        # float32 (columns,), 1.0 = empty sky
    loom: dict[str, float]
    drive: float
    launcher_hp: list[float]                     # per-launcher, for #6/#7 spatial damage
    launcher_x: list[float]
    unassigned: int                              # photoreceptors with no azimuth column
    prosthetic_sites: list[str]
    rejected: int                                # wire values the encoder could not use


@dataclass(frozen=True)
class SignalCtx:
    """Everything a signal function may read: the state, the config, and derived arrays.

    The per-enemy arrays and `luminance` are computed once per `encode()` — `loom_L`,
    `loom_R` and both `aim_err` signals would otherwise each re-derive them.
    """

    state: dict
    mapping: Mapping
    crosshair_x: float
    ex: np.ndarray        # enemy x, normalised, NOT clamped (the game does not clamp)
    ey: np.ndarray
    loom: np.ndarray      # per-enemy looming strength in [0, 1]
    luminance: np.ndarray
    drive: float
    rejected: int


def _lum(c: SignalCtx) -> np.ndarray:
    return c.luminance


def _loom_side(c: SignalCtx, side: str) -> float:
    if len(c.ex) == 0:
        return 0.0
    cols = column(c.ex, c.mapping.columns)
    on_left = cols < c.mapping.columns / 2
    want_left = (side == "L") != bool(c.mapping.loom.get("side_flip", False))
    sel = on_left if want_left else ~on_left
    return float(np.clip(c.loom[sel].sum(), 0.0, 1.0))


def _aim_err(c: SignalCtx, sign: float) -> float:
    """Heading error, split across the two PFL3 sides so both signals stay in [0, 1].

    PFL3 -> DNa02 is contralateral (measured), so a target to the right raises `aim_err_R`,
    which raises DNa02-**L**, which the decoder maps to +x. The loop closes negatively.
    """
    if len(c.ex) == 0:
        err = 0.0
    else:
        err = float(np.clip(c.ex[int(np.argmax(c.loom))] - c.crosshair_x, -1.0, 1.0))
    return (1.0 + sign * err) / 2.0


SIGNALS: dict[str, Callable[[SignalCtx], float | np.ndarray]] = {
    "luminance": _lum,
    "loom_L": lambda c: _loom_side(c, "L"),
    "loom_R": lambda c: _loom_side(c, "R"),
    "drive": lambda c: c.drive,
    "aim_err_L": lambda c: _aim_err(c, -1.0),
    "aim_err_R": lambda c: _aim_err(c, +1.0),
    "zero": lambda c: 0.0,
}
"""Signal name (from config) → value. A second game adds entries here and a JSON file;
`Encoder`, `Decoder`, `Mapping` and every neuron name change by zero lines (§7)."""

VECTOR_SIGNALS = frozenset({"luminance"})
"""Signals returning one value per azimuth column rather than a scalar."""


def photoreceptor_columns(W: sparse.spmatrix, meta: BrainMeta, columns: int,
                          hex_flip: dict[str, bool],
                          types: Sequence[str] = PHOTORECEPTOR_TYPES) -> np.ndarray:
    """Azimuth column per neuron; -1 where unassigned. int16 (n,).

    Photoreceptors carry no `ol_hex` of their own, so azimuth is the |w|-weighted modal
    `assignedOlHex1` of their hex-carrying postsynaptic partners. Measured on the real
    brain: 5,861 / 6,006 assigned, voter spread 0.00-0.05 columns — the vote is very nearly
    unanimous, which is why the optic-column xlsx is not needed. hex1 is the left-right
    axis (corr with soma X = +0.487 on L, -0.558 on R); hex2 is dorsoventral.

    The hex domain is **measured from the brain and rescaled onto `[0, columns-1]`**, not
    assumed to equal it. `h - 1` and `columns - h` land correctly only when the hex range
    happens to be `1..columns`, which is true of this connectome at `columns = 36` and of
    nothing else — at 18 half of each retina welded onto one edge pixel and at 72 the two
    eyes tiled disjoint halves of a screen they should each span, silently (#28). The
    rescale is exact at the shipped value: with hexes `1..36` and `columns = 36` it
    reproduces both old branches neuron for neuron.

    Costs ~0.08 s on the real connectome. Called once per `Encoder`, never per frame.
    """
    W = sparse.csc_matrix(W)
    hex1 = meta.ol_hex[:, 0]
    known = np.isfinite(hex1)
    binned = np.where(known, hex1, 0.0).astype(np.int64)
    nbins = int(binned.max()) + 1 if known.any() else 1
    lo_hex = int(binned[known].min()) if known.any() else 0
    span = (int(binned[known].max()) - lo_hex) if known.any() else 0

    out = np.full(meta.n, -1, dtype=np.int16)
    for j in np.flatnonzero(np.isin(meta.cell_type, list(types))):
        lo, hi = W.indptr[j], W.indptr[j + 1]
        targets, weights = W.indices[lo:hi], np.abs(W.data[lo:hi])
        ok = known[targets]
        if not ok.any():
            continue  # no hex-carrying partner: reported as EncodedFrame.unassigned
        h = int(np.argmax(np.bincount(binned[targets[ok]], weights=weights[ok], minlength=nbins)))
        c = round((h - lo_hex) / span * (columns - 1)) if span else 0
        if hex_flip.get(str(meta.side[j]), False):
            c = columns - 1 - c
        out[j] = min(max(c, 0), columns - 1)
    return out


def _finite(value: Any) -> tuple[float, bool]:
    """Coerce a wire number, reporting whether it was usable. Non-finite becomes 0.0."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0, False
    return (v, True) if math.isfinite(v) else (0.0, False)


def _list(value: Any) -> tuple[Sequence, int]:
    """A wire array, plus 1 if the key was present but held something else (#26).

    A scalar where a list belongs is a client bug, not an attack, but iterating it raises
    and `encode()` promises it never does. Absent/null is not counted: it is the normal
    way to say "none", and #4 relies on `rejected` meaning "the client sent nonsense".
    """
    if isinstance(value, (list, tuple)):
        return value, 0
    return (), int(value is not None)


def _obj(value: Any) -> tuple[dict, int]:
    """A wire object, plus 1 if the key was present but held something else (#26)."""
    if isinstance(value, dict):
        return value, 0
    return {}, int(value is not None)


class Encoder:
    """GameState → `EncodedFrame`. Holds no clock and no step counter (#4 schedules it)."""

    def __init__(self, brain: FlyBrain, mapping: Mapping | None = None) -> None:
        self.brain = brain
        self.mapping = mapping or Mapping.default()
        m = self.mapping

        # Eager, so a config naming a type this brain does not have fails at construction
        # rather than on the first frame. Disabled sites are checked too: a typo in one
        # should not lie dormant until somebody enables it.
        present = set(brain.meta.cell_type.tolist())
        for site in m.sites:
            missing = sorted(t for t in site.types if t not in present)
            if missing:
                raise MappingError(f"site {site.name!r}: cell types {missing} are absent from "
                                   f"this brain's {len(present)} annotated types")

        enabled = [s for s in m.sites if s.enabled]
        vec_types = tuple(dict.fromkeys(t for s in enabled if s.signal in VECTOR_SIGNALS
                                        for t in s.types))
        cols = (photoreceptor_columns(brain.W, brain.meta, m.columns, m.hex_flip, vec_types)
                if vec_types else None)

        self._sites: list[tuple[Any, np.ndarray, np.ndarray | None]] = []
        for site in enabled:
            idx = brain.cells(list(site.types), side=site.side)
            self._sites.append((site, idx, cols[idx] if site.signal in VECTOR_SIGNALS else None))
        self.prosthetic_sites = [s.name for s in enabled if s.prosthesis]

    # ---------------------------------------------------------------- encoding

    def encode(self, state: dict, crosshair_x: float = 0.5) -> EncodedFrame:
        """One level-held injection vector plus telemetry. Never raises on state content."""
        ctx = self._context(state, crosshair_x)
        m = self.mapping
        inject, unassigned = [], 0

        for site, idx, cols in self._sites:
            gain = site.gain
            if site.gain_mod == "drive":
                gain *= 1.0 + m.drive_mod_k * ctx.drive
            if cols is None:
                sub, amounts = idx, np.full(len(idx), gain * float(SIGNALS[site.signal](ctx)),
                                            dtype=np.float32)
            else:
                vec = np.asarray(SIGNALS[site.signal](ctx), dtype=np.float32)
                assigned = cols >= 0
                unassigned += int((~assigned).sum())
                sub = idx[assigned]
                amounts = (gain * vec[cols[assigned]]).astype(np.float32)
            # #13: one NaN in v silently removes a neuron for the rest of the session, so
            # no site is exempt from this, however trustworthy its signal looks.
            amounts = np.nan_to_num(amounts, nan=0.0, posinf=0.0, neginf=0.0)
            np.clip(amounts, 0.0, m.max_inject, out=amounts)
            inject.append((sub, amounts))

        launchers, bad = _list(ctx.state.get("launchers"))
        hp, lx, rejected = [], [], ctx.rejected + bad
        for l in launchers:
            if not isinstance(l, dict):
                rejected += 1
                continue
            v, ok = _finite(l.get("hp"))
            rejected += not ok
            hp.append(v)
            v, ok = _finite(l.get("x"))
            rejected += not ok
            lx.append(v)

        return EncodedFrame(
            inject=inject, luminance=ctx.luminance,
            loom={"L": _loom_side(ctx, "L"), "R": _loom_side(ctx, "R")}, drive=ctx.drive,
            launcher_hp=hp, launcher_x=lx, unassigned=unassigned,
            prosthetic_sites=list(self.prosthetic_sites), rejected=int(rejected),
        )

    def neutral(self) -> EncodedFrame:
        """Empty sky, full health, zero aim error. Used by `Decoder.calibrate()`."""
        return self.encode(NEUTRAL_STATE, 0.5)

    # ---------------------------------------------------------------- internals

    def _context(self, state: dict, crosshair_x: float) -> SignalCtx:
        m = self.mapping
        state, rejected = _obj(state)
        missiles, bad = _list(state.get("missiles"))
        rejected += bad
        xs, ys, vys = [], [], []
        for e in missiles:
            if not isinstance(e, dict):
                rejected += 1
                continue
            row, ok = zip(*(_finite(e.get(k)) for k in ("x", "y", "vx", "vy")))
            rejected += ok.count(False)
            xs.append(row[0])
            ys.append(row[1])
            vys.append(row[3])

        ex = np.asarray(xs, dtype=np.float64)
        ey = np.asarray(ys, dtype=np.float64)
        evy = np.asarray(vys, dtype=np.float64)

        base, bad = _obj(state.get("base"))
        rejected += bad
        health, ok = _finite(base.get("health"))
        rejected += not ok
        cx, ok = _finite(crosshair_x)
        rejected += not ok

        return SignalCtx(
            state=state, mapping=m, crosshair_x=cx, ex=ex, ey=ey,
            loom=loom(ey, evy, m.loom), luminance=self._luminance(ex, ey),
            drive=float(np.clip(1.0 - health, 0.0, 1.0)), rejected=int(rejected),
        )

    def _luminance(self, ex: np.ndarray, ey: np.ndarray) -> np.ndarray:
        """1.0 everywhere is an empty bright sky; each enemy casts a Gaussian shadow."""
        m = self.mapping
        if len(ex) == 0:
            return np.ones(m.columns, dtype=np.float32)
        spread = float(m.retina["spread_cols"])
        d = np.arange(m.columns)[None, :] - column(ex, m.columns)[:, None]
        w = np.clip(ey, 0.0, 1.0)  # lower on screen = closer to the launchers = darker
        shadow = (w[:, None] * np.exp(-(d ** 2) / (2.0 * spread ** 2))).sum(axis=0)
        return np.clip(1.0 - shadow, 0.0, 1.0).astype(np.float32)
