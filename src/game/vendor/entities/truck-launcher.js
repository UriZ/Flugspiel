/**
 * Truck Launcher — translated from truck_launcher.tscn + launcher.gd.
 * Mobile launch platform with cab, chassis, wheels, and rocket pod turret.
 * Supports right-click movement along terrain.
 */

import { Launcher, drawPoly } from './launcher.js';
import { rgba } from '../utils.js';

// Movement constants
const MOVE_SPEED = 120;          // px/s max speed
const ACCELERATION = 240;        // px/s^2
const DECELERATION = 360;        // px/s^2
const MIN_X = 80;
const MAX_X = 2480;
const LAUNCHER_CLEARANCE = 60;  // px — min distance from other launchers

// Wheel rotation visual speed (radians per px of travel)
const WHEEL_RAD_PER_PX = 1 / 10;

// Base (non-rotating) polygons
const BASE_POLYS = [
  // Chassis
  { c: rgba(0.28, 0.35, 0.24), pts: [-55, 22, 55, 22, 55, -6, -55, -6] },
  // ChassisRim
  { c: rgba(0.16, 0.2, 0.13), pts: [-55, 22, 55, 22, 55, 24, -55, 24] },
  // ChassisPanel
  { c: rgba(0.24, 0.3, 0.2), pts: [-16, 20, 55, 20, 55, 16, -16, 16] },
  // Cab
  { c: rgba(0.32, 0.4, 0.27), pts: [-55, -6, -16, -6, -16, -32, -48, -32, -55, -24] },
  // CabRoof
  { c: rgba(0.4, 0.48, 0.33), pts: [-48, -32, -16, -32, -16, -36, -44, -36] },
  // CabWindow
  { c: rgba(0.22, 0.36, 0.52, 0.92), pts: [-46, -9, -20, -9, -20, -28, -44, -28] },
  // WindowGlare
  { c: rgba(0.7, 0.82, 0.95, 0.28), pts: [-46, -9, -38, -9, -38, -28, -46, -22] },
  // GrilleFace
  { c: rgba(0.16, 0.18, 0.14), pts: [-55, -8, -49, -8, -49, -22, -55, -22] },
  // GrilleSlat1
  { c: rgba(0.26, 0.28, 0.22), pts: [-55, -10, -49, -10, -49, -11, -55, -11] },
  // GrilleSlat2
  { c: rgba(0.26, 0.28, 0.22), pts: [-55, -14, -49, -14, -49, -15, -55, -15] },
  // GrilleSlat3
  { c: rgba(0.26, 0.28, 0.22), pts: [-55, -18, -49, -18, -49, -19, -55, -19] },
  // Headlight
  { c: rgba(0.88, 0.85, 0.5, 0.95), pts: [-55, -22, -50, -22, -50, -26, -55, -26] },
  // ExhaustPipe
  { c: rgba(0.18, 0.2, 0.16), pts: [-20, -32, -16, -32, -16, -44, -20, -44] },
  // ExhaustCap
  { c: rgba(0.12, 0.14, 0.11), pts: [-22, -42, -14, -42, -14, -44, -22, -44] },
  // WheelA
  { c: rgba(0.1, 0.1, 0.1), pts: [-34, 22, -28, 14, -20, 12, -12, 14, -6, 22, -12, 30, -20, 32, -28, 30] },
  { c: rgba(0.35, 0.35, 0.35), pts: [-28, 22, -25, 17, -20, 15, -15, 17, -12, 22, -15, 27, -20, 29, -25, 27] },
  { c: rgba(0.5, 0.5, 0.5), pts: [-22, 22, -20, 20, -18, 22, -20, 24] },
  // WheelB
  { c: rgba(0.1, 0.1, 0.1), pts: [-6, 22, 0, 14, 8, 12, 16, 14, 22, 22, 16, 30, 8, 32, 0, 30] },
  { c: rgba(0.35, 0.35, 0.35), pts: [0, 22, 3, 17, 8, 15, 13, 17, 16, 22, 13, 27, 8, 29, 3, 27] },
  { c: rgba(0.5, 0.5, 0.5), pts: [6, 22, 8, 20, 10, 22, 8, 24] },
  // WheelC
  { c: rgba(0.1, 0.1, 0.1), pts: [26, 22, 32, 14, 40, 12, 48, 14, 54, 22, 48, 30, 40, 32, 32, 30] },
  { c: rgba(0.35, 0.35, 0.35), pts: [32, 22, 35, 17, 40, 15, 45, 17, 48, 22, 45, 27, 40, 29, 35, 27] },
  { c: rgba(0.5, 0.5, 0.5), pts: [38, 22, 40, 20, 42, 22, 40, 24] },
];

