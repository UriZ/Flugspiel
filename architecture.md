# Architecture

## Overview

Flugspiel connects the MaleCNS v1.0 fruit fly connectome (166,700 neurons, 25.6M synapses) to arcade games via a reservoir computing approach. The biological wiring runs as a leaky integrate-and-fire simulation in Python; a WebSocket bridge streams game state in and actions out; the browser renders the game and brain visualization side by side.

## Modules

### Module 1: Brain Simulation (Python)

Loads the MaleCNS v1.0 connectome data, builds the signed weight matrix, and runs the LIF neuron model. Stateless per-step: receives encoded sensory input, propagates one simulation step, returns motor neuron activity.

- `connectome.py` — download + parse Janelia data → weights.npz, brain.npz
- `lif.py` — leaky integrate-and-fire step: `v ← decay·v + gain·W·spikes + tonic + noise`
- `encoder.py` — game state JSON → sensory neuron activation vector
- `decoder.py` — descending neuron activity → game action JSON
- `reward.py` — dopamine modulation: PAM neurons (reward) / PPL neurons (punishment)

### Module 2: WebSocket Server (Python)

FastAPI + WebSocket endpoint bridging the browser and the brain simulation. Receives game state, runs one brain step, returns actions + neuron activity snapshot for visualization.

### Module 3: Arcade Game (JavaScript)

Forked from UriZ/missile-attack-aracde-web. Extended with:
- `getState()` — returns current game state as JSON (missiles, base, score, etc.)
- `applyAction(action)` — applies a fly-brain action (click at x,y / switch weapon)
- Headless mode — game logic runs without requiring user input

### Module 4: Brain Visualization (JavaScript)

Canvas 2D / WebGL panel showing real-time neuron activity:
- Region-colored neuron map (sensory, central, motor clusters)
- Spike raster plot (scrolling)
- Active descending neurons highlighted
- Stats overlay: spikes/sec, reward history, game score over time

### Module 5: UI Shell (HTML/CSS)

Split-panel layout. Left: brain viz. Right: game canvas. Shared status bar.

## Boundaries

```
Browser (JS)                          Server (Python)
┌─────────────┐                       ┌──────────────────┐
│ Game Canvas  │── getState() ──────►  │ Encoder          │
│              │                       │   ↓              │
│              │                       │ LIF Brain Step   │
│              │                       │   ↓              │
│              │◄── applyAction() ──── │ Decoder          │
└─────────────┘                       │   ↓              │
                                      │ Reward (optional)│
┌─────────────┐                       └──────────────────┘
│ Brain Viz   │◄── neuron snapshot ──── (same WebSocket)
└─────────────┘

Transport: WebSocket (JSON), ~20-60 messages/sec
```

## Tech Stack

### Python 3.12+ (brain + server)
LIF simulation with NumPy/numba for CPU, optional CuPy for GPU. FastAPI for the WebSocket server. Chosen because fly.ai (the reference implementation) is Python and the connectome data tools are Python-native.

### Vanilla JS + HTML5 Canvas (game + viz)
The source game (missile-attack-aracde-web) is already vanilla JS/Canvas. No reason to add frameworks — keeps the frontend zero-dependency and fast.

### WebSocket (bridge)
Low-latency bidirectional communication. JSON messages. Simpler than REST for the continuous game loop.

### MaleCNS v1.0 data (Janelia)
The authoritative connectome dataset. ~1.1 GB download, builds into ~205 MB weight matrix. CC-BY license.

## Data Model

### Game State (JS → Python)
```json
{
  "missiles": [{"x": 0.5, "y": 0.8, "vx": -0.1, "vy": -0.3}],
  "base": {"x": 0.5, "health": 0.8},
  "interceptors": [{"x": 0.3, "y": 0.5}],
  "weapon": 0,
  "score": 1200,
  "wave": 3
}
```

### Brain Action (Python → JS)
```json
{
  "action": "fire",
  "x": 0.65,
  "y": 0.2,
  "weapon_switch": null
}
```

### Neuron Snapshot (Python → JS, for viz)
```json
{
  "spikes": [1, 0, 0, 1, ...],
  "regions": {"sensory": [0.2, ...], "central": [...], "motor": [...]},
  "descending": {"DNa02_L": 0.8, "DNa02_R": 0.1, "DNp01": 0.95},
  "reward": 0.3,
  "step": 1042
}
```

## Design Principles

- **Real biology, not fake**: The connectome wiring is the actual MaleCNS map. The neuron model is the standard LIF used in computational neuroscience. No shortcuts.
- **Reservoir computing**: The brain is frozen — no weight training. Only the encoder (input mapping) and decoder (output mapping) are designed. The dopamine loop modulates KC→MBON weights per the biological reward pathway.
- **Separation of concerns**: The game knows nothing about neurons. The brain knows nothing about missiles. The encoder/decoder are the only coupling points.
- **Observable**: Every neuron spike is available for visualization. The system is transparent, not a black box.
