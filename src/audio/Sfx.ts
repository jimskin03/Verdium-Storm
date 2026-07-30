import type { BusName } from './Mixer';
import {
  adEnv, ahrEnv, bubble, body, chain, clampFreq, filter, gain, grainBurst, impulseTexture,
  modal, modulate, noiseBuffer, noiseLayer, noiseSource, osc, saturationCurve, sweep, transient,
} from './Synth';

/**
 * The sound catalogue. Every entry is built from oscillators and generated
 * buffers at trigger time, with per-instance randomisation of pitch, filter and
 * envelope, so a machine gun firing twenty rounds never repeats a waveform.
 *
 * Layering convention, borrowed from film SFX practice: transient (the click
 * that tells you where it is) + mid crack (the character) + low body (the size)
 * + tail (the space it happens in).
 */

/** Everything a builder needs. `dest` is the per-voice input node. */
export interface VoiceEnv {
  ctx: BaseAudioContext;
  dest: AudioNode;
  /** Absolute context time the sound starts at. */
  t: number;
  rng: () => number;
  /** Frequency multiplier, already combined from catalogue + caller. */
  pitch: number;
  /** Linear amplitude multiplier. */
  gain: number;
  /** Build a sustaining version that runs until `stop()`. */
  sustain: boolean;
}

export interface BuiltSound {
  /** Seconds until silent. `Infinity` while a sustained voice is held. */
  duration: number;
  /** Release a sustained voice; returns the tail length in seconds. */
  stop(at: number): number;
  /** Live control for loops: 'speed' 0..1, 'load' 0..1. */
  set?(param: string, value: number, at: number): void;
}

export interface SoundDef {
  build(v: VoiceEnv): BuiltSound;
  bus: BusName;
  /** Higher survives when the voice budget is exceeded. */
  priority: number;
  /** Concurrent instances of this id before the quietest is culled. */
  maxInstances: number;
  /** Minimum seconds between retriggers; protects against event storms. */
  minInterval: number;
  spatial: boolean;
  /** Catalogue level trim, linear. */
  gain: number;
  /** Reverb send amount into the battlefield space, 0..1. */
  space: number;
  /** Distance scale — big guns carry much further than footsteps. */
  reach: number;
  /** True when the sound is designed to be held with `loop()`. */
  loopable?: boolean;
}

/* ------------------------------------------------------------------ helpers */

/** Random value in [a, b). */
const R = (v: VoiceEnv, a: number, b: number): number => a + v.rng() * (b - a);

/**
 * Shared envelope logic. In one-shot mode the layer plays for `burst` seconds
 * and releases; in sustain mode it holds until `stop()` is called.
 */
function hold(
  v: VoiceEnv,
  g: GainNode,
  peak: number,
  attack: number,
  burst: number,
  release: number,
  sources: AudioScheduledSourceNode[],
): BuiltSound {
  const start = v.t;
  for (const s of sources) s.start(start);
  if (!v.sustain) {
    const total = ahrEnv(g.gain, start, peak, attack, burst, release);
    for (const s of sources) s.stop(start + total + 0.03);
    return { duration: total, stop: () => 0 };
  }
  g.gain.setValueAtTime(1e-4, start);
  g.gain.linearRampToValueAtTime(Math.max(peak, 2e-4), start + attack);
  let stopped = false;
  return {
    duration: Infinity,
    stop(at: number): number {
      if (stopped) return 0;
      stopped = true;
      const when = Math.max(at, start + attack);
      g.gain.cancelScheduledValues(when);
      g.gain.setValueAtTime(Math.max(g.gain.value, 1e-4), when);
      g.gain.exponentialRampToValueAtTime(1e-4, when + release);
      for (const s of sources) {
        try { s.stop(when + release + 0.03); } catch { /* already stopped */ }
      }
      return release;
    },
  };
}

/** One-shot with no sustained form: everything is scheduled up front. */
const oneShot = (duration: number): BuiltSound => ({ duration, stop: () => 0 });

/** Distant, muffled echo of a big blast rolling back off the terrain. */
function rollOff(v: VoiceEnv, dur: number, level: number, cutoff: number): void {
  noiseLayer(v.ctx, v.dest, v.t + R(v, 0.09, 0.16), {
    kind: 'brown', gain: v.gain * level, dur, from: cutoff, to: cutoff * 0.35,
    filterType: 'lowpass', q: 0.6, attack: 0.06, offset: v.rng() * 1.8,
  });
}

/**
 * Grain textures. Each is generated once per context and then played back as a
 * single buffer source, which is how a shrapnel field costs one node instead of
 * sixty. Keeping them in a table lets `prewarm` build them all up front so the
 * first explosion of a match does not hitch.
 */
interface DebrisPreset {
  dur: number; density: number; low: number; high: number; decay: number; seed: number; tail?: boolean; loop?: boolean;
}

const DEBRIS = {
  shrapnel:   { dur: 0.45, density: 60, low: 900, high: 5200, decay: 0.020, seed: 41, tail: true },
  aaFeed:     { dur: 0.30, density: 40, low: 600, high: 2600, decay: 0.012, seed: 17 },
  dirtClods:  { dur: 0.40, density: 45, low: 300, high: 1800, decay: 0.030, seed: 63, tail: true },
  stoneChips: { dur: 0.50, density: 55, low: 700, high: 3600, decay: 0.022, seed: 91, tail: true },
  blastSmall: { dur: 0.80, density: 40, low: 400, high: 2600, decay: 0.030, seed: 29, tail: true },
  blastLarge: { dur: 1.80, density: 34, low: 260, high: 2400, decay: 0.050, seed: 7, tail: true },
  masonry:    { dur: 2.20, density: 46, low: 180, high: 1400, decay: 0.090, seed: 55 },
  rubbleFine: { dur: 2.60, density: 120, low: 700, high: 4200, decay: 0.020, seed: 77, tail: true },
  orePour:    { dur: 1.20, density: 220, low: 500, high: 3400, decay: 0.020, seed: 83, tail: true },
  gravel:     { dur: 0.12, density: 90, low: 900, high: 3800, decay: 0.008, seed: 101, tail: true },
  webbing:    { dur: 0.30, density: 20, low: 2200, high: 6000, decay: 0.012, seed: 113 },
  kitFall:    { dur: 0.35, density: 40, low: 1200, high: 4600, decay: 0.014, seed: 127, tail: true },
  treadLinks: { dur: 2.00, density: 34, low: 300, high: 2600, decay: 0.035, seed: 21, loop: true },
  siteWork:   { dur: 2.40, density: 12, low: 400, high: 3000, decay: 0.050, seed: 47, loop: true },
  processing: { dur: 3.00, density: 4, low: 90, high: 700, decay: 0.160, seed: 61, loop: true },
} satisfies Record<string, DebrisPreset>;

type DebrisName = keyof typeof DEBRIS;

