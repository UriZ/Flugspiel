// Dopamine / reward — #6 §8.
//
// This zone shows a measured neural event and nothing else. #7 has established that the
// reward loop cannot change gameplay, so nothing drawn here may read as evidence of
// improvement: no trend line, no moving average, no best-so-far, no arrows. The trace is
// `cumulative`, the running sum of signed event magnitudes, labelled as exactly that.
//
// The state that matters most today is `source: "unimplemented"`, which is what the
// server actually emits — #6 ships before #7 lands. Without that branch this zone would
// draw a plausible, permanently-flat trace over a field that means "nobody has written
// this yet", which is a placeholder presented as a measurement.
//
// The bars are labelled by neuron name, never "good"/"bad": the green/red mapping is the
// project's engineered valence convention and is not the biological rule.

import { C, FONT } from './palette.js';

/** Not decoration. Anything in this list would assert something #7 has disproved. */
const FORBIDDEN = /\b(learn|learning|learned|train|training|trained|improv\w*|progress\w*|better|worse|performance|score)\b/i;

const CAPTION = {
  live: 'Injected dopamine and synaptic efficacy. Not evidence of learning.',
  off: 'Reward loop disabled — no dopamine injected, no weight change. Control condition.',
  unimplemented: '#7 not implemented — this zone has no data source yet.',
  nodata: 'Injected dopamine and synaptic efficacy. Not evidence of learning.',
};

/** The caption is normative text; a typo that drifted into a claim would defeat the
 *  point of having one. The check runs on the word "learning" in the live caption by
 *  design — it appears there only inside "Not evidence of learning". */
export function captionIsSafe(text) {
  return text === CAPTION.live || !FORBIDDEN.test(text);
}

const DEFAULT_POINTS = 600;

