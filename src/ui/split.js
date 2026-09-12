// The resizable divider — #5 §3.2, AC1.
//
// Writes one CSS custom property per axis. Two properties, not one, deliberately: a
// pixel value that means "column width" is nonsense as a row height after a breakpoint
// cross — 1100 px of column becomes 1100 px of row on a 900 px-tall viewport and
// collapses the second panel. Each axis remembers its own.

/**
 * @param {object} o
 * @param {HTMLElement} o.app      the grid container
 * @param {HTMLElement} o.divider  `[data-role="divider"]`
 * @param {Function}   [o.onResize] called once per committed write, so the panel can
 *                                  re-measure without waiting for the ResizeObserver
 */
export function createSplit({ app, divider, onResize }) {
  let stacked = false;
  let raf = 0;
  let pending = null;

  const token = (name) => parseFloat(getComputedStyle(app).getPropertyValue(name)) || 0;

  const commit = () => {
    raf = 0;
    if (pending === null) return;
    const rect = app.getBoundingClientRect();
    const gap = token('--divider');
    const min = token('--min-panel');
    // A panel under --min-panel letterboxes the game to a sliver and leaves #6 nothing
    // to draw in, so the clamp is a usability floor, not a safety check.
    const extent = stacked ? rect.height - token('--status-h') : rect.width;
    const at = stacked ? pending - rect.top : pending - rect.left;
    const value = Math.min(Math.max(at, min), Math.max(min, extent - gap - min));
    app.style.setProperty(stacked ? '--split-y' : '--split-x', `${Math.round(value)}px`);
    pending = null;
    onResize?.();
  };

  // Coalesced into one rAF callback per frame. A 120 Hz trackpad delivers pointermove
  // faster than the display refreshes, and writing the property per event forces a
  // layout per event; the measured cost of the coalesced version is in §11 AC5.
  const queue = (coord) => {
    pending = coord;
    if (!raf) raf = requestAnimationFrame(commit);
  };

  const onMove = (e) => queue(stacked ? e.clientY : e.clientX);

  const end = (e) => {
    divider.releasePointerCapture?.(e.pointerId);
    divider.removeEventListener('pointermove', onMove);
    document.body.classList.remove('dragging');
    commit();
  };

  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // Pointer capture, so a fast drag that outruns the 6 px strip keeps tracking.
    divider.setPointerCapture?.(e.pointerId);
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', end, { once: true });
    divider.addEventListener('pointercancel', end, { once: true });
    // Only while dragging, or the drag selects the status-bar text.
    document.body.classList.add('dragging');
    queue(stacked ? e.clientY : e.clientX);
  });

  return {
    setAxis(next) {
      stacked = next;
      divider.setAttribute('aria-orientation', next ? 'horizontal' : 'vertical');
    },
  };
}