const decayShape = (t: number): number => Math.pow(1 - t, 1.6);

function debrisBuffer(ctx: BaseAudioContext, name: DebrisName): AudioBuffer {
  const o: DebrisPreset = DEBRIS[name];
  return impulseTexture(ctx, {
    seconds: o.dur, density: o.density, freqMin: o.low, freqMax: o.high,
    decay: o.decay, noisiness: 0.5, seed: o.seed,
    loopSafe: o.loop ?? false,
    shape: o.tail ? decayShape : undefined,
  });
}

/** Scattered debris/shrapnel field built from one generated grain buffer. */
function debrisField(v: VoiceEnv, name: DebrisName, level: number): void {
  const buf = debrisBuffer(v.ctx, name);
  grainBurst(v.ctx, v.dest, v.t + R(v, 0.01, 0.05), buf, {
    gain: v.gain * level, dur: DEBRIS[name].dur, rate: R(v, 0.85, 1.2), attack: 0.005,
  });
}

/* --------------------------------------------------------------- weaponry */

function rifle(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.94, 1.07);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.9, freq: 4200 * p, decay: 0.008, q: 0.8, offset: v.rng() * 1.8 });
  // The crack: a bandpassed burst that opens and shuts in under 100 ms.
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.85, dur: R(v, 0.075, 0.105), from: 2400 * p, to: 700 * p,
    filterType: 'bandpass', q: 1.1, attack: 0.0012, highpass: 240, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.5, from: 165 * p, to: 62, dur: 0.075, type: 'triangle' });
  // Tail: what the valley gives back.
  noiseLayer(v.ctx, v.dest, v.t + 0.02, {
    gain: g * 0.16, dur: R(v, 0.22, 0.34), from: 1500, to: 320,
    filterType: 'lowpass', q: 0.7, attack: 0.02, offset: v.rng() * 1.8,
  });
  return oneShot(0.4);
}

function machinegun(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.9, 1.12);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 1.0, freq: 5200 * p, decay: 0.005, q: 0.7, offset: v.rng() * 1.8 });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.8, dur: R(v, 0.045, 0.07), from: 3000 * p, to: 900 * p,
    filterType: 'bandpass', q: 1.4, attack: 0.001, highpass: 300, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.45, from: 190 * p, to: 70, dur: 0.055, type: 'triangle' });
  // Bolt clack — the mechanical half of an automatic weapon.
  modal(v.ctx, v.dest, v.t + R(v, 0.012, 0.022), {
    ratios: [1, 2.41, 4.13], base: 760 * p, gain: g * 0.14, decay: 0.035, rng: v.rng, type: 'triangle',
  });
  noiseLayer(v.ctx, v.dest, v.t + 0.015, {
    gain: g * 0.1, dur: 0.16, from: 1200, to: 300, filterType: 'lowpass', attack: 0.015, offset: v.rng() * 1.8,
  });
  return oneShot(0.25);
}

function rocketLaunch(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.92, 1.08);
  const g = v.gain;
  // Ignition.
  transient(v.ctx, v.dest, v.t, { gain: g * 0.55, freq: 2600 * p, decay: 0.02, q: 0.6, offset: v.rng() * 1.8 });
  body(v.ctx, v.dest, v.t, { gain: g * 0.7, from: 120 * p, to: 38, dur: 0.28, type: 'sine', attack: 0.004 });
  // The whoosh: bandpass climbing as the motor leaves the tube.
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.95, dur: R(v, 0.55, 0.75), from: 320 * p, to: 2400 * p,
    filterType: 'bandpass', q: 0.9, attack: 0.035, offset: v.rng() * 1.8,
  });
  // Exhaust roar underneath.
  noiseLayer(v.ctx, v.dest, v.t + 0.01, {
    gain: g * 0.5, dur: 0.7, from: 900, to: 260, kind: 'pink',
    filterType: 'lowpass', q: 1.4, attack: 0.02, offset: v.rng() * 1.8,
  });
  rollOff(v, 0.5, 0.14, 700);
  return oneShot(0.95);
}

function rocketFlight(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.94, 1.06);
  const ctx = v.ctx;
  const out = gain(ctx, 0);
  out.connect(v.dest);

  const src = noiseSource(ctx, { kind: 'pink', seed: 5, rate: R(v, 0.9, 1.1) });
  const bp = filter(ctx, 'bandpass', 780 * p, 0.75);
  const drive = ctx.createWaveShaper();
  drive.curve = saturationCurve(0.25);
  chain(src, bp, drive, out);

  // Slow wander in the exhaust so it never sits still.
  const lfo = osc(ctx, 'sine', R(v, 0.7, 1.6));
  const lfoAmt = gain(ctx, 220 * p);
  modulate(lfo, lfoAmt, bp.frequency);

  const rumble = osc(ctx, 'sawtooth', 58 * p);
  const rumbleFilter = filter(ctx, 'lowpass', 190, 1.1);
  const rumbleGain = gain(ctx, 0.22);
  chain(rumble, rumbleFilter, rumbleGain, out);

  return hold(v, out, v.gain * 0.75, 0.05, 1.3, 0.28, [src, lfo, rumble]);
}

function cannon(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.95, 1.06);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 1.0, freq: 3400 * p, decay: 0.014, q: 0.5, offset: v.rng() * 1.8 });
  // Muzzle blast.
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 1.0, dur: R(v, 0.16, 0.24), from: 1900 * p, to: 220,
    filterType: 'lowpass', q: 1.2, attack: 0.002, offset: v.rng() * 1.8,
  });
  // Body: the punch you feel in the chest.
  body(v.ctx, v.dest, v.t, { gain: g * 1.0, from: 96 * p, to: 31, dur: 0.42, type: 'sine', attack: 0.003 });
  body(v.ctx, v.dest, v.t + 0.004, { gain: g * 0.45, from: 210 * p, to: 74, dur: 0.2, type: 'triangle' });
  // Breech ring, a beat later.
  modal(v.ctx, v.dest, v.t + R(v, 0.09, 0.14), {
    ratios: [1, 2.78, 5.11], base: 430 * p, gain: g * 0.12, decay: 0.22, rng: v.rng, type: 'triangle',
  });
  rollOff(v, 0.9, 0.3, 900);
  return oneShot(1.2);
}

function artillery(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.94, 1.05);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.8, freq: 2600 * p, decay: 0.02, q: 0.5, offset: v.rng() * 1.8 });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 1.0, dur: R(v, 0.3, 0.42), from: 1400 * p, to: 130,
    filterType: 'lowpass', q: 1.0, attack: 0.004, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 1.1, from: 74 * p, to: 22, dur: 0.9, type: 'sine', attack: 0.006 });
  body(v.ctx, v.dest, v.t + 0.01, { gain: g * 0.4, from: 150 * p, to: 48, dur: 0.35, type: 'triangle' });
  // Two discrete slap-backs, then the diffuse roll.
  rollOff(v, 1.3, 0.34, 620);
  noiseLayer(v.ctx, v.dest, v.t + 0.34, {
    gain: g * 0.16, dur: 1.1, from: 420, to: 130, kind: 'brown',
    filterType: 'lowpass', q: 0.6, attack: 0.12, offset: v.rng() * 1.8,
  });
  return oneShot(1.9);
}

