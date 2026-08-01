# Verdium Storm

A real-time strategy game built in Three.js, aiming at the visual and systemic
quality of a modern AAA RTS — the Command & Conquer lineage — in the browser.

Its defining constraint: **zero external art assets.** Every texture, mesh,
material and sound is generated procedurally at runtime or authored in code.
No downloaded PNGs, no model files, no audio files. That constraint is the
whole challenge, and it shapes most of the interesting engineering here.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm run build      # production build into dist/
npm run preview    # serve the built output
npm run typecheck  # tsc --noEmit
```

Query parameters: `?quality=low|medium|high|ultra` forces a quality tier,
`?dpr=1` pins device pixel ratio, `?day=<minutes>` starts the day/night clock
(frozen by default so screenshots stay comparable), `?tod=0..1` sets time of day
directly, and `?harness=1` exposes the automation surface.

## What is here

| System | Notes |
| --- | --- |
| Terrain | CDLOD quadtree, procedurally synthesised PBR layers, height-blended splat, triplanar cliffs |
| Atmosphere | Bruneton-style scattering, sky-view and multiscatter LUTs, aerial perspective, PMREM image-based lighting, volumetric clouds |
| Lighting | Cascaded shadow maps with texel-snapped fitting, key/fill/bounce rig driven by the sky model |
| Post | HDR chain — TAA, GTAO, progressive bloom, AgX with a procedural 3D-LUT grade, DOF, grain |
| Water | Gerstner waves, depth-based absorption, screen-space reflection, shoreline foam |
| Vegetation | GPU grass with a shared wind field, procedural trees with LOD and baked imposters |
| Simulation | Pooled entities, flow-field navigation, economy, power grid, fog of war, enemy AI |
| Models | Procedural units and structures per faction, with turret/tread/suspension rigs |
| VFX | Pooled GPU particles, multi-stage explosions, tracers, terrain-projected decals |
| UI | DOM HUD — command sidebar, minimap, selection, alerts, procedural icons and typeface |
| Audio | Web Audio synthesis: SFX, EVA-style announcer, adaptive score |

## Architecture

Entry point is `src/main.ts`. It creates an `Engine`, registers systems and
starts the loop.

- **`src/engine/System.ts`** — the `System` interface every subsystem
  implements (`init`, `update`, `lateUpdate`, `resize`, `dispose`) and the
  `Phase` tick ordering.
- **`src/engine/Services.ts`** — cross-system contracts. Systems talk through
  these rather than importing each other, so they can be developed and replaced
  independently.
- **`src/engine/Engine.ts`** — device, frame loop, system registry. Systems are
  fault-isolated: one that throws is reported once and disabled, and the frame
  still presents. A system may claim presentation via `setRenderHook`, which the
  post stack does.
- **`src/world/Heightfield.ts`** — the single source of truth for world shape.
  Terrain rendering, water, scattering, pathfinding and building placement all
  sample it.

Deeper notes live in `docs/`: `ARCHITECTURE.md`, `ATMOSPHERE.md`, `UI.md`,
`KNOWN_ISSUES.md`, and `REVIEW_RUBRIC.md` — the standard screenshots are judged
against.

## Tooling

Rendering work is hard to review by reading diffs, so the repository carries its
own visual harness. All of it runs headless Chromium against a real build.

```bash
node tools/verify.mjs                                  # integration checks
node tools/shoot.mjs --label mywork --shots overview   # capture PNGs
node tools/probe.mjs --shot overview --patch valley:820,760,40,40 \
  --case baseline: --case nofog:'VS_ATMO.skyUniforms.uFogA.value.set(0,1,0,1)'
node tools/compare.mjs --a baseline --b mywork --blind # A/B sheets
```

- **`verify.mjs`** asserts the invariants that only break where systems meet:
  the engine boots, systems register, geometry draws, nothing faulted, and the
  frame is not black, blown out, flat, detail-free, temporally unstable or
  broken by a resize. It reports frame statistics — mean, standard deviation,
  histogram occupancy, edge energy — which make "is this actually better?" a
  number rather than an opinion.
- **`shoot.mjs`** drives named camera presets from `src/game/ShotPresets.ts`.
  Framing is deliberately stable so iterations stay comparable.
- **`probe.mjs`** reports mean sRGB of named pixel patches across a list of
  conditions evaluated live in the page. Every colour defect in this project was
  ultimately found with it rather than by eye.

Two things worth knowing before extending the tooling. Capture reads the WebGL
buffer with `gl.readPixels` and encodes the PNG in Node, because
`canvas.toDataURL('image/png')` costs 30–50 s per frame under software
rasterisation. And frames are captured with the loop frozen and stepped a fixed
number of times, so a capture is reproducible rather than whatever the scheduler
happened to present.

## Legacy

`Verdium Storm — Three.js RTS-kimik3.html` is the original single-file Three.js
r128 demo this project grew out of. It is kept for reference and is not part of
the build.
