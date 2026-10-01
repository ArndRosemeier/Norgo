/**
 * Cartographic palette: per-biome "painted map" colors, tinted by the world
 * profile so alien worlds produce alien maps. Runs inside the map worker.
 */
import { Biome } from '../../world/biomes';
import type { WorldProfile, RGB } from '../../world/profile';

type Tint = 'foliage' | 'dry' | 'sand' | 'rock' | 'snow' | 'crystal' | 'fungal' | 'soil' | 'ash' | 'salt';

/** Base color + which profile tint to blend toward (and how strongly). */
const BASE: [number, RGB, Tint, number][] = [
  [Biome.Ocean, [0.16, 0.3, 0.42], 'sand', 0],
  [Biome.Grassland, [0.47, 0.58, 0.3], 'foliage', 0.55],
  [Biome.TemperateForest, [0.25, 0.4, 0.22], 'foliage', 0.7],
  [Biome.Taiga, [0.26, 0.36, 0.3], 'foliage', 0.45],
  [Biome.Jungle, [0.16, 0.42, 0.2], 'foliage', 0.75],
  [Biome.Savanna, [0.68, 0.62, 0.36], 'dry', 0.5],
  [Biome.Desert, [0.86, 0.74, 0.5], 'sand', 0.7],
  [Biome.Badlands, [0.72, 0.42, 0.26], 'soil', 0.25],
  [Biome.Tundra, [0.62, 0.64, 0.58], 'dry', 0.2],
  [Biome.Glacier, [0.88, 0.93, 0.97], 'snow', 0],
  [Biome.Swamp, [0.3, 0.37, 0.24], 'foliage', 0.4],
  [Biome.Volcanic, [0.2, 0.17, 0.17], 'ash', 0],
  [Biome.CrystalWastes, [0.6, 0.66, 0.78], 'crystal', 0.5],
  [Biome.FungalGrove, [0.48, 0.32, 0.5], 'fungal', 0.65],
  [Biome.FloatingIsles, [0.52, 0.68, 0.56], 'foliage', 0.4],
  [Biome.KarstPillars, [0.42, 0.5, 0.38], 'rock', 0.35],
  [Biome.SaltFlats, [0.9, 0.88, 0.84], 'salt', 0],
  [Biome.GlowCaverns, [0.2, 0.42, 0.45], 'fungal', 0.4],
  [Biome.Geodes, [0.48, 0.38, 0.6], 'crystal', 0.6],
  [Biome.MagmaDepths, [0.55, 0.18, 0.08], 'ash', 0],
  [Biome.UnderSea, [0.1, 0.18, 0.28], 'rock', 0.1],
  [Biome.BoneHollows, [0.72, 0.68, 0.58], 'rock', 0.15],
  [Biome.RootCathedral, [0.36, 0.3, 0.2], 'foliage', 0.3],
];

export interface MapPalette {
  biome: Float32Array; // BIOME_COUNT * 3
  water: RGB;
  deep: RGB;
  rock: RGB;
  snow: RGB;
  road: RGB;
  paving: RGB;
  shore: RGB;
  cave: RGB;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function buildPalette(p: WorldProfile): MapPalette {
  const tints: Record<Tint, RGB> = {
    foliage: p.foliage,
    dry: p.foliageDry,
    sand: p.sandTint,
    rock: p.rockTint,
    snow: [0.93, 0.95, 0.98],
    crystal: p.crystalTint,
    fungal: p.fungalTint,
    soil: p.soilTint,
    ash: [0.2, 0.18, 0.18],
    salt: [0.92, 0.9, 0.86],
  };
  const biome = new Float32Array(32 * 3);
  for (const [id, base, tint, k] of BASE) {
    // Foliage tints are dark in the profile (meant for lit 3D); lift them for the map.
    let t = tints[tint];
    if (tint === 'foliage' || tint === 'dry' || tint === 'fungal') t = mix(t, [t[0] * 1.6, t[1] * 1.6, t[2] * 1.6], 0.6);
    const c = mix(base, t, k);
    biome[id * 3] = c[0];
    biome[id * 3 + 1] = c[1];
    biome[id * 3 + 2] = c[2];
  }
  return {
    biome,
    water: mix(p.waterColor, [0.3, 0.55, 0.7], 0.35),
    deep: mix(p.waterDeep, [0.05, 0.12, 0.22], 0.4),
    rock: mix(p.rockTint, [0.5, 0.48, 0.45], 0.4),
    snow: [0.95, 0.96, 0.98],
    road: [0.58, 0.46, 0.32],
    paving: [0.66, 0.6, 0.5],
    shore: mix(p.sandTint, [0.85, 0.8, 0.65], 0.5),
    cave: [0.09, 0.08, 0.1],
  };
}
