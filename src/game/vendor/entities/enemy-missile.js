/**
 * Enemy missile — translated from enemy_missile.gd.
 * Ballistic arc from sky toward terrain/launchers.
 */

import { Entity } from './entity.js';
import { rgba, randf } from '../utils.js';
import { drawPoly } from './launcher.js';

const GRAVITY = 120;
const OFF_SCREEN = { bottom: 1600, left: -100, right: 2660 };

// Polygon data from SCENE_DATA §7
const BODY_GLOW = [-16,26, 16,26, 16,-18, -16,-18];
const BODY = [-12,22, 12,22, 12,-16, -12,-16];
const BODY_PANEL = [-12,8, 12,8, 12,2, -12,2];
const WARHEAD_BAND = [-12,-13, 12,-13, 12,-17, -12,-17];
const NOSECONE = [-12,-16, 0,-38, 12,-16];
const FIN_LEFT = [-12,14, -24,28, -12,22];
const FIN_RIGHT = [12,14, 24,28, 12,22];

// Orange/red flame gradient
const FIRE_COLORS = [
  rgba(1, 0.95, 0.7, 1),
  rgba(1, 0.72, 0.05, 1),
  rgba(1, 0.3, 0, 0.85),
  rgba(0.85, 0.08, 0, 0.4),
  rgba(0.3, 0.02, 0, 0),
];

export class EnemyMissile extends Entity {
  constructor(x, y) {
    super(x, y);
    this.vx = 0;
    this.vy = 0;
    this.collisionRadius = 15;
    this.groups.add('enemy_missiles');

    /** @type {function|null} Called on terrain/launcher impact */
    this.onImpact = null;
  }

  /**
   * Calculate ballistic arc to target.
   * @param {number} targetX
   * @param {number} targetY
   * @param {number} launchTime
   */
  launchTo(targetX, targetY, launchTime = 2.0) {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    this.vx = dx / launchTime;
    this.vy = (dy - 0.5 * GRAVITY * launchTime * launchTime) / launchTime;
  }

  update(dt) {
    this.vy += GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rotation = Math.atan2(this.vy, this.vx) + Math.PI / 2;

    // Off-screen cleanup
    if (this.y > OFF_SCREEN.bottom || this.x < OFF_SCREEN.left || this.x > OFF_SCREEN.right) {
      this.alive = false;
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    // Outer glow
    drawPoly(ctx, BODY_GLOW, rgba(1.0, 0.25, 0.05, 0.22));
    // Body — olive drab #787840 per spec
    drawPoly(ctx, BODY, rgba(0.47, 0.47, 0.25));
    // Panel hatching
    drawPoly(ctx, BODY_PANEL, rgba(0.36, 0.36, 0.19));
    // Panel hatch lines
    ctx.strokeStyle = 'rgba(60,60,30,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const lx = -12 + i * 8;
      ctx.beginPath(); ctx.moveTo(lx, 8); ctx.lineTo(lx + 6, 2); ctx.stroke();
    }
    // Band — #E8C010 5px per spec
    drawPoly(ctx, WARHEAD_BAND, rgba(0.91, 0.75, 0.06));
    // Nosecone — #EE1A0A with outline
    ctx.save();
    drawPoly(ctx, NOSECONE, rgba(0.93, 0.10, 0.04));
    ctx.strokeStyle = 'rgba(200,20,10,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(NOSECONE[0], NOSECONE[1]);
    for (let i = 2; i < NOSECONE.length; i += 2) {
      ctx.lineTo(NOSECONE[i], NOSECONE[i+1]);
    }
    ctx.closePath(); ctx.stroke();
    ctx.restore();
    // Fins
    drawPoly(ctx, FIN_LEFT, rgba(0.32, 0.32, 0.18));
    drawPoly(ctx, FIN_RIGHT, rgba(0.32, 0.32, 0.18));

    // Rocket fire — 3 bezier teardrops per spec
    const flicker = 0.8 + Math.random() * 0.4;
    const fireOffsets = [randf(-3, 3), randf(-2, 2), 0];
    // White-hot core
    ctx.fillStyle = `rgba(255,255,240,${(0.9 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(-3, 22);
    ctx.bezierCurveTo(-2, 26 * flicker, 2, 26 * flicker, 3, 22);
    ctx.bezierCurveTo(1, 24 * flicker, -1, 24 * flicker, 0, 22);
    ctx.fill();
    // Mid orange
    ctx.fillStyle = `rgba(255,140,20,${(0.85 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(-5, 22);
    ctx.bezierCurveTo(-4, 30 * flicker + fireOffsets[0], 4, 30 * flicker + fireOffsets[0], 5, 22);
    ctx.fill();
    // Outer red
    ctx.fillStyle = `rgba(200,30,0,${(0.6 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(-7, 22);
    ctx.bezierCurveTo(-5, 38 * flicker, 5, 38 * flicker, 7, 22);
    ctx.fill();
    // Stray spark particles
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(randf(-5, 5), 22 + randf(5, 20) * flicker, randf(0.5, 1.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,220,80,${(Math.random() * 0.7).toFixed(3)})`;
      ctx.fill();
    }

    ctx.restore();
  }
}