function laser(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.93, 1.09);
  const ctx = v.ctx;
  const g = v.gain;
  const dur = R(v, 0.2, 0.3);
  const out = gain(ctx, 0);
  const lp = filter(ctx, 'lowpass', 4200 * p, 9);
  const drive = ctx.createWaveShaper();
  drive.curve = saturationCurve(0.35);
  chain(out, drive, v.dest);

  // Two detuned saws diving through a resonant filter that dives with them.
  for (let i = 0; i < 2; i++) {
    const o1 = osc(ctx, 'sawtooth', 2600 * p, i === 0 ? -9 : 11);
    sweep(o1.frequency, v.t, 2600 * p, 300 * p, dur);
    o1.connect(lp);
    o1.start(v.t);
    o1.stop(v.t + dur + 0.05);
  }
  lp.connect(out);
  sweep(lp.frequency, v.t, clampFreq(ctx, 7000 * p), clampFreq(ctx, 500 * p), dur);
  adEnv(out.gain, v.t, g * 0.62, 0.002, dur);

  // Ring modulation gives the beam its electrical grit.
  const ring = osc(ctx, 'square', R(v, 48, 74));
  const ringGain = gain(ctx, 0.35);
  modulate(ring, ringGain, out.gain);
  ring.start(v.t);
  ring.stop(v.t + dur + 0.05);

  // Ionisation sizzle and a single reflection.
  noiseLayer(ctx, v.dest, v.t, {
    gain: g * 0.3, dur: dur * 0.7, from: 6000 * p, to: 1800,
    filterType: 'bandpass', q: 2.2, attack: 0.001, offset: v.rng() * 1.8,
  });
  noiseLayer(ctx, v.dest, v.t + dur * 0.8, {
    gain: g * 0.1, dur: 0.35, from: 1600, to: 400, filterType: 'lowpass', attack: 0.04, offset: v.rng() * 1.8,
  });
  return oneShot(dur + 0.4);
}

function flak(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.9, 1.12);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.95, freq: 3800 * p, decay: 0.01, q: 0.7, offset: v.rng() * 1.8 });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.9, dur: R(v, 0.1, 0.16), from: 2200 * p, to: 380,
    filterType: 'lowpass', q: 1.3, attack: 0.0015, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.6, from: 220 * p, to: 72, dur: 0.16, type: 'triangle' });
  // Shrapnel spraying outwards.
  debrisField(v, 'shrapnel', 0.3);
  rollOff(v, 0.4, 0.12, 1100);
  return oneShot(0.7);
}

function aaBurst(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const shots = 3 + Math.floor(v.rng() * 2);
  for (let i = 0; i < shots; i++) {
    const at = v.t + i * R(v, 0.055, 0.075);
    const p = v.pitch * R(v, 0.94, 1.08);
    transient(v.ctx, v.dest, at, { gain: g * 0.7, freq: 4600 * p, decay: 0.006, q: 0.8, offset: v.rng() * 1.8 });
    noiseLayer(v.ctx, v.dest, at, {
      gain: g * 0.62, dur: 0.06, from: 2600 * p, to: 700, filterType: 'bandpass', q: 1.3,
      attack: 0.001, highpass: 260, offset: v.rng() * 1.8,
    });
    body(v.ctx, v.dest, at, { gain: g * 0.4, from: 230 * p, to: 84, dur: 0.07, type: 'triangle' });
  }
  // Feed mechanism rattling through the burst.
  debrisField(v, 'aaFeed', 0.16);
  rollOff(v, 0.35, 0.1, 900);
  return oneShot(shots * 0.07 + 0.4);
}

/* -------------------------------------------------------- impacts, blasts */

function impactDirt(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.88, 1.14);
  const g = v.gain;
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.7, dur: R(v, 0.09, 0.15), from: 900 * p, to: 180,
    filterType: 'lowpass', q: 1.0, attack: 0.001, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.8, from: 130 * p, to: 44, dur: 0.2, type: 'sine' });
  debrisField(v, 'dirtClods', 0.22);
  return oneShot(0.55);
}

function impactMetal(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.85, 1.2);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.8, freq: 5200 * p, decay: 0.006, q: 1.0, offset: v.rng() * 1.8 });
  // Inharmonic partials — a struck steel plate, not a bell.
  modal(v.ctx, v.dest, v.t, {
    ratios: [1, 2.76, 5.4, 8.93, 13.34], base: 380 * p, gain: g * 0.55,
    decay: R(v, 0.35, 0.6), damping: 0.6, rng: v.rng, type: 'sine',
  });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.45, dur: 0.07, from: 3200 * p, to: 900, filterType: 'bandpass', q: 1.6,
    attack: 0.0008, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.35, from: 150 * p, to: 60, dur: 0.1, type: 'triangle' });
  return oneShot(0.75);
}

function impactStone(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.88, 1.16);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.75, freq: 4000 * p, decay: 0.008, q: 0.9, offset: v.rng() * 1.8 });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.8, dur: R(v, 0.07, 0.11), from: 1800 * p, to: 500,
    filterType: 'bandpass', q: 0.9, attack: 0.001, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.5, from: 190 * p, to: 80, dur: 0.11, type: 'triangle' });
  debrisField(v, 'stoneChips', 0.3);
  return oneShot(0.65);
}

function impactWater(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.9, 1.12);
  const g = v.gain;
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.6, dur: R(v, 0.14, 0.22), from: 2600 * p, to: 400,
    filterType: 'lowpass', q: 0.9, attack: 0.002, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.35, from: 110 * p, to: 55, dur: 0.14, type: 'sine' });
  // Rising bubbles: the sound of a cavity collapsing.
  const bubbles = 4 + Math.floor(v.rng() * 4);
  for (let i = 0; i < bubbles; i++) {
    bubble(v.ctx, v.dest, v.t + R(v, 0.02, 0.3), R(v, 260, 900) * p, R(v, 1.4, 2.6), R(v, 0.05, 0.12), g * 0.16);
  }
  return oneShot(0.6);
}

function explosionSmall(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.9, 1.12);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.9, freq: 3600 * p, decay: 0.012, q: 0.6, offset: v.rng() * 1.8 });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 1.0, dur: R(v, 0.3, 0.45), from: 3200 * p, to: 260,
    filterType: 'lowpass', q: 1.1, attack: 0.003, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 1.0, from: 120 * p, to: 36, dur: 0.5, type: 'sine', attack: 0.004 });
  debrisField(v, 'blastSmall', 0.28);
  rollOff(v, 0.7, 0.22, 800);
  return oneShot(1.1);
}

