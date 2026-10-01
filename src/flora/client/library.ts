/**
 * FloraLibrary: per-world cache of flora geometry (per species × variant ×
 * ground material × detail tier), the shared materials, and tree impostors.
 *
 * Geometry is built lazily the first time a chunk needs it; impostors are
 * captured on demand into a render-target atlas (8×8 cells) the first time an
 * LOD-3 chunk shows a tree species.
 */
import * as THREE from 'three';
import type { WorldProfile } from '../../world/profile';
import { MATERIALS, Mat } from '../../world/materials';
import { materialColors } from '../../world/terrainTextures';
import { getFloraCatalog, FloraCatalog, FloraSpecies, usesGroundMaterial } from '../species';
import { patchSkyOcclusion } from '../../render/skyOcclusion';
import { getFloraAtlas, FloraAtlas, ATLAS_COLS, ATLAS_ROWS, CELL_PX } from './atlas';
import { createFloraMaterial, createFloraDepthMaterial, createFloraShared, FloraMatKind, FloraShared } from './material';
import { GeoBuilder, V3, lin, style } from './geo';
import { growTree, meshTree, skeletonBounds, Skeleton } from './trees';
import { buildPlant, buildRock } from './plants';

export const IMPOSTOR_COLS = 8;
export const IMPOSTOR_ROWS = 8;
const IMP_PX = 256;

export interface FloraGeometry {
  geo: THREE.BufferGeometry;
  kind: FloraMatKind;
  /** Height and radius in reference units (for colliders, impostors, debris). */
  height: number;
  radius: number;
}

export class FloraLibrary {
  readonly cat: FloraCatalog;
  readonly shared: FloraShared;
  readonly atlas: FloraAtlas;
  readonly materials: Record<FloraMatKind, THREE.MeshStandardMaterial>;
  readonly depthMaterials: Record<FloraMatKind, THREE.MeshDepthMaterial>;
  private geos = new Map<string, FloraGeometry>();
  private skels = new Map<string, Skeleton>();
  private impostorRT: THREE.WebGLRenderTarget | null = null;
  private impostorCells = new Map<string, number>();
  private impostorMaterial: THREE.MeshStandardMaterial | null = null;
  private impostorDepth: THREE.MeshDepthMaterial | null = null;
  private captureScene: THREE.Scene | null = null;
  private captureMat: THREE.ShaderMaterial | null = null;
  private singleCache = new Map<string, THREE.MeshStandardMaterial>();
  private plainCache = new Map<string, THREE.MeshStandardMaterial>();

  constructor(readonly profile: WorldProfile, private renderer: THREE.WebGLRenderer | null) {
    this.cat = getFloraCatalog(profile);
    this.shared = createFloraShared();
    this.atlas = getFloraAtlas(profile.floraSeed);
    const kinds: FloraMatKind[] = ['foliage', 'grass', 'rock', 'crystal'];
    this.materials = {} as Record<FloraMatKind, THREE.MeshStandardMaterial>;
    this.depthMaterials = {} as Record<FloraMatKind, THREE.MeshDepthMaterial>;
    for (const k of kinds) {
      this.materials[k] = createFloraMaterial(k, this.shared, this.atlas.texture, this.atlas.rockTexture);
      this.depthMaterials[k] = createFloraDepthMaterial(k, this.shared, this.atlas.texture);
    }
    // Impostors share the foliage shader with their own atlas (assigned once the RT exists).
    this.materials.impostor = this.materials.foliage;
    this.depthMaterials.impostor = this.depthMaterials.foliage;
  }

  species(idx: number): FloraSpecies {
    return this.cat.species[idx];
  }

  /** Material family of a species. */
  matKindOf(sp: FloraSpecies): FloraMatKind {
    if (usesGroundMaterial(sp)) return 'rock';
    if (sp.form === 'crystal' || sp.form === 'glasstree') return 'crystal';
    if (sp.cls === 'grass' || (sp.layer === 2 && (sp.cls === 'plant' || sp.form === 'lilypad'))) return 'grass';
    return 'foliage';
  }

  /** Ground-material colors for rocks (match the terrain cliffs of that material). */
  rockColors(mat: number): [V3, V3] {
    const def = MATERIALS[mat] ?? MATERIALS[Mat.Stone];
    const c = materialColors(def, this.profile);
    return [lin(c.color), lin(c.color2)];
  }

  skeleton(sp: FloraSpecies, variant: number): Skeleton {
    const key = sp.idx + ':' + variant;
    let s = this.skels.get(key);
    if (!s) this.skels.set(key, (s = growTree(sp, variant)));
    return s;
  }

