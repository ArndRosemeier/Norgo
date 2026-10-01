/**
 * The game master's phrasebook: second-person narration templates in the
 * combinatorial syntax of `text.ts`. Pools are keyed by situation; the server
 * narrator picks with a VarietyMemory so pools rotate and sentences never repeat.
 *
 * World specifics are injected through variables ($world, $leaf, $skyc, $moon,
 * $sun, $legend...) computed from the WorldProfile and the lore, so the same
 * template reads differently on every seed.
 *
 * Pure data + helpers; no server imports.
 */
import { Biome } from '../world/biomes';
import type { WorldProfile } from '../world/profile';
import type { WeatherKind } from '../shared/types';

/** Name a hue (0..1) with an evocative colour word. */
export function hueWord(h: number, sat = 0.5): string {
  if (sat < 0.12) return 'grey';
  const x = ((h % 1) + 1) % 1;
  if (x < 0.03 || x >= 0.95) return 'crimson';
  if (x < 0.08) return 'rust-red';
  if (x < 0.13) return 'amber';
  if (x < 0.18) return 'golden';
  if (x < 0.24) return 'olive';
  if (x < 0.36) return 'green';
  if (x < 0.45) return 'jade';
  if (x < 0.52) return 'teal';
  if (x < 0.6) return 'azure';
  if (x < 0.68) return 'deep blue';
  if (x < 0.76) return 'violet';
  if (x < 0.86) return 'purple';
  return 'rose';
}

function rgbHue(c: [number, number, number]): [number, number] {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const l = (mx + mn) / 2;
  const s = d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [(h + 1) % 1, s];
}

/** Colour words for a world's palette: foliage ($leaf), sky ($skyc), water ($waterc), sun ($sunc). */
export function paletteWords(p: WorldProfile): Record<string, string> {
  const [sh, ss] = rgbHue(p.skyZenith);
  const [wh, ws] = rgbHue(p.waterColor);
  const [suh, sus] = rgbHue(p.sunColor);
  const [ch, cs] = rgbHue(p.crystalTint);
  return {
    leaf: hueWord(p.foliageHue, 0.5),
    skyc: hueWord(sh, ss),
    waterc: hueWord(wh, ws),
    sunc: sus < 0.15 ? 'white' : hueWord(suh, sus),
    crystalc: hueWord(ch, cs),
  };
}

export type Pool = readonly string[];

