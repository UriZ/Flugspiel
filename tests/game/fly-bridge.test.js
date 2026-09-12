// T17–T26 — spec #2 §6.2. Integration against the *real* upstream `Game` under the
// DOM stub: the seam these tests pin is the whole point of the design (§2.1), so a
// mock game would test nothing.

import { makeCanvas } from '../helpers/dom-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../../src/game/vendor/game.js';
import { FlyBridge } from '../../src/game/fly-bridge.js';
import { LOGICAL_W, LOGICAL_H } from '../../src/game/state-codec.js';
import { humanInput } from '../helpers/human-input.js';

/** A real Game with a bridge attached. `started` runs upstream's own start(). */
function rig({ mode = 'fly', started = true, ...options } = {}) {
  const game = new Game(makeCanvas());
  if (started) game.start();
  return { game, bridge: new FlyBridge(game, { mode, ...options }) };
}

const shots = (game) => game.entities.getGroup('player_missiles').length;
const frames = (game, n = 1) => { for (let i = 0; i < n; i++) game.update(1 / 60); };

test('T17 getState on a live game has every §3.1 field, typed and in range', () => {
  const { game, bridge } = rig();
  frames(game, 30);
  const s = bridge.getState();

  assert.equal(s.seq, 0);
  assert.equal(bridge.getState().seq, 1, 'seq increments per call');
  assert.ok(s.t > 0 && Number.isFinite(s.t));
  assert.equal(s.phase, 'playing');
  assert.equal(s.mode, 'fly');
  assert.equal(typeof s.score, 'number');
  assert.equal(typeof s.wave, 'number');
  assert.ok(Number.isInteger(s.weapon) && s.weapon >= 0 && s.weapon <= 6);

  assert.ok(s.base.x >= 0 && s.base.x <= 1, `base.x=${s.base.x}`);
  assert.ok(s.base.health >= 0 && s.base.health <= 1, `base.health=${s.base.health}`);
  assert.equal(s.base.launchers_alive, 7);

  assert.equal(s.launchers.length, 7);
  for (const [i, l] of s.launchers.entries()) {
    assert.equal(l.i, i);
    assert.equal(typeof l.kind, 'string');
    assert.ok(l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1, `launcher ${i} at ${l.x},${l.y}`);
    assert.equal(typeof l.alive, 'boolean');
    assert.ok(l.hp >= 0 && l.hp <= 1, `hp=${l.hp}`);
    assert.equal(typeof l.selected, 'boolean');
  }
  assert.equal(s.launchers.filter((l) => l.selected).length, 1);

  for (const e of [...s.missiles, ...s.interceptors]) {
    assert.equal(typeof e.kind, 'string');
    for (const n of [e.x, e.y, e.vx, e.vy]) assert.ok(Number.isFinite(n), `${e.kind} ${n}`);
  }
});

test('T18 fire denormalizes to logical pixels and reaches the unmodified fire path', () => {
  const { game, bridge } = rig();
  const before = shots(game);
  assert.deepEqual(bridge.applyAction({ action: 'fire', x: 0.6, y: 0.2 }), { ok: true });
  frames(game);
  assert.equal(shots(game), before + 1);
  assert.equal(game.input.mouseX, 0.6 * LOGICAL_W); // 1536
  assert.equal(game.input.mouseY, 0.2 * LOGICAL_H); // 288
  assert.equal(bridge.getStats().actionsAccepted, 1);
});

test('T19 fly mode suppresses human input entirely', () => {
  const { game } = rig();
  const before = shots(game);
  humanInput(game.input);
  frames(game);
  assert.equal(shots(game), before);
});

test('T20 human mode: humans play, the brain is locked out — AC5', () => {
  const { game, bridge } = rig({ mode: 'human' });
  assert.equal(bridge.getMode(), 'human');

  const before = shots(game);
  humanInput(game.input);
  frames(game);
  assert.equal(shots(game), before + 1, 'a human click still fires exactly one interceptor');

  const after = shots(game);
  assert.deepEqual(
    bridge.applyAction({ action: 'fire', x: 0.5, y: 0.2 }),
    { ok: false, reason: 'not_in_fly_mode' },
  );
  frames(game, 3);
  assert.equal(shots(game), after, 'the rejected action fired nothing');
  assert.equal(bridge.getStats().actionsRejected, 1);
});

