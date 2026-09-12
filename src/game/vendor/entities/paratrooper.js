/**
 * Paratrooper — enemy unit dropped by TransportPlane.
 *
 * State machine:
 *   FREEFALL → PARACHUTE → LANDED (parachute crumples)
 *     → RUNNING (toward nearest launcher) → ATTACKING (plant explosive, 1.2s fuse) → dead
 *     → IDLE (no launchers alive) → dead (no explosion)
 *
 * Ground soldiers stay in the enemy_missiles group so players can shoot them.
 * One-hit kill, no HP system.
 *
 * External references injected by game.js after construction:
 *   trooper.terrain    — Terrain instance (for getHeightAt)
 *   trooper._launchers — Array of Launcher instances
 *   trooper.onDetonate — function(px, py) called when explosive detonates
 */

import { Entity } from './entity.js';
import { randf, lerp } from '../utils.js';

const FREEFALL_GRAVITY   = 200;
const PARACHUTE_GRAVITY  = 15;
const PARACHUTE_SPEED    = 80;
const FREEFALL_DURATION  = 0.3;

const GROUND_SPEED       = 90;   // px/s running speed
const ATTACK_RANGE       = 35;   // px horizontal distance to trigger attack
const COLLAPSE_DURATION  = 0.4;  // parachute crumple animation time (s)
const FUSE_DURATION      = 1.2;  // plant-to-detonation time (s)
const IDLE_DESPAWN_DELAY = 5.0;  // despawn delay if no targets (s)
const MAX_LIFETIME       = 30.0; // absolute max lifetime (s) — prevents wave deadlock
const SOLDIER_GROUND_RADIUS = 12; // collision radius once on ground
const RUN_CYCLE_SPEED    = 8.0;  // leg animation angular speed
const RUN_LEG_AMP        = 0.35; // leg swing angle amplitude (rad)

// Canopy gore boundary X-coords (6 panels, 7 boundaries)
const GORE_X6 = [];
for (let i = 0; i <= 6; i++) {
  GORE_X6.push(30 * Math.sin((i / 6 - 0.5) * Math.PI));
}

const CANOPY_APEX_Y = -26;

export class Paratrooper extends Entity {
  /**
   * @param {number} x — spawn x (plane's x at drop time)
   * @param {number} y — spawn y (plane's y at drop time)
   */
  constructor(x, y) {
    super(x, y);
    this.vx = randf(-15, 15);
    this.vy = 0;
    this.collisionRadius = 15;
    this.groups.add('enemy_missiles');

    // Lifetime tracking — prevents wave deadlock
    /** @type {number} total seconds alive */
    this._lifetime = 0;

    // State machine
    /** @type {'freefall'|'parachute'|'landed'|'running'|'attacking'|'idle'} */
    this.state = 'freefall';

    // Freefall / parachute phase
    this.freefallTimer    = 0;
    this.parachuteDeployed = false; // kept for draw() branching
    this.swayTime         = randf(0, 6.28);
    this.deployProgress   = 0;
    this.deployTime       = 0;
    this.parachuteRotation = 0;
    this.canopyLean       = 0;

    // Ground-phase fields
    /** @type {import('../terrain.js').Terrain|null} */
    this.terrain   = null;
    /** @type {Array|null} */
    this._launchers = null;
    /** @type {function|null} */
    this.onDetonate = null;

    /** @type {object|null} current run target (a launcher) */
    this._runTarget    = null;
    /** @type {number} parachute collapse animation timer */
    this._collapseTimer = 0;
    /** @type {number} attack (fuse) timer */
    this._attackTimer  = 0;
    /** @type {number} idle despawn timer */
    this._idleTimer    = 0;
    /** @type {number} running animation cycle */
    this._runCycle     = randf(0, Math.PI * 2);
    /** @type {number} facing direction: +1 = right, -1 = left */
    this._facingDir    = 1;

    // Crumple visual: collapses the canopy after landing
    this._collapseScale = 1.0;
  }

  // ── Main update dispatcher ─────────────────────────────────────────────────

  /** @param {number} dt */
  update(dt) {
    // Hard lifetime cap — prevents wave deadlock if trooper gets stuck
    this._lifetime += dt;
    if (this._lifetime >= MAX_LIFETIME) {
      this.alive = false;
      return;
    }

    switch (this.state) {
      case 'freefall':   this._updateFreefall(dt);   break;
      case 'parachute':  this._updateParachute(dt);  break;
      case 'landed':     this._updateLanded(dt);     break;
      case 'running':    this._updateRunning(dt);    break;
      case 'attacking':  this._updateAttacking(dt);  break;
      case 'idle':       this._updateIdle(dt);       break;
    }
  }

