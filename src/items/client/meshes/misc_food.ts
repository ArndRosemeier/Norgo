/**
 * Food & drink meshes: bread, meat, fish, fruit, apples, cheese, stew, pie,
 * jars, mushrooms, mugs and the waterskin. Origin = resting base, +Y up.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { lathe, mesh, cyl, tube, extrudeOutline, type V2 } from './util';
import { lumpGeometry, stdMat, glassVessel, leafGeometry, type RGB, col } from './misc_common';

/** Capsule/rod lying flat on the ground plane, turned by `yaw`. */
function lay(m: THREE.Mesh, yaw: number): THREE.Mesh {
  m.rotation.order = 'YXZ';
  m.rotation.set(Math.PI / 2, yaw, 0);
  return m;
}

const darker = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const lighter = (c: RGB, k: number): RGB => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];

export function buildFood(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  switch (shape) {
    case 'food.bread': return bread(v, kit, rng);
    case 'food.meat': return meat(v, kit, rng);
    case 'food.fish': return fish(v, kit, rng);
    case 'food.fruit': return berries(v, kit, rng);
    case 'food.apple': return apple(v, kit, rng);
    case 'food.cheese': return cheese(v, kit, rng);
    case 'food.stew': return stew(v, kit, rng);
    case 'food.pie': return pie(v, kit, rng);
    case 'food.jar': case 'mat.jar': return jar(v, kit, rng);
    case 'food.mushroom': return mushrooms(v, kit, rng);
    case 'food.mug': return mug(v, kit, rng);
    case 'waterskin': return waterskin(v, kit, rng);
  }
  return null;
}

function bread(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const long = rng.chance(0.45);
  const crust = kit.get('organic');
  const sx = long ? rng.range(0.13, 0.16) : rng.range(0.09, 0.105);
  const geo = lumpGeometry(rng, 1, 0.06, false, [sx, rng.range(0.05, 0.065), long ? 0.065 : sx * 0.95]);
  // Flatten the bottom into a baked base.
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0.012) p.setY(i, Math.max(0, p.getY(i) * 0.3));
  geo.computeVertexNormals();
  g.add(mesh(geo, crust));
  // Scored slashes in a paler crumb colour.
  const crumb = stdMat(kit, 'crumb', lighter(v.primary, 0.55), { roughness: 0.95 });
  const n = long ? rng.int(3, 4) : 2;
  const h = (geo.boundingBox ? geo.boundingBox.max.y : 0.06) - 0.004;
  for (let i = 0; i < n; i++) {
    if (long) {
      const x = (i - (n - 1) / 2) * sx * 0.55;
      g.add(lay(mesh(new THREE.CapsuleGeometry(0.006, 0.05, 2, 6), crumb, x, h - Math.abs(x) * 0.35, 0), 0.5));
    } else {
      g.add(lay(mesh(new THREE.CapsuleGeometry(0.006, 0.09, 2, 6), crumb, 0, h - 0.004, 0), i * Math.PI / 2 + 0.3));
    }
  }
  // Flour dust.
  const flour = stdMat(kit, 'flour', [0.95, 0.93, 0.88], { roughness: 1 });
  for (let i = 0; i < 6; i++) g.add(mesh(new THREE.CircleGeometry(0.008, 6), flour, rng.range(-0.04, 0.04), h + 0.001, rng.range(-0.03, 0.03), -Math.PI / 2, 0, rng.range(0, 6)));
  return g;
}

function meat(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const bone = kit.get('bone');
  const flesh = kit.get('organic');
  const len = rng.range(0.16, 0.2);
  // Drumstick lying along X: knuckle, shaft, meaty lobe.
  const shaft = mesh(cyl(0.012, 0.012, 0, len * 0.55, 8), bone, -len * 0.5, 0.03, 0, 0, 0, -Math.PI / 2);
  g.add(shaft);
  g.add(mesh(new THREE.SphereGeometry(0.017, 8, 6), bone, -len * 0.5, 0.03, 0.009));
  g.add(mesh(new THREE.SphereGeometry(0.017, 8, 6), bone, -len * 0.5, 0.03, -0.009));
  const lobe = lumpGeometry(rng, 1, 0.08, false, [len * 0.36, 0.05, 0.055]);
  g.add(mesh(lobe, flesh, len * 0.08, 0, 0));
  // Fat marbling / char marks.
  const fat = stdMat(kit, 'fat', lighter(v.primary, 0.5), { roughness: 0.5 });
  for (let i = 0; i < 4; i++) {
    g.add(lay(mesh(new THREE.CapsuleGeometry(0.004, rng.range(0.02, 0.04), 2, 5), fat, len * 0.08 + rng.range(-0.04, 0.04), rng.range(0.085, 0.095), rng.range(-0.02, 0.02)), rng.range(0, 3)));
  }
  return g;
}

