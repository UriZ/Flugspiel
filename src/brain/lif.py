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

    @property
    def decay(self) -> float:
        return math.exp(-self.dt / self.tau)


def _propagate_numpy(W: sparse.csc_matrix, fired: np.ndarray, n: int) -> np.ndarray:
    spikes = np.zeros(n, dtype=np.float32)
    spikes[fired] = 1.0
    return W @ spikes


if numba is not None:
    @numba.njit(nogil=True, parallel=True)  # cache=True warns "dynamic globals" — don't
    def _propagate_numba(indptr, indices, data, fired, n):
        """Sum the CSC columns of the fired neurons into a dense current vector.

        `fired` is split into one contiguous slice per thread, each accumulating into
        its own buffer, so no two threads write the same element.
        """
        threads = numba.get_num_threads()
        buf = np.zeros((threads, n), dtype=np.float32)
        k = len(fired)
        for t in numba.prange(threads):
            for m in range(k * t // threads, k * (t + 1) // threads):
                j = fired[m]
                for p in range(indptr[j], indptr[j + 1]):
                    buf[t, indices[p]] += data[p]
        out = np.zeros(n, dtype=np.float32)
        for i in numba.prange(n):
            acc = np.float32(0.0)
            for t in range(threads):
                acc += buf[t, i]
            out[i] = acc
        return out
else:  # pragma: no cover - depends on the install
    _propagate_numba = None


class FlyBrain:
    """A fly brain stepping at `params.dt`.

    Determinism: same seed + same backend + same params ⇒ identical spike trains.
    Across backends they diverge — the kernels sum the same weights in different orders
    (~1e-7 relative), which is enough to flip a neuron sitting on the threshold. Compare
    currents with a tolerance, never spike indices.
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
        self.W = sparse.csc_matrix(weights, dtype=np.float32)
        self.backend = "numba" if (backend != "numpy" and numba is not None) else "numpy"
        self._seed = seed
        self.reset(seed)
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
        """v ← 0, no fired neurons, step counter 0, RNG reseeded (None reuses the last seed)."""
        if seed is not None:
            self._seed = seed
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
        array falls out of its mapping without first de-duplicating it.
        """
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