/** Arrival narration per biome (surface & underworld). */
export const BIOME_ARRIVAL: Partial<Record<Biome, Pool>> = {
  [Biome.Grassland]: [
    'The land opens into {rolling|endless|wind-combed} meadows{, $leaf grass rippling to the horizon|; the grass here has a $leaf sheen}. {Larks rise from your path.|You can see weather coming from a day away.}',
    'You step out into the meadowlands. {The wind smells of clover and distant rain.|Wildflowers nod in the breeze, and somewhere a cowbell clanks.} {Nothing here hides — not you, not what hunts.|It is easy country, and easy country makes people careless.}',
    'Grass to your knees, sky to the edge of the world. {The $skyc dome above feels close enough to touch.|Shadows of clouds race each other across the hills.}',
  ],
  [Biome.TemperateForest]: [
    'The trees close in{ overhead|}, and the light turns {green and gold|dim and dappled}. {Old trunks wear coats of moss.|Somewhere a woodpecker hammers like a tiny smith.} {The forest is listening.|You feel watched, but not unkindly.}',
    'You pass beneath the eaves of the old forest. {Leaf-litter softens every footfall.|The air is cool and smells of loam and rot and growth.} {Paths here were made by deer, not people.|It would be easy to get lost — easier still to be found.}',
    'Great boughs knit a roof of $leaf leaves above you. {Shafts of light fall like spears between the trunks.|Fireflies drift between the roots at the edge of sight.}',
  ],
  [Biome.Taiga]: [
    'Dark pines march away in silent ranks{, and the cold has teeth|}. {Your breath smokes.|Needles crunch underfoot, frosted at the tips.} {The taiga keeps its secrets well.|Somewhere far off, a wolf calls and is answered.}',
    'You enter the taiga. {The silence here is deep enough to hear snow settle.|Resin scents the cold air.} {Tracks cross your path — big ones.|A raven follows you from tree to tree, curious.}',
  ],
  [Biome.Jungle]: [
    'Heat wraps around you like a wet cloak as the jungle swallows the path. {Every leaf drips.|Vines hang like ropes left for climbers.} {Things chitter and call in the canopy.|The undergrowth moves where nothing should be.}',
    'You push into the jungle{ and the world turns green|}. {Flowers the size of shields open above you.|The air hums with insects.} {The canopy shuts out the $skyc sky.|Light comes down in ragged coins.}',
  ],
  [Biome.Savanna]: [
    'The savanna stretches gold and endless{, broken only by lone, flat-topped trees|}. {Heat shimmers on the horizon.|Herds drift in the distance like slow clouds.} {Out here, you are either hunter or hunted.|The grass hides more than it shows.}',
    'You walk out onto the savanna. {Dry grass whispers against your legs.|A hot wind carries dust and the smell of distant rain.}',
  ],
  [Biome.Desert]: [
    'The dunes begin. {Sand sings softly as it slides.|The $sunc sun hammers down without mercy.} {Water is worth more than gold here.|Every ridge looks the same; trust your stars, not your eyes.}',
    'You crest a ridge and the dune sea opens before you{, wave on frozen wave|}. {Your shadow is the only shade for a mile.|Heat rises from the sand like breath from an oven.}',
  ],
  [Biome.Badlands]: [
    'The land breaks into red mesas and deep-cut canyons{, striped like a cut cake of stone|}. {Wind moans through the arches.|Loose scree skitters down at every step.} {It is a fine place for an ambush.|Outlaws love country like this.}',
    'You enter the badlands. {Layer upon layer of ochre rock tells the story of ages.|Natural bridges span the gulches like the bones of giants.}',
  ],
  [Biome.Tundra]: [
    'The trees give up and the tundra begins: {a flat, frozen sea of lichen and stone|white to the edge of sight}. {The wind never stops.|The cold gets into your joints and settles there.}',
    'You walk onto the open tundra. {The horizon is very far and very empty.|Snow hisses across the ground in thin ribbons.} {Even the light seems cold.|Out here you can see trouble coming. So can it.}',
  ],
  [Biome.Glacier]: [
    'Ice. {Blue in the cracks, white everywhere else.|Old ice, groaning under its own weight.} {Each step crunches like breaking glass.|The cold is a living thing here.} {Mind the crevasses.|Something is frozen deep down — you can almost see its shape.}',
    'You climb onto the glacier. {Wind-carved ridges glitter.|The glare makes you squint.} {The silence is total, then broken by a distant crack like thunder.|Meltwater gurgles somewhere beneath your feet.}',
  ],
  [Biome.Swamp]: [
    'The ground softens and the fen takes you{ in its damp embrace|}. {Mist coils over black water.|Reeds hiss.} {Every step sucks at your boots.|Bubbles rise from the muck — something breathes down there.}',
    'You wade into the fen. {Will-o\'-wisps flicker at the edge of sight.|Frogs fall silent as you pass.} {The air tastes of rot and green things.|Dead trees stand like drowned sentinels.}',
  ],
  [Biome.Volcanic]: [
    'Ash crunches beneath your feet. {The air stinks of sulphur.|The ground is warm, then hot.} {Distant vents glow like forge mouths.|Grey flakes drift down like dirty snow.} {Here the world is still being made.|Nothing here forgives a misstep.}',
    'You enter the ashlands{, where the earth bleeds fire|}. {Black rock glitters with glassy veins.|A low rumble rolls beneath you, felt more than heard.}',
  ],
  [Biome.CrystalWastes]: [
    'Crystal spires rise from the salt like frozen music{, $crystalc light bending through them|}. {They hum faintly.|Your reflection follows you in a hundred facets.} {It is beautiful. It is also wrong.|Compasses wander here.}',
    'You enter the crystal wastes. {Light splits into rainbows on every edge.|The air has a taste like lightning.} {Something chimes in the distance — no wind to explain it.|The crystals feel warmer than they should.}',
  ],
  [Biome.FungalGrove]: [
    'Mushrooms taller than houses tower overhead{, their caps glowing faintly|}. {Spores drift like slow snow.|The ground is soft and springy and faintly warm.} {Breathe shallowly.|Colours here seem too bright.}',
    'You walk into the fungal grove. {Gills of the giant caps pulse with faint light.|A sweet, heavy smell fills your head.} {Things scurry between the stalks.|The silence is thick, like walking in a dream.}',
  ],
  [Biome.FloatingIsles]: [
    'Islands hang in the sky above you{, trailing roots and waterfalls that turn to mist before they land|}. {Your step feels lighter.|The ground seems to have forgotten its weight.} {This is $skyname.|Birds roost on the undersides of the isles.}',
    'You enter $skyname. {Stone drifts overhead like sleeping whales.|Wind plays through the gaps between floating rocks.} {A strong leap here carries you absurdly far.|Gravity loosens its grip on you.}',
  ],
  [Biome.KarstPillars]: [
    'Stone pillars rise from the green like the columns of a ruined god-temple{, wreathed in mist and vines|}. {Waterfalls spill from their sides.|Monkeys — or something like them — call from the heights.}',
    'You walk into the stone forest. {Mist pools between the towers of rock.|Each pillar wears a crown of trees.} {Climbers could see for miles from the top.|Paths twist like a maze between the stone feet.}',
  ],
  [Biome.SaltFlats]: [
    'The world goes white and flat. {Salt crust crackles under each step.|Heat haze turns the horizon into a lake that is never there.} {There is nowhere to hide.|The glare is merciless.}',
    'You step onto the salt flats. {Your footprints are the only marks for a mile.|The sky and ground blur into one pale shimmer.}',
  ],
  [Biome.GlowCaverns]: [
    'Glowshrooms light the cavern in soft {blue|green|violet} pools{, like a sky full of drowned stars|}. {Water drips somewhere, patient as a clock.|Spores drift in the light.} {It is beautiful, and it is very far from the sun.|Your torchlight seems rude here.}',
    'You enter the glowshroom caverns. {Bioluminescent caps carpet the walls.|Pale light ripples across the ceiling.} {Things that have never seen the sun skitter away.|The deep air is warm and damp.}',
  ],
  [Biome.Geodes]: [
    'The cave walls become crystal{, every surface glittering|}. {Your light shatters into a thousand points.|Amethyst spikes as long as spears jut from the walls.} {You are walking inside a broken jewel.|The halls ring at every footstep.}',
    'You pass into the geode halls. {Crystal teeth line the passage.|Colours swirl in the stone like trapped dawn.}',
  ],
  [Biome.MagmaDepths]: [
    'Heat slams into you. {Rivers of molten rock crawl between black islands.|The air shimmers and roars.} {Every breath burns.|Sparks rise like fireflies from hell.} {Watch where you step. Watch very carefully.|The world\'s heart is close.}',
    'You descend into the magma depths. {Red light paints the cavern ceiling.|The rock sweats and cracks.}',
  ],
  [Biome.UnderSea]: [
    'Black water stretches out under a stone sky — the lightless sea. {Waves lap at the shore without wind.|Pale things drift under the surface.} {Sound carries strangely here.|Your light reaches only a few strides across the water.}',
    'You reach the shore of the lightless sea. {The water is utterly still, then not.|Glowing motes drift above it like breath on a cold day.}',
  ],
  [Biome.BoneHollows]: [
    'Bones. {Great arches of them, ribs of beasts bigger than houses.|Skulls the size of carts stare from the walls.} {Dust hangs in the air.|Every step crunches.} {Whatever died here, died long ago. Mostly.|The silence feels like held breath.}',
    'You enter the bone hollows. {Ancient remains are fused into the rock itself.|Pale dust coats everything.}',
  ],
  [Biome.RootCathedral]: [
    'Roots as thick as towers descend from the cavern roof{, braided into vaults and arches|}. {Water trickles down them like hymns.|Moss glows faintly along their length.} {It feels like a holy place.|You speak in a whisper without meaning to.}',
    'You walk into the root cathedral. {Pale tendrils hang like chandeliers.|The air smells of earth and old rain.}',
  ],
};

