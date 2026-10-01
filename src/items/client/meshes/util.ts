/**
 * Small geometry helpers shared by the item mesh builders. Everything is
 * built in item space: origin = grip point (or resting base for non-held
 * items), +Y along the blade/handle, +Z = edge/front direction, meters.
 */
import * as THREE from 'three';

export type V2 = [number, number];

/** Place a mesh with position / Euler rotation in one call. */
export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, castShadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

/** Lathe around Y from [radius, y] points. */
export function lathe(points: V2[], segments = 16, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)), segments, phiStart, phiLength);
}

/** Cylinder along Y between y0 and y1 (radii r0 bottom, r1 top). */
export function cyl(r0: number, r1: number, y0: number, y1: number, seg = 10, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, open);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

/**
 * Extrude a 2D outline (x = width axis, y = length axis) with thickness along
 * Z, bevelled so blades get a visible edge bevel. Result centred on z = 0.
 */
export function extrudeOutline(outline: V2[], depth: number, bevel = 0, bevelSegs = 1, holes: V2[][] = []): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0005, depth - bevel * 2), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: bevelSegs, steps: 1, curveSegments: 6,
  });
  g.translate(0, 0, -(depth - bevel * 2) / 2);
  g.computeVertexNormals();
  return g;
}

/**
 * Blade geometry: a lens/diamond cross-section swept along a 2D profile.
 * `profile` gives for each station [y, halfWidth, xOffset] (xOffset bends the
 * blade for sabres/scimitars). `thick` = spine half-thickness ratio of width.
 * `fuller` 0..1 carves a groove down the centre on both faces (to `fullerEnd` of length).
 * Single-edged blades put the spine on -X (`single`).
 */
export function bladeGeometry(
  profile: [number, number, number][], thick: number, opts: { fuller?: number; fullerEnd?: number; single?: boolean; edgeBevel?: number } = {},
): THREE.BufferGeometry {
  // Cross-section points around the blade (x across, z through), counter-clockwise.
  const sec: V2[] = opts.single
    ? [[-1, 0], [-1, 0.9], [-0.4, 1], [0.35, 0.55], [1, 0], [0.35, -0.55], [-0.4, -1], [-1, -0.9]]
    : [[-1, 0], [-0.55, 0.42], [-0.15, 0.95], [0, 1], [0.15, 0.95], [0.55, 0.42], [1, 0], [0.55, -0.42], [0.15, -0.95], [0, -1], [-0.15, -0.95], [-0.55, -0.42]];
  const n = sec.length;
  const rows = profile.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const len = profile[rows - 1][0] - profile[0][0] || 1;
  const fullerEnd = opts.fullerEnd ?? 0.7;
  for (let r = 0; r < rows; r++) {
    const [y, hw, xo] = profile[r];
    const t = (y - profile[0][0]) / len;
    const th = Math.max(0.0012, hw * thick);
    for (let i = 0; i <= n; i++) {
      const [sx, sz] = sec[i % n];
      let z = sz * th;
      // Fuller: pull the flat centre inwards along the first part of the blade.
      if (opts.fuller && t < fullerEnd && Math.abs(sx) < 0.4) z *= 1 - opts.fuller * (1 - Math.abs(sx) / 0.4) * Math.min(1, (fullerEnd - t) * 8);
      pos.push(xo + sx * hw, y, z);
      uv.push(i / n, t);
    }
  }
  for (let r = 0; r < rows - 1; r++)
    for (let i = 0; i < n; i++) {
      const a = r * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  // Cap the base (the tip is a zero-width station so it closes itself).
  const base = pos.length / 3;
  pos.push(profile[0][2], profile[0][0], 0);
  uv.push(0.5, 0);
  for (let i = 0; i < n; i++) idx.push(base, i + 1, i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tube along a polyline/curve of points. */
export function tube(points: THREE.Vector3[], radius: number, radial = 6, closed = false, segs?: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, closed);
  return new THREE.TubeGeometry(curve, segs ?? Math.max(4, points.length * 6), radius, radial, closed);
}

/** A leather/cord-wrapped grip: a helix-bumped cylinder along Y. */
export function wrappedGrip(r: number, y0: number, y1: number, turns = 8, seg = 12): THREE.BufferGeometry {
  const rows = Math.max(8, Math.round(turns * 6));
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, seg, rows, true);
  const p = g.attributes.position as THREE.BufferAttribute;
  const h = y1 - y0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const t = (y + h / 2) / h;
    const ridge = 0.5 + 0.5 * Math.cos(a + t * turns * Math.PI * 2);
    const k = 1 + 0.12 * Math.pow(ridge, 3);
    p.setXYZ(i, x * k, y, z * k);
  }
  g.translate(0, (y0 + y1) / 2, 0);
  g.computeVertexNormals();
  return g;
}

/** Merge-free group helper. */
export function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

/** Deterministic jitter helper from a float RNG. */
export function jitter(r: () => number, amt: number): number {
  return (r() - 0.5) * 2 * amt;
}
