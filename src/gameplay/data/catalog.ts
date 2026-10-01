/**
 * The skill & ability catalog shared by server, client input, and UI.
 * Data lives in skills.ts / abilities.ts / effects.ts; this module indexes it,
 * derives cross references (unlock levels, colors) and holds the XP curve.
 */
import type { AbilityDef, SkillDef } from '../types';
import { SKILLS, SKILL_CAP } from './skills';
import { ABILITIES } from './abilities';
import { EFFECTS, effectDef } from './effects';

export { SKILLS, ABILITIES, EFFECTS, SKILL_CAP, effectDef };

const SKILL_BY_ID = new Map<string, SkillDef>(SKILLS.map((s) => [s.id, s]));
const ABILITY_BY_ID = new Map<string, AbilityDef>(ABILITIES.map((a) => [a.id, a]));

// Derive unlock levels and default colors from the owning skill.
for (const s of SKILLS)
  for (const u of s.unlocks) {
    const a = ABILITY_BY_ID.get(u.ability);
    if (a) {
      a.unlockLevel = u.level;
      a.color ??= s.color;
    }
  }

/**
 * Skill ids other modules (race tables, books, dialog) may use that map onto
 * our skills. Unknown ids that are not listed are ignored by the server.
 */
export const SKILL_ALIASES: Record<string, string> = {
  trading: 'barter', speech: 'persuasion', crafting: 'smithing', tinkering: 'smithing', twohanded: 'axes', two_handed: 'axes',
  daggers: 'blades', swords: 'blades', maces: 'blunt', hammers: 'blunt', spears: 'polearms', bows: 'archery', block: 'shields',
  druidism: 'vitae', healing: 'vitae', restoration: 'vitae', nature: 'vitae', shadowcraft: 'umbramancy', illusion: 'umbramancy',
  fire: 'pyromancy', frost: 'cryomancy', earth: 'geomancy', gravity: 'gravitas', light: 'luminism', force: 'kinesis', beasts: 'animism',
  taming: 'animism', runes: 'runecraft', sneak: 'stealth', thievery: 'lockpicking', athletics_run: 'athletics', climb: 'climbing', swim: 'swimming',
  hunting: 'tracking', fishing: 'survival', woodworking: 'woodcutting', cook: 'cooking', brewing: 'alchemy', sewing: 'tailoring',
};

/** Canonical skill id for an id or alias (undefined if unknown). */
export function resolveSkill(id: string): string | undefined {
  if (SKILL_BY_ID.has(id)) return id;
  const a = SKILL_ALIASES[id];
  return a && SKILL_BY_ID.has(a) ? a : undefined;
}

export function skillDef(id: string): SkillDef | undefined {
  return SKILL_BY_ID.get(id) ?? SKILL_BY_ID.get(SKILL_ALIASES[id]);
}

export function abilityDef(id: string): AbilityDef | undefined {
  return ABILITY_BY_ID.get(id);
}

/** XP needed to go from `level` to `level+1`. */
export function xpForLevel(level: number): number {
  return Math.round(40 * Math.pow(level + 1, 1.55));
}

/** Total XP from level 0 to reach `level` (UI progress, debug grants). */
export function totalXpForLevel(level: number): number {
  let t = 0;
  for (let l = 0; l < level; l++) t += xpForLevel(l);
  return t;
}

/** Status effect ids that the client player controller understands (movement-related). */
export const MOVEMENT_EFFECTS = [
  'haste', 'slow', 'root', 'stun', 'featherfall', 'levitate', 'waterwalk', 'gravity_low', 'gravity_high', 'climb_boost', 'swim_boost', 'leap_boost', 'glide', 'phase',
] as const;

/** Abilities granted by a skill up to (and including) `level`. */
export function unlocksUpTo(skill: string, level: number): string[] {
  const s = SKILL_BY_ID.get(skill);
  if (!s) return [];
  return s.unlocks.filter((u) => u.level <= level).map((u) => u.ability);
}

/** Skills grouped by category (UI). */
export function skillsByCategory(): Record<SkillDef['category'], SkillDef[]> {
  const out = { combat: [], magic: [], utility: [], craft: [], social: [], survival: [] } as Record<SkillDef['category'], SkillDef[]>;
  for (const s of SKILLS) out[s.category].push(s);
  return out;
}

/** Abilities of a skill ordered by unlock level (UI skill tree). */
export function abilitiesOfSkill(skill: string): AbilityDef[] {
  const s = SKILL_BY_ID.get(skill);
  if (!s) return [];
  return s.unlocks.map((u) => ABILITY_BY_ID.get(u.ability)).filter((a): a is AbilityDef => !!a);
}

/** Consistency check used by tools/gameplay-selftest.ts. Returns human-readable problems. */
export function validateCatalog(): string[] {
  const problems: string[] = [];
  const unlocked = new Set<string>();
  for (const s of SKILLS) {
    if (s.unlocks.length < 3) problems.push(`skill ${s.id} has only ${s.unlocks.length} unlocks`);
    for (const u of s.unlocks) {
      const a = ABILITY_BY_ID.get(u.ability);
      if (!a) problems.push(`skill ${s.id} unlocks unknown ability ${u.ability}`);
      else if (a.skill !== s.id) problems.push(`ability ${a.id} belongs to ${a.skill} but is unlocked by ${s.id}`);
      if (unlocked.has(u.ability)) problems.push(`ability ${u.ability} unlocked twice`);
      unlocked.add(u.ability);
    }
  }
  const effects = new Set(EFFECTS.map((e) => e.id));
  const checkOps = (a: AbilityDef, ops: NonNullable<AbilityDef['ops']>) => {
    for (const o of ops) {
      const ids: string[] = [];
      if (o.op === 'effect') ids.push(o.id);
      if ((o.op === 'strike' || o.op === 'projectile' || o.op === 'area' || o.op === 'cone' || o.op === 'beam') && o.effect) ids.push(o.effect.id);
      for (const id of ids) if (!effects.has(id)) problems.push(`ability ${a.id} applies unknown effect ${id}`);
      if (o.op === 'projectile' && o.onHit) checkOps(a, o.onHit);
      if ((o.op === 'zone' || o.op === 'delay') && o.ops) checkOps(a, o.ops);
    }
  };
  const ids = new Set<string>();
  for (const a of ABILITIES) {
    if (ids.has(a.id)) problems.push(`duplicate ability ${a.id}`);
    ids.add(a.id);
    if (!SKILL_BY_ID.has(a.skill)) problems.push(`ability ${a.id} has unknown skill ${a.skill}`);
    if (!unlocked.has(a.id)) problems.push(`ability ${a.id} is never unlocked`);
    if (a.targeting === 'passive' ? !a.passive : !a.ops?.length) problems.push(`ability ${a.id} has no ${a.targeting === 'passive' ? 'passive mods' : 'ops'}`);
    if (a.ops) checkOps(a, a.ops);
  }
  return problems;
}
