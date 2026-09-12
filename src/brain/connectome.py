"""MaleCNS v1.0 connectome → signed, input-normalised sparse weight matrix.

Downloads the three flat-connectome Feather files published by Janelia, keeps the
166,700 bodies that carry a `superclass` annotation, and assembles

    W[post, pre] = weight * nt_sign[pre] / sum_over_pre |weight * nt_sign[pre]|

as a float32 CSC matrix (column j = all outgoing connections of neuron j, which is the
access pattern both LIF kernels use).

Never fabricates data: every failure path raises `ConnectomeError`. There is no mock
brain, no random matrix, no zero-filled fallback.

CLI:  python -m src.brain.connectome [--data DIR] [--force]
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, Sequence

import numpy as np
from scipy import sparse

BUCKET = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
ENV_DATA_DIR = "FLUGSPIEL_DATA"

# gaba/glutamate/histamine are the fly's fast inhibitory transmitters; histamine in
# particular is what makes photoreceptors sign-inverting.
INHIBITORY_NT = frozenset({"gaba", "glutamate", "histamine"})


class Source(NamedTuple):
    url: str
    size: int
    sha256: str


ANNOTATIONS = "body-annotations-male-cns-v1.0-minconf-0.5.feather"
NEUROTRANSMITTERS = "body-neurotransmitters-male-cns-v1.0.feather"
WEIGHTS = "connectome-weights-male-cns-v1.0-minconf-0.5.feather"

SOURCES: dict[str, Source] = {
    ANNOTATIONS: Source(
        f"{BUCKET}/{ANNOTATIONS}", 14_483_314,
        "2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2"),
    NEUROTRANSMITTERS: Source(
        f"{BUCKET}/{NEUROTRANSMITTERS}", 43_282_834,
        "95c9289220663abeb3409f3ad9e5a7f8a53f8093f5139d15502cd08da8879621"),
    WEIGHTS: Source(
        f"{BUCKET}/{WEIGHTS}", 1_051_241_946,
        "e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1"),
}

PHOTORECEPTOR_TYPES = ("R1-6", "R7", "R8")
_SIDES = ("L", "R", "M")
_CHUNK = 8 << 20
_BUILD_CMD = "python -m src.brain.connectome"


class ConnectomeError(RuntimeError):
    """Missing, corrupt or inconsistent connectome data."""


def _resolve_data_dir(data_dir: Path | None = None) -> Path:
    if data_dir is None:
        env = os.environ.get(ENV_DATA_DIR)
        data_dir = Path(env) if env else Path(__file__).resolve().parents[2] / "data"
    return Path(data_dir)  # deliberately not created: only download()/build() write here


# --------------------------------------------------------------------------- metadata


@dataclass(frozen=True)
class BrainMeta:
    """Per-neuron metadata. Index i ↔ body `ids[i]`; `ids` is strictly ascending.

    That ordering is the contract every downstream module depends on: both axes of W,
    every array here, and `np.searchsorted(ids, body_id)` all agree on it.

    On `ol_hex` and photoreceptor azimuth (for the encoder, #3): the annotations assign
    hex column coordinates to 23,720 neurons but to **none** of the 6,006 photoreceptors,
    so azimuth is not a direct lookup. It is derivable from what is stored here:

        photoreceptor -> its hex-assigned postsynaptic partners in W
                      -> modal (assignedOlHex1, assignedOlHex2) of those partners
                      -> azimuth

    The hex-assigned types are exactly the columnar cells the photoreceptors synapse
    onto: L1/L2/L3/L5/C2/C3/T1 in the lamina for R1-6, and Tm1/Tm2/Tm4/Tm9/Tm20/Mi1/
    Mi4/Mi9 in the medulla for R7/R8. R7 is the hard case — its principal target Dm8
    carries no hex, so the vote has to lean on its weaker Tm/Mi partners. If the modal
    vote turns out noisy, the optic-column .xlsx from flyconnectome/2025malecns (dropped
    from this issue as a 4th data source) lists R7/R8/L1 bodies directly and would cover
    2,628 of the 6,006 photoreceptors; the other 3,377 (R1-6) need the inference either
    way. Re-adding it in #3 is additive, not a rework of this module.
    """

    ids: np.ndarray         # int64   (n,)
    cell_type: np.ndarray   # <U      (n,)   flywireType, else type, else ""
    side: np.ndarray        # <U1     (n,)   L | R | M | ""
    superclass: np.ndarray  # <U      (n,)   never ""
    nt: np.ndarray          # <U      (n,)   consensus_nt, "unknown" if missing
    nt_sign: np.ndarray     # float32 (n,)   -1.0 | +1.0
    position: np.ndarray    # float32 (n,3)  soma (else soma-tract) XYZ, NaN if unknown
    ol_hex: np.ndarray      # float32 (n,2)  assignedOlHex1/2, NaN if unassigned

    _KEYS = ("ids", "cell_type", "side", "superclass", "nt", "nt_sign", "position", "ol_hex")

    # `n` bounds every downstream allocation — the numba kernel allocates a
    # PARTITIONS x n float32 buffer *per step*, so an unvalidated n out of a crafted
    # brain.npz is a memory-exhaustion knob (n = 10**9 asks for 64 GB/step). The real
    # connectome is 166,700; 5M admits a larger future dataset but not an absurd one.
    _MAX_NEURONS = 5_000_000
    _SHAPES = {"position": 3, "ol_hex": 2}  # (n, k); every other array is (n,)
    _DTYPE_KINDS = {"ids": "i", "nt_sign": "f", "position": "f", "ol_hex": "f"}

    @property
    def n(self) -> int:
        return len(self.ids)

    def save(self, path: Path) -> None:
        np.savez_compressed(path, **{k: getattr(self, k) for k in self._KEYS})

    @classmethod
    def from_npz(cls, path: Path) -> "BrainMeta":
        if not Path(path).exists():
            raise ConnectomeError(f"{path} not found; run: {_BUILD_CMD}")
        try:
            with np.load(path, allow_pickle=False) as z:
                missing = [k for k in cls._KEYS if k not in z]
                if missing:
                    raise ConnectomeError(f"{path} is missing keys {missing}; delete it and run: {_BUILD_CMD}")
                arrays = {k: z[k] for k in cls._KEYS}
        except ConnectomeError:
            raise
        except Exception as exc:  # corrupt npz
            raise ConnectomeError(f"{path} is unreadable ({exc}); delete it and run: {_BUILD_CMD}") from exc
        cls._validate(Path(path), arrays)
        return cls(**arrays)

    @classmethod
    def _validate(cls, path: Path, arrays: dict[str, np.ndarray]) -> None:
        """Reject a brain.npz whose arrays disagree with each other or with `n`.

        Nothing downstream re-checks this: `load()` only compares W.shape against
        `meta.n`, and both LIF kernels index by `n` without bounds checking (#15).
        """
        bad = f"delete it and run: {_BUILD_CMD}"
        ids = arrays["ids"]
        if ids.ndim != 1:
            raise ConnectomeError(f"{path}: ids must be 1-D, got shape {ids.shape}; {bad}")
        n = len(ids)
        if not 0 < n <= cls._MAX_NEURONS:
            raise ConnectomeError(
                f"{path}: implausible neuron count {n} (expected 1..{cls._MAX_NEURONS}); {bad}")
        for key, arr in arrays.items():
            want = (n, cls._SHAPES[key]) if key in cls._SHAPES else (n,)
            if arr.shape != want:
                raise ConnectomeError(f"{path}: {key} has shape {arr.shape}, expected {want}; {bad}")
            kind = cls._DTYPE_KINDS.get(key)
            if kind is not None and arr.dtype.kind != kind:
                raise ConnectomeError(
                    f"{path}: {key} has dtype {arr.dtype}, expected kind {kind!r}; {bad}")


# --------------------------------------------------------------------------- pure helpers


def nt_signs(nt: np.ndarray | Sequence[str]) -> np.ndarray:
    """Map neurotransmitter names to synaptic signs (-1 inhibitory, +1 excitatory).

    Exact match on the lower-cased, stripped name against INHIBITORY_NT. Everything
    else — acetylcholine, dopamine, serotonin, octopamine, "unclear", "unknown", "" —
    is +1.

    Why unknown defaults to excitatory: acetylcholine is 103,720 of 166,700 labelled
    neurons (62%) and is the fly CNS's default fast excitatory transmitter, so +1 is
    the maximum-likelihood assignment for an unlabelled body. It affects 3,177 neurons
    (1.9%: 2,999 "unclear" + 178 missing), and `BrainMeta.nt` stores the raw label
    verbatim, so the choice is reversible by any downstream module that disagrees.
    """
    names = np.asarray(nt, dtype=str)
    lowered = np.char.strip(np.char.lower(names))
    return np.where(np.isin(lowered, tuple(INHIBITORY_NT)), -1.0, 1.0).astype(np.float32)


def build_weights(pre: np.ndarray, post: np.ndarray, weight: np.ndarray,
                  sign: np.ndarray, n: int) -> sparse.csc_matrix:
    """Assemble the signed, input-normalised CSC matrix W[post, pre]. Pure, no I/O.

    Duplicate (pre, post) pairs are summed (COO semantics) before normalisation.

    Autapses are **kept**. The real data has 101 of them (max normalised |w| 0.282); at
    gain 3.0 that is 0.846 of self-drive which, with tonic 0.14, reaches 0.986 against
    the 1.0 threshold — a margin of 0.014 that a single noise event (0.22) clears. That
    is still not a latch: the self-drive only lands on the step *after* the spike, by
    which point v has been reset to 0, and from there the trajectory decays to
    v∞ = 0.772. Dropping them would be an edit to the connectome the data does not ask for.
    """
    signed = np.asarray(weight, dtype=np.float32) * np.asarray(sign, dtype=np.float32)[pre]
    W = sparse.coo_matrix((signed, (post, pre)), shape=(n, n), dtype=np.float32).tocsc()
    # CSC: `indices` holds the row (postsynaptic) index of each nonzero.
    incoming = np.bincount(W.indices, weights=np.abs(W.data), minlength=n)
    # Raw weights are integers >= 1, so incoming >= 1 wherever there is any input; the
    # clamp exists only to avoid 0/0 for neurons with no inputs at all (370 in the real data).
    W.data /= np.maximum(incoming[W.indices], 1.0).astype(np.float32)
    return W


# --------------------------------------------------------------------------- download


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify(path: Path, src: Source) -> str:
    """Return `path`'s sha256, or raise ConnectomeError if size/hash miss the pinned values."""
    size = path.stat().st_size
    if size != src.size:
        raise ConnectomeError(f"{path.name}: expected {src.size} bytes, got {size}")
    digest = _sha256(path)
    if digest != src.sha256:
        raise ConnectomeError(f"{path.name}: expected sha256 {src.sha256}, got {digest}")
    return digest


def _stream(src: Source, part: Path, name: str) -> None:
    """Download `src` into `part`, resuming an existing partial file via Range."""
    start = part.stat().st_size if part.exists() else 0
    if start >= src.size:
        part.unlink()
        start = 0
    req = urllib.request.Request(src.url)
    if start:
        req.add_header("Range", f"bytes={start}-")
    with urllib.request.urlopen(req, timeout=60) as resp:
        if start and resp.status != 206:  # server ignored the range — restart
            start = 0
        got = start
        mark = 0
        with open(part, "ab" if start else "wb") as f:
            while chunk := resp.read(_CHUNK):
                f.write(chunk)
                got += len(chunk)
                if got - mark >= src.size // 50:
                    mark = got
                    print(f"\r  {name} {got >> 20}/{src.size >> 20} MB", end="", flush=True)
    print(f"\r  {name} {got >> 20}/{src.size >> 20} MB")


def download(data_dir: Path | None = None, *, force: bool = False) -> Path:
    """Fetch the three source files into <data_dir>/raw, resuming partial transfers.

    Returns the raw directory. `force=True` re-downloads even a file that verifies.
    Raises ConnectomeError if a file cannot be verified.
    """
    raw = _resolve_data_dir(data_dir) / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    for name, src in SOURCES.items():
        target, part = raw / name, raw / (name + ".part")
        if target.exists() and not force:
            try:
                _verify(target, src)
                print(f"  {name} ok")
                continue
            except ConnectomeError as exc:
                print(f"  {name}: re-downloading ({exc})")
                target.unlink()
        last = ""
        for _ in range(3):
            _stream(src, part, name)
            got = part.stat().st_size
            try:
                _verify(part, src)
            except ConnectomeError as exc:
                last = str(exc)
                # A transfer that delivered exactly the expected byte count but hashes
                # differently was not damaged in flight, so re-downloading 1.05 GB reaches
                # the same conclusion — stop now. `exc` already carries the computed digest,
                # so there is no second hash of the file here.
                if got == src.size:
                    part.unlink(missing_ok=True)
                    raise ConnectomeError(
                        f"{exc}, and the transfer delivered exactly the expected {src.size} bytes. "
                        "Either upstream re-published this file, or a stale .part from an earlier run "
                        "was resumed via Range — the two are indistinguishable from here. The partial "
                        "file has been removed, so retry once; only if that reproduces should SOURCES "
                        "be updated, and then deliberately (confirm it is still MaleCNS v1.0)."
                    ) from exc
                part.unlink(missing_ok=True)
                continue
            os.replace(part, target)  # atomic: a target file is always complete
            break
        else:
            raise ConnectomeError(f"{name}: failed after 3 attempts — {last}")
    return raw


# --------------------------------------------------------------------------- build


def _require(raw: Path, name: str) -> Path:
    """Return the path to a raw source file, re-checked against its pinned size+sha256.

    Existence alone is not enough. `download()` verifies before `os.replace`, so a file
    it completed is a verified file — but `build()` is a documented public entry point
    and can be called without `download()`, against a hand-populated raw/, a shared
    cache, a Docker volume or a CI artifact. Whatever sits there otherwise goes straight
    into `feather.read_table` and `pa.ipc.open_file` (#19). That is the second half of
    the #16 chain: an unverified Arrow IPC file parsed by a pyarrow version carrying an
    arbitrary-code-execution advisory on IPC reads. Fixing either link breaks the chain;
    both are cheap.

    Cost: three sha256 passes over ~1.1 GB (~2-3 s) on every build(), including the
    main() path where download() just hashed the same bytes. That is against a build
    already taking minutes, so the duplicate is not worth the coupling of threading
    digests out of download(). Deliberately has no `verify=False` escape hatch — a kwarg
    that switches off a security check is a footgun, and nothing needs one.
    """
    path = raw / name
    if not path.exists():
        raise ConnectomeError(f"{path} not found; run: {_BUILD_CMD}")
    _verify(path, SOURCES[name])
    return path


def _as_str(series) -> np.ndarray:
    return np.asarray(series.fillna(""), dtype=str)


def _positions(soma, tract, n: int) -> np.ndarray:
    """soma XYZ, falling back to the soma-tract point, NaN where neither is a triple."""
    pos = np.full((n, 3), np.nan, dtype=np.float32)
    for i, (a, b) in enumerate(zip(soma, tract)):
        for v in (a, b):
            if v is not None and np.ndim(v) == 1 and len(v) == 3:
                pos[i] = v
                break
    return pos


def _edges(path: Path, ids: np.ndarray):
    """Stream the 151.9M-row edge table, keeping edges whose endpoints are both neurons.

    `feather.read_table` materialises the whole table (4.6 GB peak); the record-batch
    reader does the same job at 1.5 GB.
    """
    import pyarrow as pa

    n = len(ids)
    pres, posts, ws = [], [], []
    with pa.memory_map(str(path), "rb") as src:
        reader = pa.ipc.open_file(src)
        for i in range(reader.num_record_batches):
            batch = reader.get_batch(i)
            body_pre = batch.column("body_pre").to_numpy()
            body_post = batch.column("body_post").to_numpy()
            pre = np.searchsorted(ids, body_pre).clip(max=n - 1)
            post = np.searchsorted(ids, body_post).clip(max=n - 1)
            ok = (ids[pre] == body_pre) & (ids[post] == body_post)
            pres.append(pre[ok].astype(np.int32))
            posts.append(post[ok].astype(np.int32))
            ws.append(batch.column("weight").to_numpy()[ok].astype(np.float32))
    return np.concatenate(pres), np.concatenate(posts), np.concatenate(ws)


def _sanity(W: sparse.csc_matrix, meta: BrainMeta) -> None:
    n = meta.n
    row_abs = np.bincount(W.indices, weights=np.abs(W.data), minlength=n)
    checks = {
        f"too few neurons ({n})": n >= 100_000,
        f"too few connections ({W.nnz})": W.nnz >= 10_000_000,
        f"W.shape {W.shape} != ({n}, {n})": W.shape == (n, n),
        "W contains non-finite weights": bool(np.isfinite(W.data).all()),
        f"row |w| sum exceeds 1 ({row_abs.max()})": row_abs.max() <= 1 + 1e-5,
        "nt_sign has only one sign": bool((meta.nt_sign < 0).any() and (meta.nt_sign > 0).any()),
        "ids are not strictly increasing": bool(np.all(np.diff(meta.ids) > 0)),
    }
    bad = [msg for msg, ok in checks.items() if not ok]
    if bad:
        raise ConnectomeError("connectome sanity checks failed: " + "; ".join(bad))


def build(data_dir: Path | None = None) -> dict:
    """Build weights.npz, brain.npz and brain.json from <data_dir>/raw.

    Returns the summary dict written to brain.json. Raises ConnectomeError if a raw
    file is missing or a sanity check fails — nothing is written in that case.
    """
    from pyarrow import feather

    data = _resolve_data_dir(data_dir)
    data.mkdir(parents=True, exist_ok=True)
    raw = data / "raw"

    ann = feather.read_table(_require(raw, ANNOTATIONS)).to_pandas()
    ann = ann[ann["superclass"].notna() & (ann["superclass"] != "")]
    ann = ann.drop_duplicates("bodyId").sort_values("bodyId")
    ids = ann["bodyId"].to_numpy(np.int64)
    n = len(ids)

    soma, root = _as_str(ann["somaSide"]), _as_str(ann["rootSide"])
    side = np.where(np.isin(soma, _SIDES), soma,
                    np.where(np.isin(root, _SIDES), root, "")).astype("<U1")

    nt_tab = feather.read_table(_require(raw, NEUROTRANSMITTERS),
                                columns=["body", "consensus_nt"]).to_pandas()
    nt = np.asarray(nt_tab.set_index("body")["consensus_nt"].reindex(ids).fillna("unknown"), dtype=str)

    meta = BrainMeta(
        ids=ids,
        cell_type=_as_str(ann["flywireType"].fillna(ann["type"])),
        side=side,
        superclass=_as_str(ann["superclass"]),
        nt=nt,
        nt_sign=nt_signs(nt),
        position=_positions(ann["somaLocation"], ann["tosomaLocation"], n),
        ol_hex=ann[["assignedOlHex1", "assignedOlHex2"]].to_numpy(np.float32),
    )

    pre, post, weight = _edges(_require(raw, WEIGHTS), ids)
    W = build_weights(pre, post, weight, meta.nt_sign, n)
    _sanity(W, meta)

    summary = {
        "neurons": n,
        "connections": int(W.nnz),
        "inhibitory": int((meta.nt_sign < 0).sum()),
        "excitatory": int((meta.nt_sign > 0).sum()),
        "unknown_nt": int(np.isin(np.char.lower(meta.nt), ("unclear", "unknown")).sum()),
        "photoreceptors": int(np.isin(meta.cell_type, PHOTORECEPTOR_TYPES).sum()),
    }
    # Uncompressed: 205 MB and a 0.29 s load, vs 139 MB / 16 s write / 0.83 s load.
    # Startup latency matters more than disk here; brain.npz is tiny so it is compressed.
    sparse.save_npz(data / "weights.npz", W, compressed=False)
    meta.save(data / "brain.npz")
    (data / "brain.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def load(data_dir: Path | None = None) -> tuple[sparse.csc_matrix, BrainMeta]:
    """Load the built brain. Raises ConnectomeError if it is absent or inconsistent."""
    data = _resolve_data_dir(data_dir)
    wpath = data / "weights.npz"
    if not wpath.exists():
        raise ConnectomeError(f"{wpath} not found; run: {_BUILD_CMD}")
    try:
        W = sparse.load_npz(wpath)
    except Exception as exc:
        raise ConnectomeError(f"{wpath} is unreadable ({exc}); delete it and run: {_BUILD_CMD}") from exc
    meta = BrainMeta.from_npz(data / "brain.npz")
    if W.shape != (meta.n, meta.n):
        raise ConnectomeError(f"{wpath} shape {W.shape} does not match brain.npz ({meta.n} neurons)")
    if W.dtype != np.float32 or W.format != "csc":
        raise ConnectomeError(f"{wpath} must be float32 CSC, got {W.dtype} {W.format}")
    try:
        # load_npz and csc_matrix() both run check_format(full_check=False), which
        # validates indptr but *skips* the index-bounds check. Out-of-range indices then
        # reach `buf[t, indices[p]] += data[p]` in the numba kernel and scipy's C
        # csc_matvec, neither of which bounds-checks — a crafted weights.npz is an
        # arbitrary heap write (SIGSEGV verified on both backends, #15). 14 ms on the
        # real 25.6M-nonzero matrix, against a 0.29 s load.
        W.check_format(full_check=True)
    except ValueError as exc:
        raise ConnectomeError(f"{wpath} is corrupt ({exc}); delete it and run: {_BUILD_CMD}") from exc
    return W, meta


def main(argv: Sequence[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Download and build the MaleCNS v1.0 brain.")
    ap.add_argument("--data", type=Path, default=None)
    ap.add_argument("--force", action="store_true", help="re-download even verified files")
    args = ap.parse_args(argv)
    download(args.data, force=args.force)
    print(json.dumps(build(args.data), indent=2))


if __name__ == "__main__":
    main()
