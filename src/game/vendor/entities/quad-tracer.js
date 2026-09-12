/**
 * QuadTracer — projectile fired by AttackQuad drones.
 * Small fast red-orange round, 600px/s, gravity 60px/s², 2.0s lifetime.
 */

import { Entity } from './entity.js';
import { randf } from '../utils.js';

const GRAVITY   = 60;    // px/s²
const SPEED     = 600;   // px/s
const LIFETIME  = 2.0;   // s
const TRAIL_LEN = 5;

export class QuadTracer extends Entity {
  /**
   * @param {number} x — spawn x
   * @param {number} y — spawn y
   * @param {number} vx — initial velocity x
   * @param {number} vy — initial velocity y
   */
  constructor(x, y, vx, vy) {
    super(x, y);
    this.vx = vx;
    this.vy = vy;
    this.collisionRadius = 5;
    this.groups.add('enemy_missiles');

    this._age = 0;

    /** Trail positions (circular buffer) */
    this._trail = [];
  }

  /**
   * Fire in a direction with optional accuracy spread.
   * @param {number} dirX — normalized direction x
   * @param {number} dirY — normalized direction y
   * @param {number} spread — angle spread in radians
   */
  static create(x, y, dirX, dirY, spread = 0) {
    // Apply spread
    const angle = Math.atan2(dirY, dirX) + (Math.random() - 0.5) * 2 * spread;
    const vx = Math.cos(angle) * SPEED;
    const vy = Math.sin(angle) * SPEED;
    return new QuadTracer(x, y, vx, vy);
  }

  update(dt) {
    this._age += dt;
    if (this._age >= LIFETIME) {
      this.alive = false;
      return;
    }

    // Record trail position before moving
    this._trail.push({ x: this.x, y: this.y });
    if (this._trail.length > TRAIL_LEN) {
      this._trail.shift();
    }

    this.vy += GRAVITY * dt;
    this.x  += this.vx * dt;
    this.y  += this.vy * dt;

    // Off-screen cleanup
    if (this.y > 1700 || this.x < -200 || this.x > 2760) {
      this.alive = false;
    }
  }

  draw(ctx) {
    // Trail — fading orange dots
    for (let i = 0; i < this._trail.length; i++) {
      const t = i / this._trail.length;
      const pt = this._trail[i];
      const alpha = t * 0.55;
      const r = 1.5 + t * 1.5;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,120,30,${alpha.toFixed(3)})`;
      ctx.fill();
    }

    // Main oval projectile (5x10px oriented along velocity)
    const angle = Math.atan2(this.vy, this.vx);

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(angle);

    // Outer red-orange
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#FF5500';
    ctx.fill();

    // White core
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.5, 1.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    ctx.restore();
  }
}
