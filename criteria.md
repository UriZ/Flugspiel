# Quality Criteria

This file defines what the judge agent evaluates against. Three layers: project-level, per-role, and per-task.

## Judge Configuration

```
STRICTNESS: medium          # low / medium / high / paranoid
GATE_MODE: blocking         # blocking / advisory
MAX_RETRIES: 2              # max retries per gate before escalating to user
```

---

## Project-Level Quality Bar

- Target quality: polished open-source demo — works reliably, looks impressive, code is clean and well-tested
- Brain simulation must be scientifically accurate — use real MaleCNS v1.0 data, real LIF dynamics, real neuron type mappings
- No placeholder/mock brain — if the connectome isn't loaded, fail loudly, don't fake it
- Game must remain playable by a human when not in fly-brain mode
- Split-panel UI must run at 30+ fps in both panels simultaneously
- WebSocket latency between brain and game must stay under 50ms per step
- Brain visualization must show real neuron activity, not random noise

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

### Developer

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | Matches spec | Critical | Implementation matches the architect's spec — no deviations without justification |
| 2 | Build passes | Critical | Code compiles/builds without errors |
| 3 | Feature works | Critical | The implemented feature actually functions as specified |
| 4 | Tests present | High | Implementation is tested (unit, integration, or manual verification documented) |
| 5 | Code quality | Medium | Clean, readable code following project conventions |
| 6 | No scope creep | High | Only what was specified was built — no extra features, no refactoring beyond scope |
| 7 |less is more| High | short concise code and text. no ai slop |


### QA

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | All acceptance criteria tested | Critical | Every criterion from the issue was explicitly verified |
| 2 | Bug reports actionable | High | Each bug has clear repro steps, expected vs actual, and root cause hypothesis |
| 3 | Edge cases covered | Medium | Testing went beyond happy path — boundary conditions, error states, invalid input |
| 4 | Evidence provided | High | Screenshots, console output, or test results included as evidence |
| 5 | Severity accurate | Medium | Bug severities reflect actual impact, not inflated or deflated |

### Security

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | OWASP coverage | Critical | All relevant OWASP Top 10 categories were checked |
| 2 | Secrets scan | Critical | Checked for hardcoded secrets in code AND git history |
| 3 | Findings actionable | High | Each finding has specific remediation steps with code examples |
| 4 | Severity calibrated | High | Severities reflect actual exploitability and impact |
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