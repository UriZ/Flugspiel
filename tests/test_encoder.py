"""Encoder — #3 §3.3 E1-E12. Synthetic brains only: no connectome, no network.

The real-brain assertions live in `test_brain_loop.py` (R1-R3, `realdata`).
"""

import copy
import dataclasses
import json

import numpy as np
import pytest
from scipy import sparse

from src.brain.encoder import Encoder, EncodedFrame, photoreceptor_columns
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping, column
from tests.conftest import make_brain, make_meta

PEPTIDE = ("NPFL1-I", "Hugin-RG", "CRZ", "CRZ01,CRZ02", "DH44", "LK",
           "IPC", "ISN", "AstA1", "DSKMP3")
HEXES = (1, 12, 24, 36)
"""ol_hex1 of the four lamina cells the toy photoreceptors target: first, two interior,
last of the 1..36 range, so a flip or an off-by-one in the hex→column map cannot hide."""


def toy_brain():
    """A 39-neuron brain carrying every cell type the default mapping names.

    Photoreceptor `j` synapses onto one hex-carrying `L1` cell, which is the only path to
    azimuth (photoreceptors carry no `ol_hex` of their own). One extra photoreceptor has
    no postsynaptic partner at all, so `unassigned` is exercised.
    """
    types, sides, hex1 = [], [], []

    def add(cell_type, side, h=np.nan):
        types.append(cell_type)
        sides.append(side)
        hex1.append(h)
        return len(types) - 1

    targets = [add("L1", "L", float(h)) for h in HEXES]
    photo = [(add(cls, side), t) for side in ("L", "R")
             for cls, t in zip(("R1-6", "R7", "R8", "R1-6"), targets)]
    orphan = add("R7", "L")
    for cell_type in ("LC4", "LPLC2", "DNa02", "DNp01", "PFL3", "ALT"):
        add(cell_type, "L")
        add(cell_type, "R")
    for cell_type in ("DNpe023", "DNg100", "MDN", *PEPTIDE):
        add(cell_type, "M")

    n = len(types)
    meta = dataclasses.replace(
        make_meta(n, cell_type=types, side=sides),
        ol_hex=np.column_stack([np.asarray(hex1, np.float32), np.full(n, np.nan, np.float32)]))
    W = sparse.lil_matrix((n, n), dtype=np.float32)
    for j, t in photo:
        W[t, j] = 1.0
    return make_brain(sparse.csc_matrix(W), meta), [j for j, _ in photo], orphan


def cfg(**over) -> dict:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    raw.update(copy.deepcopy(over))
    return raw


def state(missiles=(), health=1.0, **over) -> dict:
    """A GameState in the #2 wire shape."""
    s = {"seq": 1, "t": 1.0, "phase": "playing", "mode": "fly", "score": 0, "wave": 1,
         "weapon": 0, "base": {"x": 0.5, "health": health, "launchers_alive": 7},
         "launchers": [{"i": i, "kind": "cannon", "x": 0.1 + 0.1 * i, "y": 0.8472,
                        "alive": True, "hp": 1.0, "selected": i == 0} for i in range(7)],
         "missiles": [{"kind": "missile", "x": 0.5, "y": 0.4, "vx": 0.0, "vy": 0.0, **m}
                      for m in missiles],
         "interceptors": []}
    s.update(over)
    return s


@pytest.fixture
def enc():
    brain, photo, orphan = toy_brain()
    e = Encoder(brain)
    e.photo, e.orphan = photo, orphan  # test-only handles on the toy topology
    return e


def amounts_of(frame: EncodedFrame, idx: np.ndarray) -> np.ndarray:
    """Every amount any site injected into `idx`, concatenated."""
    out = []
    for sub, amt in frame.inject:
        keep = np.isin(sub, idx)
        out.append(amt[keep])
    return np.concatenate(out) if out else np.empty(0, np.float32)


# --------------------------------------------------------------------------- E1, E2, E4


