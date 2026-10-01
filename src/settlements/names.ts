/**
 * Culture-flavoured names for taverns, temples, halls and shops, plus
 * procedural heraldry. Pure and deterministic.
 */
import type { RaceId } from '../humanoid/types';
import type { BuildingRole, Heraldry } from './types';
import { Rng } from '../core/rng';

const ADJ: Partial<Record<RaceId, string[]>> & { human: string[] } = {
  human: ['Gilded', 'Prancing', 'Rusty', 'Sleeping', 'Crooked', 'Merry', 'Drowned', 'Golden', 'Laughing', 'Red', 'Wandering', 'Old', 'Silver', 'Blind'],
  elf: ['Silver', 'Moonlit', 'Whispering', 'Starlit', 'Evening', 'Dew-kissed', 'Verdant', 'Singing'],
  dwarf: ['Iron', 'Stout', 'Deep', 'Anvil-struck', 'Copper', 'Bearded', 'Granite', 'Thundering'],
  orc: ['Bloody', 'Broken', 'Howling', 'Black', 'Gutted', 'Screaming', 'Bone'],
  halfling: ['Hungry', 'Cozy', 'Green', 'Plump', 'Sleepy', 'Jolly', 'Buttered'],
  goblin: ['Rusty', 'Stinking', 'Wobbly', 'Grubby', 'Sneaky', 'Leaky', 'Lucky'],
  sylvan: ['Glowing', 'Mossy', 'Dreaming', 'Spore-soft', 'Dewy', 'Twilight'],
  drakeborn: ['Burning', 'Smouldering', 'Scaled', 'Ashen', 'Obsidian', 'Ember'],
  umbral: ['Veiled', 'Hollow', 'Violet', 'Silent', 'Shadowed', 'Waning'],
  giantkin: ['Mighty', 'Frozen', 'Towering', 'Ancient', 'Rumbling', 'Grey'],
};

const NOUN: Partial<Record<RaceId, string[]>> & { human: string[] } = {
  human: ['Boar', 'Pony', 'Stag', 'Crown', 'Kettle', 'Goose', 'Lantern', 'Hound', 'Wheel', 'Barrel', 'Raven', 'Plough', 'Anchor', 'Fiddler'],
  elf: ['Willow', 'Harp', 'Swan', 'Lantern', 'Bough', 'Fawn', 'Star'],
  dwarf: ['Hammer', 'Tankard', 'Beard', 'Pick', 'Forge', 'Keg', 'Mountain'],
  orc: ['Skull', 'Tusk', 'Axe', 'Boar', 'Fist', 'Maw', 'Wolf'],
  halfling: ['Pie', 'Kettle', 'Toad', 'Pumpkin', 'Hedgehog', 'Mushroom', 'Pipe'],
  goblin: ['Rat', 'Pot', 'Gear', 'Toad', 'Bucket', 'Bolt', 'Fungus'],
  sylvan: ['Spore', 'Lantern', 'Moth', 'Toadstool', 'Root', 'Firefly'],
  drakeborn: ['Wyrm', 'Brazier', 'Claw', 'Scale', 'Pyre', 'Horn'],
  umbral: ['Moon', 'Eye', 'Shard', 'Moth', 'Mirror', 'Veil'],
  giantkin: ['Mammoth', 'Horn', 'Boulder', 'Bear', 'Mead-Hall', 'Glacier'],
};

const DEITY: Partial<Record<RaceId, string[]>> & { human: string[] } = {
  human: ['the Dawn', 'the Seven Lamps', 'Saint Aldric', 'the Harvest Mother', 'the Silent Judge'],
  elf: ['the Evening Star', 'the Eternal Bough', 'Ithiel the Singer'],
  dwarf: ['the Forgefather', 'the Deep Stone', 'the Hearthkeeper'],
  orc: ['the Blood Moon', 'Grom the Unbroken', 'the Ancestors'],
  halfling: ['the Green Lady', 'the Bountiful Hearth'],
  goblin: ['the Big Rat', 'the Glimmer Below'],
  sylvan: ['the Mycelial Mother', 'the Dreaming Root'],
  drakeborn: ['the Ember Wyrm', 'the First Flame'],
  umbral: ['the Hidden Moon', 'the Whispering Void'],
  giantkin: ['the Frost Father', 'the World Pillar'],
};

