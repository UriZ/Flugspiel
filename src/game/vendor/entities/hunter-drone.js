/**
 * HunterDrone — autonomous player-launched combat drone.
 * 5-state AI: LAUNCH → SEARCH → PURSUE → ATTACK → EXPIRE
 * Group: player_missiles (collision with enemies handled in collision.js)
 *
 * Visual: Switchblade 300-inspired tube fuselage with folding swept-delta wings.
 * Wings deploy via easeOutBack animation during LAUNCH phase (0.4s).
 */

import { Entity } from './entity.js';
import { lerpAngle, randf, TAU } from '../utils.js';

// ── State constants ───────────────────────────────────────────────────────────
const STATE_LAUNCH  = 0;
const STATE_SEARCH  = 1;
const STATE_PURSUE  = 2;
const STATE_ATTACK  = 3;
const STATE_EXPIRE  = 4;

// ── Speed constants (px/s) ────────────────────────────────────────────────────
const SPEED_SEARCH  = 350;
const SPEED_PURSUE  = 500;
const SPEED_ATTACK  = 650;

// ── Config ────────────────────────────────────────────────────────────────────
const LAUNCH_DURATION  = 0.6;   // seconds ascending vertically
const MAX_LIFETIME     = 12.0;  // total lifetime before expiry
const MAX_KILLS        = 3;     // kills before expiry
const TURN_RATE        = 3.0;   // radians/s
const ATTACK_RANGE     = 400;   // px — switch PURSUE → ATTACK
const SEARCH_ORBIT_R   = 140;   // radius of patrol orbit in SEARCH
const EXPIRE_FADE      = 1.5;   // seconds to fade during EXPIRE

// ── Wing animation ────────────────────────────────────────────────────────────
const WING_DEPLOY_DURATION = 0.4;  // seconds to fully deploy wings
const MAX_WING_ANGLE = 0.663;      // 38 degrees in radians

// easeOutBack constants
const _C1 = 1.70158;
const _C3 = _C1 + 1;

/**
 * easeOutBack: overshoots then settles. t in [0,1] → value in [0,~1.07]
 * @param {number} t
 * @returns {number}
 */
function easeOutBack(t) {
  const tc = t - 1;
  return 1 + _C3 * tc * tc * tc + _C1 * tc * tc;
}

// ── Target priority weights ───────────────────────────────────────────────────
const PRIORITY = {
  Nuke:         10,
  SuicideDrone: 8,
  SuperMissile: 6,
  MissileFragment: 6,
  Drone:        5,
  EnemyMissile: 3,
};

function targetPriority(e) {
  return PRIORITY[e.constructor.name] || 3;
}

// ── Fuselage geometry (nose pointing right = 0°) ──────────────────────────────
// Switchblade 300-inspired tube: narrow body, blunt nose
const FUSELAGE_PTS = [-20,-3, 10,-3, 22,-2, 28,0, 22,2, 10,3, -20,3];

// Sensor dome (nose)
const DOME_X = 28;
const DOME_R = 4;

// Kill counter LED positions (3 lights on fuselage top)
const LEDS = [[-12, -5], [-2, -5], [8, -5]];

