/**
 * LaserLauncher — Directed-energy hitscan beam weapon.
 *
 * Gameplay identity: precision single-target weapon with 1.0s warm-up,
 * energy drain (40/s), and sustained damage model for heavy targets.
 *
 * State machine:
 *   idle → warming (mouseDown, energy >= minFireEnergy)
 *   warming → firing (warmUpTimer >= warmUpTime)
 *   firing → idle (mouseUp OR energy <= 0)
 *   warming → idle (mouseUp — cancel with no penalty)
 *
 * Beam collision is handled inside update() via ray-circle intersection.
 * Heavy targets (nuke, transport plane) accumulate damage in _beamDamageMap.
 * Standard enemies die on first contact.
 */

import { Launcher, drawPoly } from './launcher.js';
import { TAU, clamp, randf } from '../utils.js';

// ── Damage thresholds by entity type (seconds of continuous beam contact) ──
const LASER_THRESHOLDS = {
  Nuke:          0.6,
  TransportPlane: 0.5,
  SuperMissile:  0.4,
  SuicideDrone:  0.2,
  Paratrooper:   0.1,
  // All others (EnemyMissile, Drone, MissileFragment, VulkanBullet) = instant
};

// Default instant-kill threshold (very short — effectively instant on first contact frame)
const THRESHOLD_INSTANT = 0.05;

/**
 * Get laser damage threshold for an entity (seconds of beam contact to kill).
 * @param {import('./entity.js').Entity} entity
 * @returns {number}
 */
function getLaserThreshold(entity) {
  const name = entity.constructor.name;
  return LASER_THRESHOLDS[name] ?? THRESHOLD_INSTANT;
}

/**
 * Ray vs circle intersection test.
 * @param {number} ox — ray origin x
 * @param {number} oy — ray origin y
 * @param {number} dx — ray direction x (normalized)
 * @param {number} dy — ray direction y (normalized)
 * @param {number} cx — circle center x
 * @param {number} cy — circle center y
 * @param {number} r — circle radius
 * @param {number} maxDist — max ray distance
 * @returns {number} distance along ray to first intersection, or -1 if no hit
 */
export function rayCircleIntersect(ox, oy, dx, dy, cx, cy, r, maxDist) {
  const fx = ox - cx;
  const fy = oy - cy;
  // a = 1 since direction is normalized (dx*dx + dy*dy = 1)
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) * 0.5;
  const t2 = (-b + disc) * 0.5;
  // Take the smallest positive t (nearest intersection along ray)
  let t = -1;
  if (t1 >= 0 && t1 <= maxDist) t = t1;
  else if (t2 >= 0 && t2 <= maxDist) t = t2;
  return t;
}

// ── Impact spark particles ──
const MAX_IMPACT_SPARKS = 8;

