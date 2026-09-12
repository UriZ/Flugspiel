/**
 * UI — HUD, wave banner, crosshair, and overlay screens.
 *
 * All rendering uses Canvas 2D (no HTML elements).
 * Call drawHUD / drawCrosshair / drawWaveBanner from game.render() after
 * renderer.beginUI() has been called so the shake offset is excluded.
 */

import { Renderer } from './engine/renderer.js';
import { rgba, clamp, lerp } from './utils.js';

// ── Layout constants (logical coords, 2560×1440) ──────────────────────────

const LOGICAL_W = Renderer.LOGICAL_W; // 2560
const LOGICAL_H = Renderer.LOGICAL_H; // 1440

// Launcher HUD panel — bottom-left corner
const LAUNCHER_PANEL_X = 30;
const LAUNCHER_PANEL_Y = LOGICAL_H - 30;
const LAUNCHER_CARD_W = 220;
const LAUNCHER_CARD_H = 90;
const LAUNCHER_CARD_GAP = 14;

// Known launcher slots (match Godot positions in SCENE_DATA.md)
// Order corresponds to key 1–5.
const LAUNCHER_SLOTS = [
  { key: '1', type: 'sam',        label: 'SAM'     },
  { key: '2', type: 'heatseeker', label: 'HEAT-SK' },
  { key: '3', type: 'truck',      label: 'TRUCK'   },
  { key: '4', type: 'vulkan',     label: 'VULKAN'  },
  { key: '5', type: 'drone_pad',  label: 'HUNTER'  },
  { key: '6', type: 'laser',      label: 'LASER'   },
  { key: '7', type: 'bike',       label: 'BIKE'    },
];

// Nuke warning duration
const NUKE_WARNING_DURATION = 5.0; // seconds

// Wave banner animation phases
const BANNER_FADE_IN  = 0.35; // seconds
const BANNER_HOLD     = 1.80; // seconds
const BANNER_FADE_OUT = 0.45; // seconds

// Crosshair geometry
const CROSSHAIR_GAP       = 14;  // gap around center (px)
const CROSSHAIR_LINE_LEN  = 32;  // length of each crosshair arm
const CROSSHAIR_BRACKET   = 10;  // corner bracket leg length
const CROSSHAIR_BRACKET_D = 18;  // distance from centre to bracket corner

// Heat bar — positioned above the Vulkan card (slot index 3)
const VULKAN_SLOT_INDEX = 3;
const HEAT_BAR_X      = LAUNCHER_PANEL_X + VULKAN_SLOT_INDEX * (LAUNCHER_CARD_W + LAUNCHER_CARD_GAP);
const HEAT_BAR_BOTTOM = LAUNCHER_PANEL_Y - LAUNCHER_CARD_H - 20;
const HEAT_BAR_W      = LAUNCHER_CARD_W;
const HEAT_BAR_H      = 22;

// Energy bar — positioned above the Laser card (slot index 5)
const LASER_SLOT_INDEX  = 5;
const ENERGY_BAR_X      = LAUNCHER_PANEL_X + LASER_SLOT_INDEX * (LAUNCHER_CARD_W + LAUNCHER_CARD_GAP);
const ENERGY_BAR_BOTTOM = LAUNCHER_PANEL_Y - LAUNCHER_CARD_H - 20;
const ENERGY_BAR_W      = LAUNCHER_CARD_W;
const ENERGY_BAR_H      = 22;

// ── Color helpers ─────────────────────────────────────────────────────────

/** Interpolate between two CSS rgba strings using a linear t in [0,1]. */
function lerpColor(r1, g1, b1, r2, g2, b2, t) {
  return rgba(
    lerp(r1, r2, t),
    lerp(g1, g2, t),
    lerp(b1, b2, t),
  );
}

/** Derive heat-bar fill color from heat 0..1. */
function heatBarColor(heat) {
  if (heat < 0.5) {
    // green → yellow
    return lerpColor(0.2, 0.85, 0.3, 0.9, 0.85, 0.1, heat * 2);
  }
  if (heat < 0.8) {
    // yellow → orange
    return lerpColor(0.9, 0.85, 0.1, 1.0, 0.5, 0.05, (heat - 0.5) / 0.3);
  }
  // orange → red
  return lerpColor(1.0, 0.5, 0.05, 1.0, 0.1, 0.05, (heat - 0.8) / 0.2);
}

// ── UI class ──────────────────────────────────────────────────────────────

