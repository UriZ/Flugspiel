/**
 * Bike of Doom — a fast motorcycle missile launcher.
 * Extends TruckLauncher for terrain-following, dust, wheel rotation.
 * Spring-damper suspension for bounce physics.
 * Fires standard SAM missiles from a rear-mounted rack.
 * Key '7', arrow keys for movement.
 */

import { TruckLauncher } from './truck-launcher.js';
import { drawPoly } from './launcher.js';

// Movement constants (faster than truck's 120px/s)
const BIKE_MOVE_SPEED = 280;      // px/s
const BIKE_ACCELERATION = 600;    // px/s^2
const BIKE_DECELERATION = 400;    // px/s^2
const BIKE_MIN_X = 80;
const BIKE_MAX_X = 2480;

// Wheel rotation speed (smaller wheels spin faster per px of travel)
const BIKE_WHEEL_RAD_PER_PX = 1 / 8;

// Spring-damper constants for bounce physics
// Tuned for overdamped response — no oscillation on flat terrain.
// Critical damping: C = 2*sqrt(K*M). With K=280, M=1: critical C≈33.5.
// We use C=80 (overdamped) so the bike settles without oscillating.
const SPRING_K = 280;     // stiffness (was 2800 — 10x reduction eliminates constant oscillation)
const DAMPER_C = 80;      // damping (overdamped: C > 2*sqrt(K) ≈ 33.5)
const BIKE_MASS = 1.0;
const GRAVITY = 400;       // px/s^2
const REST_OFFSET = 0;     // bike sits at ground level (was -8, caused floor-clamp bounce loop)
const SPRING_DEADZONE = 3; // px — don't apply spring force inside this range (eliminates micro-bounce)
const MAX_SLOPE_ANGLE = 0.30; // radians (~17°) — clamp to prevent flipping upside-down

// Wheel contact point X offsets from bike center
const FRONT_WHEEL_X = 32;
const REAR_WHEEL_X = -28;

const FIRE_COOLDOWN = 1.2; // seconds

// Glow polygons (wider than bike body)
const GLOW1 = [-55, 10, 55, 10, 48, 20, -48, 20];
const GLOW2 = [-68, 8, 68, 8, 62, 24, -62, 24];

export class BikeLauncher extends TruckLauncher {
  constructor(x, y) {
    super(x, y);
    // Override type (super sets 'truck')
    this.type = 'bike';
    this.clickHalfW = 50;
    this.clickHalfH = 35;
    this.turretTipOffset = -45;

    // Override movement constants
    this._bikeMode = true; // flag to differentiate in update

    // Cooldown only — ammo is unlimited
    this._fireCooldownTimer = 0;
    this.fireCooldown = FIRE_COOLDOWN;

    // Spring-damper bounce state
    this._vy = 0;         // vertical velocity for bounce
    this._bounceOffset = 0; // extra Y offset from spring

    // Airborne tracking
    this._airborne = false;

    // Muzzle flash
    this._flashTimer = 0;
    this._flashDuration = 0.08;

    // Override base stats
    this._baseStats = {
      moveSpeed:    BIKE_MOVE_SPEED,
      missileSpeed: 1.0,
      fireCooldown: FIRE_COOLDOWN,
    };
    this.moveSpeed    = BIKE_MOVE_SPEED;
    this.missileSpeed = 1.0;

    // Override collision radius (smaller profile)
    this.collisionRadius = 35;

    // Smoke particles for exhaust
    /** @type {Array<{x:number,y:number,vx:number,vy:number,size:number,alpha:number,age:number,lifetime:number}>} */
    this._smokeParticles = [];
  }

  /**
   * Override: return world-space position of the rack mouth.
   * The rack mouth is drawn at local coords (-28, -44) in the bike's body space
   * (before slope rotation). The x sign flips with facingRight due to scale(-1,1).
   * @returns {{ x: number, y: number }}
   */
  getLaunchPosition() {
    const localX = this.facingRight ? 28 : -28;
    const localY = -44;
    const s = Math.sin(this._slopeAngle || 0);
    const c = Math.cos(this._slopeAngle || 0);
    return {
      x: this.x + localX * c - localY * s,
      y: this.y + localX * s + localY * c,
    };
  }

