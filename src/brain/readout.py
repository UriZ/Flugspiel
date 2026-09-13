"""A fitted linear readout over the descending population — #40 AC3.

The half of reservoir computing this project had skipped. The brain is frozen and does
the mixing; a linear map over its state does the inverting, and its coefficients are
*fitted* rather than hand-written. The alternative shipped for months: two named cells,
a laterality index and a threshold, chosen from the literature rather than from the
brain's response — and the cell chosen carried no side information at all (#40 AC2).

Two design choices carry the weight here:

* **Keyed on MaleCNS body ids, never on array indices.** The neuron axis is `meta.ids`
  sorted ascending, which is a property of the *build*: a rebuilt `brain.npz` with a
  different annotation cut renumbers it silently, and a readout keyed on indices would
  then apply the right weights to the wrong neurons with no error anywhere. `bind()`
  fails loudly instead, naming what it could not find.
* **Provenance is mandatory and is loaded, not documented.** A fitted readout that
  cannot say what it was fitted on and what was held out is not a result. `load()`
  rejects a file missing any of `REQUIRED_PROVENANCE`, so the disclosure cannot rot
  away from the coefficients it describes.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

REQUIRED_PROVENANCE = ("brain_seed", "stimulus_seed", "n_ticks", "held_out",
                       "r2_temporal_holdout", "r2_other_seed", "r2_shuffled_label",
                       "ceiling", "prosthesis")
"""What a readout must be able to say about itself before anything may use it (#40 R4)."""


class ReadoutError(ValueError):
    """A readout that cannot be trusted to apply to this brain."""


@dataclass(frozen=True)
class LinearReadout:
    """A fitted linear map from a per-neuron leaky rate trace to one scalar."""

    body_ids: np.ndarray    # int64 (k,), MaleCNS body ids — NOT array indices
    weights: np.ndarray     # float64 (k,)
    intercept: float
    tau: float              # s, the EMA constant the features were fitted with
    lo: float               # clip bounds of the fitted target
    hi: float
    provenance: dict

    # ---------------------------------------------------------------- persistence

    @classmethod
    def load(cls, path: str | Path) -> "LinearReadout":
        path = Path(path)
        if not path.exists():
            raise ReadoutError(f"{path} not found")
        with np.load(path, allow_pickle=False) as f:
            try:
                prov = json.loads(str(f["provenance"]))
                out = cls(body_ids=f["body_ids"].astype(np.int64),
                          weights=f["weights"].astype(np.float64),
                          intercept=float(f["intercept"]), tau=float(f["tau"]),
                          lo=float(f["lo"]), hi=float(f["hi"]), provenance=prov)
            except (KeyError, ValueError) as exc:
                raise ReadoutError(f"{path} is not a readout ({exc})") from exc
        missing = [k for k in REQUIRED_PROVENANCE if k not in out.provenance]
        if missing:
            raise ReadoutError(f"{path}: provenance is missing {missing}; a fitted readout "
                               f"must carry what it was fitted on and what was held out")
        if len(out.body_ids) != len(out.weights):
            raise ReadoutError(f"{path}: {len(out.body_ids)} body ids against "
                               f"{len(out.weights)} weights")
        if out.tau <= 0.0:
            raise ReadoutError(f"{path}: tau must be positive, got {out.tau}")
        return out

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, body_ids=np.asarray(self.body_ids, dtype=np.int64),
                 weights=np.asarray(self.weights, dtype=np.float64),
                 intercept=np.float64(self.intercept), tau=np.float64(self.tau),
                 lo=np.float64(self.lo), hi=np.float64(self.hi),
                 provenance=json.dumps(self.provenance, sort_keys=True))

    # ---------------------------------------------------------------- use

    def bind(self, brain) -> np.ndarray:
        """This readout's body ids as indices into *this* brain. int64 (k,)."""
        ids = brain.meta.ids
        # Sorted explicitly rather than assuming `meta.ids` is: the assumption holds for
        # every build today and a bare `searchsorted` on an unsorted axis would return
        # plausible wrong indices, which is the failure this class exists to prevent.
        order = np.argsort(ids)
        pos = order[np.clip(np.searchsorted(ids[order], self.body_ids), 0, len(ids) - 1)]
        bad = ids[pos] != self.body_ids
        if bad.any():
            names = self.body_ids[bad]
            raise ReadoutError(
                f"{int(bad.sum())} of {len(self.body_ids)} readout neurons are absent from "
                f"this brain: {names[:8].tolist()}{' …' if bad.sum() > 8 else ''}. The "
                f"readout was fitted on a different build and its weights do not describe "
                f"these cells.")
        return pos.astype(np.int64)

    def apply(self, trace: np.ndarray) -> float:
        """`clip(w·trace + b, lo, hi)`; a non-finite trace gives the midpoint, never a NaN.

        Same rule as `Decoder._index`: the crosshair is written state, so one non-finite
        value would be permanent (#35). The midpoint is the honest answer to "no usable
        estimate" — it is what an untrained readout would say.
        """
        value = float(self.weights @ trace) + self.intercept
        if not math.isfinite(value):
            return 0.5 * (self.lo + self.hi)
        return float(np.clip(value, self.lo, self.hi))
