import { chain, filter, gain, reverbImpulse, softClipCurve } from './Synth';

/**
 * The mix bus graph.
 *
 *   sfx ──▶ sfx compressor ──▶ sfx duck ─┐
 *   ui ───────────────────────────────────┤
 *   music ──▶ music duck ─────────────────┤──▶ master ──▶ limiter ──▶ soft clip ──▶ out
 *   ambience ─────────────────────────────┤
 *   voice (EVA) ──────────────────────────┘
 *        │                    │
 *        └──▶ space send ──▶ reverb ──▶ return ──┘
 *
 * The SFX bus has its own compressor so a hundred simultaneous explosions bring
 * the whole layer down together rather than each one clipping the master. EVA
 * and large blasts duck music and SFX so callouts stay intelligible.
 */

export type BusName = 'sfx' | 'music' | 'ui' | 'ambience' | 'voice';

export interface MixerOptions {
  /** Convolution reverb costs real CPU; the low tier gets a delay network. */
  convolution: boolean;
  /** Master trim in linear gain. */
  master?: number;
}

export class Mixer {
  readonly ctx: BaseAudioContext;

  /** Bus inputs — connect sources here. */
  readonly sfx: GainNode;
  readonly music: GainNode;
  readonly ui: GainNode;
  readonly ambience: GainNode;
  readonly voice: GainNode;

  /** Reverb sends. Attach a per-voice send gain to these. */
  readonly spaceSend: GainNode;
  readonly hallSend: GainNode;

  readonly output: GainNode;

  private readonly masterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly sfxComp: DynamicsCompressorNode;
  private readonly musicDuck: GainNode;
  private readonly sfxDuck: GainNode;
  private readonly busGains: Record<BusName, GainNode>;
  private readonly volumes: Record<BusName, number> = {
    sfx: 1, music: 0.62, ui: 0.85, ambience: 0.55, voice: 0.95,
  };
  private duckUntil = 0;

  constructor(ctx: BaseAudioContext, opts: MixerOptions) {
    this.ctx = ctx;

    this.output = gain(ctx, 1);

    // ---- master chain -----------------------------------------------------
    this.masterGain = gain(ctx, opts.master ?? 0.9);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.22;

    // Final safety net: nothing downstream of this can exceed 0.96 full scale.
    const clipDrive = gain(ctx, 0.5);
    const clipper = ctx.createWaveShaper();
    clipper.curve = softClipCurve();
    clipper.oversample = '2x';

    chain(this.masterGain, this.limiter, clipDrive, clipper, this.output);

    // ---- buses ------------------------------------------------------------
    this.sfx = gain(ctx, 1);
    this.music = gain(ctx, 1);
    this.ui = gain(ctx, 1);
    this.ambience = gain(ctx, 1);
    this.voice = gain(ctx, 1);

    this.sfxComp = ctx.createDynamicsCompressor();
    this.sfxComp.threshold.value = -18;
    this.sfxComp.knee.value = 10;
    this.sfxComp.ratio.value = 6;
    this.sfxComp.attack.value = 0.004;
    this.sfxComp.release.value = 0.18;

    this.sfxDuck = gain(ctx, 1);
    this.musicDuck = gain(ctx, 1);

    this.busGains = {
      sfx: gain(ctx, this.volumes.sfx),
      music: gain(ctx, this.volumes.music),
      ui: gain(ctx, this.volumes.ui),
      ambience: gain(ctx, this.volumes.ambience),
      voice: gain(ctx, this.volumes.voice),
    };

    chain(this.sfx, this.sfxComp, this.busGains.sfx, this.sfxDuck, this.masterGain);
    chain(this.music, this.busGains.music, this.musicDuck, this.masterGain);
    chain(this.ui, this.busGains.ui, this.masterGain);
    chain(this.ambience, this.busGains.ambience, this.masterGain);
    chain(this.voice, this.busGains.voice, this.masterGain);

    // ---- reverb sends -----------------------------------------------------
    this.spaceSend = gain(ctx, 1);
    this.hallSend = gain(ctx, 1);

    const spaceReturn = gain(ctx, 0.9);
    const hallReturn = gain(ctx, 0.75);
    spaceReturn.connect(this.masterGain);
    hallReturn.connect(this.masterGain);

    if (opts.convolution) {
      // Outdoor battlefield: short, dark, mostly early energy.
      const space = ctx.createConvolver();
      space.buffer = reverbImpulse(ctx, 1.9, 3.2, 0.30, 11);
      const spacePre = ctx.createDelay(0.2);
      spacePre.delayTime.value = 0.018;
      const spaceTone = filter(ctx, 'lowpass', 2600, 0.7);
      chain(this.spaceSend, spacePre, space, spaceTone, spaceReturn);

      // Music hall: longer and brighter, sits behind the score.
      const hall = ctx.createConvolver();
      hall.buffer = reverbImpulse(ctx, 3.4, 2.1, 0.55, 23);
      const hallPre = ctx.createDelay(0.2);
      hallPre.delayTime.value = 0.035;
      chain(this.hallSend, hallPre, hall, hallReturn);
    } else {
      this.buildCheapReverb(this.spaceSend, spaceReturn, [0.0297, 0.0371, 0.0411, 0.0437], 0.72, 2200);
      this.buildCheapReverb(this.hallSend, hallReturn, [0.0531, 0.0672, 0.0781, 0.0893], 0.81, 3200);
    }
  }

