// The brain visualization panel — #6, replacing #5's placeholder body.
//
// #5 defines the interface; the signature and the six methods are the contract and have
// not changed. The panel is plain Canvas 2D on the main thread with one ImageData scatter
// per map pane — measured against WebGL and an OffscreenCanvas worker on #6, where the
// worker was slower, not faster, because it adds a structured clone per frame and solves
// a throughput problem that does not exist. `transferControlToOffscreen()` is therefore
// not used and #5's §5.2 resize ownership is unchanged.
//
// The data drawn here is real spike data from the real connectome, at real soma
// coordinates. Two things it deliberately refuses to draw:
//
//   * a neuron whose position is unknown is never given one. The 26,062 without a soma
//     coordinate get a labelled strip on a visibly regular lattice, which reads as a
//     list and cannot be mistaken for anatomy.
//   * a map from a layout artifact that does not match `ready.n`. It would paint one
//     neuron's activity at another's coordinate, plausibly and falsely.
//
// The map and the VNC are separately framed because a single frame cannot show both:
// nearly all somas sit in the top fraction of the brain-to-VNC axis and the neck
// connective between them is empty. The two panes are at different scales, which is why
// each carries its own scale bar — without them the difference is invisible.

import { createAccumulator, paneMembers } from './activity.js';
import { createDescending } from './descending.js';
import { createDopamine } from './dopamine.js';
import { createRaster, ROWS } from './raster.js';
import { containFit, loadLayout, PANE_BRAIN, PANE_NONE, PANE_VNC, SEG_OTHER, validate } from './layout.js';
import { C, FONT } from './palette.js';
import { createSpikeRate } from '../ui/spike-rate.js';

const HEADER_H = 22;
const FOOTER_H = 40;
const STRIP_H = 54;
const DOPAMINE_H = 120;
const GUTTER = 10;
const FPS_WINDOW = 60;
const ACTIVE_WARN = 0.25;          // above this the footer's `active` turns warn
const STALL_FACTOR = 2;            // gap columns after this many frame periods

const fmt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

/** Fixed-width so the footer does not jitter as digits change. */
const pad = (s, n) => String(s).padStart(n, ' ');

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/**
 * @param {HTMLCanvasElement} canvas owned by the shell, which sets .width/.height
 * @param {object} ready #4's `ready` message, verbatim. `ready.n` is authoritative
 *                       for the neuron count — read it, never hardcode 166700.
 * @returns {{resize:Function, push:Function, render:Function, setConnection:Function, destroy:Function}}
 */
