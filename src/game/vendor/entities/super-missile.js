/**
 * Super missile (parachute bomb) — B61-style nuclear gravity bomb.
 * Falls fast initially, deploys parachute, drifts slowly with sway.
 *
 * Visual design: B61 "Silver Bullet" nuclear gravity bomb
 *   - Silver metallic body with lateral gradient
 *   - Blunt ogive nosecone (arcTo, NOT sharp triangle)
 *   - NATO yellow safety band near nose
 *   - Red arming/danger band near tail
 *   - 4-fin cruciform X tail assembly
 *   - ☢ symbol painted on body center
 *   - Pulsing green nuclear threat aura
 *   - Aerodynamic heating at nose (replaces rocket fire, pre-parachute only)
 *
 * Parachute has a redesigned 9-layer rendering:
 *   1. Threat glow halo (green — nuclear signature)
 *   2. Drop shadow
 *   3. Canopy base (radial gradient dome)
 *   4. 8 gore panels (alternating ivory/red)
 *   5. Gore rib lines
 *   6. Canopy outline
 *   7. Rim highlight arc
 *   8. Skirt hem
 *   9. 8 suspension lines to 2 risers
 *
 * Deployment animation: 0.4 s with overshoot scale.
 */

import { Entity } from './entity.js';
import { randf, lerp, lerpAngle } from '../utils.js';

const INITIAL_GRAVITY = 80;
const FRAGMENT_COUNT         = 4;
const FRAGMENT_SCATTER_SPEED = 180;     // px/s base outward velocity
const FRAGMENT_SCATTER_ARC   = Math.PI; // spread across 180 degrees (upward half)
const PARACHUTE_GRAVITY = 15;
// Terminal velocity with parachute. The original Godot value was 35 px/s on a
// ~720 px tall viewport. This implementation uses a 1440 px tall logical space
// (terrain at y=1240, spawn at y=-80), so the missile travels ~2x as far and
// must be proportionally faster to avoid blocking wave completion for 40+ seconds.
const PARACHUTE_SPEED = 120;
const OFF_SCREEN = { bottom: 1600, left: -200, right: 2760 };

// Canopy gore X-coordinates at skirt (y=0), 9 boundary points for 8 panels
// GORE_X[i] = 45 * sin((i/8 - 0.5) * PI) for i = 0..8
const GORE_X = [];
for (let i = 0; i <= 8; i++) {
  GORE_X.push(45 * Math.sin((i / 8 - 0.5) * Math.PI));
}
// Pre-computed GORE_X ≈ [-45, -41.6, -31.8, -17.2, 0, +17.2, +31.8, +41.6, +45]

// Canopy apex (top of dome)
const APEX_Y = -38;

// Full canopy outline polygon (same shape as before — used for outline + shadow)
const CANOPY_OUTLINE = [-45,0, -40,-20, -25,-32, 0,-38, 25,-32, 40,-20, 45,0];

/**
 * Create a lateral (left-to-right) metallic gradient for the body cylinder.
 * Simulates upper-left lighting on a cylindrical surface.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x0 - left edge X
 * @param {number} x1 - right edge X
 * @param {string} dark - shadow color
 * @param {string} mid - mid-tone color
 * @param {string} light - specular highlight color
 */
function metalGrad(ctx, x0, x1, dark, mid, light) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0,    dark);
  g.addColorStop(0.25, mid);
  g.addColorStop(0.48, light);  // highlight slightly left-of-center (upper-left lighting)
  g.addColorStop(0.70, mid);
  g.addColorStop(1.0,  dark);
  return g;
}

export class SuperMissile extends Entity {
  constructor(x, y) {
    super(x, y);
    this.vx = 0;
    this.vy = 0;
    this.gravityForce = INITIAL_GRAVITY;
    this.parachuteDeployed = false;
    this.swayTime = 0;
    this.parachuteRotation = 0;
    this.collisionRadius = 18;
    this.groups.add('enemy_missiles');

    // Parachute deployment animation state
    this.deployProgress = 0;  // 0 → 1 deployment scale
    this.deployTime = 0;
    this.canopyLean = 0;      // wind lean derived from vx

    // Time accumulator for pulsing nuclear aura
    this.time = 0;

    /** @type {function|null} */
    this.onImpact = null;
  }

