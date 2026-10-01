/**
 * Deterministic settlement population: households (couples, children, elders,
 * mixed-heritage families), jobs derived from the buildings that exist, homes &
 * beds, workplaces, relationships (family, friends, rivals, crushes, debts,
 * mentors), factions & guilds, names per culture, ages, personalities and bios.
 *
 * Output depends only on (world seed, site, layout) so every client/server and
 * every reload produce the same people. Dynamic state (needs, memories, deaths)
 * lives separately in `NpcState` (mind.ts).
 */
import { Rng, deriveSeed } from '../core/rng';
import { clamp } from '../core/math';
import type { Vec3 } from '../shared/types';
import type { RaceId } from '../humanoid/types';
import type { SiteInfo } from '../world/sites';
import type { BuildingInfo, SettlementLayout, SmartSpot } from '../settlements/types';
import type { AgeStage, Deity, NpcJob, NpcTraits, RelationKind } from './types';
import { JOBS, ROLE_JOBS, HOME_ROLES, personalSchedule, type ActivityKind } from './jobs';
import { RACE_LIFE, composeBio, jobTitle, patronDeity, personName, familyName, ambitionFor } from './culture';
import type { HeightProbe } from './layout';
import { SEA_LEVEL } from '../world/constants';

export interface NpcRel {
  kind: RelationKind;
  /** Generated base affinity -100..100. */
  affinity: number;
}

/** Static, regenerable description of one inhabitant. */
export interface NpcRecord {
  id: string;
  siteId: string | null;
  seed: number;
  given: string;
  family: string | null;
  name: string;
  race: RaceId;
  race2: RaceId | null;
  raceMix: number;
  gender: number;
  age: number;
  ageStage: AgeStage;
  job: NpcJob;
  captain: boolean;
  leader: boolean;
  traits: NpcTraits;
  wealth: number;
  household: number;
  homeBuilding: string | null;
  bed: Vec3;
  bedYaw: number;
  workBuilding: string | null;
  work: Vec3;
  workYaw: number;
  /** Work happens outside the core (fields, woods, mine, shore...). */
  outskirts: boolean;
  schedule: [number, ActivityKind][];
  nightShift: boolean;
  relations: Record<string, NpcRel>;
  factions: string[];
  deity: string | null;
  title: string;
  bio: string;
  ambition: string;
  /** MakeHuman age parameter for randomAppearance. */
  appearanceAge: number;
}

export interface PopulationContext {
  worldSeed: number;
  site: SiteInfo;
  layout: SettlementLayout;
  gods: Deity[];
  height: HeightProbe;
  /** Lower-case biome name ("temperate forest"). */
  biomeName: string;
  /** Names of linked settlements (origins for immigrants). */
  linkedNames: string[];
  /** Races present in the world (for the occasional outsider). */
  worldRaces: RaceId[];
}

const CAP = { hamlet: 12, village: 24, town: 38, city: 54 } as const;

/** Race attitude matrix: how folk of race A instinctively regard race B (-1..1). Asymmetric on purpose. */
export const RACE_ATTITUDE: Partial<Record<RaceId, Partial<Record<RaceId, number>>>> = {
  elf: { orc: -0.5, goblin: -0.4, dwarf: -0.15, sylvan: 0.35, umbral: -0.2 },
  dwarf: { goblin: -0.6, elf: -0.2, orc: -0.3, giantkin: 0.15, drakeborn: 0.1 },
  orc: { elf: -0.4, dwarf: -0.2, giantkin: 0.2, goblin: 0.1 },
  goblin: { dwarf: -0.4, halfling: 0.1, umbral: 0.2 },
  halfling: { goblin: -0.25, human: 0.2, giantkin: -0.1 },
  human: { umbral: -0.15, goblin: -0.15, orc: -0.1 },
  sylvan: { drakeborn: -0.3, dwarf: -0.1, elf: 0.3 },
  drakeborn: { sylvan: -0.15, umbral: -0.2, giantkin: 0.1 },
  umbral: { human: -0.1, elf: -0.2 },
  giantkin: { halfling: 0.15, dwarf: 0.1, goblin: -0.2 },
};

