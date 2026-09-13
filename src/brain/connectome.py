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
import stat
import time
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

# `timeout=60` on urlopen is per socket operation, so a server dripping one byte every
# 59 s keeps a transfer alive forever. Bound the *average* rate instead of the total
# duration: a 1 GB download over a genuinely slow link is legitimate and cannot be given
# a fixed deadline, but nothing honest sustains under 8 KB/s (that is 36 hours for the
# 1 GB source). The grace period covers slow starts and TLS setup (#17).
_MIN_RATE = 8 << 10   # bytes/s, averaged over this transfer
_RATE_GRACE = 30.0    # s before the floor starts applying


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

    # A plausibility bound, not a resource guard: `from_npz` materialises all eight
    # arrays before `_validate` runs, so a crafted brain.npz has already spent its memory
    # by the time we look (a 31 MB file declaring n = 20M peaks at ~1 GB RSS, and n = 10**9
    # dies as MemoryError inside the reader). What the bound buys is cross-array shape and
    # dtype consistency against a sane `n`. The real connectome is 166,700; 5M admits a
    # larger future dataset but not an absurd one.
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
        # The ordering this class documents as its contract. `_sanity` checks it when
        # build() writes the file; nothing checked it when load() reads one back, and
        # every downstream lookup is a np.searchsorted(ids, body_id) that answers
        # silently wrong — not out of range, wrong — on unsorted ids (#20).
        if n > 1 and not np.all(np.diff(ids) > 0):
            raise ConnectomeError(f"{path}: ids are not strictly increasing; {bad}")


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
    # Raw weights are integers >= 1, so `incoming >= 1` for every row that carries a
    # nonzero. Neurons with no input at all are **not** what the clamp protects, however
    # many of them the data has: CSC `indices` lists only rows that carry a nonzero, so
    # those rows are never indexed here and 0/0 cannot arise from them. The comment this
    # replaces said otherwise and was wrong about a step central to the model (#14).
    # What is left for the clamp to guard is an *explicitly stored* zero weight — a
    # structural zero the caller put in the COO triplets. The real data has none, so the
    # clamp is provably inert on this connectome and removing it is bit-identical. It is
    # kept because `build_weights` is pure and normalises whatever arrays it is handed,
    # and without it such a caller gets a NaN in W instead of a finite matrix.
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


