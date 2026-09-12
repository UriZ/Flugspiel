import { clamp } from './utils.js';

/**
 * @typedef {{ time: number, type: string }} WaveEvent
 */

/**
 * WaveSystem — manages wave timing, event scheduling, and enemy spawning.
 * Translated from main.gd wave logic.
 */
export class WaveSystem {
  constructor() {
    this.waveNumber = 0;
    this.waveTimer = 0;
    /** @type {WaveEvent[]} */
    this.waveEvents = [];
    this.inBetweenWave = true;
    this.betweenWaveTimer = 0;

    /** @type {((wave: number) => void) | null} */
    this.onWaveStart = null;
    /** @type {((wave: number) => void) | null} */
    this.onWaveComplete = null;

    /** Duration (seconds) of the most recently generated wave. */
    this._waveDuration = 10;
  }

  /** Begin with 2.5s grace period before wave 1. */
  start() {
    this.waveNumber = 0;
    this.waveTimer = 0;
    this.waveEvents = [];
    this.inBetweenWave = true;
    this.betweenWaveTimer = 2.5;
  }

  /**
   * @param {number} dt
   * @param {(type: string) => void} spawnFn
   * @param {() => number} getEnemyCount — returns living enemy count (called after spawns)
   */
  update(dt, spawnFn, getEnemyCount) {
    if (this.inBetweenWave) {
      this.betweenWaveTimer -= dt;
      if (this.betweenWaveTimer <= 0) {
        this._startWave(this.waveNumber + 1);
      }
    } else {
      this.waveTimer += dt;

      // Fire all events whose time has been reached
      while (this.waveEvents.length > 0 && this.waveEvents[0].time <= this.waveTimer) {
        const event = this.waveEvents.shift();
        spawnFn(event.type);
      }

      // Wave complete when all events fired and no enemies remain
      // Count is fetched AFTER spawns so newly-spawned enemies are included
      if (this.waveEvents.length === 0 && getEnemyCount() === 0) {
        this._onWaveComplete();
      }
    }
  }

  getCurrentWave() {
    return this.waveNumber;
  }

  /**
   * Generate randomized event list for a wave. Difficulty scales with wave
   * number but specific enemy counts, types, and timing are randomized.
   * @param {number} wave — 1-based
   * @returns {WaveEvent[]}
   */
  generateWaveEvents(wave) {
    const events = [];
    const rng = () => Math.random();

    // ── Difficulty budget: randomized ±30% so waves feel different ──
    const baseBudget = 6 + wave * 4;
    const budget = Math.round(baseBudget * (0.7 + rng() * 0.6));

    const costs = {
      missile:         1,
      super_missile:   3,
      drone:           2,
      suicide_drone:   3,
      transport_plane: 5,
      nuke:            6,
      attack_quad:     4,
      kamikaze_quad:   3,
      shock_missile:   3,
    };

    // ── Weighted pool with jittered unlock thresholds ──
    // Each entry: [type, minWave, weight]
    // Weight controls how likely each type is to be picked
    const poolDefs = [
      ['missile',         1, 3],
      ['transport_plane', 1, 1],
      ['super_missile',   2, 2],
      ['drone',           2, 2],
      ['suicide_drone',   3, 2],
      ['nuke',            3, 1],
      ['attack_quad',     2, 1.5],
      ['kamikaze_quad',   2, 1.5],
      ['shock_missile',   3, 1.5],
    ];

    // Build weighted pool — jitter thresholds by ±1 wave for variety
    const pool = [];
    const weights = [];
    for (const [type, minWave, weight] of poolDefs) {
      const jitter = minWave <= 1 ? 0 : (rng() < 0.3 ? -1 : rng() < 0.15 ? 1 : 0);
      if (wave >= minWave + jitter) {
        pool.push(type);
        // Missiles become less dominant in later waves
        const w = type === 'missile' ? Math.max(1, weight - Math.floor(wave / 4)) : weight;
        weights.push(w);
      }
    }

    // Weighted random selection helper
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const pickRandom = () => {
      let r = rng() * totalWeight;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) return pool[i];
      }
      return pool[pool.length - 1];
    };

    // ── Spend the budget randomly ──
    let remaining = budget;

    // Small guaranteed minimum — just 2 missiles so there's always something
    const minMissiles = Math.min(2, budget);
    for (let i = 0; i < minMissiles; i++) {
      events.push({ time: 0, type: 'missile' });
      remaining -= costs.missile;
    }

    // Maybe a nuke from wave 3+ (50-70% chance, not guaranteed every wave)
    if (wave >= 3 && rng() < 0.5 + wave * 0.025) {
      events.push({ time: 0, type: 'nuke' });
      remaining -= costs.nuke;
    }

    // Fill remaining budget with weighted random picks
    let safety = 100;
    while (remaining > 0 && safety-- > 0) {
      const type = pickRandom();
      const cost = costs[type];
      if (cost > remaining) {
        if (remaining >= costs.missile) {
          events.push({ time: 0, type: 'missile' });
          remaining -= costs.missile;
        } else {
          break;
        }
      } else {
        events.push({ time: 0, type: type });
        remaining -= cost;
      }
    }

    // ── Assign random timing ──
    // Wave duration scales with enemy count but has bounds
    const waveDuration = Math.max(10, Math.min(events.length * 1.5, 40));
    this._waveDuration = waveDuration;

    for (const event of events) {
      event.time = rng() * waveDuration;
    }

    // Spread nukes to the back half of the wave (more dramatic)
    for (const event of events) {
      if (event.type === 'nuke') {
        event.time = waveDuration * 0.4 + rng() * waveDuration * 0.5;
      }
      // Transport planes can come any time — slight bias toward middle of wave
      if (event.type === 'transport_plane') {
        event.time = waveDuration * 0.2 + rng() * waveDuration * 0.6;
      }
    }

    events.sort((a, b) => a.time - b.time);
    return events;
  }

  _startWave(wave) {
    this.waveNumber = wave;
    this.waveTimer = 0;
    this.waveEvents = this.generateWaveEvents(wave);
    this.inBetweenWave = false;
    if (this.onWaveStart) this.onWaveStart(this.waveNumber);
  }

  _onWaveComplete() {
    this.inBetweenWave = true;
    this.betweenWaveTimer = 3.0;
    if (this.onWaveComplete) this.onWaveComplete(this.waveNumber);
  }
}