def test_col_covers_screen():
    assert column(0.0, 36) == 0 and column(0.999, 36) == 35
    assert column(1.0, 36) == 35, "x == 1.0 is the last column, not a 37th"
    assert column(-0.1, 36) == 0 and column(2.0, 36) == 35
    xs = np.linspace(-0.2, 1.2, 200)
    assert (np.diff(column(xs, 36)) >= 0).all()


def test_luminance_roundtrip(enc):
    """AC6 roundtrip: a single missile's darkest column is the column it occupies."""
    for x in np.linspace(0.0, 1.0, 20):
        frame = enc.encode(state([dict(x=float(x), y=0.4)]))
        assert int(np.argmin(frame.luminance)) == int(column(x, 36)), f"x={x}"


def test_azimuth_from_hex(enc):
    """AC6 roundtrip: hex 1/12/24/36 → columns 0/11/23/35 on L, mirrored on R."""
    cols = photoreceptor_columns(enc.brain.W, enc.brain.meta, 36, enc.mapping.hex_flip)
    side = enc.brain.meta.side
    got = {(str(side[j]), int(cols[j])) for j in enc.photo}
    assert got == {("L", 0), ("L", 11), ("L", 23), ("L", 35),
                   ("R", 35), ("R", 24), ("R", 12), ("R", 0)}
    assert cols[enc.orphan] == -1
    assert (cols[enc.brain.cells(["L1", "LC4", "DNa02"])] == -1).all(), "non-retinal stays -1"


def test_azimuth_flip_is_configurable(enc):
    unflipped = photoreceptor_columns(enc.brain.W, enc.brain.meta, 36, {})
    side = enc.brain.meta.side
    assert {int(unflipped[j]) for j in enc.photo if side[j] == "R"} == {0, 11, 23, 35}


# --------------------------------------------------------------------------- E3, E5


def test_luminance_polarity_and_range(enc):
    """An empty sky is bright, i.e. full drive. A missile *removes* drive, never adds."""
    empty = enc.encode(state())
    retina = enc.brain.cells(["R1-6", "R7", "R8"])
    gain = next(s.gain for s in enc.mapping.sites if s.name == "retina")
    assert (empty.luminance == 1.0).all()
    assert np.allclose(amounts_of(empty, retina), gain)

    lit = enc.encode(state([dict(x=0.5, y=0.9)]))
    dark = int(column(0.5, 36))
    assert lit.luminance[dark] < 0.2
    assert lit.luminance[0] == pytest.approx(1.0), "a missile darkens only its neighbourhood"
    a = amounts_of(lit, retina)
    assert ((a >= 0.0) & (a <= gain)).all()
    assert a.min() < gain, "the photoreceptor in the missile's column lost drive"


def test_unassigned_photoreceptors_excluded(enc):
    frame = enc.encode(state())
    assert frame.unassigned == 1
    assert not any(enc.orphan in sub for sub, _ in frame.inject)


# --------------------------------------------------------------------------- E6, E7


@pytest.mark.parametrize("y, vy, expected", [
    (0.6, 0.2, 0.809),    # ttc 1.236 s
    (0.2, 0.1, 0.155),
    (0.8, 0.5, 1.0),      # inside ttc_min
    (0.5, -0.2, 0.0),     # rising: not a threat
    (0.85, 0.1, 1.0),     # already past the launcher row
    (0.5, 0.0, 0.0),
])
def test_loom_ttc(enc, y, vy, expected):
    frame = enc.encode(state([dict(x=0.1, y=y, vy=vy)]))
    assert frame.loom["L"] == pytest.approx(expected, abs=1e-3)
    assert frame.loom["R"] == 0.0


