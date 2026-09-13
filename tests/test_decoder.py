"""Decoder — #3 §3.5 D1-D13. Synthetic spike trains only: no connectome, no network."""

import copy
import json
import math

import numpy as np
import pytest

from src.brain.decoder import WEAPONS, Decoder
from src.brain.encoder import Encoder
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping
from tests.conftest import make_brain, make_meta

TYPES = ("DNa02", "DNa02", "DNp01", "DNp01", "DNg100", "MDN", "ALT", "ALT")
SIDES = ("L", "R", "L", "R", "L", "L", "L", "R")
DT = 0.02


def cfg(**over) -> dict:
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    raw.update(copy.deepcopy(over))
    return raw


def toy_brain():
    """8 neurons, one per readout population, so `fired` arrays are hand-writable."""
    n = len(TYPES)
    return make_brain(np.zeros((n, n), dtype=np.float32),
                      make_meta(n, cell_type=list(TYPES), side=list(SIDES)))


@pytest.fixture
def dec():
    d = Decoder(toy_brain())
    d.aim_zero = 0.0  # calibration is tested separately; D-tests pin the zero
    return d


@pytest.fixture
def wdec():
    """A decoder with the weapon channel turned on.

    The shipped config turns it off (#27): nothing injects into DNg100/MDN, and the band
    sat inside the channel's own resting EMA, so it switched launcher on network activity
    alone. The mechanism still has to work for whoever wires a real signal to it, so D9
    tests it here rather than through the default config.
    """
    d = Decoder(toy_brain(), Mapping.load(cfg(weapon={**cfg()["weapon"], "enabled": True})))
    d.aim_zero = 0.0
    return d


def state(missiles=(), weapon=0) -> dict:
    return {"phase": "playing", "weapon": weapon, "base": {"x": 0.5, "health": 1.0},
            "launchers": [], "interceptors": [],
            "missiles": [{"kind": "missile", "x": 0.5, "y": 0.4, "vx": 0.0, "vy": 0.0, **m}
                         for m in missiles]}


def drive(dec, *, steps, cells=(), dt=DT):
    """`steps` brain steps in which exactly `cells` fire every step."""
    fired = np.asarray(cells, dtype=np.int64)
    for _ in range(steps):
        dec.observe(fired, dt)


def assert_bridge_accepts(msg):
    """Mirror of `FlyBridge._validate` (fly-bridge.js:114-152) — D10."""
    assert set(msg) <= {"action", "x", "y", "weapon_switch"}, f"extra keys in {msg}"
    assert msg["action"] in {"fire", "aim", "noop"}
    needs_coords = msg["action"] in {"fire", "aim"}
    assert ("x" in msg) == needs_coords and ("y" in msg) == needs_coords
    for key in ("x", "y") if needs_coords else ():
        v = msg[key]
        assert isinstance(v, float) and math.isfinite(v) and 0.0 <= v <= 1.0, f"{key}={v!r}"
    if "weapon_switch" in msg:
        w = msg["weapon_switch"]
        assert isinstance(w, int) and not isinstance(w, bool) and 0 <= w <= 6, f"{w!r}"


# --------------------------------------------------------------------------- D1


def test_ema_converges(dec):
    """A 10 Hz pooled train settles the EMA on 10 Hz within 5 tau."""
    tau = dec.mapping.fire.tau
    p01 = dec.brain.cells(["DNp01"])[:1]
    trace = []
    for step in range(int(20 * tau / DT)):
        dec.observe(p01 if step % 5 == 0 else np.empty(0, np.int64), DT)  # 1 spike / 5 steps
        trace.append(dec.rates["fire"])
    settled = trace[int(5 * tau / DT):]
    assert np.mean(settled) == pytest.approx(10.0, abs=1.0)
    assert max(settled) < 14.0 and min(settled) > 6.0, "EMA ripple, not a rate"


def test_ema_is_pooled_not_per_neuron(dec):
    """`spike_count / dt` over the whole population — the quantity on_hz was measured on."""
    both = dec.brain.cells(["DNp01"])
    drive(dec, steps=500, cells=both)
    assert dec.rates["fire"] == pytest.approx(len(both) / DT, rel=1e-3)


