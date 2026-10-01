/**
 * Culture data for NPC generation: per-race naming conventions, the world's
 * pantheon, job titles, relation words, personality adjectives, ambitions and
 * templated biographies.
 *
 * Everything here is pure and deterministic — callers pass an `Rng` derived
 * from the world seed, so the same seed always names the same blacksmith the
 * same way. Names are built from per-race phonology (onset/ending syllable
 * pools with gender-leaning endings) mixed with hand-picked whole names, which
 * keeps each culture recognisable while giving thousands of combinations.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { RaceId } from '../humanoid/types';
import type { AgeStage, Deity, NpcJob, NpcTraits, RelationKind } from './types';

export interface PersonName {
  given: string;
  family: string | null;
  /** Full display name per culture convention. */
  full: string;
  epithet?: string;
}

// ------------------------------------------------------------------ helpers

function cap(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Pick from `masc` / `fem` pools by gender with a neutral overlap zone. */
function byGender<T>(rng: Rng, gender: number, fem: readonly T[], masc: readonly T[], neutral?: readonly T[]): T {
  if (neutral && neutral.length && rng.chance(0.12 + (0.5 - Math.abs(gender - 0.5)) * 0.6)) return rng.pick(neutral);
  return isMasc(gender, rng) ? rng.pick(masc) : rng.pick(fem);
}

/** Clear genders pick their pool deterministically; androgynous ones (0.35..0.65) toss a coin. */
function isMasc(gender: number, rng: Rng): boolean {
  if (gender >= 0.65) return true;
  if (gender <= 0.35) return false;
  return rng.float() < gender;
}

/** "a" / "an" by the following word. */
export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** Avoid ugly triple letters / doubled vowel clusters when joining syllables. */
function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const la = a.charAt(a.length - 1), fb = b.charAt(0).toLowerCase();
  if (la === fb && a.length > 1 && a.charAt(a.length - 2) === la) return a + b.slice(1);
  if ('aeiouy'.includes(la) && 'aeiouy'.includes(fb) && la === fb) return a + b.slice(1);
  return a + b;
}

const VOWELS = /[aeiouyë]/i;
const LINK_VOWELS = ['a', 'o', 'u', 'i'];

function syllName(rng: Rng, onsets: readonly string[], mids: readonly string[], ends: readonly string[], midChance: number): string {
  let n = rng.pick(onsets);
  const glue = (next: string) => {
    // A vowel-less cluster ("Gr", "Sk") followed by a consonant would be unpronounceable ("Grtar").
    if (!VOWELS.test(n.slice(-2)) && !VOWELS.test(next.charAt(0))) n += rng.pick(LINK_VOWELS);
    n = join(n, next);
  };
  if (rng.chance(midChance)) glue(rng.pick(mids));
  glue(rng.pick(ends));
  return cap(n);
}

// ------------------------------------------------------------------ race vocabulary

export const RACE_ADJ: Record<RaceId, string> = {
  human: 'human', elf: 'elven', dwarf: 'dwarven', orc: 'orcish', halfling: 'halfling', goblin: 'goblin',
  sylvan: 'sylvan', drakeborn: 'drakeborn', umbral: 'umbral', giantkin: 'giantkin',
};

export const RACE_NOUN: Record<RaceId, { one: string; many: string }> = {
  human: { one: 'human', many: 'humans' },
  elf: { one: 'elf', many: 'elves' },
  dwarf: { one: 'dwarf', many: 'dwarves' },
  orc: { one: 'orc', many: 'orcs' },
  halfling: { one: 'halfling', many: 'halflings' },
  goblin: { one: 'goblin', many: 'goblins' },
  sylvan: { one: 'sylvan', many: 'sylvans' },
  drakeborn: { one: 'drakeborn', many: 'drakeborn' },
  umbral: { one: 'umbral', many: 'umbrals' },
  giantkin: { one: 'giantkin', many: 'giantkin' },
};

export const RACE_LIFE: Record<RaceId, { adultAge: number; elderAge: number; maxAge: number }> = {
  human: { adultAge: 16, elderAge: 60, maxAge: 85 },
  elf: { adultAge: 40, elderAge: 300, maxAge: 450 },
  dwarf: { adultAge: 30, elderAge: 170, maxAge: 250 },
  orc: { adultAge: 13, elderAge: 45, maxAge: 65 },
  halfling: { adultAge: 20, elderAge: 90, maxAge: 130 },
  goblin: { adultAge: 9, elderAge: 35, maxAge: 50 },
  sylvan: { adultAge: 25, elderAge: 180, maxAge: 300 },
  drakeborn: { adultAge: 15, elderAge: 70, maxAge: 100 },
  umbral: { adultAge: 25, elderAge: 140, maxAge: 200 },
  giantkin: { adultAge: 22, elderAge: 120, maxAge: 180 },
};

export const JOB_NOUN: Record<NpcJob, string> = {
  farmer: 'farmer', smith: 'smith', merchant: 'merchant', innkeeper: 'innkeeper', guard: 'guard', priest: 'priest',
  hunter: 'hunter', scholar: 'scholar', mage: 'mage', miner: 'miner', woodcutter: 'woodcutter', fisher: 'fisher',
  healer: 'healer', bard: 'bard', child: 'child', elder: 'elder', noble: 'noble', beggar: 'beggar', thief: 'thief',
  bandit: 'bandit', adventurer: 'adventurer', pilgrim: 'pilgrim', herder: 'herder', cook: 'cook', tailor: 'tailor',
  alchemist: 'alchemist', carpenter: 'carpenter', mason: 'mason',
};

export const RELATION_WORD: Record<RelationKind, (gender: number) => string> = {
  spouse: (g) => (g > 0.66 ? 'husband' : g < 0.34 ? 'wife' : 'spouse'),
  parent: (g) => (g > 0.66 ? 'father' : g < 0.34 ? 'mother' : 'parent'),
  child: (g) => (g > 0.66 ? 'son' : g < 0.34 ? 'daughter' : 'child'),
  sibling: (g) => (g > 0.66 ? 'brother' : g < 0.34 ? 'sister' : 'sibling'),
  friend: () => 'friend',
  rival: () => 'rival',
  crush: () => 'sweetheart',
  mentor: () => 'mentor',
  apprentice: () => 'apprentice',
  creditor: () => 'creditor',
  debtor: () => 'debtor',
  enemy: () => 'enemy',
  colleague: () => 'colleague',
  neighbor: () => 'neighbour',
};

// ------------------------------------------------------------------ naming: human

