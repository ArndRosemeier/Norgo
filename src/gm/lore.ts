/**
 * World lore generator. Pure & deterministic per seed: given a WorldProfile it
 * invents the world's mythology (creator & adversary, origin myth, eras, the
 * great powers of every race present, notable figures, legends tied to biomes,
 * the underworld, the floating isles, gravity anomalies, moons and rings) and
 * per-place lore for settlements and points of interest.
 *
 * Everything the game master narrates or turns into quests is grounded here, and
 * NPC/dialog code can query it too:
 *   getLore(profile)                 → WorldLore (cached per seed)
 *   siteLore(profile, site)          → founding, ruler, allegiance, troubles, inn
 *   poiLore(profile, poi)            → proper name, legend, quest hook, figure
 *   biomeLegend(profile, biome)      → legend for a biome (surface or underworld)
 *   rumorsAbout(profile, ...)        → rumor lines about nearby places
 *   searchLore(profile, text)        → best matching lore entries for a question
 *   personName(race, rng)            → culture-appropriate names
 *   powerOf(profile, race)           → the faction of a race (reputation key `power.id`)
 *
 * No server imports — safe on client and server.
 */
import { Rng, deriveSeed } from '../core/rng';
import { Biome, BIOMES, SURFACE_BIOMES, UNDERWORLD_BIOMES } from '../world/biomes';
import type { WorldProfile } from '../world/profile';
import type { PoiInfo, PoiKind, SiteInfo } from '../world/sites';
import { expand, list, cap, bearing } from './text';

// ------------------------------------------------------------------ types

export type RaceKey = 'human' | 'elf' | 'dwarf' | 'orc' | 'halfling' | 'goblin' | 'sylvan' | 'drakeborn' | 'umbral' | 'giantkin';

export interface Deity {
  name: string;
  title: string;
  /** What they embody, e.g. "the Weight that binds", "the Song". */
  aspect: string;
}

export interface Era {
  name: string;
  /** Length in years. */
  years: number;
  summary: string;
  /** How it ended (empty for the current era). */
  ending: string;
}

export interface Power {
  /** Reputation / faction key, e.g. "power.elf". */
  id: string;
  race: RaceKey;
  name: string;
  /** "Concord", "Holds"... used in short references. */
  short: string;
  /** Title of their rulers ("High Thane"). */
  rulerTitle: string;
  ruler: string;
  ideal: string;
  /** What they despise / fear. */
  fear: string;
  sigil: string;
  ally: string | null;
  rival: string | null;
  /** Temperament toward outsiders: drives dialog tone & reputation gains. */
  temperament: 'proud' | 'pious' | 'mercantile' | 'warlike' | 'secretive' | 'hospitable';
}

export type FigureRole = 'hero' | 'tyrant' | 'sage' | 'traitor' | 'wanderer' | 'witch' | 'builder' | 'saint';

export interface Figure {
  id: string;
  name: string;
  epithet: string;
  race: RaceKey;
  role: FigureRole;
  era: string;
  deed: string;
  fate: 'dead' | 'vanished' | 'sleeping' | 'alive' | 'cursed';
  /** POI kind where their legacy lingers (tomb → ruin, battlefield, tower...). */
  legacy: PoiKind;
  /** A named relic tied to them. */
  relic: string;
}

export interface Legend {
  id: string;
  title: string;
  text: string;
  /** Lowercase keywords for searching. */
  tags: string[];
}

export interface MoonLore {
  name: string;
  epithet: string;
  omen: string;
}

export interface WorldLore {
  seed: number;
  worldName: string;
  epithet: string;
  creator: Deity;
  adversary: Deity;
  /** Lesser gods worshipped at shrines. */
  pantheon: Deity[];
  /** Name of the world-shaping catastrophe ("the Sundering"). */
  cataclysm: string;
  origin: string;
  eras: Era[];
  /** Current year of the current era. */
  year: number;
  powers: Power[];
  figures: Figure[];
  sunName: string;
  moons: MoonLore[];
  legends: Legend[];
  /** Name the people give the underworld. */
  underworldName: string;
  /** Name for gravity anomalies. */
  anomalyName: string;
  /** Name for the floating isles. */
  skyName: string;
}

// ------------------------------------------------------------------ culture tables

interface Culture {
  adj: string;
  plural: string;
  first: [string[], string[]];
  /** Surname / epithet stems. */
  sur: string[];
  powerName: string[];
  rulerTitles: string[];
  ideals: string[];
  fears: string[];
  sigils: string[];
  temperament: Power['temperament'][];
  townRuler: Record<'hamlet' | 'village' | 'town' | 'city', string>;
  crafts: string[];
}

