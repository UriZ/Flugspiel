/**
 * SAM Launcher — translated from sam_launcher.tscn + launcher.gd.
 * Fixed emplacement with 4 missiles on a rotating arm.
 */

import { Launcher, drawPoly } from './launcher.js';
import { rgba } from '../utils.js';

// Base (non-rotating) polygons — drawn at entity position
const BASE_POLYS = [
  // BaseSlab
  { c: rgba(0.24, 0.26, 0.22), pts: [-54, 28, 54, 28, 48, 14, -48, 14] },
  // BaseSlabRim
  { c: rgba(0.14, 0.16, 0.12), pts: [-54, 30, 54, 30, 54, 28, -54, 28] },
  // BaseUpper
  { c: rgba(0.3, 0.32, 0.27), pts: [-48, 14, 48, 14, 40, 4, -40, 4] },
  // BaseUpperEdge
  { c: rgba(0.38, 0.4, 0.34), pts: [-48, 15, 48, 15, 48, 14, -48, 14] },
  // WarningBandL
  { c: rgba(0.78, 0.62, 0.08, 0.85), pts: [-54, 20, -50, 20, -38, 28, -42, 28] },
  // WarningBandR
  { c: rgba(0.78, 0.62, 0.08, 0.85), pts: [50, 20, 54, 20, 42, 28, 38, 28] },
  // PivotOuter
  { c: rgba(0.18, 0.2, 0.17), pts: [-32, 4, 32, 4, 32, -10, -32, -10] },
  // PivotEdgeTop
  { c: rgba(0.12, 0.14, 0.11), pts: [-32, -9, 32, -9, 32, -10, -32, -10] },
  // PivotEdgeBot
  { c: rgba(0.28, 0.3, 0.25), pts: [-32, 4, 32, 4, 32, 5, -32, 5] },
];

// Turret (rotating) polygons — drawn relative to turret origin
const TURRET_POLYS = [
  // ArmShoulder
  { c: rgba(0.22, 0.24, 0.2), pts: [-26, -8, 26, -8, 26, -22, -26, -22] },
  // ArmBody
  { c: rgba(0.17, 0.19, 0.16), pts: [-24, -22, 24, -22, 24, -56, -24, -56] },
  // ArmRibL
  { c: rgba(0.27, 0.3, 0.24), pts: [-24, -22, -19, -22, -19, -56, -24, -56] },
  // ArmRibR
  { c: rgba(0.27, 0.3, 0.24), pts: [19, -22, 24, -22, 24, -56, 19, -56] },
  // ArmBrace1
  { c: rgba(0.24, 0.26, 0.21), pts: [-24, -30, 24, -30, 24, -33, -24, -33] },
  // ArmBrace2
  { c: rgba(0.24, 0.26, 0.21), pts: [-24, -44, 24, -44, 24, -47, -24, -47] },
  // Missile1
  { c: rgba(0.58, 0.18, 0.12), pts: [-17, -20, -10, -20, -10, -57, -17, -57] },
  { c: rgba(0.92, 0.9, 0.86), pts: [-17, -57, -13.5, -64, -10, -57] },
  { c: rgba(0.9, 0.85, 0.12), pts: [-17, -38, -10, -38, -10, -34, -17, -34] },
  { c: rgba(0.38, 0.12, 0.09), pts: [-21, -21, -17, -21, -17, -30, -22, -28] },
  { c: rgba(0.38, 0.12, 0.09), pts: [-10, -21, -6, -21, -6, -28, -10, -30] },
  // Missile2
  { c: rgba(0.58, 0.18, 0.12), pts: [-8, -20, -1, -20, -1, -57, -8, -57] },
  { c: rgba(0.92, 0.9, 0.86), pts: [-8, -57, -4.5, -64, -1, -57] },
  { c: rgba(0.9, 0.85, 0.12), pts: [-8, -38, -1, -38, -1, -34, -8, -34] },
  { c: rgba(0.38, 0.12, 0.09), pts: [-12, -21, -8, -21, -8, -30, -13, -28] },
  { c: rgba(0.38, 0.12, 0.09), pts: [-1, -21, 3, -21, 3, -28, -1, -30] },
  // Missile3
  { c: rgba(0.58, 0.18, 0.12), pts: [1, -20, 8, -20, 8, -57, 1, -57] },
  { c: rgba(0.92, 0.9, 0.86), pts: [1, -57, 4.5, -64, 8, -57] },
  { c: rgba(0.9, 0.85, 0.12), pts: [1, -38, 8, -38, 8, -34, 1, -34] },
  { c: rgba(0.38, 0.12, 0.09), pts: [-3, -21, 1, -21, 1, -30, -4, -28] },
  { c: rgba(0.38, 0.12, 0.09), pts: [8, -21, 12, -21, 12, -28, 8, -30] },
  // Missile4
  { c: rgba(0.58, 0.18, 0.12), pts: [10, -20, 17, -20, 17, -57, 10, -57] },
  { c: rgba(0.92, 0.9, 0.86), pts: [10, -57, 13.5, -64, 17, -57] },
  { c: rgba(0.9, 0.85, 0.12), pts: [10, -38, 17, -38, 17, -34, 10, -34] },
  { c: rgba(0.38, 0.12, 0.09), pts: [6, -21, 10, -21, 10, -30, 5, -28] },
  { c: rgba(0.38, 0.12, 0.09), pts: [17, -21, 21, -21, 21, -28, 17, -30] },
  // SensorHousing
  { c: rgba(0.13, 0.17, 0.26), pts: [-9, -55, 9, -55, 9, -70, -9, -70] },
  // SensorFace
  { c: rgba(0.1, 0.45, 0.78), pts: [-6.5, -57, 6.5, -57, 6.5, -68, -6.5, -68] },
  // SensorGlow
  { c: rgba(0.2, 1.0, 0.45), pts: [-2, -62, 2, -62, 2, -64, -2, -64] },
  // SensorAntennaL
  { c: rgba(0.28, 0.32, 0.28), pts: [-12, -56, -9, -56, -9, -70, -12, -70] },
  // SensorAntennaR
  { c: rgba(0.28, 0.32, 0.28), pts: [9, -56, 12, -56, 12, -70, 9, -70] },
];

