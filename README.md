# Flugspiel

A fruit fly brain playing arcade games.

Flugspiel wires the [MaleCNS v1.0](https://male-cns.janelia.org/) connectome (166,700 neurons, 25.6M synapses) to arcade games as a reservoir computer. The biological wiring drives gameplay through leaky integrate-and-fire simulation — no ML training, just real neural topology producing emergent behavior.

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

# Start the server
python src/server/ws_server.py

# Open in browser
npx serve .
# Navigate to http://localhost:3000
```

## Architecture

See [architecture.md](architecture.md) for the full system design.

## Credits

- Connectome data: [MaleCNS v1.0](https://male-cns.janelia.org/) (Google Research + HHMI Janelia), CC-BY 4.0
- Reference implementations: [fly.ai](https://github.com/alextitonis/fly.ai), [snedea/flybrain](https://github.com/snedea/flybrain), [stonkfly](https://github.com/nftechie/stonkfly)
- Game: [Missile Attack](https://github.com/UriZ/missile-attack-aracde-web)
