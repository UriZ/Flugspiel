import { lerp, clamp, randf, rgba } from './utils.js';

/**
 * DayNightCycle — drives all visual time-of-day changes across one full 8-wave cycle.
 *
 * tod (time-of-day) is a float in [0, 1]:
 *   0.00 = pre-dawn  (dark before first light)
 *   0.12 = dawn      (orange horizon)
 *   0.25 = morning   (bright blue sky)
 *   0.45 = midday    (full brightness)
 *   0.62 = late afternoon (warm golden)
 *   0.75 = dusk      (deep orange-red)
 *   0.87 = twilight  (purple-grey)
 *   1.00 = night     (wraps to 0.00 = pre-dawn next cycle)
 *
 * All color values are [r, g, b] floats in 0..1.
 */

const LOGICAL_W = 2560;
const LOGICAL_H = 1440;

// ── Keyframes ─────────────────────────────────────────────────────────────────

/**
 * Each keyframe describes the full visual palette at a specific time-of-day.
 * Properties:
 *   tod:            float 0..1
 *   sky_top:        [r,g,b] — top of sky gradient
 *   sky_mid:        [r,g,b] — mid sky
 *   sky_bottom:     [r,g,b] — near-horizon sky
 *   ground_top:     [r,g,b] — top of ground fill
 *   ground_bot:     [r,g,b] — bottom of ground fill
 *   grass_top:      [r,g,b] — top of grass layer
 *   grass_bot:      [r,g,b] — bottom of grass layer
 *   haze:           [r,g,b] — atmospheric haze strip
 *   ambient:        [r,g,b] — mountain color ambient tint
 *   stars_alpha:    float 0..1
 *   fog_alpha:      float 0..1 (max fog density when fog is active)
 */
