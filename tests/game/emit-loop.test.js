// T27–T32 — spec #2 §6.2, amended by v2.1 §2. Every reference count below came from
// running tools/spike/emit-rate.mjs, not from reasoning about the code.
//
// T28/T29/T29b drive `_afterFrame(dt)` directly: they need tens of thousands of
// simulated frames at exact `dt`s, which is the accumulator's contract, not the
// game's. T27/T30/T31/T32 go through the real `game.update` patch end to end.

import { makeCanvas } from '../helpers/dom-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../../src/game/vendor/game.js';
import { FlyBridge } from '../../src/game/fly-bridge.js';
import { RecordingTransport } from '../helpers/recording-transport.js';

function rig({ started = true, throws = false, transport = true, ...options } = {}) {
  const game = new Game(makeCanvas());
  if (started) game.start();
  const bridge = new FlyBridge(game, options);
  const tx = new RecordingTransport({ throws });
  if (transport) bridge.setTransport(tx);
  return { game, bridge, tx };
}

/** Emits over N frames of a fixed dt, straight through the accumulator. */
function emits(bridge, tx, hz, frames, dt = 1 / 60) {
  bridge.setEmitRate(hz);
  bridge.startEmitting();
  const before = tx.count;
  for (let i = 0; i < frames; i++) bridge._afterFrame(dt);
  return tx.count - before;
}

test('T27 20 Hz default over one simulated second through the real game loop', () => {
  const { game, bridge, tx } = rig();
  assert.equal(bridge.getEmitRate(), 20);
  bridge.startEmitting();
  assert.equal(bridge.isEmitting(), true);
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.ok(Math.abs(tx.count - 20) <= 1, `sends=${tx.count}`);
  assert.equal(bridge.getStats().emitted, tx.count);
  // seq is contiguous when nothing is dropped, so a consumer can detect gaps.
  assert.deepEqual(tx.sent.map((s) => s.seq), tx.sent.map((_, i) => i));
});

test('T28 effective rate is min(hz, fps), including rates that do not divide 60', () => {
  // Reference counts over 600 frames @ 60 fps, from tools/spike/emit-rate.mjs.
  // A variant-A (`acc = 0`) implementation returns 85/200/200/300/300/300/600/600.
  const expected = { 10: 99, 20: 200, 25: 249, 40: 399, 45: 449, 50: 499, 60: 600, 120: 600 };
  for (const [hz, reference] of Object.entries(expected)) {
    const { bridge, tx } = rig();
    const n = emits(bridge, tx, Number(hz), 600);
    assert.equal(n, reference, `${hz} Hz: expected the spike's ${reference}, got ${n}`);
    assert.ok(Math.abs(n - Math.min(Number(hz), 60) * 10) <= 1, `${hz} Hz off contract: ${n}`);
  }
});

test('T28b setEmitRate rejects bad configuration loudly and atomically', () => {
  const { bridge } = rig();
  for (const bad of [0, -5, 241, NaN, '20', null, undefined, Infinity]) {
    assert.throws(() => bridge.setEmitRate(bad), RangeError, `setEmitRate(${String(bad)})`);
    assert.equal(bridge.getEmitRate(), 20, `rate changed after rejecting ${String(bad)}`);
  }
  bridge.setEmitRate(240);
  assert.equal(bridge.getEmitRate(), 240);
});

test('T29 at most one emit per frame, however high the requested rate', () => {
  const { bridge, tx } = rig();
  bridge.setEmitRate(120);
  bridge.startEmitting();
  for (let i = 0; i < 600; i++) {
    const before = tx.count;
    bridge._afterFrame(1 / 60);
    assert.ok(tx.count - before <= 1, `frame ${i} emitted ${tx.count - before} times`);
  }
  assert.equal(tx.count, 600);
});

test('T29b a throttled tab banks no backlog — regression for v2.1 §1', () => {
  const { bridge, tx } = rig();
  // 60 s throttled to 20 fps (upstream's startLoop caps dt at 1/20) at 40 Hz requested:
  // every frame is a full interval of credit, which is what makes an unclamped
  // accumulator run away.
  emits(bridge, tx, 40, 1200, 0.05);
  const after = tx.count;
  for (let i = 0; i < 3600; i++) bridge._afterFrame(1 / 60);
  const recovered = tx.count - after;
  // Variant A (`acc = 0`) gives 1800; variant B (unclamped `acc -= iv`) gives 3600.
  assert.ok(Math.abs(recovered - 2400) <= 1, `60 s of recovery emitted ${recovered}, want ~2400`);
});

test('T30 stopEmitting silences the loop; a missing transport is counted, not fatal', () => {
  const { game, bridge, tx } = rig();
  bridge.startEmitting();
  for (let i = 0; i < 30; i++) game.update(1 / 60);
  const sent = tx.count;
  assert.ok(sent > 0);

  bridge.stopEmitting();
  assert.equal(bridge.isEmitting(), false);
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.equal(tx.count, sent, 'no sends after stopEmitting');

  const solo = rig({ transport: false });
  solo.bridge.startEmitting();
  assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) solo.game.update(1 / 60); });
  assert.ok(solo.bridge.getStats().skipped > 0);
  assert.equal(solo.bridge.getStats().emitted, 0);
});

test('T31 a throwing transport never breaks the game loop', () => {
  const { game, bridge, tx } = rig({ throws: true });
  bridge.startEmitting();
  assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) game.update(1 / 60); });
  const stats = bridge.getStats();
  assert.ok(stats.sendErrors > 0, 'errors counted');
  assert.equal(stats.emitted, 0, 'a failed send is not counted as emitted');
  assert.equal(tx.count, stats.sendErrors);
  assert.equal(game.state, 'playing', 'the game kept updating');
  assert.match(stats.lastError.message, /transport down/, 'and stayed diagnosable');
});

test('T31b a codec failure surfaces instead of being laundered as a transport error', () => {
  const { game, bridge } = rig();
  bridge.startEmitting();
  assert.equal(bridge.getStats().lastError, null);
  bridge.getState = () => { throw new Error('codec bug'); };

  // The snapshot is taken outside the transport try — our own bug must not be
  // swallowed and counted as someone else's socket failing.
  assert.throws(() => { for (let i = 0; i < 10; i++) game.update(1 / 60); }, /codec bug/);
  assert.equal(bridge.getStats().sendErrors, 0);
});

test('T32 a long stall produces one emit, not a burst', () => {
  const { game, bridge, tx } = rig();
  bridge.startEmitting();
  // 0.5 s at 20 Hz is 10 nominal intervals. Reachable only past startLoop's dt cap
  // (a debugger pause, or a direct update() like this one).
  game.update(0.5);
  assert.equal(tx.count, 1);
  // And the banked credit is one interval at most, so the next second is not a burst.
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.ok(Math.abs(tx.count - 1 - 20) <= 1, `follow-up second sent ${tx.count - 1}`);
});