function fish(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const len = rng.range(0.22, 0.28);
  const skin = kit.custom('fishskin', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.3, metalness: 0.35 }));
  // Body: lathe along Y, then laid along X and squashed sideways.
  const prof: V2[] = [[0.001, 0], [0.012, 0.01], [0.03, len * 0.15], [0.038, len * 0.35], [0.032, len * 0.6], [0.016, len * 0.82], [0.007, len * 0.9]];
  const body = lathe(prof, 14);
  body.scale(1, 1, 0.55);
  const bm = mesh(body, skin, len * 0.45, 0.034, 0, 0, 0, Math.PI / 2);
  bm.scale.set(1, 1, 1);
  // Lie it on its side: body axis X, flattened axis becomes up.
  const holder = new THREE.Group();
  holder.add(bm);
  // Tail fin and dorsal fin (in body's XY plane before tipping).
  const finMat = kit.custom('fin', () => new THREE.MeshStandardMaterial({ color: col(darker(v.primary, 0.7)), roughness: 0.5, side: THREE.DoubleSide }));
  const tail = mesh(extrudeOutline([[0, 0], [-0.05, 0.04], [-0.04, 0], [-0.05, -0.04]], 0.003), finMat, -len * 0.45 + 0.01, 0.034, 0);
  holder.add(tail);
  const dorsal = mesh(extrudeOutline([[0, 0], [0.04, 0], [0.01, 0.025]], 0.002), finMat, -0.01, 0.034 + 0.035, 0);
  holder.add(dorsal);
  const eye = stdMat(kit, 'eye', [0.05, 0.05, 0.05], { roughness: 0.1 });
  holder.add(mesh(new THREE.SphereGeometry(0.006, 6, 5), eye, len * 0.35, 0.044, 0.013));
  holder.add(mesh(new THREE.SphereGeometry(0.006, 6, 5), eye, len * 0.35, 0.044, -0.013));
  // Grill marks on cooked fish (warm, browned colour).
  if (v.primary[0] > v.primary[2] + 0.1) {
    const ch = stdMat(kit, 'char', [0.12, 0.07, 0.04], { roughness: 1 });
    for (let i = 0; i < 4; i++) for (const sd of [-1, 1]) holder.add(mesh(new THREE.BoxGeometry(0.004, 0.032, 0.002), ch, -0.04 + i * 0.03, 0.034, sd * 0.0185, 0, 0, 0.5));
  }
  holder.rotation.y = rng.range(-0.3, 0.3);
  g.add(holder);
  return g;
}

function berries(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const greenish = v.primary[1] > v.primary[0] && v.primary[1] > v.primary[2];
  if (greenish) {
    // Cactus flesh: peeled glistening slabs.
    const m = kit.custom('flesh', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.25, metalness: 0 }));
    for (let i = 0; i < 2; i++) {
      const geo = lumpGeometry(rng, 1, 0.12, false, [0.06, 0.018, 0.04]);
      g.add(mesh(geo, m, (i - 0.5) * 0.06, i * 0.012, rng.range(-0.01, 0.01), 0, rng.range(0, 3), 0));
    }
    return g;
  }
  const berry = kit.custom('berry', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.22, metalness: 0.05 }));
  const n = rng.int(7, 12);
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.008, 0.012);
    const a = rng.range(0, 6.28), d = Math.sqrt(rng.float()) * 0.035;
    const y = r + (d < 0.018 && i > 3 ? r * 1.4 : 0);
    g.add(mesh(new THREE.SphereGeometry(r, 8, 6), berry, Math.cos(a) * d, y, Math.sin(a) * d));
  }
  const leaf = stdMat(kit, 'leaf', [0.2, 0.42, 0.15], { roughness: 0.6, side: THREE.DoubleSide });
  for (let i = 0; i < 2; i++) g.add(mesh(leafGeometry(0.045, 0.015, 0.15), leaf, rng.range(-0.02, 0.02), 0.003, rng.range(-0.02, 0.02), -Math.PI / 2 + 0.15, 0, rng.range(0, 6.28)));
  return g;
}

