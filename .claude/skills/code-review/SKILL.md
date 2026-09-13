---
name: code-review
description: Senior code review for developer output. Reviews for correctness, readability, maintainability, and spec adherence. Returns actionable feedback.
user-invocable: false
---

# Code Review

You are reviewing code written by a developer against an architect's spec. Your job is to catch problems before the judge gate.

## What to review

1. **Spec adherence** — does the implementation match the architect's design? Missing interfaces, wrong data flow, skipped requirements?
2. **Correctness** — logic errors, off-by-one, race conditions, unhandled edge cases
3. **Readability** — unclear naming, tangled control flow, functions doing too much
4. **Maintainability** — tight coupling, missing abstractions that will cause pain, duplicated logic
5. **Tests** — do tests exist? Do they test the right things? Are edge cases covered?
6. **less is more** - can we simplify the code? can it be simpler and shorter? no ai slop past this point  

## What NOT to review

- Style/formatting (that's what linters are for)
- Minor naming preferences that don't affect clarity
- Architecture decisions (that ship has sailed — the architect made those calls)
- Performance micro-optimizations unless there's a clear problem

## Technique: mutation testing

For numerical, scientific or concurrency code — and for any test that exists specifically to
pin a fixed bug — reading is not enough. Reading tells you the code looks right; mutation tells
you the suite would notice if it stopped being right.

Break the thing that would fail **silently and catastrophically**, run the suite, restore:

- a transposed matrix / swapped index order
- an inverted sign or flipped comparison
- a reordered update step the spec marked normative
- an off-by-one in a boundary

Back up the file first, restore after every mutation, and `diff` against the backup at the end
to prove you left nothing behind. Report the mutation table — caught vs not caught. A mutation
nothing catches is a real coverage finding even when the code is currently correct.

Skip this when the TL has already verified the artefacts by execution — spend the freed budget
here instead of re-measuring known-good numbers.

## Running a mutation battery safely

**Drive it from a script with `try/finally` restore and a digest assertion after EACH mutation** — not
from shell commands, and not with a single check at the end. Two agents in two consecutive rounds left
a mutant on disk; one came from a 2-minute tool timeout firing mid-battery, which no amount of shell
care prevents. A mutant left in the working tree is read by concurrent agents (one stalled on a
`gain = 0.5` it found in `lif.py`) and can be committed by another author sweeping the tree.

**Mutate in memory where the design allows it.** Config-driven behaviour can be mutated by handing the loader a dict (`dict -> Mapping.load`) instead of writing a file — zero disk exposure to concurrent agents, and it made a 223-second real-brain mutation arm safe to run while two other agents were reading the same tree.

## Technique: test vacuity checklist

Mutation testing proves a test *can* fail. It cannot prove the guard under test is ever *reached* —
there is no mutation for "this line is dead at production constants". Check reachability separately.

Suspect any test that:

1. **Patches a module constant.** Ask whether that constant controls the guard's **reachability**, not
   just its threshold. Real example: `_stream`'s rate guard sits after `resp.read(_CHUNK)`;
   `HTTPResponse.read(amt)` fills `amt`, so at the production `_CHUNK = 8 << 20` the guard never
   evaluates. The test monkeypatched `_CHUNK = 1` and therefore passed identically against reachable
   and unreachable code — a false coverage record for the exact sub-issue it was named after.
2. **Asserts on a monkeypatched threshold** instead of on observable behaviour.
3. **Installs a sentinel that never fires** — assert the sentinel *did* fire.
4. **Computes its expected value with the code under test.** The first three are about what the test *does*; this one is about what it *compares against*. `argmin(luminance) == column(x, 36)` looks like a roundtrip and is a tautology, because `_luminance` builds the shadow from `column()`. It was only found by mutating a **third** file and seeing green.

Also check that a guard's companion constants are live: `_RATE_GRACE = 30.0` was inert as shipped,
because the earliest possible check was ~1024 s away.

A vacuous test is worse than a missing one. A missing test invites scrutiny; a vacuous one deflects it.

**"Stop monkeypatching the constant" is NOT a sufficient fix, and reads like one.** Running the same
drip test at production `_CHUNK` still passed against the broken code: a drip server that eventually
gives up and closes makes `read()` return short at EOF, so the guard fires **late** rather than never
— and `pytest.raises` cannot distinguish those. What de-vacuumed it was holding the connection open
and asserting `elapsed < 2.0`. **The timing assertion is the discriminator.** When a guard is about
*when* something happens, the test needs an assertion about when, not just that.

## Rules

- Be specific. "This function is too complex" is useless. "This function handles both parsing and validation — split into two" is useful.
- Reference file paths and line numbers
- Distinguish between "must fix" (will cause bugs or blocks spec) and "nice to have" (quality improvement). Use exactly these two labels — the pipeline in CLAUDE.md keys off them
- Calibrate honestly. A "must fix" should genuinely block. If you put something above the line that blocks nothing today, say so and give the reason
- Don't rewrite the code for them — describe the problem and the fix direction
- If the code is fine, say so. Don't invent issues.

## Output format

```markdown
## Code Review — #ISSUE

### Must Fix
1. **[file:line]** — [problem]. [fix direction].

### Nice to have
1. **[file:line]** — [problem]. [fix direction].

### Looks Good
- [brief note on what's solid, if anything stands out]
```
