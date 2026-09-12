/**
 * QuadDrone — base class for quadcopter enemy drones.
 * Top-down 3/4 perspective, X-config arms, hover/approach/dying state machine.
 */

import { Entity } from './entity.js';
import { randf, lerp } from '../utils.js';

// States
export const STATE_APPROACH = 0;
export const STATE_HOVER    = 1;
export const STATE_DYING    = 2;

const APPROACH_SPEED   = 200; // px/s
const HOVER_BOB_AMP    = 4;   // px
const HOVER_BOB_HZ     = 2.5; // Hz
const HOVER_DRIFT_RANGE = 20; // px
const HOVER_DRIFT_HZ   = 0.3; // Hz
const SPRING_STRENGTH  = 3.0; // soft spring toward hoverTarget
const ROTOR_SPEED_HOVER = 12; // rad/s
const ROTOR_SPEED_DIVE  = 30; // rad/s (doubles in subclass)
const SPIRAL_ROT_MIN   = 3;   // rad/s
const SPIRAL_ROT_MAX   = 6;   // rad/s
const GRAVITY_DYING    = 200; // px/s²
const FLASH_DURATION   = 0.15; // s

// Arm tip offsets (X-config at 45°, length 22px)
const ARM_LENGTH = 22;
const ARM_TIPS = [
  { x:  ARM_LENGTH, y:  ARM_LENGTH },
  { x: -ARM_LENGTH, y:  ARM_LENGTH },
  { x: -ARM_LENGTH, y: -ARM_LENGTH },
  { x:  ARM_LENGTH, y: -ARM_LENGTH },
];

/**
 * Draw one rotor disc at (tipX, tipY) with local angle.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} tipX
 * @param {number} tipY
 * @param {number} angle — current blade rotation angle
 * @param {string} accentColor — CSS color for tip dots
 */
