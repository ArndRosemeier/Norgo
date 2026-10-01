/**
 * Biome archetypes. A world profile picks which archetypes exist, jitters their
 * climate positions and parameters, so the same archetype looks different per seed.
 * Terrain parameters are *blended* between neighboring biomes, materials are dithered.
 */
import { Mat } from './materials';

export const enum Biome {
  Ocean = 0,
  Grassland,
  TemperateForest,
  Taiga,
  Jungle,
  Savanna,
  Desert,
  Badlands,
  Tundra,
  Glacier,
  Swamp,
  Volcanic,
  CrystalWastes,
  FungalGrove,
  FloatingIsles,
  KarstPillars,
  SaltFlats,
  // underworld
  GlowCaverns,
  Geodes,
  MagmaDepths,
  UnderSea,
  BoneHollows,
  RootCathedral,
}

export const BIOME_COUNT = 23;
export const SURFACE_BIOMES: Biome[] = [
  Biome.Grassland, Biome.TemperateForest, Biome.Taiga, Biome.Jungle, Biome.Savanna, Biome.Desert,
  Biome.Badlands, Biome.Tundra, Biome.Glacier, Biome.Swamp, Biome.Volcanic, Biome.CrystalWastes,
  Biome.FungalGrove, Biome.FloatingIsles, Biome.KarstPillars, Biome.SaltFlats,
];
export const UNDERWORLD_BIOMES: Biome[] = [
  Biome.GlowCaverns, Biome.Geodes, Biome.MagmaDepths, Biome.UnderSea, Biome.BoneHollows, Biome.RootCathedral,
];

/** Terrain shaping parameters (blended between biomes). */
export interface TerrainParams {
  /** Added to continental base height (m). */
  base: number;
  /** Rolling hill amplitude (m) and feature scale (m). */
  hillAmp: number;
  hillScale: number;
  /** Multiplier on regional mountain ranges. */
  mountain: number;
  /** Terracing strength 0..1 and step height (m). */
  terrace: number;
  terraceStep: number;
  /** Canyon carving strength 0..1. */
  canyon: number;
  /** Dune field strength 0..1. */
  dune: number;
  /** 3D overhang / cliff noise strength 0..1. */
  overhang: number;
  /** Stone pillar / tower field strength 0..1. */
  pillars: number;
  /** Floating island likelihood 0..1. */
  islands: number;
  /** Impact craters 0..1. */
  crater: number;
  /** Fine detail roughness (m). */
  rough: number;
  /** Pull terrain toward a flat level 0..1 (swamps, salt flats). */
  flatten: number;
  /** Crystal spires 0..1. */
  spikes: number;
  /** Natural arches 0..1. */
  arches: number;
}

export interface BiomeDef {
  id: Biome;
  name: string;
  /** Climate centre: temperature -1..1, humidity -1..1, weirdness 0..1. */
  temp: number;
  humid: number;
  weird: number;
  /** How "special" (lower = more common) — used by profile selection. */
  rarity: number;
  terrain: TerrainParams;
  top: Mat;
  sub: Mat;
  cliff: Mat;
  /** Material for underwater floor. */
  bed: Mat;
  /** Flora tags consumed by the flora system to select species. */
  flora: string[];
  /** Fauna tags consumed by the creature system. */
  fauna: string[];
  /** Vegetation density multiplier 0..2. */
  vegetation: number;
  /** Grass coverage 0..1. */
  grass: number;
  /** Fog density multiplier and tint (rgb 0..1). */
  fog: number;
  fogTint: [number, number, number];
  /** Settlement suitability 0..1. */
  habitable: number;
  /** Ambient particle style. */
  particles?: 'pollen' | 'snow' | 'ash' | 'spores' | 'sparks' | 'dust' | 'fireflies' | 'motes';
  underworld?: boolean;
}

