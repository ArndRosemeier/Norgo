/**
 * Species generator (shared by server & client, no three.js).
 *
 * Every world derives its own bestiary from `profile.faunaSeed`: ~30-40 species
 * covering all fauna roles the world's biomes ask for (BIOMES[b].fauna tags),
 * each with a full "genome" — body plan, proportions, head furniture,
 * integument & colour pattern, locomotion, behaviour traits and combat stats —
 * plus a generated name in a per-world phonology.
 *
 * Species are clustered by habitat climate: a grazer living in taiga + tundra
 * gets fur and frosty colours, one in dune seas gets sandy scales. Weird worlds
 * (`lifeWeirdness`) push body plans towards the strange (hexapod grazers,
 * octopod predators, sky-whales, crystal golems).
 *
 * The result is cached per fauna seed so client & server share one instance.
 */
import { Rng, deriveSeed, hash32, hashToFloat } from '../core/rng';
import { clamp, hsl2rgb, lerp, mixRgb } from '../core/math';
import { BIOMES, Biome } from '../world/biomes';
import type { WorldProfile, RGB } from '../world/profile';

// ------------------------------------------------------------------ genome types

export type FaunaRole =
  | 'smallcritter' | 'grazer' | 'predator' | 'bird' | 'insect' | 'fish' | 'amphibian'
  | 'burrower' | 'climber' | 'floater' | 'construct' | 'cavecritter' | 'apex';

export const FAUNA_ROLES: FaunaRole[] = [
  'smallcritter', 'grazer', 'predator', 'bird', 'insect', 'fish', 'amphibian', 'burrower', 'climber', 'floater', 'construct', 'cavecritter', 'apex',
];

export type BodyPlan = 'quadruped' | 'biped' | 'hexapod' | 'octopod' | 'serpentine' | 'winged' | 'finned' | 'radial';
export type Integument = 'fur' | 'scales' | 'chitin' | 'feathers' | 'slime' | 'crystal' | 'bark' | 'stone';
export type PatternKind = 'none' | 'stripes' | 'spots' | 'rosettes' | 'bands' | 'patches' | 'mottled' | 'saddle' | 'eyespots';
export type Gait = 'walk' | 'trot' | 'gallop' | 'bound' | 'hop' | 'tripod' | 'wave' | 'slither' | 'waddle' | 'stride' | 'swim' | 'drift';
export type Diet = 'herbivore' | 'carnivore' | 'omnivore' | 'lithovore' | 'insectivore' | 'filter';
export type Activity = 'diurnal' | 'nocturnal' | 'crepuscular' | 'cathemeral';
export type Sociality = 'solitary' | 'pair' | 'herd' | 'pack' | 'swarm' | 'school' | 'flock';
export type Temperament = 'skittish' | 'docile' | 'curious' | 'territorial' | 'aggressive';
/** Where & how the species moves. */
export type Medium = 'ground' | 'air' | 'water' | 'amphibious' | 'burrow' | 'climb' | 'float';
export type AttackKind = 'bite' | 'claw' | 'charge' | 'pounce' | 'sting' | 'spit' | 'roar';
export type DamageKind = 'slash' | 'pierce' | 'blunt' | 'poison' | 'fire' | 'frost' | 'shock';
export type PupilShape = 'round' | 'slit' | 'bar' | 'compound' | 'none';
export type SizeClass = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

export interface HeadGenome {
  /** Cranium radius relative to torso length. */
  size: number;
  /** Snout length relative to head size (0 = flat face). */
  snout: number;
  /** Snout thickness at the tip relative to cranium (0.2 pointy .. 0.9 blunt). */
  snoutTip: number;
  /** Beak instead of snout (birds, some weird beasts). */
  beak: number;
  beakCurve: number;
  /** Insect mandibles (0 = none). */
  mandibles: number;
  /** Horns: count (0, 1 unicorn, 2 pair, 4 two pairs), length & curl. */
  horns: number;
  hornLen: number;
  hornCurl: number;
  /** Horn sweep direction: 0 up, 1 back, -1 forward. */
  hornSweep: number;
  antlers: boolean;
  antlerTines: number;
  /** Head crest/ridge height (0 = none). */
  crest: number;
  /** Neck frill radius (0 = none). */
  frill: number;
  /** Eye count (0 = blind, 2 normal, 3-8 weird/spiders). */
  eyes: number;
  eyeSize: number;
  pupil: PupilShape;
  /** Ear length relative to head (0 = none). */
  ears: number;
  /** Ear pointiness 0 round .. 1 sharp. */
  earPoint: number;
  tusks: number;
  /** Antenna length relative to torso length (0 = none). */
  antennae: number;
  whiskers: boolean;
}

export interface LimbGenome {
  /** Leg pairs (0 legless .. 1 biped .. 2 quad .. 3 hexapod .. 4 octopod .. 7+ centipede). */
  pairs: number;
  /** Leg length relative to torso length. */
  length: number;
  /** Thickness relative to torso girth. */
  thickness: number;
  /** Hind/front length ratio (>1 kangaroo/raptor-ish). */
  hindRatio: number;
  /** Digitigrade (3-segment, raised heel). */
  digitigrade: boolean;
  /** Lateral splay (0 upright mammal .. 1 sprawling insect/lizard). */
  splay: number;
  /** Feet: 0 paw, 1 hoof, 2 claw, 3 pad (sticky), 4 point (insect tarsus). */
  foot: 'paw' | 'hoof' | 'claw' | 'pad' | 'point';
  footSize: number;
  /** Upright bipeds with arms (golems, apes). */
  arms: boolean;
  armLength: number;
}

export interface WingGenome {
  kind: 'none' | 'feather' | 'membrane' | 'insect';
  /** Half-span relative to torso length. */
  span: number;
  /** Chord relative to span. */
  chord: number;
  /** Insect wing pairs. */
  pairs: number;
}

export interface TailGenome {
  /** Length relative to torso length. */
  length: number;
  segments: number;
  /** Base thickness relative to hip girth. */
  thickness: number;
  /** Upward curl (scorpion > 1). */
  curl: number;
  /** End ornament. */
  tip: 'none' | 'club' | 'sting' | 'fan' | 'tuft' | 'fin' | 'spikes';
}

export interface FinGenome {
  dorsal: number;
  pectoral: number;
  tail: number;
}

export interface DorsalGenome {
  /** Row of spikes along the back (count, 0 none). */
  spikes: number;
  spikeLen: number;
  /** Back plates (stegosaur-like). */
  plates: boolean;
  /** Sail height relative to torso length. */
  sail: number;
  /** Shell/carapace dome 0..1 (turtle, beetle). */
  shell: number;
  /** Floater gas sacs count. */
  sacs: number;
}

export interface Coloring {
  base: RGB;
  secondary: RGB;
  belly: RGB;
  accent: RGB;
  glow: RGB;
  eye: RGB;
  /** Keratin (horn/claw/beak/hoof) colour. */
  keratin: RGB;
  pattern: PatternKind;
  /** Pattern frequency (per torso length). */
  patternScale: number;
  patternContrast: number;
  /** 0..1 countershading (pale belly). */
  countershade: number;
  /** 0..1 bioluminescent dots/lines strength. */
  glowAmount: number;
  /** 0 dots, 1 lines, 2 whole-body pulse. */
  glowStyle: number;
  /** Surface roughness base. */
  roughness: number;
  /** Iridescence 0..1 (beetles, feathers). */
  sheen: number;
}

export interface Species {
  index: number;
  id: string;
  /** Display name, e.g. "Ashback Vethrik". */
  name: string;
  /** Coined base noun, e.g. "Vethrik". */
  noun: string;
  /** Proper names for boss individuals. */
  bossNames: string[];
  role: FaunaRole;
  /** Additional roles this species can fill (e.g. apex → predator, boss). */
  roles: FaunaRole[];
  plan: BodyPlan;
  medium: Medium;
  integument: Integument;
  /** Translucent (jellies, slimes). */
  translucent: boolean;

  // --- dimensions (adult, meters)
  /** Torso length (pelvis → chest). */
  length: number;
  /** Torso girth (radius) relative to length. */
  girth: number;
  /** Width/height squash of the torso cross-section. */
  bodyWidth: number;
  bodyHeight: number;
  /** Chest/hip girth ratio. */
  chest: number;
  belly: number;
  spineSegs: number;
  /** Dorsal arch (positive = humped back). */
  spineArch: number;
  /** Upright torso (golems, apes, upright bipeds). */
  upright: boolean;
  neckLen: number;
  neckSegs: number;
  /** Neck elevation angle (radians). */
  neckRaise: number;
  head: HeadGenome;
  limbs: LimbGenome;
  wings: WingGenome;
  tail: TailGenome;
  fins: FinGenome;
  dorsal: DorsalGenome;
  /** Floater/radial arm count & arm length relative to torso. */
  arms: number;
  armLen: number;
  /** Blend sharpness of the implicit body (0 organic .. 1 chunky). */
  chunky: number;
  colors: Coloring;

