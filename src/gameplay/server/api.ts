/**
 * Public server-side gameplay API for other systems (creature & NPC AI,
 * dialog, settlements, items, game master). Everything goes through the
 * GameplaySystem registered as ctx.services.combat, so callers only need the
 * ServerContext.
 *
 *   useAbility(ctx, wolf, 'pounce'...)        AI casting (same rules as players)
 *   chooseAbility(ctx, mage, ['fireball',...]) pick a usable ability vs a target
 *   isIncapacitated / fearSource / tauntedBy   crowd-control queries for AI
 *   isDisplaced(ctx, id)                      pause locomotion while knocked back
 *   effectiveGravity(ctx, pos, e)             gravity incl. fields & effects
 *   checkSkill(ctx, e, skill, diff, seed)     dialog/skill checks with XP
 *   tryPickLock(ctx, e, difficulty, lockId)   locked doors/chests
 *   setFactionRelation / addAggro / setBaseStats
 */
import type { ServerContext } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { Vec3 } from '../../shared/types';
import type { AbilityUse, Stats } from '../types';
import { abilityDef, effectDef } from '../data/catalog';
import { effectiveCost } from '../shared/combat';
import { effectiveLevel } from '../shared/stats';
import { skillCheck, type SkillCheckResult } from '../shared/checks';
import { hashCombine, hashString } from '../../core/rng';
import { GameplaySystem } from './GameplaySystem';
import type { UseResult } from './abilities';
import { capsuleDist, chestOf, eyeOf, isVec3, vnorm, vsub } from './util';

export { effectiveGravity } from './zones';
export { masterOf, setMaster, isCombatant } from './util';
export { powerLevel } from './specials';
export { stealthFactor, detectionChance, skillCheck, skillCheckChance, hasEffect } from '../shared/checks';
export type { UseResult } from './abilities';

/** The gameplay system behind ctx.services.combat (null in foreign test contexts). */
export function gameplayOf(ctx: ServerContext): GameplaySystem | null {
  const c = ctx.services.combat as unknown;
  return c instanceof GameplaySystem ? c : null;
}

/**
 * Use an ability as any entity. `target` may be an entity (aimed at its
 * chest) or a world point; omitted = straight ahead. AI casters need no
 * unlocks but pay mana/stamina if they have stats and obey cooldowns.
 */
export function useAbility(ctx: ServerContext, caster: ServerEntity, abilityId: string, target?: ServerEntity | Vec3 | null, opts: { charge?: number } = {}): UseResult {
  const g = gameplayOf(ctx);
  if (!g) return { ok: false, reason: 'gameplay unavailable' };
  const use: AbilityUse = { ability: abilityId, charge: opts.charge };
  const eye = eyeOf(caster);
  if (target && !isVec3(target)) {
    use.target = target.id;
    use.point = chestOf(target);
    use.dir = vnorm(vsub(use.point, eye));
  } else if (isVec3(target)) {
    use.point = [target[0], target[1], target[2]];
    use.dir = vnorm(vsub(use.point, eye));
  }
  // Creatures without stats still get sane resources.
  if (!caster.stats) g.recomputeStats(caster);
  return g.abilities.use(caster, use, false);
}

/** Seconds until an ability is ready for this entity. */
export function abilityCooldown(ctx: ServerContext, e: ServerEntity, abilityId: string): number {
  return gameplayOf(ctx)?.abilities.readyIn(e, abilityId) ?? 0;
}

/** Could `caster` use this ability on `target` right now (cooldown, resources, range, not casting)? */
export function canUseAbility(ctx: ServerContext, caster: ServerEntity, abilityId: string, target?: ServerEntity | Vec3 | null): boolean {
  const g = gameplayOf(ctx);
  const def = abilityDef(abilityId);
  if (!g || !def || def.targeting === 'passive' || !caster.alive) return false;
  if (g.abilities.isCasting(caster) || g.abilities.readyIn(caster, abilityId) > 0) return false;
  if (isIncapacitated(caster)) return false;
  const cost = effectiveCost(def, effectiveLevel(caster.skills, caster.stats, def.skill));
  if (caster.stamina < cost.stamina || caster.mana < cost.mana) return false;
  if (target && def.range > 0) {
    const d = isVec3(target) ? Math.hypot(target[0] - caster.pos[0], target[1] - caster.pos[1], target[2] - caster.pos[2]) : capsuleDist(eyeOf(caster), target);
    if (def.targeting !== 'self' && def.targeting !== 'aura' && d > def.range) return false;
    if ((def.targeting === 'self' || def.targeting === 'aura') && def.radius && d > def.radius + 1) return false;
  }
  return true;
}