export function createDopamine() {
  // The ring is sized to the raster's column count so the two share a time window and
  // a column width exactly: reading which population burst coincided with a punish
  // event is the only honest thing this zone offers, and it needs the x axes to agree.
  let points = DEFAULT_POINTS;
  let cum = new Float32Array(points);
  let evt = new Int8Array(points);               // -1 punish, +1 reward, 2 mixed
  let brk = new Uint8Array(points);              // 1 = session boundary at this column
  let head = -1;
  let filled = 0;
  let counts = { reward: 0, punish: 0 };
  let last = null;

  /**
   * `unimplemented` and `disabled` are DIFFERENT states and must never render alike.
   *
   *   unimplemented — the reward loop does not exist in this build. Nobody wrote it.
   *                   This is what #4 emits today and what ships if #7 lands after #6.
   *   disabled      — the loop exists and is switched off. That is AC5's CONTROL
   *                   condition, the thing every learning claim is measured against.
   *                   "The control is running" is a result; "nobody built it" is not.
   *
   * `source` is authoritative for both. `enabled: false` is #7's flag and is honoured
   * too, but a `source` of `disabled` means the control condition whatever the flag
   * says — the field that names the state outranks the field that summarises it.
   */
  const stateOf = (r) => {
    // No reward object has ever arrived. Distinct from "the loop is running and has
    // nothing to report": before the first frame this zone has no data source at all,
    // and drawing its full live treatment would present empty bars as measurements.
    if (!r) return 'nodata';
    if (r.source === 'unimplemented') return 'unimplemented';
    if (r.source === 'disabled' || r.enabled === false) return 'off';
    // A block that names no source is an ABSENT block, not a running loop with nothing
    // to report. #7's telemetry always names its source, `"none"` included, and the
    // client substitutes `{}` for a missing one — so treating a nameless object as
    // `idle` renders "the block is missing" as "the loop is alive and quiet".
    if (typeof r.source !== 'string') return 'nodata';
    if (r.source === 'none') return 'idle';
    return 'live';
  };

  return {
    get state() { return stateOf(last); },
    get columns() { return points; },

    /** Match the raster's plot, so both zones scroll on the same clock. */
    resize(cols) {
      const next = Math.max(8, cols | 0);
      if (next === points) return;
      points = next;
      cum = new Float32Array(points);
      evt = new Int8Array(points);
      brk = new Uint8Array(points);
      head = -1;
      filled = 0;
    },

    push(reward) {
      last = reward || null;
      if (!last || stateOf(last) === 'unimplemented') return;
      head = (head + 1) % points;
      filled = Math.min(points, filled + 1);
      cum[head] = Number.isFinite(last.cumulative) ? last.cumulative : 0;
      const s = last.source;
      evt[head] = s === 'mixed' ? 2 : s === 'punish' ? -1 : s === 'reward' ? 1 : 0;
      brk[head] = last.session_changed ? 1 : 0;
      const e = last.events || {};
      if (Number.isFinite(e.reward)) counts.reward = e.reward;
      if (Number.isFinite(e.punish)) counts.punish = e.punish;
    },

    /**
     * @param {{x,y,w,h}} rect
     * @param {'full'|'compact'|'bar'} mode from the degradation ladder
     */
    render(ctx, rect, mode, prostheticSites) {
      const st = stateOf(last);
      const dim = st === 'off' || st === 'unimplemented' || st === 'nodata';
      const caption = CAPTION[st] || CAPTION.live;

      ctx.save();
      if (dim) ctx.globalAlpha = 0.4;

      // Amber for "never built", grey for "built and switched off". The colours carry
      // the distinction as well as the words, because the words get truncated first.
      const chip = st === 'unimplemented' ? ['NOT IMPLEMENTED', C.warn]
        : st === 'off' ? ['LOOP OFF — CONTROL', C.key]
        : st === 'nodata' ? ['NO DATA', C.key]
        : st === 'idle' ? ['NO EVENTS', C.key] : null;

      const splitX = rect.x + 218;
      const plotX = mode === 'full' ? splitX + 10 : rect.x;
      const plotW = Math.max(20, rect.x + rect.w - plotX);

      if (mode === 'full' && st !== 'unimplemented' && st !== 'nodata') {
        this._renderBars(ctx, rect, prostheticSites);
      }

      const capY = mode === 'bar' ? rect.y + 2 : rect.y + rect.h - 4;
      if (mode !== 'bar') {
        const plotY = rect.y + (mode === 'full' ? 20 : 14);
        const plotH = Math.max(10, capY - 12 - plotY);
        // The trace is HIDDEN, not flattened, when there is no source. A flat line at
        // zero reads as "no events happened", which is a different claim from "this is
        // not running" and from "this was never built".
        if (!dim) this._renderTrace(ctx, plotX, plotY, plotW, plotH);
        else {
          ctx.strokeStyle = '#222';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(plotX, plotY + plotH / 2);
          ctx.lineTo(plotX + plotW, plotY + plotH / 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      ctx.font = FONT(9);
      ctx.textAlign = 'right';
      const counterText = `+${counts.reward} / -${counts.punish}`;
      ctx.fillStyle = C.key;
      if (!dim) ctx.fillText(counterText, rect.x + rect.w, rect.y + 9);
      if (Number.isFinite(last?.anomalies) && last.anomalies > 0) {
        ctx.fillStyle = C.bad;
        ctx.fillText(`anomaly ${last.anomalies}`, rect.x + rect.w, rect.y + 20);
      }
      ctx.textAlign = 'left';

      if (chip) {
        ctx.font = FONT(9);
        ctx.fillStyle = chip[1];
        // Beside the zone title, never at the left block's origin: that is where the
        // PAM11 bar's label lives and two 9px strings would print on top of each other.
        ctx.fillText(chip[0], rect.x + 78, rect.y + (mode === 'bar' ? 2 : -4));
      }

      // The caption is normative and must never be half-drawn over something else.
      // If it does not fit it is truncated; if the zone cannot hold a line at all the
      // chip still carries the state, which is the part that must not be lost.
      ctx.font = FONT(9);
      ctx.fillStyle = C.key;
      const chipW = chip ? ctx.measureText(chip[0]).width : 0;
      const capX = mode === 'bar' ? rect.x + 78 + chipW + 10 : rect.x;
      const room = rect.x + rect.w - capX;
      if (rect.h >= 14 || mode === 'bar') {
        let out = caption;
        if (ctx.measureText(out).width > room) {
          while (out.length > 1 && ctx.measureText(`${out}…`).width > room) out = out.slice(0, -1);
          out += '…';
        }
        ctx.fillText(out, capX, capY);
      }
      ctx.restore();
    },

    _renderBars(ctx, rect, prostheticSites) {
      const d = last?.dopamine || {};
      const c = last?.compartments || {};
      const x = rect.x;
      let y = rect.y + 10;
      const bar = (label, value, colour) => {
        ctx.font = FONT(9);
        ctx.fillStyle = C.key;
        ctx.fillText(label, x, y);
        ctx.fillStyle = C.rule;
        ctx.fillRect(x + 52, y - 7, 100, 8);
        const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
        ctx.fillStyle = colour;
        ctx.fillRect(x + 52, y - 7, 100 * v, 8);
        ctx.font = FONT(10);
        ctx.fillStyle = C.text;
        ctx.fillText(Number.isFinite(value) ? value.toFixed(3) : '—', x + 158, y);
        y += 16;
      };
      bar('PAM11', d.PAM11, C.ok);
      bar('PPL101', d.PPL101, C.bad);

      ctx.font = FONT(9);
      ctx.fillStyle = C.key;
      ctx.fillText('KC→MBON efficacy (w/w0)', x, y);
      y += 13;
      const eff = (label, value, dx) => {
        ctx.font = FONT(10);
        ctx.fillStyle = C.text;
        ctx.fillText(`${label} ${Number.isFinite(value) ? value.toFixed(3) : '—'}`, x + dx, y);
        const cx = x + dx + 4;
        ctx.fillStyle = C.rule;
        ctx.fillRect(cx, y + 4, 60, 4);
        if (Number.isFinite(value)) {
          const dev = Math.max(-1, Math.min(1, (value - 1) * 8));
          ctx.fillStyle = dev >= 0 ? C.ok : C.bad;
          if (dev >= 0) ctx.fillRect(cx + 30, y + 4, 30 * dev, 4);
          else ctx.fillRect(cx + 30 + 30 * dev, y + 4, -30 * dev, 4);
        }
      };
      eff('reward', c.reward, 0);
      eff('punish', c.punish, 104);
      y += 22;

      // #7 puts the disclosure INSIDE the reward object so a logged `value` can never
      // be separated from it; prefer that over `ready`, which is only the fallback for
      // a frame that predates the loop.
      const inner = last?.prosthetic_sites;
      const sites = Array.isArray(inner) ? inner : Array.isArray(prostheticSites) ? prostheticSites : null;
      ctx.font = FONT(9);
      // #7 returns ["unknown"], never []. An empty INNER list would read as "no
      // prosthesis", which is a false statement rather than a missing one — so it is
      // surfaced as the fault it is instead of being rendered as clean.
      //
      // The rule is about the inner field only. `ready.prosthetic_sites` is the enabled
      // sites with a prosthesis, and `[]` there is the honest answer when none is
      // enabled; calling that a bug is the mirror image of the error above.
      const broken = Array.isArray(inner) && inner.length === 0;
      ctx.fillStyle = broken ? C.bad : C.prosthetic;
      const text = broken ? 'prosthesis: EMPTY LIST — disclosure missing (bug)'
        : sites === null ? 'prosthesis: not reported'
        : sites.length === 0 ? 'prosthesis: none enabled'
        : `prosthesis: ${sites.join(' ')}`;
      const words = text.split(' ');
      let line = '';
      for (const w of words) {
        if (ctx.measureText(`${line}${w} `).width > 208 && line) {
          ctx.fillText(line.trim(), x, y);
          y += 11;
          line = '';
        }
        line += `${w} `;
      }
      if (line.trim()) ctx.fillText(line.trim(), x, y);
    },

    _renderTrace(ctx, x, y, w, h) {
      ctx.fillStyle = '#222';
      ctx.fillRect(x, y + h / 2, w, 1);
      if (!filled) return;
      let peak = 0;
      for (let i = 0; i < filled; i++) peak = Math.max(peak, Math.abs(cum[i]));
      const range = Math.max(4, Math.ceil(peak));
      const colW = w / points;
      const yOf = (v) => y + h / 2 - (v / range) * (h / 2 - 2);

      ctx.strokeStyle = C.chrome;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let c = 0; c < filled; c++) {
        const idx = (head - (filled - 1 - c) + points * 2) % points;
        const px = x + w - (filled - c) * colW;
        // The path BREAKS at a resync. #7 discards reward across a session change
        // rather than differencing through it, so `cumulative` restarts; a connecting
        // segment would draw that discontinuity as a slope, which is a false reading.
        if (brk[idx]) {
          if (pen) ctx.stroke();
          ctx.beginPath();
          pen = false;
        }
        if (!pen) { ctx.moveTo(px, yOf(cum[idx])); pen = true; } else ctx.lineTo(px, yOf(cum[idx]));
      }
      if (pen) ctx.stroke();

      for (let c = 0; c < filled; c++) {
        const idx = (head - (filled - 1 - c) + points * 2) % points;
        const px = x + w - (filled - c) * colW;
        if (brk[idx]) {
          ctx.strokeStyle = C.warn;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(px, y);
          ctx.lineTo(px, y + h);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = FONT(9);
          ctx.fillStyle = C.warn;
          ctx.fillText('session', px + 2, y + 8);
        }
        const e = evt[idx];
        if (!e) continue;
        if (e === 1 || e === 2) {
          ctx.fillStyle = C.ok;
          ctx.fillRect(px, y + h / 2 - 6, 1, 6);
        }
        if (e === -1 || e === 2) {
          ctx.fillStyle = C.bad;
          ctx.fillRect(px, y + h / 2, 1, 6);
        }
      }

      // Named, not merely ranged. An unlabelled rising line over green ticks is the one
      // affordance in this zone a viewer is most likely to over-read, and the caption
      // denies a claim the line never made. It is a running sum of signed magnitudes and
      // says so; `Σ` is the fallback only when the plot is too narrow for the word.
      ctx.font = FONT(9);
      ctx.fillStyle = C.chromeDim;
      const label = `cumulative ±${range}`;
      ctx.fillText(ctx.measureText(label).width <= w - 4 ? label : `Σ ±${range}`, x + 2, y + 8);
    },

    destroy() { head = -1; filled = 0; last = null; counts = { reward: 0, punish: 0 }; },
  };
}