  // --- behaviour
  gait: Gait;
  diet: Diet;
  activity: Activity;
  sociality: Sociality;
  groupSize: [number, number];
  temperament: Temperament;
  /** Habitat biome ids (surface and/or underworld). */
  biomes: Biome[];
  underworld: boolean;
  /** Prefers caves/dark places on the surface layer. */
  cave: boolean;
  /** Can swim (land animals). */
  swims: boolean;
  /** Can fly (birds, winged, insects with wings). */
  flies: boolean;
  /** Preferred hover altitude for flyers/floaters (m above ground). */
  altitude: number;
  /** Spawn weight among same-role species. */
  abundance: number;

  // --- stats
  size: SizeClass;
  /** Adult mass (kg). */
  mass: number;
  hp: number;
  damage: number;
  damageType: DamageKind;
  armor: number;
  /** m/s */
  walkSpeed: number;
  runSpeed: number;
  /** rad/s */
  turnRate: number;
  /** Sight range (m), field of view (radians, full angle), hearing range (m). */
  sight: number;
  fov: number;
  hearing: number;
  /** Attack reach (m). */
  reach: number;
  attacks: AttackKind[];
  /** 0..1 how hard to tame (1 = impossible). */
  tameDifficulty: number;
  /** Item def ids dropped on death (besides the generic loot table). */
  loot: string[];
  /** Typical overall height (m) of the adult standing. */
  height: number;
  /** Capsule radius (m). */
  radius: number;
  /** Total model length nose to tail-tip (m). */
  totalLength: number;
  /** Hip height above ground (m). */
  hipHeight: number;
  /** Visual-only seed for mesh details. */
  seed: number;
  /** Strangeness 0..1 rolled for this species. */
  weird: number;
}

// ------------------------------------------------------------------ names

/**
 * Per-world phonology: each world gets its own consonant/vowel inventory and
 * syllable shapes so all creature names of one world sound related.
 */
class Phonology {
  private onsets: string[];
  private vowels: string[];
  private codas: string[];
  private endings: string[];
  constructor(rng: Rng) {
    const ON = ['b', 'd', 'g', 'k', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'th', 'sk', 'kr', 'gr', 'br', 'dr', 'vh', 'sh', 'ch', 'qu', 'fl', 'gl', 'l', 'h', 'j', 'x', 'tr', 'mor', 'y', 'w'];
    const VO = ['a', 'e', 'i', 'o', 'u', 'ae', 'ou', 'ai', 'y', 'ea', 'oo', 'au', 'ei'];
    const CO = ['', '', '', 'n', 'r', 'k', 's', 'th', 'l', 'm', 'x', 'g', 'sh', 'rk', 'nt', 'ld', 'sk'];
    const EN = ['ik', 'or', 'ax', 'un', 'eth', 'ra', 'el', 'ok', 'ith', 'os', 'ug', 'ar', 'yx', 'en', 'ul', 'is', 'ing', 'ow', 'ash', 'ak'];
    this.onsets = rng.sample(ON, rng.int(9, 15));
    this.vowels = rng.sample(VO, rng.int(4, 7));
    this.codas = rng.sample(CO, rng.int(5, 9));
    this.endings = rng.sample(EN, rng.int(5, 9));
  }
  word(rng: Rng, minSyl = 1, maxSyl = 2): string {
    const n = rng.int(minSyl, maxSyl);
    let w = '';
    for (let i = 0; i < n; i++) w += rng.pick(this.onsets) + rng.pick(this.vowels) + (i < n - 1 ? rng.pick(this.codas) : '');
    // Either a suffix (dropping its vowel after a vowel) or a closing consonant.
    if (rng.chance(0.55)) {
      const e = rng.pick(this.endings);
      w += /[aeiouy]$/.test(w) && /^[aeiouy]/.test(e) ? e.slice(1) : e;
    } else w += rng.pick(this.codas.filter((c) => c)) ?? '';
    w = w.replace(/(.)\1\1/g, '$1$1').replace(/([aeiouy]{2})[aeiouy]+/g, '$1');
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
}

// ------------------------------------------------------------------ habitat clustering

interface HabitatCell {
  biome: Biome;
  underworld: boolean;
  temp: number;
  humid: number;
  weird: number;
}

/** Camouflage palette for a biome (sRGB), drawn from the world profile's tints. */
function biomePalette(p: WorldProfile, b: Biome, rng: Rng): RGB[] {
  const rock = p.rockTint, sand = p.sandTint, soil = p.soilTint, fol = p.foliage, dry = p.foliageDry;
  const darken = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
  const tint = (h: number, s: number, l: number): RGB => hsl2rgb(h, s, l);
  switch (b) {
    case Biome.Ocean:
      return [mixRgb(p.waterColor, [0.75, 0.78, 0.8], 0.4), [0.55, 0.6, 0.65], darken(p.waterDeep, 2.2)];
    case Biome.Grassland:
      return [mixRgb(soil, dry, 0.5), mixRgb(sand, soil, 0.4), darken(dry, 0.9), tint(0.08, 0.35, 0.4)];
    case Biome.TemperateForest:
      return [darken(soil, 1.1), mixRgb(soil, fol, 0.3), tint(0.07, 0.45, 0.3), darken(rock, 0.8)];
    case Biome.Taiga:
      return [mixRgb(soil, rock, 0.5), tint(0.07, 0.25, 0.35), [0.45, 0.42, 0.4], darken(fol, 0.8)];
    case Biome.Jungle:
      return [darken(fol, 1.1), tint(0.08, 0.5, 0.3), mixRgb(fol, [0.9, 0.7, 0.2], 0.4), darken(soil, 0.8)];
    case Biome.Savanna:
      return [mixRgb(sand, dry, 0.5), tint(0.09, 0.5, 0.55), mixRgb(soil, sand, 0.6), tint(0.06, 0.4, 0.35)];
    case Biome.Desert:
      return [sand, mixRgb(sand, [1, 1, 1], 0.25), darken(sand, 0.75), tint(0.07, 0.45, 0.45)];
    case Biome.Badlands:
      return [tint(0.04, 0.5, 0.42), mixRgb(sand, [0.8, 0.4, 0.25], 0.5), darken(soil, 1.2), [0.75, 0.62, 0.5]];
    case Biome.Tundra:
      return [[0.86, 0.87, 0.88], [0.6, 0.58, 0.55], mixRgb(rock, [1, 1, 1], 0.4), tint(0.08, 0.15, 0.55)];
    case Biome.Glacier:
      return [[0.92, 0.94, 0.97], [0.75, 0.8, 0.88], [0.55, 0.6, 0.68]];
    case Biome.Swamp:
      return [darken(fol, 0.7), mixRgb(soil, fol, 0.5), tint(0.15, 0.3, 0.25), darken(soil, 0.7)];
    case Biome.Volcanic:
      return [[0.12, 0.11, 0.11], [0.25, 0.22, 0.2], tint(0.03, 0.7, 0.35), darken(rock, 0.5)];
    case Biome.CrystalWastes:
      return [p.crystalTint, mixRgb(p.crystalTint, [1, 1, 1], 0.5), [0.85, 0.85, 0.9], darken(p.crystalTint, 0.6)];
    case Biome.FungalGrove:
      return [p.fungalTint, mixRgb(p.fungalTint, [1, 0.9, 0.8], 0.4), darken(p.fungalTint, 0.6), tint(rng.float(), 0.4, 0.45)];
    case Biome.FloatingIsles:
      return [mixRgb(p.skyHorizon, [1, 1, 1], 0.3), mixRgb(p.skyZenith, [1, 1, 1], 0.4), fol, tint(rng.float(), 0.35, 0.65)];
    case Biome.KarstPillars:
      return [mixRgb(rock, [0.9, 0.9, 0.85], 0.3), darken(fol, 0.9), mixRgb(soil, rock, 0.5)];
    case Biome.SaltFlats:
      return [[0.93, 0.92, 0.9], mixRgb(sand, [1, 1, 1], 0.5), [0.7, 0.66, 0.62]];
    // underworld: pale, desaturated, sometimes vivid
    case Biome.GlowCaverns:
      return [[0.78, 0.76, 0.8], mixRgb(p.fungalTint, [1, 1, 1], 0.4), tint(rng.float(), 0.3, 0.5)];
    case Biome.Geodes:
      return [mixRgb(p.crystalTint, [0.9, 0.9, 0.9], 0.3), [0.5, 0.48, 0.55], darken(p.crystalTint, 0.5)];
    case Biome.MagmaDepths:
      return [[0.1, 0.09, 0.09], [0.3, 0.12, 0.08], tint(0.05, 0.8, 0.4)];
    case Biome.UnderSea:
      return [[0.82, 0.82, 0.86], [0.45, 0.5, 0.58], tint(0.55, 0.3, 0.35)];
    case Biome.BoneHollows:
      return [[0.86, 0.82, 0.74], [0.6, 0.56, 0.5], [0.3, 0.27, 0.25]];
    case Biome.RootCathedral:
      return [darken(soil, 1.2), mixRgb(fol, [0.8, 0.8, 0.7], 0.3), [0.7, 0.68, 0.6]];
    default:
      return [soil, rock, sand];
  }
}

// ------------------------------------------------------------------ role templates

interface RoleSpec {
  count: [number, number];
  /** Torso length range (m). */
  length: [number, number];
  plans: [BodyPlan, number][];
  weirdPlans: [BodyPlan, number][];
}

const ROLES: Record<FaunaRole, RoleSpec> = {
  smallcritter: { count: [3, 5], length: [0.12, 0.4], plans: [['quadruped', 6], ['biped', 1.2]], weirdPlans: [['hexapod', 2], ['radial', 1], ['serpentine', 1], ['octopod', 0.6]] },
  grazer: { count: [3, 5], length: [0.8, 2.4], plans: [['quadruped', 8], ['biped', 0.6]], weirdPlans: [['hexapod', 3], ['biped', 1.5], ['radial', 0.6], ['octopod', 0.8]] },
  predator: { count: [3, 5], length: [0.6, 1.8], plans: [['quadruped', 7], ['biped', 1.5]], weirdPlans: [['hexapod', 2], ['octopod', 2], ['serpentine', 1.2]] },
  bird: { count: [3, 4], length: [0.12, 0.55], plans: [['winged', 1]], weirdPlans: [['winged', 1]] },
  insect: { count: [3, 4], length: [0.07, 0.34], plans: [['hexapod', 6], ['octopod', 2], ['winged', 2.5]], weirdPlans: [['serpentine', 1], ['radial', 0.7]] },
  fish: { count: [2, 4], length: [0.2, 0.9], plans: [['finned', 6], ['serpentine', 1]], weirdPlans: [['finned', 2], ['radial', 0.5]] },
  amphibian: { count: [2, 3], length: [0.12, 0.6], plans: [['quadruped', 5], ['serpentine', 0.6]], weirdPlans: [['hexapod', 1.4], ['biped', 0.6]] },
  burrower: { count: [2, 3], length: [0.25, 0.9], plans: [['quadruped', 4], ['serpentine', 2]], weirdPlans: [['hexapod', 1.5], ['octopod', 0.8]] },
  climber: { count: [2, 3], length: [0.22, 0.8], plans: [['quadruped', 5]], weirdPlans: [['octopod', 2], ['hexapod', 1.4]] },
  floater: { count: [2, 3], length: [0.4, 2.2], plans: [['radial', 5], ['finned', 1.5]], weirdPlans: [['radial', 2], ['finned', 2]] },
  construct: { count: [2, 3], length: [0.7, 1.5], plans: [['biped', 4], ['quadruped', 2]], weirdPlans: [['hexapod', 1.5], ['radial', 1], ['octopod', 0.8]] },
  cavecritter: { count: [2, 4], length: [0.08, 0.6], plans: [['hexapod', 3], ['octopod', 2], ['quadruped', 3]], weirdPlans: [['serpentine', 1.5], ['radial', 1.2]] },
  apex: { count: [2, 3], length: [2.2, 4.5], plans: [['quadruped', 4], ['biped', 2.5], ['winged', 1.5]], weirdPlans: [['serpentine', 2], ['hexapod', 1.6], ['octopod', 1.4]] },
};

// ------------------------------------------------------------------ generator

const cache = new Map<number, Species[]>();

/** The world's bestiary (cached per fauna seed). */
export function speciesList(profile: WorldProfile): Species[] {
  const key = profile.faunaSeed >>> 0;
  let list = cache.get(key);
  if (!list) {
    list = generateSpecies(profile);
    cache.set(key, list);
  }
  return list;
}

/** Collect biomes that ask for a role (present in this world). */
function habitatsFor(p: WorldProfile, role: FaunaRole): HabitatCell[] {
  const out: HabitatCell[] = [];
  const tag = role === 'apex' ? 'predator' : role;
  for (const bi of p.biomes) {
    if (!bi || bi.weight <= 0) continue;
    if (BIOMES[bi.id].fauna.includes(tag)) out.push({ biome: bi.id, underworld: false, temp: bi.temp, humid: bi.humid, weird: bi.weird });
  }
  for (const bi of p.underworld) {
    if (BIOMES[bi.id].fauna.includes(tag)) out.push({ biome: bi.id, underworld: true, temp: bi.temp, humid: bi.humid, weird: bi.weird });
  }
  return out;
}

/** k-means-ish partition of habitats into `k` climate clusters (deterministic). */
function clusterHabitats(cells: HabitatCell[], k: number, rng: Rng): HabitatCell[][] {
  if (!cells.length) return [];
  k = Math.max(1, Math.min(k, cells.length));
  // Underworld & surface never share a species cluster seed.
  const seeds = rng.sample(cells, k);
  let groups: HabitatCell[][] = [];
  for (let iter = 0; iter < 4; iter++) {
    groups = seeds.map(() => []);
    for (const c of cells) {
      let best = 0, bd = 1e9;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        const d = (c.temp - s.temp) ** 2 + (c.humid - s.humid) ** 2 + (c.weird - s.weird) ** 2 * 1.5 + (c.underworld !== s.underworld ? 9 : 0);
        if (d < bd) { bd = d; best = i; }
      }
      groups[best].push(c);
    }
    for (let i = 0; i < seeds.length; i++) {
      const g = groups[i];
      if (!g.length) continue;
      const m = { biome: g[0].biome, underworld: g[0].underworld, temp: 0, humid: 0, weird: 0 };
      for (const c of g) { m.temp += c.temp / g.length; m.humid += c.humid / g.length; m.weird += c.weird / g.length; }
      seeds[i] = m;
    }
  }
  return groups.filter((g) => g.length);
}