function pick<T>(m: Partial<Record<RaceId, T[]>> & { human: T[] }, race: RaceId, rng: Rng): T {
  return rng.pick(m[race] ?? m.human);
}

/** Display name for a notable building, or undefined for anonymous ones. */
export function buildingTitle(role: BuildingRole, race: RaceId, town: string, rng: Rng): string | undefined {
  switch (role) {
    case 'tavern':
      return `The ${pick(ADJ, race, rng)} ${pick(NOUN, race, rng)}`;
    case 'temple':
      return `Temple of ${pick(DEITY, race, rng)}`;
    case 'shrine':
      return `Shrine of ${pick(DEITY, race, rng)}`;
    case 'hall':
      return race === 'orc' ? `Warchief's Hall of ${town}` : race === 'dwarf' ? `Thane's Hall of ${town}` : `${town} Hall`;
    case 'smithy':
      return `${pick(NOUN, race, rng)} Forge`;
    case 'library':
      return `${town} Archive`;
    case 'mage_tower':
      return `${pick(ADJ, race, rng)} Tower`;
    case 'barracks':
      return `${town} Watch`;
    case 'market':
      return `${town} Market Hall`;
    default:
      return undefined;
  }
}

const COLORS = [0xb02a2a, 0x2a4ab0, 0x2a8a3a, 0xd0a020, 0xf0f0e8, 0x1a1a1a, 0x6a2a8a, 0xd06a20, 0x2a8a8a, 0x8a5a2a];
const EMBLEMS_BY_RACE: Record<RaceId, Heraldry['emblem'][]> = {
  human: ['crown', 'tower', 'boar', 'cross', 'sun', 'star', 'wave'],
  elf: ['tree', 'leaf', 'star', 'moon'],
  dwarf: ['hammer', 'mountain', 'crown', 'tower'],
  orc: ['skull', 'boar', 'flame', 'eye'],
  halfling: ['sun', 'leaf', 'tree', 'wave'],
  goblin: ['skull', 'eye', 'moon', 'crystal'],
  sylvan: ['leaf', 'tree', 'moon', 'star'],
  drakeborn: ['flame', 'sun', 'skull', 'crown'],
  umbral: ['eye', 'moon', 'crystal', 'star'],
  giantkin: ['mountain', 'crown', 'hammer', 'star'],
};
const RACE_COLORS: Record<RaceId, number[]> = {
  human: [0xb02a2a, 0x2a4ab0, 0xd0a020, 0x2a8a3a, 0xf0f0e8],
  elf: [0x2a8a3a, 0xf0f0e8, 0x2a8a8a, 0xd0c060],
  dwarf: [0xb02a2a, 0x1a1a1a, 0xd0a020, 0x2a4ab0],
  orc: [0xb02a2a, 0x1a1a1a, 0x8a5a2a],
  halfling: [0x2a8a3a, 0xd0a020, 0xd06a20],
  goblin: [0x6a8a2a, 0x8a5a2a, 0x1a1a1a, 0xd0a020],
  sylvan: [0x2a8a8a, 0x6a2a8a, 0x2a8a3a],
  drakeborn: [0xd06a20, 0x1a1a1a, 0xb02a2a, 0xd0a020],
  umbral: [0x6a2a8a, 0x1a1a1a, 0xf0f0e8],
  giantkin: [0x2a4ab0, 0xf0f0e8, 0x8a5a2a],
};

export function makeHeraldry(race: RaceId, rng: Rng): Heraldry {
  const cols = RACE_COLORS[race];
  const field = rng.pick(cols);
  let field2 = rng.pick(COLORS);
  if (field2 === field) field2 = field === 0xf0f0e8 ? 0x1a1a1a : 0xf0f0e8;
  // Tincture rule of thumb: metal (gold/white) charge on colour, colour on metal.
  const metal = field === 0xd0a020 || field === 0xf0f0e8;
  const charge = metal ? rng.pick([0x1a1a1a, 0xb02a2a, 0x2a4ab0]) : rng.pick([0xd0a020, 0xf0f0e8]);
  return {
    field,
    field2,
    charge,
    division: rng.pick(['plain', 'plain', 'party', 'fess', 'quarterly', 'chevron', 'bend', 'pale', 'saltire'] as const),
    emblem: rng.pick(EMBLEMS_BY_RACE[race]),
  };
}
