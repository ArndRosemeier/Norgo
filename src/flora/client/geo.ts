/**
 * Geometry builder for procedural flora.
 *
 * All flora meshes share one vertex layout so a single shader family can render
 * trees, plants, rocks and props:
 *   position (3), normal (3), uv (2)  — uv in local atlas-cell space (may exceed 1 → wraps)
 *   color    (3)  primary color A (bark / leaf / cap)
 *   aColor2  (3)  secondary color B, selected by the atlas G mask (veins, spots, birch marks)
 *   aWind    (4)  x = bend (m of sway at full wind), y = leaf flutter 0..1, z = phase 0..1, w = glow 0..1
 *   aCell    (1)  atlas cell index
 *
 * Builders push vertices through small helpers (tubes with parallel-transport
 * frames, lathes, leaf cards, spheres, prisms). Everything is plain arrays
 * until `toGeometry()`, which packs typed arrays once.
 */
import * as THREE from 'three';

export type V3 = [number, number, number];

export interface VertexStyle {
  /** Color A / B. */
  a: V3;
  b: V3;
  cell: number;
  /** Sway weight (meters at full wind). Can be overridden per vertex via bendFn. */
  bend: number;
  flutter: number;
  phase: number;
  glow: number;
}

export function style(o: Partial<VertexStyle> & { a: V3; cell: number }): VertexStyle {
  return { b: o.a, bend: 0, flutter: 0, phase: 0, glow: 0, ...o };
}


