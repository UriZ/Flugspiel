// Descending neurons — #6 §6. The output path from brain to game.
//
// `descending.active` is a list of slots 0..1313 with no names attached, so every label
// in this zone comes from the layout artifact's DN tables. The slots are not equal:
// exactly 12 of the 1,314 are wired to the game, and the design's job is to show that
// rather than present 1,314 identical ticks.
//
// Two honesty rules are enforced here, both driven from the artifact's `enabled` flag
// rather than assumed:
//
//   * a channel the mapping switches OFF is drawn dimmed with a literal `disabled`
//     suffix. `weapon` cannot fire at all, and it must not look like a channel that
//     merely is not firing right now.
//   * a prosthetic site is magenta and dashed wherever it appears. Those neurons are
//     driven by injection, not by the brain deciding anything, and a viewer who saw
//     them fire in amber alongside DNp01 would reasonably conclude otherwise.

import { C, FONT } from './palette.js';

const PULSE_MS = 300;
const DECAY_MS = 300;

/** Group label -> the artifact group names it is composed of, in display order. */
const CHANNELS = [
  { label: 'AIM', groups: ['aim_L', 'aim_R'], value: (t) => (Number.isFinite(t.aim_index) ? `idx ${t.aim_index >= 0 ? '+' : ''}${t.aim_index.toFixed(2)}` : null) },
  { label: 'FIRE', groups: ['fire'], value: (t) => (Number.isFinite(t.fire_hz) ? `${t.fire_hz.toFixed(1)} Hz` : null) },
  { label: 'WEAPON', groups: ['weapon'], value: (t) => (Number.isFinite(t.weapon_hz) ? `${t.weapon_hz.toFixed(1)} Hz` : null) },
  { label: 'BIAS', groups: ['weapon_bias'], value: () => null },
];

