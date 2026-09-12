/**
 * Heat-Seeking Launcher — translated from heat_seeking_launcher.tscn + launcher.gd.
 * Twin-tube launcher with spinning radar dish.
 */

import { Launcher, drawPoly } from './launcher.js';
import { TAU, rgba } from '../utils.js';

// Base (non-rotating) polygons
const BASE_POLYS = [
  // BaseSlab
  { c: rgba(0.18, 0.2, 0.24), pts: [-46, 28, 46, 28, 40, 14, -40, 14] },
  // BaseSlabRim
  { c: rgba(0.1, 0.12, 0.15), pts: [-46, 30, 46, 30, 46, 28, -46, 28] },
  // BaseUpper
  { c: rgba(0.22, 0.25, 0.3), pts: [-40, 14, 40, 14, 34, 4, -34, 4] },
  // BaseTrimLine
  { c: rgba(0.1, 0.55, 0.82, 0.9), pts: [-40, 15, 40, 15, 40, 14, -40, 14] },
  // PivotOuter
  { c: rgba(0.18, 0.2, 0.26), pts: [-30, 4, 30, 4, 30, -8, -30, -8] },
  // PivotTrimLine
  { c: rgba(0.1, 0.55, 0.82, 0.7), pts: [-30, 5, 30, 5, 30, 4, -30, 4] },
];

// Turret (rotating) polygons — excludes radar (drawn separately with its own rotation)
const TURRET_POLYS = [
  // MastBase
  { c: rgba(0.2, 0.24, 0.32), pts: [-7, -6, 7, -6, 7, -22, -7, -22] },
  // MastBody
  { c: rgba(0.17, 0.21, 0.28), pts: [-4, -22, 4, -22, 4, -46, -4, -46] },
  // MastSheen
  { c: rgba(0.3, 0.4, 0.55), pts: [-4, -22, -2, -22, -2, -46, -4, -46] },
  // StatusLight
  { c: rgba(0.1, 1.0, 0.4), pts: [-2, -20, 2, -20, 2, -18, -2, -18] },
  // TubeL
  { c: rgba(0.2, 0.24, 0.32), pts: [-40, -8, -28, -8, -28, -50, -40, -50] },
  // TubeLSheen
  { c: rgba(0.3, 0.38, 0.52), pts: [-40, -8, -38, -8, -38, -50, -40, -50] },
  // TubeLFlange
  { c: rgba(0.14, 0.16, 0.22), pts: [-43, -6, -25, -6, -25, -9, -43, -9] },
  // TubeLMissile
  { c: rgba(0.55, 0.18, 0.12), pts: [-37, -12, -31, -12, -31, -48, -37, -48] },
  // TubeLTip
  { c: rgba(0.92, 0.9, 0.86), pts: [-37, -48, -34, -54, -31, -48] },
  // TubeLBand
  { c: rgba(0.9, 0.85, 0.12), pts: [-37, -32, -31, -32, -31, -28, -37, -28] },
  // TubeR
  { c: rgba(0.2, 0.24, 0.32), pts: [28, -8, 40, -8, 40, -50, 28, -50] },
  // TubeRSheen
  { c: rgba(0.3, 0.38, 0.52), pts: [28, -8, 30, -8, 30, -50, 28, -50] },
  // TubeRFlange
  { c: rgba(0.14, 0.16, 0.22), pts: [25, -6, 43, -6, 43, -9, 25, -9] },
  // TubeRMissile
  { c: rgba(0.55, 0.18, 0.12), pts: [31, -12, 37, -12, 37, -48, 31, -48] },
  // TubeRTip
  { c: rgba(0.92, 0.9, 0.86), pts: [31, -48, 34, -54, 37, -48] },
  // TubeRBand
  { c: rgba(0.9, 0.85, 0.12), pts: [31, -32, 37, -32, 37, -28, 31, -28] },
];

