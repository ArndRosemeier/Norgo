/**
 * The Director: the pacing half of the game master. Per player it runs a
 * tension curve through four phases —
 *
 *   calm → build-up → peak → relief → calm ...
 *
 * — measuring the tension the player actually feels (hostiles nearby, recent
 * hits, health, night, depth, storms) and injecting events to shape it:
 *
 *   calm    discovery nudges, rumors, travellers & the recurring stranger, quest
 *           offers from nearby places, personal-arc beats, aurora nights, meteor
 *           showers (with a fallen star to find), gentle weather
 *   build   omens that foreshadow the planned peak, gathering storms, gravity
 *           tides, tremors below
 *   peak    beast packs, named bosses, bandit ambushes, bounty hunters, the
 *           player's nemesis, eclipses that embolden the wild
 *   relief  merchants, lucky finds when hurt or poor, clear skies, rewards for
 *           heroism, praise
 *
 * Reactions run immediately: crimes raise bounties (hunters come later), saving
 * settlements earns reputation and gifts, wrecking homes angers owners, deaths
 * create nemeses. Fairness rules: no hostile spawns while the player is hurt,
 * talking, just respawned, inside a settlement, or busy with a tracked quest
 * they are pursuing; difficulty scales with player power and current tension;
 * attackers appear in front of the player, never on top of them.
 */
import type { ServerEntity } from '../../server/entity';
import type { Vec3, WeatherKind } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { PoiInfo, SiteInfo } from '../../world/sites';
import { Biome } from '../../world/biomes';
import { SEA_LEVEL } from '../../world/constants';
import type { Rng } from '../../core/rng';
import type { GmHost, PlayerGm, Phase, NemesisRecord } from './state';
import type { Narrator } from './Narrator';
import type { QuestBook } from './QuestBook';
import { groundNear } from './QuestBook';
import { poiQuest, siteRequest, fallenThingQuest, startArc, arcQuest } from './QuestForge';
import { powerLevel } from './PlayerModel';
import { featuresNear, type Feature } from './Scout';
import { getPlayerData, setWeather, weatherLockedFor } from './access';
import { poiLore, siteLore, powerOf, personName, rumorsAbout, monsterName } from '../lore';
import * as N from '../narration';
import { compass, bearing, expand, cap } from '../text';

type EventFn = (p: ServerEntity, g: PlayerGm, r: Rng) => boolean;

interface EventDef {
  id: string;
  phases: Phase[];
  /** Base weight; multiplied by style affinities and cooldown penalties. */
  weight: number;
  cooldown: number;
  styles?: Partial<Record<string, number>>;
  hostile?: boolean;
  run: EventFn;
}

const PHASE_LEN: Record<Phase, [number, number]> = { calm: [120, 260], build: [50, 110], peak: [40, 100], relief: [60, 140] };

export class Director {
  private events: EventDef[];

  constructor(private host: GmHost, private narrator: Narrator, private quests: QuestBook) {
    this.events = this.catalog();
  }

  private get ctx() {
    return this.host.ctx;
  }

  /** Global tension (max over players) for other systems. */
  tension(states: Iterable<PlayerGm>): number {
    let t = 0, n = 0;
    for (const g of states) if (g.entity) {
      t = Math.max(t, g.director.tension);
      n++;
    }
    return n ? t : 0.3;
  }

  // ------------------------------------------------------------ per-second update

  slowTick(p: ServerEntity, g: PlayerGm, dt: number) {
    const ctx = this.ctx;
    const d = g.director;
    const now = ctx.time.now;
    if (!p.alive) return;

    // --- measure felt tension ---
    const hostiles = ctx.entities.near(p.pos, 40, (e) => e !== p && e.alive && (e.kind === 'creature' || e.kind === 'npc') && this.hostileTo(e, p));
    let threat = 0;
    for (const e of hostiles) threat += e.tags.has('boss') ? 0.45 : 0.18;
    if (hostiles.length) d.lastCombatAt = now;
    const hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 1;
    let target = Math.min(1, threat) + (now - d.lastHurtAt < 6 ? 0.2 : 0) + (1 - hpFrac) * 0.35;
    const hour = ctx.time.hour;
    if (hour < 5 || hour > 21) target += 0.08;
    if (g.live.underworld) target += 0.12;
    if (ctx.weather.kind === 'storm') target += 0.05;
    target += d.intensity;
    target = Math.min(1, target);
    d.tension += (target - d.tension) * (target > d.tension ? 0.35 : 0.06) * Math.min(1, dt);
    d.intensity = Math.max(0, d.intensity - 0.006 * dt);
    d.spawned = d.spawned.filter((id) => ctx.entities.get(id)?.alive);

    // --- nemesis escape check: a GM boss the player fled from becomes a nemesis ---
    this.checkEscapes(p, g);

    // --- phase machine ---
    const fighting = now - d.lastCombatAt < 8;
    if (fighting && (d.phase === 'calm' || d.phase === 'build') && threat > 0.3) {
      // The player found a fight on their own: that's the peak.
      this.enterPhase(g, 'peak', 60);
    }
    if (now >= d.phaseUntil) {
      if (d.phase === 'peak' && fighting) d.phaseUntil = now + 10;
      else this.advancePhase(p, g);
    }

    // --- decisions ---
    if (now >= d.nextDecisionAt) {
      const [lo, hi] = d.phase === 'build' ? [25, 50] : d.phase === 'peak' ? [20, 40] : d.phase === 'relief' ? [35, 80] : [40, 110];
      const r = this.host.rng(g, 'decide');
      d.nextDecisionAt = now + r.range(lo, hi) * this.paceFactor(g);
      if (now < d.inDialogUntil) d.nextDecisionAt = now + 15;
      else this.decide(p, g, r);
    }
  }

  /** Explorers and talkers get a slower, roomier curve; fighters a faster one. */
  private paceFactor(g: PlayerGm): number {
    const w = g.model.weights();
    return 1 + (w.explorer + w.socializer + w.crafter) * 0.5 - w.fighter * 0.6;
  }

  private enterPhase(g: PlayerGm, phase: Phase, len?: number) {
    const d = g.director;
    const r = this.host.rng(g, 'phase');
    d.phase = phase;
    const [lo, hi] = PHASE_LEN[phase];
    d.phaseUntil = this.ctx.time.now + (len ?? r.range(lo, hi) * (phase === 'calm' ? this.paceFactor(g) : 1));
  }

  private advancePhase(p: ServerEntity, g: PlayerGm) {
    const d = g.director;
    const r = this.host.rng(g, 'adv');
    switch (d.phase) {
      case 'calm':
        // Respect intent: a player chasing their tracked quest gets more room.
        if (this.pursuingQuest(p, g) && r.chance(0.6)) {
          this.enterPhase(g, 'calm', r.range(60, 120));
          return;
        }
        this.enterPhase(g, 'build');
        this.planPeak(p, g, r);
        break;
      case 'build':
        this.enterPhase(g, 'peak');
        this.runPeak(p, g, r);
        break;
      case 'peak':
        this.enterPhase(g, 'relief');
        if (this.ctx.time.now - d.lastCombatAt < 30 && !g.throttle('relief.say', this.ctx.time.now, 200)) {
          this.host.say(p, 'narration', g.variety.compose('relief', N.RELIEF, r, this.host.vars(p)), { priority: 'ambient', tone: 'calm' });
        }
        break;
      case 'relief':
        this.enterPhase(g, 'calm');
        break;
    }
  }