function apple(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const r = rng.range(0.036, 0.044);
  const prof: V2[] = [[0.001, r * 0.18], [r * 0.45, r * 0.05], [r * 0.85, r * 0.35], [r, r * 0.95], [r * 0.92, r * 1.45], [r * 0.6, r * 1.72], [r * 0.2, r * 1.6], [0.001, r * 1.5]];
  const skin = kit.custom('apple', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.35, metalness: 0 }));
  const body = mesh(lathe(prof, 18), skin);
  // Blush: second colour on one side via vertex colours would cost a material variant; use a tinted overlay cap instead.
  const holder = new THREE.Group();
  holder.add(body);
  const blush = kit.custom('blush', () => new THREE.MeshStandardMaterial({ color: col([0.85, 0.75, 0.25]), roughness: 0.4, transparent: true, opacity: 0.5 }));
  const bl = mesh(new THREE.SphereGeometry(r * 1.005, 12, 8, 0, Math.PI * 0.8, Math.PI * 0.25, Math.PI * 0.5), blush, 0, r * 0.95, 0);
  holder.add(bl);
  const stem = kit.get('wood');
  holder.add(mesh(cyl(0.002, 0.0015, r * 1.5, r * 1.5 + 0.018, 5), stem, 0, 0, 0, 0, 0, 0.25));
  const leaf = stdMat(kit, 'leaf', [0.25, 0.5, 0.18], { roughness: 0.55, side: THREE.DoubleSide });
  holder.add(mesh(leafGeometry(0.035, 0.012), leaf, 0.004, r * 1.62, 0, 0.2, 0, -1.1));
  holder.rotation.z = rng.range(-0.25, 0.25);
  holder.rotation.y = rng.range(0, 6.28);
  g.add(holder);
  return g;
}

function cheese(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const R = 0.11, h = rng.range(0.05, 0.065);
  const ang = rng.range(0.6, 0.85);
  const outline: V2[] = [[0, 0]];
  for (let i = 0; i <= 8; i++) {
    const a = -ang / 2 + (ang * i) / 8;
    outline.push([Math.cos(a) * R, Math.sin(a) * R]);
  }
  const paste = kit.custom('paste', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.75, metalness: 0 }));
  const wedge = extrudeOutline(outline, h, 0.002);
  const m = mesh(wedge, paste, -R * 0.45, h / 2, 0, Math.PI / 2, 0, 0);
  g.add(m);
  // Red wax rind on the outer arc.
  const wax = stdMat(kit, 'wax', [0.65, 0.07, 0.06], { roughness: 0.35 });
  const rind = mesh(new THREE.CylinderGeometry(R + 0.003, R + 0.003, h, 12, 1, true, Math.PI / 2 - ang / 2, ang), wax, -R * 0.45, h / 2, 0);
  rind.material = wax;
  (rind.material as THREE.Material).side = THREE.DoubleSide;
  g.add(rind);
  // Holes on the two cut faces (circles turned to face outwards).
  const hole = stdMat(kit, 'hole', darker(v.primary, 0.72), { roughness: 0.9 });
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1;
    const a = (side * ang) / 2;
    const t = rng.range(0.25, 0.85);
    const nx = side > 0 ? -Math.sin(a) : Math.sin(a), nz = side > 0 ? Math.cos(a) : -Math.cos(a);
    const phi = Math.atan2(nx, nz);
    g.add(mesh(new THREE.CircleGeometry(rng.range(0.004, 0.009), 8), hole, -R * 0.45 + Math.cos(a) * R * t + nx * 0.0015, rng.range(0.014, h - 0.014), Math.sin(a) * R * t + nz * 0.0015, 0, phi, 0));
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function stew(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.get('wood');
  const prof: V2[] = [[0.001, 0], [0.04, 0], [0.045, 0.006], [0.07, 0.03], [0.082, 0.055], [0.084, 0.06], [0.078, 0.06], [0.064, 0.03], [0.035, 0.01], [0.001, 0.01]];
  g.add(mesh(lathe(prof, 20), wood));
  const broth = kit.custom('broth', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.2, metalness: 0 }));
  g.add(mesh(new THREE.CircleGeometry(0.074, 20), broth, 0, 0.05, 0, -Math.PI / 2));
  const chunkCols: RGB[] = [[0.85, 0.5, 0.15], [0.5, 0.25, 0.12], [0.9, 0.85, 0.6], [0.3, 0.55, 0.2]];
  for (let i = 0; i < 9; i++) {
    const c = rng.pick(chunkCols);
    const a = rng.range(0, 6.28), d = Math.sqrt(rng.float()) * 0.058;
    g.add(mesh(new THREE.BoxGeometry(0.012, 0.009, 0.012), stdMat(kit, 'chunk' + chunkCols.indexOf(c), c, { roughness: 0.6 }), Math.cos(a) * d, 0.052, Math.sin(a) * d, rng.range(0, 1), rng.range(0, 3), 0));
  }
  // Spoon leaning on the rim.
  const spoon = new THREE.Group();
  spoon.add(mesh(cyl(0.004, 0.003, 0, 0.14, 6), wood));
  const bowl = new THREE.SphereGeometry(0.016, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  bowl.scale(1, 0.5, 1.4);
  spoon.add(mesh(bowl, wood, 0, -0.004, 0, Math.PI / 2, 0, 0));
  spoon.position.set(0.02, 0.05, 0);
  spoon.rotation.set(0, rng.range(0, 6.28), -1.0);
  g.add(spoon);
  return g;
}

