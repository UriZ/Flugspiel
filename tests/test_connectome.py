import hashlib

import numpy as np
import pytest

from src.brain import connectome as c
from tests.conftest import make_meta


def test_nt_signs_inhibitory():
    assert c.nt_signs(["gaba", "glutamate", "histamine", "GABA", " gaba "]).tolist() == [-1.0] * 5


def test_nt_signs_excitatory():
    assert c.nt_signs(["acetylcholine", "dopamine", "serotonin", "octopamine"]).tolist() == [1.0] * 4


def test_nt_signs_unknown_defaults_excitatory():
    assert c.nt_signs(["unclear", "unknown", ""]).tolist() == [1.0] * 3


def test_nt_signs_dtype_shape():
    signs = c.nt_signs(np.array([["gaba", "x"], ["y", "z"]]))
    assert signs.dtype == np.float32 and signs.shape == (2, 2)


def test_build_weights_sign_from_presynaptic():
    # neuron 0 inhibitory, 1 excitatory; both project onto 2.
    W = c.build_weights(np.array([0, 1]), np.array([2, 2]), np.array([3.0, 1.0]),
                        np.array([-1.0, 1.0], np.float32), 3)
    assert W[2, 0] < 0 and W[2, 1] > 0


def test_build_weights_row_normalised():
    W = c.build_weights(np.array([0, 1, 2]), np.array([2, 2, 0]), np.array([3.0, 1.0, 7.0]),
                        np.array([-1.0, 1.0, 1.0], np.float32), 3)
    sums = np.abs(W).sum(axis=1).A1
    assert sums == pytest.approx([1.0, 0.0, 1.0])


def test_build_weights_isolated_neuron():
    W = c.build_weights(np.array([0]), np.array([1]), np.array([2.0]),
                        np.ones(3, np.float32), 3)
    assert W[2].nnz == 0 and np.isfinite(W.data).all()


def test_build_weights_duplicate_pairs_sum():
    dup = c.build_weights(np.array([0, 0, 1]), np.array([1, 1, 0]), np.array([1.0, 1.0, 5.0]),
                          np.ones(2, np.float32), 2)
    once = c.build_weights(np.array([0, 1]), np.array([1, 0]), np.array([2.0, 5.0]),
                           np.ones(2, np.float32), 2)
    assert (dup != once).nnz == 0


def test_build_weights_format():
    W = c.build_weights(np.array([0]), np.array([1]), np.array([2.0]), np.ones(2, np.float32), 2)
    assert W.format == "csc" and W.dtype == np.float32 and W.shape == (2, 2)


def test_load_missing_raises(tmp_path):
    with pytest.raises(c.ConnectomeError, match=r"weights\.npz.*python -m src\.brain\.connectome"):
        c.load(tmp_path)


def test_resolve_data_dir_env(tmp_path, monkeypatch):
    monkeypatch.setenv(c.ENV_DATA_DIR, str(tmp_path / "elsewhere"))
    assert c._resolve_data_dir() == tmp_path / "elsewhere"
    monkeypatch.delenv(c.ENV_DATA_DIR)
    assert c._resolve_data_dir().name == "data"


def test_resolve_data_dir_creates_nothing(tmp_path):
    """Resolving a path must not touch the filesystem — only download()/build() write."""
    assert c._resolve_data_dir(tmp_path / "nope") == tmp_path / "nope"
    assert not (tmp_path / "nope").exists()


def test_load_missing_creates_no_data_dir(tmp_path):
    with pytest.raises(c.ConnectomeError):
        c.load(tmp_path / "absent")
    assert not (tmp_path / "absent").exists()


def test_verify_rejects_wrong_size_and_hash(tmp_path):
    src = c.SOURCES[c.ANNOTATIONS]
    path = tmp_path / "f"
    path.write_bytes(b"short")
    with pytest.raises(c.ConnectomeError, match="bytes"):
        c._verify(path, src)
    path.write_bytes(b"x" * src.size)
    with pytest.raises(c.ConnectomeError, match="sha256"):
        c._verify(path, src)


def test_verify_returns_the_digest(tmp_path, monkeypatch):
    """The digest is returned, not only embedded in the exception, so callers need not re-hash."""
    path = tmp_path / "f"
    path.write_bytes(b"hello")
    digest = hashlib.sha256(b"hello").hexdigest()
    src = c.Source(url="", size=5, sha256=digest)
    assert c._verify(path, src) == digest
    path.write_bytes(b"x" * src.size)
    with pytest.raises(c.ConnectomeError, match="sha256"):
        c._verify(path, src)


def test_brainmeta_roundtrip(tmp_path):
    meta = make_meta(3, cell_type=["A", "", "LongTypeName"], side=["L", "R", ""])
    meta.save(tmp_path / "brain.npz")
    back = c.BrainMeta.from_npz(tmp_path / "brain.npz")
    assert back.n == 3
    for key in c.BrainMeta._KEYS:
        a, b = getattr(meta, key), getattr(back, key)
        assert a.dtype == b.dtype and a.shape == b.shape
        assert np.array_equal(a, b, equal_nan=a.dtype.kind == "f")


def test_brainmeta_missing_file_raises(tmp_path):
    with pytest.raises(c.ConnectomeError, match="not found"):
        c.BrainMeta.from_npz(tmp_path / "nope.npz")
