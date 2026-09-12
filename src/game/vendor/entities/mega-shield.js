/**
 * MegaShield — temporary force-field dome that blocks all enemies except nukes.
 *
 * Geometry (corrected):
 *   - Dome = upper semi-ellipse of an ellipse centered at (BASE_X, BASE_Y)
 *   - Ellipse radii: halfW=1200 (x), HEIGHT=800 (y)
 *   - Dome base at y=BASE_Y=1240 (terrain), apex at y=BASE_Y-HEIGHT=440
 *   - isPointInside: py<=BASE_Y AND ((px-BASE_X)/halfW)^2 + ((py-BASE_Y)/HEIGHT)^2 <= 1
 *
 * Visual design:
 *   - Interior fill: very subtle radial gradient (blue tint)
 *   - Hex grid: flat-top hexes, R=60, shimmer animation
 *   - Edge glow: 3 passes (core 4px, mid 12px, outer 30px)
 *   - Fade in: clip rect expands upward from BASE_Y
 *   - Fade out: clip rect collapses back to BASE_Y
 *   - Impact flashes at deflection points
 *   - Nuke penetration: full dome red fill pulse + 3 expanding red rings
 *
 * Draw order (two-pass):
 *   - drawInterior(ctx): interior + hex grid — called BEFORE entities
 *   - drawGlow(ctx):     edge glow           — called AFTER entities
 */

import { Entity } from './entity.js';

const HALF_W  = 1200;
const HEIGHT  = 800;
const BASE_X  = 1300;
const BASE_Y  = 1240;

const FADE_IN  = 0.3;
const ACTIVE   = 4.4;
const FADE_OUT = 0.3;

const HEX_R    = 60;                    // flat-top hex radius
const HEX_DX   = HEX_R * 1.5;          // column step (flat-top horizontal offset)
const HEX_DY   = HEX_R * Math.sqrt(3); // row step

/**
 * Compute the 6 corners of a flat-top hexagon centered at (cx, cy) with radius r.
 * Flat-top: first corner at angle 0.
 * @param {number} cx @param {number} cy @param {number} r
 * @returns {Array<{x:number, y:number}>}
 */
function hexCorners(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// Pre-compute hex grid centers inside the dome.
// Dome = upper semi-ellipse: ellipse center at (BASE_X, BASE_Y), radii (HALF_W, HEIGHT).
// A hex center (wx, wy) is inside if wy <= BASE_Y and the ellipse test passes.
const HEX_GRID = (function buildGrid() {
  const centers = [];
  const hw = HALF_W;
  const hh = HEIGHT;
  // Ellipse center
  const eCX = BASE_X;
  const eCY = BASE_Y;

  // Range of columns/rows to cover the dome
  const colMax = Math.ceil(hw / HEX_DX) + 2;
  const rowMax = Math.ceil(hh / HEX_DY) + 2;

  for (let col = -colMax; col <= colMax; col++) {
    for (let row = -rowMax; row <= rowMax; row++) {
      // Flat-top hex: odd columns shift row by half
      const localX = col * HEX_DX;
      const localY = row * HEX_DY + (Math.abs(col) % 2 !== 0 ? HEX_DY * 0.5 : 0);

      // World position
      const wx = eCX + localX;
      const wy = eCY + localY;

      // Only upper dome (y <= BASE_Y, i.e. localY <= 0 and wy <= eCY)
      if (wy > eCY) continue;

      // Ellipse test: (dx/hw)^2 + (dy/hh)^2 <= 1
      const dx = wx - eCX;
      const dy = wy - eCY;
      const nd = Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
      if (nd > 1.0) continue;

      centers.push({ cx: wx, cy: wy, nd });
    }
  }
  return centers;
})();

/** Impact flash record */
class ImpactFlash {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.elapsed = 0;
    this.duration = 0.35;
  }
}

/** Nuke penetration ring record */
class NukePenRing {
  constructor(x, y, phaseOffset = 0) {
    this.x = x;
    this.y = y;
    this.elapsed = phaseOffset;
    this.duration = 0.6;
  }
}

