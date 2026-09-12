// Procedural Audio Engine — Web Audio API
// Translates Godot PCM generation math to Float32 AudioBuffers

const TAU = 2 * Math.PI;
const LOOP_FADE_SAMPLES = 256;

/** @param {number} a @param {number} b */
function randf(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * Apply linear fade at loop boundaries to prevent noise clicks.
 * @param {Float32Array} data
 * @param {number} n — ramp length in samples
 */
function applyLoopCrossfade(data, n) {
  const len = data.length;
  for (let i = 0; i < n; i++) {
    const ramp = i / n;
    data[i] *= ramp;
    data[len - 1 - i] *= ramp;
  }
}

/** Compute stereo pan from world x position (viewport width 2560) */
function panFromX(x) {
  return Math.max(-1, Math.min(1, (x / 1280) - 1));
}

// ---------------------------------------------------------------------------
// SoundLoop — wraps a looping AudioBufferSourceNode with dynamic controls
// ---------------------------------------------------------------------------
class SoundLoop {
  /**
   * @param {AudioContext} audioCtx
   * @param {AudioBuffer} buffer
   * @param {number} volume  — linear gain (default 1.0)
   * @param {number} pitch   — playback rate (default 1.0)
   * @param {number} pan     — stereo pan -1..1 (default 0)
   */
  constructor(audioCtx, buffer, volume = 1.0, pitch = 1.0, pan = 0) {
    this.audioCtx = audioCtx;
    this.source = audioCtx.createBufferSource();
    this.gain = audioCtx.createGain();
    this.panner = audioCtx.createStereoPanner();

    this.source.buffer = buffer;
    this.source.loop = true;
    this.source.playbackRate.value = pitch;
    this.gain.gain.value = volume;
    this.panner.pan.value = pan;

    this.source.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(audioCtx.destination);

    this.source.start();
    this.stopped = false;
  }

  stop() {
    if (!this.stopped) {
      this.stopped = true;
      try { this.source.stop(); } catch (_) { /* already stopped */ }
    }
  }

  /** @param {number} rate */
  setPitch(rate) {
    if (!this.stopped) this.source.playbackRate.value = rate;
  }

  /** @param {number} vol — linear gain */
  setVolume(vol) {
    if (!this.stopped) this.gain.gain.value = vol;
  }

  /** @param {number} pan — -1..1 */
  setPan(pan) {
    if (!this.stopped) this.panner.pan.value = Math.max(-1, Math.min(1, pan));
  }

  /** @param {{ pitch?: number, volume?: number, pan?: number }} opts */
  update(opts) {
    if (this.stopped) return;
    if (opts.pitch !== undefined) this.source.playbackRate.value = opts.pitch;
    if (opts.volume !== undefined) this.gain.gain.value = opts.volume;
    if (opts.pan !== undefined) this.panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
  }
}

// ---------------------------------------------------------------------------
// Audio — main public class
// ---------------------------------------------------------------------------
export class Audio {
  constructor() {
    /** @type {AudioContext|null} */
    this.audioCtx = null;

    // Pre-generated buffers
    this.explosionBuffer = null;
    this.megaExplosionBuffer = null;
    this.launchBuffer = null;
    this.heatSeekerLaunchBuffer = null;
    this.motorLoopBuffer = null;
    this.spoolLoopBuffer = null;
    this.vulkanShotBuffer = null;
    this.nukeWarningBuffer = null;
    this.targetAcquiredBuffer = null;
    this.shieldActivationBuffer = null;
    this.shieldDeflectBuffer = null;
    this.shieldNukeHitBuffer = null;
    this.shieldWarningBuffer = null;
    this.quadBuzzBuffer = null;

    // Laser sounds
    this.laserWarmUpBuffer = null;
    this.laserFiringLoopBuffer = null;
    this.laserHitBuffer = null;

    // Shock Blast sounds
    this.shockZapBuffer = null;

    this.radioChatterBuffers = [];
    this._radioChatterLoaded = false;
    this._chatterPlaying = false;

    this._initialized = false;

  }

  // -----------------------------------------------------------------------
  // Initialization — call on first user click to satisfy autoplay policy
  // -----------------------------------------------------------------------
  init() {
    if (this._initialized) return;
    this._initialized = true;

    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume in case the browser started the context suspended
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    this.explosionBuffer = this._generateExplosionBuffer(false);
    this.megaExplosionBuffer = this._generateExplosionBuffer(true);
    this.launchBuffer = this._generateLaunchBuffer();
    this.heatSeekerLaunchBuffer = this._generateHeatSeekerLaunchBuffer();
    this.motorLoopBuffer = this._generateMotorBuffer();
    this.spoolLoopBuffer = this._generateSpoolBuffer();
    this.vulkanShotBuffer = this._generateVulkanShotBuffer();
    this.nukeWarningBuffer = this._generateNukeWarningBuffer();
    this.targetAcquiredBuffer = this._generateTargetAcquiredBuffer();
    this.shieldActivationBuffer = this._generateShieldActivationBuffer();
    this.shieldDeflectBuffer = this._generateShieldDeflectBuffer();
    this.shieldNukeHitBuffer = this._generateShieldNukeHitBuffer();
    this.shieldWarningBuffer = this._generateShieldWarningBuffer();

    // Drone buzz
    this.quadBuzzBuffer = this._generateQuadBuzzBuffer();

    // Laser sounds
    this.laserWarmUpBuffer      = this._generateLaserWarmUpBuffer();
    this.laserFiringLoopBuffer  = this._generateLaserFiringLoopBuffer();
    this.laserHitBuffer         = this._generateLaserHitBuffer();

    // Shock Blast sounds
    this.shockZapBuffer = this._generateShockZapBuffer();

    this._loadRadioChatter();
    this._loadThunder();
  }


  async _loadThunder() {
    try {
      const resp = await fetch('assets/radio/lightning.wav');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      this._thunderBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
      console.warn('Failed to load lightning.wav:', e);
      this._thunderBuffer = null;
    }
  }

  async _loadRadioChatter() {
    const RADIO_DIR = 'assets/radio/';
    let filenames = [];

    try {
      // Try fetching directory listing (works with most static HTTP servers)
      const response = await fetch(RADIO_DIR);
      if (response.ok) {
        const html = await response.text();
        // Parse HTML directory listing for .mp3 links
        const regex = /href="([^"]+\.mp3)"/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
          // Extract just the filename (strip any path prefix)
          const filename = match[1].split('/').pop();
          // Skip the music track — it's not a radio chatter clip
          if (filename.toLowerCase().includes('missile strike')) continue;
          filenames.push(filename);
        }
      }
    } catch (e) {
      console.warn('Could not fetch radio directory listing:', e);
    }

    // Fallback: hardcoded list if directory listing didn't work
    if (filenames.length === 0) {
      filenames = [
        'on-my-six.mp3', 'live-one.mp3', 'tango.mp3', 'fox-two.mp3',
        'bogie.mp3', 'canopy.mp3', 'eyes-on-sky.mp3', 'breaks.mp3',
      ];
    }

    // Load all discovered clips in parallel
    const results = await Promise.allSettled(
      filenames.map(async (name) => {
        const resp = await fetch(RADIO_DIR + name);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${name}`);
        const arrayBuffer = await resp.arrayBuffer();
        return this.audioCtx.decodeAudioData(arrayBuffer);
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.radioChatterBuffers.push(result.value);
      } else {
        console.warn('Failed to load radio clip:', result.reason);
      }
    }

    this._radioChatterLoaded = this.radioChatterBuffers.length > 0;
  }

  // -----------------------------------------------------------------------
  // Playback API
  // -----------------------------------------------------------------------

  /**
   * One-shot explosion, panned by x position.
   * @param {number} x — world x (0..2560)
   * @param {boolean} isMega
   */
  playExplosion(x, isMega = false) {
    if (!this.audioCtx) return;
    const buffer = isMega ? this.megaExplosionBuffer : this.explosionBuffer;
    // Godot: volume_db = 6 (normal) or 10 (mega), pitch 0.75..1.05
    const volumeDb = isMega ? 10.0 : 6.0;
    const pitch = randf(0.75, 1.05);
    this._playBuffer(buffer, volumeDb, pitch, panFromX(x));
  }

  /**
   * One-shot launch sound.
   * @param {number} x — world x
   * @param {'missile'|'heatseeker'} type
   */
  playLaunch(x, type = 'sam') {
    if (!this.audioCtx) return;
    if (type === 'heatseeker') {
      // Godot: volume_db = 3, pitch 0.94..1.06
      this._playBuffer(this.heatSeekerLaunchBuffer, 3.0, randf(0.94, 1.06), panFromX(x));
    } else {
      // Godot: volume_db = 2, pitch 0.90..1.10
      this._playBuffer(this.launchBuffer, 2.0, randf(0.90, 1.10), panFromX(x));
    }
  }

  /**
   * One-shot vulkan shot crack.
   * @param {number} x — world x
   */
  playVulkanShot(x) {
    if (!this.audioCtx) return;
    // Godot: volume_db = randf(-3,0), pitch = randf(0.85,1.15)
    this._playBuffer(this.vulkanShotBuffer, randf(-3.0, 0.0), randf(0.85, 1.15), panFromX(x));
  }

  /**
   * One-shot nuke incoming warning siren.
   * @param {number} x — world x (spawn position)
   */
  playNukeWarning(x) {
    if (!this.audioCtx) return;
    this._playBuffer(this.nukeWarningBuffer, 8.0, 1.0, panFromX(x));
  }

  /**
   * Procedural "target acquired" ascending radar-ping cue (~0.3s).
   * Two quick beeps ascending in pitch with slight reverb tail, military/tactical feel.
   */
  playTargetAcquired() {
    if (!this.audioCtx) return;
    this._playBuffer(this.targetAcquiredBuffer, 6.0, randf(0.97, 1.03), 0);
  }

  /**
   * Rising sweep 200→2000 Hz over 0.3s + noise burst — shield activation.
   */
  playShieldActivation() {
    if (!this.audioCtx) return;
    this._playBuffer(this.shieldActivationBuffer, 5.0, 1.0, 0);
  }

  /**
   * Short noise burst + sine chirp — enemy deflected off shield.
   * @param {number} x — world x for stereo pan
   */
  playShieldDeflect(x) {
    if (!this.audioCtx) return;
    this._playBuffer(this.shieldDeflectBuffer, 3.0, randf(0.9, 1.1), panFromX(x));
  }

  /**
   * Distorted low rumble + crackling — nuke punched through shield.
   */
  playShieldNukeHit() {
    if (!this.audioCtx) return;
    this._playBuffer(this.shieldNukeHitBuffer, 7.0, 1.0, 0);
  }

  /**
   * Two quick 800 Hz beeps — shield about to expire.
   */
  playShieldWarningBeeps() {
    if (!this.audioCtx) return;
    this._playBuffer(this.shieldWarningBuffer, 4.0, 1.0, 0);
  }

  /**
   * Quadcopter motor buzz — 85Hz + 170Hz detuned square waves.
   * Short burst (0.05s) to indicate firing or presence.
   * @param {number} x — world x for stereo pan
   */
  playQuadBuzz(x) {
    if (!this.audioCtx) return;
    this._playBuffer(this.quadBuzzBuffer, 0, 1.0, panFromX(x));
  }

  /**
   * Quick high-pitched crack for quad tracer shot (reuses vulkan shot pattern at higher pitch).
   * @param {number} x — world x for stereo pan
   */
  playQuadTracerShot(x) {
    if (!this.audioCtx) return;
    // Vulkan shot at 60% volume (-4.4dB) and higher pitch (1.4x)
    this._playBuffer(this.vulkanShotBuffer, randf(-7.0, -4.0), randf(1.2, 1.6), panFromX(x));
  }

  /**
   * Rising frequency sweep — laser warming up.
   * @param {number} x — world x for stereo pan
   */
  playLaserWarmUp(x) {
    if (!this.audioCtx) return;
    this._playBuffer(this.laserWarmUpBuffer, 2.0, 1.0, panFromX(x));
  }

  /**
   * Start sustained laser firing loop. Returns a SoundLoop handle.
   * @param {number} x — world x for stereo pan
   * @returns {SoundLoop|null}
   */
  startLaserFiringLoop(x) {
    if (!this.audioCtx) return null;
    const volume = Math.pow(10, 1.0 / 20); // +1 dB
    return new SoundLoop(this.audioCtx, this.laserFiringLoopBuffer, volume, 1.0, panFromX(x));
  }

  /**
   * Sharp crack on beam impact.
   * @param {number} x — world x for stereo pan
   */
  playLaserHit(x) {
    if (!this.audioCtx) return;
    this._playBuffer(this.laserHitBuffer, -2.0, randf(0.9, 1.1), panFromX(x));
  }

  /**
   * Play a random radio chatter clip. Returns true if playback started,
   * false if unavailable or already playing (caller should back off).
   * @returns {boolean}
   */
  playRadioChatter() {
    if (!this.audioCtx || !this._radioChatterLoaded || this._chatterPlaying) return false;

    const buffer = this.radioChatterBuffers[
      Math.floor(Math.random() * this.radioChatterBuffers.length)
    ];

    const volumeDb = 8.0;
    const pitch = randf(0.94, 1.06);
    const pan = randf(-0.3, 0.3);

    this._chatterPlaying = true;

    const ctx = this.audioCtx;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    source.buffer = buffer;
    source.playbackRate.value = pitch;
    gain.gain.value = Math.pow(10, volumeDb / 20);
    panner.pan.value = pan;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);

    source.onended = () => { this._chatterPlaying = false; };
    source.start();

    return true;
  }

  /**
   * Thunder — plays lightning.wav from assets/radio/.
   */
  playThunder() {
    if (!this.audioCtx || !this._thunderBuffer) return;
    const ctx = this.audioCtx;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = this._thunderBuffer;
    gain.gain.value = 0.5;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  }

  /**
   * Start heat-seeker motor loop. Returns a SoundLoop handle.
   * @param {number} x — world x
   * @returns {SoundLoop}
   */
  startMotorLoop(x) {
    if (!this.audioCtx) return null;
    // Godot: volume_db = -4, pitch = randf(0.95,1.05)
    const volume = Math.pow(10, -4.0 / 20);
    const pitch = randf(0.95, 1.05);
    return new SoundLoop(this.audioCtx, this.motorLoopBuffer, volume, pitch, panFromX(x));
  }

  /**
   * Start vulkan spool loop. Returns a SoundLoop handle.
   * @param {number} x — world x
   * @returns {SoundLoop}
   */
  startSpoolLoop(x) {
    if (!this.audioCtx) return null;
    // Godot: starts at volume_db = -20
    const volume = Math.pow(10, -20.0 / 20);
    return new SoundLoop(this.audioCtx, this.spoolLoopBuffer, volume, 0.5, panFromX(x));
  }

  /**
   * Stop a continuous loop.
   * @param {SoundLoop|null} handle
   */
  stopLoop(handle) {
    if (handle) handle.stop();
  }

  /**
   * Update a loop's dynamic parameters.
   * @param {SoundLoop|null} handle
   * @param {{ pitch?: number, volume?: number, pan?: number }} opts
   */
  updateLoop(handle, opts) {
    if (handle) handle.update(opts);
  }

  // -----------------------------------------------------------------------
  // Internal: play a one-shot buffer
  // -----------------------------------------------------------------------

  /**
   * @param {AudioBuffer} buffer
   * @param {number} volumeDb — decibels
   * @param {number} pitch — playback rate
   * @param {number} pan — -1..1
   */
  _playBuffer(buffer, volumeDb, pitch, pan) {
    if (!buffer || !this.audioCtx) return;
    const ctx = this.audioCtx;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    source.buffer = buffer;
    source.playbackRate.value = pitch;
    gain.gain.value = Math.pow(10, volumeDb / 20);
    panner.pan.value = Math.max(-1, Math.min(1, pan));

    source.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);
    source.start();
  }

  // -----------------------------------------------------------------------
  // Buffer generation — exact translations from Godot source
  // -----------------------------------------------------------------------

  /**
   * Create an AudioBuffer from Float32 sample data.
   * @param {Float32Array} samples
   * @param {number} sampleRate
   * @returns {AudioBuffer}
   */
  _createBuffer(samples, sampleRate) {
    const buffer = this.audioCtx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  // -- Explosion (from explosion.gd play_explosion_sound) ------------------
  _generateExplosionBuffer(isMega) {
    const sampleRate = 22050;
    const duration = isMega ? 1.1 : 0.7;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    const bassFreq = isMega ? 22.0 : 35.0;
    const subFreq = isMega ? 12.0 : 18.0;
    const midFreq = isMega ? 55.0 : 80.0;

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = i / numSamples;

      // Envelope: sharp attack, slower decay with bass tail
      let envelope;
      if (t < 0.008) {
        envelope = t / 0.008;
      } else if (progress < 0.15) {
        envelope = 1.0;
      } else {
        const decayProgress = (progress - 0.15) / 0.85;
        envelope = Math.pow(1.0 - decayProgress, 1.5);
      }

      // Sub-bass thump
      const subBass = Math.sin(TAU * subFreq * t) * 0.35;

      // Main bass boom with pitch drop
      const pitchDrop = 1.0 - progress * 0.5;
      const bass = Math.sin(TAU * bassFreq * t * pitchDrop) * 0.3;

      // Mid rumble layer
      const mid = Math.sin(TAU * midFreq * t * pitchDrop) * 0.15;

      // Filtered noise
      const noise = randf(-1.0, 1.0) * randf(0.3, 1.0);
      const noiseWeight = 0.2 * (1.0 - progress * 0.5);

      // Crackle in the initial blast
      let crackle = 0.0;
      if (t < 0.05) {
        crackle = randf(-1.0, 1.0) * (1.0 - t / 0.05) * 0.25;
      }

      // Mix
      let val = (subBass + bass + mid + noise * noiseWeight + crackle) * envelope;
      // Soft clipping — clamp to ±1.5 before tanh for consistent drive range
      val = Math.tanh(Math.max(-1.5, Math.min(1.5, val)) * 1.5) / Math.tanh(1.5);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Missile launch (from missile.gd play_launch_sound) ------------------
  _generateLaunchBuffer() {
    const sampleRate = 22050;
    const duration = 0.55;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Sharp attack, exponential decay envelope
      let envelope;
      if (t < 0.005) {
        envelope = t / 0.005;
      } else {
        envelope = Math.exp(-5.0 * (t - 0.005));
      }

      // Heavy ignition crack — broadband noise burst
      const crack = randf(-1.0, 1.0) * Math.max(0.0, 1.0 - t / 0.016) * 0.70;

      // Sub-bass thump on ignition
      const sub = Math.sin(TAU * 50.0 * t) * Math.max(0.0, 1.0 - t / 0.06) * 0.30;

      // Rocket motor rush — whooshing filtered noise
      const rushEnv = Math.min(t / 0.02, 1.0) * Math.exp(-3.0 * Math.max(0.0, t - 0.04));
      const rush = randf(-1.0, 1.0) * randf(0.3, 1.0) * rushEnv * 0.30;

      // Low resonant rumble
      const rumble = Math.sin(TAU * 85.0 * t * (1.0 - progress * 0.2)) * 0.20 * (1.0 - progress * 0.8);

      // Metallic ping — tube resonance on launch
      const ping = Math.sin(TAU * 680.0 * t) * Math.max(0.0, 1.0 - t / 0.03) * 0.15;

      // Receding hiss
      const hiss = randf(-1.0, 1.0) * 0.15 * Math.max(0.0, 1.0 - progress * 1.2);

      let val = (crack + sub + rush + rumble + ping + hiss) * envelope;
      val = Math.tanh(Math.max(-1.5, Math.min(1.5, val)) * 1.3) / Math.tanh(1.3);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Heat-seeker launch (from heat_seeking_missile.gd play_launch_sound) --
  _generateHeatSeekerLaunchBuffer() {
    const sampleRate = 22050;
    const duration = 0.65;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Sharp attack, exponential decay envelope
      let envelope;
      if (t < 0.006) {
        envelope = t / 0.006;
      } else {
        envelope = Math.exp(-4.5 * (t - 0.006));
      }

      // Ignition crack — sharp broadband pop
      const crack = randf(-1.0, 1.0) * Math.max(0.0, 1.0 - t / 0.018) * 0.65;

      // Rocket motor rush — whooshing noise with low-pass character
      const rushEnv = Math.min(t / 0.03, 1.0) * Math.exp(-2.5 * Math.max(0.0, t - 0.05));
      const rush = randf(-1.0, 1.0) * randf(0.4, 1.0) * rushEnv * 0.35;

      // Low sub-thump on ignition
      const sub = Math.sin(TAU * 55.0 * t) * Math.max(0.0, 1.0 - t / 0.08) * 0.25;

      // Mid-tone rocket body resonance
      const mid = Math.sin(TAU * 280.0 * t * (1.0 - progress * 0.3)) * 0.12 * Math.max(0.0, 1.0 - t / 0.2);

      // Electronic seeker acquisition — descending chirp
      const chirpFreq = 3200.0 * Math.exp(-12.0 * t);
      const chirpEnv = Math.max(0.0, 1.0 - t / 0.06) * 0.3;
      const chirp = Math.sin(TAU * chirpFreq * t) * chirpEnv;

      // Seeker lock ping — short tonal blip at ~1800Hz
      const pingStart = 0.04;
      const pingDur = 0.035;
      let ping = 0.0;
      if (t > pingStart && t < pingStart + pingDur) {
        const pingT = t - pingStart;
        const pingEnv = Math.sin(Math.PI * pingT / pingDur);
        ping = Math.sin(TAU * 1800.0 * pingT) * pingEnv * 0.2;
      }

      // Doppler rising whoosh (distant receding)
      const whooshEnv = Math.max(0, Math.min(1, (t - 0.08) / 0.15)) * Math.exp(-3.0 * Math.max(0.0, t - 0.25));
      const whoosh = randf(-1.0, 1.0) * whooshEnv * 0.18;

      // Mix
      let val = (crack + rush + sub + mid + chirp + ping + whoosh) * envelope;
      val = Math.tanh(Math.max(-1.5, Math.min(1.5, val)) * 1.4) / Math.tanh(1.4);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Heat-seeker motor loop (from heat_seeking_missile.gd _start_motor_loop) --
  _generateMotorBuffer() {
    const sampleRate = 22050;
    const duration = 0.3;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Jet hiss — filtered noise
      const hiss = randf(-1.0, 1.0) * randf(0.3, 1.0) * 0.15;

      // Low motor rumble
      let rumble = Math.sin(TAU * 72.0 * t) * 0.12;
      rumble += Math.sin(TAU * 144.0 * t) * 0.06; // harmonic

      // Mid whine (seeker electronics)
      let whine = Math.sin(TAU * 520.0 * t) * 0.04;
      whine += Math.sin(TAU * 780.0 * t) * 0.02; // harmonic shimmer

      // Slight flutter modulation
      const flutter = 1.0 + Math.sin(TAU * 18.0 * t) * 0.08;

      let val = (hiss + rumble + whine) * flutter;
      val = Math.tanh(val * 1.2) / Math.tanh(1.2);

      samples[i] = val;
    }

    // Crossfade loop boundaries to prevent noise click
    applyLoopCrossfade(samples, LOOP_FADE_SAMPLES);

    return this._createBuffer(samples, sampleRate);
  }

  // -- Vulkan shot (from vulkan_cannon.gd _create_fire_sound) ---------------
  _generateVulkanShotBuffer() {
    const sampleRate = 22050;
    const duration = 0.06;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Ultra-sharp attack, fast decay
      const envelope = Math.min(t / 0.001, 1.0) * Math.exp(-60.0 * t);

      // Sharp metallic crack
      const crack = randf(-1.0, 1.0) * 0.8;

      // Brief metallic ring
      const ring = Math.sin(TAU * 1200.0 * t) * 0.3 * Math.max(0.0, 1.0 - t / 0.02);

      // Tiny bass punch
      const punch = Math.sin(TAU * 120.0 * t) * 0.25 * Math.max(0.0, 1.0 - t / 0.015);

      let val = (crack + ring + punch) * envelope;
      val = Math.tanh(val * 1.5) / Math.tanh(1.5);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Nuke warning siren ---------------------------------------------------
  _generateNukeWarningBuffer() {
    const sampleRate = 22050;
    const duration = 1.2;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    const toneA = 420.0; // low tone Hz
    const toneB = 620.0; // high tone Hz
    const toggleInterval = 0.3; // seconds per tone

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Alternate between toneA and toneB every toggleInterval seconds
      const tonePhase = Math.floor(t / toggleInterval);
      const freq = (tonePhase % 2 === 0) ? toneA : toneB;

      // Pseudo-square wave: hard-clip a sine for harshness
      const sineVal = Math.sin(TAU * freq * t);
      const squareWave = sineVal > 0.3 ? 1.0 : (sineVal < -0.3 ? -1.0 : sineVal / 0.3);

      // Softer sine undertone at half frequency
      const undertone = Math.sin(TAU * (freq * 0.5) * t) * 0.25;

      // Brief noise click on tone transitions (within 0.004s of each toggle boundary)
      const timeInSlot = t - tonePhase * toggleInterval;
      const clickWindow = 0.004;
      const isTransition = timeInSlot < clickWindow;
      const click = isTransition ? randf(-1.0, 1.0) * (1.0 - timeInSlot / clickWindow) * 0.4 : 0.0;

      // Mix primary tones
      let val = squareWave * 0.55 + undertone + click;

      // Fade in (first 0.05s) and fade out (last 0.1s) envelope
      const fadeIn = Math.min(t / 0.05, 1.0);
      const fadeOut = Math.min((duration - t) / 0.1, 1.0);
      val *= fadeIn * fadeOut;

      // Soft clip with tanh for final saturation
      val = Math.tanh(val * 1.4) / Math.tanh(1.4);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Vulkan spool loop (from vulkan_cannon.gd _create_spool_sound) --------
  _generateSpoolBuffer() {
    const sampleRate = 22050;
    const duration = 0.2;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Mechanical whir — layered sine tones
      let whir = Math.sin(TAU * 180.0 * t) * 0.15;
      whir += Math.sin(TAU * 360.0 * t) * 0.08; // 2nd harmonic
      whir += Math.sin(TAU * 540.0 * t) * 0.04; // 3rd harmonic

      // Bearing rattle
      const rattle = randf(-1.0, 1.0) * 0.05;

      // Motor hum
      const hum = Math.sin(TAU * 90.0 * t) * 0.08;

      let val = whir + rattle + hum;
      val = Math.tanh(val * 1.3) / Math.tanh(1.3);

      samples[i] = val;
    }

    // Crossfade loop boundaries to prevent noise click
    applyLoopCrossfade(samples, LOOP_FADE_SAMPLES);

    return this._createBuffer(samples, sampleRate);
  }

  // -- Target-acquired radar ping (procedural, ~0.3s) -----------------------
  _generateTargetAcquiredBuffer() {
    const sampleRate = 22050;
    // Two beeps: beep1 starts at 0, beep2 starts at 0.13s; total ~0.30s
    const duration = 0.30;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    // Beep parameters: freq, start time, duration each
    const beeps = [
      { freq: 1200, start: 0.000, dur: 0.085 },
      { freq: 1900, start: 0.130, dur: 0.085 },
    ];

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      let val = 0;

      for (const beep of beeps) {
        const bt = t - beep.start;
        if (bt < 0 || bt >= beep.dur) continue;

        // Envelope: fast attack (2ms), short sustain, decay + reverb tail
        const attackTime = 0.002;
        const sustainEnd = beep.dur * 0.55;
        let env;
        if (bt < attackTime) {
          env = bt / attackTime;
        } else if (bt < sustainEnd) {
          env = 1.0;
        } else {
          // Exponential decay into reverb tail
          const decayT = bt - sustainEnd;
          const decayLen = beep.dur - sustainEnd;
          env = Math.exp(-5.5 * (decayT / decayLen));
        }

        // Pure sine tone — clean radar ping
        const tone = Math.sin(TAU * beep.freq * bt) * 0.55;

        // Faint 2nd harmonic for slight metallic sheen
        const harmonic = Math.sin(TAU * beep.freq * 2.0 * bt) * 0.12;

        // Very brief click transient on attack to cut through radio noise
        const click = bt < 0.003 ? (1.0 - bt / 0.003) * randf(-0.08, 0.08) : 0.0;

        val += (tone + harmonic + click) * env;
      }

      // Soft limit — pings should be clean, not saturated
      samples[i] = Math.tanh(val * 1.2) / Math.tanh(1.2);
    }

    // Brief fade-out on the last 8ms to avoid hard clip at buffer end
    const tailSamples = Math.floor(sampleRate * 0.008);
    for (let i = 0; i < tailSamples; i++) {
      samples[numSamples - 1 - i] *= i / tailSamples;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Shield activation: rising sweep 200→2000 Hz over 0.3s + noise burst --
  _generateShieldActivationBuffer() {
    const sampleRate = 22050;
    const duration = 0.5;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Envelope: quick attack, sustain, tail fade
      let env;
      if (t < 0.01) {
        env = t / 0.01;
      } else if (progress < 0.7) {
        env = 1.0;
      } else {
        env = 1.0 - (progress - 0.7) / 0.3;
      }

      // Frequency sweep: 200 → 2000 Hz exponential
      const freq = 200 * Math.pow(10.0, progress);  // log sweep

      // Sweep tone
      const sweep = Math.sin(TAU * freq * t) * 0.45;

      // Noise burst (heavier at start)
      const noiseEnv = Math.max(0, 1.0 - progress * 2.5);
      const noise = randf(-1.0, 1.0) * noiseEnv * 0.3;

      // Harmonic shimmer
      const shimmer = Math.sin(TAU * freq * 2 * t) * 0.12;

      let val = (sweep + noise + shimmer) * env;
      val = Math.tanh(val * 1.3) / Math.tanh(1.3);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Shield deflect: short noise burst + sine chirp -----------------------
  _generateShieldDeflectBuffer() {
    const sampleRate = 22050;
    const duration = 0.20;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Sharp decay envelope
      const env = Math.exp(-12 * t);

      // Noise burst
      const noise = randf(-1.0, 1.0) * 0.5;

      // Descending chirp 1800 → 600 Hz
      const chirpFreq = 1800 * Math.exp(-8 * t);
      const chirp = Math.sin(TAU * chirpFreq * t) * 0.35;

      let val = (noise + chirp) * env;
      val = Math.tanh(val * 1.5) / Math.tanh(1.5);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Shield nuke hit: distorted low rumble + crackling --------------------
  _generateShieldNukeHitBuffer() {
    const sampleRate = 22050;
    const duration = 0.6;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Envelope: impact then decay
      let env;
      if (t < 0.01) {
        env = t / 0.01;
      } else {
        env = Math.pow(1 - progress, 1.2);
      }

      // Low sub rumble
      const sub = Math.sin(TAU * 30 * t) * 0.4;

      // Mid distortion
      const mid = Math.sin(TAU * 80 * t * (1 - progress * 0.5)) * 0.25;

      // Crackling noise — high density random spikes
      const noise = randf(-1.0, 1.0);
      const crack = noise > 0.6 ? noise * 0.35 : 0;

      // Heavy saturation for distortion
      let val = (sub + mid + randf(-0.15, 0.15) + crack) * env;
      val = Math.tanh(val * 3.0) / Math.tanh(3.0);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Shield warning: two quick 800 Hz beeps -------------------------------
  _generateShieldWarningBuffer() {
    const sampleRate = 22050;
    const duration = 0.28;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    const beeps = [
      { start: 0.00, dur: 0.08 },
      { start: 0.14, dur: 0.08 },
    ];

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      let val = 0;

      for (const beep of beeps) {
        const bt = t - beep.start;
        if (bt < 0 || bt >= beep.dur) continue;

        const env = Math.min(bt / 0.004, 1.0) * Math.exp(-10 * Math.max(0, bt - 0.02));
        val += Math.sin(TAU * 800 * bt) * 0.5 * env;
        // Second harmonic
        val += Math.sin(TAU * 1600 * bt) * 0.1 * env;
      }

      samples[i] = Math.tanh(val * 1.2) / Math.tanh(1.2);
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Laser warm-up: rising frequency sweep 300→4000 Hz over 1.0s ----------
  _generateLaserWarmUpBuffer() {
    const sampleRate = 22050;
    const duration = 1.0;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Exponential frequency sweep: 300 Hz → 4000 Hz
      const startFreq = 300;
      const endFreq = 4000;
      const freq = startFreq * Math.pow(endFreq / startFreq, progress);

      // Envelope: gentle fade in at start, sustain, slight fade at end
      let env;
      if (t < 0.05) {
        env = t / 0.05;
      } else if (progress < 0.85) {
        env = 0.65 + 0.35 * progress; // builds in intensity
      } else {
        env = 1.0 * (1 - (progress - 0.85) / 0.15 * 0.3);
      }

      // Main tone — sawtooth-ish via harmonics for electrical feel
      const phase = TAU * freq * t;
      const tone = Math.sin(phase) * 0.5
                 + Math.sin(phase * 2) * 0.2
                 + Math.sin(phase * 3) * 0.1;

      // Electrical buzz — high-frequency noise component that intensifies
      const buzz = randf(-0.5, 0.5) * progress * 0.25;

      // Phase-coherent phase for a "capacitor whine"
      const whine = Math.sin(TAU * 1200 * t * (1 + progress)) * 0.15 * progress;

      let val = (tone + buzz + whine) * env * 0.5;
      val = Math.tanh(val * 1.5) / Math.tanh(1.5);

      samples[i] = val;
    }

    applyLoopCrossfade(samples, LOOP_FADE_SAMPLES);
    return this._createBuffer(samples, sampleRate);
  }

  // -- Laser firing loop: sustained electrical buzz --------------------------
  _generateLaserFiringLoopBuffer() {
    // 0.25s loop — smooth crossfade at boundaries for seamless looping
    const sampleRate = 22050;
    const duration = 0.25;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Main carrier: 180 Hz electrical hum
      const carrier = Math.sin(TAU * 180 * t) * 0.4;

      // Harmonic overtones for buzzy character
      const h2 = Math.sin(TAU * 360 * t) * 0.2;
      const h3 = Math.sin(TAU * 540 * t) * 0.1;
      const h5 = Math.sin(TAU * 900 * t) * 0.06;

      // High frequency crackling
      const crackle = randf(-1, 1) > 0.6 ? randf(-0.15, 0.15) : 0;

      // Slight amplitude modulation at 60 Hz (power-line hum character)
      const am = 0.85 + 0.15 * Math.sin(TAU * 60 * t);

      let val = (carrier + h2 + h3 + h5 + crackle) * am;
      val = Math.tanh(val * 2.0) / Math.tanh(2.0);

      samples[i] = val * 0.6;
    }

    applyLoopCrossfade(samples, LOOP_FADE_SAMPLES);
    return this._createBuffer(samples, sampleRate);
  }

  // -- Quad buzz: 85Hz + 170Hz detuned square waves, 0.05s duration ----------
  _generateQuadBuzzBuffer() {
    const sampleRate = 22050;
    const duration = 0.55;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    const TAU2 = 2 * Math.PI;

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Smooth envelope: fade in 0.02s, sustain, fade out 0.05s
      const fadeIn = Math.min(1, t / 0.02);
      const fadeOut = Math.min(1, (duration - t) / 0.05);
      const env = fadeIn * fadeOut;

      // 85Hz pseudo-square wave — fundamental rotor tone
      const s1 = Math.sin(TAU2 * 85.0 * t);
      const sq1 = s1 > 0.3 ? 0.5 : (s1 < -0.3 ? -0.5 : s1 * 1.67);

      // 170Hz detuned — harmonic buzz character
      const s2 = Math.sin(TAU2 * 172.0 * t);
      const sq2 = s2 > 0.3 ? 0.3 : (s2 < -0.3 ? -0.3 : s2);

      // 340Hz upper harmonic — adds "angry wasp" edge
      const s3 = Math.sin(TAU2 * 341.0 * t) * 0.15;

      // Slight amplitude wobble for realism (rotor speed variation)
      const wobble = 1.0 + 0.06 * Math.sin(TAU2 * 3.5 * t);

      let val = (sq1 + sq2 + s3) * env * wobble * 0.55;
      val = Math.tanh(val * 2.5) / Math.tanh(2.5);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Shock Zap: electric crackling/zap when shockwave spawns or propagates -
  /**
   * One-shot electric crackling/zap for ShockMissile impact and ShockWave propagation.
   * White noise burst filtered via bandpass with rapid amplitude modulation for crackle.
   * @param {number} x — world x for stereo pan
   */
  playShockZap(x) {
    if (!this.audioCtx) return;
    this._playBuffer(this.shockZapBuffer, 3.0, randf(0.85, 1.15), panFromX(x));
  }

  _generateShockZapBuffer() {
    const sampleRate = 22050;
    const duration = 0.35;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    // Bandpass center frequency — electric arc character sits around 1200 Hz
    const centerFreq = 1200;
    const Q = 4.0;    // resonance bandwidth
    // Simple biquad bandpass coefficients (2nd order IIR)
    const omega = TAU * centerFreq / sampleRate;
    const alpha = Math.sin(omega) / (2 * Q);
    const bpB0 =  alpha;
    const bpB1 =  0;
    const bpB2 = -alpha;
    const bpA0 =  1 + alpha;
    const bpA1 = -2 * Math.cos(omega);
    const bpA2 =  1 - alpha;

    // Normalized coefficients
    const b0 = bpB0 / bpA0;
    const b1 = bpB1 / bpA0;
    const b2 = bpB2 / bpA0;
    const a1 = bpA1 / bpA0;
    const a2 = bpA2 / bpA0;

    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Envelope: fast attack (2ms), exponential decay with crackle tail
      let env;
      if (t < 0.002) {
        env = t / 0.002;
      } else {
        env = Math.exp(-5.5 * (t - 0.002));
      }

      // White noise source
      const noise = randf(-1.0, 1.0);

      // Apply bandpass IIR filter
      const filtered = b0 * noise + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = noise;
      y2 = y1; y1 = filtered;

      // Rapid amplitude modulation (crackle effect) — 80-180 Hz AM
      const crackleRate = 120 + Math.sin(TAU * 8 * t) * 40;
      const amMod = 0.5 + 0.5 * Math.abs(Math.sin(TAU * crackleRate * t));

      // High-freq arc tone (adds electric character)
      const arcTone = Math.sin(TAU * 2800 * t + Math.sin(TAU * 45 * t) * 3) * 0.15;

      // Low sub thump on initial impact
      const subThump = Math.sin(TAU * 60 * t) * Math.max(0, 1 - t / 0.04) * 0.25;

      let val = (filtered * amMod * 0.6 + arcTone + subThump) * env;

      // Soft clip
      val = Math.tanh(Math.max(-1.5, Math.min(1.5, val)) * 2.0) / Math.tanh(2.0);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }

  // -- Laser hit: sharp electrical crack on impact ---------------------------
  _generateLaserHitBuffer() {
    const sampleRate = 22050;
    const duration = 0.08;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;

      // Very sharp attack, instant decay
      const env = Math.exp(-progress * 25);

      // High-frequency crack — noise burst with tone at ~3000 Hz
      const tone = Math.sin(TAU * 3000 * t) * 0.4;
      const noise = randf(-1.0, 1.0) * 0.6;

      let val = (tone + noise) * env;
      val = Math.tanh(val * 3.0) / Math.tanh(3.0);

      samples[i] = val;
    }

    return this._createBuffer(samples, sampleRate);
  }
}
