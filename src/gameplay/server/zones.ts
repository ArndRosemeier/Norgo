/**
 * Persistent area spells and gravity fields.
 *
 * Zones are replicated 'effect' entities (flame walls, blizzards, gravity
 * wells, sanctuaries, light orbs, campfires, rune traps, decoys...). Their
 * snapshot carries `projectile: { fx: 'zone:<kind>', owner }` and fx tags
 * `zone:<kind>`, `r:<radius>`, `len:<length>`, `dur:<seconds>` so clients can
 * render them; `yaw` orients walls. Zones tick recipe steps at their centre
 * (area steps with radius 0 use the zone's own shape) or, for traps, fire
 * once when a hostile steps in.
 *
 * Gravity fields multiply local gravity in a sphere for a while. They are
 * broadcast as GameEvent 'gravity' (clients apply them to local physics) and
 * applied to server-simulated bodies through `effectiveGravity`.
 */
import { makeEntity, type ServerEntity } from '../../server/entity';
import type { ServerContext } from '../../server/context';
import type { EntityId, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { AbilityOp } from '../types';
import type { GameplaySystem } from './GameplaySystem';
import type { CastCtx } from './abilities';
import { dirYaw, hnorm, isCombatant, vcopy, vsub, yawDir } from './util';

type ZoneOp = Extract<AbilityOp, { op: 'zone' }>;

/** Geometry of a zone: a vertical cylinder, or a capsule-wall when `length` > 0. */
export interface ZoneShape {
  pos: Vec3;
  radius: number;
  length?: number;
  /** Unit horizontal direction along a wall. */
  dir: Vec3;
}

interface Zone extends ZoneShape {
  e: ServerEntity;
  kind: string;
  caster: EntityId;
  cx: CastCtx;
  op: ZoneOp;
  until: number;
  next: number;
  armedAt: number;
  orbit: number;
}

export class ZoneSim {
  private zones = new Map<EntityId, Zone>();
  private summons = new Map<EntityId, number>();

  constructor(private g: GameplaySystem) {}

  get count() {
    return this.zones.size;
  }

  spawn(cx: CastCtx, op: ZoneOp) {
    const g = this.g, ctx = g.ctx;
    const caster = cx.caster;
    const at = op.at ?? (op.follow ? 'self' : 'point');
    const pos = g.ops.anchor(cx, at);
    if (at === 'self') pos[1] = caster.pos[1];
    const facing = hnorm(vsub(cx.point, caster.pos), yawDir(caster.yaw));
    const dir: Vec3 = [-facing[2], 0, facing[0]];
    // Limit concurrent zones of one kind per caster (traps, light orbs, campfires).
    if (op.max) {
      const mine = [...this.zones.values()].filter((z) => z.caster === caster.id && z.kind === op.kind).sort((a, b) => a.e.createdAt - b.e.createdAt);
      while (mine.length >= op.max) this.remove(mine.shift()!, false);
    }
    const e = makeEntity(ctx.newEntityId(), 'effect', pos, 'gameplay', ctx.time.now);
    e.name = op.kind;
    e.projectile = { fx: 'zone:' + op.kind, owner: caster.id };
    const dur = Number.isFinite(op.duration) ? op.duration : 3600;
    e.fx = ['zone:' + op.kind, 'r:' + op.radius.toFixed(2), 'len:' + (op.length ?? 0).toFixed(1), 'dur:' + dur.toFixed(1)];
    e.yaw = dirYaw(dir);
    e.radius = op.radius;
    e.height = 2;
    e.hp = e.maxHp = 1e6;
    e.mass = 1e6;
    e.faction = caster.faction;
    e.tags.add('zone').add('immovable').add('owner:' + caster.id);
    if (op.hidden) e.flags |= EntFlag.Invisible;
    if (op.light) e.light = { color: op.light, intensity: op.lightIntensity ?? 4, radius: Math.max(8, op.radius * 2.5 + (op.length ?? 0)) };
    ctx.spawn(e);
    const now = ctx.time.now;
    const z: Zone = {
      e, kind: op.kind, caster: caster.id, cx: { ...cx, point: vcopy(pos) }, op, pos, radius: op.radius, length: op.length, dir,
      until: now + dur, next: now + 0.05, armedAt: now + 1, orbit: g.rng.float() * Math.PI * 2,
    };
    this.zones.set(e.id, z);
  }

  /** Is an entity inside a zone shape? */
  contains(z: ZoneShape, e: ServerEntity): boolean {
    const er = e.radius * e.scale;
    const dy = e.pos[1] - z.pos[1];
    if (dy < -Math.max(2, z.radius) || dy > Math.max(3, z.radius)) return false;
    let dx = e.pos[0] - z.pos[0], dz = e.pos[2] - z.pos[2];
    if (z.length) {
      const t = Math.max(-z.length / 2, Math.min(z.length / 2, dx * z.dir[0] + dz * z.dir[2]));
      dx -= z.dir[0] * t;
      dz -= z.dir[2] * t;
    }
    return Math.hypot(dx, dz) <= z.radius + er;
  }

  tick(dt: number) {
    const g = this.g, ctx = g.ctx;
    const now = ctx.time.now;
    for (const z of [...this.zones.values()]) {
      const caster = ctx.entities.get(z.caster);
      if (z.op.follow) {
        if (!caster || !caster.alive) {
          this.remove(z, true);
          continue;
        }
        if (z.kind === 'light_orb') {
          // Bob and circle above the caster's shoulder.
          z.orbit += dt * 0.9;
          z.pos = [caster.pos[0] + Math.cos(z.orbit) * 0.7, caster.pos[1] + caster.height * caster.scale + 0.35 + Math.sin(now * 2.1) * 0.12, caster.pos[2] + Math.sin(z.orbit) * 0.7];
        } else z.pos = vcopy(caster.pos);
        z.e.pos = z.pos;
        z.e.vel = vcopy(caster.vel);
        z.e.dirty = true;
        ctx.entities.reindex(z.e);
      }
      if (now >= z.until) {
        this.remove(z, true);
        continue;
      }
      if (!z.op.ops?.length) continue;
      const zcx: CastCtx = { ...z.cx, caster: caster ?? z.cx.caster, origin: vcopy(z.pos), point: vcopy(z.pos), target: undefined, zone: z };
      if (z.op.trigger) {
        if (now < z.armedAt) continue;
        let victim: ServerEntity | undefined;
        for (const e of ctx.entities.near(z.pos, z.radius + 3)) {
          if (!isCombatant(e) || !g.ops.matches(zcx, e, 'hostile') || !this.contains(z, e)) continue;
          victim = e;
          break;
        }
        if (victim) {
          zcx.target = victim;
          g.ops.run(zcx, z.op.ops);
          this.remove(z, false);
        }
        continue;
      }
      if (now >= z.next) {
        z.next = now + (z.op.tick ?? 1);
        g.ops.run(zcx, z.op.ops);
      }
    }
    if (this.summons.size)
      for (const [id, until] of this.summons) {
        if (now < until) continue;
        this.summons.delete(id);
        const e = ctx.entities.get(id);
        if (e) {
          ctx.broadcast({ type: 'fx', fx: 'unsummon', pos: vcopy(e.pos), target: e.id }, e.pos);
          ctx.despawn(id);
        }
      }
  }

  remove(z: Zone, fade: boolean) {
    if (!this.zones.has(z.e.id)) return;
    this.zones.delete(z.e.id);
    if (fade) this.g.ctx.broadcast({ type: 'fx', fx: 'zone_end:' + z.kind, pos: vcopy(z.pos), radius: z.radius }, z.pos);
    this.g.ctx.despawn(z.e.id);
  }

  /** Despawn summons after their time is up. */
  trackSummon(e: ServerEntity, until: number) {
    this.summons.set(e.id, until);
  }

  removeOwnedFollowers(casterId: EntityId) {
    for (const z of [...this.zones.values()]) if (z.caster === casterId && z.op.follow) this.remove(z, true);
  }

  /** Zones of a caster (UI/debug, specials). */
  ofCaster(casterId: EntityId, kind?: string): ZoneShape[] {
    return [...this.zones.values()].filter((z) => z.caster === casterId && (!kind || z.kind === kind));
  }

  onEntityRemoved(e: ServerEntity) {
    this.zones.delete(e.id);
    this.summons.delete(e.id);
    if (e.kind === 'player') this.removeOwnedFollowers(e.id);
  }
}

// ------------------------------------------------------------------ gravity fields

interface Field {
  pos: Vec3;
  radius: number;
  factor: number;
  until: number;
}

export class GravityFields {
  readonly list: Field[] = [];

  constructor(private g: GameplaySystem) {}

  add(pos: Vec3, radius: number, factor: number, duration: number) {
    const until = this.g.ctx.time.now + duration;
    this.list.push({ pos: vcopy(pos), radius, factor, until });
    this.g.ctx.broadcast({ type: 'gravity', pos: vcopy(pos), radius, factor, until }, pos, 200);
  }

  /** Product of field factors at a point (1 outside all fields). */
  factorAt(p: Vec3): number {
    let f = 1;
    for (const x of this.list) {
      const dx = p[0] - x.pos[0], dy = p[1] - x.pos[1], dz = p[2] - x.pos[2];
      if (dx * dx + dy * dy + dz * dz <= x.radius * x.radius) f *= x.factor;
    }
    return f;
  }

  tick() {
    if (!this.list.length) return;
    const now = this.g.ctx.time.now;
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].until <= now) this.list.splice(i, 1);
  }
}

/**
 * Gravity (m/s², positive = down) felt at `pos`: world gravity × active
 * gravity fields × the entity's own gravity multiplier (levitate, lighten,
 * crush...). Creatures, NPCs, debris and projectiles should use this.
 */
export function effectiveGravity(ctx: ServerContext, pos: Vec3, e?: ServerEntity): number {
  const g = ctx.services.combat as unknown as { fields?: GravityFields };
  const f = g.fields ? g.fields.factorAt(pos) : 1;
  return ctx.gravityAt(pos) * f * (e?.stats?.gravityMul ?? 1);
}
