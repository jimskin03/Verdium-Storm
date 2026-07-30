import * as THREE from 'three';
import { ATMOSPHERE } from './atmosphereCommon';

/**
 * A compact CPU evaluation of the same atmosphere the GPU LUTs render.
 *
 * Only used for things the CPU has to know: the colour and intensity of the sun
 * and bounce lights, the horizon colour published on EnvironmentService, and
 * the fog fallback colour handed to `scene.fog` for any material this stream
 * does not patch. It runs a few hundred float ops and only when the sun moves,
 * so accuracy matters more than speed — but it is single-scattering only, with
 * a multiple-scattering fudge tuned against the GPU LUT.
 */

const A = ATMOSPHERE;
const RS = A.rayleighScattering;
const OZ = A.ozoneAbsorption;

interface Medium {
  sr: number[];
  sm: number;
  ext: number[];
}

const medium: Medium = { sr: [0, 0, 0], sm: 0, ext: [0, 0, 0] };

function sampleMedium(h: number): Medium {
  const dR = Math.exp(-Math.max(h, 0) / A.rayleighHeight);
  const dM = Math.exp(-Math.max(h, 0) / A.mieHeight);
  const dO = Math.max(0, 1 - Math.abs(h - A.ozoneCenter) / A.ozoneWidth);
  medium.sm = A.mieScattering * dM;
  for (let c = 0; c < 3; c++) {
    medium.sr[c] = RS[c] * dR;
    medium.ext[c] = medium.sr[c] + medium.sm + A.mieAbsorption * dM + OZ[c] * dO;
  }
  return medium;
}

/** Distance from (r, mu) to the top of the atmosphere. */
function distanceToTop(r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + A.topRadius * A.topRadius;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
}

/** True when the ray from (r, mu) hits the planet. */
function hitsGround(r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + A.groundRadius * A.groundRadius >= 0;
}

const transmittanceOut = [0, 0, 0];

/** Transmittance from an altitude/zenith-cosine pair out to space. */
export function transmittanceToSpace(altitudeKm: number, mu: number, out = transmittanceOut): number[] {
  const r = A.groundRadius + altitudeKm;
  if (hitsGround(r, mu)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const t = distanceToTop(r, mu);
  const steps = 24;
  const dt = t / steps;
  const od = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const ti = (i + 0.5) * dt;
    const ri = Math.sqrt(ti * ti + 2 * r * mu * ti + r * r);
    const m = sampleMedium(ri - A.groundRadius);
    od[0] += m.ext[0] * dt;
    od[1] += m.ext[1] * dt;
    od[2] += m.ext[2] * dt;
  }
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-od[c]);
  return out;
}

function rayleighPhase(cosT: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosT * cosT);
}

function miePhase(cosT: number, g: number): number {
  const g2 = g * g;
  const k = ((3 / (8 * Math.PI)) * (1 - g2)) / (2 + g2);
  const d = 1 + g2 - 2 * g * cosT;
  return (k * (1 + cosT * cosT)) / (d * Math.sqrt(Math.max(d, 1e-4)));
}

/**
 * Single-scattered sky radiance for a view direction, in units where the solar
 * irradiance at the top of the atmosphere is 1.
 */