// Selection glow polygons
const GLOW1 = [-58, 22, -44, 34, 44, 34, 58, 22, 44, 42, -44, 42];
const GLOW2 = [-74, 24, -56, 46, 56, 46, 74, 24, 56, 52, -56, 52];

export class SAMLauncher extends Launcher {
  constructor(x, y) {
    super(x, y, 'sam');
    this.clickHalfW = 40;
    this.clickHalfH = 50;
    this.turretTipOffset = -62;

    // Base stats — used by UpgradeState to recompute after applying effects.
    // missileSpeed: multiplier passed to Missile.launchTo (future use).
    // fireCooldown: minimum seconds between shots (0 = no cooldown by default).
    this._baseStats = {
      missileSpeed: 1.0,
      fireCooldown: 0.0,
    };
    // Apply base stats to instance fields so upgrade code can safely read them.
    this.missileSpeed  = this._baseStats.missileSpeed;
    this.fireCooldown  = this._baseStats.fireCooldown;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.translate(this._hitShakeX || 0, this._hitShakeY || 0);

    // Selection glow (behind everything) — cyan per spec
    if (this.isSelected) {
      ctx.shadowColor = '#00EEFF';
      ctx.shadowBlur = 20;
      drawPoly(ctx, GLOW2, `rgba(0,180,255,${(this._glowAlpha * 0.28).toFixed(3)})`);
      drawPoly(ctx, GLOW1, `rgba(0,180,255,${(this._glowAlpha * 0.55).toFixed(3)})`);
      ctx.shadowBlur = 0;
    }

    // Base slab with gradient
    ctx.save();
    const baseGrad = ctx.createLinearGradient(0, 14, 0, 30);
    baseGrad.addColorStop(0, '#3D4235');
    baseGrad.addColorStop(1, '#1E2218');
    ctx.fillStyle = baseGrad;
    ctx.beginPath();
    ctx.moveTo(-54, 28); ctx.lineTo(54, 28); ctx.lineTo(48, 14); ctx.lineTo(-48, 14);
    ctx.closePath();
    ctx.fill();
    // Rim
    ctx.fillStyle = '#0F1209';
    ctx.fillRect(-54, 28, 108, 2);
    // Warning bands (diagonal hatching)
    ctx.fillStyle = 'rgba(196,158,18,0.85)';
    ctx.beginPath(); ctx.moveTo(-54,20); ctx.lineTo(-50,20); ctx.lineTo(-38,28); ctx.lineTo(-42,28); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(50,20); ctx.lineTo(54,20); ctx.lineTo(42,28); ctx.lineTo(38,28); ctx.closePath(); ctx.fill();
    // Dark stripe on bands
    ctx.strokeStyle = '#1A1A00';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const bx = -53 + i * 5;
      ctx.beginPath(); ctx.moveTo(bx, 21); ctx.lineTo(bx - 4, 28); ctx.stroke();
    }
    ctx.restore();