const HUMAN_F = [
  'Alys', 'Bryony', 'Cecily', 'Edda', 'Elspeth', 'Gwen', 'Hilde', 'Isolde', 'Joan', 'Maude', 'Mira', 'Nell', 'Odile',
  'Rosamund', 'Sabine', 'Tamsin', 'Wenna', 'Agnes', 'Beatrix', 'Clara', 'Della', 'Ida', 'Lettice', 'Marta', 'Orla',
  'Petra', 'Rowena', 'Sigrid', 'Thea', 'Ulla', 'Vera', 'Yara', 'Brenna', 'Ada', 'Ilse', 'Merrin', 'Hester', 'Greta', 'Liesl', 'Avelina',
];
const HUMAN_M = [
  'Aldric', 'Bram', 'Cedric', 'Dunstan', 'Edric', 'Florian', 'Godwin', 'Hal', 'Ivo', 'Jory', 'Kester', 'Leofric', 'Merek',
  'Osric', 'Piers', 'Roderick', 'Tobin', 'Ulric', 'Wat', 'Anselm', 'Bertram', 'Conrad', 'Emmet', 'Fulk', 'Gareth', 'Hamon',
  'Jasper', 'Lambert', 'Matthias', 'Norbert', 'Oswin', 'Randal', 'Simon', 'Tybalt', 'Warin', 'Aric', 'Bennet', 'Dov', 'Gilles', 'Hugo',
];
const HUMAN_N = ['Ash', 'Robin', 'Wren', 'Rowan', 'Sky', 'Morgan', 'Avery', 'Quill'];
const HUMAN_SUR_A = ['Ash', 'Black', 'Bright', 'Cole', 'Fair', 'Green', 'Hart', 'Hay', 'Hill', 'Lang', 'Mill', 'Oak', 'Red', 'Thorn', 'Under', 'West', 'Wood', 'Stone', 'Brook', 'Marsh'];
const HUMAN_SUR_B = ['ford', 'wood', 'well', 'field', 'ley', 'by', 'combe', 'ridge', 'worth', 'hollow', 'more', 'wick', 'hurst', 'dale'];
const HUMAN_SUR_TRADE = [
  'Smith', 'Cooper', 'Fletcher', 'Thatcher', 'Mason', 'Baker', 'Tanner', 'Weaver', 'Fowler', 'Miller', 'Carter', 'Chandler',
  'Shepherd', 'Brewer', 'Wright', 'Turner', 'Fisher', 'Archer', 'Sawyer', 'Tyler', 'Hayward', 'Reeve', 'Dyer', 'Potter',
];

// ------------------------------------------------------------------ elf

const ELF_ON = ['Ae', 'Ca', 'Cae', 'E', 'Elo', 'Fae', 'Ga', 'I', 'Ithi', 'La', 'Lo', 'Mae', 'Ne', 'Ny', 'Sa', 'Se', 'Si', 'Tha', 'Thi', 'Va', 'Yl', 'Ere', 'Ara', 'Eli', 'Mi'];
const ELF_MID = ['la', 'li', 'ra', 'ren', 'lan', 'the', 'ri', 'na', 'van', 'dhi', 'sse', 'mo'];
const ELF_END_F = ['wen', 'iel', 'eth', 'ira', 'lia', 'riel', 'thiel', 'wyn', 'ara', 'elle', 'ine', 'sa'];
const ELF_END_M = ['ion', 'or', 'las', 'dir', 'thas', 'ril', 'andil', 'mar', 'iel', 'oth', 'ras', 'en'];
const ELF_HOUSE_A = ['Sar', 'Ael', 'Gal', 'Ith', 'Lor', 'Mel', 'Nar', 'Sil', 'Tal', 'Val', 'Ere', 'Fen', 'Cal', 'Ys'];
const ELF_HOUSE_B = ['enor', 'adrel', 'ithil', 'aran', 'oriel', 'vane', 'evar', 'nassë', 'athil', 'ondë', 'iriel', 'emar', 'ithar'];

// ------------------------------------------------------------------ dwarf

const DWARF_F = [
  'Brunhild', 'Dagna', 'Dis', 'Edda', 'Frida', 'Gunnloda', 'Helga', 'Hilda', 'Ingra', 'Kathra', 'Mardred', 'Nala', 'Orsik',
  'Riswynn', 'Sannl', 'Torbera', 'Vistra', 'Ylva', 'Amber', 'Bardryn', 'Eldeth', 'Falkrunn', 'Gurdis', 'Hlin', 'Kristryd',
  'Liftrasa', 'Audhild', 'Bera', 'Dagnal', 'Gerda', 'Ragna', 'Sigrun', 'Thora', 'Una', 'Vala', 'Brynja', 'Hedda', 'Jorunn', 'Ketta', 'Mora',
];
const DWARF_M = [
  'Adrik', 'Balin', 'Barendd', 'Borin', 'Brottor', 'Dain', 'Delg', 'Durin', 'Eberk', 'Fargrim', 'Gardain', 'Grimli', 'Harbek',
  'Kildrak', 'Morgran', 'Orsik', 'Oskar', 'Rangrim', 'Rurik', 'Taklinn', 'Thorin', 'Thrain', 'Tordek', 'Traubon', 'Ulfgar',
  'Veit', 'Vondal', 'Bofur', 'Dwalin', 'Gloin', 'Hrodgar', 'Kazrik', 'Murdok', 'Nali', 'Throk', 'Bruenor', 'Dolgrin', 'Garrik', 'Torgar', 'Brakk',
];
const DWARF_CLAN_A = ['Iron', 'Stone', 'Copper', 'Deep', 'Gold', 'Anvil', 'Coal', 'Granite', 'Hammer', 'Silver', 'Flint', 'Ember', 'Rune', 'Black', 'Bronze', 'Oath', 'Bright'];
const DWARF_CLAN_B = ['vein', 'beard', 'fist', 'delve', 'helm', 'shield', 'forge', 'brow', 'mantle', 'hammer', 'axe', 'heart', 'bellows', 'seam', 'hewer', 'shaft'];

// ------------------------------------------------------------------ orc

