/**
 * Dialog system: per-player conversation sessions with NPCs.
 *
 * Content is generated, not authored: every line comes from the voice library
 * (race + personality + age aware templates) filled with the NPC's actual
 * state — disposition and the reasons behind it, time of day, mood, needs,
 * family, relationships, memories (rumors spread by gossip), nearby POIs and
 * creatures, directions with bearings, and the NPC's current goal, which can be
 * turned into a quest for the game master. Skill checks (persuasion,
 * intimidation, barter, lore) show their chance up front.
 *
 * Free text goes to a `DialogBrain`: the scripted intent matcher by default,
 * or an LLM when configured (`{t:'debug', cmd:'llmConfig', args:[cfg]}`, or
 * `/llm {json}` typed into the dialog as a fallback channel).
 */
import type { DialogService, ServerContext, ServerSystem } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import { EntFlag, type EntityId, type Vec3 } from '../../shared/types';
import { Rng, deriveSeed, hashString } from '../../core/rng';
import { clamp } from '../../core/math';
import type { DialogChoice, DialogLine, DialogView } from '../types';
import { say, addressFor, oath, type VoiceSpeaker, type LineVars } from '../voice';
import { ScriptedBrain, LlmBrain, parseLlmConfig, type BrainContext, type BrainReply, type DialogBrain, type LlmConfig } from '../brain';
import type { Intent } from '../intent';
import { isBridge, type NpcDialogBridge, type NpcDialogInfo, type NpcPerson, type QuestOffer } from '../../npc/bridge';
import { dispTier, type Memory } from '../../npc/mind';
import { JOBS } from '../../npc/jobs';
import { RACE_ADJ, JOB_NOUN, traitWords } from '../../npc/culture';
import { describeWay } from '../../npc/describe';
import { BIOMES } from '../../world/biomes';
import type { RaceId } from '../../humanoid/types';
import { siteLore, rumorsAbout, biomeLegend, getLore, searchLore, loreSummary } from '../../gm/lore';
import { getPlayerData } from '../../server/systems/playerData';

type Mood = NonNullable<DialogLine['mood']>;

interface Landmark {
  id: string;
  name: string;
  kind: string;
  pos: Vec3;
}

interface Session {
  id: string;
  playerId: EntityId;
  npcId: EntityId;
  rng: Rng;
  history: { who: 'player' | 'npc'; text: string }[];
  asked: Set<string>;
  checks: Set<string>;
  compliments: number;
  insults: number;
  offer: QuestOffer | null;
  rewardMul: number;
  people: NpcPerson[];
  landmarks: Landmark[];
  allLandmarks: Landmark[];
  /** Sentences already spoken (suppresses repeated voice tics). */
  spoken: Set<string>;
  /** Choice id → free text (LLM suggestions). */
  says: Map<string, string>;
  pending: boolean;
  ended: boolean;
  turn: number;
  canTrade: boolean;
}

/** Skill aliases: the gameplay module's skill ids may differ; take the best match. */
const SKILL_ALIASES: Record<string, string[]> = {
  persuasion: ['persuasion', 'speech', 'diplomacy', 'charisma'],
  intimidation: ['intimidation', 'intimidate', 'menace'],
  barter: ['barter', 'trade', 'mercantile', 'haggling'],
  lore: ['lore', 'knowledge', 'history', 'arcana', 'scholarship'],
};

const TIER_WORD: Record<string, string> = { hostile: 'hostile toward you', cold: 'wary of you', neutral: 'indifferent to you', warm: 'friendly', friend: 'fond of you' };

const VOICE_NOTE: Record<RaceId, string> = {
  human: 'plain-spoken, practical',
  elf: 'formal and measured, never uses contractions, faintly condescending to short-lived folk',
  dwarf: 'gruff, terse, proud of craft and clan, swears by stone and forge',
  orc: 'blunt, short sentences, values strength and honour, grunts',
  halfling: 'chatty, warm, forever mentioning food and comfort',
  goblin: 'twitchy, fast, stammering, greedy for shiny things, says "yesyes"',
  sylvan: 'dreamy, speaks in plant and season metaphors, slow',
  drakeborn: 'proud, fiery, speaks of ancestry and flame',
  umbral: 'cryptic and whispery, trails off, speaks of shadows and veils',
  giantkin: 'slow, simple words, gentle, calls others "small one"',
};

/** Player-side phrasings, picked per session for variety. */
const P = {
  about: ['Who are you?', 'Tell me about yourself.', 'And you are...?', "I don't believe we've met."],
  story: ["What's your story?", 'How did you end up here?', 'Tell me more about your life.'],
  mood: ["What's on your mind?", 'How are you faring?', 'You look like you have something on your mind.'],
  place: ['Tell me about {place}.', 'What is this place like?', 'What should I know about {place}?'],
  people: ['Who else lives here?', 'Tell me about the people here.', 'Who should I know around here?'],
  rumors: ['Heard any news?', 'Any rumors worth hearing?', "What's the gossip?", 'Anything strange happen lately?'],
  directions: ['Can you point me somewhere?', 'I need directions.', "I'm looking for a place."],
  agenda: ['Need any help?', 'Is there anything I can do for you?', 'Got any work for me?', 'You seem troubled. Can I help?'],
  trade: ["Let's trade.", 'Show me your wares.', 'What are you selling?'],
  compliment: ['[Compliment] You seem very capable.', '[Compliment] I like the look of this place.', '[Compliment] Your work is impressive.'],
  insult: ['[Insult] Out of my way, peasant.', '[Insult] You smell like a wet dog.', '[Insult] What a useless lump you are.'],
  apologize: ['[Apologize] I owe you an apology.', "[Apologize] I'm sorry for what happened."],
  bye: ['Farewell.', 'Goodbye.', 'I should be going.', 'Until next time.'],
  back: ['Let me ask something else.', 'Something else...', 'Back to other matters.'],
};

export class DialogSystem implements ServerSystem, DialogService {
  readonly name = 'dialog';
  private ctx!: ServerContext;
  private sessions = new Map<EntityId, Session>();
  private scripted = new ScriptedBrain();
  private llm: LlmBrain | null = null;
  private seq = 1;
  private checkAcc = 0;

  init(ctx: ServerContext) {
    this.ctx = ctx;
    ctx.bus.on('death', (p) => {
      for (const s of this.sessions.values()) if (s.npcId === p.entity.id || s.playerId === p.entity.id) this.close(s, true);
    });
  }

  /** Configure (or disable with null) the LLM brain. Also usable directly by the worker host. */
  configureLlm(cfg: LlmConfig | null) {
    this.llm = cfg ? new LlmBrain(cfg) : null;
    this.ctx?.log('dialog: LLM brain', cfg ? `enabled (${cfg.provider}, ${cfg.model})` : 'disabled');
  }

  private get npcs(): NpcDialogBridge | null {
    const n = this.ctx.services.npcs as unknown;
    return isBridge(n) ? n : null;
  }

  // ================================================================== service

  start(player: ServerEntity, npc: ServerEntity): void {
    const bridge = this.npcs;
    if (!bridge || !npc.alive) return;
    const info = bridge.npcInfo(npc.id);
    if (!info || !(npc.flags & EntFlag.Talkable)) return;
    const old = this.sessions.get(player.id);
    if (old) this.close(old, false);
    const s: Session = {
      id: `d${this.seq++}`, playerId: player.id, npcId: npc.id, rng: new Rng(deriveSeed(this.ctx.seed, 'dialog', npc.id, Math.floor(this.ctx.time.now * 10))),
      history: [], asked: new Set(), checks: new Set(), compliments: 0, insults: 0, offer: null, rewardMul: 1, people: [], landmarks: [], allLandmarks: [], spoken: new Set(), says: new Map(),
      pending: false, ended: false, turn: 0, canTrade: false,
    };
    this.sessions.set(player.id, s);
    const firstTime = !info.st.talked[`P:${player.name}`];
    const wasAsleep = info.activity === 'sleep';
    bridge.beginTalk(npc.id, player);
    this.ctx.bus.emit('dialogStarted', { player, npc });
    s.people = bridge.people(npc.id);
    s.allLandmarks = bridge.landmarks(npc.id);
    s.landmarks = this.pickLandmarks(s, s.allLandmarks, info);
    const lines = this.greeting(s, player, info, firstTime, wasAsleep);
    this.send(s, player, info, [], lines, this.rootChoices(s, player, info));
  }

