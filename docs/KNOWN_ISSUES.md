# Known Issues

Findings from integration passes, with the diagnosis already done. Each entry
names the owning workstream. Do not re-derive these — verify and fix.

## Open

### 1. Distant tree foliage renders black (vegetation)

**Symptom.** In wide shots, many trees render as solid black silhouettes while
others in the same frame are correctly green. Near trees are fine.

**Ruled out.** Materials are correct (`vertexColors: false`, base colour set,
`map` bound). Lighting is healthy — a DirectionalLight at 3.1 plus a
HemisphereLight at 0.85. Shadowing is not responsible: disabling
`shadowMap.enabled` moves mean frame brightness only 0.2601 → 0.2831. The
imposter material is a plain MeshStandardMaterial with no colour handling of its
own, and the foliage shader patch only injects wind (vertex) and an additive
translucency term (fragment).

**Remaining hypothesis.** The leaf atlas. `leafMat` uses `alphaTest: 0.42`, so a
cell that is opaque-but-black still passes the alpha test and draws black. LOD0
renders correctly and LOD1 does not, which points at the UV cells that the
lower-detail foliage geometry addresses — likely empty or unwritten regions of
the atlas for some species/LOD combinations.

**Where to look.** `makeLeafAtlas` in `src/shaders/foliage/Textures.ts` and the
foliage UV assignment in `buildTree` (`src/shaders/foliage/Trees.ts`), for LOD
index ≥ 1. Dumping the atlas to a PNG and looking at it will settle this in one
step.

### 2. Terrain splat is monochrome (terrain)

**Symptom.** The whole map reads as one flat khaki/tan. Dry grass appears to win
everywhere; lush grass, dirt and mud are not visibly present, so the ground has
no biome variety.

**Where to look.** The layer weighting in `TERRAIN_FRAGMENT_MAIN`
(`src/shaders/terrain/surface.glsl.ts`) and the macro mask written by
`SYNTH_MACRO_FRAGMENT` (`src/shaders/terrain/synthesis.glsl.ts`). Either the
macro biome channel is saturating, or the altitude/slope thresholds sit outside
this map's actual height range — the playable area spans roughly 0–130 world
units, so thresholds authored for a taller world would collapse to one layer.

### 3. Visible tiling on distant slopes (terrain)

**Symptom.** A regular diagonal hatch pattern is visible across the mountains in
wide shots — the rock layer repeating at its tile frequency.

**Where to look.** `uLayerScale.z` (rock tile size) is 4 world units, which is
very tight for geometry seen from hundreds of units away. The stochastic /
de-tiling octave needs to dominate at distance, or the tile scale needs to grow
with view distance.

### 4. Hard stair-stepped shoreline (water / terrain)

**Symptom.** The waterline is a jagged staircase rather than a smooth contour.

**Cause.** The water plane intersects terrain geometry with no blend. The
shoreline needs the depth-difference foam and wet-sand band described in the
water brief, which will also hide the intersection.

### 5. `closeup` preset kills the tab under software rendering (harness)

**Symptom.** `node tools/shoot.mjs --shots closeup` at `--quality ultra` hangs
and takes the browser with it. Other presets are fine.

**Cause.** The camera sits 42 units from the ground, so the quadtree subdivides
to its minimum node size and parallax occlusion runs over nearly the whole
frame. That is simply more fragment work than SwiftShader will complete.

**Workaround.** Shoot `closeup` with `--quality high` (POM off) or at a smaller
`--width/--height`. The harness already isolates shot failures, so the rest of a
run survives it; only this preset is affected.

## Fixed

- **All near foliage rendered black.** Every tree and ground-cover material set
  `vertexColors: true`, but no geometry builder writes a `color` attribute, so
  three's `color_vertex` chunk multiplied by an absent attribute. Removed the
  flag; per-instance variation comes from `instanceColor`, which is unaffected.
- **Whole scene black, zero draw calls.** `Audio.update` called
  `camera.getWorldDirection` with a hand-rolled `Vector3` stand-in (the module
  imports three for types only), which threw every frame and aborted the frame
  before `render()`. The view direction now comes off the camera world matrix,
  and `Engine` isolates system faults so this class of bug degrades one system
  instead of blanking the game.
- **Capture taking 34–50 s/frame.** `canvas.toDataURL('image/png')` runs its
  encode on SwiftShader's readback path. Replaced with `gl.readPixels` plus a
  zlib PNG encoder in node (`tools/png.mjs`).
- **Stepped bursts flushing all at once.** SwiftShader defers draw work, so
  `step(n)` queued n frames and the first readback flushed the lot — minutes at
  1080p, usually fatal. `step` now ends each frame with a one-pixel readback.
- **Fragment shader failing to compile.** A GLSL local named `patch`, which is
  reserved in GLSL ES 3.00.
