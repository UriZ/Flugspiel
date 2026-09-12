// Packed spike vector decode — #5 §6.2. The ONLY place bit order is expressed.
//
// `np.packbits` is big-endian within each byte: neuron `i` is bit `7 - (i & 7)` of
// byte `i >> 3`. Getting this backwards produces a wrong-but-plausible neuron map
// that nothing errors on (#5 R6), so it is written once, here, and nowhere else.

const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

/**
 * Decode `snapshot.spikes` and count set bits in one pass.
 *
 * The padding bits are counted too and that is safe: `packbits` zero-pads, and at
 * n = 166,700 the tail is 4 zero bits in the last of 20,838 bytes.
 *
 * @param {{n: number, bits: string}} sp
 * @returns {{n: number, bytes: Uint8Array, popcount: number}}
 * @throws {DOMException} from `atob` on malformed base64 — the caller counts a bad frame.
 */
export function decodeSpikes(sp) {
  const bin = atob(sp.bits);
  const bytes = new Uint8Array(bin.length);
  let popcount = 0;
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    bytes[i] = b;
    popcount += POPCOUNT[b];
  }
  return { n: sp.n, bytes, popcount };
}

/**
 * Expand packed bits into `out[0 .. n)`. **Not called by #5** — exported because §5's
 * panel contract promises it to #6. The caller supplies and reuses `out`; allocating a
 * 166,700-element array per frame is exactly what this signature exists to avoid.
 *
 * @param {Uint8Array} bytes @param {number} n @param {Uint8Array} out length >= n
 */
export function unpackInto(bytes, n, out) {
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}
