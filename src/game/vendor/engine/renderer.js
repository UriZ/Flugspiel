/**
 * Renderer — Canvas setup, coordinate scaling (2560x1440 logical → window),
 * camera shake offset, and draw helpers.
 */
export class Renderer {
  /** Logical (game) resolution */
  static LOGICAL_W = 2560;
  static LOGICAL_H = 1440;

  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Camera shake offset (logical pixels)
    this.cameraOffsetX = 0;
    this.cameraOffsetY = 0;

    // Computed on resize
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    this._onResize = () => this._updateSize();
    window.addEventListener('resize', this._onResize);
    this._updateSize();
  }

  /** Recalculate canvas size and scale to fit the window with 16:9 letterboxing. */
  _updateSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.canvas.width = w * devicePixelRatio;
    this.canvas.height = h * devicePixelRatio;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    const scaleX = w / Renderer.LOGICAL_W;
    const scaleY = h / Renderer.LOGICAL_H;
    this.scale = Math.min(scaleX, scaleY);

    this.offsetX = (w - Renderer.LOGICAL_W * this.scale) / 2;
    this.offsetY = (h - Renderer.LOGICAL_H * this.scale) / 2;
  }

  /**
   * Begin a new frame: clear canvas and set up the logical-to-physical transform
   * including camera shake offset. Clips all rendering to the logical viewport
   * so nothing bleeds into letterbox bars on non-16:9 aspect ratios.
   *
   * Order of operations:
   *   1. Set base transform (scale + letterbox offset, NO shake) — clip is in this space
   *   2. Apply clip rect at (0, 0, LOGICAL_W, LOGICAL_H) — anchored to screen, not shaken
   *   3. Translate by camera shake offset so game content shakes inside the fixed clip
   */
  beginFrame() {
    const ctx = this.ctx;
    const c = this.canvas;

    // Reset to identity and clear the full physical canvas (including letterbox bars)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);

    // Step 1: base transform — DPR scaling + letterbox offset, without shake.
    // The clip must be set in this space so it stays fixed to the screen.
    const totalScale = this.scale * devicePixelRatio;
    ctx.setTransform(
      totalScale, 0,
      0, totalScale,
      this.offsetX * devicePixelRatio,
      this.offsetY * devicePixelRatio
    );

    // Step 2: clip to the logical viewport in pre-shake space.
    // This ensures the clip rect never moves even when cameraOffset is non-zero,
    // preventing explosions or other entities from bleeding into the letterbox bars.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Renderer.LOGICAL_W, Renderer.LOGICAL_H);
    ctx.clip();

    // Step 3: apply the camera shake on top as a translation in logical coords.
    // Content shakes within the fixed clip region established above.
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
  }

  /**
   * Switch to UI rendering mode — applies the logical transform WITHOUT camera shake.
   * Call this after drawing the game world (which includes shake) and before drawing UI.
   */
  beginUI() {
    const totalScale = this.scale * devicePixelRatio;
    this.ctx.setTransform(
      totalScale, 0,
      0, totalScale,
      this.offsetX * devicePixelRatio,
      this.offsetY * devicePixelRatio
    );
  }

  /** End the current frame. Restores the clip region set by beginFrame(). */
  endFrame() {
    this.ctx.restore();
  }

  // ── Drawing helpers ──────────────────────────────────────────

  /**
   * Draw a filled polygon.
   * @param {Array<[number,number]>} points - array of [x, y] in logical coords
   * @param {string} color - CSS color
   */
  drawPolygon(points, color) {
    if (points.length < 2) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Draw a filled circle.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {string} color
   */
  drawCircle(x, y, radius, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Draw a line.
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @param {string} color
   * @param {number} [width=1]
   */
  drawLine(x1, y1, x2, y2, color, width = 1) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /**
   * Draw an arc (stroke only).
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {number} startAngle
   * @param {number} endAngle
   * @param {string} color
   * @param {number} [width=1]
   */
  drawArc(x, y, radius, startAngle, endAngle, color, width = 1) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, radius, startAngle, endAngle);
    ctx.stroke();
  }

  /**
   * Draw text.
   * @param {string} text
   * @param {number} x
   * @param {number} y
   * @param {string} [font='24px monospace']
   * @param {string} [color='#fff']
   * @param {CanvasTextAlign} [align='left']
   */
  drawText(text, x, y, font = '24px monospace', color = '#fff', align = 'left') {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
  }

  // ── Offscreen canvas ────────────────────────────────────────

  /**
   * Create an offscreen canvas for caching (e.g. terrain).
   * @param {number} width
   * @param {number} height
   * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
   */
  createOffscreen(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    return { canvas, ctx };
  }

  // ── Coordinate transforms ──────────────────────────────────

  /**
   * Convert screen (DOM event) coordinates to logical game coordinates.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ x: number, y: number }}
   */
  screenToLogical(clientX, clientY) {
    const x = (clientX - this.offsetX) / this.scale;
    const y = (clientY - this.offsetY) / this.scale;
    return { x, y };
  }

  /**
   * Convert logical game coordinates to screen (CSS) coordinates.
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }}
   */
  logicalToScreen(x, y) {
    return {
      x: x * this.scale + this.offsetX,
      y: y * this.scale + this.offsetY
    };
  }
}
