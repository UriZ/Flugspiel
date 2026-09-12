// The only place logical<->normalized conversion, entity naming and state assembly live.
// Spec #2 §2.3, §3.1 (as amended by v2.1 §3, §4).

import { Renderer } from './vendor/engine/renderer.js';

export const LOGICAL_W = Renderer.LOGICAL_W; // 2560 — imported, never hardcoded
export const LOGICAL_H = Renderer.LOGICAL_H; // 1440

/** Logical px -> normalized [0,1] (not clamped: entities legitimately spawn off-screen). */
export function toNorm(x, y) {
  return { x: x / LOGICAL_W, y: y / LOGICAL_H };
}

/** Normalized -> logical px. */
export function toLogical(nx, ny) {
  return { x: nx * LOGICAL_W, y: ny * LOGICAL_H };
}

// Wire format decoupled from upstream class names. 18 classes; see v2.1 §4 for the
// group-by-group derivation. QuadDrone is latent upstream (only its subclasses are
// instantiated at 458c3fb) but is mapped so a future direct spawn is not 'unknown'.
const KINDS = {
  EnemyMissile: 'missile',
  ShockMissile: 'shock_missile',
  SuperMissile: 'super_missile',
  MissileFragment: 'fragment',
  Nuke: 'nuke',
  Drone: 'drone',
  SuicideDrone: 'suicide_drone',
  TransportPlane: 'transport_plane',
  Paratrooper: 'paratrooper',
  QuadDrone: 'quad_drone',
  AttackQuad: 'attack_quad',
  KamikazeQuad: 'kamikaze_quad',
  QuadTracer: 'quad_tracer',
  ShockWave: 'shock_wave',
  Missile: 'interceptor',
  HeatSeekingMissile: 'heat_seeker',
  VulkanBullet: 'vulkan_bullet',
  HunterDrone: 'hunter_drone',
};

/** @returns {string} stable snake_case kind, or 'unknown' for an unmapped class. */
export function kindOf(entity) {
  return KINDS[entity?.constructor?.name] ?? 'unknown';
}

const MIN_SAMPLE_DT = 0.008; // s — below this, reuse the last velocity (guards /0)

/**
 * Finite-differenced velocity in normalized screen-widths/heights per second.
 * Uniform across all entity classes: `Drone` and `TransportPlane` carry no vx/vy
 * field at all, so reading the entity would give the encoder two semantics.
 * WeakMap-keyed on the entity object — a Map would retain every entity ever spawned.
 */
export class VelocityTracker {
  constructor() {
    /** @type {WeakMap<object, {x:number,y:number,t:number,vx:number,vy:number}>} */
    this._last = new WeakMap();
  }

  /** @returns {{vx:number, vy:number}} zero on an entity's first sample. */
  sample(entity, t) {
    const prev = this._last.get(entity);
    if (!prev) {
      const fresh = { x: entity.x, y: entity.y, t, vx: 0, vy: 0 };
      this._last.set(entity, fresh);
      return { vx: 0, vy: 0 };
    }
    const dt = t - prev.t;
    if (dt < MIN_SAMPLE_DT) return { vx: prev.vx, vy: prev.vy };

    prev.vx = (entity.x - prev.x) / LOGICAL_W / dt;
    prev.vy = (entity.y - prev.y) / LOGICAL_H / dt;
    prev.x = entity.x;
    prev.y = entity.y;
    prev.t = t;
    return { vx: prev.vx, vy: prev.vy };
  }
}

function toWire(entity, tracker, t) {
  const { vx, vy } = tracker.sample(entity, t);
  return { kind: kindOf(entity), ...toNorm(entity.x, entity.y), vx, vy };
}

/**
 * Assemble a GameState snapshot. Safe in every phase — on the start screen
 * `game.launchers` is [] and `selectedLauncher` is null.
 */
export function buildState(game, tracker, seq, t, mode, session = 0) {
  const launchers = game.launchers;

  // Build from game.launchers, not entities.getGroup('launchers'): the former keeps
  // dead launchers so indices stay stable for the whole session.
  const wireLaunchers = launchers.map((l, i) => ({
    i,
    kind: l.type,
    ...toNorm(l.x, l.y),
    alive: l.alive,
    hp: l.hp,
    selected: l === game.selectedLauncher,
  }));

  const alive = launchers.filter((l) => l.alive);
  const maxHpTotal = launchers.reduce((s, l) => s + l.maxHp, 0);

  const missiles = [
    ...game.entities.getGroup('enemy_missiles'),
    ...game.entities.getGroup('shock_waves'),
  ].map((e) => toWire(e, tracker, t));

  return {
    seq,
    t,
    phase: game.state,
    mode,
    // Restart token, not a counter to do arithmetic on. In fly mode the 'gameover' phase
    // can last a single frame, so a 20 Hz consumer can see launchers_alive jump 1 -> 7
    // with no 'gameover' sample between; #7 must discard reward across a change of this
    // field rather than difference through it. 0 = no session observed since attach.
    session,
    score: game.score,
    wave: game.waveNumber,
    weapon: launchers.indexOf(game.selectedLauncher),
    base: {
      // DISCONTINUOUS — step-jumps when a launcher dies. Do not treat as a smooth signal.
      x: alive.length ? toNorm(alive.reduce((s, l) => s + l.x, 0) / alive.length, 0).x : 0.5,
      // Sensory only: rises during inter-wave recovery. #7's reward loop must key on
      // launchers_alive instead (architecture.md § Data Model).
      health: maxHpTotal ? launchers.reduce((s, l) => s + l.hp, 0) / maxHpTotal : 0,
      launchers_alive: alive.length,
    },
    launchers: wireLaunchers,
    missiles,
    interceptors: game.entities.getGroup('player_missiles').map((e) => toWire(e, tracker, t)),
  };
}
