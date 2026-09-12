/**
 * AttackQuad — 3 HP quadcopter that fires tracer bursts at launchers.
 * Blue accent, 3-round bursts every 2.0-3.5s, gimbal tracks nearest launcher.
 */

import { QuadDrone } from './quad-drone.js';
import { QuadTracer } from './quad-tracer.js';
import { randf, lerp } from '../utils.js';

const A_STATE_APPROACH = 0;
const A_STATE_HOVER    = 1;
const A_STATE_DYING    = 2;

const ROTOR_SPEED_HOVER = 12;
const BURST_COUNT   = 3;
const BURST_SPREAD  = 0.08; // radians accuracy spread

const ARM_LENGTH = 22;
const ARM_TIPS = [
  { x:  ARM_LENGTH, y:  ARM_LENGTH },
  { x: -ARM_LENGTH, y:  ARM_LENGTH },
  { x: -ARM_LENGTH, y: -ARM_LENGTH },
  { x:  ARM_LENGTH, y: -ARM_LENGTH },
];

export class AttackQuad extends QuadDrone {
  /**
   * @param {number} x — spawn x
   * @param {number} y — spawn y
   */
  constructor(x, y) {
    super(x, y, {
      hp: 3,
      collisionRadius: 32,
      accentColor: '#00C8FF',
    });

    this._aState     = A_STATE_APPROACH;
    this._fireCooldown = randf(2.0, 3.5);
    this._burstQueue  = 0;   // tracers remaining in burst
    this._burstTimer  = 0;   // delay between burst shots

    // Gimbal angle — tracks nearest launcher
    this._gimbalAngle = Math.PI / 2;

    // Scoring
    this.pointValue = 3;
    this.enemyType  = 'attack_quad';

  }

  /**
   * Override base update.
   * @param {number} dt
   */
  update(dt) {
    this.elapsed += dt;

    if (this._flashTimer > 0) this._flashTimer -= dt;
    if (this._shakeAmt > 0) this._shakeAmt = Math.max(0, this._shakeAmt - 40 * dt);

    // Rotor spin
    for (let i = 0; i < 4; i++) {
      this.rotorAngles[i] += ROTOR_SPEED_HOVER * (i % 2 === 0 ? 1 : -1) * dt;
    }

    // Smoke trail tick
    for (const s of this._smoke) {
      s.a -= 0.8 * dt;
      s.r += 4 * dt;
    }
    this._smoke = this._smoke.filter(s => s.a > 0);

    // Gimbal tracking
    this._updateGimbal();

    switch (this._aState) {
      case A_STATE_APPROACH: this._aApproach(dt); break;
      case A_STATE_HOVER:    this._aHover(dt);    break;
      case A_STATE_DYING:    this._aDying(dt);    break;
    }

    if (this.y > 1700 || this.x < -400 || this.x > 2960) {
      this.alive = false;
    }
  }

