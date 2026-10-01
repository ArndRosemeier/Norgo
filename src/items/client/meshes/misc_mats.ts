/**
 * Raw & intermediate material meshes (logs, ores, gems, hides, cloth bolts,
 * herbs...). These pile up in inventories and on the ground, so each reads
 * clearly at icon size: strong silhouettes, colour from the visual's primary.
 * Origin = resting base, +Y up.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { lathe, mesh, cyl, tube, extrudeOutline, type V2 } from './util';
import { lumpGeometry, stdMat, glowMat, sack, leafGeometry, lyingCyl, bendY, col, type RGB } from './misc_common';

const darker = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const lighter = (c: RGB, k: number): RGB => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];

export function buildMats(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  switch (shape) {
    case 'mat.log': return log(v, kit, rng);
    case 'mat.stick': return stick(v, kit, rng);
    case 'mat.bark': return bark(v, kit, rng);
    case 'mat.resin': return resin(v, kit, rng);
    case 'mat.fiber': return strands(v, kit, rng, 0.16, 0.0012, 26, true);
    case 'mat.reed': return strands(v, kit, rng, 0.3, 0.0035, 9, false);
    case 'mat.plank': return planks(v, kit, rng);
    case 'mat.seed': return seeds(v, kit, rng);
    case 'mat.stone': return rock(v, kit, rng, false);
    case 'mat.flint': return rock(v, kit, rng, true);
    case 'mat.lump': return lump(v, kit, rng);
    case 'mat.sack': return sack(kit, rng, 0.17, 0.065, [0.62, 0.52, 0.36], true, stdMat(kit, 'contents', v.primary, { roughness: 1 }));
    case 'mat.ore': return ore(v, kit, rng);
    case 'mat.crystal': return crystals(v, kit, rng);
    case 'mat.gem': return roughGem(v, kit, rng);
    case 'mat.gemcut': return cutGem(v, kit, rng);
    case 'mat.ingot': return ingot(v, kit, rng);
    case 'mat.bone': return bone(v, kit, rng);
    case 'mat.hide': return hide(v, kit, rng);
    case 'mat.feather': return feather(v, kit, rng);
    case 'mat.chitin': return chitin(v, kit, rng);
    case 'mat.scale': return scale(v, kit, rng);
    case 'mat.leather': return leatherRoll(v, kit, rng);
    case 'mat.cloth': return clothBolt(v, kit, rng);
    case 'mat.thread': return spool(v, kit, rng);
    case 'mat.rope': return rope(v, kit, rng);
    case 'mat.salt': return salt(v, kit, rng);
    case 'mat.sac': return venomSac(v, kit, rng);
    case 'mat.fang': return fang(v, kit, rng);
    case 'mat.paper': return paperStack(v, kit, rng);
    case 'mat.dust': return dustPouch(v, kit, rng);
    case 'herb': return herb(v, kit, rng);
  }
  return null;
}

function log(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const r = rng.range(0.07, 0.09), len = rng.range(0.42, 0.5);
  const barkM = kit.tinted('wood', darker(v.primary, 0.55), 'bark');
  const endM = kit.tinted('wood', lighter(v.primary, 0.35), 'endgrain');
  const geo = new THREE.CylinderGeometry(r * 0.95, r, len, 14, 6);
  // Bumpy bark (side vertices only; cap vertices sit inside the radius).
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (Math.hypot(x, z) < r * 0.9) continue;
    const a = Math.atan2(z, x);
    const k = 1 + Math.sin(a * 9 + y * 3) * 0.04 + Math.sin(a * 3 + y * 11) * 0.03;
    p.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, [barkM, endM, endM]);
  m.rotation.z = Math.PI / 2;
  m.position.y = r;
  m.castShadow = m.receiveShadow = true;
  g.add(m);
  // Growth rings on both ends.
  const ring = stdMat(kit, 'ring', darker(v.primary, 0.75), { roughness: 0.9 });
  for (const sx of [-1, 1])
    for (let i = 1; i <= 3; i++)
      g.add(mesh(new THREE.RingGeometry(r * i * 0.25, r * i * 0.25 + 0.002, 18), ring, sx * (len / 2 + 0.0005), r, 0, 0, sx * Math.PI / 2, 0));
  // A lopped branch stub.
  g.add(mesh(cyl(0.018, 0.014, 0, 0.04, 8), barkM, rng.range(-0.1, 0.1), r * 1.6, 0.02, 0.6, 0, 0.3));
  g.rotation.y = rng.range(-0.4, 0.4);
  return g;
}

function stick(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.get('wood');
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++) pts.push(new THREE.Vector3(-0.15 + i * 0.075, 0.009, rng.range(-0.012, 0.012)));
  g.add(mesh(tube(pts, 0.008, 6), wood));
  // Twig fork and a leaf.
  const twig = [pts[2].clone(), pts[2].clone().add(new THREE.Vector3(0.05, 0.004, 0.035))];
  g.add(mesh(tube(twig, 0.0045, 5), wood));
  const leaf = stdMat(kit, 'leaf', [0.3, 0.45, 0.18], { side: THREE.DoubleSide });
  g.add(mesh(leafGeometry(0.035, 0.012), leaf, twig[1].x, 0.01, twig[1].z, -Math.PI / 2 + 0.1, 0, -1));
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function bark(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const outer = kit.tinted('wood', darker(v.primary, 0.9), 'barkstrip');
  (outer as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  for (let i = 0; i < 3; i++) {
    const w = rng.range(0.8, 1.3);
    // Arc centred on -X, axis turned to lie along X: a concave-up curl resting on its back.
    const geo = new THREE.CylinderGeometry(0.03, 0.032, rng.range(0.13, 0.17), 10, 3, true, Math.PI * 1.5 - w / 2, w);
    const m = mesh(geo, outer, rng.range(-0.01, 0.01), 0.032, (i - 1) * 0.04, 0, rng.range(-0.3, 0.3), Math.PI / 2);
    m.rotation.order = 'YXZ';
    g.add(m);
  }
  return g;
}

function resin(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const amber = kit.custom('amber', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.15, transparent: true, opacity: 0.85, emissive: col(v.primary), emissiveIntensity: 0.12 }));
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.014, 0.024);
    g.add(mesh(lumpGeometry(rng, 1, 0.2, false, [s, s * 0.75, s]), amber, rng.range(-0.03, 0.03), 0, rng.range(-0.03, 0.03)));
  }
  return g;
}

function strands(v: ItemVisual, kit: ItemMatKit, rng: Rng, len: number, r: number, n: number, wavy: boolean) {
  const g = new THREE.Group();
  const m = kit.custom('strand', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.85 }));
  for (let i = 0; i < n; i++) {
    const z = rng.range(-1, 1) * (wavy ? 0.018 : 0.014);
    const y = r + Math.abs(rng.gaussian(0, 0.006));
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const spread = Math.abs(t - 0.5) * 2;
      pts.push(new THREE.Vector3((t - 0.5) * len * rng.range(0.92, 1.05), y + (wavy ? Math.sin(t * 9 + i) * 0.002 : 0), z * (0.4 + spread * 0.9)));
    }
    g.add(mesh(tube(pts, r, 3, false, 8), m));
  }
  // Tie in the middle.
  const tie = stdMat(kit, 'tie', [0.42, 0.3, 0.18], { roughness: 0.9 });
  g.add(mesh(new THREE.TorusGeometry(0.012, 0.0028, 5, 12), tie, 0, 0.011, 0, 0, Math.PI / 2, 0));
  if (!wavy) {
    // Reed seed-heads on one end.
    const tuft = stdMat(kit, 'tuft', [0.5, 0.36, 0.22]);
    for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CapsuleGeometry(0.007, 0.035, 2, 6), tuft, len / 2 + 0.02, 0.01 + i * 0.004, (i - 1) * 0.012, 0, 0, Math.PI / 2));
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function planks(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.get('wood');
  const knot = stdMat(kit, 'knot', darker(v.primary, 0.55));
  for (let i = 0; i < 2; i++) {
    const L = rng.range(0.42, 0.5);
    const p = mesh(new THREE.BoxGeometry(L, 0.022, 0.1), wood, rng.range(-0.02, 0.02), 0.011 + i * 0.022, rng.range(-0.01, 0.01), 0, rng.range(-0.12, 0.12), 0);
    g.add(p);
    p.add(mesh(new THREE.CircleGeometry(0.008, 10), knot, rng.range(-0.12, 0.12), 0.0115, rng.range(-0.02, 0.02), -Math.PI / 2));
  }
  return g;
}

function seeds(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = sack(kit, rng, 0.07, 0.032, [0.82, 0.74, 0.58], true, stdMat(kit, 'seedheap', v.primary, { roughness: 0.8 }));
  const seed = kit.custom('seed', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.55 }));
  for (let i = 0; i < 9; i++) {
    const s = new THREE.SphereGeometry(0.005, 6, 4);
    s.scale(1, 0.55, 0.65);
    const a = rng.range(0, 6.28), d = rng.range(0.04, 0.07);
    g.add(mesh(s, seed, Math.cos(a) * d, 0.003, Math.sin(a) * d, 0, rng.range(0, 6), 0));
  }
  return g;
}

function rock(v: ItemVisual, kit: ItemMatKit, rng: Rng, flint: boolean) {
  const g = new THREE.Group();
  if (flint) {
    // Glossy knapped nodule with a chalky cortex half.
    const glossy = kit.custom('flint', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.28, metalness: 0.05, flatShading: true }));
    g.add(mesh(lumpGeometry(rng, 0.05, 0.3, true, [1.2, 0.6, 0.9], 1), glossy));
    const cortex = stdMat(kit, 'cortex', [0.82, 0.78, 0.7], { roughness: 1 });
    const cm = mesh(lumpGeometry(rng, 0.046, 0.15, false, [1.15, 0.55, 0.85]), cortex, -0.014, 0, 0);
    cm.scale.set(0.8, 1, 1);
    g.add(cm);
  } else {
    const stone = kit.custom('rock', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.9, flatShading: true }));
    const geo = lumpGeometry(rng, 0.06, 0.28, true, [1.1, 0.75, 0.95], 1);
    g.add(mesh(geo, stone));
    // Lichen patches on the top.
    if (rng.chance(0.5)) {
      const top = geo.boundingBox ? geo.boundingBox.max.y : 0.08;
      const lichen = stdMat(kit, 'lichen', [0.55, 0.62, 0.35], { roughness: 1 });
      for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CircleGeometry(rng.range(0.008, 0.014), 7), lichen, rng.range(-0.015, 0.015), top - 0.004, rng.range(-0.015, 0.015), -Math.PI / 2 + rng.range(-0.3, 0.3), 0, 0));
    }
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function lump(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const m = kit.custom('lump', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: v.material === 'organic' ? 0.35 : 0.7 }));
  const g = new THREE.Group();
  const geo = lumpGeometry(rng, 0.05, 0.18, false, [1.1, 0.7, 1]);
  g.add(mesh(geo, m));
  // Finger dents.
  const top = geo.boundingBox ? geo.boundingBox.max.y : 0.07;
  const dent = stdMat(kit, 'dent', darker(v.primary, 0.8), { roughness: 0.8 });
  for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CircleGeometry(0.008, 8), dent, rng.range(-0.015, 0.015), top - 0.002, rng.range(-0.015, 0.015), -Math.PI / 2 + rng.range(-0.3, 0.3), 0, 0));
  return g;
}

function ore(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const coalish = v.primary[0] + v.primary[1] + v.primary[2] < 0.45;
  if (coalish) {
    // Coal / charcoal: a heap of glossy black chunks.
    const black = kit.custom('coal', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.35, metalness: 0.2, flatShading: true }));
    for (let i = 0; i < 5; i++) {
      const s = rng.range(0.022, 0.034);
      g.add(mesh(lumpGeometry(rng, s, 0.3, true, [1, 0.8, 1], 0), black, rng.range(-0.035, 0.035), i > 2 ? 0.02 : 0, rng.range(-0.03, 0.03), rng.range(0, 3), rng.range(0, 3), 0));
    }
    return g;
  }
  const host = kit.custom('host', () => new THREE.MeshStandardMaterial({ color: col([0.24, 0.22, 0.21]), roughness: 0.9, flatShading: true }));
  g.add(mesh(lumpGeometry(rng, 0.055, 0.25, true, [1.15, 0.8, 1], 1), host));
  // Metallic veins & nuggets breaking the surface.
  const vein = kit.custom('vein', () => new THREE.MeshStandardMaterial({
    color: col(v.primary), roughness: 0.3, metalness: 0.85, flatShading: true, emissive: col(v.glowColor), emissiveIntensity: v.glow,
  }));
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const dir = new THREE.Vector3(rng.range(-1, 1), rng.range(0.1, 1), rng.range(-1, 1)).normalize();
    const s = rng.range(0.012, 0.02);
    // Seat each nugget on the host's surface so it pokes out instead of hiding inside.
    const nug = lumpGeometry(rng, s, 0.35, true, [1.4, 0.7, 1], 0);
    nug.center();
    g.add(mesh(nug, vein, dir.x * 0.06, 0.044 + dir.y * 0.04, dir.z * 0.054, rng.range(0, 3), rng.range(0, 3), 0));
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function crystalMat(v: ItemVisual, kit: ItemMatKit) {
  const dark = v.primary[0] + v.primary[1] + v.primary[2] < 0.5;
  return kit.custom('crystal', () => new THREE.MeshStandardMaterial({
    color: col(v.primary), roughness: dark ? 0.05 : 0.08, metalness: dark ? 0.3 : 0.05, transparent: !dark, opacity: dark ? 1 : 0.82, flatShading: true,
    emissive: col(v.glow > 0 ? v.glowColor : v.primary), emissiveIntensity: v.glow > 0 ? 0.4 + v.glow * 1.2 : 0.02,
  }));
}

function prism(r: number, h: number, tip: number): THREE.BufferGeometry {
  return lathe([[0.0005, 0], [r, 0.0005], [r, h], [0.0005, h + tip]], 6);
}

function crystals(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const mat = crystalMat(v, kit);
  if (v.primary[0] + v.primary[1] + v.primary[2] < 0.5) {
    // Obsidian: a conchoidal glassy shard.
    g.add(mesh(lumpGeometry(rng, 0.055, 0.35, true, [1.2, 0.55, 0.8], 0), mat));
    return g;
  }
  const base = kit.custom('matrix', () => new THREE.MeshStandardMaterial({ color: col([0.3, 0.28, 0.3]), roughness: 0.95, flatShading: true }));
  g.add(mesh(lumpGeometry(rng, 0.035, 0.25, true, [1.3, 0.45, 1.1], 0), base));
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    const h = rng.range(0.04, 0.1) * (i === 0 ? 1.3 : 1);
    const r = h * rng.range(0.12, 0.2);
    const c = mesh(prism(r, h, r * 1.6), mat, rng.range(-0.02, 0.02), 0.01, rng.range(-0.02, 0.02), rng.range(-0.6, 0.6), rng.range(0, 6), rng.range(-0.6, 0.6));
    if (i === 0) c.rotation.set(rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15));
    g.add(c);
  }
  if (v.glow > 0.1) {
    const halo = mesh(new THREE.SphereGeometry(0.07, 10, 8), glowMat(kit, 'chalo', v.glowColor, 1), 0, 0.05, 0);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.1 * v.glow;
    halo.castShadow = false;
    g.add(halo);
  }
  return g;
}

function roughGem(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const m = kit.custom('rough', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.9, flatShading: true }));
  g.add(mesh(lumpGeometry(rng, 0.022, 0.35, true, [1, 0.8, 0.9], 0), m));
  // Host rock still clinging.
  const host = kit.custom('host', () => new THREE.MeshStandardMaterial({ color: col([0.35, 0.33, 0.3]), roughness: 0.95, flatShading: true }));
  g.add(mesh(lumpGeometry(rng, 0.014, 0.3, true, [1.2, 0.7, 1], 0), host, 0.016, 0, 0.006));
  return g;
}

function cutGem(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const m = kit.custom('cut', () => new THREE.MeshStandardMaterial({
    color: col(v.primary), roughness: 0.04, metalness: 0.15, flatShading: true, transparent: true, opacity: 0.92, emissive: col(v.primary), emissiveIntensity: 0.18,
  }));
  const r = 0.02;
  // Brilliant cut: pointed pavilion, girdle, table crown. Low radial count = facets.
  const cut: V2[] = [[0.0005, 0], [r, r * 0.85], [r, r * 0.95], [r * 0.6, r * 1.3], [0.0005, r * 1.32]];
  const gem = mesh(lathe(cut, 8), m);
  // Rest it tipped over so the table catches light in icons.
  gem.rotation.set(rng.range(0.9, 1.2), rng.range(0, 6), 0);
  gem.position.y = r * 0.9;
  g.add(gem);
  const spark = mesh(new THREE.SphereGeometry(r * 0.5, 6, 4), glowMat(kit, 'spark', v.primary, 1.2), 0, r, 0);
  (spark.material as THREE.MeshBasicMaterial).opacity = 0.25;
  spark.castShadow = false;
  g.add(spark);
  return g;
}

function ingot(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const metal = kit.custom('ingot', () => {
    const c = (kit.get('metal') as THREE.MeshStandardMaterial).clone();
    c.color = col(v.primary);
    c.metalness = 1;
    c.roughness = 0.35;
    return c;
  });
  // Trapezoid bar: shrink the top face.
  const L = 0.13, W = 0.05, H = 0.03;
  const geo = new THREE.BoxGeometry(L, H, W, 1, 1, 1);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setXYZ(i, p.getX(i) * 0.84, p.getY(i), p.getZ(i) * 0.72);
  geo.computeVertexNormals();
  g.add(mesh(geo, metal, 0, H / 2, 0));
  // Foundry stamp: a sunken ring + bar on the top face.
  const stamp = kit.custom('stamp', () => new THREE.MeshStandardMaterial({ color: col(darker(v.primary, 0.55)), metalness: 1, roughness: 0.6 }));
  g.add(mesh(new THREE.RingGeometry(0.007, 0.0095, 16), stamp, -0.02, H + 0.0004, 0, -Math.PI / 2));
  g.add(mesh(new THREE.PlaneGeometry(0.02, 0.003), stamp, 0.018, H + 0.0004, 0, -Math.PI / 2));
  g.rotation.y = rng.range(-0.5, 0.5);
  return g;
}

function bone(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const b = kit.get('bone');
  const L = rng.range(0.2, 0.26), r = 0.011;
  g.add(mesh(lathe([[r * 1.5, 0], [r, L * 0.15], [r * 0.85, L * 0.5], [r, L * 0.85], [r * 1.5, L]], 10), b, -L / 2, r * 1.8, 0, 0, 0, -Math.PI / 2));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(r * 1.55, 8, 6), b, sx * (L / 2 + 0.002), r * 1.6, sz * r * 0.9));
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function hide(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const furry = v.material === 'fur';
  const outerM = furry ? kit.get('fur') : kit.get('primary');
  const innerM = stdMat(kit, 'flesh', [0.82, 0.7, 0.58], { roughness: 0.8 });
  // Folded in thirds: stacked irregular slabs, the top one showing the flesh side.
  const outline = (s: number): V2[] => {
    const pts: V2[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const rr = s * (1 + Math.sin(a * 3 + 1) * 0.12 + rng.range(-0.06, 0.06));
      pts.push([Math.cos(a) * rr * 1.4, Math.sin(a) * rr]);
    }
    return pts;
  };
  const th = furry ? 0.016 : 0.008;
  for (let i = 0; i < 3; i++) {
    const geo = extrudeOutline(outline(0.075 - i * 0.004), th, 0.003);
    g.add(mesh(geo, i === 2 && !furry ? innerM : outerM, rng.range(-0.006, 0.006), th / 2 + i * (th + 0.001), rng.range(-0.006, 0.006), -Math.PI / 2, 0, rng.range(-0.15, 0.15)));
  }
  // Leg flaps hanging out of the fold.
  for (let i = 0; i < 2; i++) g.add(mesh(extrudeOutline([[0, -0.01], [0.05, -0.006], [0.055, 0.006], [0, 0.01]], 0.006), outerM, 0.09, 0.004, (i - 0.5) * 0.08, -Math.PI / 2, 0, (i - 0.5) * 0.6));
  return g;
}

function feather(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const vane = kit.custom('vane', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.8, side: THREE.DoubleSide }));
  const tipC = kit.custom('vanetip', () => new THREE.MeshStandardMaterial({ color: col(darker(v.primary, 0.4)), roughness: 0.8, side: THREE.DoubleSide }));
  const L = rng.range(0.16, 0.2);
  const f = new THREE.Group();
  f.add(mesh(bendY(leafGeometry(L, 0.018, 0.04), 2.5), vane));
  // Darker barred tip, bent along the same arc.
  const tip = leafGeometry(L * 0.25, 0.012);
  tip.translate(0, L * 0.75, 0.0008);
  f.add(mesh(bendY(tip, 2.5), tipC));
  f.add(mesh(bendY(cyl(0.0016, 0.0008, -0.025, L, 4), 2.5), kit.get('bone')));
  f.rotation.set(-Math.PI / 2, 0, rng.range(0, 6.28));
  f.position.y = 0.004;
  g.add(f);
  return g;
}

function chitin(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const shell = kit.custom('chitin', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.18, metalness: 0.25, side: THREE.DoubleSide }));
  const geo = new THREE.SphereGeometry(0.08, 16, 10, 0, Math.PI * 0.7, 0, Math.PI * 0.45);
  geo.scale(1, 0.5, 1.3);
  const m = mesh(geo, shell, 0, -0.008, 0, 0, rng.range(0, 6), 0);
  g.add(m);
  // Growth ridges: thin latitude bands of the same dome, slightly proud.
  const ridge = kit.custom('ridge', () => new THREE.MeshStandardMaterial({ color: col(lighter(v.primary, 0.35)), roughness: 0.25, metalness: 0.2, side: THREE.DoubleSide }));
  for (let i = 1; i <= 3; i++) {
    const band = new THREE.SphereGeometry(0.0812, 16, 1, 0, Math.PI * 0.7, i * 0.11, 0.025);
    band.scale(1, 0.5, 1.3);
    m.add(mesh(band, ridge));
  }
  return g;
}

function scale(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const big = v.primary[0] > 0.45 && v.primary[1] < 0.3; // dragon scale
  const m = kit.custom('scale', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.22, metalness: 0.55, emissive: col(big ? [0.6, 0.15, 0.05] : [0, 0, 0]), emissiveIntensity: big ? 0.15 : 0 }));
  const s = big ? 0.11 : 0.05;
  const pts: V2[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = s * (Math.sin(a) > 0 ? 1 - Math.sin(a) * 0.15 : 1);
    pts.push([Math.cos(a) * rr * 0.8, Math.sin(a) * rr * (Math.sin(a) < 0 ? 1.25 : 1)]);
  }
  const geo = extrudeOutline(pts, s * 0.08, s * 0.03);
  // Cup it (after laying flat the rim curls down, the centre stays proud).
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + (p.getX(i) ** 2 + p.getY(i) ** 2) * (0.25 / s));
  geo.computeVertexNormals();
  g.add(mesh(geo, m, 0, s * 0.3, 0, Math.PI / 2, 0, rng.range(0, 6)));
  // Central keel ridge.
  g.add(mesh(new THREE.CapsuleGeometry(s * 0.04, s * 1.1, 2, 6), m, 0, s * 0.34, 0, Math.PI / 2, 0, 0));
  return g;
}

function leatherRoll(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const leather = kit.get('primary');
  const len = 0.2, r = 0.035;
  g.add(lyingCyl(leather, r, len, 16));
  // Spiral visible on the ends + loose tongue.
  const edge = kit.tinted('primary', darker(v.primary, 0.6), 'edge');
  for (const sx of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 30; i++) {
      const a = (i / 30) * Math.PI * 2 * 2.5;
      const rr = r * (0.25 + 0.75 * (i / 30));
      pts.push(new THREE.Vector3(sx * (len / 2 + 0.001), r + Math.sin(a) * rr, Math.cos(a) * rr));
    }
    g.add(mesh(tube(pts, 0.0018, 3, false, 40), edge));
  }
  g.add(mesh(new THREE.PlaneGeometry(len * 0.95, 0.05), leather, 0, 0.002, r + 0.022, -Math.PI / 2, 0, 0));
  const tie = stdMat(kit, 'thong', darker(v.primary, 0.5));
  for (const x of [-0.05, 0.05]) g.add(mesh(new THREE.TorusGeometry(r + 0.002, 0.0025, 5, 18), tie, x, r, 0, 0, Math.PI / 2, 0));
  g.rotation.y = rng.range(-0.5, 0.5);
  return g;
}

function clothBolt(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const cloth = kit.get('cloth');
  const len = 0.26, r = 0.045;
  g.add(lyingCyl(cloth, r, len, 18));
  // Wooden core tube showing at the ends.
  g.add(lyingCyl(kit.tinted('wood', [0.6, 0.45, 0.28], 'core'), 0.012, len + 0.02, 10));
  const coreM = g.children[1] as THREE.Mesh;
  coreM.position.y = r;
  // Contrasting selvedge stripes.
  const stripe = kit.tinted('cloth', v.secondary, 'stripe');
  for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(r + 0.0012, r + 0.0012, 0.012, 18, 1, true), stripe, sx * (len / 2 - 0.012), r, 0, 0, 0, Math.PI / 2));
  // Loose end draped down to the ground.
  const drape = new THREE.PlaneGeometry(len * 0.98, 0.07, 1, 6);
  const p = drape.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + 0.035) / 0.07;
    const a = t * Math.PI * 0.5;
    p.setXYZ(i, p.getX(i), r + Math.cos(a) * r * 1.02 - t * r, Math.sin(a) * r * 1.02 + t * 0.035);
  }
  drape.computeVertexNormals();
  g.add(mesh(drape, cloth));
  g.rotation.y = rng.range(-0.5, 0.5);
  return g;
}

function spool(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.tinted('wood', [0.66, 0.5, 0.32], 'spool');
  const thread = kit.custom('thread', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.75 }));
  g.add(mesh(lathe([[0.008, 0], [0.028, 0], [0.028, 0.008], [0.014, 0.012], [0.014, 0.068], [0.028, 0.072], [0.028, 0.08], [0.008, 0.08]], 16), wood));
  // Wound thread with visible helical ridges.
  const geo = new THREE.CylinderGeometry(0.023, 0.023, 0.056, 20, 24, true);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + Math.sin(y * 900 + Math.atan2(z, x)) * 0.015;
    p.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  g.add(mesh(geo, thread, 0, 0.04, 0));
  // Loose end.
  g.add(mesh(tube([new THREE.Vector3(0.023, 0.05, 0), new THREE.Vector3(0.04, 0.02, 0.01), new THREE.Vector3(0.06, 0.001, 0.03), new THREE.Vector3(0.09, 0.001, 0.02)], 0.0012, 3), thread));
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function rope(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const m = kit.custom('rope', () => {
    const base = (kit.get('cloth') as THREE.MeshStandardMaterial).clone();
    base.color = col(v.primary);
    base.roughness = 0.95;
    return base;
  });
  const pts: THREE.Vector3[] = [];
  const turns = 4;
  for (let i = 0; i <= turns * 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = 0.06 - (i / (turns * 16)) * 0.012;
    pts.push(new THREE.Vector3(Math.cos(a) * rr, 0.008 + (i / (turns * 16)) * 0.03, Math.sin(a) * rr));
  }
  // Tail end trailing off to the ground.
  const last = pts[pts.length - 1];
  pts.push(new THREE.Vector3(last.x + 0.03, 0.02, last.z + 0.05), new THREE.Vector3(last.x + 0.05, 0.008, last.z + 0.1));
  g.add(mesh(tube(pts, 0.008, 6, false, 180), m));
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function salt(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const bowl = kit.tinted('wood', [0.55, 0.38, 0.22], 'saltbowl');
  g.add(mesh(lathe([[0.001, 0], [0.035, 0], [0.05, 0.02], [0.055, 0.03], [0.05, 0.03], [0.03, 0.008], [0.001, 0.008]], 16), bowl));
  const crystal = kit.custom('salt', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.4, flatShading: true }));
  g.add(mesh(lathe([[0.046, 0.024], [0.03, 0.036], [0.001, 0.042]], 10), crystal));
  for (let i = 0; i < 10; i++) {
    const s = rng.range(0.004, 0.008);
    const a = rng.range(0, 6.28), d = rng.range(0, 0.035);
    g.add(mesh(new THREE.BoxGeometry(s, s, s), crystal, Math.cos(a) * d, 0.038 + rng.range(0, 0.004) - d * 0.25, Math.sin(a) * d, rng.range(0, 3), rng.range(0, 3), 0));
  }
  return g;
}

function venomSac(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const m = kit.custom('sac', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.15, transparent: true, opacity: 0.85, emissive: col(v.primary), emissiveIntensity: 0.15 }));
  g.add(mesh(lumpGeometry(rng, 0.035, 0.12, false, [1.2, 0.75, 1]), m));
  // Duct stump & veins.
  const vein = stdMat(kit, 'vein', [0.5, 0.15, 0.2], { roughness: 0.4 });
  g.add(mesh(cyl(0.006, 0.004, 0, 0.025, 6), m, 0.04, 0.02, 0, 0, 0, -1.2));
  for (let i = 0; i < 4; i++) {
    const a = rng.range(0, 6.28);
    const pts = [0, 0.4, 0.8].map((t) => new THREE.Vector3(Math.cos(a + t) * 0.042 * (1 - t * 0.25), 0.02 + t * 0.024, Math.sin(a + t) * 0.036 * (1 - t * 0.25)));
    g.add(mesh(tube(pts, 0.0012, 3, false, 8), vein));
  }
  return g;
}

function fang(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const b = kit.get('bone');
  const L = rng.range(0.07, 0.09);
  g.add(mesh(bendY(lathe([[0.009, 0], [0.01, L * 0.15], [0.007, L * 0.6], [0.0006, L]], 10), 12), b, -L * 0.3, 0.009, 0, 0, 0, -Math.PI / 2));
  // Darker root end.
  g.add(mesh(new THREE.SphereGeometry(0.0095, 8, 6), stdMat(kit, 'root', [0.55, 0.45, 0.32]), -L * 0.3, 0.009, 0));
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function paperStack(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const paper = kit.tinted('paper', v.primary, 'sheets');
  for (let i = 0; i < 5; i++) g.add(mesh(new THREE.BoxGeometry(0.15, 0.0012, 0.2), paper, rng.range(-0.006, 0.006), 0.0006 + i * 0.0013, rng.range(-0.006, 0.006), 0, rng.range(-0.08, 0.08), 0));
  // Top sheet curling up at one corner.
  const curl = new THREE.PlaneGeometry(0.15, 0.2, 4, 6);
  const p = curl.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, (p.getX(i) + p.getY(i) * 0.6) / 0.15);
    p.setZ(i, t * t * 0.02);
  }
  curl.computeVertexNormals();
  g.add(mesh(curl, paper, 0, 0.0075, 0, -Math.PI / 2, 0, 0.1));
  // Tie string.
  g.add(mesh(new THREE.BoxGeometry(0.16, 0.003, 0.003), stdMat(kit, 'twine', [0.55, 0.45, 0.3]), 0, 0.007, 0.03));
  return g;
}

function dustPouch(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const dust = kit.custom('dust', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.4, emissive: col(v.glowColor), emissiveIntensity: 0.5 + v.glow }));
  const g = sack(kit, rng, 0.08, 0.035, [0.32, 0.22, 0.4], true, dust);
  // Glitter motes on the heap and spilled in front.
  const glit = glowMat(kit, 'glitter', v.glow > 0 ? v.glowColor : v.primary, 2.5);
  for (let i = 0; i < 14; i++) {
    const a = rng.range(0, 6.28), heap = i < 7;
    const d = heap ? rng.range(0, 0.02) : rng.range(0.03, 0.06);
    const m = mesh(new THREE.OctahedronGeometry(rng.range(0.0015, 0.003), 0), glit, Math.cos(a) * d, heap ? 0.082 + rng.range(0, 0.004) : 0.002, Math.sin(a) * d);
    m.castShadow = false;
    g.add(m);
  }
  return g;
}

function herb(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const greenish = v.primary[1] > v.primary[0] * 1.05 && v.primary[1] > v.primary[2] * 0.9;
  const stemM = stdMat(kit, 'stem', [0.28, 0.42, 0.16], { roughness: 0.7 });
  const leafM = greenish
    ? kit.custom('herbleaf', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.6, side: THREE.DoubleSide, emissive: col(v.glowColor), emissiveIntensity: v.glow * 0.6 }))
    : stdMat(kit, 'leafg', [0.25, 0.45, 0.18], { side: THREE.DoubleSide });
  const flowerM = kit.custom('petal', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.55, side: THREE.DoubleSide, emissive: col(v.glowColor), emissiveIntensity: v.glow * 0.8 }));
  const whiteM = stdMat(kit, 'wht', [0.95, 0.95, 0.85], { side: THREE.DoubleSide });
  const centreM = stdMat(kit, 'centre', [0.85, 0.65, 0.15]);
  // A bundle of stems fanning from the tie.
  const n = rng.int(5, 7);
  const bundle = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const L = rng.range(0.13, 0.17);
    const stem = new THREE.Group();
    stem.add(mesh(cyl(0.0016, 0.0012, 0, L, 4), stemM));
    for (let k = 0; k < 3; k++) {
      const side = k % 2 ? 1 : -1;
      stem.add(mesh(leafGeometry(0.035, greenish ? 0.012 : 0.009, greenish ? 0.2 : 0), leafM, 0, L * (0.35 + k * 0.2), 0, 0, side * 0.9 + rng.range(-0.3, 0.3), side * 0.8));
    }
    if (!greenish || rng.chance(0.3)) {
      // Flower head: a ring of petals around a golden centre.
      const head = new THREE.Group();
      const petals = rng.int(5, 6);
      for (let k = 0; k < petals; k++) head.add(mesh(leafGeometry(0.014, 0.007), greenish ? whiteM : flowerM, 0, 0, 0, 0, 0, (k / petals) * Math.PI * 2));
      head.add(mesh(new THREE.SphereGeometry(0.004, 6, 4), centreM, 0, 0, 0.001));
      head.position.y = L;
      head.rotation.x = -0.4;
      stem.add(head);
    }
    stem.rotation.z = (i - (n - 1) / 2) * 0.09 + rng.range(-0.03, 0.03);
    bundle.add(stem);
  }
  // Twine wrap at the base.
  bundle.add(mesh(cyl(0.007, 0.007, 0.012, 0.03, 8), stdMat(kit, 'twine', [0.6, 0.5, 0.32], { roughness: 0.9 })));
  // Lay the bundle on the ground (stems along -Z, leaves up), centred, then spin it.
  bundle.rotation.x = -Math.PI / 2 + 0.08;
  bundle.position.set(0, 0.012, 0.07);
  g.add(bundle);
  g.rotation.y = rng.range(0, 6.28);
  return g;
}
