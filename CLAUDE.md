# Flugspiel

Fly brain connectome simulation playing arcade games — visualize 166,700 neurons driving gameplay in real time.

## Concept

Flugspiel ("fly play" in German) wires the MaleCNS v1.0 fruit fly connectome (166,700 neurons, 25.6M synapses) to arcade games as a reservoir computer. The biological wiring runs as a leaky integrate-and-fire simulation — game state is encoded into sensory neurons, signals propagate through the real connectome, and descending/motor neuron activity is decoded into game actions. A dopamine-based reward loop lets the brain improve over time. Split-panel UI shows the brain visualization alongside the game.

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

- `BACKLOG.md` — the starting point. User adds work items here, TL picks them up
- `architecture.md` — system architecture doc
- `criteria.md` — quality criteria for judge evaluations
- `SESSION_LOG.md` — activity log for all agent work

## Agent Behaviour

- be concise. no ai slop
- apply critical thinking. don't tell me what i want to hear
- read existing code before modifying it — never blind-edit
- work in small chunks — one logical change at a time; small prs
- **never bypass problems** — if something is broken (permissions, tests, builds), diagnose the root cause and fix it. Do not work around it, do not do the task manually instead, do not skip steps. Fix the system so it works correctly going forward.
- **never break the pipeline** — follow every step of the pipeline in order. Don't skip judge gates, don't skip retros, don't skip session logging. If a step fails, fix the step, don't skip it.
- **every implementation includes tests** — if no test runner is configured, set one up as part of the task. Pure-logic modules (validation, rate limiting, error handling) must have unit tests. No PR without tests.

## Team Agents

Agents are defined in `.claude/agents/`. The team lead (TL) orchestrates all work.

### Core Roles

| Agent | Role |
|-------|------|
| `tl` | Orchestrates the team — breaks down work, assigns tasks, runs the pipeline, applies retrospective improvements |
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

The `BACKLOG.md` file is the entry point for all work. The user adds items with acceptance criteria. The TL reads the backlog, picks items by priority, creates GitHub issues, and feeds them into the pipeline.

```
BACKLOG.md (user adds items)
    │
    ▼
TL picks item → creates GitHub issue with acceptance criteria
    │
    ▼
architect ──► JUDGE GATE ──► developer ──► CODE REVIEW ──► JUDGE GATE ──► qa ──► JUDGE GATE
                                                                                                │
                                                                                        security (if needed)
                                                                                                │
                                                                                        FINAL JUDGE GATE
                                                                                                │
                                                                                              done
```

1. **Architect designs** — creates spec, posts to GitHub issue
2. **Judge evaluates architect output** — checks spec completeness, no scope creep, clear interfaces
3. **Developer implements** — builds from spec
4. **Code review** — senior-developer reviews code using the `code-review` skill. Posts findings with "must fix" vs "nice to have" classification
5. **Developer addresses code review** — a developer agent receives the code review findings and fixes all "must fix" items. TL does NOT fix code review items — the developer does
6. **Judge evaluates developer output** — checks implementation matches spec, builds, tests pass, code review "must fix" items resolved
6. **QA verifies** — tests the implementation, files bugs if found
7. **Judge evaluates QA output** — checks test coverage, bug reports actionable
8. **Security audits** (when applicable) — reviews code for vulnerabilities
9. **Final judge gate** — evaluates the complete feature against acceptance criteria

If a judge gate **FAILs**, work is sent back to the responsible agent with specific feedback. The TL does NOT override judge decisions without user approval.

**After every judge gate PASSES**: apply retro improvements from the judge and agent insights BEFORE moving to the next pipeline stage. This is not optional — update agent definitions, CLAUDE.md, criteria.md as needed, and log what was applied in SESSION_LOG.md.

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