  /**
   * @returns {boolean} true if the bike can fire (cooldown only — ammo is unlimited)
   */
  canFire() {
    return this._fireCooldownTimer <= 0;
  }

  /**
   * Called by game.js after a missile is fired.
   */
  onFired() {
    this._fireCooldownTimer = this.fireCooldown;
    this._flashTimer = this._flashDuration;
  }

  /** @override Stop moving when destroyed */
  destroy() {
    super.destroy();
    this.currentSpeed = 0;
    this._vy = 0;
  }

  /** @param {number} dt */
  update(dt) {
    // Handle cooldown timer
    if (this._fireCooldownTimer > 0) {
      this._fireCooldownTimer = Math.max(0, this._fireCooldownTimer - dt);
    }

    // Handle flash timer
    if (this._flashTimer > 0) {
      this._flashTimer = Math.max(0, this._flashTimer - dt);
    }

    // Do NOT call super.update(dt) — we replicate the needed logic
    // to avoid the turret tracking and truck-specific speeds.

    // ── Base class update (selection glow only — skip turret tracking) ──
    // Replicate the glow pulse from Launcher.update()
    if (this.isSelected) {
      this._glowTime = (this._glowTime || 0) + dt;
      this._glowAlpha = 0.375 + 0.125 * Math.sin(this._glowTime * Math.PI / 0.6);
    }

    // Fixed turret angle (rack is fixed at rear, slightly backward)
    this.turretRotation = this.facingRight ? 0.4 : -0.4;

    // ── Horizontal movement ──
    if (this._moveDir !== 0) {
      this.facingRight = this._moveDir > 0;
      this.currentSpeed = Math.min(this.moveSpeed, this.currentSpeed + BIKE_ACCELERATION * dt);

      const move = this.currentSpeed * this._moveDir * dt;
      this.x = Math.max(BIKE_MIN_X, Math.min(BIKE_MAX_X, this.x + move));
      this.wheelAngle += move * BIKE_WHEEL_RAD_PER_PX;
    } else {
      if (this.currentSpeed > 0) {
        this.currentSpeed = Math.max(0, this.currentSpeed - BIKE_DECELERATION * dt);
        const move = this.currentSpeed * (this.facingRight ? 1 : -1) * dt;
        this.x = Math.max(BIKE_MIN_X, Math.min(BIKE_MAX_X, this.x + move));
        this.wheelAngle += move * BIKE_WHEEL_RAD_PER_PX;
      }
    }

    // ── Spring-damper terrain following ──
    if (this.terrain) {
      const dir = this.facingRight ? 1 : -1;
      const groundFront = this.terrain.getHeightAt(this.x + FRONT_WHEEL_X * dir);
      const groundRear  = this.terrain.getHeightAt(this.x + REAR_WHEEL_X * dir);
      const groundAvg = (groundFront + groundRear) / 2;
      const targetY = groundAvg + REST_OFFSET;

      // Displacement from rest position
      const displacement = targetY - this.y;

      if (Math.abs(displacement) <= SPRING_DEADZONE && Math.abs(this._vy) < 20) {
        // Within deadzone on flat/near-flat ground — snap directly to ground and kill velocity.
        // This prevents micro-oscillation on flat terrain.
        this.y = targetY;
        this._vy = 0;
        this._airborne = false;
      } else {
        // Apply spring-damper physics only when meaningfully displaced or airborne.
        // Spring force toward target (deadzone stripped — full force outside deadzone)
        const springF = SPRING_K * displacement;
        // Damper force opposing velocity
        const damperF = -DAMPER_C * this._vy;
        // Net vertical acceleration (gravity pulls down, spring+damper correct position)
        const ay = GRAVITY + (springF + damperF) / BIKE_MASS;

        this._vy += ay * dt;
        this.y += this._vy * dt;

        // Hard floor clamp — don't clip through terrain
        if (this.y >= groundAvg) {
          this.y = groundAvg;
          // Absorb downward velocity (inelastic landing — no rebound)
          this._vy = 0;
          this._airborne = false;
        } else {
          this._airborne = this.y < groundAvg - 4;
        }
      }

      // Slope tilt from two wheel contact points.
      // Clamped to ±MAX_SLOPE_ANGLE to prevent the bike from flipping upside-down.
      const rawSlope = Math.atan2(groundFront - groundRear, (FRONT_WHEEL_X - REAR_WHEEL_X) * dir);
      const clampedSlope = Math.max(-MAX_SLOPE_ANGLE, Math.min(MAX_SLOPE_ANGLE, rawSlope));
      this._slopeAngle += (clampedSlope - this._slopeAngle) * Math.min(1, 8 * dt);
    }

    // ── Dust particles (only when not airborne) ──
    if (this.currentSpeed > 15 && !this._airborne) {
      // Rear wheel dust
      if (this._dustParticles.length < 30) {
        const dir = this.facingRight ? 1 : -1;
        const rearX = this.x + REAR_WHEEL_X * dir;
        const groundY = this.terrain ? this.terrain.getHeightAt(rearX) : this.y;
        this._dustParticles.push({
          x: rearX + (Math.random() - 0.5) * 6,
          y: groundY,
          r: 4 + Math.random() * 4,
          alpha: 0.55 + Math.random() * 0.2,
          vr: 6 + Math.random() * 6,
        });
        // Front wheel dust (lighter)
        const frontX = this.x + FRONT_WHEEL_X * dir;
        const groundFY = this.terrain ? this.terrain.getHeightAt(frontX) : this.y;
        if (this._dustParticles.length < 30) {
          this._dustParticles.push({
            x: frontX + (Math.random() - 0.5) * 4,
            y: groundFY,
            r: 3 + Math.random() * 2,
            alpha: 0.35 + Math.random() * 0.15,
            vr: 5 + Math.random() * 5,
          });
        }
      }
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

    // ── Exhaust smoke (when moving) ──
    if (this.currentSpeed > 20) {
      const dir = this.facingRight ? 1 : -1;
      // Exhaust pipe tip — approximately behind and below the rider
      const pipeX = this.x + (-18) * dir;
      const pipeY = this.y - 12;
      if (this._smokeParticles.length < 20) {
        this._smokeParticles.push({
          x: pipeX,
          y: pipeY,
          vx: -dir * (6 + Math.random() * 10),
          vy: -(15 + Math.random() * 20),
          size: 2 + Math.random() * 3,
          alpha: 0.3 + Math.random() * 0.15,
          age: 0,
          lifetime: 0.5 + Math.random() * 0.4,
        });
      }
    }

    // Age smoke particles
    for (let i = this._smokeParticles.length - 1; i >= 0; i--) {
      const p = this._smokeParticles[i];
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += 3 * dt;
      p.alpha -= dt / p.lifetime;
      if (p.age >= p.lifetime) {
        this._smokeParticles.splice(i, 1);
      }
    }
  }

  draw(ctx) {
    const worldX = this.x;
    const worldY = this.y;

    // ── Layer 1: Speed lines (world space, drawn behind everything) ──
    if (this.currentSpeed > 80) {
      const lineCount = 4 + Math.floor((this.currentSpeed - 80) / 20);
      const dir = this.facingRight ? 1 : -1;
      const tailX = worldX + 50 * dir;
      ctx.save();
      for (let i = 0; i < Math.min(lineCount, 6); i++) {
        const ly = worldY - 20 + i * 7;
        const lineLen = 20 + Math.random() * 30;
        const lineAlpha = 0.1 + (this.currentSpeed - 80) / 400;
        ctx.strokeStyle = `rgba(255,255,255,${lineAlpha.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tailX, ly);
        ctx.lineTo(tailX + (-dir) * lineLen, ly);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Layer 2: Exhaust smoke particles ──
    ctx.save();
    for (const p of this._smokeParticles) {
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = 'rgba(80,80,90,1)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ── Layer 3: Dust particles ──
    for (const p of this._dustParticles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = 'rgba(210,190,140,1)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ── Layers 4–19: Bike body in local space ──
    // Bike body is drawn facing RIGHT by default (positive X = forward).
    // Flip horizontally only when facing left.
    ctx.save();
    ctx.translate(worldX, worldY);
    ctx.translate(this._hitShakeX || 0, this._hitShakeY || 0);
    ctx.rotate(this._slopeAngle);
    if (!this.facingRight) {
      ctx.scale(-1, 1);
    }

    // ── Layer 4: Selection glow ──
    if (this.isSelected) {
      ctx.shadowColor = '#FF4400';
      ctx.shadowBlur = 20;
      drawPoly(ctx, GLOW2, `rgba(255,80,0,${(this._glowAlpha * 0.25).toFixed(3)})`);
      drawPoly(ctx, GLOW1, `rgba(255,80,0,${(this._glowAlpha * 0.55).toFixed(3)})`);
      ctx.shadowBlur = 0;
    }

    // ── Layer 5: Front wheel (positive X = forward by default) ──
    this._drawWheel(ctx, 28, 0, 12);

    // ── Layer 6: Swingarm ──
    ctx.save();
    ctx.strokeStyle = '#2A3020';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(5, -5);
    ctx.lineTo(28, 0);
    ctx.stroke();
    ctx.restore();

    // ── Layer 7: Rear shock absorber ──
    ctx.save();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(8, -15);
    ctx.lineTo(22, -4);
    ctx.stroke();
    // Spring coils — two short lines
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(12, -12); ctx.lineTo(14, -10); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(16, -9); ctx.lineTo(18, -7); ctx.stroke();
    ctx.restore();

    // ── Layer 8: Main frame spine ──
    ctx.save();
    const frameGrad = ctx.createLinearGradient(-30, -20, 20, 0);
    frameGrad.addColorStop(0, '#3A4428');
    frameGrad.addColorStop(1, '#2A3018');
    ctx.fillStyle = frameGrad;
    // Spine bar from rear axle to head tube
    ctx.beginPath();
    ctx.moveTo(-32, -4);
    ctx.lineTo(5, -4);
    ctx.lineTo(12, -22);
    ctx.lineTo(-5, -28);
    ctx.lineTo(-30, -14);
    ctx.closePath();
    ctx.fill();
    // Belly pan
    ctx.fillStyle = '#2A3018';
    ctx.beginPath();
    ctx.moveTo(-28, 0);
    ctx.lineTo(26, 0);
    ctx.lineTo(26, 4);
    ctx.lineTo(-28, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── Layer 9: Engine block ──
    ctx.save();
    ctx.fillStyle = '#1E2228';
    ctx.fillRect(-18, -14, 26, 16);
    // Cooling fins
    ctx.strokeStyle = '#333840';
    ctx.lineWidth = 1;
    for (let f = 0; f < 4; f++) {
      const fy = -12 + f * 4;
      ctx.beginPath();
      ctx.moveTo(-18, fy); ctx.lineTo(8, fy); ctx.stroke();
    }
    // Oil pan
    ctx.fillStyle = '#161820';
    ctx.fillRect(-14, 2, 20, 5);
    ctx.restore();

    // ── Layer 10: Fuel tank ──
    ctx.save();
    ctx.fillStyle = '#3A4828';
    ctx.beginPath();
    ctx.ellipse(-8, -28, 14, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Highlight stripe
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.ellipse(-8, -30, 8, 3, 0, 0, Math.PI);
    ctx.fill();
    ctx.restore();

    // ── Layer 11: Rear missile rack ──
    ctx.save();
    ctx.translate(-28, -16);
    ctx.rotate(-0.26); // ~-15 degrees
    // Rack frame — dark olive/green
    ctx.fillStyle = '#2A2C34';
    ctx.fillRect(-5, -28, 10, 28);
    // Rack side panels
    ctx.fillStyle = '#22242C';
    ctx.fillRect(-7, -28, 2, 28);
    ctx.fillRect(5, -28, 2, 28);
    ctx.fillRect(-7, -28, 14, 2);
    // Missile visible in rack
    ctx.fillStyle = '#993322';
    ctx.fillRect(-3, -26, 6, 22);
    // Missile tip
    ctx.fillStyle = '#EEEADE';
    ctx.beginPath();
    ctx.moveTo(-3, -26); ctx.lineTo(0, -32); ctx.lineTo(3, -26);
    ctx.closePath(); ctx.fill();
    // Missile band
    ctx.fillStyle = '#E8D810';
    ctx.fillRect(-3, -18, 6, 3);
    ctx.restore();

    // ── Layer 12: Exhaust pipes ──
    ctx.save();
    ctx.strokeStyle = '#2A2820';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-10, -5);
    ctx.lineTo(-18, 2);
    ctx.lineTo(-22, 6);
    ctx.stroke();
    // Exhaust tip
    ctx.fillStyle = '#1C1A18';
    ctx.beginPath();
    ctx.arc(-22, 6, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── Layer 13: Front fork ──
    ctx.save();
    ctx.strokeStyle = '#3A3E3A';
    ctx.lineWidth = 3;
    // Left fork tube
    ctx.beginPath();
    ctx.moveTo(10, -22);
    ctx.lineTo(28, 0);
    ctx.stroke();
    // Right fork tube (slight offset)
    ctx.beginPath();
    ctx.moveTo(14, -22);
    ctx.lineTo(32, 0);
    ctx.stroke();
    // Fork brace
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, -16); ctx.lineTo(28, -8); ctx.stroke();
    ctx.restore();

    // ── Layer 14: Rear wheel (negative X = rear by default) ──
    this._drawWheel(ctx, -32, 0, 11);

    // ── Layer 15: Seat pad ──
    ctx.save();
    ctx.fillStyle = '#111418';
    ctx.beginPath();
    ctx.ellipse(-10, -32, 12, 4, -0.15, 0, Math.PI * 2);
    ctx.fill();
    // Seat highlight
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.ellipse(-10, -33, 8, 2, -0.15, 0, Math.PI);
    ctx.fill();
    ctx.restore();

    // ── Rider ── (slight counter-bob: rider moves less than bike body on bumps)
    const riderBobOffset = 0; // Could add this._bounceOffset * -0.4 for more realism

    ctx.save();
    ctx.translate(0, riderBobOffset);

    // ── Layer 16: Rider legs ──
    ctx.save();
    ctx.fillStyle = '#1A1C20';
    // Left leg
    ctx.beginPath();
    ctx.moveTo(-16, -24);
    ctx.lineTo(-18, -8);
    ctx.lineTo(-12, -8);
    ctx.lineTo(-10, -24);
    ctx.closePath(); ctx.fill();
    // Right leg (knee up, tucked in for speed)
    ctx.beginPath();
    ctx.moveTo(-6, -24);
    ctx.lineTo(-4, -8);
    ctx.lineTo(2, -8);
    ctx.lineTo(0, -24);
    ctx.closePath(); ctx.fill();
    // Boots
    ctx.fillStyle = '#0A0A0C';
    ctx.fillRect(-18, -8, 8, 4);
    ctx.fillRect(-4, -8, 7, 4);
    ctx.restore();

    // ── Layer 17: Rider torso ──
    ctx.save();
    const torsoGrad = ctx.createLinearGradient(-14, -50, 4, -24);
    torsoGrad.addColorStop(0, '#252830');
    torsoGrad.addColorStop(1, '#1A1C20');
    ctx.fillStyle = torsoGrad;
    ctx.beginPath();
    ctx.moveTo(-14, -24);
    ctx.lineTo(2, -24);
    ctx.lineTo(4, -50);
    ctx.lineTo(-12, -50);
    ctx.closePath();
    ctx.fill();
    // Jacket detail — diagonal stripe
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-12, -28); ctx.lineTo(0, -46); ctx.stroke();
    ctx.restore();

    // ── Layer 18: Rider arms + handlebars ──
    ctx.save();
    // Arms — leaning forward
    ctx.strokeStyle = '#1A1C20';
    ctx.lineWidth = 5;
    // Left arm
    ctx.beginPath();
    ctx.moveTo(-10, -44);
    ctx.lineTo(12, -30);
    ctx.stroke();
    // Right arm
    ctx.beginPath();
    ctx.moveTo(-4, -44);
    ctx.lineTo(18, -32);
    ctx.stroke();
    // Handlebars — horizontal bar at front
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, -34); ctx.lineTo(22, -28); ctx.stroke();
    ctx.restore();

    // ── Layer 19: Rider helmet ──
    ctx.save();
    // Helmet shell
    ctx.fillStyle = '#1A2230';
    ctx.beginPath();
    ctx.arc(-4, -54, 10, 0, Math.PI * 2);
    ctx.fill();
    // Helmet highlight
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(-6, -57, 5, Math.PI * 1.0, Math.PI * 1.7);
    ctx.fill();
    // Visor band — green tinted
    const visorAlpha = this.currentSpeed > 60 ? 0.9 : 0.75;
    ctx.fillStyle = `rgba(30,180,80,${visorAlpha})`;
    ctx.beginPath();
    ctx.arc(-4, -54, 9, Math.PI * 1.15, Math.PI * 1.85);
    ctx.fill();
    // Visor glint
    ctx.fillStyle = 'rgba(200,255,230,0.35)';
    ctx.beginPath();
    ctx.arc(-6, -56, 4, Math.PI * 1.2, Math.PI * 1.55);
    ctx.fill();
    // Speed visor glow when moving fast
    if (this.currentSpeed > 60) {
      ctx.shadowColor = 'rgba(0,200,100,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = 'rgba(0,200,100,0.2)';
      ctx.beginPath();
      ctx.arc(-4, -54, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    ctx.restore(); // rider counter-bob

    // ── Layer 20: Muzzle flash (when just fired) ──
    if (this._flashTimer > 0) {
      const flashAlpha = this._flashTimer / this._flashDuration;
      // Rack tip is at approximately (-28, -16) rotated by -15 degrees, tip at top
      // Transform to approximate world-local position
      ctx.save();
      ctx.translate(-28, -44); // approximate rack mouth
      const rackMouthX = 0, rackMouthY = 0;
      // Outer cone
      ctx.beginPath();
      ctx.moveTo(rackMouthX - 8, rackMouthY);
      ctx.lineTo(rackMouthX, rackMouthY - 28);
      ctx.lineTo(rackMouthX + 8, rackMouthY);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,200,80,${flashAlpha.toFixed(3)})`;
      ctx.fill();
      // White core
      ctx.beginPath();
      ctx.moveTo(rackMouthX - 4, rackMouthY);
      ctx.lineTo(rackMouthX, rackMouthY - 18);
      ctx.lineTo(rackMouthX + 4, rackMouthY);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,255,255,${(flashAlpha * 0.8).toFixed(3)})`;
      ctx.fill();
      // Backblast glow
      ctx.beginPath();
      ctx.arc(rackMouthX, rackMouthY + 6, 12, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,140,0,${(flashAlpha * 0.3).toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    }

    // Damage overlay — full bike body bounds (helmet top to ground)
    this._drawDamageOverlay(ctx, 55, 4, -64);

    ctx.restore(); // entity transform
  }

  /**
   * Draw a motorcycle wheel with knobby tread and hub details.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx — center X in local space
   * @param {number} cy — center Y in local space
   * @param {number} r — wheel radius
   */
  _drawWheel(ctx, cx, cy, r) {
    ctx.save();
    ctx.translate(cx, cy);

    // Outer tire — dark with knobby texture
    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Knobby tread marks
    ctx.strokeStyle = '#2A2A2A';
    ctx.lineWidth = 1.5;
    const knobs = 8;
    for (let k = 0; k < knobs; k++) {
      const angle = (k / knobs) * Math.PI * 2 + this.wheelAngle;
      const innerR = r - 2;
      const outerR = r;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * innerR, Math.sin(angle) * innerR);
      ctx.lineTo(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
      ctx.stroke();
    }

    // Inner hub
    const hubGrad = ctx.createRadialGradient(-r * 0.15, -r * 0.15, 1, 0, 0, r * 0.6);
    hubGrad.addColorStop(0, '#666666');
    hubGrad.addColorStop(1, '#222222');
    ctx.fillStyle = hubGrad;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
    ctx.fill();

    // Spokes — animated rotation
    ctx.save();
    ctx.rotate(this.wheelAngle);
    ctx.strokeStyle = 'rgba(160,160,160,0.55)';
    ctx.lineWidth = 1;
    for (let s = 0; s < 5; s++) {
      const angle = (s / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * 2, Math.sin(angle) * 2);
      ctx.lineTo(Math.cos(angle) * (r * 0.55), Math.sin(angle) * (r * 0.55));
      ctx.stroke();
    }
    ctx.restore();

    // Hub cap
    ctx.fillStyle = '#888888';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#333333';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.08, 0, Math.PI * 2);
    ctx.fill();

    // Chrome arch highlight
    ctx.strokeStyle = 'rgba(200,200,200,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(-r * 0.15, -r * 0.25, r * 0.7, Math.PI * 1.1, Math.PI * 1.8);
    ctx.stroke();

    ctx.restore();
  }
}
