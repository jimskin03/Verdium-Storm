# Atmosphere

Sky, sun, aerial perspective and image-based lighting. Owned by the atmosphere
stream: `src/engine/Atmosphere.ts`, `src/shaders/sky/**`, this document.

## Model

Hillaire 2020, *A Scalable and Production Ready Sky and Atmosphere Rendering
Technique*. Rayleigh + Mie single scattering raymarched into a sky-view LUT, plus
a second-order multiple-scattering LUT that supplies the energy single scattering
misses. Coefficients are Bruneton's clear-sky table and live once, in TypeScript,
in `atmosphereCommon.ts`; they are injected into GLSL as literals so the CPU sky
(`skyCpu.ts`, which colours the lights) and the GPU sky can never drift apart.

Units are kilometres. One world unit is one metre, so world Y maps to altitude
via `y * 0.001`.

| Pass | File | Rebuilt when |
| --- | --- | --- |
| Transmittance LUT | `SkyRenderer.ts` | once |
| Cloud density bake | `SkyRenderer.ts` | once |
| Multiple-scattering LUT | `SkyRenderer.ts` | sun moves ~1° |
| Sky-view LUT | `SkyRenderer.ts` | sun moves ~1° |
| Terrain sun-visibility | `GroundOcclusion.ts` | sun moves ~2° |
| PMREM environment probe | `SkyRenderer.ts` | sun moves ~6° |
| Dome | `SkyRenderer.ts` | every frame (1 draw call) |

With a static sun — which is the default, so screenshot comparisons mean
something — the steady-state cost is that one dome draw.

## The sky-view LUT has a ground half, and it is not sky

`vsSkyViewUv` maps a whole sphere of directions, not a hemisphere. Rows below
v ≈ 0.474 are view rays that hit the planet, and for those the raymarch ends at
the surface and adds a ground term: `VS_GROUND_ALBEDO / π` lit by the sun and by
multiple scattering. That term is wanted — it is what fills the lower half of the
environment probe, so PBR materials get a warm bounce from below instead of black
— but it is the planet's mean albedo, a tan, and it is **not** a sky colour.

**Invariant: aerial perspective must never sample the LUT below the horizon.**
`vsSkyLookup` in `SceneShaders.ts` clamps the elevation to zero before the fetch.
An RTS camera looks down at 30–50°, so without the clamp the inscatter colour for
essentially every pixel in the frame is the planet albedo, and the whole image
takes on a heavy warm tan cast that reads as a permanent dust storm. This was a
real, shipped bug; see *Fixed* below.

Clamping is the correct limit, not a fudge. A view ray to a surface a few
kilometres out stays at essentially constant altitude, so the medium along it
matches the medium along the horizon ray at the same azimuth, and the saturated
radiance of that horizontal path is exactly what the horizon row holds. Paired
with the per-channel `1 - tr`, short paths reproduce the source function
(blue-dominant, so near geometry blue-shifts) and long paths saturate to the
horizon. The dome and the probe still read the full sphere, and should.

## Aerial perspective

