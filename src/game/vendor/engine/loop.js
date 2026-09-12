/**
 * Start the game loop using requestAnimationFrame.
 * Calculates delta time between frames, capped at 1/20s to prevent spiral-of-death.
 *
 * @param {(dt: number) => void} updateFn - called each frame with delta time in seconds
 * @param {() => void} renderFn - called each frame after update
 * @returns {{ stop: () => void }} handle to stop the loop
 */
export function startLoop(updateFn, renderFn) {
  let lastTime = 0;
  let running = true;
  let rafId = 0;

  function frame(timestamp) {
    if (!running) return;

    if (lastTime === 0) {
      lastTime = timestamp;
    }

    let dt = (timestamp - lastTime) / 1000; // ms → seconds
    lastTime = timestamp;

    // Cap dt to prevent spiral-of-death (e.g. after tab switch)
    if (dt > 1 / 20) {
      dt = 1 / 20;
    }

    updateFn(dt);
    renderFn();

    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    }
  };
}
