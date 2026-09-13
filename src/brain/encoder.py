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
* **looming** (AC2) — LC4+LPLC2, from time-to-contact. This *is* what drives the fire
  channel: 0.30 into LC4+LPLC2-L takes DNp01-L to 17.6 Hz against 0.12 Hz contra. It is
  also the only azimuth-bearing channel that reaches the descending layer at all, and it
  used to be delivered as **two scalars** — `loom_L`/`loom_R`, each injected identically
  into every LC4/LPLC2 on one side — which destroyed azimuth at the point of injection,
  before the brain saw it (#40). It is now one `azimuth_code` site: a per-column looming
  profile delivered to each LC4/LPLC2 at the azimuth column its own `code` map gives it.
  `looming_L`/`looming_R` remain in the config, disabled, as the A/B control.
  The two cues must come from **one** site: a scalar site run alongside a coded one
  drives every cell on a side with a common-mode signal that swamps the spatial pattern
  (measured, #40 §5.1). Hence the side constraint inside the code map rather than two
  sites.
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
    unassigned: int                              # site cells with no azimuth column
    prosthetic_sites: list[str]
    coded_sites: list[str]                       # sites whose azimuth basis is ours, not
                                                 # the fly's: see `CODE_MAPS`
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


def _azimuth_code(c: SignalCtx) -> np.ndarray:
    """Per-column looming strength: each threat a Gaussian bump at its own azimuth column.

    The 1-D analogue of `_luminance`, and its complement: luminance is what the retina
    sees and the retina reaches no descending neuron (§2.2), while this is delivered to
    LC4/LPLC2, which do. Shares `retina.spread_cols` because it is the same angular blur
    of the same object, and a second knob for it would be a knob nothing measured.
    """
    m = c.mapping
    if len(c.ex) == 0:
        return np.zeros(m.columns, dtype=np.float32)
    spread = float(m.retina["spread_cols"])
    d = np.arange(m.columns)[None, :] - column(c.ex, m.columns)[:, None]
    prof = (c.loom[:, None] * np.exp(-(d ** 2) / (2.0 * spread ** 2))).sum(axis=0)
    return np.clip(prof, 0.0, 1.0).astype(np.float32)


SIGNALS: dict[str, Callable[[SignalCtx], float | np.ndarray]] = {
    "luminance": _lum,
    "azimuth_code": _azimuth_code,
    "loom_L": lambda c: _loom_side(c, "L"),
    "loom_R": lambda c: _loom_side(c, "R"),
    "drive": lambda c: c.drive,
    "aim_err_L": lambda c: _aim_err(c, -1.0),
    "aim_err_R": lambda c: _aim_err(c, +1.0),
    "zero": lambda c: 0.0,
}
"""Signal name (from config) → value. A second game adds entries here and a JSON file;
`Encoder`, `Decoder`, `Mapping` and every neuron name change by zero lines (§7)."""

VECTOR_SIGNALS = frozenset({"luminance", "azimuth_code"})
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
    return _hex_vote(sparse.csc_matrix(W), meta, columns, hex_flip, types)


def looming_columns(W: sparse.spmatrix, meta: BrainMeta, columns: int,
                    hex_flip: dict[str, bool], types: Sequence[str]) -> np.ndarray:
    """Azimuth column per neuron by the vote over **presynaptic** partners; -1 unassigned.

    The same vote as `photoreceptor_columns` over the other axis of `W`, and the axis is
    the whole point. `W` is `[post, pre]`, so a CSC column holds a cell's targets and a
    CSR row holds its sources. A photoreceptor's targets carry hex and a projection
    neuron's do not — LC4/LPLC2 target hexless central-brain cells — so the postsynaptic
    vote leaves most of them unassigned while the presynaptic vote, over their
    hex-carrying medulla inputs, assigns every one (measured, #40).

    What this establishes is an **ordering** of those cells along azimuth and not a
    calibrated retinotopy: the vote leans on a small share of each cell's input weight
    and its correlation with soma X is weak and wrong-signed on the right eye.
    `_sided_deal` consumes the order and discards the absolute value for that reason.
    Validated where it can be — run on cells that *do* carry hex, it recovers their own
    value (#40).
    """
    return _hex_vote(sparse.csr_matrix(W), meta, columns, hex_flip, types)


def _hex_vote(W: sparse.spmatrix, meta: BrainMeta, columns: int, hex_flip: dict[str, bool],
              types: Sequence[str]) -> np.ndarray:
    """The |w|-weighted modal hex vote over whichever axis `W`'s format stores."""
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


CodeMap = tuple[np.ndarray, list[tuple[np.ndarray, int, int]]]
"""What a code map returns: the azimuth column per cell (-1 where unassigned), and the
drive groups `_drive_matched` normalises over — (cell mask, column lo, column hi)."""


def _sided_deal(base: np.ndarray, sides: np.ndarray, columns: int) -> CodeMap:
    """Rank each side's cells by `base` and deal them across that side's half of azimuth.

    Two things the shipped scalar sites did separately, in one map. **Side** is preserved
    exactly as `looming_L`/`looming_R` preserved it — a left cell can only be given a
    left column — which is what lets one site carry both cues, and it has to be one site
    (see the module docstring). **Position within the side** is the cells' order under
    `base` and nothing else: the deal is uniform, so the absolute value of `base` is
    discarded and only its ordering survives. That is the claim the measurement supports
    for the anatomical map (#40), and making the code incapable of using more is what
    keeps the claim and the implementation the same statement.

    Cells whose side is neither L nor R, and cells `base` left unassigned, stay -1 and
    are reported as `EncodedFrame.unassigned` rather than dropped silently.

    Returns the column per cell and the **drive groups** — each side's cells with the
    span of azimuth they were dealt across. `_drive_matched` needs the span and not just
    the cells: a side's drive is set by the strongest threat *in that hemifield*, which
    is what the scalar site it replaces measured, and reading it off the cells' own
    columns instead would make total drive sag whenever no cell happened to sit at the
    threat's column.
    """
    half = columns // 2
    out = np.full(len(base), -1, dtype=np.int16)
    groups = []
    for side, lo, hi in (("L", 0, half), ("R", half, columns)):
        sel = np.flatnonzero((sides == side) & (base >= 0))
        if sel.size:
            order = sel[np.argsort(base[sel], kind="stable")]
            out[order] = lo + np.arange(order.size) * half // order.size
        groups.append((sides == side, lo, hi))
    return out, groups


def _code_sided_anat(brain: FlyBrain, site: Any, idx: np.ndarray, columns: int,
                     hex_flip: dict[str, bool], seed: int | None) -> CodeMap:
    """The connectome's own ordering of the site's cells along azimuth, side-constrained."""
    base = looming_columns(brain.W, brain.meta, columns, hex_flip, site.types)[idx]
    return _sided_deal(base.astype(np.int64), brain.meta.side[idx], columns)


def _code_sided_random(brain: FlyBrain, site: Any, idx: np.ndarray, columns: int,
                       hex_flip: dict[str, bool], seed: int | None) -> CodeMap:
    """The control: the same cells, the same side constraint, the **order** shuffled.

    Not decoration and not dead code. The anatomical map's claim is comparative — that
    the connectome's ordering of these cells along azimuth carries more than an arbitrary
    ordering of the same cells at the same drive — and it is only checkable while this
    arm is runnable (#40 R-new). A recommendation that cannot be re-measured is an
    assertion.

    A permutation and not a random column per cell: both arms then deal the same uniform
    set of columns and differ in *ordering alone*, which is the thing being claimed. The
    probe that measured R-new draws random columns instead, so its control also perturbs
    the column histogram — a looser control, and the one the published ratio was measured
    against.
    """
    rng = np.random.default_rng(seed)
    sides = brain.meta.side[idx]
    return _sided_deal(rng.permutation(len(idx)).astype(np.int64), sides, columns)


CODE_MAPS: dict[str, tuple[Callable[..., CodeMap], bool]] = {
    "azimuth_sided_anat": (_code_sided_anat, False),
    "azimuth_sided_random": (_code_sided_random, True),
}
"""`Site.code` name → (builder, whether it needs a `code_seed`).

A site's own azimuth column per neuron, replacing the photoreceptor vector signals' shared
`photoreceptor_columns` map. Per-site and not global because the two maps vote over
opposite axes of `W` and neither is correct for the other's cells."""


def _drive_matched(gain: float, shape: np.ndarray, vec: np.ndarray,
                   groups: list[tuple[np.ndarray, int, int]]) -> np.ndarray:
    """Spread a coded site's current over its cells without changing how much there is.

    A scalar site injects `gain * v` into each of a side's `n` cells, so its total is
    `gain * v * n`. A coded site injects the same total, distributed in proportion to
    `shape` — the two differ only in *where* the current goes, which is the comparison
    every measurement behind this encoder was run under. The normaliser depends on the
    shape alone, so looming strength still modulates total drive.

    Per side, not globally, because that is what the site replaces: one side's cells see
    only their own side's threat, exactly as `looming_L` saw only `loom_L`.

    This is not a refinement. Without it a Gaussian bump delivers roughly a tenth of the
    shipped current, the descending readouts fall to a few tenths of a hertz, and the
    whole channel reads as a clean negative result when in fact nothing is driving the
    brain — which is what happened to the probe this encoder came from (#40).
    """
    out = np.zeros(len(shape), dtype=np.float64)
    for g, lo, hi in groups:
        w = shape[g]
        total = float(w.sum())
        if total > 0.0:
            out[g] = gain * float(vec[lo:hi].max()) * g.size * w / total
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
                                        and s.code is None for t in s.types))
        cols = (photoreceptor_columns(brain.W, brain.meta, m.columns, m.hex_flip, vec_types)
                if vec_types else None)

        self._sites: list[tuple[Any, np.ndarray, np.ndarray | None, list | None]] = []
        for site in enabled:
            idx = brain.cells(list(site.types), side=site.side)
            groups = None
            if site.code is not None:
                site_cols, raw = CODE_MAPS[site.code][0](brain, site, idx, m.columns,
                                                         m.hex_flip, site.code_seed)
                keep = site_cols >= 0
                groups = [(np.flatnonzero(g[keep]), lo, hi) for g, lo, hi in raw]
                groups = [g for g in groups if g[0].size]
            elif site.signal in VECTOR_SIGNALS:
                site_cols = cols[idx]
            else:
                site_cols = None
            self._sites.append((site, idx, site_cols, groups))
        self.prosthetic_sites = [s.name for s in enabled if s.prosthesis]
        self.coded_sites = [s.name for s in enabled if s.code is not None]

    # ---------------------------------------------------------------- encoding

    def encode(self, state: dict, crosshair_x: float = 0.5) -> EncodedFrame:
        """One level-held injection vector plus telemetry. Never raises on state content."""
        ctx = self._context(state, crosshair_x)
        m = self.mapping
        inject, unassigned = [], 0

        for site, idx, cols, groups in self._sites:
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
                shape = vec[cols[assigned]]
                amounts = (_drive_matched(gain, shape, vec, groups) if groups is not None
                           else gain * shape).astype(np.float32)
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
            prosthetic_sites=list(self.prosthetic_sites),
            coded_sites=list(self.coded_sites), rejected=int(rejected),
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
