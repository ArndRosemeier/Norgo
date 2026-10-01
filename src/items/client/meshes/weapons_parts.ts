/**
 * Shared parts for weapon/tool meshes: swept tubes with elliptic sections
 * (bow limbs, gnarled staves, antlers, pick heads), vertex deformers, geometry
 * merging, rune engravings, enchantment halos, guards, pommels and hafts.
 *
 * Built in *weapon space*: +Y along the handle/blade, +X = cutting edge /
 * forward, Z = flat thickness. `buildWeaponsMesh` rotates the result so +X
 * becomes the item-space +Z edge direction.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import type { CultureStyle } from '../../data/styles';
import { mesh, lathe, cyl, extrudeOutline, wrappedGrip, type V2 } from './util';

/** Everything a part builder needs. */
export interface WCtx {
  v: ItemVisual;
  kit: ItemMatKit;
  rng: Rng;
  st: CultureStyle;
  /** Root group in weapon space. */
  g: THREE.Group;
  /** Meshes that should get an enchantment halo. */
  heads: THREE.Mesh[];
}

const V = THREE.Vector3;

export function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Sweep an elliptic cross-section along a curve. `rad(t)` returns radii along
 * the frame normal and binormal. With `plane` given, the binormal is fixed to
 * that axis (planar curves: bow limbs keep their width along Z).
 */
export function sweep(
  points: THREE.Vector3[], rad: (t: number) => [number, number],
  o: { segs?: number; radial?: number; plane?: THREE.Vector3; caps?: boolean; twist?: number } = {},
): THREE.BufferGeometry {
  const segs = o.segs ?? 24, radial = o.radial ?? 8;
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const frames = o.plane ? null : curve.computeFrenetFrames(segs, false);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const P = new V(), T = new V(), N = new V(), B = new V();
  const ends: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, P);
    if (o.plane) {
      curve.getTangentAt(t, T);
      B.copy(o.plane);
      N.crossVectors(B, T).normalize();
      B.crossVectors(T, N).normalize();
    } else {
      N.copy(frames!.normals[i]);
      B.copy(frames!.binormals[i]);
    }
    const [rn, rb] = rad(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2 + (o.twist ?? 0) * t;
      const c = Math.cos(a), s = Math.sin(a);
      pos.push(P.x + N.x * c * rn + B.x * s * rb, P.y + N.y * c * rn + B.y * s * rb, P.z + N.z * c * rn + B.z * s * rb);
      uv.push(j / radial, t * 4);
    }
    if (i === 0 || i === segs) ends.push(P.clone());
  }
  const row = radial + 1;
  for (let i = 0; i < segs; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  if (o.caps !== false) {
    const c0 = pos.length / 3;
    pos.push(ends[0].x, ends[0].y, ends[0].z);
    uv.push(0.5, 0);
    for (let j = 0; j < radial; j++) idx.push(c0, j + 1, j);
    const c1 = pos.length / 3;
    pos.push(ends[1].x, ends[1].y, ends[1].z);
    uv.push(0.5, 1);
    const base = segs * row;
    for (let j = 0; j < radial; j++) idx.push(c1, base + j, base + j + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Deform geometry vertices in place (then recompute normals). */
export function deform(g: THREE.BufferGeometry, f: (p: THREE.Vector3) => void): THREE.BufferGeometry {
  const a = g.attributes.position as THREE.BufferAttribute;
  const p = new V();
  for (let i = 0; i < a.count; i++) {
    p.set(a.getX(i), a.getY(i), a.getZ(i));
    f(p);
    a.setXYZ(i, p.x, p.y, p.z);
  }
  a.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Weld coincident vertices (same position & uv) so deformed extrusions shade
 * smoothly across their caps instead of showing triangulation facets.
 */
export function smoothShade(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-5);
  m.computeVertexNormals();
  return m;
}

/** Merge geometries regardless of indexing; keeps position/normal/uv. */
export function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const anyNonIndexed = geos.some((g) => !g.index);
  const prepared = geos.map((g) => {
    let h = anyNonIndexed && g.index ? g.toNonIndexed() : g;
    if (!h.attributes.normal) h.computeVertexNormals();
    if (!h.attributes.uv) h.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(h.attributes.position.count * 2), 2));
    for (const k of Object.keys(h.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') h.deleteAttribute(k);
    h.morphAttributes = {};
    return h;
  });
  const m = mergeGeometries(prepared, false);
  return m ?? prepared[0];
}

/** Transform a geometry by position/rotation/scale (returns it). */
export function place(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(sx, sy, sz));
  g.applyMatrix4(m);
  return g;
}

/** Cylinder between two arbitrary points. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): THREE.BufferGeometry {
  const d = new V().subVectors(b, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Fibonacci-sphere directions (spikes, studs). */
export function sphereDirs(n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    out.push(new V(Math.cos(ga * i) * r, y, Math.sin(ga * i) * r));
  }
  return out;
}