export class LaserLauncher extends Launcher {
  constructor(x, y) {
    super(x, y, 'laser');

    this.clickHalfW = 45;
    this.clickHalfH = 55;
    this.turretTipOffset = -68; // long barrel

    // ── Energy system ──
    this.energy     = 1.0;   // 0..1 (normalized)
    this.maxEnergy  = 1.0;
    this.drainRate  = 0.18;  // per second while firing
    this.rechargeRate = 0.08; // per second while idle
    this.rechargeDelay = 1.5; // seconds delay before recharge starts
    this.minFireEnergy = 0.10; // minimum to begin warm-up

    // ── Warm-up system ──
    this.warmUpTime  = 1.0;   // seconds
    this.warmUpTimer = 0;

    // ── State ──
    // 'idle' | 'warming' | 'firing'
    this.laserState = 'idle';

    // ── Beam ──
    this.beamMaxRange  = 2800; // pixels
    this.beamEndX      = 0;
    this.beamEndY      = 0;
    this._beamDamageMap = new Map(); // entity → accumulated damage time
    this._beamDecayMap  = new Map(); // entity → time since last contact
    this._beamHitEntity = null;      // entity currently under beam (for ring)
    this._beamHitThreshold = 1;     // threshold for current hit entity

    // Turret speed multiplier (1.0 normal, 0.5 while firing)
    this._turretSpeedMultiplier = 1.0;

    // ── Recharge cooldown ──
    this._rechargeCooldown = 0;

    // ── Elapsed time (for animations) ──
    this._elapsed = 0;

    // ── Beam jitter particles (visual) ──
    this._jitterPoints = [];

    // ── Impact sparks (visual) ──
    this._impactSparks = [];

    // ── Charging particles (inward convergence during warm-up) ──
    this._chargeParticles = [];

    // ── Audio callbacks wired by game.js ──
    /** @type {function|null} Called when warm-up starts */
    this.onStartWarmUp = null;
    /** @type {function|null} Called when warm-up cancels */
    this.onCancelWarmUp = null;
    /** @type {function|null} Called when beam starts firing */
    this.onStartFiring = null;
    /** @type {function|null} Called when beam stops */
    this.onStopFiring = null;
    /** @type {function|null} Called when beam hits a NEW entity */
    this.onBeamHit = null;

    // Base stats for upgrade system.
    this._baseStats = {
      drainRate:      this.drainRate,
      rechargeRate:   this.rechargeRate,
      rechargeDelay:  this.rechargeDelay,
      warmUpTime:     this.warmUpTime,
      beamMaxRange:   this.beamMaxRange,
      minFireEnergy:  this.minFireEnergy,
    };
    // Mirror back so instance fields always match _baseStats.
    this.drainRate     = this._baseStats.drainRate;
    this.rechargeRate  = this._baseStats.rechargeRate;
    this.rechargeDelay = this._baseStats.rechargeDelay;
    this.warmUpTime    = this._baseStats.warmUpTime;
    this.beamMaxRange  = this._baseStats.beamMaxRange;
    this.minFireEnergy = this._baseStats.minFireEnergy;
    /** @type {function|null} Called by collision/update — game passes enemy list */
    this.getEnemies = null;
    /** @type {function|null} Called when enemy killed by laser */
    this.onEnemyKilled = null;
    /** @type {function|null} Called to spawn explosion effect */
    this.onSpawnExplosion = null;
  }

  // ── Public state machine API (called by game.js) ──────────────────

  /** Begin charging the laser (on mouse-down). */
  startWarmUp() {
    if (this.laserState !== 'idle') return;
    if (this.energy < this.minFireEnergy) return;
    this.laserState = 'warming';
    this.warmUpTimer = 0;
    if (this.onStartWarmUp) this.onStartWarmUp(this.x);
    // Spawn initial charge particles
    this._spawnChargeParticles();
  }

  /** Cancel warm-up on mouse release (no penalty). */
  cancelWarmUp() {
    if (this.laserState !== 'warming') return;
    this.laserState = 'idle';
    this.warmUpTimer = 0;
    this._chargeParticles = [];
    if (this.onCancelWarmUp) this.onCancelWarmUp();
  }

  /** Force stop beam (called when deselected or energy out). */
  stopFiring() {
    if (this.laserState === 'firing') {
      this.laserState = 'idle';
      this._rechargeCooldown = this.rechargeDelay;
      this._beamDamageMap.clear();
      this._beamDecayMap.clear();
      this._beamHitEntity = null;
      if (this.onStopFiring) this.onStopFiring();
    } else if (this.laserState === 'warming') {
      this.cancelWarmUp();
    }
  }

  // ── Update ────────────────────────────────────────────────────────