const C: Record<RaceKey, Culture> = {
  human: {
    adj: 'human', plural: 'humans',
    first: [['Al', 'Bran', 'Cor', 'Ed', 'Gar', 'Hal', 'Is', 'Jor', 'Mar', 'Ros', 'Wen', 'Ther', 'Ald', 'Ser', 'Mael'], ['ric', 'wyn', 'da', 'mund', 'en', 'a', 'ith', 'win', 'ora', 'an', 'is', 'elle']],
    sur: ['Ashdown', 'Blackwell', 'Coldbrook', 'Harrow', 'Marsh', 'Redmane', 'Stonebridge', 'Thorne', 'Vance', 'Wolfe', 'Greaves', 'Holloway'],
    powerName: ['the {Crown|Kingdom|Commonwealth} of {Aster|Valen|Haldor|Merrow|Corwyn}', 'the {Free|Chartered|Sworn} {Cities|Marches|Baronies}'],
    rulerTitles: ['Queen', 'King', 'Lord Protector', 'High Steward'],
    ideals: ['law and the written charter', 'ambition and the open road', 'the sanctity of the hearth', 'coin honestly earned'],
    fears: ['the old magic', 'plague', 'the things below', 'a broken oath'],
    sigils: ['a white stag on green', 'a golden key', 'three towers', 'a crowned wheel'],
    temperament: ['mercantile', 'proud', 'hospitable'],
    townRuler: { hamlet: 'Reeve', village: 'Headman', town: 'Lord-Mayor', city: 'Duke' },
    crafts: ['wool', 'ale', 'horses', 'iron tools', 'bread', 'cartography'],
  },
  elf: {
    adj: 'elven', plural: 'elves',
    first: [['Ae', 'Cel', 'Ela', 'Fae', 'Gal', 'Ith', 'Lae', 'Nim', 'Syl', 'Thal', 'Eru', 'Ny'], ['driel', 'rion', 'wen', 'nor', 'thas', 'lith', 'ariel', 'orn', 'ael', 'ianna']],
    sur: ['of the Long Dusk', 'Starweaver', 'Silverbough', 'Moonwhisper', 'Dawnstrider', 'Leafsong'],
    powerName: ['the {Silver|Starlit|Evening|Verdant} {Concord|Court|Circle}', 'the {Undying|Twilight} {Throne|Accord}'],
    rulerTitles: ['Star-Queen', 'Eldest', 'Lord of Leaves', 'Speaker of Stars'],
    ideals: ['memory that outlasts stone', 'harmony of root and star', 'beauty as a duty', 'patience'],
    fears: ['forgetting', 'fire in the old woods', 'the haste of mortals', 'iron that sings'],
    sigils: ['a silver leaf', 'seven stars in a ring', 'a white owl', 'a crescent bough'],
    temperament: ['proud', 'secretive'],
    townRuler: { hamlet: 'Warden', village: 'Elder', town: 'Lady of the Grove', city: 'Star-Regent' },
    crafts: ['bows', 'silverleaf wine', 'songs', 'moonsilk', 'healing herbs'],
  },
  dwarf: {
    adj: 'dwarven', plural: 'dwarves',
    first: [['Bal', 'Dor', 'Grim', 'Thra', 'Bof', 'Kil', 'Nor', 'Ulf', 'Hel', 'Brun', 'Dag'], ['in', 'grim', 'dur', 'a', 'rik', 'dis', 'gar', 'mund', 'hild', 'ra']],
    sur: ['Ironfist', 'Deepdelver', 'Stonebeard', 'Anvilborn', 'Coalbrow', 'Goldvein', 'Hammerhand'],
    powerName: ['the {Deep|Iron|Anvil|Granite} {Holds|Thanes|Brotherhood}', 'the {Seven|Nine} {Halls|Delves} of {Khaz|Dun|Bar}{gar|dum|rak}'],
    rulerTitles: ['High Thane', 'Forge-King', 'Stone Matriarch', 'Keeper of the Ledger'],
    ideals: ['the oath carved in stone', 'craft perfected over lifetimes', 'kinship and debt repaid', 'the ancestors\' grudges'],
    fears: ['the deep that answers back', 'a debt unpaid', 'open sky', 'losing the old runes'],
    sigils: ['an anvil under a star', 'crossed hammers', 'a mountain with a single eye', 'a golden beard-ring'],
    temperament: ['proud', 'mercantile'],
    townRuler: { hamlet: 'Foreman', village: 'Thane', town: 'Hold-Thane', city: 'High Thane' },
    crafts: ['steel', 'stout', 'gem-cutting', 'runework', 'mining picks'],
  },
  orc: {
    adj: 'orcish', plural: 'orcs',
    first: [['Gor', 'Ug', 'Mak', 'Zug', 'Grash', 'Ruk', 'Thog', 'Ur', 'Shag', 'Krag', 'Yaz'], ['ash', 'ka', 'nak', 'gul', 'rok', 'mash', 'dak', 'za', 'ul', 'gra']],
    sur: ['Skullsplitter', 'Bloodtusk', 'Ironhide', 'the Unbowed', 'Ashfang', 'Gutripper', 'Stormcaller'],
    powerName: ['the {Red|Broken|Ash|Bone|Iron} {Horde|Fang Clans|Warbands}', 'the {Blood|Thunder} {Moot|Banners}'],
    rulerTitles: ['Warchief', 'Great Khan', 'Bone-Mother', 'Speaker of Drums'],
    ideals: ['strength proven in the open', 'the clan above the self', 'honest fury', 'a worthy death'],
    fears: ['a coward\'s death', 'shame before the ancestors', 'chains', 'the silent places'],
    sigils: ['a red hand', 'a broken tusk', 'a black sun', 'three claw marks'],
    temperament: ['warlike', 'hospitable'],
    townRuler: { hamlet: 'Packleader', village: 'Chieftain', town: 'Warlord', city: 'Warchief' },
    crafts: ['war drums', 'boar-hide leather', 'heavy blades', 'fire-liquor'],
  },
  halfling: {
    adj: 'halfling', plural: 'halflings',
    first: [['Bil', 'Pip', 'Ros', 'Dod', 'Mil', 'Tob', 'Lil', 'Bram', 'Hob', 'Pear', 'Wil'], ['bo', 'pin', 'ie', 'wise', 'ly', 'by', 'do', 'ola', 'kin', 'iver']],
    sur: ['Underbough', 'Tealeaf', 'Puddlefoot', 'Goodbarrel', 'Honeypot', 'Brambleby', 'Thistledown'],
    powerName: ['the {Hearthshires|Twelve Burrows|Hill Moot|Green Shires}'],
    rulerTitles: ['Thain', 'Mayor of the Moot', 'Eldest Grandmother'],
    ideals: ['a full larder', 'good neighbours', 'a quiet life', 'the second breakfast'],
    fears: ['adventure', 'famine', 'strangers with swords', 'a cold hearth'],
    sigils: ['a round green door', 'a golden acorn', 'a smoking pipe', 'a pie with a star'],
    temperament: ['hospitable', 'mercantile'],
    townRuler: { hamlet: 'Hobmaster', village: 'Mayor', town: 'Thain\'s Deputy', city: 'Thain' },
    crafts: ['pipeweed', 'cheese', 'pies', 'brewing', 'gardening'],
  },
  goblin: {
    adj: 'goblin', plural: 'goblins',
    first: [['Snik', 'Griz', 'Nub', 'Rik', 'Zab', 'Skee', 'Mott', 'Fizz', 'Krik', 'Nax'], ['let', 'zik', 'nab', 'wick', 'tik', 'gob', 'ik', 'sy', 'gle']],
    sur: ['Quickfingers', 'Rustgut', 'the Clever', 'Mudwhistle', 'Sparkfuse', 'Ratcatcher'],
    powerName: ['the {Muck|Rat|Grinning|Copper} {Warrens|Syndicate|Kingship}'],
    rulerTitles: ['Boss', 'Big Chief', 'Grand Haggler', 'Queen of Nooks'],
    ideals: ['cleverness over strength', 'a bargain struck', 'surviving another day', 'shiny things'],
    fears: ['big folk with torches', 'drowning', 'being forgotten', 'honest work'],
    sigils: ['a grinning moon', 'a rat with a crown', 'a crooked key', 'a copper cog'],
    temperament: ['mercantile', 'secretive'],
    townRuler: { hamlet: 'Nook-Boss', village: 'Boss', town: 'Big Boss', city: 'Goblin King' },
    crafts: ['contraptions', 'mushroom brew', 'salvage', 'traps', 'fireworks'],
  },
  sylvan: {
    adj: 'sylvan', plural: 'sylvans',
    first: [['Moss', 'Fern', 'Wil', 'Bry', 'Ash', 'Rue', 'Ivy', 'Thistle', 'Lichen', 'Briar'], ['whisper', 'song', 'bloom', 'dew', 'shade', 'root', 'light', 'heart', 'mist']],
    sur: ['of the Deep Green', 'Sporeborn', 'Rainkeeper', 'Twiceblossomed', 'Rootsinger'],
    powerName: ['the {Green|Moss|Spore|Rain} {Choir|Circle|Dreaming}'],
    rulerTitles: ['Mother Tree', 'Eldest Bloom', 'Voice of the Choir'],
    ideals: ['the cycle of rot and bloom', 'listening before speaking', 'the forest as one body', 'gentle patience'],
    fears: ['the axe', 'drought', 'salt in the soil', 'the Hollow Blight'],
    sigils: ['an unfurling fern', 'a ring of mushrooms', 'a green spiral', 'a dew-drop eye'],
    temperament: ['secretive', 'hospitable', 'pious'],
    townRuler: { hamlet: 'Tender', village: 'Bloom-Elder', town: 'Choir-Speaker', city: 'Mother Tree' },
    crafts: ['living wood', 'spore-lanterns', 'herbal cures', 'dyes'],
  },
  drakeborn: {
    adj: 'drakeborn', plural: 'drakeborn',
    first: [['Vyr', 'Skal', 'Rhaz', 'Ix', 'Thyr', 'Kael', 'Zar', 'Sor', 'Vael', 'Ish'], ['akth', 'ithra', 'oran', 'ax', 'yss', 'esh', 'mir', 'ikar', 'eth']],
    sur: ['Emberscale', 'of the Ninth Clutch', 'Sunforged', 'Ashwing', 'Cinderborn', 'Flamecrest'],
    powerName: ['the {Ember|Scaled|Ashen|Sun} {Dominion|Aerie|Ascendancy}'],
    rulerTitles: ['Wyrm-Regent', 'Flame Sovereign', 'First of the Clutch'],
    ideals: ['the purity of fire', 'lineage and the egg-right', 'dominion earned', 'the debt to the old dragons'],
    fears: ['cold that does not end', 'the extinguishing', 'a broken bloodline', 'water from below'],
    sigils: ['a coiled red wyrm', 'a burning eye', 'a golden egg', 'wings over a sun'],
    temperament: ['proud', 'warlike'],
    townRuler: { hamlet: 'Brood-Warden', village: 'Clutch-Elder', town: 'Flamewarden', city: 'Wyrm-Regent' },
    crafts: ['glassfire', 'obsidian blades', 'firestones', 'scale armour'],
  },
  umbral: {
    adj: 'umbral', plural: 'umbrals',
    first: [['Nyx', 'Vel', 'Sha', 'Mor', 'Eth', 'Ul', 'Qeth', 'Ves', 'Ise', 'Zha'], ['ara', 'ith', 'ael', 'oss', 'une', 'iel', 'ash', 'eon', 'ira']],
    sur: ['of the Veil', 'Duskwalker', 'Shadowsworn', 'the Unseen', 'Nightglass', 'Hollowvoice'],
    powerName: ['the {Veiled|Hollow|Dusk|Ninefold} {Synod|Court|Covenant}'],
    rulerTitles: ['Veiled Matriarch', 'Hierophant of Dusk', 'First Shadow'],
    ideals: ['secrets kept are power kept', 'the balance of light and shade', 'contemplation', 'the old pacts'],
    fears: ['the unveiling', 'pure light', 'the forgetting dark', 'their own names spoken aloud'],
    sigils: ['a closed eye', 'a black moon', 'a veil pierced by a needle', 'nine silver rings'],
    temperament: ['secretive', 'pious'],
    townRuler: { hamlet: 'Veilkeeper', village: 'Duskmother', town: 'Hierarch', city: 'Veiled Matriarch' },
    crafts: ['shadowglass', 'ink', 'poisons', 'star charts', 'silence-silk'],
  },
  giantkin: {
    adj: 'giantkin', plural: 'giantkin',
    first: [['Jot', 'Hrim', 'Ymr', 'Brok', 'Stor', 'Fjal', 'Thrym', 'Ulf', 'Gerd', 'Skad'], ['nir', 'gard', 'ra', 'bjorn', 'mund', 'ulf', 'hild', 'vor', 'a']],
    sur: ['Frostborn', 'Stormshoulder', 'Mountainheart', 'Icevein', 'the Tall', 'Thunderstep'],
    powerName: ['the {Frost|Thunder|Mountain} {Jarldom|Moot|Thrones}'],
    rulerTitles: ['Jarl of Jarls', 'Storm-King', 'Ice-Mother'],
    ideals: ['the long memory of mountains', 'hospitality to the frozen traveller', 'strength that shelters', 'the old songs'],
    fears: ['the thaw', 'small folk\'s cunning', 'the dragons\' return', 'shrinking'],
    sigils: ['a white mountain', 'a hammer of ice', 'a horn crossed with a spear', 'a storm-cloud eye'],
    temperament: ['hospitable', 'proud', 'warlike'],
    townRuler: { hamlet: 'Hearth-Elder', village: 'Jarl', town: 'High Jarl', city: 'Storm-King' },
    crafts: ['furs', 'giant mead', 'ice-forged axes', 'stone carving'],
  },
};

