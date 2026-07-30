# Verdium Storm

VERDIUM STORM is a single-file, browser-based real-time strategy (RTS) demo built with Three.js. It implements terrain, fog-of-war, base-building, resource harvesting, units, AI enemy waves, a power grid and an in-browser synthesized SFX system — all inside a self-contained HTML file: `Verdium Storm — Three.js RTS-kimik3.html`.

The project is intended for players, hobby game developers, and authors exploring realtime gameplay systems with WebGL/Three.js. It is a compact, playable example showing how to combine 3D rendering and game systems in one distributable HTML page.

## Quick links
- Play / demo file: `Verdium Storm — Three.js RTS-kimik3.html`
- Core code: inline JavaScript inside the HTML file (Three.js r128 via CDN)
- Docs: `docs/` (this repository)

## Highlights
- Beautiful procedural terrain with water, foliage and fields
- Fully implemented RTS systems: buildings, units, production queues, projectiles, explosions and particle FX
- Fog-of-war with exploration & visibility
- Synthesized in-browser audio using WebAudio (no external audio files)
- Single-file distribution (easy to host or drop on any static web server)

## How to run (minimum)
From a fresh clone, the simplest way to run the demo locally is to serve the repository with a static server and open the HTML file in a browser.

Example using Python 3 (works on macOS, Linux, Windows with Python installed):

```bash
# from the repository root
python3 -m http.server 8000
# then open http://localhost:8000/Verdium%20Storm%20%E2%80%94%20Three.js%20RTS-kimik3.html
```

Or open the HTML file directly in a modern browser. Note: some browsers restrict certain APIs for file:// pages (audio or resource loading). Running via a local HTTP server is recommended.

## Controls (short)
- LMB / Drag: select units (box select)
- RMB: move / attack / harvest
- WASD or Arrow keys: scroll camera
- Q / E or MMB-drag: rotate camera
- Mouse wheel: zoom
- H: help overlay
- P: pause
- M: mute
- Ctrl+1–5 to set control groups, 1–5 to recall

Full control list and gameplay tips are in docs/PLAY.md.

## Development
This project is intentionally distributed as one HTML file that contains the game logic. If you want to iterate locally:

- Edit `Verdium Storm — Three.js RTS-kimik3.html` directly.
- Use a local static server (see above) and refresh the page to see changes.
- The demo uses Three.js r128 from CDN: https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js

For notes on the code structure, systems and functions, see docs/ARCHITECTURE.md and docs/DEVELOPMENT.md.

## Contributing
If you'd like to contribute, see CONTRIBUTING.md for guidelines. Issue reports should include steps to reproduce, browser and GPU/driver details when relevant.

## Credits

Special thanks to @achimala (TheLongSilence) — original inspiration / contribution. https://github.com/achimala/TheLongSilence"

Author / repository owner: jimskin03
Three.js: https://threejs.org/ (CDN used)
All in-game audio is synthesized via the Web Audio API — there are no external SFX assets.

## License
No license file is included in the repository. If you want this project to be open-source under a specific license (MIT, Apache-2.0, etc.), add a LICENSE file or let us know and I can add one.
