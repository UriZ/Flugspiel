// Spike: how often does `launchers_alive` drop in open-loop (no-action) play, and what
// survival interval makes #7's reward loop comparable in count to its punishment events?
// Evidence for spec #7 §4 (`t_survive` default, one-shot arming) and for the null
// distribution the shuffle control is compared against.
//
//   node tools/spike/reward-cadence.mjs
//
// Runs the real vendored Game headless via tests/helpers/dom-stub.js, 10 sessions, no
// actions applied, fixed 1/60 s step, 300 s cap. The game is not seeded, so re-running
// reproduces the shape, not the digits.
//
// Two findings this spike exists to record (2026-09-13):
//
//  1. Passive play always ends with all 7 launchers lost and score 0 — an unconnected fly
//     never intercepts anything. Sessions ran 45-112 s here; an earlier 5-session batch
//     had 3 sessions still alive at a 600 s cap with 1-2 launchers left. THE GAME CAN
//     STALL. A wall-clock-repeating survival reward is therefore unbounded per session,
//     which is why #7 arms the reward ONE-SHOT per surviving interval: at most 8 reward
//     events against exactly 7 punishment events, stall or no stall.
//
//  2. Inter-loss gaps over two 10-session batches: N=70 median 5.40 s (mean 9.47,
//     p25 2.35, p75 12.77) and N=67 median 4.65 s (mean 12.55, p25 2.08, p75 14.32).
//     One-shot reward/punishment ratio per session, median over 10 sessions, both
//     batches agreeing to within one step of the sweep:
//       T=2 0.86   T=3 0.71   T=4 0.57   T=5 0.57   T=6 0.43   T=8 0.43
//     ADOPTED t_survive = 5.0 s — the rounded median gap, so the reward event fires on
//     roughly half of surviving intervals and is maximally informative.

import { makeCanvas } from '../../tests/helpers/dom-stub.js';
import { Game } from '../../src/game/vendor/game.js';
import { FlyBridge } from '../../src/game/fly-bridge.js';

const DT = 1 / 60;
const RUNS = 10;
const MAX_SECS = 300;

function session() {
  const game = new Game(makeCanvas());
  const bridge = new FlyBridge(game);
  bridge.setMode('fly');
  bridge.startGame();
  const losses = [];
  let prev = null, t = 0;
  for (let i = 0; i < MAX_SECS * 60; i++) {
    game.update(DT);
    t += DT;
    const s = bridge.getState();
    if (prev === null) prev = s.base.launchers_alive;
    if (s.base.launchers_alive < prev) { losses.push(t); prev = s.base.launchers_alive; }
    if (s.phase !== 'playing') return { losses, dur: t, end: s.phase, score: s.score };
  }
  return { losses, dur: t, end: 'timeout(STALLED)', score: 0 };
}

const runs = [];
for (let k = 0; k < RUNS; k++) runs.push(session());
console.log('ends: ' + runs.map((r) => `${r.end}@${r.dur.toFixed(0)}s/${r.losses.length}L/score${r.score}`).join('  '));

const gaps = [];
for (const r of runs) {
  let last = 0;
  for (const t of r.losses) { gaps.push(t - last); last = t; }
}
gaps.sort((a, b) => a - b);
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
console.log(`\nN=${gaps.length} inter-loss gaps: mean=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)}s `
  + `p25=${q(0.25).toFixed(2)} median=${q(0.5).toFixed(2)} p75=${q(0.75).toFixed(2)}`);

console.log('\nt_survive sweep, ONE-SHOT arming (at most one reward per surviving interval):');
for (const T of [2, 3, 4, 5, 6, 8]) {
  const rp = runs.map((r) => {
    let R = 0, last = 0;
    for (const t of r.losses) { if (t - last >= T) R++; last = t; }
    if (r.dur - last >= T) R++;
    return R / Math.max(r.losses.length, 1);
  });
  const sorted = [...rp].sort((a, b) => a - b);
  console.log(`  T=${T}  ${rp.map((x) => x.toFixed(2)).join(' ')}  median=${sorted[rp.length >> 1].toFixed(2)}`);
}
