/**
 * Heat-seeking missile — translated from heat_seeking_missile.gd.
 * Tracks a target entity, color shifts when locked.
 */

import { Entity } from './entity.js';
import { rgba, randf, lerp, lerpAngle } from '../utils.js';
import { drawPoly } from './launcher.js';

const GRAVITY = 30;
const TRACKING_SPEED = 5.5;
const OFF_SCREEN = { top: -100, bottom: 1540, left: -100, right: 2660 };
const MAX_LIFETIME = 10.0;

// Body polygon data from SCENE_DATA §6
const BODY_GLOW = [-14,26, 14,26, 14,-18, -14,-18];
const BODY = [-11,22, 11,22, 11,-16, -11,-16];
const BODY_ACCENT = [-11,2, 11,2, 11,-4, -11,-4];
const SEEKER_RING = [-11,-13, 11,-13, 11,-16, -11,-16];
const NOSECONE = [-11,-16, 0,-36, 11,-16];
const FIN_LEFT = [-11,14, -22,26, -11,22];
const FIN_RIGHT = [11,14, 22,26, 11,22];

// Blue-tinted flame gradient
const FIRE_COLORS = [
  rgba(0.85, 0.98, 1, 1),
  rgba(0.3, 0.85, 1, 1),
  rgba(0.05, 0.5, 0.95, 0.8),
  rgba(0.02, 0.2, 0.7, 0.35),
  rgba(0, 0.05, 0.3, 0),
];

export class HeatSeekingMissile extends Entity {
  constructor(x, y) {
    super(x, y);
    this.vx = 0;
    this.vy = 0;
    this.elapsed = 0;
    this.collisionRadius = 15;
    this.groups.add('player_missiles');

    /** @type {Entity|null} */
    this.target = null;
    this.lockStrength = 0; // 0..1

    /** @type {function|null} */
    this.onEnemyDestroyed = null;
    /** @type {function|null} */
    this.onExplode = null;

    /** @type {object|null} SoundLoop handle — caller attaches */
    this.motorSound = null;
  }

  /**
   * @param {number} targetX
   * @param {number} targetY
   * @param {Entity|null} lockedTarget
   */
  launchTo(targetX, targetY, lockedTarget = null) {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const launchTime = 1.2;
    this.vx = dx / launchTime;
    this.vy = (dy - 0.5 * GRAVITY * launchTime * launchTime) / launchTime;

    if (lockedTarget) {
      this.target = lockedTarget;
      this.lockStrength = 0.5;
    }
  }

  update(dt) {
    this.elapsed += dt;

    if (this.target && this.target.alive) {
      // Track target
      const tdx = this.target.x - this.x;
      const tdy = this.target.y - this.y;
      const targetAngle = Math.atan2(tdy, tdx);
      const currentAngle = Math.atan2(this.vy, this.vx);
      const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);

      const newAngle = lerpAngle(currentAngle, targetAngle, TRACKING_SPEED * dt);
      this.vx = Math.cos(newAngle) * speed;
      this.vy = Math.sin(newAngle) * speed;

      // Increase lock
      this.lockStrength = Math.min(this.lockStrength + dt * 2.0, 1.0);
    } else {
      // Lost target — more gravity
      this.vy += GRAVITY * 2.0 * dt;
      this.lockStrength = Math.max(this.lockStrength - dt * 3.0, 0.0);
    }

    // Base gravity always applies
    this.vy += GRAVITY * dt;

    // Integrate
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Rotation follows velocity
    this.rotation = Math.atan2(this.vy, this.vx) + Math.PI / 2;

    // Motor sound pitch follows speed
    if (this.motorSound) {
      const speedRatio = Math.max(0.6, Math.min(1.6,
        Math.sqrt(this.vx * this.vx + this.vy * this.vy) / 400.0));
      if (this.motorSound.setPitch) this.motorSound.setPitch(speedRatio);
    }

    // Lifetime / off-screen
    if (this.elapsed > MAX_LIFETIME ||
        this.y > OFF_SCREEN.bottom || this.y < OFF_SCREEN.top ||
        this.x < OFF_SCREEN.left || this.x > OFF_SCREEN.right) {
      this._cleanup();
      this.alive = false;
    }
  }

  _cleanup() {
    if (this.motorSound && this.motorSound.stop) {
      this.motorSound.stop();
    }
  }

  destroy() {
    this._cleanup();
    super.destroy();
  }

  draw(ctx) {
    const ls = this.lockStrength;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    drawPoly(ctx, BODY_GLOW, rgba(0.1, 0.6, 1.0, 0.2));

    // Dynamic body color: (0.3,0.45,0.72) → (0.5,0.3,0.3) when locked
    const br = lerp(0.3, 0.5, ls);
    const bg = lerp(0.45, 0.3, ls);
    const bb = lerp(0.72, 0.3, ls);
    drawPoly(ctx, BODY, rgba(br, bg, bb));

    drawPoly(ctx, BODY_ACCENT, rgba(0.2, 0.62, 0.88));
    drawPoly(ctx, SEEKER_RING, rgba(0.15, 0.85, 0.95, 0.9));

    // Dynamic nosecone: (0.92,0.9,0.18) → (1.0,0.2,0.1) when locked
    const nr = lerp(0.92, 1.0, ls);
    const ng = lerp(0.9, 0.2, ls);
    const nb = lerp(0.18, 0.1, ls);
    drawPoly(ctx, NOSECONE, rgba(nr, ng, nb));

    drawPoly(ctx, FIN_LEFT, rgba(0.22, 0.36, 0.62));
    drawPoly(ctx, FIN_RIGHT, rgba(0.22, 0.36, 0.62));

    // Blue-tinted rocket fire
    const flicker = 0.8 + Math.random() * 0.4;
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const cy = 22 + i * 6 * flicker;
      const r = (6 - i * 0.8) * flicker;
      const colorIdx = Math.min(Math.floor(t * (FIRE_COLORS.length - 1)), FIRE_COLORS.length - 1);
      ctx.beginPath();
      ctx.arc(randf(-2, 2), cy, r, 0, Math.PI * 2);
      ctx.fillStyle = FIRE_COLORS[colorIdx];
      ctx.fill();
    }

    ctx.restore();
  }
}
