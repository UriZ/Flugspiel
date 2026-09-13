# Quality Criteria

This file defines what the judge agent evaluates against. Three layers: project-level, per-role, and per-task.

## Judge Configuration

```
STRICTNESS: medium          # low / medium / high / paranoid
GATE_MODE: blocking         # blocking / advisory
SCORE_THRESHOLD: 7          # minimum score (1-10) to pass a gate
MAX_RETRIES: 2              # max retries per gate before escalating to user
GATE_FREQUENCY: feature     # feature / stage
```

### GATE_FREQUENCY: feature

The judge runs **once per feature**, not after every agent. A "feature" is a coherent
deliverable — one issue, or a group of issues that ship together (e.g. the UI = #5 + #6). The
judge evaluates the whole thing against its acceptance criteria at the end, reading every stage's
output in one pass.

**What still runs every time** (these are not judge gates and are not batched):
- **Code review** by `senior-developer` after each implementation. This is the independent-reader
  gate and it is cheap relative to a judge pass. It stays per-implementation.
- **TL retrospectives** after each agent completes. The TL does these directly.
- **QA** after implementation.

**Escalate to a judge immediately, mid-feature, regardless of frequency**, when:
- an agent overrides a spec, a review finding or a TL steer (this has happened three times and
  been correct each time — but it needs adjudication, not assumption)
- two agents report contradicting measurements for the same thing
- code review raises a must-fix the developer disputes

**Accepted cost:** defects now compound across stages before anything catches them. A wrong spec
is not caught until after it has been implemented, reviewed and tested. Rework is therefore larger
and later when it happens. This is a deliberate trade for cost — the per-stage gates were
genuinely catching real defects, so the batched gate must read every stage's output, not just the
last one.

---

## Project-Level Quality Bar

- Target quality: polished open-source demo — works reliably, looks impressive, code is clean and well-tested
- Brain simulation must be scientifically accurate — use real MaleCNS v1.0 data, real LIF dynamics, real neuron type mappings
- No placeholder/mock brain — if the connectome isn't loaded, fail loudly, don't fake it
- Game must remain playable by a human when not in fly-brain mode
- Split-panel UI must run at 30+ fps in both panels simultaneously
- WebSocket latency between brain and game must stay under 50ms per step
- Brain visualization must show real neuron activity, not random noise. **This is a signal test, not a vibes test**: measured on the built brain, baseline activity is 13,086 neurons/step of *amplified noise* (it falls to 0 with the noise or tonic term removed), so a busy-looking raster proves nothing. The bar is that activity under real game state must be statistically distinguishable from activity under **shuffled** game state (identical injection statistics, wrong content)

---

## Per-Role Criteria

### Architect

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | Spec completeness | Critical | Design covers ALL requirements in the task — nothing missing |
| 2 | No scope creep | Critical | Design covers ONLY what's requested — no unrequested features, no gold-plating |
| 3 | Clear interfaces | High | All public interfaces are unambiguous — developer should not need to make design decisions |
| 4 | Consistent with architecture | High | Design aligns with existing architecture.md and established patterns |
| 5 | Risks identified | Medium | Edge cases, failure modes, and constraints are called out explicitly |
| 6 | Implementation actionable | High | Spec is detailed enough that a developer can implement without asking questions |
| 7 | Technology choices justified | Medium | Any technology or library choice has clear reasoning with tradeoffs |
| 8 | Acceptance criteria made testable | High | Ambiguous or unfalsifiable acceptance criteria on the issue are restated in verifiable form, rather than left as prose for the judge to rule on. **State per criterion whether the restatement is assertable against the real system or only against a synthetic fixture** — the difference is often the whole story (#3's AC4 is fully testable synthetically and only one-quarter testable against the real brain)  **A third category matters as much as real-vs-synthetic: criteria that are assertable but whose expected result is NEGATIVE.** #7 pre-registers H2 and H3 as predicted FALSE, and states what a positive result would mean (evidence of a bug, not of learning). A spec that predicts a null and says how to read a surprise is stronger than one that only lists what should pass. |
| 9 | Claims verified, not assumed | High | Assumptions about third-party/existing code are verified by executing a spike or reading the actual source — not taken from the backlog, a README, or a reference implementation on faith. Spec states which claims were verified how |
| 12 | Downstream contract | High | When a spec cuts scope, it must **show** that the artefacts it does produce are sufficient for the blocked issue — naming the concrete derivation path, not asserting "derivable later". Quantify what the cut costs the downstream issue |
| 11 | Internal consistency | High | No section of the spec contradicts another. Numeric contracts stated in one section must match the algorithm specified in another |
| 10 | Prior art reconciled | Medium | Existing specs/comments on the issue were read; if superseded, the spec says what it replaces and why |

### Developer

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | Matches spec | Critical | Implementation matches the architect's spec — no deviations without justification |
| 2 | Build passes | Critical | Code compiles/builds without errors |
| 3 | Feature works | Critical | The implemented feature actually functions as specified |
| 4 | Tests present | **SUSPENDED** | **Not scored — testing suspended by user decision 2026-09-12.** Do not fail an implementation for absent tests. Manual verification, if the developer did any, is still worth recording. Re-enable on the user's say-so |
| 5 | Code quality | Medium | Clean, readable code following project conventions |
| 6 | No scope creep | High | Only what was specified was built — no extra features, no refactoring beyond scope |
| 7 |less is more| High | short concise code and text. no ai slop |
| 8 | Normative behaviour is test-pinned | **SUSPENDED** | **Not scored — testing suspended by user decision 2026-09-12, same as D4.** Its only remedy is a test, so scoring it would re-impose a suspended obligation through another row. **Three gates have now spent words re-deriving that D4's suspension implies D8's** — it is marked here so a fourth does not. Surviving mutants are still **reported** with proof of non-equivalence (34 across #32/#34/#39), because the record of what is unprotected is what makes the suspension reversible. Re-enable with D4. Original text:  Where the spec marks an ordering, invariant or numeric contract **normative**, at least one test must fail if it is violated. Verified by mutation, not by reading: break it, confirm a test goes red, restore. A **surviving** mutant counts as a coverage gap only once it is shown to change observable behaviour — an equivalent mutant (unreachable code) is a reporting item, not a test hole  **The converse is an obligation: demonstrate the observable difference in the review before promoting a surviving mutant to a gap.** The row says "once it is shown", not "show it" — on #3 this kept two equivalent mutants (M6, M10) out of the findings while four others were promoted only after their output change was measured. |
| 9 | Deviations are evidence-backed, not argued | High | Departing from a spec, a review finding or a TL steer is legitimate **when the developer executed the alternative and showed it fails**. Score this under this row, not under "no scope creep" — a reproduced defeat of the instruction is the behaviour we want, and must never be marked down as deviation |
| 10 | Behaviour amendments land in the code | Medium | A contract change agreed in an issue thread must also appear at the call site it governs. The next implementer reads the code, not the thread |
| 11 | No comment in the changed file contradicts what shipped **or another comment in the same file** | Medium -> **must-fix on a second appearance in the same file** | Distinct from row 10, which covers *"the amendment did not land at the call site"*. This covers *"a comment elsewhere in the same file now asserts the opposite of what shipped"* — which **three agents walked past** on `lif.py`: `10dc238` existed to remove a false claim from that file and left `lif.py:149` ("nothing pins it (#24)") standing 40 lines above, in `PARTITIONS`' own docstring, i.e. the text someone reads at the moment they edit the constant. Grep the whole changed file for claims your change falsified, not just the lines you touched. **Two defect classes, and the second was missed by a rule written for the first**: a claim that was *true when written* and invalidated by a later change, **and** a claim that was *never true*, introduced by the same commit that changed the code, contradicting **another comment three lines above it** rather than the code. `lif.py` carried one of each, eight lines apart. **Read the whole file, not the hunk** — both were found only by a grep mandated after the previous one was found, and a targeted fix reads a window |


### QA

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | All acceptance criteria tested | Critical | Every criterion from the issue was explicitly verified |
| 2 | Bug reports actionable | High | Each bug has clear repro steps, expected vs actual, and root cause hypothesis |
| 3 | Edge cases covered | Medium | Testing went beyond happy path — boundary conditions, error states, invalid input |
| 4 | Evidence provided | High | Screenshots, console output, or test results included as evidence |
| 5 | Severity accurate | Medium | Bug severities reflect actual impact, not inflated or deflated |
| 6 | Verified in the DOCUMENTED environment | High | Coverage and pass claims are reproduced in a clean env built from the project's stated install files (`requirements-dev.txt`, `package.json`), not only the developer's working venv. A test that silently skips there has zero coverage in production. **State how the env was established** — report the interpreter/runtime version and check it against the project's stated minimum; a finding evidenced on an unsupported interpreter is weakened even when the finding is right. Build it in a uniquely-named directory: `python -m venv` silently reuses an existing one without replacing `bin/python` |
| 7 | Mutations restored and proven restored | High | After mutation testing, assert the source matches a pre-mutation backup (checksum) and re-run the suite green. A QA run must never leave a mutated tree for the next agent |

### Security

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | OWASP coverage | Critical | All relevant OWASP Top 10 categories were checked |
| 2 | Secrets scan | Critical | Checked for hardcoded secrets in code AND git history |
| 3 | Findings actionable | High | Each finding has specific remediation steps with code examples |
| 4 | Severity calibrated | High | Severities reflect actual exploitability and impact. **Each finding must name the conditions under which its severity changes** — a static label hides decisions the team can still make freely. (The most useful line in the #1 audit was "SEC-001 becomes High the moment a prebuilt `weights.npz` is distributed") |
| 5 | States what it does NOT close | High | A fix must name its residual risk explicitly. Three of the five #15-#19 fix comments overclaimed, and the one self-reported residual (#19's TOCTOU) was recorded with a **wrong** reason — `pa.ipc.open_file` does accept a file-like source, so it was an mmap/RSS tradeoff, not an impossibility. An overclaimed fix is worse than a partial one, because it closes the issue in everyone's mind |
| 6 | Every commit in range independently reviewed | Critical | Name the reviewing comment per commit range. #1 FAILed its first gate on three unreviewed commits, and the review then found **dead shipped code** no mutation battery could reach. Also: **a review whose prescribed fix is itself a design change must be re-reviewed after the fix** — that re-review is what caught the reviewer's own error propagating into shipped code |
| 7 | Comments state mechanisms the code has | High -> **must-fix on 2nd appearance in the same file** | A comment describing a mechanism the code does not have is a defect in security code. One wrong claim ("download() retries three times" — `_stream` sits *outside* the `try`) reached **three** places through two reviews and two gates, including `8af152e`'s commit message, which cannot be corrected without a history rewrite. Medium once; must-fix if it survives another round in the same file |
| 5 | Dependency audit | Medium | npm/pip audit or equivalent was run |

### UI Designer

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | Research done | High | Referenced real-world examples, not designing in a vacuum |
| 2 | Spec implementable | Critical | Design is precise enough to implement (colors, sizes, spacing in exact values) |
| 3 | Responsive | High | Design accounts for mobile and desktop viewports |
| 4 | Consistent | Medium | Design aligns with existing visual language and patterns |

---

## Per-Task Acceptance Criteria

Defined on each GitHub issue at creation time. Format:

```markdown
## Acceptance Criteria
- [ ] [Specific, verifiable criterion]
- [ ] [Specific, verifiable criterion]
- [ ] [Specific, verifiable criterion]
```

The judge evaluates each criterion as PASS/FAIL. All acceptance criteria must pass for the final gate to pass.

---

## Verdict Rules

- **PASS**: All critical criteria met. High/medium criteria are substantially met. Work proceeds.
- **FAIL**: Any critical criterion not met, OR multiple high criteria have significant gaps. Work returns to agent with specific feedback.

### Weight Definitions

- **Critical** — Must pass. A FAIL on any critical criterion means overall FAIL regardless of everything else.
- **High** — Important. A single high failure is a warning. Multiple high failures → FAIL.
- **Medium** — Nice to have. Failures noted in feedback but don't block on their own.

### Fail feedback must be specific

Every FAIL must include:
- Which criteria failed and why
- Specific evidence (file, line, output)
- What needs to change to pass
- No vague "needs improvement" — name the gap