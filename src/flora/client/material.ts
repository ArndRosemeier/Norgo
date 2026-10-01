/**
 * Flora materials: one MeshStandardMaterial-based shader family for all
 * vegetation, rocks and props.
 *
 * Features:
 *  - atlas sampling with per-vertex cell index (bark wraps inside its cell via
 *    textureGrad, so mip selection stays seamless)
 *  - two-color tinting (vertex color A/B selected by the atlas mask), per-instance
 *    brightness/hue jitter derived from the instance random
 *  - wind sway (trunk bend + branch phase + leaf flutter) driven by Environment.wind
 *  - grass push-away around the player and distance fade for ground cover
 *  - sky occlusion ('varying' mode, value from the instance data) so caves are dark
 *  - emissive glow from the atlas B mask (glowshrooms, embers, crystals)
 *  - leaf translucency when looking towards the sun
 *  - rocks: triplanar detail texture, ore veins, damage darkening
 *
 * Per-instance data is carried in `InstancedMesh.instanceColor` (not as a tint!):
 *   r = random 0..1, g = sky visibility 0..1, b = damage 0..1
 * Non-instanced meshes (falling trees, debris) use the `uInst` uniform instead.
 */
import * as THREE from 'three';
import { patchSkyOcclusion } from '../../render/skyOcclusion';
import { ATLAS_COLS, ATLAS_ROWS, CELL_PX } from './atlas';

export type FloraMatKind = 'foliage' | 'grass' | 'rock' | 'crystal' | 'impostor';

/** Uniforms shared by every flora material (updated once per frame). */
export interface FloraShared {
  uTime: { value: number };
  /** xy = wind direction (world XZ), z = strength. */
  uWind: { value: THREE.Vector3 };
  /** xyz = player position, w = push radius. */
  uPlayer: { value: THREE.Vector4 };
  /** Sun direction in view space (for translucency). */
  uSunView: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
  /** Grass fade distances (start, end). */
  uFade: { value: THREE.Vector2 };
  uGlow: { value: number };
}

export function createFloraShared(): FloraShared {
  return {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3(1, 0, 0.3) },
    uPlayer: { value: new THREE.Vector4(0, -1e6, 0, 1.1) },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uFade: { value: new THREE.Vector2(34, 48) },
    uGlow: { value: 1 },
  };
}

const CELL_PAD = 2 / CELL_PX;

const VERT_HEAD = /* glsl */ `
attribute vec3 aColor2;
attribute vec4 aWind;
attribute float aCell;
uniform float uTime;
uniform vec3 uWind;
uniform vec4 uPlayer;
uniform vec2 uFade;
uniform vec3 uInst;
varying vec3 vColB;
varying vec2 vUvL;
varying float vCell;
varying float vGlowV;
varying float vLeaf;
varying float vSkyVis;
varying float vDamage;
varying vec3 vObjPos;
varying vec3 vObjNrm;
vec3 floraInst() {
#ifdef USE_INSTANCING_COLOR
  return instanceColor;
#else
  return uInst;
#endif
}
`;

/** Wind / push / fade displacement applied to `transformed` (object space). */
const VERT_WIND = /* glsl */ `
{
  vec3 inst = floraInst();
  float rnd = inst.x;
  vec3 wl = vec3(uWind.x, 0.0, uWind.y);
  float sInst = 1.0;
#ifdef USE_INSTANCING
  sInst = max(length(instanceMatrix[0].xyz), 1e-3);
  wl = (vec4(wl, 0.0) * instanceMatrix).xyz / sInst;
#endif
  float str = uWind.z;
  float bend = aWind.x;
  float ph = rnd * 6.2831 + aWind.z * 6.2831;
  float t = uTime;
#ifndef FLORA_ROCK
  if (bend > 0.0 || aWind.y > 0.0) {
    float gust = 0.55 + 0.45 * sin(t * 0.37 + rnd * 4.0) * sin(t * 0.21 + 1.7);
    float main = (sin(t * 1.05 + rnd * 6.2831) * 0.5 + sin(t * 1.93 + rnd * 3.1) * 0.22 + 0.55) * gust;
    vec3 d = wl * (bend * str * main);
    // Branch-level desynchronized motion.
    d += vec3(sin(t * 2.4 + ph), 0.0, cos(t * 2.1 + ph * 1.3)) * bend * str * 0.18;
    // Leaf flutter along the normal.
    d += normal * (aWind.y * sin(t * 9.0 + ph * 3.0 + position.y * 2.3) * 0.045 * (0.3 + str));
#ifdef FLORA_GRASS
    // Push away from the player (world-space test, local-space displacement).
    vec4 org = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 dp = org.xz - uPlayer.xz;
    float dist = length(dp);
    float push = (1.0 - smoothstep(uPlayer.w * 0.25, uPlayer.w, dist)) * (1.0 - smoothstep(1.0, 2.5, abs(org.y - uPlayer.y)));
    if (push > 0.0) {
      vec3 pl = (vec4(dp.x, 0.0, dp.y, 0.0) * instanceMatrix).xyz / (sInst * max(dist, 0.05));
      d += pl * push * bend * 2.4;
      d.y -= push * bend * 1.2;
    }
#endif
    // Preserve length a little when bending.
    d.y -= dot(d.xz, d.xz) * 0.35 / max(position.y, 0.6);
    transformed += d;
  }
#endif
#ifdef FLORA_GRASS
  {
    vec4 org2 = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float cd = length(org2.xyz - cameraPosition);
    float fade = 1.0 - smoothstep(uFade.x, uFade.y, cd);
    transformed *= fade;
  }
#endif
  vColB = aColor2;
  vUvL = uv;
  vCell = aCell;
  vGlowV = aWind.w;
  vLeaf = aWind.y;
  vSkyVis = inst.y;
  vDamage = inst.z;
  vObjPos = position;
  vObjNrm = normal;
  // Per-instance tint variation from the random: brightness ±12 %, slight warm/cool shift.
  float jit = (rnd - 0.5);
  vec3 tintI = vec3(1.0 + jit * 0.22 + jit * 0.06, 1.0 + jit * 0.22, 1.0 + jit * 0.22 - jit * 0.08);
  vColB *= tintI;
#ifdef FLORA_TINT_A
  vColor.rgb *= tintI;
#endif
}
`;

