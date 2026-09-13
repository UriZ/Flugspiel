# Flugspiel

Fly brain connectome simulation playing arcade games — visualize 166,700 neurons driving gameplay in real time.

## Concept

Flugspiel ("fly play" in German) wires the MaleCNS v1.0 fruit fly connectome (166,700 neurons, 25.6M connections / 124M synapses) to arcade games as a reservoir computer. The biological wiring runs as a leaky integrate-and-fire simulation — game state is encoded into sensory neurons, signals propagate through the real connectome, and descending/motor neuron activity is decoded into game actions. A dopamine-based reward loop lets the brain improve over time. Split-panel UI shows the brain visualization alongside the game.

## Project Structure

```
Flugspiel/
├── src/
│   ├── brain/              # Python: connectome loading, LIF simulation, encoder/decoder
│   │   ├── connectome.py   # Load MaleCNS data, build weight matrix
│   │   ├── lif.py          # Leaky integrate-and-fire neuron model
│   │   ├── encoder.py      # Game state → sensory neuron input
│   │   ├── decoder.py      # Motor neuron output → game actions
│   │   └── reward.py       # Dopamine reward/punishment loop
│   ├── server/             # Python: WebSocket server bridging brain ↔ game
│   │   └── ws_server.py
│   ├── game/               # JS: arcade game (Missile Attack fork) with state API
│   │   └── ...
│   └── viz/                # JS: brain visualization panel (WebGL/Canvas)
│       └── ...
├── data/                   # Connectome data files (downloaded, not committed)
├── tests/
├── requirements.txt
├── package.json
└── index.html              # Split-panel UI shell
```

## Key Files

- `BACKLOG.md` — intake inbox only. User drops future work items here; TL turns them into GitHub issues. Never the source of truth for task state
- `architecture.md` — system architecture doc
- `criteria.md` — quality criteria for judge evaluations
- `SESSION_LOG.md` — activity log for all agent work

## Agent Behaviour