  _updateGimbal() {
    if (!this.getLaunchers) return;
    const alive = this.getLaunchers().filter(l => l.alive);
    if (alive.length === 0) return;

    let best = alive[0];
    let bestD2 = Infinity;
    for (const l of alive) {
      const dx = l.x - this.x;
      const dy = l.y - this.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = l; }
    }
    this._gimbalAngle = Math.atan2(best.y - this.y, best.x - this.x);
  }

  _aApproach(dt) {
    if (this.hoverX === this.x && this.hoverY === this.y) {
      this._pickHoverTarget();
    }
    const dx = this.hoverX - this.x;
    const dy = this.hoverY - this.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d < 30) {
      this._aState = A_STATE_HOVER;
      this.vx = 0;
      this.vy = 0;
      return;
    }
    const nx = dx / d;
    const ny = dy / d;
    const speed = Math.min(200, d * 5);
    this.vx = lerp(this.vx, nx * speed, 4 * dt);
    this.vy = lerp(this.vy, ny * speed, 4 * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Rotor buzz during approach
    this._buzzTimer -= dt;
    if (this._buzzTimer <= 0) {
      this._buzzTimer = 0.5;
      this.audio?.playQuadBuzz(this.x);
    }
  }

  _aHover(dt) {
    // Bob + drift
    const bobY   = Math.sin(this.elapsed * 2.5 * Math.PI * 2) * 4;
    const driftX = Math.sin(this.elapsed * 0.3 * Math.PI * 2) * 20;
    const tx = this.hoverX + driftX;
    const ty = this.hoverY + bobY;
    this.vx = lerp(this.vx, (tx - this.x) * 3.0, 3 * dt);
    this.vy = lerp(this.vy, (ty - this.y) * 3.0, 3 * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Rotor buzz during hover
    this._buzzTimer -= dt;
    if (this._buzzTimer <= 0) {
      this._buzzTimer = 0.5;
      this.audio?.playQuadBuzz(this.x);
    }

    // Fire logic
    if (this._burstQueue > 0) {
      this._burstTimer -= dt;
      if (this._burstTimer <= 0) {
        this._fireTracer();
        this._burstQueue--;
        this._burstTimer = 0.08; // 80ms between shots
      }
    } else {
      this._fireCooldown -= dt;
      if (this._fireCooldown <= 0) {
        this._burstQueue = BURST_COUNT;
        this._burstTimer = 0;
        this._fireCooldown = randf(2.0, 3.5);
      }
    }
  }

  _fireTracer() {
    if (!this.onSpawnProjectile) return;
    const tracer = QuadTracer.create(this.x, this.y, Math.cos(this._gimbalAngle), Math.sin(this._gimbalAngle), BURST_SPREAD);
    this.onSpawnProjectile(tracer);
    this.audio?.playQuadTracerShot(this.x);
  }

  _aDying(dt) {
    this.vy += 200 * dt;
    this.visualRotation += this._spiralRot * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (Math.random() < 0.6) {
      this._smoke.push({ x: this.x, y: this.y, r: randf(3, 7), a: 0.6 });
    }
  }

  /** Override takeDamage to switch to dying state when HP reaches 0. */
  takeDamage(amount = 1) {
    const dead = super.takeDamage(amount);
    if (dead && this._aState !== A_STATE_DYING) {
      this._aState = A_STATE_DYING;
    }
    return dead;
  }

  draw(ctx) {
    // Smoke trail
    for (const s of this._smoke) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(60,55,50,${s.a.toFixed(3)})`;
      ctx.fill();
    }

    const jx = this._shakeAmt > 0 ? (Math.random() - 0.5) * this._shakeAmt * 2 : 0;
    const jy = this._shakeAmt > 0 ? (Math.random() - 0.5) * this._shakeAmt * 2 : 0;

    ctx.save();
    ctx.translate(this.x + jx, this.y + jy);
    ctx.rotate(this.visualRotation);

    this._drawArms(ctx);
    this._drawRotors(ctx);
    this._drawBody(ctx);
    this._drawGimbal(ctx);
    this._drawHPBar(ctx);

    // Hit flash
    if (this._flashTimer > 0) {
      const t = this._flashTimer / 0.15;
      ctx.save();
      ctx.globalAlpha = t * 0.85;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-12, -8, 24, 16);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    ctx.restore();
  }

  _drawRotors(ctx) {
    const DISC_R = 12;
    const BLADE_COUNT = 3;
    for (let i = 0; i < 4; i++) {
      const tip = ARM_TIPS[i];
      const angle = this.rotorAngles[i];

      ctx.save();
      ctx.translate(tip.x, tip.y);

      ctx.beginPath();
      ctx.arc(0, 0, DISC_R, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,130,140,0.18)';
      ctx.fill();

      for (let b = 0; b < BLADE_COUNT; b++) {
        const a = angle + (b / BLADE_COUNT) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, DISC_R - 2, a - 0.18, a + 0.18);
        ctx.closePath();
        ctx.fillStyle = 'rgba(80,90,100,0.85)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(0, 0, DISC_R - 1, angle, angle + 0.5);
      ctx.strokeStyle = '#00C8FF';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    }
  }

  /**
   * Override base _drawBody to omit the static camera gimbal.
   * AttackQuad draws its own tracking gimbal via _drawGimbal() instead.
   */
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
    // NOTE: no static gimbal here — _drawGimbal() renders the tracking one.
  }

  _drawGimbal(ctx) {
    // Camera gimbal underneath, rotated to track target
    ctx.save();
    // Gimbal is drawn in world-rotate space, but we want it pointing at target
    // We're already translated and rotated by visualRotation (usually 0 when hovering)
    // so counter-rotate by visualRotation then apply gimbal angle
    ctx.rotate(-this.visualRotation);
    ctx.rotate(this._gimbalAngle + Math.PI / 2); // +90° so up = toward target

    // Gimbal housing
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(0, 8, 4, 0, Math.PI * 2); ctx.fill();

    // Gun barrel pointing toward target
    ctx.fillStyle = '#00C8FF';
    ctx.fillRect(-1, 4, 2, 8);

    // Blue LED pulse
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 6);
    ctx.save();
    ctx.shadowColor = '#00C8FF';
    ctx.shadowBlur = 4 * pulse;
    ctx.fillStyle = `rgba(0,200,255,${(0.6 + 0.4 * pulse).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(0, 8, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  _drawHPBar(ctx) {
    if (this.hp >= 3) return; // Only show when damaged
    const maxW = 20;
    const w = maxW * (this.hp / 3);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-maxW / 2, -16, maxW, 3);
    ctx.fillStyle = this.hp === 1 ? '#FF4400' : '#00CC44';
    ctx.fillRect(-maxW / 2, -16, w, 3);
  }
}