/** Prefix for the first visit to a biome in this life. */
export const BIOME_FIRST: Pool = [
  '{You have never seen country like this.|New country.|This is new ground for you.}',
  '{Nothing you have heard prepares you for this.|Your eyes go wide.|You slow, taking it all in.}',
  '{The map in your head grows.|Another corner of $world.}',
];

export const BIOME_RETURN: Pool = [
  'The $biome again. {It has not missed you.|Familiar ground, though never quite safe.}',
  'Back in the $biome.',
  '{You know this country now|The $biome welcomes you back, more or less}.',
];

export const UNDERWORLD_ENTER: Pool = [
  'The last of the daylight is gone. You are in $underworld now{ — the world beneath the world|}. {The air is warm and old.|Sound behaves differently down here.} {Somewhere above, the sun is shining. It does not matter.|Gravity feels a fraction heavier.}',
  'The passage opens into a cavern so vast its ceiling is lost in darkness: $underworld. {Strange lights glimmer in the distance.|Wind moves here, though there is no sky.} {Legends say $adversary sleeps somewhere below.|Few come this deep. Fewer return.}',
  'You have descended into $underworld. {The rock overhead is a sky of stone.|Your heartbeat seems loud.} {Here the old stories stop being stories.|Mind your light.}',
];

export const UNDERWORLD_LEAVE: Pool = [
  '{Daylight|Fresh air} — {you had forgotten how it tastes|it hits you like cold water}. You have left $underworld behind.',
  'The depths release you. {The sky has never looked so wide.|You climb back into the surface world, blinking.}',
];

