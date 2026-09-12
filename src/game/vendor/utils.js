/** @type {number} */
export const TAU = Math.PI * 2;

/**
 * Linearly interpolate between two values.
 * @param {number} a
 * @param {number} b
 * @param {number} t - weight (0..1)
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Shortest-path angle interpolation.
 * @param {number} from - radians
 * @param {number} to   - radians
 * @param {number} weight - 0..1
 * @returns {number}
 */
export function lerpAngle(from, to, weight) {
  let diff = ((to - from + Math.PI * 3) % TAU) - Math.PI;
  return from + diff * weight;
}

/**
 * Clamp a value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Convert Godot Color(r,g,b,a) (0-1 floats) to CSS rgba string.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a=1]
 * @returns {string}
 */
export function rgba(r, g, b, a = 1) {
  return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`;
}

/**
 * Random float in [min, max).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randf(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Random integer in [min, max] (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randi(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Move a value toward a target by at most `maxDelta` per call.
 * Equivalent to Godot's move_toward().
 * @param {number} from
 * @param {number} to
 * @param {number} maxDelta
 * @returns {number}
 */
export function moveToward(from, to, maxDelta) {
  if (Math.abs(to - from) <= maxDelta) return to;
  return from + Math.sign(to - from) * maxDelta;
}

/**
 * Pick a random element from an array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Distance between two 2D points.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
export function dist(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}
