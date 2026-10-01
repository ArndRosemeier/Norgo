/**
 * Per-world flora catalog (shared by chunk workers, the client renderer and the
 * server ObjectSystem — no three.js, no DOM).
 *
 * From `profile.floraSeed` every world grows its own set of species: tree
 * archetypes with individual growth parameters, shrubs, flowers, herbs,
 * mushrooms, cacti, water plants, cave flora, rocks and props. Each biome flora
 * tag (see biomes.ts) maps to one or more species; weird worlds swap mundane
 * archetypes for alien growth forms and shift palettes far away from green.
 *
 * Everything here is deterministic: worker, client and server all call
 * `getFloraCatalog(profile)` and obtain identical species indices, which are
 * the basis of scatter kind strings ("f<idx>") and object yields.
 */
import { Rng, deriveSeed } from '../core/rng';
import { clamp, hsl2rgb, lerp, mixRgb } from '../core/math';
import { Biome, BIOMES, BIOME_COUNT, SURFACE_BIOMES, UNDERWORLD_BIOMES } from '../world/biomes';
import { Mat, MATERIALS } from '../world/materials';
import type { RGB, WorldProfile } from '../world/profile';
import { materialColors } from '../world/terrainTextures';

// ------------------------------------------------------------------ enums & types

/** Placement layers; each has its own world-aligned jittered grid (see scatter.ts). */
export const enum Layer {
  Tree = 0,
  Shrub = 1,
  Small = 2,
  Grass = 3,
  Boulder = 4,
  Debris = 5,
  /** Walls & ceilings (3D cells): vines, roots, moss, crystals, stalactites. */
  Surface3D = 6,
}
export const LAYER_COUNT = 7;

/** Water relation of a species. */
export const enum WaterMode {
  /** Dry land only. */
  Land = 0,
  /** Shoreline / wet banks (just above and just below the water line). */
  Shore = 1,
  /** On the floor below the water surface. */
  Under = 2,
  /** Floating on the water surface. */
  Float = 3,
}

/** Light requirement. */
export const enum CaveMode {
  /** Needs open sky. */
  Sky = 0,
  /** Grows anywhere. */
  Any = 1,
  /** Only in darkness (caves, underworld). */
  Dark = 2,
}

/** How an instance is oriented. */
export const enum Orient {
  /** Grows straight up (gravitropism), with a slight lean. */
  Up = 0,
  /** Aligned to the surface normal (moss, crystals, shelf fungi). */
  Normal = 1,
  /** Hangs from ceilings (roots, vines, stalactites). */
  Hang = 2,
  /** Partially aligned (rocks, grass): halfway between up and normal. */
  Half = 3,
}

export type FloraClass = 'tree' | 'shrub' | 'plant' | 'grass' | 'rock' | 'cover' | 'hang' | 'water' | 'debris';

export type FloraForm =
  // trees
  | 'oak' | 'birch' | 'fir' | 'pine' | 'willow' | 'palm' | 'baobab' | 'acacia' | 'mangrove' | 'bamboo' | 'emergent' | 'kapok'
  | 'juniper' | 'snag' | 'charred' | 'giantshroom' | 'glasstree' | 'spiral' | 'bulb' | 'umbrella' | 'saguaro'
  // shrubs & plants
  | 'bush' | 'berrybush' | 'deadbush' | 'fern' | 'giantleaf' | 'grass' | 'tallgrass' | 'flower' | 'herb' | 'mushroom'
  | 'glowshroom' | 'glowshelf' | 'sporepod' | 'barrel' | 'succulent' | 'reed' | 'lilypad' | 'kelp' | 'coral' | 'vine' | 'root'
  | 'moss' | 'lichen' | 'crystal' | 'emberbloom' | 'floatbloom' | 'bones'
  // rocks & props
  | 'boulder' | 'rock' | 'pebbles' | 'slab' | 'stalagmite' | 'stalactite' | 'orerock' | 'saltcrust' | 'log' | 'driftwood';

export type InteractPrompt = '' | 'Chop' | 'Mine' | 'Gather' | 'Pick';
export type ColliderMaterial = 'wood' | 'stone' | 'metal' | 'crystal' | 'flesh' | 'plant' | 'cloth' | 'ice';
export type HarvestSkill = 'woodcutting' | 'mining' | 'herbalism' | 'foraging';

export interface Yield {
  item: string;
  min: number;
  max: number;
  /** Probability the yield happens at all (default 1). */
  chance?: number;
  /** Multiply counts by the instance size factor (trees, boulders). */
  scaled?: boolean;
}

export interface SpeciesCollider {
  shape: 'capsule' | 'sphere';
  /** Radius in reference geometry units (multiplied by instance scale). */
  r: number;
  /** Capsule height / sphere centre height in reference units. */
  h: number;
  solid: boolean;
}

export interface FloraSpecies {
  idx: number;
  /** Stable key (tag + ordinal), useful for debugging and saves. */
  key: string;
  name: string;
  cls: FloraClass;
  form: FloraForm;
  /** Gameplay kind word reported to the bus: tree, rock, crystal, herb, flower, mushroom, shrub, cactus, bones, log, plant. */
  kind: string;
  /** Biome flora tag this species serves ('' = generic). */
  tag: string;
  seed: number;
  /** Number of distinct geometry variants. */
  variants: number;
  /** Reference size in meters (height for plants/trees, diameter for rocks). Builders use it directly. */
  size: number;
  /** Instance scale range (multiplies the reference geometry). */
  scale: [number, number];
  // ---- palette (sRGB 0..1)
  bark: RGB;
  bark2: RGB;
  leaf: RGB;
  leaf2: RGB;
  accent: RGB;
  /** Emissive strength of glowing parts (0 = none). */
  glow: number;
  /** Form-specific growth parameters. */
  p: Record<string, number>;
  // ---- placement
  layer: Layer;
  /** Minimum surface normal y (slope limit). */
  slope: number;
  /** Bitmask of allowed ground materials (1 << Mat); 0 = any solid. */
  mats: number;
  water: WaterMode;
  cave: CaveMode;
  orient: Orient;
  /** Patchiness 0..1 (higher = tighter stands). */
  cluster: number;
  /** Max chunk LOD at which the species is emitted. */
  lods: number;
  /** Casts shadows (when near). */
  shadow: boolean;
  // ---- gameplay
  hp: number;
  interact: InteractPrompt;
  /** Gathered in one action and vanishes (regrows if regrow > 0). */
  harvest: boolean;
  material: ColliderMaterial;
  skill: HarvestSkill;
  yields: Yield[];
  col: SpeciesCollider | null;
  /** Seconds until a harvested instance regrows (0 = never). */
  regrow: number;
}

export interface WeightedSpecies {
  sp: number;
  w: number;
}

/** Placement table of one biome (or cave context). */
export interface BiomeFlora {
  layers: WeightedSpecies[][];
  /** Probability that a cell of the layer holds something (before local modulation). */
  prob: number[];
}

export interface FloraCatalog {
  seed: number;
  species: FloraSpecies[];
  /** Surface + underworld biome tables, indexed by Biome. */
  biomes: BiomeFlora[];
  /** Cave tables (underground but not underworld), indexed by the surface biome above. */
  caves: BiomeFlora[];
  /** Species per tag. */
  byTag: Map<string, number[]>;
}

// ------------------------------------------------------------------ helpers