/** Expand a proper-noun template, keeping a leading article lowercase ("the Silver Court"). */
function nameOf(t: string, rng: Rng, vars: Record<string, string> = {}): string {
  return expand(t, rng, vars).replace(/^The /, 'the ');
}

function culture(race: string): Culture {
  return C[(race in C ? race : 'human') as RaceKey];
}

/** Culture-appropriate personal name. */
export function personName(race: string, rng: Rng, withSurname = false): string {
  const c = culture(race);
  const n = rng.pick(c.first[0]) + rng.pick(c.first[1]);
  if (!withSurname) return n;
  const s = rng.pick(c.sur);
  return s.startsWith('of ') || s.startsWith('the ') ? `${n} ${s}` : `${n} ${s}`;
}

const BEAST_A = ['Grim', 'Ash', 'Hollow', 'Night', 'Iron', 'Red', 'Old', 'Bone', 'Storm', 'Gut', 'Skull', 'Mire', 'Frost', 'Ember'];
const BEAST_B = ['jaw', 'maw', 'claw', 'hide', 'fang', 'belly', 'tooth', 'eye', 'back', 'tusk', 'horn', 'scale'];
const BEAST_EPI = ['the Widowmaker', 'the Unfed', 'the Ancient', 'Who Waits', 'the Scarred', 'the Hungry', 'Eater of Lanterns', 'the Pale', 'the Patient'];

/** A memorable monster name ("Ashmaw the Unfed", "Grimjaw, Mother of Wolves"). `kinPlural` names its kind. */
export function monsterName(rng: Rng, kinPlural = ''): string {
  const n = rng.pick(BEAST_A) + rng.pick(BEAST_B);
  if (kinPlural && rng.chance(0.4)) return `${n}, ${rng.pick(['Mother', 'Father', 'Lord', 'Queen', 'King'])} of ${cap(kinPlural)}`;
  return `${n} ${rng.pick(BEAST_EPI)}`;
}

export function raceAdjective(race: string): string {
  return culture(race).adj;
}

export function racePlural(race: string): string {
  return culture(race).plural;
}

/** Ruler title of a settlement of this race and size. */
export function townRulerTitle(race: string, size: SiteInfo['size']): string {
  return culture(race).townRuler[size];
}

// ------------------------------------------------------------------ myth vocabulary

const DIVINE_A = ['Aum', 'Ve', 'Ori', 'Thal', 'Ysh', 'Kor', 'Ama', 'Sel', 'Nu', 'Eon', 'Ba', 'Ira', 'Xo', 'Ul'];
const DIVINE_B = ['ra', 'thas', 'el', 'mir', 'oth', 'ane', 'unis', 'aya', 'esh', 'or', 'iel', 'ax'];
const CREATOR_ACTS = [
  'sang the first note, and the note became stone',
  'dreamed a single long dream, and $world is what was dreamed',
  'forged the land on an anvil of stars and quenched it in the first sea',
  'wove the world from threads of light and shadow',
  'cracked the Egg of Night, and $world spilled out still warm',
  'carved $world from the bones of an older, nameless god',
  'breathed upon the void until it clouded into land and water',
];
const ADVERSARY_ACTS = [
  'envied the work and tore at it',
  'whispered to the first peoples that the gift was a cage',
  'stole the Weight that held all things in place',
  'swallowed a moon and choked upon it',
  'poured hunger into the deep places',
  'unravelled the threads at the world\'s edge',
];
const ASPECTS_CREATOR = ['the Song', 'the Forge', 'the Dream', 'the Loom', 'the First Light', 'the Root', 'the Weight that binds'];
const ASPECTS_ADVERSARY = ['the Hunger', 'the Unmaking', 'the Hollow', 'the Rust', 'the Long Silence', 'the Drowning Dark'];
const LESSER_ASPECTS = [
  'harvests and hearths', 'the hunt', 'the dead and their road', 'storms', 'smiths and makers', 'travellers and crossroads',
  'secrets', 'the sea', 'healing', 'war', 'luck and gamblers', 'the stars and their reading', 'mountains', 'dreams',
];
const CATACLYSMS = ['the Sundering', 'the Long Fall', 'the Unweaving', 'the Breaking of the Weight', 'the Ashen Winter', 'the Night of Falling Stars', 'the Great Drowning'];
const ERA_NAMES = [
  'Dawn', 'Song', 'Giants', 'Crowns', 'Ash', 'Silence', 'Iron', 'Embers', 'Lanterns', 'Wandering', 'Thorns', 'Glass', 'Tides', 'Bells', 'Ruin', 'Rebuilding',
];
const MOON_NAMES = ['Ilun', 'Sorrow', 'Varra', 'the Pale Sister', 'Ket', 'Ombra', 'Lantern', 'Ysa', 'the Watcher', 'Mourn', 'Hespa', 'Tallow'];
const MOON_EPITHETS = ['the Watcher', 'the Weeping One', 'the Hunter\'s Eye', 'the Silver Coin', 'the Wanderer', 'the Bleeding Moon', 'the Lantern of the Dead', 'the Fickle Sister'];
const MOON_OMENS = [
  'When it rises red, blood will be spilled before dawn.',
  'Sailors and miners alike say it pulls at more than the tides.',
  'Lovers swear oaths beneath it; liars avoid its light.',
  'Beasts grow restless when it is full.',
  'The dead are said to walk more easily under its gaze.',
  'Children born under it dream of falling upward.',
];

// ------------------------------------------------------------------ main generator

const cache = new Map<number, WorldLore>();

/** Lore for a world (cached per seed; cheap after the first call). */
export function getLore(profile: WorldProfile): WorldLore {
  let l = cache.get(profile.seed);
  if (!l) {
    l = generateLore(profile);
    cache.set(profile.seed, l);
    if (cache.size > 8) cache.delete(cache.keys().next().value as number);
  }
  return l;
}

function deityName(rng: Rng): string {
  return cap(rng.pick(DIVINE_A) + rng.pick(DIVINE_B));
}

function presentSurface(profile: WorldProfile): Biome[] {
  return SURFACE_BIOMES.filter((b) => (profile.biomes[b]?.weight ?? 0) > 0);
}

