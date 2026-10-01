/**
 * Architecture styles: per-culture palettes, materials and proportions used by
 * the layout (sizes, roof choice) and the blueprint builders. Pure data.
 *
 * Each race has a home style; mixed settlements blend a second culture in per
 * district / household (see layout.ts), and individual households may borrow a
 * secondary style for one storey or the roof (BuildingInfo.style2).
 */
import type { RaceId } from '../../humanoid/types';
import type { ArchStyle, RoofKind } from '../types';
import { Surf } from './kit';

export const RACE_STYLE: Record<RaceId, ArchStyle> = {
  human: 'timber',
  elf: 'elven',
  dwarf: 'stonekeep',
  orc: 'orcish',
  halfling: 'burrow',
  goblin: 'goblin',
  sylvan: 'sylvan',
  drakeborn: 'drakeborn',
  umbral: 'umbral',
  giantkin: 'megalith',
};

/** Body scale of a race relative to humans — doors, storeys and furniture follow it. */
export const RACE_SCALE: Record<RaceId, number> = {
  human: 1, elf: 1.05, dwarf: 0.88, orc: 1.1, halfling: 0.74, goblin: 0.78, sylvan: 1, drakeborn: 1.12, umbral: 1, giantkin: 1.5,
};

export function asRace(r: string | null | undefined): RaceId {
  return (r && r in RACE_STYLE ? r : 'human') as RaceId;
}

export interface StyleDef {
  id: ArchStyle;
  /** Main wall surfaces & colours (picked per building). */
  wall: { surf: Surf; cols: number[] }[];
  /** Foundation / plinth. */
  base: { surf: Surf; cols: number[] };
  /** Trim: frames, beams, posts. */
  trim: { surf: Surf; cols: number[] };
  roof: { surf: Surf; cols: number[] }[];
  roofs: [RoofKind, number][];
  /** Roof rise per horizontal run. */
  pitch: [number, number];
  floors: [number, number];
  /** Storey height (m) before race scale. */
  storey: number;
  wallT: number;
  window: 'rect' | 'arch' | 'round' | 'slit' | 'pointed';
  /** Lit window colour (sRGB). */
  glow: number;
  /** Accent glow (runes, crystals, embers) or 0. */
  accent: number;
  doorCols: number[];
  /** Floor surface inside. */
  floor: { surf: Surf; cols: number[] };
  /** Lamp kind along streets. */
  lamp: 'lantern' | 'torch' | 'brazier' | 'crystal' | 'mushroom' | 'none';
  /** Plinth height above ground (m). */
  plinth: number;
}

