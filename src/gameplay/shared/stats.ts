/**
 * Stat computation (pure, shared). Final stats = base (+ non-player base
 * overrides) + race mods + skill-derived bonuses + unlocked passives +
 * equipment mods + active effects. Used by the server (authoritative) and by
 * the UI (to preview equipment changes).
 *
 * Mod keys (items, races, passives, effects): maxHp, maxStamina, maxMana,
 * hpRegen, staminaRegen, manaRegen, armor, moveSpeed, jump, carry, stealth,
 * perception, spellPower, critChance, critMult, attackSpeed, castSpeed,
 * lightRadius, dodge, block, barter, fallResist, resist.<type>,
 * damage.<type>, skill.<id>.
 */
import type { DamageType } from '../../shared/types';
import type { ActiveEffect, SkillsState, Stats } from '../types';
import type { Equipment, ItemDef } from '../../items/types';
import { abilityDef, effectDef, resolveSkill } from '../data/catalog';

export const BASE_STATS: Readonly<Stats> = Object.freeze({
  maxHp: 100, maxStamina: 100, maxMana: 60, hpRegen: 0.6, staminaRegen: 9, manaRegen: 0.8, armor: 0, moveSpeed: 1, jump: 1, carry: 100,
  stealth: 0, perception: 10, resist: {}, spellPower: 0, critChance: 0.05, critMult: 1.6, attackSpeed: 0, castSpeed: 0, lightRadius: 0,
  damage: {}, skillBonus: {}, dodge: 0, block: 0, barter: 0, fallResist: 0, gravityMul: 1, flatDamage: {}, xpGain: 0,
});

export const MAGIC_SCHOOL_SKILLS = ['pyromancy', 'cryomancy', 'geomancy', 'gravitas', 'vitae', 'luminism', 'umbramancy', 'kinesis', 'animism', 'runecraft'] as const;
export const PHYSICAL_TYPES: ReadonlySet<DamageType> = new Set<DamageType>(['slash', 'pierce', 'blunt']);

