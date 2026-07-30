import * as THREE from 'three';
import { FULLSCREEN_VERTEX } from './common';

/**
 * One screen-space shader invocation. Deliberately thinner than
 * `EffectComposer` — the stack owns its own render targets and routes them by
 * hand, so the composer's read/write buffer swapping would only get in the way.
 */
export class FullScreenPass {
  readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private static geometry: THREE.BufferGeometry | null = null;
  private static readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform>,
    defines: Record<string, string> = {},
  ) {
    if (!FullScreenPass.geometry) {
      // A single triangle that covers the viewport; clip-space coordinates are
      // written straight through, so no matrices are involved.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
      );
      FullScreenPass.geometry = geometry;
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      // The stack tone maps and encodes explicitly in its final pass; letting
      // three do it again on the way out would double-transform the image.
      toneMapped: false,
      blending: THREE.NoBlending,
    });

    this.mesh = new THREE.Mesh(FullScreenPass.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  /** Draws into `target`, or the default framebuffer when `target` is null. */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, FullScreenPass.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}