  update(dt) {
    this._elapsed += dt;

    // Override turret tracking speed (slower while firing for gameplay balance)
    const trackSpeed = this._turretSpeedMultiplier * 10.0 * dt;

    // Manually replicate Launcher.update() logic with modified track speed
    const dx = this.mouseX - this.x;
    const dy = this.mouseY - this.y;
    let targetAngle = Math.atan2(dy, dx) + Math.PI / 2;
    const limit = 80 * Math.PI / 180;
    targetAngle = clamp(targetAngle, -limit, limit);
    this.turretRotation = lerpAngle(this.turretRotation, targetAngle, trackSpeed);

    // Selection glow pulse
    if (this.isSelected) {
      this._glowTime += dt;
      this._glowAlpha = 0.375 + 0.125 * Math.sin(this._glowTime * Math.PI / 0.6);
    }

    // ── State machine ──
    switch (this.laserState) {
      case 'warming':
        this._updateWarming(dt);
        break;
      case 'firing':
        this._updateFiring(dt);
        break;
      case 'idle':
        this._updateIdle(dt);
        break;
    }

    // ── Update charge particles ──
    this._updateChargeParticles(dt);

    // ── Update impact sparks ──
    for (let i = this._impactSparks.length - 1; i >= 0; i--) {
      const s = this._impactSparks[i];
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 200 * dt; // slight gravity
      if (s.age > s.life) this._impactSparks.splice(i, 1);
    }

    // ── Laser damage decay — forgiveness window ──
    // For entities NOT hit this frame, decay their contact time
    // (handled each frame in _updateBeamCollision)
    for (const [entity, decay] of [...this._beamDecayMap]) {
      const newDecay = decay + dt;
      if (newDecay > 0.1) {
        // Forgiveness expired — reset damage accumulator
        this._beamDamageMap.delete(entity);
        this._beamDecayMap.delete(entity);
      } else {
        this._beamDecayMap.set(entity, newDecay);
      }
    }
  }

  _updateWarming(dt) {
    this.warmUpTimer += dt;
    this._turretSpeedMultiplier = 1.0; // full tracking during warm-up

    // Emit more charge particles as warm-up progresses
    const progress = this.warmUpTimer / this.warmUpTime;
    if (Math.random() < progress * 4 * dt + 0.5 * dt) {
      this._spawnChargeParticle();
    }

    // Warm-up complete → transition to firing
    if (this.warmUpTimer >= this.warmUpTime) {
      this.laserState = 'firing';
      this.warmUpTimer = 0;
      this._beamDamageMap.clear();
      this._beamDecayMap.clear();
      if (this.onStartFiring) this.onStartFiring(this.x);
    }
  }

  _updateFiring(dt) {
    this._turretSpeedMultiplier = 0.5; // reduced tracking while firing

    // Drain energy
    this.energy -= this.drainRate * dt;

    if (this.energy <= 0) {
      this.energy = 0;
      this.stopFiring();
      return;
    }

    // Compute beam endpoint and check collisions
    this._updateBeamCollision(dt);

    // Generate beam jitter points
    this._updateBeamJitter();
  }

  _updateIdle(dt) {
    this._turretSpeedMultiplier = 1.0;
    this._chargeParticles = [];

    // Recharge delay countdown
    if (this._rechargeCooldown > 0) {
      this._rechargeCooldown -= dt;
      return;
    }

    // Recharge energy
    if (this.energy < this.maxEnergy) {
      this.energy = Math.min(this.maxEnergy, this.energy + this.rechargeRate * dt);
    }
  }