function generateLore(profile: WorldProfile): WorldLore {
  const rng = new Rng(deriveSeed(profile.seed, 'gm', 'lore'));
  const world = profile.name;
  const vars: Record<string, string> = { world };

  const creator: Deity = { name: deityName(rng.fork('creator')), title: rng.pick(['the Maker', 'the First', 'the Singer', 'the Smith of Stars', 'the Dreamer', 'Mother of All']), aspect: rng.pick(ASPECTS_CREATOR) };
  const adversary: Deity = { name: deityName(rng.fork('adv')), title: rng.pick(['the Devourer', 'the Unmaker', 'the Hollow King', 'the Whisperer', 'the Starved One']), aspect: rng.pick(ASPECTS_ADVERSARY) };
  const pantheon: Deity[] = [];
  const asp = rng.sample(LESSER_ASPECTS, 5);
  const usedNames = new Set([creator.name, adversary.name]);
  for (let i = 0; i < asp.length; i++) {
    let name = deityName(rng.fork('god', i));
    for (let k = 0; usedNames.has(name) && k < 20; k++) name = deityName(rng.fork('god', i, k));
    usedNames.add(name);
    pantheon.push({ name, title: rng.pick(['the Kind', 'the Grey', 'the Wanderer', 'of the Veil', 'the Laughing', 'the Patient', 'Twice-Born', 'the Lame']), aspect: asp[i] });
  }
  const cataclysm = rng.pick(CATACLYSMS);
  const skyPresent = (profile.biomes[Biome.FloatingIsles]?.weight ?? 0) > 0;
  const underworldName = rng.pick(['the Below', 'the Underdeep', 'the Hollow Earth', 'the Rootdark', 'the Low Kingdoms', 'the Undervault']);
  const anomalyName = rng.pick(['Weightwells', 'Lightsinks', 'Heavy Rings', 'god-scars', 'Fallgates', 'drift-wounds']);
  const skyName = rng.pick(['the Skyreach', 'the Drifting Lands', 'the Hanging Isles', 'the Unmoored', 'Heaven\'s Shoals']);
  const sunName = deityName(rng.fork('sun'));

  // Moons (named after the profile's actual moons).
  const moons: MoonLore[] = profile.moons.map((_, i) => {
    const r = rng.fork('moon', i);
    return { name: r.pick(MOON_NAMES), epithet: r.pick(MOON_EPITHETS), omen: r.pick(MOON_OMENS) };
  });
  // Ensure distinct moon names.
  for (let i = 1; i < moons.length; i++) while (moons.slice(0, i).some((m) => m.name === moons[i].name)) moons[i].name = rng.pick(MOON_NAMES) + (rng.chance(0.5) ? '' : ' Minor');

  // ---- origin myth: woven from the world's real features ----
  const parts: string[] = [];
  parts.push(expand(`In the beginning ${creator.name}, $title, ${rng.pick(CREATOR_ACTS)}.`, rng, { ...vars, title: creator.title }));
  parts.push(expand(`But ${adversary.name} ${rng.pick(ADVERSARY_ACTS)}, and so came ${cataclysm}.`, rng, vars));
  if (skyPresent) parts.push(`In that hour whole lands tore free of the earth and rose, and they drift still — ${skyName}, where the world forgot how to fall.`);
  if (profile.gravityAnomalyFrequency > 0.6) parts.push(`Where the god's grip slipped, the ${anomalyName} remain: places where a stone weighs as much as a feather, or a feather as much as a stone.`);
  parts.push(rng.pick([
    `${adversary.name} was cast down beneath the roots of the world, into ${underworldName}, and the glow of the deep caverns is said to be the light of its slow breathing.`,
    `${creator.name} sealed the wound with ${underworldName}, a world beneath the world, and set the first peoples above it as wardens.`,
    `The war ended in ${underworldName}, where both gods fell; one sleeps there still, and nobody agrees which.`,
  ]));
  if (profile.hasRings) parts.push(`The pale ring across the sky is what remains of ${rng.pick(['a shattered moon', 'the Maker\'s crown', 'the chain that once bound the Adversary', 'a road the gods walked'])}.`);
  if (profile.moons.length === 0) parts.push('The night has no moon; the old songs say it was eaten, and that the hunger is not yet satisfied.');
  else if (moons.length) parts.push(`${list(moons.map((m) => m.name))} ${moons.length > 1 ? 'were set in the sky to watch' : 'was set in the sky to watch'} over what remained.`);
  const origin = parts.join(' ');

  // ---- powers ----
  const races = profile.races.map((r) => r.id as RaceKey).filter((r) => r in C);
  const powers: Power[] = races.map((race) => {
    const c = C[race];
    const r = rng.fork('power', race);
    const name = nameOf(r.pick(c.powerName), r);
    const words = name.replace(/^the /, '').split(' ');
    return {
      id: `power.${race}`, race, name, short: words[words.length - 1], rulerTitle: r.pick(c.rulerTitles), ruler: personName(race, r.fork('ruler'), true),
      ideal: r.pick(c.ideals), fear: r.pick(c.fears), sigil: r.pick(c.sigils), ally: null, rival: null, temperament: r.pick(c.temperament),
    };
  });
  // Alliances & rivalries: deterministic pairing.
  const order = rng.shuffle(powers.slice());
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    if (!p.rival && order.length > 1) {
      const cands = order.filter((o) => o !== p && !o.rival);
      const q = cands.length ? rng.pick(cands) : rng.pick(order.filter((o) => o !== p));
      p.rival = q.id;
      if (!q.rival) q.rival = p.id;
    }
  }
  for (const p of powers) {
    const cands = powers.filter((o) => o !== p && o.id !== p.rival && o.rival !== p.id);
    if (cands.length) p.ally = rng.pick(cands).id;
  }

  // ---- eras ----
  // The first age gets a "beginning" word; later ones anything else.
  const firstWord = rng.pick(['Dawn', 'Song', 'Giants', 'Glass', 'Tides', 'First Fires']);
  const eraWords = [firstWord, ...rng.sample(ERA_NAMES.filter((w) => w !== firstWord && w !== 'Dawn'), 4)];
  const eras: Era[] = [];
  const nEras = 4 + (rng.chance(0.5) ? 1 : 0);
  for (let i = 0; i < nEras; i++) {
    const name = `the Age of ${eraWords[i]}`;
    const years = rng.int(180, 1400);
    eras.push({ name, years, summary: '', ending: '' });
  }
  const year = rng.int(12, 420);

  // ---- figures ----
  const roles: FigureRole[] = ['hero', 'tyrant', 'sage', 'traitor', 'wanderer', 'witch', 'builder', 'saint'];
  const legacyFor: Record<FigureRole, PoiKind[]> = {
    hero: ['battlefield', 'ruin', 'monolith'], tyrant: ['ruin', 'tower', 'battlefield'], sage: ['tower', 'obelisk', 'monolith'],
    traitor: ['ruin', 'camp', 'well'], wanderer: ['wayshrine', 'well', 'crashsite'], witch: ['grove', 'tower', 'well'],
    builder: ['obelisk', 'ruin', 'wayshrine'], saint: ['shrine', 'wayshrine', 'grove'],
  };
  const epithets: Record<FigureRole, string[]> = {
    hero: ['the Unbroken', 'Dragonsbane', 'the Lantern-Bearer', 'Who Stood Alone', 'the Last Shield'],
    tyrant: ['the Iron Crown', 'the Pale Tyrant', 'Who Burned the Fields', 'the Usurper', 'the Hungry King'],
    sage: ['the Star-Reader', 'the Silent Scholar', 'Who Weighed the World', 'the Cartographer', 'the Blind Seer'],
    traitor: ['the Oathbreaker', 'Who Opened the Gate', 'the Smiling Knife', 'the Turncloak'],
    wanderer: ['the Footsore', 'Who Walked the Edge', 'the Pilgrim', 'Who Fell Upward', 'the Lost Navigator'],
    witch: ['of the Thorns', 'the Moon-Witch', 'Who Spoke with Rot', 'the Bone-Singer'],
    builder: ['the Mason', 'Who Raised the Stones', 'the Bridge-Maker', 'the Engineer'],
    saint: ['the Merciful', 'of the Open Hand', 'the Blessed', 'Who Healed the River'],
  };
  const relicA = ['Crown', 'Blade', 'Lantern', 'Astrolabe', 'Chalice', 'Horn', 'Key', 'Mirror', 'Seal', 'Bell', 'Spear', 'Codex', 'Ring'];
  const relicB = ['of Ash', 'of Seven Winters', 'of the Weight', 'of Tears', 'of Dawn', 'Unbroken', 'of Whispers', 'of the Deep', 'of Falling Stars', 'of Thorns'];
  const figures: Figure[] = [];
  const nFig = 9 + rng.int(0, 3);
  for (let i = 0; i < nFig; i++) {
    const r = rng.fork('figure', i);
    const race = races.length ? r.pick(races) : 'human';
    const role = i < roles.length ? roles[i] : r.pick(roles);
    const era = eras[Math.min(eras.length - 1, Math.floor(r.float() * eras.length))].name;
    const name = personName(race, r.fork('n'));
    const relic = `the ${r.pick(relicA)} ${r.pick(relicB)}`;
    const p = powers.find((x) => x.race === race);
    const foe = powers.find((x) => x.id === p?.rival);
    const deedT: Record<FigureRole, string[]> = {
      hero: [`held the pass against ${foe ? foe.name : 'the Devourer\'s spawn'} for nine days`, `slew the great wyrm that nested in ${underworldName}`, `carried ${relic} out of the fire of ${cataclysm}`],
      tyrant: [`bound ${p ? p.name : 'the free peoples'} in chains of law and fear`, `drained a lake to fill a treasury`, `bargained with ${adversary.name} for a crown that never rusts`],
      sage: [`measured the weight of the world and found it lighter than it should be`, `wrote the first map of ${underworldName}`, `read the end of the world in the ring of the sky`],
      traitor: [`opened the gates of the last free city to ${foe ? foe.name : 'the enemy'}`, `sold the secret of ${relic} for a single night of youth`, `poisoned the well of kings`],
      wanderer: [`walked from one edge of ${world} to the other and came back speaking no known tongue`, `climbed to ${skyName} without wings or rope`, `went down into ${underworldName} and returned a century later, unaged`],
      witch: [`taught the forest to remember faces`, `cursed a whole valley to sleep`, `bargained a moon\'s light for her lover\'s life`],
      builder: [`raised the standing stones that still hum at dusk`, `built the first road that never floods`, `chained a floating isle to the earth with iron links`],
      saint: [`healed a plague with nothing but water and patience`, `walked unharmed through ${cataclysm}`, `gave her eyes so a city could see again`],
    };
    const fate = r.pick(['dead', 'dead', 'vanished', 'sleeping', 'cursed', ...(role === 'wanderer' || role === 'witch' ? ['alive'] : [])] as Figure['fate'][]);
    figures.push({
      id: `fig${i}`, name, epithet: r.pick(epithets[role]), race, role, era, deed: r.pick(deedT[role]), fate, legacy: r.pick(legacyFor[role]), relic,
    });
  }

  // Era summaries reference figures & powers.
  for (let i = 0; i < eras.length; i++) {
    const e = eras[i];
    const r = rng.fork('era', i);
    const fs = figures.filter((f) => f.era === e.name);
    const pw = powers.length ? r.pick(powers) : null;
    if (i === 0) e.summary = `The first peoples woke in a young world. ${pw ? cap(racePlural(pw.race)) + ' were the first to name the stars.' : ''}`;
    else e.summary = cap(r.pick([
      `${pw ? pw.name : 'The great powers'} rose to greatness${fs[0] ? `, and ${fs[0].name} ${fs[0].epithet} ${fs[0].deed}` : ''}.`,
      `An age of roads and trade${fs[0] ? `, remembered for ${fs[0].name} ${fs[0].epithet}, who ${fs[0].deed}` : ''}.`,
      `War, mostly${fs[0] ? `; the songs keep the name of ${fs[0].name} ${fs[0].epithet}, who ${fs[0].deed}` : ''}.`,
    ]));
    if (i < eras.length - 1) e.ending = r.pick([`It ended with ${cataclysm}.`, 'It ended in plague and a hard winter.', 'It ended when the last king died without an heir.', 'It ended when the stars fell for a night and a day.', 'It ended in fire, as such ages do.']);
  }
  // Only one era carries the cataclysm.
  let seenCat = false;
  for (const e of eras) {
    if (e.ending.includes(cataclysm)) {
      if (seenCat) e.ending = 'It ended quietly, as the old powers faded.';
      seenCat = true;
    }
  }

  const lore: WorldLore = {
    seed: profile.seed, worldName: world,
    epithet: rng.pick(['the Unfinished World', 'the Twice-Made', 'the World Beneath the Ring', 'the Drifting Realm', 'the Hollow Crown', 'the Last Gift', 'the Patient Earth']),
    creator, adversary, pantheon, cataclysm, origin, eras, year, powers, figures, sunName, moons, legends: [], underworldName, anomalyName, skyName,
  };
  if (!profile.hasRings && lore.epithet === 'the World Beneath the Ring') lore.epithet = 'the World Below the Stars';
  lore.legends = buildLegends(profile, lore, rng.fork('legends'));
  return lore;
}

