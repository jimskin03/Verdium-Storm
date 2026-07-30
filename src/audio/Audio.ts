import type * as THREE from 'three';
import type { AudioService } from '@/engine/Services';
import { provide } from '@/engine/Services';
import type { EngineContext, QualityTier, System } from '@/engine/System';
import { AudioCore, type LoopHandle, type Vec3Like } from './AudioCore';
import { EVA_IDS } from './Eva';
import type { MusicState } from './Music';
import { SFX_IDS } from './Sfx';

/**
 * Audio system entry point.
 *
 * Owns the single live `AudioContext`, forwards the {@link AudioService}
 * contract to {@link AudioCore}, and deals with the browser autoplay policy:
 * nothing is constructed until the page has had a real user gesture, so the
 * console never fills with "AudioContext was not allowed to start". Everything
 * before that point is silently discarded — `ready` tells the truth about it.
 *
 * If the environment has no Web Audio at all (some headless configurations, or
 * a locked-down embed) every entry point degrades to a no-op without throwing
 * and without logging.
 */

/** Voice budget and reverb quality per tier. */
const TIER_BUDGET: Record<QualityTier, { maxVoices: number; convolution: boolean }> = {
  low: { maxVoices: 16, convolution: false },
  medium: { maxVoices: 28, convolution: true },
  high: { maxVoices: 40, convolution: true },
  ultra: { maxVoices: 56, convolution: true },
};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

export class Audio implements System, AudioService {
  readonly name = 'audio';
  readonly phase = 600;

  private core: AudioCore | null = null;
  private ctx: AudioContext | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private tier: QualityTier = 'high';
  private unavailable = false;
  private booting = false;

  /** Remembered so the score starts in the right state once audio unlocks. */
  private pendingMusic: MusicState = 'calm';
  /** Seconds since setListener was last called by another system. */
  private sinceExternalListener = 999;

  private readonly gestureEvents = ['pointerdown', 'mousedown', 'touchstart', 'keydown'] as const;
  private readonly onGesture = (): void => {
    void this.boot();
  };

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.tier = ctx.quality.tier;

    if (!this.contextCtor()) {
      this.unavailable = true;
    } else {
      for (const type of this.gestureEvents) {
        window.addEventListener(type, this.onGesture, { passive: true, once: false });
      }
      // The harness (and any embedder that has already relaxed the policy) can
      // start immediately; `userActivation` tells us whether that is allowed
      // without constructing a context and tripping a console warning.
      const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (activation?.hasBeenActive) void this.boot();
    }