const ORC_ON = ['Gr', 'Kr', 'Th', 'Ug', 'Mo', 'Ru', 'Za', 'Dur', 'Gor', 'Mak', 'Sha', 'Ur', 'Bol', 'Nar', 'Ghor', 'Vrak', 'Az', 'Lug', 'Og', 'Yaz'];
const ORC_END_M = ['ash', 'ok', 'nak', 'gul', 'rak', 'tar', 'mog', 'uk', 'gash', 'thak', 'rag', 'grim', 'dush', 'zog'];
const ORC_END_F = ['ka', 'ra', 'sha', 'gra', 'zha', 'ura', 'enka', 'ola', 'arra', 'ruk', 'ika', 'mara'];
const ORC_CLAN = ['Broken Tusk', 'Red Hand', 'Black Moon', 'Bloodfang', 'Ash Wolf', 'Iron Jaw', 'Burning Eye', 'Dust Serpent', 'Bone Drum', 'Thunder Hoof', 'Shattered Spear', 'Grey Crow'];
const ORC_EPITHET = ['Skullsplitter', 'Ironhide', 'Bonechewer', 'Stormcaller', 'Gutripper', 'Ashborn', 'Wolfbiter', 'Longstride', 'Stonefist', 'Redmaw', 'Oathkeeper', 'Scarback'];

// ------------------------------------------------------------------ halfling

const HALF_F = [
  'Andry', 'Bree', 'Callie', 'Cora', 'Euphemia', 'Jillian', 'Kithri', 'Lavinia', 'Lidda', 'Merla', 'Nedda', 'Paela', 'Portia',
  'Seraphina', 'Shaena', 'Trym', 'Vani', 'Verna', 'Daisy', 'Primrose', 'Rosie', 'Marigold', 'Poppy', 'Pansy', 'Ruby', 'Myrtle',
  'Tansy', 'Bella', 'Lobelia', 'Hilly', 'Mirabel', 'Peony', 'Clover', 'Elsie', 'Dottie', 'Fern', 'Hazel', 'Linnet', 'Mabel', 'Tilly',
];
const HALF_M = [
  'Alton', 'Ander', 'Cade', 'Corrin', 'Eldon', 'Errich', 'Finnan', 'Garret', 'Lindal', 'Lyle', 'Merric', 'Milo', 'Osborn',
  'Perrin', 'Reed', 'Roscoe', 'Wellby', 'Bilbert', 'Bungo', 'Dodo', 'Fosco', 'Hamfast', 'Largo', 'Mungo', 'Odo', 'Pip',
  'Polo', 'Rufus', 'Tobold', 'Wilcome', 'Barnaby', 'Cob', 'Doddy', 'Ferdi', 'Hob', 'Jolly', 'Ned', 'Otho', 'Teddy', 'Willum',
];
const HALF_SUR_A = ['Under', 'Tea', 'Brush', 'Green', 'High', 'Good', 'Tall', 'Thorn', 'Honey', 'Apple', 'Butter', 'Bramble', 'Hill', 'Mug', 'Burrow', 'Tumble'];
const HALF_SUR_B = ['bough', 'leaf', 'gather', 'bottle', 'hill', 'barrel', 'foot', 'gage', 'cake', 'dew', 'wort', 'button', 'bank', 'wort', 'top', 'whistle'];

// ------------------------------------------------------------------ goblin

const GOB_ON = ['Sn', 'Gr', 'Zib', 'Nub', 'Sk', 'Kr', 'Rat', 'Muk', 'Pik', 'Fiz', 'Gli', 'Wik', 'Spl', 'Nix', 'Bog', 'Tik', 'Zz', 'Skr'];
const GOB_MID = ['ik', 'ab', 'eg', 'ob', 'ub', 'izz', 'ag', 'it'];
const GOB_END = ['et', 'kit', 'gle', 'nik', 'zit', 'snik', 'ble', 'wick', 'ix', 'ug', 'leek', 'grub', 'ka', 'na', 'ette', 'zza'];
const GOB_EPITHET = [
  'the Quick', 'the Twitchy', 'Three-Fingers', 'the Clever', 'Shinystealer', 'the Loud', 'Ratcatcher', 'the Sneak', 'Burnt-Ear',
  'the Lucky', 'Mudfoot', 'the Nervous', 'Knifewit', 'Half-Nose', 'the Hungry', 'Gearbiter', 'the Unexploded', 'Sparkfingers',
];

// ------------------------------------------------------------------ sylvan

const SYL_NAMES = [
  'Fern', 'Moss', 'Bloom', 'Sorrel', 'Thistle', 'Bracken', 'Willow', 'Lichen', 'Dew', 'Rootsong', 'Spore', 'Hazel', 'Briar',
  'Alder', 'Sedge', 'Tamarack', 'Juniper', 'Nettle', 'Rue', 'Yarrow', 'Larch', 'Cress', 'Morel', 'Clove', 'Bramble', 'Ivy',
  'Reed', 'Aspen', 'Burdock', 'Wort', 'Petal', 'Galingale', 'Myrrh', 'Silverbark', 'Dapple', 'Hollyhock', 'Mallow', 'Tansy', 'Vetch', 'Loam',
];
const SYL_PLACE = ['the Hollow', 'the Deep Glade', 'the Mossbank', 'the Third Ring', 'the Old Root', 'the Dew Pools', 'the Sporefall', 'the Quiet Bough', 'the Bloomcircle', 'the Lantern Caps'];
const SYL_PREFIX = ['Old', 'Little', 'Quiet', 'Bright', 'Green', 'Gray', 'Late', 'First'];

// ------------------------------------------------------------------ drakeborn

const DRAKE_ON = ['Vyr', 'Skal', 'Rhaz', 'Ix', 'Thyr', 'Kael', 'Zar', 'Ors', 'Bah', 'Ghes', 'Medr', 'Nyth', 'Sor', 'Tarh', 'Ur', 'Vrae'];
const DRAKE_END_M = ['ax', 'akar', 'rhan', 'oth', 'esh', 'ivor', 'ash', 'uun', 'ekor', 'ix', 'orn', 'arax'];
const DRAKE_END_F = ['ra', 'ysa', 'inn', 'thra', 'ixa', 'ala', 'essa', 'hira', 'ova', 'ynn', 'ari', 'eshi'];
const DRAKE_CLAN = ['Kesh', 'Vyrr', 'Thal', 'Ix', 'Rhas', 'Dakh', 'Ossa', 'Myr', 'Zhur', 'Kerr', 'Yarj', 'Shen'];

// ------------------------------------------------------------------ umbral

