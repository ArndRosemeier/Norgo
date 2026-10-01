/**
 * Quest runtime. Any system submits a declarative QuestSpec; the quest book
 * turns it into a QuestRecord, mirrors it into the player's journal as a
 * QuestView, and advances objectives from bus events:
 *
 *   kill      death events (killer or last attacker = player) matching species/faction/tag
 *   collect   inventory counts re-evaluated on itemAcquired/itemLost
 *   deliver   dialogStarted with the recipient: items are taken from the inventory
 *   talk      dialogStarted with the npc
 *   goto      player position (slow tick)
 *   escort    npc position (slow tick); fails if the npc dies
 *   harvest   harvest events by object kind ('*' = any)
 *   discover  discoverPoi / enterSite, or simply standing at the place
 *   ability   abilityUsed ('*' = any)
 *   custom    'questCustom' bus events, dialogEvent names, GM linger/riddle mechanics
 *
 * Completion grants rewards (coins, items or rolled loot, skill XP, reputation),
 * time limits fail quests, and every transition emits the 'questEvent' bus event.
 * GM-generated quests may attach spawn plans (targets appear when the player
 * approaches), linger zones (search/rites/vigil) and riddles; if a spawn is not
 * possible the objective degrades gracefully into a search so nothing dead-ends.
 */
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import type { EntityId, Vec3 } from '../../shared/types';
import type { QuestObjective, QuestObjectiveSpec, QuestSpec, QuestView, GmMessageKind } from '../types';
import type { PoiInfo, SiteInfo } from '../../world/sites';
import { getPlayerData } from './access';
import type { GmHost, ObjectiveRuntime, PlayerGm, QuestRecord } from './state';
import { poiById, siteById } from './Scout';
import { QUEST_ACCEPT, QUEST_DONE, QUEST_FAILED, QUEST_OFFER, QUEST_STEP } from '../narration';
import { cap, list } from '../text';
import { powerLevel } from './PlayerModel';

const MAX_ACTIVE = 8;
const OFFER_TTL = 1200;

export interface CreateOpts {
  origin?: string;
  arc?: { id: string; stage: number };
  sequential?: boolean;
  aux?: (ObjectiveRuntime['aux'] | undefined)[];
  /** Seconds an offer stays open (default 20 min). */
  offerTtl?: number;
  /** Do not narrate the offer (caller narrates). */
  silent?: boolean;
  /** Indices of optional objectives. */
  optional?: number[];
}

export class QuestBook {
  private counter = 1;
  /** Entity id → quest/objective it belongs to (for kill credit & despawn handling). */
  private spawnIndex = new Map<EntityId, { player: string; quest: string; obj: number }>();

  constructor(private host: GmHost) {}

  get counterValue() {
    return this.counter;
  }
  set counterValue(v: number) {
    this.counter = Math.max(this.counter, v);
  }

  // ------------------------------------------------------------ lifecycle

  create(p: ServerEntity, spec: QuestSpec, opts: CreateOpts = {}): string {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    const id = `q${this.counter++}`;
    const rec: QuestRecord = {
      id, spec, status: 'offered', createdAt: now, updatedAt: now, tracked: false, sequential: !!opts.sequential, arc: opts.arc, origin: opts.origin,
      objectives: spec.objectives.map((o, i) => ({
        spec: o, id: `${id}.${i}`, count: 0, done: false, optional: opts.optional?.includes(i) ? true : undefined, aux: opts.aux?.[i],
      })),
    };
    // Point GM spawn tags at this quest.
    rec.objectives.forEach((o, i) => {
      if (o.aux?.spawn && o.spec.kind === 'kill') o.spec = { ...o.spec, tag: `gmq:${id}:${i}` };
    });
    if (spec.timeLimit) rec.expiresAt = now + spec.timeLimit;
    g.quests.push(rec);
    if (opts.origin) g.generatedOrigins.add(opts.origin);
    this.emit(p, id, 'offered');
    if (spec.autoAccept) this.accept(p, id, true);
    else {
      rec.offerExpiresAt = now + (opts.offerTtl ?? OFFER_TTL);
      if (!opts.silent) this.narrateOffer(p, rec);
    }
    this.sync(p);
    return id;
  }

