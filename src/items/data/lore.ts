/**
 * Generated text: book titles and bodies, legendary item names and lore,
 * maker's marks. All deterministic from an Rng so the same seed always
 * produces the same book. Books are written in a handful of genres (history,
 * bestiary, travelogue, poetry, craft manual, prophecy, diary, sermon), each
 * assembled from phrase templates and world nouns.
 *
 * Shared (server + client).
 */
import type { Rng } from '../../core/rng';
import { styleOf } from './styles';

const PLACES = ['the Ashen Vale', 'Kel Morrow', 'the Sunken Stair', 'the Thornwood', 'Highmere', 'the Glass Desert', 'Duskhollow', 'the Saltmarch', 'Old Varnholt', 'the Shattered Coast', 'Emberfall', 'the Hanging Isles', 'the Underdeep', 'Mirewatch', 'Stonebridge', 'the Weeping Pines'];
const PEOPLE = ['a wandering tinker', 'the old queen', 'a dwarven runesmith', 'a goblin chieftain', 'an elven archivist', 'the hermit of the hill', 'a drakeborn exile', 'twin sisters of the mill', 'a one-eyed captain', 'the last priest of the drowned god', 'a halfling cartographer', 'an umbral seer'];
const THINGS = ['a crown of salt', 'the moon-bell', 'a sword with no edge', 'the first seed', 'a lantern that burned cold', 'the name of the wind', 'a map of the underworld', 'a door in the sky', 'the heart of a mountain', 'a song that could not be sung twice'];
const BEASTS = ['the ridgeback wyrm', 'glass-winged moths', 'the marsh lurker', 'cave weavers', 'the antlered howler', 'stonebacks', 'the drowned hounds', 'ember salamanders', 'sky-eels', 'the many-mouthed toad'];
const VIRTUES = ['patience', 'courage', 'hunger', 'grief', 'loyalty', 'pride', 'mercy', 'cunning', 'faith', 'longing'];
const SKILL_TOPICS: Record<string, string> = {
  blades: 'the sword', axes: 'the axe', blunt: 'the mace and hammer', polearms: 'the spear and halberd', archery: 'the bow', throwing: 'thrown weapons', unarmed: 'the open hand', shields: 'the shield',
  heavy_armor: 'wearing plate', light_armor: 'moving in leather', mining: 'the deep veins', woodcutting: 'felling timber', herbalism: 'wild herbs', foraging: 'living off the land', smithing: 'the forge',
  alchemy: 'the alembic', cooking: 'the hearth', tailoring: 'needle and thread', enchanting: 'binding power into things',
};

export const BOOK_GENRES = ['history', 'bestiary', 'travelogue', 'poetry', 'manual', 'prophecy', 'diary', 'sermon', 'fable'] as const;
export type BookGenre = (typeof BOOK_GENRES)[number];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Title case except short joining words. */
const titleCase = (s: string) => s.split(' ').map((w, i) => (i > 0 && ['of', 'the', 'and', 'in', 'a'].includes(w) ? w : cap(w))).join(' ');

