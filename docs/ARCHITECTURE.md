# Verdium Storm — Architecture & Code Map

This document describes the major systems in the single-file demo `Verdium Storm — Three.js RTS-kimik3.html` and points to the main symbols you will encounter. The full game is implemented inline in the HTML file under a single top-level IIFE; the code is organized into sections and helper functions.

## Major systems (high level)
- Renderer & scene setup  
  - Three.js renderer instantiation, scene, camera, lights, sky dome.
- Terrain generation  
  - Noise and FBM functions: `hash2()`, `vnoise()`, `fbm()`  
  - Height sampling: `getH(x,z)` — used everywhere for ground placement.
  - Terrain painting: `paintTerrain()` generates the color texture.
- Water & environment  
  - Water plane with procedural water texture and sky sprites/cloud sprites.
- Props & scattering  
  - `scatter()` function generates trees/rocks using InstancedMesh and marks grid occupancy.
- Fields / resources (Verdium crystals)
  - `FIELDS` array with fields data (position, radius, amount)
  - Per-field crystals in `crystals[]`, each with `res` (resource amount)
- Fog of War
  - Resolution: `FRES`, `FCELL` — fog alpha map on a canvas texture
  - Visibility arrays: `fogExplored[]`, `fogVis[]`
  - Reveal function: `reveal(x,z,sight)`
- Materials & shared geometry
  - Standard materials builder `std()`, team color table `TEAM`, helper textures (glow, smoke, stripe)
- Building and unit definitions
  - Building definitions: `BLD` (keys: `cy`, `power`, `barracks`, `factory`, `refinery`, `turret`)  
  - Unit definitions: `UDEF` (`rifle`, `rocket`, `tank`, `harvester`)  
  - Production/placement orders: `BUILD_ORDER`, `UNIT_ORDER`
- Builders / mesh factories
  - Building mesh factory `BUILDERS` (per-building builder functions)
  - Unit makers: `makeInfantry()`, `makeTank()`, `makeHarvester()`
- Entity creation
  - `createBuilding(team,type,x,z,instant)`  
  - `createUnit(team,type,x,z)`
- Health, selection & UI rings
  - `makeHealthBar()`, `bldBar()` create overlay sprites and rings
  - `selection` set maintains selection state
- Projectiles & Weapons
  - Projectile pools: `projectiles[]`; firing helper `fireProjectile(from,target,owner,kind,def)`
  - Tracers, shells, rockets with homing/gravity behaviour
- Particles & FX
  - Particle pools: `makePoints(cap,additive)` returning an object with arrays/pool
  - Functions to `spawnP()` and `updateP()` for smoke, sparks
  - FX items: `flashes`, `rings`, `lights`, `scorches`, `explosion()` helper
- Audio (WebAudio synthesized)
  - `initAudio()` constructs an AudioContext and waveform chains
  - `sfx` object with functions: `rifle`, `rocket`, `tank`, `boom`, `ui`, `ack`, etc.
- Game loop & AI
  - Time step and main update loop (update camera, entities, projectiles, emitters, spawn waves)
  - `enemyAI` object controls simplistic enemy wave logic
- Input & camera
  - Camera rig object `cam` with pan/rotate/zoom
  - Input handling (pointer events, keyboard): selection, drag-box, MMB for rotation, wheel zoom
  - Placement mode: `startPlacement(type)`, placement ghost object with `ghostMat`/`ghostBad`
- Economy & power
  - Player economy object `player` with `credits`, `power` (`made`, `used`), `kills`, `losses`
  - `recalcPower()` determines available power vs usage and toggles low-power behaviour.

## Notable top-level symbols
- WORLD, HALF, CELL, GRIDN, WATER_Y — environment constants
- PLATEAUS, FIELDS — pre-placed strategic/geographical features
- getH(x,z) — terrain height sampler (use this to place any ground object)
- BLD — building definitions with costs, hp, power
- UDEF — unit definitions
- BUILDERS / makeInfantry / makeTank / makeHarvester — mesh constructors
- createBuilding / createUnit — runtime entity spawners
- reveal(x,z,sight) — reveal fog around a position
- sfx — synthesized sound functions

## Recommended places to start reading
1. The top of the HTML file: scene + renderer + Three.js setup.
2. Terrain section (noise, getH, paintTerrain) — see how heights and textures are generated.
3. Definitions (BLD, UDEF) — understanding gameplay numbers.
4. Builders & entity creation — how meshes are composed then instantiated.
5. Input & UI — selection, placement, orders (this is a good place to modify controls).
6. Game loop & update functions — follow the tick order to see side-effects like resource ticks and AI.

---

## Modification guidance
- If you plan to split the file into modules, follow these logical separations:
  - engine/renderer.js (Three.js setup, main loop)
  - world/terrain.js (getH, paintTerrain, FIELDS)
  - world/objects.js (builders, shared materials)
  - gameplay/entities.js (createUnit/createBuilding, defs)
  - gameplay/combat.js (projectiles, damage)
  - systems/fx.js (particles, explosions)
  - systems/audio.js (sfx)
  - ui/input.js (selection, placement, overlay logic)
- Use ES modules and a bundler (esbuild/webpack/parcel) when moving to multiple files.