const FRAG_HEAD = /* glsl */ `
uniform vec3 uSunView;
uniform vec3 uSunCol;
uniform float uGlow;
uniform float uTime;
uniform sampler2D tRock;
varying vec3 vColB;
varying vec2 vUvL;
varying float vCell;
varying float vGlowV;
varying float vLeaf;
varying float vDamage;
varying vec3 vObjPos;
varying vec3 vObjNrm;
vec3 floraAlbedo;
float floraMask;
float floraGlowMask;
`;

const FRAG_MAP = /* glsl */ `
{
#ifdef FLORA_ROCK
  // Triplanar rock detail in object space.
  vec3 bw = pow(abs(normalize(vObjNrm)), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  vec3 p = vObjPos * 0.45;
  vec4 tx = texture2D(tRock, p.yz);
  vec4 ty = texture2D(tRock, p.xz);
  vec4 tz = texture2D(tRock, p.xy);
  vec4 tex = tx * bw.x + ty * bw.y + tz * bw.z;
  floraMask = tex.g * step(0.01, vGlowV);
  floraGlowMask = 0.0;
  float lum = 0.55 + tex.r * 0.75;
  // Upward faces catch dust / lichen (color B), damage adds dark cracks.
  float top = smoothstep(0.55, 0.95, normalize(vObjNrm).y);
  vec3 base = mix(vColor.rgb, vColB, max(floraMask, top * 0.25));
  lum *= 1.0 - vDamage * tex.b * 0.9;
  floraAlbedo = base * lum;
  diffuseColor.rgb *= floraAlbedo;
#else
  vec2 cellSize = vec2(1.0 / ${ATLAS_COLS}.0, 1.0 / ${ATLAS_ROWS}.0);
  vec2 org = vec2(mod(vCell, ${ATLAS_COLS}.0), floor(vCell / ${ATLAS_COLS}.0 + 0.001)) * cellSize;
  vec2 inner = cellSize * (1.0 - 2.0 * ${CELL_PAD.toFixed(6)});
  vec2 auv = org + cellSize * ${CELL_PAD.toFixed(6)} + fract(vUvL) * inner;
  vec4 tex = textureGrad(map, auv, dFdx(vUvL) * inner, dFdy(vUvL) * inner);
  floraMask = tex.g;
  floraGlowMask = tex.b;
  floraAlbedo = mix(vColor.rgb, vColB, floraMask) * (tex.r * 1.15);
  diffuseColor.rgb *= floraAlbedo;
  // Alpha-tested cut-outs thin out in coarse mips; boost alpha with the mip level to keep coverage.
  vec2 px = vUvL * ${CELL_PX}.0;
  float mip = max(0.0, 0.5 * log2(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px)))));
  diffuseColor.a = tex.a * (1.0 + mip * 0.28);
#endif
}
`;

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
{
  float g = vGlowV * uGlow;
#ifdef FLORA_CRYSTAL
  // Crystals: internal glow + fresnel rim.
  vec3 vdir = normalize(vViewPosition);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), vdir)), 3.0);
  totalEmissiveRadiance += mix(vColor.rgb, vColB, 0.5) * (g * (0.35 + floraGlowMask * 0.9) + fres * 0.35 * (0.3 + g));
#else
  float pulse = 0.85 + 0.15 * sin(uTime * 1.7 + vObjPos.x * 3.1 + vObjPos.z * 2.3);
  totalEmissiveRadiance += mix(vColor.rgb, vColB, floraMask) * (floraGlowMask * g * 0.95 * pulse);
