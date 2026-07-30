import {
  adEnv, chain, clampFreq, filter, gain, modulate, noiseSource, osc, sweep,
} from './Synth';
import type { MusicState } from './Music';

/**
 * The ambient bed.
 *
 * Four things happen at once: a continuous wind layer whose cutoff and level are
 * driven by three incommensurate LFOs (so it never repeats audibly), a sub-bass
 * rumble, sparse wildlife during quiet stretches, and unseen artillery on the
 * horizon once the map heats up. The sparse layers are scheduled by the same
 * lookahead clock the music uses, not by timers.
 */
export class Ambience {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;

  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly gustGain: GainNode;
  private readonly rumbleGain: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];

  private started = false;
  private nextWildlife = 0;
  private nextBattle = 0;
  private nextGust = 0;
  private scheduledTo = 0;
  private state: MusicState = 'calm';
  private rngState = 0x2545f491;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = gain(ctx, 1);
    this.out.connect(dest);

    // ---- wind -------------------------------------------------------------
    this.windGain = gain(ctx, 0);
    this.windFilter = filter(ctx, 'lowpass', 480, 1.4);
    const windSrc = noiseSource(ctx, { kind: 'pink', seed: 71, rate: 0.55 });
    const windHp = filter(ctx, 'highpass', 90, 0.6);
    chain(windSrc, this.windFilter, windHp, this.windGain, this.out);
    this.sources.push(windSrc);

    // Three slow LFOs at unrelated rates: the sum has no audible period.
    for (const [rate, depth] of [[0.037, 240], [0.083, 130], [0.017, 320]] as const) {
      const lfo = osc(ctx, 'sine', rate);
      const amt = gain(ctx, depth);
      modulate(lfo, amt, this.windFilter.frequency);
      this.sources.push(lfo);
    }
    for (const [rate, depth] of [[0.029, 0.05], [0.061, 0.03]] as const) {
      const lfo = osc(ctx, 'sine', rate);
      const amt = gain(ctx, depth);
      modulate(lfo, amt, this.windGain.gain);
      this.sources.push(lfo);
    }

    // ---- gust channel (scheduled swells ride on top of the bed) -----------
    this.gustGain = gain(ctx, 0);
    const gustSrc = noiseSource(ctx, { kind: 'white', seed: 73, rate: 0.7 });
    const gustBp = filter(ctx, 'bandpass', 900, 0.7);
    chain(gustSrc, gustBp, this.gustGain, this.out);
    this.sources.push(gustSrc);

    // ---- low rumble --------------------------------------------------------
    this.rumbleGain = gain(ctx, 0);
    const rumbleSrc = noiseSource(ctx, { kind: 'brown', seed: 79, rate: 0.4 });
    const rumbleLp = filter(ctx, 'lowpass', 65, 1.2);
    chain(rumbleSrc, rumbleLp, this.rumbleGain, this.out);
    this.sources.push(rumbleSrc);
  }

  private rng(): number {
    let x = this.rngState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.rngState = x;
    return x / 4294967296;
  }

  start(at = this.ctx.currentTime + 0.05): void {
    if (this.started) return;
    this.started = true;
    for (const s of this.sources) s.start(at);
    this.windGain.gain.setValueAtTime(1e-4, at);
    this.windGain.gain.linearRampToValueAtTime(0.16, at + 3);
    this.rumbleGain.gain.setValueAtTime(1e-4, at);
    this.rumbleGain.gain.linearRampToValueAtTime(0.18, at + 4);
    this.nextWildlife = at + 2;
    this.nextBattle = at + 6;
    this.nextGust = at + 5;
    this.scheduledTo = at;
  }

  /** Ambience follows the same intensity signal the score does. */
  setState(state: MusicState): void {
    if (state === this.state) return;
    this.state = state;
    const t = this.ctx.currentTime;
    const combat = state === 'combat' || state === 'tension';
    this.windGain.gain.setTargetAtTime(combat ? 0.2 : 0.16, t, 4);
    this.rumbleGain.gain.setTargetAtTime(combat ? 0.26 : 0.16, t, 5);
  }

  /** Schedules the sparse layers out to `until`. */
  scheduleAhead(until: number): void {
    if (!this.started) return;
    let guard = 0;
    while (this.scheduledTo < until && guard++ < 512) {
      const t = Math.max(this.scheduledTo, this.nextGust);
      if (this.nextGust < until) {
        this.gust(this.nextGust);
        this.nextGust += 9 + this.rng() * 22;
      }
      if (this.nextWildlife < until) {
        if (this.state === 'calm' || this.state === 'menu') this.wildlife(this.nextWildlife);
        this.nextWildlife += 1.6 + this.rng() * 5.5;
      }
      if (this.nextBattle < until) {
        if (this.state === 'tension' || this.state === 'combat') this.distantArtillery(this.nextBattle);
        this.nextBattle += this.state === 'combat' ? 2.5 + this.rng() * 5 : 6 + this.rng() * 12;
      }
      this.scheduledTo = Math.min(this.nextGust, this.nextWildlife, this.nextBattle);
      if (this.scheduledTo <= t) this.scheduledTo = t + 0.25;
    }
  }

  /** Offline helper for measurement: lays down `seconds` in one pass. */
  renderOffline(seconds: number): void {
    this.start(0.02);
    this.scheduleAhead(seconds);
  }

  /** A single wind swell, panned across the field. */
  private gust(t: number): void {
    const dur = 3.5 + this.rng() * 5;
    const peak = 0.05 + this.rng() * 0.07;
    const g = this.gustGain.gain;
    g.setValueAtTime(Math.max(g.value, 1e-4), t);
    g.linearRampToValueAtTime(peak, t + dur * 0.45);
    g.linearRampToValueAtTime(1e-4, t + dur);
  }

  /** Insect or bird call: a short FM chirp, deliberately thin and distant. */
  private wildlife(t: number): void {
    const ctx = this.ctx;
    const insect = this.rng() < 0.55;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng() * 1.8 - 0.9;
    const out = gain(ctx, 0);
    const hp = filter(ctx, 'highpass', 1200, 0.7);
    chain(out, hp, pan, this.out);

    if (insect) {
      // Cricket: a fast trill of narrow bursts.
      const base = 3800 + this.rng() * 2200;
      const reps = 3 + Math.floor(this.rng() * 4);
      for (let i = 0; i < reps; i++) {
        const at = t + i * 0.055;
        const o1 = osc(ctx, 'sine', base);
        const bp = filter(ctx, 'bandpass', base, 12);
        const g = gain(ctx, 0);
        chain(o1, bp, g, out);
        adEnv(g.gain, at, 0.05, 0.004, 0.03);
        o1.start(at);
        o1.stop(at + 0.06);
      }
      out.gain.setValueAtTime(1, t);
    } else {
      // Bird: two or three glided notes.
      const notes = 2 + Math.floor(this.rng() * 2);
      for (let i = 0; i < notes; i++) {
        const at = t + i * (0.11 + this.rng() * 0.09);
        const f0 = 2200 + this.rng() * 1800;
        const o1 = osc(ctx, 'sine', f0);
        const g = gain(ctx, 0);
        chain(o1, g, out);
        sweep(o1.frequency, at, f0, f0 * (0.7 + this.rng() * 0.7), 0.09);
        adEnv(g.gain, at, 0.06, 0.008, 0.09);
        o1.start(at);
        o1.stop(at + 0.14);
      }
      out.gain.setValueAtTime(1, t);
    }
  }

  /**
   * Artillery over the ridge line: no transient at all, just the low half of a
   * blast arriving late and smeared, with a slap-back off the terrain.
   */
  private distantArtillery(t: number): void {
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng() * 1.6 - 0.8;
    const lp = filter(ctx, 'lowpass', 220 + this.rng() * 180, 0.9);
    const out = gain(ctx, 1);
    chain(out, lp, pan, this.out);

    const level = 0.16 + this.rng() * 0.22;
    const o1 = osc(ctx, 'sine', 62);
    const og = gain(ctx, 0);
    chain(o1, og, out);
    sweep(o1.frequency, t, 62, 24, 0.5);
    adEnv(og.gain, t, level, 0.02, 0.7);
    o1.start(t);
    o1.stop(t + 0.85);

    const n = noiseSource(ctx, { kind: 'brown', seed: 87 });
    const nf = filter(ctx, 'lowpass', clampFreq(ctx, 400), 0.7);
    const ng = gain(ctx, 0);
    chain(n, nf, ng, out);
    sweep(nf.frequency, t, 400, 120, 1.4);
    adEnv(ng.gain, t, level * 0.8, 0.05, 1.5);
    n.start(t, this.rng() * 1.5);
    n.stop(t + 1.7);

    // Late reflection off the far side of the valley.
    const echo = t + 0.35 + this.rng() * 0.4;
    const n2 = noiseSource(ctx, { kind: 'brown', seed: 89 });
    const n2f = filter(ctx, 'lowpass', 160, 0.7);
    const n2g = gain(ctx, 0);
    chain(n2, n2f, n2g, out);
    adEnv(n2g.gain, echo, level * 0.35, 0.12, 1.1);
    n2.start(echo, this.rng() * 1.5);
    n2.stop(echo + 1.3);
  }

  stop(): void {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.5);
  }

  dispose(): void {
    this.stop();
    for (const s of this.sources) {
      try { s.stop(this.ctx.currentTime + 1); } catch { /* not started */ }
    }
  }
}
