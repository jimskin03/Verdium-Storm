import * as THREE from 'three';
import { Engine } from '@/engine/Engine';
import { createQuality } from '@/engine/Quality';
import { Atmosphere } from '@/engine/Atmosphere';
import { Terrain } from '@/world/Terrain';
import { CameraRig } from '@/game/CameraRig';
import { SHOT_PRESETS, type ShotPresetName } from '@/game/ShotPresets';

const viewport = document.getElementById('viewport')!;
const uiRoot = document.getElementById('ui-root')!;
const boot = document.getElementById('boot')!;
const bootBar = document.getElementById('boot-bar')!;
const bootStatus = document.getElementById('boot-status')!;

async function main(): Promise<void> {
  const quality = createQuality();
  const engine = new Engine(viewport, uiRoot, quality);

  const cameraRig = new CameraRig();

  engine.add(new Atmosphere());
  engine.add(new Terrain());
  engine.add(cameraRig);

  // Optional systems are loaded dynamically so a failure in one subsystem
  // degrades that feature instead of blanking the whole game.
  await loadOptionalSystems(engine);

  await engine.initSystems((name, index, total) => {
    bootStatus.textContent = name.replace(/([A-Z])/g, ' $1').trim();
    bootBar.style.width = `${Math.round((index / total) * 100)}%`;
  });

  bootBar.style.width = '100%';
  bootStatus.textContent = 'ready';

  engine.start();

  // Warm the pipeline: compile shaders and let temporal effects converge before
  // the curtain lifts, so the first visible frame is already correct.
  engine.renderer.compile(engine.scene, engine.camera);
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  setTimeout(() => boot.classList.add('hidden'), 120);

  exposeHarness(engine, cameraRig);
}

/**
 * Systems added here are still under construction by parallel work streams.
 * Each import is isolated so a missing or throwing module cannot take down the
 * rest of the game.
 */
async function loadOptionalSystems(engine: Engine): Promise<void> {
  const optional: Array<[string, () => Promise<{ default?: unknown } & Record<string, unknown>>]> = [
    ['Lighting', () => import('@/engine/Lighting')],
    ['Water', () => import('@/world/Water')],
    ['Vegetation', () => import('@/world/Vegetation')],
    ['Props', () => import('@/world/Props')],
    ['ModelCatalog', () => import('@/entities/ModelCatalog')],
    ['Decals', () => import('@/fx/Decals')],
    ['Effects', () => import('@/fx/Effects')],
    ['Battlefield', () => import('@/game/Battlefield')],
    ['Hud', () => import('@/ui/Hud')],
    ['Audio', () => import('@/audio/Audio')],
    ['PostFX', () => import('@/engine/PostFX')],
  ];

  for (const [label, loader] of optional) {
    try {
      const mod = await loader();
      const Ctor = (mod.default ?? mod[label] ?? mod[Object.keys(mod)[0]]) as
        | (new () => { name: string })
        | undefined;
      if (typeof Ctor === 'function') {
        engine.add(new Ctor() as never);
      }
    } catch (err) {
      if (!isMissingModule(err)) console.warn(`[VerdiumStorm] system "${label}" failed to load`, err);
    }
  }
}

function isMissingModule(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /Failed to (fetch|resolve)|Cannot find module|dynamically imported module/i.test(msg);
}

/**
 * Test/automation surface used by tools/shoot.mjs. Kept tiny and stable so the
 * visual review harness does not need to know about engine internals.
 */
function exposeHarness(engine: Engine, rig: CameraRig): void {
  const harness = {
    engine,
    rig,
    THREE,
    ready: true,
    version: 2,
    presets: Object.keys(SHOT_PRESETS),

    setPreset(name: ShotPresetName): boolean {
      const preset = SHOT_PRESETS[name];
      if (!preset) return false;
      rig.instant = true;
      rig.setPose(
        {
          target: new THREE.Vector3(preset.target[0], 0, preset.target[1]),
          distance: preset.distance,
          yaw: preset.yaw,
          pitch: preset.pitch,
        },
        true,
      );
      preset.apply?.(engine);
      return true;
    },

    setTimeOfDay(t: number): void {
      const env = engine.get('atmosphere') as unknown as { timeOfDay: number } | undefined;
      if (env) env.timeOfDay = t;
    },

    setPaused(v: boolean): void {
      engine.paused = v;
    },

    /**
     * Halts the rAF loop so the drawing buffer holds a stable frame. Software
     * rasterisation is slow enough that the compositor otherwise never settles
     * long enough for a screenshot to complete.
     */
    freeze(): void {
      engine.stop();
    },
    thaw(): void {
      engine.start();
    },

    /** Reads the WebGL buffer directly — bypasses the browser compositor. */
    capture(): string {
      return engine.renderer.domElement.toDataURL('image/png');
    },

    /**
     * Advances the sim by fixed steps so captures are reproducible.
     *
     * Each frame ends with a one-pixel readback. That looks wasteful but is
     * load-bearing under software rasterisation: SwiftShader defers the drawing
     * work, so a burst of steps queues up instead of executing, and the first
     * real readPixels then has to flush the entire burst — which takes minutes
     * at 1080p and takes the tab down with it. Syncing per frame keeps the
     * queue one frame deep.
     */
    step(frames: number, dt = 1 / 60): void {
      const gl = engine.renderer.getContext();
      const probe = new Uint8Array(4);
      for (let i = 0; i < frames; i++) {
        engine.stepManual(dt);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
      }
    },

    stats(): Record<string, number> {
      const info = engine.renderer.info;
      return {
        frameMs: Math.round(engine.frameMs * 100) / 100,
        fps: Math.round(1000 / Math.max(engine.frameMs, 0.01)),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        textures: info.memory.textures,
        geometries: info.memory.geometries,
      };
    },

    systems(): string[] {
      return (engine as unknown as { systems: Array<{ name: string }> }).systems.map((s) => s.name);
    },

    /** Systems disabled after throwing. Empty is the only healthy value. */
    faulted(): string[] {
      return [...engine.faulted];
    },
  };

  (window as unknown as Record<string, unknown>).VS = harness;
  window.dispatchEvent(new CustomEvent('vs-ready'));
}

main().catch((err) => {
  console.error(err);
  bootStatus.textContent = `failed: ${String((err as Error)?.message ?? err)}`;
  bootStatus.setAttribute('style', 'color:#ff7a7a');
});
