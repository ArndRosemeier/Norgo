/**
 * Procedural creature meshing.
 *
 * The body layout's primitives (round cones, ellipsoids, rounded boxes bound to
 * bones) are blended with polynomial smooth-min into one signed distance field,
 * sampled on a bounding grid and polygonised with surface nets. That gives a
 * single organic skin where neck flows into shoulders and haunches into legs.
 *
 * Primitives thinner than the grid can resolve (insect legs, antennae, horns
 * tips, whiskers, claws) are emitted as explicit tubes/ellipsoids instead, so
 * nothing disappears at low resolution. Wings, fins and sails are skinned
 * membrane patches with their own geometry.
 *
 * Skin weights: each vertex is weighted to the bones of nearby primitives by a
 * soft-min over primitive distances, so joints bend smoothly. The same weights
 * blend part tags (keratin/shell/glow/mouth) and body regions for the shader.
 */
import * as THREE from 'three';
import type { BodyLayout, Prim, V3 } from '../body';

export interface CreatureGeometries {
  body: THREE.BufferGeometry;
  membrane: THREE.BufferGeometry | null;
}

// ------------------------------------------------------------------ primitive SDFs

interface PrimFrame {
  p: Prim;
  ax: number; ay: number; az: number; // unit axis a→b
  sxv: V3; // side axis
  upv: V3; // up axis
  len: number;
  /** AABB (world) */
  min: V3;
  max: V3;
  /** Largest radius (for weight falloff). */
  rad: number;
}

function frameFor(p: Prim): PrimFrame {
  let ax = p.b[0] - p.a[0], ay = p.b[1] - p.a[1], az = p.b[2] - p.a[2];
  let l = Math.hypot(ax, ay, az);
  if (p.type === 'ellipsoid' || l < 1e-6) { ax = 0; ay = 0; az = 1; l = p.type === 'ellipsoid' ? 0 : 1e-6; } else { ax /= l; ay /= l; az /= l; }
  // Reference up; vertical segments use forward instead.
  let rx = 0, ry = 1, rz = 0;
  if (Math.abs(ay) > 0.95) { rx = 0; ry = 0; rz = 1; }
  // side = normalize(cross(ref, axis))
  let sx = ry * az - rz * ay, sy = rz * ax - rx * az, sz = rx * ay - ry * ax;
  const sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl; sy /= sl; sz /= sl;
  // up = cross(axis, side)
  const ux = ay * sz - az * sy, uy = az * sx - ax * sz, uz = ax * sy - ay * sx;
  const rad = p.type === 'ellipsoid' ? p.ra * Math.max(p.sx, p.sy, p.b[0]) : Math.max(p.ra, p.rb) * Math.max(p.sx, p.sy);
  const min: V3 = [Math.min(p.a[0], p.type === 'ellipsoid' ? p.a[0] : p.b[0]) - rad, Math.min(p.a[1], p.type === 'ellipsoid' ? p.a[1] : p.b[1]) - rad, Math.min(p.a[2], p.type === 'ellipsoid' ? p.a[2] : p.b[2]) - rad];
  const max: V3 = [Math.max(p.a[0], p.type === 'ellipsoid' ? p.a[0] : p.b[0]) + rad, Math.max(p.a[1], p.type === 'ellipsoid' ? p.a[1] : p.b[1]) + rad, Math.max(p.a[2], p.type === 'ellipsoid' ? p.a[2] : p.b[2]) + rad];
  return { p, ax, ay, az, sxv: [sx, sy, sz], upv: [ux, uy, uz], len: l, min, max, rad };
}

