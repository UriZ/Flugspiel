/**
 * Base Launcher class — translated from launcher.gd.
 * Handles turret tracking, selection glow pulse, click detection, launch position.
 * Subclasses provide polygon data and override draw().
 */

import { Entity } from './entity.js';
import { TAU, lerpAngle, clamp } from '../utils.js';

/**
 * Draw a polygon from a flat coordinate array [x0,y0, x1,y1, ...].
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} coords — flat [x,y,...] pairs
 * @param {string} color — CSS fill color
 */
export function drawPoly(ctx, coords, color) {
  ctx.beginPath();
  for (let i = 0; i < coords.length; i += 2) {
    if (i === 0) ctx.moveTo(coords[i], coords[i + 1]);
    else ctx.lineTo(coords[i], coords[i + 1]);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export class Launcher extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   * @param {'sam'|'truck'|'heatseeker'|'vulkan'} type
   */
  constructor(x, y, type) {
    super(x, y);
    this.type = type;
    this.isSelected = false;
    this.turretRotation = 0;
    this.groups.add('launchers');

    // Selection glow animation
    this._glowAlpha = 0.35;
    this._glowDir = -1; // pulsing direction
    this._glowTime = 0;

    // Click detection bounds (half-width, half-height from center)
    this.clickHalfW = 40;
    this.clickHalfH = 50;

    // Turret tip offset for launch position (distance from origin along turret axis)
    this.turretTipOffset = -62;

    // Mouse position — set by game each frame
    this.mouseX = 0;
    this.mouseY = 0;

    /** @type {function|null} Called when launcher is clicked */
    this.onClick = null;

    // ── HP system ──────────────────────────────────────────────────────────
    /** Current hit points [0..maxHp] */
    this.hp    = 1.0;
    /** Maximum hit points */
    this.maxHp = 1.0;

    // Hit-flash visual (white overlay fades over 0.15s after taking damage)
    this._hitFlash    = 0.0; // remaining flash time (seconds)
    this._hitFlashMax = 0.15;

    // Body shake after hit (decays exponentially per frame)
    this._hitShakeAmp = 0.0; // current amplitude (px)
    this._hitShakeX   = 0.0; // current shake offset
    this._hitShakeY   = 0.0;

    // Between-wave HP recovery
    this._recovering    = false;
    this._recoverRate   = 0.15; // HP/s

    // Damage particle accumulators (spark and smoke wisps)
    this._sparkTimer    = 0.0;
    this._smokeTimer    = 0.0;
    /** @type {Array<{x:number, y:number, vx:number, vy:number, life:number, maxLife:number, r:number}>} */
    this._damageParticles = [];
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    // Turret tracking toward mouse
    const dx = this.mouseX - this.x;
    const dy = this.mouseY - this.y;
    let targetAngle = Math.atan2(dy, dx) + Math.PI / 2;
    // Clamp to ±80 degrees from vertical
    const limit = 80 * Math.PI / 180;
    targetAngle = clamp(targetAngle, -limit, limit);
    this.turretRotation = lerpAngle(this.turretRotation, targetAngle, 10.0 * dt);

    // Selection glow pulse (0.25 ↔ 0.5 over 0.6s each way)
    if (this.isSelected) {
      this._glowTime += dt;
      // Sine-based pulse between 0.25 and 0.5
      this._glowAlpha = 0.375 + 0.125 * Math.sin(this._glowTime * Math.PI / 0.6);
    }

    // ── HP visuals ──────────────────────────────────────────────────────────

    // Tick hit-flash timer
    if (this._hitFlash > 0) {
      this._hitFlash = Math.max(0, this._hitFlash - dt);
    }

    // Decay hit-shake
    if (this._hitShakeAmp > 0.1) {
      this._hitShakeAmp *= Math.pow(0.01, dt); // fast exponential decay (~100x per second)
      this._hitShakeX = (Math.random() - 0.5) * 2 * this._hitShakeAmp;
      this._hitShakeY = (Math.random() - 0.5) * 2 * this._hitShakeAmp;
    } else {
      this._hitShakeAmp = 0;
      this._hitShakeX = 0;
      this._hitShakeY = 0;
    }

    // Between-wave HP recovery
    if (this._recovering && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + this._recoverRate * dt);
    }

    // Damage particles — only when damaged
    if (this.hp < this.maxHp && this.hp > 0) {
      this._updateDamageParticles(dt);
    }
  }

  // ── HP system methods ────────────────────────────────────────────────────

  /**
   * Apply damage to this launcher.
   * Triggers hit-flash and body-shake visuals. Kills launcher when HP <= 0.
   * @param {number} amount  damage amount (0..1 for partial; 1.0 = instant kill)
   * @returns {boolean}  true if the launcher was killed by this hit
   */
  takeDamage(amount) {
    if (!this.alive) return false;
    if (amount <= 0) return false;

    this.hp = Math.max(0, this.hp - amount);

    // Hit flash
    this._hitFlash    = this._hitFlashMax;

    // Shake amplitude proportional to damage (clamp so partial hits still feel impactful)
    this._hitShakeAmp = Math.min(8, 8 * amount + this._hitShakeAmp);

    if (this.hp <= 0) {
      this.destroy();
      return true;
    }
    return false;
  }

  /**
   * Restore HP, clamped to maxHp.
   * @param {number} amount
   */
  healHp(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  // ── Damage particle internal helpers ─────────────────────────────────────

  /**
   * Spawn and update damage effect particles (sparks and smoke wisps).
   * @param {number} dt
   */
  _updateDamageParticles(dt) {
    const hpFrac = this.hp / this.maxHp;

    // Sparks appear when HP < 0.7; more frequent as HP drops
    if (hpFrac < 0.7) {
      const sparkRate = (0.7 - hpFrac) / 0.7; // 0 at full, 1 at 0 HP
      this._sparkTimer -= dt;
      if (this._sparkTimer <= 0) {
        this._sparkTimer = 0.08 - 0.06 * sparkRate; // 80ms down to 20ms between sparks
        const offX = (Math.random() - 0.5) * 40;
        const offY = -10 - Math.random() * 20;
        this._damageParticles.push({
          type: 'spark',
          x: offX,
          y: offY,
          vx: (Math.random() - 0.5) * 80,
          vy: -60 - Math.random() * 80,
          life: 0.25 + Math.random() * 0.2,
          maxLife: 0.45,
          r: 2,
        });
      }
    }

    // Smoke wisps appear when HP < 0.4
    if (hpFrac < 0.4) {
      const smokeRate = (0.4 - hpFrac) / 0.4;
      this._smokeTimer -= dt;
      if (this._smokeTimer <= 0) {
        this._smokeTimer = 0.15 - 0.1 * smokeRate;
        const offX = (Math.random() - 0.5) * 30;
        const offY = -5 - Math.random() * 15;
        this._damageParticles.push({
          type: 'smoke',
          x: offX,
          y: offY,
          vx: (Math.random() - 0.5) * 15,
          vy: -20 - Math.random() * 25,
          life: 0.8 + Math.random() * 0.4,
          maxLife: 1.2,
          r: 6 + Math.random() * 8,
        });
      }
    }

    // Advance all particles
    for (let i = this._damageParticles.length - 1; i >= 0; i--) {
      const p = this._damageParticles[i];
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        this._damageParticles.splice(i, 1);
      }
    }
  }

  /**
   * Draw damage-state visual effects on top of the launcher body.
   * Subclasses should call this at the END of their draw() after ctx.translate(x, y),
   * so particles are drawn in launcher-local space.
   *
   * Renders:
   *  - Smoke wisps and spark particles (offset from origin)
   *  - White hit-flash overlay (covers the local bounding box)
   *  - Red body tint when HP < 0.4 (blended semi-transparent rect)
   *
   * @param {CanvasRenderingContext2D} ctx  — canvas already translated to (this.x, this.y)
   * @param {number} halfW  — half-width of the launcher body for overlay sizing
   * @param {number} halfH  — half-height of the launcher body for overlay sizing
   * @param {number} [topY] — top Y of body bounding box in local space (default -halfH)
   */
  _drawDamageOverlay(ctx, halfW, halfH, topY) {
    if (!this.alive) return;
    const hpFrac = this.hp / this.maxHp;
    const bodyTop = topY !== undefined ? topY : -halfH;

    // Damage particles (sparks + smoke)
    for (const p of this._damageParticles) {
      const t = 1 - p.life / p.maxLife; // 0 = fresh, 1 = dead
      const alpha = p.life / p.maxLife; // fade out

      if (p.type === 'spark') {
        // Bright yellow-white spark
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = t < 0.3 ? '#FFFFFF' : '#FFDD44';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        // Dark grey smoke wisp — grows as it rises
        const radius = p.r * (1 + t * 1.5);
        ctx.save();
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = '#333333';
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // Red tint when critically damaged (HP < 0.4)
    if (hpFrac < 0.4) {
      const tintAlpha = (0.4 - hpFrac) / 0.4 * 0.25; // up to 25% red overlay
      ctx.save();
      ctx.globalAlpha = tintAlpha;
      ctx.fillStyle = '#FF2200';
      ctx.fillRect(-halfW, bodyTop, halfW * 2, halfH + Math.abs(bodyTop));
      ctx.restore();
    }

    // White hit-flash overlay
    if (this._hitFlash > 0) {
      const flashAlpha = (this._hitFlash / this._hitFlashMax) * 0.65;
      ctx.save();
      ctx.globalAlpha = flashAlpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-halfW, bodyTop, halfW * 2, halfH + Math.abs(bodyTop));
      ctx.restore();
    }
  }

  /**
   * Recompute all instance stats from _baseStats.
   * Subclasses set this._baseStats in their constructor.
   * Call this before applying upgrade effects so a clean baseline is ensured.
   */
  resetToBaseStats() {
    if (!this._baseStats) return;
    for (const [stat, value] of Object.entries(this._baseStats)) {
      this[stat] = value;
    }
  }

  /**
   * @param {boolean} selected
   */
  setSelected(selected) {
    this.isSelected = selected;
    this._glowTime = 0;
    this._glowAlpha = 0.35;
  }

  /**
   * Get the tip position of the turret for spawning projectiles.
   * @returns {{ x: number, y: number }}
   */
  getLaunchPosition() {
    // Godot: Vector2(0, turretTipOffset).rotated(turretRotation)
    // Standard 2D rotation of (0, offset):
    //   x' = -offset * sin(r)
    //   y' =  offset * cos(r)
    const r = this.turretRotation;
    const offset = this.turretTipOffset; // negative value (e.g. -62)
    return {
      x: this.x - offset * Math.sin(r),
      y: this.y + offset * Math.cos(r),
    };
  }

  /**
   * Check if a point (logical coordinates) is within click bounds.
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  containsPoint(px, py) {
    return Math.abs(px - this.x) < this.clickHalfW &&
           Math.abs(py - this.y) < this.clickHalfH;
  }

  /**
   * Draw selection glow polygons. Call from subclass draw() when selected.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]} glow1 — inner glow polygon coords
   * @param {string} glow1Color — base color without alpha
   * @param {number[]} glow2 — outer glow polygon coords
   * @param {string} glow2Color — base color without alpha
   */
  _drawSelectionGlow(ctx, glow1, glow1Color, glow2, glow2Color) {
    if (!this.isSelected) return;
    // Outer glow (behind, lower alpha)
    drawPoly(ctx, glow2, glow2Color.replace(/[\d.]+\)$/, `${(this._glowAlpha * 0.43).toFixed(3)})`));
    // Inner glow
    drawPoly(ctx, glow1, glow1Color.replace(/[\d.]+\)$/, `${this._glowAlpha.toFixed(3)})`));
  }
}