/** Generate a book: title, author and multi-paragraph body. */
export function generateBook(rng: Rng, opts: { genre?: BookGenre; skill?: string; worldName?: string } = {}): { title: string; author: string; text: string; genre: BookGenre } {
  const genre: BookGenre = opts.genre ?? (opts.skill ? 'manual' : rng.pick(BOOK_GENRES));
  const place = rng.pick(PLACES), person = rng.pick(PEOPLE), thing = rng.pick(THINGS), beast = rng.pick(BEASTS), virtue = rng.pick(VIRTUES);
  const st = styleOf(rng.pick(['human', 'elf', 'dwarf', 'orc', 'halfling', 'goblin', 'sylvan', 'drakeborn', 'umbral', 'giantkin']));
  const author = legendaryName(rng, st.id) + (rng.chance(0.5) ? ` of ${rng.pick(PLACES).replace(/^the /, '')}` : '');
  const year = rng.int(112, 1180);
  let title = '';
  const p: string[] = [];
  switch (genre) {
    case 'history':
      title = rng.pick([`The Fall of ${place.replace(/^the /, '')}`, `A Chronicle of ${cap(place)}`, `The ${cap(virtue)} of Kings`, `Year ${year}: The Long Winter`]);
      p.push(`In the ${year}th year of the reckoning, ${place} was a place of ${virtue}. Its walls were young, its granaries full, and no one yet spoke of ${thing}.`);
      p.push(`It was ${person} who first brought word of the danger. They were not believed — the histories rarely record who was believed, only who was right.`);
      p.push(`What followed took a generation. Some say ${beast} came down from the heights; others that the cause was older, and ${rng.pick(['buried', 'drowned', 'forgotten', 'sealed'])} beneath the old roads.`);
      p.push(`Of ${place} today only foundations remain, and a saying among the ${st.adj.toLowerCase()} folk: "${cap(virtue)} builds walls; ${rng.pick(VIRTUES)} tears them down."`);
      break;
    case 'bestiary':
      title = rng.pick([`On the Habits of ${cap(beast.replace(/^the /, ''))}`, `A Hunter's Bestiary`, `Beasts of ${cap(place.replace(/^the /, ''))}`]);
      p.push(`Of ${beast}: it keeps to ${rng.pick(['high ridges', 'deep caves', 'still water', 'old forests', 'the edges of settlements'])} and is most active ${rng.pick(['at dusk', 'before storms', 'under a full moon', 'in the hottest hour'])}.`);
      p.push(`It fears ${rng.pick(['fire', 'silver', 'loud bells', 'salt', 'running water'])} and hunts by ${rng.pick(['scent', 'sound', 'the warmth of blood', 'movement alone'])}. A careful traveller can pass it by; a careless one becomes a meal.`);
      p.push(`Its ${rng.pick(['hide', 'fangs', 'venom', 'scales', 'bones'])} fetch a fine price among alchemists and smiths, who swear by their ${rng.pick(['potency', 'hardness', 'strange warmth', 'resonance'])}.`);
      p.push(`Advice: ${rng.pick(['strike from above', 'never fight it in water', 'aim for the soft underside', 'let it tire itself', 'do not look into its eyes'])}.`);
      break;
    case 'travelogue':
      title = rng.pick([`Roads to ${cap(place.replace(/^the /, ''))}`, `Letters from the Road`, `Forty Nights Beyond the Pass`]);
      p.push(`We left at first light with three mules and too little bread. By the fourth day the road became a path, and by the sixth the path became a rumour.`);
      p.push(`In ${place} the people ${rng.pick(['greet strangers with salt', 'paint their doors blue against spirits', 'never speak after sunset', 'bury their dead standing'])}. I was offered ${rng.pick(['fermented milk', 'roasted beetles', 'a bowl of bitter tea', 'a seat at the elders\' fire'])} and accepted, as one must.`);
      p.push(`${cap(person)} told me of ${thing}, hidden somewhere ${rng.pick(['beyond the falls', 'under the old shrine', 'in the ruins to the north', 'in the deep caves'])}. I did not go. I regret it still.`);
      break;
    case 'poetry': {
      title = rng.pick([`Songs of ${cap(virtue)}`, `The ${cap(virtue)} Cycle`, `Verses for the Long Night`]);
      const line = () => rng.pick([`the ${rng.pick(['river', 'mountain', 'lantern', 'raven', 'ember'])} remembers what we lose`, `${virtue} is a road with no inn`, `we buried ${rng.pick(['our songs', 'the old names', 'our swords', 'the bells'])} beneath ${place}`, `the stars are the campfires of the dead`, `and still the ${rng.pick(['wind', 'sea', 'snow', 'night'])} came calling`]);
      for (let s = 0; s < 3; s++) p.push([line(), line(), line(), line()].map(cap).join(',\n') + '.');
      break;
    }
    case 'manual': {
      const topic = SKILL_TOPICS[opts.skill ?? ''] ?? 'the craft';
      const T = titleCase(topic.replace(/^the /, ''));
      title = rng.pick([`On ${T}`, `A Primer of ${T}`, `The ${cap(virtue)} of ${T}`, `Notes on ${T}`]);
      p.push(`Every master of ${topic} was once a fool with ${topic}. This book is for the fool.`);
      p.push(`First principle: ${rng.pick(['economy of motion', 'respect for the material', 'patience before strength', 'rhythm over force', 'knowing when to stop'])}. Second: ${rng.pick(['practice daily', 'learn from failure', 'watch the masters', 'trust your hands', 'listen to the tool'])}.`);
      p.push(`${cap(person)} taught me the trick of ${rng.pick(['the turned wrist', 'the half-breath', 'the cold start', 'the second look', 'the soft grip'])}. I pass it to you: ${rng.pick(['do less, sooner', 'begin where the material is weakest', 'finish every motion', 'let the weight work for you'])}.`);
      p.push('Study these pages well, and your hands will remember what your head forgets.');
      break;
    }
    case 'prophecy':
      title = rng.pick([`The Book of ${cap(virtue)}`, `What the Seer Saw`, `The ${cap(thing.replace(/^(a|the) /, ''))} Prophecy`]);
      p.push(`When ${rng.pick(['the moons stand together', 'the rivers run backward', 'the mountain sleeps', 'the last bell is silent'])}, one shall come bearing ${thing}.`);
      p.push(`They shall walk from ${place} to ${rng.pick(PLACES)}, and ${rng.pick(['kings shall kneel', 'the dead shall wake', 'the sky shall open', 'the old gods shall listen'])}.`);
      p.push(`Beware ${rng.pick(['the gift freely given', 'the friend who smiles too often', 'the second dawn', 'the door with no key'])}. ${cap(virtue)} alone will not suffice.`);
      break;
    case 'diary':
      title = rng.pick(['A Private Diary', `Notes of ${author.split(' ')[0]}`, 'Kept Thoughts']);
      for (let d = 0; d < 3; d++) p.push(`Day ${rng.int(1, 300)}. ${rng.pick([`Rain again. ${cap(person)} came by asking about ${thing}; I said nothing.`, `Found tracks of ${beast} by the well. Told no one. Should have.`, `Sold the last of the ${rng.pick(['wool', 'salt', 'iron', 'grain'])} at a loss. ${cap(virtue)} does not fill a belly.`, `Dreamed of ${place} again. The door was open this time.`, `I have hidden the key ${rng.pick(['under the third stone', 'in the hollow oak', 'behind the shrine', 'in my boot'])}. If you are reading this, I am sorry.`])}`);
      break;
    case 'sermon':
      title = rng.pick([`Sermons on ${cap(virtue)}`, 'The Lantern Homilies', `Prayers for ${cap(place.replace(/^the /, ''))}`]);
      p.push(`Brothers and sisters, we gather in ${virtue}. The world is wide and dark, and the lantern is small — and yet it is enough to see the next step.`);
      p.push(`Remember ${person}, who gave away ${thing} and was richer for it. Remember ${place}, which kept its gold and fell.`);
      p.push(`Go now, and carry the light a little further than you found it.`);
      break;
    case 'fable':
      title = rng.pick([`The Fox and the ${cap(rng.pick(['Crow', 'Wolf', 'Bell', 'Miller']))}`, `Why the ${cap(rng.pick(['Moon', 'Owl', 'River', 'Mountain']))} Is Silent`, `The Tale of ${cap(thing.replace(/^(a|the) /, ''))}`]);
      p.push(`Long ago, when animals still spoke, a ${rng.pick(['fox', 'crow', 'badger', 'hare'])} found ${thing} lying in the road.`);
      p.push(`"Give it to me," said the ${rng.pick(['wolf', 'bear', 'serpent', 'king'])}, "and I will make you rich." But the ${rng.pick(['fox', 'crow', 'badger', 'hare'])} remembered ${virtue}, and ran.`);
      p.push(`And that is why, to this day, ${rng.pick(['foxes have red tails', 'crows laugh at kings', 'badgers live underground', 'hares never sleep'])}.`);
      break;
  }
  if (opts.worldName && rng.chance(0.5)) p.push(`— written in the reckoning of ${opts.worldName}`);
  return { title, author, text: p.join('\n\n'), genre };
}

