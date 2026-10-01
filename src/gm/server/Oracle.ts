/**
 * "Ask the Game Master": the player can address the GM directly (ClientMessage
 * 'gmAsk'). The Oracle parses intent (where / what / who / why / help /
 * challenge / calm / recap / lore / weather / time / gravity / quest hints /
 * rumors / riddles / paying debts), executes any side effect (e.g. bringing a
 * challenge forward, paying a bounty) and answers from real world state.
 *
 * Answers come from a pluggable GmBrain. The ScriptedBrain is the default and
 * always produces a grounded answer; an optional LlmBrain (Anthropic Messages
 * API, OpenAI-compatible chat completions, or Ollama) can rephrase/expand it,
 * constrained to the facts we hand it. LLM failures fall back to the script.
 * Configure with {t:'debug', cmd:'gmLlmConfig', args:[{endpoint, apiKey, model, provider}]}.
 */
import type { ServerEntity } from '../../server/entity';
import type { Vec3 } from '../../shared/types';
import type { GmHost, PlayerGm } from './state';
import type { QuestBook } from './QuestBook';
import type { Director } from './Director';
import type { Narrator } from './Narrator';
import { Biome, BIOMES } from '../../world/biomes';
import { getLore, loreSummary, poiLore, rumorsAbout, searchLore, siteLore } from '../lore';
import { bearing, hourWords, list, cap } from '../text';
import { featuresNear } from './Scout';
import { getPlayerData } from './access';
import { powerLevel, PLAYSTYLES } from './PlayerModel';

// ------------------------------------------------------------------ brains

export interface AskContext {
  question: string;
  intent: Intent;
  /** The scripted, fact-grounded answer (always available). */
  scripted: string;
  /** World facts relevant to the player right now. */
  facts: string[];
  /** Compact world lore. */
  lore: string;
  /** Recent exchanges with this player. */
  history: { q: string; a: string }[];
  playerName: string;
}

export interface GmBrain {
  readonly name: string;
  answer(ctx: AskContext): Promise<string | null>;
}

/** Default brain: the scripted answer is the answer. */
export class ScriptedBrain implements GmBrain {
  readonly name = 'scripted';
  async answer(ctx: AskContext): Promise<string | null> {
    return ctx.scripted;
  }
}

export interface LlmConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  provider?: 'anthropic' | 'openai' | 'ollama';
}