  offer(p: ServerEntity, id: string) {
    const rec = this.find(p, id);
    if (!rec) return;
    if (rec.status === 'abandoned' || rec.status === 'failed') {
      rec.status = 'offered';
      rec.offerExpiresAt = this.host.ctx.time.now + OFFER_TTL;
      this.emit(p, id, 'offered');
    }
    if (rec.status === 'offered') this.narrateOffer(p, rec);
    this.sync(p);
  }

  private narrateOffer(p: ServerEntity, rec: QuestRecord) {
    const g = this.host.state(p);
    const r = this.host.rng(g, 'offer');
    const text = g.variety.compose('quest.offer', QUEST_OFFER, r, { title: rec.spec.title, summary: rec.spec.summary });
    const rw = this.rewardLines(rec.spec);
    this.host.say(p, 'quest', `${text}${rw.length ? ` (Reward: ${list(rw)}.)` : ''} Open your journal to accept.`, { quest: rec.id, title: rec.spec.title, priority: 'urgent', pos: this.objectivePos(rec, rec.objectives[0]) });
  }

  accept(p: ServerEntity, id: string, silent = false): boolean {
    const rec = this.find(p, id);
    if (!rec || rec.status !== 'offered') return false;
    const g = this.host.state(p);
    if (this.active(g).length >= MAX_ACTIVE) {
      this.host.say(p, 'hint', 'Your journal is full of unfinished business. Finish or abandon a quest first.', { priority: 'urgent', noLog: true });
      return false;
    }
    rec.status = 'active';
    rec.acceptedAt = this.host.ctx.time.now;
    rec.updatedAt = rec.acceptedAt;
    rec.offerExpiresAt = undefined;
    // Auto-track if nothing else is tracked.
    if (!g.quests.some((q) => q.tracked && q.status === 'active')) rec.tracked = true;
    this.emit(p, id, 'accepted');
    if (!silent) {
      const r = this.host.rng(g, 'accept');
      this.host.say(p, 'quest', g.variety.compose('quest.accept', QUEST_ACCEPT, r, { title: rec.spec.title }), { quest: id, title: rec.spec.title, priority: 'urgent', beat: `Took up the task “${rec.spec.title}”` });
    }
    // Already satisfied objectives (collect/discover) count right away.
    this.recountCollect(p, rec);
    this.checkPresence(p, rec);
    this.checkComplete(p, rec);
    this.sync(p);
    return true;
  }

  abandon(p: ServerEntity, id: string) {
    const rec = this.find(p, id);
    if (!rec || (rec.status !== 'active' && rec.status !== 'offered')) return;
    const wasOffered = rec.status === 'offered';
    rec.status = 'abandoned';
    rec.tracked = false;
    rec.updatedAt = this.host.ctx.time.now;
    this.cleanupSpawns(rec);
    this.emit(p, id, 'abandoned');
    if (!wasOffered) this.host.say(p, 'quest', `You set aside ${rec.spec.title}.`, { quest: id, priority: 'urgent' });
    this.sync(p);
  }

  track(p: ServerEntity, id: string) {
    const g = this.host.state(p);
    const rec = this.find(p, id);
    if (!rec || rec.status !== 'active') return;
    const was = rec.tracked;
    for (const q of g.quests) q.tracked = false;
    rec.tracked = !was;
    this.sync(p);
    if (rec.tracked) {
      const o = this.current(rec)[0];
      const pos = o ? this.objectivePos(rec, o) : undefined;
      this.host.say(p, 'hint', o ? `Tracking ${rec.spec.title}: ${o.spec.text}.` : `Tracking ${rec.spec.title}.`, { quest: id, pos, priority: 'urgent', noLog: true });
    }
  }

  onMessage(p: ServerEntity, msg: Extract<ClientMessage, { t: 'questAction' }>) {
    if (msg.action === 'accept') this.accept(p, msg.quest);
    else if (msg.action === 'abandon') this.abandon(p, msg.quest);
    else if (msg.action === 'track') this.track(p, msg.quest);
  }

  // ------------------------------------------------------------ queries

  find(p: ServerEntity, id: string): QuestRecord | undefined {
    return this.host.state(p).quests.find((q) => q.id === id);
  }

  active(g: PlayerGm): QuestRecord[] {
    return g.quests.filter((q) => q.status === 'active');
  }

