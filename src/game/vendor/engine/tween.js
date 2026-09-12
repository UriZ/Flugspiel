/**
 * Lightweight tween for UI animations.
 * Interpolates a single property on a target object from one value to another over time.
 */
export class Tween {
  /**
   * @param {object} target   - object whose property is being tweened
   * @param {string} prop     - property name to tween
   * @param {number} from     - start value
   * @param {number} to       - end value
   * @param {number} duration - seconds
   * @param {(t: number) => number} [easing] - easing function (default: ease-in-out)
   */
  constructor(target, prop, from, to, duration, easing = Tween.easeInOut) {
    this.target = target;
    this.prop = prop;
    this.from = from;
    this.to = to;
    this.duration = duration;
    this.easing = easing;
    this.elapsed = 0;
    this.finished = false;

    // Set initial value
    target[prop] = from;
  }

  /**
   * Advance the tween by dt seconds.
   * @param {number} dt
   * @returns {boolean} true when the tween is complete
   */
  update(dt) {
    if (this.finished) return true;

    this.elapsed += dt;
    let t = this.elapsed / this.duration;

    if (t >= 1) {
      t = 1;
      this.finished = true;
    }

    const easedT = this.easing(t);
    this.target[this.prop] = this.from + (this.to - this.from) * easedT;

    return this.finished;
  }

  // ── Common easing functions ────────────────────────────────

  /** @param {number} t */
  static linear(t) {
    return t;
  }

  /** @param {number} t */
  static easeIn(t) {
    return t * t;
  }

  /** @param {number} t */
  static easeOut(t) {
    return 1 - (1 - t) * (1 - t);
  }

  /** @param {number} t */
  static easeInOut(t) {
    return t < 0.5
      ? 2 * t * t
      : 1 - 2 * (1 - t) * (1 - t);
  }
}