export class HunterDrone extends Entity {
  /**
   * @param {number} x  — launch x (pad center)
   * @param {number} y  — launch y (pad surface)
   */
  constructor(x, y) {
    super(x, y);
    this.collisionRadius = 12;
    this.groups.add('player_missiles');

    this.state = STATE_LAUNCH;
    this.stateTimer = 0;
    this.lifetime = 0;
    this.killsRemaining = MAX_KILLS;

    // Movement
    this.vx = 0;
    this.vy = -SPEED_SEARCH; // launch upward
    this.heading = -Math.PI / 2; // pointing up

    // Search orbit
    this._orbitAngle = Math.random() * TAU;
    this._orbitCx = x;
    this._orbitCy = y - 180; // patrol center above pad

    // Target
    /** @type {Entity|null} */
    this.target = null;

    /** @type {function|null} Returns array of enemy entities in 'enemy_missiles' group */
    this.getEnemies = null;

    /** @type {function|null} Called when drone enters EXPIRE state (1 kill cycle done) */
    this.onExpire = null;

    // Visual
    this._scanRotation = 0;
    this._expireAlpha  = 1.0;

    // Engine glow pulse
    this._glowPhase = Math.random() * TAU;

    // Wing deployment animation (0→1 over WING_DEPLOY_DURATION)
    this._wingDeployT = 0;
    this._wingsDeployed = false;
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * Called by collision.js when the drone hits a normal (non-lethal) enemy.
   * Drone survives and decrements its kill counter.
   */
  registerKill() {
    this.killsRemaining--;
    if (this.killsRemaining <= 0) {
      this._transitionTo(STATE_EXPIRE);
    } else {
      // Re-enter search to pick next target
      this.target = null;
      this._transitionTo(STATE_SEARCH);
    }
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt) {
    this.lifetime += dt;
    this.stateTimer += dt;
    this._glowPhase += dt * 5.0;
    this._scanRotation += dt * 2.0;

    if (this.state !== STATE_EXPIRE && this.lifetime >= MAX_LIFETIME) {
      this._transitionTo(STATE_EXPIRE);
    }

    switch (this.state) {
      case STATE_LAUNCH:  this._updateLaunch(dt);  break;
      case STATE_SEARCH:  this._updateSearch(dt);  break;
      case STATE_PURSUE:  this._updatePursue(dt);  break;
      case STATE_ATTACK:  this._updateAttack(dt);  break;
      case STATE_EXPIRE:  this._updateExpire(dt);  break;
    }
  }

  _transitionTo(newState) {
    this.state = newState;
    this.stateTimer = 0;
    if (newState === STATE_SEARCH) {
      // Reset orbit center to current X but clamped to visible altitude
      this._orbitCx = this.x;
      this._orbitCy = Math.max(400, Math.min(900, this.y));
    }
    if (newState === STATE_EXPIRE && this.onExpire) {
      this.onExpire();
    }
  }

  _updateLaunch(dt) {
    // Ascend vertically
    this.vy = -SPEED_SEARCH;
    this.vx = 0;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.heading = -Math.PI / 2;

    if (this.stateTimer >= LAUNCH_DURATION) {
      this._orbitCx = this.x;
      this._orbitCy = this.y;
      this._transitionTo(STATE_SEARCH);
    }
  }

  _updateSearch(dt) {
    // Tick wing deployment in flight
    if (!this._wingsDeployed) {
      this._wingDeployT = Math.min(1, this._wingDeployT + dt / WING_DEPLOY_DURATION);
      if (this._wingDeployT >= 1) this._wingsDeployed = true;
    }

    // Circular patrol orbit
    this._orbitAngle += (SPEED_SEARCH / SEARCH_ORBIT_R) * dt;
    const targetX = this._orbitCx + Math.cos(this._orbitAngle) * SEARCH_ORBIT_R;
    const targetY = this._orbitCy + Math.sin(this._orbitAngle) * SEARCH_ORBIT_R;

    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const desired = Math.atan2(dy, dx);
    this.heading = lerpAngle(this.heading, desired, TURN_RATE * dt);
    this.vx = Math.cos(this.heading) * SPEED_SEARCH;
    this.vy = Math.sin(this.heading) * SPEED_SEARCH;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Scan for target every 0.25s
    if (this.stateTimer >= 0.25) {
      this.stateTimer = 0;
      this.target = this._pickTarget();
      if (this.target) {
        this._transitionTo(STATE_PURSUE);
      }
    }
  }

  _updatePursue(dt) {
    if (!this.target || !this.target.alive) {
      this.target = this._pickTarget();
      if (!this.target) {
        this._transitionTo(STATE_SEARCH);
        return;
      }
    }

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const d  = Math.sqrt(dx * dx + dy * dy);

    // Steer toward target
    const desired = Math.atan2(dy, dx);
    this.heading = lerpAngle(this.heading, desired, TURN_RATE * dt);
    this.vx = Math.cos(this.heading) * SPEED_PURSUE;
    this.vy = Math.sin(this.heading) * SPEED_PURSUE;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (d < ATTACK_RANGE) {
      this._transitionTo(STATE_ATTACK);
    }

    // Reacquire if target died
    if (!this.target.alive) {
      this.target = null;
    }
  }

  _updateAttack(dt) {
    if (!this.target || !this.target.alive) {
      this.target = this._pickTarget();
      if (!this.target) {
        this._transitionTo(STATE_SEARCH);
        return;
      }
      this._transitionTo(STATE_PURSUE);
      return;
    }

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const desired = Math.atan2(dy, dx);
    this.heading = lerpAngle(this.heading, desired, TURN_RATE * 1.5 * dt);
    this.vx = Math.cos(this.heading) * SPEED_ATTACK;
    this.vy = Math.sin(this.heading) * SPEED_ATTACK;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  _updateExpire(dt) {
    // Decelerate and fade
    this.vx *= Math.pow(0.05, dt);
    this.vy *= Math.pow(0.05, dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this._expireAlpha = Math.max(0, 1.0 - this.stateTimer / EXPIRE_FADE);
    if (this.stateTimer >= EXPIRE_FADE) {
      this.alive = false;
    }
  }

  _pickTarget() {
    if (!this.getEnemies) return null;
    const enemies = this.getEnemies();
    let best = null;
    let bestScore = -Infinity;

    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - this.x;
      const dy = e.y - this.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const priority = targetPriority(e);
      // Score = priority / (normalised distance) — prefer close + high-priority
      const score = priority * 1000 / (d + 1);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  draw(ctx) {
    if (!this.alive) return;

    ctx.save();
    ctx.globalAlpha = this._expireAlpha;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.heading);

    // ── Wings ─────────────────────────────────────────────────────────────────
    // Wing animation: t=0 folded (wings tucked against body), t=1 fully spread
    const deployT = Math.min(1, this._wingDeployT);
    const eased   = deployT < 1 ? easeOutBack(deployT) : 1;
    // At t=0: wingAngle = MAX (tucked in). At t=1: wingAngle = 0 (spread out).
    const foldAngle = Math.max(0, Math.min(MAX_WING_ANGLE * 1.15, MAX_WING_ANGLE * (1 - eased)));

    // Snap flash effect: cyan highlight at overshoot peak (t 0.72–0.95)
    const inSnapWindow = deployT >= 0.72 && deployT <= 0.95;
    const snapFlashAlpha = inSnapWindow
      ? Math.sin((deployT - 0.72) / (0.95 - 0.72) * Math.PI) * 0.8
      : 0;

    // Wing gradient (root to tip: lighter to darker)
    const wingGrad = ctx.createLinearGradient(0, 0, 0, 38);
    wingGrad.addColorStop(0, '#7A8A6A');
    wingGrad.addColorStop(1, '#4A5440');

    // Upper wing (port, negative Y in local space)
    ctx.save();
    ctx.translate(-5, 0); // pivot near wing root on fuselage
    ctx.rotate(-foldAngle); // rotate upward
    ctx.fillStyle = wingGrad;
    ctx.beginPath();
    // Swept delta wing: root at body, tip extending outward
    ctx.moveTo(0, 0);
    ctx.lineTo(-18, -38);
    ctx.lineTo(16, -8);
    ctx.closePath();
    ctx.fill();

    // Snap flash: cyan highlight on leading edge
    if (snapFlashAlpha > 0.01) {
      ctx.save();
      ctx.strokeStyle = `rgba(0,255,255,${snapFlashAlpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-18, -38);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // Lower wing (starboard, positive Y in local space)
    const wingGrad2 = ctx.createLinearGradient(0, 0, 0, 38);
    wingGrad2.addColorStop(0, '#7A8A6A');
    wingGrad2.addColorStop(1, '#4A5440');
    ctx.save();
    ctx.translate(-5, 0);
    ctx.rotate(foldAngle); // rotate downward
    ctx.fillStyle = wingGrad2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-18, 38);
    ctx.lineTo(16, 8);
    ctx.closePath();
    ctx.fill();

    // Snap flash: lower wing
    if (snapFlashAlpha > 0.01) {
      ctx.save();
      ctx.strokeStyle = `rgba(0,255,255,${snapFlashAlpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-18, 38);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // ── Tail fins (V-tail) ─────────────────────────────────────────────────────
    ctx.fillStyle = '#4A5238';
    // Upper tail fin
    ctx.beginPath();
    ctx.moveTo(-20, -2);
    ctx.lineTo(-28, -14);
    ctx.lineTo(-16, -3);
    ctx.closePath();
    ctx.fill();
    // Lower tail fin
    ctx.beginPath();
    ctx.moveTo(-20, 2);
    ctx.lineTo(-28, 14);
    ctx.lineTo(-16, 3);
    ctx.closePath();
    ctx.fill();

    // ── Fuselage ──────────────────────────────────────────────────────────────
    // Vertical gradient: olive top to dark olive bottom
    const fuselageGrad = ctx.createLinearGradient(0, -3, 0, 3);
    fuselageGrad.addColorStop(0, '#6B7A5A');
    fuselageGrad.addColorStop(1, '#3D4530');
    ctx.fillStyle = fuselageGrad;
    ctx.beginPath();
    ctx.moveTo(FUSELAGE_PTS[0], FUSELAGE_PTS[1]);
    for (let i = 2; i < FUSELAGE_PTS.length; i += 2) {
      ctx.lineTo(FUSELAGE_PTS[i], FUSELAGE_PTS[i + 1]);
    }
    ctx.closePath();
    ctx.fill();

    // Fuselage edge highlight
    ctx.strokeStyle = 'rgba(0,207,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(FUSELAGE_PTS[0], FUSELAGE_PTS[1]);
    for (let i = 2; i < FUSELAGE_PTS.length; i += 2) {
      ctx.lineTo(FUSELAGE_PTS[i], FUSELAGE_PTS[i + 1]);
    }
    ctx.closePath();
    ctx.stroke();

    // ── Engine exhaust ────────────────────────────────────────────────────────
    const glowPulse = 0.6 + Math.sin(this._glowPhase) * 0.4;
    const exhaustA = glowPulse * 0.55;
    for (let i = 0; i < 3; i++) {
      const ex = -22 - i * 7;
      const alpha = exhaustA * (1 - i / 3);
      ctx.beginPath();
      ctx.arc(ex, (Math.random() - 0.5) * 4, randf(1, 2.5), 0, TAU);
      ctx.fillStyle = `rgba(0,207,255,${alpha.toFixed(3)})`;
      ctx.fill();
    }

    // ── Sensor dome (nose) ─────────────────────────────────────────────────────
    // Color varies by state
    let domeColor;
    if (this.state === STATE_SEARCH) {
      domeColor = 'rgba(0,220,255,1)';       // cyan
    } else if (this.state === STATE_PURSUE) {
      domeColor = 'rgba(0,255,180,0.9)';     // green
    } else if (this.state === STATE_ATTACK) {
      domeColor = 'rgba(255,160,0,0.95)';    // amber
    } else {
      domeColor = 'rgba(0,180,200,0.6)';     // dim
    }

    ctx.save();
    ctx.shadowColor = domeColor;
    ctx.shadowBlur = 8;
    const domeGrad = ctx.createRadialGradient(DOME_X, 0, 0, DOME_X, 0, DOME_R);
    domeGrad.addColorStop(0, domeColor);
    domeGrad.addColorStop(1, 'rgba(0,80,140,0.5)');
    ctx.fillStyle = domeGrad;
    ctx.beginPath();
    ctx.arc(DOME_X, 0, DOME_R, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // ── Kill counter LEDs ──────────────────────────────────────────────────────
    for (let i = 0; i < MAX_KILLS; i++) {
      const [lx, ly] = LEDS[i];
      const lit = i < this.killsRemaining;
      ctx.save();
      if (lit) {
        ctx.shadowColor = '#00FF88';
        ctx.shadowBlur = 6;
        ctx.fillStyle = '#00FF88';
      } else {
        ctx.fillStyle = '#1A3A2A';
      }
      ctx.beginPath();
      ctx.arc(lx, ly, 2, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // ── State-specific overlays ────────────────────────────────────────────────

    if (this.state === STATE_SEARCH) {
      // Scanning ring — rotates independently
      ctx.save();
      ctx.rotate(this._scanRotation);
      ctx.strokeStyle = 'rgba(0,207,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 10]);
      ctx.beginPath();
      ctx.arc(0, 0, 60, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      // tick marks
      for (let t = 0; t < 6; t++) {
        const ta = (t / 6) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ta) * 55, Math.sin(ta) * 55);
        ctx.lineTo(Math.cos(ta) * 64, Math.sin(ta) * 64);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (this.state === STATE_PURSUE && this.target) {
      // Lock-on brackets: unrotate back to world space and draw relative to target
      const tgt = this.target;
      ctx.restore(); // pops translate+rotate
      // Draw brackets in plain canvas space
      this._drawLockBracketsWorld(ctx, tgt.x, tgt.y);
      return; // early out — no further ctx.restore() needed
    }

    ctx.restore(); // heading rotation + translation
  }

  /**
   * Draw lock-on brackets at a world canvas position.
   * Must be called with canvas in un-transformed (world) space.
   */
  _drawLockBracketsWorld(ctx, tx, ty) {
    const s = 28;
    const arm = 10;
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() * 0.012);

    ctx.save();
    ctx.strokeStyle = `rgba(0,207,255,${pulse.toFixed(3)})`;
    ctx.lineWidth = 2;

    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const bx = tx + sx * s;
      const by = ty + sy * s;
      ctx.beginPath();
      ctx.moveTo(bx, by + sy * arm);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + sx * arm, by);
      ctx.stroke();
    }
    ctx.restore();
  }
}