/** Exact round-cone SDF (Inigo Quilez) in a squashed frame. */
function sdPrim(f: PrimFrame, x: number, y: number, z: number): number {
  const p = f.p;
  const px = x - p.a[0], py = y - p.a[1], pz = z - p.a[2];
  if (p.type === 'ellipsoid') {
    const rx = p.ra * p.sx, ry = p.ra * p.sy, rz = p.ra * p.b[0];
    const k0 = Math.hypot(px / rx, py / ry, pz / rz);
    const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
  }
  // Local coords: along axis, side, up.
  const t = px * f.ax + py * f.ay + pz * f.az;
  const s = px * f.sxv[0] + py * f.sxv[1] + pz * f.sxv[2];
  const u = px * f.upv[0] + py * f.upv[1] + pz * f.upv[2];
  if (p.type === 'box') {
    const hl = f.len / 2;
    const hx = p.ra * p.sx, hy = p.ra * p.sy;
    const rr = Math.min(hx, hy) * 0.25;
    const qx = Math.abs(s) - hx + rr, qy = Math.abs(u) - hy + rr, qz = Math.abs(t - hl) - hl + rr;
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - rr;
  }
  // Squash the cross-section, evaluate round cone in (t, r) space.
  const ss = s / p.sx, uu = u / p.sy;
  const scale = Math.min(p.sx, p.sy);
  const r1 = p.ra, r2 = p.rb, h = f.len;
  const q = Math.hypot(ss, uu);
  // 2D round cone: points (q, t), circles at t=0 radius r1 and t=h radius r2.
  const b = (r1 - r2) / h;
  const a = Math.sqrt(Math.max(0, 1 - b * b));
  const k = -q * b + t * a; // dot((q,t), (-b, a))
  let d: number;
  if (k < 0) d = Math.hypot(q, t) - r1;
  else if (k > a * h) d = Math.hypot(q, t - h) - r2;
  else d = q * a + t * b - r1;
  return d * scale;
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ------------------------------------------------------------------ geometry accumulation

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  skinI: number[] = [];
  skinW: number[] = [];
  part: number[] = [];
  region: number[] = [];
  idx: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, bones: number[], weights: number[], part: number[], region: number[]) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    for (let i = 0; i < 4; i++) {
      this.skinI.push(bones[i] ?? 0);
      this.skinW.push(weights[i] ?? 0);
    }
    this.part.push(part[0], part[1], part[2], part[3]);
    this.region.push(region[0], region[1]);
    return this.count - 1;
  }
  build(extra?: (g: THREE.BufferGeometry) => void): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinW, 4));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 4));
    g.setAttribute('aRegion', new THREE.Float32BufferAttribute(this.region, 2));
    g.setIndex(this.idx);
    extra?.(g);
    g.computeBoundingSphere();
    return g;
  }
}

