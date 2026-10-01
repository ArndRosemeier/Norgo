/**
 * Creature materials: MeshStandardMaterial patched with procedural integument
 * shading. Everything is computed in the shader from the *bind-pose* position
 * (skinning moves the surface, patterns stay glued to the body):
 *
 *  - integument micro-structure: fur fibres, overlapping scales, chitin plates,
 *    feather barbs, wet slime, faceted crystal, bark ridges, cracked stone;
 *  - colour patterns: stripes, spots, rosettes, bands, patches, mottling,
 *    saddles, eyespots, countershading;
 *  - part tags from the mesher: keratin (horns/claws/beaks), shell plates,
 *    glow organs, mouth;
 *  - bioluminescence (dots, lines or whole-body pulse) scaled at runtime by
 *    darkness (night / caves);
 *  - sky occlusion via patchSkyOcclusion('uniform').
 *
 * All creatures share three shader programs (body, membrane, eye); per-species
 * & per-individual values are uniforms.
 */
import * as THREE from 'three';
import { patchSkyOcclusion } from '../../render/skyOcclusion';
import type { Species } from '../species';
import { hash32, hashToFloat } from '../../core/rng';

const INTEG_ID: Record<string, number> = { fur: 0, scales: 1, chitin: 2, feathers: 3, slime: 4, crystal: 5, bark: 6, stone: 7 };
const PATTERN_ID: Record<string, number> = { none: 0, stripes: 1, spots: 2, rosettes: 3, bands: 4, patches: 5, mottled: 6, saddle: 7, eyespots: 8 };
const PUPIL_ID: Record<string, number> = { round: 0, slit: 1, bar: 2, compound: 3, none: 4 };

/** Runtime-controlled uniforms of one creature's materials. */
export interface CreatureUniforms {
  glowLevel: { value: number };
  hurt: { value: number };
  time: { value: number };
  skyVis: { value: number }[];
  /** 0 alive .. 1 dead (desaturate, darken eyes). */
  dead: { value: number };
}

