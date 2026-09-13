"""What identifies a spike train, so a recorded one can refuse to replay wrong — #24.

Same seed and same params do **not** give the same trajectory. float32 addition is not
associative and the network is chaotic, so any change to the order the synaptic input is
summed in amplifies from one ulp to a different train within a second of simulated time.
Two such changes are hidden inputs today: `backend="auto"` resolves to whatever wheel is
installed, and `PARTITIONS` is a module constant nothing records.

This module does not remove either. It makes them **visible**, by naming everything that
decides a trajectory and attaching it to anything that persists one.

Two tiers, because "this is a different trajectory" and "this might be a different
trajectory" deserve different answers:

* **identity** — inputs proven to change the train, all of them under this project's
  control: seed, every `LIFParams` field, backend, `PARTITIONS`, and a digest of the
  connectome arrays the kernels actually read. A mismatch here means the recording
  describes a different computation, so `check()` raises.
* **environment** — interpreter, numpy, scipy and numba versions, and the machine. These
  *can* move the train (scipy's `csc_matvec` and numpy's PCG64 both have freedom the
  project does not control) but a mismatch is not proof of one, and refusing would make
  every recording expire on the next `pip install`. `check()` warns.

`PARTITIONS` is included **only for the numba backend**, which is the one place it is
read. Including it unconditionally would make a numpy recording refuse a replay that is
bit-identical — measured, not assumed.

The connectome digest is the expensive field by two orders of magnitude, so it is computed
lazily and never during `FlyBrain.__init__`: pass `connectome=False` for a fingerprint of
everything else. `identity_only()` needs neither a connectome nor numba and is what
`--check` uses to pin `PARTITIONS` against `trajectory.lock.json`.

CLI:  python -m src.brain.fingerprint [--check] [--update] [--json]
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import platform
import sys
import warnings
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from . import lif
from .connectome import BrainMeta

LOCK_PATH = Path(__file__).resolve().parent / "trajectory.lock.json"

VERSION = 1
"""Bumped only when a field is added to or removed from `identity`.