/** A proper name in a culture's syllables, e.g. "Thalithwen", "Grimdokheim". */
export function legendaryName(rng: Rng, style: string): string {
  const st = styleOf(style);
  const n = rng.pick(st.syl[0]) + rng.pick(st.syl[1]) + rng.pick(st.syl[2]);
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

const LEG_DEEDS = [
  'was carried by {who} at the siege of {place}, and did not break when the gate did',
  'was quenched in the blood of {beast}, and has run warm ever since',
  'was lost for three generations in {place} until a shepherd found it shining in a stream',
  'was forged as a wedding gift and used, the songs say, at the funeral',
  'was buried with {who}, and did not stay buried',
  'passed through eleven hands in a single war; each owner died old',
  'was made to settle a debt between {who} and {who2}; it settled several',
  'sings faintly before a storm, and its owners learned to listen',
];

/** Lore paragraph for a generated legendary item. */
export function legendaryLore(rng: Rng, style: string, baseName: string): string {
  const st = styleOf(style);
  const who = `${legendaryName(rng, style)} ${rng.pick(st.epithets)}`;
  const who2 = rng.pick(PEOPLE);
  const deed = rng.pick(LEG_DEEDS).replace('{who}', who).replace('{who2}', who2).replace('{place}', rng.pick(PLACES)).replace('{beast}', rng.pick(BEASTS));
  const maker = `${st.adj} ${rng.pick(['smiths', 'artisans', 'masters', 'hands'])}`;
  return `This ${baseName.toLowerCase()} was made by ${maker} long ago. It ${deed}. ${rng.pick(['Its edge has never needed honing.', 'Its maker\'s mark is a ' + rng.pick(['coiled serpent', 'single star', 'broken crown', 'closed eye', 'oak leaf']) + '.', 'Some say it chooses its bearer.', 'It is heavier in the hands of a liar.', 'Its true name is carved where only the light can read it.'])}`;
}

/** A short "origin" line for crafted or found items. */
export function makersMark(rng: Rng, style: string, how: 'crafted' | 'found' | 'merchant'): string {
  const st = styleOf(style);
  if (how === 'crafted') return `Made by ${legendaryName(rng, style)}, ${st.adj.toLowerCase()} artisan`;
  if (how === 'merchant') return `${st.adj} make`;
  return `Found in ${rng.pick(PLACES)}`;
}