// ------------------------------------------------------------------ legends

const BIOME_LEGENDS: Partial<Record<Biome, string[]>> = {
  [Biome.Grassland]: ['They say the wind over the {meadows|grasslands} carries the voices of $figure\'s lost army, still marching home.', 'Shepherds leave a bowl of milk at the crossroads for $god, who walks the grass as a grey hare.'],
  [Biome.TemperateForest]: ['The oldest trees of the forest were saplings when $creator still walked the world, and they remember. {Speak softly beneath them.|Some say they whisper names.}', 'Somewhere in the old forest sleeps $figure, $epithet, beneath a hill that breathes.'],
  [Biome.Taiga]: ['In the endless pines a white elk leads lost travellers home — or deeper in, if they have lied that day.', 'Trappers swear the taiga has a heart, a clearing where snow never settles.'],
  [Biome.Jungle]: ['The jungle swallowed a whole kingdom in a single generation; its golden roofs still glint under the canopy.', 'The vines move when no one watches. The jungle-folk call it $god\'s patience.'],
  [Biome.Savanna]: ['The great lone trees of the savanna were planted by $figure, one for every battle won.', 'Herders say the lions here were once a royal guard, cursed to keep their oath forever.'],
  [Biome.Desert]: ['Beneath the dunes lies a city of glass, buried in a single night by $adversary\'s breath.', 'Walk the dunes at noon and you may meet your own shadow walking the other way. Do not follow it.'],
  [Biome.Badlands]: ['The red mesas are the scars of the war of $cataclysm; the stripes in the rock are the years of the burning.', 'Outlaws claim the canyons echo a little later each year, as if the land were growing.'],
  [Biome.Tundra]: ['On the tundra the dead are left to the wind, which carries their names to the stars.', 'The frost giants of old are said to sleep beneath the tundra, and the cold is their breathing.'],
  [Biome.Glacier]: ['Frozen in the glacier, deep and blue, stands something enormous with its arms raised. No one has reached it.', 'The ice remembers. Chip a sliver free, melt it, and you may hear a voice from $era.'],
  [Biome.Swamp]: ['The fen lights are lanterns carried by the drowned, still searching for the road.', 'A witch-queen once ruled the fen; her crown is still down there, somewhere beneath the reeds.'],
  [Biome.Volcanic]: ['The ashlands are where $adversary\'s blood touched the earth. The fire there has never gone out.', 'Smiths make pilgrimage to the ashlands to quench a blade in the living rock; few return with both hands.'],
  [Biome.CrystalWastes]: ['The crystal wastes grew from a single tear of $creator. The spires hum when danger is near.', 'Scholars say the crystals are thinking, very slowly, and that one day they will reach a conclusion.'],
  [Biome.FungalGrove]: ['The great mushrooms are one creature, the sylvans say — the oldest living thing in $world.', 'Breathe the spores too long and you will dream another life. Some never wake from it, and are happy.'],
  [Biome.FloatingIsles]: ['$sky tore loose during $cataclysm. The islands still remember their old places and drift back toward them, a hand-span every century.', 'Somewhere in $sky floats the palace of $figure, who climbed there and pulled the ladder up after.'],
  [Biome.KarstPillars]: ['The stone pillars are the petrified fingers of a giant who tried to climb out of $underworld.', 'Monks live atop the highest pillars and come down only when the world is ending. They came down once, in $era.'],
  [Biome.SaltFlats]: ['The salt flats were a sea, until $adversary drank it in a single draught.', 'On the salt the horizon lies. Travellers walk for days toward a city that is never there.'],
  [Biome.GlowCaverns]: ['The glowing caverns are lit by $adversary\'s slow breathing, the miners say — or by its dreams.', 'Lost miners are guided home by the glowshrooms, which dim along the wrong path.'],
  [Biome.Geodes]: ['The geode halls are the hollow eggs of stone dragons. Some of them have not hatched yet.', 'Dwarven legend holds that every gem here is a frozen word of the first song.'],
  [Biome.MagmaDepths]: ['In the magma depths the world\'s heart beats. $figure went to silence it, and the heat has never been the same.', 'Fire-spirits trade in memories down there; the price of a safe passage is your earliest one.'],
  [Biome.UnderSea]: ['The lightless sea has no bottom, sailors of the deep insist — only another sky, upside down.', 'Something vast moves beneath the black water. When it surfaces, the cavern ceilings weep.'],
  [Biome.BoneHollows]: ['The bone hollows are the graveyard of the great beasts that warred before the peoples woke.', 'Whatever killed the giants of the bone hollows is still down there. It simply has not been hungry since.'],
  [Biome.RootCathedral]: ['The root cathedral is where the world-tree drinks. Pray there and the tree may answer.', 'The roots grow toward whoever is lost; follow them up and you will find the sky.'],
};

