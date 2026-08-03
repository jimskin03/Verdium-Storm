import { makeRng } from '@/util/Noise';

/**
 * Low level synthesis primitives. Everything in this file works against a plain
 * `BaseAudioContext`, so the exact same graph can be built inside a live
 * `AudioContext` or inside an `OfflineAudioContext` for measurement. That is the
 * only way to verify audio in a container that has no speakers: render it and
 * look at the numbers.
 *
 * No sample files exist anywhere in this project. Every waveform below is either
 * an oscillator, a filtered noise source, or an `AudioBuffer` filled by JS math.
 */

export type NoiseKind = 'white' | 'pink' | 'brown';

/** Smallest value an exponential ramp may target; 0 is illegal for those. */
export const EPS = 1e-4;

/* ------------------------------------------------------------------ buffers */

/**
 * Generated buffers are shared across contexts (the spec allows it as long as
 * the sample rate matches) so the offline measurement path does not pay the
 * generation cost again.
 */
const bufferCache = new Map<string, AudioBuffer>();

function cached(key: string, make: () => AudioBuffer): AudioBuffer {
  const hit = bufferCache.get(key);
  if (hit) return hit;
  const made = make();
  bufferCache.set(key, made);
  return made;
}

/** Crossfades the tail into the head so a looped buffer has no seam click. */
function makeLoopSafe(data: Float32Array, sampleRate: number, fade = 0.02): void {
  const n = Math.min(Math.floor(sampleRate * fade), Math.floor(data.length / 4));
  if (n <= 1) return;
  const head = data.length - n;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = data[i];
    const b = data[head + i];
    // Equal-power crossfade of the wrap point into the start of the buffer.
    data[i] = a * Math.sqrt(t) + b * Math.sqrt(1 - t);
  }
  data.copyWithin(head, 0, n);
}

export function noiseBuffer(
  ctx: BaseAudioContext,
  kind: NoiseKind = 'white',
  seconds = 2,
  seed = 1,
  loopSafe = true,
): AudioBuffer {
  const sr = ctx.sampleRate;
  return cached(`noise:${kind}:${seconds}:${seed}:${loopSafe}:${sr}`, () => {
    const len = Math.max(64, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const rng = makeRng((seed * 2654435761) >>> 0);
    if (kind === 'white') {
      for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellet's economical pink filter.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
        b6 = w * 0.115926;
      }
    } else {
      // Leaky integrator: brown/red noise, dominated by the bottom two octaves.
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + (rng() * 2 - 1) * 0.035) * 0.997;
        d[i] = last * 6;
      }
    }
    if (loopSafe) makeLoopSafe(d, sr);
    return buf;
  });
}

export interface ImpulseTextureOptions {
  seconds: number;
  /** Impulses per second. */
  density: number;
  freqMin: number;
  freqMax: number;
  /** Ring decay in seconds for one impulse. */
  decay: number;
  /** 0 = pure resonant ping, 1 = broadband knock. */
  noisiness?: number;
  seed?: number;
  loopSafe?: boolean;
  /** Optional density shaping over the buffer, 0..1 in, gain multiplier out. */
  shape?: (t01: number) => number;
}

/**
 * Sparse resonant impulses — the workhorse behind tread rattle, gravel, shrapnel
 * and collapsing debris. Each impulse is a two-pole resonator excited by a
 * single sample, which is far cheaper than instantiating a node per grain and
 * sounds better than gating noise.
 */