/** Map a race-relative age to the MakeHuman age parameter (0.1875 = 11y, 0.5 = 25y, 1 = 90y human-equivalent). */
export function appearanceAgeFor(race: RaceId, age: number): number {
  const L = RACE_LIFE[race];
  // Piecewise: childhood scales with adultAge, adulthood with the remaining span.
  let y: number;
  if (age < L.adultAge) y = (age / L.adultAge) * 18;
  else if (age < L.elderAge) y = 18 + ((age - L.adultAge) / Math.max(1, L.elderAge - L.adultAge)) * 42;
  else y = 60 + ((age - L.elderAge) / Math.max(1, L.maxAge - L.elderAge)) * 30;
  if (y <= 11) return (y / 11) * 0.1875;
  if (y <= 25) return 0.1875 + ((y - 11) / 14) * 0.3125;
  return clamp(0.5 + ((y - 25) / 65) * 0.5, 0, 1);
}

function stageOf(race: RaceId, age: number): AgeStage {
  const L = RACE_LIFE[race];
  return age < L.adultAge ? 'child' : age >= L.elderAge ? 'elder' : 'adult';
}

function rollTraits(rng: Rng, bias?: Partial<NpcTraits>, race?: RaceId): NpcTraits {
  const r = () => clamp(rng.gaussian(0, 0.42), -1, 1);
  const t: NpcTraits = { openness: r(), conscientiousness: r(), extraversion: r(), agreeableness: r(), neuroticism: r(), courage: r(), greed: r(), piety: r() };
  // Cultural nudges keep races recognisable without making individuals identical.
  const rb: Partial<Record<RaceId, Partial<NpcTraits>>> = {
    dwarf: { conscientiousness: 0.2, extraversion: -0.1, greed: 0.1 }, elf: { openness: 0.2, extraversion: -0.15 }, orc: { courage: 0.25, agreeableness: -0.15 },
    halfling: { agreeableness: 0.2, extraversion: 0.15, courage: -0.1 }, goblin: { neuroticism: 0.25, greed: 0.2, conscientiousness: -0.15 },
    sylvan: { openness: 0.2, piety: 0.15, greed: -0.2 }, drakeborn: { courage: 0.2, greed: 0.1 }, umbral: { extraversion: -0.25, openness: 0.15 },
    giantkin: { agreeableness: 0.1, neuroticism: -0.15 },
  };
  const all = [race ? rb[race] : undefined, bias];
  for (const b of all) if (b) for (const k of Object.keys(b) as (keyof NpcTraits)[]) t[k] = clamp(t[k] + (b[k] ?? 0), -1, 1);
  return t;
}

interface Person {
  idx: number;
  race: RaceId;
  race2: RaceId | null;
  raceMix: number;
  gender: number;
  age: number;
  stage: AgeStage;
  household: number;
  home: BuildingInfo | null;
  family: string | null;
  given: string;
  full: string;
  job: NpcJob | null;
  jobBuilding: BuildingInfo | null;
  traits: NpcTraits;
  rels: Record<number, NpcRel>;
  captain: boolean;
  leader: boolean;
  spouse: number;
  parents: number[];
  children: number[];
  widowed: boolean;
}