function buildLegends(profile: WorldProfile, lore: WorldLore, rng: Rng): Legend[] {
  const out: Legend[] = [];
  const fig = (r: Rng) => r.pick(lore.figures);
  const baseVars = (r: Rng) => {
    const f = fig(r);
    return {
      world: lore.worldName, creator: lore.creator.name, adversary: lore.adversary.name, cataclysm: lore.cataclysm, figure: f.name, epithet: f.epithet,
      god: r.pick(lore.pantheon).name, era: r.pick(lore.eras).name, underworld: lore.underworldName, sky: lore.skyName,
    };
  };
  for (const b of [...presentSurface(profile), ...UNDERWORLD_BIOMES]) {
    const pool = BIOME_LEGENDS[b];
    if (!pool) continue;
    const r = rng.fork('biome', b);
    out.push({ id: `biome.${b}`, title: `Legend of the ${BIOMES[b].name}`, text: expand(r.pick(pool), r, baseVars(r)), tags: ['biome', ...BIOMES[b].name.toLowerCase().split(' ')] });
  }
  {
    const r = rng.fork('under');
    out.push({
      id: 'underworld', title: cap(lore.underworldName),
      text: expand(`Beneath every continent of $world lies ${lore.underworldName}, a world of caverns lit by glow and fire. {Shafts and cave-mouths lead down to it|The old shafts are its doors}; {few who go down for treasure come back for more|those who return speak of rivers of light and seas without stars}. ${lore.adversary.name} {is said to sleep there|was buried there, the priests say}.`, r, baseVars(r)),
      tags: ['underworld', 'below', 'deep', 'caves', 'cave', 'shaft', 'underground', lore.underworldName.toLowerCase().replace('the ', '')],
    });
  }
  if ((profile.biomes[Biome.FloatingIsles]?.weight ?? 0) > 0) {
    const r = rng.fork('sky');
    out.push({
      id: 'skyreach', title: cap(lore.skyName),
      text: expand(`Islands hang in the air above $world: ${lore.skyName}. There the ground forgets its weight, and a strong leap can carry you {higher than a house|over a river}. {The elves claim the isles were once their gardens|Birds nest there that have never touched the true ground}.`, r, baseVars(r)),
      tags: ['sky', 'skyreach', 'floating', 'isles', 'islands', 'float'],
    });
  }
  {
    const r = rng.fork('grav');
    out.push({
      id: 'gravity', title: `The ${cap(lore.anomalyName)}`,
      text: expand(`Across $world lie the ${lore.anomalyName} — places where the pull of the earth is wrong. In some, you {bound like a hare|drift like thistledown}; in others every step is {a burden|like wading through stone}. {Scholars blame $cataclysm|Priests call them the god's fingerprints}.`, r, baseVars(r)),
      tags: ['gravity', 'weight', 'heavy', 'light', 'anomaly', 'float', lore.anomalyName.toLowerCase()],
    });
  }
  if (profile.hasRings) out.push({ id: 'ring', title: 'The Ring in the Sky', text: `The pale ring that spans the heavens over ${lore.worldName} is older than any people. Every culture tells a different tale of it, and every tale ends badly.`, tags: ['ring', 'sky', 'heavens'] });
  for (const m of lore.moons) out.push({ id: `moon.${m.name}`, title: m.name, text: `${m.name}, ${m.epithet}. ${m.omen}`, tags: ['moon', 'moons', 'night', m.name.toLowerCase()] });
  if (profile.auroraStrength > 0) out.push({ id: 'aurora', title: 'The Veil-Lights', text: `On some nights curtains of light ripple across the sky of ${lore.worldName}. The old folk say it is ${lore.creator.name} mending the world, stitch by stitch.`, tags: ['aurora', 'lights', 'night', 'sky'] });
  out.push({ id: 'origin', title: 'How the World Began', text: lore.origin, tags: ['origin', 'beginning', 'creation', 'myth', 'world', 'gods', 'god', lore.creator.name.toLowerCase(), lore.adversary.name.toLowerCase()] });
  out.push({ id: 'cataclysm', title: cap(lore.cataclysm), text: `${cap(lore.cataclysm)} broke the old world. ${cap(lore.eras.find((e) => e.ending.includes(lore.cataclysm))?.name ?? 'an age')} ended with it, and nothing since has been quite whole.`, tags: ['cataclysm', 'history', ...lore.cataclysm.toLowerCase().split(' ')] });
  for (const f of lore.figures) {
    out.push({
      id: `figure.${f.id}`, title: `${f.name} ${f.epithet}`,
      text: `${f.name} ${f.epithet}, ${raceAdjective(f.race)} ${f.role} of ${f.era}, ${f.deed}. ${fateLine(f)}`,
      tags: ['figure', 'hero', f.role, f.name.toLowerCase(), ...f.epithet.toLowerCase().split(' '), ...f.relic.toLowerCase().split(' ')],
    });
  }
  for (const p of lore.powers) {
    const ally = lore.powers.find((x) => x.id === p.ally);
    const rival = lore.powers.find((x) => x.id === p.rival);
    out.push({
      id: p.id, title: cap(p.name),
      text: `${cap(p.name)} — the ${raceAdjective(p.race)} power — is ruled by ${p.rulerTitle} ${p.ruler}. Their banner bears ${p.sigil}; they prize ${p.ideal} and fear ${p.fear}.${ally ? ` They keep faith with ${ally.name}.` : ''}${rival ? ` They have never forgiven ${rival.name}.` : ''}`,
      tags: ['power', 'faction', 'politics', p.race, racePlural(p.race), ...p.name.toLowerCase().split(' ')],
    });
  }
  for (const g of [lore.creator, lore.adversary, ...lore.pantheon]) {
    out.push({ id: `god.${g.name}`, title: `${g.name} ${g.title}`, text: `${g.name} ${g.title}, god of ${g.aspect}.`, tags: ['god', 'gods', 'faith', 'religion', g.name.toLowerCase(), ...g.aspect.toLowerCase().split(' ')] });
  }
  return out;
}

export function fateLine(f: Figure): string {
  switch (f.fate) {
    case 'dead': return `${f.name} is long dead; ${f.relic} was buried with them, or so the songs claim.`;
    case 'vanished': return `One day ${f.name} simply vanished, and ${f.relic} with them.`;
    case 'sleeping': return `Some say ${f.name} only sleeps, and will wake when ${f.relic} is found.`;
    case 'cursed': return `${f.name} was cursed for it, and the curse lingers wherever ${f.relic} rests.`;
    case 'alive': return `Impossibly, ${f.name} is said to still walk the world.`;
  }
}

export function biomeLegend(profile: WorldProfile, biome: Biome): Legend | undefined {
  return getLore(profile).legends.find((l) => l.id === `biome.${biome}`);
}

export function powerOf(profile: WorldProfile, race: string): Power | undefined {
  return getLore(profile).powers.find((p) => p.race === race);
}

// ------------------------------------------------------------------ places

export interface SiteLore {
  name: string;
  power: Power | undefined;
  rulerTitle: string;
  ruler: string;
  founded: string;
  /** "famous for its cheese". */
  known: string;
  trouble: string;
  inn: string;
  /** One-line description for narration. */
  line: string;
}

