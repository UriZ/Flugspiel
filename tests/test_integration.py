"""Checks against the real MaleCNS v1.0 build. Skipped when the data is not present."""

import time

import numpy as np
import pytest

from src.brain.connectome import PHOTORECEPTOR_TYPES

pytestmark = pytest.mark.realdata


def test_shapes(real_brain):
    W = real_brain.W
    assert real_brain.n == 166_700
    assert W.nnz == 25_582_938
    assert W.shape == (166_700, 166_700) and W.dtype == np.float32 and W.format == "csc"


def test_nt_counts(real_brain):
    nt, sign = real_brain.meta.nt, real_brain.meta.nt_sign
    assert (sign < 0).sum() == 59_262
    assert (sign > 0).sum() == 107_438
    assert np.isin(nt, ("unclear", "unknown")).sum() == 3_177


def test_photoreceptors_are_histamine(real_brain):
    """Histamine photoreceptors are ground truth: catches a pre/post sign inversion."""
    photo = np.isin(real_brain.meta.cell_type, PHOTORECEPTOR_TYPES)
    assert photo.sum() == 6_006
    assert (real_brain.meta.nt[photo] == "histamine").all()
    assert (real_brain.meta.nt_sign[photo] == -1).all()


def test_row_normalisation(real_brain):
    W = real_brain.W
    rows = np.bincount(W.indices, weights=np.abs(W.data), minlength=real_brain.n)
    assert rows.max() <= 1 + 1e-5


def test_throughput(real_brain):
    for _ in range(5):
        real_brain.step()
    times = []
    for _ in range(100):
        t0 = time.perf_counter()
        real_brain.step()
        times.append(time.perf_counter() - t0)
    median = float(np.median(times))
    assert median <= 0.100, f"{median * 1e3:.1f} ms/step is under 10 steps/s"


def test_activity_stable(real_brain):
    """No die-out, no runaway.

    Deviates from the spec's "300 steps, every step in (0.005, 0.20)": from v=0 the
    network needs ~15 steps to climb to threshold, so the first steps are legitimately
    at 0. The 20 warm-up steps cover that ramp, which is asserted separately.
    """
    real_brain.reset()
    warmup = [real_brain.step() is not None and real_brain.rates() for _ in range(20)]
    assert warmup[0] == 0.0 and warmup[-1] > 0.005, "network never ramps up"
    rates = []
    for _ in range(300):
        real_brain.step()
        rates.append(real_brain.rates())
    assert 0.005 < min(rates) and max(rates) < 0.20
