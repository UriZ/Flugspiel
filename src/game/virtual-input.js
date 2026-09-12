// A synthetic mouse + numeric keypad. Spec #2 §2.2.
//
// `Game` reads *all* player intent from one object (`game.input`), so overwriting
// that object's fields once per frame is a complete, lossless control surface —
// and touches zero upstream files.

import { LOGICAL_W, LOGICAL_H } from './state-codec.js';

export class VirtualInput {
  constructor() {
    this.x = LOGICAL_W / 2;
    this.y = LOGICAL_H / 2;
    this.down = false;
    this._pressed = false;
    /** @type {Set<string>} */
    this._keys = new Set();
  }

  /** Move the pointer (logical px). */
  aim(logicalX, logicalY) {
    this.x = logicalX;
    this.y = logicalY;
  }

  /** Latch a one-frame press. OR-latched: N clicks between frames = 1 press. */
  click() {
    this._pressed = true;
  }

  /** A real mousedown both holds the button and produces a press. */
  pressButton() {
    if (!this.down) this._pressed = true;
    this.down = true;
  }

  releaseButton() {
    this.down = false;
  }

  /** Latch a key into the next frame's just-pressed set. */
  pressKey(key) {
    this._keys.add(key);
  }

  /**
   * Overwrite the real Input's fields for one frame, consuming latched state.
   * MUST be called *after* the original `Input.update()`, which rebuilds
   * `_keysJustPressedFrame` and would otherwise clobber what we write.
   */
  writeTo(input) {
    input.mouseX = this.x;
    input.mouseY = this.y;
    input.mouseDown = this.down;
    input.mouseJustPressed = this._pressed;
    input.rightMouseJustPressed = false;
    input.arrowLeft = false;
    input.arrowRight = false;
    // The one upstream private we depend on — `Input.wasKeyPressed()` reads it.
    // virtual-input.test.js T16 asserts the dependency still holds after a re-vendor.
    input._keysJustPressedFrame = new Set(this._keys);
    this._pressed = false;
    this._keys.clear();
  }

  reset() {
    this.down = false;
    this._pressed = false;
    this._keys.clear();
  }

  /**
   * Zero the real Input once. Without this, leaving fly mode while `down` is true
   * (vulkan/laser sustained fire) leaves `input.mouseDown === true` forever — the
   * weapon keeps firing until a human clicks and releases.
   */
  releaseInto(input) {
    input.mouseDown = false;
    input.mouseJustPressed = false;
    input.arrowLeft = false;
    input.arrowRight = false;
    input._keysJustPressedFrame = new Set();
  }
}
