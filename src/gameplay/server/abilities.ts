/**
 * Ability use pipeline: validation (unlocked, alive, not stunned/silenced,
 * requirements), target & aim resolution, costs, cooldowns, cast times,
 * toggles with upkeep, interrupts. Execution of the recipe is delegated to
 * OpRunner. Players and AI casters go through exactly the same path.
 */
import type { ServerEntity } from '../../server/entity';
import { getPlayerData } from '../../server/systems/playerData';
import type { EntityId, Vec3 } from '../../shared/types';
import type { AbilityDef, AbilityUse } from '../types';
import { abilityDef, effectDef } from '../data/catalog';
import { abilityPower, effectiveCooldown, effectiveCost } from '../shared/combat';
import { effectiveLevel } from '../shared/stats';
import type { GameplaySystem } from './GameplaySystem';
import { capsuleDist, chestOf, eyeOf, isCombatant, isVec3, vadd, vdist, vnorm, vsub, yawDir, dirYaw, vdot, vlen } from './util';
import type { ZoneShape } from './zones';

/** Everything a recipe step needs to know about the cast. */
export interface CastCtx {
  caster: ServerEntity;
  def: AbilityDef;
  use: AbilityUse;
  /** Where effects originate (eye for casts, impact point for on-hit steps). */
  origin: Vec3;
  /** Normalized aim direction. */
  dir: Vec3;
  /** Resolved aim/ground point. */
  point: Vec3;
  target?: ServerEntity;
  /** Effective skill level of the caster for this ability's skill. */
  level: number;
  /** Damage/heal multiplier from skill level. */
  power: number;
  /** 0..1 (charged abilities; 1 otherwise). */
  charge: number;
  /** Set when steps run inside a zone (area radius 0 = the zone's own shape). */
  zone?: ZoneShape;
  /**
   * Ranged single-target attack that was checked at cast time (in range, in sight): its
   * projectiles fly to this target and its beams land on it — no ballistics, no misses.
   */
  guaranteed?: ServerEntity;
}

interface PendingCast {
  cx: CastCtx;
  at: number;
}

export type UseResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Aimed abilities that hit one creature at range (projectiles or beams): certain hits, see CastCtx.guaranteed. */
const rangedSingle = (def: AbilityDef) => def.targeting === 'aim' && !!def.ops?.some((o) => o.op === 'projectile' || o.op === 'beam');

export class AbilityRunner {
  private casts = new Map<EntityId, PendingCast>();
  /** Hold-to-charge abilities started without an explicit charge (press → release). */
  private charging = new Map<EntityId, { use: AbilityUse; t0: number }>();

  constructor(private g: GameplaySystem) {}

  // ------------------------------------------------------------------ cooldowns

  cooldownMap(e: ServerEntity): Record<string, number> {
    if (e.kind === 'player') {
      const pd = getPlayerData(this.g.ctx, e.id);
      if (pd) return pd.cooldowns;
    }
    return this.g.runtime(e).cooldowns;
  }

  readyIn(e: ServerEntity, id: string): number {
    return Math.max(0, (this.cooldownMap(e)[id] ?? 0) - this.g.ctx.time.now);
  }

  setCooldown(e: ServerEntity, id: string, seconds: number) {
    const m = this.cooldownMap(e);
    if (seconds <= 0) delete m[id];
    else m[id] = this.g.ctx.time.now + seconds;
    // Drop stale entries so the replicated map stays small.
    const now = this.g.ctx.time.now;
    for (const k in m) if (m[k] < now) delete m[k];
    if (e.kind === 'player') this.g.ctx.markPlayerDirty(e.id, 'cooldowns');
  }

  isCasting(e: ServerEntity): boolean {
    return this.casts.has(e.id);
  }

  // ------------------------------------------------------------------ use

