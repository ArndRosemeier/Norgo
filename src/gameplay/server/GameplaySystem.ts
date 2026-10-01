/**
 * Gameplay server system: combat, skills, abilities, effects, stats,
 * projectiles, area spells, gravity fields and terrain shaping.
 *
 * It implements `CombatService` + `SkillService` (ctx.services.combat/skills)
 * and owns the client messages `ability`, `abilityRelease`, `attack`, `block`
 * and `dig`. Work is split into focused modules that all hang off this class:
 *
 *   progression.ts  use-based XP, level ups, unlocks, hotbar, movement XP
 *   effects.ts      status effects: apply/tick/expire, flags, auras, toggles
 *   abilities.ts    ability validation, costs, cooldowns, cast times, toggles
 *   ops.ts          the ability recipe interpreter (AbilityOp)
 *   melee.ts        basic attacks, strikes, blocking & parrying
 *   projectiles.ts  projectile entities with gravity & terrain collision
 *   zones.ts        persistent area spells ("effect" entities), gravity fields
 *   mover.ts        knockback/displacement of non-player entities
 *   terrainOps.ts   digging and terrain-shaping spells (+ material yields)
 *   specials.ts     hand-written ability behaviours (tame, pick lock...)
 *
 * Other systems use the exported helpers in ./api.ts (useAbility,
 * effectiveGravity, isIncapacitated, skillCheck...).
 */