test('T21 weapon_switch selects, and switch-then-fire works in one message', () => {
  const { game, bridge } = rig();
  assert.deepEqual(bridge.applyAction({ weapon_switch: 3 }), { ok: true });
  frames(game);
  assert.equal(game.selectedLauncher.type, 'vulkan');

  // Upstream handles the number keys (game.js:368) before _handleFireInput (:412),
  // so one frame is enough for both.
  bridge.applyAction({ weapon_switch: 0 });
  const before = shots(game);
  assert.deepEqual(bridge.applyAction({ weapon_switch: 1, action: 'fire', x: 0.5, y: 0.3 }), { ok: true });
  frames(game);
  assert.equal(game.selectedLauncher.type, 'heatseeker');
  assert.ok(shots(game) > before, 'fired from the newly selected launcher');
});

test('T22 weapon_switch to a dead launcher is rejected, selection unchanged', () => {
  const { game, bridge } = rig();
  game.launchers[5].alive = false;
  const before = game.selectedLauncher;
  assert.deepEqual(bridge.applyAction({ weapon_switch: 5 }), { ok: false, reason: 'launcher_dead' });
  frames(game);
  assert.equal(game.selectedLauncher, before);
});

test('T23 hold_fire/release_fire drive the sustained weapons', () => {
  const { game, bridge } = rig();
  bridge.applyAction({ weapon_switch: 3 });
  frames(game);
  assert.equal(game.selectedLauncher.type, 'vulkan');

  const before = shots(game);
  assert.deepEqual(bridge.applyAction({ action: 'hold_fire', x: 0.5, y: 0.3 }), { ok: true });
  frames(game, 20);
  assert.ok(shots(game) > before, 'vulkan streams while held');
  assert.equal(game._vulkanWasFiring, true);

  assert.deepEqual(bridge.applyAction({ action: 'release_fire' }), { ok: true });
  frames(game);
  assert.equal(game._vulkanWasFiring, false);
});

test('T24 the §3.2 validation matrix, exactly', () => {
  const { game, bridge } = rig();
  const rows = [
    [null, { ok: false, reason: 'malformed' }],
    [undefined, { ok: false, reason: 'malformed' }],
    [42, { ok: false, reason: 'malformed' }],
    ['fire', { ok: false, reason: 'malformed' }],
    [{}, { ok: true }],
    [{ action: 'bogus' }, { ok: false, reason: 'unknown_action' }],
    [{ action: 'fire' }, { ok: false, reason: 'invalid_coords' }],
    [{ action: 'aim', x: 0.5 }, { ok: false, reason: 'invalid_coords' }],
    [{ action: 'noop', y: 0.5 }, { ok: false, reason: 'invalid_coords' }],
    [{ action: 'fire', x: NaN, y: 0.5 }, { ok: false, reason: 'invalid_coords' }],
    [{ action: 'fire', x: Infinity, y: 0.5 }, { ok: false, reason: 'invalid_coords' }],
    [{ weapon_switch: 7 }, { ok: false, reason: 'invalid_weapon' }],
    [{ weapon_switch: -1 }, { ok: false, reason: 'invalid_weapon' }],
    [{ weapon_switch: 1.5 }, { ok: false, reason: 'invalid_weapon' }],
    [{ weapon_switch: '2' }, { ok: false, reason: 'invalid_weapon' }],
    [{ weapon_switch: NaN }, { ok: false, reason: 'invalid_weapon' }],
    // JSON decoders emit explicit nulls for absent fields — both mean "not requested".
    [{ weapon_switch: null }, { ok: true }],
    [{ action: null }, { ok: true }],
    // ...and a stringly-typed payload must not slip through as coordinates.
    [{ action: 'fire', x: '0.5', y: '0.5' }, { ok: false, reason: 'invalid_coords' }],
  ];
  for (const [action, expected] of rows) {
    let got;
    assert.doesNotThrow(() => { got = bridge.applyAction(action); }, `threw on ${JSON.stringify(action)}`);
    assert.deepEqual(got, expected, JSON.stringify(action));
  }

  // Out-of-range coords clamp rather than reject: a decoder emits a continuous
  // signal, and rejecting 1.0000001 would make the screen edges unreachable.
  assert.deepEqual(bridge.applyAction({ action: 'fire', x: 1.5, y: -0.2 }), { ok: true, clamped: true });
  assert.equal(bridge.virtual.x, LOGICAL_W);
  assert.equal(bridge.virtual.y, 0);

  // An unknown action rejects the whole message — weapon_switch is not half-applied.
  const selected = game.selectedLauncher;
  assert.deepEqual(
    bridge.applyAction({ action: 'bogus', weapon_switch: 3 }),
    { ok: false, reason: 'unknown_action' },
  );
  frames(game);
  assert.equal(game.selectedLauncher, selected);
});

