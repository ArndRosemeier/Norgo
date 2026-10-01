/** Terrain voxel materials. IDs are stored as Uint8 in chunk grids and vertex data. */

export const enum Mat {
  Air = 0,
  Bedrock = 1,
  Stone = 2,
  Dirt = 3,
  Grass = 4,
  Sand = 5,
  Sandstone = 6,
  Snow = 7,
  Ice = 8,
  Gravel = 9,
  Clay = 10,
  Mud = 11,
  Basalt = 12,
  Ash = 13,
  Moss = 14,
  Mycelium = 15,
  Crystal = 16,
  Obsidian = 17,
  Limestone = 18,
  Marble = 19,
  Salt = 20,
  Path = 21,
  Cobble = 22,
  Magma = 23,
  OreIron = 24,
  OreGold = 25,
  OreGem = 26,
  ForestFloor = 27,
}

export const MAT_COUNT = 28;

/** Procedural texture family used by the texture synthesizer. */
export type TexStyle =
  | 'rock' | 'strata' | 'soil' | 'grass' | 'sand' | 'snow' | 'ice' | 'gravel' | 'mud' | 'moss'
  | 'crystal' | 'glass' | 'cobble' | 'salt' | 'magma' | 'ore' | 'litter' | 'ash' | 'marble';

export interface MaterialDef {
  id: Mat;
  name: string;
  /** Default albedo (sRGB 0..1); world profiles tint some of these. */
  color: [number, number, number];
  /** Secondary color used for texture detail. */
  color2: [number, number, number];
  roughness: number;
  /** 0..1 emission strength (crystal, magma, mycelium spots). */
  emissive: number;
  emissiveColor: [number, number, number];
  /** Resistance to digging/explosions: effective radius multiplier is 1/hardness. */
  hardness: number;
  /** Can plants grow on it. */
  fertile: boolean;
  /** Footstep / impact sound family. */
  sound: 'stone' | 'soil' | 'sand' | 'snow' | 'ice' | 'mud' | 'crystal' | 'wood' | 'grass';
  /** Which profile palette slot tints this material (if any). */
  tint?: 'foliage' | 'rock' | 'sand' | 'soil' | 'crystal' | 'fungal';
  style: TexStyle;
  /** Resource dropped when mined (item def id), if any. */
  yields?: string;
  /** Show as steep variant on slopes (grass → dirt/rock). */
  slopeMat?: Mat;
}

const D = (
  id: Mat, name: string, color: [number, number, number], color2: [number, number, number], style: TexStyle,
  o: Partial<MaterialDef> = {},
): MaterialDef => ({
  id, name, color, color2, style,
  roughness: 0.9, emissive: 0, emissiveColor: [0, 0, 0], hardness: 1, fertile: false, sound: 'stone',
  ...o,
});