/** Cone spike pointing along dir from origin point. */
export function spike(at: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, seg = 5): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, len, seg, 1);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), dir.clone().normalize()));
  g.translate(at.x, at.y, at.z);
  return g;
}

/**
 * Engraved glyph strip along Y on both faces (z = ±zAt(y)). Used for dwarven
 * runes (dark inlay) and enchantment runes (glow material).
 */
export function runeStrip(c: WCtx, y0: number, y1: number, cell: number, zAt: (y: number) => number, mat: THREE.Material, xo: (y: number) => number = () => 0) {
  const geos: THREE.BufferGeometry[] = [];
  const r = () => c.rng.float();
  const stroke = cell * 0.16;
  // Cap glyph count so long blades stay within the triangle budget.
  const step = Math.max(cell * 1.25, (y1 - y0) / 28);
  for (let y = y0 + cell / 2; y < y1 - cell / 2; y += step) {
    const z = zAt(y) + 0.0004;
    const strokes = 2 + Math.floor(r() * 3);
    for (let k = 0; k < strokes; k++) {
      const vert = r() < 0.5;
      const ang = r() < 0.3 ? (r() < 0.5 ? 0.6 : -0.6) : 0;
      const len = cell * (0.45 + r() * 0.5);
      const ox = (r() - 0.5) * cell * 0.4, oy = (r() - 0.5) * cell * 0.4;
      for (const side of [1, -1]) {
        const b = new THREE.BoxGeometry(vert ? stroke : len, vert ? len : stroke, 0.0008);
        place(b, xo(y) + ox, y + oy, side * z, 0, 0, ang);
        geos.push(b);
      }
    }
  }
  if (geos.length) c.g.add(mesh(mergeAll(geos), mat, 0, 0, 0, 0, 0, 0, false));
}

/** Additive glowing shell around enchanted heads/blades. */
export function addHalos(c: WCtx) {
  if (c.v.glow <= 0.05) return;
  const col = new THREE.Color().setRGB(c.v.glowColor[0], c.v.glowColor[1], c.v.glowColor[2], THREE.SRGBColorSpace);
  const mat = new THREE.MeshBasicMaterial({ color: col.multiplyScalar(1.5), transparent: true, opacity: Math.min(0.22, 0.05 + c.v.glow * 0.15), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.BackSide });
  for (const h of c.heads) {
    const g = h.geometry.clone();
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
    const pad = 0.006;
    const sx = 1 + pad / Math.max(0.005, (bb.max.x - bb.min.x) / 2), sy = 1 + pad / Math.max(0.005, (bb.max.y - bb.min.y) / 2), sz = 1 + pad * 1.5 / Math.max(0.002, (bb.max.z - bb.min.z) / 2);
    deform(g, (p) => p.set(cx + (p.x - cx) * sx, cy + (p.y - cy) * sy, cz + (p.z - cz) * sz));
    const m = new THREE.Mesh(g, mat);
    m.position.copy(h.position);
    m.rotation.copy(h.rotation);
    m.scale.copy(h.scale);
    m.renderOrder = 2;
    h.parent?.add(m);
  }
}

// ------------------------------------------------------------------ hilts

export type GuardStyle = 'bar' | 'curved' | 'disc' | 'wings' | 'crescent' | 'spiked' | 'block' | 'knuckle' | 'swept' | 'none' | 'claw';
export type PommelStyle = 'wheel' | 'scent' | 'ball' | 'ring' | 'faceted' | 'spike' | 'claw' | 'block' | 'leaf';