export function generateSpecies(p: WorldProfile): Species[] {
  const rng = new Rng(deriveSeed(p.faunaSeed, 'species'));
  const phon = new Phonology(rng.fork('phonology'));
  const out: Species[] = [];
  const usedNames = new Set<string>();
  for (const role of FAUNA_ROLES) {
    const cells = habitatsFor(p, role);
    if (!cells.length) continue;
    const rr = rng.fork('role', role);
    const spec = ROLES[role];
    let count = rr.int(spec.count[0], spec.count[1]);
    count = Math.min(count, Math.max(1, cells.length + 1));
    const groups = clusterHabitats(cells, count, rr.fork('cluster'));
    // A few extra species share habitat with an existing cluster (diversity within biomes).
    while (groups.length < count) groups.push(rr.pick(groups).slice());
    for (let i = 0; i < groups.length; i++) {
      const s = makeSpecies(p, role, groups[i], i, out.length, rr.fork('sp', i), phon, usedNames);
      out.push(s);
    }
  }
  // Every world gets at least one surface flyer & critter even if no biome asked for it explicitly.
  return out;
}

function pickWeighted<T>(rng: Rng, items: [T, number][]): T {
  return rng.weighted(items, (it) => it[1])[0];
}

/** Build one species genome for a role & habitat cluster. */
function makeSpecies(p: WorldProfile, role: FaunaRole, habitat: HabitatCell[], ordinal: number, index: number, rng: Rng, phon: Phonology, usedNames: Set<string>): Species {
  const spec = ROLES[role];
  const w = clamp(p.lifeWeirdness * 0.8 + rng.range(-0.15, 0.35) + avg(habitat, (h) => h.weird) * 0.35, 0, 1);
  const weirdPlan = rng.chance(w * 0.55);
  let plan = pickWeighted(rng, weirdPlan ? spec.weirdPlans : spec.plans);
  const underworld = habitat.every((h) => h.underworld);
  const temp = avg(habitat, (h) => h.temp);
  const humid = avg(habitat, (h) => h.humid);
  const cold = temp < -0.3, hot = temp > 0.55, wet = humid > 0.5, dry = humid < -0.3;
  const crystalHab = habitat.some((h) => h.biome === Biome.CrystalWastes || h.biome === Biome.Geodes);
  const fungalHab = habitat.some((h) => h.biome === Biome.FungalGrove || h.biome === Biome.GlowCaverns);
  const fireHab = habitat.some((h) => h.biome === Biome.Volcanic || h.biome === Biome.MagmaDepths);
  const cave = role === 'cavecritter';
  const dark = underworld || cave;

  // ---------------- size
  let length = Math.exp(lerp(Math.log(spec.length[0]), Math.log(spec.length[1]), rng.float()));
  if (rng.chance(w * 0.25) && role !== 'apex') length *= rng.range(1.4, 2.4); // giant weird variants
  if (role === 'insect' && plan === 'winged') length *= 1.3;

  // ---------------- integument
  let integ: Integument = 'fur';
  const I = (opts: [Integument, number][]) => pickWeighted(rng, opts);
  switch (role) {
    case 'bird': integ = rng.chance(w * 0.35) ? I([['scales', 1], ['fur', 1], ['chitin', 0.5]]) : 'feathers'; break;
    case 'insect': integ = rng.chance(w * 0.2) ? I([['crystal', 1], ['bark', 1], ['slime', 1]]) : 'chitin'; break;
    case 'fish': integ = I([['scales', 5], ['slime', 2], ['chitin', w * 2], ['crystal', crystalHab ? 2 : 0]]); break;
    case 'amphibian': integ = I([['slime', 6], ['scales', 1], ['chitin', w]]); break;
    case 'floater': integ = I([['slime', 6], ['crystal', crystalHab ? 3 : w], ['bark', w * 0.5]]); break;
    case 'construct': integ = crystalHab ? I([['crystal', 3], ['stone', 2]]) : I([['stone', 3], ['crystal', 1], ['bark', 1]]); break;
    case 'cavecritter': integ = I([['chitin', 3], ['slime', 3], ['fur', 1.5], ['scales', 1], ['crystal', crystalHab ? 2 : 0]]); break;
    default: {
      const opts: [Integument, number][] = [
        ['fur', cold ? 8 : hot ? 1 : 4],
        ['scales', hot || dry ? 6 : 2],
        ['chitin', 0.5 + w * 3 + (plan === 'hexapod' || plan === 'octopod' ? 8 : 0)],
        ['feathers', plan === 'biped' ? 2 : 0.4],
        ['slime', wet ? 1.5 : 0.2],
        ['bark', 0.3 + w * (fungalHab ? 3 : 1.2)],
        ['crystal', crystalHab ? 4 : w * 0.6],
      ];
      if (plan === 'hexapod' || plan === 'octopod') { opts[0][1] *= 0.15; opts[3][1] = 0; }
      if (fireHab) opts.push(['stone', 2]);
      integ = I(opts);
    }
  }

  // ---------------- base genome
  const legPairsFor = (pl: BodyPlan): number => {
    switch (pl) {
      case 'quadruped': return 2;
      case 'biped': return 1;
      case 'hexapod': return rng.chance(0.15 + w * 0.2) && role !== 'insect' ? rng.int(4, 7) : 3;
      case 'octopod': return 4;
      case 'serpentine': return rng.chance(0.3) ? rng.int(8, 14) : 0; // centipede or snake
      case 'winged': return role === 'apex' ? 2 : role === 'insect' ? 3 : 1;
      case 'finned': return 0;
      case 'radial': return 0;
    }
  };
  let pairs = legPairsFor(plan);
  if (role === 'fish') pairs = 0;
  if (plan === 'serpentine' && pairs > 0) plan = 'serpentine';

  const upright = (plan === 'biped' && (role === 'construct' || rng.chance(0.18 + w * 0.2))) && role !== 'bird';
  const sixLegInsect = role === 'insect' || ((plan === 'hexapod' || plan === 'octopod') && integ === 'chitin');
  const centipede = plan === 'serpentine' && pairs > 0;

  const girth = plan === 'serpentine' ? rng.range(0.08, 0.14) : plan === 'radial' ? rng.range(0.4, 0.6) : plan === 'finned' ? rng.range(0.13, 0.2) : role === 'construct' ? rng.range(0.32, 0.45) : sixLegInsect ? rng.range(0.22, 0.32) : rng.range(0.16, 0.27) * (role === 'grazer' && length > 1.5 ? 1.15 : 1);
  const legLenRel = (() => {
    if (pairs === 0) return 0;
    if (sixLegInsect) return rng.range(0.6, 1.5) * (plan === 'octopod' ? 1.3 : 1);
    if (centipede) return rng.range(0.15, 0.3);
    if (role === 'grazer') return rng.range(0.7, 1.3) * (rng.chance(w * 0.3) ? 1.5 : 1);
    if (role === 'smallcritter' || role === 'amphibian' || role === 'burrower') return rng.range(0.3, 0.6);
    if (role === 'bird' || plan === 'winged') return rng.range(0.45, 0.9);
    if (plan === 'biped') return rng.range(0.8, 1.3);
    return rng.range(0.55, 1.0);
  })();

  const limbs: LimbGenome = {
    pairs,
    length: legLenRel,
    thickness: sixLegInsect || centipede ? rng.range(0.08, 0.14) : role === 'construct' ? rng.range(0.4, 0.55) : rng.range(0.22, 0.38) * (role === 'grazer' && length > 1.6 ? 1.2 : 1),
    hindRatio: plan === 'quadruped' ? (rng.chance(0.25) ? rng.range(1.15, 1.6) : rng.range(0.9, 1.1)) : 1,
    digitigrade: !sixLegInsect && !upright && (role === 'grazer' || role === 'predator' || plan === 'biped' || plan === 'winged' || rng.chance(0.4)) && role !== 'construct',
    splay: sixLegInsect || centipede ? rng.range(0.7, 1) : role === 'amphibian' || (integ === 'scales' && plan === 'quadruped' && rng.chance(0.5)) ? rng.range(0.45, 0.8) : rng.range(0, 0.15),
    foot: sixLegInsect || centipede ? 'point' : role === 'grazer' && rng.chance(0.7) ? 'hoof' : role === 'amphibian' || role === 'climber' ? 'pad' : role === 'predator' || role === 'apex' || role === 'burrower' ? 'claw' : rng.pick(['paw', 'claw'] as const),
    footSize: rng.range(0.8, 1.3),
    arms: upright,
    armLength: upright ? rng.range(0.9, 1.5) : 0,
  };
  if (role === 'burrower') limbs.footSize *= 1.5;

  // Head
  const beaked = role === 'bird' || (rng.chance(0.12 + w * 0.15) && !sixLegInsect && plan !== 'finned' && plan !== 'radial');
  const head: HeadGenome = {
    size: plan === 'radial' ? 0 : sixLegInsect ? rng.range(0.22, 0.34) : role === 'bird' ? rng.range(0.3, 0.42) : role === 'construct' ? rng.range(0.18, 0.26) : plan === 'finned' ? rng.range(0.16, 0.24) : rng.range(0.2, 0.3),
    snout: beaked || sixLegInsect || role === 'construct' ? rng.range(0, 0.4) : role === 'grazer' ? rng.range(0.9, 1.7) : role === 'predator' || role === 'apex' ? rng.range(0.8, 1.6) : role === 'fish' ? rng.range(0.4, 1.2) : rng.range(0.5, 1.3),
    snoutTip: rng.range(0.35, 0.85),
    beak: beaked ? rng.range(0.6, 1.6) : 0,
    beakCurve: rng.range(-0.2, 0.9) * (role === 'bird' && rng.chance(0.3) ? 1.5 : 0.6),
    mandibles: sixLegInsect && rng.chance(0.65) ? rng.range(0.5, 1.4) : rng.chance(w * 0.15) && !beaked ? rng.range(0.4, 1) : 0,
    horns: 0,
    hornLen: 0,
    hornCurl: 0,
    hornSweep: 0,
    antlers: false,
    antlerTines: 0,
    crest: rng.chance(role === 'bird' ? 0.4 : 0.15 + w * 0.2) ? rng.range(0.3, 1) : 0,
    frill: rng.chance(0.06 + w * 0.12) && plan !== 'finned' ? rng.range(0.5, 1.2) : 0,
    eyes: 2,
    eyeSize: rng.range(0.85, 1.25),
    pupil: 'round',
    ears: 0,
    earPoint: rng.float(),
    tusks: 0,
    antennae: sixLegInsect && plan !== 'octopod' ? rng.range(0.3, 1.2) : rng.chance(w * 0.12) ? rng.range(0.2, 0.6) : 0,
    whiskers: integ === 'fur' && rng.chance(0.4),
  };
  // Horns & antlers: grazers and apex mostly.
  if ((role === 'grazer' && rng.chance(0.7)) || (role === 'apex' && rng.chance(0.6)) || (role === 'predator' && rng.chance(0.15 + w * 0.2)) || (role === 'construct' && rng.chance(0.4)) || rng.chance(w * 0.08)) {
    if (integ === 'fur' && role === 'grazer' && rng.chance(0.35)) {
      head.antlers = true;
      head.antlerTines = rng.int(2, 5);
      head.hornLen = rng.range(0.9, 2.0);
    } else {
      head.horns = rng.weighted([1, 2, 2, 4, 6], (_, i) => [0.4 + w, 3, 3, 0.6 + w, w * 0.6][i]);
      head.hornLen = rng.range(0.4, 1.8);
      head.hornCurl = rng.range(0, 1.3);
      head.hornSweep = rng.range(-0.4, 1.1);
    }
  }
  if (!beaked && !sixLegInsect && (role === 'grazer' || role === 'apex') && rng.chance(0.18 + w * 0.1)) head.tusks = rng.range(0.4, 1.1);
  if (integ === 'fur' && plan !== 'finned') head.ears = rng.range(0.35, 1.3) * (role === 'smallcritter' && rng.chance(0.4) ? 1.8 : 1);
  if (role === 'construct' && integ === 'stone') head.ears = 0;
  // Eyes
  if (sixLegInsect) {
    head.pupil = 'compound';
    head.eyes = plan === 'octopod' ? rng.pick([4, 6, 8]) : 2;
    head.eyeSize *= plan === 'octopod' ? 0.7 : 1.4;
  } else if (role === 'construct') {
    head.pupil = 'none';
    head.eyes = rng.pick([1, 2, 2, 3]);
  } else {
    head.pupil = role === 'predator' || role === 'apex' ? rng.pick(['slit', 'round', 'slit'] as const) : role === 'grazer' ? rng.pick(['bar', 'round'] as const) : rng.pick(['round', 'slit', 'round'] as const);
    if (rng.chance(w * 0.3)) head.eyes = rng.pick([1, 3, 4, 6]);
  }
  if (dark && rng.chance(0.55)) {
    head.eyes = 0; // blind cave dwellers
    head.antennae = Math.max(head.antennae, rng.range(0.3, 0.9));
    head.whiskers = true;
  }
  if (plan === 'radial') { head.eyes = rng.chance(0.5) ? 0 : rng.int(3, 8); head.ears = 0; head.horns = 0; head.antlers = false; head.snout = 0; head.beak = 0; head.mandibles = 0; head.whiskers = false; }

  // Neck
  let neckLen = rng.range(0.15, 0.45);
  if (role === 'grazer' && rng.chance(0.3)) neckLen = rng.range(0.6, 1.4) * (rng.chance(w * 0.3) ? 1.5 : 1); // giraffe/sauropod
  if (role === 'bird') neckLen = rng.range(0.2, 0.7) * (rng.chance(0.2) ? 2 : 1);
  if (sixLegInsect || plan === 'finned' || plan === 'radial') neckLen = sixLegInsect ? 0.08 : 0.04;
  if (upright) neckLen = rng.range(0.08, 0.2);
  const neckRaise = plan === 'finned' || plan === 'serpentine' ? 0 : upright ? 0.1 : sixLegInsect ? rng.range(-0.1, 0.25) : role === 'grazer' && neckLen > 0.6 ? rng.range(0.7, 1.2) : rng.range(0.2, 0.75);

  // Tail
  const tail: TailGenome = {
    length: plan === 'serpentine' ? rng.range(1.2, 2.4) : sixLegInsect ? (rng.chance(0.25) ? rng.range(0.5, 1.2) : 0) : role === 'construct' ? (rng.chance(0.3) ? rng.range(0.4, 0.9) : 0) : upright ? (rng.chance(0.3) ? rng.range(0.3, 0.8) : 0) : plan === 'radial' ? 0 : rng.range(0.25, 1.4),
    segments: 0,
    thickness: rng.range(0.35, 0.8),
    curl: sixLegInsect ? rng.range(0.6, 1.6) : rng.range(-0.2, 0.5),
    tip: 'none',
  };
  if (plan === 'biped' && !upright) tail.length = Math.max(tail.length, rng.range(0.9, 1.6)); // counterbalance
  if (role === 'bird') tail.length = rng.range(0.2, 0.8);
  if (plan === 'finned') tail.length = rng.range(0.5, 1.0);
  if (role === 'climber') tail.length = rng.range(0.9, 1.8);
  tail.tip = sixLegInsect && tail.length > 0 ? (rng.chance(0.7) ? 'sting' : 'club') : plan === 'finned' ? 'fin' : role === 'bird' ? 'fan' : rng.weighted(['none', 'club', 'tuft', 'spikes', 'sting'] as const, (_, i) => [5, role === 'apex' || role === 'grazer' ? 1.2 : 0.3, integ === 'fur' ? 1.5 : 0, 0.5 + w, w * 0.5][i]);
  tail.segments = tail.length > 0 ? clamp(Math.round(3 + tail.length * 5), 3, plan === 'serpentine' ? 16 : 10) : 0;

  const fins: FinGenome = {
    dorsal: plan === 'finned' || (role === 'amphibian' && rng.chance(0.3)) || (plan === 'serpentine' && role === 'fish') ? rng.range(0.4, 1.2) : 0,
    pectoral: plan === 'finned' ? rng.range(0.4, 1.1) : 0,
    tail: plan === 'finned' || role === 'fish' ? rng.range(0.6, 1.3) : 0,
  };
  const dorsal: DorsalGenome = {
    spikes: rng.chance(0.12 + w * 0.25 + (integ === 'scales' || integ === 'crystal' ? 0.2 : 0)) && plan !== 'finned' && plan !== 'radial' ? rng.int(4, 10) : 0,
    spikeLen: rng.range(0.08, 0.3),
    plates: rng.chance(0.08 + w * 0.1) && (role === 'grazer' || role === 'apex'),
    sail: rng.chance(0.04 + w * 0.08) && plan !== 'radial' ? rng.range(0.2, 0.5) : 0,
    shell: (integ === 'chitin' && rng.chance(0.4)) || (role === 'grazer' && rng.chance(0.08 + w * 0.1)) || (role === 'cavecritter' && rng.chance(0.3)) ? rng.range(0.4, 1) : 0,
    sacs: role === 'floater' ? rng.int(0, 4) : 0,
  };
  if (integ === 'crystal') { dorsal.spikes = Math.max(dorsal.spikes, rng.int(3, 8)); dorsal.spikeLen = rng.range(0.15, 0.45); }
  if (dorsal.plates) dorsal.spikes = rng.int(5, 9);

  // Wings
  const wings: WingGenome = { kind: 'none', span: 0, chord: 0, pairs: 0 };
  if (plan === 'winged') {
    if (role === 'insect') wings.kind = 'insect';
    else if (integ === 'feathers') wings.kind = 'feather';
    else wings.kind = 'membrane';
    wings.span = wings.kind === 'insect' ? rng.range(0.9, 1.6) : rng.range(1.6, 3.2);
    wings.chord = wings.kind === 'insect' ? rng.range(0.22, 0.4) : rng.range(0.32, 0.55);
    wings.pairs = wings.kind === 'insect' ? rng.pick([1, 2, 2]) : 1;
  }
  if (role === 'floater' && plan === 'finned') {
    // Sky-whales / manta drifters: huge pectoral "wings".
    fins.pectoral = rng.range(1.2, 2.2);
    fins.dorsal = rng.range(0, 0.6);
  }

  // Radial (floaters & star-walkers)
  const arms = plan === 'radial' ? (role === 'floater' ? rng.int(6, 14) : rng.int(5, 7)) : 0;
  const armLen = plan === 'radial' ? (role === 'floater' ? rng.range(1.2, 3.2) : rng.range(1.0, 1.9)) : 0;

  // ---------------- colours
  const pal = habitat.flatMap((h) => biomePalette(p, h.biome, rng));
  const vivid = role === 'bird' || role === 'insect' || role === 'amphibian' || rng.chance(w * 0.4);
  let base = rng.pick(pal);
  let secondary = rng.pick(pal);
  if (vivid && rng.chance(0.6)) {
    const hue = rng.float();
    if (rng.chance(0.5)) secondary = hsl2rgb(hue, rng.range(0.55, 0.9), rng.range(0.35, 0.6));
    else base = hsl2rgb(hue, rng.range(0.45, 0.8), rng.range(0.3, 0.55));
  }
  if (dark) {
    base = mixRgb(base, [0.86, 0.84, 0.86], rng.range(0.3, 0.7)); // albino-ish
    secondary = mixRgb(secondary, base, 0.4);
  }
  if (integ === 'crystal') base = mixRgb(p.crystalTint, base, 0.3);
  if (integ === 'stone') base = mixRgb(p.rockTint, [0.4, 0.38, 0.36], 0.4);
  if (integ === 'bark') base = mixRgb([0.32, 0.24, 0.17], base, 0.35);
  const jitter = (c: RGB, a: number): RGB => [clamp(c[0] + rng.range(-a, a), 0.02, 1), clamp(c[1] + rng.range(-a, a), 0.02, 1), clamp(c[2] + rng.range(-a, a), 0.02, 1)];
  base = jitter(base, 0.05);
  secondary = jitter(secondary, 0.06);
  const belly = mixRgb(base, [0.95, 0.92, 0.85], rng.range(0.35, 0.75));
  const accent = vivid || rng.chance(0.4) ? hsl2rgb(rng.float(), rng.range(0.6, 0.95), rng.range(0.4, 0.6)) : mixRgb(secondary, [0, 0, 0], 0.4);
  const glowHue = rng.chance(0.6) ? rng.range(0.42, 0.62) : rng.float();
  const glow = hsl2rgb(glowHue, rng.range(0.7, 1), 0.6);
  const glowAmount = dark ? rng.range(0.5, 1) : role === 'floater' ? rng.range(0.2, 0.9) : integ === 'crystal' ? rng.range(0.4, 0.8) : role === 'construct' ? rng.range(0.5, 1) : rng.chance(0.1 + w * 0.25) ? rng.range(0.2, 0.7) : 0;
  const pattern: PatternKind = (() => {
    if (integ === 'crystal' || integ === 'stone') return rng.pick(['none', 'bands', 'mottled'] as const);
    const opts: [PatternKind, number][] = [
      ['none', 2], ['stripes', role === 'predator' || role === 'grazer' ? 2 : 1], ['spots', 2], ['rosettes', role === 'predator' ? 1.5 : 0.3],
      ['bands', integ === 'chitin' || plan === 'serpentine' ? 3 : 0.5], ['patches', 1], ['mottled', 1.5], ['saddle', 0.8], ['eyespots', role === 'insect' || role === 'bird' ? 1.2 : 0.2 + w * 0.4],
    ];
    return pickWeighted(rng, opts);
  })();
  const eye: RGB = head.pupil === 'compound' ? hsl2rgb(rng.float(), 0.5, 0.25) : dark ? [0.9, 0.85, 0.8] : hsl2rgb(rng.pick([0.08, 0.12, 0.15, 0.3, 0.55, rng.float()]), rng.range(0.5, 0.95), rng.range(0.35, 0.55));
  const keratin: RGB = integ === 'crystal' ? mixRgb(p.crystalTint, [1, 1, 1], 0.4) : integ === 'chitin' ? mixRgb(base, [0.05, 0.04, 0.03], 0.6) : rng.pick([[0.85, 0.8, 0.68], [0.2, 0.18, 0.16], [0.55, 0.45, 0.32], [0.92, 0.88, 0.78]] as RGB[]);
  const colors: Coloring = {
    base, secondary, belly, accent, glow, eye, keratin,
    pattern,
    patternScale: rng.range(3, 9) * (pattern === 'stripes' ? 1.3 : 1),
    patternContrast: rng.range(0.4, 1),
    countershade: integ === 'chitin' || integ === 'crystal' || integ === 'stone' ? rng.range(0, 0.3) : rng.range(0.3, 1),
    glowAmount,
    glowStyle: rng.weighted([0, 1, 2], (_, i) => [3, 2, role === 'floater' ? 4 : 0.6][i]),
    roughness: integ === 'slime' ? rng.range(0.15, 0.35) : integ === 'chitin' ? rng.range(0.25, 0.45) : integ === 'crystal' ? rng.range(0.08, 0.25) : integ === 'scales' ? rng.range(0.4, 0.6) : integ === 'stone' ? 0.85 : rng.range(0.7, 0.95),
    sheen: integ === 'chitin' || integ === 'feathers' ? (rng.chance(0.35) ? rng.range(0.3, 1) : 0) : integ === 'scales' && rng.chance(0.2) ? rng.range(0.2, 0.6) : 0,
  };

  // ---------------- behaviour
  const diet: Diet = (() => {
    switch (role) {
      case 'grazer': return 'herbivore';
      case 'predator': case 'apex': return 'carnivore';
      case 'construct': return 'lithovore';
      case 'floater': return 'filter';
      case 'fish': return rng.pick(['omnivore', 'herbivore', 'carnivore'] as const);
      case 'bird': return rng.pick(['insectivore', 'omnivore', 'herbivore', 'carnivore'] as const);
      case 'insect': return rng.pick(['herbivore', 'omnivore', 'carnivore'] as const);
      case 'amphibian': return 'insectivore';
      case 'cavecritter': return rng.pick(['omnivore', 'insectivore', 'carnivore', 'lithovore'] as const);
      default: return rng.pick(['herbivore', 'omnivore', 'insectivore'] as const);
    }
  })();
  const activity: Activity = dark ? 'cathemeral' : role === 'construct' ? rng.pick(['cathemeral', 'nocturnal'] as const) : rng.weighted(['diurnal', 'nocturnal', 'crepuscular', 'cathemeral'] as const, (_, i) => [5, role === 'predator' || role === 'amphibian' ? 3 : 1.3, 1.6, 1][i]);
  const sociality: Sociality = (() => {
    switch (role) {
      case 'grazer': return rng.weighted(['herd', 'pair', 'solitary'] as const, (_, i) => [7, 1.5, 1][i]);
      case 'predator': return rng.weighted(['pack', 'solitary', 'pair'] as const, (_, i) => [3.5, 3, 1.4][i]);
      case 'apex': case 'construct': return rng.chance(0.85) ? 'solitary' : 'pair';
      case 'fish': return rng.chance(0.75) ? 'school' : 'solitary';
      case 'bird': return rng.weighted(['flock', 'pair', 'solitary'] as const, (_, i) => [3, 2, 1.5][i]);
      case 'insect': return rng.weighted(['swarm', 'solitary', 'pair'] as const, (_, i) => [2.5, 2, 1][i]);
      case 'floater': return rng.weighted(['swarm', 'solitary', 'herd'] as const, (_, i) => [2, 1.5, 1.5][i]);
      default: return rng.weighted(['solitary', 'pair', 'herd', 'swarm'] as const, (_, i) => [3, 2, 1.2, role === 'cavecritter' ? 1.5 : 0.3][i]);
    }
  })();
  const groupSize: [number, number] = sociality === 'herd' ? [3, rng.int(6, 10)] : sociality === 'pack' ? [2, rng.int(4, 6)] : sociality === 'school' ? [5, rng.int(9, 16)] : sociality === 'swarm' ? [4, rng.int(7, 14)] : sociality === 'flock' ? [3, rng.int(6, 10)] : sociality === 'pair' ? [2, 2] : [1, 1];
  const temperament: Temperament = (() => {
    switch (role) {
      case 'grazer': return rng.weighted(['skittish', 'docile', 'territorial', 'curious'] as const, (_, i) => [5, 2.5, length > 1.6 ? 2 : 0.6, 1][i]);
      case 'predator': return rng.weighted(['aggressive', 'territorial', 'skittish', 'curious'] as const, (_, i) => [4, 2.5, 0.6, 0.8][i]);
      case 'apex': return rng.chance(0.7) ? 'aggressive' : 'territorial';
      case 'construct': return rng.weighted(['territorial', 'docile', 'aggressive'] as const, (_, i) => [4, 1.5, 1.5][i]);
      case 'cavecritter': return rng.weighted(['skittish', 'aggressive', 'curious', 'territorial'] as const, (_, i) => [3, 2, 1, 1][i]);
      case 'floater': return rng.weighted(['docile', 'curious', 'territorial'] as const, (_, i) => [5, 3, 0.6][i]);
      case 'insect': return rng.weighted(['skittish', 'docile', 'territorial', 'aggressive'] as const, (_, i) => [4, 2, 1, length > 0.25 ? 1.5 : 0.2][i]);
      default: return rng.weighted(['skittish', 'curious', 'docile', 'territorial'] as const, (_, i) => [5, 2, 2, 0.6][i]);
    }
  })();

  let medium: Medium = 'ground';
  if (role === 'fish') medium = 'water';
  else if (role === 'amphibian') medium = 'amphibious';
  else if (role === 'floater') medium = 'float';
  else if (role === 'burrower') medium = 'burrow';
  else if (role === 'climber') medium = 'climb';
  else if (plan === 'winged' || wings.kind !== 'none') medium = 'air';
  const flies = medium === 'air' || medium === 'float';
  const swims = medium === 'water' || medium === 'amphibious' || (integ !== 'crystal' && integ !== 'stone' && rng.chance(0.4));

  const gait: Gait = (() => {
    if (plan === 'finned' || role === 'fish') return 'swim';
    if (plan === 'radial') return role === 'floater' ? 'drift' : 'wave';
    if (plan === 'serpentine') return pairs > 0 ? 'wave' : 'slither';
    if (pairs >= 4) return 'wave';
    if (pairs === 3) return 'tripod';
    if (plan === 'biped' || pairs === 1) return role === 'bird' && length < 0.3 && rng.chance(0.5) ? 'hop' : upright && role === 'construct' ? 'stride' : rng.chance(0.15) ? 'waddle' : 'stride';
    if (role === 'smallcritter' && rng.chance(0.5)) return 'bound';
    if (role === 'amphibian' && rng.chance(0.4)) return 'hop';
    if (role === 'predator' || role === 'grazer' || role === 'apex') return 'gallop';
    return rng.chance(0.5) ? 'trot' : 'walk';
  })();

  // ---------------- dimensions & stats
  const spineSegs = plan === 'serpentine' ? clamp(Math.round(rng.range(8, 14)), 8, 14) : pairs >= 4 && !sixLegInsect ? pairs + 1 : plan === 'radial' ? 1 : rng.int(3, 5);
  const bodyWidth = plan === 'radial' ? 1 : plan === 'finned' ? rng.range(0.5, 0.8) : rng.range(0.8, 1.15) * (role === 'construct' ? 1.2 : 1);
  const bodyHeight = plan === 'radial' ? (role === 'floater' ? rng.range(0.7, 1.2) : rng.range(0.3, 0.5)) : plan === 'finned' ? rng.range(1.15, 1.7) : rng.range(0.9, 1.2);
  const legLenM = length * legLenRel;
  const hipHeight = pairs === 0 ? length * girth * bodyHeight * (plan === 'serpentine' ? 1 : 1.1) : sixLegInsect ? legLenM * 0.45 + length * girth * 0.4 : legLenM * (limbs.digitigrade ? 0.92 : 0.95) * (1 - limbs.splay * 0.5) + length * girth * 0.15;
  const neckM = length * neckLen;
  const headR = length * head.size;
  const tailM = length * tail.length;
  let totalLength = length + neckM * Math.cos(neckRaise) + headR * (1 + head.snout) + tailM;
  let height = hipHeight + length * girth * bodyHeight + Math.max(0, neckM * Math.sin(neckRaise)) + headR;
  if (upright) height = hipHeight + length * 1.1 + neckM + headR * 2;
  if (plan === 'radial' && role === 'floater') { height = length * bodyHeight + length * armLen; totalLength = length; }
  const vol = length * Math.PI * (length * girth) ** 2 * bodyWidth * bodyHeight * (plan === 'serpentine' ? 2.4 : 1) + (pairs ? pairs * 2 * legLenM * Math.PI * (length * girth * limbs.thickness) ** 2 : 0);
  const density = role === 'construct' ? 2400 : role === 'floater' ? 120 : integ === 'chitin' ? 900 : 1000;
  const mass = Math.max(0.005, vol * density * 1.6);
  const sizeClass: SizeClass = mass < 1.5 ? 'tiny' : mass < 25 ? 'small' : mass < 220 ? 'medium' : mass < 1500 ? 'large' : 'huge';
  const aggressive = temperament === 'aggressive' || temperament === 'territorial';
  // Gameplay-scaled (players have ~100 hp): cube-root of mass keeps elephants at a few hundred.
  const hp = Math.round((8 + 14 * Math.pow(mass, 0.33)) * (role === 'construct' ? 1.8 : 1) * (role === 'apex' ? 1.6 : 1) * (integ === 'chitin' || integ === 'crystal' || integ === 'stone' ? 1.2 : 1));
  const carnivore = diet === 'carnivore' || role === 'apex';
  const damage = Math.round((1 + 1.15 * Math.pow(mass, 0.3)) * (carnivore ? 1.6 : 0.8) * (aggressive ? 1.2 : 1) * (head.horns || head.antlers ? 1.2 : 1));
  const speedBase = Math.pow(Math.max(hipHeight, 0.04), 0.45) * 4.2;
  let walkSpeed = clamp(speedBase * 0.32, 0.25, 2.2);
  let runSpeed = clamp(speedBase * (role === 'predator' || role === 'grazer' ? 1.55 : 1.1) * (gait === 'gallop' ? 1.15 : 1), 1, 15);
  if (sixLegInsect) { walkSpeed = clamp(length * 3, 0.15, 1.6); runSpeed = clamp(length * 14, 0.8, 7); }
  if (role === 'construct') { walkSpeed *= 0.7; runSpeed *= 0.6; }
  if (flies) runSpeed = Math.max(runSpeed, role === 'floater' ? 2.2 : 7 + length * 4);
  if (medium === 'water') { walkSpeed = clamp(length * 1.5, 0.4, 2); runSpeed = clamp(length * 7, 2, 9); }
  if (plan === 'serpentine' && pairs === 0) { walkSpeed = clamp(length * 0.9, 0.3, 1.6); runSpeed = walkSpeed * 3; }
  const attacks: AttackKind[] = [];
  if (head.mandibles || head.snout > 0.3 || head.beak) attacks.push('bite');
  if ((limbs.foot === 'claw' || limbs.foot === 'paw') && pairs >= 1 && !sixLegInsect) attacks.push('claw');
  if (head.horns || head.antlers || head.tusks || role === 'construct') attacks.push('charge');
  if (role === 'predator' && plan === 'quadruped' && rng.chance(0.6)) attacks.push('pounce');
  if (tail.tip === 'sting') attacks.push('sting');
  if ((role === 'amphibian' || role === 'cavecritter' || (role === 'insect' && length > 0.15) || rng.chance(w * 0.15)) && rng.chance(0.35)) attacks.push('spit');
  if (!attacks.length) attacks.push(role === 'floater' ? 'sting' : 'bite');
  const damageType: DamageKind = attacks.includes('sting') || attacks.includes('spit') ? 'poison' : attacks[0] === 'charge' ? 'blunt' : attacks[0] === 'claw' ? 'slash' : fireHab && rng.chance(0.5) ? 'fire' : role === 'floater' ? 'shock' : 'pierce';
  const loot: string[] = [];
  if (integ === 'fur') loot.push('hide');
  if (integ === 'scales') loot.push('scale');
  if (integ === 'feathers') loot.push('feather');
  if (integ === 'chitin') loot.push('chitin');
  if (integ === 'crystal' || glowAmount > 0.4) loot.push('glowsap');
  if (role !== 'construct' && role !== 'floater' && sizeClass !== 'tiny') loot.push('meat_raw');
  if (sizeClass !== 'tiny' && role !== 'floater') loot.push('bone');
  if (carnivore && head.snout > 0.3) loot.push('fang');
  if (damageType === 'poison') loot.push('venom_sac');
  if (role === 'floater') loot.push('glowsap');
  if (!loot.length) loot.push('bone');

  // ---------------- names
  let noun = phon.word(rng, 1, 2);
  for (let k = 0; k < 6 && usedNames.has(noun); k++) noun = phon.word(rng, 1, 3);
  usedNames.add(noun);
  const name = epithet(rng, { integ, pattern, head, dorsal, tail, colors, habitat, role, plan, dark, glowAmount, limbs, wings }) + ' ' + noun;
  const bossNames: string[] = [];
  const titles = ['the Old', 'Mother of Herds', 'the Hollow-Eyed', 'Ashmaw', 'the Unbroken', 'Graveborn', 'the Pale', 'Stormhide', 'the Hungering', 'Elder', 'the Patient', 'Thornback'];
  for (let i = 0; i < 4; i++) bossNames.push(phon.word(rng, 2, 3) + ' ' + rng.pick(titles));

  const roles: FaunaRole[] = [role];
  if (role === 'apex') roles.push('predator');
  if (role === 'cavecritter' && carnivore) roles.push('predator');

  const sp: Species = {
    index,
    id: `${role}_${ordinal}_${(hash32(rng.seed) % 10000).toString(36)}`,
    name, noun, bossNames, role, roles, plan, medium, integument: integ,
    translucent: integ === 'slime' && (role === 'floater' || (dark && rng.chance(0.5))) || (integ === 'crystal' && role === 'floater'),
    length, girth, bodyWidth, bodyHeight,
    chest: plan === 'radial' ? 1 : rng.range(0.85, 1.35) * (role === 'construct' ? 1.2 : 1),
    belly: rng.range(0, 0.35),
    spineSegs,
    spineArch: plan === 'serpentine' || plan === 'finned' ? 0 : rng.range(-0.1, 0.35) + (dorsal.shell ? 0.2 : 0),
    upright,
    neckLen, neckSegs: clamp(Math.round(1 + neckLen * 5), 1, 6), neckRaise,
    head, limbs, wings, tail, fins, dorsal, arms, armLen,
    chunky: role === 'construct' ? rng.range(0.6, 1) : integ === 'chitin' ? rng.range(0.3, 0.6) : rng.range(0, 0.25),
    colors,
    gait, diet, activity, sociality, groupSize, temperament,
    biomes: habitat.map((h) => h.biome),
    underworld,
    cave: cave && !underworld,
    swims, flies,
    altitude: medium === 'air' ? rng.range(10, 35) : medium === 'float' ? rng.range(3, 18) * (p.lowGravityStrength + 0.5) : 0,
    abundance: rng.range(0.5, 1.5) * (role === 'apex' ? 0.25 : sizeClass === 'tiny' ? 1.4 : 1),
    size: sizeClass, mass, hp, damage, damageType,
    armor: integ === 'chitin' || integ === 'scales' ? 0.15 : integ === 'stone' || integ === 'crystal' ? 0.35 : integ === 'bark' ? 0.2 : 0.05,
    walkSpeed, runSpeed,
    turnRate: clamp(5 / Math.pow(Math.max(length, 0.05), 0.5), 1.2, 12),
    sight: clamp(18 + Math.pow(length, 0.5) * 18, 12, 60) * (head.eyes === 0 ? 0.2 : 1) * (role === 'bird' ? 1.6 : 1),
    fov: role === 'predator' || role === 'apex' ? rng.range(2.0, 3.0) : rng.range(3.6, 5.6),
    hearing: clamp(10 + length * 10, 8, 40) * (head.ears > 0.8 ? 1.4 : 1) * (head.eyes === 0 ? 1.6 : 1),
    reach: clamp(length * (0.6 + head.snout * 0.15) + 0.4, 0.5, 6),
    attacks,
    tameDifficulty: role === 'construct' || role === 'apex' ? 1 : clamp(0.2 + Math.log10(mass + 1) * 0.15 + (aggressive ? 0.25 : 0) + (sixLegInsect ? 0.2 : 0) + (role === 'fish' ? 0.5 : 0), 0.1, 0.95),
    loot,
    height, radius: 0, totalLength, hipHeight,
    seed: rng.nextU32(),
    weird: w,
  };
  sp.radius = clamp(Math.max(length * girth * bodyWidth, Math.min(totalLength, length * 1.2) * 0.32), 0.04, 3.5);
  return sp;
}

