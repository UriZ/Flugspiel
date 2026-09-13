"""Spike: #7 §9's shuffle control and §12.AC6's direction check — verification by
execution, not a test (testing suspended, user, 2026-09-12).

    PYTHONPATH=. python tools/spike/reward-shuffle.py --trajectory   # seconds, no LIF
    PYTHONPATH=. python tools/spike/reward-shuffle.py --direction    # ~1 min, real brain
    PYTHONPATH=. python tools/spike/reward-shuffle.py --contract     # ~2 min, real brain
    PYTHONPATH=. python tools/spike/reward-shuffle.py                # the three arms, slow

Stimulus: `tools/spike/traces/openloop.json`, written by `reward-cadence.mjs --json`.
The detector reads only `t`, `phase`, `session` and `launchers_alive`, so a recorded
`{losses, dur, start}` replays to an identical event train and weight trajectory. The
game is not seeded, so regenerating the trace reproduces the shape and not the digits.

Brain input is the LC4+LPLC2-L looming site held at +0.30 — the one encoder channel #3
measured as driving a readout, and the operating point every rate in #7 §3 was measured
at. The three arms differ ONLY in the reward loop:

    A real      loop on, events at their recorded times
    B shuffled  loop on, same events, same count, magnitudes and valence mix,
                inter-event intervals randomly permuted
    C off       enabled = false (AC5's control)

Arm B deliberately bypasses the detector and drives the update path directly: holding the
dopamine *statistics* fixed while destroying only the timing is the whole point of the
control, and no `launchers_alive` stream can command a survival reward at an arbitrary
time. Any A-vs-B difference is therefore attributable to temporal credit assignment and
to nothing else.

PRE-REGISTERED (#7 §9.2, fixed before this file was run). Statistic: MBON25,MBON34
pooled spikes/s over the final 300 steps of a replay, 5 seeds per arm. Threshold 3.0 Hz,
against a seed noise floor #7 §3.5 measured at 0.38-2.20 Hz.

    H1  A vs C differ by >= 3.0 Hz                     predicted TRUE
    H2  A vs B differ by >= 3.0 Hz                     predicted FALSE
    H3  A vs C differ in DNp01 pooled rate or score    predicted FALSE

H2 is predicted FALSE because every KC fires on every step under #1's parameterisation,
so the eligibility trace saturates and the update depends on the event *sequence* rather
than on its alignment to anything in the brain. A POSITIVE H2 IS EVIDENCE OF A BUG, NOT
OF LEARNING. H3's score half is not measurable here by construction — all three arms
replay one recorded stimulus, so no arm can score differently; the DNp01 half is what
this file measures.

HONESTY CLAUSE (#7 §9.3). Unless H3 comes out TRUE, nothing about #7 may be described as
learning, training, progress, improvement or performance, in the README, the UI, a commit
message or a demo. What may be claimed when H1 holds and H2/H3 do not:

    Reward and punishment events derived from `launchers_alive` drive PAM11 and PPL101
    and measurably modulate KC->MBON efficacy and mushroom-body output. The modulation
    does not reach the game's readout neurons, and no behavioural change is claimed.

PROSTHESIS DISCLOSURE, required per run (#7 §8 and its addendum, from #3's QA run):

    Aiming in this run used the PFL3 `aim_bias` prosthesis. With it disabled, the
    decoder's aim is at chance (0.945 of shuffled); with it enabled it is 0.671 of
    shuffled. DNa02 receives 0.000 of its input from LC4/LPLC2.

Results are recorded on issue #7 and in SESSION_LOG.md with the date and the command,
never in this header: the trace is regenerated per run and pinning digits here would
turn a stale file into a false claim.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

import numpy as np

from src.brain.connectome import load
from src.brain.lif import FlyBrain
from src.brain.reward import (PUNISH, REWARD, RewardConfig, RewardEvent, RewardLoop,
                              _edges)

ROOT = Path(__file__).resolve().parents[2]
TRACE = ROOT / "tools" / "spike" / "traces" / "openloop.json"
SEEDS = (64, 1, 2, 3, 4)
WIRE_HZ = 20.0          # #4's decode rate: one promoted state per emitted frame
WARM = 100              # steps excluded from every window, matching reward-reachability
TAIL = 300              # the pre-registered window, in steps
THRESHOLD_HZ = 3.0
LOOM_GAIN = 0.30
EFF_EVERY = 10          # steps between efficacy samples; 14k divisions is not free


def wire(session: dict) -> list[dict]:
    """The recorded session as the 20 Hz state stream the detector consumes."""
    losses, alive, out = list(session["losses"]), int(session["start"]), []
    for k in range(int(session["dur"] * WIRE_HZ) + 1):
        t = k / WIRE_HZ
        while losses and t >= losses[0]:
            losses.pop(0)
            alive -= 1
        out.append({"t": t, "phase": "playing", "session": 0,
                    "base": {"launchers_alive": alive}})
    return out


def detect(cfg: RewardConfig, states: list[dict]) -> list[RewardEvent]:
    """The event train alone, no brain and no weights — what arm B permutes."""
    brain = _null_brain()
    loop = RewardLoop(brain, cfg)
    return [e for s in states if (e := loop.on_state(s, False)).kind != "none"]


def shuffle(events: list[RewardEvent], rng: np.random.Generator) -> list[RewardEvent]:
    """Same events, same order of kinds and magnitudes; the gaps between them permuted."""
    if not events:
        return []
    gaps = np.diff([0.0] + [e.t for e in events])
    times = np.cumsum(rng.permutation(gaps))
    return [dataclasses.replace(e, t=float(t)) for e, t in zip(events, times)]


def replay(brain, loop, watch, states, arm, seed, events=None):
    """One arm, one seed. Returns per-step spike counts and the efficacy trajectory."""
    brain.reset(seed)
    loop.reset()
    dt = brain.params.dt
    inj = [(watch["loom"], np.float32(LOOM_GAIN))]
    counts = {k: np.zeros(len(states) * 3, np.int32) for k in ("mbon", "dnp01")}
    eff, mask = [], np.zeros(brain.n, bool)
    si, ei, prev_t = 0, 0, 0.0
    steps = int(states[-1]["t"] / dt)

    for s in range(steps):
        t = s * dt
        if arm == "B":
            loop._decay(min(t - prev_t, 1.0))
            while ei < len(events) and events[ei].t <= t:
                loop._apply(events[ei])
                ei += 1
            prev_t = t
        else:
            while si < len(states) and states[si]["t"] <= t:
                loop.on_state(states[si], False)
                si += 1
        fired = brain.step(inject=inj + loop.inject())
        loop.observe(fired)
        if s < WARM:
            continue
        mask[fired] = True
        counts["mbon"][s] = int(mask[watch["mbon"]].sum())
        counts["dnp01"][s] = int(mask[watch["dnp01"]].sum())
        mask[fired] = False
        if s % EFF_EVERY == 0:
            eff.append((s, loop.efficacy()[PUNISH]))
    return {k: v[:steps] for k, v in counts.items()}, eff, dt


def windows(counts, eff, dt):
    """The tail window (the H1/H2/H3 statistic) and the lowest-efficacy window (AC3 iii)."""
    n = len(counts["mbon"])

    def rate(a, lo):
        return float(a[lo:lo + TAIL].sum()) / (TAIL * dt)

    out = {"tail_mbon": rate(counts["mbon"], n - TAIL),
           "tail_dnp01": rate(counts["dnp01"], n - TAIL)}
    usable = [(s, v) for s, v in eff if WARM <= s <= n - TAIL]
    if usable:
        s, v = min(usable, key=lambda x: x[1])
        out |= {"min_eff": v, "min_mbon": rate(counts["mbon"], s)}
    return out


def _null_brain() -> FlyBrain:
    """A 1-neuron stand-in, so the detector can be exercised without the connectome."""
    from scipy import sparse

    from src.brain.connectome import BrainMeta

    names = ["KC", "MBON07", "MBON06", "MBON25,MBON34", "MBON11", "MBON20", "MBON30",
             "PAM11", "PPL101"]
    n = len(names)
    W = sparse.csc_matrix(np.full((n, n), 0.01, dtype=np.float32))
    meta = BrainMeta(ids=np.arange(n, dtype=np.int64),
                     cell_type=np.asarray(names, dtype=str),
                     side=np.asarray(["L"] * n, dtype="<U1"),
                     superclass=np.asarray(["central_brain"] * n, dtype=str),
                     nt=np.asarray(["acetylcholine"] * n, dtype=str),
                     nt_sign=np.ones(n, dtype=np.float32),
                     position=np.zeros((n, 3), dtype=np.float32),
                     ol_hex=np.full((n, 2), np.nan, dtype=np.float32))
    return FlyBrain(W, meta)


CONTRACT_FIELDS = {"enabled": bool, "value": float, "source": str, "session_changed": bool,
                   "cumulative": float, "events": dict, "dopamine": dict,
                   "compartments": dict, "prosthetic_sites": list,
                   "resyncs": int, "anomalies": int}


def contract(cfg: RewardConfig) -> None:
    """#7 §12 AC3(ii) scope, AC4 snapshot, AC5 toggle — the checks that are not rate
    measurements. Every one either prints PASS or prints FAIL with what it saw."""
    from src.brain.encoder import Encoder

    brain, watch = _brain_and_watch(SEEDS[0])
    enc = Encoder(brain)
    loop = RewardLoop(brain, cfg, encoder=enc)
    off = RewardLoop(brain, dataclasses.replace(cfg, enabled=False), encoder=enc)
    W0 = brain.W.data.copy()
    inj = [(watch["loom"], np.float32(LOOM_GAIN))]
    base = {"phase": "playing", "session": 0}
    ok = lambda tag, good, saw="": print(f"  {'PASS' if good else 'FAIL'}  {tag}"
                                        f"{'' if good else '   saw: ' + str(saw)}")

    print("AC4 — snapshot.reward")
    tel = loop.telemetry(False)
    bad = {k: type(tel.get(k)).__name__ for k, t in CONTRACT_FIELDS.items()
           if not isinstance(tel.get(k), t)}
    ok(f"every field of §10.1 present with its type ({len(CONTRACT_FIELDS)} fields)",
       not bad, bad)
    ok("prosthetic_sites == Encoder.prosthetic_sites, element for element",
       tel["prosthetic_sites"] == enc.prosthetic_sites, tel["prosthetic_sites"])
    ok('["unknown"] and never [] with no encoder',
       RewardLoop(brain, cfg).telemetry(False)["prosthetic_sites"] == ["unknown"])

    # (a) two events between emitted frames: `value` is their signed sum, not the last.
    for _ in range(WARM):
        loop.observe(brain.step(inject=inj))
    loop.on_state({**base, "t": 0.0, "base": {"launchers_alive": 7}}, False)
    loop.on_state({**base, "t": 0.05, "base": {"launchers_alive": 5}}, False)
    loop.on_state({**base, "t": 0.10, "base": {"launchers_alive": 4}}, False)
    tel = loop.telemetry(False)
    ok("two events between frames sum into `value` (-2 then -1 => -3)",
       tel["value"] == -3.0 and tel["source"] == PUNISH, (tel["value"], tel["source"]))
    ok("`value` drains: the next frame reads 0.0 with source none",
       (loop.telemetry(False)["value"], loop.telemetry(False)["source"]) == (0.0, "none"))

    print("\nAC3(ii) — scope: nothing outside the compartments moved")
    touched = np.zeros(brain.W.data.size, bool)
    for part in loop._parts:
        touched[part["sel"]] = True
    moved = brain.W.data != W0
    ok(f"{int(moved.sum())} of {int(touched.sum())} compartment edges changed; "
       f"{int((moved & ~touched).sum())} outside them", not (moved & ~touched).any())
    ct = brain.meta.cell_type
    kc = np.flatnonzero(np.char.startswith(ct, "KC"))
    mb = np.flatnonzero(np.char.startswith(ct, "MBON"))
    kcmbon, _ = _edges(brain.W, kc, mb)
    rest = kcmbon[~touched[kcmbon]]
    ok(f"the {rest.size} KC->MBON edges outside both compartments are bit-identical",
       np.array_equal(brain.W.data[rest], W0[rest]))
    sample = np.random.default_rng(7).choice(
        np.flatnonzero(~touched), size=10_000, replace=False)
    ok("a 10,000-edge random sample of the rest of W is bit-identical",
       np.array_equal(brain.W.data[sample], W0[sample]))
    loop.reset()
    ok("reset() restores every weight by assignment", np.array_equal(brain.W.data, W0))

    print("\nAC5 — the toggle is the control condition")
    states = [{**base, "t": i * 0.05,
               "base": {"launchers_alive": 7 - (i > 40) - (i > 120)}} for i in range(200)]
    trains = []
    for use_loop in (True, False):
        brain.reset(SEEDS[0])
        off.reset()
        si, train = 0, []
        for step in range(400):
            while si < len(states) and states[si]["t"] <= step * brain.params.dt:
                if use_loop:
                    off.on_state(states[si], False)
                si += 1
            extra = off.inject() if use_loop else []
            fired = brain.step(inject=inj + extra)
            if use_loop:
                off.observe(fired)
            train.append(fired)
        trains.append(train)
    ok("(a) W.data bit-identical after 400 steps with >= 1 loss",
       np.array_equal(brain.W.data, W0))
    same = all(np.array_equal(a, b) for a, b in zip(*trains))
    ok("(b) fired-index sequence identical, step for step, to no RewardLoop at all", same)
    tel = off.telemetry(False)
    ok("(c) enabled is False, value == 0.0, source == 'disabled'",
       tel["enabled"] is False and tel["value"] == 0.0 and tel["source"] == "disabled", tel)


def _brain_and_watch(seed: int):
    W, m = load(ROOT / "data")
    brain = FlyBrain(W, m, seed=seed)
    ct = m.cell_type
    return brain, {"mbon": np.flatnonzero(ct == "MBON25,MBON34"),
                   "dnp01": np.flatnonzero(ct == "DNp01"),
                   "loom": np.flatnonzero(np.isin(ct, ["LC4", "LPLC2"]) & (m.side == "L"))}


def _disclosure(loop: RewardLoop, *, encoder_live: bool) -> None:
    """#7 §8 and its addendum. Says what was actually true of THIS run: the replay modes
    inject the looming site directly and run neither encoder nor decoder, so no aim
    prosthesis is active in them and claiming one would be its own small lie."""
    tel = loop.telemetry(False)
    print(f"prosthetic_sites (from snapshot.reward, #7 §8): {tel['prosthetic_sites']}")
    if encoder_live:
        print("Aiming in this run used the PFL3 `aim_bias` prosthesis.", end=" ")
    else:
        print("This run drives the brain by direct injection into LC4+LPLC2-L. No encoder\n"
              "and no decoder run, so no aim prosthesis was active and `prosthetic_sites`\n"
              "reads ['unknown']. In the closed loop it is active:", end=" ")
    print("With it disabled, the decoder's\naim is at chance (0.945 of shuffled); with it "
          "enabled it is 0.671 of shuffled.\nDNa02 receives 0.000 of its input from "
          "LC4/LPLC2.\n")


# ------------------------------------------------------------------ modes


def trajectory(cfg: RewardConfig, trace: dict) -> None:
    """No LIF: the weight trajectory the recorded loss streams command, per session.

    #7 §5.6 fixed `lr` by simulating this against a dose-response measured before the rule
    existed, and predicted min w/w0 in 0.799-0.854. Re-running it on a fresh stimulus is
    how that prediction is checked WITHOUT retuning `lr` to reach it (#7 risk R7).
    """
    brain = _null_brain()
    loop = RewardLoop(brain, cfg)
    dt = brain.params.dt
    # The eligibility trace is driven at the real brain-step cadence, with the stand-in
    # KC firing every step. That is not an assumption: #7 §3.2 measured every one of the
    # real KCs firing on every step. Feeding it explicitly exercises the same `observe`
    # path the server uses, so a broken trace shows up here as it would on the brain.
    kc = np.flatnonzero(np.char.startswith(brain.meta.cell_type, "KC"))
    print(f"lr={cfg.lr}  t_survive={cfg.t_survive}  tau_decay={cfg.tau_decay}\n")
    # Both compartments, because they are the evidence that each answers only to its own
    # valence: a reward must move `reward` and leave `punish` at its punishment-only path.
    print("sess  dur   losses  R  P   min w/w0 (punish)  end w/w0   max w/w0 (reward)")
    for i, session in enumerate(trace["sessions"]):
        states = wire(session)
        loop.reset()
        lo, last, si, hi = 1.0, 1.0, 0, 1.0
        n = {REWARD: 0, PUNISH: 0}
        for step in range(int(states[-1]["t"] / dt)):
            while si < len(states) and states[si]["t"] <= step * dt:
                ev = loop.on_state(states[si], False)
                si += 1
                if ev.kind in (REWARD, PUNISH):
                    n[ev.kind] += 1
            loop.observe(kc)
            eff = loop.efficacy()
            last = eff[PUNISH]
            lo, hi = min(lo, last), max(hi, eff[REWARD])
        print(f"{i:>4}  {session['dur']:>5.0f}s {len(session['losses']):>5}  "
              f"{n[REWARD]:>2} {n[PUNISH]:>2}   {lo:>14.4f}  {last:>9.4f}   {hi:>14.4f}")


def direction(cfg: RewardConfig) -> None:
    """§12.AC6, restated as verification by execution: reward > 1.0, punish < 1.0.

    THIS DIRECTION IS AN ENGINEERED VALENCE ASSIGNMENT, NOT THE BIOLOGY. The reference
    implementation's anti-Hebbian rule (Huang, Luo et al. 2024) depresses in BOTH
    compartments and takes behavioural valence from which compartment is depressed; #7
    Correction 6 pins this issue's convention as the default and leaves the other one
    config-deep. One `sign` field, no code change.
    """
    from src.brain.encoder import Encoder

    brain, watch = _brain_and_watch(SEEDS[0])
    loop = RewardLoop(brain, cfg, encoder=Encoder(brain))
    _disclosure(loop, encoder_live=True)
    inj = [(watch["loom"], np.float32(LOOM_GAIN))]
    settle = int(5 * cfg.tau_elig / brain.params.dt)  # 5 tau, so this is not a transient
    for _ in range(settle):
        loop.observe(brain.step(inject=inj))
    print(f"eligibility after {settle} steps: mean={loop._e.mean():.4f} "
          f"min={loop._e.min():.4f} max={loop._e.max():.4f}   "
          f"(#7 §5.4: degenerate, every KC fires every step)")
    print(f"baseline                      {loop.efficacy()}")

    base = {"phase": "playing", "session": 0}
    loop.on_state({**base, "t": 0.0, "base": {"launchers_alive": 7}}, False)
    loop.on_state({**base, "t": 0.05, "base": {"launchers_alive": 6}}, False)
    print(f"after one isolated PUNISH     {loop.efficacy()}")
    print(f"  dopamine {loop.telemetry(False)['dopamine']}  "
          f"inject sites {[len(i) for i, _ in loop.inject()]}")
    loop.on_state({**base, "t": 0.05 + cfg.t_survive, "base": {"launchers_alive": 6}}, False)
    print(f"after one isolated REWARD     {loop.efficacy()}")
    print(f"  dopamine {loop.telemetry(False)['dopamine']}")

    eff = loop.efficacy()
    ok = eff[REWARD] > 1.0 and eff[PUNISH] < 1.0
    print(f"\nAC6 direction (reward > 1.0 and punish < 1.0): {'PASS' if ok else 'FAIL'}")


def arms(cfg: RewardConfig, trace: dict, which: int, seeds: tuple[int, ...]) -> None:
    session = trace["sessions"][which]
    states = wire(session)
    events = detect(cfg, states)
    print(f"session {which}: dur={session['dur']:.0f}s losses={len(session['losses'])} "
          f"events={len(events)} "
          f"({sum(e.kind == REWARD for e in events)}R/{sum(e.kind == PUNISH for e in events)}P)"
          f"  steps/arm={int(states[-1]['t'] / 0.020)}\n")

    brain, watch = _brain_and_watch(seeds[0])
    loops = {"A": RewardLoop(brain, cfg),
             "C": RewardLoop(brain, dataclasses.replace(cfg, enabled=False))}
    loops["B"] = loops["A"]
    _disclosure(loops["A"], encoder_live=False)

    rows: dict[str, list[dict]] = {"A": [], "B": [], "C": []}
    for seed in seeds:
        for arm in ("A", "B", "C"):
            ev = shuffle(events, np.random.default_rng(seed)) if arm == "B" else None
            counts, eff, dt = replay(brain, loops[arm], watch, states, arm, seed, ev)
            row = windows(counts, eff, dt) | {"seed": seed}
            rows[arm].append(row)
            print(f"  seed {seed:>3} arm {arm}: MBON25,MBON34 tail={row['tail_mbon']:7.2f} Hz  "
                  f"DNp01 tail={row['tail_dnp01']:6.2f} Hz  "
                  f"min w/w0={row.get('min_eff', float('nan')):.4f} "
                  f"@{row.get('min_mbon', float('nan')):7.2f} Hz")

    def stat(arm, key):
        v = np.array([r[key] for r in rows[arm]])
        return v.mean(), v.std(ddof=1)

    print("\narm   MBON25,MBON34 tail      DNp01 tail")
    for arm in ("A", "B", "C"):
        m, sd = stat(arm, "tail_mbon")
        d, dsd = stat(arm, "tail_dnp01")
        print(f"  {arm}   {m:8.2f} +/- {sd:5.2f}     {d:6.2f} +/- {dsd:5.2f}")

    print("\n#   hypothesis                            predicted  |diff|   result")
    for tag, a, b, key, pred in (("H1", "A", "C", "tail_mbon", "TRUE"),
                                 ("H2", "A", "B", "tail_mbon", "FALSE"),
                                 ("H3", "A", "C", "tail_dnp01", "FALSE")):
        diff = abs(stat(a, key)[0] - stat(b, key)[0])
        got = "TRUE" if diff >= THRESHOLD_HZ else "FALSE"
        flag = "" if got == pred else "   <-- DISAGREES WITH THE PREDICTION"
        what = "DNp01" if key == "tail_dnp01" else "MBON25,MBON34"
        print(f"{tag}  {a} vs {b} on {what:<14s} >= {THRESHOLD_HZ} Hz    "
              f"{pred:<9s}  {diff:6.2f}   {got}{flag}")
    print("\nH3's score half is untestable here: all three arms replay one recorded "
          "stimulus,\nso no arm can score differently by construction. See the header.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--direction", action="store_true", help="§12.AC6 direction check")
    ap.add_argument("--trajectory", action="store_true", help="weight trajectory, no LIF")
    ap.add_argument("--contract", action="store_true", help="§12 AC3(ii), AC4, AC5")
    ap.add_argument("--session", type=int, default=0)
    ap.add_argument("--seeds", type=int, nargs="+", default=list(SEEDS))
    args = ap.parse_args()

    cfg = RewardConfig.default()
    if args.direction:
        return direction(cfg)
    if args.contract:
        return contract(cfg)
    if not TRACE.exists():
        raise SystemExit(f"{TRACE} not found; run: node tools/spike/reward-cadence.mjs --json")
    trace = json.loads(TRACE.read_text())
    if args.trajectory:
        return trajectory(cfg, trace)
    arms(cfg, trace, args.session, tuple(args.seeds))


if __name__ == "__main__":
    main()
