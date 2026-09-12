// FlyBridge — getState / applyAction / mode switching / emit loop. Spec #2 §2.4–2.6, §3.
//
// Installs exactly two reversible instance-property patches on the game; no upstream
// file is read except through documented fields. See §2.1 for why this is the seam.

import { VirtualInput } from './virtual-input.js';
import { buildState, VelocityTracker, toLogical } from './state-codec.js';

/**
 * @typedef {{ send: (state: object) => void }} Transport
 *   send() MUST be non-blocking and MUST discard any previously-unsent state
 *   (latest-wins). FlyBridge holds no queue: for a closed-loop controller, stale
 *   state is worse than no state.
 */

const ACTIONS = new Set(['fire', 'aim', 'hold_fire', 'release_fire', 'noop']);
const NEEDS_COORDS = new Set(['fire', 'aim']);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const present = (v) => v !== undefined && v !== null;

export class FlyBridge {
  /**
   * @param {object} game an upstream `Game` instance
   * @param {{emitHz?: number, mode?: 'human'|'fly'}} [options]
   */
  constructor(game, { emitHz = 20, mode = 'human' } = {}) {
    // One bridge per Game: a second bridge's detach() would `delete game.update` and
    // silently remove the first bridge's patch along with its own (§4.4 gotcha 10).
    if (game.__flyBridged) throw new Error('game already bridged');

    this.game = game;
    this.virtual = new VirtualInput();
    this._tracker = new VelocityTracker();
    this._mode = 'human';
    this._seq = 0;
    this._t = 0;
    this._session = 0;
    this._prevPhase = null;
    this._acc = 0;
    this._emitting = false;
    /** @type {Transport|null} */
    this._transport = null;
    this._attached = false;
    this._stats = {
      emitted: 0, skipped: 0, sendErrors: 0, actionsAccepted: 0, actionsRejected: 0, lastError: null,
    };

    // Both of these throw on a bad config — before anything is claimed or patched, so
    // a rejected construction leaves the game exactly as it found it and attachable.
    this.setEmitRate(emitHz);
    this.setMode(mode);

    // patch 1 — control. Input.update() runs at the start of Game.update(), and DOM
    // events can only arrive between frames, so overwriting here suppresses 100% of
    // human input for the frame. In human mode this is a pass-through.
    const origInputUpdate = game.input.update.bind(game.input);
    game.input.update = () => {
      origInputUpdate();
      if (this._mode === 'fly') this.virtual.writeTo(game.input);
    };

    // patch 2 — observation. Runs after a complete update step, so a snapshot is
    // never taken mid-update. `startLoop` resolves `this.update` at call time, so a
    // running loop picks this up.
    const origGameUpdate = game.update.bind(game);
    game.update = (dt) => {
      origGameUpdate(dt);
      this._afterFrame(dt);
    };

    // Claimed last: nothing above can throw from here on, so the flag and the patches
    // are installed together or not at all.
    game.__flyBridged = true;
    this._attached = true;
  }

  // ── Observation ────────────────────────────────────────────

  /** @returns {object} a GameState snapshot (§3.1). Safe in any phase. */
  getState() {
    return buildState(this.game, this._tracker, this._seq++, this._t, this._mode, this._session);
  }

  // ── Control ────────────────────────────────────────────────

  /**
   * Apply a brain action. Never throws on action data — this is fed by a neural
   * decoder over a network, and a throw inside the socket's frame would take the
   * game down. Configuration errors (setMode/setEmitRate) do throw.
   * @returns {{ok: boolean, reason?: string, clamped?: boolean}}
   */
  applyAction(action) {
    const result = this._validate(action);
    if (!result.ok) {
      this._stats.actionsRejected++;
      return result;
    }

    const { kind, weapon, coords } = result;
    if (weapon !== null) this.virtual.pressKey(String(weapon + 1));
    if (coords) {
      const p = toLogical(coords.x, coords.y);
      this.virtual.aim(p.x, p.y);
    }

    if (kind === 'fire') this.virtual.click();
    else if (kind === 'hold_fire') this.virtual.pressButton();
    else if (kind === 'release_fire') this.virtual.releaseButton();

    this._stats.actionsAccepted++;
    return result.clamped ? { ok: true, clamped: true } : { ok: true };
  }

  /** Validate the whole message before mutating anything — never half-apply. */
  _validate(action) {
    // Lifecycle before content: a detached bridge cannot deliver any action, whatever
    // the message says or what mode it was left in.
    if (!this._attached) return { ok: false, reason: 'detached' };
    if (typeof action !== 'object' || action === null) return { ok: false, reason: 'malformed' };
    if (this._mode !== 'fly') return { ok: false, reason: 'not_in_fly_mode' };
    if (this.game.state !== 'playing') return { ok: false, reason: 'not_playing' };

    const kind = present(action.action) ? action.action : 'noop';
    if (!ACTIONS.has(kind)) return { ok: false, reason: 'unknown_action' };

    let weapon = null;
    if (present(action.weapon_switch)) {
      weapon = action.weapon_switch;
      if (!Number.isInteger(weapon) || weapon < 0 || weapon > 6) {
        return { ok: false, reason: 'invalid_weapon' };
      }
      // Game._selectLauncher() silently returns for a dead launcher; the brain
      // deserves feedback rather than a no-op.
      const l = this.game.launchers[weapon];
      if (!l || !l.alive) return { ok: false, reason: 'launcher_dead' };
    }

    const hasX = present(action.x);
    const hasY = present(action.y);
    if (hasX !== hasY) return { ok: false, reason: 'invalid_coords' };
    if (!hasX) {
      if (NEEDS_COORDS.has(kind)) return { ok: false, reason: 'invalid_coords' };
      return { ok: true, kind, weapon, coords: null };
    }
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
      return { ok: false, reason: 'invalid_coords' };
    }

