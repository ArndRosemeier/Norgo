/**
 * Item PBR materials. Every item mesh is shaded through an `ItemMatKit`
 * created from its ItemVisual: the kit hands out materials by *role* (blade,
 * fittings, wood, grip leather, cloth, trim, gem, glow, glass, liquid...),
 * tinted by the visual's colors and the material family, roughened by wear,
 * and lit by enchantment glow.
 *
 * Textures (wood grain, leather pebbling, cloth weave, brushed/hammered metal,
 * paper fibre) are generated once on canvases and shared by all items; the
 * materials themselves are per-object so sky occlusion can be set per entity
 * (`setItemSkyVis`). three.js shares the compiled programs.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../types';
import { patchSkyOcclusion } from '../../render/skyOcclusion';
import { Rng } from '../../core/rng';

export type MatRole =
  | 'blade' | 'metal' | 'dark' | 'trim' | 'wood' | 'grip' | 'leather' | 'cloth' | 'fur' | 'bone' | 'stone' | 'crystal' | 'gem'
  | 'glow' | 'glass' | 'liquid' | 'paper' | 'flame' | 'string' | 'primary' | 'secondary' | 'accent' | 'organic';

// ------------------------------------------------------------------ shared detail textures

type TexKind = 'wood' | 'leather' | 'cloth' | 'brushed' | 'hammered' | 'paper' | 'fur' | 'stone' | 'bone' | 'noise';
const texCache = new Map<TexKind, THREE.Texture>();

/**
 * Grayscale detail texture (mid-grey ≈ 0.85 so tinted colors stay true). Used
 * as color map (multiplied by material color) and as bump map.
 */