  /**
   * Try to use an ability. `fromClient` enforces unlocks (AI casters may use
   * any ability, e.g. a fire elemental casting fireball without skills).
   */
  use(caster: ServerEntity, use: AbilityUse, fromClient = false): UseResult {
    const g = this.g, ctx = g.ctx;
    const def = abilityDef(use.ability);
    if (!def) return fail('Unknown ability.');
    if (def.targeting === 'passive') return fail(`${def.name} is passive.`);
    if (!caster.alive) return fail('You are dead.');
    if (fromClient && !caster.skills?.abilities.includes(def.id)) return fail(`You have not learned ${def.name}.`);
    for (const x of caster.effects) {
      const d = effectDef(x.id);
      if (d?.incapacitate) return fail('You cannot act right now.');
      if (d?.silence && def.kind === 'magic') return fail('You are silenced.');
    }
    // Toggles switch off for free.
    if (def.toggle && caster.skills?.toggles?.includes(def.id)) {
      this.toggleOff(caster, def.id);
      return { ok: true };
    }
    if (this.casts.has(caster.id)) return fail('Already casting.');
    // Press without a charge value: start drawing; the release fires it.
    if (def.chargeTime && use.charge === undefined && fromClient) {
      if (this.readyIn(caster, def.id) > 0.05) return fail(`${def.name} is not ready.`);
      const req0 = this.checkRequirements(caster, def);
      if (req0) return fail(req0);
      this.charging.set(caster.id, { use: { ...use }, t0: ctx.time.now });
      caster.anim = { ...caster.anim, action: { id: def.anim, t0: ctx.time.now, dur: def.chargeTime * 3, aim: isVec3(use.dir) ? use.dir : undefined } };
      caster.dirty = true;
      return { ok: true };
    }
    const wait = this.readyIn(caster, def.id);
    if (wait > 0.05) return fail(`${def.name} is ready in ${wait.toFixed(1)}s.`);
    const req = this.checkRequirements(caster, def);
    if (req) return fail(req);

    const level = effectiveLevel(caster.skills, caster.stats, def.skill);
    const cost = effectiveCost(def, level);
    if (caster.stamina < cost.stamina - 0.01) return fail('Not enough stamina.');
    if (caster.mana < cost.mana - 0.01) return fail('Not enough mana.');
    if (cost.hp && caster.hp <= cost.hp + 1) return fail('Too wounded.');

    const cx = this.resolve(caster, def, use, level);
    if ('reason' in cx) return cx;

    // Pay up front so cast-time abilities can't be spammed.
    caster.stamina -= cost.stamina;
    caster.mana -= cost.mana;
    if (cost.hp) caster.hp -= cost.hp;
    if (cost.stamina > 0) g.runtime(caster).staminaUsedAt = ctx.time.now;
    this.setCooldown(caster, def.id, effectiveCooldown(def, level));
    if (caster.kind === 'player') ctx.markPlayerDirty(caster.id, 'vitals');
    if (caster.kind !== 'player' && cx.target) caster.target = cx.target.id;
    caster.yaw = dirYaw(cx.dir);

    const castTime = def.castTime / (1 + (caster.stats?.castSpeed ?? 0));
    this.animate(caster, def, cx, castTime);
    if (castTime > 0.05) {
      this.casts.set(caster.id, { cx, at: ctx.time.now + castTime });
      ctx.broadcast({ type: 'fx', fx: 'cast', pos: [...caster.pos] as Vec3, target: caster.id, color: def.color, duration: castTime, radius: def.kind === 'magic' ? 1.2 : 0.6 }, caster.pos);
    } else this.execute(cx, cost);
    return { ok: true };
  }

  /** Release of a held ability: fires charged abilities, ends channels. */
  release(caster: ServerEntity, id: string) {
    const def = abilityDef(id);
    const ch = this.charging.get(caster.id);
    if (ch && ch.use.ability === id && def?.chargeTime) {
      this.charging.delete(caster.id);
      const charge = Math.max(0.15, Math.min(1, (this.g.ctx.time.now - ch.t0) / def.chargeTime));
      // Aim with the latest look direction the client reported.
      const look = caster.anim.lookAt;
      const use: AbilityUse = { ...ch.use, charge };
      if (isVec3(look)) {
        use.dir = vnorm(vsub(look, eyeOf(caster)), use.dir ?? yawDir(caster.yaw));
        use.point = undefined;
      }
      const r = this.use(caster, use, true);
      if (!r.ok) this.g.notify(caster, r.reason, 'warn');
      return;
    }
    if (def?.channel && caster.skills?.toggles?.includes(id)) this.toggleOff(caster, id);
  }

  private checkRequirements(caster: ServerEntity, def: AbilityDef): string | null {
    const r = def.requires;
    if (!r) return null;
    if (r.weaponSkill) {
      const w = this.g.melee.weaponOf(caster);
      if (!r.weaponSkill.includes(w.skill)) return `${def.name} needs a ${r.weaponSkill.join(' or ')} weapon.`;
      if (w.skill === 'archery' && !this.g.melee.hasAmmo(caster)) return 'No arrows.';
    }
    if (r.shield && !this.g.melee.hasShield(caster)) return `${def.name} needs a shield.`;
    if (r.tool) {
      const items = this.g.ctx.services.items;
      const has = Object.values(caster.equipment ?? {}).some((it) => it && items.def(it.defId)?.tool?.kind === r.tool);
      if (!has) return `${def.name} needs a ${r.tool}.`;
    }
    if (r.grounded && !caster.grounded) return 'You need firm ground.';
    return null;
  }