# --------------------------------------------------------------------------- D2, D3, D4


def test_laterality_index_range(dec):
    rng = np.random.default_rng(0)
    pairs = rng.random((10_000, 2)) * 200.0
    pairs[:50] = 0.0
    for left, right in pairs:
        dec.rates["aim_L"], dec.rates["aim_R"] = float(left), float(right)
        assert -1.0 <= dec._index() <= 1.0


def test_crosshair_bounded(dec):
    rng = np.random.default_rng(1)
    k = dec.mapping.aim["k_turn"]
    for value in rng.uniform(-500, 500, 10_000):
        dec.rates["aim_L"], dec.rates["aim_R"] = max(value, 0.0), max(-value, 0.0)
        before = dec.crosshair_x
        msg = dec.decode(state(), 0.05)
        assert 0.0 <= dec.crosshair_x <= 1.0
        assert abs(dec.crosshair_x - before) <= k * 0.05 + 1e-12
        assert_bridge_accepts(msg)


def test_dead_zone_exact(dec):
    dead = dec.mapping.aim["dead"]
    for index in (0.0, dead * 0.5, dead, -dead):
        dec.reset(readout=True)
        dec.aim_zero = 0.0
        dec.rates["aim_L"] = (1 + index) * 10
        dec.rates["aim_R"] = (1 - index) * 10
        assert abs(dec._index()) <= dead + 1e-9
        assert dec.decode(state(), 0.05) == {"action": "noop"}
        assert dec.crosshair_x == 0.5, "inside the dead zone the crosshair must not drift"


def test_dead_zone_rescales_to_full_range(dec):
    dead = dec.mapping.aim["dead"]
    dec.rates["aim_L"], dec.rates["aim_R"] = 100.0, 0.0
    assert dec._command() == pytest.approx(1.0, abs=1e-3), "the rails stay reachable"
    dec.rates["aim_L"], dec.rates["aim_R"] = 0.0, 100.0
    assert dec._command() == pytest.approx(-1.0, abs=1e-3)


# --------------------------------------------------------------------------- D5


def test_aim_sign_convention(dec):
    """Normative: DNa02-L alone ⇒ index > 0 ⇒ x increases (screen right)."""
    left, right = dec.brain.cells(["DNa02"], side="L"), dec.brain.cells(["DNa02"], side="R")
    drive(dec, steps=100, cells=left)
    assert dec._index() > 0
    assert dec.decode(state(), 0.1)["x"] > 0.5

    dec.reset(readout=True)
    dec.aim_zero = 0.0
    drive(dec, steps=100, cells=right)
    assert dec._index() < 0
    assert dec.decode(state(), 0.1)["x"] < 0.5


def test_aim_invert_flips_both(dec):
    inverted = Decoder(dec.brain, Mapping.load(cfg(aim={**dec.mapping.aim, "invert": True})))
    inverted.aim_zero = 0.0
    drive(inverted, steps=100, cells=inverted.brain.cells(["DNa02"], side="L"))
    assert inverted.decode(state(), 0.1)["x"] < 0.5


def test_measured_zero_is_subtracted(dec):
    """§2.4: the index sits at +0.365 under a symmetric command. Ignoring it drifts right."""
    dec.rates["aim_L"], dec.rates["aim_R"] = 6.0, 4.0
    biased = dec._index()
    dec.aim_zero = biased
    assert dec._command() == 0.0
    dec.aim_zero = 0.0
    assert dec._command() > 0.0


# --------------------------------------------------------------------------- D6, D7


def test_fire_schmitt(dec):
    """One rising edge per excursion above on_hz; a dip into the band is not a second."""
    on, off = dec.mapping.fire.on_hz, dec.mapping.fire.off_hz
    fires = []
    for rate in (0.0, on / 2, on, on * 2, (on + off) / 2, on * 2, off / 2, 0.0, on * 2):
        dec.rates["fire"] = rate
        msg = dec.decode(state(), 0.05)
        fires.append(msg["action"] == "fire")
        assert_bridge_accepts(msg)
    assert fires == [False, False, True, False, False, False, False, False, True]