/** Pick guard/pommel by culture motif + rng. */
export function hiltStyles(c: WCtx): { guard: GuardStyle; pommel: PommelStyle } {
  const r = c.rng;
  switch (c.st.motif) {
    case 'leafvine': return { guard: r.pick(['wings', 'curved', 'wings'] as GuardStyle[]), pommel: r.pick(['leaf', 'scent'] as PommelStyle[]) };
    case 'runic': return { guard: r.pick(['block', 'bar'] as GuardStyle[]), pommel: r.pick(['faceted', 'wheel', 'block'] as PommelStyle[]) };
    case 'spikes': return { guard: r.pick(['spiked', 'crescent', 'spiked'] as GuardStyle[]), pommel: r.pick(['spike', 'ball'] as PommelStyle[]) };
    case 'rough': return { guard: r.pick(['bar', 'spiked', 'none'] as GuardStyle[]), pommel: r.pick(['ball', 'spike'] as PommelStyle[]) };
    case 'scales': return { guard: r.pick(['claw', 'wings'] as GuardStyle[]), pommel: 'claw' };
    case 'crescent': return { guard: r.pick(['crescent', 'curved'] as GuardStyle[]), pommel: r.pick(['scent', 'ring'] as PommelStyle[]) };
    case 'megalith': return { guard: 'block', pommel: r.pick(['block', 'ball'] as PommelStyle[]) };
    case 'geometric': return { guard: r.pick(['disc', 'bar'] as GuardStyle[]), pommel: r.pick(['ball', 'faceted'] as PommelStyle[]) };
    default: return { guard: r.pick(['bar', 'curved', 'bar', 'disc'] as GuardStyle[]), pommel: r.pick(['wheel', 'scent', 'ball', 'wheel', 'faceted'] as PommelStyle[]) };
  }
}

/**
 * Crossguard centred at (0, y), spanning ±hw along X, `h` tall, `t` thick.
 * Returns the guard height actually used above y.
 */