const T = (o: Partial<TerrainParams>): TerrainParams => ({
  base: 0, hillAmp: 8, hillScale: 160, mountain: 1, terrace: 0, terraceStep: 8, canyon: 0, dune: 0, overhang: 0.1,
  pillars: 0, islands: 0, crater: 0, rough: 1.2, flatten: 0, spikes: 0, arches: 0, ...o,
});

export const BIOMES: BiomeDef[] = [];
function def(b: BiomeDef) {
  BIOMES[b.id] = b;
}

def({
  id: Biome.Ocean, name: 'Ocean', temp: 0, humid: 1, weird: 0, rarity: 0,
  terrain: T({ hillAmp: 6, mountain: 0.2, rough: 0.6 }),
  top: Mat.Sand, sub: Mat.Sand, cliff: Mat.Stone, bed: Mat.Sand,
  flora: ['kelp', 'coral'], fauna: ['fish'], vegetation: 0.2, grass: 0, fog: 1, fogTint: [0.6, 0.75, 0.9], habitable: 0,
});
def({
  id: Biome.Grassland, name: 'Meadowlands', temp: 0.15, humid: 0.0, weird: 0.0, rarity: 0,
  terrain: T({ hillAmp: 14, hillScale: 220, mountain: 0.55, overhang: 0.05, arches: 0.05 }),
  top: Mat.Grass, sub: Mat.Dirt, cliff: Mat.Stone, bed: Mat.Gravel,
  flora: ['grass', 'flower', 'broadleaf', 'shrub', 'tallgrass'], fauna: ['grazer', 'smallcritter', 'bird', 'predator', 'insect'],
  vegetation: 0.35, grass: 1, fog: 0.8, fogTint: [0.75, 0.85, 0.95], habitable: 1, particles: 'pollen',
});
def({
  id: Biome.TemperateForest, name: 'Old Forest', temp: 0.1, humid: 0.45, weird: 0.05, rarity: 0,
  terrain: T({ hillAmp: 22, hillScale: 180, mountain: 0.8, overhang: 0.15, arches: 0.05 }),
  top: Mat.ForestFloor, sub: Mat.Dirt, cliff: Mat.Stone, bed: Mat.Mud,
  flora: ['broadleaf', 'fern', 'shrub', 'mushroom', 'flower', 'grass', 'deadwood'], fauna: ['grazer', 'smallcritter', 'bird', 'predator', 'insect'],
  vegetation: 1.4, grass: 0.6, fog: 1.2, fogTint: [0.7, 0.8, 0.75], habitable: 0.8, particles: 'fireflies',
});
def({
  id: Biome.Taiga, name: 'Taiga', temp: -0.45, humid: 0.3, weird: 0.0, rarity: 0,
  terrain: T({ hillAmp: 26, hillScale: 200, mountain: 1.1, overhang: 0.15 }),
  top: Mat.Moss, sub: Mat.Dirt, cliff: Mat.Stone, bed: Mat.Gravel,
  flora: ['conifer', 'shrub', 'fern', 'mushroom', 'deadwood', 'grass'], fauna: ['grazer', 'predator', 'smallcritter', 'bird'],
  vegetation: 1.2, grass: 0.4, fog: 1.3, fogTint: [0.75, 0.82, 0.88], habitable: 0.6,
});
def({
  id: Biome.Jungle, name: 'Jungle', temp: 0.8, humid: 0.85, weird: 0.1, rarity: 0.2,
  terrain: T({ hillAmp: 34, hillScale: 140, mountain: 0.9, overhang: 0.45, pillars: 0.15, arches: 0.1 }),
  top: Mat.Moss, sub: Mat.Mud, cliff: Mat.Limestone, bed: Mat.Mud,
  flora: ['jungle', 'palm', 'fern', 'vine', 'flower', 'giantleaf', 'grass'], fauna: ['smallcritter', 'bird', 'predator', 'insect', 'climber'],
  vegetation: 1.8, grass: 0.8, fog: 1.6, fogTint: [0.65, 0.8, 0.65], habitable: 0.5, particles: 'fireflies',
});
def({
  id: Biome.Savanna, name: 'Savanna', temp: 0.65, humid: -0.3, weird: 0.0, rarity: 0.1,
  terrain: T({ hillAmp: 10, hillScale: 300, mountain: 0.4, pillars: 0.05 }),
  top: Mat.Grass, sub: Mat.Clay, cliff: Mat.Sandstone, bed: Mat.Clay,
  flora: ['acacia', 'tallgrass', 'shrub', 'baobab', 'grass'], fauna: ['grazer', 'predator', 'bird', 'insect', 'smallcritter'],
  vegetation: 0.35, grass: 0.9, fog: 0.6, fogTint: [0.9, 0.85, 0.7], habitable: 0.8, particles: 'dust',
});
def({
  id: Biome.Desert, name: 'Dune Sea', temp: 0.9, humid: -0.85, weird: 0.05, rarity: 0.1,
  terrain: T({ hillAmp: 6, hillScale: 400, mountain: 0.35, dune: 1, rough: 0.4 }),
  top: Mat.Sand, sub: Mat.Sand, cliff: Mat.Sandstone, bed: Mat.Sand,
  flora: ['cactus', 'deadshrub', 'succulent'], fauna: ['smallcritter', 'predator', 'insect', 'burrower'],
  vegetation: 0.12, grass: 0, fog: 0.5, fogTint: [0.95, 0.85, 0.65], habitable: 0.4, particles: 'dust',
});
def({
  id: Biome.Badlands, name: 'Mesa Badlands', temp: 0.7, humid: -0.6, weird: 0.2, rarity: 0.3,
  terrain: T({ hillAmp: 40, hillScale: 220, mountain: 0.6, terrace: 1, terraceStep: 9, canyon: 1, overhang: 0.25, arches: 0.6 }),
  top: Mat.Clay, sub: Mat.Sandstone, cliff: Mat.Sandstone, bed: Mat.Clay,
  flora: ['deadshrub', 'cactus', 'succulent', 'juniper'], fauna: ['smallcritter', 'predator', 'bird', 'burrower'],
  vegetation: 0.15, grass: 0.1, fog: 0.5, fogTint: [0.95, 0.75, 0.6], habitable: 0.4, particles: 'dust',
});
def({
  id: Biome.Tundra, name: 'Tundra', temp: -0.8, humid: -0.2, weird: 0.0, rarity: 0.1,
  terrain: T({ hillAmp: 9, hillScale: 260, mountain: 0.7, rough: 0.8 }),
  top: Mat.Snow, sub: Mat.Gravel, cliff: Mat.Stone, bed: Mat.Gravel,
  flora: ['lichen', 'deadshrub', 'conifer', 'grass'], fauna: ['grazer', 'predator', 'smallcritter'],
  vegetation: 0.15, grass: 0.3, fog: 1.1, fogTint: [0.85, 0.9, 0.97], habitable: 0.3, particles: 'snow',
});
def({
  id: Biome.Glacier, name: 'Glacier', temp: -1, humid: 0.3, weird: 0.1, rarity: 0.3,
  terrain: T({ hillAmp: 30, hillScale: 240, mountain: 1.4, overhang: 0.3, canyon: 0.4, rough: 0.5 }),
  top: Mat.Snow, sub: Mat.Ice, cliff: Mat.Ice, bed: Mat.Ice,
  flora: ['lichen'], fauna: ['predator', 'grazer'], vegetation: 0.02, grass: 0, fog: 1.4, fogTint: [0.85, 0.92, 1], habitable: 0.1, particles: 'snow',
});
def({
  id: Biome.Swamp, name: 'Fen', temp: 0.35, humid: 0.95, weird: 0.15, rarity: 0.15,
  terrain: T({ base: -2, hillAmp: 3, hillScale: 120, mountain: 0.1, flatten: 0.85, rough: 0.6 }),
  top: Mat.Mud, sub: Mat.Mud, cliff: Mat.Dirt, bed: Mat.Mud,
  flora: ['mangrove', 'reed', 'willow', 'mushroom', 'vine', 'lilypad'], fauna: ['amphibian', 'insect', 'bird', 'predator'],
  vegetation: 1.1, grass: 0.5, fog: 2.4, fogTint: [0.6, 0.7, 0.6], habitable: 0.3, particles: 'fireflies',
});
def({
  id: Biome.Volcanic, name: 'Ashlands', temp: 0.95, humid: -0.2, weird: 0.55, rarity: 0.5,
  terrain: T({ base: 10, hillAmp: 30, hillScale: 150, mountain: 1.3, crater: 1, overhang: 0.3, rough: 1.8 }),
  top: Mat.Ash, sub: Mat.Basalt, cliff: Mat.Basalt, bed: Mat.Obsidian,
  flora: ['charred', 'emberbloom', 'succulent'], fauna: ['predator', 'insect', 'burrower'],
  vegetation: 0.15, grass: 0, fog: 1.6, fogTint: [0.5, 0.42, 0.38], habitable: 0.15, particles: 'ash',
});
def({
  id: Biome.CrystalWastes, name: 'Crystal Wastes', temp: -0.1, humid: -0.5, weird: 0.95, rarity: 0.7,
  terrain: T({ hillAmp: 18, hillScale: 200, mountain: 0.8, spikes: 1, overhang: 0.35, arches: 0.4 }),
  top: Mat.Salt, sub: Mat.Marble, cliff: Mat.Crystal, bed: Mat.Crystal,
  flora: ['crystalplant', 'glasstree', 'lichen'], fauna: ['construct', 'insect', 'floater'],
  vegetation: 0.4, grass: 0, fog: 0.8, fogTint: [0.8, 0.75, 1], habitable: 0.2, particles: 'motes',
});
def({
  id: Biome.FungalGrove, name: 'Fungal Grove', temp: 0.3, humid: 0.7, weird: 0.85, rarity: 0.6,
  terrain: T({ hillAmp: 20, hillScale: 160, mountain: 0.6, overhang: 0.4, arches: 0.2 }),
  top: Mat.Mycelium, sub: Mat.Dirt, cliff: Mat.Stone, bed: Mat.Mud,
  flora: ['giantmushroom', 'mushroom', 'spore', 'fern'], fauna: ['insect', 'smallcritter', 'floater', 'grazer'],
  vegetation: 1.3, grass: 0.2, fog: 1.8, fogTint: [0.7, 0.6, 0.8], habitable: 0.5, particles: 'spores',
});
def({
  id: Biome.FloatingIsles, name: 'Skyreach', temp: 0.2, humid: 0.2, weird: 0.9, rarity: 0.7,
  terrain: T({ base: 6, hillAmp: 26, hillScale: 160, mountain: 0.7, islands: 1, overhang: 0.6, arches: 0.5 }),
  top: Mat.Grass, sub: Mat.Dirt, cliff: Mat.Stone, bed: Mat.Gravel,
  flora: ['broadleaf', 'flower', 'vine', 'grass', 'floatbloom'], fauna: ['floater', 'bird', 'grazer'],
  vegetation: 0.8, grass: 1, fog: 0.7, fogTint: [0.8, 0.85, 1], habitable: 0.6, particles: 'motes',
});
def({
  id: Biome.KarstPillars, name: 'Stone Forest', temp: 0.5, humid: 0.6, weird: 0.5, rarity: 0.5,
  terrain: T({ hillAmp: 12, hillScale: 160, mountain: 0.5, pillars: 1, overhang: 0.35, arches: 0.4 }),
  top: Mat.Grass, sub: Mat.Dirt, cliff: Mat.Limestone, bed: Mat.Limestone,
  flora: ['broadleaf', 'vine', 'fern', 'bamboo', 'grass', 'flower'], fauna: ['climber', 'bird', 'grazer', 'smallcritter'],
  vegetation: 1.0, grass: 0.8, fog: 1.5, fogTint: [0.75, 0.82, 0.8], habitable: 0.6,
});
def({
  id: Biome.SaltFlats, name: 'Salt Flats', temp: 0.6, humid: -0.95, weird: 0.6, rarity: 0.6,
  terrain: T({ base: 2, hillAmp: 2, hillScale: 300, mountain: 0.15, flatten: 0.95, rough: 0.15 }),
  top: Mat.Salt, sub: Mat.Clay, cliff: Mat.Sandstone, bed: Mat.Salt,
  flora: ['succulent', 'deadshrub'], fauna: ['grazer', 'insect'], vegetation: 0.03, grass: 0, fog: 0.3, fogTint: [1, 0.97, 0.95], habitable: 0.2,
});