export function impulseTexture(ctx: BaseAudioContext, opts: ImpulseTextureOptions): AudioBuffer {
  const sr = ctx.sampleRate;
  const key = `imp:${opts.seconds}:${opts.density}:${opts.freqMin}:${opts.freqMax}:${opts.decay}:${opts.noisiness ?? 0}:${opts.seed ?? 3}:${opts.loopSafe ?? false}:${opts.shape ? 'S' : 'F'}:${sr}`;
  return cached(key, () => {
    const len = Math.max(64, Math.floor(sr * opts.seconds));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const rng = makeRng(((opts.seed ?? 3) * 2246822519) >>> 0);
    const count = Math.max(1, Math.round(opts.density * opts.seconds));
    const noisiness = opts.noisiness ?? 0.15;
    for (let k = 0; k < count; k++) {
      const at = Math.floor(rng() * len);
      const shapeGain = opts.shape ? opts.shape(at / len) : 1;
      if (shapeGain <= 0.001) continue;
      const f = opts.freqMin * Math.pow(opts.freqMax / opts.freqMin, rng());
      const decay = opts.decay * (0.45 + rng() * 1.1);
      const amp = shapeGain * (0.25 + rng() * 0.75);
      const w = (2 * Math.PI * f) / sr;
      const r = Math.exp(-1 / (decay * sr));
      // Direct-form resonator: y[n] = 2 r cos(w) y[n-1] - r^2 y[n-2] + x[n]
      const a1 = 2 * r * Math.cos(w);
      const a2 = -r * r;
      let y1 = 0;
      let y2 = 0;
      const tail = Math.min(len - at, Math.floor(decay * sr * 6));
      for (let i = 0; i < tail; i++) {
        const drive = i === 0 ? 1 : noisiness * (rng() * 2 - 1) * Math.exp(-i / (sr * decay * 0.35));
        const y = a1 * y1 + a2 * y2 + drive;
        y2 = y1;
        y1 = y;
        d[at + i] += y * amp * 0.06;
      }
    }
    // Normalise so callers can reason about gain in a predictable range.
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) {
      const s = 0.9 / peak;
      for (let i = 0; i < len; i++) d[i] *= s;
    }
    if (opts.loopSafe) makeLoopSafe(d, sr);
    return buf;
  });
}

/**
 * Procedural room impulse response: exponentially decaying noise with a handful
 * of discrete early reflections. Used by the convolution reverb sends.
 */
export function reverbImpulse(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  brightness: number,
  seed = 7,
): AudioBuffer {
  const sr = ctx.sampleRate;
  return cached(`ir:${seconds}:${decay}:${brightness}:${seed}:${sr}`, () => {
    const len = Math.max(64, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const rng = makeRng((seed * 2654435761) >>> 0);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      // One-pole lowpass state, so the tail darkens as it decays.
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const envelope = Math.pow(1 - t, decay);
        const cutoff = brightness * (1 - t * 0.85) + 0.02;
        lp += (rng() * 2 - 1 - lp) * cutoff;
        d[i] = lp * envelope;
      }
      // Early reflections give the space a size before the diffuse tail arrives.
      const reflections = 7;
      for (let k = 0; k < reflections; k++) {
        const at = Math.floor((0.008 + rng() * 0.09) * sr);
        if (at < len) d[at] += (rng() * 2 - 1) * 0.55 * (1 - k / reflections);
      }
      // Fade the first millisecond so the IR does not add a click of its own.
      const pre = Math.floor(sr * 0.001);
      for (let i = 0; i < pre; i++) d[i] *= i / pre;
    }
    return buf;
  });
}

/** Waveshaper transfer curve; `amount` 0..1 goes from gentle drive to hard grit. */
export function saturationCurve(amount: number, samples = 1024): Float32Array {
  const key = `curve:${amount.toFixed(3)}:${samples}`;
  const hit = curveCache.get(key);
  if (hit) return hit;
  const curve = new Float32Array(samples);
  const k = 1 + amount * 60;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  curveCache.set(key, curve);
  return curve;
}
const curveCache = new Map<string, Float32Array>();

/**
 * Soft clipper for the master output. Fed at 0.5x the signal, the curve reads
 * `tanh(s)` for a signal `s`: unity gain and no colouration below about -12 dBFS,
 * a smooth knee above it, and a hard ceiling of 0.96 for anything past +6 dB.
 */
export function softClipCurve(samples = 2048): Float32Array {
  const key = `softclip:${samples}`;
  const hit = curveCache.get(key);
  if (hit) return hit;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(2 * x);
  }
  curveCache.set(key, curve);
  return curve;
}

/* ---------------------------------------------------------------- envelopes */

/** Percussive attack/decay on a gain-like param. Leaves the param at 0. */
export function adEnv(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  decay: number,
  curve: 'exp' | 'lin' = 'exp',
): number {
  const p = Math.max(peak, EPS * 2);
  param.setValueAtTime(EPS, t);
  if (attack <= 0.0005) param.setValueAtTime(p, t);
  else param.linearRampToValueAtTime(p, t + attack);
  if (curve === 'exp') param.exponentialRampToValueAtTime(EPS, t + attack + decay);
  else param.linearRampToValueAtTime(0, t + attack + decay);
  param.setValueAtTime(0, t + attack + decay + 0.001);
  return attack + decay + 0.001;
}