const INN_A = ['Gilded', 'Drunken', 'Sleeping', 'Crooked', 'Laughing', 'Rusty', 'Silver', 'Wandering', 'Lame', 'Three-Legged', 'Blind', 'Last'];
const INN_B = ['Boar', 'Lantern', 'Griffin', 'Anvil', 'Moon', 'Goose', 'Wyrm', 'Kettle', 'Stag', 'Barrel', 'Pilgrim', 'Star'];

/** Deterministic lore for a settlement. */
export function siteLore(profile: WorldProfile, site: SiteInfo): SiteLore {
  const lore = getLore(profile);
  const r = new Rng(deriveSeed(site.seed, 'gm', 'sitelore'));
  const c = culture(site.race);
  const power = powerOf(profile, site.race);
  const era = r.pick(lore.eras);
  const founder = r.chance(0.3) ? r.pick(lore.figures) : null;
  const troubles = [
    'wolves — or worse — taking livestock at night', 'a feud between two old families', 'a sickness in the wells', 'bandits on the roads',
    `strange lights from the direction of ${lore.underworldName}`, 'a harvest that keeps failing', 'missing children', 'a tax collector nobody trusts',
    'tremors that crack the walls', 'a debt owed to ' + (lore.powers.find((p) => p.id === power?.rival)?.name ?? 'a foreign lord'), 'a haunted mill', 'a dragon sighting nobody believes',
  ];
  const sl: SiteLore = {
    name: site.name, power, rulerTitle: c.townRuler[site.size], ruler: personName(site.race, r.fork('ruler'), true),
    founded: founder ? `founded by ${founder.name} ${founder.epithet} in ${founder.era}` : `founded in ${era.name}`,
    known: r.pick(c.crafts), trouble: r.pick(troubles), inn: `the ${r.pick(INN_A)} ${r.pick(INN_B)}`, line: '',
  };
  sl.line = expand(`$name, {a|an old|a stubborn little|a proud} ${c.adj} ${site.size}${site.race2 ? ` shared with ${culture(site.race2).plural}` : ''}, $founded. {It is known for|Folk travel far for} its $known{, and its ${sl.rulerTitle.toLowerCase()}, $ruler, keeps the peace| and its inn, $inn}.`, r, {
    name: site.name, founded: sl.founded, known: sl.known, ruler: sl.ruler, inn: sl.inn,
  });
  return sl;
}

export interface PoiLore {
  /** Proper name, e.g. "the Ruins of Kel-Ashar". */
  name: string;
  /** Short legend sentence(s). */
  legend: string;
  /** Concrete hook a quest can use. */
  hook: string;
  figure: Figure | null;
  /** For camps: gang name; for lairs: the beast's name. */
  ownerName?: string;
  relic?: string;
  /** Pantheon deity tied to shrines. */
  deity?: Deity;
  /** Riddle for shrines/monoliths: [question, answer keywords]. */
  riddle?: [string, string[]];
}

const RIDDLES: [string, string[]][] = [
  ['I have roots that nobody sees, I am taller than trees, up, up I go, and yet I never grow.', ['mountain']],
  ['The more you take, the more you leave behind.', ['footsteps', 'steps', 'footprints']],
  ['I speak without a mouth and hear without ears. I have no body, but I come alive with the wind.', ['echo']],
  ['What falls but never breaks, and what breaks but never falls?', ['night', 'day', 'dawn']],
  ['I am weightless, yet you cannot hold me for long.', ['breath']],
  ['Feed me and I live, give me drink and I die.', ['fire', 'flame']],
  ['What has a heart that does not beat?', ['artichoke', 'stone', 'tree']],
  ['The one who makes it sells it; the one who buys it never uses it; the one who uses it never sees it.', ['coffin']],
  ['I am always hungry, I must always be fed; the finger I lick will soon turn red.', ['fire', 'flame']],
  ['Voiceless it cries, wingless flutters, toothless bites, mouthless mutters.', ['wind']],
];

/** Deterministic name, legend and quest hook for a point of interest. */
export function poiLore(profile: WorldProfile, poi: PoiInfo): PoiLore {
  const lore = getLore(profile);
  const r = new Rng(deriveSeed(poi.seed, 'gm', 'poilore'));
  const races = profile.races.map((x) => x.id);
  const race = races.length ? r.pick(races) : 'human';
  const place = cap(r.pick(culture(race).first[0]) + r.pick(culture(race).first[1]).toLowerCase());
  const figs = lore.figures.filter((f) => f.legacy === poi.kind);
  const figure = figs.length && r.chance(0.75) ? r.pick(figs) : r.chance(0.35) ? r.pick(lore.figures) : null;
  const power = lore.powers.length ? r.pick(lore.powers) : undefined;
  const era = r.pick(lore.eras).name;
  const relic = figure ? figure.relic : `the ${r.pick(['Amulet', 'Lantern', 'Signet', 'Censer', 'Idol', 'Tablet', 'Horn'])} of ${place}`;
  const deity = r.pick(lore.pantheon);
  const biome = BIOMES[poi.biome]?.name ?? 'wilds';
  const v = { place, era, relic, power: power?.name ?? 'a forgotten kingdom', god: deity.name, aspect: deity.aspect, figure: figure ? `${figure.name} ${figure.epithet}` : '', biome: biome.toLowerCase(), underworld: lore.underworldName, cataclysm: lore.cataclysm };
  const L = (t: string) => expand(t, r, v);
  const N = (t: string) => nameOf(t, r, v);
  switch (poi.kind) {
    case 'ruin':
      return {
        name: N(`the {Ruins|Broken Halls|Fallen Keep|Shattered Abbey} of $place`), figure, relic,
        legend: L(`{Once|Long ago} a stronghold of $power, abandoned {after $cataclysm|in $era}. ${figure ? `${figure.name} is said to have {ruled|died|hidden} here.` : '{Treasure-seekers still dig among the stones.|Nobody remembers why it fell.}'}`),
        hook: L(`$relic {lies|is said to lie} somewhere among the stones.`),
      };
    case 'shrine': {
      const riddle = r.pick(RIDDLES);
      return {
        name: N(`the Shrine of $god`), figure, deity, riddle,
        legend: L(`A shrine to $god, {keeper|patron} of $aspect. {Pilgrims leave|Travellers leave} {coins|ribbons|stones} here for luck.`),
        hook: L(`The priests say $god answers those who {solve the riddle carved above the altar|pray here at dusk with an offering}.`),
      };
    }
    case 'camp': {
      const gang = N(`the {Gallow|Red|Ashen|Grinning|Hollow|Black|Crooked} {Crows|Knives|Hounds|Lanterns|Brotherhood|Masks|Wolves}`);
      const leader = personName(race, r.fork('leader'), true);
      return {
        name: N(`the camp of ${gang}`), figure: null, ownerName: `${leader} of ${gang}`,
        legend: L(`${cap(gang)} {make camp here between raids|hold this ground and tax the road|hide here from the law}. Their leader is ${leader}.`),
        hook: L(`The nearby settlements {would pay well|have posted a reward} to see ${gang} scattered.`),
      };
    }
    case 'lair': {
      const beast = r.chance(0.5) ? monsterName(r.fork('beast')) : L(`{Old|Grey|Red|Black|Mother|Father} {Grimjaw|Hollowbelly|Ironhide|Nightmaw|Ashclaw|Gutripper|Skulltaker}`);
      return {
        name: N(`the lair of ${beast}`), figure: null, ownerName: beast,
        legend: L(`Locals {whisper|warn} that ${beast} dens here, {older than anyone remembers|grown fat on travellers}. {Bones litter the entrance.|The birds do not sing nearby.}`),
        hook: L(`{A bounty|A reward|A hunter's purse} awaits whoever brings down ${beast}.`),
      };
    }
    case 'grove':
      return {
        name: N(`the {Whispering|Silent|Moonlit|Weeping} Grove of $place`), figure, deity,
        legend: L(`An old grove where {the trees lean together as if listening|spirits of the $biome gather at dusk}. {Sylvan pilgrims tend it.|Druids once sang here.}`),
        hook: L(`{Sit beneath the eldest tree and listen;|Leave an offering at the heart of the grove;} the grove {may share a secret|remembers everything that ever happened in the $biome}.`),
      };
    case 'monolith': {
      const riddle = r.pick(RIDDLES);
      return {
        name: N(`the {Singing|Black|Weeping|Lonely} Stone of $place`), figure, riddle,
        legend: L(`A standing stone {older than any people|raised in $era}, carved with {star-writing|spirals no scholar can read}. {It hums at dusk.|Compasses spin near it.}`),
        hook: L(`The carvings pose a riddle; {they say the stone remembers who answers it|answer it and the stone shows the way to $underworld}.`),
      };
    }
    case 'tower': {
      const mage = figure && (figure.role === 'sage' || figure.role === 'witch' || figure.role === 'tyrant') ? `${figure.name} ${figure.epithet}` : personName(race, r.fork('mage'), true);
      return {
        name: N(`{the Tower of|the Spire of|the Watchtower of} ${mage.split(' ')[0]}`), figure, ownerName: mage,
        legend: L(`${mage} {studied the stars|bound spirits|measured the ${lore.anomalyName}} in this tower{ until $cataclysm| in $era}. {Lights are still seen in the top window.|The door opens only for the curious.}`),
        hook: L(`{Notes|A journal|An unfinished experiment} left by ${mage} {may still lie inside|could be worth a fortune to a scholar}.`),
      };
    }
    case 'battlefield': {
      const p2 = lore.powers.find((x) => x.id === power?.rival);
      return {
        name: N(`the Field of {Swords|Tears|Crows|Ash} at $place`), figure, relic,
        legend: L(`Here $power fought ${p2 ? p2.name : 'the Devourer\'s host'} in $era. {The grass still grows red in spring.|Rusted blades still surface after rain.}${figure ? ` ${figure.name} ${figure.epithet} {fell|stood} here.` : ''}`),
        hook: L(`The dead of $place {were never given rites|still walk on moonless nights}. {Someone should lay them to rest.|A priest would bless whoever brings them peace.}`),
      };
    }
    case 'crashsite':
      return {
        name: N(`the {Starfall|Skyscar|Fallen Star|Burning Furrow} of $place`), figure, relic,
        legend: L(`Something fell from the sky here {in living memory|in $era}{, and the ground has not cooled|; the crater glitters with strange metal}. {Some say it was a star.|Some say it was a ship from beyond the ring.|The scholars cannot agree.}`),
        hook: L(`{Sky-metal from the impact|What remains of the fallen thing} {would fetch a fortune from any smith|is said to hum with power}.`),
      };
    case 'well':
      return {
        name: N(`the {Wishing|Old|Bottomless|Moon} Well of $place`), figure, relic,
        legend: L(`An old well {that never runs dry|with water that tastes of iron and starlight}. {Drop a coin and make a wish — but wishes here have a way of coming true sideways.|Some say it reaches all the way to $underworld.}`),
        hook: L(`Legend says ${figure ? `${figure.name} threw $relic into it` : 'a king\'s ring was lost in it'}, and that the well gives back what it is owed.`),
      };
    case 'wayshrine':
      return {
        name: N(`the Wayshrine of $god`), figure, deity,
        legend: L(`A small roadside shrine to $god, {protector of travellers|keeper of $aspect}. {Pilgrims walking the old ways rest here.|It marks one stage of a pilgrimage long forgotten.}`),
        hook: L(`{Pilgrims who pray at three wayshrines in a row are said to walk under $god\'s protection.|The pilgrims\' road continues from here; walk it and be blessed.}`),
      };
    case 'obelisk':
      return {
        name: N(`the {Obelisk|Needle|Spire} of $place`), figure, riddle: r.pick(RIDDLES),
        legend: L(`A black obelisk {raised by no known people|older than $cataclysm}. {The air around it feels heavy.|Loose pebbles drift upward near its base.} {Some say it pins the world together.|Scholars believe it measures the ${lore.anomalyName}.}`),
        hook: L(`{Touch it at midnight|Speak the answer to its riddle}, they say, and it {will reveal a secret of the old world|shows a vision of ${lore.underworldName}}.`),
      };
  }
}

