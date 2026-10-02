/**
 * Projectiles: replicated 'projectile' entities simulated on the server with
 * local gravity (incl. gravity fields), drag-free ballistic flight, homing,
 * piercing, reflection, and collision against creatures (capsules), world
 * objects (cylinders) and the voxel terrain. Impacts run on-hit recipe steps
 * (explosions, craters, zones). Arrows and thrown weapons can be recovered.
 */
import { makeEntity, type ServerEntity } from '../../server/entity';
import type { DamageType, EntityId, Vec3 } from '../../shared/types';
import type { ItemInstance } from '../../items/types';
import type { AbilityOp } from '../types';
import { matDef } from '../../world/materials';
import { outgoingMult } from '../shared/combat';
import { effectiveLevel } from '../shared/stats';
import { hasEffect } from '../shared/checks';
import type { GameplaySystem } from './GameplaySystem';
import { solidMaterial } from './terrainOps';
import type { CastCtx } from './abilities';
import { effectiveGravity } from './zones';
import { chestOf, dirYaw, isCombatant, masterOf, segmentCapsuleDist, vadd, vcopy, vdist, vlen, vnorm, vscale, vsub } from './util';

type ProjOp = Extract<AbilityOp, { op: 'projectile' }>;

interface Proj {
  e: ServerEntity;
  cx: CastCtx;
  op: ProjOp;
  owner: ServerEntity;
  gk: number;
  radius: number;
  until: number;
  pierce: number;
  hit: Set<EntityId>;
  homing?: ServerEntity;
  /** Checked ranged attack: flies straight to this target and hits it (see CastCtx.guaranteed). */
  sure?: ServerEntity;
  damage: number;
  type: DamageType;
  skill: string;
  basic: boolean;
  ammoDef?: string;
  itemDrop?: ItemInstance;
  reflected: boolean;
}

export interface SpawnOpts {
  ammoDef?: string;
  itemDrop?: ItemInstance;
}

const OBJECT_HEIGHT = (kind: string, r: number) => (kind.includes('tree') ? 14 : 2 * r + 0.6);

export class ProjectileSim {
  private list = new Map<EntityId, Proj>();

  constructor(private g: GameplaySystem) {}

  get count() {
    return this.list.size;
  }