  // ── State handlers ─────────────────────────────────────────────────────────

  /** @param {number} dt */
  _updateFreefall(dt) {
    this.freefallTimer += dt;
    this.vy += FREEFALL_GRAVITY * dt;

    if (this.freefallTimer >= FREEFALL_DURATION) {
      this.state = 'parachute';
      this.parachuteDeployed = true;
      this.vy = Math.min(this.vy, PARACHUTE_SPEED);
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.x < -200 || this.x > 2760) this.alive = false;
  }

  /** @param {number} dt */
  _updateParachute(dt) {
    // Cap fall speed
    if (this.vy > PARACHUTE_SPEED) {
      this.vy = lerp(this.vy, PARACHUTE_SPEED, 3.0 * dt);
    }

    // Gentle horizontal sway
    this.swayTime += dt;
    this.vx += Math.sin(this.swayTime * 1.2) * 10 * dt;

    // Canopy oscillation and lean
    this.parachuteRotation = Math.sin(this.swayTime * 2.0) * 0.10;
    this.canopyLean = Math.max(-0.18, Math.min(0.18, this.vx * 0.003));

    // Deployment animation (0.3s with overshoot)
    this.deployTime += dt;
    const t = Math.min(this.deployTime / 0.3, 1.0);
    this.deployProgress = t < 0.8
      ? (t / 0.8) * 1.07
      : 1.07 - ((t - 0.8) / 0.2) * 0.07;

    // Apply parachute gravity drag
    this.vy += PARACHUTE_GRAVITY * dt;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.x < -200 || this.x > 2760) {
      this.alive = false;
      return;
    }

