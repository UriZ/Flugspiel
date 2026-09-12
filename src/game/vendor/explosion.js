/**
 * Procedural explosion effect — translated from explosion.gd.
 * Multi-phase visual: flash, fireball, shockwave, debris, sparks, cinders,
 * smoke wisps, secondary pops, heat distortion, ground scorch, lingering embers.
 */

import { Entity } from './entities/entity.js';
import { TAU, clamp, randf, randi, moveToward, pickRandom, dist } from './utils.js';

export class Explosion extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   * @param {boolean} isMega
   */
  constructor(x, y, isMega = false) {
    super(x, y);
    this.isMega = isMega;

    // Timing
    this.elapsed = 0;
    this.totalLifetime = isMega ? 2.8 : 2.0;

    // Fireball
    this.fireballRadius = 0;
    this.fireballMaxRadius = isMega ? 80 : 40;
    this.shockwaveRadius = 0;
    this.shockwaveMaxRadius = isMega ? 220 : 120;
    this.glowAlpha = 1;
    this.heatShimmerOffset = 0;
    this.flashAlpha = 1;

    // Scorch rings
    const numRings = isMega ? 6 : 4;
    this.scorchRings = [];
    for (let i = 0; i < numRings; i++) {
      this.scorchRings.push({
        radius: randf(8, this.fireballMaxRadius * 0.8),
        angle: randf(0, TAU),
        width: randf(2, 5),
      });
    }

    // Aftermath systems
    this.debrisChunks = this._spawnDebrisChunks();
    this.sparkTrails = this._spawnSparkTrails();
    this.cinders = this._spawnCinders();
    this.smokeWisps = this._spawnSmokeWisps();
    this.secondaryPops = this._spawnSecondaryPops();

    /** @type {function|null} Callback for screen shake */
    this.onShake = null;
  }

  // -----------------------------------------------------------------------
  // Debris generation — exact translation from explosion.gd
  // -----------------------------------------------------------------------

  _spawnDebrisChunks() {
    const count = this.isMega ? 26 : 14;
    const chunks = [];
    const colorOptions = [
      { r: 0.5, g: 0.4, b: 0.3 },   // rock/dirt
      { r: 0.65, g: 0.65, b: 0.6 },  // metal
      { r: 0.35, g: 0.3, b: 0.25 },  // dark debris
      { r: 0.7, g: 0.5, b: 0.2 },    // burnt orange
    ];
    for (let i = 0; i < count; i++) {
      const angle = randf(0, TAU);
      const speed = this.isMega ? randf(120, 380) : randf(80, 260);
      // Pre-generate irregular polygon vertices so shape is stable across frames
      const shape = Math.floor(Math.random() * 3);
      let irregularVerts = null;
      if (shape === 2) {
        const nverts = randi(4, 6);
        irregularVerts = [];
        for (let v = 0; v < nverts; v++) {
          irregularVerts.push({
            angleFrac: TAU * v / nverts,
            dist: randf(0.5, 1.0),
          });
        }
      }
      chunks.push({
        px: 0, py: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed + randf(-80, -20),
        rot: 0,
        spin: randf(-15, 15),
        size: this.isMega ? randf(3, 9) : randf(2, 6),
        shape,
        irregularVerts,
        color: pickRandom(colorOptions),
        trail: [], // {x,y} pairs
        alive: true,
        drag: randf(0.3, 0.8),
        onFire: Math.random() < 0.3,
      });
    }
    return chunks;
  }

  _spawnSparkTrails() {
    const count = this.isMega ? 20 : 10;
    const colorOptions = [
      { r: 1, g: 0.9, b: 0.4 },
      { r: 1, g: 0.7, b: 0.2 },
      { r: 1, g: 0.5, b: 0.1 },
      { r: 1, g: 1.0, b: 1.0 }, // white sparks (20%)
    ];
    const sparks = [];
    for (let i = 0; i < count; i++) {
      const angle = randf(0, TAU);
      const speed = this.isMega ? randf(200, 550) : randf(150, 400);
      // 20% white sparks
      const colorIdx = Math.random() < 0.2 ? 3 : randi(0, 2);
      sparks.push({
        px: 0, py: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed + randf(-120, -30),
        trailPoints: [], // {x,y}
        maxTrail: randi(10, 20), // longer trails: 10-20 segments
        lifetime: randf(0.4, 1.0),
        age: 0,
        brightness: randf(0.7, 1.0),
        color: colorOptions[colorIdx],
      });
    }
    return sparks;
  }

  _spawnCinders() {
    const count = this.isMega ? 30 : 15;
    const cinders = [];
    for (let i = 0; i < count; i++) {
      const angle = randf(0, TAU);
      const d = randf(5, this.fireballMaxRadius * 0.8);
      cinders.push({
        px: Math.cos(angle) * d,
        py: Math.sin(angle) * d + randf(-40, -10),
        vx: randf(-15, 15),
        vy: randf(-50, -15),
        size: randf(0.8, 2.5),
        glow: randf(0.5, 1.0),
        wobblePhase: randf(0, TAU),
        wobbleFreq: randf(3, 8),
        lifetime: randf(0.8, this.totalLifetime * 0.85),
        age: 0,
      });
    }
    return cinders;
  }

  _spawnSmokeWisps() {
    const count = this.isMega ? 12 : 7;
    const wisps = [];
    for (let i = 0; i < count; i++) {
      const angle = randf(0, TAU);
      const d = randf(10, this.fireballMaxRadius * 0.5);
      wisps.push({
        baseX: Math.cos(angle) * d,
        baseY: Math.sin(angle) * d,
        offsetY: 0,
        driftX: randf(-12, 12),
        riseSpeed: randf(20, 50),
        size: this.isMega ? randf(6, 16) : randf(4, 10),
        alpha: randf(0.15, 0.35),
        wobblePhase: randf(0, TAU),
        delay: randf(0.1, 0.6),
      });
    }
    return wisps;
  }

  _spawnSecondaryPops() {
    const count = this.isMega ? 8 : 4;
    const pops = [];
    for (let i = 0; i < count; i++) {
      const angle = randf(0, TAU);
      const d = randf(15, this.fireballMaxRadius * 1.2);
      pops.push({
        px: Math.cos(angle) * d,
        py: Math.sin(angle) * d,
        time: randf(0.15, 0.7),
        radius: this.isMega ? randf(8, 22) : randf(5, 14),
        currentRadius: 0,
        alpha: 0,
        fired: false,
      });
    }
    return pops;
  }

  // -----------------------------------------------------------------------
  // Update — translated from _process()
  // -----------------------------------------------------------------------
  update(dt) {
    this.elapsed += dt;
    const progress = clamp(this.elapsed / this.totalLifetime, 0, 1);
    const gravityY = 320;

    // Auto-destroy
    if (this.elapsed >= this.totalLifetime) {
      this.destroy();
      return;
    }

    // Phase 1: Flash (0-0.08s)
    if (this.elapsed < 0.08) {
      this.flashAlpha = 1.0 - (this.elapsed / 0.08);
    } else {
      this.flashAlpha = 0;
    }

    // Phase 2: Fireball expansion and fade
    const fireballDuration = this.isMega ? 0.6 : 0.4;
    if (this.elapsed < fireballDuration) {
      const fbProgress = this.elapsed / fireballDuration;
      this.fireballRadius = this.fireballMaxRadius * (1.0 - Math.pow(1.0 - fbProgress, 3.0));
      this.glowAlpha = 1.0 - Math.pow(fbProgress, 2.0);
    } else {
      this.glowAlpha = 0;
    }

    // Phase 3: Shockwave ring expansion
    const shockStart = 0.02;
    const shockDuration = this.isMega ? 0.8 : 0.5;
    if (this.elapsed > shockStart && this.elapsed < shockStart + shockDuration) {
      const shockProgress = (this.elapsed - shockStart) / shockDuration;
      this.shockwaveRadius = this.shockwaveMaxRadius * shockProgress;
    } else {
      this.shockwaveRadius = 0;
    }

    // Heat shimmer wobble
    this.heatShimmerOffset = Math.sin(this.elapsed * 25) * 3 * Math.max(0, 1 - progress * 1.5);

    // Debris chunks physics
    for (const chunk of this.debrisChunks) {
      if (!chunk.alive) continue;
      chunk.vy += gravityY * dt;
      chunk.vx *= (1 - chunk.drag * dt);
      chunk.vy *= (1 - chunk.drag * dt);
      chunk.px += chunk.vx * dt;
      chunk.py += chunk.vy * dt;
      chunk.rot += chunk.spin * dt;
      // Trail
      const tLen = chunk.trail.length;
      if (tLen === 0 || dist(chunk.px, chunk.py, chunk.trail[tLen - 1].x, chunk.trail[tLen - 1].y) > 8) {
        chunk.trail.push({ x: chunk.px, y: chunk.py });
        if (chunk.trail.length > 8) chunk.trail.shift();
      }
      if (chunk.py > 300 || this.elapsed > this.totalLifetime * 0.9) {
        chunk.alive = false;
      }
    }

    // Spark trails physics
    for (const spark of this.sparkTrails) {
      spark.age += dt;
      if (spark.age > spark.lifetime) continue;
      spark.vy += gravityY * 1.5 * dt;
      spark.vx *= 0.97;
      spark.vy *= 0.97;
      spark.px += spark.vx * dt;
      spark.py += spark.vy * dt;
      spark.trailPoints.push({ x: spark.px, y: spark.py });
      if (spark.trailPoints.length > spark.maxTrail) spark.trailPoints.shift();
    }

    // Cinders
    for (const cinder of this.cinders) {
      cinder.age += dt;
      if (cinder.age > cinder.lifetime) continue;
      const wobble = Math.sin(cinder.age * cinder.wobbleFreq + cinder.wobblePhase) * 20;
      cinder.vx = wobble;
      cinder.vy += 15 * dt;
      cinder.px += cinder.vx * dt;
      cinder.py += cinder.vy * dt;
      cinder.glow = 0.4 + 0.6 * Math.abs(Math.sin(cinder.age * 8 + cinder.wobblePhase));
    }

    // Secondary pops
    for (const pop of this.secondaryPops) {
      if (!pop.fired && this.elapsed >= pop.time) {
        pop.fired = true;
        pop.alpha = 1.0;
        pop.currentRadius = pop.radius * 0.3;
      }
      if (pop.fired && pop.alpha > 0) {
        pop.currentRadius = moveToward(pop.currentRadius, pop.radius, dt * pop.radius * 6);
        pop.alpha = moveToward(pop.alpha, 0, dt * 4);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Draw — translated from _draw()
  // -----------------------------------------------------------------------
  draw(ctx) {
    const progress = clamp(this.elapsed / this.totalLifetime, 0, 1);
    const hs = this.heatShimmerOffset;

    ctx.save();
    ctx.translate(this.x, this.y);

    // === White flash overlay ===
    if (this.flashAlpha > 0.01) {
      const flashSize = this.fireballMaxRadius * 3;
      ctx.beginPath();
      ctx.arc(0, 0, flashSize, 0, TAU);
      ctx.fillStyle = `rgba(255,255,242,${(this.flashAlpha * 0.7).toFixed(3)})`;
      ctx.fill();
    }

    // === Fireball glow (5-layer circles with blue-white core) ===
    if (this.glowAlpha > 0.01 && this.fireballRadius > 1) {
      const outerR = this.fireballRadius * 1.3;
      // Layer 1: outer orange haze — rgba(255,70,0,0.38)
      ctx.beginPath();
      ctx.arc(hs * 0.3, 0, outerR, 0, TAU);
      ctx.fillStyle = `rgba(255,70,0,${(this.glowAlpha * 0.38).toFixed(3)})`;
      ctx.fill();
      // Layer 2: mid orange — rgba(255,140,20,0.58)
      ctx.beginPath();
      ctx.arc(-hs * 0.2, hs * 0.1, this.fireballRadius, 0, TAU);
      ctx.fillStyle = `rgba(255,140,20,${(this.glowAlpha * 0.58).toFixed(3)})`;
      ctx.fill();
      // Layer 3: inner yellow — rgba(255,220,100,0.85)
      const innerR = this.fireballRadius * 0.55;
      ctx.beginPath();
      ctx.arc(hs * 0.15, -hs * 0.1, innerR, 0, TAU);
      ctx.fillStyle = `rgba(255,220,100,${(this.glowAlpha * 0.85).toFixed(3)})`;
      ctx.fill();
      // Layer 4: center white — rgba(255,255,255,0.95)
      const centerR = this.fireballRadius * 0.25;
      ctx.beginPath();
      ctx.arc(0, 0, centerR, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${(this.glowAlpha * 0.95).toFixed(3)})`;
      ctx.fill();
      // Layer 5: blue-white core at 5% radius — rgba(200,220,255,0.9)
      const coreR = this.fireballRadius * 0.05;
      if (coreR > 1) {
        ctx.beginPath();
        ctx.arc(0, 0, coreR, 0, TAU);
        ctx.fillStyle = `rgba(200,220,255,${(this.glowAlpha * 0.9).toFixed(3)})`;
        ctx.fill();
      }
    }

    // === Double shockwave ring ===
    if (this.shockwaveRadius > 5) {
      const shockProgress = this.shockwaveRadius / this.shockwaveMaxRadius;
      const ringAlpha = (1 - shockProgress) * 0.4;
      // Primary shockwave — 8px mega, 4px normal
      const primaryWidth = this.isMega ? 8 : 4;
      ctx.beginPath();
      ctx.arc(0, 0, this.shockwaveRadius, 0, TAU);
      ctx.strokeStyle = `rgba(255,217,128,${ringAlpha.toFixed(3)})`;
      ctx.lineWidth = primaryWidth;
      ctx.stroke();
      // Secondary shockwave at 0.7x radius, 50% alpha
      const secondaryR = this.shockwaveRadius * 0.7;
      if (secondaryR > 5) {
        const secondaryAlpha = ringAlpha * 0.5;
        const secondaryWidth = this.isMega ? 4 : 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, secondaryR, 0, TAU);
        ctx.strokeStyle = `rgba(255,200,100,${secondaryAlpha.toFixed(3)})`;
        ctx.lineWidth = secondaryWidth;
        ctx.stroke();
      }
    }

    // === Secondary pops ===
    for (const pop of this.secondaryPops) {
      if (pop.fired && pop.alpha > 0.01) {
        const r = pop.currentRadius;
        // Inner glow
        ctx.beginPath();
        ctx.arc(pop.px, pop.py, r, 0, TAU);
        ctx.fillStyle = `rgba(255,179,51,${(pop.alpha * 0.6).toFixed(3)})`;
        ctx.fill();
        // Hot center
        ctx.beginPath();
        ctx.arc(pop.px, pop.py, r * 0.5, 0, TAU);
        ctx.fillStyle = `rgba(255,230,128,${(pop.alpha * 0.8).toFixed(3)})`;
        ctx.fill();
        // Outer ring
        ctx.beginPath();
        ctx.arc(pop.px, pop.py, r * 1.3, 0, TAU);
        ctx.strokeStyle = `rgba(255,153,38,${(pop.alpha * 0.3).toFixed(3)})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // === Debris chunk smoke trails + yellow tail streaks ===
    for (const chunk of this.debrisChunks) {
      const trail = chunk.trail;
      if (trail.length >= 2) {
        for (let k = 0; k < trail.length - 1; k++) {
          const tProgress = k / trail.length;
          const trailAlpha = tProgress * 0.2 * (1 - progress);
          if (trailAlpha < 0.005) continue;
          ctx.beginPath();
          ctx.moveTo(trail[k].x, trail[k].y);
          ctx.lineTo(trail[k + 1].x, trail[k + 1].y);
          if (chunk.onFire) {
            ctx.strokeStyle = `rgba(230,102,26,${(trailAlpha * 1.5).toFixed(3)})`;
            ctx.lineWidth = 2.5;
          } else {
            ctx.strokeStyle = `rgba(77,77,77,${trailAlpha.toFixed(3)})`;
            ctx.lineWidth = 2;
          }
          ctx.stroke();
        }
        // Yellow tail streak on recent trail segment
        if (trail.length >= 3) {
          const lastIdx = trail.length - 1;
          const prevIdx = trail.length - 3;
          const streakAlpha = (1 - progress) * 0.65;
          if (streakAlpha > 0.01) {
            ctx.beginPath();
            ctx.moveTo(trail[prevIdx].x, trail[prevIdx].y);
            ctx.lineTo(trail[lastIdx].x, trail[lastIdx].y);
            ctx.strokeStyle = `rgba(255,220,50,${streakAlpha.toFixed(3)})`;
            ctx.lineWidth = chunk.onFire ? 2 : 1;
            ctx.stroke();
          }
        }
      }
    }

    // === Debris chunks (polygon shapes) ===
    for (const chunk of this.debrisChunks) {
      if (!chunk.alive) continue;
      const p = chunk;
      const s = chunk.size;
      const r = chunk.rot;
      const ageFade = clamp(1 - progress * 1.1, 0, 1);
      if (ageFade < 0.01) continue;
      const c = chunk.color;

      ctx.save();
      ctx.translate(p.px, p.py);

      if (chunk.shape === 0) {
        // Triangle
        ctx.beginPath();
        ctx.moveTo(Math.cos(r) * s, Math.sin(r) * s);
        ctx.lineTo(Math.cos(r + 2.2) * s * 0.8, Math.sin(r + 2.2) * s * 0.8);
        ctx.lineTo(Math.cos(r + 4.0) * s * 0.6, Math.sin(r + 4.0) * s * 0.6);
        ctx.closePath();
        ctx.fillStyle = `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${ageFade.toFixed(3)})`;
        ctx.fill();
      } else if (chunk.shape === 1) {
        // Rectangle
        const hw = s * 0.5;
        const hh = s * 0.3;
        const cosR = Math.cos(r);
        const sinR = Math.sin(r);
        ctx.beginPath();
        ctx.moveTo(cosR * hw - sinR * hh, sinR * hw + cosR * hh);
        ctx.lineTo(cosR * hw + sinR * hh, sinR * hw - cosR * hh);
        ctx.lineTo(-cosR * hw + sinR * hh, -sinR * hw - cosR * hh);
        ctx.lineTo(-cosR * hw - sinR * hh, -sinR * hw + cosR * hh);
        ctx.closePath();
        ctx.fillStyle = `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${ageFade.toFixed(3)})`;
        ctx.fill();
      } else {
        // Irregular polygon — use pre-generated vertices
        const verts = chunk.irregularVerts;
        ctx.beginPath();
        for (let v = 0; v < verts.length; v++) {
          const a = r + verts[v].angleFrac;
          const d = s * verts[v].dist;
          const px = Math.cos(a) * d;
          const py = Math.sin(a) * d;
          if (v === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${ageFade.toFixed(3)})`;
        ctx.fill();
      }

      // Burning chunk highlight
      if (chunk.onFire) {
        const fireFlicker = 0.6 + 0.4 * Math.sin(this.elapsed * 15 + chunk.spin);
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.4, 0, TAU);
        ctx.fillStyle = `rgba(255,128,26,${(0.4 * fireFlicker * ageFade).toFixed(3)})`;
        ctx.fill();
      }

      ctx.restore();
    }

    // === Spark trails ===
    for (const spark of this.sparkTrails) {
      if (spark.age > spark.lifetime) continue;
      const sparkAlpha = 1 - spark.age / spark.lifetime;
      const trail = spark.trailPoints;
      const sc = spark.color;
      // Trail line segments
      if (trail.length >= 2) {
        for (let k = 0; k < trail.length - 1; k++) {
          const segAlpha = (k / trail.length) * sparkAlpha * spark.brightness;
          if (segAlpha < 0.005) continue;
          ctx.beginPath();
          ctx.moveTo(trail[k].x, trail[k].y);
          ctx.lineTo(trail[k + 1].x, trail[k + 1].y);
          ctx.strokeStyle = `rgba(${(sc.r * 255) | 0},${(sc.g * 255) | 0},${(sc.b * 255) | 0},${segAlpha.toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      // Bright head
      if (trail.length > 0) {
        const head = trail[trail.length - 1];
        ctx.beginPath();
        ctx.arc(head.x, head.y, 1.5, 0, TAU);
        ctx.fillStyle = `rgba(${(sc.r * 255) | 0},${(sc.g * 255) | 0},${(sc.b * 255) | 0},${(sparkAlpha * spark.brightness).toFixed(3)})`;
        ctx.fill();
        // Hot core
        ctx.beginPath();
        ctx.arc(head.x, head.y, 0.8, 0, TAU);
        ctx.fillStyle = `rgba(255,255,230,${(sparkAlpha * 0.8).toFixed(3)})`;
        ctx.fill();
      }
    }

    // === Falling cinders / glowing ash ===
    for (const cinder of this.cinders) {
      if (cinder.age > cinder.lifetime) continue;
      const cinderAlpha = (1 - cinder.age / cinder.lifetime) * 0.7;
      const g = cinder.glow;
      const cs = cinder.size;
      // Glowing ember dot
      ctx.beginPath();
      ctx.arc(cinder.px, cinder.py, cs, 0, TAU);
      ctx.fillStyle = `rgba(255,${((0.4 + g * 0.3) * 255) | 0},26,${(cinderAlpha * g).toFixed(3)})`;
      ctx.fill();
      // Tiny orange halo
      ctx.beginPath();
      ctx.arc(cinder.px, cinder.py, cs * 2, 0, TAU);
      ctx.fillStyle = `rgba(255,77,13,${(cinderAlpha * g * 0.2).toFixed(3)})`;
      ctx.fill();
    }

    // === Smoke wisps rising from blast site ===
    for (let wi = 0; wi < this.smokeWisps.length; wi++) {
      const wisp = this.smokeWisps[wi];
      if (this.elapsed < wisp.delay) continue;
      const wispAge = this.elapsed - wisp.delay;
      const wispAlpha = wisp.alpha * clamp(1 - progress * 1.3, 0, 1);
      if (wispAlpha < 0.01) continue;
      const bx = wisp.baseX + Math.sin(wispAge * 2.5 + wisp.wobblePhase) * wisp.driftX;
      const by = wisp.baseY - wispAge * wisp.riseSpeed;
      const ws = wisp.size + wispAge * 6;
      // Alternate between lighter and darker smoke variants
      const isDark = wi % 3 === 2;
      // Overlapping translucent circles
      ctx.beginPath();
      ctx.arc(bx, by, ws, 0, TAU);
      ctx.fillStyle = isDark
        ? `rgba(38,34,30,${(wispAlpha * 0.55).toFixed(3)})`
        : `rgba(64,56,51,${(wispAlpha * 0.5).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx + ws * 0.3, by - ws * 0.2, ws * 0.7, 0, TAU);
      ctx.fillStyle = isDark
        ? `rgba(48,42,38,${(wispAlpha * 0.38).toFixed(3)})`
        : `rgba(77,69,61,${(wispAlpha * 0.35).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx - ws * 0.2, by - ws * 0.4, ws * 0.5, 0, TAU);
      ctx.fillStyle = isDark
        ? `rgba(30,26,22,${(wispAlpha * 0.28).toFixed(3)})`
        : `rgba(56,51,46,${(wispAlpha * 0.25).toFixed(3)})`;
      ctx.fill();
    }

    // === Heat distortion lines (per-segment fading alpha) ===
    if (progress < 0.7) {
      const heatAlpha = (1 - progress / 0.7) * 0.25;
      const numLines = this.isMega ? 7 : 4;
      for (let i = 0; i < numLines; i++) {
        const xBase = (i - numLines / 2) * 12;
        // Build wave points
        const pts = [];
        for (let j = 0; j < 10; j++) {
          pts.push({
            x: xBase + Math.sin(this.elapsed * 8 + j * 0.7 + i) * 8,
            y: -20 - j * 12 - this.elapsed * 45,
          });
        }
        // Draw individual segments with fading alpha per the Godot source
        ctx.lineWidth = 1.5;
        for (let k = 0; k < pts.length - 1; k++) {
          const segAlpha = heatAlpha * (1 - k / pts.length);
          if (segAlpha < 0.005) continue;
          ctx.beginPath();
          ctx.moveTo(pts[k].x, pts[k].y);
          ctx.lineTo(pts[k + 1].x, pts[k + 1].y);
          ctx.strokeStyle = `rgba(255,153,51,${segAlpha.toFixed(3)})`;
          ctx.stroke();
        }
      }
    }

    // === Ground scorch / burn mark ===
    if (progress > 0.1) {
      const scorchAlpha = clamp((progress - 0.1) * 2, 0, 1) * 0.3;
      const scorchR = this.fireballMaxRadius * 0.6;
      ctx.beginPath();
      ctx.arc(0, 2, scorchR, 0, TAU);
      ctx.fillStyle = `rgba(26,20,13,${scorchAlpha.toFixed(3)})`;
      ctx.fill();
      for (const ring of this.scorchRings) {
        const ptx = Math.cos(ring.angle) * ring.radius * 0.4;
        const pty = Math.sin(ring.angle) * ring.radius * 0.4;
        ctx.beginPath();
        ctx.arc(ptx, pty + 2, ring.width, 0, TAU);
        ctx.fillStyle = `rgba(38,26,13,${(scorchAlpha * 0.5).toFixed(3)})`;
        ctx.fill();
      }
    }

    // === Lingering embers glow (late phase) ===
    if (progress > 0.2 && progress < 0.9) {
      const emberAlpha = Math.sin((progress - 0.2) / 0.7 * Math.PI) * 0.2;
      const emberCount = this.isMega ? 12 : 6;
      for (let i = 0; i < emberCount; i++) {
        const seedAngle = (i / emberCount) * TAU + this.elapsed * 0.5;
        const seedDist = this.fireballMaxRadius * 0.35 * (0.5 + 0.5 * Math.sin(i * 2.3));
        const ex = Math.cos(seedAngle) * seedDist;
        const ey = Math.sin(seedAngle) * seedDist;
        const flicker = 0.5 + 0.5 * Math.sin(this.elapsed * 12 + i * 1.7);
        ctx.beginPath();
        ctx.arc(ex, ey, 2.5 + flicker * 1.5, 0, TAU);
        ctx.fillStyle = `rgba(255,128,26,${(emberAlpha * flicker).toFixed(3)})`;
        ctx.fill();
        // Tiny hot center
        ctx.beginPath();
        ctx.arc(ex, ey, 1, 0, TAU);
        ctx.fillStyle = `rgba(255,217,102,${(emberAlpha * flicker * 0.7).toFixed(3)})`;
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
