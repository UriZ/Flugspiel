// T1–T10 — spec #2 §6.2. Pure-logic codec tests against hand-built game shapes.

import '../helpers/dom-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { toNorm, toLogical, kindOf, VelocityTracker, buildState, LOGICAL_W, LOGICAL_H }
  from '../../src/game/state-codec.js';
import { fakeGame, fakeLauncher, classNamed } from '../helpers/fake-game.js';

import { EnemyMissile } from '../../src/game/vendor/entities/enemy-missile.js';
import { ShockMissile } from '../../src/game/vendor/entities/shock-missile.js';
import { SuperMissile } from '../../src/game/vendor/entities/super-missile.js';
import { MissileFragment } from '../../src/game/vendor/entities/missile-fragment.js';
import { Nuke } from '../../src/game/vendor/entities/nuke.js';
import { Drone } from '../../src/game/vendor/entities/drone.js';
import { SuicideDrone } from '../../src/game/vendor/entities/suicide-drone.js';
import { TransportPlane } from '../../src/game/vendor/entities/transport-plane.js';
import { Paratrooper } from '../../src/game/vendor/entities/paratrooper.js';
import { QuadDrone } from '../../src/game/vendor/entities/quad-drone.js';
import { AttackQuad } from '../../src/game/vendor/entities/attack-quad.js';
import { KamikazeQuad } from '../../src/game/vendor/entities/kamikaze-quad.js';
import { QuadTracer } from '../../src/game/vendor/entities/quad-tracer.js';
import { ShockWave } from '../../src/game/vendor/entities/shock-wave.js';
import { Missile } from '../../src/game/vendor/entities/missile.js';
import { HeatSeekingMissile } from '../../src/game/vendor/entities/heat-seeking-missile.js';
import { VulkanBullet } from '../../src/game/vendor/entities/vulkan-bullet.js';
import { HunterDrone } from '../../src/game/vendor/entities/hunter-drone.js';

/** An instance without running the constructor — we only need `constructor.name` and x/y. */
const at = (Klass, x = 0, y = 0) => Object.assign(Object.create(Klass.prototype), { x, y });

test('T1 toNorm maps the logical viewport onto [0,1]', () => {
  assert.deepEqual(toNorm(0, 0), { x: 0, y: 0 });
  assert.deepEqual(toNorm(LOGICAL_W, LOGICAL_H), { x: 1, y: 1 });
  assert.deepEqual(toNorm(1280, 720), { x: 0.5, y: 0.5 });
  assert.equal(LOGICAL_W, 2560);
  assert.equal(LOGICAL_H, 1440);
});

test('T2 toLogical round-trips toNorm', () => {
  for (const [x, y] of [[0, 0], [2560, 1440], [1280, 720], [7, 1439], [-100, 1600]]) {
    const p = toLogical(toNorm(x, y).x, toNorm(x, y).y);
    assert.ok(Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9, `${x},${y}`);
  }
});

test('T3 off-screen entities are reported unclamped and unfiltered', () => {
  const g = fakeGame({ enemy: [at(EnemyMissile, -100, 1600)] });
  const s = buildState(g, new VelocityTracker(), 0, 0, 'fly');
  assert.equal(s.missiles.length, 1);
  assert.ok(s.missiles[0].x < 0, `x=${s.missiles[0].x}`);
  assert.ok(s.missiles[0].y > 1, `y=${s.missiles[0].y}`);
});

test('T4 all 18 mapped classes produce their kind; anything else is unknown', () => {
  const expected = new Map([
    [EnemyMissile, 'missile'], [ShockMissile, 'shock_missile'], [SuperMissile, 'super_missile'],
    [MissileFragment, 'fragment'], [Nuke, 'nuke'], [Drone, 'drone'],
    [SuicideDrone, 'suicide_drone'], [TransportPlane, 'transport_plane'],
    [Paratrooper, 'paratrooper'], [QuadDrone, 'quad_drone'], [AttackQuad, 'attack_quad'],
    [KamikazeQuad, 'kamikaze_quad'], [QuadTracer, 'quad_tracer'], [ShockWave, 'shock_wave'],
    [Missile, 'interceptor'], [HeatSeekingMissile, 'heat_seeker'],
    [VulkanBullet, 'vulkan_bullet'], [HunterDrone, 'hunter_drone'],
  ]);
  assert.equal(expected.size, 18);
  for (const [Klass, kind] of expected) assert.equal(kindOf(at(Klass)), kind, Klass.name);
  assert.equal(kindOf(at(classNamed('Blimp'))), 'unknown');
  assert.equal(kindOf(undefined), 'unknown');
});

