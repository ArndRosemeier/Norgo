/**
 * Garment "look": decides the armor family, surface pattern and shading
 * parameters of a worn item from its definition and rolled visual. Shared by
 * the wearable resolver (ShellMaterial for the humanoid shell shader) and the
 * apparel display models (canvas pattern textures), so an item looks the same
 * on the ground, in the inventory icon and on the body.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ShellMaterial } from '../../wearable';
import { itemDef } from '../../data/catalog';
import type { ItemMatKit } from '../materials';
import { patternTexture, type DisplayPattern } from './patterns';
import { hash32 } from '../../../core/rng';

type RGB = [number, number, number];

export type ArmorFamily = 'cloth' | 'robe' | 'padded' | 'leather' | 'fur' | 'studded' | 'bone' | 'chain' | 'scale' | 'lamellar' | 'plate' | 'jewelry';

const FAMILIES: ArmorFamily[] = ['cloth', 'robe', 'padded', 'leather', 'fur', 'studded', 'bone', 'chain', 'scale', 'lamellar', 'plate'];

export interface Look {
  family: ArmorFamily;
  pattern: DisplayPattern;
  shellPattern: ShellMaterial['pattern'];
  color: RGB;
  color2: RGB;
  accent: RGB;
  roughness: number;
  metalness: number;
  sheen: number;
  /** Pattern repeats per meter-ish (shell shader uses it as tiling scale). */
  patternScale: number;
  metallic: boolean;
}

/** Family of a worn item from its def tags (falls back to the shape name). */
export function familyOf(defId: string, shape: string): ArmorFamily {
  const def = itemDef(defId);
  if (def?.category === 'jewelry') return 'jewelry';
  const tags = def?.tags ?? [];
  for (const f of FAMILIES) if (tags.includes(f)) return f;
  if (/mail|coif|chausses|hauberk/.test(shape)) return 'chain';
  if (/plate|cuirass|sabaton|greave|vambrace|gorget|helm|visage/.test(shape)) return 'plate';
  if (/scale/.test(shape)) return 'scale';
  if (/fur|hide/.test(shape)) return 'fur';
  if (/bone|skull/.test(shape)) return 'bone';
  if (/leather|boots|bracers|belt/.test(shape)) return 'leather';
  if (/robe|gown/.test(shape)) return 'robe';
  if (/ring|amulet|torc|circlet|crown|pendant/.test(shape)) return 'jewelry';
  return 'cloth';
}

const SHELL_OF: Record<DisplayPattern, ShellMaterial['pattern']> = {
  plain: 'plain', stripes: 'stripes', checks: 'checks', quilted: 'quilted', chainmail: 'chainmail', scales: 'scales', leather: 'leather', fur: 'fur',
  embroidered: 'embroidered', patchwork: 'patchwork', silk: 'silk', plates: 'plates', runes: 'runes', lamellar: 'plates', studded: 'plates', straw: 'stripes',
};

