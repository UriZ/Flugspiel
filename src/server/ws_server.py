"""WebSocket bridge: one JSON socket between the game and a live fly brain — #4.

One process owns one `FlyBrain`, one `Encoder` and one `Decoder`, steps them on its own
wall clock, and exchanges text frames with whatever holds the game:

    client -> hello | state | result | reset | ping
    server -> ready | frame | error | pong

**Trust model — single-user localhost research tool, no authentication.** Binds
`127.0.0.1`; `--host` exists and says in its help text not to use it. The only access
control is an Origin allowlist, because Starlette applies no Origin check of its own and
without one any page the user browses could open this socket, evict the real UI and drive
the game. Inbound frames are capped by `ws_max_size`; malformed input is answered with a
non-fatal `error` and the connection is kept, since one corrupt frame must not end a
research session. State *contents* are not re-validated here — `Encoder.encode` never
raises on them and counts what it coerced; the server's duty is to surface that count.

**The reader never encodes and never steps.** It parses JSON into a single latest-wins
slot; encode, step and frame-build run on the server's clock, and credit is capped at one
and never banked. That is what bounds a flooding client's cost to `json.loads`. Moving
`encode()` into the reader would reintroduce a denial-of-service.

**Frames are credit-paced, never awaited into a slow consumer.** `await send_text()`
returns once uvicorn has buffered, so a backlog sinks below the ASGI layer where this code
cannot see it; one frame per credited state, uncredited steps counted in `meta.dropped`.

CLI:  python src/server/ws_server.py [--port 8000] [--backend auto]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import numpy as np

if __package__ in (None, ""):  # run as a script; `python -m` already has the root
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import FastAPI, WebSocket  # noqa: E402

from src.brain.decoder import Decoder  # noqa: E402
from src.brain.encoder import Encoder  # noqa: E402
from src.brain.lif import FlyBrain  # noqa: E402
from src.brain.reward import RewardError, RewardLoop  # noqa: E402

PROTOCOL = 1
MAX_FRAME_BYTES = 131072
"""Inbound cap. Tripping it closes the connection (1009), so it is set far above a
realistic state — a late wave must never drop the controller."""

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


@dataclass(frozen=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8000
    sim_hz: float = 50.0
    backend: str = "auto"
    data: Path | None = None
    allow_origin: tuple[str, ...] = ()


CONFIG = Config()


def origin_allowed(origin: str | None, extra: tuple[str, ...]) -> bool:
    """Absent Origin is allowed: browsers always send one, non-browser clients never do."""
    if not origin:
        return True
    if origin in extra:
        return True
    with contextlib.suppress(ValueError):
        return urlsplit(origin).hostname in LOCAL_HOSTS
    return False


class Runtime:
    """Everything loaded once, before the socket accepts anything."""

    def __init__(self, cfg: Config) -> None:
        t0 = time.perf_counter()
        self.brain = FlyBrain.load(cfg.data, backend=cfg.backend)
        self.encoder = Encoder(self.brain)
        self.decoder = Decoder(self.brain)
        self.decoder.calibrate(self.encoder)  # resets brain and decoder itself
        self.brain.reset()
        self.decoder.reset()
        # Built even when disabled, so a config typo fails here rather than lying dormant
        # and so the frame's `reward` block keeps its shape either way (#7 §7).
        self.reward = RewardLoop(self.brain, encoder=self.encoder)

        m, brain = self.brain.meta, self.brain
        # Once, never per frame: 27 `flatnonzero` scans cost more than the whole budget.
        self.regions = {s: np.flatnonzero(m.superclass == s)
                        for s in sorted(set(m.superclass.tolist()))}
        self.dn = np.flatnonzero(m.superclass == "descending_neuron")
        self._mask = np.zeros(brain.n, dtype=bool)  # reused; zeroing 166k per frame is waste

        mp = self.decoder.mapping
        self.populations = {
            "aim_L": len(brain.cells(list(mp.aim["types"]), side="L")),
            "aim_R": len(brain.cells(list(mp.aim["types"]), side="R")),
            "fire": len(brain.cells(list(mp.fire.types))),
            "weapon": len(brain.cells(list(mp.weapon.types))),
            "descending": len(self.dn),
        }
        self.startup_s = time.perf_counter() - t0
        self.generation = 0
        self.holder: WebSocket | None = None

    @property
    def ac2_capable(self) -> bool:
        return self.brain.backend == "numba"

    def ready_message(self) -> dict:
        return {"type": "ready", "protocol": PROTOCOL, "n": self.brain.n,
                "backend": self.brain.backend, "sim_hz": CONFIG.sim_hz,
                "step_dt": self.brain.params.dt, "ac2_capable": self.ac2_capable,
                "regions": list(self.regions), "populations": self.populations,
                "prosthetic_sites": list(self.encoder.prosthetic_sites)}

    def snapshot(self, fired: np.ndarray, reward: dict, meta: dict) -> dict:
        mask = self._mask
        mask[fired] = True
        try:
            descending = dict(self.decoder.telemetry())
            descending["active"] = np.flatnonzero(mask[self.dn]).tolist()
            return {
                "step": self.brain.steps,
                # `n` is required: packbits pads to a byte, and the tail is not spikes.
                "spikes": {"n": self.brain.n,
                           "bits": base64.b64encode(np.packbits(mask)).decode()},
                "regions": {k: int(mask[v].sum()) for k, v in self.regions.items()},
                "descending": descending,
                "reward": reward,
                "meta": meta,
            }
        finally:
            mask[fired] = False


@dataclass
class Counters:
    dropped: int = 0
    rejected: int = 0
    unassigned: int = 0
    errors: dict[str, int] = field(default_factory=dict)


class Session:
    """One controller connection: a reader task and the step loop, same event loop."""

    def __init__(self, rt: Runtime, ws: WebSocket, gen: int) -> None:
        self.rt, self.ws, self.gen = rt, ws, gen
        self.stop = False
        self.slot: dict | None = None
        self.credit = 0
        self.ack_seq: int | None = None
        self.session: int | None = None
        self.session_changed = False
        self.detached_reported = False
        self.c = Counters()

    async def run(self) -> None:
        reader = asyncio.create_task(self._read())
        try:
            await self._loop()
        finally:
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader

    # ---------------------------------------------------------------- reader

    async def _read(self) -> None:
        while True:
            try:
                msg = await self.ws.receive()
            except Exception:
                self.stop = True
                return
            if msg["type"] == "websocket.disconnect":
                self.stop = True
                return
            raw = msg.get("text")
            if raw is None:
                await self._error("bad_envelope", "binary frames are not accepted")
                continue
            await self._handle(raw)

    async def _handle(self, raw: str) -> None:
        try:
            obj = json.loads(raw)
        except ValueError as e:
            return await self._error("bad_json", str(e))
        if not isinstance(obj, dict):
            return await self._error("bad_envelope", "top level must be an object")

        kind = obj.get("type")
        if kind == "state":
            state = obj.get("state")
            if not isinstance(state, dict) or not _is_int(state.get("seq")):
                return await self._error("bad_state", "state must be an object with int seq")
            self.slot = state
            self.credit = 1  # one state buys one frame; extra states are not banked
        elif kind == "result":
            # Applied here and now: `Decoder.on_result` consumes a latch that the next
            # decode() clears, so routing this through the state slot would revert the
            # wrong one. A result for any other frame is stale and must not be applied.
            if not _is_int(obj.get("seq")) or obj.get("seq") != self.ack_seq:
                self.c.errors["stale_result"] = self.c.errors.get("stale_result", 0) + 1
                return
            self.rt.decoder.on_result(obj.get("result"))
            if self.rt.decoder.halted and not self.detached_reported:
                self.detached_reported = True
                # Terminal. The server never re-arms the bridge, resets the decoder or
                # retries: a detached bridge reports ok:true and fires nothing. Replacing
                # it is the client's job. Snapshots keep flowing so the viz stays live.
                await self._send({"type": "error", "code": "bridge_detached",
                                  "detail": "decoder halted", "fatal": False})
        elif kind == "reset":
            await self._reset(obj.get("scope"))
        elif kind == "ping":
            await self._send({"type": "pong", "id": obj.get("id")})
        elif kind == "hello":
            pass  # informational; the server does not wait for it
        else:
            await self._error("unknown_type", f"unknown type {kind!r}")

    async def _reset(self, scope: Any) -> None:
        if scope not in ("decoder", "brain", "all"):
            return await self._error("bad_scope", f"scope must be decoder/brain/all, got {scope!r}")
        if scope in ("brain", "all"):
            # reset() reseeds the RNG, which invalidates the measured aim zero, so the
            # recalibration is not optional. It blocks the loop for seconds — say so first.
            await self._send({"type": "error", "code": "recalibrating",
                              "detail": "brain reset; re-measuring the aim zero",
                              "fatal": False})
            self.rt.brain.reset()
            # Before recalibrating: the aim zero must be measured on the pristine
            # connectome, not through whatever efficacy the last session left behind.
            self.rt.reward.reset()
            self.rt.decoder.calibrate(self.rt.encoder)
            self.rt.brain.reset()
        # readout=True only where the brain was reset too: the EMAs describe a brain that
        # no longer exists. On the `decoder` scope the brain carries on, so they stand
        # (#22). Either way this is one of the three ways out of `halted`.
        self.rt.decoder.reset(readout=scope in ("brain", "all"))
        self.detached_reported = False

    async def _error(self, code: str, detail: str) -> None:
        self.c.errors[code] = self.c.errors.get(code, 0) + 1
        await self._send({"type": "error", "code": code, "detail": detail, "fatal": False})

    async def _send(self, obj: dict) -> None:
        with contextlib.suppress(Exception):
            await self.ws.send_text(json.dumps(obj, allow_nan=False))

    # ---------------------------------------------------------------- step loop

    async def _loop(self) -> None:
        rt, dec, enc, brain = self.rt, self.rt.decoder, self.rt.encoder, self.rt.brain
        dt, period = brain.params.dt, 1.0 / CONFIG.sim_hz
        frame, state = enc.neutral(), None
        last_decode = next_t = time.perf_counter()
        t_first: float | None = None   # set after step 1: the rate is over intervals,
        steps = 0                      # not over steps, or the first sample reads high

        # The generation guard, not a lock: an evicted handler's loop must stop stepping
        # the shared brain. Both loops are tasks on one event loop and brain.step()
        # contains no await, so the evicted loop's last step is atomic and harmless.
        while not self.stop and rt.generation == self.gen:
            if self.slot is not None:
                state, self.slot = self.slot, None
                # Promote before the step, so ack_seq names a state this step injected.
                self.ack_seq = int(state["seq"])
                changed = self._track_session(state.get("session"))
                frame = enc.encode(state, dec.crosshair_x)
                # Before the step whose synaptic input it changes (#7 §11.4): after it,
                # every weight update lands one step late. `changed`, not the sticky
                # `session_changed` flag, so a frame the socket never took cannot make
                # the loop resync twice off one boundary.
                try:
                    rt.reward.on_state(state, changed)
                except RewardError as exc:
                    # #7's write guard fired and left W byte-identical, which is the guard
                    # working. Letting it out of the loop would kill the session with a
                    # 1006 and no `error` frame — #26's failure mode at a call site
                    # written after #26 fixed it. Non-fatal: the brain still steps, the
                    # reward contribution for this state is simply not applied.
                    await self._error("reward_refused", str(exc))
                self.c.unassigned = frame.unassigned
                self.c.rejected += frame.rejected

            fired = brain.step(inject=frame.inject + rt.reward.inject())
            dec.observe(fired, dt)
            rt.reward.observe(fired)
            steps += 1
            if t_first is None:
                t_first = time.perf_counter()

            if self.credit:
                self.credit = 0
                now = time.perf_counter()
                action = dec.decode(state or {}, min(max(now - last_decode, period), 1.0))
                last_decode = now
                sim_hz = (steps - 1) / (now - t_first) if steps > 1 else 0.0
                try:
                    payload = json.dumps(self._frame(action, fired, sim_hz), allow_nan=False)
                except ValueError:
                    # `allow_nan=False` is deliberate and stays: telemetry is not
                    # sanitised, so a non-finite readout must stay loud (#35). But the
                    # bare ValueError names no field, which makes a field report
                    # undiagnosable — and unguarded it would end the session. Name it,
                    # drop the frame, keep the socket.
                    await self._error("nonfinite_frame", "; ".join(
                        _nonfinite(self._frame(action, fired, sim_hz))) or "unknown field")
                    self.session_changed = False
                    continue
                try:
                    await self.ws.send_text(payload)
                except Exception:
                    return
                self.session_changed = False
            else:
                self.c.dropped += 1

            next_t += period
            delay = next_t - time.perf_counter()
            if delay < 0:  # no debt catch-up: a slow backend degrades to a lower rate
                next_t, delay = time.perf_counter(), 0.0
            await asyncio.sleep(delay)

    def _track_session(self, session: Any) -> bool:
        """A session change is a restart: the decoder's latches and crosshair are stale,
        and #7 must discard reward across it rather than difference through it. The brain
        is deliberately NOT reset — it is a continuous reservoir, and reseeding it would
        invalidate the aim zero measured under that RNG stream.

        A change here also clears `halted`, and that is deliberate: only a live, emitting
        bridge can produce one, because `_afterFrame` is both the sole emit site and the
        sole `_session` increment site and `detach()` removes it. The change is therefore
        *evidence* of a live bridge, not merely correlated with one (#36).

        Which is exactly why a **non-int** `session` must not count. It used to coerce to
        0 and read as a change from any other value, so a malformed field cleared `halted`
        with no live bridge implied — two correct decisions, #26's sanitise-rather-than-
        reject and "a change of this field is a restart", composing into a third nobody
        chose. Garbage is not evidence: the frame is still accepted and still drives the
        brain, the field is counted, and the last observed session stands.
        """
        if not _is_int(session):
            self.c.errors["bad_session"] = self.c.errors.get("bad_session", 0) + 1
            return False
        value = int(session)
        if self.session is None:
            self.session = value
            return False
        if value != self.session:
            self.session = value
            self.session_changed = True
            self.rt.decoder.reset()
            return True
        return False

    def _frame(self, action: dict, fired: np.ndarray, sim_hz: float) -> dict:
        c = self.c
        return {
            "type": "frame",
            "step": self.rt.brain.steps,
            "ack_seq": self.ack_seq,
            "session": self.session,
            "action": action,
            "snapshot": self.rt.snapshot(
                fired,
                reward=self.rt.reward.telemetry(self.session_changed),
                meta={"sim_hz": sim_hz, "dropped": c.dropped, "rejected": c.rejected,
                      "unassigned": c.unassigned, "errors": dict(c.errors)},
            ),
        }


def _nonfinite(obj: Any, path: str = "") -> list[str]:
    """Every non-finite float in a frame, named by its path. Diagnostic only (#36)."""
    if isinstance(obj, dict):
        return [p for k, v in obj.items() for p in _nonfinite(v, f"{path}.{k}" if path else str(k))]
    if isinstance(obj, (list, tuple)):
        return [p for i, v in enumerate(obj) for p in _nonfinite(v, f"{path}[{i}]")]
    if isinstance(obj, float) and not math.isfinite(obj):
        return [f"{path or '<root>'}={obj!r}"]
    return []


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    # Load, JIT and calibrate before the socket answers anything. A ConnectomeError here
    # must kill the process with the loader's own message, not serve a brainless socket.
    app.state.rt = Runtime(CONFIG)
    if not app.state.rt.ac2_capable:
        print("WARNING: backend=numpy — the per-step latency target (#4 AC2) is not "
              "reachable. Install the fast path: pip install -r requirements-fast.txt",
              file=sys.stderr)
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    rt: Runtime | None = getattr(app.state, "rt", None)
    return {"ready": rt is not None,
            "backend": rt.brain.backend if rt else None,
            "ac2_capable": rt.ac2_capable if rt else None,
            "startup_s": rt.startup_s if rt else None}


@app.websocket("/brain")
async def brain_ws(ws: WebSocket) -> None:
    rt: Runtime = ws.app.state.rt
    await ws.accept()
    if not origin_allowed(ws.headers.get("origin"), CONFIG.allow_origin):
        await ws.close(code=4403, reason="origin")
        return

    # Newest-wins: a browser refresh races its own teardown, so refusing the newcomer
    # would lock the user out of their own tool until the old TCP FIN lands.
    incumbent, rt.holder = rt.holder, ws
    if incumbent is not None:
        with contextlib.suppress(Exception):
            await incumbent.close(code=4409, reason="superseded")
    rt.generation += 1
    rt.decoder.reset()  # the brain carries over; the decoder's latches do not
    try:
        await ws.send_text(json.dumps(rt.ready_message(), allow_nan=False))
        await Session(rt, ws, rt.generation).run()
    finally:
        if rt.holder is ws:  # an evicted handler must not clear its successor's holder
            rt.holder = None


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    ap = argparse.ArgumentParser(description="Run the fly brain behind a WebSocket.")
    ap.add_argument("--host", default="127.0.0.1",
                    help="expose the brain to the network (no auth — do not use)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--sim-hz", type=float, default=50.0,
                    help="brain steps per second; 50 keeps model time at wall-clock rate")
    ap.add_argument("--backend", default="auto", choices=("auto", "numba", "numpy"))
    ap.add_argument("--data", type=Path, default=None)
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="extra allowed Origin, repeatable (localhost is always allowed)")
    ap.add_argument("--log-level", default="info")
    args = ap.parse_args(argv)

    if args.sim_hz <= 0:
        ap.error("--sim-hz must be positive")

    global CONFIG
    CONFIG = Config(host=args.host, port=args.port, sim_hz=args.sim_hz,
                    backend=args.backend, data=args.data,
                    allow_origin=tuple(args.allow_origin))
    # The app object, not an import string: `reload=True` re-imports in a subprocess and
    # would load the connectome twice.
    uvicorn.run(app, host=args.host, port=args.port, ws_max_size=MAX_FRAME_BYTES,
                log_level=args.log_level)


if __name__ == "__main__":
    main()
