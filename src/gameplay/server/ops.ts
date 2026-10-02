/**
 * Ability recipe interpreter. Executes AbilityOp steps for a cast: strikes,
 * projectiles, areas, cones, beams, effects, heals, cleanses, terrain shaping,
 * zones, gravity fields, teleports, dashes, pushes, summons, delays and
 * special behaviours. Shared by players, NPCs, creatures, zones and traps.
 */
import type { ServerEntity } from '../../server/entity';
import type { DamageType, Vec3 } from '../../shared/types';
import type { AbilityOp, EffectApply, OpAnchor, OpWho } from '../types';
import { effectDef } from '../data/catalog';
import { matDef } from '../../world/materials';
import { outgoingMult } from '../shared/combat';
import type { GameplaySystem } from './GameplaySystem';
import { solidMaterial } from './terrainOps';
import type { CastCtx } from './abilities';
import {
  capsuleDist, chestOf, eyeOf, hnorm, isCombatant, masterOf, segmentCapsuleDist, setMaster, vadd, vcopy, vdist, vdot, vlen, vnorm, vscale, vsub, yawDir,
} from './util';

type Op<K extends AbilityOp['op']> = Extract<AbilityOp, { op: K }>;

interface Delayed {
  at: number;
  cx: CastCtx;
  ops: AbilityOp[];
}

interface DashHit {
  until: number;
  cx: CastCtx;
  hit: NonNullable<Op<'dash'>['hit']>;
  done: Set<number>;
}

export class OpRunner {
  private delayed: Delayed[] = [];
  private dashHits: DashHit[] = [];

  constructor(private g: GameplaySystem) {}

  /**
   * Run steps. Returns false when a step could not do anything meaningful
   * (only `special` steps report this) so the caller can refund the cast.
   */
  run(cx: CastCtx, ops: AbilityOp[], toggleAbility?: string): boolean {
    let ok = true;
    for (const op of ops) {
      try {
        if (!this.step(cx, op, toggleAbility)) ok = false;
      } catch (err) {
        console.error('[gameplay] op failed', cx.def.id, op.op, err);
      }
      if (!ok) break;
    }
    return ok;
  }

  tick(_dt: number) {
    const now = this.g.ctx.time.now;
    if (this.delayed.length) {
      const due = this.delayed.filter((d) => d.at <= now);
      if (due.length) {
        this.delayed = this.delayed.filter((d) => d.at > now);
        for (const d of due) if (d.cx.caster.alive || d.cx.zone) this.run(d.cx, d.ops);
      }
    }
    if (this.dashHits.length) {
      for (const d of this.dashHits) this.dashTick(d);
      this.dashHits = this.dashHits.filter((d) => d.until > now && d.cx.caster.alive);
    }
  }

  // ------------------------------------------------------------------ helpers

  anchor(cx: CastCtx, at: OpAnchor | undefined, def: OpAnchor = 'point'): Vec3 {
    switch (at ?? def) {
      case 'self': return vcopy(cx.caster.pos);
      case 'target': return cx.target ? chestOf(cx.target) : vcopy(cx.point);
      default: return vcopy(cx.point);
    }
  }

  /** Does `e` match the who-filter relative to the caster? */
  matches(cx: CastCtx, e: ServerEntity, who: OpWho = 'hostile'): boolean {
    const c = cx.caster;
    switch (who) {
      case 'all': return true;
      case 'others': return e !== c && masterOf(e) !== c.id;
      case 'ally': return this.g.isAlly(c, e);
      default:
        if (e === c || masterOf(e) === c.id) return false;
        // The directly targeted entity counts as hostile: the caster chose it.
        return this.g.isHostile(c, e) || (cx.target === e && cx.caster.kind === 'player');
    }
  }

  /** Combatants inside a sphere (or the current zone shape when radius is 0). */
  targetsIn(cx: CastCtx, center: Vec3, radius: number, who?: OpWho): ServerEntity[] {
    const out: ServerEntity[] = [];
    const z = radius <= 0 ? cx.zone : undefined;
    const r = z ? z.radius + (z.length ?? 0) / 2 : radius;
    for (const e of this.g.ctx.entities.near(z ? z.pos : center, r + 3)) {
      if (!isCombatant(e) || !this.matches(cx, e, who)) continue;
      if (z) {
        if (!this.g.zones.contains(z, e)) continue;
      } else if (capsuleDist(center, e) > radius) continue;
      out.push(e);
    }
    return out;
  }