Recordings carry it so a reader can say "this predates the field you are missing" instead
of reporting a mismatch it cannot explain. Adding an *environment* field does not bump it:
environment never refuses, so an older recording simply has less to warn about.
"""


class TrajectoryMismatch(ValueError):
    """A recorded trajectory cannot be reproduced by this brain."""


@dataclasses.dataclass(frozen=True)
class Fingerprint:
    """Everything that decides a spike train, split by what a mismatch proves."""

    identity: dict[str, Any]
    environment: dict[str, Any]

    @property
    def short(self) -> str:
        """16 hex chars over `identity` — for a status bar, a filename or a log line."""
        blob = json.dumps(self.identity, sort_keys=True, separators=(",", ":"))
        return hashlib.blake2b(blob.encode(), digest_size=8).hexdigest()

    def to_dict(self) -> dict:
        return {"version": VERSION, "short": self.short,
                "identity": dict(self.identity), "environment": dict(self.environment)}

    @classmethod
    def from_dict(cls, raw: dict) -> "Fingerprint":
        if not isinstance(raw, dict):
            raise TrajectoryMismatch(f"fingerprint must be an object, got {type(raw).__name__}")
        got = raw.get("version")
        if got != VERSION:
            raise TrajectoryMismatch(
                f"fingerprint version {got!r}, this build writes {VERSION}; the identity "
                f"fields differ, so the two cannot be compared field by field")
        return cls(identity=dict(raw.get("identity") or {}),
                   environment=dict(raw.get("environment") or {}))

    def diff(self, other: "Fingerprint") -> tuple[list[str], list[str]]:
        """(identity differences, environment differences), each `key: mine -> theirs`."""
        return (_diff(self.identity, other.identity), _diff(self.environment, other.environment))


def _diff(mine: dict, theirs: dict) -> list[str]:
    return [f"{k}: {mine.get(k, '<absent>')!r} -> {theirs.get(k, '<absent>')!r}"
            for k in sorted(set(mine) | set(theirs)) if mine.get(k) != theirs.get(k)]


# --------------------------------------------------------------------------- building


def connectome_digest(W, meta: BrainMeta) -> str:
    """blake2b over exactly the arrays the kernels read, in the order they read them.

    Not over `weights.npz`: the file carries compression and archive metadata that do not
    reach the arithmetic, and a rebuild that changed neither would report a false
    mismatch. Not over a canonicalised matrix either — the *stored* order of the indices
    within a column is what the numba kernel accumulates in, so two matrices holding the
    same edges in a different order are genuinely two different trajectories.

    Fed through a buffer rather than `tobytes()` to avoid copying the whole matrix.
    """
    h = hashlib.blake2b(digest_size=16)
    h.update(str(int(meta.n)).encode())
    for arr in (W.indptr, W.indices, W.data):
        a = np.ascontiguousarray(arr)
        h.update(str(a.dtype).encode())
        h.update(memoryview(a).cast("B"))
    return h.hexdigest()


def identity_only(params: lif.LIFParams | None = None, *, seed: int = 64,
                  backend: str = "numba") -> dict[str, Any]:
    """The identity fields that need no connectome, no numba and no `FlyBrain`.

    This is the part `--check` can verify anywhere, and it is what pins `PARTITIONS`:
    the constant is read from the live module, so changing it and not updating the lock
    is a failing check rather than a silent new trajectory.
    """
    params = params or lif.LIFParams()
    out: dict[str, Any] = {
        "seed": int(seed),
        "backend": str(backend),
        "params": {f.name: getattr(params, f.name) for f in dataclasses.fields(params)},
    }
    if backend == "numba":
        # numpy never reads it; including it there would refuse a replay that is
        # bit-identical, which `fp24.py` confirmed by running both values on both backends.
        out["partitions"] = int(lif.PARTITIONS)
    return out


def fingerprint(brain: lif.FlyBrain, *, connectome: bool = True) -> Fingerprint:
    """Fingerprint a live brain. `connectome=False` skips the one expensive field."""
    ident = identity_only(brain.params, seed=brain._seed, backend=brain.backend)
    ident["connectome"] = connectome_digest(brain.W, brain.meta) if connectome else None
    return Fingerprint(identity=ident, environment=_environment())


def _environment() -> dict[str, Any]:
    from scipy import __version__ as scipy_version

    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy_version,
        "numba": getattr(lif.numba, "__version__", None),
        "platform": f"{platform.system()}-{platform.machine()}",
    }


def spike_digest(brain: lif.FlyBrain, steps: int, *,
                 inject: Sequence = ()) -> str:
    """blake2b over the fired indices of `steps` steps. Resets the brain first.

    The trajectory itself, reduced to something a lock file can hold. Every input to it is
    in the fingerprint, so a mismatch here with a matching fingerprint means the *code*
    moved, not the configuration — which is the case no field can capture.
    """
    brain.reset()
    h = hashlib.blake2b(digest_size=8)
    for _ in range(steps):
        h.update(brain.step(inject=inject).astype(np.int64).tobytes())
    return h.hexdigest()


# --------------------------------------------------------------------------- checking


def check(recorded: dict, brain: lif.FlyBrain, *, what: str = "recording",
          connectome: bool = True) -> Fingerprint:
    """Compare a recorded fingerprint against this brain. Returns the live one.

    Raises `TrajectoryMismatch` on an identity difference — the recording describes a
    different computation and replaying it would produce a different train while looking
    like a bug. Warns on an environment difference, because that is a suspicion rather
    than a proof and refusing would expire every recording on the next dependency bump.

    A `None` on **either** side matches anything: that is how a fingerprint taken with
    `connectome=False` says "I did not measure this", as opposed to "I measured a
    different one". Absence and disagreement are not the same claim.
    """
    theirs = Fingerprint.from_dict(recorded)
    want = connectome and theirs.identity.get("connectome") is not None
    mine = fingerprint(brain, connectome=want)
    ident, env = mine.diff(theirs)
    unmeasured = {k for k in set(mine.identity) | set(theirs.identity)
                  if mine.identity.get(k) is None or theirs.identity.get(k) is None}
    ident = [d for d in ident if d.split(":", 1)[0] not in unmeasured]
    if ident:
        raise TrajectoryMismatch(
            f"{what} was produced by a different computation and will not reproduce here: "
            + "; ".join(ident))
    if env:
        warnings.warn(f"{what} was produced in a different environment ("
                      + "; ".join(env) + "); the trajectory may still differ",
                      RuntimeWarning, stacklevel=2)
    return mine


# --------------------------------------------------------------------------- the lock


def read_lock(path: Path = LOCK_PATH) -> dict:
    if not path.exists():
        raise TrajectoryMismatch(f"{path} not found; run: python -m src.brain.fingerprint --update")
    return json.loads(path.read_text())


def check_lock(path: Path = LOCK_PATH, *, brain: lif.FlyBrain | None = None) -> list[str]:
    """Verify the shipped constants against the lock. Returns a list of complaints.

    The connectome-free half runs anywhere in milliseconds and is the half that pins
    `PARTITIONS`. The spike digest is checked only when a brain is supplied, since it
    needs the built connectome and the backend the lock was taken on.
    """
    lock = read_lock(path)
    bad = _diff(lock.get("identity") or {}, identity_only(backend=lock.get("backend", "numba")))
    bad = [f"lock {d}" for d in bad]
    if brain is not None and lock.get("spike_digest"):
        if brain.backend != lock.get("backend"):
            bad.append(f"lock was taken on backend {lock['backend']!r}, this brain is "
                       f"{brain.backend!r}; the spike digest is not comparable")
        else:
            got = spike_digest(brain, int(lock["steps"]))
            if got != lock["spike_digest"]:
                bad.append(f"spike digest over {lock['steps']} steps: "
                           f"{lock['spike_digest']} -> {got}")
    return bad


def _write_lock(path: Path, steps: int, brain: lif.FlyBrain | None) -> dict:
    backend = brain.backend if brain is not None else "numba"
    lock = {"version": VERSION, "backend": backend, "steps": steps,
            "identity": identity_only(backend=backend),
            "spike_digest": None, "connectome": None}
    if brain is not None:
        lock["spike_digest"] = spike_digest(brain, steps)
        lock["connectome"] = connectome_digest(brain.W, brain.meta)
    path.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
    return lock


# --------------------------------------------------------------------------- CLI


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Trajectory fingerprint and lock (#24).")
    ap.add_argument("--check", action="store_true", help="verify the lock; exit 1 on mismatch")
    ap.add_argument("--update", action="store_true", help="rewrite the lock from this build")
    ap.add_argument("--json", action="store_true", help="print the fingerprint as JSON")
    ap.add_argument("--steps", type=int, default=60)
    ap.add_argument("--data", type=Path, default=None)
    ap.add_argument("--backend", default="auto", choices=("auto", "numba", "numpy"))
    ap.add_argument("--no-connectome", action="store_true",
                    help="skip everything needing the built brain (fast, works anywhere)")
    args = ap.parse_args(argv)

    brain = None
    if not args.no_connectome:
        try:
            brain = lif.FlyBrain.load(args.data, backend=args.backend)
        except Exception as exc:  # the connectome is optional for the half that matters
            print(f"  no connectome ({exc}); checking the constants only")

    if args.update:
        lock = _write_lock(LOCK_PATH, args.steps, brain)
        print(f"wrote {LOCK_PATH}\n{json.dumps(lock, indent=2, sort_keys=True)}")
        return 0

    if args.check:
        bad = check_lock(brain=brain)
        if bad:
            print("trajectory lock MISMATCH:")
            for line in bad:
                print(f"  {line}")
            print("\nIf the change was deliberate, re-run with --update and commit the lock "
                  "in the same change, so the new trajectory is on the record.")
            return 1
        scope = "constants and spike digest" if brain is not None else "constants only"
        print(f"trajectory lock ok ({scope})")
        return 0

    fp = (fingerprint(brain) if brain is not None
          else Fingerprint(identity_only(), _environment()))
    print(json.dumps(fp.to_dict(), indent=2, sort_keys=True) if args.json
          else f"{fp.short}  {fp.identity}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
