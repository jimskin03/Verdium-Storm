import { makeRng } from '@/util/Noise';
import { Ambience } from './Ambience';
import { EVA_PHRASES, speak } from './Eva';
import { Mixer } from './Mixer';
import { Music, type MusicState } from './Music';
import { SFX, prewarm, type BuiltSound, type SoundDef } from './Sfx';
import { chain, clampFreq, filter, gain } from './Synth';

/** Minimal positional type so this module never has to import three.js. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Ids the simulation is likely to reach for that are not catalogue names. Being
 * forgiving here costs nothing and means a missing alias never turns into
 * silence in the field.
 */
const ALIASES: Record<string, string> = {
  // alert kinds from GameStateService
  insufficientFunds: 'eva.insufficientFunds',
  lowPower: 'eva.lowPower',
  baseUnderAttack: 'eva.baseUnderAttack',
  unitLost: 'eva.unitLost',
  buildingComplete: 'eva.constructionComplete',
  unitReady: 'eva.unitReady',
  newTech: 'eva.newOptions',
  harvesterLost: 'eva.harvesterLost',
  // shorthands
  explosion: 'explosion.small',
  gunshot: 'weapon.rifle',
  rifle: 'weapon.rifle',
  cannon: 'weapon.cannon',
  rocket: 'weapon.rocketLaunch',
  laser: 'weapon.laser',
  click: 'ui.click',
  invalid: 'ui.invalid',
  alert: 'ui.alert',
  footstep: 'infantry.footstep',
  'impact.default': 'impact.dirt',
  'explosion.building': 'destroy.building',
  'weapon.missile': 'weapon.rocketLaunch',
  'weapon.aa': 'weapon.aaBurst',
  'vehicle.death': 'explosion.vehicle',
  'building.collapse': 'destroy.building',
};

export interface AudioCoreOptions {
  /** Simultaneous positional voices before the quietest gets culled. */
  maxVoices: number;
  /** Convolution reverb (off on the low tier). */
  convolution: boolean;
  /** Skip ambience and music timers; used by the offline measurement path. */
  offline?: boolean;
}

interface Voice {
  id: string;
  def: SoundDef;
  built: BuiltSound;
  /** Chain head — disconnecting this detaches the whole voice. */
  head: AudioNode;
  /** Nodes to disconnect on cleanup. */
  nodes: AudioNode[];
  /** Absolute context time the voice becomes inaudible. */
  endTime: number;
  /** Level after distance attenuation; the culling metric. */
  effective: number;
  panner: PannerNode | null;
  distanceFilter: BiquadFilterNode | null;
  sustained: boolean;
  released: boolean;
}

/** Handle for a sustained sound, e.g. a vehicle engine. */
export interface LoopHandle {
  /** Move the source; also refreshes distance attenuation. */
  setPosition(p: Vec3Like): void;
  /** 'speed' or 'load', 0..1. */
  set(param: string, value: number): void;
  stop(fade?: number): void;
  readonly active: boolean;
}

const DEAD_LOOP: LoopHandle = {
  setPosition: () => {},
  set: () => {},
  stop: () => {},
  active: false,
};

/**
 * Everything above the raw Web Audio graph: voice allocation and limiting,
 * distance modelling, the EVA queue, and ownership of the music and ambience
 * engines. It is deliberately constructed against a `BaseAudioContext` so the
 * exact same code renders inside an `OfflineAudioContext` for measurement.
 */
export class AudioCore {
  readonly ctx: BaseAudioContext;
  readonly mixer: Mixer;
  readonly music: Music;
  readonly ambience: Ambience;

  private readonly opts: AudioCoreOptions;
  private readonly voices: Voice[] = [];
  private readonly lastTrigger = new Map<string, number>();
  private readonly rng = makeRng(0x51ed270b);

  private listenerPos: Vec3Like = { x: 0, y: 0, z: 0 };
  private evaFreeAt = 0;
  private evaQueued = 0;

  /** Diagnostics for the check harness. */
  readonly stats = { triggered: 0, culled: 0, rateLimited: 0, unknown: 0, peakVoices: 0 };

  constructor(ctx: BaseAudioContext, opts: AudioCoreOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.mixer = new Mixer(ctx, { convolution: opts.convolution });
    this.music = new Music(ctx, { dest: this.mixer.music, hall: this.mixer.hallSend });
    this.ambience = new Ambience(ctx, this.mixer.ambience);
    prewarm(ctx);
  }