def test_fire_sustains_under_a_held_burst(dec):
    """Spike level: a held DNp01 burst keeps firing, and stops once the EMA decays (#25).

    This pinned the opposite before #25 — one fire per *excursion*, whatever the burst
    did after the edge. Real looming holds DNp01 above `off_hz` for the whole approach,
    so that rule went silent exactly when a missile was about to land.
    """
    p01 = dec.brain.cells(["DNp01"])
    burst, tail = 0, 0
    for cells in (p01, np.empty(0, np.int64)):
        for _ in range(40):
            drive(dec, steps=5, cells=cells)
            fired = dec.decode(state(), 5 * DT)["action"] == "fire"
            if len(cells):
                burst += fired
            else:
                tail += fired
    assert burst > 20, burst
    assert tail <= 5, "the EMA decays through the band and then the channel goes quiet"


def test_reject_does_not_consume_fire(dec):
    dec.rates["fire"] = 50.0
    assert dec.decode(state(), 0.05)["action"] == "fire"
    dec.on_result({"ok": False, "reason": "not_playing"})
    assert dec.decode(state(), 0.05)["action"] == "fire", "a rejected fire must be re-offered"
    assert dec.stats["fired"] == 1
    dec.on_result({"ok": True})
    assert dec.decode(state(), 0.05)["action"] != "fire", "an accepted fire is consumed"
    assert dec.stats["rejected"] == {"not_playing": 1}


def test_unconfirmed_latch_is_treated_as_committed(dec):
    """#4 is not obliged to be synchronous; re-offering forever would spam the game."""
    dec.rates["fire"] = 50.0
    assert dec.decode(state(), 0.05)["action"] == "fire"
    assert dec.decode(state(), 0.05)["action"] != "fire"


# --------------------------------------------------------------------------- D8


def test_detached_is_terminal(dec):
    dec.rates["fire"] = 50.0
    dec.decode(state(), 0.05)
    dec.on_result({"ok": False, "reason": "detached"})
    assert dec.halted

    # A halted decoder must stay silent under input that would otherwise emit: a *fresh*
    # fire edge (the latch released first) and a one-sided DNa02 drive that would aim.
    for _ in range(10):
        dec.rates["fire"] = 0.0
        assert dec.decode(state(), 0.05) == {"action": "noop"}
        dec.rates["fire"] = 50.0
        drive(dec, steps=20, cells=dec.brain.cells(["DNa02"], side="L"))
        assert dec.decode(state(), 0.05) == {"action": "noop"}
        assert dec.crosshair_x == 0.5, "a halted decoder must not move the crosshair either"
    dec.on_result({"ok": True})
    assert dec.decode(state(), 0.05) == {"action": "noop"}, "never retried"


# --------------------------------------------------------------------------- D9


def test_weapon_ring_cycles(wdec):
    wdec.rates["weapon"] = 50.0
    assert wdec.decode(state(weapon=2), 0.05)["weapon_switch"] == 3
    wdec.on_result({"ok": True})
    wdec.rates["weapon"] = 0.0
    wdec.decode(state(), 0.05)
    wdec.rates["weapon"] = 50.0
    assert wdec.decode(state(weapon=6), 0.05)["weapon_switch"] == 0, "wraps"


def test_weapon_ring_skips_dead(wdec):
    wdec.rates["weapon"] = 50.0
    assert wdec.decode(state(weapon=0), 0.05)["weapon_switch"] == 1
    wdec.on_result({"ok": False, "reason": "launcher_dead"})
    assert wdec.decode(state(weapon=0), 0.05)["weapon_switch"] == 2
    wdec.on_result({"ok": False, "reason": "launcher_dead"})
    assert wdec.stats["weapon_switches"] == 0, "a rejected switch never counts as fired"

    for _ in range(WEAPONS):
        msg = wdec.decode(state(weapon=0), 0.05)
        if "weapon_switch" in msg:
            wdec.on_result({"ok": False, "reason": "launcher_dead"})
    assert "weapon_switch" not in wdec.decode(state(weapon=0), 0.05), "all dead ⇒ omitted"


