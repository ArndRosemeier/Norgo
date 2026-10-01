/**
 * Use-based progression: XP grants, level ups, ability unlocks, hotbar
 * auto-placement, race starting bonuses and passive XP sources (movement,
 * sneaking, armor hits, crafting).
 */
import type { ServerEntity } from '../../server/entity';
import type { EntityId, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { GameEvent } from '../../shared/protocol';
import type { SkillProgress } from '../types';
import { RACES } from '../../humanoid/appearance';
import type { RaceId } from '../../humanoid/types';
import { abilityDef, resolveSkill, skillDef, SKILLS, SKILL_CAP, xpForLevel } from '../data/catalog';
import { hashString } from '../../core/rng';
import { MAGIC_SCHOOL_SKILLS } from '../shared/stats';
import type { GameplaySystem } from './GameplaySystem';
import { chestOf, hdist, masterOf } from './util';

export const HOTBAR_SIZE = 10;
/** Every player skill starts at least here, so each school and craft can be practised. */
export const PLAYER_MIN_SKILL = 1;
/** Starting level of a character's innate magic school. */
const TALENT_LEVEL = 4;

interface MoveTrack {
  pos: Vec3;
  grounded: boolean;
  acc: Record<string, number>;
}

/** Race lookup that tolerates an empty/partial RACES table. */
function raceDef(id: RaceId | null | undefined) {
  if (!id) return undefined;
  return (RACES as Partial<typeof RACES>)[id];
}

/** Blended race data for (possibly mixed heritage) humanoids. */
export function raceBlend(e: ServerEntity, field: 'skillBonus' | 'statMods'): Record<string, number> {
  const h = e.humanoid;
  if (!h) return {};
  const out: Record<string, number> = {};
  const w2 = h.race2 ? Math.max(0, Math.min(1, h.raceMix)) : 0;
  const add = (src: Record<string, number> | undefined, w: number) => {
    if (!src || w <= 0) return;
    for (const k in src) out[k] = (out[k] ?? 0) + src[k] * w;
  };
  add(raceDef(h.race)?.[field], 1 - w2);
  if (h.race2) add(raceDef(h.race2)?.[field], w2);
  return out;
}

export class Progression {
  private pending = new Map<EntityId, Map<string, { amount: number; level: number; leveled: boolean }>>();
  private moves = new Map<EntityId, MoveTrack>();
  /** `${entity}:${skill}` → server time of last explicit grant (crafting dedupe). */
  private lastGrant = new Map<string, number>();
  private warned = new Set<string>();

  constructor(private g: GameplaySystem) {}

  listen() {
    const ctx = this.g.ctx;
    // Crafting XP: the item system emits itemAcquired(how: 'craft'). If it already
    // granted XP for the matching skill this tick we do not double count.
    ctx.bus.on('itemAcquired', ({ entity, item, how }) => {
      if (how !== 'craft' || !entity.skills) return;
      const def = ctx.services.items.def(item.defId);
      const cat = def?.category ?? '';
      const mat = item.visual?.material ?? '';
      const tags = def?.tags ?? [];
      let skill = 'smithing';
      if (cat === 'food' || tags.includes('food')) skill = 'cooking';
      else if (cat === 'consumable' || cat === 'reagent' || tags.includes('potion')) skill = 'alchemy';
      else if (cat === 'clothing' || ['cloth', 'leather', 'silk', 'fur'].includes(mat)) skill = 'tailoring';
      else if (cat === 'jewelry' || cat === 'trinket') skill = 'enchanting';
      const amount = 6 + Math.min(30, (item.value ?? 1) * 0.15) * (item.count || 1);
      const key = entity.id + ':' + skill;
      if ((this.lastGrant.get(key) ?? -1) > ctx.time.now - 0.5) return;
      this.grantXp(entity, skill, amount);
      if (item.affixes?.length) this.grantXp(entity, 'enchanting', 4 * item.affixes.length);
    });
  }

  // ------------------------------------------------------------------ setup

  initSkills(e: ServerEntity) {
    const skills: Record<string, SkillProgress> = {};
    for (const s of SKILLS) skills[s.id] = { level: 0, xp: 0 };
    // Players start with a first step in every skill (so every school and craft can be
    // practised from the start), a little more in their starting gear's skills, and
    // one innate magical talent chosen deterministically from who they are: two
    // characters of the same race still play differently.
    if (e.kind === 'player') {
      for (const s of SKILLS) skills[s.id].level = PLAYER_MIN_SKILL;
      skills.blades.level = 2;
      skills.mining.level = 2;
      skills.survival.level = 2;
      const talentSeed = hashString((e.humanoid?.seed ?? 0) + ':' + e.name);
      const talent = MAGIC_SCHOOL_SKILLS[talentSeed % MAGIC_SCHOOL_SKILLS.length];
      skills[talent].level = Math.max(skills[talent].level, TALENT_LEVEL);
    }
    for (const [raw, b] of Object.entries(raceBlend(e, 'skillBonus'))) {
      const id = resolveSkill(raw);
      if (!id) continue;
      skills[id].level = Math.max(0, Math.min(30, Math.round(skills[id].level + b)));
    }
    const abilities: string[] = [];
    for (const s of SKILLS) for (const u of s.unlocks) if (u.level <= skills[s.id].level) abilities.push(u.ability);
    e.skills = { skills, abilities, hotbar: new Array(HOTBAR_SIZE).fill(null), toggles: [] };
    // Fill the hotbar from the character's strengths (race bonuses, talent, starting
    // gear: the skills above the common baseline), then by role: combat, movement,
    // defense, the rest. Everything else waits in the skill book.
    const order = (id: string) => {
      const d = abilityDef(id);
      const r = d?.role;
      const role = r === 'combat' ? 0 : r === 'movement' ? 1 : r === 'defense' ? 2 : 3;
      const lvl = d ? skills[d.skill]?.level ?? 0 : 0;
      return -lvl * 10 + role;
    };
    const actives = abilities.filter((a) => abilityDef(a)?.targeting !== 'passive').sort((a, b) => order(a) - order(b));
    for (let i = 0; i < Math.min(HOTBAR_SIZE, actives.length); i++) e.skills.hotbar[i] = actives[i];
  }

  /** Repair older saves: missing skills, unlocks added to the catalog later, bad hotbars. */
  sanitize(e: ServerEntity) {
    const st = e.skills;
    if (!st) return this.initSkills(e);
    st.skills ??= {};
    for (const s of SKILLS) st.skills[s.id] ??= { level: 0, xp: 0 };
    // Older saves predate the player baseline: lift every skill to it (unlocks follow below).
    if (e.kind === 'player') for (const s of SKILLS) if (st.skills[s.id].level < PLAYER_MIN_SKILL) st.skills[s.id] = { level: PLAYER_MIN_SKILL, xp: 0 };
    st.abilities = (st.abilities ?? []).filter((a) => !!abilityDef(a));
    const have = new Set(st.abilities);
    for (const s of SKILLS)
      for (const u of s.unlocks) if (u.level <= st.skills[s.id].level && !have.has(u.ability)) st.abilities.push(u.ability);
    st.hotbar = Array.isArray(st.hotbar) ? st.hotbar.slice(0, 12) : [];
    while (st.hotbar.length < HOTBAR_SIZE) st.hotbar.push(null);
    st.toggles = [];
  }

  // ------------------------------------------------------------------ XP

  grantXp(e: ServerEntity, skill: string, amount: number) {
    const st = e.skills;
    if (!st || !(amount > 0) || !Number.isFinite(amount)) return;
    const def = skillDef(skill);
    if (!def) {
      if (!this.warned.has(skill)) {
        this.warned.add(skill);
        this.g.ctx.log('gameplay: grantXp for unknown skill', skill);
      }
      return;
    }
    const ctx = this.g.ctx;
    skill = def.id;
    amount *= 1 + Math.max(-0.5, e.stats?.xpGain ?? 0);
    this.lastGrant.set(e.id + ':' + skill, ctx.time.now);
    const p = (st.skills[skill] ??= { level: 0, xp: 0 });
    if (p.level >= SKILL_CAP) return;
    p.xp += amount;
    let leveled = false;
    while (p.level < SKILL_CAP && p.xp >= xpForLevel(p.level)) {
      p.xp -= xpForLevel(p.level);
      p.level++;
      leveled = true;
      for (const u of def.unlocks) if (u.level === p.level || (u.level < p.level && !st.abilities.includes(u.ability))) this.unlock(e, u.ability, skill);
    }
    if (p.level >= SKILL_CAP) p.xp = 0;
    ctx.bus.emit('skillXp', { entity: e, skill, amount, level: p.level, leveled });
    if (leveled) {
      this.g.effects.recompute(e);
      ctx.broadcast({ type: 'fx', fx: 'levelup', pos: chestOf(e), target: e.id, color: def.color }, e.pos);
    }
    if (e.kind === 'player') {
      let m = this.pending.get(e.id);
      if (!m) this.pending.set(e.id, (m = new Map()));
      const cur = m.get(skill);
      if (cur) {
        cur.amount += amount;
        cur.level = p.level;
        cur.leveled ||= leveled;
      } else m.set(skill, { amount, level: p.level, leveled });
      ctx.markPlayerDirty(e.id, 'skills');
    }
  }

  unlock(e: ServerEntity, abilityId: string, skill: string) {
    const st = e.skills;
    const def = abilityDef(abilityId);
    if (!st || !def || st.abilities.includes(abilityId)) return;
    st.abilities.push(abilityId);
    if (def.targeting !== 'passive') {
      const slot = st.hotbar.findIndex((h, i) => h === null && i < HOTBAR_SIZE);
      if (slot >= 0) st.hotbar[slot] = abilityId;
    } else this.g.effects.recompute(e);
    this.g.ctx.bus.emit('abilityUnlocked', { entity: e, ability: abilityId });
    this.g.sendEvents(e, [{ type: 'unlock', ability: abilityId, skill }]);
    if (e.kind === 'player') this.g.ctx.markPlayerDirty(e.id, 'skills');
  }

  /** Armor skills train by taking hits in that armor. */
  armorHit(p: ServerEntity, amount: number) {
    const eq = p.equipment;
    if (!eq) return;
    let heavy = 0, light = 0;
    for (const it of Object.values(eq)) {
      if (!it) continue;
      const def = this.g.ctx.services.items.def(it.defId);
      if (!def?.armor) continue;
      if (def.armor.heaviness >= 0.5) heavy += def.armor.coverage;
      else light += def.armor.coverage;
    }
    if (heavy + light <= 0) return;
    const xp = Math.min(5, 0.6 + amount * 0.12);
    if (heavy >= light) this.grantXp(p, 'heavy_armor', xp);
    else this.grantXp(p, 'light_armor', xp);
  }

  // ------------------------------------------------------------------ passive sources

  tick(_dt: number) {
    const ctx = this.g.ctx;
    for (const p of ctx.players()) {
      if (!p.alive) continue;
      let m = this.moves.get(p.id);
      if (!m) {
        this.moves.set(p.id, (m = { pos: [...p.pos] as Vec3, grounded: p.grounded, acc: {} }));
        continue;
      }
      const dx = p.pos[0] - m.pos[0], dy = p.pos[1] - m.pos[1], dz = p.pos[2] - m.pos[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 15) {
        const add = (skill: string, v: number) => {
          const a = (m!.acc[skill] = (m!.acc[skill] ?? 0) + v);
          if (a >= 2) {
            this.grantXp(p, skill, a);
            m!.acc[skill] = 0;
          }
        };
        switch (p.anim.move) {
          case 'climb': add('climbing', Math.abs(dy) * 0.6 + Math.hypot(dx, dz) * 0.15); break;
          case 'swim': add('swimming', d * 0.25); break;
          case 'sprint': add('athletics', d * 0.04); break;
          case 'run': add('athletics', d * 0.015); break;
          case 'glide': add('acrobatics', d * 0.03); break;
        }
        if (m.grounded && !p.grounded && p.vel[1] > 2) add('acrobatics', 0.5);
      }
      m.pos[0] = p.pos[0];
      m.pos[1] = p.pos[1];
      m.pos[2] = p.pos[2];
      m.grounded = p.grounded;
    }
    // Flush aggregated XP events once per tick.
    for (const [id, m] of this.pending) {
      const p = ctx.entities.get(id);
      if (p) {
        const evs: GameEvent[] = [];
        for (const [skill, x] of m) evs.push({ type: 'xp', skill, amount: Math.round(x.amount * 10) / 10, level: x.level, leveled: x.leveled });
        this.g.sendEvents(p, evs);
      }
    }
    this.pending.clear();
  }

  /** Once per second: stealth XP for sneaking near others who have not noticed you. */
  slowTick() {
    const ctx = this.g.ctx;
    for (const p of ctx.players()) {
      if (!p.alive) continue;
      const sneaking = (p.flags & (EntFlag.Sneaking | EntFlag.Invisible)) !== 0;
      if (!sneaking) continue;
      let unaware = 0;
      for (const o of ctx.entities.near(p.pos, 18)) {
        if (o === p || !o.alive || (o.kind !== 'npc' && o.kind !== 'creature')) continue;
        if (masterOf(o) === p.id) continue;
        if (o.target === p.id || o.lastAttacker === p.id) continue;
        unaware += hdist(o.pos, p.pos) < 8 ? 1.5 : 1;
      }
      if (unaware > 0) this.grantXp(p, 'stealth', Math.min(3, 0.5 * unaware));
    }
    const now = ctx.time.now;
    for (const [k, t] of this.lastGrant) if (now - t > 5) this.lastGrant.delete(k);
  }

  forget(id: EntityId) {
    this.moves.delete(id);
    this.pending.delete(id);
  }
}
