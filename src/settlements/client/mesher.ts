/**
 * Primitive mesher: turns blueprint primitives into compact, merged
 * BufferGeometry for the shared settlement material.
 *
 * Vertex format (32 B + indices): position f32×3 (relative to a tile origin),
 * normal i8×3, uv f32×2 (tile units), color u8×3 (linear), aLayer u8,
 * aEmit u8×4 (radiance / EMIT_SCALE, w = night-only), skyVis u8.
 *
 * Flat faces get planar UVs from a per-face basis in building space (u along
 * the horizontal tangent, v up the face — so roof tiles run up the slope and
 * adjacent wall boxes line up); round shapes get smooth normals and wrapped
 * UVs. Vertices inside the building's interior volume get reduced sky
 * visibility so rooms are lit by hearths and windows rather than the sky.
 * Each piece's vertex range is recorded so destroyed pieces can be collapsed
 * in place without rebuilding.
 */
import * as THREE from 'three';
import { SURF_TILE, Shape, Surf, type Blueprint, type Prim } from '../build/kit';
import { EMIT_SCALE } from './material';

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export interface PieceRange {
  start: number;
  count: number;
}

const INTERIOR_SKY = 0.32;

export class MeshBuilder {
  pos = new Float32Array(3 * 4096);
  nrm = new Int8Array(3 * 4096);
  uv = new Float32Array(2 * 4096);
  col = new Uint8Array(3 * 4096);
  layer = new Uint8Array(4096);
  emit = new Uint8Array(4 * 4096);
  sky = new Uint8Array(4096);
  idx = new Uint32Array(6 * 4096);
  nv = 0;
  ni = 0;

  // Building frame: world = Ry(yaw)·local + (tx, ty, tz).
  private cy = 1;
  private sy = 0;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private interior: Blueprint['interior'] = null;
  // Current prim matrix (building-local) M = Ry·Rx·Rz and translation.
  private m = new Float64Array(9);
  private px = 0;
  private py = 0;
  private pz = 0;
  private prim!: Prim;
  private cr = 0;
  private cg = 0;
  private cb = 0;
  private er = 0;
  private eg = 0;
  private eb = 0;
  private ew = 0;
  private tile = 1;
  private ax = 1;
  private az = 0;

  reset() {
    this.nv = 0;
    this.ni = 0;
  }

