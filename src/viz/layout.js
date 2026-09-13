// The static layout artifact — #6 §3.6. Parses `assets/viz-layout.bin`.
//
// Built by `tools/build-viz-layout.py`; the binary layout is documented in that file's
// docstring and the two must be changed together. Every field is read through a typed
// array view over the same ArrayBuffer, so nothing here copies a megabyte.
//
// The panel must refuse to draw the map rather than draw a wrong one: a stale artifact
// whose `n` disagrees with `ready.n` would silently paint one neuron's activity at
// another's coordinate, which looks entirely plausible and is false. `validate()` is
// what makes that a visible failure instead.

const MAGIC = 'FSVIZL';
const VERSION = 2;
const HEADER_BYTES = 72;

export const PANE_BRAIN = 0;
export const PANE_VNC = 1;
export const PANE_NONE = 2;
export const SEG_OTHER = 255;
const ROLE_PROSTHESIS = 1;

/** Default location, resolved against this module so it survives any mount path. */
export const layoutUrl = () => new URL('../../assets/viz-layout.bin', import.meta.url).href;

/**
 * @param {ArrayBuffer} buf
 * @returns {object} the parsed artifact
 * @throws {Error} on a bad magic, an unknown version, or a truncated body
 */
export function parseLayout(buf) {
  if (buf.byteLength < HEADER_BYTES) throw new Error(`layout: ${buf.byteLength} bytes is not a header`);
  const head = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 6));
  if (magic !== MAGIC) throw new Error(`layout: magic "${magic}" is not ${MAGIC}`);
  const version = head.getUint16(6, true);
  if (version !== VERSION) throw new Error(`layout: version ${version}, expected ${VERSION}`);

  const n = head.getUint32(8, true);
  const nSuper = head.getUint32(12, true);
  const nDn = head.getUint32(16, true);
  const nDnType = head.getUint32(20, true);
  const nSeg = head.getUint32(24, true);
  const dnCols = head.getUint32(28, true);
  const namesBytes = head.getUint32(32, true);
  const nMark = head.getUint32(36, true);
  const nGrp = head.getUint32(40, true);
  const paneAspect = new Float32Array(buf.slice(44, 56));
  const paneUm = new Float32Array(buf.slice(56, 68));

  let off = HEADER_BYTES;
  const take = (Ctor, count) => {
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    if (off + bytes > buf.byteLength) throw new Error('layout: truncated');
    const a = new Ctor(buf, off, count);
    off += bytes;
    off += (4 - (off % 4)) % 4;         // the generator 4-aligns every array
    return a;
  };

  const uv = take(Uint16Array, 2 * n);
  const dnSlot = take(Uint32Array, nDn);
  const segCount = take(Uint32Array, nSeg);
  const segU0 = take(Float32Array, nSeg);
  const segU1 = take(Float32Array, nSeg);
  const markIdx = take(Uint32Array, nMark);
  const grpOff = take(Uint32Array, nGrp);
  const grpCount = take(Uint32Array, nGrp);
  const dnType = take(Uint16Array, nDn);
  const dnCol = take(Uint16Array, nDn);
  const grpName = take(Uint16Array, nGrp);
  const pane = take(Uint8Array, n);
  const superIdx = take(Uint8Array, n);
  const dnSide = take(Uint8Array, nDn);
  const segSuper = take(Uint8Array, nSeg);
  const grpRole = take(Uint8Array, nGrp);
  const grpEnabled = take(Uint8Array, nGrp);
  const grpSide = take(Uint8Array, nGrp);

  if (off + namesBytes > buf.byteLength) throw new Error('layout: truncated name table');
  const names = new TextDecoder().decode(new Uint8Array(buf, off, namesBytes)).split('\0');
  const classNames = names.slice(0, nSuper);
  const dnTypeNames = names.slice(nSuper, nSuper + nDnType);
  const groupNames = names.slice(nSuper + nDnType, nSuper + nDnType + nGrp);
  if (classNames.length !== nSuper || dnTypeNames.length !== nDnType
      || groupNames.length !== nGrp) {
    throw new Error('layout: name table is short');
  }

  // Marked groups, resolved into something the zones can read directly. `enabled` is
  // the mapping's own switch: a group that is declared and off must not be drawn as a
  // group that merely is not firing.
  const groups = [];
  for (let g = 0; g < nGrp; g++) {
    groups.push({
      name: groupNames[grpName[g]],
      role: grpRole[g] === ROLE_PROSTHESIS ? 'prosthesis' : 'readout',
      enabled: grpEnabled[g] === 1,
      side: ['L', 'R', 'M', ''][grpSide[g]],
      neurons: markIdx.subarray(grpOff[g], grpOff[g] + grpCount[g]),
    });
  }

  return { version, n, nSeg, dnCols, paneAspect, paneUm, uv, dnSlot, dnType, dnCol,
           dnSide, pane, superIdx, segCount, segU0, segU1, segSuper,
           classNames, dnTypeNames, groups };
}

/**
 * The artifact is only usable if it describes the brain the server is running.
 * @returns {string|null} a human-readable reason, or null when it is usable
 */
export function validate(layout, ready) {
  if (!layout) return 'brain layout unavailable — map disabled';
  if (!ready || !Number.isFinite(ready.n)) return 'brain layout unverified — map disabled';
  if (layout.n !== ready.n) {
    return `layout n=${layout.n.toLocaleString()} ≠ brain n=${ready.n.toLocaleString()} — map disabled`;
  }
  return null;
}

/** Fetch and parse; resolves to null (never rejects) so a missing artifact degrades. */
export async function loadLayout(url = layoutUrl()) {
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseLayout(await res.arrayBuffer());
  } catch (e) {
    console.warn(`viz layout unavailable (${e.message}) — map disabled`);
    return null;
  }
}

/**
 * Isotropic contain-fit of a pane's bbox into a rect. Letterboxed and centred; the
 * anatomy is never stretched by a panel resize, so an asymmetry on screen is real.
 * @returns {{x:number,y:number,w:number,h:number,scale:number}} in the rect's units
 */
export function containFit(rect, aspect) {
  const inset = 2;
  const availW = Math.max(1, rect.w - 2 * inset);
  const availH = Math.max(1, rect.h - 2 * inset);
  let w = availW;
  let h = w / aspect;
  if (h > availH) { h = availH; w = h * aspect; }
  return { x: rect.x + inset + (availW - w) / 2, y: rect.y + inset + (availH - h) / 2, w, h };
}
