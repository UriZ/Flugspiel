/**
 * ShockMissile — electric-themed enemy missile.
 * Extends EnemyMissile with blue-white visual and spawns a ShockWave on impact.
 */

import { EnemyMissile } from './enemy-missile.js';
import { randf } from '../utils.js';
import { drawPoly } from './launcher.js';

// Body polygon — same shape as EnemyMissile but rendered in electric blue/white
const BODY_GLOW = [-16, 26, 16, 26, 16, -18, -16, -18];
const BODY      = [-12, 22, 12, 22, 12, -16, -12, -16];
const BODY_PANEL = [-12, 8, 12, 8, 12, 2, -12, 2];
const WARHEAD_BAND = [-12, -13, 12, -13, 12, -17, -12, -17];
const NOSECONE  = [-12, -16, 0, -38, 12, -16];
const FIN_LEFT  = [-12, 14, -24, 28, -12, 22];
const FIN_RIGHT = [12, 14, 24, 28, 12, 22];

// Arc segment endpoints — 4 crackling arcs around the missile body
const ARCS = [
  { ox: -14, oy: -5,  ex: -22, ey: -12 },
  { ox:  14, oy: -5,  ex:  22, ey: -12 },
  { ox: -14, oy:  10, ex: -20, ey:  18 },
  { ox:  14, oy:  10, ex:  20, ey:  18 },
];

export class ShockMissile extends EnemyMissile {
  constructor(x, y) {
    super(x, y);
    // Accumulate animation time for arc jitter
    this._time = 0;
    // Electric spark trail particles — [{x, y, vx, vy, life, maxLife}]
    this._sparks = [];
    this._sparkTimer = 0;
  }

  update(dt) {
    super.update(dt);
    this._time += dt;

    // Spawn spark trail particles
    this._sparkTimer += dt;
    if (this._sparkTimer > 0.03) {
      this._sparkTimer = 0;
      // Emit 2-3 sparks in world space (will be drawn with offset)
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
        // Tail position in world space — spawn behind missile
        const tailX = this.x + Math.sin(this.rotation) * 22;
        const tailY = this.y - Math.cos(this.rotation) * 22;
        this._sparks.push({
          wx: tailX + randf(-8, 8),
          wy: tailY + randf(-8, 8),
          vx: randf(-30, 30),
          vy: randf(-30, 30),
          life: randf(0.10, 0.22),
          maxLife: 0.22,
        });
      }
    }