// Turret (rotating) polygons
const TURRET_POLYS = [
  // PodShell
  { c: rgba(0.38, 0.4, 0.35), pts: [-14, -4, 52, -4, 52, -16, -14, -16] },
  // PodSideL
  { c: rgba(0.3, 0.32, 0.27), pts: [-14, -4, -11, -4, -11, -54, -14, -54] },
  // PodSideR
  { c: rgba(0.3, 0.32, 0.27), pts: [49, -4, 52, -4, 52, -54, 49, -54] },
  // PodTop
  { c: rgba(0.34, 0.36, 0.31), pts: [-14, -52, 52, -52, 52, -54, -14, -54] },
  // PodRibA
  { c: rgba(0.28, 0.3, 0.25), pts: [10, -4, 12, -4, 12, -54, 10, -54] },
  // PodRibB
  { c: rgba(0.28, 0.3, 0.25), pts: [33, -4, 35, -4, 35, -54, 33, -54] },
  // Rocket1
  { c: rgba(0.58, 0.18, 0.12), pts: [-4, -16, 4, -16, 4, -52, -4, -52] },
  { c: rgba(0.92, 0.9, 0.86), pts: [-4, -52, 0, -58, 4, -52] },
  { c: rgba(0.9, 0.85, 0.12), pts: [-4, -34, 4, -34, 4, -30, -4, -30] },
  // Rocket2
  { c: rgba(0.58, 0.18, 0.12), pts: [8, -16, 16, -16, 16, -52, 8, -52] },
  { c: rgba(0.92, 0.9, 0.86), pts: [8, -52, 12, -58, 16, -52] },
  { c: rgba(0.9, 0.85, 0.12), pts: [8, -34, 16, -34, 16, -30, 8, -30] },
  // Rocket3
  { c: rgba(0.58, 0.18, 0.12), pts: [20, -16, 28, -16, 28, -52, 20, -52] },
  { c: rgba(0.92, 0.9, 0.86), pts: [20, -52, 24, -58, 28, -52] },
  { c: rgba(0.9, 0.85, 0.12), pts: [20, -34, 28, -34, 28, -30, 20, -30] },
  // Rocket4
  { c: rgba(0.58, 0.18, 0.12), pts: [32, -16, 40, -16, 40, -52, 32, -52] },
  { c: rgba(0.92, 0.9, 0.86), pts: [32, -52, 36, -58, 40, -52] },
  { c: rgba(0.9, 0.85, 0.12), pts: [32, -34, 40, -34, 40, -30, 32, -30] },
];

const GLOW1 = [-60, 20, -48, 32, 48, 32, 60, 20, 48, 40, -48, 40];
const GLOW2 = [-76, 22, -58, 44, 58, 44, 76, 22, 58, 50, -58, 50];

/** @typedef {{ x: number, y: number, r: number, alpha: number, vr: number }} DustParticle */