function pie(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const tin = kit.custom('tin', () => new THREE.MeshStandardMaterial({ color: new THREE.Color(0.45, 0.45, 0.47), roughness: 0.45, metalness: 1 }));
  g.add(mesh(lathe([[0.001, 0], [0.085, 0], [0.1, 0.03], [0.104, 0.032], [0.001, 0.005]], 24), tin));
  const crust = kit.get('organic');
  g.add(mesh(lathe([[0.1, 0.03], [0.104, 0.038], [0.098, 0.044], [0.09, 0.04], [0.001, 0.04]], 24), crust));
  const filling = stdMat(kit, 'filling', [0.32, 0.04, 0.16], { roughness: 0.25 });
  g.add(mesh(new THREE.CircleGeometry(0.09, 20), filling, 0, 0.041, 0, -Math.PI / 2));
  // Lattice.
  for (let i = -2; i <= 2; i++) {
    const L = 2 * Math.sqrt(Math.max(0, 0.09 * 0.09 - (i * 0.034) ** 2));
    g.add(mesh(new THREE.BoxGeometry(L, 0.006, 0.014), crust, 0, 0.045, i * 0.034));
    g.add(mesh(new THREE.BoxGeometry(0.014, 0.006, L), crust, i * 0.034, 0.047, 0));
  }
  // Crimped rim.
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    g.add(mesh(new THREE.SphereGeometry(0.009, 6, 4), crust, Math.cos(a) * 0.095, 0.042, Math.sin(a) * 0.095));
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function jar(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const r = rng.range(0.035, 0.042), h = rng.range(0.08, 0.1);
  const prof: V2[] = [[0.001, 0], [r * 0.85, 0], [r, r * 0.25], [r, h * 0.78], [r * 0.82, h * 0.88], [r * 0.8, h * 0.95], [r * 0.86, h], [r * 0.8, h]];
  const liqMat = v.glow > 0.05
    ? kit.custom('jarliq', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.2, transparent: true, opacity: 0.9, emissive: col(v.glowColor), emissiveIntensity: 1 + v.glow * 2 }))
    : undefined;
  g.add(glassVessel(kit, prof, rng.range(0.7, 0.85), h, 18, liqMat));
  // Cloth cover tied with twine.
  const cover = kit.tinted('cloth', [0.82, 0.74, 0.58], 'jarcover');
  const coverGeo = lathe([[0.001, h + 0.006], [r * 0.6, h + 0.005], [r * 0.95, h + 0.001], [r * 1.02, h - 0.012], [r * 1.08, h - 0.022]], 16);
  g.add(mesh(coverGeo, cover));
  const twine = stdMat(kit, 'twine', [0.55, 0.45, 0.3], { roughness: 0.9 });
  g.add(mesh(new THREE.TorusGeometry(r * 0.86, 0.0025, 5, 20), twine, 0, h - 0.008, 0, Math.PI / 2));
  // Paper label.
  const paper = kit.get('paper');
  g.add(mesh(new THREE.CylinderGeometry(r + 0.0015, r + 0.0015, h * 0.32, 12, 1, true, -0.6, 1.2), paper, 0, h * 0.45, 0));
  if (v.glow > 0.05) {
    const halo = mesh(new THREE.SphereGeometry(r * 1.25, 12, 8), kit.get('glow'), 0, h * 0.42, 0);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.15;
    halo.castShadow = false;
    g.add(halo);
  }
  return g;
}

