// Spike: emit-rate accumulator. Evidence behind spec #2 §2.6 / §7.1 (v2.1).
//
// Compares three accumulator variants at a fixed frame rate:
//   A  acc = 0                      (v2 spec — WRONG, quantizes to fps/ceil(fps/hz))
//   B  acc -= interval              (correct rate, but acc grows unbounded when hz > fps)
//   C  acc -= interval, clamped     (ADOPTED — correct rate, bounded backlog)
//
//   node tools/spike/emit-rate.mjs

function sim(hz, fps, secs, variant) {
  const dt = 1 / fps, iv = 1 / hz;
  let acc = 0, n = 0, maxAcc = 0;
  for (let i = 0; i < Math.round(fps * secs); i++) {
    acc += dt;
    if (acc < iv) continue;
    if (variant === 'A') acc = 0;
    else { acc -= iv; if (variant === 'C' && acc > iv) acc = iv; }
    maxAcc = Math.max(maxAcc, acc);
    n++;
  }
  return { hz: n / secs, n, maxAcc };
}

const RATES = [10, 20, 25, 40, 45, 50, 60, 120];
const FPS = 60;

console.log(`--- effective rate over 60 s @ ${FPS} fps ---`);
console.log('req | A(acc=0) | B(acc-=iv) | C(clamped) | contract min(hz,fps)');
for (const hz of RATES) {
  const a = sim(hz, FPS, 60, 'A'), b = sim(hz, FPS, 60, 'B'), c = sim(hz, FPS, 60, 'C');
  console.log(
    String(hz).padStart(3), '|', a.hz.toFixed(2).padStart(8), '|', b.hz.toFixed(2).padStart(10),
    '|', c.hz.toFixed(2).padStart(10), '|', String(Math.min(hz, FPS)).padStart(4));
}

console.log(`\n--- accumulator runaway: 120 Hz requested @ ${FPS} fps for 600 s ---`);
for (const v of ['B', 'C']) console.log(` ${v}: max acc = ${sim(120, FPS, 600, v).maxAcc.toFixed(4)} s`);

console.log('\n--- exact emit counts, variant C, no epsilon (test oracle) ---');
console.log('hz  | 1 s (60 f) | 10 s (600 f) | allowed [min(hz,fps)*T - 1, min(hz,fps)*T]');
for (const hz of RATES) {
  const e1 = sim(hz, FPS, 1, 'C').n, e10 = sim(hz, FPS, 10, 'C').n, r = Math.min(hz, FPS);
  console.log(String(hz).padStart(3), '|', String(e1).padStart(10), '|', String(e10).padStart(12),
              `| [${r - 1}, ${r}] / [${r * 10 - 1}, ${r * 10}]`);
}

console.log('\n--- recovery after a 3 s stall (20 Hz req), emits in the following 2 s ---');
for (const v of ['A', 'B', 'C']) {
  const iv = 1 / 20; let acc = 3.0, n = 0, firstTen = [];
  for (let i = 0; i < 120; i++) {
    if (i > 0) acc += 1 / FPS;
    if (acc < iv) continue;
    if (v === 'A') acc = 0; else { acc -= iv; if (v === 'C' && acc > iv) acc = iv; }
    n++; if (i < 10) firstTen.push(i);
  }
  console.log(` ${v}: ${String(n).padStart(3)} emits (nominal 40) | frames 0-9 emitting: ${firstTen.join(',')}`);
}

// Browser-reachable scenario that kills the unclamped variant B. `startLoop` caps dt at
// 1/20 s (loop.js), so a background tab throttled to 20 fps still delivers dt = 0.05.
// At 40 Hz requested that is one whole interval of credit per frame.
console.log('\n--- 60 s throttled to 20 fps @ 40 Hz requested, then 60 s back at 60 fps ---');
for (const v of ['A', 'B', 'C']) {
  const iv = 1 / 40; let acc = 0, n = 0;
  const step = (dt) => { acc += dt; if (acc < iv) return false; if (v === 'A') acc = 0; else { acc -= iv; if (v === 'C' && acc > iv) acc = iv; } return true; };
  for (let i = 0; i < 20 * 60; i++) step(0.05);
  const debt = acc;
  for (let i = 0; i < 60 * 60; i++) if (step(1 / 60)) n++;
  console.log(` ${v}: backlog ${debt.toFixed(2)} s | ${n} emits in the next 60 s (nominal 2400) = ${(n / 60).toFixed(1)} Hz`);
}