  /** Resolve aim direction, point and target. */
  private resolve(caster: ServerEntity, def: AbilityDef, use: AbilityUse, level: number): CastCtx | { ok: false; reason: string } {
    const ctx = this.g.ctx;
    const origin = eyeOf(caster);
    let dir = isVec3(use.dir) ? vnorm(use.dir, yawDir(caster.yaw)) : undefined;
    if (!dir && isVec3(use.point)) dir = vnorm(vsub(use.point, origin), yawDir(caster.yaw));
    dir ??= yawDir(caster.yaw);
    const range = Math.max(def.range, 1);
    let point: Vec3 = isVec3(use.point) ? [...use.point] as Vec3 : vadd(origin, dir, range);
    if (vdist(point, origin) > range + 1.5) point = vadd(origin, vnorm(vsub(point, origin)), range);
    let target = use.target !== undefined ? ctx.entities.get(use.target) : undefined;
    if (target && (!target.alive || capsuleDist(origin, target) > range + 2.5)) target = undefined;
    // Tab target (lock): validated like a basic attack's (alive, in range, in sight); a support
    // ability never lands on a locked enemy — it falls back to the caster instead.
    const support = def.tags.includes('heal') || def.role === 'utility';
    const locked = use.lock && target ? this.g.melee.lockedTarget(caster, target.id, range + 2.5) : undefined;
    if (locked && support && def.targeting === 'entity' && this.g.isHostile(caster, locked)) target = caster;
    const charge = def.chargeTime ? Math.max(0.15, Math.min(1, Number(use.charge ?? 1) || 0)) : 1;
    const cx: CastCtx = { caster, def, use, origin, dir, point, target, level, power: abilityPower(def, level), charge };

    switch (def.targeting) {
      case 'self':
      case 'aura':
        cx.target = caster;
        cx.point = [...caster.pos] as Vec3;
        break;
      case 'entity': {
        if (!target || !isCombatant(target)) target = this.pick(caster, origin, dir, range, def);
        if (!target && support) target = caster;
        if (!target) return fail('No target.');
        const need = def.requires?.target;
        if (need === 'creature' && target.kind !== 'creature') return fail(`${def.name} only works on creatures.`);
        if (need === 'npc' && target.kind !== 'npc') return fail(`${def.name} only works on people.`);
        if (target !== caster) {
          const c = chestOf(target);
          const d = vsub(c, origin);
          const dist = vlen(d);
          const hit = ctx.terrain.raycast(origin[0], origin[1], origin[2], d[0] / dist, d[1] / dist, d[2] / dist, dist);
          if (hit && hit.dist < dist - 0.6) return fail('No line of sight.');
          cx.dir = vnorm(d);
        }
        cx.target = target;
        cx.point = chestOf(target);
        break;
      }
      case 'ground': {
        // A locked target puts the area at its feet; otherwise clip to terrain along the aim ray.
        if (locked) {
          point = [...locked.pos] as Vec3;
          cx.dir = vnorm(vsub(chestOf(locked), origin), dir);
        }
        const d = vsub(point, origin);
        const dist = vlen(d);
        if (dist > 0.01) {
          const hit = ctx.terrain.raycast(origin[0], origin[1], origin[2], d[0] / dist, d[1] / dist, d[2] / dist, dist);
          if (hit) point = [hit.x, hit.y, hit.z];
        }
        let gy = ctx.groundAt(point[0], point[1] + 1.5, point[2], 6);
        if (Number.isNaN(gy)) gy = ctx.groundAt(point[0], point[1], point[2], 60);
        if (Number.isNaN(gy)) return fail('No ground there.');
        cx.point = [point[0], gy, point[2]];
        break;
      }
      default:
        // Ranged single-target attacks with a tab target: decided once, here. If it cannot hit,
        // a message and nothing is spent; otherwise the hit is certain (see CastCtx.guaranteed).
        if (rangedSingle(def) && use.lock && use.target !== undefined) {
          const t = ctx.entities.get(use.target);
          const why = t ? this.g.melee.rangedBlocker(caster, t, range + 0.5) : 'Target lost.';
          if (why || !t) return fail(why ?? 'Target lost.');
          cx.target = t;
          cx.guaranteed = t;
          cx.point = chestOf(t);
          cx.dir = vnorm(vsub(cx.point, origin), dir);
          break;
        }
        cx.point = point;
        // Crosshair aim: the client's direction is the camera's, which sits behind and above
        // the shoulder; cast along it from the eye and the line runs parallel but offset —
        // small targets (critters) were missed. Aim from the eye at the crosshair point.
        if (!locked && isVec3(use.point) && vdist(use.point, origin) > 1) cx.dir = vnorm(vsub(use.point, origin), dir);
        if (locked) {
          // Aimed at the tab target: projectiles lead it (see ProjectileSim), cones and strikes face it.
          cx.point = chestOf(locked);
          cx.dir = vnorm(vsub(cx.point, origin), dir);
          cx.target = locked;
        } else if (!target && (def.targeting === 'aim' || def.targeting === 'cone')) cx.target = this.pick(caster, origin, cx.dir, Math.min(range, 40), def, 0.12);
        // Crosshair on a creature that can be hit from here: the same certain hit as a tab target.
        if (!locked && rangedSingle(def) && cx.target && cx.target !== caster && !this.g.melee.rangedBlocker(caster, cx.target, range + 0.5)) {
          cx.guaranteed = cx.target;
          cx.point = chestOf(cx.target);
          cx.dir = vnorm(vsub(cx.point, origin), cx.dir);
        }
    }
    return cx;
  }

