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
* **fire** — Schmitt trigger on the pooled DNp01 rate, emitting only on the rising edge.
* **weapon** — Schmitt on the pooled DNg100+MDN rate, advancing a weapon ring. DNg100 is
  **not drivable at all** on the real brain (0.00 Hz even with its 47 strongest presynaptic
  partners at +3.0) and MDN has no game signal wired to it, so with the default config this
  channel never fires. The mechanism is implemented and unit-tested; inventing a "switch
  weapon" signal would be fabricating a capability.

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
from .mapping import Mapping, column, loom

if TYPE_CHECKING:  # §3.1: the decoder must not import the encoder at runtime
    from .encoder import Encoder

WEAPONS = 7
"""Launcher indices the bridge accepts (`fly-bridge.js:128` validates 0..6)."""


class Decoder:
    def __init__(self, brain: FlyBrain, mapping: Mapping | None = None) -> None:
        self.brain = brain
        self.mapping = mapping or Mapping.default()
        m = self.mapping

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
        self.reset()

    def reset(self) -> None:
        """Crosshair to centre, all EMAs and latches cleared. Does not clear `aim_zero`."""
        self.rates = {k: 0.0 for k in self._pop}
        self.crosshair_x = 0.5
        self.halted = False
        self._latched = {"fire": False, "weapon": False}
        self._dead_weapons: set[int] = set()
        self._pending: dict | None = None
        self._cmd = 0.0
        self._y_source = "default"
        self.stats: dict[str, Any] = {"actions": 0, "fired": 0, "weapon_switches": 0,
                                      "rejected": {}}

    # ---------------------------------------------------------------- per brain step

    def observe(self, fired: np.ndarray, dt: float) -> None:
        """Once per brain step. `fired` is exactly what `FlyBrain.step()` returned."""
        self._mask[fired] = True
        for key, idx in self._pop.items():
            count = int(self._mask[idx].sum())
            a = 1.0 - math.exp(-dt / self._tau[key])
            self.rates[key] += a * (count / dt - self.rates[key])
        self._mask[fired] = False

    # ---------------------------------------------------------------- per decode tick

    def decode(self, state: dict, dt_decode: float) -> dict:
        """One message `FlyBridge.applyAction()` accepts. At most one action per call."""
        if self.halted:
            return {"action": "noop"}

        # A latch nobody confirmed is treated as committed: #4 is not obliged to be
        # synchronous, and re-offering forever would spam the game.
        self._pending = None
        before = dict(self._latched)

        self._cmd = self._command()
        self.crosshair_x = float(np.clip(
            self.crosshair_x + self.mapping.aim["k_turn"] * dt_decode * self._cmd, 0.0, 1.0))

        fire = self._schmitt("fire", self.mapping.fire)
        weapon = self._schmitt("weapon", self.mapping.weapon)

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
            self._pending = {"latched": before, "weapon": weapon_index, "fired": bool(fire)}
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
        self._latched.update(pending["latched"])  # re-offer the edge next tick
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
        self.reset()
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
        """Laterality in [-1, 1]. DNa02-L alone ⇒ +1 ⇒ crosshair moves right (normative)."""
        left, right = self.rates["aim_L"], self.rates["aim_R"]
        return (left - right) / (left + right + 1e-3)

    def _command(self) -> float:
        """De-biased, dead-zoned turn rate in [-1, 1]."""
        aim = self.mapping.aim
        zero = 0.0 if self.aim_zero is None else self.aim_zero
        cmd = float(np.clip(self._index() - zero, -1.0, 1.0))
        dead = aim["dead"]
        cmd = 0.0 if abs(cmd) <= dead else math.copysign((abs(cmd) - dead) / (1.0 - dead), cmd)
        return -cmd if aim["invert"] else cmd

    def _schmitt(self, key: str, channel) -> bool:
        """True only on the rising edge: latch at `on_hz`, release below `off_hz`."""
        hot = self.rates[key] > channel.off_hz if self._latched[key] \
            else self.rates[key] >= channel.on_hz
        rising = hot and not self._latched[key]
        self._latched[key] = hot
        return rising

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
            for e in state.get("missiles") or []:
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