function explosionLarge(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.9, 1.08);
  const g = v.gain;
  transient(v.ctx, v.dest, v.t, { gain: g * 1.0, freq: 3000 * p, decay: 0.02, q: 0.5, offset: v.rng() * 1.8 });
  // Broadband blast front collapsing to a roar.
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 1.1, dur: R(v, 0.7, 1.0), from: 4200 * p, to: 180,
    filterType: 'lowpass', q: 1.0, attack: 0.004, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 1.2, from: 82 * p, to: 21, dur: 1.3, type: 'sine', attack: 0.006 });
  body(v.ctx, v.dest, v.t + 0.02, { gain: g * 0.5, from: 190 * p, to: 52, dur: 0.5, type: 'triangle' });
  // Fireball rumble: slow, modulated brown noise well behind the front.
  noiseLayer(v.ctx, v.dest, v.t + 0.05, {
    gain: g * 0.55, dur: 1.8, from: 320, to: 90, kind: 'brown',
    filterType: 'lowpass', q: 0.8, attack: 0.15, offset: v.rng() * 1.8,
  });
  debrisField(v, 'blastLarge', 0.32);
  rollOff(v, 1.6, 0.3, 700);
  return oneShot(2.6);
}

function explosionVehicle(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  explosionSmall({ ...v, gain: g * 0.9 });
  // Hull tearing: a resonant sweep downwards.
  const rip = filter(v.ctx, 'bandpass', 1800, 4.5);
  const ripGain = gain(v.ctx, 0);
  const ripSrc = noiseSource(v.ctx, { kind: 'white', seed: 13 });
  chain(ripSrc, rip, ripGain, v.dest);
  sweep(rip.frequency, v.t + 0.05, 2400, 320, 0.5);
  adEnv(ripGain.gain, v.t + 0.05, g * 0.4, 0.02, 0.5);
  ripSrc.start(v.t + 0.05, v.rng() * 1.8);
  ripSrc.stop(v.t + 0.65);
  // Secondary cook-offs.
  explosionSmall({ ...v, t: v.t + R(v, 0.3, 0.45), gain: g * 0.5, pitch: v.pitch * 1.25 });
  explosionSmall({ ...v, t: v.t + R(v, 0.75, 1.0), gain: g * 0.32, pitch: v.pitch * 1.5 });
  // Escaping pressure.
  noiseLayer(v.ctx, v.dest, v.t + 0.25, {
    gain: g * 0.16, dur: 1.4, from: 5200, to: 2200, filterType: 'bandpass', q: 1.2,
    attack: 0.1, offset: v.rng() * 1.8,
  });
  modal(v.ctx, v.dest, v.t + R(v, 0.5, 0.8), {
    ratios: [1, 2.66, 4.9, 7.1], base: 260, gain: g * 0.22, decay: 0.7, rng: v.rng, type: 'sine',
  });
  return oneShot(2.4);
}

function buildingCollapse(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const p = v.pitch;
  // Initial detonation.
  transient(v.ctx, v.dest, v.t, { gain: g * 0.7, freq: 2400 * p, decay: 0.02, q: 0.5, offset: v.rng() * 1.8 });
  body(v.ctx, v.dest, v.t, { gain: g * 1.0, from: 70 * p, to: 20, dur: 1.1, type: 'sine', attack: 0.01 });
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.7, dur: 0.6, from: 2600 * p, to: 200, filterType: 'lowpass', q: 1.0,
    attack: 0.006, offset: v.rng() * 1.8,
  });
  // Structural groan: steel giving way, an octave of slow detune.
  const groan = osc(v.ctx, 'sawtooth', 118 * p);
  const groanFilter = filter(v.ctx, 'lowpass', 520, 6);
  const groanGain = gain(v.ctx, 0);
  chain(groan, groanFilter, groanGain, v.dest);
  sweep(groan.frequency, v.t + 0.1, 118 * p, 46 * p, 1.2);
  sweep(groanFilter.frequency, v.t + 0.1, 900, 260, 1.2);
  adEnv(groanGain.gain, v.t + 0.1, g * 0.3, 0.15, 1.2);
  groan.start(v.t + 0.1);
  groan.stop(v.t + 1.6);
  // Two debris waves: masonry first, then the fine rubble settling.
  debrisField(v, 'masonry', 0.5);
  debrisField(v, 'rubbleFine', 0.3);
  // Dust cloud rolling out.
  noiseLayer(v.ctx, v.dest, v.t + 0.4, {
    gain: g * 0.35, dur: 2.4, from: 700, to: 150, kind: 'brown', filterType: 'lowpass',
    q: 0.7, attack: 0.5, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t + R(v, 1.6, 2.0), { gain: g * 0.4, from: 60, to: 26, dur: 0.6, type: 'sine', attack: 0.01 });
  rollOff(v, 2.0, 0.28, 600);
  return oneShot(3.4);
}

/* ----------------------------------------------------------------- vehicles */

function engineLoop(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const p = v.pitch * R(v, 0.95, 1.06);
  const out = gain(ctx, 0);
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturationCurve(0.4);
  const tone = filter(ctx, 'lowpass', 420, 3.2);
  chain(out, shaper, tone, v.dest);

  // Diesel: two saws a fifth apart plus a sub, all driven into the shaper.
  const base = 34 * p;
  const o1 = osc(ctx, 'sawtooth', base);
  const o2 = osc(ctx, 'sawtooth', base * 1.5, 7);
  const sub = osc(ctx, 'sine', base * 0.5);
  const subGain = gain(ctx, 0.5);
  o1.connect(out);
  const o2g = gain(ctx, 0.55);
  chain(o2, o2g, out);
  chain(sub, subGain, out);

  // Firing-order chuff: an LFO gating the amplitude at the cylinder rate.
  const chuff = osc(ctx, 'square', base * 0.5);
  const chuffAmt = gain(ctx, 0.35);
  modulate(chuff, chuffAmt, out.gain);

  // Intake/turbo hiss tracks the load.
  const air = noiseSource(ctx, { kind: 'pink', seed: 9 });
  const airBp = filter(ctx, 'bandpass', 1400, 1.1);
  const airGain = gain(ctx, 0.07);
  chain(air, airBp, airGain, tone);

  const built = hold(v, out, v.gain * 0.5, 0.12, 1.1, 0.35, [o1, o2, sub, chuff, air]);
  built.set = (param: string, value: number, at: number): void => {
    if (param !== 'speed' && param !== 'load') return;
    const s = Math.max(0, Math.min(1, value));
    const f = base * (0.75 + s * 1.35);
    o1.frequency.setTargetAtTime(clampFreq(ctx, f), at, 0.25);
    o2.frequency.setTargetAtTime(clampFreq(ctx, f * 1.5), at, 0.25);
    sub.frequency.setTargetAtTime(clampFreq(ctx, f * 0.5), at, 0.25);
    chuff.frequency.setTargetAtTime(clampFreq(ctx, f * 0.5), at, 0.25);
    tone.frequency.setTargetAtTime(clampFreq(ctx, 320 + s * 900), at, 0.2);
    airGain.gain.setTargetAtTime(0.05 + s * 0.14, at, 0.3);
  };
  return built;
}