function avg<T>(arr: T[], f: (t: T) => number): number {
  let s = 0;
  for (const a of arr) s += f(a);
  return arr.length ? s / arr.length : 0;
}

/** Descriptive prefix from the species' most salient feature. */
function epithet(rng: Rng, s: {
  integ: Integument; pattern: PatternKind; head: HeadGenome; dorsal: DorsalGenome; tail: TailGenome; colors: Coloring; habitat: HabitatCell[];
  role: FaunaRole; plan: BodyPlan; dark: boolean; glowAmount: number; limbs: LimbGenome; wings: WingGenome;
}): string {
  const opts: string[] = [];
  const colorWord = colorName(s.colors.base);
  if (s.pattern === 'stripes') opts.push('Striped', 'Tiger-banded', colorWord + '-striped');
  if (s.pattern === 'spots' || s.pattern === 'rosettes') opts.push('Spotted', 'Dappled', 'Leopard');
  if (s.pattern === 'eyespots') opts.push('Eyed', 'Peacock');
  if (s.pattern === 'bands') opts.push('Ringed', 'Banded');
  if (s.pattern === 'mottled') opts.push('Mottled', 'Speckled');
  if (s.head.horns === 1) opts.push('Unicorn', 'Spire-horned');
  if (s.head.horns >= 4) opts.push('Crowned', 'Many-horned');
  if (s.head.horns === 2) opts.push('Ram', 'Hook-horned', 'Twinhorn');
  if (s.head.antlers) opts.push('Antlered', 'Branchcrown');
  if (s.head.tusks) opts.push('Tusked', 'Ivory');
  if (s.head.eyes === 0) opts.push('Blind', 'Eyeless');
  if (s.head.eyes > 2) opts.push('Many-eyed', 'Gazing');
  if (s.dorsal.spikes) opts.push('Spined', 'Thornback', 'Ridgeback');
  if (s.dorsal.plates) opts.push('Plated');
  if (s.dorsal.shell) opts.push('Shelled', 'Domed', 'Armored');
  if (s.dorsal.sail) opts.push('Sailback');
  if (s.head.frill) opts.push('Frilled');
  if (s.head.crest) opts.push('Crested');
  if (s.tail.tip === 'club') opts.push('Clubtail');
  if (s.tail.tip === 'sting') opts.push('Stinging', 'Barbtail');
  if (s.glowAmount > 0.4) opts.push('Glow', 'Lantern', 'Lumen', 'Starlit');
  if (s.dark) opts.push('Pale', 'Hollow', 'Deep');
  if (s.integ === 'crystal') opts.push('Glass', 'Prism', 'Shard');
  if (s.integ === 'stone') opts.push('Rubble', 'Granite', 'Cairn');
  if (s.integ === 'bark') opts.push('Barkhide', 'Mossback', 'Rootborn');
  if (s.integ === 'slime') opts.push('Slick', 'Glistening');
  if (s.limbs.length > 1.2 && s.limbs.pairs) opts.push('Long-legged', 'Stilt');
  if (s.wings.kind === 'membrane') opts.push('Leatherwing', 'Dusk');
  if (s.wings.kind === 'feather') opts.push(colorWord + '-winged', 'Swift');
  const hb = s.habitat[0]?.biome;
  const habitatWords: Partial<Record<Biome, string[]>> = {
    [Biome.Grassland]: ['Meadow', 'Field'], [Biome.TemperateForest]: ['Wood', 'Thicket'], [Biome.Taiga]: ['Pine', 'Frost'], [Biome.Jungle]: ['Canopy', 'Vine'],
    [Biome.Savanna]: ['Plains', 'Sun'], [Biome.Desert]: ['Dune', 'Sand'], [Biome.Badlands]: ['Mesa', 'Canyon'], [Biome.Tundra]: ['Snow', 'Rime'],
    [Biome.Glacier]: ['Ice', 'Glacier'], [Biome.Swamp]: ['Bog', 'Mire'], [Biome.Volcanic]: ['Ash', 'Ember', 'Cinder'], [Biome.CrystalWastes]: ['Prism', 'Glint'],
    [Biome.FungalGrove]: ['Spore', 'Mold'], [Biome.FloatingIsles]: ['Sky', 'Cloud'], [Biome.KarstPillars]: ['Crag', 'Cliff'], [Biome.SaltFlats]: ['Salt', 'Bleach'],
    [Biome.Ocean]: ['Reef', 'Tide'], [Biome.GlowCaverns]: ['Glimmer', 'Cave'], [Biome.Geodes]: ['Geode', 'Vug'], [Biome.MagmaDepths]: ['Magma', 'Slag'],
    [Biome.UnderSea]: ['Lightless', 'Abyssal'], [Biome.BoneHollows]: ['Ossuary', 'Bone'], [Biome.RootCathedral]: ['Root', 'Hollow'],
  };
  if (hb !== undefined) opts.push(...(habitatWords[hb] ?? []));
  opts.push(colorWord);
  return rng.pick(opts);
}