export class MegaShield extends Entity {
  constructor() {
    super(BASE_X, BASE_Y);
    this.groups.add('shield');
    this.collisionRadius = 0; // collision handled via isPointInside

    /** @type {'fadein'|'active'|'fadeout'|'done'} */
    this._phase = 'fadein';
    this._phaseTimer = 0;
    this._elapsed = 0;    // total alive time for shimmer animation
    this._alpha = 0;

    /** @type {ImpactFlash[]} */
    this._impacts = [];

    /** @type {NukePenRing[]} */
    this._nukeRings = [];

    this._nukeRedTimer = 0;
    this._nukeRedDuration = 0.5;

    // Set to a function by game.js for the warning beep
    this.onWarningBeep = null;
    this._warningBeepFired = false;
  }

  /**
   * Test whether world point (px, py) is inside the shield dome.
   * Dome = upper semi-ellipse centered at (BASE_X, BASE_Y).
   * @param {number} px @param {number} py
   * @returns {boolean}
   */
  isPointInside(px, py) {
    if (py > BASE_Y) return false;   // below terrain
    const dx = px - BASE_X;
    const dy = py - BASE_Y;
    return (dx / HALF_W) ** 2 + (dy / HEIGHT) ** 2 <= 1.0;
  }

  /**
   * Record a deflection impact at world (x, y).
   * @param {number} x @param {number} y
   */
  onDeflect(x, y) {
    this._impacts.push(new ImpactFlash(x, y));
    if (this._impacts.length > 20) this._impacts.shift();
  }

  /**
   * Nuke punches through — red flash, lose 2s of active duration.
   * @param {number} x — impact world x
   * @param {number} y — impact world y
   */
  onNukePenetration(x = BASE_X, y = BASE_Y - HEIGHT * 0.5) {
    this._nukeRedTimer = this._nukeRedDuration;
    for (let i = 0; i < 3; i++) {
      this._nukeRings.push(new NukePenRing(x, y, i * 0.08));
    }

    // Lose 2s from active phase
    if (this._phase === 'active') {
      const remaining = ACTIVE - this._phaseTimer;
      if (remaining > 2.0) {
        this._phaseTimer += 2.0;
      } else {
        this._phase = 'fadeout';
        this._phaseTimer = 0;
      }
    }
  }

  /** @param {number} dt */
  update(dt) {
    this._elapsed += dt;
    this._phaseTimer += dt;

    // Tick effects
    for (const imp of this._impacts) imp.elapsed += dt;
    this._impacts = this._impacts.filter(i => i.elapsed < i.duration);

    for (const ring of this._nukeRings) ring.elapsed += dt;
    this._nukeRings = this._nukeRings.filter(r => r.elapsed < r.duration);

    if (this._nukeRedTimer > 0) {
      this._nukeRedTimer = Math.max(0, this._nukeRedTimer - dt);
    }

    // Phase state machine
    switch (this._phase) {
      case 'fadein': {
        this._alpha = Math.min(this._phaseTimer / FADE_IN, 1);
        if (this._phaseTimer >= FADE_IN) {
          this._phase = 'active';
          this._phaseTimer = 0;
        }
        break;
      }
      case 'active': {
        this._alpha = 1;
        const remaining = ACTIVE - this._phaseTimer;
        if (remaining <= 1.5 && !this._warningBeepFired) {
          this._warningBeepFired = true;
          if (this.onWarningBeep) this.onWarningBeep();
        }
        if (this._phaseTimer >= ACTIVE) {
          this._phase = 'fadeout';
          this._phaseTimer = 0;
        }
        break;
      }
      case 'fadeout': {
        this._alpha = Math.max(1 - this._phaseTimer / FADE_OUT, 0);
        if (this._phaseTimer >= FADE_OUT) {
          this._phase = 'done';
          this.alive = false;
        }
        break;
      }
    }
  }

  // ── Drawing helpers ───────────────────────────────────────────────────────