export function createPanel(canvas, ready) {
  const ctx = canvas.getContext('2d');
  let geo = { cssW: 1, cssH: 1, dpr: 1, w: 1, h: 1 };
  let snapshot = null;
  let conn = 'connecting';
  let destroyed = false;

  let layout = null;
  let layoutError = 'brain layout loading — map disabled';
  let dn = null;
  let members = null;

  const panes = {
    [PANE_BRAIN]: createAccumulator(),
    [PANE_VNC]: createAccumulator(),
    [PANE_NONE]: createAccumulator(),
  };
  const raster = createRaster();
  const dopamine = createDopamine();
  const rate = createSpikeRate();

  let zones = null;
  let lastStep = -1;
  let lastFrameMs = -Infinity;
  let framePeriodMs = 1000 / 19.2;   // EMA of the inter-frame interval
  let nextGapMs = Infinity;
  let compact = false;

  const frameTimes = [];
  const renderTimes = [];
  let fpsEma = 0;

  // Class sizes for the raster's denominators. `ready.regions` is the authoritative
  // list of class names; `ready.populations` does not carry per-class sizes, so the
  // counts come from the artifact once it lands and the raster stays dark until then.
  const classSizes = {};

  const applyLayout = (L) => {
    if (destroyed) return;
    const why = validate(L, ready);
    if (why) { layout = null; layoutError = why; return; }
    layout = L;
    layoutError = null;
    members = {
      [PANE_BRAIN]: paneMembers(L.pane, PANE_BRAIN),
      [PANE_VNC]: paneMembers(L.pane, PANE_VNC),
      [PANE_NONE]: paneMembers(L.pane, PANE_NONE),
    };
    dn = createDescending(L);
    for (let i = 0; i < L.n; i++) {
      const k = L.classNames[L.superIdx[i]];
      classSizes[k] = (classSizes[k] || 0) + 1;
    }
    raster.setClasses(Array.isArray(ready.regions) ? ready.regions : Object.keys(classSizes), classSizes);
    rebuild();
  };

  loadLayout().then((L) => {
    if (L) applyLayout(L);
    else { layout = null; layoutError = 'brain layout unavailable — map disabled'; }
  });

  /** Zone geometry in css px, plus the degradation ladder. Recomputed only on resize.
   *
   *  Heights are allocated from a budget and subtracted, never clamped independently:
   *  independent clamps can each be individually reasonable and still sum past the
   *  panel, which does not look like a layout bug, it looks like the dopamine zone
   *  printing on top of the footer. The budget makes overflow unrepresentable. */
  function computeZones() {
    const w = geo.cssW;
    const h = geo.cssH;
    const drop = {
      axisLabels: h < 820,
      classLabels: h < 780,
      dopamineCompact: h < 740,
      strip: h < 680,
      dopamineBar: h < 620,
      vncInset: w < 420,
      dnTicks: w < 340,
      raster: h < 480,
    };

    const SEP = 4;
    let budget = Math.max(60, h - HEADER_H - FOOTER_H);

    // Spend in ladder order, each zone taking what is left rather than what it wants.
    let dopH = drop.dopamineBar ? 22 : drop.dopamineCompact ? 72 : DOPAMINE_H;
    dopH = Math.min(dopH, Math.max(22, Math.floor(budget * 0.28)));
    budget -= dopH + SEP;

    let stripH = drop.strip ? 0 : STRIP_H;
    stripH = Math.min(stripH, Math.max(0, Math.floor(budget * 0.16)));
    if (stripH > 0 && stripH < 30) stripH = 0;          // a strip too short to label
    if (stripH === 0) drop.strip = true;
    budget -= stripH + (stripH ? SEP : 0);

    // The map must never be starved below a readable height, and neither must the
    // middle band; splitting what is left keeps both true at any panel size.
    const MIN_MID = 84;
    let brainH = Math.round(Math.min(Math.max(budget * 0.42, 96), Math.max(96, budget - MIN_MID)));
    brainH = Math.min(brainH, Math.max(60, budget - 24));
    budget -= brainH + SEP;
    const midH = Math.max(24, budget);

    if (midH < 150) drop.raster = true;
    compact = Object.values(drop).some(Boolean);

    const vncW = drop.vncInset ? 0 : Math.round(Math.min(Math.max(midH * 0.394, 64), w * 0.22));

    let y = 0;
    const header = { x: 0, y, w, h: HEADER_H };
    y += HEADER_H;
    const brain = { x: 0, y, w, h: brainH };
    y += brainH + SEP;
    const mid = { x: 0, y, w, h: midH };
    const vnc = { x: 0, y, w: vncW, h: midH };
    const rightX = vncW ? vncW + SEP : 0;
    const rightW = w - rightX;
    const dnH = drop.raster ? midH : Math.round(Math.min(Math.max(midH * 0.3, 72), 120));
    const dnZone = { x: rightX, y, w: rightW, h: dnH };
    const rasterZone = drop.raster
      ? null
      : { x: rightX, y: y + dnH + SEP, w: rightW, h: midH - dnH - SEP };
    y += midH + SEP;
    const strip = stripH ? { x: 0, y, w, h: stripH } : null;
    y += stripH ? stripH + SEP : 0;
    const dop = { x: 0, y, w, h: dopH };
    const footer = { x: 0, y: h - FOOTER_H, w, h: FOOTER_H };

    return { header, brain, mid, vnc, dn: dnZone, raster: rasterZone, strip, dop, footer,
             drop, vncInset: drop.vncInset };
  }

  /** The only place the per-pixel buffers are allocated — see #5's contract note.
   *  Idempotent for unchanged geometry: `resize()` is cheap for a caller to over-call,
   *  and reallocating would silently discard every accumulated pixel level, which shows
   *  up as a map that renders only its static floor however hard the brain is firing. */
  let builtKey = '';
  function rebuild() {
    const key = `${geo.cssW}x${geo.cssH}@${geo.dpr}|${layout ? layout.n : 0}`;
    if (key === builtKey) return;
    builtKey = key;
    zones = computeZones();
    if (!layout || !members) return;
    const d = geo.dpr;

    // A title band reserved out of the rect, not drawn over it: at a small panel size
    // the contain-fit fills the full height and would otherwise bury the title.
    const TITLE_H = 16;
    const brainBox = { x: zones.brain.x, y: zones.brain.y + TITLE_H,
                       w: zones.brain.w, h: Math.max(24, zones.brain.h - TITLE_H) };
    const brainRect = containFit(brainBox, layout.paneAspect[PANE_BRAIN]);
    zones.brainFit = brainRect;
    panes[PANE_BRAIN].rebuild(ctx, Math.round(brainRect.w * d), Math.round(brainRect.h * d),
                              members[PANE_BRAIN], layout.uv);

    // On a narrow panel the VNC becomes an inset in the brain pane's bottom-right
    // rather than disappearing: it is 15,618 real neurons and must not silently vanish.
    const insetH = Math.min(brainRect.h - 8, 56 / layout.paneAspect[PANE_VNC]);
    const vncBox = zones.vncInset
      // Inside the brain pane's bottom-right, never outside it: at the narrow end the
      // VNC is 15,618 real neurons and must stay visible, but it must not escape the
      // pane it is inset into.
      ? { x: brainRect.x + brainRect.w - 60, y: brainRect.y + brainRect.h - insetH - 4,
          w: 56, h: insetH }
      // 18px reserved for the zone title, or the blit covers it.
      : { x: zones.vnc.x, y: zones.vnc.y + TITLE_H, w: zones.vnc.w,
          h: Math.max(24, zones.vnc.h - TITLE_H - 4) };
    const vncRect = vncBox.w > 8 && vncBox.h > 8
      ? containFit(vncBox, layout.paneAspect[PANE_VNC]) : null;
    zones.vncFit = vncRect;
    if (vncRect) {
      panes[PANE_VNC].rebuild(ctx, Math.round(vncRect.w * d), Math.round(vncRect.h * d),
                              members[PANE_VNC], layout.uv);
    }

    if (zones.strip) {
      const inner = { x: zones.strip.x + GUTTER, y: zones.strip.y + 24,
                      w: zones.strip.w - 2 * GUTTER, h: zones.strip.h - 28 };
      zones.stripFit = inner;
      panes[PANE_NONE].rebuild(ctx, Math.round(inner.w * d), Math.round(inner.h * d),
                               members[PANE_NONE], layout.uv);
    } else {
      zones.stripFit = null;
      panes[PANE_NONE].destroy();
    }

    if (zones.raster) {
      const gutter = zones.drop.classLabels ? 48 : 96;
      const cols = Math.max(1, Math.round(zones.raster.w - 2 * GUTTER - gutter));
      raster.resize(cols);
      zones.rasterGutter = gutter;
      dopamine.resize(cols);
    }
  }

  /** Device-pixel-accurate projection of a neuron onto the canvas, or null if its pane
   *  is not currently drawn. Used by the DN marker and ring passes. */
  const project = (i) => {
    if (!layout) return null;
    const p = layout.pane[i];
    const fit = p === PANE_BRAIN ? zones?.brainFit : p === PANE_VNC ? zones?.vncFit : null;
    if (!fit) return null;
    return { x: fit.x + (layout.uv[2 * i] / 65535) * fit.w,
             y: fit.y + (layout.uv[2 * i + 1] / 65535) * fit.h };
  };

  const text = (s, x, y, colour, px = 10, align = 'left', maxW = 0) => {
    ctx.font = FONT(px);
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    // Truncated, never overflowing. A label that runs past its zone lands on top of a
    // neighbouring zone's text and both become unreadable.
    let out = s;
    if (maxW > 0 && ctx.measureText(out).width > maxW) {
      while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
      out += '…';
    }
    ctx.fillText(out, x, y);
    ctx.textAlign = 'left';
    return ctx.measureText(out).width;
  };

  function zoneTitle(rect, title, count) {
    const avail = rect.w - 2 * GUTTER;
    const used = text(title, rect.x + GUTTER, rect.y + 12, C.chrome, 10, 'left', avail);
    if (count && avail - used - 8 > 24) {
      text(count, rect.x + GUTTER + used + 8, rect.y + 12, C.chromeDim, 10, 'left',
           avail - used - 8);
    }
  }

  function scaleBar(rect, um) {
    if (!rect || !um || rect.w < 70 || rect.h < 28) return;
    // A round number of micrometres whose bar is a comfortable fraction of the pane.
    const targets = [10, 20, 50, 100, 200, 500, 1000];
    const pxPerUm = rect.w / um;
    let pick = targets[0];
    for (const t of targets) if (t * pxPerUm <= rect.w * 0.35) pick = t;
    const barW = pick * pxPerUm;
    const x = rect.x + rect.w - barW - 6;
    const y = rect.y + rect.h - 10;
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(x, y, barW, 1);
    text(`${pick}µm`, x + barW, y - 4, C.chromeDim, 9, 'right');
  }

  function renderHeader(rect) {
    // The chips are laid out first so the title is truncated against what is left.
    const chipRoom = layoutError ? 150 : 90;
    text(`FLY CNS · MaleCNS v1.0 · n=${fmt(ready.n)}`, rect.x + GUTTER, rect.y + 15,
         C.chrome, 10, 'left', rect.w - 2 * GUTTER - chipRoom);
    const [label, colour] = conn === 'live' ? ['LIVE', C.ok]
      : conn === 'connecting' ? ['CONNECTING', C.warn]
      : conn === 'stale' ? ['STALE', C.warn]
      : conn === 'idle' ? ['DISCONNECTED', C.bad]
      : conn === 'superseded' ? ['SUPERSEDED', C.bad]
      : conn === 'refused' ? ['REFUSED', C.bad]
      : snapshot ? ['CLOSED', C.bad] : ['READY', C.key];
    const chips = [[label, colour]];
    if (layoutError) chips.push(['MAP OFF', C.warn]);
    let x = rect.x + rect.w - GUTTER;
    ctx.font = FONT(10);
    for (const [t, c] of chips) {
      const wpx = ctx.measureText(t).width + 12;
      ctx.strokeStyle = c;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - wpx, rect.y + 4, wpx, 15);
      text(t, x - wpx / 2, rect.y + 15, c, 10, 'center');
      x -= wpx + 6;
    }
  }

  function renderStrip(rect) {
    zoneTitle(rect, 'NO SOMA POSITION',
      `— ${fmt(layout.n - members[PANE_BRAIN].length - members[PANE_VNC].length)} of ${fmt(layout.n)} `
      + `(${(100 * members[PANE_NONE].length / layout.n).toFixed(1)}%). Laid out by class; `
      + 'these are not anatomical locations.');
    const inner = zones.stripFit;
    panes[PANE_NONE].blit(ctx, Math.round(inner.x * geo.dpr), Math.round(inner.y * geo.dpr));
    ctx.font = FONT(9);
    for (let s = 0; s < layout.nSeg; s++) {
      const name = layout.segSuper[s] === SEG_OTHER ? 'other' : layout.classNames[layout.segSuper[s]];
      const label = `${name} ${fmt(layout.segCount[s])}`;
      const x = inner.x + layout.segU0[s] * inner.w;
      const segW = (layout.segU1[s] - layout.segU0[s]) * inner.w;
      // Skip rather than overlap: two labels on top of each other are less readable
      // than one, and the counts are all in the header line above anyway.
      if (ctx.measureText(label).width <= segW) text(label, x, rect.y + 22, C.key, 9);
    }
  }

  function renderFooter(rect) {
    const y1 = rect.y + 20;
    const y2 = rect.y + 34;
    const avail = rect.w - 2 * GUTTER;
    const f = snapshot;
    // brain-client.js rejects a frame whose `spikes.n` disagrees with `ready.n`, so
    // this cannot arise from the wire — but a percentage over 100 is never a reading
    // worth printing, and a panel that shows one is lying about something.
    const activeFrac = f && f.spikes.popcount <= ready.n ? f.spikes.popcount / ready.n : null;
    // Values blank rather than stale once the link is gone: a number still on screen
    // after a disconnect is the wrong kind of reassuring.
    const shown = conn === 'idle' || !f ? null : f;
    const active = shown?.descending?.active;
    const spk = rate.perSecond();

    // Each field carries a `keep` rank. When the row does not fit, the lowest ranks are
    // dropped first — `compact` outranks everything in row 2, because a viewer who
    // cannot see it cannot tell whether a zone is absent or merely empty.
    const row1 = [
      { k: 'step', v: shown ? fmt(shown.step) : '—', keep: 3 },
      { k: 'active', v: shown && activeFrac !== null ? `${(activeFrac * 100).toFixed(1)}%` : '—', keep: 4,
        c: activeFrac !== null && activeFrac > ACTIVE_WARN ? C.warn : C.text },
      { k: '', v: shown ? `${fmt(shown.spikes.popcount)}/step` : '—', keep: 1 },
      { k: '', v: shown && spk !== null ? `≈${fmt(spk)} spk/s` : '—', keep: 2 },
      { k: 'DN', v: shown && Array.isArray(active) ? `${active.length}/${fmt(dn ? dn.count : 0)}` : '—', keep: 3 },
    ];

    const backend = ready.backend || '?';
    const row2 = [
      { v: backend, keep: 3, c: backend !== 'numba' ? C.warn : C.chromeDim },
      { v: `sim ${fmt(ready.sim_hz)} Hz`, keep: 1 },
      { v: `${fpsEma ? fpsEma.toFixed(0) : '—'} fps`, keep: 4,
        c: fpsEma && fpsEma < 30 ? C.bad : C.chromeDim },
      { v: `render ${median(renderTimes).toFixed(1)} ms`, keep: 2 },
    ];
    if (!zones.strip && layout) {
      row2.push({ v: `${fmt(members[PANE_NONE].length)} unpositioned`, keep: 5 });
    }
    if (compact) row2.push({ v: 'compact', keep: 6 });

    const draw = (items, y, px) => {
      ctx.font = FONT(px);
      const width = (it) => (it.k ? ctx.measureText(it.k).width + 5 : 0) + ctx.measureText(it.v).width;
      const sepW = ctx.measureText(' · ').width;
      let live = [...items];
      const total = () => live.reduce((a, it) => a + width(it), 0) + sepW * Math.max(0, live.length - 1);
      while (live.length > 1 && total() > avail) {
        let worst = 0;
        for (let i = 1; i < live.length; i++) if (live[i].keep < live[worst].keep) worst = i;
        live.splice(worst, 1);
      }
      let x = rect.x + GUTTER;
      for (let i = 0; i < live.length; i++) {
        const it = live[i];
        if (it.k) {
          text(it.k, x, y, C.key, px);
          x += ctx.measureText(it.k).width + 5;
        }
        text(it.v, x, y, it.c || (px > 9 ? C.text : C.chromeDim), px);
        x += ctx.measureText(it.v).width;
        if (i < live.length - 1) {
          text(' · ', x, y, px > 9 ? '#3a3a3a' : '#2a2a2a', px);
          x += sepW;
        }
      }
    };
    draw(row1, y1, 11);
    draw(row2, y2, 9);
  }

  return {
    /** Setting canvas.width resets 2D context state, so the shell writes the backing
     *  store first and this is the cue to rebuild transforms (§5.3). */
    resize(g) {
      geo = g;
      ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
      rebuild();
    },

    /** Must return promptly and must not draw — at ~19 Hz in and ~60 fps out the same
     *  snapshot is rendered about three times. All accumulation happens here, once per
     *  received frame; `render` only composites. */
    push(s) {
      snapshot = s;
      if (!s || s.step === lastStep) return;
      lastStep = s.step;
      const now = performance.now();
      if (lastFrameMs > -Infinity) {
        const dt = now - lastFrameMs;
        if (dt > 0 && dt < 2000) framePeriodMs += (dt - framePeriodMs) * 0.2;
      }
      lastFrameMs = now;
      nextGapMs = now + framePeriodMs * STALL_FACTOR;

      rate.observe(s);
      const bytes = s.spikes.bytes;
      panes[PANE_BRAIN].push(bytes);
      panes[PANE_VNC].push(bytes);
      panes[PANE_NONE].push(bytes);
      raster.push(s.regions || {});
      dopamine.push(s.reward);
      dn?.push(s.descending?.active, now);
    },

    render(now = performance.now()) {
      const t0 = performance.now();
      if (frameTimes.length) {
        const dt = t0 - frameTimes[frameTimes.length - 1];
        if (dt > 0) fpsEma = fpsEma ? fpsEma + (1000 / dt - fpsEma) / FPS_WINDOW : 1000 / dt;
      }
      frameTimes.push(t0);
      if (frameTimes.length > FPS_WINDOW) frameTimes.shift();

      if (!zones) zones = computeZones();

      // A link that stopped delivering keeps the time axis true: gap columns, and the
      // map's decay keeps running so activity visibly fades to floor. Nothing freezes.
      while (t0 >= nextGapMs) {
        raster.pushGap();
        panes[PANE_BRAIN].decayOnly();
        panes[PANE_VNC].decayOnly();
        panes[PANE_NONE].decayOnly();
        nextGapMs += Math.max(16, framePeriodMs);
      }

      const { cssW: w, cssH: h } = geo;
      ctx.fillStyle = C.ground;
      ctx.fillRect(0, 0, w, h);

      renderHeader(zones.header);

      if (layout) {
        zoneTitle(zones.brain, 'BRAIN', `optic lobes + central brain · ${fmt(members[PANE_BRAIN].length)} positioned`);
        panes[PANE_BRAIN].blit(ctx, Math.round(zones.brainFit.x * geo.dpr),
                               Math.round(zones.brainFit.y * geo.dpr));
        scaleBar(zones.brainFit, layout.paneUm[PANE_BRAIN]);
        if (zones.vncFit) {
          if (!zones.vncInset) zoneTitle(zones.vnc, 'VNC', `${fmt(members[PANE_VNC].length)}`);
          panes[PANE_VNC].blit(ctx, Math.round(zones.vncFit.x * geo.dpr),
                               Math.round(zones.vncFit.y * geo.dpr));
          if (zones.vncInset) {
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            ctx.strokeRect(zones.vncFit.x - 0.5, zones.vncFit.y - 0.5,
                           zones.vncFit.w + 1, zones.vncFit.h + 1);
          }
          scaleBar(zones.vncFit, layout.paneUm[PANE_VNC]);
        }
        dn.renderMarkers(ctx, now, project);
        dn.renderRings(ctx, now, project);
        if (zones.strip) renderStrip(zones.strip);
      } else {
        text(layoutError, zones.brain.x + zones.brain.w / 2,
             zones.brain.y + zones.brain.h / 2, C.warn, 10, 'center');
      }

      if (!dn) {
        // Never silently absent. Descending identity — type names, sides, the game
        // channels — lives entirely in the layout artifact, so without it the chips
        // would have to invent labels. Saying why beats both a blank and a guess.
        zoneTitle(zones.dn, 'DESCENDING', '— identity unavailable without the layout artifact');
      } else {
        zoneTitle(zones.dn, 'DESCENDING',
          `${fmt(dn.count)} · ${dn.wired} wired to game · ${dn.unpositioned} unpositioned`);
        const inner = { x: zones.dn.x + GUTTER, y: zones.dn.y + 20,
                        w: zones.dn.w - 2 * GUTTER, h: zones.dn.h - 20 };
        dn.renderChips(ctx, inner, snapshot?.descending, now);
        if (!zones.drop.dnTicks && inner.h > 56) {
          dn.renderStrip(ctx, { x: inner.x, y: inner.y + 52, w: inner.w,
                                h: Math.max(8, inner.h - 56) }, now);
        }
      }

      if (zones.raster && !layout) {
        zoneTitle(zones.raster, 'POPULATION RASTER',
          '— class sizes unavailable without the layout artifact');
      } else if (zones.raster) {
        const windowSec = raster.columns / (1000 / framePeriodMs);
        zoneTitle(zones.raster, 'POPULATION RASTER', `${ROWS.length} rows · ${windowSec.toFixed(1)} s`);
        raster.render(ctx, { x: zones.raster.x + GUTTER, y: zones.raster.y + 20,
                             w: zones.raster.w - 2 * GUTTER, h: zones.raster.h - 20 },
                      { gutter: zones.rasterGutter, windowSec,
                        labels: zones.drop.classLabels ? 'group' : 'class',
                        axis: !zones.drop.axisLabels });
      }

      zoneTitle(zones.dop, 'DOPAMINE', '');
      dopamine.render(ctx, { x: zones.dop.x + GUTTER, y: zones.dop.y + 16,
                             w: zones.dop.w - 2 * GUTTER, h: zones.dop.h - 16 },
                      zones.drop.dopamineBar ? 'bar' : zones.drop.dopamineCompact ? 'compact' : 'full',
                      ready.prosthetic_sites);

      renderFooter(zones.footer);

      // Zone separators last, so nothing overdraws them.
      ctx.fillStyle = C.rule;
      for (const yy of [zones.brain.y + zones.brain.h + 3, zones.mid.y + zones.mid.h + 1,
                        zones.dop.y - 2, zones.footer.y]) {
        ctx.fillRect(0, Math.round(yy), w, 1);
      }
      if (zones.vnc.w) ctx.fillRect(Math.round(zones.vnc.w + 1), zones.mid.y, 1, zones.mid.h);

      if (conn === 'idle') {
        ctx.strokeStyle = C.bad;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      }
      if (!snapshot) {
        text(conn === 'connecting' ? 'waiting for brain…' : 'no frames yet',
             w / 2, zones.mid.y + zones.mid.h / 2, C.key, 11, 'center');
      }

      const cost = performance.now() - t0;
      renderTimes.push(cost);
      if (renderTimes.length > FPS_WINDOW) renderTimes.shift();
    },

    setConnection(c) {
      conn = c;
    },

    destroy() {
      destroyed = true;
      snapshot = null;
      for (const p of Object.values(panes)) p.destroy();
      raster.destroy();
      dopamine.destroy();
      dn?.destroy();
      dn = null;
      layout = null;
      members = null;
      zones = null;
    },
  };
}
