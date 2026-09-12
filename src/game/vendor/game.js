import { startLoop } from './engine/loop.js';
import { Renderer } from './engine/renderer.js';
import { Input } from './engine/input.js';
import { Audio } from './engine/audio.js';
import { EntityManager } from './entities/entity-manager.js';
import { CollisionSystem } from './collision.js';
import { WaveSystem } from './wave.js';
import { UI } from './ui.js';
import { Terrain } from './terrain.js';
import { SAMLauncher } from './entities/sam-launcher.js';
import { HeatSeekerLauncher } from './entities/heat-seeking-launcher.js';
import { TruckLauncher } from './entities/truck-launcher.js';
import { VulkanCannon } from './entities/vulkan-cannon.js';
import { LaserLauncher } from './entities/laser-launcher.js';
import { BikeLauncher } from './entities/bike-launcher.js';
import { DronePad } from './entities/drone-pad.js';
import { HunterDrone } from './entities/hunter-drone.js';
import { Missile } from './entities/missile.js';
import { HeatSeekingMissile } from './entities/heat-seeking-missile.js';
import { VulkanBullet } from './entities/vulkan-bullet.js';
import { EnemyMissile } from './entities/enemy-missile.js';
import { SuperMissile } from './entities/super-missile.js';
import { ShockMissile } from './entities/shock-missile.js';
import { ShockWave } from './entities/shock-wave.js';
import { Drone } from './entities/drone.js';
import { SuicideDrone } from './entities/suicide-drone.js';
import { Nuke } from './entities/nuke.js';
import { TransportPlane } from './entities/transport-plane.js';
import { Paratrooper } from './entities/paratrooper.js';
import { AttackQuad } from './entities/attack-quad.js';
import { KamikazeQuad } from './entities/kamikaze-quad.js';
import { Explosion } from './explosion.js';
import { Crater } from './crater.js';
import { DayNightCycle } from './day-night.js';
import { BiomeSystem } from './biome.js';
import { MegaShield } from './entities/mega-shield.js';
import { rgba, lerp, randf, dist } from './utils.js';
import { UpgradeState } from './upgrades/upgrade-state.js';

// Launcher spawn positions (from main.gd / SCENE_DATA)
const LAUNCHER_POSITIONS = [
  { x: 400,  y: 1220, Class: SAMLauncher },
  { x: 900,  y: 1220, Class: HeatSeekerLauncher },
  { x: 1400, y: 1220, Class: TruckLauncher },
  { x: 1900, y: 1220, Class: VulkanCannon },
  { x: 2200, y: 1220, Class: DronePad },
  { x: 2450, y: 1220, Class: LaserLauncher },
  { x: 1200, y: 1220, Class: BikeLauncher },
];

const CROSSHAIR_RADIUS = 90;

/**
 * Game — top-level controller. Creates engine systems, runs the game loop,
 * manages state transitions. Translates main.gd.
 */
