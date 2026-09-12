import hashlib
import os
import subprocess
import sys
from pathlib import Path

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


# --------------------------------------------------------------- #15 crafted weights.npz


def write_csc_npz(path, n, indices, data=None):
    """Write a weights.npz by hand, bypassing the checks `sparse.save_npz` would apply.

    Every nonzero lands in column 0. This is the shape of a hostile artifact: valid
    indptr (so `check_format(full_check=False)` passes) with out-of-range `indices`.
    """
    data = np.arange(1, len(indices) + 1, dtype=np.float32) if data is None else data
    indptr = np.zeros(n + 1, dtype=np.int32)
    indptr[1:] = len(data)
    np.savez(path, format=np.array(b"csc"), shape=np.array([n, n]), data=data,
             indices=np.asarray(indices, dtype=np.int32), indptr=indptr,
             _is_array=np.array(False))


def crafted_brain(tmp_path, n, indices):
    write_csc_npz(tmp_path / "weights.npz", n, indices)
    make_meta(n).save(tmp_path / "brain.npz")
    return tmp_path


@pytest.mark.parametrize("indices", [[0, 5_000_000], [2_000_000_000], [8], [5_000_000]])
def test_load_rejects_out_of_range_indices(tmp_path, indices):
    """Out-of-range CSC row indices must die at load(), never reach a kernel (#15).

    `sparse.load_npz` and `csc_matrix()` both run check_format(full_check=False), which
    skips the index-bounds check, so nothing before this rejected them.
    """
    with pytest.raises(c.ConnectomeError, match="corrupt.*indices must be"):
        c.load(crafted_brain(tmp_path, 8, indices))


@pytest.mark.parametrize("indices", [[-1], [-1_000_000_000]])
def test_load_rejects_negative_indices(tmp_path, indices):
    """Negative indices write *before* the buffer — same primitive, opposite direction."""
    with pytest.raises(c.ConnectomeError, match="corrupt.*indices must be"):
        c.load(crafted_brain(tmp_path, 8, indices))


def test_load_accepts_in_range_indices(tmp_path):
    """The bounds check must not reject a valid matrix (guards over-rejection)."""
    W, meta = c.load(crafted_brain(tmp_path, 8, [0, 7]))
    assert W.shape == (8, 8) and W.nnz == 2 and meta.n == 8


def test_crafted_weights_never_reach_the_kernel(tmp_path):
    """Memory-safety proof: the full load->step chain must exit 1, not SIGSEGV (#15).

    Runs in a subprocess because the failure mode under test is a segfault, which would
    take the pytest process down with it rather than failing a test. Before the
    check_format call in load(), this exits -11/139 on both backends.
    """
    crafted_brain(tmp_path, 8, [5_000_000])
    script = tmp_path / "step.py"
    script.write_text(
        "import sys\n"
        "from src.brain import connectome as c\n"
        "from src.brain.lif import FlyBrain, LIFParams\n"
        "import numpy as np\n"
        f"W, meta = c.load({str(tmp_path)!r})\n"
        "b = FlyBrain(W, meta, LIFParams(gain=1.0, tonic=0.0, noise_hz=0.0), backend='numpy')\n"
        "b._synaptic_input(np.array([0], dtype=np.int64))\n"
        "print('REACHED THE KERNEL')\n"
    )
    root = Path(__file__).resolve().parents[1]
    # pytest.ini's `pythonpath = .` configures the in-process sys.path only; a spawned
    # interpreter needs PYTHONPATH to find `src`.
    proc = subprocess.run([sys.executable, str(script)], capture_output=True, text=True,
                          cwd=str(root), env={**os.environ, "PYTHONPATH": str(root)})
    assert proc.returncode == 1, f"expected ConnectomeError exit 1, got {proc.returncode}"
    assert proc.returncode not in (-11, 139), "SIGSEGV: out-of-bounds write reached the kernel"
    assert "ConnectomeError" in proc.stderr and "REACHED THE KERNEL" not in proc.stdout


# --------------------------------------------------------------- #15 brain.npz metadata


def test_brainmeta_rejects_implausible_n(tmp_path):
    """n sizes a per-step PARTITIONS x n buffer in the numba kernel — it needs a ceiling."""
    meta = make_meta(2)
    arrays = {k: getattr(meta, k) for k in c.BrainMeta._KEYS}
    arrays["ids"] = np.arange(c.BrainMeta._MAX_NEURONS + 1, dtype=np.int64)
    with pytest.raises(c.ConnectomeError, match="implausible neuron count"):
        c.BrainMeta._validate(tmp_path / "brain.npz", arrays)


def test_brainmeta_rejects_empty(tmp_path):
    arrays = {k: getattr(make_meta(0), k) for k in c.BrainMeta._KEYS}
    with pytest.raises(c.ConnectomeError, match="implausible neuron count 0"):
        c.BrainMeta._validate(tmp_path / "brain.npz", arrays)


@pytest.mark.parametrize("key,shape", [
    ("position", (3, 2)), ("ol_hex", (3, 3)), ("cell_type", (2,)), ("nt_sign", (3, 1)),
])
def test_brainmeta_rejects_mismatched_array_shapes(tmp_path, key, shape):
    """Documented shapes are (n,), (n,3) and (n,2); nothing downstream re-checks them."""
    arrays = {k: getattr(make_meta(3), k) for k in c.BrainMeta._KEYS}
    arrays[key] = np.zeros(shape, dtype=arrays[key].dtype)
    with pytest.raises(c.ConnectomeError, match=f"{key} has shape"):
        c.BrainMeta._validate(tmp_path / "brain.npz", arrays)


def test_brainmeta_rejects_wrong_dtype(tmp_path):
    arrays = {k: getattr(make_meta(3), k) for k in c.BrainMeta._KEYS}
    arrays["nt_sign"] = np.ones(3, dtype=np.int64)
    with pytest.raises(c.ConnectomeError, match="nt_sign has dtype"):
        c.BrainMeta._validate(tmp_path / "brain.npz", arrays)


def test_brainmeta_from_npz_rejects_a_tampered_file(tmp_path):
    """The validation must run on the real from_npz path, not only when called directly."""
    meta = make_meta(3)
    arrays = {k: getattr(meta, k) for k in c.BrainMeta._KEYS}
    arrays["position"] = np.zeros((3, 2), dtype=np.float32)  # documented (n, 3)
    np.savez_compressed(tmp_path / "brain.npz", **arrays)
    with pytest.raises(c.ConnectomeError, match="position has shape"):
        c.BrainMeta.from_npz(tmp_path / "brain.npz")