  private grow(nv: number, ni: number) {
    if (this.nv + nv > this.layer.length) {
      let cap = this.layer.length;
      while (cap < this.nv + nv) cap *= 2;
      const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, k: number): T => {
        const n = new (a.constructor as new (n: number) => T)(cap * k);
        n.set(a.subarray(0, this.nv * k));
        return n;
      };
      this.pos = g(this.pos, 3);
      this.nrm = g(this.nrm, 3);
      this.uv = g(this.uv, 2);
      this.col = g(this.col, 3);
      this.layer = g(this.layer, 1);
      this.emit = g(this.emit, 4);
      this.sky = g(this.sky, 1);
    }
    if (this.ni + ni > this.idx.length) {
      let cap = this.idx.length;
      while (cap < this.ni + ni) cap *= 2;
      const n = new Uint32Array(cap);
      n.set(this.idx.subarray(0, this.ni));
      this.idx = n;
    }
  }

  /** Set the building transform relative to the mesh origin. */
  setFrame(x: number, y: number, z: number, yaw: number, interior: Blueprint['interior']) {
    this.tx = x;
    this.ty = y;
    this.tz = z;
    this.cy = Math.cos(yaw);
    this.sy = Math.sin(yaw);
    this.interior = interior;
  }

  /** Add every primitive of a piece within the LOD window; returns its vertex range. */
  addPiece(p: Blueprint['pieces'][number], minLod: number, maxLod: number): PieceRange {
    const start = this.nv;
    for (const q of p.prims) if (q.lod >= minLod && q.lod <= maxLod) this.addPrim(q);
    return { start, count: this.nv - start };
  }

  addPrim(q: Prim) {
    this.prim = q;
    // M = Ry(ry)·Rx(rx)·Rz(rz)
    const cy = Math.cos(q.ry), sy = Math.sin(q.ry), cx = Math.cos(q.rx), sx = Math.sin(q.rx), cz = Math.cos(q.rz), sz = Math.sin(q.rz);
    const m = this.m;
    // Rows of Ry·Rx·Rz.
    m[0] = cy * cz + sy * sx * sz; m[1] = -cy * sz + sy * sx * cz; m[2] = sy * cx;
    m[3] = cx * sz; m[4] = cx * cz; m[5] = -sx;
    m[6] = -sy * cz + cy * sx * sz; m[7] = sy * sz + cy * sx * cz; m[8] = cy * cx;
    this.px = q.x;
    this.py = q.y;
    this.pz = q.z;
    this.cr = SRGB2LIN[(q.col >> 16) & 255];
    this.cg = SRGB2LIN[(q.col >> 8) & 255];
    this.cb = SRGB2LIN[q.col & 255];
    if (q.emit && q.emitI > 0) {
      const k = q.emitI / EMIT_SCALE;
      this.er = Math.min(1, SRGB2LIN[(q.emit >> 16) & 255] * k);
      this.eg = Math.min(1, SRGB2LIN[(q.emit >> 8) & 255] * k);
      this.eb = Math.min(1, SRGB2LIN[q.emit & 255] * k);
      this.ew = q.night ? 1 : 0;
    } else this.er = this.eg = this.eb = this.ew = 0;
    this.tile = 1 / (SURF_TILE[q.surf] ?? 2);
    // Prim local X axis in building space (horizontal-face UV direction).
    this.ax = m[0];
    this.az = m[6];
    if (q.shape === Shape.Frustum) this.frustum(q);
    else if (q.shape === Shape.Cyl) this.cylinder(q);
    else this.sphere(q);
  }

  // ---------------------------------------------------------------- transforms

  /** Prim-local → building-local into out[o..o+2]. */
  private toB(x: number, y: number, z: number, out: number[], o: number) {
    const m = this.m;
    out[o] = m[0] * x + m[1] * y + m[2] * z + this.px;
    out[o + 1] = m[3] * x + m[4] * y + m[5] * z + this.py;
    out[o + 2] = m[6] * x + m[7] * y + m[8] * z + this.pz;
  }

  private dirB(x: number, y: number, z: number, out: number[], o: number) {
    const m = this.m;
    out[o] = m[0] * x + m[1] * y + m[2] * z;
    out[o + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[o + 2] = m[6] * x + m[7] * y + m[8] * z;
  }

  /** Write one vertex from building-local position/normal. */
  private vert(bx: number, by: number, bz: number, nx: number, ny: number, nz: number, u: number, v: number) {
    const i = this.nv++;
    const c = this.cy, s = this.sy;
    this.pos[i * 3] = c * bx + s * bz + this.tx;
    this.pos[i * 3 + 1] = by + this.ty;
    this.pos[i * 3 + 2] = -s * bx + c * bz + this.tz;
    this.nrm[i * 3] = Math.round((c * nx + s * nz) * 127);
    this.nrm[i * 3 + 1] = Math.round(ny * 127);
    this.nrm[i * 3 + 2] = Math.round((-s * nx + c * nz) * 127);
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = v;
    this.col[i * 3] = this.cr * 255 + 0.5;
    this.col[i * 3 + 1] = this.cg * 255 + 0.5;
    this.col[i * 3 + 2] = this.cb * 255 + 0.5;
    this.layer[i] = this.prim.surf;
    this.emit[i * 4] = this.er * 255 + 0.5;
    this.emit[i * 4 + 1] = this.eg * 255 + 0.5;
    this.emit[i * 4 + 2] = this.eb * 255 + 0.5;
    this.emit[i * 4 + 3] = this.ew * 255;
    let sky = 1;
    const it = this.interior;
    if (it && by > -0.3 && by < it.h - 0.04) {
      const inside = it.round ? bx * bx + bz * bz < (it.hx - 0.02) * (it.hx - 0.02) : Math.abs(bx) < it.hx - 0.02 && Math.abs(bz) < it.hz - 0.02;
      if (inside) sky = INTERIOR_SKY;
    }
    this.sky[i] = sky * 255 + 0.5;
    // Lit windows glow outward only: the inner face of a pane shows the dark night outside.
    if (sky < 1 && this.ew > 0 && this.prim.surf === Surf.Window) this.emit[i * 4] = this.emit[i * 4 + 1] = this.emit[i * 4 + 2] = 0;
    return i;
  }

  private pts: number[] = new Array(64 * 3).fill(0);

  /** Flat polygon (building-local points in this.pts[0..n*3)) with a per-face UV basis. */
  private face(n: number) {
    const p = this.pts;
    // Newell normal.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = p[i * 3], y0 = p[i * 3 + 1], z0 = p[i * 3 + 2];
      const x1 = p[j * 3], y1 = p[j * 3 + 1], z1 = p[j * 3 + 2];
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-7) return;
    nx /= len;
    ny /= len;
    nz /= len;
    // Basis: t = horizontal tangent (Y × n), b = n × t; horizontal faces use the prim's X axis.
    let tx: number, ty: number, tz: number;
    if (Math.abs(ny) < 0.97) {
      tx = nz;
      ty = 0;
      tz = -nx;
      const l = Math.hypot(tx, tz);
      tx /= l;
      tz /= l;
    } else {
      tx = this.ax;
      ty = 0;
      tz = this.az;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
    }
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    this.grow(n, (n - 2) * 3);
    const base = this.nv;
    const k = this.tile;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      this.vert(x, y, z, nx, ny, nz, (x * tx + y * ty + z * tz) * k, (x * bx + y * by + z * bz) * k);
    }
    for (let i = 1; i < n - 1; i++) {
      this.idx[this.ni++] = base;
      this.idx[this.ni++] = base + i;
      this.idx[this.ni++] = base + i + 1;
    }
  }

  // ---------------------------------------------------------------- shapes

  private corner = new Array(24).fill(0);

  private frustum(q: Prim) {
    const w = q.a / 2, d = q.b / 2, tw = q.c / 2, td = q.d / 2, h = q.h, ox = q.e, oz = q.f;
    const c = this.corner;
    this.toB(-w, 0, -d, c, 0);
    this.toB(w, 0, -d, c, 3);
    this.toB(w, 0, d, c, 6);
    this.toB(-w, 0, d, c, 9);
    this.toB(ox - tw, h, oz - td, c, 12);
    this.toB(ox + tw, h, oz - td, c, 15);
    this.toB(ox + tw, h, oz + td, c, 18);
    this.toB(ox - tw, h, oz + td, c, 21);
    const quad = (a: number, b: number, cc: number, dd: number) => {
      const p = this.pts;
      let n = 0;
      for (const v of [a, b, cc, dd]) {
        const x = c[v * 3], y = c[v * 3 + 1], z = c[v * 3 + 2];
        if (n > 0 && Math.abs(p[(n - 1) * 3] - x) < 1e-6 && Math.abs(p[(n - 1) * 3 + 1] - y) < 1e-6 && Math.abs(p[(n - 1) * 3 + 2] - z) < 1e-6) continue;
        p[n * 3] = x;
        p[n * 3 + 1] = y;
        p[n * 3 + 2] = z;
        n++;
      }
      if (n > 2 && Math.abs(p[0] - p[(n - 1) * 3]) < 1e-6 && Math.abs(p[1] - p[(n - 1) * 3 + 1]) < 1e-6 && Math.abs(p[2] - p[(n - 1) * 3 + 2]) < 1e-6) n--;
      if (n >= 3) this.face(n);
    };
    if (w > 1e-4 && d > 1e-4) quad(0, 1, 2, 3); // bottom
    if (tw > 1e-4 && td > 1e-4) quad(7, 6, 5, 4); // top
    quad(3, 2, 6, 7); // +z
    quad(1, 0, 4, 5); // −z
    quad(2, 1, 5, 6); // +x
    quad(0, 3, 7, 4); // −x
  }

  private cylinder(q: Prim) {
    const seg = Math.max(3, q.seg | 0);
    const r0 = q.a, r1 = q.b, h = q.h, sx = q.e || 1, sz = q.f || 1;
    const smooth = seg >= 8 || q.smooth;
    const p = this.pts;
    const k = this.tile;
    if (smooth) {
      const slope = (r0 - r1) / (h || 1e-4);
      this.grow((seg + 1) * 2, seg * 6);
      const base = this.nv;
      const tmp = [0, 0, 0, 0, 0, 0];
      const ravg = (r0 + r1) / 2;
      for (let i = 0; i <= seg; i++) {
        const th = ((i + 0.5) / seg) * Math.PI * 2;
        const s = Math.sin(th), c = Math.cos(th);
        let nx = s / sx, ny = slope, nz = c / sz;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        this.dirB(nx, ny, nz, tmp, 3);
        const u = th * ravg * k;
        this.toB(s * r0 * sx, 0, c * r0 * sz, tmp, 0);
        this.vert(tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5], u, 0);
        this.toB(s * r1 * sx, h, c * r1 * sz, tmp, 0);
        this.vert(tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5], u, Math.hypot(h, r0 - r1) * k);
      }
      for (let i = 0; i < seg; i++) {
        const a = base + i * 2, b = a + 2;
        this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = b + 1;
        if (r1 > 1e-4) {
          this.idx[this.ni++] = a; this.idx[this.ni++] = b + 1; this.idx[this.ni++] = a + 1;
        }
      }
    } else {
      for (let i = 0; i < seg; i++) {
        const t0 = ((i + 0.5) / seg) * Math.PI * 2, t1 = ((i + 1.5) / seg) * Math.PI * 2;
        let n = 0;
        this.toB(Math.sin(t0) * r0 * sx, 0, Math.cos(t0) * r0 * sz, p, n++ * 3);
        this.toB(Math.sin(t1) * r0 * sx, 0, Math.cos(t1) * r0 * sz, p, n++ * 3);
        if (r1 > 1e-4) {
          this.toB(Math.sin(t1) * r1 * sx, h, Math.cos(t1) * r1 * sz, p, n++ * 3);
          this.toB(Math.sin(t0) * r1 * sx, h, Math.cos(t0) * r1 * sz, p, n++ * 3);
        } else this.toB(0, h, 0, p, n++ * 3);
        // Increasing angle runs left→right seen from outside: already counter-clockwise.
        this.face(n);
      }
    }
    // Caps.
    if (r0 > 1e-4) {
      for (let i = 0; i < seg; i++) {
        const t = ((seg - i - 0.5) / seg) * Math.PI * 2;
        this.toB(Math.sin(t) * r0 * sx, 0, Math.cos(t) * r0 * sz, p, i * 3);
      }
      this.face(seg);
    }
    if (r1 > 1e-4) {
      for (let i = 0; i < seg; i++) {
        const t = ((i + 0.5) / seg) * Math.PI * 2;
        this.toB(Math.sin(t) * r1 * sx, h, Math.cos(t) * r1 * sz, p, i * 3);
      }
      this.face(seg);
    }
  }

  private reverse(n: number) {
    const p = this.pts;
    for (let i = 0; i < n / 2; i++) {
      const j = n - 1 - i;
      for (let k = 0; k < 3; k++) {
        const t = p[i * 3 + k];
        p[i * 3 + k] = p[j * 3 + k];
        p[j * 3 + k] = t;
      }
    }
  }

  private sphere(q: Prim) {
    const a = q.a, b = q.b, h = q.h;
    const lat0 = q.e, lat1 = q.f;
    const seg = Math.max(4, q.seg | 0);
    const rings = Math.max(2, Math.round((seg / 2) * ((lat1 - lat0) / Math.PI)) + 1);
    const k = this.tile;
    this.grow((rings + 1) * (seg + 1), rings * seg * 6);
    const base = this.nv;
    const tmp = [0, 0, 0, 0, 0, 0];
    const ravg = (a + b) / 2;
    for (let j = 0; j <= rings; j++) {
      const lat = lat0 + ((lat1 - lat0) * j) / rings;
      const sl = Math.sin(lat), cl = Math.cos(lat);
      for (let i = 0; i <= seg; i++) {
        const lon = (i / seg) * Math.PI * 2;
        const x = sl * Math.sin(lon) * a, y = cl * h, z = sl * Math.cos(lon) * b;
        let nx = x / (a * a), ny = y / (h * h), nz = z / (b * b);
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        this.toB(x, y, z, tmp, 0);
        this.dirB(nx, ny, nz, tmp, 3);
        this.vert(tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5], lon * ravg * k, -lat * h * k);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < seg; i++) {
        const v0 = base + j * (seg + 1) + i, v1 = v0 + 1, v2 = v0 + seg + 1, v3 = v2 + 1;
        this.idx[this.ni++] = v0; this.idx[this.ni++] = v2; this.idx[this.ni++] = v1;
        this.idx[this.ni++] = v1; this.idx[this.ni++] = v2; this.idx[this.ni++] = v3;
      }
    const p = this.pts;
    const nseg = Math.min(seg, 60);
    if (lat1 < Math.PI - 0.01) {
      const sl = Math.sin(lat1), y = Math.cos(lat1) * h;
      for (let i = 0; i < nseg; i++) {
        const lon = ((nseg - i) / nseg) * Math.PI * 2;
        this.toB(sl * Math.sin(lon) * a, y, sl * Math.cos(lon) * b, p, i * 3);
      }
      this.face(nseg);
    }
    if (lat0 > 0.01) {
      const sl = Math.sin(lat0), y = Math.cos(lat0) * h;
      for (let i = 0; i < nseg; i++) {
        const lon = (i / nseg) * Math.PI * 2;
        this.toB(sl * Math.sin(lon) * a, y, sl * Math.cos(lon) * b, p, i * 3);
      }
      this.face(nseg);
    }
  }

  // ---------------------------------------------------------------- ground-hugging surfaces

  /** Set flat colour/surface state for ground helpers. */
  private groundState(surf: number, col: number) {
    this.prim = { surf } as Prim;
    this.cr = SRGB2LIN[(col >> 16) & 255];
    this.cg = SRGB2LIN[(col >> 8) & 255];
    this.cb = SRGB2LIN[col & 255];
    this.er = this.eg = this.eb = this.ew = 0;
    this.tile = 1 / (SURF_TILE[surf] ?? 2);
    this.interior = null;
    this.cy = 1;
    this.sy = 0;
  }

  /**
   * Street ribbon along a world polyline, hugging the terrain (heights from
   * `h`, lifted by `lift`). Positions are relative to (ox, oy, oz).
   */
  ribbon(pts: [number, number][], width: number, surf: number, col: number, h: (x: number, z: number) => number, ox: number, oy: number, oz: number, lift = 0.07) {
    if (pts.length < 2) return;
    this.groundState(surf, col);
    this.tx = -ox;
    this.ty = -oy;
    this.tz = -oz;
    // Resample to ~2 m steps.
    const rs: [number, number][] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / 2));
      for (let k = 1; k <= n; k++) rs.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    const k = this.tile;
    const hw = width / 2;
    this.grow(rs.length * 3, rs.length * 12);
    const base = this.nv;
    let along = 0;
    for (let i = 0; i < rs.length; i++) {
      const [x, z] = rs[i];
      const [px, pz] = rs[Math.max(0, i - 1)], [nx, nz] = rs[Math.min(rs.length - 1, i + 1)];
      let tx = nx - px, tz = nz - pz;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      if (i > 0) along += Math.hypot(x - rs[i - 1][0], z - rs[i - 1][1]);
      // Three columns: left edge, centre, right edge (crown slightly raised).
      for (let c = -1; c <= 1; c++) {
        const vx = x - tz * hw * c, vz = z + tx * hw * c;
        const y = h(vx, vz) + lift + (c === 0 ? 0.03 : 0);
        this.vert(vx, y, vz, 0, 1, 0, c * hw * k, along * k);
      }
    }
    for (let i = 0; i < rs.length - 1; i++) {
      const a0 = base + i * 3, b0 = a0 + 3;
      for (let c = 0; c < 2; c++) {
        this.idx[this.ni++] = a0 + c; this.idx[this.ni++] = a0 + c + 1; this.idx[this.ni++] = b0 + c;
        this.idx[this.ni++] = a0 + c + 1; this.idx[this.ni++] = b0 + c + 1; this.idx[this.ni++] = b0 + c;
      }
    }
  }

  /** Terrain-hugging rectangle (fields, plaza) or disc (round = true) centred at (cx, cz). */
  patch(cx: number, cz: number, yaw: number, w: number, d: number, surf: number, col: number, h: (x: number, z: number) => number, ox: number, oy: number, oz: number, round = false, lift = 0.06) {
    this.groundState(surf, col);
    this.tx = -ox;
    this.ty = -oy;
    this.tz = -oz;
    const k = this.tile;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    if (round) {
      const R = w / 2;
      const rings = Math.max(2, Math.ceil(R / 2.5)), seg = Math.max(16, Math.ceil(R * 2));
      this.grow(1 + rings * seg, rings * seg * 6);
      const base = this.nv;
      this.vert(cx, h(cx, cz) + lift, cz, 0, 1, 0, cx * k, cz * k);
      for (let j = 1; j <= rings; j++)
        for (let i = 0; i < seg; i++) {
          const a = (i / seg) * Math.PI * 2, r = (R * j) / rings;
          const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
          this.vert(x, h(x, z) + lift, z, 0, 1, 0, x * k, z * k);
        }
      for (let i = 0; i < seg; i++) {
        this.idx[this.ni++] = base; this.idx[this.ni++] = base + 1 + ((i + 1) % seg); this.idx[this.ni++] = base + 1 + i;
      }
      for (let j = 1; j < rings; j++)
        for (let i = 0; i < seg; i++) {
          const a0 = base + 1 + (j - 1) * seg + i, a1 = base + 1 + (j - 1) * seg + ((i + 1) % seg);
          const b0 = a0 + seg, b1 = a1 + seg;
          this.idx[this.ni++] = a0; this.idx[this.ni++] = a1; this.idx[this.ni++] = b0;
          this.idx[this.ni++] = a1; this.idx[this.ni++] = b1; this.idx[this.ni++] = b0;
        }
      return;
    }
    const nx = Math.max(1, Math.ceil(w / 2.5)), nz = Math.max(1, Math.ceil(d / 2.5));
    this.grow((nx + 1) * (nz + 1), nx * nz * 6);
    const base = this.nv;
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= nx; i++) {
        const lx = -w / 2 + (w * i) / nx, lz = -d / 2 + (d * j) / nz;
        const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
        this.vert(x, h(x, z) + lift, z, 0, 1, 0, lx * k, lz * k);
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const a0 = base + j * (nx + 1) + i, a1 = a0 + 1, b0 = a0 + nx + 1, b1 = b0 + 1;
        this.idx[this.ni++] = a0; this.idx[this.ni++] = b0; this.idx[this.ni++] = a1;
        this.idx[this.ni++] = a1; this.idx[this.ni++] = b0; this.idx[this.ni++] = b1;
      }
  }

  // ---------------------------------------------------------------- output

  /** Build a BufferGeometry from the accumulated data (copies; the builder can be reused). */
  build(): THREE.BufferGeometry | null {
    if (!this.nv) return null;
    const g = new THREE.BufferGeometry();
    const n = this.nv;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, n * 3), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    g.setAttribute('aLayer', new THREE.BufferAttribute(this.layer.slice(0, n), 1, false));
    g.setAttribute('aEmit', new THREE.BufferAttribute(this.emit.slice(0, n * 4), 4, true));
    g.setAttribute('skyVis', new THREE.BufferAttribute(this.sky.slice(0, n), 1, true));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? this.idx.slice(0, this.ni) : new Uint16Array(this.idx.subarray(0, this.ni)), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Collapse a vertex range to a point (hides the triangles without rebuilding). */
