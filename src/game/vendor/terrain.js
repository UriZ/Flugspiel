import { Entity } from './entities/entity.js';
import { rgba, randf, randi, clamp, pickRandom, lerp, TAU } from './utils.js';

const TERRAIN_WIDTH = 2560;
const TERRAIN_DEPTH = 200;
const TERRAIN_RESOLUTION = 8; // pixels between height samples
const GRASS_DEPTH = 20;

// Godot Color helper: darkened / lightened for procedural color variation
function darken(r, g, b, amount) {
  const f = 1 - amount;
  return [r * f, g * f, b * f];
}
function lighten(r, g, b, amount) {
  return [r + (1 - r) * amount, g + (1 - g) * amount, b + (1 - b) * amount];
}

// Godot smoothstep equivalent
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Terrain — deformable heightmap with procedural decorations.
 * Renders to an offscreen canvas for performance; re-renders only on damage.
 */
export class Terrain extends Entity {
  static WIDTH = TERRAIN_WIDTH;
  static DEPTH = TERRAIN_DEPTH;
  static RESOLUTION = TERRAIN_RESOLUTION;

  /**
   * @param {number} baseY - world Y position of the terrain top edge
   * @param {import('./engine/renderer.js').Renderer} renderer
   * @param {import('./biome.js').BiomeSystem|null} [biomeSystem]
   */
  constructor(baseY, renderer, biomeSystem = null) {
    super(0, baseY);
    this.groups.add('terrain');

    this.baseY = baseY;
    this.renderer = renderer;

    // Height samples — Y offset from baseY (0 = top, positive = lower)
    const numPoints = Math.floor(TERRAIN_WIDTH / TERRAIN_RESOLUTION) + 1;
    this.heights = new Float32Array(numPoints);

    // Baseline heights — the pristine generated shape; recovery lerps back to these
    this._baseline = new Float32Array(numPoints);

    // Inter-wave recovery state
    // Set to true between waves; the update() method lerps heights toward _baseline.
    this.recovering = false;
    // Units per second between waves — full range is ~50 units, so 12 u/s ≈ 4s full heal.
    this._recoverySpeed = 12;
    // Units per second during active waves — 9 u/s heals a standard 22-unit crater
    // in ~2.5 seconds, keeping up with the ~2-second impact cadence so craters
    // don't accumulate indefinitely while still feeling like battle damage.
    this._recoverySpeedSlow = 9;
    // Minimum per-column move to consider the terrain visibly changed this frame.
    // Used to avoid triggering a full offscreen re-render for sub-pixel drifts.
    this._recoveryRedrawThreshold = 0.5;
    // (Legacy field — kept for forward compat; no longer used for slow recovery.)
    this._slowRecoveryAccum = 0;
    // Maximum depth a single column can be pushed below its baseline (units).
    // Prevents super missile spam from making permanent bottomless pits.
    this._maxDamageDepth = 55;

    // Decoration data for destruction
    /** @type {Array<{x: number, width: number, drawFn: (ctx: CanvasRenderingContext2D) => void}>} */
    this.decorations = [];

    // Offscreen caching
    this.dirty = true;
    /** @type {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D} | null} */
    this._offscreen = null;

    /** @type {import('./day-night.js').DayNightCycle | null} */
    this._dayNight = null;

    /** @type {import('./biome.js').BiomeSystem | null} */
    this._biomeSystem = biomeSystem;

    // Height modifiers from biome
    const mods = biomeSystem ? biomeSystem.getHeightmapModifiers() : null;
    this._biomeAmpScale  = mods ? mods.amplitudeScale  : 1;
    this._biomeFreqScale = mods ? mods.frequencyScale  : 1;

    this._generateHeights();
    this.spawnDecorations();
  }

  /**
   * Attach (or detach) the day/night cycle. Setting it forces a redraw.
   * @param {import('./day-night.js').DayNightCycle | null} dayNight
   */
  setDayNight(dayNight) {
    this._dayNight = dayNight;
    this.dirty = true;
  }

  // ── Height generation ──────────────────────────────────────

  _generateHeights() {
    const n = this.heights.length;
    const launcherXs = [400, 900, 1400, 1900];
    const flattenRadius = 80;

    // Multiple random phases for varied terrain
    const phase1 = Math.random() * TAU;
    const phase2 = Math.random() * TAU;
    const phase3 = Math.random() * TAU;
    const phase4 = Math.random() * TAU;
    const phase5 = Math.random() * TAU;

    // Canyon/valley positions — 1-3 deep valleys per map
    const numValleys = randi(1, 3);
    const valleys = [];
    for (let vi = 0; vi < numValleys; vi++) {
      valleys.push({
        x: randf(300, TERRAIN_WIDTH - 300),
        depth: randf(12, 24),
        width: randf(200, 400),
      });
    }

    const ampScale  = this._biomeAmpScale  || 1;
    const freqScale = this._biomeFreqScale || 1;

    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_RESOLUTION;

      // Dramatic layered sine hills — 3-4x larger than original
      let h = 0;
      // Large rolling mountains (primary shape)
      h += Math.sin(x * 0.003 * freqScale + phase1) * 52 * ampScale;
      h += Math.sin(x * 0.007 * freqScale + phase2) * 24 * ampScale;
      // Medium ridges (secondary detail)
      h += Math.sin(x * 0.016 * freqScale + phase3) * 12 * ampScale;
      // High-frequency jaggedness (rocky silhouette)
      h += Math.sin(x * 0.038 * freqScale + phase4) * 5  * ampScale;
      h += Math.sin(x * 0.072 * freqScale + phase5) * 2.5 * ampScale;

      // Canyon carving — pull terrain DOWN (positive h = lower surface in our coord system)
      for (const v of valleys) {
        const dist = Math.abs(x - v.x);
        if (dist < v.width) {
          const t = dist / v.width;
          // Smooth U-shaped valley with steep walls
          const valleyShape = 1 - t * t * (3 - 2 * t); // smoothstep reversed
          h += v.depth * valleyShape;
        }
      }

      // Flatten near launcher positions
      let flattenFactor = 1;
      for (const lx of launcherXs) {
        const d = Math.abs(x - lx);
        if (d < flattenRadius) {
          const t = d / flattenRadius;
          flattenFactor = Math.min(flattenFactor, smoothstep(0, 1, t));
        }
      }

      // Clamp: allow much taller peaks (negative = raised terrain) and deeper valleys
      this.heights[i] = clamp(h * flattenFactor - 8, -65, 35);
    }

