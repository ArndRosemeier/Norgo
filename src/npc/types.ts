/** NPC public profile (shared); internal mind state lives on the server. */
import type { RaceId } from '../humanoid/types';

export type NpcJob =
  | 'farmer' | 'smith' | 'merchant' | 'innkeeper' | 'guard' | 'priest' | 'hunter' | 'scholar' | 'mage' | 'miner'
  | 'woodcutter' | 'fisher' | 'healer' | 'bard' | 'child' | 'elder' | 'noble' | 'beggar' | 'thief' | 'bandit'
  | 'adventurer' | 'pilgrim' | 'herder' | 'cook' | 'tailor' | 'alchemist' | 'carpenter' | 'mason';

export const NPC_JOBS: NpcJob[] = [
  'farmer', 'smith', 'merchant', 'innkeeper', 'guard', 'priest', 'hunter', 'scholar', 'mage', 'miner',
  'woodcutter', 'fisher', 'healer', 'bard', 'child', 'elder', 'noble', 'beggar', 'thief', 'bandit',
  'adventurer', 'pilgrim', 'herder', 'cook', 'tailor', 'alchemist', 'carpenter', 'mason',
];

/** Personality, each -1..1. */
export interface NpcTraits {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
  courage: number;
  greed: number;
  piety: number;
}

export type TraitId = keyof NpcTraits;

/** Physiological / psychological needs, 0 = desperate .. 1 = fully satisfied. */
export type NeedId = 'hunger' | 'energy' | 'social' | 'fun' | 'safety' | 'wealth' | 'faith';
export const NEED_IDS: NeedId[] = ['hunger', 'energy', 'social', 'fun', 'safety', 'wealth', 'faith'];

export type AgeStage = 'child' | 'adult' | 'elder';

/** Kinds of interpersonal ties between NPCs (and towards players). */
export type RelationKind =
  | 'spouse' | 'parent' | 'child' | 'sibling' | 'friend' | 'rival' | 'crush' | 'mentor' | 'apprentice'
  | 'creditor' | 'debtor' | 'enemy' | 'colleague' | 'neighbor';

export interface NpcRelationInfo {
  /** Other NPC's stable record id. */
  id: string;
  name: string;
  kind: RelationKind;
  /** Affinity -100..100. */
  affinity: number;
}

/** A god of the world's pantheon (generated per world seed). */
export interface Deity {
  id: string;
  name: string;
  /** e.g. "the Ember Mother". */
  epithet: string;
  /** e.g. "forge", "harvest", "sea", "death", "stars". */
  domain: string;
}

export interface NpcProfile {
  id: string;
  name: string;
  race: RaceId;
  job: NpcJob;
  /** Settlement site id (home), or null for wanderers. */
  home: string | null;
  /** Big-five-ish personality traits, -1..1. */
  traits: NpcTraits;
  /** Short generated biography. */
  bio: string;
  /** Faction ids. */
  factions: string[];

  // ---- optional extensions (NPC module) ----
  /** Secondary heritage for mixed-race NPCs. */
  race2?: RaceId | null;
  /** Age in years and coarse life stage. */
  age?: number;
  ageStage?: AgeStage;
  /** 0 = female .. 1 = male (continuous, mirrors HumanoidAppearance.gender). */
  gender?: number;
  /** Display title, e.g. "Smith of Oakford". */
  title?: string;
  /** Family / clan name if the culture uses one. */
  family?: string | null;
  /** Personal wealth 0..1. */
  wealth?: number;
  /** Settlement display name. */
  homeName?: string;
  /** Notable relations (family, friends, rivals...). */
  relations?: NpcRelationInfo[];
  /** Human-readable description of the current long-term goal, if any. */
  goal?: string;
  /** Current activity label ("working at the forge", "asleep"...). */
  activity?: string;
  /** Patron deity id, if devout. */
  deity?: string;
  alive?: boolean;
}

/**
 * Extended introspection API offered by the NpcSystem on top of `NpcService`.
 * Other domains may feature-detect these methods on `ctx.services.npcs`
 * (e.g. `(ctx.services.npcs as Partial<NpcIntrospection>).priceModifier?.(...)`).
 */
export interface NpcIntrospection {
  /** Price multiplier an NPC merchant applies for this player (barter checks, disposition). 1 = neutral. */
  priceModifier(npc: number, player: number): number;
  /** Add a rumor to a settlement (or globally when siteId is null) — e.g. from the game master. */
  addRumor(siteId: string | null, text: string, importance: number, pos?: [number, number, number]): void;
  /** Is this entity an NPC simulated by the NPC module. */
  isNpc(entityId: number): boolean;
}