/** Attack / hold / release for sustained layers. */
export function ahrEnv(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): number {
  const p = Math.max(peak, EPS * 2);
  param.setValueAtTime(EPS, t);
  param.linearRampToValueAtTime(p, t + attack);
  param.setValueAtTime(p, t + attack + hold);
  param.exponentialRampToValueAtTime(EPS, t + attack + hold + release);
  param.setValueAtTime(0, t + attack + hold + release + 0.001);
  return attack + hold + release + 0.001;
}

/** Exponential parameter sweep that tolerates zero/negative endpoints. */
export function sweep(param: AudioParam, t: number, from: number, to: number, dur: number): void {
  const a = Math.max(from, EPS);
  const b = Math.max(to, EPS);
  param.setValueAtTime(a, t);
  param.exponentialRampToValueAtTime(b, t + Math.max(dur, 0.001));
}

/* -------------------------------------------------------------- node makers */

export function gain(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function filter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.707,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clampFreq(ctx, freq);
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function clampFreq(ctx: BaseAudioContext, f: number): number {
  const nyquist = ctx.sampleRate * 0.5;
  return Math.min(Math.max(f, 10), nyquist * 0.98);
}

export function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: number,
  detuneCents = 0,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = clampFreq(ctx, freq);
  o.detune.value = detuneCents;
  return o;
}

export interface NoiseSourceOptions {
  kind?: NoiseKind;
  /** Playback rate; below 1 shifts the spectrum down and stretches the grain. */
  rate?: number;
  loop?: boolean;
  seconds?: number;
  seed?: number;
}

export function noiseSource(ctx: BaseAudioContext, opts: NoiseSourceOptions = {}): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.kind ?? 'white', opts.seconds ?? 2, opts.seed ?? 1);
  src.loop = opts.loop ?? true;
  src.playbackRate.value = opts.rate ?? 1;
  return src;
}

/** Connects an LFO (via its depth gain) to a modulation target parameter. */
export function modulate(src: AudioNode, depth: GainNode, param: AudioParam): void {
  src.connect(depth);
  depth.connect(param);
}

/** Connects a chain of nodes left to right and returns the last one. */
export function chain<T extends AudioNode>(...nodes: [AudioNode, ...AudioNode[], T]): T {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1] as T;
}

/* --------------------------------------------------------- composite voices */

export interface TransientOptions {
  gain: number;
  freq?: number;
  decay?: number;
  /** Bandpass Q for the noise component. */
  q?: number;
  /** Read offset into the noise buffer; vary it so repeats differ. */
  offset?: number;
}

/** The initial "click" of any impact: two milliseconds of bright band noise. */
export function transient(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  o: TransientOptions,
): number {
  const dur = o.decay ?? 0.012;
  const src = noiseSource(ctx, { kind: 'white' });
  const bp = filter(ctx, 'bandpass', o.freq ?? 3200, o.q ?? 0.9);
  const g = gain(ctx, 0);
  chain(src, bp, g, dest);
  adEnv(g.gain, t, o.gain, 0.0008, dur);
  src.start(t, o.offset ?? Math.random() * 1.8);
  src.stop(t + dur + 0.02);
  return dur;
}

export interface BodyOptions {
  gain: number;
  from: number;
  to: number;
  dur: number;
  type?: OscillatorType;
  attack?: number;
}

/** Low-frequency "body" of an explosion or gunshot: a fast downward pitch drop. */
export function body(ctx: BaseAudioContext, dest: AudioNode, t: number, o: BodyOptions): number {
  const o1 = osc(ctx, o.type ?? 'sine', o.from);
  const g = gain(ctx, 0);
  chain(o1, g, dest);
  sweep(o1.frequency, t, o.from, o.to, o.dur);
  adEnv(g.gain, t, o.gain, o.attack ?? 0.002, o.dur);
  o1.start(t);
  o1.stop(t + o.dur + 0.05);
  return o.dur;
}

