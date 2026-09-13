"""Dopamine reward/punishment → KC→MBON plasticity — #7 §4, §5.

The one place `architecture.md`'s frozen-reservoir principle is deliberately broken, and
the break is fenced: only KC→MBON edges **inside a configured compartment** are ever
written, and the loop holds index arrays for exactly those positions, so "no global weight
training" is enforced by construction rather than by discipline.

Three factors, per #7 §5:

* **when** — a `RewardEvent` derived only from `launchers_alive` and `session` (§4).
  `base.health` is forbidden: it rises during inter-wave recovery, so keying on it would
  pay the fly for waiting. `phase` gates whether the loop runs and contributes nothing to
  sign or magnitude, because the start screen has no launchers and a running timer would
  pay out on the menu. Any *rise* in `launchers_alive` without a session change is a
  monotonicity violation — a missed boundary — and is discarded, never read as reward.
* **which synapses** — an eligibility trace over presynaptic KCs (§5.4). **Under #1's
  current parameterisation every KC fires on every step, so the trace saturates and this
  rule degenerates to one scalar per compartment.** That is a property of the brain, not
  of this module; it is measured and recorded on #7 (§3.2, risk R6) and belongs to #1.
  The trace is implemented in full because it is the mechanism the issue asks for and
  because it stops being degenerate the moment KC sparseness is restored. It does not
  discriminate between synapses today.
* **how much** — the *commanded* event magnitude, never a measured DAN spike rate. Both
  DAN populations sit at their firing ceiling with the loop off and the socket closed
  (#7 §3.2), so a rule reading their rate reads a constant. The DAN injection is still
  applied — it is the biologically correct site and #6 draws it — but it is inert on rate
  and no criterion here claims otherwise.

**What this module does not do.** Weight change is not learning. The mushroom body's
output does not reach the game's readout neurons on this connectome (#7 §3.4), so nothing
here may be described as learning, training, progress or improvement in any artefact.
`telemetry()` therefore carries `prosthetic_sites` in the *same object* as `value`: a
reward number that outlives its connection in a log or a screenshot still travels with its
disclosure. See #7 §8, §9.3.

`enabled = false` is the control condition for every claim made against this loop, not a
convenience flag: nothing is injected, no weight is written, and the spike train is
identical to a run with no `RewardLoop` at all (§7).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

import numpy as np

from .lif import FlyBrain
from .mapping import DEFAULT_MAPPING_PATH

if TYPE_CHECKING:  # the reward loop must not import the encoder at runtime
    from .encoder import Encoder

REWARD, PUNISH, NONE = "reward", "punish", "none"
VALENCES = (REWARD, PUNISH)

KC_PREFIX = "KC"
"""Presynaptic population, matched by cell-type prefix. Every KC type in MaleCNS is named
`KC…` and all of them are cholinergic, so the whole KC→MBON block is strictly positive and
`w_min > 0` keeps every edge from ever changing sign."""

CFG_KEYS = ("enabled", "t_survive", "k_event", "lr", "tau_elig", "tau_decay",
            "w_min", "w_max", "dan_inject", "dan_hold", "compartments")
COMPARTMENT_KEYS = ("name", "dan_types", "mbon_types", "sign")

MAX_DT = 1.0
"""Longest wire-clock gap the baseline decay will honour, in seconds. A stall must not
discharge the whole trace in one tick."""


class RewardError(ValueError):
    """A reward config that cannot be trusted to run. Raised at construction only."""


@dataclass(frozen=True)
class Compartment:
    """The MBONs one DAN population innervates, and the valence it answers to."""

    name: str                    # "reward" | "punish"
    dan_types: tuple[str, ...]
    mbon_types: tuple[str, ...]
    sign: float                  # +1 potentiate, -1 depress — see #7 §5.3


@dataclass(frozen=True)
class RewardConfig:
    """Every constant the loop uses. Lives in the mapping JSON, not in Python.

    `sign` is an **engineered valence assignment** matching #7's AC6 (reward strengthens,
    punishment weakens), not the biology: the reference implementation's anti-Hebbian rule
    depresses in *both* compartments and gets behavioural valence from which compartment
    is depressed. One config field, so the alternative is an edit and not a rewrite.
    """

    enabled: bool
    t_survive: float
    k_event: float
    lr: float
    tau_elig: float
    tau_decay: float
    w_min: float
    w_max: float
    dan_inject: float
    dan_hold: float
    compartments: tuple[Compartment, ...]

    @classmethod
    def load(cls, source: str | Path | dict = DEFAULT_MAPPING_PATH) -> "RewardConfig":
        """Parse the `"reward"` block of a mapping JSON, a path to one, or the block itself."""
        if isinstance(source, dict):
            raw = source
        else:
            path = Path(source)
            if not path.exists():
                raise RewardError(f"{path} not found")
            try:
                raw = json.loads(path.read_text())
            except json.JSONDecodeError as exc:
                raise RewardError(f"{path} is not valid JSON ({exc})") from exc
        if "reward" in raw:
            raw = raw["reward"]
        return cls._build(raw)

    @classmethod
    def default(cls) -> "RewardConfig":
        return cls.load(DEFAULT_MAPPING_PATH)

    @classmethod
    def _build(cls, raw: Any) -> "RewardConfig":
        if not isinstance(raw, dict):
            raise RewardError(f"reward config must be an object, got {raw!r}")
        _only(raw, CFG_KEYS, "reward")
        parts, seen = [], set()
        for entry in raw.get("compartments", ()):
            part = _compartment(entry)
            if part.name in seen:
                raise RewardError(f"duplicate compartment {part.name!r}")
            seen.add(part.name)
            parts.append(part)
        if not parts:
            raise RewardError("reward config has no compartments")

        w_min = _num(raw, "w_min", "reward", low=1e-9)
        w_max = _num(raw, "w_max", "reward")
        if not w_min < 1.0 < w_max:
            # Bounds that do not bracket the baseline pin every weight away from it, so
            # the trace could never return to the connectome it started from.
            raise RewardError(f"reward: need 0 < w_min < 1 < w_max, got {w_min} and {w_max}")
        return cls(
            enabled=bool(raw.get("enabled", True)),
            t_survive=_num(raw, "t_survive", "reward", low=1e-9),
            k_event=_num(raw, "k_event", "reward", low=1e-9),
            lr=_num(raw, "lr", "reward", low=1e-9),
            tau_elig=_num(raw, "tau_elig", "reward", low=1e-9),
            tau_decay=_num(raw, "tau_decay", "reward", low=1e-9),
            w_min=w_min, w_max=w_max,
            dan_inject=_num(raw, "dan_inject", "reward", low=0.0),
            dan_hold=_num(raw, "dan_hold", "reward", low=0.0),
            compartments=tuple(parts),
        )


@dataclass(frozen=True)
class RewardEvent:
    """`magnitude` is always >= 0; the sign lives in `kind`."""

    kind: str          # REWARD | PUNISH | NONE
    magnitude: float
    t: float


NO_EVENT = RewardEvent(NONE, 0.0, 0.0)


class RewardLoop:
    """Holds no clock and no socket: #4 calls `observe()` once per brain step and
    `on_state()` once per promoted state, in that order relative to `FlyBrain.step`."""

    def __init__(self, brain: FlyBrain, cfg: RewardConfig | None = None, *,
                 encoder: "Encoder | None" = None) -> None:
        self.brain = brain
        self.cfg = cfg or RewardConfig.default()
        # Never re-derived from the mapping: a disclosure that can disagree with the
        # encoder it describes is worse than none (#7 §8). `["unknown"]` and never `[]`,
        # because an empty list reads as "no prosthesis was active".
        self.prosthetic_sites = list(encoder.prosthetic_sites) if encoder is not None \
            else ["unknown"]

        # Eager and loud, mirroring `Encoder`/`Decoder`: `brain.cells()` returns an empty
        # array for a type this brain lacks, so a typo would give a permanently dead loop
        # with no error at all. Checked even when disabled — a typo must not lie dormant
        # until somebody turns the loop on.
        present = set(brain.meta.cell_type.tolist())
        kc = np.flatnonzero(np.char.startswith(brain.meta.cell_type, KC_PREFIX))
        if not kc.size:
            raise RewardError(f"no cell type starting {KC_PREFIX!r} in this brain: there is "
                              f"no mushroom body to modulate")

        self._slot = np.zeros(brain.n, dtype=np.int64)
        self._slot[kc] = np.arange(kc.size)
        self._is_kc = np.zeros(brain.n, dtype=bool)
        self._is_kc[kc] = True
        self._e = np.zeros(kc.size, dtype=np.float32)

        self._parts: list[dict[str, Any]] = []
        for part in self.cfg.compartments:
            missing = sorted(t for t in part.dan_types + part.mbon_types if t not in present)
            if missing:
                raise RewardError(f"compartment {part.name!r}: cell types {missing} are absent "
                                  f"from this brain's {len(present)} annotated types")
            sel, kc_of_edge = _edges(brain.W, kc, brain.cells(list(part.mbon_types)))
            if not sel.size:
                raise RewardError(f"compartment {part.name!r}: no KC->MBON edges onto "
                                  f"{list(part.mbon_types)}; nothing for it to modulate")
            w0 = np.asarray(brain.W.data[sel], dtype=np.float32).copy()
            bounds = np.stack((w0 * self.cfg.w_min, w0 * self.cfg.w_max))
            self._parts.append({
                "cfg": part, "sel": sel, "w0": w0,
                "elig": self._slot[kc_of_edge],
                # Precomputed, and via min/max rather than assuming w0 > 0: a negative
                # baseline would otherwise silently invert the clip and pin the edge.
                "lo": bounds.min(axis=0), "hi": bounds.max(axis=0),
                "dan": brain.cells(list(part.dan_types)),
            })
        self.reset()

    @property
    def enabled(self) -> bool:
        return self.cfg.enabled

    # ---------------------------------------------------------------- per brain step

    def observe(self, fired: np.ndarray) -> None:
        """Once per brain step. `fired` is exactly what `FlyBrain.step()` returned.

        Indexing `fired` and then the slot table costs materially less than masking the
        whole population every step, and this runs in the hot loop (#7 §5.5).
        """
        if not self.cfg.enabled:
            return
        if self._dan_steps:
            self._dan_steps -= 1
            if not self._dan_steps:
                self._dan_level = 0.0
        dt = self.brain.params.dt
        a = 1.0 - math.exp(-dt / self.cfg.tau_elig)
        self._e *= np.float32(1.0 - a)
        self._e[self._slot[fired[self._is_kc[fired]]]] += np.float32(a)

    def inject(self) -> list[tuple[np.ndarray, np.ndarray]]:
        """DAN drive for the compartment that last fired, level-held for `dan_hold`.

        Biologically the right site, and what #6 draws. It is inert on firing rate: both
        DAN populations already fire on every step with the loop off (#7 §3.2, §5.2).
        """
        if not self.cfg.enabled or not self._dan_steps or self._dan_part is None:
            return []
        idx = self._dan_part["dan"]
        return [(idx, np.full(idx.size, self._dan_level, dtype=np.float32))]

    # ---------------------------------------------------------------- per promoted state

    def on_state(self, state: dict, session_changed: bool) -> RewardEvent:
        """Detect one event, decay the weights toward baseline, apply the update.

        Must run *before* the step whose synaptic input it changes (#7 §11.4). The clock
        is the wire's `state["t"]`, never the server's, so a recorded state stream replays
        to an identical event train and an identical weight trajectory.
        """
        if not self.cfg.enabled:
            return NO_EVENT
        if not isinstance(state, dict):
            state = {}  # a malformed frame must not end the session (#26)

        t, ok = _finite(state.get("t"))
        resync = session_changed or self._prev_t is None or not ok or t < self._prev_t
        dt = 0.0 if resync else min(t - self._prev_t, MAX_DT)
        self._decay(dt)

        event = self._detect(state, t, ok, resync)
        if event.kind in VALENCES:
            self._apply(event)
            self._value += event.magnitude * (1.0 if event.kind == REWARD else -1.0)
            self._cumulative += event.magnitude * (1.0 if event.kind == REWARD else -1.0)
            self._events[event.kind] += 1
            self._pending.add(event.kind)
        if ok:
            self._prev_t = t
        return event

    def _detect(self, state: dict, t: float, ok: bool, resync: bool) -> RewardEvent:
        """#7 §4.3, in order. Returns at most one event per promoted state."""
        alive, alive_ok = _count(_obj(state.get("base")).get("launchers_alive"))

        if state.get("phase") != "playing":
            # The start screen has no launchers, so a running timer would pay out for
            # sitting on the menu. A gate only: it never sets a sign or a magnitude.
            self._armed = False
            self._armed_at = t if ok else 0.0
            return NO_EVENT
        if resync or not alive_ok:
            return self._resync(alive if alive_ok else None, t if ok else 0.0, "resyncs")
        if self._prev_alive is None:
            return self._resync(alive, t, "resyncs")

        if alive < self._prev_alive:
            lost = self._prev_alive - alive
            self._prev_alive = alive
            self._armed, self._armed_at = True, t
            return RewardEvent(PUNISH, self.cfg.k_event * lost, t)
        if alive > self._prev_alive:
            # `launchers_alive` is monotonic within a session and dead launchers are never
            # revived, so a rise is a session boundary nobody reported. Discarded, never
            # differenced through, and never read as a spontaneous reward (#7 §4.3 step 5).
            return self._resync(alive, t, "anomalies")
        if self._armed and t - self._armed_at >= self.cfg.t_survive:
            # One-shot: the game can stall with launchers still standing, and a repeating
            # survival reward would then pay out forever (#7 §4.2).
            self._armed = False
            return RewardEvent(REWARD, self.cfg.k_event, t)
        return NO_EVENT

    def _resync(self, alive: int | None, t: float, counter: str) -> RewardEvent:
        self._prev_alive = alive
        self._armed, self._armed_at = False, t
        self._cumulative = 0.0
        self._telemetry[counter] += 1
        return NO_EVENT

    # ---------------------------------------------------------------- weights

    def _decay(self, dt: float) -> None:
        """Every edge relaxes toward its baseline. `w0` is kept separately, so `reset()`
        restores the pristine connectome by assignment and never by waiting for this."""
        if dt <= 0.0:
            return
        a = np.float32(1.0 - math.exp(-dt / self.cfg.tau_decay))
        data = self.brain.W.data
        for part in self._parts:
            sel = part["sel"]
            data[sel] += (part["w0"] - data[sel]) * a

    def _apply(self, event: RewardEvent) -> None:
        """Multiplicative in `w0`: the KC→MBON weights span orders of magnitude, and a
        constant increment would flatten the connectome's structure inside the compartment.

        Each compartment answers only to its own valence — without that the two would be
        perfectly anticorrelated and the compartment structure would be decorative.
        """
        data = self.brain.W.data
        for part in self._parts:
            if part["cfg"].name != event.kind:
                continue
            self._dan_part, self._dan_level = part, self.cfg.dan_inject
            self._dan_steps = max(1, math.ceil(self.cfg.dan_hold / self.brain.params.dt))
            sel = part["sel"]
            delta = (np.float32(self.cfg.lr * part["cfg"].sign * event.magnitude)
                     * self._e[part["elig"]] * part["w0"])
            # In place through `.data`: both LIF kernels read it every step, and rebinding
            # `brain.W` would silently detach the loop from the brain (#7 §6).
            np.clip(data[sel] + delta, part["lo"], part["hi"], out=delta)
            data[sel] = delta

    def efficacy(self) -> dict[str, float]:
        """Mean `w / w0` per compartment — the AC3 evidence. Efficacy, never progress."""
        return {part["cfg"].name:
                float(np.mean(self.brain.W.data[part["sel"]] / part["w0"]))
                for part in self._parts}

    # ---------------------------------------------------------------- telemetry

    def telemetry(self, session_changed: bool) -> dict:
        """One `snapshot.reward` object. Drains `value`, which is the signed sum of the
        events since the last emitted frame — several states can be promoted between two
        frames, and reporting only the last would drop events the weights already took."""
        value, pending = self._value, self._pending
        self._value, self._pending = 0.0, set()
        if not self.cfg.enabled:
            source = "disabled"
        elif len(pending) > 1:
            source = "mixed"
        else:
            source = next(iter(pending), "none")
        return {
            "enabled": self.cfg.enabled,
            "value": float(value),
            "source": source,
            "session_changed": bool(session_changed),
            "cumulative": float(self._cumulative),
            "events": dict(self._events),
            "dopamine": {t: (self._dan_level if part is self._dan_part else 0.0)
                         for part in self._parts for t in part["cfg"].dan_types},
            "compartments": self.efficacy(),
            # In the same object as `value` by design: a logged reward number that can be
            # read without its disclosure is the failure #7 §8 exists to prevent.
            "prosthetic_sites": list(self.prosthetic_sites),
            "resyncs": self._telemetry["resyncs"],
            "anomalies": self._telemetry["anomalies"],
        }

    def reset(self) -> None:
        """Weights back to the pristine connectome by assignment, counters cleared."""
        for part in self._parts:
            self.brain.W.data[part["sel"]] = part["w0"]
        self._e[:] = 0.0
        self._prev_alive: int | None = None
        self._prev_t: float | None = None
        self._armed, self._armed_at = False, 0.0
        self._value, self._cumulative = 0.0, 0.0
        self._pending: set[str] = set()
        self._events = {REWARD: 0, PUNISH: 0}
        self._telemetry = {"resyncs": 0, "anomalies": 0}
        self._dan_part: dict[str, Any] | None = None
        self._dan_level, self._dan_steps = 0.0, 0


# ------------------------------------------------------------------ construction helpers


def _edges(W, kc: np.ndarray, mbon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Positions in `W.data` of the KC→MBON edges onto `mbon`, and each one's source KC.

    `W` is CSC and `W @ spikes` is indexed by the presynaptic neuron, so a column is a
    source and a row is a target. Only the KC columns are walked — expanding all of `W`'s
    column indices would cost more memory than the matrix.
    """
    starts, ends = W.indptr[kc], W.indptr[kc + 1]
    lens = (ends - starts).astype(np.int64)
    pos = _ragged(starts.astype(np.int64), lens)
    src = np.repeat(kc, lens)
    keep = np.isin(W.indices[pos], mbon)
    return pos[keep], src[keep]


def _ragged(starts: np.ndarray, lens: np.ndarray) -> np.ndarray:
    """Concatenation of `range(s, s + l)` over every (s, l), without a Python loop."""
    total = int(lens.sum())
    if not total:
        return np.empty(0, dtype=np.int64)
    offsets = np.cumsum(lens) - lens
    return np.arange(total) - np.repeat(offsets, lens) + np.repeat(starts, lens)


def _compartment(entry: Any) -> Compartment:
    if not isinstance(entry, dict):
        raise RewardError(f"each compartment must be an object, got {entry!r}")
    name = entry.get("name")
    if name not in VALENCES:
        raise RewardError(f"compartment name must be one of {VALENCES}, got {name!r}")
    _only(entry, COMPARTMENT_KEYS, f"compartment {name!r}")
    sign = _num(entry, "sign", f"compartment {name!r}")
    if sign not in (-1.0, 1.0):
        raise RewardError(f"compartment {name!r}: sign must be +1 or -1, got {sign}")
    return Compartment(name=name, sign=sign,
                       dan_types=_types(entry.get("dan_types"), f"compartment {name!r}"),
                       mbon_types=_types(entry.get("mbon_types"), f"compartment {name!r}"))


def _only(d: dict, known: Sequence[str], where: str) -> None:
    """Reject unknown keys: every value is read with a default, so a typo would silently
    select it rather than fail — the same rule `mapping.py` runs under."""
    extra = sorted(k for k in d if k not in known)
    if extra:
        raise RewardError(f"{where}: unknown key(s) {extra}; known keys are {sorted(known)}")


def _num(d: dict, key: str, where: str, *, low: float | None = None) -> float:
    v = d.get(key)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not np.isfinite(v):
        raise RewardError(f"{where}.{key} must be a finite number, got {v!r}")
    if low is not None and v < low:
        raise RewardError(f"{where}.{key} must be >= {low}, got {v}")
    return float(v)


def _types(v: Any, where: str) -> tuple[str, ...]:
    if isinstance(v, str) or not isinstance(v, (list, tuple)) or not v:
        raise RewardError(f"{where}: types must be a non-empty list of names, got {v!r}")
    if not all(isinstance(t, str) and t for t in v):
        raise RewardError(f"{where}: types must contain only non-empty strings, got {v!r}")
    return tuple(v)


# ------------------------------------------------------------------ wire helpers


def _obj(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _finite(value: Any) -> tuple[float, bool]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0, False
    return (v, True) if math.isfinite(v) else (0.0, False)


def _count(value: Any) -> tuple[int, bool]:
    """`launchers_alive` must be a real non-negative count; anything else forces a resync."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0, False
    return value, True
