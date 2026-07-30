# Verdium Storm — Development & Iteration

This document explains how to iterate locally, debug, and (optionally) refactor the single-file demo into a more maintainable project.

## Local iteration
Recommended: serve the repository over HTTP to avoid file:// restrictions (audio and certain APIs):
```bash
# From repo root
python3 -m http.server 8000
# or, using npm:
npx http-server -p 8000
# open: http://localhost:8000/Verdium%20Storm%20%E2%80%94%20Three.js%20RTS-kimik3.html
```

Edit the HTML file directly, save, then refresh the browser. Use “Disable cache” in DevTools Network tab during iteration.

## Debugging tips
- Open browser DevTools (Console, Sources, Performance).
- Set breakpoints in the inlined script (the HTML file is the source).
- For performance profiling: use the Performance tab, and observe draw calls + script time.
- To inspect scene graph: in console, you can access `scene`, `camera`, or global objects if they are exposed — the demo wraps code in an IIFE; if needed, temporarily expose objects for debugging (e.g., `window._scene = scene`).
- To inspect geometry: select meshes in the Three.js inspector (use a browser extension like “three.js inspector”).

## Suggested refactor / split (if you want a multi-file project)
Move sections into modules:
- src/engine/renderer.js — three.js renderer, lighting, sky
- src/world/terrain.js — noise, getH, paintTerrain, water
- src/world/objects.js — BUILDERS and general mesh helpers
- src/game/entities.js — createUnit, createBuilding, definitions (BLD/UDEF)
- src/game/combat.js — projectiles & damage
- src/systems/particles.js — particle pools & spawn/update
- src/systems/audio.js — initAudio & sfx
- src/ui/input.js — pointer/keyboard handling & overlays
- index.html — small host HTML that imports the bundled app

Use a bundler (esbuild, Rollup, webpack) and convert to ES modules. Keep Three.js version pinned (r128 used in demo). Consider upgrading carefully: Three.js API changes may require small code edits (e.g., material or renderer settings).

## Unit testing
- This demo is visual and interactive; conventional unit tests may be limited to pure functions (noise, fbm, resource math).
- For behavior-driven tests, extract game logic (economy, AI tick, production queue) into testable modules and use a test runner (Jest).

## Performance knobs
- renderer.setPixelRatio(Math.min(devicePixelRatio,2)); lower the clamp for low-end devices.
- Reduce particle counts in `makePoints()`.
- Use InstancedMesh where possible (already used for props).
- Limit shadow map size or turn off shadows for slower devices.

## Upgrading Three.js
- The demo references Three.js r128. If upgrading:
  - Check for breaking changes in WebGLRenderer, material properties, or shader snippets.
  - Run the demo and inspect console for removed/changed APIs.

## Packaging & hosting
- The HTML is self-contained (except for the Three.js CDN). For easier hosting, upload to GitHub Pages or any static host.
- To create a deployable bundle for distribution, consider minifying and gzipping the HTML for a static server.