const GLSL_NOISE = /* glsl */ `
float cr_hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 cr_hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float cr_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cr_hash(i), cr_hash(i + vec3(1,0,0)), f.x), mix(cr_hash(i + vec3(0,1,0)), cr_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(cr_hash(i + vec3(0,0,1)), cr_hash(i + vec3(1,0,1)), f.x), mix(cr_hash(i + vec3(0,1,1)), cr_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float cr_fbm(vec3 p) { return cr_noise(p) * 0.5 + cr_noise(p * 2.03 + 7.1) * 0.3 + cr_noise(p * 4.1 + 3.3) * 0.2; }
// Cellular: returns (F1, F2, cell id hash).
vec3 cr_cell(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = cr_hash3(i + g);
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = o.x; } else if (d < f2) { f2 = d; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
vec3 cr_perturb(vec3 surfPos, vec3 surfNorm, float h, float scale, float faceDir) {
  vec3 sx = dFdx(surfPos); vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm); vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dFdx(h) * scale * r1 + dFdy(h) * scale * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

// ------------------------------------------------------------------ body

export function createBodyMaterial(sp: Species, seed: number, u: CreatureUniforms): THREE.MeshStandardMaterial {
  const c = sp.colors;
  const mat = new THREE.MeshStandardMaterial({
    roughness: c.roughness,
    metalness: sp.integument === 'crystal' ? 0.15 : 0,
    transparent: sp.translucent,
    opacity: 1,
    depthWrite: !sp.translucent,
    side: THREE.FrontSide,
  });
  const col = (rgb: [number, number, number], jitter = 0) => {
    const h = hashToFloat(hash32(seed ^ 0x77)) - 0.5;
    const out = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    if (jitter) out.offsetHSL(h * 0.03 * jitter, h * 0.08 * jitter, (hashToFloat(hash32(seed ^ 0x99)) - 0.5) * 0.08 * jitter);
    return out;
  };
  const uniforms = {
    uBase: { value: col(c.base, 1) },
    uSecondary: { value: col(c.secondary, 1) },
    uBelly: { value: col(c.belly, 1) },
    uAccent: { value: col(c.accent) },
    uGlowColor: { value: col(c.glow) },
    uKeratin: { value: col(c.keratin) },
    uInteg: { value: INTEG_ID[sp.integument] ?? 0 },
    uPattern: { value: PATTERN_ID[c.pattern] ?? 0 },
    uPatternScale: { value: c.patternScale },
    uContrast: { value: c.patternContrast },
    uCountershade: { value: c.countershade },
    uGlowAmount: { value: c.glowAmount },
    uGlowStyle: { value: c.glowStyle },
    uSheen: { value: c.sheen },
    uLength: { value: sp.length },
    uSeedOff: { value: new THREE.Vector3(hashToFloat(hash32(sp.seed)) * 50, hashToFloat(hash32(sp.seed + 1)) * 50, hashToFloat(hash32(seed)) * 3) },
    uTranslucent: { value: sp.translucent ? 1 : 0 },
    uGlowLevel: u.glowLevel,
    uHurt: u.hurt,
    uTime: u.time,
    uDead: u.dead,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aPart;\nattribute vec2 aRegion;\nuniform float uLength;\nvarying vec3 vRest;\nvarying vec3 vRestN;\nvarying vec4 vPart;\nvarying vec2 vRegion;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvRestN = normal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position / uLength;\nvPart = aPart;\nvRegion = aRegion;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uBase, uSecondary, uBelly, uAccent, uGlowColor, uKeratin, uSeedOff;
uniform float uInteg, uPattern, uPatternScale, uContrast, uCountershade, uGlowAmount, uGlowStyle, uSheen, uGlowLevel, uHurt, uTime, uDead, uTranslucent;
varying vec3 vRest; varying vec3 vRestN; varying vec4 vPart; varying vec2 vRegion;
${GLSL_NOISE}
float crH = 0.0; float crBump = 0.0; float crRough = 0.0; vec3 crEmis = vec3(0.0); float crFacet = 0.0;
`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 p = vRest + uSeedOff * 0.0;
  vec3 q = vRest * uPatternScale + uSeedOff;
  float sc = uPatternScale;
  float warp = cr_fbm(q * 0.7) - 0.5;
  // --- colour pattern mask
  float m = 0.0;
  int pat = int(uPattern + 0.5);
  if (pat == 1) { float s = sin((p.z * sc * 1.1 + p.y * 0.8 + warp * 1.6) * 6.2832); m = smoothstep(0.25, 0.55, s) * smoothstep(-0.6, 0.1, vRestN.y); }
  else if (pat == 2) { vec3 cl = cr_cell(q * 1.4); m = 1.0 - smoothstep(0.22, 0.34, cl.x + warp * 0.15); }
  else if (pat == 3) { vec3 cl = cr_cell(q * 1.1); m = smoothstep(0.2, 0.28, cl.x) * (1.0 - smoothstep(0.33, 0.42, cl.x)) + (1.0 - smoothstep(0.08, 0.14, cl.x)) * 0.0; }
  else if (pat == 4) { m = step(0.5, fract(p.z * sc * 0.55 + warp * 0.25)); }
  else if (pat == 5) { m = smoothstep(0.48, 0.56, cr_fbm(q * 0.45)); }
  else if (pat == 6) { m = smoothstep(0.35, 0.75, cr_fbm(q * 1.8)) ; }
  else if (pat == 7) { m = smoothstep(0.1, 0.5, vRestN.y + warp * 0.6) * (1.0 - vRegion.x); }
  else if (pat == 8) { vec3 cl = cr_cell(q * 0.55); m = smoothstep(0.22, 0.26, cl.x) * (1.0 - smoothstep(0.3, 0.34, cl.x)); m += (1.0 - smoothstep(0.1, 0.14, cl.x)) * 2.0; }
  m *= uContrast * (1.0 - vRegion.x * 0.55);
  vec3 col = mix(uBase, uSecondary, clamp(m, 0.0, 1.0));
  if (pat == 8 && m > 1.0) col = mix(col, uAccent, clamp(m - 1.0, 0.0, 1.0));
  // Countershading: pale belly, darker back.
  float under = smoothstep(0.15, -0.55, vRestN.y);
  col = mix(col, uBelly, under * uCountershade);
  col *= 1.0 - smoothstep(0.4, 1.0, vRestN.y) * 0.12 * uCountershade;
  // Head & limb tips slightly darker (points), adds definition.
  col *= 1.0 - vRegion.x * 0.12;
  // --- integument micro structure
  int integ = int(uInteg + 0.5);
  float rough = roughness;
  if (integ == 0) { // fur: fibres stretched along the body axis
    float f = cr_noise(vec3(vRest.x * 140.0, vRest.y * 140.0, vRest.z * 35.0));
    float f2 = cr_noise(vec3(vRest.x * 60.0, vRest.y * 60.0, vRest.z * 14.0) + 3.0);
    col *= 0.86 + f * 0.22 + (f2 - 0.5) * 0.14;
    crH = f * 0.6 + f2 * 0.4; crBump = 0.35;
    rough = 0.92;
  } else if (integ == 1) { // overlapping scales
    vec3 cl = cr_cell(vec3(vRest.x * 46.0, vRest.y * 46.0, vRest.z * 30.0));
    float edge = cl.y - cl.x;
    crH = smoothstep(0.0, 0.25, edge) * (1.0 - cl.x * 0.5);
    col *= 0.78 + 0.3 * smoothstep(0.0, 0.3, edge) + (cl.z - 0.5) * 0.12;
    crBump = 0.9; rough = mix(0.3, 0.6, cl.z);
  } else if (integ == 2) { // chitin plates with seams + iridescence
    float seg = fract(vRest.z * 7.0 + warp * 0.1);
    float seam = smoothstep(0.0, 0.06, seg) * smoothstep(1.0, 0.92, seg);
    crH = seam * (0.7 + 0.3 * cr_noise(vRest * 60.0)); crBump = 0.8;
    col *= 0.55 + 0.45 * seam;
    rough = 0.28;
  } else if (integ == 3) { // feathers: elongated overlapping vanes
    vec3 cl = cr_cell(vec3(vRest.x * 60.0, vRest.y * 60.0, vRest.z * 22.0));
    float vane = 1.0 - cl.x / max(cl.y, 1e-3);
    float barb = cr_noise(vec3(vRest.x * 220.0, vRest.y * 220.0, vRest.z * 40.0));
    col *= 0.72 + 0.35 * smoothstep(0.0, 0.5, vane) + (barb - 0.5) * 0.1;
    crH = vane; crBump = 0.5; rough = 0.75;
  } else if (integ == 4) { // slime: wet, mottled, glossy
    float mo = cr_fbm(vRest * 18.0);
    col *= 0.85 + mo * 0.3;
    crH = mo; crBump = 0.25; rough = 0.12 + mo * 0.15;
  } else if (integ == 5) { // crystal: facets & inner glow
    vec3 cl = cr_cell(vRest * 9.0);
    col = mix(col, col * 1.4 + 0.08, cl.z * 0.4);
    crFacet = 0.85; rough = 0.06;
    crEmis += uBase * 0.08 * (0.5 + cl.z);
  } else if (integ == 6) { // bark: ridges along the axis, moss on top
    float r = abs(cr_noise(vec3(vRest.x * 26.0, vRest.y * 26.0, vRest.z * 5.0)) * 2.0 - 1.0);
    crH = 1.0 - r; crBump = 1.4;
    col *= 0.55 + 0.6 * (1.0 - r);
    float moss = smoothstep(0.45, 0.9, vRestN.y) * smoothstep(0.45, 0.7, cr_fbm(vRest * 12.0));
    col = mix(col, vec3(0.16, 0.26, 0.08), moss * 0.8);
    rough = 0.95;
  } else { // stone: cracked blocks with glowing seams
    vec3 cl = cr_cell(vRest * 7.0);
    float crack = 1.0 - smoothstep(0.0, 0.05, cl.y - cl.x);
    col *= 0.75 + 0.35 * cr_fbm(vRest * 25.0) - crack * 0.4;
    crH = (1.0 - crack) * (0.6 + 0.4 * cr_noise(vRest * 40.0)); crBump = 1.0; rough = 0.9;
    crEmis += uGlowColor * crack * uGlowAmount * (0.6 + 0.4 * sin(uTime * 1.7 + cl.z * 6.0)) * 1.5;
  }
  // --- parts
  vec3 ker = uKeratin * (0.8 + 0.25 * cr_noise(vRest * vec3(10.0, 80.0, 10.0)));
  col = mix(col, ker, vPart.x);
  rough = mix(rough, 0.35, vPart.x);
  vec3 shc = vPart.y > 0.01 ? cr_cell(vRest * 12.0) : vec3(0.0, 1.0, 0.0);
  vec3 shell = mix(uSecondary, uBase, 0.35) * (0.7 + 0.4 * smoothstep(0.0, 0.3, shc.y - shc.x));
  col = mix(col, shell, vPart.y);
  rough = mix(rough, 0.35, vPart.y);
  col = mix(col, vec3(0.32, 0.1, 0.12), vPart.w * 0.85);
  col = mix(col, uGlowColor * 0.6 + 0.2, vPart.z);
  // --- bioluminescence
  float glow = 0.0;
  int gs = int(uGlowStyle + 0.5);
  // Skip the cellular evaluation entirely when nothing would glow (daylight / no biolum).
  if (uGlowAmount * uGlowLevel < 0.01) gs = 3;
  if (gs == 0) { vec3 cl = cr_cell(vRest * 16.0 + uSeedOff); glow = (1.0 - smoothstep(0.08, 0.16, cl.x)) * step(0.45, cl.z) * smoothstep(0.6, -0.2, vRestN.y + 0.3); }
  else if (gs == 1) { glow = (1.0 - smoothstep(0.0, 0.05, abs(fract(vRest.z * 4.0 + vRest.y * 0.5) - 0.5) - 0.42)) * smoothstep(-0.5, 0.3, abs(vRestN.x)); }
  else if (gs == 2) { glow = 0.35 + 0.25 * sin(uTime * 1.3 + vRest.y * 6.0); }
  float pulse = 0.75 + 0.25 * sin(uTime * 2.1 + uSeedOff.z * 10.0 + vRest.z * 3.0);
  crEmis += uGlowColor * glow * uGlowAmount * uGlowLevel * pulse * 2.2;
  crEmis += uGlowColor * vPart.z * (0.4 + 1.6 * uGlowLevel) * pulse;
  // Hurt flash & death pallor.
  crEmis += vec3(0.6, 0.05, 0.02) * uHurt;
  col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))) * 0.8, uDead * 0.5);
  diffuseColor.rgb = col;
  if (uTranslucent > 0.5) diffuseColor.a = 0.55 + 0.35 * vPart.z + 0.15 * smoothstep(0.0, 1.0, abs(vRestN.y));
  crRough = rough;
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = crRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (crBump > 0.0) normal = cr_perturb(-vViewPosition, normal, crH, crBump * 0.012, faceDirection);
if (crFacet > 0.0) { vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))); normal = normalize(mix(normal, fn, crFacet)); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += crEmis;
{
  // Iridescent sheen (beetles, starling feathers) & fur rim fuzz.
  float nv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  vec3 irid = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + nv * 1.6 + vRest.z * 0.6));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * irid * 1.4, uSheen * (1.0 - nv) * 0.8);
  if (int(uInteg + 0.5) == 0) diffuseColor.rgb *= 1.0 + pow(1.0 - nv, 3.0) * 0.35;
  if (uTranslucent > 0.5) totalEmissiveRadiance += diffuseColor.rgb * pow(1.0 - nv, 2.0) * 0.25;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'creatureBody';
  const sky = patchSkyOcclusion(mat, 'uniform');
  if (sky.uniform) u.skyVis.push(sky.uniform);
  return mat;
}