import type { CombatService, ServerContext, ServerSystem, SkillService } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage, GameEvent } from '../../shared/protocol';
import type { DamageType, EntityId, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { Stats } from '../types';
import { Rng } from '../../core/rng';
import { mitigate } from '../shared/combat';
import { PHYSICAL_TYPES } from '../shared/stats';
import { hasEffect } from '../shared/checks';
import { Progression } from './progression';
import { EffectEngine } from './effects';
import { AbilityRunner } from './abilities';
import { OpRunner } from './ops';
import { MeleeSim } from './melee';
import { ProjectileSim } from './projectiles';
import { ZoneSim, GravityFields } from './zones';
import { Mover } from './mover';
import { TerrainOps } from './terrainOps';
import { Specials } from './specials';
import { chestOf, hnorm, isCombatant, masterOf, vsub, yawDir, vdot } from './util';

/** Per-entity runtime state private to the gameplay module. */
export interface Runtime {
  /** Cooldowns for entities without PlayerData (NPCs, creatures). */
  cooldowns: Record<string, number>;
  /** Hostility memory: entity id → server time until which we fight each other. */
  aggro: Map<EntityId, number>;
  combatUntil: number;
  staminaUsedAt: number;
  /** Accumulator for 2 Hz effect ticking. */
  effectAcc: number;
  /** EntFlag bits currently set by effects (so we never clear other systems' bits). */
  effFlags: number;
  fxKey: string;
  ownLight: boolean;
  /** Base stats override for non-player entities (captured or set via setBaseStats). */
  base?: Partial<Stats>;
  blockSince?: number;
  nextAttackAt: number;
  combo: number;
  /** NPC ids this entity attacked while they were not hostile (crime tracking). */
  assaulted?: Set<EntityId>;
  lastNotify: number;
  lastNotifyText: string;
  nextDigAt: number;
  /** Last synced vitals hash (players). */
  vitalsKey: number;
  vitalsAt: number;
}

const FLAG_INCOMBAT = EntFlag.InCombat;

export class GameplaySystem implements ServerSystem, CombatService, SkillService {
  readonly name = 'gameplay';
  ctx!: ServerContext;
  rng!: Rng;
  readonly rt = new Map<EntityId, Runtime>();
  progression!: Progression;
  effects!: EffectEngine;
  abilities!: AbilityRunner;
  ops!: OpRunner;
  melee!: MeleeSim;
  projectiles!: ProjectileSim;
  zones!: ZoneSim;
  fields!: GravityFields;
  mover!: Mover;
  terrainOps!: TerrainOps;
  specials!: Specials;
  /** Custom faction relations (`a|b` → hostile?), see setFactionRelation. */
  readonly factionRel = new Map<string, boolean>();

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.rng = ctx.rng('gameplay', 'combat');
    this.progression = new Progression(this);
    this.effects = new EffectEngine(this);
    this.abilities = new AbilityRunner(this);
    this.ops = new OpRunner(this);
    this.melee = new MeleeSim(this);
    this.projectiles = new ProjectileSim(this);
    this.zones = new ZoneSim(this);
    this.fields = new GravityFields(this);
    this.mover = new Mover(this);
    this.terrainOps = new TerrainOps(this);
    this.specials = new Specials(this);
    // Default faction politics; other systems may add more via setFactionRelation.
    for (const f of ['player', 'neutral', 'guard', 'villager', 'merchant', 'wild'])
      this.factionRel.set(this.relKey('hostile', f), true);
    for (const f of ['player', 'neutral', 'guard', 'villager', 'merchant']) this.factionRel.set(this.relKey('bandit', f), true);
    this.factionRel.set(this.relKey('bandit', 'hostile'), false);
    this.factionRel.set(this.relKey('undead', 'player'), true);
    this.factionRel.set(this.relKey('undead', 'guard'), true);
    this.factionRel.set(this.relKey('undead', 'villager'), true);
    this.progression.listen();
  }

  // ------------------------------------------------------------------ runtime

  runtime(e: ServerEntity | EntityId): Runtime {
    const id = typeof e === 'number' ? e : e.id;
    let r = this.rt.get(id);
    if (!r) {
      r = {
        cooldowns: {}, aggro: new Map(), combatUntil: 0, staminaUsedAt: 0, effectAcc: 0, effFlags: 0, fxKey: '', ownLight: false,
        nextAttackAt: 0, combo: 0, lastNotify: 0, lastNotifyText: '', nextDigAt: 0, vitalsKey: 0, vitalsAt: 0,
      };
      this.rt.set(id, r);
    }
    return r;
  }

  /** Personal events (xp, unlock, notify, pings) go only to that player. */
  sendEvents(player: ServerEntity, events: GameEvent[]) {
    if (player.kind === 'player' && events.length) this.ctx.send(player.id, { t: 'events', events });
  }

  /** Throttled personal notification (avoids spamming "Not enough mana"). */
  notify(player: ServerEntity, text: string, tone: 'info' | 'good' | 'bad' | 'warn' = 'info') {
    if (player.kind !== 'player') return;
    const r = this.runtime(player);
    const now = this.ctx.time.now;
    if (text === r.lastNotifyText && now - r.lastNotify < 1.5) return;
    r.lastNotify = now;
    r.lastNotifyText = text;
    this.sendEvents(player, [{ type: 'notify', text, tone }]);
  }

  enterCombat(e: ServerEntity) {
    this.runtime(e).combatUntil = this.ctx.time.now + 6;
    if (!(e.flags & FLAG_INCOMBAT)) {
      e.flags |= FLAG_INCOMBAT;
      e.dirty = true;
    }
  }

  // ------------------------------------------------------------------ hostility

  private relKey(a: string, b: string) {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  /** Declare two factions hostile (or not). Symmetric. */
  setFactionRelation(a: string, b: string, hostile: boolean) {
    this.factionRel.set(this.relKey(a, b), hostile);
  }

  /** Mutual aggression for `seconds` (fights, provocation, failed pickpocketing). */
  addAggro(a: ServerEntity, b: ServerEntity, seconds = 30) {
    const until = this.ctx.time.now + seconds;
    const ma = this.ctx.entities.get(masterOf(a)) ?? a, mb = this.ctx.entities.get(masterOf(b)) ?? b;
    if (ma === mb) return;
    this.runtime(ma).aggro.set(mb.id, until);
    this.runtime(mb).aggro.set(ma.id, until);
  }

  clearAggro(a: ServerEntity, b: ServerEntity) {
    this.rt.get(a.id)?.aggro.delete(b.id);
    this.rt.get(b.id)?.aggro.delete(a.id);
  }

  isHostile(a: ServerEntity, b: ServerEntity): boolean {
    if (a === b || !a.alive || !b.alive) return false;
    const ents = this.ctx.entities;
    const ma = ents.get(masterOf(a)) ?? a, mb = ents.get(masterOf(b)) ?? b;
    if (ma === mb) return false;
    const now = this.ctx.time.now;
    const ra = this.rt.get(ma.id), rb = this.rt.get(mb.id);
    if ((ra?.aggro.get(mb.id) ?? 0) > now || (rb?.aggro.get(ma.id) ?? 0) > now) return true;
    // Charm and calm suppress default hostility (but not active aggression above).
    for (const x of a.effects) if ((x.id === 'charmed' && x.source === mb.id) || x.id === 'calmed') return false;
    for (const x of b.effects) if ((x.id === 'charmed' && x.source === ma.id) || x.id === 'calmed') return false;
    if (ma.faction === mb.faction) return false;
    const rel = this.factionRel.get(this.relKey(ma.faction, mb.faction));
    if (rel !== undefined) return rel;
    return ma.faction === 'hostile' || mb.faction === 'hostile';
  }

  /** Friendly for support spells: same faction, own pets/master, fellow players. */
  isAlly(a: ServerEntity, b: ServerEntity): boolean {
    if (a === b) return true;
    if (this.isHostile(a, b)) return false;
    const ma = masterOf(a) ?? a.id, mb = masterOf(b) ?? b.id;
    if (ma === mb) return true;
    const ea = this.ctx.entities.get(ma) ?? a, eb = this.ctx.entities.get(mb) ?? b;
    return ea.faction === eb.faction;
  }

  // ------------------------------------------------------------------ CombatService

  damage(
    target: ServerEntity, amount: number, type: DamageType, source?: ServerEntity,
    opts?: { ability?: string; pos?: Vec3; crit?: boolean; knockback?: number; melee?: boolean; ranged?: boolean; dot?: boolean; noBlock?: boolean; silent?: boolean },
  ): number {
    const ctx = this.ctx;
    if (!target.alive || !(amount > 0) || !Number.isFinite(amount)) return 0;
    if (!isCombatant(target)) return 0;
    const now = ctx.time.now;
    const stats = target.stats;
    const hitPos = opts?.pos ?? chestOf(target);
    const tr = this.runtime(target);
    const attack = !!(opts?.melee || opts?.ranged);

    // Aggression & crimes (players attacking peaceful folk).
    if (source && source !== target && source.alive && !opts?.dot) {
      const wasHostile = this.isHostile(source, target);
      const srcMaster = this.ctx.entities.get(masterOf(source)) ?? source;
      if (!wasHostile && srcMaster.kind === 'player' && target.kind === 'npc') {
        const sr = this.runtime(srcMaster);
        (sr.assaulted ??= new Set()).add(target.id);
        ctx.bus.emit('crime', { offender: srcMaster, victim: target, kind: 'assault', pos: [...target.pos] as Vec3 });
      }
      this.addAggro(source, target);
      this.enterCombat(source);
    }
    this.enterCombat(target);

    if (type === 'fall') {
      amount *= 1 - (stats?.fallResist ?? 0);
      if (hasEffect(target, 'featherfall') || hasEffect(target, 'levitate')) amount = 0;
      if (target.kind === 'player') this.grantXp(target, 'acrobatics', Math.min(8, 1 + amount * 0.2));
      if (amount <= 0.5) return 0;
    }

    // Dodge (melee & projectiles only).
    if (attack && stats?.dodge && this.rng.float() < stats.dodge) {
      ctx.broadcast({ type: 'fx', fx: 'dodge', pos: hitPos, target: target.id }, target.pos);
      if (target.kind === 'player') this.grantXp(target, hasEffect(target, 'phase') ? 'acrobatics' : 'light_armor', 2);
      return 0;
    }

    // Blocking & parrying.
    if (attack && source && !opts?.noBlock && tr.blockSince !== undefined && target.alive) {
      const fwd = yawDir(target.yaw);
      const toSrc = hnorm(vsub(source.pos, target.pos));
      if (vdot(fwd, toSrc) > 0.34) {
        const parry = now - tr.blockSince < 0.3 || hasEffect(target, 'parry');
        if (parry) {
          ctx.broadcast({ type: 'fx', fx: 'parry', pos: hitPos, target: target.id }, target.pos);
          ctx.broadcast({ type: 'sound', sound: 'parry', pos: hitPos }, target.pos);
          if (opts?.melee) this.applyEffect(source, 'staggered', 1, 1.5, target);
          this.applyEffect(target, 'riposte', 1, 2.5, target);
          this.effects.remove(target, 'parry');
          if (target.kind === 'player') this.grantXp(target, target.equipment?.offhand ? 'shields' : 'blades', 6);
          return 0;
        }
        const block = Math.max(stats?.block ?? 0, target.equipment?.offhand ? 0.45 : 0.3);
        const magic = !PHYSICAL_TYPES.has(type) && type !== 'force';
        const stopped = amount * block * (magic ? 0.4 : 1);
        amount -= stopped;
        target.stamina = Math.max(0, target.stamina - stopped * 0.7);
        tr.staminaUsedAt = now;
        ctx.broadcast({ type: 'fx', fx: 'block', pos: hitPos, target: target.id }, target.pos);
        if (target.kind === 'player') this.grantXp(target, target.equipment?.offhand ? 'shields' : 'blades', 2);
        if (target.stamina <= 0) {
          // Guard broken.
          this.melee.setBlocking(target, false);
          this.applyEffect(target, 'staggered', 1, 2, source);
        }
      }
    }

    amount = mitigate(amount, type, stats);
    const vuln = this.effects.magnitude(target, 'vulnerable');
    if (vuln) amount *= 1 + vuln;
    let crit = !!opts?.crit;
    if (!crit && source?.stats && !opts?.dot && type !== 'fall' && this.rng.float() < (source.stats.critChance ?? 0)) crit = true;
    if (crit) amount *= source?.stats?.critMult ?? 1.6;

    // Absorb shields.
    const shield = target.effects.find((x) => x.id === 'force_shield');
    if (shield && amount > 0) {
      const absorbed = Math.min(shield.magnitude, amount);
      shield.magnitude -= absorbed;
      amount -= absorbed;
      if (shield.magnitude <= 0.5) this.effects.remove(target, 'force_shield');
      else this.effects.changed(target);
      ctx.broadcast({ type: 'fx', fx: 'shield_hit', pos: hitPos, target: target.id }, target.pos);
    }
    if (amount <= 0) return 0;

    target.hp -= amount;
    if (source && source !== target) target.lastAttacker = source.id;
    target.dirty = true;
    this.effects.onDamaged(target, amount);
    this.abilities.onDamaged(target, amount);

    // Retaliation auras on melee attackers.
    if (opts?.melee && source && source !== target && source.alive) {
      if (hasEffect(target, 'thorns') || this.melee.grantsOf(target).has('ench.thorns')) this.damage(source, 4 + amount * 0.25, 'pierce', target, { dot: true });
      if (hasEffect(target, 'flame_cloak')) this.applyEffect(source, 'burning', 4, 3, target);
      if (hasEffect(target, 'frost_armor')) this.applyEffect(source, 'chilled', 1, 3, target);
    }

    // Armor training: getting hit while armored.
    if (target.kind === 'player' && !opts?.dot && type !== 'fall') this.progression.armorHit(target, amount);

    if (!opts?.silent)
      ctx.broadcast({ type: 'damage', target: target.id, source: source?.id, amount, dtype: type, crit: crit || undefined, pos: hitPos }, target.pos);
    ctx.bus.emit('damage', { target, source, amount, type, ability: opts?.ability });
    if (target.kind === 'player') ctx.markPlayerDirty(target.id, 'vitals');

    if (opts?.knockback && target.alive) {
      const from = source && source !== target ? source.pos : opts.pos ?? target.pos;
      const d = hnorm(vsub(target.pos, from), yawDir(target.yaw + Math.PI));
      const k = opts.knockback * (crit ? 1.3 : 1);
      this.knockback(target, [d[0] * k, Math.min(6, k * 0.35 + 1), d[2] * k]);
    }
    if (target.hp <= 0) this.kill(target, source);
    return amount;
  }

  heal(target: ServerEntity, amount: number, source?: ServerEntity): number {
    if (!target.alive || !(amount > 0)) return 0;
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + amount);
    const healed = target.hp - before;
    if (healed > 0.05) {
      target.dirty = true;
      this.ctx.broadcast({ type: 'heal', target: target.id, amount: healed, pos: chestOf(target) }, target.pos);
      this.ctx.bus.emit('heal', { target, source, amount: healed });
      if (target.kind === 'player') this.ctx.markPlayerDirty(target.id, 'vitals');
    }
    return healed;
  }

  kill(target: ServerEntity, killer?: ServerEntity) {
    if (!target.alive) return;
    const ctx = this.ctx;
    target.alive = false;
    target.hp = 0;
    target.diedAt = ctx.time.now;
    target.anim = { move: 'dead', action: { id: 'die', t0: ctx.time.now, dur: 1.5 } };
    target.dirty = true;
    this.abilities.cancel(target);
    this.melee.setBlocking(target, false);
    this.effects.clearAll(target);
    this.zones.removeOwnedFollowers(target.id);
    const km = killer ? ctx.entities.get(masterOf(killer)) ?? killer : undefined;
    if (km?.kind === 'player' && target.kind === 'npc' && this.rt.get(km.id)?.assaulted?.has(target.id))
      ctx.bus.emit('crime', { offender: km, victim: target, kind: 'murder', pos: [...target.pos] as Vec3 });
    ctx.broadcast({ type: 'death', target: target.id, killer: killer?.id }, target.pos);
    ctx.bus.emit('death', { entity: target, killer });
    if (target.kind === 'player') {
      ctx.markPlayerDirty(target.id, 'vitals', 'effects', 'skills');
      ctx.bus.emit('playerDied', { player: target, killer });
    }
    // Illusions (decoys) simply pop.
    if (target.kind === 'effect') ctx.despawn(target.id);
  }

  applyEffect(target: ServerEntity, effectId: string, magnitude: number, duration: number, source?: ServerEntity) {
    this.effects.apply(target, effectId, magnitude, duration, source);
  }

  knockback(target: ServerEntity, impulse: Vec3) {
    if (!target.alive && target.kind !== 'item') return;
    if (hasEffect(target, 'unstoppable') || target.tags.has('immovable')) return;
    // Heavier bodies move less (70 kg human = 1).
    const k = Math.min(2.5, Math.max(0.15, Math.sqrt(70 / Math.max(1, target.mass))));
    const imp: Vec3 = [impulse[0] * k, impulse[1] * k, impulse[2] * k];
    if (target.kind === 'player') this.ctx.broadcast({ type: 'knockback', target: target.id, impulse: imp }, target.pos);
    else this.mover.push(target, imp);
  }

  // ------------------------------------------------------------------ SkillService

  grantXp(entity: ServerEntity, skill: string, amount: number) {
    this.progression.grantXp(entity, skill, amount);
  }

  level(entity: ServerEntity, skill: string) {
    return entity.skills?.skills[skill]?.level ?? 0;
  }

  recomputeStats(e: ServerEntity) {
    this.effects.recompute(e);
  }

  initSkills(e: ServerEntity) {
    this.progression.initSkills(e);
  }

  /** Base stats for a non-player entity (creatures/NPC templates). Recomputes. */
  setBaseStats(e: ServerEntity, base: Partial<Stats>) {
    this.runtime(e).base = { ...base };
    this.effects.recompute(e);
    if (base.maxHp) e.hp = Math.min(e.hp, e.maxHp);
  }

  // ------------------------------------------------------------------ system hooks

  onMessage(p: ServerEntity, msg: ClientMessage): boolean {
    switch (msg.t) {
      case 'ability':
        if (msg.use && typeof msg.use.ability === 'string') {
          const r = this.abilities.use(p, msg.use, true);
          if (!r.ok && r.reason) this.notify(p, r.reason, 'warn');
        }
        return true;
      case 'abilityRelease':
        this.abilities.release(p, msg.ability);
        return true;
      case 'attack':
        this.melee.attack(p, msg);
        return true;
      case 'block':
        this.melee.setBlocking(p, !!msg.on);
        return true;
      case 'dig':
        this.terrainOps.dig(p, msg);
        return true;
    }
    return false;
  }

  onPlayerJoin(p: ServerEntity) {
    this.progression.sanitize(p);
    this.effects.sanitize(p);
    this.effects.recompute(p);
    this.ctx.markPlayerDirty(p.id, 'skills', 'stats', 'effects', 'cooldowns', 'gravity');
  }

  onEntityRemoved(e: ServerEntity) {
    this.rt.delete(e.id);
    for (const r of this.rt.values()) r.aggro.delete(e.id);
    this.abilities.forget(e.id);
    this.projectiles.onEntityRemoved(e);
    this.zones.onEntityRemoved(e);
    this.mover.forget(e.id);
    this.progression.forget(e.id);
  }

  tick(dt: number) {
    const now = this.ctx.time.now;
    this.abilities.tick(dt);
    this.melee.tick(dt);
    this.ops.tick(dt);
    this.projectiles.tick(dt);
    this.zones.tick(dt);
    this.fields.tick();
    this.mover.tick(dt);
    for (const e of this.ctx.entities.all.values()) {
      if (!e.stats && !e.effects.length) continue;
      const r = this.rt.get(e.id);
      if (e.alive) {
        if (e.stats) this.regen(e, r, dt, now);
        if (e.effects.length) this.effects.tick(e, dt);
      }
      if (r && r.combatUntil && now > r.combatUntil) {
        r.combatUntil = 0;
        e.flags &= ~FLAG_INCOMBAT;
        e.dirty = true;
      }
      if (e.kind === 'player') this.syncVitals(e, now);
    }
    this.progression.tick(dt);
  }

  slowTick() {
    const now = this.ctx.time.now;
    // Expire aggression memory.
    for (const r of this.rt.values()) for (const [id, until] of r.aggro) if (until <= now) r.aggro.delete(id);
    this.progression.slowTick();
    this.specials.slowTick();
    for (const p of this.ctx.players()) if (p.alive) this.effects.environment(p);
  }

  private regen(e: ServerEntity, r: Runtime | undefined, dt: number, now: number) {
    const s = e.stats!;
    const combat = r && r.combatUntil > now ? 0.35 : 1;
    if (e.hp < e.maxHp && s.hpRegen > 0) e.hp = Math.min(e.maxHp, e.hp + s.hpRegen * combat * dt);
    if (e.mana < s.maxMana) e.mana = Math.min(s.maxMana, e.mana + Math.max(0, s.manaRegen) * dt);
    const sinceUse = r ? now - r.staminaUsedAt : 9;
    const blocking = r?.blockSince !== undefined;
    const exert = e.anim.move === 'sprint' || e.anim.move === 'climb' || e.anim.move === 'swim';
    if (e.stamina < s.maxStamina && sinceUse > 0.8 && !blocking && !exert) e.stamina = Math.min(s.maxStamina, e.stamina + Math.max(0, s.staminaRegen) * dt);
    if (e.mana > s.maxMana) e.mana = s.maxMana;
    if (e.stamina > s.maxStamina) e.stamina = s.maxStamina;
  }

  /** Push vitals to the owning client at ≤ 5 Hz when they changed noticeably. */
  private syncVitals(p: ServerEntity, now: number) {
    const r = this.runtime(p);
    if (now - r.vitalsAt < 0.2) return;
    const key = Math.round(p.hp * 2) * 1e6 + Math.round(p.stamina) * 1e3 + Math.round(p.mana);
    if (key === r.vitalsKey) return;
    r.vitalsKey = key;
    r.vitalsAt = now;
    this.ctx.markPlayerDirty(p.id, 'vitals');
  }

  save() {
    return { anchors: this.specials.saveAnchors(), xpDay: this.specials.saveScavenged() };
  }

  load(data: unknown) {
    const d = data as { anchors?: Record<string, Vec3>; xpDay?: string[] } | null;
    if (!d) return;
    this.specials.loadAnchors(d.anchors ?? {});
    this.specials.loadScavenged(d.xpDay ?? []);
  }
}
