/**
 * Vulkan Cannon — GE M134 Rotary Cannon (M134 Minigun aesthetic).
 * Heavy industrial mount with 6 rotating barrels inside an octagonal shroud,
 * OD green ammo feed box, brass belt chute, muzzle brake crown,
 * 3-stage heat glow, and procedural muzzle flash / shell casings / smoke.
 *
 * Visual redesign (issue #27): depth-sorted barrel cluster with cylindrical
 * shroud, per-barrel muzzle flash originating from active (frontmost) barrel,
 * and 3-stage spool-up animation (discrete → smear → blur ring).
 */

import { Launcher, drawPoly } from './launcher.js';
import { TAU, rgba, lerp, clamp, randf } from '../utils.js';

// ══════════════════════════════════════════════════════════════════
// Geometry data — M134 heavy pedestal proportions (issue #27 redesign)
// ══════════════════════════════════════════════════════════════════

// Barrel cluster constants (updated per spec)
const NUM_BARRELS = 6;
const BARREL_ORBIT_R = 9;         // px from spin axis to barrel center
const BARREL_HALF_W = 3.5;        // half-width of each barrel tube
const BARREL_LENGTH = 26;         // half-length from cluster center to muzzle
const CLUSTER_CENTER_Y = -40;     // turret-local y of barrel cluster center
const MUZZLE_FACE_Y = -65;        // where the end-on circle view is
const MUZZLE_FACE_R = 12;         // radius of muzzle face disc
const SHROUD_TOP = -60;
const SHROUD_BOTTOM = -22;

// Selection glow polys
const GLOW1 = [-44, 34, 44, 34, 38, 26, -38, 26];
const GLOW2 = [-48, 38, 48, 38, 42, 29, -42, 29];

// Shell casing particle pool
const MAX_SHELLS = 12;

export class VulkanCannon extends Launcher {
  constructor(x, y) {
    super(x, y, 'vulkan');
    this.clickHalfW = 40;
    this.clickHalfH = 45;
    this.turretTipOffset = -62;

    // Overheat system
    this.heat = 0;
    this.heatPerShot = 0.018;
    this.coolRate = 0.32;
    this.overheatCoolRate = 0.18;
    this.overheated = false;
    this.overheatThreshold = 1.0;
    this.overheatRecover = 0.3;

    // Firing
    this.fireRate = 0.07;
    this.fireTimer = 0;
    this.isFiring = false;

    // Barrel spin
    this.barrelSpin = 0;
    this.barrelSpeed = 0;

    // Muzzle flash state
    this._muzzleFlashTimer = 0;
    this._muzzleFlashIntensity = 0;

    // Ejecting shell casings
    this._shells = [];

    // Smoke wisps
    this._smokeParticles = [];

    // Elapsed time
    this._elapsed = 0;

    /** @type {function|null} */
    this.onFireBullet = null;

    // Base stats for upgrade system.
    this._baseStats = {
      fireRate:         this.fireRate,
      heatPerShot:      this.heatPerShot,
      coolRate:         this.coolRate,
      overheatCoolRate: this.overheatCoolRate,
      overheatThreshold:this.overheatThreshold,
      overheatRecover:  this.overheatRecover,
    };
  }

  setSelected(selected) {
    super.setSelected(selected);
    if (!selected) {
      this.stopFiring();
    }
  }

  startFiring() {
    if (!this.overheated) {
      this.isFiring = true;
      this.fireTimer = 0;
    }
  }

  stopFiring() {
    this.isFiring = false;
  }

