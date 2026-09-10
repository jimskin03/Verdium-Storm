# Verdium Storm

A real-time strategy game built in Three.js, aiming at the visual and systemic
quality of a modern AAA RTS — the Command & Conquer lineage — in the browser.

Its defining constraint: **zero external art assets.** Every texture, mesh,
material and sound is generated procedurally at runtime or authored in code.
No downloaded PNGs, no model files, no audio files. That constraint is the
whole challenge, and it shapes most of the interesting engineering here.

**The Prompt**:
I want you to build a real-time strategy game at the level of the most recent Command and conquer game. It should be utterly perfect, visually beautiful, with every single thing done at AAA quality—from textures to physics to anything you could think of.

Fan out sub-agents and have sub-agents tackle each one individually so that the game is utterly perfect. You should /loop on each item and have a separate sub-agent check it visually to ensure it looks triple A. That separate sub-agent should be a really harsh critic, and if it doesn't look triple A, it should keep going.

Don't stop until each sub-agent is utterly wowed with the quality when compared with the actual Command and conquer game. It should literally compare them side by side blind and say which one looks better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out sub-agents and ultracode.
**Credit to Matt Shumer https://shumer.dev/about -for the prompt (Gauntlet Loop)

## Running it

```bash
npm install
npm --prefix server install
npm run server     # multiplayer API/WebSocket server on http://localhost:8787
npm run dev        # game client on http://localhost:5173
```

Other scripts:

```bash
npm run build      # production build into dist/
npm run preview    # serve the built output
npm run typecheck  # tsc --noEmit
npm test           # client/server multiplayer integration and protocol tests
npm run agent:smoke:headless  # renderer-independent control-plane smoke test
```

## Two-player rooms

Choose **2 Player Room** on the main menu. The host creates a room with a
password and shares the displayed six-character room code plus that password.
The second commander opens the deployed game from any supported browser or
device, enters both values, and waits for the host to press **Deploy**.

Rooms use Verdium Storm's independent HTTP/WebSocket service in `server/`.
The server generates room codes, session capabilities, faction assignment and
the shared match seed. Passwords are sent only to the configured HTTPS endpoint
and stored in memory as salted scrypt verifiers. The host controls GDI and the
joining player controls Nod; build, placement, stance, stop, rally, and
movement/attack commands are validated, sequenced and relayed.

For local development, the client automatically uses `http://localhost:8787`.
For a deployed frontend, set the public build variable before building:

```bash
VITE_MULTIPLAYER_SERVER_URL=https://your-verdium-server.onrender.com npm run build
```

Set the server's `ALLOWED_ORIGINS` to a comma-separated list of exact frontend
origins. A Render Blueprint is included in `render.yaml`; after creating that
service, set `VITE_MULTIPLAYER_SERVER_URL` in Vercel and redeploy the frontend.
See `docs/MULTIPLAYER.md` for the protocol, security model and MVP limitations.

Query parameters: `?quality=low|medium|high|ultra` forces a quality tier,
`?dpr=1` pins device pixel ratio, `?day=<minutes>` starts the day/night clock
(frozen by default so screenshots stay comparable), `?tod=0..1` sets time of day
directly, `?harness=1` exposes the visual automation surface, and
`?agent=1&render=none` starts the simulation-only agent runtime without
constructing a WebGL renderer. `?headless=1` is an equivalent shorthand.

## Renderer-independent agent control

Agent runs expose `window.VS_AGENT` as a stable control-plane API. The bridge is
marked during startup before WebGL is touched, so an agent can distinguish
"still booting" from "renderer unavailable". In headless mode the same
simulation and command validation run with Three.js scene objects only; no
canvas, GPU context, shader compilation, terrain renderer, or audio is needed.

```js
const agent = window.VS_AGENT;
agent.capabilities();
await agent.createRoom('eight-byte-passphrase');
agent.roomStatus();
agent.launchRoom();
agent.observe();
agent.command('request-1', { type: 'move', ref: 65537, x: 24, z: -12 });
await agent.waitFor({ types: ['command_accepted'], timeoutMs: 15000 });
```

`createRoom`, `joinRoom`, `spectateRoom`, `launchRoom`, `observe`, `command`,
`events`, and `waitFor` all use the supported simulation/control interfaces;
they do not expose the engine, renderer, entity stores, or arbitrary evaluation.
The browser smoke test deliberately disables WebGL when run through
`agent:smoke:headless`.

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
`AGENT_FRIENDLY_PLAN.md`, `FULL_PLAYABILITY_IMPLEMENTATION_PROPOSAL.md`,
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
