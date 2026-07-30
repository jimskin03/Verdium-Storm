import type { Engine } from '@/engine/Engine';

/**
 * Fixed camera poses used by the automated visual review harness. Each preset
 * frames one discipline so a reviewer can judge it in isolation and compare
 * against a reference shot from the same angle across iterations.
 */
export interface ShotPreset {
  /** [x, z] ground focus point. */
  target: [number, number];
  distance: number;
  yaw: number;
  pitch: number;
  description: string;
  apply?: (engine: Engine) => void;
}

export type ShotPresetName =
  | 'overview' | 'base' | 'battle' | 'closeup' | 'terrain'
  | 'water' | 'vegetation' | 'sunset' | 'skyline';

export const SHOT_PRESETS: Record<ShotPresetName, ShotPreset> = {
  overview: {
    target: [-120, -120], distance: 380, yaw: Math.PI * 0.25, pitch: 0.86,
    description: 'Wide strategic view — terrain silhouette, atmosphere, scale',
  },
  base: {
    target: [-300, -300], distance: 150, yaw: Math.PI * 0.3, pitch: 0.7,
    description: 'Player base — buildings, materials, shadows, ground detail',
  },
  battle: {
    target: [0, 0], distance: 110, yaw: Math.PI * 0.75, pitch: 0.58,
    description: 'Mid-map engagement — units, VFX, decals, combat readability',
  },
  closeup: {
    target: [-300, -300], distance: 42, yaw: Math.PI * 0.15, pitch: 0.38,
    description: 'Hero close-up — model fidelity, PBR response, micro-detail',
  },
  terrain: {
    target: [-80, 210], distance: 260, yaw: Math.PI * 1.15, pitch: 0.5,
    description: 'Ridge line — terrain texturing, blending, cliff detail',
  },
  water: {
    target: [40, 40], distance: 130, yaw: Math.PI * 0.55, pitch: 0.34,
    description: 'Shoreline — water shading, reflections, foam, refraction',
  },
  vegetation: {
    target: [-140, 40], distance: 70, yaw: Math.PI * 0.6, pitch: 0.44,
    description: 'Ground cover — grass, trees, wind, scatter density',
  },
  sunset: {
    target: [-120, -60], distance: 300, yaw: Math.PI * 0.92, pitch: 0.32,
    description: 'Golden hour — sun disc, god rays, aerial perspective',
    apply: (engine) => {
      const sky = engine.get('skyAtmosphere') as unknown as { timeOfDay: number } | undefined;
      const atmo = engine.get('atmosphere') as unknown as { timeOfDay: number } | undefined;
      if (sky) sky.timeOfDay = 0.79;
      else if (atmo) atmo.timeOfDay = 0.79;
    },
  },
  skyline: {
    target: [0, 0], distance: 420, yaw: Math.PI * 0.1, pitch: 0.24,
    description: 'Horizon — sky gradient, clouds, distance fog, fog banding',
  },
};