  /** True while the player is clearly closing in on their tracked objective. */
  private pursuingQuest(p: ServerEntity, g: PlayerGm): boolean {
    const q = this.quests.tracked(g);
    if (!q) return false;
    const o = this.quests.current(q)[0];
    const pos = o ? this.quests.objectivePos(q, o) : undefined;
    if (!pos) return false;
    const dNow = Math.hypot(p.pos[0] - pos[0], p.pos[2] - pos[2]);
    const key = `pursue:${q.id}`;
    const prev = g.flags[key];
    g.flags[key] = dNow;
    return prev !== undefined && dNow < prev - 20;
  }

  // ------------------------------------------------------------ decisions

  private decide(p: ServerEntity, g: PlayerGm, r: Rng) {
    const d = g.director;
    const now = this.ctx.time.now;
    const w = g.model.weights();
    const cands: { ev: EventDef; wt: number }[] = [];
    for (const ev of this.events) {
      if (!ev.phases.includes(d.phase)) continue;
      const last = d.lastByType[ev.id] ?? -1e9;
      if (now - last < ev.cooldown) continue;
      if (ev.hostile && !this.canThreaten(p, g)) continue;
      let wt = ev.weight;
      for (const [s, k] of Object.entries(ev.styles ?? {})) wt *= 1 + (w[s as keyof typeof w] ?? 0) * (k ?? 0);
      // Variety: penalise whatever ran recently.
      const recent = d.history.slice(-4).filter((h) => h.type === ev.id).length;
      wt /= 1 + recent * 1.5;
      if (wt > 0) cands.push({ ev, wt });
    }
    // Try candidates in weighted order until one succeeds.
    for (let tries = 0; tries < 4 && cands.length; tries++) {
      const pick = r.weighted(cands, (c) => c.wt);
      cands.splice(cands.indexOf(pick), 1);
      if (pick.ev.run(p, g, r)) {
        this.record(g, pick.ev.id);
        return;
      }
    }
  }

  private record(g: PlayerGm, type: string) {
    const d = g.director;
    d.lastByType[type] = this.ctx.time.now;
    d.history.push({ type, t: this.ctx.time.now });
    if (d.history.length > 30) d.history.shift();
  }

  /** Fairness gate for anything hostile. */
  canThreaten(p: ServerEntity, g: PlayerGm): boolean {
    const d = g.director;
    const now = this.ctx.time.now;
    if (!p.alive || p.hp < p.maxHp * 0.5) return false;
    if (now < d.inDialogUntil) return false;
    if (now - d.lastDeathAt < 120) return false;
    if (now - g.live.joinedAt < 90) return false;
    if (p.flags & EntFlag.Swimming) return false;
    if (this.ctx.gen.siteAt(p.pos[0], p.pos[2])) return false;
    if (d.spawned.length >= 6) return false;
    return true;
  }