  /**
   * Trace the dome semi-ellipse path (upper half of ellipse at BASE_Y).
   * Creates a closed path: arc from right to left (counter-clockwise through apex),
   * then closes along the base line.
   * @param {CanvasRenderingContext2D} ctx
   */
  _traceDomePath(ctx) {
    ctx.beginPath();
    // Upper semi-ellipse: start at right (0), go counter-clockwise to left (π)
    // In canvas (Y-down), anticlockwise=true sweeps UP through the apex
    ctx.ellipse(BASE_X, BASE_Y, HALF_W, HEIGHT, 0, 0, Math.PI, true);
    ctx.closePath(); // closes from left base back to right base along a straight line
  }

  /**
   * Trace just the curved arc edge (no fill closure).
   * @param {CanvasRenderingContext2D} ctx
   */
  _traceArcEdge(ctx) {
    ctx.beginPath();
    ctx.ellipse(BASE_X, BASE_Y, HALF_W, HEIGHT, 0, 0, Math.PI, true);
    // Don't close — we just want the arc for stroking
  }

  /**
   * The clip rect: covers from (BASE_Y - clipH) down to BASE_Y.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} revealFrac 0..1
   */
  _applyRevealClip(ctx, revealFrac) {
    const clipH = HEIGHT * revealFrac;
    ctx.beginPath();
    ctx.rect(BASE_X - HALF_W - 40, BASE_Y - clipH, HALF_W * 2 + 80, clipH + 2);
    ctx.clip();
  }

