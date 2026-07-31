import * as THREE from 'three';
import { tryGet } from '@/engine/Services';
import type { EngineContext } from '@/engine/System';
import { HALF_WORLD, RESOURCE_FIELDS, heightAt, raycastHeightfield } from '@/world/Heightfield';
import { TEAM_COLORS } from '@/entities/Types';
import type { BuildableId, SelectionSummary } from '@/game/GameState';
import {
  BUILDING_ID,
  BUILDING_LIST,
  UNIT_ID,
  UNIT_LIST,
  isBuildingType,
  isUnitType,
} from './Stats';
import { KIND_BUILDING, KIND_UNIT, NO_REF, Order, Stance, refKind, refSlot } from './Entities';
import { NAV_CELL } from './Nav';
import type { Sim } from './Sim';

/**
 * Player input: selection, control groups, contextual orders, waypoints,
 * stances, rally points and structure placement.
 *
 * Input is captured as *intent* on the DOM event and applied at the top of the
 * next simulation update, so a click never mutates entity state part-way
 * through a tick. That keeps the sim deterministic under the fixed-step
 * harness even while a human is playing.
 */

const DRAG_THRESHOLD = 6;

interface PendingClick {
  kind: 'select' | 'order' | 'place';
  /** Screen rectangle in CSS pixels for a marquee, or a point for a click. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

const tmpVec = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpHit = new THREE.Vector3();
const tmpProj = new THREE.Vector3();

export class PlayerController {
  /** Selected entity refs, units first. */
  private selected: number[] = [];
  private groups: number[][] = Array.from({ length: 10 }, () => []);

  /** Structure type awaiting a placement click; -1 when not placing. */
  placingType = -1;

  private pending: PendingClick[] = [];
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragX = 0;
  private dragY = 0;

  private dom!: HTMLElement;
  private camera!: THREE.PerspectiveCamera;
  private marquee!: HTMLDivElement;
  private ghost!: THREE.Mesh;
  private ghostGeo!: THREE.BufferGeometry;
  private ghostMat!: THREE.MeshBasicMaterial;

  /** Raised the first time the human commands anything. */
  onFirstCommand: (() => void) | null = null;
  private commanded = false;

  /** Scratch buffers for the selection ring pass; never reallocated. */
  private ringX = new Float32Array(96);
  private ringY = new Float32Array(96);
  private ringZ = new Float32Array(96);
  private ringR = new Float32Array(96);

  private summaries: SelectionSummary[] = [];
  /** Bumped whenever the selection changes, so the HUD can diff cheaply. */
  selectionVersion = 0;

  constructor(private sim: Sim, private team: number) {}

  init(ctx: EngineContext): void {
    this.dom = ctx.viewport;
    this.camera = ctx.camera;

    this.marquee = document.createElement('div');
    this.marquee.style.cssText = [
      'position:absolute', 'pointer-events:none', 'display:none', 'z-index:40',
      'border:1px solid rgba(120,220,255,0.9)', 'background:rgba(90,190,255,0.12)',
      'box-shadow:0 0 12px rgba(80,190,255,0.35) inset',
    ].join(';');
    ctx.uiRoot.appendChild(this.marquee);

    this.ghostGeo = new THREE.BoxGeometry(1, 1, 1);
    this.ghostMat = new THREE.MeshBasicMaterial({
      color: 0x6effa8, transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false,
    });
    this.ghost = new THREE.Mesh(this.ghostGeo, this.ghostMat);
    this.ghost.visible = false;
    this.ghost.renderOrder = 10;
    this.sim.entityRoot.add(this.ghost);

    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    this.dom?.removeEventListener('pointerdown', this.onPointerDown);
    this.dom?.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.marquee?.remove();
    this.ghost?.removeFromParent();
    this.ghostGeo?.dispose();
    this.ghostMat?.dispose();
  }