export function createDescending(layout) {
  const nDn = layout.dnSlot.length;
  const slotOf = new Map();
  for (let k = 0; k < nDn; k++) slotOf.set(layout.dnSlot[k], k);

  // Per-slot last-active timestamp drives both the tick decay and the readout pulse.
  const lastMs = new Float64Array(nDn).fill(-Infinity);
  const prevActive = new Uint8Array(nDn);
  const edgeMs = new Float64Array(nDn).fill(-Infinity);

  const chan = CHANNELS.map((c) => {
    const groups = c.groups.map((g) => layout.groups.find((x) => x.name === g)).filter(Boolean);
    const slots = [];
    for (const g of groups) for (const i of g.neurons) if (slotOf.has(i)) slots.push(slotOf.get(i));
    return {
      ...c,
      slots,
      // A channel is off if every group backing it is off. `weapon` and `weapon_bias`
      // are both off in the shipped mapping.
      enabled: groups.length > 0 && groups.some((g) => g.enabled),
      prosthesis: groups.some((g) => g.role === 'prosthesis'),
      type: slots.length ? layout.dnTypeNames[layout.dnType[slots[0]]] : '—',
    };
  });

  /** Every slot that is a game readout or a prosthesis, for the map's ring pass. */
  const marked = new Map();
  for (const g of layout.groups) {
    for (const i of g.neurons) {
      const prev = marked.get(i);
      // Prosthesis wins over readout: the injection is the more important disclosure.
      if (!prev || (g.role === 'prosthesis' && prev.role !== 'prosthesis')) {
        marked.set(i, { role: g.role, enabled: g.enabled, name: g.name });
      }
    }
  }

  let unpositioned = 0;
  for (let k = 0; k < nDn; k++) if (layout.pane[layout.dnSlot[k]] === 2) unpositioned++;

  return {
    get count() { return nDn; },
    get unpositioned() { return unpositioned; },
    get markedNeurons() { return marked; },
    /** Descending neurons wired to the game. NOT `marked.size`: the prosthetic aim
     *  sites are 24 PFL3, which are central-brain neurons and not descending at all,
     *  so counting them here would overstate this zone's own population. */
    get wired() {
      let k = 0;
      for (const i of marked.keys()) if (slotOf.has(i)) k++;
      return k;
    },

    /** Called once per received frame. */
    push(active, nowMs) {
      for (let k = 0; k < nDn; k++) prevActive[k] = 0;
      if (Array.isArray(active)) {
        for (const s of active) {
          if (s >= 0 && s < nDn) { lastMs[s] = nowMs; prevActive[s] = 1; }
        }
      }
      // Rising edges only — the readout pulse is one per activation, not one per frame.
      for (let k = 0; k < nDn; k++) if (prevActive[k] && nowMs - edgeMs[k] > PULSE_MS) edgeMs[k] = nowMs;
    },

    /** 0..1 afterglow for a slot, so a 52 ms spike stays visible for ~300 ms. */
    glow(slot, nowMs) {
      const dt = nowMs - lastMs[slot];
      return dt < 0 || dt > DECAY_MS ? 0 : 1 - dt / DECAY_MS;
    },

    /** Markers at real soma positions, drawn after the map's putImageData. Bounded by
     *  1,314 regardless of firing rate — three orders below the per-neuron fillRect
     *  pass the spike measured at 65.8 ms. */
    renderMarkers(ctx, nowMs, project) {
      ctx.save();
      for (let k = 0; k < nDn; k++) {
        const g = this.glow(k, nowMs);
        if (g <= 0) continue;
        const i = layout.dnSlot[k];
        const p = project(i);
        if (!p) continue;                        // unpositioned, or its pane is hidden
        ctx.globalAlpha = g;
        ctx.fillStyle = C.dn;
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    },

    /** Rings on the neurons wired to the game — always drawn, active or not, so their
     *  position is findable when they are silent. */
    renderRings(ctx, nowMs, project) {
      ctx.save();
      ctx.lineWidth = 1;
      for (const [i, m] of marked) {
        const p = project(i);
        if (!p) continue;
        const slot = slotOf.get(i);
        const g = slot === undefined ? 0 : this.glow(slot, nowMs);
        const pros = m.role === 'prosthesis';
        if (pros) {
          ctx.strokeStyle = C.prosthetic;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = pros ? C.prosthetic : (g > 0 ? C.dnReadout : '#4a4a4a');
        ctx.lineWidth = g > 0 && !pros ? 2 : 1;
        ctx.globalAlpha = m.enabled ? 1 : 0.45;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.stroke();
        // One expanding pulse per activation edge.
        if (slot !== undefined) {
          const dt = nowMs - edgeMs[slot];
          if (dt >= 0 && dt < PULSE_MS) {
            const t = dt / PULSE_MS;
            ctx.globalAlpha = 0.35 * (1 - t) * (m.enabled ? 1 : 0.45);
            ctx.strokeStyle = pros ? C.prosthetic : C.dnReadout;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4.5 + 2 * t, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    },

    /** Row A — the readout chips. Four labelled groups, one square per neuron. */
    renderChips(ctx, rect, telemetry, nowMs) {
      const t = telemetry || {};
      const colW = rect.w / CHANNELS.length;
      const inner = Math.max(20, colW - 6);
      // Every string is truncated to its own column. Four labels that each overflow by
      // a few pixels produce one unreadable row, not four slightly clipped ones.
      const clip = (str, px) => {
        ctx.font = FONT(px);
        if (ctx.measureText(str).width <= inner) return str;
        let out = str;
        while (out.length > 1 && ctx.measureText(`${out}…`).width > inner) out = out.slice(0, -1);
        return `${out}…`;
      };
      for (let c = 0; c < chan.length; c++) {
        const ch = chan[c];
        const x = rect.x + c * colW;
        ctx.save();
        ctx.globalAlpha = ch.enabled ? 1 : 0.45;

        ctx.font = FONT(9);
        ctx.fillStyle = ch.prosthesis ? C.prosthetic : C.key;
        const suffix = ch.prosthesis
          ? (ch.enabled ? ' injected' : ' pros. off')
          : (ch.enabled ? '' : ' disabled');
        const head = clip(ch.label + suffix, 9);
        ctx.font = FONT(9);
        ctx.fillText(head, x, rect.y + 9);
        const headW = ctx.measureText(head).width;

        ctx.fillStyle = C.text;
        ctx.fillText(clip(ch.type, 10), x, rect.y + 22);

        const sq = Math.max(4, Math.min(9, Math.floor((inner - 4) / Math.max(1, ch.slots.length)) - 3));
        const half = ch.slots.length > 1 ? Math.ceil(ch.slots.length / 2) : ch.slots.length;
        for (let s = 0; s < ch.slots.length; s++) {
          const gx = x + s * (sq + 3) + (s >= half ? 4 : 0);
          const g = this.glow(ch.slots[s], nowMs);
          ctx.fillStyle = g > 0 ? C.dnReadout : C.idle;
          ctx.globalAlpha = (ch.enabled ? 1 : 0.45) * (g > 0 ? 0.35 + 0.65 * g : 1);
          ctx.fillRect(gx, rect.y + 27, sq, sq);
        }
        ctx.globalAlpha = ch.enabled ? 1 : 0.45;
        if (ch.slots.length > 1 && half < ch.slots.length) {
          ctx.fillStyle = '#2a2a2a';
          ctx.fillRect(x + half * (sq + 3) + 1, rect.y + 27, 1, sq);
        }

        const val = ch.value(t);
        ctx.fillStyle = C.key;
        ctx.fillText(clip(val ?? '—', 9), x, rect.y + 46);

        if (ch.prosthesis) {         // the group is boxed so the dash reads as a unit
          ctx.strokeStyle = C.prosthetic;
          ctx.setLineDash([2, 2]);
          ctx.globalAlpha = 0.7;
          const boxW = Math.min(inner, Math.max(headW + 8, 60));
          ctx.strokeRect(x - 3.5, rect.y - 1.5, boxW, 51);
          ctx.setLineDash([]);
        }
        ctx.restore();
      }
    },

    /** Row B — all 1,314 as ticks. L above the midline, R below, midline neurons in
     *  their own block at the right. A type's L and R share a column, so bilateral
     *  firing reads as a vertical pair and unilateral firing as a single tick. */
    renderStrip(ctx, rect, nowMs) {
      const mCount = layout.dnSide.reduce((a, s) => a + (s === 2 ? 1 : 0), 0);
      const mW = mCount ? 14 : 0;
      const plotW = Math.max(1, rect.w - mW - 6);
      const tickW = Math.max(1, Math.floor(plotW / layout.dnCols));
      const half = Math.floor(rect.h / 2);
      const tickH = Math.max(3, half - 1);

      ctx.fillStyle = '#141414';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = '#222';
      ctx.fillRect(rect.x, rect.y + half, rect.w, 1);

      for (let k = 0; k < nDn; k++) {
        const side = layout.dnSide[k];
        const g = this.glow(k, nowMs);
        const i = layout.dnSlot[k];
        const m = marked.get(i);
        let x;
        let y;
        if (side === 2) {
          x = rect.x + plotW + 6 + (layout.dnCol[k] % mCount) * Math.max(1, mW / mCount);
          y = rect.y + 1;
        } else {
          // Columns accumulate with max when the pane is narrower than dnCols, never
          // overwrite — the same rule as the map's per-pixel accumulation.
          x = rect.x + Math.floor((layout.dnCol[k] * plotW) / layout.dnCols);
          y = side === 0 ? rect.y + 1 : rect.y + half + 2;
        }
        const h = side === 2 ? rect.h - 2 : tickH;
        if (g > 0) {
          ctx.globalAlpha = 0.35 + 0.65 * g;
          ctx.fillStyle = m && m.role === 'prosthesis' ? C.prosthetic : C.dn;
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = C.tickIdle;
        }
        ctx.fillRect(x, y, tickW, h);
        if (m) {                      // a cap so the wired 12 are findable when silent
          ctx.globalAlpha = m.enabled ? 1 : 0.5;
          ctx.fillStyle = m.role === 'prosthesis' ? C.prosthetic : C.dnReadout;
          ctx.fillRect(x, side === 1 ? y + h - 2 : y, Math.max(2, tickW), 2);
        }
      }
      ctx.globalAlpha = 1;

      if (mCount) {
        ctx.font = FONT(9);
        ctx.fillStyle = C.chromeDim;
        ctx.fillText('M', rect.x + plotW + 6, rect.y + rect.h + 9);
      }
    },

    destroy() { slotOf.clear(); marked.clear(); },
  };
}