  tracked(g: PlayerGm): QuestRecord | undefined {
    return g.quests.find((q) => q.tracked && q.status === 'active') ?? this.active(g)[0];
  }

  /** Objectives currently open for progress (sequential quests reveal one at a time). */
  current(rec: QuestRecord): ObjectiveRuntime[] {
    if (!rec.sequential) return rec.objectives.filter((o) => !o.done);
    const out: ObjectiveRuntime[] = [];
    for (const o of rec.objectives) {
      if (o.done) continue;
      out.push(o);
      if (!o.optional) break;
    }
    return out;
  }

  /** World position an objective points at (for markers & hints). */
  objectivePos(rec: QuestRecord, o: ObjectiveRuntime | undefined): Vec3 | undefined {
    if (!o) return undefined;
    const s = o.spec;
    if (s.kind === 'goto' || s.kind === 'escort') return s.pos;
    if (s.kind === 'kill' && s.pos) return s.pos;
    if (o.aux?.spawn) return o.aux.spawn.pos;
    if (o.aux?.linger) return o.aux.linger.pos;
    if (o.aux?.riddle) return o.aux.riddle.pos;
    if (s.kind === 'discover') {
      const gen = this.host.ctx.gen;
      if (s.poi) {
        const poi = poiById(gen, s.poi);
        if (poi) return [poi.x, poi.y, poi.z];
      }
      if (s.site) {
        const site = siteById(gen, s.site);
        if (site) return [site.x, site.plateau, site.z];
      }
    }
    if ((s.kind === 'talk' || s.kind === 'deliver') && this.host.ctx.entities.get(s.kind === 'talk' ? s.npc : s.toNpc)) {
      const e = this.host.ctx.entities.get(s.kind === 'talk' ? s.npc : s.toNpc)!;
      return [e.pos[0], e.pos[1], e.pos[2]];
    }
    return undefined;
  }

  // ------------------------------------------------------------ progress from events

  onDeath(victim: ServerEntity, killer: ServerEntity | undefined) {
    const idx = this.spawnIndex.get(victim.id);
    const players = this.host.ctx.players();
    for (const p of players) {
      const credited = killer?.id === p.id || victim.lastAttacker === p.id || (idx !== undefined && idx.player === p.name);
      if (!credited) continue;
      for (const rec of this.active(this.host.state(p))) {
        for (const o of this.current(rec)) {
          if (o.spec.kind !== 'kill' || !this.killMatches(o.spec, victim)) continue;
          this.advance(p, rec, o, 1);
        }
      }
    }
    this.spawnIndex.delete(victim.id);
  }

  private killMatches(s: Extract<QuestObjectiveSpec, { kind: 'kill' }>, v: ServerEntity): boolean {
    if (s.tag) return v.tags.has(s.tag);
    if (s.species !== undefined && v.creature?.species !== s.species) return false;
    if (s.faction && v.faction !== s.faction) return false;
    if (s.species === undefined && !s.faction) return v.kind === 'creature' || v.faction === 'hostile' || v.tags.has('bandit') || v.tags.has('hostile');
    return true;
  }

  onInventoryChanged(p: ServerEntity) {
    for (const rec of this.active(this.host.state(p))) {
      this.recountCollect(p, rec);
      this.checkComplete(p, rec);
    }
  }

  private recountCollect(p: ServerEntity, rec: QuestRecord) {
    for (const o of this.current(rec)) {
      if (o.spec.kind !== 'collect') continue;
      const have = countItems(p, o.spec.itemDef);
      const target = o.spec.count;
      if (have !== o.count) {
        o.count = Math.min(have, target);
        const done = have >= target;
        if (done && !o.done) this.completeObjective(p, rec, o);
        else if (!done && o.done) o.done = false;
        rec.updatedAt = this.host.ctx.time.now;
        this.sync(p);
      }
    }
  }