/** sRGB → HSL (0..1). */
export function rgb2hsl(c: RGB): [number, number, number] {
  const r = c[0], g = c[1], b = c[2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

const matMask = (...m: Mat[]) => m.reduce((a, x) => a | (1 << x), 0);
/** Soils plants grow in. */
export const FERTILE = matMask(Mat.Dirt, Mat.Grass, Mat.Mud, Mat.Moss, Mat.Mycelium, Mat.ForestFloor);
export const FERTILE_SAND = FERTILE | matMask(Mat.Sand, Mat.Clay, Mat.Gravel);
export const ARID = matMask(Mat.Sand, Mat.Clay, Mat.Sandstone, Mat.Gravel, Mat.Dirt, Mat.Grass, Mat.Salt);
export const ROCKY = matMask(Mat.Stone, Mat.Gravel, Mat.Basalt, Mat.Limestone, Mat.Marble, Mat.Sandstone, Mat.Obsidian, Mat.Ash, Mat.Snow, Mat.Ice);
export const VOLCANIC = matMask(Mat.Ash, Mat.Basalt, Mat.Obsidian, Mat.Magma, Mat.Stone);
export const CRYSTAL_GROUND = matMask(Mat.Crystal, Mat.Salt, Mat.Marble, Mat.Stone, Mat.Limestone);
export const ANY = 0;
export const SNOW = matMask(Mat.Snow);

const HIDDEN_TAGS = new Set<string>();

function jitterHsl(rng: Rng, base: RGB, dh: number, ds: number, dl: number): RGB {
  const [h, s, l] = rgb2hsl(base);
  return hsl2rgb(h + rng.range(-dh, dh), clamp(s + rng.range(-ds, ds), 0, 1), clamp(l + rng.range(-dl, dl), 0.03, 0.97));
}

function hsl(h: number, s: number, l: number): RGB {
  return hsl2rgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
}

// ------------------------------------------------------------------ naming

const NAME_PRE = [
  'Silver', 'Ash', 'Iron', 'Amber', 'Moon', 'Ember', 'Frost', 'Mist', 'Dusk', 'Thorn', 'Gloom', 'Sun', 'Star', 'Hollow', 'Velvet',
  'Copper', 'Ghost', 'Bramble', 'Rust', 'Pale', 'Storm', 'Witch', 'Dragon', 'Hearth', 'Sorrow', 'Glimmer', 'Raven', 'Opal', 'Bitter', 'Honey',
];
const NAME_FORM: Partial<Record<FloraForm, string[]>> = {
  oak: ['oak', 'crown', 'elder', 'bough'], birch: ['birch', 'aspen', 'wand'], fir: ['fir', 'spire', 'spruce'], pine: ['pine', 'cone'],
  willow: ['willow', 'weeper', 'veil'], palm: ['palm', 'frond'], baobab: ['baobab', 'bottletree'], acacia: ['acacia', 'thorntree'],
  mangrove: ['mangrove', 'stilt-tree'], bamboo: ['bamboo', 'cane'], emergent: ['giant', 'skytree', 'kapok'], kapok: ['canopy', 'fig'],
  juniper: ['juniper', 'gnarl'], snag: ['snag', 'deadwood'], charred: ['cinderwood', 'charwood'], giantshroom: ['cap', 'toadstool tree', 'mushroom tree'],
  glasstree: ['glasstree', 'prism tree'], spiral: ['coilwood', 'helix'], bulb: ['bulbtree', 'gourdwood'], umbrella: ['parasol', 'tierwood'],
  saguaro: ['saguaro', 'pillar cactus'], bush: ['shrub', 'bush'], berrybush: ['berry', 'bramble'], deadbush: ['tumbleweed', 'brittlebush'],
  fern: ['fern', 'bracken'], giantleaf: ['elephant ear', 'broadleaf'], grass: ['grass'], tallgrass: ['tallgrass', 'reedgrass'],
  flower: ['bloom', 'lily', 'bell', 'star', 'cup'], herb: ['wort', 'leaf', 'root', 'weed'], mushroom: ['cap', 'shroom', 'morel'],
  glowshroom: ['glowcap', 'lantern'], glowshelf: ['shelf fungus'], sporepod: ['puffball', 'sporepod'], barrel: ['barrel cactus', 'pad cactus'],
  succulent: ['aloe', 'rosette'], reed: ['cattail', 'reed'], lilypad: ['lily'], kelp: ['kelp'], coral: ['coral'], vine: ['vine', 'creeper'],
  root: ['root'], moss: ['moss'], lichen: ['lichen'], crystal: ['crystal', 'shardbloom'], emberbloom: ['emberbloom', 'cinderflower'],
  floatbloom: ['floatbloom', 'skybell'], bones: ['bones'],
};

function speciesName(rng: Rng, form: FloraForm): string {
  const base = rng.pick(NAME_FORM[form] ?? [form]);
  const pre = rng.pick(NAME_PRE);
  // Short single words fuse ("Ashbark"), longer ones stay separate ("Ember Weeping Veil").
  const fused = base.length <= 6 && !base.includes(' ') && rng.chance(0.45);
  return fused ? pre + base : pre + ' ' + base.charAt(0).toUpperCase() + base.slice(1);
}

// ------------------------------------------------------------------ catalog builder

type SpecInit = Partial<FloraSpecies> & { form: FloraForm; cls: FloraClass; layer: Layer; size: number };

class CatalogBuilder {
  readonly species: FloraSpecies[] = [];
  readonly byTag = new Map<string, number[]>();
  readonly p: WorldProfile;
  readonly weird: number;
  readonly alien: boolean;
  /** HSL of the world foliage. */
  readonly fh: number;
  readonly fs: number;
  readonly fl: number;

  constructor(profile: WorldProfile, readonly rng: Rng) {
    this.p = profile;
    this.weird = profile.lifeWeirdness;
    const [h, s, l] = rgb2hsl(profile.foliage);
    this.fh = h;
    this.fs = s;
    this.fl = l;
    this.alien = Math.abs(((profile.foliageHue - 0.27 + 1.5) % 1) - 0.5) > 0.12;
  }

  /** Leaf color around the world foliage hue. */
  leafColor(r: Rng, spread = 0.05, light = 0): RGB {
    const dh = spread * (1 + this.weird * 1.5);
    return hsl(this.fh + r.range(-dh, dh), clamp(this.fs + r.range(-0.12, 0.12), 0.15, 0.85), clamp(this.fl + light + r.range(-0.06, 0.06), 0.1, 0.6));
  }

  barkColor(r: Rng, light = 0): RGB {
    if (r.chance(this.weird * 0.35)) return hsl(r.float(), r.range(0.15, 0.45), r.range(0.15, 0.4) + light);
    return hsl(r.range(0.04, 0.1), r.range(0.15, 0.4), r.range(0.14, 0.3) + light);
  }

  /** Bright accent (flowers, berries, spots, glow). */
  accentColor(r: Rng): RGB {
    const h = r.float();
    return hsl(h, r.range(0.55, 0.95), r.range(0.45, 0.65));
  }

  add(tag: string, init: SpecInit): number {
    const idx = this.species.length;
    const r = this.rng.fork('sp', idx, init.form);
    const sp: FloraSpecies = {
      idx,
      key: (tag || init.form) + '#' + idx,
      name: init.name ?? speciesName(r.fork('name'), init.form),
      kind: init.kind ?? init.cls,
      tag,
      seed: r.nextU32(),
      variants: 1,
      scale: [0.8, 1.2],
      bark: this.barkColor(r),
      bark2: this.barkColor(r, -0.06),
      leaf: this.leafColor(r),
      leaf2: this.leafColor(r, 0.05, 0.08),
      accent: this.accentColor(r),
      glow: 0,
      p: {},
      slope: 0.72,
      mats: FERTILE,
      water: WaterMode.Land,
      cave: CaveMode.Sky,
      orient: Orient.Up,
      cluster: 0.4,
      lods: 0,
      shadow: false,
      hp: 0,
      interact: '',
      harvest: false,
      material: 'plant',
      skill: 'foraging',
      yields: [],
      col: null,
      regrow: 0,
      ...init,
    } as FloraSpecies;
    if (!sp.name) sp.name = speciesName(r.fork('name2'), sp.form);
    this.species.push(sp);
    if (tag) {
      let l = this.byTag.get(tag);
      if (!l) this.byTag.set(tag, (l = []));
      l.push(idx);
    }
    return idx;
  }
}

// ---------------------------------------------------------------- tree helpers

const WOOD_YIELDS = (logs: number, extra: Yield[] = []): Yield[] => [
  { item: 'log', min: Math.max(1, logs - 1), max: logs + 1, scaled: true },
  { item: 'stick', min: 1, max: 3 },
  { item: 'bark', min: 0, max: 2, chance: 0.7 },
  { item: 'seed', min: 1, max: 1, chance: 0.3 },
  ...extra,
];

function treeBase(b: CatalogBuilder, r: Rng, form: FloraForm, size: number, trunkR: number, extra: Partial<FloraSpecies> = {}): SpecInit {
  return {
    form, cls: 'tree', layer: Layer.Tree, size, kind: 'tree',
    variants: 2, scale: [0.72, 1.3], lods: 3, shadow: true, slope: 0.7, mats: FERTILE_SAND,
    hp: Math.round(40 + size * 7 + trunkR * 90), interact: 'Chop', material: 'wood', skill: 'woodcutting',
    yields: WOOD_YIELDS(Math.max(1, Math.round(size / 5))),
    col: { shape: 'capsule', r: trunkR * 1.05, h: Math.min(size * 0.55, 7), solid: true },
    cluster: 0.5,
    ...extra,
    p: { trunkR, ...(extra.p ?? {}) },
  };
}

/** Make a tree species alien (keeps its tag & placement, swaps the growth form). */
function alienize(b: CatalogBuilder, r: Rng, init: SpecInit): SpecInit {
  const form = r.pick<FloraForm>(['spiral', 'bulb', 'umbrella']);
  const trunkR = init.p?.trunkR ?? 0.3;
  return {
    ...init,
    form,
    name: undefined,
    leaf: hsl(r.float(), r.range(0.45, 0.9), r.range(0.35, 0.6)),
    leaf2: hsl(r.float(), r.range(0.45, 0.9), r.range(0.4, 0.65)),
    bark: hsl(r.float(), r.range(0.1, 0.5), r.range(0.2, 0.45)),
    bark2: hsl(r.float(), r.range(0.1, 0.5), r.range(0.15, 0.35)),
    glow: r.chance(0.4) ? r.range(0.3, 0.9) : 0,
    yields: WOOD_YIELDS(2, [{ item: 'glowsap', min: 1, max: 2, chance: 0.5 }]),
    p: { trunkR, twist: r.range(1.5, 4), tiers: r.int(2, 5), pods: r.int(4, 11), droop: r.range(0, 0.6) },
  };
}

// ------------------------------------------------------------------ tag definitions

/** Create species for one tag. Returns nothing; species are registered in the builder. */
function defineTag(b: CatalogBuilder, tag: string) {
  const r = b.rng.fork('tag', tag);
  const weirdSwap = (init: SpecInit) => (b.weird > 0.25 && r.chance(Math.pow(b.weird, 2) * 0.75) ? alienize(b, r.fork('alien', init.form), init) : init);
  switch (tag) {
    // ------------------------------------------------------------------ trees
    case 'broadleaf': {
      const oak = treeBase(b, r, 'oak', r.range(10, 17), r.range(0.3, 0.5), {
        p: { crownW: r.range(0.75, 1.15), crownH: r.range(0.5, 0.75), trunkFrac: r.range(0.25, 0.42), gnarl: r.range(0.1, 0.45), leafSize: r.range(1.0, 1.6), density: r.range(0.8, 1.2) },
      });
      b.add(tag, weirdSwap(oak));
      // Second broadleaf: birch, autumn maple or a tall linden-like crown.
      const kind = r.int(0, 2);
      if (kind === 0) {
        b.add(tag, weirdSwap(treeBase(b, r, 'birch', r.range(11, 16), r.range(0.15, 0.24), {
          bark: hsl(r.range(0.08, 0.14), r.range(0.02, 0.1), r.range(0.78, 0.9)),
          bark2: hsl(r.range(0.05, 0.1), 0.1, r.range(0.08, 0.16)),
          leaf: b.leafColor(r, 0.04, 0.06),
          hp: 70,
          p: { trunkR: 0.2, lean: r.range(0, 0.12), leafSize: r.range(0.7, 1.0), droop: r.range(0, 0.4) },
        })));
      } else {
        const autumn = kind === 1;
        const leaf = autumn ? hsl(r.range(-0.02, 0.13), r.range(0.65, 0.9), r.range(0.38, 0.5)) : b.leafColor(r, 0.06, -0.03);
        b.add(tag, weirdSwap(treeBase(b, r, 'oak', r.range(13, 20), r.range(0.3, 0.45), {
          leaf, leaf2: autumn ? hsl(r.range(0.0, 0.15), 0.8, 0.55) : b.leafColor(r, 0.05, 0.05),
          p: { crownW: r.range(0.55, 0.75), crownH: r.range(0.65, 0.85), trunkFrac: r.range(0.2, 0.3), gnarl: r.range(0.05, 0.2), leafSize: r.range(1.1, 1.5), density: 1.1 },
        })));
      }
      break;
    }
    case 'conifer': {
      const needle = b.leafColor(r, 0.04, -0.07);
      b.add(tag, weirdSwap(treeBase(b, r, 'fir', r.range(14, 24), r.range(0.25, 0.42), {
        leaf: needle, mats: FERTILE_SAND | SNOW, leaf2: b.leafColor(r, 0.04, -0.02),
        p: { whorls: r.int(9, 15), droop: r.range(0.1, 0.5), crownW: r.range(0.28, 0.42), bare: r.range(0.05, 0.15), leafSize: r.range(0.9, 1.3) },
        yields: WOOD_YIELDS(3, [{ item: 'resin', min: 1, max: 2, chance: 0.6 }]),
      })));
      b.add(tag, weirdSwap(treeBase(b, r, 'pine', r.range(15, 24), r.range(0.28, 0.45), {
        mats: FERTILE_SAND | SNOW, leaf: b.leafColor(r, 0.05, -0.04),
        bark: hsl(r.range(0.03, 0.08), r.range(0.3, 0.5), r.range(0.22, 0.32)),
        p: { bare: r.range(0.45, 0.65), crownW: r.range(0.3, 0.5), lean: r.range(0, 0.15), leafSize: r.range(1.0, 1.4) },
        yields: WOOD_YIELDS(3, [{ item: 'resin', min: 1, max: 3, chance: 0.8 }]),
      })));
      break;
    }
    case 'jungle': {
      b.add(tag, weirdSwap(treeBase(b, r, 'emergent', r.range(24, 36), r.range(0.55, 0.8), {
        scale: [0.75, 1.25], slope: 0.65,
        p: { crownW: r.range(0.35, 0.5), buttress: r.range(0.6, 1), leafSize: r.range(1.6, 2.3), bare: r.range(0.6, 0.75) },
      })));
      b.add(tag, weirdSwap(treeBase(b, r, 'kapok', r.range(13, 19), r.range(0.4, 0.6), {
        leaf: b.leafColor(r, 0.05, 0.02),
        p: { crownW: r.range(1.0, 1.4), crownH: r.range(0.35, 0.5), trunkFrac: r.range(0.45, 0.6), gnarl: r.range(0.1, 0.3), leafSize: r.range(1.3, 1.9), density: 1.2, buttress: r.range(0.3, 0.7) },
      })));
      break;
    }
    case 'palm':
      b.add(tag, weirdSwap(treeBase(b, r, 'palm', r.range(8, 14), r.range(0.18, 0.26), {
        mats: FERTILE_SAND, slope: 0.75, hp: 60,
        bark: hsl(r.range(0.06, 0.1), r.range(0.2, 0.35), r.range(0.3, 0.42)),
        p: { fronds: r.int(7, 12), curve: r.range(0.1, 0.35), frondLen: r.range(0.32, 0.45), droop: r.range(0.3, 0.7) },
        yields: [{ item: 'log', min: 1, max: 3, scaled: true }, { item: 'fiber', min: 1, max: 3 }, { item: 'seed', min: 1, max: 2, chance: 0.5 }],
      })));
      break;
    case 'acacia':
      b.add(tag, weirdSwap(treeBase(b, r, 'acacia', r.range(7, 11), r.range(0.22, 0.32), {
        mats: ARID | FERTILE, slope: 0.75,
        leaf: b.leafColor(r, 0.05, -0.02),
        p: { forks: r.int(2, 4), spread: r.range(0.55, 0.85), crownW: r.range(1.0, 1.4), leafSize: r.range(1.0, 1.4) },
        yields: WOOD_YIELDS(2, [{ item: 'resin', min: 1, max: 1, chance: 0.4 }]),
      })));
      break;
    case 'baobab':
      b.add(tag, weirdSwap(treeBase(b, r, 'baobab', r.range(10, 16), r.range(0.9, 1.5), {
        mats: ARID | FERTILE, scale: [0.8, 1.2],
        bark: hsl(r.range(0.05, 0.1), r.range(0.12, 0.25), r.range(0.38, 0.5)),
        p: { bulge: r.range(1.1, 1.6), limbs: r.int(5, 9), leafSize: r.range(0.9, 1.3) },
        yields: WOOD_YIELDS(5, [{ item: 'fiber', min: 1, max: 3 }]),
      })));
      break;
    case 'mangrove':
      b.add(tag, weirdSwap(treeBase(b, r, 'mangrove', r.range(7, 11), r.range(0.2, 0.3), {
        water: WaterMode.Shore, mats: FERTILE_SAND, slope: 0.6,
        p: { roots: r.int(6, 11), rootH: r.range(1.4, 2.4), crownW: r.range(0.9, 1.2), crownH: 0.5, trunkFrac: 0.4, gnarl: 0.35, leafSize: 1.1, density: 1 },
      })));
      break;
    case 'willow':
      b.add(tag, weirdSwap(treeBase(b, r, 'willow', r.range(9, 14), r.range(0.35, 0.5), {
        water: WaterMode.Shore,
        leaf: b.leafColor(r, 0.04, 0.05),
        p: { strands: r.int(20, 34), droop: r.range(0.65, 0.9), crownW: r.range(0.9, 1.2), leafSize: r.range(0.8, 1.1) },
        yields: WOOD_YIELDS(2, [{ item: 'herb_healing', min: 1, max: 1, chance: 0.25 }]),
      })));
      break;
    case 'bamboo':
      b.add(tag, treeBase(b, r, 'bamboo', r.range(8, 14), r.range(0.06, 0.1), {
        scale: [0.75, 1.25], hp: 25,
        bark: hsl(b.fh + r.range(-0.08, 0.04), r.range(0.35, 0.55), r.range(0.35, 0.5)),
        p: { culms: r.int(6, 13), nodes: r.range(0.35, 0.6), spread: r.range(0.6, 1.3) },
        yields: [{ item: 'stick', min: 3, max: 6 }, { item: 'fiber', min: 1, max: 2 }],
        col: { shape: 'capsule', r: 0.5, h: 6, solid: true },
      }));
      break;
    case 'juniper':
      b.add(tag, weirdSwap(treeBase(b, r, 'juniper', r.range(3.5, 6.5), r.range(0.18, 0.28), {
        mats: ARID | FERTILE | ROCKY, slope: 0.55, hp: 55,
        leaf: hsl(b.fh + r.range(-0.05, 0.08), b.fs * 0.6, b.fl * 0.9),
        bark: hsl(r.range(0.05, 0.09), r.range(0.15, 0.3), r.range(0.35, 0.48)),
        p: { twist: r.range(0.4, 1.0), clumps: r.int(5, 9) },
        yields: [{ item: 'log', min: 1, max: 2 }, { item: 'stick', min: 2, max: 3 }, { item: 'berries', min: 1, max: 3, chance: 0.5 }],
      })));
      break;
    case 'deadwood':
      b.add(tag, treeBase(b, r, 'snag', r.range(7, 12), r.range(0.22, 0.34), {
        bark: hsl(r.range(0.05, 0.1), r.range(0.05, 0.15), r.range(0.3, 0.42)),
        hp: 50, p: { broken: r.range(0.3, 0.7), limbs: r.int(3, 6) },
        yields: [{ item: 'log', min: 1, max: 2, scaled: true }, { item: 'stick', min: 2, max: 4 }, { item: 'mushroom_edible', min: 1, max: 1, chance: 0.15 }],
      }));
      b.add(tag, {
        form: 'log', cls: 'debris', layer: Layer.Debris, size: r.range(5, 8), kind: 'log', scale: [0.7, 1.2], lods: 1, shadow: true,
        bark: hsl(r.range(0.05, 0.1), r.range(0.15, 0.3), r.range(0.2, 0.3)), slope: 0.75, mats: FERTILE_SAND | ROCKY,
        hp: 45, interact: 'Chop', material: 'wood', skill: 'woodcutting',
        yields: [{ item: 'log', min: 1, max: 2 }, { item: 'bark', min: 1, max: 1 }, { item: 'mushroom_edible', min: 1, max: 2, chance: 0.35 }],
        col: { shape: 'sphere', r: 0.45, h: 0.35, solid: false }, p: { r: r.range(0.25, 0.4), moss: r.range(0.2, 0.7) },
      });
      break;
    case 'charred':
      b.add(tag, treeBase(b, r, 'charred', r.range(6, 11), r.range(0.22, 0.32), {
        bark: hsl(r.range(0.0, 0.08), 0.1, r.range(0.05, 0.1)), bark2: hsl(r.range(0.02, 0.08), 0.9, 0.5),
        accent: hsl(r.range(0.02, 0.08), 0.95, 0.55), glow: r.range(0.4, 0.9), mats: VOLCANIC | FERTILE, cave: CaveMode.Any, hp: 40,
        p: { broken: r.range(0.2, 0.6), limbs: r.int(2, 5) },
        yields: [{ item: 'coal', min: 1, max: 3, scaled: true }, { item: 'stick', min: 1, max: 2 }],
      }));
      b.add(tag, {
        form: 'log', cls: 'debris', layer: Layer.Debris, size: r.range(3.5, 6), kind: 'log', lods: 1, shadow: true, cave: CaveMode.Any,
        bark: hsl(0.05, 0.1, 0.07), bark2: hsl(0.05, 0.95, 0.5), accent: hsl(0.05, 0.95, 0.55), glow: 0.6, mats: VOLCANIC | FERTILE, slope: 0.7,
        hp: 30, interact: 'Gather', material: 'wood', skill: 'foraging', harvest: true,
        yields: [{ item: 'coal', min: 1, max: 3 }],
        col: { shape: 'sphere', r: 0.4, h: 0.3, solid: false }, p: { r: 0.25, moss: 0, charred: 1 },
      });
      break;
    case 'giantmushroom': {
      const n = 2;
      for (let i = 0; i < n; i++) {
        const cap = hsl(b.p.fungalTint ? rgb2hsl(b.p.fungalTint)[0] + r.range(-0.15, 0.15) : r.float(), r.range(0.4, 0.8), r.range(0.35, 0.55));
        b.add(tag, {
          ...treeBase(b, r, 'giantshroom', r.range(7, 14), r.range(0.4, 0.7)),
          kind: 'mushroom', mats: FERTILE | ROCKY, cave: CaveMode.Any, hp: 60, interact: 'Chop', skill: 'foraging', material: 'plant',
          bark: hsl(r.range(0.05, 0.15), r.range(0.05, 0.25), r.range(0.65, 0.85)), leaf: cap, leaf2: hsl(rgb2hsl(cap)[0] + 0.05, 0.3, 0.75),
          accent: hsl(r.float(), 0.3, 0.92), glow: r.chance(0.35) ? r.range(0.2, 0.6) : 0,
          p: { trunkR: 0.55, capStyle: r.int(0, 4), capR: r.range(0.35, 0.6), spots: r.chance(0.6) ? 1 : 0, bend: r.range(0, 0.3), stems: r.int(1, 3) },
          yields: [{ item: 'mushroom_edible', min: 2, max: 5, scaled: true }, { item: 'fiber', min: 1, max: 2 }, { item: 'mushroom_glow', min: 1, max: 2, chance: 0.3 }],
          col: { shape: 'capsule', r: 0.6, h: 5, solid: true },
        });
      }
      break;
    }
    case 'glasstree':
      b.add(tag, {
        ...treeBase(b, r, 'glasstree', r.range(6, 11), r.range(0.2, 0.32)),
        kind: 'crystal', mats: CRYSTAL_GROUND | FERTILE, cave: CaveMode.Any, interact: 'Mine', skill: 'mining', material: 'crystal', hp: 140,
        bark: mixRgb(b.p.crystalTint, [0.9, 0.9, 0.95], 0.4), leaf: b.p.crystalTint, leaf2: hsl(rgb2hsl(b.p.crystalTint)[0] + r.range(-0.1, 0.1), 0.8, 0.7),
        accent: hsl(rgb2hsl(b.p.crystalTint)[0], 0.9, 0.75), glow: r.range(0.4, 0.9),
        p: { trunkR: 0.25, levels: r.int(2, 3), facets: r.int(4, 6), shardSize: r.range(0.4, 0.8) },
        yields: [{ item: 'crystal_shard', min: 2, max: 5, scaled: true }, { item: 'raw_gem', min: 1, max: 1, chance: 0.25 }],
      });
      break;
    case 'cactus':
      b.add(tag, {
        ...treeBase(b, r, 'saguaro', r.range(4, 8), r.range(0.22, 0.32)),
        kind: 'cactus', mats: ARID, slope: 0.75, interact: 'Chop', skill: 'foraging', material: 'plant', hp: 45, shadow: true, lods: 2,
        bark: hsl(b.fh + r.range(-0.05, 0.12), r.range(0.25, 0.45), r.range(0.28, 0.4)), accent: b.accentColor(r),
        p: { trunkR: 0.3, arms: r.int(0, 4), ribs: r.int(8, 14), flower: r.chance(0.5) ? 1 : 0 },
        yields: [{ item: 'cactus_flesh', min: 2, max: 4, scaled: true }, { item: 'fiber', min: 0, max: 1 }],
        col: { shape: 'capsule', r: 0.34, h: 4, solid: true },
      });
      b.add(tag, {
        form: 'barrel', cls: 'shrub', layer: Layer.Shrub, size: r.range(0.6, 1.1), kind: 'cactus', mats: ARID, slope: 0.7, lods: 1,
        bark: hsl(b.fh + r.range(-0.05, 0.12), r.range(0.3, 0.5), r.range(0.3, 0.42)), accent: b.accentColor(r),
        interact: 'Gather', harvest: true, regrow: 1800, skill: 'foraging',
        p: { pads: r.chance(0.5) ? 1 : 0, ribs: r.int(10, 18), flower: r.chance(0.6) ? 1 : 0 },
        yields: [{ item: 'cactus_flesh', min: 1, max: 2 }], col: { shape: 'sphere', r: 0.5, h: 0.4, solid: true },
      });
      break;
    // ------------------------------------------------------------------ shrubs
    case 'shrub':
      b.add(tag, {
        form: 'bush', cls: 'shrub', layer: Layer.Shrub, size: r.range(1.0, 1.8), kind: 'shrub', lods: 1, mats: FERTILE_SAND,
        leaf: b.leafColor(r, 0.06, -0.02), interact: 'Gather', harvest: true, regrow: 1200, skill: 'foraging',
        p: { clumps: r.int(5, 9), leafSize: r.range(0.5, 0.8) },
        yields: [{ item: 'stick', min: 1, max: 2 }, { item: 'fiber', min: 1, max: 2 }], col: { shape: 'sphere', r: 0.55, h: 0.5, solid: false },
      });
      b.add(tag, {
        form: 'berrybush', cls: 'shrub', layer: Layer.Shrub, size: r.range(0.9, 1.4), kind: 'shrub', lods: 1, mats: FERTILE,
        leaf: b.leafColor(r, 0.05, -0.04), accent: hsl(r.pick([0.0, 0.62, 0.75, 0.95, 0.12]) + r.range(-0.03, 0.03), 0.8, 0.45),
        interact: 'Gather', harvest: true, regrow: 1500, skill: 'foraging', cluster: 0.6,
        p: { clumps: r.int(4, 7), leafSize: r.range(0.45, 0.65), berries: r.int(14, 30) },
        yields: [{ item: 'berries', min: 2, max: 5 }, { item: 'seed', min: 1, max: 1, chance: 0.3 }], col: { shape: 'sphere', r: 0.5, h: 0.45, solid: false },
      });
      break;
    case 'deadshrub':
      b.add(tag, {
        form: 'deadbush', cls: 'shrub', layer: Layer.Shrub, size: r.range(0.7, 1.3), kind: 'shrub', lods: 1, mats: ARID | ROCKY | FERTILE,
        bark: hsl(r.range(0.06, 0.11), r.range(0.15, 0.35), r.range(0.4, 0.55)), interact: 'Gather', harvest: true, regrow: 1800, slope: 0.6,
        p: { twigs: r.int(14, 26), round: r.range(0.3, 1) },
        yields: [{ item: 'stick', min: 2, max: 3 }, { item: 'fiber', min: 0, max: 1 }], col: { shape: 'sphere', r: 0.45, h: 0.4, solid: false },
      });
      break;
    case 'fern':
      b.add(tag, {
        form: 'fern', cls: 'shrub', layer: Layer.Shrub, size: r.range(0.8, 1.6), kind: 'plant', lods: 0, mats: FERTILE, cave: CaveMode.Any,
        leaf: b.leafColor(r, 0.05, 0.0), interact: 'Gather', harvest: true, regrow: 900, slope: 0.55, cluster: 0.7,
        p: { fronds: r.int(7, 13), arch: r.range(0.3, 0.8), curl: r.range(0, 0.5) },
        yields: [{ item: 'fiber', min: 1, max: 2 }, { item: 'herb_healing', min: 1, max: 1, chance: 0.1 }], col: { shape: 'sphere', r: 0.45, h: 0.35, solid: false },
      });
      break;
    case 'giantleaf':
      b.add(tag, {
        form: 'giantleaf', cls: 'shrub', layer: Layer.Shrub, size: r.range(1.4, 2.4), kind: 'plant', lods: 1, mats: FERTILE, shadow: true,
        leaf: b.leafColor(r, 0.05, 0.03), interact: 'Gather', harvest: true, regrow: 1200, cluster: 0.6,
        p: { leaves: r.int(4, 8), heart: r.range(0, 1) },
        yields: [{ item: 'fiber', min: 2, max: 3 }], col: { shape: 'sphere', r: 0.7, h: 0.6, solid: false },
      });
      break;
    case 'reed':
      b.add(tag, {
        form: 'reed', cls: 'shrub', layer: Layer.Shrub, size: r.range(1.4, 2.4), kind: 'plant', lods: 0, mats: FERTILE_SAND, water: WaterMode.Shore,
        cave: CaveMode.Any, leaf: b.leafColor(r, 0.04, 0.02), bark: hsl(r.range(0.05, 0.09), 0.5, 0.25), interact: 'Gather', harvest: true, regrow: 900, cluster: 0.8,
        p: { stems: r.int(9, 16), heads: r.range(0.4, 0.9) },
        yields: [{ item: 'reed', min: 2, max: 4 }, { item: 'fiber', min: 0, max: 1 }], col: { shape: 'sphere', r: 0.45, h: 0.6, solid: false },
      });
      break;
    case 'crystalplant':
      b.add(tag, {
        form: 'crystal', cls: 'rock', layer: Layer.Shrub, size: r.range(1.2, 2.4), kind: 'crystal', lods: 1, shadow: true, mats: ANY, slope: 0.3,
        cave: CaveMode.Any, orient: Orient.Normal, leaf: b.p.crystalTint, leaf2: hsl(rgb2hsl(b.p.crystalTint)[0] + r.range(-0.12, 0.12), 0.8, 0.7),
        glow: r.range(0.5, 1), interact: 'Mine', skill: 'mining', material: 'crystal', hp: 70,
        p: { shards: r.int(5, 11), spread: r.range(0.3, 0.7), facets: r.int(4, 6) },
        yields: [{ item: 'crystal_shard', min: 2, max: 4, scaled: true }, { item: 'raw_gem', min: 1, max: 1, chance: 0.2 }],
        col: { shape: 'sphere', r: 0.55, h: 0.5, solid: true },
      });
      b.add(tag, {
        form: 'crystal', cls: 'plant', layer: Layer.Small, size: r.range(0.35, 0.6), kind: 'crystal', lods: 0, mats: ANY, slope: 0.2,
        cave: CaveMode.Any, orient: Orient.Normal, leaf: b.p.crystalTint, leaf2: hsl(rgb2hsl(b.p.crystalTint)[0] + r.range(-0.15, 0.15), 0.85, 0.72),
        glow: r.range(0.6, 1), interact: 'Pick', harvest: true, skill: 'mining', material: 'crystal', regrow: 3600,
        p: { shards: r.int(3, 7), spread: r.range(0.4, 0.8), facets: r.int(4, 6) },
        yields: [{ item: 'crystal_shard', min: 1, max: 2 }, { item: 'raw_gem', min: 1, max: 1, chance: 0.06 }],
        col: { shape: 'sphere', r: 0.35, h: 0.25, solid: false },
      });
      break;
    // ------------------------------------------------------------------ small plants
    case 'flower': {
      const n = r.int(3, 4);
      const styles = r.shuffle([0, 1, 2, 3, 4]);
      for (let i = 0; i < n; i++) {
        const rr = r.fork('flower', i);
        b.add(tag, {
          form: 'flower', cls: 'plant', layer: Layer.Small, size: rr.range(0.3, 0.75), kind: 'flower', lods: 0, mats: FERTILE, cluster: 0.85,
          leaf: b.leafColor(rr, 0.05, 0.02), accent: b.accentColor(rr), leaf2: b.accentColor(rr), interact: 'Pick', harvest: true, regrow: 900,
          skill: 'herbalism', p: { style: styles[i], petals: rr.int(4, 9), heads: rr.int(1, 5), petalLen: rr.range(0.6, 1.2) },
          yields: [{ item: 'flower', min: 1, max: 2 }, { item: 'seed', min: 1, max: 1, chance: 0.35 }], col: { shape: 'sphere', r: 0.3, h: 0.2, solid: false },
        });
      }
      break;
    }
    case 'mushroom': {
      const toxic = hsl(r.pick([0.0, 0.08, 0.6, 0.78, 0.9]) + r.range(-0.03, 0.03), 0.85, 0.48);
      b.add(tag, {
        form: 'mushroom', cls: 'plant', layer: Layer.Small, size: r.range(0.18, 0.32), kind: 'mushroom', lods: 0, mats: FERTILE, cave: CaveMode.Any,
        bark: hsl(0.1, 0.15, 0.82), leaf: hsl(r.range(0.05, 0.11), r.range(0.3, 0.55), r.range(0.3, 0.48)), cluster: 0.85, interact: 'Pick', harvest: true,
        regrow: 1200, skill: 'herbalism', p: { capStyle: r.int(0, 2), count: r.int(1, 5), spots: 0 },
        yields: [{ item: 'mushroom_edible', min: 1, max: 2 }], col: { shape: 'sphere', r: 0.25, h: 0.12, solid: false },
      });
      b.add(tag, {
        form: 'mushroom', cls: 'plant', layer: Layer.Small, size: r.range(0.2, 0.4), kind: 'mushroom', lods: 0, mats: FERTILE, cave: CaveMode.Any,
        bark: hsl(0.12, 0.1, 0.88), leaf: toxic, accent: hsl(0.1, 0.1, 0.95), cluster: 0.9, interact: 'Pick', harvest: true, regrow: 1200,
        skill: 'herbalism', p: { capStyle: r.int(0, 2), count: r.int(1, 3), spots: 1 },
        yields: [{ item: 'mushroom_toxic', min: 1, max: 2 }], col: { shape: 'sphere', r: 0.25, h: 0.12, solid: false },
      });
      break;
    }
    case 'spore':
      b.add(tag, {
        form: 'sporepod', cls: 'plant', layer: Layer.Small, size: r.range(0.35, 0.8), kind: 'mushroom', lods: 0, mats: FERTILE | ROCKY, cave: CaveMode.Any,
        leaf: hsl(rgb2hsl(b.p.fungalTint)[0] + r.range(-0.1, 0.1), 0.45, 0.55), accent: b.accentColor(r), glow: r.chance(0.5) ? r.range(0.2, 0.6) : 0,
        interact: 'Pick', harvest: true, regrow: 1500, skill: 'herbalism', cluster: 0.8, p: { pods: r.int(3, 7), stalk: r.range(0.2, 1) },
        yields: [{ item: 'mushroom_toxic', min: 1, max: 1 }, { item: 'seed', min: 1, max: 2 }], col: { shape: 'sphere', r: 0.3, h: 0.25, solid: false },
      });
      break;
    case 'glowshroom': {
      const gh = r.float();
      b.add(tag, {
        form: 'glowshroom', cls: 'plant', layer: Layer.Small, size: r.range(0.3, 0.7), kind: 'mushroom', lods: 0, mats: ANY, cave: CaveMode.Any, slope: 0.5,
        bark: hsl(gh, 0.2, 0.75), leaf: hsl(gh, 0.75, 0.55), accent: hsl(gh + r.range(-0.08, 0.08), 0.9, 0.62), glow: r.range(0.8, 1.4), cluster: 0.85,
        interact: 'Pick', harvest: true, regrow: 1500, skill: 'herbalism', p: { capStyle: r.int(0, 2), count: r.int(2, 6), spots: 0 },
        yields: [{ item: 'mushroom_glow', min: 1, max: 2 }, { item: 'glowsap', min: 1, max: 1, chance: 0.3 }], col: { shape: 'sphere', r: 0.3, h: 0.2, solid: false },
      });
      b.add(tag, {
        form: 'glowshelf', cls: 'cover', layer: Layer.Surface3D, size: r.range(0.5, 1.0), kind: 'mushroom', lods: 0, mats: ANY, cave: CaveMode.Any,
        orient: Orient.Normal, slope: -1, bark: hsl(gh, 0.2, 0.7), leaf: hsl(gh + 0.05, 0.7, 0.55), accent: hsl(gh, 0.9, 0.65), glow: r.range(0.7, 1.2),
        p: { shelves: r.int(2, 5) },
      });
      // Giant glowing mushrooms tower over underworld caverns.
      b.add(tag, {
        ...treeBase(b, r, 'giantshroom', r.range(8, 16), 0.5),
        kind: 'mushroom', mats: ANY, cave: CaveMode.Dark, hp: 60, interact: 'Chop', skill: 'foraging', material: 'plant', slope: 0.6,
        bark: hsl(gh, 0.15, 0.7), leaf: hsl(gh, 0.7, 0.45), leaf2: hsl(gh, 0.5, 0.7), accent: hsl(gh, 0.9, 0.65), glow: r.range(0.8, 1.3),
        p: { trunkR: 0.5, capStyle: r.int(0, 4), capR: r.range(0.3, 0.5), spots: 1, bend: r.range(0.05, 0.35), stems: r.int(1, 3) },
        yields: [{ item: 'mushroom_glow', min: 2, max: 4, scaled: true }, { item: 'glowsap', min: 1, max: 2 }],
        col: { shape: 'capsule', r: 0.55, h: 5, solid: true },
      });
      break;
    }
    case 'succulent':
      b.add(tag, {
        form: 'succulent', cls: 'plant', layer: Layer.Small, size: r.range(0.25, 0.6), kind: 'plant', lods: 0, mats: ARID | ROCKY | VOLCANIC, slope: 0.55,
        leaf: hsl(b.fh + r.range(-0.1, 0.2), r.range(0.2, 0.45), r.range(0.38, 0.55)), accent: b.accentColor(r), cluster: 0.7,
        interact: 'Pick', harvest: true, regrow: 1800, skill: 'herbalism', cave: CaveMode.Any,
        p: { leaves: r.int(8, 18), spike: r.range(0, 1), flower: r.chance(0.4) ? 1 : 0 },
        yields: [{ item: 'herb_healing', min: 1, max: 1, chance: 0.6 }, { item: 'fiber', min: 1, max: 1 }], col: { shape: 'sphere', r: 0.3, h: 0.15, solid: false },
      });
      break;
    case 'emberbloom':
      b.add(tag, {
        form: 'emberbloom', cls: 'plant', layer: Layer.Small, size: r.range(0.4, 0.8), kind: 'flower', lods: 0, mats: VOLCANIC | ANY, cave: CaveMode.Any, slope: 0.5,
        leaf: hsl(r.range(0.0, 0.05), 0.4, 0.12), accent: hsl(r.range(0.0, 0.11), 1, 0.55), glow: r.range(1.0, 1.6), cluster: 0.7,
        interact: 'Pick', harvest: true, regrow: 2400, skill: 'herbalism', p: { petals: r.int(5, 9), heads: r.int(1, 3) },
        yields: [{ item: 'flower', min: 1, max: 1 }, { item: 'glowsap', min: 1, max: 1, chance: 0.5 }, { item: 'herb_rare', min: 1, max: 1, chance: 0.12 }],
        col: { shape: 'sphere', r: 0.3, h: 0.3, solid: false },
      });
      break;
    case 'floatbloom':
      b.add(tag, {
        form: 'floatbloom', cls: 'plant', layer: Layer.Small, size: r.range(1.2, 2.6), kind: 'flower', lods: 0, mats: FERTILE, cluster: 0.7,
        leaf: b.leafColor(r, 0.06, 0.03), accent: hsl(r.float(), 0.6, 0.7), glow: r.range(0.15, 0.5), interact: 'Pick', harvest: true, regrow: 1800,
        skill: 'herbalism', p: { bulbs: r.int(1, 4) },
        yields: [{ item: 'flower', min: 1, max: 1 }, { item: 'seed', min: 1, max: 2 }, { item: 'herb_mana', min: 1, max: 1, chance: 0.3 }],
        col: { shape: 'sphere', r: 0.45, h: 1.2, solid: false },
      });
      break;
    case 'bones':
      b.add(tag, {
        form: 'bones', cls: 'debris', layer: Layer.Small, size: r.range(0.5, 0.9), kind: 'bones', lods: 0, mats: ANY, cave: CaveMode.Any, slope: 0.6,
        bark: hsl(r.range(0.08, 0.13), r.range(0.1, 0.25), r.range(0.72, 0.85)), interact: 'Gather', harvest: true, regrow: 3600, material: 'flesh',
        p: { style: 0 }, yields: [{ item: 'bone', min: 1, max: 2 }], col: { shape: 'sphere', r: 0.4, h: 0.15, solid: false },
      });
      b.add(tag, {
        form: 'bones', cls: 'debris', layer: Layer.Debris, size: r.range(3.5, 7), kind: 'bones', lods: 1, mats: ANY, cave: CaveMode.Any, slope: 0.7, shadow: true,
        bark: hsl(r.range(0.08, 0.13), r.range(0.1, 0.2), r.range(0.7, 0.82)), interact: 'Gather', material: 'flesh', hp: 40,
        p: { style: 1, ribs: r.int(6, 11) }, yields: [{ item: 'bone', min: 3, max: 6 }], col: { shape: 'sphere', r: 0.35, h: 0.3, solid: false },
      });
      break;
    case 'lichen':
      b.add(tag, {
        form: 'lichen', cls: 'cover', layer: Layer.Small, size: r.range(0.5, 1.1), kind: 'plant', lods: 0, mats: ANY, slope: 0.35, orient: Orient.Normal,
        cave: CaveMode.Any, leaf: hsl(r.pick([0.12, 0.2, 0.3, 0.05, 0.55]) + r.range(-0.03, 0.03), r.range(0.3, 0.6), r.range(0.45, 0.6)),
        leaf2: hsl(r.float(), 0.3, 0.6), cluster: 0.6, p: { blobs: r.int(3, 6) },
      });
      b.add(tag, {
        form: 'lichen', cls: 'cover', layer: Layer.Surface3D, size: r.range(0.6, 1.2), kind: 'plant', lods: 0, mats: ANY, slope: -1, orient: Orient.Normal,
        cave: CaveMode.Any, leaf: hsl(r.pick([0.12, 0.2, 0.3, 0.05]) + r.range(-0.03, 0.03), r.range(0.3, 0.6), r.range(0.45, 0.6)),
        leaf2: hsl(r.float(), 0.3, 0.6), p: { blobs: r.int(3, 6) },
      });
      break;
    case 'cavemoss': {
      const mossHue = rgb2hsl(b.p.foliage)[0] + r.range(-0.1, 0.1);
      const glow = r.chance(0.6) ? r.range(0.25, 0.7) : 0;
      for (const layer of [Layer.Small, Layer.Surface3D]) {
        b.add(tag, {
          form: 'moss', cls: 'cover', layer, size: r.range(0.9, 1.6), kind: 'plant', lods: 0, mats: ANY, slope: layer === Layer.Small ? 0.4 : -1,
          orient: Orient.Normal, cave: CaveMode.Any, leaf: hsl(mossHue, r.range(0.35, 0.6), r.range(0.22, 0.35)),
          leaf2: hsl(mossHue + r.range(-0.2, 0.2), 0.7, 0.55), accent: hsl(r.float(), 0.8, 0.6), glow, cluster: 0.5, p: { blobs: r.int(4, 7) },
        });
      }
      break;
    }
    case 'vine':
      b.add(tag, {
        form: 'vine', cls: 'hang', layer: Layer.Surface3D, size: r.range(2.5, 6), kind: 'plant', lods: 0, mats: ANY, slope: -1, orient: Orient.Hang,
        cave: CaveMode.Any, leaf: b.leafColor(r, 0.05, -0.02), accent: b.accentColor(r), p: { strands: r.int(3, 7), flowers: r.chance(0.5) ? 1 : 0 },
      });
      break;
    case 'hangingroot':
      b.add(tag, {
        form: 'root', cls: 'hang', layer: Layer.Surface3D, size: r.range(4, 10), kind: 'plant', lods: 0, mats: ANY, slope: -1, orient: Orient.Hang,
        cave: CaveMode.Any, bark: hsl(r.range(0.05, 0.1), r.range(0.2, 0.4), r.range(0.22, 0.35)), accent: hsl(r.float(), 0.7, 0.6),
        glow: r.chance(0.5) ? r.range(0.3, 0.8) : 0, p: { strands: r.int(3, 7) },
      });
      break;
    case 'tallgrass':
      // Per-biome grass species are created separately (see defineGrass); tallgrass only flags taller tufts.
      break;
    case 'grass':
      break;
    case 'lilypad':
      b.add(tag, {
        form: 'lilypad', cls: 'water', layer: Layer.Small, size: r.range(0.6, 1.3), kind: 'flower', lods: 0, mats: ANY, water: WaterMode.Float, slope: 0,
        leaf: b.leafColor(r, 0.05, 0.0), accent: hsl(r.pick([0.95, 0.0, 0.12, 0.8, 0.15]), r.range(0.3, 0.8), r.range(0.7, 0.85)), cluster: 0.85,
        p: { pads: r.int(2, 6), flower: r.range(0.2, 0.7) },
      });
      break;
    case 'kelp':
      b.add(tag, {
        form: 'kelp', cls: 'water', layer: Layer.Shrub, size: r.range(4, 9), kind: 'plant', lods: 1, mats: ANY, water: WaterMode.Under, slope: 0.5, cave: CaveMode.Any,
        leaf: hsl(r.range(0.12, 0.22), r.range(0.5, 0.75), r.range(0.22, 0.32)), cluster: 0.85, p: { strands: r.int(3, 6) },
      });
      break;
    case 'coral': {
      for (let i = 0; i < 2; i++) {
        const rr = r.fork('coral', i);
        b.add(tag, {
          form: 'coral', cls: 'water', layer: Layer.Small, size: rr.range(0.6, 1.4), kind: 'plant', lods: 0, mats: ANY, water: WaterMode.Under, slope: 0.5,
          cave: CaveMode.Any, leaf: hsl(rr.float(), rr.range(0.6, 0.9), rr.range(0.5, 0.65)), accent: hsl(rr.float(), 0.7, 0.7), cluster: 0.75,
          glow: rr.chance(0.25) ? 0.3 : 0, p: { style: i, branches: rr.int(5, 12) },
        });
      }
      break;
    }
    case 'jungle-vines':
      break;
  }
}

/** Grass species per biome (color matched to the terrain grass/moss texture with the biome's hue shift). */
function defineGrass(b: CatalogBuilder, biome: Biome, tall: boolean): number {
  const r = b.rng.fork('grass', biome, tall ? 1 : 0);
  const def = BIOMES[biome];
  const topMat = def.top === Mat.Moss || def.top === Mat.Mycelium || def.top === Mat.ForestFloor || def.top === Mat.Snow ? def.top : Mat.Grass;
  const mc = materialColors(MATERIALS[topMat === Mat.Snow ? Mat.Grass : topMat], b.p);
  const shift = b.p.biomes[biome]?.hueShift ?? 0;
  const base = topMat === Mat.ForestFloor ? b.p.foliage : mc.color;
  const [h, s, l] = rgb2hsl(base as RGB);
  const dry = def.humid < -0.2 || def.temp < -0.5;
  const leaf = hsl(h + shift * 0.6 - (dry ? 0.05 : 0), s * (dry ? 0.7 : 1.05), l * (tall ? 1.1 : 1.0) + 0.02);
  const leaf2 = mixRgb(hsl(h + shift - (dry ? 0.09 : 0.02), s * 0.9, l + 0.16), b.p.foliageDry, dry ? 0.5 : 0.15);
  return b.add(tall ? 'tallgrass' : 'grass', {
    form: tall ? 'tallgrass' : 'grass', cls: 'grass', layer: Layer.Grass, size: tall ? r.range(0.8, 1.3) : r.range(0.35, 0.6), kind: 'plant', lods: 0,
    mats: FERTILE, slope: 0.62, leaf, leaf2, accent: mixRgb(leaf2, [0.9, 0.85, 0.6], 0.4), scale: [0.7, 1.3], cave: CaveMode.Sky,
    p: { blades: tall ? r.int(9, 14) : r.int(10, 16), bend: r.range(0.2, 0.5), heads: tall ? r.range(0.3, 0.8) : 0, biome },
  });
}

/** Generic rocks, debris and cave features that every world has (per-world shapes & palettes). */
function defineGeneric(b: CatalogBuilder) {
  const r = b.rng.fork('generic');
  const style = r.float(); // rounded ↔ angular
  const flat = r.range(0.5, 0.85);
  const rockYields = (n: number): Yield[] => [
    { item: 'stone', min: n, max: n + 2, scaled: true },
    { item: 'flint', min: 1, max: 1, chance: 0.3 },
  ];
  // Rock colliders are given as fractions of the reference size.
  const generic = (key: string, init: SpecInit) => {
    const i = b.add(key, init);
    const s = b.species[i];
    if (s.col && s.cls === 'rock' && s.form !== 'pebbles') s.col = { ...s.col, r: s.col.r * s.size, h: s.col.h * s.size };
    return i;
  };
  generic('boulder', {
    form: 'boulder', cls: 'rock', layer: Layer.Boulder, size: r.range(1.8, 3.2), kind: 'rock', variants: 3, scale: [0.6, 1.6], lods: 2, shadow: true,
    mats: ANY, slope: 0.25, orient: Orient.Half, cave: CaveMode.Any, hp: 150, interact: 'Mine', skill: 'mining', material: 'stone',
    p: { rough: lerp(0.15, 0.45, style), angular: style, flat }, yields: rockYields(3), col: { shape: 'sphere', r: 0.42, h: 0.22, solid: true },
  });
  generic('rock', {
    form: 'rock', cls: 'rock', layer: Layer.Shrub, size: r.range(0.7, 1.2), kind: 'rock', variants: 3, scale: [0.6, 1.5], lods: 1, shadow: true,
    mats: ANY, slope: 0.3, orient: Orient.Half, cave: CaveMode.Any, hp: 45, interact: 'Mine', skill: 'mining', material: 'stone',
    p: { rough: lerp(0.2, 0.5, style), angular: style, flat: flat * 0.9 }, yields: rockYields(1), col: { shape: 'sphere', r: 0.42, h: 0.2, solid: true },
  });
  generic('pebbles', {
    form: 'pebbles', cls: 'rock', layer: Layer.Small, size: r.range(0.5, 0.9), kind: 'rock', variants: 2, lods: 0, mats: ANY, slope: 0.4,
    orient: Orient.Normal, cave: CaveMode.Any, interact: 'Pick', harvest: true, regrow: 2400, skill: 'foraging', material: 'stone',
    p: { count: r.int(3, 7), angular: style }, yields: [{ item: 'stone', min: 1, max: 2 }, { item: 'flint', min: 1, max: 1, chance: 0.35 }],
    col: { shape: 'sphere', r: 0.35, h: 0.1, solid: false },
  });
  generic('slab', {
    form: 'slab', cls: 'rock', layer: Layer.Debris, size: r.range(2.5, 4.5), kind: 'rock', variants: 2, lods: 2, shadow: true, mats: ANY, slope: 0.35,
    orient: Orient.Half, cave: CaveMode.Any, hp: 90, interact: 'Mine', skill: 'mining', material: 'stone',
    p: { thick: r.range(0.12, 0.25), angular: 0.8 }, yields: rockYields(2), col: { shape: 'sphere', r: 0.4, h: 0.1, solid: true },
  });
  generic('orerock', {
    form: 'orerock', cls: 'rock', layer: Layer.Boulder, size: r.range(1.4, 2.2), kind: 'ore', variants: 2, lods: 2, shadow: true, mats: ANY, slope: 0.3,
    orient: Orient.Half, cave: CaveMode.Any, hp: 180, interact: 'Mine', skill: 'mining', material: 'stone', accent: [0.7, 0.45, 0.25],
    p: { rough: 0.35, angular: Math.min(1, style + 0.3), flat: 0.8 }, yields: rockYields(1), col: { shape: 'sphere', r: 0.42, h: 0.22, solid: true },
  });
  generic('stalagmite', {
    form: 'stalagmite', cls: 'rock', layer: Layer.Shrub, size: r.range(1.5, 4), kind: 'rock', variants: 3, scale: [0.5, 1.8], lods: 1, shadow: true,
    mats: ANY, slope: 0.5, cave: CaveMode.Dark, hp: 50, interact: 'Mine', skill: 'mining', material: 'stone',
    p: { thin: r.range(0.12, 0.22), drip: r.range(0, 1) }, yields: rockYields(1), col: { shape: 'capsule', r: 0.1, h: 0.6, solid: true },
  });
  generic('stalactite', {
    form: 'stalactite', cls: 'hang', layer: Layer.Surface3D, size: r.range(1.5, 4.5), kind: 'rock', variants: 2, lods: 0, mats: ANY, slope: -1,
    orient: Orient.Hang, cave: CaveMode.Dark, p: { thin: r.range(0.1, 0.2) },
  });
  generic('driftwood', {
    form: 'driftwood', cls: 'debris', layer: Layer.Debris, size: r.range(2.5, 4.5), kind: 'log', variants: 2, lods: 1, mats: matMask(Mat.Sand, Mat.Gravel),
    slope: 0.75, water: WaterMode.Shore, bark: hsl(r.range(0.07, 0.11), r.range(0.05, 0.15), r.range(0.55, 0.7)), interact: 'Gather', harvest: true,
    regrow: 3600, material: 'wood', p: { r: r.range(0.12, 0.2), moss: 0, bleached: 1 },
    yields: [{ item: 'stick', min: 2, max: 3 }, { item: 'log', min: 1, max: 1, chance: 0.4 }], col: { shape: 'sphere', r: 0.4, h: 0.15, solid: false },
  });
  generic('saltcrust', {
    form: 'saltcrust', cls: 'rock', layer: Layer.Shrub, size: r.range(0.8, 1.6), kind: 'rock', lods: 1, mats: matMask(Mat.Salt, Mat.Clay, Mat.Sand), slope: 0.6,
    orient: Orient.Half, hp: 20, interact: 'Mine', skill: 'mining', material: 'crystal', bark: [0.94, 0.93, 0.9], leaf: b.p.sandTint,
    p: { shards: r.int(6, 12) }, yields: [{ item: 'salt', min: 2, max: 4 }], col: { shape: 'sphere', r: 0.45, h: 0.25, solid: false },
  });
  // Herbs: every world has its five medicinal plants, each with a distinct look.
  const herbs: [string, string][] = [['herb_healing', 'healing'], ['herb_mana', 'mana'], ['herb_stamina', 'stamina'], ['herb_poison', 'poison'], ['herb_rare', 'rare']];
  for (const [item, k] of herbs) {
    const rr = r.fork('herb', k);
    const accent = k === 'mana' ? hsl(rr.range(0.55, 0.75), 0.8, 0.6) : k === 'healing' ? hsl(rr.range(0.95, 1.05), 0.75, 0.6)
      : k === 'stamina' ? hsl(rr.range(0.1, 0.16), 0.9, 0.55) : k === 'poison' ? hsl(rr.range(0.75, 0.85), 0.6, 0.35) : hsl(rr.float(), 0.95, 0.7);
    b.add('herb.' + k, {
      form: 'herb', cls: 'plant', layer: Layer.Small, size: rr.range(0.3, 0.55), kind: 'herb', lods: 0, mats: FERTILE, cluster: 0.8,
      leaf: k === 'poison' ? hsl(b.fh + rr.range(-0.1, 0.1), 0.4, 0.25) : b.leafColor(rr, 0.08, 0.04), accent,
      glow: k === 'rare' || k === 'mana' ? rr.range(0.2, 0.6) : 0, interact: 'Pick', harvest: true, regrow: k === 'rare' ? 3600 : 1500, skill: 'herbalism',
      p: { style: rr.int(0, 3), leaves: rr.int(5, 9), berries: k === 'stamina' || k === 'poison' ? 1 : 0 },
      yields: [{ item, min: 1, max: k === 'rare' ? 1 : 2 }, { item: 'seed', min: 1, max: 1, chance: 0.25 }], col: { shape: 'sphere', r: 0.28, h: 0.2, solid: false },
    });
  }
}

// ------------------------------------------------------------------ biome tables

function tableFor(b: CatalogBuilder, biome: Biome, grassSp: Map<Biome, number[]>): BiomeFlora {
  const def = BIOMES[biome];
  const layers: WeightedSpecies[][] = Array.from({ length: LAYER_COUNT }, () => []);
  const prob = new Array<number>(LAYER_COUNT).fill(0);
  const fd = b.p.floraDensity;
  const veg = def.vegetation;
  const add = (tag: string, w: number, layerFilter?: Layer) => {
    for (const sp of b.byTag.get(tag) ?? []) {
      const s = b.species[sp];
      if (layerFilter !== undefined && s.layer !== layerFilter) continue;
      layers[s.layer].push({ sp, w });
    }
  };
  for (const tag of def.flora) {
    switch (tag) {
      case 'jungle': add(tag, 1.6); break;
      case 'palm': add(tag, biome === Biome.Jungle ? 0.5 : 1); break;
      case 'deadwood': add(tag, 0.25); break;
      case 'vine': add(tag, 1); break;
      case 'mushroom': add(tag, 0.5); break;
      case 'flower': add(tag, 1.2); break;
      case 'shrub': add(tag, 1); break;
      case 'bones': add(tag, biome === Biome.BoneHollows ? 2 : 0.4); break;
      default: add(tag, 1);
    }
  }
  // Herbs grow in every fertile surface biome.
  if (def.flora.includes('grass') || def.flora.includes('fern') || def.flora.includes('flower')) {
    add('herb.healing', 0.35);
    add('herb.stamina', 0.3);
    add('herb.mana', def.weird > 0.3 ? 0.4 : 0.15);
    add('herb.poison', def.humid > 0.4 ? 0.35 : 0.12);
    add('herb.rare', 0.04 + def.weird * 0.12);
  }
  // Rocks everywhere; mineral-rich biomes get more ore boulders.
  const rocky = def.terrain.mountain * 0.3 + (biome === Biome.Badlands || biome === Biome.Tundra || biome === Biome.Glacier || biome === Biome.Volcanic ? 0.5 : 0) + (def.underworld ? 0.5 : 0);
  add('boulder', 1);
  add('orerock', 0.12 + rocky * 0.15);
  add('rock', 0.6 + rocky * 0.6);
  add('pebbles', 0.25 + rocky * 0.4);
  add('slab', 0.3 + rocky * 0.6);
  if (biome === Biome.SaltFlats) add('saltcrust', 2.5);
  if (biome === Biome.Ocean || def.flora.includes('palm') || def.flora.includes('mangrove') || def.top === Mat.Sand || def.humid > -0.3) add('driftwood', 0.8);
  if (def.underworld) {
    add('stalagmite', 1.2);
    add('stalactite', 1);
  }
  // Grass tufts.
  for (const sp of grassSp.get(biome) ?? []) layers[Layer.Grass].push({ sp, w: b.species[sp].form === 'tallgrass' ? 0.8 : 1 });

  prob[Layer.Tree] = clamp(veg * 0.5 * fd, 0, 0.92);
  prob[Layer.Shrub] = clamp(0.06 + veg * 0.2 * fd + rocky * 0.04, 0, 0.7);
  prob[Layer.Small] = clamp(0.05 + veg * 0.17 * fd, 0, 0.6);
  prob[Layer.Grass] = clamp(def.grass * 0.95, 0, 0.95);
  prob[Layer.Boulder] = clamp(0.1 + rocky * 0.3, 0, 0.6);
  prob[Layer.Debris] = clamp(0.12 + veg * 0.08, 0, 0.4);
  prob[Layer.Surface3D] = clamp(0.25 + veg * 0.25, 0, 0.75);
  if (biome === Biome.Ocean) prob[Layer.Shrub] = 0.4;
  if (biome === Biome.SaltFlats) prob[Layer.Shrub] = 0.15;
  return { layers, prob };
}

/** Cave flora beneath a surface biome (between the surface and the underworld). */
function caveTableFor(b: CatalogBuilder, surface: Biome): BiomeFlora {
  const layers: WeightedSpecies[][] = Array.from({ length: LAYER_COUNT }, () => []);
  const prob = new Array<number>(LAYER_COUNT).fill(0);
  const add = (tag: string, w: number) => {
    for (const sp of b.byTag.get(tag) ?? []) layers[b.species[sp].layer].push({ sp, w });
  };
  const def = BIOMES[surface];
  add('stalagmite', 1.4);
  add('stalactite', 1.4);
  add('pebbles', 0.8);
  add('rock', 0.7);
  add('boulder', 0.6);
  add('orerock', 0.35);
  add('cavemoss', def.humid > 0 ? 1.2 : 0.4);
  if (def.humid > 0.2 || def.flora.includes('mushroom') || def.flora.includes('giantmushroom')) add('glowshroom', 0.7);
  if (def.flora.includes('crystalplant') || def.flora.includes('glasstree')) add('crystalplant', 1.5);
  if (def.flora.includes('vine') || def.flora.includes('jungle')) add('hangingroot', 0.6);
  if (surface === Biome.Volcanic) add('emberbloom', 0.8);
  add('bones', 0.15);
  // Cave floors never get surface trees/grass: only the dark-tolerant giant shrooms.
  layers[Layer.Tree] = layers[Layer.Tree].filter((e) => b.species[e.sp].cave !== CaveMode.Sky);
  layers[Layer.Grass] = [];
  prob[Layer.Tree] = 0.12;
  prob[Layer.Shrub] = 0.32;
  prob[Layer.Small] = 0.22;
  prob[Layer.Boulder] = 0.15;
  prob[Layer.Debris] = 0.05;
  prob[Layer.Surface3D] = 0.45;
  return { layers, prob };
}

// ------------------------------------------------------------------ public

const cache = new Map<number, FloraCatalog>();

/** Deterministic per-world flora catalog (memoized per seed). */
export function getFloraCatalog(profile: WorldProfile): FloraCatalog {
  const hit = cache.get(profile.seed);
  if (hit) return hit;
  const rng = new Rng(deriveSeed(profile.floraSeed, 'catalog'));
  const b = new CatalogBuilder(profile, rng);
  // Tags used by present biomes (+ ocean & all underworld biomes, which exist in every world).
  const biomesUsed: Biome[] = [Biome.Ocean, ...UNDERWORLD_BIOMES];
  for (const s of SURFACE_BIOMES) if ((profile.biomes[s]?.weight ?? 0) > 0) biomesUsed.push(s);
  const tags = new Set<string>();
  for (const bi of biomesUsed) for (const t of BIOMES[bi].flora) tags.add(t);
  // Stalagmites & crystals & glow flora also live in ordinary caves under any biome.
  tags.add('cavemoss');
  tags.add('glowshroom');
  // Fixed iteration order (insertion order of the canonical tag list) keeps indices stable per seed.
  const ORDER = [
    'broadleaf', 'conifer', 'jungle', 'palm', 'acacia', 'baobab', 'mangrove', 'willow', 'bamboo', 'juniper', 'deadwood', 'charred',
    'giantmushroom', 'glasstree', 'cactus', 'shrub', 'deadshrub', 'fern', 'giantleaf', 'reed', 'crystalplant', 'flower', 'mushroom',
    'spore', 'glowshroom', 'succulent', 'emberbloom', 'floatbloom', 'bones', 'lichen', 'cavemoss', 'vine', 'hangingroot', 'lilypad',
    'kelp', 'coral', 'grass', 'tallgrass',
  ];
  for (const t of ORDER) if (tags.has(t) && !HIDDEN_TAGS.has(t)) defineTag(b, t);
  // Weird worlds grow an extra alien tree in their weirdest biomes.
  if (b.weird > 0.55) {
    const r = rng.fork('xeno');
    b.add('xeno', alienize(b, r, treeBase(b, r, 'oak', r.range(9, 16), r.range(0.3, 0.5))));
  }
  defineGeneric(b);
  // Grass per biome.
  const grassSp = new Map<Biome, number[]>();
  for (const bi of biomesUsed) {
    const d = BIOMES[bi];
    if (d.grass <= 0 || d.underworld) continue;
    const l: number[] = [defineGrass(b, bi, false)];
    if (d.flora.includes('tallgrass')) l.push(defineGrass(b, bi, true));
    grassSp.set(bi, l);
  }
  const biomes: BiomeFlora[] = [];
  const caves: BiomeFlora[] = [];
  for (let i = 0; i < BIOME_COUNT; i++) {
    biomes[i] = tableFor(b, i as Biome, grassSp);
    caves[i] = caveTableFor(b, i as Biome);
  }
  // Weird alien tree joins the weirdest surface biomes' tree layers.
  for (const sp of b.byTag.get('xeno') ?? []) {
    for (const bi of SURFACE_BIOMES) if (BIOMES[bi].weird > 0.4 && BIOMES[bi].vegetation > 0.3) biomes[bi].layers[Layer.Tree].push({ sp, w: 0.8 });
  }
  const cat: FloraCatalog = { seed: profile.seed, species: b.species, biomes, caves, byTag: b.byTag };
  cache.set(profile.seed, cat);
  return cat;
}

/** Encode/decode scatter kind strings: "f<idx>" or "f<idx>.v<variant>" or "f<idx>.m<mat>". */
export function kindOf(sp: number, variant: number, mat: number): string {
  let k = 'f' + sp;
  if (variant > 0) k += '.v' + variant;
  if (mat >= 0) k += '.m' + mat;
  return k;
}

export interface ParsedKind {
  sp: number;
  variant: number;
  mat: number;
}

export function parseKind(kind: string, out: ParsedKind = { sp: -1, variant: 0, mat: -1 }): ParsedKind {
  out.sp = -1;
  out.variant = 0;
  out.mat = -1;
  if (kind.charCodeAt(0) !== 102 /* f */) return out;
  const parts = kind.slice(1).split('.');
  out.sp = parseInt(parts[0], 10);
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i].charAt(0), v = parseInt(parts[i].slice(1), 10);
    if (c === 'v') out.variant = v;
    else if (c === 'm') out.mat = v;
  }
  return out;
}

