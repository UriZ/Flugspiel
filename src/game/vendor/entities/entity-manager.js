/**
 * EntityManager — manages all entities: add/remove, update/draw, group queries.
 */
export class EntityManager {
  constructor() {
    /** @type {import('./entity.js').Entity[]} */
    this.entities = [];
  }

  /**
   * Add an entity.
   * @param {import('./entity.js').Entity} entity
   * @returns {import('./entity.js').Entity} the same entity (for chaining)
   */
  add(entity) {
    this.entities.push(entity);
    return entity;
  }

  /**
   * Immediately remove a specific entity.
   * @param {import('./entity.js').Entity} entity
   */
  remove(entity) {
    entity.alive = false;
  }

  /**
   * Update all entities and filter out dead ones.
   * @param {number} dt
   */
  update(dt) {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.alive) {
        e.update(dt);
      }
    }
    // Remove dead entities after the full update pass (never mid-iteration)
    this.entities = this.entities.filter(e => e.alive);
  }

  /**
   * Draw all entities.
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.alive) {
        e.draw(ctx);
      }
    }
  }

  /**
   * Get all living entities that belong to a specific group.
   * @param {string} name
   * @returns {import('./entity.js').Entity[]}
   */
  getGroup(name) {
    const result = [];
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.alive && e.groups.has(name)) {
        result.push(e);
      }
    }
    return result;
  }

  /** Remove all entities. */
  clear() {
    this.entities.length = 0;
  }
}
