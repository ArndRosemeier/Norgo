/**
 * Culture styles: each race forges, weaves and names things differently.
 * A style biases material choice, dye palettes, ornament motifs (which the
 * client mesh builders read from `ItemVisual.style`), and the syllables used
 * for legendary item names.
 *
 * Shared (server + client).
 */
import type { RGB } from './materials';

export interface CultureStyle {
  id: string;
  /** Adjective for item names ("Dwarven Warhammer"). */
  adj: string;
  /** Preferred material ids (weighted ×2.5 when rolling). */
  favored: string[];
  /** Dye palette for cloth/leather (picked per item). */
  dyes: RGB[];
  /** Metal trim/accent colors. */
  trims: RGB[];
  /** Ornament motif used by meshes & heraldry: knotwork, leafvine, runic, spikes, geometric, scales, crescent, tusks, megalith, rough. */
  motif: string;
  /** Syllables for legendary names. */
  syl: [string[], string[], string[]];
  /** Epithet nouns ("Oathkeeper", "the Last Ember"). */
  epithets: string[];
  /** Typical blade curvature -1..1 (elves curve, dwarves broad & straight) and width multiplier for meshes. */
  curve: number;
  broad: number;
}

const rgb = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export const STYLES: Record<string, CultureStyle> = {
  human: {
    id: 'human', adj: 'Imperial', favored: ['iron', 'steel', 'oak', 'leather', 'wool', 'linen'],
    dyes: [0x7a2a22, 0x2c4a7a, 0x3d5a2e, 0x6b5a3a, 0x8a7a5a, 0x4a2a4a, 0x2a2a2a].map(rgb),
    trims: [0xb08d57, 0x9a9a9a, 0x6e4a2a].map(rgb), motif: 'knotwork',
    syl: [['Al', 'Ber', 'Cor', 'Ed', 'Gar', 'Hal', 'Os', 'Ri', 'Wil', 'Mar'], ['dric', 'win', 'ward', 'mund', 'helm', 'bert', 'ric', 'stan'], ['', '', 'a', 'e']],
    epithets: ['Oathkeeper', 'Kingsguard', 'Widowmaker', 'the Last Banner', 'Heartwarden', 'the Long Road', 'Dawnbreaker'],
    curve: 0, broad: 1,
  },
  elf: {
    id: 'elf', adj: 'Elven', favored: ['mithril', 'silver', 'yew', 'elderwood', 'silk', 'moonweave'],
    dyes: [0x2e6a5a, 0x4a6a8a, 0xc8c0a0, 0x5a3a6a, 0x7a8a4a, 0x1e3a4a].map(rgb),
    trims: [0xd8dce8, 0xc8a860, 0x8ab0a0].map(rgb), motif: 'leafvine',
    syl: [['Ae', 'Ith', 'Lae', 'Syl', 'Thal', 'Va', 'El', 'Ny', 'Cael', 'Mir'], ['an', 'ith', 'ae', 'oril', 'ien', 'enn', 'ath', 'ul'], ['dir', 'wen', 'thas', 'iel', 'ion', 'sar']],
    epithets: ['Starwhisper', 'the Quiet Song', 'Moonthorn', 'Leafsilver', 'the Patient Root', 'Dawnreed'],
    curve: 0.35, broad: 0.8,
  },
  dwarf: {
    id: 'dwarf', adj: 'Dwarven', favored: ['steel', 'darksteel', 'adamant', 'bronze', 'hardleather', 'wool'],
    dyes: [0x5a2a1a, 0x3a3a4a, 0x6a4a1a, 0x2a4a3a, 0x8a5a2a].map(rgb),
    trims: [0xc8963c, 0xb06a3a, 0x9a9a9a].map(rgb), motif: 'runic',
    syl: [['Bar', 'Dur', 'Grim', 'Thor', 'Kaz', 'Bal', 'Mor', 'Dain', 'Brun', 'Thra'], ['ak', 'in', 'grim', 'dok', 'gar', 'rak', 'bur', 'um'], ['', 'ar', 'dum', 'heim', 'ek']],
    epithets: ['Anvilsong', 'the Unbroken', 'Deepdelver', 'Stonegrudge', 'Hearthguard', 'the Last Vein'],
    curve: -0.1, broad: 1.3,
  },
  orc: {
    id: 'orc', adj: 'Orcish', favored: ['iron', 'bone', 'darksteel', 'rawhide', 'fur', 'stone'],
    dyes: [0x5a1a12, 0x2a2a1a, 0x4a3a1a, 0x1a1a1a, 0x6a5a3a].map(rgb),
    trims: [0x5a5048, 0x8a2a1a, 0xc8b89a].map(rgb), motif: 'spikes',
    syl: [['Gor', 'Ug', 'Kru', 'Mag', 'Snag', 'Rakh', 'Grak', 'Uz', 'Throk', 'Vrog'], ['ash', 'gul', 'nak', 'rok', 'zug', 'mog', 'kha'], ['', '', 'a', 'ul']],
    epithets: ['Skullsplitter', 'the Red Tusk', 'Bonegnaw', 'Warcry', 'the Hungry Iron', 'Gutripper'],
    curve: 0.15, broad: 1.4,
  },
  halfling: {
    id: 'halfling', adj: 'Hillfolk', favored: ['bronze', 'oak', 'leather', 'cotton', 'wool', 'linen'],
    dyes: [0x6a8a3a, 0xc89a3a, 0x8a4a2a, 0x3a6a5a, 0xd8c8a0, 0xa85a5a].map(rgb),
    trims: [0xc8a050, 0x8a6a3a].map(rgb), motif: 'geometric',
    syl: [['Bil', 'Pip', 'Mer', 'Tob', 'Rosie', 'Hob', 'Fen', 'Bram', 'Lob', 'Dod'], ['wick', 'bo', 'by', 'ry', 'kin', 'dle'], ['', 'ton', 'foot', 'brook']],
    epithets: ['Second Breakfast', 'the Lucky Thimble', 'Burrowguard', 'the Fat Badger', 'Hearthbright'],
    curve: 0.05, broad: 0.9,
  },
  goblin: {
    id: 'goblin', adj: 'Goblin', favored: ['copper', 'iron', 'bone', 'rawhide', 'flint', 'chitin'],
    dyes: [0x4a5a2a, 0x6a3a5a, 0x8a6a1a, 0x3a2a2a, 0x2a4a4a].map(rgb),
    trims: [0xa86a3a, 0x6a8a6a].map(rgb), motif: 'rough',
    syl: [['Snik', 'Grib', 'Nog', 'Zit', 'Krik', 'Biz', 'Wex', 'Skab'], ['lit', 'nak', 'gle', 'ik', 'zz', 'sniv'], ['', 'o', 'ik', 'ert']],
    epithets: ['Shinybiter', 'the Clever Stab', 'Nobody\'s Fault', 'Big Boss Poker', 'the Sneaky Bit'],
    curve: 0.25, broad: 0.85,
  },
  sylvan: {
    id: 'sylvan', adj: 'Sylvan', favored: ['ironwood', 'elderwood', 'ghostwood', 'chitin', 'leather', 'silk'],
    dyes: [0x3a6a2a, 0x6a8a3a, 0x8a5a3a, 0x2a4a2a, 0xa8b060].map(rgb),
    trims: [0x8ab060, 0xc8b070, 0x6a8a5a].map(rgb), motif: 'leafvine',
    syl: [['Oak', 'Fern', 'Ash', 'Bryo', 'Mos', 'Wil', 'Thorn', 'Root'], ['heart', 'song', 'bloom', 'whisper', 'hollow', 'shade'], ['', '', 'ling']],
    epithets: ['the Green Patience', 'Rootbinder', 'Springsong', 'Barkbrother', 'the Hollow Bloom'],
    curve: 0.3, broad: 0.9,
  },
  drakeborn: {
    id: 'drakeborn', adj: 'Drakeborn', favored: ['bronze', 'gold', 'dragonbone', 'wyrmhide', 'obsidian', 'silk'],
    dyes: [0x8a1a1a, 0xc87a1a, 0x1a1a1a, 0x6a2a0a, 0xa89040].map(rgb),
    trims: [0xd8a840, 0xa83a1a].map(rgb), motif: 'scales',
    syl: [['Vyr', 'Kael', 'Ish', 'Dra', 'Zar', 'Rhae', 'Sol', 'Tyr'], ['axx', 'ion', 'ath', 'ys', 'orr', 'esh'], ['', 'ax', 'ix', 'oth', 'ara']],
    epithets: ['Flamewake', 'the Ember Oath', 'Scaleborn', 'Ashfather', 'the Smouldering Claim'],
    curve: 0.2, broad: 1.1,
  },
  umbral: {
    id: 'umbral', adj: 'Umbral', favored: ['darksteel', 'silver', 'obsidian', 'shadowhide', 'voidcloth', 'spidersilk'],
    dyes: [0x1a1a2a, 0x3a1a4a, 0x2a2a3a, 0x4a3a5a, 0x101018].map(rgb),
    trims: [0xa0a8c8, 0x6a4aa0].map(rgb), motif: 'crescent',
    syl: [['Nyx', 'Vel', 'Shae', 'Mor', 'Ith', 'Zil', 'Ves', 'Ul'], ['ara', 'eth', 'ith', 'oss', 'ael', 'yr'], ['', 'is', 'ane', 'ith']],
    epithets: ['Nightsworn', 'the Quiet Knife', 'Duskmantle', 'the Pale Hunger', 'Starless'],
    curve: 0.4, broad: 0.85,
  },
  giantkin: {
    id: 'giantkin', adj: 'Giantkin', favored: ['stone', 'iron', 'bronze', 'fur', 'oak', 'wool'],
    dyes: [0x6a5a4a, 0x4a5a6a, 0x8a7a5a, 0x3a3a2a].map(rgb),
    trims: [0x8a8a7a, 0xa87a4a].map(rgb), motif: 'megalith',
    syl: [['Hro', 'Ymm', 'Thu', 'Gran', 'Skal', 'Bor', 'Jot'], ['mar', 'rok', 'dun', 'hild', 'rimm', 'gar'], ['', 'r', 'a', 'ung']],
    epithets: ['Mountainheart', 'the Slow Avalanche', 'Cairnbreaker', 'Skystone', 'the Patient Hill'],
    curve: 0, broad: 1.5,
  },
};

export function styleOf(id: string | undefined): CultureStyle {
  return (id && STYLES[id]) || STYLES.human;
}
