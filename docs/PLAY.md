# Verdium Storm — Play Guide & Unit/Building Reference

This document summarizes controls, UI and the in-game units/buildings. The numbers below are taken directly from the inlined game definitions for quick reference.

## Controls (full)
- LMB (left mouse) / Drag — select units (click to select one; drag to box-select). Shift to add to selection.
- RMB (right mouse) — issue orders:
  - RMB on ground: move (auto-engage nearby enemies)
  - RMB on enemy: attack
  - RMB on verdium crystal: send harvester(s)
  - RMB while selecting a building that accepts rally points: set rally point
- WASD / Arrow keys — pan camera
- Q / E or MMB-drag — rotate camera
- Mouse wheel — zoom camera in/out
- Ctrl+1–5 — set control group; 1–5 — recall control group
- H — help overlay
- P — pause/unpause
- M — mute/unmute
- Esc — cancel placement / deselect

UI buttons:
- Sound toggle
- Help
- Pause
- Buildings & Units tabs (sidebar)
- Build / queue buttons inside the sidebar

---

## Objective
Establish a base in the southern plateau, harvest verdium crystals to fund production, expand your base, and destroy enemy structures. Manage your power grid — not enough power will slow production and disable turrets.

---

## Buildings (BLD)
Each building entry: name — cost — hp — cells (footprint) — power effect — brief note

- Construction Yard (cy) — cost: 0 — hp: 1600 — cells: [3,3] — power: +30  
  Base hub. Provides power; starting structure.

- Power Plant (power) — cost: 300 — hp: 450 — cells: [2,2] — power: +90  
  Adds +90 power to the grid.

- Barracks (barracks) — cost: 500 — hp: 650 — cells: [2,2] — power: -20  
  Trains infantry units (rifle, rocket).

- War Factory (factory) — cost: 1200 — hp: 950 — cells: [3,2] — power: -30  
  Builds vehicles (tank, harvester).

- Refinery (refinery) — cost: 800 — hp: 850 — cells: [3,2] — power: -30  
  Processes verdium; first one includes a free harvester.

- Cannon Turret (turret) — cost: 600 — hp: 550 — cells: [1,1] — power: -15  
  Automated base defense. turret: range 30, dmg 34, rof 1.6, aoe 2.5

Note: Buildings take build time and must be placed on valid terrain and unoccupied grid cells.

---

## Units (UDEF)
Each unit entry: name — cost — hp — speed — range — damage — rate-of-fire — sight — build requirement — build time

- Rifleman (rifle) — cost: 100 — hp: 60 — speed: 7.6 — range: 16 — dmg: 7 — rof: 0.45 — sight: 22 — needs: barracks — time: 2.5 sec  
  Basic infantry; effective versus infantry. icon: RF

- Rocket Trooper (rocket) — cost: 200 — hp: 75 — speed: 6.2 — range: 22 — dmg: 24 — rof: 1.5 — sight: 24 — needs: barracks — time: 3.5 sec  
  Area effect (aoe: 3). Strong vs vehicles/structures. icon: RK

- Battle Tank (tank) — cost: 700 — hp: 240 — speed: 9.2 — range: 20 — dmg: 32 — rof: 1.8 — sight: 26 — needs: factory — time: 7 sec  
  Vehicle unit with high HP and damage; aoe: 2.5. icon: TK

- Harvester (harvester) — cost: 900 — hp: 340 — speed: 7.4 — range: 0 — dmg: 0 — rof: 1 — sight: 20 — needs: refinery — time: 9 sec  
  Harvests verdium crystals; first refinery provides a free harvester. icon: HV

---

## Resources & Economy
- Verdium crystals exist in `FIELDS` (map locations). Each field has a finite amount (code sets `f.amount = 1400`).
- Harvesters collect from fields and bring resources to refineries (automated in code).
- Player starts with $4000 credits (see topbar UI).
- Power: buildings provide or use power. `recalcPower()` computes `player.power.made` and `.used`. Low power reduces production and disables turrets.

---

## Tactics / Tips
- Build a power plant early to avoid slowdowns once you add turrets/factories.
- Place refineries close to fields to minimize harvester travel time.
- Use rocket troopers against clusters or tanks (they have AOE), but tanks are good at soaking damage.
- Use control groups for fast unit management (Ctrl+1–5 to set, press 1–5 to recall).
- Use rally points to keep produced units moving to forward positions.

---

## Known quirks
- The demo is single-file and optimized for compactness; editing the file is the main way to tweak unit stats or behavior.
- Fog-of-war and exploration use a 2D canvas alpha map; revealing is tied to unit sight radii.