  /**
   * @param {number} targetX
   * @param {number} targetY
   * @param {number} launchTime
   */
  launchTo(targetX, targetY, launchTime = 8.0) {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    this.vx = dx / launchTime;
    this.vy = (dy - 0.5 * this.gravityForce * launchTime * launchTime) / launchTime;
  }

  update(dt) {
    this.time += dt;

    // Deploy parachute when falling
    if (this.vy > 15.0 && !this.parachuteDeployed) {
      this.parachuteDeployed = true;
      this.vx *= 0.3;
      this.gravityForce = PARACHUTE_GRAVITY;
    }

    if (this.parachuteDeployed) {
      // Limit fall speed
      if (this.vy > PARACHUTE_SPEED) {
        this.vy = lerp(this.vy, PARACHUTE_SPEED, 3.0 * dt);
      }

      // Gentle sway — increased amplitude from 0.08 to 0.14
      this.swayTime += dt;
      this.vx += Math.sin(this.swayTime * 1.5) * 15.0 * dt;

      // Parachute billowing — increased amplitude from 0.08 to 0.14
      this.parachuteRotation = Math.sin(this.swayTime * 2.0) * 0.14;

      // Wind lean from horizontal velocity
      this.canopyLean = Math.max(-0.22, Math.min(0.22, this.vx * 0.0035));

      // Deployment animation (0.4 s with overshoot)
      this.deployTime += dt;
      const t = Math.min(this.deployTime / 0.4, 1.0);
      this.deployProgress = t < 0.8
        ? (t / 0.8) * 1.07
        : 1.07 - ((t - 0.8) / 0.2) * 0.07;

      // Keep pointing mostly down
      this.rotation = lerpAngle(this.rotation, Math.PI, 2.0 * dt);
    } else {
      this.vy += this.gravityForce * dt;
      this.rotation = Math.atan2(this.vy, this.vx) + Math.PI / 2;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Off-screen cleanup
    if (this.y > OFF_SCREEN.bottom || this.x < OFF_SCREEN.left || this.x > OFF_SCREEN.right) {
      this.alive = false;
    }
  }

  /**
   * Generate fragment spawn data. Called by the collision system when this
   * SuperMissile is hit by a player projectile.
   * @returns {Array<{x: number, y: number, vx: number, vy: number}>}
   */
  getFragments() {
    const frags = [];
    const baseAngle = -Math.PI / 2;
    for (let i = 0; i < FRAGMENT_COUNT; i++) {
      const t = FRAGMENT_COUNT > 1 ? (i / (FRAGMENT_COUNT - 1) - 0.5) : 0;
      const angle = baseAngle + t * FRAGMENT_SCATTER_ARC + randf(-0.15, 0.15);
      const speed = FRAGMENT_SCATTER_SPEED * randf(0.8, 1.2);
      frags.push({
        x:  this.x,
        y:  this.y,
        vx: Math.cos(angle) * speed + this.vx * 0.3,
        vy: Math.sin(angle) * speed + this.vy * 0.3,
      });
    }
    return frags;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    // ── Layer 1: Nuclear Threat Aura (pulsing green radial gradient) ──────────
    {
      // Pulse inner alpha between 0.12–0.22 at 1.8 Hz
      const pulseAlpha = Math.sin(this.time * 1.8) * 0.05 + 0.17;
      const grad = ctx.createRadialGradient(0, -8, 15, 0, -8, 55);
      grad.addColorStop(0,    `rgba(60,255,90,${pulseAlpha.toFixed(3)})`);
      grad.addColorStop(0.55, 'rgba(30,200,60,0.08)');
      grad.addColorStop(1,    'rgba(0,180,40,0)');
      ctx.beginPath();
      ctx.ellipse(0, -8, 55, 50, 0, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // ── Layer 8 (draw first): Cruciform Back Fins ─────────────────────────────
    // Back fins drawn first so primary fins overlap them
    {
      ctx.beginPath();
      ctx.rect(-3, 26, 6, 14);
      ctx.fillStyle = '#5A5E62';
      ctx.fill();
    }

    // ── Layer 7: Tail Adapter ─────────────────────────────────────────────────
    {
      ctx.beginPath();
      ctx.rect(-11, 24, 22, 10);
      ctx.fillStyle = metalGrad(ctx, -11, 11, '#545A5E', '#848C90', '#6A7075');
      ctx.fill();
      ctx.strokeStyle = 'rgba(50,55,58,0.4)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // ── Layer 6: Red Arming/Danger Band ──────────────────────────────────────
    {
      // Top border
      ctx.beginPath();
      ctx.rect(-13, 18, 26, 6);
      const redGrad = ctx.createLinearGradient(-13, 0, 13, 0);
      redGrad.addColorStop(0,    '#8B1A00');
      redGrad.addColorStop(0.35, '#CC2800');
      redGrad.addColorStop(0.55, '#FF3C10');
      redGrad.addColorStop(1,    '#992000');
      ctx.fillStyle = redGrad;
      ctx.fill();
      // Border strokes
      ctx.strokeStyle = 'rgba(60,10,0,0.6)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-13, 18); ctx.lineTo(13, 18);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-13, 24); ctx.lineTo(13, 24);
      ctx.stroke();
    }

    // ── Layer 2: Main Body ────────────────────────────────────────────────────
    {
      ctx.beginPath();
      ctx.rect(-13, -15, 26, 33);  // y: -15 to +18
      ctx.fillStyle = metalGrad(ctx, -13, 13, '#6A6E72', '#9EA4A8', '#D0D5D8');
      ctx.fill();
      ctx.strokeStyle = 'rgba(50,55,58,0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // Panel seam line at y=5
      ctx.beginPath();
      ctx.moveTo(-13, 5);
      ctx.lineTo(13, 5);
      ctx.strokeStyle = 'rgba(80,85,90,0.45)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // ── Layer 3: Fore Section (slightly wider nose adapter) ───────────────────
    {
      ctx.beginPath();
      ctx.rect(-14, -28, 28, 13);  // y: -28 to -15
      // Slightly lighter than main body
      const foreGrad = ctx.createLinearGradient(-14, 0, 14, 0);
      foreGrad.addColorStop(0,    '#7A8085');
      foreGrad.addColorStop(0.25, '#AEB4B8');
      foreGrad.addColorStop(0.48, '#E0E5E8');
      foreGrad.addColorStop(0.70, '#C0C6CA');
      foreGrad.addColorStop(1.0,  '#8A9095');
      ctx.fillStyle = foreGrad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(50,55,58,0.4)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // ── Layer 4: NATO Yellow Safety Band ──────────────────────────────────────
    {
      ctx.beginPath();
      ctx.rect(-14, -35, 28, 7);  // y: -35 to -28
      const yellowGrad = ctx.createLinearGradient(-14, 0, 14, 0);
      yellowGrad.addColorStop(0,    '#C89800');
      yellowGrad.addColorStop(0.35, '#F5CC00');
      yellowGrad.addColorStop(0.55, '#FFE040');
      yellowGrad.addColorStop(1,    '#C08A00');
      ctx.fillStyle = yellowGrad;
      ctx.fill();
      // Top/bottom border strokes
      ctx.strokeStyle = 'rgba(80,60,0,0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-14, -35); ctx.lineTo(14, -35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-14, -28); ctx.lineTo(14, -28);
      ctx.stroke();
    }

    // ── Layer 5: Blunt Nosecone (dome — arcTo for smooth ogive) ──────────────
    // This is the most critical visual change: blunt dome vs sharp triangle
    {
      ctx.beginPath();
      ctx.moveTo(-13, -35);
      // arcTo draws a smooth arc through the control point (0,-50) to the target (13,-35)
      // radius 16 gives a nicely blunted ogive dome profile
      ctx.arcTo(0, -50, 13, -35, 16);
      ctx.lineTo(13, -35);
      ctx.closePath();

      const noseGrad = ctx.createRadialGradient(-5, -42, 0, 0, -36, 22);
      noseGrad.addColorStop(0,   '#E8ECEF');  // specular hotspot, upper-left
      noseGrad.addColorStop(0.5, '#C2C8CC');
      noseGrad.addColorStop(1,   '#8A9095');  // shadow underside
      ctx.fillStyle = noseGrad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,65,70,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ── Layer 8 (continued): Primary Cruciform Fins (L/R delta) ──────────────
    {
      const finGrad = ctx.createLinearGradient(0, 26, 0, 40);
      finGrad.addColorStop(0, '#6E7275');
      finGrad.addColorStop(1, '#525658');

      // Left fin — swept delta silhouette
      ctx.beginPath();
      ctx.moveTo(-13, 26);
      ctx.lineTo(-30, 40);
      ctx.lineTo(-22, 40);
      ctx.lineTo(-13, 34);
      ctx.closePath();
      ctx.fillStyle = finGrad;
      ctx.fill();
      // Leading-edge highlight
      ctx.beginPath();
      ctx.moveTo(-13, 26);
      ctx.lineTo(-30, 40);
      ctx.strokeStyle = 'rgba(130,136,140,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Right fin — swept delta silhouette
      ctx.beginPath();
      ctx.moveTo(13, 26);
      ctx.lineTo(30, 40);
      ctx.lineTo(22, 40);
      ctx.lineTo(13, 34);
      ctx.closePath();
      ctx.fillStyle = finGrad;
      ctx.fill();
      // Leading-edge highlight
      ctx.beginPath();
      ctx.moveTo(13, 26);
      ctx.lineTo(30, 40);
      ctx.strokeStyle = 'rgba(130,136,140,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ── Layer 9: Radiation Symbol ☢ ───────────────────────────────────────────
    {
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = 'rgba(200,165,0,0.75)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur = 4;
      ctx.shadowColor = 'rgba(255,220,0,0.4)';
      ctx.fillText('☢', 0, 0);   // center of body
      ctx.shadowBlur = 0;
    }

    // ── Parachute — 9-layer rendering ────────────────────────────────────────
    if (this.parachuteDeployed) {
      ctx.save();
      ctx.translate(0, 34);
      ctx.scale(this.deployProgress, -this.deployProgress); // negative y: un-flip since body rotates π when falling
      ctx.rotate(this.parachuteRotation + this.canopyLean);

      this._drawParachute(ctx);

      ctx.restore();
    }

    // ── Layer 10: Aerodynamic Heating at Nose (replaces rocket fire) ──────────
    // Only shown before parachute deploys — no rocket engine on a gravity bomb
    if (!this.parachuteDeployed) {
      const flicker = 0.3 + Math.random() * 0.25;
      // Main heating glow at nose tip
      const grad = ctx.createRadialGradient(0, -50, 0, 0, -50, 14);
      grad.addColorStop(0,   `rgba(255,200,80,${flicker.toFixed(2)})`);
      grad.addColorStop(0.5, `rgba(255,120,20,${(flicker * 0.5).toFixed(2)})`);
      grad.addColorStop(1,   'rgba(255,60,0,0)');
      ctx.beginPath();
      ctx.arc(0, -50, 14, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // 4 ablative particle sparks streaming back from nose
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(randf(-4, 4), -50 + randf(5, 20), randf(0.5, 2), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,160,40,${(Math.random() * 0.6).toFixed(2)})`;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /**
   * Draw the 9-layer parachute canopy.
   * Called with canvas already translated to canopy origin (0,34 from body center),
   * scaled by deployProgress, and rotated by parachuteRotation + canopyLean.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawParachute(ctx) {
    // ── Layer 1: Threat Glow Halo (GREEN — nuclear signature) ─────────────────
    {
      const grad = ctx.createRadialGradient(0, -20, 0, 0, -20, 58);
      grad.addColorStop(0, 'rgba(60,255,90,0.15)');
      grad.addColorStop(1, 'rgba(0,180,40,0)');
      ctx.beginPath();
      // Upper half-ellipse: PI → 0 clockwise = top arc (left to right through apex)
      ctx.ellipse(0, -20, 58, 52, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // ── Layer 2: Drop Shadow ──────────────────────────────────────────────────
    {
      ctx.beginPath();
      // Upper half-ellipse (+5, +5 offset) for shadow — PI → 0 clockwise = top arc
      ctx.ellipse(5, -15, 58, 52, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fill();
    }

    // ── Layer 3: Canopy Base (Radial Gradient Dome) ───────────────────────────
    {
      const grad = ctx.createRadialGradient(-8, -32, 0, 0, -19, 52);
      grad.addColorStop(0,    '#FFFFFF');
      grad.addColorStop(0.28, '#EAE6D2');
      grad.addColorStop(0.56, '#C4C0AC');
      grad.addColorStop(0.78, '#9A9688');
      grad.addColorStop(1,    '#6A6860');
      ctx.beginPath();
      // Upper half-ellipse: PI → 0 clockwise = top arc (left through apex to right)
      ctx.ellipse(0, 0, 45, 38, 0, Math.PI, 0);
      ctx.closePath();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }

    // ── Layer 4: 8 Gore Panels ────────────────────────────────────────────────
    for (let g = 0; g < 8; g++) {
      const x0 = GORE_X[g];
      const x1 = GORE_X[g + 1];
      const midX = (x0 + x1) * 0.5;

      // Per-gore billowing: slight bulge applied to the panel midpoint at skirt
      const billow = Math.sin(this.swayTime * 3.0 + g * 0.785) * 4.0;

      const isEven = (g % 2 === 0);
      // Gradient from skirt color to apex color
      const skirtColor = isEven ? '#F0ECD8' : '#EE3311';
      const apexColor  = isEven ? '#B4B0A0' : '#7A1100';

      const grad = ctx.createLinearGradient(0, 0, 0, APEX_Y);
      grad.addColorStop(0, skirtColor);
      grad.addColorStop(1, apexColor);

      ctx.beginPath();
      ctx.moveTo(0, APEX_Y);        // apex
      ctx.lineTo(x0, 0);            // left boundary at skirt
      ctx.quadraticCurveTo(midX + billow * 0.5, 2, x1, 0); // skirt with billow
      ctx.closePath();

      ctx.fillStyle = grad;
      ctx.fill();
    }

    // ── Layer 5: Gore Rib Lines ───────────────────────────────────────────────
    {
      ctx.strokeStyle = 'rgba(70,52,42,0.55)';
      ctx.lineWidth = 1.5;
      // 7 seams between 8 panels — seams at GORE_X[1..7]
      for (let g = 1; g < 8; g++) {
        ctx.beginPath();
        ctx.moveTo(0, APEX_Y);
        ctx.lineTo(GORE_X[g], 0);
        ctx.stroke();
      }
    }

    // ── Layer 6: Canopy Outline ───────────────────────────────────────────────
    {
      ctx.beginPath();
      ctx.moveTo(CANOPY_OUTLINE[0], CANOPY_OUTLINE[1]);
      for (let i = 2; i < CANOPY_OUTLINE.length; i += 2) {
        ctx.lineTo(CANOPY_OUTLINE[i], CANOPY_OUTLINE[i + 1]);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(55,45,35,0.72)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ── Layer 7: Rim Highlight Arc (upper-left crescent) ─────────────────────
    {
      ctx.beginPath();
      ctx.arc(-12, -26, 36, Math.PI * 1.1, Math.PI * 1.7);
      ctx.strokeStyle = 'rgba(255,255,240,0.70)';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 7;
      ctx.shadowColor = 'rgba(255,255,255,0.5)';
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ── Layer 8: Skirt Hem (dark strip at bottom) ─────────────────────────────
    {
      ctx.beginPath();
      ctx.moveTo(GORE_X[0], 0);
      ctx.quadraticCurveTo(0, 6, GORE_X[8], 0);
      ctx.lineTo(GORE_X[8], 3);
      ctx.quadraticCurveTo(0, 9, GORE_X[0], 3);
      ctx.closePath();
      ctx.fillStyle = 'rgba(65,50,40,0.45)';
      ctx.fill();
    }

    // ── Layer 9: 8 Suspension Lines to 2 Risers ──────────────────────────────
    // Color: cooler nylon/cord tone (vs warm tan of original)
    {
      ctx.strokeStyle = 'rgba(210,205,195,0.90)';
      ctx.lineWidth = 1.5;
      const riserL = { x: -7, y: 34 };
      const riserR = { x:  7, y: 34 };
      for (let g = 0; g <= 8; g++) {
        const gx = GORE_X[g];
        const riser = gx <= 0 ? riserL : riserR;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(riser.x, riser.y);
        ctx.stroke();
      }
    }
  }
}