  onDialog(p: ServerEntity, npc: ServerEntity) {
    const ctx = this.host.ctx;
    for (const rec of this.active(this.host.state(p))) {
      for (const o of this.current(rec)) {
        const s = o.spec;
        if (s.kind === 'talk' && s.npc === npc.id) this.advance(p, rec, o, 1);
        else if (s.kind === 'deliver' && s.toNpc === npc.id) {
          const have = countItems(p, s.itemDef);
          if (have >= s.count) {
            let left = s.count;
            for (const it of [...(p.inventory?.items ?? [])]) {
              if (left <= 0) break;
              if (it.defId !== s.itemDef) continue;
              const n = Math.min(left, it.count);
              const taken = ctx.services.items.take(p, it.uid, n);
              if (taken && npc.inventory) ctx.services.items.give(npc, taken, 'gift');
              left -= n;
            }
            this.advance(p, rec, o, s.count);
          } else {
            this.host.say(p, 'hint', `${npc.name || 'They'} expect${npc.name ? 's' : ''} ${s.count}× ${ctx.services.items.def(s.itemDef)?.name ?? s.itemDef}; you carry ${have}.`, { priority: 'urgent', noLog: true, quest: rec.id });
          }
        }
      }
    }
  }

  onCustom(p: ServerEntity, event: string, count = 1) {
    for (const rec of this.active(this.host.state(p))) {
      for (const o of this.current(rec)) if (o.spec.kind === 'custom' && o.spec.event === event) this.advance(p, rec, o, count);
    }
  }

  onHarvest(p: ServerEntity, kind: string) {
    for (const rec of this.active(this.host.state(p))) {
      for (const o of this.current(rec)) {
        if (o.spec.kind !== 'harvest') continue;
        const want = o.spec.objectKind;
        if (want === '*' || kind === want || kind.includes(want)) this.advance(p, rec, o, 1);
      }
    }
  }

  onDiscover(p: ServerEntity, poi: PoiInfo | null, site: SiteInfo | null) {
    for (const rec of this.active(this.host.state(p))) {
      for (const o of this.current(rec)) {
        if (o.spec.kind !== 'discover') continue;
        const s = o.spec;
        const hit = (poi && (s.poi === poi.id || (!s.poi && !s.site))) || (site && (s.site === site.id || (!s.poi && !s.site)));
        if (hit) this.advance(p, rec, o, 1);
      }
    }
  }

  onAbility(p: ServerEntity, ability: string) {
    for (const rec of this.active(this.host.state(p))) {
      for (const o of this.current(rec)) {
        if (o.spec.kind === 'ability' && (o.spec.ability === '*' || o.spec.ability === ability)) this.advance(p, rec, o, 1);
      }
    }
  }