export function freshStats(base?: Partial<Stats>): Stats {
  const s: Stats = { ...BASE_STATS, resist: {}, damage: {}, skillBonus: {}, flatDamage: {} };
  if (base) {
    for (const [k, v] of Object.entries(base)) {
      if (k === 'resist' || k === 'damage' || k === 'skillBonus') Object.assign((s as unknown as Record<string, object>)[k], v);
      else (s as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return s;
}

/** Add one stat mod (see module doc for keys). Unknown keys are ignored. */
export function addMod(s: Stats, key: string, v: number): void {
  if (!v || !Number.isFinite(v)) return;
  const dot = key.indexOf('.');
  if (dot > 0) {
    const group = key.slice(0, dot), sub = key.slice(dot + 1);
    if (group === 'resist') s.resist[sub as DamageType] = (s.resist[sub as DamageType] ?? 0) + v;
    else if (group === 'damage') (s.damage ??= {})[sub as DamageType] = (s.damage[sub as DamageType] ?? 0) + v;
    else if (group === 'skill') {
      const id = resolveSkill(sub) ?? sub;
      (s.skillBonus ??= {})[id] = (s.skillBonus[id] ?? 0) + v;
    }
    return;
  }
  // Keys used by race tables / older data.
  switch (key) {
    case 'damage':
      for (const t of PHYSICAL_TYPES) (s.damage ??= {})[t] = (s.damage[t] ?? 0) + v;
      return;
    case 'evasion':
      s.dodge = (s.dodge ?? 0) + v;
      return;
    case 'luck':
      s.critChance = (s.critChance ?? 0) + v * 0.01;
      s.barter = (s.barter ?? 0) + v * 0.01;
      return;
    case 'darkvision':
      s.perception += v * 10;
      return;
  }
  const r = s as unknown as Record<string, unknown>;
  if (typeof r[key] === 'number' || key in BASE_STATS) r[key] = ((r[key] as number) ?? 0) + v;
}

export function addMods(s: Stats, mods: Record<string, number> | undefined, scale = 1): void {
  if (!mods) return;
  for (const k in mods) addMod(s, k, mods[k] * scale);
}

/**
 * Gear mods follow the item module's conventions: "resist.<type>" in percent
 * (30 = 30%) and "damage.<type>" as flat damage per hit. Convert them into
 * the stat model (fractions / flatDamage).
 */
export function addGearMods(s: Stats, mods: Record<string, number> | undefined): void {
  if (!mods) return;
  for (const k in mods) {
    const v = mods[k];
    if (k.startsWith('resist.')) addMod(s, k, Math.abs(v) > 1 ? v / 100 : v);
    else if (k.startsWith('damage.')) {
      const t = k.slice(7) as DamageType;
      (s.flatDamage ??= {})[t] = (s.flatDamage[t] ?? 0) + v;
    } else addMod(s, k, v);
  }
}

/** Skill level including gear/effect bonuses. */
export function effectiveLevel(skills: SkillsState | undefined, stats: Stats | undefined, skill: string): number {
  return (skills?.skills[skill]?.level ?? 0) + (stats?.skillBonus?.[skill] ?? 0);
}

export interface StatInputs {
  skills?: SkillsState;
  equipment?: Equipment;
  effects: ActiveEffect[];
  /** Race stat mods (already blended for mixed heritage). */
  raceMods?: Record<string, number>;
  /** Base override (creatures/NPCs: their own hp pool etc). */
  base?: Partial<Stats>;
  /** Item definition lookup (armor heaviness). Optional on the client. */
  itemDef?: (id: string) => ItemDef | undefined;
}

/** Compute final stats. Allocates one Stats object (call on change, not per frame). */
export function computeStats(inp: StatInputs): Stats {
  const s = freshStats(inp.base);
  // Pass 1: everything that can grant skill bonuses, so skill-derived stats see them.
  addMods(s, inp.raceMods);
  if (inp.skills) for (const id of inp.skills.abilities) addMods(s, abilityDef(id)?.passive);
  let heaviness = 0, heavyArmor = 0, lightArmor = 0, shieldBlock = 0;
  if (inp.equipment) {
    for (const [slot, it] of Object.entries(inp.equipment)) {
      if (!it) continue;
      addGearMods(s, it.mods);
      const def = inp.itemDef?.(it.defId);
      if (def?.armor) {
        const a = it.mods.armor ?? def.armor.armor;
        heaviness += def.armor.heaviness * def.armor.coverage;
        if (def.armor.heaviness >= 0.5) heavyArmor += a;
        else lightArmor += a;
        if (slot === 'offhand') shieldBlock = Math.max(shieldBlock, 0.35 + Math.min(0.3, a * 0.01));
      }
    }
  }
  // Effects are pruned by the server when they expire, so all listed ones count.
  for (const e of inp.effects) {
    const d = effectDef(e.id);
    if (!d) continue;
    addMods(s, d.mods, e.magnitude * (d.stack === 'stack' ? e.stacks ?? 1 : 1));
    addMods(s, d.flat);
    if (d.gravityMul !== undefined) s.gravityMul = (s.gravityMul ?? 1) * d.gravityMul;
  }

  // Pass 2: skill-derived bonuses.
  const L = (id: string) => effectiveLevel(inp.skills, s, id);
  if (inp.skills) {
    const ath = L('athletics'), acro = L('acrobatics'), heavy = L('heavy_armor'), light = L('light_armor'), surv = L('survival');
    s.maxHp += ath * 0.35 + heavy * 0.3 + surv * 0.3 + L('unarmed') * 0.1;
    s.maxStamina += ath * 0.8 + L('swimming') * 0.2 + L('climbing') * 0.2;
    s.staminaRegen += ath * 0.06 + L('climbing') * 0.02;
    s.carry += ath * 0.8 + L('mining') * 0.2;
    s.jump += acro * 0.003;
    s.fallResist = (s.fallResist ?? 0) + acro * 0.004;
    s.dodge = (s.dodge ?? 0) + acro * 0.0008 + light * 0.001;
    s.hpRegen += surv * 0.015;
    addMod(s, 'resist.frost', surv * 0.002);
    addMod(s, 'resist.fire', surv * 0.002);
    s.stealth += L('stealth') * 0.6;
    s.perception += L('tracking') * 0.3 + L('foraging') * 0.15 + L('lore') * 0.1;
    s.barter = (s.barter ?? 0) + L('barter') * 0.002 + L('persuasion') * 0.001;
    let magicSum = 0, magicMax = 0;
    for (const m of MAGIC_SCHOOL_SKILLS) {
      const l = L(m);
      magicSum += l;
      if (l > magicMax) magicMax = l;
    }
    s.maxMana += magicSum * 0.35 + L('lore') * 0.2 + L('enchanting') * 0.3;
    s.manaRegen += magicMax * 0.02 + L('enchanting') * 0.01;
    s.critChance = (s.critChance ?? 0) + L('stealth') * 0.0005 + L('archery') * 0.0005;
    // Armor training multiplies the protection of matching gear.
    s.armor += heavyArmor * heavy * 0.006 + lightArmor * light * 0.006;
    heaviness *= Math.max(0.25, 1 - heavy * 0.008);
    if (shieldBlock > 0) s.block = Math.max(s.block ?? 0, shieldBlock + L('shields') * 0.004);
  }
  // Heavy gear burdens movement, stealth and casting.
  if (heaviness > 0) {
    s.moveSpeed -= heaviness * 0.035;
    s.stealth -= heaviness * 7;
    s.castSpeed = (s.castSpeed ?? 0) - heaviness * 0.04;
  }

  // Clamps.
  s.maxHp = Math.max(1, Math.round(s.maxHp));
  s.maxStamina = Math.max(10, Math.round(s.maxStamina));
  s.maxMana = Math.max(0, Math.round(s.maxMana));
  s.moveSpeed = Math.max(0.2, s.moveSpeed);
  s.jump = Math.max(0.2, s.jump);
  s.armor = Math.max(0, s.armor);
  for (const k in s.resist) s.resist[k as DamageType] = Math.max(-1, Math.min(0.85, s.resist[k as DamageType]!));
  s.dodge = Math.max(0, Math.min(0.6, s.dodge ?? 0));
  s.block = Math.max(0, Math.min(0.9, s.block ?? 0));
  s.fallResist = Math.max(0, Math.min(1, s.fallResist ?? 0));
  s.critChance = Math.max(0, Math.min(0.75, s.critChance ?? 0));
  s.barter = Math.max(-0.5, Math.min(0.5, s.barter ?? 0));
  s.attackSpeed = Math.max(-0.6, s.attackSpeed ?? 0);
  s.castSpeed = Math.max(-0.6, s.castSpeed ?? 0);
  return s;
}

/** Human readable stat labels for UI. */
export const STAT_LABELS: Record<string, string> = {
  maxHp: 'Health', maxStamina: 'Stamina', maxMana: 'Mana', hpRegen: 'Health regen', staminaRegen: 'Stamina regen', manaRegen: 'Mana regen',
  armor: 'Armor', moveSpeed: 'Move speed', jump: 'Jump', carry: 'Carry weight', stealth: 'Stealth', perception: 'Perception',
  spellPower: 'Spell power', critChance: 'Critical chance', critMult: 'Critical damage', attackSpeed: 'Attack speed', castSpeed: 'Cast speed',
  lightRadius: 'Light radius', dodge: 'Dodge', block: 'Block', barter: 'Barter', fallResist: 'Fall resistance',
};

/** "resist.fire" → "Fire resistance", "skill.mining" → "Mining", "damage.slash" → "Slash damage". */
export function modLabel(key: string, skillName?: (id: string) => string | undefined): string {
  const dot = key.indexOf('.');
  if (dot > 0) {
    const g = key.slice(0, dot), sub = key.slice(dot + 1);
    const cap = sub.charAt(0).toUpperCase() + sub.slice(1);
    if (g === 'resist') return `${cap} resistance`;
    if (g === 'damage') return `${cap} damage`;
    if (g === 'skill') return skillName?.(sub) ?? cap;
  }
  return STAT_LABELS[key] ?? key;
}

/** Format a mod value for UI ("+12%", "+5"). */
export function formatMod(key: string, v: number): string {
  const pct = key.startsWith('resist.') || key.startsWith('damage.') || ['moveSpeed', 'jump', 'spellPower', 'critChance', 'attackSpeed', 'castSpeed', 'dodge', 'block', 'barter', 'fallResist'].includes(key);
  const sign = v >= 0 ? '+' : '−';
  const a = Math.abs(v);
  return pct ? `${sign}${Math.round(a * 100)}%` : `${sign}${a % 1 ? a.toFixed(1) : a}`;
}
