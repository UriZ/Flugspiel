import numpy as np
import pytest
from scipy import sparse

from src.brain.lif import FlyBrain, LIFParams, _propagate_numpy, numba
from tests.conftest import EXACT, make_brain, make_meta, random_weights

ZERO = np.zeros((1, 1), dtype=np.float32)


def test_decay_only():
    brain = make_brain(ZERO)
    brain.v[0] = 0.5
    for k in range(1, 6):
        brain.step()
        assert brain.v[0] == pytest.approx(0.5 * EXACT.decay ** k, rel=1e-5)


def test_subthreshold_tonic_never_fires():
    brain = make_brain(ZERO, params=LIFParams(noise_hz=0.0))
    for _ in range(500):
        assert len(brain.step()) == 0
    assert brain.v[0] == pytest.approx(0.14 / (1 - LIFParams().decay), abs=1e-3)


def test_suprathreshold_tonic_fires():
    brain = make_brain(ZERO, params=LIFParams(tonic=0.20, noise_hz=0.0))
    spikes = [len(brain.step()) for _ in range(200)]
    assert sum(spikes) > 10
    for _ in range(5):
        for _ in range(100):
            if len(brain.step()):
                break
        else:
            pytest.fail("no spike within 100 steps")
        assert brain.v[0] == 0.0


def test_threshold_is_inclusive():
    brain = make_brain(ZERO, params=LIFParams(gain=0.0, tonic=0.0, noise_hz=0.0))
    assert brain.step(inject=[(np.array([0]), 1.0)]).tolist() == [0]


def test_excitatory_propagation(tiny_brain):
    tiny_brain.fired = np.array([0], dtype=np.int64)
    tiny_brain.step()
    assert tiny_brain.v[1] == pytest.approx(0.5)  # w=0.5, EXACT.gain=1


def test_inhibitory_propagation(tiny_brain):
    tiny_brain.fired = np.array([0], dtype=np.int64)
    tiny_brain.step()
    assert tiny_brain.v[2] == pytest.approx(-0.5)


@pytest.mark.parametrize("gain, expected", [(0.0, 0.0), (0.5, 0.1), (3.0, 0.6)])
def test_gain_scales_the_synaptic_term(gain, expected):
    """Pins the magnitude of `gain * (W @ spikes)`, not just its presence and sign.

    The expectations are literals. Deriving them from `params.gain` — as the two tests
    above used to — makes the assertion self-referential, and the only other test that
    varied gain used the multiplicative identity, so deleting the factor outright left
    the suite green (#9).
    """
    W = np.zeros((2, 2), dtype=np.float32)
    W[1, 0] = 0.2
    brain = make_brain(W, make_meta(2), params=LIFParams(gain=gain, tonic=0.0, noise_hz=0.0))
    brain.fired = np.array([0], dtype=np.int64)
    brain.step()
    assert brain.v[1] == pytest.approx(expected)


def test_default_gain_matches_the_documented_calibration():
    """gain=3.0 is calibrated in LIFParams' docstring against rows normalised to |w| sum 1:
    a neuron whose whole input population fires receives ~3x threshold. Here the input row
    sums to 0.2, so the literal 0.6 pins the default itself — retuning it fails here.
    """
    W = np.zeros((5, 5), dtype=np.float32)
    W[4, :4] = 0.05
    brain = make_brain(W, make_meta(5), params=LIFParams(tonic=0.0, noise_hz=0.0))
    brain.fired = np.arange(4, dtype=np.int64)
    brain.step()
    assert brain.v[4] == pytest.approx(0.6)


def test_no_input_no_current(tiny_brain):
    current = tiny_brain._synaptic_input(np.empty(0, dtype=np.int64))
    assert not current.any()


def test_determinism_same_seed(random_brain):
    a = make_brain(random_brain.toarray(), seed=3)
    b = make_brain(random_brain.toarray(), seed=3)
    for _ in range(50):
        assert np.array_equal(a.step(), b.step())


def test_reset_restores_trajectory(random_brain):
    brain = make_brain(random_brain.toarray(), params=LIFParams(), seed=11)
    first = [brain.step().tolist() for _ in range(20)]
    brain.reset(11)
    assert [brain.step().tolist() for _ in range(20)] == first
    assert brain.steps == 20


