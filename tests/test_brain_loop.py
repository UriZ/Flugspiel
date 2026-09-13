"""Real-brain checks for the encoder/decoder — #3 R1-R4. Skipped with no built connectome.

Every test here pins `backend="numpy"` (§6 note 8) and asserts a *rate over a window*,
never a spike index or an exact count. Measured numbers in each docstring were produced on
this tree at `data/weights.npz` (166,700 neurons / 25,582,938 connections), seed 0.

Runtime on an M-series laptop: R1 30 s, R2 124 s, R3 56 s, R4 20 s. The numpy kernel is
53 ms/step; that cost is the price of a machine-independent spike train.
"""

import copy
import json
import math

import numpy as np
import pytest

from src.brain.connectome import ConnectomeError
from src.brain.decoder import Decoder
from src.brain.encoder import Encoder, photoreceptor_columns
from src.brain.lif import FlyBrain
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping

pytestmark = pytest.mark.realdata

SETTLE = 150


@pytest.fixture(scope="module")
def brain():
    try:
        return FlyBrain.load(seed=0, backend="numpy")
    except ConnectomeError as exc:
        pytest.skip(f"no built connectome ({exc}); run: python -m src.brain.connectome")


def state(x, y=0.4, vy=0.3, health=1.0) -> dict:
    return {"seq": 0, "t": 0.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
            "weapon": 0, "base": {"x": 0.5, "health": health, "launchers_alive": 7},
            "launchers": [], "interceptors": [],
            "missiles": [{"kind": "missile", "x": float(x), "y": y, "vx": 0.0, "vy": vy}]}


def pooled_hz(brain, inject, pops, steps, settle=SETTLE, measure=None):
    """Pooled firing rate of each population over the last `measure` of `steps` steps."""
    measure = steps if measure is None else measure
    brain.reset(0)
    counts = [0] * len(pops)
    mask = np.zeros(brain.n, dtype=bool)
    for i in range(settle + steps):
        fired = brain.step(inject=inject)
        if i >= settle + steps - measure:
            mask[fired] = True
            for k, pop in enumerate(pops):
                counts[k] += int(mask[pop].sum())
            mask[fired] = False
    return [c / measure / brain.params.dt for c in counts]


def sites_only(names, **gains) -> Mapping:
    """The default mapping with only `names` enabled, optionally with replaced gains."""
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    raw["sites"] = [{**s, "enabled": s["name"] in names,
                     "gain": gains.get(s["name"], s["gain"])} for s in raw["sites"]]
    return Mapping.load(copy.deepcopy(raw))


# --------------------------------------------------------------------------- R1 (AC2)


def test_looming_drives_dnp01(brain):
    """AC2 — LC4+LPLC2-L at 0.30 for 400 steps: measured DNp01-L 17.62 Hz, DNp01-R 0.12 Hz.

    Reproduces the spec's §2.3 numbers (17.56 / 0.12), which were taken on the *numba*
    kernel, to within 0.06 Hz — so the two backends agree on this channel and the 10:1
    bound below is not backend-sensitive.
    """
    site = next(s for s in Mapping.default().sites if s.name == "looming_L")
    idx = brain.cells(list(site.types), side="L")
    assert len(idx) > 0
    left, right = pooled_hz(brain, [(idx, np.float32(site.gain))],
                            [brain.cells(["DNp01"], side="L"),
                             brain.cells(["DNp01"], side="R")], 400)
    assert left >= 10.0, f"DNp01-L {left:.2f} Hz: the looming channel is not getting through"
    assert right <= 1.0, f"DNp01-R {right:.2f} Hz: the 135:1 laterality is gone"


# --------------------------------------------------------------------------- R2 (AC7)


def test_shuffle_control(brain):
    """AC7 — the encoder carries game *content*, not just game-shaped energy.

    A missile sweeps x from 0.05 to 0.95 in 20 frames (y 0.4, vy 0.3), each held for 50
    brain steps with DNp01 L/R counted over the last 25. Accuracy = fraction of frames
    where sign(DNp01-L − DNp01-R) matches sign(loom_L − loom_R) from the *true* position.
    The sweep is then re-run with the x values permuted by `default_rng(0).permutation` —
    the same 20 injections in a different order, so identical energy and identical
    per-frame statistics, wrong content.

    Measured, seed 0: **real 1.000, shuffled 0.500** (chance). Ipsilateral counts are 7-8
    spikes against 0 contralateral on every frame, so the margin is categorical rather
    than statistical. The same run at 100-step frames measuring 60 gives 1.000 / 0.500
    with counts 16-18 vs 0; the shorter frames are used because the pair costs 124 s
    instead of 208 s on the numpy kernel.

    Without this test the aim channel's noise floor (crosshair sd 0.16-0.36 with *no*
    command, hitting both rails on every seed) makes open-loop wandering indistinguishable
    from playing. AC1-AC6 cannot tell them apart; this can.
    """
    block, measure = 50, 25
    enc = Encoder(brain)
    dn_L, dn_R = brain.cells(["DNp01"], side="L"), brain.cells(["DNp01"], side="R")
    xs = np.linspace(0.05, 0.95, 20)
    frames = [enc.encode(state(x)) for x in xs]
    truth = np.sign([f.loom["L"] - f.loom["R"] for f in frames])
    assert set(truth.tolist()) == {-1.0, 1.0}, "the sweep must cross the midline"

    def sweep(order):
        brain.reset(0)
        neutral = enc.neutral()
        for _ in range(SETTLE):
            brain.step(inject=neutral.inject)
        mask, signs = np.zeros(brain.n, bool), []
        for k in order:
            counts = [0, 0]
            for i in range(block):
                fired = brain.step(inject=frames[k].inject)
                if i >= block - measure:
                    mask[fired] = True
                    counts[0] += int(mask[dn_L].sum())
                    counts[1] += int(mask[dn_R].sum())
                    mask[fired] = False
            signs.append(np.sign(counts[0] - counts[1]))
        return float(np.mean(np.asarray(signs) == truth))

    real = sweep(range(20))
    shuffled = sweep(np.random.default_rng(0).permutation(20))
    assert real >= 0.90, f"encoder content is not reaching DNp01 (accuracy {real:.3f})"
    assert shuffled <= 0.75, (f"shuffled content scores {shuffled:.3f}: the readout is "
                              f"responding to injection energy, not to the game")