    this.exposeHarness();
    provide('audio', this);
  }

  private contextCtor(): AudioContextCtor | null {
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  }

  /**
   * Creates the context on demand and starts the beds. Safe to call from any
   * gesture handler, any number of times.
   */
  async boot(): Promise<boolean> {
    if (this.unavailable || this.booting) return this.ready;
    if (this.core && this.ctx) {
      if (this.ctx.state !== 'running') {
        this.booting = true;
        try { await this.ctx.resume(); } catch { /* still locked */ }
        this.booting = false;
      }
      return this.ready;
    }
    const Ctor = this.contextCtor();
    if (!Ctor) {
      this.unavailable = true;
      return false;
    }
    this.booting = true;
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const budget = TIER_BUDGET[this.tier] ?? TIER_BUDGET.high;
      const core = new AudioCore(ctx, budget);
      core.output.connect(ctx.destination);
      this.ctx = ctx;
      this.core = core;
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch { /* still locked; a later gesture retries */ }
      }
      core.setMusicState(this.pendingMusic);
      core.startBeds();
      this.detachGestures();
    } catch {
      // No usable audio device. Degrade silently — this is a normal state in
      // headless CI and must never surface as an error.
      this.unavailable = true;
      this.core = null;
      this.ctx = null;
    }
    this.booting = false;
    return this.ready;
  }

  private detachGestures(): void {
    for (const type of this.gestureEvents) window.removeEventListener(type, this.onGesture);
  }

  /* ------------------------------------------------------------ AudioService */

  get ready(): boolean {
    return this.core !== null && this.ctx !== null && this.ctx.state === 'running';
  }

  play(id: string, position?: THREE.Vector3, volume = 1, pitch = 1): void {
    if (!this.ready || !this.core) return;
    this.core.play(id, position as Vec3Like | undefined, volume, pitch);
  }

  music(state: MusicState): void {
    this.pendingMusic = state;
    this.core?.setMusicState(state);
  }

  setListener(position: THREE.Vector3, forward: THREE.Vector3): void {
    this.sinceExternalListener = 0;
    if (!this.core) return;
    this.core.setListener(position, forward);
  }

  /**
   * Sustained sources (engines, treads, refineries). Not part of
   * {@link AudioService} — the simulation gets it by asking the concrete system
   * for it — but documented in docs/AUDIO.md alongside the catalogue.
   */
  loop(id: string, position?: Vec3Like, volume = 1, pitch = 1): LoopHandle | null {
    if (!this.ready || !this.core) return null;
    return this.core.loop(id, position, volume, pitch);
  }

  /** 0..1 per bus, for a settings panel. */
  setVolume(bus: 'sfx' | 'music' | 'ui' | 'ambience' | 'voice', value: number): void {
    this.core?.mixer.setVolume(bus, value);
  }

  /* ------------------------------------------------------------------ System */

  update(dt: number): void {
    if (!this.core) return;
    this.core.update();
    this.sinceExternalListener += dt;
    // Nobody has claimed the listener, so follow the camera. The ear sits part
    // way down the view ray rather than at the camera, which is what keeps an
    // RTS mix from sounding like it is happening a hundred metres below you.
    if (this.sinceExternalListener > 0.5 && this.camera) {
      const cam = this.camera;
      const f = FORWARD;
      cam.getWorldDirection(f);
      const groundT = f.y < -0.05 ? -cam.position.y / f.y : 0;
      const along = Math.min(groundT * 0.65, 200);
      EAR.x = cam.position.x + f.x * along;
      EAR.y = cam.position.y + f.y * along;
      EAR.z = cam.position.z + f.z * along;
      this.core.setListener(EAR, f);
    }
  }

  dispose(): void {
    this.detachGestures();
    this.core?.dispose();
    this.core = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  /* ---------------------------------------------------------------- harness */

  /**
   * Measurement surface for tools/audio-check.mjs. The screenshot harness cannot
   * hear anything, so every sound is verified by rendering it through the real
   * mix chain in an OfflineAudioContext and measuring the result.
   */
  private exposeHarness(): void {
    const self = this;
    const harness = {
      version: 1,
      sfxIds: SFX_IDS,
      evaIds: EVA_IDS,
      ids: [...SFX_IDS, ...EVA_IDS],
      get ready(): boolean {
        return self.ready;
      },
      get state(): string {
        return self.ctx?.state ?? (self.unavailable ? 'unavailable' : 'uninitialised');
      },
      boot: () => self.boot(),
      play: (id: string, x?: number, y?: number, z?: number, volume = 1, pitch = 1) => {
        const pos = x === undefined ? undefined : ({ x, y: y ?? 0, z: z ?? 0 } as Vec3Like);
        self.core?.play(id, pos, volume, pitch);
      },
      music: (state: MusicState) => self.music(state),
      stats: () => ({ ...(self.core?.stats ?? {}), voices: self.core?.voiceCount ?? 0 }),

      /** Taps the master output so live playback can be measured. */
      analyser: (): AnalyserNode | null => {
        if (!self.core || !self.ctx) return null;
        const node = self.ctx.createAnalyser();
        node.fftSize = 2048;
        node.smoothingTimeConstant = 0;
        self.core.output.connect(node);
        return node;
      },

      /** Renders one id through the full mix chain and returns the buffer. */
      render: (id: string, seconds = 3, distance = 0): Promise<AudioBuffer> =>
        renderOffline(seconds, (core) => {
          core.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
          const pos = distance > 0 ? { x: 0, y: 0, z: -distance } : undefined;
          core.play(id, pos, 1, 1);
        }),

      /** Renders a sustained id via the loop path, held for most of the window. */
      renderLoop: (id: string, seconds = 3): Promise<AudioBuffer> =>
        renderOffline(seconds, (core) => {
          const handle = core.loop(id, undefined, 1, 1);
          handle.stop(0.2);
        }),

      renderMusic: (state: MusicState, seconds = 8): Promise<AudioBuffer> =>
        renderOffline(seconds, (core) => {
          core.music.setState(state);
          core.music.renderOffline(seconds);
        }),

      renderAmbience: (state: MusicState, seconds = 8): Promise<AudioBuffer> =>
        renderOffline(seconds, (core) => {
          core.ambience.setState(state);
          core.ambience.renderOffline(seconds);
        }),

      /** Fires `count` copies of an id to exercise voice limiting and the bus compressor. */
      renderStorm: (id: string, count = 40, seconds = 4): Promise<AudioBuffer> =>
        renderOffline(seconds, (core) => {
          core.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
          for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2;
            core.play(id, { x: Math.cos(a) * 30, y: 0, z: Math.sin(a) * 30 }, 1, 1);
          }
          return count;
        }),
    };

    (window as unknown as Record<string, unknown>).VSAudio = harness;
  }
}

/**
 * Builds a throwaway AudioCore inside an OfflineAudioContext, lets the caller
 * trigger whatever it wants, and renders. This is the measurement path: it
 * exercises the real catalogue, the real per-voice chain and the real master
 * limiter, so the numbers it produces describe what a player would hear.
 */
async function renderOffline(
  seconds: number,
  trigger: (core: AudioCore) => void,
): Promise<AudioBuffer> {
  const sampleRate = 48000;
  const oc = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const core = new AudioCore(oc, { maxVoices: 64, convolution: true, offline: true });
  core.output.connect(oc.destination);
  trigger(core);
  return oc.startRendering();
}

/** Scratch vectors for the camera-follow listener; avoids per-frame allocation. */
const EAR = { x: 0, y: 0, z: 0 };
const FORWARD = { x: 0, y: 0, z: -1, isVector3: true } as unknown as THREE.Vector3;

export default Audio;
