/**
 * Pooled non-particle effect primitives used by the FX library:
 *  - FlashLights: a tiny budget of real point lights for transient flashes
 *    (explosions, lightning, blinks). Entity lights (`snap.light`) are handled
 *    by the client core's LightManager, so this only covers one-shots.
 *  - BeamPool: camera-facing ribbons (sun lances, lightning arcs, shadow
 *    tendrils, ropes, pull beams) with per-kind shaping.
 *  - DecalPool: ground-aligned procedural glyph circles, shockwave rings,
 *    soft zone discs, footprints and targeting reticles.
 *  - MeshFxPool: short-lived animated meshes (earth spikes, meteor rocks,
 *    force bubbles, ice crystals).
 * Every pool preallocates its objects; nothing is created per frame.
 */
import * as THREE from 'three';
import { patchSkyOcclusion } from '../../render/skyOcclusion';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();

// ------------------------------------------------------------------ flash lights

interface Flash {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  intensity: number;
  radius: number;
  t: number;
  dur: number;
  active: boolean;
  /** Assigned to a light this frame. */
  taken: boolean;
}

export class FlashLights {
  private lights: THREE.PointLight[] = [];
  private flashes: Flash[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, count = 3) {
    for (let i = 0; i < count; i++) {
      // Lights stay in the scene with zero intensity: toggling visibility would
      // change the light count and force shader recompiles.
      const l = new THREE.PointLight(0xffffff, 0, 20, 1.6);
      l.name = 'fx.flash';
      scene.add(l);
      this.lights.push(l);
    }
    for (let i = 0; i < 24; i++) this.flashes.push({ x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, intensity: 0, radius: 1, t: 0, dur: 0, active: false, taken: false });
  }

  flash(x: number, y: number, z: number, color: ArrayLike<number>, intensity: number, radius: number, dur: number) {
    const f = this.flashes[this.next];
    this.next = (this.next + 1) % this.flashes.length;
    f.x = x; f.y = y; f.z = z;
    f.r = color[0]; f.g = color[1]; f.b = color[2];
    f.intensity = intensity; f.radius = radius; f.t = 0; f.dur = dur; f.active = true;
  }

  update(dt: number, cam: THREE.Vector3) {
    // Advance, then give the lights to the strongest flashes as seen from the camera.
    for (const f of this.flashes) if (f.active && (f.t += dt) >= f.dur) f.active = false;
    for (let li = 0; li < this.lights.length; li++) {
      let best: Flash | null = null, bestScore = 0;
      for (const f of this.flashes) {
        if (!f.active || f.taken) continue;
        const k = 1 - f.t / f.dur;
        const d2 = (f.x - cam.x) ** 2 + (f.y - cam.y) ** 2 + (f.z - cam.z) ** 2;
        const score = (f.intensity * k * k) / (1 + d2 / (f.radius * f.radius * 4));
        if (score > bestScore) {
          bestScore = score;
          best = f;
        }
      }
      const L = this.lights[li];
      if (!best) {
        L.intensity = 0;
        continue;
      }
      best.taken = true;
      const k = 1 - best.t / best.dur;
      L.position.set(best.x, best.y, best.z);
      L.color.setRGB(best.r, best.g, best.b);
      L.intensity = best.intensity * k * k;
      L.distance = best.radius;
    }
    for (const f of this.flashes) f.taken = false;
  }

  dispose() {
    for (const l of this.lights) l.removeFromParent();
  }
}

// ------------------------------------------------------------------ beams

export const enum BeamKind {
  Straight = 0,
  Lightning = 1,
  Tendril = 2,
  Rope = 3,
  Spiral = 4,
}