const UMB_ON = ['Ny', 'Ve', 'Sha', 'Mo', 'E', 'U', 'Qe', 'Xi', 'Ae', 'Sy', 'Ith', 'Ca', 'Ze', 'Lu'];
const UMB_END = ['x', 'l', 'th', 'sk', 'n', 'ae', 'ys', 'ith', 'el', 'oun', 'eth', 'ra', 'ul', 'iss'];
const UMB_HOUSE = ['the Veil', 'the Ninth Lamp', 'the Hollow Star', 'the Still Water', 'the Grey Choir', 'the Unlit Door', 'the Long Dusk', 'the Silver Hush', 'the Folded Shadow', 'the Quiet Bell'];

// ------------------------------------------------------------------ giantkin

const GIANT_ON = ['Hrim', 'Jot', 'Ymr', 'Brok', 'Stor', 'Fjal', 'Thrym', 'Skad', 'Gunn', 'Hrod', 'Ulf', 'Bjor', 'Eld', 'Svar', 'Grot'];
const GIANT_END_M = ['gar', 'ulf', 'mund', 'ir', 'ald', 'nar', 'bjorn', 'vald', 'grim', 'stein'];
const GIANT_END_F = ['hild', 'run', 'dis', 'veig', 'gerd', 'laug', 'unn', 'eydr', 'frid', 'borg'];

function givenFor(race: RaceId, gender: number, rng: Rng): string {
  const male = isMasc(gender, rng);
  switch (race) {
    case 'human':
      return byGender(rng, gender, HUMAN_F, HUMAN_M, HUMAN_N);
    case 'elf':
      return syllName(rng, ELF_ON, ELF_MID, male ? ELF_END_M : ELF_END_F, 0.45);
    case 'dwarf':
      return byGender(rng, gender, DWARF_F, DWARF_M);
    case 'orc':
      return syllName(rng, ORC_ON, [], male ? ORC_END_M : ORC_END_F, 0);
    case 'halfling':
      return byGender(rng, gender, HALF_F, HALF_M);
    case 'goblin':
      return syllName(rng, GOB_ON, GOB_MID, GOB_END, 0.35);
    case 'sylvan':
      return rng.pick(SYL_NAMES);
    case 'drakeborn':
      return syllName(rng, DRAKE_ON, [], male ? DRAKE_END_M : DRAKE_END_F, 0);
    case 'umbral':
      return syllName(rng, UMB_ON, ['r', 'v', 'sh', 'l', 'n'], UMB_END, 0.4);
    case 'giantkin':
      return syllName(rng, GIANT_ON, [], male ? GIANT_END_M : GIANT_END_F, 0);
  }
  return byGender(rng, gender, HUMAN_F, HUMAN_M);
}

export function familyName(race: RaceId, rng: Rng): string | null {
  switch (race) {
    case 'human':
      return rng.chance(0.45) ? rng.pick(HUMAN_SUR_TRADE) : join(rng.pick(HUMAN_SUR_A), rng.pick(HUMAN_SUR_B));
    case 'elf':
      return join(rng.pick(ELF_HOUSE_A), rng.pick(ELF_HOUSE_B));
    case 'dwarf':
      return rng.pick(DWARF_CLAN_A) + rng.pick(DWARF_CLAN_B);
    case 'orc':
      return rng.pick(ORC_CLAN);
    case 'halfling':
      return join(rng.pick(HALF_SUR_A), rng.pick(HALF_SUR_B));
    case 'goblin':
      return null;
    case 'sylvan':
      return rng.chance(0.5) ? rng.pick(SYL_PLACE) : null;
    case 'drakeborn':
      return rng.pick(DRAKE_CLAN);
    case 'umbral':
      return rng.pick(UMB_HOUSE);
    case 'giantkin':
      return null;
  }
  return null;
}

export function personName(
  race: RaceId,
  gender: number,
  rng: Rng,
  opts: { family?: string | null; parentGiven?: string; parentGender?: number } = {},
): PersonName {
  const given = givenFor(race, gender, rng);
  const fam = opts.family !== undefined ? opts.family : familyName(race, rng);
  const g = gender;
  switch (race) {
    case 'human':
    case 'halfling':
    case 'elf':
      return { given, family: fam, full: fam ? `${given} ${fam}` : given };
    case 'dwarf': {
      const kin = g > 0.5 ? 'son' : 'daughter';
      const full = fam ? `${given} ${fam}` : given;
      return { given, family: fam, full: opts.parentGiven && rng.chance(0.4) ? `${full}, ${kin} of ${opts.parentGiven}` : full };
    }
    case 'orc': {
      if (rng.chance(0.4)) {
        const ep = rng.pick(ORC_EPITHET);
        return { given, family: fam, full: `${given} ${ep}`, epithet: ep };
      }
      return { given, family: fam, full: fam ? `${given} of the ${fam} clan` : given };
    }
    case 'goblin': {
      const ep = rng.pick(GOB_EPITHET);
      const full = ep.startsWith('the ') ? `${given} ${ep}` : `${given} ${ep}`;
      return { given, family: null, full, epithet: ep };
    }
    case 'sylvan': {
      if (fam) return { given, family: fam, full: `${given}-of-${fam.replace(/^the /, 'the-').replace(/ /g, '-')}` };
      if (rng.chance(0.3)) {
        const ep = rng.pick(SYL_PREFIX);
        return { given, family: null, full: `${ep} ${given}`, epithet: ep };
      }
      return { given, family: null, full: given };
    }
    case 'drakeborn':
      return { given, family: fam, full: fam ? `${fam}-${given}` : given };
    case 'umbral':
      return { given, family: fam, full: fam && rng.chance(0.7) ? `${given} of ${fam}` : given };
    case 'giantkin': {
      const parent = opts.parentGiven ?? givenFor('giantkin', opts.parentGender ?? 1, rng);
      const suffix = g > 0.5 ? 'sson' : 'sdottir';
      const family = parent.replace(/s$/, '') + suffix;
      return { given, family, full: `${given} ${family}` };
    }
  }
  return { given, family: fam, full: fam ? `${given} ${fam}` : given };
}

// ------------------------------------------------------------------ pantheon

