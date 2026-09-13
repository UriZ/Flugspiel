"""Mapping config validation — #3 §3.2 M1-M4. A bad config must fail before frame 1."""

import copy
import json

import numpy as np
import pytest

from src.brain.encoder import SIGNALS, Encoder
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping, MappingError
from tests.conftest import make_brain


def cfg(**over) -> dict:
    """The default mapping as a dict, with top-level keys replaced."""
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    raw.update(copy.deepcopy(over))
    return raw


def test_default_mapping_loads():
    m = Mapping.default()
    assert m.game == "missile_attack" and m.version == 1 and m.columns == 36
    assert len(m.sites) == 8
    assert [s.name for s in m.sites if s.prosthesis] == ["aim_bias_L", "aim_bias_R", "weapon_bias"]
    assert m.aim["zero"] is None, "a pinned zero would bias the crosshair (§2.4)"
    assert all(s.signal in SIGNALS for s in m.sites)


def test_unknown_signal_raises():
    sites = cfg()["sites"]
    # By name, not by index: a site added or reordered in the shipped config must not
    # silently retarget this test at a different site.
    i = next(i for i, s in enumerate(sites) if s["name"] == "looming_L")
    sites[i] = {**sites[i], "signal": "loom_up"}
    with pytest.raises(MappingError, match="looming_L.*loom_up"):
        Mapping.load(cfg(sites=sites))


def test_unknown_cell_type_raises_at_construction():
    """M3 — at Encoder.__init__, not at encode(). `make_brain`'s types are all "X"."""
    brain = make_brain(np.zeros((3, 3), dtype=np.float32))
    with pytest.raises(MappingError, match="absent from this brain"):
        Encoder(brain)


@pytest.mark.parametrize("over, match", [
    ({"columns": 0}, "columns"),
    ({"columns": 36.0}, "columns"),
    ({"version": 2}, "version"),
    ({"max_inject": float("inf")}, "max_inject"),
    ({"drive_mod_k": -1.0}, "drive_mod_k"),
    ({"fire": {"types": ["DNp01"], "tau": 0.25, "on_hz": 1.0, "off_hz": 1.0}}, "on_hz"),
    ({"fire": {"types": ["DNp01"], "tau": 0.0, "on_hz": 3.0, "off_hz": 1.0}}, "tau"),
    ({"fire": {"types": [], "tau": 0.25, "on_hz": 3.0, "off_hz": 1.0}}, "types"),
    ({"fire": {"types": "DNp01", "tau": 0.25, "on_hz": 3.0, "off_hz": 1.0}}, "types"),
])
def test_invalid_numerics_raise(over, match):
    with pytest.raises(MappingError, match=match):
        Mapping.load(cfg(**over))


@pytest.mark.parametrize("key, value, match", [
    ("dead", 1.0, "dead"),
    ("dead", -0.1, "dead"),
    ("tau", 0.0, "tau"),
    ("y_policy", "brain", "y_policy"),
    ("y_default", 1.5, "y_default"),
    ("types", [], "types"),
])
def test_invalid_aim_raises(key, value, match):
    with pytest.raises(MappingError, match=match):
        Mapping.load(cfg(aim={**Mapping.default().aim, key: value}))


def test_duplicate_site_name_raises():
    sites = cfg()["sites"]
    sites[2] = {**sites[2], "name": sites[1]["name"]}
    with pytest.raises(MappingError, match="duplicate site name"):
        Mapping.load(cfg(sites=sites))


@pytest.mark.parametrize("over, match", [
    ({"gain": -0.1}, "gain"),
    ({"gain": None}, "gain"),
    ({"side": "left"}, "side"),
    ({"gain_mod": "health"}, "gain_mod"),
    ({"name": ""}, "name"),
])
def test_invalid_site_raises(over, match):
    sites = cfg()["sites"]
    sites[0] = {**sites[0], **over}
    with pytest.raises(MappingError, match=match):
        Mapping.load(cfg(sites=sites))


def test_load_from_missing_path_raises(tmp_path):
    with pytest.raises(MappingError, match="not found"):
        Mapping.load(tmp_path / "nope.json")


def test_load_from_bad_json_raises(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    with pytest.raises(MappingError, match="not valid JSON"):
        Mapping.load(bad)
