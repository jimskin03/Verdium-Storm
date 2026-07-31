# HUD / UI

Everything the player sees that is not the 3D frame. Owned by the UI stream:
`src/ui/**`, `tools/shoot-ui.mjs`, this document.

## Entry point

`src/ui/Hud.ts` exports the `Hud` system (phase `PRESENT`). `main.ts` loads it
through `loadOptionalSystems()`, so a throw in here disables the interface and
nothing else. It mounts into `#ui-root` and owns a single `.vs-hud` element;
disposing the system removes the whole tree.

## Data contract

The HUD reads and commands the simulation exclusively through
`GameStateService` (`src/game/GameState.ts`). It never imports a simulation
class.

- `tryGet('game')` at init. If the service is missing, `MockGame` stands in and
  `whenReady('game')` swaps the real one in the moment it registers.
- The camera rig is reached through `window.VS.rig` (the harness surface), never
  by import, and only through its public `setPose`. Nothing in `src/game` is
  modified.
- `WorldProbe` (`src/ui/WorldProbe.ts`) is the one duck-typed extension:
  `GameStateService` carries no per-entity transforms, so floating health bars
  would be impossible from the contract alone. `simProbe()` recognises the
  simulation's entity stores structurally and reads them read-only; when the
  shape is not recognised the in-world layer simply does not draw.

## Layout

| Region | Class | Contents |
| --- | --- | --- |
| Command bar (right) | `.vs-sidebar` | faction plate, tactical map, resources, production tabs, build grid, active order |
| Status strip (top) | `.vs-top` | faction mark, mission clock, forces vs cap, kills, losses, pause/menu |
| Event feed | `.vs-alerts` | newest first, click to jump, right-click to dismiss |
| Selection (bottom left) | `.vs-sel` | portrait, name, integrity/cargo/construction meters, squad chips |
| In-world | `.vs-world` | floating health bars, selection reticles |
| Front end | `.vs-menu` | wordmark, faction select, deployment sequence |
| Pause | `.vs-pause` | resume / main menu |

## Why it does not look like a web page

- **No system font.** `src/ui/Typeface.ts` draws a condensed military grotesque
  in code and compiles it to a TrueType binary at runtime, registered through
  the `FontFace` API. It is caps-only, so *every* string the HUD renders is
  upper-cased before it is written — mixed case would fall through to the
  fallback stack per character.
- **No untreated rectangles.** Every panel is a `.vs-plate`: an angular clip
  path, a hairline frame drawn as a separate stacked pseudo-element (a CSS
  border cannot follow a clip path), a gradient fill, procedural grain and an
  inner bevel.
- **No browser controls.** Buttons, tabs, scrollbars, meters and toggles are all
  divs. The build grid's scrollbar is hidden and replaced by `.vs-rail`.
- **No downloaded art.** Build cameos, glyphs, crests, grain and brushed-metal
  tiles are generated in `src/ui/Icons.ts` as miniature axonometric renders
  sharing one projection, one light vector and one edge treatment, so the whole
  icon set reads as one family.

## Update budget

`Hud.update` splits work by how fast it has to move:

- **Every frame** — the world layer (health bars track units) and the minimap
  call (which throttles itself internally).
- **30 Hz, or immediately on a `subscribe()` signal** — sidebar, status strip,
  alert feed, selection panel. These ask the simulation to rebuild option lists,
  which is the expensive part.
- **Once** — the minimap's terrain layer is hillshaded from `heightAt()` into an
  offscreen canvas and blitted thereafter. Fog, blips and the camera frustum are
  the only things redrawn on the composite.

All DOM writes go through the diffing helpers in `src/ui/dom.ts`
(`setText`, `setClass`, `setVar`), so an unchanged panel costs no layout.

## Screenshots

The main harness (`tools/shoot.mjs`) reads the WebGL buffer directly and
therefore never shows the HUD. Use the compositing harness instead:

```bash
npx vite build --outDir dist-ui
node tools/shoot-ui.mjs                       # hud over base/battle/overview + menu + pause
node tools/shoot-ui.mjs --shots battle --scenes hud --label pass3
```

It freezes the render loop (`window.VS.freeze()`) before every
`page.screenshot()` — under software rasterisation a composited capture of a
live loop takes minutes — and disables fog of war so the world behind the HUD is
visible. `window.VSHUD` (`phase`, `menu`, `deploy`, `setPaused`, `setFaction`,
`sync`, `usingMock`) drives the interface states.

`report.json` records `faulted`, which must be empty, and `usingMock`, which
must be `false` whenever the simulation is present.

## Known gaps

- Selection reticles are drawn in DOM only when the simulation does not project
  its own ground rings. With the real simulation the rings win, because they
  follow the terrain and occlude correctly.
- Health-bar heights are measured from the first rig seen per entity type. A
  type whose rig is much taller than its first instance would sit slightly low.
- The front end's option toggles cover only what the HUD can genuinely change
  (tactical overlay, fog of war). No decorative settings that do nothing.
