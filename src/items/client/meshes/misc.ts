/**
 * Misc item meshes: food & drink, potions, scrolls, books, keys, quest items,
 * trinkets, coins and every raw/intermediate material. Dispatches to the
 * themed builder files; unknown shapes in the misc families fall back to a
 * tied cloth bundle so nothing ever renders as a bare box.
 *
 * Origin = resting base centre on the ground, +Y up, meters.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { buildFood } from './misc_food';
import { buildGoods } from './misc_goods';
import { buildMats } from './misc_mats';
import { lumpGeometry, stdMat } from './misc_common';
import { mesh, cyl } from './util';

const FAMILIES = ['mat.', 'food.', 'potion.', 'trinket.'];

export function buildMiscMesh(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  const obj = buildFood(shape, v, kit, rng) ?? buildGoods(shape, v, kit, rng) ?? buildMats(shape, v, kit, rng);
  if (obj) return obj;
  if (FAMILIES.some((f) => shape.startsWith(f))) return bundle(v, kit, rng);
  return null;
}

/** Generic fallback: a cloth bundle knotted at the top, dyed in the item's primary colour. */
function bundle(v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D {
  const g = new THREE.Group();
  const cloth = kit.tinted('cloth', v.primary, 'bundle');
  g.add(mesh(lumpGeometry(rng, 0.06, 0.12, false, [1.1, 0.75, 1]), cloth));
  // Gathered neck and the two knot ears.
  g.add(mesh(cyl(0.022, 0.012, 0.08, 0.095, 10), cloth));
  for (const s of [-1, 1]) g.add(mesh(new THREE.ConeGeometry(0.012, 0.035, 6), cloth, s * 0.016, 0.1, 0, 0, 0, -s * 1.0));
  g.add(mesh(new THREE.TorusGeometry(0.014, 0.003, 5, 12), stdMat(kit, 'twine', [0.55, 0.45, 0.3], { roughness: 0.9 }), 0, 0.088, 0, Math.PI / 2, 0, 0));
  return g;
}