function treadRattle(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const out = gain(ctx, 0);
  const bp = filter(ctx, 'bandpass', 1500, 0.8);
  chain(out, bp, v.dest);
  // A pre-rendered rattle texture loops seamlessly and costs one node to play.
  const buf = debrisBuffer(ctx, 'treadLinks');
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = v.pitch * R(v, 0.9, 1.1);
  src.connect(out);
  // A low plate resonance under the links, so it has weight.
  const plate = noiseSource(ctx, { kind: 'brown', seed: 33 });
  const plateFilter = filter(ctx, 'lowpass', 220, 1.4);
  const plateGain = gain(ctx, 0.3);
  chain(plate, plateFilter, plateGain, out);

  const built = hold(v, out, v.gain * 0.55, 0.08, 1.0, 0.2, [src, plate]);
  built.set = (param: string, value: number, at: number): void => {
    if (param !== 'speed') return;
    const s = Math.max(0, Math.min(1, value));
    src.playbackRate.setTargetAtTime(0.55 + s * 0.85, at, 0.2);
    bp.frequency.setTargetAtTime(clampFreq(ctx, 900 + s * 1600), at, 0.25);
  };
  return built;
}

function treadSqueak(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const p = v.pitch * R(v, 0.8, 1.3);
  const dur = R(v, 0.25, 0.5);
  const out = gain(ctx, 0);
  const bp = filter(ctx, 'bandpass', 2200 * p, 8);
  chain(out, bp, v.dest);
  // Stick-slip: two partials with independent slow wobble.
  for (let i = 0; i < 2; i++) {
    const f = (i === 0 ? 1780 : 2680) * p * R(v, 0.95, 1.05);
    const o1 = osc(ctx, 'sawtooth', f);
    const og = gain(ctx, i === 0 ? 0.5 : 0.28);
    chain(o1, og, out);
    const wob = osc(ctx, 'sine', R(v, 5, 13));
    const wobAmt = gain(ctx, f * R(v, 0.02, 0.06));
    modulate(wob, wobAmt, o1.frequency);
    o1.start(v.t);
    wob.start(v.t);
    o1.stop(v.t + dur + 0.05);
    wob.stop(v.t + dur + 0.05);
  }
  adEnv(out.gain, v.t, v.gain * 0.22, 0.05, dur);
  return oneShot(dur + 0.1);
}

function turretServo(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const p = v.pitch * R(v, 0.9, 1.12);
  const out = gain(ctx, 0);
  const bp = filter(ctx, 'bandpass', 900 * p, 3.5);
  chain(out, bp, v.dest);
  // Motor fundamental plus the gear whine two octaves up.
  const motor = osc(ctx, 'sawtooth', 170 * p);
  const motorGain = gain(ctx, 0.5);
  chain(motor, motorGain, out);
  const whine = osc(ctx, 'square', 1180 * p);
  const whineGain = gain(ctx, 0.1);
  chain(whine, whineGain, out);
  const vib = osc(ctx, 'sine', 22);
  const vibAmt = gain(ctx, 14);
  modulate(vib, vibAmt, whine.frequency);
  const grind = noiseSource(ctx, { kind: 'pink', seed: 15 });
  const grindBp = filter(ctx, 'bandpass', 2400, 2.0);
  const grindGain = gain(ctx, 0.08);
  chain(grind, grindBp, grindGain, out);
  return hold(v, out, v.gain * 0.4, 0.04, 0.35, 0.08, [motor, whine, vib, grind]);
}

function harvesterDrone(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const p = v.pitch;
  const out = gain(ctx, 0);
  const lp = filter(ctx, 'lowpass', 1400, 1.2);
  chain(out, lp, v.dest);
  // Grinding drone: a low saw stack plus a resonant noise band being swept.
  const d1 = osc(ctx, 'sawtooth', 56 * p);
  const d2 = osc(ctx, 'sawtooth', 84 * p, -8);
  const dg = gain(ctx, 0.35);
  d1.connect(dg);
  d2.connect(dg);
  dg.connect(out);
  const grind = noiseSource(ctx, { kind: 'white', seed: 27 });
  const grindBp = filter(ctx, 'bandpass', 1100, 5);
  const grindGain = gain(ctx, 0.28);
  chain(grind, grindBp, grindGain, out);
  const sweepLfo = osc(ctx, 'triangle', 0.7);
  const sweepAmt = gain(ctx, 600);
  modulate(sweepLfo, sweepAmt, grindBp.frequency);
  // Rhythmic auger clank.
  const clank = osc(ctx, 'square', 2.4);
  const clankAmt = gain(ctx, 0.4);
  modulate(clank, clankAmt, out.gain);
  return hold(v, out, v.gain * 0.42, 0.15, 1.8, 0.3, [d1, d2, grind, sweepLfo, clank]);
}

function harvesterDump(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  // Hydraulic release.
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.3, dur: 0.5, from: 3600, to: 1400, filterType: 'bandpass', q: 1.4,
    attack: 0.02, offset: v.rng() * 1.8,
  });
  // Bed tipping: heavy metal clunk.
  modal(v.ctx, v.dest, v.t + 0.12, {
    ratios: [1, 2.4, 4.7, 7.9], base: 140, gain: g * 0.4, decay: 0.5, rng: v.rng, type: 'sine',
  });
  // Ore pouring out.
  debrisField(v, 'orePour', 0.45);
  body(v.ctx, v.dest, v.t + 0.35, { gain: g * 0.3, from: 90, to: 40, dur: 0.5, type: 'sine', attack: 0.05 });
  return oneShot(1.6);
}

/* ---------------------------------------------------------------- infantry */

function footstep(v: VoiceEnv): BuiltSound {
  const p = v.pitch * R(v, 0.85, 1.2);
  const g = v.gain;
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.5, dur: R(v, 0.04, 0.07), from: 1300 * p, to: 300,
    filterType: 'lowpass', q: 0.9, attack: 0.001, offset: v.rng() * 1.8,
  });
  body(v.ctx, v.dest, v.t, { gain: g * 0.35, from: 105 * p, to: 52, dur: 0.06, type: 'sine' });
  debrisField(v, 'gravel', 0.14);
  return oneShot(0.2);
}