    // Record the pristine shape so recovery always targets the original baseline.
    this._baseline.set(this.heights);
  }

  // ── Inter-wave recovery ────────────────────────────────────

  /**
   * Called every frame by the entity manager. Handles gradual terrain recovery.
   * Between waves: heals at _recoverySpeed (12 u/s).
   * During waves: heals at _recoverySpeedSlow (9 u/s) — fast enough to visibly
   * heal a standard crater in ~2.5s so dark marks don't accumulate indefinitely.
   * @param {number} dt
   */
  update(dt) {
    const n = this.heights.length;
    const isFast = this.recovering;
    const speed = isFast ? this._recoverySpeed : this._recoverySpeedSlow;
    const step = speed * dt;
    let totalMove = 0;

    for (let i = 0; i < n; i++) {
      const diff = this._baseline[i] - this.heights[i];
      if (Math.abs(diff) < 0.01) {
        // Close enough — snap and skip
        this.heights[i] = this._baseline[i];
        continue;
      }
      // Move toward baseline by at most `step` units, never overshooting.
      const move = Math.sign(diff) * Math.min(Math.abs(diff), step);
      this.heights[i] += move;
      totalMove += Math.abs(move);
    }

    // Redraw whenever any column moved enough to be sub-pixel visible.
    // Both fast (inter-wave) and slow (in-wave) recovery use the same threshold —
    // the old slow-recovery accumulator was causing redraws to be suppressed for
    // several seconds, making craters look permanent even when healing was active.
    if (totalMove >= this._recoveryRedrawThreshold) this.dirty = true;
  }

  // ── Damage ─────────────────────────────────────────────────

  /**
   * Carve a crater in the terrain.
   * @param {number} worldX - hit position in world X
   * @param {number} worldY - hit position in world Y (unused, for API compat)
   * @param {number} [radius=40]
   * @param {number} [depth=30]
   */
  damage(worldX, worldY, radius = 40, depth = 30) {
    const hitX = worldX; // terrain starts at x=0 in world space
    const n = this.heights.length;

    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_RESOLUTION;
      const d = Math.abs(x - hitX);
      if (d < radius) {
        let factor = 1 - d / radius;
        factor *= factor; // quadratic falloff
        this.heights[i] += depth * factor;
        // Hard ceiling: never push below TERRAIN_DEPTH - 10 (absolute floor)
        this.heights[i] = Math.min(this.heights[i], TERRAIN_DEPTH - 10);
        // Per-column cap: never exceed baseline + _maxDamageDepth so repeated
        // hits on the same spot don't produce bottomless permanent craters.
        const maxAllowed = this._baseline[i] + this._maxDamageDepth;
        if (this.heights[i] > maxAllowed) this.heights[i] = maxAllowed;
      }
    }

    this._destroyDecorationsNear(hitX, radius * 1.5);
    this.dirty = true;
  }

  // ── Collision / Query ──────────────────────────────────────

  /**
   * Get interpolated surface Y in world space at a given world X.
   * @param {number} x
   * @returns {number} world Y of the surface
   */
  getHeightAt(x) {
    const fi = x / TERRAIN_RESOLUTION;
    const i = Math.floor(fi);
    const n = this.heights.length;
    if (i < 0) return this.baseY + this.heights[0];
    if (i >= n - 1) return this.baseY + this.heights[n - 1];
    const t = fi - i;
    return this.baseY + lerp(this.heights[i], this.heights[i + 1], t);
  }

  /**
   * Check if a point is inside (below surface of) the terrain.
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  containsPoint(x, y) {
    return y >= this.getHeightAt(x);
  }

  // ── Decoration system ──────────────────────────────────────

  spawnDecorations() {
    this.decorations = [];

    // Background mountains (only for biomes that have them)
    const hasMountains = this._biomeSystem && this._biomeSystem._def && this._biomeSystem._def.mountains;
    if (hasMountains) {
      this._addBackgroundMountains();
    }

    // Get biome for palette decisions
    const biomeId = this._biomeSystem ? (this._biomeSystem._def ? this._biomeSystem._def.id : null) : null;

    // Background ridge / scattered vegetation (biome-aware)
    if (biomeId === 'space') {
      this._addSpaceRidge();
      this._scatterSpaceVegetation();
    } else if (biomeId === 'desert') {
      this._scatterDesertVegetation();
    } else if (biomeId === 'snow' || biomeId === 'snowy_mountains') {
      this._scatterSnowVegetation();
    } else if (biomeId === 'pine_forest') {
      this._scatterPineForest();
    } else {
      this._scatterTrees();
    }

    // Zones between launchers
    const zones = [
      [50, 260], [540, 760], [1040, 1260], [1540, 1760], [2040, 2460]
    ];

    // Bridges (not in desert or space — arid/alien terrain)
    if (biomeId !== 'desert' && biomeId !== 'space') {
      const bridgeZones = [...zones];
      _shuffle(bridgeZones);
      const numBridges = randi(1, 2);
      for (let bi = 0; bi < Math.min(numBridges, bridgeZones.length); bi++) {
        const bz = bridgeZones[bi];
        const bx = randf(bz[0] + 20, bz[1] - 100);
        this._addBridge(bx);
      }
    }

    // Fill zones with buildings, soldiers, trees/bushes — biome-aware
    for (const zone of zones) {
      const items = biomeId === 'space' ? randi(2, 4) : randi(3, 5);
      const placed = [];
      for (let i = 0; i < items; i++) {
        const x = randf(zone[0], zone[1]);
        let skip = false;
        for (const px of placed) {
          if (Math.abs(x - px) < 55) { skip = true; break; }
        }
        if (skip) continue;
        placed.push(x);

        const roll = Math.random();
        if (biomeId === 'space') {
          // Space: lunar rocks, craters, crystal clusters — 2-4 items per zone
          // Sample actual terrain height so decorations sit on the ground.
          const spaceTerrainY = this.getHeightAt(x);
          if (roll < 0.45) this._addLunarRock(x, spaceTerrainY);
          else if (roll < 0.75) this._addCrater(x, spaceTerrainY);
          else this._addCrystalCluster(x, spaceTerrainY);
        } else if (biomeId === 'desert') {
          // Desert: more rocks/cacti, some buildings, no trees
          if (roll < 0.22) this._addCivilianBuilding(x);
          else if (roll < 0.35) this._addIndustryBuilding(x);
          else if (roll < 0.50) this._addSoldierGroup(x);
          else if (roll < 0.72) this._addCactus(x);
          else this._addRockFormation(x);
        } else if (biomeId === 'snow' || biomeId === 'snowy_mountains') {
          // Snow: snow-coated pines, sparse buildings, snowman
          if (roll < 0.18) this._addCivilianBuilding(x);
          else if (roll < 0.30) this._addIndustryBuilding(x);
          else if (roll < 0.45) this._addSoldierGroup(x);
          else if (roll < 0.75) this._addSnowPineTree(x);
          else this._addRockFormation(x);
        } else if (biomeId === 'pine_forest') {
          // Pine forest: mostly pines, few buildings, some rocks
          if (roll < 0.10) this._addCivilianBuilding(x);
          else if (roll < 0.15) this._addSoldierGroup(x);
          else if (roll < 0.85) this._addPineTree(x);
          else this._addBushCluster(x);
        } else {
          // Default mixed biomes
          if (roll < 0.20) this._addCivilianBuilding(x);
          else if (roll < 0.35) this._addIndustryBuilding(x);
          else if (roll < 0.50) this._addSoldierGroup(x);
          else if (roll < 0.68) this._addDeciduousTree(x);
          else if (roll < 0.82) this._addPineTree(x);
          else this._addBushCluster(x);
        }
      }
    }

    this.dirty = true;
  }

  _registerDecoration(x, width, drawFn) {
    this.decorations.push({ x, width, drawFn });
  }

  _destroyDecorationsNear(hitX, blastRadius) {
    this.decorations = this.decorations.filter(d => {
      const center = d.x + d.width * 0.5;
      return Math.abs(center - hitX) >= blastRadius + d.width * 0.5;
    });
  }

  // ── Rendering ──────────────────────────────────────────────

  _renderToOffscreen() {
    if (!this._offscreen) {
      this._offscreen = this.renderer.createOffscreen(TERRAIN_WIDTH, TERRAIN_DEPTH + 1200);
      // Extra 1200px above for decorations and tall dramatic mountains
    }

    const ctx = this._offscreen.ctx;
    const cw = this._offscreen.canvas.width;
    const ch = this._offscreen.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // The offscreen canvas origin (0,0) corresponds to world (0, baseY - 1200)
    // We shift everything so terrain surface is at y=1200 in offscreen space
    const yOff = 1200; // vertical offset for decorations above terrain

    ctx.save();
    ctx.translate(0, yOff);

    // Draw background mountains (behind everything)
    for (const d of this.decorations) {
      if (d._isMountain) d.drawFn(ctx);
    }

    // Draw ground polygon
    this._drawGround(ctx);

    // Draw grass layer
    this._drawGrass(ctx);

    // Draw decorations (not mountains)
    for (const d of this.decorations) {
      if (!d._isMountain) d.drawFn(ctx);
    }

    ctx.restore();
  }

  /**
   * Override draw to use adjusted Y for offscreen blit.
   * Applies biome terrain filter if active.
   */
  draw(ctx) {
    if (this.dirty || !this._offscreen) {
      this._renderToOffscreen();
      this.dirty = false;
    }
    // Apply biome ctx.filter on the terrain blit only
    const biomeFilter = this._biomeSystem ? this._biomeSystem.getTerrainFilter() : null;
    if (biomeFilter && 'filter' in ctx) {
      ctx.save();
      ctx.filter = biomeFilter;
      ctx.drawImage(this._offscreen.canvas, 0, this.baseY - 1200);
      ctx.filter = 'none';
      ctx.restore();
    } else {
      // Blit offscreen: the offscreen has 1200px headroom above terrain
      ctx.drawImage(this._offscreen.canvas, 0, this.baseY - 1200);
    }
  }

  _drawGround(ctx) {
    const n = this.heights.length;
    const groundGrad = ctx.createLinearGradient(0, 0, 0, TERRAIN_DEPTH);
    if (this._dayNight) {
      const gc = this._dayNight.getGroundColors();
      groundGrad.addColorStop(0, rgba(...gc.top));
      groundGrad.addColorStop(1, rgba(...gc.bottom));
    } else {
      // Fallback: Godot hardcoded colors
      groundGrad.addColorStop(0, '#453828');
      groundGrad.addColorStop(1, '#2A2018');
    }
    ctx.fillStyle = groundGrad;
    ctx.beginPath();
    ctx.moveTo(0, TERRAIN_DEPTH);
    for (let i = 0; i < n; i++) {
      ctx.lineTo(i * TERRAIN_RESOLUTION, this.heights[i]);
    }
    ctx.lineTo(TERRAIN_WIDTH, TERRAIN_DEPTH);
    ctx.closePath();
    ctx.fill();
  }

  _drawGrass(ctx) {
    const n = this.heights.length;
    const grassGrad = ctx.createLinearGradient(0, -GRASS_DEPTH, 0, GRASS_DEPTH);
    if (this._dayNight) {
      const gc = this._dayNight.getGrassColors();
      grassGrad.addColorStop(0, rgba(...gc.top));
      grassGrad.addColorStop(1, rgba(...gc.bottom));
    } else {
      // Fallback: Godot hardcoded colors
      grassGrad.addColorStop(0, '#4A8A2E');
      grassGrad.addColorStop(1, '#2A5018');
    }
    ctx.fillStyle = grassGrad;
    ctx.beginPath();
    // Top edge left-to-right
    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_RESOLUTION;
      if (i === 0) ctx.moveTo(x, this.heights[i]);
      else ctx.lineTo(x, this.heights[i]);
    }
    // Bottom edge right-to-left
    for (let i = n - 1; i >= 0; i--) {
      const x = i * TERRAIN_RESOLUTION;
      ctx.lineTo(x, this.heights[i] + GRASS_DEPTH);
    }
    ctx.closePath();
    ctx.fill();

    // 1px highlight on grass top edge
    ctx.strokeStyle = 'rgba(120,200,80,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_RESOLUTION;
      if (i === 0) ctx.moveTo(x, this.heights[i]);
      else ctx.lineTo(x, this.heights[i]);
    }
    ctx.stroke();

    // Snow biome: draw snow accumulation strip along terrain contour
    const biomeId = this._biomeSystem ? (this._biomeSystem._def ? this._biomeSystem._def.id : null) : null;
    if (biomeId === 'snow' || biomeId === 'snowy_mountains') {
      this._drawSnowAccumulation(ctx, n);
    }

    // River/water in valley regions (riverside biome draws it behind terrain;
    // here we draw it integrated into low terrain points for other biomes)
    if (biomeId === 'stormy' || biomeId === 'riverside') {
      this._drawValleyWater(ctx, n);
    }

    // Atmospheric haze strip at horizon
    const hazeY = -60; // relative offset above terrain surface
    const hazeGrad = ctx.createLinearGradient(0, hazeY - 20, 0, hazeY + 20);
    let hazeR = 80, hazeG = 100, hazeB = 140;
    if (this._dayNight) {
      const hc = this._dayNight.getHazeColor();
      hazeR = (hc[0] * 255) | 0;
      hazeG = (hc[1] * 255) | 0;
      hazeB = (hc[2] * 255) | 0;
    }
    hazeGrad.addColorStop(0, `rgba(${hazeR},${hazeG},${hazeB},0)`);
    hazeGrad.addColorStop(0.5, `rgba(${hazeR},${hazeG},${hazeB},0.12)`);
    hazeGrad.addColorStop(1, `rgba(${hazeR},${hazeG},${hazeB},0)`);
    ctx.fillStyle = hazeGrad;
    ctx.fillRect(0, hazeY - 20, TERRAIN_WIDTH, 40);
  }

  /**
   * Draw a semi-transparent white snow strip following the terrain contour.
   * Called only for snow biome.
   */
  _drawSnowAccumulation(ctx, n) {
    const snowDepth = 8; // depth of snow layer on top of terrain
    ctx.save();
    // Base snow layer
    ctx.fillStyle = 'rgba(220,228,240,0.75)';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_RESOLUTION;
      if (i === 0) ctx.moveTo(x, this.heights[i]);
      else ctx.lineTo(x, this.heights[i]);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = i * TERRAIN_RESOLUTION;
      ctx.lineTo(x, this.heights[i] + snowDepth);
    }
    ctx.closePath();
    ctx.fill();

    // Bright highlight on very top edge
    ctx.strokeStyle = 'rgba(240,245,255,0.80)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_RESOLUTION;
      if (i === 0) ctx.moveTo(x, this.heights[i]);
      else ctx.lineTo(x, this.heights[i]);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw water in valley areas — in low-lying terrain segments.
   * Uses a threshold: areas near TERRAIN_DEPTH/2 or higher (lower surface)
   * get a water tint overlay.
   */
  _drawValleyWater(ctx, n) {
    // Find valley segments (areas where height is above threshold = lower terrain)
    const valleyThreshold = 12; // heights above this are valleys
    const waterColor1 = 'rgba(50,110,180,0.40)';
    const waterColor2 = 'rgba(30,80,140,0.55)';

    let inValley = false;
    let valleyStart = 0;

    const drawValleySegment = (startI, endI) => {
      if (endI <= startI + 1) return;
      ctx.save();
      ctx.fillStyle = waterColor1;
      ctx.beginPath();
      // Top follows terrain
      for (let i = startI; i <= endI; i++) {
        const x = i * TERRAIN_RESOLUTION;
        if (i === startI) ctx.moveTo(x, this.heights[i]);
        else ctx.lineTo(x, this.heights[i]);
      }
      // Bottom flat at valley floor + small depth
      ctx.lineTo(endI * TERRAIN_RESOLUTION, this.heights[endI] + 6);
      for (let i = endI - 1; i >= startI; i--) {
        ctx.lineTo(i * TERRAIN_RESOLUTION, this.heights[i] + 6);
      }
      ctx.closePath();
      ctx.fill();

      // Ripple highlight
      ctx.strokeStyle = 'rgba(180,220,255,0.25)';
      ctx.lineWidth = 1;
      const cx = ((startI + endI) * 0.5) * TERRAIN_RESOLUTION;
      const cy = this.heights[Math.floor((startI + endI) * 0.5)] + 3;
      ctx.beginPath();
      ctx.moveTo(cx - 15, cy);
      ctx.quadraticCurveTo(cx, cy - 3, cx + 15, cy);
      ctx.stroke();
      ctx.restore();
    };

    for (let i = 0; i < n; i++) {
      const isLow = this.heights[i] > valleyThreshold;
      if (isLow && !inValley) {
        inValley = true;
        valleyStart = i;
      } else if (!isLow && inValley) {
        drawValleySegment(valleyStart, i);
        inValley = false;
      }
    }
    if (inValley) drawValleySegment(valleyStart, n - 1);
  }

  // ── Background Mountains ──────────────────────────────────

  _addBackgroundMountains() {
    // Layer 1: far distant — #161C28 (layerIndex 0) — massive peaks
    this._addMountainLayer(0, 0.086, 0.110, 0.157, 0.90, -680, 420, 5, 0.55, true);
    // Layer 2: mid-distance — #1C2430 (layerIndex 1) — tall ridges
    this._addMountainLayer(1, 0.110, 0.141, 0.188, 0.87, -460, 310, 7, 0.75, false);
    // Layer 3: nearby hills — #222C20 (layerIndex 2) — jagged foreground
    this._addMountainLayer(2, 0.133, 0.173, 0.125, 0.82, -260, 195, 10, 1.0, false);
    // Snow caps removed per user request
  }

  /**
   * Get the current mountain color for the given layer, tinted by day/night ambient.
   * @param {number} layerIndex — 0=far, 1=mid, 2=near
   * @returns {string} CSS color string
   */
  _getMountainColor(layerIndex, baseR, baseG, baseB, baseA) {
    // Mountains use fixed colors — no day/night tinting.
    // This keeps the terrain stable and prevents mountains from washing out
    // or disappearing during sunrise/sunset ambient shifts.
    return rgba(baseR, baseG, baseB, baseA);
  }

  _addMountainLayer(layerIndex, r, g, b, a, baseY, maxHeight, numPeaks, jaggedness, hasSnow) {
    const phase  = Math.random() * TAU;
    const phase2 = Math.random() * TAU;
    const phase3 = Math.random() * TAU;
    const phase4 = Math.random() * TAU;
    // Use more steps for smoother but more detailed silhouettes
    const steps = numPeaks * 12;
    const terrain = this;

    const drawFn = (ctx) => {
      ctx.fillStyle = terrain._getMountainColor(layerIndex, r, g, b, a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = t * TERRAIN_WIDTH;
        let h = 0;
        // Primary large peaks
        h += Math.sin(t * Math.PI * numPeaks + phase) * maxHeight * 0.50;
        // Secondary ridges for visual complexity
        h += Math.sin(t * Math.PI * numPeaks * 2.3 + phase2) * maxHeight * 0.28 * jaggedness;
        h += Math.sin(t * Math.PI * numPeaks * 4.7 + phase3) * maxHeight * 0.12 * jaggedness;
        // High-freq rocky texture
        h += Math.sin(t * Math.PI * numPeaks * 9.1 + phase4) * maxHeight * 0.04 * jaggedness;
        // Keep minimum height so mountains always fill bottom
        h = Math.max(h, 12);
        ctx.lineTo(x, baseY - h);
      }
      ctx.lineTo(TERRAIN_WIDTH, 0);
      ctx.closePath();
      ctx.fill();
    };
    const d = { x: 0, width: TERRAIN_WIDTH, drawFn, _isMountain: true };
    this.decorations.push(d);
  }


  // ── Scattered trees ────────────────────────────────────────

  _scatterTrees() {
    const launcherXs = [400, 900, 1400, 1900];
    const treeClear = 70;
    const numTrees = randi(18, 30);

    for (let ti = 0; ti < numTrees; ti++) {
      const tx = randf(30, TERRAIN_WIDTH - 30);
      let nearLauncher = false;
      for (const lx of launcherXs) {
        if (Math.abs(tx - lx) < treeClear) { nearLauncher = true; break; }
      }
      if (nearLauncher) continue;

      const sampleI = clamp(Math.floor(tx / TERRAIN_RESOLUTION), 0, this.heights.length - 1);
      const terrainY = this.heights[sampleI];

      const roll = Math.random();
      if (roll < 0.40) this._addPineTree(tx, terrainY);
      else if (roll < 0.75) this._addDeciduousTree(tx, terrainY);
      else this._addBushCluster(tx, terrainY);
    }
  }

  _scatterPineForest() {
    const launcherXs = [400, 900, 1400, 1900];
    const treeClear = 70;
    // Dense pine forest — more trees than normal
    const numTrees = randi(35, 50);

    for (let ti = 0; ti < numTrees; ti++) {
      const tx = randf(30, TERRAIN_WIDTH - 30);
      let nearLauncher = false;
      for (const lx of launcherXs) {
        if (Math.abs(tx - lx) < treeClear) { nearLauncher = true; break; }
      }
      if (nearLauncher) continue;

      const sampleI = clamp(Math.floor(tx / TERRAIN_RESOLUTION), 0, this.heights.length - 1);
      const terrainY = this.heights[sampleI];

      const roll = Math.random();
      if (roll < 0.80) this._addPineTree(tx, terrainY);
      else this._addBushCluster(tx, terrainY);
    }
  }

  // ── Deciduous tree ─────────────────────────────────────────

  _addDeciduousTree(x, yOffset = 0) {
    const trunkH = randf(22, 38);
    const trunkW = randf(4, 7);
    const canopyR = randf(16, 28);

    const trunkColor = pickRandom([
      [0.35, 0.25, 0.16], [0.38, 0.28, 0.18],
      [0.32, 0.22, 0.14], [0.40, 0.30, 0.20],
    ]);
    const canopyColor = pickRandom([
      [0.22, 0.42, 0.18], [0.25, 0.45, 0.20],
      [0.20, 0.38, 0.16], [0.28, 0.48, 0.22],
      [0.18, 0.40, 0.15], [0.24, 0.44, 0.20],
    ]);

    // Pre-generate canopy blob data
    const numBlobs = randi(4, 6);
    const blobs = [];
    const canopyCenterY = -trunkH - canopyR * 0.4;
    for (let ci = 0; ci < numBlobs; ci++) {
      const br = canopyR * randf(0.55, 0.85);
      const bx = randf(-canopyR * 0.4, canopyR * 0.4);
      const by = canopyCenterY + randf(-canopyR * 0.3, canopyR * 0.3);
      const segments = 10;
      const pts = [];
      for (let si = 0; si < segments; si++) {
        const angle = TAU * si / segments;
        const wobble = 1 + Math.sin(angle * 3 + ci) * 0.15;
        pts.push([
          bx + Math.cos(angle) * br * wobble,
          by + Math.sin(angle) * br * wobble * 0.85
        ]);
      }
      const lightShift = randf(-0.06, 0.06);
      blobs.push({ pts, color: lighten(...canopyColor, Math.max(0, lightShift)) });
    }

    // Pre-generate branches
    const numBranches = randi(2, 3);
    const branches = [];
    for (let bi = 0; bi < numBranches; bi++) {
      const by = -trunkH * randf(0.5, 0.85);
      const bdir = bi % 2 === 0 ? 1 : -1;
      const blen = randf(8, 15);
      const brise = randf(4, 10);
      branches.push({ by, bdir, blen, brise });
    }

    // Highlight blob
    const hlR = canopyR * 0.5;

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      // Ground shadow
      ctx.fillStyle = rgba(0.08, 0.10, 0.05, 0.35);
      ctx.beginPath();
      const shadowRx = canopyR * 0.8;
      for (let si = 0; si < 12; si++) {
        const angle = TAU * si / 12;
        const px = Math.cos(angle) * shadowRx;
        const py = Math.sin(angle) * 4 + 2;
        if (si === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      // Trunk
      ctx.fillStyle = rgba(...trunkColor);
      ctx.beginPath();
      ctx.moveTo(-trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.35, -trunkH);
      ctx.lineTo(-trunkW * 0.35, -trunkH);
      ctx.closePath();
      ctx.fill();

      // Bark texture
      const dk = darken(...trunkColor, 0.2);
      ctx.fillStyle = rgba(...dk);
      ctx.beginPath();
      ctx.moveTo(-trunkW * 0.15, -2);
      ctx.lineTo(trunkW * 0.15, -2);
      ctx.lineTo(trunkW * 0.1, -trunkH + 3);
      ctx.lineTo(-trunkW * 0.1, -trunkH + 3);
      ctx.closePath();
      ctx.fill();

      // Branches
      const branchColor = darken(...trunkColor, 0.08);
      ctx.fillStyle = rgba(...branchColor);
      for (const br of branches) {
        ctx.beginPath();
        ctx.moveTo(0, br.by);
        ctx.lineTo(br.bdir * br.blen, br.by - br.brise);
        ctx.lineTo(br.bdir * br.blen, br.by - br.brise - 1.5);
        ctx.lineTo(0, br.by - 1.5);
        ctx.closePath();
        ctx.fill();
      }

      // Canopy blobs
      for (const blob of blobs) {
        ctx.fillStyle = rgba(...blob.color);
        ctx.beginPath();
        ctx.moveTo(blob.pts[0][0], blob.pts[0][1]);
        for (let i = 1; i < blob.pts.length; i++) {
          ctx.lineTo(blob.pts[i][0], blob.pts[i][1]);
        }
        ctx.closePath();
        ctx.fill();
      }

      // Highlight
      ctx.fillStyle = rgba(...lighten(...canopyColor, 0.15), 0.4);
      ctx.beginPath();
      for (let si = 0; si < 8; si++) {
        const angle = TAU * si / 8;
        const px = -canopyR * 0.2 + Math.cos(angle) * hlR;
        const py = canopyCenterY - canopyR * 0.15 + Math.sin(angle) * hlR * 0.7;
        if (si === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    };

    this._registerDecoration(x, canopyR * 2, drawFn);
  }

  // ── Pine tree ──────────────────────────────────────────────

  _addPineTree(x, yOffset = 0) {
    const trunkH = randf(18, 30);
    const trunkW = randf(3.5, 5.5);
    const treeH = randf(40, 65);
    const baseWidth = randf(18, 28);
    const trunkColor = [0.32, 0.22, 0.14];
    const pineColor = pickRandom([
      [0.12, 0.30, 0.14], [0.14, 0.32, 0.16],
      [0.10, 0.28, 0.12], [0.16, 0.34, 0.15],
      [0.11, 0.26, 0.13],
    ]);

    const numTiers = randi(3, 5);
    const canopyStart = -trunkH * 0.6;
    const tierH = (treeH - trunkH * 0.4) / numTiers;

    // Pre-generate snow data
    const snowTiers = [];
    for (let ti = 0; ti < numTiers; ti++) {
      if (ti >= numTiers - 2 && Math.random() < 0.3) {
        const ty = canopyStart - ti * tierH * 0.75;
        const tw = baseWidth * (1 - ti * 0.15);
        const th = tierH * 1.1;
        snowTiers.push({ ty, tw, th });
      }
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      // Shadow
      ctx.fillStyle = rgba(0.06, 0.08, 0.04, 0.3);
      ctx.beginPath();
      for (let si = 0; si < 10; si++) {
        const angle = TAU * si / 10;
        const px = Math.cos(angle) * baseWidth * 0.6;
        const py = Math.sin(angle) * 3.5 + 2;
        if (si === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      // Trunk
      ctx.fillStyle = rgba(...trunkColor);
      ctx.beginPath();
      ctx.moveTo(-trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.3, -trunkH);
      ctx.lineTo(-trunkW * 0.3, -trunkH);
      ctx.closePath();
      ctx.fill();

      // Tiers
      for (let ti = 0; ti < numTiers; ti++) {
        const ty = canopyStart - ti * tierH * 0.75;
        const tw = baseWidth * (1 - ti * 0.15);
        const th = tierH * 1.1;

        // Main tier
        const lt = lighten(...pineColor, ti * 0.03);
        ctx.fillStyle = rgba(...lt);
        ctx.beginPath();
        ctx.moveTo(-tw * 0.5, ty);
        ctx.lineTo(tw * 0.5, ty);
        ctx.lineTo(0, ty - th);
        ctx.closePath();
        ctx.fill();

        // Shadow on right side
        const dk = darken(...pineColor, 0.12);
        ctx.fillStyle = rgba(...dk);
        ctx.beginPath();
        ctx.moveTo(0, ty);
        ctx.lineTo(tw * 0.5, ty);
        ctx.lineTo(0, ty - th);
        ctx.closePath();
        ctx.fill();
      }

      // Snow dusting
      ctx.fillStyle = rgba(0.90, 0.92, 0.95, 0.35);
      for (const s of snowTiers) {
        const snowW = s.tw * 0.3;
        ctx.beginPath();
        ctx.moveTo(-snowW * 0.5, s.ty - s.th + 2);
        ctx.lineTo(snowW * 0.5, s.ty - s.th + 2);
        ctx.lineTo(0, s.ty - s.th - 1);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    };

    this._registerDecoration(x, baseWidth, drawFn);
  }

  // ── Bush cluster ───────────────────────────────────────────

  _addBushCluster(x, yOffset = 0) {
    const numBushes = randi(2, 4);
    const spread = numBushes * randf(8, 12);

    const bushGreens = [
      [0.20, 0.36, 0.16], [0.24, 0.40, 0.18],
      [0.18, 0.34, 0.14], [0.26, 0.38, 0.20],
      [0.22, 0.42, 0.17],
    ];

    // Pre-generate bush data
    const bushes = [];
    for (let bi = 0; bi < numBushes; bi++) {
      const bx = randf(-spread * 0.5, spread * 0.5);
      const bushW = randf(10, 18);
      const bushH = randf(8, 14);
      const bushColor = pickRandom(bushGreens);

      const bodyPts = [];
      const segments = 10;
      for (let si = 0; si < segments; si++) {
        const angle = TAU * si / segments;
        const wobble = 1 + Math.sin(angle * 2.5 + bi) * 0.2;
        const rx = bushW * 0.5 * wobble;
        const ry = bushH * 0.5 * wobble;
        let py = Math.sin(angle) * ry;
        if (py > 0) py *= 0.3;
        bodyPts.push([bx + Math.cos(angle) * rx, -bushH * 0.3 + py]);
      }

      // Berries
      let berries = null;
      if (Math.random() < 0.3) {
        const berryColor = pickRandom([
          [0.75, 0.15, 0.15], [0.85, 0.75, 0.20],
          [0.80, 0.40, 0.60], [0.90, 0.55, 0.15],
        ]);
        const dots = [];
        const nd = randi(2, 5);
        for (let di = 0; di < nd; di++) {
          dots.push([
            bx + randf(-bushW * 0.35, bushW * 0.35),
            -bushH * randf(0.2, 0.6)
          ]);
        }
        berries = { color: berryColor, dots };
      }

      bushes.push({ bx, bushW, bushH, bushColor, bodyPts, berries });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      for (const b of bushes) {
        // Shadow
        ctx.fillStyle = rgba(0.06, 0.08, 0.04, 0.25);
        ctx.beginPath();
        for (let si = 0; si < 8; si++) {
          const angle = TAU * si / 8;
          const px = b.bx + Math.cos(angle) * b.bushW * 0.5;
          const py = Math.sin(angle) * 2.5 + 2;
          if (si === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();

        // Body
        ctx.fillStyle = rgba(...b.bushColor);
        ctx.beginPath();
        ctx.moveTo(b.bodyPts[0][0], b.bodyPts[0][1]);
        for (let i = 1; i < b.bodyPts.length; i++) ctx.lineTo(b.bodyPts[i][0], b.bodyPts[i][1]);
        ctx.closePath();
        ctx.fill();

        // Highlight
        const hl = lighten(...b.bushColor, 0.12);
        ctx.fillStyle = rgba(...hl, 0.45);
        ctx.beginPath();
        const hlR = b.bushW * 0.25;
        for (let si = 0; si < 7; si++) {
          const angle = TAU * si / 7;
          const px = b.bx - b.bushW * 0.12 + Math.cos(angle) * hlR;
          const py = -b.bushH * 0.45 + Math.sin(angle) * hlR * 0.6;
          if (si === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();

        // Berries
        if (b.berries) {
          ctx.fillStyle = rgba(...b.berries.color);
          for (const d of b.berries.dots) {
            ctx.fillRect(d[0] - 1.5, d[1] - 1.5, 3, 3);
          }
        }
      }

      ctx.restore();
    };

    this._registerDecoration(x, spread, drawFn);
  }

  // ── Desert cactus ─────────────────────────────────────────

  _addCactus(x, yOffset = 0) {
    const trunkH  = randf(30, 55);
    const trunkW  = randf(7, 11);
    const armType = Math.random(); // 0=tall single, 0.5=two arms, 1=saguaro

    const cactusGreen = pickRandom([
      [0.22, 0.45, 0.20], [0.18, 0.40, 0.17],
      [0.25, 0.50, 0.22], [0.20, 0.42, 0.18],
    ]);
    const darkGreen = darken(...cactusGreen, 0.22);

    // Arms data
    const arms = [];
    if (armType > 0.35) {
      const numArms = armType > 0.65 ? 2 : 1;
      for (let ai = 0; ai < numArms; ai++) {
        const side  = ai % 2 === 0 ? 1 : -1;
        const armY  = -trunkH * randf(0.45, 0.70);
        const armL  = randf(14, 24);
        const armH  = randf(10, 18);
        const armW  = trunkW * 0.65;
        arms.push({ side, armY, armL, armH, armW });
      }
    }

    // Spine dots
    const numSpines = Math.floor(trunkH / 6);
    const spines = [];
    for (let si = 0; si < numSpines; si++) {
      spines.push({
        y:    -si * (trunkH / numSpines) - 4,
        side: (si % 2 === 0) ? 1 : -1,
      });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      // Shadow
      ctx.fillStyle = rgba(0.10, 0.08, 0.04, 0.30);
      ctx.beginPath();
      for (let si = 0; si < 10; si++) {
        const angle = TAU * si / 10;
        const px = Math.cos(angle) * trunkW * 1.2;
        const py = Math.sin(angle) * 4 + 3;
        if (si === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      // Arms
      for (const arm of arms) {
        const armBaseX = arm.side > 0 ? trunkW * 0.4 : -trunkW * 0.4 - arm.armL;
        // Horizontal segment
        _fillRect(ctx, armBaseX, arm.armY - arm.armW * 0.5, arm.armL, arm.armW, rgba(...cactusGreen));
        // Vertical tip
        const tipX = arm.side > 0
          ? trunkW * 0.4 + arm.armL - arm.armW * 0.5
          : -trunkW * 0.4 - arm.armW * 0.5;
        _fillRect(ctx, tipX, arm.armY - arm.armH, arm.armW, arm.armH, rgba(...cactusGreen));
        // Shadow
        _fillRect(ctx, armBaseX + arm.armL * 0.5, arm.armY - arm.armW * 0.5, arm.armL * 0.4, arm.armW, rgba(...darkGreen, 0.6));
      }

      // Main trunk
      ctx.fillStyle = rgba(...cactusGreen);
      ctx.beginPath();
      ctx.moveTo(-trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.42, -trunkH);
      ctx.lineTo(-trunkW * 0.42, -trunkH);
      ctx.closePath();
      ctx.fill();

      // Trunk shadow (right edge)
      ctx.fillStyle = rgba(...darkGreen);
      ctx.beginPath();
      ctx.moveTo(trunkW * 0.15, 0);
      ctx.lineTo(trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.42, -trunkH);
      ctx.lineTo(trunkW * 0.15, -trunkH);
      ctx.closePath();
      ctx.fill();

      // Top rounded crown
      ctx.fillStyle = rgba(...cactusGreen);
      ctx.beginPath();
      for (let si = 0; si <= 10; si++) {
        const angle = Math.PI * si / 10;
        const px = Math.cos(angle) * trunkW * 0.48;
        const py = -trunkH + Math.sin(angle) * (-trunkW * 0.55);
        if (si === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineTo(trunkW * 0.42, -trunkH);
      ctx.lineTo(-trunkW * 0.42, -trunkH);
      ctx.closePath();
      ctx.fill();

      // Spine dots
      for (const sp of spines) {
        const sx = sp.side * (trunkW * 0.52);
        _fillRect(ctx, sx - 1, sp.y - 1, 2, 2, rgba(0.72, 0.68, 0.52, 0.65));
      }

      ctx.restore();
    };

    this._registerDecoration(x, trunkW + (arms.length > 0 ? 28 : 0), drawFn);
  }

  // ── Rock formation ────────────────────────────────────────

  _addRockFormation(x, yOffset = 0) {
    const numRocks = randi(2, 5);
    const spread   = numRocks * randf(12, 18);

    const rockColors = [
      [0.48, 0.42, 0.36], [0.52, 0.46, 0.38],
      [0.44, 0.40, 0.35], [0.56, 0.50, 0.42],
      [0.50, 0.44, 0.38],
    ];

    const rocks = [];
    for (let ri = 0; ri < numRocks; ri++) {
      const rx  = randf(-spread * 0.5, spread * 0.5);
      const rw  = randf(16, 36);
      const rh  = randf(12, 28);
      const col = pickRandom(rockColors);
      const dk  = darken(...col, 0.20);
      const hl  = lighten(...col, 0.18);

      // Pre-gen polygon points (irregular polygon, flat-bottomed)
      const numSides = randi(5, 7);
      const pts = [];
      for (let si = 0; si < numSides; si++) {
        const angle  = TAU * si / numSides + randf(-0.3, 0.3);
        const radiusX = rw * 0.5 * randf(0.7, 1.0);
        const radiusY = rh * 0.5 * randf(0.6, 1.0);
        // Flatten bottom
        const sy = Math.sin(angle);
        const ry = sy < 0 ? sy * radiusY : sy * radiusY * 0.35;
        pts.push([Math.cos(angle) * radiusX, ry - rh * 0.22]);
      }

      rocks.push({ rx, rw, rh, col, dk, hl, pts });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      for (const rock of rocks) {
        // Shadow
        ctx.fillStyle = rgba(0.08, 0.07, 0.05, 0.28);
        ctx.beginPath();
        for (let si = 0; si < 8; si++) {
          const angle = TAU * si / 8;
          const px = rock.rx + Math.cos(angle) * rock.rw * 0.52;
          const py = Math.sin(angle) * 4 + 3;
          if (si === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();

        // Main body
        ctx.fillStyle = rgba(...rock.col);
        ctx.beginPath();
        ctx.moveTo(rock.rx + rock.pts[0][0], rock.pts[0][1]);
        for (let i = 1; i < rock.pts.length; i++) {
          ctx.lineTo(rock.rx + rock.pts[i][0], rock.pts[i][1]);
        }
        ctx.closePath();
        ctx.fill();

        // Dark shadow side (right portion)
        ctx.fillStyle = rgba(...rock.dk, 0.65);
        ctx.beginPath();
        ctx.moveTo(rock.rx + rock.rw * 0.05, -rock.rh * 0.22);
        ctx.lineTo(rock.rx + rock.rw * 0.50, -rock.rh * 0.08);
        ctx.lineTo(rock.rx + rock.rw * 0.48, rock.rh * 0.10);
        ctx.lineTo(rock.rx + rock.rw * 0.10, rock.rh * 0.10);
        ctx.closePath();
        ctx.fill();

        // Highlight (upper-left)
        ctx.fillStyle = rgba(...rock.hl, 0.42);
        ctx.beginPath();
        ctx.moveTo(rock.rx - rock.rw * 0.20, -rock.rh * 0.42);
        ctx.lineTo(rock.rx - rock.rw * 0.02, -rock.rh * 0.52);
        ctx.lineTo(rock.rx + rock.rw * 0.08, -rock.rh * 0.28);
        ctx.lineTo(rock.rx - rock.rw * 0.15, -rock.rh * 0.20);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    };

    this._registerDecoration(x, spread, drawFn);
  }

  // ── Snow-heavy pine tree (snow biome) ─────────────────────

  _addSnowPineTree(x, yOffset = 0) {
    const trunkH    = randf(18, 30);
    const trunkW    = randf(3.5, 5.5);
    const treeH     = randf(45, 75);
    const baseWidth = randf(20, 34);
    const trunkColor = [0.28, 0.20, 0.14];
    const pineColor  = [0.10, 0.22, 0.12];

    const numTiers    = randi(4, 6);
    const canopyStart = -trunkH * 0.6;
    const tierH       = (treeH - trunkH * 0.4) / numTiers;

    // Each tier gets snow coverage fraction
    const snowTiers = [];
    for (let ti = 0; ti < numTiers; ti++) {
      const ty        = canopyStart - ti * tierH * 0.75;
      const tw        = baseWidth * (1 - ti * 0.15);
      const th        = tierH * 1.1;
      const snowCover = randf(0.30, 0.65);
      snowTiers.push({ ty, tw, th, snowCover });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      // Shadow
      ctx.fillStyle = rgba(0.06, 0.08, 0.10, 0.22);
      ctx.beginPath();
      for (let si = 0; si < 10; si++) {
        const angle = TAU * si / 10;
        const px = Math.cos(angle) * baseWidth * 0.6;
        const py = Math.sin(angle) * 3.5 + 2;
        if (si === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      // Trunk
      ctx.fillStyle = rgba(...trunkColor);
      ctx.beginPath();
      ctx.moveTo(-trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.5, 0);
      ctx.lineTo(trunkW * 0.3, -trunkH);
      ctx.lineTo(-trunkW * 0.3, -trunkH);
      ctx.closePath();
      ctx.fill();

      // Pine tiers
      for (let ti = 0; ti < numTiers; ti++) {
        const ty = canopyStart - ti * tierH * 0.75;
        const tw = baseWidth * (1 - ti * 0.15);
        const th = tierH * 1.1;
        ctx.fillStyle = rgba(...pineColor);
        ctx.beginPath();
        ctx.moveTo(-tw * 0.5, ty);
        ctx.lineTo(tw * 0.5, ty);
        ctx.lineTo(0, ty - th);
        ctx.closePath();
        ctx.fill();
      }

      // Heavy snow on each tier
      for (const s of snowTiers) {
        const sw = s.tw * s.snowCover;
        // Snow cap
        ctx.fillStyle = rgba(0.88, 0.91, 0.95, 0.92);
        ctx.beginPath();
        ctx.moveTo(-sw * 0.5, s.ty - s.th * 0.12);
        ctx.lineTo(sw * 0.5, s.ty - s.th * 0.12);
        ctx.lineTo(0, s.ty - s.th - 2);
        ctx.closePath();
        ctx.fill();

        // Snow droop edges
        ctx.fillStyle = rgba(0.85, 0.88, 0.93, 0.62);
        ctx.beginPath();
        ctx.moveTo(-s.tw * 0.5, s.ty);
        ctx.lineTo(-s.tw * 0.5 + sw * 0.15, s.ty + 5);
        ctx.lineTo(-s.tw * 0.5 + sw * 0.40, s.ty);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(s.tw * 0.5, s.ty);
        ctx.lineTo(s.tw * 0.5 - sw * 0.15, s.ty + 5);
        ctx.lineTo(s.tw * 0.5 - sw * 0.40, s.ty);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    };

    this._registerDecoration(x, baseWidth, drawFn);
  }

  // ── Desert scattered vegetation ───────────────────────────

  _scatterDesertVegetation() {
    const launcherXs  = [400, 900, 1400, 1900];
    const clearRadius = 70;
    const numItems    = randi(12, 22);

    for (let ti = 0; ti < numItems; ti++) {
      const tx = randf(30, TERRAIN_WIDTH - 30);
      let near = false;
      for (const lx of launcherXs) {
        if (Math.abs(tx - lx) < clearRadius) { near = true; break; }
      }
      if (near) continue;

      const sampleI = clamp(Math.floor(tx / TERRAIN_RESOLUTION), 0, this.heights.length - 1);
      const terrainY = this.heights[sampleI];
      if (Math.random() < 0.55) this._addCactus(tx, terrainY);
      else this._addRockFormation(tx, terrainY);
    }
  }

  // ── Snow biome scattered vegetation ──────────────────────

  _scatterSnowVegetation() {
    const launcherXs  = [400, 900, 1400, 1900];
    const clearRadius = 70;
    const numItems    = randi(15, 25);

    for (let ti = 0; ti < numItems; ti++) {
      const tx = randf(30, TERRAIN_WIDTH - 30);
      let near = false;
      for (const lx of launcherXs) {
        if (Math.abs(tx - lx) < clearRadius) { near = true; break; }
      }
      if (near) continue;

      const sampleI = clamp(Math.floor(tx / TERRAIN_RESOLUTION), 0, this.heights.length - 1);
      const terrainY = this.heights[sampleI];
      if (Math.random() < 0.65) this._addSnowPineTree(tx, terrainY);
      else this._addRockFormation(tx, terrainY);
    }
  }

  // ── Space biome scattered vegetation ─────────────────────

  _scatterSpaceVegetation() {
    const launcherXs  = [400, 900, 1400, 1900];
    const clearRadius = 70;
    const numItems    = randi(20, 32);

    for (let ti = 0; ti < numItems; ti++) {
      const tx = randf(30, TERRAIN_WIDTH - 30);
      let near = false;
      for (const lx of launcherXs) {
        if (Math.abs(tx - lx) < clearRadius) { near = true; break; }
      }
      if (near) continue;

      const sampleI = clamp(Math.floor(tx / TERRAIN_RESOLUTION), 0, this.heights.length - 1);
      const terrainY = this.heights[sampleI];
      const roll = Math.random();
      if (roll < 0.55) this._addLunarRock(tx, terrainY);
      else if (roll < 0.85) this._addCrater(tx, terrainY);
      else this._addCrystalCluster(tx, terrainY);
    }
  }

  // ── Lunar rock ────────────────────────────────────────────

  _addLunarRock(x, yOffset = 0) {
    const numRocks = randi(2, 5);
    const spread   = numRocks * randf(12, 18);

    const rockColors = [
      [0.38, 0.36, 0.44], [0.32, 0.30, 0.40],
      [0.44, 0.42, 0.50], [0.28, 0.27, 0.36],
      [0.48, 0.46, 0.54],
    ];

    const rocks = [];
    for (let ri = 0; ri < numRocks; ri++) {
      const rx  = randf(-spread * 0.5, spread * 0.5);
      const rw  = randf(16, 36);
      const rh  = randf(12, 28);
      const col = pickRandom(rockColors);
      const dk  = darken(...col, 0.22);
      const hl  = lighten(...col, 0.16);

      const numSides = randi(5, 7);
      const pts = [];
      for (let si = 0; si < numSides; si++) {
        const angle   = TAU * si / numSides + randf(-0.3, 0.3);
        const radiusX = rw * 0.5 * randf(0.7, 1.0);
        const radiusY = rh * 0.5 * randf(0.6, 1.0);
        const sy = Math.sin(angle);
        const ry = sy < 0 ? sy * radiusY : sy * radiusY * 0.35;
        pts.push([Math.cos(angle) * radiusX, ry - rh * 0.22]);
      }

      rocks.push({ rx, rw, rh, col, dk, hl, pts });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      for (const rock of rocks) {
        // Shadow
        ctx.fillStyle = 'rgba(10,8,20,0.40)';
        ctx.beginPath();
        for (let si = 0; si < 8; si++) {
          const angle = TAU * si / 8;
          const px = rock.rx + Math.cos(angle) * rock.rw * 0.52;
          const py = Math.sin(angle) * 4 + 3;
          if (si === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();

        // Main body
        ctx.fillStyle = rgba(...rock.col);
        ctx.beginPath();
        ctx.moveTo(rock.rx + rock.pts[0][0], rock.pts[0][1]);
        for (let i = 1; i < rock.pts.length; i++) {
          ctx.lineTo(rock.rx + rock.pts[i][0], rock.pts[i][1]);
        }
        ctx.closePath();
        ctx.fill();

        // Dark shadow side
        ctx.fillStyle = rgba(...rock.dk, 0.65);
        ctx.beginPath();
        ctx.moveTo(rock.rx + rock.rw * 0.05, -rock.rh * 0.22);
        ctx.lineTo(rock.rx + rock.rw * 0.50, -rock.rh * 0.08);
        ctx.lineTo(rock.rx + rock.rw * 0.48, rock.rh * 0.10);
        ctx.lineTo(rock.rx + rock.rw * 0.10, rock.rh * 0.10);
        ctx.closePath();
        ctx.fill();

        // Highlight (upper-left)
        ctx.fillStyle = 'rgba(166,158,184,0.38)';
        ctx.beginPath();
        ctx.moveTo(rock.rx - rock.rw * 0.20, -rock.rh * 0.42);
        ctx.lineTo(rock.rx - rock.rw * 0.02, -rock.rh * 0.52);
        ctx.lineTo(rock.rx + rock.rw * 0.08, -rock.rh * 0.28);
        ctx.lineTo(rock.rx - rock.rw * 0.15, -rock.rh * 0.20);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    };

    this._registerDecoration(x, spread, drawFn);
  }

  // ── Impact crater ──────────────────────────────────────────

  _addCrater(x, yOffset = 0) {
    const rx = randf(20, 45);
    const ry = randf(6, 14);
    const innerRx = rx * randf(0.45, 0.60);
    const innerRy = ry * randf(0.50, 0.70);

    // Pre-generate ejecta dots
    const numEjecta = randi(5, 8);
    const ejecta = [];
    for (let ei = 0; ei < numEjecta; ei++) {
      const angle = randf(0, TAU);
      const dist  = rx + randf(5, 18);
      ejecta.push({
        ex: Math.cos(angle) * dist,
        ey: Math.sin(angle) * dist * (ry / rx), // scale for ellipse
        er: randf(1.5, 3.5),
      });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      // Outer rim ellipse
      ctx.fillStyle = 'rgba(107,102,128,1.0)';
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
      ctx.fill();

      // Inner floor (darker)
      ctx.fillStyle = 'rgba(46,41,61,0.85)';
      ctx.beginPath();
      ctx.ellipse(0, 0, innerRx, innerRy, 0, 0, TAU);
      ctx.fill();

      // Rim highlight arc (bottom lip)
      ctx.strokeStyle = 'rgba(156,150,178,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(0, ry * 0.15, rx * 0.85, ry * 0.4, 0, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();

      // Ejecta dots
      ctx.fillStyle = 'rgba(107,102,128,0.70)';
      for (const e of ejecta) {
        ctx.beginPath();
        ctx.arc(e.ex, e.ey, e.er, 0, TAU);
        ctx.fill();
      }

      ctx.restore();
    };

    // Ejecta dots extend up to rx+18 from center; bounding box covers that.
    this._registerDecoration(x, rx * 2 + 36, drawFn);
  }

  // ── Crystal cluster ────────────────────────────────────────

  _addCrystalCluster(x, yOffset = 0) {
    const numSpires = randi(3, 5);

    // Pick one cluster color
    const clusterColors = [
      { r: 51,  g: 179, b: 204 }, // cyan
      { r: 191, g: 51,  b: 166 }, // magenta
      { r: 204, g: 153, b: 38  }, // amber
    ];
    const col = pickRandom(clusterColors);
    const cssBase = `rgba(${col.r},${col.g},${col.b}`;

    // Pre-generate spire data
    const spires = [];
    const spread = numSpires * 6;
    for (let si = 0; si < numSpires; si++) {
      const sx    = randf(-spread, spread);
      const sh    = randf(25, 65);
      const sw    = randf(4, 9);
      const tilt  = randf(-8, 8) * Math.PI / 180;
      spires.push({ sx, sh, sw, tilt });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, yOffset);

      for (const sp of spires) {
        ctx.save();
        ctx.translate(sp.sx, 0);
        ctx.rotate(sp.tilt);

        // Ground glow
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, sp.sw * 2.5);
        glow.addColorStop(0,   `${cssBase},0.15)`);
        glow.addColorStop(1,   `${cssBase},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(0, 0, sp.sw * 2.5, sp.sw * 1.2, 0, 0, TAU);
        ctx.fill();

        // Main spire (tapered quad)
        ctx.fillStyle = `${cssBase},0.75)`;
        ctx.beginPath();
        ctx.moveTo(-sp.sw * 0.5, 0);
        ctx.lineTo( sp.sw * 0.5, 0);
        ctx.lineTo( sp.sw * 0.12, -sp.sh);
        ctx.lineTo(-sp.sw * 0.12, -sp.sh);
        ctx.closePath();
        ctx.fill();

        // Inner lighter stripe
        ctx.fillStyle = `${cssBase},0.45)`;
        ctx.beginPath();
        ctx.moveTo(-sp.sw * 0.12, -2);
        ctx.lineTo( sp.sw * 0.12, -2);
        ctx.lineTo( sp.sw * 0.04, -sp.sh + 4);
        ctx.lineTo(-sp.sw * 0.04, -sp.sh + 4);
        ctx.closePath();
        ctx.fill();

        // Bright top cap
        ctx.fillStyle = `rgba(255,255,255,0.55)`;
        ctx.beginPath();
        ctx.moveTo(-sp.sw * 0.10, -sp.sh + 4);
        ctx.lineTo( sp.sw * 0.10, -sp.sh + 4);
        ctx.lineTo(0, -sp.sh - 3);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      }

      ctx.restore();
    };

    this._registerDecoration(x, spread * 2 + 20, drawFn);
  }

  // ── Space ridge ────────────────────────────────────────────

  _addSpaceRidge() {
    const numPts = randi(60, 80);
    // Pre-generate ridge profile
    const pts = [];
    for (let i = 0; i <= numPts; i++) {
      pts.push(randf(-680, -400));
    }

    const drawFn = (ctx) => {
      ctx.save();

      ctx.fillStyle = 'rgba(26,23,41,1.0)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let i = 0; i <= numPts; i++) {
        const px = (i / numPts) * TERRAIN_WIDTH;
        ctx.lineTo(px, pts[i]);
      }
      ctx.lineTo(TERRAIN_WIDTH, 0);
      ctx.closePath();
      ctx.fill();

      // Rim-light on top edge
      ctx.strokeStyle = 'rgba(56,51,82,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, pts[0]);
      for (let i = 1; i <= numPts; i++) {
        const px = (i / numPts) * TERRAIN_WIDTH;
        ctx.lineTo(px, pts[i]);
      }
      ctx.stroke();

      ctx.restore();
    };

    const d = { x: 0, width: TERRAIN_WIDTH, drawFn, _isMountain: true };
    this.decorations.push(d);
  }

  // ── Civilian building ──────────────────────────────────────

  _addCivilianBuilding(x) {
    const w = randf(40, 58);
    const h = randf(32, 46);
    const roofH = randf(14, 20);

    const wallColor = pickRandom([
      [0.72, 0.65, 0.55], [0.68, 0.58, 0.48],
      [0.76, 0.70, 0.60], [0.82, 0.78, 0.68],
      [0.70, 0.62, 0.55], [0.85, 0.80, 0.72],
    ]);
    const wallShadow = darken(...wallColor, 0.18);
    const roofColor = pickRandom([
      [0.55, 0.22, 0.18], [0.50, 0.28, 0.20],
      [0.42, 0.25, 0.18], [0.35, 0.18, 0.14],
    ]);
    const shutterColor = darken(...wallColor, 0.30);
    const sidingColor = darken(...wallColor, 0.08);

    const hasChimney = Math.random() > 0.5;
    const chimX = w * randf(0.65, 0.8);
    const chimW = randf(6, 9);
    const chimH = randf(12, 18);

    const numWindows = w > 44 ? 2 : 1;
    const winPositions = numWindows === 2 ? [0.22, 0.72] : [0.25];
    const numLines = Math.floor(h / 7);

    const doorW = w * 0.20;
    const doorH = h * 0.42;
    const doorX = w * 0.5 - doorW * 0.5;

    // Pre-bake a stable random value per window for lit/unlit decisions.
    // Captured by the drawFn closure so each redraw uses the same base threshold.
    const winRands = winPositions.map(() => Math.random());
    const terrain = this;

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, 0);

      // Foundation
      _fillRect(ctx, -2, -4, w + 4, 4, rgba(0.42, 0.40, 0.38));

      // Wall
      _fillRect(ctx, 0, -h, w, h - 3, rgba(...wallColor));

      // Side shadow
      _fillRect(ctx, w - w * 0.2, -h, w * 0.2, h - 3, rgba(...wallShadow));

      // Siding lines
      for (let li = 0; li < numLines; li++) {
        const ly = -4 - li * (h - 4) / Math.max(numLines, 1);
        _fillRect(ctx, 1, ly - 1, w - 2, 1, rgba(...sidingColor));
      }

      // Roof
      const overhang = 6;
      ctx.fillStyle = rgba(...roofColor);
      ctx.beginPath();
      ctx.moveTo(-overhang, -h);
      ctx.lineTo(w + overhang, -h);
      ctx.lineTo(w * 0.5, -h - roofH);
      ctx.closePath();
      ctx.fill();

      // Roof shadow (right half)
      const roofShadow = darken(...roofColor, 0.15);
      ctx.fillStyle = rgba(...roofShadow);
      ctx.beginPath();
      ctx.moveTo(w + overhang, -h);
      ctx.lineTo(w * 0.5, -h);
      ctx.lineTo(w * 0.5, -h - roofH);
      ctx.closePath();
      ctx.fill();

      // Ridge cap
      const rx = w * 0.5;
      _fillRect(ctx, rx - 3, -h - roofH - 2, 6, 3, rgba(...darken(...roofColor, 0.25)));

      // Snow cap on roof (snow biome only)
      const biomeId_bld = terrain._biomeSystem ? (terrain._biomeSystem._def ? terrain._biomeSystem._def.id : null) : null;
      if (biomeId_bld === 'snow') {
        // Snow layer on both sides of pitched roof
        const snowDepth = 4;
        ctx.fillStyle = 'rgba(218,226,240,0.82)';
        ctx.beginPath();
        ctx.moveTo(-overhang, -h);
        ctx.lineTo(w * 0.5, -h - roofH);
        ctx.lineTo(w * 0.5 - snowDepth * 0.8, -h - roofH + snowDepth);
        ctx.lineTo(-overhang + snowDepth * 1.5, -h + snowDepth * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(w * 0.5, -h - roofH);
        ctx.lineTo(w + overhang, -h);
        ctx.lineTo(w + overhang - snowDepth * 1.5, -h + snowDepth * 0.5);
        ctx.lineTo(w * 0.5 + snowDepth * 0.8, -h - roofH + snowDepth);
        ctx.closePath();
        ctx.fill();
      }

      // Chimney
      if (hasChimney) {
        _fillRect(ctx, chimX, -h - 4 - chimH, chimW, chimH, rgba(0.48, 0.30, 0.25));
        _fillRect(ctx, chimX - 1.5, -h - 4 - chimH - 2.5, chimW + 3, 2.5, rgba(0.35, 0.22, 0.18));
      }

      // Door step
      _fillRect(ctx, doorX - 3, -5, doorW + 6, 3, rgba(0.50, 0.48, 0.44));
      // Door frame
      _fillRect(ctx, doorX - 2, -3 - doorH - 3, doorW + 4, doorH + 3, rgba(0.35, 0.28, 0.22));
      // Door
      _fillRect(ctx, doorX, -3 - doorH, doorW, doorH, rgba(0.30, 0.22, 0.16));
      // Doorknob
      const kx = doorX + doorW * 0.75;
      const ky = -3 - doorH * 0.5;
      _fillRect(ctx, kx - 1, ky - 1, 2, 2, rgba(0.75, 0.65, 0.30));

      // Awning
      const awningColor = lighten(...roofColor, 0.1);
      ctx.fillStyle = rgba(...awningColor);
      ctx.beginPath();
      ctx.moveTo(doorX - 4, -3 - doorH - 2);
      ctx.lineTo(doorX + doorW + 4, -3 - doorH - 2);
      ctx.lineTo(doorX + doorW + 6, -3 - doorH - 6);
      ctx.lineTo(doorX - 6, -3 - doorH - 6);
      ctx.closePath();
      ctx.fill();

      // Windows — alternating lit/unlit with warm glow
      const winW = 8, winH = 9;
      const winY = -h * 0.58;
      // winRands is pre-baked per-window for stable lit/unlit decisions across redraws.
      // Window light factor is evaluated at draw time so it responds to tod changes.
      for (let wi2 = 0; wi2 < winPositions.length; wi2++) {
        const frac = winPositions[wi2];
        const wx = w * frac - winW * 0.5;
        const winLightFactor = terrain._dayNight ? terrain._dayNight.getWindowLightFactor() : 0.67;
        // Each window has a stable random threshold; it lights up when threshold < light factor
        const isLit = winRands[wi2] < (winLightFactor * 0.85 + 0.12);
        // Frame
        _fillRect(ctx, wx - 1.5, winY - 1.5, winW + 3, winH + 3, rgba(0.35, 0.30, 0.25));
        // Glass
        if (isLit) {
          _fillRect(ctx, wx, winY, winW, winH, rgba(0.95, 0.88, 0.50, 0.95));
          // Warm glow halo around lit window
          _fillRect(ctx, wx - 3, winY - 2, winW + 6, winH + 4, rgba(1.0, 0.85, 0.40, 0.12));
        } else {
          _fillRect(ctx, wx, winY, winW, winH, rgba(0.20, 0.22, 0.28, 0.9));
        }
        // Mullions
        _fillRect(ctx, wx + winW * 0.5 - 0.5, winY, 1, winH, rgba(0.30, 0.25, 0.20));
        _fillRect(ctx, wx, winY + winH * 0.5 - 0.5, winW, 1, rgba(0.30, 0.25, 0.20));
        // Shutters
        _fillRect(ctx, wx - 5, winY - 1, 4, winH + 2, rgba(...shutterColor));
        _fillRect(ctx, wx + winW + 1, winY - 1, 4, winH + 2, rgba(...shutterColor));
        // Sill
        _fillRect(ctx, wx - 2, winY + winH + 1, winW + 4, 2.5, rgba(0.60, 0.58, 0.54));
      }

      ctx.restore();
    };

    this._registerDecoration(x, w, drawFn);
  }

  // ── Industry building ──────────────────────────────────────

  _addIndustryBuilding(x) {
    const w = randf(65, 105);
    const h = randf(42, 60);

    const bodyColor = pickRandom([
      [0.38, 0.40, 0.44], [0.42, 0.42, 0.46],
      [0.35, 0.37, 0.42], [0.40, 0.38, 0.36],
    ]);
    const bodyShadow = darken(...bodyColor, 0.15);
    const stripeLight = lighten(...bodyColor, 0.06);
    const stripeDark = darken(...bodyColor, 0.06);

    const numTeeth = randi(2, 4);
    const toothW = w / numTeeth;
    const toothH = randf(8, 14);

    const numStacks = randi(1, 2);
    const stacks = [];
    for (let si = 0; si < numStacks; si++) {
      stacks.push({
        w: randf(7, 11),
        h: randf(24, 40),
        x: w * (0.2 + si * 0.55)
      });
    }

    const numPipes = randi(1, 3);
    const pipes = [];
    for (let pi = 0; pi < numPipes; pi++) {
      pipes.push(-h * (0.25 + pi * 0.22));
    }

    const numWins = Math.floor(w / 18);
    const stripeW = 6;
    const numStripes = Math.floor(w / stripeW);

    const dockW = w * 0.3;
    const dockH = h * 0.32;
    const dockX = w * 0.62;

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, 0);

      // Foundation
      _fillRect(ctx, -3, -5, w + 6, 5, rgba(0.45, 0.43, 0.40));

      // Body
      _fillRect(ctx, 0, -h, w, h - 4, rgba(...bodyColor));

      // Side shadow
      _fillRect(ctx, w - w * 0.18, -h, w * 0.18, h - 4, rgba(...bodyShadow));

      // Corrugated stripes
      for (let si = 0; si < numStripes; si++) {
        if (si % 2 === 0) {
          _fillRect(ctx, si * stripeW, -h + 1, stripeW * 0.5, h - 6, rgba(...stripeLight));
        }
      }

      // Sawtooth roof
      for (let ti = 0; ti < numTeeth; ti++) {
        const tx = ti * toothW;
        ctx.fillStyle = rgba(0.32, 0.32, 0.34);
        ctx.beginPath();
        ctx.moveTo(tx, -h);
        ctx.lineTo(tx + toothW, -h);
        ctx.lineTo(tx + toothW, -h - toothH);
        ctx.lineTo(tx, -h - 2);
        ctx.closePath();
        ctx.fill();
        // Glass panel
        _fillRect(ctx, tx + toothW - 0.5, -h - toothH, 1, toothH, rgba(0.55, 0.70, 0.80, 0.6));
      }

      // Smokestacks
      for (const st of stacks) {
        const sx = st.x - st.w * 0.5;
        _fillRect(ctx, sx, -h - st.h, st.w, st.h, rgba(0.32, 0.30, 0.28));
        _fillRect(ctx, sx + st.w * 0.6, -h - st.h, st.w * 0.4, st.h, rgba(0.26, 0.24, 0.22));
        // Bands
        for (let bi = 0; bi < 2; bi++) {
          const by = -h - st.h * (0.3 + bi * 0.4);
          _fillRect(ctx, sx - 1, by - 2.5, st.w + 2, 2.5, rgba(0.38, 0.36, 0.34));
        }
        // Warning light
        const lx = sx + st.w * 0.5;
        const ly = -h - st.h;
        _fillRect(ctx, lx - 2.5, ly - 4, 5, 3, rgba(1.0, 0.15, 0.1, 0.95));
        _fillRect(ctx, lx - 5, ly - 6, 10, 6, rgba(1.0, 0.2, 0.1, 0.15));
      }

      // Pipes
      for (const py of pipes) {
        _fillRect(ctx, -4, py - 3, w * 0.4 + 4, 3, rgba(0.50, 0.48, 0.42));
        _fillRect(ctx, -4, py, w * 0.4 + 4, 1.5, rgba(0.28, 0.27, 0.25, 0.4));
      }

      // Industrial windows — some lit, some dark
      const winW = 9, winH = 12;
      const winY = -h * 0.52;
      for (let wi = 0; wi < numWins; wi++) {
        const wx = 12 + wi * (w - 24) / Math.max(numWins - 1, 1) - winW * 0.5;
        const isLit = (Math.floor(x * 5 + wi * 11) % 4) !== 0; // ~75% lit
        _fillRect(ctx, wx - 1.5, winY - 1.5, winW + 3, winH + 3, rgba(0.28, 0.28, 0.30));
        if (isLit) {
          _fillRect(ctx, wx, winY, winW, winH, rgba(0.55, 0.68, 0.80, 0.75));
          // Cool blue glow for industrial
          _fillRect(ctx, wx - 2, winY - 2, winW + 4, winH + 4, rgba(0.30, 0.55, 0.80, 0.08));
        } else {
          _fillRect(ctx, wx, winY, winW, winH, rgba(0.15, 0.18, 0.22, 0.9));
        }
        _fillRect(ctx, wx, winY + winH * 0.5 - 0.5, winW, 1, rgba(0.28, 0.28, 0.30));
      }

      // Loading dock
      _fillRect(ctx, dockX, -4 - dockH, dockW, dockH, rgba(0.18, 0.18, 0.20));
      // Hazard stripes
      const numHz = Math.floor(dockW / 8);
      for (let hi = 0; hi < numHz; hi++) {
        if (hi % 2 === 0) {
          const hx = dockX + hi * (dockW / numHz);
          _fillRect(ctx, hx, -4 - dockH - 3, dockW / numHz, 3, rgba(0.85, 0.70, 0.10, 0.9));
        }
      }

      ctx.restore();
    };

    this._registerDecoration(x, w, drawFn);
  }

  // ── Bridge ─────────────────────────────────────────────────

  _addBridge(x) {
    const span = randf(80, 120);
    const deckH = 5;
    const deckY = -20;
    const pillarW = 10;
    const towerH = 50;
    const rampLen = 25;

    const bridgeColor = rgba(0.48, 0.45, 0.40);
    const pillarColor = rgba(0.40, 0.38, 0.35);
    const pillarShadow = rgba(0.32, 0.30, 0.28);
    const railingColor = rgba(0.55, 0.52, 0.48);
    const cableColor = rgba(0.42, 0.40, 0.38, 0.8);
    const roadColor = rgba(0.28, 0.28, 0.27);
    const markingColor = rgba(0.85, 0.82, 0.70, 0.7);

    const rtX = span - pillarW * 2;

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, 0);

      // Road approach ramps
      ctx.fillStyle = roadColor;
      ctx.beginPath();
      ctx.moveTo(-rampLen, 0); ctx.lineTo(0, 0); ctx.lineTo(0, deckY); ctx.lineTo(-rampLen, -3);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(span, 0); ctx.lineTo(span + rampLen, 0); ctx.lineTo(span + rampLen, -3); ctx.lineTo(span, deckY);
      ctx.closePath(); ctx.fill();

      // Left tower
      _fillRect(ctx, pillarW, -towerH, pillarW, towerH, pillarColor);
      _fillRect(ctx, pillarW * 1.5, -towerH, pillarW * 0.5, towerH, pillarShadow);
      _fillRect(ctx, pillarW - 2, -towerH - 4, pillarW + 4, 4, pillarShadow);

      // Right tower
      _fillRect(ctx, rtX, -towerH, pillarW, towerH, pillarColor);
      _fillRect(ctx, rtX + pillarW * 0.5, -towerH, pillarW * 0.5, towerH, pillarShadow);
      _fillRect(ctx, rtX - 2, -towerH - 4, pillarW + 4, 4, pillarShadow);

      // Deck
      _fillRect(ctx, 0, deckY - deckH, span, deckH, bridgeColor);
      // Underside shadow
      _fillRect(ctx, 2, deckY, span - 4, 3, rgba(0.22, 0.20, 0.18, 0.5));
      // Road surface
      _fillRect(ctx, 2, deckY - deckH - 2, span - 4, 2, roadColor);

      // Center dashed marking
      const markY = deckY - deckH - 0.5;
      let cx = 5;
      while (cx < span - 5) {
        _fillRect(ctx, cx, markY - 1.5, 8, 1.5, markingColor);
        cx += 14;
      }

      // Edge markings
      _fillRect(ctx, 3, deckY - deckH - 2, 1.5, 2, markingColor);
      _fillRect(ctx, span - 4.5, deckY - deckH - 2, 1.5, 2, markingColor);

      // Suspension cables
      const ltTop = { x: pillarW * 1.5, y: -towerH - 3 };
      const rtTop = { x: rtX + pillarW * 0.5, y: -towerH - 3 };
      const cableSegs = 10;
      ctx.fillStyle = cableColor;
      for (let ci = 0; ci < cableSegs; ci++) {
        const t0 = ci / cableSegs;
        const t1 = (ci + 1) / cableSegs;
        const x0 = lerp(ltTop.x, rtTop.x, t0);
        const x1 = lerp(ltTop.x, rtTop.x, t1);
        const sag0 = 4 * (towerH - 25) * t0 * (1 - t0);
        const sag1 = 4 * (towerH - 25) * t1 * (1 - t1);
        ctx.beginPath();
        ctx.moveTo(x0, ltTop.y + sag0);
        ctx.lineTo(x1, ltTop.y + sag1);
        ctx.lineTo(x1, ltTop.y + sag1 - 1.5);
        ctx.lineTo(x0, ltTop.y + sag0 - 1.5);
        ctx.closePath();
        ctx.fill();
      }

      // Vertical suspender cables
      const numSusp = Math.floor(span / 12);
      for (let si = 1; si < numSusp; si++) {
        const t = si / numSusp;
        const sx = lerp(ltTop.x, rtTop.x, t);
        const sag = 4 * (towerH - 25) * t * (1 - t);
        const syTop = ltTop.y + sag;
        const syBot = deckY - deckH;
        if (syTop < syBot) {
          _fillRect(ctx, sx - 0.5, syTop, 1, syBot - syTop, cableColor);
        }
      }

      // Railings
      const numPosts = Math.floor(span / 12);
      const postH = 10;
      for (let pi = 0; pi <= numPosts; pi++) {
        const px = pi * span / Math.max(numPosts, 1);
        _fillRect(ctx, px - 1, deckY - deckH - 2 - postH, 2, postH, railingColor);
      }
      // Top rail
      _fillRect(ctx, 0, deckY - deckH - 2 - postH - 2, span, 2, railingColor);

      // Arches under deck
      ctx.fillStyle = rgba(0.22, 0.20, 0.18, 0.4);
      for (let ai = 0; ai < 2; ai++) {
        const archCx = span * (0.33 + ai * 0.34);
        const archRx = span * 0.2;
        ctx.beginPath();
        for (let asi = 0; asi <= 14; asi++) {
          const angle = Math.PI * asi / 14;
          const px = archCx + Math.cos(angle) * archRx;
          const py = -Math.sin(angle) * 16;
          if (asi === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.lineTo(archCx + archRx, 0);
        ctx.lineTo(archCx - archRx, 0);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    };

    this._registerDecoration(x, span + rampLen * 2, drawFn);
  }

  // ── Soldier group ──────────────────────────────────────────

  _addSoldierGroup(x) {
    const count = randi(2, 5);
    const spread = count * 14;

    const uniformColors = [
      [0.25, 0.32, 0.20], [0.28, 0.30, 0.22],
      [0.22, 0.28, 0.20], [0.30, 0.33, 0.24],
    ];
    const skinTones = [
      [0.72, 0.58, 0.45], [0.68, 0.52, 0.38],
      [0.78, 0.62, 0.48], [0.60, 0.45, 0.32],
    ];
    const helmetColor = [0.22, 0.26, 0.18];
    const bootColor = [0.18, 0.15, 0.12];
    const weaponColor = [0.25, 0.22, 0.18];
    const gearColor = [0.30, 0.28, 0.22];

    const hasSandbags = Math.random() < 0.4;
    const hasFlag = Math.random() < 0.3;
    const flagX = spread * randf(0.6, 0.9);
    const flagColor = pickRandom([
      [0.15, 0.35, 0.55], [0.55, 0.15, 0.15], [0.20, 0.40, 0.20],
    ]);

    // Pre-generate soldier data
    const soldiers = [];
    for (let si = 0; si < count; si++) {
      const sx = si * randf(10, 16) + (hasSandbags ? 15 : 0);
      const skinColor = pickRandom(skinTones);
      const uniColor = pickRandom(uniformColors);
      const bodyH = randf(7, 9);
      const hasPack = Math.random() < 0.5;
      soldiers.push({ sx, skinColor, uniColor, bodyH, hasPack });
    }

    const drawFn = (ctx) => {
      ctx.save();
      ctx.translate(x, 0);

      // Sandbags
      if (hasSandbags) {
        const sbX = spread * 0.3;
        for (let row = 0; row < 3; row++) {
          const bagsInRow = 3 - row;
          for (let bi = 0; bi < bagsInRow; bi++) {
            const bx = sbX + bi * 10 - bagsInRow * 5 + row * 3;
            const by = -row * 5;
            const dk = darken(0.52, 0.46, 0.32, row * 0.05);
            ctx.fillStyle = rgba(...dk);
            ctx.beginPath();
            ctx.moveTo(bx, by); ctx.lineTo(bx + 9, by);
            ctx.lineTo(bx + 8, by - 4.5); ctx.lineTo(bx + 1, by - 4.5);
            ctx.closePath(); ctx.fill();
            // Seam
            _fillRect(ctx, bx + 4, by - 3.5, 1, 2.5, rgba(0.42, 0.38, 0.26));
          }
        }
      }

      // Flag
      if (hasFlag) {
        _fillRect(ctx, flagX - 0.8, -35, 1.6, 35, rgba(0.45, 0.42, 0.38));
        ctx.fillStyle = rgba(...flagColor);
        ctx.beginPath();
        ctx.moveTo(flagX + 1, -35);
        ctx.lineTo(flagX + 16, -32);
        ctx.lineTo(flagX + 1, -28);
        ctx.closePath();
        ctx.fill();
      }

      // Soldiers
      for (const s of soldiers) {
        ctx.save();
        ctx.translate(s.sx, 0);

        const uniDk = darken(...s.uniColor, 0.12);
        const uniDk2 = darken(...s.uniColor, 0.08);

        // Boots
        ctx.fillStyle = rgba(...bootColor);
        _poly(ctx, [[-3, 0], [-0.5, 0], [-0.5, -4], [-3, -3.5]]);
        _poly(ctx, [[0.5, 0], [3, 0], [3, -3.5], [0.5, -4]]);

        // Legs
        ctx.fillStyle = rgba(...uniDk);
        _poly(ctx, [[-2.5, -3.5], [-0.5, -4], [-0.5, -7], [-2.5, -7]]);
        _poly(ctx, [[0.5, -4], [2.5, -3.5], [2.5, -7], [0.5, -7]]);

        // Torso
        ctx.fillStyle = rgba(...s.uniColor);
        _poly(ctx, [[-3, -7], [3, -7], [2.5, -7 - s.bodyH], [-2.5, -7 - s.bodyH]]);

        // Belt
        _fillRect(ctx, -3.2, -9, 6.4, 1.5, rgba(0.22, 0.20, 0.16));

        // Arms
        const armY = -7 - s.bodyH * 0.4;
        ctx.fillStyle = rgba(...uniDk2);
        _poly(ctx, [[-3, armY + 2], [-5.5, armY], [-5, armY - 1.5], [-2.5, armY + 0.5]]);
        _poly(ctx, [[3, armY + 2], [5.5, armY], [5, armY - 1.5], [2.5, armY + 0.5]]);

        // Weapon
        const wy = armY - 0.5;
        ctx.fillStyle = rgba(...weaponColor);
        _poly(ctx, [[4.5, wy + 1], [12, wy - 2], [12, wy - 3.5], [4.5, wy - 0.5]]);

        // Backpack
        if (s.hasPack) {
          const packY = -7 - s.bodyH * 0.3;
          _fillRect(ctx, -5, packY - 3, 2, 6, rgba(...gearColor));
        }

        // Neck
        const neckY = -7 - s.bodyH;
        _fillRect(ctx, -1.2, neckY - 2, 2.4, 2, rgba(...s.skinColor));

        // Head
        const headY = neckY - 2;
        _fillRect(ctx, -2.5, headY - 4, 5, 4, rgba(...s.skinColor));

        // Helmet
        const hy = headY - 3.5;
        ctx.fillStyle = rgba(...helmetColor);
        _poly(ctx, [[-3.5, hy + 1], [3.5, hy + 1], [3, hy - 2.5], [-3, hy - 2.5]]);
        // Helmet band
        _fillRect(ctx, -3.3, hy - 0.2, 6.6, 1.2, rgba(0.35, 0.32, 0.26));

        ctx.restore();
      }

      ctx.restore();
    };

    this._registerDecoration(x, spread + (hasSandbags ? 15 : 0), drawFn);
  }
}

// ── Helpers ────────────────────────────────────────────────

function _fillRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function _poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
