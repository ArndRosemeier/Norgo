/**
 * GPU particle pool. Each particle is an instanced camera-facing quad whose
 * whole life is evaluated analytically in the vertex shader from its spawn
 * state (position, velocity, drag, gravity, turbulence, size/rotation/colour
 * over life). The CPU only writes 28 floats once per spawn into a ring buffer
 * (one interleaved instanced buffer, one partial upload per frame), so tens
 * of thousands of particles cost almost nothing on the CPU and nothing is
 * allocated per frame.
 *
 * Two blend modes are used by FxSystem: additive (fire, magic, sparks — HDR
 * values > 1 feed the bloom pass) and alpha (smoke, dust, rain, blood).
 * Particles fade in/out softly and are fogged (additive ones fade to black
 * in fog instead of to the fog colour).
 */
import * as THREE from 'three';
import { ATLAS_CELLS, particleAtlas } from './sprites';

const STRIDE = 28;

/** Spawn parameters. Reuse one object (see `P`) — never allocate per particle. */
export interface ParticleSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds. */
  life: number;
  size0: number; size1: number;
  rot: number; spin: number;
  r0: number; g0: number; b0: number; a0: number;
  r1: number; g1: number; b1: number; a1: number;
  sprite: number;
  /** Downward acceleration (m/s²); negative rises (buoyant smoke, embers). */
  gravity: number;
  /** Linear drag coefficient (1/s). */
  drag: number;
  /** Velocity stretch (0 = round billboard, ~0.05 = rain streak). */
  stretch: number;
  /** Turbulence amplitude in meters. */
  turb: number;
}

/** The shared scratch spawn object. Fill it, then call pool.spawn(P). */
export const P: ParticleSpawn = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 1, size1: 1, rot: 0, spin: 0,
  r0: 1, g0: 1, b0: 1, a0: 1, r1: 1, g1: 1, b1: 1, a1: 0, sprite: 0, gravity: 0, drag: 0, stretch: 0, turb: 0,
};

/** Reset the scratch object to defaults and return it. */
export function resetP(): ParticleSpawn {
  P.vx = P.vy = P.vz = 0;
  P.life = 1;
  P.size0 = P.size1 = 1;
  P.rot = P.spin = 0;
  P.r0 = P.g0 = P.b0 = P.a0 = 1;
  P.r1 = P.g1 = P.b1 = 1;
  P.a1 = 0;
  P.sprite = 0;
  P.gravity = P.drag = P.stretch = P.turb = 0;
  return P;
}

