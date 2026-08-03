import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { tryGet } from '@/engine/Services';
import { HALF_WORLD, heightAt } from '@/world/Heightfield';
import { clamp } from '@/util/Noise';

export interface CameraPose {
  /** Ground point the camera orbits. */
  target: THREE.Vector3;
  /** Orbit distance in world units. */
  distance: number;
  /** Compass rotation in radians. */
  yaw: number;
  /** Elevation in radians; 0 = horizon, PI/2 = straight down. */
  pitch: number;
}

const MIN_DISTANCE = 28;
const MAX_DISTANCE = 420;
const MIN_PITCH = 0.22;
const MAX_PITCH = 1.35;

/**
 * Classic RTS camera: an orbit rig over a ground-locked focus point with edge
 * scroll, drag pan, wheel zoom and middle-drag rotation. Motion is critically
 * damped so screenshots and gameplay both read as smooth.
 */
export class CameraRig implements System {
  readonly name = 'cameraRig';
  readonly phase = Phase.INPUT;

  readonly target = new THREE.Vector3(-180, 0, -180);
  distance = 190;
  yaw = Math.PI * 0.25;
  pitch = 0.72;

  /** Smoothed values actually applied to the camera. */
  private smoothTarget = new THREE.Vector3();
  private smoothDistance = 190;
  private smoothYaw = Math.PI * 0.25;
  private smoothPitch = 0.72;

  /** Set true by the harness so poses snap instead of easing. */
  instant = false;
  edgeScrollEnabled = true;
  inputEnabled = true;
  /** Scales both keyboard and edge-scroll pan speed. Settings-panel controlled. */
  panSpeedMultiplier = 1;

