/**
 * Voice library: race- and personality-flavoured line banks shared by the
 * dialog system and NPC barks.
 *
 * Template language (see `expand`):
 *   {var}        substituted from LineVars; a template referencing a missing
 *                var is rejected and another template is tried instead.
 *   [a|b|c]      pick one alternative at random; alternatives may be empty
 *                ("[truly |]") and may nest ("[the [old|grey] mill|the well]").
 *                Alternatives whose vars are missing are skipped, so optional
 *                detail can live inside brackets ("[ near {place}|]").
 *
 * Selection: `say(key)` draws from a child bank (children), the speaker's
 * race bank (~65% when it has the key) or the generic bank, then applies light
 * probabilistic decorators for race voice (gruff dwarves, formal elves, twitchy
 * goblins...) and personality (hedging neurotics, curt grumps, exuberant
 * extraverts). Output never contains unresolved placeholders.
 */
import type { Rng } from '../core/rng';
import type { RaceId } from '../humanoid/types';
import type { AgeStage, NpcJob, NpcTraits } from '../npc/types';

export interface VoiceSpeaker {
  race: RaceId;
  traits: NpcTraits;
  job: NpcJob;
  ageStage?: AgeStage;
  gender?: number;
}

export type LineVars = Record<string, string | number | undefined>;

type Bank = Record<string, string[]>;

// ============================================================== generic bank

