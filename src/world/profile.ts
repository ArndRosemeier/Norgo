/**
 * WorldProfile: the "genome" of a world. Every global aspect that should make two
 * seeds look wildly different is decided here, once, from the seed.
 */
import { Rng, deriveSeed } from '../core/rng';
import { hsl2rgb, clamp } from '../core/math';
import { BIOMES, Biome, SURFACE_BIOMES, UNDERWORLD_BIOMES, TerrainParams, TERRAIN_KEYS } from './biomes';

export type RGB = [number, number, number];

export interface BiomeInstance {
  id: Biome;
  /** Climate position after per-world jitter. */
  temp: number;
  humid: number;
  weird: number;
  /** Selection weight in this world (0 = absent). */
  weight: number;
  terrain: TerrainParams;
  /** Per-world color shift for this biome's vegetation (hue offset). */
  hueShift: number;
}

export interface WorldProfile {
  seed: number;
  name: string;
  /** 0 = mundane, 1 = utterly alien. Drives palette & biome weirdness. */
  weirdness: number;

  // --- terrain ---
  continentScale: number;
  /** Positive → more land. */
  landBias: number;
  mountainHeight: number;
  ridgeScale: number;
  ridgeSharpness: number;
  erosionWarp: number;
  riverDensity: number;
  coastRoughness: number;
  /** Global multipliers applied on top of biome params. */
  overhangMul: number;
  archMul: number;
  islandMul: number;
  pillarMul: number;
  canyonMul: number;
  caveDensity: number;
  caveWidth: number;
  cavernFrequency: number;
  underworldOpenness: number;
  shaftFrequency: number;
  oreRichness: number;

  // --- climate ---
  climateScale: number;
  tempOffset: number;
  humidOffset: number;
  /** Temperature drop per 100 m of altitude. */
  lapseRate: number;
  snowLine: number;

  // --- palette (sRGB 0..1) ---
  skyZenith: RGB;
  skyHorizon: RGB;
  sunColor: RGB;
  sunSize: number;
  fogColor: RGB;
  fogDensity: number;
  foliage: RGB;
  foliageDry: RGB;
  rockTint: RGB;
  sandTint: RGB;
  soilTint: RGB;
  crystalTint: RGB;
  fungalTint: RGB;
  waterColor: RGB;
  waterDeep: RGB;
  /** Hue base for vegetation (0..1). Earthlike ≈ 0.27 */
  foliageHue: number;
  moons: { size: number; color: RGB; orbit: number; phase: number }[];
  hasRings: boolean;
  ringTilt: number;
  ringColor: RGB;
  starDensity: number;
  auroraStrength: number;
  dayLengthSec: number;
  axialTilt: number;
  cloudCover: number;
  cloudColor: RGB;

  // --- physics ---
  baseGravity: number;
  gravityAnomalyFrequency: number;
  /** Strength of the low-gravity regions (fraction of base gravity removed). */
  lowGravityStrength: number;

  // --- life ---
  floraSeed: number;
  faunaSeed: number;
  floraDensity: number;
  faunaDensity: number;
  /** Probability-ish that flora/fauna take unusual forms. */
  lifeWeirdness: number;
  /** Biomes present in this world. Index = Biome id. */
  biomes: BiomeInstance[];
  underworld: BiomeInstance[];

  // --- civilization ---
  settlementDensity: number;
  /** Race ids (see humanoid/races) present and their relative population. */
  races: { id: string; weight: number }[];
  /** Overall tech/magic level 0..1 (affects building styles and items). */
  arcaneLevel: number;
  techLevel: number;
}

const SYL_A = ['ka', 'mor', 'el', 'thra', 'vel', 'du', 'ish', 'zar', 'no', 'qua', 'ryn', 'sol', 'ul', 'bra', 'kai', 'ves', 'yth', 'or', 'gal', 'phe', 'ter', 'ny', 'ash', 'ilm'];
const SYL_B = ['go', 'th', 'ra', 'nde', 'mir', 'os', 'ea', 'lun', 'dor', 'ix', 'ae', 'rim', 'vash', 'tel', 'quen', 'zun', 'hal', 'mar'];
const SYL_C = ['', '', 'ia', 'oth', 'ar', 'is', 'en', 'heim', 'ora', 'un', 'eth', 'ys'];