  _updateBeamCollision(dt) {
    // Get turret tip as beam origin
    const tip = this.getLaunchPosition();
    const ox = tip.x;
    const oy = tip.y;

    // Direction toward mouse
    const mdx = this.mouseX - ox;
    const mdy = this.mouseY - oy;
    const mlen = Math.sqrt(mdx * mdx + mdy * mdy);
    if (mlen < 1) {
      this.beamEndX = ox;
      this.beamEndY = oy;
      return;
    }
    const rdx = mdx / mlen;
    const rdy = mdy / mlen;

    let closestDist = this.beamMaxRange;
    let hitEntity = null;

    // Check all enemies
    if (this.getEnemies) {
      const enemies = this.getEnemies();
      // Track which entities were NOT hit this frame (for decay)
      const hitThisFrame = new Set();

      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const r = enemy.collisionRadius || 20;
        const t = rayCircleIntersect(ox, oy, rdx, rdy, enemy.x, enemy.y, r, closestDist);
        if (t < 0) continue;

        // This is the closest enemy along the beam so far
        if (t < closestDist) {
          closestDist = t;
          hitEntity = enemy;
        }
      }

      // Now apply damage to the closest hit entity only
      if (hitEntity && hitEntity.alive) {
        hitThisFrame.add(hitEntity);
        const prevDamage = this._beamDamageMap.get(hitEntity) || 0;
        const newDamage = prevDamage + dt;
        this._beamDamageMap.set(hitEntity, newDamage);
        // Reset decay timer for this entity (it's being actively hit)
        this._beamDecayMap.delete(hitEntity);

        const threshold = getLaserThreshold(hitEntity);

        // Notify game of new hit (for audio — only on first contact)
        if (prevDamage === 0 && this.onBeamHit) {
          this.onBeamHit(hitEntity.x, hitEntity.y);
        }

        // Check if entity should be destroyed
        if (newDamage >= threshold) {
          this._killEnemy(hitEntity);
          this._beamDamageMap.delete(hitEntity);
          this._beamDecayMap.delete(hitEntity);
          hitEntity = null; // beam passes through next frame
        }
      }

      // For entities NOT hit this frame, start or advance decay
      for (const entity of [...this._beamDamageMap.keys()]) {
        if (!hitThisFrame.has(entity)) {
          const currentDecay = this._beamDecayMap.get(entity) || 0;
          this._beamDecayMap.set(entity, currentDecay); // will be incremented in main update()
        }
      }
    }

    // Compute beam end point
    this.beamEndX = ox + rdx * closestDist;
    this.beamEndY = oy + rdy * closestDist;
    this._beamHitEntity = hitEntity;