def test_loom_side_split(enc):
    two = [dict(x=0.2, y=0.6, vy=0.2), dict(x=0.9, y=0.2, vy=0.1)]
    frame = enc.encode(state(two))
    assert frame.loom["L"] == pytest.approx(0.809, abs=1e-3)
    assert frame.loom["R"] == pytest.approx(0.155, abs=1e-3)

    # Telemetry agreeing with the truth is not enough: each hemisphere's *injection* must
    # carry its own side's value. A side-blind encoder looks perfect in `frame.loom`.
    gain = next(s.gain for s in enc.mapping.sites if s.name == "looming_L")
    assert amounts_of(frame, enc.brain.cells(["LC4", "LPLC2"], side="L")) == pytest.approx(
        gain * 0.809, abs=1e-3)
    assert amounts_of(frame, enc.brain.cells(["LC4", "LPLC2"], side="R")) == pytest.approx(
        gain * 0.155, abs=1e-3)

    flipped = Encoder(enc.brain, Mapping.load(cfg(loom={**enc.mapping.loom, "side_flip": True})))
    swapped = flipped.encode(state([dict(x=0.2, y=0.6, vy=0.2), dict(x=0.9, y=0.2, vy=0.1)]))
    assert swapped.loom["L"] == pytest.approx(0.155, abs=1e-3)
    assert swapped.loom["R"] == pytest.approx(0.809, abs=1e-3)


def test_loom_ttc_min_is_a_floor(enc):
    """`ttc_min` guards the division and caps very close threats.

    Under the *default* config it is invisible — tau/ttc_min = 4.0 is above the clip, so
    the clip subsumes it. It only becomes observable when tau < ttc_min, which is the
    configuration this test pins; without the floor, a missile 0.05 screens away at
    vy = 0.5 would read 1.0 instead of 0.2.
    """
    slow = Encoder(enc.brain, Mapping.load(cfg(loom={**enc.mapping.loom,
                                                     "tau": 0.1, "ttc_min": 0.5})))
    assert slow.encode(state([dict(x=0.1, y=0.8, vy=0.5)])).loom["L"] == pytest.approx(0.2)
    at_ground = slow.encode(state([dict(x=0.1, y=enc.mapping.loom["y_ground"], vy=0.5)]))
    assert at_ground.loom["L"] == pytest.approx(1.0), "ttc == 0 must not divide by zero"


def test_loom_saturates_at_one(enc):
    many = [dict(x=0.1, y=0.6, vy=0.2)] * 4
    assert enc.encode(state(many)).loom["L"] == 1.0


# --------------------------------------------------------------------------- E8


def test_drive_and_gain_mod(enc):
    loom_L = enc.brain.cells(["LC4", "LPLC2"], side="L")
    base = next(s.gain for s in enc.mapping.sites if s.name == "looming_L")
    missile = [dict(x=0.1, y=0.6, vy=0.2)]  # loom 0.809

    healthy = enc.encode(state(missile, health=1.0))
    assert healthy.drive == 0.0
    assert amounts_of(healthy, loom_L) == pytest.approx(base * 0.809, abs=1e-3)

    hurt = enc.encode(state(missile, health=0.0))
    assert hurt.drive == 1.0
    k = enc.mapping.drive_mod_k
    assert amounts_of(hurt, loom_L) == pytest.approx(base * (1 + k) * 0.809, abs=1e-3)

    pool = enc.brain.cells(list(PEPTIDE))
    pool_gain = next(s.gain for s in enc.mapping.sites if s.name == "drive")
    assert np.allclose(amounts_of(hurt, pool), pool_gain * 1.0)
    assert np.allclose(amounts_of(healthy, pool), 0.0)


def test_launcher_structure_is_exposed(enc):
    """AC3 (amended): per-launcher damage is available, not just the scalar."""
    frame = enc.encode(state(health=0.5))
    assert len(frame.launcher_hp) == 7 and len(frame.launcher_x) == 7
    assert frame.launcher_x[0] == pytest.approx(0.1)
    assert "launchers_alive" not in frame.__dict__, "monotonic signal is #7's, not the encoder's"


# --------------------------------------------------------------------------- E9


