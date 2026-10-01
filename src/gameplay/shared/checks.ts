/**
 * Perception, stealth and skill checks (shared, pure). NPC/creature AI uses
 * `stealthFactor`/`detectionChance` to decide whether it notices someone;
 * dialog uses `skillCheck`/`skillCheckChance` for persuasion, intimidation,
 * barter and lore checks. Server code can grant XP for checks through
 * `ctx.services.skills.grantXp` (GameplaySystem.skillCheck does it for you).
 */
import { EntFlag } from '../../shared/types';
import type { AnimState } from '../../shared/types';
import type { ActiveEffect, SkillsState, Stats } from '../types';
import { hashCombine, hashToFloat, hash32 } from '../../core/rng';
import { effectiveLevel } from './stats';

/** Minimal shape needed by checks (ServerEntity satisfies it). */
export interface Checkable {
  flags: number;
  anim: AnimState;
  effects: ActiveEffect[];
  skills?: SkillsState;
  stats?: Stats;
}

export function hasEffect(e: { effects: ActiveEffect[] }, id: string): boolean {
  for (const x of e.effects) if (x.id === id) return true;
  return false;
}

/**
 * How hard an entity is to notice, 0 (obvious) .. 0.97 (practically invisible).
 * `darkness` 0..1 is the ambient darkness at the entity (night, caves) if known.
 */
export function stealthFactor(e: Checkable, darkness = 0): number {
  const sneaking = (e.flags & EntFlag.Sneaking) !== 0 || e.anim.move === 'crouch';
  let f = sneaking ? 0.35 : 0.05;
  f += Math.min(0.4, Math.max(-0.3, (e.stats?.stealth ?? 0) / 200));
  switch (e.anim.move) {
    case 'sprint': f -= 0.25; break;
    case 'run': f -= 0.1; break;
    case 'idle': case 'sit': case 'sleep': f += 0.1; break;
    case 'swim': f -= 0.05; break;
  }
  if (e.anim.action && e.anim.action.id !== 'block') f -= 0.15; // swinging, casting, working is noisy
  f += darkness * (sneaking ? 0.3 : 0.15);
  if (e.flags & EntFlag.Glowing) f -= 0.3;
  if (e.flags & EntFlag.Burning) f -= 0.4;
  if (hasEffect(e, 'marked') || hasEffect(e, 'exposed')) f -= 0.5;
  if (e.flags & EntFlag.Invisible) f = Math.max(f, 0.92);
  return Math.max(0, Math.min(0.97, f));
}

/**
 * Probability (per check, ~1 s) that `observer` notices `target` at `dist`
 * meters. `facing` 0..1 = how much the target is in front of the observer.
 */
export function detectionChance(observer: Checkable, target: Checkable, dist: number, facing = 1, darkness = 0): number {
  if (hasEffect(observer, 'blinded') || hasEffect(observer, 'asleep') || hasEffect(observer, 'stun')) return 0;
  const perception = Math.max(0, observer.stats?.perception ?? 10);
  const range = 10 + perception * 0.6; // meters where an unhidden target is always seen
  const distK = dist <= range ? 1 : Math.max(0, 1 - (dist - range) / (range * 1.5));
  const view = 0.35 + 0.65 * Math.max(0, Math.min(1, facing));
  const sf = stealthFactor(target, darkness);
  return Math.max(0, Math.min(1, distK * view * (1 - sf) * (0.7 + perception / 100)));
}

/** Chance 0.05..0.95 to pass a check of `difficulty` with an effective skill `level`. */
export function skillCheckChance(level: number, difficulty: number): number {
  const x = (level - difficulty) / 9;
  const p = 1 / (1 + Math.exp(-x));
  return Math.max(0.05, Math.min(0.95, p));
}

export interface SkillCheckResult {
  success: boolean;
  chance: number;
  roll: number;
  /** Positive = passed by that much (level − difficulty). */
  margin: number;
  level: number;
}

/**
 * Deterministic skill check: the roll derives from `rngSeed` (e.g. hash of
 * npc id + dialog node + day) so retrying the same check gives the same
 * result — no save-scumming dialog options.
 */
export function skillCheck(e: Checkable, skill: string, difficulty: number, rngSeed: number): SkillCheckResult {
  const level = effectiveLevel(e.skills, e.stats, skill);
  const chance = skillCheckChance(level, difficulty);
  const roll = hashToFloat(hashCombine(hash32(rngSeed), 0x5c1ec4));
  return { success: roll < chance, chance, roll, margin: level - difficulty, level };
}