export function drawRotor(ctx, tipX, tipY, angle, accentColor) {
  const DISC_R = 12;
  const BLADE_COUNT = 3;

  ctx.save();
  ctx.translate(tipX, tipY);

  // Blur disc (motion blur)
  ctx.beginPath();
  ctx.arc(0, 0, DISC_R, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120,130,140,0.18)';
  ctx.fill();

  // 3 rotating arc blades
  for (let b = 0; b < BLADE_COUNT; b++) {
    const a = angle + (b / BLADE_COUNT) * Math.PI * 2;
    const startAngle = a - 0.18;
    const endAngle   = a + 0.18;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, DISC_R - 2, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = 'rgba(80,90,100,0.85)';
    ctx.fill();
  }

  // Orange accent arc (tip dots area)
  ctx.beginPath();
  ctx.arc(0, 0, DISC_R - 1, angle, angle + 0.5);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

export class QuadDrone extends Entity {
  /**
   * @param {number} x — spawn x
   * @param {number} y — spawn y
   * @param {object} opts — { hp, collisionRadius, accentColor }
   */
  constructor(x, y, opts = {}) {
    super(x, y);
    this.hp              = opts.hp            ?? 1;
    this.collisionRadius = opts.collisionRadius ?? 30;
    this.accentColor     = opts.accentColor   ?? '#FF8800';
    this.groups.add('enemy_missiles');

    this.state    = STATE_APPROACH;
    this.vx       = 0;
    this.vy       = 0;
    this.elapsed  = 0;

    // Hover target — set to a position above a launcher or random ground point
    this.hoverX = x;
    this.hoverY = y;

    // Rotor angles for 4 rotors (independent so damage can desync them)
    this.rotorAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];

    // Dying spiral
    this._spiralRot = randf(SPIRAL_ROT_MIN, SPIRAL_ROT_MAX) * (Math.random() < 0.5 ? 1 : -1);
    this.visualRotation = 0; // current display angle

    // Hit flash
    this._flashTimer = -1;

    // Damage shake
    this._shakeAmt = 0;

    // Smoke trail for dying state
    this._smoke = []; // [{x,y,r,a}]

    /** @type {function|null} Returns launcher entities */
    this.getLaunchers = null;

    /** @type {import('../engine/audio.js').AudioEngine|null} Audio engine reference */
    this.audio = null;

    // Timer for periodic buzz sound in hover state
    this._buzzTimer = 0;
  }

  /** Pick or update hover target above nearest launcher (or random). */
  _pickHoverTarget() {
    if (this.getLaunchers) {
      const launchers = this.getLaunchers().filter(l => l.alive);
      if (launchers.length > 0) {
        // Find nearest alive launcher
        let best = launchers[0];
        let bestDist = Infinity;
        for (const l of launchers) {
          const dx = l.x - this.x;
          const dy = l.y - this.y;
          if (dx * dx + dy * dy < bestDist) {
            bestDist = dx * dx + dy * dy;
            best = l;
          }
        }
        this.hoverX = best.x + randf(-60, 60);
        this.hoverY = best.y - randf(180, 280);
        return;
      }
    }
    // No launcher — hover over random screen position
    this.hoverX = randf(200, 2360);
    this.hoverY = randf(300, 600);
  }

  /** Called by collision system when hit. Returns true when dead. */
  takeDamage(amount = 1) {
    this.hp -= amount;
    this._flashTimer = FLASH_DURATION;
    this._shakeAmt = 8;
    if (this.hp <= 0) {
      this.hp = 0;
      this._enterDying();
    }
    return this.hp <= 0;
  }

  _enterDying() {
    this.state = STATE_DYING;
    // Keep current velocity as dying spiral seed
  }

  update(dt) {
    this.elapsed += dt;

    // Flash timer
    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
    }
    // Shake decay
    if (this._shakeAmt > 0) {
      this._shakeAmt = Math.max(0, this._shakeAmt - 40 * dt);
    }

    // Update rotor angles
    const rotSpeed = this.state === STATE_DYING
      ? (this.hp <= 0 ? ROTOR_SPEED_HOVER * 0.3 : ROTOR_SPEED_HOVER)
      : this._rotorSpeed();
    for (let i = 0; i < 4; i++) {
      // Alternate clockwise/counter-clockwise for stability
      this.rotorAngles[i] += rotSpeed * (i % 2 === 0 ? 1 : -1) * dt;
    }

    switch (this.state) {
      case STATE_APPROACH: this._updateApproach(dt); break;
      case STATE_HOVER:    this._updateHover(dt); break;
      case STATE_DYING:    this._updateDying(dt); break;
    }

    // Off-screen cleanup
    if (this.y > 1700 || this.x < -400 || this.x > 2960) {
      this.alive = false;
    }
  }

  /** Rotor speed override — subclasses can override. */
  _rotorSpeed() {
    return ROTOR_SPEED_HOVER;
  }

  _updateApproach(dt) {
    if (this.hoverX === this.x && this.hoverY === this.y) {
      this._pickHoverTarget();
    }

    const dx = this.hoverX - this.x;
    const dy = this.hoverY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 30) {
      // Arrived at hover point
      this.state = STATE_HOVER;
      this.vx = 0;
      this.vy = 0;
      return;
    }

    // Move toward hover target
    const nx = dx / dist;
    const ny = dy / dist;
    const speed = Math.min(APPROACH_SPEED, dist * 5);
    this.vx = lerp(this.vx, nx * speed, 4 * dt);
    this.vy = lerp(this.vy, ny * speed, 4 * dt);

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Continuous rotor buzz during approach — same timing as hover
    this._buzzTimer -= dt;
    if (this._buzzTimer <= 0) {
      this._buzzTimer = 0.5;
      this.audio?.playQuadBuzz(this.x);
    }
  }

  _updateHover(dt) {
    // Bob: vertical sine wave
    const bobY = Math.sin(this.elapsed * HOVER_BOB_HZ * Math.PI * 2) * HOVER_BOB_AMP;
    // Drift: slow sine on both axes
    const driftX = Math.sin(this.elapsed * HOVER_DRIFT_HZ * Math.PI * 2) * HOVER_DRIFT_RANGE;

    const targetX = this.hoverX + driftX;
    const targetY = this.hoverY + bobY;

    // Soft spring
    this.vx = lerp(this.vx, (targetX - this.x) * SPRING_STRENGTH, 3 * dt);
    this.vy = lerp(this.vy, (targetY - this.y) * SPRING_STRENGTH, 3 * dt);

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Continuous rotor buzz — retrigger every 0.5s (buffer is 0.55s so they overlap)
    this._buzzTimer -= dt;
    if (this._buzzTimer <= 0) {
      this._buzzTimer = 0.5;
      this.audio?.playQuadBuzz(this.x);
    }
  }

  _updateDying(dt) {
    // Gravity pull down
    this.vy += GRAVITY_DYING * dt;

    // Spiral rotation
    this.visualRotation += this._spiralRot * dt;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Smoke trail
    if (Math.random() < 0.6) {
      this._smoke.push({ x: this.x, y: this.y, r: randf(3, 7), a: 0.6 });
    }
    for (const s of this._smoke) {
      s.a -= 0.8 * dt;
      s.r += 4 * dt;
    }
    this._smoke = this._smoke.filter(s => s.a > 0);
  }

  draw(ctx) {
    // Draw smoke trail first (world space, no rotation)
    for (const s of this._smoke) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(60,55,50,${s.a.toFixed(3)})`;
      ctx.fill();
    }

    // Shake jitter
    const jx = this._shakeAmt > 0 ? randf(-this._shakeAmt, this._shakeAmt) : 0;
    const jy = this._shakeAmt > 0 ? randf(-this._shakeAmt, this._shakeAmt) : 0;

    ctx.save();
    ctx.translate(this.x + jx, this.y + jy);
    ctx.rotate(this.visualRotation);

    // Draw 4 arms first (behind body)
    this._drawArms(ctx);

    // Draw rotors at arm tips
    for (let i = 0; i < 4; i++) {
      const tip = ARM_TIPS[i];
      drawRotor(ctx, tip.x, tip.y, this.rotorAngles[i], this.accentColor);
    }

    // Draw body
    this._drawBody(ctx);

    // Hit flash overlay
    if (this._flashTimer > 0) {
      const t = this._flashTimer / FLASH_DURATION;
      ctx.save();
      ctx.globalAlpha = t * 0.85;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-12, -8, 24, 16);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    ctx.restore();
  }

  _drawArms(ctx) {
    // 4 arms tapering from 5px at body to 3px at tip
    const ARM_ANGLES = [
      Math.PI * 0.25,   //  45°
      Math.PI * 0.75,   // 135°
      Math.PI * 1.25,   // 225°
      Math.PI * 1.75,   // 315°
    ];

    for (let i = 0; i < 4; i++) {
      const angle = ARM_ANGLES[i];
      const tx = Math.cos(angle) * ARM_LENGTH;
      const ty = Math.sin(angle) * ARM_LENGTH;

      ctx.save();
      ctx.beginPath();
      // Tapered line via a narrow trapezoid
      const perp = angle + Math.PI / 2;
      const px = Math.cos(perp);
      const py = Math.sin(perp);
      ctx.moveTo(px * 2.5, py * 2.5);
      ctx.lineTo(tx + px * 1.5, ty + py * 1.5);
      ctx.lineTo(tx - px * 1.5, ty - py * 1.5);
      ctx.lineTo(-px * 2.5, -py * 2.5);
      ctx.closePath();
      ctx.fillStyle = '#4A4F56';
      ctx.fill();
      ctx.restore();
    }
  }

  _drawBody(ctx) {
    // 24x16px dark gray rect body
    ctx.fillStyle = '#363C42';
    ctx.fillRect(-12, -8, 24, 16);

    // Body highlight
    ctx.fillStyle = 'rgba(80,88,96,0.6)';
    ctx.fillRect(-10, -7, 20, 5);

    // Accent LEDs on body sides
    ctx.fillStyle = this.accentColor;
    ctx.beginPath(); ctx.arc(-10, 0, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( 10, 0, 2, 0, Math.PI * 2); ctx.fill();

    // Camera gimbal underneath
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(0, 6, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.accentColor;
    ctx.beginPath(); ctx.arc(0, 6, 1.5, 0, Math.PI * 2); ctx.fill();
  }
}