export function guard(c: WCtx, style: GuardStyle, y: number, hw: number, h: number, t: number): number {
  const { kit, g } = c;
  const fancy = c.rng.chance(0.4) ? kit.get('trim') : kit.get('metal');
  const curveUp = c.st.curve * 0.5;
  switch (style) {
    case 'none':
      g.add(mesh(cyl(t * 0.9, t * 0.8, y - h * 0.3, y + h * 0.5, 10), kit.get('dark')));
      return h * 0.5;
    case 'disc': {
      g.add(mesh(lathe([[0.004, -h * 0.5], [hw * 0.55, -h * 0.4], [hw * 0.6, 0], [hw * 0.55, h * 0.4], [0.004, h * 0.5]], 18), fancy, 0, y, 0));
      return h * 0.5;
    }
    case 'block': {
      const ol: V2[] = [[-hw, -h / 2], [hw, -h / 2], [hw * 1.08, h / 2], [-hw * 1.08, h / 2]];
      g.add(mesh(extrudeOutline(ol, t * 1.6, 0.003), kit.get('dark'), 0, y, 0));
      // Studs across the face.
      for (const sx of [-hw * 0.7, 0, hw * 0.7]) for (const sz of [1, -1]) g.add(mesh(new THREE.SphereGeometry(h * 0.18, 6, 4), kit.get('trim'), sx, y, sz * t * 0.82));
      return h / 2;
    }
    case 'crescent': {
      // Horns curve up toward the blade.
      const pts: V2[] = [];
      const n = 12;
      for (let i = 0; i <= n; i++) {
        const a = Math.PI + Math.PI * (i / n);
        pts.push([Math.cos(a) * hw, h * 0.6 + Math.sin(a) * h * 1.4]);
      }
      pts.push([hw * 1.02, h * 1.9]);
      for (let i = n; i >= 0; i--) {
        const a = Math.PI + Math.PI * (i / n);
        pts.push([Math.cos(a) * hw * 0.78, h * 1.1 + Math.sin(a) * h * 0.9]);
      }
      pts.push([-hw * 1.02, h * 1.9]);
      g.add(mesh(extrudeOutline(pts, t, 0.0015), fancy, 0, y, 0));
      return h * 0.25;
    }
    case 'wings': case 'claw': {
      // Quillons sweeping toward the blade, tips like leaves or talons.
      const pts: V2[] = [];
      const n = 8;
      const up = style === 'claw' ? 0.5 : 1.2;
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        pts.push([s * hw, -h * 0.5 + s * s * h * up * 2.2 - (1 - s) * 0.002]);
      }
      for (let i = n; i >= 0; i--) {
        const s = i / n;
        pts.push([s * hw * 0.95, h * 0.5 + s * s * h * up * 2.6 + s * h * 0.4 * (1 - s)]);
      }
      const half = pts;
      const full: V2[] = [...half, ...half.slice().reverse().map(([x, yy]) => [-x, yy] as V2)];
      g.add(mesh(extrudeOutline(full, t, 0.0015), fancy, 0, y, 0));
      if (style === 'claw') for (const sx of [1, -1]) g.add(mesh(spike(new V(sx * hw * 0.95, y + h * 1.4, 0), new V(sx * 0.4, 1, 0), h * 1.2, t * 0.4), kit.get('dark')));
      return h * 0.5;
    }
    case 'knuckle': case 'swept': case 'bar': case 'curved': case 'spiked': default: {
      const n = 8;
      const top: V2[] = [], bot: V2[] = [];
      const bend = style === 'curved' ? 0.35 + curveUp : curveUp * 0.4;
      for (let i = -n; i <= n; i++) {
        const s = i / n;
        const w = 1 - 0.45 * Math.abs(s);
        const yy = bend * s * s * hw;
        top.push([s * hw, yy + (h / 2) * w]);
        bot.push([s * hw, yy - (h / 2) * w]);
      }
      const ol = [...bot, ...top.reverse()];
      g.add(mesh(extrudeOutline(ol, t, 0.0015), fancy, 0, y, 0));
      // Quillon terminals.
      for (const sx of [1, -1]) {
        const tx = sx * hw, ty = y + bend * hw;
        if (style === 'spiked') g.add(mesh(spike(new V(tx, ty, 0), new V(sx, 0.6, 0), h * 1.8, h * 0.45), kit.get('dark')));
        else g.add(mesh(new THREE.SphereGeometry(h * 0.42, 8, 6), fancy, tx, ty, 0));
      }
      // Écusson (langet) over the blade root.
      g.add(mesh(extrudeOutline([[-h * 0.55, 0], [h * 0.55, 0], [0, h * 1.3]], t * 1.15, 0.001), fancy, 0, y + h * 0.3, 0));
      if (style === 'knuckle' || style === 'swept') {
        // Knuckle bow from the +X quillon down to the pommel.
        const pts = [new V(hw * 0.95, y, 0), new V(hw * 1.1, y - 0.04, 0), new V(hw * 0.95, y - 0.09, 0), new V(0.035, y - 0.13, 0), new V(0.012, y - 0.15, 0)];
        g.add(mesh(sweep(pts, () => [0.004, 0.004], { segs: 14, radial: 6 }), fancy));
      }
      if (style === 'swept') {
        // Rapier cage: side ring + swept bars on both faces.
        const ring = new THREE.TorusGeometry(0.035, 0.0035, 6, 18);
        g.add(mesh(ring, fancy, 0, y + 0.012, 0, Math.PI / 2, 0, 0));
        for (const sz of [1, -1]) {
          const pts = [new V(-hw * 0.6, y, 0), new V(-0.02, y - 0.05, sz * 0.035), new V(0.03, y - 0.07, sz * 0.03), new V(hw * 0.95, y - 0.02, sz * 0.01)];
          g.add(mesh(sweep(pts, () => [0.0032, 0.0032], { segs: 14, radial: 5 }), fancy));
          const loop = [new V(-0.02, y, 0), new V(-0.01, y + 0.03, sz * 0.03), new V(0.02, y + 0.035, sz * 0.028), new V(0.03, y, 0)];
          g.add(mesh(sweep(loop, () => [0.003, 0.003], { segs: 10, radial: 5 }), fancy));
        }
      }
      return h / 2;
    }
  }
}

