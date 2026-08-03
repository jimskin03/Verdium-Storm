# Visual Review Rubric

This is the standard every screenshot is judged against. It exists so reviews
are consistent and hard, not vibes.

## How to review

1. Run the harness, then open the PNGs with the Read tool and **look at them**.
2. Score each axis below 0–10. Write the score, then one sentence of evidence
   naming what in the image drove it. "Looks good" is not evidence; "the tank's
   lower hull has no contact shadow so it reads as floating" is.
3. Report the three worst axes with concrete, actionable fixes.
4. **Overall = the lowest axis score, not the average.** One broken axis ruins
   a frame. A scene with gorgeous terrain and floating units is a failing scene.

## The reference

The bar is a modern AAA RTS in the Command & Conquer lineage — C&C 3: Tiberium
Wars, Kane's Wrath, and the 2020 Remastered Collection's 3D presentation. What
those actually look like, concretely:

- **Readability first.** Units are instantly identifiable by silhouette at
  normal play zoom. Team colour is unmistakable but occupies a small fraction of
  the model — panels, stripes, insignia, running lights, not whole-body tint.
- **Warm, high-contrast, saturated grade.** Strong directional key light, deep
  but coloured shadows, visible bounce light. Never flat, never grey-on-grey.
- **Dense ground.** The terrain is never bare. Texture detail, scattered debris,
  vegetation, tread marks, scorch, decals. You cannot find an untextured patch.
- **Heavy, grounded machines.** Vehicles sit *in* the terrain with contact
  shadow and occlusion at the tracks. They kick dust. They have visible mass:
  suspension travel, recoil, a settle after stopping.
- **Loud, layered combat VFX.** Muzzle flash with light emission, tracers,
  impact sparks, dust puffs, multi-stage explosions (flash → fireball → smoke →
  debris → lingering column), shockwave rings, screen shake.
- **A diegetic, dense HUD.** Angular, high-contrast, heavily styled sidebar,
  crisp iconography, no browser-default look anywhere.

## Axes

**1. Silhouette & readability** — Is every object identifiable by shape alone?
Do units separate from terrain? Is anything a mushy blob at play zoom?

**2. Material response** — Distinct roughness/metalness per surface. Metal
reflecting sky, dirt not. Any surface that reads as untextured plastic fails
this axis outright.

**3. Micro-detail** — Panel lines, bevels, edge wear, surface grain, greebles.
Look at any flat face: does it have detail, or is it a solid fill?

**4. Grounding** — Contact shadows and AO where objects meet ground. Nothing
floating, nothing intersecting wrongly. Dust/debris at the base. This axis
catches more amateur work than any other.

**5. Lighting** — Directional key with real shadow shape. Coloured, not black,
shadows. Ambient that comes from the sky rather than a flat fill. Visible bounce.

**6. Atmosphere & depth** — Aerial perspective desaturating distance. Fog with
structure, not a uniform wash. Does the scene feel large?

**7. Colour grade** — A deliberate palette with real tonal range. Highlights
that roll off, shadows with colour. Not neutral, not muddy, not crushed.

**8. Anti-aliasing & image quality** — Crawling edges, shimmer, ringing,
over-sharpening, banding in gradients. Zoom into a silhouette edge and a sky
gradient specifically.

**9. Scene density** — Is the frame populated? Empty ground and empty sky read
as unfinished regardless of how good the shading is.

**10. VFX quality** — Multi-stage, light-emitting, physically motivated. Not
billboard puffs. Not a single sprite scaled up.

**11. Motion quality** — Nothing snaps or moves linearly. Recoil, suspension,
turret lead and settle, tread scroll, banking. (Judge from an animated capture
or from the code if a still cannot show it.)

**12. UI/HUD craft** — Custom, dense, styled, aligned to a grid. Real typographic
hierarchy. Any browser-default control, default font, or untreated rectangle
fails this axis.

## Scoring bands

- **0–3** Broken or absent. Obviously a tech demo.
- **4–5** Works, clearly hobby-grade. The common landing spot for "it renders".
- **6–7** Competent indie. Real effort visible, still would not ship at AAA.
- **8** Genuinely good. Would pass in a mid-budget commercial game.
- **9** Indistinguishable from the reference in a blind comparison.
- **10** Better than the reference.

**Target: every axis at 8+, no exceptions.**

## Reviewer stance

Be harsh. The failure mode of this process is a reviewer who is impressed that
it works at all and gives 7s to a 4. Your job is the opposite: find the tell
that gives it away as a browser demo, and name it precisely.

If you would not be surprised to learn a frame came from a shipped AAA game,
say so and say why. If you would, say exactly what gave it away.