test('T5 velocity is normalized screen-widths/heights per second', () => {
  const t = new VelocityTracker();
  const e = { x: 0, y: 1440 };
  t.sample(e, 0);
  e.x = 128;      // +128 logical px  = 0.05 widths
  e.y = 1440 - 288; // -288 logical px = -0.2 heights
  const v = t.sample(e, 0.05); // over 50 ms
  assert.ok(Math.abs(v.vx - 1.0) < 1e-12, `vx=${v.vx}`);
  assert.ok(Math.abs(v.vy - -4.0) < 1e-12, `vy=${v.vy}`);
});

test('T6 an entity first sample is zero velocity', () => {
  const v = new VelocityTracker().sample({ x: 500, y: 500 }, 3.2);
  assert.deepEqual(v, { vx: 0, vy: 0 });
});

test('T7 samples under 8 ms apart reuse the prior velocity, never NaN/Infinity', () => {
  const t = new VelocityTracker();
  const e = { x: 0, y: 0 };
  t.sample(e, 0);
  e.x = 256;
  const first = t.sample(e, 0.05);
  e.x = 300;
  const again = t.sample(e, 0.05);          // dt == 0 — the divide-by-zero case
  assert.deepEqual(again, first);
  const soon = t.sample(e, 0.05 + 0.004);   // dt == 4 ms
  assert.deepEqual(soon, first);
  for (const n of Object.values(again)) assert.ok(Number.isFinite(n));
});

test('T8 base.health is sum(hp)/sum(maxHp) and never NaN', () => {
  const mk = (hps) => fakeGame({ launchers: hps.map((hp) => fakeLauncher({ hp, alive: hp > 0 })) });
  const health = (g) => buildState(g, new VelocityTracker(), 0, 0, 'fly').base.health;
  assert.equal(health(mk([1, 1, 1, 1, 1, 1, 1])), 1);
  assert.equal(health(mk([0, 0, 0, 0, 0, 0, 0])), 0);
  assert.equal(health(mk([])), 0);
  assert.ok(Math.abs(health(mk([1, 0.5, 0, 1, 1, 1, 1])) - 5.5 / 7) < 1e-12);
});

test('T9 base.x is the mean x of alive launchers only', () => {
  const g = fakeGame({
    launchers: [
      fakeLauncher({ x: 0, alive: true }),
      fakeLauncher({ x: LOGICAL_W, alive: true }),
      fakeLauncher({ x: LOGICAL_W * 10, alive: false, hp: 0 }),
    ],
  });
  const s = buildState(g, new VelocityTracker(), 0, 0, 'fly');
  assert.equal(s.base.x, 0.5);
  assert.equal(s.base.launchers_alive, 2);

  const dead = fakeGame({ launchers: [fakeLauncher({ x: 0, alive: false, hp: 0 })] });
  const sd = buildState(dead, new VelocityTracker(), 0, 0, 'fly');
  assert.equal(sd.base.x, 0.5);
  assert.equal(sd.base.launchers_alive, 0);
});

test('T10 weapon index, and the start phase builds without throwing', () => {
  const launchers = [fakeLauncher({ type: 'sam' }), fakeLauncher({ type: 'vulkan' })];
  const sel = buildState(fakeGame({ launchers, selected: 1 }), new VelocityTracker(), 0, 0, 'fly');
  assert.equal(sel.weapon, 1);
  assert.equal(sel.launchers[1].selected, true);
  assert.equal(sel.launchers[0].selected, false);

  const none = buildState(fakeGame({ launchers }), new VelocityTracker(), 0, 0, 'fly');
  assert.equal(none.weapon, -1);

  const start = buildState(fakeGame({ state: 'start' }), new VelocityTracker(), 7, 1.5, 'human');
  assert.equal(start.phase, 'start');
  assert.equal(start.weapon, -1);
  assert.deepEqual(start.base, { x: 0.5, health: 0, launchers_alive: 0 });
  assert.deepEqual(start.launchers, []);
  assert.equal(start.seq, 7);
  assert.equal(start.t, 1.5);
  assert.equal(start.mode, 'human');
});
