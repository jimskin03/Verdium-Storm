import * as THREE from 'three';
import { tryGet } from '@/engine/Services';

/**
 * The single wind field of the map.
 *
 * Every piece of vegetation — grass blades, leaf cards, trunks, bushes — bends
 * against the *same* function, so a gust reads as one coherent wave sweeping
 * across a field rather than as per-object jitter. The field is defined in
 * world space and advected along the wind direction, which is what makes the
 * travelling wave visible.
 *
 * Uniform objects here are shared by reference across every material that uses
 * them, so `updateWind` once per frame drives the entire world.
 */

export const windUniforms = {
  uWindTime: { value: 0 },
  /** Normalised XZ direction the wind blows towards. */
  uWindDir: { value: new THREE.Vector2(0.86, 0.51).normalize() },
  /** Global gust amplitude multiplier; 0 freezes the field. */
  uWindStrength: { value: 1.0 },
};

/** Sun state mirrored from the environment service for foliage translucency. */
export const sunUniforms = {
  uSunDir: { value: new THREE.Vector3(0.42, 0.62, 0.35).normalize() },
  uSunColor: { value: new THREE.Color(0xffe6c2) },
  uSunIntensity: { value: 3.1 },
};

let lastTick = -1;

/**
 * Idempotent per-frame tick. Vegetation and Props are separate systems but
 * share these uniforms; whichever ticks first wins and the second call is free.
 */
export function updateWind(elapsed: number): void {
  if (elapsed === lastTick) return;
  lastTick = elapsed;

  windUniforms.uWindTime.value = elapsed;
  // Slow multi-minute drift in direction and strength so a long look at the
  // same field never settles into an obvious loop.
  const drift = Math.sin(elapsed * 0.021) * 0.32 + Math.sin(elapsed * 0.0071 + 1.7) * 0.18;
  const base = Math.atan2(0.51, 0.86);
  windUniforms.uWindDir.value.set(Math.cos(base + drift), Math.sin(base + drift));
  windUniforms.uWindStrength.value = 0.82 + 0.3 * Math.sin(elapsed * 0.043 + 0.6) + 0.12 * Math.sin(elapsed * 0.11);

  const env = tryGet('environment');
  if (env) {
    sunUniforms.uSunDir.value.copy(env.sunDirection);
    sunUniforms.uSunColor.value.copy(env.sunColor);
    sunUniforms.uSunIntensity.value = env.sunIntensity;
  }
}

/**
 * GLSL half of the wind field. `vsWind` returns:
 *   .xy — horizontal bend vector (unit-ish, scaled by gust strength)
 *   .z  — local gust intensity in ~[0,1.2], used for colour and flutter
 */
export const WIND_GLSL = /* glsl */ `
uniform float uWindTime;
uniform vec2  uWindDir;
uniform float uWindStrength;

float vsHash21(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vsNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vsHash21(i);
  float b = vsHash21(i + vec2(1.0, 0.0));
  float c = vsHash21(i + vec2(0.0, 1.0));
  float d = vsHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

vec3 vsWind(vec2 world, float flutterRate) {
  vec2 dir = normalize(uWindDir + vec2(1e-5));

  // Two advected octaves. The low one is the gust cell (~70 unit wavelength)
  // travelling downwind; the high one breaks it up so the wave front is ragged.
  vec2 flow = world * 0.0135 - dir * uWindTime * 0.62;
  float g = vsNoise2(flow) * 0.72 + vsNoise2(flow * 2.63 + 11.3) * 0.28;
  float gust = max(0.0, 0.52 + 0.62 * g);

  // Cross-wind ripple: keeps a field from looking like it is on rails.
  float ripple = vsNoise2(world * 0.075 - dir * uWindTime * 1.9);

  vec2 bend = dir * gust + vec2(-dir.y, dir.x) * ripple * 0.28;
  float flutter = sin(uWindTime * flutterRate + world.x * 1.7 + world.y * 1.1);
  bend += vec2(-dir.y, dir.x) * flutter * 0.07 * gust;

  return vec3(bend * uWindStrength, gust);
}
`;
