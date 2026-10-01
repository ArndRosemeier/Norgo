/**
 * `buildItemObject` — the single entry point for item 3D models (held
 * weapons, ground items, UI icons, sandbox). Dispatches on the shape family
 * to the weapon / apparel / misc builders, all shaded via one ItemMatKit.
 *
 * Conventions (shared with the humanoid module):
 *  - origin = grip point for held items (resting base for others), +Y along
 *    the blade/handle, +Z = cutting edge / face direction.
 *  - `object.userData.skyUniforms` → use `setItemSkyVis(obj, v)`.
 *  - Light sources (torches, lanterns, glowing gear) expose
 *    `object.userData.light = { color, intensity, distance, anchor }` where
 *    `anchor` is an Object3D inside the item to parent a PointLight to.
 *    `attachItemLight(obj)` does exactly that.
 *  - `object.userData.flames` lists flame meshes animated by `animateItem`.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../types';
import { ItemMatKit, attachSky } from './materials';
import { Rng } from '../../core/rng';
import { buildWeaponsMesh } from './meshes/weapons';
import { buildApparelMesh } from './meshes/apparel';
import { buildMiscMesh } from './meshes/misc';
import { itemDef } from '../data/catalog';

export interface ItemLightSpec {
  color: [number, number, number];
  intensity: number;
  distance: number;
  anchor: THREE.Object3D;
}

/** Build a standalone 3D object for an item. Origin = grip point (held) or resting base. */
export function buildItemObject(defId: string, visual: ItemVisual): THREE.Object3D {
  const kit = new ItemMatKit(visual);
  const rng = new Rng(visual.seed >>> 0 || 1);
  const shape = visual.shape || itemDef(defId)?.visual.shape || 'misc';
  let obj: THREE.Object3D | null = null;
  try {
    obj = buildWeaponsMesh(shape, visual, kit, rng.fork('w')) ?? buildApparelMesh(shape, visual, kit, rng.fork('a')) ?? buildMiscMesh(shape, visual, kit, rng.fork('m'));
  } catch (err) {
    console.warn('[items] mesh build failed for', defId, shape, err);
    obj = null;
  }
  if (!obj) obj = fallbackMesh(kit);
  const root = new THREE.Group();
  root.name = 'item:' + defId;
  root.add(obj);
  attachSky(root, kit);
  // Lift userData written by builders (light, flames) onto the root.
  obj.traverse((o) => {
    if (o.userData.light) root.userData.light = o.userData.light;
    if (o.userData.flames) root.userData.flames = [...((root.userData.flames as THREE.Object3D[]) ?? []), ...(o.userData.flames as THREE.Object3D[])];
  });
  root.userData.defId = defId;
  root.userData.shape = shape;
  return root;
}

function fallbackMesh(kit: ItemMatKit): THREE.Object3D {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.12), kit.get('primary'));
  m.position.y = 0.06;
  m.castShadow = true;
  return m;
}

/** Create a PointLight at the item's light anchor (torch flame, lantern). Returns it (or null). */
export function attachItemLight(obj: THREE.Object3D, intensityMul = 1): THREE.PointLight | null {
  const spec = obj.userData.light as ItemLightSpec | undefined;
  if (!spec) return null;
  const light = new THREE.PointLight(new THREE.Color().setRGB(...spec.color, THREE.SRGBColorSpace), spec.intensity * intensityMul, spec.distance, 2);
  light.castShadow = false;
  light.name = 'itemLight';
  spec.anchor.add(light);
  obj.userData.pointLight = light;
  return light;
}

/** Per-frame cosmetic animation: flame flicker and light jitter. Cheap; call for visible items only. */
export function animateItem(obj: THREE.Object3D, time: number) {
  const flames = obj.userData.flames as THREE.Object3D[] | undefined;
  if (flames)
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const s = 1 + Math.sin(time * 17 + i * 2.1) * 0.08 + Math.sin(time * 31 + i) * 0.05;
      f.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
      f.rotation.y = time * 2 + i;
    }
  const light = obj.userData.pointLight as THREE.PointLight | undefined;
  const spec = obj.userData.light as ItemLightSpec | undefined;
  if (light && spec) light.intensity = spec.intensity * (0.88 + Math.sin(time * 13.7) * 0.06 + Math.sin(time * 23.1) * 0.06);
}
