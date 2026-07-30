# Verdium Storm — Workstream Contract

Read this in full before writing any code. Multiple work streams run in
parallel against this repository at the same time. The rules below are what
keep that from turning into a merge disaster.

## The goal

A real-time strategy game whose visual and systemic quality stands next to a
modern AAA RTS — the C&C 3: Tiberium Wars / Kane's Wrath / C&C Remastered
lineage. Built in Three.js, in the browser, with **zero external art assets**:
every texture, mesh, material and sound is generated procedurally at runtime or
authored in code. That constraint is the whole challenge — hitting AAA fidelity
without a single downloaded PNG.

"Good enough" is not the bar. The bar is: a reviewer shown this next to a real
C&C screenshot, without labels, cannot immediately tell which is the hobby
project.

## Hard rules

1. **Only edit the files you own.** Your brief lists them. If you need a change
   in a file you do not own, note it in your final report instead — do not edit
   it. The only shared files you may append to are listed under "Shared files"
   below, and only in the way described there.
2. **Never leave the build broken.** `npm run typecheck && npm run build` must
   pass before you finish, and ideally after each significant step. Another
   stream may build at any moment.
3. **No new runtime dependencies.** `three` only. Dev-only tooling is fine to
   propose but do not install it yourself.
4. **No external asset fetches.** No CDN textures, no image files, no model
   files, no audio files. Everything procedural. This is non-negotiable — it is
   the project's defining constraint.
5. **Budget-aware.** Target 60 fps at 1080p on a mid-range discrete GPU at the
   `high` tier. Respect `ctx.quality` — every expensive feature must degrade or
   switch off on lower tiers.
6. **Write production code.** Full implementations, no `TODO`, no stubs left
   behind, no placeholder colours standing in for real work. Match the
   surrounding code's style: typed, commented where the *why* is non-obvious,
   no commented-out experiments.

## Architecture

Entry point is `src/main.ts`. It creates an `Engine`, registers systems and
starts the loop.

- `src/engine/System.ts` — the `System` interface and `EngineContext`. Every
  subsystem implements `System`: `init(ctx)`, `update(dt, elapsed)`,
  `lateUpdate`, `resize`, `dispose`. `phase` controls tick order (see `Phase`).
- `src/engine/Services.ts` — the cross-system contracts. This is how systems
  talk to each other **without importing each other**. If you produce something
  another stream consumes, `provide('name', impl)`. If you consume, use
  `whenReady('name')` (async) or `tryGet('name')` (optional). Never import
  another stream's concrete class.
- `src/engine/Engine.ts` — device, frame loop, system registry. A system may
  claim presentation via `engine.setRenderHook()`; the post-processing stack
  does this.
- `src/world/Heightfield.ts` — **the single source of truth for world shape.**
  `heightAt(x, z)`, `normalAt`, `slopeAt`, `isBuildable`, plateau and resource
  field layout. Terrain rendering, water, scattering, pathfinding and placement
  all sample this. It is shared and read-only to every stream.
- `src/game/ShotPresets.ts` — camera poses used by the review harness.

Your system is registered by `loadOptionalSystems()` in `main.ts`, which
dynamically imports a fixed list of modules and instantiates the default
export. Your module **must** keep its path and export a default class
implementing `System`. A throwing module degrades only itself.

## Shared files

You may edit these, but only additively and only for your own needs. Keep
changes minimal and never reformat or restructure them:

- `src/engine/Services.ts` — only to add a new service interface + map entry.
- `src/game/ShotPresets.ts` — only to add a new preset. Never change an
  existing preset's framing: stable framing is what makes iteration-over-
  iteration comparison meaningful.
- `docs/` — add your own file; do not edit others'.

Everything else: your files only.

## Verifying your work — this is the important part

```bash
npm run typecheck          # must be clean
npm run build              # must succeed
node tools/shoot.mjs --label <yourstream> --shots <relevant presets>
```

The harness boots the built game in headless Chromium, drives the camera to
each named preset and writes PNGs to `shots/<label>/`, plus a `report.json`
with draw calls, triangle counts and any console errors.

**Look at your own screenshots with the Read tool before you report done.**
Read them as images and judge them honestly. Most of the gap between "works"
and "looks AAA" is only visible this way. If it looks flat, muddy, plasticky,
low-contrast, aliased, or obviously procedural — it is not done. Iterate.

Rendering runs on SwiftShader (software) in this container, so frame rates in
`report.json` are not meaningful; draw calls and triangle counts are. Judge
performance by those, and by keeping work off the per-frame path.

## Known baseline gaps

- The world is a 1024×1024 plane with nothing beyond it, so wide shots see past
  the map edge into void. The world must read as continuous to the horizon.
- Lighting is a single directional light plus a hemisphere fill. Flat, no
  bounce, no sky IBL, no volumetrics.
- Terrain is per-vertex colour, no textures at all.
- No post-processing whatsoever.

## Quality bar — specifics that separate AAA from hobby

These are the things reviewers consistently catch:

- **Silhouette and read.** Units must be identifiable at gameplay zoom by
  shape alone. Team colour must be visible without dominating.
- **Material response.** Distinct roughness/metalness per surface. Metal that
  reflects the sky, dirt that does not. Nothing uniformly matte, nothing
  uniformly shiny.
- **Micro-detail at every scale.** Panel lines, bevels, wear at edges, surface
  noise. Flat untextured faces read as untextured instantly.
- **Grounding.** Contact shadows, ambient occlusion where objects meet ground,
  dust and debris at the base. Objects that appear to hover are the single most
  common tell.
- **Colour grading.** A deliberate palette with real tonal range. Not
  everything mid-grey-green. Highlights that bloom, shadows with colour in them.
- **Atmosphere with depth.** Aerial perspective so distant geometry desaturates
  and shifts toward the sky colour. Depth is what makes a scene feel large.
- **Motion quality.** Nothing snaps or lerps linearly. Recoil, suspension
  travel, turret lead and settle, tread animation, banking on turns.