def test_weapon_switch_rides_along_with_the_action(wdec):
    wdec.rates["weapon"] = 50.0
    wdec.rates["fire"] = 50.0
    msg = wdec.decode(state(weapon=1), 0.05)
    assert msg["action"] == "fire" and msg["weapon_switch"] == 2
    assert_bridge_accepts(msg)


def test_weapon_switch_handles_start_screen(wdec):
    """`weapon` is -1 on the start screen (`indexOf(null)`), so the ring starts at 0."""
    wdec.rates["weapon"] = 50.0
    assert wdec.decode(state(weapon=-1), 0.05)["weapon_switch"] == 0


# --------------------------------------------------------------------------- D10, D11, D12


def test_output_passes_bridge_validation(dec):
    rng = np.random.default_rng(2)
    cells = np.arange(len(TYPES), dtype=np.int64)
    for _ in range(1_000):
        dec.observe(cells[rng.random(len(TYPES)) < 0.5], DT)
        assert_bridge_accepts(dec.decode(state([{"x": float(rng.random())}]), 0.05))


def test_silence_gives_noop(dec):
    for _ in range(500):
        dec.observe(np.empty(0, np.int64), DT)
        assert dec.decode(state(), 0.05) == {"action": "noop"}
    assert dec.crosshair_x == 0.5, "no spikes anywhere must never move the crosshair"