/** Generate the full population of a settlement. Deterministic. */
export function generatePopulation(pc: PopulationContext): NpcRecord[] {
  const { site, layout } = pc;
  const rng = new Rng(deriveSeed(pc.worldSeed, 'npc-pop', site.id));
  const primary = site.race as RaceId;
  const secondary = (site.race2 as RaceId | null) ?? null;
  const cap = CAP[site.size];
  const wantPop = clamp(Math.round(layout.population || 0), Math.min(6, cap), cap) || cap;

  // ---- homes
  let homes = layout.buildings.filter((b) => b.residents > 0 && (HOME_ROLES.includes(b.role) || b.role === 'smithy' || b.role === 'workshop'));
  if (!homes.length) homes = layout.buildings.filter((b) => b.role !== 'well' && b.role !== 'wall' && b.role !== 'gate' && b.role !== 'ruin');
  homes = homes.slice();
  // Barracks house guards, taverns their keepers; ordinary homes host families.
  const people: Person[] = [];
  const usedGiven = new Set<string>();
  let hh = 0;
  const raceForHousehold = (): RaceId => {
    if (secondary && rng.chance(0.32)) return secondary;
    if (rng.chance(0.04) && pc.worldRaces.length > 1) return rng.pick(pc.worldRaces);
    return primary;
  };
  const L = (r: RaceId) => RACE_LIFE[r];
  const newPerson = (race: RaceId, gender: number, age: number, household: number, home: BuildingInfo | null, family: string | null, parentGiven?: string, parentGender?: number): Person => {
    // Re-roll given names already taken in this settlement (no three Wrens on one street).
    let nm = personName(race, gender, rng, { family, parentGiven, parentGender });
    for (let k = 0; k < 8 && usedGiven.has(nm.given); k++) nm = personName(race, gender, rng, { family, parentGiven, parentGender });
    usedGiven.add(nm.given);
    const p: Person = {
      idx: people.length, race, race2: null, raceMix: 0, gender, age, stage: stageOf(race, age), household, home,
      family: nm.family, given: nm.given, full: nm.full, job: null, jobBuilding: null, traits: rollTraits(rng, undefined, race), rels: {}, captain: false, leader: false,
      spouse: -1, parents: [], children: [], widowed: false,
    };
    people.push(p);
    return p;
  };
  const relate = (a: Person, b: Person, ka: RelationKind, kb: RelationKind, aff: number) => {
    a.rels[b.idx] = { kind: ka, affinity: aff };
    b.rels[a.idx] = { kind: kb, affinity: aff };
  };
  const adultAge = (r: RaceId) => rng.range(L(r).adultAge + 1, L(r).elderAge - 2);

  let homeCursor = 0;
  while (people.length < wantPop && homes.length) {
    const home = homes[homeCursor % homes.length];
    homeCursor++;
    if (homeCursor > homes.length * 3) break;
    const capHome = Math.max(1, Math.min(home.residents || 3, wantPop - people.length));
    const household = hh++;
    if (home.role === 'barracks') {
      for (let i = 0; i < capHome && people.length < wantPop; i++) {
        const race = raceForHousehold();
        const p = newPerson(race, rng.chance(0.3) ? rng.range(0, 0.3) : rng.range(0.7, 1), adultAge(race), household, home, familyName(race, rng));
        p.job = 'guard';
        p.jobBuilding = home;
      }
      continue;
    }
    const roll = rng.float();
    const race = raceForHousehold();
    const fam = familyName(race, rng);
    if (roll < 0.58 && capHome >= 2) {
      // Couple, possibly mixed, with children and maybe an elder parent.
      const g1 = rng.chance(0.5) ? rng.range(0.75, 1) : rng.range(0, 0.25);
      const sameSex = rng.chance(0.08);
      const g2 = sameSex ? g1 : 1 - g1;
      const a = newPerson(race, g1, adultAge(race), household, home, fam);
      let race2: RaceId = race;
      if (secondary && secondary !== race && rng.chance(0.18)) race2 = secondary;
      else if (secondary === race && rng.chance(0.18)) race2 = primary;
      const b = newPerson(race2, g2, clamp(a.age + rng.gaussian(0, L(race).adultAge * 0.2), L(race2).adultAge + 1, L(race2).elderAge - 1), household, home, race2 === race ? fam : fam ?? familyName(race2, rng));
      a.spouse = b.idx;
      b.spouse = a.idx;
      relate(a, b, 'spouse', 'spouse', Math.round(rng.range(20, 90) * (rng.chance(0.12) ? -0.5 : 1)));
      const kids = sameSex ? rng.int(0, 1) : Math.min(capHome - 2, rng.weighted([0, 1, 2, 3, 4], (_, i) => [2, 3, 3, 1.5, 0.5][i]));
      const mother = a.gender < 0.5 ? a : b;
      const father = a.gender < 0.5 ? b : a;
      for (let k = 0; k < kids && people.length < wantPop; k++) {
        const kr = mother.race;
        const maxKidAge = Math.max(2, Math.min(L(kr).adultAge * 0.95, Math.min(a.age, b.age) - L(kr).adultAge * 0.9));
        const cage = rng.range(Math.min(3, maxKidAge * 0.5), maxKidAge);
        const c = newPerson(kr, rng.float(), cage, household, home, fam, father.given, father.gender);
        if (mother.race !== father.race) {
          c.race = rng.chance(0.5) ? mother.race : father.race;
          c.race2 = c.race === mother.race ? father.race : mother.race;
          c.raceMix = rng.range(0.3, 0.6);
          c.stage = stageOf(c.race, c.age);
        }
        c.parents = [a.idx, b.idx];
        a.children.push(c.idx);
        b.children.push(c.idx);
        relate(c, a, 'parent', 'child', Math.round(rng.range(30, 95)));
        relate(c, b, 'parent', 'child', Math.round(rng.range(30, 95)));
      }
      // Siblings.
      for (const i of a.children) for (const j of a.children) if (i < j) relate(people[i], people[j], 'sibling', 'sibling', Math.round(rng.range(-20, 85)));
      if (rng.chance(0.2) && people.length < wantPop && home.residents > 2 + kids) {
        const gp = newPerson(a.race, rng.float(), rng.range(L(a.race).elderAge, L(a.race).maxAge * 0.92), household, home, fam);
        a.parents.push(gp.idx);
        gp.children.push(a.idx);
        gp.widowed = true;
        relate(a, gp, 'parent', 'child', Math.round(rng.range(10, 90)));
      }
    } else if (roll < 0.7 && capHome >= 2) {
      // Widowed parent with children.
      const parent = newPerson(race, rng.float(), adultAge(race) + L(race).adultAge * 0.3, household, home, fam);
      parent.widowed = true;
      const kids = rng.int(1, Math.min(3, capHome - 1));
      for (let k = 0; k < kids && people.length < wantPop; k++) {
        const c = newPerson(race, rng.float(), rng.range(3, Math.max(4, L(race).adultAge * 0.95)), household, home, fam, parent.given, parent.gender);
        c.parents = [parent.idx];
        parent.children.push(c.idx);
        relate(c, parent, 'parent', 'child', Math.round(rng.range(40, 95)));
      }
      for (const i of parent.children) for (const j of parent.children) if (i < j) relate(people[i], people[j], 'sibling', 'sibling', Math.round(rng.range(0, 80)));
    } else if (roll < 0.8 && capHome >= 2) {
      // Grown siblings sharing a house.
      const n = Math.min(capHome, rng.int(2, 3));
      const sibs: Person[] = [];
      for (let k = 0; k < n && people.length < wantPop; k++) sibs.push(newPerson(race, rng.float(), adultAge(race), household, home, fam));
      for (const x of sibs) for (const y of sibs) if (x.idx < y.idx) relate(x, y, 'sibling', 'sibling', Math.round(rng.range(-30, 80)));
    } else if (roll < 0.88) {
      // Elderly person or couple.
      const e1 = newPerson(race, rng.float(), rng.range(L(race).elderAge, L(race).maxAge * 0.95), household, home, fam);
      if (capHome >= 2 && rng.chance(0.55) && people.length < wantPop) {
        const e2 = newPerson(race, 1 - e1.gender, clamp(e1.age + rng.gaussian(0, 4), L(race).elderAge, L(race).maxAge), household, home, fam);
        e1.spouse = e2.idx;
        e2.spouse = e1.idx;
        relate(e1, e2, 'spouse', 'spouse', Math.round(rng.range(30, 95)));
      } else e1.widowed = rng.chance(0.7);
    } else {
      newPerson(race, rng.float(), adultAge(race), household, home, fam);
    }
  }

  // ---- jobs from buildings
  interface Slot { job: NpcJob; b: BuildingInfo; prio: number }
  const slots: Slot[] = [];
  for (const b of layout.buildings) {
    const list = ROLE_JOBS[b.role];
    if (!list) continue;
    list.forEach(([job, w], i) => {
      if (i === 0 || rng.chance(w)) slots.push({ job, b, prio: (i === 0 ? 2 : 1) * w + rng.float() * 0.1 });
    });
  }
  slots.sort((a, b) => b.prio - a.prio);
  // Guards are pre-assigned in barracks; count them against slots.
  const adults = people.filter((p) => p.stage === 'adult' && !p.job);
  const elders = people.filter((p) => p.stage === 'elder');
  const fit = (p: Person, job: NpcJob) => {
    const bias = JOBS[job].traitBias ?? {};
    let s = 0;
    for (const k of Object.keys(bias) as (keyof NpcTraits)[]) s += (bias[k] ?? 0) * p.traits[k];
    return s + rng.float() * 0.6;
  };
  for (const slot of slots) {
    if (slot.job === 'guard' && people.filter((p) => p.job === 'guard').length >= Math.max(2, Math.round(wantPop / 7))) continue;
    if (slot.job === 'elder') {
      const e = elders.filter((p) => !p.job).sort((a, b) => b.age - a.age)[0];
      if (e) {
        e.job = 'elder';
        e.jobBuilding = slot.b;
        continue;
      }
    }
    const pool = adults.filter((p) => !p.job);
    if (!pool.length) break;
    pool.sort((a, b) => fit(b, slot.job) - fit(a, slot.job));
    const p = pool[0];
    p.job = slot.job;
    p.jobBuilding = slot.b;
  }
  // Remaining adults: land-based or urban occupations.
  const biome = pc.biomeName;
  const nearWater = findShore(pc) !== null;
  const landJobs: [NpcJob, number][] = [
    ['farmer', /grass|savanna|forest|jungle/.test(biome) ? 3 : 1.2],
    ['woodcutter', /forest|taiga|jungle/.test(biome) ? 2.2 : 0.4],
    ['miner', (primary === 'dwarf' ? 2.5 : 0.6) + (/badlands|tundra|volcanic|crystal|karst/.test(biome) ? 1.5 : 0)],
    ['hunter', 1.2],
    ['herder', /grass|savanna|tundra|steppe/.test(biome) ? 1.5 : 0.5],
    ['fisher', nearWater ? 2.2 : 0],
    ['carpenter', 0.5], ['mason', primary === 'dwarf' || primary === 'giantkin' ? 0.9 : 0.4], ['cook', 0.4], ['tailor', 0.4],
    ['healer', 0.3], ['bard', site.size === 'hamlet' ? 0.1 : 0.35], ['beggar', site.size === 'city' ? 0.6 : site.size === 'town' ? 0.3 : 0.05],
    ['thief', site.size === 'city' ? 0.45 : site.size === 'town' ? 0.25 : 0.02], ['adventurer', 0.2], ['alchemist', 0.15],
  ];
  for (const p of adults) {
    if (p.job) continue;
    const w = landJobs.map(([j, x]) => [j, x * (1 + fit(p, j))] as [NpcJob, number]);
    p.job = rng.weighted(w, (x) => x[1])[0];
  }
  for (const p of people) {
    if (p.job) continue;
    if (p.stage === 'child') p.job = 'child';
    else if (p.stage === 'elder') p.job = rng.chance(0.65) ? 'elder' : rng.pick<NpcJob>(['farmer', 'scholar', 'healer', 'priest', 'tailor']);
  }
  // Leader: noble if any, else the eldest elder, else the oldest adult (who becomes elder).
  const noble = people.find((p) => p.job === 'noble');
  const leader = noble ?? people.filter((p) => p.job === 'elder').sort((a, b) => b.age - a.age)[0] ?? people.filter((p) => p.stage !== 'child').sort((a, b) => b.age - a.age)[0];
  if (leader) {
    leader.leader = true;
    if (leader.job !== 'noble' && leader.job !== 'elder') leader.job = 'elder';
  }
  // Village+ always has some watch.
  const guards = people.filter((p) => p.job === 'guard');
  if (site.size !== 'hamlet' && guards.length === 0) {
    const g = people.filter((p) => p.stage === 'adult' && p.job !== 'noble').sort((a, b) => b.traits.courage - a.traits.courage)[0];
    if (g) (g.job = 'guard'), guards.push(g);
  }
  if (guards.length) guards.sort((a, b) => b.traits.courage + b.traits.conscientiousness - a.traits.courage - a.traits.conscientiousness)[0].captain = guards.length > 1 || site.size !== 'hamlet';
  for (const p of people) {
    const bias = p.job ? JOBS[p.job].traitBias : undefined;
    if (bias) for (const k of Object.keys(bias) as (keyof NpcTraits)[]) p.traits[k] = clamp(p.traits[k] + (bias[k] ?? 0) * 0.6, -1, 1);
  }

  // ---- social web beyond family
  const grown = people.filter((p) => p.stage !== 'child');
  for (const p of grown) {
    const nFriends = rng.int(0, p.traits.extraversion > 0.2 ? 3 : 1);
    for (let i = 0; i < nFriends; i++) {
      const o = rng.pick(grown);
      if (o === p || p.rels[o.idx]) continue;
      relate(p, o, 'friend', 'friend', Math.round(rng.range(25, 80)));
    }
    // Rivalry: same trade, different household, prickly temperament.
    if (p.traits.agreeableness < 0.1 && rng.chance(0.45)) {
      const rivals = grown.filter((o) => o !== p && o.household !== p.household && !p.rels[o.idx] && (o.job === p.job || rng.chance(0.15)));
      if (rivals.length) {
        const o = rng.pick(rivals);
        relate(p, o, 'rival', 'rival', -Math.round(rng.range(20, 70)));
      }
    }
    // Crushes among the unattached.
    if (p.spouse < 0 && p.stage === 'adult' && rng.chance(0.3)) {
      const cands = grown.filter((o) => o !== p && o.stage === 'adult' && o.household !== p.household && !p.rels[o.idx] && Math.abs(o.age - p.age) < RACE_LIFE[p.race].adultAge * 0.6 && Math.abs(o.gender - p.gender) > 0.4);
      if (cands.length) {
        const o = rng.pick(cands);
        p.rels[o.idx] = { kind: 'crush', affinity: Math.round(rng.range(40, 85)) };
        if (!o.rels[p.idx]) o.rels[p.idx] = { kind: 'neighbor', affinity: Math.round(rng.range(-10, 40)) };
      }
    }
    // Debts to the wealthy.
    if (rng.chance(p.job === 'beggar' || p.job === 'thief' ? 0.5 : 0.14)) {
      const lenders = grown.filter((o) => o !== p && !p.rels[o.idx] && (o.job === 'merchant' || o.job === 'innkeeper' || o.job === 'noble' || o.job === 'smith'));
      if (lenders.length) {
        const o = rng.pick(lenders);
        p.rels[o.idx] = { kind: 'creditor', affinity: Math.round(rng.range(-40, 20)) };
        o.rels[p.idx] = { kind: 'debtor', affinity: Math.round(rng.range(-50, 10)) };
      }
    }
    // Mentors in the same craft.
    if (p.stage === 'adult' && rng.chance(0.4)) {
      const m = grown.find((o) => o !== p && o.job === p.job && o.age - p.age > RACE_LIFE[p.race].adultAge * 0.5 && !p.rels[o.idx]);
      if (m) relate(p, m, 'mentor', 'apprentice', Math.round(rng.range(20, 80)));
    }
  }
  // Workmates know each other.
  for (const p of grown)
    for (const o of grown) if (p.idx < o.idx && p.jobBuilding && p.jobBuilding === o.jobBuilding && !p.rels[o.idx]) relate(p, o, 'colleague', 'colleague', Math.round(rng.range(-15, 60)));

  // ---- records
  const usedBeds = new Map<string, number>();
  const usedSpots = new Map<string, number>();
  const records: NpcRecord[] = [];
  const hasTavern = layout.buildings.some((b) => b.role === 'tavern');
  const hasTemple = layout.buildings.some((b) => b.role === 'temple' || b.role === 'shrine');
  const guardIdx = { n: 0 };
  for (const p of people) {
    const job = p.job ?? 'farmer';
    const prng = rng.fork('rec', p.idx);
    const home = p.home;
    const bed = pickSpot(home, 'bed', usedBeds, prng) ?? fallbackSpot(home, layout, prng, 'bed');
    // Workplace: assigned building, else any building of the job's work roles.
    let wb = p.jobBuilding;
    if (!wb) {
      const roles = JOBS[job].workRoles;
      const cand = layout.buildings.filter((b) => roles.includes(b.role));
      wb = cand.length ? prng.pick(cand) : null;
    }
    let work: Vec3 | null = null, workYaw = 0, outskirts = false;
    const def = JOBS[job];
    if (def.outskirts && !(wb && (job === 'farmer' || job === 'herder') && wb.spots.some((s) => s.kind === 'farm'))) {
      const o = outskirtsSpot(pc, def.outskirts, prng);
      work = o.pos;
      workYaw = o.yaw;
      outskirts = true;
    } else if (wb) {
      for (const k of def.spotKinds) {
        const s = pickSpot(wb, k, usedSpots, prng);
        if (s) {
          work = s.pos;
          workYaw = s.yaw;
          break;
        }
      }
      if (!work) {
        const s = fallbackSpot(wb, layout, prng, 'work');
        work = s.pos;
        workYaw = s.yaw;
      }
    }
    if (!work) {
      // No workplace (children, beggars, thieves, adventurers): free spots near the plaza.
      const kinds = def.spotKinds;
      const free = layout.spots.filter((s) => kinds.includes(s.kind));
      const s = free.length ? prng.pick(free) : null;
      work = s ? [s.pos[0] + prng.range(-1.5, 1.5), s.pos[1], s.pos[2] + prng.range(-1.5, 1.5)] : [layout.plaza[0] + prng.range(-6, 6), layout.plaza[1], layout.plaza[2] + prng.range(-6, 6)];
      workYaw = s?.yaw ?? prng.range(0, Math.PI * 2);
    }
    const nightShift = job === 'guard' && !p.captain && guardIdx.n++ % 3 === 2;
    const schedule = personalSchedule(job, p.traits, { nightShift, hasTavern, hasTemple, jitter: prng.range(-1, 1) });
    const deity = p.traits.piety > -0.2 || job === 'priest' ? patronDeity(pc.gods, p.race, job, prng) : null;
    const factions = [`site:${site.id}`];
    const guild: Partial<Record<NpcJob, string>> = {
      smith: 'guild:crafters', carpenter: 'guild:crafters', mason: 'guild:crafters', tailor: 'guild:crafters', merchant: 'guild:merchants',
      innkeeper: 'guild:merchants', cook: 'guild:merchants', guard: 'watch', priest: 'faith', healer: 'faith', scholar: 'circle', mage: 'circle',
      alchemist: 'circle', thief: 'shadows', noble: 'council', elder: 'council', hunter: 'lodge', woodcutter: 'lodge', farmer: 'growers', herder: 'growers',
    };
    const g = guild[job];
    if (g) factions.push(g === 'faith' && deity ? `faith:${deity.id}` : `${g}:${site.id}`);
    if (p.leader && !factions.includes(`council:${site.id}`)) factions.push(`council:${site.id}`);
    const wealth = clamp(def.wealth * (0.6 + layout.wealth * 0.8) + prng.gaussian(0, 0.08) + (p.leader ? 0.2 : 0), 0, 1);
    const relations: Record<string, NpcRel> = {};
    for (const [k, v] of Object.entries(p.rels)) relations[`${site.id}#${k}`] = v;
    const spouse = p.spouse >= 0 ? people[p.spouse] : null;
    const rival = Object.entries(p.rels).find(([, r]) => r.kind === 'rival');
    const crush = Object.entries(p.rels).find(([, r]) => r.kind === 'crush');
    const debt = Object.entries(p.rels).find(([, r]) => r.kind === 'creditor');
    const title = jobTitle(job, site.name, prng, { captain: p.captain, leader: p.leader, ageStage: p.stage });
    const bio = composeBio({
      name: p.given, race: p.race, race2: p.race2, gender: p.gender, age: Math.round(p.age), ageStage: p.stage, job, traits: p.traits, place: site.name,
      placeSize: site.size, biome, spouse: spouse?.given ?? null, widowed: p.widowed, children: p.children.length, parents: p.parents.map((i) => people[i].given),
      linkedPlace: pc.linkedNames.length ? prng.pick(pc.linkedNames) : null, deity, wealth, leader: p.leader, captain: p.captain,
      rival: rival ? people[+rival[0]].given : null, crush: crush ? people[+crush[0]].given : null, debtTo: debt ? people[+debt[0]].given : null,
    }, prng.fork('bio'));
    records.push({
      id: `${site.id}#${p.idx}`, siteId: site.id, seed: deriveSeed(pc.worldSeed, 'npc', site.id, p.idx), given: p.given, family: p.family, name: p.full,
      race: p.race, race2: p.race2, raceMix: p.raceMix, gender: p.gender, age: Math.round(p.age), ageStage: p.stage, job, captain: p.captain, leader: p.leader,
      traits: p.traits, wealth, household: p.household, homeBuilding: home?.id ?? null, bed: bed.pos, bedYaw: bed.yaw, workBuilding: outskirts ? null : wb?.id ?? null,
      work, workYaw, outskirts, schedule, nightShift, relations, factions, deity: deity?.id ?? null, title, bio,
      ambition: ambitionFor(job, p.traits, prng.fork('amb')), appearanceAge: appearanceAgeFor(p.race, p.age),
    });
  }
  return records;
}

