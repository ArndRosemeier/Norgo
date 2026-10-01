/**
 * Shared building blocks for the misc item meshes (consumables, materials,
 * trinkets): lumpy rocks, sacks & pouches, glass containers with liquid,
 * tied bundles, leaves. All sizes in meters; origin = resting base centre.
 */
import * as THREE from 'three';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { lathe, mesh, cyl, type V2 } from './util';

export type RGB = [number, number, number];

/** sRGB tuple → linear THREE.Color. */
export function col(c: RGB): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}

/** Simple PBR material (per-object, sky-patched through the kit). */
export function stdMat(kit: ItemMatKit, key: string, c: RGB, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return kit.custom(key, () => new THREE.MeshStandardMaterial({ color: col(c), roughness: 0.7, metalness: 0, ...o }));
}

/** Additive glow material in an arbitrary colour. */
export function glowMat(kit: ItemMatKit, key: string, c: RGB, strength = 2.5): THREE.Material {
  return kit.adopt(
    'glow:' + key,
    new THREE.MeshBasicMaterial({ color: col(c).multiplyScalar(strength), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
}

/**
 * Displaced sphere: rocks, lumps, ore, blobs. Displacement is a smooth
 * function of the *direction*, so duplicated vertices of non-indexed
 * polyhedra stay welded. `faceted` uses an icosahedron (chunky facets).
 */
export function lumpGeometry(rng: Rng, radius: number, amt: number, faceted: boolean, scale: [number, number, number] = [1, 1, 1], detail = 1): THREE.BufferGeometry {
  const g = faceted ? new THREE.IcosahedronGeometry(radius, detail) : new THREE.SphereGeometry(radius, 14, 10);
  const ph = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
  const fr = [rng.range(2, 3.5), rng.range(3, 5), rng.range(5, 8)];
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const n =
      Math.sin(v.x * fr[0] + ph[0]) * Math.cos(v.y * fr[0] + ph[1]) * 0.5 +
      Math.sin(v.y * fr[1] + ph[2]) * Math.sin(v.z * fr[1] + ph[3]) * 0.3 +
      Math.sin((v.x + v.z) * fr[2] + ph[1]) * 0.2;
    const r = radius * (1 + n * amt);
    p.setXYZ(i, v.x * r * scale[0], v.y * r * scale[1], v.z * r * scale[2]);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  // Rest on the ground.
  g.translate(0, -g.boundingBox!.min.y, 0);
  return g;
}

/**
 * Glass container with inner liquid. `profile` is the outer lathe profile
 * [radius, y] from base to lip; the liquid fills `fill` (0..1) of `liquidTop`.
 */
export function glassVessel(kit: ItemMatKit, profile: V2[], fill: number, liquidTop: number, seg = 18, liquidMat?: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  // Clear, faintly green glass: low opacity so the liquid colour reads true; env reflections give the sheen.
  const glassMat = kit.custom('vesselglass', () => new THREE.MeshStandardMaterial({ color: new THREE.Color(0.75, 0.85, 0.82), roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false }));
  const glass = mesh(lathe(profile, seg), glassMat);
  glass.renderOrder = 2;
  glass.castShadow = false;
  g.add(glass);
  // Liquid: shrink the profile inwards and cut it at the fill height.
  const top = liquidTop * fill;
  const inner: V2[] = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, y] = profile[i];
    if (y > top) {
      // interpolate the cut
      const [r0, y0] = profile[i - 1] ?? profile[0];
      const t = y === y0 ? 0 : (top - y0) / (y - y0);
      inner.push([Math.max(0.001, (r0 + (r - r0) * t) * 0.9 - 0.002), top]);
      break;
    }
    inner.push([Math.max(0.001, r * 0.9 - 0.002), Math.max(0.003, y + 0.003)]);
  }
  inner.push([0.0005, top]);
  const liq = mesh(lathe(inner, seg), liquidMat ?? kit.get('liquid'));
  liq.renderOrder = 1;
  g.add(liq);
  return g;
}

/** Cork stopper. */
export function cork(kit: ItemMatKit, r: number, y: number, h = 0.022): THREE.Mesh {
  return mesh(cyl(r * 0.92, r * 1.08, y - h * 0.4, y + h * 0.6, 10), stdMat(kit, 'cork', [0.62, 0.45, 0.28], { roughness: 0.95 }));
}

/**
 * Cloth sack / pouch with a cinched neck. `open` leaves the top open with a
 * heap of contents (material `contents`), otherwise it is tied with cord.
 */
export function sack(kit: ItemMatKit, rng: Rng, h: number, r: number, clothColor: RGB, open: boolean, contents?: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const sag = rng.range(0.9, 1.1);
  const prof: V2[] = open
    ? [[0.001, 0], [r * 0.75, 0.005], [r * 0.98, h * 0.12], [r * sag, h * 0.4], [r * 0.92, h * 0.68], [r * 0.7, h * 0.85], [r * 0.62, h * 0.9], [r * 0.72, h * 0.97], [r * 0.8, h]]
    : [[0.001, 0], [r * 0.75, 0.005], [r * 0.98, h * 0.12], [r * sag, h * 0.4], [r * 0.85, h * 0.66], [r * 0.4, h * 0.8], [r * 0.18, h * 0.84], [r * 0.24, h * 0.92], [r * 0.32, h], [0.001, h * 0.97]];
  const cloth = kit.tinted('cloth', clothColor, 'sack' + clothColor.join());
  const body = mesh(lathe(prof, 14), cloth);
  body.rotation.y = rng.range(0, 6.28);
  // Lumpy, slumped body.
  const p = body.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 + Math.sin(a * 3 + y * 40) * 0.05 + Math.sin(a * 5) * 0.03;
    p.setXYZ(i, x * k, y, z * k * 0.92);
  }
  body.geometry.computeVertexNormals();
  g.add(body);
  const cord = stdMat(kit, 'twine', [0.6, 0.5, 0.32], { roughness: 0.9 });
  if (open) {
    if (contents) {
      const heap = mesh(lathe([[r * 0.68, h * 0.9], [r * 0.55, h * 0.97], [r * 0.3, h * 1.03], [0.001, h * 1.05]], 12), contents);
      g.add(heap);
    }
    g.add(mesh(new THREE.TorusGeometry(r * 0.64, 0.004, 5, 18), cord, 0, h * 0.87, 0, Math.PI / 2));
  } else {
    g.add(mesh(new THREE.TorusGeometry(r * 0.2, 0.005, 5, 14), cord, 0, h * 0.82, 0, Math.PI / 2));
    // Dangling cord ends.
    g.add(mesh(cyl(0.003, 0.003, 0, h * 0.25, 4), cord, r * 0.2, h * 0.6, 0, 0, 0, 0.35));
  }
  return g;
}