function colorName(c: RGB): string {
  const r = c[0], g = c[1], b = c[2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1) + 1e-6);
  if (l > 0.82) return 'White';
  if (l < 0.13) return 'Black';
  if (s < 0.15) return l > 0.5 ? 'Ash' : 'Grey';
  let h = 0;
  if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  h /= 6;
  if (h < 0.04 || h > 0.94) return l < 0.35 ? 'Blood' : 'Red';
  if (h < 0.11) return l < 0.4 ? 'Brown' : s < 0.45 ? 'Tawny' : 'Rust';
  if (h < 0.18) return l > 0.55 ? 'Golden' : 'Ochre';
  if (h < 0.42) return l < 0.3 ? 'Moss' : 'Green';
  if (h < 0.55) return 'Teal';
  if (h < 0.7) return l < 0.3 ? 'Midnight' : 'Blue';
  if (h < 0.83) return 'Violet';
  return 'Rose';
}

// ------------------------------------------------------------------ queries

/** Species living in a biome that can fill a role. role 'boss' → apex/big predators; 'any' → all. */
export function speciesForBiome(list: Species[], biome: number, role: string, underworld: boolean): number[] {
  const matchRole = (s: Species): boolean => {
    if (role === 'any' || role === '') return true;
    if (role === 'boss') return s.role === 'apex' || (s.role === 'predator' && (s.size === 'large' || s.size === 'huge')) || s.role === 'construct';
    if (role === 'hostile') return s.temperament === 'aggressive' || s.temperament === 'territorial';
    return s.roles.includes(role as FaunaRole);
  };
  const out: number[] = [];
  for (const s of list) if (matchRole(s) && s.biomes.includes(biome as Biome) && s.underworld === underworld) out.push(s.index);
  if (out.length) return out;
  for (const s of list) if (matchRole(s) && s.biomes.includes(biome as Biome)) out.push(s.index);
  if (out.length) return out;
  for (const s of list) if (matchRole(s) && s.underworld === underworld) out.push(s.index);
  return out;
}

/**
 * Per-individual scale & colour jitter from the CreatureRef. Shared so the
 * server's collision capsule matches what the client draws.
 */
export function individualScale(sp: Species, seed: number, growth: number): number {
  const jitter = 0.88 + hashToFloat(hash32(seed ^ 0x51ed)) * 0.26;
  return jitter * lerp(0.42, 1, clamp(growth, 0, 1));
}

/** Size-class loot table id used with ItemService.rollLoot. */
export function lootTableFor(sp: Species): string {
  return 'creature.' + sp.size;
}