export function collapseRange(g: THREE.BufferGeometry, r: PieceRange) {
  if (r.count <= 0) return;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  const x = a[r.start * 3], y = a[r.start * 3 + 1], z = a[r.start * 3 + 2];
  for (let i = r.start; i < r.start + r.count; i++) {
    a[i * 3] = x;
    a[i * 3 + 1] = y;
    a[i * 3 + 2] = z;
  }
  pos.addUpdateRange(r.start * 3, r.count * 3);
  pos.needsUpdate = true;
}

/** Restore a collapsed range from a saved copy of the original positions. */
export function restoreRange(g: THREE.BufferGeometry, r: PieceRange, original: Float32Array) {
  if (r.count <= 0) return;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  (pos.array as Float32Array).set(original.subarray(r.start * 3, (r.start + r.count) * 3), r.start * 3);
  pos.addUpdateRange(r.start * 3, r.count * 3);
  pos.needsUpdate = true;
}

/** Darken a range (damaged pieces). */
export function tintRange(g: THREE.BufferGeometry, r: PieceRange, k: number) {
  if (r.count <= 0) return;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const a = col.array as Uint8Array;
  for (let i = r.start * 3; i < (r.start + r.count) * 3; i++) a[i] = Math.min(255, a[i] * k);
  col.addUpdateRange(r.start * 3, r.count * 3);
  col.needsUpdate = true;
}