    // A decoder emits a continuous signal; rejecting 1.0000001 would make the screen
    // edges unreachable. `clamped` is reported so a broken decoder stays detectable.
    const coords = { x: clamp01(action.x), y: clamp01(action.y) };
    const clamped = coords.x !== action.x || coords.y !== action.y;
    return { ok: true, kind, weapon, coords, clamped };
  }

  /** Synthetic click to leave the start/gameover screen. @returns {{ok:boolean,reason?:string}} */
  startGame() {
    if (!this._attached) return { ok: false, reason: 'detached' };
    if (this._mode !== 'fly') return { ok: false, reason: 'not_in_fly_mode' };
    if (this.game.state === 'playing') return { ok: false, reason: 'already_playing' };
    this.virtual.click();
    return { ok: true };
  }

  // ── Mode ───────────────────────────────────────────────────

  setMode(mode) {
    if (mode !== 'human' && mode !== 'fly') throw new TypeError(`unknown mode: ${mode}`);
    if (mode === this._mode) return; // idempotent — no reset

    if (mode === 'fly') {
      // Seed from the real pointer so the turrets don't snap on entry.
      this.virtual.aim(this.game.input.mouseX, this.game.input.mouseY);
      this.virtual.reset();
    } else {
      this.virtual.reset();
      this.virtual.releaseInto(this.game.input);
    }
    this._mode = mode;
  }

  getMode() {
    return this._mode;
  }

  // ── Emission ───────────────────────────────────────────────

  setEmitRate(hz) {
    if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0 || hz > 240) {
      throw new RangeError(`emit rate must be a number in (0, 240], got ${hz}`);
    }
    this._emitHz = hz;
    // A rate change must not carry credit that is large in the new interval's terms.
    this._acc = Math.min(this._acc, 1 / hz);
  }

  getEmitRate() {
    return this._emitHz;
  }

  setTransport(transport) {
    this._transport = transport;
  }

  startEmitting() {
    this._acc = 0; // first emit lands one interval after the start, not immediately
    this._emitting = true;
  }

  stopEmitting() {
    this._emitting = false;
  }

  isEmitting() {
    return this._emitting;
  }

  getStats() {
    return { ...this._stats };
  }

  /**
   * Called by the game.update patch after every complete frame.
   *
   * The accumulator keeps its remainder (`acc -= interval`) so the average rate is
   * correct — discarding it quantizes 10 Hz down to 8.57 Hz at 60 fps — and clamps
   * the backlog at one interval so a throttled tab cannot bank credit and then emit
   * every frame for a minute on recovery. No epsilon: the accumulator self-corrects
   * across frames, and an epsilon would bias the rate fast. Evidence and the three
   * rejected variants: tools/spike/emit-rate.mjs.
   */
  _afterFrame(dt) {
    this._t += dt;

    // `game.state = 'playing'` is assigned at exactly one site — inside start() — so a
    // transition into it is an exact proxy for a restart. Watched per frame rather than
    // per emit: the restart needs mouseJustPressed on a frame *after* the one that set
    // 'gameover', so at this rate the boundary cannot be missed. No third game patch.
    const phase = this.game.state;
    if (phase === 'playing' && this._prevPhase !== 'playing') this._session++;
    this._prevPhase = phase;

    if (!this._emitting) return;

    const interval = 1 / this._emitHz;
    this._acc += dt;
    if (this._acc < interval) return;
    this._acc -= interval;
    if (this._acc > interval) this._acc = interval;

    if (!this._transport) {
      this._stats.skipped++;
      return;
    }
    // Outside the try on purpose: a buildState bug is ours, not the transport's, and
    // must surface rather than be counted as a send error and swallowed.
    const state = this.getState();
    try {
      this._transport.send(state);
      this._stats.emitted++;
    } catch (e) {
      // A broken transport must never break the game loop — but it must stay diagnosable.
      this._stats.sendErrors++;
      this._stats.lastError = e;
    }
  }

  /** Restore the prototype methods, stop emitting, release the real Input. */
  detach() {
    // Idempotent: without this, a stale detach() from an already-detached bridge would
    // `delete` a *successor* bridge's patches and clear its __flyBridged guard.
    if (!this._attached) return;
    this._attached = false;
    this._emitting = false;
    // `delete`, not reassignment of a saved copy — otherwise a later bridge's patch
    // would be resurrected rather than removed.
    delete this.game.update;
    delete this.game.input.update;
    this.virtual.reset();
    this.virtual.releaseInto(this.game.input);
    delete this.game.__flyBridged;
  }
}
