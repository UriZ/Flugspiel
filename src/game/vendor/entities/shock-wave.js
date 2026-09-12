/**
 * ShockWave — electric shock wave that propagates along terrain surface.
 * Spawned when a ShockMissile hits the ground.
 *
 * Speed: 400 px/s per side.
 * Max range: 600px per side.
 * Damage: 0.6 at impact point, linear falloff to 0 at max range.
 * Visual: jittery lightning arcs along terrain, leading-edge flash, branch lightning.
 */

import { Entity } from './entity.js';
import { randf } from '../utils.js';

const WAVE_SPEED   = 400;   // px/s, per side
const MAX_RANGE    = 600;   // px, per side
const MAX_DAMAGE   = 0.6;   // at origin
const ARC_INTERVAL = 8;     // px between arc sample points
const BRANCH_CHANCE = 0.15; // probability per sample point of spawning a branch

export class ShockWave extends Entity {
  /**
   * @param {number} x — impact x in world coords
   * @param {number} y — impact y (should be terrain surface)
   * @param {import('../terrain.js').Terrain} terrain
   */
  constructor(x, y, terrain) {
    super(x, y);
    this.groups.add('shock_waves');
    this.collisionRadius = 0; // damage handled internally

    this._terrain = terrain;

    // Wave front distances from origin (one per side)
    this._distLeft  = 0;
    this._distRight = 0;

    // Track which launchers have already been damaged by this wave
    // (so each launcher is only hit once per shockwave)
    /** @type {Set<import('./launcher.js').Launcher>} */
    this._damagedLaunchers = new Set();

    // Crackling particle system for visual flair
    // Each particle: {wx, wy, vx, vy, life, maxLife, isLeading}
    this._particles = [];
    this._particleTimer = 0;

    // Branch lightning segments — [{x1,y1,x2,y2,life,maxLife}]
    this._branches = [];
    this._branchTimer = 0;

    // Reference to launcher group (injected by game.js)
    /** @type {() => import('./launcher.js').Launcher[]} */
    this.getLaunchers = null;
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    const prevLeft  = this._distLeft;
    const prevRight = this._distRight;

    this._distLeft  = Math.min(this._distLeft  + WAVE_SPEED * dt, MAX_RANGE);
    this._distRight = Math.min(this._distRight + WAVE_SPEED * dt, MAX_RANGE);

    // Apply damage to launchers as wave front passes over them
    if (this.getLaunchers) {
      const launchers = this.getLaunchers();
      for (const launcher of launchers) {
        if (!launcher.alive) continue;
        if (this._damagedLaunchers.has(launcher)) continue;

        const dx = launcher.x - this.x;
        const absDx = Math.abs(dx);
        const side = dx < 0 ? 'left' : 'right';

        // Check if wave front just crossed this launcher
        const prevDist = side === 'left' ? prevLeft : prevRight;
        const curDist  = side === 'left' ? this._distLeft : this._distRight;

        if (absDx <= curDist && absDx > prevDist) {
          // Compute damage with linear falloff
          const t = 1 - absDx / MAX_RANGE;
          const damage = MAX_DAMAGE * Math.max(0, t);
          if (damage > 0) {
            launcher.takeDamage(damage);
            this._damagedLaunchers.add(launcher);
          }
        }
      }
    }

    // Emit leading-edge particles
    this._particleTimer += dt;
    if (this._particleTimer > 0.025) {
      this._particleTimer = 0;

      // Left leading edge
      if (this._distLeft < MAX_RANGE) {
        const lx = this.x - this._distLeft;
        const ly = this._terrain ? this._terrain.getHeightAt(lx) : this.y;
        this._spawnLeadingParticles(lx, ly);
      }
      // Right leading edge
      if (this._distRight < MAX_RANGE) {
        const rx = this.x + this._distRight;
        const ry = this._terrain ? this._terrain.getHeightAt(rx) : this.y;
        this._spawnLeadingParticles(rx, ry);
      }
    }

    // Update particles
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.wx += p.vx * dt;
      p.wy += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) this._particles.splice(i, 1);
    }

    // Update branches
    for (let i = this._branches.length - 1; i >= 0; i--) {
      const b = this._branches[i];
      b.life -= dt;
      if (b.life <= 0) this._branches.splice(i, 1);
    }

    // Emit branch lightning periodically
    this._branchTimer += dt;
    if (this._branchTimer > 0.06) {
      this._branchTimer = 0;
      this._spawnBranches();
    }

    // Done when both sides reached max range
    if (this._distLeft >= MAX_RANGE && this._distRight >= MAX_RANGE) {
      this.alive = false;
    }
  }

  /**
   * Draw the shockwave — jittery arc lines along terrain surface.
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    if (!this._terrain) return;

    const leftEdge  = this.x - this._distLeft;
    const rightEdge = this.x + this._distRight;

    // ── Draw main electric arc along terrain ────────────────────────────
    // Sample terrain at ARC_INTERVAL px, draw jittery lightning
    ctx.save();
    ctx.lineWidth = 2;

    // Outer glow pass
    ctx.strokeStyle = 'rgba(40,120,255,0.25)';
    ctx.lineWidth = 6;
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(80,160,255,0.6)';
    this._drawArcLine(ctx, leftEdge, rightEdge, 4);

    // Mid arc
    ctx.strokeStyle = 'rgba(120,200,255,0.65)';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(160,220,255,0.8)';
    this._drawArcLine(ctx, leftEdge, rightEdge, 8);

    // White hot core
    ctx.strokeStyle = 'rgba(220,240,255,0.90)';
    ctx.lineWidth = 1;
    ctx.shadowBlur = 2;
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    this._drawArcLine(ctx, leftEdge, rightEdge, 5);

    ctx.shadowBlur = 0;

    // ── Draw leading edge flashes ────────────────────────────────────────
    const progress = Math.max(this._distLeft, this._distRight) / MAX_RANGE;
    const flashAlpha = 0.85 * (1 - progress * 0.5);

    if (this._distLeft < MAX_RANGE) {
      const lx = this.x - this._distLeft;
      const ly = this._terrain.getHeightAt(lx);
      this._drawLeadingFlash(ctx, lx, ly, flashAlpha);
    }
    if (this._distRight < MAX_RANGE) {
      const rx = this.x + this._distRight;
      const ry = this._terrain.getHeightAt(rx);
      this._drawLeadingFlash(ctx, rx, ry, flashAlpha);
    }

    // ── Draw branch lightning ────────────────────────────────────────────
    ctx.lineWidth = 1;
    for (const b of this._branches) {
      const alpha = (b.life / b.maxLife) * 0.8;
      ctx.strokeStyle = `rgba(180,220,255,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
    }

    // ── Draw crackling particles ─────────────────────────────────────────
    for (const p of this._particles) {
      const alpha = (p.life / p.maxLife) * 0.9;
      ctx.beginPath();
      ctx.arc(p.wx, p.wy, p.isLeading ? randf(1.5, 3) : randf(0.5, 1.5), 0, Math.PI * 2);
      if (p.isLeading) {
        ctx.fillStyle = `rgba(220,240,255,${alpha.toFixed(3)})`;
      } else {
        ctx.fillStyle = `rgba(100,180,255,${alpha.toFixed(3)})`;
      }
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw a jittery arc line between two world-x positions along terrain.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x0
   * @param {number} x1
   * @param {number} jitter — max pixel deviation
   */
  _drawArcLine(ctx, x0, x1, jitter) {
    if (!this._terrain) return;
    ctx.beginPath();
    let first = true;
    for (let wx = Math.min(x0, x1); wx <= Math.max(x0, x1); wx += ARC_INTERVAL) {
      const wy = this._terrain.getHeightAt(wx) + randf(-jitter, jitter) - 2;
      if (first) {
        ctx.moveTo(wx, wy);
        first = false;
      } else {
        ctx.lineTo(wx, wy);
      }
    }
    ctx.stroke();
  }

  /**
   * Spawn leading-edge bright particles.
   */
  _spawnLeadingParticles(wx, wy) {
    for (let i = 0; i < 3; i++) {
      this._particles.push({
        wx: wx + randf(-6, 6),
        wy: wy + randf(-6, 6),
        vx: randf(-60, 60),
        vy: randf(-80, -20),
        life: randf(0.08, 0.20),
        maxLife: 0.20,
        isLeading: true,
      });
    }
    // A few trailing glow particles behind leading edge
    for (let i = 0; i < 2; i++) {
      this._particles.push({
        wx: wx + randf(-20, 20),
        wy: wy + randf(-4, 4),
        vx: randf(-20, 20),
        vy: randf(-30, 10),
        life: randf(0.05, 0.12),
        maxLife: 0.12,
        isLeading: false,
      });
    }
  }

  /**
   * Draw a bright starburst flash at the leading edge.
   */
  _drawLeadingFlash(ctx, wx, wy, alpha) {
    const grad = ctx.createRadialGradient(wx, wy, 0, wx, wy, 18);
    grad.addColorStop(0,   `rgba(255,255,255,${(alpha * 0.9).toFixed(3)})`);
    grad.addColorStop(0.3, `rgba(160,220,255,${(alpha * 0.6).toFixed(3)})`);
    grad.addColorStop(1,   'rgba(40,120,255,0)');
    ctx.beginPath();
    ctx.arc(wx, wy, 18, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  /**
   * Spawn upward branch lightning segments from the arc.
   */
  _spawnBranches() {
    if (!this._terrain) return;
    // Try a few random points along the current arc span
    const leftEdge  = this.x - this._distLeft;
    const rightEdge = this.x + this._distRight;
    const span = rightEdge - leftEdge;
    if (span < ARC_INTERVAL) return;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (Math.random() > BRANCH_CHANCE * 4) continue;
      const bx = leftEdge + Math.random() * span;
      const by = this._terrain.getHeightAt(bx) - 2;
      // Branch upward with jitter
      const length = randf(15, 50);
      const angle = -Math.PI / 2 + randf(-0.6, 0.6);
      const bx2 = bx + Math.cos(angle) * length;
      const by2 = by + Math.sin(angle) * length;
      const maxLife = randf(0.05, 0.15);
      this._branches.push({ x1: bx, y1: by, x2: bx2, y2: by2, life: maxLife, maxLife });

      // Sub-branch
      if (Math.random() < 0.5) {
        const subLen = length * randf(0.3, 0.6);
        const subAngle = angle + randf(-0.5, 0.5);
        this._branches.push({
          x1: bx2,
          y1: by2,
          x2: bx2 + Math.cos(subAngle) * subLen,
          y2: by2 + Math.sin(subAngle) * subLen,
          life: maxLife * 0.7,
          maxLife: maxLife * 0.7,
        });
      }
    }
  }
}