function mushrooms(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const n = rng.int(1, 3);
  const cap = kit.get('organic');
  const stemMat = stdMat(kit, 'stem', [0.88, 0.85, 0.78], { roughness: 0.8, emissive: col(v.glowColor), emissiveIntensity: v.glow * 0.4 });
  const gills = stdMat(kit, 'gills', darker(v.primary, 0.6), { roughness: 0.9 });
  for (let i = 0; i < n; i++) {
    const s = i === 0 ? 1 : rng.range(0.55, 0.8);
    const m = new THREE.Group();
    const h = 0.06 * s * rng.range(0.85, 1.15), cr = 0.03 * s * rng.range(0.9, 1.2);
    m.add(mesh(lathe([[0.009 * s, 0], [0.007 * s, h * 0.5], [0.006 * s, h]], 8), stemMat));
    m.add(mesh(lathe([[0.002, h - 0.004], [cr * 0.9, h - 0.003], [cr, h + 0.002], [cr * 0.85, h + cr * 0.4], [cr * 0.45, h + cr * 0.75], [0.001, h + cr * 0.82]], 14), cap));
    m.add(mesh(new THREE.CircleGeometry(cr * 0.9, 14), gills, 0, h - 0.0035, 0, Math.PI / 2));
    // Spots for toxic-looking (yellowish/red) caps.
    if (v.primary[0] > 0.5 && v.primary[2] < 0.5) {
      const spot = stdMat(kit, 'spot', [0.95, 0.93, 0.85]);
      for (let k = 0; k < 4; k++) {
        const a = rng.range(0, 6.28);
        m.add(mesh(new THREE.SphereGeometry(0.0035 * s, 5, 4), spot, Math.cos(a) * cr * 0.55, h + cr * 0.58, Math.sin(a) * cr * 0.55));
      }
    }
    const a = (i / n) * 6.28 + rng.range(0, 1);
    m.position.set(i ? Math.cos(a) * 0.03 : 0, 0, i ? Math.sin(a) * 0.03 : 0);
    m.rotation.set(rng.range(-0.2, 0.2), 0, rng.range(-0.25, 0.25));
    g.add(m);
  }
  if (v.glow > 0.1) {
    const halo = mesh(new THREE.SphereGeometry(0.05, 10, 8), kit.get('glow'), 0, 0.06, 0);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.05;
    halo.castShadow = false;
    g.add(halo);
  }
  return g;
}

function mug(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.tinted('wood', [0.5, 0.33, 0.18], 'mugwood');
  const r = 0.04, h = 0.11;
  g.add(mesh(lathe([[0.001, 0], [r, 0], [r * 1.02, h * 0.5], [r * 0.95, h], [r * 0.85, h], [r * 0.9, 0.012], [0.001, 0.012]], 16), wood));
  const band = kit.get('dark');
  for (const y of [0.015, h - 0.018]) g.add(mesh(new THREE.TorusGeometry(r * 1.02, 0.0035, 4, 18), band, 0, y, 0, Math.PI / 2));
  g.add(mesh(new THREE.TorusGeometry(0.028, 0.006, 6, 12, Math.PI), wood, r + 0.004, h * 0.5, 0, 0, 0, -Math.PI / 2));
  const ale = kit.custom('ale', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.2 }));
  g.add(mesh(new THREE.CircleGeometry(r * 0.86, 14), ale, 0, h - 0.012, 0, -Math.PI / 2));
  const foam = stdMat(kit, 'foam', [0.96, 0.92, 0.82], { roughness: 0.9 });
  const fg = lumpGeometry(rng, 1, 0.15, false, [r * 0.95, 0.018, r * 0.95]);
  g.add(mesh(fg, foam, 0, h - 0.012, 0));
  return g;
}

function waterskin(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const leather = kit.get('leather');
  const body = lumpGeometry(rng, 1, 0.05, false, [0.11, 0.06, 0.07]);
  g.add(mesh(body, leather));
  // Neck, stitched seam & wooden stopper.
  const neck = mesh(cyl(0.018, 0.012, 0, 0.05, 10), leather, 0.1, 0.05, 0, 0, 0, -1.1);
  g.add(neck);
  g.add(mesh(cyl(0.011, 0.012, 0, 0.022, 8), kit.get('wood'), 0.145, 0.073, 0, 0, 0, -1.1));
  const thread = stdMat(kit, 'seam', [0.85, 0.8, 0.65], { roughness: 0.9 });
  // Side seam following the bag's silhouette (ellipse in the XY plane).
  const seam = new THREE.TorusGeometry(0.106, 0.0018, 4, 40);
  seam.scale(1, 0.55, 1);
  g.add(mesh(seam, thread, 0, 0.06, 0));
  // Shoulder strap loop.
  const strap = kit.get('grip');
  // Carrying strap slung over the top of the bag, neck to tail.
  g.add(mesh(tube([new THREE.Vector3(0.085, 0.085, 0.0), new THREE.Vector3(0.03, 0.128, 0.025), new THREE.Vector3(-0.04, 0.125, 0.03), new THREE.Vector3(-0.1, 0.07, 0.0)], 0.005, 5), strap));
  return g;
}
