/**
 * NPC system: settlement populations with needs, schedules, memories,
 * relationships and GOAP-planned long-term goals; wanderers & bandit camps;
 * reactions to world events; gossip; server-side locomotion and animation.
 *
 * Simulation levels of detail:
 *  - spawned & near a player (LOD 0): full per-tick locomotion, barks, look-at;
 *  - spawned & further away (LOD 1/2): reduced-rate locomotion / teleporting;
 *  - not spawned (site inactive, NPC away travelling): abstract simulation of
 *    needs, goals, travel and gossip in coarse time steps, caught up lazily
 *    when a site becomes active again.
 *
 * Populations are regenerated deterministically from the seed; only the mind
 * state (`NpcState`: deaths, memories, dispositions, goal progress...) is
 * persisted.
 */
import type { NpcService, ServerContext, ServerSystem, ServerBusEvents } from '../../server/context';
import { makeEntity, type ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import { EntFlag, type EntityId, type Vec3, type AnimState } from '../../shared/types';
import { Rng, deriveSeed, hashString } from '../../core/rng';
import { clamp } from '../../core/math';
import type { SiteInfo, PoiInfo } from '../../world/sites';
import { BIOMES } from '../../world/biomes';
import type { BuildingInfo, SettlementLayout, SmartSpot } from '../../settlements/types';
import type { RaceId } from '../../humanoid/types';
import { RACE_IDS } from '../../humanoid/types';
import { randomAppearance } from '../../humanoid/appearance';
import { getPlayerData } from '../../server/systems/playerData';
import type { Deity, NpcProfile, NpcIntrospection, RelationKind } from '../types';
import { JOBS, ACTIVITY_LABEL, activityAt, type ActivityKind, type GoalKind } from '../jobs';
import { generatePopulation, outskirtsSpot, RACE_ATTITUDE, type NpcRecord, type PopulationContext } from '../population';
import { synthesizeLayout, buildNavGraph, routeVia, nearestNode, type NavGraph } from '../layout';
import {
  newState, addMemory, addDisp, decayNeeds, satisfy, moodOf, juiciest, topReasons, memoryId, worldHours,
  type NpcState, type Memory, type Goal, type Mood, type Task,
} from '../mind';
import { proposeGoal, planGoal, nextStep, goalSatisfied, runEffect, questFor, questCompleted, poiName, canQuest, type GoalHost, type GoalCtx, type NpcRef } from '../goals';
import { pantheon, RACE_ADJ, JOB_NOUN, RELATION_WORD } from '../culture';
import { getLore, siteLore } from '../../gm/lore';
import { describeWay, compass } from '../describe';
import { wandererRecord, normalizeKind, campSize, type WandererKind, type WandererSpec } from '../wanderers';
import { newBody, stepBody, settle, placeAt, buildingAt, yawTo, turnToward, type Body, type BodyEnv } from './body';
import { say, type VoiceSpeaker } from '../../dialog/voice';
import type { NpcDialogBridge, NpcDialogInfo, NpcPerson, QuestOffer } from '../bridge';

// ------------------------------------------------------------------ tuning

/** Generate + spawn a site when a player is within radius + this. */
const ACTIVATE_MARGIN = 400;
const DEACTIVATE_MARGIN = 560;
const CAMP_ACTIVATE = 380;
const CAMP_DEACTIVATE = 520;
const WANDERER_FORGET = 650;
const CORPSE_TIME = 120;
const WALK = 1.45;
const RUN = 3.6;

/** Goal kinds pursued during working hours vs. free time. */
const WORK_GOALS = new Set<GoalKind>(['restock', 'tradeRun', 'hunt', 'investigate', 'clearCamp', 'protectFields', 'rebuild', 'gatherHerbs', 'feast', 'heal']);
const WORKLIKE = new Set<ActivityKind>(['work', 'market', 'study', 'patrol', 'guard', 'beg', 'prowl']);
const FREETIME = new Set<ActivityKind>(['socialize', 'tavern', 'wander', 'home', 'play']);
const CHILD_KEEP = new Set(['bark.flee', 'bark.danger', 'bark.hurt', 'bark.mourn', 'bark.child']);
const OUTDOOR = new Set<ActivityKind>(['socialize', 'wander', 'play', 'market', 'beg', 'work', 'patrol']);

// ------------------------------------------------------------------ runtime types

interface SiteRt {
  site: SiteInfo;
  layout: SettlementLayout;
  synthetic: boolean;
  nav: NavGraph;
  recs: NpcRecord[];
  active: boolean;
  /** Server time when the site may deactivate (grace after ensureSettlement). */
  holdUntil: number;
  lastSim: number;
  flags: Record<string, number>;
  ground: Map<string, number>;
  env: BodyEnv;
  barkAt: number;
  patrol: Vec3[];
}

interface WanderRt {
  rec: NpcRecord;
  spec: WandererSpec;
  phase: 'travel' | 'visit' | 'roam' | 'approach';
  dest: Vec3;
  destSite: string | null;
  /** World hour when the current phase ends (visit/roam). */
  until: number;
  /** Record id of the caravan leader for escorts. */
  leader?: string;
  anchor: Vec3;
  newsDelivered: boolean;
}

interface CampRt {
  poi: PoiInfo;
  size: number;
  dead: number[];
  cleared: boolean;
  active: boolean;
  recs: NpcRecord[];
}

interface Live {
  rec: NpcRecord;
  st: NpcState;
  e: ServerEntity;
  site: SiteRt | null;
  body: Body;
  act: ActivityKind;
  /** Key of the current destination (avoid re-pathing). */
  destKey: string;
  dest: Vec3 | null;
  destYaw: number;
  destBuilding: string | null;
  arrived: boolean;
  thinkAt: number;
  lod: number;
  lodAcc: number;
  nearestPlayer: ServerEntity | null;
  nearestDist: number;
  anims: string[];
  animIdx: number;
  nextAnimAt: number;
  pose: AnimState['move'];
  barkAt: number;
  threat: EntityId | null;
  threatSince: number;
  attackCd: number;
  grudge: Map<EntityId, number>;
  talkPlayer: EntityId | null;
  talkUntil: number;
  talkMood: Mood | null;
  diedAt: number;
  wander: WanderRt | null;
  camp: CampRt | null;
  patrolIdx: number;
  /** Player-proximity pause (someone is standing in the way / watching). */
  pauseUntil: number;
  seen: Set<EntityId>;
  rng: Rng;
  lastAct: ActivityKind;
}

interface SavedData {
  v: 1;
  sites: Record<string, { synthetic: boolean; flags: Record<string, number>; lastSim: number }>;
  states: Record<string, NpcState>;
  camps: Record<string, { dead: number[]; cleared: boolean }>;
  wanderers: { kind: WandererKind; seed: number; pos: Vec3; index: number; races: RaceId[]; origin: string | null; leader?: string; st: NpcState }[];
  quests: Record<string, { rec: string; goal: string; player: string }>;
  rumors: Memory[];
}

export class NpcSystem implements ServerSystem, NpcService, NpcIntrospection, NpcDialogBridge {
  readonly name = 'npcs';
  private ctx!: ServerContext;
  private gods: Deity[] = [];
  metersPerHour = 105;
  private sites = new Map<string, SiteRt>();
  private states = new Map<string, NpcState>();
  private live = new Map<string, Live>();
  private byEntity = new Map<EntityId, Live>();
  private wanderers = new Map<string, WanderRt>();
  private camps = new Map<string, CampRt>();
  private savedSites: SavedData['sites'] = {};
  private savedCamps: SavedData['camps'] = {};
  private quests = new Map<string, { rec: string; goal: string; player: string }>();
  private globalRumors: Memory[] = [];
  private crimeSeen = new Map<string, number>();
  private tickN = 0;
  private lastHours = -1;
  private abstractAcc = 0;
  private gossipAcc = 0;
  private pendingWanderers: SavedData['wanderers'] = [];
  private rngRuntime!: Rng;

  // ================================================================== lifecycle

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.gods = pantheon(ctx.seed);
    // Share god names with the game master's world lore so priests and narration agree.
    try {
      const lore = getLore(ctx.gen.profile);
      const gm = [lore.creator, ...lore.pantheon];
      this.gods = this.gods.map((g, i) => (gm[i] ? { ...g, name: gm[i].name, epithet: gm[i].title } : g));
    } catch (err) {
      ctx.log('npc: lore unavailable, using local pantheon', err);
    }
    this.metersPerHour = 1.4 * (ctx.gen.profile.dayLengthSec || 1800) / 24;
    this.rngRuntime = ctx.rng('npc-runtime');
    const bus = ctx.bus;
    bus.on('damage', (p) => this.onDamage(p));
    bus.on('death', (p) => this.onDeath(p));
    bus.on('crime', (p) => this.onCrime(p));
    bus.on('objectDestroyed', (p) => this.onObjectDestroyed(p));
    bus.on('weatherChanged', (p) => this.onWeather(p.weather.kind, p.weather.intensity));
    bus.on('timeOfDay', (p) => this.onHour(p.hour));
    bus.on('questEvent', (p) => this.onQuestEvent(p));
    bus.on('enterSite', (p) => this.onEnterSite(p.player, p.site));
    bus.on('playerDied', (p) => this.onPlayerDied(p.player, p.killer));
    bus.on('terrainEdited', (p) => {
      for (const s of this.sites.values()) if (Math.hypot(p.edit.x - s.site.x, p.edit.z - s.site.z) < s.site.radius + 60) s.ground.clear();
    });
  }

  /** World time in hours (day * 24 + hour). */
  now(): number {
    return worldHours(this.ctx.time.day, this.ctx.time.hour);
  }

  rng(...tag: (string | number)[]): Rng {
    return this.ctx.rng('npc', ...tag);
  }

  // ================================================================== sites

  private siteInfo(siteId: string): SiteInfo | null {
    const m = /^S(-?\d+)_(-?\d+)$/.exec(siteId);
    if (!m) return null;
    const s = this.ctx.gen.sites.siteInCell(+m[1], +m[2]);
    if (s) this.ctx.gen.sites.roadsNear(s.x, s.z, 1); // populates links lazily
    return s;
  }

  site(siteId: string): SiteInfo | null {
    return this.sites.get(siteId)?.site ?? this.siteInfo(siteId);
  }

  layout(siteId: string): SettlementLayout | null {
    return this.sites.get(siteId)?.layout ?? null;
  }

  linked(siteId: string): SiteInfo[] {
    const s = this.site(siteId);
    if (!s) return [];
    this.ctx.gen.sites.roadsNear(s.x, s.z, 1);
    const out: SiteInfo[] = [];
    for (const id of s.links) {
      const o = this.siteInfo(id);
      if (o) out.push(o);
    }
    return out;
  }

  pois(x: number, z: number, r: number): PoiInfo[] {
    return this.ctx.gen.sites.poisNear(x, z, r);
  }

  /** Load (generate) a site's population. Deterministic; cheap to call repeatedly. */
  private loadSite(siteId: string): SiteRt | null {
    const ex = this.sites.get(siteId);
    if (ex) return ex;
    const site = this.siteInfo(siteId);
    if (!site) return null;
    const ctx = this.ctx;
    const saved = this.savedSites[siteId];
    let layout: SettlementLayout | null = null;
    if (!saved?.synthetic) {
      try {
        layout = ctx.services.settlements.layout(siteId);
      } catch (err) {
        ctx.log('npc: settlement layout failed', siteId, err);
      }
    }
    const height = (x: number, z: number) => ctx.gen.heightAt(x, z);
    const synthetic = !layout || !layout.buildings?.length;
    if (synthetic) layout = synthesizeLayout(site, height);
    const lay = layout!;
    const linkedNames = this.linked(siteId).map((s) => s.name);
    const pc: PopulationContext = {
      worldSeed: ctx.seed, site, layout: lay, gods: this.gods, height, biomeName: (BIOMES[site.biome]?.name ?? 'wilds').toLowerCase(), linkedNames,
      worldRaces: (ctx.gen.profile.races ?? []).map((r) => r.id as RaceId).filter((r) => RACE_IDS.includes(r)),
    };
    const recs = generatePopulation(pc);
    const ground = new Map<string, number>();
    const rt: SiteRt = {
      site, layout: lay, synthetic, nav: buildNavGraph(lay), recs, active: false, holdUntil: 0, lastSim: saved?.lastSim ?? this.now(), flags: saved?.flags ?? {},
      ground, barkAt: 0, patrol: [],
      env: {
        ctx, buildings: lay.buildings,
        ground: (x, y, z) => {
          const k = Math.round(x * 2) + ',' + Math.round(z * 2);
          let g = ground.get(k);
          if (g === undefined) {
            g = ctx.groundAt(x, Math.max(y, site.plateau) + 3, z, 14);
            if (!Number.isFinite(g)) g = ctx.gen.heightAt(x, z);
            if (ground.size > 30000) ground.clear();
            ground.set(k, g);
          }
          return g;
        },
      },
    };
    rt.patrol = this.patrolRoute(rt);
    this.sites.set(siteId, rt);
    for (const r of recs) {
      if (this.states.has(r.id)) continue;
      const st = newState(r, new Rng(deriveSeed(r.seed, 'state')));
      // Stagger agendas so a freshly met town is not all errands at once.
      st.nextGoalAt = this.now() + new Rng(deriveSeed(r.seed, 'first-goal')).range(0, 30);
      this.states.set(r.id, st);
    }
    return rt;
  }

  /** Patrol loop: outer street nodes and guard posts ordered by angle around the centre. */
  private patrolRoute(rt: SiteRt): Vec3[] {
    const c = rt.layout.center;
    const pts: Vec3[] = [];
    for (let i = 0; i < rt.nav.count; i++) {
      const x = rt.nav.pos[i * 3], z = rt.nav.pos[i * 3 + 2];
      const d = Math.hypot(x - c[0], z - c[2]);
      if (d > rt.layout.radius * 0.45) pts.push([x, rt.nav.pos[i * 3 + 1], z]);
    }
    for (const s of rt.layout.spots) if (s.kind === 'guard') pts.push(s.pos);
    pts.sort((a, b) => Math.atan2(a[2] - c[2], a[0] - c[0]) - Math.atan2(b[2] - c[2], b[0] - c[0]));
    // Thin to ~12 waypoints.
    const step = Math.max(1, Math.floor(pts.length / 12));
    return pts.filter((_, i) => i % step === 0);
  }

  private activateSite(rt: SiteRt) {
    if (rt.active) return;
    this.catchUp(rt);
    rt.active = true;
    for (const rec of rt.recs) this.ensureLive(rec, rt);
  }

  private deactivateSite(rt: SiteRt) {
    if (!rt.active) return;
    rt.active = false;
    for (const rec of rt.recs) {
      const l = this.live.get(rec.id);
      if (l) this.despawnLive(l);
    }
    rt.lastSim = this.now();
  }

  /** Spawn a resident if they should be physically present. */
  private ensureLive(rec: NpcRecord, rt: SiteRt) {
    if (this.live.has(rec.id)) return;
    const st = this.states.get(rec.id);
    if (!st || st.away) return;
    if (!st.alive) return;
    const act = this.scheduleActivity(rec, st, rt);
    const pos = this.restingPos(rec, rt, act);
    this.spawnLive(rec, st, rt, pos, null, null);
  }

  private restingPos(rec: NpcRecord, rt: SiteRt, act: ActivityKind): Vec3 {
    switch (act) {
      case 'sleep':
      case 'home':
      case 'eat':
        return [rec.bed[0], rec.bed[1], rec.bed[2]];
      case 'work':
      case 'study':
      case 'market':
        return [rec.work[0], rec.work[1], rec.work[2]];
      default: {
        const r = this.rngRuntime;
        const p = rt.layout.plaza;
        return [p[0] + r.range(-8, 8), p[1], p[2] + r.range(-8, 8)];
      }
    }
  }

  // ================================================================== spawning

  private spawnLive(rec: NpcRecord, st: NpcState, rt: SiteRt | null, pos: Vec3, wander: WanderRt | null, camp: CampRt | null): Live {
    const ctx = this.ctx;
    const e = makeEntity(ctx.newEntityId(), 'npc', pos, 'npcs', ctx.time.now);
    e.name = rec.name;
    e.title = rec.title;
    const app = randomAppearance(rec.race, rec.seed, { gender: rec.gender, age: rec.appearanceAge, race2: rec.race2 });
    if (rec.race2) app.raceMix = rec.raceMix;
    e.humanoid = app;
    e.height = 1.75 * (app.scale || 1);
    e.radius = 0.32 * (app.scale || 1);
    e.faction = rec.job === 'bandit' ? 'hostile' : rec.siteId ? `site:${rec.siteId}` : 'travelers';
    e.inventory = { items: [], capacity: 80, coins: st.coins };
    e.equipment = {};
    e.yaw = rec.siteId && rt ? yawTo(pos[0], pos[2], rt.layout.plaza[0], rt.layout.plaza[2]) : 0;
    for (const t of JOBS[rec.job].tags) e.tags.add(t);
    e.tags.add('npc');
    e.tags.add(rec.siteId ? 'resident' : 'wanderer');
    if (rec.captain) e.tags.add('captain');
    if (rec.leader) e.tags.add('leader');
    e.flags = rec.job === 'bandit' ? EntFlag.Hostile : EntFlag.Talkable;
    if (JOBS[rec.job].merchant && rec.job !== 'bandit') e.flags |= EntFlag.Merchant;
    try {
      ctx.services.skills.initSkills(e);
      ctx.services.skills.recomputeStats(e);
    } catch (err) {
      ctx.log('npc: skills init failed', err);
    }
    e.hp = e.maxHp * (1 - st.injury * 0.5);
    try {
      ctx.services.items.outfitFor(e, rec.job, rec.wealth, rec.seed);
    } catch (err) {
      ctx.log('npc: outfit failed', err);
    }
    ctx.spawn(e);
    const l: Live = {
      rec, st, e, site: rt, body: newBody(), act: 'home', destKey: '', dest: null, destYaw: 0, destBuilding: null, arrived: true,
      thinkAt: ctx.time.now + this.rngRuntime.range(0, 1), lod: 2, lodAcc: 0, nearestPlayer: null, nearestDist: Infinity, anims: [], animIdx: 0, nextAnimAt: 0,
      pose: 'idle', barkAt: ctx.time.now + this.rngRuntime.range(5, 30), threat: null, threatSince: 0, attackCd: 0, grudge: new Map(), talkPlayer: null,
      talkUntil: 0, talkMood: null, diedAt: 0, wander, camp, patrolIdx: hashString(rec.id) % 7, pauseUntil: 0, seen: new Set(),
      rng: new Rng(deriveSeed(rec.seed, 'live', Math.floor(ctx.time.now))), lastAct: 'home',
    };
    if (rt) {
      const b = buildingAt(rt.layout.buildings, pos[0], pos[2]);
      if (b) l.body.exempt = [b.id];
      placeAt(e, l.body, rt.env, pos);
    } else {
      const g = ctx.groundAt(pos[0], pos[1] + 4, pos[2], 30);
      if (Number.isFinite(g)) e.pos[1] = g;
    }
    this.live.set(rec.id, l);
    this.byEntity.set(e.id, l);
    return l;
  }

  private despawnLive(l: Live) {
    l.st.pos = [l.e.pos[0], l.e.pos[1], l.e.pos[2]];
    l.st.coins = l.e.inventory?.coins ?? l.st.coins;
    this.live.delete(l.rec.id);
    this.byEntity.delete(l.e.id);
    if (this.ctx.entities.get(l.e.id)) this.ctx.despawn(l.e.id);
  }

  onEntityRemoved(e: ServerEntity) {
    const l = this.byEntity.get(e.id);
    if (!l) return;
    // Removed by someone else (e.g. corpse cleanup by gameplay): forget the runtime, keep the mind.
    this.live.delete(l.rec.id);
    this.byEntity.delete(e.id);
    if (l.wander) this.wanderers.delete(l.rec.id);
  }

  // ================================================================== NpcService

  profile(entityId: EntityId): NpcProfile | undefined {
    const l = this.byEntity.get(entityId);
    if (!l) return undefined;
    return this.profileOf(l.rec, l.st, l);
  }

  private profileOf(rec: NpcRecord, st: NpcState, l?: Live): NpcProfile {
    const g = this.activeGoal(st);
    const rels = Object.entries(rec.relations).slice(0, 12).map(([id, r]) => {
      const o = this.findRec(id);
      return { id, name: o?.name ?? id, kind: (st.relKind[id] as RelationKind) ?? r.kind, affinity: clamp(r.affinity + (st.rel[id] ?? 0), -100, 100) };
    });
    const site = rec.siteId ? this.site(rec.siteId) : null;
    return {
      id: rec.id, name: rec.name, race: rec.race, job: rec.job, home: rec.siteId, traits: rec.traits, bio: rec.bio, factions: rec.factions,
      race2: rec.race2, age: rec.age, ageStage: rec.ageStage, gender: rec.gender, title: rec.title, family: rec.family, wealth: rec.wealth,
      homeName: site?.name, relations: rels, goal: g?.desc, activity: st.away ? st.away.label : l ? ACTIVITY_LABEL[l.act] : undefined,
      deity: rec.deity ?? undefined, alive: st.alive,
    };
  }

  ensureSettlement(siteId: string): void {
    const rt = this.loadSite(siteId);
    if (!rt) return;
    rt.holdUntil = this.ctx.time.now + 60;
    this.activateSite(rt);
  }

  private keyOf(e: ServerEntity | undefined): string | null {
    if (!e) return null;
    if (e.kind === 'player') return `P:${e.name}`;
    const l = this.byEntity.get(e.id);
    if (l) return l.rec.id;
    return `E:${e.id}`;
  }

  adjustDisposition(npc: EntityId, toward: EntityId, delta: number, reason: string): void {
    const l = this.byEntity.get(npc);
    const other = this.ctx.entities.get(toward);
    const key = this.keyOf(other);
    if (!l || !key) return;
    addDisp(l.st, key, delta, reason, this.now());
    if (other?.kind === 'player' && Math.abs(delta) >= 10) {
      addMemory(l.st, { text: `${other.name} ${reason}`, kind: 'player', imp: clamp(Math.abs(delta) / 50, 0.3, 0.9), t: this.now(), about: key }, this.now());
    }
  }

  disposition(npc: EntityId, toward: EntityId): number {
    const l = this.byEntity.get(npc);
    const other = this.ctx.entities.get(toward);
    if (!l || !other) return 0;
    return this.dispValue(l.rec, l.st, other);
  }

  private dispValue(rec: NpcRecord, st: NpcState, other: ServerEntity): number {
    const key = this.keyOf(other)!;
    let base = rec.traits.agreeableness * 15 + rec.traits.extraversion * 5;
    const race = other.humanoid?.race;
    if (race && race !== rec.race) base += (RACE_ATTITUDE[rec.race]?.[race] ?? 0) * 35;
    if (race && race === rec.race) base += 6;
    if (other.kind === 'player') {
      const pd = getPlayerData(this.ctx, other.id);
      if (pd && rec.siteId) base += (pd.reputation[`site.${rec.siteId}`] ?? 0) * 0.6;
      for (const f of rec.factions) if (pd?.reputation[f]) base += pd.reputation[f] * 0.3;
    } else {
      const ol = this.byEntity.get(other.id);
      if (ol) {
        const r = rec.relations[ol.rec.id];
        if (r) base += r.affinity + (st.rel[ol.rec.id] ?? 0);
      }
    }
    if (rec.job === 'bandit' && other.faction !== 'hostile') base -= 80;
    return clamp(Math.round(base + (st.disp[key]?.v ?? 0)), -100, 100);
  }

  spawnWanderer(kind: string, pos: Vec3, seed: number): ServerEntity | null {
    const k = normalizeKind(kind);
    const ctx = this.ctx;
    const near = ctx.gen.sites.sitesNear(pos[0], pos[2], 1200).sort((a, b) => Math.hypot(a.x - pos[0], a.z - pos[2]) - Math.hypot(b.x - pos[0], b.z - pos[2]));
    const races: RaceId[] = [];
    for (const s of near.slice(0, 3)) {
      races.push(s.race as RaceId, s.race as RaceId);
      if (s.race2) races.push(s.race2 as RaceId);
    }
    for (const r of ctx.gen.profile.races ?? []) if (RACE_IDS.includes(r.id as RaceId)) races.push(r.id as RaceId);
    const origin = near[0]?.name ?? null;
    const spec: WandererSpec = { kind: k, seed: seed >>> 0, pos: [pos[0], pos[1], pos[2]], races, gods: this.gods, origin, index: 0 };
    const lead = this.spawnWandererRec(spec, near, undefined);
    if (!lead) return null;
    const raw = kind.toLowerCase();
    if (raw !== k) lead.e.tags.add(raw);
    if (k === 'caravan') {
      const n = 1 + (seed % 2);
      for (let i = 1; i <= n; i++) {
        const esc = this.spawnWandererRec({ ...spec, kind: 'guard', index: i, pos: [pos[0] + i * 1.5, pos[1], pos[2] + 1] }, near, lead.rec.id);
        if (esc && lead.wander) esc.wander!.dest = lead.wander.dest;
      }
    }
    return lead.e;
  }

  private spawnWandererRec(spec: WandererSpec, near: SiteInfo[], leader: string | undefined, st0?: NpcState): Live | null {
    const rec = wandererRecord(this.ctx.seed, spec);
    if (this.live.has(rec.id)) return this.live.get(rec.id)!;
    const st = st0 ?? this.states.get(rec.id) ?? newState(rec, new Rng(deriveSeed(rec.seed, 'state')));
    if (!st.alive) return null;
    this.states.set(rec.id, st);
    const rng = new Rng(deriveSeed(rec.seed, 'itinerary'));
    const pos = spec.pos;
    let dest: Vec3 = [pos[0], pos[1], pos[2]];
    let destSite: string | null = null;
    let phase: WanderRt['phase'] = 'travel';
    if (spec.kind === 'bandit' || spec.kind === 'hunter' || spec.kind === 'bounty_hunter') phase = 'roam';
    else if (spec.kind === 'angry_owner' || spec.kind === 'messenger') phase = 'approach';
    else if (spec.kind === 'pilgrim') {
      const shrines = this.pois(pos[0], pos[2], 1400).filter((p) => p.kind === 'shrine' || p.kind === 'wayshrine' || p.kind === 'monolith');
      if (shrines.length) {
        const p = rng.pick(shrines);
        dest = [p.x, p.y, p.z];
      }
    }
    if (phase === 'travel' && dest[0] === pos[0]) {
      const cands = near.filter((s) => Math.hypot(s.x - pos[0], s.z - pos[2]) > s.radius * 1.2);
      const target = cands.length ? cands[0] : near[0];
      if (target) {
        dest = [target.x, target.plateau, target.z];
        destSite = target.id;
      }
    }
    const until = this.now() + (phase === 'approach' ? rng.range(1.5, 3) : rng.range(10, 30));
    const w: WanderRt = { rec, spec, phase, dest, destSite, until, leader, anchor: [pos[0], pos[1], pos[2]], newsDelivered: false };
    if (phase === 'travel' && spec.origin) addMemory(st, { text: `the road from ${spec.origin} was long and dusty`, kind: 'travel', imp: 0.2, t: this.now() }, this.now());
    this.seedWandererNews(st, pos);
    this.wanderers.set(rec.id, w);
    const l = this.spawnLive(rec, st, null, pos, w, null);
    // Tags the game master (and others) query by: the requested kind plus its archetype.
    l.e.tags.add(spec.kind);
    if (spec.kind === 'caravan') l.e.tags.add('merchant');
    if (spec.kind === 'bounty_hunter') {
      l.e.faction = 'hostile';
      l.e.flags = (l.e.flags | EntFlag.Hostile) & ~EntFlag.Talkable;
    }
    return l;
  }

  /** Travellers know things from where they came from: a site's juiciest memories or POI rumors. */
  private seedWandererNews(st: NpcState, pos: Vec3) {
    const rng = this.rngRuntime;
    for (const rt of this.sites.values()) {
      if (Math.hypot(rt.site.x - pos[0], rt.site.z - pos[2]) > 2500) continue;
      const r = rt.recs.length ? this.states.get(rng.pick(rt.recs).id) : undefined;
      const m = r ? juiciest(r, this.now()) : null;
      if (m) addMemory(st, { ...m, heard: true, from: rt.site.name, imp: m.imp * 0.8 }, this.now());
    }
    const pois = this.pois(pos[0], pos[2], 1500);
    if (pois.length) {
      const p = rng.pick(pois);
      const w = describeWay(pos, [p.x, p.y, p.z]);
      addMemory(st, { text: `there is a ${poiName(p.kind)} ${w.dist} ${w.dir} of the road`, kind: 'rumor', imp: 0.45, t: this.now(), pos: [p.x, p.y, p.z] }, this.now());
    }
  }

  remember(npc: EntityId, fact: string, importance: number): void {
    const l = this.byEntity.get(npc);
    if (!l) return;
    addMemory(l.st, { text: fact, kind: 'event', imp: clamp(importance, 0, 1), t: this.now() }, this.now());
  }

  // ================================================================== NpcIntrospection

  priceModifier(npc: number, player: number): number {
    const l = this.byEntity.get(npc);
    const p = this.ctx.entities.get(player);
    if (!l || !p) return 1;
    const d = this.dispValue(l.rec, l.st, p);
    const greed = 1 + l.rec.traits.greed * 0.08;
    return clamp((1 - d * 0.0018) * greed * (l.st.price[`P:${p.name}`] ?? 1), 0.7, 1.4);
  }

  addRumor(siteId: string | null, text: string, importance: number, pos?: Vec3): void {
    const m: Omit<Memory, 'id' | 't'> = { text, kind: 'rumor', imp: clamp(importance, 0, 1), pos, heard: true, from: 'travellers' };
    if (siteId) {
      this.loadSite(siteId);
      this.spread(siteId, m, 0.5);
    } else {
      this.globalRumors.push({ ...m, id: memoryId('rumor', text), t: this.now() });
      if (this.globalRumors.length > 12) this.globalRumors.shift();
      for (const rt of this.sites.values()) this.spread(rt.site.id, m, 0.25);
    }
  }

  isNpc(entityId: number): boolean {
    return this.byEntity.has(entityId);
  }

  // ================================================================== GoalHost

  campStrength(poiId: string): number {
    const c = this.camps.get(poiId);
    if (c) return c.cleared ? 0 : c.size - c.dead.length;
    const sv = this.savedCamps[poiId];
    if (sv?.cleared) return 0;
    const poi = this.poiById(poiId);
    if (!poi || poi.kind !== 'camp') return 0;
    return campSize(poi.seed) - (sv?.dead.length ?? 0);
  }

  private poiById(id: string): PoiInfo | null {
    const m = /^P(-?\d+)_(-?\d+)$/.exec(id);
    return m ? this.ctx.gen.sites.poiInCell(+m[1], +m[2]) : null;
  }

  clearCamp(poiId: string, by: string): void {
    let c = this.camps.get(poiId);
    if (!c) {
      const poi = this.poiById(poiId);
      if (!poi) return;
      c = this.loadCamp(poi);
    }
    if (c.cleared) return;
    c.cleared = true;
    for (let i = 0; i < c.size; i++) if (!c.dead.includes(i)) c.dead.push(i);
    for (const r of c.recs) {
      const l = this.live.get(r.id);
      if (l) this.despawnLive(l);
      const st = this.states.get(r.id);
      if (st) st.alive = false;
    }
    // News reaches nearby settlements.
    const by2 = by.startsWith('P:') ? by.slice(2) : this.findRec(by)?.given ?? 'the watch';
    for (const rt of this.sites.values()) {
      const d = Math.hypot(rt.site.x - c.poi.x, rt.site.z - c.poi.z);
      if (d > 1800) continue;
      const way = compass([rt.site.x, 0, rt.site.z], [c.poi.x, 0, c.poi.z]);
      this.spread(rt.site.id, { text: `${by2} cleared out the bandit camp to the ${way}`, kind: 'event', imp: 0.7, about: by.startsWith('P:') ? by : undefined }, 0.8);
      if (by.startsWith('P:')) for (const r of rt.recs) {
        const st = this.states.get(r.id);
        if (st) addDisp(st, by, 12, 'cleared the bandit camp', this.now());
      }
    }
  }

  ref(recId: string): NpcRef | undefined {
    const rec = this.findRec(recId);
    const st = this.states.get(recId);
    return rec && st ? { rec, st } : undefined;
  }

  private findRec(recId: string): NpcRecord | undefined {
    const l = this.live.get(recId);
    if (l) return l.rec;
    const hash = recId.lastIndexOf('#');
    if (recId.startsWith('S') && hash > 0) {
      const rt = this.sites.get(recId.slice(0, hash));
      return rt?.recs[+recId.slice(hash + 1)];
    }
    if (recId.startsWith('C:')) {
      const poiId = recId.slice(2, hash);
      return this.camps.get(poiId)?.recs[+recId.slice(hash + 1)];
    }
    return this.wanderers.get(recId)?.rec;
  }

  residents(siteId: string): NpcRef[] {
    const rt = this.sites.get(siteId);
    if (!rt) return [];
    const out: NpcRef[] = [];
    for (const rec of rt.recs) {
      const st = this.states.get(rec.id);
      if (st) out.push({ rec, st });
    }
    return out;
  }

  remember2(recId: string, m: Omit<Memory, 'id' | 't'>) {
    const st = this.states.get(recId);
    if (st) addMemory(st, { ...m, t: this.now() }, this.now());
  }

  // GoalHost.remember has a different signature than NpcService.remember: route through an arrow below.
  private goalHost(): GoalHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      now: () => self.now(), metersPerHour: self.metersPerHour, rng: (...t) => self.rng(...t), layout: (id) => self.layout(id), site: (id) => self.site(id),
      linked: (id) => self.linked(id), pois: (x, z, r) => self.pois(x, z, r), campStrength: (id) => self.campStrength(id), clearCamp: (id, by) => self.clearCamp(id, by),
      ref: (id) => self.ref(id), residents: (id) => self.residents(id), remember: (id, m) => self.remember2(id, m), spread: (s, m, f) => self.spread(s, m, f),
      adjustRel: (a, b, d) => self.adjustRel(a, b, d), setRelKind: (a, b, k) => self.setRelKind(a, b, k), kill: (id, c, by) => self.killRec(id, c, by),
      injure: (id, a) => self.injure(id, a), speciesFor: (s, r) => self.speciesFor(s, r), speciesName: (n) => self.speciesName(n),
      setSiteFlag: (s, f, h) => self.setSiteFlag(s, f, h), siteFlag: (s, f) => self.siteFlag(s, f), bark: (id, k, v) => self.barkRec(id, k, v),
      describeWay: (a, b) => describeWay(a, b), outskirts: (rec, kind) => self.outskirts(rec, kind), entityOf: (id) => self.live.get(id)?.e.id,
    };
  }

  private host: GoalHost | null = null;
  private gh(): GoalHost {
    return (this.host ??= this.goalHost());
  }

  spread(siteId: string, m: Omit<Memory, 'id' | 't'>, fraction: number) {
    const rt = this.sites.get(siteId);
    if (!rt) return;
    const now = this.now();
    const id = memoryId(m.kind, m.text);
    const rng = new Rng(deriveSeed(hashString(id), 'spread'));
    for (const rec of rt.recs) {
      if (rec.ageStage === 'child' && m.kind !== 'event') continue;
      const st = this.states.get(rec.id);
      if (!st || !st.alive) continue;
      if (rec.id === m.from || rng.chance(fraction)) addMemory(st, { ...m, id, t: now, heard: rec.id !== m.from }, now);
    }
  }

  adjustRel(a: string, b: string, delta: number) {
    const st = this.states.get(a);
    if (st) st.rel[b] = clamp((st.rel[b] ?? 0) + delta, -150, 150);
  }

  setRelKind(a: string, b: string, kind: string) {
    const st = this.states.get(a);
    if (st) st.relKind[b] = kind;
  }

  injure(recId: string, amount: number) {
    const st = this.states.get(recId);
    if (!st) return;
    st.injury = clamp(st.injury + amount, 0, 1);
    const l = this.live.get(recId);
    if (l) {
      l.e.hp = Math.max(1, l.e.hp - l.e.maxHp * amount * 0.5);
      l.e.dirty = true;
    }
  }

  /** Abstract death (goal outcomes off-screen). */
  killRec(recId: string, cause: string, by?: string) {
    const st = this.states.get(recId);
    const rec = this.findRec(recId);
    if (!st || !rec || !st.alive) return;
    const l = this.live.get(recId);
    if (l && l.e.alive) {
      this.ctx.services.combat.kill(l.e);
      return;
    }
    this.recordDeath(rec, st, cause, by);
  }

  private recordDeath(rec: NpcRecord, st: NpcState, cause: string, by?: string) {
    if (!st.alive) return;
    st.alive = false;
    st.death = { t: this.now(), cause, by };
    st.goals = [];
    const now = this.now();
    const text = `${rec.given} the ${JOB_NOUN[rec.job]} ${cause}`;
    const about = by && (by.startsWith('P:') || by.startsWith('S:')) ? by : rec.id;
    if (rec.siteId) {
      for (const r of this.residents(rec.siteId)) {
        if (!r.st.alive || r.rec.id === rec.id) continue;
        const rel = rec.relations[r.rec.id];
        const kind = (r.st.relKind[rec.id] as RelationKind) ?? r.rec.relations[rec.id]?.kind;
        const close = kind === 'spouse' || kind === 'parent' || kind === 'child' || kind === 'sibling';
        const friend = kind === 'friend' || kind === 'crush' || kind === 'mentor' || kind === 'apprentice';
        if (close || friend || rel) {
          addMemory(r.st, { text, kind: 'death', imp: close ? 0.95 : friend ? 0.8 : 0.6, t: now, about }, now);
          if (close) {
            r.st.needs.fun = 0.05;
            r.st.needs.social = Math.min(r.st.needs.social, 0.3);
          }
          if (by?.startsWith('P:')) addDisp(r.st, by, close ? -90 : friend ? -50 : -25, `killed ${rec.given}`, now);
        } else if (this.rngRuntime.chance(0.6)) {
          addMemory(r.st, { text, kind: 'death', imp: 0.55, t: now, about, heard: true }, now);
          if (by?.startsWith('P:')) addDisp(r.st, by, -20, `killed ${rec.given}`, now);
        }
      }
    }
  }

  speciesFor(siteId: string, role: string): number[] {
    const s = this.site(siteId);
    let out: number[] = [];
    try {
      if (s) out = this.ctx.services.creatures.speciesFor(s.biome, role, false) ?? [];
    } catch {
      out = [];
    }
    // Folk names stand in when the creature module offers no species (negative ids).
    if (!out.length) out = role === 'predator' ? [-1, -2, -3] : [-4, -5, -6];
    return out;
  }

  speciesName(n: number): string {
    if (n >= 0) {
      try {
        const nm = this.ctx.services.creatures.speciesName(n);
        if (nm) return nm.toLowerCase();
      } catch {
        /* fall through to folk names */
      }
    }
    const folk = ['beast', 'grey wolf', 'night prowler', 'tusked brute', 'wild boar', 'red elk', 'long-eared hare'];
    return folk[Math.abs(n) % folk.length] || 'beast';
  }

  setSiteFlag(siteId: string, flag: string, hours: number) {
    const rt = this.sites.get(siteId);
    if (!rt) return;
    if (hours <= 0) delete rt.flags[flag];
    else rt.flags[flag] = this.now() + hours;
  }

  siteFlag(siteId: string, flag: string): boolean {
    const rt = this.sites.get(siteId);
    return !!rt && (rt.flags[flag] ?? 0) > this.now();
  }

  outskirts(rec: NpcRecord, kind: 'fields' | 'woods' | 'mine' | 'shore' | 'pasture' | 'wilds'): Vec3 {
    const rt = rec.siteId ? this.sites.get(rec.siteId) : null;
    if (!rt) {
      const r = new Rng(deriveSeed(rec.seed, 'outskirts', kind));
      const a = r.range(0, Math.PI * 2);
      const p = rec.work;
      return [p[0] + Math.cos(a) * 40, p[1], p[2] + Math.sin(a) * 40];
    }
    const pc = { worldSeed: this.ctx.seed, site: rt.site, layout: rt.layout, gods: this.gods, height: (x: number, z: number) => this.ctx.gen.heightAt(x, z), biomeName: '', linkedNames: [], worldRaces: [] };
    return outskirtsSpot(pc, kind, new Rng(deriveSeed(rec.seed, 'outskirts', kind, Math.floor(this.now() / 24)))).pos;
  }

  // ================================================================== goals

  private activeGoal(st: NpcState): Goal | null {
    for (const g of st.goals) if (g.status === 'active' || g.status === 'waiting') return g;
    return null;
  }

  private goalCtx(rec: NpcRecord, st: NpcState, g: Goal): GoalCtx {
    return { n: { rec, st }, g, h: this.gh() };
  }

  /** Consider new goals, check deadlines. Called hourly-ish per NPC (live or abstract). */
  private manageGoals(rec: NpcRecord, st: NpcState) {
    if (!st.alive || rec.ageStage === 'child' || rec.job === 'bandit') return;
    const now = this.now();
    const g = this.activeGoal(st);
    if (g) {
      const limit = g.status === 'waiting' ? g.deadline + 72 : g.deadline;
      if (now > limit) this.finishGoal(rec, st, g, false, g.status === 'waiting' ? 'nobody came back' : 'ran out of time');
      return;
    }
    // Keep history short.
    if (st.goals.length > 6) st.goals.splice(0, st.goals.length - 6);
    if (now < st.nextGoalAt) return;
    const ng = proposeGoal({ rec, st }, this.gh());
    st.nextGoalAt = now + 4 + this.rng('goal-wait', rec.id, Math.floor(now)).range(2, 14);
    if (!ng) return;
    const c = this.goalCtx(rec, st, ng);
    if (!planGoal(c)) return;
    st.goals.push(ng);
  }

  private finishGoal(rec: NpcRecord, st: NpcState, g: Goal, success: boolean, why: string) {
    g.status = success ? 'done' : 'failed';
    const now = this.now();
    if (success) {
      st.goalsDone++;
      st.needs.fun = clamp(st.needs.fun + 0.25, 0, 1);
      addMemory(st, { text: `${rec.given} managed to ${g.desc}`, kind: 'personal', imp: 0.4, t: now, about: rec.id }, now);
    } else {
      st.goalsFailed++;
      addMemory(st, { text: `${rec.given} gave up trying to ${g.desc} (${why})`, kind: 'personal', imp: 0.45, t: now, about: rec.id }, now);
      // Players who took the request but never delivered are remembered.
      for (const [qid, pkey] of Object.entries(g.quests)) {
        if (g.status === 'failed') addDisp(st, pkey, -12, `never finished helping me ${g.desc}`, now);
        this.quests.delete(qid);
      }
    }
    st.nextGoalAt = now + this.rng('goal-rest', rec.id, Math.floor(now)).range(6, 20);
    const l = this.live.get(rec.id);
    if (l) this.updateFlags(l);
  }

  /** Is the NPC free to work on this goal given its current schedule slot? */
  private goalEligible(g: Goal, sched: ActivityKind): boolean {
    if (sched === 'sleep') return false;
    if (WORK_GOALS.has(g.kind)) return WORKLIKE.has(sched) || (sched === 'socialize' && g.kind === 'feast');
    return FREETIME.has(sched);
  }

  /**
   * Progress the active goal by `hours`. For live NPCs, movement tasks are
   * completed by locomotion (`arrivedTask`), timed tasks only count while the
   * NPC is actually doing them.
   */
  private progressGoal(rec: NpcRecord, st: NpcState, hours: number, l: Live | null) {
    const g = this.activeGoal(st);
    if (!g || g.status !== 'active' || !st.alive || st.away) return;
    const c = this.goalCtx(rec, st, g);
    let budget = hours;
    for (let guard = 0; guard < 12 && budget > 0; guard++) {
      const task = g.tasks[g.taskIdx];
      if (!task) {
        if (!this.advanceStep(c)) return;
        continue;
      }
      if (l && l.act !== 'goal' && task.k !== 'effect' && task.k !== 'askHelp') return;
      switch (task.k) {
        case 'effect': {
          const ok = runEffect(task.fx, c);
          if (!st.alive) return;
          if (!ok) {
            this.actionFailed(c);
            return;
          }
          g.taskIdx++;
          g.taskT = 0;
          continue;
        }
        case 'goto': {
          if (l) return; // locomotion completes it
          const d = Math.hypot(task.to[0] - (st.pos?.[0] ?? rec.work[0]), task.to[2] - (st.pos?.[2] ?? rec.work[2]));
          const need = d / this.metersPerHour;
          const use = Math.min(budget, need - g.taskT);
          g.taskT += use;
          budget -= use;
          if (g.taskT >= need - 1e-6) {
            st.pos = [task.to[0], task.to[1], task.to[2]];
            g.taskIdx++;
            g.taskT = 0;
          }
          continue;
        }
        case 'travel': {
          if (l && l.rec.siteId) return; // walks out physically; leaves via travel handling
          st.away = { until: this.now() + Math.max(0.5, task.hours - g.taskT), site: task.site ?? null, label: task.label };
          g.taskIdx++;
          g.taskT = 0;
          return;
        }
        case 'askHelp': {
          // A posted request runs in the background while the NPC goes about their day.
          if (Object.keys(g.quests).length) {
            g.status = 'waiting';
            return;
          }
          const use = Math.min(budget, task.hours - g.taskT);
          g.taskT += use;
          budget -= use;
          if (g.taskT >= task.hours - 1e-6) {
            // Nobody answered: try another way.
            this.actionFailed(c);
            return;
          }
          continue;
        }
        case 'visit': {
          const other = this.ref(task.npc);
          if (!other || !other.st.alive || other.st.away) {
            this.actionFailed(c);
            return;
          }
          if (l && !l.arrived) return;
          const use = Math.min(budget, task.hours - g.taskT);
          g.taskT += use;
          budget -= use;
          if (g.taskT >= task.hours - 1e-6) {
            other.st.needs.social = clamp(other.st.needs.social + 0.15, 0, 1);
            g.taskIdx++;
            g.taskT = 0;
          }
          continue;
        }
        case 'work':
        case 'hunt': {
          if (l && !l.arrived) return;
          const use = Math.min(budget, task.hours - g.taskT);
          g.taskT += use;
          budget -= use;
          g.progress = clamp((g.step + g.taskT / Math.max(0.1, task.hours)) / Math.max(1, g.plan.length), 0, 1);
          if (g.taskT >= task.hours - 1e-6) {
            g.taskIdx++;
            g.taskT = 0;
          }
          continue;
        }
      }
    }
  }

  /** Current plan step finished: next step or goal completion. */
  private advanceStep(c: GoalCtx): boolean {
    if (nextStep(c)) return true;
    if (goalSatisfied(c)) this.finishGoal(c.n.rec, c.n.st, c.g, true, '');
    else if (!planGoal(c)) this.finishGoal(c.n.rec, c.n.st, c.g, false, 'no way forward');
    return false;
  }

  private actionFailed(c: GoalCtx) {
    const a = c.g.plan[c.g.step];
    if (a && !c.g.blocked.includes(a)) c.g.blocked.push(a);
    if (!planGoal(c)) this.finishGoal(c.n.rec, c.n.st, c.g, false, 'every attempt failed');
  }

  // ================================================================== quests (bridge)

  questOffer(entityId: number, player: ServerEntity): QuestOffer | null {
    const l = this.byEntity.get(entityId);
    if (!l || !l.st.alive) return null;
    const g = this.activeGoal(l.st);
    if (!g || g.status !== 'active') return null;
    const pkey = `P:${player.name}`;
    if (Object.values(g.quests).includes(pkey)) return null;
    const spec = questFor(this.goalCtx(l.rec, l.st, g), l.e.id, player.name);
    if (!spec) return null;
    spec.timeLimit = Math.round((this.ctx.gen.profile.dayLengthSec || 1800) * 3);
    return { goalId: g.id, spec, goal: g.desc, wanted: g.help };
  }

  acceptQuest(entityId: number, player: ServerEntity, goalId: string, rewardMul = 1): string | null {
    const l = this.byEntity.get(entityId);
    if (!l) return null;
    const g = l.st.goals.find((x) => x.id === goalId);
    if (!g || (g.status !== 'active' && g.status !== 'waiting')) return null;
    const spec = questFor(this.goalCtx(l.rec, l.st, g), l.e.id, player.name);
    if (!spec) return null;
    spec.timeLimit = Math.round((this.ctx.gen.profile.dayLengthSec || 1800) * 3);
    // Accepted inside the conversation: no second offer step in the journal.
    spec.autoAccept = true;
    spec.category = 'npc';
    if (spec.rewards.coins) spec.rewards.coins = Math.round(spec.rewards.coins * clamp(rewardMul, 0.5, 2));
    let qid = '';
    try {
      qid = this.ctx.services.gm.createQuest(player, spec) || '';
    } catch (err) {
      this.ctx.log('npc: createQuest failed', err);
    }
    // Without a quest id from the game master we still track the promise locally.
    if (!qid) qid = `npcq:${g.id}:${player.name}`;
    const pkey = `P:${player.name}`;
    g.quests[qid] = pkey;
    g.status = 'waiting';
    g.deadline = Math.max(g.deadline, this.now() + 72);
    this.quests.set(qid, { rec: l.rec.id, goal: g.id, player: pkey });
    addDisp(l.st, pkey, 6, 'agreed to help me', this.now());
    this.updateFlags(l);
    return qid;
  }

  openQuests(entityId: number, player: ServerEntity): { goal: string; quest: string }[] {
    const l = this.byEntity.get(entityId);
    if (!l) return [];
    const pkey = `P:${player.name}`;
    const out: { goal: string; quest: string }[] = [];
    for (const g of l.st.goals) for (const [q, p] of Object.entries(g.quests)) if (p === pkey && (g.status === 'waiting' || g.status === 'active')) out.push({ goal: g.desc, quest: q });
    return out;
  }

  private onQuestEvent(p: ServerBusEvents['questEvent']) {
    const link = this.quests.get(p.quest);
    if (!link) return;
    if (p.event !== 'completed' && p.event !== 'failed' && p.event !== 'abandoned') return;
    this.quests.delete(p.quest);
    const rec = this.findRec(link.rec);
    const st = this.states.get(link.rec);
    if (!rec || !st) return;
    const g = st.goals.find((x) => x.id === link.goal);
    if (!g) return;
    delete g.quests[p.quest];
    const now = this.now();
    const c = this.goalCtx(rec, st, g);
    if (p.event === 'completed') {
      questCompleted(c, p.player.name);
      addDisp(st, link.player, 30, `helped me ${g.desc}`, now);
      addMemory(st, { text: `${p.player.name} helped ${rec.given} ${g.desc}`, kind: 'help', imp: 0.75, t: now, about: link.player }, now);
      // Word of good deeds spreads.
      if (rec.siteId) this.spread(rec.siteId, { text: `the stranger ${p.player.name} helped ${rec.given} ${g.desc}`, kind: 'help', imp: 0.5, about: link.player, from: rec.id }, 0.35);
      if (rec.siteId) for (const r of this.residents(rec.siteId)) if (r.rec.relations[rec.id] && r.rec.id !== rec.id) addDisp(r.st, link.player, 8, `helped ${rec.given}`, now);
      g.status = 'active';
      if (goalSatisfied(c)) this.finishGoal(rec, st, g, true, '');
      else if (!planGoal(c)) this.finishGoal(rec, st, g, false, 'no way forward');
    } else {
      addDisp(st, link.player, p.event === 'abandoned' ? -10 : -5, p.event === 'abandoned' ? 'abandoned my request' : 'failed my request', now);
      g.status = 'active';
      if (!g.blocked.includes('askHelp')) g.blocked.push('askHelp');
      if (!planGoal(c)) this.finishGoal(rec, st, g, false, 'help never came');
    }
  }

  // ================================================================== tick

  tick(dt: number) {
    this.tickN++;
    const now = this.ctx.time.now;
    for (const l of this.live.values()) {
      const e = l.e;
      if (e.speech && now > e.speech.until) {
        e.speech = undefined;
        e.dirty = true;
      }
      if (!e.alive) {
        if (!l.diedAt) l.diedAt = now;
        if (now - l.diedAt > CORPSE_TIME) this.despawnLive(l);
        continue;
      }
      if (now >= l.thinkAt) this.think(l);
      // Level of detail: near NPCs every tick, mid every 3rd, far only on think.
      if (l.lod === 0) this.act(l, dt);
      else if (l.lod === 1) {
        l.lodAcc += dt;
        if ((this.tickN + (e.id % 3)) % 3 === 0) {
          this.act(l, l.lodAcc);
          l.lodAcc = 0;
        }
      }
    }
  }

  slowTick() {
    const ctx = this.ctx;
    const nowH = this.now();
    const dh = this.lastHours < 0 ? 0 : clamp(nowH - this.lastHours, 0, 6);
    this.lastHours = nowH;
    this.manageActivation();
    // Live minds.
    for (const l of [...this.live.values()]) {
      if (!l.e.alive || !l.st.alive) continue;
      const sleeping = l.act === 'sleep';
      decayNeeds(l.st, l.rec.traits, dh, sleeping);
      satisfy(l.st, l.act === 'goal' ? 'work' : l.act, l.arrived ? dh : 0);
      if (l.act === 'talk') satisfy(l.st, 'talk', dh);
      if (l.rec.siteId || l.rec.job !== 'bandit') {
        this.manageGoals(l.rec, l.st);
        this.progressGoal(l.rec, l.st, dh, l);
      }
      if (l.st.away && l.site) this.despawnLive(l);
      l.e.inventory && (l.e.inventory.coins = l.st.coins);
    }
    // Returning travellers.
    for (const [id, st] of this.states) {
      if (!st.away || nowH < st.away.until) continue;
      st.away = undefined;
      const rec = this.findRec(id);
      if (!rec) continue;
      this.progressGoal(rec, st, 0.01, null);
      const rt = rec.siteId ? this.sites.get(rec.siteId) : null;
      if (rt?.active && st.alive) {
        // Walk in from the edge of town in the direction of travel.
        const a = this.rngRuntime.range(0, Math.PI * 2);
        const p: Vec3 = [rt.site.x + Math.cos(a) * rt.site.radius, rt.site.plateau, rt.site.z + Math.sin(a) * rt.site.radius];
        this.spawnLive(rec, st, rt, p, null, null);
      }
    }
    // Abstract simulation for loaded but inactive sites.
    this.abstractAcc += 1;
    if (this.abstractAcc >= 15) {
      this.abstractAcc = 0;
      for (const rt of this.sites.values()) if (!rt.active) this.catchUp(rt);
      this.expireSiteFlags();
    }
    // Gossip among people standing together.
    this.gossipAcc += 1;
    if (this.gossipAcc >= 4) {
      this.gossipAcc = 0;
      this.gossipLive();
    }
    // Crime dedupe housekeeping.
    for (const [k, t] of this.crimeSeen) if (ctx.time.now - t > 20) this.crimeSeen.delete(k);
  }

  private expireSiteFlags() {
    const now = this.now();
    for (const rt of this.sites.values()) for (const [k, v] of Object.entries(rt.flags)) if (v <= now) delete rt.flags[k];
  }

  /** Spawn/despawn sites, camps and wanderers around players. */
  private manageActivation() {
    const ctx = this.ctx;
    const players = ctx.players();
    const nearSites = new Set<string>();
    const nearCamps = new Set<string>();
    for (const p of players) {
      for (const s of ctx.gen.sites.sitesNear(p.pos[0], p.pos[2], ACTIVATE_MARGIN + 160)) {
        const d = Math.hypot(s.x - p.pos[0], s.z - p.pos[2]);
        if (d < s.radius + ACTIVATE_MARGIN) nearSites.add(s.id);
        else if (d < s.radius + DEACTIVATE_MARGIN && this.sites.get(s.id)?.active) nearSites.add(s.id);
      }
      for (const poi of this.pois(p.pos[0], p.pos[2], CAMP_DEACTIVATE)) {
        if (poi.kind !== 'camp') continue;
        const d = Math.hypot(poi.x - p.pos[0], poi.z - p.pos[2]);
        if (d < CAMP_ACTIVATE || (d < CAMP_DEACTIVATE && this.camps.get(poi.id)?.active)) nearCamps.add(poi.id);
      }
    }
    for (const id of nearSites) {
      const rt = this.loadSite(id);
      if (rt) {
        this.activateSite(rt);
        for (const rec of rt.recs) this.ensureLive(rec, rt);
      }
    }
    for (const rt of this.sites.values()) if (rt.active && !nearSites.has(rt.site.id) && ctx.time.now > rt.holdUntil) this.deactivateSite(rt);
    // Camps.
    for (const id of nearCamps) {
      const poi = this.poiById(id);
      if (!poi) continue;
      const c = this.camps.get(id) ?? this.loadCamp(poi);
      if (!c.cleared && !c.active) this.activateCamp(c);
    }
    for (const c of this.camps.values()) if (c.active && !nearCamps.has(c.poi.id)) this.deactivateCamp(c);
    // Pending wanderers from a save are re-spawned when a player is around.
    if (this.pendingWanderers.length && players.length) {
      const pend = this.pendingWanderers;
      this.pendingWanderers = [];
      for (const w of pend) {
        const near = ctx.gen.sites.sitesNear(w.pos[0], w.pos[2], 1200);
        const spec: WandererSpec = { kind: w.kind, seed: w.seed, pos: w.pos, races: w.races, gods: this.gods, origin: w.origin, index: w.index };
        this.spawnWandererRec(spec, near, w.leader, w.st);
      }
    }
    // Wanderers far from everyone move on (their story continues off-screen: news is delivered).
    for (const l of [...this.live.values()]) {
      if (!l.wander) continue;
      let dmin = Infinity;
      for (const p of players) dmin = Math.min(dmin, Math.hypot(p.pos[0] - l.e.pos[0], p.pos[2] - l.e.pos[2]));
      if (dmin > WANDERER_FORGET || !l.e.alive && l.diedAt && ctx.time.now - l.diedAt > CORPSE_TIME) {
        if (l.wander.destSite && !l.wander.newsDelivered) this.deliverNews(l, l.wander.destSite);
        this.wanderers.delete(l.rec.id);
        this.states.delete(l.rec.id);
        this.despawnLive(l);
      }
    }
  }

  private loadCamp(poi: PoiInfo): CampRt {
    const sv = this.savedCamps[poi.id];
    const size = campSize(poi.seed);
    const near = this.ctx.gen.sites.sitesNear(poi.x, poi.z, 1500);
    const races: RaceId[] = near.length ? near.flatMap((s) => [s.race as RaceId, (s.race2 ?? s.race) as RaceId]) : ['human', 'orc'];
    races.push('orc', 'goblin', 'human');
    const recs: NpcRecord[] = [];
    for (let i = 0; i < size; i++) recs.push(wandererRecord(this.ctx.seed, { kind: 'bandit', seed: poi.seed, pos: [poi.x, poi.y, poi.z], races, gods: this.gods, origin: null, camp: poi.id, index: i }));
    const c: CampRt = { poi, size, dead: sv?.dead ?? [], cleared: sv?.cleared ?? false, active: false, recs };
    this.camps.set(poi.id, c);
    return c;
  }

  private activateCamp(c: CampRt) {
    c.active = true;
    c.recs.forEach((rec, i) => {
      if (c.dead.includes(i) || this.live.has(rec.id)) return;
      const st = this.states.get(rec.id) ?? newState(rec, new Rng(deriveSeed(rec.seed, 'state')));
      this.states.set(rec.id, st);
      if (!st.alive) return;
      const a = (i / c.size) * Math.PI * 2;
      const pos: Vec3 = [c.poi.x + Math.cos(a) * 5, c.poi.y, c.poi.z + Math.sin(a) * 5];
      const w: WanderRt = {
        rec, spec: { kind: 'bandit', seed: c.poi.seed, pos, races: [], gods: this.gods, origin: null, camp: c.poi.id, index: i }, phase: 'roam', dest: pos, destSite: null,
        until: 0, anchor: [c.poi.x, c.poi.y, c.poi.z], newsDelivered: true,
      };
      this.spawnLive(rec, st, null, pos, w, c);
    });
  }

  private deactivateCamp(c: CampRt) {
    c.active = false;
    for (const r of c.recs) {
      const l = this.live.get(r.id);
      if (l) this.despawnLive(l);
    }
  }

  // ================================================================== abstract simulation

  /** Catch a site's minds up to now in coarse steps (needs, schedules, goals, gossip). */
  private catchUp(rt: SiteRt) {
    const now = this.now();
    let t = rt.lastSim;
    if (now - t > 96) t = now - 96; // cap: older history is summarised by the last 4 days
    const rng = this.rng('catchup', rt.site.id, Math.floor(now));
    while (t < now - 0.01) {
      const step = Math.min(2, now - t);
      const hour = (t + step / 2) % 24;
      for (const rec of rt.recs) {
        if (this.live.has(rec.id)) continue;
        const st = this.states.get(rec.id);
        if (!st || !st.alive) continue;
        if (st.away) {
          if (t >= st.away.until) {
            st.away = undefined;
            this.progressGoal(rec, st, 0.01, null);
          }
          continue;
        }
        const act = activityAt(rec.schedule, hour);
        decayNeeds(st, rec.traits, step, act === 'sleep');
        satisfy(st, act, step);
        if (st.needs.hunger < 0.3) satisfy(st, 'eat', 0.5);
        this.manageGoals(rec, st);
        const g = this.activeGoal(st);
        if (g && this.goalEligible(g, act)) this.progressGoal(rec, st, step, null);
      }
      // Gossip: a few conversations per step.
      const alive = rt.recs.filter((r) => this.states.get(r.id)?.alive && r.ageStage !== 'child');
      for (let i = 0; i < Math.ceil(alive.length / 6); i++) {
        if (alive.length < 2) break;
        const a = rng.pick(alive), b = rng.pick(alive);
        if (a !== b) this.gossip(a, b, false);
      }
      t += step;
    }
    rt.lastSim = now;
  }

  /** Speaker tells listener the juiciest thing the listener doesn't know yet. */
  private gossip(a: NpcRecord, b: NpcRecord, physical: boolean): Memory | null {
    const sa = this.states.get(a.id), sb = this.states.get(b.id);
    if (!sa || !sb || !sa.alive || !sb.alive) return null;
    const now = this.now();
    const known = new Set(sb.mem.map((m) => m.id));
    const m = juiciest(sa, now, (x) => known.has(x.id) || x.about === b.id);
    // Friends chat more warmly; the relationship grows a little either way.
    this.adjustRel(a.id, b.id, 0.5);
    this.adjustRel(b.id, a.id, 0.5);
    sa.needs.social = clamp(sa.needs.social + 0.05, 0, 1);
    sb.needs.social = clamp(sb.needs.social + 0.05, 0, 1);
    if (!m) return null;
    m.told = (m.told ?? 0) + 1;
    const trust = clamp(0.75 + ((b.relations[a.id]?.affinity ?? 0) + (sb.rel[a.id] ?? 0)) / 400, 0.5, 0.95);
    addMemory(sb, { ...m, heard: true, from: a.id, imp: m.imp * trust, told: 0, t: m.t }, now);
    // Gossip about the player colours opinions second-hand.
    if (m.about?.startsWith('P:')) {
      const d = sa.disp[m.about]?.v ?? 0;
      if (Math.abs(d) > 10) addDisp(sb, m.about, d * 0.2, `heard from ${a.given}`, now);
    }
    if (physical) {
      const l = this.live.get(a.id);
      if (l) this.bark(l, 'bark.gossip', { fact: m.text, person: b.given });
    }
    return m;
  }

  private gossipLive() {
    for (const l of this.live.values()) {
      if (!l.e.alive || !l.arrived || (l.act !== 'socialize' && l.act !== 'tavern' && l.act !== 'eat')) continue;
      if (!l.rng.chance(0.35)) continue;
      const others = this.ctx.entities.near(l.e.pos, 3.5, (x) => x.kind === 'npc' && x !== l.e && x.alive);
      if (!others.length) continue;
      const o = this.byEntity.get(l.rng.pick(others).id);
      if (!o || o.wander?.rec.job === 'bandit') continue;
      this.gossip(l.rec, o.rec, true);
    }
  }

  private deliverNews(l: Live, siteId: string) {
    const rt = this.loadSite(siteId);
    if (!rt || !l.wander) return;
    l.wander.newsDelivered = true;
    const now = this.now();
    const picks = [...l.st.mem].sort((a, b) => b.imp - a.imp).slice(0, 3);
    for (const m of picks) this.spread(siteId, { ...m, heard: true, from: l.rec.given, imp: m.imp * 0.85 }, 0.3);
    this.spread(siteId, { text: `a ${l.rec.title.toLowerCase()} named ${l.rec.given} passed through ${l.wander.spec.origin ? `on the way from ${l.wander.spec.origin}` : 'town'}`, kind: 'travel', imp: 0.3 }, 0.4);
    void now;
  }

  // ================================================================== thinking

  private scheduleActivity(rec: NpcRecord, st: NpcState, rt: SiteRt | null): ActivityKind {
    const hour = this.ctx.time.hour;
    let sched = activityAt(rec.schedule, hour);
    if (rt && (rt.flags.feast ?? 0) > this.now() && hour >= 18 && hour < 23.5 && sched !== 'guard' && sched !== 'patrol' && rec.ageStage !== 'child') sched = 'socialize';
    if (rt && sched === 'patrol' && (rt.flags.patrolFields ?? 0) > this.now() && rec.job === 'guard') sched = 'patrol';
    if (st.jailedUntil && this.now() < st.jailedUntil) return 'home';
    return sched;
  }

  private chooseActivity(l: Live): ActivityKind {
    const { rec, st } = l;
    const sched = this.scheduleActivity(rec, st, l.site);
    if (st.jailedUntil && this.now() < st.jailedUntil) return 'home';
    if (st.needs.safety < 0.3 && sched !== 'sleep' && JOBS[rec.job].combat < 0.5) return 'shelter';
    if (st.needs.energy < 0.1 || (st.injury > 0.7 && sched !== 'work')) return 'sleep';
    if (st.needs.hunger < 0.18 && sched !== 'sleep') return 'eat';
    if (rec.traits.piety > 0.3 && st.needs.faith < 0.2 && FREETIME.has(sched)) return 'pray';
    const w = this.ctx.weather;
    const bad = (w.kind === 'storm' && w.intensity > 0.3) || ((w.kind === 'rain' || w.kind === 'snow' || w.kind === 'ashfall') && w.intensity > 0.6);
    if (bad && OUTDOOR.has(sched) && rec.job !== 'guard' && !(sched === 'work' && rec.traits.conscientiousness > 0.4)) return 'shelter';
    const g = this.activeGoal(st);
    const task = g?.status === 'active' ? g.tasks[g.taskIdx] : undefined;
    if (g && task && task.k !== 'askHelp' && this.goalEligible(g, sched)) {
      // Agendas interleave with routine: diligent folk spend more of their slots on them.
      const slot = Math.floor(this.now() * 2);
      const focus = l.act === 'goal' && l.destKey.startsWith(g.id) ? 0.85 : 0.5 + rec.traits.conscientiousness * 0.25;
      if (new Rng(deriveSeed(rec.seed, 'focus', slot)).float() < focus) return 'goal';
    }
    // A started trip continues regardless of the schedule.
    if (g && g.status === 'active' && g.tasks[g.taskIdx]?.k === 'travel' && l.act === 'goal') return 'goal';
    return sched;
  }

  private think(l: Live) {
    const ctx = this.ctx;
    const now = ctx.time.now;
    const e = l.e;
    // Proximity / LOD.
    let best: ServerEntity | null = null, bd = Infinity;
    for (const p of ctx.players()) {
      const d = Math.hypot(p.pos[0] - e.pos[0], p.pos[2] - e.pos[2]);
      if (d < bd) (bd = d), (best = p);
    }
    l.nearestPlayer = best;
    l.nearestDist = bd;
    l.lod = bd < 110 ? 0 : bd < 280 ? 1 : 2;
    l.thinkAt = now + (l.lod === 0 ? 0.6 + l.rng.float() * 0.4 : l.lod === 1 ? 1.5 + l.rng.float() : 3 + l.rng.float() * 2);

    // Grudges expire.
    for (const [id, until] of l.grudge) if (until < now || !ctx.entities.get(id)?.alive) l.grudge.delete(id);

    // In conversation: hold still and face the player.
    if (l.talkPlayer !== null) {
      const p = ctx.entities.get(l.talkPlayer);
      if (!p || !p.alive || Math.hypot(p.pos[0] - e.pos[0], p.pos[2] - e.pos[2]) > 8) {
        l.talkPlayer = null;
      } else {
        this.setAct(l, 'talk');
        turnToward(e, yawTo(e.pos[0], e.pos[2], p.pos[0], p.pos[2]), Math.PI);
        this.applyAnim(l, 'idle', undefined, [p.pos[0], p.pos[1] + 1.6, p.pos[2]]);
        return;
      }
    }

    // Threats.
    if (l.lod < 2) this.scanThreats(l);
    if (l.threat !== null) {
      const t = ctx.entities.get(l.threat);
      if (!t || !t.alive) {
        l.threat = null;
        if (l.act === 'fight') this.bark(l, 'bark.victory');
      } else {
        const fight = this.willFight(l, t);
        this.setAct(l, fight ? 'fight' : 'flee');
        if (!fight) this.planFlee(l, t);
        this.updateFlags(l);
        return;
      }
    }

    // Wanderers have their own itinerary.
    if (l.wander) {
      this.thinkWanderer(l);
      this.updateFlags(l);
      this.ambientBarks(l);
      return;
    }

    const act = this.chooseActivity(l);
    this.setAct(l, act);
    if (act === 'goal') this.thinkGoal(l);
    else this.planActivity(l, act);
    this.updateFlags(l);
    this.ambientBarks(l);

    // Pause for players standing in the way / looking at us.
    if (l.nearestPlayer && l.nearestDist < 1.6 && l.body.idx < l.body.path.length && l.act !== 'flee') l.pauseUntil = now + 1.2;
  }

  private setAct(l: Live, act: ActivityKind) {
    if (l.act === act) return;
    l.lastAct = l.act;
    l.act = act;
    l.destKey = '';
    l.anims = [];
  }

  /** Destination & animation set for a scheduled activity. */
  private planActivity(l: Live, act: ActivityKind) {
    const rt = l.site;
    if (!rt) return;
    const { rec } = l;
    const lay = rt.layout;
    const now = this.now();
    const slot = Math.floor(now * 2); // half-hour slots for variety
    const r = new Rng(deriveSeed(rec.seed, act, slot));
    let key: string = act;
    let dest: Vec3 | null = null;
    let yaw = 0;
    let building: string | null = null;
    let anims: string[] = [];
    let pose: AnimState['move'] = 'idle';
    let run = false;
    const spotOf = (kinds: SmartSpot['kind'][], roles?: string[], slotKey = slot): SmartSpot | null => {
      const list: SmartSpot[] = [];
      for (const b of lay.buildings) if (!roles || roles.includes(b.role)) for (const s of b.spots) if (kinds.includes(s.kind)) list.push(s);
      if (!roles) for (const s of lay.spots) if (kinds.includes(s.kind)) list.push(s);
      if (!list.length) return null;
      return list[new Rng(deriveSeed(rec.seed, kinds.join(), slotKey)).int(0, list.length - 1)];
    };
    switch (act) {
      case 'sleep':
        dest = rec.bed;
        yaw = rec.bedYaw;
        building = rec.homeBuilding;
        pose = 'sleep';
        break;
      case 'home':
      case 'shelter': {
        if (l.st.jailedUntil && now < l.st.jailedUntil) {
          dest = [lay.plaza[0] + 2, lay.plaza[1], lay.plaza[2] + 2];
          pose = 'sit';
          key = 'stocks';
          break;
        }
        const home = lay.buildings.find((b) => b.id === rec.homeBuilding);
        const seat = home?.spots.find((s) => s.kind === 'seat' || s.kind === 'cook');
        if (act === 'shelter' && !home) {
          const near = lay.buildings.filter((b) => b.doors.length).sort((a, b) => Math.hypot(a.pos[0] - l.e.pos[0], a.pos[2] - l.e.pos[2]) - Math.hypot(b.pos[0] - l.e.pos[0], b.pos[2] - l.e.pos[2]))[0];
          dest = near ? near.pos : rec.bed;
          building = near?.id ?? null;
        } else {
          dest = seat?.pos ?? rec.bed;
          yaw = seat?.yaw ?? rec.bedYaw;
          building = rec.homeBuilding;
        }
        anims = ['eat', 'talk', 'gesture_shrug'];
        pose = seat?.kind === 'seat' ? 'sit' : 'idle';
        run = act === 'shelter';
        break;
      }
      case 'eat': {
        const tavern = rec.traits.extraversion > 0.2 && l.st.coins > 3 ? spotOf(['seat', 'drink'], ['tavern'], Math.floor(now / 24)) : null;
        if (tavern) {
          dest = tavern.pos;
          yaw = tavern.yaw;
          building = tavern.building ?? null;
          pose = tavern.kind === 'seat' ? 'sit' : 'idle';
        } else {
          const home = lay.buildings.find((b) => b.id === rec.homeBuilding);
          const seat = home?.spots.find((s) => s.kind === 'seat' || s.kind === 'cook');
          dest = seat?.pos ?? rec.bed;
          yaw = seat?.yaw ?? rec.bedYaw;
          building = rec.homeBuilding;
          pose = seat?.kind === 'seat' ? 'sit' : 'idle';
        }
        anims = ['eat', 'eat', 'drink'];
        break;
      }
      case 'work':
      case 'study':
        dest = rec.work;
        yaw = rec.workYaw;
        building = rec.workBuilding;
        anims = JOBS[rec.job].workAnims;
        if (act === 'study') anims = ['channel', 'talk', 'gesture_point'];
        break;
      case 'market': {
        const isMarketJob = JOBS[rec.job].merchant;
        const s = isMarketJob ? null : spotOf(['market', 'counter'], undefined);
        dest = s?.pos ?? rec.work;
        yaw = s?.yaw ?? rec.workYaw;
        building = s ? s.building ?? null : rec.workBuilding;
        anims = isMarketJob ? ['gesture_wave', 'talk', 'gesture_point'] : ['talk', 'pickup', 'gesture_shrug'];
        break;
      }
      case 'socialize': {
        const feast = (rt.flags.feast ?? 0) > now;
        const s = feast ? null : spotOf(['idle', 'seat', 'drink'], undefined, Math.floor(now / 1.5));
        const c = s?.pos ?? lay.plaza;
        // Stand in a loose circle around the gathering point, facing it.
        const a = r.range(0, Math.PI * 2), rad = feast ? r.range(2, 7) : r.range(1, 1.8);
        dest = [c[0] + Math.cos(a) * rad, c[1], c[2] + Math.sin(a) * rad];
        yaw = yawTo(dest[0], dest[2], c[0], c[2]);
        anims = feast ? ['cheer', 'dance', 'drink', 'talk'] : ['talk', 'gesture_shrug', 'gesture_point', 'talk'];
        key = `soc:${Math.floor(c[0])}:${Math.floor(c[2])}`;
        break;
      }
      case 'tavern': {
        const s = spotOf(['seat', 'drink'], ['tavern'], Math.floor(now / 24));
        if (s) {
          dest = s.pos;
          yaw = s.yaw;
          building = s.building ?? null;
          pose = s.kind === 'seat' ? 'sit' : 'idle';
        } else dest = [lay.plaza[0] + r.range(-4, 4), lay.plaza[1], lay.plaza[2] + r.range(-4, 4)];
        anims = rec.job === 'bard' ? ['dance', 'cheer', 'bow'] : ['drink', 'talk', 'cheer', 'drink'];
        break;
      }
      case 'pray': {
        const s = spotOf(['pray'], ['temple', 'shrine']) ?? spotOf(['pray'], undefined);
        dest = s?.pos ?? rec.bed;
        yaw = s?.yaw ?? rec.bedYaw;
        building = s?.building ?? rec.homeBuilding;
        anims = ['pray'];
        break;
      }
      case 'patrol': {
        const route = (rt.flags.patrolFields ?? 0) > now && l.patrolIdx % 2 === 0 ? [this.outskirts(rec, 'fields'), ...rt.patrol.slice(0, 3)] : rt.patrol;
        if (!route.length) {
          dest = rec.work;
          break;
        }
        if (l.arrived && l.destKey.startsWith('patrol')) l.patrolIdx = (l.patrolIdx + 1) % route.length;
        dest = route[l.patrolIdx % route.length];
        key = `patrol:${l.patrolIdx}`;
        anims = ['gesture_point'];
        break;
      }
      case 'guard': {
        const s = spotOf(['guard'], ['barracks', 'watchtower', 'gate', 'wall'], 0) ?? spotOf(['guard'], undefined, hashString(rec.id));
        dest = s?.pos ?? rec.work;
        yaw = s?.yaw ?? rec.workYaw;
        anims = ['block', 'gesture_point'];
        break;
      }
      case 'wander':
      case 'prowl': {
        const n = rt.nav.count ? r.int(0, rt.nav.count - 1) : -1;
        dest = n >= 0 ? [rt.nav.pos[n * 3], rt.nav.pos[n * 3 + 1], rt.nav.pos[n * 3 + 2]] : lay.plaza;
        anims = act === 'prowl' ? ['pickup', 'gesture_shrug'] : ['gesture_wave', 'talk'];
        break;
      }
      case 'play': {
        const c = lay.plaza;
        const slot2 = Math.floor(this.ctx.time.now / 12);
        const r2 = new Rng(deriveSeed(rec.seed, 'play', slot2));
        dest = [c[0] + r2.range(-9, 9), c[1], c[2] + r2.range(-9, 9)];
        key = `play:${slot2}`;
        run = true;
        anims = ['cheer', 'dance', 'gesture_wave'];
        break;
      }
      case 'beg': {
        const s = spotOf(['idle', 'seat'], undefined, Math.floor(now / 24));
        const c = s?.pos ?? lay.plaza;
        dest = [c[0] + 1.5, c[1], c[2] + 1.5];
        yaw = s?.yaw ?? 0;
        pose = 'sit';
        anims = ['gesture_wave'];
        break;
      }
      default:
        dest = rec.work;
    }
    if (!dest) return;
    const k = `${key}:${Math.round(dest[0])}:${Math.round(dest[2])}`;
    if (k === l.destKey) return;
    l.destKey = k;
    this.goTo(l, dest, yaw, building, run);
    l.anims = anims;
    l.pose = pose;
  }

  private goTo(l: Live, dest: Vec3, yaw: number, building: string | null, run = false) {
    const rt = l.site;
    l.dest = [dest[0], dest[1], dest[2]];
    l.destYaw = yaw;
    l.destBuilding = building;
    l.arrived = false;
    const b = l.body;
    b.run = run;
    b.idx = 0;
    b.stuck = 0;
    b.lastDist = Infinity;
    const path: Vec3[] = [];
    const exempt: string[] = [];
    if (rt) {
      const start = buildingAt(rt.layout.buildings, l.e.pos[0], l.e.pos[2]);
      const destB = building ? rt.layout.buildings.find((x) => x.id === building) ?? null : buildingAt(rt.layout.buildings, dest[0], dest[2]);
      if (start) exempt.push(start.id);
      if (destB) exempt.push(destB.id);
      if (start && start !== destB && start.doors.length) path.push(this.nearestDoor(start, l.e.pos));
      const from = path.length ? path[path.length - 1] : l.e.pos;
      const doorTo = destB && destB !== start && destB.doors.length ? this.nearestDoor(destB, from) : null;
      if (!(start && start === destB)) for (const p of routeVia(rt.nav, from, doorTo ?? dest)) path.push(p);
      if (doorTo) path.push(dest);
      if (start && start === destB) path.push(dest);
    } else path.push(l.dest);
    b.path = path;
    b.exempt = exempt;
    // Far from every player: no need to walk — teleport.
    if (l.lod === 2) {
      placeAt(l.e, b, rt ? rt.env : this.wildEnv(), dest, yaw);
      l.arrived = true;
    }
  }

  private nearestDoor(b: BuildingInfo, from: Vec3): Vec3 {
    let best = b.doors[0], bd = Infinity;
    for (const d of b.doors) {
      const dd = Math.hypot(d[0] - from[0], d[2] - from[2]);
      if (dd < bd) (bd = dd), (best = d);
    }
    return best;
  }

  private wildEnvCache: BodyEnv | null = null;
  private wildEnv(): BodyEnv {
    const ctx = this.ctx;
    return (this.wildEnvCache ??= { ctx, buildings: [], ground: (x, y, z) => ctx.groundAt(x, y + 3, z, 30) });
  }

  /** Physical goal execution: translate the current task into movement & animation. */
  private thinkGoal(l: Live) {
    const g = this.activeGoal(l.st);
    if (!g) return;
    const task = g.tasks[g.taskIdx];
    if (!task) return;
    const keyBase = `${g.id}:${g.step}:${g.taskIdx}`;
    switch (task.k) {
      case 'goto':
        if (l.destKey !== keyBase) {
          l.destKey = keyBase;
          this.goTo(l, task.to, l.e.yaw, null, !!task.run);
          l.anims = [];
          l.pose = 'idle';
        } else if (l.arrived) {
          g.taskIdx++;
          g.taskT = 0;
          l.destKey = '';
        }
        break;
      case 'work':
      case 'hunt':
        if (l.destKey !== keyBase) {
          l.destKey = keyBase;
          const at = task.at ?? l.e.pos;
          this.goTo(l, at, task.k === 'work' ? task.yaw ?? l.e.yaw : l.e.yaw, null);
          l.anims = task.k === 'work' ? task.anims : ['shoot_bow', 'pickup'];
          l.pose = 'idle';
        }
        if (task.k === 'hunt' && l.arrived) this.huntNearby(l, g);
        break;
      case 'askHelp':
        if (l.destKey !== keyBase) {
          l.destKey = keyBase;
          this.goTo(l, l.rec.work, l.rec.workYaw, l.rec.workBuilding);
          l.anims = ['gesture_wave', 'talk', 'gesture_shrug'];
        }
        // Call out to passing players.
        if (l.arrived && l.nearestPlayer && l.nearestDist < 14) this.bark(l, 'goal.pitch', { goal: g.desc });
        break;
      case 'visit': {
        const other = this.live.get(task.npc);
        const target = other?.e.alive ? other.e.pos : this.findRec(task.npc)?.bed ?? l.rec.work;
        const k = `${keyBase}:${Math.round(target[0] / 3)}:${Math.round(target[2] / 3)}`;
        if (l.destKey !== k) {
          l.destKey = k;
          // Stop a little short and face them.
          const dx = target[0] - l.e.pos[0], dz = target[2] - l.e.pos[2];
          const d = Math.hypot(dx, dz) || 1;
          const stop: Vec3 = [target[0] - (dx / d) * 1.2, target[1], target[2] - (dz / d) * 1.2];
          this.goTo(l, stop, yawTo(stop[0], stop[2], target[0], target[2]), null);
          l.anims = ['talk', 'gesture_shrug', 'talk', 'bow'];
        }
        if (l.arrived && other?.e.alive && other.talkPlayer === null) {
          turnToward(other.e, yawTo(other.e.pos[0], other.e.pos[2], l.e.pos[0], l.e.pos[2]), Math.PI);
          other.pauseUntil = this.ctx.time.now + 3;
          if (task.topic === 'court') this.bark(l, 'bark.courtship', { person: other.rec.given });
          else if (task.topic === 'rival') this.bark(l, 'bark.rival', { person: other.rec.given });
          else if (task.topic === 'debt') this.bark(l, 'bark.debt', { person: other.rec.given });
        }
        break;
      }
      case 'travel': {
        if (l.destKey !== keyBase) {
          l.destKey = keyBase;
          this.goTo(l, task.to, l.e.yaw, null);
          l.anims = [];
          this.bark(l, 'bark.travel', { target: task.site ? this.site(task.site)?.name ?? 'the road' : 'the road' });
        }
        // Once out of town (or far from any player), the trip continues abstractly.
        const rt = l.site;
        const out = !rt || Math.hypot(l.e.pos[0] - rt.site.x, l.e.pos[2] - rt.site.z) > rt.site.radius + 30;
        if (out || l.lod === 2 || l.arrived) {
          l.st.away = { until: this.now() + Math.max(0.5, task.hours - g.taskT), site: task.site ?? null, label: task.label };
          g.taskIdx++;
          g.taskT = 0;
          this.despawnLive(l);
        }
        break;
      }
      case 'effect':
        this.progressGoal(l.rec, l.st, 0, l);
        break;
    }
  }

  /** During a hunt task: engage suitable creatures nearby. */
  private huntNearby(l: Live, g: Goal) {
    const sp = Number(g.data.species);
    const prey = this.ctx.entities.near(l.e.pos, 45, (x) => x.kind === 'creature' && x.alive && (!Number.isFinite(sp) || sp < 0 || x.creature?.species === sp));
    if (prey.length) {
      l.threat = prey[0].id;
      l.threatSince = this.ctx.time.now;
      l.grudge.set(prey[0].id, this.ctx.time.now + 60);
      this.bark(l, 'bark.hunt');
    }
  }

  // ================================================================== wanderers

  private thinkWanderer(l: Live) {
    const w = l.wander!;
    const nowH = this.now();
    const e = l.e;
    // Escorts follow their leader.
    if (w.leader) {
      const lead = this.live.get(w.leader);
      if (lead && lead.e.alive) {
        const tp = lead.e.pos;
        const d = Math.hypot(tp[0] - e.pos[0], tp[2] - e.pos[2]);
        if (d > 4) {
          const a = (hashString(l.rec.id) % 628) / 100;
          const p: Vec3 = [tp[0] + Math.cos(a) * 2.5, tp[1], tp[2] + Math.sin(a) * 2.5];
          this.wanderGo(l, p, d > 10);
        }
        l.act = lead.act === 'sleep' ? 'sleep' : 'travel';
        return;
      }
      w.leader = undefined;
    }
    const hour = this.ctx.time.hour;
    const night = hour < 5.5 || hour > 21.5;
    if (w.phase === 'approach') {
      // Messengers and wronged householders seek out the player, have their say, then leave.
      const p = l.nearestPlayer;
      if (p && nowH < w.until && l.nearestDist < 120) {
        if (l.nearestDist > 3) {
          this.setAct(l, 'travel');
          const dx = p.pos[0] - e.pos[0], dz = p.pos[2] - e.pos[2];
          const d = Math.hypot(dx, dz) || 1;
          this.wanderGo(l, [p.pos[0] - (dx / d) * 2, p.pos[1], p.pos[2] - (dz / d) * 2], d > 12 && w.spec.kind === 'angry_owner', `appr${Math.round(p.pos[0] / 3)}:${Math.round(p.pos[2] / 3)}`);
          if (w.spec.kind === 'angry_owner' && l.rng.chance(0.15)) this.bark(l, 'bark.crime', {}, 'shout');
        } else {
          this.setAct(l, 'talk');
          turnToward(e, yawTo(e.pos[0], e.pos[2], p.pos[0], p.pos[2]), Math.PI);
          l.anims = w.spec.kind === 'angry_owner' ? ['gesture_point', 'gesture_shrug'] : ['bow', 'talk'];
        }
        return;
      }
      const near = this.ctx.gen.sites.sitesNear(e.pos[0], e.pos[2], 1500).sort((a, b) => Math.hypot(a.x - e.pos[0], a.z - e.pos[2]) - Math.hypot(b.x - e.pos[0], b.z - e.pos[2]))[0];
      w.phase = 'travel';
      w.dest = near ? [near.x, near.plateau, near.z] : [e.pos[0] + 400, e.pos[1], e.pos[2]];
      w.destSite = near?.id ?? null;
      return;
    }
    if (w.phase === 'roam') {
      // Bandits and hunters loiter around an anchor (camp fire), sleeping at night.
      if (night && l.rng.chance(0.7)) {
        this.setAct(l, 'sleep');
        if (!l.destKey.startsWith('sleep')) {
          const a = (hashString(l.rec.id) % 628) / 100;
          this.wanderGo(l, [w.anchor[0] + Math.cos(a) * 4, w.anchor[1], w.anchor[2] + Math.sin(a) * 4], false, 'sleep');
          l.pose = 'sleep';
        }
        return;
      }
      this.setAct(l, l.rec.job === 'bandit' ? 'guard' : 'work');
      if (l.arrived && l.rng.chance(0.25)) {
        const a = l.rng.range(0, Math.PI * 2), r = l.rng.range(3, l.camp ? 14 : 40);
        this.wanderGo(l, [w.anchor[0] + Math.cos(a) * r, w.anchor[1], w.anchor[2] + Math.sin(a) * r], false, `roam${Math.floor(this.ctx.time.now)}`);
        l.anims = l.rec.job === 'bandit' ? ['gesture_point', 'cheer', 'swing_1h'] : ['shoot_bow', 'pickup'];
      }
      return;
    }
    if (w.phase === 'travel') {
      this.setAct(l, 'travel');
      const d = Math.hypot(w.dest[0] - e.pos[0], w.dest[2] - e.pos[2]);
      if (night && l.rng.chance(0.5) && d > 60) {
        this.setAct(l, 'sleep');
        this.wanderGo(l, e.pos, false, 'camp-night');
        l.pose = 'sleep';
        return;
      }
      if (d < 25) {
        // Arrived: visit the town for a while (or pray at the shrine).
        w.phase = 'visit';
        w.until = nowH + l.rng.range(4, 12);
        if (w.destSite && !w.newsDelivered) this.deliverNews(l, w.destSite);
        return;
      }
      if (!l.destKey.startsWith('travel') || l.arrived) {
        // Walk in legs of ~60 m so terrain & roads are re-evaluated.
        const step = Math.min(60, d);
        const nx = e.pos[0] + ((w.dest[0] - e.pos[0]) / d) * step, nz = e.pos[2] + ((w.dest[2] - e.pos[2]) / d) * step;
        this.wanderGo(l, [nx, e.pos[1], nz], false, `travel${Math.round(nx)}`);
      }
      return;
    }
    // Visiting a town: behave like a guest (tavern, market, plaza), then move on.
    const rt = w.destSite ? this.loadSite(w.destSite) : null;
    if (nowH > w.until) {
      const next = rt ? this.linked(rt.site.id).filter((s) => s.id !== w.spec.origin) : [];
      if (next.length) {
        const s = l.rng.pick(next);
        w.spec.origin = rt?.site.name ?? w.spec.origin;
        w.dest = [s.x, s.plateau, s.z];
        w.destSite = s.id;
        w.newsDelivered = false;
        w.phase = 'travel';
        this.bark(l, 'bark.travel', { target: s.name });
      } else {
        w.until = nowH + 6;
      }
      return;
    }
    if (rt) {
      l.site = rt;
      const act: ActivityKind = night ? 'sleep' : l.rec.job === 'merchant' ? 'market' : l.rec.job === 'pilgrim' ? 'pray' : hour > 17 ? 'tavern' : 'socialize';
      this.setAct(l, act);
      if (act === 'sleep') {
        const tav = rt.layout.buildings.find((b) => b.role === 'tavern') ?? rt.layout.buildings[0];
        const bed = tav?.spots.find((s) => s.kind === 'bed' || s.kind === 'seat');
        if (!l.destKey.startsWith('vsleep')) {
          l.destKey = 'vsleep';
          this.goTo(l, bed?.pos ?? rt.layout.plaza, bed?.yaw ?? 0, tav?.id ?? null);
          l.pose = 'sleep';
        }
      } else if (act === 'market') {
        if (!l.destKey.startsWith('vmarket')) {
          const s = rt.layout.spots.find((x) => x.kind === 'market') ?? null;
          l.destKey = 'vmarket';
          this.goTo(l, s?.pos ?? rt.layout.plaza, s?.yaw ?? 0, null);
          l.anims = ['gesture_wave', 'talk', 'gesture_point'];
        }
      } else this.planActivity(l, act);
    } else {
      this.setAct(l, 'pray');
      if (!l.destKey.startsWith('shrine')) {
        this.wanderGo(l, w.dest, false, 'shrine');
        l.anims = ['pray', 'bow'];
      }
    }
  }

  private wanderGo(l: Live, p: Vec3, run: boolean, key?: string) {
    const k = key ?? `w${Math.round(p[0])}:${Math.round(p[2])}`;
    if (l.destKey === k) return;
    l.destKey = k;
    const rt = l.site;
    if (rt && Math.hypot(p[0] - rt.site.x, p[2] - rt.site.z) < rt.site.radius * 1.3) this.goTo(l, p, l.e.yaw, null, run);
    else {
      l.dest = [p[0], p[1], p[2]];
      l.arrived = false;
      l.body.path = [l.dest];
      l.body.idx = 0;
      l.body.run = run;
      l.body.exempt = [];
      l.body.stuck = 0;
      l.body.lastDist = Infinity;
      if (l.lod === 2) {
        placeAt(l.e, l.body, this.wildEnv(), p);
        l.arrived = true;
      }
    }
    l.pose = 'idle';
  }

  // ================================================================== threats & combat

  private hostileTo(l: Live, x: ServerEntity): boolean {
    if (l.grudge.has(x.id)) return true;
    const bandit = l.rec.job === 'bandit';
    if (x.kind === 'npc') {
      const o = this.byEntity.get(x.id);
      if (o && o.rec.job === 'bandit') return !bandit;
      return bandit && !!o && o.rec.job !== 'bandit';
    }
    if (x.kind === 'player') return (bandit || l.wander?.spec.kind === 'bounty_hunter') && x.alive;
    if (x.kind === 'creature') {
      if (x.tags.has('summon') || x.flags & EntFlag.Tamed) return false;
      return (x.flags & EntFlag.Hostile) !== 0 || (x.target !== undefined && this.byEntity.has(x.target));
    }
    return false;
  }

  private scanThreats(l: Live) {
    if (l.threat !== null) return;
    const e = l.e;
    const r = l.rec.job === 'guard' || l.rec.job === 'bandit' ? 26 : 15;
    const near = this.ctx.entities.near(e.pos, r, (x) => x !== e && x.alive && (x.kind === 'creature' || x.kind === 'npc' || x.kind === 'player'));
    let best: ServerEntity | null = null, bd = Infinity;
    for (const x of near) {
      if (!this.hostileTo(l, x)) continue;
      const d = Math.hypot(x.pos[0] - e.pos[0], x.pos[2] - e.pos[2]);
      // Bandits size up players before charging: only within 18 m.
      if (x.kind === 'player' && (l.rec.job === 'bandit' || l.wander?.spec.kind === 'bounty_hunter') && d > 18 && !l.grudge.has(x.id)) continue;
      if (d < bd) (bd = d), (best = x);
    }
    if (!best) return;
    l.threat = best.id;
    l.threatSince = this.ctx.time.now;
    const now = this.now();
    if (!l.seen.has(best.id)) {
      l.seen.add(best.id);
      if (best.kind === 'creature') {
        const sp = best.creature?.species ?? -1;
        const cn = this.speciesName(sp);
        const place = l.site?.site.name ?? 'the road';
        addMemory(l.st, { text: `a ${cn} attacked near ${place}`, kind: 'monster', imp: 0.7, t: now, about: `S:${sp}`, pos: [best.pos[0], best.pos[1], best.pos[2]] }, now);
      }
      if (best.kind === 'player' && l.rec.job === 'bandit') this.bark(l, 'bark.bandit.taunt', {}, 'shout', true);
    }
    l.st.needs.safety = Math.min(l.st.needs.safety, 0.25);
  }

  private willFight(l: Live, t: ServerEntity): boolean {
    const job = JOBS[l.rec.job];
    if (l.rec.ageStage === 'child') return false;
    if (l.rec.job === 'bandit' || l.rec.job === 'guard') return l.e.hp > l.e.maxHp * 0.15 || l.rec.traits.courage > 0.5;
    if (job.combat >= 0.45 && l.e.hp > l.e.maxHp * 0.35) return true;
    return l.rec.traits.courage > 0.6 && job.combat >= 0.2 && t.kind !== 'player';
  }

  private planFlee(l: Live, t: ServerEntity) {
    const rt = l.site;
    const target: Vec3 = rt && l.rec.siteId ? l.rec.bed : [l.e.pos[0] + (l.e.pos[0] - t.pos[0]) * 3, l.e.pos[1], l.e.pos[2] + (l.e.pos[2] - t.pos[2]) * 3];
    const k = `flee:${t.id}`;
    if (l.destKey !== k || l.arrived) {
      l.destKey = k;
      if (rt && l.rec.siteId) this.goTo(l, target, l.rec.bedYaw, l.rec.homeBuilding, true);
      else this.wanderGo(l, target, true, k);
      l.body.run = true;
      this.bark(l, 'bark.flee', {}, 'shout', true);
    }
    // Safe at home and the threat lost track? Calm down.
    if (l.arrived && Math.hypot(t.pos[0] - l.e.pos[0], t.pos[2] - l.e.pos[2]) > 20) l.threat = null;
  }

  /** Per-tick combat: chase & strike. */
  private combat(l: Live, dt: number): boolean {
    const t = this.ctx.entities.get(l.threat ?? -1);
    if (!t || !t.alive) {
      l.threat = null;
      return false;
    }
    const e = l.e;
    const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
    const d = Math.hypot(dx, dz);
    // Give up chases that lead far from home.
    const anchor = l.site ? [l.site.site.x, l.site.site.z] : l.wander ? [l.wander.anchor[0], l.wander.anchor[2]] : [e.pos[0], e.pos[2]];
    const leash = l.site ? l.site.site.radius + 70 : 60;
    if (Math.hypot(t.pos[0] - anchor[0], t.pos[2] - anchor[1]) > leash || d > 45 || this.ctx.time.now - l.threatSince > 90) {
      l.threat = null;
      l.grudge.delete(t.id);
      return false;
    }
    const archer = l.rec.job === 'hunter';
    const reach = archer ? 16 : 1.7 + t.radius;
    l.attackCd -= dt;
    if (d > reach) {
      l.body.path = [[t.pos[0] - (dx / d) * (reach * 0.8), t.pos[1], t.pos[2] - (dz / d) * (reach * 0.8)]];
      l.body.idx = 0;
      l.body.exempt = [];
      stepBody(e, l.body, l.site?.env ?? this.wildEnv(), dt, RUN * this.speedMul(l), this.neighbours(l));
      this.applyAnim(l, 'run', undefined, [t.pos[0], t.pos[1] + 1.4, t.pos[2]], 'angry');
      return true;
    }
    turnToward(e, yawTo(e.pos[0], e.pos[2], t.pos[0], t.pos[2]), 10 * dt);
    settle(e, l.body, l.site?.env ?? this.wildEnv(), dt);
    if (l.attackCd <= 0) {
      const job = JOBS[l.rec.job];
      const anim = archer ? 'shoot_bow' : job.combat > 0.4 ? l.rng.pick(['swing_1h', 'stab', 'swing_1h']) : 'punch';
      l.attackCd = archer ? 1.8 : 1.25 + l.rng.float() * 0.4;
      e.anim = { move: 'idle', action: { id: anim, t0: this.ctx.time.now, dur: 0.7 }, mood: 'angry', lookAt: [t.pos[0], t.pos[1] + 1.4, t.pos[2]] };
      e.flags |= EntFlag.InCombat;
      e.target = t.id;
      e.dirty = true;
      const dmg = (4 + job.combat * 12) * (0.8 + l.rng.float() * 0.4);
      this.ctx.services.combat.damage(t, dmg, archer ? 'pierce' : job.combat > 0.4 ? 'slash' : 'blunt', e, { pos: [t.pos[0], t.pos[1] + 1, t.pos[2]] });
      if (l.rng.chance(0.2)) this.bark(l, 'bark.fight', {}, 'shout');
    }
    return true;
  }

  private neighbours(l: Live): ServerEntity[] | null {
    if (l.lod > 0) return null;
    return this.ctx.entities.near(l.e.pos, 1.3, (x) => x !== l.e && (x.kind === 'npc' || x.kind === 'player'));
  }

  private speedMul(l: Live): number {
    const s = l.e.stats?.moveSpeed ?? 1;
    const scale = l.e.humanoid?.scale ?? 1;
    const kid = l.rec.ageStage === 'child' ? 0.85 : l.rec.ageStage === 'elder' ? 0.75 : 1;
    return s * kid * (0.85 + scale * 0.15) * (1 - l.st.injury * 0.4);
  }

  // ================================================================== acting (per tick)

  private act(l: Live, dt: number) {
    const e = l.e;
    const now = this.ctx.time.now;
    if (l.threat !== null && l.act === 'fight') {
      if (this.combat(l, dt)) return;
    }
    e.target = undefined;
    e.flags &= ~EntFlag.InCombat;
    if (l.act === 'talk') return;
    const env = l.site?.env ?? this.wildEnv();
    if (!l.arrived && now >= l.pauseUntil) {
      const speed = (l.body.run || l.act === 'flee' ? RUN : WALK) * this.speedMul(l);
      const done = stepBody(e, l.body, env, dt, speed, this.neighbours(l));
      const prowl = l.act === 'prowl' && this.ctx.time.hour > 20;
      this.applyAnim(l, l.body.run || l.act === 'flee' ? 'run' : prowl ? 'crouch' : 'walk', undefined, this.lookTarget(l), l.act === 'flee' ? 'afraid' : undefined);
      if (done) {
        l.arrived = true;
        if (l.dest) {
          e.pos[0] = l.dest[0];
          e.pos[2] = l.dest[2];
        }
      }
      return;
    }
    if (!l.arrived) {
      // Paused: face whoever is in the way.
      if (l.nearestPlayer) turnToward(e, yawTo(e.pos[0], e.pos[2], l.nearestPlayer.pos[0], l.nearestPlayer.pos[2]), 4 * dt);
      this.applyAnim(l, 'idle', undefined, this.lookTarget(l));
      return;
    }
    settle(e, l.body, env, dt);
    if (l.destYaw !== undefined && l.pose !== 'sleep') turnToward(e, l.destYaw, 3 * dt);
    // Cycle activity animations.
    let action = e.anim.action;
    if (now >= l.nextAnimAt && l.anims.length && l.pose !== 'sleep') {
      const id = l.anims[l.animIdx++ % l.anims.length];
      const dur = id === 'pray' || id === 'channel' ? 6 : id === 'sit' ? 0 : 2.2 + l.rng.float() * 1.6;
      action = dur > 0 ? { id, t0: now, dur } : undefined;
      l.nextAnimAt = now + dur + 0.8 + l.rng.float() * (l.act === 'work' || l.act === 'goal' ? 1.2 : 4);
    } else if (action && now > action.t0 + action.dur) action = undefined;
    this.applyAnim(l, l.pose, action, this.lookTarget(l));
  }

  private lookTarget(l: Live): Vec3 | undefined {
    const p = l.nearestPlayer;
    if (!p || l.nearestDist > 7 || l.pose === 'sleep') return undefined;
    // Only look if the player is roughly in front.
    const yawP = yawTo(l.e.pos[0], l.e.pos[2], p.pos[0], p.pos[2]);
    let d = Math.abs(yawP - l.e.yaw);
    if (d > Math.PI) d = Math.PI * 2 - d;
    return d < 1.9 ? [p.pos[0], p.pos[1] + (p.height || 1.7) * 0.92, p.pos[2]] : undefined;
  }

  /** Update e.anim only when something visible changed. */
  private applyAnim(l: Live, move: AnimState['move'], action: AnimState['action'], lookAt?: Vec3, moodOverride?: Mood) {
    const e = l.e;
    const now = this.ctx.time.now;
    const talking = l.talkUntil > now || (!!e.speech && e.speech.until > now);
    const mood = moodOverride ?? (l.talkUntil > now && l.talkMood ? l.talkMood : moodOf(l.st, l.rec.traits, this.now()));
    const a = e.anim;
    const lookChanged = (a.lookAt === undefined) !== (lookAt === undefined) || (lookAt && a.lookAt && Math.abs(a.lookAt[0] - lookAt[0]) + Math.abs(a.lookAt[2] - lookAt[2]) > 0.3);
    if (a.move === move && a.action === action && a.mood === mood && !!a.talking === talking && !lookChanged) return;
    e.anim = { move, action, mood, talking, lookAt };
    if (move === 'sleep') e.flags |= EntFlag.Sleeping;
    else e.flags &= ~EntFlag.Sleeping;
    e.dirty = true;
  }

  private updateFlags(l: Live) {
    const e = l.e;
    let f = e.flags;
    const g = this.activeGoal(l.st);
    const quest = !!g && g.status === 'active' && (g.help || (l.rec.traits.extraversion > 0.3 && canQuest(g.kind)));
    if (quest && l.rec.job !== 'bandit') f |= EntFlag.Questgiver;
    else f &= ~EntFlag.Questgiver;
    if (f !== e.flags) {
      e.flags = f;
      e.dirty = true;
    }
  }

  // ================================================================== barks

  speaker(rec: NpcRecord): VoiceSpeaker {
    return { race: rec.race, traits: rec.traits, job: rec.job, ageStage: rec.ageStage, gender: rec.gender };
  }

  private bark(l: Live, key: string, vars: Record<string, string | number | undefined> = {}, style: 'say' | 'shout' | 'whisper' | 'think' = 'say', force = false) {
    const now = this.ctx.time.now;
    if (!l.e.alive || l.talkPlayer !== null) return;
    if (!force && (now < l.barkAt || !l.nearestPlayer || l.nearestDist > 24)) return;
    if (!force && l.site && now < l.site.barkAt) return;
    // Children have their own small repertoire; fear and pain sound the same at any age.
    if (l.rec.ageStage === 'child' && key.startsWith('bark.') && !CHILD_KEEP.has(key)) key = 'bark.child';
    const deity = l.rec.deity ? this.gods.find((g) => g.id === l.rec.deity) : null;
    const text = say(key, this.speaker(l.rec), {
      name: l.rec.given, place: l.site?.site.name ?? 'here', deity: deity?.name, player: l.nearestPlayer?.name, job: JOB_NOUN[l.rec.job],
      weather: this.ctx.weather.kind, ...vars,
    }, l.rng);
    if (!text) return;
    l.e.speech = { text, until: now + clamp(2.2 + text.length / 16, 3, 8), style: l.rec.job === 'thief' && key === 'bark.thief' ? 'whisper' : style };
    l.e.dirty = true;
    l.barkAt = now + 14 + l.rng.float() * 36 - l.rec.traits.extraversion * 8;
    if (l.site) l.site.barkAt = now + 2.5;
  }

  private barkRec(recId: string, key: string, vars?: Record<string, string>) {
    const l = this.live.get(recId);
    if (l) this.bark(l, key, vars ?? {});
  }

  private ambientBarks(l: Live) {
    if (l.lod > 0 || !l.nearestPlayer || l.nearestDist > 18 || this.ctx.time.now < l.barkAt) return;
    const { rec, st } = l;
    const p = l.nearestPlayer;
    const r = l.rng;
    const w = this.ctx.weather;
    // Greet a passing player once in a while (disposition-aware).
    if (l.nearestDist < 5 && r.chance(0.5)) {
      const d = this.dispValue(rec, st, p);
      if (d < -40) return this.bark(l, 'bark.guard.warn');
      if (rec.job === 'guard' && r.chance(0.5)) return this.bark(l, d < -10 ? 'bark.guard.warn' : 'bark.guard.patrol');
      return this.bark(l, 'bark.greetPass', { addr: p.name });
    }
    const g = this.activeGoal(st);
    if (g?.help && g.status === 'active' && l.nearestDist < 12 && r.chance(0.5)) return this.bark(l, 'goal.pitch', { goal: g.desc });
    if (!r.chance(0.18)) return;
    const recentDeath = st.mem.find((m) => m.kind === 'death' && m.imp >= 0.75 && this.now() - m.t < 48);
    if (recentDeath) return this.bark(l, 'bark.mourn', { person: recentDeath.text.split(' ')[0] });
    if (w.kind === 'rain' || w.kind === 'snow' || w.kind === 'storm' || w.kind === 'fog') if (r.chance(0.4)) return this.bark(l, `bark.weather.${w.kind}`);
    if (st.needs.hunger < 0.3) return this.bark(l, 'bark.hungry');
    if (st.needs.energy < 0.25) return this.bark(l, 'bark.sleepy');
    switch (l.act) {
      case 'work':
      case 'goal':
        return this.bark(l, 'bark.work');
      case 'market':
        return this.bark(l, 'bark.market');
      case 'tavern':
        return this.bark(l, 'bark.tavern');
      case 'pray':
        return this.bark(l, 'bark.pray');
      case 'play':
        return this.bark(l, 'bark.child');
      case 'patrol':
      case 'guard':
        return this.bark(l, 'bark.guard.patrol');
      case 'prowl':
        return this.bark(l, 'bark.thief', {}, 'whisper');
      case 'travel':
        return this.bark(l, rec.job === 'merchant' ? 'bark.caravan' : 'bark.travel', { target: l.wander?.destSite ? this.site(l.wander.destSite)?.name : 'the next town' });
    }
    const h = this.ctx.time.hour;
    if (h < 9 && r.chance(0.4)) return this.bark(l, 'bark.morning');
    if (h > 19 && r.chance(0.4)) return this.bark(l, h > 22 ? 'bark.night' : 'bark.evening');
    this.bark(l, 'bark.idle');
  }

  // ================================================================== world reactions

  private witnesses(pos: Vec3, r: number): Live[] {
    const out: Live[] = [];
    for (const x of this.ctx.entities.near(pos, r, (x) => x.kind === 'npc' && x.alive)) {
      const l = this.byEntity.get(x.id);
      if (l) out.push(l);
    }
    return out;
  }

  private onDamage(p: ServerBusEvents['damage']) {
    const l = this.byEntity.get(p.target.id);
    if (!l || !p.source || p.source === p.target) return;
    const src = p.source;
    const now = this.ctx.time.now;
    l.st.injury = clamp(l.st.injury + (p.amount / Math.max(1, l.e.maxHp)) * 0.4, 0, 1);
    l.grudge.set(src.id, now + 60);
    if (l.threat === null || l.act !== 'fight') {
      l.threat = src.id;
      l.threatSince = now;
      l.thinkAt = now;
    }
    if (!l.e.anim.action || now > l.e.anim.action.t0 + l.e.anim.action.dur) {
      l.e.anim = { ...l.e.anim, action: { id: 'flinch', t0: now, dur: 0.4 }, mood: 'pain' };
      l.e.dirty = true;
    }
    if (l.rng.chance(0.35)) this.bark(l, 'bark.hurt', {}, 'shout', true);
    // Attacking a peaceful NPC is a crime; bandits are fair game.
    if (src.kind === 'player' && l.rec.job !== 'bandit') {
      const k = `${src.id}:${l.e.id}:assault`;
      if (!this.crimeSeen.has(k)) this.ctx.bus.emit('crime', { offender: src, victim: l.e, kind: 'assault', pos: [l.e.pos[0], l.e.pos[1], l.e.pos[2]] });
    }
  }

  private onCrime(p: ServerBusEvents['crime']) {
    const k = `${p.offender.id}:${p.victim?.id ?? ''}:${p.kind}`;
    const now = this.ctx.time.now;
    if (this.crimeSeen.has(k) && now - this.crimeSeen.get(k)! < 15) return;
    this.crimeSeen.set(k, now);
    const off = p.offender;
    const okey = this.keyOf(off);
    if (!okey) return;
    const victimName = p.victim ? (this.byEntity.get(p.victim.id)?.rec.given ?? p.victim.name) || 'someone' : 'someone';
    const verbs: Record<string, string> = { assault: `attacked ${victimName}`, murder: `murdered ${victimName}`, theft: `stole from ${victimName}`, vandalism: 'smashed property', trespass: 'was sneaking where they should not' };
    const imp: Record<string, number> = { assault: 0.7, murder: 0.95, theft: 0.6, vandalism: 0.5, trespass: 0.3 };
    const disp: Record<string, number> = { assault: -22, murder: -45, theft: -16, vandalism: -10, trespass: -5 };
    const h = this.now();
    const place = this.ctx.services.settlements.siteAt(p.pos)?.name ?? 'the road';
    const text = `${off.name || 'a stranger'} ${verbs[p.kind]} in ${place}`;
    for (const w of this.witnesses(p.pos, 32)) {
      if (w.e === off) continue;
      addMemory(w.st, { text, kind: 'crime', imp: imp[p.kind], t: h, about: okey, pos: [p.pos[0], p.pos[1], p.pos[2]] }, h);
      addDisp(w.st, okey, disp[p.kind] * (w.e === p.victim ? 1.5 : 1), verbs[p.kind], h);
      w.st.needs.safety = Math.min(w.st.needs.safety, 0.4);
      if (w.rec.job === 'guard' || (w.rec.job === 'bandit' && off.kind !== 'player')) {
        const repeat = (w.st.disp[okey]?.reasons.length ?? 0) > 1;
        if (p.kind === 'assault' || p.kind === 'murder' || repeat) {
          w.grudge.set(off.id, now + 90);
          w.threat = off.id;
          w.threatSince = now;
          w.thinkAt = now;
          this.bark(w, 'bark.guard.halt', {}, 'shout', true);
        } else this.bark(w, 'bark.guard.warn', {}, 'shout', true);
      } else if (w.lod === 0) this.bark(w, 'bark.crime', {}, 'shout');
    }
    // Settlement reputation for crimes is applied by the game master (crime bus handler).
  }

  private onDeath(p: ServerBusEvents['death']) {
    const ent = p.entity;
    const killer = p.killer;
    const l = this.byEntity.get(ent.id);
    const now = this.now();
    if (l) {
      l.diedAt = this.ctx.time.now;
      l.e.flags &= ~(EntFlag.Talkable | EntFlag.Merchant | EntFlag.Questgiver);
      l.e.speech = undefined;
      const by = killer ? (killer.kind === 'creature' ? `S:${killer.creature?.species ?? -1}` : this.keyOf(killer) ?? undefined) : undefined;
      const kname = killer ? (killer.kind === 'creature' ? `a ${this.speciesName(killer.creature?.species ?? -1)}` : (this.byEntity.get(killer.id)?.rec.given ?? killer.name) || 'someone') : '';
      const cause = killer ? `was killed by ${kname}` : 'died';
      if (l.camp) {
        const idx = l.camp.recs.indexOf(l.rec);
        if (idx >= 0 && !l.camp.dead.includes(idx)) l.camp.dead.push(idx);
        l.st.alive = false;
        if (l.camp.dead.length >= l.camp.size && !l.camp.cleared) this.clearCamp(l.camp.poi.id, by ?? 'unknown');
        return;
      }
      this.recordDeath(l.rec, l.st, cause, by);
      // Witnesses remember the killing.
      for (const w of this.witnesses(ent.pos, 30)) {
        if (w === l) continue;
        addMemory(w.st, { text: `${l.rec.given} ${cause} before ${w.rec.given}'s eyes`, kind: 'death', imp: 0.85, t: now, about: by }, now);
        w.st.needs.safety = 0.1;
      }
      if (killer?.kind === 'player' && l.rec.job !== 'bandit') this.ctx.bus.emit('crime', { offender: killer, victim: ent, kind: 'murder', pos: [ent.pos[0], ent.pos[1], ent.pos[2]] });
      if (killer?.kind === 'creature') {
        const sp = killer.creature?.species ?? -1;
        if (l.rec.siteId) this.spread(l.rec.siteId, { text: `a ${this.speciesName(sp)} killed ${l.rec.given} the ${JOB_NOUN[l.rec.job]}`, kind: 'monster', imp: 0.8, about: `S:${sp}` }, 0.8);
      }
      return;
    }
    // A creature slain near town: witnesses note who protected them.
    if (ent.kind === 'creature' && killer) {
      const hostile = (ent.flags & EntFlag.Hostile) !== 0;
      const cn = this.speciesName(ent.creature?.species ?? -1);
      const kkey = this.keyOf(killer);
      const kn = killer.kind === 'player' ? killer.name : this.byEntity.get(killer.id)?.rec.given ?? killer.name;
      for (const w of this.witnesses(ent.pos, 35)) {
        if (w.e === killer) continue;
        addMemory(w.st, { text: `${kn} slew a ${cn} near ${w.site?.site.name ?? 'the road'}`, kind: 'event', imp: hostile ? 0.5 : 0.25, t: now, about: kkey ?? undefined }, now);
        if (hostile && kkey && killer.kind === 'player') addDisp(w.st, kkey, 6, `drove off a ${cn}`, now);
        if (w.threat === ent.id) w.threat = null;
      }
    }
  }

  private onPlayerDied(player: ServerEntity, killer?: ServerEntity) {
    const now = this.now();
    for (const w of this.witnesses(player.pos, 30)) {
      const by = killer ? (killer.kind === 'creature' ? `a ${this.speciesName(killer.creature?.species ?? -1)}` : killer.name) : 'misfortune';
      addMemory(w.st, { text: `the stranger ${player.name} fell to ${by}`, kind: 'event', imp: 0.5, t: now, about: `P:${player.name}` }, now);
      w.grudge.delete(player.id);
      if (w.threat === player.id) w.threat = null;
    }
  }

  private onObjectDestroyed(p: ServerBusEvents['objectDestroyed']) {
    const isBuilding = typeof p.id === 'string' && p.id.startsWith('B:');
    if (!isBuilding && !/wall|door|house|building|roof|stall|fence/.test(p.kind)) return;
    let rt: SiteRt | null = null;
    for (const s of this.sites.values()) if (Math.hypot(p.pos[0] - s.site.x, p.pos[2] - s.site.z) < s.site.radius * 1.3) rt = s;
    if (!rt) return;
    const b = buildingAt(rt.layout.buildings, p.pos[0], p.pos[2]) ?? rt.layout.buildings.find((x) => typeof p.id === 'string' && p.id.includes(x.id)) ?? null;
    const what = b ? b.role.replace('_', ' ') : p.kind;
    const now = this.now();
    const src = p.source;
    const skey = this.keyOf(src);
    const who = src ? (src.kind === 'player' ? src.name : src.kind === 'creature' ? `a ${this.speciesName(src.creature?.species ?? -1)}` : src.name) : 'something';
    const text = `${who} wrecked the ${what} in ${rt.site.name}`;
    this.spread(rt.site.id, { text, kind: 'destroyed', imp: 0.6, about: skey ?? undefined, pos: [p.pos[0], p.pos[1], p.pos[2]] }, 0.6);
    if (b) {
      for (const rec of rt.recs) {
        const st = this.states.get(rec.id);
        if (!st || !st.alive) continue;
        const owner = rec.homeBuilding === b.id || rec.workBuilding === b.id;
        if (owner || rec.job === 'carpenter' || rec.job === 'mason') {
          st.flags[`ruined:${what}:${p.pos[0].toFixed(1)}:${p.pos[1].toFixed(1)}:${p.pos[2].toFixed(1)}`] = 1;
          st.nextGoalAt = Math.min(st.nextGoalAt, now + 1);
        }
        if (owner && skey?.startsWith('P:')) addDisp(st, skey, -30, `wrecked my ${what}`, now);
      }
    }
    if (src?.kind === 'player') {
      const k = `${src.id}::vandalism`;
      if (!this.crimeSeen.has(k)) this.ctx.bus.emit('crime', { offender: src, kind: 'vandalism', pos: p.pos });
    }
  }

  private onWeather(kind: string, intensity: number) {
    if (kind !== 'storm' && !(intensity > 0.75 && (kind === 'snow' || kind === 'ashfall' || kind === 'sporefall'))) return;
    const now = this.now();
    const words: Record<string, string> = { storm: 'a fierce storm', snow: 'a heavy snowfall', ashfall: 'choking ashfall', sporefall: 'a cloud of spores' };
    for (const rt of this.sites.values()) {
      if (!rt.active) continue;
      this.spread(rt.site.id, { text: `${words[kind] ?? 'foul weather'} swept over ${rt.site.name} on day ${this.ctx.time.day + 1}`, kind: 'weather', imp: 0.3 }, 0.8);
    }
    void now;
  }

  private onHour(hour: number) {
    // Dawn & dusk: a few NPCs near players comment.
    if (hour !== 6 && hour !== 19 && hour !== 22) return;
    const key = hour === 6 ? 'bark.morning' : hour === 19 ? 'bark.evening' : 'bark.night';
    for (const l of this.live.values()) if (l.lod === 0 && l.rng.chance(0.3)) this.bark(l, key);
  }

  private onEnterSite(player: ServerEntity, site: SiteInfo) {
    const rt = this.sites.get(site.id);
    if (!rt) return;
    // The nearest guard (or anyone) greets newcomers.
    let best: Live | null = null, bd = 40;
    for (const l of this.live.values()) {
      if (l.site !== rt || !l.e.alive) continue;
      const d = Math.hypot(l.e.pos[0] - player.pos[0], l.e.pos[2] - player.pos[2]);
      if (d < bd && (l.rec.job === 'guard' || d < 15)) (bd = d), (best = l);
    }
    if (best) {
      best.nearestPlayer = player;
      best.nearestDist = bd;
      const d = this.dispValue(best.rec, best.st, player);
      this.bark(best, d < -30 ? 'bark.guard.warn' : 'bark.greetPass', { addr: player.name }, 'say', true);
    }
  }

  // ================================================================== dialog bridge

  npcInfo(entityId: number): NpcDialogInfo | null {
    const l = this.byEntity.get(entityId);
    if (!l) return null;
    return {
      entity: l.e, rec: l.rec, st: l.st, site: l.site?.site ?? (l.rec.siteId ? this.site(l.rec.siteId) : null), layout: l.site?.layout ?? null,
      activity: l.act, activityLabel: ACTIVITY_LABEL[l.act], mood: moodOf(l.st, l.rec.traits, this.now()), deity: l.rec.deity ? this.gods.find((g) => g.id === l.rec.deity) ?? null : null,
      goal: this.activeGoal(l.st), now: this.now(), wanderer: l.wander ? l.wander.spec.kind : null,
    };
  }

  beginTalk(entityId: number, player: ServerEntity): void {
    const l = this.byEntity.get(entityId);
    if (!l) return;
    l.talkPlayer = player.id;
    l.thinkAt = 0;
    l.e.speech = undefined;
    l.st.talked[`P:${player.name}`] = this.now();
    this.think(l);
  }

  endTalk(entityId: number, player: ServerEntity): void {
    const l = this.byEntity.get(entityId);
    if (!l || l.talkPlayer !== player.id) return;
    l.talkPlayer = null;
    l.talkUntil = 0;
    l.talkMood = null;
    l.destKey = '';
    l.thinkAt = this.ctx.time.now + 1.5;
  }

  setTalking(entityId: number, talking: boolean, mood?: Mood): void {
    const l = this.byEntity.get(entityId);
    if (!l) return;
    l.talkUntil = talking ? this.ctx.time.now + 3.5 : 0;
    l.talkMood = mood ?? null;
    this.applyAnim(l, l.e.anim.move === 'walk' || l.e.anim.move === 'run' ? 'idle' : l.e.anim.move, l.e.anim.action, l.e.anim.lookAt);
  }

  gesture(entityId: number, anim: string, dur = 1.6): void {
    const l = this.byEntity.get(entityId);
    if (!l) return;
    l.e.anim = { ...l.e.anim, action: { id: anim, t0: this.ctx.time.now, dur } };
    l.nextAnimAt = this.ctx.time.now + dur + 1;
    l.e.dirty = true;
  }

  dispositionInfo(entityId: number, player: ServerEntity): { value: number; reasons: string[] } {
    const l = this.byEntity.get(entityId);
    if (!l) return { value: 0, reasons: [] };
    return { value: this.dispValue(l.rec, l.st, player), reasons: topReasons(l.st, `P:${player.name}`, 3).map((r) => r.r) };
  }

  people(entityId: number): NpcPerson[] {
    const l = this.byEntity.get(entityId);
    if (!l) return [];
    const out: NpcPerson[] = [];
    const add = (id: string, relation: string | null, affinity: number) => {
      if (out.some((p) => p.id === id) || id === l.rec.id) return;
      const rec = this.findRec(id);
      const st = this.states.get(id);
      if (!rec || !st) return;
      const ol = this.live.get(id);
      out.push({ id, name: rec.name, given: rec.given, job: JOB_NOUN[rec.job], relation, affinity, alive: st.alive, away: !!st.away, activity: st.away ? st.away.label : ol ? ACTIVITY_LABEL[ol.act] : 'at home' });
    };
    for (const [id, r] of Object.entries(l.rec.relations)) {
      const kind = (l.st.relKind[id] as RelationKind) ?? r.kind;
      const rec = this.findRec(id);
      add(id, rec ? RELATION_WORD[kind](rec.gender) : kind, clamp(r.affinity + (l.st.rel[id] ?? 0), -100, 100));
    }
    // Notable townsfolk everyone knows.
    if (l.site) {
      for (const rec of l.site.recs) {
        if (rec.leader || rec.captain || rec.job === 'innkeeper' || rec.job === 'priest' || rec.job === 'smith' || rec.job === 'healer') add(rec.id, null, l.st.rel[rec.id] ?? 0);
        if (out.length > 14) break;
      }
    }
    return out;
  }

  rumors(entityId: number, n: number): Memory[] {
    const l = this.byEntity.get(entityId);
    if (!l) return [];
    const now = this.now();
    const out: Memory[] = [];
    const skip = new Set<string>();
    for (let i = 0; i < n; i++) {
      const m = juiciest(l.st, now, (x) => skip.has(x.id));
      if (!m) break;
      skip.add(m.id);
      out.push(m);
    }
    for (const g of this.globalRumors) if (out.length < n && !skip.has(g.id)) out.push(g);
    return out;
  }

  told(entityId: number, memoryId2: string): void {
    const l = this.byEntity.get(entityId);
    const m = l?.st.mem.find((x) => x.id === memoryId2);
    if (m) m.told = (m.told ?? 0) + 1;
  }

  setPriceModifier(entityId: number, player: ServerEntity, mult: number): void {
    const l = this.byEntity.get(entityId);
    if (l) l.st.price[`P:${player.name}`] = clamp(mult, 0.6, 1.5);
  }

  rememberPlayer(entityId: number, player: ServerEntity, text: string, kind: Memory['kind'], importance: number): void {
    const l = this.byEntity.get(entityId);
    if (!l) return;
    addMemory(l.st, { text, kind, imp: importance, t: this.now(), about: `P:${player.name}` }, this.now());
  }

  landmarks(entityId: number): { id: string; name: string; kind: string; pos: Vec3 }[] {
    const l = this.byEntity.get(entityId);
    if (!l) return [];
    const out: { id: string; name: string; kind: string; pos: Vec3 }[] = [];
    const here = l.e.pos;
    if (l.site) {
      const seen = new Set<string>();
      const NICE: Record<string, string> = {
        tavern: 'the tavern', smithy: 'the smithy', market: 'the market', temple: 'the temple', shrine: 'the shrine', barracks: 'the barracks', library: 'the library',
        mage_tower: "the mage's tower", hall: 'the great hall', stable: 'the stables', mill: 'the mill', warehouse: 'the warehouse', workshop: 'the workshop', watchtower: 'the watchtower',
      };
      let inn: string | null = null;
      try {
        inn = siteLore(this.ctx.gen.profile, l.site.site).inn;
      } catch {
        inn = null;
      }
      for (const b of l.site.layout.buildings) {
        const nm = b.role === 'tavern' && inn ? `${inn} (the tavern)` : NICE[b.role];
        if (!nm || seen.has(b.role)) continue;
        seen.add(b.role);
        out.push({ id: b.id, name: nm, kind: b.role, pos: b.doors[0] ?? b.pos });
      }
    }
    for (const s of this.ctx.gen.sites.sitesNear(here[0], here[2], 1800)) {
      if (l.site && s.id === l.site.site.id) continue;
      out.push({ id: s.id, name: s.name, kind: s.size, pos: [s.x, s.plateau, s.z] });
    }
    for (const p of this.pois(here[0], here[2], 1000)) out.push({ id: p.id, name: `the ${poiName(p.kind)}`, kind: p.kind, pos: [p.x, p.y, p.z] });
    return out;
  }

  creaturesNear(entityId: number): string[] {
    const l = this.byEntity.get(entityId);
    if (!l) return [];
    const names = new Set<string>();
    for (const m of l.st.mem) if (m.about?.startsWith('S:')) names.add(this.speciesName(Number(m.about.slice(2))));
    const c = l.site ? [l.site.site.x, l.site.site.plateau, l.site.site.z] as Vec3 : l.e.pos;
    for (const x of this.ctx.entities.near(c, (l.site?.site.radius ?? 40) + 150, (x) => x.kind === 'creature' && x.alive)) {
      names.add(this.speciesName(x.creature?.species ?? -1));
      if (names.size > 5) break;
    }
    return [...names];
  }

  worldFacts(entityId: number): Record<string, string> {
    const l = this.byEntity.get(entityId);
    const h = this.ctx.time.hour;
    const facts: Record<string, string> = {
      time: h < 5 ? 'deep night' : h < 8 ? 'early morning' : h < 12 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : h < 21 ? 'evening' : 'night',
      day: String(this.ctx.time.day + 1), weather: `${this.ctx.weather.kind}${this.ctx.weather.intensity > 0.6 ? ' (heavy)' : ''}`, world: this.ctx.gen.profile.name,
      gods: this.gods.map((g) => `${g.name}, ${g.epithet} (${g.domain})`).join('; '),
    };
    if (l?.site) {
      const s = l.site.site;
      facts.place = `${s.name}, a ${RACE_ADJ[s.race as RaceId] ?? s.race} ${s.size}${s.race2 ? ` with many ${RACE_ADJ[s.race2 as RaceId] ?? s.race2} folk` : ''} in ${BIOMES[s.biome]?.name ?? 'the wilds'}`;
      const leader = l.site.recs.find((r) => r.leader);
      if (leader) facts.leader = `${leader.name} (${leader.title})`;
      facts.population = String(l.site.recs.length);
      facts.neighbours = this.linked(s.id).map((x) => x.name).join(', ');
    }
    return facts;
  }

  // ================================================================== messages

  onMessage(_player: ServerEntity, _msg: ClientMessage): boolean {
    // Talk/interact are routed to the dialog system (which calls back into this bridge).
    return false;
  }

  // ================================================================== persistence

  save(): SavedData {
    for (const l of this.live.values()) {
      l.st.pos = [l.e.pos[0], l.e.pos[1], l.e.pos[2]];
      l.st.coins = l.e.inventory?.coins ?? l.st.coins;
    }
    const sites: SavedData['sites'] = { ...this.savedSites };
    for (const rt of this.sites.values()) sites[rt.site.id] = { synthetic: rt.synthetic, flags: rt.flags, lastSim: rt.active ? this.now() : rt.lastSim };
    const states: Record<string, NpcState> = {};
    for (const [id, st] of this.states) if (!id.startsWith('W:')) states[id] = st;
    const camps: SavedData['camps'] = { ...this.savedCamps };
    for (const c of this.camps.values()) camps[c.poi.id] = { dead: c.dead, cleared: c.cleared };
    const wanderers: SavedData['wanderers'] = [...this.pendingWanderers];
    for (const w of this.wanderers.values()) {
      const l = this.live.get(w.rec.id);
      const st = this.states.get(w.rec.id);
      if (!l || !st || !st.alive || w.spec.camp) continue;
      wanderers.push({ kind: w.spec.kind, seed: w.spec.seed, pos: [l.e.pos[0], l.e.pos[1], l.e.pos[2]], index: w.spec.index ?? 0, races: w.spec.races, origin: w.spec.origin, leader: w.leader, st });
    }
    const quests: SavedData['quests'] = {};
    for (const [k, v] of this.quests) quests[k] = v;
    return { v: 1, sites, states, camps, wanderers, quests, rumors: this.globalRumors };
  }

  load(data: unknown): void {
    const d = data as Partial<SavedData>;
    if (!d || d.v !== 1) return;
    this.savedSites = d.sites ?? {};
    this.savedCamps = d.camps ?? {};
    for (const [id, st] of Object.entries(d.states ?? {})) this.states.set(id, st);
    for (const [k, v] of Object.entries(d.quests ?? {})) this.quests.set(k, v);
    this.globalRumors = d.rumors ?? [];
    this.pendingWanderers = d.wanderers ?? [];
  }

  // ================================================================== debug / tools

  /** Snapshot of a loaded site for tools & sandboxes. */
  debugSite(siteId: string): { site: SiteInfo; synthetic: boolean; people: { rec: NpcRecord; st: NpcState; act: string; pos: Vec3 | null }[] } | null {
    const rt = this.loadSite(siteId);
    if (!rt) return null;
    return {
      site: rt.site, synthetic: rt.synthetic,
      people: rt.recs.map((rec) => {
        const l = this.live.get(rec.id);
        const st = this.states.get(rec.id)!;
        return { rec, st, act: st.away ? `away: ${st.away.label}` : l ? ACTIVITY_LABEL[l.act] : 'off-screen', pos: l ? [l.e.pos[0], l.e.pos[1], l.e.pos[2]] : null };
      }),
    };
  }

  /** Live NPC count (perf/debug). */
  liveCount(): number {
    return this.live.size;
  }
}