const KEYFRAMES = [
  {
    tod: 0.00,
    sky_top:    [0.02, 0.02, 0.06],
    sky_mid:    [0.04, 0.04, 0.10],
    sky_bottom: [0.06, 0.06, 0.14],
    ground_top: [0.22, 0.17, 0.10],
    ground_bot: [0.12, 0.09, 0.05],
    grass_top:  [0.15, 0.25, 0.10],
    grass_bot:  [0.08, 0.14, 0.06],
    haze:       [0.10, 0.12, 0.20],
    ambient:    [0.08, 0.10, 0.16],
    stars_alpha: 0.95,
    fog_alpha:  0.35,
  },
  {
    tod: 0.12,
    sky_top:    [0.04, 0.04, 0.12],
    sky_mid:    [0.22, 0.10, 0.04],
    sky_bottom: [0.70, 0.35, 0.10],
    ground_top: [0.32, 0.22, 0.12],
    ground_bot: [0.18, 0.12, 0.07],
    grass_top:  [0.22, 0.32, 0.12],
    grass_bot:  [0.12, 0.20, 0.08],
    haze:       [0.55, 0.30, 0.12],
    ambient:    [0.25, 0.16, 0.08],
    stars_alpha: 0.40,
    fog_alpha:  0.25,
  },
  {
    tod: 0.25,
    sky_top:    [0.20, 0.38, 0.65],
    sky_mid:    [0.38, 0.58, 0.80],
    sky_bottom: [0.60, 0.75, 0.90],
    ground_top: [0.38, 0.28, 0.17],
    ground_bot: [0.22, 0.16, 0.10],
    grass_top:  [0.32, 0.55, 0.20],
    grass_bot:  [0.18, 0.35, 0.12],
    haze:       [0.50, 0.65, 0.80],
    ambient:    [0.40, 0.50, 0.65],
    stars_alpha: 0.00,
    fog_alpha:  0.08,
  },
  {
    tod: 0.45,
    sky_top:    [0.22, 0.45, 0.72],
    sky_mid:    [0.42, 0.62, 0.84],
    sky_bottom: [0.65, 0.80, 0.95],
    ground_top: [0.42, 0.32, 0.18],
    ground_bot: [0.25, 0.18, 0.10],
    grass_top:  [0.38, 0.62, 0.22],
    grass_bot:  [0.22, 0.42, 0.14],
    haze:       [0.55, 0.70, 0.82],
    ambient:    [0.55, 0.62, 0.72],
    stars_alpha: 0.00,
    fog_alpha:  0.04,
  },
  {
    tod: 0.62,
    sky_top:    [0.18, 0.32, 0.58],
    sky_mid:    [0.45, 0.52, 0.70],
    sky_bottom: [0.75, 0.65, 0.50],
    ground_top: [0.45, 0.32, 0.16],
    ground_bot: [0.28, 0.18, 0.10],
    grass_top:  [0.35, 0.52, 0.18],
    grass_bot:  [0.20, 0.32, 0.10],
    haze:       [0.70, 0.58, 0.35],
    ambient:    [0.55, 0.48, 0.38],
    stars_alpha: 0.00,
    fog_alpha:  0.05,
  },
  {
    tod: 0.75,
    sky_top:    [0.06, 0.06, 0.20],
    sky_mid:    [0.30, 0.12, 0.06],
    sky_bottom: [0.80, 0.35, 0.10],
    ground_top: [0.35, 0.22, 0.12],
    ground_bot: [0.18, 0.12, 0.07],
    grass_top:  [0.25, 0.35, 0.12],
    grass_bot:  [0.14, 0.20, 0.08],
    haze:       [0.65, 0.30, 0.10],
    ambient:    [0.35, 0.20, 0.12],
    stars_alpha: 0.10,
    fog_alpha:  0.15,
  },
  {
    tod: 0.87,
    sky_top:    [0.04, 0.03, 0.12],
    sky_mid:    [0.10, 0.06, 0.18],
    sky_bottom: [0.22, 0.12, 0.28],
    ground_top: [0.25, 0.16, 0.08],
    ground_bot: [0.14, 0.09, 0.05],
    grass_top:  [0.16, 0.22, 0.09],
    grass_bot:  [0.09, 0.14, 0.06],
    haze:       [0.15, 0.10, 0.22],
    ambient:    [0.14, 0.10, 0.18],
    stars_alpha: 0.70,
    fog_alpha:  0.28,
  },
  {
    tod: 1.00,
    sky_top:    [0.02, 0.02, 0.06],
    sky_mid:    [0.04, 0.04, 0.10],
    sky_bottom: [0.06, 0.06, 0.14],
    ground_top: [0.22, 0.17, 0.10],
    ground_bot: [0.12, 0.09, 0.05],
    grass_top:  [0.15, 0.25, 0.10],
    grass_bot:  [0.08, 0.14, 0.06],
    haze:       [0.10, 0.12, 0.20],
    ambient:    [0.08, 0.10, 0.16],
    stars_alpha: 0.95,
    fog_alpha:  0.35,
  },
];

// Map wave number (1-based) to target tod.
// Cycle runs over 8 waves. Wave 1 starts at dawn (0.15) so biome colors are
// visible from the beginning instead of the near-black pre-dawn (0.0).
// Full cycle: wave1=dawn(0.15), wave2=morning, ..., wave8=pre-dawn, repeating.
function _waveTod(wave) {
  const DAWN_OFFSET = 0.15;
  return (DAWN_OFFSET + ((wave - 1) % 8) / 8) % 1.0;
}

// ── Star data (generated once) ─────────────────────────────────────────────

const NUM_STARS = 180;
const _stars = (() => {
  const out = [];
  // Use a seeded-like deterministic approach so stars don't re-randomize
  // each wave. We just use Math.random() once at module load time.
  for (let i = 0; i < NUM_STARS; i++) {
    out.push({
      x:          Math.random() * LOGICAL_W,
      y:          Math.random() * LOGICAL_H * 0.55, // upper 55% of sky
      r:          0.5 + Math.random() * 2.0,
      twinkleOff: Math.random() * Math.PI * 2,
      twinkleSpd: 0.8 + Math.random() * 1.5,
    });
  }
  return out;
})();

// ── Cloud layer data ─────────────────────────────────────────────────────────

const FAR_CLOUD_COUNT  = 4;
const NEAR_CLOUD_COUNT = 3;