  end(player: ServerEntity): void {
    const s = this.sessions.get(player.id);
    if (s) this.close(s, true);
  }

  private close(s: Session, notify: boolean) {
    if (s.ended) return;
    s.ended = true;
    this.sessions.delete(s.playerId);
    const player = this.ctx.entities.get(s.playerId);
    if (player) this.npcs?.endTalk(s.npcId, player);
    if (notify) {
      const npc = this.ctx.entities.get(s.npcId);
      this.ctx.send(s.playerId, {
        t: 'dialog', view: { sessionId: s.id, npcId: s.npcId, npcName: npc?.name ?? '', npcTitle: '', lines: [], choices: [], freeText: false, ended: true, disposition: 0, canTrade: false },
      });
    }
  }

  // ================================================================== messages

  onMessage(player: ServerEntity, msg: ClientMessage): boolean {
    switch (msg.t) {
      case 'talk': {
        const npc = this.ctx.entities.get(msg.npc);
        if (!npc || npc.kind !== 'npc' || !this.npcs?.isNpc(npc.id)) return false;
        if (this.dist(player, npc) <= 7) this.start(player, npc);
        return true;
      }
      case 'interact': {
        if (msg.target === undefined) return false;
        const npc = this.ctx.entities.get(msg.target);
        if (!npc || npc.kind !== 'npc' || !this.npcs?.isNpc(npc.id)) return false;
        if (!(npc.flags & EntFlag.Talkable)) return false;
        if (this.dist(player, npc) <= 7) this.start(player, npc);
        return true;
      }
      case 'dialogChoice': {
        const s = this.sessions.get(player.id);
        if (!s || s.id !== msg.session) return true;
        this.onChoice(s, player, msg.choice);
        return true;
      }
      case 'dialogText': {
        const s = this.sessions.get(player.id);
        const text = msg.text.trim().slice(0, 500);
        if (text.startsWith('/llm')) {
          this.configureFromText(text.slice(4).trim());
          return true;
        }
        if (!s || s.id !== msg.session || !text) return true;
        this.onText(s, player, text);
        return true;
      }
      case 'dialogEnd': {
        const s = this.sessions.get(player.id);
        if (s && s.id === msg.session) this.farewell(s, player, true);
        return true;
      }
      case 'debug':
        if (msg.cmd === 'llmConfig') {
          const a = msg.args?.[0];
          this.configureLlm(a === null || a === 'off' ? null : parseLlmConfig(a));
          return true;
        }
        return false;
    }
    return false;
  }

  private configureFromText(t: string) {
    if (t === 'off' || !t) return this.configureLlm(null);
    try {
      this.configureLlm(parseLlmConfig(JSON.parse(t)));
    } catch {
      this.ctx.log('dialog: bad /llm config');
    }
  }

  tick(dt: number) {
    this.checkAcc += dt;
    if (this.checkAcc < 0.5) return;
    this.checkAcc = 0;
    for (const s of [...this.sessions.values()]) {
      const p = this.ctx.entities.get(s.playerId);
      const n = this.ctx.entities.get(s.npcId);
      if (!p || !n || !n.alive || !p.alive || this.dist(p, n) > 9) this.close(s, true);
    }
  }

  private dist(a: ServerEntity, b: ServerEntity) {
    return Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
  }

  // ================================================================== rendering helpers

  private speaker(info: NpcDialogInfo): VoiceSpeaker {
    return { race: info.rec.race, traits: info.rec.traits, job: info.rec.job, ageStage: info.rec.ageStage, gender: info.rec.gender };
  }

  private vars(s: Session, player: ServerEntity, info: NpcDialogInfo, extra: LineVars = {}): LineVars {
    const site = info.site;
    const disp = this.disp(player, info);
    const leader = site ? s.people.find((p) => p.relation === null && info.layout && p.id !== info.rec.id) : undefined;
    const h = this.ctx.time.hour;
    return {
      name: info.rec.given, player: player.name, addr: addressFor(this.speaker(info), disp, s.rng), job: JOB_NOUN[info.rec.job], place: site?.name ?? 'these lands', home: site?.name,
      race: RACE_ADJ[info.rec.race], size: site?.size, biome: site ? (BIOMES[site.biome]?.name ?? 'wilds').toLowerCase() : undefined, deity: info.deity?.name,
      deityEpithet: info.deity?.epithet, weather: this.ctx.weather.kind, time: h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night',
      leader: leader?.name, race2: site?.race2 ? RACE_ADJ[site.race2 as RaceId] : undefined, ...extra,
    };
  }

  private line(s: Session, player: ServerEntity, info: NpcDialogInfo, key: string, mood?: Mood, extra: LineVars = {}): DialogLine {
    return { speaker: info.rec.name, speakerId: info.entity.id, text: say(key, this.speaker(info), this.vars(s, player, info, extra), s.rng), mood: mood ?? this.baseMood(info) };
  }

  private raw(info: NpcDialogInfo, text: string, mood?: Mood): DialogLine {
    return { speaker: info.rec.name, speakerId: info.entity.id, text, mood: mood ?? this.baseMood(info) };
  }

  private baseMood(info: NpcDialogInfo): Mood {
    return info.mood === 'focused' ? 'neutral' : info.mood;
  }

  private disp(player: ServerEntity, info: NpcDialogInfo): number {
    return this.npcs?.dispositionInfo(info.entity.id, player).value ?? 0;
  }

  private pickP(s: Session, k: keyof typeof P, vars: Record<string, string> = {}): string {
    const arr = P[k];
    const t = arr[(hashString(s.id + k) + s.turn * 0) % arr.length];
    return t.replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
  }

  private send(s: Session, player: ServerEntity, info: NpcDialogInfo, echo: DialogLine[], lines: DialogLine[], choices: DialogChoice[], opts: { thinking?: boolean; brain?: string; openTrade?: boolean; ended?: boolean } = {}) {
    s.turn++;
    this.dedupe(s, lines);
    for (const l of lines) s.history.push({ who: 'npc', text: l.text });
    if (s.history.length > 30) s.history.splice(0, s.history.length - 30);
    const d = this.npcs?.dispositionInfo(info.entity.id, player);
    const value = d?.value ?? 0;
    const tier = dispTier(value);
    const view: DialogView = {
      sessionId: s.id, npcId: info.entity.id, npcName: info.rec.name, npcTitle: this.title(info, tier), lines: [...echo, ...lines], choices, freeText: !opts.ended,
      ended: !!opts.ended, disposition: value, canTrade: s.canTrade, thinking: opts.thinking, brain: opts.brain ?? 'scripted', tier, openTrade: opts.openTrade,
    };
    this.ctx.send(player.id, { t: 'dialog', view });
    const last = lines[lines.length - 1];
    if (last && !opts.ended) this.npcs?.setTalking(info.entity.id, true, last.mood as never);
    if (opts.ended) this.close(s, false);
  }