def _open_nofollow(path: Path, *, append: bool):
    """Open `path` for writing, refusing anything that is not an unshared regular file.

    A plain `open()` follows symlinks, so a pre-planted `<name>.part` symlink redirects
    server-controlled bytes through to any file the running user can write — and the
    `.part` is only unlinked *after* `_verify` fails, so the hash pin does not help: it
    protects what gets parsed, not what gets written (#18).

    `O_NOFOLLOW` only rejects a symlink *as the final component*, and says nothing about
    what the opened inode is (#21). Two things get through it:

    * a **hardlink** — the `.part` really is a regular file, it is just a second name for
      the victim's inode, so the same overwrite lands without a symlink anywhere;
    * a **FIFO** — `os.open(O_WRONLY)` blocks until a reader appears, and it blocks
      before the first HTTP request, so `urlopen(timeout=...)` never gets to apply.

    `O_NONBLOCK` turns the FIFO hang into ENXIO at the open (it has no effect on regular
    files on macOS or Linux, so it is left set rather than cleared afterwards), and
    `fstat` on the descriptor — not the path, so nothing can be swapped underneath it —
    rejects the hardlink and any device node or socket planted there.

    Truncation is deferred to an explicit `ftruncate` *after* that check instead of
    `O_TRUNC` in the flags: `O_TRUNC` fires inside `os.open`, so it would zero a
    hardlinked victim before there was anything to check. `O_EXCL` would be the stronger
    fix for the fresh-download path, but it is wrong here — `_stream` resets `start` to 0
    when the server ignores or mismatches the Range, and re-opens an already-existing
    `.part` with `append=False`, which since #17 is the normal state after an abort.

    Only reachable when FLUGSPIEL_DATA points somewhere another local user can write — a
    shared scratch volume, /tmp/flugspiel, a CI runner cache — which is exactly what the
    env var exists for. With the default <repo>/data an attacker would already be able to
    edit this file.

    Mode 0o644 matches what `open(path, "wb")` produced under the usual umask, so a
    deliberately shared 1.1 GB cache stays readable; tightening it is a separate call.
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    flags |= os.O_APPEND if append else 0
    try:
        fd = os.open(path, flags, 0o644)
    except OSError as exc:  # ELOOP: a symlink; ENXIO: a readerless FIFO
        raise ConnectomeError(
            f"{path} is not a regular file ({exc}); remove it and retry") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise ConnectomeError(
                f"{path} is not an exclusively-linked regular file "
                f"(mode {stat.S_IFMT(st.st_mode):o}, {st.st_nlink} links); remove it and retry")
        if not append:
            os.ftruncate(fd, 0)
    except OSError as exc:
        os.close(fd)
        raise ConnectomeError(
            f"{path} cannot be opened for writing ({exc}); remove it and retry") from exc
    except BaseException:
        os.close(fd)
        raise
    # O_APPEND is a kernel flag, so writes append regardless of the mode string here.
    return open(fd, "wb", closefd=True)


def _warn_if_shared(raw: Path) -> None:
    """Warn if the raw dir is group/world-writable — `mkdir` inherits the umask and does
    not check the mode of a directory that already exists (#18). Not fatal: relocating
    the 1.1 GB cache onto a shared volume is a legitimate thing to do with FLUGSPIEL_DATA,
    but the symlink-planting precondition is worth surfacing rather than silently allowing.
    """
    try:
        mode = raw.stat().st_mode
    except OSError:
        return
    if mode & 0o022:
        print(f"  warning: {raw} is writable by other users (mode {mode & 0o777:o}); "
              f"another local user could pre-plant files there")


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
        elif start:
            # A 206 for a range we did not ask for would append the wrong bytes onto the
            # existing prefix. `_verify` still catches it, but only after paying 1 GB of
            # bandwidth to find out. `start = 0` re-opens with `append=False`, which
            # truncates the existing `.part` — via the explicit `ftruncate` after the
            # inode check, not `O_TRUNC`, which #21 removed from the flags — so
            # restarting is already sound.
            rng = resp.headers.get("Content-Range", "")
            if not rng.startswith(f"bytes {start}-"):
                start = 0
        got = start
        mark = 0
        began = time.monotonic()
        with _open_nofollow(part, append=bool(start)) as f:
            # read1, not read: `read(_CHUNK)` *fills* _CHUNK bytes, so against a drip
            # server it blocks in the kernel for ~1024 s at the rate floor and the guards
            # below are never evaluated. read1 returns what is already buffered, so the
            # loop iterates per TCP segment and the guards actually run.
            while chunk := resp.read1(_CHUNK):
                f.write(chunk)
                got += len(chunk)
                if got > src.size:
                    # src.size is pinned. A server sending more is serving the wrong file
                    # or is hostile; `_verify` would reject it either way, but only after
                    # the server has decided how much of our disk to use. Overshoot is
                    # bounded by one _CHUNK, and the .part is removed here.
                    f.close()
                    part.unlink(missing_ok=True)
                    raise ConnectomeError(
                        f"{name}: server sent more than the pinned {src.size} bytes "
                        f"(got {got}); refusing to continue")
                elapsed = time.monotonic() - began
                if elapsed > _RATE_GRACE and (got - start) / elapsed < _MIN_RATE:
                    # Keep the .part, unlike the oversize abort above: these are good
                    # bytes that hash into the final file. Nothing retries them in this
                    # process — `_stream` is called outside `download()`'s try, so this
                    # abort propagates out of `download()` and the retry loop only ever
                    # re-runs a `_verify` failure — so the prefix is what the *next run*
                    # resumes from via Range. Deleting it would make a sub-floor link
                    # accumulate nothing, ever. Peak disk stays bounded by the
                    # `got > src.size` guard.
                    f.close()
                    raise ConnectomeError(
                        f"{name}: transfer averaged {(got - start) / elapsed:.0f} B/s over "
                        f"{elapsed:.0f}s, below the {_MIN_RATE} B/s floor; aborting")
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
    _warn_if_shared(raw)
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


def _failures(checks: dict[str, bool]) -> list[str]:
    return [msg for msg, ok in checks.items() if not ok]


def _invariants(W: sparse.csc_matrix, meta: BrainMeta) -> list[str]:
    """Properties of any brain `build()` writes, at any size. Returns the failures.

    Run on the **load** path as well as the build path. `load()` checked shape, dtype and
    index bounds, which makes a crafted artifact memory-safe (#15) but says nothing about
    its values, and the artifact most worth attacking was the least checked one (#20).
    These are the checks that do not assume the real connectome's scale, so a two-neuron
    matrix passes them too.

    What they catch: rescaled weights, a synapse set to NaN or inf, a rewritten nt_sign.
    What they do **not** catch, because none of it changes |w| or the sign vocabulary: a
    matrix with its signs flipped, or one rewired to connect different neurons. Only a
    pinned hash would, which is the open half of #20.

    `_sanity` and `load()` share this one implementation deliberately, rather than each
    reducing the row sums their own way: a cheaper reduction (`abs(W).sum(axis=1)`)
    accumulates in float32 and overshoots the tolerance on the real matrix, so it would
    reject the artifact build() had just written.
    """
    worst = np.bincount(W.indices, weights=np.abs(W.data), minlength=meta.n).max(initial=0.0)
    return _failures({
        f"W.shape {W.shape} != ({meta.n}, {meta.n})": W.shape == (meta.n, meta.n),
        "W contains non-finite weights": bool(np.isfinite(W.data).all()),
        f"row |w| sum exceeds 1 ({worst})": worst <= 1 + 1e-5,
        "nt_sign is not all -1 or +1": bool(np.isin(meta.nt_sign, (-1.0, 1.0)).all()),
    })


def _sanity(W: sparse.csc_matrix, meta: BrainMeta) -> None:
    """Build-time checks: the load-path invariants, plus bounds only the real data meets."""
    bad = _failures({
        f"too few neurons ({meta.n})": meta.n >= 100_000,
        f"too few connections ({W.nnz})": W.nnz >= 10_000_000,
        "nt_sign has only one sign": bool((meta.nt_sign < 0).any() and (meta.nt_sign > 0).any()),
        "ids are not strictly increasing": bool(np.all(np.diff(meta.ids) > 0)),
    }) + _invariants(W, meta)
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
    # Structure is not provenance. Nothing here authenticates the artifact — see #20 for
    # why it is not hash-pinned the way SOURCES pins the raw downloads — but a matrix
    # whose values no longer obey what build() guarantees is rejected rather than
    # silently simulated. Costs a bincount over the nonzeros, once, at startup.
    bad = _invariants(W, meta)
    if bad:
        raise ConnectomeError(
            f"{wpath} failed the brain's invariants ({'; '.join(bad)}); "
            f"delete it and run: {_BUILD_CMD}")
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