# --------------------------------------------------------------------------- R3 (§2.2)


def test_photoreceptor_path_null_is_pinned(brain):
    """§2.2 — the retina does **not** reach DNa02. Pinned so the measurement cannot rot.

    Retina at gain 1.0 on an empty sky (every assigned photoreceptor at its full amount,
    5,861 of 6,006) moves pooled DNa02 from 0.500 to 0.625 Hz — 0.125 Hz, i.e. one extra
    spike in 400 steps. At gain 2.0 it is 0.875 Hz (0.375 Hz). If this assertion ever
    fails, the retina channel started working and the spec's §2.2 claim — plus AC4's
    restatement and #7's disclosure of the aim prosthesis — must be revisited.
    """
    pops = [brain.cells(["DNa02"])]
    off = Encoder(brain, sites_only(())).neutral()
    on = Encoder(brain, sites_only({"retina"}, retina=1.0)).neutral()
    assert sum(len(i) for i, _ in off.inject) == 0
    injected = sum(len(i) for i, _ in on.inject)
    assert injected == 5_861, f"{injected} photoreceptors assigned an azimuth, expected 5861"

    quiet = pooled_hz(brain, off.inject, pops, 400)[0]
    lit = pooled_hz(brain, on.inject, pops, 400)[0]
    assert abs(lit - quiet) < 1.0, (f"pooled DNa02 moved {lit - quiet:+.3f} Hz "
                                   f"({quiet:.3f} -> {lit:.3f}) under photoreceptor drive")


def test_azimuth_coverage(brain):
    """§2.1 — the modal-hex vote, on the real data. 5,861 / 6,006 assigned, no gaps."""
    cols = photoreceptor_columns(brain.W, brain.meta, 36, Mapping.default().hex_flip)
    photo = brain.cells(["R1-6", "R7", "R8"])
    assert len(photo) == 6_006
    assigned = cols[photo]
    assert int((assigned >= 0).sum()) == 5_861
    assert assigned.max() == 35 and assigned[assigned >= 0].min() == 0
    assert len(np.unique(assigned[assigned >= 0])) == 36, "every column has photoreceptors"
    assert (cols[np.setdiff1d(np.arange(brain.n), photo)] == -1).all()


# --------------------------------------------------------------------------- R4


def test_full_loop_runs_and_calibrates(brain):
    """encode → step → observe → decode → on_result on the real brain, end to end."""
    enc, dec = Encoder(brain), Decoder(brain)
    zero = dec.calibrate(enc, steps=100, settle=50)
    if dec.readout is None:
        assert math.isfinite(zero) and -1.0 <= zero <= 1.0
        assert dec.aim_zero == zero
    else:
        # Readout mode has no zero to measure — the fitted intercept is the zero — and
        # `calibrate()` must return before resetting the brain, or every session boundary
        # reinstates the reset #22 removed (#40 §9).
        steps = brain.steps
        assert zero is None and dec.aim_zero is None
        assert dec.calibrate(enc, steps=100, settle=50) is None
        assert brain.steps == steps, "calibrate() must not step the brain in readout mode"

    dt = brain.params.dt
    frame = enc.encode(state(0.2), dec.crosshair_x)
    messages = []
    for tick in range(10):
        for _ in range(5):
            dec.observe(brain.step(inject=frame.inject), dt)
        msg = dec.decode(state(0.2), 5 * dt)
        dec.on_result({"ok": True})
        frame = enc.encode(state(0.2), dec.crosshair_x)
        messages.append(msg)

    assert all(m["action"] in ("fire", "aim", "noop") for m in messages)
    assert any(m["action"] == "fire" for m in messages), "looming at 0.2 must reach DNp01"
    assert 0.0 <= dec.crosshair_x <= 1.0
    tele = dec.telemetry()
    assert tele["fire_hz"] > 0 and tele["halted"] is False
    # The PFL3 prosthesis is retired (#40 §5.3) — it stays in the config, disabled, as the
    # A/B control. The azimuth basis the encoder now uses is disclosed in its place.
    assert frame.prosthetic_sites == []
    assert frame.coded_sites == ["looming_code"]