export const GRAVITY_LOW: Pool = [
  'Your body suddenly feels {lighter|weightless|like thistledown}. {Each step becomes a small bound.|Pebbles you kick drift lazily before falling.} {One of the $anomaly.|The earth\'s grip loosens here.}',
  'The pull of the ground fades. {Your stomach lurches as if you were falling upward.|Your hair lifts gently.} {Leap carefully — coming down takes a while.|This must be one of the $anomaly.}',
  '{Weight drains out of you.|You feel as if a hand has lifted you by the collar.} {Gravity is weak here.|The $anomaly — the legends were true.}',
];
export const GRAVITY_HIGH: Pool = [
  'Your limbs turn to lead. {Every step costs twice the effort.|Your pack drags at your shoulders like a stone.} {The ground pulls hard here — one of the heavy $anomaly.|Falling here would be a very bad idea.}',
  'The air seems to press down on you. {Breathing is work.|Your knees ache.} {This is a place of crushing weight.|Even the plants grow low and squat.}',
];
export const GRAVITY_NORMAL: Pool = [
  'The world\'s pull settles back to normal. {Your body thanks you.|Your feet remember the ground.}',
  'Weight returns to its proper measure.',
];

export const NIGHTFALL: Pool = [
  'Night falls over $world. {$moon rises|The stars come out one by one}{, and the shadows lengthen|}. {Creatures of the dark stir.|Wise travellers find a fire.}',
  'Dusk gives way to night. {The $skyc of the sky deepens to black.|The wind changes.} {Out here, the night belongs to other things.|Somewhere, something wakes hungry.}',
  'The sun slips below the horizon. {$moon watches.|Darkness pools beneath the trees.} {Keep your torch close.|Listen.}',
];
export const NIGHTFALL_MOONLESS: Pool = [
  'Night falls, and $world has no moon to soften it. {The dark is absolute between the stars.|Only starlight now.} {Keep your torch close.|Listen carefully.}',
];
export const DAWN: Pool = [
  'Dawn breaks{, $sunc and slow|}. {The night\'s terrors slink back to their dens.|Birds begin to sing.} {You have survived another night.|A new day in $world.}',
  'The sky pales, then blazes. {Mist rises from the low ground.|Warmth returns to your fingers.}',
  'Morning comes to $world. {The long shadows shrink.|Dew glitters on every surface.}',
];