export function worldName(rng: Rng): string {
  const n = rng.pick(SYL_A) + rng.pick(SYL_B) + rng.pick(SYL_C);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

const RACE_POOL = ['human', 'elf', 'dwarf', 'orc', 'halfling', 'goblin', 'sylvan', 'drakeborn', 'umbral', 'giantkin'];

export function createProfile(seed: number): WorldProfile {
  const rng = new Rng(deriveSeed(seed, 'profile'));
  const weirdness = clamp(Math.pow(rng.float(), 1.4) * 1.1, 0, 1);
  const alien = rng.chance(0.15 + weirdness * 0.5);

  // ---- palette ----
  // Foliage: earthlike green most of the time, but alien worlds may be red, purple, teal, golden...
  const foliageHue = alien ? rng.float() : clamp(rng.gaussian(0.27, 0.035), 0.16, 0.42);
  const foliageSat = alien ? rng.range(0.35, 0.75) : rng.range(0.35, 0.6);
  const foliage = hsl2rgb(foliageHue, foliageSat, rng.range(0.22, 0.34));
  const foliageDry = hsl2rgb(foliageHue - 0.12 + rng.range(-0.03, 0.03), foliageSat * 0.7, 0.38);

  const skyHue = alien ? rng.float() : clamp(rng.gaussian(0.58, 0.03), 0.5, 0.66);
  const skySat = rng.range(0.35, alien ? 0.8 : 0.65);
  const skyZenith = hsl2rgb(skyHue, skySat, rng.range(0.32, 0.48));
  const skyHorizon = hsl2rgb(skyHue + rng.range(-0.04, 0.04), skySat * 0.45, rng.range(0.72, 0.86));
  const sunHue = alien ? rng.range(0, 1) : rng.range(0.07, 0.13);
  const sunColor = hsl2rgb(sunHue, alien ? rng.range(0.3, 0.9) : rng.range(0.25, 0.6), 0.88);
  const fogColor = hsl2rgb(skyHue, skySat * 0.35, 0.75);

  const rockHue = rng.float();
  const rockTint = hsl2rgb(rockHue, rng.range(0.02, alien ? 0.3 : 0.12), rng.range(0.42, 0.55));
  const sandTint = hsl2rgb(alien ? rng.float() : rng.range(0.06, 0.12), rng.range(0.25, 0.55), rng.range(0.6, 0.75));
  const soilTint = hsl2rgb(rng.range(0.03, 0.1), rng.range(0.25, 0.45), rng.range(0.22, 0.32));
  const crystalTint = hsl2rgb(rng.float(), rng.range(0.5, 0.9), 0.6);
  const fungalTint = hsl2rgb(rng.float(), rng.range(0.3, 0.6), 0.45);
  const waterHue = alien ? rng.float() : rng.range(0.47, 0.6);
  const waterColor = hsl2rgb(waterHue, rng.range(0.4, 0.7), rng.range(0.28, 0.42));
  const waterDeep = hsl2rgb(waterHue + 0.03, rng.range(0.5, 0.8), rng.range(0.06, 0.14));

  const moonCount = rng.weighted([0, 1, 2, 3], (_, i) => [0.15, 0.5, 0.25, 0.1][i]);
  const moons = [];
  for (let i = 0; i < moonCount; i++) {
    moons.push({
      size: rng.range(0.02, 0.09),
      color: hsl2rgb(rng.float(), rng.range(0, 0.4), rng.range(0.7, 0.9)),
      orbit: rng.range(0.6, 3.5),
      phase: rng.float(),
    });
  }

  // ---- biomes ----
  const biomes: BiomeInstance[] = [];
  const presentCount = rng.int(7, SURFACE_BIOMES.length);
  const shuffled = rng.shuffle(SURFACE_BIOMES.slice());
  // Always keep a "mundane" anchor biome so worlds are not all-weird.
  const anchors = [Biome.Grassland, Biome.TemperateForest, Biome.Savanna, Biome.Taiga];
  const anchor = rng.pick(anchors);
  const present = new Set<Biome>([anchor, ...shuffled.slice(0, presentCount)]);
  for (const b of SURFACE_BIOMES) {
    const d = BIOMES[b];
    let weight = present.has(b) ? rng.range(0.6, 1.4) : 0;
    if (weight > 0) {
      // Weird biomes are favoured in weird worlds, suppressed in mundane ones.
      weight *= d.weird > 0.4 ? 0.3 + weirdness * 1.6 : 1.2 - weirdness * 0.4;
    }
    const terrain = { ...d.terrain };
    for (const k of TERRAIN_KEYS) {
      const v = terrain[k];
      if (k === 'base') terrain[k] = v + rng.range(-6, 6);
      else if (k === 'terraceStep' || k === 'hillScale') terrain[k] = v * rng.range(0.7, 1.4);
      else terrain[k] = v * rng.range(0.6, 1.5);
    }
    biomes[b] = {
      id: b,
      temp: d.temp + rng.range(-0.15, 0.15),
      humid: d.humid + rng.range(-0.15, 0.15),
      weird: d.weird,
      weight,
      terrain,
      hueShift: rng.range(-0.06, 0.06) + (alien ? rng.range(-0.15, 0.15) : 0),
    };
  }
  biomes[Biome.Ocean] = { id: Biome.Ocean, temp: 0, humid: 1, weird: 0, weight: 1, terrain: { ...BIOMES[Biome.Ocean].terrain }, hueShift: 0 };
  const underworld: BiomeInstance[] = [];
  for (const b of UNDERWORLD_BIOMES) {
    const d = BIOMES[b];
    underworld.push({
      id: b, temp: d.temp, humid: d.humid, weird: d.weird, weight: rng.range(0.4, 1.4), terrain: { ...d.terrain }, hueShift: rng.range(-0.1, 0.1),
    });
  }

  // ---- races ----
  const raceCount = rng.int(3, 7);
  const races = rng.sample(RACE_POOL.filter((r) => r !== 'human'), raceCount - 1).map((id) => ({ id, weight: rng.range(0.3, 1) }));
  if (rng.chance(0.85)) races.push({ id: 'human', weight: rng.range(0.8, 1.6) });

  const baseGravity = rng.chance(0.7) ? rng.range(8.6, 10.6) : rng.range(6.5, 13.5);

  return {
    seed,
    name: worldName(rng.fork('name')),
    weirdness,
    continentScale: rng.range(1400, 4200),
    landBias: rng.range(-0.15, 0.35),
    mountainHeight: rng.range(140, 520) * (rng.chance(0.15) ? 1.5 : 1),
    ridgeScale: rng.range(700, 1800),
    ridgeSharpness: rng.range(1.3, 3.2),
    erosionWarp: rng.range(20, 140),
    riverDensity: rng.range(0.4, 1.2),
    coastRoughness: rng.range(0.4, 1.4),
    overhangMul: rng.range(0.5, 1.6) * (1 + weirdness * 0.6),
    archMul: rng.range(0.3, 1.8),
    islandMul: rng.range(0.6, 1.5) * (0.5 + weirdness),
    pillarMul: rng.range(0.5, 1.5),
    canyonMul: rng.range(0.4, 1.6),
    caveDensity: rng.range(0.6, 1.4),
    caveWidth: rng.range(1.15, 1.7),
    cavernFrequency: rng.range(0.5, 1.5),
    underworldOpenness: rng.range(0.55, 1),
    shaftFrequency: rng.range(0.5, 1.5),
    oreRichness: rng.range(0.6, 1.5),

    climateScale: rng.range(1600, 4000),
    tempOffset: rng.range(-0.25, 0.25),
    humidOffset: rng.range(-0.25, 0.25),
    lapseRate: rng.range(0.25, 0.45),
    snowLine: rng.range(170, 420),

    skyZenith, skyHorizon, sunColor,
    sunSize: rng.range(0.6, 1.8),
    fogColor,
    fogDensity: rng.range(0.6, 1.5),
    foliage, foliageDry, rockTint, sandTint, soilTint, crystalTint, fungalTint, waterColor, waterDeep,
    foliageHue,
    moons,
    hasRings: rng.chance(0.12 + weirdness * 0.35),
    ringTilt: rng.range(-0.6, 0.6),
    ringColor: hsl2rgb(rng.float(), rng.range(0.1, 0.4), rng.range(0.65, 0.85)),
    starDensity: rng.range(0.4, 1.6),
    auroraStrength: rng.chance(0.3 + weirdness * 0.3) ? rng.range(0.3, 1) : 0,
    dayLengthSec: rng.range(18, 40) * 60,
    axialTilt: rng.range(0.1, 0.5),
    cloudCover: rng.range(0.15, 0.75),
    cloudColor: hsl2rgb(skyHue, rng.range(0, 0.25), 0.95),

    baseGravity,
    gravityAnomalyFrequency: rng.range(0.3, 1.5),
    lowGravityStrength: rng.range(0.45, 0.8),

    floraSeed: deriveSeed(seed, 'flora'),
    faunaSeed: deriveSeed(seed, 'fauna'),
    floraDensity: rng.range(0.7, 1.3),
    faunaDensity: rng.range(0.7, 1.4),
    lifeWeirdness: clamp(weirdness + rng.range(-0.2, 0.3), 0, 1),
    biomes,
    underworld,

    settlementDensity: rng.range(0.7, 1.4),
    races,
    arcaneLevel: rng.float(),
    techLevel: rng.range(0.1, 0.7),
  };
}