export class TruckLauncher extends Launcher {
  constructor(x, y) {
    super(x, y, 'truck');
    this.clickHalfW = 57;
    this.clickHalfH = 38;
    this.turretTipOffset = -62;

    // Movement state
    /** @type {-1|0|1} current drive direction set by moveDirection() */
    this._moveDir = 0;
    this.currentSpeed = 0;
    /** true = moving right (cab faces right — flipped) */
    this.facingRight = false;
    this.wheelAngle = 0;

    // Terrain reference — injected by game.js after construction
    /** @type {import('../terrain.js').Terrain|null} */
    this.terrain = null;

    // Other launchers reference for collision avoidance — injected by game.js
    /** @type {import('./launcher.js').Launcher[]} */
    this._otherLaunchers = [];

    // Terrain tilt angle (smoothed)
    this._slopeAngle = 0;

    // Dust particles
    /** @type {DustParticle[]} */
    this._dustParticles = [];

    // Base stats for upgrade system.
    // moveSpeed: max movement speed in px/s.
    // missileSpeed: velocity multiplier for launched rockets.
    // fireCooldown: minimum seconds between shots.
    this._baseStats = {
      moveSpeed:    MOVE_SPEED,
      missileSpeed: 1.0,
      fireCooldown: 0.0,
    };
    this.moveSpeed    = this._baseStats.moveSpeed;
    this.missileSpeed = this._baseStats.missileSpeed;
    this.fireCooldown = this._baseStats.fireCooldown;
  }

  /**
   * Set the drive direction for this frame.
   * Called by game.js based on arrow-key input.
   * @param {-1|0|1} dir  -1 = left, 0 = stop/decelerate, 1 = right
   */
  moveDirection(dir) {
    this._moveDir = dir;
  }

  /** @param {number} dt */
  update(dt) {
    super.update(dt);

    if (this._moveDir !== 0) {
      // Accelerate in the requested direction (use instance moveSpeed so upgrades apply)
      this.facingRight = this._moveDir > 0;
      this.currentSpeed = Math.min(this.moveSpeed, this.currentSpeed + ACCELERATION * dt);

      const move = this.currentSpeed * this._moveDir * dt;
      this.x = Math.max(MIN_X, Math.min(MAX_X, this.x + move));
      this.wheelAngle += move * WHEEL_RAD_PER_PX;

      // Snap Y to terrain surface
      if (this.terrain) {
        this.y = this.terrain.getHeightAt(this.x);
      }

      // Spawn dust behind the rear of the truck
      if (this.currentSpeed > 20 && this._dustParticles.length < 20) {
        const rearX = this.x + (this.facingRight ? 20 : -20);
        const groundY = this.y + 22;
        this._dustParticles.push({
          x: rearX + (Math.random() - 0.5) * 8,
          y: groundY,
          r: 4 + Math.random() * 4,
          alpha: 0.55 + Math.random() * 0.2,
          vr: 6 + Math.random() * 6,
        });
      }
    } else {
      // No input — decelerate to stop
      if (this.currentSpeed > 0) {
        this.currentSpeed = Math.max(0, this.currentSpeed - DECELERATION * dt);
        // Keep rolling the wheels and moving until fully stopped
        const move = this.currentSpeed * (this.facingRight ? 1 : -1) * dt;
        this.x = Math.max(MIN_X, Math.min(MAX_X, this.x + move));
        this.wheelAngle += move * WHEEL_RAD_PER_PX;
        if (this.terrain) {
          this.y = this.terrain.getHeightAt(this.x);
        }
      }
    }

    // Compute terrain slope for tilt (sample 20px ahead and behind)
    if (this.terrain) {
      const yL = this.terrain.getHeightAt(this.x - 20);
      const yR = this.terrain.getHeightAt(this.x + 20);
      const targetSlope = Math.atan2(yR - yL, 40);
      // Smooth the slope to avoid jitter
      this._slopeAngle += (targetSlope - this._slopeAngle) * Math.min(1, 8 * dt);
    }

    // Age dust particles
    for (let i = this._dustParticles.length - 1; i >= 0; i--) {
      const p = this._dustParticles[i];
      p.r += p.vr * dt;
      p.alpha -= 1.1 * dt;
      if (p.alpha <= 0) {
        this._dustParticles.splice(i, 1);
      }
    }
  }