function gearRustle(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const dur = R(v, 0.2, 0.35);
  // Fabric: bandpassed noise with a bumpy envelope.
  const src = noiseSource(v.ctx, { kind: 'pink', seed: 19, rate: R(v, 0.8, 1.3) });
  const bp = filter(v.ctx, 'bandpass', R(v, 1800, 3200), 0.9);
  const gg = gain(v.ctx, 0);
  chain(src, bp, gg, v.dest);
  gg.gain.setValueAtTime(1e-4, v.t);
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    gg.gain.linearRampToValueAtTime(g * 0.2 * R(v, 0.3, 1.0), v.t + (dur * i) / steps);
  }
  gg.gain.exponentialRampToValueAtTime(1e-4, v.t + dur + 0.05);
  src.start(v.t, v.rng() * 1.8);
  src.stop(v.t + dur + 0.1);
  // Webbing hardware.
  debrisField(v, 'webbing', 0.1);
  return oneShot(dur + 0.15);
}

function infantryDeath(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const g = v.gain;
  const p = v.pitch * R(v, 0.9, 1.15);
  // A short, choked vocal formant — deliberately stylised, not a scream.
  const dur = R(v, 0.28, 0.4);
  const src = osc(ctx, 'sawtooth', 150 * p);
  const srcGain = gain(ctx, 1);
  sweep(src.frequency, v.t, 150 * p, 82 * p, dur);
  const sum = gain(ctx, 0);
  for (const [f, q, amp] of [[620, 6, 1], [1180, 8, 0.5], [2500, 10, 0.2]] as const) {
    const bp = filter(ctx, 'bandpass', f * p, q);
    const bg = gain(ctx, amp);
    srcGain.connect(bp);
    chain(bp, bg, sum);
  }
  src.connect(srcGain);
  sum.connect(v.dest);
  adEnv(sum.gain, v.t, g * 0.5, 0.02, dur);
  src.start(v.t);
  src.stop(v.t + dur + 0.05);
  // Breath, then the body and kit hitting the ground.
  noiseLayer(ctx, v.dest, v.t + 0.05, {
    gain: g * 0.16, dur: 0.3, from: 1600, to: 600, filterType: 'bandpass', q: 1.1,
    attack: 0.03, offset: v.rng() * 1.8,
  });
  const fall = v.t + R(v, 0.3, 0.45);
  body(ctx, v.dest, fall, { gain: g * 0.45, from: 96, to: 42, dur: 0.16, type: 'sine' });
  noiseLayer(ctx, v.dest, fall, {
    gain: g * 0.3, dur: 0.12, from: 800, to: 200, filterType: 'lowpass', attack: 0.002, offset: v.rng() * 1.8,
  });
  debrisField({ ...v, t: fall }, 'kitFall', 0.14);
  return oneShot(1.0);
}

/* -------------------------------------------------------------- structures */

function construction(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const out = gain(ctx, 0);
  out.connect(v.dest);
  // Motor bed.
  const motor = osc(ctx, 'sawtooth', 78 * v.pitch);
  const motorFilter = filter(ctx, 'lowpass', 500, 2.5);
  const motorGain = gain(ctx, 0.28);
  chain(motor, motorFilter, motorGain, out);
  // Hydraulic hiss pulsing.
  const air = noiseSource(ctx, { kind: 'white', seed: 37 });
  const airBp = filter(ctx, 'bandpass', 3200, 1.3);
  const airGain = gain(ctx, 0.1);
  chain(air, airBp, airGain, out);
  const pulse = osc(ctx, 'sine', 0.9);
  const pulseAmt = gain(ctx, 0.09);
  modulate(pulse, pulseAmt, airGain.gain);
  // Rivet gun / welding sparks.
  const work = debrisBuffer(ctx, 'siteWork');
  const workSrc = ctx.createBufferSource();
  workSrc.buffer = work;
  workSrc.loop = true;
  const workGain = gain(ctx, 0.55);
  chain(workSrc, workGain, out);
  return hold(v, out, v.gain * 0.45, 0.2, 2.0, 0.4, [motor, air, pulse, workSrc]);
}

function powerHum(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const p = v.pitch;
  const out = gain(ctx, 0);
  out.connect(v.dest);
  // Transformer: mains fundamental with its odd harmonics.
  const sources: AudioScheduledSourceNode[] = [];
  const partials: Array<[number, number]> = [[50, 0.5], [100, 0.3], [150, 0.18], [250, 0.08], [350, 0.04]];
  for (const [f, a] of partials) {
    const o1 = osc(ctx, f === 50 ? 'sine' : 'triangle', f * p);
    const og = gain(ctx, a);
    chain(o1, og, out);
    sources.push(o1);
  }
  // Coil buzz.
  const buzz = osc(ctx, 'sawtooth', 100 * p);
  const buzzBp = filter(ctx, 'bandpass', 1600, 6);
  const buzzGain = gain(ctx, 0.06);
  chain(buzz, buzzBp, buzzGain, out);
  sources.push(buzz);
  // Cooling airflow.
  const fan = noiseSource(ctx, { kind: 'pink', seed: 43 });
  const fanLp = filter(ctx, 'lowpass', 700, 0.9);
  const fanGain = gain(ctx, 0.05);
  chain(fan, fanLp, fanGain, out);
  sources.push(fan);
  return hold(v, out, v.gain * 0.35, 0.4, 2.0, 0.6, sources);
}

function radarSweep(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const g = v.gain;
  const p = v.pitch;
  // Dish motor whoosh.
  noiseLayer(ctx, v.dest, v.t, {
    gain: g * 0.22, dur: 1.1, from: 400, to: 2200, filterType: 'bandpass', q: 1.6,
    attack: 0.3, offset: v.rng() * 1.8,
  });
  // Sonar ping with decaying repeats — the classic radar cue.
  for (let i = 0; i < 3; i++) {
    const at = v.t + 0.15 + i * 0.34;
    const o1 = osc(ctx, 'sine', 1180 * p * (1 - i * 0.02));
    const og = gain(ctx, 0);
    const bp = filter(ctx, 'bandpass', 1200 * p, 2.2);
    chain(o1, bp, og, v.dest);
    adEnv(og.gain, at, g * 0.3 * Math.pow(0.5, i), 0.004, 0.3);
    o1.start(at);
    o1.stop(at + 0.4);
  }
  return oneShot(1.6);
}