const DOMAINS = [
  'forge', 'harvest', 'sea', 'death', 'stars', 'hunt', 'storm', 'hearth', 'trickery', 'wisdom', 'war', 'moon', 'healing',
  'wilds', 'fortune', 'dreams', 'fire', 'stone', 'travel', 'shadow', 'love', 'craft', 'rivers', 'winter',
];
const DOMAIN_EPITHETS: Record<string, string[]> = {
  forge: ['the Anvil Father', 'the Ember Mother', 'Who Tempers', 'the First Smith'],
  harvest: ['the Sheaf Bearer', 'the Green Mother', 'Lord of Barley', 'the Patient Field'],
  sea: ['the Drowned King', 'the Tide Mother', 'the Salt-Crowned', 'Who Keeps the Depths'],
  death: ['the Quiet Ferryman', 'the Last Door', 'the Grey Warden', 'Keeper of Ashes'],
  stars: ['the Lamplighter', 'the Night Weaver', 'Who Counts the Sky', 'the Far Eye'],
  hunt: ['the Antlered One', 'the Silent Bow', 'the Red Stag', 'Who Runs at Dusk'],
  storm: ['the Thunder Herald', 'the Wind-Wife', 'the Breaker of Oaks', 'the Grey Rider'],
  hearth: ['the Kindly Flame', 'the Hearth Mother', 'Keeper of Doors', 'the Warm Hand'],
  trickery: ['the Laughing Mask', 'the Many-Faced', 'the Crooked Fox', 'Who Steals Moons'],
  wisdom: ['the Open Book', 'the Owl-Eyed', 'the Patient Sage', 'the Lantern of Thought'],
  war: ['the Iron Wolf', 'the Red Banner', 'the Unbroken Shield', 'Lord of Spears'],
  moon: ['the Pale Lady', 'the Silver Watcher', 'the Turning Face', 'Who Pulls the Tides'],
  healing: ['the Gentle Hand', 'the Mender', 'Lady of Springs', 'the White Physician'],
  wilds: ['the Horned Wanderer', 'the Mossbearded', 'the Wild Heart', 'Who Walks Unseen'],
  fortune: ['the Golden Wheel', 'the Lucky Coin', 'the Blind Dealer', 'Smile of Chance'],
  dreams: ['the Sleeping Eye', 'the Veil Walker', 'the Murmuring One', 'Weaver of Sleep'],
  fire: ['the Burning Crown', 'the Ashen Phoenix', 'the Kindler', 'Who Devours'],
  stone: ['the Mountain Heart', 'the Unmoving', 'the Deep Root', 'Grandfather Granite'],
  travel: ['the Road Warden', 'the Far Walker', 'the Signpost', 'Lord of Crossroads'],
  shadow: ['the Hidden Door', 'the Dusk Mother', 'the Unlit One', 'Keeper of Secrets'],
  love: ['the Rose Bride', 'the Twin Hearts', 'the Golden Smile', 'Who Binds'],
  craft: ['the Busy Hand', 'the Loom Mother', 'the Measure-Keeper', 'the Patient Maker'],
  rivers: ['the Silver Serpent', 'the Ford Keeper', 'the Wandering Water', 'Mother of Fish'],
  winter: ['the Frost King', 'the White Silence', 'the Long Night', 'Breath of Ice'],
};
const GOD_ON = ['Vel', 'Ama', 'Thor', 'Sel', 'Ky', 'Mor', 'Eth', 'Ul', 'Ish', 'Ora', 'Bael', 'Nym', 'Tyr', 'Hes', 'Ar', 'Zo', 'Lu', 'Dra', 'Ser', 'Yr'];
const GOD_MID = ['a', 'e', 'i', 'o', 'ar', 'en', 'ul', 'ith', 'or'];
const GOD_END = ['thra', 'nos', 'mir', 'unn', 'el', 'is', 'ane', 'oth', 'ara', 'gar', 'ys', 'iel', 'ax', 'ora', 'un'];

export function pantheon(worldSeed: number): Deity[] {
  const rng = new Rng(deriveSeed(worldSeed, 'pantheon'));
  const count = rng.int(4, 7);
  const domains = rng.sample(DOMAINS, count);
  const used = new Set<string>();
  const out: Deity[] = [];
  for (let i = 0; i < count; i++) {
    let name = '';
    for (let tries = 0; tries < 8; tries++) {
      name = syllName(rng, GOD_ON, GOD_MID, GOD_END, 0.4);
      if (!used.has(name)) break;
    }
    used.add(name);
    const domain = domains[i];
    out.push({ id: 'god_' + name.toLowerCase().replace(/[^a-z]/g, ''), name, epithet: rng.pick(DOMAIN_EPITHETS[domain] ?? ['the Nameless']), domain });
  }
  return out;
}

const JOB_DOMAINS: Partial<Record<NpcJob, string[]>> = {
  smith: ['forge', 'fire', 'craft', 'stone'], farmer: ['harvest', 'hearth', 'rivers'], herder: ['harvest', 'wilds'],
  fisher: ['sea', 'rivers', 'moon'], hunter: ['hunt', 'wilds', 'moon'], guard: ['war', 'hearth', 'stone'], miner: ['stone', 'forge', 'fortune'],
  woodcutter: ['wilds', 'craft'], merchant: ['fortune', 'travel'], innkeeper: ['hearth', 'fortune', 'love'], cook: ['hearth', 'harvest'],
  priest: ['wisdom', 'healing', 'death', 'stars'], healer: ['healing', 'moon', 'rivers'], scholar: ['wisdom', 'stars', 'dreams'],
  mage: ['stars', 'dreams', 'fire', 'shadow'], alchemist: ['wisdom', 'fire', 'healing'], bard: ['love', 'trickery', 'dreams', 'fortune'],
  thief: ['trickery', 'shadow', 'fortune'], bandit: ['war', 'trickery', 'shadow'], beggar: ['fortune', 'hearth', 'death'],
  noble: ['war', 'fortune', 'wisdom'], elder: ['death', 'wisdom', 'hearth'], tailor: ['craft', 'love'], carpenter: ['craft', 'wilds'],
  mason: ['stone', 'craft'], pilgrim: ['travel', 'stars', 'healing'], adventurer: ['travel', 'war', 'fortune'],
};
const RACE_DOMAINS: Partial<Record<RaceId, string[]>> = {
  dwarf: ['forge', 'stone'], elf: ['stars', 'moon', 'wilds'], orc: ['war', 'hunt', 'storm'], halfling: ['hearth', 'harvest'],
  goblin: ['trickery', 'fortune', 'shadow'], sylvan: ['wilds', 'rivers', 'dreams'], drakeborn: ['fire', 'war'],
  umbral: ['shadow', 'dreams', 'moon'], giantkin: ['winter', 'stone', 'storm'], human: ['harvest', 'war', 'hearth'],
};

export function patronDeity(gods: Deity[], race: RaceId, job: NpcJob, rng: Rng): Deity {
  const jd = JOB_DOMAINS[job] ?? [];
  const rd = RACE_DOMAINS[race] ?? [];
  return rng.weighted(gods, (g) => 1 + (jd.includes(g.domain) ? 4 : 0) + (rd.includes(g.domain) ? 2.5 : 0));
}

