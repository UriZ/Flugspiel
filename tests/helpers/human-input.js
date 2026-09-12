// What the real DOM listeners write into `Input` before a frame, in one place —
// the two suites previously disagreed about whether a click sets `mouseDown`.
// Modelled on engine/input.js: `mousedown` sets both `mouseDown` and `_mousePressed`,
// and `keydown` sets `arrowLeft`/`arrowRight` alongside the just-pressed set.

/**
 * @param {object} input a real upstream `Input`
 * @param {{x?: number, y?: number, pressed?: boolean, keys?: string[]}} [opts]
 */
export function humanInput(input, { x = 900, y = 300, pressed = true, keys = [] } = {}) {
  input.mouseX = x;
  input.mouseY = y;
  if (pressed) {
    input.mouseDown = true;
    input._mousePressed = true;
  }
  for (const k of keys) {
    input._keysJustPressed.add(k);
    if (k === 'ArrowLeft') input.arrowLeft = true;
    if (k === 'ArrowRight') input.arrowRight = true;
  }
}