// ------------------------------------------------------------------ rumors & search

export interface RumorContext {
  x: number;
  z: number;
  /** Nearby POIs and sites (any order). */
  pois: PoiInfo[];
  sites: SiteInfo[];
  /** Ids the listener already knows (rumors prefer unknown places). */
  known?: Set<string>;
}

/**
 * Rumor lines about nearby places and world lore, for taverns, NPC barks and
 * the game master. Prefers places the listener has not discovered.
 */
export function rumorsAbout(profile: WorldProfile, ctx: RumorContext, rng: Rng, count = 3): string[] {
  const lore = getLore(profile);
  const out: string[] = [];
  const from = { x: ctx.x, z: ctx.z };
  const pois = ctx.pois.filter((p) => !ctx.known?.has(p.id)).sort((a, b) => Math.hypot(a.x - ctx.x, a.z - ctx.z) - Math.hypot(b.x - ctx.x, b.z - ctx.z));
  for (const p of pois.slice(0, 4)) {
    const pl = poiLore(profile, p);
    out.push(expand(`{They say|Folk whisper that|A traveller swore that|I heard that} {$name|$name}, $dir, {holds a secret|is worth a look|is no place to go alone}: $hook`, rng, { name: pl.name, dir: bearing(from, p), hook: pl.hook.charAt(0).toLowerCase() + pl.hook.slice(1) }));
  }
  for (const s of ctx.sites.filter((s) => !ctx.known?.has(s.id)).slice(0, 2)) {
    const sl = siteLore(profile, s);
    out.push(expand(`{Over in|Down in|Out at} $name, $dir, {they have trouble with|folk complain of} $trouble.`, rng, { name: s.name, dir: bearing(from, { x: s.x, z: s.z }), trouble: sl.trouble }));
  }
  const leg = rng.pick(lore.legends);
  out.push(expand(`{An old tale goes|Grandmothers tell it this way}: ${leg.text}`, rng));
  rng.shuffle(out);
  return out.slice(0, count);
}

/** Search lore entries by free text (used by "Ask the Game Master" and dialog). */
export function searchLore(profile: WorldProfile, text: string, max = 3): Legend[] {
  const lore = getLore(profile);
  const words = text.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) return [];
  const scored = lore.legends.map((l) => {
    let s = 0;
    const title = l.title.toLowerCase();
    for (const w of words) {
      if (l.tags.includes(w)) s += 3;
      else if (l.tags.some((t) => t.startsWith(w) || w.startsWith(t))) s += 1.5;
      if (title.includes(w)) s += 2;
      if (l.text.toLowerCase().includes(w)) s += 0.5;
    }
    return { l, s };
  });
  return scored.filter((x) => x.s >= 1.5).sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.l);
}

const STOP = new Set(['the', 'and', 'about', 'tell', 'what', 'who', 'where', 'why', 'how', 'are', 'is', 'was', 'were', 'this', 'that', 'there', 'here', 'you', 'your', 'me', 'my', 'of', 'for', 'with', 'know', 'does', 'did', 'can', 'could', 'would', 'should', 'please', 'any', 'some', 'more', 'world']);

/** Compact multi-line summary of the world (used as LLM context and in recaps). */
export function loreSummary(profile: WorldProfile): string {
  const l = getLore(profile);
  return [
    `World: ${l.worldName}, ${l.epithet}. Current year ${l.year} of ${l.eras[l.eras.length - 1].name}.`,
    `Gods: ${l.creator.name} ${l.creator.title} (${l.creator.aspect}); adversary ${l.adversary.name} ${l.adversary.title} (${l.adversary.aspect}); lesser: ${l.pantheon.map((g) => `${g.name} (${g.aspect})`).join(', ')}.`,
    `Origin: ${l.origin}`,
    `Eras: ${l.eras.map((e) => `${e.name} (${e.years} yrs) ${e.summary} ${e.ending}`).join(' | ')}`,
    `Powers: ${l.powers.map((p) => `${p.name} (${p.race}, ${p.rulerTitle} ${p.ruler}, prizes ${p.ideal}, rival ${p.rival ?? 'none'})`).join('; ')}.`,
    `Figures: ${l.figures.map((f) => `${f.name} ${f.epithet} (${f.role}, ${f.fate})`).join('; ')}.`,
    `Underworld: ${l.underworldName}. Floating isles: ${l.skyName}. Gravity anomalies: ${l.anomalyName}. Moons: ${l.moons.map((m) => m.name).join(', ') || 'none'}.`,
  ].join('\n');
}
