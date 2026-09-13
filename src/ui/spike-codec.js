// Packed spike vector decode — #5 §6.2. `spikeAt` is where bit order is expressed.
//
// `np.packbits` is big-endian within each byte: neuron `i` is bit `7 - (i & 7)` of
// byte `i >> 3`. Getting this backwards produces a wrong-but-plausible neuron map that
// nothing errors on (#5 R6), so every reader in `src/` goes through `spikeAt` and the
// expression appears once. Fixtures under `tools/spike/` synthesise their own packed
// vectors and are not readers.
//
// It was not always true. This header claimed sole authority for `unpackInto`, which
// #6 never called — it read the bits inline instead, so the documented authority was
// inert and the live copy was undocumented. Anyone debugging a bit-order fault would
// have followed this header to dead code, changed it, and seen nothing happen (#55).

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
 * Is neuron `i` set in the packed vector?
 *
 * The one expression of bit order, and deliberately a single-bit test rather than a
 * bulk expansion: every reader in the panel is sparse — each map pane walks its own
 * members and asks about those — so a whole-vector unpack would allocate and fill
 * 166,700 entries per frame to answer questions about a subset of them. `unpackInto`,
 * which did exactly that, was removed here: it had no call site, and the pattern it
 * offered is the one the panel's accumulator is built to avoid.
 *
 * @param {Uint8Array} bytes @param {number} i neuron index
 * @returns {number} 1 or 0
 */
export const spikeAt = (bytes, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;
