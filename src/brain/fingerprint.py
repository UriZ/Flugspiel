"""What identifies a spike train, so a recorded one can refuse to replay wrong — #24.

Same seed and same params do **not** give the same trajectory. float32 addition is not
associative and the network is chaotic, so any change to the order the synaptic input is
summed in amplifies from one ulp to a different train within a second of simulated time.
Two such changes are hidden inputs at the call site: `backend="auto"` resolves to whatever
wheel is installed, and `PARTITIONS` is a bare module constant that no recording carries
unless something puts it there.

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

The connectome digest is by a wide margin the expensive field, so it is computed
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
    mismatch.

    This digest is **conservative, not tight**, and the difference is worth knowing before
    trusting a mismatch. It covers the *stored* order of the row indices within a column,
    which on the matrix this project ships cannot move the trajectory at all: CSC canonical
    form has no duplicate row index inside a column, so each element of the kernel's
    accumulator is written at most once per column and a within-column permutation reorders
    which elements are touched, never the additions into any one of them. Reversing that
    order moves this digest and leaves the spike digest bit-identical on both backends —
    measured, not reasoned (#37). The order that does decide the trajectory is the one
    *across* columns, fixed by the ascending `fired` array and by how it is sliced, i.e.
    `PARTITIONS`, which `identity` already carries.

    So a rebuild that reordered within a column would report a mismatch it should not, and
    canonicalising first would remove that class. The reason to do it is stronger than
    tidiness and is the one thing the paragraph above depends on: the no-duplicates premise
    is a property of *canonical* CSC, not of CSC, and a matrix carrying duplicate entries in
    a column really would make within-column order trajectory-relevant. Canonical form is
    what rules that out. Deliberately **not** done here — it belongs in its own change, with
    its own check of whether the digest moved (#37).

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

    This is the part `--check` can verify anywhere, and it is what pins `PARTITIONS` and
    every `LIFParams` field: both are read from the live module, so changing one and not
    updating the lock is a failing check rather than a silent new trajectory.

    `seed` is not pinned that way and must not be read as though it were. The default above
    is *this* module's literal, and `check_lock` calls this function without a seed, so it
    compares the lock against a constant that moves only when this line does — a change to
    `FlyBrain`'s own default seed passes the constants-only check untouched. The full check
    catches it through the spike digest. Anything relying on `--no-connectome` alone is
    relying on that gap staying closed by hand (#37).
    """
    params = params or lif.LIFParams()
    out: dict[str, Any] = {
        "seed": int(seed),
        "backend": str(backend),
        "params": {f.name: getattr(params, f.name) for f in dataclasses.fields(params)},
    }
    if backend == "numba":
        # numpy never reads it — `_propagate_numpy` never mentions the constant — so
        # including it there would refuse a replay that is bit-identical. Confirmed by
        # running both values on both backends (#24); the spike that did it was never
        # committed, so the record is the issue, not a file.
        out["partitions"] = int(lif.PARTITIONS)
    return out


def fingerprint(brain: lif.FlyBrain, *, connectome: bool = True) -> Fingerprint:
    """Fingerprint a live brain. `connectome=False` skips the one expensive field."""
    ident = identity_only(brain.params, seed=brain.seed, backend=brain.backend)
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

    Three tiers, cheapest first. The constants run anywhere in microseconds and are the
    half that pins `PARTITIONS`; the connectome and spike digests need a brain, and the
    spike digest additionally needs the backend the lock was taken on.

    A `None` on either side of a digest means *not measured*, never *empty* — the same
    convention `check()` uses. A lock written without a brain therefore says nothing about
    the connectome or the trajectory rather than asserting they were blank, and `--check`
    reports what it actually verified rather than what it could have.

    The connectome digest is checked **before** the spike digest and reported *instead* of
    it (#51). A changed connectome moves the train by construction, so running both would
    bury the specific diagnosis under the general one and pay for a trajectory the answer
    is already known for. Order also repairs a claim this module makes about itself: a
    spike mismatch is documented as meaning the *code* moved, and that only follows once
    the connectome has been ruled out. It costs about what it saves — the two digests are
    the same order of magnitude — so this buys specificity, not speed, except in the
    failing case.
    """
    lock = read_lock(path)
    bad = [f"lock {d}" for d in
           _diff(lock.get("identity") or {}, identity_only(backend=lock.get("backend", "numba")))]
    if brain is None:
        return bad

    ruled_out = False
    if lock.get("connectome"):
        got = connectome_digest(brain.W, brain.meta)
        if got != lock["connectome"]:
            bad.append(f"connectome digest: {lock['connectome']} -> {got}; this brain was "
                       f"built from different weights or metadata, so the spike digest "
                       f"could not have matched and was not run")
            return bad
        ruled_out = True
    if lock.get("spike_digest"):
        if brain.backend != lock.get("backend"):
            bad.append(f"lock was taken on backend {lock['backend']!r}, this brain is "
                       f"{brain.backend!r}; the spike digest is not comparable")
        else:
            got = spike_digest(brain, int(lock["steps"]))
            if got != lock["spike_digest"]:
                # Conditioned on having actually run the connectome digest. Saying "the
                # code moved" against a lock that records no connectome digest would name
                # a cause this check never eliminated.
                why = ("the connectome and every identity field match, so the code moved"
                       if ruled_out else
                       "this lock carries no connectome digest, so the code and the "
                       "connectome are both still in play and this cannot tell them apart")
                bad.append(f"spike digest over {lock['steps']} steps: "
                           f"{lock['spike_digest']} -> {got}; {why}")
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
        # Derived from the lock, not from `brain is not None`: a lock written by
        # `--update --no-connectome` carries null digests, and the old message called
        # that "constants and spike digest" on any machine that had a brain to load.
        lock = read_lock(LOCK_PATH)
        checked = ["constants"]
        if brain is not None:
            checked += [n for n, k in (("connectome digest", "connectome"),
                                       ("spike digest", "spike_digest")) if lock.get(k)]
        print(f"trajectory lock ok ({', '.join(checked)})")
        return 0

    fp = (fingerprint(brain) if brain is not None
          else Fingerprint(identity_only(), _environment()))
    print(json.dumps(fp.to_dict(), indent=2, sort_keys=True) if args.json
          else f"{fp.short}  {fp.identity}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