/** Leaf outline (pointed ellipse), extruded paper-thin and slightly cupped. */
export function leafGeometry(len: number, wid: number, serrate = 0): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const w = Math.sin(t * Math.PI) * wid * (1 - t * 0.3) * (1 + (serrate && i % 2 ? serrate : 0));
    pts.push(new THREE.Vector2(w, t * len));
  }
  for (let i = N - 1; i >= 1; i--) {
    const t = i / N;
    const w = Math.sin(t * Math.PI) * wid * (1 - t * 0.3) * (1 + (serrate && i % 2 ? serrate : 0));
    pts.push(new THREE.Vector2(-w, t * len));
  }
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, (x * x) / (wid * 2) + Math.sin((y / len) * Math.PI) * len * 0.08);
  }
  g.computeVertexNormals();
  return g;
}

/** Cylinder mesh lying along X (logs, scrolls, rolls). y = radius so it rests on the ground. */
export function lyingCyl(mat: THREE.Material | THREE.Material[], r: number, len: number, seg = 14): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  const m = new THREE.Mesh(g, mat);
  m.rotation.z = Math.PI / 2;
  m.position.y = r;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Bend a geometry along Y into an arc around Z (fangs, horns, curled bark). `k` = curvature (1/m). */
export function bendY(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  if (Math.abs(k) < 1e-5) return g;
  const p = g.attributes.position as THREE.BufferAttribute;
  const R = 1 / k;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = y / R;
    p.setXYZ(i, R - (R - x) * Math.cos(a), (R - x) * Math.sin(a), z);
  }
  g.computeVertexNormals();
  return g;
}