  /**
   * Draw the interior of the dome: fill + hex grid.
   * Call BEFORE entities.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawInterior(ctx) {
    if (this._alpha <= 0) return;

    const alpha = this._alpha;
    const t = this._elapsed;

    const revealFrac = this._phase === 'fadein'
      ? this._phaseTimer / FADE_IN
      : this._phase === 'fadeout'
        ? 1 - this._phaseTimer / FADE_OUT
        : 1;

    ctx.save();
    this._applyRevealClip(ctx, revealFrac);

    // ── 1. Interior radial fill ──────────────────────────────────────────────
    const innerGrad = ctx.createRadialGradient(
      BASE_X, BASE_Y, 0,
      BASE_X, BASE_Y, Math.max(HALF_W, HEIGHT)
    );
    innerGrad.addColorStop(0, `rgba(0,100,180,0.00)`);
    innerGrad.addColorStop(1, `rgba(0,40,100,${(0.12 * alpha).toFixed(4)})`);

    this._traceDomePath(ctx);
    ctx.fillStyle = innerGrad;
    ctx.fill();

    // ── 2. Hex grid ──────────────────────────────────────────────────────────
    const shimmerSpeed = 1.5;
    const shimmerWave = 0.4;

    ctx.lineWidth = 1;
    ctx.setLineDash([]);

    for (const cell of HEX_GRID) {
      const edgeFactor = Math.max(0, cell.nd - 0.55) / 0.45;
      const shimmerPhase = (cell.cx / HALF_W) * Math.PI * 3 - t * shimmerSpeed * Math.PI * 2;
      const shimmer = 0.5 + shimmerWave * Math.sin(shimmerPhase);
      const hexAlpha = alpha * (0.10 + 0.25 * edgeFactor) * shimmer;

      if (hexAlpha < 0.012) continue;

      const corners = hexCorners(cell.cx, cell.cy, HEX_R - 1);
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = `rgba(0,180,255,${hexAlpha.toFixed(4)})`;
      ctx.stroke();
    }

    // ── 3. Impact hex brightening ────────────────────────────────────────────
    for (const imp of this._impacts) {
      const flashFrac = 1 - imp.elapsed / imp.duration;
      const flashR = 200;

      for (const cell of HEX_GRID) {
        const dx = cell.cx - imp.x;
        const dy = cell.cy - imp.y;
        if (dx * dx + dy * dy > flashR * flashR) continue;
        const proximity = 1 - Math.sqrt(dx * dx + dy * dy) / flashR;
        const fa = alpha * flashFrac * proximity * 0.8;
        if (fa < 0.01) continue;

        const corners = hexCorners(cell.cx, cell.cy, HEX_R - 1);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.fillStyle = `rgba(128,223,255,${fa.toFixed(4)})`;
        ctx.fill();
      }
    }

    // ── 4. Nuke penetration red pulse ────────────────────────────────────────
    if (this._nukeRedTimer > 0) {
      const redFrac = this._nukeRedTimer / this._nukeRedDuration;
      this._traceDomePath(ctx);
      ctx.fillStyle = `rgba(220,20,20,${(0.22 * redFrac * alpha).toFixed(4)})`;
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw the edge glow of the dome.
   * Call AFTER entities.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawGlow(ctx) {
    if (this._alpha <= 0) return;

    const alpha = this._alpha;

    const revealFrac = this._phase === 'fadein'
      ? this._phaseTimer / FADE_IN
      : this._phase === 'fadeout'
        ? 1 - this._phaseTimer / FADE_OUT
        : 1;

    ctx.save();
    this._applyRevealClip(ctx, revealFrac);

    // Pass 1: outer ambient glow (30px)
    ctx.save();
    ctx.shadowColor = '#00BFFF';
    ctx.shadowBlur = 30;
    ctx.strokeStyle = `rgba(0,191,255,${(0.18 * alpha).toFixed(4)})`;
    ctx.lineWidth = 30;
    this._traceArcEdge(ctx);
    ctx.stroke();
    ctx.restore();

    // Pass 2: mid glow (12px)
    ctx.save();
    ctx.shadowColor = '#00BFFF';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = `rgba(64,200,255,${(0.55 * alpha).toFixed(4)})`;
    ctx.lineWidth = 12;
    this._traceArcEdge(ctx);
    ctx.stroke();
    ctx.restore();

    // Pass 3: core bright line (4px)
    ctx.save();
    ctx.shadowColor = '#00BFFF';
    ctx.shadowBlur = 30;
    ctx.strokeStyle = `rgba(128,223,255,${(0.90 * alpha).toFixed(4)})`;
    ctx.lineWidth = 4;
    this._traceArcEdge(ctx);
    ctx.stroke();
    ctx.restore();

    // ── Impact flashes: burst lines + expanding ring ─────────────────────────
    for (const imp of this._impacts) {
      const flashFrac = 1 - imp.elapsed / imp.duration;
      const burstR = 20 + 60 * (1 - flashFrac);

      ctx.save();
      ctx.globalAlpha = alpha * flashFrac * 0.8;
      ctx.strokeStyle = '#80DFFF';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00BFFF';
      ctx.shadowBlur = 10;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r0 = 10;
        ctx.beginPath();
        ctx.moveTo(imp.x + Math.cos(a) * r0, imp.y + Math.sin(a) * r0);
        ctx.lineTo(imp.x + Math.cos(a) * burstR, imp.y + Math.sin(a) * burstR);
        ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha * flashFrac * 0.6;
      ctx.beginPath();
      ctx.arc(imp.x, imp.y, 20 + 100 * (1 - flashFrac), 0, Math.PI * 2);
      ctx.strokeStyle = '#80DFFF';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#00BFFF';
      ctx.shadowBlur = 15;
      ctx.stroke();
      ctx.restore();
    }

    // ── Nuke penetration rings ────────────────────────────────────────────────
    for (const ring of this._nukeRings) {
      const frac = 1 - ring.elapsed / ring.duration;
      const ringR = 30 + 300 * (ring.elapsed / ring.duration);

      ctx.save();
      ctx.globalAlpha = alpha * frac * 0.7;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = '#FF2020';
      ctx.lineWidth = 4;
      ctx.shadowColor = '#FF0000';
      ctx.shadowBlur = 20;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // Standard draw() is a no-op — two-pass rendering handled by game.js
  draw(ctx) { /* intentionally empty */ }
}
