# Flugspiel

A fruit fly brain playing arcade games.

Flugspiel wires the [MaleCNS v1.0](https://male-cns.janelia.org/) connectome (166,700 neurons, 25.6M connections / 124M synapses) to arcade games as a reservoir computer. The biological wiring drives gameplay through leaky integrate-and-fire simulation — no ML training, just real neural topology producing emergent behavior.

Split-panel UI: watch the brain fire on the left while the fly plays [Missile Attack](https://github.com/UriZ/missile-attack-aracde-web) on the right.

## How It Works

1. **Game state** (missile positions, base health, score) is encoded into the fly's sensory neurons
2. **166,700 LIF neurons** propagate signals through the real connectome wiring
3. **Descending neurons** (steering, escape, walk) are decoded into game actions (aim, fire, switch weapon)
4. **Dopamine reward loop** reinforces successful interceptions

## Quick Start

```bash
# Clone
git clone https://github.com/UriZ/Flugspiel.git
cd Flugspiel

# Build the brain (downloads ~1.1 GB connectome data)
pip install -r requirements.txt
python src/brain/connectome.py

# Start the brain server (loads the connectome; ~6-10 s before it accepts)
python src/server/ws_server.py

# Serve the repo root in a second terminal — the UI needs a real origin
python3 -m http.server 8080
```

Then open **http://localhost:8080/index.html**.

## Running the UI

The shell is two panels and a status bar: the brain visualization on the left, the real
game in a same-origin `<iframe>` on the right, and `brain / step / score / spikes-per-second`
underneath. Drag the divider to resize; below 768 px the panels stack.

To hand the game to the fly: click **mode: human** to switch to fly mode, then **start**.
`applyAction` is rejected outside a live round, so the loop does nothing until a round is
running. Keys reach the game only once you have clicked inside the game panel.

- `file://` does not work — ES modules and the same-origin `contentWindow` access the
  loop depends on both need a real origin. Any static server will do, but serve the
  **repo root**, not `src/`, so `assets/` and `game.html` resolve.
- The shell connects to `ws://127.0.0.1:8000/brain` by default. If the brain server is on
  another port, append `?brain=ws://127.0.0.1:8111/brain`. The override is restricted to
  loopback; anything else is ignored with a console warning.
- It is normal for the status bar to read `reconnecting in Ns` for the first several
  seconds — uvicorn does not accept connections until the connectome has loaded. There is
  no `/healthz` poll: that endpoint is unreachable from a browser (no CORS middleware), so
  the WebSocket handshake itself is the readiness probe.
- Opening a second tab evicts the first (the server is newest-wins). The evicted tab says
  `taken by another tab` and **does not** reconnect on its own — two auto-reconnecting
  tabs would evict each other forever. Use its `reconnect` button to take the brain back.
- `game.html` is still the standalone human-play page and is unchanged.

`window.flugspiel` is the console handle (`.bridge`, `.client`, `.panel`); the game's own
`window.bridge` is reachable as `document.getElementById('game-frame').contentWindow.bridge`.

## Architecture

See [architecture.md](architecture.md) for the full system design.

## Credits

- Connectome data: [MaleCNS v1.0](https://male-cns.janelia.org/) (Google Research + HHMI Janelia), CC-BY 4.0
- Reference implementations: [fly.ai](https://github.com/alextitonis/fly.ai), [snedea/flybrain](https://github.com/snedea/flybrain), [stonkfly](https://github.com/nftechie/stonkfly)
- Game: [Missile Attack](https://github.com/UriZ/missile-attack-aracde-web) — vendored verbatim into `src/game/vendor/` @ `458c3fb` (ISC); see [src/game/VENDOR.md](src/game/VENDOR.md)
