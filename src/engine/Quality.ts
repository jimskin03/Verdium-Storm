import type { QualitySettings, QualityTier } from './System';

const PRESETS: Record<QualityTier, Omit<QualitySettings, 'tier' | 'pixelRatio' | 'anisotropy'>> = {
  low: {
    shadowMapSize: 1024, shadowCascades: 2, pcssSamples: 0,
    ssao: false, ssr: false, taa: false, bloom: true, motionBlur: false,
    depthOfField: false, volumetricLight: false, volumetricClouds: false,
    grassDensity: 0.15, terrainLodBias: 2.0, maxParticles: 6000,
  },
  medium: {
    shadowMapSize: 2048, shadowCascades: 3, pcssSamples: 8,
    ssao: true, ssr: false, taa: true, bloom: true, motionBlur: false,
    depthOfField: false, volumetricLight: true, volumetricClouds: true,
    grassDensity: 0.45, terrainLodBias: 1.35, maxParticles: 18000,
  },
  high: {
    shadowMapSize: 2048, shadowCascades: 4, pcssSamples: 16,
    ssao: true, ssr: true, taa: true, bloom: true, motionBlur: true,
    depthOfField: true, volumetricLight: true, volumetricClouds: true,
    grassDensity: 0.8, terrainLodBias: 1.0, maxParticles: 40000,
  },
  ultra: {
    shadowMapSize: 4096, shadowCascades: 4, pcssSamples: 24,
    ssao: true, ssr: true, taa: true, bloom: true, motionBlur: true,
    depthOfField: true, volumetricLight: true, volumetricClouds: true,
    grassDensity: 1.0, terrainLodBias: 0.75, maxParticles: 80000,
  },
};

/** Reads `?quality=ultra` / `?dpr=1` overrides used by the screenshot harness. */
export function createQuality(): QualitySettings {
  const params = new URLSearchParams(location.search);
  const requested = params.get('quality') as QualityTier | null;
  const tier: QualityTier = requested && requested in PRESETS ? requested : detectTier();
  const maxDpr = tier === 'ultra' ? 2 : tier === 'high' ? 2 : 1.5;
  const dprOverride = Number(params.get('dpr'));
  const pixelRatio = Number.isFinite(dprOverride) && dprOverride > 0
    ? dprOverride
    : Math.min(window.devicePixelRatio || 1, maxDpr);
  return { tier, pixelRatio, anisotropy: tier === 'low' ? 4 : 16, ...PRESETS[tier] };
}

function detectTier(): QualityTier {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return 'low';
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : '';
  const renderer = raw.toLowerCase();
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  if (/swiftshader|llvmpipe|software|angle \(google/.test(renderer)) return 'medium';
  if (/rtx (30|40|50)|rx 7\d{3}|rx 6[89]00|m[123] (max|ultra)/.test(renderer)) return 'ultra';
  if (memory <= 4) return 'low';
  return 'high';
}