    // Base upper with gradient
    ctx.save();
    const upperGrad = ctx.createLinearGradient(0, 4, 0, 14);
    upperGrad.addColorStop(0, '#4A4D40');
    upperGrad.addColorStop(1, '#2E3228');
    ctx.fillStyle = upperGrad;
    ctx.beginPath();
    ctx.moveTo(-48, 14); ctx.lineTo(48, 14); ctx.lineTo(40, 4); ctx.lineTo(-40, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Pivot
    ctx.fillStyle = '#1E2218';
    ctx.fillRect(-32, -10, 64, 14);
    ctx.fillStyle = '#0D100B';
    ctx.fillRect(-32, -10, 64, 1);
    ctx.fillStyle = '#3A3D35';
    ctx.fillRect(-32, 4, 64, 1);

    // Turret (rotated)
    ctx.save();
    ctx.rotate(this.turretRotation);

    // Arm with gradient
    const armGrad = ctx.createLinearGradient(-24, 0, 24, 0);
    armGrad.addColorStop(0, '#445540');
    armGrad.addColorStop(0.15, '#2E3228');
    armGrad.addColorStop(0.85, '#1A1D16');
    armGrad.addColorStop(1, '#445540');
    ctx.fillStyle = armGrad;
    ctx.fillRect(-24, -56, 48, 50);
    // Shoulder
    ctx.fillStyle = '#2E3228';
    ctx.fillRect(-26, -22, 52, 14);
    // Rib highlights
    ctx.fillStyle = '#445540';
    ctx.fillRect(-24, -56, 5, 34);
    ctx.fillRect(19, -56, 5, 34);
    // Braces
    ctx.fillStyle = '#363A30';
    ctx.fillRect(-24, -33, 48, 3);
    ctx.fillRect(-24, -47, 48, 3);

    // Missiles — 4 of them with improved colors
    for (let m = 0; m < 4; m++) {
      const mx = -17 + m * 9;
      // Body #993322 with highlight
      ctx.fillStyle = '#993322';
      ctx.fillRect(mx, -57, 7, 37);
      // Left edge highlight
      ctx.fillStyle = 'rgba(255,160,120,0.25)';
      ctx.fillRect(mx, -57, 2, 37);
      // Tip — ivory
      ctx.fillStyle = '#EEEADE';
      ctx.beginPath();
      ctx.moveTo(mx, -57); ctx.lineTo(mx + 3.5, -64); ctx.lineTo(mx + 7, -57);
      ctx.closePath(); ctx.fill();
      // 2px nose ring
      ctx.strokeStyle = '#CCBBA8';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, -57); ctx.lineTo(mx + 7, -57); ctx.stroke();
      // Band #E8D810
      ctx.fillStyle = '#E8D810';
      ctx.fillRect(mx, -38, 7, 4);
      // Fins
      ctx.fillStyle = '#5A2010';
      ctx.beginPath(); ctx.moveTo(mx - 4, -21); ctx.lineTo(mx, -21); ctx.lineTo(mx, -30); ctx.lineTo(mx - 5, -28); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(mx + 7, -21); ctx.lineTo(mx + 11, -21); ctx.lineTo(mx + 6, -28); ctx.lineTo(mx + 7, -30); ctx.closePath(); ctx.fill();
    }

    // Sensor housing with gradient
    const sensorGrad = ctx.createLinearGradient(-9, -70, 9, -55);
    sensorGrad.addColorStop(0, '#202A42');
    sensorGrad.addColorStop(1, '#141E30');
    ctx.fillStyle = sensorGrad;
    ctx.fillRect(-9, -70, 18, 15);
    ctx.strokeStyle = 'rgba(0,180,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-9, -70, 18, 15);
    // Sensor face gradient
    const faceGrad = ctx.createLinearGradient(-6.5, -68, 6.5, -57);
    faceGrad.addColorStop(0, '#1A74C8');
    faceGrad.addColorStop(1, '#0D3D6B');
    ctx.fillStyle = faceGrad;
    ctx.fillRect(-6.5, -68, 13, 11);
    // Glow arc
    ctx.shadowColor = '#00FF44';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#20FF72';
    ctx.fillRect(-2, -64, 4, 2);
    ctx.shadowBlur = 0;
    // Antennas
    ctx.fillStyle = '#2E3A2E';
    ctx.fillRect(-12, -70, 3, 14);
    ctx.fillRect(9, -70, 3, 14);

    ctx.restore(); // turret rotation

    // Damage overlay (flash, sparks, smoke, red tint) — base body bounds
    this._drawDamageOverlay(ctx, 54, 30, -10);

    ctx.restore(); // entity position
  }
}
