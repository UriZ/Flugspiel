"""Leaky integrate-and-fire simulation over the MaleCNS connectome.

    v ← decay·v + gain·(W @ spikes) + tonic + noise;  fire at v ≥ 1, reset to 0.

Two interchangeable CPU kernels compute `W @ spikes`. The numba one scatters the CSC
column of each fired neuron (only ~7% of neurons fire per step, so it touches ~1.8M of
25.6M nonzeros); the numpy one does the full sparse matvec. numba is an optimisation,
not a requirement — see `requirements-fast.txt`.

CLI:  python -m src.brain.lif [--steps 100] [--backend auto]
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
from scipy import sparse

from .connectome import BrainMeta, load

try:
    import numba
except ImportError:  # pragma: no cover - depends on the install
    numba = None


@dataclass(frozen=True)
class LIFParams:
    """Simulation constants.

    These are hand-tuned, not measured from biology. With no synaptic input the fixed
    point is v∞ = tonic/(1-decay) = 0.772 < 1, so an isolated neuron never fires on the
    background drive alone — activity has to come from synapses and noise. With rows
    normalised to |w| sum 1, gain=3.0 means a neuron whose whole input population fires
    at once receives ~3× threshold. On the real connectome that settles at ~7% of
    neurons firing per 20 ms step (≈3.6 Hz), stable over hundreds of steps.
    """

    dt: float = 0.020        # s
    tau: float = 0.100       # s, membrane time constant
    gain: float = 3.0        # scales W @ spikes
    tonic: float = 0.14      # constant drive per step
    noise_hz: float = 1.2    # spontaneous event rate per neuron
    noise_amp: float = 0.22  # voltage kick per noise event
    threshold: float = 1.0
    v_reset: float = 0.0

    def __post_init__(self) -> None:
        """Reject parameters that silently break the model instead of raising (#12).

        Runs once per construction, never per step. Every one of these produced a brain
        that still ran and still returned spike trains: `tau <= 0` gives `decay >= 1` and
        a membrane that gains charge forever, `dt <= 0` removes the leak that puts the L
        in LIF, `threshold <= v_reset` makes every neuron fire on every step for the life
        of the process, and a negative `gain` swaps excitation and inhibition network-wide,
        discarding the neurotransmitter signs baked into W. A non-finite `v_reset` is the
        same defect as #13 by another route: `v` never recovers from it.

        `tonic` carries no inequality on purpose — a hyperpolarising bias is a legitimate
        thing to ask for — which is why finiteness is checked separately rather than being
        left to fall out of the comparisons.
        """
        for name in ("dt", "tau", "gain", "tonic", "noise_hz", "noise_amp",
                     "threshold", "v_reset"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) \
                    or not math.isfinite(value):
                raise ValueError(f"LIFParams.{name} must be a finite number, got {value!r}")
        for name, ok, want in (("dt", self.dt > 0, "> 0"),
                               ("tau", self.tau > 0, "> 0"),
                               ("gain", self.gain >= 0, ">= 0"),
                               ("noise_hz", self.noise_hz >= 0, ">= 0"),
                               ("noise_amp", self.noise_amp >= 0, ">= 0"),
                               ("threshold", self.threshold > self.v_reset, "> v_reset")):
            if not ok:
                raise ValueError(f"LIFParams.{name} must be {want}, "
                                 f"got {getattr(self, name)!r}")

    @property
    def decay(self) -> float:
        return math.exp(-self.dt / self.tau)


def _check_seed(seed: int) -> int:
    """A seed that is not an int defeats the determinism this module documents (#12)."""
    if isinstance(seed, bool) or not isinstance(seed, (int, np.integer)):
        why = ("None draws OS entropy, which silently breaks both the determinism "
               "guarantee and reset()" if seed is None else
               "np.random.default_rng would accept it and the seed stored for reset() "
               "would not be the one asked for")
        raise TypeError(f"seed must be an int, got {seed!r}; {why}")
    return int(seed)


def _check_inject(idx: np.ndarray, amount: float | np.ndarray) -> None:
    """Reject the two ways a caller can silently corrupt `v` (#12, #13).

    A NaN in `v` is permanent and invisible: `nan >= threshold` is False, so the neuron
    never fires, never gets reset to `v_reset`, and is dropped from the network for the
    rest of the session with nothing to observe — `rates()` does not move. A negative
    index is worse than an error because numpy wraps it onto a real neuron at the far end
    of the array, and -1 is a plausible "no target" sentinel out of an encoder; positive
    out-of-range indices already raise, so the two directions disagreed.

    Both checks are O(len(idx)) at the entry point, not O(n) on every step.
    """
    idx = np.asarray(idx)
    if idx.size and idx.min() < 0:
        raise IndexError(f"negative neuron index {int(idx.min())}: numpy would wrap it "
                         f"onto a neuron at the other end of the array rather than raise")
    if not np.all(np.isfinite(amount)):
        raise ValueError("non-finite injection amount: a NaN in v never fires, never "
                         "resets, and removes the neuron for the rest of the session")


def _propagate_numpy(W: sparse.csc_matrix, fired: np.ndarray, n: int) -> np.ndarray:
    spikes = np.zeros(n, dtype=np.float32)
    spikes[fired] = 1.0
    return W @ spikes


PARTITIONS = 8
"""How many slices `fired` is cut into — fixed, deliberately *not* the thread count.

float32 addition is not associative, so the number of partial sums decides the result
bit for bit. Keying it to `get_num_threads()` made the spike train a property of the
machine's core count: same seed, same params, four different trains at 16/8/4/1 threads,
diverging by step 30 (#11). numba schedules these slices onto however many threads exist,
and the reduction below runs in partition order, so the output is identical everywhere.

Choosing the value trades two costs that move in opposite directions. `buf` below is
(PARTITIONS, n) float32, allocated and zeroed *every step*, so that cost is fixed in
PARTITIONS and paid whether or not anything fired; the scatter, in contrast, parallelises
better the more slices there are, and its share of the step grows with how many neurons
fired. A value below this one wins at the firing rate the network currently settles at and
then crosses over to worse as activity rises — which is why the value is not chosen at the
operating point. This one measured fastest or tied across the thread counts tried, and
never worse than any other at any activity level tried (#10).

That sweep ran where the thread count could exceed PARTITIONS, which starves the scatter
phase; on hardware with many more cores than this value a larger one may well win again.
Re-measure before assuming the choice transfers, and interleave the variants.

Changing this value changes the spike train, and nothing pins it (#24) — anything that
records a trajectory has to record PARTITIONS alongside the seed and the backend.
"""


if numba is not None:
    @numba.njit(nogil=True, parallel=True, cache=True)
    def _propagate_numba(indptr, indices, data, fired, n):
        """Sum the CSC columns of the fired neurons into a dense current vector.

        `fired` is split into `PARTITIONS` contiguous slices, each accumulating into its
        own buffer, so no two threads write the same element.
        """
        buf = np.zeros((PARTITIONS, n), dtype=np.float32)
        k = len(fired)
        for t in numba.prange(PARTITIONS):
            for m in range(k * t // PARTITIONS, k * (t + 1) // PARTITIONS):
                j = fired[m]
                for p in range(indptr[j], indptr[j + 1]):
                    buf[t, indices[p]] += data[p]
        out = np.zeros(n, dtype=np.float32)
        for i in numba.prange(n):
            acc = np.float32(0.0)
            for t in range(PARTITIONS):
                acc += buf[t, i]
            out[i] = acc
        return out
else:  # pragma: no cover - depends on the install
    _propagate_numba = None


class FlyBrain:
    """A fly brain stepping at `params.dt`.

    Determinism: same seed + same backend + same params ⇒ identical spike trains, on any
    machine and at any thread count (see `PARTITIONS`). Across backends they diverge — the
    kernels sum the same weights in different orders (~1e-7 relative), which is enough to
    flip a neuron sitting on the threshold. Compare currents across backends with a
    tolerance, never spike indices.
    """

    def __init__(self, weights: sparse.spmatrix, meta: BrainMeta,
                 params: LIFParams = LIFParams(), *, seed: int = 64,
                 backend: str = "auto") -> None:
        if backend not in ("auto", "numba", "numpy"):
            raise ValueError(f"backend must be auto/numba/numpy, got {backend!r}")
        if weights.shape != (meta.n, meta.n):
            raise ValueError(f"weights {weights.shape} do not match {meta.n} neurons")
        if backend == "numba" and numba is None:
            raise ImportError("backend='numba' requested but numba is not installed")

        self.meta = meta
        self.params = params
        self.n = meta.n
        # copy=True: #7 mutates brain.W.data in place, and a CSC input already at
        # float32 otherwise shares the caller's buffer.
        self.W = sparse.csc_matrix(weights, dtype=np.float32, copy=True)
        self.backend = "numba" if (backend != "numpy" and numba is not None) else "numpy"
        self._seed = _check_seed(seed)
        self.reset(self._seed)
        if self.backend == "numba":
            self._synaptic_input(np.zeros(1, dtype=np.int64))  # ~1.7 s of JIT, not on frame 1

    @classmethod
    def load(cls, data_dir: Path | None = None, *, params: LIFParams = LIFParams(),
             seed: int = 64, backend: str = "auto") -> "FlyBrain":
        W, meta = load(data_dir)
        brain = cls(W, meta, params, seed=seed, backend=backend)
        print(f"FlyBrain: {brain.n} neurons, {brain.W.nnz} connections, backend={brain.backend}")
        return brain

    def reset(self, seed: int | None = None) -> None:
        """v ← 0, no fired neurons, step counter 0, RNG reseeded (None reuses the last seed).

        `None` is the only non-int accepted, and it means *reuse*, never *reseed from
        entropy* — `__init__` rejects it, so `self._seed` is always an int and `reset()`
        always reproduces the trajectory (#12).
        """
        if seed is not None:
            self._seed = _check_seed(seed)
        self.rng = np.random.default_rng(self._seed)
        self.v = np.zeros(self.n, dtype=np.float32)
        self.fired = np.empty(0, dtype=np.int64)
        self.steps = 0

    def cells(self, types: Sequence[str], side: str | None = None) -> np.ndarray:
        """Indices whose cell_type is in `types`, optionally on one side. May be empty."""
        if isinstance(types, str):
            # list("DNp01") is ["D","N","p","0","1"], which matches nothing or, worse,
            # the wrong types. Rejecting beats returning a plausible empty array.
            raise TypeError(f"cells() takes a sequence of names, not the string {types!r}")
        mask = np.isin(self.meta.cell_type, list(types))
        if side is not None:
            mask &= self.meta.side == side
        return np.flatnonzero(mask).astype(np.int64)

    def stimulate(self, idx: np.ndarray, amount: float | np.ndarray) -> None:
        """Add voltage now, i.e. before the next step's decay.

        Repeated indices accumulate (`np.add.at`), so an encoder may emit whatever index
        array falls out of its mapping without first de-duplicating it. It may not emit a
        negative index or a non-finite amount — see `_check_inject`.
        """
        _check_inject(idx, amount)
        np.add.at(self.v, idx, amount)

    def _synaptic_input(self, fired: np.ndarray) -> np.ndarray:
        if self.backend == "numba":
            return _propagate_numba(self.W.indptr, self.W.indices, self.W.data, fired, self.n)
        return _propagate_numpy(self.W, fired, self.n)

    def step(self, inject: Sequence[tuple[np.ndarray, float | np.ndarray]] = ()) -> np.ndarray:
        """Advance one dt. Returns the indices that fired this step.

        The order below is normative: swapping the noise and threshold lines changes the
        dynamics.
        """
        p = self.params
        current = self._synaptic_input(self.fired)
        self.v *= p.decay
        self.v += current * p.gain
        self.v += p.tonic
        self.v += (self.rng.random(self.n, dtype=np.float32) < p.noise_hz * p.dt) * np.float32(p.noise_amp)
        for idx, amount in inject:
            _check_inject(idx, amount)
            np.add.at(self.v, idx, amount)  # accumulates on repeated indices; `+=` would not
        fired = np.flatnonzero(self.v >= p.threshold).astype(np.int64, copy=False)
        self.v[fired] = p.v_reset
        self.fired = fired
        self.steps += 1
        return fired

    def rates(self) -> float:
        """Fraction of neurons that fired on the last step."""
        return len(self.fired) / self.n


def main(argv: Sequence[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Benchmark the LIF step on the real connectome.")
    ap.add_argument("--steps", type=int, default=100)
    ap.add_argument("--backend", default="auto", choices=("auto", "numba", "numpy"))
    ap.add_argument("--data", type=Path, default=None)
    args = ap.parse_args(argv)

    brain = FlyBrain.load(args.data, backend=args.backend)
    for _ in range(5):
        brain.step()
    times, rates = [], []
    for _ in range(args.steps):
        t0 = time.perf_counter()
        brain.step()
        times.append(time.perf_counter() - t0)
        rates.append(brain.rates())
    median = float(np.median(times))
    print(f"backend={brain.backend} median={median * 1e3:.1f} ms/step "
          f"steps/s={1 / median:.1f} firing={np.mean(rates) * 100:.1f}%")


if __name__ == "__main__":
    main()
