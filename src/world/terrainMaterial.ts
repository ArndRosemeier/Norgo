/**
 * Terrain material: MeshStandardMaterial extended with
 *  - triplanar sampling of per-world synthesized texture arrays
 *  - 3-way material blending per triangle (height-aware)
 *  - vertex AO and sky visibility (dark caves)
 *  - emissive materials (crystal, magma, mycelium spots)
 *  - shoreline wetness and macro variation against tiling
 */
import * as THREE from 'three';
import { MATERIALS, MAT_COUNT } from './materials';
import type { TerrainTextureData } from './terrainTextures';
import { patchSkyOcclusion } from '../render/skyOcclusion';
import { SEA_LEVEL } from './constants';

export interface TerrainMaterialHandle {
  material: THREE.MeshStandardMaterial;
  depthMaterial: THREE.MeshDepthMaterial;
  uniforms: {
    uTime: { value: number };
    uWetness: { value: number };
  };
}

export function createTerrainTextures(data: TerrainTextureData): { albedo: THREE.DataArrayTexture; normal: THREE.DataArrayTexture } {
  const albedo = new THREE.DataArrayTexture(data.albedo, data.size, data.size, data.layers);
  albedo.format = THREE.RGBAFormat;
  albedo.type = THREE.UnsignedByteType;
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.magFilter = THREE.LinearFilter;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.generateMipmaps = true;
  albedo.anisotropy = 8;
  albedo.needsUpdate = true;
  const normal = new THREE.DataArrayTexture(data.normal, data.size, data.size, data.layers);
  normal.format = THREE.RGBAFormat;
  normal.type = THREE.UnsignedByteType;
  normal.colorSpace = THREE.NoColorSpace;
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.magFilter = THREE.LinearFilter;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.generateMipmaps = true;
  normal.anisotropy = 8;
  normal.needsUpdate = true;
  return { albedo, normal };
}

/** Texture tiling (meters per tile) per material style. */
function tileSize(i: number): number {
  const s = MATERIALS[i].style;
  switch (s) {
    case 'rock': return 6;
    case 'strata': return 9;
    case 'grass': return 3.5;
    case 'sand': return 5;
    case 'cobble': return 3;
    case 'gravel': return 2.2;
    case 'crystal': return 4;
    case 'marble': return 6;
    case 'ice': return 8;
    default: return 3.5;
  }
}