  /** Master output; connect to `ctx.destination` (or an analyser tap). */
  get output(): GainNode {
    return this.mixer.output;
  }

  /* --------------------------------------------------------------- listener */

  setListener(position: Vec3Like, forward: Vec3Like): void {
    this.listenerPos = { x: position.x, y: position.y, z: position.z };
    const l = this.ctx.listener as AudioListener & {
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (x: number, y: number, z: number, ux: number, uy: number, uz: number) => void;
    };
    const t = this.ctx.currentTime;
    // Normalise the forward vector; an unnormalised one silently breaks the
    // panner's orientation maths.
    let fx = forward.x, fy = forward.y, fz = forward.z;
    const len = Math.hypot(fx, fy, fz) || 1;
    fx /= len; fy /= len; fz /= len;
    // Up is derived so the listener stays level even when the camera pitches
    // steeply, which is the normal RTS case.
    let ux = -fx * fy, uy = 1 - fy * fy, uz = -fz * fy;
    const ulen = Math.hypot(ux, uy, uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;

    if (l.positionX) {
      const smooth = 0.02;
      l.positionX.setTargetAtTime(position.x, t, smooth);
      l.positionY.setTargetAtTime(position.y, t, smooth);
      l.positionZ.setTargetAtTime(position.z, t, smooth);
      l.forwardX.setTargetAtTime(fx, t, smooth);
      l.forwardY.setTargetAtTime(fy, t, smooth);
      l.forwardZ.setTargetAtTime(fz, t, smooth);
      l.upX.setTargetAtTime(ux, t, smooth);
      l.upY.setTargetAtTime(uy, t, smooth);
      l.upZ.setTargetAtTime(uz, t, smooth);
    } else {
      l.setPosition?.(position.x, position.y, position.z);
      l.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /* ------------------------------------------------------------ triggering */

  static resolve(id: string): string {
    if (SFX[id] || EVA_PHRASES[id]) return id;
    return ALIASES[id] ?? id;
  }

  play(id: string, position?: Vec3Like, volume = 1, pitch = 1): void {
    const resolved = AudioCore.resolve(id);
    if (EVA_PHRASES[resolved]) {
      this.callout(resolved, volume);
      return;
    }
    const def = SFX[resolved];
    if (!def) {
      this.stats.unknown++;
      return;
    }
    this.spawn(resolved, def, position, volume, pitch, false);
  }

  /**
   * Starts a sustained sound and returns a handle. Falls back to an inert handle
   * when the budget is full, so callers never have to null-check behaviour.
   */
  loop(id: string, position?: Vec3Like, volume = 1, pitch = 1): LoopHandle {
    const resolved = AudioCore.resolve(id);
    const def = SFX[resolved];
    if (!def) {
      this.stats.unknown++;
      return DEAD_LOOP;
    }
    const voice = this.spawn(resolved, def, position, volume, pitch, true);
    if (!voice) return DEAD_LOOP;
    const core = this;
    return {
      get active(): boolean {
        return !voice.released;
      },
      setPosition(p: Vec3Like): void {
        core.reposition(voice, p);
      },
      set(param: string, value: number): void {
        voice.built.set?.(param, value, core.ctx.currentTime);
      },
      stop(fade = 0.12): void {
        core.release(voice, core.ctx.currentTime, Math.max(0.02, fade));
      },
    };
  }

  private spawn(
    id: string,
    def: SoundDef,
    position: Vec3Like | undefined,
    volume: number,
    pitch: number,
    sustain: boolean,
  ): Voice | null {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // --- rate limit: one event can never spawn an unbounded number of nodes.
    const last = this.lastTrigger.get(id) ?? -1e9;
    if (!sustain && now - last < def.minInterval) {
      this.stats.rateLimited++;
      return null;
    }

    // --- distance model
    const spatial = def.spatial && !!position;
    const distance = spatial && position ? this.distanceTo(position) : 0;
    const reach = def.reach;
    const attenuation = spatial ? Math.min(1, (40 * reach) / (40 * reach + distance)) : 1;
    const effective = Math.max(0, volume) * def.gain * attenuation;

    // Anything this quiet is below the noise floor of a busy battle.
    if (effective < 0.0015) return null;

    if (!this.makeRoom(id, def, effective)) {
      this.stats.culled++;
      return null;
    }

    // --- per-voice chain: [predelay] → tone → panner → level → bus (+ send)
    const nodes: AudioNode[] = [];
    const level = gain(ctx, 1);
    nodes.push(level);
    let head: AudioNode = level;
    let panner: PannerNode | null = null;
    let distanceFilter: BiquadFilterNode | null = null;

    if (spatial && position) {
      distanceFilter = filter(ctx, 'lowpass', 20000, 0.6);
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 40 * reach;
      panner.maxDistance = 4000;
      panner.rolloffFactor = 1;
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
      nodes.push(distanceFilter, panner);
      chain(distanceFilter, panner, level);
      head = distanceFilter;
      // Far sources arrive late and dull; near ones stay sharp and immediate.
      if (distance > 30) {
        const delay = ctx.createDelay(0.4);
        delay.delayTime.value = Math.min(0.3, distance / 700);
        delay.connect(distanceFilter);
        nodes.push(delay);
        head = delay;
      }
      this.applyDistanceTone(distanceFilter, distance, reach);
    }

    const bus = def.bus === 'ui' ? this.mixer.ui : def.bus === 'voice' ? this.mixer.voice : this.mixer.sfx;
    level.connect(bus);
    if (def.space > 0) {
      const send = gain(ctx, def.space);
      level.connect(send);
      send.connect(this.mixer.spaceSend);
      nodes.push(send);
    }

    // --- build
    const built = def.build({
      ctx,
      dest: head,
      t: now + 0.005,
      rng: this.rng,
      pitch: Math.max(0.25, Math.min(4, pitch)),
      gain: Math.max(0, volume) * def.gain,
      sustain,
    });

    const voice: Voice = {
      id, def, built, head, nodes,
      endTime: sustain ? Number.POSITIVE_INFINITY : now + built.duration + 0.15,
      effective, panner, distanceFilter, sustained: sustain, released: false,
    };
    this.voices.push(voice);
    this.lastTrigger.set(id, now);
    this.stats.triggered++;
    this.stats.peakVoices = Math.max(this.stats.peakVoices, this.voices.length);

    // The heaviest blasts briefly own the mix.
    if (def.priority >= 9 && effective > 0.35) this.mixer.duck(0.28, 0.5);
    return voice;
  }

  /** Cutoff opens up as the source gets closer; air absorbs the top end. */
  private applyDistanceTone(f: BiquadFilterNode, distance: number, reach: number): void {
    const halfDistance = 130 * reach;
    const cutoff = 20000 * Math.pow(0.5, distance / halfDistance);
    f.frequency.value = clampFreq(this.ctx, Math.max(320, cutoff));
  }

  private distanceTo(p: Vec3Like): number {
    const l = this.listenerPos;
    return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
  }

  private reposition(voice: Voice, p: Vec3Like): void {
    if (!voice.panner) return;
    const t = this.ctx.currentTime;
    voice.panner.positionX.setTargetAtTime(p.x, t, 0.05);
    voice.panner.positionY.setTargetAtTime(p.y, t, 0.05);
    voice.panner.positionZ.setTargetAtTime(p.z, t, 0.05);
    const d = this.distanceTo(p);
    if (voice.distanceFilter) {
      const halfDistance = 130 * voice.def.reach;
      const cutoff = clampFreq(this.ctx, Math.max(320, 20000 * Math.pow(0.5, d / halfDistance)));
      voice.distanceFilter.frequency.setTargetAtTime(cutoff, t, 0.1);
    }
    voice.effective = Math.min(1, (40 * voice.def.reach) / (40 * voice.def.reach + d)) * voice.def.gain;
  }

  /**
   * Voice budget. Per-id caps stop one weapon from owning the mix; the global
   * cap protects the audio thread. In both cases the quietest instance loses.
   */
  private makeRoom(id: string, def: SoundDef, effective: number): boolean {
    let sameId = 0;
    let weakestSame: Voice | null = null;
    for (const v of this.voices) {
      if (v.id !== id || v.released) continue;
      sameId++;
      if (!weakestSame || v.effective < weakestSame.effective) weakestSame = v;
    }
    if (sameId >= def.maxInstances) {
      if (!weakestSame || weakestSame.effective > effective) return false;
      this.release(weakestSame, this.ctx.currentTime, 0.04);
    }

    const active = this.voices.filter((v) => !v.released).length;
    if (active < this.opts.maxVoices) return true;

    // Rank by priority first, then by how loud it actually is at the listener.
    let weakest: Voice | null = null;
    for (const v of this.voices) {
      if (v.released || v.sustained) continue;
      if (!weakest || this.score(v) < this.score(weakest)) weakest = v;
    }
    const incoming = def.priority * 4 + effective;
    if (!weakest || this.score(weakest) >= incoming) return false;
    this.release(weakest, this.ctx.currentTime, 0.04);
    return true;
  }

  private score(v: Voice): number {
    return v.def.priority * 4 + v.effective;
  }

  private release(voice: Voice, at: number, fade = 0.08): void {
    if (voice.released) return;
    voice.released = true;
    const g = voice.nodes[0] as GainNode;
    const t = Math.max(at, this.ctx.currentTime);
    const tail = voice.built.stop(t);
    if (g && g.gain) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(g.gain.value, 1e-4), t);
      g.gain.exponentialRampToValueAtTime(1e-4, t + Math.max(fade, tail));
    }
    voice.endTime = t + Math.max(fade, tail) + 0.05;
  }

  /* ------------------------------------------------------------------- EVA */

  /** Queues a callout. Only one speaks at a time and the queue is capped. */
  callout(id: string, volume = 1): void {
    const phrase = EVA_PHRASES[id];
    if (!phrase) {
      this.stats.unknown++;
      return;
    }
    const now = this.ctx.currentTime;
    if (this.evaFreeAt < now) {
      this.evaFreeAt = now;
      this.evaQueued = 0;
    }
    if (this.evaQueued >= 2) return;
    const start = Math.max(now + 0.02, this.evaFreeAt + 0.12);

    // Urgent callouts get the alert stinger in front of them.
    if (phrase.urgent) {
      this.playAt('ui.alert', start, volume * 0.9);
    }
    const voiceStart = phrase.urgent ? start + 0.42 : start;
    const dur = speak(id, {
      ctx: this.ctx,
      dest: this.mixer.voice,
      t: voiceStart,
      gain: 0.5 * Math.max(0, Math.min(1.5, volume)),
      rng: this.rng,
    });
    this.evaFreeAt = voiceStart + dur;
    this.evaQueued++;
    this.stats.triggered++;
    // Duck the rest of the mix so the callout is always intelligible.
    this.mixer.duck(0.42, voiceStart - this.ctx.currentTime + dur, 0.22);
  }

  /** Schedules a non-positional sound at an absolute context time. */
  private playAt(id: string, when: number, volume: number): void {
    const def = SFX[id];
    if (!def) return;
    const level = gain(this.ctx, 1);
    level.connect(def.bus === 'ui' ? this.mixer.ui : this.mixer.sfx);
    const built = def.build({
      ctx: this.ctx, dest: level, t: when, rng: this.rng,
      pitch: 1, gain: volume * def.gain, sustain: false,
    });
    this.voices.push({
      id, def, built, head: level, nodes: [level],
      endTime: when + built.duration + 0.15, effective: volume * def.gain,
      panner: null, distanceFilter: null, sustained: false, released: false,
    });
  }

  /* ----------------------------------------------------------------- music */

  setMusicState(state: MusicState): void {
    this.music.setState(state);
    this.ambience.setState(state);
  }

  startBeds(): void {
    this.music.start();
    this.ambience.start();
  }

  /* ---------------------------------------------------------------- update */

  /** Per-frame housekeeping: retire finished voices, advance sparse schedulers. */
  update(): void {
    const now = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.endTime > now) continue;
      for (const n of v.nodes) n.disconnect();
      this.voices.splice(i, 1);
    }
    this.ambience.scheduleAhead(now + 1.5);
    if (this.evaFreeAt < now) this.evaQueued = 0;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  dispose(): void {
    for (const v of this.voices) {
      this.release(v, this.ctx.currentTime, 0.05);
      for (const n of v.nodes) n.disconnect();
    }
    this.voices.length = 0;
    this.music.dispose();
    this.ambience.dispose();
    this.mixer.dispose();
  }
}
