import * as THREE from 'three';
import { makeRng } from '@/util/Noise';
import { GeoBuilder, addCard, addTube } from './GeoBuilder';
import type { LeafAtlas } from './Textures';

/**
 * The small stuff: bushes, ferns, weed tufts and fallen branches.
 *
 * Its job is to make sure nothing in the world sits on bare ground. Scattered
 * at the base of trees and rocks and along the moist ground near the river, it
 * is what removes the "objects dropped onto a texture" look.
 */

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _soft = new THREE.Vector3();
const _pos = new THREE.Vector3();

/** Leafy bush: a dome of overlapping cards over a few visible twigs. */
export function buildBush(atlas: LeafAtlas, seed: number, cardCount = 14): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const b = new GeoBuilder();
  const color = new THREE.Color();
  const height = 1.55 + rng() * 0.7;
  const radius = 1.05 + rng() * 0.55;

  const twigColor = new THREE.Color(0.16, 0.13, 0.08);
  for (let i = 0; i < 4; i++) {
    const a = rng() * Math.PI * 2;
    const pts = [
      new THREE.Vector3(0, -0.15, 0),
      new THREE.Vector3(Math.cos(a) * radius * 0.25, height * 0.4, Math.sin(a) * radius * 0.25),
      new THREE.Vector3(Math.cos(a) * radius * 0.6, height * 0.85, Math.sin(a) * radius * 0.6),
    ];
    addTube(
      b, pts, [0.055, 0.035, 0.015], 3,
      () => twigColor,
      (t) => t * 0.7,
      [1, 0.6],
      () => 0,
      false,
    );
  }

  for (let i = 0; i < cardCount; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.pow(rng(), 0.55);
    _pos.set(Math.cos(a) * radius * rr, height * (0.24 + rng() * 0.72), Math.sin(a) * radius * rr);
    _soft.copy(_pos).normalize();
    _soft.y = Math.abs(_soft.y) * 0.6 + 0.45;
    _soft.normalize();
    _up.set(rng() - 0.5, 1.1, rng() - 0.5).normalize();
    _right.crossVectors(_up, _soft).normalize();
    _up.crossVectors(_soft, _right).normalize();
    const shade = 0.5 + 0.5 * (_pos.y / height);
    color.setRGB(0.42 * shade, 0.56 * shade, 0.26 * shade);
    const s = 0.5 + rng() * 0.38;
    addCard(b, _pos, _right, _up, s, s * 0.9, atlas.bush[0], color, 0.35 + 0.65 * (_pos.y / height), _soft, 0.7);
  }
  return b.build('bush');
}

/** Fern: fronds fanning out of a single crown. */
export function buildFern(atlas: LeafAtlas, seed: number, fronds = 8): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const b = new GeoBuilder();
  const color = new THREE.Color();

  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rng() * 0.5;
    const lean = 0.5 + rng() * 0.5;
    const len = 0.85 + rng() * 0.55;
    _soft.set(Math.cos(a) * lean, 1.0, Math.sin(a) * lean).normalize();
    _pos.set(_soft.x * len * 0.55, _soft.y * len * 0.62, _soft.z * len * 0.55);
    _up.copy(_soft);
    _right.set(-Math.sin(a), 0, Math.cos(a)).normalize();
    _soft.set(_soft.x * 0.4, 0.9, _soft.z * 0.4).normalize();
    const shade = 0.72 + rng() * 0.45;
    color.setRGB(0.3 * shade, 0.47 * shade, 0.19 * shade);
    addCard(
      b, _pos, _right, _up, len * 0.34, len * 0.72,
      atlas.fern[(rng() * atlas.fern.length) | 0],
      color, 0.85, _soft, 0.6,
    );
  }
  return b.build('fern');
}

/** Weed tuft: three crossed cards, the cheapest way to break up bare soil. */
export function buildTuft(atlas: LeafAtlas, seed: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const b = new GeoBuilder();
  const color = new THREE.Color();
  const h = 0.62 + rng() * 0.4;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI + rng() * 0.4;
    _right.set(Math.cos(a), 0, Math.sin(a));
    _up.set(0, 1, 0);
    _soft.set(Math.sin(a) * 0.3, 0.94, -Math.cos(a) * 0.3).normalize();
    _pos.set(0, h * 0.5, 0);
    const shade = 0.78 + rng() * 0.4;
    color.setRGB(0.44 * shade, 0.46 * shade, 0.2 * shade);
    addCard(
      b, _pos, _right, _up, h * 0.62, h * 0.5,
      atlas.tuft[(rng() * atlas.tuft.length) | 0],
      color, 0.9, _soft, 0.55,
    );
  }
  return b.build('tuft');
}

/** Fallen deadwood; no wind, and it lies flat so it beds into the ground. */
export function buildDeadBranch(seed: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const b = new GeoBuilder();
  const wood = new THREE.Color(0.2, 0.16, 0.11);
  const woodLit = new THREE.Color(0.34, 0.29, 0.21);
  const scratch = new THREE.Color();

  const main: THREE.Vector3[] = [];
  const len = 2.0 + rng() * 1.8;
  let a = rng() * Math.PI * 2;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    a += (rng() - 0.5) * 0.5;
    main.push(new THREE.Vector3(Math.cos(a) * len * t, 0.09 + Math.sin(t * 3.1) * 0.05, Math.sin(a) * len * t));
  }
  const colorOf = (t: number, _ang: number, ridge: number): THREE.Color =>
    scratch.copy(wood).lerp(woodLit, Math.min(1, 0.4 + ridge * 4 + t * 0.2));
  addTube(b, main, [0.13, 0.11, 0.09, 0.06, 0.03], 4, colorOf, () => 0, [1, 0.5],
    (t, ang) => Math.sin(ang * 4 + t * 7) * 0.08, true);

  for (let i = 0; i < 2 + ((rng() * 2) | 0); i++) {
    const t = 0.25 + rng() * 0.6;
    const anchor = main[Math.round(t * (main.length - 1))].clone();
    const ba = a + (rng() - 0.5) * 2.4;
    const bl = 0.5 + rng() * 0.9;
    const pts = [anchor, anchor.clone().add(new THREE.Vector3(Math.cos(ba) * bl, 0.02, Math.sin(ba) * bl))];
    addTube(b, pts, [0.055, 0.02], 3, colorOf, () => 0, [1, 0.5], () => 0, true);
  }
  return b.build('deadbranch');
}
