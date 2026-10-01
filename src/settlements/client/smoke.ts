/**
 * Chimney / campfire smoke: a small pool of soft billboard particles emitted
 * from smoke anchors near the camera (rising, drifting with the wind,
 * expanding and fading). One draw call for all settlements.
 */
import * as THREE from 'three';

const MAX = 600;

export class SmokeSystem {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX).fill(1e9);
  private life = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private next = 0;
  private emitAcc = new Map<string, number>();

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: { ...THREE.UniformsLib.fog, uLight: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; varying float vA;
        #include <fog_pars_vertex>
        void main(){ vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aSize * 900.0 / max(1.0, -mvPosition.z); vA = aAlpha;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uLight; varying float vA;
        #include <fog_pars_fragment>
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d)*4.0; if (r > 1.0) discard;
          float a = (1.0 - r) * (1.0 - r) * vA; gl_FragColor = vec4(vec3(0.55, 0.54, 0.52) * uLight, a);
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** Emit from anchors (world positions with stable keys) and simulate. */
  update(dt: number, anchors: { key: string; x: number; y: number; z: number; rate: number }[], wind: { x: number; z: number }, light: number) {
    for (const a of anchors) {
      let acc = (this.emitAcc.get(a.key) ?? Math.random()) + dt * a.rate;
      while (acc >= 1) {
        acc -= 1;
        const i = this.next;
        this.next = (this.next + 1) % MAX;
        this.pos[i * 3] = a.x + (Math.random() - 0.5) * 0.2;
        this.pos[i * 3 + 1] = a.y;
        this.pos[i * 3 + 2] = a.z + (Math.random() - 0.5) * 0.2;
        this.vel[i * 3] = (Math.random() - 0.5) * 0.2;
        this.vel[i * 3 + 1] = 0.8 + Math.random() * 0.5;
        this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.2;
        this.age[i] = 0;
        this.life[i] = 5 + Math.random() * 3;
      }
      this.emitAcc.set(a.key, acc);
    }
    if (this.emitAcc.size > 4000) this.emitAcc.clear();
    for (let i = 0; i < MAX; i++) {
      const t = (this.age[i] += dt);
      if (t > this.life[i]) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      const k = t / this.life[i];
      this.vel[i * 3] += wind.x * dt * 0.35;
      this.vel[i * 3 + 2] += wind.z * dt * 0.35;
      this.vel[i * 3 + 1] *= 1 - dt * 0.15;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = 0.5 + k * 2.6;
      this.alpha[i] = Math.min(1, t * 2) * (1 - k) * 0.45;
    }
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.material as THREE.ShaderMaterial).uniforms.uLight.value = light;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
