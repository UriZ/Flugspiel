/**
 * Base entity class. All game objects extend this.
 */
export class Entity {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.alive = true;
    /** @type {Set<string>} Group names this entity belongs to */
    this.groups = new Set();
    /** Collision radius for circle-based hit testing */
    this.collisionRadius = 0;
  }

  /**
   * Called each frame. Override in subclasses.
   * @param {number} dt - delta time in seconds
   */
  update(dt) {
    // override
  }

  /**
   * Called each frame after update. Override in subclasses.
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    // override
  }

  /** Mark this entity for removal. */
  destroy() {
    this.alive = false;
  }
}