export const WEATHER: Record<WeatherKind, Pool> = {
  clear: ['The clouds part. {The $skyc sky opens wide above you.|Sunlight floods the land.}', 'The weather clears{, and the world seems larger|}.'],
  cloudy: ['Clouds gather{, grey and heavy|, rolling in from the $wind}.', 'The sky clouds over. {The light goes flat.|Colours dull.}'],
  rain: ['Rain begins to fall{, soft at first, then steady|}. {The smell of wet earth rises.|Every leaf drips.}', 'The heavens open. {Rain drums on everything.|You are soaked in moments.}'],
  storm: ['Thunder rolls across the land. {A storm is breaking.|Lightning splits the sky.} {Find shelter — or don\'t, and be remembered.|The wind howls out of the $wind.}', 'The storm hits{ like a fist|}. {Rain comes sideways.|The sky turns the colour of a bruise.}'],
  snow: ['Snow begins to fall{, silent and thick|}. {The world softens to white.|Tracks fill in behind you.}', 'Flakes drift down from a leaden sky. {Your breath steams.|The cold deepens.}'],
  fog: ['Fog rolls in{, thick as wool|}. {Shapes loom and vanish.|Sound grows muffled and strange.} {Anything could be out there.|Stay close to the path.}', 'Mist rises and swallows the land. {You can barely see your own hand.|The world shrinks to a few grey strides.}'],
  ashfall: ['Ash begins to fall from a darkened sky. {It tastes of sulphur.|Grey flakes settle on your shoulders.}', 'The volcanoes are speaking. {Ash drifts down like grey snow.|The sun turns a sullen red.}'],
  sporefall: ['Spores drift down in glittering clouds. {Breathe carefully.|The air shimmers with them.}', 'A sporefall begins{ — the grove is breathing out|}. {Colours seem to swim.|Your thoughts feel slow and pleasant.}'],
};

export const SITE_FIRST: Pool = [
  'You arrive at $line {$people look up from their work as you pass.|Smoke rises from chimneys, and somewhere a dog barks.}',
  '$line {Few strangers come through here — you are noticed.|A cart rattles past; the driver nods to you.}',
  'You enter $name. $line',
];
export const SITE_AGAIN: Pool = [
  '$name again. {Familiar streets, familiar faces.|Some of the locals recognise you now.}',
  'You return to $name. {Nothing much has changed.|The $inn is still where you left it.}',
  'Back in $name.',
];
export const SITE_WANTED: Pool = [
  '{Eyes follow you.|Conversation stops as you pass.} {The guards of $name have not forgotten your crimes.|There is a price on your head here.}',
];
export const SITE_HERO: Pool = [
  '{People smile at you here.|A child points at you and whispers your name.} {Word of your deeds has reached $name.|Here you are welcome.}',
];

export const POI_DISCOVER: Pool = [
  'You have found $poiname. $legend',
  '$poiname. {You stop and take it in.|So the stories were true.} $legend',
  '{Before you lies|You come upon} $poiname. $legend',
];

export const LEVEL_UP: Pool = [
  'Your {skill|mastery} in $skill grows{ — level $level|}. {Practice is its own teacher.|Your hands remember what your mind forgets.}',
  '$skill: level $level. {You feel it settle into your bones.|Something clicks.}',
  '{Each attempt taught you something.|The world is a harsh tutor.} You are now level $level in $skill.',
];
export const LEVEL_MILESTONE: Pool = [
  'Level $level in $skill. {Masters would nod at that.|Few in $world can match you in this.} {Songs are made of less.|The world takes notice.}',
];
export const UNLOCK: Pool = [
  'A new ability awakens in you: $ability. {You understand now how it is done.|It feels as natural as breathing.}',
  'You have learned $ability. {Use it well.|The world just got a little smaller.}',
];

