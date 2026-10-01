/**
 * Tab-targeting rules shared by the client targeting system and the HUD: who counts as a
 * target, how hostile it is to the local player, and the stable cycling order. Pure functions
 * (no three.js / DOM) so they can be tested headlessly.
 */
import type { EntitySnapshot } from '../shared/protocol';
import type { EntityId } from '../shared/types';
import { EntFlag } from '../shared/types';

/** How the target relates to the local player (ring & frame colour). */
export type Disposition = 'hostile' | 'neutral' | 'friendly';

/** Tab only picks targets this close to the player (m). */
export const TARGET_PICK_RANGE = 35;
/** A target further than this is dropped (m). */
export const TARGET_KEEP_RANGE = 50;
/** Seconds a target may stay out of line of sight before it is dropped. */
export const TARGET_LOS_GRACE = 4;
/** Seconds a dead target stays selected (frame shows "Dead") before it clears. */
export const TARGET_DEAD_LINGER = 1.4;
/** Repeated presses within this window keep walking the previous order (s). */
export const CYCLE_MEMORY = 6;

/** Entities tab can select: living creatures, NPCs and other players. */
export function isTargetable(s: EntitySnapshot, playerId: EntityId): boolean {
  if (s.id === playerId) return false;
  if (s.kind !== 'creature' && s.kind !== 'npc' && s.kind !== 'player') return false;
  if (s.hp <= 0) return false;
  return (s.flags & EntFlag.Invisible) === 0;
}

export function dispositionOf(s: EntitySnapshot, playerId: EntityId): Disposition {
  if (s.kind === 'player') return 'friendly';
  const hostile = (s.flags & EntFlag.Hostile) !== 0 || s.faction === 'hostile' || (s.target === playerId && (s.flags & EntFlag.InCombat) !== 0);
  if (hostile) return 'hostile';
  if (s.kind === 'creature') return (s.flags & EntFlag.Tamed) !== 0 ? 'friendly' : 'neutral';
  return 'friendly';
}

/** Actively fighting or hunting the local player. */
export function isEngaged(s: EntitySnapshot, playerId: EntityId): boolean {
  return s.target === playerId && ((s.flags & EntFlag.Hostile) !== 0 || (s.flags & EntFlag.InCombat) !== 0);
}

export interface RankInput {
  id: EntityId;
  disposition: Disposition;
  engaged: boolean;
  /** Angle between the camera aim and the direction to the target (radians). */
  angle: number;
  /** Distance from the player (m). */
  dist: number;
}

/**
 * Order candidates: hostile first (those already after the player slightly ahead), then neutral,
 * then friendly; inside a tier, closest to the crosshair wins with distance as a tie-breaker.
 */
export function rankTargets(c: RankInput[]): EntityId[] {
  const tier = (d: Disposition) => (d === 'hostile' ? 0 : d === 'neutral' ? 1 : 2);
  const score = (r: RankInput) => r.angle / 0.6 + r.dist / TARGET_PICK_RANGE - (r.engaged ? 0.35 : 0);
  return [...c]
    .sort((a, b) => tier(a.disposition) - tier(b.disposition) || score(a) - score(b) || a.id - b.id)
    .map((r) => r.id);
}

/**
 * Keep a cycling order stable across presses: still-valid ids keep their previous position,
 * newcomers are appended in their ranked order.
 */
export function mergeCycle(prev: readonly EntityId[], ranked: readonly EntityId[]): EntityId[] {
  const valid = new Set(ranked);
  const kept = prev.filter((id) => valid.has(id));
  const seen = new Set(kept);
  return [...kept, ...ranked.filter((id) => !seen.has(id))];
}

/**
 * Next (dir 1) or previous (dir -1) target in `order` after `current`. Without a current target
 * (or when it is not in the list) both directions start at the best candidate.
 */
export function stepCycle(order: readonly EntityId[], current: EntityId | null, dir: 1 | -1): EntityId | null {
  if (!order.length) return null;
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return order[0];
  return order[(i + dir + order.length) % order.length];
}