export const MATERIALS: MaterialDef[] = [
  D(Mat.Air, 'air', [0, 0, 0], [0, 0, 0], 'rock'),
  D(Mat.Bedrock, 'bedrock', [0.16, 0.15, 0.15], [0.08, 0.08, 0.09], 'rock', { hardness: 1000 }),
  D(Mat.Stone, 'stone', [0.45, 0.44, 0.42], [0.3, 0.29, 0.28], 'rock', { hardness: 4, tint: 'rock', yields: 'stone' }),
  D(Mat.Dirt, 'dirt', [0.36, 0.26, 0.18], [0.25, 0.18, 0.12], 'soil', { hardness: 1, fertile: true, sound: 'soil', tint: 'soil', yields: 'soil' }),
  D(Mat.Grass, 'grass', [0.3, 0.45, 0.16], [0.2, 0.32, 0.1], 'grass', { hardness: 1, fertile: true, sound: 'grass', tint: 'foliage', yields: 'soil' }),
  D(Mat.Sand, 'sand', [0.82, 0.72, 0.52], [0.7, 0.6, 0.42], 'sand', { hardness: 0.7, sound: 'sand', tint: 'sand', yields: 'sand' }),
  D(Mat.Sandstone, 'sandstone', [0.78, 0.55, 0.36], [0.62, 0.4, 0.26], 'strata', { hardness: 2.5, tint: 'sand', yields: 'stone' }),
  D(Mat.Snow, 'snow', [0.93, 0.95, 0.98], [0.82, 0.86, 0.94], 'snow', { hardness: 0.5, sound: 'snow', roughness: 0.7 }),
  D(Mat.Ice, 'ice', [0.68, 0.84, 0.95], [0.5, 0.7, 0.88], 'ice', { hardness: 2, sound: 'ice', roughness: 0.15 }),
  D(Mat.Gravel, 'gravel', [0.5, 0.48, 0.45], [0.35, 0.33, 0.31], 'gravel', { hardness: 1.2, sound: 'sand', yields: 'stone' }),
  D(Mat.Clay, 'clay', [0.66, 0.38, 0.27], [0.52, 0.28, 0.2], 'soil', { hardness: 1.4, sound: 'mud', yields: 'clay' }),
  D(Mat.Mud, 'mud', [0.26, 0.22, 0.15], [0.17, 0.14, 0.1], 'mud', { hardness: 0.6, fertile: true, sound: 'mud', roughness: 0.45 }),
  D(Mat.Basalt, 'basalt', [0.17, 0.17, 0.18], [0.1, 0.1, 0.11], 'rock', { hardness: 5, yields: 'stone' }),
  D(Mat.Ash, 'ash', [0.32, 0.31, 0.31], [0.22, 0.21, 0.21], 'ash', { hardness: 0.6, sound: 'sand' }),
  D(Mat.Moss, 'moss', [0.22, 0.36, 0.14], [0.14, 0.24, 0.09], 'moss', { hardness: 1, fertile: true, sound: 'grass', tint: 'foliage' }),
  D(Mat.Mycelium, 'mycelium', [0.42, 0.33, 0.45], [0.28, 0.22, 0.32], 'moss', {
    hardness: 1, fertile: true, sound: 'soil', tint: 'fungal', emissive: 0.35, emissiveColor: [0.4, 0.9, 1.0],
  }),
  D(Mat.Crystal, 'crystal', [0.55, 0.4, 0.85], [0.3, 0.2, 0.6], 'crystal', {
    hardness: 3, sound: 'crystal', roughness: 0.2, tint: 'crystal', emissive: 0.6, emissiveColor: [0.6, 0.4, 1.0], yields: 'crystal_shard',
  }),
  D(Mat.Obsidian, 'obsidian', [0.07, 0.06, 0.09], [0.15, 0.12, 0.2], 'glass', { hardness: 6, roughness: 0.12, sound: 'crystal', yields: 'obsidian' }),
  D(Mat.Limestone, 'limestone', [0.74, 0.72, 0.66], [0.6, 0.58, 0.52], 'strata', { hardness: 3, tint: 'rock', yields: 'stone' }),
  D(Mat.Marble, 'marble', [0.88, 0.87, 0.86], [0.62, 0.6, 0.62], 'marble', { hardness: 4, roughness: 0.4, yields: 'stone' }),
  D(Mat.Salt, 'salt', [0.95, 0.94, 0.92], [0.82, 0.8, 0.78], 'salt', { hardness: 1, sound: 'sand', roughness: 0.6, yields: 'salt' }),
  D(Mat.Path, 'path', [0.45, 0.37, 0.27], [0.34, 0.27, 0.19], 'gravel', { hardness: 1.5, sound: 'soil' }),
  D(Mat.Cobble, 'cobble', [0.5, 0.49, 0.47], [0.3, 0.29, 0.28], 'cobble', { hardness: 4, yields: 'stone' }),
  D(Mat.Magma, 'magma', [0.15, 0.07, 0.05], [1.0, 0.35, 0.05], 'magma', {
    hardness: 3, emissive: 1.4, emissiveColor: [1.0, 0.35, 0.06], yields: 'stone',
  }),
  D(Mat.OreIron, 'iron ore', [0.42, 0.35, 0.32], [0.58, 0.32, 0.18], 'ore', { hardness: 5, tint: 'rock', yields: 'iron_ore' }),
  D(Mat.OreGold, 'gold ore', [0.42, 0.4, 0.36], [0.95, 0.75, 0.25], 'ore', { hardness: 5, tint: 'rock', yields: 'gold_ore' }),
  D(Mat.OreGem, 'gem vein', [0.35, 0.33, 0.36], [0.3, 0.85, 0.75], 'ore', {
    hardness: 6, tint: 'rock', emissive: 0.15, emissiveColor: [0.3, 1, 0.8], yields: 'raw_gem',
  }),
  D(Mat.ForestFloor, 'forest floor', [0.27, 0.22, 0.14], [0.36, 0.3, 0.16], 'litter', { hardness: 1, fertile: true, sound: 'soil', tint: 'soil', yields: 'soil' }),
];

export function matDef(id: number): MaterialDef {
  return MATERIALS[id] ?? MATERIALS[Mat.Stone];
}
