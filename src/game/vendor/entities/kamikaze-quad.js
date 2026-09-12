/**
 * KamikazeQuad — 1 HP quadcopter that hovers then dives into launchers.
 * Red accent, hover 1.5-3.0s → warning flash → dive at 450px/s.
 */

import { QuadDrone } from './quad-drone.js';
import { randf, lerp } from '../utils.js';

const K_STATE_APPROACH = 0;
const K_STATE_HOVER    = 1;
const K_STATE_WARNING  = 2;
const K_STATE_DIVE     = 3;
const K_STATE_DYING    = 4;

const DIVE_SPEED       = 450; // px/s
const WARNING_DURATION = 0.6; // s
const ROTOR_SPEED_DIVE = 30;  // rad/s

const ARM_LENGTH = 22;
const ARM_TIPS = [
  { x:  ARM_LENGTH, y:  ARM_LENGTH },
  { x: -ARM_LENGTH, y:  ARM_LENGTH },
  { x: -ARM_LENGTH, y: -ARM_LENGTH },
  { x:  ARM_LENGTH, y: -ARM_LENGTH },
];

export class KamikazeQuad extends QuadDrone {
  /**
   * @param {number} x — spawn x
   * @param {number} y — spawn y
   */
  constructor(x, y) {
    super(x, y, {
      hp: 1,
      collisionRadius: 26,
      accentColor: '#FF2010',
    });

    this._kState         = K_STATE_APPROACH;
    this._hoverTimer     = 0;
    this._hoverDuration  = randf(1.5, 3.0);
    this._warningTimer   = 0;

    /** @type {{ x: number, y: number }|null} */
    this._diveTarget = null;

    // Scoring
    this.pointValue = 2;
    this.enemyType  = 'kamikaze_quad';
  }

  _rotorSpeed() {
    return this._kState === K_STATE_DIVE ? ROTOR_SPEED_DIVE : 12;
  }

  /**
   * Override the base update to use our own state machine.
   * @param {number} dt
   */
  update(dt) {
    this.elapsed += dt;

    if (this._flashTimer > 0) this._flashTimer -= dt;
    if (this._shakeAmt > 0) this._shakeAmt = Math.max(0, this._shakeAmt - 40 * dt);

    // Rotor spin
    const rotSpeed = this._rotorSpeed();
    for (let i = 0; i < 4; i++) {
      this.rotorAngles[i] += rotSpeed * (i % 2 === 0 ? 1 : -1) * dt;
    }

    // Smoke trail tick
    for (const s of this._smoke) {
      s.a -= 0.8 * dt;
      s.r += 4 * dt;
    }
    this._smoke = this._smoke.filter(s => s.a > 0);

    switch (this._kState) {
      case K_STATE_APPROACH: this._kApproach(dt);  break;
      case K_STATE_HOVER:    this._kHover(dt);     break;
      case K_STATE_WARNING:  this._kWarning(dt);   break;
      case K_STATE_DIVE:     this._kDive(dt);      break;
      case K_STATE_DYING:    this._kDying(dt);     break;
    }

    if (this.y > 1700 || this.x < -400 || this.x > 2960) {
      this.alive = false;
    }
  }

  _kApproach(dt) {
    if (this.hoverX === this.x && this.hoverY === this.y) {
      this._pickHoverTarget();
    }
    const dx = this.hoverX - this.x;
    const dy = this.hoverY - this.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d < 30) {
      this._kState = K_STATE_HOVER;
      this._hoverTimer = 0;
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

  _kHover(dt) {
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

    this._hoverTimer += dt;
    if (this._hoverTimer >= this._hoverDuration) {
      this._kState = K_STATE_WARNING;
      this._warningTimer = 0;
      this._selectDiveTarget();
    }
  }

  _selectDiveTarget() {
    if (!this.getLaunchers) return;
    const alive = this.getLaunchers().filter(l => l.alive);
    if (alive.length === 0) {
      this._diveTarget = { x: this.x, y: 1300 };
      return;
    }
    let best = alive[0];
    let bestD2 = Infinity;
    for (const l of alive) {
      const dx = l.x - this.x;
      const dy = l.y - this.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = l; }
    }
    this._diveTarget = best;
  }

  _kWarning(dt) {
    // Slight drift hold
    this.x += this.vx * dt * 0.1;
    this.y += this.vy * dt * 0.1;
    this._warningTimer += dt;
    if (this._warningTimer >= WARNING_DURATION) {
      this._kState = K_STATE_DIVE;
    }
  }

  _kDive(dt) {
    if (!this._diveTarget) {
      this._kState = K_STATE_DYING;
      return;
    }
    const tx = this._diveTarget.x;
    const ty = this._diveTarget.y ?? 1240;
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d  = Math.sqrt(dx * dx + dy * dy);

    if (d < 5) {
      // Reached target — keep alive so collision section 3 can handle the impact.
      // Setting alive=false here would remove the entity before collision runs,
      // causing launchers to survive the hit. Stay at target position instead.
      this.x = tx;
      this.y = ty;
      this.vx = 0;
      this.vy = 0;
      return;
    }

    const nx = dx / d;
    const ny = dy / d;
    this.vx = lerp(this.vx, nx * DIVE_SPEED, 6.0 * dt);
    this.vy = lerp(this.vy, ny * DIVE_SPEED, 6.0 * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Tilt visual toward dive angle
    const diveAngle = Math.atan2(this.vy, this.vx) - Math.PI / 2;
    this.visualRotation = lerp(this.visualRotation, diveAngle * 0.5, 5 * dt);
  }

  _kDying(dt) {
    this.vy += 200 * dt;
    this.visualRotation += this._spiralRot * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (Math.random() < 0.6) {
      this._smoke.push({ x: this.x, y: this.y, r: randf(3, 7), a: 0.6 });
    }
  }

  /** Override draw from base to use our state. */
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
    this._drawExtras(ctx);

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
      ctx.strokeStyle = '#FF2010';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    }
  }

  _drawExtras(ctx) {
    // Explosive cylinder visible underneath
    ctx.fillStyle = '#CC3300';
    ctx.fillRect(-4, 4, 8, 6);
    ctx.fillStyle = '#FF6600';
    ctx.fillRect(-3, 4, 6, 2);

    // Dive red pulse
    if (this._kState === K_STATE_DIVE) {
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 20);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.shadowColor = '#FF2010';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#FF2010';
      ctx.beginPath(); ctx.arc(0, -2, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Warning flash ring
    if (this._kState === K_STATE_WARNING) {
      const flashAlpha = Math.abs(Math.sin(this._warningTimer * Math.PI * 8)) * 0.7;
      ctx.save();
      ctx.globalAlpha = flashAlpha;
      ctx.strokeStyle = '#FF2010';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
}