/** First usable ability from a priority list (AI helper). */
export function chooseAbility(ctx: ServerContext, caster: ServerEntity, candidates: string[], target?: ServerEntity | Vec3 | null): string | null {
  for (const id of candidates) if (canUseAbility(ctx, caster, id, target)) return id;
  return null;
}

/** Stunned, frozen, asleep... (AI should not move or act). */
export function isIncapacitated(e: ServerEntity): boolean {
  for (const x of e.effects) if (effectDef(x.id)?.incapacitate) return true;
  return false;
}

/** Rooted (can act but not move). */
export function isRooted(e: ServerEntity): boolean {
  return e.effects.some((x) => x.id === 'root' || x.id === 'stun' || x.id === 'frozen');
}

/** Entity id this entity is terrified of (it should flee), if any. */
export function fearSource(e: ServerEntity): number | undefined {
  return e.effects.find((x) => x.id === 'feared')?.source;
}

/** Entity id that taunted this entity (it should attack it), if any. */
export function tauntedBy(e: ServerEntity): number | undefined {
  return e.effects.find((x) => x.id === 'taunted')?.source;
}

/** Being flung by knockback/pull right now (AI should not steer). */
export function isDisplaced(ctx: ServerContext, id: number): boolean {
  return gameplayOf(ctx)?.mover.isMoving(id) ?? false;
}

/**
 * Server skill check with use-based XP (dialog options, quest checks).
 * Deterministic for a given seed. Grants more XP for hard successes.
 */
export function checkSkill(ctx: ServerContext, e: ServerEntity, skill: string, difficulty: number, seed: number, grantXp = true): SkillCheckResult {
  const r = skillCheck(e, skill, difficulty, seed);
  if (grantXp) ctx.services.skills.grantXp(e, skill, r.success ? 4 + Math.max(0, -r.margin) * 0.3 : 1.5);
  return r;
}

/**
 * Attempt to pick a lock of `difficulty` (0..100). Uses the lockpicking
 * skill, boosted while the Pick Lock ability is active. Returns success;
 * grants XP either way. `lockId` makes repeated attempts vary per minute.
 */
export function tryPickLock(ctx: ServerContext, e: ServerEntity, difficulty: number, lockId: string | number): boolean {
  const g = gameplayOf(ctx);
  const prepared = g ? g.specials.lockPower(e) : 0;
  const lvl = Math.max(prepared, effectiveLevel(e.skills, e.stats, 'lockpicking'));
  const seed = hashCombine(hashString(String(lockId)), Math.floor(ctx.time.now / 60) + e.id * 7919);
  const r = skillCheck({ ...e, skills: undefined, stats: { ...(e.stats as Stats), skillBonus: { lockpicking: lvl } } }, 'lockpicking', difficulty, seed);
  ctx.services.skills.grantXp(e, 'lockpicking', r.success ? 6 + difficulty * 0.1 : 2);
  if (g && r.success) g.effects.remove(e, 'lockpicking');
  ctx.broadcast({ type: 'sound', sound: r.success ? 'lock_open' : 'lock_fail', pos: [...e.pos] as Vec3 }, e.pos);
  return r.success;
}

export function setFactionRelation(ctx: ServerContext, a: string, b: string, hostile: boolean) {
  gameplayOf(ctx)?.setFactionRelation(a, b, hostile);
}

/** Make two entities (and their masters) fight for `seconds`. */
export function addAggro(ctx: ServerContext, a: ServerEntity, b: ServerEntity, seconds = 30) {
  gameplayOf(ctx)?.addAggro(a, b, seconds);
}

/** Base stats for creatures/NPC templates (hp pool, regen, armor, resists...). */
export function setBaseStats(ctx: ServerContext, e: ServerEntity, base: Partial<Stats>) {
  gameplayOf(ctx)?.setBaseStats(e, base);
}
