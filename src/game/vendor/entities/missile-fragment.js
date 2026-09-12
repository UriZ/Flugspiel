/**
 * MissileFragment — spawned when a SuperMissile is hit by a player projectile.
 * Tumbles with gravity, has a smoke trail and small flickering flame.
 * Joins 'enemy_missiles' so existing collision logic handles it automatically.
 */

import { Entity } from './entity.js';
import { rgba, randf } from '../utils.js';
import { drawPoly } from './launcher.js';

const GRAVITY = 200;
const OFF_SCREEN = { bottom: 1600, left: -200, right: 2760 };
const TRAIL_MAX = 6;

// Fragment body at 0.5x scale of SuperMissile body polygons
const FRAG_BODY   = [-9, 16,  9, 16,  9, -10, -9, -10];
const FRAG_NOSE   = [-9, -10, 0, -24,  9, -10];
const FRAG_STRIPE = [-9,  6,  9,  6,  9,   3, -9,   3];
const FRAG_FIN_L  = [-9, 12, -15, 19, -9,  16];
const FRAG_FIN_R  = [ 9, 12,  15, 19,  9,  16];

// Flame colors — same palette as SuperMissile
const FIRE_COLORS = [
  rgba(1, 0.95, 0.7,  1),
  rgba(1, 0.72, 0.05, 1),
  rgba(1, 0.3,  0,    0.85),
  rgba(0.85, 0.08, 0, 0.4),
  rgba(0.3,  0.02, 0, 0),
];

export class MissileFragment extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   */
  constructor(x, y, vx, vy) {
    super(x, y);
    this.vx = vx;
    this.vy = vy;
    this.collisionRadius = 10;
    this.groups.add('enemy_missiles');

    // Tumble rate in rad/s — visual spin, not velocity-aligned
    this.tumbleRate = randf(-8, 8);
    this.elapsed = 0;

    /** @type {Array<{x: number, y: number}>} */
    this.trailPoints = [];
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    this.elapsed += dt;

    // Gravity
    this.vy += GRAVITY * dt;

    // Record trail position before moving
    this.trailPoints.push({ x: this.x, y: this.y });
    if (this.trailPoints.length > TRAIL_MAX) {
      this.trailPoints.shift();
    }

    // Move
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Tumble — pure rotation, not velocity-aligned
    this.rotation += this.tumbleRate * dt;

    // Off-screen cleanup
    if (
      this.y > OFF_SCREEN.bottom ||
      this.x < OFF_SCREEN.left ||
      this.x > OFF_SCREEN.right
    ) {
      this.alive = false;
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    ctx.save();

    // ── Smoke trail ──────────────────────────────────────────────────
    if (this.trailPoints.length >= 2) {
      for (let i = 1; i < this.trailPoints.length; i++) {
        const alpha = (i / this.trailPoints.length) * 0.3;
        const p0 = this.trailPoints[i - 1];
        const p1 = this.trailPoints[i];
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.strokeStyle = `rgba(180,160,140,${alpha.toFixed(3)})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    // ── Fragment body ────────────────────────────────────────────────
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    // Red glow tint to signal danger
    drawPoly(ctx, FRAG_BODY,   rgba(0.28, 0.15, 0.15));
    drawPoly(ctx, FRAG_STRIPE, rgba(0.85, 0.65, 0.0));
    drawPoly(ctx, FRAG_FIN_L,  rgba(0.22, 0.10, 0.10));
    drawPoly(ctx, FRAG_FIN_R,  rgba(0.22, 0.10, 0.10));
    // Danger glow overlay
    drawPoly(ctx, FRAG_BODY,   rgba(1.0, 0.15, 0.05, 0.18));
    drawPoly(ctx, FRAG_NOSE,   rgba(0.92, 0.1, 0.05));

    // ── Small flickering flame (3 layers) ───────────────────────────
    const flicker = 0.7 + Math.random() * 0.5;
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      const cy = 16 + i * 5 * flicker;
      const r  = (5 - i) * flicker;
      const colorIdx = Math.min(
        Math.floor(t * (FIRE_COLORS.length - 1)),
        FIRE_COLORS.length - 1
      );
      ctx.beginPath();
      ctx.arc(randf(-2, 2), cy, r, 0, Math.PI * 2);
      ctx.fillStyle = FIRE_COLORS[colorIdx];
      ctx.fill();
    }

    ctx.restore();
  }
}
