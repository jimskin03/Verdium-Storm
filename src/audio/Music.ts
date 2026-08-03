import { adEnv, chain, clampFreq, filter, gain, modulate, noiseSource, osc, saturationCurve, sweep } from './Synth';

/**
 * Adaptive score.
 *
 * An industrial/orchestral-electronic bed in the C&C tradition: percussive
 * ostinato, distorted bass, cold pads, a brass-ish stab layer and a lead motif,
 * all generated note by note from oscillators. Intensity is expressed as layer
 * gains rather than as separate tracks, and every state change is deferred to
 * the next bar line so transitions are musical instead of a crossfade.
 *
 * Timing comes from a lookahead scheduler: a coarse 25 ms timer that schedules
 * every note 200 ms early against `ctx.currentTime`. Nothing is triggered by a
 * per-note `setTimeout`, so jitter in the JS event loop cannot smear the groove.
 */

export type MusicState = 'menu' | 'calm' | 'tension' | 'combat';

type LayerName = 'drums' | 'bass' | 'pulse' | 'pad' | 'lead' | 'stab';

const LAYER_MIX: Record<MusicState, Record<LayerName, number>> = {
  menu: { drums: 0.0, bass: 0.28, pulse: 0.0, pad: 0.95, lead: 0.5, stab: 0.0 },
  calm: { drums: 0.18, bass: 0.5, pulse: 0.22, pad: 0.72, lead: 0.16, stab: 0.0 },
  tension: { drums: 0.62, bass: 0.78, pulse: 0.7, pad: 0.55, lead: 0.3, stab: 0.35 },
  combat: { drums: 1.0, bass: 0.95, pulse: 0.9, pad: 0.42, lead: 0.8, stab: 0.9 },
};

const INTENSITY: Record<MusicState, number> = { menu: 0, calm: 1, tension: 2, combat: 3 };

const BPM = 126;
const STEPS_PER_BAR = 16;
const SECONDS_PER_STEP = 60 / BPM / 4;

/** i – VI – III – VII in C minor: the four bars the whole score turns on. */
const PROGRESSION: number[][] = [
  [36, 39, 43], // Cm
  [32, 36, 39], // Ab
  [39, 43, 46], // Eb
  [34, 38, 41], // Bb
];

/** Natural minor, used for the lead and the arpeggio. */
const SCALE = [0, 2, 3, 5, 7, 8, 10];

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** step → velocity; absent steps are silent. */
type Pattern = Record<number, number>;

const PATTERNS: Record<string, Record<'calm' | 'tension' | 'combat', Pattern>> = {
  kick: {
    calm: { 0: 0.8 },
    tension: { 0: 1, 8: 0.85 },
    combat: { 0: 1, 4: 0.6, 6: 0.8, 8: 1, 14: 0.85 },
  },
  snare: {
    calm: { 12: 0.5 },
    tension: { 4: 0.85, 12: 0.9 },
    combat: { 4: 1, 7: 0.28, 12: 1, 15: 0.35 },
  },
  hat: {
    calm: { 4: 0.3, 12: 0.3 },
    tension: { 0: 0.5, 2: 0.3, 4: 0.5, 6: 0.3, 8: 0.5, 10: 0.3, 12: 0.5, 14: 0.3 },
    combat: {
      0: 0.6, 1: 0.22, 2: 0.4, 3: 0.22, 4: 0.6, 5: 0.22, 6: 0.4, 7: 0.3,
      8: 0.6, 9: 0.22, 10: 0.4, 11: 0.22, 12: 0.6, 13: 0.3, 14: 0.45, 15: 0.35,
    },
  },
  metal: {
    calm: {},
    tension: { 2: 0.4, 10: 0.4 },
    combat: { 2: 0.55, 7: 0.35, 10: 0.55, 15: 0.4 },
  },
  bass: {
    calm: { 0: 0.9, 8: 0.7 },
    tension: { 0: 1, 3: 0.6, 6: 0.7, 8: 1, 11: 0.6, 14: 0.7 },
    combat: { 0: 1, 2: 0.5, 3: 0.7, 6: 0.8, 8: 1, 10: 0.5, 11: 0.7, 14: 0.85 },
  },
};