const BEAM_SEG = 28;

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uKind;
varying vec2 vUv;
#include <fog_pars_fragment>
float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) { float i = floor(x); float f = fract(x); return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  float v = abs(vUv.y - 0.5) * 2.0;
  float ends = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  float core = exp(-v * v * 9.0);
  float halo = exp(-v * v * 2.2) * 0.45;
  float flow = 0.75 + 0.25 * noise(vUv.x * 18.0 - uTime * 9.0);
  vec3 col;
  float a;
  if (uKind > 2.5 && uKind < 3.5) {
    // Rope: opaque-ish fibre.
    col = uColor * (0.6 + 0.4 * noise(vUv.x * 60.0));
    a = smoothstep(1.0, 0.6, v) * uAlpha;
    gl_FragColor = vec4(col, a * ends);
  } else {
    if (uKind > 1.5 && uKind < 2.5) flow = 0.4 + 0.9 * noise(vUv.x * 7.0 - uTime * 3.0);
    col = uColor * (core * 1.3 + halo * 0.6) * flow + vec3(core * core * 0.45);
    a = uAlpha * ends;
    gl_FragColor = vec4(col * a, 1.0);
  }
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb *= 1.0 - fogF;
  #endif
}`;

export interface Beam {
  mesh: THREE.Mesh;
  pos: Float32Array;
  points: Float32Array;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Optional live endpoints (follow entities). */
  fromObj: THREE.Object3D | null;
  toObj: THREE.Object3D | null;
  fromOffset: number;
  toOffset: number;
  kind: BeamKind;
  width: number;
  t: number;
  life: number;
  active: boolean;
  seed: number;
  jitterT: number;
  color: THREE.Color;
  /** Reveal animation: the beam grows from `from` over this many seconds. */
  grow: number;
}

export class BeamPool {
  readonly group = new THREE.Group();
  private beams: Beam[] = [];

  constructor(count = 24) {
    this.group.name = 'fx.beams';
    for (let i = 0; i < count; i++) {
      const n = (BEAM_SEG + 1) * 2;
      const pos = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      const idx: number[] = [];
      for (let s = 0; s <= BEAM_SEG; s++) {
        uv[s * 4] = s / BEAM_SEG; uv[s * 4 + 1] = 0;
        uv[s * 4 + 2] = s / BEAM_SEG; uv[s * 4 + 3] = 1;
        if (s < BEAM_SEG) {
          const a = s * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uColor: { value: new THREE.Color() }, uAlpha: { value: 1 }, uTime: { value: 0 }, uKind: { value: 0 } },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 12;
      this.group.add(mesh);
      this.beams.push({
        mesh, pos, points: new Float32Array((BEAM_SEG + 1) * 3), from: new THREE.Vector3(), to: new THREE.Vector3(), fromObj: null, toObj: null,
        fromOffset: 0, toOffset: 0, kind: BeamKind.Straight, width: 0.2, t: 0, life: 0, active: false, seed: 0, jitterT: 0, color: new THREE.Color(), grow: 0,
      });
    }
  }

  /** Start a beam. Returns it so callers can attach live endpoints. */
  spawn(from: THREE.Vector3, to: THREE.Vector3, kind: BeamKind, color: ArrayLike<number>, width: number, life: number, grow = 0): Beam {
    let b = this.beams.find((x) => !x.active);
    if (!b) b = this.beams.reduce((a, c) => (c.t / c.life > a.t / a.life ? c : a));
    b.from.copy(from);
    b.to.copy(to);
    b.fromObj = b.toObj = null;
    b.fromOffset = b.toOffset = 0;
    b.kind = kind;
    b.width = width;
    b.t = 0;
    b.life = life;
    b.active = true;
    b.seed = Math.random() * 100;
    b.jitterT = 0;
    b.grow = grow;
    b.color.setRGB(color[0], color[1], color[2]);
    const mat = b.mesh.material as THREE.ShaderMaterial;
    mat.uniforms.uColor.value.copy(b.color);
    mat.uniforms.uKind.value = kind;
    mat.blending = kind === BeamKind.Rope ? THREE.NormalBlending : THREE.AdditiveBlending;
    b.mesh.visible = true;
    this.shape(b);
    return b;
  }

  private shape(b: Beam) {
    const P = b.points;
    const len = b.from.distanceTo(b.to);
    tmpV.subVectors(b.to, b.from);
    // Perpendicular basis for offsets.
    tmpV2.set(0, 1, 0);
    if (len > 1e-6 && Math.abs(tmpV.y / len) > 0.95) tmpV2.set(1, 0, 0);
    const side = tmpV3.crossVectors(tmpV, tmpV2).normalize();
    const up = tmpV2.crossVectors(side, tmpV).normalize();
    for (let i = 0; i <= BEAM_SEG; i++) {
      const s = i / BEAM_SEG;
      let ox = 0, oy = 0;
      const env = Math.sin(Math.PI * s);
      switch (b.kind) {
        case BeamKind.Lightning: {
          const amp = Math.min(14, 0.07 * len + 0.15) * env;
          ox = (Math.random() - 0.5) * amp;
          oy = (Math.random() - 0.5) * amp;
          break;
        }
        case BeamKind.Tendril:
          ox = Math.sin(s * 9 + b.t * 6 + b.seed) * 0.35 * env;
          oy = Math.cos(s * 7 + b.t * 5 + b.seed) * 0.35 * env;
          break;
        case BeamKind.Rope:
          oy = -env * Math.min(1.5, len * 0.04);
          break;
        case BeamKind.Spiral:
          ox = Math.sin(s * 30 - b.t * 14) * 0.25;
          oy = Math.cos(s * 30 - b.t * 14) * 0.25;
          break;
      }
      P[i * 3] = b.from.x + tmpV.x * s + side.x * ox + up.x * oy;
      P[i * 3 + 1] = b.from.y + tmpV.y * s + side.y * ox + up.y * oy;
      P[i * 3 + 2] = b.from.z + tmpV.z * s + side.z * ox + up.z * oy;
    }
  }

  update(dt: number, cam: THREE.Vector3, time: number) {
    for (const b of this.beams) {
      if (!b.active) continue;
      b.t += dt;
      if (b.t >= b.life) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }
      if (b.fromObj) {
        b.fromObj.getWorldPosition(b.from);
        b.from.y += b.fromOffset;
      }
      if (b.toObj) {
        b.toObj.getWorldPosition(b.to);
        b.to.y += b.toOffset;
      }
      b.jitterT -= dt;
      if (b.kind !== BeamKind.Lightning || b.jitterT <= 0) {
        this.shape(b);
        b.jitterT = 0.045;
      }
      const k = b.t / b.life;
      const mat = b.mesh.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = time;
      const flick = b.kind === BeamKind.Lightning ? 0.6 + 0.4 * Math.random() : 1;
      mat.uniforms.uAlpha.value = Math.min(1, b.t / 0.04) * (1 - k * k) * flick;
      // Camera-facing ribbon.
      const P = b.points, pos = b.pos;
      const grow = b.grow > 0 ? Math.min(1, b.t / b.grow) : 1;
      const width = b.width * (b.kind === BeamKind.Straight ? 1 - k * 0.6 : 1);
      for (let i = 0; i <= BEAM_SEG; i++) {
        const j = Math.min(BEAM_SEG, Math.round(i * grow));
        const i0 = Math.max(0, j - 1), i1 = Math.min(BEAM_SEG, j + 1);
        tmpV.set(P[i1 * 3] - P[i0 * 3], P[i1 * 3 + 1] - P[i0 * 3 + 1], P[i1 * 3 + 2] - P[i0 * 3 + 2]);
        tmpV2.set(cam.x - P[j * 3], cam.y - P[j * 3 + 1], cam.z - P[j * 3 + 2]);
        tmpV3.crossVectors(tmpV, tmpV2).normalize().multiplyScalar(width * 0.5);
        const o = i * 6;
        pos[o] = P[j * 3] - tmpV3.x; pos[o + 1] = P[j * 3 + 1] - tmpV3.y; pos[o + 2] = P[j * 3 + 2] - tmpV3.z;
        pos[o + 3] = P[j * 3] + tmpV3.x; pos[o + 4] = P[j * 3 + 1] + tmpV3.y; pos[o + 5] = P[j * 3 + 2] + tmpV3.z;
      }
      (b.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Points along the active beam (for particles along lightning etc). */
  pointAt(b: Beam, s: number, out: THREE.Vector3) {
    const i = Math.min(BEAM_SEG, Math.max(0, Math.round(s * BEAM_SEG)));
    return out.set(b.points[i * 3], b.points[i * 3 + 1], b.points[i * 3 + 2]);
  }

  dispose() {
    for (const b of this.beams) {
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.Material).dispose();
    }
  }
}

// ------------------------------------------------------------------ decals

export const enum DecalKind {
  Glyph = 0,
  Shockwave = 1,
  Disc = 2,
  Footprint = 3,
  Reticle = 4,
  Vortex = 5,
}

const DECAL_VERT = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const DECAL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uKind;
uniform float uProgress;
uniform float uSeed;
varying vec2 vUv;
#include <fog_pars_fragment>
#define PI 3.14159265
float hash(float n) { return fract(sin(n * 12.9898 + uSeed) * 43758.5453); }
float ring(float r, float c, float w) { return smoothstep(w, 0.0, abs(r - c)); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float th = atan(vUv.y, vUv.x);
  float a = 0.0;
  if (uKind < 0.5) {
    // Glyph circle: two rings, rotating rune ticks, inner star.
    float rot = th + uTime * 0.6;
    a += ring(r, 0.95, 0.03) + ring(r, 0.8, 0.02) * 0.8 + ring(r, 0.42, 0.015) * 0.6;
    float seg = floor((rot + PI) / (2.0 * PI) * 24.0);
    float f = fract((rot + PI) / (2.0 * PI) * 24.0);
    float h = hash(seg);
    float tick = step(0.25, f) * step(f, 0.75) * step(0.83, r) * step(r, 0.92) * step(0.35, h);
    float bar = step(abs(f - 0.5), 0.08) * step(0.83, r) * step(r, 0.92);
    a += max(tick * (0.4 + 0.6 * h), bar) * 0.9;
    float th2 = th - uTime * 0.9;
    float star = abs(cos(th2 * 2.5));
    a += smoothstep(0.03, 0.0, abs(r - 0.42 * (0.55 + 0.45 * star))) * step(r, 0.45) * 0.7;
    a += exp(-r * r * 9.0) * 0.25;
    a *= smoothstep(0.0, 0.25, uProgress) ;
  } else if (uKind < 1.5) {
    // Shockwave: expanding ring that thins and fades.
    float c = uProgress;
    a = ring(r, c, 0.06 + 0.08 * (1.0 - c)) * (1.0 - c) * 1.6 + smoothstep(c, 0.0, r) * 0.15 * (1.0 - c);
  } else if (uKind < 2.5) {
    // Soft disc with a brighter rim and slow ripples (zone floors).
    a = smoothstep(1.0, 0.85, r) * (0.25 + 0.12 * sin(r * 14.0 - uTime * 2.0)) + ring(r, 0.95, 0.05) * 0.6;
  } else if (uKind < 3.5) {
    // Footprint: oval pad + toes.
    vec2 p = vUv * vec2(1.8, 1.0);
    a = smoothstep(0.55, 0.45, length(p - vec2(0.0, -0.15))) * 0.8;
    for (int i = 0; i < 3; i++) a += smoothstep(0.2, 0.12, length(p - vec2(-0.45 + float(i) * 0.45, 0.55))) * 0.7;
  } else if (uKind < 4.5) {
    // Targeting reticle: dashed rim, crosshair, center dot.
    float dash = step(0.5, fract((th + uTime * 0.4) / (2.0 * PI) * 32.0));
    a = ring(r, 0.96, 0.025) * (0.4 + 0.6 * dash) + ring(r, 0.6, 0.01) * 0.35 + smoothstep(0.06, 0.03, r);
    a += (smoothstep(0.012, 0.0, abs(vUv.x)) + smoothstep(0.012, 0.0, abs(vUv.y))) * step(0.15, r) * step(r, 0.35) * 0.6;
  } else {
    // Vortex: spiral arms rotating inward.
    float s = sin(th * 3.0 + r * 10.0 + uTime * 4.0);
    a = smoothstep(0.4, 1.0, s) * (1.0 - r) * 0.45 + ring(r, 0.96, 0.03) * 0.35;
  }
  a *= uAlpha;
  #if defined(DARK)
    gl_FragColor = vec4(uColor, a);
  #else
    gl_FragColor = vec4(uColor * a, 1.0);
  #endif
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb *= 1.0 - fogF;
  #endif
}`;