@pytest.mark.parametrize("field", ["x", "y", "vx", "vy"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf"), None, "abc"])
def test_injections_are_finite_and_bounded(enc, field, bad):
    """#13 — one NaN in `v` silently removes a neuron for the rest of the session."""
    frame = enc.encode(state([{field: bad}]), crosshair_x=0.5)
    all_amounts = np.concatenate([a for _, a in frame.inject])
    assert np.isfinite(all_amounts).all()
    assert ((all_amounts >= 0.0) & (all_amounts <= enc.mapping.max_inject)).all()
    assert frame.rejected == 1


def test_non_finite_health_and_hp_are_counted(enc):
    s = state(health=float("nan"))
    s["launchers"][3]["hp"] = float("inf")
    frame = enc.encode(s, crosshair_x=float("nan"))
    assert frame.rejected == 3
    assert frame.drive == 1.0 and frame.launcher_hp[3] == 0.0
    assert np.isfinite(np.concatenate([a for _, a in frame.inject])).all()


@pytest.mark.parametrize("rogue", [float("nan"), float("inf"), -float("inf"), -5.0, 1e9])
def test_a_rogue_signal_cannot_inject_nan(enc, monkeypatch, rogue):
    """#13, at the layer where the guard is actually reachable.

    Wire input is sanitised on the way in (`_finite`), so no GameState can produce a
    non-finite amount — `test_injections_are_finite_and_bounded` proves that and passes
    even with `nan_to_num` deleted. The guard exists for the *other* input: `SIGNALS` is a
    registry #8 extends, and a signal function returning NaN would otherwise remove a
    neuron from the simulation permanently.
    """
    import src.brain.encoder as mod

    monkeypatch.setitem(mod.SIGNALS, "rogue", lambda c: rogue)
    sites = [{"name": "rogue", "types": ["LC4"], "side": None, "signal": "rogue",
              "gain": 1.0, "gain_mod": None, "prosthesis": False, "enabled": True}]
    frame = Encoder(enc.brain, Mapping.load(cfg(sites=sites))).encode(state())
    amounts = np.concatenate([a for _, a in frame.inject])
    assert len(amounts) == 2
    assert np.isfinite(amounts).all()
    assert ((amounts >= 0.0) & (amounts <= enc.mapping.max_inject)).all()


def test_max_inject_clamps(enc):
    """A retuned config cannot push more than `max_inject` into a neuron."""
    e = Encoder(enc.brain, Mapping.load(cfg(max_inject=0.1)))
    frame = e.encode(state())
    assert np.concatenate([a for _, a in frame.inject]).max() == pytest.approx(0.1)


# --------------------------------------------------------------------------- E10, E11, E12


def test_encode_is_level_held(enc):
    """The same frame applied twice injects the same amount twice (§6 note 3)."""
    frame = enc.encode(state())
    brain = enc.brain
    retina = brain.cells(["R1-6"])[0]
    before = [a.copy() for _, a in frame.inject]
    brain.step(inject=frame.inject)
    first = float(brain.v[retina])
    brain.step(inject=frame.inject)
    second = float(brain.v[retina])
    applied = second - first * brain.params.decay
    assert applied == pytest.approx(first, rel=1e-5)
    for (_, after), b in zip(frame.inject, before):
        assert np.array_equal(after, b), "encode() must not mutate its own frame"


def test_config_retunes_without_code_change(enc):
    """AC5 — behaviour changes from JSON alone."""
    sites = cfg()["sites"]
    loud = [{**s, "gain": s["gain"] * 2} if s["name"] == "looming_L" else
            {**s, "enabled": False} if s["name"] == "retina" else s for s in sites]
    tuned = Encoder(enc.brain, Mapping.load(cfg(sites=loud)))
    missile = [dict(x=0.1, y=0.6, vy=0.2)]

    loom_L = enc.brain.cells(["LC4", "LPLC2"], side="L")
    assert amounts_of(tuned.encode(state(missile)), loom_L) == pytest.approx(
        2 * amounts_of(enc.encode(state(missile)), loom_L), rel=1e-6)

    retina = enc.brain.cells(["R1-6", "R7", "R8"])
    assert len(amounts_of(tuned.encode(state(missile)), retina)) == 0
    assert tuned.encode(state(missile)).unassigned == 0, "no retina site, nothing to assign"


def test_prosthetic_sites_are_disclosed(enc):
    """#7 must be able to see that aiming came from a premotor shortcut (§2.3)."""
    assert enc.encode(state()).prosthetic_sites == ["aim_bias_L", "aim_bias_R"]
    off = [{**s, "enabled": False} if s["name"].startswith("aim_bias") else s
           for s in cfg()["sites"]]
    honest = Encoder(enc.brain, Mapping.load(cfg(sites=off)))
    assert honest.encode(state()).prosthetic_sites == []


def test_aim_error_is_relative_to_the_crosshair(enc):
    """PFL3 is contralateral: a target to the right raises aim_err_R (§3.3)."""
    pfl_L = enc.brain.cells(["PFL3"], side="L")
    pfl_R = enc.brain.cells(["PFL3"], side="R")
    right = enc.encode(state([dict(x=0.9, y=0.6, vy=0.2)]), crosshair_x=0.5)
    assert amounts_of(right, pfl_R) > amounts_of(right, pfl_L)
    left = enc.encode(state([dict(x=0.1, y=0.6, vy=0.2)]), crosshair_x=0.5)
    assert amounts_of(left, pfl_L) > amounts_of(left, pfl_R)
    on_target = enc.encode(state([dict(x=0.5, y=0.6, vy=0.2)]), crosshair_x=0.5)
    assert amounts_of(on_target, pfl_L) == pytest.approx(amounts_of(on_target, pfl_R))


def test_neutral_frame_is_symmetric_and_empty(enc):
    """What `Decoder.calibrate()` holds: empty sky, full health, zero aim error."""
    frame = enc.neutral()
    assert frame.drive == 0.0 and frame.loom == {"L": 0.0, "R": 0.0}
    assert (frame.luminance == 1.0).all() and frame.rejected == 0
    pfl_L = enc.brain.cells(["PFL3"], side="L")
    pfl_R = enc.brain.cells(["PFL3"], side="R")
    assert amounts_of(frame, pfl_L) == pytest.approx(amounts_of(frame, pfl_R))


@pytest.mark.parametrize("phase, over, rejected", [
    # The start screen: `launchers.indexOf(null)` is -1 and there is no health (§6 note 7).
    ("start", {"launchers": [], "weapon": -1,
               "base": {"x": 0.5, "health": 0, "launchers_alive": 0}}, 0),
    ("gameover", {"phase": "gameover", "launchers": [], "base": {"health": 0}}, 0),
    # A key missing altogether is not something #2 emits; it is counted, not tolerated.
    ("keys missing entirely", {"missiles": None, "launchers": None, "base": {}}, 1),
])
def test_non_playing_phases_do_not_raise(enc, phase, over, rejected):
    s = state()
    s.update(over)  # applied after, so a key can be blanked as well as replaced
    frame = enc.encode(s)
    assert np.isfinite(np.concatenate([a for _, a in frame.inject])).all()
    assert frame.drive == 1.0, f"{phase}: no launchers means no health"
    assert frame.launcher_hp == [] and frame.rejected == rejected


def test_retina_is_scanned_once_per_encoder(enc, monkeypatch):
    """`photoreceptor_columns` costs 0.08 s on the real brain — __init__ only (§4)."""
    import src.brain.encoder as mod

    calls = []
    real = mod.photoreceptor_columns
    monkeypatch.setattr(mod, "photoreceptor_columns",
                        lambda *a, **k: (calls.append(a), real(*a, **k))[1])
    e = Encoder(enc.brain)
    for _ in range(3):
        frame = e.encode(state())
    assert len(calls) == 1
    assert len(frame.inject) == 6, "one entry per enabled site"