test('T25 actions need the playing phase; startGame() leaves the start screen', () => {
  const { game, bridge } = rig({ started: false });
  assert.equal(game.state, 'start');
  assert.deepEqual(
    bridge.applyAction({ action: 'fire', x: 0.5, y: 0.5 }),
    { ok: false, reason: 'not_playing' },
  );

  assert.deepEqual(bridge.startGame(), { ok: true });
  frames(game);
  assert.equal(game.state, 'playing');
  assert.deepEqual(bridge.startGame(), { ok: false, reason: 'already_playing' });

  bridge.setMode('human');
  assert.deepEqual(bridge.startGame(), { ok: false, reason: 'not_in_fly_mode' });
});

test('T26 setMode stops sustained fire; detach restores the prototype methods', () => {
  const { game, bridge } = rig();
  assert.throws(() => bridge.setMode('robot'), TypeError);

  bridge.applyAction({ weapon_switch: 3 });
  frames(game);
  bridge.applyAction({ action: 'hold_fire', x: 0.5, y: 0.3 });
  frames(game, 5);
  assert.equal(game._vulkanWasFiring, true);

  bridge.setMode('human');
  assert.equal(game.input.mouseDown, false, 'the real Input is released immediately');
  frames(game);
  assert.equal(game._vulkanWasFiring, false);

  const proto = Object.getPrototypeOf(game);
  assert.notEqual(game.update, proto.update, 'patched while attached');
  bridge.detach();
  assert.equal(game.update, proto.update);
  assert.equal(game.input.update, Object.getPrototypeOf(game.input).update);
  assert.equal(game.input.mouseDown, false);
  assert.equal(bridge.isEmitting(), false);

  // One bridge per Game (§4.4 gotcha 10) — and detach() clears the flag so a
  // replacement bridge can attach.
  const second = new FlyBridge(game);
  assert.throws(() => new FlyBridge(game), /already bridged/);
  second.detach();
});

test('T26b detach is idempotent — a stale detach cannot unpatch a successor', () => {
  const { game, bridge: a } = rig();
  a.detach();
  const b = new FlyBridge(game, { mode: 'fly' }); // legitimate successor
  a.detach(); // stale call from the dead bridge

  const proto = Object.getPrototypeOf(game);
  assert.notEqual(game.update, proto.update, "the successor's patch survived");
  assert.equal(game.__flyBridged, true, 'the one-bridge-per-game guard survived');
  assert.throws(() => new FlyBridge(game), /already bridged/);

  const before = shots(game);
  assert.deepEqual(b.applyAction({ action: 'fire', x: 0.5, y: 0.2 }), { ok: true });
  frames(game);
  assert.equal(shots(game), before + 1, 'the successor still drives the game');

  // A detached bridge reports it rather than claiming a success it cannot deliver.
  assert.deepEqual(a.applyAction({ action: 'fire', x: 0.5, y: 0.2 }), { ok: false, reason: 'detached' });
  assert.deepEqual(a.startGame(), { ok: false, reason: 'detached' });
  a.setMode('fly'); // even re-arming the dead bridge cannot make it lie
  assert.deepEqual(a.applyAction({ action: 'noop' }), { ok: false, reason: 'detached' });
  b.detach();
});

test('T26c a failed construction leaves the game attachable', () => {
  const game = new Game(makeCanvas());
  game.start();
  const proto = Object.getPrototypeOf(game);

  assert.throws(() => new FlyBridge(game, { emitHz: 0 }), RangeError);
  assert.throws(() => new FlyBridge(game, { mode: 'robot' }), TypeError);
  assert.equal(game.__flyBridged, undefined, 'a throwing constructor claimed nothing');
  assert.equal(game.update, proto.update, 'and installed no patch');

  const bridge = new FlyBridge(game, { mode: 'fly' }); // recovers with no manual cleanup
  const before = shots(game);
  assert.deepEqual(bridge.applyAction({ action: 'fire', x: 0.5, y: 0.2 }), { ok: true });
  frames(game);
  assert.equal(shots(game), before + 1);
  bridge.detach();
});