export function createTerrainMaterial(tex: { albedo: THREE.Texture; normal: THREE.Texture }): TerrainMaterialHandle {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uniforms = {
    tAlbedo: { value: tex.albedo },
    tNormal: { value: tex.normal },
    uScale: { value: Array.from({ length: MAT_COUNT }, (_, i) => 1 / tileSize(i)) },
    uEmis: {
      value: MATERIALS.map((m) => new THREE.Vector3(...m.emissiveColor).multiplyScalar(m.emissive)),
    },
    uTime: { value: 0 },
    uWetness: { value: 0 },
    uSea: { value: SEA_LEVEL },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 mats;
attribute float skyVis;
varying vec3 vWPos;
varying vec3 vWNormal;
flat varying vec3 vMats;
varying vec3 vBary;
varying float vAO;
varying float vSkyVis;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * normal);
vMats = mats.xyz;
int corner = gl_VertexID % 3;
vBary = vec3(corner == 0 ? 1.0 : 0.0, corner == 1 ? 1.0 : 0.0, corner == 2 ? 1.0 : 0.0);
vAO = mats.w / 255.0;
vSkyVis = clamp(skyVis, 0.0, 1.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tNormal;
uniform float uScale[${MAT_COUNT}];
uniform vec3 uEmis[${MAT_COUNT}];
uniform float uTime;
uniform float uWetness;
uniform float uSea;
varying vec3 vWPos;
varying vec3 vWNormal;
flat varying vec3 vMats;
varying vec3 vBary;
varying float vAO;
vec3 gTerrN;
float gTerrRough;
vec3 gTerrEmis;

struct TerrSample { vec3 albedo; float rough; vec3 n; float h; float emit; };

TerrSample sampleMat(float layer, vec3 p, vec3 wn, vec3 blend) {
  float s = uScale[int(layer + 0.5)];
  vec3 uvX = vec3(p.zy * s, layer);
  vec3 uvY = vec3(p.xz * s, layer);
  vec3 uvZ = vec3(p.xy * s, layer);
  vec4 aX = texture(tAlbedo, uvX), aY = texture(tAlbedo, uvY), aZ = texture(tAlbedo, uvZ);
  vec4 nX = texture(tNormal, uvX), nY = texture(tNormal, uvY), nZ = texture(tNormal, uvZ);
  TerrSample o;
  vec4 a = aX * blend.x + aY * blend.y + aZ * blend.z;
  o.albedo = a.rgb;
  o.rough = a.a;
  // UDN normal blending.
  vec2 tx = nX.xy * 2.0 - 1.0, ty = nY.xy * 2.0 - 1.0, tz = nZ.xy * 2.0 - 1.0;
  vec3 nnX = vec3(tx + wn.zy, wn.x);
  vec3 nnY = vec3(ty + wn.xz, wn.y);
  vec3 nnZ = vec3(tz + wn.xy, wn.z);
  o.n = normalize(nnX.zyx * blend.x + nnY.xzy * blend.y + nnZ.xyz * blend.z);
  o.h = nX.z * blend.x + nY.z * blend.y + nZ.z * blend.z;
  o.emit = nX.w * blend.x + nY.w * blend.y + nZ.w * blend.z;
  return o;
}
`,
      )
      .replace(
        '#include <map_fragment>',
        `
{
  vec3 wn = normalize(vWNormal);
  vec3 blend = pow(abs(wn), vec3(4.0));
  blend /= (blend.x + blend.y + blend.z);
  vec3 p = vWPos;
  TerrSample s0 = sampleMat(vMats.x, p, wn, blend);
  TerrSample res = s0;
  float w0 = 1.0, w1 = 0.0, w2 = 0.0;
  if (vMats.y != vMats.x || vMats.z != vMats.x) {
    TerrSample s1 = sampleMat(vMats.y, p, wn, blend);
    TerrSample s2 = sampleMat(vMats.z, p, wn, blend);
    // Height-aware blending: crisp, natural transitions between materials.
    vec3 hw = vBary + vec3(s0.h, s1.h, s2.h) * 0.6;
    float mx = max(hw.x, max(hw.y, hw.z)) - 0.25;
    vec3 bw = max(hw - mx, vec3(0.0));
    bw /= (bw.x + bw.y + bw.z + 1e-5);
    w0 = bw.x; w1 = bw.y; w2 = bw.z;
    res.albedo = s0.albedo * w0 + s1.albedo * w1 + s2.albedo * w2;
    res.rough = s0.rough * w0 + s1.rough * w1 + s2.rough * w2;
    res.n = normalize(s0.n * w0 + s1.n * w1 + s2.n * w2);
    res.emit = 0.0;
    gTerrEmis = uEmis[int(vMats.x + 0.5)] * s0.emit * w0 + uEmis[int(vMats.y + 0.5)] * s1.emit * w1 + uEmis[int(vMats.z + 0.5)] * s2.emit * w2;
  } else {
    gTerrEmis = uEmis[int(vMats.x + 0.5)] * s0.emit;
  }
  // Close-range detail: the dominant material at 4x frequency, normalised by its average
  // colour (lowest mip), adds crisp micro structure where the base texels get blurry.
  float camDist = length(vWPos - cameraPosition);
  float detailFade = 1.0 - smoothstep(10.0, 28.0, camDist);
  if (detailFade > 0.01) {
    float dl = (w0 >= w1 && w0 >= w2) ? vMats.x : (w1 >= w2 ? vMats.y : vMats.z);
    float ds = uScale[int(dl + 0.5)] * 4.0;
    vec3 dA = texture(tAlbedo, vec3(p.zy * ds, dl)).rgb * blend.x + texture(tAlbedo, vec3(p.xz * ds, dl)).rgb * blend.y + texture(tAlbedo, vec3(p.xy * ds, dl)).rgb * blend.z;
    vec3 avg = textureLod(tAlbedo, vec3(0.5, 0.5, dl), 12.0).rgb;
    float ratio = dot(dA, vec3(0.299, 0.587, 0.114)) / max(0.04, dot(avg, vec3(0.299, 0.587, 0.114)));
    res.albedo *= mix(1.0, clamp(ratio, 0.55, 1.6), 0.55 * detailFade);
    vec2 dn = (texture(tNormal, vec3(p.xz * ds, dl)).xy * 2.0 - 1.0) * blend.y + (texture(tNormal, vec3(p.zy * ds, dl)).xy * 2.0 - 1.0) * blend.x;
    res.n = normalize(res.n + vec3(dn.x, 0.0, dn.y) * 0.35 * detailFade);
  }
  // Macro variation breaks up tiling at distance.
  float macro = texture(tNormal, vec3(p.xz * 0.0071, 2.0)).z * 0.6 + texture(tNormal, vec3(p.xz * 0.0013 + 0.3, 3.0)).z * 0.4;
  res.albedo *= mix(0.78, 1.18, macro);
  // Shoreline / rain wetness: darker, glossier.
  float wet = max(uWetness, 1.0 - smoothstep(uSea + 0.1, uSea + 1.6, p.y)) * step(0.0, wn.y);
  res.albedo *= mix(1.0, 0.55, wet);
  res.rough = mix(res.rough, 0.15, wet * 0.85);
  diffuseColor.rgb *= res.albedo;
  gTerrRough = res.rough;
  gTerrN = res.n;
}
`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * gTerrRough;')
      .replace(
        '#include <normal_fragment_maps>',
        'normal = normalize((viewMatrix * vec4(gTerrN, 0.0)).xyz);\n',
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gTerrEmis * 2.0;')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
float tAO = vAO * vAO;
reflectedLight.indirectDiffuse *= tAO;
reflectedLight.indirectSpecular *= tAO;
reflectedLight.directDiffuse *= mix(1.0, tAO, 0.35);`,
      );
  };
  material.customProgramCacheKey = () => 'norgo-terrain';
  patchSkyOcclusion(material, 'varying');

  // Depth material for shadows: default is fine (positions only).
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  return { material, depthMaterial, uniforms };
}

/** Build a BufferGeometry from a worker chunk mesh. */
export function buildTerrainGeometry(positions: Float32Array, normals: Int8Array, mats: Uint8Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const ib = new THREE.InterleavedBuffer(normals, 4);
  g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 0, true));
  g.setAttribute('skyVis', new THREE.InterleavedBufferAttribute(ib, 1, 3, true));
  g.setAttribute('mats', new THREE.BufferAttribute(mats, 4, false));
  return g;
}