    // Update existing sparks
    for (let i = this._sparks.length - 1; i >= 0; i--) {
      const s = this._sparks[i];
      s.wx += s.vx * dt;
      s.wy += s.vy * dt;
      s.life -= dt;
      if (s.life <= 0) {
        this._sparks.splice(i, 1);
      }
    }
  }

  draw(ctx) {
    // Draw spark trail first (world space, no missile transform)
    for (const s of this._sparks) {
      const alpha = (s.life / s.maxLife) * 0.9;
      ctx.beginPath();
      ctx.arc(s.wx, s.wy, randf(1, 2.5), 0, Math.PI * 2);
      // Alternate between electric blue and white-hot
      const r = Math.random();
      if (r < 0.5) {
        ctx.fillStyle = `rgba(100,200,255,${alpha.toFixed(3)})`;
      } else {
        ctx.fillStyle = `rgba(220,240,255,${alpha.toFixed(3)})`;
      }
      ctx.fill();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    // ── Outer electric glow ───────────────────────────────────────────────
    // Blue-white radial glow instead of orange
    const glowGrad = ctx.createRadialGradient(0, 0, 8, 0, 0, 28);
    glowGrad.addColorStop(0,   'rgba(80,180,255,0.30)');
    glowGrad.addColorStop(0.5, 'rgba(40,120,220,0.14)');
    glowGrad.addColorStop(1,   'rgba(10,60,180,0)');
    ctx.beginPath();
    ctx.ellipse(0, 4, 28, 28, 0, 0, Math.PI * 2);
    ctx.fillStyle = glowGrad;
    ctx.fill();

    // ── Body — dark metallic blue-grey ────────────────────────────────────
    drawPoly(ctx, BODY_GLOW, 'rgba(20,60,120,0.35)');
    drawPoly(ctx, BODY, '#1A3A6A');
    drawPoly(ctx, BODY_PANEL, '#122A50');

    // Panel charge lines (like circuit traces)
    ctx.strokeStyle = 'rgba(80,180,255,0.50)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const lx = -12 + i * 8;
      ctx.beginPath(); ctx.moveTo(lx, 8); ctx.lineTo(lx + 6, 2); ctx.stroke();
    }

    // ── Warhead band — electric white ────────────────────────────────────
    drawPoly(ctx, WARHEAD_BAND, '#C8E8FF');

    // ── Nosecone — electric blue-white ────────────────────────────────────
    ctx.save();
    drawPoly(ctx, NOSECONE, '#4AB0FF');
    ctx.strokeStyle = 'rgba(180,230,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(NOSECONE[0], NOSECONE[1]);
    for (let i = 2; i < NOSECONE.length; i += 2) {
      ctx.lineTo(NOSECONE[i], NOSECONE[i + 1]);
    }
    ctx.closePath(); ctx.stroke();
    ctx.restore();

    // ── Fins — dark blue-steel ────────────────────────────────────────────
    drawPoly(ctx, FIN_LEFT,  '#1A2E50');
    drawPoly(ctx, FIN_RIGHT, '#1A2E50');

    // ── Electric arcs around missile body ────────────────────────────────
    // Each arc is a jittery multi-segment line
    ctx.lineWidth = 1.5;
    for (const arc of ARCS) {
      // Only draw if this arc is "active" (random per frame for crackle effect)
      if (Math.random() < 0.7) {
        const segments = 3;
        const arcAlpha = 0.6 + Math.random() * 0.4;
        ctx.strokeStyle = `rgba(160,220,255,${arcAlpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.moveTo(arc.ox, arc.oy);
        for (let s = 1; s <= segments; s++) {
          const t = s / segments;
          const midX = arc.ox + (arc.ex - arc.ox) * t + randf(-5, 5);
          const midY = arc.oy + (arc.ey - arc.oy) * t + randf(-5, 5);
          ctx.lineTo(midX, midY);
        }
        ctx.stroke();

        // Bright white core arc
        ctx.strokeStyle = `rgba(220,240,255,${(arcAlpha * 0.7).toFixed(2)})`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(arc.ox, arc.oy);
        const midX = (arc.ox + arc.ex) * 0.5 + randf(-3, 3);
        const midY = (arc.oy + arc.ey) * 0.5 + randf(-3, 3);
        ctx.lineTo(midX, midY);
        ctx.lineTo(arc.ex, arc.ey);
        ctx.stroke();
        ctx.lineWidth = 1.5;
      }
    }

    // ── Electric thruster — blue plasma instead of orange fire ───────────
    const flicker = 0.8 + Math.random() * 0.4;
    // White-blue plasma core
    ctx.fillStyle = `rgba(220,240,255,${(0.9 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(-3, 22);
    ctx.bezierCurveTo(-2, 26 * flicker, 2, 26 * flicker, 3, 22);
    ctx.bezierCurveTo(1, 24 * flicker, -1, 24 * flicker, 0, 22);
    ctx.fill();

    // Blue plasma mid
    ctx.fillStyle = `rgba(80,160,255,${(0.85 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(-5, 22);
    ctx.bezierCurveTo(-4, 30 * flicker, 4, 30 * flicker, 5, 22);
    ctx.fill();

    // Deep blue outer
    ctx.fillStyle = `rgba(20,80,200,${(0.55 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(-7, 22);
    ctx.bezierCurveTo(-5, 38 * flicker, 5, 38 * flicker, 7, 22);
    ctx.fill();

    // Electric sparks from thruster
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(randf(-5, 5), 22 + randf(5, 20) * flicker, randf(0.5, 1.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,220,255,${(Math.random() * 0.8).toFixed(3)})`;
      ctx.fill();
    }

    ctx.restore();
  }
}