export function skyRadiance(
  viewDir: THREE.Vector3,
  sunDir: THREE.Vector3,
  altitudeKm: number,
  out: THREE.Color,
): THREE.Color {
  const r = A.groundRadius + altitudeKm;
  const mu = THREE.MathUtils.clamp(viewDir.y, -1, 1);
  const cosT = THREE.MathUtils.clamp(viewDir.dot(sunDir), -1, 1);
  const pR = rayleighPhase(cosT);
  const pM = miePhase(cosT, A.miePhaseG);

  const groundHit = hitsGround(r, mu);
  let tMax = groundHit ? 40 : distanceToTop(r, mu);
  tMax = Math.min(tMax, 200);

  const steps = 16;
  const L = [0, 0, 0];
  const tr = [1, 1, 1];
  const sunT: number[] = [0, 0, 0];

  for (let i = 0; i < steps; i++) {
    const f0 = i / steps;
    const f1 = (i + 1) / steps;
    const tA = tMax * f0 * f0;
    const dt = tMax * f1 * f1 - tA;
    if (dt <= 0) continue;
    const t = tA + dt * 0.5;
    // Altitude of the sample, curved-earth exact.
    const ri = Math.sqrt(t * t + 2 * r * mu * t + r * r);
    const h = ri - A.groundRadius;
    const m = sampleMedium(h);
    // Sun zenith cosine at the sample point.
    const sampleMuSun = (r * sunDir.y + t * viewDir.dot(sunDir)) / ri;
    transmittanceToSpace(ri - A.groundRadius, sampleMuSun, sunT);
    for (let c = 0; c < 3; c++) {
      const inScatter = (m.sr[c] * pR + m.sm * pM) * sunT[c];
      const stepTr = Math.exp(-m.ext[c] * dt);
      L[c] += tr[c] * ((inScatter - inScatter * stepTr) / Math.max(m.ext[c], 1e-7));
      tr[c] *= stepTr;
    }
  }

  // Multiple scattering, approximated: it is roughly proportional to the single
  // scattered blue and fills in as the sun drops, which is what keeps twilight
  // luminous rather than black.
  const msGain = 0.55 + 0.9 * Math.max(0, 1 - Math.abs(sunDir.y));
  out.setRGB(L[0] * (1 + msGain * 0.5), L[1] * (1 + msGain * 0.62), L[2] * (1 + msGain * 0.78));
  return out;
}

const tmpDir = new THREE.Vector3();
const tmpColor = new THREE.Color();

export interface SkySample {
  /** Solar transmittance at the camera — the sun's colour. */
  sunTransmittance: THREE.Color;
  zenith: THREE.Color;
  /** Averaged horizon ring; what distant geometry fades into. */
  horizon: THREE.Color;
  /** Rough hemispherical average, used for the ambient fill. */
  average: THREE.Color;
}

const sample: SkySample = {
  sunTransmittance: new THREE.Color(),
  zenith: new THREE.Color(),
  horizon: new THREE.Color(),
  average: new THREE.Color(),
};

/** Evaluates the handful of sky quantities the CPU side of the engine needs. */
export function evaluateSky(sunDir: THREE.Vector3, altitudeKm = 0.06): SkySample {
  const t = transmittanceToSpace(altitudeKm, sunDir.y);
  sample.sunTransmittance.setRGB(t[0], t[1], t[2]);

  skyRadiance(tmpDir.set(0, 1, 0), sunDir, altitudeKm, sample.zenith);

  sample.horizon.setRGB(0, 0, 0);
  sample.average.setRGB(0, 0, 0);
  const rings = [0.02, 0.16, 0.42, 0.72];
  const azimuths = 6;
  let weightSum = 0;
  for (let a = 0; a < azimuths; a++) {
    const phi = (a / azimuths) * Math.PI * 2;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    // Azimuth measured from the sun so the ring straddles both the warm and the
    // cool side of the sky.
    const sx = sunDir.x;
    const sz = sunDir.z;
    const len = Math.hypot(sx, sz) || 1;
    const dx = (sx / len) * cos - (sz / len) * sin;
    const dz = (sx / len) * sin + (sz / len) * cos;
    for (let r = 0; r < rings.length; r++) {
      const el = rings[r];
      const ce = Math.sqrt(Math.max(0, 1 - el * el));
      skyRadiance(tmpDir.set(dx * ce, el, dz * ce), sunDir, altitudeKm, tmpColor);
      const w = 1;
      sample.average.r += tmpColor.r * w;
      sample.average.g += tmpColor.g * w;
      sample.average.b += tmpColor.b * w;
      weightSum += w;
      if (r === 0) {
        sample.horizon.r += tmpColor.r / azimuths;
        sample.horizon.g += tmpColor.g / azimuths;
        sample.horizon.b += tmpColor.b / azimuths;
      }
    }
  }
  sample.average.multiplyScalar(1 / Math.max(weightSum, 1));
  return sample;
}