  private hostileTo(e: ServerEntity, p: ServerEntity): boolean {
    if (e.flags & EntFlag.Hostile) return true;
    try {
      return this.ctx.services.combat.isHostile(e, p);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ peak planning

  /** Commit to a peak event at the start of the build-up so omens can foreshadow it. */
  private planPeak(p: ServerEntity, g: PlayerGm, r: Rng) {
    const d = g.director;
    const opts: [string, number][] = [];
    const bounty = Object.values(g.bounty).reduce((a, b) => a + b, 0);
    const nem = g.nemeses.find((n) => !n.defeated);
    const pw = powerLevel(p);
    const now = this.ctx.time.now;
    opts.push(['beasts', 3]);
    if (pw >= 2.5 && now - (d.lastByType.boss ?? -1e9) > 900) opts.push(['boss', 1 + pw * 0.08]);
    if (!g.live.underworld) opts.push(['bandits', 1.6]);
    if (bounty >= 40) opts.push(['hunters', 1 + bounty / 80]);
    if (nem && now - nem.lastSeen > 900) opts.push(['nemesis', 2.2]);
    if (!g.live.underworld && now - (d.lastByType.eclipse ?? -1e9) > 5400 && this.ctx.time.hour > 9 && this.ctx.time.hour < 16) opts.push(['eclipse', 0.35]);
    const type = r.weighted(opts, (o) => o[1])[0];
    d.planned = { type, dir: r.range(-1, 1), omen: false, at: now };
  }

  /** Execute the planned peak (or fall back to an alternative if impossible right now). */
  private runPeak(p: ServerEntity, g: PlayerGm, r: Rng) {
    const d = g.director;
    const plan = d.planned;
    d.planned = null;
    if (!this.canThreaten(p, g)) {
      // Not fair right now: let the peak pass as tension in the air only.
      if (plan?.omen) this.host.say(p, 'narration', 'The danger you sensed passes you by — this time.', { priority: 'ambient' });
      return;
    }
    const order = [plan?.type ?? 'beasts', 'beasts', 'bandits'];
    for (const t of order) {
      const ok = t === 'beasts' ? this.evBeasts(p, g, r, plan?.dir) : t === 'boss' ? this.evBoss(p, g, r, plan?.dir) : t === 'bandits' ? this.evBandits(p, g, r, plan?.dir)
        : t === 'hunters' ? this.evHunters(p, g, r, plan?.dir) : t === 'nemesis' ? this.evNemesis(p, g, r, plan?.dir) : t === 'eclipse' ? this.evEclipse(p, g, r) : false;
      if (ok) {
        this.record(g, t);
        d.intensity = Math.min(0.5, d.intensity + 0.25);
        return;
      }
    }
  }

  /** Allow the Oracle ("give me a challenge") to bring the peak forward. */
  forcePeak(p: ServerEntity, g: PlayerGm): boolean {
    if (!this.canThreaten(p, g)) return false;
    const r = this.host.rng(g, 'force');
    this.planPeak(p, g, r);
    this.enterPhase(g, 'build', 8);
    g.director.nextDecisionAt = this.ctx.time.now + 3;
    return true;
  }

  // ------------------------------------------------------------ spawning helpers

  /** A fair spawn point: in front of the player (±70°), on ground, not in water or a settlement. */
  private spawnPoint(p: ServerEntity, dist: number, r: Rng, dirBias?: number): Vec3 | null {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const base = Math.atan2(fx, fz);
    for (let i = 0; i < 8; i++) {
      const a = base + (dirBias ?? 0) * 0.9 + r.range(-1.2, 1.2) * (i < 4 ? 1 : 2.5);
      const dd = dist * r.range(0.85, 1.15);
      const x = p.pos[0] + Math.sin(a) * dd, z = p.pos[2] + Math.cos(a) * dd;
      if (this.ctx.gen.siteAt(x, z)) continue;
      const y = g_underground(this.host, p) ? this.ctx.groundAt(x, p.pos[1] + 6, z, 30) : groundNear(this.host, x, p.pos[1], z);
      if (!Number.isFinite(y)) continue;
      if (Math.abs(y - p.pos[1]) > 25) continue;
      if (!g_underground(this.host, p) && y < SEA_LEVEL + 0.4) continue;
      return [x, y + 0.5, z];
    }
    return null;
  }

  private biomeHere(p: ServerEntity, g: PlayerGm): number {
    const col = this.ctx.gen.cachedColumn(p.pos[0], p.pos[2]);
    return g.live.underworld ? col.uwBiome : col.biome === Biome.Ocean ? col.biome2 : col.biome;
  }

  private spawnCreatures(p: ServerEntity, g: PlayerGm, species: number, count: number, at: Vec3, r: Rng, opts: { boss?: boolean; name?: string; title?: string; growth?: number; seed?: number } = {}): ServerEntity[] {
    const out: ServerEntity[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2;
      const pos: Vec3 = [at[0] + Math.cos(a) * (i ? 2.5 : 0), at[1], at[2] + Math.sin(a) * (i ? 2.5 : 0)];
      const e = this.ctx.services.creatures.spawn(species, pos, { seed: (opts.seed ?? r.nextU32()) + i, hostile: true, boss: opts.boss && i === 0, growth: opts.growth });
      if (!e) continue;
      e.tags.add('gm');
      e.tags.add(`gm:${g.name}`);
      if (opts.boss && i === 0) {
        e.tags.add('gm-boss');
        if (opts.name) e.name = opts.name;
        if (opts.title) e.title = opts.title;
        e.dirty = true;
      }
      g.director.spawned.push(e.id);
      out.push(e);
    }
    return out;
  }

  private spawnWanderers(g: PlayerGm, kind: string, count: number, at: Vec3, seed: number): ServerEntity[] {
    const out: ServerEntity[] = [];
    for (let i = 0; i < count; i++) {
      const pos: Vec3 = [at[0] + (i % 3) * 2 - 2, at[1], at[2] + Math.floor(i / 3) * 2];
      const e = this.ctx.services.npcs.spawnWanderer(kind, pos, seed + i);
      if (!e) continue;
      e.tags.add('gm');
      e.tags.add(`gm:${g.name}`);
      out.push(e);
    }
    return out;
  }

  private dirWord(p: ServerEntity, at: Vec3): string {
    return compass(at[0] - p.pos[0], at[2] - p.pos[2]);
  }

  // ------------------------------------------------------------ peak events

  private evBeasts(p: ServerEntity, g: PlayerGm, r: Rng, dir?: number): boolean {
    const pw = powerLevel(p);
    const species = this.ctx.services.creatures.speciesFor(this.biomeHere(p, g), 'predator', g.live.underworld);
    if (!species.length) return false;
    const sp = r.pick(species);
    const at = this.spawnPoint(p, 34, r, dir);
    if (!at) return false;
    const eclipse = this.ctx.time.now - (g.director.lastByType.eclipse ?? -1e9) < 180;
    const count = Math.max(1, Math.min(6, Math.round(1 + pw * 0.22 + g.director.tension * 1.2 + (eclipse ? 1 : 0) + r.range(-0.5, 0.8))));
    const growth = Math.min(1, 0.6 + pw * 0.04);
    const spawned = this.spawnCreatures(p, g, sp, count, at, r, { growth });
    if (!spawned.length) return false;
    const what = this.ctx.services.creatures.speciesName(sp) || r.pick(N.BEAST_FALLBACK);
    const pool = spawned.length > 1 ? N.ENCOUNTER.beasts : N.ENCOUNTER.beast;
    this.host.say(p, 'event', g.variety.compose('enc.beasts', pool, r, { ...this.host.vars(p), what: spawned.length > 1 ? plural(what) : what, dir: this.dirWord(p, at) }), { pos: at, tone: 'tense', priority: 'urgent' });
    return true;
  }

  private evBoss(p: ServerEntity, g: PlayerGm, r: Rng, dir?: number): boolean {
    const cs = this.ctx.services.creatures;
    const biome = this.biomeHere(p, g);
    let species = cs.speciesFor(biome, 'boss', g.live.underworld);
    if (!species.length) species = cs.speciesFor(biome, 'predator', g.live.underworld);
    if (!species.length) return false;
    const sp = r.pick(species);
    const at = this.spawnPoint(p, 40, r, dir);
    if (!at) return false;
    const name = bossName(r, cs.speciesName(sp));
    const e = this.spawnCreatures(p, g, sp, 1, at, r, { boss: true, name, title: r.pick(['Terror of the Wilds', 'the Old One', 'Eater of Travellers', 'Lord of this Land']), growth: 1 })[0];
    if (!e) return false;
    this.host.say(p, 'event', g.variety.compose('enc.boss', N.ENCOUNTER.boss, r, { ...this.host.vars(p), name, dir: this.dirWord(p, at) }), { pos: at, tone: 'dread', priority: 'urgent', title: name });
    g.flags[`boss:${e.id}`] = this.ctx.time.now;
    return true;
  }

  private evBandits(p: ServerEntity, g: PlayerGm, r: Rng, dir?: number): boolean {
    if (g.live.underworld) return false;
    const at = this.spawnPoint(p, 30, r, dir);
    if (!at) return false;
    const count = Math.max(2, Math.min(5, Math.round(1.5 + powerLevel(p) * 0.2)));
    const out = this.spawnWanderers(g, 'bandit', count, at, r.nextU32());
    if (!out.length) return false;
    for (const e of out) g.director.spawned.push(e.id);
    this.host.say(p, 'event', g.variety.compose('enc.bandits', N.ENCOUNTER.bandits, r, { ...this.host.vars(p), count: out.length, dir: this.dirWord(p, at) }), { pos: at, tone: 'tense', priority: 'urgent' });
    return true;
  }

  private evHunters(p: ServerEntity, g: PlayerGm, r: Rng, dir?: number): boolean {
    const total = Object.values(g.bounty).reduce((a, b) => a + b, 0);
    if (total < 40) return false;
    const at = this.spawnPoint(p, 30, r, dir);
    if (!at) return false;
    const out = this.spawnWanderers(g, 'bounty_hunter', Math.min(4, 1 + Math.floor(total / 80)), at, r.nextU32());
    if (!out.length) return false;
    for (const e of out) {
      e.tags.add('bounty_hunter');
      g.director.spawned.push(e.id);
    }
    this.host.say(p, 'event', g.variety.compose('enc.hunters', N.ENCOUNTER.hunters, r, { ...this.host.vars(p), dir: this.dirWord(p, at) }) + ` (Your bounty: ${Math.round(total)} coins. Ask the Game Master to pay it.)`, { pos: at, tone: 'tense', priority: 'urgent' });
    return true;
  }

  private evNemesis(p: ServerEntity, g: PlayerGm, r: Rng, dir?: number): boolean {
    const nem = g.nemeses.find((n) => !n.defeated);
    if (!nem) return false;
    const at = this.spawnPoint(p, 38, r, dir);
    if (!at) return false;
    nem.growth = Math.min(1.3, nem.growth + 0.08);
    const e = this.spawnCreatures(p, g, nem.species, 1, at, r, { boss: true, name: nem.name, title: 'Your nemesis', growth: Math.min(1, nem.growth), seed: nem.seed })[0];
    if (!e) return false;
    e.tags.add(`nemesis:${nem.id}`);
    nem.encounters++;
    nem.lastSeen = this.ctx.time.now;
    this.host.say(p, 'event', g.variety.compose('enc.nem', N.ENCOUNTER.nemesis, r, { ...this.host.vars(p), name: nem.name, dir: this.dirWord(p, at) }), { pos: at, tone: 'dread', priority: 'urgent', title: nem.name });
    return true;
  }

  private evEclipse(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    if (g.live.underworld) return false;
    this.ctx.broadcast({ type: 'fx', fx: 'eclipse', pos: p.pos, radius: 5000, duration: 150 });
    this.host.say(p, 'event', g.variety.compose('sky.eclipse', N.SKY_EVENT.eclipse, r, this.host.vars(p)), { tone: 'dread', priority: 'urgent', title: 'Eclipse' });
    g.beat('Lived through an eclipse.', this.ctx.time.now, this.ctx.time.day);
    g.director.lastByType.eclipse = this.ctx.time.now;
    // The wild grows bold: a pack follows shortly if fair.
    this.evBeasts(p, g, r);
    return true;
  }

  // ------------------------------------------------------------ escapes & nemeses

  private checkEscapes(p: ServerEntity, g: PlayerGm) {
    for (const id of g.director.spawned) {
      const e = this.ctx.entities.get(id);
      if (!e || !e.tags.has('gm-boss') || e.tags.has('nemesis-made')) continue;
      const dist = Math.hypot(e.pos[0] - p.pos[0], e.pos[2] - p.pos[2]);
      const fought = e.lastAttacker === p.id || e.hp < e.maxHp;
      if (fought && dist > 130) {
        e.tags.add('nemesis-made');
        this.makeNemesis(p, g, e, 'escaped');
      }
    }
  }

  /** Record a creature as the player's nemesis (it escaped, or it killed them). */
  makeNemesis(p: ServerEntity, g: PlayerGm, e: ServerEntity, how: 'escaped' | 'victor'): NemesisRecord | null {
    if (!e.creature) return null;
    const existing = g.nemeses.find((n) => !n.defeated && (n.name === e.name || n.seed === e.creature!.seed));
    if (existing) {
      if (how === 'victor') existing.victories++;
      existing.lastSeen = this.ctx.time.now;
      return existing;
    }
    if (g.nemeses.filter((n) => !n.defeated).length >= 2) return null;
    const r = this.host.rng(g, 'nem');
    const name = e.name || bossName(r, this.ctx.services.creatures.speciesName(e.creature.species));
    const nem: NemesisRecord = {
      id: `n${g.nemeses.length + 1}`, name, species: e.creature.species, seed: e.creature.seed, encounters: 1, victories: how === 'victor' ? 1 : 0,
      scars: e.hp < e.maxHp ? ['a wound you gave it'] : [], defeated: false, lastSeen: this.ctx.time.now, growth: e.creature.growth,
    };
    g.nemeses.push(nem);
    if (how === 'escaped') this.host.say(p, 'omen', `${name} slips away, wounded and furious. You have not seen the last of it.`, { tone: 'dread', priority: 'normal', beat: `Let ${name} escape` });
    return nem;
  }

  // ------------------------------------------------------------ reactions

  onPlayerHurt(p: ServerEntity, g: PlayerGm, amount: number) {
    g.director.lastHurtAt = this.ctx.time.now;
    if (p.alive && p.hp > 0 && p.hp < p.maxHp * 0.2) this.narrator.onNearDeath(p);
  }

  onPlayerDied(p: ServerEntity, g: PlayerGm, killer: ServerEntity | undefined) {
    const d = g.director;
    d.lastDeathAt = this.ctx.time.now;
    d.planned = null;
    this.enterPhase(g, 'relief', 180);
    let killerName: string | null = null;
    if (killer && killer !== p) {
      killerName = killer.name || (killer.creature ? this.ctx.services.creatures.speciesName(killer.creature.species) : null) || null;
      if (killer.creature && (killer.tags.has('gm-boss') || killer.tags.has('boss') || killer.name)) {
        const nem = this.makeNemesis(p, g, killer, 'victor');
        if (nem) killerName = nem.name;
        killer.tags.add('nemesis-made');
      }
    }
    this.narrator.onDeath(p, killerName);
  }

  /** A creature/NPC died: credit kills, nemesis defeats, heroism. */
  onKill(p: ServerEntity, g: PlayerGm, victim: ServerEntity) {
    const cs = this.ctx.services.creatures;
    const role = ['bandit', 'bounty_hunter', 'guard', 'cultist', 'soldier', 'merchant', 'pilgrim'].find((t) => victim.tags.has(t));
    const label = victim.creature ? cs.speciesName(victim.creature.species) || 'beast' : this.ctx.services.npcs.profile(victim.id)?.job ?? role?.replace('_', ' ') ?? victim.title ?? 'foe';
    const nemTag = [...victim.tags].find((t) => t.startsWith('nemesis:'));
    let nemName = '';
    if (nemTag) {
      const nem = g.nemeses.find((n) => n.id === nemTag.slice(8));
      if (nem) {
        nem.defeated = true;
        nemName = nem.name;
        this.grantCoins(p, Math.round(60 + powerLevel(p) * 20));
      }
    } else if (victim.creature && victim.name) {
      // A named creature that was a nemesis (by seed) but spawned by someone else.
      const nem = g.nemeses.find((n) => !n.defeated && n.seed === victim.creature!.seed);
      if (nem) {
        nem.defeated = true;
        nemName = nem.name;
      }
    }
    const boss = victim.tags.has('boss') || victim.tags.has('gm-boss');
    g.model.onKill(victim, label, (p.flags & EntFlag.Sneaking) !== 0, boss);
    this.narrator.onKill(p, label, boss, !!nemName, nemName || victim.name);
    if (boss) g.director.intensity = 0;
    // Heroism: slaying a hostile near a settlement or near townsfolk.
    if (this.hostileTo(victim, p) || victim.faction === 'hostile' || victim.tags.has('bandit')) {
      const site = this.ctx.gen.sites.sitesNear(victim.pos[0], victim.pos[2], 0).find((s) => Math.hypot(s.x - victim.pos[0], s.z - victim.pos[2]) < s.radius * 2.5);
      const npcsNear = this.ctx.entities.near(victim.pos, 25, (e) => e.kind === 'npc' && e.alive && !this.hostileTo(e, p)).length;
      if (site || npcsNear > 0) this.heroism(p, g, site);
    }
  }

  private heroism(p: ServerEntity, g: PlayerGm, site: SiteInfo | undefined) {
    const ctx = this.ctx;
    g.model.history.heroics++;
    const d = getPlayerData(ctx, p.id);
    if (!d) return;
    if (site) {
      const power = powerOf(ctx.gen.profile, site.race);
      d.reputation[`site.${site.id}`] = Math.min(100, (d.reputation[`site.${site.id}`] ?? 0) + 2);
      if (power) d.reputation[power.id] = Math.min(100, (d.reputation[power.id] ?? 0) + 1);
      ctx.markPlayerDirty(p.id, 'reputation');
      // Count deeds per settlement; the relief phase pays out once enough pile up.
      const key = `hero:${site.id}:n`;
      g.flags[key] = (g.flags[key] ?? 0) + 1;
      if (!g.throttle(`herosay:${site.id}`, ctx.time.now, 300)) {
        const r = this.host.rng(g, 'hero');
        this.host.say(p, 'narration', g.variety.compose('hero', N.HEROISM, r, { ...this.host.vars(p), place: site.name }), { priority: 'normal', tone: 'triumph' });
      }
    }
    for (const npc of ctx.entities.near(p.pos, 25, (e) => e.kind === 'npc' && e.alive)) {
      ctx.services.npcs.adjustDisposition(npc.id, p.id, 4, 'defended us');
      ctx.services.npcs.remember(npc.id, `${p.name} fought off a threat nearby`, 0.6);
    }
  }

  onCrime(p: ServerEntity, g: PlayerGm, kind: 'assault' | 'murder' | 'theft' | 'vandalism' | 'trespass', pos: Vec3) {
    const ctx = this.ctx;
    g.model.onCrime(kind);
    g.flags.lastCrimeAt = ctx.time.now;
    const amount = { assault: 15, murder: 120, theft: 25, vandalism: 20, trespass: 5 }[kind];
    const site = ctx.gen.siteAt(pos[0], pos[2]) ?? ctx.gen.sites.sitesNear(pos[0], pos[2], 600).sort((a, b) => Math.hypot(a.x - pos[0], a.z - pos[2]) - Math.hypot(b.x - pos[0], b.z - pos[2]))[0];
    const power = site ? powerOf(ctx.gen.profile, site.race) : undefined;
    const key = power?.id ?? 'wilds';
    g.bounty[key] = (g.bounty[key] ?? 0) + amount;
    const d = getPlayerData(ctx, p.id);
    if (d) {
      if (power) d.reputation[power.id] = Math.max(-100, (d.reputation[power.id] ?? 0) - Math.ceil(amount / 6));
      if (site) d.reputation[`site.${site.id}`] = Math.max(-100, (d.reputation[`site.${site.id}`] ?? 0) - Math.ceil(amount / 4));
      ctx.markPlayerDirty(p.id, 'reputation');
    }
    if (!g.throttle(`crime:${kind}`, ctx.time.now, 45)) {
      const r = this.host.rng(g, 'crime');
      this.host.say(p, 'event', g.variety.compose('bounty', N.BOUNTY, r, { ...this.host.vars(p), power: power?.name ?? 'the roads', amount: Math.round(g.bounty[key]) }), { tone: 'tense', priority: 'normal' });
    }
    if (kind === 'murder') g.beat(`Took an innocent life${site ? ` in ${site.name}` : ''}`, ctx.time.now, ctx.time.day);
  }

  onObjectDestroyed(p: ServerEntity, g: PlayerGm, id: number | string, kind: string, pos: Vec3) {
    const ctx = this.ctx;
    const site = ctx.gen.siteAt(pos[0], pos[2]);
    if (!site) return;
    const isBuilding = (typeof id === 'string' && id.startsWith('B:')) || /wall|door|house|roof|window|fence|stall|building|piece|beam|chest|crate|barrel|gate/.test(kind);
    if (!isBuilding) return;
    const d = getPlayerData(ctx, p.id);
    if (d) {
      d.reputation[`site.${site.id}`] = Math.max(-100, (d.reputation[`site.${site.id}`] ?? 0) - 3);
      ctx.markPlayerDirty(p.id, 'reputation');
    }
    const dmgKey = `vandal:${site.id}`;
    g.flags[dmgKey] = (g.flags[dmgKey] ?? 0) + 1;
    // If the settlement system did not file a crime for this, the GM does.
    if (ctx.time.now - (g.flags.lastCrimeAt ?? -1e9) > 2) this.onCrime(p, g, 'vandalism', pos);
    const r = this.host.rng(g, 'vandal');
    if (!g.throttle(`vandalsay:${site.id}`, ctx.time.now, 60)) {
      this.host.say(p, 'event', g.variety.compose('vandal', N.VANDAL, r, this.host.vars(p)), { tone: 'tense', priority: 'normal' });
    }
    // Enough damage: the owner comes to have words, and amends are offered.
    if (g.flags[dmgKey] >= 3 && !g.throttle(`owner:${site.id}`, ctx.time.now, 600)) {
      const at = this.spawnPoint(p, 10, r) ?? ([p.pos[0] + 6, p.pos[1], p.pos[2]] as Vec3);
      const owner = this.spawnWanderers(g, 'angry_owner', 1, at, r.nextU32())[0];
      if (owner) {
        if (!owner.name) owner.name = personName(site.race, r, true);
        owner.speech = { text: r.pick(['My home! You will pay for this!', 'What have you done?!', 'Thug! Vandal! Guards!']), until: ctx.time.now + 6, style: 'shout' };
        owner.dirty = true;
      }
      const cost = g.flags[dmgKey] * 15;
      this.quests.create(p, {
        source: 'gm', category: 'bounty', title: `Amends in ${site.name}`, giver: owner?.name ?? `the folk of ${site.name}`,
        summary: `You damaged property in ${site.name}. Pay ${cost} coins for repairs (tell the Game Master "pay for the damage") and the matter is closed.`,
        objectives: [{ kind: 'custom', text: `Pay ${cost} coins for the damage`, event: `amends:${site.id}`, count: 1 }],
        rewards: { reputation: { [`site.${site.id}`]: 8 }, text: 'a clean conscience' }, meta: { amends: cost, site: site.id },
      }, { origin: `amends:${site.id}:${Math.floor(ctx.time.now)}` });
    }
  }

  /** Called when the player talks to someone: pause the director briefly. */
  onDialog(g: PlayerGm) {
    g.director.inDialogUntil = this.ctx.time.now + 25;
  }

  // ------------------------------------------------------------ discoveries → quests

  /** A POI was discovered: maybe offer its quest (not every time; never spam). */
  onDiscoverPoi(p: ServerEntity, g: PlayerGm, poi: PoiInfo) {
    if (g.generatedOrigins.has(poi.id)) return;
    const open = g.quests.filter((q) => (q.status === 'offered' || q.status === 'active') && q.spec.source === 'poi').length;
    if (open >= 3) return;
    const r = this.host.rng(g, 'poiq', poi.id);
    if (!r.chance(0.7)) {
      g.generatedOrigins.add(poi.id);
      return;
    }
    const q = poiQuest(this.host, p, poi, r);
    if (q) this.quests.create(p, q.spec, q.opts);
  }

  onEnterSite(p: ServerEntity, g: PlayerGm, site: SiteInfo) {
    const origin = `req:${site.id}`;
    if (g.generatedOrigins.has(origin)) return;
    const r = this.host.rng(g, 'siteq', site.id);
    // Let the arrival narration land first; offer on the next visit tick.
    g.flags[`offerSite:${site.id}`] = this.ctx.time.now + r.range(8, 20);
  }

  /** Deferred offers (site requests) and arc beats. */
  pendingOffers(p: ServerEntity, g: PlayerGm) {
    const now = this.ctx.time.now;
    for (const [k, t] of Object.entries(g.flags)) {
      if (!k.startsWith('offerSite:') || now < t) continue;
      delete g.flags[k];
      const site = this.ctx.gen.siteAt(p.pos[0], p.pos[2]);
      if (!site || `offerSite:${site.id}` !== k) continue;
      const open = g.quests.filter((q) => (q.status === 'offered' || q.status === 'active') && q.spec.source === 'settlement').length;
      if (open >= 2) continue;
      const q = siteRequest(this.host, p, site, this.host.rng(g, 'sitereq', site.id));
      if (q) this.quests.create(p, q.spec, q.opts);
    }
    // Personal arc: begins once the player has found their feet.
    if (!g.arc && g.model.history.playTime > 480 && now - g.live.joinedAt > 120) {
      const r = this.host.rng(g, 'arc');
      g.arc = startArc(this.host, p, g.model.dominant(), r);
      this.offerArcStage(p, g);
    }
  }

  offerArcStage(p: ServerEntity, g: PlayerGm) {
    const arc = g.arc;
    if (!arc || arc.done) return;
    if (g.quests.some((q) => q.arc?.id === arc.id && q.arc.stage === arc.stage && (q.status === 'active' || q.status === 'offered'))) return;
    const q = arcQuest(this.host, p, arc, this.host.rng(g, 'arcq', arc.stage));
    if (q) this.quests.create(p, q.spec, q.opts);
  }

  /** Arc quests advance the arc on completion; failures let the GM re-offer later. */
  onQuestEvent(p: ServerEntity, g: PlayerGm, questId: string, event: string) {
    const rec = g.quests.find((q) => q.id === questId);
    if (!rec) return;
    if (event === 'completed') {
      g.director.intensity = Math.max(0, g.director.intensity - 0.2);
      if (rec.arc && g.arc && rec.arc.id === g.arc.id) {
        g.arc.stage++;
        if (g.arc.stage >= 3) {
          g.arc.done = true;
          g.beat(`Finished the tale of ${g.arc.data.figure}`, this.ctx.time.now, this.ctx.time.day);
        } else g.flags.arcNextAt = this.ctx.time.now + 90;
      }
      // Heroism ripples: finishing settlement requests improves standing in town.
      if (rec.spec.source === 'settlement' || rec.spec.source === 'poi') g.model.history.heroics++;
    }
    if ((event === 'failed' || event === 'abandoned') && rec.arc && g.arc && !g.arc.done) g.flags.arcNextAt = this.ctx.time.now + 600;
  }

  arcTick(p: ServerEntity, g: PlayerGm) {
    const t = g.flags.arcNextAt;
    if (t !== undefined && this.ctx.time.now >= t) {
      delete g.flags.arcNextAt;
      this.offerArcStage(p, g);
    }
  }

  // ------------------------------------------------------------ calm / build / relief events

  private catalog(): EventDef[] {
    const E = (id: string, phases: Phase[], weight: number, cooldown: number, run: EventFn, styles?: EventDef['styles'], hostile?: boolean): EventDef => ({ id, phases, weight, cooldown, run, styles, hostile });
    return [
      E('nudge', ['calm', 'relief'], 3, 90, (p, g, r) => this.evNudge(p, g, r), { explorer: 3 }),
      E('rumor', ['calm', 'relief'], 1.6, 180, (p, g, r) => this.evRumor(p, g, r), { socializer: 3, explorer: 1 }),
      E('questOffer', ['calm', 'relief'], 1.8, 240, (p, g, r) => this.evQuestOffer(p, g, r), { explorer: 1, fighter: 1 }),
      E('merchant', ['calm', 'relief'], 1.2, 480, (p, g, r) => this.evTraveller(p, g, r, 'merchant'), { socializer: 2, crafter: 1.5 }),
      E('pilgrim', ['calm', 'relief'], 0.8, 600, (p, g, r) => this.evTraveller(p, g, r, 'pilgrim'), { socializer: 2 }),
      E('stranger', ['calm', 'relief'], 0.7, 1200, (p, g, r) => this.evStranger(p, g, r), { socializer: 2, explorer: 1 }),
      E('aurora', ['calm', 'relief'], 1.4, 2400, (p, g, r) => this.evAurora(p, g, r), { explorer: 1, mage: 1 }),
      E('meteors', ['calm', 'build'], 0.8, 3600, (p, g, r) => this.evMeteors(p, g, r), { explorer: 1.5, mage: 1 }),
      E('weatherCalm', ['calm', 'relief'], 0.9, 600, (p, g, r) => this.evWeather(p, g, r, 'calm')),
      E('idle', ['calm'], 0.5, 300, (p, g) => this.evIdle(p, g)),
      E('omen', ['build'], 4, 30, (p, g, r) => this.evOmen(p, g, r)),
      E('weatherBuild', ['build'], 1.5, 600, (p, g, r) => this.evWeather(p, g, r, 'build')),
      E('gravityTide', ['build', 'calm'], 0.7, 1500, (p, g, r) => this.evGravityTide(p, g, r), { explorer: 1.5, mage: 1 }),
      E('tremor', ['build'], 1.2, 600, (p, g, r) => this.evTremor(p, g, r)),
      E('luckyFind', ['relief'], 1.5, 900, (p, g, r) => this.evLuckyFind(p, g, r), { explorer: 1, crafter: 1 }),
      E('heroReward', ['relief', 'calm'], 3, 300, (p, g, r) => this.evHeroReward(p, g, r)),
      E('lone', ['peak'], 1, 60, (p, g, r) => this.evBeasts(p, g, r), { fighter: 2 }, true),
    ];
  }

  private evNudge(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const feats = featuresNear(this.ctx.gen, g.scout, p.pos, 650);
    const d = getPlayerData(this.ctx, p.id);
    const known = d?.discovered ?? new Set<string>();
    const cand = feats.filter((f) => !g.scout.visited.has(f.id) && !g.scout.nudged.has(f.id) && !known.has(f.id) && Math.hypot(f.x - p.pos[0], f.z - p.pos[2]) > 60);
    if (!cand.length) {
      // Nothing near: speak of the deep, once in a while.
      if (g.flags['uw:ever'] || g.throttle('nudge.uw', this.ctx.time.now, 3600)) return false;
      this.host.say(p, 'hint', g.variety.compose('nudge.underworld', N.NUDGE.underworld, r, this.host.vars(p)), { priority: 'ambient' });
      return true;
    }
    // Prefer kinds the player has not seen much of; shafts & islands are showpieces.
    const kindWeight: Record<string, number> = { poi: 1.2, site: 0.8, shaft: g.flags['uw:ever'] ? 0.4 : 2, cave: 0.8, island: 1.5, anomaly: g.flags['grav:ever'] ? 0.4 : 1.6 };
    // Diminishing returns per kind so hints stay varied (not five cave mouths in a row).
    const f = r.weighted(cand, (c) => ((kindWeight[c.kind] ?? 1) / (1 + (g.flags[`nudges:${c.kind}`] ?? 0) * 0.8)) / (1 + Math.hypot(c.x - p.pos[0], c.z - p.pos[2]) / 300));
    g.scout.nudged.add(f.id);
    g.flags[`nudges:${f.kind}`] = (g.flags[`nudges:${f.kind}`] ?? 0) + 1;
    const vars = { ...this.host.vars(p), dir: compass(f.x - p.pos[0], f.z - p.pos[2]), name: this.featureName(f) };
    const pool = N.NUDGE[f.kind === 'poi' ? 'poi' : f.kind] ?? N.NUDGE.poi;
    this.host.say(p, 'hint', g.variety.compose(`nudge.${f.kind}`, pool, r, vars), { pos: [f.x, f.y, f.z], priority: 'ambient' });
    return true;
  }

  featureName(f: Feature): string {
    const gen = this.ctx.gen;
    if (f.kind === 'poi') {
      const poi = gen.sites.poisNear(f.x, f.z, 1).find((q) => q.id === f.id);
      return poi ? poiLore(gen.profile, poi).name : 'something old';
    }
    if (f.kind === 'site') {
      const s = gen.sites.sitesNear(f.x, f.z, 0).find((q) => q.id === f.id);
      return s ? s.name : 'a settlement';
    }
    if (f.kind === 'shaft') return `a shaft into ${this.host.lore.underworldName}`;
    if (f.kind === 'cave') return 'a cave mouth';
    if (f.kind === 'island') return 'a floating island';
    return `one of the ${this.host.lore.anomalyName}`;
  }

  private evRumor(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const gen = this.ctx.gen;
    const d = getPlayerData(this.ctx, p.id);
    const lines = rumorsAbout(gen.profile, { x: p.pos[0], z: p.pos[2], pois: gen.sites.poisNear(p.pos[0], p.pos[2], 900), sites: gen.sites.sitesNear(p.pos[0], p.pos[2], 1500), known: d?.discovered }, r, 1);
    if (!lines.length) return false;
    const text = lines[0];
    if (g.variety.wasSaid(text)) return false;
    g.variety.remember(text);
    this.host.say(p, 'rumor', text, { priority: 'ambient' });
    return true;
  }

  private evQuestOffer(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const open = g.quests.filter((q) => q.status === 'offered' || q.status === 'active').length;
    if (open >= 4) return false;
    const pois = this.ctx.gen.sites.poisNear(p.pos[0], p.pos[2], 700).filter((q) => !g.generatedOrigins.has(q.id));
    if (!pois.length) return false;
    pois.sort((a, b) => Math.hypot(a.x - p.pos[0], a.z - p.pos[2]) - Math.hypot(b.x - p.pos[0], b.z - p.pos[2]));
    const poi = pois[0];
    const q = poiQuest(this.host, p, poi, r);
    if (!q) return false;
    const pl = poiLore(this.ctx.gen.profile, poi);
    // Urgent so the lead-in arrives before the offer it introduces.
    this.host.say(p, 'rumor', `${r.pick(['Word on the wind:', 'A traveller you passed mentioned it:', 'You recall an old story:'])} ${cap(pl.name)}, ${bearing({ x: p.pos[0], z: p.pos[2] }, poi)}. ${pl.hook}`, { priority: 'urgent', pos: [poi.x, poi.y, poi.z] });
    this.quests.create(p, q.spec, q.opts);
    return true;
  }

  private evTraveller(p: ServerEntity, g: PlayerGm, r: Rng, kind: 'merchant' | 'pilgrim'): boolean {
    if (g.live.underworld && kind === 'pilgrim') return false;
    const at = this.spawnPoint(p, 28, r);
    if (!at) return false;
    const e = this.spawnWanderers(g, kind, 1, at, r.nextU32())[0];
    if (!e) return false;
    const god = r.pick(this.host.lore.pantheon).name;
    this.host.say(p, 'event', g.variety.compose(`enc.${kind}`, N.ENCOUNTER[kind], r, { ...this.host.vars(p), dir: this.dirWord(p, at), god }), { pos: at, priority: 'normal', tone: 'calm' });
    return true;
  }

  private evStranger(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    if (g.live.underworld) return false;
    let ch = g.recurring[0];
    if (!ch) {
      const living = this.host.lore.figures.find((f) => f.fate === 'alive');
      const race = living?.race ?? (this.ctx.gen.profile.races[0]?.id ?? 'human');
      ch = { name: living ? `${living.name} ${living.epithet}` : personName(race, r, true), race, kind: 'adventurer', seed: r.nextU32(), meetings: 0, lastMet: 0, figure: living?.id };
      g.recurring.push(ch);
    }
    const at = this.spawnPoint(p, 18, r);
    if (!at) return false;
    const e = this.spawnWanderers(g, ch.kind, 1, at, ch.seed)[0];
    if (!e) return false;
    e.name = ch.name.split(' ')[0];
    e.title = ch.meetings ? 'An old acquaintance' : 'A curious stranger';
    e.dirty = true;
    ch.meetings++;
    ch.lastMet = this.ctx.time.now;
    const gen = this.ctx.gen;
    const rumor = rumorsAbout(gen.profile, { x: p.pos[0], z: p.pos[2], pois: gen.sites.poisNear(p.pos[0], p.pos[2], 1200), sites: [], known: getPlayerData(this.ctx, p.id)?.discovered }, r, 1)[0] ?? '';
    const intro = ch.meetings === 1
      ? `A traveller introduces themself as ${ch.name}${ch.figure ? ' — a name from the old songs, though surely a coincidence' : ''}. "We will meet again," they say, as if they know it.`
      : g.variety.compose('enc.stranger', N.ENCOUNTER.stranger, r, { ...this.host.vars(p), name: ch.name, dir: this.dirWord(p, at) });
    this.host.say(p, 'event', `${intro} ${rumor ? `They lean close: “${rumor}”` : ''}`, { pos: at, priority: 'normal', title: ch.name, beat: ch.meetings === 1 ? `Met ${ch.name}` : undefined });
    return true;
  }

  private evAurora(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const h = this.ctx.time.hour;
    if (g.live.underworld || (h > 4.5 && h < 21)) return false;
    const strength = this.ctx.gen.profile.auroraStrength;
    if (strength <= 0 && !r.chance(0.15)) return false;
    this.ctx.broadcast({ type: 'fx', fx: 'aurora', pos: p.pos, radius: 4000, duration: 240, color: hueRgb(this.ctx.gen.profile.foliageHue) });
    this.host.say(p, 'event', g.variety.compose('sky.aurora', N.SKY_EVENT.aurora, r, this.host.vars(p)), { tone: 'wonder', priority: 'normal', title: 'Aurora' });
    g.director.intensity = Math.max(0, g.director.intensity - 0.1);
    return true;
  }

  private evMeteors(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const h = this.ctx.time.hour;
    if (g.live.underworld || (h > 4.5 && h < 20.5)) return false;
    const ctx = this.ctx;
    for (let i = 0; i < 14; i++) {
      const a = r.range(0, Math.PI * 2);
      const pos: Vec3 = [p.pos[0] + Math.cos(a) * r.range(200, 900), p.pos[1] + r.range(250, 450), p.pos[2] + Math.sin(a) * r.range(200, 900)];
      ctx.broadcast({ type: 'fx', fx: 'meteor', pos, dir: [r.range(-1, 1), -0.6, r.range(-1, 1)], duration: r.range(0.8, 2.2) }, p.pos, 2000);
    }
    // One falls close enough to find.
    const a = r.range(0, Math.PI * 2);
    const dist = r.range(160, 320);
    const x = p.pos[0] + Math.cos(a) * dist, z = p.pos[2] + Math.sin(a) * dist;
    const y = groundNear(this.host, x, ctx.gen.heightAt(x, z), z);
    if (!Number.isFinite(y) || y < SEA_LEVEL) return false;
    const impact: Vec3 = [x, y, z];
    ctx.broadcast({ type: 'fx', fx: 'meteor_impact', pos: impact, radius: 6, duration: 3 }, impact, 1500);
    ctx.broadcast({ type: 'shake', pos: impact, strength: 0.6 }, impact, 600);
    ctx.broadcast({ type: 'sound', sound: 'meteor_impact', pos: impact, volume: 1 }, impact, 1200);
    this.dropStarMetal(impact, r);
    this.host.say(p, 'event', g.variety.compose('sky.meteors', N.SKY_EVENT.meteors, r, { ...this.host.vars(p), dir: compass(x - p.pos[0], z - p.pos[2]) }), { pos: impact, tone: 'wonder', priority: 'urgent', title: 'Falling Stars', beat: 'Watched the stars fall' });
    const q = fallenThingQuest(this.host, p, impact, 'Fallen Star', 'A star fell from the sky not far from you. Whatever landed is still glowing.', `star:${Math.round(x)},${Math.round(z)}`, r);
    this.quests.create(p, q.spec, q.opts);
    return true;
  }

  private dropStarMetal(pos: Vec3, r: Rng) {
    const items = this.ctx.services.items;
    let it = null;
    try {
      if (items.def('star_metal')) it = items.create('star_metal', { seed: r.nextU32(), rarity: 'rare' });
    } catch {
      it = null;
    }
    const loot = it ? [it] : items.rollLoot('chest.ruin', 5, r.nextU32()).slice(0, 1);
    for (const x of loot) items.drop([pos[0], pos[1] + 0.6, pos[2]], x, [0, 2, 0]);
  }

  private evWeather(p: ServerEntity, g: PlayerGm, r: Rng, mood: 'calm' | 'build'): boolean {
    if (g.live.underworld || weatherLockedFor(this.ctx) > 0) return false;
    const biome = this.biomeHere(p, g);
    let kind: WeatherKind;
    if (mood === 'calm') kind = r.pick(['clear', 'clear', 'cloudy', 'fog'] as WeatherKind[]);
    else {
      const opts: WeatherKind[] = ['storm', 'fog', 'rain'];
      if (biome === Biome.Tundra || biome === Biome.Glacier || biome === Biome.Taiga) opts.push('snow', 'snow');
      if (biome === Biome.Volcanic) opts.push('ashfall', 'ashfall');
      if (biome === Biome.FungalGrove) opts.push('sporefall');
      if (biome === Biome.Desert || biome === Biome.SaltFlats || biome === Biome.Badlands) opts.splice(0, opts.length, 'storm', 'cloudy');
      kind = r.pick(opts);
    }
    if (kind === this.ctx.weather.kind) return false;
    const a = r.range(0, Math.PI * 2);
    // The world system announces it on the bus; the narrator describes it.
    return setWeather(this.ctx, { kind, intensity: kind === 'clear' ? 0 : r.range(0.45, mood === 'build' ? 1 : 0.7), windX: Math.cos(a), windZ: Math.sin(a) }, mood === 'build' ? 300 : 400);
  }

  private evIdle(p: ServerEntity, g: PlayerGm): boolean {
    if (this.ctx.time.now - g.live.lastMoveAt < 40) return false;
    this.narrator.ambientIdle(p, g);
    return true;
  }

  private evOmen(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const plan = g.director.planned;
    if (!plan || plan.omen) return false;
    plan.omen = true;
    const keyByType: Record<string, string> = { beasts: 'beast', boss: 'beast', bandits: 'bandit', hunters: 'hunter', nemesis: 'nemesis', eclipse: 'eclipse' };
    const key = keyByType[plan.type] ?? 'beast';
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const ang = Math.atan2(fx, fz) + plan.dir * 0.9;
    const dir = compass(Math.sin(ang), Math.cos(ang));
    const nem = g.nemeses.find((n) => !n.defeated);
    this.host.say(p, 'omen', g.variety.compose(`omen.${key}`, N.OMENS[key], r, { ...this.host.vars(p), dir, name: nem?.name ?? 'Something' }), { tone: 'tense', priority: 'normal' });
    g.director.intensity = Math.min(0.4, g.director.intensity + 0.1);
    return true;
  }

  private evGravityTide(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const near = featuresNear(this.ctx.gen, g.scout, p.pos, 500).some((f) => f.kind === 'anomaly' || f.kind === 'island');
    if (!near && !r.chance(0.2)) return false;
    const light = r.chance(0.7);
    const until = this.ctx.time.now + r.range(25, 45);
    this.ctx.broadcast({ type: 'gravity', pos: [p.pos[0], p.pos[1], p.pos[2]], radius: 55, factor: light ? 0.35 : 1.6, until }, p.pos, 300);
    this.ctx.broadcast({ type: 'fx', fx: 'gravity_tide', pos: p.pos, radius: 55, duration: until - this.ctx.time.now }, p.pos, 300);
    const pool = N.SKY_EVENT.gravity;
    this.host.say(p, 'event', expand(pool[light ? 0 : 1], r, this.host.vars(p)), { tone: 'wonder', priority: 'urgent', title: 'Gravity Tide' });
    if (!g.flags.gravTide) {
      g.flags.gravTide = this.ctx.time.now;
      g.beat(`Rode out a gravity tide`, this.ctx.time.now, this.ctx.time.day);
    }
    return true;
  }

  private evTremor(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const col = this.ctx.gen.cachedColumn(p.pos[0], p.pos[2]);
    const underground = g.live.underworld || p.pos[1] < col.height - 12;
    if (!underground && !r.chance(0.25)) return false;
    this.ctx.broadcast({ type: 'shake', pos: p.pos, strength: underground ? 0.8 : 0.4 }, p.pos, 200);
    this.ctx.broadcast({ type: 'sound', sound: 'tremor', pos: p.pos, volume: 0.9 }, p.pos, 200);
    this.host.say(p, 'event', g.variety.compose('sky.tremor', N.SKY_EVENT.tremor, r, this.host.vars(p)), { tone: 'dread', priority: 'normal' });
    return true;
  }

  private evLuckyFind(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    const hurt = p.hp < p.maxHp * 0.6;
    const poor = (p.inventory?.coins ?? 0) < 30;
    if (!hurt && !poor && !r.chance(0.25)) return false;
    const at = this.spawnPoint(p, 9, r);
    if (!at) return false;
    const items = this.ctx.services.items;
    const loot = items.rollLoot('cache.travel', Math.round(powerLevel(p)), r.nextU32());
    if (loot.length) for (const it of loot.slice(0, 3)) items.drop(at, it, [0, 1.5, 0]);
    else this.grantCoins(p, 10 + Math.round(powerLevel(p) * 4));
    const text = g.variety.compose('lucky', N.LUCKY_FIND, r, { ...this.host.vars(p), dir: this.dirWord(p, at) });
    this.host.say(p, 'event', loot.length ? text : `${text} Inside: a few coins, tucked away by someone long gone.`, { pos: at, priority: 'normal', tone: 'calm' });
    return true;
  }

  private evHeroReward(p: ServerEntity, g: PlayerGm, r: Rng): boolean {
    for (const [k, n] of Object.entries(g.flags)) {
      if (!k.startsWith('hero:') || !k.endsWith(':n') || n < 3) continue;
      const siteId = k.slice(5, -2);
      g.flags[k] = 0;
      const site = this.ctx.gen.sites.sitesNear(p.pos[0], p.pos[2], 3000).find((s) => s.id === siteId);
      const sl = site ? siteLore(this.ctx.gen.profile, site) : null;
      const coins = Math.round(30 + powerLevel(p) * 10);
      this.grantCoins(p, coins);
      const at = this.spawnPoint(p, 14, r);
      if (at) this.spawnWanderers(g, 'messenger', 1, at, r.nextU32());
      this.host.say(p, 'event', `A messenger finds you on the road, out of breath. "From ${sl ? `${sl.rulerTitle} ${sl.ruler} of ${site!.name}` : 'grateful folk'} — for keeping us safe." The purse holds ${coins} coins.`, {
        priority: 'normal', tone: 'triumph', beat: site ? `Earned the thanks of ${site.name} for protecting it` : undefined,
      });
      return true;
    }
    return false;
  }

  grantCoins(p: ServerEntity, coins: number) {
    if (!p.inventory) return;
    p.inventory.coins += coins;
    this.ctx.markPlayerDirty(p.id, 'inventory');
  }
}

// ------------------------------------------------------------------ helpers

function g_underground(host: GmHost, p: ServerEntity): boolean {
  return host.ctx.gen.isUnderworld(p.pos[0], p.pos[1], p.pos[2]) || p.pos[1] < host.ctx.gen.heightAt(p.pos[0], p.pos[2]) - 10;
}

function plural(s: string): string {
  if (/(wol|el|hal|lea|loa|thie)f$/.test(s)) return s.slice(0, -1) + 'ves';
  if (/s$|sh$|ch$|x$/.test(s)) return s + 'es';
  if (/[^aeiou]y$/.test(s)) return s.slice(0, -1) + 'ies';
  return s + 's';
}

/** A memorable name for a boss creature ("Ashmaw the Unfed"). */
export function bossName(r: Rng, species: string): string {
  return monsterName(r, species ? plural(species) : '');
}

function hueRgb(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return 0.6 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
