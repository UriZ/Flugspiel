/**
 * MushroomCloud — dramatic 7-layer nuclear detonation effect spawned on nuke impact.
 * Purely visual (no collision).
 *
 * Phases:
 *  Layer 1: Ground fireball dome (0-1.5s)
 *  Layer 2: Dust ring with radial streaks (0-3.0s)
 *  Layer 3: Hourglass stem with bezier profile + altitude heat gradient
 *  Layer 4: Mushroom cap via ctx.ellipse(), cauliflower bumps around perimeter
 *  Layer 5: Neck connector (stem-cap junction skirt)
 *  Layer 6: Internal billows within cap
 *  Layer 7: Crown puffs rising above cap (after 2.5s)
 */

import { Entity } from './entity.js';
import { TAU, clamp, randf } from '../utils.js';

const CLOUD_LIFETIME       = 9.0;   // Total lifetime in seconds
const STEM_RISE_SPEED      = 220;   // px/s initial rise speed
const CAP_MAX_RADIUS       = 320;   // Maximum mushroom cap radius
const CAP_EXPAND_DURATION  = 3.0;   // Seconds to reach full cap size
const STEM_MAX_WIDTH       = 120;   // Stem base half-width * 2
const STEM_MIN_WIDTH       = 55;    // Hourglass pinch width at mid-height
const MAX_STEM_HEIGHT      = 520;   // Tallest stem height
const DUST_RING_MAX        = 480;   // Ground shockwave max radius
const BILLOW_COUNT         = 18;    // Internal cap billows
const CAULIFLOWER_COUNT    = 14;    // Bumps around cap perimeter

export class MushroomCloud extends Entity {
  constructor(x, y) {
    super(x, y);
    this.groups.add('effects');

    this.elapsed = 0;

    // Stem state
    this.stemHeight = 0;
    this.maxStemHeight = MAX_STEM_HEIGHT;

    // Cap state
    this.capRadius = 0;
    this.capDrift = 0;  // upward drift during dissipation

    // Billowing internal clouds
    this.billows = [];
    for (let i = 0; i < BILLOW_COUNT; i++) {
      this.billows.push({
        angle: randf(0, TAU),
        dist:  randf(0.2, 0.8),
        size:  randf(0.4, 0.9),
        phase: randf(0, TAU),
        speed: randf(1.5, 3.0),
      });
    }

    // Cauliflower bumps around cap perimeter
    this.cauliflowerBumps = Array.from({ length: CAULIFLOWER_COUNT }, (_, i) => ({
      phase:  (i / CAULIFLOWER_COUNT) * Math.PI * 2,
      speed:  randf(1.2, 2.2),
      size:   randf(0.7, 1.3),
      wobble: randf(0, Math.PI * 2),
    }));

    // Stem turbulence vortices
    this.stemTurbulence = Array.from({ length: 6 }, (_, i) => ({
      side:  i % 2 === 0 ? 1 : -1,
      phase: randf(0, Math.PI * 2),
      speed: randf(2.0, 3.5),
    }));

    // Crown puffs rising above cap
    this.crownPuffs = Array.from({ length: 5 }, (_, i) => ({
      xOff:  randf(-0.3, 0.3),
      yOff:  -0.5 - i * 0.12,
      size:  randf(0.12, 0.18),
      phase: randf(0, Math.PI * 2),
    }));

    // Dust ring
    this.dustRingRadius = 0;
  }

  update(dt) {
    this.elapsed += dt;

    if (this.elapsed >= CLOUD_LIFETIME) {
      this.destroy();
      return;
    }

    // Stem rises quickly then decelerates
    const stemProgress = clamp(this.elapsed / 3.0, 0, 1);
    this.stemHeight = this.maxStemHeight * (1 - Math.pow(1 - stemProgress, 2.5));

    // Cap expands after a brief delay
    const capStart = 0.4;
    if (this.elapsed > capStart) {
      const capProgress = clamp((this.elapsed - capStart) / CAP_EXPAND_DURATION, 0, 1);
      this.capRadius = CAP_MAX_RADIUS * (1 - Math.pow(1 - capProgress, 2));
    }

    // Dust ring expands quickly
    const dustProgress = clamp(this.elapsed / 2.0, 0, 1);
    this.dustRingRadius = DUST_RING_MAX * (1 - Math.pow(1 - dustProgress, 2.5));

    // Cap upward drift during dissipation
    if (this.elapsed > 4.0) {
      this.capDrift += dt * 12;
    }
  }