  scaledDamage(cx: CastCtx, base: number, type: DamageType): number {
    return base * cx.power * outgoingMult(cx.caster.stats, type, cx.def.kind === 'magic');
  }

  applyEffect(cx: CastCtx, e: ServerEntity, eff: EffectApply | undefined, scale = false) {
    if (!eff || !e.alive) return;
    if (eff.chance !== undefined && this.g.rng.float() > eff.chance) return;
    const d = effectDef(eff.id);
    const mag = d && (d.dot || d.hot || d.mot || scale) ? eff.magnitude * cx.power * (cx.def.kind === 'magic' ? 1 + (cx.caster.stats?.spellPower ?? 0) : 1) : eff.magnitude;
    this.g.effects.apply(e, eff.id, mag, eff.duration, cx.caster);
  }

  hitObjects(cx: CastCtx, center: Vec3, radius: number, o: { amount: number; kind: DamageType | 'chop' | 'mine' }, filter?: (p: Vec3) => boolean) {
    const objs = this.g.ctx.services.objects.near(center, radius);
    let hits = 0;
    for (const ob of objs) {
      if (ob.hp <= 0 || (filter && !filter(ob.pos))) continue;
      const amt = o.amount * cx.power;
      this.g.ctx.services.objects.damage(ob.id, amt, o.kind, cx.caster, ob.pos);
      hits++;
      if (o.kind === 'chop') this.g.grantXp(cx.caster, 'woodcutting', 3);
      else if (o.kind === 'mine') this.g.grantXp(cx.caster, 'mining', 3);
      if (hits >= 6) break;
    }
    return hits;
  }

  /** Move an entity instantly (players get a correction + teleport grace). */
  setPos(e: ServerEntity, p: Vec3, reason: string) {
    e.pos = [p[0], p[1], p[2]];
    e.vel = [0, 0, 0];
    this.g.ctx.entities.reindex(e);
    e.dirty = true;
    if (e.kind === 'player') {
      e.tags.add('teleportGrace');
      this.g.ctx.send(e.id, { t: 'correct', pos: e.pos, vel: [0, 0, 0], reason });
    }
  }

  /** Velocity impulse on the caster (players: knockback event to their own client). */
  impulse(e: ServerEntity, imp: Vec3) {
    if (e.kind === 'player') this.g.ctx.broadcast({ type: 'knockback', target: e.id, impulse: imp }, e.pos);
    else this.g.mover.push(e, imp);
  }

  // ------------------------------------------------------------------ steps

