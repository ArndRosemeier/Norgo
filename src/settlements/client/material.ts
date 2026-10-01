/**
 * Shared settlement materials.
 *
 * All settlement geometry (buildings, props, POI structures) is drawn with ONE
 * MeshStandardMaterial whose shader is patched to read per-vertex surface
 * layers from the procedural texture arrays (textures.ts). That keeps a whole
 * tile of a town to a single draw call.
 *
 * Vertex attributes (all required):
 *  - position, normal
 *  - uv      vec2   planar UV in tile units (meters / SURF_TILE[surf])
 *  - color   vec3   linear RGB tint (vertexColors)
 *  - aLayer  float  Surf id (texture-array layer)
 *  - aEmit   vec4   rgb = linear emissive radiance / EMIT_SCALE (premultiplied intensity; stored as
 *                   normalized Uint8), w = 1 → night only, 0 → always
 *  - skyVis  float  sky visibility 0..1 (see render/skyOcclusion.ts; interiors < 1)
 *
 * Uniforms: uNight (0 day … 1 night) scales night-only emission, uTime (s).
 */
import * as THREE from 'three';
import { patchSkyOcclusion } from '../../render/skyOcclusion';
import { getSettlementTextures, layerMeanColors } from './textures';
import { SURF_COUNT, Surf } from '../build/kit';

export interface SettlementMaterialHandle {
  material: THREE.MeshStandardMaterial;
  uniforms: { uNight: { value: number }; uTime: { value: number } };
}

/** Emissive radiance is stored as normalized bytes divided by this factor. */
export const EMIT_SCALE = 8;

const VERT_HEAD = /* glsl */ `
attribute float aLayer;
attribute vec4 aEmit;
varying vec2 vTexUv;
flat varying float vLayer;
varying vec4 vEmit;
`;

const VERT_BODY = /* glsl */ `
vTexUv = uv;
vLayer = floor(aLayer + 0.5);
vEmit = vec4(aEmit.rgb * ${EMIT_SCALE.toFixed(1)}, aEmit.w);
`;

const FRAG_HEAD = /* glsl */ `
uniform highp sampler2DArray uAlbedoArr;
uniform highp sampler2DArray uNormalArr;
uniform float uNight;
uniform float uTime;
varying vec2 vTexUv;
flat varying float vLayer;
varying vec4 vEmit;
`;

/** Shared shader-chunk replacement for the emission term. `glassMask` is an expression for window panes. */
function emissionChunk(glassMask: string) {
  return /* glsl */ `
{
  float nightGate = mix(1.0, uNight, vEmit.w);
  float pane = (abs(vLayer - ${Surf.Window.toFixed(1)}) < 0.5) ? ${glassMask} : 1.0;
  totalEmissiveRadiance += vEmit.rgb * nightGate * pane;
}
`;
}

/**
 * The full-detail settlement material (texture arrays + derivative normal mapping).
 * `skyVisMode` is fixed to 'attribute' (per-vertex interior darkening).
 */
export function createSettlementMaterial(opts: { skyVisMode?: 'attribute' } = {}): SettlementMaterialHandle {
  const tex = getSettlementTextures();
  const uniforms = { uNight: { value: 0 }, uTime: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  material.name = 'settlement';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAlbedoArr = { value: tex.albedo };
    shader.uniforms.uNormalArr = { value: tex.normal };
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
vec4 sAlb = texture(uAlbedoArr, vec3(vTexUv, vLayer));
vec4 sNrm = texture(uNormalArr, vec3(vTexUv, vLayer));
float sAO = sNrm.a;
diffuseColor.rgb *= sAlb.rgb * mix(1.0, sAO, 0.55);
`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * max(sAlb.a, 0.04);')
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = (abs(vLayer - ${Surf.Metal.toFixed(1)}) < 0.5) ? 0.3 : metalness;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
{
  // Cotangent frame from screen-space derivatives (no tangent attribute needed).
  vec3 mapN = sNrm.xyz * 2.0 - 1.0;
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  vec2 st0 = dFdx(vTexUv), st1 = dFdy(vTexUv);
  vec3 q1perp = cross(q1, normal), q0perp = cross(normal, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = (det == 0.0) ? 0.0 : inversesqrt(det);
  normal = normalize(mat3(T * sc, B * sc, normal) * mapN);
}
`,
      )
      .replace('#include <emissivemap_fragment>', emissionChunk('smoothstep(0.012, 0.03, dot(sAlb.rgb, vec3(0.333)))'))
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= sAO;',
      );
  };
  material.customProgramCacheKey = () => 'norgo-settlement-v1';
  patchSkyOcclusion(material, opts.skyVisMode ?? 'attribute');
  return { material, uniforms };
}

/**
 * Cheap far-LOD material: same vertex layout, but each layer is a flat mean
 * colour (no texture fetches, no normal mapping). Emission keeps towns
 * twinkling at night from a distance.
 */
export function createSettlementFarMaterial(): SettlementMaterialHandle {
  const means = layerMeanColors();
  const cols: THREE.Vector3[] = [];
  for (let i = 0; i < SURF_COUNT; i++) cols.push(new THREE.Vector3(means[i * 3], means[i * 3 + 1], means[i * 3 + 2]));
  const uniforms = { uNight: { value: 0 }, uTime: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  material.name = 'settlement-far';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLayerCol = { value: cols };
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform vec3 uLayerCol[${SURF_COUNT}];\nuniform float uNight;\nuniform float uTime;\nvarying vec2 vTexUv;\nflat varying float vLayer;\nvarying vec4 vEmit;\n`,
      )
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= uLayerCol[int(vLayer)];')
      .replace('#include <emissivemap_fragment>', emissionChunk('0.7'));
  };
  material.customProgramCacheKey = () => 'norgo-settlement-far-v1';
  patchSkyOcclusion(material, 'attribute');
  return { material, uniforms };
}

export { layerMeanColors };
