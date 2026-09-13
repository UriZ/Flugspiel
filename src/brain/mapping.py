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

# `reward._disclose` distinguishes "no site" from "nobody could say" with these two
# words inside the site list, because a sentinel beside the list does not survive being
# grepped out of a log (#7 §8, #48). That only works while no real site can be called
# either, so the names are reserved here rather than hoped about there.
RESERVED_SITE_NAMES = ("none", "unknown")

SIDES = (None, "L", "R", "M")
GAIN_MODS = (None, "drive")
Y_POLICIES = ("threat", "fixed")
AIM_MODES = ("laterality", "readout")

# Every key each object may carry. Anything else is rejected at load: a mapping is read
# with `.get(key, default)` throughout, so a misspelled key does not fail — it silently
# selects the default. `"prostesis": true` would ship `aim_bias` injecting at full gain
# while `EncodedFrame.prosthetic_sites` denied it existed, and #7's honesty clause rests
# on that flag. A disclosure that fails open is worse than none.
# `reward` is listed but never read here: `RewardConfig.load` parses it out of the same
# file. It has to be in the allowlist anyway, because `_only` below rejects any key it
# does not know and would otherwise refuse the whole mapping (#7 §11 assumed it would be
# tolerated; the allowlist landed after that was checked).
TOP_KEYS = ("version", "game", "columns", "max_inject", "hex_flip", "sites", "drive_mod_k",
            "loom", "retina", "aim", "fire", "weapon", "reward")
SITE_KEYS = ("name", "types", "side", "signal", "gain", "gain_mod", "prosthesis", "enabled",
             "code", "code_seed")
CHANNEL_KEYS = ("types", "tau", "on_hz", "off_hz", "spikes_per_action", "enabled")
LOOM_KEYS = ("y_ground", "tau", "ttc_min", "side_flip")
RETINA_KEYS = ("spread_cols",)
AIM_KEYS = ("types", "tau", "dead", "k_turn", "zero", "invert", "y_policy", "y_default",
            "mode", "readout", "tau_servo", "rate_max")


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
    code: str | None       # None, or an `encoder.CODE_MAPS` name: this site's own azimuth
                           # column per neuron, instead of the shared photoreceptor vote
    code_seed: int | None  # required by a code that draws its map, rejected by one that
                           # derives it — an unseeded arbitrary basis is unreproducible


@dataclass(frozen=True)
class Channel:
    """One readout channel: a population, an EMA time constant and a Schmitt band."""

    types: tuple[str, ...]
    tau: float
    on_hz: float
    off_hz: float
    spikes_per_action: float | None  # pooled spikes above off_hz per repeat; None = edge only
    enabled: bool                    # False: the rate is still measured, never acted on


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

        # The resolution of the luminance image, and nothing more. It used to have to equal
        # the connectome's `ol_hex1` range or the azimuth map silently corrupted (#28);
        # `photoreceptor_columns` now rescales that range onto it, so any value works. What
        # it cannot do is add detail the brain does not have: the fly's angular resolution
        # is fixed at however many hex columns the connectome annotates (36 here), so above
        # that the photoreceptors undersample a finer image rather than seeing more.
        # 2 and not 1: the whole design is bilateral, and both the encoder's loom routing
        # and the decoder's same-half test split on `column(x) < columns/2`. At 1 every
        # position is on the left, so `loom_R` is pinned at 0 and half the fire pathway is
        # dead — silently, which is the same class of defect as the range mismatch above.
        columns = raw.get("columns")
        if not isinstance(columns, int) or isinstance(columns, bool) or columns < 2:
            raise MappingError(f"columns must be an int >= 2, got {columns!r}")
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
        # `laterality` is the default so a mapping written before the fitted readout
        # existed still loads. The readout keys are validated only in the mode that reads
        # them, for the same reason.
        aim.setdefault("mode", "laterality")
        if aim["mode"] not in AIM_MODES:
            raise MappingError(f"aim.mode must be one of {AIM_MODES}, got {aim['mode']!r}")
        if aim["mode"] == "readout":
            name = aim.get("readout")
            if not isinstance(name, str) or not name:
                raise MappingError("aim.readout must name a file in mappings/ when "
                                   "aim.mode is 'readout'")
            aim["readout"] = (DEFAULT_MAPPING_PATH.parent / name).resolve()
            _num(aim, "tau_servo", "aim", low=1e-9)
            _num(aim, "rate_max", "aim", low=1e-9)

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


