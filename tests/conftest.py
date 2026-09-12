import numpy as np
import pytest
from scipy import sparse

from src.brain.connectome import BrainMeta, ConnectomeError
from src.brain.lif import FlyBrain, LIFParams

EXACT = LIFParams(gain=1.0, tonic=0.0, noise_hz=0.0)


def make_meta(n, cell_type=None, side=None, nt_sign=None):
    """A BrainMeta with plausible filler for everything the tests don't care about."""
    return BrainMeta(
        ids=np.arange(1000, 1000 + n, dtype=np.int64),
        cell_type=np.asarray(cell_type if cell_type is not None else ["X"] * n, dtype=str),
        side=np.asarray(side if side is not None else ["L"] * n, dtype="<U1"),
        superclass=np.asarray(["central_brain"] * n, dtype=str),
        nt=np.asarray(["acetylcholine"] * n, dtype=str),
        nt_sign=np.asarray(nt_sign if nt_sign is not None else [1.0] * n, dtype=np.float32),
        position=np.zeros((n, 3), dtype=np.float32),
        ol_hex=np.full((n, 2), np.nan, dtype=np.float32),
    )


def make_brain(W, meta=None, params=EXACT, **kw):
    W = sparse.csc_matrix(W, dtype=np.float32)  # accepts dense or sparse
    return FlyBrain(W, meta or make_meta(W.shape[0]), params, **kw)


def random_weights(n, density, seed=7):
    """Signed and row-normalised like the real matrix."""
    rng = np.random.default_rng(seed)
    W = sparse.random(n, n, density=density, format="csc", dtype=np.float32, random_state=rng)
    W.data = (W.data * 2 - 1).astype(np.float32)
    rows = np.bincount(W.indices, weights=np.abs(W.data), minlength=n)
    W.data /= np.maximum(rows[W.indices], 1e-6).astype(np.float32)
    return W


@pytest.fixture
def tiny_brain():
    """3 neurons: 0 excites 1 (+0.5) and inhibits 2 (-0.5). No tonic, no noise, gain 1."""
    W = np.zeros((3, 3), dtype=np.float32)
    W[1, 0] = 0.5
    W[2, 0] = -0.5
    return make_brain(W, make_meta(3, cell_type=["A", "B", "B"], side=["L", "R", "L"]))


@pytest.fixture
def random_brain():
    """200 neurons, ~5% connectivity, signed and row-normalised like the real matrix."""
    return random_weights(200, 0.05)


@pytest.fixture
def real_brain():
    try:
        return FlyBrain.load()
    except ConnectomeError as exc:
        pytest.skip(f"no built connectome ({exc}); run: python -m src.brain.connectome")