export interface Decal {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  /** Persistent decals are never auto-released (zones, reticles). */
  persistent: boolean;
  active: boolean;
  fadeIn: number;
  baseAlpha: number;
  grow: boolean;
  mat: THREE.ShaderMaterial;
}

export class DecalPool {
  readonly group = new THREE.Group();
  private decals: Decal[] = [];
  private normal = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(count = 40) {
    this.group.name = 'fx.decals';
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          uColor: { value: new THREE.Color() }, uAlpha: { value: 1 }, uTime: { value: 0 }, uKind: { value: 0 }, uProgress: { value: 0 }, uSeed: { value: i * 3.7 },
        },
        vertexShader: DECAL_VERT,
        fragmentShader: DECAL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        fog: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 9;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.decals.push({ mesh, t: 0, life: 1, persistent: false, active: false, fadeIn: 0.15, baseAlpha: 1, grow: false, mat });
    }
  }

  /**
   * Place a decal of `radius` at `pos`, aligned to `normal` (defaults to up).
   * `seeThrough` draws it over terrain (sense pings).
   */
  spawn(pos: THREE.Vector3, radius: number, kind: DecalKind, color: ArrayLike<number>, life: number, opts: { normal?: THREE.Vector3; alpha?: number; persistent?: boolean; seeThrough?: boolean; yaw?: number } = {}): Decal {
    let d = this.decals.find((x) => !x.active);
    if (!d) d = this.decals.filter((x) => !x.persistent).reduce((a, c) => (c.t / c.life > a.t / a.life ? c : a), this.decals[0]);
    d.active = true;
    d.t = 0;
    d.life = life;
    d.persistent = !!opts.persistent;
    d.baseAlpha = opts.alpha ?? 1;
    d.grow = kind === DecalKind.Shockwave;
    const m = d.mesh;
    m.visible = true;
    m.position.copy(pos);
    this.normal.copy(opts.normal ?? THREE.Object3D.DEFAULT_UP).normalize();
    m.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.normal);
    if (opts.yaw) m.quaternion.multiply(this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, opts.yaw));
    m.position.addScaledVector(this.normal, 0.06);
    m.scale.setScalar(radius);
    const u = d.mat.uniforms;
    u.uColor.value.setRGB(color[0], color[1], color[2]);
    u.uKind.value = kind;
    u.uProgress.value = 0;
    u.uAlpha.value = 0;
    d.mat.depthTest = !opts.seeThrough;
    m.renderOrder = opts.seeThrough ? 20 : 9;
    return d;
  }

  release(d: Decal) {
    d.active = false;
    d.persistent = false;
    d.mesh.visible = false;
  }

  update(dt: number, time: number) {
    for (const d of this.decals) {
      if (!d.active) continue;
      d.t += dt;
      const u = d.mat.uniforms;
      u.uTime.value = time;
      if (d.persistent) {
        u.uProgress.value = Math.min(1, d.t / 0.6);
        u.uAlpha.value = d.baseAlpha * Math.min(1, d.t / d.fadeIn);
        continue;
      }
      const k = d.t / d.life;
      if (k >= 1) {
        this.release(d);
        continue;
      }
      u.uProgress.value = d.grow ? 1 - (1 - k) * (1 - k) : Math.min(1, d.t / 0.5);
      u.uAlpha.value = d.baseAlpha * Math.min(1, d.t / d.fadeIn) * (d.grow ? 1 : 1 - Math.pow(k, 3));
    }
  }

  dispose() {
    this.decals[0]?.mesh.geometry.dispose();
    for (const d of this.decals) d.mat.dispose();
  }
}