    // Check terrain landing
    if (this.terrain) {
      const groundY = this.terrain.getHeightAt(this.x);
      if (this.y >= groundY) {
        this._land(groundY);
      }
    }
  }

  /** @param {number} dt */
  _updateLanded(dt) {
    // Animate parachute collapse
    this._collapseTimer += dt;
    this._collapseScale = Math.max(0, 1.0 - this._collapseTimer / COLLAPSE_DURATION);

    if (this._collapseTimer >= COLLAPSE_DURATION) {
      // Collapse complete — find a target and transition
      this._findTarget();
      if (this._runTarget) {
        this.state = 'running';
      } else {
        this.state = 'idle';
      }
    }

    // Stay on terrain surface (terrain may deform)
    if (this.terrain) {
      this.y = this.terrain.getHeightAt(this.x);
    }
  }

  /** @param {number} dt */
  _updateRunning(dt) {
    // Off-screen kill check
    if (this.x < -100 || this.x > 2660 || this.y > 1600) {
      this.alive = false;
      return;
    }

    // Keep on terrain surface (handles deformation)
    if (this.terrain) {
      this.y = this.terrain.getHeightAt(this.x);
    }

    // Retarget if current target is dead
    if (!this._runTarget || !this._runTarget.alive) {
      this._findTarget();
      if (!this._runTarget) {
        this.state = 'idle';
        return;
      }
    }

    const dx = this._runTarget.x - this.x;
    const absDx = Math.abs(dx);

    // Transition to attacking when close enough
    if (absDx <= ATTACK_RANGE) {
      this.state = 'attacking';
      this._attackTimer = 0;
      return;
    }

    // Move toward target
    this._facingDir = dx > 0 ? 1 : -1;
    this.x += this._facingDir * GROUND_SPEED * dt;

    // Advance run animation cycle
    this._runCycle += RUN_CYCLE_SPEED * dt;
  }

  /** @param {number} dt */
  _updateAttacking(dt) {
    // Off-screen kill check
    if (this.x < -100 || this.x > 2660 || this.y > 1600) {
      this.alive = false;
      return;
    }

    // Stay on terrain surface
    if (this.terrain) {
      this.y = this.terrain.getHeightAt(this.x);
    }

    this._attackTimer += dt;

    if (this._attackTimer >= FUSE_DURATION) {
      // Detonate!
      if (this.onDetonate) {
        this.onDetonate(this.x, this.y);
      }

      // Destroy the target launcher via takeDamage so the HP system is always used
      if (this._runTarget && this._runTarget.alive) {
        this._runTarget.takeDamage(1.0);
      }

      this.alive = false;
    }
  }

  /** @param {number} dt */
  _updateIdle(dt) {
    // Off-screen kill check
    if (this.x < -100 || this.x > 2660 || this.y > 1600) {
      this.alive = false;
      return;
    }

    // Stay on terrain surface
    if (this.terrain) {
      this.y = this.terrain.getHeightAt(this.x);
    }

    // Check if a launcher has appeared (unlikely but safe)
    this._findTarget();
    if (this._runTarget) {
      this.state = 'running';
      return;
    }

    this._idleTimer += dt;
    if (this._idleTimer >= IDLE_DESPAWN_DELAY) {
      this.alive = false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Snap to terrain surface and transition state to LANDED.
   * @param {number} groundY
   */
  _land(groundY) {
    this.y = groundY;
    this.vx = 0;
    this.vy = 0;
    this.collisionRadius = SOLDIER_GROUND_RADIUS;
    this.state = 'landed';
    this._collapseTimer = 0;
    this._collapseScale = 1.0;
  }

  /**
   * Find the nearest alive launcher by horizontal distance and store in _runTarget.
   * Sets _runTarget to null if no launchers are alive.
   */
  _findTarget() {
    if (!this._launchers || this._launchers.length === 0) {
      this._runTarget = null;
      return;
    }
    let nearest = null;
    let nearestDist = Infinity;
    for (const launcher of this._launchers) {
      if (!launcher.alive) continue;
      const d = Math.abs(launcher.x - this.x);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = launcher;
      }
    }
    this._runTarget = nearest;
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.state === 'freefall') {
      // Tumbling without chute
      this._drawSoldierBody(ctx, 0, 0, this.freefallTimer * 4.0, 0, 0);
      ctx.restore();
      return;
    }

    if (this.state === 'parachute') {
      this._drawParachutingTrooper(ctx);
      ctx.restore();
      return;
    }

    if (this.state === 'landed') {
      // Parachute crumpling animation — scale canopy down to 0
      if (this._collapseScale > 0.01) {
        ctx.save();
        ctx.translate(0, -55);
        const s = this._collapseScale;
        // Crumple: canopy sinks down as it collapses
        ctx.translate(0, (1 - s) * 40);
        ctx.scale(s, s * 0.5 + 0.5 * s * s);
        this._drawCanopy(ctx);
        ctx.restore();
      }
      this._drawSoldierBody(ctx, 0, 0, 0, 0, 0);
      ctx.restore();
      return;
    }

    if (this.state === 'running') {
      // Running soldier — flip based on facing direction
      ctx.scale(this._facingDir, 1);
      this._drawRunningBody(ctx);
      ctx.restore();
      return;
    }

    if (this.state === 'attacking') {
      // Crouching with pulsing fuse indicator
      ctx.scale(this._facingDir, 1);
      this._drawAttackingBody(ctx);
      ctx.restore();
      return;
    }

    if (this.state === 'idle') {
      // Idle soldier — standing still
      this._drawSoldierBody(ctx, 0, 0, 0, 0, 0);
      ctx.restore();
      return;
    }

    ctx.restore();
  }

  // ── Draw helpers ──────────────────────────────────────────────────────────

  /** Draw full parachuting view (canopy + lines + body) */
  _drawParachutingTrooper(ctx) {
    // Parachute canopy (4-layer simplified version)
    ctx.save();
    ctx.translate(0, -55); // canopy above the soldier
    ctx.scale(this.deployProgress, this.deployProgress);
    ctx.rotate(this.parachuteRotation + this.canopyLean);

    this._drawCanopy(ctx);

    ctx.restore();

    // Suspension lines — drawn in entity space so they connect the canopy
    // skirt to the soldier's shoulders without floating above the body.
    //
    // Canopy skirt point (gx, 0) in canopy-local space maps to entity space via:
    //   1. rotate(rot):    (gx*cos(rot), gx*sin(rot))
    //   2. scale(dp):      (gx*cos(rot)*dp, gx*sin(rot)*dp)
    //   3. translate(0,-55): (gx*cos(rot)*dp, gx*sin(rot)*dp - 55)
    const rot = this.parachuteRotation + this.canopyLean;
    const dp  = this.deployProgress;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);

    ctx.strokeStyle = 'rgba(180,165,140,0.8)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 6; g++) {
      const gx = GORE_X6[g];
      const skirtX = gx * cosR * dp;
      const skirtY = gx * sinR * dp - 55;
      // Riser shoulder anchor — left lines go to left shoulder, right to right
      const riserX = gx <= 0 ? -5 : 5;
      const riserY = -4; // top of torso / shoulder height in entity space
      ctx.beginPath();
      ctx.moveTo(skirtX, skirtY);
      ctx.lineTo(riserX, riserY);
      ctx.stroke();
    }

    // Soldier body below canopy
    this._drawSoldierBody(ctx, 0, 0, 0, 0, 0);
  }

  /**
   * Draw the simplified 4-layer parachute canopy.
   * Canvas should be translated to canopy origin, scaled by deployProgress,
   * rotated by parachuteRotation.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawCanopy(ctx) {
    // Layer 1: Canopy base — bright green radial gradient dome
    {
      const grad = ctx.createRadialGradient(-6, -20, 0, 0, -13, 36);
      grad.addColorStop(0, '#AADA70');
      grad.addColorStop(0.5, '#7AAA5A');
      grad.addColorStop(1, '#4A7A38');
      ctx.beginPath();
      ctx.ellipse(0, 0, 30, 25, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.save();
      ctx.globalAlpha = 0.97;
      ctx.fill();
      ctx.restore();
    }

    // Layer 2: 6 gore panels — alternating bright green shades
    for (let g = 0; g < 6; g++) {
      const x0 = GORE_X6[g];
      const x1 = GORE_X6[g + 1];
      const midX = (x0 + x1) * 0.5;
      const billow = Math.sin(this.swayTime * 3.0 + g * 1.05) * 2.5;

      const isEven = (g % 2 === 0);
      const skirtColor = isEven ? '#8AC060' : '#5A8840';
      const apexColor  = isEven ? '#4A6830' : '#305020';

      const grad = ctx.createLinearGradient(0, 0, 0, CANOPY_APEX_Y);
      grad.addColorStop(0, skirtColor);
      grad.addColorStop(1, apexColor);

      ctx.beginPath();
      ctx.moveTo(0, CANOPY_APEX_Y);
      ctx.lineTo(x0, 0);
      ctx.quadraticCurveTo(midX + billow * 0.5, 2, x1, 0);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Layer 3: Gore rib lines
    {
      ctx.strokeStyle = 'rgba(30,50,20,0.55)';
      ctx.lineWidth = 1;
      for (let g = 1; g < 6; g++) {
        ctx.beginPath();
        ctx.moveTo(0, CANOPY_APEX_Y);
        ctx.lineTo(GORE_X6[g], 0);
        ctx.stroke();
      }
    }

    // Layer 4: Canopy outline — bright edge for visibility against dark sky
    {
      ctx.beginPath();
      ctx.ellipse(0, 0, 30, 25, 0, Math.PI, 0);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(200,240,160,0.80)';
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }
  }

  /**
   * Draw the running soldier body with pumping arms and alternating legs.
   * ctx is already scaled by _facingDir.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawRunningBody(ctx) {
    const legSwing = Math.sin(this._runCycle) * RUN_LEG_AMP;
    const armSwing = -legSwing; // arms opposite to legs

    // Helmet
    ctx.fillStyle = '#4A5A2A';
    ctx.beginPath();
    ctx.ellipse(0, -6, 5, 3, 0, Math.PI, 0);
    ctx.fill();

    // Head — skin tone
    ctx.fillStyle = '#C88848';
    ctx.fillRect(-3, -6, 6, 5);

    // Torso — slight forward lean while running
    ctx.fillStyle = '#4A5A2A';
    ctx.save();
    ctx.rotate(0.15); // lean forward
    ctx.fillRect(-4, -1, 8, 9);
    ctx.restore();

    // Arms — pumping motion
    ctx.strokeStyle = '#4A5A2A';
    ctx.lineWidth = 2;
    // Left arm (back arm when facing right)
    ctx.beginPath();
    ctx.moveTo(-4, 1);
    ctx.lineTo(-4 + Math.sin(armSwing + 0.5) * 7, 1 + Math.cos(armSwing + 0.5) * 5);
    ctx.stroke();
    // Right arm (front arm)
    ctx.beginPath();
    ctx.moveTo(4, 1);
    ctx.lineTo(4 + Math.sin(-armSwing - 0.5) * 7, 1 + Math.cos(-armSwing - 0.5) * 5);
    ctx.stroke();

    // Legs — alternating stride
    ctx.lineWidth = 2.5;
    // Left leg
    ctx.beginPath();
    ctx.moveTo(-2, 8);
    ctx.lineTo(-2 + Math.sin(legSwing) * 10, 8 + Math.abs(Math.cos(legSwing)) * 9);
    ctx.stroke();
    // Right leg
    ctx.beginPath();
    ctx.moveTo(2, 8);
    ctx.lineTo(2 + Math.sin(legSwing + Math.PI) * 10, 8 + Math.abs(Math.cos(legSwing + Math.PI)) * 9);
    ctx.stroke();
  }

  /**
   * Draw the attacking soldier — crouched, with pulsing fuse indicator.
   * ctx is already scaled by _facingDir.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawAttackingBody(ctx) {
    const fuseProgress = Math.min(this._attackTimer / FUSE_DURATION, 1.0);

    // Crouched body — shifted down a bit
    const crouch = 4;

    // Helmet
    ctx.fillStyle = '#4A5A2A';
    ctx.beginPath();
    ctx.ellipse(0, -6 + crouch, 5, 3, 0, Math.PI, 0);
    ctx.fill();

    // Head
    ctx.fillStyle = '#C88848';
    ctx.fillRect(-3, -6 + crouch, 6, 5);

    // Torso — crouched
    ctx.fillStyle = '#4A5A2A';
    ctx.fillRect(-4, -1 + crouch, 8, 7);

    // Arms — reaching forward (toward target)
    ctx.strokeStyle = '#4A5A2A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(4, 1 + crouch);
    ctx.lineTo(12, 3 + crouch);
    ctx.stroke();

    // Legs — crouched
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-2, 6 + crouch);
    ctx.lineTo(-5, 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(2, 6 + crouch);
    ctx.lineTo(5, 14);
    ctx.stroke();

    // Fuse indicator — pulsing dot at ground level near soldier
    const fuseX = 14;
    const fuseY = 12;
    const pulseRate = 4 + fuseProgress * 12; // speeds up as fuse burns
    const pulseAlpha = 0.5 + 0.5 * Math.sin(this._attackTimer * pulseRate * Math.PI * 2);
    const fuseColor = fuseProgress < 0.5
      ? `rgba(255,220,0,${pulseAlpha.toFixed(3)})`
      : `rgba(255,80,0,${pulseAlpha.toFixed(3)})`;

    // Small explosive pack
    ctx.fillStyle = '#3A2A1A';
    ctx.fillRect(fuseX - 3, fuseY - 4, 7, 5);

    // Fuse spark
    ctx.beginPath();
    ctx.arc(fuseX, fuseY - 4, 3 + fuseProgress * 2, 0, Math.PI * 2);
    ctx.fillStyle = fuseColor;
    ctx.fill();

    // Fuse line (burns down)
    const fuseLineLen = 10 * (1 - fuseProgress);
    if (fuseLineLen > 0) {
      ctx.strokeStyle = '#C8A020';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(fuseX, fuseY - 4);
      ctx.lineTo(fuseX - fuseLineLen, fuseY - 8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * Draw the soldier body — used for freefall, parachute, and idle states.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} ox — x offset
   * @param {number} oy — y offset
   * @param {number} tumbleAngle — rotation for freefall tumbling
   * @param {number} _unused1
   * @param {number} _unused2
   */
  _drawSoldierBody(ctx, ox, oy, tumbleAngle, _unused1, _unused2) {
    ctx.save();
    ctx.translate(ox, oy);
    if (tumbleAngle !== 0) ctx.rotate(tumbleAngle);

    // Helmet — olive dome
    ctx.fillStyle = '#4A5A2A';
    ctx.beginPath();
    ctx.ellipse(0, -6, 5, 3, 0, Math.PI, 0);
    ctx.fill();

    // Head — skin tone
    ctx.fillStyle = '#C88848';
    ctx.fillRect(-3, -6, 6, 5);

    // Torso — olive drab
    ctx.fillStyle = '#4A5A2A';
    ctx.fillRect(-4, -1, 8, 9);

    // Left arm — slight angle
    ctx.strokeStyle = '#4A5A2A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-4, 1);
    ctx.lineTo(-8, 6);
    ctx.stroke();

    // Right arm
    ctx.beginPath();
    ctx.moveTo(4, 1);
    ctx.lineTo(8, 6);
    ctx.stroke();

    // Legs — dangle with slight sway
    const legSway = this.parachuteDeployed
      ? Math.sin(this.swayTime * 1.8) * 3
      : 0;

    ctx.lineWidth = 2;
    // Left leg
    ctx.beginPath();
    ctx.moveTo(-2, 8);
    ctx.lineTo(-3 + legSway, 16);
    ctx.stroke();
    // Right leg
    ctx.beginPath();
    ctx.moveTo(2, 8);
    ctx.lineTo(3 + legSway, 16);
    ctx.stroke();

    ctx.restore();
  }
}