  private step(cx: CastCtx, op: AbilityOp, toggleAbility?: string): boolean {
    const g = this.g, ctx = g.ctx;
    switch (op.op) {
      case 'strike': {
        g.melee.queueStrike(cx.caster, ctx.time.now + (op.delay ?? 0.25), {
          mult: op.mult, arc: op.arc, reach: op.reach, maxHits: op.maxHits, knockback: op.knockback, type: op.type, effect: op.effect,
          bonusUnaware: op.bonusUnaware, ability: cx.def.id, dir: cx.dir, target: cx.target?.id, power: cx.power,
          lock: !!cx.use.lock && !!cx.target && cx.target !== cx.caster,
        });
        return true;
      }
      case 'projectile':
        g.projectiles.spawn(cx, op);
        return true;
      case 'area': return this.area(cx, op);
      case 'cone': return this.cone(cx, op);
      case 'beam': return this.beam(cx, op);
      case 'effect': {
        const e = op.to === 'self' ? cx.caster : cx.target ?? (cx.def.targeting === 'entity' ? cx.caster : undefined);
        if (!e) return true;
        if (op.duration === Infinity) {
          // Toggle effect: bound to the ability, kept alive by upkeep.
          g.effects.apply(e, op.id, op.magnitude, Infinity, cx.caster, toggleAbility);
        } else this.applyEffect(cx, e, { id: op.id, magnitude: op.magnitude, duration: op.duration }, op.scale);
        return true;
      }
      case 'heal': {
        const e = op.to === 'self' ? cx.caster : cx.target ?? cx.caster;
        const amt = op.amount * cx.power * (cx.def.kind === 'magic' ? 1 + (cx.caster.stats?.spellPower ?? 0) : 1);
        const healed = g.heal(e, amt, cx.caster);
        if (healed > 0 && e !== cx.caster) g.grantXp(cx.caster, cx.def.skill, Math.min(6, healed * 0.1));
        return true;
      }
      case 'cleanse': {
        if (op.to === 'area') {
          for (const e of this.targetsIn(cx, cx.zone?.pos ?? cx.point, op.radius ?? 5, 'ally')) g.effects.cleanse(e, op.buffs, op.max ?? 1);
        } else {
          const e = op.to === 'self' ? cx.caster : cx.target ?? cx.caster;
          g.effects.cleanse(e, op.buffs, op.max ?? 99);
        }
        return true;
      }
      case 'terrain': return g.terrainOps.shape(cx, op);
      case 'zone':
        g.zones.spawn(cx, op);
        return true;
      case 'gravity':
        g.fields.add(this.anchor(cx, op.at), op.radius, op.factor, op.duration);
        return true;
      case 'teleport': return this.teleport(cx, op);
      case 'dash': {
        let d: Vec3;
        switch (op.dir ?? 'flat') {
          case 'aim': d = cx.dir; break;
          case 'back': d = vscale(hnorm(cx.dir), -1); break;
          case 'up': d = [0, 0, 0]; break;
          default: {
            // Movement abilities may send the movement direction in use.dir.
            d = hnorm(cx.dir, yawDir(cx.caster.yaw));
          }
        }
        this.impulse(cx.caster, [d[0] * op.speed, (d[1] ?? 0) * op.speed + (op.up ?? 0), d[2] * op.speed]);
        ctx.broadcast({ type: 'fx', fx: 'dash', pos: vcopy(cx.caster.pos), dir: d, target: cx.caster.id, color: cx.def.color }, cx.caster.pos);
        if (op.hit) this.dashHits.push({ until: ctx.time.now + 0.6, cx, hit: op.hit, done: new Set() });
        return true;
      }
      case 'push': return this.push(cx, op);
      case 'fx': {
        const pos = this.anchor(cx, op.at);
        ctx.broadcast({ type: 'fx', fx: op.fx, pos, dir: cx.dir, radius: op.radius, color: op.color ?? cx.def.color, duration: op.duration, target: op.at === 'target' ? cx.target?.id : op.at === 'self' ? cx.caster.id : undefined }, pos);
        return true;
      }
      case 'summon': return this.summon(cx, op);
      case 'delay':
        this.delayed.push({ at: ctx.time.now + op.t, cx: { ...cx, point: vcopy(cx.point) }, ops: op.ops });
        return true;
      case 'special': return g.specials.run(cx, op);
    }
    return true;
  }

  private area(cx: CastCtx, op: Op<'area'>): boolean {
    const g = this.g, ctx = g.ctx;
    const center = cx.zone && op.radius <= 0 ? cx.zone.pos : this.anchor(cx, op.at);
    const targets = this.targetsIn(cx, center, op.radius, op.who ?? (op.heal ? 'ally' : 'hostile'));
    let hits = 0;
    for (const e of targets) {
      if (op.damage) {
        const type = op.type ?? 'force';
        const dist = cx.zone ? 0 : Math.max(0, capsuleDist(center, e));
        const falloff = op.radius > 0 ? 1 - 0.4 * Math.min(1, dist / op.radius) : 1;
        if (g.damage(e, this.scaledDamage(cx, op.damage, type) * falloff, type, cx.caster, { ability: cx.def.id, pos: chestOf(e) }) > 0) hits++;
      }
      if (op.heal) g.heal(e, op.heal * cx.power * (1 + (cx.caster.stats?.spellPower ?? 0)), cx.caster);
      this.applyEffect(cx, e, op.effect);
      if (op.mana && e.stats) e.mana = Math.min(e.stats.maxMana, e.mana + op.mana);
      if (op.stamina && e.stats) e.stamina = Math.min(e.stats.maxStamina, e.stamina + op.stamina);
      if ((op.knockback || op.lift) && e !== cx.caster) {
        const d = hnorm(vsub(e.pos, center), yawDir(e.yaw + Math.PI));
        const k = op.knockback ?? 0;
        g.knockback(e, [d[0] * k, (op.lift ?? 0) + k * 0.25, d[2] * k]);
      }
    }
    if (op.objects) this.hitObjects(cx, center, cx.zone && op.radius <= 0 ? cx.zone.radius + (cx.zone.length ?? 0) / 2 : op.radius, op.objects);
    if (op.fx) ctx.broadcast({ type: 'fx', fx: op.fx, pos: center, radius: op.radius, color: cx.def.color }, center);
    if (hits && cx.def.kind === 'magic' && !cx.zone) g.grantXp(cx.caster, cx.def.skill, Math.min(4, hits));
    return true;
  }