export function lookFor(defId: string, v: ItemVisual): Look {
  const shape = v.shape;
  const family = familyOf(defId, shape);
  const h = hash32(v.seed ^ 0x9e37);
  const pick = (h & 1023) / 1024;
  const silk = v.material === 'silk';
  const elvish = v.style === 'elf' || v.style === 'sylvan';
  let pattern: DisplayPattern = 'plain';
  switch (family) {
    case 'cloth':
      if (shape === 'kilt') pattern = 'checks';
      else if (shape === 'hat.straw') pattern = 'straw';
      else if (silk) pattern = 'silk';
      else if (v.glow > 0.3) pattern = 'runes';
      else if (elvish && pick < 0.5) pattern = 'embroidered';
      else if (v.wear > 0.45 && pick < 0.45) pattern = 'patchwork';
      else pattern = pick < 0.55 ? 'plain' : pick < 0.72 ? 'stripes' : pick < 0.84 ? 'checks' : pick < 0.93 ? 'embroidered' : 'patchwork';
      break;
    case 'robe':
      pattern = v.glow > 0.25 ? 'runes' : silk && pick < 0.4 ? 'silk' : 'embroidered';
      break;
    case 'padded': pattern = 'quilted'; break;
    case 'leather': pattern = 'leather'; break;
    case 'fur': pattern = 'fur'; break;
    case 'studded': pattern = 'studded'; break;
    case 'bone': pattern = 'plates'; break;
    case 'chain': pattern = 'chainmail'; break;
    case 'scale': pattern = 'scales'; break;
    case 'lamellar': pattern = 'lamellar'; break;
    case 'plate': pattern = 'plates'; break;
    case 'jewelry': pattern = 'plain'; break;
  }
  const metallic = family === 'chain' || family === 'scale' || family === 'lamellar' || family === 'plate' || family === 'jewelry';
  const wear = v.wear;
  return {
    family,
    pattern,
    shellPattern: SHELL_OF[pattern],
    color: v.primary,
    color2: v.secondary,
    accent: v.accent,
    roughness: metallic ? 0.28 + wear * 0.35 : family === 'leather' || family === 'studded' ? 0.6 + wear * 0.2 : silk ? 0.38 : 0.88,
    metalness: metallic ? (family === 'chain' ? 0.85 : 0.95) : family === 'studded' ? 0.15 : 0,
    sheen: silk ? 0.8 : family === 'cloth' || family === 'robe' || family === 'padded' ? 0.35 : family === 'fur' ? 0.5 : 0,
    patternScale: family === 'chain' ? 40 : family === 'scale' ? 18 : family === 'lamellar' ? 14 : family === 'plate' ? 6 : family === 'studded' ? 12 : family === 'padded' ? 10 : 4,
    metallic,
  };
}

/**
 * Patterned display material for a garment surface. `rep` = texture repeats
 * across the surface (u around, v along). Registered with the kit so sky
 * occlusion applies.
 */
export function patternMaterial(kit: ItemMatKit, look: Look, rep: [number, number], variant: DisplayPattern | null = null, key = ''): THREE.MeshStandardMaterial {
  const v = kit.v;
  const pattern = variant ?? look.pattern;
  return kit.custom('pat:' + pattern + ':' + rep.join('x') + key, () => {
    const tex = patternTexture(pattern, look.color, look.color2, look.accent, v.seed, v.wear, v.glow > 0.05 ? v.glowColor : null);
    const map = tex.map.clone();
    map.repeat.set(rep[0], rep[1]);
    map.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({
      map,
      bumpMap: map,
      bumpScale: look.metallic ? 1.2 : pattern === 'quilted' || pattern === 'fur' ? 2 : 0.8,
      roughness: look.roughness,
      metalness: look.metalness,
      side: THREE.DoubleSide,
    });
    if (tex.emissive) {
      const em = tex.emissive.clone();
      em.repeat.set(rep[0], rep[1]);
      em.needsUpdate = true;
      m.emissiveMap = em;
      m.emissive = new THREE.Color().setRGB(v.glowColor[0], v.glowColor[1], v.glowColor[2], THREE.SRGBColorSpace);
      m.emissiveIntensity = 0.6 + v.glow * 2;
    } else if (v.glow > 0.05) {
      m.emissive = new THREE.Color().setRGB(v.glowColor[0], v.glowColor[1], v.glowColor[2], THREE.SRGBColorSpace);
      m.emissiveIntensity = v.glow * 0.25;
    }
    // Cloned repeat wrappers are owned by this material.
    m.userData.ownMap = map;
    return m;
  });
}

/** Plain material for the "main" surface of a rigid piece by family. */
export function mainMaterial(kit: ItemMatKit, look: Look): THREE.Material {
  switch (look.family) {
    case 'chain': case 'scale': case 'lamellar': case 'plate': case 'jewelry':
      return kit.get('metal');
    case 'bone': return kit.v.material === 'bone' ? kit.get('bone') : kit.get('primary');
    case 'fur': return kit.get('fur');
    case 'cloth': case 'robe': case 'padded': return kit.get('cloth');
    default: return kit.get('primary');
  }
}

/** A flat near-black material for eye slits, breathing holes, sockets. */
export function voidMaterial(kit: ItemMatKit): THREE.MeshStandardMaterial {
  return kit.custom('void', () => new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, metalness: 0 }));
}
