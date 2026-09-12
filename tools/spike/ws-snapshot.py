#!/usr/bin/env python
"""Verify AC4's snapshot contents against the real connectome, and price the encodings.

    .venv/bin/python tools/spike/ws-snapshot.py                 # numba
    .venv/bin/python tools/spike/ws-snapshot.py --backend numpy  # fallback step cost

Answers four questions the #4 spec cannot answer by reading code:
  1. What are the `superclass` values? They become the `snapshot.regions` keys, so the
     key set is data, not a design choice.
  2. Do descending neurons actually fire under a real encoded game state? An all-zero
     `descending` field would make AC4 satisfiable and useless.
  3. What does each candidate `spikes` encoding cost in ms and bytes, at the real firing
     rate? `architecture.md` specifies a literal [1,0,...] array.
  4. What is the per-step cost of the backend, to place the 50 ms AC2 budget.

Needs the built connectome. ~60 s.

Expected output — see the run recorded in the #4 spec comment; the region key set and the
DN counts are properties of MaleCNS v1.0 and are stable, the timings are not.
"""
from __future__ import annotations

import argparse
import base64
import json
import time
from collections import Counter

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.brain.decoder import Decoder
from src.brain.encoder import Encoder
from src.brain.lif import FlyBrain


def state(seq: int) -> dict:
    return {"seq": seq, "t": seq * 0.05, "phase": "playing", "mode": "fly", "score": 100,
            "wave": 3, "weapon": 0,
            "base": {"x": 0.5, "health": 0.8, "launchers_alive": 6},
            "launchers": [{"i": i, "kind": "cannon", "x": i / 7, "y": 0.847,
                           "alive": i != 3, "hp": 0.8, "selected": i == 0}
                          for i in range(7)],
            "missiles": [{"kind": "missile", "x": 0.05 + 0.07 * k, "y": 0.3 + 0.02 * k,
                          "vx": 0.0, "vy": 0.25} for k in range(12)],
            "interceptors": [{"kind": "interceptor", "x": 0.5, "y": 0.7,
                              "vx": 0.0, "vy": -0.6}]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="numba", choices=("auto", "numba", "numpy"))
    ap.add_argument("--steps", type=int, default=200)
    args = ap.parse_args()

    brain = FlyBrain.load(backend=args.backend)
    enc, dec = Encoder(brain), Decoder(brain)
    m = brain.meta

    # 1 region keys
    hist = Counter(m.superclass.tolist())
    print(f"\n1 superclass values: {len(hist)}")
    for k, v in sorted(hist.items(), key=lambda kv: -kv[1]):
        print(f"    {k:24s} {v:7d}")
    key_bytes = len(json.dumps({k: 0 for k in sorted(hist)}))
    print(f"  regions dict as JSON: {key_bytes} bytes")

    dn = np.flatnonzero(m.superclass == "descending_neuron")
    print(f"  descending_neuron population: {len(dn)}")
    named = {k: brain.cells(list(v)) for k, v in
             (("DNa02", ("DNa02",)), ("DNp01", ("DNp01",)), ("DNg100", ("DNg100",)))}
    for k, v in named.items():
        print(f"    {k}: {len(v)} neurons")

    # 2 do DNs fire under a real encoded state?
    dec.calibrate(enc)
    brain.reset()
    dec.reset()
    frame = enc.encode(state(0), 0.5)
    mask = np.zeros(brain.n, bool)
    dn_counts, all_counts, dn_ever = [], [], np.zeros(len(dn), bool)
    t_step = []
    for i in range(args.steps):
        t0 = time.perf_counter()
        fired = brain.step(inject=frame.inject)
        t_step.append(time.perf_counter() - t0)
        dec.observe(fired, brain.params.dt)
        mask[:] = False
        mask[fired] = True
        dn_counts.append(int(mask[dn].sum()))
        all_counts.append(len(fired))
        dn_ever |= mask[dn]
    print(f"\n2 over {args.steps} steps, holding one encoded state:")
    print(f"  global firing   median {np.median(all_counts):8.0f} / {brain.n} "
          f"({np.median(all_counts) / brain.n * 100:.1f}%)")
    print(f"  DN firing       median {np.median(dn_counts):8.0f} / {len(dn)}  "
          f"min {min(dn_counts)}  max {max(dn_counts)}")
    print(f"  distinct DNs that fired at least once: {int(dn_ever.sum())} / {len(dn)}")
    tel = dec.telemetry()
    print(f"  decoder rates: fire_hz={tel['fire_hz']:.2f} weapon_hz={tel['weapon_hz']:.2f} "
          f"aim_index={tel['aim_index']:.4f} aim_zero={tel['aim_zero']:.4f}")

    # 3 encoding cost at the real firing rate
    mask[:] = False
    mask[brain.fired] = True
    print(f"\n3 `spikes` encodings at {len(brain.fired)} fired / {brain.n}:")
    variants = {
        "literal [1,0,...] (architecture.md)": lambda: json.dumps(mask.astype(np.uint8).tolist()),
        "fired index list":                    lambda: json.dumps(brain.fired.tolist()),
        "packbits + base64":                   lambda: base64.b64encode(np.packbits(mask)).decode(),
    }
    for label, fn in variants.items():
        best, out = 1e9, ""
        for _ in range(5):
            t0 = time.perf_counter()
            out = fn()
            best = min(best, time.perf_counter() - t0)
        print(f"    {label:38s} {best * 1e3:7.2f} ms  {len(out) / 1000:7.1f} kB")

    # 4 backend step cost
    print(f"\n4 backend={brain.backend}  step median {np.median(t_step) * 1e3:.2f} ms  "
          f"p95 {np.percentile(t_step, 95) * 1e3:.2f} ms  "
          f"=> {1 / np.median(t_step):.1f} steps/s "
          f"(50 Hz sim needs <= 20.0 ms)")


if __name__ == "__main__":
    main()