export const STYLES: Record<ArchStyle, StyleDef> = {
  timber: {
    id: 'timber',
    wall: [
      { surf: Surf.Plaster, cols: [0xf0e6d0, 0xe8dcc0, 0xf4efe4, 0xe6d2a8, 0xd9c8a8, 0xeadbc2, 0xd8d2c4] },
      { surf: Surf.StoneBrick, cols: [0xb8b0a2, 0xa89e8e, 0xc4bcae] },
      { surf: Surf.Planks, cols: [0x9a7550, 0x8a6a4a, 0xa4835c] },
    ],
    base: { surf: Surf.Rubble, cols: [0xa09888, 0x948c7c, 0xaaa294] },
    trim: { surf: Surf.Timber, cols: [0x4a3424, 0x553a26, 0x3e2c1e, 0x5e4430] },
    roof: [
      { surf: Surf.Thatch, cols: [0xc8a868, 0xb89a5c, 0xd0b478] },
      { surf: Surf.Shingle, cols: [0x7a5a40, 0x6a4e38, 0x86684a] },
      { surf: Surf.Slate, cols: [0x5a6070, 0x4e5462, 0x666c78] },
      { surf: Surf.ClayTile, cols: [0xb05a3c, 0xa4523a, 0xc06a48] },
    ],
    roofs: [['gable', 6], ['hip', 2], ['mansard', 0.6]],
    pitch: [0.75, 1.15],
    floors: [1, 2],
    storey: 3,
    wallT: 0.3,
    window: 'rect',
    glow: 0xffb35c,
    accent: 0,
    doorCols: [0x5a3a22, 0x3e5a3a, 0x6a2a22, 0x2e4a6a, 0x6a5030],
    floor: { surf: Surf.Planks, cols: [0x8a6a48, 0x7a5e40] },
    lamp: 'lantern',
    plinth: 0.45,
  },
  stonekeep: {
    id: 'stonekeep',
    wall: [
      { surf: Surf.StoneBrick, cols: [0x9a948c, 0x8c867e, 0xa8a196, 0x857d72] },
      { surf: Surf.Carved, cols: [0x958f86, 0x8a8278] },
    ],
    base: { surf: Surf.Rubble, cols: [0x6e6a64, 0x78726a] },
    trim: { surf: Surf.Carved, cols: [0x6a645c, 0x5e5850] },
    roof: [
      { surf: Surf.Slate, cols: [0x4a4e58, 0x3e424c, 0x55595f] },
      { surf: Surf.StoneBrick, cols: [0x7a746c, 0x6e685f] },
      { surf: Surf.Turf, cols: [0x6a8040, 0x5c7438] },
    ],
    roofs: [['flat', 4], ['hip', 2.5], ['gable', 1]],
    pitch: [0.35, 0.6],
    floors: [1, 2],
    storey: 3.1,
    wallT: 0.75,
    window: 'slit',
    glow: 0xff9a40,
    accent: 0xffa040,
    doorCols: [0x4a3020, 0x3a2a1c, 0x5a4030],
    floor: { surf: Surf.StoneBrick, cols: [0x857f76, 0x7a746a] },
    lamp: 'brazier',
    plinth: 0.7,
  },
  elven: {
    id: 'elven',
    wall: [
      { surf: Surf.Marble, cols: [0xf2f0ea, 0xe8ece6, 0xf0ebe0, 0xe4eae8] },
      { surf: Surf.Plaster, cols: [0xeef0e4, 0xe6efe8] },
      { surf: Surf.Bark, cols: [0xa08a6c, 0x947e60] },
    ],
    base: { surf: Surf.Marble, cols: [0xd8d8cc, 0xcfd2c6] },
    trim: { surf: Surf.Bark, cols: [0x8a7458, 0x7c684c, 0x96805e] },
    roof: [
      { surf: Surf.Shingle, cols: [0x4e7a5a, 0x3e6a6a, 0x5a7a4a, 0x6a8a7a] },
      { surf: Surf.Leaf, cols: [0x6aa050, 0x5a9048, 0x7aa860] },
      { surf: Surf.Slate, cols: [0x5a7a8a, 0x4a6a80] },
    ],
    roofs: [['conical', 3], ['gable', 2], ['dome', 1.5], ['hip', 1]],
    pitch: [1.3, 2.1],
    floors: [1, 3],
    storey: 3.4,
    wallT: 0.25,
    window: 'pointed',
    glow: 0xd8f0ff,
    accent: 0x9fe8c8,
    doorCols: [0x8a6a40, 0x6a8a5a, 0x5a7a8a],
    floor: { surf: Surf.Marble, cols: [0xd8d4c8, 0xcfcabc] },
    lamp: 'crystal',
    plinth: 0.35,
  },
  orcish: {
    id: 'orcish',
    wall: [
      { surf: Surf.Bark, cols: [0x6a5038, 0x5e4630, 0x74583c] },
      { surf: Surf.Hide, cols: [0xa08060, 0x8e7050, 0xb09070, 0x7a6048] },
      { surf: Surf.Planks, cols: [0x6a5440, 0x5e4a38] },
    ],
    base: { surf: Surf.Rubble, cols: [0x6a645c, 0x5e5a52] },
    trim: { surf: Surf.Bark, cols: [0x4e3a28, 0x5a4430] },
    roof: [
      { surf: Surf.Hide, cols: [0x8a6a4c, 0x9a7a58, 0x7a5c40, 0x6a4c38] },
      { surf: Surf.Thatch, cols: [0x8a7448, 0x7a6640] },
    ],
    roofs: [['conical', 3], ['gable', 2.5], ['hip', 0.6]],
    pitch: [0.8, 1.3],
    floors: [1, 1],
    storey: 3.2,
    wallT: 0.35,
    window: 'slit',
    glow: 0xff8a3a,
    accent: 0xff5020,
    doorCols: [0x4a3424, 0x5a4030],
    floor: { surf: Surf.Soil, cols: [0x6a5440, 0x5e4a38] },
    lamp: 'torch',
    plinth: 0.15,
  },
  burrow: {
    id: 'burrow',
    wall: [
      { surf: Surf.Plaster, cols: [0xf0e2c0, 0xe8d8b4, 0xf2e8d0] },
      { surf: Surf.Rubble, cols: [0xb0a490, 0xa49884] },
    ],
    base: { surf: Surf.Rubble, cols: [0xa89c88, 0x9c907c] },
    trim: { surf: Surf.Timber, cols: [0x6a4a30, 0x7a5636] },
    roof: [{ surf: Surf.Turf, cols: [0x6aa040, 0x5e9438, 0x78aa48] }],
    roofs: [['dome', 5], ['gable', 1]],
    pitch: [0.6, 0.9],
    floors: [1, 1],
    storey: 2.6,
    wallT: 0.35,
    window: 'round',
    glow: 0xffc070,
    accent: 0,
    doorCols: [0x2e6a3a, 0xa8402e, 0x2e5a8a, 0xd0a030, 0x6a3a7a, 0x3a7a6a],
    floor: { surf: Surf.Planks, cols: [0x9a7450, 0x8a6a48] },
    lamp: 'lantern',
    plinth: 0.2,
  },
  goblin: {
    id: 'goblin',
    wall: [
      { surf: Surf.Planks, cols: [0x7a6650, 0x6a5844, 0x84705a, 0x5e5040] },
      { surf: Surf.Metal, cols: [0x7a6a5a, 0x8a5a3a, 0x6a6e70] },
      { surf: Surf.Hide, cols: [0x8a7a5a, 0x7a6a4a] },
    ],
    base: { surf: Surf.Planks, cols: [0x5e5040, 0x52463a] },
    trim: { surf: Surf.Timber, cols: [0x4a3e30, 0x3e3428] },
    roof: [
      { surf: Surf.Metal, cols: [0x8a5a3a, 0x7a6a5a, 0x6a6e70, 0x9a6a40] },
      { surf: Surf.Planks, cols: [0x6a5844, 0x5e5040] },
      { surf: Surf.Thatch, cols: [0x7a7048, 0x6a6040] },
    ],
    roofs: [['shed', 4], ['gable', 2], ['flat', 1]],
    pitch: [0.3, 0.8],
    floors: [1, 3],
    storey: 2.4,
    wallT: 0.15,
    window: 'rect',
    glow: 0xffe070,
    accent: 0x9aff60,
    doorCols: [0x5a4a3a, 0x6a3a2a, 0x4a5a3a],
    floor: { surf: Surf.Planks, cols: [0x6a5844, 0x5e5040] },
    lamp: 'lantern',
    plinth: 0.1,
  },
  sylvan: {
    id: 'sylvan',
    wall: [
      { surf: Surf.Mushroom, cols: [0xf0e8d8, 0xe8dcc8, 0xf4f0e4, 0xe0d8c8] },
      { surf: Surf.Bark, cols: [0x7a6448, 0x6a5840] },
    ],
    base: { surf: Surf.Bark, cols: [0x5a4a38, 0x4e4032] },
    trim: { surf: Surf.Bark, cols: [0x6a5640, 0x5a4a36] },
    roof: [
      { surf: Surf.Mushroom, cols: [0xb03a2a, 0x7a3aa0, 0x2e6aa0, 0xc07a30, 0x3a8a7a, 0xa04a7a] },
    ],
    roofs: [['dome', 6], ['conical', 1]],
    pitch: [0.5, 0.9],
    floors: [1, 2],
    storey: 2.8,
    wallT: 0.3,
    window: 'round',
    glow: 0x9affd0,
    accent: 0x60ffc0,
    doorCols: [0x6a5a3a, 0x5a6a3a, 0x4a3a2a],
    floor: { surf: Surf.Turf, cols: [0x5a7a3a, 0x4e6e34] },
    lamp: 'mushroom',
    plinth: 0.1,
  },
  drakeborn: {
    id: 'drakeborn',
    wall: [
      { surf: Surf.Basalt, cols: [0x3a3634, 0x443e3a, 0x302c2a, 0x4a403a] },
      { surf: Surf.StoneBrick, cols: [0x5a4a42, 0x4e4038] },
    ],
    base: { surf: Surf.Basalt, cols: [0x2a2624, 0x322c28] },
    trim: { surf: Surf.Metal, cols: [0x6a4a30, 0x7a5a3a, 0x5a4a40] },
    roof: [
      { surf: Surf.Slate, cols: [0x2a2a30, 0x3a2a28, 0x302a2a] },
      { surf: Surf.Metal, cols: [0x7a4a2a, 0x8a5a30] },
    ],
    roofs: [['hip', 4], ['flat', 2], ['gable', 1]],
    pitch: [1.0, 1.6],
    floors: [1, 2],
    storey: 3.4,
    wallT: 0.6,
    window: 'slit',
    glow: 0xff7a2a,
    accent: 0xff5a10,
    doorCols: [0x3a2a24, 0x5a3a2a],
    floor: { surf: Surf.Basalt, cols: [0x3a3432, 0x443c38] },
    lamp: 'brazier',
    plinth: 0.8,
  },
  umbral: {
    id: 'umbral',
    wall: [
      { surf: Surf.Basalt, cols: [0x3a3444, 0x2e2a3a, 0x443c50] },
      { surf: Surf.StoneBrick, cols: [0x4a4458, 0x3e384c] },
      { surf: Surf.Crystal, cols: [0x5a4a7a, 0x4a3a6a] },
    ],
    base: { surf: Surf.Basalt, cols: [0x26222e, 0x2e2a36] },
    trim: { surf: Surf.Crystal, cols: [0x6a4aa0, 0x5a3a8a, 0x7a5ab0] },
    roof: [
      { surf: Surf.Slate, cols: [0x2a2638, 0x322c42] },
      { surf: Surf.Crystal, cols: [0x4a3a7a, 0x3a2e6a] },
    ],
    roofs: [['conical', 3], ['hip', 2], ['flat', 1]],
    pitch: [1.4, 2.4],
    floors: [1, 3],
    storey: 3.3,
    wallT: 0.45,
    window: 'pointed',
    glow: 0xb070ff,
    accent: 0x9a50ff,
    doorCols: [0x2a2430, 0x3a2e44],
    floor: { surf: Surf.Basalt, cols: [0x2e2a36, 0x36303e] },
    lamp: 'crystal',
    plinth: 0.5,
  },
  megalith: {
    id: 'megalith',
    wall: [
      { surf: Surf.Rubble, cols: [0x9a968e, 0x8c887e, 0xa6a296, 0x7e7a70] },
      { surf: Surf.Timber, cols: [0x6a5038, 0x5e4630] },
    ],
    base: { surf: Surf.Rubble, cols: [0x7a766c, 0x6e6a60] },
    trim: { surf: Surf.Timber, cols: [0x5a4430, 0x4e3a28] },
    roof: [
      { surf: Surf.Turf, cols: [0x6a8040, 0x5e7438, 0x748a48] },
      { surf: Surf.Thatch, cols: [0xa08a58, 0x907a4c] },
      { surf: Surf.Hide, cols: [0x8a7458, 0x7a664c] },
    ],
    roofs: [['gable', 5], ['hip', 2]],
    pitch: [0.7, 1.0],
    floors: [1, 1],
    storey: 3.2,
    wallT: 0.9,
    window: 'slit',
    glow: 0xffa860,
    accent: 0x80c0ff,
    doorCols: [0x5a4430, 0x4a3828],
    floor: { surf: Surf.Planks, cols: [0x7a6040, 0x6a5238] },
    lamp: 'torch',
    plinth: 0.5,
  },
  ruined: {
    id: 'ruined',
    wall: [
      { surf: Surf.StoneBrick, cols: [0x8a867c, 0x7e7a70, 0x96928a] },
      { surf: Surf.Rubble, cols: [0x7a766c, 0x6e6a62] },
    ],
    base: { surf: Surf.Rubble, cols: [0x6a665e, 0x5e5a52] },
    trim: { surf: Surf.Carved, cols: [0x6e6a62, 0x625e56] },
    roof: [{ surf: Surf.Slate, cols: [0x4a4c50, 0x404246] }],
    roofs: [['none', 4], ['gable', 1]],
    pitch: [0.6, 1.0],
    floors: [1, 2],
    storey: 3.2,
    wallT: 0.6,
    window: 'arch',
    glow: 0x80a0ff,
    accent: 0x7090ff,
    doorCols: [0x4a3a2a],
    floor: { surf: Surf.Cobble, cols: [0x6a665e] },
    lamp: 'none',
    plinth: 0.3,
  },
};