// Radar dish polygons — drawn at RadarMast position (0, -46) with independent rotation
const RADAR_POLYS = [
  // RadarArm
  { c: rgba(0.22, 0.26, 0.34), pts: [-2, 0, 2, 0, 2, -8, -2, -8] },
  // DishBack
  { c: rgba(0.15, 0.19, 0.26), pts: [-30, -8, -22, -20, -10, -26, 0, -28, 10, -26, 22, -20, 30, -8] },
  // DishFace
  { c: rgba(0.12, 0.46, 0.72), pts: [-28, -9, -20, -20, -9, -26, 0, -27, 9, -26, 20, -20, 28, -9] },
  // DishInner
  { c: rgba(0.08, 0.65, 0.95, 0.85), pts: [-18, -11, -11, -21, 0, -24, 11, -21, 18, -11] },
  // DishGlow
  { c: rgba(0.15, 0.95, 1.0, 0.9), pts: [-6, -14, 6, -14, 4, -22, 0, -24, -4, -22] },
  // DishCore
  { c: rgba(0.4, 1.0, 1.0), pts: [-2, -17, 2, -17, 1, -21, 0, -22, -1, -21] },
];

const GLOW1 = [-50, 22, -38, 32, 38, 32, 50, 22, 38, 40, -38, 40];
const GLOW2 = [-64, 24, -48, 44, 48, 44, 64, 24, 48, 50, -48, 50];

export class HeatSeekerLauncher extends Launcher {
  constructor(x, y) {
    super(x, y, 'heatseeker');
    this.clickHalfW = 45;
    this.clickHalfH = 50;
    this.turretTipOffset = -62;

    // Independent radar rotation (from launcher.gd: $Turret/RadarMast.rotation += 1.8 * delta)
    this.radarRotation = 0;

    // Base stats for upgrade system.
    // missileSpeed: future multiplier for heat-seeker velocity.
    // lockRadius:   crosshair lock-on radius in px (Game currently uses CROSSHAIR_RADIUS=90).
    // fireCooldown: minimum seconds between shots.
    this._baseStats = {
      missileSpeed: 1.0,
      lockRadius:   90,
      fireCooldown: 0.0,
    };
    this.missileSpeed  = this._baseStats.missileSpeed;
    this.lockRadius    = this._baseStats.lockRadius;
    this.fireCooldown  = this._baseStats.fireCooldown;
  }