// ------------------------------------------------------------------ animated meshes

export const enum MeshFxKind {
  Spike = 0,
  Rock = 1,
  Bubble = 2,
  Crystal = 3,
}

interface MeshFx {
  obj: THREE.Mesh;
  kind: MeshFxKind;
  t: number;
  life: number;
  active: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  size: number;
  follow: THREE.Object3D | null;
}

const BUBBLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
  float hex = 0.5 + 0.5 * sin(vP.x * 9.0 + uTime * 2.0) * sin(vP.y * 9.0 - uTime) * sin(vP.z * 9.0);
  gl_FragColor = vec4(uColor * (f * 1.6 + hex * 0.12) * uAlpha, 1.0);
}`;
const BUBBLE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

export class MeshFxPool {
  readonly group = new THREE.Group();
  private items: MeshFx[] = [];
  private skyVis: { value: number }[] = [];

  constructor() {
    this.group.name = 'fx.meshes';
    // Rough rock cone for earth spikes.
    const spike = new THREE.ConeGeometry(0.55, 2.4, 7, 4, false);
    spike.translate(0, 1.2, 0);
    jitter(spike, 0.09, 11);
    spike.computeVertexNormals();
    const rock = new THREE.IcosahedronGeometry(0.9, 1);
    jitter(rock, 0.22, 23);
    rock.computeVertexNormals();
    const crystal = new THREE.OctahedronGeometry(0.5, 0);
    crystal.scale(0.6, 1.8, 0.6);
    const bubble = new THREE.SphereGeometry(1, 28, 18);
    const mkStone = (color: number, emissive = 0x000000, ei = 0) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, flatShading: true, emissive, emissiveIntensity: ei, transparent: true });
      const p = patchSkyOcclusion(m, 'uniform');
      if (p.uniform) this.skyVis.push(p.uniform);
      return m;
    };
    const add = (kind: MeshFxKind, geo: THREE.BufferGeometry, n: number, mat: () => THREE.Material) => {
      for (let i = 0; i < n; i++) {
        const obj = new THREE.Mesh(geo, mat());
        obj.visible = false;
        obj.castShadow = kind === MeshFxKind.Spike || kind === MeshFxKind.Rock;
        obj.frustumCulled = false;
        this.group.add(obj);
        this.items.push({ obj, kind, t: 0, life: 1, active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), size: 1, follow: null });
      }
    };
    add(MeshFxKind.Spike, spike, 10, () => mkStone(0x6b5d4f));
    add(MeshFxKind.Rock, rock, 6, () => mkStone(0x2a1d16, 0xff4a10, 1.6));
    add(MeshFxKind.Crystal, crystal, 16, () => {
      const m = new THREE.MeshStandardMaterial({ color: 0xbfe8ff, roughness: 0.1, metalness: 0.1, emissive: 0x3a90c0, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 });
      const p = patchSkyOcclusion(m, 'uniform');
      if (p.uniform) this.skyVis.push(p.uniform);
      return m;
    });
    add(MeshFxKind.Bubble, bubble, 10, () => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.5, 0.75, 1) }, uAlpha: { value: 1 }, uTime: { value: 0 } },
      vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
  }

  /** Sky visibility for the lit fx meshes (caves). */
  setSkyVis(v: number) {
    for (const u of this.skyVis) u.value = v;
  }

  spawn(kind: MeshFxKind, from: THREE.Vector3, to: THREE.Vector3, size: number, life: number, color?: ArrayLike<number>, follow: THREE.Object3D | null = null) {
    let it = this.items.find((x) => x.kind === kind && !x.active);
    if (!it) it = this.items.filter((x) => x.kind === kind).reduce((a, c) => (c.t / c.life > a.t / a.life ? c : a));
    it.active = true;
    it.t = 0;
    it.life = life;
    it.from.copy(from);
    it.to.copy(to);
    it.size = size;
    it.follow = follow;
    it.obj.visible = true;
    it.obj.rotation.set(Math.random() * 0.25 - 0.12, Math.random() * Math.PI * 2, Math.random() * 0.25 - 0.12);
    if (kind === MeshFxKind.Bubble && color) ((it.obj.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).setRGB(color[0], color[1], color[2]);
    if (kind === MeshFxKind.Crystal) it.obj.rotation.set((Math.random() - 0.5) * 1.2, Math.random() * 6.28, (Math.random() - 0.5) * 1.2);
    return it;
  }

  /** Is there a live bubble following this object (aura shields)? */
  hasFollower(obj: THREE.Object3D) {
    return this.items.some((x) => x.active && x.follow === obj);
  }

  update(dt: number, time: number) {
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) {
        it.active = false;
        it.obj.visible = false;
        continue;
      }
      const o = it.obj;
      switch (it.kind) {
        case MeshFxKind.Spike: {
          // Erupt fast, hold, sink back into the ground.
          const up = Math.min(1, it.t / 0.12);
          const down = k > 0.7 ? (k - 0.7) / 0.3 : 0;
          const s = it.size * (0.2 + 0.8 * easeOutBack(up));
          o.position.copy(it.from);
          o.position.y -= down * 2.6 * it.size;
          o.scale.set(s, it.size * up, s);
          break;
        }
        case MeshFxKind.Rock: {
          // Falling meteor: from sky to target with a slight spin.
          o.position.lerpVectors(it.from, it.to, k * k);
          o.rotation.x += dt * 3;
          o.rotation.z += dt * 2;
          o.scale.setScalar(it.size);
          break;
        }
        case MeshFxKind.Crystal: {
          // Ice crystals: shoot out from `from` toward `to`, then shatter (fade).
          const e = easeOutBack(Math.min(1, it.t / 0.15));
          o.position.lerpVectors(it.from, it.to, e);
          o.scale.setScalar(it.size * (k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1));
          break;
        }
        case MeshFxKind.Bubble: {
          if (it.follow) {
            it.follow.getWorldPosition(o.position);
            o.position.y += it.size * 0.85;
          } else o.position.copy(it.from);
          const pop = Math.min(1, it.t / 0.2);
          o.scale.setScalar(it.size * (0.8 + 0.2 * easeOutBack(pop)));
          const u = (o.material as THREE.ShaderMaterial).uniforms;
          u.uTime.value = time;
          u.uAlpha.value = pop * (k > 0.85 ? (1 - k) / 0.15 : 1);
          break;
        }
      }
      const mat = o.material as THREE.Material & { opacity?: number };
      if (it.kind !== MeshFxKind.Bubble && mat.opacity !== undefined) mat.opacity = k > 0.85 ? (1 - k) / 0.15 : 1;
    }
  }

  /** End bubbles following an object (shield expired). */
  releaseFollower(obj: THREE.Object3D) {
    for (const it of this.items) if (it.active && it.follow === obj && it.t < it.life - 0.3) it.t = it.life - 0.3;
  }

  dispose() {
    const geos = new Set<THREE.BufferGeometry>();
    for (const it of this.items) {
      geos.add(it.obj.geometry);
      (it.obj.material as THREE.Material).dispose();
    }
    for (const g of geos) g.dispose();
  }
}

function easeOutBack(x: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** Deterministic vertex jitter (shared vertices move together). */
function jitter(geo: THREE.BufferGeometry, amount: number, seed: number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const h = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = Math.round(x * 100) / 100, l = Math.round(y * 100) / 100, m = Math.round(z * 100) / 100;
    pos.setXYZ(i, x + h(k, l, m) * amount * 2, y + h(l, m, k) * amount, z + h(m, k, l) * amount * 2);
  }
}
