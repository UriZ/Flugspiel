# Backlog

The backlog is the starting point for all work. The user adds items here, and the TL picks them up, creates GitHub issues with acceptance criteria, and runs them through the pipeline.

## How it works

1. **User adds items** to this file — features, bugs, ideas, improvements
2. **TL reads the backlog** at the start of each session
3. **TL prioritizes** — picks the next item(s) to work on based on priority and dependencies
4. **TL creates GitHub issues** — with acceptance criteria, labels, and assigns to architect
5. **Item moves through pipeline** — architect → judge → developer → judge → QA → judge → done
6. **TL updates backlog** — marks items as done, adds new items discovered during work

## Format

```markdown
## Priority: High / Medium / Low

### [Short title]
[Description of what's needed. Be specific about the desired outcome.]

**Acceptance criteria:**
- [ ] [What must be true when this is done]
- [ ] [What must be true when this is done]

**Notes:** [optional context, constraints, references]
**Status:** new / in-progress (#issue) / done (#issue)
```

---

## Priority: High

### Connectome loader + LIF brain engine
Download MaleCNS v1.0 data from Janelia, build the signed weight matrix (166,700 neurons, 25.6M synapses), and implement the leaky integrate-and-fire simulation step. Reference fly.ai's `build_brain.py` and LIF model.

**Acceptance criteria:**
- [ ] Downloads connectome data (~1.1 GB) from public Janelia sources
- [ ] Builds weights.npz (~205 MB signed connection matrix) and brain.npz (neuron metadata)
- [ ] LIF step runs: `v ← decay·v + gain·W·spikes + tonic + noise`, spike at threshold 1, reset
- [ ] Neurotransmitter signs correct: GABA/glutamate/histamine inhibitory, rest excitatory
- [ ] Can run at least 10 steps/sec on CPU (16GB RAM machine)
- [ ] Unit tests for LIF dynamics (single neuron, small network)

**Notes:** Reference https://github.com/alextitonis/fly.ai for data sources and LIF implementation. Data under CC-BY 4.0.
**Status:** new

### Game state API for Missile Attack
Fork/integrate UriZ/missile-attack-aracde-web and add a programmatic interface: `getState()` returns game state as JSON, `applyAction(action)` applies fly-brain decisions. Game must still be playable by a human.

**Acceptance criteria:**
- [ ] `getState()` returns: missile positions/velocities, base position/health, active interceptors, current weapon, score, wave
- [ ] `applyAction({action, x, y, weapon_switch})` fires interceptor at (x,y) or switches weapon
- [ ] Game runs in "fly mode" (actions come from WebSocket) or "human mode" (normal mouse/keyboard)
- [ ] Game loop emits state at configurable rate (default 20 Hz)
- [ ] Human can still play normally when fly mode is off
- [ ] No changes to core game mechanics

**Notes:** Source: https://github.com/UriZ/missile-attack-aracde-web. Vanilla JS, Canvas 2D, zero deps.
**Status:** new

### Encoder + Decoder
Map game state onto the fly's sensory neurons (encoder) and map descending neuron activity to game actions (decoder). This is the core integration layer.

**Acceptance criteria:**
- [ ] Encoder maps missile positions to photoreceptor activations (~6,006 neurons) as a 1D panoramic view
- [ ] Encoder fires looming detectors (LC4/LPLC2) when missiles approach fast
- [ ] Encoder maps base health to drive/hunger neurons
- [ ] Decoder reads DNa02 L/R for aim direction, DNp01 for fire, DNg100/MDN for weapon cycling
- [ ] Encoder/decoder are configurable (mapping can be tuned without changing brain or game code)
- [ ] Unit tests for encoding roundtrip and decoder output ranges

**Notes:** Reference fly.ai's visual input system and motor output mapping.
**Status:** new

### WebSocket server + bridge
FastAPI WebSocket server that receives game state, runs one brain step, returns actions + neuron snapshot for visualization.

**Acceptance criteria:**
- [ ] WebSocket endpoint accepts game state JSON, returns action + neuron snapshot
- [ ] End-to-end latency under 50ms per step
- [ ] Handles connect/disconnect/reconnect gracefully
- [ ] Neuron snapshot includes: spike vector, region summaries, descending neuron activations, reward signal, step count
- [ ] Server starts with `python src/server/ws_server.py`
- [ ] Integration test: send mock game state, receive valid action

**Notes:** FastAPI + uvicorn. JSON messages.
**Status:** new

## Priority: Medium

### Split-panel UI shell
HTML layout with left panel (brain viz) and right panel (game canvas). Shared status bar with connection state, step count, score.

**Acceptance criteria:**
- [ ] Split layout: left = brain viz, right = game, resizable divider
- [ ] Status bar shows: connection status, brain step count, game score, spikes/sec
- [ ] Panels stack vertically on narrow screens (<768px)
- [ ] Dark theme (#0a0a0a background)
- [ ] Both panels render at 30+ fps

**Notes:** Vanilla HTML/CSS/JS. No frameworks.
**Status:** new

### Brain visualization panel
Real-time visualization of neuron activity: region-colored neuron map, spike raster, descending neuron indicators, reward history.

**Acceptance criteria:**
- [ ] Neuron map shows clusters by region (sensory/central/motor) with activity as brightness
- [ ] Spike raster scrolls showing recent firing patterns
- [ ] Descending neurons labeled and highlighted when active
- [ ] Reward/punishment signal visualized (green for reward, red for punishment)
- [ ] Stats: spikes/sec, active neuron %, step count
- [ ] Renders at 30+ fps with full 166k neuron data

**Notes:** Canvas 2D or WebGL. Reference snedea/flybrain for browser-based neural viz approach.
**Status:** new

### Dopamine reward loop
Implement reinforcement via the fly's biological dopamine pathway: PAM neurons for reward (missile intercepted), PPL neurons for punishment (base hit). Modulates KC→MBON synaptic weights.

**Acceptance criteria:**
- [ ] PAM11 dopamine neurons (~15) fire on missile interception events
- [ ] PPL101 aversive neurons (~2) fire on base damage events
- [ ] KC→MBON synaptic weights update based on dopamine signal
- [ ] Reward signal included in neuron snapshot for visualization
- [ ] Can be toggled on/off (brain works without reward loop)
- [ ] Unit test: verify weight modulation direction (reward strengthens, punishment weakens)

**Notes:** Reference stonkfly's dopamine implementation. Note their disclaimer: weight changes don't guarantee learning.
**Status:** new

## Priority: Low

### Alternative game modes
Support connecting the fly brain to other simple arcade games beyond Missile Attack — e.g., a simple Pong, Space Invaders clone, or After Burner-style game.

**Acceptance criteria:**
- [ ] Encoder/decoder abstraction supports multiple games via config
- [ ] At least one additional game implemented with state API
- [ ] Game selector in UI

**Notes:** Stretch goal. Encoder/decoder design should anticipate this from the start.
**Status:** new

---

## Done

<!-- TL moves completed items here with issue references -->