export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas, this.renderer);
    this.audio = new Audio();
    this.entities = new EntityManager();
    this.collision = new CollisionSystem();
    this.waves = new WaveSystem();
    this.ui = new UI(this.renderer);

    /** @type {'start' | 'playing' | 'gameover'} */
    this.state = 'start';
    this.score = 0;
    this.waveNumber = 0;

    // Economy — reset to 0 in start()
    this.cash = 0;
    this.waveScore = 0;

    // Upgrade state — recreated fresh in start()
    this.upgradeState = new UpgradeState();

    /** @type {import('./entities/launcher.js').Launcher|null} */
    this.selectedLauncher = null;

    /** @type {import('./entities/launcher.js').Launcher[]} */
    this.launchers = [];

    /** @type {import('./terrain.js').Terrain|null} */
    this.terrain = null;

    /** @type {DayNightCycle} */
    this.dayNight = new DayNightCycle();

    /** @type {BiomeSystem} */
    this.biomeSystem = new BiomeSystem();

    /** @type {import('./entities/entity.js').Entity|null} */
    this.lockedTarget = null;
    this._targetAcquiredCooldown = 0;

    // Screen shake
    this.shakeIntensity = 0;
    this.shakeDecay = 5.0;

    // Vulkan spool state
    this._vulkanSpoolLoop = null;
    this._vulkanWasFiring = false;

    // Laser state
    this._laserFiringLoop = null;
    this._laserMouseWasDown = false;

    // Mega Shield state
    this.shieldCharges = 99;
    this.shieldCooldown = 0;
    /** @type {MegaShield|null} */
    this.activeShield = null;

    // Delta time for UI banner rendering
    this._lastDt = 1 / 60;

    // Radio chatter timer
    this._chatterTimer = 0;
    this._chatterInterval = 0;

    // Hide OS cursor
    canvas.style.cursor = 'none';

    // Preload cover image for start screen
    this._coverImage = new Image();
    this._coverImage.src = 'assets/coverfinal.png';

    // Wire wave system callbacks
    this.waves.onWaveStart = (wave) => {
      this.waveNumber = wave;
      this.ui.showWaveBanner(`WAVE ${wave}`, rgba(1, 0.85, 0.1));
      // Stop terrain recovery once the new wave begins — craters should stick
      // during active combat.
      if (this.terrain) this.terrain.recovering = false;
      // Stop launcher HP recovery — enemies are spawning now
      for (const launcher of this.launchers) {
        launcher._recovering = false;
      }
      // Advance day/night cycle to target tod for this wave
      this.dayNight.setWave(wave);
      // Stormy biome: ensure DayNight does NOT draw its own 200 rain drops,
      // because biome.drawFrontOfTerrain() already draws 400 heavy rain
      // streaks. Both firing every frame would produce 600 rain particles —
      // a visible duplication with mismatched speeds/angles.
      if (this.biomeSystem._def && this.biomeSystem._def.id === 'stormy') {
        this.dayNight._weatherType = 'none';
      }
    };
    this.waves.onWaveComplete = (wave) => {
      this.ui.showWaveBanner(`WAVE ${wave} CLEAR`, rgba(0.2, 0.9, 0.3));
      // Begin gradual terrain healing during the inter-wave break.
      if (this.terrain) this.terrain.recovering = true;
      // Begin HP recovery for all damaged (but alive) launchers
      for (const launcher of this.launchers) {
        if (launcher.alive) {
          launcher._recovering = true;
        }
      }
      // Every 5 waves grant +1 shield charge
      if (wave % 5 === 0) {
        this.shieldCharges++;
      }
      // Convert wave score to cash: base + 25% bonus
      const earned = this.waveScore + Math.floor(this.waveScore * 0.25);
      this.cash += earned;
      this.waveScore = 0;
    };

    // Start the loop
    this._loopHandle = startLoop(
      (dt) => this.update(dt),
      () => this.render()
    );

  }

  // ── State transitions ──────────────────────────────────────

  start() {
    this.state = 'playing';
    this.score = 0;
    this.waveNumber = 0;
    this.cash = 0;
    this.waveScore = 0;
    this.entities.clear();
    this.launchers = [];
    this.selectedLauncher = null;
    this.lockedTarget = null;
    this._vulkanSpoolLoop = null;
    this._vulkanWasFiring = false;
    this._laserFiringLoop = null;
    this._laserMouseWasDown = false;

    // Create a fresh upgrade state for this game session
    this.upgradeState = new UpgradeState();

    // Reset shield
    this.shieldCharges = 99;
    this.shieldCooldown = 0;
    this.activeShield = null;

    // Pick biome for this game and wrap the day-night cycle
    this.biomeSystem.pickRandom();
    this.dayNight = new DayNightCycle();
    this.dayNight = this.biomeSystem.wrapDayNight(this.dayNight);

    // Create terrain — pass biomeSystem so it can scale heights and apply filter
    this.terrain = new Terrain(1240, this.renderer, this.biomeSystem);
    this.entities.add(this.terrain);

    // Spawn launchers
    for (const def of LAUNCHER_POSITIONS) {
      const launcher = new def.Class(def.x, def.y);
      this.entities.add(launcher);
      this.launchers.push(launcher);
      // Apply any purchased upgrade effects (no-op if upgradeState is empty at game start)
      this.upgradeState.applyToWeapon(launcher, null);
    }

    // Inject terrain + sibling references into the truck launcher so it can move
    const truckLauncher = this.launchers.find(l => l.type === 'truck');
    if (truckLauncher) {
      truckLauncher.terrain = this.terrain;
      truckLauncher._otherLaunchers = this.launchers;
    }

    // Inject terrain into the bike launcher
    const bikeLauncher = this.launchers.find(l => l.type === 'bike');
    if (bikeLauncher) {
      bikeLauncher.terrain = this.terrain;
      bikeLauncher._otherLaunchers = this.launchers;
    }

    // Wire vulkan fire callback
    const vulkan = this.launchers[3];
    if (vulkan && vulkan.type === 'vulkan') {
      vulkan.onFireBullet = (cannon) => this._onVulkanFire(cannon);
    }

    // Wire laser launcher
    const laser = this.launchers.find(l => l.type === 'laser');
    if (laser) {
      // Enemy access for beam collision
      laser.getEnemies = () => this.entities.getGroup('enemy_missiles');
      // Game ref for scoring
      laser.game = this;
      // Audio callbacks
      laser.onStartWarmUp = () => this.audio.playLaserWarmUp(laser.x);
      laser.onCancelWarmUp = () => {};
      laser.onStartFiring  = () => {
        this._laserFiringLoop = this.audio.startLaserFiringLoop(laser.x);
      };
      laser.onStopFiring   = () => {
        if (this._laserFiringLoop) {
          this.audio.stopLoop(this._laserFiringLoop);
          this._laserFiringLoop = null;
        }
      };
      laser.onBeamHit      = (x, y) => this.audio.playLaserHit(x);
      // Kill callback — handle scoring and explosion
      laser.onEnemyKilled  = (enemy, typeName) => {
        // Map constructor name to score type key used by onEnemyDestroyed
        const typeMap = {
          Nuke: 'nuke',
          TransportPlane: 'transport_plane',
          Paratrooper: 'paratrooper',
          AttackQuad: 'attack_quad',
          KamikazeQuad: 'kamikaze_quad',
        };
        this.onEnemyDestroyed(typeMap[typeName] || 'normal');
        this.shakeScreen(8);
      };
      laser.onSpawnExplosion = (x, y, isMega) => {
        this.entities.add(new Explosion(x, y, isMega));
        this.audio.playExplosion(x, isMega);
        if (this.terrain) this.terrain.damage(x, y, isMega ? 100 : 50, isMega ? 30 : 18);
        const craterY = this.terrain ? this.terrain.getHeightAt(x) : y;
        this.entities.add(new Crater(x, craterY, isMega ? 2 : 1));
        this.shakeScreen(isMega ? 20 : 8);
      };
    }

    // Select SAM by default
    this._selectLauncher(0);

    // Start wave system
    this.waves.start();

    this._resetChatterTimer();
    this._chatterInterval = randf(3, 5); // first chatter comes early
  }

  // ── Per-frame ──────────────────────────────────────────────

  /** @param {number} dt */
  update(dt) {
    this.input.update();
    this._lastDt = dt;

    // Screen shake decay (always active)
    if (this.shakeIntensity > 0.01) {
      this.shakeIntensity = lerp(this.shakeIntensity, 0, this.shakeDecay * dt);
      this.renderer.cameraOffsetX = (Math.random() - 0.5) * 2 * this.shakeIntensity;
      this.renderer.cameraOffsetY = (Math.random() - 0.5) * 2 * this.shakeIntensity;
    } else {
      this.shakeIntensity = 0;
      this.renderer.cameraOffsetX = 0;
      this.renderer.cameraOffsetY = 0;
    }

    if (this.state === 'start') {
      if (this.input.mouseJustPressed) {
        this.audio.init();
        this.start();
      }
    } else if (this.state === 'playing') {
      this._updatePlaying(dt);
    } else if (this.state === 'gameover') {
      this.entities.update(dt);
      if (this.input.mouseJustPressed) {
        this.start();
      }
    }
  }

  /** @param {number} dt */
  _updatePlaying(dt) {
    // Update biome particles / effects
    this.biomeSystem.update(dt, this.audio);

    // Update day/night cycle
    const waveDuration = this.waves._waveDuration || 20;
    const waveProgress = waveDuration > 0 ? Math.min(this.waves.waveTimer / waveDuration, 1) : 0;
    this.dayNight.update(dt, waveProgress);

    // Propagate day/night colors to terrain when tod changes significantly
    if (this.terrain && this.dayNight.consumeTerrainDirty()) {
      this.terrain.setDayNight(this.dayNight);
    }

    // Feed mouse position to all launchers
    for (const launcher of this.launchers) {
      if (launcher.alive) {
        launcher.mouseX = this.input.mouseX;
        launcher.mouseY = this.input.mouseY;
      }
    }

    // Update entities
    this.entities.update(dt);

    // Collision
    this.collision.update(this.entities, this.terrain, this);

    // Wave system — pass a getter so count is checked AFTER spawns.
    // Include shock_waves in the count so a wave cannot complete while a
    // ShockWave is still propagating and dealing damage.
    this.waves.update(dt, (type) => this._spawnEnemy(type),
      () => this.entities.getGroup('enemy_missiles').length +
            this.entities.getGroup('shock_waves').length);
    this.waveNumber = this.waves.getCurrentWave();

    // Keyboard launcher selection (1-7)
    for (let i = 0; i < this.launchers.length; i++) {
      if (this.input.wasKeyPressed(String(i + 1))) {
        this._selectLauncher(i);
      }
    }

    // Mega Shield — S key
    if (this.input.wasKeyPressed('s') || this.input.wasKeyPressed('S')) {
      this._activateShield();
    }

    // Shield: tick cooldown, clean up expired shield
    if (this.shieldCooldown > 0) {
      this.shieldCooldown = Math.max(0, this.shieldCooldown - dt);
    }
    if (this.activeShield && !this.activeShield.alive) {
      this.activeShield = null;
      // Start cooldown after shield expires
      this.shieldCooldown = 15;
    }

    // Truck / Bike movement via arrow keys (only when the mobile launcher is selected)
    const selMobile = this.selectedLauncher;
    if (selMobile && (selMobile.type === 'truck' || selMobile.type === 'bike') && selMobile.alive) {
      if (this.input.arrowLeft) {
        selMobile.moveDirection(-1);
      } else if (this.input.arrowRight) {
        selMobile.moveDirection(1);
      } else {
        selMobile.moveDirection(0);
      }
    }

    // Validate selected launcher
    if (this.selectedLauncher && !this.selectedLauncher.alive) {
      this._autoSelectLauncher();
    }

    // Target-acquired cooldown
    if (this._targetAcquiredCooldown > 0) this._targetAcquiredCooldown -= dt;

    // Heat-seeker lock target
    this._updateLockedTarget();

    // Fire input
    this._handleFireInput();

    // Game over check
    this._checkGameOver();

    // Radio chatter
    this._chatterTimer += dt;
    if (this._chatterTimer >= this._chatterInterval) {
      if (this.audio.playRadioChatter()) {
        this._resetChatterTimer();
      } else {
        this._chatterTimer = this._chatterInterval - 1.0;
      }
    }
  }

  // ── Rendering ──────────────────────────────────────────────

  render() {
    const r = this.renderer;
    const ctx = r.ctx;

    r.beginFrame();

    if (this.state === 'playing' || this.state === 'gameover') {
      // Dynamic sky gradient from day/night cycle
      const sky = this.dayNight.getSkyColors();
      const skyGrad = ctx.createLinearGradient(0, 0, 0, Renderer.LOGICAL_H);
      skyGrad.addColorStop(0,   rgba(...sky.top));
      skyGrad.addColorStop(0.5, rgba(...sky.mid));
      skyGrad.addColorStop(1,   rgba(...sky.bottom));
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, Renderer.LOGICAL_W, Renderer.LOGICAL_H);
    } else {
      // Start screen: flat dark fill (overwritten below by start-screen gradient)
      ctx.fillStyle = rgba(0.05, 0.05, 0.12);
      ctx.fillRect(0, 0, Renderer.LOGICAL_W, Renderer.LOGICAL_H);
    }

    if (this.state === 'start') {
      r.beginUI();

      // Background: vertical gradient #020408 → #060A18 → #040608
      const skyGrad = ctx.createLinearGradient(0, 0, 0, Renderer.LOGICAL_H);
      skyGrad.addColorStop(0,   '#020408');
      skyGrad.addColorStop(0.5, '#060A18');
      skyGrad.addColorStop(1,   '#040608');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, Renderer.LOGICAL_W, Renderer.LOGICAL_H);

      // Subtle scanline overlay
      ctx.save();
      for (let sy = 0; sy < Renderer.LOGICAL_H; sy += 4) {
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.fillRect(0, sy, Renderer.LOGICAL_W, 2);
      }
      ctx.restore();

      // Cover image — full-width marquee, centered on screen
      const img = this._coverImage;
      if (img.complete && img.naturalWidth > 0) {
        const imgW = 2200;
        const imgH = Math.round(imgW * img.naturalHeight / img.naturalWidth);
        const imgX = (Renderer.LOGICAL_W - imgW) / 2;
        const imgY = (Renderer.LOGICAL_H - imgH) / 2;
        ctx.drawImage(img, imgX, imgY, imgW, imgH);
      }

      // Title: "MISSILE ATTACK" — glow pass then main text
      const titleCx = Renderer.LOGICAL_W / 2;
      const titleY = 1150;
      ctx.save();
      ctx.font = 'bold 112px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Glow pass — shadowBlur=40
      ctx.shadowColor = '#FF5522';
      ctx.shadowBlur = 40;
      ctx.fillStyle = 'rgba(255,85,34,0.55)';
      ctx.fillText('MISSILE ATTACK', titleCx, titleY);
      // Main pass
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#FF5522';
      ctx.fillText('MISSILE ATTACK', titleCx, titleY);
      ctx.shadowBlur = 0;
      // Highlight pass at (1,-1)
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('MISSILE ATTACK', titleCx + 1, titleY - 1);
      ctx.restore();

      // Pulsing "CLICK TO START"
      const ctaAlpha = 0.5 + 0.5 * Math.sin(Date.now() * 0.0025);
      const ctaY = 1300;
      ctx.save();
      ctx.font = '48px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(255,255,255,${ctaAlpha.toFixed(2)})`;
      ctx.fillText('CLICK TO START', titleCx, ctaY);
      ctx.restore();

      // Flanking horizontal lines around CTA
      ctx.save();
      ctx.strokeStyle = 'rgba(255,85,34,0.45)';
      ctx.lineWidth = 1.5;
      const lineY2 = ctaY;
      const lineCx = titleCx;
      const lineGap = 200; // gap from center to line start
      const lineLen2 = 260;
      ctx.beginPath();
      ctx.moveTo(lineCx - lineGap - lineLen2, lineY2);
      ctx.lineTo(lineCx - lineGap, lineY2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lineCx + lineGap, lineY2);
      ctx.lineTo(lineCx + lineGap + lineLen2, lineY2);
      ctx.stroke();
      ctx.restore();

    } else if (this.state === 'playing' || this.state === 'gameover') {
      // Atmospheric layers — drawn before game world entities (no shake applied yet)
      this.dayNight.drawStars(ctx);
      this.dayNight.drawCelestialBody(ctx);
      this.dayNight.drawClouds(ctx, this._lastDt);

      // Biome behind-terrain effects (e.g. riverside water band)
      this.biomeSystem.drawBehindTerrain(ctx, this.terrain);

      // Shield dome interior + hex grid (drawn BEHIND entities, before shake applied)
      if (this.activeShield && this.activeShield.alive) {
        this.activeShield.drawInterior(ctx);
      }

      // Game world (with shake) — terrain, entities
      this.entities.draw(ctx);

      // Laser beam — drawn AFTER entities so it appears on top of everything
      const laserLauncher = this.launchers.find(l => l.type === 'laser' && l.alive);
      if (laserLauncher) {
        laserLauncher.drawBeam(ctx);
      }

      // Shield edge glow (drawn AFTER entities so it wraps around the scene)
      if (this.activeShield && this.activeShield.alive) {
        this.activeShield.drawGlow(ctx);
      }

      // Biome front-of-terrain effects (snow, rain, shimmer, lightning, lens flare)
      // Drawn in UI space (no shake) so particles cover the full screen cleanly
      if (this.state === 'playing') {
        r.beginUI();
        this.biomeSystem.drawFrontOfTerrain(ctx);
      }

      // Weather overlay — drawn after entities, before UI (no shake for weather)
      if (this.state === 'playing') {
        r.beginUI();
        this.dayNight.drawWeather(ctx, this._lastDt);
      }

      // UI layer (no shake)
      r.beginUI();
      this.ui.drawHUD(ctx, this, this._lastDt);
      this.ui.drawWaveBanner(ctx, this._lastDt);
      this.ui.drawCrosshair(ctx, this);
    }

    r.endFrame();
  }

  // ── Launcher selection ─────────────────────────────────────

  /** @param {number} index */
  _selectLauncher(index) {
    if (index < 0 || index >= this.launchers.length) return;
    const launcher = this.launchers[index];
    if (!launcher.alive) return;

    // Deselect previous
    if (this.selectedLauncher) {
      this.selectedLauncher.setSelected(false);
      if (this.selectedLauncher.type === 'vulkan') {
        this.selectedLauncher.stopFiring();
        this._stopVulkanSpool();
      } else if (this.selectedLauncher.type === 'laser') {
        this.selectedLauncher.stopFiring();
        if (this._laserFiringLoop) {
          this.audio.stopLoop(this._laserFiringLoop);
          this._laserFiringLoop = null;
        }
      }
    }

    this.selectedLauncher = launcher;
    launcher.setSelected(true);
    this.lockedTarget = null;
  }

  _autoSelectLauncher() {
    if (this.selectedLauncher && this.selectedLauncher.type === 'vulkan') {
      this._stopVulkanSpool();
    }
    if (this.selectedLauncher && this.selectedLauncher.type === 'laser') {
      if (this._laserFiringLoop) {
        this.audio.stopLoop(this._laserFiringLoop);
        this._laserFiringLoop = null;
      }
      this._laserMouseWasDown = false;
    }
    this.selectedLauncher = null;
    this.lockedTarget = null;

    for (let i = 0; i < this.launchers.length; i++) {
      if (this.launchers[i].alive) {
        this._selectLauncher(i);
        return;
      }
    }
  }

  // ── Fire input ─────────────────────────────────────────────

  _handleFireInput() {
    const sel = this.selectedLauncher;
    if (!sel || !sel.alive) return;

    if (sel.type === 'vulkan') {
      if (this.input.mouseDown) {
        if (!this._vulkanWasFiring) {
          sel.startFiring();
          this._startVulkanSpool();
          this._vulkanWasFiring = true;
        }
      } else {
        if (this._vulkanWasFiring) {
          sel.stopFiring();
          this._stopVulkanSpool();
          this._vulkanWasFiring = false;
        }
      }
    } else if (sel.type === 'laser') {
      if (this.input.mouseDown) {
        if (!this._laserMouseWasDown) {
          sel.startWarmUp();
          this._laserMouseWasDown = true;
        }
      } else {
        if (this._laserMouseWasDown) {
          sel.stopFiring();
          this._laserMouseWasDown = false;
        }
      }
    } else if (sel.type === 'drone_pad') {
      if (this.input.mouseJustPressed) {
        this._deployHunterDrone(sel);
      }
    } else if (sel.type === 'bike') {
      if (this.input.mouseJustPressed && sel.canFire()) {
        this._fireMissile(sel);
        sel.onFired();
      }
    } else {
      if (this.input.mouseJustPressed) {
        this._fireMissile(sel);
      }
    }
  }

  _activateShield() {
    if (this.activeShield) return;       // already active
    if (this.shieldCooldown > 0) return; // on cooldown
    if (this.shieldCharges <= 0) return; // no charges left

    this.shieldCharges--;
    const shield = new MegaShield();

    // Wire warning beep callback
    shield.onWarningBeep = () => {
      this.audio.playShieldWarningBeeps();
    };

    this.entities.add(shield);
    this.activeShield = shield;
    this.audio.playShieldActivation();
  }

  _fireMissile(launcher) {
    const launchPos = launcher.getLaunchPosition();
    const targetX = this.input.mouseX;
    const targetY = this.input.mouseY;

    if (launcher.type === 'heatseeker') {
      const missile = new HeatSeekingMissile(launchPos.x, launchPos.y);
      missile.launchTo(targetX, targetY, this.lockedTarget);
      const motorLoop = this.audio.startMotorLoop(launchPos.x);
      if (motorLoop) missile.motorSound = motorLoop;
      this.entities.add(missile);
      this.audio.playLaunch(launchPos.x, 'heatseeker');
    } else {
      const missile = new Missile(launchPos.x, launchPos.y);
      // missileSpeed > 1 means faster: shorter travel time
      const launchTime = 1.5 / (launcher.missileSpeed || 1.0);
      missile.launchTo(targetX, targetY, launchTime);
      this.entities.add(missile);
      this.audio.playLaunch(launchPos.x, 'sam');
    }
  }

  _deployHunterDrone(pad) {
    if (!pad.canDeploy()) return;

    const drone = new HunterDrone(pad.x, pad.y);

    // Wire enemy access so the drone can scan for targets
    drone.getEnemies = () => this.entities.getGroup('enemy_missiles');

    // Notify pad when drone expires so active count is decremented
    drone.onExpire = () => pad.onDroneExpired();

    this.entities.add(drone);
    pad.onDroneDeployed();
    this.audio.playLaunch(pad.x, 'sam'); // reuse SAM launch sound
  }

  // ── Vulkan helpers ─────────────────────────────────────────

  _onVulkanFire(cannon) {
    const launchPos = cannon.getLaunchPosition();
    const bullet = new VulkanBullet(launchPos.x, launchPos.y);
    const dx = this.input.mouseX - launchPos.x;
    const dy = this.input.mouseY - launchPos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    bullet.fire(len > 0 ? dx / len : 0, len > 0 ? dy / len : -1);
    this.entities.add(bullet);
    this.audio.playVulkanShot(launchPos.x);
  }

  _startVulkanSpool() {
    if (this._vulkanSpoolLoop) return;
    if (this.selectedLauncher) {
      this._vulkanSpoolLoop = this.audio.startSpoolLoop(this.selectedLauncher.x);
    }
  }

  _stopVulkanSpool() {
    if (this._vulkanSpoolLoop) {
      this.audio.stopLoop(this._vulkanSpoolLoop);
      this._vulkanSpoolLoop = null;
    }
    this._vulkanWasFiring = false;
  }

  // ── Heat-seeker lock-on ────────────────────────────────────

  _updateLockedTarget() {
    if (!this.selectedLauncher || !this.selectedLauncher.alive ||
        this.selectedLauncher.type !== 'heatseeker') {
      this.lockedTarget = null;
      return;
    }

    const prevLocked = this.lockedTarget;

    const mx = this.input.mouseX;
    const my = this.input.mouseY;
    const enemies = this.entities.getGroup('enemy_missiles');

    let closest = null;
    let closestDist = CROSSHAIR_RADIUS;

    for (const enemy of enemies) {
      const d = dist(mx, my, enemy.x, enemy.y);
      if (d < closestDist) {
        closestDist = d;
        closest = enemy;
      }
    }

    this.lockedTarget = closest;

    // "Target acquired" ping on new lock acquisition
    if (this.lockedTarget && this.lockedTarget !== prevLocked && this._targetAcquiredCooldown <= 0) {
      this.audio.playTargetAcquired();
      this._targetAcquiredCooldown = 2.0;
    }
  }

  // ── Enemy spawning ─────────────────────────────────────────

  /** @param {string} type */
  _spawnEnemy(type) {
    switch (type) {
      case 'missile': this._spawnEnemyMissile(); break;
      case 'super_missile': this._spawnSuperMissile(); break;
      case 'drone': this._spawnDrone(); break;
      case 'suicide_drone': this._spawnSuicideDrone(); break;
      case 'nuke': this._spawnNuke(); break;
      case 'transport_plane': this._spawnTransportPlane(); break;
      case 'attack_quad': this._spawnAttackQuad(); break;
      case 'kamikaze_quad': this._spawnKamikazeQuad(); break;
      case 'shock_missile': this._spawnShockMissile(); break;
    }
  }

  _spawnEnemyMissile() {
    const spawnX = randf(100, 2460);
    const spawnY = randf(-100, -50);
    const missile = new EnemyMissile(spawnX, spawnY);

    // 40% chance to target a launcher, otherwise random terrain
    let targetX;
    if (Math.random() < 0.4 && this.launchers.some(l => l.alive)) {
      const alive = this.launchers.filter(l => l.alive);
      const target = alive[Math.floor(Math.random() * alive.length)];
      targetX = target.x + randf(-80, 80);
    } else {
      targetX = randf(100, 2460);
    }
    const targetY = this.terrain ? this.terrain.getHeightAt(targetX) : 1240;
    missile.launchTo(targetX, targetY, randf(8.0, 12.0));
    this.entities.add(missile);
  }

  _spawnSuperMissile() {
    const missile = new SuperMissile(randf(200, 2360), -80);
    const targetX = randf(300, 2260);
    const targetY = this.terrain ? this.terrain.getHeightAt(targetX) : 1240;
    missile.launchTo(targetX, targetY, randf(6.0, 10.0));
    this.entities.add(missile);
  }

  _spawnShockMissile() {
    const spawnX = randf(100, 2460);
    const spawnY = randf(-100, -50);
    const missile = new ShockMissile(spawnX, spawnY);

    // 60% chance to target a launcher directly — shock wave is more dangerous near bases
    let targetX;
    if (Math.random() < 0.6 && this.launchers.some(l => l.alive)) {
      const alive = this.launchers.filter(l => l.alive);
      const target = alive[Math.floor(Math.random() * alive.length)];
      // Aim slightly offset so shockwave propagates through multiple launchers
      targetX = target.x + randf(-120, 120);
    } else {
      targetX = randf(100, 2460);
    }
    const targetY = this.terrain ? this.terrain.getHeightAt(targetX) : 1240;
    missile.launchTo(targetX, targetY, randf(8.0, 12.0));

    // Wire ground impact callback — spawn ShockWave + electric explosion
    missile.onImpact = (x, y) => {
      // Small electric explosion visual (blue flash, not a mega explosion)
      this.entities.add(new Explosion(x, y, false));
      this.audio.playShockZap(x);
      this.shakeScreen(6);

      // Spawn ShockWave
      const wave = new ShockWave(x, y, this.terrain);
      wave.getLaunchers = () => this.launchers;
      this.entities.add(wave);
    };

    this.entities.add(missile);
  }

  _spawnDrone() {
    const fromLeft = Math.random() < 0.5;
    const drone = new Drone(fromLeft, randf(200, 600));
    drone.getLaunchers = () => this.launchers;
    drone.onDropBomb = (x, y) => this._onDroneBomb(x, y);
    this.entities.add(drone);
  }

  _spawnSuicideDrone() {
    const fromLeft = Math.random() < 0.5;
    const drone = new SuicideDrone(
      fromLeft ? -60 : 2620,
      randf(150, 500)
    );
    drone.getLaunchers = () => this.launchers;
    drone.init();
    this.entities.add(drone);
  }

  _spawnNuke() {
    const spawnX = randf(400, 2160);
    const spawnY = -300;
    const nuke = new Nuke(spawnX, spawnY);

    let targetX;
    if (this.launchers.some(l => l.alive)) {
      const alive = this.launchers.filter(l => l.alive);
      const target = alive[Math.floor(Math.random() * alive.length)];
      targetX = target.x + randf(-40, 40);
    } else {
      targetX = randf(600, 1960);
    }
    const targetY = this.terrain ? this.terrain.getHeightAt(targetX) : 1240;
    nuke.launchTo(targetX, targetY, randf(5.0, 7.0));
    this.entities.add(nuke);

    this.ui.showNukeWarning();
    this.audio.playNukeWarning(spawnX);
  }

  _spawnTransportPlane() {
    const fromLeft = Math.random() < 0.5;
    const yPos = randf(100, 250);
    const maxDrops = Math.floor(randf(3, 6));
    const plane = new TransportPlane(fromLeft, yPos, maxDrops);
    plane.onDropParatrooper = (x, y) => {
      const trooper = new Paratrooper(x, y);
      // Inject game-world references so the trooper can navigate and attack
      trooper.terrain   = this.terrain;
      trooper._launchers = this.launchers;
      trooper.onDetonate = (px, py) => {
        // Spawn explosion at detonation point
        this.entities.add(new Explosion(px, py, true));
        this.audio.playExplosion(px, true);
        // Crater at detonation point
        const craterY = this.terrain ? this.terrain.getHeightAt(px) : py;
        this.entities.add(new Crater(px, craterY, 2));
        if (this.terrain) {
          this.terrain.damage(px, py, 70, 25);
        }
        this.shakeScreen(20);
      };
      this.entities.add(trooper);
    };
    this.entities.add(plane);
  }

  _spawnAttackQuad() {
    const side = Math.random() < 0.5 ? -60 : 2620;
    const y = randf(150, 400);
    const quad = new AttackQuad(side, y);
    quad.hoverTargetX = randf(300, 2260);
    quad.hoverTargetY = randf(200, 500);
    // Set hover targets so the approach state has a destination
    quad.hoverX = quad.hoverTargetX;
    quad.hoverY = quad.hoverTargetY;
    quad.terrain = this.terrain;
    quad.getLaunchers = () => this.launchers.filter(l => l.alive);
    quad.onSpawnProjectile = (tracer) => this.entities.add(tracer);
    quad.audio = this.audio;
    quad.onDeath = (x, y) => {
      this.entities.add(new Explosion(x, y));
      this.entities.add(new Crater(x, this.terrain ? this.terrain.getHeightAt(x) : y, 1.0));
    };
    this.entities.add(quad);
  }

  _spawnKamikazeQuad() {
    const side = Math.random() < 0.5 ? -60 : 2620;
    const y = randf(150, 400);
    const quad = new KamikazeQuad(side, y);
    quad.hoverTargetX = randf(300, 2260);
    quad.hoverTargetY = randf(250, 550);
    // Set hover targets so the approach state has a destination
    quad.hoverX = quad.hoverTargetX;
    quad.hoverY = quad.hoverTargetY;
    quad._hoverDuration = randf(1.5, 3.0);
    quad.terrain = this.terrain;
    quad.getLaunchers = () => this.launchers.filter(l => l.alive);
    quad.audio = this.audio;
    quad.onDeath = (x, y) => {
      this.entities.add(new Explosion(x, y));
      this.entities.add(new Crater(x, this.terrain ? this.terrain.getHeightAt(x) : y, 1.5));
    };
    this.entities.add(quad);
  }

  _onDroneBomb(x, y) {
    const bomb = new EnemyMissile(x, y);
    const targetX = x + randf(-30, 30);
    const targetY = this.terrain ? this.terrain.getHeightAt(targetX) : 1240;
    bomb.launchTo(targetX, targetY, randf(1.5, 2.5));
    this.entities.add(bomb);
  }

  // ── Game events ────────────────────────────────────────────

  onEnemyDestroyed(type = 'normal') {
    const points = { nuke: 5, transport_plane: 3, paratrooper: 2, attack_quad: 3, kamikaze_quad: 2 };
    const earned = points[type] || 1;
    this.score += earned;
    this.waveScore += earned;
  }

  shakeScreen(intensity = 15.0) {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  _checkGameOver() {
    if (!this.launchers.some(l => l.alive) && this.state === 'playing') {
      this.state = 'gameover';
      this._stopVulkanSpool();
      if (this._laserFiringLoop) {
        this.audio.stopLoop(this._laserFiringLoop);
        this._laserFiringLoop = null;
      }
    }
  }

  _resetChatterTimer() {
    this._chatterInterval = randf(8, 15);
    this._chatterTimer = 0;
  }
}
