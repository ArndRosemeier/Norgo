/**
 * Server-side NPC locomotion: waypoint following with steering, separation
 * from nearby people, building-footprint avoidance (NPCs only enter the
 * building they start in or are heading to, through its door), terrain
 * following with gravity, and facing/yaw smoothing. Allocation-light: runs
 * every tick for NPCs near players and at reduced rate further away.
 */
import type { Vec3 } from '../../shared/types';
import type { ServerContext } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { BuildingInfo } from '../../settlements/types';
import { insideFootprint } from '../layout';

export interface Body {
  path: Vec3[];
  idx: number;
  run: boolean;
  /** Buildings the NPC may walk inside (start + destination). */
  exempt: string[];
  vy: number;
  /** Seconds without progress. */
  stuck: number;
  lastDist: number;
  /** Last ground probe. */
  gx: number;
  gz: number;
  gy: number;
  /** Detour side preference (+1/-1) to avoid oscillation. */
  side: number;
}

export function newBody(): Body {
  return { path: [], idx: 0, run: false, exempt: [], vy: 0, stuck: 0, lastDist: Infinity, gx: NaN, gz: NaN, gy: NaN, side: 1 };
}

export interface BodyEnv {
  ctx: ServerContext;
  buildings: BuildingInfo[];
  /** Cached ground query. */
  ground(x: number, y: number, z: number): number;
}

/** Yaw that faces from (x,z) towards (tx,tz). Yaw 0 faces −Z. */
export function yawTo(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - x), -(tz - z));
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function turnToward(e: ServerEntity, yaw: number, rate: number) {
  const d = wrapAngle(yaw - e.yaw);
  const step = Math.sign(d) * Math.min(Math.abs(d), rate);
  if (Math.abs(step) > 1e-4) {
    e.yaw = wrapAngle(e.yaw + step);
    e.dirty = true;
  }
}

function blocked(env: BodyEnv, b: Body, x: number, z: number): boolean {
  for (const bd of env.buildings) {
    if (b.exempt.length && b.exempt.includes(bd.id)) continue;
    // Tiny props (wells) do not block; footprints shrink a little so streets stay walkable.
    if (bd.size[0] < 2.5 && bd.size[1] < 2.5) continue;
    if (insideFootprint(bd, x, z, -0.15)) return true;
  }
  return false;
}

/** Buildings containing a point (used to compute exemptions). */
export function buildingAt(buildings: BuildingInfo[], x: number, z: number): BuildingInfo | null {
  for (const bd of buildings) if (insideFootprint(bd, x, z, 0.3)) return bd;
  return null;
}

const DETOUR = [0.6, -0.6, 1.2, -1.2, 1.8, -1.8];

/**
 * Advance along the path. Returns true when the final waypoint is reached.
 * `speed` in m/s; `others` are nearby entities for separation.
 */