const GENERIC: Bank = {
  // ---------------------------------------------------------------- greetings
  'greet.first': [
    "[Hello|Well met|Greetings], {addr}. I don't believe we've met. I'm {name}.",
    "A new face in {place}! [Welcome|Be welcome], {addr}.",
    "[Hm,|Oh,] you're not from around here. Name's {name}.",
    "Haven't seen you before, {addr}. What brings you to {place}?",
    "Well now, a stranger. [Doesn't happen every day|We get few of those]. I'm {name}, the {job}.",
    "[Greetings|Good day], traveller. You look like you've walked a long road.",
    "Welcome to {place}, {addr}. Mind the mud and the dogs.",
  ],
  'greet.again': [
    "[Ah|Oh], {player}. Back again?",
    "{player}! [Good to see you|I was wondering if you'd return].",
    "You again. [What is it this time?|What can I do for you?]",
    "Back in {place}, {addr}? [The road brings everyone home eventually.|Welcome back.]",
    "Hello again, {player}. [Still in one piece, I see.|Keeping well?]",
  ],
  'greet.hostile': [
    "You've got some nerve showing your face here.",
    "Keep your distance. I remember what you did.",
    "What do you want? Make it quick and then get out of my sight.",
    "[Speak|Talk], and keep your hands where I can see them.",
    "I've nothing to say to the likes of you.",
    "One more step and I call the guard.",
  ],
  'greet.cold': [
    "[Hm.|Yes?] What is it?",
    "Make it brief, {addr}. I have things to do.",
    "Oh. It's you.",
    "If you're selling something, I'm not buying.",
    "[What do you want?|State your business.]",
    "I suppose you want something.",
  ],
  'greet.neutral': [
    "[Hello|Good day|Greetings], {addr}.",
    "Can I help you with something?",
    "[Yes?|Hm?] Something I can do for you?",
    "{time} to you, {addr}.",
    "[Well met|Hail], {addr}. What's on your mind?",
    "Mm? Oh, hello there.",
    "[Need something|Looking for someone], {addr}?",
  ],
  'greet.warm': [
    "[Ah|Oh], {player}! Good to see you.",
    "[Hello|Hail], {player}! Always a pleasure.",
    "There's a friendly face. How fare you, {addr}?",
    "{player}! Come, sit a moment. What news?",
    "Well met, {player}. You've been a help to us.",
    "[Ha!|Oh!] {player}, I was just thinking about you.",
  ],
  'greet.friend': [
    "{player}! [My friend!|There you are!] Come here!",
    "By all that's good, {player}! You're a sight for sore eyes.",
    "My dear {player}! Whatever you need, just ask.",
    "{player}! I'd hoped you'd come by. Sit, sit.",
    "[Old friend|Friend of {place}]! Tell me everything.",
  ],
  'greet.busy': [
    "[Mm,|Ah,] can't stop working, but I can talk.",
    "Busy, busy. Speak while I work, {addr}.",
    "You caught me in the middle of things. What is it?",
    "[Make it quick|Talk fast], the work won't do itself.",
    "Hands are full, ears are free. Go on.",
  ],
  'greet.sleepy': [
    "[Hnn...|Mmh...] what? It's the middle of the night!",
    "Do you know what hour it is, {addr}?",
    "[Yawn.|Ugh.] Can't this wait till morning?",
    "I was asleep. This had better be important.",
    "Wha... who's there? Oh. You.",
  ],
  'greet.afraid': [
    "[Quiet!|Shh!] Something's out there.",
    "Not now, {addr}, it's not safe!",
    "Did you see it? Tell me you saw it too.",
    "Please, keep your voice down. Something's prowling.",
    "Stay close... I don't like the feel of this.",
  ],
  'greet.mourning': [
    "[Forgive me|Pardon me], {addr}. It's been a hard few days.",
    "Oh... hello. I'm not much company right now.",
    "We buried one of ours. The whole of {place} is grieving.",
    "I keep expecting to see them walk through that door.",
  ],
  'greet.drunk': [
    "Heyyy! {addr}! Have you... have you met me? I'm {name}!",
    "[Hic.|Hah!] Another round for my new friend!",
    "You've got two faces. No, wait. That's me.",
    "Sit down, sit down! The ale's terrible and I love it!",
  ],

  'time.morning': ["Good morning", "Fair morning", "A bright morning", "Early morning greetings", "Morning"],
  'time.day': ["Good day", "Fair day", "Good afternoon", "Fine day"],
  'time.evening': ["Good evening", "Fair evening", "Pleasant evening", "Evening"],
  'time.night': ["Quiet night", "Late hour greetings", "Dark night", "Good night"],

  'bye.cold': [
    "[Fine.|Good.] Off with you.",
    "Don't come back soon.",
    "We're done here.",
    "Go on, then.",
    "[Hmph.|Right.] Leave me be.",
  ],
  'bye.neutral': [
    "[Farewell|Safe travels|Take care], {addr}.",
    "Mind yourself out there.",
    "Until next time.",
    "[Go well|Walk safe], {addr}.",
    "Good luck to you.",
    "May the road be kind.",
  ],
  'bye.warm': [
    "Come back soon, {player}! You're always welcome here.",
    "Take care of yourself, {player}. I mean it.",
    "Safe roads, my friend. {place} won't be the same without you.",
    "Off you go then. And don't do anything I wouldn't!",
    "Farewell, {player}. Bring me a story next time.",
  ],

  // ---------------------------------------------------------------- self
  'self.intro': [
    "I'm {name}, {job} of {place}.",
    "Name's {name}. I'm the {job} [around here|in {place}].",
    "{name}, at your service. [I work as a|I'm the local] {job}.",
    "They call me {name}. I've been {job} in {place} for [years|longer than I care to count].",
    "{name}. {job}. That's about all there is to say.",
  ],
  'self.job.farmer': [
    "I work the fields. Up before the sun, down after it.",
    "Barley, beans and a stubborn ox. That's my life, and it's not a bad one.",
    "Every harvest is a gamble with the sky. So far, I've mostly won.",
    "The soil here is [good|stubborn|thin], but it feeds us. Mostly.",
  ],
  'self.job.smith': [
    "I keep the forge burning. Nails, hinges, blades. Whatever's needed.",
    "Iron listens if you strike it right. People, less so.",
    "Every plough and sword in {place} has passed under my hammer.",
    "Hot work, honest work. Give me good ore and I'll give you good steel.",
  ],
  'self.job.merchant': [
    "I buy low and sell fair. Mostly fair.",
    "Goods come in from the roads, coin goes out. I sit in the middle and smile.",
    "If it can be carried, I can sell it. If it can't, I know someone who can.",
    "Trade is the blood of {place}. I'm one of the veins.",
  ],
  'self.job.innkeeper': [
    "I run the inn. Ale, stew, a bed, and all the gossip you can swallow.",
    "Everyone ends up at my tables sooner or later. Kings and beggars alike.",
    "Keep your boots off the benches and we'll get along.",
  ],
  'self.job.guard': [
    "I keep the peace in {place}. Or try to.",
    "Walls, gates, and drunks. I watch all three.",
    "My job is to make sure nothing bad gets in. Or out.",
    "Long watches, cold nights. But {place} sleeps safe because of us.",
  ],
  'self.job.priest': [
    "I tend the shrine and the souls who come to it.",
    "I speak for {deity}, when {deity} has something to say.",
    "Births, burials, blessings. The gods keep me busy.",
    "Faith is a lantern. I just keep the wick trimmed.",
  ],
  'self.job.hunter': [
    "I track game in the wilds. Meat for the pot, hides for the tanner.",
    "The forest talks if you know how to listen. Mostly it says 'run'.",
    "I've followed tracks from here to places without names.",
  ],
  'self.job.scholar': [
    "I study. Old texts, older ruins, and the occasional strange stone.",
    "Knowledge is scattered across the land like seeds. I gather them.",
    "There's a pattern to the ruins out there. I mean to find it.",
  ],
  'self.job.mage': [
    "I practise the arts. Carefully. Mostly carefully.",
    "Magic is a river. I've learned to swim in it without drowning. Usually.",
    "The weave of the world is thin in places. I mend it, and sometimes pull it.",
  ],
  'self.job.miner': [
    "I dig. Ore, stone, the odd gem if the mountain's kind.",
    "Down in the dark, the rock tells you its moods. You'd best listen.",
    "Every vein runs out eventually. Then you find the next one.",
  ],
  'self.job.woodcutter': [
    "I fell trees. Somebody has to keep the hearths of {place} burning.",
    "The axe and I have an understanding. The trees, less so.",
    "I always thank a tree before I cut it. Old habit.",
  ],
  'self.job.fisher': [
    "I fish. Nets in the morning, mending in the evening.",
    "The water gives and the water takes. Today it gave.",
    "Ask me about the one that got away. I've got hours.",
  ],
  'self.job.healer': [
    "I mend what's broken. Bones, fevers, sometimes hearts.",
    "Herbs, poultices, and a steady hand. That's healing.",
    "Bring me your wounds and I'll bring you back on your feet.",
  ],
  'self.job.bard': [
    "I sing for my supper. Tonight, maybe for yours too.",
    "Every place has a song. I collect them.",
    "Give me a lute and an audience and I'll give you a legend.",
  ],
  'self.job.child': [
    "I help mum and dad! And I play. Mostly I play.",
    "I'm going to be a hero when I'm big!",
    "I know all the best hiding spots in {place}. Don't tell!",
  ],
  'self.job.elder': [
    "I'm old, and I remember. That counts for something here.",
    "Folk come to me for advice. Sometimes they even take it.",
    "I've seen {place} grow from a handful of roofs. I'll see it a while longer.",
  ],
  'self.job.noble': [
    "I oversee the affairs of {place}. Someone of breeding must.",
    "My family has held these lands for generations.",
    "Decisions, petitions, disputes. Rule is mostly listening to complaints.",
  ],
  'self.job.beggar': [
    "I get by. A coin here, a crust there.",
    "Once I had a trade. Now I have a corner and a cup.",
    "Spare a coin? The gods notice generosity, they say.",
  ],
  'self.job.thief': [
    "Me? I... do odd jobs. Deliveries, mostly. Very discreet deliveries.",
    "I'm in the business of finding things. Things people lose. Sometimes before they know it.",
    "Let's say I help goods find new homes.",
    "Work? Bit of this, bit of that. Mostly that.",
  ],
  'self.job.bandit': [
    "I take what the road offers. Today the road offered you.",
    "Lords tax you with ink. We tax you with steel. Same thing.",
    "Free folk of the wilds, that's us.",
  ],
  'self.job.adventurer': [
    "I go where the maps get vague and the coin gets good.",
    "Ruins, beasts, curses. If it pays, I'm interested.",
    "Every scar's a story. Pick one.",
  ],
  'self.job.pilgrim': [
    "I walk the holy road to the shrines. One step at a time.",
    "I made a vow. The road keeps it for me.",
    "My feet ache, but my heart is light.",
  ],
  'self.job.herder': [
    "I mind the flocks. They mind nobody.",
    "Sheep, goats, the odd stubborn mule. Good company, mostly.",
    "Wolves keep me awake at night. The flock keeps me busy by day.",
  ],
  'self.job.cook': [
    "I feed {place}. Stews, breads, and pies when I'm feeling generous.",
    "A good meal mends more than a healer ever could.",
    "Taste this. No, really. Taste it.",
  ],
  'self.job.tailor': [
    "Needle and thread. I clothe half of {place}.",
    "I can tell a lot about someone from their hems. Yours have seen roads.",
    "A good coat lasts a lifetime. A bad one, a winter.",
  ],
  'self.job.alchemist': [
    "I brew remedies and reagents. Don't touch the green ones.",
    "Everything is a mixture. Getting it right is the trick.",
    "Some of my potions heal. Some... are works in progress.",
  ],
  'self.job.carpenter': [
    "I build. Roofs, carts, cradles and coffins.",
    "Measure twice, cut once. Words to live by.",
    "Half the beams in {place} were shaped by my hands.",
  ],
  'self.job.mason': [
    "I work stone. Walls, wells, foundations. Things that last.",
    "Stone remembers every blow. I make sure they're good ones.",
    "Long after we're gone, my walls will still be standing.",
  ],

  'self.family.spouse': [
    "My [partner|other half], {spouse}, keeps me honest.",
    "{spouse} and I have shared a roof for many years now.",
    "I'd be lost without {spouse}. Don't tell them I said so.",
  ],
  'self.family.children': [
    "I've {children}. They're the reason I get up in the morning.",
    "{children}. Loud, hungry, and wonderful.",
    "My little ones? {children}. They keep me young and grey at once.",
  ],
  'self.family.none': [
    "No family to speak of. Just me and the work.",
    "Never married. The road of life went another way.",
    "It's just me. Quieter that way.",
  ],
  'self.family.widowed': [
    "I had {spouse}. Once. The gods took them too soon.",
    "{spouse} is gone now. I still set two cups out some mornings.",
    "I lost {spouse}. Some days are harder than others.",
  ],

  'self.mood.happy': [
    "[Honestly?|Truth be told,] I'm in fine spirits today.",
    "Life's good, {addr}. Can't complain.",
    "The sun's out and my belly's full. What more is there?",
  ],
  'self.mood.sad': [
    "I've been better, if I'm honest.",
    "Some days the world feels heavier than others.",
    "Don't mind me. Just one of those days.",
  ],
  'self.mood.angry': [
    "I'm in a foul mood. Don't push me.",
    "Everything is going wrong today, and I mean everything.",
    "If one more person crosses me today...",
  ],
  'self.mood.afraid': [
    "I can't shake this feeling that something terrible is coming.",
    "I'm scared, {addr}. There, I said it.",
    "Every sound at night makes me jump these days.",
  ],
  'self.mood.content': [
    "Can't complain. Wouldn't help if I did.",
    "Days come and go. This one's fine.",
    "I'm well enough. Thank you for asking.",
  ],

  'self.need.hunger': [
    "I'm starving, truth be told. Haven't eaten since dawn.",
    "My stomach's been growling all day.",
    "I'd trade my boots for a hot meal right now.",
  ],
  'self.need.energy': [
    "I'm dead on my feet. Need sleep.",
    "So tired I could nap standing up.",
    "Long day. Longer night ahead, I fear.",
  ],
  'self.need.social': [
    "It's been a while since I had a proper chat. Thank you for this.",
    "Lonely work, mine. Good to hear another voice.",
    "I miss the company of friends.",
  ],
  'self.need.fun': [
    "All work and no play. I need a festival.",
    "When was the last time I laughed? I can't remember.",
    "Gods, I'm bored. Tell me something interesting.",
  ],
  'self.need.safety': [
    "I don't feel safe here anymore.",
    "Something's out there. I lock my door twice now.",
    "Every night I wonder if the walls will hold.",
  ],
  'self.need.wealth': [
    "Coin's tight. Tighter than it's ever been.",
    "If business doesn't pick up, I don't know what I'll do.",
    "I owe more than I own these days.",
  ],
  'self.need.faith': [
    "I haven't been to the shrine in too long. I feel it.",
    "I need to pray. Something in me feels unmoored.",
    "The gods feel far away lately.",
  ],

  // ---------------------------------------------------------------- place
  'place.intro': [
    "This is {place}. [Not much, but it's ours.|Home, for better or worse.]",
    "{place}. Quiet, mostly. Folk keep to their own.",
    "Welcome to {place}. We're a {size} of honest folk.",
    "{place} has stood here longer than anyone remembers.",
  ],
  'place.size.hamlet': [
    "We're barely a hamlet. A few roofs, a few families.",
    "Small place. Everyone knows everyone's business.",
    "Blink and you'd miss us. That's how we like it.",
  ],
  'place.size.village': [
    "A proper village. Market days, a shrine, the lot.",
    "Big enough to have gossip, small enough that it travels fast.",
    "We're a village of good folk. Mostly.",
  ],
  'place.size.town': [
    "A busy town. Traders come from all over.",
    "{place} is growing every year. New faces, new trouble.",
    "There's always something happening in a town this size.",
  ],
  'place.size.city': [
    "A city! Streets you could get lost in for days.",
    "{place} never sleeps. Somebody's always awake, scheming or singing.",
    "The greatest city in these lands, if you ask anyone born here.",
  ],
  'place.biome': [
    "The {biome} around here can be beautiful. And deadly.",
    "You get used to the {biome}. Mostly.",
    "Living in the {biome} teaches you respect.",
  ],
  'place.leader': [
    "{leader} keeps order here. Fairly, most would say.",
    "If you want something done officially, talk to {leader}.",
    "{leader} speaks for {place}. For good or ill.",
  ],
  'place.walls': [
    "Our walls have kept us safe through worse than you can imagine.",
    "The walls are the pride of {place}. Took three generations to build.",
    "Walls make folk feel safe. Whether they are is another matter.",
  ],
  'place.poor': [
    "Times are lean. Harvests poor, coin scarce.",
    "We don't have much, but we share what we have.",
    "{place} has seen better days.",
  ],
  'place.rich': [
    "Trade's been good to us. You can see it in the roofs.",
    "{place} is doing well. Envied, even.",
    "Coin flows here. Not always to the right people, mind.",
  ],
  'place.faith': [
    "Most folk here honour {deity}. The shrine's never empty.",
    "{deity}, {deityEpithet}, watches over {place}. Or so we hope.",
    "We keep the old rites for {deity}. It's served us well.",
  ],
  'place.mixed': [
    "We've {race2} folk living among us too. Took some getting used to.",
    "Some {race2} families settled here. Different customs, same troubles.",
    "Half the market speaks with a {race2} accent these days.",
  ],

  // ---------------------------------------------------------------- people
  'people.love': [
    "{person}? My {relation}. I'd walk through fire for them.",
    "Nobody better in all of {place} than {person}.",
    "{person} is the best thing in my life.",
  ],
  'people.like': [
    "{person}'s a good sort. You can trust them.",
    "I like {person}. Always has a kind word.",
    "{person}? Decent. We get along.",
  ],
  'people.neutral': [
    "{person}? I know them a bit. Nothing to say either way.",
    "We nod in the street, {person} and I. That's about it.",
    "{person} keeps to themselves, mostly.",
  ],
  'people.dislike': [
    "{person}. Hmph. Don't get me started.",
    "I'd rather not talk about {person}.",
    "{person} and I don't see eye to eye.",
  ],
  'people.hate': [
    "{person}? Don't say that name in front of me.",
    "If {person} fell down a well, I wouldn't throw a rope.",
    "{person} is a snake, and one day everyone will see it.",
  ],
  'people.unknown': [
    "Never heard of them.",
    "Can't say I know anyone by that name.",
    "Doesn't ring a bell. Try the inn.",
  ],
  'people.dead': [
    "{person}... is gone. Dead. We still don't talk about it much.",
    "{person} died. The gods keep them.",
    "You didn't hear? {person} is dead.",
  ],

  // ---------------------------------------------------------------- rumors
  'rumor.intro': [
    "Rumors? [Well...|Hm, let me think.]",
    "I hear things. Lean in.",
    "You didn't hear this from me, but...",
    "There's talk, [sure|always].",
  ],
  'rumor.none': [
    "Nothing worth repeating, I'm afraid.",
    "Quiet lately. Too quiet, maybe.",
    "Can't think of anything. Ask at the inn.",
    "No news. And no news is good news, they say.",
  ],
  'rumor.memory': [
    "They say {fact}.",
    "Word is {fact}.",
    "I saw it myself: {fact}.",
    "You know {fact}? Strange times.",
  ],
  'rumor.heard': [
    "Someone told me {fact}. Make of that what you will.",
    "I heard [at the inn|on the road|in the market] that {fact}.",
    "Folk are whispering that {fact}.",
    "Can't swear to it, but they say {fact}.",
  ],
  'rumor.poi.ruin': [
    "There's an old ruin {dist} to the {dir}. Folk say it's haunted.",
    "Crumbling stones {dist} {dir} of here. Nobody goes there anymore.",
    "Ruins {dir}, {dist} out. Treasure, if you believe the drunks.",
  ],
  'rumor.poi.shrine': [
    "There's a forgotten shrine {dist} to the {dir}. Some pray there still.",
    "A shrine lies {dir}, {dist} from here. The air feels different near it.",
  ],
  'rumor.poi.camp': [
    "Smoke rises {dist} to the {dir}. A camp. Bandits, likely.",
    "Watch the road {dir}. There's a camp {dist} out, and they're not friendly.",
    "Cutthroats have made camp {dist} {dir} of here.",
  ],
  'rumor.poi.lair': [
    "Something lairs {dist} to the {dir}. Bones everywhere around it.",
    "Don't go {dir}. There's a den {dist} out, and whatever lives there is hungry.",
  ],
  'rumor.poi.grove': [
    "There's a grove {dist} {dir}. Trees older than kingdoms.",
    "A strange grove lies {dir}, {dist} out. Quiet as a held breath.",
  ],
  'rumor.poi.monolith': [
    "A great standing stone {dist} to the {dir}. Hums at night, some say.",
    "There's a monolith {dir} of here, {dist}. Nobody knows who raised it.",
  ],
  'rumor.poi.tower': [
    "An old tower stands {dist} {dir}. Lights in the window, sometimes.",
    "Some mage's tower, {dir}, {dist} out. Abandoned. Supposedly.",
  ],
  'rumor.poi.battlefield': [
    "There was a battle {dist} to the {dir}, long ago. The ground still gives up bones.",
    "Old battlefield {dir} of here, {dist}. Rusted blades everywhere.",
  ],
  'rumor.poi.crashsite': [
    "Something fell from the sky {dist} to the {dir}. Scorched earth all around.",
    "A star came down {dir} of here, {dist} out. Strange stones there now.",
  ],
  'rumor.poi.well': [
    "There's an old well {dist} {dir}. Water's sweet, but folk hear voices in it.",
    "A lone well stands {dir}, {dist} out. Wishes made there come true, they say.",
  ],
  'rumor.poi.wayshrine': [
    "A wayshrine stands {dist} to the {dir}. Travellers leave offerings.",
    "There's a little roadside shrine {dir}, {dist}. Good place to rest.",
  ],
  'rumor.poi.obelisk': [
    "A black obelisk stands {dist} to the {dir}. Covered in writing nobody can read.",
    "There's an obelisk {dir} of here, {dist}. Birds won't land on it.",
  ],
  'rumor.creature': [
    "Folk have seen a {creature} prowling {dir} of here.",
    "Watch out for the {creature}. They've been bolder lately.",
    "A {creature} took a goat last week. Bold as anything.",
    "If you see a {creature}, don't run. Or do. I forget which.",
  ],
  'rumor.site': [
    "{target} lies {dist} to the {dir}. Decent folk, mostly.",
    "Heard trouble's brewing in {target}, {dir} of here.",
    "Traders from {target} say business is booming there.",
    "Ever been to {target}? {dist} to the {dir}. Worth the walk.",
  ],
  'rumor.weather': [
    "The old knees say {weather} is coming.",
    "Smells like {weather}. Mark my words.",
    "Birds are flying low. {weather} on the way.",
  ],

  // ---------------------------------------------------------------- directions
  'dir.answer': [
    "{target}? Head {dir}, {dist}. Can't miss it.",
    "Go {dir}. {target} is {dist} that way.",
    "{target} lies {dist} to the {dir}. Follow the road if there is one.",
    "That's {dir} of here. {dist}, give or take.",
  ],
  'dir.unknown': [
    "No idea, {addr}. Never been.",
    "Can't help you there. Try someone who travels.",
    "That's beyond what I know, I'm afraid.",
  ],
  'dir.here': [
    "You're standing in it, {addr}!",
    "This is {target}. You've arrived.",
    "Look around. You've found it.",
  ],

  // ---------------------------------------------------------------- goals & quests
  'goal.pitch': [
    "If I'm honest, I need to {goal}. It's been weighing on me.",
    "What I really need is to {goal}.",
    "I've been trying to {goal}. Not going well.",
  ],
  'goal.none': [
    "Need? No, I'm doing all right.",
    "Nothing I can't handle myself, thank you.",
    "I'm fine. Really.",
  ],
  'goal.progress': [
    "Still working on it. I need to {goal}.",
    "Getting there. Slowly. Still have to {goal}.",
    "One step at a time. I still need to {goal}.",
  ],
  'quest.offer': [
    "Would you help me {goal}? I can offer {reward}.",
    "If you could {goal}, I'd pay {reward}. Fair?",
    "I need someone capable to {goal}. {reward} for your trouble.",
    "Help me {goal}, and {reward} is yours.",
  ],
  'quest.accepted': [
    "Thank you! You don't know what this means to me.",
    "Good. I knew I could count on you.",
    "Excellent. Come back when it's done.",
    "May the gods smile on you. Be careful.",
  ],
  'quest.declined': [
    "I understand. If you change your mind...",
    "Pity. I'll find another way.",
    "Fine. I'll manage. Somehow.",
  ],
  'quest.active': [
    "Have you done what I asked?",
    "Any news on that matter?",
    "Still waiting on you, {addr}.",
  ],
  'quest.thanks': [
    "You did it! I'm in your debt.",
    "Thank you, truly. {place} won't forget this.",
    "I won't forget this, {player}.",
    "Well done! Here, you've earned this.",
  ],
  'quest.failed': [
    "So it didn't work out. Can't be helped.",
    "Disappointing. But I don't blame you. Much.",
    "That's a blow. We'll have to find another way.",
  ],

  // ---------------------------------------------------------------- trade
  'trade.offer': [
    "Let's see what you've got, and what I've got.",
    "Have a look. Prices are fair. Mostly.",
    "Buying or selling? I do both.",
    "Best wares in {place}. Take your time.",
  ],
  'trade.refuse': [
    "I don't deal with your kind.",
    "Not interested. Go peddle elsewhere.",
    "My goods aren't for you.",
  ],
  'trade.closed': [
    "Shop's closed. Come back in the morning.",
    "Not at this hour. Come back when the sun's up.",
    "I'm off duty. Business hours, please.",
  ],

  // ---------------------------------------------------------------- skill checks
  'check.persuade.ok': [
    "Well... when you put it that way, how can I refuse?",
    "Fine. You've convinced me.",
    "You make a good point. All right.",
  ],
  'check.persuade.fail': [
    "Nice try. No.",
    "You'll have to do better than that.",
    "I don't think so.",
  ],
  'check.intimidate.ok': [
    "A-all right! No need for that!",
    "Fine, fine! Just... put that away.",
    "Easy! I'll tell you whatever you want.",
  ],
  'check.intimidate.fail': [
    "Is that supposed to scare me?",
    "Threaten me again and see what happens.",
    "Ha! I've faced worse than you before breakfast.",
  ],
  'check.barter.ok': [
    "You drive a hard bargain. Deal.",
    "Fine, fine. A better price, just for you.",
    "You'll ruin me. But all right.",
  ],
  'check.barter.fail': [
    "The price is the price.",
    "I've children to feed. No discount.",
    "Haggle all you like. It won't change a thing.",
  ],
  'check.lore.ok': [
    "You know your history! Then you'll appreciate this...",
    "Ah, a fellow scholar of the old ways. Listen...",
    "You've read the old tales. Then you'll understand.",
  ],
  'check.lore.fail': [
    "That's... not quite how it went.",
    "You've got your stories muddled.",
    "Hm. Someone told you wrong.",
  ],

  // ---------------------------------------------------------------- social
  'compliment.ok': [
    "Oh! Well, thank you. That's kind of you.",
    "You flatter me, {addr}. Go on.",
    "That's the nicest thing I've heard all week.",
  ],
  'compliment.flat': [
    "Hm. Thank you, I suppose.",
    "Words are cheap.",
    "If you say so.",
  ],
  'compliment.suspicious': [
    "What do you want from me?",
    "Flattery. What are you after?",
    "Sweet words usually come before a sour request.",
  ],
  'insult.mild': [
    "Charming. Was that meant to hurt?",
    "Well, aren't you pleasant.",
    "I've heard worse from my own mother.",
  ],
  'insult.angry': [
    "Say that again. I dare you.",
    "Get out of my sight before I do something we'll both regret.",
    "How dare you!",
  ],
  'insult.afraid': [
    "I... I don't want any trouble.",
    "Please, just leave me alone.",
    "I didn't mean anything by it, honest!",
  ],
  'insult.laugh': [
    "Ha! That's the best you've got?",
    "Oh, you're funny. Truly.",
    "Hah! I like you. Rude, but I like you.",
  ],

  // ---------------------------------------------------------------- misc
  'confused': [
    "I'm sorry, I don't follow.",
    "What's that now?",
    "You've lost me, {addr}.",
    "Come again? I didn't catch your meaning.",
  ],
  'smalltalk': [
    "Strange weather we're having.",
    "Did you hear the dogs howling last night?",
    "Market's been busy lately.",
    "They say the roads are getting worse.",
    "I could use a holiday. A long one.",
  ],
  'secret.reveal': [
    "Between you and me... {fact}.",
    "I've never told anyone this, but {fact}.",
    "Swear you won't repeat it. {fact}.",
  ],
  'refuse.talk': [
    "I've nothing to say to you.",
    "Leave me alone.",
    "Not now. Not ever, maybe.",
  ],
  'thanks': [
    "Thank you, {addr}.",
    "That's kind of you.",
    "Much obliged.",
    "I won't forget it.",
  ],
  'apology.accept': [
    "Well... all right. Let's put it behind us.",
    "Apology accepted. Don't make me regret it.",
    "Fine. Water under the bridge.",
  ],
  'apology.reject': [
    "Sorry doesn't fix it.",
    "Words. Just words.",
    "You'll have to do more than apologize.",
  ],

  // ---------------------------------------------------------------- barks
  'bark.idle': [
    "[Hm.|Mm.] Nice day for it.",
    "Wonder what's for supper.",
    "Where did I leave that thing...",
    "Same old, same old.",
    "Could use a sit-down.",
    "Gods, my back.",
    "Another day in {place}.",
    "Is it going to rain?",
  ],
  'bark.work': [
    "Back to it.",
    "This won't finish itself.",
    "Almost done. Almost.",
    "Steady hands, steady work.",
    "One more, then a break.",
    "Who keeps moving my tools?",
  ],
  'bark.greetPass': [
    "[Morning|Hello|Evening].",
    "Hail, {addr}.",
    "Well met.",
    "Safe roads.",
    "Ah, hello there.",
    "Nice to see you.",
  ],
  'bark.weather.rain': [
    "Rain again. Wonderful.",
    "Good for the crops, I suppose.",
    "Soaked to the bone.",
    "Inside, quick!",
  ],
  'bark.weather.snow': [
    "Brr! Snow!",
    "My fingers are frozen.",
    "Winter's teeth today.",
    "Mind the ice!",
  ],
  'bark.weather.storm': [
    "Storm's coming! Get inside!",
    "Thunder! Batten everything down!",
    "The sky's angry today.",
  ],
  'bark.weather.fog': [
    "Can't see a thing in this fog.",
    "Fog like this hides things.",
    "Stay close to the lanterns.",
  ],
  'bark.night': [
    "Late. Should be abed.",
    "Quiet night. Good.",
    "The stars are out.",
    "Mind the dark corners.",
  ],
  'bark.morning': [
    "Another morning.",
    "Up and at it.",
    "Fresh day, fresh start.",
    "Gods, I need something hot.",
  ],
  'bark.evening': [
    "Long day. Done now.",
    "Time for a drink.",
    "Sun's going down.",
    "Supper and bed, that's me.",
  ],
  'bark.danger': [
    "Something's out there!",
    "Did you hear that?",
    "Look out!",
    "Stay back!",
  ],
  'bark.flee': [
    "Run! Run!",
    "Help! Somebody help!",
    "Get away from me!",
    "Gods save me!",
  ],
  'bark.fight': [
    "Come on, then!",
    "For {place}!",
    "You'll regret this!",
    "Stand and fight!",
  ],
  'bark.guard.halt': [
    "Halt! Stay where you are!",
    "Stop in the name of {place}!",
    "Don't move, criminal!",
    "That's far enough!",
  ],
  'bark.guard.patrol': [
    "All quiet.",
    "Keep moving, nothing to see.",
    "Eyes open.",
    "Watch your step.",
    "No trouble today, eh?",
  ],
  'bark.guard.warn': [
    "Watch yourself.",
    "I've got my eye on you.",
    "No trouble here, understand?",
    "Keep your weapons sheathed.",
  ],
  'bark.mourn': [
    "Why them? Why?",
    "I miss them so much.",
    "Rest well, wherever you are.",
    "It should have been me.",
  ],
  'bark.gossip': [
    "Did you hear? {fact}!",
    "They say {fact}.",
    "You won't believe it: {fact}.",
  ],
  'bark.tavern': [
    "Another round!",
    "Ha! Good one!",
    "To {place}!",
    "Who's paying for this?",
    "Sing us another!",
  ],
  'bark.pray': [
    "{deity}, watch over us.",
    "Grant us strength, {deity}.",
    "Blessed be {deity}.",
    "Hear me, {deity}.",
  ],
  'bark.market': [
    "Fresh goods! Fresh goods!",
    "Best prices in {place}!",
    "Come, have a look!",
    "Two for one, today only!",
  ],
  'bark.child': [
    "Catch me if you can!",
    "You're it!",
    "I'm a fearsome knight!",
    "Mum! Mum, look!",
  ],
  'bark.sleepy': [
    "*yawn*",
    "So tired...",
    "Need my bed.",
  ],
  'bark.hungry': [
    "My stomach's growling.",
    "Is it supper yet?",
    "Starving.",
  ],
  'bark.crime': [
    "Thief! Stop, thief!",
    "Guards! Guards!",
    "Did you see that?",
    "Criminal!",
  ],
  'bark.travel': [
    "Long road ahead.",
    "Keep walking.",
    "Not far now.",
    "My feet ache.",
  ],
  'bark.bandit': [
    "Your coin or your life!",
    "Nobody passes for free.",
    "Get 'em!",
    "Fresh meat on the road!",
  ],
  'bark.bandit.taunt': [
    "Run while you can!",
    "Look at this one, lads!",
    "That all you got?",
    "Easy pickings!",
  ],
  'bark.caravan': [
    "Keep the wagons moving!",
    "Watch the cargo!",
    "Eyes on the treeline.",
    "Steady, steady.",
  ],
  'bark.courtship': [
    "Do you think {person} likes me?",
    "I'll pick flowers for {person}.",
    "{person} smiled at me today!",
  ],
  'bark.rival': [
    "{person} again. Insufferable.",
    "I'll show {person}.",
    "{person} thinks they're better than me.",
  ],
  'bark.debt': [
    "{person} still owes me.",
    "I need to pay {person} back...",
    "Money, money, money.",
  ],
  'bark.rebuild': [
    "We'll build it back better.",
    "Hand me that beam.",
    "Stone by stone.",
  ],
  'bark.hunt': [
    "Fresh tracks.",
    "Quiet now. Downwind.",
    "Something big came through here.",
  ],
  'bark.study': [
    "Fascinating...",
    "If this is right, then...",
    "I need more notes.",
  ],
  'bark.victory': [
    "Ha! Got it!",
    "That's the end of that!",
    "Victory!",
  ],
  'bark.hurt': [
    "Argh!",
    "That hurts!",
    "I'm bleeding!",
  ],
  'bark.thief': [
    "Nobody's watching...",
    "Easy does it...",
    "Shiny.",
  ],
};

