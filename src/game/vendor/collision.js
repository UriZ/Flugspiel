/**
 * CollisionSystem — per-frame collision detection between entity groups.
 *
 * Translates main.gd's Area2D overlap handling into explicit group-vs-group
 * circle tests and heightmap checks. Check order matches the original:
 *
 *   1. player_missiles vs enemy_missiles  — circle/circle
 *   2. enemy_missiles  vs terrain         — heightmap Y check
 *   3. enemy_missiles  vs launchers       — circle/circle
 *   4. player_missiles vs terrain         — heightmap Y check
 *
 * Each entity is marked "hit" before any side-effects are applied so that
 * a single entity cannot trigger more than one collision response per frame.
 */

import { Explosion } from './explosion.js';
import { DroneKillExplosion } from './entities/drone-kill-explosion.js';
import { MushroomCloud } from './entities/mushroom-cloud.js';
import { Crater } from './crater.js';
import { MissileFragment } from './entities/missile-fragment.js';

// ------------------------------------------------------------------
// Type guards — checked by constructor name so no import cycles are
// needed for instanceof. The strings match the class names exactly.
// ------------------------------------------------------------------

/** @param {import('./entities/entity.js').Entity} e */
function isSuperMissile(e) { return e.constructor.name === 'SuperMissile'; }

/** @param {import('./entities/entity.js').Entity} e */
function isSuicideDrone(e) { return e.constructor.name === 'SuicideDrone'; }

/** @param {import('./entities/entity.js').Entity} e */
function isVulkanBullet(e) { return e.constructor.name === 'VulkanBullet'; }

/** @param {import('./entities/entity.js').Entity} e */
function isNuke(e) { return e.constructor.name === 'Nuke'; }

/** @param {import('./entities/entity.js').Entity} e */
function isHeatSeekingMissile(e) { return e.constructor.name === 'HeatSeekingMissile'; }

/** @param {import('./entities/entity.js').Entity} e */
function isMissileFragment(e) { return e.constructor.name === 'MissileFragment'; }

/** @param {import('./entities/entity.js').Entity} e */
function isTransportPlane(e) { return e.constructor.name === 'TransportPlane'; }

/** @param {import('./entities/entity.js').Entity} e */
function isParatrooper(e) { return e.constructor.name === 'Paratrooper'; }

/** @param {import('./entities/entity.js').Entity} e */
function isHunterDrone(e) { return e.constructor.name === 'HunterDrone'; }

/** @param {import('./entities/entity.js').Entity} e */
function isAttackQuad(e) { return e.constructor.name === 'AttackQuad'; }

/** @param {import('./entities/entity.js').Entity} e */
function isKamikazeQuad(e) { return e.constructor.name === 'KamikazeQuad'; }

/** @param {import('./entities/entity.js').Entity} e */
function isQuadTracer(e) { return e.constructor.name === 'QuadTracer'; }

/** @param {import('./entities/entity.js').Entity} e */
function isShockMissile(e) { return e.constructor.name === 'ShockMissile'; }

// ------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------

/**
 * Returns true when two circle-bounded entities overlap.
 * @param {import('./entities/entity.js').Entity} a
 * @param {import('./entities/entity.js').Entity} b
 */
function circlesOverlap(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  // Avoid sqrt when possible by comparing squared distances.
  const sumR = a.collisionRadius + b.collisionRadius;
  return dx * dx + dy * dy < sumR * sumR;
}

/**
 * Returns true when an entity's position is at or below the terrain surface.
 * @param {import('./entities/entity.js').Entity} entity
 * @param {import('./terrain.js').Terrain} terrain
 */
function collidesWithTerrain(entity, terrain) {
  return entity.y >= terrain.getHeightAt(entity.x);
}

// ------------------------------------------------------------------
// Effect helpers — spawn into the entity manager
// ------------------------------------------------------------------

/**
 * @param {import('./entities/entity-manager.js').EntityManager} em
 * @param {object} game
 * @param {number} x
 * @param {number} y
 * @param {boolean} isMega
 */
function spawnExplosion(em, game, x, y, isMega = false) {
  em.add(new Explosion(x, y, isMega));
  game.audio.playExplosion(x, isMega);
}

/**
 * Spawn the drone-kill explosion effect at the given world position.
 * @param {import('./entities/entity-manager.js').EntityManager} em
 * @param {object} game
 * @param {number} x
 * @param {number} y
 */