export const NEAR_DEATH: Pool = [
  'Blood in your mouth. {Your vision narrows.|Your legs tremble.} {Fall back. Heal. Live.|This is how heroes die — or how they are made.}',
  '{The world tilts.|Your heart hammers against your ribs.} {One more blow and it ends.|You are close to the edge now.}',
  'Pain everywhere. {Your body begs you to run.|Death is very near.}',
];
export const DEATH: Pool = [
  'Darkness. {Then — slowly — the memory of warmth.|Then a voice, very far away.} {$world is not done with you yet.|Death, it seems, has refused you.}',
  'You fall. {The ground rushes up.|Silence.} {But your story is not over.|Something pulls you back.}',
];
export const DEATH_BY: Pool = [
  'You fall to $killer. {The last thing you see is its shadow over you.|Your blood darkens the ground.} {It will remember you. You will remember it.|This is not over.}',
];

export const FIRST_KILL: Pool = [
  'Your first $what falls. {You stand over it, breathing hard.|The silence after is very loud.} {Remember how this felt.|The world is a little more dangerous for knowing you.}',
  'The $what lies still. {First of many, perhaps.|You learn its weak points as you study the body.}',
];
export const BOSS_KILL: Pool = [
  '$name falls{, and the ground shakes|}. {Silence spreads outward like a ripple.|Somewhere a bird begins to sing again.} {They will tell this story in the taverns.|You did that.}',
  'With a final {roar|shudder|cry}, $name lies still. {Your hands shake.|You have earned a name of your own today.}',
];
export const NEMESIS_KILL: Pool = [
  '$name — your old enemy — falls at last. {The score is settled.|You have waited a long time for this.} {Its shadow will not follow you any more.|Even the wind seems to sigh with relief.}',
];

export const QUEST_OFFER: Pool = [
  '{A new task presents itself|Opportunity knocks}: $title. $summary',
  '$title — $summary',
];
export const QUEST_ACCEPT: Pool = ['You take up the task: $title. {May it end well.|The road begins.}', 'Accepted: $title.'];
export const QUEST_DONE: Pool = [
  '$title — done. {Word will spread.|You allow yourself a moment of pride.} $reward',
  'You have completed $title. $reward',
];
export const QUEST_FAILED: Pool = ['$title has failed. {Not every story ends well.|Some doors close forever.}', '{Too late.|It is over.} $title has failed.'];
export const QUEST_STEP: Pool = ['$objective — {done|complete}.', '{One step closer:|Progress:} $objective.'];

export const RECAP_OPEN: Pool = [
  '{When last we left you|Previously, in $world|Your story so far}...',
  '{You return to $world.|The world remembers you.} {Here is where things stand.|Recall what came before.}',
];