/** Pommel hanging below y (grip bottom). */
export function pommel(c: WCtx, style: PommelStyle, y: number, s: number) {
  const { kit, g } = c;
  const mat = c.rng.chance(0.5) ? kit.get('trim') : kit.get('metal');
  // Ferrule/collar between grip and pommel.
  g.add(mesh(cyl(s * 0.55, s * 0.6, y - s * 0.25, y, 10), kit.get('dark')));
  const py = y - s * 0.25;
  switch (style) {
    case 'wheel':
      g.add(mesh(new THREE.CylinderGeometry(s * 1.1, s * 1.1, s * 0.7, 18), mat, 0, py - s * 0.95, 0, Math.PI / 2));
      g.add(mesh(new THREE.CylinderGeometry(s * 0.55, s * 0.55, s * 0.9, 12), kit.get('dark'), 0, py - s * 0.95, 0, Math.PI / 2));
      g.add(mesh(cyl(s * 0.25, s * 0.35, py - s * 2.2, py - s * 1.9, 8), mat));
      break;
    case 'scent':
      g.add(mesh(lathe([[s * 0.5, 0], [s * 0.9, -s * 0.5], [s * 0.85, -s * 1.3], [s * 0.4, -s * 1.9], [s * 0.15, -s * 2.3], [0, -s * 2.45]], 12), mat, 0, py, 0));
      break;
    case 'leaf': {
      const ol: V2[] = [[0, 0], [s * 0.8, -s * 0.8], [s * 0.7, -s * 1.8], [0, -s * 2.8], [-s * 0.7, -s * 1.8], [-s * 0.8, -s * 0.8]];
      g.add(mesh(extrudeOutline(ol, s * 0.7, s * 0.15), mat, 0, py, 0));
      break;
    }
    case 'ring':
      g.add(mesh(new THREE.TorusGeometry(s * 0.9, s * 0.25, 6, 16), mat, 0, py - s * 0.9, 0));
      break;
    case 'faceted':
      g.add(mesh(new THREE.OctahedronGeometry(s * 1.1, 0), mat, 0, py - s * 1, 0, 0, Math.PI / 4, 0));
      break;
    case 'spike':
      g.add(mesh(new THREE.SphereGeometry(s * 0.75, 8, 6), mat, 0, py - s * 0.6, 0));
      g.add(mesh(spike(new V(0, py - s * 1.1, 0), new V(0, -1, 0), s * 1.8, s * 0.45), kit.get('dark')));
      break;
    case 'block':
      g.add(mesh(new THREE.BoxGeometry(s * 1.8, s * 1.4, s * 1.4), mat, 0, py - s * 0.75, 0));
      break;
    case 'claw': {
      g.add(mesh(new THREE.IcosahedronGeometry(s * 0.8, 1), kit.get('gem'), 0, py - s * 1.1, 0));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const pts = [new V(0, py, 0), new V(Math.cos(a) * s * 0.9, py - s * 0.7, Math.sin(a) * s * 0.9), new V(Math.cos(a) * s * 0.6, py - s * 1.7, Math.sin(a) * s * 0.6)];
        g.add(mesh(sweep(pts, (t) => [s * 0.2 * (1 - t * 0.8), s * 0.2 * (1 - t * 0.8)], { segs: 8, radial: 5 }), mat));
      }
      break;
    }
    case 'ball':
    default:
      g.add(mesh(new THREE.SphereGeometry(s, 12, 8), mat, 0, py - s * 0.85, 0));
  }
}

/** Wrapped grip from y0 to y1; sometimes wire-wrapped for fine items. */
export function grip(c: WCtx, y0: number, y1: number, r: number) {
  const wire = c.rng.chance(0.15);
  c.g.add(mesh(wrappedGrip(r, y0, y1, Math.min(16, Math.round((y1 - y0) / 0.014)), 10), wire ? c.kit.get('trim') : c.kit.get('grip')));
}

/**
 * Wooden haft from y0 to y1 with optional leather grip wrap at the origin,
 * butt cap and slight natural taper.
 */
export function haft(c: WCtx, y0: number, y1: number, r: number, opts: { wrap?: [number, number]; butt?: 'cap' | 'spike' | 'knob' | 'none'; mat?: THREE.Material; rings?: number[] } = {}) {
  const { kit, g } = c;
  const mat = opts.mat ?? kit.get('wood');
  g.add(mesh(lathe([[r * 1.05, y0], [r, y0 + (y1 - y0) * 0.5], [r * 0.92, y1]], 10), mat));
  if (opts.wrap) g.add(mesh(wrappedGrip(r * 1.12, opts.wrap[0], opts.wrap[1], Math.round((opts.wrap[1] - opts.wrap[0]) / 0.014), 10), kit.get('grip')));
  for (const ry of opts.rings ?? []) g.add(mesh(cyl(r * 1.25, r * 1.25, ry - 0.006, ry + 0.006, 10), kit.get('dark')));
  switch (opts.butt ?? 'cap') {
    case 'cap': g.add(mesh(lathe([[r * 1.2, y0 + 0.03], [r * 1.25, y0 + 0.005], [r * 0.8, y0 - 0.008], [0, y0 - 0.01]], 10), kit.get('dark'))); break;
    case 'spike': g.add(mesh(lathe([[r * 1.2, y0 + 0.05], [r * 1.15, y0], [r * 0.5, y0 - 0.06], [0, y0 - 0.1]], 8), kit.get('dark'))); break;
    case 'knob': g.add(mesh(new THREE.SphereGeometry(r * 1.6, 10, 8), kit.get('dark'), 0, y0, 0)); break;
    default: break;
  }
}