function refinery(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const out = gain(ctx, 0);
  const lp = filter(ctx, 'lowpass', 1800, 0.9);
  chain(out, lp, v.dest);
  // Conveyor rumble.
  const rumble = noiseSource(ctx, { kind: 'brown', seed: 51 });
  const rumbleLp = filter(ctx, 'lowpass', 260, 1.5);
  const rumbleGain = gain(ctx, 0.5);
  chain(rumble, rumbleLp, rumbleGain, out);
  // Steam venting on a slow cycle.
  const steam = noiseSource(ctx, { kind: 'white', seed: 57 });
  const steamBp = filter(ctx, 'bandpass', 4200, 1.1);
  const steamGain = gain(ctx, 0.04);
  chain(steam, steamBp, steamGain, out);
  const cycle = osc(ctx, 'sine', 0.22);
  const cycleAmt = gain(ctx, 0.05);
  modulate(cycle, cycleAmt, steamGain.gain);
  // Processing clunks.
  const clunks = debrisBuffer(ctx, 'processing');
  const clunkSrc = ctx.createBufferSource();
  clunkSrc.buffer = clunks;
  clunkSrc.loop = true;
  const clunkGain = gain(ctx, 0.45);
  chain(clunkSrc, clunkGain, out);
  return hold(v, out, v.gain * 0.4, 0.3, 2.2, 0.5, [rumble, steam, cycle, clunkSrc]);
}

/* --------------------------------------------------------------------- UI */

function uiClick(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const p = v.pitch;
  transient(v.ctx, v.dest, v.t, { gain: g * 0.35, freq: 5200, decay: 0.004, q: 1.4, offset: v.rng() * 1.8 });
  const o1 = osc(v.ctx, 'square', 940 * p);
  const og = gain(v.ctx, 0);
  const bp = filter(v.ctx, 'bandpass', 1400 * p, 1.6);
  chain(o1, bp, og, v.dest);
  adEnv(og.gain, v.t, g * 0.3, 0.001, 0.045);
  o1.start(v.t);
  o1.stop(v.t + 0.08);
  return oneShot(0.1);
}

function uiTab(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const p = v.pitch;
  // Two-step blip: a small, confident interface movement.
  for (let i = 0; i < 2; i++) {
    const at = v.t + i * 0.045;
    const o1 = osc(v.ctx, 'square', (i === 0 ? 660 : 990) * p);
    const og = gain(v.ctx, 0);
    const bp = filter(v.ctx, 'bandpass', (i === 0 ? 900 : 1400) * p, 2.0);
    chain(o1, bp, og, v.dest);
    adEnv(og.gain, at, g * 0.26, 0.002, 0.05);
    o1.start(at);
    o1.stop(at + 0.09);
  }
  transient(v.ctx, v.dest, v.t, { gain: g * 0.16, freq: 4200, decay: 0.005, q: 1.2, offset: v.rng() * 1.8 });
  return oneShot(0.16);
}

function uiPlace(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const p = v.pitch;
  // Perfect fifth stack with an FM bell edge — a "locked in" confirmation.
  const notes = [392, 588, 784];
  for (let i = 0; i < notes.length; i++) {
    const at = v.t + i * 0.028;
    const carrier = osc(v.ctx, 'sine', notes[i] * p);
    const mod = osc(v.ctx, 'sine', notes[i] * p * 2.01);
    const modAmt = gain(v.ctx, notes[i] * 1.6);
    modulate(mod, modAmt, carrier.frequency);
    const og = gain(v.ctx, 0);
    chain(carrier, og, v.dest);
    adEnv(og.gain, at, (g * 0.22) / (1 + i * 0.4), 0.002, 0.28 + i * 0.06);
    carrier.start(at);
    mod.start(at);
    carrier.stop(at + 0.45);
    mod.stop(at + 0.45);
  }
  // Mechanical seat.
  modal(v.ctx, v.dest, v.t, { ratios: [1, 2.9, 5.2], base: 220, gain: g * 0.14, decay: 0.1, rng: v.rng, type: 'triangle' });
  return oneShot(0.55);
}

function uiInvalid(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const p = v.pitch;
  // Two blunt buzzes: unmistakably "no".
  for (let i = 0; i < 2; i++) {
    const at = v.t + i * 0.11;
    const o1 = osc(v.ctx, 'square', 128 * p * (i === 0 ? 1 : 0.94));
    const bp = filter(v.ctx, 'bandpass', 420, 2.4);
    const og = gain(v.ctx, 0);
    chain(o1, bp, og, v.dest);
    adEnv(og.gain, at, g * 0.3, 0.003, 0.075, 'lin');
    o1.start(at);
    o1.stop(at + 0.12);
  }
  noiseLayer(v.ctx, v.dest, v.t, {
    gain: g * 0.1, dur: 0.2, from: 900, to: 300, filterType: 'bandpass', q: 1.0,
    attack: 0.004, offset: v.rng() * 1.8,
  });
  return oneShot(0.3);
}

function uiAlert(v: VoiceEnv): BuiltSound {
  const ctx = v.ctx;
  const g = v.gain;
  const p = v.pitch;
  // Descending minor third over a sub thump: the EVA attention-getter.
  const notes = [880, 740];
  for (let i = 0; i < notes.length; i++) {
    const at = v.t + i * 0.16;
    const o1 = osc(ctx, 'triangle', notes[i] * p);
    const o2 = osc(ctx, 'triangle', notes[i] * p * 2, 6);
    const og = gain(ctx, 0);
    const bp = filter(ctx, 'bandpass', notes[i] * p * 1.4, 1.4);
    o1.connect(bp);
    const o2g = gain(ctx, 0.3);
    chain(o2, o2g, bp);
    chain(bp, og, v.dest);
    adEnv(og.gain, at, g * 0.3, 0.006, 0.28);
    o1.start(at);
    o2.start(at);
    o1.stop(at + 0.4);
    o2.stop(at + 0.4);
  }
  body(ctx, v.dest, v.t, { gain: g * 0.4, from: 90, to: 44, dur: 0.35, type: 'sine', attack: 0.01 });
  noiseLayer(ctx, v.dest, v.t, {
    gain: g * 0.12, dur: 0.5, from: 5200, to: 1400, filterType: 'bandpass', q: 1.2,
    attack: 0.12, offset: v.rng() * 1.8,
  });
  return oneShot(0.8);
}

function uiHover(v: VoiceEnv): BuiltSound {
  const g = v.gain;
  const o1 = osc(v.ctx, 'sine', 2200 * v.pitch);
  const og = gain(v.ctx, 0);
  chain(o1, og, v.dest);
  adEnv(og.gain, v.t, g * 0.1, 0.001, 0.022);
  o1.start(v.t);
  o1.stop(v.t + 0.05);
  return oneShot(0.06);
}

/* ------------------------------------------------------------ the catalogue */

const def = (
  build: (v: VoiceEnv) => BuiltSound,
  o: Partial<SoundDef> = {},
): SoundDef => ({
  build,
  bus: 'sfx',
  priority: 5,
  maxInstances: 6,
  minInterval: 0.02,
  spatial: true,
  gain: 1,
  space: 0.18,
  reach: 1,
  ...o,
});