  /** Entities inside a cone from the caster along the aim direction. */
  coneTargets(cx: CastCtx, range: number, angle: number, who?: OpWho): ServerEntity[] {
    const origin = eyeOf(cx.caster);
    const cosA = Math.cos((angle * Math.PI) / 360);
    const out: ServerEntity[] = [];
    for (const e of this.g.ctx.entities.near(cx.caster.pos, range + 2)) {
      if (!isCombatant(e) || !this.matches(cx, e, who)) continue;
      const to = vsub(chestOf(e), origin);
      const dist = vlen(to);
      if (dist - e.radius > range) continue;
      if (dist > 1 && vdot(to, cx.dir) / dist < cosA) continue;
      out.push(e);
    }
    return out;
  }

  private cone(cx: CastCtx, op: Op<'cone'>): boolean {
    const g = this.g, ctx = g.ctx;
    const origin = eyeOf(cx.caster);
    const cosA = Math.cos((op.angle * Math.PI) / 360);
    for (const e of this.coneTargets(cx, op.range, op.angle, op.who)) {
      if (op.damage) {
        const type = op.type ?? 'force';
        g.damage(e, this.scaledDamage(cx, op.damage, type), type, cx.caster, { ability: cx.def.id, knockback: op.knockback });
      } else if (op.knockback) {
        const d = hnorm(vsub(e.pos, cx.caster.pos));
        g.knockback(e, [d[0] * op.knockback, 2, d[2] * op.knockback]);
      }
      this.applyEffect(cx, e, op.effect);
    }
    if (op.objects)
      this.hitObjects(cx, cx.caster.pos, op.range + 1, op.objects, (p) => {
        const to = vsub([p[0], origin[1], p[2]], origin);
        const l = vlen(to);
        return l < 1.2 || vdot(to, hnorm(cx.dir)) / l > cosA;
      });
    if (op.fx) ctx.broadcast({ type: 'fx', fx: op.fx, pos: origin, dir: cx.dir, radius: op.range, color: cx.def.color, target: cx.caster.id }, origin);
    return true;
  }

