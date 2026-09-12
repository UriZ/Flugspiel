/**
 * Nuke — heavily armoured ballistic warhead.
 *
 * Takes multiple hits to destroy (MAX_HP = 3). Heat-seeking missiles kill it
 * instantly. On impact with terrain or launchers it triggers a catastrophic
 * multi-explosion spread much larger than a SuperMissile.
 *
 * Visual redesign v3: Military olive hull, red danger bands, yellow hazard
 * stripes, black matte nosecone, smoke puff trail (ballistic — no rocket fire),
 * red targeting reticle and warning chevrons, green radiation trefoil.
 */

import { Entity } from './entity.js';
import { TAU, randf } from '../utils.js';

const GRAVITY = 60;          // Slower, more deliberate descent
const MAX_HP = 3;
const FLASH_DURATION = 0.25; // Seconds the hit-flash overlay stays visible

const OFF_SCREEN = { bottom: 1600, left: -200, right: 2760 };

// ── Color constants ────────────────────────────────────────────────────────
const C_BODY         = '#2B2E1A';   // Military olive hull
const C_NOSECONE     = '#141414';   // Matte black nosecone
const C_FIN          = '#1E2110';   // Near-black fins
const C_DANGER_RED   = '#FF3300';   // Red danger bands
const C_HAZARD_YELLOW = '#FFCC00';  // Yellow hazard stripes / stencil text
const C_TREFOIL      = 'rgba(57,255,20,0.92)';  // Bright green trefoil

// ── Fat Man bezier body drawing helpers ───────────────────────────────────

/**
 * Trace the Fat Man silhouette (6px outset glow version) as a closed path.
 * Nose tip at y=-96, tail bottom at y=+68.
 */
function traceNukeGlow(ctx) {
  ctx.beginPath();
  ctx.moveTo(0, -96);
  ctx.bezierCurveTo(10, -80, 22, -68, 22, -58);
  ctx.bezierCurveTo(36, -38, 56, -18, 56, 0);
  ctx.bezierCurveTo(56, 22, 38, 42, 32, 52);
  ctx.lineTo(32, 68);
  ctx.lineTo(-32, 68);
  ctx.lineTo(-32, 52);
  ctx.bezierCurveTo(-38, 42, -56, 22, -56, 0);
  ctx.bezierCurveTo(-56, -18, -36, -38, -22, -58);
  ctx.bezierCurveTo(-22, -68, -10, -80, 0, -96);
  ctx.closePath();
}

/**
 * Trace the Fat Man body silhouette as a closed path.
 * Nose tip at y=-90, tail bottom at y=+62.
 */
function traceNukeBody(ctx) {
  ctx.beginPath();
  ctx.moveTo(0, -90);                             // nose tip
  ctx.bezierCurveTo(8, -75, 16, -65, 16, -58);   // nose cone right edge
  ctx.bezierCurveTo(28, -40, 50, -20, 50, 0);     // upper belly swell right
  ctx.bezierCurveTo(50, 20, 34, 38, 28, 48);      // lower belly taper right
  ctx.lineTo(28, 62);                              // tail cylinder right
  ctx.lineTo(-28, 62);                             // tail bottom
  ctx.lineTo(-28, 48);                             // tail cylinder left
  ctx.bezierCurveTo(-34, 38, -50, 20, -50, 0);    // lower belly taper left
  ctx.bezierCurveTo(-50, -20, -28, -40, -16, -58); // upper belly swell left
  ctx.bezierCurveTo(-16, -65, -8, -75, 0, -90);   // nose cone left edge
  ctx.closePath();
}

/** Clamp a value between min and max. */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

