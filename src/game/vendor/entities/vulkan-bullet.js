/**
 * Vulkan bullet — hot tracer round with glowing tail.
 * Fast, straight trajectory, bright orange-white trail that fades.
 * Think T2 minigun tracers ripping through the night.
 */

import { Entity } from './entity.js';
import { TAU, rgba, randf, clamp } from '../utils.js';

const SPEED = 1800;
const LIFETIME = 1.2;
const SPREAD = 0.04; // ±radians (~2.3°)
const OFF_SCREEN = { top: -100, bottom: 1540, left: -100, right: 2660 };
const TRAIL_LENGTH = 8; // Number of trail positions stored

export class VulkanBullet extends Entity {
  constructor(x, y) {
    super(x, y);
    this.vx = 0;
    this.vy = 0;
    this._elapsed = 0;
    this.collisionRadius = 6;
    this.groups.add('player_missiles');

    // Trail history for tracer effect
    this._trail = [];
    this._trailTimer = 0;

    /** @type {function|null} */
    this.onEnemyDestroyed = null;
  }

  /**
   * Fire bullet in a direction with random spread.
   * @param {number} dirX — normalized direction x
   * @param {number} dirY — normalized direction y
   */
  fire(dirX, dirY) {
    const angle = Math.atan2(dirY, dirX) + randf(-SPREAD, SPREAD);
    this.vx = Math.cos(angle) * SPEED;
    this.vy = Math.sin(angle) * SPEED;
    this.rotation = angle + Math.PI / 2;
  }

  update(dt) {
    this._elapsed += dt;

    if (this._elapsed > LIFETIME) {
      this.alive = false;
      return;
    }

    // No gravity — straight line
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Store trail positions
    this._trailTimer += dt;
    if (this._trailTimer > 0.008) {
      this._trailTimer = 0;
      this._trail.push({ x: this.x, y: this.y });
      if (this._trail.length > TRAIL_LENGTH) this._trail.shift();
    }

    // Off-screen
    if (this.y > OFF_SCREEN.bottom || this.y < OFF_SCREEN.top ||
        this.x < OFF_SCREEN.left || this.x > OFF_SCREEN.right) {
      this.alive = false;
    }
  }

  draw(ctx) {
    // Fade after 70% lifetime
    const fadeStart = LIFETIME * 0.7;
    let alpha = 1.0;
    if (this._elapsed > fadeStart) {
      alpha = 1.0 - (this._elapsed - fadeStart) / (LIFETIME * 0.3);
    }

    // === Tracer trail ===
    if (this._trail.length >= 2) {
      for (let i = 0; i < this._trail.length - 1; i++) {
        const t = i / this._trail.length;
        const segAlpha = t * alpha * 0.7;
        if (segAlpha < 0.01) continue;
        const width = 1 + t * 2.5;

        ctx.beginPath();
        ctx.moveTo(this._trail[i].x, this._trail[i].y);
        ctx.lineTo(this._trail[i + 1].x, this._trail[i + 1].y);
        ctx.strokeStyle = `rgba(255, ${(180 + t * 60) | 0}, ${(50 + t * 40) | 0}, ${segAlpha.toFixed(3)})`;
        ctx.lineWidth = width;
        ctx.stroke();
      }

      // Hot connection from last trail point to current position
      const last = this._trail[this._trail.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(this.x, this.y);
      ctx.strokeStyle = `rgba(255, 240, 150, ${(alpha * 0.8).toFixed(3)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // === Bullet head ===
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.globalAlpha = alpha;

    // Outer glow
    ctx.beginPath();
    ctx.ellipse(0, 0, 4, 7, 0, 0, TAU);
    ctx.fillStyle = 'rgba(255, 200, 50, 0.4)';
    ctx.fill();

    // Core — white-hot
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.5, 5, 0, 0, TAU);
    ctx.fillStyle = 'rgba(255, 255, 220, 0.9)';
    ctx.fill();

    // Tip point
    ctx.beginPath();
    ctx.moveTo(-2, -3);
    ctx.lineTo(0, -8);
    ctx.lineTo(2, -3);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 150, 30, 1)';
    ctx.fill();

    ctx.restore();
  }
}