function spawnDroneKillExplosion(em, game, x, y) {
  em.add(new DroneKillExplosion(x, y));
  game.audio.playExplosion(x, false);
}

const CRATER_MERGE_RADIUS = 60;

/**
 * @param {import('./entities/entity-manager.js').EntityManager} em
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 */
function spawnCrater(em, x, y, scale) {
  const craters = em.getGroup('craters');
  for (const existing of craters) {
    const dx = existing.x - x;
    const dy = existing.y - y;
    if (dx * dx + dy * dy < CRATER_MERGE_RADIUS * CRATER_MERGE_RADIUS) {
      existing.elapsed = 0;
      if (scale > existing.scale) {
        existing.scale = scale;
      }
      return;
    }
  }
  em.add(new Crater(x, y, scale));
}

// ------------------------------------------------------------------
// CollisionSystem
// ------------------------------------------------------------------

export class CollisionSystem {
  /**
   * Run all collision checks for one frame.
   *
   * The `game` object is expected to implement:
   *   game.onEnemyDestroyed()
   *   game.shakeScreen(intensity: number)
   *
   * @param {import('./entities/entity-manager.js').EntityManager} entityManager
   * @param {import('./terrain.js').Terrain} terrain
   * @param {object} game
   */
  update(entityManager, terrain, game) {
    const playerProjectiles = entityManager.getGroup('player_missiles');
    const enemies           = entityManager.getGroup('enemy_missiles');
    const launchers         = entityManager.getGroup('launchers');

    // Collect entities that have already resolved a collision this frame.
    // Using a Set of object references avoids any id management overhead.
    /** @type {Set<import('./entities/entity.js').Entity>} */
    const hit = new Set();

    // ── 1. Player projectiles vs enemy projectiles ────────────────────
    for (const proj of playerProjectiles) {
      if (hit.has(proj)) continue;

      for (const enemy of enemies) {
        if (hit.has(enemy)) continue;
        if (!circlesOverlap(proj, enemy)) continue;

        // ── HunterDrone special handling ──────────────────────────────
        // Drone is a loitering munition — it explodes on every impact.
        if (isHunterDrone(proj)) {
          const droneKillsNuke   = isNuke(enemy);
          const droneKillsSuper  = isSuperMissile(enemy);

          if (droneKillsNuke || droneKillsSuper) {
            // Drone is destroyed by these heavy hitters
            hit.add(proj);
            hit.add(enemy);
            proj.destroy();
            spawnDroneKillExplosion(entityManager, game, proj.x, proj.y);

            if (droneKillsNuke) {
              const destroyed = enemy.takeDamage(1, false);
              if (destroyed) {
                enemy.destroy();
                spawnExplosion(entityManager, game, enemy.x, enemy.y, true);
                game.onEnemyDestroyed('nuke');
                game.shakeScreen(20);
              }
            } else {
              // Super missile
              const fragData = enemy.getFragments ? enemy.getFragments() : [];
              enemy.destroy();
              spawnExplosion(entityManager, game, enemy.x, enemy.y, false);
              game.shakeScreen(12);
              for (const fd of fragData) {
                entityManager.add(new MissileFragment(fd.x, fd.y, fd.vx, fd.vy));
              }
            }
          } else {
            // Drone is a loitering munition — it explodes on impact
            hit.add(enemy);
            hit.add(proj);
            enemy.destroy();
            proj.destroy();

            // Spawn drone kill explosion at the impact point
            spawnDroneKillExplosion(entityManager, game, enemy.x, enemy.y);
            game.onEnemyDestroyed();
          }
          break; // done with this enemy iteration for this proj
        }

        const mx = (proj.x + enemy.x) * 0.5;
        const my = (proj.y + enemy.y) * 0.5;

        if (isNuke(enemy)) {
          // Nuke absorbs the hit — it may survive if HP remains.
          const instantKill = isHeatSeekingMissile(proj);
          const destroyed   = enemy.takeDamage(1, instantKill);

          // The intercepting projectile is always consumed.
          hit.add(proj);
          proj.destroy();

          // Small feedback explosion at midpoint
          spawnExplosion(entityManager, game, mx, my, false);

          if (destroyed) {
            hit.add(enemy);
            enemy.destroy();
            // Mega explosion at nuke position
            spawnExplosion(entityManager, game, enemy.x, enemy.y, true);
            game.onEnemyDestroyed('nuke');
            game.shakeScreen(20);
          }
        } else if (isSuperMissile(enemy)) {
          // SuperMissile splits into fragments instead of being destroyed.
          // Collect fragment data first (before destroy clears nothing, but cleaner semantics).
          const fragData = enemy.getFragments();

          hit.add(proj);
          hit.add(enemy);
          proj.destroy();
          enemy.destroy();

          // Standard explosion at midpoint as visual feedback
          spawnExplosion(entityManager, game, mx, my, false);
          game.shakeScreen(12);

          // Spawn fragments — inherit a fraction of the SuperMissile's velocity
          for (const fd of fragData) {
            entityManager.add(new MissileFragment(fd.x, fd.y, fd.vx, fd.vy));
          }

          // No score for the split itself — score comes from killing each fragment
        } else if (isTransportPlane(enemy)) {
          // Transport plane — mega explosion, stop further drops.
          hit.add(proj);
          hit.add(enemy);
          proj.destroy();
          enemy.destroy();

          spawnExplosion(entityManager, game, enemy.x, enemy.y, true);
          game.onEnemyDestroyed('transport_plane');
          game.shakeScreen(15);
        } else if (isParatrooper(enemy)) {
          // Paratrooper intercepted mid-air — 2 points.
          hit.add(proj);
          hit.add(enemy);
          proj.destroy();
          enemy.destroy();

          spawnExplosion(entityManager, game, mx, my, false);
          game.onEnemyDestroyed('paratrooper');
        } else if (isAttackQuad(enemy)) {
          // AttackQuad absorbs hits — reduces HP, destroyed when HP reaches 0.
          hit.add(proj);
          proj.destroy();

          const destroyed = enemy.takeDamage(1);
          spawnExplosion(entityManager, game, mx, my, false);

          if (destroyed) {
            hit.add(enemy);
            enemy.destroy();
            spawnExplosion(entityManager, game, enemy.x, enemy.y, false);
            game.onEnemyDestroyed('attack_quad');
          }
        } else if (isKamikazeQuad(enemy)) {
          // KamikazeQuad has 1 HP — instant kill, small explosion.
          hit.add(proj);
          hit.add(enemy);
          proj.destroy();
          enemy.destroy();

          spawnExplosion(entityManager, game, mx, my, false);
          game.onEnemyDestroyed('kamikaze_quad');
        } else {
          // Standard intercept — both consumed.
          hit.add(proj);
          hit.add(enemy);
          proj.destroy();
          enemy.destroy();

          // Spawn explosion at midpoint — visually cleaner than snapping to
          // either entity's exact center when the circles only just touched.
          spawnExplosion(entityManager, game, mx, my, false);

          game.onEnemyDestroyed();
        }

        break; // proj is consumed; skip remaining enemies for this proj
      }
    }

    // ── 1b. Shield vs enemy projectiles ──────────────────────────────────────
    const shields = entityManager.getGroup('shield');
    if (shields.length > 0) {
      const shield = shields[0];
      for (const enemy of enemies) {
        if (hit.has(enemy)) continue;
        // Transport planes fly at altitude — skip (they are above the dome)
        if (isTransportPlane(enemy)) continue;
        // Paratroopers handle own lifecycle
        if (isParatrooper(enemy)) continue;
        if (!shield.isPointInside(enemy.x, enemy.y)) continue;

        if (isNuke(enemy)) {
          // Nuke punches through — dome takes damage
          shield.onNukePenetration(enemy.x, enemy.y);
          game.audio.playShieldNukeHit();
          // Nuke is NOT consumed — it continues through
          continue;
        }

        // Enemy deflected
        hit.add(enemy);
        enemy.destroy();
        spawnExplosion(entityManager, game, enemy.x, enemy.y, false);
        shield.onDeflect(enemy.x, enemy.y);
        game.audio.playShieldDeflect(enemy.x);
        game.onEnemyDestroyed();
      }
    }

    // ── 2. Enemy projectiles vs terrain ──────────────────────────────
    for (const enemy of enemies) {
      if (hit.has(enemy)) continue;
      // Transport planes fly at high altitude — skip terrain collision
      if (isTransportPlane(enemy)) continue;
      // Paratroopers manage their own landing via state machine in paratrooper.js
      if (isParatrooper(enemy)) continue;
      // AttackQuad and KamikazeQuad hover above terrain — their state machines
      // handle terrain proximity; terrain collision would prematurely destroy them
      if (isAttackQuad(enemy)) continue;
      if (isKamikazeQuad(enemy)) continue;
      if (!collidesWithTerrain(enemy, terrain)) continue;

      hit.add(enemy);
      enemy.destroy();

      const ex = enemy.x;
      // Snap the effect to the actual surface rather than the entity's Y,
      // which may have already passed below the surface by up to one frame.
      const ey = terrain.getHeightAt(ex);

      if (isNuke(enemy)) {
        // Five mega explosions in a spread pattern.
        spawnExplosion(entityManager, game, ex,       ey,      true);
        spawnExplosion(entityManager, game, ex - 80,  ey,      true);
        spawnExplosion(entityManager, game, ex + 80,  ey,      true);
        spawnExplosion(entityManager, game, ex - 40,  ey - 20, true);
        spawnExplosion(entityManager, game, ex + 40,  ey - 20, true);

        // Mushroom cloud rising from impact
        entityManager.add(new MushroomCloud(ex, ey));

        terrain.damage(ex,      ey, 200, 70);
        terrain.damage(ex - 80, ey, 150, 55);
        terrain.damage(ex + 80, ey, 150, 55);

        spawnCrater(entityManager, ex, ey, 10);

        game.shakeScreen(50);
      } else if (isSuperMissile(enemy)) {
        // Triple mega explosion spread across the impact zone.
        spawnExplosion(entityManager, game, ex,      ey, true);
        spawnExplosion(entityManager, game, ex - 60, ey, true);
        spawnExplosion(entityManager, game, ex + 60, ey, true);

        terrain.damage(ex,      ey, 120, 45);
        terrain.damage(ex - 60, ey, 120, 45);
        terrain.damage(ex + 60, ey, 120, 45);

        spawnCrater(entityManager, ex, ey, 5);

        game.shakeScreen(30);
      } else if (isShockMissile(enemy)) {
        // ShockMissile delegates all impact effects to its onImpact callback.
        // game.js wires onImpact to spawn a ShockWave + electric explosion.
        // Minimal terrain damage — the shockwave is the real threat.
        terrain.damage(ex, ey, 30, 12);
        spawnCrater(entityManager, ex, ey, 0.8);

        if (enemy.onImpact) enemy.onImpact(ex, ey);
      } else {
        // Standard enemy missile / drone hits ground.
        spawnExplosion(entityManager, game, ex, ey, false);

        terrain.damage(ex, ey, 60, 22);

        spawnCrater(entityManager, ex, ey, 1.5);

        game.shakeScreen(8);
      }
    }

    // ── 3. Enemy projectiles vs launchers ────────────────────────────
    for (const enemy of enemies) {
      if (hit.has(enemy)) continue;
      // Paratroopers handle their own launcher attack via their state machine
      // (RUNNING → ATTACKING transition). Their collisionRadius (12px) + launcher
      // fallback radius (50px) = 62px which fires well before ATTACK_RANGE (35px),
      // killing both entities before the trooper ever reaches attack state.
      if (isParatrooper(enemy)) continue;

      for (const launcher of launchers) {
        if (hit.has(launcher)) continue;

        // Launchers do not set collisionRadius in their constructor (they rely
        // on click-rect detection for selection). Fall back to a fixed radius
        // that covers the visual footprint defined in the Godot tscn data.
        const launcherRadius = launcher.collisionRadius > 0
          ? launcher.collisionRadius
          : 50;

        const dx = enemy.x - launcher.x;
        const dy = enemy.y - launcher.y;
        const sumR = enemy.collisionRadius + launcherRadius;
        if (dx * dx + dy * dy >= sumR * sumR) continue;

        hit.add(enemy);
        hit.add(launcher);
        enemy.destroy();
        launcher.takeDamage(1.0);

        const ix = launcher.x;
        const iy = launcher.y;
        const craterY = terrain.getHeightAt(launcher.x);

        if (isNuke(enemy)) {
          // Catastrophic area-damage hit — destroys ALL launchers within 300px.
          spawnExplosion(entityManager, game, ix,      iy, true);
          spawnExplosion(entityManager, game, ix - 60, iy, true);
          spawnExplosion(entityManager, game, ix + 60, iy, true);
          spawnExplosion(entityManager, game, ix - 30, iy - 20, true);
          spawnExplosion(entityManager, game, ix + 30, iy - 20, true);

          // Mushroom cloud rising from impact point (same as terrain impact)
          entityManager.add(new MushroomCloud(ix, craterY));

          terrain.damage(ix,      iy, 200, 70);
          terrain.damage(ix - 80, iy, 150, 55);
          terrain.damage(ix + 80, iy, 150, 55);

          spawnCrater(entityManager, ix, craterY, 10);

          // Area damage: destroy all launchers within 300px of the impact point.
          const NUKE_AREA_RADIUS = 300;
          for (const nearby of launchers) {
            if (hit.has(nearby)) continue;
            const ndx = nearby.x - ix;
            const ndy = nearby.y - iy;
            if (ndx * ndx + ndy * ndy <= NUKE_AREA_RADIUS * NUKE_AREA_RADIUS) {
              hit.add(nearby);
              nearby.takeDamage(1.0);
              spawnExplosion(entityManager, game, nearby.x, nearby.y, true);
            }
          }

          game.shakeScreen(50);
        } else if (isSuperMissile(enemy)) {
          // Catastrophic hit — three mega explosions, enormous crater.
          spawnExplosion(entityManager, game, ix,      iy, true);
          spawnExplosion(entityManager, game, ix - 40, iy, true);
          spawnExplosion(entityManager, game, ix + 40, iy, true);

          terrain.damage(ix, iy, 120, 45);

          spawnCrater(entityManager, ix, craterY, 7);

          game.shakeScreen(45);
        } else if (isSuicideDrone(enemy)) {
          // Suicide drone — mega explosion, same crater/shake as a standard hit.
          spawnExplosion(entityManager, game, ix, iy, true);

          terrain.damage(ix, iy, 80, 35);

          spawnCrater(entityManager, ix, craterY, 3);

          game.shakeScreen(28);
        } else if (isKamikazeQuad(enemy)) {
          // KamikazeQuad body-slams the launcher — large explosion, moderate damage.
          // No score awarded — enemy reaching the launcher is an enemy success.
          spawnExplosion(entityManager, game, ix, iy, true);

          terrain.damage(ix, iy, 80, 30);

          spawnCrater(entityManager, ix, craterY, 2.5);

          game.shakeScreen(22);
        } else if (isQuadTracer(enemy)) {
          // QuadTracer is a small projectile — small explosion, minimal terrain damage.
          spawnExplosion(entityManager, game, ix, iy, false);

          terrain.damage(ix, iy, 30, 10);

          spawnCrater(entityManager, ix, craterY, 0.5);

          game.shakeScreen(4);
        } else if (isShockMissile(enemy)) {
          // ShockMissile direct launcher hit — small electric explosion, then shockwave.
          terrain.damage(ix, iy, 30, 12);
          spawnCrater(entityManager, ix, craterY, 0.8);
          game.shakeScreen(6);

          if (enemy.onImpact) enemy.onImpact(ix, craterY);
        } else {
          // Standard enemy missile or drone.
          spawnExplosion(entityManager, game, ix, iy, true);

          terrain.damage(ix, iy, 80, 35);

          spawnCrater(entityManager, ix, craterY, 3);

          game.shakeScreen(25);
        }

        break; // enemy is consumed; skip remaining launchers for this enemy
      }
    }

    // ── 4. Player projectiles vs terrain ─────────────────────────────
    for (const proj of playerProjectiles) {
      if (hit.has(proj)) continue;
      // Hunter drones manage their own lifecycle — never destroyed by terrain
      if (isHunterDrone(proj)) continue;
      if (!collidesWithTerrain(proj, terrain)) continue;

      hit.add(proj);
      proj.destroy();

      const px = proj.x;
      const py = terrain.getHeightAt(px);

      if (isVulkanBullet(proj)) {
        // Vulkan bullets vanish silently — no crater, no explosion.
        // At their fire rate, causing terrain damage would shred the landscape.
      } else {
        // SAM or heat-seeker missing everything and hitting the ground.
        spawnExplosion(entityManager, game, px, py, false);

        terrain.damage(px, py, 35, 15);

        spawnCrater(entityManager, px, py, 1);
      }
    }
  }
}