const PART_VEC: number[][] = [
  [0, 0, 0, 0],
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const REGION_VEC: number[][] = [[0, 0], [1, 0], [0, 1]];

// ------------------------------------------------------------------ main entry

/**
 * Build skinned geometry for a body layout.
 * @param res grid cells along the longest axis (LOD0 ≈ 60, LOD1 ≈ 26)
 */
export function buildCreatureGeometry(body: BodyLayout, res: number): CreatureGeometries {
  const ext = Math.max(body.max[0] - body.min[0], body.max[1] - body.min[1], body.max[2] - body.min[2]);
  const h = ext / res;
  const frames = body.prims.map(frameFor);
  const thinLimit = h * 1.3;
  const sdfFrames: PrimFrame[] = [];
  const thinFrames: PrimFrame[] = [];
  for (const f of frames) {
    const p = f.p;
    const minR = p.type === 'ellipsoid' ? p.ra * Math.min(p.sx, p.sy, p.b[0]) : Math.max(p.ra, p.rb) * Math.min(p.sx, p.sy);
    if (minR < thinLimit && p.type !== 'box') thinFrames.push(f);
    else sdfFrames.push(f);
  }
  const g = new GeoBuilder();
  surfaceNets(body, sdfFrames, frames, h, g);
  for (const f of thinFrames) {
    if (f.p.type === 'ellipsoid') explicitEllipsoid(f, res > 40 ? 10 : 6, g);
    else explicitTube(f, res > 40 ? 8 : 5, g);
  }
  const body3 = g.build();
  const membrane = body.membranes.length ? buildMembranes(body, res > 40 ? 1 : 0.5) : null;
  return { body: body3, membrane };
}

// ------------------------------------------------------------------ surface nets

function surfaceNets(body: BodyLayout, sdf: PrimFrame[], all: PrimFrame[], h: number, g: GeoBuilder) {
  if (!sdf.length) return;
  let maxK = 0;
  for (const f of sdf) maxK = Math.max(maxK, f.p.k);
  const pad = 2 * h + maxK * 0.3;
  const ox = body.min[0] - pad, oy = body.min[1] - pad, oz = body.min[2] - pad;
  const nx = Math.ceil((body.max[0] - body.min[0] + pad * 2) / h) + 1;
  const ny = Math.ceil((body.max[1] - body.min[1] + pad * 2) / h) + 1;
  const nz = Math.ceil((body.max[2] - body.min[2] + pad * 2) / h) + 1;
  const NXY = nx * ny;
  const field = new Float32Array(nx * ny * nz).fill(1e3);
  // Splat each primitive only into its own (blend-expanded) bounding box.
  for (const f of sdf) {
    const k = f.p.k;
    const m = k + 2 * h;
    const i0 = Math.max(0, Math.floor((f.min[0] - m - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((f.max[0] + m - ox) / h));
    const j0 = Math.max(0, Math.floor((f.min[1] - m - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((f.max[1] + m - oy) / h));
    const k0 = Math.max(0, Math.floor((f.min[2] - m - oz) / h)), k1 = Math.min(nz - 1, Math.ceil((f.max[2] + m - oz) / h));
    for (let kk = k0; kk <= k1; kk++) {
      const z = oz + kk * h;
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * h;
        let idx = i0 + j * nx + kk * NXY;
        for (let i = i0; i <= i1; i++, idx++) {
          const d = sdPrim(f, ox + i * h, y, z);
          field[idx] = smin(field[idx], d, k);
        }
      }
    }
  }
  // Vertex per surface cell.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const CX = nx - 1, CXY = (nx - 1) * (ny - 1);
  const cornerOff = [0, 1, nx, nx + 1, NXY, NXY + 1, NXY + nx, NXY + nx + 1];
  const cornerPos = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const vals = new Float32Array(8);
  const tmpBones: number[] = [0, 0, 0, 0], tmpW: number[] = [0, 0, 0, 0], tmpPart = [0, 0, 0, 0], tmpReg = [0, 0];
  const boneAcc = new Float64Array(body.bones.length);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const base = i + j * nx + k * NXY;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          vals[c] = field[base + cornerOff[c]];
          if (vals[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          const va = vals[a], vb = vals[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += cornerPos[a][0] + (cornerPos[b][0] - cornerPos[a][0]) * t;
          sy += cornerPos[a][1] + (cornerPos[b][1] - cornerPos[a][1]) * t;
          sz += cornerPos[a][2] + (cornerPos[b][2] - cornerPos[a][2]) * t;
          n++;
        }
        const x = ox + (i + sx / n) * h, y = oy + (j + sy / n) * h, z = oz + (k + sz / n) * h;
        // Normal from the field gradient (trilinear over the cell corners).
        const gx = (vals[1] - vals[0]) + (vals[3] - vals[2]) + (vals[5] - vals[4]) + (vals[7] - vals[6]);
        const gy = (vals[2] - vals[0]) + (vals[3] - vals[1]) + (vals[6] - vals[4]) + (vals[7] - vals[5]);
        const gz = (vals[4] - vals[0]) + (vals[5] - vals[1]) + (vals[6] - vals[2]) + (vals[7] - vals[3]);
        const gl = Math.hypot(gx, gy, gz) || 1;
        skinVertex(all, x, y, z, h, boneAcc, tmpBones, tmpW, tmpPart, tmpReg);
        cellVert[i + j * CX + k * CXY] = g.vert(x, y, z, gx / gl, gy / gl, gz / gl, tmpBones, tmpW, tmpPart, tmpReg);
      }
  // Quads across sign-changing grid edges.
  const idx = g.idx;
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const p0 = field[i + j * nx + k * NXY];
        const c = (ii: number, jj: number, kk: number) => cellVert[ii + jj * CX + kk * CXY];
        // x-edge (i,j,k)-(i+1,j,k): cells around share j-1..j, k-1..k
        if (i < nx - 1) {
          const p1 = field[i + 1 + j * nx + k * NXY];
          if (p0 < 0 !== p1 < 0) quad(c(i, j - 1, k - 1), c(i, j, k - 1), c(i, j, k), c(i, j - 1, k), p0 >= 0);
        }
        const p2 = field[i + (j + 1) * nx + k * NXY];
        if (p0 < 0 !== p2 < 0) quad(c(i - 1, j, k - 1), c(i - 1, j, k), c(i, j, k), c(i, j, k - 1), p0 >= 0);
        const p3 = field[i + j * nx + (k + 1) * NXY];
        if (p0 < 0 !== p3 < 0) quad(c(i - 1, j - 1, k), c(i, j - 1, k), c(i, j, k), c(i - 1, j, k), p0 >= 0);
      }
}

/**
 * Soft skinning: weights from the distance to every nearby primitive. Writes
 * the 4 strongest bones, plus blended part/region tags.
 */
function skinVertex(all: PrimFrame[], x: number, y: number, z: number, h: number, acc: Float64Array, bones: number[], w: number[], part: number[], region: number[]) {
  acc.fill(0);
  part[0] = part[1] = part[2] = part[3] = 0;
  region[0] = region[1] = 0;
  let dmin = 1e9;
  const ds = _ds.length >= all.length ? _ds : (_ds = new Float64Array(all.length * 2));
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    const m = f.rad + f.p.k + 4 * h;
    if (x < f.min[0] - m || y < f.min[1] - m || z < f.min[2] - m || x > f.max[0] + m || y > f.max[1] + m || z > f.max[2] + m) {
      ds[i] = 1e9;
      continue;
    }
    const d = sdPrim(f, x, y, z);
    ds[i] = d;
    if (d < dmin) dmin = d;
  }
  let total = 0;
  for (let i = 0; i < all.length; i++) {
    if (ds[i] > 1e8) continue;
    const f = all[i];
    const sigma = Math.max(h * 0.7, f.p.k * 0.45 + f.rad * 0.08);
    const wi = Math.exp(-(ds[i] - dmin) / sigma);
    if (wi < 1e-4) continue;
    acc[f.p.bone] += wi;
    const pv = PART_VEC[f.p.part];
    part[0] += pv[0] * wi; part[1] += pv[1] * wi; part[2] += pv[2] * wi; part[3] += pv[3] * wi;
    const rv = REGION_VEC[f.p.region] ?? REGION_VEC[0];
    region[0] += rv[0] * wi; region[1] += rv[1] * wi;
    total += wi;
  }
  if (total <= 0) total = 1;
  part[0] /= total; part[1] /= total; part[2] /= total; part[3] /= total;
  region[0] /= total; region[1] /= total;
  // Top-4 bones.
  for (let s = 0; s < 4; s++) { bones[s] = 0; w[s] = 0; }
  for (let b = 0; b < acc.length; b++) {
    const v = acc[b];
    if (v <= 0) continue;
    for (let s = 0; s < 4; s++) {
      if (v > w[s]) {
        for (let t = 3; t > s; t--) { w[t] = w[t - 1]; bones[t] = bones[t - 1]; }
        w[s] = v;
        bones[s] = b;
        break;
      }
    }
  }
  const sw = w[0] + w[1] + w[2] + w[3] || 1;
  for (let s = 0; s < 4; s++) w[s] /= sw;
}
let _ds = new Float64Array(64);

// ------------------------------------------------------------------ explicit thin parts

function explicitTube(f: PrimFrame, sides: number, g: GeoBuilder) {
  const p = f.p;
  const bones = [p.bone, 0, 0, 0], w = [1, 0, 0, 0];
  const part = PART_VEC[p.part], region = REGION_VEC[p.region] ?? REGION_VEC[0];
  const [sx, sy, sz] = f.sxv, [ux, uy, uz] = f.upv;
  const ax = f.ax, ay = f.ay, az = f.az;
  // Rings: cap A pole, cap A mid, start, end, cap B mid, cap B pole (as a capsule with tapered radius).
  const rings: { t: number; r: number; off: number; nAx: number }[] = [
    { t: 0, r: p.ra * 0.7, off: -p.ra * 0.7, nAx: -0.7 },
    { t: 0, r: p.ra, off: 0, nAx: 0 },
    { t: 1, r: p.rb, off: 0, nAx: 0 },
    { t: 1, r: p.rb * 0.7, off: p.rb * 0.7, nAx: 0.7 },
  ];
  const start = g.count;
  // Pole A
  g.vert(p.a[0] - ax * p.ra, p.a[1] - ay * p.ra, p.a[2] - az * p.ra, -ax, -ay, -az, bones, w, part, region);
  for (const ring of rings) {
    const cx = p.a[0] + (p.b[0] - p.a[0]) * ring.t + ax * ring.off;
    const cy = p.a[1] + (p.b[1] - p.a[1]) * ring.t + ay * ring.off;
    const cz = p.a[2] + (p.b[2] - p.a[2]) * ring.t + az * ring.off;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const cs = Math.cos(a) * p.sx, sn = Math.sin(a) * p.sy;
      const rx = sx * cs + ux * sn, ry = sy * cs + uy * sn, rz = sz * cs + uz * sn;
      const nr = Math.sqrt(1 - ring.nAx * ring.nAx);
      g.vert(cx + rx * ring.r, cy + ry * ring.r, cz + rz * ring.r, rx * nr + ax * ring.nAx, ry * nr + ay * ring.nAx, rz * nr + az * ring.nAx, bones, w, part, region);
    }
  }
  // Pole B
  const poleB = g.vert(p.b[0] + ax * p.rb, p.b[1] + ay * p.rb, p.b[2] + az * p.rb, ax, ay, az, bones, w, part, region);
  const idx = g.idx;
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    idx.push(start, start + 1 + s1, start + 1 + s);
    for (let r = 0; r < rings.length - 1; r++) {
      const a0 = start + 1 + r * sides + s, a1 = start + 1 + r * sides + s1;
      const b0 = a0 + sides, b1 = a1 + sides;
      idx.push(a0, a1, b1, a0, b1, b0);
    }
    const last = start + 1 + (rings.length - 1) * sides;
    idx.push(last + s, last + s1, poleB);
  }
}

function explicitEllipsoid(f: PrimFrame, seg: number, g: GeoBuilder) {
  const p = f.p;
  const bones = [p.bone, 0, 0, 0], w = [1, 0, 0, 0];
  const part = PART_VEC[p.part], region = REGION_VEC[p.region] ?? REGION_VEC[0];
  const rx = p.ra * p.sx, ry = p.ra * p.sy, rz = p.ra * p.b[0];
  const start = g.count;
  const rows = Math.max(4, Math.round(seg * 0.6));
  for (let r = 0; r <= rows; r++) {
    const th = (r / rows) * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const ph = (s / seg) * Math.PI * 2;
      const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
      const l = Math.hypot(nx / rx, ny / ry, nz / rz) || 1;
      g.vert(p.a[0] + nx * rx, p.a[1] + ny * ry, p.a[2] + nz * rz, (nx / rx) / l, (ny / ry) / l, (nz / rz) / l, bones, w, part, region);
    }
  }
  for (let r = 0; r < rows; r++)
    for (let s = 0; s < seg; s++) {
      const a = start + r * (seg + 1) + s, b = a + seg + 1;
      g.idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
}

// ------------------------------------------------------------------ membranes

function buildMembranes(body: BodyLayout, detail: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const mem: number[] = [];
  const zero = [0, 0, 0, 0], reg = [1, 0];
  for (const m of body.membranes) {
    const n = m.lead.length;
    const rows = Math.max(2, Math.round(m.rows * (detail >= 1 ? 1.5 : 1)));
    const start = g.count;
    for (let i = 0; i < n; i++) {
      for (let r = 0; r <= rows; r++) {
        const v = r / rows;
        const L = m.lead[i], T = m.trail[i];
        // Slight camber so the membrane catches light.
        const camber = Math.sin(Math.PI * v) * 0.04 * Math.hypot(T[0] - L[0], T[1] - L[1], T[2] - L[2]);
        const x = L[0] + (T[0] - L[0]) * v, y = L[1] + (T[1] - L[1]) * v + camber, z = L[2] + (T[2] - L[2]) * v;
        const bl = m.leadBone[i], bt = m.trailBone[i];
        const bones = bl === bt ? [bl, 0, 0, 0] : [bl, bt, 0, 0];
        const w = bl === bt ? [1, 0, 0, 0] : [1 - v, v, 0, 0];
        g.vert(x, y, z, 0, 1, 0, bones, w, zero, reg);
        mem.push(i / (n - 1), v, m.style);
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let r = 0; r < rows; r++) {
        const a = start + i * (rows + 1) + r, b = a + rows + 1;
        g.idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
  }
  return g.build((geo) => {
    geo.setAttribute('aMem', new THREE.Float32BufferAttribute(mem, 3));
    geo.computeVertexNormals();
  });
}

/** Shared unit eye sphere (looks down +Z). */
let eyeGeo: THREE.SphereGeometry | null = null;
export function eyeGeometry(): THREE.SphereGeometry {
  if (!eyeGeo) {
    eyeGeo = new THREE.SphereGeometry(1, 16, 12);
    eyeGeo.rotateX(Math.PI / 2); // poles on ±Z so the pupil is round around +Z
  }
  return eyeGeo;
}
