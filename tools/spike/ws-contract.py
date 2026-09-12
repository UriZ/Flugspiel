#!/usr/bin/env python
"""Verify the framework-level claims the #4 spec rests on. No connectome needed, ~20 s.

    .venv/bin/python tools/spike/ws-contract.py

Checks, in order:
  1. `TestClient.websocket_connect` drives a *server-driven* emit loop (the #4 design) —
     this is the AC6 test strategy, and it needs `httpx` installed.
  2. Starlette applies **no** Origin check to WebSocket routes: a browser page on any
     origin can open ws://127.0.0.1 . Drives a real uvicorn with a forged Origin.
  3. uvicorn's default inbound frame cap (`--ws-max-size`, 16 MiB) and what the client
     sees when it is exceeded.
  4. A close code set by the app (4409) is visible to a real client.
  5. `python src/server/<file>.py` vs `python -m src.server.<file>` — whether a
     sys.path bootstrap makes AC5's literal command work.

Expected output (2026-09-12, starlette 1.6.0, uvicorn 0.52.4, websockets 17.1, httpx 0.28.1):

    1 TestClient server-driven loop : OK  got 5 frames, steps 1..5
    2 forged Origin 'http://evil.example' : ACCEPTED (no framework check)
    3 16 MiB+1 text frame : rejected, close code 1009
    3 15 MiB text frame  : accepted
    4 app close(4409) seen by client : code=4409 reason='busy'
    5 python src/server/probe.py (no bootstrap) : ModuleNotFoundError: No module named 'src'
    5 python src/server/probe.py (sys.path bootstrap) : OK
    5 python -m src.server.probe : OK
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import textwrap
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

APP = '''
import asyncio, json, contextlib
from fastapi import FastAPI, WebSocket

@contextlib.asynccontextmanager
async def lifespan(app):
    app.state.busy = False
    app.state.holder = None
    yield

app = FastAPI(lifespan=lifespan)

@app.websocket("/takeover")
async def takeover(ws: WebSocket):
    """Newest-wins: a new connection evicts the incumbent instead of being refused."""
    await ws.accept()
    inc = getattr(app.state, "holder", None)
    if inc is not None:
        try:
            await inc.close(code=4409, reason="superseded")
        except Exception:
            pass
    app.state.holder = ws
    step = 0
    try:
        while True:
            step += 1
            await ws.send_text(json.dumps({"type": "frame", "step": step}))
            await asyncio.sleep(0.02)
    except Exception:
        pass
    finally:
        if app.state.holder is ws:
            app.state.holder = None


@app.websocket("/brain")
async def brain(ws: WebSocket):
    if app.state.busy:
        await ws.accept()
        await ws.close(code=4409, reason="busy")
        return
    app.state.busy = True
    await ws.accept()
    step = 0
    stop = asyncio.Event()

    async def reader():
        while True:
            try:
                raw = await ws.receive_text()
            except Exception:
                stop.set(); return
            if json.loads(raw).get("type") == "stop":
                stop.set(); return

    task = asyncio.create_task(reader())
    try:
        while not stop.is_set():
            step += 1
            await ws.send_text(json.dumps({"type": "frame", "step": step}))
            await asyncio.sleep(0.02)
    except Exception:
        pass
    finally:
        task.cancel()
        app.state.busy = False
'''

sys.path.insert(0, str(ROOT))
(ROOT / "tools/spike/_ws_contract_app.py").write_text(APP)
from tools.spike import _ws_contract_app as appmod  # noqa: E402


def check1():
    from fastapi.testclient import TestClient
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/brain") as ws:
            ws.send_text(json.dumps({"type": "state", "state": {"seq": 0}}))
            steps = [ws.receive_json()["step"] for _ in range(5)]
            ws.send_text(json.dumps({"type": "stop"}))
    print(f"1 TestClient server-driven loop : OK  got {len(steps)} frames, "
          f"steps {steps[0]}..{steps[-1]}")


async def _live_checks(port):
    import websockets
    uri = f"ws://127.0.0.1:{port}/brain"

    # 2 forged Origin
    try:
        async with websockets.connect(uri, origin="http://evil.example") as ws:
            await ws.recv()
            print("2 forged Origin 'http://evil.example' : ACCEPTED (no framework check)")
    except Exception as e:
        print(f"2 forged Origin : REJECTED ({type(e).__name__}: {e})")

    # 3 frame size cap
    for size, label in [(16 * 1024 * 1024 + 1, "16 MiB+1"), (15 * 1024 * 1024, "15 MiB")]:
        await asyncio.sleep(1.0)   # the app allows one connection at a time
        try:
            async with websockets.connect(uri, max_size=None) as ws:
                await ws.recv()
                await ws.send("x" * size)
                await asyncio.sleep(0.5)
                await ws.send(json.dumps({"type": "stop"}))
                await asyncio.sleep(0.3)
                print(f"3 {label} text frame : accepted")
        except Exception as e:
            code = getattr(e, "code", getattr(getattr(e, "rcvd", None), "code", "?"))
            print(f"3 {label} text frame : rejected, close code {code}")

    # 4 app-set close code, second concurrent connection
    await asyncio.sleep(1.0)   # let the previous connection's teardown clear `busy`
    async with websockets.connect(uri) as first:
        await first.recv()
        try:
            async with websockets.connect(uri) as second:
                await second.recv()
                print("4 app close(4409) : second connection was ACCEPTED")
        except Exception as e:
            rcvd = getattr(e, "rcvd", None)
            print(f"4 app close(4409) seen by client : code={getattr(rcvd,'code','?')} "
                  f"reason={getattr(rcvd,'reason','?')!r}")
        await first.send(json.dumps({"type": "stop"}))

    # 6 newest-wins handoff (the reconnect path: a browser refresh races its own teardown)
    await asyncio.sleep(0.5)
    a = await websockets.connect(f"ws://127.0.0.1:{port}/takeover")
    await a.recv()
    b = await websockets.connect(f"ws://127.0.0.1:{port}/takeover")
    await b.recv()
    try:
        for _ in range(20):
            await asyncio.wait_for(a.recv(), timeout=1.0)
        print("6 newest-wins : incumbent was NOT evicted")
    except Exception as e:
        rcvd = getattr(e, "rcvd", None)
        print(f"6 newest-wins : incumbent evicted, code={getattr(rcvd,'code','?')} "
              f"reason={getattr(rcvd,'reason','?')!r}; newcomer still streaming="
              f"{bool(await b.recv())}")
    await b.close()


def check_2_3_4(port=8781):
    src = (f"import sys; sys.path.insert(0, {str(ROOT)!r})\n"
           "from tools.spike._ws_contract_app import app\n"
           "import uvicorn\n"
           f"uvicorn.run(app, host='127.0.0.1', port={port}, log_level='error')\n")
    proc = subprocess.Popen([sys.executable, "-c", src], cwd=str(ROOT))
    try:
        import socket
        for _ in range(80):
            time.sleep(0.25)
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
        asyncio.run(_live_checks(port))
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def check7(port=8782):
    """uvicorn's ws_max_size override, and what the client sees when it trips."""
    src = (f"import sys; sys.path.insert(0, {str(ROOT)!r})\n"
           "from tools.spike._ws_contract_app import app\n"
           "import uvicorn\n"
           f"uvicorn.run(app, host='127.0.0.1', port={port}, log_level='error', "
           "ws_max_size=65536)\n")
    proc = subprocess.Popen([sys.executable, "-c", src], cwd=str(ROOT))

    async def go():
        import websockets
        uri = f"ws://127.0.0.1:{port}/takeover"
        for size, label in [(65537, "64 KiB+1"), (60000, "60 kB")]:
            try:
                async with websockets.connect(uri, max_size=None) as ws:
                    await ws.recv()
                    await ws.send("x" * size)
                    await asyncio.sleep(0.4)
                    await ws.recv()
                    print(f"7 ws_max_size=65536, {label} frame : accepted")
            except Exception as e:
                rcvd = getattr(e, "rcvd", None)
                print(f"7 ws_max_size=65536, {label} frame : rejected, close code "
                      f"{getattr(rcvd, 'code', '?')}")
            await asyncio.sleep(0.3)

    try:
        import socket
        for _ in range(80):
            time.sleep(0.25)
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
        asyncio.run(go())
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def check5():
    d = ROOT / "src/server"
    plain = d / "_probe_plain.py"
    boot = d / "_probe_boot.py"
    plain.write_text("from src.brain.lif import FlyBrain\nprint('OK')\n")
    boot.write_text(textwrap.dedent('''
        import sys
        from pathlib import Path
        if __package__ in (None, ""):
            sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
        from src.brain.lif import FlyBrain
        print("OK")
    '''))
    try:
        for label, args in [("python src/server/probe.py (no bootstrap)",
                             [sys.executable, "src/server/_probe_plain.py"]),
                            ("python src/server/probe.py (sys.path bootstrap)",
                             [sys.executable, "src/server/_probe_boot.py"]),
                            ("python -m src.server.probe",
                             [sys.executable, "-m", "src.server._probe_boot"])]:
            r = subprocess.run(args, cwd=str(ROOT), capture_output=True, text=True)
            tail = (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr) else ""
            print(f"5 {label} : {tail}")
    finally:
        plain.unlink(missing_ok=True)
        boot.unlink(missing_ok=True)


if __name__ == "__main__":
    check1()
    check_2_3_4()
    check7()
    check5()
    (ROOT / "tools/spike/_ws_contract_app.py").unlink(missing_ok=True)
