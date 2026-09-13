#!/usr/bin/env python
"""#57 — is MAX_FRAME_BYTES enforced by the application, or by the launch command?

    .venv/bin/python tools/spike/ws-frame-cap.py [--ports 8461 8462] [--legacy]

`ws_max_size` is an argument to one launch command. Under any other invocation of the
same `app` the websocket layer's own default applies, which is two orders of magnitude
larger — so the cap has to be checked under **both** invocations or the result says
nothing about the second one:

    python src/server/ws_server.py     the documented path; `ws_max_size` is passed
    uvicorn src.server.ws_server:app   a standard alternative; it is not

`--legacy` runs the same two arms against `git show HEAD:src/server/ws_server.py` in a
temporary file, so the before/after needs no edit on disk.

Each arm sends three frames and reports what the client saw: one just under the cap
(must be accepted and answered), one just over (must close 1009), and — on a surviving
connection — a normal `ping`, so "the cap fires" is distinguished from "the session died
for some other reason".

**Never uses port 8000 or 8099.** Those are the user's live UI.

Exit 0 always — this is a measurement, not a gate.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.server.ws_server import MAX_FRAME_BYTES  # noqa: E402

FORBIDDEN_PORTS = {8000, 8099}
RTT_FRAMES = 0
PY = str(ROOT / ".venv" / "bin" / "python")


def wait_ready(port: int, proc: subprocess.Popen, timeout: float = 180.0) -> bool:
    """Poll /healthz until the connectome is loaded, or the process dies."""
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as r:
                if json.loads(r.read()).get("ready"):
                    return True
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(1.0)
    return False


def game_state(seq: int) -> dict:
    """A state the shipped client would actually send — three missiles and seven
    launchers, not a padded blob. The cap check runs on every one of these, so this is
    the frame whose cost matters."""
    return {"seq": seq, "t": seq * 0.02, "phase": "playing", "mode": "fly", "score": 120,
            "wave": 3, "weapon": 0,
            "base": {"x": 0.5, "health": 0.8, "launchers_alive": 6},
            "launchers": [{"i": i, "kind": "cannon", "x": 0.1 + 0.1 * i, "y": 0.8472,
                           "hp": 3, "alive": True} for i in range(7)],
            "missiles": [{"kind": "missile", "x": 0.2 + 0.3 * i, "y": 0.4,
                          "vx": 0.0, "vy": 0.3} for i in range(3)],
            "interceptors": []}


async def rtt(port: int, frames: int) -> dict:
    """state -> frame round trip, matched by `ack_seq`. #4 AC2 is a p95 contract, and the
    cap check runs once per inbound frame on this exact path."""
    import websockets

    uri = f"ws://127.0.0.1:{port}/brain"
    samples: list[float] = []
    async with websockets.connect(uri, max_size=None) as ws:
        await asyncio.wait_for(ws.recv(), timeout=60)          # `ready`
        sent: dict[int, float] = {}
        for seq in range(frames):
            raw = json.dumps({"type": "state", "state": game_state(seq)})
            sent[seq] = time.perf_counter()
            await ws.send(raw)
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                if msg.get("type") != "frame":
                    continue
                ack = msg.get("ack_seq")
                if ack in sent:
                    samples.append((time.perf_counter() - sent[ack]) * 1000.0)
                    break
    warm = samples[len(samples) // 10:]            # drop the JIT-warm head
    warm.sort()
    return {"n": len(warm), "median": warm[len(warm) // 2],
            "p95": warm[int(0.95 * len(warm))], "max": warm[-1],
            "bytes": len(json.dumps({"type": "state", "state": game_state(0)}))}


async def probe(port: int) -> dict:
    """Under-cap, over-cap, and a liveness check on whatever survives."""
    import websockets

    out: dict[str, object] = {}
    uri = f"ws://127.0.0.1:{port}/brain"
    # The client's own limit must be larger than the server's, or the client rejects the
    # frame on the way out and the server is never tested.
    async with websockets.connect(uri, max_size=None) as ws:
        await asyncio.wait_for(ws.recv(), timeout=30)          # the `ready` message
        pad = "x" * (MAX_FRAME_BYTES - 200)
        under = json.dumps({"type": "state", "state": {"seq": 1, "pad": pad}})
        assert len(under) <= MAX_FRAME_BYTES, len(under)
        await ws.send(under)
        await ws.send(json.dumps({"type": "ping", "id": "under"}))
        for _ in range(40):
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if msg.get("type") == "pong":
                out["under_cap"] = f"accepted ({len(under)} bytes), pong received"
                break
        else:
            out["under_cap"] = "no pong within 40 frames"

        over = json.dumps({"type": "state",
                           "state": {"seq": 2, "pad": "y" * (MAX_FRAME_BYTES + 4096)}})
        assert len(over) > MAX_FRAME_BYTES
        try:
            await ws.send(over)
            while True:
                await asyncio.wait_for(ws.recv(), timeout=20)
        except websockets.exceptions.ConnectionClosed as exc:
            out["over_cap"] = f"closed, code {exc.code}, {len(over)} bytes sent"
        except (asyncio.TimeoutError, OSError) as exc:
            out["over_cap"] = f"NOT closed — {type(exc).__name__}"
    return out


def arm(label: str, cmd: list[str], port: int, pypath: str) -> None:
    env = {**os.environ, "PYTHONPATH": pypath}
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        if not wait_ready(port, proc):
            err = (proc.stderr.read() or b"").decode()[-400:] if proc.stderr else ""
            print(f"{label:34s} server never became ready. {err}")
            return
        if RTT_FRAMES:
            r = asyncio.run(rtt(port, RTT_FRAMES))
            print(f"{label:34s} rtt        n={r['n']}  state {r['bytes']} B  "
                  f"median {r['median']:.1f} ms  p95 {r['p95']:.1f} ms  max {r['max']:.1f} ms")
            return
        result = asyncio.run(probe(port))
        for k, v in result.items():
            print(f"{label:34s} {k:10s} {v}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ports", type=int, nargs=2, default=[8461, 8462])
    ap.add_argument("--legacy", action="store_true",
                    help="run both arms against HEAD's ws_server.py instead")
    ap.add_argument("--rtt", type=int, default=0, metavar="N",
                    help="measure state->frame RTT over N frames instead of the cap")
    args = ap.parse_args()
    global RTT_FRAMES
    RTT_FRAMES = args.rtt
    if FORBIDDEN_PORTS & set(args.ports):
        raise SystemExit(f"ports {sorted(FORBIDDEN_PORTS)} are the user's live UI")

    src = ROOT / "src" / "server" / "ws_server.py"
    mod = "src.server.ws_server"
    pypath = str(ROOT)
    tmp: tempfile.TemporaryDirectory | None = None
    if args.legacy:
        # Written to a temp directory and NOT into `src/server/`: a probe that drops a
        # second copy of the module under test into the source tree leaves it there if it
        # is killed mid-run. `ROOT` stays on PYTHONPATH so `src.brain…` resolves the same
        # way for both copies.
        tmp = tempfile.TemporaryDirectory()
        head = subprocess.run(["git", "show", "HEAD:src/server/ws_server.py"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout
        src = Path(tmp.name) / "ws_head_probe.py"
        src.write_text(head)
        mod = "ws_head_probe"
        pypath = os.pathsep.join([str(ROOT), tmp.name])

    print(f"{'ws_server.py: ' + ('HEAD (pre-fix)' if args.legacy else 'working tree'):34s} "
          f"MAX_FRAME_BYTES={MAX_FRAME_BYTES}")
    try:
        arm("python src/server/ws_server.py", [PY, str(src), "--port", str(args.ports[0])],
            args.ports[0], pypath)
        arm("uvicorn src.server.ws_server:app",
            [PY, "-m", "uvicorn", f"{mod}:app", "--port", str(args.ports[1])],
            args.ports[1], pypath)
    finally:
        if tmp:
            tmp.cleanup()


if __name__ == "__main__":
    main()
