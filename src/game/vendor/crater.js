/**
 * Persistent crater/scorch mark — translated from crater.tscn.
 * Static polygons drawn at the explosion site, persisting for the rest of the game.
 */

import { Entity } from './entities/entity.js';

// Polygon data from crater.tscn (Godot PackedVector2Array values)
const OUTER_RIM = [
  -20, -8, -15, -12, -8, -15, 0, -16, 8, -15, 15, -12, 20, -8,
  20, 8, 15, 12, 8, 15, 0, 16, -8, 15, -15, 12, -20, 8,
];
const MIDDLE_RIM = [
  -15, -6, -10, -9, -6, -11, 0, -12, 6, -11, 10, -9, 15, -6,
  15, 6, 10, 9, 6, 11, 0, 12, -6, 11, -10, 9, -15, 6,
];
const INNER_CRATER = [
  -10, -4, -7, -7, -4, -8, 0, -9, 4, -8, 7, -7, 10, -4,
  10, 4, 7, 7, 4, 8, 0, 9, -4, 8, -7, 7, -10, 4,
];

const SCORCHES = [
  { color: 'rgba(13,13,8,0.6)', pts: [-25, -3, -18, -8, -12, -5, -15, 0] },
  { color: 'rgba(13,13,8,0.6)', pts: [18, -8, 25, -3, 22, 2, 15, -2] },
  { color: 'rgba(13,13,8,0.6)', pts: [-8, 18, -3, 25, 3, 22, 0, 15] },
];

const DEBRIS = [
  { color: 'rgba(77,64,51,1)', pts: [-30, 5, -28, 3, -26, 5, -28, 7] },
  { color: 'rgba(77,64,51,1)', pts: [26, -6, 28, -8, 30, -6, 28, -4] },
  { color: 'rgba(77,64,51,1)', pts: [5, 28, 7, 26, 9, 28, 7, 30] },
];

/**
 * Draw a polygon from a flat coordinate array [x0,y0, x1,y1, ...].
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} coords
 * @param {string} fillColor
 * @param {number} ox - offset x (entity world position)
 * @param {number} oy - offset y
 * @param {number} scale - crater scale multiplier
 */
function drawPoly(ctx, coords, fillColor, ox, oy, scale) {
  ctx.beginPath();
  for (let i = 0; i < coords.length; i += 2) {
    const px = ox + coords[i] * scale;
    const py = oy + coords[i + 1] * scale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

// Total time a crater is visible (seconds).
const CRATER_LIFETIME = 3;
// How long before the end the crater begins fading out (seconds).
const CRATER_FADE_DURATION = 2;

export class Crater extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} [scale=1] - size multiplier (mega explosions use larger craters)
   */
  constructor(x, y, scale = 1) {
    super(x, y);
    this.scale = scale;
    this.elapsed = 0;
    this.groups.add('craters');
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= CRATER_LIFETIME) {
      this.destroy();
    }
  }

  /** Returns the current draw alpha [0,1] — 1 until fade starts, then linear to 0. */
  _alpha() {
    const timeLeft = CRATER_LIFETIME - this.elapsed;
    if (timeLeft >= CRATER_FADE_DURATION) return 1;
    return Math.max(0, timeLeft / CRATER_FADE_DURATION);
  }

  draw(ctx) {
    const alpha = this._alpha();
    if (alpha <= 0) return;

    const s = this.scale;
    const ox = this.x;
    const oy = this.y;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Draw layers back to front
    // Scorch marks (lowest layer, extends beyond rim)
    for (const scorch of SCORCHES) {
      drawPoly(ctx, scorch.pts, scorch.color, ox, oy, s);
    }
    // Outer rim
    drawPoly(ctx, OUTER_RIM, 'rgba(38,38,26,1)', ox, oy, s);
    // Middle rim
    drawPoly(ctx, MIDDLE_RIM, 'rgba(31,31,20,1)', ox, oy, s);
    // Inner crater (darkest)
    drawPoly(ctx, INNER_CRATER, 'rgba(20,20,13,1)', ox, oy, s);
    // Debris bits
    for (const deb of DEBRIS) {
      drawPoly(ctx, deb.pts, deb.color, ox, oy, s);
    }

    ctx.restore();
  }
}