function pickSpot(b: BuildingInfo | null, kind: SmartSpot['kind'], used: Map<string, number>, rng: Rng): SmartSpot | null {
  if (!b) return null;
  const list = b.spots.filter((s) => s.kind === kind);
  if (!list.length) return null;
  // Least-used spot first, so households spread across beds and stations.
  let best = list[0], bu = Infinity;
  for (const s of list) {
    const u = (used.get(s.id) ?? 0) + rng.float() * 0.1;
    if (u < bu) (bu = u), (best = s);
  }
  used.set(best.id, (used.get(best.id) ?? 0) + 1);
  return best;
}

/** Synthesize a spot inside a building (or near the plaza) when the layout lacks one. */
function fallbackSpot(b: BuildingInfo | null, layout: SettlementLayout, rng: Rng, _kind: string): { pos: Vec3; yaw: number } {
  if (b) {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const lx = rng.range(-b.size[0] / 2 + 1, b.size[0] / 2 - 1), lz = rng.range(-b.size[1] / 2 + 1, b.size[1] / 2 - 1);
    return { pos: [b.pos[0] + lx * c + lz * s, b.pos[1], b.pos[2] - lx * s + lz * c], yaw: b.yaw + Math.PI };
  }
  return { pos: [layout.plaza[0] + rng.range(-8, 8), layout.plaza[1], layout.plaza[2] + rng.range(-8, 8)], yaw: rng.range(0, Math.PI * 2) };
}