// ------------------------------------------------------------------ titles

const TITLE_NOUN: Record<NpcJob, string[]> = {
  farmer: ['Farmer', 'Crofter', 'Field-hand', 'Grower'], smith: ['Smith', 'Blacksmith', 'Forgemaster', 'Ironwright'],
  merchant: ['Merchant', 'Trader', 'Chandler', 'Dealer'], innkeeper: ['Innkeeper', 'Host', 'Alewife', 'Taverner'],
  guard: ['Guard', 'Watchman', 'Sentry', 'Warden'], priest: ['Priest', 'Cleric', 'Acolyte', 'Votary'],
  hunter: ['Hunter', 'Trapper', 'Tracker', 'Huntsman'], scholar: ['Scholar', 'Scribe', 'Loremaster', 'Archivist'],
  mage: ['Mage', 'Wizard', 'Arcanist', 'Spellwright'], miner: ['Miner', 'Delver', 'Prospector', 'Digger'],
  woodcutter: ['Woodcutter', 'Forester', 'Axeman', 'Lumberer'], fisher: ['Fisher', 'Netcaster', 'Angler', 'Boatman'],
  healer: ['Healer', 'Herbalist', 'Physician', 'Mender'], bard: ['Bard', 'Minstrel', 'Storyteller', 'Songsmith'],
  child: ['Child'], elder: ['Elder', 'Greybeard', 'Old One'], noble: ['Noble', 'Lord', 'Steward', 'Thane'],
  beggar: ['Beggar', 'Vagrant', 'Mendicant'], thief: ['Pickpocket', 'Cutpurse', 'Fence', 'Rogue'],
  bandit: ['Bandit', 'Brigand', 'Outlaw', 'Raider'], adventurer: ['Adventurer', 'Sellsword', 'Treasure-seeker', 'Wanderer'],
  pilgrim: ['Pilgrim', 'Wayfarer', 'Seeker'], herder: ['Herder', 'Shepherd', 'Drover', 'Goatherd'],
  cook: ['Cook', 'Baker', 'Kitchen-keeper'], tailor: ['Tailor', 'Seamster', 'Weaver', 'Clothier'],
  alchemist: ['Alchemist', 'Apothecary', 'Distiller'], carpenter: ['Carpenter', 'Joiner', 'Woodwright'],
  mason: ['Mason', 'Stonecutter', 'Builder'],
};

export function jobTitle(job: NpcJob, place: string | null, rng: Rng, opts: { captain?: boolean; leader?: boolean; ageStage?: AgeStage } = {}): string {
  let noun: string;
  if (opts.leader) noun = job === 'noble' ? rng.pick(['Lord', 'Lady', 'Steward', 'Reeve', 'Thane']) : rng.pick(['Elder', 'Headman', 'Reeve', 'Speaker']);
  else if (opts.captain) noun = rng.pick(['Watch Captain', 'Captain of the Guard', 'Sergeant-at-Arms']);
  else if (job === 'child') noun = 'Child';
  else noun = rng.pick(TITLE_NOUN[job]);
  if (opts.ageStage === 'elder' && !opts.leader && job !== 'elder' && rng.chance(0.4)) noun = 'Old ' + noun;
  if (job === 'child' || job === 'beggar' || job === 'thief' || job === 'bandit' || job === 'pilgrim' || job === 'adventurer' || !place) return noun;
  return `${noun} of ${place}`;
}

// ------------------------------------------------------------------ traits

const TRAIT_WORDS: Record<keyof NpcTraits, [string[], string[]]> = {
  openness: [['set in their ways', 'traditional', 'incurious'], ['curious', 'imaginative', 'open-minded']],
  conscientiousness: [['careless', 'easygoing', 'lazy'], ['diligent', 'orderly', 'meticulous']],
  extraversion: [['reserved', 'quiet', 'withdrawn'], ['talkative', 'boisterous', 'sociable']],
  agreeableness: [['gruff', 'prickly', 'blunt'], ['kind', 'warm', 'generous']],
  neuroticism: [['calm', 'steady', 'unflappable'], ['anxious', 'jumpy', 'moody']],
  courage: [['timid', 'cautious', 'fearful'], ['brave', 'bold', 'fearless']],
  greed: [['open-handed', 'unworldly', 'frugal'], ['greedy', 'grasping', 'shrewd']],
  piety: [['irreverent', 'skeptical', 'godless'], ['devout', 'pious', 'god-fearing']],
};

export function traitWords(traits: NpcTraits): string[] {
  const entries = (Object.keys(TRAIT_WORDS) as (keyof NpcTraits)[])
    .map((k) => ({ k, v: traits[k] }))
    .filter((e) => Math.abs(e.v) > 0.25)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 3);
  const out = entries.map((e) => {
    const pool = TRAIT_WORDS[e.k][e.v > 0 ? 1 : 0];
    // Deterministic per magnitude so the same person always gets the same word.
    return pool[Math.min(pool.length - 1, Math.floor((Math.abs(e.v) - 0.25) * 4 * pool.length / 3))];
  });
  return out.length ? out : ['unremarkable'];
}

// ------------------------------------------------------------------ ambitions