  update(dt) {
    super.update(dt);
    this._elapsed += dt;

    // Firing logic
    if (this.isSelected && this.isFiring && !this.overheated) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this.fireTimer = this.fireRate;
        this._fireBullet();
        this.heat = Math.min(this.heat + this.heatPerShot, 1.0);
        this._muzzleFlashTimer = 0.04;
        this._muzzleFlashIntensity = 0.8 + Math.random() * 0.2;
        this._ejectShell();
        if (this.heat >= this.overheatThreshold) {
          this.overheated = true;
          this.isFiring = false;
        }
      }
    }

    // Cooling
    if (this.overheated) {
      this.heat = Math.max(this.heat - this.overheatCoolRate * dt, 0);
      if (this.heat <= this.overheatRecover) {
        this.overheated = false;
      }
    } else if (!this.isFiring) {
      this.heat = Math.max(this.heat - this.coolRate * dt, 0);
    }

    // Barrel spin — spins up fast, coasts down slowly
    if (this.isFiring && !this.overheated) {
      this.barrelSpeed = lerp(this.barrelSpeed, 1800, 6.0 * dt);
    } else {
      this.barrelSpeed = lerp(this.barrelSpeed, 0, 2.0 * dt);
    }
    this.barrelSpin += this.barrelSpeed * dt;
    if (this.barrelSpin > 360) this.barrelSpin -= 360;

    // Muzzle flash decay
    this._muzzleFlashTimer = Math.max(0, this._muzzleFlashTimer - dt);

    // Update shell casings
    for (let i = this._shells.length - 1; i >= 0; i--) {
      const s = this._shells[i];
      s.age += dt;
      s.vy += 600 * dt; // gravity
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
      if (s.age > 0.6) this._shells.splice(i, 1);
    }

    // Emit smoke when hot
    if (this.heat > 0.3 && Math.random() < this.heat * 2 * dt) {
      this._smokeParticles.push({
        x: randf(-6, 6),
        y: randf(-50, -55),
        vx: randf(-15, 15),
        vy: randf(-40, -80),
        size: randf(3, 8),
        alpha: randf(0.15, 0.3),
        age: 0,
        lifetime: randf(0.4, 0.8),
      });
    }

    // Update smoke
    for (let i = this._smokeParticles.length - 1; i >= 0; i--) {
      const p = this._smokeParticles[i];
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += dt * 8;
      if (p.age > p.lifetime) this._smokeParticles.splice(i, 1);
    }
  }

  _fireBullet() {
    if (this.onFireBullet) {
      this.onFireBullet(this);
    }
  }

  _ejectShell() {
    if (this._shells.length >= MAX_SHELLS) return;
    // Shell ejects to the right side
    this._shells.push({
      x: this.x + 12,
      y: this.y - 20,
      vx: randf(60, 140),
      vy: randf(-120, -60),
      rot: 0,
      spin: randf(-20, 20),
      age: 0,
    });
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.translate(this._hitShakeX || 0, this._hitShakeY || 0);

    // ── 1. Selection glow ────────────────────────────────────────
    if (this.isSelected) {
      ctx.save();
      ctx.shadowColor = '#5060FF';
      ctx.shadowBlur = 18;
      drawPoly(ctx, GLOW2, `rgba(80,110,255,${(this._glowAlpha * 0.28).toFixed(3)})`);
      drawPoly(ctx, GLOW1, `rgba(80,110,255,${(this._glowAlpha * 0.55).toFixed(3)})`);
      ctx.restore();
    }

    // ── 2. Base pedestal (non-rotating) ─────────────────────────
    // Foot plate
    drawPoly(ctx, [-42, 32, 42, 32, 36, 24, -36, 24], '#1A1C1E');

    // Body column — gradient
    const colGrad = ctx.createLinearGradient(-22, 0, 22, 0);
    colGrad.addColorStop(0, '#3A3C42');
    colGrad.addColorStop(1, '#22242A');
    ctx.beginPath();
    ctx.moveTo(-22, 24); ctx.lineTo(22, 24);
    ctx.lineTo(18, 2);   ctx.lineTo(-18, 2);
    ctx.closePath();
    ctx.fillStyle = colGrad;
    ctx.fill();

    // Trunnion crossbar
    const trGrad = ctx.createLinearGradient(0, -2, 0, 6);
    trGrad.addColorStop(0, '#4A4C54');
    trGrad.addColorStop(0.4, '#5A5C64');
    trGrad.addColorStop(1, '#32343C');
    ctx.beginPath();
    ctx.rect(-32, -2, 64, 8);
    ctx.fillStyle = trGrad;
    ctx.fill();

    // Trunnion arms extending up to gun housing (y = -18)
    ctx.fillStyle = '#2C2E36';
    ctx.fillRect(-30, -18, 8, 16);
    ctx.fillRect(22, -18, 8, 16);

    // Mounting bolts on foot plate (4 bolts)
    for (const boltX of [-30, -18, 18, 30]) {
      ctx.beginPath();
      ctx.arc(boltX, 28, 2.5, 0, TAU);
      ctx.fillStyle = '#5A5C64';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(boltX, 28, 1.2, 0, TAU);
      ctx.fillStyle = '#222428';
      ctx.fill();
    }

    // ── 3. Ammo feed box (non-rotating, left side) ───────────────
    drawPoly(ctx, [-54, 2, -28, 2, -26, -14, -46, -18, -54, -10], '#2E3A1E');
    // Box highlight edge
    drawPoly(ctx, [-54, 2, -28, 2, -28, 0, -54, 0], 'rgba(255,255,255,0.06)');
    // Shadow edge
    drawPoly(ctx, [-46, -18, -54, -10, -54, -8, -47, -16], 'rgba(0,0,0,0.22)');

    // Belt chute — 3 brass hex segments
    for (let seg = 0; seg < 3; seg++) {
      const bcy = -2 + seg * -5;
      const bcx = -28 + seg * 3;
      drawPoly(ctx, [
        bcx - 4, bcy,
        bcx,     bcy - 2,
        bcx + 4, bcy,
        bcx + 4, bcy - 4,
        bcx,     bcy - 6,
        bcx - 4, bcy - 4,
      ], seg % 2 === 0 ? '#C8A030' : '#B89028');
    }

    // ── 4. Gun body (rotates with turret) ────────────────────────
    ctx.save();
    ctx.rotate(this.turretRotation);

    // 4a. Receiver block (y = 0 to y = -8)
    ctx.fillStyle = '#2A2C32';
    ctx.fillRect(-16, -8, 34, 8);
    // Belt feed port (left)
    ctx.fillStyle = '#141618';
    ctx.fillRect(-18, -3, 5, 5);
    // Ejection port (right) — glows with heat
    const ejectR = Math.min(1, this.heat * 2.5);
    ctx.fillStyle = `rgb(${Math.round(20 + ejectR * 60)},${Math.round(20 + ejectR * 10)},20)`;
    ctx.fillRect(13, -4, 6, 5);

    // 4b. Motor housing (y = -8 to y = -20) — wider bulge with cooling fins
    const motorGrad = ctx.createLinearGradient(-14, 0, 14, 0);
    motorGrad.addColorStop(0, '#222428');
    motorGrad.addColorStop(1, '#2E3036');
    ctx.beginPath();
    ctx.moveTo(-14, -8); ctx.lineTo(-16, -12);
    ctx.lineTo(-16, -20); ctx.lineTo(16, -20);
    ctx.lineTo(16, -12); ctx.lineTo(14, -8);
    ctx.closePath();
    ctx.fillStyle = motorGrad;
    ctx.fill();

    // Cooling fins
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (const fy of [-11, -14, -17]) {
      ctx.fillRect(-15, fy - 0.5, 30, 1.5);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (const fy of [-11, -14, -17]) {
      ctx.fillRect(-15, fy - 0.5, 30, 0.7);
    }

    // Motor access panel
    ctx.fillStyle = '#1E2028';
    ctx.fillRect(4, -18, 10, 7);
    for (const sx of [6, 12]) {
      ctx.beginPath();
      ctx.arc(sx, -15, 1.2, 0, TAU);
      ctx.fillStyle = '#3A3C44';
      ctx.fill();
    }

    // 4c. Dark interior cavity — visible background behind spinning barrels
    {
      const cavityGrad = ctx.createRadialGradient(0, CLUSTER_CENTER_Y, 0, 0, CLUSTER_CENTER_Y, 14);
      cavityGrad.addColorStop(0, '#0D0E11');
      cavityGrad.addColorStop(1, '#16181D');
      ctx.beginPath();
      ctx.rect(-13, SHROUD_TOP + 1, 26, SHROUD_BOTTOM - SHROUD_TOP - 1);
      ctx.fillStyle = cavityGrad;
      ctx.fill();
    }

    // ── 4d. Depth-sorted barrel cluster ─────────────────────────
    // Each barrel's angle around the bore axis: barrelSpin (degrees → radians)
    // bx = sin(angle) * BARREL_ORBIT_R (horizontal displacement)
    // depth = -cos(angle): front barrels have depth > 0, back barrels < 0
    // Sort back-to-front (ascending depth) for correct occlusion
    const spinRad = this.barrelSpin * Math.PI / 180;

    // Determine spool-up stage for visual effect:
    // stage 0: slow (speed < 200 deg/s) — discrete barrels visible
    // stage 1: mid (200-900 deg/s) — smeared
    // stage 2: fast (> 900 deg/s) — blur ring
    const speed = this.barrelSpeed;
    const spoolStage = speed > 900 ? 2 : speed > 200 ? 1 : 0;

    // Build barrel descriptors with depth values
    const barrels = [];
    for (let i = 0; i < NUM_BARRELS; i++) {
      const angle = spinRad + (TAU / NUM_BARRELS) * i;
      const bx = Math.sin(angle) * BARREL_ORBIT_R;
      const depth = -Math.cos(angle); // -1=back, +1=front
      // brightness: map depth (-1..1) to (0.28..1.0)
      const brightness = 0.28 + (depth + 1) * 0.5 * 0.72;
      barrels.push({ i, angle, bx, depth, brightness });
    }

    // Sort back to front
    barrels.sort((a, b) => a.depth - b.depth);

    // Find active barrel (frontmost)
    const activeBarrel = barrels[barrels.length - 1];

    if (spoolStage === 2) {
      // ── Stage 2: full-speed — draw as a single blur ring ──────
      // The cluster appears as a solid tube at full speed
      ctx.save();
      ctx.translate(0, CLUSTER_CENTER_Y);

      // Cylindrical shroud body — the blur ring fills in
      const shroudH = BARREL_LENGTH * 2;
      const shroudGrad = ctx.createLinearGradient(-BARREL_ORBIT_R - BARREL_HALF_W, 0, BARREL_ORBIT_R + BARREL_HALF_W, 0);
      shroudGrad.addColorStop(0,    '#3A3C46');
      shroudGrad.addColorStop(0.15, '#8A8E98');
      shroudGrad.addColorStop(0.5,  '#C8CACC');
      shroudGrad.addColorStop(0.85, '#8A8E98');
      shroudGrad.addColorStop(1,    '#2A2C34');
      ctx.fillStyle = shroudGrad;
      ctx.fillRect(-(BARREL_ORBIT_R + BARREL_HALF_W), -BARREL_LENGTH, (BARREL_ORBIT_R + BARREL_HALF_W) * 2, shroudH);

      // Blur ring alpha overlay — spinning smear effect
      const smearAlpha = clamp((speed - 900) / 600, 0, 1) * 0.35;
      ctx.beginPath();
      ctx.arc(0, 0, BARREL_ORBIT_R, 0, TAU);
      ctx.strokeStyle = `rgba(180,185,195,${smearAlpha.toFixed(3)})`;
      ctx.lineWidth = BARREL_HALF_W * 2;
      ctx.stroke();

      // Bore channel (dark center)
      ctx.fillStyle = '#0D0E11';
      ctx.fillRect(-3, -BARREL_LENGTH, 6, BARREL_LENGTH * 2);

      ctx.restore();

    } else if (spoolStage === 1) {
      // ── Stage 1: mid-speed — smeared individual barrels ───────
      ctx.save();
      ctx.translate(0, CLUSTER_CENTER_Y);

      // Draw a smear for each barrel — arc at the orbit radius
      const smearFraction = clamp((speed - 200) / 700, 0, 1);
      const smearArc = smearFraction * (TAU / NUM_BARRELS) * 0.7; // arc angle smear

      for (const b of barrels) {
        const br = Math.round(b.brightness * 180);
        const smearAlpha = 0.55 + b.depth * 0.35;
        ctx.save();
        ctx.translate(b.bx, 0);

        // Smeared barrel tube
        const barrelGrad = ctx.createLinearGradient(-BARREL_HALF_W, 0, BARREL_HALF_W, 0);
        barrelGrad.addColorStop(0,    `rgba(${br + 40},${br + 42},${br + 48},${smearAlpha.toFixed(3)})`);
        barrelGrad.addColorStop(0.4,  `rgba(${br},${br + 2},${br + 8},${smearAlpha.toFixed(3)})`);
        barrelGrad.addColorStop(1,    `rgba(${Math.max(0, br - 40)},${Math.max(0, br - 38)},${Math.max(0, br - 30)},${smearAlpha.toFixed(3)})`);
        ctx.fillStyle = barrelGrad;
        ctx.fillRect(-BARREL_HALF_W, -BARREL_LENGTH, BARREL_HALF_W * 2, BARREL_LENGTH * 2);

        // Motion smear arc blur at orbit
        if (smearArc > 0.01) {
          ctx.save();
          ctx.translate(-b.bx, 0); // back to center for arc
          const arcStartAngle = b.angle - Math.PI / 2 - smearArc;
          ctx.beginPath();
          ctx.arc(0, -BARREL_LENGTH * 0.3, BARREL_ORBIT_R, arcStartAngle, arcStartAngle + smearArc * 2);
          ctx.strokeStyle = `rgba(160,165,175,${(smearAlpha * smearFraction * 0.3).toFixed(3)})`;
          ctx.lineWidth = BARREL_HALF_W * 1.5;
          ctx.stroke();
          ctx.restore();
        }

        ctx.restore();
      }

      // Center hub
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.fillStyle = '#1A1C22';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 2, 0, TAU);
      ctx.fillStyle = '#6070A0';
      ctx.fill();

      ctx.restore();

    } else {
      // ── Stage 0: slow/stopped — discrete depth-sorted barrels ─
      ctx.save();
      ctx.translate(0, CLUSTER_CENTER_Y);

      for (const b of barrels) {
        ctx.save();
        ctx.translate(b.bx, 0);

        // Brightness-scaled cylindrical gradient per barrel
        const br = Math.round(b.brightness * 200);
        const barrelGrad = ctx.createLinearGradient(-BARREL_HALF_W, 0, BARREL_HALF_W, 0);
        barrelGrad.addColorStop(0,    `rgb(${Math.min(255, br + 55)},${Math.min(255, br + 57)},${Math.min(255, br + 63)})`);
        barrelGrad.addColorStop(0.3,  `rgb(${Math.min(255, br + 20)},${Math.min(255, br + 22)},${Math.min(255, br + 28)})`);
        barrelGrad.addColorStop(0.7,  `rgb(${br},${Math.min(255, br + 2)},${Math.min(255, br + 8)})`);
        barrelGrad.addColorStop(1,    `rgb(${Math.max(0, br - 45)},${Math.max(0, br - 43)},${Math.max(0, br - 37)})`);
        ctx.fillStyle = barrelGrad;
        ctx.fillRect(-BARREL_HALF_W, -BARREL_LENGTH, BARREL_HALF_W * 2, BARREL_LENGTH * 2);

        // Bore hole at muzzle end (visible when barrel is at front)
        if (b.depth > 0.2) {
          ctx.beginPath();
          ctx.arc(0, -BARREL_LENGTH, 2.2 * b.depth, 0, TAU);
          ctx.fillStyle = '#050507';
          ctx.fill();
          // Bore rim glint
          ctx.beginPath();
          ctx.arc(-0.6, -BARREL_LENGTH - 0.6, 0.7, 0, TAU);
          ctx.fillStyle = `rgba(255,255,255,${(b.depth * 0.35).toFixed(3)})`;
          ctx.fill();
        }

        ctx.restore();
      }

      // Center hub with rotating spoke markers
      ctx.save();
      ctx.rotate(spinRad);
      // Spokes
      ctx.strokeStyle = '#3A3C48';
      ctx.lineWidth = 1.2;
      for (let s = 0; s < 3; s++) {
        const sa = (TAU / 3) * s;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(sa) * 7, Math.sin(sa) * 7);
        ctx.stroke();
      }
      ctx.restore();

      // Hub rings (non-rotating overlay)
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.fillStyle = '#1A1C22';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, TAU);
      ctx.fillStyle = '#2A2C36';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 2, 0, TAU);
      ctx.fillStyle = '#6070A0';
      ctx.fill();

      ctx.restore();
    }

    // ── 4e. Cylindrical shroud — drawn OVER barrels ─────────────
    // Left wall: gradient creates cylinder illusion (edge darker, center brightest)
    {
      const lwGrad = ctx.createLinearGradient(-16, 0, -12, 0);
      lwGrad.addColorStop(0, '#3A3C46');
      lwGrad.addColorStop(0.4, '#2A2C34');
      lwGrad.addColorStop(1, '#1A1C22');
      ctx.fillStyle = lwGrad;
      ctx.beginPath();
      ctx.moveTo(-13, SHROUD_BOTTOM + 1);
      ctx.lineTo(-16, SHROUD_BOTTOM - 3);
      ctx.lineTo(-16, SHROUD_TOP + 4);
      ctx.lineTo(-13, SHROUD_TOP);
      ctx.lineTo(-12, SHROUD_TOP);
      ctx.lineTo(-12, SHROUD_BOTTOM + 1);
      ctx.closePath();
      ctx.fill();
    }
    // Right wall
    {
      const rwGrad = ctx.createLinearGradient(12, 0, 16, 0);
      rwGrad.addColorStop(0, '#1A1C22');
      rwGrad.addColorStop(0.6, '#2A2C34');
      rwGrad.addColorStop(1, '#3A3C46');
      ctx.fillStyle = rwGrad;
      ctx.beginPath();
      ctx.moveTo(12, SHROUD_BOTTOM + 1);
      ctx.lineTo(12, SHROUD_TOP);
      ctx.lineTo(13, SHROUD_TOP);
      ctx.lineTo(16, SHROUD_TOP + 4);
      ctx.lineTo(16, SHROUD_BOTTOM - 3);
      ctx.lineTo(13, SHROUD_BOTTOM + 1);
      ctx.closePath();
      ctx.fill();
    }
    // Top cap
    ctx.fillStyle = '#2A2C34';
    ctx.fillRect(-13, SHROUD_TOP, 26, 3);
    // Bottom cap
    ctx.fillRect(-13, SHROUD_BOTTOM - 2, 26, 3);

    // ── 4f. Clamp rings ──────────────────────────────────────────
    for (const cy of [-30, -42, -54]) {
      ctx.fillStyle = '#1E2028';
      ctx.fillRect(-17, cy - 2, 34, 4);
      ctx.fillStyle = 'rgba(180,180,200,0.25)';
      ctx.fillRect(-17, cy - 2, 34, 1);
      for (const bx of [-13, -5, 5, 13]) {
        ctx.beginPath();
        ctx.arc(bx, cy, 1.8, 0, TAU);
        ctx.fillStyle = '#3C3E48';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bx, cy, 0.9, 0, TAU);
        ctx.fillStyle = '#14161A';
        ctx.fill();
      }
    }

    // ── 4g. Muzzle crown + end-on muzzle face ────────────────────
    const muzzleColor = this._getMuzzleColor();
    // Outer octagonal crown
    ctx.beginPath();
    ctx.moveTo(-13, SHROUD_TOP);
    ctx.lineTo(-15, SHROUD_TOP - 2);
    ctx.lineTo(-15, SHROUD_TOP - 8);
    ctx.lineTo(-13, SHROUD_TOP - 10);
    ctx.lineTo(13, SHROUD_TOP - 10);
    ctx.lineTo(15, SHROUD_TOP - 8);
    ctx.lineTo(15, SHROUD_TOP - 2);
    ctx.lineTo(13, SHROUD_TOP);
    ctx.closePath();
    ctx.fillStyle = muzzleColor;
    ctx.fill();
    // Crown rim highlight
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(-14, SHROUD_TOP - 2, 28, 1);

    // Dark muzzle face disc — background
    {
      const muzzleFaceGrad = ctx.createRadialGradient(0, MUZZLE_FACE_Y, 0, 0, MUZZLE_FACE_Y, MUZZLE_FACE_R);
      muzzleFaceGrad.addColorStop(0, '#0A0B0E');
      muzzleFaceGrad.addColorStop(1, '#1E2028');
      ctx.beginPath();
      ctx.arc(0, MUZZLE_FACE_Y, MUZZLE_FACE_R, 0, TAU);
      ctx.fillStyle = muzzleFaceGrad;
      ctx.fill();
      // Rim ring
      ctx.beginPath();
      ctx.arc(0, MUZZLE_FACE_Y, MUZZLE_FACE_R, 0, TAU);
      ctx.strokeStyle = '#3A3C48';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Barrel tip circles on muzzle face — spool-stage-aware rendering
    ctx.save();
    ctx.translate(0, MUZZLE_FACE_Y);

    if (spoolStage === 2) {
      // Full-speed: draw a blur ring (arc stroke) instead of individual dots
      ctx.beginPath();
      ctx.arc(0, 0, BARREL_ORBIT_R, 0, TAU);
      ctx.strokeStyle = 'rgba(160,165,175,0.55)';
      ctx.lineWidth = 4;
      ctx.stroke();
      // Dark center bore
      ctx.beginPath();
      ctx.arc(0, 0, 2, 0, TAU);
      ctx.fillStyle = '#050507';
      ctx.fill();
    } else if (spoolStage === 1) {
      // Mid-speed: arc smear behind each barrel tip
      const smearFraction = clamp((speed - 200) / 700, 0, 1);
      ctx.save();
      ctx.rotate(spinRad);
      for (let i = 0; i < NUM_BARRELS; i++) {
        const angle = (TAU / NUM_BARRELS) * i;
        const tx = Math.cos(angle) * BARREL_ORBIT_R;
        const ty = Math.sin(angle) * BARREL_ORBIT_R;
        // Smear arc
        const arcLen = smearFraction * (TAU / NUM_BARRELS) * 0.8;
        ctx.beginPath();
        ctx.arc(0, 0, BARREL_ORBIT_R, angle - arcLen, angle + arcLen * 0.2);
        ctx.strokeStyle = `rgba(140,145,155,${(smearFraction * 0.4).toFixed(3)})`;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        // Barrel dot (fading as smear increases)
        const dotAlpha = 1 - smearFraction * 0.7;
        ctx.beginPath();
        ctx.arc(tx, ty, 3, 0, TAU);
        ctx.fillStyle = `rgba(192,196,204,${dotAlpha.toFixed(3)})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(tx, ty, 1.8, 0, TAU);
        ctx.fillStyle = `rgba(5,5,7,${dotAlpha.toFixed(3)})`;
        ctx.fill();
      }
      ctx.restore();
    } else {
      // Stage 0: discrete barrel tips, depth-sorted for occlusion
      const faceSorted = [...barrels]; // already sorted back-to-front
      ctx.save();
      ctx.rotate(spinRad);
      for (const b of faceSorted) {
        const angle = (TAU / NUM_BARRELS) * b.i;
        const tx = Math.cos(angle) * BARREL_ORBIT_R;
        const ty = Math.sin(angle) * BARREL_ORBIT_R;
        const tipBr = Math.round(b.brightness * 192);

        ctx.save();
        ctx.translate(tx, ty);
        // Tip face with radial gradient (brightness-scaled)
        const tipGrad = ctx.createRadialGradient(-0.8, -0.8, 0, 0, 0, 3);
        tipGrad.addColorStop(0, `rgb(${Math.min(255, tipBr + 40)},${Math.min(255, tipBr + 42)},${Math.min(255, tipBr + 44)})`);
        tipGrad.addColorStop(1, `rgb(${Math.max(20, tipBr - 30)},${Math.max(20, tipBr - 28)},${Math.max(20, tipBr - 24)})`);
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, TAU);
        ctx.fillStyle = tipGrad;
        ctx.fill();
        // Bore hole
        ctx.beginPath();
        ctx.arc(0, 0, 1.8, 0, TAU);
        ctx.fillStyle = '#050507';
        ctx.fill();
        // Bore glint (only on front-facing barrels)
        if (b.depth > 0) {
          ctx.beginPath();
          ctx.arc(-0.6, -0.6, 0.6, 0, TAU);
          ctx.fillStyle = `rgba(255,255,255,${(b.depth * 0.4).toFixed(3)})`;
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // Center hub on muzzle face
    {
      const hubGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 3);
      hubGrad.addColorStop(0, '#4050A0');
      hubGrad.addColorStop(1, '#20253A');
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, TAU);
      ctx.fillStyle = hubGrad;
      ctx.fill();
    }
    ctx.restore(); // muzzle face translate

    // ── 5. Heat glow overlay ──────────────────────────────────────
    if (this.overheated) {
      // Stage 3: pulsing red inferno
      const pulse = 0.5 + Math.sin(this._elapsed * 8) * 0.3;
      ctx.save();
      ctx.shadowColor = '#FF2200';
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(0, CLUSTER_CENTER_Y, 20, 0, TAU);
      ctx.fillStyle = `rgba(255, 34, 0, ${(pulse * 0.22).toFixed(3)})`;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      // Warning shimmer lines
      ctx.save();
      ctx.strokeStyle = `rgba(255,50,0,${(pulse * 0.35).toFixed(3)})`;
      ctx.lineWidth = 1;
      for (let li = 0; li < 3; li++) {
        const lx = randf(-14, 14);
        ctx.beginPath();
        ctx.moveTo(lx, SHROUD_BOTTOM); ctx.lineTo(lx + randf(-4, 4), SHROUD_TOP);
        ctx.stroke();
      }
      ctx.restore();
    } else if (this.heat > 0.9) {
      const t = (this.heat - 0.9) / 0.1;
      const pulse = 0.5 + Math.sin(this._elapsed * 10) * 0.3;
      ctx.save();
      ctx.shadowColor = '#FF2200';
      ctx.shadowBlur = 14 + t * 8;
      ctx.beginPath();
      ctx.arc(0, CLUSTER_CENTER_Y, 16, 0, TAU);
      ctx.fillStyle = `rgba(255, 34, 0, ${(t * pulse * 0.18).toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    } else if (this.heat > 0.7) {
      // Stage 2: orange glow
      const t = (this.heat - 0.7) / 0.2;
      ctx.save();
      ctx.shadowColor = '#FF6600';
      ctx.shadowBlur = 14 + t * 8;
      ctx.beginPath();
      ctx.arc(0, CLUSTER_CENTER_Y, 14, 0, TAU);
      ctx.fillStyle = `rgba(255, 102, 0, ${(t * 0.16).toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    } else if (this.heat > 0.5) {
      // Stage 1: subtle warm shimmer
      const t = (this.heat - 0.5) / 0.2;
      ctx.beginPath();
      ctx.arc(0, CLUSTER_CENTER_Y, 12, 0, TAU);
      ctx.fillStyle = `rgba(255, 176, 64, ${(t * 0.1).toFixed(3)})`;
      ctx.fill();
    }

    // ── 6. Muzzle flash — originates from active (frontmost) barrel ──
    if (this._muzzleFlashTimer > 0) {
      const flashAlpha = (this._muzzleFlashTimer / 0.04) * this._muzzleFlashIntensity;

      // Active barrel x offset at muzzle face (in turret-local space)
      // activeBarrel.bx is relative to cluster center; map to muzzle face coords
      const activeBx = activeBarrel.bx;
      const flashLen = 22 + Math.random() * 14;
      const flashW = 9 + Math.random() * 4;
      // Flash originates from muzzle face position + active barrel offset
      const muzzleY = MUZZLE_FACE_Y - 7;
      const muzzleX = activeBx * 0.6; // compress horizontal offset slightly

      // Main cone
      ctx.beginPath();
      ctx.moveTo(muzzleX - flashW, muzzleY);
      ctx.lineTo(muzzleX, muzzleY - flashLen);
      ctx.lineTo(muzzleX + flashW, muzzleY);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 235, 120, ${(flashAlpha * 0.9).toFixed(3)})`;
      ctx.fill();

      // Inner white core
      ctx.beginPath();
      ctx.moveTo(muzzleX - flashW * 0.4, muzzleY);
      ctx.lineTo(muzzleX, muzzleY - flashLen * 0.7);
      ctx.lineTo(muzzleX + flashW * 0.4, muzzleY);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 255, 255, ${(flashAlpha * 0.7).toFixed(3)})`;
      ctx.fill();

      // Side coronas
      for (const sx of [muzzleX - flashW * 1.4, muzzleX + flashW * 1.4]) {
        ctx.beginPath();
        ctx.arc(sx, muzzleY - flashLen * 0.2, flashW * 0.55, 0, TAU);
        ctx.fillStyle = `rgba(255, 200, 50, ${(flashAlpha * 0.45).toFixed(3)})`;
        ctx.fill();
      }

      // Bloom centered on active barrel
      ctx.beginPath();
      ctx.arc(muzzleX, muzzleY, 28, 0, TAU);
      ctx.fillStyle = `rgba(255, 220, 100, ${(flashAlpha * 0.15).toFixed(3)})`;
      ctx.fill();

      // Sparks
      for (let i = 0; i < 5; i++) {
        const sx = muzzleX + randf(-flashW * 1.5, flashW * 1.5);
        const sy = muzzleY - randf(3, flashLen * 0.5);
        ctx.beginPath();
        ctx.arc(sx, sy, randf(1, 2.5), 0, TAU);
        ctx.fillStyle = `rgba(255, 200, 50, ${(flashAlpha * 0.6).toFixed(3)})`;
        ctx.fill();
      }
    }

    // ── Smoke wisps ───────────────────────────────────────────────
    for (const p of this._smokeParticles) {
      const smokeAlpha = p.alpha * (1 - p.age / p.lifetime);
      if (smokeAlpha < 0.01) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fillStyle = `rgba(80, 80, 90, ${smokeAlpha.toFixed(3)})`;
      ctx.fill();
    }

    ctx.restore(); // turret rotation

    // Damage overlay — pedestal base bounds
    this._drawDamageOverlay(ctx, 44, 32, -18);

    ctx.restore(); // entity position

    // ── Shell casings (world space) ───────────────────────────────
    for (const s of this._shells) {
      const shellAlpha = clamp(1 - s.age / 0.6, 0, 1);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.rect(-1.5, -4, 3, 8);
      ctx.fillStyle = `rgba(214, 178, 54, ${shellAlpha.toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(0,0,0,${(shellAlpha * 0.4).toFixed(3)})`;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(-1.5, -4, 3, 8);
      ctx.beginPath();
      ctx.arc(0, 4, 1.5, 0, TAU);
      ctx.fillStyle = `rgba(180, 140, 40, ${shellAlpha.toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.rect(-0.5, -3, 1, 6);
      ctx.fillStyle = `rgba(255, 220, 100, ${(shellAlpha * 0.4).toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Heat visual color calculations ──

  _getTipColor() {
    if (this.overheated) {
      const pulse = 0.7 + Math.sin(this._elapsed * 12) * 0.3;
      return rgba(0.9, 0.15 * pulse, 0.05);
    }
    // Cool steel → orange-red as heat increases
    const h = this.heat;
    return rgba(
      0.4 + h * 0.5,
      0.4 + h * 0.1 - h * h * 0.35,
      0.45 - h * 0.4
    );
  }

  _getHousingColor() {
    if (this.overheated) {
      const pulse = 0.5 + Math.sin(this._elapsed * 8) * 0.2;
      return rgba(0.5 + pulse * 0.25, 0.12, 0.06);
    }
    if (this.heat > 0.4) {
      const t = (this.heat - 0.4) / 0.6;
      return rgba(0.25 + t * 0.3, 0.25 - t * 0.12, 0.3 - t * 0.22);
    }
    return rgba(0.25, 0.25, 0.3);
  }

  _getMuzzleColor() {
    if (this.overheated) {
      const pulse = 0.5 + Math.sin(this._elapsed * 10) * 0.3;
      return rgba(0.6 + pulse * 0.2, 0.12, 0.06);
    }
    if (this.heat > 0.5) {
      const t = (this.heat - 0.5) / 0.5;
      return rgba(0.22 + t * 0.35, 0.22 - t * 0.1, 0.27 - t * 0.2);
    }
    return rgba(0.22, 0.22, 0.27);
  }
}