export const OMENS: Record<string, Pool> = {
  beast: [
    '{The birds have gone quiet.|A flock bursts from the trees and flees $dir.} {Something large moves out there.|The silence feels like held breath.}',
    'You find tracks — {fresh, deep, and too far apart|claw marks gouged into bark at head height}. {They lead $dir.|Whatever made them is hungry.}',
    'A distant {roar|howl|scream} echoes from the $dir. {Then nothing.|Then, closer, another.}',
  ],
  bandit: [
    'You catch a glint of metal {on a ridge|between the trees} to the $dir. {Then it is gone.|A signal?}',
    'A cold campfire, still warm at the heart. {Boot prints, several sets.|Someone has been watching this road.}',
    '{A crow-feather tied to a branch.|An arrow stuck in a post, fletched in black.} {A marker — bandits use them.|You are being warned. Or counted.}',
  ],
  storm: [
    'The air grows heavy and still. {The hairs on your arms rise.|Clouds pile up in the $dir like a dark wall.}',
    '{The wind changes, smelling of iron.|Animals seek shelter.} A storm is coming.',
  ],
  sky: [
    '{The stars seem restless tonight.|$moon wears a strange halo.} {Old folk would call it an omen.|Something is coming from above.}',
    'A single shooting star crosses the sky{, then another|}. {Make a wish.|Then the sky goes very still.}',
  ],
  nemesis: [
    '{An old scar itches.|You catch a familiar scent on the wind.} {$name is near. You know it in your bones.|Something that knows you is hunting.}',
    'Fresh kills, left where you would find them. {A message.|$name has not forgotten you.}',
  ],
  hunter: [
    'A rider asks after you at a crossroads, the travellers say{, describing your face very precisely|}. {Your crimes have a price.|Someone wants to collect.}',
    'You notice a figure {pacing you at a distance|studying a sheet of paper, then you}. {Bounty hunters?|Your past is catching up.}',
  ],
  gravity: [
    'Pebbles near your feet {twitch|lift for a heartbeat, then fall}. {The weight of the world is shifting nearby.|The $anomaly are stirring.}',
  ],
  eclipse: [
    'The light turns strange and copper-coloured. {Shadows sharpen.|Birds go to roost in the middle of the day.} {Something is crossing the sun.|The old tales speak of days like this.}',
  ],
};

export const ENCOUNTER: Record<string, Pool> = {
  beasts: [
    '{Movement|Eyes} in the $dir — {a pack of $what|$what, more than one}, {and they have your scent|closing in}!',
    '$what {burst from cover to the $dir|come at you from the $dir}! {Steel yourself.|Fight or run — choose now.}',
  ],
  beast: ['{A $what steps out to the $dir and fixes you with its eyes.|To the $dir, a $what lowers its head and charges!}'],
  boss: [
    'The ground trembles. To the $dir, $name rises{ — bigger than any beast has a right to be|, scarred and ancient}. {It has been waiting.|This one has a name for a reason.}',
    'A {bellow|shriek|roar} shakes the air. $name has come{, and it is hungry|}. {Stand your ground — or live to tell of running.|The real test begins.}',
  ],
  nemesis: [
    '$name. {Scarred where you marked it.|Bigger than you remember.} {It has come back for you.|It remembers you.} {End this.|This time, one of you stays down.}',
  ],
  bandits: [
    '{"Your purse or your life!"|A whistle — then figures with blades step onto the path.} {Bandits, $count of them, to the $dir.|An ambush!}',
    'Arrows hiss past from the $dir. {Bandits!|Brigands spring their trap.}',
  ],
  hunters: [
    '{"That\'s the one."|A voice calls your name — not kindly.} Bounty hunters {close from the $dir|have found you}. {Your crimes have come to collect.|Pay in coin, or in blood.}',
  ],
  merchant: [
    'A travelling merchant{\'s cart creaks| trundles} along from the $dir{, bells jingling|}. {"Fine wares! Fair prices! Mostly fair!"|They raise a hand in greeting.}',
    'A caravan appears to the $dir — {a merchant and their guards|a trader with a mule laden with goods}. {Perhaps they have something you need.|Trade is the other road to fortune.}',
  ],
  pilgrim: [
    'A pilgrim walks toward you from the $dir, {humming a hymn to $god|leaning on a tall staff}. {They look as if they have walked a very long way.|Perhaps they have news.}',
  ],
  wanderer: [
    'A lone traveller {approaches from the $dir|rests by the path ahead}. {They watch you with interest.|They seem to have stories to tell.}',
  ],
  stranger: [
    '{A familiar figure|$name} {waits by the path|steps out of the shadow} to the $dir. {"We meet again."|They give you a crooked smile.} {Fate keeps crossing your roads.|You were half expecting this.}',
  ],
};

