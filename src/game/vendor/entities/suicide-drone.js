/**
 * Suicide drone — translated from suicide_drone.gd.
 * WANDER → LOCK → DIVE state machine targeting launchers.
 */

import { Entity } from './entity.js';
import { rgba, randf, lerpAngle, lerp } from '../utils.js';
import { drawPoly } from './launcher.js';

const WANDER_SPEED = 140;
const DIVE_SPEED = 380;
const OFF_SCREEN = { top: -300, bottom: 1600, left: -300, right: 2860 };

const STATE_WANDER = 0;
const STATE_LOCK = 1;
const STATE_DIVE = 2;

// Polygon data from SCENE_DATA §10
const BODY = [-40,0, -24,-5, -2,-6, 18,-4, 36,-2, 42,0, 36,2, 18,4, -2,6, -24,5];
const COCKPIT = [5,-4, 24,-3, 36,0, 24,3, 5,4, 12,0];
const UPPER_WING = [-5,-6, 14,-6, -6,-28, -24,-9];
const LOWER_WING = [-5,6, 14,6, -6,28, -24,9];
const TAIL_FIN = [-32,0, -48,-13, -44,0, -48,5, -32,1];
const ENGINE_GLOW = [-44,0, -40,-5, -35,0, -40,5];

export class SuicideDrone extends Entity {
  /**
   * @param {number} x — spawn x
   * @param {number} y — spawn y
   */
  constructor(x, y) {
    super(x, y);
    this.collisionRadius = 24;
    this.groups.add('enemy_missiles');
    this.state = STATE_WANDER;

    this.vx = 0;
    this.vy = 0;
    this.wanderAngle = 0;
    this.targetAngle = 0;
    this.wanderTurnTimer = 0;
    this.lockTimer = 0;
    this.lockDelay = randf(3.0, 5.0);
    this.visualRotation = 0;

    /** @type {Entity|null} */
    this.targetLauncher = null;

    /** @type {function|null} Returns launcher entities */
    this.getLaunchers = null;

    // Lock flash animation
    this._flashTimer = -1; // < 0 = not flashing
    this._flashAlpha = 1;
  }

  /**
   * Initialize with direction toward center.
   */
  init() {
    const toCenterX = 1280 - this.x;
    const toCenterY = 500 - this.y;
    this.wanderAngle = Math.atan2(toCenterY, toCenterX);
    this.targetAngle = this.wanderAngle;
    this.vx = Math.cos(this.wanderAngle) * WANDER_SPEED;
    this.vy = Math.sin(this.wanderAngle) * WANDER_SPEED;
  }

  update(dt) {
    // Flash animation
    if (this._flashTimer >= 0) {
      this._flashTimer += dt;
      if (this._flashTimer > 0.44) this._flashTimer = -1;
    }

    switch (this.state) {
      case STATE_WANDER:
        this._processWander(dt);
        break;
      case STATE_LOCK:
        this._findTarget();
        break;
      case STATE_DIVE:
        this._processDive(dt);
        break;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Off-screen cleanup
    if (this.x < OFF_SCREEN.left || this.x > OFF_SCREEN.right ||
        this.y < OFF_SCREEN.top || this.y > OFF_SCREEN.bottom) {
      this.alive = false;
    }
  }

  _processWander(dt) {
    this.lockTimer += dt;

    // Periodically pick new heading
    this.wanderTurnTimer -= dt;
    if (this.wanderTurnTimer <= 0) {
      this.wanderTurnTimer = randf(1.2, 2.5);
      this.targetAngle = randf(-Math.PI * 0.45, Math.PI * 0.45);
    }

    // Nudge away from edges
    if (this.x < 150) {
      this.targetAngle = lerpAngle(this.targetAngle, 0, 0.3);
    } else if (this.x > 2410) {
      this.targetAngle = lerpAngle(this.targetAngle, Math.PI, 0.3);
    }
    if (this.y < 120) {
      this.targetAngle = lerpAngle(this.targetAngle, Math.PI * 0.1, 0.3);
    } else if (this.y > 820) {
      this.targetAngle = lerpAngle(this.targetAngle, -Math.PI * 0.1, 0.3);
    }

    this.wanderAngle = lerpAngle(this.wanderAngle, this.targetAngle, 2.5 * dt);
    this.vx = Math.cos(this.wanderAngle) * WANDER_SPEED;
    this.vy = Math.sin(this.wanderAngle) * WANDER_SPEED;
    this.visualRotation = this.wanderAngle;

    // Transition to lock
    if (this.lockTimer >= this.lockDelay) {
      this.state = STATE_LOCK;
      this._flashTimer = 0; // start flash
    }
  }

  _findTarget() {
    if (!this.getLaunchers) {
      this.alive = false;
      return;
    }

    const launchers = this.getLaunchers();
    let closest = null;
    let closestDist = Infinity;

    for (const launcher of launchers) {
      if (launcher.alive) {
        const dx = this.x - launcher.x;
        const dy = this.y - launcher.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < closestDist) {
          closestDist = d;
          closest = launcher;
        }
      }
    }

    if (closest) {
      this.targetLauncher = closest;
      this.state = STATE_DIVE;
    } else {
      this.alive = false; // No launchers left
    }
  }

