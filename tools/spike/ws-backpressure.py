#!/usr/bin/env python
"""Does a slow WebSocket consumer stall the #4 brain loop? ~25 s, no connectome needed.

The brain is stood in for by a 6.4 ms busy wait (the measured `brain.step` cost on the
real connectome, `tools/spike/ws-latency.py`) and a 29 kB frame, so this isolates the
transport question: `await ws.send_text()` inside the step loop vs a single-slot outbox
drained by a separate writer task (latest-wins, the same discipline FlyBridge's Transport
contract imposes in the other direction).

    .venv/bin/python tools/spike/ws-backpressure.py

Three emission policies are compared. `direct` awaits send_text() inside the step loop;
`outbox` keeps a single latest-wins slot drained by a writer task; `credit` sends a frame
only when a client message has bought one (no banking).

Expected output (2026-09-12, uvicorn 0.52.4, websockets 17.1, macOS localhost):

    mode=direct  client=fast  sim 50.0 Hz  sent 250  dropped   0  max lag    1.0 ms
    mode=direct  client=slow  sim  0.0 Hz  sent   0  dropped   0  max lag 6510.9 ms
    mode=outbox  client=fast  sim 50.0 Hz  sent 250  dropped   0  max lag    2.2 ms
    mode=outbox  client=slow  sim  0.0 Hz  sent   0  dropped   0  max lag 6627.8 ms
    mode=credit  client=fast  sim 50.0 Hz  sent  97  dropped 153  max lag    1.1 ms
    mode=credit  client=slow  sim 50.0 Hz  sent  50  dropped 200  max lag   24.4 ms

Findings:
  * `outbox` does NOT bound lag. `await ws.send_text()` returns as soon as uvicorn has
    buffered the frame, so the slot is empty again before the next step and nothing is
    ever dropped — the backlog moves below the ASGI layer where the app cannot see it.
  * `direct`/`outbox` with a slow consumer reach **6.5 s** of lag in 5 s of streaming.
    The `sim 0.0 Hz / sent 0` rows are a reporting artefact of exactly that: the final
    status frame was stuck behind the buffered backlog past the client's 5 s timeout.
  * `credit` holds max lag at 24.4 ms (~one step plus transport) with the sim still at
    50 Hz, by dropping the frames the client never asked for.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = 8791
FRAME = "x" * 29000
STEP_MS = 6.4
STEP_HZ = 50.0
STEPS = 250

SERVER = f'''
import asyncio, json, time
from fastapi import FastAPI, WebSocket
import uvicorn

FRAME = "x" * 29000
app = FastAPI()

def work(ms):
    t = time.perf_counter() + ms / 1000.0
    while time.perf_counter() < t:
        pass

@app.websocket("/brain")
async def brain(ws: WebSocket):
    mode = ws.query_params.get("mode", "direct")
    await ws.accept()
    sent = dropped = 0
    slot = {{"frame": None}}
    stop = asyncio.Event()

    async def writer():
        nonlocal sent
        while not stop.is_set():
            f = slot["frame"]
            if f is None:
                await asyncio.sleep(0.001)
                continue
            slot["frame"] = None
            await ws.send_text(f)
            sent += 1

    credit = {{"n": 0}}

    async def reader():
        while True:
            try:
                await ws.receive_text()
            except Exception:
                stop.set(); return
            credit["n"] += 1        # one state message buys one frame

    tasks = [asyncio.create_task(reader())]
    if mode == "outbox":
        tasks.append(asyncio.create_task(writer()))

    period = 1.0 / {STEP_HZ}
    next_t = time.perf_counter()
    t0 = time.perf_counter()
    for step in range(1, {STEPS} + 1):
        work({STEP_MS})
        payload = json.dumps({{"step": step, "t": time.perf_counter(), "spikes": FRAME}})
        if mode == "outbox":
            if slot["frame"] is not None:
                dropped += 1
            slot["frame"] = payload
        elif mode == "credit":
            if credit["n"] > 0:
                credit["n"] = 0     # latest-wins: extra credit is not banked
                await ws.send_text(payload)
                sent += 1
            else:
                dropped += 1
        else:
            await ws.send_text(payload)
            sent += 1
        next_t += period
        d = next_t - time.perf_counter()
        if d < 0:
            next_t = time.perf_counter(); d = 0
        await asyncio.sleep(d)
    sim_hz = {STEPS} / (time.perf_counter() - t0)
    await asyncio.sleep(0.5)
    stop.set()
    for t in tasks:
        t.cancel()
    try:
        await ws.send_text(json.dumps({{"done": True, "sim_hz": sim_hz,
                                       "sent": sent, "dropped": dropped}}))
        await asyncio.sleep(0.2)
    except Exception:
        pass

uvicorn.run(app, host="127.0.0.1", port={PORT}, log_level="error", ws_max_size=65536)
'''


async def run(mode, slow):
    import websockets
    uri = f"ws://127.0.0.1:{PORT}/brain?mode={mode}"
    lags, report = [], {}
    async with websockets.connect(uri, max_size=None) as ws:
        async def pacer():
            while True:
                await ws.send(json.dumps({"type": "state", "seq": 0}))
                await asyncio.sleep(0.05 if not slow else 0.10)
        pace = asyncio.create_task(pacer())
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            except Exception:
                break
            m = json.loads(raw)
            if m.get("done"):
                report = m
                break
            lags.append(time.perf_counter() - m["t"])
            if slow:
                await asyncio.sleep(0.10)
        pace.cancel()
    lag = f"{max(lags) * 1e3:6.1f}" if lags else "    n/a"
    print(f"mode={mode:7s} client={'slow' if slow else 'fast':5s} "
          f"sim {report.get('sim_hz', 0):.1f} Hz  sent {report.get('sent', 0):3d}  "
          f"dropped {report.get('dropped', 0):3d}  max lag {lag} ms")


def main():
    proc = subprocess.Popen([sys.executable, "-c", SERVER], cwd=str(ROOT))
    try:
        import socket
        for _ in range(80):
            time.sleep(0.25)
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", PORT)) == 0:
                    break
        for mode in ("direct", "outbox", "credit"):
            for slow in (False, True):
                asyncio.run(run(mode, slow))
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
