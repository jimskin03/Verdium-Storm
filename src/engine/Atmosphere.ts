import * as THREE from 'three';
import { Phase, type EngineContext, type System } from './System';
import { provide, type EnvironmentService } from './Services';

/**
 * BASELINE atmosphere — gradient sky dome, sun + fill lights and distance fog.
 * The production system (physical scattering, aerial perspective, volumetric
 * clouds and god rays) replaces this while keeping the same service contract.
 */
export class Atmosphere implements System, EnvironmentService {
  readonly name = 'atmosphere';
  readonly phase = Phase.ENVIRONMENT;

  readonly sunDirection = new THREE.Vector3(0.42, 0.62, 0.35).normalize();
  readonly sunColor = new THREE.Color(0xffe6c2);
  readonly horizonColor = new THREE.Color(0x9fb6c4);
  sunIntensity = 3.1;
  timeOfDay = 0.34;

  sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private skyMesh!: THREE.Mesh;

  init(ctx: EngineContext): void {
    const { scene, quality } = ctx;

    this.sun = new THREE.DirectionalLight(this.sunColor, this.sunIntensity);
    this.sun.position.copy(this.sunDirection).multiplyScalar(900);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 2200;
    const extent = 480;
    this.sun.shadow.camera.left = -extent;
    this.sun.shadow.camera.right = extent;
    this.sun.shadow.camera.top = extent;
    this.sun.shadow.camera.bottom = -extent;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.9;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd6ea, 0x40402e, 0.85);
    scene.add(this.hemi);

    const skyGeo = new THREE.SphereGeometry(3000, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x2f6ea8) },
        uHorizon: { value: this.horizonColor },
        uBottom: { value: new THREE.Color(0x1d2a2c) },
        uSunDir: { value: this.sunDirection },
        uSunColor: { value: this.sunColor },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uHorizon, uBottom, uSunDir, uSunColor;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
          col = mix(uBottom, col, smoothstep(-0.25, 0.02, h));
          float sun = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunColor * pow(sun, 900.0) * 24.0;
          col += uSunColor * pow(sun, 6.0) * 0.16;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.frustumCulled = false;
    scene.add(this.skyMesh);

    scene.fog = new THREE.FogExp2(0x93a9b8, 0.00075);

    provide('environment', this);
  }

  update(): void {
    this.skyMesh.position.set(0, 0, 0);
  }

  dispose(): void {
    this.skyMesh?.geometry.dispose();
    (this.skyMesh?.material as THREE.Material)?.dispose();
  }
}