  /** Geometry for a species at a detail tier (0..2). */
  geometry(spIdx: number, variant: number, mat: number, tier: number): FloraGeometry {
    const sp = this.cat.species[spIdx];
    const rockLike = usesGroundMaterial(sp);
    const key = spIdx + ':' + variant + ':' + (rockLike ? mat : -1) + ':' + tier;
    let g = this.geos.get(key);
    if (g) return g;
    let gb: GeoBuilder;
    let height = sp.size, radius = sp.size * 0.5;
    if (sp.cls === 'tree') {
      const sk = this.skeleton(sp, variant);
      gb = meshTree(sp, sk, tier);
      const b = skeletonBounds(sk);
      height = b.height;
      radius = b.radius;
    } else if (rockLike) {
      const [a, b] = this.rockColors(mat < 0 ? Mat.Stone : mat);
      gb = buildRock(sp, variant, tier, a, b);
    } else {
      gb = buildPlant(sp, variant, tier);
    }
    const geo = gb.toGeometry();
    geo.name = 'flora:' + sp.key + ':' + tier;
    g = { geo, kind: this.matKindOf(sp), height, radius };
    this.geos.set(key, g);
    return g;
  }

  // ------------------------------------------------------------------ impostors

  /** Impostor geometry (crossed quads) for a tree species variant; captures on first use. Null without a renderer. */
  impostor(spIdx: number, variant: number): FloraGeometry | null {
    if (!this.renderer) return null;
    const sp = this.cat.species[spIdx];
    const key = 'imp:' + spIdx + ':' + variant;
    const hit = this.geos.get(key);
    if (hit) return hit;
    const cell = this.captureImpostor(sp, variant);
    if (cell < 0) return null;
    const base = this.geometry(spIdx, variant, -1, 0);
    const H = base.height + 0.6, R = base.radius * 1.05;
    const gb = new GeoBuilder();
    gb.bendFn = (p) => 0.022 * H * Math.pow(Math.max(0, p[1]) / H, 2);
    const s = style({ a: [1, 1, 1], b: [1, 1, 1], cell, flutter: 0.15 });
    const cy = H * 0.55;
    for (let k = 0; k < 2; k++) {
      const ang = k * Math.PI * 0.5;
      const rx = Math.cos(ang), rz = Math.sin(ang);
      const v = (x: number, y: number, u: number, vv: number) => {
        const p: V3 = [rx * x, y, rz * x];
        // Spherical normals give the flat cards a volumetric shading.
        const nn: V3 = [p[0] / R, (y - cy) / H, p[2] / R];
        const l = Math.hypot(nn[0], nn[1] + 0.6, nn[2]) || 1;
        return gb.vertex(p, [nn[0] / l, (nn[1] + 0.6) / l, nn[2] / l], u, vv, s);
      };
      const a = v(-R, -0.6, 0, 0), b = v(R, -0.6, 1, 0), c = v(R, H - 0.6, 1, 1), d = v(-R, H - 0.6, 0, 1);
      gb.quad(a, b, c, d);
    }
    const geo = gb.toGeometry();
    const g: FloraGeometry = { geo, kind: 'impostor', height: H, radius: R };
    this.geos.set(key, g);
    return g;
  }