  draw(ctx) {
    // Draw dust particles first (behind the truck)
    for (const p of this._dustParticles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = 'rgba(210,190,140,1)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.translate(this._hitShakeX || 0, this._hitShakeY || 0);

    // Terrain tilt
    ctx.rotate(this._slopeAngle);

    // Flip horizontally when facing right
    if (this.facingRight) {
      ctx.scale(-1, 1);
    }

    // Selection glow — orange per spec
    if (this.isSelected) {
      ctx.shadowColor = '#FF6600';
      ctx.shadowBlur = 18;
      drawPoly(ctx, GLOW2, `rgba(255,136,0,${(this._glowAlpha * 0.25).toFixed(3)})`);
      drawPoly(ctx, GLOW1, `rgba(255,136,0,${(this._glowAlpha * 0.55).toFixed(3)})`);
      ctx.shadowBlur = 0;
    }

    // Chassis gradient
    ctx.save();
    const chassisGrad = ctx.createLinearGradient(0, -6, 0, 22);
    chassisGrad.addColorStop(0, '#47592D');
    chassisGrad.addColorStop(1, '#2A3519');
    ctx.fillStyle = chassisGrad;
    ctx.fillRect(-55, -6, 110, 28);
    // Scratch lines
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const ly = -4 + i * 5;
      ctx.beginPath(); ctx.moveTo(-55, ly); ctx.lineTo(55, ly); ctx.stroke();
    }
    // Rim
    ctx.fillStyle = '#141F0C';
    ctx.fillRect(-55, 22, 110, 2);
    // Chassis panel
    ctx.fillStyle = 'rgba(36,46,32,0.7)';
    ctx.fillRect(-16, 16, 71, 4);
    ctx.restore();

    // Cab with gradient
    ctx.save();
    const cabGrad = ctx.createLinearGradient(-55, -32, -16, -6);
    cabGrad.addColorStop(0, '#526644');
    cabGrad.addColorStop(1, '#303D27');
    ctx.fillStyle = cabGrad;
    ctx.beginPath();
    ctx.moveTo(-55, -6); ctx.lineTo(-16, -6); ctx.lineTo(-16, -32); ctx.lineTo(-48, -32); ctx.lineTo(-55, -24);
    ctx.closePath(); ctx.fill();
    // Cab roof highlight
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(-48, -36, 32, 4);
    // Window (blue-gray)
    ctx.fillStyle = 'rgba(56,92,133,0.92)';
    ctx.beginPath();
    ctx.moveTo(-46,-9); ctx.lineTo(-20,-9); ctx.lineTo(-20,-28); ctx.lineTo(-44,-28);
    ctx.closePath(); ctx.fill();
    // Window glare (alpha 0.42 per spec)
    ctx.fillStyle = 'rgba(179,209,242,0.42)';
    ctx.beginPath();
    ctx.moveTo(-46,-9); ctx.lineTo(-38,-9); ctx.lineTo(-38,-28); ctx.lineTo(-46,-22);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // Grille
    ctx.fillStyle = '#262922';
    ctx.fillRect(-55, -22, 6, 14);
    ctx.strokeStyle = '#434828';
    ctx.lineWidth = 1;
    for (let s = 0; s < 3; s++) {
      const gy = -20 + s * 4;
      ctx.beginPath(); ctx.moveTo(-55, gy); ctx.lineTo(-49, gy); ctx.stroke();
    }

    // Headlights — bright circles with glow
    ctx.save();
    ctx.shadowColor = '#FFFFAA';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#FAEEA0';
    ctx.beginPath(); ctx.arc(-52.5, -24, 3, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Exhaust pipe
    ctx.fillStyle = '#282E22';
    ctx.fillRect(-20, -44, 4, 12);
    ctx.fillStyle = '#1A1E16';
    ctx.fillRect(-22, -44, 8, 2);

    // Wheels — with animated rotation
    const wheelDefs = [{ cx: -20, cy: 22 }, { cx: 8, cy: 22 }, { cx: 40, cy: 22 }];
    for (const wd of wheelDefs) {
      // Outer tire
      ctx.fillStyle = '#1A1A1A';
      ctx.beginPath(); ctx.arc(wd.cx, wd.cy, 10, 0, Math.PI * 2); ctx.fill();
      // Inner hub gradient
      const hubGrad = ctx.createRadialGradient(wd.cx - 2, wd.cy - 2, 1, wd.cx, wd.cy, 7);
      hubGrad.addColorStop(0, '#888888');
      hubGrad.addColorStop(1, '#333333');
      ctx.fillStyle = hubGrad;
      ctx.beginPath(); ctx.arc(wd.cx, wd.cy, 7, 0, Math.PI * 2); ctx.fill();
      // Hub highlight
      ctx.fillStyle = '#8A8A8A';
      ctx.beginPath(); ctx.arc(wd.cx, wd.cy, 2.5, 0, Math.PI * 2); ctx.fill();
      // Dark center dot
      ctx.fillStyle = '#222222';
      ctx.beginPath(); ctx.arc(wd.cx, wd.cy, 1.2, 0, Math.PI * 2); ctx.fill();
      // Animated spoke — single line rotated by wheelAngle
      ctx.save();
      ctx.translate(wd.cx, wd.cy);
      ctx.rotate(this.wheelAngle);
      ctx.strokeStyle = 'rgba(160,160,160,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(0, 6); ctx.stroke();
      ctx.restore();
      // Chrome arch highlight
      ctx.strokeStyle = 'rgba(200,200,200,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(wd.cx - 2, wd.cy - 3, 6, Math.PI * 1.1, Math.PI * 1.8); ctx.stroke();
    }

    // Turret (rotated) — negate rotation when flipped so it still tracks mouse correctly
    ctx.save();
    const effectiveTurretRotation = this.facingRight ? -this.turretRotation : this.turretRotation;
    ctx.rotate(effectiveTurretRotation);

    // Rocket pod with gradient
    const podGrad = ctx.createLinearGradient(-14, -54, 52, -4);
    podGrad.addColorStop(0, '#616659');
    podGrad.addColorStop(1, '#3D4038');
    ctx.fillStyle = podGrad;
    ctx.fillRect(-14, -54, 66, 50);
    // Sides
    ctx.fillStyle = '#2E3028';
    ctx.fillRect(-14, -54, 3, 50);
    ctx.fillRect(49, -54, 3, 50);
    ctx.fillRect(-14, -54, 66, 2);
    // Ribs
    ctx.fillStyle = '#282A24';
    ctx.fillRect(10, -54, 2, 50);
    ctx.fillRect(33, -54, 2, 50);

    // Rockets — 4 with improved colors
    for (let r = 0; r < 4; r++) {
      const rx = -4 + r * 12;
      ctx.fillStyle = '#993322';
      ctx.fillRect(rx, -52, 8, 36);
      ctx.fillStyle = 'rgba(255,160,120,0.2)';
      ctx.fillRect(rx, -52, 2, 36);
      // Tip
      ctx.fillStyle = '#EEEADE';
      ctx.beginPath();
      ctx.moveTo(rx, -52); ctx.lineTo(rx + 4, -58); ctx.lineTo(rx + 8, -52);
      ctx.closePath(); ctx.fill();
      // Band
      ctx.fillStyle = '#E8D810';
      ctx.fillRect(rx, -34, 8, 4);
    }

    ctx.restore(); // turret rotation

    // Damage overlay — truck body bounds (cab top to chassis rim)
    this._drawDamageOverlay(ctx, 57, 24, -44);

    ctx.restore(); // entity position (translate + rotate + optional scale)
  }
}