/** Species that take their color from the ground material (rocks): the scatter encodes the material in the kind. */
export function usesGroundMaterial(sp: FloraSpecies): boolean {
  return sp.form === 'boulder' || sp.form === 'rock' || sp.form === 'pebbles' || sp.form === 'slab' || sp.form === 'orerock' || sp.form === 'stalagmite' || sp.form === 'stalactite';
}

/** Collapse a ground material to the rock material a stone of that place is made of. */
export function rockMaterialFor(mat: number): Mat {
  switch (mat) {
    case Mat.Grass: case Mat.Dirt: case Mat.Moss: case Mat.ForestFloor: case Mat.Mud: case Mat.Mycelium: case Mat.Path: case Mat.Gravel:
      return Mat.Stone;
    case Mat.Sand: case Mat.Clay: return Mat.Sandstone;
    case Mat.Snow: return Mat.Stone;
    case Mat.Ash: case Mat.Magma: return Mat.Basalt;
    case Mat.Cobble: return Mat.Stone;
    case Mat.OreIron: case Mat.OreGold: case Mat.OreGem: case Mat.Bedrock: return Mat.Stone;
    case Mat.Air: return Mat.Stone;
    default: return mat as Mat;
  }
}

/** Ore item of an ore boulder (deterministic from its id; deeper = richer). */
export function oreFor(id: number, y: number): string {
  const h = ((id >>> 7) % 1000) / 1000;
  const deep = y < -130 ? 0.25 : y < -30 ? 0.12 : 0;
  if (h < 0.03 + deep * 0.4) return 'gold_ore';
  if (h < 0.1 + deep * 0.7) return 'silver_ore';
  if (h < 0.35 + deep) return 'copper_ore';
  if (h < 0.55 + deep) return 'coal';
  return 'iron_ore';
}

/** Extra yields of a rock depending on the material it is made of. */
export function materialYields(mat: number): Yield[] {
  switch (mat) {
    case Mat.Basalt: return [{ item: 'obsidian', min: 1, max: 1, chance: 0.25 }, { item: 'coal', min: 1, max: 1, chance: 0.15 }];
    case Mat.Obsidian: return [{ item: 'obsidian', min: 1, max: 3 }];
    case Mat.Sandstone: return [{ item: 'sand', min: 1, max: 2 }, { item: 'clay', min: 1, max: 1, chance: 0.3 }];
    case Mat.Crystal: return [{ item: 'crystal_shard', min: 1, max: 3 }, { item: 'raw_gem', min: 1, max: 1, chance: 0.12 }];
    case Mat.Salt: return [{ item: 'salt', min: 1, max: 3 }];
    case Mat.Limestone: return [{ item: 'flint', min: 1, max: 1, chance: 0.3 }];
    case Mat.Marble: return [{ item: 'raw_gem', min: 1, max: 1, chance: 0.04 }];
    case Mat.Ice: return [];
    default: return [{ item: 'copper_ore', min: 1, max: 1, chance: 0.04 }, { item: 'iron_ore', min: 1, max: 1, chance: 0.05 }];
  }
}