const DEFAULTS: Record<NonNullable<LlmConfig['provider']>, { endpoint: string; model: string }> = {
  anthropic: { endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-5-5' },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  ollama: { endpoint: 'http://localhost:11434/api/chat', model: 'llama3.1' },
};

/**
 * LLM-backed brain over plain fetch (no SDK dependency in the worker). The
 * system prompt pins the persona and forbids inventing facts beyond those given.
 */
export class LlmBrain implements GmBrain {
  readonly name: string;
  private cfg: Required<Omit<LlmConfig, 'apiKey'>> & { apiKey?: string };

  constructor(cfg: LlmConfig) {
    const provider = cfg.provider ?? (cfg.endpoint?.includes('11434') ? 'ollama' : cfg.endpoint?.includes('anthropic') || !cfg.endpoint ? 'anthropic' : 'openai');
    this.cfg = { provider, endpoint: cfg.endpoint || DEFAULTS[provider].endpoint, model: cfg.model || DEFAULTS[provider].model, apiKey: cfg.apiKey };
    this.name = `llm:${provider}:${this.cfg.model}`;
  }

  get config(): LlmConfig {
    return { provider: this.cfg.provider, endpoint: this.cfg.endpoint, model: this.cfg.model };
  }

  private system(ctx: AskContext): string {
    return [
      'You are the Game Master of a fantasy open world, like a tabletop GM narrating to a single player.',
      'Speak in second person, vivid but concise: 1-4 sentences. Stay in character; never mention being an AI, prompts, or game mechanics jargon unless asked about controls.',
      'Ground every claim in the FACTS and LORE given. Never invent places, directions, quests, rewards or mechanics that are not in them. If unsure, be evocative but vague.',
      'A SCRIPTED ANSWER is provided: it is correct. Keep its information (names, directions, numbers) and improve its voice. If the player is asking for something the script already did (e.g. a challenge), confirm it.',
      '',
      'LORE:',
      ctx.lore,
    ].join('\n');
  }

  private userText(ctx: AskContext): string {
    return [`FACTS:\n- ${ctx.facts.join('\n- ')}`, `INTENT: ${ctx.intent}`, `SCRIPTED ANSWER: ${ctx.scripted}`, `PLAYER (${ctx.playerName}) ASKS: ${ctx.question}`].join('\n\n');
  }

  async answer(ctx: AskContext): Promise<string | null> {
    const { provider, endpoint, model, apiKey } = this.cfg;
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const h of ctx.history.slice(-4)) history.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 25000) : null;
    try {
      let body: unknown;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (provider === 'anthropic') {
        if (apiKey) headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        // The server runs in a browser worker in single player.
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        body = { model, max_tokens: 1024, system: this.system(ctx), messages: [...history, { role: 'user', content: this.userText(ctx) }] };
      } else if (provider === 'openai') {
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        body = { model, max_tokens: 400, messages: [{ role: 'system', content: this.system(ctx) }, ...history, { role: 'user', content: this.userText(ctx) }] };
      } else {
        body = { model, stream: false, messages: [{ role: 'system', content: this.system(ctx) }, ...history, { role: 'user', content: this.userText(ctx) }] };
      }
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ac?.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown>;
      let text = '';
      if (provider === 'anthropic') {
        if (json.stop_reason === 'refusal') return null;
        for (const b of (json.content as { type: string; text?: string }[] | undefined) ?? []) if (b.type === 'text' && b.text) text += b.text;
      } else if (provider === 'openai') {
        text = ((json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content) ?? '';
      } else {
        text = ((json.message as { content?: string } | undefined)?.content) ?? '';
      }
      text = text.trim();
      return text ? text.slice(0, 1200) : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ------------------------------------------------------------------ intents

export type Intent =
  | 'greet' | 'thanks' | 'recap' | 'where' | 'what' | 'who' | 'why' | 'help' | 'challenge' | 'calm' | 'lore' | 'weather' | 'time'
  | 'gravity' | 'quest' | 'rumor' | 'riddle' | 'pay' | 'self' | 'unknown';

const INTENTS: [Intent, RegExp][] = [
  ['pay', /\b(pay|settle|clear)\b.*\b(bounty|fine|debt|damage|amends|repairs?)\b|\bpay (it|up)\b/],
  ['riddle', /\briddle\b/],
  ['recap', /\b(recap|story so far|what happened|remind me|summar|previously|where was i)\b/],
  ['challenge', /\b(challenge|fight|danger|bored|boring|something to (kill|fight)|test me|bring it|ambush|monster)\b/],
  ['calm', /\b(peace|calm|rest|too (hard|much|dangerous)|tired|break|slow down|safe)\b/],
  ['quest', /\b(quest|objective|task|mission|next step|what now|how do i (finish|complete|do)|hint|stuck|journal)\b/],
  ['weather', /\b(weather|rain|storm|snow|fog|forecast|sky|clouds?)\b/],
  ['time', /\b(time|hour|what day|night|dawn|dusk|clock)\b/],
  ['gravity', /\b(gravity|weight|heavy|light(er)?|float|floating|weightless)\b/],
  ['rumor', /\b(rumou?rs?|gossip|news|heard anything)\b/],
  ['self', /\b(who am i|how am i doing|my (progress|stats|reputation|style)|what kind of)\b/],
  ['where', /\b(where|which way|direction|how (do|can) i get|nearest|closest|find|way to|path to|lead me)\b/],
  ['what', /\b(what is (this|here|that)|what's (this|here)|where am i|look around|describe|surroundings|what do i see)\b/],
  ['who', /\b(who|whom)\b/],
  ['lore', /\b(lore|legend|myth|history|tell me about|gods?|origin|creation|ages?|eras?|king|queen|ruler|power|faction)\b/],
  ['help', /\b(help|what (should|can) i do|advice|suggest|idea|what to do)\b/],
  ['why', /\bwhy\b/],
  ['greet', /^\s*(hi|hello|hey|greetings|good (morning|evening|day)|hail)\b/],
  ['thanks', /\b(thanks|thank you|cheers|much obliged)\b/],
];

export function parseIntent(text: string): Intent {
  const t = text.toLowerCase();
  for (const [intent, re] of INTENTS) if (re.test(t)) return intent;
  return 'unknown';
}

/** Words that name a kind of place in "where" questions. */
const TARGETS: [RegExp, string][] = [
  [/\b(town|village|city|settlement|hamlet|inn|people|shop|merchant)\b/, 'site'],
  [/\bruins?\b/, 'ruin'], [/\b(shrine|temple|altar)\b/, 'shrine'], [/\bwayshrine\b/, 'wayshrine'], [/\btower\b/, 'tower'], [/\b(lair|den|beast)\b/, 'lair'],
  [/\b(camp|bandits?)\b/, 'camp'], [/\bwell\b/, 'well'], [/\bgrove\b/, 'grove'], [/\b(obelisk|needle)\b/, 'obelisk'], [/\b(monolith|standing stone|stone)\b/, 'monolith'],
  [/\bbattle ?field\b/, 'battlefield'], [/\b(crash|fallen star|crater|meteor)\b/, 'crashsite'], [/\b(cave|caves|cavern)\b/, 'cave'],
  [/\b(shaft|underworld|below|underground|down|depths?|deep)\b/, 'shaft'], [/\b(island|isles?|sky|floating)\b/, 'island'], [/\b(anomal|gravity)\w*\b/, 'anomaly'],
];

// ------------------------------------------------------------------ oracle

export class Oracle {
  brain: GmBrain = new ScriptedBrain();
  private convo = new Map<string, { q: string; a: string }[]>();
  private pending = new Set<string>();

  constructor(private host: GmHost, private quests: QuestBook, private director: Director, private narrator: Narrator) {}

  configure(cfg: LlmConfig | null | undefined): string {
    if (!cfg || (!cfg.endpoint && !cfg.apiKey && !cfg.model && !cfg.provider)) {
      this.brain = new ScriptedBrain();
      return 'The Game Master will speak from its own book again (LLM disabled).';
    }
    const b = new LlmBrain(cfg);
    this.brain = b;
    return `The Game Master now thinks with ${b.name}. Ask away.`;
  }

  get llmConfig(): LlmConfig | null {
    return this.brain instanceof LlmBrain ? this.brain.config : null;
  }

  /** Handle a player's question. Side effects happen now; the answer may arrive async. */
  ask(p: ServerEntity, text: string) {
    const ctx = this.host.ctx;
    const g = this.host.state(p);
    const q = text.trim().slice(0, 400);
    if (!q) return;
    if (this.pending.has(g.name)) {
      this.host.say(p, 'reply', 'The Game Master is still answering your last question.', { priority: 'urgent', noLog: true });
      return;
    }
    ctx.bus.emit('gmAsk', { player: p, text: q });
    // Riddle answers & custom triggers take precedence over everything.
    const riddle = this.quests.answerRiddle(p, q);
    const intent: Intent = riddle ? 'riddle' : parseIntent(q);
    const scripted = riddle ?? this.scripted(p, g, intent, q);
    const facts = this.facts(p, g);
    const history = this.convo.get(g.name) ?? [];
    const finish = (answer: string) => {
      this.pending.delete(g.name);
      history.push({ q, a: answer });
      if (history.length > 8) history.shift();
      this.convo.set(g.name, history);
      const live = ctx.entities.get(p.id);
      if (live) this.host.say(live, 'reply', answer, { priority: 'urgent' });
    };
    if (this.brain instanceof ScriptedBrain) {
      finish(scripted);
      return;
    }
    this.pending.add(g.name);
    this.brain
      .answer({ question: q, intent, scripted, facts, lore: loreSummary(ctx.gen.profile), history, playerName: p.name })
      .then((a) => finish(a ?? scripted))
      .catch(() => finish(scripted));
  }

  // ------------------------------------------------------------ facts

  /** Ground truth about the player's situation (also the LLM's context). */
  facts(p: ServerEntity, g: PlayerGm): string[] {
    const ctx = this.host.ctx;
    const gen = ctx.gen;
    const lore = getLore(gen.profile);
    const out: string[] = [];
    const col = gen.cachedColumn(p.pos[0], p.pos[2]);
    const uw = g.live.underworld;
    const biome = uw ? col.uwBiome : col.biome === Biome.Ocean ? col.biome2 : col.biome;
    out.push(`World: ${lore.worldName}. Player is in the ${BIOMES[biome].name}${uw ? ` (in ${lore.underworldName}, the underworld)` : ''}.`);
    out.push(`Time: ${hourWords(ctx.time.hour)}, day ${ctx.time.day + 1}. Weather: ${ctx.weather.kind}.`);
    const grav = ctx.gravityAt(p.pos) / gen.profile.baseGravity;
    out.push(`Gravity here: ${grav < 0.8 ? 'light' : grav > 1.2 ? 'heavy' : 'normal'} (${Math.round(grav * 100)}% of normal for this world).`);
    out.push(`Health ${Math.round((p.hp / p.maxHp) * 100)}%. Power level ~${powerLevel(p).toFixed(1)}. Coins: ${p.inventory?.coins ?? 0}.`);
    const site = gen.siteAt(p.pos[0], p.pos[2]);
    if (site) {
      const sl = siteLore(gen.profile, site);
      out.push(`In settlement: ${sl.line} Trouble there: ${sl.trouble}.`);
    }
    const here = { x: p.pos[0], z: p.pos[2] };
    const known = getPlayerData(ctx, p.id)?.discovered ?? new Set<string>();
    const pois = gen.sites.poisNear(p.pos[0], p.pos[2], 700).sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z)).slice(0, 4);
    for (const poi of pois) out.push(`Nearby place: ${poiLore(gen.profile, poi).name} (${poi.kind}), ${bearing(here, poi)}${known.has(poi.id) ? ', visited' : ', unexplored'}.`);
    const sites = gen.sites.sitesNear(p.pos[0], p.pos[2], 1500).filter((s) => s !== site).sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z)).slice(0, 2);
    for (const s of sites) out.push(`Settlement: ${s.name} (${s.size}, ${s.race}), ${bearing(here, s)}.`);
    for (const rec of this.quests.active(g).slice(0, 4)) {
      const o = this.quests.current(rec)[0];
      const pos = o ? this.quests.objectivePos(rec, o) : undefined;
      out.push(`Active quest "${rec.spec.title}"${rec.tracked ? ' (tracked)' : ''}: next "${o?.spec.text ?? 'finish up'}"${pos ? `, ${bearing(here, { x: pos[0], z: pos[2] })}` : ''}.`);
    }
    const offered = g.quests.filter((x) => x.status === 'offered');
    if (offered.length) out.push(`Offered quests waiting in the journal: ${offered.map((x) => x.spec.title).join('; ')}.`);
    const bounty = Object.values(g.bounty).reduce((a, b) => a + b, 0);
    if (bounty > 0) out.push(`Bounty on the player: ${Math.round(bounty)} coins.`);
    const nem = g.nemeses.find((n) => !n.defeated);
    if (nem) out.push(`Nemesis: ${nem.name} (met ${nem.encounters} times).`);
    out.push(`Playstyle so far: mostly ${g.model.dominant()}. Pacing phase: ${g.director.phase}.`);
    return out;
  }

  // ------------------------------------------------------------ scripted answers

  private scripted(p: ServerEntity, g: PlayerGm, intent: Intent, q: string): string {
    const ctx = this.host.ctx;
    const gen = ctx.gen;
    const lore = getLore(gen.profile);
    const here = { x: p.pos[0], z: p.pos[2] };
    const r = this.host.rng(g, 'ask');
    switch (intent) {
      case 'greet':
        return r.pick([`Well met, ${p.name}. ${lore.worldName} is listening. Ask me where to go, what lies here, or what the old tales say.`, `Greetings, ${p.name}. What would you know?`]);
      case 'thanks':
        return r.pick(['The story is yours; I only keep the lamp lit.', 'Go well.', 'Anytime, wanderer.']);
      case 'recap':
        return this.narrator.recap(p, 'asked');
      case 'challenge': {
        if (this.director.forcePeak(p, g)) return r.pick(['So be it. Keep your blade close — something is coming.', 'You asked for it. Listen... the wild has heard you.', 'Very well. The world will test you shortly.']);
        if (p.hp < p.maxHp * 0.5) return 'Not like this — tend your wounds first. A challenge met half-dead is just a death.';
        if (gen.siteAt(p.pos[0], p.pos[2])) return 'Not within these walls. Step out into the wilds and ask again.';
        if (ctx.time.now - g.director.lastDeathAt < 120) return 'You have only just come back from death. Breathe first; the world will still be dangerous in a moment.';
        if (ctx.time.now < g.director.inDialogUntil) return 'Finish your conversation first.';
        return 'The world is catching its breath. Give it a moment.';
      }
      case 'calm': {
        const d = g.director;
        d.planned = null;
        d.phase = 'relief';
        d.phaseUntil = ctx.time.now + 420;
        d.nextDecisionAt = ctx.time.now + 60;
        d.intensity = 0;
        return 'Then rest. The roads will be kinder for a while.';
      }
      case 'quest':
        return this.questHint(p, g);
      case 'riddle': {
        const rs = this.quests.openRiddles(p);
        if (!rs.length) return 'No riddle stands between you and anything right now.';
        const x = rs[0];
        return `The riddle of ${x.quest}, carved ${bearing(here, { x: x.pos[0], z: x.pos[2] })}: “${x.question}” Speak your answer there.`;
      }
      case 'pay':
        return this.pay(p, g);
      case 'weather': {
        const w = ctx.weather;
        const now = `The weather is ${w.kind === 'clear' ? 'clear' : `${w.intensity > 0.7 ? 'heavy ' : ''}${w.kind}`}.`;
        const forecast = g.director.phase === 'build' ? 'The air feels like it is gathering itself. I would not count on it staying that way.' : g.director.phase === 'relief' ? 'It should settle.' : 'Hard to say what comes next; the sky keeps its own counsel.';
        return g.live.underworld ? `Down here there is no weather, only the slow breathing of ${lore.underworldName}. Above, ${now.toLowerCase()}` : `${now} ${forecast}`;
      }
      case 'time': {
        const h = ctx.time.hour;
        const nextNight = h < 20 ? `Night falls in about ${Math.round(20 - h)} hours.` : 'Dawn is some hours off.';
        return `It is ${hourWords(h)} on day ${ctx.time.day + 1} of your journey. ${nextNight}`;
      }
      case 'gravity': {
        const gv = ctx.gravityAt(p.pos);
        const ratio = gv / gen.profile.baseGravity;
        const label = ratio < 0.35 ? 'feather-light' : ratio < 0.8 ? 'light' : ratio < 1.2 ? 'normal' : ratio < 1.5 ? 'heavy' : 'crushing';
        const near = featuresNear(gen, g.scout, p.pos, 800).filter((f) => f.kind === 'anomaly' || f.kind === 'island');
        const tail = near.length ? ` The nearest ${near[0].kind === 'island' ? 'floating isle' : near[0].sub === 'heavy' ? 'heavy anomaly' : 'light anomaly'} lies ${bearing(here, near[0])}.` : '';
        return `The pull of the world here is ${label} (${Math.round(ratio * 100)}% of usual).${ratio < 0.85 ? ' Jump with care — you will fly further than you think.' : ratio > 1.15 ? ' Falls hurt more here; climb carefully.' : ''}${tail}`;
      }
      case 'rumor': {
        const lines = rumorsAbout(gen.profile, { x: here.x, z: here.z, pois: gen.sites.poisNear(here.x, here.z, 1000), sites: gen.sites.sitesNear(here.x, here.z, 1600), known: getPlayerData(ctx, p.id)?.discovered }, r, 2);
        return lines.join(' ') || 'The roads are quiet. Even gossip needs travellers.';
      }
      case 'self':
        return this.selfReport(p, g);
      case 'where':
        return this.where(p, g, q);
      case 'what':
        return this.describe(p, g);
      case 'who': {
        if (/\bwho am i\b/.test(q.toLowerCase())) return this.selfReport(p, g);
        if (/\b(rules?|leads?|charge|lord|mayor|chief|thane|jarl|elder|king|queen)\b/.test(q.toLowerCase())) {
          // In town: the local ruler. In the wilds: the nearest town's ruler and the power behind it.
          const inside = gen.siteAt(p.pos[0], p.pos[2]);
          const site = inside ?? gen.sites.sitesNear(here.x, here.z, 1500).sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))[0];
          if (site) {
            const sl = siteLore(gen.profile, site);
            const pw = sl.power ? ` ${cap(sl.power.name)}, under ${sl.power.rulerTitle} ${sl.power.ruler}, claims these lands.` : '';
            return inside
              ? `${site.name} answers to ${sl.rulerTitle} ${sl.ruler}.${pw}`
              : `No one rules the wilds, but the nearest town, ${site.name} (${bearing(here, site)}), answers to ${sl.rulerTitle} ${sl.ruler}.${pw}`;
          }
        }
        return this.loreAnswer(q, true) ?? `I do not know that name. The songs of ${lore.worldName} speak most of ${list(lore.figures.slice(0, 3).map((f) => `${f.name} ${f.epithet}`))}.`;
      }
      case 'lore':
        if (/(gods?|pantheon|faith|religion|pray|worship)/.test(q.toLowerCase())) return this.gods(r);
        return this.loreAnswer(q, false) ?? lore.origin;
      case 'why':
        return this.loreAnswer(q, false) ?? (intent === 'why' ? this.why(p, g) : `${lore.origin}`);
      case 'help':
        return this.help(p, g);
      default:
        return this.loreAnswer(q, false) ?? `I am the Game Master of ${lore.worldName}. Ask me where to go, what lies here, who rules, what the legends say, how your quests stand, or for a challenge.`;
    }
  }

  private loreAnswer(q: string, figuresFirst: boolean): string | null {
    const gen = this.host.ctx.gen;
    const hits = searchLore(gen.profile, q, 2);
    if (!hits.length) return null;
    const sorted = figuresFirst ? hits.sort((a, b) => Number(b.id.startsWith('figure') || b.id.startsWith('power')) - Number(a.id.startsWith('figure') || a.id.startsWith('power'))) : hits;
    return sorted.map((h) => h.text).join(' ');
  }

  private gods(r: { pick<T>(a: readonly T[]): T }): string {
    const l = getLore(this.host.ctx.gen.profile);
    const lesser = l.pantheon.map((g) => `${g.name} ${g.title} (${g.aspect})`);
    return `${l.creator.name} ${l.creator.title}, ${l.creator.aspect}, made ${l.worldName}; ${l.adversary.name} ${l.adversary.title}, ${l.adversary.aspect}, ${r.pick(['tried to unmake it', 'brought about ' + l.cataclysm, 'is the reason the world is broken'])}. ${r.pick(['Common folk pray to the lesser gods:', 'At wayside shrines you will find', 'The lesser gods are'])} ${list(lesser)}.`;
  }

  private why(p: ServerEntity, g: PlayerGm): string {
    const ctx = this.host.ctx;
    const ratio = ctx.gravityAt(p.pos) / ctx.gen.profile.baseGravity;
    const lore = getLore(ctx.gen.profile);
    if (ratio < 0.85 || ratio > 1.15) return lore.legends.find((l) => l.id === 'gravity')?.text ?? 'The world is wounded here.';
    if (g.live.underworld) return lore.legends.find((l) => l.id === 'underworld')?.text ?? '';
    return `Some things in ${lore.worldName} have reasons; most have stories. ${lore.legends.find((l) => l.id === 'cataclysm')?.text ?? ''}`;
  }

  private questHint(p: ServerEntity, g: PlayerGm): string {
    const here = { x: p.pos[0], z: p.pos[2] };
    const rec = this.quests.tracked(g);
    if (!rec) {
      const offered = g.quests.find((q) => q.status === 'offered');
      if (offered) return `Nothing is underway, but "${offered.spec.title}" waits in your journal: ${offered.spec.summary}`;
      return 'Your journal is empty of tasks. Explore — places and people will give you reasons soon enough.';
    }
    const o = this.quests.current(rec)[0];
    if (!o) return `"${rec.spec.title}" is nearly done.`;
    const pos = this.quests.objectivePos(rec, o);
    const where = pos ? ` It lies ${bearing(here, { x: pos[0], z: pos[2] })}.` : '';
    const s = o.spec;
    let tip = '';
    if (o.aux?.linger) tip = o.aux.linger.night ? ' Go there after dusk and stay a while.' : ' Go there and take your time; search carefully.';
    else if (o.aux?.riddle) tip = ` The riddle reads: “${o.aux.riddle.question}” Speak your answer to me there.`;
    else if (s.kind === 'kill') tip = o.aux?.spawn ? ' Your quarry will show itself when you come close.' : ' Hunt in the wilds.';
    else if (s.kind === 'collect' || s.kind === 'deliver') tip = ` You need ${s.count}; you carry ${countOf(p, s.itemDef)}.`;
    else if (s.kind === 'harvest') tip = ' Gather from plants, trees or stones as you go.';
    else if (s.kind === 'talk') tip = ' Find them and speak with them.';
    else if (s.kind === 'ability') tip = ` Use ${s.ability === '*' ? 'any of your abilities' : s.ability} — ${s.count - o.count} more time(s).`;
    else if (s.kind === 'custom' && s.event.startsWith('amends:')) tip = ' Tell me "pay for the damage" when you have the coin.';
    return `${rec.spec.title}: ${s.text}.${where}${tip}`;
  }

  private pay(p: ServerEntity, g: PlayerGm): string {
    const ctx = this.host.ctx;
    const coins = p.inventory?.coins ?? 0;
    // Amends quests first (cheaper, local).
    for (const rec of this.quests.active(g)) {
      const amends = rec.spec.meta?.amends;
      if (typeof amends !== 'number') continue;
      if (coins < amends) return `The repairs cost ${amends} coins; you have ${coins}.`;
      p.inventory!.coins -= amends;
      ctx.markPlayerDirty(p.id, 'inventory');
      this.quests.onCustom(p, `amends:${String(rec.spec.meta?.site)}`);
      return `You count out ${amends} coins for the repairs. The matter is closed.`;
    }
    const total = Math.round(Object.values(g.bounty).reduce((a, b) => a + b, 0));
    if (total <= 0) return 'You owe nothing to anyone. For now.';
    if (coins < total) return `Your bounty stands at ${total} coins; you carry ${coins}. Some debts must wait.`;
    p.inventory!.coins -= total;
    ctx.markPlayerDirty(p.id, 'inventory');
    const d = getPlayerData(ctx, p.id);
    if (d) {
      for (const k of Object.keys(g.bounty)) if (k !== 'wilds') d.reputation[k] = Math.min(100, (d.reputation[k] ?? 0) + 5);
      ctx.markPlayerDirty(p.id, 'reputation');
    }
    g.bounty = {};
    g.beat(`Paid off a bounty of ${total} coins`, ctx.time.now, ctx.time.day);
    return `You pay ${total} coins. The writs are torn up; the hunters will find other quarry.`;
  }

  private selfReport(p: ServerEntity, g: PlayerGm): string {
    const h = g.model.history;
    const w = g.model.weights();
    const top = PLAYSTYLES.slice().sort((a, b) => w[b] - w[a]).slice(0, 2);
    const d = getPlayerData(this.host.ctx, p.id);
    const reps = Object.entries(d?.reputation ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2).map(([k, v]) => `${v >= 0 ? 'liked' : 'disliked'} by ${this.quests.factionName(k)}`);
    const parts = [
      `You are ${p.name}, ${top[0]} at heart${w[top[1]] > 0.2 ? ` with a streak of ${top[1]}` : ''}.`,
      `${n(h.kills, 'foe')} felled, ${n(h.discoveries, 'place')} found, ${n(h.questsCompleted, 'task')} completed, ${n(h.deaths, 'death')} survived.`,
    ];
    if (reps.length) parts.push(`You are ${list(reps)}.`);
    if (h.bossKills.length) parts.push(`They still talk about ${h.bossKills[h.bossKills.length - 1]}.`);
    return parts.join(' ');
  }

  /** "Where is X?" — finds the nearest matching feature. */
  private where(p: ServerEntity, g: PlayerGm, q: string): string {
    const ctx = this.host.ctx;
    const gen = ctx.gen;
    const t = q.toLowerCase();
    const here = { x: p.pos[0], z: p.pos[2] };
    if (/\bwhere am i\b/.test(t)) return this.describe(p, g);
    if (/\b(quest|objective|go next|should i go)\b/.test(t)) return this.questHint(p, g);
    if (/\bhome\b/.test(t)) {
      const d = getPlayerData(ctx, p.id);
      return d ? `Your hearth lies ${bearing(here, { x: d.home[0], z: d.home[2] })}.` : 'You have no home yet.';
    }
    // Named place?
    for (const s of gen.sites.sitesNear(here.x, here.z, 3000)) if (t.includes(s.name.toLowerCase())) return `${s.name} lies ${bearing(here, s)}.`;
    let want: string | null = null;
    for (const [re, k] of TARGETS) if (re.test(t)) {
      want = k;
      break;
    }
    const feats = featuresNear(gen, g.scout, p.pos, 1800);
    const known = getPlayerData(ctx, p.id)?.discovered ?? new Set<string>();
    const match = feats.filter((f) => !want || f.kind === want || f.sub === want || (want === 'shaft' && f.kind === 'cave'));
    match.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
    const unexplored = match.filter((f) => !known.has(f.id) && !g.scout.visited.has(f.id));
    const f = unexplored[0] ?? match[0];
    if (!f) {
      if (want === 'shaft') return `No way down that I know of nearby. ${getLore(gen.profile).underworldName} has many doors — caves and great shafts. Keep looking.`;
      return want ? `I know of no ${want} within a day's walk. The world is wide; try another direction.` : 'Be more specific — a town, a ruin, a shrine, a way down?';
    }
    g.scout.nudged.add(f.id);
    const name = this.director.featureName(f);
    const pos: Vec3 = [f.x, f.y, f.z];
    this.host.say(p, 'hint', `${cap(name)} — marked.`, { pos, priority: 'urgent', noLog: true });
    return `${cap(name)} lies ${bearing(here, f)}${!known.has(f.id) && !g.scout.visited.has(f.id) ? ' — you have not been there yet' : ''}.`;
  }

  /** "What is here?" — a description of the surroundings. */
  describe(p: ServerEntity, g: PlayerGm): string {
    const ctx = this.host.ctx;
    const gen = ctx.gen;
    const lore = getLore(gen.profile);
    const col = gen.cachedColumn(p.pos[0], p.pos[2]);
    const uw = g.live.underworld;
    const biome = uw ? col.uwBiome : col.biome === Biome.Ocean ? col.biome2 : col.biome;
    const parts: string[] = [];
    parts.push(`You stand in the ${BIOMES[biome].name}${uw ? `, deep in ${lore.underworldName}` : ''}, at ${hourWords(ctx.time.hour)}.`);
    const site = gen.siteAt(p.pos[0], p.pos[2]);
    if (site) parts.push(siteLore(gen.profile, site).line);
    const poi = gen.sites.poisNear(p.pos[0], p.pos[2], 60)[0];
    if (poi) {
      const pl = poiLore(gen.profile, poi);
      parts.push(`${cap(pl.name)}: ${pl.legend}`);
    }
    const ratio = ctx.gravityAt(p.pos) / gen.profile.baseGravity;
    if (ratio < 0.85) parts.push('The ground holds you loosely here.');
    if (ratio > 1.15) parts.push('Everything here is heavier than it should be.');
    if (!uw && p.pos[1] < col.height - 8) parts.push('You are underground; the surface is above you.');
    if (!site && !poi) {
      const leg = searchLore(gen.profile, BIOMES[biome].name, 1)[0];
      if (leg) parts.push(leg.text);
    }
    return parts.join(' ');
  }

  private help(p: ServerEntity, g: PlayerGm): string {
    const ideas: string[] = [];
    const rec = this.quests.tracked(g);
    if (rec) ideas.push(this.questHint(p, g));
    const offered = g.quests.find((q) => q.status === 'offered');
    if (offered) ideas.push(`Consider "${offered.spec.title}" waiting in your journal.`);
    if (p.hp < p.maxHp * 0.5) ideas.unshift('First: you are hurt. Rest, eat, heal.');
    const style = g.model.dominant();
    const feats = featuresNear(this.host.ctx.gen, g.scout, p.pos, 900).filter((f) => !g.scout.visited.has(f.id));
    const here = { x: p.pos[0], z: p.pos[2] };
    if (feats.length && (style === 'explorer' || ideas.length < 2)) {
      const f = feats.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))[0];
      ideas.push(`There is ${this.director.featureName(f)} ${bearing(here, f)}.`);
    }
    if (style === 'fighter' && ideas.length < 3) ideas.push('If you want a fight, ask me for a challenge.');
    if (style === 'socializer' && ideas.length < 3) ideas.push('Settlements are full of people with problems; talk to them.');
    if (style === 'crafter' && ideas.length < 3) ideas.push('Rare materials gather where the land is strange — crystal, ash, the deep.');
    if (style === 'mage' && ideas.length < 3) ideas.push('The obelisks and standing stones hum with old power; try your arts there.');
    if (style === 'sneak' && ideas.length < 3) ideas.push('Night is your friend, and camps sleep deeply after midnight.');
    return ideas.slice(0, 3).join(' ') || 'Walk, look, listen. The world will find you.';
  }
}

/** "1 place", "3 places". */
function n(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function countOf(p: ServerEntity, defId: string): number {
  let n = 0;
  for (const it of p.inventory?.items ?? []) if (it.defId === defId) n += it.count;
  return n;
}
