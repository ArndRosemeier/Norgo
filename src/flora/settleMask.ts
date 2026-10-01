/**
 * Settlement / POI exclusion mask for flora scatter.
 *
 * Streets, plazas, building footprints, crop fields and POI structures come
 * from the deterministic settlement layouts (src/settlements/cache.ts), which
 * are pure functions of the seed — so the chunk workers and the server derive
 * the very same mask and object ids stay identical everywhere.
 *
 * Per chunk the relevant primitives are gathered once; candidate tests are then
 * a handful of distance checks.
 */
import type { WorldGenerator } from '../world/generator';
import { SettlementCache, worldFromGenerator } from '../settlements/cache';
import type { BuildingInfo } from '../settlements/types';

/** Result of a mask test. */
export const enum MaskHit {
  Free = 0,
  /** Crop field / garden: no wild plants. */
  Field = 1,
  /** Street, plaza, building or structure footprint. */
  Hard = 2,
}

export class ChunkMask {
  /** Street segments: ax, az, bx, bz, halfWidth. */
  segs: number[] = [];
  /** Oriented rectangles: cx, cz, cos, sin, hx, hz, kind (1 field, 2 hard). */
  rects: number[] = [];
  /** Circles: x, z, r. */
  circles: number[] = [];

  get empty() {
    return !this.segs.length && !this.rects.length && !this.circles.length;
  }

  /** Test a point with an extra clearance margin (m). */
  test(x: number, z: number, margin: number): MaskHit {
    const c = this.circles;
    for (let i = 0; i < c.length; i += 3) {
      const dx = x - c[i], dz = z - c[i + 1], r = c[i + 2] + margin;
      if (dx * dx + dz * dz < r * r) return MaskHit.Hard;
    }
    const s = this.segs;
    for (let i = 0; i < s.length; i += 5) {
      const ax = s[i], az = s[i + 1], bx = s[i + 2], bz = s[i + 3], hw = s[i + 4] + margin;
      const vx = bx - ax, vz = bz - az;
      const l2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + vx * t), dz = z - (az + vz * t);
      if (dx * dx + dz * dz < hw * hw) return MaskHit.Hard;
    }
    const r = this.rects;
    let hit = MaskHit.Free;
    for (let i = 0; i < r.length; i += 7) {
      const dx = x - r[i], dz = z - r[i + 1];
      const lx = dx * r[i + 2] + dz * r[i + 3], lz = -dx * r[i + 3] + dz * r[i + 2];
      if (Math.abs(lx) < r[i + 4] + margin && Math.abs(lz) < r[i + 5] + margin) {
        if (r[i + 6] === 2) return MaskHit.Hard;
        hit = MaskHit.Field;
      }
    }
    return hit;
  }
}

const masks = new WeakMap<WorldGenerator, SettleMask>();

export class SettleMask {
  private cache: SettlementCache;

  constructor(private gen: WorldGenerator) {
    this.cache = new SettlementCache(worldFromGenerator(gen));
  }

  static of(gen: WorldGenerator): SettleMask {
    let m = masks.get(gen);
    if (!m) masks.set(gen, (m = new SettleMask(gen)));
    return m;
  }

  private addBuilding(m: ChunkMask, b: BuildingInfo, kind: number) {
    // Footprint rect (rotated by yaw; size x = width, z = depth).
    m.rects.push(b.pos[0], b.pos[2], Math.cos(b.yaw), -Math.sin(b.yaw), b.size[0] / 2 + 0.5, b.size[2] / 2 + 0.5, kind);
  }

  /** Mask primitives overlapping the XZ rectangle [x0,x1]×[z0,z1] (plus a margin). Null when nothing is near. */
  forArea(x0: number, z0: number, x1: number, z1: number): ChunkMask | null {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const half = Math.hypot(x1 - x0, z1 - z0) / 2;
    const sites = this.gen.sites.sitesNear(cx, cz, half + 160);
    const pois = this.gen.sites.poisNear(cx, cz, half + 80);
    if (!sites.length && !pois.length) return null;
    const m = new ChunkMask();
    const pad = 6;
    const inArea = (x: number, z: number, r: number) => x + r > x0 - pad && x - r < x1 + pad && z + r > z0 - pad && z - r < z1 + pad;
    for (const s of sites) {
      const reach = s.radius * 2.6;
      if (!inArea(s.x, s.z, reach)) continue;
      const l = this.cache.layout(s);
      if (l.plazaRadius && inArea(l.plaza[0], l.plaza[2], l.plazaRadius)) m.circles.push(l.plaza[0], l.plaza[2], l.plazaRadius);
      for (const st of l.streets) {
        const p = st.points;
        for (let i = 0; i + 1 < p.length; i++) {
          const ax = p[i][0], az = p[i][2], bx = p[i + 1][0], bz = p[i + 1][2];
          const r = Math.hypot(bx - ax, bz - az) / 2 + st.width;
          if (!inArea((ax + bx) / 2, (az + bz) / 2, r)) continue;
          m.segs.push(ax, az, bx, bz, st.width / 2);
        }
      }
      for (const b of l.buildings) if (inArea(b.pos[0], b.pos[2], Math.hypot(b.size[0], b.size[2]) / 2 + 1)) this.addBuilding(m, b, 2);
      for (const f of l.fields ?? []) {
        if (!inArea(f.pos[0], f.pos[2], Math.hypot(f.w, f.d) / 2)) continue;
        m.rects.push(f.pos[0], f.pos[2], Math.cos(f.yaw), -Math.sin(f.yaw), f.w / 2, f.d / 2, 1);
      }
    }
    for (const p of pois) {
      if (!inArea(p.x, p.z, p.radius * 2)) continue;
      const l = this.cache.poi(p);
      const b = l.structure;
      if (inArea(b.pos[0], b.pos[2], Math.hypot(b.size[0], b.size[2]) / 2 + 1)) this.addBuilding(m, b, 2);
    }
    return m.empty ? null : m;
  }
}
