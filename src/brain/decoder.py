"""Descending-neuron spike trains → one game action per decode tick — #3 §3.5, §4.

Three readout channels, all named in config:

* **aim** — DNa02 laterality. The decoder **integrates**: the de-biased laterality index is
  a *turn rate* on a crosshair the decoder owns, not a screen coordinate. Forced by
  measurement (§2.4): the index saturates by |u| ~ 0.2 and is asymmetric at the rails
  (-1.29 vs +0.66), so a proportional index→x map would be a bang-bang controller.
  Integrating a saturating signal is usable, and it is what DNa02 does in the animal — it
  sets yaw velocity, not heading. The same measurement shows a large constant bias
  (index = +0.365 at a symmetric command, seed-to-seed sd 0.09), so the zero must come from
  `calibrate()` on the live brain, never from a constant.
* **fire** — Schmitt trigger on the pooled DNp01 rate. The rising edge fires, and while
  the rate stays inside the band the channel keeps firing at a rate proportional to the
  drive: it integrates the pooled rate in excess of `off_hz` and emits one action per
  `spikes_per_action` pooled spikes. Edge-only was the original rule (#3 §3.5) and is
  still reachable with `spikes_per_action: null`, but it is wrong for a command neuron
  under sustained input — real looming holds DNp01 far above `off_hz` for the whole
  approach, so the edge never recurs and the fly goes silent exactly when a missile is
  about to land (#25). Rest stays quiet for one reason only: `on_hz` is set above the
  EMA step a single isolated spike produces, so one stray spike from a small population
  cannot arm the channel. Clearing the integrator on release does **not** contribute to
  that — see `_trigger` (#31).
* **weapon** — Schmitt on the pooled DNg100+MDN rate, advancing a weapon ring. **Ships
  `enabled: false`**, so the rate is measured and published as telemetry and nothing acts
  on it. No site injects into either type — DNg100 is not drivable at all on the real
  brain, and MDN has no game signal wired to it — but "nothing drives it" is not the same
  claim as "it is silent", and the earlier docstring conflated them: baseline network
  activity alone carried the pooled EMA across a band that sat inside the channel's own
  resting distribution, and the fly changed launcher for no reason (#27). No threshold
  fixes that. The channel's EMA under maximum looming barely exceeds its own resting
  maximum, so every band is either inside the noise or out of reach — what little the
  channel does track is a leak of the looming signal, not a weapon choice. Disabled by
  construction beats inert by hope. The mechanism stays implemented and unit-tested for
  whoever wires a real signal to it; inventing one would be fabricating a capability.

Rates are pooled per channel — `spike_count / dt`, summed over the population, not per
neuron. That is the quantity the `on_hz`/`off_hz` bands were measured against.

`decode()` *proposes* a latch and `on_result()` commits or reverts it, so an action the
bridge rejected is never counted as fired. Holds no clock and no socket: #4 calls
`observe()` once per brain step and `decode()` once per decode tick.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np

from .lif import FlyBrain
from .mapping import Mapping, MappingError, column, loom

if TYPE_CHECKING:  # §3.1: the decoder must not import the encoder at runtime
    from .encoder import Encoder

WEAPONS = 7
"""Launcher indices the bridge accepts (`fly-bridge.js:128` validates 0..6)."""


class Decoder:
    def __init__(self, brain: FlyBrain, mapping: Mapping | None = None) -> None:
        self.brain = brain
        self.mapping = mapping or Mapping.default()
        m = self.mapping

        # Eager, mirroring `Encoder.__init__`: `brain.cells()` returns an empty array for a
        # type this brain lacks, so a typo would give a permanently dead readout with no
        # error at all. §3.2: a bad config must fail before the first frame. A type present
        # on only one side is legitimate (MDN is unilateral), so this checks the type, not
        # the per-side population size.
        present = set(brain.meta.cell_type.tolist())
        for where, types in (("aim", m.aim["types"]), ("fire", m.fire.types),
                             ("weapon", m.weapon.types)):
            missing = sorted(t for t in types if t not in present)
            if missing:
                raise MappingError(f"readout {where!r}: cell types {missing} are absent from "
                                   f"this brain's {len(present)} annotated types")

        self._pop = {
            "aim_L": brain.cells(list(m.aim["types"]), side="L"),
            "aim_R": brain.cells(list(m.aim["types"]), side="R"),
            "fire": brain.cells(list(m.fire.types)),
            "weapon": brain.cells(list(m.weapon.types)),
        }
        self._tau = {"aim_L": m.aim["tau"], "aim_R": m.aim["tau"],
                     "fire": m.fire.tau, "weapon": m.weapon.tau}
        self._mask = np.zeros(brain.n, dtype=bool)  # reused; zeroing 166k per step is waste
        zero = m.aim["zero"]
        self.aim_zero = None if zero is None else float(zero)  # else calibrate() measures it
        self.reset(readout=True)

    def reset(self, *, readout: bool = False) -> None:
        """Crosshair to centre, session counters cleared. Does not clear `aim_zero`.

        The EMAs and latches are **brain-derived**, and #4 resets the decoder at a session
        boundary and on reconnect while deliberately not resetting the brain (#4 §4.3).
        Zeroing them there discards a measurement of a system that did not change, and the
        EMA then re-converges from 0 through `on_hz` — a rising edge the brain never
        produced, and one spurious `fire` every reconnect (#22). So they survive a reset by
        default: a channel that is genuinely hot at reset time stays hot and keeps its
        train, and a cold one still needs a real crossing. Pass `readout=True` only when
        the caller also reset the brain.
        """
        if readout:
            self.rates = {k: 0.0 for k in self._pop}
            self._latched = {"fire": False, "weapon": False}
            self._charge = {"fire": 0.0, "weapon": 0.0}
            self._brain_dt = 0.0
        self.crosshair_x = 0.5
        self.halted = False
        self._dead_weapons: set[int] = set()
        self._pending: dict | None = None
        self._cmd = 0.0
        self._y_source = "default"
        self.stats: dict[str, Any] = {"actions": 0, "fired": 0, "weapon_switches": 0,
                                      "rejected": {}}

    # ---------------------------------------------------------------- per brain step

    def observe(self, fired: np.ndarray, dt: float) -> None:
        """Once per brain step. `fired` is exactly what `FlyBrain.step()` returned.

        Also accumulates the **brain** time `decode()` will integrate over. That is the
        only clock in this class: `dt` here is `FlyBrain.params.dt`, the same quantity the
        rates below are per-second of, so the two compose into a spike count (#30).
        """
        self._brain_dt += dt
        self._mask[fired] = True
        for key, idx in self._pop.items():
            count = int(self._mask[idx].sum())
            a = 1.0 - math.exp(-dt / self._tau[key])
            self.rates[key] += a * (count / dt - self.rates[key])
        self._mask[fired] = False

    # ---------------------------------------------------------------- per decode tick

    def decode(self, state: dict, dt_decode: float) -> dict:
        """One message `FlyBridge.applyAction()` accepts. At most one action per call.

        `dt_decode` is **not** the clock. Everything here integrates over the brain time
        `observe()` has accumulated since the last call, so a decode tick that covers more
        simulated time buys proportionally more action and one that covers none buys none.
        The argument is kept for the call signature #4 already uses, and because a caller
        that never calls `observe()` has offered no other clock — but the production path
        always has brain time and always uses it (#30).
        """
        if self.halted:
            return {"action": "noop"}
        if not isinstance(state, dict):
            state = {}  # #26: a malformed frame must not end the session

        # A latch nobody confirmed is treated as committed: #4 is not obliged to be
        # synchronous, and re-offering forever would spam the game.
        self._pending = None
        before = dict(self._latched)
        before_charge = dict(self._charge)

        dt, self._brain_dt = (self._brain_dt or dt_decode), 0.0

        self._cmd = self._command()
        # Written state, so a single non-finite value would be permanent — the same trap
        # as a NaN in `FlyBrain.v` (#13). The clip does not protect it (#35), and `dt` is
        # the caller's, so the guard is on what is about to be stored: a step that does
        # not produce a usable position leaves the crosshair where it was.
        moved = float(np.clip(
            self.crosshair_x + self.mapping.aim["k_turn"] * dt * self._cmd, 0.0, 1.0))
        if math.isfinite(moved):
            self.crosshair_x = moved

        fire = self._trigger("fire", self.mapping.fire, dt)
        weapon = self._trigger("weapon", self.mapping.weapon, dt)

        action: dict[str, Any]
        if fire:
            action = {"action": "fire", **self._coords(state)}
        elif self._cmd != 0.0:
            action = {"action": "aim", **self._coords(state)}
        else:
            action = {"action": "noop"}

        weapon_index = self._advance_weapon(state) if weapon else None
        if weapon_index is not None:
            action["weapon_switch"] = weapon_index

        if fire or weapon_index is not None:
            self._pending = {"latched": before, "charge": before_charge,
                             "weapon": weapon_index, "fired": bool(fire)}
        self.stats["actions"] += 1
        self.stats["fired"] += bool(fire)
        self.stats["weapon_switches"] += weapon_index is not None
        return action

    def on_result(self, result: dict) -> None:
        """Feed back `FlyBridge.applyAction()`'s reply. Commits or reverts the last latch."""
        pending, self._pending = self._pending, None
        if not isinstance(result, dict):
            result = {"ok": False, "reason": "malformed_result"}
        if result.get("ok"):
            return

        reason = str(result.get("reason", "unknown"))
        self.stats["rejected"][reason] = self.stats["rejected"].get(reason, 0) + 1
        if reason == "detached":
            # Terminal: the bridge is gone, so no later action can ever land. Never retried.
            self.halted = True
            return
        if pending is None:
            return
        if reason == "launcher_dead" and pending["weapon"] is not None:
            self._dead_weapons.add(pending["weapon"])
        # Both halves of the trigger's state, not just the latch. Reverting `_latched`
        # alone re-offers an *edge* fire, because the rising edge recurs — but a
        # charge-driven fire had already spent the charge that bought it, so it was
        # silently dropped while `stats` recorded the revert (#31). The propose/commit
        # protocol exists to make those two cases symmetric.
        self._latched.update(pending["latched"])
        self._charge.update(pending["charge"])
        self.stats["fired"] -= pending["fired"]
        self.stats["weapon_switches"] -= pending["weapon"] is not None

    # ---------------------------------------------------------------- calibration

    def calibrate(self, encoder: Encoder, steps: int = 600, settle: int = 150) -> float:
        """Measure and store the aim channel's zero on *this* brain and seed.

        Resets the brain and the decoder, holds the neutral frame (empty sky, full health,
        symmetric aim drive) and averages the raw laterality index. Skipped if the config
        pins `aim.zero` — a hardcoded zero biases the crosshair one way (sd 0.09 across
        seeds), so the config value exists only for replaying a recorded session.
        """
        if self.mapping.aim["zero"] is not None:
            self.aim_zero = float(self.mapping.aim["zero"])
            return self.aim_zero

        frame = encoder.neutral()
        dt = self.brain.params.dt
        self.brain.reset()
        self.reset(readout=True)
        total = 0.0
        for i in range(settle + steps):
            self.observe(self.brain.step(inject=frame.inject), dt)
            if i >= settle:
                total += self._index()
        self.aim_zero = total / steps
        return self.aim_zero

    # ---------------------------------------------------------------- telemetry

    def telemetry(self) -> dict:
        return {
            "aim_index": self._index(), "aim_cmd": self._cmd, "crosshair_x": self.crosshair_x,
            "aim_zero": self.aim_zero, "fire_hz": self.rates["fire"],
            "weapon_hz": self.rates["weapon"], "y_source": self._y_source,
            "halted": self.halted, "stats": self.stats,
        }

    # ---------------------------------------------------------------- internals

    def _index(self) -> float:
        """Laterality in [-1, 1]. DNa02-L alone ⇒ +1 ⇒ crosshair moves right (normative).

        Non-finite rates give **no command**, not a non-finite one (#35). `self.rates` is
        public mutable state and this expression manufactures a NaN from two infinities
        on its own, so the `np.clip` downstream in `_command()` cannot be trusted to
        sanitise it — `np.clip` bounds an infinity and passes a NaN straight through.
        Guarding here rather than after the clip covers `_command()`, the crosshair,
        `calibrate()`'s average and the `aim_index` telemetry in one place, all of which
        consume this value.
        """
        left, right = self.rates["aim_L"], self.rates["aim_R"]
        index = (left - right) / (left + right + 1e-3)
        return index if math.isfinite(index) else 0.0

    def _command(self) -> float:
        """De-biased, dead-zoned turn rate in [-1, 1]."""
        aim = self.mapping.aim
        zero = 0.0 if self.aim_zero is None else self.aim_zero
        cmd = float(np.clip(self._index() - zero, -1.0, 1.0))
        dead = aim["dead"]
        cmd = 0.0 if abs(cmd) <= dead else math.copysign((abs(cmd) - dead) / (1.0 - dead), cmd)
        return -cmd if aim["invert"] else cmd

    def _trigger(self, key: str, channel, dt: float) -> bool:
        """Latch at `on_hz`, release below `off_hz`; fire on the edge and then on charge.

        `spikes_per_action` is the pooled spike count, above the `off_hz` floor, that buys
        one more action while the channel stays hot. `None` restores the edge-only rule.
        The charge is cleared on release, so a channel that never stays hot never builds
        one, and it is capped at one action per call so no rate can emit twice per tick.
        """
        if not channel.enabled:
            return False  # the rate is still measured and published; nothing acts on it

        hot = self.rates[key] > channel.off_hz if self._latched[key] \
            else self.rates[key] >= channel.on_hz
        rising = hot and not self._latched[key]
        self._latched[key] = hot

        per = channel.spikes_per_action
        if per is None:
            return rising
        if not hot:
            # Defensive, and **cannot currently change behaviour**: a hot run can only
            # begin on a rising edge, and that branch overwrites the charge outright, so
            # nothing a cold period leaves behind is ever read (#31, proven by execution
            # against a variant with this line removed). It is kept because it is what
            # makes "charge does not survive a cold period" true by construction rather
            # than by the accident of the line below — change that line to preserve the
            # charge across an edge and this one becomes load-bearing immediately.
            self._charge[key] = 0.0
            return False
        self._charge[key] = per if rising else \
            self._charge[key] + (self.rates[key] - channel.off_hz) * dt
        if self._charge[key] < per:
            return False
        # Carry the remainder rather than zeroing: one tick covering more brain time can
        # deliver several actions' worth of charge, and dropping it would make a decoder
        # that samples the same train less often fire less per second of brain time.
        # Capped at one spare so a transient leaves no queue.
        self._charge[key] = min(self._charge[key] - per, per)
        return True

    def _advance_weapon(self, state: dict) -> int | None:
        current = state.get("weapon")
        if not isinstance(current, int) or isinstance(current, bool) or not 0 <= current < WEAPONS:
            current = -1  # start screen: `launchers.indexOf(null)` is -1
        for step in range(1, WEAPONS + 1):
            candidate = (current + step) % WEAPONS
            if candidate not in self._dead_weapons and candidate != current:
                return candidate
        return None

    def _coords(self, state: dict) -> dict:
        """Crosshair x from the integrator; y from the threat, because no neuron encodes it."""
        aim = self.mapping.aim
        y = float(aim["y_default"])
        self._y_source = "default"
        if aim["y_policy"] == "threat":
            ys, strength = [], []
            missiles = state.get("missiles")
            for e in missiles if isinstance(missiles, (list, tuple)) else ():
                if not isinstance(e, dict):
                    continue
                ex, ok = _num(e.get("x"))
                ey, ok2 = _num(e.get("y"))
                evy, ok3 = _num(e.get("vy"))
                if not (ok and ok2 and ok3):
                    continue
                same_half = (column(ex, self.mapping.columns) < self.mapping.columns / 2) == \
                            (column(self.crosshair_x, self.mapping.columns)
                             < self.mapping.columns / 2)
                if same_half:
                    ys.append(ey)
                    strength.append(float(loom(ey, evy, self.mapping.loom)))
            if strength:
                y = float(np.clip(ys[int(np.argmax(strength))], 0.0, 1.0))
                self._y_source = "threat"
        return {"x": self.crosshair_x, "y": y}


def _num(value: Any) -> tuple[float, bool]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0, False
    return (v, True) if math.isfinite(v) else (0.0, False)