const VERT = /* glsl */ `
uniform float uTime;
attribute vec4 a0; // pos, t0
attribute vec4 a1; // vel, life
attribute vec4 a2; // size0, size1, rot, spin
attribute vec4 a3; // color0
attribute vec4 a4; // color1
attribute vec4 a5; // sprite, gravity, drag, stretch
attribute vec4 a6; // turb, seed
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  float age = uTime - a0.w;
  float t = age / a1.w;
  if (t < 0.0 || t > 1.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vColor = vec4(0.0);
    return;
  }
  float k = max(a5.z, 1e-4);
  float dragF = (1.0 - exp(-k * age)) / k;
  vec3 p = a0.xyz + a1.xyz * dragF;
  p.y -= 0.5 * a5.y * age * age;
  float seed = a6.y;
  vec3 vel = a1.xyz * exp(-k * age) - vec3(0.0, a5.y * age, 0.0);
  if (a6.x > 0.0) {
    float ramp = 1.0 - exp(-age * 1.5);
    p += a6.x * ramp * vec3(sin(age * 1.7 + seed * 6.28), 0.5 * sin(age * 1.3 + seed * 12.1), cos(age * 1.9 + seed * 9.3));
  }
  float size = mix(a2.x, a2.y, t);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 corner = position.xy;
  vec2 off;
  if (a5.w > 0.0) {
    vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    float l = length(vv.xy);
    vec2 d = l > 1e-4 ? vv.xy / l : vec2(0.0, 1.0);
    // Right-handed basis (n, d): a mirrored basis would flip the winding and cull the quad.
    vec2 n = vec2(d.y, -d.x);
    off = n * corner.x * size + d * corner.y * (size + l * a5.w);
  } else {
    float r = a2.z + a2.w * age;
    float c = cos(r), s = sin(r);
    off = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  }
  mv.xy += off;
  vec4 mvPosition = mv;
  gl_Position = projectionMatrix * mv;
  float cell = a5.x;
  float cx = mod(cell, ${ATLAS_CELLS}.0), cy = floor(cell / ${ATLAS_CELLS}.0);
  vUv = (vec2(cx, ${ATLAS_CELLS - 1}.0 - cy) + uv) / ${ATLAS_CELLS}.0;
  vColor = mix(a3, a4, t);
  vColor.a *= smoothstep(0.0, 0.07, t);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.002) discard;
  #ifdef ADDITIVE
    gl_FragColor = vec4(vColor.rgb * tex.rgb * a, 1.0);
  #else
    gl_FragColor = vec4(vColor.rgb * tex.rgb, a);
  #endif
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    #ifdef ADDITIVE
      gl_FragColor.rgb *= 1.0 - fogF;
    #else
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogF);
    #endif
  #endif
}
`;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private data: Float32Array;
  private buffer: THREE.InstancedInterleavedBuffer;
  private head = 0;
  /** First slot written since the last upload, and how many were written. */
  private dirtyFrom = 0;
  private pending = 0;
  private uniforms: { uTime: { value: number }; uMap: { value: THREE.Texture } };
  /** Pool clock (seconds), advanced by update(). */
  time = 0;
  /** Spawns this frame (debug HUD). */
  spawned = 0;
  private seed = 0;

  constructor(capacity: number, additive: boolean, renderOrder = 10) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    // Park every slot as already dead.
    for (let i = 0; i < capacity; i++) {
      this.data[i * STRIDE + 3] = -1e6;
      this.data[i * STRIDE + 7] = 1;
    }
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < 7; i++) geo.setAttribute('a' + i, new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4));
    geo.instanceCount = capacity;
    this.uniforms = { uTime: { value: 0 }, uMap: { value: particleAtlas() } };
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]) as Record<string, THREE.IUniform>,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: additive ? { ADDITIVE: '' } : {},
    });
    // Keep our uniform objects (merge clones values).
    mat.uniforms.uTime = this.uniforms.uTime;
    mat.uniforms.uMap = this.uniforms.uMap;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = additive ? 'fx.additive' : 'fx.alpha';
  }

  spawn(p: ParticleSpawn) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.pending === 0) this.dirtyFrom = i;
    this.pending++;
    const o = i * STRIDE, d = this.data;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = this.time;
    d[o + 4] = p.vx; d[o + 5] = p.vy; d[o + 6] = p.vz; d[o + 7] = Math.max(0.01, p.life);
    d[o + 8] = p.size0; d[o + 9] = p.size1; d[o + 10] = p.rot; d[o + 11] = p.spin;
    d[o + 12] = p.r0; d[o + 13] = p.g0; d[o + 14] = p.b0; d[o + 15] = p.a0;
    d[o + 16] = p.r1; d[o + 17] = p.g1; d[o + 18] = p.b1; d[o + 19] = p.a1;
    d[o + 20] = p.sprite; d[o + 21] = p.gravity; d[o + 22] = p.drag; d[o + 23] = p.stretch;
    d[o + 24] = p.turb; d[o + 25] = (this.seed = (this.seed + 0.618034) % 1); d[o + 26] = 0; d[o + 27] = 0;
    this.spawned++;
  }

  /** Advance the clock and upload the slots written since the last frame. */
  update(dt: number) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (!this.pending) return;
    const b = this.buffer;
    b.clearUpdateRanges();
    const n = Math.min(this.pending, this.capacity);
    const end = this.dirtyFrom + n;
    if (n >= this.capacity) b.addUpdateRange(0, this.capacity * STRIDE);
    else if (end <= this.capacity) b.addUpdateRange(this.dirtyFrom * STRIDE, n * STRIDE);
    else {
      // The ring wrapped this frame: upload the tail and the head segment.
      b.addUpdateRange(this.dirtyFrom * STRIDE, (this.capacity - this.dirtyFrom) * STRIDE);
      b.addUpdateRange(0, (end - this.capacity) * STRIDE);
    }
    b.needsUpdate = true;
    this.pending = 0;
  }

  /** Kill everything (e.g. after a teleport across the world). */
  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * STRIDE + 3] = -1e6;
    this.buffer.clearUpdateRanges();
    this.buffer.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