const AMBITION_JOB: Partial<Record<NpcJob, string[]>> = {
  smith: ['to forge a blade worthy of a king', "to become master of the smiths' guild", 'to work a seam of true star-iron'],
  merchant: ['to own a whole caravan of wagons', 'to open a trading house in the capital', 'to corner the salt trade'],
  farmer: ['to buy the fields next to their own', 'to win the harvest fair just once', 'to see their children never go hungry'],
  guard: ['to make captain before their hair goes grey', 'to clear the roads of bandits for good', 'to be remembered as the one who held the gate'],
  priest: ['to raise a proper temple here', 'to hear their god speak plainly, once', 'to bring the lost back to the faith'],
  hunter: ['to bring down the great beast of the hills', 'to map every trail in the valley', 'to hang a trophy no one can match'],
  scholar: ['to finish the history they have been writing for years', 'to decipher the old ruins', 'to be read in libraries far away'],
  mage: ['to master a school of magic nobody teaches', 'to open a door between worlds', 'to earn a seat among the great magi'],
  miner: ['to strike a vein that makes them rich', 'to reach the deepest gallery anyone has dug', 'to own their own mine'],
  innkeeper: ['to make their inn famous across the region', 'to brew an ale people travel for', 'to add a second floor and a stable'],
  bard: ['to compose a song sung in every tavern', 'to perform before royalty', 'to collect the old ballads before they are lost'],
  healer: ['to cure the coughing sickness', 'to train an apprentice worthy of the craft', 'to grow every herb in the old herbals'],
  thief: ['to pull one last job and retire', 'to steal something no one has ever stolen', 'to clear a debt to the wrong people'],
  beggar: ['to have a roof of their own again', 'to see their family once more', 'to win back what was lost'],
  noble: ['to marry their house into a greater one', 'to be remembered as a just ruler', 'to restore their family\'s lost lands'],
  child: ['to become a knight', 'to see a dragon', 'to be allowed to go to the market alone', 'to be as strong as a giant'],
  elder: ['to see grandchildren settled', 'to make peace with an old rival', 'to tell one last great story'],
  adventurer: ['to find a lost crown', 'to have their name in a song', 'to retire rich before forty'],
  pilgrim: ['to reach the holiest shrine', 'to atone for an old sin', 'to see a miracle with their own eyes'],
  tailor: ['to dress a noble for a wedding', 'to invent a new dye', 'to open a shop in a city'],
  alchemist: ['to brew the elixir of long life', 'to turn lead to something better', 'to name a reagent after themselves'],
  cook: ['to cook for a royal feast', 'to perfect their grandmother\'s stew', 'to open their own eatery'],
  carpenter: ['to build a bridge that lasts a century', 'to carve the great hall\'s doors', 'to build a ship'],
  mason: ['to raise a tower that will outlast them', 'to carve their mark on a temple', 'to wall the whole town'],
  woodcutter: ['to fell the great old oak', 'to own a sawmill', 'to plant a forest of their own'],
  fisher: ['to catch the legendary pike', 'to own a proper boat', 'to sail beyond the horizon'],
  herder: ['to breed the finest flock in the region', 'to own their own pastures', 'to win the shearing contest'],
  bandit: ['to make enough to vanish', 'to lead their own band', 'to take revenge on the lord who outlawed them'],
};
const AMBITION_GENERIC = [
  'to see the sea before dying', 'to be remembered kindly', 'to leave this place and see the world', 'to pay off every debt',
  'to find true love', 'to be left in peace', 'to visit the land of their ancestors', 'to learn to read', 'to build a house with their own hands',
];

export function ambitionFor(job: NpcJob, traits: NpcTraits, rng: Rng): string {
  if (traits.greed > 0.5 && rng.chance(0.5)) return rng.pick(['to become the richest soul in town', 'to never count copper again', 'to own half the market']);
  if (traits.piety > 0.6 && rng.chance(0.4)) return rng.pick(['to make a pilgrimage to the holiest shrine', 'to earn a sign of divine favour']);
  if (traits.openness > 0.5 && rng.chance(0.35)) return rng.pick(['to travel beyond the mapped lands', 'to learn the secrets of the old ruins', 'to see the floating isles up close']);
  if (traits.courage > 0.6 && rng.chance(0.35)) return rng.pick(['to slay a monster that has a name', 'to win glory in battle']);
  const pool = AMBITION_JOB[job];
  return pool && rng.chance(0.75) ? rng.pick(pool) : rng.pick(AMBITION_GENERIC);
}

// ------------------------------------------------------------------ bios

export interface BioInput {
  name: string;
  race: RaceId;
  race2: RaceId | null;
  gender: number;
  age: number;
  ageStage: AgeStage;
  job: NpcJob;
  traits: NpcTraits;
  place: string | null;
  placeSize?: string;
  biome?: string;
  spouse?: string | null;
  widowed?: boolean;
  children: number;
  parents?: string[];
  linkedPlace?: string | null;
  deity?: Deity | null;
  wealth: number;
  leader?: boolean;
  captain?: boolean;
  rival?: string | null;
  crush?: string | null;
  debtTo?: string | null;
}

const BEASTS = ['a ridge-wolf', 'a cave bear', 'a marsh lurker', 'a swarm of glass wasps', 'a great boar', 'a night-stalker', 'a wyrmling', 'a rock troll', 'something in the dark woods'];
const DISASTERS = ['a flood', 'a fire', 'a hard winter', 'a raid', 'a sickness', 'a quarrel with the local lord', 'a bad harvest', 'a collapsed mine'];

function pronouns(g: number) {
  return g > 0.66 ? { s: 'he', o: 'him', p: 'his', S: 'He', P: 'His' } : g < 0.34 ? { s: 'she', o: 'her', p: 'her', S: 'She', P: 'Her' } : { s: 'they', o: 'them', p: 'their', S: 'They', P: 'Their' };
}

/** Conjugate the leading verb of a "<verb>s ..." clause for singular they. */
function conj(g: number, clause: string): string {
  if (g < 0.34 || g > 0.66) return clause;
  return clause.replace(/^is /, 'are ').replace(/^(works|leads|commands|belongs)/, (m) => m.slice(0, -1));
}

/** Conjugate a verb for they/he/she (simple present). */
function v(g: number, base: string, third: string): string {
  return g >= 0.34 && g <= 0.66 ? base : third;
}