  _processDive(dt) {
    if (!this.targetLauncher || !this.targetLauncher.alive) {
      // Re-enter wander with immediate re-lock
      this.state = STATE_WANDER;
      this.lockTimer = this.lockDelay;
      return;
    }

    const dx = this.targetLauncher.x - this.x;
    const dy = this.targetLauncher.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const toTargetX = dx / dist;
    const toTargetY = dy / dist;

    // Lerp velocity toward target
    this.vx = lerp(this.vx, toTargetX * DIVE_SPEED, 6.0 * dt);
    this.vy = lerp(this.vy, toTargetY * DIVE_SPEED, 6.0 * dt);

    this.visualRotation = Math.atan2(this.vy, this.vx);
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.visualRotation);

    // Flash overlay during lock
    if (this._flashTimer >= 0) {
      const ft = this._flashTimer;
      // 4-step tween: bright → white → bright → white
      let flashR = 1, flashG = 1, flashB = 1;
      if (ft < 0.12) {
        flashR = 2.0; flashG = 0.6; flashB = 0.3;
      } else if (ft < 0.24) {
        flashR = 1; flashG = 1; flashB = 1;
      } else if (ft < 0.34) {
        flashR = 2.0; flashG = 0.6; flashB = 0.3;
      }
      // Apply as tint — just draw body brighter
    }

    // Body gradient #AA1A10 to #661008 per spec
    ctx.save();
    const bodyGrad = ctx.createLinearGradient(-40, 0, 42, 0);
    bodyGrad.addColorStop(0, '#AA1A10');
    bodyGrad.addColorStop(1, '#661008');
    if (this.state === STATE_DIVE) {
      const pulse = 0.5 + Math.sin(performance.now() * 0.025) * 0.5;
      const brightness = Math.min(255, Math.round(170 + pulse * 85));
      bodyGrad.addColorStop(0, `rgb(${brightness},26,16)`);
    }
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(BODY[0], BODY[1]);
    for (let i = 2; i < BODY.length; i += 2) ctx.lineTo(BODY[i], BODY[i+1]);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // Cockpit — #FF3311 with glow blur 10 per spec
    ctx.save();
    ctx.shadowColor = '#FF0000';
    ctx.shadowBlur = 10;
    drawPoly(ctx, COCKPIT, rgba(1.0, 0.20, 0.07));
    ctx.shadowBlur = 0;
    ctx.restore();

    drawPoly(ctx, UPPER_WING, rgba(0.50, 0.08, 0.06, 0.95));
    drawPoly(ctx, LOWER_WING, rgba(0.50, 0.08, 0.06, 0.95));
    drawPoly(ctx, TAIL_FIN, rgba(0.45, 0.08, 0.06));

    // Engine glow — different pulse for wander vs dive
    let glowAlpha;
    if (this.state === STATE_DIVE) {
      glowAlpha = 0.5 + Math.sin(performance.now() * 0.025) * 0.5;
      // DIVE: white-hot engine per spec
      ctx.save();
      const engineA = glowAlpha;
      ctx.fillStyle = `rgba(255,255,200,${(engineA * 0.9).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(ENGINE_GLOW[0], ENGINE_GLOW[1]);
      for (let i = 2; i < ENGINE_GLOW.length; i += 2) ctx.lineTo(ENGINE_GLOW[i], ENGINE_GLOW[i+1]);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else {
      glowAlpha = 0.5 + Math.sin(performance.now() * 0.007) * 0.35;
      drawPoly(ctx, ENGINE_GLOW, rgba(1.0, 0.35, 0.0, glowAlpha));
    }

    // LOCK state: screen-edge red vignette hint near drone (local effect)
    if (this.state === STATE_LOCK) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = 'rgba(255,0,0,0.15)';
      ctx.lineWidth = 12;
      ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    ctx.restore();
  }
}
