"""Config model for the game↔brain mapping — #3 §3.2, §4.

Every neuron name, gain, threshold and time constant the encoder injects into or the
decoder reads from lives in a JSON file, not in Python (AC5). This module parses one,
validates it eagerly and hands back frozen dataclasses. `MappingError` is raised at
load time only: a bad config must fail before the first frame, never mid-game.

It also holds the two pure geometry functions both `encoder` and `decoder` need
(`column`, `loom`). They are parameterised entirely by config, and putting them here is
what lets the encoder and the decoder stay independent of each other (§3.1) without
either duplicating the measured looming formula.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np

DEFAULT_MAPPING_PATH = Path(__file__).resolve().parent / "mappings" / "missile_attack.json"

SIDES = (None, "L", "R", "M")
GAIN_MODS = (None, "drive")
Y_POLICIES = ("threat", "fixed")

# Every key each object may carry. Anything else is rejected at load: a mapping is read
# with `.get(key, default)` throughout, so a misspelled key does not fail — it silently
# selects the default. `"prostesis": true` would ship `aim_bias` injecting at full gain
# while `EncodedFrame.prosthetic_sites` denied it existed, and #7's honesty clause rests
# on that flag. A disclosure that fails open is worse than none.
TOP_KEYS = ("version", "game", "columns", "max_inject", "hex_flip", "sites", "drive_mod_k",
            "loom", "retina", "aim", "fire", "weapon")
SITE_KEYS = ("name", "types", "side", "signal", "gain", "gain_mod", "prosthesis", "enabled")
CHANNEL_KEYS = ("types", "tau", "on_hz", "off_hz", "spikes_per_action")
LOOM_KEYS = ("y_ground", "tau", "ttc_min", "side_flip")
RETINA_KEYS = ("spread_cols",)
AIM_KEYS = ("types", "tau", "dead", "k_turn", "zero", "invert", "y_policy", "y_default")


class MappingError(ValueError):
    """A mapping config that cannot be trusted to run."""


@dataclass(frozen=True)
class Site:
    """One injection site: a neuron population, a signal name and a gain."""

    name: str
    types: tuple[str, ...]
    side: str | None
    signal: str
    gain: float
    gain_mod: str | None   # None, or "drive" for gain·(1 + drive_mod_k·drive)
    prosthesis: bool       # a shortcut past the fly's own circuitry; #7 must disclose it
    enabled: bool


@dataclass(frozen=True)
class Channel:
    """One readout channel: a population, an EMA time constant and a Schmitt band."""

    types: tuple[str, ...]
    tau: float
    on_hz: float
    off_hz: float
    spikes_per_action: float | None  # pooled spikes above off_hz per repeat; None = edge only


@dataclass(frozen=True)
class Mapping:
    version: int
    game: str
    columns: int
    max_inject: float
    hex_flip: dict[str, bool]
    sites: tuple[Site, ...]
    drive_mod_k: float
    loom: dict[str, Any]
    retina: dict[str, Any]
    aim: dict[str, Any]
    fire: Channel
    weapon: Channel

    @classmethod
    def load(cls, source: str | Path | dict) -> "Mapping":
        """Parse and validate a mapping from a JSON file path or an already-parsed dict."""
        if isinstance(source, dict):
            raw = source
        else:
            path = Path(source)
            if not path.exists():
                raise MappingError(f"{path} not found")
            try:
                raw = json.loads(path.read_text())
            except json.JSONDecodeError as exc:
                raise MappingError(f"{path} is not valid JSON ({exc})") from exc
        return cls._build(raw)

    @classmethod
    def default(cls) -> "Mapping":
        return cls.load(DEFAULT_MAPPING_PATH)

    @classmethod
    def _build(cls, raw: dict) -> "Mapping":
        _only(raw, TOP_KEYS, "mapping")
        if raw.get("version") != 1:
            raise MappingError(f"unsupported mapping version {raw.get('version')!r}, expected 1")
        game = raw.get("game")
        if not isinstance(game, str) or not game:
            raise MappingError("game must be a non-empty string")

        columns = raw.get("columns")
        if not isinstance(columns, int) or isinstance(columns, bool) or columns < 1:
            raise MappingError(f"columns must be an int >= 1, got {columns!r}")
        max_inject = _num(raw, "max_inject", "mapping", low=1e-9)

        hex_flip = raw.get("hex_flip", {})
        if not isinstance(hex_flip, dict) or not all(isinstance(v, bool) for v in hex_flip.values()):
            raise MappingError(f"hex_flip must be a dict of side -> bool, got {hex_flip!r}")

        sites, seen = [], set()
        signals = _known_signals()
        for entry in raw.get("sites", ()):
            site = _site(entry, signals)
            if site.name in seen:
                raise MappingError(f"duplicate site name {site.name!r}")
            seen.add(site.name)
            sites.append(site)
        if not sites:
            raise MappingError("mapping has no sites")

        loom = dict(raw.get("loom", {}))
        _only(loom, LOOM_KEYS, "loom")
        _num(loom, "y_ground", "loom")
        _num(loom, "tau", "loom", low=1e-9)
        _num(loom, "ttc_min", "loom", low=1e-9)
        loom.setdefault("side_flip", False)

        retina = dict(raw.get("retina", {}))
        _only(retina, RETINA_KEYS, "retina")
        _num(retina, "spread_cols", "retina", low=1e-9)

        aim = dict(raw.get("aim", {}))
        _only(aim, AIM_KEYS, "aim")
        aim["types"] = _types(aim.get("types"), "aim")
        _num(aim, "tau", "aim", low=1e-9)
        _num(aim, "k_turn", "aim", low=0.0)
        dead = _num(aim, "dead", "aim", low=0.0)
        if dead >= 1.0:
            raise MappingError(f"aim.dead must be in [0, 1), got {dead}")
        if aim.get("zero") is not None:
            _num(aim, "zero", "aim")
        y_default = _num(aim, "y_default", "aim", low=0.0)
        if y_default > 1.0:
            raise MappingError(f"aim.y_default must be in [0, 1], got {y_default}")
        if aim.get("y_policy") not in Y_POLICIES:
            raise MappingError(f"aim.y_policy must be one of {Y_POLICIES}, got {aim.get('y_policy')!r}")
        aim["invert"] = bool(aim.get("invert", False))

        return cls(
            version=1, game=game, columns=columns, max_inject=max_inject,
            hex_flip=hex_flip, sites=tuple(sites),
            drive_mod_k=_num(raw, "drive_mod_k", "mapping", low=0.0),
            loom=loom, retina=retina, aim=aim,
            fire=_channel(raw.get("fire"), "fire"), weapon=_channel(raw.get("weapon"), "weapon"),
        )


def _known_signals() -> Sequence[str]:
    # Imported late, not at module scope: `encoder` imports this module, and the signal
    # functions belong next to the GameState fields they read (§7).
    from .encoder import SIGNALS

    return tuple(SIGNALS)


def _only(d: dict, known: Sequence[str], where: str) -> None:
    """Reject unknown keys. See the comment on `TOP_KEYS`: typos must not fail open."""
    extra = sorted(k for k in d if k not in known)
    if extra:
        raise MappingError(f"{where}: unknown key(s) {extra}; known keys are {sorted(known)}")


def _num(d: dict, key: str, where: str, *, low: float | None = None) -> float:
    v = d.get(key)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not np.isfinite(v):
        raise MappingError(f"{where}.{key} must be a finite number, got {v!r}")
    if low is not None and v < low:
        raise MappingError(f"{where}.{key} must be >= {low}, got {v}")
    return float(v)


def _types(v: Any, where: str) -> tuple[str, ...]:
    if isinstance(v, str) or not isinstance(v, (list, tuple)) or not v:
        raise MappingError(f"{where}.types must be a non-empty list of cell-type names, got {v!r}")
    if not all(isinstance(t, str) and t for t in v):
        raise MappingError(f"{where}.types must contain only non-empty strings, got {v!r}")
    return tuple(v)


def _site(entry: Any, signals: Sequence[str]) -> Site:
    if not isinstance(entry, dict):
        raise MappingError(f"each site must be an object, got {entry!r}")
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        raise MappingError(f"site name must be a non-empty string, got {name!r}")
    _only(entry, SITE_KEYS, f"site {name!r}")
    if entry.get("signal") not in signals:
        raise MappingError(f"site {name!r}: unknown signal {entry.get('signal')!r}; "
                           f"known signals are {sorted(signals)}")
    if entry.get("side") not in SIDES:
        raise MappingError(f"site {name!r}: side must be one of {SIDES}, got {entry.get('side')!r}")
    if entry.get("gain_mod") not in GAIN_MODS:
        raise MappingError(f"site {name!r}: gain_mod must be one of {GAIN_MODS}, "
                           f"got {entry.get('gain_mod')!r}")
    return Site(
        name=name, types=_types(entry.get("types"), f"site {name!r}"), side=entry.get("side"),
        signal=entry["signal"], gain=_num(entry, "gain", f"site {name!r}", low=0.0),
        gain_mod=entry.get("gain_mod"), prosthesis=bool(entry.get("prosthesis", False)),
        enabled=bool(entry.get("enabled", True)),
    )


def _channel(entry: Any, where: str) -> Channel:
    if not isinstance(entry, dict):
        raise MappingError(f"{where} must be an object, got {entry!r}")
    _only(entry, CHANNEL_KEYS, where)
    on_hz = _num(entry, "on_hz", where, low=0.0)
    off_hz = _num(entry, "off_hz", where, low=0.0)
    if on_hz <= off_hz:
        raise MappingError(f"{where}: on_hz ({on_hz}) must exceed off_hz ({off_hz}) — "
                           f"a Schmitt trigger with no hysteresis chatters")
    per = entry.get("spikes_per_action")
    return Channel(types=_types(entry.get("types"), where), tau=_num(entry, "tau", where, low=1e-9),
                   on_hz=on_hz, off_hz=off_hz,
                   spikes_per_action=None if per is None
                   else _num(entry, "spikes_per_action", where, low=1e-9))


# ------------------------------------------------------- geometry shared by both modules


def column(x: Any, columns: int) -> np.ndarray:
    """Screen x (normalised, unclamped) → azimuth column index, clamped to [0, columns-1]."""
    c = np.floor(np.asarray(x, dtype=np.float64) * columns)
    return np.clip(c, 0, columns - 1).astype(np.int64)


def loom(y: Any, vy: Any, cfg: dict) -> np.ndarray:
    """Looming strength in [0, 1] from time-to-contact with the launcher row (#3 §3.3).

    `vy <= 0` (rising, or stationary) is 0 — nothing that is not closing looms. Past the
    launcher row is 1. Otherwise tau / max(ttc, ttc_min), clipped.
    """
    y = np.asarray(y, dtype=np.float64)
    vy = np.asarray(vy, dtype=np.float64)
    closing = vy > 0
    ttc = np.where(closing, (cfg["y_ground"] - y) / np.where(closing, vy, 1.0), np.inf)
    val = np.clip(cfg["tau"] / np.maximum(ttc, cfg["ttc_min"]), 0.0, 1.0)
    return np.where(closing, np.where(ttc <= 0, 1.0, val), 0.0)