  /** Entity closest to the aim ray within `range` (angular tolerance `tol` radians). */
  pick(caster: ServerEntity, origin: Vec3, dir: Vec3, range: number, def?: AbilityDef, tol = 0.2): ServerEntity | undefined {
    const ctx = this.g.ctx;
    const mid = vadd(origin, dir, range / 2);
    let best: ServerEntity | undefined, bestScore = Infinity;
    const support = def && (def.tags.includes('heal') || def.role === 'utility' || def.role === 'social');
    for (const e of ctx.entities.near(mid, range / 2 + 3)) {
      if (e === caster || !isCombatant(e)) continue;
      if (!support && this.g.isAlly(caster, e) && e.kind !== 'npc' && e.kind !== 'creature') continue;
      const c = chestOf(e);
      const to = vsub(c, origin);
      const t = vdot(to, dir);
      if (t < 0 || t > range + e.radius) continue;
      const perp = vlen(vsub(to, [dir[0] * t, dir[1] * t, dir[2] * t]));
      const allowed = Math.max(e.radius * e.scale + 0.4, t * tol);
      if (perp > allowed) continue;
      const score = perp / allowed + t / range;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  private animate(caster: ServerEntity, def: AbilityDef, cx: CastCtx, castTime: number) {
    if (!def.anim) return;
    let dur = def.animDur ?? (def.kind === 'magic' ? 0.55 : 0.5);
    for (const o of def.ops ?? []) if (o.op === 'strike' && o.delay) dur = Math.max(dur, o.delay + 0.3);
    caster.anim = { ...caster.anim, action: { id: def.anim, t0: this.g.ctx.time.now, dur: castTime + dur, aim: cx.dir } };
    caster.dirty = true;
  }

  // ------------------------------------------------------------------ execute

  private execute(cx: CastCtx, cost: { stamina: number; mana: number; hp: number }) {
    const g = this.g, ctx = g.ctx;
    const { caster, def } = cx;
    if (!caster.alive) return;
    if (def.role === 'combat') g.effects.onAction(caster);
    const ok = g.ops.run(cx, def.ops ?? [], def.toggle ? def.id : undefined);
    if (!ok) {
      // A special step could not do anything (no food, nothing to repair...): refund.
      caster.stamina = Math.min(caster.stats?.maxStamina ?? 100, caster.stamina + cost.stamina);
      caster.mana = Math.min(caster.stats?.maxMana ?? 100, caster.mana + cost.mana);
      this.setCooldown(caster, def.id, 0);
      if (caster.anim.action?.id === def.anim) {
        caster.anim = { ...caster.anim, action: undefined };
        caster.dirty = true;
      }
      return;
    }
    if (def.toggle && caster.skills) {
      const t = (caster.skills.toggles ??= []);
      if (!t.includes(def.id)) t.push(def.id);
      if (caster.kind === 'player') ctx.markPlayerDirty(caster.id, 'skills');
    }
    // Use-based XP: proportional to effort, a little extra for higher tiers.
    const xp = 2 + (cost.mana + cost.stamina) / 8 + (def.unlockLevel ?? 0) * 0.03;
    g.grantXp(caster, def.skill, xp);
    ctx.bus.emit('abilityUsed', { caster, ability: def.id, target: cx.target, point: cx.point });
  }

  tick(_dt: number) {
    const now = this.g.ctx.time.now;
    // Over-held charges fire on their own.
    for (const [id, ch] of this.charging) {
      const def = abilityDef(ch.use.ability);
      const e = this.g.ctx.entities.get(id);
      if (!def || !e || !e.alive) this.charging.delete(id);
      else if (now - ch.t0 > (def.chargeTime ?? 1) * 3) this.release(e, def.id);
    }
    if (!this.casts.size) return;
    for (const [id, c] of this.casts) {
      if (now < c.at) continue;
      this.casts.delete(id);
      const cx = c.cx;
      if (!cx.caster.alive) continue;
      // Re-validate the target (it may have died or left during the cast).
      if (cx.target && cx.target !== cx.caster && !cx.target.alive && cx.def.targeting === 'entity') continue;
      if (cx.target && cx.target !== cx.caster && cx.def.targeting === 'entity') cx.point = chestOf(cx.target);
      const level = cx.level;
      this.execute(cx, effectiveCost(cx.def, level));
    }
  }

  /** Interrupt casting (stun, death, silence). */
  cancel(e: ServerEntity, magicOnly = false) {
    const c = this.casts.get(e.id);
    if (c && (!magicOnly || c.cx.def.kind === 'magic')) {
      this.casts.delete(e.id);
      this.g.ctx.broadcast({ type: 'fx', fx: 'fizzle', pos: chestOf(e), target: e.id, color: c.cx.def.color }, e.pos);
      if (e.anim.action) {
        e.anim = { ...e.anim, action: undefined };
        e.dirty = true;
      }
    }
    if (!magicOnly && e.skills?.toggles?.length) for (const t of [...e.skills.toggles]) this.toggleOff(e, t);
    else if (magicOnly && e.skills?.toggles?.length)
      for (const t of [...e.skills.toggles]) if (abilityDef(t)?.kind === 'magic') this.toggleOff(e, t);
  }

  /** Heavy hits interrupt spell casting. */
  onDamaged(e: ServerEntity, amount: number) {
    const c = this.casts.get(e.id);
    if (c && amount > e.maxHp * 0.18 && c.cx.def.kind === 'magic') this.cancel(e, true);
  }

  // ------------------------------------------------------------------ toggles

  payUpkeep(e: ServerEntity, abilityId: string, dt: number): boolean {
    const up = abilityDef(abilityId)?.upkeep;
    if (!up) return true;
    const level = effectiveLevel(e.skills, e.stats, abilityDef(abilityId)!.skill);
    const k = Math.max(0.5, 1 - level * 0.005);
    const m = (up.mana ?? 0) * k * dt, s = (up.stamina ?? 0) * k * dt;
    if (e.mana < m || e.stamina < s) return false;
    e.mana -= m;
    e.stamina -= s;
    if (s > 0) this.g.runtime(e).staminaUsedAt = this.g.ctx.time.now;
    return true;
  }

  toggleOff(e: ServerEntity, abilityId: string) {
    let removed = false;
    for (let i = e.effects.length - 1; i >= 0; i--)
      if (e.effects[i].ability === abilityId && e.effects[i].until === Infinity) {
        e.effects.splice(i, 1);
        removed = true;
      }
    this.onToggleEffectGone(e, abilityId);
    if (removed) this.g.effects.changed(e);
  }

  /** Bookkeeping when a toggle's effect disappears (expired, dispelled, broken). */
  onToggleEffectGone(e: ServerEntity, abilityId: string) {
    const t = e.skills?.toggles;
    if (!t) return;
    const i = t.indexOf(abilityId);
    if (i < 0) return;
    t.splice(i, 1);
    const def = abilityDef(abilityId);
    if (def) this.setCooldown(e, abilityId, Math.min(def.cooldown, 3));
    if (e.kind === 'player') this.g.ctx.markPlayerDirty(e.id, 'skills');
  }

  forget(id: EntityId) {
    this.casts.delete(id);
    this.charging.delete(id);
  }
}
