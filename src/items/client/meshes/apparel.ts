/**
 * Item meshes: apparel — armor, clothing and jewelry as standalone display
 * models (ground items, inventory icons, sandbox). Worn versions are produced
 * by `resolveWearable` (../wearables.ts); both share the rigid builders and
 * the garment "look" in ../wear/* so an item looks the same everywhere.
 *
 * Origin = resting base (lowest point at y = 0), +Y up, +Z front.
 */
import type * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { ITEM_DEFS } from '../../data/catalog';
import { DEFAULT_FIT } from '../wear/fit';
import { lookFor } from '../wear/look';
import { buildApparelDisplay } from '../wear/display';

let shapeToDef: Map<string, string> | null = null;

/** A representative def id for a shape (prefers equippable, non-quest defs) — for family lookup. */
export function defForShape(shape: string): string {
  if (!shapeToDef) {
    shapeToDef = new Map();
    // First pass: equippable, non-quest defs win; second pass fills the rest.
    for (const d of ITEM_DEFS) if (d.slots.length && d.category !== 'quest' && !shapeToDef.has(d.visual.shape)) shapeToDef.set(d.visual.shape, d.id);
    for (const d of ITEM_DEFS) if (!shapeToDef.has(d.visual.shape)) shapeToDef.set(d.visual.shape, d.id);
  }
  return shapeToDef.get(shape) ?? '';
}

const APPAREL = new Set([
  'hood', 'hat.straw', 'hat.wide', 'hat.pointed', 'cap.leather', 'coif.mail', 'helm.nasal', 'helm.kettle', 'helm.barbute', 'helm.great', 'helm.horned', 'helm.skull', 'circlet', 'crown',
  'mask.cloth', 'mask.leather', 'mask.bone', 'mask.metal', 'veil',
  'gorget', 'scarf', 'amulet', 'pendant', 'torc',
  'mantle.fur', 'pauldron.leather', 'pauldron.scale', 'pauldron.plate', 'pauldron.bone',
  'shirt', 'tunic', 'vest', 'doublet', 'robe.short', 'robe.long', 'robe.gown', 'coat.long', 'gambeson', 'jerkin', 'brigandine', 'hide', 'hauberk', 'scale', 'lamellar', 'cuirass', 'harness.bone',
  'cloak', 'cloak.fur', 'cape',
  'wraps', 'bracers.leather', 'bracers.metal', 'vambraces',
  'gloves.cloth', 'gloves.leather', 'gauntlets.mail', 'gauntlets.plate',
  'belt.rope', 'belt.leather', 'belt.pouches', 'belt.plated', 'sash',
  'trousers', 'breeches', 'kilt', 'leggings.padded', 'leggings.leather', 'chausses', 'leggings.scale', 'legplates',
  'sandals', 'shoes', 'boots.leather', 'boots.tall', 'boots.fur', 'sabatons',
  'ring.band', 'ring.signet', 'ring.gem',
]);

/** True if the shape family is apparel (handled here). */
export function isApparelShape(shape: string): boolean {
  return APPAREL.has(shape);
}

export function buildApparelMesh(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  if (!APPAREL.has(shape)) return null;
  const look = lookFor(defForShape(shape), v);
  return buildApparelDisplay(shape, { kit, look, fit: DEFAULT_FIT, rng }, rng);
}