// ============================================================== race banks

const RACE: Partial<Record<RaceId, Bank>> = {
  human: {
    'greet.first': [
      "[Hail|Well met], {addr}. You've the dust of the road on you. I'm {name}.",
      "A stranger in {place}? Mind the toll on the bridge. Joking. I'm {name}.",
    ],
    'greet.neutral': ["[Morning|Afternoon|Evening], {addr}.", "Something you need, {addr}?"],
    'greet.warm': ["{player}! Good to see a friend.", "Ha! {player}! How's the road been?"],
    'greet.hostile': ["You. Get out of {place} before I lose my temper."],
    'bye.neutral': ["Gods keep you, {addr}.", "Safe road."],
    'bye.warm': ["Go with the gods, {player}. Come back to us."],
    'insult.angry': ["Mind your tongue, or I'll mind it for you."],
    'compliment.ok': ["Ha! You're a charmer, {addr}."],
    'self.intro': ["{name}. Born and raised in {place}. {job} by trade."],
    'place.intro': ["{place}. Honest work, cold ale, and the occasional fistfight."],
    'rumor.intro': ["Well, the inn's been buzzing..."],
    'quest.offer': ["Look, I'll be plain. I need to {goal}. There's {reward} in it for you."],
    'bark.idle': ["Taxes again this season. Typical.", "Need to fix that fence."],
    'bark.tavern': ["Barkeep! Another!", "Who spilled my ale?"],
    'bark.work': ["Honest work for honest coin."],
    'greet.cold': ["What?", "Busy. Talk."],
    'bye.cold': ["Off you go."],
    'insult.mild': ["Takes all kinds, I suppose."],
    'bark.greetPass': ["Gods' day to you."],
    'rumor.none': ["Quiet as a churchyard lately."],
  },
  elf: {
    'greet.first': [
      "The leaves whispered of a newcomer. I am {name}. Be welcome in {place}.",
      "Greetings, {addr}. You walk loudly, but not unkindly. I am {name}.",
    ],
    'greet.neutral': ["Be welcome, {addr}.", "The stars keep you, {addr}.", "Peace upon you."],
    'greet.cold': ["You may speak. Briefly.", "Your presence is noted."],
    'greet.warm': ["{player}. The grove rejoices at your return.", "Well met under the boughs, {player}."],
    'greet.friend': ["{player}, friend of the old trees. My heart lifts to see you."],
    'greet.hostile': ["You have worn out your welcome, as the axe wears out the oak.", "Leave. The forest remembers your deeds."],
    'bye.neutral': ["May your path be green.", "Walk in starlight, {addr}."],
    'bye.warm': ["Until the leaves turn again, {player}.", "Go gently. We shall meet beneath kinder skies."],
    'bye.cold': ["Go. And tread lightly."],
    'insult.angry': ["Your words are as brief and crude as your lifespan.", "I will remember that for a century."],
    'insult.mild': ["How very... mortal of you."],
    'compliment.ok': ["Graciously spoken. You honour me."],
    'compliment.flat': ["Words are wind through branches."],
    'self.intro': ["I am {name}. I have tended {place} as {job} for many of your lifetimes."],
    'place.intro': ["{place}. Our ancestors sang its first stones into place."],
    'rumor.intro': ["The wind carries many voices. Hear one of them."],
    'quest.offer': ["There is a task: to {goal}. Accept it, and {reward} shall be yours."],
    'bark.idle': ["The bark of this tree is older than your kingdoms.", "Listen. The leaves are speaking."],
    'bark.pray': ["{deity}, hear the song of your children."],
    'bark.night': ["The stars are singing tonight."],
    'bark.greetPass': ["Peace, traveller.", "Star-blessed day."],
    'bark.danger': ["Shadows move among the trees!"],
  },
  dwarf: {
    'greet.first': [
      "Hmph. A new face. I'm {name}, {job}. Don't touch anything.",
      "Stranger in {place}, eh? Name's {name}. State your business.",
    ],
    'greet.neutral': ["Aye?", "Well? Out with it.", "Stone and steel, {addr}."],
    'greet.cold': ["What. Spit it out.", "Hmph. You."],
    'greet.warm': ["{player}! Good to see ye, lad. Or lass. Whichever.", "Ha! {player}! Pull up a stone."],
    'greet.friend': ["{player}! Shield-friend! Ale's on me tonight!"],
    'greet.hostile': ["You've a thick hide coming back here.", "Clear off before I take my hammer to ye."],
    'bye.neutral': ["Stone keep ye.", "Mind the deep places.", "Aye. Off with ye."],
    'bye.warm': ["May yer beard grow long and yer forge stay hot, {player}!"],
    'bye.cold': ["Good riddance."],
    'insult.angry': ["Say that again and ye'll be picking teeth from the mud!", "I've cracked harder heads than yours."],
    'insult.laugh': ["Ha! My grandmother insults better than that, and she's been dead forty years."],
    'compliment.ok': ["Hmph. Well. Ye've a good eye."],
    'compliment.flat': ["Flattery's softer than slate."],
    'self.intro': ["{name}, {job} of {place}. Clan's older than the mountain."],
    'place.intro': ["{place}. Carved from honest rock by honest hands."],
    'rumor.intro': ["Rumors. Hmph. Fine."],
    'quest.offer': ["Need someone to {goal}. Pays {reward}. Don't dawdle."],
    'bark.idle': ["Hmph.", "Needs more stone, this place.", "My beard itches."],
    'bark.work': ["Strike true.", "Good iron, this.", "Hrm. Again."],
    'bark.tavern': ["Ale! Proper ale!", "Ye call this ale?"],
    'bark.fight': ["Taste my axe!", "For the hold!"],
    'bark.greetPass': ["Aye.", "Stone and steel."],
    'trade.offer': ["Dwarf-made. Worth every coin, and then some."],
  },
  orc: {
    'greet.first': [
      "New one. I am {name}. You look weak. Prove me wrong.",
      "Hrrk. Stranger. I am {name}, {job}. Speak.",
    ],
    'greet.neutral': ["Speak.", "What you want?", "Hrm. You."],
    'greet.cold': ["Talk fast or go.", "Bah. What?"],
    'greet.warm': ["{player}! Strong one returns!", "Ha! {player}! Good hunt?"],
    'greet.friend': ["{player}! Blood-friend! We feast tonight!"],
    'greet.hostile': ["You. I break you.", "Leave or bleed."],
    'bye.neutral': ["Go. Hunt well.", "Strength to you."],
    'bye.warm': ["Go strong, blood-friend. Come back with stories."],
    'bye.cold': ["Bah. Go."],
    'insult.angry': ["You want fight? We fight!", "I crush your skull for that!"],
    'insult.laugh': ["Ha! Small words from small mouth."],
    'insult.afraid': ["...Not worth fight. Go."],
    'compliment.ok': ["Hrrk. Good words. True words."],
    'self.intro': ["{name}. I am {job}. I am strong."],
    'place.intro': ["{place}. Our camp. Our blood. Our land."],
    'rumor.intro': ["Hrm. I hear things."],
    'quest.offer': ["Need strong one to {goal}. Give {reward}."],
    'bark.idle': ["Bah.", "Hungry.", "Need fight. Bored."],
    'bark.fight': ["Waaagh!", "Blood and bone!", "Die!"],
    'bark.work': ["Hrrk. Heavy.", "Work. Then eat."],
    'bark.greetPass': ["Hrm.", "Strength."],
    'bark.victory': ["Ha! Weak!"],
  },
  halfling: {
    'greet.first': [
      "Oh! A visitor! I'm {name}. Have you eaten? You look peckish.",
      "Well, hello there! Welcome to {place}! I'm {name}, the {job}. Tea?",
    ],
    'greet.neutral': ["Hello, hello! Lovely day for it.", "Afternoon, {addr}! Had second breakfast?"],
    'greet.cold': ["Oh. Hello. I suppose.", "Yes? I'm rather busy, you know."],
    'greet.warm': ["{player}! Come in, come in, the kettle's on!", "Oh, {player}! I baked too much again, take some!"],
    'greet.friend': ["{player}! Dearest! Sit, eat, tell me everything!"],
    'greet.hostile': ["You're not welcome in this burrow. Off you trot."],
    'bye.neutral': ["Cheerio! Mind the puddles!", "Off you go, then. Eat well!"],
    'bye.warm': ["Oh, take a pie for the road! I insist, {player}!"],
    'bye.cold': ["Well. Goodbye, then."],
    'insult.angry': ["Well I never! The cheek of it!", "Out! Out of my garden!"],
    'insult.mild': ["Somebody missed their elevenses."],
    'compliment.ok': ["Oh, stop it! Well, don't stop. Go on!"],
    'self.intro': ["{name}, {job}, and the best pie-maker in {place}. Ask anyone."],
    'place.intro': ["{place}! Prettiest gardens in the land, and the best mushrooms."],
    'rumor.intro': ["Ooh, gossip! I do love a bit of gossip."],
    'quest.offer': ["Would you be a dear and {goal}? There's {reward}. And cake."],
    'bark.idle': ["Is it lunch yet?", "Those carrots won't weed themselves.", "Smells like pie!"],
    'bark.hungry': ["Second breakfast was ages ago!"],
    'bark.greetPass': ["Lovely day!", "Hello, dear!"],
    'bark.tavern': ["More cheese!", "Oh, sing the one about the pig!"],
  },
  goblin: {
    'greet.first': [
      "Ooh! New one! Shiny boots! I'm {name}, yes? {job}, very important!",
      "Eh? Eh! Stranger! I'm {name}. Not stealing anything. Nope.",
    ],
    'greet.neutral': ["What what? What you want?", "Heh. Hello, big-boots.", "Yesyes, hello. What?"],
    'greet.cold': ["Go 'way. Busy. Very busy.", "Ugh. You."],
    'greet.warm': ["{player}! Friend! Bring shinies?", "Heh! {player}! Good friend, best friend!"],
    'greet.friend': ["{player}! Best biggun! I saved you a beetle!"],
    'greet.hostile': ["You! Bad one! Stabby time if you come close!"],
    'bye.neutral': ["Byebye! Don't step on me!", "Go go go."],
    'bye.warm': ["Come back! Bring more shinies! Heh!"],
    'bye.cold': ["Go. Go! Shoo!"],
    'insult.angry': ["Grr! I bite you! I bite your ankles!", "Stabbity stab stab! You'll see!"],
    'insult.afraid': ["Eep! No hurt! No hurt!"],
    'insult.laugh': ["Heh! Hehehe! Good one. Stealing that."],
    'compliment.ok': ["Really? Really really? Heh!"],
    'compliment.suspicious': ["Nice words... what you stealing?"],
    'self.intro': ["Me? {name}! {job}! Best one! Only one, maybe."],
    'place.intro': ["{place}! Warm, muddy, good bugs. Best place!"],
    'rumor.intro': ["Ooh, secrets. Got lots. Psst."],
    'quest.offer': ["You go {goal}, yes? Yes! {reward}! Good deal, heh."],
    'bark.idle': ["Heh.", "Shiny... where shiny go?", "Itchy. Very itchy."],
    'bark.thief': ["Mine now. Heh.", "Shiny shiny shiny."],
    'bark.flee': ["Eeeek!", "Not me! Eat someone else!"],
    'bark.greetPass': ["Heh. Hi.", "Hi hi."],
  },
  sylvan: {
    'greet.first': [
      "A new seed drifts into {place}. I am {name}. The moss told me you'd come.",
      "Welcome, wanderer. I am {name}. Your roots are far from here, I think.",
    ],
    'greet.neutral': ["Light and rain to you.", "The spores dance for you, {addr}.", "Greetings, walker."],
    'greet.cold': ["You trample. What do you want?", "The soil sours. Speak."],
    'greet.warm': ["{player}. You bloom in my sight.", "Ah, {player}. The canopy brightens."],
    'greet.friend': ["{player}! Our roots have grown together, you and I."],
    'greet.hostile': ["You are blight. Go, before the thorns wake."],
    'bye.neutral': ["Grow well.", "May rain find you.", "Drift gently."],
    'bye.warm': ["Return when the moss is thick, {player}. I will wait."],
    'bye.cold': ["Wither elsewhere."],
    'insult.angry': ["Thorns grow from such words.", "Careful. Roots can strangle."],
    'insult.mild': ["Weeds speak loudly, too."],
    'compliment.ok': ["Your words are warm sunlight. Thank you."],
    'self.intro': ["I am {name}. I am {job} here, as the fern is fern."],
    'place.intro': ["{place} grew. Nobody built it. It simply grew."],
    'rumor.intro': ["The mycelium whispers. Listen..."],
    'quest.offer': ["The grove needs someone to {goal}. It offers {reward}."],
    'bark.idle': ["The moss is restless.", "Mmm. Petrichor.", "Grow, little ones."],
    'bark.weather.rain': ["Drink, little roots. Drink."],
    'bark.greetPass': ["Light and rain.", "Grow well."],
  },
  drakeborn: {
    'greet.first': [
      "A stranger kneels before... ah, you're not kneeling. I am {name}, {job} of {place}.",
      "You smell of ash and roads. I am {name}. Speak with respect.",
    ],
    'greet.neutral': ["Speak, ashless one.", "Hail. The flame acknowledges you.", "You may address me."],
    'greet.cold': ["Do not waste my fire.", "Hm. A spark asking for attention."],
    'greet.warm': ["{player}. Your flame burns brighter each time.", "Hail, {player}. Kindled any glory?"],
    'greet.friend': ["{player}! Flame-sibling! My hearth is yours."],
    'greet.hostile': ["You will burn for your insolence.", "Begone, before I forget my restraint."],
    'bye.neutral': ["Burn bright.", "Go, and be worthy.", "May your embers never cool."],
    'bye.warm': ["Return in glory, {player}. Or in ashes, nobly."],
    'bye.cold': ["Smoulder elsewhere."],
    'insult.angry': ["My ancestors burned cities for less!", "You will choke on those words."],
    'insult.laugh': ["Ha! Little sparks crackle loudly."],
    'compliment.ok': ["Naturally. But it pleases me you noticed."],
    'self.intro': ["I am {name}, of the scaled line, {job} of {place}."],
    'place.intro': ["{place}. Forged in heat. Tempered by pride."],
    'rumor.intro': ["Smoke carries secrets. I have breathed many."],
    'quest.offer': ["There is glory in it: {goal}. And {reward}."],
    'bark.idle': ["The fire within stirs.", "Too cold here.", "Hm. Unworthy."],
    'bark.fight': ["Burn!", "By ember and scale!"],
    'bark.greetPass': ["Burn bright.", "Hail."],
  },
  umbral: {
    'greet.first': [
      "Ah... a new shape in the shadows. I am {name}... {job}. We've been watching.",
      "Sunborn... come closer. I am {name}. Don't be frightened.",
    ],
    'greet.neutral': ["...yes?", "The dusk greets you, {addr}.", "Hmm... you."],
    'greet.cold': ["Your light is... intrusive.", "Speak, and then... fade."],
    'greet.warm': ["{player}... your shadow grows familiar. Welcome.", "Ah, {player}... the dark remembers you fondly."],
    'greet.friend': ["{player}... shadow-kin. Sit in the quiet with me."],
    'greet.hostile': ["Leave... while your shadow still follows you.", "The dark has teeth... for you."],
    'bye.neutral': ["Walk softly... in the dusk.", "Until the dark returns you."],
    'bye.warm': ["The shadows will keep you, {player}... as I would."],
    'bye.cold': ["...gone. Good."],
    'insult.angry': ["Careful... shadows grow long at sunset.", "You will not see what comes for you."],
    'insult.mild': ["Mm... how loud you are."],
    'compliment.ok': ["Mm... sweet words. I'll keep them in the dark."],
    'self.intro': ["I am {name}... {job}, in {place}... where the light thins."],
    'place.intro': ["{place}... a quiet place. We like it quiet."],
    'rumor.intro': ["Secrets... I have so many. Here is one..."],
    'quest.offer': ["Someone must {goal}... quietly. There will be {reward}."],
    'bark.idle': ["...hm.", "The light hurts today.", "Shh... listen."],
    'bark.night': ["Ahh... the good hours.", "Night, sweet night."],
    'bark.greetPass': ["...dusk.", "Mm."],
  },
  giantkin: {
    'greet.first': [
      "Hm. Small one. New. I am {name}. I am {job}.",
      "Ho. Little traveller. Welcome to {place}. I am {name}. Do not get stepped on.",
    ],
    'greet.neutral': ["Hm. Small one.", "Ho. What is it?", "You speak. I listen. Slow."],
    'greet.cold': ["Hm. You again. Small and noisy.", "What, tiny?"],
    'greet.warm': ["{player}! Little friend! Ho ho!", "Hm! {player}. Good. Good."],
    'greet.friend': ["{player}! Small friend, big heart! Come, sit on my knee."],
    'greet.hostile': ["Go. Before I sit on you.", "Bad small one. Leave."],
    'bye.neutral': ["Hm. Go well. Walk slow.", "Ho. Goodbye, little one."],
    'bye.warm': ["Come back, little friend. Mountain waits. I wait."],
    'bye.cold': ["Hm. Go."],
    'insult.angry': ["HM! You want to fly? I make you fly.", "Small mouth. Big trouble."],
    'insult.laugh': ["Ho ho ho! Tiny insult! Tiny!"],
    'compliment.ok': ["Hm. Nice. Warm words. Like fire."],
    'self.intro': ["I am {name}. {job}. Big job. Hm."],
    'place.intro': ["{place}. Old place. Stone place. Good place."],
    'rumor.intro': ["Hm. I hear things. Slowly. Let me think."],
    'quest.offer': ["Small one. You {goal}? I give {reward}. Hm."],
    'bark.idle': ["Hm.", "Ho hum.", "Mountain is quiet today."],
    'bark.work': ["Heave. Hm.", "Big lift."],
    'bark.greetPass': ["Ho.", "Hm. Small one."],
  },
};