- be concise. no ai slop
- apply critical thinking. don't tell me what i want to hear
- **NEVER `git add` then `git commit` as two steps — the index is shared process-wide.** Use `git commit <paths> -F msg` in **one** step. A TL ran `git add SESSION_LOG.md` followed by a bare `git commit` and swept another agent's already-staged `connectome.py` into a commit whose message described only the log. Content survived; **attribution did not**, and history cannot be rewritten with other agents active. This is the third variant of the same failure — after `git add -A <dir>` and after a path carrying two features — and the `git diff --cached` rule does not save you if another process stages a file between your check and your commit.
- **never `git add -A <dir>` on a shared branch** — stage explicit path lists. With several agents working one tree, `git add -A tools/spike` swept four other agents' untracked probes into one agent's commits. Nothing was lost (blobs byte-identical), but attribution was, and a history rewrite to fix it is more dangerous than the noise when others are committing. **But staging explicit paths is NOT sufficient, and gives false confidence** — naming a path says nothing about whether that path carries one feature or two. `decoder.py` already held an unfinished #25/#22 rework when a #26 commit named it, so `cf5afcf`'s message covers #26 while the commit carries the entire #25 mechanism and all of #22's fix. Reverting the follow-up would leave #22 still fixed and #25's integrator present but inert. **The check that actually catches this is `git diff --cached` before every commit** — read what you are about to commit, not what you asked to stage.
- read existing code before modifying it — never blind-edit
- **`gh issue comment --body "..."` with backticks is destructive under zsh** — the shell command-substitutes the backticked span, silently deleting it, and `gh` exits **0**. An agent lost the words `architect-ui` from a heading this way and only caught it by reading the posted body back. Use **`--body-file`**, or single-quote the body (single quotes block substitution). **Read back anything you post that matters** — same class as `--comments` printing nothing: a silent failure with a success exit code. **This applies to `git commit -m` too** — a commit message lost the words `enabled` and the commit succeeded; it was only caught by reading the message back, and fixing it changed the SHA. Use `git commit -F <file>` for any message containing backticks. The rule is general: **any shell argument you did not single-quote is a substitution site**. Concretely: **`rev:path` arguments too** — `git show "$rev:src/brain/decoder.py"` fails with a mangled path because `:s` is a zsh history modifier, and it bites **inside double quotes and inside a variable assignment**. Use Python `subprocess` for those.
- **`timeout(1)` does not exist on macOS** — hang probes need `subprocess.run(..., timeout=)`, and the shell's 137 must be reconstructed from a negative `returncode` (`-9` -> 128+9). Applies wherever a rule says "report the exit code".
- **`gh issue view N --comments` silently returns empty output in this environment** — it does not error, it just prints nothing, which reads as "this issue has no comments". Use `gh issue view N --json comments --jq ...` instead. Cost `sec-fixes` a false start on the premise that #15-#19 had no discussion on them.
- work in small chunks — one logical change at a time; small prs
- **never bypass problems** — if something is broken (permissions, tests, builds), diagnose the root cause and fix it. Do not work around it, do not do the task manually instead, do not skip steps. Fix the system so it works correctly going forward.
- **never break the pipeline** — follow every step of the pipeline in order. Don't skip judge gates, don't skip retros, don't skip session logging. If a step fails, fix the step, don't skip it.
- **After touching `src/brain/lif.py` or anything that changes the spike train, run `python -m src.brain.fingerprint --check`.** If the trajectory legitimately moved, `--update` and **commit `trajectory.lock.json` in the same change** — a one-line lock diff beside the constant change is what makes a deliberate change distinguishable from a drift. `PARTITIONS` went 16 -> 8 with nothing recording it (#24), which is the failure this closes. The constants-only half (`--check --no-connectome`) needs no connectome, no numba and no network, and runs in ~0.1 ms. **If the lock goes stale silently, the next person to hit it concludes the fingerprint is broken rather than that the trajectory moved.**
- **After any change to `fingerprint.py` itself, verify the tripwire still FAILS, not only that the lock still passes.** Two green checks cannot distinguish *"nothing moved"* from *"the check stopped working"* — the same failure mode as a skipped test reading as coverage. Mutate `PARTITIONS` and confirm exit 1 naming both values.
- **`scipy.sparse.csr_matrix(...)` fed CSC arrays silently TRANSPOSES** — no error, a plausible wrong answer. It reported a one-hop MBON->DN max of 0.01024 instead of 0.07053, off by 7x in the direction that would have changed a conclusion. Caught only by an assertion that reproduced the quantity independently (5.5e-01 vs 9.7e-08). **Same shape as the packbits bit-order trap: a wrong answer nothing errors on.** When converting sparse formats, assert the result against an independently computed value, and ship the assertion in the probe.
- **Interleave the arms of ANY cost comparison, by default — this is not a remedy for a noisy box, it is how you measure.** Non-interleaved runs have twice in one session handed an agent a confident wrong answer **in the flattering direction**: a 4x latency "improvement" (54.8/86.8 ms before vs 19.9/21.5 after) that interleaving collapsed to **19.8-20.1 ms median on both arms**, and a 39% "regression" that was `putImageData` and 1,314 marker arcs the change never touched. Alternate the order within each round and report the ratio; a sequential A-then-B comparison attributes load drift to whichever arm drew the busy window.
- **`np.clip` is a range limiter, never a sanitiser** — it bounds `±inf` and **passes NaN straight through**, so a clip sitting upstream of a write reads as protection and is not. **The correct order is `nan_to_num` then `clip`** (`encoder.py:253-254` already does this; copy that pattern). Worse, a clip can be downstream of the *manufacture*: `(left - right) / (left + right + 1e-3)` over public mutable state produces `inf - inf` before any clip runs, and that NaN reached the wire where `json.dumps(allow_nan=False)` killed the session. **Guard where the value is created, not after it is bounded** — and guard persistent state separately, because one non-finite write there is permanent (#13).
- **`emitted` from `bridge.getStats()` is NOT a throughput measure** — the server coalesces states landing in one step period, so `emitted` can rise while delivered frames fall **3.4x**. A reward loop or a status display keying on emit counts would read client-side rAF burstiness as progress.
- **verify the wire, not the spec of the wire** — a downstream agent must confirm an upstream contract against the running system, not against the document describing it. Two facts that reshaped #5's design were invisible in #4's spec text and appeared only on a live socket: `populations.weapon` is **6** where the spec's example said 2, and `/healthz` is unreachable from a browser because #4 mounts no CORS — true of #4's own Python probe, false of the UI. A spec is a claim about a system; the system is the fact.
- **backlog notes are user intent, not verified fact** — BACKLOG.md and issue descriptions are written from memory and have already been wrong about upstream repos. Verify factual claims against the actual source before designing or building on them, and report corrections.
- **a green test run must be proven, not assumed** — read the actual output and assert a non-zero test count. A misconfigured runner can report a false FAIL over working tests (seen: `node --test <dir>` on Node 22 dies with `Cannot find module`), and far worse, a runner that discovers **zero** tests exits 0 and looks green. Always report the real output with counts, never just "tests pass". **The same applies to any negative result**: an agent reporting no findings, no bugs or nothing to fix must enumerate what it checked and found clean, so the next agent neither silently redoes it nor wrongly assumes coverage. **And read the skip list.** A skipped test is zero coverage, not a pass — `43 passed, 1 skipped` reads as green and hid #10 for a month, where the skip *was* the default production backend. Report skips with their reasons (`pytest -ra`), and justify every one. **A negative security result is the same class of false green**: a guard verified only under patched-down constants, or a crash proof at toy scale, proves nothing about the shipped code. `OFF=166700` (exactly `n`) exits **0** at real scale where `OFF=5_000_000` exits 139 — so a single-offset or small-fixture probe would have concluded the kernel was protected when only the load-boundary check protects it. **Third shape: the self-referential assertion**, where expected and actual derive from the same function. It collects, runs, reports a non-zero count and an empty skip list, and still cannot fail — #3's E2 asserted `argmin(luminance) == column(x, 36)` while `_luminance` *builds* the shadow from `column(...)`. No test count or skip list reveals this; only mutation does. **Fourth shape: a runner that counts the wrong thing.** `tools/run-tests.mjs` — written for #2 *specifically to refuse a vacuous pass* — counts **files, not tests**: truncating all five test files to 0 bytes reports `# tests 5 / # pass 5 / # fail 0` and exits 0. A broken or empty file silently books itself as a passing test. **Verify the runner itself by emptying a test file and confirming the count drops**; never trust a harness's own anti-vacuity claim without testing it (#23). **Fifth shape: a check that passes while its own detail line contains the disproof.** A shell probe reported **PASS** next to `rejected=259 phase=start` — every action bouncing off a start screen while the step counter ticked, printed in green. No test count or skip list can catch this. **Assert on the field that would be WRONG if the feature were broken, not on a field that moves either way.** The fix there was `phase === 'playing' && accepted > 0 && rejected === 0`. **Sixth shape: a test that exercises a code path production does not take.** D12 passed a **brain-time** `dt` to `decode()`; `ws_server` passes a **wall-clock** one. The test is not vacuous, not self-referential, and **no mutation of `decoder.py` reveals it** — only reading the call site does. That is what hid #30, in the very mechanism that had just fixed the project's worst defect. **Check that the test's inputs are the ones the caller actually supplies.** **Seventh shape, its inverse: quoting a passing suite that does not cover the changed file at all.** `tools/build-viz-layout.py` has no test importing it, and `src/viz/` has **zero automated tests across 1,779 lines** — so "the suite is green" is a true statement and a **vacuous** claim about either. **Name which files your suite actually covers**, and if it covers none of what you changed, say so and describe what you drove instead. A developer disclosed exactly this unprompted; it is the standard. **Eighth shape: a named check scoped so narrowly it cannot see the invariant it is named after.** `--contract`'s `PASS ["unknown"] and never [] with no encoder` is scoped to the **no-encoder** path and never builds an Encoder with prosthesis disabled — so the check passes green while the invariant in its own name is violated (#48). **Read what a passing check actually exercised, not what it is called.** **Ninth shape: citing a figure from the wrong run of the same issue.** An issue reporting a measurement **before and after a fix** carries two real numbers — both genuinely "on the linked issue", only one current. A README quoted `0 / 40 / 108 / 168`, taking `40` from the post-fix run and `168` from the pre-fix one; **neither ladder was that.** No word sweep, diff review or link check catches it, because every digit is sourced and the citation resolves. **When you cite a figure, name which run** — and prefer the one the issue itself marks as reproducing the shipped behaviour.
- **mutation-test anything that must not silently break** — a passing suite proves nothing until you've broken the code and watched it fail. Revert the fix, confirm the test goes red, restore. This found a real hole in #1 (the noise term's position in the LIF update order was unpinned: moving it left all 37 tests green while changing the dynamics) and confirmed #2's emit regression tests catch both known-bad variants.
- **prove a guard is REACHED at production constants, not just that it works when reached** — the converse of the mutation rule, and mutation testing structurally cannot find this because there is no mutation. `_stream`'s rate guard sat after `resp.read(_CHUNK)` with `_CHUNK = 8 << 20`; `HTTPResponse.read(amt)` *fills* `amt`, so the guard never evaluated against a drip server and the code shipped dead. Its test passed only because it monkeypatched `_CHUNK = 1`. **When a test monkeypatches a constant, check whether that constant controls the guard's reachability, not just its threshold** — a test that passes against both reachable and unreachable code is a false coverage record.
- **`-m "not realdata"` is a CHOICE, not a limitation — the connectome IS present.** For weeks every report on this project quoted `194 passed, 11 deselected` as the baseline, including mine in agent briefs. **True coverage is 205 passed, 0 skipped**; the 11 take ~346 s. Deselecting them is fine for a fast inner loop, but **quoting the deselected total as "the baseline" hides 11 real-data tests behind a flag** — the same shape as a skip reading as coverage, one level up. Name which set you ran and say whether the 11 were excluded by choice or by absence.
- **always name your collected set** — `tests/` now holds four issues' work; `33 passed` means something only because the agent said *which* 33 (`test_lif.py` 27 + `test_integration.py` 6). On a shared branch a test count is only attributable if you name the collected set — a reviewer's collection grew 50 -> 76 mid-review because a concurrent agent added a test file, which silently changed every mutation count in the battery. Scope the runner to the files under review, or record `--collect-only` counts before and after. A bare total from a moving branch proves nothing about the code you are reviewing.
- **a spec or design grounded in a measurement names the command and the date** — the design analogue of proving a green run. A layout claim also names the pixel sizes it was checked at. "Works responsively" is an untested assertion, not a decision.
- **never embed machine-specific numbers in a docstring or comment** — a claim in source is a maintenance liability the moment it cites a measured figure. Two agents produced 1.8x-divergent throughput for the identical command, and `lif.py`'s docstring is 1.8x off while claiming an 8-thread penalty that does not exist. The rot runs the other way too: a stale comment forbidding `cache=True` (true only before #11 removed `get_num_threads()`) cost a free 6x startup win for a whole session. Put measurements in the issue or the session log, where they carry a date and a command. **The strongest evidence for this rule is not that figures rot — it is that the figure was never a property of the code.** The *same uncompressed file* measured **0.13-0.21 s** warm and **0.44-0.81 s** earlier the same evening, on one machine, minutes apart, with nothing about the code different. A 4x spread with no code change. A docstring stating either number is asserting something about a machine's mood.
- **TESTING SUSPENDED by user decision (2026-09-12).** Do not write new unit tests, do not set up
  test scaffolding, and do not block a PR or a judge gate on missing tests. Existing tests are
  retained and must still pass if you run them — do not delete them and do not knowingly break
  them. Rationale recorded by the user: test noise outweighs its value at this stage.
  **Carve-out: repairing a test that CANNOT FAIL is a fix, not new coverage, and is always in
  scope.** A vacuous test is a false coverage record — worse than no test, because it deflects
  scrutiny. Amending its assertion is repair. Widening it to cover more cases is not.
  **Cost accepted deliberately:** the four defects found so far (#9 gain unpinned, #10 numba data
  race, #11 thread-dependent spike trains, #15 SIGSEGV + silent wrong answer) were all caught by
  tests and mutation runs, not by review. On numerics a wrong result is indistinguishable from a
  right one by inspection, so regressions from here will surface late or not at all.
  Re-enable only on the user's say-so.

## Team Agents

Agents are defined in `.claude/agents/`. The team lead (TL) orchestrates all work.

**`tl` is the session agent and is NEVER spawned.** The TL *is* the agent running the session — dispatching a `tl` subagent (or the generic `team-lead`) is self-delegation: a cold-start agent re-deriving context the TL already holds, with ownership of the pipeline split across two actors. Every other role in the tables below is spawned by the TL; `tl` is the one that does the spawning. Orchestration work — reading issues with comments, task breakdown, issue creation and relabelling, pre-flight verification, retrospectives, session logging, status reports — is done by the TL directly and has nobody to hand off to.

### Core Roles

| Agent | Role |
|-------|------|
| `tl` | **Session agent — never spawned.** Orchestrates the team — breaks down work, assigns tasks, runs the pipeline, applies retrospective improvements |
| `architect` | Designs architecture, API contracts, data models, implementation specs |
| `developer` | Implements features from specs |
| `qa` | Tests the app, finds bugs, verifies fixes |
| `security` | Audits code for vulnerabilities — OWASP, secrets, injection, API abuse |
| `judge` | Evaluates agent output against acceptance criteria — quality gate |

### Optional Roles (add as needed)

| Agent | Role |
|-------|------|
| `senior-developer` | Handles complex/high-risk implementation tasks |
| `ui-designer` | Produces visual design specs |
| `visual-qa` | Screenshot-based visual QA testing |
| `devops` | Deployment, CI/CD, infra, environment config |

### Backlog → Pipeline

`BACKLOG.md` is an **intake inbox**, not a tracker. The user drops items there; the TL drains them into GitHub issues and feeds those into the pipeline. Once an issue exists it is authoritative — the backlog entry is dead text and nobody updates its status. **GitHub issues are the sole source of truth.** Where the two disagree, the issue wins.

```
BACKLOG.md (intake inbox — user drops items)
    │
    ▼
TL picks item → creates GitHub issue with acceptance criteria
    │
    ▼
architect ──► developer ──► qa ──► FEATURE JUDGE GATE ──► done
```

1. **Architect designs** — creates spec, posts to GitHub issue
2. **Developer implements** — builds from spec
3. **Code review** — **DISABLED by user decision (2026-09-13)** to move faster. Do not route issues
   to `code-review` and do not spawn `senior-developer` for review. **Cost accepted deliberately:**
   this stage caught things no other stage could — #17's `_MIN_RATE` guard was *dead code at
   production constants* and a 9-mutation judge battery passed straight over it (there is no
   mutation for "this line never runs"), and #3's E2 was a self-referential assertion where expected
   and actual both derive from the function under test. With testing suspended and security
   disabled, the judge gate is now the only independent read of any implementation.
   Re-enable on the user's say-so.
4. **Developer addresses code review** — a developer agent receives the findings and fixes all "must fix" items. TL does NOT fix code review items — the developer does
5. **QA verifies** — tests the implementation, files bugs if found
6. **Security audits** — **DISABLED by user decision (2026-09-12).** Do not route issues to the
   `security` stage and do not spawn the `security` agent. The pipeline goes `qa` -> feature judge
   gate. Findings already filed (#15-#19) are still to be fixed as ordinary bugs; this disables the
   audit *stage*, it does not retire open findings. Re-enable only on the user's say-so
7. **FEATURE JUDGE GATE** — **once per feature**, at the end. Evaluates the complete feature against its acceptance criteria, reading **every stage's output in one pass** — the architect's spec, the implementation, the code review and its fixes, and QA's findings. Not just the last stage.

**A feature** is a coherent deliverable: one issue, or a group of issues that ship together (the UI = #5 + #6). `GATE_FREQUENCY: feature` in `criteria.md`.

**Escalate to a judge mid-feature anyway** when: an agent overrides a spec/review finding/TL steer; two agents report contradicting measurements for the same thing; or code review raises a must-fix the developer disputes. These need adjudication and cannot wait for the end.

**What this costs, accepted deliberately:** defects compound across stages before anything catches them — a wrong spec now survives implementation, review and QA before the gate sees it. Rework is larger and later. The per-stage gates were catching real defects, so the batched gate must read every stage, not just the last.

If a judge gate **FAILs**, work is sent back to the responsible agent with specific feedback. The TL does NOT override judge decisions without user approval.

**Retrospectives still run after EVERY agent completes** — they are the TL's own work, not a judge pass, and are not batched. Apply insights immediately and log them in SESSION_LOG.md.

### Judge System

The judge is a separate agent (`.claude/agents/judge.md`) that evaluates work quality at pipeline gates.

#### Three layers of criteria (see `criteria.md`):

1. **Project-level** — overall quality bar, target standard, non-negotiables
2. **Per-role** — generic quality requirements for each agent type
3. **Per-task** — acceptance criteria defined on each GitHub issue

#### Judge configuration (in `criteria.md`):

- `STRICTNESS`: low / medium / high / paranoid
- `GATE_MODE`: blocking / advisory
- `SCORE_THRESHOLD`: minimum score to pass (1-10)
- `JUDGE_TL`: whether to evaluate TL orchestration at end of cycle

#### Judge output format:

```markdown
## Judge Evaluation — [agent-name] — #ISSUE
**Verdict**: PASS / FAIL
**Score**: N/10
**Threshold**: N/10

| # | Criterion | Result | Notes |
|---|-----------|--------|-------|
| 1 | ... | PASS/FAIL | ... |

**Gaps**: [specific shortcomings]
**Recommendation**: [next action]
```

### Task Tracking via GitHub Issues (MANDATORY)

All tasks MUST be tracked as GitHub issues on `UriZ/Flugspiel`. GitHub issues are the **sole source of truth** for task state. Do NOT use internal task systems as the primary tracker.

#### GitHub repo: `UriZ/Flugspiel`

#### Labels:
- `enhancement` — new feature or feature request
- `bug` — something broken found by QA
- `security` — security finding or security-related task
- `architect` — needs architect design before implementation
- `ui-design` — needs UI/visual design spec
- `developer` — ready for developer implementation
- `code-review` — in senior-developer code review, before the judge gate
- `qa` — needs QA verification
- `in-progress` — currently being worked on
- `judge-fail` — failed a judge gate, needs rework
- `won't fix` — decided not to fix (with reasoning in comment)

#### Issue lifecycle:
1. **Feature request**: Create issue with `enhancement` + `architect` labels. MUST include acceptance criteria.
2. **Architect designs**: Posts spec as comment, relabels to `developer` (or `ui-design` first)
3. **Developer implements**: Posts implementation notes, relabels to `qa`
4. **QA verifies**: Reports findings. Bugs → new `bug` issues. Clean → relabels to `security` or done
5. **Judge gates**: Run between stages. On FAIL → `judge-fail` label + feedback comment, back to previous stage
6. **User approves**: UriZ is the FINAL approver

#### How to create issues:
```bash
gh issue create --title "Title" --body "Description" --label "enhancement,architect"
```

#### How to update issues:
```bash
gh issue comment NUMBER --body "Update text"
gh issue edit NUMBER --add-label "developer" --remove-label "architect"
```

### Session Log (MANDATORY)

Every agent MUST append to `SESSION_LOG.md` (root) throughout and at the end of their work. See `SESSION_LOG.md` for the format guide.

### Continuous Self-Improvement (MANDATORY)

Every agent MUST include an **Improvement Insights** section at the end of their TLDR:

```
## Improvement Insights
- **[agent-name.md]**: [specific suggestion]
- **[CLAUDE.md]**: [specific suggestion]
- **[criteria.md]**: [specific suggestion]
- **[workflow]**: [specific suggestion]
```

Only include actionable, specific suggestions — not generic praise or complaints.

### Team Lead Retrospective (MANDATORY — after every agent completes):
1. **Capture the agent's full TLDR verbatim** in SESSION_LOG.md
2. **Read the agent's Improvement Insights**
3. **Evaluate each suggestion** — is it valid? Would it save time next run?
4. **Apply valid suggestions immediately** — edit agent definitions, CLAUDE.md, criteria, or workflow docs
5. **Log what was applied** in SESSION_LOG.md under a "Retrospective" heading

### Deployment Policy (MANDATORY)

NEVER deploy to production or push code without explicit user approval. Always present a summary and wait for confirmation.

### Git Push Policy (MANDATORY)

NEVER push code (`git push`) without explicit user approval.