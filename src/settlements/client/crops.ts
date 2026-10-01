/**
 * Field crops: one small instanced plant geometry per crop kind (built with the
 * construction kit so it shares the settlement material), scattered in rows.
 */
import * as THREE from 'three';
import type { FieldInfo } from '../types';
import { Kit, Surf } from '../build/kit';
import { MeshBuilder } from './mesher';
import { Rng } from '../../core/rng';

const geoCache = new Map<string, THREE.BufferGeometry>();

function plant(crop: FieldInfo['crop']): THREE.BufferGeometry | null {
  const hit = geoCache.get(crop);
  if (hit) return hit;
  const k = new Kit(7);
  k.piece('deco', 'plant');
  switch (crop) {
    case 'wheat':
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        k.pole(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08, Math.cos(a) * 0.2, 0.95, Math.sin(a) * 0.2, 0.012, 0.01, Surf.Straw, 0xd8c070, { seg: 3 });
        k.cyl(Math.cos(a) * 0.2, 0.9, Math.sin(a) * 0.2, 0.03, 0.01, 0.18, Surf.Straw, 0xe0c068, { seg: 4 });
      }
      break;
    case 'flax':
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        k.pole(0, 0, 0, Math.cos(a) * 0.12, 0.7, Math.sin(a) * 0.12, 0.012, 0.01, Surf.Leaf, 0x6a9a4a, { seg: 3 });
        k.sphere(Math.cos(a) * 0.12, 0.72, Math.sin(a) * 0.12, 0.04, 0.03, 0.04, Surf.Cloth, 0x6a8ad0, { seg: 4 });
      }
      break;
    case 'corn':
      k.cyl(0, 0, 0, 0.03, 0.02, 1.9, Surf.Leaf, 0x7a9a3a, { seg: 4 });
      for (let i = 0; i < 4; i++) k.boxC(0, 0.6 + i * 0.3, 0, 0.7, 0.02, 0.1, Surf.Leaf, 0x6a8a30, { ry: i * 1.6, rz: 0.4 });
      k.cyl(0.04, 1.1, 0, 0.05, 0.03, 0.25, Surf.Straw, 0xe0c050, { seg: 5, rz: -0.3 });
      break;
    case 'cabbage':
      k.sphere(0, 0.18, 0, 0.24, 0.2, 0.24, Surf.Leaf, 0x8ab05a, { seg: 7 });
      k.sphere(0, 0.12, 0, 0.32, 0.1, 0.32, Surf.Leaf, 0x6a9a48, { seg: 7 });
      break;
    case 'pumpkin':
      k.sphere(0, 0.2, 0, 0.3, 0.22, 0.3, Surf.Leaf, 0xe08a2a, { seg: 8 });
      k.sphere(0.3, 0.08, 0.1, 0.25, 0.06, 0.2, Surf.Leaf, 0x4a7a30, { seg: 6 });
      break;
    case 'vines':
      k.cyl(0, 0, 0, 0.04, 0.04, 1.5, Surf.Timber, 0x5a4430, { seg: 4 });
      k.sphere(0, 1.1, 0, 0.45, 0.35, 0.25, Surf.Leaf, 0x4a7a30, { seg: 7 });
      for (let i = 0; i < 3; i++) k.sphere(-0.2 + i * 0.2, 0.8, 0.2, 0.07, 0.1, 0.07, Surf.Leaf, 0x5a2a6a, { seg: 5 });
      break;
    case 'mushroom':
      k.cyl(0, 0, 0, 0.05, 0.04, 0.3, Surf.Mushroom, 0xe8e0d0, { seg: 5 });
      k.sphere(0, 0.3, 0, 0.18, 0.1, 0.18, Surf.Mushroom, 0x8a5a9a, { lat0: 0, lat1: Math.PI / 2, seg: 7, emit: 0x60c0a0, emitI: 0.4 });
      break;
    default:
      return null;
  }
  const bp = k.finish(null);
  const mb = new MeshBuilder();
  mb.setFrame(0, 0, 0, 0, null);
  for (const p of bp.pieces) mb.addPiece(p, 0, 2);
  const g = mb.build();
  if (g) geoCache.set(crop, g);
  return g;
}

/** Instanced crops for a field (world positions relative to origin). */
export function cropMesh(f: FieldInfo, material: THREE.Material, h: (x: number, z: number) => number, ox: number, oy: number, oz: number): THREE.InstancedMesh | null {
  const g = plant(f.crop);
  if (!g) return null;
  const rng = new Rng(f.seed);
  const row = f.crop === 'vines' ? 1.6 : f.crop === 'corn' ? 0.9 : 0.7;
  const step = f.crop === 'wheat' || f.crop === 'flax' ? 0.45 : f.crop === 'vines' ? 1.1 : 0.7;
  const nr = Math.floor((f.d - 0.6) / row), nc = Math.floor((f.w - 0.6) / step);
  const n = Math.min(900, Math.max(0, nr * nc));
  if (!n) return null;
  const mesh = new THREE.InstancedMesh(g, material, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
  let i = 0;
  const skip = nr * nc > 900 ? (nr * nc) / 900 : 1;
  let acc = 0;
  for (let r = 0; r < nr; r++)
    for (let k = 0; k < nc; k++) {
      acc += 1;
      if (acc < skip) continue;
      acc -= skip;
      if (i >= n) break;
      const lx = -f.w / 2 + 0.3 + (k + 0.5) * step + rng.range(-0.06, 0.06), lz = -f.d / 2 + 0.3 + (r + 0.5) * row;
      const x = f.pos[0] + lx * c + lz * sn, z = f.pos[2] - lx * sn + lz * c;
      p.set(x - ox, h(x, z) + 0.04 - oy, z - oz);
      q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
      const sc = rng.range(0.8, 1.15);
      s.set(sc, sc * rng.range(0.85, 1.1), sc);
      mesh.setMatrixAt(i++, m.compose(p, q, s));
    }
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}