  /**
   * Voice decorators add flavour sentences ("Such is the way of growing
   * things."). Repeated within a conversation they grate: drop sentences that
   * were already said, unless that would empty the line.
   */
  private dedupe(s: Session, lines: DialogLine[]) {
    for (const l of lines) {
      if (!l.speaker) continue;
      const parts = l.text.match(/[^.!?…]+[.!?…]+["”']?\s*|[^.!?…]+$/g) ?? [l.text];
      const keep = parts.filter((p, i) => {
        const k = p.trim().toLowerCase();
        if (k.length > 60 || i === 0) return true;
        return !s.spoken.has(k);
      });
      for (const p of parts) s.spoken.add(p.trim().toLowerCase());
      const t = keep.join('').trim();
      if (t) l.text = t;
    }
  }

  private title(info: NpcDialogInfo, tier: string): string {
    const r = info.rec;
    const race = r.race2 ? `${cap(RACE_ADJ[r.race])}-${RACE_ADJ[r.race2]}` : cap(RACE_ADJ[r.race]);
    const what = r.title || JOB_NOUN[r.job];
    return `${race} ${what.charAt(0).toLowerCase() === what.charAt(0) ? what : what}, ${TIER_WORD[tier] ?? 'indifferent to you'}`;
  }

  private echo(player: ServerEntity, text: string): DialogLine[] {
    return [{ speaker: player.name, speakerId: player.id, text }];
  }

  // ================================================================== greeting & menus

  private greeting(s: Session, player: ServerEntity, info: NpcDialogInfo, first: boolean, asleep: boolean): DialogLine[] {
    const bridge = this.npcs!;
    const d = bridge.dispositionInfo(info.entity.id, player);
    const tier = dispTier(d.value);
    const out: DialogLine[] = [];
    const now = info.now;
    const grief = info.st.mem.find((m) => m.kind === 'death' && m.imp >= 0.8 && now - m.t < 48 && !m.heard);
    if (asleep) {
      out.push(this.line(s, player, info, 'greet.sleepy', 'angry'));
      bridge.adjustDisposition(info.entity.id, player.id, -3, 'woke me from my sleep');
    } else if (info.st.needs.safety < 0.3) out.push(this.line(s, player, info, 'greet.afraid', 'afraid'));
    else if (grief) out.push(this.line(s, player, info, 'greet.mourning', 'sad', { person: grief.text.split(' ')[0] }));
    else if (tier === 'hostile') out.push(this.line(s, player, info, 'greet.hostile', 'angry'));
    else {
      const busy = (info.activity === 'work' || info.activity === 'goal') && info.rec.traits.extraversion < -0.1;
      const drunk = info.activity === 'tavern' && this.ctx.time.hour > 21 && s.rng.chance(0.35);
      const key = busy ? 'greet.busy' : drunk ? 'greet.drunk' : first ? 'greet.first' : s.rng.chance(0.5) ? 'greet.again' : `greet.${tier}`;
      const mood: Mood = tier === 'friend' || tier === 'warm' ? 'happy' : tier === 'cold' ? 'disgusted' : this.baseMood(info);
      out.push(this.line(s, player, info, key, mood));
      if (!first && key !== `greet.${tier}` && tier !== 'neutral') out.push(this.line(s, player, info, `greet.${tier}`, mood));
    }
    // Strong feelings come with a reason the NPC remembers.
    const reason = d.reasons.find((r) => !r.startsWith('heard from'));
    if (reason && Math.abs(d.value) >= 20 && s.rng.chance(0.7)) {
      const pos = d.value > 0;
      const t = pos
        ? s.rng.pick([`You ${reason}. I don't forget a kindness.`, `Ah, the one who ${reason}!`, `Folk here know you ${reason}. You're welcome at my fire.`])
        : s.rng.pick([`You ${reason}. Don't think I've forgotten.`, `You're the one who ${reason}.`, `After you ${reason}? You've some nerve.`]);
      out.push(this.raw(info, t, pos ? 'happy' : 'angry'));
    }
    // Open promises.
    const open = bridge.openQuests(info.entity.id, player);
    if (open.length) out.push(this.line(s, player, info, 'quest.active', 'focused', { goal: open[0].goal }));
    return out;
  }

  private rootChoices(s: Session, player: ServerEntity, info: NpcDialogInfo): DialogChoice[] {
    const d = this.disp(player, info);
    const tier = dispTier(d);
    const c: DialogChoice[] = [];
    const kid = info.rec.ageStage === 'child';
    const place = info.site?.name ?? 'this place';
    if (tier === 'hostile' && info.rec.job !== 'bandit') {
      c.push({ id: 'apologize', text: this.pickP(s, 'apologize'), kind: 'social', hint: 'May soften them' });
      this.checkChoice(s, player, info, c, 'persuade', 'persuasion', '[Persuade] Hear me out, please.');
      this.checkChoice(s, player, info, c, 'intimidate', 'intimidation', '[Intimidate] Watch your tone with me.');
      c.push({ id: 'bye', text: this.pickP(s, 'bye'), kind: 'exit', exit: true });
      return c;
    }
    if (!s.asked.has('about')) c.push({ id: 'about', text: this.pickP(s, 'about'), kind: 'topic' });
    else if (!s.asked.has('story') && !kid) c.push({ id: 'story', text: this.pickP(s, 'story'), kind: 'topic' });
    c.push({ id: 'mood', text: this.pickP(s, 'mood'), kind: 'topic' });
    if (info.site) c.push({ id: 'place', text: this.pickP(s, 'place', { place }), kind: 'topic' });
    if (s.people.length) c.push({ id: 'people', text: this.pickP(s, 'people'), kind: 'topic' });
    c.push({ id: 'rumors', text: this.pickP(s, 'rumors'), kind: 'topic' });
    if (s.landmarks.length) c.push({ id: 'directions', text: this.pickP(s, 'directions'), kind: 'topic' });
    if (!kid) {
      const offer = this.npcs!.questOffer(info.entity.id, player);
      c.push({ id: 'agenda', text: this.pickP(s, 'agenda'), kind: 'quest', hint: offer ? (offer.wanted ? 'They need help' : 'They might accept help') : undefined });
    }
    if (JOBS[info.rec.job].merchant && info.rec.job !== 'thief') c.push({ id: 'trade', text: this.pickP(s, 'trade'), kind: 'trade' });
    else if (info.rec.job === 'thief' && d > 25) c.push({ id: 'trade', text: '[Quietly] I hear you deal in... special goods.', kind: 'trade' });
    if (!kid) {
      if (JOBS[info.rec.job].merchant) this.checkChoice(s, player, info, c, 'barter', 'barter', '[Barter] Surely you can do better on prices.');
      this.checkChoice(s, player, info, c, 'persuade', 'persuasion', '[Persuade] Come now, tell me what you really know.');
      this.checkChoice(s, player, info, c, 'intimidate', 'intimidation', '[Intimidate] Tell me what you know. Now.');
      if (info.deity || info.rec.job === 'scholar' || info.rec.job === 'mage' || info.rec.job === 'priest') this.checkChoice(s, player, info, c, 'lore', 'lore', info.deity ? `[Lore] Speak of ${info.deity.name}, ${info.deity.epithet}.` : '[Lore] Discuss old legends of these lands.');
    }
    if (s.compliments < 2) c.push({ id: 'compliment', text: this.pickP(s, 'compliment'), kind: 'social', hint: 'Disposition +' });
    if (s.insults < 2) c.push({ id: 'insult', text: this.pickP(s, 'insult'), kind: 'social', hint: 'Disposition −' });
    if (d < -10) c.push({ id: 'apologize', text: this.pickP(s, 'apologize'), kind: 'social' });
    c.push({ id: 'bye', text: this.pickP(s, 'bye'), kind: 'exit', exit: true });
    return c;
  }

  // ================================================================== skill checks

  private playerSkill(player: ServerEntity, skill: string): { level: number; id: string } {
    let best = 0, id = skill;
    for (const alias of SKILL_ALIASES[skill] ?? [skill]) {
      let lv = 0;
      try {
        lv = this.ctx.services.skills.level(player, alias) || 0;
      } catch {
        lv = 0;
      }
      if (lv > best) (best = lv), (id = alias);
    }
    return { level: best, id };
  }

  private difficulty(info: NpcDialogInfo, kind: string): number {
    const t = info.rec.traits;
    const sk = JOBS[info.rec.job].skills;
    switch (kind) {
      case 'persuasion':
        return Math.round(clamp(18 + (sk.persuasion ?? 10) * 0.4 + t.conscientiousness * 10 - t.agreeableness * 10 + (info.rec.leader ? 10 : 0), 5, 95));
      case 'intimidation':
        return Math.round(clamp(20 + t.courage * 25 + JOBS[info.rec.job].combat * 30 + (sk.intimidation ?? 0) * 0.3, 5, 95));
      case 'barter':
        return Math.round(clamp(15 + (sk.barter ?? 10) * 0.6 + t.greed * 15, 5, 95));
      default:
        return Math.round(clamp(25 + (sk.lore ?? 10) * 0.35 + t.openness * 5, 5, 95));
    }
  }

  private chance(player: ServerEntity, info: NpcDialogInfo, kind: string, diff: number): number {
    const lv = this.playerSkill(player, kind).level;
    const d = this.disp(player, info);
    // Skill dominates, difficulty and disposition shift it; even novices get a sliver of hope.
    return clamp(0.35 + lv / 60 - diff / 120 + (kind === 'intimidation' ? -d / 500 : d / 250), 0.05, 0.95);
  }

  private checkChoice(s: Session, player: ServerEntity, info: NpcDialogInfo, out: DialogChoice[], id: string, skill: string, text: string) {
    if (s.checks.has(id)) return;
    const diff = this.difficulty(info, skill);
    const ch = this.chance(player, info, skill, diff);
    out.push({ id, text, kind: 'check', check: { skill, difficulty: diff, chance: Math.round(ch * 100) / 100 }, hint: `${Math.round(ch * 100)}%` });
  }

  private roll(s: Session, player: ServerEntity, info: NpcDialogInfo, skill: string, tag: string): boolean {
    const diff = this.difficulty(info, skill);
    const ch = this.chance(player, info, skill, diff);
    const ok = new Rng(deriveSeed(hashString(s.id), tag, s.turn)).chance(ch);
    const sk = this.playerSkill(player, skill);
    try {
      this.ctx.services.skills.grantXp(player, sk.id, ok ? 12 + diff * 0.3 : 5);
    } catch {
      /* skill unknown to the gameplay module */
    }
    this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'skillCheck', data: { skill, difficulty: diff, chance: ch, success: ok } });
    return ok;
  }