/** Children's simplified phrasing for greetings and a few other keys. */
const CHILD: Bank = {
  'greet.first': ["Hi! Who are you? Are you an adventurer?", "Whoa! You're new! I'm {name}!", "Mum says not to talk to strangers. But hi!"],
  'greet.again': ["You came back! Did you fight a monster?", "Hi again, {player}!"],
  'greet.hostile': ["Go away! I'll tell my dad!", "You're mean! Go away!"],
  'greet.cold': ["What do you want?", "I'm playing. Go away."],
  'greet.neutral': ["Hi!", "Hello! Wanna play?", "Hi! Do you have any sweets?"],
  'greet.warm': ["{player}! Tell me a story!", "Yay, it's {player}!"],
  'greet.friend': ["{player}! You're my favourite grown-up!", "{player}! Look what I found!"],
  'greet.busy': ["I'm doing chores. Boring!"],
  'greet.sleepy': ["I'm supposed to be in bed..."],
  'greet.afraid': ["I'm scared! There's a monster!", "Is it gone? Is the bad thing gone?"],
  'greet.mourning': ["Everyone's sad. I don't like it."],
  'greet.drunk': ["Why are you walking funny?"],
  'bye.neutral': ["Bye bye!", "See you!"],
  'bye.warm': ["Come back soon! Bring a dragon!"],
  'bye.cold': ["Bye. Whatever."],
  'self.intro': ["I'm {name}! I live in {place}!", "My name's {name}! I'm almost grown up!"],
  'rumor.intro': ["I know a secret!"],
  'rumor.none': ["I don't know anything. I'm just little."],
  'insult.angry': ["I'm telling!", "You're a big stinky meanie!"],
  'insult.afraid': ["*sniff* That's not nice..."],
  'compliment.ok': ["Hehe! Thank you!"],
  'quest.offer': ["Can you help me {goal}? I'll give you {reward}! Promise!"],
};

