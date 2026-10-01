/** Spatial hash of static world colliders (trees, rocks, walls, furniture) with raycasts. */
import type { StaticCollider, StaticColliders } from './context';
import type { Vec3 } from '../shared/types';

const CELL = 8;

function bounds(c: StaticCollider): [number, number, number, number, number, number] {
  const [x, y, z] = c.pos;
  if (c.shape === 'sphere') {
    const r = c.radius ?? 0.5;
    return [x - r, y - r, z - r, x + r, y + r, z + r];
  }
  if (c.shape === 'capsule') {
    const r = c.radius ?? 0.5;
    return [x - r, y - r, z - r, x + r, y + (c.height ?? 2) + r, z + r];
  }
  const h = c.half ?? [0.5, 0.5, 0.5];
  // Conservative bounds for rotated boxes.
  const ext = Math.hypot(h[0], h[2]);
  return [x - ext, y - h[1], z - ext, x + ext, y + h[1], z + ext];
}

export class StaticColliderStore implements StaticColliders {
  private cells = new Map<number, StaticCollider[]>();
  private byId = new Map<string, { c: StaticCollider; keys: number[] }>();
  private byOwner = new Map<string, Set<string>>();
  private stamp = 0;
  private marks = new WeakMap<StaticCollider, number>();

  private key(cx: number, cz: number) {
    return ((cx & 0xffff) << 16) | (cz & 0xffff);
  }

  add(c: StaticCollider): void {
    if (this.byId.has(c.id)) this.remove(c.id);
    const b = bounds(c);
    const keys: number[] = [];
    for (let cz = Math.floor(b[2] / CELL); cz <= Math.floor(b[5] / CELL); cz++)
      for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[3] / CELL); cx++) {
        const k = this.key(cx, cz);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(c);
        keys.push(k);
      }
    this.byId.set(c.id, { c, keys });
    let s = this.byOwner.get(c.owner);
    if (!s) this.byOwner.set(c.owner, (s = new Set()));
    s.add(c.id);
  }

  remove(id: string): void {
    const e = this.byId.get(id);
    if (!e) return;
    for (const k of e.keys) {
      const l = this.cells.get(k);
      if (!l) continue;
      const i = l.indexOf(e.c);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) this.cells.delete(k);
    }
    this.byId.delete(id);
    this.byOwner.get(e.c.owner)?.delete(id);
  }

  removeOwner(owner: string): void {
    const s = this.byOwner.get(owner);
    if (!s) return;
    for (const id of [...s]) this.remove(id);
    this.byOwner.delete(owner);
  }

  get(id: string): StaticCollider | undefined {
    return this.byId.get(id)?.c;
  }

  get size() {
    return this.byId.size;
  }

  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: StaticCollider[] = []): StaticCollider[] {
    const stamp = ++this.stamp;
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++)
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        const l = this.cells.get(this.key(cx, cz));
        if (!l) continue;
        for (const c of l) {
          if (this.marks.get(c) === stamp) continue;
          this.marks.set(c, stamp);
          const b = bounds(c);
          if (b[3] < minX || b[0] > maxX || b[4] < minY || b[1] > maxY || b[5] < minZ || b[2] > maxZ) continue;
          out.push(c);
        }
      }
    return out;
  }

  raycast(o: Vec3, d: Vec3, maxDist: number, filter?: (c: StaticCollider) => boolean) {
    const ex = [o[0] + d[0] * maxDist, o[1] + d[1] * maxDist, o[2] + d[2] * maxDist];
    const cands = this.query(Math.min(o[0], ex[0]), Math.min(o[1], ex[1]), Math.min(o[2], ex[2]), Math.max(o[0], ex[0]), Math.max(o[1], ex[1]), Math.max(o[2], ex[2]));
    let best: { collider: StaticCollider; dist: number; point: Vec3; normal: Vec3 } | null = null;
    for (const c of cands) {
      if (filter && !filter(c)) continue;
      const hit = rayCollider(o, d, c);
      if (hit && hit[0] <= maxDist && (!best || hit[0] < best.dist)) {
        best = { collider: c, dist: hit[0], point: [o[0] + d[0] * hit[0], o[1] + d[1] * hit[0], o[2] + d[2] * hit[0]], normal: hit[1] };
      }
    }
    return best;
  }
}

