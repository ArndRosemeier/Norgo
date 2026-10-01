/**
 * Free-text intent matcher used when no LLM brain is configured (and as a
 * fallback when the LLM fails). Scores keyword groups against the player's
 * text, and resolves named entities (people, landmarks) mentioned in it.
 */

export type Intent =
  | 'greet' | 'about' | 'job' | 'place' | 'people' | 'family' | 'rumors' | 'directions' | 'agenda' | 'trade' | 'bye' | 'thanks'
  | 'compliment' | 'insult' | 'apologize' | 'faith' | 'weather' | 'mood' | 'yes' | 'no' | 'unknown';

const GROUPS: [Intent, RegExp, number][] = [
  ['bye', /\b(bye|farewell|goodbye|see you|later|leave|must go|take care)\b/, 3],
  ['thanks', /\b(thanks?|thank you|cheers|grateful|appreciate)\b/, 2],
  ['greet', /\b(hello|hi|hey|greetings|good (morning|day|evening)|well met|hail)\b/, 1.5],
  ['about', /\b(who are you|your name|about you|yourself|who is this|introduce)\b/, 3],
  ['job', /\b(job|work|trade|craft|do you do|living|profession|occupation)\b/, 1.5],
  ['place', /\b(town|village|city|hamlet|place|settlement|here|this land|live here)\b/, 1.2],
  ['people', /\b(people|folk|who lives|neighbou?rs?|anyone|leader|elder|mayor|chief|lord|lady)\b/, 1.3],
  ['family', /\b(family|wife|husband|spouse|children|kids|son|daughter|mother|father|parents|married)\b/, 2],
  ['rumors', /\b(rumou?rs?|news|gossip|heard|happen(ed|ing)|going on|stories|tales|anything new)\b/, 2],
  ['directions', /\b(where|direction|way to|how (do|can) i get|find|road|path|nearest|which way|located)\b/, 1.8],
  ['agenda', /\b(help|quest|task|need|job for me|errand|problem|trouble|assist|anything i can do|work for)\b/, 1.8],
  ['trade', /\b(trade|buy|sell|shop|wares|goods|price|merchant|barter|purchase|coin)\b/, 1.8],
  ['compliment', /\b(beautiful|handsome|wise|kind|brave|great|wonderful|amazing|lovely|impressive|skilled|clever|fine)\b/, 1.2],
  ['insult', /\b(stupid|idiot|fool|ugly|smell|coward|useless|pathetic|dumb|moron|worthless|scum|shut up)\b/, 2.5],
  ['apologize', /\b(sorry|apolog|forgive|my fault|didn'?t mean|regret)\b/, 2.5],
  ['faith', /\b(god|gods|goddess|pray|temple|shrine|faith|divine|holy|worship|deity)\b/, 1.6],
  ['weather', /\b(weather|rain|storm|snow|sun|cold|hot|wind|fog)\b/, 1],
  ['mood', /\b(how are you|feeling|mood|alright|are you ok|what'?s wrong|sad|happy)\b/, 2],
  ['yes', /^\s*(yes|yeah|yep|sure|ok(ay)?|aye|of course|deal|agreed|i accept|i'?ll do it)\b/, 2],
  ['no', /^\s*(no|nope|nah|not now|never|decline|refuse)\b/, 2],
];

export interface IntentMatch {
  intent: Intent;
  score: number;
  /** Index into `names` when the text mentions a known name. */
  nameHit: number;
}

/**
 * Match free text. `names` are entity/landmark names the NPC knows (people,
 * places); a name hit upgrades ambiguous intents to 'people' / 'directions'.
 */
export function matchIntent(text: string, names: string[] = []): IntentMatch {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ') + ' ';
  let best: Intent = 'unknown', bs = 0;
  for (const [intent, re, w] of GROUPS) {
    const m = t.match(new RegExp(re.source, 'g'));
    if (!m) continue;
    const s = w * m.length;
    if (s > bs) (bs = s), (best = intent);
  }
  let nameHit = -1;
  for (let i = 0; i < names.length; i++) {
    const n = names[i].toLowerCase().replace(/^the /, '');
    if (n.length >= 3 && t.includes(n)) {
      nameHit = i;
      break;
    }
    // First word of a person's name ("Borin" in "Borin Ironvein").
    const first = n.split(/[\s,]/)[0];
    if (first.length >= 4 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(t)) {
      nameHit = i;
      break;
    }
  }
  if (nameHit >= 0 && (best === 'unknown' || best === 'people' || best === 'place' || best === 'job' || best === 'about')) best = best === 'place' ? 'directions' : best === 'unknown' ? 'people' : best;
  return { intent: best, score: bs, nameHit };
}