// ============================================================== race flavour

const ADDRESS: Record<RaceId, [string[], string[], string[], string[], string[]]> = {
  // hostile, cold, neutral, warm, friend
  human: [['scum', 'cutthroat', 'troublemaker'], ['stranger', 'outlander'], ['traveller', 'stranger', 'friend'], ['friend', 'good friend'], ['my friend', 'old friend', 'dear friend']],
  elf: [['despoiler', 'axe-bearer'], ['short-lived one', 'outsider'], ['wanderer', 'traveller'], ['friend of the leaves', 'gentle traveller'], ['star-friend', 'beloved friend']],
  dwarf: [['oath-breaker', 'grudge-bearer'], ['surface-walker', 'stoneless one'], ['traveller', 'beardling'], ['friend', 'stout one'], ['shield-friend', 'stone-friend']],
  orc: [['weakling', 'prey'], ['soft-skin', 'outsider'], ['stranger', 'traveller'], ['strong one', 'hunter'], ['blood-friend', 'war-sibling']],
  halfling: [['you brute', 'ruffian'], ['big-folk', 'stranger'], ['traveller', 'dear'], ['dear', 'lovely'], ['dearest', 'my dear friend']],
  goblin: [['stinker', 'bad one'], ['big-boots', 'biggun'], ['biggun', 'stranger'], ['pal', 'friend-friend'], ['best friend', 'best biggun']],
  sylvan: [['blight', 'trampler'], ['walker', 'outsider'], ['wanderer', 'seedling'], ['sapling-friend', 'gentle one'], ['root-kin', 'beloved bloom']],
  drakeborn: [['vermin', 'cinder'], ['ashless one', 'kindling'], ['traveller', 'ashless one'], ['spark-bearer', 'worthy one'], ['flame-sibling', 'hearth-kin']],
  umbral: [['glare', 'loud thing'], ['sunborn', 'lightling'], ['wanderer', 'sunborn'], ['dusk-friend', 'quiet one'], ['shadow-kin', 'dear shadow']],
  giantkin: [['bad tiny', 'pest'], ['tiny', 'small one'], ['small one', 'little traveller'], ['little friend', 'small friend'], ['dear small one', 'little brother']],
};

