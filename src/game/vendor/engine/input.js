/**
 * Input — Mouse and keyboard tracking with logical coordinate conversion.
 */
export class Input {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./renderer.js').Renderer} renderer
   */
  constructor(canvas, renderer) {
    this.renderer = renderer;

    // Mouse state (logical coordinates)
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseDown = false;
    this.mouseJustPressed = false;

    // Right-click state
    this.rightMouseJustPressed = false;
    this._rightMousePressed = false;

    // Internal flag set by event, consumed by update()
    this._mousePressed = false;

    // Arrow key held state (for continuous truck movement)
    this.arrowLeft = false;
    this.arrowRight = false;

    // Keyboard state
    /** @type {Set<string>} keys currently held */
    this._keysDown = new Set();
    /** @type {Set<string>} keys pressed this frame (consumed by update) */
    this._keysJustPressed = new Set();
    /** @type {Set<string>} keys that were just pressed — exposed for one frame */
    this._keysJustPressedFrame = new Set();

    // --- Event listeners ---

    canvas.addEventListener('mousemove', (e) => {
      const pos = renderer.screenToLogical(e.clientX, e.clientY);
      this.mouseX = pos.x;
      this.mouseY = pos.y;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseDown = true;
        this._mousePressed = true;
      } else if (e.button === 2) {
        this._rightMousePressed = true;
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.mouseDown = false;
      }
    });

    window.addEventListener('keydown', (e) => {
      if (!this._keysDown.has(e.key)) {
        this._keysJustPressed.add(e.key);
      }
      this._keysDown.add(e.key);
      if (e.key === 'ArrowLeft')  this.arrowLeft  = true;
      if (e.key === 'ArrowRight') this.arrowRight = true;
    });

    window.addEventListener('keyup', (e) => {
      this._keysDown.delete(e.key);
      if (e.key === 'ArrowLeft')  this.arrowLeft  = false;
      if (e.key === 'ArrowRight') this.arrowRight = false;
    });

    // Reset state when window loses focus
    window.addEventListener('blur', () => {
      this._keysDown.clear();
      this.mouseDown = false;
      this.arrowLeft  = false;
      this.arrowRight = false;
    });
  }

  /**
   * Call at the START of each frame to update per-frame flags.
   */
  update() {
    this.mouseJustPressed = this._mousePressed;
    this._mousePressed = false;

    this.rightMouseJustPressed = this._rightMousePressed;
    this._rightMousePressed = false;

    this._keysJustPressedFrame = new Set(this._keysJustPressed);
    this._keysJustPressed.clear();
  }

  /**
   * @param {string} key
   * @returns {boolean} true if the key is currently held down
   */
  isKeyDown(key) {
    return this._keysDown.has(key);
  }

  /**
   * @param {string} key
   * @returns {boolean} true for one frame when the key is first pressed
   */
  wasKeyPressed(key) {
    return this._keysJustPressedFrame.has(key);
  }
}