  spawn(cx: CastCtx, op: ProjOp, opts: SpawnOpts = {}) {
    const g = this.g, ctx = g.ctx;
    const caster = cx.caster;
    const basic = cx.def.id === 'attack';
    let damage = op.damage ?? 0, type: DamageType = op.type ?? 'force', skill = cx.def.skill;
    if (op.useWeapon) {
      const w = g.melee.weaponOf(caster);
      const wl = effectiveLevel(caster.skills, caster.stats, w.skill);
      damage = (w.damage + (caster.stats?.flatDamage?.[op.type ?? w.type] ?? 0)) * (op.damage ?? 1) * (basic ? 1 + wl * 0.012 : cx.power * (1 + wl * 0.01));
      type = op.type ?? w.type;
      skill = w.skill;
      damage *= outgoingMult(caster.stats, type, false);
    } else damage *= cx.power * outgoingMult(caster.stats, type, cx.def.kind === 'magic');
    const charged = !!cx.def.chargeTime;
    if (charged) damage *= 0.35 + 0.65 * cx.charge;
    const speed = op.speed * (charged ? 0.55 + 0.45 * cx.charge : 1);
    const n = Math.max(1, op.count ?? 1);
    // Abilities that shoot arrows use real arrows.
    let ammoDef = opts.ammoDef;
    if (op.useWeapon && skill === 'archery' && !basic) {
      const a = g.melee.takeAmmo(caster, n);
      if (a === null) {
        g.notify(caster, 'No arrows.', 'warn');
        return;
      }
      ammoDef = a || undefined;
    }
    const right: Vec3 = vnorm([-cx.dir[2], 0, cx.dir[0]], [1, 0, 0]);
    for (let i = 0; i < n; i++) {
      let origin: Vec3, vel: Vec3;
      if (op.volley) {
        const R = cx.def.radius ?? 4;
        const a = g.rng.float() * Math.PI * 2, rr = Math.sqrt(g.rng.float()) * R;
        origin = [cx.point[0] + Math.cos(a) * rr, cx.point[1] + 16 + g.rng.float() * 6, cx.point[2] + Math.sin(a) * rr];
        vel = [cx.dir[0] * 2, -speed, cx.dir[2] * 2];
      } else {
        let d = cx.dir;
        if (n > 1 && op.spread) {
          const ang = ((-0.5 + i / (n - 1)) * op.spread * Math.PI) / 180;
          const c = Math.cos(ang), s = Math.sin(ang);
          d = [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
        } else if (op.spread) {
          d = vnorm([d[0] + (g.rng.float() - 0.5) * 0.02, d[1] + (g.rng.float() - 0.5) * 0.02, d[2]]);
        }
        origin = vadd(vadd(cx.origin, d, 0.5), right, 0.18);
        const gr = effectiveGravity(ctx, origin) * (op.gravity ?? 1);
        const lock = cx.use.lock && cx.target && cx.target !== caster && cx.target.alive && !op.homing ? cx.target : undefined;
        if (lock) {
          // Tab target: lead it and compensate drop; multi-shot spreads still fan around that line.
          d = this.leadAim(origin, lock, speed, gr);
          if (n > 1 && op.spread) {
            const ang = ((-0.5 + i / (n - 1)) * op.spread * Math.PI) / 180;
            const c = Math.cos(ang), s = Math.sin(ang);
            d = [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
          }
        } else if (op.arc && cx.point) d = this.ballistic(origin, cx.point, speed, gr) ?? d;
        vel = [d[0] * speed, d[1] * speed, d[2] * speed];
      }
      const e = makeEntity(ctx.newEntityId(), 'projectile', origin, 'gameplay', ctx.time.now);
      e.projectile = { fx: op.fx, owner: caster.id };
      e.vel = vel;
      e.yaw = dirYaw(vel);
      e.radius = op.radius ?? 0.1;
      e.height = e.radius * 2;
      e.mass = 0.2;
      e.hp = e.maxHp = 1;
      e.tags.add('projectile');
      if (op.light) e.light = { color: op.light, intensity: 4, radius: 9 };
      ctx.spawn(e);
      let homing: ServerEntity | undefined;
      const seeking = !!op.useWeapon && skill === 'archery' && g.melee.grantsOf(caster).has('ench.seeking_arrow');
      if (op.homing || seeking) homing = cx.target && cx.target !== caster && cx.target.alive ? cx.target : this.acquire(caster, origin, vnorm(vel), 30);
      // The first projectile of a checked attack is certain to arrive; spread extras fly freely.
      const sure = i === 0 && !op.volley && cx.guaranteed?.alive ? cx.guaranteed : undefined;
      const life = op.life ?? (op.volley ? 4 : 5);
      const reach = sure ? vlen(vsub(chestOf(sure), origin)) / Math.max(1, speed) + 1 : 0;
      this.list.set(e.id, {
        e, cx, op, owner: caster, gk: op.gravity ?? 1, radius: e.radius, until: ctx.time.now + Math.max(life, reach), pierce: op.pierce ?? 0,
        hit: new Set(), homing, sure, damage, type, skill, basic, ammoDef, itemDrop: i === 0 ? opts.itemDrop : undefined,
        reflected: false,
      });
    }
    ctx.broadcast({ type: 'fx', fx: 'launch', pos: vcopy(cx.origin), dir: cx.dir, color: cx.def.color, target: caster.id }, caster.pos);
  }

  /** Launch direction to hit `to` (low arc), or null if out of range. */
  /**
   * Launch direction that meets a (locked) target: aims at where its chest will be after the
   * flight time (two refinement passes) and compensates for drop along a flat arc.
   */
  private leadAim(from: Vec3, target: ServerEntity, speed: number, gr: number): Vec3 {
    const c = chestOf(target);
    let aim: Vec3 = c;
    for (let k = 0; k < 2; k++) {
      const t = Math.min(3, vdist(from, aim) / Math.max(1, speed));
      aim = [c[0] + target.vel[0] * t, c[1] + Math.max(-2, Math.min(2, target.vel[1] * t)), c[2] + target.vel[2] * t];
    }
    return this.ballistic(from, aim, speed, gr) ?? vnorm(vsub(aim, from));
  }

  private ballistic(from: Vec3, to: Vec3, v: number, gr: number): Vec3 | null {
    const dx = to[0] - from[0], dz = to[2] - from[2], dy = to[1] - from[1];
    const x = Math.hypot(dx, dz);
    if (x < 0.5 || gr <= 0) return null;
    const v2 = v * v;
    const disc = v2 * v2 - gr * (gr * x * x + 2 * dy * v2);
    const theta = disc < 0 ? Math.PI / 4 : Math.atan((v2 - Math.sqrt(disc)) / (gr * x));
    const c = Math.cos(theta);
    return [(dx / x) * c, Math.sin(theta), (dz / x) * c];
  }

  private acquire(caster: ServerEntity, from: Vec3, dir: Vec3, range: number): ServerEntity | undefined {
    let best: ServerEntity | undefined, bestD = Infinity;
    for (const e of this.g.ctx.entities.near(from, range)) {
      if (e === caster || !isCombatant(e) || !this.g.isHostile(caster, e)) continue;
      const to = vsub(chestOf(e), from);
      const d = vlen(to);
      if ((to[0] * dir[0] + to[1] * dir[1] + to[2] * dir[2]) / d < 0.85) continue;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  tick(dt: number) {
    if (!this.list.size) return;
    const g = this.g, ctx = g.ctx;
    const now = ctx.time.now;
    for (const p of [...this.list.values()]) {
      const e = p.e;
      if (now > p.until) {
        this.finish(p, vcopy(e.pos), undefined, true);
        continue;
      }
      const speed = vlen(e.vel);
      // Certain hit: straight to the target's chest, through anything in between.
      if (p.sure) {
        if (!p.sure.alive || !ctx.entities.get(p.sure.id)) p.sure = undefined;
        else {
          const aim = chestOf(p.sure);
          const to = vsub(aim, e.pos);
          const dist = vlen(to);
          const fly = Math.max(speed, 8);
          const step = fly * dt;
          if (dist <= step + p.radius + p.sure.radius * p.sure.scale * 0.5) {
            const target = p.sure;
            p.sure = undefined;
            if (this.hitEntity(p, target, aim)) continue;
          } else {
            const n = vscale(to, 1 / dist);
            e.vel = vscale(n, fly);
            e.pos = vadd(e.pos, n, step);
            e.yaw = dirYaw(e.vel);
            e.dirty = true;
            ctx.entities.reindex(e);
            continue;
          }
        }
      }
      const travel = speed * dt;
      const steps = Math.max(1, Math.ceil(travel / 0.6));
      const h = dt / steps;
      const cands = ctx.entities.near(e.pos, travel + 4).filter((x) => isCombatant(x) && !p.hit.has(x.id) && x !== p.owner && masterOf(x) !== p.owner.id);
      const objs = ctx.services.objects.near(e.pos, travel + 3);
      let done = false;
      for (let s = 0; s < steps && !done; s++) {
        if (p.homing?.alive) {
          const want = vnorm(vsub(chestOf(p.homing), e.pos));
          const cur = vnorm(e.vel);
          const k = Math.min(1, (p.op.homing ?? 1.2) * h);
          const nd = vnorm([cur[0] + want[0] * k, cur[1] + want[1] * k, cur[2] + want[2] * k]);
          const sp = vlen(e.vel);
          e.vel = [nd[0] * sp, nd[1] * sp, nd[2] * sp];
        }
        e.vel[1] -= effectiveGravity(ctx, e.pos) * p.gk * h;
        const next: Vec3 = [e.pos[0] + e.vel[0] * h, e.pos[1] + e.vel[1] * h, e.pos[2] + e.vel[2] * h];
        // Creatures.
        let victim: ServerEntity | undefined, vt = Infinity;
        for (const c of cands) {
          if (p.hit.has(c.id)) continue;
          const r = segmentCapsuleDist(e.pos, next, c);
          if (r.d <= p.radius && r.t < vt) {
            vt = r.t;
            victim = c;
          }
        }
        if (victim) {
          const hp: Vec3 = [e.pos[0] + (next[0] - e.pos[0]) * vt, e.pos[1] + (next[1] - e.pos[1]) * vt, e.pos[2] + (next[2] - e.pos[2]) * vt];
          if (this.hitEntity(p, victim, hp)) {
            done = true;
            break;
          }
          continue;
        }
        // World objects (trees, rocks) as vertical cylinders.
        for (const o of objs) {
          if (o.hp <= 0) continue;
          if (Math.hypot(next[0] - o.pos[0], next[2] - o.pos[2]) > o.radius + p.radius) continue;
          if (next[1] < o.pos[1] - 0.3 || next[1] > o.pos[1] + OBJECT_HEIGHT(o.kind, o.radius)) continue;
          const amt = p.damage * (p.type === 'fire' ? 1 : p.type === 'blunt' || p.type === 'force' ? 0.6 : 0.25);
          ctx.services.objects.damage(o.id, amt, p.type, p.owner, next);
          ctx.broadcast({ type: 'impact', pos: next, normal: vnorm(vsub(next, [o.pos[0], next[1], o.pos[2]])), material: o.kind.includes('tree') ? 'wood' : 'stone', force: Math.min(1, speed / 60) }, next);
          this.finish(p, next, undefined, false);
          done = true;
          break;
        }
        if (done) break;
        // Terrain.
        if (ctx.terrain.density(next[0], next[1], next[2]) > 0) {
          const d = vsub(next, e.pos);
          const len = vlen(d) || 1e-3;
          const hit = ctx.terrain.raycast(e.pos[0], e.pos[1], e.pos[2], d[0] / len, d[1] / len, d[2] / len, len + 0.3);
          const hp: Vec3 = hit ? [hit.x, hit.y, hit.z] : vcopy(e.pos);
          const n: Vec3 = hit ? [hit.nx, hit.ny, hit.nz] : [0, 1, 0];
          const mat = solidMaterial(ctx, hp[0] - n[0] * 0.2, hp[1] - n[1] * 0.2, hp[2] - n[2] * 0.2);
          ctx.broadcast({ type: 'impact', pos: hp, normal: n, material: matDef(mat).name, force: Math.min(1, speed / 60) }, hp);
          this.finish(p, vadd(hp, n, 0.25), undefined, false, n);
          done = true;
          break;
        }
        e.pos = next;
      }
      if (done) continue;
      e.yaw = dirYaw(e.vel);
      e.dirty = true;
      ctx.entities.reindex(e);
    }
  }

  /** Returns true when the projectile is consumed. */
  private hitEntity(p: Proj, victim: ServerEntity, at: Vec3): boolean {
    const g = this.g, ctx = g.ctx;
    p.hit.add(victim.id);
    if (hasEffect(victim, 'reflect') && !p.reflected) {
      p.reflected = true;
      p.e.vel = [-p.e.vel[0], -p.e.vel[1] * 0.5 + 2, -p.e.vel[2]];
      p.owner = victim;
      p.e.projectile = { fx: p.op.fx, owner: victim.id };
      p.hit.clear();
      p.hit.add(victim.id);
      p.homing = ctx.entities.get(p.cx.caster.id);
      ctx.broadcast({ type: 'fx', fx: 'reflect', pos: at, target: victim.id }, at);
      if (victim.kind === 'player') g.grantXp(victim, 'shields', 4);
      return false;
    }
    const kb = p.op.knockback ?? 0;
    const dealt = p.damage > 0
      ? g.damage(victim, p.damage, p.type, p.owner, { ability: p.basic ? undefined : p.cx.def.id, ranged: true, knockback: kb || undefined, pos: at })
      : 0;
    if (p.op.effect && (dealt > 0 || p.damage <= 0)) g.ops.applyEffect(p.cx, victim, p.op.effect);
    if (dealt > 0) g.grantXp(p.owner, p.skill, p.basic ? 2.5 : 1);
    if (dealt > 0 && p.op.useWeapon) g.melee.onWeaponHit(p.owner, victim, dealt, p.type, victim.target !== p.owner.id);
    if (p.op.onHit) g.ops.run({ ...p.cx, caster: p.owner, origin: at, point: at, target: victim, dir: vnorm(p.e.vel) }, p.op.onHit);
    if (p.pierce > 0) {
      p.pierce--;
      p.damage *= 0.8;
      return false;
    }
    this.finish(p, at, victim, false);
    return true;
  }

  /** Remove the projectile; run on-hit steps for terrain/expiry and drop recoverables. */
  private finish(p: Proj, at: Vec3, victim: ServerEntity | undefined, expired: boolean, normal?: Vec3) {
    const g = this.g, ctx = g.ctx;
    if (!this.list.has(p.e.id)) return;
    this.list.delete(p.e.id);
    // Spells detonate where they stop; mundane projectiles just stop.
    if (!victim && p.op.onHit && (!expired || p.cx.def.kind === 'magic'))
      g.ops.run({ ...p.cx, caster: p.owner, origin: at, point: at, target: undefined, dir: vnorm(p.e.vel) }, p.op.onHit);
    if (!victim) ctx.broadcast({ type: 'fx', fx: 'hit:' + p.op.fx, pos: at, dir: normal ?? vnorm(p.e.vel), color: p.cx.def.color }, at);
    const items = ctx.services.items;
    try {
      if (p.itemDrop) {
        const gy = ctx.groundAt(at[0], at[1] + 0.5, at[2], 30);
        items.drop([at[0], Number.isNaN(gy) ? at[1] : gy + 0.05, at[2]], p.itemDrop, [0, 0, 0]);
      } else if (p.ammoDef && !victim && !expired && g.rng.float() < 0.55) {
        items.drop(at, items.create(p.ammoDef, { count: 1 }), [0, 0, 0]);
      }
    } catch (err) {
      ctx.log('gameplay: could not drop recovered projectile item', err);
    }
    ctx.despawn(p.e.id);
  }

  onEntityRemoved(e: ServerEntity) {
    this.list.delete(e.id);
    for (const p of this.list.values()) if (p.homing === e) p.homing = undefined;
  }

  /** Distance helper for debug/tests. */
  nearest(pos: Vec3): number {
    let d = Infinity;
    for (const p of this.list.values()) d = Math.min(d, vdist(p.e.pos, pos));
    return d;
  }
}