`GLSL_AERIAL` in `SceneShaders.ts`, spliced into every three.js mesh material
before tone mapping (three's own fog runs after it, which is too late).

```
color * tr + inscatter * (1 - tr)      tr = exp(-od * uFogExt)
```

- `uFogA` — two exponential layers: a deep haze (300 m scale height) that does
  the distance work and a shallow mist (34 m) that pools in valleys. Integrated
  analytically along the ray, so fog thins over ridges.
- `uFogExt` — per-channel extinction, blue-biased. This is what makes distance
  *shift* rather than merely pale. Note the sign: because blue extinguishes
  fastest, `color * tr` alone goes *warmer* with distance. The blue of aerial
  perspective comes entirely from the inscatter term, which is why the inscatter
  colour is the load-bearing part of this equation.
- `uFogB.y/z` — extra haze past 1300 units so the outer massif reads as distance
  rather than painted cardboard. Terrain runs to 5120 units; the playfield is
  1024.

**Density and inscatter brightness trade off directly and must be tuned as a
pair.** A dark inscatter buys density for free — you can pile on optical depth
before the frame looks hazy — so a density fitted against a wrong inscatter will
be far too high once the inscatter is right.

## Why the horizon is pale, and what does not fix it

A clear horizon saturates to `S / ext` times the solar transmittance at the
scattering points. In an optically thick Rayleigh medium `S` and `ext` share the
same spectral shape, so the ratio tends to white — the pale horizon band is
optical-depth saturation, not aerosol. Consequences, all measured:

- Lowering turbidity (Mie scattering + absorption together) makes the horizon
  *brighter and slightly warmer*, not bluer, because less grey extinction lets
  red saturate higher. It is not a lever for a bluer horizon.
- `miePhaseG` between 0.70 and 0.80 moves the horizon by under 2%.
- `groundAlbedo` is worth ~25% of horizon radiance through the multiple-
  scattering LUT. Lowering it does cool the horizon, but it also cools and dims
  the probe's ground hemisphere, which makes shadowed ground *bluer*. Left at
  Bruneton-ish values on purpose.

The sky gradient itself is healthy: at the default 34° sun the zenith sits at
B/R ≈ 4.5, 8° elevation at ≈ 2.7, and the horizon at ≈ 1.3 away from the sun.

## Lighting hand-off

`skyState` (in `SceneShaders.ts`) is a direct hand-off to `Lighting`, not a
service: key (sun by day, moon by night), a cool sky fill from the anti-sun side,
and a warm ground bounce from below. `EnvironmentService` publishes sun
direction/colour/intensity, time of day and a display-referred horizon colour for
the HUD, the minimap and water's fallback sky.

`SCENE_EXPOSURE` (5.2) is the one stop that lifts sun, sky, aerial perspective
and IBL together so their ratios stay physical. Tone mapping belongs to the post
stack; this is scene-referred gain. `scene.fog` is a `FogExp2` fallback for raw
shader materials that other streams own (water); its density is fitted to cross
the patched materials' haze at ~1 km and has to move whenever `uFogA.x` does.

## Tuning knobs, in the order you should reach for them

1. `configureFog()` in `Atmosphere.ts` — haze density, mist density, boundary
   boost. Almost every "too hazy / not hazy enough" note lands here.
2. `SCENE_EXPOSURE` — overall level. Moves everything together.
3. `uDomeParams` — sun disc gain, aureole gain, cloud lighting gain.
4. `ATMOSPHERE` in `atmosphereCommon.ts` — the physical model. Changing anything
   here invalidates every LUT and the CPU sky at once, which is the point.

## Measuring without rendering

`skyCpu.ts` is a compact CPU evaluation of the same model, accurate enough to
answer "what colour is the horizon at this sun angle" in milliseconds. Port a
variant of it before spending 15 minutes on a screenshot round-trip; most sky
questions are numerical, and the harness is slow under software rendering.

Frame statistics come from `node tools/verify.mjs --dist <dir>`. Healthy is mean
~0.29, stdev ~0.22, 16/16 histogram buckets, nothing clipping, and `faulted()`
empty — a throwing system is disabled and reported rather than fatal, so a broken
atmosphere looks like "no crash" but renders nothing.

## Fixed

- **Heavy warm tan/sepia cast over the whole frame.** `vsSkyLookup` sampled the
  sky-view LUT in the raw view direction. For a downward ray that returns the
  planet's mean ground albedo (0.24, 0.23, 0.19) lit by a warm sun — B/R 0.59 —
  so aerial perspective washed every surface in tan and the more correct the
  extinction maths was, the more sepia the scene became. Geometry *above* the
  horizon line, such as tree canopies against the sky, correctly took a blue
  inscatter in the same frame, which is the tell. Clamping the lookup elevation
  to the horizon fixed it; the fog densities then had to come down ~2x because
  they had been fitted against the wrong, too-dark inscatter.

## Known shortfalls

- **Golden hour is underexposed.** At the `sunset` preset (4° sun) the sky is
  correct and beautiful but the terrain falls to near-black. The exposure
  compensation in `refreshLighting` clamps at 2.9x, and a 4° sun on flat ground
  delivers `sin(4°)` of the irradiance. The sky and the ground want different
  exposures here and only one is available.
- **Shaded ground is very blue.** Physically defensible — diffuse skylight really
  is that blue — but the engine has no bounce GI from surrounding sunlit slopes,
  only a from-below bounce light that up-facing surfaces barely see, so shadowed
  valleys get sky and nothing else.
- **The multiple-scattering LUT is under-energised.** `MULTISCATTER_FRAG`
  normalises both accumulators without Hillaire's `4π` solid-angle factor, so the
  isotropic term lands ~12x low and the `1 / (1 - fms)` infinite-series
  amplification is effectively inert. The sky is tuned around this, so fixing it
  is a re-balance, not a one-line change.