export const SKY_EVENT: Record<string, Pool> = {
  aurora: [
    'Curtains of light ripple across the night sky{ — $leaf and violet and gold|}. {The old folk would say $creator is mending the world.|For a moment, everything is still and beautiful.}',
    'The night sky blooms with shimmering veils of light. {You stop and stare.|Even the beasts seem to pause.}',
  ],
  meteors: [
    'Stars begin to fall — {first one, then dozens, streaking across the sky|a shower of fire across the night}. {One burns brighter than the rest and comes down not far to the $dir.|A distant thud shakes the ground to the $dir.}',
  ],
  eclipse: [
    'The sun dims. {A black disc slides across it.|Darkness falls at midday.} {All around, beasts grow restless and bold.|In the eerie twilight, things stir that should sleep.}',
  ],
  gravity: [
    'The world shudders — {and suddenly you are lighter|and weight bleeds out of everything around you}. {Stones lift from the ground.|Water droplets hang in the air.} {A gravity tide! It will pass.|The $anomaly are pulsing.}',
    'The air thickens{ and your knees buckle|}. {Gravity surges.|Everything around you grows heavy.} {Brace yourself — it will pass.|The $anomaly have woken.}',
  ],
  tremor: ['The ground shakes. {Dust sifts from above.|Rock groans.} {Something deep below has turned over in its sleep.|Far below, something in $underworld stirs.}'],
};

export const NUDGE: Record<string, Pool> = {
  poi: [
    '{Something catches your eye|You notice a shape on the horizon} to the $dir{ — perhaps $name|}. {It might be worth a look.|Curiosity tugs at you.}',
    '{A faint path|An old trail} branches off toward the $dir. {Travellers speak of $name in that direction.|Where does it lead?}',
  ],
  site: ['Smoke rises to the $dir — {a settlement|people}. {$name, if your memory serves.|A warm meal, perhaps, and news.}'],
  shaft: [
    'A cold draught rises from the $dir, smelling of deep stone. {A great shaft opens there, plunging down toward $underworld.|The ground there falls away into darkness.}',
  ],
  cave: ['{A dark mouth in the rock|A cave entrance} yawns to the $dir. {Cool air breathes out of it.|Who knows how deep it goes?}'],
  island: ['High above to the $dir, {an island floats in the sky|land drifts against the clouds}. {Could you reach it?|$skyname beckons.}'],
  anomaly: ['To the $dir, {dust hangs in the air without falling|the light bends oddly}. {One of the $anomaly.|The weight of the world is strange there.}'],
  underworld: ['{Somewhere below your feet|Deep beneath this land} lies $underworld. {The shafts and caves are its doors.|Not everyone who goes down comes back — but some come back rich.}'],
};

export const RELIEF: Pool = [
  '{The danger has passed.|The world goes quiet again.} {Catch your breath.|Your heartbeat slows.}',
  '{For now, peace.|A moment of calm.} {Tend your wounds.|Listen to the wind.}',
];

export const LUCKY_FIND: Pool = [
  '{Half-hidden by roots|In the hollow of a tree|Beneath a loose stone}, you spot a {forgotten|weathered|cached} bundle to the $dir. {Someone\'s loss, your gain.|Fortune smiles.}',
];

export const BOUNTY: Pool = [
  'Word of your {crime|deed} spreads. {$power has put a price on your head: $amount coins.|Guards will remember your face; the price on your head is $amount coins.}',
  '{That was seen.|There were witnesses.} Your bounty with $power rises to $amount coins.',
];
export const HEROISM: Pool = [
  '{Word of your deed reaches $place.|The people of $place saw what you did.} {They will remember it.|Your name is spoken kindly there now.}',
];
export const VANDAL: Pool = [
  '{A shout of outrage.|Someone screams at you from a doorway.} {That was someone\'s home.|The owner will not forget this.}',
];

export const IDLE: Pool = [
  '{The world waits for you.|Time passes.} {The wind turns the pages of an invisible book.|Somewhere, a story is waiting to be found.}',
  '{You stand still for a while, listening.|A quiet moment.} $legend',
];

/** Short labels for creature roles in narration ("a pack of $what"). */
export const BEAST_FALLBACK = ['beasts', 'hunters of the wild', 'predators', 'shapes with teeth'];