/** Ray vs collider → [t, normal] or null. */
export function rayCollider(o: Vec3, d: Vec3, c: StaticCollider): [number, Vec3] | null {
  if (c.shape === 'sphere') return raySphere(o, d, c.pos, c.radius ?? 0.5);
  if (c.shape === 'capsule') {
    const r = c.radius ?? 0.5, h = c.height ?? 2;
    // Infinite vertical cylinder test, then clamp to caps.
    const ox = o[0] - c.pos[0], oz = o[2] - c.pos[2];
    const a = d[0] * d[0] + d[2] * d[2];
    let best: [number, Vec3] | null = null;
    if (a > 1e-9) {
      const b = ox * d[0] + oz * d[2];
      const cc = ox * ox + oz * oz - r * r;
      const disc = b * b - a * cc;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        const y = o[1] + d[1] * t;
        if (t >= 0 && y >= c.pos[1] && y <= c.pos[1] + h) {
          const nx = (ox + d[0] * t) / r, nz = (oz + d[2] * t) / r;
          best = [t, [nx, 0, nz]];
        }
      }
    }
    for (const cy of [c.pos[1], c.pos[1] + h]) {
      const s = raySphere(o, d, [c.pos[0], cy, c.pos[2]], r);
      if (s && (!best || s[0] < best[0])) best = s;
    }
    return best;
  }
  // Oriented box (yaw only): transform ray into box space.
  const h = c.half ?? [0.5, 0.5, 0.5];
  const yaw = c.yaw ?? 0;
  // three.js rotation.y convention: world = R(yaw) * local.
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const px = o[0] - c.pos[0], py = o[1] - c.pos[1], pz = o[2] - c.pos[2];
  const lo: Vec3 = [px * cs - pz * sn, py, px * sn + pz * cs];
  const ld: Vec3 = [d[0] * cs - d[2] * sn, d[1], d[0] * sn + d[2] * cs];
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-9) {
      if (lo[i] < -h[i] || lo[i] > h[i]) return null;
      continue;
    }
    let t1 = (-h[i] - lo[i]) / ld[i], t2 = (h[i] - lo[i]) / ld[i];
    let s = -1;
    if (t1 > t2) {
      const tt = t1; t1 = t2; t2 = tt;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = Math.max(0, tmin);
  const ln: Vec3 = [0, 0, 0];
  ln[axis] = sign;
  return [t, [ln[0] * cs + ln[2] * sn, ln[1], -ln[0] * sn + ln[2] * cs]];
}

function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): [number, Vec3] | null {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  return [t, [(ox + d[0] * t) / r, (oy + d[1] * t) / r, (oz + d[2] * t) / r]];
}

/**
 * Push a vertical capsule (feet at p, height h, radius r) out of a collider.
 * Returns push vector or null.
 */
export function capsulePushOut(px: number, py: number, pz: number, r: number, h: number, c: StaticCollider): [number, number, number] | null {
  if (!c.solid) return null;
  if (c.shape === 'capsule' || c.shape === 'sphere') {
    const cr = c.radius ?? 0.5;
    const cy0 = c.shape === 'sphere' ? c.pos[1] : c.pos[1];
    const cy1 = c.shape === 'sphere' ? c.pos[1] : c.pos[1] + (c.height ?? 2);
    // Closest points between two vertical segments → vertical overlap test.
    const a0 = py + r, a1 = py + h - r;
    const ov0 = Math.max(a0, cy0), ov1 = Math.min(a1, cy1);
    let dy = 0;
    if (ov0 > ov1) dy = a0 > cy1 ? a0 - cy1 : a1 - cy0; // separated vertically: dy signed gap
    const dx = px - c.pos[0], dz = pz - c.pos[2];
    const horiz = Math.hypot(dx, dz);
    const dist = Math.hypot(horiz, ov0 > ov1 ? dy : 0);
    const min = r + cr;
    if (dist >= min) return null;
    const pen = min - dist;
    if (ov0 <= ov1 || Math.abs(dy) < 1e-4) {
      if (horiz < 1e-5) return [pen, 0, 0];
      return [(dx / horiz) * pen, 0, (dz / horiz) * pen];
    }
    // Standing on top / hitting from below.
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    return [nx * pen, ny * pen, nz * pen];
  }
  // Box (yaw): treat capsule as vertical segment; resolve in box local XZ, Y separately.
  const half = c.half ?? [0.5, 0.5, 0.5];
  const yaw = c.yaw ?? 0;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const lx0 = px - c.pos[0], lz0 = pz - c.pos[2];
  const lx = lx0 * cs - lz0 * sn, lz = lx0 * sn + lz0 * cs;
  const boxBot = c.pos[1] - half[1], boxTop = c.pos[1] + half[1];
  // Standing on (or a hair above) the top is not an overlap: after a step-up the feet sit exactly
  // at boxTop, and treating that as inside pushed the player back off the step every frame.
  if (py + h < boxBot || py >= boxTop - 0.002) return null;
  const qx = Math.max(-half[0], Math.min(half[0], lx));
  const qz = Math.max(-half[2], Math.min(half[2], lz));
  let ddx = lx - qx, ddz = lz - qz;
  let d2 = ddx * ddx + ddz * ddz;
  let pushX = 0, pushZ = 0, pushY = 0;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    if (d >= r) return null;
    pushX = (ddx / d) * (r - d);
    pushZ = (ddz / d) * (r - d);
  } else {
    // Centre inside the box footprint: choose the cheapest way out (incl. stepping on top).
    const outs = [half[0] - lx + r, lx + half[0] + r, half[2] - lz + r, lz + half[2] + r];
    const up = boxTop - py;
    let m = Math.min(...outs);
    if (up < 0.45 && up < m) {
      pushY = up;
      m = -1;
    } else if (m === outs[0]) pushX = outs[0];
    else if (m === outs[1]) pushX = -outs[1];
    else if (m === outs[2]) pushZ = outs[2];
    else pushZ = -outs[3];
  }
  // Allow stepping onto low boxes (steps, low walls).
  const stepUp = boxTop - py;
  if (pushY === 0 && stepUp > 0 && stepUp < 0.42) return [0, stepUp, 0];
  return [pushX * cs + pushZ * sn, pushY, -pushX * sn + pushZ * cs];
}