export interface NoiseLayerOptions {
  gain: number;
  dur: number;
  kind?: NoiseKind;
  filterType?: BiquadFilterType;
  from: number;
  to?: number;
  q?: number;
  attack?: number;
  rate?: number;
  seed?: number;
  /** Optional second filter stage, e.g. a highpass to clear the mud. */
  highpass?: number;
  /** Read offset into the noise buffer; vary it so repeats differ. */
  offset?: number;
}

/** Filtered noise with a swept cutoff — smoke, blast, wind, hiss, whoosh. */
export function noiseLayer(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  o: NoiseLayerOptions,
): number {
  const src = noiseSource(ctx, { kind: o.kind ?? 'white', rate: o.rate ?? 1, seed: o.seed ?? 1 });
  const f = filter(ctx, o.filterType ?? 'lowpass', o.from, o.q ?? 0.8);
  const g = gain(ctx, 0);
  let tail: AudioNode = f;
  if (o.highpass !== undefined) {
    const hp = filter(ctx, 'highpass', o.highpass, 0.7);
    f.connect(hp);
    tail = hp;
  }
  src.connect(f);
  tail.connect(g);
  g.connect(dest);
  if (o.to !== undefined) sweep(f.frequency, t, clampFreq(ctx, o.from), clampFreq(ctx, o.to), o.dur);
  adEnv(g.gain, t, o.gain, o.attack ?? 0.004, o.dur);
  src.start(t, o.offset ?? Math.random() * 1.8);
  src.stop(t + o.dur + 0.05);
  return o.dur;
}

export interface ModalOptions {
  /** Partial ratios; inharmonic ratios read as metal, harmonic as wood. */
  ratios: number[];
  base: number;
  gain: number;
  decay: number;
  /** Per-partial decay scaling: higher partials should die first. */
  damping?: number;
  type?: OscillatorType;
  rng?: () => number;
}

/** Modal (struck-bar) synthesis — the core of metal clangs and bell hits. */
export function modal(ctx: BaseAudioContext, dest: AudioNode, t: number, o: ModalOptions): number {
  const rng = o.rng ?? Math.random;
  const damping = o.damping ?? 0.55;
  let longest = 0;
  for (let i = 0; i < o.ratios.length; i++) {
    const f = o.base * o.ratios[i] * (0.99 + rng() * 0.02);
    if (f > ctx.sampleRate * 0.48) continue;
    const decay = o.decay * Math.pow(damping, i * 0.6);
    const amp = (o.gain / (1 + i * 0.85)) * (0.7 + rng() * 0.6);
    const o1 = osc(ctx, o.type ?? 'sine', f);
    const g = gain(ctx, 0);
    chain(o1, g, dest);
    adEnv(g.gain, t, amp, 0.001, decay);
    // Real bars drop slightly in pitch as the strike energy dissipates.
    sweep(o1.frequency, t, f, f * 0.985, decay);
    o1.start(t);
    o1.stop(t + decay + 0.05);
    longest = Math.max(longest, decay);
  }
  return longest;
}

/** Rising sine "bubble" — water splash and droplet component. */
export function bubble(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  f0: number,
  rise: number,
  dur: number,
  amp: number,
): number {
  const o1 = osc(ctx, 'sine', f0);
  const g = gain(ctx, 0);
  chain(o1, g, dest);
  sweep(o1.frequency, t, f0, f0 * rise, dur);
  adEnv(g.gain, t, amp, 0.002, dur);
  o1.start(t);
  o1.stop(t + dur + 0.03);
  return dur;
}

/** Plays a generated buffer once with an amplitude envelope. */
export function grainBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  buffer: AudioBuffer,
  o: { gain: number; dur: number; rate?: number; attack?: number; offset?: number; filterHz?: number; filterType?: BiquadFilterType },
): number {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = o.rate ?? 1;
  const g = gain(ctx, 0);
  if (o.filterHz !== undefined) {
    const f = filter(ctx, o.filterType ?? 'lowpass', o.filterHz, 0.8);
    chain(src, f, g, dest);
  } else {
    chain(src, g, dest);
  }
  adEnv(g.gain, t, o.gain, o.attack ?? 0.003, o.dur);
  src.start(t, o.offset ?? 0);
  src.stop(t + o.dur + 0.05);
  return o.dur;
}