def test_decode_rate_independent_of_step_rate(dec):
    """D12 — actions per second of *brain* time, not per decode tick.

    One DNp01 neuron, not both: a channel is capped at one action per `decode()` call, so
    two neurons saturate that ceiling at the coarser ratio and the comparison stops being
    about the ratio at all. The same run length in brain time on both sides.
    """
    one = dec.brain.cells(["DNp01"])[:1]
    counts = []
    for per_tick in (1, 5):
        dec.reset(readout=True)
        dec.aim_zero = 0.0
        fires = 0
        for _ in range(250 // per_tick):
            drive(dec, steps=per_tick, cells=one)
            msg = dec.decode(state(), per_tick * DT)
            assert_bridge_accepts(msg)
            fires += msg["action"] == "fire"
        counts.append(fires)
    assert abs(counts[0] - counts[1]) <= 2, counts


# --------------------------------------------------------------------------- D13


def test_config_reroutes_readout(dec):
    """AC5 — swapping `aim.types` makes the decoder read a different population."""
    rerouted = Decoder(dec.brain, Mapping.load(cfg(aim={**dec.mapping.aim, "types": ["ALT"]})))
    rerouted.aim_zero = 0.0
    alt_L = rerouted.brain.cells(["ALT"], side="L")
    drive(rerouted, steps=100, cells=alt_L)
    assert rerouted._index() > 0
    drive(dec, steps=100, cells=alt_L)
    assert dec._index() == 0.0, "the default config must not see ALT at all"


def test_config_retunes_schmitt_bands(dec):
    loud = Decoder(dec.brain, Mapping.load(
        cfg(fire={**cfg()["fire"], "on_hz": 80.0, "off_hz": 10.0})))
    loud.aim_zero = 0.0
    drive(loud, steps=200, cells=loud.brain.cells(["DNp01"]))  # 100 Hz pooled
    assert loud.decode(state(), 0.05)["action"] == "fire"
    quiet = Decoder(dec.brain, Mapping.load(
        cfg(fire={**cfg()["fire"], "on_hz": 200.0, "off_hz": 10.0})))
    quiet.aim_zero = 0.0
    drive(quiet, steps=200, cells=quiet.brain.cells(["DNp01"]))
    assert quiet.decode(state(), 0.05)["action"] == "noop"


# --------------------------------------------------------------------------- aim y


def test_y_comes_from_the_threat_on_the_crosshair_side(dec):
    """AC4 assigns no neuron to elevation, so y is labelled as not from the brain."""
    dec.rates["fire"] = 50.0
    near = {"x": 0.6, "y": 0.7, "vy": 0.3}
    far = {"x": 0.1, "y": 0.2, "vy": 0.3}
    dec.crosshair_x = 0.6
    msg = dec.decode(state([near, far]), 0.05)
    assert msg["y"] == pytest.approx(0.7)
    assert dec.telemetry()["y_source"] == "threat"


def test_y_falls_back_to_default(dec):
    dec.rates["fire"] = 50.0
    dec.crosshair_x = 0.9
    msg = dec.decode(state([{"x": 0.1, "y": 0.2, "vy": 0.3}]), 0.05)
    assert msg["y"] == pytest.approx(dec.mapping.aim["y_default"])
    assert dec.telemetry()["y_source"] == "default", "nothing threatening on this half"


def test_y_policy_fixed_ignores_threats(dec):
    fixed = Decoder(dec.brain, Mapping.load(
        cfg(aim={**dec.mapping.aim, "y_policy": "fixed", "y_default": 0.6})))
    fixed.aim_zero = 0.0
    fixed.rates["fire"] = 50.0
    assert fixed.decode(state([{"x": 0.5, "y": 0.7, "vy": 0.3}]), 0.05)["y"] == pytest.approx(0.6)


# --------------------------------------------------------------------------- calibration


def biased_encoder(brain, gain=1.0):
    """An encoder whose neutral frame drives DNa02-**L** only.

    Reproduces §2.4's awkward finding in miniature: at a symmetric *command* the laterality
    index sits far from zero (measured +0.365 on the real brain), so `calibrate()` has to
    measure it. `aim_err_L` is 0.5 on an empty sky, so this injects `gain/2` per step.
    """
    sites = [{"name": "bias", "types": ["DNa02"], "side": "L", "signal": "aim_err_L",
              "gain": gain, "gain_mod": None, "prosthesis": True, "enabled": True}]
    return Encoder(brain, Mapping.load(cfg(sites=sites)))


def test_calibrate_measures_the_zero_on_this_brain(dec):
    """§2.4: the zero is a property of this brain and seed, not a constant."""
    assert dec.mapping.aim["zero"] is None
    fresh = Decoder(dec.brain)
    assert fresh.aim_zero is None
    zero = fresh.calibrate(biased_encoder(dec.brain, gain=3.0), steps=200, settle=50)
    assert zero == fresh.aim_zero and math.isfinite(zero)
    assert zero > 0.5, f"a one-sided neutral frame must measure a biased zero, got {zero:.3f}"
    assert fresh.crosshair_x == 0.5 and fresh.stats["actions"] == 0

    # And the measured zero is what cancels it: the same frame now commands nothing.
    fresh.calibrate(biased_encoder(dec.brain, gain=3.0), steps=200, settle=50)
    assert fresh._command() == 0.0, "the measured zero must cancel the resting bias"


def test_unmeasured_zero_would_drift(dec):
    """The other half of the above: without calibration the same brain aims right forever."""
    naive = Decoder(dec.brain)
    frame = biased_encoder(dec.brain, gain=3.0).neutral()
    for _ in range(200):
        naive.observe(dec.brain.step(inject=frame.inject), DT)
    assert naive.aim_zero is None and naive._command() > 0.5


def test_calibrate_is_skipped_when_config_pins_the_zero(dec):
    pinned = Decoder(dec.brain, Mapping.load(cfg(aim={**dec.mapping.aim, "zero": 0.25})))
    assert pinned.aim_zero == 0.25
    steps = pinned.brain.steps
    assert pinned.calibrate(biased_encoder(dec.brain)) == 0.25
    assert pinned.brain.steps == steps, "a pinned zero must not step the brain"


def test_telemetry_exposes_every_field_4_and_6_consume(dec):
    keys = {"aim_index", "aim_cmd", "crosshair_x", "aim_zero", "fire_hz", "weapon_hz",
            "y_source", "halted", "stats"}
    assert set(dec.telemetry()) == keys