def test_different_seed_differs(random_brain):
    a = make_brain(random_brain.toarray(), params=LIFParams(), seed=1)
    b = make_brain(random_brain.toarray(), params=LIFParams(), seed=2)
    assert [a.step().tolist() for _ in range(20)] != [b.step().tolist() for _ in range(20)]


def test_stimulate(tiny_brain):
    tiny_brain.stimulate(np.array([0, 2]), 0.3)
    assert tiny_brain.v.tolist() == pytest.approx([0.3, 0.0, 0.3])


def test_inject_applied_this_step(tiny_brain):
    assert tiny_brain.step(inject=[(np.array([1, 2]), 2.0)]).tolist() == [1, 2]


def test_noise_is_added_before_the_threshold_check():
    """Pins the noise term above threshold/reset in the update order (spec 4.3).

    noise_hz * dt == 1.0 makes `rng.random() < p` always true, so the 0.22 kick is
    deterministic and the only drive. Applied before the threshold check it fires the
    neuron and leaves v at the reset value; applied after, v carries 1.0 and nothing fires.
    """
    brain = make_brain(ZERO, params=LIFParams(gain=0.0, tonic=0.0, noise_hz=50.0, noise_amp=1.0))
    assert brain.step().tolist() == [0]
    assert brain.v[0] == 0.0


def test_cells_lookup(tiny_brain):
    assert tiny_brain.cells(["B"]).tolist() == [1, 2]
    assert tiny_brain.cells(["B"], side="L").tolist() == [2]
    assert tiny_brain.cells(["nope"]).tolist() == []


def test_cells_rejects_a_bare_string(tiny_brain):
    # list("B") would silently iterate the characters; on real types ("DNp01") that
    # matches the wrong neurons or none at all.
    with pytest.raises(TypeError, match="not the string"):
        tiny_brain.cells("B")


def test_stimulate_accumulates_duplicate_indices(tiny_brain):
    tiny_brain.stimulate(np.array([1, 1, 1]), 0.3)
    assert tiny_brain.v[1] == pytest.approx(0.9)


def test_inject_accumulates_duplicate_indices(tiny_brain):
    brain = make_brain(ZERO, params=LIFParams(gain=0.0, tonic=0.0, noise_hz=0.0))
    brain.step(inject=[(np.array([0, 0]), 0.3)])
    assert brain.v[0] == pytest.approx(0.6)


@pytest.mark.skipif(numba is None, reason="numba not installed")
def test_backend_equivalence(random_brain):
    fired = np.arange(0, 200, 3, dtype=np.int64)
    fast = make_brain(random_brain.toarray(), backend="numba")._synaptic_input(fired)
    slow = _propagate_numpy(random_brain, fired, 200)
    assert np.allclose(fast, slow, atol=1e-6)


@pytest.mark.skipif(numba is None, reason="numba not installed")
def test_backend_equivalence_under_thread_contention():
    """The 200-neuron fixture above is too small to catch a broken parallel reduction.

    Sharing one accumulator between threads (`buf[0, ...]` instead of `buf[t, ...]`) is a
    lost-update race, and it leaves the test above green: 67 fired columns over ~2,000
    nonzeros, so the threads rarely collide. At this size that mutation lands 0.058-0.199
    off the numpy kernel — measured over 20 runs each at 2, 4 and 16 threads, never once
    inside the tolerance — against a 1.2e-7 baseline for the correct kernel (#10).
    """
    n = 2000
    W = random_weights(n, 0.02, seed=5)
    fired = np.arange(0, n, 2, dtype=np.int64)
    fast = make_brain(W, make_meta(n), backend="numba")._synaptic_input(fired)
    slow = _propagate_numpy(W, fired, n)
    assert np.allclose(fast, slow, atol=1e-6)


def test_bad_backend_raises():
    with pytest.raises(ValueError):
        make_brain(ZERO, backend="gpu")


def test_shape_mismatch_raises():
    with pytest.raises(ValueError):
        FlyBrain(sparse.csc_matrix((5, 5), dtype=np.float32), make_meta(3))


def test_steps_counter(tiny_brain):
    for i in range(3):
        assert tiny_brain.steps == i
        tiny_brain.step()
    tiny_brain.reset()
    assert tiny_brain.steps == 0