/** Find a shore point near the site (ground just above sea level), deterministic. */
export function findShore(pc: PopulationContext): Vec3 | null {
  const { site } = pc;
  for (let r = site.radius + 20; r < site.radius + 260; r += 30) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r;
      const h = pc.height(x, z);
      if (h < SEA_LEVEL + 0.5 && h > SEA_LEVEL - 4) {
        // Step back to dry land.
        const bx = site.x + Math.cos(a) * (r - 8), bz = site.z + Math.sin(a) * (r - 8);
        return [bx, Math.max(SEA_LEVEL + 0.2, pc.height(bx, bz)), bz];
      }
    }
  }
  return null;
}

/** Deterministic outskirts work position for fields, woods, mines, shore, pastures and wilds. */
export function outskirtsSpot(pc: PopulationContext, kind: NonNullable<(typeof JOBS)[NpcJob]['outskirts']>, rng: Rng): { pos: Vec3; yaw: number } {
  const { site } = pc;
  if (kind === 'shore') {
    const s = findShore(pc);
    if (s) return { pos: [s[0] + rng.range(-6, 6), s[1], s[2] + rng.range(-6, 6)], yaw: Math.atan2(-(s[0] - site.x), -(s[2] - site.z)) };
  }
  const dist = { fields: [1.05, 1.35], pasture: [1.2, 1.6], woods: [1.4, 2.1], mine: [1.5, 2.3], wilds: [1.8, 2.8], shore: [1.3, 1.8] }[kind];
  // Mines prefer higher ground: probe a few angles and keep the highest.
  let bestA = rng.range(0, Math.PI * 2), bestScore = -Infinity;
  const tries = kind === 'mine' ? 8 : 1;
  for (let i = 0; i < tries; i++) {
    const a = i === 0 ? bestA : rng.range(0, Math.PI * 2);
    const d = site.radius * dist[1];
    const h = pc.height(site.x + Math.cos(a) * d, site.z + Math.sin(a) * d);
    if (h > bestScore) (bestScore = h), (bestA = a);
  }
  const d = site.radius * rng.range(dist[0], dist[1]);
  const x = site.x + Math.cos(bestA) * d, z = site.z + Math.sin(bestA) * d;
  const y = pc.height(x, z);
  return { pos: [x, Number.isFinite(y) ? y : site.plateau, z], yaw: rng.range(0, Math.PI * 2) };
}
