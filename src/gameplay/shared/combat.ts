/**
 * Combat math (shared, pure): mitigation, crits, ability power scaling and
 * weapon defaults. The server applies these authoritatively; the UI uses them
 * for tooltips ("~34 fire damage at your level").
 */
import type { DamageType } from '../../shared/types';
import type { AbilityDef, Stats } from '../types';
import { PHYSICAL_TYPES } from './stats';

/** Armor reduces physical damage with diminishing returns: 50 armor ≈ 45%. */
export function armorReduction(armor: number): number {
  return armor <= 0 ? 0 : armor / (armor + 60);
}

/** Damage after armor and resistances (before shields, block and crits). */
export function mitigate(amount: number, type: DamageType, stats: Stats | undefined): number {
  if (!stats || type === 'fall') return amount;
  let a = amount;
  if (PHYSICAL_TYPES.has(type)) a *= 1 - armorReduction(stats.armor) * 0.9;
  else if (type === 'force') a *= 1 - armorReduction(stats.armor) * 0.4;
  const r = stats.resist[type] ?? 0;
  a *= 1 - r;
  return Math.max(0, a);
}

/** Outgoing multiplier for a damage type from "damage.<type>" mods. */
export function outgoingMult(stats: Stats | undefined, type: DamageType, magic: boolean): number {
  if (!stats) return 1;
  let m = 1 + (stats.damage?.[type] ?? 0);
  if (magic) m *= 1 + (stats.spellPower ?? 0);
  return Math.max(0.1, m);
}

/**
 * Ability power from skill level: physical +1.5%/level, magic +2%/level.
 * A level-50 pyromancer's fireball is twice as strong as an apprentice's.
 */
export function abilityPower(def: Pick<AbilityDef, 'kind'>, level: number): number {
  return 1 + level * (def.kind === 'magic' ? 0.02 : 0.015);
}

/** Cooldown after cast speed / attack speed and skill (−0.3%/level, max −30%). */
export function effectiveCooldown(def: AbilityDef, level: number): number {
  return def.cooldown * Math.max(0.7, 1 - level * 0.003);
}

/** Resource cost after skill (−0.4%/level, max −40%). */
export function effectiveCost(def: AbilityDef, level: number): { stamina: number; mana: number; hp: number } {
  const k = Math.max(0.6, 1 - level * 0.004);
  return { stamina: (def.cost.stamina ?? 0) * k, mana: (def.cost.mana ?? 0) * k, hp: def.cost.hp ?? 0 };
}

/** Fallback weapon when nothing (or an unknown item) is equipped. */
export const UNARMED = { damage: 6, type: 'blunt' as DamageType, speed: 1.3, reach: 1.6, skill: 'unarmed', ranged: false };

/** Damage-type color for floating numbers and impact fx (linear-ish sRGB). */
export const DAMAGE_COLORS: Record<DamageType, [number, number, number]> = {
  slash: [0.9, 0.15, 0.12], pierce: [0.95, 0.3, 0.2], blunt: [0.85, 0.75, 0.6], fire: [1, 0.5, 0.12], frost: [0.55, 0.85, 1],
  shock: [0.7, 0.8, 1], force: [0.7, 0.85, 1], poison: [0.45, 0.9, 0.2], radiant: [1, 0.92, 0.55], shadow: [0.55, 0.3, 0.85],
  psychic: [0.95, 0.45, 0.9], fall: [0.8, 0.8, 0.8],
};