/** Lead motif over the 4-bar progression: [bar, step, scale degree, steps long]. */
const MOTIF: Array<[number, number, number, number]> = [
  [0, 0, 0, 3], [0, 6, 2, 2], [0, 8, 4, 4], [0, 14, 3, 2],
  [1, 0, 2, 4], [1, 8, 1, 3], [1, 12, 0, 4],
  [2, 0, 4, 3], [2, 4, 5, 3], [2, 8, 4, 3], [2, 12, 2, 4],
  [3, 0, 3, 4], [3, 6, 2, 2], [3, 8, 0, 8],
];

export interface MusicOptions {
  /** Music bus input. */
  dest: AudioNode;
  /** Long reverb send for pads and lead. */
  hall: GainNode;
  /** Trim layer count on weak hardware. */
  reduced?: boolean;
}

interface Layer {
  gain: GainNode;
  input: AudioNode;
}

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly opts: MusicOptions;
  private readonly layers: Record<LayerName, Layer>;
  private readonly out: GainNode;

  private state: MusicState = 'calm';
  private pending: MusicState | null = null;
  private step = 0;
  private nextStepTime = 0;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rngState = 0x9e3779b9;

  constructor(ctx: BaseAudioContext, opts: MusicOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.out = gain(ctx, 1);
    this.out.connect(opts.dest);
    this.layers = {
      drums: this.buildDrumLayer(),
      bass: this.buildBassLayer(),
      pulse: this.buildPulseLayer(),
      pad: this.buildPadLayer(),
      lead: this.buildLeadLayer(),
      stab: this.buildStabLayer(),
    };
    for (const name of Object.keys(this.layers) as LayerName[]) {
      this.layers[name].gain.gain.value = 0;
    }
  }

  /* ------------------------------------------------------------ transport */

  /** Begins the clock. Safe to call twice. */
  start(at = this.ctx.currentTime + 0.08): void {
    if (this.started) return;
    this.started = true;
    this.nextStepTime = at;
    this.applyMix(this.state, at, 0.5);
    this.scheduleAhead(at + 0.25);
    if (typeof setInterval === 'function' && !this.isOffline) {
      this.timer = setInterval(() => this.tick(), 25);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.4);
  }

  private get isOffline(): boolean {
    return typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
  }

  /** Requests a state. The change lands on the next bar line, never mid-bar. */
  setState(next: MusicState): void {
    if (next === this.state && this.pending === null) return;
    if (next === this.state) {
      this.pending = null;
      return;
    }
    this.pending = next;
    // Menu is the one transition that is allowed to be immediate-ish, because
    // it only ever happens outside a match.
    if (!this.started) this.state = next;
  }

  get currentState(): MusicState {
    return this.state;
  }

  private tick(): void {
    if (!this.started) return;
    this.scheduleAhead(this.ctx.currentTime + 0.2);
  }

  /** Schedules every step whose time falls before `until`. */
  scheduleAhead(until: number): void {
    let guard = 0;
    while (this.nextStepTime < until && guard++ < 4096) {
      this.scheduleStep(this.step, this.nextStepTime);
      this.nextStepTime += SECONDS_PER_STEP;
      this.step++;
    }
  }

  /** Offline helper: lays down `seconds` of music in one pass. */
  renderOffline(seconds: number): void {
    this.start(0.05);
    this.scheduleAhead(seconds);
  }

  /* ------------------------------------------------------------- arranging */

  private rng(): number {
    // xorshift; the score should vary but stay reproducible within a session.
    let x = this.rngState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.rngState = x;
    return x / 4294967296;
  }

  private applyMix(state: MusicState, at: number, seconds: number): void {
    const mix = LAYER_MIX[state];
    for (const name of Object.keys(this.layers) as LayerName[]) {
      const p = this.layers[name].gain.gain;
      p.cancelScheduledValues(at);
      p.setValueAtTime(Math.max(p.value, 1e-4), at);
      p.linearRampToValueAtTime(mix[name], at + seconds);
    }
  }

  private scheduleStep(step: number, t: number): void {
    const inBar = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const chordIndex = bar % PROGRESSION.length;
    const chord = PROGRESSION[chordIndex];

    // ---- state changes land here, on the bar line -------------------------
    if (inBar === 0 && this.pending !== null && this.pending !== this.state) {
      const rising = INTENSITY[this.pending] > INTENSITY[this.state];
      const prev = this.state;
      this.state = this.pending;
      this.pending = null;
      // Rising intensity gets a crash and a sub drop on the downbeat; falling
      // intensity fades over a full bar so it feels like the fight receding.
      this.applyMix(this.state, t, rising ? 0.45 : SECONDS_PER_STEP * 16);
      if (rising && prev !== 'menu') this.crash(t, 0.5 + 0.2 * INTENSITY[this.state]);
    }

    const state = this.state;
    const level = state === 'menu' ? 'calm' : state;

    // ---- percussion --------------------------------------------------------
    if (state !== 'menu') {
      const k = PATTERNS.kick[level][inBar];
      if (k) this.kick(t, k);
      const s = PATTERNS.snare[level][inBar];
      if (s) this.snare(t, s);
      const h = PATTERNS.hat[level][inBar];
      if (h) this.hat(t, h * (0.85 + this.rng() * 0.3));
      const m = PATTERNS.metal[level][inBar];
      if (m) this.metal(t, m * (0.8 + this.rng() * 0.4));
    }

    // ---- bass --------------------------------------------------------------
    const bv = state === 'menu' ? (inBar === 0 ? 0.7 : 0) : PATTERNS.bass[level][inBar];
    if (bv) {
      // Octave jumps on the off-16ths give the ostinato its forward drive.
      const octave = inBar % 4 === 3 && state === 'combat' ? 12 : 0;
      this.bass(t, mtof(chord[0] + octave), SECONDS_PER_STEP * (state === 'menu' ? 12 : 1.6), bv);
    }

    // ---- 16th pulse --------------------------------------------------------
    if (state !== 'menu' && state !== 'calm') {
      const degree = [0, 2, 1, 2][inBar % 4];
      const note = chord[degree] + 24;
      this.pulse(t, mtof(note), 0.5 + (inBar % 2 === 0 ? 0.25 : 0));
    } else if (state === 'calm' && inBar % 4 === 0) {
      this.pulse(t, mtof(chord[inBar % 3] + 24), 0.4);
    }

    // ---- pad ---------------------------------------------------------------
    if (inBar === 0) this.pad(t, chord, SECONDS_PER_STEP * 16);

    // ---- brass stabs -------------------------------------------------------
    if (state === 'tension' || state === 'combat') {
      if (inBar === 0 || (inBar === 10 && state === 'combat')) {
        this.stab(t, chord, SECONDS_PER_STEP * (inBar === 0 ? 3 : 2));
      }
    }

    // ---- lead motif --------------------------------------------------------
    if (state !== 'calm') {
      const phraseBar = bar % 4;
      for (const [b, s, deg, len] of MOTIF) {
        if (b !== phraseBar || s !== inBar) continue;
        const midi = 60 + SCALE[deg % SCALE.length] + Math.floor(deg / SCALE.length) * 12;
        this.lead(t, mtof(midi), SECONDS_PER_STEP * len);
      }
    }
  }

  /* ----------------------------------------------------------- instruments */

  private buildDrumLayer(): Layer {
    const g = gain(this.ctx, 0);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = saturationCurve(0.18);
    const tone = filter(this.ctx, 'highpass', 32, 0.7);
    chain(g, shaper, tone, this.out);
    return { gain: g, input: g };
  }

  private buildBassLayer(): Layer {
    const g = gain(this.ctx, 0);
    const lp = filter(this.ctx, 'lowpass', 1400, 1.1);
    const drive = this.ctx.createWaveShaper();
    drive.curve = saturationCurve(0.5);
    const post = filter(this.ctx, 'highpass', 28, 0.7);
    chain(g, drive, lp, post, this.out);
    return { gain: g, input: g };
  }

  private buildPulseLayer(): Layer {
    const g = gain(this.ctx, 0);
    const lp = filter(this.ctx, 'lowpass', 2600, 7);
    // Slow filter movement so the ostinato breathes across bars.
    const lfo = osc(this.ctx, 'sine', 0.06);
    const lfoAmt = gain(this.ctx, 1400);
    modulate(lfo, lfoAmt, lp.frequency);
    lfo.start(0);
    const delay = this.ctx.createDelay(1);
    delay.delayTime.value = SECONDS_PER_STEP * 3;
    const fb = gain(this.ctx, 0.32);
    const wet = gain(this.ctx, 0.3);
    chain(g, lp, this.out);
    lp.connect(delay);
    chain(delay, fb);
    fb.connect(delay);
    chain(delay, wet, this.out);
    return { gain: g, input: g };
  }

  private buildPadLayer(): Layer {
    const g = gain(this.ctx, 0);
    const lp = filter(this.ctx, 'lowpass', 1700, 0.8);
    // Chorus: two short modulated delays, which is what stops a saw stack from
    // sounding like a single fat oscillator.
    const dry = gain(this.ctx, 0.7);
    chain(g, lp, dry, this.out);
    for (let i = 0; i < 2; i++) {
      const d = this.ctx.createDelay(0.06);
      d.delayTime.value = 0.012 + i * 0.009;
      const lfo = osc(this.ctx, 'sine', 0.11 + i * 0.07);
      const amt = gain(this.ctx, 0.004);
      modulate(lfo, amt, d.delayTime);
      lfo.start(0);
      const wet = gain(this.ctx, 0.3);
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = i === 0 ? -0.7 : 0.7;
      lp.connect(d);
      chain(d, wet, pan, this.out);
    }
    lp.connect(this.opts.hall);
    return { gain: g, input: g };
  }

  private buildLeadLayer(): Layer {
    const g = gain(this.ctx, 0);
    const lp = filter(this.ctx, 'lowpass', 3200, 3);
    const drive = this.ctx.createWaveShaper();
    drive.curve = saturationCurve(0.28);
    const delay = this.ctx.createDelay(1);
    delay.delayTime.value = SECONDS_PER_STEP * 6;
    const fb = gain(this.ctx, 0.34);
    const wet = gain(this.ctx, 0.34);
    const damp = filter(this.ctx, 'lowpass', 2400, 0.7);
    chain(g, drive, lp, this.out);
    lp.connect(delay);
    chain(delay, damp, fb);
    fb.connect(delay);
    chain(damp, wet, this.out);
    lp.connect(this.opts.hall);
    return { gain: g, input: g };
  }

  private buildStabLayer(): Layer {
    const g = gain(this.ctx, 0);
    const lp = filter(this.ctx, 'lowpass', 2400, 1.4);
    chain(g, lp, this.out);
    lp.connect(this.opts.hall);
    return { gain: g, input: g };
  }

  private kick(t: number, vel: number): void {
    const dest = this.layers.drums.input;
    const o1 = osc(this.ctx, 'sine', 150);
    const g = gain(this.ctx, 0);
    chain(o1, g, dest);
    sweep(o1.frequency, t, 150, 44, 0.09);
    adEnv(g.gain, t, vel * 0.9, 0.001, 0.34);
    o1.start(t);
    o1.stop(t + 0.42);
    // Beater click.
    const n = noiseSource(this.ctx, { kind: 'white', seed: 1 });
    const hp = filter(this.ctx, 'highpass', 1800, 0.8);
    const ng = gain(this.ctx, 0);
    chain(n, hp, ng, dest);
    adEnv(ng.gain, t, vel * 0.16, 0.0005, 0.012);
    n.start(t, this.rng() * 1.5);
    n.stop(t + 0.05);
  }

  private snare(t: number, vel: number): void {
    const dest = this.layers.drums.input;
    // Industrial snare: noise body plus two detuned tuned shells.
    const n = noiseSource(this.ctx, { kind: 'white', seed: 2 });
    const bp = filter(this.ctx, 'bandpass', 1900, 0.8);
    const ng = gain(this.ctx, 0);
    chain(n, bp, ng, dest);
    adEnv(ng.gain, t, vel * 0.5, 0.001, 0.13 + this.rng() * 0.04);
    n.start(t, this.rng() * 1.5);
    n.stop(t + 0.25);
    for (const f of [185, 258]) {
      const o1 = osc(this.ctx, 'triangle', f);
      const g = gain(this.ctx, 0);
      chain(o1, g, dest);
      adEnv(g.gain, t, vel * 0.22, 0.001, 0.09);
      o1.start(t);
      o1.stop(t + 0.15);
    }
    // Metallic sheen so it cuts through a busy mix.
    const ring = filter(this.ctx, 'bandpass', 4200, 3);
    const rg = gain(this.ctx, 0);
    const rn = noiseSource(this.ctx, { kind: 'white', seed: 4 });
    chain(rn, ring, rg, dest);
    adEnv(rg.gain, t, vel * 0.12, 0.001, 0.06);
    rn.start(t, this.rng() * 1.5);
    rn.stop(t + 0.12);
  }

  private hat(t: number, vel: number): void {
    const dest = this.layers.drums.input;
    const n = noiseSource(this.ctx, { kind: 'white', seed: 6 });
    const hp = filter(this.ctx, 'highpass', 7200, 0.8);
    const bp = filter(this.ctx, 'bandpass', 9800, 1.2);
    const g = gain(this.ctx, 0);
    chain(n, hp, bp, g, dest);
    adEnv(g.gain, t, vel * 0.2, 0.0006, 0.028 + this.rng() * 0.02);
    n.start(t, this.rng() * 1.5);
    n.stop(t + 0.09);
  }

  private metal(t: number, vel: number): void {
    const dest = this.layers.drums.input;
    // Ring-modulated square pair through a narrow band: an anvil, basically.
    const a = osc(this.ctx, 'square', 317);
    const b = osc(this.ctx, 'square', 523);
    const mix = gain(this.ctx, 0.5);
    a.connect(mix);
    b.connect(mix);
    const bp = filter(this.ctx, 'bandpass', 2600 + this.rng() * 900, 2.4);
    const g = gain(this.ctx, 0);
    chain(mix, bp, g, dest);
    adEnv(g.gain, t, vel * 0.16, 0.0008, 0.16);
    a.start(t); b.start(t);
    a.stop(t + 0.25); b.stop(t + 0.25);
  }

  private crash(t: number, vel: number): void {
    const dest = this.layers.drums.input;
    const n = noiseSource(this.ctx, { kind: 'white', seed: 8 });
    const hp = filter(this.ctx, 'highpass', 3200, 0.7);
    const g = gain(this.ctx, 0);
    chain(n, hp, g, this.out);
    adEnv(g.gain, t, vel * 0.28, 0.003, 1.6);
    n.start(t, this.rng() * 1.5);
    n.stop(t + 1.8);
    // Sub drop under the crash.
    const o1 = osc(this.ctx, 'sine', 90);
    const og = gain(this.ctx, 0);
    chain(o1, og, dest);
    sweep(o1.frequency, t, 90, 30, 0.7);
    adEnv(og.gain, t, vel * 0.5, 0.004, 0.75);
    o1.start(t);
    o1.stop(t + 0.85);
  }

  private bass(t: number, freq: number, dur: number, vel: number): void {
    const dest = this.layers.bass.input;
    const o1 = osc(this.ctx, 'sawtooth', freq);
    const o2 = osc(this.ctx, 'square', freq, -6);
    const o2g = gain(this.ctx, 0.35);
    const sub = osc(this.ctx, 'sine', freq * 0.5);
    const subg = gain(this.ctx, 0.5);
    const lp = filter(this.ctx, 'lowpass', 220, 6);
    const g = gain(this.ctx, 0);
    o1.connect(lp);
    chain(o2, o2g, lp);
    chain(sub, subg, g);
    chain(lp, g, dest);
    // Filter envelope: the pluck that makes a synth bass read as percussive.
    sweep(lp.frequency, t, 220 + vel * 1400, 180, dur * 0.8);
    adEnv(g.gain, t, vel * 0.5, 0.004, dur);
    for (const o of [o1, o2, sub]) {
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  private pulse(t: number, freq: number, vel: number): void {
    const dest = this.layers.pulse.input;
    const o1 = osc(this.ctx, 'square', freq);
    const o2 = osc(this.ctx, 'sawtooth', freq, 9);
    const o2g = gain(this.ctx, 0.4);
    const g = gain(this.ctx, 0);
    o1.connect(g);
    chain(o2, o2g, g);
    g.connect(dest);
    adEnv(g.gain, t, vel * 0.12, 0.002, SECONDS_PER_STEP * 0.9);
    o1.start(t); o2.start(t);
    o1.stop(t + SECONDS_PER_STEP * 1.2);
    o2.stop(t + SECONDS_PER_STEP * 1.2);
  }

  private pad(t: number, chord: number[], dur: number): void {
    const dest = this.layers.pad.input;
    // Voice the triad up two octaves and detune each voice for width.
    for (let i = 0; i < chord.length; i++) {
      const midi = chord[i] + 24;
      for (const detune of [-8, 7]) {
        const o1 = osc(this.ctx, 'sawtooth', mtof(midi), detune);
        const g = gain(this.ctx, 0);
        chain(o1, g, dest);
        g.gain.setValueAtTime(1e-4, t);
        g.gain.linearRampToValueAtTime(0.07 / (1 + i * 0.3), t + dur * 0.35);
        g.gain.setValueAtTime(0.07 / (1 + i * 0.3), t + dur * 0.75);
        g.gain.exponentialRampToValueAtTime(1e-4, t + dur * 1.02);
        o1.start(t);
        o1.stop(t + dur * 1.05);
      }
    }
    // Root an octave down keeps the pad anchored.
    const root = osc(this.ctx, 'triangle', mtof(chord[0] + 12));
    const rg = gain(this.ctx, 0);
    chain(root, rg, dest);
    rg.gain.setValueAtTime(1e-4, t);
    rg.gain.linearRampToValueAtTime(0.05, t + dur * 0.3);
    rg.gain.exponentialRampToValueAtTime(1e-4, t + dur * 1.02);
    root.start(t);
    root.stop(t + dur * 1.05);
  }

  private stab(t: number, chord: number[], dur: number): void {
    const dest = this.layers.stab.input;
    for (let i = 0; i < chord.length; i++) {
      const f = mtof(chord[i] + 12);
      const o1 = osc(this.ctx, 'sawtooth', f);
      const o2 = osc(this.ctx, 'sawtooth', f, 11);
      const mix = gain(this.ctx, 0.5);
      o1.connect(mix); o2.connect(mix);
      const bp = filter(this.ctx, 'lowpass', 900, 4);
      const g = gain(this.ctx, 0);
      chain(mix, bp, g, dest);
      // Brass character is mostly this: a fast upward filter sweep on attack.
      sweep(bp.frequency, t, 500, 2600, 0.05);
      sweep(bp.frequency, t + 0.05, 2600, 900, dur * 0.8);
      adEnv(g.gain, t, 0.13 / (1 + i * 0.35), 0.012, dur);
      o1.start(t); o2.start(t);
      o1.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
    }
  }

  private lead(t: number, freq: number, dur: number): void {
    const dest = this.layers.lead.input;
    const o1 = osc(this.ctx, 'sawtooth', freq);
    const o2 = osc(this.ctx, 'square', freq * 2, 6);
    const o2g = gain(this.ctx, 0.22);
    const lp = filter(this.ctx, 'lowpass', 1800, 5);
    const g = gain(this.ctx, 0);
    o1.connect(lp);
    chain(o2, o2g, lp);
    chain(lp, g, dest);
    sweep(lp.frequency, t, clampFreq(this.ctx, freq * 6), clampFreq(this.ctx, freq * 2.2), dur * 0.6);
    // Vibrato arrives late, the way a player would add it.
    const vib = osc(this.ctx, 'sine', 5.4);
    const vibAmt = gain(this.ctx, 0);
    modulate(vib, vibAmt, o1.frequency);
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(freq * 0.012, t + dur * 0.9);
    adEnv(g.gain, t, 0.16, 0.02, dur);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.1); o2.stop(t + dur + 0.1); vib.stop(t + dur + 0.1);
  }

  dispose(): void {
    this.stop();
    this.out.disconnect();
  }
}