export function composeBio(b: BioInput, rng: Rng): string {
  const pr = pronouns(b.gender);
  const g = b.gender;
  const first = b.name.split(/[ ,]/)[0];
  const raceWord = b.race2 ? `half-${RACE_NOUN[b.race2].one}, half-${RACE_NOUN[b.race].one}` : RACE_ADJ[b.race];
  const place = b.place ?? 'the open road';
  const job = JOB_NOUN[b.job];
  const words = traitWords(b.traits);
  const s: string[] = [];

  // 1. Origin / role.
  if (b.ageStage === 'child') {
    s.push(rng.pick([
      `${first} is ${article(words[0])} ${words[0]} ${raceWord} child of ${place}, ${b.age} years old.`,
      `${cap(article(words[0]))} ${words[0]} ${raceWord} youngster, ${first} has never been farther than the edge of ${place}.`,
      `${first} is ${b.age}, ${words[0]}, and convinced ${pr.s} ${v(g, 'are', 'is')} destined for great things.`,
    ]));
    if (b.parents?.length) s.push(rng.pick([`${pr.S} ${v(g, 'idolise', 'idolises')} ${b.parents[0]}.`, `${pr.S} ${v(g, 'help', 'helps')} ${b.parents[0]} when ${pr.s} ${v(g, 'are', 'is')} not hiding from chores.`, `${b.parents[0]} worries ${pr.s} ${v(g, 'wander', 'wanders')} too far.`]));
    s.push(rng.pick([
      `${pr.S} secretly ${v(g, 'want', 'wants')} ${ambitionFor('child', b.traits, rng)}.`,
      `${pr.S} ${v(g, 'collect', 'collects')} ${rng.pick(['pretty stones', 'beetles', 'old coins', 'feathers', 'stories about monsters'])}.`,
    ]));
    return s.join(' ');
  }

  const lead = b.leader ? `leads ${place}` : b.captain ? `commands the watch of ${place}` : b.job === 'elder' ? `is one of the elders of ${place}` : b.job === 'noble' ? `belongs to the gentry of ${place}` : `works as ${article(job)} ${job} in ${place}`;
  if (b.linkedPlace && rng.chance(0.4)) {
    s.push(rng.pick([
      `${first}, ${article(words[0])} ${words[0]} ${b.race2 ? raceWord : RACE_NOUN[b.race].one}, came to ${place} from ${b.linkedPlace} after ${rng.pick(DISASTERS)} and now ${lead}.`,
      `Born in ${b.linkedPlace}, ${first} left after ${rng.pick(DISASTERS)}; today ${pr.s} ${conj(g, lead)}.`,
    ]));
  } else {
    s.push(rng.pick([
      `${first} is ${article(words[0])} ${words[0]} ${raceWord} who ${lead}.`,
      `${cap(article(raceWord))} ${b.race2 ? raceWord : RACE_NOUN[b.race].one} of ${b.age} years, ${first} ${lead}${b.ageStage === 'elder' ? ', as ' + pr.p + ' family has for generations' : ''}.`,
      `${first} ${lead} and is known locally as ${words.length > 1 ? words[0] + ' but ' + words[1] : words[0]}.`,
    ]));
  }

  // 2. Backstory event.
  const ev: string[] = [
    `${pr.S} lost a ${rng.pick(['brother', 'sister', 'cousin', 'best friend'])} to ${rng.pick(BEASTS)} years ago and ${v(g, 'have', 'has')} not forgotten it.`,
    `As a youth ${pr.s} ${rng.pick(['apprenticed to a travelling', 'ran away to become a', 'was taken in by an old'])} ${rng.pick(['tinker', 'sellsword', 'herbalist', 'cartographer', 'stonecutter', 'minstrel'])}.`,
    `${pr.S} once won ${rng.pick(['the spring wrestling match', 'a riddle contest against a sphinx-priest', 'a wager with a drunk noble', 'the harvest pie contest', 'a race to the old tower and back'])}, and still ${v(g, 'tell', 'tells')} the story.`,
    `${pr.S} survived ${rng.pick(DISASTERS)} that took most of what ${pr.s} owned.`,
    `${pr.S} ${v(g, 'claim', 'claims')} to have seen ${rng.pick(['a ghost light over the marsh', 'a dragon cross the moon', 'the old ruins glow at midnight', 'a creature with too many eyes'])}.`,
  ];
  if (b.job === 'smith' || b.job === 'carpenter' || b.job === 'mason' || b.job === 'tailor') ev.push(`${pr.S} learned the craft from ${rng.pick(['a stern master', 'a parent', 'a wandering dwarf', 'an old widow'])} and ${v(g, 'swear', 'swears')} by ${pr.p} ${rng.pick(['first hammer', 'old tools', 'teacher\'s methods'])}.`);
  if (b.job === 'guard' || b.captain) ev.push(`${pr.S} still ${v(g, 'carry', 'carries')} a scar from ${rng.pick(['a bandit ambush on the east road', 'a night raid', 'a tavern brawl that went too far'])}.`);
  if (b.job === 'priest' && b.deity) ev.push(`${pr.S} heard the call of ${b.deity.name}, ${b.deity.epithet}, during ${rng.pick(['a fever', 'a storm', 'a long fast', 'a dream'])}.`);
  if (b.deity && b.traits.piety > 0.4 && b.job !== 'priest') ev.push(`${pr.S} ${v(g, 'pray', 'prays')} daily to ${b.deity.name}, ${b.deity.epithet}.`);
  s.push(rng.pick(ev));

  // 3. Family / relations.
  const fam: string[] = [];
  if (b.spouse) fam.push(b.children > 0 ? `${pr.S} ${v(g, 'share', 'shares')} a home with ${b.spouse} and ${b.children === 1 ? 'one child' : b.children + ' children'}.` : `${pr.S} ${v(g, 'are', 'is')} married to ${b.spouse}.`);
  else if (b.widowed) fam.push(`${pr.S} ${v(g, 'have', 'has')} been widowed for ${rng.int(2, 15)} years${b.children ? ' and raises ' + (b.children === 1 ? 'a child' : b.children + ' children') + ' alone' : ''}.`);
  if (b.crush) fam.push(`${pr.S} ${v(g, 'are', 'is')} quietly sweet on ${b.crush}.`);
  if (b.rival) fam.push(`${pr.S} cannot stand ${b.rival}.`);
  if (b.debtTo) fam.push(`${pr.S} ${v(g, 'owe', 'owes')} ${b.debtTo} more coin than ${pr.s} ${v(g, 'like', 'likes')} to admit.`);
  if (fam.length) s.push(rng.pick(fam));

  // 4. Ambition or secret.
  const tail: string[] = [
    `${pr.S} ${v(g, 'hope', 'hopes')} ${ambitionFor(b.job, b.traits, rng).replace(/their/g, pr.p).replace(/them/g, pr.o)}.`,
    `Few know that ${pr.s} ${rng.pick([v(g, 'keep', 'keeps') + ' a hidden purse under the floor', v(g, 'write', 'writes') + ' poetry at night', v(g, 'fear', 'fears') + ' deep water', v(g, 'owe', 'owes') + ' a favour to a smuggler', v(g, 'talk', 'talks') + ' to the dead'])}.`,
  ];
  if (b.wealth > 0.7) tail.push(`${pr.S} ${v(g, 'are', 'is')} wealthier than ${pr.s} ${v(g, 'let', 'lets')} on.`);
  if (b.wealth < 0.2) tail.push(`Money is always short in ${pr.p} household.`);
  if (s.length < 4 || rng.chance(0.5)) s.push(rng.pick(tail));

  // Keep it compact (≤ ~70 words).
  let out = s.join(' ');
  while (out.split(/\s+/).length > 70 && s.length > 2) {
    s.splice(s.length - 2, 1);
    out = s.join(' ');
  }
  return out;
}
