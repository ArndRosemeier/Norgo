/**
 * Wandering NPCs (caravans, pilgrims, adventurers, refugees, bards, messengers)
 * and bandit camp populations. Records are deterministic from (kind, seed) so
 * a saved wanderer regenerates identically; their runtime is handled by the
 * NpcSystem like any other NPC, with a travel itinerary instead of a home.
 */
import { Rng, deriveSeed } from '../core/rng';
import { clamp } from '../core/math';
import type { Vec3 } from '../shared/types';
import type { RaceId } from '../humanoid/types';
import type { Deity, NpcJob, NpcTraits } from './types';
import type { NpcRecord } from './population';
import { appearanceAgeFor } from './population';
import { JOBS } from './jobs';
import { RACE_LIFE, composeBio, jobTitle, patronDeity, personName, ambitionFor } from './culture';

export type WandererKind =
  | 'caravan' | 'guard' | 'pilgrim' | 'bandit' | 'adventurer' | 'hunter' | 'bard' | 'refugee' | 'scholar' | 'messenger' | 'mage' | 'healer'
  | 'bounty_hunter' | 'angry_owner';

const KIND_JOB: Record<WandererKind, NpcJob> = {
  caravan: 'merchant', guard: 'guard', pilgrim: 'pilgrim', bandit: 'bandit', adventurer: 'adventurer', hunter: 'hunter', bard: 'bard',
  refugee: 'beggar', scholar: 'scholar', messenger: 'adventurer', mage: 'mage', healer: 'healer', bounty_hunter: 'guard', angry_owner: 'farmer',
};

const KIND_TITLE: Partial<Record<WandererKind, string>> = {
  caravan: 'Travelling Merchant', guard: 'Caravan Guard', bounty_hunter: 'Bounty Hunter', angry_owner: 'Wronged Householder', messenger: 'Messenger', refugee: 'Refugee',
};

export function normalizeKind(kind: string): WandererKind {
  const k = kind.toLowerCase();
  if (k in KIND_JOB) return k as WandererKind;
  if (k.includes('merchant') || k.includes('trader') || k.includes('caravan')) return 'caravan';
  if (k.includes('bounty')) return 'bounty_hunter';
  if (k.includes('owner') || k.includes('victim')) return 'angry_owner';
  if (k.includes('courier') || k.includes('herald')) return 'messenger';
  if (k.includes('bandit') || k.includes('raider') || k.includes('brigand')) return 'bandit';
  if (k.includes('pilgrim') || k.includes('monk') || k.includes('priest')) return 'pilgrim';
  if (k.includes('refugee') || k.includes('beggar')) return 'refugee';
  if (k.includes('bard') || k.includes('minstrel')) return 'bard';
  if (k.includes('scholar') || k.includes('sage')) return 'scholar';
  if (k.includes('wizard') || k.includes('mage')) return 'mage';
  return 'adventurer';
}

export interface WandererSpec {
  kind: WandererKind;
  seed: number;
  /** Spawn position. */
  pos: Vec3;
  /** Race pool to draw from (world races weighted by nearby culture). */
  races: RaceId[];
  gods: Deity[];
  /** Origin place name (for bio). */
  origin: string | null;
  /** Bandit camp id when part of a camp. */
  camp?: string;
  /** Group index (escorts of a caravan). */
  index?: number;
}

function traits(rng: Rng, bias?: Partial<NpcTraits>): NpcTraits {
  const r = () => clamp(rng.gaussian(0, 0.42), -1, 1);
  const t: NpcTraits = { openness: r(), conscientiousness: r(), extraversion: r(), agreeableness: r(), neuroticism: r(), courage: r(), greed: r(), piety: r() };
  if (bias) for (const k of Object.keys(bias) as (keyof NpcTraits)[]) t[k] = clamp(t[k] + (bias[k] ?? 0), -1, 1);
  return t;
}

/** Deterministic record for a wanderer / camp member. */
export function wandererRecord(worldSeed: number, w: WandererSpec): NpcRecord {
  const rng = new Rng(deriveSeed(worldSeed, 'wanderer', w.kind, w.seed, w.index ?? 0));
  const job = KIND_JOB[w.kind];
  const race = rng.pick(w.races.length ? w.races : (['human'] as RaceId[]));
  const L = RACE_LIFE[race];
  const elderly = w.kind === 'pilgrim' && rng.chance(0.4);
  const age = elderly ? rng.range(L.elderAge, L.maxAge * 0.9) : rng.range(L.adultAge + 1, L.elderAge - 1);
  const gender = rng.chance(w.kind === 'bandit' || w.kind === 'guard' ? 0.7 : 0.5) ? rng.range(0.7, 1) : rng.range(0, 0.3);
  const nm = personName(race, gender, rng);
  const t = traits(rng, JOBS[job].traitBias);
  const deity = t.piety > -0.2 || job === 'pilgrim' ? patronDeity(w.gods, race, job, rng) : null;
  const factions = w.kind === 'bandit' ? [`bandits:${w.camp ?? 'roaming'}`] : w.kind === 'bounty_hunter' ? ['bounty_hunters'] : w.kind === 'pilgrim' && deity ? ['travelers', `faith:${deity.id}`] : ['travelers'];
  const wealth = clamp(JOBS[job].wealth + rng.gaussian(0, 0.1), 0, 1);
  const stage = elderly ? 'elder' : 'adult';
  const leaderOfCamp = w.kind === 'bandit' && !!w.camp && (w.index ?? 0) === 0;
  return {
    id: w.camp ? `C:${w.camp}#${w.index ?? 0}` : `W:${w.kind}:${w.seed}:${w.index ?? 0}`,
    siteId: null, seed: deriveSeed(worldSeed, 'wnpc', w.kind, w.seed, w.index ?? 0), given: nm.given, family: nm.family, name: leaderOfCamp ? `${nm.given} the ${rng.pick(['Red', 'Butcher', 'Knife', 'Crow', 'Wolf', 'Grinning'])}` : nm.full,
    race, race2: null, raceMix: 0, gender, age: Math.round(age), ageStage: stage, job, captain: leaderOfCamp, leader: leaderOfCamp, traits: t, wealth, household: -1,
    homeBuilding: null, bed: [w.pos[0], w.pos[1], w.pos[2]], bedYaw: 0, workBuilding: null, work: [w.pos[0], w.pos[1], w.pos[2]], workYaw: 0, outskirts: true,
    schedule: JOBS[job].schedule, nightShift: false, relations: {}, factions, deity: deity?.id ?? null,
    title: leaderOfCamp ? 'Bandit Chief' : w.kind === 'bandit' ? 'Bandit' : KIND_TITLE[w.kind] ?? jobTitle(job, null, rng, { ageStage: stage }),
    bio: composeBio({ name: nm.given, race, race2: null, gender, age: Math.round(age), ageStage: stage, job, traits: t, place: null, children: 0, linkedPlace: w.origin, deity, wealth }, rng.fork('bio')),
    ambition: ambitionFor(job, t, rng.fork('amb')), appearanceAge: appearanceAgeFor(race, age),
  };
}

/** Bandit camp strength (number of bandits) from the POI seed. */
export function campSize(poiSeed: number): number {
  return 3 + (deriveSeed(poiSeed, 'camp-size') % 4);
}