  /**
   * Feedback delay network standing in for convolution on the low tier: four
   * mutually prime delay lines with a damping lowpass in each loop.
   */
  private buildCheapReverb(
    send: GainNode,
    ret: GainNode,
    times: number[],
    feedback: number,
    damp: number,
  ): void {
    const ctx = this.ctx;
    const spread = ctx.createGain();
    spread.gain.value = 0.32;
    send.connect(spread);
    for (let i = 0; i < times.length; i++) {
      const d = ctx.createDelay(0.5);
      d.delayTime.value = times[i];
      const fb = gain(ctx, feedback);
      const lp = filter(ctx, 'lowpass', damp, 0.6);
      spread.connect(d);
      chain(d, lp, fb);
      fb.connect(d);
      const pan = ctx.createStereoPanner();
      pan.pan.value = i % 2 === 0 ? -0.6 : 0.6;
      chain(lp, pan, ret);
    }
  }

  /** 0..1 per bus. Applied immediately with a short ramp to avoid zipper noise. */
  setVolume(bus: BusName, value: number): void {
    const v = Math.max(0, Math.min(1.5, value));
    this.volumes[bus] = v;
    const t = this.ctx.currentTime;
    const p = this.busGains[bus].gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(v, t, 0.02);
  }

  getVolume(bus: BusName): number {
    return this.volumes[bus];
  }

  /**
   * Ducks music (and optionally SFX) for `hold` seconds. Used by EVA callouts and
   * by very large explosions, which briefly own the mix.
   */
  duck(amount: number, hold: number, duckSfx = 0): void {
    const t = this.ctx.currentTime;
    const end = t + hold;
    if (end < this.duckUntil) return;
    this.duckUntil = end;
    const apply = (node: GainNode, depth: number): void => {
      if (depth <= 0) return;
      const p = node.gain;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(1 - depth, t, 0.05);
      p.setValueAtTime(1 - depth, end);
      p.setTargetAtTime(1, end, 0.22);
    };
    apply(this.musicDuck, Math.max(0, Math.min(0.9, amount)));
    apply(this.sfxDuck, Math.max(0, Math.min(0.9, duckSfx)));
  }

  /** Master trim, e.g. for a global mute or a settings slider. */
  setMaster(value: number): void {
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1.2, value)), t, 0.03);
  }

  /** Current limiter gain reduction in dB (negative). Diagnostics only. */
  get reduction(): number {
    return this.limiter.reduction;
  }

  dispose(): void {
    this.output.disconnect();
    this.masterGain.disconnect();
  }
}
