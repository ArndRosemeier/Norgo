/**
 * Weapons: basic melee & ranged attacks (`attack` messages), timed strike
 * resolution (wind-up → hit frame), weapon enchantments, sneak attacks,
 * blocking with a parry window (`block` messages), ammo and thrown weapons.
 */
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import type { DamageType, EntityId, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { ItemDef, ItemInstance } from '../../items/types';
import type { AbilityDef, EffectApply } from '../types';
import { effectDef } from '../data/catalog';
import { matDef } from '../../world/materials';
import { outgoingMult, UNARMED } from '../shared/combat';
import { effectiveLevel } from '../shared/stats';
import { hasEffect } from '../shared/checks';
import type { GameplaySystem } from './GameplaySystem';
import { solidMaterial } from './terrainOps';
import type { CastCtx } from './abilities';
import { chestOf, dirYaw, eyeOf, hnorm, isCombatant, isVec3, masterOf, vdist, vnorm, vsub, yawDir } from './util';

export interface WeaponInfo {
  damage: number;
  type: DamageType;
  speed: number;
  reach: number;
  skill: string;
  ranged: boolean;
  item?: ItemInstance;
  def?: ItemDef;
}

export interface StrikeSpec {
  mult: number;
  arc?: number;
  reach?: number;
  maxHits?: number;
  knockback?: number;
  type?: DamageType;
  effect?: EffectApply;
  bonusUnaware?: number;
  ability?: string;
  dir: Vec3;
  target?: EntityId;
  /** Ability power (skill scaling of the ability itself). */
  power?: number;
  heavy?: boolean;
  /** Out of stamina: feeble swing. */
  weak?: boolean;
  /** Basic attack: may hit world objects / terrain when no creature is in reach. */
  point?: Vec3;
  /** `target` is the caster's tab target: swing at it (instead of the camera aim) while it is in reach. */
  lock?: boolean;
}

/** Furthest a tab target may be for the server to honour a lock (client clears at 50 m). */
export const LOCK_RANGE = 52;
/** Extra slack beyond weapon reach within which a melee swing turns toward the locked target (latency, wind-up). */
const LOCK_MELEE_SLACK = 1.2;

/** Synthetic ability def for basic attacks (projectiles & XP bookkeeping). */
function basicDef(skill: string): AbilityDef {
  return {
    id: 'attack', name: 'Attack', skill, kind: 'physical', role: 'combat', targeting: 'aim', range: 80, cost: {}, cooldown: 0, castTime: 0,
    anim: 'swing_1h', description: '', icon: '', tags: [],
  };
}

const ENCHANTS: { id: string; type: DamageType; effect?: string; chance: number }[] = [
  { id: 'enchant_fire', type: 'fire', effect: 'burning', chance: 0.25 },
  { id: 'enchant_frost', type: 'frost', effect: 'chilled', chance: 0.4 },
  { id: 'enchant_shock', type: 'shock', effect: 'shocked', chance: 0.15 },
  { id: 'enchant_radiant', type: 'radiant', chance: 0 },
  { id: 'enchant_poison', type: 'poison', effect: 'poisoned', chance: 0.6 },
];

export class MeleeSim {
  private strikes: { at: number; caster: ServerEntity; spec: StrikeSpec }[] = [];

  constructor(private g: GameplaySystem) {}

  // ------------------------------------------------------------------ equipment queries

  weaponOf(e: ServerEntity): WeaponInfo {
    const it = e.equipment?.mainhand;
    if (!it) return { ...UNARMED };
    const def = this.g.ctx.services.items.def(it.defId);
    // Final rolled stats (material, quality) live on the instance.
    if (it.weapon) {
      const w = it.weapon;
      return { damage: w.damage, type: w.type, speed: w.speed || 1, reach: w.reach || 2, skill: w.skill, ranged: !!w.ranged, item: it, def };
    }
    if (def?.weapon) {
      const w = def.weapon;
      return { damage: w.damage, type: w.type, speed: w.speed || 1, reach: w.reach || 2, skill: w.skill, ranged: !!w.ranged, item: it, def };
    }
    if (def?.tool) {
      // Tools make passable improvised weapons.
      const k = def.tool.kind;
      const type: DamageType = k === 'axe' ? 'slash' : k === 'pick' ? 'pierce' : k === 'knife' || k === 'sickle' ? 'slash' : 'blunt';
      const skill = k === 'axe' ? 'axes' : k === 'knife' || k === 'sickle' ? 'blades' : k === 'pick' || k === 'hammer' ? 'blunt' : 'unarmed';
      return { damage: 5 + def.tool.power * 3, type, speed: 0.9, reach: 1.9, skill, ranged: false, item: it, def };
    }
    return { ...UNARMED, item: it, def };
  }

  hasShield(e: ServerEntity): boolean {
    const it = e.equipment?.offhand;
    if (!it) return false;
    const def = this.g.ctx.services.items.def(it.defId);
    return !!(def?.armor || def?.tags?.includes('shield') || it.visual?.shape?.startsWith('shield'));
  }

  private ammoItems(e: ServerEntity): ItemInstance[] {
    const items = this.g.ctx.services.items;
    return (e.inventory?.items ?? []).filter((it) => items.def(it.defId)?.category === 'ammo' || it.defId.includes('arrow'));
  }

  hasAmmo(e: ServerEntity): boolean {
    if (e.kind !== 'player') return true;
    return this.ammoItems(e).length > 0;
  }

  /** Consume up to `n` ammo. Returns the ammo def id ('' = infinite for AI), or null if none. */
  takeAmmo(e: ServerEntity, n = 1): string | null {
    if (e.kind !== 'player') return '';
    const list = this.ammoItems(e);
    if (!list.length) return null;
    const it = list[0];
    const defId = it.defId;
    this.g.ctx.services.items.take(e, it.uid, Math.min(n, it.count));
    this.g.ctx.markPlayerDirty(e.id, 'inventory');
    return defId;
  }

  // ------------------------------------------------------------------ attacks

  /**
   * Validate a client's tab target (`lock`): an alive combatant other than the caster, within
   * `range` of the caster's eye and not hidden behind terrain. Anything else is ignored and the
   * attack falls back to the ordinary crosshair aim — the client never decides outcomes.
   */
  lockedTarget(caster: ServerEntity, id: EntityId | undefined, range: number): ServerEntity | undefined {
    if (id === undefined || id === caster.id) return;
    const ctx = this.g.ctx;
    const e = ctx.entities.get(id);
    if (!e || !isCombatant(e) || (e.flags & EntFlag.Invisible) !== 0) return;
    const eye = eyeOf(caster), c = chestOf(e);
    const d = vsub(c, eye);
    const dist = Math.hypot(d[0], d[1], d[2]);
    if (dist > Math.min(range, LOCK_RANGE)) return;
    if (dist > 0.5) {
      const hit = ctx.terrain.raycast(eye[0], eye[1], eye[2], d[0] / dist, d[1] / dist, d[2] / dist, dist);
      if (hit && hit.dist < dist - 0.6) return;
    }
    return e;
  }

  /**
   * Can `caster` hit `target` with a ranged attack reaching `range`? `null` = yes (the hit is
   * then certain); otherwise the reason shown to the player. Line of sight counts if the head,
   * chest or upper body is visible from the caster's eye.
   */
  rangedBlocker(caster: ServerEntity, target: ServerEntity, range: number): string | null {
    if (target === caster || !target.alive || !isCombatant(target) || (target.flags & EntFlag.Invisible) !== 0) return 'Target lost.';
    const ctx = this.g.ctx;
    const eye = eyeOf(caster);
    const c = chestOf(target);
    if (Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) > range) return 'Out of range.';
    const h = target.height * target.scale;
    for (const y of [h * 0.9, c[1] - target.pos[1], h * 0.55]) {
      const d: Vec3 = [target.pos[0] - eye[0], target.pos[1] + y - eye[1], target.pos[2] - eye[2]];
      const dist = Math.hypot(d[0], d[1], d[2]);
      if (dist < 0.5) return null;
      const hit = ctx.terrain.raycast(eye[0], eye[1], eye[2], d[0] / dist, d[1] / dist, d[2] / dist, dist);
      if (!hit || hit.dist >= dist - 0.4) return null;
    }
    return 'No line of sight.';
  }

  attack(p: ServerEntity, msg: Extract<ClientMessage, { t: 'attack' }>) {
    const g = this.g, ctx = g.ctx;
    if (!p.alive) return;
    if (p.effects.some((x) => effectDef(x.id)?.incapacitate)) return;
    const now = ctx.time.now;
    const r = g.runtime(p);
    if (now < r.nextAttackAt - 0.05) return;
    const w = this.weaponOf(p);
    // Bows and throws at a tab target: decided before anything is spent. If the shot cannot
    // hit, a message; otherwise it is certain to land (the projectile flies to the target).
    let sure: ServerEntity | undefined;
    if (w.ranged && msg.lock && msg.target !== undefined) {
      const t = ctx.entities.get(msg.target);
      const why = t ? this.rangedBlocker(p, t, LOCK_RANGE) : 'Target lost.';
      if (why || !t) {
        g.notify(p, why ?? 'Target lost.', 'warn');
        return;
      }
      sure = t;
    }
    const heavy = !!msg.heavy;
    const speed = Math.max(0.3, w.speed * (1 + (p.stats?.attackSpeed ?? 0)));
    const dur = (heavy ? 0.95 : 0.6) / speed;
    const cost = w.ranged ? (heavy ? 8 : 4) : heavy ? 14 : 6;
    const weak = p.stamina < cost;
    p.stamina = Math.max(0, p.stamina - cost);
    r.staminaUsedAt = now;
    r.nextAttackAt = now + dur;
    if (r.blockSince !== undefined) this.setBlocking(p, false);
    g.effects.onAction(p);
    let dir = isVec3(msg.dir) ? vnorm(msg.dir, yawDir(p.yaw)) : yawDir(p.yaw);
    // Tab target: shots fly at it from any distance; swings turn toward it once it is in reach.
    const reach = w.reach + (p.scale - 1) * 0.8;
    const lock = sure ?? (msg.lock ? this.lockedTarget(p, msg.target, w.ranged ? LOCK_RANGE : reach + 3) : undefined);
    if (lock) {
      const to = vsub(lock.pos, p.pos);
      const gap = Math.hypot(to[0], to[2]) - lock.radius * lock.scale;
      if (w.ranged) dir = vnorm(vsub(chestOf(lock), eyeOf(p)), dir);
      else if (gap <= reach + LOCK_MELEE_SLACK) dir = hnorm(to, dir);
    }
    p.yaw = dirYaw(dir);
    r.combo = (r.combo + 1) % 3;
    let anim: string;
    if (w.ranged) anim = w.skill === 'archery' ? 'shoot_bow' : 'throw';
    else if (w.skill === 'unarmed') anim = heavy ? 'kick' : 'punch';
    else if (w.skill === 'polearms') anim = heavy ? 'swing_2h' : 'stab';
    else if (w.skill === 'blunt') anim = heavy ? 'slam' : 'swing_1h';
    else if (w.def?.twoHanded || heavy) anim = 'swing_2h';
    else anim = r.combo === 2 ? 'stab' : 'swing_1h';
    p.anim = { ...p.anim, action: { id: anim, t0: now, dur, aim: dir } };
    p.dirty = true;
    if (w.ranged) {
      this.fireRanged(p, w, dir, heavy, weak, lock);
      return;
    }
    this.queueStrike(p, now + dur * 0.45, {
      mult: heavy ? 1.8 : 1, arc: heavy ? 140 : 100, maxHits: heavy ? 3 : 2, knockback: heavy ? 4.5 : 1.2, dir, target: lock?.id ?? msg.target, heavy, weak,
      point: isVec3(msg.point) ? msg.point : undefined, lock: !!lock,
    });
  }

  private fireRanged(p: ServerEntity, w: WeaponInfo, dir: Vec3, heavy: boolean, weak: boolean, lock?: ServerEntity) {
    const g = this.g, ctx = g.ctx;
    const cx: CastCtx = {
      caster: p, def: basicDef(w.skill), use: { ability: 'attack', dir }, origin: eyeOf(p), dir, point: eyeOf(p), level: 0, power: 1, charge: heavy ? 1 : 0.7,
    };
    if (lock) {
      // Checked in attack(): the shot flies to the target and lands (see CastCtx.guaranteed).
      cx.use = { ...cx.use, target: lock.id, lock: true };
      cx.target = lock;
      cx.guaranteed = lock;
      cx.point = chestOf(lock);
    }
    if (w.skill === 'archery') {
      const ammo = this.takeAmmo(p, 1);
      if (ammo === null) {
        g.notify(p, 'No arrows.', 'warn');
        return;
      }
      g.projectiles.spawn(cx, { op: 'projectile', fx: 'arrow', speed: heavy ? 70 : 52, gravity: 0.8, radius: 0.05, useWeapon: true, damage: (heavy ? 1.4 : 1) * (weak ? 0.6 : 1) }, { ammoDef: ammo || undefined });
      return;
    }
    // Thrown weapons fly off and land as items you can pick up again.
    const it = w.item;
    let drop: ItemInstance | undefined;
    if (it && p.equipment) {
      const items = ctx.services.items;
      if (it.count > 1) {
        it.count--;
        drop = items.create(it.defId, { count: 1, material: it.material, rarity: it.rarity, seed: it.visual.seed });
      } else {
        drop = it;
        delete p.equipment.mainhand;
        g.effects.recompute(p);
      }
      ctx.markPlayerDirty(p.id, 'equipment', 'inventory');
      p.dirty = true;
    }
    const shape = it?.visual.shape ?? '';
    const fx = shape.includes('javelin') || shape.includes('spear') ? 'javelin' : shape.includes('axe') ? 'axe' : 'knife';
    g.projectiles.spawn(cx, { op: 'projectile', fx, speed: heavy ? 30 : 24, gravity: 1, radius: 0.08, useWeapon: true, damage: (heavy ? 1.5 : 1.1) * (weak ? 0.6 : 1) }, { itemDrop: drop });
  }

  queueStrike(caster: ServerEntity, at: number, spec: StrikeSpec) {
    this.strikes.push({ at, caster, spec });
  }

  tick(_dt: number) {
    if (!this.strikes.length) return;
    const now = this.g.ctx.time.now;
    const due = this.strikes.filter((s) => s.at <= now);
    if (!due.length) return;
    this.strikes = this.strikes.filter((s) => s.at > now);
    for (const s of due) this.resolveStrike(s.caster, s.spec);
  }

  /** The hit frame of a swing: find victims in the arc and apply damage. */
  resolveStrike(caster: ServerEntity, spec: StrikeSpec) {
    const g = this.g, ctx = g.ctx;
    if (!caster.alive || caster.effects.some((x) => effectDef(x.id)?.incapacitate)) return;
    const w = this.weaponOf(caster);
    const reach = w.reach + (spec.reach ?? 0) + (caster.scale - 1) * 0.8;
    const arc = spec.arc ?? 90;
    const cosA = Math.cos((arc * Math.PI) / 360);
    // Turn toward the aim at the moment of impact: players aim continuously with the camera
    // (anim.lookAt from their move messages); body yaw may lag behind the camera. A tab target
    // (validated lock) that is within reach wins over the camera aim.
    const look = caster.kind === 'player' ? caster.anim.lookAt : undefined;
    let dir = hnorm(look ? vsub(look, caster.pos) : spec.dir, hnorm(spec.dir));
    const locked = spec.lock && spec.target !== undefined ? ctx.entities.get(spec.target) : undefined;
    if (locked && isCombatant(locked)) {
      const to = vsub(locked.pos, caster.pos);
      if (Math.hypot(to[0], to[2]) - locked.radius * locked.scale <= reach + LOCK_MELEE_SLACK) dir = hnorm(to, dir);
    }
    const cands: { e: ServerEntity; d: number; dot: number }[] = [];
    for (const e of ctx.entities.near(caster.pos, reach + 4)) {
      if (e === caster || !isCombatant(e) || masterOf(e) === caster.id) continue;
      const to = vsub(e.pos, caster.pos);
      const hd = Math.hypot(to[0], to[2]);
      const d = hd - e.radius * e.scale;
      if (d > reach) continue;
      if (e.pos[1] > caster.pos[1] + caster.height * caster.scale + 0.6) continue;
      if (e.pos[1] + e.height * e.scale < caster.pos[1] - 1.2) continue;
      const dot = hd > 0.01 ? (to[0] * dir[0] + to[2] * dir[2]) / hd : 1;
      if (d > 0.35 && dot < cosA) continue;
      const deliberate = e.id === spec.target || (caster.kind === 'player' && dot > 0.9);
      if (!deliberate && !g.isHostile(caster, e)) continue;
      cands.push({ e, d: e.id === spec.target ? -1 : d, dot });
    }
    cands.sort((a, b) => a.d - b.d);
    const maxHits = spec.maxHits ?? (arc >= 180 ? 6 : 1);
    const lvl = effectiveLevel(caster.skills, caster.stats, w.skill);
    let hits = 0;
    for (const { e } of cands.slice(0, maxHits)) {
      const type = spec.type ?? w.type;
      let dmg = (w.damage + (caster.stats?.flatDamage?.[type] ?? 0)) * spec.mult * (spec.power ?? 1) * (1 + lvl * 0.012) * outgoingMult(caster.stats, type, false) * (0.9 + g.rng.float() * 0.2);
      if (spec.weak) dmg *= 0.6;
      let crit = false;
      if (hasEffect(caster, 'riposte')) {
        dmg *= 3;
        crit = true;
        g.effects.remove(caster, 'riposte');
      }
      // Sneak attacks: the victim is not fighting us, or we hit it from behind.
      const er = g.rt.get(e.id);
      const facing = yawDir(e.yaw);
      const fromBehind = (facing[0] * dir[0] + facing[2] * dir[2]) > 0.4;
      const unaware = e.target !== caster.id && !((er?.aggro.get(caster.id) ?? 0) > ctx.time.now);
      const hidden = (caster.flags & (EntFlag.Sneaking | EntFlag.Invisible)) !== 0;
      if ((unaware || fromBehind) && (spec.bonusUnaware || hidden)) {
        dmg *= 1 + (spec.bonusUnaware ?? 0) + (hidden ? 0.5 : 0);
        crit = crit || unaware;
        g.grantXp(caster, 'stealth', 3);
      }
      if (type === 'blunt' && hasEffect(e, 'frozen')) {
        dmg *= 1.5;
        g.effects.remove(e, 'frozen');
        ctx.broadcast({ type: 'fx', fx: 'shatter', pos: chestOf(e), target: e.id }, e.pos);
      }
      const dealt = g.damage(e, dmg, type, caster, { ability: spec.ability, melee: true, knockback: spec.weak ? 0 : spec.knockback, crit: crit || undefined, pos: chestOf(e) });
      if (dealt <= 0) continue;
      hits++;
      if (spec.effect) {
        const eff = spec.effect;
        if (eff.chance === undefined || g.rng.float() < eff.chance) {
          const d = effectDef(eff.id);
          g.effects.apply(e, eff.id, d?.dot ? eff.magnitude * (spec.power ?? 1) : eff.magnitude, eff.duration, caster);
        }
      }
      this.onWeaponHit(caster, e, dealt, type, unaware || fromBehind);
      g.grantXp(caster, w.skill, (spec.ability ? 1 : 2.5) + (spec.heavy ? 1 : 0));
      if (spec.heavy) g.grantXp(caster, 'athletics', 0.5);
    }
    if (!hits && spec.point && !spec.ability) this.hitWorld(caster, w, spec, reach);
  }

  /** Item affix procs ("ench.*" grants) on everything this entity wears. */
  grantsOf(e: ServerEntity): Set<string> {
    const out = new Set<string>();
    for (const it of Object.values(e.equipment ?? {})) if (it) for (const a of it.affixes ?? []) if (a.grants) out.add(a.grants);
    return out;
  }

  /**
   * Everything that rides on a landed weapon hit (melee or weapon projectile):
   * flat elemental gear damage, temporary weapon enchantments and item procs.
   */
  onWeaponHit(caster: ServerEntity, e: ServerEntity, dealt: number, type: DamageType, sneak: boolean) {
    const g = this.g, ctx = g.ctx;
    const flat = caster.stats?.flatDamage;
    if (flat)
      for (const k in flat) {
        const t = k as DamageType;
        const v = flat[t] ?? 0;
        // Physical flats are already part of the swing itself.
        if (v > 0 && e.alive && t !== type && t !== 'slash' && t !== 'pierce' && t !== 'blunt') g.damage(e, v, t, caster, { ability: 'gear' });
      }
    for (const en of ENCHANTS) {
      const m = g.effects.magnitude(caster, en.id);
      if (m <= 0 || !e.alive) continue;
      g.damage(e, m, en.type, caster, { ability: en.id });
      if (en.effect && g.rng.float() < en.chance) g.effects.apply(e, en.effect, en.id === 'enchant_poison' ? m * 0.5 : 3, 4, caster);
    }
    const grants = this.grantsOf(caster);
    if (!grants.size) return;
    const r = () => g.rng.float();
    const pos = chestOf(e);
    const fx = (name: string, color: [number, number, number], radius = 2) => ctx.broadcast({ type: 'fx', fx: name, pos, radius, color, target: e.id }, pos);
    const foesNear = (rad: number) => ctx.entities.near(pos, rad).filter((o) => o !== caster && isCombatant(o) && (o === e || g.isHostile(caster, o)));
    for (const gr of grants) {
      switch (gr) {
        case 'ench.flame_burst':
          if (r() < 0.15) {
            fx('explosion_fire', [1, 0.5, 0.15], 2);
            for (const o of foesNear(2.2)) g.damage(o, 10, 'fire', caster, { ability: gr, knockback: 3 });
          }
          break;
        case 'ench.ignite':
          if (r() < 0.25) g.effects.apply(e, 'burning', 4, 4, caster);
          break;
        case 'ench.frost_bite':
          if (r() < 0.3) g.effects.apply(e, 'chilled', 1, 4, caster);
          break;
        case 'ench.lifesteal':
          g.heal(caster, dealt * 0.15, caster);
          break;
        case 'ench.chain_spark':
          if (r() < 0.2) {
            let from = pos;
            const hit = new Set([e.id]);
            for (let k = 0; k < 2; k++) {
              const nxt = ctx.entities.near(from, 7).find((o) => !hit.has(o.id) && o !== caster && isCombatant(o) && g.isHostile(caster, o));
              if (!nxt) break;
              hit.add(nxt.id);
              const to = chestOf(nxt);
              ctx.broadcast({ type: 'fx', fx: 'chain', pos: from, dir: vnorm(vsub(to, from)), radius: vdist(from, to), color: [0.6, 0.75, 1] }, from);
              g.damage(nxt, 8, 'shock', caster, { ability: gr });
              from = to;
            }
          }
          break;
        case 'ench.thunderclap':
          if (r() < 0.1) {
            fx('force_ring', [0.7, 0.8, 1], 3);
            for (const o of foesNear(3)) g.damage(o, 8, 'shock', caster, { ability: gr, knockback: 7 });
          }
          break;
        case 'ench.bloodrage':
          if (r() < 0.1) g.effects.apply(caster, 'berserk', 1, 6, caster);
          break;
        case 'ench.backstab':
          if (sneak && e.alive) g.damage(e, dealt * 0.5, type, caster, { ability: gr });
          break;
        case 'ench.dirty_trick':
          if (r() < 0.1) g.effects.apply(e, 'blinded', 1, 2.5, caster);
          break;
        case 'ench.overgrowth':
          if (r() < 0.15) {
            g.effects.apply(e, 'root', 1, 2, caster);
            fx('bloom', [0.4, 0.9, 0.3], 1.2);
          }
          break;
        case 'ench.starfall':
          if (r() < 0.1 && e.alive) {
            fx('sunburst', [0.7, 0.7, 1], 2);
            g.damage(e, 18, 'radiant', caster, { ability: gr });
          }
          break;
        case 'ench.sunburst':
          if (r() < 0.08) {
            fx('sunburst', [1, 0.9, 0.55], 4);
            for (const o of foesNear(4)) {
              g.damage(o, 10, 'radiant', caster, { ability: gr });
              g.effects.apply(o, 'blinded', 0.6, 2, caster);
            }
          }
          break;
      }
    }
  }

  /** A swing that met no creature: chop/mine/damage objects or chip at terrain. */
  private hitWorld(caster: ServerEntity, w: WeaponInfo, spec: StrikeSpec, reach: number) {
    const g = this.g, ctx = g.ctx;
    const p = spec.point!;
    const eye = eyeOf(caster);
    if (vdist(eye, p) > reach + 1.2) return;
    const toolKind = w.def?.tool?.kind;
    const kind: DamageType | 'chop' | 'mine' = toolKind === 'axe' ? 'chop' : toolKind === 'pick' ? 'mine' : w.type;
    const objs = ctx.services.objects.near(p, 1.6);
    if (objs.length) {
      let best = objs[0];
      for (const o of objs) if (vdist(o.pos, p) < vdist(best.pos, p)) best = o;
      const amount = w.damage * spec.mult * (toolKind ? 1.5 + (w.def?.tool?.power ?? 1) * 0.5 : 0.5);
      ctx.services.objects.damage(best.id, amount, kind, caster, p);
      if (kind === 'chop') g.grantXp(caster, 'woodcutting', 1.5);
      else if (kind === 'mine') g.grantXp(caster, 'mining', 1.5);
      return;
    }
    const n = ctx.terrain.normal(p[0], p[1], p[2]);
    const mat = solidMaterial(ctx, p[0] - n[0] * 0.2, p[1] - n[1] * 0.2, p[2] - n[2] * 0.2);
    ctx.broadcast({ type: 'impact', pos: [p[0], p[1], p[2]], normal: n, material: matDef(mat).name, force: spec.heavy ? 1 : 0.5 }, p);
  }

  // ------------------------------------------------------------------ blocking

  setBlocking(e: ServerEntity, on: boolean) {
    const g = this.g, ctx = g.ctx;
    const r = g.runtime(e);
    if (on) {
      if (!e.alive || r.blockSince !== undefined || e.stamina < 5) return;
      if (e.effects.some((x) => effectDef(x.id)?.incapacitate)) return;
      r.blockSince = ctx.time.now;
      g.effects.apply(e, 'blocking', 1, Infinity);
      e.anim = { ...e.anim, action: { id: 'block', t0: ctx.time.now, dur: 600 } };
      e.dirty = true;
    } else {
      if (r.blockSince === undefined) return;
      r.blockSince = undefined;
      g.effects.remove(e, 'blocking');
      if (e.anim.action?.id === 'block') {
        e.anim = { ...e.anim, action: undefined };
        e.dirty = true;
      }
    }
  }
}
