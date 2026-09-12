/**
 * TransportPlane — military cargo aircraft that flies horizontally and drops
 * paratroopers at intervals. Translated from the architect's spec.
 *
 * Flies at 100-250px altitude, 200px/s, drops up to maxDrops paratroopers
 * while over the playfield. Can be shot down by player projectiles.
 */

import { Entity } from './entity.js';
import { randf } from '../utils.js';


const SPEED = 200;
const OFF_SCREEN = { left: -300, right: 2860 };
const PLAYFIELD = { left: 200, right: 2360 };

// Polygon data (local coords, facing right; scale mirrored for direction)
const FUSELAGE  = [-70,0, -50,-8, -10,-10, 30,-8, 60,-4, 70,0, 60,4, 30,8, -10,10, -50,8];
const COCKPIT   = [30,-6, 55,-4, 65,0, 55,4, 30,6, 40,0];
const UPPER_WING = [-20,-10, 20,-10, 5,-40, -35,-15];
const LOWER_STAB = [-20,10, 10,10, -10,25, -35,12];
const TAIL_FIN  = [-55,0, -75,-20, -70,0, -75,8, -55,1];
const ENG_L     = [-25,-20, -10,-20, -10,-27, -25,-27]; // left engine pod
const ENG_R     = [5,-20, 20,-20, 20,-27, 5,-27];       // right engine pod
const CARGO_DOOR = [0,6, 30,6, 30,10, 0,10];            // belly door indicator

export class TransportPlane extends Entity {
  /**
   * @param {boolean} fromLeft — true = enters from left, false = from right
   * @param {number} yPos — vertical position (100-250)
   * @param {number} maxDrops — number of paratroopers to drop (3-5)
   */
  constructor(fromLeft, yPos, maxDrops = 4) {
    super(fromLeft ? -150 : 2710, yPos);
    this.direction = fromLeft ? 1 : -1;
    this.collisionRadius = 55;
    this.groups.add('enemy_missiles');

    this.maxDrops = maxDrops;
    this.dropsRemaining = maxDrops;
    this.dropTimer = randf(0.8, 1.5); // initial delay before first drop
    this.dropInterval = randf(1.2, 2.0);

    /** @type {function|null} Called to spawn a paratrooper at (x, y) */
    this.onDropParatrooper = null;

    /** @type {object|null} SoundLoop reference for engine sound cleanup */
    this.engineSound = null;

    // Animation time for engine glow
    this._animTime = 0;
  }

  update(dt) {
    this._animTime += dt;
    this.x += SPEED * this.direction * dt;

    // Drop paratroopers while over the playfield
    if (this.dropsRemaining > 0 &&
        this.x >= PLAYFIELD.left && this.x <= PLAYFIELD.right) {
      this.dropTimer -= dt;
      if (this.dropTimer <= 0) {
        this._dropParatrooper();
        this.dropsRemaining--;
        this.dropTimer = this.dropInterval;
      }
    }

    // Off-screen cleanup
    if (this.x < OFF_SCREEN.left || this.x > OFF_SCREEN.right) {
      this._stopEngineSound();
      this.alive = false;
    }
  }

  _dropParatrooper() {
    if (this.onDropParatrooper) {
      this.onDropParatrooper(this.x, this.y);
    }
  }

  _stopEngineSound() {
    if (this.engineSound) {
      this.engineSound.stop();
      this.engineSound = null;
    }
  }

  destroy() {
    super.destroy();
    this._stopEngineSound();
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.direction, 1);

    // ── Fuselage — olive drab gradient ──
    ctx.save();
    const bodyGrad = ctx.createLinearGradient(-70, -10, 70, 10);
    bodyGrad.addColorStop(0, '#4A5A3A');
    bodyGrad.addColorStop(1, '#2A3620');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(FUSELAGE[0], FUSELAGE[1]);
    for (let i = 2; i < FUSELAGE.length; i += 2) ctx.lineTo(FUSELAGE[i], FUSELAGE[i+1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── Cockpit — blue glass ──
    ctx.save();
    ctx.fillStyle = '#336688';
    ctx.strokeStyle = 'rgba(120,200,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(COCKPIT[0], COCKPIT[1]);
    for (let i = 2; i < COCKPIT.length; i += 2) ctx.lineTo(COCKPIT[i], COCKPIT[i+1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // ── Wings and fins ──
    ctx.save();
    ctx.fillStyle = '#3A4A2A';
    // Upper wing
    ctx.beginPath();
    ctx.moveTo(UPPER_WING[0], UPPER_WING[1]);
    for (let i = 2; i < UPPER_WING.length; i += 2) ctx.lineTo(UPPER_WING[i], UPPER_WING[i+1]);
    ctx.closePath();
    ctx.fill();
    // Lower stabilizer
    ctx.beginPath();
    ctx.moveTo(LOWER_STAB[0], LOWER_STAB[1]);
    for (let i = 2; i < LOWER_STAB.length; i += 2) ctx.lineTo(LOWER_STAB[i], LOWER_STAB[i+1]);
    ctx.closePath();
    ctx.fill();
    // Tail fin
    ctx.beginPath();
    ctx.moveTo(TAIL_FIN[0], TAIL_FIN[1]);
    for (let i = 2; i < TAIL_FIN.length; i += 2) ctx.lineTo(TAIL_FIN[i], TAIL_FIN[i+1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── Engine pods + animated glow ──
    const glowAlpha = 0.55 + Math.sin(this._animTime * 10) * 0.35;
    for (const eng of [ENG_L, ENG_R]) {
      ctx.save();
      ctx.fillStyle = '#2A3620';
      ctx.beginPath();
      ctx.moveTo(eng[0], eng[1]);
      for (let i = 2; i < eng.length; i += 2) ctx.lineTo(eng[i], eng[i+1]);
      ctx.closePath();
      ctx.fill();
      // Engine glow at rear of pod
      const ex = (eng[0] + eng[2]) * 0.5 - 10;
      const ey = (eng[1] + eng[5]) * 0.5;
      ctx.beginPath();
      ctx.arc(ex, ey, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,160,50,${glowAlpha.toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    }

    // ── Cargo door — amber pulse when about to drop ──
    const willDropSoon = this.dropsRemaining > 0 &&
      this.x >= PLAYFIELD.left && this.x <= PLAYFIELD.right &&
      this.dropTimer < 0.4;
    const doorPulse = willDropSoon
      ? (0.6 + Math.sin(this._animTime * 20) * 0.4)
      : (0.3 + Math.sin(this._animTime * 3) * 0.15);

    ctx.save();
    ctx.fillStyle = `rgba(255,180,30,${doorPulse.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(CARGO_DOOR[0], CARGO_DOOR[1]);
    for (let i = 2; i < CARGO_DOOR.length; i += 2) ctx.lineTo(CARGO_DOOR[i], CARGO_DOOR[i+1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── Fuselage outline for readability ──
    ctx.save();
    ctx.strokeStyle = 'rgba(80,100,60,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(FUSELAGE[0], FUSELAGE[1]);
    for (let i = 2; i < FUSELAGE.length; i += 2) ctx.lineTo(FUSELAGE[i], FUSELAGE[i+1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }
}