  update(dt) {
    super.update(dt);
    // Spin radar dish independently
    this.radarRotation += 1.8 * dt;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.translate(this._hitShakeX || 0, this._hitShakeY || 0);

    // Selection glow — teal/cyan per spec
    if (this.isSelected) {
      ctx.shadowColor = '#00DDFF';
      ctx.shadowBlur = 20;
      drawPoly(ctx, GLOW2, `rgba(0,200,255,${(this._glowAlpha * 0.28).toFixed(3)})`);
      drawPoly(ctx, GLOW1, `rgba(0,200,255,${(this._glowAlpha * 0.55).toFixed(3)})`);
      ctx.shadowBlur = 0;
    }

    // Base slab gradient
    const baseGrad = ctx.createLinearGradient(0, 14, 0, 30);
    baseGrad.addColorStop(0, '#2E3340');
    baseGrad.addColorStop(1, '#161C2A');
    ctx.fillStyle = baseGrad;
    ctx.beginPath();
    ctx.moveTo(-46, 28); ctx.lineTo(46, 28); ctx.lineTo(40, 14); ctx.lineTo(-40, 14);
    ctx.closePath(); ctx.fill();
    // Rim
    ctx.fillStyle = '#0A0E18';
    ctx.fillRect(-46, 28, 92, 2);
    // 2px trim line cyan
    ctx.fillStyle = 'rgba(26,192,255,0.9)';
    ctx.fillRect(-40, 14, 80, 2);

    // BaseUpper
    const upperGrad = ctx.createLinearGradient(0, 4, 0, 14);
    upperGrad.addColorStop(0, '#363D50');
    upperGrad.addColorStop(1, '#222A3A');
    ctx.fillStyle = upperGrad;
    ctx.beginPath();
    ctx.moveTo(-40, 14); ctx.lineTo(40, 14); ctx.lineTo(34, 4); ctx.lineTo(-34, 4);
    ctx.closePath(); ctx.fill();
    // Trim line
    ctx.fillStyle = 'rgba(26,192,255,0.7)';
    ctx.fillRect(-30, 5, 60, 1);

    // Pivot
    ctx.fillStyle = '#222A36';
    ctx.fillRect(-30, -8, 60, 12);

    // Turret (rotated)
    ctx.save();
    ctx.rotate(this.turretRotation);

    // Mast with gradient
    const mastGrad = ctx.createLinearGradient(-7, 0, 7, 0);
    mastGrad.addColorStop(0, '#303850');
    mastGrad.addColorStop(1, '#1A2035');
    ctx.fillStyle = mastGrad;
    ctx.fillRect(-7, -22, 14, 16);
    ctx.fillRect(-4, -46, 8, 24);
    // Mast sheen
    ctx.fillStyle = 'rgba(80,110,160,0.5)';
    ctx.fillRect(-4, -46, 2, 24);

    // Status light
    ctx.save();
    ctx.shadowColor = '#00FF44';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#19FF66';
    ctx.beginPath(); ctx.arc(0, -19, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Tubes
    for (const side of [-1, 1]) {
      const tx = side === -1 ? -40 : 28;
      const tw = 12;
      // Tube body gradient
      const tubeGrad = ctx.createLinearGradient(tx, 0, tx + tw, 0);
      tubeGrad.addColorStop(0, side === -1 ? '#303850' : '#303850');
      tubeGrad.addColorStop(side === -1 ? 1 : 0, '#1A2035');
      ctx.fillStyle = tubeGrad;
      ctx.fillRect(tx, -50, tw, 42);
      // Sheen
      ctx.fillStyle = 'rgba(80,100,140,0.5)';
      ctx.fillRect(side === -1 ? tx : tx + 10, -50, 2, 42);
      // Flange
      ctx.fillStyle = '#181C2A';
      ctx.fillRect(tx - 3, -9, tw + 6, 3);
      // Missile in tube
      const mx = tx + 3;
      ctx.fillStyle = '#882818';
      ctx.fillRect(mx, -48, 6, 36);
      ctx.fillStyle = 'rgba(255,160,120,0.2)';
      ctx.fillRect(mx, -48, 2, 36);
      // Tip
      ctx.fillStyle = '#EEEADE';
      ctx.beginPath();
      ctx.moveTo(mx, -48); ctx.lineTo(mx + 3, -54); ctx.lineTo(mx + 6, -48);
      ctx.closePath(); ctx.fill();
      // Band
      ctx.fillStyle = '#E8D810';
      ctx.fillRect(mx, -32, 6, 4);
    }

    // Radar dish — positioned at (0, -46), with independent rotation
    ctx.save();
    ctx.translate(0, -46);
    ctx.rotate(this.radarRotation);

    // Radar arm
    ctx.fillStyle = '#363E50';
    ctx.fillRect(-2, -8, 4, 8);

    // Dish back
    ctx.fillStyle = '#1A2230';
    ctx.beginPath();
    ctx.moveTo(-30, -8); ctx.bezierCurveTo(-30, -8, -15, -28, 0, -28); ctx.bezierCurveTo(15, -28, 30, -8, 30, -8);
    ctx.closePath(); ctx.fill();

    // Dish face gradient
    const dishGrad = ctx.createLinearGradient(0, -27, 0, -9);
    dishGrad.addColorStop(0, '#1A75C0');
    dishGrad.addColorStop(1, '#0D3D70');
    ctx.fillStyle = dishGrad;
    ctx.beginPath();
    ctx.moveTo(-28, -9); ctx.bezierCurveTo(-20, -22, -9, -26, 0, -27); ctx.bezierCurveTo(9, -26, 20, -22, 28, -9);
    ctx.closePath(); ctx.fill();

    // Dish inner
    ctx.fillStyle = 'rgba(30,150,220,0.75)';
    ctx.beginPath();
    ctx.moveTo(-18, -11); ctx.lineTo(-11, -21); ctx.lineTo(0, -24); ctx.lineTo(11, -21); ctx.lineTo(18, -11);
    ctx.closePath(); ctx.fill();

    // Center glow
    ctx.save();
    ctx.shadowColor = '#00FFEE';
    ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(25,255,240,0.9)';
    ctx.beginPath(); ctx.arc(0, -17, 7, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Dish core
    ctx.fillStyle = '#66FFFF';
    ctx.beginPath(); ctx.arc(0, -17, 2, 0, Math.PI * 2); ctx.fill();

    ctx.restore(); // radar rotation

    ctx.restore(); // turret rotation

    // Damage overlay — base body bounds
    this._drawDamageOverlay(ctx, 46, 30, -8);

    ctx.restore(); // entity position
  }
}