export class Nuke extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    super(x, y);
    this.vx = 0;
    this.vy = 0;
    this.hp = MAX_HP;
    this.collisionRadius = 28;
    this.groups.add('enemy_missiles');
    this.groups.add('nukes');

    this.elapsed            = 0;   // total alive time — drives glow pulse
    this.flashTimer         = 0;   // counts down from FLASH_DURATION on hit
    this.damageShake        = 0;   // position jitter magnitude, decays each frame
    this.trefoilAngle       = 0;   // rotating radiation trefoil
    this.descentReticleAngle = 0;  // rotating descent targeting rings
    this.trail              = [];  // contrail positions [{x,y}]
  }

  /**
   * Calculate ballistic arc to target.
   * @param {number} targetX
   * @param {number} targetY
   * @param {number} launchTime  default 5.0s — slower arc than standard missiles
   */
  launchTo(targetX, targetY, launchTime = 5.0) {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    this.vx = dx / launchTime;
    this.vy = (dy - 0.5 * GRAVITY * launchTime * launchTime) / launchTime;
  }

  /**
   * Apply damage. Heat-seekers kill instantly.
   * @param {number}  amount      Damage points (default 1)
   * @param {boolean} isHeatSeeker Whether the projectile is a heat-seeker
   * @returns {boolean} true when the nuke is destroyed
   */
  takeDamage(amount = 1, isHeatSeeker = false) {
    if (isHeatSeeker) {
      this.hp = 0;
    } else {
      this.hp -= amount;
    }

    this.flashTimer  = FLASH_DURATION;
    this.damageShake = 10;

    if (this.hp <= 0) {
      this.hp = 0;
      this.destroy();
    }

    return this.hp <= 0;
  }

  update(dt) {
    this.elapsed += dt;

    // Ballistic gravity
    this.vy += GRAVITY * dt;
    this.x  += this.vx * dt;
    this.y  += this.vy * dt;

    // Rotation: nose (local y=-90) should point toward the ground.
    // atan2(vy, vx) for pure downward motion ≈ π/2; adding π/2 gives π,
    // which rotates 180° so the local -Y axis aligns with world +Y (downward).
    // Clamp ±15° around π to keep the nuke roughly nose-down.
    const rawAngle = Math.atan2(this.vy, this.vx) + Math.PI / 2;
    this.rotation = clamp(rawAngle, Math.PI - 0.26, Math.PI + 0.26);

    // Trefoil and reticle rotation
    this.trefoilAngle        += dt * 0.4;
    this.descentReticleAngle += dt * (-0.5);

    // Contrail — record world position, keep last 60 points
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 60) this.trail.shift();

    // Flash and shake decay
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
    }
    if (this.damageShake > 0) {
      this.damageShake = Math.max(0, this.damageShake - 40 * dt);
    }

    // Off-screen cleanup
    if (
      this.y > OFF_SCREEN.bottom ||
      this.x < OFF_SCREEN.left   ||
      this.x > OFF_SCREEN.right
    ) {
      this.alive = false;
    }
  }

  draw(ctx) {
    const hpFrac     = this.hp / MAX_HP;            // 1.0 → undamaged
    const damageFrac = Math.pow(1 - hpFrac, 0.6);   // 0 → full health, 1 → critical
    const pulse      = 0.5 + 0.5 * Math.sin(this.elapsed * 3.0);
    const fastPulse  = 0.5 + 0.5 * Math.sin(this.elapsed * 8.0 * (1 + damageFrac));

    // Jitter from recent hit
    const jx = this.damageShake > 0 ? randf(-this.damageShake, this.damageShake) : 0;
    const jy = this.damageShake > 0 ? randf(-this.damageShake, this.damageShake) : 0;

    ctx.save();
    ctx.translate(this.x + jx, this.y + jy);

    // ── World-space effects (no body rotation) ────────────────────────────

    // Descent targeting reticle — RED, when moving downward fast enough
    if (this.vy > 30) {
      ctx.save();
      ctx.rotate(this.descentReticleAngle);

      // Inner dashed circle r=80
      ctx.beginPath();
      ctx.arc(0, 0, 80, 0, Math.PI * 2);
      ctx.setLineDash([12, 8]);
      ctx.strokeStyle = `rgba(255,51,0,0.35)`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Outer dashed circle r=160
      ctx.beginPath();
      ctx.arc(0, 0, 160, 0, Math.PI * 2);
      ctx.setLineDash([20, 14]);
      ctx.strokeStyle = `rgba(255,51,0,0.20)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.restore();

      // Dashed drop line
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 2000);
      ctx.setLineDash([8, 12]);
      ctx.strokeStyle = `rgba(255,51,0,0.10)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      // Impact ring at ground
      const impactY = 2000;
      ctx.beginPath();
      ctx.arc(0, impactY, 22, 0, TAU);
      ctx.strokeStyle = `rgba(255,51,0,0.30)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Center dot
      ctx.beginPath();
      ctx.arc(0, impactY, 4, 0, TAU);
      ctx.fillStyle = `rgba(255,51,0,0.45)`;
      ctx.fill();
      // Crosshair arms
      ctx.strokeStyle = `rgba(255,51,0,0.30)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-12, impactY); ctx.lineTo(12, impactY);
      ctx.moveTo(0, impactY - 12); ctx.lineTo(0, impactY + 12);
      ctx.stroke();
      // "IMPACT" label
      ctx.save();
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = `rgba(255,51,0,0.35)`;
      ctx.fillText('IMPACT', 0, impactY - 26);
      ctx.restore();
    }

    // Warning chevrons — RED, when high up (y < 480 in world space)
    if (this.y < 480) {
      const chevAlpha = (0.6 * fastPulse).toFixed(4);
      ctx.strokeStyle = `rgba(255,51,0,${chevAlpha})`;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'miter';
      for (let c = 0; c < 2; c++) {
        const cy = 140 + c * 28;
        ctx.beginPath();
        ctx.moveTo(-14, cy - 14);
        ctx.lineTo(0,   cy);
        ctx.lineTo(14,  cy - 14);
        ctx.stroke();
      }
    }

    // ── Smoke puff trail (ballistic — dark expanding puffs, no rocket fire) ─
    if (this.trail.length > 1) {
      for (let i = 1; i < this.trail.length; i++) {
        const t = i / this.trail.length;  // 0 (oldest) → 1 (newest)
        // Oldest puffs are largest and most faded; newest are smallest and darkest
        const age = 1 - t;
        const alpha = (0.04 + 0.08 * t).toFixed(3);
        const r = 4 + age * 18;  // grows as it ages
        const cur = this.trail[i];
        ctx.beginPath();
        ctx.arc(cur.x - this.x, cur.y - this.y, r, 0, TAU);
        ctx.fillStyle = `rgba(40,40,35,${alpha})`;
        ctx.fill();
      }
    }

    // ── Apply body rotation for all remaining draw operations ─────────────
    ctx.rotate(this.rotation);

    // ── Subtle damage aura when critically hit (orange bleed) ─────────────
    if (damageFrac > 0.5) {
      const orangeAlpha = 0.35 * (damageFrac - 0.5) * 2 * pulse;
      const r = 65 + 12 * pulse;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,100,0,${orangeAlpha.toFixed(4)})`;
      ctx.fill();
    }

    // ── Body glow silhouette (subtle, dark) ───────────────────────────────
    traceNukeGlow(ctx);
    ctx.fillStyle = `rgba(20,25,10,0.4)`;
    ctx.fill();

    // ── Main hull (bezier Fat Man shape) — military olive ─────────────────
    traceNukeBody(ctx);
    ctx.fillStyle = C_BODY;
    ctx.fill();

    // ── Body roundness gradient (left-to-right) — clipped to body ──────────
    ctx.save();
    traceNukeBody(ctx);
    ctx.clip();
    const roundGrad = ctx.createLinearGradient(-50, 0, 50, 0);
    roundGrad.addColorStop(0.00, 'rgba(0,0,0,0.7)');
    roundGrad.addColorStop(0.20, 'rgba(0,0,0,0.3)');
    roundGrad.addColorStop(0.40, 'rgba(60,65,40,0.2)');
    roundGrad.addColorStop(0.50, 'rgba(80,85,55,0.1)');
    roundGrad.addColorStop(0.60, 'rgba(60,65,40,0.2)');
    roundGrad.addColorStop(0.80, 'rgba(0,0,0,0.3)');
    roundGrad.addColorStop(1.00, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = roundGrad;
    ctx.fillRect(-55, -95, 110, 160);
    ctx.restore();

    // ── Panel lines — clipped to body ─────────────────────────────────────
    ctx.save();
    traceNukeBody(ctx);
    ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-49, -20); ctx.lineTo(49, -20); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.moveTo(-28, 28); ctx.lineTo(28, 28); ctx.stroke();
    ctx.restore();

    // ── Danger band 1: nose junction (y=-58 to y=-46) — RED + diagonal hazard stripes
    ctx.save();
    traceNukeBody(ctx);
    ctx.clip();
    // Red base
    ctx.fillStyle = C_DANGER_RED;
    ctx.fillRect(-55, -58, 110, 12);
    // Black diagonal hazard stripes
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 4;
    for (let sx = -68; sx <= 70; sx += 12) {
      ctx.beginPath();
      ctx.moveTo(sx,      -58);
      ctx.lineTo(sx + 12, -46);
      ctx.stroke();
    }
    ctx.restore();

    // ── Danger band 2: equator (y=-10 to y=+10) — RED + diagonal hazard stripes
    ctx.save();
    traceNukeBody(ctx);
    ctx.clip();
    // Red base
    ctx.fillStyle = C_DANGER_RED;
    ctx.fillRect(-55, -10, 110, 20);
    // Black diagonal hazard stripes
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 4;
    for (let sx = -68; sx <= 70; sx += 12) {
      ctx.beginPath();
      ctx.moveTo(sx,      -10);
      ctx.lineTo(sx + 20,  10);
      ctx.stroke();
    }
    ctx.restore();

    // ── Stencil text: "NUCLEAR" at y=-34, "WARHEAD" at y=-22 ─────────────
    ctx.save();
    traceNukeBody(ctx);
    ctx.clip();
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = C_HAZARD_YELLOW;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NUCLEAR', 0, -34);
    ctx.fillText('WARHEAD', 0, -22);
    ctx.restore();

    // ── Nosecone section — matte black, no glow ───────────────────────────
    ctx.beginPath();
    ctx.moveTo(0, -90);
    ctx.bezierCurveTo(8, -75, 16, -65, 16, -58);
    ctx.lineTo(-16, -58);
    ctx.bezierCurveTo(-16, -65, -8, -75, 0, -90);
    ctx.closePath();
    ctx.fillStyle = C_NOSECONE;
    ctx.fill();
    // Subtle edge highlight on nosecone
    ctx.strokeStyle = 'rgba(60,60,60,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ── Four fins (drawn after body so they layer on top at tail) ─────────
    ctx.beginPath();
    ctx.moveTo(-28, 52);
    ctx.lineTo(-72, 78);
    ctx.lineTo(-28, 68);
    ctx.closePath();
    ctx.fillStyle = C_FIN;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-28, 52);
    ctx.lineTo(-72, 78);
    ctx.strokeStyle = 'rgba(50,55,35,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(28, 52);
    ctx.lineTo(72, 78);
    ctx.lineTo(28, 68);
    ctx.closePath();
    ctx.fillStyle = C_FIN;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(28, 52);
    ctx.lineTo(72, 78);
    ctx.strokeStyle = 'rgba(50,55,35,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Inner box fins
    ctx.fillStyle = '#1E2110';
    ctx.fillRect(-14, 54, 10, 24);
    ctx.fillRect(  4, 54, 10, 24);

    // Fin depth strips
    ctx.fillStyle = 'rgba(30,33,20,0.7)';
    ctx.beginPath();
    ctx.moveTo(-28, 52);
    ctx.lineTo(-72, 78);
    ctx.lineTo(-68, 78);
    ctx.lineTo(-24, 54);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(28, 52);
    ctx.lineTo(72, 78);
    ctx.lineTo(68, 78);
    ctx.lineTo(24, 54);
    ctx.closePath();
    ctx.fill();

    // ── Radiation trefoil — GREEN, moved to y=+18, radius 22 ──────────────
    ctx.save();
    ctx.translate(0, 18);
    ctx.rotate(this.trefoilAngle);

    // Outer halo
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, TAU);
    ctx.fillStyle = `rgba(57,255,20,${(0.12 * pulse).toFixed(4)})`;
    ctx.fill();

    // Outer ring stroke
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, TAU);
    ctx.strokeStyle = 'rgba(57,255,20,0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Hub filled circle
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, TAU);
    ctx.fillStyle = C_TREFOIL;
    ctx.fill();

    // Three trefoil blades
    for (let s = 0; s < 3; s++) {
      const baseAngle = (s / 3) * TAU - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(0, 0, 20, baseAngle + 0.25, baseAngle + Math.PI / 3 - 0.25);
      ctx.arc(0, 0,  8, baseAngle + Math.PI / 3 - 0.25, baseAngle + 0.25, true);
      ctx.closePath();
      ctx.fillStyle = C_TREFOIL;
      ctx.fill();
    }

    ctx.restore(); // end trefoil

    // ── Damage escalation: orange crack lines at HP=1 ─────────────────────
    if (this.hp === 1) {
      ctx.save();
      traceNukeBody(ctx);
      ctx.clip();
      ctx.strokeStyle = `rgba(255,140,0,${(0.6 + 0.4 * fastPulse).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      // A few jagged crack lines across the hull
      ctx.beginPath();
      ctx.moveTo(-8, -30); ctx.lineTo(5, -10); ctx.lineTo(-3, 10); ctx.lineTo(12, 30);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(10, -20); ctx.lineTo(-4, 0); ctx.lineTo(8, 20);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-15, 5); ctx.lineTo(-5, 25); ctx.lineTo(-18, 40);
      ctx.stroke();
      ctx.restore();
    }

    // ── Hit flash overlay ─────────────────────────────────────────────────
    if (this.flashTimer > 0) {
      const t = this.flashTimer / FLASH_DURATION;
      const flashAlpha = t * 0.8;

      // Clip to body shape for the flash
      ctx.save();
      traceNukeBody(ctx);
      ctx.fillStyle = `rgba(255,200,180,${flashAlpha.toFixed(4)})`;
      ctx.fill();
      ctx.restore();

      // Expanding ring — red
      const ringR = 40 + 80 * (1 - t);
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,51,0,${Math.min(flashAlpha * 1.5, 1).toFixed(4)})`;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    ctx.restore(); // end main save (translate + rotate)
  }
}