  /* ================================================================== *
   * DOM capture — records intent only
   * ================================================================== */

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 0) {
      this.dragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    const dx = Math.abs(this.dragX - this.dragStartX);
    const dy = Math.abs(this.dragY - this.dragStartY);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      const left = Math.min(this.dragStartX, this.dragX);
      const top = Math.min(this.dragStartY, this.dragY);
      this.marquee.style.display = 'block';
      this.marquee.style.left = `${left}px`;
      this.marquee.style.top = `${top}px`;
      this.marquee.style.width = `${dx}px`;
      this.marquee.style.height = `${dy}px`;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button === 0 && this.dragging) {
      this.dragging = false;
      this.marquee.style.display = 'none';
      this.pending.push({
        kind: this.placingType >= 0 ? 'place' : 'select',
        x0: this.dragStartX, y0: this.dragStartY, x1: e.clientX, y1: e.clientY,
        shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      });
    } else if (e.button === 2) {
      this.pending.push({
        kind: 'order',
        x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
        shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      });
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    if (code === 'Escape') {
      this.placingType = -1;
      this.ghost.visible = false;
      return;
    }
    if (code === 'KeyZ') return this.applyStance(Stance.Aggressive);
    if (code === 'KeyX') return this.applyStance(Stance.Guard);
    if (code === 'KeyC') return this.applyStance(Stance.HoldFire);
    if (code === 'KeyS') {
      // Stop: clear every queued order but keep the selection.
      for (const ref of this.selected) {
        if (refKind(ref) !== KIND_UNIT || !this.sim.units.valid(ref)) continue;
        const slot = refSlot(ref);
        this.sim.units.clearOrders(slot);
        this.sim.units.hasGoal[slot] = 0;
      }
      this.markCommanded();
      return;
    }
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) {
      const g = Number(digit[1]);
      if (e.ctrlKey || e.metaKey) {
        this.groups[g] = this.selected.slice();
      } else {
        this.selected = this.groups[g].filter((r) => this.sim.refValid(r));
        this.refreshSelection();
      }
    }
  };

  private applyStance(stance: number): void {
    for (const ref of this.selected) {
      if (refKind(ref) !== KIND_UNIT || !this.sim.units.valid(ref)) continue;
      this.sim.setStance(refSlot(ref), stance);
    }
    this.markCommanded();
  }

  private markCommanded(): void {
    if (this.commanded) return;
    this.commanded = true;
    this.onFirstCommand?.();
  }

  /* ================================================================== *
   * Application — runs at the top of the simulation update
   * ================================================================== */

  update(dt: number): void {
    for (let i = 0; i < this.pending.length; i++) this.apply(this.pending[i]);
    this.pending.length = 0;
    this.pruneSelection();
    this.updateGhost();
    this.drawRings();
    void dt;
  }

  private apply(cmd: PendingClick): void {
    if (cmd.kind === 'place') {
      if (!this.groundAt(cmd.x1, cmd.y1, tmpHit)) return;
      if (this.sim.placeReadyBuilding(this.team, tmpHit.x, tmpHit.z)) {
        this.placingType = -1;
        this.ghost.visible = false;
      }
      this.markCommanded();
      return;
    }

    if (cmd.kind === 'select') {
      const dx = Math.abs(cmd.x1 - cmd.x0);
      const dy = Math.abs(cmd.y1 - cmd.y0);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) this.boxSelect(cmd);
      else this.clickSelect(cmd);
      return;
    }

    this.issueContextOrder(cmd);
  }

  /* ---------------- selection ---------------- */

  private clickSelect(cmd: PendingClick): void {
    if (!this.groundAt(cmd.x1, cmd.y1, tmpHit)) return;
    const ref = this.pickEntity(tmpHit.x, tmpHit.z, true);
    if (ref === NO_REF) {
      if (!cmd.shift) {
        this.selected.length = 0;
        this.refreshSelection();
      }
      return;
    }
    if (cmd.shift) {
      const at = this.selected.indexOf(ref);
      if (at >= 0) this.selected.splice(at, 1);
      else this.selected.push(ref);
    } else if (cmd.alt) {
      // Alt-click selects every visible unit of the same type.
      this.selectAllOfRef(ref);
      return;
    } else {
      this.selected.length = 0;
      this.selected.push(ref);
    }
    this.refreshSelection();
  }

  private boxSelect(cmd: PendingClick): void {
    const rect = this.dom.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    const nx0 = ((Math.min(cmd.x0, cmd.x1) - rect.left) / w) * 2 - 1;
    const nx1 = ((Math.max(cmd.x0, cmd.x1) - rect.left) / w) * 2 - 1;
    const ny0 = -((Math.max(cmd.y0, cmd.y1) - rect.top) / h) * 2 + 1;
    const ny1 = -((Math.min(cmd.y0, cmd.y1) - rect.top) / h) * 2 + 1;

    if (!cmd.shift) this.selected.length = 0;
    const u = this.sim.units;
    u.refreshLive();
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (u.team[i] !== this.team || !u.visible[i]) continue;
      tmpProj.set(u.px[i], u.py[i] + 1.5, u.pz[i]).project(this.camera);
      if (tmpProj.z < -1 || tmpProj.z > 1) continue;
      if (tmpProj.x < nx0 || tmpProj.x > nx1 || tmpProj.y < ny0 || tmpProj.y > ny1) continue;
      const ref = u.ref(i);
      if (this.selected.indexOf(ref) < 0) this.selected.push(ref);
    }
    // A marquee that caught nothing but structures still selects one, so the
    // player can drag over a base and get its production panel.
    if (this.selected.length === 0) {
      const b = this.sim.buildings;
      b.refreshLive();
      for (let n = 0; n < b.liveCount; n++) {
        const i = b.live[n];
        if (b.team[i] !== this.team) continue;
        tmpProj.set(b.px[i], b.py[i] + 4, b.pz[i]).project(this.camera);
        if (tmpProj.x < nx0 || tmpProj.x > nx1 || tmpProj.y < ny0 || tmpProj.y > ny1) continue;
        this.selected.push(b.ref(i));
        break;
      }
    }
    this.refreshSelection();
  }

  private selectAllOfRef(ref: number): void {
    this.selected.length = 0;
    if (refKind(ref) === KIND_UNIT) {
      const type = this.sim.units.type[refSlot(ref)];
      const u = this.sim.units;
      for (let n = 0; n < u.liveCount; n++) {
        const i = u.live[n];
        if (u.team[i] === this.team && u.type[i] === type) this.selected.push(u.ref(i));
      }
    } else {
      this.selected.push(ref);
    }
    this.refreshSelection();
  }

  /** Service-facing bulk select used by the HUD. */
  selectAll(type?: BuildableId): void {
    this.selected.length = 0;
    if (type && isBuildingType(type)) {
      const b = this.sim.buildings;
      b.refreshLive();
      const id = BUILDING_ID[type];
      for (let n = 0; n < b.liveCount; n++) {
        const i = b.live[n];
        if (b.team[i] === this.team && b.type[i] === id) this.selected.push(b.ref(i));
      }
    } else {
      const u = this.sim.units;
      u.refreshLive();
      const id = type && isUnitType(type) ? UNIT_ID[type] : -1;
      for (let n = 0; n < u.liveCount; n++) {
        const i = u.live[n];
        if (u.team[i] !== this.team) continue;
        if (id >= 0 ? u.type[i] !== id : UNIT_LIST[u.type[i]].cargo) continue;
        this.selected.push(u.ref(i));
      }
    }
    this.refreshSelection();
  }

  private pruneSelection(): void {
    let changed = false;
    for (let i = this.selected.length - 1; i >= 0; i--) {
      if (!this.sim.refValid(this.selected[i])) {
        this.selected.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.refreshSelection();
  }

  private refreshSelection(): void {
    const u = this.sim.units;
    const b = this.sim.buildings;
    for (let i = 0; i < u.capacity; i++) u.selected[i] = 0;
    for (let i = 0; i < b.capacity; i++) b.selected[i] = 0;
    this.summaries.length = 0;
    for (const ref of this.selected) {
      if (!this.sim.refValid(ref)) continue;
      const slot = refSlot(ref);
      if (refKind(ref) === KIND_UNIT) {
        u.selected[slot] = 1;
        const stats = UNIT_LIST[u.type[slot]];
        const s: SelectionSummary = {
          id: ref, label: stats.label, kind: 'unit', type: stats.type,
          hp: Math.max(0, Math.round(u.hp[slot])), maxHp: u.maxHp[slot],
        };
        if (stats.cargo) {
          s.cargo = Math.round(u.cargo[slot]);
          s.cargoMax = stats.cargo;
        }
        this.summaries.push(s);
      } else {
        b.selected[slot] = 1;
        const stats = BUILDING_LIST[b.type[slot]];
        const s: SelectionSummary = {
          id: ref, label: stats.label, kind: 'building', type: stats.type,
          hp: Math.max(0, Math.round(b.hp[slot])), maxHp: b.maxHp[slot],
        };
        if (b.buildProgress[slot] < 1) s.buildProgress = b.buildProgress[slot];
        this.summaries.push(s);
      }
    }
    this.selectionVersion++;
  }

  selection(): SelectionSummary[] {
    return this.summaries;
  }

  hasSelection(): boolean {
    return this.selected.length > 0;
  }

  /* ---------------- orders ---------------- */

  private issueContextOrder(cmd: PendingClick): void {
    if (this.placingType >= 0) {
      this.placingType = -1;
      this.ghost.visible = false;
      return;
    }
    if (this.selected.length === 0) return;
    if (!this.groundAt(cmd.x1, cmd.y1, tmpHit)) return;
    const gx = tmpHit.x;
    const gz = tmpHit.z;
    const target = this.pickEntity(gx, gz, false);
    const targetTeam = target !== NO_REF ? this.sim.refTeam(target) : -1;
    const queued = cmd.shift;

    // A structure in the selection takes the click as a rally point.
    let sawBuilding = false;
    for (const ref of this.selected) {
      if (refKind(ref) !== KIND_BUILDING || !this.sim.buildings.valid(ref)) continue;
      const slot = refSlot(ref);
      this.sim.buildings.rallyX[slot] = gx;
      this.sim.buildings.rallyZ[slot] = gz;
      this.sim.buildings.hasRally[slot] = 1;
      sawBuilding = true;
    }

    const field = this.fieldAt(gx, gz);
    let ordered = false;
    for (const ref of this.selected) {
      if (refKind(ref) !== KIND_UNIT || !this.sim.units.valid(ref)) continue;
      const slot = refSlot(ref);
      const stats = UNIT_LIST[this.sim.units.type[slot]];
      let order: number = Order.Move;
      let orderRef = NO_REF;

      if (target !== NO_REF && targetTeam !== this.team) {
        order = Order.Attack;
        orderRef = target;
      } else if (stats.type === 'harvester' && field >= 0) {
        order = Order.Harvest;
      } else if (stats.type === 'engineer' && target !== NO_REF && refKind(target) === KIND_BUILDING) {
        order = targetTeam === this.team ? Order.Repair : Order.Capture;
        orderRef = target;
      } else if (cmd.ctrl) {
        order = Order.AttackMove;
      } else if (target !== NO_REF && targetTeam === this.team) {
        order = Order.Guard;
      }

      // Spread a group order across a formation so they do not stack on a point.
      const spread = this.formationOffset(ordered ? this.orderIndex++ : (this.orderIndex = 0));
      this.sim.issueOrder(slot, order, gx + spread[0], gz + spread[1], orderRef, queued);
      ordered = true;
    }
    if (ordered || sawBuilding) this.markCommanded();
  }

  private orderIndex = 0;
  private formation = new Float32Array(2);

  /** Hex-ish ring layout: index 0 is the click point, then rings around it. */
  private formationOffset(index: number): Float32Array {
    if (index <= 0) {
      this.formation[0] = 0;
      this.formation[1] = 0;
      return this.formation;
    }
    const ring = Math.ceil((Math.sqrt(12 * index + 1) - 1) / 6);
    const perRing = ring * 6;
    const first = 1 + 3 * ring * (ring - 1);
    const a = ((index - first) / perRing) * Math.PI * 2;
    const r = ring * 7.5;
    this.formation[0] = Math.cos(a) * r;
    this.formation[1] = Math.sin(a) * r;
    return this.formation;
  }

  /* ---------------- placement ---------------- */

  beginPlacement(typeId: number): void {
    this.placingType = typeId;
    const size = BUILDING_LIST[typeId].footprint * NAV_CELL;
    this.ghost.scale.set(size, Math.max(6, size * 0.55), size);
    this.ghost.visible = true;
    this.markCommanded();
  }

  private updateGhost(): void {
    if (this.placingType < 0) {
      this.ghost.visible = false;
      return;
    }
    if (!this.groundAt(this.dragX || this.pointerX, this.dragY || this.pointerY, tmpHit)) return;
    const ok = this.sim.canPlace(this.team, this.placingType, tmpHit.x, tmpHit.z);
    this.ghostMat.color.setHex(ok ? 0x6effa8 : 0xff5a4a);
    this.ghost.position.set(tmpHit.x, heightAt(tmpHit.x, tmpHit.z) + this.ghost.scale.y * 0.5, tmpHit.z);
    this.ghost.visible = true;
  }

  private pointerX = 0;
  private pointerY = 0;

  /* ---------------- picking ---------------- */

  /**
   * Ground point under a screen position. Prefers the terrain service's
   * raycast when the terrain stream has registered one, and falls back to the
   * shared heightfield march otherwise.
   */
  private groundAt(sx: number, sy: number, out: THREE.Vector3): boolean {
    const rect = this.dom.getBoundingClientRect();
    const nx = ((sx - rect.left) / (rect.width || 1)) * 2 - 1;
    const ny = -((sy - rect.top) / (rect.height || 1)) * 2 + 1;
    tmpVec.set(nx, ny, 0.5).unproject(this.camera);
    tmpDir.copy(tmpVec).sub(this.camera.position).normalize();
    const terrain = tryGet('terrain');
    const hit = terrain
      ? terrain.raycast(this.camera.position, tmpDir, out)
      : raycastHeightfield(this.camera.position, tmpDir, out);
    if (!hit) return false;
    if (Math.abs(out.x) > HALF_WORLD || Math.abs(out.z) > HALF_WORLD) return false;
    return true;
  }

  /** Nearest entity to a ground point, optionally restricted to our own team. */
  private pickEntity(x: number, z: number, ownOnly: boolean): number {
    const u = this.sim.units;
    u.refreshLive();
    let best = NO_REF;
    let bestD = Infinity;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (ownOnly && u.team[i] !== this.team) continue;
      if (!u.visible[i]) continue;
      const r = UNIT_LIST[u.type[i]].radius + 3.5;
      const d = (u.px[i] - x) ** 2 + (u.pz[i] - z) ** 2;
      if (d < r * r && d < bestD) {
        bestD = d;
        best = u.ref(i);
      }
    }
    if (best !== NO_REF) return best;

    const b = this.sim.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (ownOnly && b.team[i] !== this.team) continue;
      if (!b.visible[i]) continue;
      const half = (BUILDING_LIST[b.type[i]].footprint * NAV_CELL) / 2 + 2;
      if (Math.abs(b.px[i] - x) > half || Math.abs(b.pz[i] - z) > half) continue;
      const d = (b.px[i] - x) ** 2 + (b.pz[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b.ref(i);
      }
    }
    return best;
  }

  private fieldAt(x: number, z: number): number {
    for (let f = 0; f < RESOURCE_FIELDS.length; f++) {
      const field = RESOURCE_FIELDS[f];
      const r = field.radius + 12;
      if ((field.x - x) ** 2 + (field.z - z) ** 2 < r * r) return f;
    }
    return -1;
  }

  /* ---------------- presentation ---------------- */

  private drawRings(): void {
    const u = this.sim.units;
    const b = this.sim.buildings;
    let n = 0;
    const cap = this.ringX.length;
    for (const ref of this.selected) {
      if (n >= cap) break;
      if (!this.sim.refValid(ref)) continue;
      const slot = refSlot(ref);
      if (refKind(ref) === KIND_UNIT) {
        this.ringX[n] = u.px[slot];
        this.ringY[n] = u.py[slot];
        this.ringZ[n] = u.pz[slot];
        this.ringR[n] = UNIT_LIST[u.type[slot]].radius;
      } else {
        this.ringX[n] = b.px[slot];
        this.ringY[n] = b.py[slot];
        this.ringZ[n] = b.pz[slot];
        this.ringR[n] = (BUILDING_LIST[b.type[slot]].footprint * NAV_CELL) / 2.6;
      }
      n++;
    }
    this.sim.vfx.setSelectionRings(n, this.ringX, this.ringY, this.ringZ, this.ringR, this.team);
    void TEAM_COLORS;
  }
}
