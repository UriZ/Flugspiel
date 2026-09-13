"""#40 R8 — does the fly's crosshair follow the threat, in a closed loop, without a prosthesis?

Every other number in #40 is open loop: a frame is injected, the state is recorded, a
regression is fitted offline. None of that proves the *loop* works. Here the crosshair the
decoder produces is fed back into the encoder on every tick, so an unstable servo, a rate
limit that cannot keep up with a falling missile, or a readout that is accurate but lagged
all show up as error where the open-loop R2 would not see them.

**This is not the game.** It drives the real brain through the real `Encoder`/`Decoder`
with synthetic missile trajectories, so it measures the aim channel and not the game's
spawn schedule. The inherited 0.671 / 0.945 ratios were taken against the real upstream
`Game` and are cited, not reproduced, here.

The metric is the one those ratios use: `mean|crosshair - target| / mean|crosshair -
shuffled target|`, where the shuffled series is a permutation of the same target series —
identical marginal distribution, wrong pairing. 1.0 is chance; a crosshair pinned at the
centre scores 1.0 by construction.

Arms, all with the PFL3 prosthesis **off** unless the name says otherwise:

    readout     the shipped encoder + the fitted readout      <- the deliverable
    laterality  the shipped encoder + the hand-written rule    <- what it replaced
    prosthesis  the scalar encoder + laterality + PFL3 on      <- what shipped before

Run:

    .venv/bin/python tools/spike/aim-closed-loop.py --seconds 300 --seeds 3

Output shape (values live in issue #40 and SESSION_LOG.md):

    arm=readout    seed=..  err=..  shuffled=..  ratio=..  rail=..
    arm=readout    MEAN ratio=..
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.brain.decoder import Decoder                         # noqa: E402
from src.brain.encoder import Encoder                         # noqa: E402
from src.brain.lif import FlyBrain                            # noqa: E402
from src.brain.mapping import DEFAULT_MAPPING_PATH, Mapping   # noqa: E402


def _fitter():
    """`tools/fit-aim-readout.py`, imported for its `Sky` and `STEPS_PER_TICK`.

    Awkward, and load-bearing: the readout is fitted against that module's sky and scored
    against this one, so if the two keep separate copies they can drift apart and the
    scoring silently stops describing the thing that was fitted. Measured cost of exactly
    that drift, before this import existed: a readout fitted on one missile scored 0.283
    of shuffled open loop and 0.732 in a three-missile closed loop.
    """
    spec = importlib.util.spec_from_file_location("fit_aim_readout",
                                                  ROOT / "tools" / "fit-aim-readout.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FIT = _fitter()
Sky, STEPS_PER_TICK = FIT.Sky, FIT.STEPS_PER_TICK


def arm_mapping(arm: str) -> Mapping:
    """The shipped config, with exactly the sites and mode this arm is named for."""
    raw = json.loads(DEFAULT_MAPPING_PATH.read_text())
    scalar = arm == "prosthesis"
    for site in raw["sites"]:
        if site["name"] in ("looming_L", "looming_R"):
            site["enabled"] = scalar
        elif site["name"] == "looming_code":
            site["enabled"] = not scalar
        elif site["name"].startswith("aim_bias"):
            site["enabled"] = scalar
    raw["aim"] = {**raw["aim"], "mode": "readout" if arm == "readout" else "laterality"}
    return Mapping.load(raw)


def run(brain: FlyBrain, arm: str, seed: int, ticks: int, missiles: int) -> dict:
    mapping = arm_mapping(arm)
    enc, dec = Encoder(brain, mapping), Decoder(brain, mapping)
    dt = brain.params.dt
    tick_dt = STEPS_PER_TICK * dt
    brain.reset(64)
    for _ in range(200):
        brain.step()
    dec.reset(readout=True)
    if dec.readout is None:
        # The laterality arms need their zero measured on this brain, as they ship.
        dec.calibrate(enc, steps=300, settle=100)
        brain.reset(64)
        for _ in range(200):
            brain.step()
        dec.reset(readout=True)

    sky = Sky(seed, mapping.loom["y_ground"], missiles)
    cross, truth = [], []
    for _ in range(ticks):
        state = sky.state()
        frame = enc.encode(state, dec.crosshair_x)
        for _ in range(STEPS_PER_TICK):
            dec.observe(brain.step(inject=frame.inject), dt)
        dec.decode(state, tick_dt)
        dec.on_result({"ok": True})
        # The target is the threat the decoder is meant to be tracking: the strongest
        # looming missile, which is what the aim signal, `_coords` and the fit all name.
        truth.append(sky.threat_x(mapping.loom))
        cross.append(dec.crosshair_x)
        sky.advance(tick_dt)

    c, t = np.asarray(cross), np.asarray(truth)
    shuffled = np.random.default_rng(seed + 500).permutation(t)
    err, null = float(np.abs(c - t).mean()), float(np.abs(c - shuffled).mean())
    return {"arm": arm, "seed": seed, "err": err, "shuffled": null,
            "ratio": err / null, "rail": float(((c <= 0.001) | (c >= 0.999)).mean()),
            "crosshair_sd": float(c.std())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=300.0, help="game time per session")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--arms", default="readout,laterality,prosthesis")
    ap.add_argument("--missiles", type=int, default=3)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    brain = FlyBrain.load(backend="numba")
    ticks = int(args.seconds / (STEPS_PER_TICK * brain.params.dt))
    print(f"{ticks} ticks/session = {args.seconds:.0f}s of game time, "
          f"{ticks * STEPS_PER_TICK} brain steps", flush=True)

    results = []
    for arm in args.arms.split(","):
        rows = []
        for seed in range(args.seeds):
            t0 = time.perf_counter()
            r = run(brain, arm, seed, ticks, args.missiles)
            rows.append(r)
            results.append(r)
            print(f"arm={arm:11s} seed={seed}  err={r['err']:.4f}  "
                  f"shuffled={r['shuffled']:.4f}  ratio={r['ratio']:.3f}  "
                  f"rail={r['rail']:.3f}  sd={r['crosshair_sd']:.3f}  "
                  f"[{time.perf_counter() - t0:.0f}s]", flush=True)
        mean = float(np.mean([r["ratio"] for r in rows]))
        print(f"arm={arm:11s} MEAN ratio={mean:.3f} over {len(rows)} sessions", flush=True)
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