  // ================================================================== choices

  private onChoice(s: Session, player: ServerEntity, choice: string) {
    if (s.pending) return;
    const bridge = this.npcs;
    const info = bridge?.npcInfo(s.npcId);
    if (!bridge || !info) return this.close(s, true);
    const said = s.says.get(choice);
    if (said !== undefined) return this.onText(s, player, said);
    const [head, arg] = choice.split(':');
    const echoText = this.echoTextFor(s, info, player, head, arg);
    const echo = echoText ? this.echo(player, echoText) : [];
    if (echoText) s.history.push({ who: 'player', text: echoText });
    this.runTopic(s, player, info, head, arg, echo);
  }

  private echoTextFor(s: Session, info: NpcDialogInfo, player: ServerEntity, head: string, arg?: string): string {
    const place = info.site?.name ?? 'this place';
    switch (head) {
      case 'person': {
        const p = s.people[Number(arg)];
        return p ? `What can you tell me about ${p.given}?` : '';
      }
      case 'dir': {
        const l = s.landmarks[Number(arg)];
        return l ? `Where would I find ${l.name}?` : '';
      }
      case 'qaccept':
        return s.rng.pick(["I'll do it.", 'Consider it done.', 'You can count on me.']);
      case 'qdecline':
        return s.rng.pick(['Not right now.', "I can't help with that.", 'Perhaps another time.']);
      case 'qhaggle':
        return "[Persuade] That's dangerous work. I'd want more for it.";
      case 'back':
        return '';
      default: {
        const k = head as keyof typeof P;
        if (head === 'barter') return '[Barter] Surely you can do better on prices.';
        if (head === 'persuade') return '[Persuade] Come now, tell me what you really know.';
        if (head === 'intimidate') return '[Intimidate] Tell me what you know. Now.';
        if (head === 'lore') return info.deity ? `[Lore] Speak of ${info.deity.name}, ${info.deity.epithet}.` : '[Lore] Tell me of the old legends.';
        return P[k] ? this.pickP(s, k, { place }) : '';
      }
    }
  }

