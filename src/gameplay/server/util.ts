/**
 * Small server-side helpers for the gameplay module: vector math on tuples,
 * entity classification, ownership (tamed/summoned) conventions.
 */
import type { ServerEntity } from '../../server/entity';
import type { EntityId, Vec3 } from '../../shared/types';

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vcopy = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const vadd = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vlen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const vdist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const hdist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const vdot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function vnorm(a: Vec3, fallback: Vec3 = [0, 0, -1]): Vec3 {
  const l = vlen(a);
  return l > 1e-6 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : vcopy(fallback);
}
/** Horizontal unit direction (y = 0). */
export function hnorm(a: Vec3, fallback: Vec3 = [0, 0, -1]): Vec3 {
  const l = Math.hypot(a[0], a[2]);
  return l > 1e-6 ? [a[0] / l, 0, a[2] / l] : vcopy(fallback);
}
/** Forward vector for a yaw (yaw 0 faces −Z, counter-clockwise). */
export const yawDir = (yaw: number): Vec3 => [-Math.sin(yaw), 0, -Math.cos(yaw)];
export const dirYaw = (d: Vec3): number => Math.atan2(-d[0], -d[2]);
export const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Eye/cast origin of an entity. */
export function eyeOf(e: ServerEntity): Vec3 {
  return [e.pos[0], e.pos[1] + e.height * 0.85 * e.scale, e.pos[2]];
}
/** Center of mass (projectile aiming, fx). */
export function chestOf(e: ServerEntity): Vec3 {
  return [e.pos[0], e.pos[1] + e.height * 0.55 * e.scale, e.pos[2]];
}

/** Living things that take damage (decoys included). */
export function isCombatant(e: ServerEntity): boolean {
  return e.alive && (e.kind === 'player' || e.kind === 'npc' || e.kind === 'creature' || e.tags.has('decoy'));
}

/** Master of a tamed/summoned entity: convention tag "owner:<entityId>". */
export function masterOf(e: ServerEntity): EntityId | undefined {
  for (const t of e.tags) if (t.charCodeAt(0) === 111 /* o */ && t.startsWith('owner:')) return Number(t.slice(6));
  return undefined;
}

export function setMaster(e: ServerEntity, master: EntityId | undefined) {
  for (const t of [...e.tags]) if (t.startsWith('owner:')) e.tags.delete(t);
  if (master !== undefined) e.tags.add('owner:' + master);
}

/**
 * Distance between a point and an entity's vertical capsule (≤ 0 = inside).
 * The capsule spans pos.y .. pos.y + height*scale with radius*scale.
 */
export function capsuleDist(p: Vec3, e: ServerEntity): number {
  const r = e.radius * e.scale;
  const y0 = e.pos[1] + r, y1 = e.pos[1] + Math.max(r, e.height * e.scale - r);
  const cy = Math.max(y0, Math.min(y1, p[1]));
  return Math.hypot(p[0] - e.pos[0], p[1] - cy, p[2] - e.pos[2]) - r;
}

/** Closest distance between segment a→b and an entity capsule (sampled, cheap & robust). */
export function segmentCapsuleDist(a: Vec3, b: Vec3, e: ServerEntity): { d: number; t: number } {
  const len = vdist(a, b);
  const n = Math.max(1, Math.ceil(len / 0.25));
  let best = Infinity, bt = 0;
  const p: Vec3 = [0, 0, 0];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    p[0] = a[0] + (b[0] - a[0]) * t;
    p[1] = a[1] + (b[1] - a[1]) * t;
    p[2] = a[2] + (b[2] - a[2]) * t;
    const d = capsuleDist(p, e);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return { d: best, t: bt };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