  private camera!: THREE.PerspectiveCamera;
  private dom!: HTMLElement;
  private keys = new Set<string>();
  private pointerX = -1;
  private pointerY = -1;
  private rotating = false;
  private panning = false;
  private lastPointer = new THREE.Vector2();
  private shakeAmount = 0;
  private shakeTime = 0;

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.dom = ctx.viewport;
    this.smoothTarget.copy(this.target);
    this.smoothDistance = this.distance;
    this.smoothYaw = this.yaw;
    this.smoothPitch = this.pitch;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    // Captured on window, not bound to `dom`: the HUD's top bar and sidebar
    // sit in front of the viewport with `pointer-events: auto` so their own
    // controls work, which means a listener on `dom` alone stops receiving
    // pointermove the instant the cursor crosses onto one of those panels —
    // including the strip along the very top of the screen. Capture fires
    // during the top-down phase, before the HUD's own bubble-phase handlers
    // (and their `stopPropagation`) ever run, so pointer tracking for edge
    // scroll keeps working right up to the physical screen edge.
    window.addEventListener('pointermove', this.onPointerMove, true);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this.apply();
  }

  /** Impulse used by nearby explosions. */
  shake(amount: number): void {
    this.shakeAmount = Math.min(this.shakeAmount + amount, 3.2);
  }

  setPose(pose: Partial<CameraPose>, instant = false): void {
    if (pose.target) this.target.copy(pose.target);
    if (pose.distance !== undefined) this.distance = clamp(pose.distance, MIN_DISTANCE, MAX_DISTANCE);
    if (pose.yaw !== undefined) this.yaw = pose.yaw;
    if (pose.pitch !== undefined) this.pitch = clamp(pose.pitch, MIN_PITCH, MAX_PITCH);
    if (instant) {
      this.smoothTarget.copy(this.target);
      this.smoothDistance = this.distance;
      this.smoothYaw = this.yaw;
      this.smoothPitch = this.pitch;
      this.apply();
    }
  }

  focusOn(point: THREE.Vector3): void {
    this.target.set(point.x, 0, point.z);
  }

  update(dt: number, elapsed: number): void {
    if (this.inputEnabled) {
      this.handleKeyboard(dt);
      this.handleEdgeScroll(dt);
    }
    this.clampTarget();

    const k = this.instant ? 1 : 1 - Math.exp(-dt * 13);
    this.smoothTarget.lerp(this.target, k);
    this.smoothDistance += (this.distance - this.smoothDistance) * k;
    this.smoothYaw += (this.yaw - this.smoothYaw) * k;
    this.smoothPitch += (this.pitch - this.smoothPitch) * k;

    this.shakeAmount *= Math.exp(-dt * 3.4);
    this.shakeTime += dt;
    this.apply(elapsed);
  }

  private apply(elapsed = 0): void {
    const cosP = Math.cos(this.smoothPitch);
    const sinP = Math.sin(this.smoothPitch);
    const groundY = heightAt(this.smoothTarget.x, this.smoothTarget.z);
    const focus = new THREE.Vector3(this.smoothTarget.x, groundY, this.smoothTarget.z);

    const offset = new THREE.Vector3(
      Math.sin(this.smoothYaw) * cosP,
      sinP,
      Math.cos(this.smoothYaw) * cosP,
    ).multiplyScalar(this.smoothDistance);

    this.camera.position.copy(focus).add(offset);

    if (this.shakeAmount > 0.001) {
      const t = this.shakeTime * 32;
      const a = this.shakeAmount;
      this.camera.position.x += Math.sin(t * 1.7) * a * 0.5;
      this.camera.position.y += Math.sin(t * 2.3) * a * 0.4;
      this.camera.position.z += Math.cos(t * 1.9) * a * 0.5;
    }

    // Keep the camera from clipping through hills between it and the focus.
    const ground = heightAt(this.camera.position.x, this.camera.position.z) + 6;
    if (this.camera.position.y < ground) this.camera.position.y = ground;

    this.camera.lookAt(focus);
    // Near/far tuned to the current orbit so depth precision stays tight.
    this.camera.near = Math.max(0.6, this.smoothDistance * 0.02);
    this.camera.far = 5200;
    this.camera.updateProjectionMatrix();
  }

  private handleKeyboard(dt: number): void {
    const speed = this.smoothDistance * 1.15 * dt * this.panSpeedMultiplier;
    let fx = 0;
    let fz = 0;
    // `panBy`'s `forward` axis is positive toward where the camera looks — the
    // top of the screen, in this rig's oblique framing — so "up"/W has to pass
    // +1 to advance that way. It used to pass -1, which drove the camera
    // backward: pressing W panned toward the bottom of the screen instead.
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fz -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) fx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) fx += 1;
    if (fx || fz) this.panBy(fx * speed, fz * speed);
    if (this.keys.has('KeyQ')) this.yaw -= dt * 1.4;
    if (this.keys.has('KeyE')) this.yaw += dt * 1.4;
  }

  private handleEdgeScroll(dt: number): void {
    if (!this.edgeScrollEnabled || this.pointerX < 0) return;
    const w = this.dom.clientWidth;
    const h = this.dom.clientHeight;
    const margin = 12;
    const speed = this.smoothDistance * 1.4 * dt * this.panSpeedMultiplier;
    let fx = 0;
    let fz = 0;
    if (this.pointerX < margin) fx -= 1;
    else if (this.pointerX > w - margin) fx += 1;
    // Same sign convention as the keyboard: the top edge has to pass +1 to
    // pan toward what's ahead (see the note in handleKeyboard).
    if (this.pointerY < margin) fz += 1;
    else if (this.pointerY > h - margin) fz -= 1;
    if (fx || fz) this.panBy(fx * speed, fz * speed);
  }

  private panBy(right: number, forward: number): void {
    const sin = Math.sin(this.smoothYaw);
    const cos = Math.cos(this.smoothYaw);
    this.target.x += right * cos - forward * sin;
    this.target.z += -right * sin - forward * cos;
  }

  private clampTarget(): void {
    const limit = HALF_WORLD - 60;
    this.target.x = clamp(this.target.x, -limit, limit);
    this.target.z = clamp(this.target.z, -limit, limit);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.inputEnabled) return;
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    if (!this.inputEnabled) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer.set(e.clientX, e.clientY);
    if (this.rotating) {
      this.yaw -= dx * 0.006;
      this.pitch = clamp(this.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
    } else if (this.panning) {
      const scale = this.smoothDistance * 0.0022;
      this.panBy(-dx * scale, -dy * scale);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.lastPointer.set(e.clientX, e.clientY);
    if (!this.inputEnabled) return;
    if (e.button === 1) {
      this.rotating = true;
      e.preventDefault();
    } else if (e.button === 2 && e.shiftKey) {
      this.panning = true;
    }
  };

  private onPointerUp = (): void => {
    this.rotating = false;
    this.panning = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.inputEnabled) return;
    e.preventDefault();
    const factor = Math.exp(Math.sign(e.deltaY) * 0.16);
    this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
    // Zooming in tilts toward a lower, more cinematic angle.
    const t = (this.distance - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE);
    this.pitch = clamp(THREE.MathUtils.lerp(0.5, 1.02, t), MIN_PITCH, MAX_PITCH);
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove, true);
  }
}