  private ensureImpostorTarget() {
    if (this.impostorRT) return;
    const rt = new THREE.WebGLRenderTarget(IMPOSTOR_COLS * IMP_PX, IMPOSTOR_ROWS * IMP_PX, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    this.impostorRT = rt;
    // Impostor material: foliage shader reading the impostor atlas (8×8 cells, color = albedo).
    const m = createFloraMaterial('impostor', this.shared, rt.texture, this.atlas.rockTexture);
    m.defines = { ...m.defines, FLORA_IMPOSTOR: '' };
    this.patchImpostorRows(m);
    const d = createFloraDepthMaterial('impostor', this.shared, rt.texture);
    this.patchImpostorRows(d);
    this.impostorMaterial = m;
    this.impostorDepth = d;
    this.materials.impostor = m;
    this.depthMaterials.impostor = d;
    // Capture material: albedo of the atlas with vertex colors, no lighting.
    this.captureMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.atlas.texture } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor2;
        attribute float aCell;
        attribute vec4 aWind;
        varying vec3 vA; varying vec3 vB; varying vec2 vUvL; varying float vCell; varying float vShade;
        void main() {
          vA = color; vB = aColor2; vUvL = uv; vCell = aCell;
          // Baked crown self-shadowing: darker low and inside.
          vShade = 0.72 + 0.28 * clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec3 vA; varying vec3 vB; varying vec2 vUvL; varying float vCell; varying float vShade;
        void main() {
          vec2 cs = vec2(1.0 / ${ATLAS_COLS}.0, 1.0 / ${ATLAS_ROWS}.0);
          vec2 org = vec2(mod(vCell, ${ATLAS_COLS}.0), floor(vCell / ${ATLAS_COLS}.0 + 0.001)) * cs;
          float pad = ${(2 / CELL_PX).toFixed(6)};
          vec2 inner = cs * (1.0 - 2.0 * pad);
          vec2 auv = org + cs * pad + fract(vUvL) * inner;
          vec4 t = textureGrad(map, auv, dFdx(vUvL) * inner, dFdy(vUvL) * inner);
          if (t.a < 0.5) discard;
          vec3 c = mix(vA, vB, t.g) * t.r * 1.15 * vShade;
          gl_FragColor = vec4(c, 1.0);
        }`,
      vertexColors: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.captureScene = new THREE.Scene();
  }

  private patchImpostorRows(m: THREE.Material) {
    const prev = m.onBeforeCompile.bind(m);
    m.onBeforeCompile = (shader, r) => {
      prev(shader, r);
      // Impostor atlas has its own grid; geometry colors are white (albedo comes from the capture).
      const fix = (src: string) =>
        src
          .split(`vec2(1.0 / ${ATLAS_COLS}.0, 1.0 / ${ATLAS_ROWS}.0)`).join(`vec2(1.0 / ${IMPOSTOR_COLS}.0, 1.0 / ${IMPOSTOR_ROWS}.0)`)
          .split(`mod(vCell, ${ATLAS_COLS}.0), floor(vCell / ${ATLAS_COLS}.0 + 0.001)`).join(`mod(vCell, ${IMPOSTOR_COLS}.0), floor(vCell / ${IMPOSTOR_COLS}.0 + 0.001)`)
          .replace('floraAlbedo = mix(vColor.rgb, vColB, floraMask) * (tex.r * 1.15);', 'floraAlbedo = tex.rgb * vColor.rgb; floraMask = 0.0; floraGlowMask = 0.0;');
      shader.fragmentShader = fix(shader.fragmentShader);
    };
    const prevKey = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => prevKey() + '|imp';
  }

  private captureImpostor(sp: FloraSpecies, variant: number): number {
    const key = sp.idx + ':' + variant;
    const have = this.impostorCells.get(key);
    if (have !== undefined) return have;
    const cell = this.impostorCells.size;
    if (cell >= IMPOSTOR_COLS * IMPOSTOR_ROWS) return -1;
    this.ensureImpostorTarget();
    const renderer = this.renderer!;
    const rt = this.impostorRT!;
    const base = this.geometry(sp.idx, variant, -1, 0);
    const H = base.height + 0.6, R = base.radius * 1.05;
    const cam = new THREE.OrthographicCamera(-R, R, H - 0.6, -0.6, 0.1, R * 4 + 10);
    cam.position.set(0, 0, R * 2 + 5);
    cam.lookAt(0, 0, 0);
    cam.position.y = 0;
    cam.updateMatrixWorld();
    const mesh = new THREE.Mesh(base.geo, this.captureMat!);
    const scene = this.captureScene!;
    scene.add(mesh);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    const prevScissor = renderer.getScissorTest();
    const col = cell % IMPOSTOR_COLS, row = Math.floor(cell / IMPOSTOR_COLS);
    renderer.setRenderTarget(rt);
    renderer.autoClear = false;
    rt.viewport.set(col * IMP_PX, row * IMP_PX, IMP_PX, IMP_PX);
    rt.scissor.set(col * IMP_PX, row * IMP_PX, IMP_PX, IMP_PX);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    // Clear to the foliage color with zero alpha so mipmaps don't darken the silhouette.
    const lc = lin(sp.cls === 'tree' && sp.form !== 'snag' && sp.form !== 'charred' ? sp.leaf : sp.bark);
    renderer.setClearColor(new THREE.Color(lc[0], lc[1], lc[2]), 0);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    rt.scissorTest = false;
    rt.viewport.set(0, 0, rt.width, rt.height);
    rt.scissor.set(0, 0, rt.width, rt.height);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.setScissorTest(prevScissor);
    scene.remove(mesh);
    this.impostorCells.set(key, cell);
    return cell;
  }

  // ------------------------------------------------------------------ single (non-instanced) materials

  /** Non-instanced flora material (falling trees, shatter sources). Cached per kind & sky bucket. */
  singleMaterial(kind: FloraMatKind, sky: number): THREE.MeshStandardMaterial {
    const bucket = Math.round(sky * 4);
    const key = kind + ':' + bucket;
    let m = this.singleCache.get(key);
    if (!m) {
      m = createFloraMaterial(kind, this.shared, this.atlas.texture, this.atlas.rockTexture, new THREE.Vector3(0.5, bucket / 4, 0));
      this.singleCache.set(key, m);
    }
    return m;
  }

  /** Plain colored material for debris (logs, chips, leaf clumps). */
  plainMaterial(color: readonly number[], sky: number, emissive = 0): THREE.MeshStandardMaterial {
    const key = color.map((c) => c.toFixed(2)).join(',') + ':' + Math.round(sky * 2) + ':' + emissive.toFixed(1);
    let m = this.plainCache.get(key);
    if (!m) {
      const c = lin(color);
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.9, emissive: new THREE.Color(c[0], c[1], c[2]).multiplyScalar(emissive) });
      // Debris keeps the sky visibility of where it was spawned (dark in caves).
      patchSkyOcclusion(m, 'uniform', Math.round(sky * 2) / 2);
      this.plainCache.set(key, m);
    }
    return m;
  }

  dispose() {
    for (const g of this.geos.values()) g.geo.dispose();
    this.geos.clear();
    for (const m of Object.values(this.materials)) m.dispose();
    for (const m of Object.values(this.depthMaterials)) m.dispose();
    for (const m of this.singleCache.values()) m.dispose();
    for (const m of this.plainCache.values()) m.dispose();
    this.impostorRT?.dispose();
    this.captureMat?.dispose();
    void this.impostorMaterial;
    void this.impostorDepth;
  }
}

