/**
 * The virtual Game Master. Inspired by the "AI game master" idea: an always-on
 * narrator and director that runs the world like a tabletop GM — it watches what
 * each player does, learns how they like to play, paces tension, stages events
 * and consequences, writes quests grounded in the world's lore, narrates in the
 * second person, keeps the journal, and answers when spoken to.
 *
 * Composition (all per player, keyed by player name so it survives save/load):
 *   PlayerModel  playstyle inference + history          (PlayerModel.ts)
 *   Narrator     narration triggers, recaps             (Narrator.ts)
 *   Director     tension curve, events, consequences    (Director.ts)
 *   QuestBook    quest runtime & journal views          (QuestBook.ts)
 *   QuestForge   GM-authored quests & personal arcs     (QuestForge.ts)
 *   Oracle       "Ask the Game Master" + LLM brain      (Oracle.ts)
 *   Scout        unexplored-feature finder              (Scout.ts)
 * Lore & phrasebook are shared pure modules (../lore.ts, ../narration.ts).
 *
 * Messages go out through a small pacing queue so the GM never floods the
 * screen: urgent lines (replies, quest updates, encounters) go immediately,
 * normal lines are spaced, ambient lines wait their turn and lapse if stale.
 */
import type { GameMasterService, ServerContext, ServerSystem } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import type { EntityId, Vec3 } from '../../shared/types';
import type { GmMessage, GmMessageKind, QuestSpec } from '../types';
import { QUEST_CUSTOM_EVENT } from '../types';
import { Rng, deriveSeed } from '../../core/rng';
import { Biome, BIOMES } from '../../world/biomes';
import { getLore, siteLore, type WorldLore } from '../lore';
import { paletteWords } from '../narration';
import { getPlayerData, interceptDebug } from './access';
import { PlayerGm, type GmHost, type PlayerGmSave, type SayExtra } from './state';
import { Narrator } from './Narrator';
import { QuestBook } from './QuestBook';
import { Director } from './Director';
import { Oracle, type LlmConfig } from './Oracle';
import { featuresNear } from './Scout';

const LOG_CAP = 150;
const GAP_NORMAL = 2.5;
const GAP_AMBIENT = 9;
const AMBIENT_TTL = 40;

interface GmSave {
  v: 1;
  players: PlayerGmSave[];
  questCounter: number;
  msgCounter: number;
  /** LLM endpoint config without the API key (keys are never persisted). */
  llm: LlmConfig | null;
}