// ---- underworld ----
const U = (o: Partial<BiomeDef> & { id: Biome; name: string }): BiomeDef => ({
  temp: 0, humid: 0, weird: 0.5, rarity: 0, terrain: T({}), top: Mat.Stone, sub: Mat.Stone, cliff: Mat.Stone, bed: Mat.Gravel,
  flora: [], fauna: [], vegetation: 0.5, grass: 0, fog: 2, fogTint: [0.3, 0.3, 0.35], habitable: 0.2, underworld: true, ...o,
});
def(U({
  id: Biome.GlowCaverns, name: 'Glowshroom Caverns', humid: 0.7, top: Mat.Mycelium, sub: Mat.Dirt, cliff: Mat.Stone,
  flora: ['glowshroom', 'cavemoss', 'spore'], fauna: ['insect', 'cavecritter', 'floater'], vegetation: 1.3, fogTint: [0.25, 0.4, 0.5], particles: 'spores', habitable: 0.5,
}));
def(U({
  id: Biome.Geodes, name: 'Geode Halls', top: Mat.Crystal, sub: Mat.Marble, cliff: Mat.Crystal,
  flora: ['crystalplant'], fauna: ['construct', 'cavecritter'], vegetation: 0.6, fogTint: [0.4, 0.3, 0.55], particles: 'motes',
}));
def(U({
  id: Biome.MagmaDepths, name: 'Magma Depths', temp: 1, top: Mat.Basalt, sub: Mat.Basalt, cliff: Mat.Magma, bed: Mat.Obsidian,
  flora: ['emberbloom', 'charred'], fauna: ['predator', 'burrower'], vegetation: 0.2, fogTint: [0.5, 0.2, 0.1], particles: 'sparks', habitable: 0.1,
}));
def(U({
  id: Biome.UnderSea, name: 'Lightless Sea', humid: 1, top: Mat.Gravel, sub: Mat.Stone, cliff: Mat.Limestone, bed: Mat.Mud,
  flora: ['cavemoss', 'glowshroom', 'reed'], fauna: ['amphibian', 'cavecritter', 'fish'], vegetation: 0.6, fogTint: [0.15, 0.25, 0.35], habitable: 0.4,
}));
def(U({
  id: Biome.BoneHollows, name: 'Bone Hollows', top: Mat.Ash, sub: Mat.Limestone, cliff: Mat.Marble,
  flora: ['charred', 'cavemoss', 'bones'], fauna: ['predator', 'cavecritter', 'insect'], vegetation: 0.4, fogTint: [0.35, 0.33, 0.3], particles: 'dust',
}));
def(U({
  id: Biome.RootCathedral, name: 'Root Cathedral', humid: 0.6, top: Mat.Moss, sub: Mat.Dirt, cliff: Mat.Limestone,
  flora: ['hangingroot', 'cavemoss', 'glowshroom', 'fern'], fauna: ['climber', 'cavecritter', 'insect'], vegetation: 1.1, fogTint: [0.25, 0.35, 0.25], particles: 'fireflies', habitable: 0.6,
}));

export const TERRAIN_KEYS: (keyof TerrainParams)[] = [
  'base', 'hillAmp', 'hillScale', 'mountain', 'terrace', 'terraceStep', 'canyon', 'dune', 'overhang', 'pillars',
  'islands', 'crater', 'rough', 'flatten', 'spikes', 'arches',
];