// ------------------------------------------------------------------ membranes

export function createMembraneMaterial(sp: Species, seed: number, u: CreatureUniforms): THREE.MeshStandardMaterial {
  const c = sp.colors;
  const insect = sp.wings.kind === 'insect';
  const mat = new THREE.MeshStandardMaterial({
    roughness: insect ? 0.15 : 0.7,
    side: THREE.DoubleSide,
    transparent: insect || sp.translucent || sp.fins.tail > 0 || sp.fins.dorsal > 0,
    depthWrite: !insect,
    alphaTest: 0.02,
  });
  const col = (rgb: [number, number, number]) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  const uniforms = {
    uBase: { value: col(c.base) },
    uSecondary: { value: col(c.secondary) },
    uAccent: { value: col(c.accent) },
    uGlowColor: { value: col(c.glow) },
    uGlowAmount: { value: c.glowAmount },
    uSheen: { value: c.sheen },
    uGlowLevel: u.glowLevel,
    uHurt: u.hurt,
    uTime: u.time,
    uSeedF: { value: hashToFloat(hash32(seed)) },
    uEyes: { value: c.pattern === 'eyespots' ? 1 : 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMem;\nvarying vec3 vMem;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMem = aMem;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uBase, uSecondary, uAccent, uGlowColor;
uniform float uGlowAmount, uSheen, uGlowLevel, uHurt, uTime, uSeedF, uEyes;
varying vec3 vMem;
${GLSL_NOISE}
vec3 crEmis = vec3(0.0);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float uu = vMem.x, vv = vMem.y; int style = int(vMem.z + 0.5);
  vec3 col = uBase; float a = 1.0;
  if (style == 0) { // leathery wing membrane with finger rays & veins
    float ray = 1.0 - smoothstep(0.0, 0.02, abs(fract(uu * 3.5 + vv * 0.3) - 0.5) - 0.47);
    float vein = 1.0 - smoothstep(0.0, 0.015, abs(cr_noise(vec3(uu * 14.0, vv * 6.0, uSeedF * 9.0)) - 0.5));
    col = mix(uBase * 0.55, uSecondary * 0.7, vv * 0.6) * (1.0 - vein * 0.25) + ray * 0.05;
    a = 0.97;
  } else if (style == 1) { // feathers: separated vanes, notched tips, barring
    float n = 9.0;
    float f = fract(uu * n);
    float sep = smoothstep(0.0, 0.08, f) * smoothstep(1.0, 0.9, f);
    float tip = 1.0 - smoothstep(0.86, 1.0, vv + (0.5 - abs(f - 0.5)) * 0.25);
    float bar = step(0.5, fract(vv * 5.0 + uu * 2.0));
    col = mix(uBase, uSecondary, smoothstep(0.4, 1.0, vv)) * (0.8 + 0.2 * sep) * (1.0 - bar * 0.18);
    col = mix(col, uAccent, smoothstep(0.82, 0.95, uu) * 0.6);
    if (uEyes > 0.5) { float d = length(vec2(f - 0.5, (vv - 0.75) * 2.0)); col = mix(col, uAccent, 1.0 - smoothstep(0.18, 0.22, d)); col = mix(col, vec3(0.05), 1.0 - smoothstep(0.08, 0.11, d)); }
    a = tip;
  } else if (style == 2) { // insect wing: transparent with vein network & thin-film colours
    vec3 cl = cr_cell(vec3(uu * 9.0, vv * 5.0, uSeedF * 7.0));
    float vein = 1.0 - smoothstep(0.0, 0.035, cl.y - cl.x);
    float edge = smoothstep(0.88, 1.0, vv) + (1.0 - smoothstep(0.0, 0.05, vv));
    vec3 film = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + uu * 1.5 + vv));
    col = mix(film * 0.6 + 0.3, uSecondary * 0.3, vein);
    a = 0.18 + vein * 0.7 + edge * 0.4;
    if (uEyes > 0.5) { float d = length(vec2((uu - 0.65) * 2.0, vv - 0.5)); col = mix(col, uAccent, 1.0 - smoothstep(0.2, 0.24, d)); a = max(a, 1.0 - smoothstep(0.2, 0.24, d)); }
  } else { // fin: rays with translucent webbing
    float ray = 1.0 - smoothstep(0.0, 0.1, abs(fract(uu * 12.0) - 0.5) - 0.38);
    col = mix(uSecondary, uBase, 0.4) * (0.75 + ray * 0.35);
    a = 0.55 + ray * 0.4 - smoothstep(0.85, 1.0, vv) * 0.3;
    crEmis += uGlowColor * ray * uGlowAmount * uGlowLevel * 0.6;
  }
  crEmis += vec3(0.6, 0.05, 0.02) * uHurt;
  diffuseColor.rgb = col;
  diffuseColor.a *= a;
}`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += crEmis;');
  };
  mat.customProgramCacheKey = () => 'creatureMembrane';
  const sky = patchSkyOcclusion(mat, 'uniform');
  if (sky.uniform) u.skyVis.push(sky.uniform);
  return mat;
}

// ------------------------------------------------------------------ eyes

export function createEyeMaterial(sp: Species, u: CreatureUniforms): THREE.MeshStandardMaterial {
  const c = sp.colors;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.06, metalness: 0 });
  const uniforms = {
    uIris: { value: new THREE.Color().setRGB(c.eye[0], c.eye[1], c.eye[2], THREE.SRGBColorSpace) },
    uPupil: { value: PUPIL_ID[sp.head.pupil] ?? 0 },
    uGlowColor: { value: new THREE.Color().setRGB(c.glow[0], c.glow[1], c.glow[2], THREE.SRGBColorSpace) },
    uShine: { value: sp.activity === 'nocturnal' || sp.activity === 'crepuscular' ? 1 : 0.25 },
    uGlowLevel: u.glowLevel,
    uDead: u.dead,
    uDilate: { value: 0.5 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEye;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEye = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uIris, uGlowColor; uniform float uPupil, uShine, uGlowLevel, uDead, uDilate;
varying vec3 vEye;
${GLSL_NOISE}
vec3 crEmis = vec3(0.0);`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 e = normalize(vEye);
  int pu = int(uPupil + 0.5);
  vec3 col;
  float dil = mix(0.6, 1.4, uGlowLevel) * (1.0 + uDead);
  if (pu == 3) { // compound eye: hexagonal ommatidia with a sheen
    vec3 cl = cr_cell(e * 14.0);
    col = uIris * (0.4 + 0.8 * smoothstep(0.0, 0.25, cl.y - cl.x)) + cl.z * 0.05;
    crEmis += uIris * uGlowLevel * 0.15;
  } else if (pu == 4) { // construct: glowing gem
    col = uGlowColor * 0.6;
    crEmis += uGlowColor * (1.2 + 0.4 * sin(e.x * 10.0)) * (1.0 - uDead);
  } else {
    float ang = acos(clamp(e.z, -1.0, 1.0));
    float iris = 1.0 - smoothstep(0.95, 1.05, ang);
    float rings = cr_noise(vec3(atan(e.y, e.x) * 6.0, ang * 30.0, 1.0));
    col = mix(vec3(0.75, 0.68, 0.6) * 0.6, uIris * (0.7 + rings * 0.5) * (1.2 - ang * 0.4), iris);
    float pupil;
    if (pu == 1) pupil = 1.0 - smoothstep(0.0, 0.05, abs(e.x) * 3.2 / dil + abs(e.y) * 0.45 - 0.22);
    else if (pu == 2) pupil = 1.0 - smoothstep(0.0, 0.05, abs(e.y) * 3.2 / dil + abs(e.x) * 0.45 - 0.22);
    else pupil = 1.0 - smoothstep(0.32, 0.38, ang / (0.6 * dil));
    pupil *= step(0.0, e.z);
    col = mix(col, vec3(0.01), pupil);
    // Tapetum eyeshine at night.
    crEmis += uIris * pupil * uShine * uGlowLevel * 0.6 * (1.0 - uDead);
  }
  col *= 1.0 - uDead * 0.6;
  diffuseColor.rgb = col;
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.04, 0.6, uDead);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += crEmis;');
  };
  mat.customProgramCacheKey = () => 'creatureEye';
  const sky = patchSkyOcclusion(mat, 'uniform');
  if (sky.uniform) u.skyVis.push(sky.uniform);
  return mat;
}

/** Fresh runtime uniform bundle for one creature view. */
export function makeCreatureUniforms(): CreatureUniforms {
  return { glowLevel: { value: 0 }, hurt: { value: 0 }, time: { value: 0 }, skyVis: [], dead: { value: 0 } };
}