const OATHS: Record<RaceId, string[]> = {
  human: ['By the gods!', 'Gods above!', 'Saints preserve us!', 'Blood and ashes!', 'Mercy me!'],
  elf: ['By leaf and star!', 'Stars guide us.', 'Ancient roots!', 'By the first song!'],
  dwarf: ['By the deep stone!', "Hammer and anvil!", 'Hmph.', 'Beard of my fathers!', 'Stone and steel!'],
  orc: ['Hrrk.', 'Bah!', 'Blood and bone!', 'By the great tusk!', 'Grah!'],
  halfling: ['Oh my!', 'Goodness gracious!', 'Butter and buttons!', 'Sweet potatoes!'],
  goblin: ['Heh!', 'Eep!', 'Snot and toenails!', 'Shinies!', 'Yesyes!'],
  sylvan: ['By the mycelium!', 'Root and bloom!', 'Rain bless us.', 'Mossy depths!'],
  drakeborn: ['By ember and scale!', 'Ashes!', 'Flame take it!', 'By the first fire!'],
  umbral: ['...hm.', 'By the long dusk...', 'Shadows keep us...', 'Hsss.'],
  giantkin: ['Ho!', 'Hm!', 'By the mountain!', 'Rocks and rivers!'],
};

const ELF_CONTRACTIONS: [RegExp, string][] = [
  [/\bdon't\b/gi, 'do not'], [/\bcan't\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\bI'm\b/g, 'I am'],
  [/\bit's\b/gi, 'it is'], [/\byou're\b/gi, 'you are'], [/\bisn't\b/gi, 'is not'], [/\bthat's\b/gi, 'that is'],
  [/\bwe're\b/gi, 'we are'], [/\bthey're\b/gi, 'they are'], [/\bI've\b/g, 'I have'], [/\bI'd\b/g, 'I would'],
  [/\bI'll\b/g, 'I shall'], [/\bdoesn't\b/gi, 'does not'], [/\bdidn't\b/gi, 'did not'], [/\bhaven't\b/gi, 'have not'],
  [/\bwasn't\b/gi, 'was not'], [/\baren't\b/gi, 'are not'], [/\bthere's\b/gi, 'there is'], [/\bwhat's\b/gi, 'what is'],
];

// ============================================================== expansion

const ALT_RE = /\[([^[\]]*)\]/;
const VAR_RE = /\{(\w+)\}/g;

function varsPresent(s: string, vars: LineVars): boolean {
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(s))) {
    const v = vars[m[1]];
    if (v === undefined || v === '') return false;
  }
  return true;
}