export class GameMaster implements ServerSystem, GameMasterService, GmHost {
  readonly name = 'gm';
  ctx!: ServerContext;
  lore!: WorldLore;
  private byName = new Map<string, PlayerGm>();
  private byId = new Map<EntityId, PlayerGm>();
  private narrator!: Narrator;
  private quests!: QuestBook;
  private director!: Director;
  private oracle!: Oracle;
  private msgCounter = 1;
  private palette: Record<string, string> = {};
  private lastSentAt = new Map<EntityId, number>();

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.lore = getLore(ctx.gen.profile);
    this.palette = paletteWords(ctx.gen.profile);
    this.narrator = new Narrator(this);
    this.quests = new QuestBook(this);
    this.director = new Director(this, this.narrator, this.quests);
    this.oracle = new Oracle(this, this.quests, this.director, this.narrator);
    // The PlayerSystem consumes all debug messages; route ours (see access.ts).
    interceptDebug(ctx, 'gmLlmConfig', (p, args) => this.configureLlm(p, args));
    this.subscribe();
  }

  // ------------------------------------------------------------ GameMasterService

  narrate(player: ServerEntity, text: string, kind: GmMessageKind = 'narration', pos?: Vec3) {
    this.say(player, kind, text, { pos, priority: kind === 'narration' ? 'normal' : 'urgent' });
  }

  createQuest(player: ServerEntity, spec: QuestSpec): string {
    return this.quests.create(player, spec);
  }

  offerQuest(player: ServerEntity, questId: string) {
    this.quests.offer(player, questId);
  }

  tension(): number {
    return this.director.tension(this.byName.values());
  }

  // ------------------------------------------------------------ GmHost

  state(p: ServerEntity): PlayerGm {
    let g = this.byId.get(p.id);
    if (g) return g;
    g = this.byName.get(p.name);
    if (!g) {
      g = new PlayerGm(p.name, this.ctx.time.now);
      this.byName.set(p.name, g);
    }
    g.entity = p;
    this.byId.set(p.id, g);
    return g;
  }

  rng(g: PlayerGm, ...tag: (string | number)[]): Rng {
    return new Rng(deriveSeed(this.ctx.seed, 'gm', g.name, g.rngCounter++, ...tag));
  }

  vars(p: ServerEntity): Record<string, string> {
    const lore = this.lore;
    const g = this.byId.get(p.id);
    const col = this.ctx.gen.cachedColumn(p.pos[0], p.pos[2]);
    const biome = g?.live.underworld ? col.uwBiome : col.biome === Biome.Ocean ? col.biome2 : col.biome;
    const moon = lore.moons.length ? lore.moons[Math.floor(this.ctx.time.day) % lore.moons.length].name : 'the starlight';
    const godIdx = g ? g.rngCounter % lore.pantheon.length : 0;
    return {
      ...this.palette, world: lore.worldName, moon, sun: lore.sunName, underworld: lore.underworldName, anomaly: lore.anomalyName, skyname: lore.skyName,
      creator: lore.creator.name, adversary: lore.adversary.name, god: lore.pantheon[godIdx]?.name ?? lore.creator.name, biome: BIOMES[biome]?.name ?? 'wilds',
    };
  }

  /** Send (or queue) a GM message and keep the journal log. */
  say(p: ServerEntity, kind: GmMessageKind, text: string, extra: SayExtra = {}) {
    const g = this.state(p);
    const now = this.ctx.time.now;
    const msg: GmMessage = { id: `g${this.msgCounter++}`, kind, text, t: now };
    if (extra.pos) msg.pos = [extra.pos[0], extra.pos[1], extra.pos[2]];
    if (extra.quest) msg.quest = extra.quest;
    if (extra.title) msg.title = extra.title;
    if (extra.tone) msg.tone = extra.tone;
    if (extra.beat) g.beat(extra.beat, now, this.ctx.time.day);
    const pr = extra.priority ?? 'normal';
    if (pr === 'urgent') {
      this.deliver(p, g, msg, extra);
      return;
    }
    // Ambient lines lapse; normal lines wait at most a little.
    g.live.queue.push({ msg, extra, until: now + (pr === 'ambient' ? AMBIENT_TTL : 120) });
    if (g.live.queue.length > 12) g.live.queue.splice(0, g.live.queue.length - 12);
  }

  private deliver(p: ServerEntity, g: PlayerGm, msg: GmMessage, extra: SayExtra) {
    msg.t = this.ctx.time.now;
    this.ctx.send(p.id, { t: 'gm', messages: [msg] });
    this.lastSentAt.set(p.id, this.ctx.time.now);
    if (extra.priority === 'ambient') g.director.lastAmbientAt = this.ctx.time.now;
    if (extra.noLog) return;
    const d = getPlayerData(this.ctx, p.id);
    if (!d) return;
    d.journal.log.push(msg);
    if (d.journal.log.length > LOG_CAP) d.journal.log.splice(0, d.journal.log.length - LOG_CAP);
    this.ctx.markPlayerDirty(p.id, 'journal');
  }

  /** Drain queues respecting spacing: normal lines every ~2.5 s, ambient lines every ~9 s. */
  tick() {
    const now = this.ctx.time.now;
    for (const g of this.byId.values()) {
      const p = g.entity;
      const q = g.live.queue;
      if (!p || !q.length) continue;
      const last = this.lastSentAt.get(p.id) ?? -1e9;
      // Drop stale ambient lines.
      for (let i = q.length - 1; i >= 0; i--) if (now > q[i].until) q.splice(i, 1);
      if (!q.length || now - last < GAP_NORMAL) continue;
      let idx = q.findIndex((x) => x.extra.priority !== 'ambient');
      if (idx < 0) {
        if (now - g.director.lastAmbientAt < GAP_AMBIENT) continue;
        idx = 0;
      }
      const [item] = q.splice(idx, 1);
      this.deliver(p, g, item.msg, item.extra);
    }
  }

  // ------------------------------------------------------------ players

  onPlayerJoin(p: ServerEntity) {
    const now = this.ctx.time.now;
    const known = this.byName.has(p.name);
    const g = this.state(p);
    g.sessions++;
    g.live.joinedAt = now;
    g.live.lastMoveAt = now;
    g.live.lastPos = [p.pos[0], p.pos[1], p.pos[2]];
    g.live.lastHp = p.hp;
    g.live.underworld = this.ctx.gen.isUnderworld(p.pos[0], p.pos[1], p.pos[2]);
    g.director.spawned = [];
    // Quest foes from a previous session no longer exist.
    for (const rec of g.quests) for (const o of rec.objectives) if (o.aux?.spawn) o.aux.spawn.ids = [];
    this.quests.sync(p);
    if (known && (g.beats.length || g.quests.length)) g.live.pendingRecap = true;
    else this.welcome(p, g);
  }

  private welcome(p: ServerEntity, g: PlayerGm) {
    const lore = this.lore;
    const gen = this.ctx.gen;
    const r = this.rng(g, 'welcome');
    const site = gen.sites.sitesNear(p.pos[0], p.pos[2], 400).find((s) => Math.hypot(s.x - p.pos[0], s.z - p.pos[2]) < s.radius * 3);
    const firstLine = lore.origin.split(/(?<=\.)\s/)[0];
    const near = site ? ` You stand on the outskirts of ${siteLore(gen.profile, site).line}` : '';
    const text = `Welcome to ${lore.worldName}, ${lore.epithet}. ${firstLine} It is the year ${lore.year} of ${lore.eras[lore.eras.length - 1].name}.${near}`;
    this.say(p, 'narration', text, { title: lore.worldName, tone: 'wonder', priority: 'urgent', beat: `Arrived in ${lore.worldName}` });
    this.say(p, 'hint', r.pick([
      'Speak to the Game Master whenever you like — ask where to go, what lies here, who rules, what the legends say, or for a challenge.',
      'The Game Master is listening. Ask about places, people, legends, your quests — or ask for trouble.',
    ]), { priority: 'normal', noLog: true });
  }

  onEntityRemoved(e: ServerEntity) {
    this.quests.onEntityRemoved(e);
    if (e.kind !== 'player') return;
    const g = this.byId.get(e.id);
    if (!g) return;
    g.lastSeen = this.ctx.time.now;
    g.lastDay = this.ctx.time.day;
    g.entity = null;
    g.live.queue = [];
    this.byId.delete(e.id);
    this.lastSentAt.delete(e.id);
  }

  slowTick(dt: number) {
    const ctx = this.ctx;
    const now = ctx.time.now;
    for (const p of ctx.players()) {
      const g = this.state(p);
      // Movement, idleness, model evidence.
      const moved = Math.hypot(p.pos[0] - g.live.lastPos[0], p.pos[2] - g.live.lastPos[2]);
      if (moved > 0.5) {
        if (now - g.live.lastMoveAt > 600 && !g.live.pendingRecap) this.say(p, 'recap', this.narrator.recap(p, 'idle'), { priority: 'normal' });
        g.live.lastMoveAt = now;
      }
      g.model.tick(p, moved, dt);
      g.live.lastPos = [p.pos[0], p.pos[1], p.pos[2]];
      if (g.live.pendingRecap && now - g.live.joinedAt > 3) {
        g.live.pendingRecap = false;
        this.say(p, 'recap', this.narrator.recap(p, 'return'), { priority: 'urgent', title: 'The story so far' });
      }
      // Underworld & gravity transitions.
      this.updateDepth(p, g);
      const ratio = ctx.gravityAt(p.pos) / ctx.gen.profile.baseGravity;
      const band = g.live.gravityBand;
      const nb: -1 | 0 | 1 = band === -1 ? (ratio > 0.8 ? 0 : -1) : band === 1 ? (ratio < 1.2 ? 0 : 1) : ratio < 0.7 ? -1 : ratio > 1.3 ? 1 : 0;
      if (nb !== band) {
        g.live.gravityBand = nb;
        if (now - g.live.joinedAt > 2) this.narrator.onGravity(p, nb, band);
      }
      // Scout the surroundings (amortised) and mark explored features.
      g.scout.scan(ctx.gen, p.pos, 8);
      if (Math.floor(now) % 5 === 0) g.scout.markVisited(featuresNear(ctx.gen, g.scout, p.pos, 120), p.pos);
      // Bounties fade slowly (≈1% per minute).
      for (const k of Object.keys(g.bounty)) {
        g.bounty[k] *= Math.pow(0.99, dt / 60);
        if (g.bounty[k] < 1) delete g.bounty[k];
      }
      this.quests.slowTick(p, dt);
      this.director.slowTick(p, g, dt);
      this.director.pendingOffers(p, g);
      this.director.arcTick(p, g);
    }
  }

  /** Underworld entry/exit (also called before biome narration so the descent is told first). */
  private updateDepth(p: ServerEntity, g: PlayerGm) {
    const uw = this.ctx.gen.isUnderworld(p.pos[0], p.pos[1], p.pos[2]);
    if (uw !== g.live.underworld) {
      g.live.underworld = uw;
      this.narrator.onUnderworld(p, uw);
    }
  }

  // ------------------------------------------------------------ messages

  onMessage(p: ServerEntity, msg: ClientMessage): boolean {
    if (p.kind !== 'player') return false;
    switch (msg.t) {
      case 'gmAsk':
        this.oracle.ask(p, String(msg.text ?? ''));
        return true;
      case 'questAction':
        this.quests.onMessage(p, msg);
        return true;
      case 'debug':
        // Reached only if the PlayerSystem lets unknown debug commands through.
        if (msg.cmd === 'gmLlmConfig') {
          this.configureLlm(p, msg.args ?? []);
          return true;
        }
        return false;
    }
    return false;
  }

  private configureLlm(p: ServerEntity, args: unknown[]) {
    const cfg = (args[0] ?? null) as LlmConfig | null;
    const reply = this.oracle.configure(cfg && typeof cfg === 'object' ? cfg : null);
    this.say(p, 'reply', reply, { priority: 'urgent', noLog: true });
  }

  // ------------------------------------------------------------ bus

  private player(e: ServerEntity | undefined): ServerEntity | null {
    return e && e.kind === 'player' && this.byId.has(e.id) ? e : null;
  }

  private subscribe() {
    const bus = this.ctx.bus;
    bus.on('damage', ({ target, source, amount, ability }) => {
      const tp = this.player(target);
      if (tp) this.director.onPlayerHurt(tp, this.state(tp), amount);
      const sp = this.player(source);
      if (sp && sp !== target) {
        const g = this.state(sp);
        g.model.onDamageDealt(amount, ability);
        g.director.lastCombatAt = this.ctx.time.now;
      }
    });
    bus.on('death', ({ entity, killer }) => {
      if (entity.kind === 'player') return;
      this.quests.onDeath(entity, killer);
      const credit = this.player(killer) ?? this.player(this.ctx.entities.get(entity.lastAttacker));
      if (credit) this.director.onKill(credit, this.state(credit), entity);
    });
    bus.on('playerDied', ({ player, killer }) => {
      const p = this.player(player);
      if (!p) return;
      const g = this.state(p);
      g.model.onDeath(killer?.name || (killer?.creature ? this.ctx.services.creatures.speciesName(killer.creature.species) : null) || null);
      this.director.onPlayerDied(p, g, killer);
    });
    bus.on('abilityUsed', ({ caster, ability }) => {
      const p = this.player(caster);
      if (!p) return;
      this.state(p).model.onAbility(ability);
      this.quests.onAbility(p, ability);
    });
    bus.on('skillXp', ({ entity, skill, level, leveled }) => {
      const p = this.player(entity);
      if (!p) return;
      this.state(p).model.onSkill(skill, level, leveled);
      if (leveled) this.narrator.onLevel(p, skill, level);
    });
    bus.on('abilityUnlocked', ({ entity, ability }) => {
      const p = this.player(entity);
      if (!p) return;
      this.state(p).model.onUnlock(ability);
      this.narrator.onUnlock(p, ability);
    });
    bus.on('itemAcquired', ({ entity, item, how }) => {
      const p = this.player(entity);
      if (!p) return;
      this.state(p).model.onItem(how, item.name, item.rarity, item.value);
      this.quests.onInventoryChanged(p);
    });
    bus.on('itemLost', ({ entity }) => {
      const p = this.player(entity);
      if (p) this.quests.onInventoryChanged(p);
    });
    bus.on('harvest', ({ entity, kind }) => {
      const p = this.player(entity);
      if (!p) return;
      this.state(p).model.onHarvest();
      this.quests.onHarvest(p, kind);
    });
    bus.on('terrainEdited', ({ source }) => {
      const p = this.player(source);
      if (p) this.state(p).model.onDig();
    });
    bus.on('objectDestroyed', ({ source, id, kind, pos }) => {
      const p = this.player(source);
      if (p) this.director.onObjectDestroyed(p, this.state(p), id, kind, pos);
    });
    bus.on('enterSite', ({ player, site }) => {
      const p = this.player(player);
      if (!p) return;
      const g = this.state(p);
      const first = g.flags[`site:${site.id}`] === undefined;
      this.narrator.onSite(p, site, first);
      this.quests.onDiscover(p, null, site);
      this.quests.onCustom(p, `enter:${site.id}`);
      if (first) this.director.onEnterSite(p, g, site);
    });
    bus.on('discoverPoi', ({ player, poi }) => {
      const p = this.player(player);
      if (!p) return;
      const g = this.state(p);
      this.narrator.onPoi(p, poi);
      this.quests.onDiscover(p, poi, null);
      this.director.onDiscoverPoi(p, g, poi);
    });
    bus.on('enterBiome', ({ player, biome }) => {
      const p = this.player(player);
      if (!p) return;
      this.updateDepth(p, this.state(p));
      this.narrator.onBiome(p, biome as Biome);
    });
    bus.on('dialogStarted', ({ player, npc }) => {
      const p = this.player(player);
      if (!p) return;
      const g = this.state(p);
      this.director.onDialog(g);
      g.model.onDialog();
      this.quests.onDialog(p, npc);
      const site = this.ctx.gen.siteAt(p.pos[0], p.pos[2]);
      // Each distinct townsperson counts once for "hear them out" requests.
      if (site && !g.flags[`talked:${npc.id}`]) {
        g.flags[`talked:${npc.id}`] = this.ctx.time.now;
        this.quests.onCustom(p, `talk:${site.id}`);
      }
    });
    bus.on('dialogEvent', ({ player, event }) => {
      const p = this.player(player);
      if (!p) return;
      const g = this.state(p);
      g.director.inDialogUntil = this.ctx.time.now + 20;
      g.model.onDialogEvent(event);
      this.quests.onCustom(p, event);
    });
    bus.on('crime', ({ offender, kind, pos }) => {
      const p = this.player(offender);
      if (p) this.director.onCrime(p, this.state(p), kind, pos);
    });
    bus.on('timeOfDay', ({ hour }) => {
      for (const g of this.byId.values()) if (g.entity) this.narrator.onHour(g.entity, hour);
    });
    bus.on('weatherChanged', ({ weather }) => {
      for (const g of this.byId.values()) if (g.entity && this.ctx.time.now - g.live.joinedAt > 5) this.narrator.onWeather(g.entity, weather);
    });
    bus.on('questEvent', ({ player, quest, event }) => {
      const p = this.player(player);
      if (p) this.director.onQuestEvent(p, this.state(p), quest, event);
    });
    // Custom objective convention (see QUEST_CUSTOM_EVENT in ../types.ts).
    bus.on(QUEST_CUSTOM_EVENT, (payload) => {
      const ev = payload as { player?: ServerEntity; event?: string; count?: number };
      const p = this.player(ev.player);
      if (p && ev.event) this.quests.onCustom(p, ev.event, ev.count ?? 1);
    });
  }

  // ------------------------------------------------------------ persistence

  save(): GmSave {
    for (const g of this.byId.values()) {
      g.lastSeen = this.ctx.time.now;
      g.lastDay = this.ctx.time.day;
    }
    return {
      v: 1,
      players: [...this.byName.values()].map((g) => g.save()),
      questCounter: this.quests.counterValue,
      msgCounter: this.msgCounter,
      llm: this.oracle.llmConfig,
    };
  }

  load(data: unknown) {
    const d = data as Partial<GmSave> | null;
    if (!d || !Array.isArray(d.players)) return;
    const now = this.ctx.time.now;
    for (const s of d.players) {
      try {
        const g = PlayerGm.load(s, now);
        this.byName.set(g.name, g);
      } catch (err) {
        this.ctx.log('[gm] could not restore player state', s?.name, err);
      }
    }
    this.quests.counterValue = d.questCounter ?? 1;
    this.msgCounter = Math.max(this.msgCounter, d.msgCounter ?? 1);
    // Keys are never saved: keyless local endpoints (Ollama) come back on their own,
    // keyed providers need gmLlmConfig again.
    if (d.llm && d.llm.provider && d.llm.provider !== 'anthropic' && d.llm.provider !== 'openai') this.oracle.configure(d.llm);
  }

  // ------------------------------------------------------------ debugging / tools

  /** Snapshot of a player's GM state for tools and debug UIs. */
  debugState(p: ServerEntity) {
    const g = this.state(p);
    return {
      phase: g.director.phase, tension: g.director.tension, style: g.model.weights(), dominant: g.model.dominant(), quests: g.quests.map((q) => ({ id: q.id, title: q.spec.title, status: q.status })),
      bounty: g.bounty, nemeses: g.nemeses, arc: g.arc, beats: g.beats.slice(-10), history: g.model.history,
    };
  }

  /** Ask programmatically (tools/tests). */
  ask(p: ServerEntity, text: string) {
    this.oracle.ask(p, text);
  }
}