  /**
   * A player said something to the GM: check riddle objectives. Returns a reply
   * if the text was an attempt at an open riddle, else null.
   */
  answerRiddle(p: ServerEntity, text: string): string | null {
    const t = text.toLowerCase();
    for (const rec of this.active(this.host.state(p))) {
      for (const o of this.current(rec)) {
        const rd = o.aux?.riddle;
        if (!rd) continue;
        const near = Math.hypot(p.pos[0] - rd.pos[0], p.pos[2] - rd.pos[2]) < 60;
        const hit = rd.answers.some((a) => new RegExp(`\\b${a}\\b`).test(t));
        if (hit && near) {
          this.advance(p, rec, o, 1);
          return 'The carved words seem to settle, satisfied. Somewhere, stone grinds against stone.';
        }
        if (hit && !near) return 'You feel you have the answer — but it must be spoken where the riddle is carved.';
        if (near && /\b(answer|is it|it is|it's|i say|riddle)\b/.test(t)) return 'Nothing happens. The riddle waits, patient as stone.';
      }
    }
    return null;
  }

  /** Remaining riddle questions for a player (for "what is the riddle?"). */
  openRiddles(p: ServerEntity): { quest: string; question: string; pos: Vec3 }[] {
    const out: { quest: string; question: string; pos: Vec3 }[] = [];
    for (const rec of this.active(this.host.state(p))) for (const o of this.current(rec)) if (o.aux?.riddle) out.push({ quest: rec.spec.title, question: o.aux.riddle.question, pos: o.aux.riddle.pos });
    return out;
  }

  // ------------------------------------------------------------ periodic

  /** Once per second per player: positions, lingering, spawns, expiry. */
  slowTick(p: ServerEntity, dt: number) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    let dirty = false;
    for (const rec of g.quests) {
      if (rec.status === 'offered' && rec.offerExpiresAt !== undefined && now > rec.offerExpiresAt) {
        rec.status = 'abandoned';
        rec.updatedAt = now;
        this.emit(p, rec.id, 'abandoned');
        dirty = true;
        continue;
      }
      if (rec.status !== 'active') continue;
      if (rec.expiresAt !== undefined && now > rec.expiresAt) {
        this.fail(p, rec, 'Time has run out.');
        dirty = true;
        continue;
      }
      if (p.alive) {
        this.checkPresence(p, rec, dt);
        this.checkSpawns(p, rec);
      }
    }
    // Prune old finished quests so the journal stays readable.
    const finished = g.quests.filter((q) => q.status !== 'active' && q.status !== 'offered');
    if (finished.length > 40) {
      const drop = new Set(finished.slice(0, finished.length - 40).map((q) => q.id));
      g.quests = g.quests.filter((q) => !drop.has(q.id));
      dirty = true;
    }
    if (dirty) this.sync(p);
  }

  /** goto / discover-by-presence / escort / linger checks. */
  private checkPresence(p: ServerEntity, rec: QuestRecord, dt = 0) {
    const ctx = this.host.ctx;
    for (const o of this.current(rec)) {
      const s = o.spec;
      if (s.kind === 'goto') {
        if (dist3w(p.pos, s.pos) <= s.radius) this.advance(p, rec, o, 1);
      } else if (s.kind === 'discover') {
        const pos = this.objectivePos(rec, o);
        if (pos && Math.hypot(p.pos[0] - pos[0], p.pos[2] - pos[2]) < 30) this.advance(p, rec, o, 1);
      } else if (s.kind === 'escort') {
        const npc = ctx.entities.get(s.npc);
        if (!npc || !npc.alive) {
          this.fail(p, rec, `${npc?.name || 'Your charge'} did not survive the journey.`);
          return;
        }
        if (dist3w(npc.pos, s.pos) <= s.radius) this.advance(p, rec, o, 1);
      }
      const lg = o.aux?.linger;
      if (lg && dt > 0) {
        const hour = ctx.time.hour;
        const isNight = hour < 5.5 || hour > 20;
        const inside = Math.hypot(p.pos[0] - lg.pos[0], p.pos[2] - lg.pos[2]) < lg.radius && Math.abs(p.pos[1] - lg.pos[1]) < 40;
        if (inside && (!lg.night || isNight)) {
          if (lg.acc === 0 && lg.hint) this.host.say(p, 'hint', lg.hint, { quest: rec.id, priority: 'urgent', noLog: true });
          lg.acc += dt;
          if (lg.acc >= lg.secs && s.kind === 'custom') this.advance(p, rec, o, s.count - o.count);
        } else if (inside && lg.night && !isNight) {
          if (!this.host.state(p).throttle('night:hint', ctx.time.now, 300)) this.host.say(p, 'hint', 'This must be done under the night sky. Return after dusk.', { quest: rec.id, priority: 'urgent', noLog: true });
        } else if (!inside && lg.acc > 0) lg.acc = Math.max(0, lg.acc - dt * 2);
      }
    }
  }

  /** Spawn quest targets when the player approaches; degrade if impossible. */
  private checkSpawns(p: ServerEntity, rec: QuestRecord) {
    const ctx = this.host.ctx;
    for (const o of this.current(rec)) {
      const sp = o.aux?.spawn;
      if (!sp || o.spec.kind !== 'kill' || sp.failed) continue;
      const alive = sp.ids.filter((id) => ctx.entities.get(id)?.alive);
      sp.ids = alive;
      const remaining = o.spec.count - o.count;
      if (remaining <= 0 || alive.length >= remaining) continue;
      const d = Math.hypot(p.pos[0] - sp.pos[0], p.pos[2] - sp.pos[2]);
      if (d > 95 || d < 12) continue;
      const g = this.host.state(p);
      if (g.throttle(`spawn:${o.id}`, ctx.time.now, alive.length ? 25 : 4)) continue;
      const need = remaining - alive.length;
      const lvl = powerLevel(p);
      for (let i = 0; i < need; i++) {
        const a = (i / Math.max(1, need)) * Math.PI * 2 + sp.seed;
        const x = sp.pos[0] + Math.cos(a) * (3 + i * 1.5), z = sp.pos[2] + Math.sin(a) * (3 + i * 1.5);
        const y = groundNear(this.host, x, sp.pos[1], z);
        let e: ServerEntity | null = null;
        if (sp.kind === 'creature' && sp.species !== undefined) {
          e = ctx.services.creatures.spawn(sp.species, [x, y + 0.5, z], { seed: sp.seed + i, hostile: true, boss: sp.boss && i === 0, growth: Math.min(1, 0.7 + lvl * 0.03) });
        } else if (sp.kind === 'wanderer' && sp.wanderer) {
          e = ctx.services.npcs.spawnWanderer(sp.wanderer, [x, y + 0.5, z], sp.seed + i);
        }
        if (!e) continue;
        e.tags.add(o.spec.tag!);
        e.tags.add('gm');
        if (sp.name && i === 0) {
          e.name = sp.name;
          if (sp.title) e.title = sp.title;
          e.dirty = true;
        }
        sp.ids.push(e.id);
        this.spawnIndex.set(e.id, { player: p.name, quest: rec.id, obj: rec.objectives.indexOf(o) });
      }
      if (!sp.ids.length) this.degradeSpawn(p, rec, o);
    }
  }

  /** The world cannot provide the foe: turn the objective into a search of the site. */
  private degradeSpawn(p: ServerEntity, rec: QuestRecord, o: ObjectiveRuntime) {
    const sp = o.aux!.spawn!;
    sp.failed = true;
    const text = sp.name ? `Find the trail of ${sp.name}` : 'Search the area for your quarry';
    o.spec = { kind: 'custom', text, event: `search:${o.id}`, count: 1 };
    o.count = 0;
    o.aux = { linger: { pos: sp.pos, radius: 22, secs: 8, acc: 0, hint: 'You search the ground for tracks and signs...' } };
    this.sync(p);
  }

  onEntityRemoved(e: ServerEntity) {
    // Despawned (not killed) targets will respawn when the player returns.
    if (e.alive) this.spawnIndex.delete(e.id);
  }

  // ------------------------------------------------------------ transitions

  private advance(p: ServerEntity, rec: QuestRecord, o: ObjectiveRuntime, n: number) {
    if (o.done || rec.status !== 'active' || n <= 0) return;
    const target = targetOf(o.spec);
    o.count = Math.min(target, o.count + n);
    rec.updatedAt = this.host.ctx.time.now;
    if (o.count >= target) this.completeObjective(p, rec, o);
    else {
      this.emit(p, rec.id, 'progress');
      // Urgent so counters never arrive after the completion line.
      if (target > 1) this.host.say(p, 'quest', `${o.spec.text}: ${o.count}/${target}.`, { quest: rec.id, priority: 'urgent', noLog: true });
    }
    this.checkComplete(p, rec);
    this.sync(p);
  }

  private completeObjective(p: ServerEntity, rec: QuestRecord, o: ObjectiveRuntime) {
    o.done = true;
    o.count = targetOf(o.spec);
    this.emit(p, rec.id, 'progress');
    const g = this.host.state(p);
    const remaining = rec.objectives.filter((x) => !x.done && !x.optional).length;
    if (remaining > 0) {
      const r = this.host.rng(g, 'step');
      const next = this.current(rec).find((x) => !x.optional);
      let text = g.variety.compose('quest.step', QUEST_STEP, r, { objective: o.spec.text });
      if (next) text += ` Next: ${next.spec.text}.`;
      this.host.say(p, 'quest', text, { quest: rec.id, title: rec.spec.title, priority: 'urgent', pos: this.objectivePos(rec, next) });
    }
  }

  private checkComplete(p: ServerEntity, rec: QuestRecord) {
    if (rec.status !== 'active') return;
    if (rec.objectives.some((o) => !o.done && !o.optional)) return;
    rec.status = 'completed';
    rec.tracked = false;
    rec.updatedAt = this.host.ctx.time.now;
    this.cleanupSpawns(rec);
    const rewards = this.grantRewards(p, rec);
    const g = this.host.state(p);
    g.model.history.questsCompleted++;
    const r = this.host.rng(g, 'done');
    this.host.say(p, 'quest', g.variety.compose('quest.done', QUEST_DONE, r, { title: rec.spec.title, reward: rewards.length ? `You receive ${list(rewards)}.` : '' }), {
      quest: rec.id, title: rec.spec.title, tone: 'triumph', priority: 'urgent', beat: `Completed “${rec.spec.title}”`,
    });
    this.emit(p, rec.id, 'completed');
    // Auto-track the next active quest.
    const next = this.active(g)[0];
    if (next && !g.quests.some((q) => q.tracked && q.status === 'active')) next.tracked = true;
    this.sync(p);
  }

  fail(p: ServerEntity, rec: QuestRecord, why: string) {
    if (rec.status !== 'active') return;
    rec.status = 'failed';
    rec.tracked = false;
    rec.updatedAt = this.host.ctx.time.now;
    this.cleanupSpawns(rec);
    const g = this.host.state(p);
    g.model.history.questsFailed++;
    const r = this.host.rng(g, 'fail');
    this.host.say(p, 'quest', `${why} ${g.variety.compose('quest.fail', QUEST_FAILED, r, { title: rec.spec.title })}`, { quest: rec.id, title: rec.spec.title, tone: 'grief', priority: 'urgent', beat: `Failed “${rec.spec.title}”` });
    this.emit(p, rec.id, 'failed');
    this.sync(p);
  }

  private cleanupSpawns(rec: QuestRecord) {
    // Living quest foes stay in the world (they are creatures/NPCs now), but lose their quest tie.
    for (const o of rec.objectives) for (const id of o.aux?.spawn?.ids ?? []) this.spawnIndex.delete(id);
  }

  // ------------------------------------------------------------ rewards

  rewardLines(spec: QuestSpec): string[] {
    const out: string[] = [];
    const rw = spec.rewards;
    if (rw.coins) out.push(`${rw.coins} coins`);
    for (const id of rw.items ?? []) out.push(this.host.ctx.services.items.def(id)?.name ?? humanize(id));
    if (spec.meta?.lootTable) out.push('a share of treasure');
    for (const [skill, xp] of Object.entries(rw.xp ?? {})) out.push(`${xp} ${humanize(skill)} experience`);
    for (const [fac, v] of Object.entries(rw.reputation ?? {})) out.push(`${v >= 0 ? 'standing' : 'ill will'} with ${this.factionName(fac)}`);
    if (rw.text) out.push(rw.text);
    return out;
  }

  factionName(id: string): string {
    const p = this.host.lore.powers.find((x) => x.id === id);
    if (p) return p.name;
    if (id.startsWith('site.')) {
      const s = siteById(this.host.ctx.gen, id.slice(5));
      if (s) return `the folk of ${s.name}`;
    }
    return humanize(id);
  }

  private grantRewards(p: ServerEntity, rec: QuestRecord): string[] {
    const ctx = this.host.ctx;
    const rw = rec.spec.rewards;
    const out: string[] = [];
    if (rw.coins && p.inventory) {
      p.inventory.coins += rw.coins;
      ctx.markPlayerDirty(p.id, 'inventory');
      this.host.state(p).model.history.coinsEarned += rw.coins;
      out.push(`${rw.coins} coins`);
    }
    const give = (defId: string) => {
      try {
        const it = ctx.services.items.create(defId, { seed: ctx.rng('questreward', rec.id, defId).nextU32(), level: Math.round(powerLevel(p)) });
        if (ctx.services.items.give(p, it, 'quest')) out.push(it.name || humanize(defId));
      } catch {
        // Unknown item definition: compensate in coin so the reward is never lost.
        if (p.inventory) {
          p.inventory.coins += 25;
          ctx.markPlayerDirty(p.id, 'inventory');
          out.push('25 coins in lieu of a lost keepsake');
        }
      }
    };
    for (const id of rw.items ?? []) give(id);
    const table = rec.spec.meta?.lootTable;
    if (typeof table === 'string') {
      const items = ctx.services.items.rollLoot(table, Math.round(powerLevel(p)), ctx.rng('questloot', rec.id).nextU32());
      for (const it of items) if (ctx.services.items.give(p, it, 'quest')) out.push(it.name);
      if (!items.length && p.inventory) {
        const coins = 20 + Math.round(powerLevel(p) * 8);
        p.inventory.coins += coins;
        ctx.markPlayerDirty(p.id, 'inventory');
        out.push(`${coins} coins of old treasure`);
      }
    }
    for (const [skill, xp] of Object.entries(rw.xp ?? {})) {
      ctx.services.skills.grantXp(p, skill, xp);
      out.push(`${xp} ${humanize(skill)} experience`);
    }
    const d = getPlayerData(ctx, p.id);
    if (d && rw.reputation) {
      for (const [fac, v] of Object.entries(rw.reputation)) {
        d.reputation[fac] = Math.max(-100, Math.min(100, (d.reputation[fac] ?? 0) + v));
        out.push(`${v >= 0 ? 'the gratitude' : 'the enmity'} of ${this.factionName(fac)}`);
      }
      ctx.markPlayerDirty(p.id, 'reputation');
    }
    if (rw.text) out.push(rw.text);
    return out;
  }

  // ------------------------------------------------------------ journal

  /** Mirror records into the player's journal (QuestView). */
  sync(p: ServerEntity) {
    const ctx = this.host.ctx;
    const d = getPlayerData(ctx, p.id);
    if (!d) return;
    const g = this.host.state(p);
    const mine = new Set(g.quests.map((q) => q.id));
    // Keep foreign views (quests created before the GM knew them) untouched.
    const views: QuestView[] = d.journal.quests.filter((v) => !mine.has(v.id) && !/^q\d+$/.test(v.id));
    for (const rec of g.quests) views.push(this.view(rec, p));
    d.journal.quests = views;
    ctx.markPlayerDirty(p.id, 'journal');
  }

  private view(rec: QuestRecord, p: ServerEntity): QuestView {
    const shown = rec.sequential ? this.revealed(rec) : rec.objectives;
    const objectives: QuestObjective[] = shown.map((o) => {
      const target = targetOf(o.spec);
      const v: QuestObjective = { id: o.id, text: o.spec.text, done: o.done };
      if (target > 1) {
        v.count = o.count;
        v.target = target;
      }
      const pos = this.objectivePos(rec, o);
      if (pos) v.pos = [pos[0], pos[1], pos[2]];
      if (o.optional) v.optional = true;
      return v;
    });
    return {
      id: rec.id, title: rec.spec.title, giver: rec.spec.giver, summary: rec.spec.summary, status: rec.status, objectives, rewards: this.rewardLines(rec.spec),
      source: rec.spec.source, tracked: rec.tracked || undefined, expiresAt: rec.expiresAt, category: rec.spec.category ?? (rec.arc ? 'arc' : rec.spec.source === 'npc' ? 'npc' : 'side'),
      level: Math.round(powerLevel(p)), updatedAt: rec.updatedAt,
    };
  }

  private revealed(rec: QuestRecord): ObjectiveRuntime[] {
    const out: ObjectiveRuntime[] = [];
    for (const o of rec.objectives) {
      out.push(o);
      if (!o.done && !o.optional) break;
    }
    return out;
  }

  private emit(p: ServerEntity, quest: string, event: 'offered' | 'accepted' | 'progress' | 'completed' | 'failed' | 'abandoned') {
    this.host.ctx.bus.emit('questEvent', { player: p, quest, event });
  }
}

// ------------------------------------------------------------------ helpers

export function targetOf(s: QuestObjectiveSpec): number {
  switch (s.kind) {
    case 'kill':
    case 'collect':
    case 'deliver':
    case 'harvest':
    case 'ability':
    case 'custom':
      return Math.max(1, s.count);
    default:
      return 1;
  }
}

export function countItems(p: ServerEntity, defId: string): number {
  let n = 0;
  for (const it of p.inventory?.items ?? []) if (it.defId === defId) n += it.count;
  return n;
}

/** Distance with vertical difference weighted lower (terrain height noise). */
function dist3w(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.5, a[2] - b[2]);
}

export function humanize(id: string): string {
  return cap(id.replace(/^power\./, '').replace(/[._]/g, ' '));
}

/** Ground height near (x, ~y, z): terrain query first, analytic surface as fallback. */
export function groundNear(host: GmHost, x: number, y: number, z: number): number {
  const ctx = host.ctx;
  let gy = ctx.groundAt(x, y + 30, z, 80);
  if (!Number.isFinite(gy)) gy = ctx.gen.findGround(x, y + 60, z, 200);
  if (!Number.isFinite(gy)) gy = ctx.gen.heightAt(x, z);
  return gy;
}

export type { GmMessageKind };