export function expand(template: string, vars: LineVars, rng: Rng): string | null {
  let s = template;
  // Resolve innermost alternatives first so nesting works naturally.
  for (let guard = 0; guard < 64; guard++) {
    const m = ALT_RE.exec(s);
    if (!m) break;
    const opts = m[1].split('|').filter((o) => varsPresent(o, vars));
    if (!opts.length) return null;
    const pick = opts[Math.floor(rng.float() * opts.length)];
    s = s.slice(0, m.index) + pick + s.slice(m.index + m[0].length);
  }
  if (s.includes('[') || s.includes(']')) return null;
  let ok = true;
  s = s.replace(VAR_RE, (_, k: string) => {
    const v = vars[k];
    if (v === undefined || v === '') {
      ok = false;
      return '';
    }
    return String(v);
  });
  if (!ok || s.includes('{') || s.includes('}')) return null;
  return tidy(s);
}

function tidy(s: string): string {
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  if (s.length) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

function pickFrom(bank: string[] | undefined, vars: LineVars, rng: Rng): string | null {
  if (!bank || !bank.length) return null;
  const start = Math.floor(rng.float() * bank.length);
  for (let i = 0; i < bank.length; i++) {
    const out = expand(bank[(start + i) % bank.length], vars, rng);
    if (out) return out;
  }
  return null;
}

const SAFE_FALLBACK: [string, string][] = [
  ['greet', 'Hello.'], ['bye', 'Farewell.'], ['bark', 'Hm.'], ['time', 'Good day'], ['quest', 'I see.'],
  ['trade', 'Let us see.'], ['check', 'Hm.'], ['insult', 'Hmph.'], ['compliment', 'Thank you.'], ['rumor', "Nothing worth repeating."],
  ['dir', "I can't say for sure."], ['people', "I'd rather not say."], ['place', 'It is home.'], ['self', 'Not much to tell.'],
  ['goal', 'I manage.'],
];

function fallbackFor(key: string): string {
  for (const [p, s] of SAFE_FALLBACK) if (key.startsWith(p)) return s;
  return 'Hm.';
}

/** Does a bank exist for this key (generic or race)? */
export function hasLine(key: string, race?: RaceId): boolean {
  if (GENERIC[key]?.length) return true;
  return !!(race && RACE[race]?.[key]?.length);
}

/** Pick + expand a line for a key in this speaker's voice. */
export function say(key: string, sp: VoiceSpeaker, vars: LineVars, rng: Rng): string {
  const order: (string[] | undefined)[] = [];
  const child = sp.ageStage === 'child' ? CHILD[key] : undefined;
  const race = RACE[sp.race]?.[key];
  if (child) order.push(child);
  if (race && rng.float() < 0.65) order.push(race, GENERIC[key]);
  else order.push(GENERIC[key], race);
  // Job-specific keys fall back to the generic self-introduction.
  if (key.startsWith('self.job.')) order.push(GENERIC['self.intro']);
  let line: string | null = null;
  for (const b of order) {
    line = pickFrom(b, vars, rng);
    if (line) break;
  }
  if (!line) return fallbackFor(key);
  return decorate(line, key, sp, rng);
}

// ============================================================== decorators

function endsSentence(s: string): boolean {
  return /[.!?…]$/.test(s);
}

function decorate(line: string, key: string, sp: VoiceSpeaker, rng: Rng): string {
  const bark = key.startsWith('bark.');
  const conv = !bark && !key.startsWith('time.');
  const t = sp.traits;
  let s = line;
  if (key.startsWith('time.')) return s;

  // ---- race voice
  switch (sp.race) {
    case 'elf':
      for (const [re, rep] of ELF_CONTRACTIONS) s = s.replace(re, (m) => (m[0] === m[0].toUpperCase() ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep));
      break;
    case 'dwarf':
      if (conv && rng.float() < 0.2 && !s.startsWith('Hmph')) s = 'Hmph. ' + s;
      break;
    case 'orc':
      if (rng.float() < 0.18) s = rng.pick(['Hrrk. ', 'Bah. ', 'Grah. ']) + s;
      break;
    case 'goblin': {
      const r = rng.float();
      if (r < 0.2) {
        const m = /[A-Za-z]/.exec(s);
        if (m) {
          const c = m[0];
          s = s.slice(0, m.index) + c.toUpperCase() + '-' + c.toLowerCase() + s.slice(m.index + 1);
        }
      } else if (r < 0.35) s = s + rng.pick([' Heh.', ' Hehe.', ' Yesyes.']);
      else if (r < 0.45 && conv) s = rng.pick(['Yesyes, ', 'Eh, eh, ', 'Psst, ']) + s.charAt(0).toLowerCase() + s.slice(1);
      break;
    }
    case 'halfling':
      if (conv && key.startsWith('greet.') && rng.float() < 0.2) s += rng.pick([' Have you eaten?', ' There might be pie later.', ' Mind the vegetable patch.']);
      break;
    case 'sylvan':
      if (conv && rng.float() < 0.15) s += rng.pick([' The roots remember.', ' Such is the way of growing things.', ' Mm, the moss agrees.']);
      break;
    case 'drakeborn':
      if (conv && rng.float() < 0.12) s += rng.pick([' By ember and scale.', ' The flame knows.', ' So burns the truth.']);
      break;
    case 'umbral':
      if (rng.float() < 0.4) s = s.replace(/\.$/, '...');
      if (conv && rng.float() < 0.15) s = '...' + s.charAt(0).toLowerCase() + s.slice(1);
      break;
    case 'giantkin':
      if (conv && rng.float() < 0.2 && !/^(Hm|Ho)/.test(s)) s = 'Hm. ' + s;
      break;
    default:
      break;
  }

  // ---- personality
  if (conv) {
    if (t.neuroticism > 0.45 && rng.float() < 0.25) {
      if (/^I /.test(s)) s = 'I... ' + s;
      else s = rng.pick(['Er... ', 'Well... ', 'Um, ']) + s.charAt(0).toLowerCase() + s.slice(1);
    }
    if (t.agreeableness < -0.45 && rng.float() < 0.2 && (key.startsWith('greet.') || key.startsWith('bye.') || key.startsWith('dir.') || key.startsWith('rumor.'))) {
      s += rng.pick([' Now go.', ' Satisfied?', ' Anything else? No? Good.']);
    }
    if (sp.ageStage === 'elder' && rng.float() < 0.12 && !key.startsWith('greet.') && !key.startsWith('bye.')) {
      s += rng.pick([' Things were different in my day.', ' When I was young, we knew better.', ' Mark an old one\'s words.']);
    }
  }
  if (t.extraversion > 0.5 && rng.float() < 0.25 && s.endsWith('.') && !s.endsWith('...')) s = s.slice(0, -1) + '!';
  if (!endsSentence(s) && !bark) s += '.';
  return tidy(s);
}

/** Short race-flavoured interjection/oath for spice ("By the deep stone!", "Hrrk."). */
export function oath(sp: VoiceSpeaker, rng: Rng, deity?: string): string {
  if (deity && rng.float() < 0.35) return rng.pick([`By ${deity}!`, `${deity} preserve us!`, `${deity} help me.`]);
  return rng.pick(OATHS[sp.race] ?? OATHS.human);
}

/** Address form for the player by disposition (-100..100), race-aware. */
export function addressFor(sp: VoiceSpeaker, disposition: number, rng: Rng): string {
  const tiers = ADDRESS[sp.race] ?? ADDRESS.human;
  const tier = disposition < -50 ? 0 : disposition < -10 ? 1 : disposition < 30 ? 2 : disposition < 70 ? 3 : 4;
  if (sp.ageStage === 'child') return tier <= 1 ? 'meanie' : tier >= 3 ? 'friend' : 'mister';
  return rng.pick(tiers[tier]);
}