  private beam(cx: CastCtx, op: Op<'beam'>): boolean {
    const g = this.g, ctx = g.ctx;
    const origin = eyeOf(cx.caster);
    let dir = cx.dir;
    if (cx.target && cx.target !== cx.caster) dir = vnorm(vsub(chestOf(cx.target), origin));
    const hit = ctx.terrain.raycast(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], op.range);
    let length = hit ? hit.dist : op.range;
    // Entities are tested a little past the terrain impact: a creature standing partly in the
    // ground right where the beam lands (small critters on slopes) must not be shielded by it.
    const graze = hit ? Math.min(op.range, length + 0.6) : length;
    const end = vadd(origin, dir, graze);
    // Entities along the ray (first one unless piercing).
    const hits: { e: ServerEntity; t: number }[] = [];
    for (const e of ctx.entities.near(vadd(origin, dir, graze / 2), graze / 2 + 3)) {
      if (e === cx.caster || !isCombatant(e)) continue;
      const { d, t } = segmentCapsuleDist(origin, end, e);
      if (d <= 0.35) hits.push({ e, t });
    }
    hits.sort((a, b) => a.t - b.t);
    const victims = op.pierce ? hits : hits.slice(0, 1);
    if (!op.pierce && victims.length) length = Math.max(0.5, Math.min(length, victims[0].t * graze));
    for (const { e } of victims) {
      if (op.damage) {
        const type = op.type ?? 'force';
        g.damage(e, this.scaledDamage(cx, op.damage, type), type, cx.caster, { ability: cx.def.id, knockback: op.knockback });
      }
      if (op.heal) g.heal(e, op.heal * cx.power, cx.caster);
      this.applyEffect(cx, e, op.effect);
    }
    if (!victims.length && op.objects) {
      // Trees/rocks are not terrain: test them as vertical cylinders along the ray,
      // preferring the object the client had under its crosshair.
      const obj = this.objectAlongRay(cx, origin, dir, length);
      if (obj) {
        const hd = Math.hypot(obj.pos[0] - origin[0], obj.pos[2] - origin[2]) / (Math.hypot(dir[0], dir[2]) || 1);
        length = Math.max(0.5, Math.min(length, hd));
        ctx.services.objects.damage(obj.id, op.objects.amount * cx.power, op.objects.kind, cx.caster, obj.pos);
        if (op.objects.kind === 'chop') g.grantXp(cx.caster, 'woodcutting', 3);
      }
    }
    ctx.broadcast({ type: 'fx', fx: op.fx, pos: origin, dir, radius: length, color: cx.def.color, target: victims[0]?.e.id }, origin);
    if (hit && !victims.length) {
      const mat = solidMaterial(ctx, hit.x - hit.nx * 0.2, hit.y - hit.ny * 0.2, hit.z - hit.nz * 0.2);
      ctx.broadcast({ type: 'impact', pos: [hit.x, hit.y, hit.z], normal: [hit.nx, hit.ny, hit.nz], material: matDef(mat).name, force: 0.5 }, origin);
    }
    return true;
  }

  /** First destructible object along a ray (objects are vertical cylinders on the server). */
  objectAlongRay(cx: CastCtx, origin: Vec3, dir: Vec3, length: number): { id: number | string; pos: Vec3 } | null {
    const objects = this.g.ctx.services.objects;
    const mid = vadd(origin, dir, length / 2);
    const list = objects.near(mid, length / 2 + 3);
    if (cx.use.object !== undefined) {
      const o = list.find((x) => x.id === cx.use.object);
      if (o && o.hp > 0) return o;
    }
    let best: { id: number | string; pos: Vec3 } | null = null, bestT = Infinity;
    const hl = Math.hypot(dir[0], dir[2]) || 1;
    for (const o of list) {
      if (o.hp <= 0) continue;
      // Closest approach in the XZ plane.
      const ox = o.pos[0] - origin[0], oz = o.pos[2] - origin[2];
      const t = (ox * dir[0] + oz * dir[2]) / (hl * hl);
      if (t < 0 || t > length) continue;
      const px = origin[0] + dir[0] * t - o.pos[0], pz = origin[2] + dir[2] * t - o.pos[2];
      const y = origin[1] + dir[1] * t;
      const height = o.kind.includes('tree') ? 14 : 2 * o.radius + 0.6;
      if (Math.hypot(px, pz) > o.radius + 0.35 || y < o.pos[1] - 0.5 || y > o.pos[1] + height) continue;
      if (t < bestT) {
        bestT = t;
        best = o;
      }
    }
    return best;
  }

  private teleport(cx: CastCtx, op: Op<'teleport'>): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    let dest: Vec3;
    switch (op.mode) {
      case 'behind': {
        if (!cx.target || cx.target === c) return true;
        const f = yawDir(cx.target.yaw);
        dest = vadd(cx.target.pos, f, -1.3);
        break;
      }
      case 'swap': {
        if (!cx.target || cx.target === c) return true;
        const a = vcopy(c.pos);
        this.setPos(cx.target, a, 'swap');
        dest = vcopy(cx.target.pos);
        break;
      }
      case 'recall':
        return g.specials.run(cx, { op: 'special', fn: 'recall' });
      default: {
        // Blink toward the aim point, stopping short of walls.
        const from = eyeOf(c);
        const to: Vec3 = [cx.point[0], cx.point[1] + 1, cx.point[2]];
        const d = vsub(to, from);
        const dist = Math.min(vlen(d), op.range);
        const dn = vnorm(d);
        const hit = ctx.terrain.raycast(from[0], from[1], from[2], dn[0], dn[1], dn[2], dist);
        const reach = hit ? Math.max(0, hit.dist - 0.7) : dist;
        dest = vadd(from, dn, reach);
      }
    }
    const gy = ctx.groundAt(dest[0], dest[1] + 1.2, dest[2], 30);
    if (!Number.isNaN(gy)) dest[1] = gy + 0.05;
    // Never end inside rock.
    if (ctx.terrain.density(dest[0], dest[1] + 1, dest[2]) > 0) return true;
    ctx.broadcast({ type: 'fx', fx: 'blink_out', pos: vcopy(c.pos), color: cx.def.color, target: c.id }, c.pos);
    this.setPos(c, dest, 'blink');
    ctx.broadcast({ type: 'fx', fx: 'blink_in', pos: vcopy(dest), color: cx.def.color, target: c.id }, dest);
    return true;
  }

  private push(cx: CastCtx, op: Op<'push'>): boolean {
    const g = this.g, ctx = g.ctx;
    const center = cx.zone ? cx.zone.pos : this.anchor(cx, op.at, 'point');
    const cosA = op.cone ? Math.cos((op.cone * Math.PI) / 360) : -2;
    const fwd = hnorm(cx.dir);
    for (const e of ctx.entities.near(center, op.radius + 1)) {
      const loose = e.kind === 'item';
      if (!loose && !isCombatant(e)) continue;
      if (!loose && !this.matches(cx, e, op.who ?? 'others')) continue;
      const to = vsub(e.pos, center);
      const dist = Math.hypot(to[0], to[2]);
      if (dist > op.radius) continue;
      const d = hnorm(to, fwd);
      if (op.cone && dist > 0.8 && d[0] * fwd[0] + d[2] * fwd[2] < cosA) continue;
      let f = op.force * (1 - 0.45 * (dist / op.radius));
      // Pulls must not overshoot the centre.
      if (f < 0) f = -Math.min(-f, dist * 1.8);
      const imp: Vec3 = [d[0] * f, (op.up ?? 0) + Math.abs(f) * 0.12, d[2] * f];
      if (loose) g.mover.push(e, imp);
      else g.knockback(e, imp);
    }
    return true;
  }

  private summon(cx: CastCtx, op: Op<'summon'>): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const cs = ctx.services.creatures;
    const col = ctx.gen.cachedColumn(c.pos[0], c.pos[2]);
    const uw = ctx.gen.isUnderworld(c.pos[0], c.pos[1], c.pos[2]);
    const biome = uw ? col.uwBiome : col.biome;
    let species = cs.speciesFor(biome, op.role, uw);
    if (!species.length) species = cs.speciesFor(biome, 'grazer', uw);
    if (!species.length) {
      g.notify(c, 'No beast answers your call here.', 'warn');
      return false;
    }
    const n = op.count ?? 1;
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const sp = species[g.rng.int(0, species.length - 1)];
      const ang = g.rng.float() * Math.PI * 2;
      const px = c.pos[0] + Math.cos(ang) * 3, pz = c.pos[2] + Math.sin(ang) * 3;
      const gy = ctx.groundAt(px, c.pos[1] + 3, pz, 10);
      const pos: Vec3 = [px, Number.isNaN(gy) ? c.pos[1] : gy + 0.1, pz];
      const e = cs.spawn(sp, pos, { tamedBy: c.id, hostile: false, seed: g.rng.nextU32(), growth: 1 });
      if (!e) continue;
      setMaster(e, c.id);
      e.tags.add('summon');
      e.faction = c.faction;
      g.effects.apply(e, 'tamed_bond', 1, op.duration, c);
      g.zones.trackSummon(e, ctx.time.now + op.duration);
      ctx.broadcast({ type: 'fx', fx: 'summon', pos, color: cx.def.color, target: e.id }, pos);
      spawned++;
    }
    if (!spawned) g.notify(c, 'No beast answers your call.', 'warn');
    return spawned > 0;
  }

  private dashTick(d: DashHit) {
    const g = this.g, c = d.cx.caster;
    for (const e of g.ctx.entities.near(c.pos, d.hit.radius + 1.5)) {
      if (e === c || d.done.has(e.id) || !isCombatant(e) || !this.matches(d.cx, e, 'hostile')) continue;
      if (vdist(e.pos, c.pos) > d.hit.radius + e.radius) continue;
      d.done.add(e.id);
      g.damage(e, this.scaledDamage(d.cx, d.hit.damage, d.hit.type), d.hit.type, c, { ability: d.cx.def.id, knockback: d.hit.knockback, melee: true });
      g.effects.apply(e, 'staggered', 1, 1.5, c);
    }
  }
}