  /** Execute a topic and send the resulting view. */
  private runTopic(s: Session, player: ServerEntity, info: NpcDialogInfo, head: string, arg: string | undefined, echo: DialogLine[]) {
    const bridge = this.npcs!;
    const lines: DialogLine[] = [];
    let choices: DialogChoice[] | null = null;
    let openTrade = false;
    let ended = false;
    const T = info.rec.traits;
    const L = (key: string, mood?: Mood, extra?: LineVars) => lines.push(this.line(s, player, info, key, mood, extra));
    s.asked.add(head);
    switch (head) {
      case 'about': {
        L('self.intro');
        L(`self.job.${info.rec.job}`);
        this.familyLine(s, player, info, lines);
        break;
      }
      case 'story': {
        lines.push({ speaker: '', text: info.rec.bio });
        L('smalltalk');
        break;
      }
      case 'mood': {
        const m = info.mood;
        L(`self.mood.${m === 'happy' || m === 'sad' || m === 'angry' || m === 'afraid' ? m : 'content'}`, m === 'neutral' || m === 'focused' ? 'neutral' : m);
        const needs = Object.entries(info.st.needs).filter(([, v]) => v < 0.35).sort((a, b) => a[1] - b[1]);
        if (needs.length) L(`self.need.${needs[0][0]}`);
        if (info.goal) L(info.goal.progress > 0.3 ? 'goal.progress' : 'goal.pitch', 'focused', { goal: info.goal.desc });
        else if (!needs.length) L('goal.none');
        break;
      }
      case 'place':
        this.placeLines(s, player, info, lines);
        break;
      case 'people':
        lines.push(this.raw(info, s.rng.pick(['Everyone knows everyone here. Who do you mean?', 'Depends who you are asking after.', `Folk in ${info.site?.name ?? 'these parts'}? Name one.`, 'Ask away. I know most faces.'])));
        choices = s.people.slice(0, 7).map((p, i) => ({ id: `person:${i}`, text: `${p.given}${p.relation ? ` (${p.relation})` : `, the ${p.job}`}`, kind: 'topic' as const }));
        choices.push({ id: 'back', text: this.pickP(s, 'back'), kind: 'back' });
        break;
      case 'person': {
        const p = s.people[Number(arg)];
        if (p) this.personLines(s, player, info, p, lines);
        break;
      }
      case 'rumors':
        this.rumorLines(s, player, info, lines);
        break;
      case 'directions':
        L('dir.unknown');
        lines.pop();
        lines.push(this.raw(info, s.rng.pick(['Where are you headed?', 'Looking for something in particular?', 'Depends where you want to go.'])));
        choices = s.landmarks.map((l, i) => ({ id: `dir:${i}`, text: cap(l.name), kind: 'topic' as const }));
        choices.push({ id: 'back', text: this.pickP(s, 'back'), kind: 'back' });
        break;
      case 'dir': {
        const lm = s.landmarks[Number(arg)];
        if (lm) this.directionLines(s, player, info, lm, lines);
        break;
      }
      case 'agenda': {
        const offer = bridge.questOffer(info.entity.id, player);
        s.offer = offer;
        s.rewardMul = 1;
        if (offer) {
          L('quest.offer', 'focused', { goal: offer.goal, reward: this.rewardPhrase(offer) });
          choices = this.questChoices(s, player, info);
        } else {
          const open = bridge.openQuests(info.entity.id, player);
          if (open.length) L('quest.active', 'focused', { goal: open[0].goal });
          else if (info.goal) L('goal.progress', 'neutral', { goal: info.goal.desc });
          else L('goal.none');
        }
        break;
      }
      case 'qaccept': {
        const offer = s.offer;
        if (!offer) break;
        const qid = bridge.acceptQuest(info.entity.id, player, offer.goalId, s.rewardMul);
        if (qid) {
          L('quest.accepted', 'happy');
          bridge.gesture(info.entity.id, s.rng.pick(['bow', 'gesture_wave', 'cheer']));
          this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'questAccepted', data: { quest: qid, goal: offer.goal } });
        } else L('goal.none');
        s.offer = null;
        break;
      }
      case 'qdecline':
        L('quest.declined', s.offer?.wanted ? 'sad' : 'neutral');
        if (s.offer?.wanted) bridge.adjustDisposition(info.entity.id, player.id, -2, 'turned down my plea for help');
        s.offer = null;
        break;
      case 'qhaggle': {
        s.checks.add('qhaggle');
        if (this.roll(s, player, info, 'persuasion', 'haggle')) {
          s.rewardMul = 1.35;
          L('check.persuade.ok', 'neutral');
          if (s.offer) L('quest.offer', 'focused', { goal: s.offer.goal, reward: this.rewardPhrase(s.offer, s.rewardMul) });
        } else {
          L('check.persuade.fail', 'disgusted');
          bridge.adjustDisposition(info.entity.id, player.id, -3, 'haggled over my plea');
        }
        choices = this.questChoices(s, player, info);
        break;
      }
      case 'trade': {
        const open = info.wanderer !== null || info.activity === 'work' || info.activity === 'market' || info.activity === 'goal' || info.activity === 'talk';
        const d = this.disp(player, info);
        if (d < -40) L('trade.refuse', 'disgusted');
        else if (!open && this.ctx.time.hour > 20 || this.ctx.time.hour < 6) L('trade.closed');
        else {
          L('trade.offer', 'happy');
          s.canTrade = true;
          openTrade = true;
          this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'trade', data: { npc: info.entity.id, priceModifier: bridge.priceModifier(info.entity.id, player.id) } });
        }
        break;
      }
      case 'barter': {
        s.checks.add('barter');
        if (this.roll(s, player, info, 'barter', 'barter')) {
          L('check.barter.ok', 'neutral');
          bridge.setPriceModifier(info.entity.id, player, 0.85);
          this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'priceChanged', data: { modifier: 0.85 } });
        } else {
          L('check.barter.fail', 'disgusted');
          bridge.setPriceModifier(info.entity.id, player, 1.08);
        }
        break;
      }
      case 'persuade': {
        s.checks.add('persuade');
        if (this.roll(s, player, info, 'persuasion', 'persuade')) {
          L('check.persuade.ok', 'neutral');
          this.secretLine(s, player, info, lines);
          bridge.adjustDisposition(info.entity.id, player.id, 3, 'listened to me');
        } else {
          L('check.persuade.fail', 'disgusted');
          bridge.adjustDisposition(info.entity.id, player.id, -3, 'pestered me');
        }
        break;
      }
      case 'intimidate': {
        s.checks.add('intimidate');
        if (this.roll(s, player, info, 'intimidation', 'intimidate')) {
          L('check.intimidate.ok', 'afraid');
          this.secretLine(s, player, info, lines);
          bridge.adjustDisposition(info.entity.id, player.id, -8, 'threatened me');
        } else {
          L('check.intimidate.fail', T.courage > 0.2 ? 'angry' : 'afraid');
          bridge.adjustDisposition(info.entity.id, player.id, -12, 'tried to bully me');
        }
        break;
      }
      case 'lore': {
        s.checks.add('lore');
        if (this.roll(s, player, info, 'lore', 'lore')) {
          L('check.lore.ok', 'happy');
          const extra = this.loreReveal(s, info);
          if (extra) lines.push(this.raw(info, extra, 'focused'));
          bridge.adjustDisposition(info.entity.id, player.id, 6, 'knows the old lore');
        } else L('check.lore.fail', 'neutral');
        break;
      }
      case 'compliment': {
        s.compliments++;
        const d = this.disp(player, info);
        if (s.compliments > 1 || d < -30) {
          L('compliment.suspicious', 'disgusted');
          bridge.adjustDisposition(info.entity.id, player.id, -1, 'laid on the flattery');
        } else if (s.rng.chance(0.55 + T.extraversion * 0.2 + T.agreeableness * 0.1)) {
          L('compliment.ok', 'happy');
          bridge.adjustDisposition(info.entity.id, player.id, s.rng.int(4, 8), 'paid me a kind word');
          bridge.gesture(info.entity.id, 'bow');
        } else L('compliment.flat', 'neutral');
        this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'compliment' });
        break;
      }
      case 'insult': {
        s.insults++;
        const key = T.courage > 0.25 || info.rec.job === 'guard' ? 'insult.angry' : T.extraversion > 0.4 && T.agreeableness > 0.2 ? 'insult.laugh' : T.courage < -0.2 ? 'insult.afraid' : 'insult.mild';
        L(key, key === 'insult.angry' ? 'angry' : key === 'insult.afraid' ? 'afraid' : key === 'insult.laugh' ? 'happy' : 'disgusted');
        bridge.adjustDisposition(info.entity.id, player.id, -s.rng.int(8, 16) * (s.insults > 1 ? 1.5 : 1), 'insulted me to my face');
        bridge.rememberPlayer(info.entity.id, player, `${player.name} insulted ${info.rec.given}`, 'player', 0.45);
        this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'insult' });
        if (s.insults > 1 || this.disp(player, info) < -60) {
          L('refuse.talk', 'angry');
          ended = true;
        }
        break;
      }
      case 'apologize': {
        const d = bridge.dispositionInfo(info.entity.id, player);
        if (s.rng.chance(0.4 + T.agreeableness * 0.3 + (info.deity ? 0.1 : 0))) {
          L('apology.accept', 'neutral');
          bridge.adjustDisposition(info.entity.id, player.id, clamp(-d.value * 0.3, 3, 15), 'apologised');
        } else L('apology.reject', 'angry');
        s.checks.add('apologize');
        break;
      }
      case 'back':
        lines.push(this.raw(info, s.rng.pick(['Mm?', 'Go on.', 'What else?', 'Yes?']), 'neutral'));
        break;
      case 'bye':
        this.farewell(s, player, false, echo);
        return;
    }
    if (!lines.length) L('smalltalk');
    this.send(s, player, info, echo, lines, ended ? [] : choices ?? this.rootChoices(s, player, info), { openTrade, ended });
  }

  private questChoices(s: Session, player: ServerEntity, info: NpcDialogInfo): DialogChoice[] {
    const c: DialogChoice[] = [{ id: 'qaccept', text: s.rng.pick(["I'll do it.", 'Consider it done.', 'You can count on me.']), kind: 'quest', hint: 'Accept quest' }];
    if (!s.checks.has('qhaggle')) {
      const diff = this.difficulty(info, 'persuasion');
      const ch = this.chance(player, info, 'persuasion', diff);
      c.push({ id: 'qhaggle', text: "[Persuade] That's dangerous work. I'd want more for it.", kind: 'check', check: { skill: 'persuasion', difficulty: diff, chance: Math.round(ch * 100) / 100 }, hint: `${Math.round(ch * 100)}%` });
    }
    c.push({ id: 'qdecline', text: s.rng.pick(['Not right now.', "I can't help with that.", 'Perhaps another time.']), kind: 'back' });
    return c;
  }

  private rewardPhrase(o: QuestOffer, mul = 1): string {
    const r = o.spec.rewards;
    const parts: string[] = [];
    if (r.coins) parts.push(`${Math.round(r.coins * mul)} coins`);
    if (r.items?.length) parts.push(r.items.join(', '));
    if (r.text && !parts.length) parts.push(r.text.toLowerCase());
    return parts.join(' and ') || 'my thanks';
  }

  private farewell(s: Session, player: ServerEntity, fromClient: boolean, echo: DialogLine[] = []) {
    const info = this.npcs?.npcInfo(s.npcId);
    if (!info) return this.close(s, true);
    const tier = dispTier(this.disp(player, info));
    const key = tier === 'hostile' || tier === 'cold' ? 'bye.cold' : tier === 'neutral' ? 'bye.neutral' : 'bye.warm';
    const lines = [this.line(s, player, info, key, tier === 'friend' || tier === 'warm' ? 'happy' : undefined)];
    if (tier === 'friend' || tier === 'warm') this.npcs?.gesture(info.entity.id, 'gesture_wave');
    void fromClient;
    this.send(s, player, info, echo, lines, [], { ended: true });
  }

  // ================================================================== topic content

  private familyLine(s: Session, player: ServerEntity, info: NpcDialogInfo, lines: DialogLine[]) {
    const fam = s.people.filter((p) => p.relation);
    const spouse = fam.find((p) => /wife|husband|spouse/.test(p.relation ?? ''));
    const kids = fam.filter((p) => /son|daughter|child/.test(p.relation ?? ''));
    if (spouse && !spouse.alive) lines.push(this.line(s, player, info, 'self.family.widowed', 'sad', { spouse: spouse.given }));
    else if (spouse) lines.push(this.line(s, player, info, 'self.family.spouse', 'happy', { spouse: spouse.given }));
    if (kids.length) {
      const names = kids.map((k) => k.given);
      const children = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      lines.push(this.line(s, player, info, 'self.family.children', 'happy', { children, count: kids.length }));
    }
    if (!spouse && !kids.length && info.rec.ageStage !== 'child') lines.push(this.line(s, player, info, 'self.family.none'));
  }

  private placeLines(s: Session, player: ServerEntity, info: NpcDialogInfo, lines: DialogLine[]) {
    const site = info.site;
    if (!site) {
      lines.push(this.line(s, player, info, 'smalltalk'));
      return;
    }
    const L = (key: string, extra?: LineVars) => lines.push(this.line(s, player, info, key, undefined, extra));
    L('place.intro');
    const opts: (() => void)[] = [() => L(`place.size.${site.size}`), () => L('place.biome')];
    const leader = s.people.find((p) => p.id !== info.rec.id && info.layout && /elder|lord|lady|steward|reeve|thane|headman|speaker|noble/i.test(p.job + ' ' + p.name)) ?? null;
    const lrec = info.layout ? this.leaderName(s) : null;
    if (lrec && !info.rec.leader) opts.push(() => L('place.leader', { leader: lrec }));
    if (site.walled) opts.push(() => L('place.walls'));
    if (info.layout) opts.push(() => L(info.layout!.wealth > 0.55 ? 'place.rich' : info.layout!.wealth < 0.3 ? 'place.poor' : `place.size.${site.size}`));
    if (info.deity) opts.push(() => L('place.faith'));
    if (site.race2) opts.push(() => L('place.mixed'));
    // Grounded local lore from the game master's world history.
    try {
      const sl = siteLore(this.ctx.gen.profile, site);
      opts.push(() => lines.push(this.raw(info, s.rng.pick([`We're known for ${sl.known}, if you're asking.`, `Folk come from far off for our ${sl.known}.`]))));
      opts.push(() => lines.push(this.raw(info, s.rng.pick([`The trouble lately? ${cap(sl.trouble)}.`, `Not everything's well. ${cap(sl.trouble)}, and nobody's doing much about it.`]), 'sad')));
      opts.push(() => lines.push(this.raw(info, `${cap(site.name)} was ${sl.founded}.`)));
      if (info.layout?.buildings.some((b) => b.role === 'tavern')) opts.push(() => lines.push(this.raw(info, s.rng.pick([`Thirsty? ${cap(sl.inn)} pours the best in town.`, `Try ${sl.inn}. Warm fire, honest ale.`]), 'happy')));
    } catch {
      /* lore module unavailable: templated lines suffice */
    }
    void leader;
    s.rng.shuffle(opts);
    for (const f of opts.slice(0, 2 + (info.rec.traits.extraversion > 0.3 ? 1 : 0))) f();
  }

  private leaderName(s: Session): string | null {
    const p = s.people.find((x) => x.relation === null && /elder|noble/.test(x.job));
    return p?.name ?? null;
  }

  private personLines(s: Session, player: ServerEntity, info: NpcDialogInfo, p: NpcPerson, lines: DialogLine[]) {
    const L = (key: string, mood?: Mood, extra?: LineVars) => lines.push(this.line(s, player, info, key, mood, { person: p.given, relation: p.relation ?? 'neighbour', ...extra }));
    if (!p.alive) {
      L('people.dead', 'sad');
      return;
    }
    const a = p.affinity;
    if (a >= 60) L('people.love', 'happy');
    else if (a >= 20) L('people.like', 'happy');
    else if (a <= -60) L('people.hate', 'angry');
    else if (a <= -20) L('people.dislike', 'disgusted');
    else L('people.neutral');
    const where = p.away ? `${p.given} is away — ${p.activity}.` : s.rng.pick([`Right now ${p.given} is ${p.activity}, I'd wager.`, `You'll find ${p.given} ${p.activity} about now.`, `${cap(p.job)} by trade. Probably ${p.activity}.`]);
    lines.push(this.raw(info, where));
  }

  private rumorLines(s: Session, player: ServerEntity, info: NpcDialogInfo, lines: DialogLine[]) {
    const bridge = this.npcs!;
    const L = (key: string, mood?: Mood, extra?: LineVars) => lines.push(this.line(s, player, info, key, mood, extra));
    const here = info.entity.pos;
    L('rumor.intro', 'focused');
    let told = 0;
    const pkey = `P:${player.name}`;
    for (const m of bridge.rumors(info.entity.id, 6)) {
      if (told >= 2) break;
      // Talk about the player happens in greetings, not as gossip to their face.
      if (m.about === pkey || m.text.includes(player.name)) continue;
      if (s.asked.has(`r:${m.id}`)) continue;
      s.asked.add(`r:${m.id}`);
      L(m.heard ? 'rumor.heard' : 'rumor.memory', m.kind === 'death' ? 'sad' : m.kind === 'monster' || m.kind === 'crime' ? 'afraid' : 'surprised', { fact: m.text });
      bridge.told(info.entity.id, m.id);
      if (m.pos) {
        const w = describeWay(here, m.pos, info.rec.race);
        if (w.meters > 40) lines.push(this.raw(info, s.rng.pick([`That was ${w.dist} ${w.dir} of here.`, `Off to the ${w.dir}, ${w.dist}.`])));
        this.ctx.services.gm.narrate(player, cap(m.text) + '.', 'rumor', m.pos);
      }
      told++;
    }
    if (told < 2 && !s.asked.has('lore-rumor')) {
      // World lore: named places and old tales from the game master's history.
      try {
        const known = getPlayerData(this.ctx, player.id)?.discovered;
        const r = rumorsAbout(this.ctx.gen.profile, { x: here[0], z: here[2], pois: this.ctx.gen.sites.poisNear(here[0], here[2], 1200), sites: this.ctx.gen.sites.sitesNear(here[0], here[2], 1500).filter((x) => x.id !== info.site?.id), known }, s.rng, 1)[0];
        if (r) {
          s.asked.add('lore-rumor');
          lines.push(this.raw(info, r, 'focused'));
          told++;
        }
      } catch {
        /* lore module unavailable */
      }
    }
    if (told < 2) {
      // Places and beasts nearby make for rumors too.
      const pois = s.allLandmarks.filter((l) => /ruin|shrine|camp|lair|grove|monolith|tower|battlefield|crashsite|well|wayshrine|obelisk/.test(l.kind) && !s.asked.has(`p:${l.id}`));
      if (pois.length) {
        const p = s.rng.pick(pois);
        s.asked.add(`p:${p.id}`);
        const w = describeWay(here, p.pos, info.rec.race);
        L(`rumor.poi.${p.kind}`, 'focused', { dir: w.dir, dist: w.dist, poi: p.name.replace(/^the /, '') });
        this.ctx.services.gm.narrate(player, `${cap(p.name)} lies ${w.dist} to the ${w.dir}, they say.`, 'rumor', p.pos);
        told++;
      }
    }
    if (told < 2) {
      const cr = bridge.creaturesNear(info.entity.id).filter((c) => !s.asked.has(`c:${c}`));
      if (cr.length) {
        const c = s.rng.pick(cr);
        s.asked.add(`c:${c}`);
        L('rumor.creature', 'afraid', { creature: c, dir: s.rng.pick(['the woods', 'the hills', 'the fields', 'the old road']) });
        told++;
      }
    }
    if (told === 0) {
      const sites = s.allLandmarks.filter((l) => /hamlet|village|town|city/.test(l.kind) && !s.asked.has(`s:${l.id}`));
      if (sites.length) {
        const t = s.rng.pick(sites);
        s.asked.add(`s:${t.id}`);
        const w = describeWay(here, t.pos, info.rec.race);
        L('rumor.site', 'neutral', { target: t.name, dir: w.dir, dist: w.dist });
      } else L('rumor.none');
    }
  }

  private directionLines(s: Session, player: ServerEntity, info: NpcDialogInfo, lm: Landmark, lines: DialogLine[]) {
    const w = describeWay(info.entity.pos, lm.pos, info.rec.race);
    if (w.meters < 12) lines.push(this.line(s, player, info, 'dir.here', 'happy', { target: lm.name }));
    else lines.push(this.line(s, player, info, 'dir.answer', 'neutral', { target: lm.name, dir: w.dir, dist: w.dist }));
    this.npcs?.gesture(info.entity.id, 'gesture_point', 1.4);
    if (w.meters > 60) this.ctx.services.gm.narrate(player, `${cap(lm.name)}: ${w.dist} to the ${w.dir}.`, 'hint', lm.pos);
  }

  /** A secret: crush, debt, rivalry, ambition or the most important private memory. */
  private secretLine(s: Session, player: ServerEntity, info: NpcDialogInfo, lines: DialogLine[]) {
    const crush = s.people.find((p) => p.relation && /crush|sweet/.test(p.relation)) ?? s.people.find((p) => info.st.relKind[p.id] === 'crush' || info.rec.relations[p.id]?.kind === 'crush');
    const creditor = s.people.find((p) => info.rec.relations[p.id]?.kind === 'creditor');
    const rival = s.people.find((p) => info.rec.relations[p.id]?.kind === 'rival');
    const priv = info.st.mem.filter((m) => !m.heard && (m.kind === 'personal' || m.kind === 'love' || m.kind === 'crime')).sort((a, b) => b.imp - a.imp)[0];
    const facts: string[] = [];
    if (crush) facts.push(`I am sweet on ${crush.given}, and I have never dared say it`);
    if (creditor) facts.push(`I owe ${creditor.given} more coin than I can pay`);
    if (rival) facts.push(`${rival.given} and I cannot stand each other`);
    if (priv) facts.push(priv.text);
    facts.push(`I dream ${info.rec.ambition.replace(/^to /, 'to ')}`);
    const fact = facts[s.rng.int(0, Math.min(facts.length - 1, 2))];
    lines.push(this.line(s, player, info, 'secret.reveal', 'focused', { fact }));
    this.npcs?.rememberPlayer(info.entity.id, player, `${info.rec.given} told ${player.name} a secret`, 'player', 0.35);
  }

  private loreReveal(s: Session, info: NpcDialogInfo): string | null {
    // Prefer the world's recorded legends (shared with the game master).
    try {
      const prof = this.ctx.gen.profile;
      const leg = (info.site && s.rng.chance(0.5) ? biomeLegend(prof, info.site.biome) : undefined) ?? (info.deity ? searchLore(prof, info.deity.name, 1)[0] : undefined) ?? s.rng.pick(getLore(prof).legends);
      if (leg) return `${s.rng.pick(['You know the old tales, then. Do you know this one?', 'Then you will appreciate this:', 'Few ask about such things anymore.'])} ${leg.text}`;
    } catch {
      /* fall back to local lore */
    }
    if (info.deity && s.rng.chance(0.6)) {
      const g = info.deity;
      return s.rng.pick([
        `${g.name} watches over ${g.domain}. The old rite says three offerings at dusk, never four.`,
        `Few remember that ${g.name} was once called ${g.epithet} only by the faithful. You know your rites.`,
        `They say ${g.name}'s favour falls on those who honour ${g.domain} in deed, not word.`,
      ]);
    }
    const pois = s.allLandmarks.filter((l) => /ruin|shrine|monolith|tower|battlefield|obelisk|grove|crashsite/.test(l.kind));
    if (!pois.length) return null;
    const p = s.rng.pick(pois);
    const w = describeWay(info.entity.pos, p.pos, info.rec.race);
    return s.rng.pick([
      `Since you know the old tales: ${p.name} to the ${w.dir} was raised before any kingdom we remember. Something sleeps beneath it.`,
      `Scholars argue about ${p.name}, ${w.dist} ${w.dir}. I say it was a waystation of the sky-folk.`,
      `Look for marks at ${p.name} that only show at dusk. Few know that.`,
    ]);
  }

  /** Directions menu: a few places in town plus the nearest settlements & sights beyond. */
  private pickLandmarks(s: Session, all: Landmark[], info: NpcDialogInfo): Landmark[] {
    const here = info.entity.pos;
    const d = (l: Landmark) => Math.hypot(l.pos[0] - here[0], l.pos[2] - here[2]);
    all.sort((a, b) => d(a) - d(b));
    const inTown = all.filter((l) => d(l) < 200 && d(l) > 12);
    const sites = all.filter((l) => d(l) >= 200 && /hamlet|village|town|city/.test(l.kind)).slice(0, 2);
    const sights = all.filter((l) => d(l) >= 200 && !sites.includes(l)).slice(0, 2);
    return [...s.rng.shuffle(inTown).slice(0, 4), ...sites, ...sights];
  }

  // ================================================================== free text

  private onText(s: Session, player: ServerEntity, text: string) {
    if (s.pending) return;
    const bridge = this.npcs;
    const info = bridge?.npcInfo(s.npcId);
    if (!bridge || !info) return this.close(s, true);
    const echo = this.echo(player, text);
    const brain: DialogBrain = this.llm ?? this.scripted;
    // Context first: the brain appends the new player line itself.
    const ctx = this.brainContext(s, player, info);
    s.history.push({ who: 'player', text });
    const reply = brain.respond(ctx, text);
    if (reply instanceof Promise) {
      s.pending = true;
      this.send(s, player, info, echo, [], [], { thinking: true, brain: brain.id });
      reply
        .then((r) => {
          s.pending = false;
          if (s.ended) return;
          const p = this.ctx.entities.get(s.playerId);
          const i2 = this.npcs?.npcInfo(s.npcId);
          if (p && i2) this.applyReply(s, p, i2, r, []);
        })
        .catch((err) => {
          s.pending = false;
          this.ctx.log('dialog: LLM failed, using scripted brain', String(err));
          if (s.ended) return;
          const p = this.ctx.entities.get(s.playerId);
          const i2 = this.npcs?.npcInfo(s.npcId);
          if (p && i2) this.applyReply(s, p, i2, this.scripted.respond(ctx, text), []);
        });
      return;
    }
    this.applyReply(s, player, info, reply, echo);
  }

  private applyReply(s: Session, player: ServerEntity, info: NpcDialogInfo, r: BrainReply, echo: DialogLine[]) {
    const bridge = this.npcs!;
    // Scripted: map the intent onto a topic.
    const topic = r.actions.find((a): a is Extract<typeof a, { type: 'topic' }> => a.type === 'topic');
    if (topic) return this.runIntent(s, player, info, topic.topic, topic.nameHit, echo);
    const lines: DialogLine[] = r.lines.map((l) => this.raw(info, l.text, l.mood));
    let choices: DialogChoice[] = [];
    let openTrade = false;
    let ended = false;
    s.says.clear();
    (r.suggestions ?? []).forEach((t, i) => {
      s.says.set(`say${s.turn}_${i}`, t);
      choices.push({ id: `say${s.turn}_${i}`, text: t, kind: 'say' });
    });
    for (const a of r.actions) {
      switch (a.type) {
        case 'disposition':
          bridge.adjustDisposition(info.entity.id, player.id, a.delta, a.reason);
          break;
        case 'remember':
          bridge.rememberPlayer(info.entity.id, player, a.text, 'player', a.importance);
          break;
        case 'gesture':
          bridge.gesture(info.entity.id, a.anim);
          break;
        case 'trade':
          if (JOBS[info.rec.job].merchant) {
            s.canTrade = true;
            openTrade = true;
            this.ctx.bus.emit('dialogEvent', { player, npc: info.entity, event: 'trade', data: { npc: info.entity.id } });
          }
          break;
        case 'offerQuest': {
          const offer = bridge.questOffer(info.entity.id, player);
          if (offer) {
            s.offer = offer;
            lines.push(this.line(s, player, info, 'quest.offer', 'focused', { goal: offer.goal, reward: this.rewardPhrase(offer) }));
            choices = [...this.questChoices(s, player, info), ...choices];
          }
          break;
        }
        case 'end':
          ended = true;
          break;
      }
    }
    if (!lines.length) lines.push(this.line(s, player, info, 'confused'));
    if (!ended) {
      // Always keep the structured topics reachable.
      choices.push({ id: 'agenda', text: this.pickP(s, 'agenda'), kind: 'quest' });
      if (JOBS[info.rec.job].merchant) choices.push({ id: 'trade', text: this.pickP(s, 'trade'), kind: 'trade' });
      choices.push({ id: 'bye', text: this.pickP(s, 'bye'), kind: 'exit', exit: true });
    }
    this.send(s, player, info, echo, lines, ended ? [] : choices, { openTrade, ended, brain: r.brain });
  }

  private runIntent(s: Session, player: ServerEntity, info: NpcDialogInfo, intent: Intent, nameHit: number, echo: DialogLine[]) {
    const nPeople = s.people.length;
    // Named people and places take precedence.
    if (nameHit >= 0) {
      if (nameHit < nPeople) return this.runTopic(s, player, info, 'person', String(nameHit), echo);
      const li = nameHit - nPeople;
      if (s.landmarks[li]) return this.runTopic(s, player, info, 'dir', String(li), echo);
    }
    const map: Partial<Record<Intent, string>> = {
      about: 'about', job: 'about', place: 'place', people: 'people', family: 'about', rumors: 'rumors', directions: 'directions', agenda: 'agenda', trade: 'trade',
      bye: 'bye', compliment: 'compliment', insult: 'insult', apologize: 'apologize', mood: 'mood',
    };
    if (intent === 'yes' && s.offer) return this.runTopic(s, player, info, 'qaccept', undefined, echo);
    if (intent === 'no' && s.offer) return this.runTopic(s, player, info, 'qdecline', undefined, echo);
    // Asking for a kind of place this settlement doesn't have.
    if (intent === 'directions') {
      const roles = ['tavern', 'inn', 'smithy', 'forge', 'market', 'temple', 'shrine', 'barracks', 'library', 'tower', 'hall', 'stable', 'mill', 'healer'];
      const text = s.history[s.history.length - 1]?.text.toLowerCase() ?? '';
      const asked = roles.find((r) => text.includes(r));
      const want = asked === 'inn' ? 'tavern' : asked === 'forge' ? 'smithy' : asked;
      const known = asked ? s.allLandmarks.find((l) => l.name.includes(want!)) : undefined;
      if (known) {
        const w = describeWay(info.entity.pos, known.pos, info.rec.race);
        const lines = [w.meters < 12 ? this.line(s, player, info, 'dir.here', 'happy', { target: known.name }) : this.line(s, player, info, 'dir.answer', 'neutral', { target: known.name, dir: w.dir, dist: w.dist })];
        this.npcs?.gesture(info.entity.id, 'gesture_point', 1.4);
        return this.send(s, player, info, echo, lines, this.rootChoices(s, player, info));
      }
      if (asked) {
        return this.send(s, player, info, echo, [this.line(s, player, info, 'dir.unknown', 'neutral', { target: `a ${asked}` })], this.rootChoices(s, player, info));
      }
    }
    const topic = map[intent];
    if (topic) return this.runTopic(s, player, info, topic, undefined, echo);
    const lines: DialogLine[] = [];
    switch (intent) {
      case 'greet':
        lines.push(this.line(s, player, info, `greet.${dispTier(this.disp(player, info))}`));
        break;
      case 'thanks':
        lines.push(this.line(s, player, info, 'thanks', 'happy'));
        break;
      case 'faith':
        lines.push(info.deity ? this.line(s, player, info, 'place.faith') : this.raw(info, `${oath(this.speaker(info), s.rng)} I leave the gods to the priests.`));
        break;
      case 'weather':
        lines.push(this.line(s, player, info, 'rumor.weather'));
        break;
      default:
        lines.push(this.line(s, player, info, 'confused', 'surprised'));
    }
    this.send(s, player, info, echo, lines, this.rootChoices(s, player, info));
  }

  private brainContext(s: Session, player: ServerEntity, info: NpcDialogInfo): BrainContext {
    const bridge = this.npcs!;
    const r = info.rec;
    const d = bridge.dispositionInfo(info.entity.id, player);
    const gender = r.gender > 0.65 ? 'man' : r.gender < 0.35 ? 'woman' : 'person';
    const persona = `${r.name}, a ${r.age}-year-old ${RACE_ADJ[r.race]}${r.race2 ? ` (of mixed ${RACE_ADJ[r.race2]} blood)` : ''} ${gender}; ${r.title}. Personality: ${traitWords(r.traits).join(', ') || 'even-tempered'}. Voice: ${VOICE_NOTE[r.race]}${r.ageStage === 'child' ? '; a child, speaks simply' : r.ageStage === 'elder' ? '; old, reminiscent' : ''}. Biography: ${r.bio} Secret dream: ${r.ambition}.${info.deity ? ` Worships ${info.deity.name}, ${info.deity.epithet}.` : ''}`;
    const needs = Object.entries(info.st.needs).filter(([, v]) => v < 0.4).map(([k, v]) => `${k} ${v < 0.2 ? 'desperate' : 'low'}`).join(', ') || 'content';
    const facts: Record<string, string> = { ...bridge.worldFacts(info.entity.id), activity: info.activityLabel, mood: info.mood };
    try {
      facts.history = loreSummary(this.ctx.gen.profile).slice(0, 700);
      if (info.site) {
        const sl = siteLore(this.ctx.gen.profile, info.site);
        facts.localLore = `${sl.founded}; known for ${sl.known}; current trouble: ${sl.trouble}; the inn is ${sl.inn}`;
      }
    } catch {
      /* lore module unavailable */
    }
    const memories = [...info.st.mem].sort((a: Memory, b: Memory) => b.imp - a.imp).slice(0, 10).map((m) => `${m.heard ? '(heard) ' : ''}${m.text}`);
    const relations = s.people.slice(0, 8).map((p) => `${p.name} — ${p.relation ?? p.job}, ${p.alive ? p.activity : 'dead'}, feelings ${p.affinity}`);
    const offer = bridge.questOffer(info.entity.id, player);
    return {
      npcName: r.name, playerName: player.name, persona, facts, memories, needs, goal: info.goal?.desc ?? null, relations, disposition: d.value, dispositionReasons: d.reasons,
      canTrade: !!JOBS[r.job].merchant, questAvailable: offer?.goal ?? null, history: s.history.slice(-14), names: [...s.people.map((p) => p.name), ...s.landmarks.map((l) => l.name)],
    };
  }

  // ================================================================== persistence

  save() {
    // LLM credentials are deliberately not persisted.
    return undefined;
  }
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
