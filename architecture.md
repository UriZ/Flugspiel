# Architecture

Every claim below was checked against the shipped code by execution on 2026-09-13 (#40).
Where the code and this document disagreed, the document was wrong and has been corrected;
where a decision was superseded, it is marked **superseded** rather than deleted.

## Overview

Flugspiel connects the MaleCNS v1.0 fruit fly connectome (166,700 neurons, 25.6M connections / 124M synapses) to arcade games via a reservoir computing approach. The biological wiring runs as a leaky integrate-and-fire simulation in Python; a WebSocket bridge streams game state in and actions out; the browser renders the game and brain visualization side by side.

## Modules

### Module 1: Brain Simulation (Python)

Loads the MaleCNS v1.0 connectome data, builds the signed weight matrix, and runs the LIF neuron model. **Stateful across steps, deliberately**: the membrane vector, the last spike set and the decoder's integrators all carry over, and that persistence *is* the reservoir. The same input applied on two different steps does not give the same output.

- `connectome.py` — download + parse Janelia data → weights.npz, brain.npz
- `lif.py` — leaky integrate-and-fire step: `v ← decay·v + gain·W·spikes + tonic + noise`
- `mapping.py` + `mappings/*.json` — every population, gain and time constant the encoder injects into or the decoder reads from is named in JSON, not in Python
- `encoder.py` — game state JSON → voltage injections into named populations (retina, looming, drive, aim_bias)
- `decoder.py` — descending neuron activity → game action JSON
- `reward.py` — dopamine modulation: PAM neurons (reward) / PPL neurons (punishment)
- `fingerprint.py` — trajectory lock: pins the constants, seed, backend and spike digest

### Module 2: WebSocket Server (Python)

FastAPI + WebSocket endpoint bridging the browser and the brain simulation. Receives game state into a latest-wins slot, steps the brain on its own clock, and returns one frame per credited state: action + neuron activity snapshot for visualization. The reader never encodes and never steps — that asymmetry is what bounds a flooding client's cost.

### Module 3: Arcade Game (JavaScript)

**Vendored, not forked.** `src/game/vendor/` is a verbatim copy of `UriZ/missile-attack-aracde-web` at a pinned commit, and no file under it may be modified — a SHA-256 manifest test enforces that. Flugspiel's code sits in sibling modules and drives the game through two reversible instance-property patches on `game.input.update` and `game.update`:

- `fly-bridge.js` — `getState()` / `applyAction(action)` / `human`↔`fly` mode switch / emit loop
- `state-codec.js` — the only place logical↔normalized conversion and state assembly live
- `virtual-input.js` — synthesizes input; in human mode the patch is a pass-through

There is no "headless mode" in the game. Headless operation is a test-side DOM/Canvas stub that lets the real upstream `Game` construct, update and fire without a browser.

### Module 4: Brain Visualization (JavaScript)

Canvas 2D panel showing real-time neuron activity. WebGL and an OffscreenCanvas worker were both measured on #6 and were not faster:

- Neuron map at real soma coordinates, one `ImageData` scatter per pane: brain, VNC, and the unpositioned remainder
- Population raster (scrolling) — rows are **fractions of each superclass**, not per-neuron rows, driven by the per-class counts already on the wire
- Active descending neurons highlighted
- Dopamine / reward pane. #7's honesty clause bans *learn*, *train*, *improve*, *progress*, *better*, *worse*, *performance* and *score* — and their inflections — from this pane's text

Spikes/second and the game score are in the shell's status bar (Module 5), not in this panel: the score never enters the brain snapshot, and the word is forbidden in the dopamine pane.

### Module 5: UI Shell (HTML/CSS/JS)

Split-panel layout. Left: brain viz. Right: the game, as a same-origin iframe. Shared status bar. `src/ui/` holds the shell logic: `shell.js`, `split.js` (divider), `status-bar.js`, `brain-client.js` (the WebSocket client), `game-host.js`, `spike-codec.js` and `spike-rate.js`.

The spike rate is `mean(popcount) × sim_hz`, never × the observed frame rate — the UI samples well under the brain's step rate, so the obvious version under-reports and looks plausible doing it. One implementation, shared by the status bar and the panel footer.

## Boundaries

```
Browser (JS)                          Server (Python)
┌─────────────┐                       ┌────────────────────────┐
│ Game Canvas  │── getState() ──────►  │ Encoder                │
│  (iframe)    │                       │   ↓                    │
│              │                       │ Reward.on_state        │
│              │                       │   ↓                    │
│              │                       │ LIF Brain Step         │
│              │                       │   ↓                    │
│              │◄── applyAction() ──── │ Decoder                │
└─────────────┘                       └────────────────────────┘
┌─────────────┐
│ Brain Viz   │◄── frame (action + snapshot) ── (same WebSocket)
└─────────────┘

Transport: WebSocket (JSON). The game emits state at its emit rate (20 Hz by default);
the brain steps on the server's own clock (50 Hz by default, `--sim-hz`); frames are
credit-paced at one per accepted state, so the socket carries about the emit rate in each
direction whatever the sim rate is, and uncredited steps are counted in `meta.dropped`.
```

The reward loop runs **before** the step whose synaptic input it changes, not after the decoder: its weight updates and its DAN injection both have to land on the same step, or every update arrives one step late.

## Tech Stack

### Python 3.12+ (brain + server)
LIF simulation with NumPy, plus an optional numba kernel (`requirements-fast.txt`) — numba is an optimisation, not a requirement. **No GPU backend**: `FlyBrain` accepts `auto`, `numba` or `numpy` and rejects anything else. CuPy was scoped out as untestable on this hardware (**superseded**: this document previously listed "optional CuPy for GPU"). FastAPI for the WebSocket server. Python was chosen because fly.ai (the reference implementation) is Python and the connectome data tools are Python-native.

### Vanilla JS + HTML5 Canvas (game + viz)
The source game (missile-attack-aracde-web) is already vanilla JS/Canvas. No frameworks in the shipped frontend — it stays zero-dependency at runtime; `puppeteer` is a dev-only dependency for visual QA.

### WebSocket (bridge)
Low-latency bidirectional communication. JSON messages. Simpler than REST for the continuous game loop.

### MaleCNS v1.0 data (Janelia)
The authoritative connectome dataset. ~1.1 GB download (sha256-pinned in `connectome.py`), builds into a ~205 MB weight matrix. CC-BY license.

## Data Model

### Game State (JS → Python)

Assembled by `state-codec.js:buildState`; `tests/game/fly-bridge.test.js` pins it against a live game.

```json
{
  "seq": 42, "t": 12.5, "phase": "playing", "mode": "fly", "session": 1,
  "score": 1200, "wave": 3, "weapon": 0,
  "base": {"x": 0.5, "health": 0.83, "launchers_alive": 6},
  "launchers": [{"i": 0, "kind": "sam", "x": 0.15, "y": 0.85, "alive": true, "hp": 1.0, "selected": true}],
  "missiles": [{"kind": "missile", "x": 0.5, "y": 0.8, "vx": -0.1, "vy": -0.3}],
  "interceptors": [{"kind": "interceptor", "x": 0.3, "y": 0.5, "vx": 0.0, "vy": -0.6}]
}
```

- Every entity carries a `kind` — 18 upstream classes mapped to stable snake_case names.
- `vx`/`vy` are finite-differenced by the codec, not read off the entity: two upstream classes carry no velocity field at all, so reading them would give the encoder two semantics.
- `weapon` is `launchers.indexOf(selectedLauncher)` and is **-1** when nothing is selected.

**Note on `base`**: the game has no single base object — it has **7 independent launchers** at fixed positions. "Base health" is a *derived aggregate*, `sum(hp) / sum(maxHp)` over all launchers including dead ones. `maxHp` is set once, to 1.0, and never changes, so the denominator is fixed for the session and a destroyed launcher permanently lowers the ceiling. `base.x` is the mean position of the *living* launchers and is **discontinuous** — it step-jumps when one dies.

Two distinct signals, deliberately separated:
- **`base.health`** — continuous, *includes* the inter-wave HP regeneration (gated at `vendor/entities/launcher.js:124`, rate `_recoverRate = 0.15` HP/s at `:76`). Correct as a **sensory** input: the fly should perceive that its defences recovered.
- **`launchers_alive`** — integer 0..7, monotonically decreasing **within a session**; destruction is permanent and nothing revives a launcher. This is the **only** signal the dopamine reward loop may key on.

Reward must never be derived from `base.health`, because inter-wave regeneration would generate a steady positive reward unrelated to the fly's behaviour — reward hacking introduced by us, invalidating any learning claim.

### Brain Action (Python → JS)

```json
{"action": "fire", "x": 0.65, "y": 0.2}
```

`action` is one of `fire`, `aim` or `noop`; `x`/`y` accompany only `fire` and `aim`. `weapon_switch` is an integer 0..6 and is **present only when a switch is commanded** — never `null`. `FlyBridge` also accepts `hold_fire` and `release_fire`, which the decoder does not currently emit. `applyAction` never throws on action data; it returns `{ok}`, `{ok, clamped}` or `{ok: false, reason}`.

### Frame (Python → JS)

The spike vector is packbits + base64 on the wire, never a literal array: a literal `[1, 0, 0, 1, ...]` over 166,700 neurons costs one to two orders of magnitude more bytes and more serialisation time per frame — a large fraction of the AC2 latency budget in one field — and the ratio holds at every activity level, since both forms are dense. Measured on #4; see that issue for the command. **`#4`'s spec §3 is the normative schema** — this is a summary, and where the two disagree the spec wins.

```json
{
  "type": "frame",
  "step": 1042,
  "ack_seq": 42,
  "session": 1,
  "action": {"action": "fire", "x": 0.65, "y": 0.2},
  "snapshot": {
    "step": 1042,
    "spikes": {"n": 166700, "bits": "<base64 of np.packbits(spikes)>"},
    "regions": {"<superclass>": 137},
    "descending": {"aim_index": 0.0, "aim_cmd": 0.0, "crosshair_x": 0.5, "aim_zero": null,
                   "fire_hz": 0.0, "weapon_hz": 0.0, "y_source": "default",
                   "halted": false, "stats": {}, "active": [12, 880]},
    "reward": {"enabled": true, "value": 0.0, "source": "...", "cumulative": 0.0, "...": "..."},
    "meta": {"sim_hz": 50.0, "dropped": 0, "rejected": 0, "unassigned": 0, "errors": {}}
  }
}
```

- `regions` is one **integer count per superclass** (27 of them), not a float array per group.
- `descending` is the decoder's telemetry plus `active`, the indices of descending neurons that fired. It is **not** a per-neuron rate map, and no `DNa02_L` / `DNa02_R` / `DNp01` fields exist on the wire (**superseded**: this document previously showed them).
- `reward` is an object, not a scalar.
- `session` is on the frame; the snapshot carries `meta`.

`session` increments on every `start()`. It exists because the `gameover` phase can last a single frame, so a consumer can observe `launchers_alive` jump 1 -> 7 with no `gameover` sample between. **Any reward derived from `launchers_alive` must be discarded across a `session` change, not differenced through it** — otherwise a missed boundary reads as a large spontaneous reward.

## Design Principles

- **Real biology, not fake**: The connectome wiring is the actual MaleCNS map. The neuron model is the standard LIF used in computational neuroscience. No shortcuts.
- **Reservoir computing**: The connectome is never trained. Only the encoder (input mapping) and decoder (output mapping) are designed. The one exception is deliberate and bounded: the dopamine loop modulates the KC→MBON edges in place, per the biological reward pathway, clamped to a configured `[w_min, w_max]` — no other weight in `W` moves.
- **Separation of concerns**: The vendored game knows nothing about neurons, and a hash manifest enforces that. `encoder.py` and `decoder.py` are the only modules that know both sides — the encoder reads `missiles`, `launchers` and `base` by name. The LIF core knows nothing about the game.
- **Observable**: Every neuron spike is on the wire every frame — all 166,700 bits, packed. The system is transparent, not a black box.
- **Honest about what is measured**: no claim of learning, training, improvement or performance may appear in the UI or the README, because none has been measured. The dopamine pane enforces this with a word filter; the README states the negative result outright (#47 fixed the one place that did not). See below.

## Measured limits

These are properties of what shipped, not aspirations. Each was measured; the figures, commands and dates are on the issue named.

- **The aim path does not see azimuth (#40).** The only visual channel that reaches a descending neuron is looming, and the encoder injects it as two scalars — one per side — applied identically to every LC4/LPLC2 neuron in that side's population. Within-hemifield azimuth is therefore destroyed before the brain sees it. A retinotopic injection recovers it; the shipped encoder is at chance. This is a defect in our encoding, **not** a limit of the substrate.
- **DNa02 carries no side information (#40).** It ships as the steering readout (`aim.types`), and it is one neuron per side, but its left/right rate difference does not separate left from right threats. Other descending neurons do, by a wide margin. Any description of DNa02 as a *working* steering signal is false.
- **The reward loop does not reach the readouts (#7).** It modulates KC→MBON efficacy; DNp01 receives none of its input from MBONs. It is a biologically-shaped modulation that is observable in the dopamine pane and must never be called learning.
- **The reservoir is not low-dimensional (#29).** Participation ratio keeps growing with the observation window and does not saturate, so "the dynamics collapse" does not explain the aim failure. KC saturation is real and exact, but the LC4/LPLC2→DN path does not route through the mushroom body.
- **The weapon channel ships disabled (#27).** Its readout under full threat is the same distribution as its resting noise, so it would be a coin flip presented as a decision.
- **The fire channel is monotone in threat (#25).** It was anti-correlated with threat before that fix.