export const SFX: Record<string, SoundDef> = {
  // ---- weapons
  'weapon.rifle': def(rifle, { gain: 0.55, maxInstances: 7, minInterval: 0.035, priority: 4, reach: 0.9, space: 0.22 }),
  'weapon.machinegun': def(machinegun, { gain: 0.42, maxInstances: 8, minInterval: 0.028, priority: 4, reach: 0.9, space: 0.2 }),
  'weapon.rocketLaunch': def(rocketLaunch, { gain: 0.8, maxInstances: 5, minInterval: 0.05, priority: 7, reach: 1.5, space: 0.28 }),
  'weapon.rocketFlight': def(rocketFlight, { gain: 0.5, maxInstances: 5, minInterval: 0.05, priority: 3, reach: 1.2, space: 0.15, loopable: true }),
  'weapon.cannon': def(cannon, { gain: 0.9, maxInstances: 5, minInterval: 0.05, priority: 8, reach: 1.8, space: 0.3 }),
  'weapon.artillery': def(artillery, { gain: 1.0, maxInstances: 4, minInterval: 0.08, priority: 9, reach: 2.6, space: 0.34 }),
  'weapon.laser': def(laser, { gain: 0.6, maxInstances: 6, minInterval: 0.04, priority: 6, reach: 1.2, space: 0.22 }),
  'weapon.flak': def(flak, { gain: 0.65, maxInstances: 6, minInterval: 0.035, priority: 6, reach: 1.4, space: 0.26 }),
  'weapon.aaBurst': def(aaBurst, { gain: 0.6, maxInstances: 4, minInterval: 0.12, priority: 6, reach: 1.3, space: 0.24 }),

  // ---- impacts and destruction
  'impact.dirt': def(impactDirt, { gain: 0.6, maxInstances: 7, minInterval: 0.025, priority: 4, reach: 1.0 }),
  'impact.metal': def(impactMetal, { gain: 0.55, maxInstances: 7, minInterval: 0.025, priority: 5, reach: 1.0 }),
  'impact.stone': def(impactStone, { gain: 0.6, maxInstances: 7, minInterval: 0.025, priority: 4, reach: 1.0 }),
  'impact.water': def(impactWater, { gain: 0.55, maxInstances: 5, minInterval: 0.03, priority: 4, reach: 1.0 }),
  'explosion.small': def(explosionSmall, { gain: 0.85, maxInstances: 6, minInterval: 0.04, priority: 8, reach: 1.7, space: 0.3 }),
  'explosion.large': def(explosionLarge, { gain: 1.0, maxInstances: 4, minInterval: 0.09, priority: 10, reach: 2.6, space: 0.38 }),
  'explosion.vehicle': def(explosionVehicle, { gain: 0.9, maxInstances: 4, minInterval: 0.07, priority: 9, reach: 2.0, space: 0.34 }),
  'destroy.building': def(buildingCollapse, { gain: 1.0, maxInstances: 3, minInterval: 0.2, priority: 10, reach: 2.8, space: 0.4 }),

  // ---- vehicles
  'vehicle.engine': def(engineLoop, { gain: 0.5, maxInstances: 8, minInterval: 0.05, priority: 2, reach: 0.75, space: 0.1, loopable: true }),
  'vehicle.tread': def(treadRattle, { gain: 0.45, maxInstances: 8, minInterval: 0.05, priority: 2, reach: 0.7, space: 0.1, loopable: true }),
  'vehicle.squeak': def(treadSqueak, { gain: 0.4, maxInstances: 4, minInterval: 0.3, priority: 2, reach: 0.6 }),
  'vehicle.servo': def(turretServo, { gain: 0.42, maxInstances: 6, minInterval: 0.08, priority: 3, reach: 0.6, space: 0.08, loopable: true }),
  'harvester.mine': def(harvesterDrone, { gain: 0.5, maxInstances: 4, minInterval: 0.1, priority: 3, reach: 0.9, space: 0.14, loopable: true }),
  'harvester.dump': def(harvesterDump, { gain: 0.6, maxInstances: 3, minInterval: 0.2, priority: 4, reach: 0.9 }),

  // ---- infantry
  'infantry.footstep': def(footstep, { gain: 0.35, maxInstances: 6, minInterval: 0.05, priority: 1, reach: 0.45 }),
  'infantry.gear': def(gearRustle, { gain: 0.35, maxInstances: 4, minInterval: 0.15, priority: 1, reach: 0.45 }),
  'infantry.death': def(infantryDeath, { gain: 0.6, maxInstances: 4, minInterval: 0.08, priority: 5, reach: 0.9 }),

  // ---- structures
  'structure.construct': def(construction, { gain: 0.55, maxInstances: 3, minInterval: 0.1, priority: 3, reach: 1.0, loopable: true }),
  'structure.power': def(powerHum, { gain: 0.45, maxInstances: 3, minInterval: 0.2, priority: 2, reach: 0.8, space: 0.08, loopable: true }),
  'structure.radar': def(radarSweep, { gain: 0.5, maxInstances: 2, minInterval: 0.5, priority: 3, reach: 1.0 }),
  'structure.refinery': def(refinery, { gain: 0.5, maxInstances: 3, minInterval: 0.2, priority: 2, reach: 1.0, space: 0.12, loopable: true }),

  // ---- interface (non-positional, on the UI bus)
  'ui.click': def(uiClick, { bus: 'ui', spatial: false, gain: 0.7, maxInstances: 4, minInterval: 0.02, priority: 6, space: 0 }),
  'ui.tab': def(uiTab, { bus: 'ui', spatial: false, gain: 0.7, maxInstances: 3, minInterval: 0.03, priority: 6, space: 0 }),
  'ui.place': def(uiPlace, { bus: 'ui', spatial: false, gain: 0.75, maxInstances: 3, minInterval: 0.05, priority: 7, space: 0 }),
  'ui.invalid': def(uiInvalid, { bus: 'ui', spatial: false, gain: 0.7, maxInstances: 2, minInterval: 0.12, priority: 7, space: 0 }),
  'ui.alert': def(uiAlert, { bus: 'ui', spatial: false, gain: 0.75, maxInstances: 2, minInterval: 0.25, priority: 9, space: 0 }),
  'ui.hover': def(uiHover, { bus: 'ui', spatial: false, gain: 0.5, maxInstances: 2, minInterval: 0.04, priority: 2, space: 0 }),
};

export const SFX_IDS: string[] = Object.keys(SFX);

/**
 * Builds every generated buffer the catalogue can ask for. Called once when the
 * context comes up so no in-game trigger ever pays generation cost on the audio
 * thread's critical path.
 */
export function prewarm(ctx: BaseAudioContext): void {
  for (const name of Object.keys(DEBRIS) as DebrisName[]) debrisBuffer(ctx, name);
  for (const seed of [1, 13, 27, 37, 57]) noiseBuffer(ctx, 'white', 2, seed);
  for (const seed of [1, 5, 9, 15, 19, 43]) noiseBuffer(ctx, 'pink', 2, seed);
  for (const seed of [1, 33, 51]) noiseBuffer(ctx, 'brown', 2, seed);
}