export function v3(x = 0, y = 0, z = 0): V3 {
  return [x, y, z];
}
export function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function len(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function norm(a: V3): V3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function lerp3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** Rotate v around unit axis k by angle a (Rodrigues). */
export function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  const kd = dot(k, v) * (1 - c);
  const kx = cross(k, v);
  return [v[0] * c + kx[0] * s + k[0] * kd, v[1] * c + kx[1] * s + k[1] * kd, v[2] * c + kx[2] * s + k[2] * kd];
}
/** Any unit vector perpendicular to v. */
export function perp(v: V3): V3 {
  const a: V3 = Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return norm(cross(v, a));
}

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  colA: number[] = [];
  colB: number[] = [];
  wind: number[] = [];
  cell: number[] = [];
  idx: number[] = [];
  /** Optional per-vertex bend override from position (e.g. height-based sway). */
  bendFn: ((p: V3, base: number) => number) | null = null;

  get count() {
    return this.pos.length / 3;
  }

  vertex(p: V3, n: V3, u: number, v: number, s: VertexStyle, mixB = 0): number {
    const i = this.count;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    if (mixB > 0) {
      this.colA.push(s.a[0] + (s.b[0] - s.a[0]) * mixB, s.a[1] + (s.b[1] - s.a[1]) * mixB, s.a[2] + (s.b[2] - s.a[2]) * mixB);
    } else this.colA.push(s.a[0], s.a[1], s.a[2]);
    this.colB.push(s.b[0], s.b[1], s.b[2]);
    const bend = this.bendFn ? this.bendFn(p, s.bend) : s.bend;
    this.wind.push(bend, s.flutter, s.phase, s.glow);
    this.cell.push(s.cell);
    return i;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Generalized cylinder along a polyline with radii. Parallel-transport frames
   * avoid twisting. v runs along the length (meters * vScale), u around.
   */
  tube(pts: V3[], radii: number[], radial: number, s: VertexStyle, opts: { vScale?: number; capEnd?: boolean; capStart?: boolean; uRepeat?: number; radiusFn?: (i: number, a: number) => number; flatShade?: boolean } = {}) {
    const n = pts.length;
    if (n < 2) return;
    const vScale = opts.vScale ?? 0.5;
    const uRep = opts.uRepeat ?? 1;
    // Tangents.
    const tans: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      tans.push(norm(sub(b, a)));
    }
    let nx = perp(tans[0]);
    const rings: number[] = [];
    let vAcc = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        // Parallel transport of the normal.
        const t0 = tans[i - 1], t1 = tans[i];
        const ax = cross(t0, t1);
        const al = len(ax);
        if (al > 1e-5) nx = rotate(nx, scale(ax, 1 / al), Math.asin(Math.min(1, al)) * (dot(t0, t1) < 0 ? -1 : 1));
        vAcc += len(sub(pts[i], pts[i - 1]));
      }
      const bx = cross(tans[i], nx);
      const base = this.count;
      rings.push(base);
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const r = radii[i] * (opts.radiusFn ? opts.radiusFn(i, a) : 1);
        const dir: V3 = [nx[0] * ca + bx[0] * sa, nx[1] * ca + bx[1] * sa, nx[2] * ca + bx[2] * sa];
        const p: V3 = [pts[i][0] + dir[0] * r, pts[i][1] + dir[1] * r, pts[i][2] + dir[2] * r];
        this.vertex(p, dir, (k / radial) * uRep, vAcc * vScale, s);
      }
      if (i > 0) {
        const r0 = rings[i - 1], r1 = base;
        for (let k = 0; k < radial; k++) this.quad(r0 + k, r0 + k + 1, r1 + k + 1, r1 + k);
      }
    }
    if (opts.capEnd) {
      const c = this.vertex(pts[n - 1], tans[n - 1], 0.5, vAcc * vScale + 0.1, s);
      const r = rings[n - 1];
      for (let k = 0; k < radial; k++) this.tri(r + k, r + k + 1, c);
    }
    if (opts.capStart) {
      const c = this.vertex(pts[0], scale(tans[0], -1), 0.5, -0.1, s);
      const r = rings[0];
      for (let k = 0; k < radial; k++) this.tri(r + k + 1, r + k, c);
    }
  }

  /**
   * Lathe around +Y at `origin`: profile of [radius, y] pairs (bottom → top).
   * Normals from the profile slope. Optional radius modulation by angle (ribs).
   */
  lathe(origin: V3, profile: [number, number][], radial: number, s: VertexStyle, opts: { vScale?: number; ribFn?: (a: number, t: number) => number; uRepeat?: number; mixBFn?: (t: number) => number; axis?: V3 } = {}) {
    const n = profile.length;
    const vScale = opts.vScale ?? 0.5;
    const uRep = opts.uRepeat ?? 1;
    const rings: number[] = [];
    let vAcc = 0;
    // Optional axis tilt: build in local frame (axis = up).
    const up = opts.axis ? norm(opts.axis) : ([0, 1, 0] as V3);
    const ax = perp(up);
    const az = cross(ax, up);
    for (let i = 0; i < n; i++) {
      const [r, y] = profile[i];
      const pr = profile[Math.max(0, i - 1)], nx = profile[Math.min(n - 1, i + 1)];
      const dr = nx[0] - pr[0], dy = nx[1] - pr[1];
      // Profile normal (outward): rotate tangent (dr, dy) by -90°.
      let pnR = dy, pnY = -dr;
      const pl = Math.hypot(pnR, pnY) || 1;
      pnR /= pl;
      pnY /= pl;
      if (i > 0) vAcc += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
      const t = i / (n - 1);
      const base = this.count;
      rings.push(base);
      const mb = opts.mixBFn ? opts.mixBFn(t) : 0;
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rr = r * (opts.ribFn ? opts.ribFn(a, t) : 1);
        const dir: V3 = [ax[0] * ca + az[0] * sa, ax[1] * ca + az[1] * sa, ax[2] * ca + az[2] * sa];
        const p: V3 = [origin[0] + dir[0] * rr + up[0] * y, origin[1] + dir[1] * rr + up[1] * y, origin[2] + dir[2] * rr + up[2] * y];
        const nn: V3 = norm([dir[0] * pnR + up[0] * pnY, dir[1] * pnR + up[1] * pnY, dir[2] * pnR + up[2] * pnY]);
        this.vertex(p, nn, (k / radial) * uRep, vAcc * vScale, s, mb);
      }
      if (i > 0) {
        // Winding chosen so front faces point outward (rocks render single-sided).
        const r0 = rings[i - 1], r1 = base;
        for (let k = 0; k < radial; k++) this.quad(r0 + k, r1 + k, r1 + k + 1, r0 + k + 1);
      }
    }
  }

  /**
   * Leaf card: quad centered at c spanning `w` along `right` and `h` along `up`,
   * anchored at its bottom edge when `anchorBottom`. Normals are bent towards
   * `normalHint` (usually outward from the crown centre) for soft volumetric lighting.
   */
  card(c: V3, right: V3, up: V3, w: number, h: number, s: VertexStyle, normalHint: V3 | null, anchorBottom = true, uv: [number, number, number, number] = [0, 0, 1, 1]) {
    const n = norm(cross(right, up));
    const nn = normalHint ? norm(lerp3(n, normalHint, 0.75)) : n;
    const hw = w / 2;
    const y0 = anchorBottom ? 0 : -h / 2, y1 = anchorBottom ? h : h / 2;
    const p = (x: number, y: number): V3 => [c[0] + right[0] * x + up[0] * y, c[1] + right[1] * x + up[1] * y, c[2] + right[2] * x + up[2] * y];
    const sTip = { ...s, flutter: s.flutter };
    const a = this.vertex(p(-hw, y0), nn, uv[0], uv[1], s);
    const b = this.vertex(p(hw, y0), nn, uv[2], uv[1], s);
    const cc = this.vertex(p(hw, y1), nn, uv[2], uv[3], sTip);
    const d = this.vertex(p(-hw, y1), nn, uv[0], uv[3], sTip);
    this.quad(a, b, cc, d);
  }

  /** Strip along a polyline (fronds, kelp, grass blades): width per point, oriented by side vectors. */
  strip(pts: V3[], sides: V3[], widths: number[], s: VertexStyle, normals: V3[] | null, vRange: [number, number] = [0, 1], uRange: [number, number] = [0, 1], flutterFn?: (t: number) => number) {
    const n = pts.length;
    let prevL = -1, prevR = -1;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const v = vRange[0] + (vRange[1] - vRange[0]) * t;
      const w = widths[i] / 2;
      const nn = normals ? normals[i] : norm(cross(sides[i], i < n - 1 ? sub(pts[i + 1], pts[i]) : sub(pts[i], pts[i - 1])));
      const st = flutterFn ? { ...s, flutter: flutterFn(t) } : s;
      const l = this.vertex(add(pts[i], scale(sides[i], -w)), nn, uRange[0], v, st);
      const r = this.vertex(add(pts[i], scale(sides[i], w)), nn, uRange[1], v, st);
      if (prevL >= 0) this.quad(prevL, prevR, r, l);
      prevL = l;
      prevR = r;
    }
  }

  /** UV sphere / ellipsoid. */
  ellipsoid(c: V3, rx: number, ry: number, rz: number, seg: number, s: VertexStyle, deform?: (dir: V3) => number) {
    const rings = Math.max(3, Math.floor(seg / 2));
    const base = this.count;
    for (let j = 0; j <= rings; j++) {
      const th = (j / rings) * Math.PI;
      for (let k = 0; k <= seg; k++) {
        const ph = (k / seg) * Math.PI * 2;
        const dir: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        const d = deform ? deform(dir) : 1;
        const p: V3 = [c[0] + dir[0] * rx * d, c[1] + dir[1] * ry * d, c[2] + dir[2] * rz * d];
        this.vertex(p, norm([dir[0] / rx, dir[1] / ry, dir[2] / rz]), k / seg, j / rings, s);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let k = 0; k < seg; k++) {
        const a = base + j * (seg + 1) + k;
        const b = a + seg + 1;
        this.quad(a, b, b + 1, a + 1);
      }
  }

  /** Faceted bipyramid crystal from base point along dir. Flat-shaded (unshared vertices). */
  crystal(base: V3, dir: V3, len: number, r: number, facets: number, s: VertexStyle, twist = 0) {
    const d = norm(dir);
    const ax = perp(d);
    const az = cross(d, ax);
    const ring: V3[] = [];
    const mid = add(base, scale(d, len * 0.72));
    const bot = add(base, scale(d, -len * 0.05));
    const tip = add(base, scale(d, len));
    for (let k = 0; k < facets; k++) {
      const a = (k / facets) * Math.PI * 2 + twist;
      const off = add(scale(ax, Math.cos(a) * r), scale(az, Math.sin(a) * r));
      ring.push(off);
    }
    for (let k = 0; k < facets; k++) {
      const o0 = ring[k], o1 = ring[(k + 1) % facets];
      // Prism side.
      const p0 = add(bot, scale(o0, 0.85)), p1 = add(bot, scale(o1, 0.85)), p2 = add(mid, o1), p3 = add(mid, o0);
      const nn = norm(cross(sub(p1, p0), sub(p3, p0)));
      const a = this.vertex(p0, nn, 0, 0, s), b = this.vertex(p1, nn, 1, 0, s), c = this.vertex(p2, nn, 1, 0.75, s), e = this.vertex(p3, nn, 0, 0.75, s);
      this.quad(a, e, c, b);
      // Tip facet.
      const tn = norm(cross(sub(p2, p3), sub(tip, p3)));
      const f = this.vertex(p3, tn, 0, 0.75, s), g = this.vertex(p2, tn, 1, 0.75, s), h = this.vertex(tip, tn, 0.5, 1, s);
      this.tri(f, g, h);
    }
  }

  /** Append another builder (already in the same space). */
  merge(o: GeoBuilder) {
    const off = this.count;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.uv.push(...o.uv);
    this.colA.push(...o.colA);
    this.colB.push(...o.colB);
    this.wind.push(...o.wind);
    this.cell.push(...o.cell);
    for (const i of o.idx) this.idx.push(i + off);
  }

  /** Bake into a BufferGeometry. */
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colA, 3));
    g.setAttribute('aColor2', new THREE.Float32BufferAttribute(this.colB, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 4));
    g.setAttribute('aCell', new THREE.Float32BufferAttribute(this.cell, 1));
    const n = this.count;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Convert sRGB tuple to linear (vertex colors are interpreted linear by three). */
export function lin(c: readonly number[]): V3 {
  const f = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** Multiply color. */
export function mulc(c: V3, k: number): V3 {
  return [c[0] * k, c[1] * k, c[2] * k];
}

