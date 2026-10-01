/**
 * Terrain collision & queries. Uses exact LOD-0 density grids streamed from the
 * chunk workers when available (includes edits), and falls back to the
 * analytic generator (+ edit store) elsewhere. Shared by client physics; the
 * server uses the same class without grids.
 */
import { CHUNK_SIZE, CHUNK_PAD, GRID_N } from './constants';
import type { WorldGenerator } from './generator';
import type { EditStore } from './edits';
import { Mat } from './materials';

interface Grid {
  density: Float32Array;
  mats: Uint8Array;
  ox: number;
  oy: number;
  oz: number;
  lastUsed: number;
}

export interface RayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  dist: number;
}

export class TerrainCollider {
  private grids = new Map<string, Grid>();
  private tick = 0;
  maxGrids = 220;

  constructor(readonly gen: WorldGenerator, readonly edits: EditStore) {}

  private key(cx: number, cy: number, cz: number) {
    return cx + ',' + cy + ',' + cz;
  }

  setGrid(ox: number, oy: number, oz: number, density: Float32Array, mats: Uint8Array) {
    const cx = Math.round(ox / CHUNK_SIZE), cy = Math.round(oy / CHUNK_SIZE), cz = Math.round(oz / CHUNK_SIZE);
    this.grids.set(this.key(cx, cy, cz), { density, mats, ox, oy, oz, lastUsed: this.tick });
    if (this.grids.size > this.maxGrids) this.evict();
  }

  hasGrid(x: number, y: number, z: number): boolean {
    return this.grids.has(this.key(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }

  /** Remove grids touched by an edit; they will be replaced by regenerated ones. Analytic fallback covers the gap. */
  invalidate(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    for (let cz = Math.floor(minZ / CHUNK_SIZE); cz <= Math.floor(maxZ / CHUNK_SIZE); cz++)
      for (let cy = Math.floor(minY / CHUNK_SIZE); cy <= Math.floor(maxY / CHUNK_SIZE); cy++)
        for (let cx = Math.floor(minX / CHUNK_SIZE); cx <= Math.floor(maxX / CHUNK_SIZE); cx++) this.grids.delete(this.key(cx, cy, cz));
  }

  private evict() {
    const arr = [...this.grids.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < arr.length - this.maxGrids * 0.8; i++) this.grids.delete(arr[i][0]);
  }

  /** Advance usage clock (call once per frame). */
  frame() {
    this.tick++;
  }

  /** Density at a point (positive = solid). */
  density(x: number, y: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const g = this.grids.get(this.key(cx, cy, cz));
    if (g) {
      g.lastUsed = this.tick;
      const fx = x - g.ox + CHUNK_PAD, fy = y - g.oy + CHUNK_PAD, fz = z - g.oz + CHUNK_PAD;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const tx = fx - ix, ty = fy - iy, tz = fz - iz;
      const N = GRID_N, NN = N * N;
      const i = ix + iy * N + iz * NN;
      const d = g.density;
      const c00 = d[i] + (d[i + 1] - d[i]) * tx;
      const c10 = d[i + N] + (d[i + N + 1] - d[i + N]) * tx;
      const c01 = d[i + NN] + (d[i + NN + 1] - d[i + NN]) * tx;
      const c11 = d[i + NN + N] + (d[i + NN + N + 1] - d[i + NN + N]) * tx;
      const c0 = c00 + (c10 - c00) * ty;
      const c1 = c01 + (c11 - c01) * ty;
      return c0 + (c1 - c0) * tz;
    }
    return this.edits.apply(this.gen.density(x, y, z), x, y, z);
  }

  /** Material at a solid point (grid-exact when loaded). */
  material(x: number, y: number, z: number): Mat {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const g = this.grids.get(this.key(cx, cy, cz));
    if (g) {
      const N = GRID_N;
      const ix = Math.round(x - g.ox + CHUNK_PAD), iy = Math.round(y - g.oy + CHUNK_PAD), iz = Math.round(z - g.oz + CHUNK_PAD);
      // Search the nearest solid sample in a small neighbourhood.
      let best = -Infinity, m = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const i = ix + dx, j = iy + dy, k = iz + dz;
            if (i < 0 || j < 0 || k < 0 || i >= N || j >= N || k >= N) continue;
            const idx = i + j * N + k * N * N;
            const dd = g.density[idx];
            if (dd > 0 && g.mats[idx] && -Math.abs(dd) - (dx * dx + dy * dy + dz * dz) * 0.3 > best) {
              best = -Math.abs(dd) - (dx * dx + dy * dy + dz * dz) * 0.3;
              m = g.mats[idx];
            }
          }
      if (m) return m as Mat;
    }
    return this.gen.materialAt(x, y, z);
  }

  /** Gradient-based outward normal (unit). */
  normal(x: number, y: number, z: number, e = 0.35): [number, number, number] {
    const gx = this.density(x - e, y, z) - this.density(x + e, y, z);
    const gy = this.density(x, y - e, z) - this.density(x, y + e, z);
    const gz = this.density(x, y, z - e) - this.density(x, y, z + e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  }

  /** Ray march against the density field. dir must be normalized. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
    let t = 0;
    let prev = this.density(ox, oy, oz);
    if (prev > 0) return { x: ox, y: oy, z: oz, nx: -dx, ny: -dy, nz: -dz, dist: 0 };
    while (t < maxDist) {
      // Cave fields are not exact distances: cap the stride so thin walls are not skipped.
      const stepLen = Math.max(0.15, Math.min(-prev * 0.7, 2));
      const nt = Math.min(maxDist, t + stepLen);
      const x = ox + dx * nt, y = oy + dy * nt, z = oz + dz * nt;
      const d = this.density(x, y, z);
      if (d > 0) {
        let lo = t, hi = nt;
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) / 2;
          if (this.density(ox + dx * m, oy + dy * m, oz + dz * m) > 0) hi = m;
          else lo = m;
        }
        const hx = ox + dx * hi, hy = oy + dy * hi, hz = oz + dz * hi;
        const [nx, ny, nz] = this.normal(hx, hy, hz);
        return { x: hx, y: hy, z: hz, nx, ny, nz, dist: hi };
      }
      if (nt >= maxDist) break;
      t = nt;
      prev = d;
    }
    return null;
  }

  /** Ground height below a point (NaN if none within maxDrop). */
  groundBelow(x: number, y: number, z: number, maxDrop = 60): number {
    const hit = this.raycast(x, y, z, 0, -1, 0, maxDrop);
    return hit ? hit.y : NaN;
  }

  /**
   * Resolve a sphere against terrain: returns push-out vector (or null).
   * Uses density as approximate signed distance.
   */
  sphereContact(x: number, y: number, z: number, r: number): { px: number; py: number; pz: number; nx: number; ny: number; nz: number; depth: number } | null {
    const d = this.density(x, y, z);
    // Quick reject: density is never smaller than ~distance/3 for our fields.
    if (-d > r * 3 + 1) return null;
    const e = 0.3;
    const gx = this.density(x - e, y, z) - this.density(x + e, y, z);
    const gy = this.density(x, y - e, z) - this.density(x, y + e, z);
    const gz = this.density(x, y, z - e) - this.density(x, y, z + e);
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-6) return null;
    // First-order signed distance estimate: density / |∇density|.
    const dist = -d / (gl / (2 * e));
    if (dist >= r) return null;
    const nx = gx / gl, ny = gy / gl, nz = gz / gl;
    const depth = r - dist;
    return { px: nx * depth, py: ny * depth, pz: nz * depth, nx, ny, nz, depth };
  }
}
