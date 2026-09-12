// npm test entry point. Discovers the test files itself instead of handing a quoted
// glob to `node --test`: that glob is expanded by the runner only on Node >= 21, so on
// an older runtime the suite ran zero tests and exited 0 — a green build testing nothing.
//
// Discovery is explicit, and three shapes of a suite that proves nothing are hard
// failures, because each of them otherwise looks green (#23):
//
//   1. no test files at all;
//   2. a discovered file that declares no tests — `node --test` scores an empty
//      .test.js as one *passing* test point named after the file, so N truncated files
//      report N passes and exit 0. This is the case the file-count guard could not see;
//   3. zero passing tests overall, which is what an all-skipped suite looks like.
//
// Counting therefore comes from `run()`'s `test:summary` events, which carry real
// executed-test totals per file, and never from the number of files. A file that
// declares nothing emits no per-file summary at all — that absence is the signal.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';

const ROOT = path.resolve(import.meta.dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const rel = (f) => path.relative(ROOT, f);

async function collect(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collect(full)));
    else if (e.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

let files = [];
try {
  files = await collect(TESTS);
} catch (e) {
  // A missing tests/ tree is the same failure as an empty one; say so instead of
  // letting an ENOENT trace stand in for the guard message.
  if (e.code !== 'ENOENT') throw e;
}

if (files.length === 0) {
  console.error(`no *.test.js files found under ${rel(TESTS)}/ — refusing to report a vacuous pass`);
  process.exit(1);
}

// The suite resolves its own paths from import.meta.url, but the previous runner
// pinned cwd for the child processes and something may yet depend on it.
process.chdir(ROOT);

const perFile = new Map(files.map((f) => [f, null]));
const crashed = new Set();
let totals = null;

const stream = run({ files });
stream.on('test:summary', (d) => {
  if (d.file) perFile.set(d.file, d.counts);
  else totals = d.counts;
});
// A file that throws on import also emits no summary. It is already failing the run;
// calling it "declared no tests" would send the reader hunting for an empty file.
stream.on('test:fail', (d) => { if (d.file) crashed.add(d.file); });

for await (const chunk of stream.compose(tap)) process.stdout.write(chunk);

const fail = (msg) => {
  console.error(msg);
  process.exitCode = 1;
};

const silent = files.filter((f) => !perFile.get(f)?.tests && !crashed.has(f));
if (silent.length > 0) {
  fail(`${silent.length} of ${files.length} test file(s) declared no tests — refusing to report a `
     + `vacuous pass. node --test scores an empty file as one passing test:\n`
     + silent.map((f) => `  ${rel(f)}`).join('\n'));
}

if (!totals) {
  fail('the test runner produced no summary — cannot prove anything ran');
} else {
  if (totals.passed === 0) {
    fail(`0 passing tests (${totals.skipped} skipped, ${totals.todo} todo) — a skipped test is `
       + 'zero coverage, not a pass');
  }
  if (totals.failed > 0 || totals.cancelled > 0) process.exitCode = 1;
  // Not a failure: a quarantined test is a decision. Silence about it is the problem.
  const skipped = files.filter((f) => perFile.get(f)?.skipped > 0);
  if (skipped.length > 0) {
    console.error(`note: ${totals.skipped} skipped test(s) in:\n`
      + skipped.map((f) => `  ${rel(f)} (${perFile.get(f).skipped} of ${perFile.get(f).tests})`).join('\n'));
  }
}