#endif
}
`;

const FRAG_TRANSLUCENT = /* glsl */ `
#ifndef FLORA_ROCK
{
  // Light shining through leaves when looking towards the sun.
  vec3 toCam = normalize(vViewPosition);
  float tr = pow(clamp(dot(toCam, -uSunView), 0.0, 1.0), 4.0);
  outgoingLight += floraAlbedo * uSunCol * (vLeaf * tr * 0.7 * vSkyVis);
  // Soft subsurface fill so shaded leaf cards never go flat black.
  outgoingLight += floraAlbedo * uSunCol * (vLeaf * 0.1 * vSkyVis);
}
#endif
#include <opaque_fragment>
`;

function defineFor(kind: FloraMatKind): Record<string, string> {
  const d: Record<string, string> = {};
  if (kind === 'grass') d.FLORA_GRASS = '';
  if (kind === 'rock') d.FLORA_ROCK = '';
  if (kind === 'crystal') d.FLORA_CRYSTAL = '';
  if (kind === 'impostor') d.FLORA_IMPOSTOR = '';
  return d;
}

/**
 * Create a flora material. `instInit` is the uInst uniform value for
 * non-instanced use (random, sky, damage).
 */
export function createFloraMaterial(kind: FloraMatKind, shared: FloraShared, map: THREE.Texture, rockTex: THREE.Texture, instInit?: THREE.Vector3): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: kind === 'rock' ? null : map,
    roughness: kind === 'crystal' ? 0.18 : kind === 'rock' ? 0.92 : 0.82,
    metalness: kind === 'crystal' ? 0.15 : 0,
    side: kind === 'rock' ? THREE.FrontSide : THREE.DoubleSide,
    alphaTest: kind === 'rock' ? 0 : 0.5,
  });
  mat.name = 'flora:' + kind;
  mat.defines = { ...(mat.defines ?? {}), ...defineFor(kind) };
  const uInst = { value: instInit ?? new THREE.Vector3(0.5, 1, 0) };
  mat.userData.uInst = uInst;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.uniforms.uPlayer = shared.uPlayer;
    shader.uniforms.uSunView = shared.uSunView;
    shader.uniforms.uSunCol = shared.uSunCol;
    shader.uniforms.uFade = shared.uFade;
    shader.uniforms.uGlow = shared.uGlow;
    shader.uniforms.uInst = uInst;
    shader.uniforms.tRock = { value: rockTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      // Instance color carries data, not tint: keep vertex colors untouched.
      .replace('#include <color_vertex>', '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n\tvColor = vec4(1.0);\n\tvColor.rgb *= color.rgb;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_WIND);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <map_fragment>', FRAG_MAP)
      // Vertex colors are applied inside FRAG_MAP (two-color mix); skip the default multiply.
      .replace('#include <color_fragment>', '')
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <opaque_fragment>', FRAG_TRANSLUCENT)
      // Two-sided foliage keeps its (outward, crown-bent) normals on back faces.
      .replace(
        '#include <normal_fragment_begin>',
        kind === 'rock' ? '#include <normal_fragment_begin>' : THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''),
      );
    if (kind === 'rock') {
      // Ore veins glint.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.3, floraMask);',
      );
    }
  };
  mat.customProgramCacheKey = () => 'flora-v2:' + kind;
  patchSkyOcclusion(mat, 'varying');
  // vColor tint jitter applies to all but rocks (rocks get it via instance color variation in color B mix).
  if (kind !== 'rock') mat.defines.FLORA_TINT_A = '';
  return mat;
}

/** Depth material for shadow casting (wind + alpha cut-outs). */
export function createFloraDepthMaterial(kind: FloraMatKind, shared: FloraShared, map: THREE.Texture): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: kind === 'rock' ? null : map, alphaTest: kind === 'rock' ? 0 : 0.5 });
  mat.defines = { ...(mat.defines ?? {}), ...defineFor(kind) };
  const uInst = { value: new THREE.Vector3(0.5, 1, 0) };
  mat.userData.uInst = uInst;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.uniforms.uPlayer = shared.uPlayer;
    shader.uniforms.uFade = shared.uFade;
    shader.uniforms.uInst = uInst;
    const head = VERT_HEAD.replace('varying float vSkyVis;', 'float vSkyVis;');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + head)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_WIND.replace('vColor.rgb *= tintI;', ''));
    if (kind !== 'rock') {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vUvL;\nvarying float vCell;')
        .replace(
          '#include <map_fragment>',
          `{
  vec2 cellSize = vec2(1.0 / ${ATLAS_COLS}.0, 1.0 / ${ATLAS_ROWS}.0);
  vec2 org = vec2(mod(vCell, ${ATLAS_COLS}.0), floor(vCell / ${ATLAS_COLS}.0 + 0.001)) * cellSize;
  vec2 inner = cellSize * (1.0 - 2.0 * ${CELL_PAD.toFixed(6)});
  vec2 auv = org + cellSize * ${CELL_PAD.toFixed(6)} + fract(vUvL) * inner;
  diffuseColor.a = textureGrad(map, auv, dFdx(vUvL) * inner, dFdy(vUvL) * inner).a;
}`,
        );
    }
  };
  mat.customProgramCacheKey = () => 'flora-depth-v1:' + kind;
  return mat;
}