def _vector_signals() -> frozenset:
    """Signals with one value per azimuth column. Late import, as above."""
    from .encoder import VECTOR_SIGNALS

    return VECTOR_SIGNALS


def _known_codes() -> dict[str, bool]:
    """Code map name -> whether it needs a `code_seed`. Late import, as above."""
    from .encoder import CODE_MAPS

    return {name: needs_seed for name, (_, needs_seed) in CODE_MAPS.items()}


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


def _code(entry: dict, name: str) -> tuple[str | None, int | None]:
    """A site's own azimuth column map, and the seed it does or does not take.

    The seed is not optional-with-a-default: a map that draws its columns is a different
    map under every seed, so an unseeded one cannot be reproduced from the config that
    ran it. A map that derives its columns from the connectome rejects a seed rather than
    ignoring one, because a seed that changes nothing reads as a knob that does.
    """
    code = entry.get("code")
    seed = entry.get("code_seed")
    if code is None:
        if seed is not None:
            raise MappingError(f"site {name!r}: code_seed without a code")
        return None, None
    codes = _known_codes()
    if code not in codes:
        raise MappingError(f"site {name!r}: unknown code {code!r}; "
                           f"known codes are {sorted(codes)}")
    # A code assigns one azimuth column per neuron, which is only meaningful for a signal
    # that has a value per column. Paired with a scalar signal the encoder would index a
    # 0-d array on the first frame, which is exactly the "fails at frame 1" that every
    # other check in this module exists to prevent.
    if entry.get("signal") not in _vector_signals():
        raise MappingError(f"site {name!r}: code {code!r} needs a per-column signal; "
                           f"{entry.get('signal')!r} is a scalar")
    if codes[code] and (not isinstance(seed, int) or isinstance(seed, bool)):
        raise MappingError(f"site {name!r}: code {code!r} requires an integer code_seed, "
                           f"got {seed!r}")
    if not codes[code] and seed is not None:
        raise MappingError(f"site {name!r}: code {code!r} is derived from the connectome "
                           f"and takes no code_seed")
    return code, None if seed is None else int(seed)


def _site(entry: Any, signals: Sequence[str]) -> Site:
    if not isinstance(entry, dict):
        raise MappingError(f"each site must be an object, got {entry!r}")
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        raise MappingError(f"site name must be a non-empty string, got {name!r}")
    if name.lower() in RESERVED_SITE_NAMES:
        raise MappingError(f"site name {name!r} is reserved: the reward loop's disclosure "
                           f"uses {list(RESERVED_SITE_NAMES)} inside the site list to say "
                           f"'no sites' and 'not known', and a site by that name would be "
                           f"indistinguishable from either (#48)")
    _only(entry, SITE_KEYS, f"site {name!r}")
    if entry.get("signal") not in signals:
        raise MappingError(f"site {name!r}: unknown signal {entry.get('signal')!r}; "
                           f"known signals are {sorted(signals)}")
    if entry.get("side") not in SIDES:
        raise MappingError(f"site {name!r}: side must be one of {SIDES}, got {entry.get('side')!r}")
    if entry.get("gain_mod") not in GAIN_MODS:
        raise MappingError(f"site {name!r}: gain_mod must be one of {GAIN_MODS}, "
                           f"got {entry.get('gain_mod')!r}")
    code, code_seed = _code(entry, name)
    return Site(
        name=name, types=_types(entry.get("types"), f"site {name!r}"), side=entry.get("side"),
        signal=entry["signal"], gain=_num(entry, "gain", f"site {name!r}", low=0.0),
        gain_mod=entry.get("gain_mod"), prosthesis=bool(entry.get("prosthesis", False)),
        enabled=bool(entry.get("enabled", True)), code=code, code_seed=code_seed,
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
                   else _num(entry, "spikes_per_action", where, low=1e-9),
                   enabled=bool(entry.get("enabled", True)))


# ------------------------------------------------------- geometry shared by both modules


def column(x: Any, columns: int) -> np.ndarray:
    """Screen x (normalised, unclamped) → azimuth column index, clamped to [0, columns-1].

    The result is used as an **array index**, and the clamp alone does not make it one:
    `np.clip` passes a NaN through and `float('nan').astype(int64)` is INT64_MIN, which
    indexes nothing and raises out of the encoder's luminance lookup (#35). Infinities
    the clamp does handle. Both call sites pass values that `_finite`/`_num` have already
    coerced, so this is unreachable from the wire today — it is guarded because `column`
    is a public helper and an index is the wrong place to find out.
    """
    c = np.floor(np.nan_to_num(np.asarray(x, dtype=np.float64)) * columns)
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
