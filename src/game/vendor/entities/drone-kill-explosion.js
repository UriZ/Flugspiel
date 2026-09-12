/**
 * DroneKillExplosion — compact 4-phase explosion spawned when a HunterDrone
 * destroys an enemy target.
 *
 * 4 phases over ~0.8s:
 *   1. Detonation flash  (0–0.08s): white expanding circle 0→60px
 *   2. Fireball          (0–0.45s): orange/red radial gradient 0→80px, easeOutCubic
 *   3. Pressure ring     (0.05–0.4s): expanding stroke-only circle 20→180px, fading amber
 *   4. Debris scatter    (0–0.6s): 8-12 small rectangles flying outward with deceleration
 *
 * Plus smoke puffs (0.1–0.8s): 3-5 expanding circles drifting upward.
 */

import { Entity } from './entity.js';
import { TAU, randf, randi } from '../utils.js';

function easeOutCubic(t) {
  return 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);
}

const TOTAL_LIFETIME = 0.8;

export class DroneKillExplosion extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    super(x, y);
    this.elapsed = 0;

    // Flash
    this._flashRadius = 0;
    this._flashAlpha  = 1;

    // Fireball
    this._fireballRadius = 0;
    this._fireballAlpha  = 1;

    // Pressure ring
    this._ringRadius = 20;
    this._ringAlpha  = 1;

    // Debris chunks: 8-12 small rectangles
    const count = randi(8, 12);
    this._debris = [];
    for (let i = 0; i < count; i++) {
      const angle = randf(0, TAU);
      const speed = randf(80, 220);
      this._debris.push({
        px: 0,
        py: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed + randf(-80, -10),
        rot: randf(0, TAU),
        spin: randf(-8, 8),
        w: randf(3, 8),
        h: randf(2, 5),
        alive: true,
      });
    }

    // Smoke puffs: 3-5 circles drifting upward
    const smokeCount = randi(3, 5);
    this._smoke = [];
    for (let i = 0; i < smokeCount; i++) {
      this._smoke.push({
        x: randf(-12, 12),
        y: randf(-8, 8),
        vx: randf(-10, 10),
        vy: randf(-30, -15),
        radius: randf(6, 14),
        alpha: randf(0.15, 0.30),
        delay: randf(0.1, 0.3),
      });
    }
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= TOTAL_LIFETIME) {
      this.destroy();
      return;
    }

    const t = this.elapsed;

    // Phase 1: Flash (0–0.08s) — expand then vanish
    if (t < 0.08) {
      this._flashRadius = 60 * (t / 0.08);
      this._flashAlpha  = 1 - (t / 0.08);
    } else {
      this._flashRadius = 0;
      this._flashAlpha  = 0;
    }

    // Phase 2: Fireball (0–0.45s)
    if (t < 0.45) {
      const fbT = t / 0.45;
      this._fireballRadius = 80 * easeOutCubic(fbT);
      this._fireballAlpha  = 1 - fbT * fbT;
    } else {
      this._fireballRadius = 0;
      this._fireballAlpha  = 0;
    }

    // Phase 3: Pressure ring (0.05–0.4s) — 20→180px
    if (t >= 0.05 && t < 0.4) {
      const ringT = (t - 0.05) / (0.4 - 0.05);
      this._ringRadius = 20 + 160 * ringT;
      this._ringAlpha  = (1 - ringT) * 0.7;
    } else {
      this._ringAlpha = 0;
    }

    // Phase 4: Debris (0–0.6s)
    const gravityY = 280;
    for (const d of this._debris) {
      if (!d.alive) continue;
      if (t > 0.6) { d.alive = false; continue; }
      d.vy += gravityY * dt;
      d.vx *= (1 - 0.5 * dt);
      d.vy *= (1 - 0.3 * dt);
      d.px += d.vx * dt;
      d.py += d.vy * dt;
      d.rot += d.spin * dt;
    }

    // Smoke puffs (0.1–0.8s)
    for (const s of this._smoke) {
      if (t < s.delay) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.radius += 8 * dt;
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    const t = this.elapsed;

    // Phase 1: Detonation flash
    if (this._flashAlpha > 0.01 && this._flashRadius > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, this._flashRadius, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${(this._flashAlpha * 0.85).toFixed(3)})`;
      ctx.fill();
    }

    // Phase 2: Fireball — radial gradient orange/red
    if (this._fireballAlpha > 0.01 && this._fireballRadius > 1) {
      const r = this._fireballRadius;
      // Outer orange haze
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.2, 0, TAU);
      ctx.fillStyle = `rgba(255,60,0,${(this._fireballAlpha * 0.35).toFixed(3)})`;
      ctx.fill();
      // Mid orange
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = `rgba(255,130,20,${(this._fireballAlpha * 0.55).toFixed(3)})`;
      ctx.fill();
      // Inner yellow
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.5, 0, TAU);
      ctx.fillStyle = `rgba(255,210,80,${(this._fireballAlpha * 0.8).toFixed(3)})`;
      ctx.fill();
      // White core
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.2, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${(this._fireballAlpha * 0.9).toFixed(3)})`;
      ctx.fill();
    }

    // Phase 3: Pressure ring — stroke only, amber, expanding
    if (this._ringAlpha > 0.01) {
      ctx.beginPath();
      ctx.arc(0, 0, this._ringRadius, 0, TAU);
      ctx.strokeStyle = `rgba(255,180,40,${this._ringAlpha.toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Phase 4: Debris scatter — small rotating rectangles
    for (const d of this._debris) {
      if (!d.alive) continue;
      const debrisFade = Math.max(0, 1 - t / 0.6);
      if (debrisFade < 0.01) continue;

      ctx.save();
      ctx.translate(d.px, d.py);
      ctx.rotate(d.rot);

      const hw = d.w * 0.5;
      const hh = d.h * 0.5;
      ctx.fillStyle = `rgba(140,100,50,${(debrisFade * 0.9).toFixed(3)})`;
      ctx.fillRect(-hw, -hh, d.w, d.h);

      // Burning highlight on some chunks
      if (t < 0.3) {
        ctx.fillStyle = `rgba(255,120,20,${(debrisFade * 0.5).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(0, 0, d.h * 0.4, 0, TAU);
        ctx.fill();
      }

      ctx.restore();
    }

    // Smoke puffs
    for (const s of this._smoke) {
      if (t < s.delay) continue;
      const smokeAge = t - s.delay;
      const smokeLife = TOTAL_LIFETIME - s.delay;
      const smokeFade = Math.max(0, 1 - smokeAge / smokeLife);
      const alpha = s.alpha * smokeFade;
      if (alpha < 0.01) continue;

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, TAU);
      ctx.fillStyle = `rgba(55,48,44,${alpha.toFixed(3)})`;
      ctx.fill();

      // Lighter inner smoke circle
      ctx.beginPath();
      ctx.arc(s.x + s.radius * 0.2, s.y - s.radius * 0.15, s.radius * 0.65, 0, TAU);
      ctx.fillStyle = `rgba(80,72,65,${(alpha * 0.7).toFixed(3)})`;
      ctx.fill();
    }

    ctx.restore();
  }
}