export class UI {
  /**
   * @param {Renderer} renderer
   */
  constructor(renderer) {
    this._renderer = renderer;

    // Wave banner state
    this._bannerText  = '';
    this._bannerColor = rgba(1, 0.85, 0.1);
    this._bannerTimer = 0;
    this._bannerPhase = 'idle'; // 'idle' | 'fadein' | 'hold' | 'fadeout'

    // Nuke warning state
    this._nukeWarningTimer = 0;
    this._nukeWarningActive = false;

    // Heat-seeker lock-on dramatic state
    this._lockActive = false;
    this._lockJustAcquired = false;
    this._lockTimer = 0;
    this._lockPulseTimer = 0;
    this._lockParticles = [];

    // Converging Chevrons crosshair rotation state
    this._lockRingRotation = 0; // advances at 1.0 rad/s when locked, reset on lock loss
    this._scanRotation = 0;     // for scanning circle rotation (+0.5 rad/s)

    // Pending target position for particle origin injection
    this._pendingTargetX = 0;
    this._pendingTargetY = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Trigger a wave banner animation.
   * @param {string} text   — e.g. "WAVE 3" or "WAVE 3 CLEAR"
   * @param {string} [color] — CSS color string (default: gold)
   */
  showWaveBanner(text, color = rgba(1, 0.85, 0.1)) {
    this._bannerText  = text;
    this._bannerColor = color;
    this._bannerTimer = 0;
    this._bannerPhase = 'fadein';
  }

  /** Activate the nuke incoming warning banner. */
  showNukeWarning() {
    this._nukeWarningActive = true;
    this._nukeWarningTimer = Math.max(this._nukeWarningTimer, NUKE_WARNING_DURATION);
  }

  // ── Per-frame draw methods ─────────────────────────────────────────────

  /**
   * Main HUD — score, wave number, contextual info text, launcher panel, heat bar.
   * Must be called after renderer.beginUI().
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} game — Game instance
   * @param {number} [dt=1/60] — delta time in seconds
   */
  drawHUD(ctx, game, dt = 1 / 60) {
    if (game.state === 'start') return; // start screen handled by game.js

    // ── Score + wave panel (top-left) ──
    this._drawScorePanel(ctx, game);

    // ── Contextual info (top-center) — suppressed while nuke warning is active ──
    if (!this._nukeWarningActive) {
      const infoMsg = this._getInfoText(game);
      if (infoMsg) {
        this._drawContextualInfo(ctx, infoMsg);
      }
    }

    // ── Launcher panel (bottom-left) ──
    this._drawLauncherPanel(ctx, game);

    // ── Heat bar (only when vulkan selected and has accumulated heat) ──
    const sel = game.selectedLauncher;
    if (sel && sel.type === 'vulkan' && sel.alive && sel.heat > 0.01) {
      this._drawHeatBar(ctx, sel.heat, sel.overheated);
    }

    // ── Energy bar (laser launcher — always visible when laser selected) ──
    if (sel && sel.type === 'laser' && sel.alive) {
      this._drawEnergyBar(ctx, sel.energy, sel.laserState);
    }

    // ── Shield HUD card (bottom-right) ──
    this._drawShieldCard(ctx, game);

    // ── Game Over overlay ──
    if (game.state === 'gameover') {
      this._drawGameOverOverlay(ctx, game.score);
    }

    // ── Nuke warning banner ──
    this._drawNukeWarning(ctx, dt);
  }

  /**
   * Animated wave banner centred on screen.
   * Must be called after renderer.beginUI().
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} dt — delta time in seconds
   */
  drawWaveBanner(ctx, dt) {
    if (this._bannerPhase === 'idle') return;

    this._bannerTimer += dt;
    let alpha = 1;

    if (this._bannerPhase === 'fadein') {
      alpha = clamp(this._bannerTimer / BANNER_FADE_IN, 0, 1);
      if (this._bannerTimer >= BANNER_FADE_IN) {
        this._bannerPhase = 'hold';
        this._bannerTimer = 0;
      }
    } else if (this._bannerPhase === 'hold') {
      alpha = 1;
      if (this._bannerTimer >= BANNER_HOLD) {
        this._bannerPhase = 'fadeout';
        this._bannerTimer = 0;
      }
    } else if (this._bannerPhase === 'fadeout') {
      alpha = clamp(1 - this._bannerTimer / BANNER_FADE_OUT, 0, 1);
      if (this._bannerTimer >= BANNER_FADE_OUT) {
        this._bannerPhase = 'idle';
        this._bannerTimer = 0;
        return;
      }
    }

    // Suppress rendering while nuke warning is active (state machine still ticks)
    if (this._nukeWarningActive) return;

    const cx = LOGICAL_W / 2;
    const cy = LOGICAL_H / 2;

    // Backdrop: rounded rect 1200x148 with vignette gradient fading at edges
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    const bdW = 1200, bdH = 148;
    const bdX = cx - bdW / 2, bdY = cy - bdH / 2;
    const vigGrad = ctx.createLinearGradient(bdX, cy, bdX + bdW, cy);
    vigGrad.addColorStop(0,   'rgba(0,0,0,0)');
    vigGrad.addColorStop(0.08,'rgba(0,0,0,0.75)');
    vigGrad.addColorStop(0.92,'rgba(0,0,0,0.75)');
    vigGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = vigGrad;
    _roundRect(ctx, bdX, bdY, bdW, bdH, 12);
    ctx.fill();
    ctx.restore();

    // Flanking horizontal lines
    ctx.save();
    ctx.globalAlpha = alpha * 0.35;
    ctx.strokeStyle = 'rgba(255,210,50,0.35)';
    ctx.lineWidth = 1.5;
    const lineY = cy;
    const lineInset = 80;
    const lineLen = 320;
    ctx.beginPath();
    ctx.moveTo(cx - bdW / 2 + lineInset, lineY);
    ctx.lineTo(cx - bdW / 2 + lineInset + lineLen, lineY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + bdW / 2 - lineInset - lineLen, lineY);
    ctx.lineTo(cx + bdW / 2 - lineInset, lineY);
    ctx.stroke();
    ctx.restore();

    // Diamond decorations at line ends
    ctx.save();
    ctx.globalAlpha = alpha * 0.6;
    ctx.fillStyle = 'rgba(255,210,50,0.6)';
    const diamondPositions = [
      cx - bdW / 2 + lineInset,
      cx - bdW / 2 + lineInset + lineLen,
      cx + bdW / 2 - lineInset - lineLen,
      cx + bdW / 2 - lineInset,
    ];
    for (const dx of diamondPositions) {
      const ds = 7;
      ctx.beginPath();
      ctx.moveTo(dx, lineY - ds);
      ctx.lineTo(dx + ds, lineY);
      ctx.lineTo(dx, lineY + ds);
      ctx.lineTo(dx - ds, lineY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Main banner text — bold 108px #FFD700, drop shadow blur 20
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 108px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Drop shadow pass
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 20;
    ctx.fillStyle = this._bannerColor;
    ctx.fillText(this._bannerText, cx, cy);
    ctx.shadowBlur = 0;
    // White highlight pass at offset (1,-1)
    ctx.globalAlpha = alpha * 0.25;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(this._bannerText, cx + 1, cy - 1);
    ctx.restore();
  }

  /**
   * Crosshair drawn at the logical mouse position.
   * Mode depends on selected launcher type and lock state.
   * Must be called after renderer.beginUI().
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} game — Game instance
   */
  drawCrosshair(ctx, game) {
    if (game.state === 'start') return;

    // Clamp cursor so crosshair arms never clip outside the canvas edges.
    const _margin = CROSSHAIR_GAP + CROSSHAIR_LINE_LEN;
    const mx = clamp(game.input.mouseX, _margin, LOGICAL_W - _margin);
    const my = clamp(game.input.mouseY, _margin, LOGICAL_H - _margin);
    const sel = game.selectedLauncher;

    const isHeat   = sel && sel.type === 'heatseeker' && sel.alive;
    // game.lockedTarget may be set by game.js when heat-seeker launcher has a lock
    const locked   = isHeat && game.lockedTarget && game.lockedTarget.alive;

    // Advance lock-on state machine (must happen before drawing)
    const dt = game._lastDt || 1 / 60;
    this.updateLockState(!!locked, dt);

    if (locked) {
      // Apply camera shake offset so the target ring follows the entity visually
      const shakeX = game.renderer ? game.renderer.cameraOffsetX : 0;
      const shakeY = game.renderer ? game.renderer.cameraOffsetY : 0;
      this._drawLockedCrosshair(ctx, mx, my, game.lockedTarget, shakeX, shakeY);
    } else if (isHeat) {
      this._drawHeatCrosshair(ctx, mx, my);
    } else {
      this._drawDefaultCrosshair(ctx, mx, my, sel);
    }
  }

  // ── Lock state management ──────────────────────────────────────────────

  /**
   * Update lock-on state machine. Must be called once per frame before drawing.
   * @param {boolean} locked — whether a target is currently locked
   * @param {number} dt — delta time in seconds
   */
  updateLockState(locked, dt) {
    const wasLocked = this._lockActive;

    // Always advance scan rotation regardless of lock state
    this._scanRotation += 0.5 * dt;

    if (locked) {
      if (!wasLocked) {
        // Transition false→true: acquisition event
        this._lockJustAcquired = true;
        this._lockTimer = 0;
        this._lockPulseTimer = 0;
        this._lockRingRotation = 0;

        // Spawn 18-26 spark particles at target position.
        // ox/oy will be set from target coords when first drawn.
        const count = 18 + Math.floor(Math.random() * 9); // 18..26
        for (let i = 0; i < count; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 140 + Math.random() * 260;  // faster, more spread
          const life  = 0.30 + Math.random() * 0.35; // 0.30-0.65s lifetime
          this._lockParticles.push({
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life,
            maxLife: life,
            radius: 4 + Math.random() * 6,  // larger sparks
            ox: 0, oy: 0,
            x: 0, y: 0,
          });
        }
      }

      this._lockActive = true;
      this._lockTimer += dt;
      this._lockPulseTimer += dt;
      this._lockRingRotation += 1.0 * dt; // 1.0 rad/s ring rotation

      // Update particles
      for (const p of this._lockParticles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // Decelerate
        p.vx *= (1 - 4 * dt);
        p.vy *= (1 - 4 * dt);
        p.life -= dt;
      }
      // Cull dead particles
      this._lockParticles = this._lockParticles.filter(p => p.life > 0);

      // Clear the just-acquired flag after the flash window
      if (this._lockTimer >= 0.3) {
        this._lockJustAcquired = false;
      }
    } else {
      // Not locked — reset all state
      this._lockActive = false;
      this._lockJustAcquired = false;
      this._lockTimer = 0;
      this._lockPulseTimer = 0;
      this._lockParticles = [];
      this._lockRingRotation = 0;
    }
  }

  // ── Private draw helpers ───────────────────────────────────────────────

  /**
   * Score/wave display panel — top-left, 320x110px.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} game
   */
  _drawScorePanel(ctx, game) {
    const px = 24, py = 24, pw = 320, ph = 110;
    ctx.save();

    // Panel background gradient
    const bg = ctx.createLinearGradient(px, py, px, py + ph);
    bg.addColorStop(0, 'rgba(8,14,28,0.88)');
    bg.addColorStop(1, 'rgba(4,8,18,0.78)');
    ctx.fillStyle = bg;
    _roundRect(ctx, px, py, pw, ph, 10);
    ctx.fill();

    // Left accent bar — 3px #00EEFF with shadowBlur=8
    ctx.shadowColor = '#00EEFF';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#00EEFF';
    ctx.fillRect(px, py + 8, 3, ph - 16);
    ctx.shadowBlur = 0;

    // Score label
    ctx.font = '20px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#8899CC';
    ctx.fillText('SCORE', px + 14, py + 12);

    // Score value — bold 52px white monospace
    ctx.font = 'bold 52px monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(String(game.score), px + 14, py + 34);

    // Wave value — bold 36px #88CCFF
    // Suppressed while the centered wave banner is animating to avoid duplication.
    if (game.waveNumber > 0 && this._bannerPhase === 'idle') {
      ctx.font = 'bold 36px monospace';
      ctx.fillStyle = '#88CCFF';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`WAVE ${game.waveNumber}`, px + pw - 12, py + ph - 10);
    }

    ctx.restore();
  }

  /**
   * Contextual info pill — top-center.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} msg
   */
  _drawContextualInfo(ctx, msg) {
    ctx.save();
    ctx.font = '28px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(msg).width;
    const cx = LOGICAL_W / 2;
    const cy = 40;
    const pr = 14; // pill radius
    const pw = tw + pr * 2;

    // Pill background
    ctx.fillStyle = 'rgba(6,12,24,0.70)';
    _roundRect(ctx, cx - pw / 2, cy - 22, pw, 44, pr);
    ctx.fill();

    // Text with shadow glow
    ctx.shadowColor = 'rgba(180,210,255,0.5)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#BBCCDD';
    ctx.fillText(msg, cx, cy);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  /**
   * Build contextual info string for the selected launcher.
   * @param {object} game
   * @returns {string}
   */
  _getInfoText(game) {
    const sel = game.selectedLauncher;
    if (!sel) return 'Click a launcher to select   [1-5] select launcher';
    if (!sel.alive) return 'LAUNCHER DESTROYED — select another';
    switch (sel.type) {
      case 'sam':
        return 'SAM — Click to fire missile';
      case 'heatseeker':
        return 'HEAT-SEEKER — Hold near target to lock, click to fire';
      case 'truck':
        return 'TRUCK — Click to fire rocket';
      case 'vulkan':
        return 'VULKAN — Hold click to fire   (watch heat!)';
      case 'drone_pad': {
        const stock = sel.stock !== undefined ? sel.stock : 5;
        const cd = sel.deployCooldown > 0 ? ` (cooldown ${sel.deployCooldown.toFixed(1)}s)` : '';
        return `HUNTER — Click to deploy drone   stock:[${stock}]${cd}`;
      }
      case 'laser': {
        const state = sel.laserState || 'idle';
        const energyPct = Math.round((sel.energy || 0) * 100);
        if (state === 'warming') return `LASER — Charging... hold to fire`;
        if (state === 'firing')  return `LASER — FIRING   energy:${energyPct}%`;
        return `LASER — Hold click to fire directed energy beam`;
      }
      case 'bike': {
        const cd = sel._fireCooldownTimer > 0 ? ` (reload ${sel._fireCooldownTimer.toFixed(1)}s)` : '';
        return `BIKE — Click to fire missile${cd}   ← → to drive`;
      }
      default:
        return '';
    }
  }

  /**
   * Draw the launcher status panel (bottom-left).
   * Shows up to 4 cards, one per launcher slot, with key number, type label,
   * selected highlight, and destroyed state.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} game
   */
  _drawLauncherPanel(ctx, game) {
    const launchers = game.entities ? game.entities.getGroup('launchers') : [];

    // Build a lookup: type → launcher entity (take first match per type)
    /** @type {Map<string, object>} */
    const byType = new Map();
    for (const l of launchers) {
      if (!byType.has(l.type)) byType.set(l.type, l);
    }

    for (let i = 0; i < LAUNCHER_SLOTS.length; i++) {
      const slot     = LAUNCHER_SLOTS[i];
      const launcher = byType.get(slot.type) || null;
      const isAlive  = launcher && launcher.alive;
      // Check selected: compare by reference OR by type (if selectedLauncher not in group yet)
      const isSel    = launcher && game.selectedLauncher === launcher;

      const cardX = LAUNCHER_PANEL_X + i * (LAUNCHER_CARD_W + LAUNCHER_CARD_GAP);
      const cardY = LAUNCHER_PANEL_Y - LAUNCHER_CARD_H;

      this._drawLauncherCard(ctx, cardX, cardY, slot, isAlive, isSel, launcher);
    }
  }

  /**
   * Draw a single launcher card.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x — top-left x
   * @param {number} y — top-left y
   * @param {{ key: string, type: string, label: string }} slot
   * @param {boolean} isAlive
   * @param {boolean} isSelected
   * @param {object|null} launcher
   */
  _drawLauncherCard(ctx, x, y, slot, isAlive, isSelected, launcher) {
    const w = LAUNCHER_CARD_W;
    const h = LAUNCHER_CARD_H;

    ctx.save();

    // Card background gradient
    const bg = ctx.createLinearGradient(x, y, x, y + h);
    if (isSelected) {
      bg.addColorStop(0, 'rgba(8,30,68,0.92)');
      bg.addColorStop(1, 'rgba(4,18,48,0.92)');
    } else if (!isAlive) {
      bg.addColorStop(0, 'rgba(28,10,10,0.88)');
      bg.addColorStop(1, 'rgba(18,6,6,0.88)');
    } else {
      bg.addColorStop(0, 'rgba(10,16,28,0.85)');
      bg.addColorStop(1, 'rgba(6,10,18,0.85)');
    }
    ctx.fillStyle = bg;
    _roundRect(ctx, x, y, w, h, 8);
    ctx.fill();

    // Per-type accent color for selected border
    const ACCENT_COLOR = {
      sam:        { shadow: '#00CCFF', stroke: 'rgba(0,180,255,0.85)' },
      heatseeker: { shadow: '#00CCFF', stroke: 'rgba(0,180,255,0.85)' },
      truck:      { shadow: '#00CCFF', stroke: 'rgba(0,180,255,0.85)' },
      vulkan:     { shadow: '#00CCFF', stroke: 'rgba(0,180,255,0.85)' },
      drone_pad:  { shadow: '#00CCFF', stroke: 'rgba(0,180,255,0.85)' },
      laser:      { shadow: '#00CCFF', stroke: 'rgba(0,180,255,0.85)' },
      bike:       { shadow: '#FF4400', stroke: 'rgba(255,80,0,0.85)' },
    };
    const accent = ACCENT_COLOR[slot.type] || ACCENT_COLOR.sam;

    // Border
    if (isSelected) {
      ctx.shadowColor = accent.shadow;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = accent.stroke;
      ctx.lineWidth = 1.5;
    } else if (!isAlive) {
      ctx.strokeStyle = 'rgba(100,30,30,0.4)';
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = 'rgba(40,60,80,0.55)';
      ctx.lineWidth = 1;
    }
    _roundRect(ctx, x, y, w, h, 8);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Key badge — 32x22px rounded rect at top-left
    const badgeX = x + 8, badgeY = y + 8, badgeW = 32, badgeH = 22;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    _roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 5);
    ctx.fill();
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isSelected ? '#88CCFF' : '#6699CC';
    ctx.fillText(`[${slot.key}]`, badgeX + badgeW / 2, badgeY + badgeH / 2);

    // Type label
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (!isAlive) {
      ctx.fillStyle = 'rgba(140,64,64,0.7)';
    } else if (isSelected) {
      ctx.fillStyle = '#FFFFFF';
    } else {
      ctx.fillStyle = 'rgba(192,210,224,1)';
    }
    ctx.fillText(slot.label, x + 48, y + h / 2 + 6);

    // Status dot at top-right
    const dotX = x + w - 16, dotY = y + 16;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
    if (!isAlive) {
      ctx.fillStyle = '#441111';
    } else if (isSelected) {
      // SELECTED — cyan pulsing
      const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.006);
      ctx.fillStyle = `rgba(68,${Math.round(204 * pulse)},255,${pulse.toFixed(2)})`;
    } else {
      // READY — green pulsing
      const pulse = 0.7 + 0.3 * Math.sin(Date.now() * 0.004);
      ctx.fillStyle = `rgba(34,${Math.round(204 * pulse)},85,${pulse.toFixed(2)})`;
    }
    ctx.fill();

    // "DESTROYED" label
    if (!isAlive) {
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(217,64,51,0.9)';
      ctx.fillText('DESTROYED', x + w - 10, y + h - 8);
    }

    // Stock count for HUNTER drone pad
    if (slot.type === 'drone_pad' && isAlive && launcher) {
      const stock = launcher.stock !== undefined ? launcher.stock : 5;
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = stock > 0 ? 'rgba(0,255,136,0.85)' : 'rgba(255,50,50,0.9)';
      ctx.fillText(`[${stock}]`, x + w - 10, y + h - 8);
    }

    // Cooldown + speed bar for BIKE launcher
    if (slot.type === 'bike' && isAlive && launcher) {
      // Cooldown indicator (top-right corner of card)
      const cd = launcher._fireCooldownTimer || 0;
      if (cd > 0) {
        ctx.font = 'bold 18px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,200,50,0.9)';
        ctx.fillText(`${cd.toFixed(1)}s`, x + w - 10, y + h - 8);
      } else {
        ctx.font = 'bold 18px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(0,255,136,0.85)';
        ctx.fillText('READY', x + w - 10, y + h - 8);
      }
      // Speed indicator bar
      const speed = launcher.currentSpeed || 0;
      const maxSpeed = launcher.moveSpeed || 280;
      const speedRatio = Math.min(1, speed / maxSpeed);
      const barX = x + 8;
      const barY = y + h - 18;
      const barW = w - 16;
      const barH = 6;
      // Background
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      _roundRect(ctx, barX, barY, barW, barH, 3);
      ctx.fill();
      // Fill
      if (speedRatio > 0) {
        const spdGrad = ctx.createLinearGradient(barX, barY, barX + barW * speedRatio, barY);
        spdGrad.addColorStop(0, 'rgba(60,80,50,0.8)');
        spdGrad.addColorStop(0.5, 'rgba(200,160,20,0.9)');
        spdGrad.addColorStop(1, 'rgba(255,80,20,0.95)');
        ctx.fillStyle = spdGrad;
        _roundRect(ctx, barX, barY, barW * speedRatio, barH, 3);
        ctx.fill();
      }
      // SPD label
      ctx.font = '12px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(150,160,140,0.7)';
      ctx.fillText('SPD', barX + 2, barY + barH / 2);
    }

    ctx.restore();
  }

  /**
   * Draw the heat bar for the Vulkan Cannon.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} heat — 0..1
   * @param {boolean} overheated
   */
  _drawHeatBar(ctx, heat, overheated) {
    const x = HEAT_BAR_X;
    const y = HEAT_BAR_BOTTOM - HEAT_BAR_H;
    const w = HEAT_BAR_W;
    const h = 28;

    ctx.save();

    // Label
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = rgba(0.7, 0.75, 0.8, 0.9);
    ctx.fillText('HEAT', x, y - 4);

    // Track — rgba(6,6,8,0.85) rounded r=5
    ctx.fillStyle = 'rgba(6,6,8,0.85)';
    _roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,60,60,0.6)';
    ctx.lineWidth = 1.5;
    _roundRect(ctx, x, y, w, h, 5);
    ctx.stroke();

    // Fill gradient: 0-40% green→yellow, 40-75% →orange, 75-100% →red
    const fillW = clamp(heat, 0, 1) * (w - 4);
    if (fillW > 0) {
      if (overheated) {
        // Pulsing red when overheated
        const pulse = 0.1 + 0.2 * Math.sin(Date.now() * 0.012);
        ctx.fillStyle = `rgba(255,${Math.round(pulse * 255)},13,1)`;
      } else {
        // Color gradient fill along the bar
        const grad = ctx.createLinearGradient(x + 2, y, x + 2 + fillW, y);
        if (heat <= 0.4) {
          grad.addColorStop(0, '#22DD44');
          grad.addColorStop(1, '#CCE820');
        } else if (heat <= 0.75) {
          grad.addColorStop(0, '#22DD44');
          grad.addColorStop(0.4 / heat, '#CCE820');
          grad.addColorStop(1, '#FF8800');
        } else {
          grad.addColorStop(0, '#22DD44');
          grad.addColorStop(0.4 / heat, '#CCE820');
          grad.addColorStop(0.75 / heat, '#FF8800');
          grad.addColorStop(1, '#FF1100');
        }
        ctx.fillStyle = grad;
      }

      // Glow at heat > 0.8
      if (heat > 0.8) {
        ctx.shadowColor = '#FF4400';
        ctx.shadowBlur = 12;
      }
      _roundRect(ctx, x + 2, y + 2, fillW, h - 4, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Tick marks at 25/50/75/100%
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    for (let t = 1; t <= 4; t++) {
      const tx = x + (t / 4) * (w - 4) + 2;
      ctx.beginPath();
      ctx.moveTo(tx, y + 2);
      ctx.lineTo(tx, y + h - 2);
      ctx.stroke();
    }

    // OVERHEATED warning text — blink 0.3s on/off
    if (overheated) {
      const blink = Math.floor(Date.now() / 300) % 2 === 0;
      if (blink) {
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF3311';
        ctx.fillText('OVERHEATED', x + w / 2, y + h / 2);
      }
    }

    ctx.restore();
  }

  /**
   * Draw the energy bar for the Laser Launcher.
   * Drains from full (left) when firing, recharges when idle.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} energy — 0..1
   * @param {string} laserState — 'idle' | 'warming' | 'firing'
   */
  _drawEnergyBar(ctx, energy, laserState) {
    const x = ENERGY_BAR_X;
    const y = ENERGY_BAR_BOTTOM - ENERGY_BAR_H;
    const w = ENERGY_BAR_W;
    const h = 28;

    ctx.save();

    // Label
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = rgba(0.6, 0.5, 0.85, 0.9);
    ctx.fillText('ENERGY', x, y - 4);

    // Track — dark background, rounded r=5
    ctx.fillStyle = 'rgba(6,4,14,0.85)';
    _roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,100,0.6)';
    ctx.lineWidth = 1.5;
    _roundRect(ctx, x, y, w, h, 5);
    ctx.stroke();

    // Fill — violet-to-cyan gradient, drains when firing
    const fillW = clamp(energy, 0, 1) * (w - 4);
    if (fillW > 0) {
      if (laserState === 'firing' && energy < 0.2) {
        // Pulsing red when nearly depleted
        const pulse = 0.1 + 0.2 * Math.sin(Date.now() * 0.012);
        ctx.fillStyle = `rgba(220,${Math.round(pulse * 80)},255,1)`;
      } else {
        const grad = ctx.createLinearGradient(x + 2, y, x + 2 + fillW, y);
        if (laserState === 'firing') {
          // Draining: bright cyan → violet
          grad.addColorStop(0, '#00EEFF');
          grad.addColorStop(0.5, '#6644FF');
          grad.addColorStop(1, '#CC44FF');
        } else {
          // Idle/warming: violet → cyan (recharging feel)
          grad.addColorStop(0, '#CC44FF');
          grad.addColorStop(0.5, '#8844FF');
          grad.addColorStop(1, '#44AAFF');
        }
        ctx.fillStyle = grad;
      }

      // Glow when firing
      if (laserState === 'firing') {
        ctx.shadowColor = '#8844FF';
        ctx.shadowBlur = 10;
      }
      _roundRect(ctx, x + 2, y + 2, fillW, h - 4, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Warm-up progress indicator (pulse on the label)
    if (laserState === 'warming') {
      const blink = Math.floor(Date.now() / 200) % 2 === 0;
      if (blink) {
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#00CCFF';
        ctx.fillText('CHARGING', x + w / 2, y + h / 2);
      }
    }

    // Tick marks at 25/50/75/100%
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    for (let t = 1; t <= 4; t++) {
      const tx = x + (t / 4) * (w - 4) + 2;
      ctx.beginPath();
      ctx.moveTo(tx, y + 2);
      ctx.lineTo(tx, y + h - 2);
      ctx.stroke();
    }

    // LOW ENERGY warning text — blink when near empty
    if (energy < 0.15 && laserState !== 'idle') {
      const blink = Math.floor(Date.now() / 300) % 2 === 0;
      if (blink) {
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF44CC';
        ctx.fillText('LOW ENERGY', x + w / 2, y + h / 2);
      }
    }

    ctx.restore();
  }

  /**
   * Nuke incoming warning banner at top-center of screen.
   * Blinks and fades out over NUKE_WARNING_DURATION seconds.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} dt — delta time in seconds
   */
  _drawNukeWarning(ctx, dt) {
    if (!this._nukeWarningActive) return;

    this._nukeWarningTimer -= dt;
    if (this._nukeWarningTimer <= 0) {
      this._nukeWarningActive = false;
      return;
    }

    // Spec 12: Smooth alpha pulse (replaces hard blink)
    // Base alpha: fade out in last 1.0s
    const fadeStart = 1.0;
    let baseAlpha = 1.0;
    if (this._nukeWarningTimer < fadeStart) {
      baseAlpha = this._nukeWarningTimer / fadeStart;
    }
    // Smooth sine pulse at ~2 Hz — never goes to zero (stays 50–100% of base)
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.013);
    const alpha = baseAlpha * (0.55 + 0.45 * pulse);

    const barW = 1100;
    const barH = 80;
    const barX = (LOGICAL_W - barW) / 2;
    const barY = 215;

    // Spec 12: Red screen-edge vignette during warning
    ctx.save();
    ctx.globalAlpha = baseAlpha * (0.18 + 0.14 * pulse);
    const vigW = LOGICAL_W;
    const vigH = LOGICAL_H;
    const vigSize = 220;
    // Top edge
    const vigTop = ctx.createLinearGradient(0, 0, 0, vigSize);
    vigTop.addColorStop(0, 'rgba(200,0,0,1)');
    vigTop.addColorStop(1, 'rgba(200,0,0,0)');
    ctx.fillStyle = vigTop;
    ctx.fillRect(0, 0, vigW, vigSize);
    // Bottom edge
    const vigBottom = ctx.createLinearGradient(0, vigH - vigSize, 0, vigH);
    vigBottom.addColorStop(0, 'rgba(200,0,0,0)');
    vigBottom.addColorStop(1, 'rgba(200,0,0,1)');
    ctx.fillStyle = vigBottom;
    ctx.fillRect(0, vigH - vigSize, vigW, vigSize);
    // Left edge
    const vigLeft = ctx.createLinearGradient(0, 0, vigSize, 0);
    vigLeft.addColorStop(0, 'rgba(200,0,0,1)');
    vigLeft.addColorStop(1, 'rgba(200,0,0,0)');
    ctx.fillStyle = vigLeft;
    ctx.fillRect(0, 0, vigSize, vigH);
    // Right edge
    const vigRight = ctx.createLinearGradient(vigW - vigSize, 0, vigW, 0);
    vigRight.addColorStop(0, 'rgba(200,0,0,0)');
    vigRight.addColorStop(1, 'rgba(200,0,0,1)');
    ctx.fillStyle = vigRight;
    ctx.fillRect(vigW - vigSize, 0, vigSize, vigH);
    ctx.restore();

    // Subtle 1% scale pulse
    const scalePulse = 1 + 0.01 * Math.sin(Date.now() * 0.01);

    ctx.save();
    ctx.globalAlpha = alpha;
    // Apply scale pulse from center of bar
    ctx.translate(LOGICAL_W / 2, barY + barH / 2);
    ctx.scale(scalePulse, scalePulse);
    ctx.translate(-(LOGICAL_W / 2), -(barY + barH / 2));

    // Shadow rect
    const padX = 12, padY = 8;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    _roundRect(ctx, barX - padX, barY - padY, barW + padX * 2, barH + padY * 2, 12);
    ctx.fill();

    // Gradient background — #C80000 to #8C0000
    const barGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    barGrad.addColorStop(0, 'rgba(200,0,0,0.90)');
    barGrad.addColorStop(0.5, 'rgba(180,0,0,0.95)');
    barGrad.addColorStop(1, 'rgba(140,0,0,0.90)');
    ctx.fillStyle = barGrad;
    _roundRect(ctx, barX, barY, barW, barH, 8);
    ctx.fill();

    // Border with glow — wrapped in save/restore per spec rules
    ctx.save();
    ctx.shadowColor = '#FF0000';
    ctx.shadowBlur = 20;
    ctx.strokeStyle = 'rgba(255,60,60,0.9)';
    ctx.lineWidth = 2;
    _roundRect(ctx, barX, barY, barW, barH, 8);
    ctx.stroke();
    ctx.restore();

    // Pulsing alert icon circles (left and right)
    const iconPulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.012);
    const iconR = 18 + iconPulse * 4;
    const iconY = barY + barH / 2;
    ctx.fillStyle = `rgba(255,238,16,${(0.7 + 0.3 * iconPulse).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(barX + 48, iconY, iconR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(barX + barW - 48, iconY, iconR, 0, Math.PI * 2);
    ctx.fill();
    // Icon inner "!" symbol
    ctx.font = `bold ${Math.round(20 + iconPulse * 4)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(180,0,0,0.9)';
    ctx.fillText('!', barX + 48, iconY);
    ctx.fillText('!', barX + barW - 48, iconY);

    // Warning text — bold 48px #FFEE10 with glow blur 12 — wrapped in save/restore
    ctx.save();
    ctx.font = 'bold 48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#FF0000';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#FFEE10';
    ctx.fillText('!! NUKE INCOMING !!', LOGICAL_W / 2, barY + barH / 2);
    ctx.restore();

    ctx.restore();
  }

  /**
   * Default crosshair: drawn with 'difference' blend mode so it inverts whatever
   * is behind it — guaranteed visibility against bright sky, dark night, or terrain.
   * A tinted color tint is applied on top in normal blend for launcher identity.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} mx
   * @param {number} my
   * @param {object|null} sel — selected launcher (optional)
   */
  _drawDefaultCrosshair(ctx, mx, my, sel) {
    // Per-launcher-type accent color (used for center dot and subtle tint)
    let color;
    const type = sel && sel.type;
    if (type === 'sam') {
      color = '#00CCFF';
    } else if (type === 'truck') {
      color = '#FFB040';
    } else if (type === 'vulkan') {
      color = '#00FF88';
    } else if (type === 'laser') {
      color = '#CC44FF';
    } else {
      color = '#E0FF40';
    }

    const drawLines = () => {
      _hline(ctx, mx - CROSSHAIR_GAP - CROSSHAIR_LINE_LEN, my, mx - CROSSHAIR_GAP, my);
      _hline(ctx, mx + CROSSHAIR_GAP, my, mx + CROSSHAIR_GAP + CROSSHAIR_LINE_LEN, my);
      _vline(ctx, mx, my - CROSSHAIR_GAP - CROSSHAIR_LINE_LEN, mx, my - CROSSHAIR_GAP);
      _vline(ctx, mx, my + CROSSHAIR_GAP, mx, my + CROSSHAIR_GAP + CROSSHAIR_LINE_LEN);
      const d = 20, b = 12;
      _bracket(ctx, mx - d, my - d,  b,  b);
      _bracket(ctx, mx + d, my - d, -b,  b);
      _bracket(ctx, mx - d, my + d,  b, -b);
      _bracket(ctx, mx + d, my + d, -b, -b);
    };

    ctx.save();

    // ── Inversion pass: white lines in 'difference' mode invert the background ──
    // This makes the crosshair appear black on bright sky and white on dark sky,
    // guaranteeing visibility against any background at any time of day.
    ctx.globalCompositeOperation = 'difference';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5;
    drawLines();

    // ── Color tint pass: subtle colored overlay for launcher identity ──
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    drawLines();
    ctx.globalAlpha = 1;

    // Corner tip squares
    const d = 20, b = 12;
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#FFFFFF';
    const corners = [
      [mx - d + b, my - d], [mx + d - b, my - d],
      [mx - d + b, my + d], [mx + d - b, my + d],
      [mx - d, my - d + b], [mx + d, my - d + b],
      [mx - d, my + d - b], [mx + d, my + d - b],
    ];
    for (const [cx2, cy2] of corners) {
      ctx.fillRect(cx2 - 1, cy2 - 1, 3, 3);
    }

    // Center dot — inversion ring + colored fill
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Heat-seeker crosshair — Converging Chevrons design, scanning state.
   * 4 arms at cursor, rotating dashed outer scan circle, center dot.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} mx
   * @param {number} my
   */
  _drawHeatCrosshair(ctx, mx, my) {
    const color = '#FF5500';
    const armLen = 28;
    const armGap = 12;
    const scanR  = 80;

    ctx.save();

    // 4 arms — 'difference' blend inverts background for guaranteed visibility
    ctx.globalCompositeOperation = 'difference';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5;
    _hline(ctx, mx - armGap - armLen, my, mx - armGap, my);
    _hline(ctx, mx + armGap, my, mx + armGap + armLen, my);
    _vline(ctx, mx, my - armGap - armLen, mx, my - armGap);
    _vline(ctx, mx, my + armGap, mx, my + armGap + armLen);
    // Color tint pass
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    _hline(ctx, mx - armGap - armLen, my, mx - armGap, my);
    _hline(ctx, mx + armGap, my, mx + armGap + armLen, my);
    _vline(ctx, mx, my - armGap - armLen, mx, my - armGap);
    _vline(ctx, mx, my + armGap, mx, my + armGap + armLen);
    ctx.globalAlpha = 1;

    // Outer scan circle — dashed, rotates at +0.5 rad/s
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(this._scanRotation);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(255,85,0,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, scanR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Center dot r=3, fill #FF5500, shadow #FF3300 blur 6
    ctx.save();
    ctx.shadowColor = '#FF3300';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(mx, my, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  /**
   * Locked-on crosshair: Converging Chevrons design.
   * - At target (tx, ty): glow halo, acquisition flash rings, rotating arc segments
   *   with chevrons, inner crosshair, "LOCKED" badge, spark particles.
   * - At cursor (mx, my): simple 4-arm crosshair + center dot + "FIRE" label.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} mx
   * @param {number} my
   * @param {object} target — enemy entity with x,y properties
   * @param {number} [shakeX=0] — camera shake X offset to keep ring on entity
   * @param {number} [shakeY=0] — camera shake Y offset to keep ring on entity
   */
  _drawLockedCrosshair(ctx, mx, my, target, shakeX = 0, shakeY = 0) {
    // Adjust target draw position by shake so the ring stays on the entity visually
    const tx = target.x + shakeX;
    const ty = target.y + shakeY;

    const lockTimer = this._lockTimer;

    // ── 1. Glow halo at target ─────────────────────────────────────────────
    ctx.save();
    const halo = ctx.createRadialGradient(tx, ty, 0, tx, ty, 52);
    halo.addColorStop(0,    'rgba(255,80,0,0)');
    halo.addColorStop(30/52,'rgba(255,80,0,0.08)');
    halo.addColorStop(1,    'rgba(255,80,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(tx, ty, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── 2. Acquisition flash rings (lockTimer < 0.5s) ─────────────────────
    if (lockTimer < 0.5) {
      // Ring 1: white, lw 4→2
      const t1 = lockTimer / 0.5;
      const r1 = 30 + 55 * easeOutCubic(t1);
      const a1 = 1 * (1 - t1);
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${a1.toFixed(3)})`;
      ctx.lineWidth = 4 - 2 * t1;
      ctx.beginPath();
      ctx.arc(tx, ty, r1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Ring 2: delay 0.05s, amber #FFBE28
      if (lockTimer > 0.05) {
        const t2 = (lockTimer - 0.05) / 0.45;
        const r2 = 30 + 45 * easeOutCubic(t2);
        const a2 = 0.7 * (1 - t2);
        ctx.save();
        ctx.strokeStyle = `rgba(255,190,40,${a2.toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(tx, ty, r2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Ring 3: delay 0.12s, orange #FF6400
      if (lockTimer > 0.12) {
        const t3 = (lockTimer - 0.12) / 0.38;
        const r3 = 30 + 35 * easeOutCubic(t3);
        const a3 = 0.5 * (1 - t3);
        ctx.save();
        ctx.strokeStyle = `rgba(255,100,0,${a3.toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(tx, ty, r3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── 3. Rotating arc segments with chevrons ─────────────────────────────
    // On acquisition (lockTimer < 0.3): radius eases from 80 → 40
    let lockR;
    if (lockTimer < 0.3) {
      lockR = 80 - 40 * easeOutCubic(lockTimer / 0.3);
    } else {
      // Steady r=40 with ±3px pulse at 8 rad/s
      lockR = 40 + 3 * Math.sin(this._lockPulseTimer * 8);
    }

    const isAcquisition = lockTimer < 0.3;
    const segSpan = (70 / 180) * Math.PI;
    const gap     = (Math.PI * 2 - 4 * segSpan) / 4;

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(this._lockRingRotation);

    // Shadow glow
    ctx.shadowColor = '#FF8800';
    ctx.shadowBlur  = 12;
    ctx.strokeStyle = isAcquisition ? '#FFFFFF' : '#FFAA00';
    ctx.lineWidth   = isAcquisition ? 4 : 3;

    for (let i = 0; i < 4; i++) {
      const startAngle = i * (segSpan + gap);

      // Arc segment
      ctx.beginPath();
      ctx.arc(0, 0, lockR, startAngle, startAngle + segSpan);
      ctx.stroke();

      // Chevron at arc midpoint, pointing outward
      const midAngle = startAngle + segSpan / 2;
      const cx2  = Math.cos(midAngle) * lockR;
      const cy2  = Math.sin(midAngle) * lockR;
      const outX = Math.cos(midAngle) * 10;
      const outY = Math.sin(midAngle) * 10;
      const perpX = -Math.sin(midAngle) * 5;
      const perpY =  Math.cos(midAngle) * 5;
      ctx.beginPath();
      ctx.moveTo(cx2 + perpX, cy2 + perpY);
      ctx.lineTo(cx2 + outX,  cy2 + outY);
      ctx.lineTo(cx2 - perpX, cy2 - perpY);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.restore();

    // ── 4. Inner crosshair at target (fixed, not rotating) ─────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(255,170,0,0.9)';
    ctx.lineWidth = 1.5;
    const icLen = 10;
    const icGap = 6;
    _hline(ctx, tx - icGap - icLen, ty, tx - icGap, ty);
    _hline(ctx, tx + icGap,         ty, tx + icGap + icLen, ty);
    _vline(ctx, tx, ty - icGap - icLen, tx, ty - icGap);
    _vline(ctx, tx, ty + icGap,         tx, ty + icGap + icLen);
    ctx.restore();

    // ── 5. "LOCKED" badge ──────────────────────────────────────────────────
    if (lockTimer > 0.1) {
      const badgeAlpha = Math.min(lockTimer / 0.2, 1);
      const badgeColor = lockTimer < 0.3 ? '#FFFFFF' : '#FFAA00';
      const badgeX = tx - 42;
      const badgeY = ty - 70 - 15; // center of pill at ty-70
      ctx.save();
      ctx.globalAlpha = badgeAlpha;
      // Dark pill background
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      _roundRect(ctx, badgeX, badgeY, 84, 30, 6);
      ctx.fill();
      // Badge text
      ctx.font = 'bold 22px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = badgeColor;
      ctx.fillText('LOCKED', tx, ty - 70);
      ctx.restore();
    }

    // ── 6. Spark particles — origin at (tx, ty) ───────────────────────────
    ctx.save();
    for (const p of this._lockParticles) {
      // Set origin to target position on first draw
      if (p.ox === 0 && p.oy === 0) {
        p.ox = tx;
        p.oy = ty;
      }
      const lifeRatio = p.life / p.maxLife; // 1→0
      const alpha = Math.max(0, lifeRatio);
      const r = p.radius * lifeRatio;
      if (r < 0.5) continue;
      // White→yellow→orange color by lifetime
      const particleR = 255;
      const particleG = Math.round((0.9 - 0.5 * (1 - lifeRatio)) * 255);
      const particleB = Math.round(lifeRatio > 0.6 ? 255 * (lifeRatio - 0.6) / 0.4 : 0);
      ctx.fillStyle = `rgba(${particleR},${particleG},${particleB},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.ox + p.x, p.oy + p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ── 7. Cursor crosshair at (mx, my) — no scan circles ─────────────────
    ctx.save();
    ctx.strokeStyle = '#FFAA00';
    ctx.lineWidth = 2;
    const cArmLen = 28;
    const cArmGap = 12;
    _hline(ctx, mx - cArmGap - cArmLen, my, mx - cArmGap, my);
    _hline(ctx, mx + cArmGap,           my, mx + cArmGap + cArmLen, my);
    _vline(ctx, mx, my - cArmGap - cArmLen, mx, my - cArmGap);
    _vline(ctx, mx, my + cArmGap,           mx, my + cArmGap + cArmLen);
    ctx.restore();

    // Center dot at cursor
    ctx.save();
    ctx.shadowColor = '#FF8800';
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = '#FFAA00';
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // "FIRE" label below cursor, visible after lockTimer > 0.35s
    if (lockTimer > 0.35) {
      ctx.save();
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,170,0,0.7)';
      ctx.fillText('FIRE', mx, my + 28);
      ctx.restore();
    }
  }

  /**
   * Shield HUD card — bottom-right corner.
   * Shows [S] key badge, SHIELD label, 3 charge dots, and status bar.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} game — Game instance
   */
  _drawShieldCard(ctx, game) {
    const cardX = 2290;
    const cardY = 1300;
    const cardW = 240;
    const cardH = 110;

    const charges = game.shieldCharges != null ? game.shieldCharges : 2;
    const cooldown = game.shieldCooldown != null ? game.shieldCooldown : 0;
    const activeShield = game.activeShield;
    const isActive = activeShield && activeShield.alive;

    // Determine status
    let status; // 'READY' | 'ACTIVE' | 'COOLDOWN' | 'DEPLETED'
    if (isActive) {
      status = 'ACTIVE';
    } else if (cooldown > 0) {
      status = 'COOLDOWN';
    } else if (charges <= 0) {
      status = 'DEPLETED';
    } else {
      status = 'READY';
    }

    ctx.save();

    // Card background
    const bg = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
    bg.addColorStop(0, 'rgba(0,16,36,0.92)');
    bg.addColorStop(1, 'rgba(0,8,20,0.92)');
    ctx.fillStyle = bg;
    _roundRect(ctx, cardX, cardY, cardW, cardH, 8);
    ctx.fill();

    // Border color by status
    const borderColors = {
      READY:    'rgba(0,180,255,0.60)',
      ACTIVE:   'rgba(0,255,191,0.85)',
      COOLDOWN: 'rgba(0,80,140,0.55)',
      DEPLETED: 'rgba(80,30,30,0.55)',
    };
    ctx.save();
    if (isActive) {
      ctx.shadowColor = '#00BFFF';
      ctx.shadowBlur = 14;
    }
    ctx.strokeStyle = borderColors[status];
    ctx.lineWidth = 1.5;
    _roundRect(ctx, cardX, cardY, cardW, cardH, 8);
    ctx.stroke();
    ctx.restore();

    // [S] key badge — top-left
    const badgeX = cardX + 8, badgeY = cardY + 8, badgeW = 32, badgeH = 22;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    _roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 5);
    ctx.fill();
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = status === 'READY' || isActive ? '#80DFFF' : '#335577';
    ctx.fillText('[S]', badgeX + badgeW / 2, badgeY + badgeH / 2);

    // "SHIELD" label
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isActive ? '#80DFFF' : status === 'READY' ? '#C0E8FF' : '#557799';
    ctx.fillText('SHIELD', cardX + 48, cardY + cardH / 2 - 14);


    // Status bar — bottom of card
    const barX = cardX + 8;
    const barY = cardY + cardH - 22;
    const barW = cardW - 16;
    const barH = 12;

    // Bar track
    ctx.fillStyle = 'rgba(0,10,20,0.85)';
    _roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,60,100,0.4)';
    ctx.lineWidth = 1;
    _roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.stroke();

    // Bar fill
    let fillFrac = 0;
    let fillColor;
    if (isActive) {
      // Drain: from full to empty over shield duration
      const shield = activeShield;
      const totalPhaseTime = 0.3 + 4.4 + 0.3; // 5s
      const elapsed = shield._elapsed || 0;
      fillFrac = Math.max(0, 1 - elapsed / totalPhaseTime);
      fillColor = `rgba(0,191,255,0.9)`;
    } else if (cooldown > 0) {
      fillFrac = 1 - cooldown / 15;
      fillColor = `rgba(0,100,160,0.7)`;
    } else if (charges > 0) {
      fillFrac = 1;
      fillColor = `rgba(0,191,255,0.9)`;
    } else {
      fillFrac = 0;
      fillColor = `rgba(60,0,0,0.5)`;
    }

    if (fillFrac > 0) {
      const fillW = fillFrac * (barW - 4);
      if (isActive) {
        ctx.save();
        ctx.shadowColor = '#00BFFF';
        ctx.shadowBlur = 6;
      }
      ctx.fillStyle = fillColor;
      _roundRect(ctx, barX + 2, barY + 2, fillW, barH - 4, 3);
      ctx.fill();
      if (isActive) ctx.restore();
    }

    // Status text label next to bar
    const statusLabels = {
      READY:    { text: 'READY',    color: '#00BFFF' },
      ACTIVE:   { text: 'ACTIVE',   color: '#00FFB0' },
      COOLDOWN: { text: 'COOLDOWN', color: '#336688' },
      DEPLETED: { text: 'DEPLETED', color: '#883333' },
    };
    const { text: statusText, color: statusColor } = statusLabels[status];

    // DEPLETED blinks
    let showLabel = true;
    if (status === 'DEPLETED') {
      showLabel = Math.floor(Date.now() / 500) % 2 === 0;
    }

    if (showLabel) {
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = statusColor;
      ctx.fillText(statusText, cardX + cardW - 8, cardY + cardH / 2 + 12);
    }

    ctx.restore();
  }

  /**
   * Game Over overlay — dim background, GAME OVER text, score.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} score
   */
  _drawGameOverOverlay(ctx, score) {
    ctx.save();

    // Radial gradient overlay — darker center, lighter edges
    const cx = LOGICAL_W / 2, cy = LOGICAL_H / 2;
    const radGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(LOGICAL_W, LOGICAL_H) * 0.7);
    radGrad.addColorStop(0, 'rgba(0,0,0,0.72)');
    radGrad.addColorStop(0.5, 'rgba(0,0,0,0.55)');
    radGrad.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = radGrad;
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textY = LOGICAL_H / 2 - 80;

    // "GAME OVER" — triple-pass (glow blur 60, main, crack highlight)
    ctx.font = 'bold 144px monospace';

    // Pass 1: glow blur 60
    ctx.shadowColor = '#FF1A10';
    ctx.shadowBlur = 60;
    ctx.fillStyle = 'rgba(255,26,16,0.6)';
    ctx.fillText('GAME OVER', cx, textY);

    // Pass 2: main solid text
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#FF1A10';
    ctx.fillText('GAME OVER', cx, textY);
    ctx.shadowBlur = 0;

    // Pass 3: crack highlight at offset (2,-2) semi-transparent white
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('GAME OVER', cx + 2, textY - 2);
    ctx.globalAlpha = 1;

    // "FINAL SCORE" label — 28px #AAAAAA above score
    ctx.font = '28px monospace';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText('FINAL SCORE', cx, LOGICAL_H / 2 + 20);

    // Score value — 64px #FFD700
    ctx.font = 'bold 64px monospace';
    ctx.fillStyle = '#FFD700';
    ctx.fillText(String(score), cx, LOGICAL_H / 2 + 90);

    // Play again hint
    const blinkA = 0.5 + 0.5 * Math.sin(Date.now() * 0.002);
    ctx.font = '34px monospace';
    ctx.fillStyle = `rgba(180,192,204,${blinkA.toFixed(2)})`;
    ctx.fillText('Click to play again', cx, LOGICAL_H / 2 + 185);

    ctx.restore();
  }
}

// ── Module-private math helpers ───────────────────────────────────────────

/**
 * Cubic ease-out: fast start, decelerates to stop. t clamped to [0,1].
 * @param {number} t
 * @returns {number}
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);
}

// ── Module-private canvas helpers ─────────────────────────────────────────

/**
 * Draw a horizontal line segment.
 * @param {CanvasRenderingContext2D} ctx
 */
function _hline(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Draw a vertical line segment (alias for _hline — both are just line segments).
 * @param {CanvasRenderingContext2D} ctx
 */
function _vline(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Draw an L-shaped corner bracket at (cx, cy).
 * dx/dy are the signed lengths along each axis.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx
 * @param {number} cy
 * @param {number} dx — horizontal arm direction (+right / -left)
 * @param {number} dy — vertical arm direction (+down / -up)
 */
function _bracket(ctx, cx, cy, dx, dy) {
  ctx.beginPath();
  ctx.moveTo(cx + dx, cy);  // horizontal end
  ctx.lineTo(cx, cy);        // corner
  ctx.lineTo(cx, cy + dy);  // vertical end
  ctx.stroke();
}

/**
 * Trace a rounded rectangle path. Does NOT stroke/fill — caller does that.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r — corner radius
 */
function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