export function detailTexture(kind: TexKind): THREE.Texture {
  let t = texCache.get(kind);
  if (t) return t;
  const S = 128;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const img = g.createImageData(S, S);
  const d = img.data;
  const rng = new Rng(0x17e3 + kind.length * 977 + kind.charCodeAt(0));
  // Tileable value noise.
  const N = 16;
  const grid = new Float32Array(N * N).map(() => rng.float());
  const vn = (x: number, y: number, f: number) => {
    const gx = (x / S) * f, gy = (y / S) * f;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => grid[((((j % f) + f) % f) % N) * N + ((((i % f) + f) % f) % N)];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), e = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy;
  };
  const fbm = (x: number, y: number) => vn(x, y, 4) * 0.5 + vn(x, y, 8) * 0.3 + vn(x, y, 16) * 0.2;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let v = 0.85;
      switch (kind) {
        case 'wood': {
          // Grain runs along V (texture y) — items are built +Y along the handle.
          const warp = fbm(x, y) * 6;
          const ring = Math.sin((x / S) * Math.PI * 2 * 7 + warp) * 0.5 + 0.5;
          v = 0.68 + ring * 0.22 + (rng.float() - 0.5) * 0.05 + vn(x, y * 0.1, 16) * 0.08;
          break;
        }
        case 'leather':
          v = 0.74 + fbm(x, y) * 0.16 - Math.pow(vn(x, y, 16), 6) * 0.25 + (rng.float() - 0.5) * 0.04;
          break;
        case 'cloth': {
          const wx = Math.sin((x / S) * Math.PI * 64), wy = Math.sin((y / S) * Math.PI * 64);
          v = 0.78 + (((x >> 1) + (y >> 1)) & 1 ? wx : wy) * 0.07 + fbm(x, y) * 0.1;
          break;
        }
        case 'brushed':
          v = 0.86 + (vn(x * 0.05, y, 16) - 0.5) * 0.12 + (rng.float() - 0.5) * 0.04 - (rng.float() < 0.002 ? 0.3 : 0);
          break;
        case 'hammered': {
          const c = vn(x, y, 8);
          v = 0.8 + Math.abs(c - 0.5) * 0.25 + fbm(x, y) * 0.06;
          break;
        }
        case 'paper':
          v = 0.86 + fbm(x, y) * 0.1 + (rng.float() - 0.5) * 0.04;
          break;
        case 'fur':
          v = 0.6 + vn(x * 0.3, y, 16) * 0.35 + (rng.float() - 0.5) * 0.15;
          break;
        case 'stone':
          v = 0.65 + fbm(x, y) * 0.3 + (rng.float() - 0.5) * 0.08;
          break;
        case 'bone':
          v = 0.8 + fbm(x, y) * 0.12 - Math.pow(vn(x, y * 0.3, 16), 8) * 0.3;
          break;
        default:
          v = 0.75 + fbm(x, y) * 0.2;
      }
      const c = Math.max(0, Math.min(255, Math.round(v * 255)));
      const i = (y * S + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = c;
      d[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  t = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(kind, t);
  return t;
}

// ------------------------------------------------------------------ kit

const tmpColor = new THREE.Color();

function srgb(c: [number, number, number], out = new THREE.Color()): THREE.Color {
  return out.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}

/** Family of the item's primary material → texture & shading defaults. */
function familyTex(family: string): TexKind | null {
  switch (family) {
    case 'wood': return 'wood';
    case 'leather': return 'leather';
    case 'cloth': case 'silk': return 'cloth';
    case 'metal': return 'brushed';
    case 'fur': return 'fur';
    case 'stone': return 'stone';
    case 'bone': case 'chitin': return 'bone';
    case 'organic': return 'noise';
    default: return null;
  }
}

/**
 * Per-object material factory. Materials are created lazily per role and
 * reused within the object. `skyUniforms` collects sky-occlusion uniforms.
 */
export class ItemMatKit {
  private mats = new Map<string, THREE.Material>();
  readonly skyUniforms: { value: number }[] = [];
  readonly v: ItemVisual;

  constructor(v: ItemVisual) {
    this.v = v;
  }

  private finish<T extends THREE.Material>(key: string, m: T): T {
    const p = patchSkyOcclusion(m, 'uniform', 1);
    if (p.uniform) this.skyUniforms.push(p.uniform);
    this.mats.set(key, m);
    return m;
  }

  /** Standard material with explicit parameters (cached by key). */
  custom(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const m = this.mats.get('c:' + key) as THREE.MeshStandardMaterial | undefined;
    return m ?? this.finish('c:' + key, make());
  }

  get(role: MatRole): THREE.Material {
    const hit = this.mats.get(role);
    if (hit) return hit;
    const v = this.v;
    const wear = v.wear;
    const enchant = v.glow;
    const fam = v.material;
    const std = (o: THREE.MeshStandardMaterialParameters & { tex?: TexKind | null; bump?: number; rep?: number }) => {
      const { tex, bump, rep, ...rest } = o;
      const m = new THREE.MeshStandardMaterial(rest);
      if (tex) {
        const t = detailTexture(tex);
        m.map = t;
        m.bumpMap = t;
        m.bumpScale = bump ?? 0.6;
        if (rep && rep !== 1) {
          // Repeat via a cloned texture sharing the same image.
          const c = t.clone();
          c.repeat.set(rep, rep);
          c.needsUpdate = true;
          m.map = c;
          m.bumpMap = c;
        }
      }
      return m;
    };
    let m: THREE.Material;
    switch (role) {
      case 'blade': {
        // Primary metal (or obsidian/crystal/bone head) — polished edge, glow when enchanted.
        if (fam === 'glass' || fam === 'crystal') {
          m = std({ color: srgb(v.primary), roughness: 0.06, metalness: 0.1, transparent: fam === 'crystal', opacity: fam === 'crystal' ? 0.85 : 1, emissive: srgb(v.glowColor), emissiveIntensity: enchant * 1.6 + (fam === 'crystal' ? 0.25 : 0) });
        } else if (fam === 'bone' || fam === 'chitin') {
          m = std({ color: srgb(v.primary), roughness: 0.45 + wear * 0.2, metalness: 0, tex: 'bone', emissive: srgb(v.glowColor), emissiveIntensity: enchant * 1.2 });
        } else if (fam === 'stone') {
          m = std({ color: srgb(v.primary), roughness: 0.8, metalness: 0, tex: 'stone', emissive: srgb(v.glowColor), emissiveIntensity: enchant });
        } else if (fam === 'wood') {
          m = std({ color: srgb(v.primary), roughness: 0.6, metalness: 0, tex: 'wood', emissive: srgb(v.glowColor), emissiveIntensity: enchant });
        } else {
          m = std({ color: srgb(v.primary), roughness: 0.18 + wear * 0.45, metalness: 1, tex: 'brushed', bump: 0.15, emissive: srgb(v.glowColor), emissiveIntensity: enchant * 1.4 });
        }
        break;
      }
      case 'metal':
        m = std({ color: srgb(v.primary), roughness: 0.3 + wear * 0.4, metalness: fam === 'metal' ? 1 : 0.2, tex: fam === 'metal' ? 'hammered' : familyTex(fam), bump: 0.3, emissive: srgb(v.glowColor), emissiveIntensity: enchant * 0.6 });
        break;
      case 'dark':
        m = std({ color: srgb(v.secondary).lerp(tmpColor.setRGB(0.12, 0.12, 0.13), 0.55), roughness: 0.45 + wear * 0.3, metalness: 0.9, tex: 'hammered', bump: 0.4 });
        break;
      case 'trim':
      case 'accent':
        m = std({ color: srgb(v.accent), roughness: 0.25 + wear * 0.25, metalness: 1, tex: 'brushed', bump: 0.1 });
        break;
      case 'wood':
        m = std({ color: fam === 'wood' ? srgb(v.primary) : srgb(v.secondary).lerp(tmpColor.setRGB(0.4, 0.27, 0.15), 0.6), roughness: 0.62 + wear * 0.2, metalness: 0, tex: 'wood', bump: 0.8 });
        break;
      case 'grip':
        m = std({ color: srgb(v.secondary).multiplyScalar(0.8), roughness: 0.75, metalness: 0, tex: 'leather', bump: 1.2, rep: 2 });
        break;
      case 'leather':
        m = std({ color: fam === 'leather' ? srgb(v.primary) : srgb(v.secondary), roughness: 0.62 + wear * 0.2, metalness: 0, tex: 'leather', bump: 0.9 });
        break;
      case 'cloth':
        m = std({ color: srgb(v.primary), roughness: fam === 'silk' ? 0.4 : 0.92, metalness: 0, tex: 'cloth', bump: 0.5, rep: 2, side: THREE.DoubleSide });
        break;
      case 'fur':
        m = std({ color: srgb(v.material === 'fur' ? v.primary : v.secondary), roughness: 1, metalness: 0, tex: 'fur', bump: 1.5 });
        break;
      case 'bone':
        m = std({ color: fam === 'bone' ? srgb(v.primary) : new THREE.Color(0.85, 0.8, 0.68), roughness: 0.5, metalness: 0, tex: 'bone', bump: 0.5 });
        break;
      case 'stone':
        m = std({ color: srgb(v.primary), roughness: 0.85, metalness: 0, tex: 'stone', bump: 1 });
        break;
      case 'organic':
        m = std({ color: srgb(v.primary), roughness: 0.7, metalness: 0, tex: 'noise', bump: 0.6, emissive: srgb(v.glowColor), emissiveIntensity: v.glow });
        break;
      case 'crystal':
        m = std({ color: srgb(v.glow > 0 ? v.glowColor : v.accent), roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.82, emissive: srgb(v.glow > 0 ? v.glowColor : v.accent), emissiveIntensity: 0.6 + v.glow * 1.5 });
        break;
      case 'gem':
        m = std({ color: srgb(v.accent), roughness: 0.08, metalness: 0.2, emissive: srgb(v.accent), emissiveIntensity: 0.25 + enchant * 1.2 });
        break;
      case 'glow':
        m = new THREE.MeshBasicMaterial({ color: srgb(v.glowColor).multiplyScalar(2 + v.glow * 2), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
        this.mats.set(role, m);
        return m;
      case 'glass':
        m = std({ color: new THREE.Color(0.85, 0.95, 0.95), roughness: 0.04, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false });
        break;
      case 'liquid':
        m = std({ color: srgb(v.primary), roughness: 0.15, metalness: 0, transparent: true, opacity: 0.88, emissive: srgb(v.primary), emissiveIntensity: 0.35 + v.glow * 0.6 });
        break;
      case 'paper':
        m = std({ color: new THREE.Color().setRGB(0.88, 0.82, 0.66, THREE.SRGBColorSpace), roughness: 0.95, metalness: 0, tex: 'paper', bump: 0.3, side: THREE.DoubleSide });
        break;
      case 'flame':
        m = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.4, 0.4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
        this.mats.set(role, m);
        return m;
      case 'string':
        m = std({ color: new THREE.Color(0.85, 0.82, 0.72), roughness: 0.8, metalness: 0 });
        break;
      case 'primary':
        m = std({ color: srgb(v.primary), roughness: fam === 'metal' ? 0.3 + wear * 0.3 : 0.7, metalness: fam === 'metal' ? 1 : 0, tex: familyTex(fam), bump: 0.6, emissive: srgb(v.glowColor), emissiveIntensity: enchant * 0.5 });
        break;
      case 'secondary':
        m = std({ color: srgb(v.secondary), roughness: 0.7, metalness: 0, tex: 'leather', bump: 0.6 });
        break;
      default:
        m = std({ color: srgb(v.primary) });
    }
    return this.finish(role, m);
  }

  /** A material with arbitrary color sharing a role's shading (paint, dyes...). */
  tinted(role: MatRole, color: [number, number, number], key: string): THREE.Material {
    const k = role + ':' + key;
    const hit = this.mats.get(k);
    if (hit) return hit;
    const base = this.get(role) as THREE.MeshStandardMaterial;
    const m = base.clone();
    if ('color' in m) (m as THREE.MeshStandardMaterial).color = srgb(color);
    return this.finish(k, m);
  }

  /** Register an externally created material for sky occlusion. */
  adopt<T extends THREE.Material>(key: string, m: T): T {
    return this.finish('x:' + key, m);
  }
}

/** Attach the kit's sky uniforms to an object so `setItemSkyVis` can find them. */
export function attachSky(obj: THREE.Object3D, kit: ItemMatKit) {
  const arr = (obj.userData.skyUniforms ??= []) as { value: number }[];
  arr.push(...kit.skyUniforms);
}

/** Set cave/sky visibility (0..1) on an item object built by `buildItemObject`. */
export function setItemSkyVis(obj: THREE.Object3D, v: number) {
  const arr = obj.userData.skyUniforms as { value: number }[] | undefined;
  if (arr) for (const u of arr) u.value = v;
}

/** Dispose geometries & per-object materials (shared textures are kept). */
export function disposeItemObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const sm = mat as THREE.MeshStandardMaterial;
        // Cloned repeat textures are per-material wrappers around shared images.
        if (sm.map && !isShared(sm.map)) sm.map.dispose();
        if (sm.userData?.ownMap) (sm.userData.ownMap as THREE.Texture).dispose();
        mat.dispose();
      }
    }
  });
}

function isShared(t: THREE.Texture) {
  for (const s of texCache.values()) if (s === t) return true;
  return false;
}