    // Spawn impact sparks when beam terminates on something
    if (hitEntity && Math.random() < 0.4) {
      this._spawnImpactSparks(this.beamEndX, this.beamEndY);
    }
  }

  _killEnemy(enemy) {
    const name = enemy.constructor.name;

    if (this.onEnemyKilled) {
      this.onEnemyKilled(enemy, name);
    }

    // Spawn impact explosion
    if (this.onSpawnExplosion) {
      const isMega = name === 'Nuke' || name === 'TransportPlane';
      this.onSpawnExplosion(enemy.x, enemy.y, isMega);
    }

    enemy.destroy();
  }

  _updateBeamJitter() {
    // 5 jitter points along the beam for electrical shimmer
    this._jitterPoints = [];
    const tip = this.getLaunchPosition();
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const px = tip.x + (this.beamEndX - tip.x) * t;
      const py = tip.y + (this.beamEndY - tip.y) * t;
      // Perpendicular offset
      const perpX = -(this.beamEndY - tip.y) / this.beamMaxRange;
      const perpY =  (this.beamEndX - tip.x) / this.beamMaxRange;
      const jitter = (Math.random() - 0.5) * 4;
      this._jitterPoints.push({
        x: px + perpX * jitter,
        y: py + perpY * jitter,
      });
    }
  }

  _spawnChargeParticles() {
    for (let i = 0; i < 4; i++) {
      this._spawnChargeParticle();
    }
  }

  _spawnChargeParticle() {
    const tip = this.getLaunchPosition();
    // Spawn at random point around the turret, converging toward tip
    const angle = Math.random() * TAU;
    const dist = 30 + Math.random() * 60;
    this._chargeParticles.push({
      x: tip.x + Math.cos(angle) * dist,
      y: tip.y + Math.sin(angle) * dist,
      tx: tip.x,    // target x (tip)
      ty: tip.y,    // target y (tip)
      life: 0.3 + Math.random() * 0.4,
      age: 0,
      size: 1.5 + Math.random() * 2.5,
    });
  }

  _updateChargeParticles(dt) {
    for (let i = this._chargeParticles.length - 1; i >= 0; i--) {
      const p = this._chargeParticles[i];
      // Update target to current tip position (turret is rotating)
      const tip = this.getLaunchPosition();
      p.tx = tip.x;
      p.ty = tip.y;
      p.age += dt;
      const progress = p.age / p.life;
      // Move toward tip
      p.x = p.x + (p.tx - p.x) * Math.min(1, dt * 6);
      p.y = p.y + (p.ty - p.y) * Math.min(1, dt * 6);
      if (p.age > p.life) this._chargeParticles.splice(i, 1);
    }
  }

  _spawnImpactSparks(x, y) {
    if (this._impactSparks.length >= MAX_IMPACT_SPARKS) return;
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const speed = 80 + Math.random() * 200;
      this._impactSparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 50,
        age: 0,
        life: 0.1 + Math.random() * 0.2,
      });
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────

  draw(ctx) {
    if (!this.alive) return;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.translate(this._hitShakeX || 0, this._hitShakeY || 0);

    // ── 1. Selection glow (violet identity) ──────────────────────────
    if (this.isSelected) {
      ctx.save();
      ctx.shadowColor = '#8844FF';
      ctx.shadowBlur = 20;
      drawPoly(ctx, [-48, 36, 48, 36, 42, 28, -42, 28], `rgba(100,50,220,${(this._glowAlpha * 0.35).toFixed(3)})`);
      drawPoly(ctx, [-44, 33, 44, 33, 38, 25, -38, 25], `rgba(140,80,255,${this._glowAlpha.toFixed(3)})`);
      ctx.restore();
    }

    // ── 2. Base platform (hexagonal feel, flat polygon) ───────────────
    // Foot plate
    drawPoly(ctx, [-46, 32, 46, 32, 38, 22, -38, 22], '#1A1E28');
    // Highlight edge
    drawPoly(ctx, [-46, 32, 46, 32, 46, 30, -46, 30], 'rgba(0,200,255,0.08)');
    // Mounting bolts
    for (const bx of [-32, -16, 16, 32]) {
      ctx.beginPath();
      ctx.arc(bx, 28, 2.2, 0, TAU);
      ctx.fillStyle = '#4A5060';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx, 28, 1, 0, TAU);
      ctx.fillStyle = '#1A1E28';
      ctx.fill();
    }

    // Pedestal column with cooling vents
    const pedGrad = ctx.createLinearGradient(-16, 0, 16, 0);
    pedGrad.addColorStop(0, '#2A3040');
    pedGrad.addColorStop(0.5, '#3A4258');
    pedGrad.addColorStop(1, '#2A3040');
    ctx.beginPath();
    ctx.moveTo(-16, 22); ctx.lineTo(16, 22);
    ctx.lineTo(14, 4);   ctx.lineTo(-14, 4);
    ctx.closePath();
    ctx.fillStyle = pedGrad;
    ctx.fill();
    // Cooling vents (horizontal slits)
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (const vy of [8, 13, 18]) {
      ctx.fillRect(-12, vy - 0.5, 24, 1.5);
    }

    // ── 3. Turret arm (rotates) ──────────────────────────────────────
    ctx.save();
    ctx.rotate(this.turretRotation);

    const warmProg = this.laserState === 'warming'
      ? clamp(this.warmUpTimer / this.warmUpTime, 0, 1) : 0;
    const isFiringNow = this.laserState === 'firing';

    // Turret housing body — tapered rectangular housing
    const housingGrad = ctx.createLinearGradient(-12, 0, 12, 0);
    housingGrad.addColorStop(0, '#1A1E28');
    housingGrad.addColorStop(0.4, '#2A3040');
    housingGrad.addColorStop(1, '#1A1E28');
    ctx.beginPath();
    ctx.moveTo(-14, 4); ctx.lineTo(14, 4);
    ctx.lineTo(10, -30); ctx.lineTo(-10, -30);
    ctx.closePath();
    ctx.fillStyle = housingGrad;
    ctx.fill();

    // Emissive cyan strip along top of housing
    const cyanAlpha = isFiringNow ? 0.95 : (0.3 + warmProg * 0.65);
    ctx.fillStyle = `rgba(0,200,255,${cyanAlpha.toFixed(3)})`;
    ctx.fillRect(-9, -29, 18, 2.5);

    // Capacitor banks (two cylinders flanking the barrel)
    for (const cx2 of [-8, 8]) {
      const capBrightness = isFiringNow ? 1.0 : (0.1 + warmProg * 0.9);
      const capR = Math.round(200 * capBrightness);
      const capG = Math.round(230 * capBrightness);
      const capB = Math.round(255 * capBrightness);
      const capGrad = ctx.createLinearGradient(cx2 - 4, 0, cx2 + 4, 0);
      capGrad.addColorStop(0, '#1A1E28');
      capGrad.addColorStop(0.3, `rgb(${capR},${capG},${capB})`);
      capGrad.addColorStop(1, '#1A1E28');
      ctx.beginPath();
      ctx.moveTo(cx2 - 3, 2); ctx.lineTo(cx2 + 3, 2);
      ctx.lineTo(cx2 + 3, -28); ctx.lineTo(cx2 - 3, -28);
      ctx.closePath();
      ctx.fillStyle = capGrad;
      ctx.fill();

      // Capacitor glow when charging/firing
      if (warmProg > 0.1 || isFiringNow) {
        ctx.save();
        ctx.shadowColor = `rgba(0,200,255,${capBrightness})`;
        ctx.shadowBlur = 8 + capBrightness * 8;
        ctx.fillStyle = `rgba(0,200,255,${(capBrightness * 0.15).toFixed(3)})`;
        ctx.beginPath();
        ctx.rect(cx2 - 3, -28, 6, 30);
        ctx.fill();
        ctx.restore();
      }
    }

    // Barrel — long thin with focusing rings
    ctx.fillStyle = '#2A3040';
    ctx.fillRect(-3.5, -30, 7, -34); // from y=-30 to y=-64 (tip)

    // Barrel highlight stripe
    ctx.fillStyle = 'rgba(100,150,255,0.15)';
    ctx.fillRect(-1.5, -30, 3, -34);

    // 3 focusing rings along barrel
    for (const ry of [-38, -50, -60]) {
      // Barrel tremor during late warm-up (last 30%)
      const tremor = (warmProg > 0.7 && !isFiringNow)
        ? (Math.random() - 0.5) * 2.5 : 0;
      ctx.beginPath();
      ctx.arc(tremor, ry, 5.5, 0, TAU);
      ctx.fillStyle = '#1A1E28';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(tremor, ry, 4.5, 0, TAU);
      ctx.strokeStyle = '#3A4258';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Ring glow when charging/firing
      if (warmProg > 0 || isFiringNow) {
        const ringAlpha = isFiringNow ? 0.7 : warmProg * 0.5;
        ctx.save();
        ctx.shadowColor = `rgba(0,200,255,${ringAlpha})`;
        ctx.shadowBlur = 6;
        ctx.strokeStyle = `rgba(0,200,255,${ringAlpha.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(tremor, ry, 4.5, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Heat sink fins at back of housing
    for (let f = 0; f < 4; f++) {
      const finX = -16 + f * 8;
      ctx.fillStyle = '#2A3040';
      ctx.beginPath();
      ctx.moveTo(finX, 4); ctx.lineTo(finX - 3, -4); ctx.lineTo(finX + 3, -4); ctx.closePath();
      ctx.fill();
    }

    // ── Lens aperture at barrel tip ─────────────────────────────
    const lensY = -64;
    // Barrel tremor for lens too
    const lensTremor = (warmProg > 0.7 && !isFiringNow)
      ? (Math.random() - 0.5) * 2.5 : 0;

    // Lens glow radius increases during warm-up
    const lensR = isFiringNow ? 6.5 : (2 + warmProg * 4.5);
    const lensGlowAlpha = isFiringNow ? 1.0 : warmProg;

    // Lens base
    ctx.beginPath();
    ctx.arc(lensTremor, lensY, lensR + 1, 0, TAU);
    ctx.fillStyle = '#0A0C12';
    ctx.fill();

    // Lens emissive core
    if (warmProg > 0.05 || isFiringNow) {
      ctx.save();
      ctx.shadowColor = isFiringNow ? '#FFFFFF' : '#00C8FF';
      ctx.shadowBlur = isFiringNow ? 20 : 10 * warmProg;
      const lensGrad = ctx.createRadialGradient(lensTremor, lensY, 0, lensTremor, lensY, lensR);
      lensGrad.addColorStop(0, isFiringNow ? 'rgba(255,255,255,0.95)' : `rgba(200,230,255,${lensGlowAlpha.toFixed(2)})`);
      lensGrad.addColorStop(0.5, isFiringNow ? 'rgba(100,200,255,0.8)' : `rgba(0,200,255,${(lensGlowAlpha * 0.6).toFixed(2)})`);
      lensGrad.addColorStop(1, 'rgba(0,180,255,0)');
      ctx.beginPath();
      ctx.arc(lensTremor, lensY, lensR, 0, TAU);
      ctx.fillStyle = lensGrad;
      ctx.fill();
      ctx.restore();
    }

    // ── Progress ring during warm-up ─────────────────────────────
    if (this.laserState === 'warming' && warmProg > 0.02) {
      ctx.save();
      ctx.translate(0, lensY);
      ctx.rotate(-Math.PI / 2); // start at top
      // Track ring (dim)
      ctx.strokeStyle = 'rgba(0,100,150,0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, lensR + 5, 0, TAU);
      ctx.stroke();
      // Progress arc (bright cyan → white)
      const progressR = Math.round(lerp(0, 255, warmProg));
      const progressG = Math.round(lerp(200, 255, warmProg));
      ctx.save();
      ctx.shadowColor = 'rgba(0,200,255,0.8)';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = `rgb(${progressR},${progressG},255)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, lensR + 5, 0, TAU * warmProg);
      ctx.stroke();
      ctx.restore();
      ctx.restore();
    }

    ctx.restore(); // end turret rotation

    // Damage overlay — base platform bounds
    this._drawDamageOverlay(ctx, 46, 32, 4);

    ctx.restore(); // end entity position

    // ── Charge particles (world space, drawn outside rotation) ───────
    if (this._chargeParticles.length > 0) {
      ctx.save();
      for (const p of this._chargeParticles) {
        const progress = p.age / p.life;
        const alpha = (1 - progress) * 0.85;
        const size = p.size * (1 - progress * 0.5);
        ctx.save();
        ctx.shadowColor = 'rgba(0,200,255,0.8)';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, TAU);
        ctx.fillStyle = `rgba(100,200,255,${alpha.toFixed(3)})`;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    // ── Impact sparks ─────────────────────────────────────────────────
    if (this._impactSparks.length > 0) {
      ctx.save();
      for (const s of this._impactSparks) {
        const alpha = Math.max(0, 1 - s.age / s.life);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2, 0, TAU);
        ctx.fillStyle = `rgba(255,255,200,${alpha.toFixed(3)})`;
        ctx.fill();
      }
      ctx.restore();
    }

    // ── Sustained damage ring for heavy targets ─────────────────────
    if (this._beamHitEntity && this._beamHitEntity.alive && this.laserState === 'firing') {
      const ent = this._beamHitEntity;
      const threshold = getLaserThreshold(ent);
      if (threshold > THRESHOLD_INSTANT) {
        const accumulated = this._beamDamageMap.get(ent) || 0;
        const ringProgress = clamp(accumulated / threshold, 0, 1);
        ctx.save();
        ctx.translate(ent.x, ent.y);
        ctx.rotate(-Math.PI / 2);
        // Background ring
        ctx.strokeStyle = 'rgba(255,100,50,0.3)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, (ent.collisionRadius || 20) + 8, 0, TAU);
        ctx.stroke();
        // Progress arc (orange → red)
        if (ringProgress > 0) {
          ctx.save();
          ctx.shadowColor = '#FF4400';
          ctx.shadowBlur = 8;
          ctx.strokeStyle = `rgba(255,${Math.round(100 * (1 - ringProgress))},50,0.9)`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, (ent.collisionRadius || 20) + 8, 0, TAU * ringProgress);
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }
    }
  }

  /**
   * Draw the beam — called from game.render() AFTER entities.draw()
   * so the beam appears on top of all entities.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawBeam(ctx) {
    if (!this.alive || this.laserState !== 'firing') return;

    const tip = this.getLaunchPosition();
    const ex = this.beamEndX;
    const ey = this.beamEndY;

    ctx.save();

    // ── Layer 1: Outer glow (wide, semi-transparent) ────────────────
    ctx.shadowBlur = 0;
    const outerW = 16 + (Math.random() - 0.5) * 6;
    ctx.strokeStyle = 'rgba(0,180,255,0.08)';
    ctx.lineWidth = outerW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // ── Layer 2: Mid beam (with jitter) ────────────────────────────
    const midAlpha = 0.45 + (Math.random() - 0.5) * 0.2;
    ctx.strokeStyle = `rgba(100,200,255,${midAlpha.toFixed(3)})`;
    ctx.lineWidth = 5 + (Math.random() - 0.5) * 2;
    ctx.beginPath();
    if (this._jitterPoints.length > 0) {
      ctx.moveTo(tip.x, tip.y);
      for (const pt of this._jitterPoints) {
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.lineTo(ex, ey);
    } else {
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(ex, ey);
    }
    ctx.stroke();

    // ── Layer 3: Core beam (bright white, thin) ─────────────────────
    ctx.save();
    ctx.shadowColor = '#00AAFF';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();

    // ── Origin flare (starburst at lens aperture) ───────────────────
    ctx.save();
    ctx.shadowColor = '#FFFFFF';
    ctx.shadowBlur = 15;
    const flareGrad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 18);
    flareGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
    flareGrad.addColorStop(0.3, 'rgba(100,200,255,0.5)');
    flareGrad.addColorStop(1, 'rgba(0,100,255,0)');
    ctx.fillStyle = flareGrad;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 18, 0, TAU);
    ctx.fill();
    // Starburst cross
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    const starSize = 14;
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2 + this._elapsed * 2;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x + Math.cos(angle) * starSize, tip.y + Math.sin(angle) * starSize);
      ctx.stroke();
    }
    ctx.restore();

    // ── Impact flash at beam end ────────────────────────────────────
    if (this._beamHitEntity && this._beamHitEntity.alive) {
      ctx.save();
      ctx.shadowColor = '#FFFFFF';
      ctx.shadowBlur = 20;
      const flashR = 8 + Math.random() * 6;
      const flashGrad = ctx.createRadialGradient(ex, ey, 0, ex, ey, flashR * 2);
      flashGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
      flashGrad.addColorStop(0.4, 'rgba(100,200,255,0.5)');
      flashGrad.addColorStop(1, 'rgba(0,100,255,0)');
      ctx.fillStyle = flashGrad;
      ctx.beginPath();
      ctx.arc(ex, ey, flashR * 2, 0, TAU);
      ctx.fill();
      // Red-shift overlay to show damage being applied
      ctx.fillStyle = 'rgba(255,100,50,0.25)';
      ctx.beginPath();
      ctx.arc(ex, ey, flashR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }
}

// ── Private math helpers ──────────────────────────────────────────────────

/**
 * Angle interpolation (shortest path).
 * @param {number} from
 * @param {number} to
 * @param {number} t — lerp factor (already multiplied by dt)
 * @returns {number}
 */
function lerpAngle(from, to, t) {
  let diff = to - from;
  // Wrap to [-π, π]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * Math.min(1, t);
}

/**
 * Linear interpolation.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}