  draw(ctx) {
    const progress   = clamp(this.elapsed / CLOUD_LIFETIME, 0, 1);
    // Fade starts at 6.0s, completes at 9.0s
    const fadeAlpha  = this.elapsed < 6.0
      ? 1.0
      : clamp(1 - (this.elapsed - 6.0) / 3.0, 0, 1);

    if (fadeAlpha < 0.01) return;

    // Stem width multiplier — thins during dissipation
    const stemWidthMult = this.elapsed > 6.0
      ? clamp(1 - (this.elapsed - 6.0) / 3.0, 0.2, 1)
      : 1;

    const stemH    = this.stemHeight;
    const capR     = this.capRadius;
    const capY     = -stemH - this.capDrift;

    ctx.save();
    ctx.translate(this.x, this.y);

    // ==================================================================
    // Spec 5 — Layer 0: Detonation flash (first 0.15s)
    // ==================================================================
    if (this.elapsed < 0.15) {
      const flashT = this.elapsed / 0.15;   // 0→1
      const flashAlpha = 1 - flashT;

      // Full-screen white flash (caller ctx is translated, so use negative offset)
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${(flashAlpha * 0.85).toFixed(3)})`;
      // fillRect uses translated origin — reach back to screen edges
      ctx.fillRect(-this.x, -this.y, 2560, 1440);
      ctx.restore();

      // Shrinking white-hot core
      const coreR = 180 * (1 - flashT) + 20;
      ctx.save();
      const coreGrad = ctx.createRadialGradient(0, -10, 0, 0, -10, coreR);
      coreGrad.addColorStop(0,   `rgba(255,255,255,${flashAlpha.toFixed(3)})`);
      coreGrad.addColorStop(0.4, `rgba(255,240,180,${(flashAlpha * 0.7).toFixed(3)})`);
      coreGrad.addColorStop(1,   `rgba(255,160,40,0)`);
      ctx.beginPath();
      ctx.arc(0, -10, coreR, 0, TAU);
      ctx.fillStyle = coreGrad;
      ctx.fill();
      ctx.restore();
    }

    // ==================================================================
    // Spec 6 — Scorchmark: persistent ground-level dark ellipse
    // ==================================================================
    if (this.elapsed > 0.1 && this.dustRingRadius > 8) {
      const scorch = ctx.createRadialGradient(0, 0, 0, 0, 0, this.dustRingRadius * 0.65);
      scorch.addColorStop(0,   `rgba(10,5,0,${(fadeAlpha * 0.55).toFixed(3)})`);
      scorch.addColorStop(0.5, `rgba(30,12,4,${(fadeAlpha * 0.35).toFixed(3)})`);
      scorch.addColorStop(1,   `rgba(0,0,0,0)`);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, this.dustRingRadius * 0.65, this.dustRingRadius * 0.18, 0, 0, TAU);
      ctx.fillStyle = scorch;
      ctx.fill();
      // Fading orange inner (only visible up to 3s)
      if (this.elapsed < 3.0 && this.dustRingRadius * 0.06 > 1) {
        const orangeA = fadeAlpha * (1 - this.elapsed / 3.0) * 0.45;
        const innerScorch = ctx.createRadialGradient(0, 0, 0, 0, 0, this.dustRingRadius * 0.22);
        innerScorch.addColorStop(0, `rgba(255,120,10,${orangeA.toFixed(3)})`);
        innerScorch.addColorStop(1, `rgba(180,50,5,0)`);
        ctx.beginPath();
        ctx.ellipse(0, 0, this.dustRingRadius * 0.22, this.dustRingRadius * 0.06, 0, 0, TAU);
        ctx.fillStyle = innerScorch;
        ctx.fill();
      }
      ctx.restore();
    }

    // ==================================================================
    // Layer 1: Ground Fireball Dome (0-1.5s)
    // ==================================================================
    if (this.elapsed < 1.5) {
      const fireProgress = clamp(this.elapsed / 1.5, 0, 1);
      const baseFireR = 90 * (1 - Math.pow(1 - clamp(this.elapsed / 0.4, 0, 1), 2));
      const fireAlpha = 0.9 * (1 - fireProgress);

      if (baseFireR > 1) {
        // White-hot core
        ctx.beginPath();
        ctx.arc(0, -8, baseFireR * 0.3, 0, TAU);
        ctx.fillStyle = `rgba(255,255,200,${fireAlpha.toFixed(3)})`;
        ctx.fill();

        // Yellow fire
        ctx.beginPath();
        ctx.arc(0, -8, baseFireR * 0.6, 0, TAU);
        ctx.fillStyle = `rgba(255,180,40,${(fireAlpha * 0.8).toFixed(3)})`;
        ctx.fill();

        // Orange outer
        ctx.beginPath();
        ctx.arc(0, -8, baseFireR, 0, TAU);
        ctx.fillStyle = `rgba(255,80,10,${(fireAlpha * 0.5).toFixed(3)})`;
        ctx.fill();
      }
    }

    // ==================================================================
    // Layer 2: Ground Dust Ring with radial streaks (0-3.0s)
    // ==================================================================
    if (this.elapsed < 3.0 && this.dustRingRadius > 5) {
      const dustProgress = clamp(this.elapsed / 2.0, 0, 1);
      const dustAlpha    = fadeAlpha * Math.max(0, 1 - this.elapsed / 2.5) * 0.7;

      if (dustAlpha > 0.01) {
        // Outer stroke
        ctx.beginPath();
        ctx.arc(0, 0, this.dustRingRadius, 0, TAU);
        ctx.strokeStyle = `rgba(180,140,80,${(dustAlpha * 0.4).toFixed(3)})`;
        ctx.lineWidth = 28;
        ctx.stroke();

        // Mid stroke
        ctx.beginPath();
        ctx.arc(0, 0, this.dustRingRadius * 0.75, 0, TAU);
        ctx.strokeStyle = `rgba(220,160,80,${(dustAlpha * 0.5).toFixed(3)})`;
        ctx.lineWidth = 18;
        ctx.stroke();

        // Inner fire glow fill
        ctx.beginPath();
        ctx.arc(0, 0, this.dustRingRadius * 0.3, 0, TAU);
        ctx.fillStyle = `rgba(255,120,40,${(dustAlpha * 0.3).toFixed(3)})`;
        ctx.fill();

        // Spec 10: 16 radial dust streaks with varying length and width
        for (let i = 0; i < 16; i++) {
          const angle   = (i / 16) * TAU;
          const innerR  = this.dustRingRadius * 0.3;
          // Alternate longer/shorter streaks
          const lengthMult = (i % 2 === 0) ? 1.0 : 0.72;
          const outerR  = this.dustRingRadius * lengthMult;
          const lw      = (i % 2 === 0) ? 3 : 1.5;
          ctx.strokeStyle = `rgba(160,130,80,${(dustAlpha * (i % 2 === 0 ? 0.32 : 0.18)).toFixed(3)})`;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * innerR, Math.sin(angle) * innerR);
          ctx.lineTo(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
          ctx.stroke();
        }
      }
    }

    // ==================================================================
    // Spec 7 — Layer 2b: Ring of Fire shockwave (0-3.5s)
    // ==================================================================
    if (this.elapsed < 3.5 && this.dustRingRadius > 10) {
      const fireRingAlpha = fadeAlpha * clamp(1 - this.elapsed / 3.5, 0, 1) * 0.65;
      if (fireRingAlpha > 0.01) {
        const fr = this.dustRingRadius * 0.55;
        // Outer fire ring
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, fr, 0, TAU);
        ctx.strokeStyle = `rgba(255,140,20,${(fireRingAlpha * 0.8).toFixed(3)})`;
        ctx.lineWidth = 18;
        ctx.stroke();
        // Inner brighter ring
        ctx.beginPath();
        ctx.arc(0, 0, fr * 0.85, 0, TAU);
        ctx.strokeStyle = `rgba(255,220,80,${(fireRingAlpha * 0.55).toFixed(3)})`;
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.restore();
      }
    }

    // ==================================================================
    // Layer 3: Stem Body (hourglass bezier profile)
    // ==================================================================
    if (stemH > 5) {
      const stemAlpha = fadeAlpha * 0.85;

      // Hourglass dimensions
      const halfBase  = (STEM_MAX_WIDTH / 2) * stemWidthMult;   // 60
      const halfPinch = (STEM_MIN_WIDTH / 2) * stemWidthMult;   // 27
      const halfTop   = halfPinch * 1.4;                        // ~38

      // Spec 8: Stem gradient recolor — orange-red base → charcoal mid → ash-grey top
      const stemGrad = ctx.createLinearGradient(0, 0, 0, -stemH);
      stemGrad.addColorStop(0,    `rgba(200,60,20,${stemAlpha.toFixed(3)})`);
      stemGrad.addColorStop(0.15, `rgba(160,50,18,${stemAlpha.toFixed(3)})`);
      stemGrad.addColorStop(0.35, `rgba(60,50,45,${stemAlpha.toFixed(3)})`);
      stemGrad.addColorStop(0.58, `rgba(55,52,50,${stemAlpha.toFixed(3)})`);
      stemGrad.addColorStop(1.0,  `rgba(168,160,155,${(stemAlpha * 0.9).toFixed(3)})`);

      // Helper to trace the stem bezier path (used twice below)
      const traceStemPath = () => {
        ctx.beginPath();
        ctx.moveTo(-halfBase, 0);
        ctx.bezierCurveTo(-halfBase, -stemH * 0.2, -halfPinch, -stemH * 0.35, -halfPinch, -stemH * 0.45);
        ctx.bezierCurveTo(-halfPinch, -stemH * 0.55, -halfTop, -stemH * 0.7, -halfTop, -stemH);
        ctx.lineTo(halfTop, -stemH);
        ctx.bezierCurveTo(halfTop, -stemH * 0.7, halfPinch, -stemH * 0.55, halfPinch, -stemH * 0.45);
        ctx.bezierCurveTo(halfPinch, -stemH * 0.35, halfBase, -stemH * 0.2, halfBase, 0);
        ctx.closePath();
      };

      traceStemPath();
      ctx.fillStyle = stemGrad;
      ctx.fill();

      // Spec 8: left-to-right roundness clip pass on stem
      ctx.save();
      traceStemPath();
      ctx.clip();
      const stemRoundGrad = ctx.createLinearGradient(-halfBase, 0, halfBase, 0);
      stemRoundGrad.addColorStop(0.00, 'rgba(0,0,0,0.55)');
      stemRoundGrad.addColorStop(0.20, 'rgba(0,0,0,0.25)');
      stemRoundGrad.addColorStop(0.50, 'rgba(255,255,255,0.06)');
      stemRoundGrad.addColorStop(0.80, 'rgba(0,0,0,0.25)');
      stemRoundGrad.addColorStop(1.00, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = stemRoundGrad;
      ctx.fillRect(-halfBase, -stemH, halfBase * 2, stemH);
      ctx.restore();

      // Stem turbulence vortices
      const turbAlpha = stemAlpha * 0.4;
      const vortexPositions = [0.2, 0.3, 0.45, 0.55, 0.65, 0.75];
      for (let i = 0; i < 6; i++) {
        const vp = vortexPositions[i];
        const vy = -stemH * vp;
        // Width at this stem position (linearly interpolated)
        let widthAtV;
        if (vp < 0.45) {
          // Narrowing from base to pinch
          widthAtV = halfBase + (halfPinch - halfBase) * (vp / 0.45);
        } else {
          // Widening from pinch to top
          widthAtV = halfPinch + (halfTop - halfPinch) * ((vp - 0.45) / 0.55);
        }
        const t = this.stemTurbulence[i];
        const wobbleOffset = Math.cos(this.elapsed * t.speed + t.phase) * widthAtV * 0.25 * t.side;
        const ellW = widthAtV * 0.35 * stemWidthMult;
        const ellH = widthAtV * 0.25 * stemWidthMult;
        ctx.beginPath();
        ctx.ellipse(wobbleOffset, vy, Math.max(ellW, 1), Math.max(ellH, 1), 0, 0, TAU);
        ctx.fillStyle = `rgba(60,45,30,${turbAlpha.toFixed(3)})`;
        ctx.fill();
      }

      // Base fire glow on stem (fades in first 1.0s)
      if (this.elapsed < 1.0) {
        const fireAlpha = 0.7 * (1 - this.elapsed / 1.0);
        const fireGrad = ctx.createRadialGradient(0, -5, 0, 0, -5, 85);
        fireGrad.addColorStop(0, `rgba(255,160,30,${fireAlpha.toFixed(3)})`);
        fireGrad.addColorStop(1, `rgba(255,60,10,0)`);
        ctx.beginPath();
        ctx.arc(0, -5, 85, 0, TAU);
        ctx.fillStyle = fireGrad;
        ctx.fill();
      }
    }

    // ==================================================================
    // Layer 4: Mushroom Cap (ellipse API, no ctx.scale)
    // ==================================================================
    if (capR > 5) {
      const capAlpha = fadeAlpha * 0.8;
      const vertR = capR * 0.55;  // vertical radius — slightly flattened

      // Pass A — outer shadow/depth ring (slightly offset and larger)
      ctx.beginPath();
      ctx.ellipse(0, capY + capR * 0.05, capR * 1.05, vertR * 1.05, 0, 0, TAU);
      ctx.fillStyle = `rgba(80,60,40,${(capAlpha * 0.6).toFixed(3)})`;
      ctx.fill();

      // Spec 9: Pass B — cap gradient ash-white center → dark brown edge
      const capGrad = ctx.createRadialGradient(0, capY, 0, 0, capY, capR);
      capGrad.addColorStop(0,    `rgba(230,225,218,${(capAlpha * 0.95).toFixed(3)})`);
      capGrad.addColorStop(0.30, `rgba(195,185,175,${(capAlpha * 0.90).toFixed(3)})`);
      capGrad.addColorStop(0.60, `rgba(120,100,82,${(capAlpha * 0.85).toFixed(3)})`);
      capGrad.addColorStop(1,    `rgba(60,45,35,${(capAlpha * 0.75).toFixed(3)})`);
      ctx.beginPath();
      ctx.ellipse(0, capY, capR, vertR, 0, 0, TAU);
      ctx.fillStyle = capGrad;
      ctx.fill();

      // Spec 9: Pass C — cauliflower bumps with directional lighting (upper-left at 225°)
      // Light direction: upper-left → light angle = -135° from positive-x = 225° = Math.PI * 1.25
      const LIGHT_ANGLE = Math.PI * 1.25; // 225 degrees
      const lightDX = Math.cos(LIGHT_ANGLE); // ~-0.707
      const lightDY = Math.sin(LIGHT_ANGLE); // ~-0.707

      for (let i = 0; i < CAULIFLOWER_COUNT; i++) {
        const bump = this.cauliflowerBumps[i];
        const angle = (i / CAULIFLOWER_COUNT) * TAU;
        const bumpCX = Math.cos(angle) * capR * 0.88;
        const bumpCY = capY + Math.sin(angle) * vertR * 0.88;
        const bumpR  = capR * 0.18 * bump.size;
        const wOffset = 6 * Math.cos(this.elapsed * bump.speed + bump.phase);
        const wx = bumpCX + Math.cos(angle) * wOffset;
        const wy = bumpCY + Math.sin(angle) * wOffset * 0.55;

        // Directional lighting: dot product of outward normal vs light direction
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);
        const dot = clamp(nx * (-lightDX) + ny * (-lightDY), 0, 1); // 0=shadow, 1=lit

        // Base bump color shaded by lighting
        const shade = Math.round(100 + dot * 80);       // 100 (dark) → 180 (lit)
        const shadeB = Math.round(80 + dot * 60);
        ctx.beginPath();
        ctx.arc(wx, wy, Math.max(bumpR, 1), 0, TAU);
        ctx.fillStyle = `rgba(${shade},${Math.round(shade * 0.88)},${shadeB},${(capAlpha * 0.82).toFixed(3)})`;
        ctx.fill();

        // Inner highlight (lit side only)
        if (dot > 0.3) {
          const hiAlpha = capAlpha * dot * 0.45;
          ctx.beginPath();
          ctx.arc(wx + lightDX * bumpR * 0.25, wy + lightDY * bumpR * 0.25,
                  Math.max(bumpR * 0.5, 1), 0, TAU);
          ctx.fillStyle = `rgba(230,220,210,${hiAlpha.toFixed(3)})`;
          ctx.fill();
        }
      }

      // Pass D — bright crown top (early phase)
      if (capR > 60 && progress < 0.65) {
        const crownAlpha = capAlpha * (1 - progress / 0.65);
        ctx.beginPath();
        ctx.ellipse(0, capY - capR * 0.22, capR * 0.45, capR * 0.2, 0, 0, TAU);
        ctx.fillStyle = `rgba(210,180,140,${(crownAlpha * 0.55).toFixed(3)})`;
        ctx.fill();
      }
    }

    // ==================================================================
    // Spec 11 — Layer 5: Neck connector — stem-cap junction skirt (gradient)
    // ==================================================================
    if (stemH > 5 && capR > 10) {
      const neckAlpha = fadeAlpha * 0.7;
      const halfTop = (STEM_MIN_WIDTH / 2) * 1.4 * stemWidthMult;
      const skirtBase = capY + 20;

      // Vertical gradient: light at top (cap junction), dark at bottom (stem)
      const neckGrad = ctx.createLinearGradient(0, capY, 0, skirtBase);
      neckGrad.addColorStop(0,   `rgba(185,172,158,${neckAlpha.toFixed(3)})`);
      neckGrad.addColorStop(0.5, `rgba(120,100,80,${neckAlpha.toFixed(3)})`);
      neckGrad.addColorStop(1,   `rgba(60,45,32,${neckAlpha.toFixed(3)})`);

      ctx.beginPath();
      ctx.moveTo(-halfTop, capY);
      ctx.lineTo(-capR * 0.25, skirtBase);
      ctx.lineTo( capR * 0.25, skirtBase);
      ctx.lineTo( halfTop, capY);
      ctx.closePath();
      ctx.fillStyle = neckGrad;
      ctx.fill();
    }

    // ==================================================================
    // Layer 6: Internal Billows within cap
    // ==================================================================
    if (capR > 5) {
      const capAlpha = fadeAlpha * 0.8;
      const vertR = capR * 0.55;

      ctx.save();
      // Clip to cap ellipse so billows don't bleed outside
      ctx.beginPath();
      ctx.ellipse(0, capY, capR, vertR, 0, 0, TAU);
      ctx.clip();

      for (const b of this.billows) {
        const bx = Math.cos(b.angle + this.elapsed * b.speed * 0.3) * capR * b.dist;
        const rawBy = Math.sin(b.phase + this.elapsed * b.speed * 0.5) * capR * b.dist * 0.5;
        const by = Math.min(rawBy, vertR * 0.7);
        const bs = capR * b.size * 0.35;
        ctx.beginPath();
        ctx.arc(bx, capY + by, Math.max(bs, 1), 0, TAU);
        ctx.fillStyle = `rgba(100,75,55,${(capAlpha * 0.35).toFixed(3)})`;
        ctx.fill();
      }

      ctx.restore();
    }

    // ==================================================================
    // Layer 7: Top Crown Smoke Puffs (after 2.5s)
    // ==================================================================
    if (this.elapsed > 2.5 && capR > 30) {
      const puffAlpha = fadeAlpha * clamp((this.elapsed - 2.5) / 1.0, 0, 1);
      for (const puff of this.crownPuffs) {
        const px = puff.xOff * capR;
        const py = capY + puff.yOff * capR;
        const pr = capR * puff.size;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(pr, 1), 0, TAU);
        ctx.fillStyle = `rgba(190,170,155,${(puffAlpha * 0.4).toFixed(3)})`;
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