function _makeCloudLayer(count, yMin, yMax, wMin, wMax, speed) {
  const clouds = [];
  for (let i = 0; i < count; i++) {
    const maxBlobs = Math.floor(wMax / 80) + 3;
    clouds.push({
      x:     Math.random() * LOGICAL_W * 1.4 - LOGICAL_W * 0.2,
      y:     yMin + Math.random() * (yMax - yMin),
      w:     wMin + Math.random() * (wMax - wMin),
      h:     (wMin * 0.35) + Math.random() * ((wMax - wMin) * 0.25),
      speed,
      alphaJitter:  Math.random() * 0.1,
      blobJitters:  Array.from({length: maxBlobs}, () => Math.random()),
    });
  }
  return clouds;
}

const _farClouds  = _makeCloudLayer(FAR_CLOUD_COUNT,  80, 280, 180, 380, 8);
const _nearClouds = _makeCloudLayer(NEAR_CLOUD_COUNT, 60, 220, 280, 560, 18);

// ── DayNightCycle ────────────────────────────────────────────────────────────

export class DayNightCycle {
  constructor() {
    /** Current time-of-day, float [0, 1). */
    this.tod = 0.0;

    /** Target tod — set on wave start. */
    this._targetTod = 0.0;

    /** How fast tod lerps toward target (fraction per second). */
    this._lerpSpeed = 0.08;

    /** tod value at last consumeTerrainDirty() check — for dirty detection. */
    this._lastDirtyTod = -1;

    /** Whether terrain needs a color update. */
    this._terrainDirty = true;

    /** Clock for twinkling stars. */
    this._time = 0;

    /** Weather state per wave. */
    this._weatherType = 'none'; // 'none' | 'rain' | 'fog'

    /** Rain drop data — reused each frame. */
    this._rainDrops = (() => {
      const drops = [];
      for (let i = 0; i < 200; i++) {
        drops.push({
          x: Math.random() * LOGICAL_W,
          y: Math.random() * LOGICAL_H,
          len: 12 + Math.random() * 24,
          speed: 600 + Math.random() * 400,
          alpha: 0.2 + Math.random() * 0.35,
        });
      }
      return drops;
    })();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called on wave start to transition tod toward the target for this wave.
   * @param {number} wave — 1-based wave number
   */
  setWave(wave) {
    this._targetTod = _waveTod(wave);

    // Decide weather for this wave (20% chance from wave 3+)
    if (wave >= 3 && Math.random() < 0.20) {
      this._weatherType = Math.random() < 0.5 ? 'rain' : 'fog';
    } else {
      this._weatherType = 'none';
    }
  }

  /**
   * Update tod toward target; call each frame during playing state.
   * @param {number} dt — seconds since last frame
   * @param {number} waveProgress — [0, 1] fraction through current wave (unused for now)
   */
  update(dt, waveProgress) {
    this._time += dt;

    // Lerp tod toward target — handles wrap-around
    const diff = _angleDiff(this.tod, this._targetTod);
    const maxStep = this._lerpSpeed * dt;

    if (Math.abs(diff) <= maxStep) {
      this.tod = this._targetTod;
    } else {
      this.tod = (this.tod + Math.sign(diff) * maxStep + 1.0) % 1.0;
    }

    // Scroll clouds
    for (const c of _farClouds) {
      c.x += c.speed * dt;
      if (c.x > LOGICAL_W + c.w) c.x = -c.w;
    }
    for (const c of _nearClouds) {
      c.x += c.speed * dt;
      if (c.x > LOGICAL_W + c.w) c.x = -c.w;
    }

    // Scroll rain
    for (const d of this._rainDrops) {
      d.y += d.speed * dt;
      if (d.y > LOGICAL_H) {
        d.y = -d.len;
        d.x = Math.random() * LOGICAL_W;
      }
    }
  }

  /**
   * Returns true once when tod has changed enough to warrant a terrain redraw.
   * Resets the flag on consumption.
   * @returns {boolean}
   */
  consumeTerrainDirty() {
    if (this._terrainDirty) {
      this._terrainDirty = false;
      this._lastDirtyTod = this.tod;
      return true;
    }
    // Re-dirty if tod changed more than 3%
    if (Math.abs(this.tod - this._lastDirtyTod) > 0.03) {
      this._lastDirtyTod = this.tod;
      return true;
    }
    return false;
  }

  /** @returns {{ top: number[], mid: number[], bottom: number[] }} */
  getSkyColors() {
    return {
      top:    this._sample('sky_top'),
      mid:    this._sample('sky_mid'),
      bottom: this._sample('sky_bottom'),
    };
  }

  /** @returns {{ top: number[], bottom: number[] }} */
  getGroundColors() {
    return {
      top:    this._sample('ground_top'),
      bottom: this._sample('ground_bot'),
    };
  }

  /** @returns {{ top: number[], bottom: number[] }} */
  getGrassColors() {
    return {
      top:    this._sample('grass_top'),
      bottom: this._sample('grass_bot'),
    };
  }

  /** @returns {number[]} [r, g, b] */
  getHazeColor() {
    return this._sample('haze');
  }

  /** @returns {number[]} [r, g, b] */
  getAmbientColor() {
    return this._sample('ambient');
  }

  /** @returns {number} 0..1 */
  getStarsAlpha() {
    return this._sampleScalar('stars_alpha');
  }

  /**
   * Returns the current sun position for lens-flare effects.
   * Returns null when the sun is not visible (night / twilight).
   * @returns {{ x: number, y: number, alpha: number } | null}
   */
  getSunPosition() {
    const tod = this.tod;
    if (tod < 0.12 || tod > 0.80) return null;
    const t = (tod - 0.12) / (0.80 - 0.12);
    return {
      x:     LOGICAL_W * t,
      y:     900 - Math.sin(t * Math.PI) * 780,
      alpha: Math.min(
        Math.min((tod - 0.12) / 0.08, 1),
        Math.min((0.80 - tod) / 0.08, 1)
      ),
    };
  }

  /**
   * Window light factor: 1.0 at night (all windows lit), 0.0 at midday.
   * @returns {number} 0..1
   */
  getWindowLightFactor() {
    const sa = this._sampleScalar('stars_alpha');
    // stars_alpha tracks darkness well — use it as window lit proxy
    return clamp(sa * 2.0, 0, 1);
  }

  // ── Draw calls ─────────────────────────────────────────────────────────────

  /**
   * Draw 180 twinkling stars. Must be called after sky gradient is drawn.
   * Uses ctx.save()/ctx.restore().
   * @param {CanvasRenderingContext2D} ctx
   */
  drawStars(ctx) {
    const alpha = this.getStarsAlpha();
    if (alpha < 0.01) return;

    ctx.save();
    const t = this._time;

    for (const s of _stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * s.twinkleSpd + s.twinkleOff);
      const a = alpha * (0.5 + 0.5 * twinkle);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (0.8 + 0.2 * twinkle), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw sun (tod 0.12–0.80, parabolic arc) or moon (tod 0.85–0.08).
   * @param {CanvasRenderingContext2D} ctx
   */
  drawCelestialBody(ctx) {
    const tod = this.tod;

    ctx.save();

    // Sun: visible between dawn (0.12) and late dusk (0.80)
    // Arc: peaks at midday (0.45)
    if (tod >= 0.12 && tod <= 0.80) {
      const t = (tod - 0.12) / (0.80 - 0.12); // 0..1 across day
      const sunX = LOGICAL_W * t;
      // Parabolic arc: y = 0 at endpoints, min at t=0.5
      const arcY = 4 * t * (1 - t); // 0..1 normalized arc height
      const sunY = lerp(900, 80, arcY); // high in sky at noon

      // Sun alpha: fade in at dawn, fade out at dusk
      const fadeIn  = clamp((tod - 0.12) / 0.08, 0, 1);
      const fadeOut = clamp((0.80 - tod)  / 0.08, 0, 1);
      const sunAlpha = Math.min(fadeIn, fadeOut);

      // Color: warm orange at dawn/dusk, white-yellow at noon
      const warmth = 1 - arcY; // 1 at horizon, 0 at noon
      const sunR = lerp(1.0, 1.0, 1 - warmth);
      const sunG = lerp(0.55, 0.95, 1 - warmth);
      const sunB = lerp(0.10, 0.70, 1 - warmth);

      const sunRadius = 48;

      // Glow halo
      const halo = ctx.createRadialGradient(sunX, sunY, sunRadius * 0.5, sunX, sunY, sunRadius * 3.5);
      halo.addColorStop(0, `rgba(${(sunR*255)|0},${(sunG*255)|0},${(sunB*255)|0},${(sunAlpha * 0.35).toFixed(3)})`);
      halo.addColorStop(1, 'rgba(255,200,80,0)');
      ctx.fillStyle = halo;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunRadius * 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Sun disc
      ctx.globalAlpha = sunAlpha;
      const disc = ctx.createRadialGradient(sunX - sunRadius * 0.2, sunY - sunRadius * 0.2, 0, sunX, sunY, sunRadius);
      disc.addColorStop(0, `rgba(255,255,${(sunB*255 + 80)|0},1)`);
      disc.addColorStop(1, `rgba(${(sunR*255)|0},${(sunG*255)|0},${(sunB*255)|0},1)`);
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Moon: visible between twilight (0.85) and dawn (0.08, wrapping through 0)
    const moonVisible = tod >= 0.85 || tod <= 0.08;
    if (moonVisible) {
      // Fade alpha at boundaries
      let moonAlpha;
      if (tod >= 0.85) {
        moonAlpha = clamp((tod - 0.85) / 0.05, 0, 1);
      } else {
        moonAlpha = clamp((0.08 - tod) / 0.05, 0, 1);
      }

      const moonX = LOGICAL_W * 0.78; // fixed position
      const moonY = 150;
      const moonR  = 36;

      ctx.globalAlpha = moonAlpha;

      // Moon glow
      const moonGlow = ctx.createRadialGradient(moonX, moonY, moonR, moonX, moonY, moonR * 3);
      moonGlow.addColorStop(0, 'rgba(200,210,255,0.18)');
      moonGlow.addColorStop(1, 'rgba(200,210,255,0)');
      ctx.fillStyle = moonGlow;
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR * 3, 0, Math.PI * 2);
      ctx.fill();

      // Moon disc
      ctx.fillStyle = 'rgba(225,228,240,1)';
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
      ctx.fill();

      // Crescent shadow (bite out of right side slightly)
      ctx.fillStyle = 'rgba(8,8,20,0.55)';
      ctx.beginPath();
      ctx.arc(moonX + moonR * 0.3, moonY, moonR * 0.88, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw 2 cloud layers (8 far + 5 near). Colors adapt to tod.
   * Cloud positions are mutated each frame in update().
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} dt — provided for API symmetry but clouds scroll in update()
   */
  drawClouds(ctx, dt) {
    const starsAlpha = this.getStarsAlpha();
    // Night clouds are barely visible; dawn/dusk clouds glow
    const skyBottom = this._sample('sky_bottom');

    ctx.save();

    // Far clouds — lighter, more transparent
    const farAlpha = lerp(0.08, 0.16, 1 - starsAlpha);
    this._drawCloudLayer(ctx, _farClouds, skyBottom, farAlpha, 0.85);

    // Near clouds — denser, slightly darker
    const nearAlpha = lerp(0.10, 0.20, 1 - starsAlpha);
    const ambient = this._sample('ambient');
    // Near cloud color: blend sky_bottom with ambient
    const nearColor = [
      lerp(skyBottom[0], ambient[0] + 0.1, 0.3),
      lerp(skyBottom[1], ambient[1] + 0.1, 0.3),
      lerp(skyBottom[2], ambient[2] + 0.1, 0.3),
    ];
    this._drawCloudLayer(ctx, _nearClouds, nearColor, nearAlpha, 0.92);

    ctx.restore();
  }

  /**
   * Draw weather effects (rain or fog overlay). Must be called AFTER entities,
   * BEFORE UI.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} dt
   */
  drawWeather(ctx, dt) {
    if (this._weatherType === 'rain') {
      this._drawRain(ctx);
    } else if (this._weatherType === 'fog') {
      this._drawFog(ctx);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Sample a color property at the current tod by lerping between keyframes.
   * @param {string} prop
   * @returns {number[]} [r, g, b]
   */
  _sample(prop) {
    return _sampleCycle(this.tod, prop);
  }

  /**
   * Sample a scalar property at the current tod.
   * @param {string} prop
   * @returns {number}
   */
  _sampleScalar(prop) {
    return _sampleCycleScalar(this.tod, prop);
  }

  _drawCloudLayer(ctx, clouds, color, alpha, alphaVariance) {
    const r = (color[0] * 255) | 0;
    const g = (color[1] * 255) | 0;
    const b = (color[2] * 255) | 0;

    for (const c of clouds) {
      const a = alpha * (alphaVariance + (1 - alphaVariance) * c.alphaJitter);
      ctx.globalAlpha = clamp(a, 0, 1);

      // Draw cloud as overlapping ellipses
      const blobs = Math.floor(c.w / 80) + 2;
      const stepX = c.w / blobs;

      ctx.fillStyle = `rgb(${r},${g},${b})`;

      for (let i = 0; i < blobs; i++) {
        const bx = c.x + i * stepX;
        const by = c.y + Math.sin(i * 1.3) * c.h * 0.3;
        const bw = stepX * (0.8 + c.blobJitters[i % c.blobJitters.length] * 0.3);
        const bh = c.h * (0.7 + Math.sin(i * 2.1) * 0.2);

        ctx.beginPath();
        ctx.ellipse(bx, by, bw * 0.5, bh * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
  }

  _drawRain(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(160,180,220,1)';
    ctx.lineWidth = 1.2;

    for (const d of this._rainDrops) {
      ctx.globalAlpha = d.alpha;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 2, d.y + d.len);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _drawFog(ctx) {
    ctx.save();

    const fogAlpha = this._sampleScalar('fog_alpha');
    const clampedAlpha = clamp(fogAlpha, 0.05, 0.35);

    // Layered fog: bottom-heavy gradient
    const grad = ctx.createLinearGradient(0, LOGICAL_H * 0.6, 0, LOGICAL_H);
    grad.addColorStop(0, `rgba(180,190,210,0)`);
    grad.addColorStop(0.4, `rgba(180,190,210,${(clampedAlpha * 0.6).toFixed(3)})`);
    grad.addColorStop(1, `rgba(180,190,210,${clampedAlpha.toFixed(3)})`);

    ctx.fillStyle = grad;
    ctx.fillRect(0, LOGICAL_H * 0.6, LOGICAL_W, LOGICAL_H * 0.4);

    ctx.restore();
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Find the two bracketing keyframes for a given tod and lerp between them.
 * Handles the wrap from tod=1.0 → 0.0 by treating the last keyframe
 * (tod=1.0) as equivalent to the first (tod=0.0).
 * @param {number} tod
 * @param {string} prop
 * @returns {number[]} [r, g, b]
 */
function _sampleCycle(tod, prop) {
  const kf = KEYFRAMES;
  const n  = kf.length;

  // Find the upper keyframe index
  let hi = 1;
  while (hi < n - 1 && kf[hi].tod <= tod) hi++;

  const lo = hi - 1;
  const kLo = kf[lo];
  const kHi = kf[hi];

  const span = kHi.tod - kLo.tod;
  const t    = span > 0 ? (tod - kLo.tod) / span : 0;

  const a = kLo[prop];
  const b = kHi[prop];

  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
  ];
}

/**
 * Same as _sampleCycle but for scalar properties (stars_alpha, fog_alpha).
 */
function _sampleCycleScalar(tod, prop) {
  const kf = KEYFRAMES;
  const n  = kf.length;

  let hi = 1;
  while (hi < n - 1 && kf[hi].tod <= tod) hi++;

  const lo = hi - 1;
  const kLo = kf[lo];
  const kHi = kf[hi];

  const span = kHi.tod - kLo.tod;
  const t    = span > 0 ? (tod - kLo.tod) / span : 0;

  return lerp(kLo[prop], kHi[prop], t);
}

/**
 * Shortest signed angular difference between two tod values on the circle [0,1).
 * Result is in (-0.5, 0.5].
 */
function _angleDiff(from, to) {
  let d = to - from;
  if (d > 0.5)  d -= 1.0;
  if (d < -0.5) d += 1.0;
  return d;
}