export function stepBody(e: ServerEntity, b: Body, env: BodyEnv, dt: number, speed: number, others: ServerEntity[] | null): boolean {
  const ctx = env.ctx;
  if (b.idx >= b.path.length) {
    settle(e, b, env, dt);
    return true;
  }
  const tgt = b.path[b.idx];
  let dx = tgt[0] - e.pos[0], dz = tgt[2] - e.pos[2];
  const dist = Math.hypot(dx, dz);
  const last = b.idx === b.path.length - 1;
  if (dist < (last ? 0.25 : 0.9)) {
    b.idx++;
    b.stuck = 0;
    b.lastDist = Infinity;
    if (b.idx >= b.path.length) {
      e.vel = [0, 0, 0];
      return true;
    }
    return false;
  }
  dx /= dist;
  dz /= dist;
  // Separation: gently push away from people closer than ~0.9 m.
  if (others) {
    for (const o of others) {
      if (o === e || !o.alive) continue;
      const ox = e.pos[0] - o.pos[0], oz = e.pos[2] - o.pos[2];
      const d2 = ox * ox + oz * oz;
      if (d2 > 0.0001 && d2 < 0.8) {
        const d = Math.sqrt(d2);
        const w = (0.9 - d) * 1.4;
        dx += (ox / d) * w;
        dz += (oz / d) * w;
      }
    }
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
  }
  const step = Math.min(dist, speed * dt);
  let nx = e.pos[0] + dx * step, nz = e.pos[2] + dz * step;
  if (blocked(env, b, nx, nz)) {
    // Try detours, preferring the side that worked last time.
    let ok = false;
    for (const a0 of DETOUR) {
      const a = a0 * b.side;
      const c = Math.cos(a), s = Math.sin(a);
      const rx = dx * c - dz * s, rz = dx * s + dz * c;
      const tx = e.pos[0] + rx * step, tz = e.pos[2] + rz * step;
      if (!blocked(env, b, tx, tz)) {
        nx = tx;
        nz = tz;
        dx = rx;
        dz = rz;
        ok = true;
        if (a0 < 0) b.side = -b.side;
        break;
      }
    }
    if (!ok) {
      nx = e.pos[0];
      nz = e.pos[2];
    }
  }
  // Progress watchdog: hop to the next waypoint when hopelessly stuck.
  if (dist < b.lastDist - 0.05) {
    b.lastDist = dist;
    b.stuck = 0;
  } else {
    b.stuck += dt;
    if (b.stuck > 4) {
      b.stuck = 0;
      b.lastDist = Infinity;
      nx = tgt[0];
      nz = tgt[2];
      b.idx++;
    }
  }
  const vx = (nx - e.pos[0]) / Math.max(dt, 1e-3), vz = (nz - e.pos[2]) / Math.max(dt, 1e-3);
  e.pos[0] = nx;
  e.pos[2] = nz;
  // Ground & gravity. Inside the destination/start building use the spot height (floors).
  const inside = b.exempt.length ? buildingAt(env.buildings, nx, nz) : null;
  let gy: number;
  if (inside && b.exempt.includes(inside.id)) gy = last ? tgt[1] : Math.max(inside.pos[1], groundCached(b, env, nx, e.pos[1], nz));
  else gy = groundCached(b, env, nx, e.pos[1], nz);
  applyVertical(e, b, gy, ctx.gravityAt(e.pos), dt);
  e.vel = [vx, b.vy, vz];
  turnToward(e, yawTo(0, 0, dx, dz), 8 * dt);
  ctx.entities.reindex(e);
  e.dirty = true;
  return false;
}

function groundCached(b: Body, env: BodyEnv, x: number, y: number, z: number): number {
  if (Math.abs(x - b.gx) < 0.6 && Math.abs(z - b.gz) < 0.6 && Number.isFinite(b.gy)) return b.gy;
  const g = env.ground(x, y, z);
  b.gx = x;
  b.gz = z;
  b.gy = Number.isFinite(g) ? g : y;
  return b.gy;
}

function applyVertical(e: ServerEntity, b: Body, gy: number, g: number, dt: number) {
  const y = e.pos[1];
  if (y > gy + 0.6 || b.vy > 0) {
    // Falling (ledges, knockback): integrate local gravity.
    b.vy -= g * dt;
    e.pos[1] = Math.max(gy, y + b.vy * dt);
    e.grounded = e.pos[1] <= gy + 0.01;
    if (e.grounded) b.vy = 0;
  } else {
    // Walking: follow the terrain smoothly (steps, slopes).
    e.pos[1] = gy + (y - gy) * 0.4;
    if (Math.abs(e.pos[1] - gy) < 0.02) e.pos[1] = gy;
    b.vy = 0;
    e.grounded = true;
  }
}

/** Idle physics: keep standing on the ground (terrain edits under feet, knockbacks). */
export function settle(e: ServerEntity, b: Body, env: BodyEnv, dt: number) {
  const inside = b.exempt.length ? buildingAt(env.buildings, e.pos[0], e.pos[2]) : null;
  if (inside && b.exempt.includes(inside.id)) return;
  const gy = groundCached(b, env, e.pos[0], e.pos[1], e.pos[2]);
  if (Math.abs(e.pos[1] - gy) > 0.02 || b.vy !== 0) {
    applyVertical(e, b, gy, env.ctx.gravityAt(e.pos), dt);
    e.dirty = true;
  }
}

/** Teleport (used when an NPC is far from every player and simulated coarsely). */
export function placeAt(e: ServerEntity, b: Body, env: BodyEnv, p: Vec3, yaw?: number) {
  e.pos = [p[0], p[1], p[2]];
  const inside = buildingAt(env.buildings, p[0], p[2]);
  if (!inside) {
    const g = env.ground(p[0], p[1] + 2, p[2]);
    if (Number.isFinite(g)) e.pos[1] = g;
  }
  if (yaw !== undefined) e.yaw = yaw;
  b.path = [];
  b.idx = 0;
  b.vy = 0;
  e.vel = [0, 0, 0];
  env.ctx.entities.reindex(e);
  e.dirty = true;
}
