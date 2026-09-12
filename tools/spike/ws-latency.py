#!/usr/bin/env python
"""Measure the #4 end-to-end WebSocket budget on the real connectome and the real #3
encoder/decoder. Evidence for the #4 spec's latency section, and the harness the AC2
benchmark reuses.

    .venv/bin/python tools/spike/ws-latency.py                  # numba backend
    .venv/bin/python tools/spike/ws-latency.py --backend numpy   # no-numba fallback

Runs the designed server loop behind a real uvicorn process and a real `websockets`
client: brain stepping on its own 50 Hz clock, level-held injection, credit-paced frames
(one frame per inbound state, never banked), packed spike bitset. The reported RTT is
state-sent -> frame-received, where the frame is tagged with a `seq` that was promoted
*before* the step that injected it, so no sample is credited to a state that arrived
mid-step. Needs the built connectome. Takes ~90 s.

Expected output (2026-09-12, macOS x86_64, Python 3.13.3, NUMBA_NUM_THREADS unset, real
connectome 166,700 neurons / 25,582,938 connections, `git diff -- src/brain/lif.py` empty):

    backend=numba  frames sent 300 / dropped 484  rtt samples=300
    encode (per state)  median   0.44 ms   p95   0.53 ms
    brain.step          median   6.15 ms   p95   7.37 ms
    observe (per step)  median   0.09 ms   p95   0.11 ms
    decode (per tick)   median   0.05 ms   p95   0.07 ms
    snapshot build      median   0.79 ms   p95   0.93 ms
    json.dumps          median   0.16 ms   p95   0.20 ms
    frame bytes         median   29.3 kB
    state->frame RTT    median  22.6 ms   p95  31.0 ms   max  38.2 ms
    sim rate            49.9 Hz (target 50)
    startup: load+calibrate 8.9 s

    # --backend numpy (no-numba fallback) misses the 50 ms budget by ~2.8x:
    brain.step          median  49.29 ms   p95  70.15 ms
    state->frame RTT    median 137.8 ms   p95 181.4 ms   max 217.9 ms
    sim rate            17.5 Hz (target 50)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]

SERVER = r'''
import asyncio, base64, contextlib, json, sys, time
import numpy as np
sys.path.insert(0, %(root)r)
from src.brain.lif import FlyBrain
from src.brain.encoder import Encoder
from src.brain.decoder import Decoder
from fastapi import FastAPI, WebSocket
import uvicorn

BACKEND, PORT, OUT = %(backend)r, %(port)d, %(out)r
STEP_HZ = 50.0
S = {}

@contextlib.asynccontextmanager
async def lifespan(app):
    t0 = time.perf_counter()
    b = FlyBrain.load(backend=BACKEND)
    enc, dec = Encoder(b), Decoder(b)
    dec.calibrate(enc)
    b.reset()
    dec.reset()
    m = b.meta
    S.update(brain=b, enc=enc, dec=dec, ready=True,
             startup=time.perf_counter() - t0,
             regions={s: np.flatnonzero(m.superclass == s)
                      for s in sorted(set(m.superclass.tolist()))},
             dn=np.flatnonzero(m.superclass == "descending_neuron"))
    yield

app = FastAPI(lifespan=lifespan)

@app.get("/healthz")
def healthz():
    return {"ready": bool(S.get("ready"))}

@app.websocket("/brain")
async def brain_ws(ws: WebSocket):
    await ws.accept()
    b, enc, dec = S["brain"], S["enc"], S["dec"]
    n, dt = b.n, b.params.dt
    frame = enc.neutral()
    t_enc, t_step, t_obs, t_dec, t_snap, t_json, nbytes = [], [], [], [], [], [], []
    pending, credit = {"seq": None, "state": None}, {"n": 0}
    seq, state, sent, dropped, steps = -1, None, 0, 0, 0
    stop = False
    t_first = None

    async def reader():
        nonlocal stop
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except Exception:
                stop = True; return
            if msg.get("type") == "stop":
                stop = True; return
            pending["seq"] = msg["state"]["seq"]
            pending["state"] = msg["state"]
            credit["n"] = 1          # one state buys one frame; extra is not banked

    task = asyncio.create_task(reader())
    period = 1.0 / STEP_HZ
    next_t = time.perf_counter()
    while not stop:
        # Promote before the step, so `seq` names a state this step actually injected.
        if pending["seq"] is not None:
            seq, state = pending["seq"], pending["state"]
            pending["seq"] = None
            t = time.perf_counter()
            frame = enc.encode(state, dec.crosshair_x)
            t_enc.append(time.perf_counter() - t)

        t0 = time.perf_counter()
        fired = b.step(inject=frame.inject)
        t1 = time.perf_counter()
        dec.observe(fired, dt)
        t2 = time.perf_counter()
        steps += 1
        if t_first is None:
            t_first = t0
        t_step.append(t1 - t0); t_obs.append(t2 - t1)

        if credit["n"]:
            credit["n"] = 0
            t = time.perf_counter()
            action = dec.decode(state or {}, 1.0 / 20.0)
            t3 = time.perf_counter()
            mask = np.zeros(n, bool); mask[fired] = True
            snap = {
                "spikes": base64.b64encode(np.packbits(mask)).decode(),
                "regions": {k: int(mask[v].sum()) for k, v in S["regions"].items()},
                "descending": dec.telemetry(),
                "dn_active": np.flatnonzero(mask[S["dn"]]).tolist(),
                "reward": None,
            }
            t4 = time.perf_counter()
            payload = json.dumps({"type": "frame", "step": b.steps, "ack_seq": seq,
                                  "action": action, "snapshot": snap}, allow_nan=False)
            t5 = time.perf_counter()
            try:
                await ws.send_text(payload)
            except Exception:
                break
            sent += 1
            t_dec.append(t3 - t); t_snap.append(t4 - t3); t_json.append(t5 - t4)
            nbytes.append(len(payload))
            dec.on_result({"ok": True})
        else:
            dropped += 1

        next_t += period
        d = next_t - time.perf_counter()
        if d < 0:
            next_t = time.perf_counter(); d = 0   # no debt catch-up
        await asyncio.sleep(d)

    task.cancel()
    open(OUT, "w").write(json.dumps(
        {"t_enc": t_enc, "t_step": t_step, "t_obs": t_obs, "t_dec": t_dec,
         "t_snap": t_snap, "t_json": t_json, "bytes": nbytes, "sent": sent,
         "dropped": dropped, "startup": S["startup"],
         "sim_hz": steps / max(1e-9, time.perf_counter() - (t_first or 0.0))}))

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", ws_max_size=65536)
'''


def ms(a, p):
    return float(np.percentile(np.asarray(a) * 1e3, p))


def state_at(seq, t):
    return {"seq": seq, "t": t, "phase": "playing", "mode": "fly", "score": 0, "wave": 3,
            "weapon": 0, "session": 1,
            "base": {"x": 0.5, "health": 0.8, "launchers_alive": 6},
            "launchers": [{"i": i, "kind": "cannon", "x": i / 7, "y": 0.847,
                           "alive": i != 3, "hp": 0.8, "selected": i == 0}
                          for i in range(7)],
            "missiles": [{"kind": "missile", "x": 0.05 + 0.07 * k, "y": 0.3 + 0.02 * k,
                          "vx": 0.0, "vy": 0.25} for k in range(12)],
            "interceptors": [{"kind": "interceptor", "x": 0.5, "y": 0.7,
                              "vx": 0.0, "vy": -0.6}]}


async def client(port, frames):
    """Sender and receiver are separate tasks: a polled recv() would add its own timeout
    to every RTT sample."""
    import websockets
    rtts, sent_at = [], {}
    stop = asyncio.Event()
    async with websockets.connect(f"ws://127.0.0.1:{port}/brain", max_size=None) as ws:
        async def sender():
            next_send = time.perf_counter()
            for seq in range(frames):
                sent_at[seq] = time.perf_counter()
                await ws.send(json.dumps({"type": "state", "state": state_at(seq, next_send)}))
                next_send += 0.05          # 20 Hz, FlyBridge's default emit rate
                await asyncio.sleep(max(0.0, next_send - time.perf_counter()))
            stop.set()

        async def receiver():
            while not stop.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    return
                now = time.perf_counter()
                a = json.loads(raw).get("ack_seq")
                if a in sent_at:
                    rtts.append(now - sent_at.pop(a))

        await asyncio.gather(sender(), receiver())
        await ws.send(json.dumps({"type": "stop"}))
    return rtts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="numba", choices=("auto", "numba", "numpy"))
    ap.add_argument("--port", type=int, default=8771)
    ap.add_argument("--frames", type=int, default=300)
    args = ap.parse_args()

    out = Path(tempfile.gettempdir()) / f"flugspiel-ws-latency-{args.port}.json"
    out.unlink(missing_ok=True)
    src = SERVER % {"root": str(ROOT), "backend": args.backend, "port": args.port,
                    "out": str(out)}
    proc = subprocess.Popen([sys.executable, "-c", src], cwd=str(ROOT))
    try:
        import urllib.request
        for _ in range(180):
            time.sleep(1.0)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/healthz",
                                            timeout=2) as r:
                    if json.load(r)["ready"]:
                        break
            except Exception:
                pass
        else:
            raise SystemExit("server never became ready")
        rtts = asyncio.run(client(args.port, args.frames))
        time.sleep(2.0)
    finally:
        proc.terminate()
        proc.wait(timeout=20)

    d = json.loads(out.read_text())
    print(f"backend={args.backend}  frames sent {d['sent']} / dropped {d['dropped']}  "
          f"rtt samples={len(rtts)}")
    for k, label in [("t_enc", "encode (per state)"), ("t_step", "brain.step"),
                     ("t_obs", "observe (per step)"), ("t_dec", "decode (per tick)"),
                     ("t_snap", "snapshot build"), ("t_json", "json.dumps")]:
        print(f"{label:19s} median {ms(d[k], 50):6.2f} ms   p95 {ms(d[k], 95):6.2f} ms")
    print(f"{'frame bytes':19s} median {np.median(d['bytes']) / 1000:6.1f} kB")
    if rtts:
        print(f"{'state->frame RTT':19s} median {ms(rtts, 50):6.1f} ms   "
              f"p95 {ms(rtts, 95):6.1f} ms   max {max(rtts) * 1e3:6.1f} ms")
    print(f"{'sim rate':19s} {d['sim_hz']:.1f} Hz (target 50)")
    print(f"startup: load+calibrate {d['startup']:.1f} s")


if __name__ == "__main__":
    main()
