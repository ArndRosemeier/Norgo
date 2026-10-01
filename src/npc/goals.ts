/**
 * Long-term NPC goals ("agendas"). Each goal kind declares the facts it wants,
 * a set of GOAP actions with personality-dependent costs, how each action
 * expands into executable tasks, what its effects do to the world/NPC minds,
 * and how a player can be asked to help (QuestSpec for the game master).
 *
 * Goals are proposed from circumstances: a smith out of ore, a farmer whose
 * goats were taken by a predator, a guard captain with a bandit camp nearby, a
 * lovesick baker, a debtor, a scholar intrigued by a ruin, a widow avenging her
 * husband... Outcomes create memories that spread by gossip, change
 * relationships and can kill or injure NPCs — so the town's story evolves.
 */
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import type { Vec3 } from '../shared/types';
import type { SiteInfo, PoiInfo, PoiKind } from '../world/sites';
import type { SettlementLayout, BuildingRole } from '../settlements/types';
import type { QuestSpec } from '../gm/types';
import type { NpcJob } from './types';
import type { NpcRecord } from './population';
import type { Goal, Memory, NpcState, Task } from './mind';
import { plan, type Facts, type PlanAction } from './planner';
import { JOBS, GOODS_NAME, GOODS_ITEM, type GoalKind } from './jobs';
import { JOB_NOUN } from './culture';

export interface NpcRef {
  rec: NpcRecord;
  st: NpcState;
}

/** Everything goals need from the NPC system (implemented by NpcSystem). */
export interface GoalHost {
  now(): number;
  metersPerHour: number;
  rng(...tag: (string | number)[]): Rng;
  layout(siteId: string): SettlementLayout | null;
  site(siteId: string): SiteInfo | null;
  linked(siteId: string): SiteInfo[];
  pois(x: number, z: number, r: number): PoiInfo[];
  /** Bandit strength of a camp POI (0 = cleared). */
  campStrength(poiId: string): number;
  clearCamp(poiId: string, by: string): void;
  ref(recId: string): NpcRef | undefined;
  residents(siteId: string): NpcRef[];
  remember(recId: string, m: Omit<Memory, 'id' | 't'>): void;
  /** Spread a memory to a fraction of a settlement (news, announcements). */
  spread(siteId: string, m: Omit<Memory, 'id' | 't'>, fraction: number): void;
  adjustRel(a: string, b: string, delta: number): void;
  setRelKind(a: string, b: string, kind: string): void;
  kill(recId: string, cause: string, by?: string): void;
  injure(recId: string, amount: number): void;
  speciesFor(siteId: string, role: string): number[];
  speciesName(n: number): string;
  setSiteFlag(siteId: string, flag: string, hours: number): void;
  siteFlag(siteId: string, flag: string): boolean;
  bark(recId: string, key: string, vars?: Record<string, string>): void;
  /** Compass phrasing "north-east" + distance phrase between two points. */
  describeWay(from: Vec3, to: Vec3): { dir: string; dist: string };
  outskirts(rec: NpcRecord, kind: 'fields' | 'woods' | 'mine' | 'shore' | 'pasture' | 'wilds'): Vec3;
  /** Entity id of a spawned NPC, if any. */
  entityOf(recId: string): number | undefined;
}

export interface GoalCtx {
  n: NpcRef;
  g: Goal;
  h: GoalHost;
}

interface GoalDef {
  kind: GoalKind;
  want: Facts;
  actions: PlanAction<GoalCtx>[];
  facts(c: GoalCtx): Facts;
  tasks(action: string, c: GoalCtx): Task[];
  effect(fx: string, c: GoalCtx): boolean;
  quest?(c: GoalCtx, giverId: number | undefined, playerName: string): QuestSpec | null;
  /** Called when a player's quest for this goal completes. */
  questDone?(c: GoalCtx, playerName: string): void;
  /** Called when the goal ultimately fails. */
  failed?(c: GoalCtx): void;
}

// ------------------------------------------------------------------ helpers

const T = (c: GoalCtx) => c.n.rec.traits;
const name = (c: GoalCtx) => c.n.rec.given;
const site = (c: GoalCtx) => c.n.rec.siteId ?? '';

function homePos(c: GoalCtx): Vec3 {
  return c.n.rec.bed;
}

function plazaPos(c: GoalCtx): Vec3 {
  const l = c.n.rec.siteId ? c.h.layout(c.n.rec.siteId) : null;
  return l ? l.plaza : c.n.rec.work;
}

function buildingPos(c: GoalCtx, roles: BuildingRole[]): Vec3 | null {
  const l = c.n.rec.siteId ? c.h.layout(c.n.rec.siteId) : null;
  const b = l?.buildings.find((x) => roles.includes(x.role));
  if (!b) return null;
  return b.doors[0] ?? b.pos;
}

function travelHours(c: GoalCtx, to: Vec3): number {
  const from = c.n.rec.work;
  return Math.hypot(to[0] - from[0], to[2] - from[2]) / c.h.metersPerHour;
}

function sitePos(s: SiteInfo): Vec3 {
  return [s.x, s.plateau, s.z];
}

function nearestCamp(c: GoalCtx, r = 1100): PoiInfo | null {
  const s = c.n.rec.siteId ? c.h.site(c.n.rec.siteId) : null;
  if (!s) return null;
  let best: PoiInfo | null = null, bd = Infinity;
  for (const p of c.h.pois(s.x, s.z, r)) {
    if (p.kind !== 'camp' || c.h.campStrength(p.id) <= 0) continue;
    const d = Math.hypot(p.x - s.x, p.z - s.z);
    if (d < bd) (bd = d), (best = p);
  }
  return best;
}

/** Who in town produces a good. */
function supplierOf(c: GoalCtx, good: string): NpcRef | null {
  if (!c.n.rec.siteId) return null;
  for (const r of c.h.residents(c.n.rec.siteId)) {
    if (r === c.n || !r.st.alive || r.st.away) continue;
    if (JOBS[r.rec.job].produces?.includes(good)) return r;
  }
  return null;
}

const GATHER: Record<string, { at: 'woods' | 'mine' | 'wilds' | 'fields' | 'shore'; anim: string }> = {
  ore: { at: 'mine', anim: 'mine' }, stone: { at: 'mine', anim: 'mine' }, charcoal: { at: 'woods', anim: 'chop' }, timber: { at: 'woods', anim: 'chop' },
  herbs: { at: 'wilds', anim: 'harvest' }, reagents: { at: 'wilds', anim: 'harvest' }, meat: { at: 'wilds', anim: 'shoot_bow' }, hides: { at: 'wilds', anim: 'shoot_bow' },
  grain: { at: 'fields', anim: 'harvest' }, wool: { at: 'fields', anim: 'harvest' }, fish: { at: 'shore', anim: 'throw' },
};

function reward(c: GoalCtx, base: number): QuestSpec['rewards'] {
  const t = T(c);
  const coins = Math.max(5, Math.round(base * (0.6 + c.n.rec.wealth) * (1 - t.greed * 0.3)));
  return { coins, reputation: c.n.rec.siteId ? { [`site.${c.n.rec.siteId}`]: 5 } : undefined, text: `${name(c)}'s gratitude` };
}

function questBase(c: GoalCtx, giverId: number | undefined, title: string, summary: string): Pick<QuestSpec, 'title' | 'summary' | 'giver' | 'giverId' | 'source' | 'meta'> {
  return { title, summary, giver: c.n.rec.name, giverId, source: 'npc', meta: { npc: c.n.rec.id, goal: c.g.id, kind: c.g.kind } };
}

/** Standard "ask a passing adventurer" action: posting a request is slow but safe. */
function askHelp(eff: Facts, base: number, pre: Facts = {}): PlanAction<GoalCtx> {
  return {
    id: 'askHelp', pre, eff,
    cost: (c) => base + T(c).courage * 0.8 + T(c).conscientiousness * 0.4 - T(c).extraversion * 0.3 - T(c).neuroticism * 0.5,
  };
}

function remember(c: GoalCtx, text: string, kind: Memory['kind'], imp: number, about?: string) {
  c.h.remember(c.n.rec.id, { text, kind, imp, about });
}

function news(c: GoalCtx, text: string, kind: Memory['kind'], imp: number, fraction: number, about?: string) {
  if (c.n.rec.siteId) c.h.spread(c.n.rec.siteId, { text, kind, imp, about, from: c.n.rec.id }, fraction);
}

// ------------------------------------------------------------------ goal library

const restock: GoalDef = {
  kind: 'restock',
  want: { stocked: 1 },
  facts(c) {
    const good = String(c.g.data.good);
    const need = Number(c.g.data.need);
    const cost = Number(c.g.data.cost);
    return {
      stocked: (c.n.st.stock[good] ?? 0) >= need ? 1 : 0,
      rich: c.n.st.coins >= cost ? 1 : 0,
      supplier: supplierOf(c, good) ? 1 : 0,
      gatherable: GATHER[good] ? 1 : 0,
      linked: c.h.linked(site(c)).length ? 1 : 0,
    };
  },
  actions: [
    { id: 'buyLocal', pre: { supplier: 1, rich: 1 }, eff: { stocked: 1 }, cost: (c) => 1 + T(c).greed * 1.2 },
    { id: 'gather', pre: { gatherable: 1 }, eff: { stocked: 1 }, cost: (c) => 3 - T(c).courage - T(c).conscientiousness * 0.5 },
    { id: 'fetch', pre: { linked: 1, rich: 1 }, eff: { stocked: 1 }, cost: (c) => 4.5 + T(c).neuroticism - T(c).openness * 0.6 },
    { id: 'earn', pre: {}, not: ['rich'], eff: { rich: 1 }, cost: () => 3 },
    askHelp({ stocked: 1 }, 2.6),
  ],
  tasks(a, c) {
    const good = String(c.g.data.good);
    const gn = GOODS_NAME[good] ?? good;
    switch (a) {
      case 'buyLocal': {
        const s = supplierOf(c, good);
        return [{ k: 'goto', to: s ? s.rec.work : plazaPos(c), label: `buying ${gn}` }, { k: 'work', anims: ['talk', 'gesture_point'], hours: 0.4, label: `haggling for ${gn}` }, { k: 'effect', fx: 'buy', label: `bought ${gn}` }];
      }
      case 'gather': {
        const g = GATHER[good];
        const at = c.h.outskirts(c.n.rec, g.at === 'fields' ? 'fields' : g.at);
        return [{ k: 'goto', to: at, label: `heading out for ${gn}` }, { k: 'work', anims: [g.anim, 'pickup'], hours: 2.5, label: `gathering ${gn}`, at }, { k: 'effect', fx: 'gathered', label: `gathered ${gn}` }, { k: 'goto', to: c.n.rec.work, label: 'returning' }];
      }
      case 'fetch': {
        const dest = c.h.rng('fetch', c.g.id).pick(c.h.linked(site(c)));
        return [{ k: 'travel', to: sitePos(dest), site: dest.id, hours: travelHours(c, sitePos(dest)) * 2 + 2, label: `fetching ${gn} from ${dest.name}` }, { k: 'effect', fx: 'fetched', label: `returned with ${gn}` }];
      }
      case 'earn':
        return [{ k: 'work', anims: JOBS[c.n.rec.job].workAnims, hours: 4, label: 'working extra hours', at: c.n.rec.work }, { k: 'effect', fx: 'earn', label: 'earned coin' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 36, label: `hoping someone brings ${gn}` }];
    }
    return [];
  },
  effect(fx, c) {
    const good = String(c.g.data.good);
    const need = Number(c.g.data.need);
    const gn = GOODS_NAME[good] ?? good;
    const st = c.n.st;
    switch (fx) {
      case 'buy': {
        const s = supplierOf(c, good);
        const cost = Number(c.g.data.cost);
        if (!s || st.coins < cost) return false;
        st.coins -= cost;
        s.st.coins += cost;
        st.stock[good] = (st.stock[good] ?? 0) + need;
        c.h.adjustRel(c.n.rec.id, s.rec.id, 3);
        return true;
      }
      case 'gathered': {
        const rng = c.h.rng('gather', c.g.id, c.g.taskIdx);
        // Danger in the wilds: the timid or unlucky can come back hurt.
        if (rng.chance(0.12 - T(c).courage * 0.05)) {
          c.h.injure(c.n.rec.id, rng.range(0.2, 0.5));
          remember(c, `${name(c)} was hurt while gathering ${gn} outside ${c.h.site(site(c))?.name ?? 'town'}`, 'personal', 0.55, c.n.rec.id);
          news(c, `${name(c)} the ${JOB_NOUN[c.n.rec.job]} came back from the wilds bruised and bleeding`, 'event', 0.45, 0.3, c.n.rec.id);
          return false;
        }
        st.stock[good] = (st.stock[good] ?? 0) + need;
        return true;
      }
      case 'fetched': {
        const cost = Number(c.g.data.cost);
        st.coins = Math.max(0, st.coins - cost);
        st.stock[good] = (st.stock[good] ?? 0) + need + 1;
        return true;
      }
      case 'earn':
        st.coins += Math.round(8 + c.n.rec.wealth * 20);
        return true;
    }
    return false;
  },
  quest(c, giverId, _player) {
    const good = String(c.g.data.good);
    const item = GOODS_ITEM[good];
    if (!item) return null;
    const gn = GOODS_NAME[good] ?? good;
    const count = Number(c.g.data.need);
    const objectives: QuestSpec['objectives'] = [{ kind: 'collect', text: `Gather ${count} ${gn}`, itemDef: item, count }];
    if (giverId !== undefined) objectives.push({ kind: 'deliver', text: `Bring the ${gn} to ${name(c)}`, itemDef: item, count, toNpc: giverId });
    return { ...questBase(c, giverId, `${cap(gn)} for ${name(c)}`, `${c.n.rec.name}, ${JOB_NOUN[c.n.rec.job]} of ${c.h.site(site(c))?.name ?? 'the road'}, needs ${count} ${gn} to keep working.`), objectives, rewards: reward(c, 30 + count * 6) };
  },
  questDone(c) {
    const good = String(c.g.data.good);
    c.n.st.stock[good] = (c.n.st.stock[good] ?? 0) + Number(c.g.data.need);
  },
};

const tradeRun: GoalDef = {
  kind: 'tradeRun',
  want: { profit: 1 },
  facts(c) {
    const dest = c.h.site(String(c.g.data.dest));
    return {
      goods: (c.n.st.stock.goods ?? 0) >= 3 ? 1 : 0,
      dest: dest ? 1 : 0,
      safe: Number(c.g.data.danger) < 0.35 || T(c).courage > 0.5 ? 1 : 0,
      escort: c.n.st.flags.escort ? 1 : 0,
      rich: c.n.st.coins >= 25 ? 1 : 0,
    };
  },
  actions: [
    { id: 'buyGoods', pre: { rich: 1 }, eff: { goods: 1 }, cost: () => 1 },
    { id: 'hireGuard', pre: { rich: 1 }, eff: { escort: 1 }, cost: (c) => 1.5 + T(c).greed * 2 },
    { id: 'travel', pre: { goods: 1, dest: 1, safe: 1 }, eff: { profit: 1 }, cost: () => 3 },
    { id: 'travelEscorted', pre: { goods: 1, dest: 1, escort: 1 }, eff: { profit: 1 }, cost: () => 3.4 },
    { id: 'sellLocal', pre: { goods: 1 }, eff: { profit: 1 }, cost: (c) => 6 - T(c).neuroticism * 2 },
    askHelp({ escort: 1 }, 2.4, { goods: 1 }),
  ],
  tasks(a, c) {
    const dest = c.h.site(String(c.g.data.dest));
    switch (a) {
      case 'buyGoods':
        return [{ k: 'goto', to: c.n.rec.work, label: 'stocking the wagon' }, { k: 'work', anims: ['pickup', 'gesture_point'], hours: 1, label: 'loading goods', at: c.n.rec.work }, { k: 'effect', fx: 'buyGoods', label: 'loaded goods' }];
      case 'hireGuard':
        return [{ k: 'goto', to: buildingPos(c, ['barracks', 'watchtower', 'tavern']) ?? plazaPos(c), label: 'looking for a sellsword' }, { k: 'work', anims: ['talk'], hours: 0.5, label: 'hiring a guard' }, { k: 'effect', fx: 'hire', label: 'hired a guard' }];
      case 'travel':
      case 'travelEscorted':
        if (!dest) return [];
        return [{ k: 'travel', to: sitePos(dest), site: dest.id, hours: travelHours(c, sitePos(dest)) * 2 + 3, label: `on a trade run to ${dest.name}` }, { k: 'effect', fx: a === 'travel' ? 'arrive' : 'arriveSafe', label: 'back from the road' }];
      case 'sellLocal':
        return [{ k: 'goto', to: plazaPos(c), label: 'hawking wares' }, { k: 'work', anims: ['gesture_wave', 'talk'], hours: 3, label: 'selling at the market', at: plazaPos(c) }, { k: 'effect', fx: 'sellLocal', label: 'sold goods' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 30, label: 'looking for an escort' }];
    }
    return [];
  },
  effect(fx, c) {
    const st = c.n.st;
    const dest = c.h.site(String(c.g.data.dest));
    const rng = c.h.rng('trade', c.g.id, fx);
    switch (fx) {
      case 'buyGoods':
        st.coins -= 20;
        st.stock.goods = (st.stock.goods ?? 0) + 4;
        return true;
      case 'hire':
        st.coins -= 15;
        st.flags.escort = 1;
        return true;
      case 'arrive':
      case 'arriveSafe': {
        const danger = Number(c.g.data.danger) * (fx === 'arriveSafe' ? 0.3 : 1);
        delete st.flags.escort;
        if (rng.chance(danger)) {
          st.stock.goods = 0;
          st.coins = Math.max(0, st.coins - rng.int(5, 30));
          c.h.injure(c.n.rec.id, rng.range(0.2, 0.6));
          const t = `bandits robbed ${c.n.rec.given} on the road to ${dest?.name ?? 'the next town'}`;
          remember(c, t, 'crime', 0.85);
          news(c, t, 'crime', 0.75, 0.6, c.n.rec.id);
          c.h.bark(c.n.rec.id, 'bark.hurt');
          return false;
        }
        const profit = Math.round((st.stock.goods ?? 0) * rng.range(6, 14) * (1 + T(c).greed * 0.3));
        st.stock.goods = 0;
        st.coins += profit;
        st.needs.wealth = clamp(st.needs.wealth + 0.15, 0, 1);
        if (dest) {
          remember(c, `${dest.name}'s market paid well for ${c.n.rec.given}'s goods`, 'travel', 0.4);
          news(c, `${c.n.rec.given} the ${JOB_NOUN[c.n.rec.job]} is back from ${dest.name} with full purses and fresh news`, 'trade', 0.35, 0.35, c.n.rec.id);
        }
        return true;
      }
      case 'sellLocal':
        st.coins += Math.round((st.stock.goods ?? 0) * rng.range(3, 7));
        st.stock.goods = 0;
        return true;
    }
    return false;
  },
  quest(c, giverId) {
    const dest = c.h.site(String(c.g.data.dest));
    if (!dest) return null;
    const camp = nearestCamp(c, 1400);
    const objectives: QuestSpec['objectives'] = [];
    if (camp) objectives.push({ kind: 'kill', text: `Thin out the bandits threatening the road`, faction: 'hostile', tag: 'bandit', count: 3, pos: [camp.x, camp.y, camp.z] });
    objectives.push({ kind: 'goto', text: `Scout the road to ${dest.name}`, pos: sitePos(dest), radius: dest.radius });
    if (giverId !== undefined) objectives.push({ kind: 'talk', text: `Report back to ${name(c)}`, npc: giverId });
    return { ...questBase(c, giverId, `Safe Road to ${dest.name}`, `${c.n.rec.name} wants to haul goods to ${dest.name}, but the road is said to be dangerous.`), objectives, rewards: reward(c, 45) };
  },
  questDone(c) {
    c.n.st.flags.escort = 1;
    c.g.data.danger = 0;
  },
};

const hunt: GoalDef = {
  kind: 'hunt',
  want: { prey: 1 },
  facts(c) {
    return { tracked: c.g.data.tracked ? 1 : 0, prey: c.g.data.done ? 1 : 0, dangerous: c.g.data.role === 'predator' ? 1 : 0, bold: T(c).courage > -0.2 ? 1 : 0 };
  },
  actions: [
    { id: 'track', pre: {}, eff: { tracked: 1 }, cost: () => 1 },
    { id: 'stalk', pre: { tracked: 1, bold: 1 }, eff: { prey: 1 }, cost: (c) => 2 - T(c).courage },
    { id: 'traps', pre: { tracked: 1 }, eff: { prey: 1 }, cost: (c) => 3.5 + T(c).extraversion * 0.5 - T(c).conscientiousness },
    askHelp({ prey: 1 }, 3.2, { tracked: 1 }),
  ],
  tasks(a, c) {
    const wilds = c.h.outskirts(c.n.rec, 'wilds');
    const cn = String(c.g.data.creatureName);
    switch (a) {
      case 'track':
        return [{ k: 'goto', to: wilds, label: `tracking the ${cn}` }, { k: 'work', anims: ['harvest', 'pickup'], hours: 1, label: 'reading tracks', at: wilds }, { k: 'effect', fx: 'tracked', label: 'found the trail' }];
      case 'stalk':
        return [{ k: 'hunt', hours: 3, label: `hunting the ${cn}`, at: wilds }, { k: 'effect', fx: 'kill', label: `brought down the ${cn}` }, { k: 'goto', to: c.n.rec.work, label: 'hauling the kill home' }];
      case 'traps':
        return [{ k: 'work', anims: ['work_hammer', 'pickup'], hours: 2, label: 'setting snares', at: wilds }, { k: 'effect', fx: 'trap', label: 'checked the snares' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 30, label: `looking for someone to hunt the ${cn}` }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('hunt', c.g.id, fx);
    const cn = String(c.g.data.creatureName);
    switch (fx) {
      case 'tracked':
        c.g.data.tracked = 1;
        return true;
      case 'kill':
      case 'trap': {
        if (c.g.data.done) return true; // killed physically during the hunt
        const skill = JOBS[c.n.rec.job].combat + T(c).courage * 0.15 - (c.g.data.role === 'predator' ? 0.25 : 0);
        if (!rng.chance(clamp(0.35 + skill * 0.5 + (fx === 'trap' ? 0.1 : 0), 0.1, 0.92))) {
          if (c.g.data.role === 'predator' && rng.chance(0.3)) {
            c.h.injure(c.n.rec.id, rng.range(0.3, 0.7));
            const t = `a ${cn} mauled ${c.n.rec.given} the ${JOB_NOUN[c.n.rec.job]} in the wilds`;
            remember(c, t, 'monster', 0.8, `S:${c.g.data.species}`);
            news(c, t, 'monster', 0.7, 0.5, `S:${c.g.data.species}`);
          }
          return false;
        }
        c.g.data.done = 1;
        c.n.st.stock.meat = (c.n.st.stock.meat ?? 0) + rng.int(2, 5);
        c.n.st.stock.hides = (c.n.st.stock.hides ?? 0) + rng.int(1, 2);
        const t = `${c.n.rec.given} brought down a ${cn} near ${c.h.site(site(c))?.name ?? 'the camp'}`;
        remember(c, t, 'event', 0.5);
        news(c, t, 'event', c.g.data.role === 'predator' ? 0.6 : 0.3, 0.4);
        if (c.g.data.role === 'predator' && c.n.rec.siteId) c.h.setSiteFlag(c.n.rec.siteId, `threat:${c.g.data.species}`, 0);
        return true;
      }
    }
    return false;
  },
  quest(c, giverId) {
    const sp = Number(c.g.data.species);
    const cn = String(c.g.data.creatureName);
    const wilds = c.h.outskirts(c.n.rec, 'wilds');
    const count = c.g.data.role === 'predator' ? 1 + (Number(c.g.data.pack) || 1) : 3;
    const obj: QuestSpec['objectives'] = [{ kind: 'kill', text: `Slay ${count} ${cn}${count > 1 ? 's' : ''}`, species: Number.isFinite(sp) && sp >= 0 ? sp : undefined, count, pos: wilds }];
    if (giverId !== undefined) obj.push({ kind: 'talk', text: `Tell ${name(c)} the deed is done`, npc: giverId });
    return { ...questBase(c, giverId, `The ${cap(cn)} Hunt`, `${c.n.rec.name} has been tracking a ${cn} that troubles ${c.h.site(site(c))?.name ?? 'these lands'}.`), objectives: obj, rewards: reward(c, 40 + count * 10) };
  },
  questDone(c) {
    c.g.data.done = 1;
    if (c.n.rec.siteId) c.h.setSiteFlag(c.n.rec.siteId, `threat:${c.g.data.species}`, 0);
  },
};

const DISCOVERY: Partial<Record<PoiKind, string[]>> = {
  ruin: ['carvings older than any kingdom', 'a sealed vault beneath the rubble', 'a mural of a forgotten coronation'],
  shrine: ['offerings left by unknown hands', 'a prayer to a god no one remembers', 'an altar still warm to the touch'],
  camp: ['tracks of many armed men', 'a map with our roads marked in red'],
  lair: ['bones gnawed clean', 'a nest bigger than a cart'],
  grove: ['flowers that turn to follow passers-by', 'a ring of trees humming at dusk'],
  monolith: ['runes that glow under the second moon', 'a stone that is warm in winter'],
  tower: ['an astrolabe still turning', 'a wizard\'s journal with half its pages burned'],
  battlefield: ['banners of a war no song recalls', 'arrowheads of a metal no smith can name'],
  crashsite: ['metal that sings when struck', 'glassy craters still smoking'],
  well: ['echoes that answer back', 'water that tastes of iron and stars'],
  wayshrine: ['pilgrim marks from distant lands', 'a lantern that never goes out'],
  obelisk: ['a star chart cut into the stone', 'a hum that sets teeth on edge'],
};

const investigate: GoalDef = {
  kind: 'investigate',
  want: { studied: 1 },
  facts(c) {
    return {
      notes: c.g.data.notes ? 1 : 0, studied: c.g.data.done ? 1 : 0, brave: T(c).courage > -0.1 || Number(c.g.data.danger) < 0.3 ? 1 : 0,
      library: buildingPos(c, ['library', 'mage_tower', 'temple']) ? 1 : 0,
    };
  },
  actions: [
    { id: 'research', pre: { library: 1 }, eff: { notes: 1 }, cost: () => 1 },
    { id: 'ask', pre: {}, eff: { notes: 1 }, cost: (c) => 1.8 - T(c).extraversion * 0.6 },
    { id: 'expedition', pre: { notes: 1, brave: 1 }, eff: { studied: 1 }, cost: (c) => 2.5 + Number(c.g.data.danger) * 3 - T(c).courage },
    askHelp({ studied: 1 }, 2.5, { notes: 1 }),
  ],
  tasks(a, c) {
    const poiName = String(c.g.data.poiName);
    const at: Vec3 = [Number(c.g.data.x), Number(c.g.data.y), Number(c.g.data.z)];
    switch (a) {
      case 'research': {
        const lib = buildingPos(c, ['library', 'mage_tower', 'temple'])!;
        return [{ k: 'goto', to: lib, label: 'heading to the archives' }, { k: 'work', anims: ['channel', 'talk'], hours: 2, label: `reading about the ${poiName}`, at: lib }, { k: 'effect', fx: 'notes', label: 'took notes' }];
      }
      case 'ask':
        return [{ k: 'goto', to: buildingPos(c, ['tavern']) ?? plazaPos(c), label: 'asking around' }, { k: 'work', anims: ['talk', 'gesture_point'], hours: 1, label: `asking about the ${poiName}` }, { k: 'effect', fx: 'notes', label: 'heard stories' }];
      case 'expedition':
        return [{ k: 'travel', to: at, hours: travelHours(c, at) * 2 + 2, label: `investigating the ${poiName}` }, { k: 'effect', fx: 'study', label: `studied the ${poiName}` }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 40, label: `seeking someone to explore the ${poiName}` }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('study', c.g.id, fx);
    const kind = String(c.g.data.poiKind) as PoiKind;
    switch (fx) {
      case 'notes':
        c.g.data.notes = 1;
        return true;
      case 'study': {
        if (rng.chance(Number(c.g.data.danger) * 0.5)) {
          c.h.injure(c.n.rec.id, rng.range(0.2, 0.6));
          remember(c, `${c.n.rec.given} fled the ${c.g.data.poiName} with something on their heels`, 'personal', 0.6);
          news(c, `${c.n.rec.given} the ${JOB_NOUN[c.n.rec.job]} came back from the ${c.g.data.poiName} pale and shaking`, 'event', 0.55, 0.4);
          return false;
        }
        c.g.data.done = 1;
        const what = rng.pick(DISCOVERY[kind] ?? ['strange signs']);
        const t = `the ${c.g.data.poiName} ${c.g.data.way} holds ${what}`;
        remember(c, t, 'rumor', 0.7);
        news(c, t, 'rumor', 0.55, 0.45);
        return true;
      }
    }
    return false;
  },
  quest(c, giverId) {
    const at: Vec3 = [Number(c.g.data.x), Number(c.g.data.y), Number(c.g.data.z)];
    const obj: QuestSpec['objectives'] = [
      { kind: 'discover', text: `Find the ${c.g.data.poiName} ${c.g.data.way}`, poi: String(c.g.data.poi) },
      { kind: 'goto', text: `Search the ${c.g.data.poiName}`, pos: at, radius: 20 },
    ];
    if (giverId !== undefined) obj.push({ kind: 'talk', text: `Tell ${name(c)} what you found`, npc: giverId });
    return { ...questBase(c, giverId, `Secrets of the ${cap(String(c.g.data.poiName))}`, `${c.n.rec.name} wants to know what lies at the ${c.g.data.poiName} ${c.g.data.way}.`), objectives: obj, rewards: { ...reward(c, 35), xp: { lore: 60 } } };
  },
  questDone(c, player) {
    c.g.data.done = 1;
    const kind = String(c.g.data.poiKind) as PoiKind;
    const what = c.h.rng('studyq', c.g.id).pick(DISCOVERY[kind] ?? ['strange signs']);
    remember(c, `${player} found that the ${c.g.data.poiName} ${c.g.data.way} holds ${what}`, 'rumor', 0.7, `P:${player}`);
  },
};

const clearCamp: GoalDef = {
  kind: 'clearCamp',
  want: { cleared: 1 },
  facts(c) {
    const str = c.h.campStrength(String(c.g.data.poi));
    const guards = c.n.rec.siteId ? c.h.residents(c.n.rec.siteId).filter((r) => r.rec.job === 'guard' && r.st.alive && !r.st.away && r.st.injury < 0.5).length : 0;
    return { cleared: str <= 0 ? 1 : 0, mustered: c.g.data.mustered ? 1 : 0, guards: guards >= 2 ? 1 : 0, strong: guards * 0.8 + 0.5 >= str ? 1 : 0 };
  },
  actions: [
    { id: 'muster', pre: { guards: 1 }, eff: { mustered: 1 }, cost: () => 1 },
    { id: 'assault', pre: { mustered: 1, strong: 1 }, eff: { cleared: 1 }, cost: (c) => 3 - T(c).courage * 1.5 },
    { id: 'drill', pre: { guards: 1 }, eff: { strong: 1 }, cost: (c) => 3 + T(c).courage },
    askHelp({ cleared: 1 }, 2.2),
  ],
  tasks(a, c) {
    const at: Vec3 = [Number(c.g.data.x), Number(c.g.data.y), Number(c.g.data.z)];
    switch (a) {
      case 'muster': {
        const b = buildingPos(c, ['barracks', 'watchtower']) ?? plazaPos(c);
        return [{ k: 'goto', to: b, label: 'mustering the watch' }, { k: 'work', anims: ['gesture_point', 'talk', 'cheer'], hours: 0.75, label: 'rallying the guards', at: b }, { k: 'effect', fx: 'muster', label: 'the watch is ready' }];
      }
      case 'drill':
        return [{ k: 'work', anims: ['swing_1h', 'block', 'gesture_point'], hours: 3, label: 'drilling the watch', at: buildingPos(c, ['barracks']) ?? plazaPos(c) }, { k: 'effect', fx: 'drill', label: 'drilled' }];
      case 'assault':
        return [{ k: 'travel', to: at, hours: travelHours(c, at) * 2 + 1.5, label: 'leading an assault on the bandit camp' }, { k: 'effect', fx: 'assault', label: 'returned from the assault' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 48, label: 'posting a bounty on the bandits' }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('camp', c.g.id, fx);
    const poi = String(c.g.data.poi);
    switch (fx) {
      case 'muster':
        c.g.data.mustered = 1;
        news(c, `the watch is mustering to strike the bandit camp ${c.g.data.way}`, 'event', 0.5, 0.5);
        return true;
      case 'drill':
        c.g.data.drilled = Number(c.g.data.drilled ?? 0) + 1;
        return true;
      case 'assault': {
        const str = c.h.campStrength(poi);
        if (str <= 0) return true;
        const guards = c.n.rec.siteId ? c.h.residents(c.n.rec.siteId).filter((r) => r.rec.job === 'guard' && r.st.alive && !r.st.away) : [];
        const power = guards.length * 0.8 + Number(c.g.data.drilled ?? 0) * 0.5 + T(c).courage * 0.5;
        const win = rng.chance(clamp(0.3 + (power - str) * 0.15, 0.1, 0.9));
        // Battles cost lives: a guard may fall, win or lose.
        const victim = guards.length ? rng.pick(guards) : null;
        if (victim && rng.chance(win ? 0.25 : 0.55)) c.h.kill(victim.rec.id, 'fell assaulting the bandit camp', 'bandits');
        for (const g of guards) if (rng.chance(0.35)) c.h.injure(g.rec.id, rng.range(0.15, 0.5));
        if (win) {
          c.h.clearCamp(poi, c.n.rec.id);
          const t = `the watch of ${c.h.site(site(c))?.name ?? 'town'} burned the bandit camp ${c.g.data.way}`;
          news(c, t, 'event', 0.75, 0.9);
          c.h.bark(c.n.rec.id, 'bark.victory');
          return true;
        }
        c.g.data.mustered = 0;
        news(c, `the watch was driven back from the bandit camp ${c.g.data.way}`, 'event', 0.7, 0.8);
        return false;
      }
    }
    return false;
  },
  quest(c, giverId) {
    const at: Vec3 = [Number(c.g.data.x), Number(c.g.data.y), Number(c.g.data.z)];
    const n = Math.max(3, Math.round(c.h.campStrength(String(c.g.data.poi)) * 1.5));
    const obj: QuestSpec['objectives'] = [{ kind: 'kill', text: `Kill ${n} bandits at the camp ${c.g.data.way}`, faction: 'hostile', tag: 'bandit', count: n, pos: at }];
    if (giverId !== undefined) obj.push({ kind: 'talk', text: `Report to ${name(c)}`, npc: giverId });
    return { ...questBase(c, giverId, 'Bounty: The Bandit Camp', `${c.n.rec.name} offers a bounty on the bandits camped ${c.g.data.way} of ${c.h.site(site(c))?.name ?? 'here'}.`), objectives: obj, rewards: reward(c, 90) };
  },
  questDone(c, player) {
    c.h.clearCamp(String(c.g.data.poi), `P:${player}`);
  },
};

const protectFields: GoalDef = {
  kind: 'protectFields',
  want: { safe: 1 },
  facts(c) {
    const guards = c.n.rec.siteId ? c.h.residents(c.n.rec.siteId).some((r) => r.rec.job === 'guard' && r.st.alive) : false;
    return { safe: c.g.data.done ? 1 : 0, bold: T(c).courage > 0.15 ? 1 : 0, guards: guards ? 1 : 0, fence: c.g.data.fence ? 1 : 0 };
  },
  actions: [
    { id: 'scare', pre: { bold: 1 }, eff: { safe: 1 }, cost: (c) => 2 - T(c).courage },
    { id: 'fence', pre: {}, eff: { fence: 1 }, cost: (c) => 2 - T(c).conscientiousness * 0.6 },
    { id: 'watch', pre: { fence: 1 }, eff: { safe: 1 }, cost: () => 1.5 },
    { id: 'guards', pre: { guards: 1 }, eff: { safe: 1 }, cost: (c) => 2.2 - T(c).agreeableness * 0.4 },
    askHelp({ safe: 1 }, 2.6),
  ],
  tasks(a, c) {
    const fields = c.n.rec.outskirts ? c.n.rec.work : c.h.outskirts(c.n.rec, 'fields');
    const cn = String(c.g.data.creatureName);
    switch (a) {
      case 'scare':
        return [{ k: 'goto', to: fields, label: `chasing off the ${cn}`, run: true }, { k: 'work', anims: ['throw', 'gesture_wave', 'cheer'], hours: 0.75, label: `shouting at the ${cn}`, at: fields }, { k: 'effect', fx: 'scare', label: 'drove it off' }];
      case 'fence':
        return [{ k: 'goto', to: fields, label: 'mending the fence' }, { k: 'work', anims: ['work_hammer', 'work_saw'], hours: 3, label: 'building a stout fence', at: fields }, { k: 'effect', fx: 'fence', label: 'fence built' }];
      case 'watch':
        return [{ k: 'work', anims: ['gesture_point', 'idle'], hours: 2, label: 'keeping watch over the fields', at: fields }, { k: 'effect', fx: 'watch', label: 'the night passed quietly' }];
      case 'guards': {
        const cap0 = c.n.rec.siteId ? c.h.residents(c.n.rec.siteId).find((r) => r.rec.captain) ?? c.h.residents(c.n.rec.siteId).find((r) => r.rec.job === 'guard') : undefined;
        return [{ k: 'visit', npc: cap0?.rec.id ?? '', hours: 0.4, label: 'asking the watch for help', topic: 'gossip' }, { k: 'effect', fx: 'guards', label: 'the watch will patrol the fields' }];
      }
      case 'askHelp':
        return [{ k: 'askHelp', hours: 30, label: `begging for help against the ${cn}` }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('fields', c.g.id, fx);
    switch (fx) {
      case 'scare':
        if (rng.chance(0.25 - T(c).courage * 0.1)) {
          c.h.injure(c.n.rec.id, rng.range(0.2, 0.5));
          news(c, `the ${c.g.data.creatureName} turned on ${c.n.rec.given} in the fields`, 'monster', 0.65, 0.5, `S:${c.g.data.species}`);
          return false;
        }
        c.g.data.done = 1;
        return true;
      case 'fence':
        c.g.data.fence = 1;
        return true;
      case 'watch':
        c.g.data.done = 1;
        return true;
      case 'guards':
        if (c.n.rec.siteId) c.h.setSiteFlag(c.n.rec.siteId, 'patrolFields', 48);
        c.g.data.done = 1;
        return true;
    }
    return false;
  },
  quest(c, giverId) {
    const sp = Number(c.g.data.species);
    const cn = String(c.g.data.creatureName);
    const fields = c.n.rec.outskirts ? c.n.rec.work : c.h.outskirts(c.n.rec, 'fields');
    const obj: QuestSpec['objectives'] = [{ kind: 'kill', text: `Drive off the ${cn}s near the fields`, species: Number.isFinite(sp) && sp >= 0 ? sp : undefined, count: 2, pos: fields }];
    if (giverId !== undefined) obj.push({ kind: 'talk', text: `Tell ${name(c)} the fields are safe`, npc: giverId });
    return { ...questBase(c, giverId, `Pests in the Pasture`, `${c.n.rec.name}'s ${c.n.rec.job === 'herder' ? 'herd' : 'fields'} are plagued by a ${cn}.`), objectives: obj, rewards: reward(c, 30) };
  },
  questDone(c) {
    c.g.data.done = 1;
  },
};

const courtship: GoalDef = {
  kind: 'courtship',
  want: { wed: 1 },
  facts(c) {
    return { impressed: c.g.data.impressed ? 1 : 0, wed: c.g.data.done ? 1 : 0, rich: c.n.st.coins >= 12 ? 1 : 0, bold: T(c).extraversion > -0.1 ? 1 : 0 };
  },
  actions: [
    { id: 'gift', pre: { rich: 1 }, eff: { impressed: 1 }, cost: (c) => 1.5 + T(c).greed * 1.5 },
    { id: 'serenade', pre: { bold: 1 }, eff: { impressed: 1 }, cost: (c) => 2 - T(c).extraversion - T(c).openness * 0.5 },
    { id: 'propose', pre: { impressed: 1 }, eff: { wed: 1 }, cost: (c) => 1 + T(c).neuroticism },
    askHelp({ impressed: 1 }, 3.5),
  ],
  tasks(a, c) {
    const other = c.h.ref(String(c.g.data.target));
    const on = other?.rec.given ?? 'them';
    switch (a) {
      case 'gift':
        return [{ k: 'goto', to: plazaPos(c), label: `buying a gift for ${on}` }, { k: 'work', anims: ['pickup', 'talk'], hours: 0.4, label: 'choosing a gift' }, { k: 'visit', npc: String(c.g.data.target), hours: 0.5, label: `giving ${on} a gift`, topic: 'court' }, { k: 'effect', fx: 'gift', label: 'gift given' }];
      case 'serenade':
        return [{ k: 'visit', npc: String(c.g.data.target), hours: 0.75, label: `singing for ${on}`, topic: 'court' }, { k: 'effect', fx: 'serenade', label: 'serenaded' }];
      case 'propose':
        return [{ k: 'visit', npc: String(c.g.data.target), hours: 0.6, label: `proposing to ${on}`, topic: 'court' }, { k: 'effect', fx: 'propose', label: 'asked the question' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 30, label: `hoping someone will put in a good word with ${on}` }];
    }
    return [];
  },
  effect(fx, c) {
    const other = c.h.ref(String(c.g.data.target));
    if (!other || !other.st.alive) return false;
    const rng = c.h.rng('court', c.g.id, fx);
    const me = c.n.rec.id, them = other.rec.id;
    switch (fx) {
      case 'gift':
        c.n.st.coins -= 12;
        c.h.adjustRel(them, me, rng.int(6, 18));
        c.g.data.impressed = 1;
        return true;
      case 'serenade': {
        const liked = rng.chance(0.55 + T(c).extraversion * 0.2);
        c.h.adjustRel(them, me, liked ? rng.int(8, 20) : -rng.int(3, 10));
        if (liked) c.g.data.impressed = 1;
        news(c, `${c.n.rec.given} sang beneath ${other.rec.given}'s window ${liked ? 'and won a smile' : 'and was pelted with turnips'}`, 'love', 0.4, 0.4);
        return liked;
      }
      case 'propose': {
        const aff = (other.rec.relations[me]?.affinity ?? 0) + (other.st.rel[me] ?? 0);
        const yes = rng.chance(clamp(0.25 + aff / 120 + other.rec.traits.agreeableness * 0.15, 0.05, 0.92));
        if (yes) {
          c.g.data.done = 1;
          c.h.setRelKind(me, them, 'spouse');
          c.h.setRelKind(them, me, 'spouse');
          c.h.adjustRel(them, me, 30);
          c.h.adjustRel(me, them, 30);
          news(c, `${c.n.rec.given} and ${other.rec.given} are to be wed`, 'love', 0.7, 0.9);
          c.h.bark(c.n.rec.id, 'bark.victory');
          if (c.n.rec.siteId) c.h.setSiteFlag(c.n.rec.siteId, 'feast', 20);
          return true;
        }
        c.h.adjustRel(me, them, -10);
        c.n.st.needs.fun = 0.1;
        remember(c, `${other.rec.given} turned down ${c.n.rec.given}'s proposal`, 'love', 0.8, them);
        news(c, `${other.rec.given} refused ${c.n.rec.given}'s hand`, 'gossip', 0.5, 0.5);
        return false;
      }
    }
    return false;
  },
  quest(c, giverId) {
    const other = c.h.ref(String(c.g.data.target));
    if (!other) return null;
    const oid = c.h.entityOf(other.rec.id);
    const obj: QuestSpec['objectives'] = oid !== undefined
      ? [{ kind: 'talk', text: `Put in a good word for ${name(c)} with ${other.rec.given}`, npc: oid }]
      : [{ kind: 'goto', text: `Find ${other.rec.given} at home`, pos: other.rec.bed, radius: 6 }];
    if (giverId !== undefined) obj.push({ kind: 'talk', text: `Tell ${name(c)} how it went`, npc: giverId });
    return { ...questBase(c, giverId, `A Word for ${name(c)}`, `${c.n.rec.name} is sweet on ${other.rec.name} but cannot find the courage to say so.`), objectives: obj, rewards: reward(c, 20) };
  },
  questDone(c) {
    c.g.data.impressed = 1;
    const other = c.h.ref(String(c.g.data.target));
    if (other) c.h.adjustRel(other.rec.id, c.n.rec.id, 15);
  },
};

const rivalry: GoalDef = {
  kind: 'rivalry',
  want: { settled: 1 },
  facts(c) {
    return { settled: c.g.data.done ? 1 : 0, mean: T(c).agreeableness < -0.15 ? 1 : 0, kind: T(c).agreeableness > 0.25 ? 1 : 0, bold: T(c).courage > 0.2 ? 1 : 0 };
  },
  actions: [
    { id: 'outwork', pre: {}, eff: { settled: 1 }, cost: (c) => 2.5 - T(c).conscientiousness },
    { id: 'slander', pre: { mean: 1 }, eff: { settled: 1 }, cost: (c) => 1.5 + T(c).piety },
    { id: 'challenge', pre: { bold: 1 }, eff: { settled: 1 }, cost: (c) => 2 - T(c).courage * 0.5 },
    { id: 'reconcile', pre: { kind: 1 }, eff: { settled: 1 }, cost: (c) => 2 - T(c).agreeableness },
  ],
  tasks(a, c) {
    const rv = String(c.g.data.target);
    const rn = c.h.ref(rv)?.rec.given ?? 'the rival';
    switch (a) {
      case 'outwork':
        return [{ k: 'work', anims: JOBS[c.n.rec.job].workAnims, hours: 4, label: `trying to outdo ${rn}`, at: c.n.rec.work }, { k: 'effect', fx: 'outwork', label: 'outworked the rival' }];
      case 'slander':
        return [{ k: 'goto', to: buildingPos(c, ['tavern']) ?? plazaPos(c), label: `whispering about ${rn}` }, { k: 'work', anims: ['talk'], hours: 1, label: `spreading tales about ${rn}` }, { k: 'effect', fx: 'slander', label: 'spread rumors' }];
      case 'challenge':
        return [{ k: 'visit', npc: rv, hours: 0.6, label: `challenging ${rn}`, topic: 'rival' }, { k: 'effect', fx: 'challenge', label: 'settled it' }];
      case 'reconcile':
        return [{ k: 'visit', npc: rv, hours: 0.75, label: `making peace with ${rn}`, topic: 'rival' }, { k: 'effect', fx: 'reconcile', label: 'reconciled' }];
    }
    return [];
  },
  effect(fx, c) {
    const rv = c.h.ref(String(c.g.data.target));
    if (!rv) return false;
    const rng = c.h.rng('rival', c.g.id, fx);
    const me = c.n.rec.id;
    switch (fx) {
      case 'outwork':
        c.n.st.coins += rng.int(5, 20);
        c.g.data.done = 1;
        news(c, `${c.n.rec.given} has been working dawn to dusk to outshine ${rv.rec.given}`, 'gossip', 0.3, 0.3);
        return true;
      case 'slander': {
        const lies = ['waters down the ale', 'cheats at dice', 'sold rotten goods to a widow', 'talks to crows at night', 'owes half the town money', 'was seen sneaking out after curfew'];
        const t = `${rv.rec.given} ${rng.pick(lies)}`;
        news(c, t, 'gossip', 0.45, 0.45, rv.rec.id);
        c.h.adjustRel(rv.rec.id, me, -15);
        c.g.data.done = 1;
        return true;
      }
      case 'challenge': {
        const won = rng.chance(0.5 + (T(c).courage - rv.rec.traits.courage) * 0.2);
        const contest = rng.pick(['an arm-wrestling match', 'a drinking contest', 'a shouting match in the square', 'a test of their crafts']);
        const t = `${won ? c.n.rec.given : rv.rec.given} beat ${won ? rv.rec.given : c.n.rec.given} in ${contest}`;
        news(c, t, 'gossip', 0.5, 0.6);
        c.h.adjustRel(rv.rec.id, me, won ? -8 : 5);
        c.g.data.done = 1;
        return true;
      }
      case 'reconcile': {
        const ok = rng.chance(0.45 + rv.rec.traits.agreeableness * 0.3);
        if (ok) {
          c.h.adjustRel(rv.rec.id, me, 40);
          c.h.adjustRel(me, rv.rec.id, 40);
          c.h.setRelKind(me, rv.rec.id, 'friend');
          c.h.setRelKind(rv.rec.id, me, 'friend');
          news(c, `${c.n.rec.given} and ${rv.rec.given} have buried their old quarrel`, 'gossip', 0.5, 0.5);
          c.g.data.done = 1;
        }
        return ok;
      }
    }
    return false;
  },
};

const repayDebt: GoalDef = {
  kind: 'repayDebt',
  want: { free: 1 },
  facts(c) {
    const amt = Number(c.g.data.amount);
    return { free: c.g.data.done ? 1 : 0, rich: c.n.st.coins >= amt ? 1 : 0, crooked: T(c).greed > 0.25 && T(c).agreeableness < 0 ? 1 : 0, heirloom: c.n.st.flags.heirloomSold ? 0 : 1 };
  },
  actions: [
    { id: 'pay', pre: { rich: 1 }, eff: { free: 1 }, cost: () => 1 },
    { id: 'workExtra', pre: {}, eff: { rich: 1 }, cost: (c) => 2.5 - T(c).conscientiousness },
    { id: 'sellHeirloom', pre: { heirloom: 1 }, eff: { rich: 1 }, cost: (c) => 3 + T(c).neuroticism },
    { id: 'steal', pre: { crooked: 1 }, eff: { rich: 1 }, cost: (c) => 2 + T(c).piety * 2 + T(c).conscientiousness },
    askHelp({ free: 1 }, 3.5),
  ],
  tasks(a, c) {
    const cr = String(c.g.data.target);
    const cn = c.h.ref(cr)?.rec.given ?? 'the lender';
    switch (a) {
      case 'pay':
        return [{ k: 'visit', npc: cr, hours: 0.4, label: `repaying ${cn}`, topic: 'debt' }, { k: 'effect', fx: 'pay', label: 'paid the debt' }];
      case 'workExtra':
        return [{ k: 'work', anims: JOBS[c.n.rec.job].workAnims, hours: 5, label: 'working off the debt', at: c.n.rec.work }, { k: 'effect', fx: 'earn', label: 'earned coin' }];
      case 'sellHeirloom':
        return [{ k: 'goto', to: plazaPos(c), label: 'selling a family heirloom' }, { k: 'work', anims: ['talk', 'gesture_shrug'], hours: 0.5, label: 'parting with an heirloom' }, { k: 'effect', fx: 'heirloom', label: 'sold the heirloom' }];
      case 'steal':
        return [{ k: 'goto', to: plazaPos(c), label: 'loitering' }, { k: 'work', anims: ['pickup'], hours: 0.5, label: 'eyeing purses' }, { k: 'effect', fx: 'steal', label: 'lifted a purse' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 36, label: `hoping someone can talk ${cn} round` }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('debt', c.g.id, fx);
    const amt = Number(c.g.data.amount);
    const cr = c.h.ref(String(c.g.data.target));
    switch (fx) {
      case 'pay':
        if (c.n.st.coins < amt) return false;
        c.n.st.coins -= amt;
        if (cr) {
          cr.st.coins += amt;
          c.h.adjustRel(cr.rec.id, c.n.rec.id, 25);
          c.h.setRelKind(c.n.rec.id, cr.rec.id, 'neighbor');
          c.h.setRelKind(cr.rec.id, c.n.rec.id, 'neighbor');
        }
        c.g.data.done = 1;
        news(c, `${c.n.rec.given} paid off every coin owed to ${cr?.rec.given ?? 'the lender'}`, 'gossip', 0.35, 0.3);
        return true;
      case 'earn':
        c.n.st.coins += Math.round(amt * rng.range(0.35, 0.7));
        return true;
      case 'heirloom':
        c.n.st.flags.heirloomSold = 1;
        c.n.st.coins += Math.round(amt * rng.range(0.8, 1.3));
        remember(c, `${c.n.rec.given} sold the family heirloom to pay a debt`, 'personal', 0.6);
        return true;
      case 'steal': {
        const victims = c.n.rec.siteId ? c.h.residents(c.n.rec.siteId).filter((r) => r !== c.n && r.st.alive && r.st.coins > 10) : [];
        if (!victims.length) return false;
        const v = rng.pick(victims);
        const take = Math.min(v.st.coins, Math.round(amt * rng.range(0.5, 1.2)));
        const caught = rng.chance(0.25 - T(c).conscientiousness * 0.05);
        if (caught) {
          c.n.st.jailedUntil = c.h.now() + 24;
          c.h.adjustRel(v.rec.id, c.n.rec.id, -50);
          news(c, `${c.n.rec.given} was caught with ${v.rec.given}'s purse and thrown in the stocks`, 'crime', 0.8, 0.9, c.n.rec.id);
          return false;
        }
        v.st.coins -= take;
        c.n.st.coins += take;
        c.h.remember(v.rec.id, { text: `someone cut ${v.rec.given}'s purse in the market`, kind: 'crime', imp: 0.6 });
        news(c, `a cutpurse robbed ${v.rec.given} in broad daylight`, 'crime', 0.5, 0.5);
        return true;
      }
    }
    return false;
  },
  quest(c, giverId) {
    const cr = c.h.ref(String(c.g.data.target));
    if (!cr) return null;
    const oid = c.h.entityOf(cr.rec.id);
    if (oid === undefined) return null;
    const obj: QuestSpec['objectives'] = [{ kind: 'talk', text: `Convince ${cr.rec.given} to forgive ${name(c)}'s debt`, npc: oid }];
    return { ...questBase(c, giverId, `${name(c)}'s Debt`, `${c.n.rec.name} owes ${c.g.data.amount} coins to ${cr.rec.name} and cannot pay.`), objectives: obj, rewards: { coins: 0, reputation: c.n.rec.siteId ? { [`site.${c.n.rec.siteId}`]: 8 } : undefined, text: `${name(c)} will owe you a favour` } };
  },
  questDone(c) {
    c.g.data.done = 1;
    const cr = c.h.ref(String(c.g.data.target));
    if (cr) {
      c.h.setRelKind(c.n.rec.id, cr.rec.id, 'neighbor');
      c.h.setRelKind(cr.rec.id, c.n.rec.id, 'neighbor');
    }
  },
};

const ambition: GoalDef = {
  kind: 'ambition',
  want: { achieved: 1 },
  facts(c) {
    const p = Number(c.g.data.p ?? 0);
    return { achieved: p >= 1 ? 1 : 0, p, social: T(c).extraversion > 0 ? 1 : 0 };
  },
  actions: [
    { id: 'practice', pre: {}, eff: {}, add: { p: 0.35 }, cost: (c) => 1.6 - T(c).conscientiousness * 0.5 },
    { id: 'network', pre: { social: 1 }, eff: {}, add: { p: 0.35 }, cost: (c) => 1.6 - T(c).extraversion * 0.5 },
    { id: 'claim', pre: { p: 1 }, eff: { achieved: 1 }, cost: () => 0.5 },
  ],
  tasks(a, c) {
    switch (a) {
      case 'practice':
        return [{ k: 'work', anims: JOBS[c.n.rec.job].workAnims, hours: 3, label: `working toward a dream: ${c.g.desc}`, at: c.n.rec.work }, { k: 'effect', fx: 'progress', label: 'made progress' }];
      case 'network': {
        const leader = c.n.rec.siteId ? c.h.residents(c.n.rec.siteId).find((r) => r.rec.leader && r !== c.n) : undefined;
        return [{ k: 'visit', npc: leader?.rec.id ?? '', hours: 0.75, label: 'currying favour', topic: 'gossip' }, { k: 'effect', fx: 'progress', label: 'made a useful friend' }];
      }
      case 'claim':
        return [{ k: 'effect', fx: 'claim', label: 'achieved a dream' }];
    }
    return [];
  },
  effect(fx, c) {
    if (fx === 'progress') {
      c.g.data.p = Number(c.g.data.p ?? 0) + 0.35;
      c.g.progress = clamp(Number(c.g.data.p), 0, 1);
      return true;
    }
    if (fx === 'claim') {
      c.n.st.needs.fun = 1;
      c.n.st.needs.wealth = clamp(c.n.st.needs.wealth + 0.2, 0, 1);
      news(c, `${c.n.rec.given} finally managed ${c.g.desc.replace(/^to /, 'to ')}`, 'gossip', 0.45, 0.5, c.n.rec.id);
      c.h.bark(c.n.rec.id, 'bark.victory');
      return true;
    }
    return false;
  },
};

const rebuild: GoalDef = {
  kind: 'rebuild',
  want: { rebuilt: 1 },
  facts(c) {
    return { rebuilt: c.g.data.done ? 1 : 0, materials: (c.n.st.stock.timber ?? 0) + (c.n.st.stock.stone ?? 0) >= 4 ? 1 : 0, supplier: supplierOf(c, 'timber') ? 1 : 0, rich: c.n.st.coins >= 20 ? 1 : 0 };
  },
  actions: [
    { id: 'gatherWood', pre: {}, eff: { materials: 1 }, cost: (c) => 2.5 - T(c).conscientiousness * 0.5 },
    { id: 'buyWood', pre: { supplier: 1, rich: 1 }, eff: { materials: 1 }, cost: (c) => 1.5 + T(c).greed },
    { id: 'build', pre: { materials: 1 }, eff: { rebuilt: 1 }, cost: () => 2 },
    askHelp({ materials: 1 }, 2.4),
  ],
  tasks(a, c) {
    const at: Vec3 = [Number(c.g.data.x), Number(c.g.data.y), Number(c.g.data.z)];
    switch (a) {
      case 'gatherWood': {
        const w = c.h.outskirts(c.n.rec, 'woods');
        return [{ k: 'goto', to: w, label: 'felling timber' }, { k: 'work', anims: ['chop', 'pickup'], hours: 3, label: 'felling timber', at: w }, { k: 'effect', fx: 'wood', label: 'hauled timber' }];
      }
      case 'buyWood': {
        const s = supplierOf(c, 'timber');
        return [{ k: 'goto', to: s?.rec.work ?? plazaPos(c), label: 'buying timber' }, { k: 'work', anims: ['talk'], hours: 0.4, label: 'buying timber' }, { k: 'effect', fx: 'buyWood', label: 'bought timber' }];
      }
      case 'build':
        return [{ k: 'goto', to: at, label: 'heading to the ruins' }, { k: 'work', anims: ['work_hammer', 'work_saw', 'pickup'], hours: 5, label: `rebuilding the ${c.g.data.what}`, at }, { k: 'effect', fx: 'build', label: 'rebuilt' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 30, label: 'asking for building materials' }];
    }
    return [];
  },
  effect(fx, c) {
    switch (fx) {
      case 'wood':
        c.n.st.stock.timber = (c.n.st.stock.timber ?? 0) + 4;
        return true;
      case 'buyWood': {
        const s = supplierOf(c, 'timber');
        c.n.st.coins -= 20;
        if (s) s.st.coins += 20;
        c.n.st.stock.timber = (c.n.st.stock.timber ?? 0) + 4;
        return true;
      }
      case 'build':
        c.n.st.stock.timber = Math.max(0, (c.n.st.stock.timber ?? 0) - 4);
        c.g.data.done = 1;
        news(c, `${c.n.rec.given} has rebuilt the ${c.g.data.what}`, 'event', 0.45, 0.6);
        return true;
    }
    return false;
  },
  quest(c, giverId) {
    const obj: QuestSpec['objectives'] = [{ kind: 'collect', text: 'Gather 6 logs of timber', itemDef: GOODS_ITEM.timber, count: 6 }];
    if (giverId !== undefined) obj.push({ kind: 'deliver', text: `Bring the timber to ${name(c)}`, itemDef: GOODS_ITEM.timber, count: 6, toNpc: giverId });
    return { ...questBase(c, giverId, `Raise the ${cap(String(c.g.data.what))}`, `The ${c.g.data.what} in ${c.h.site(site(c))?.name ?? 'town'} was destroyed and ${c.n.rec.name} means to rebuild it.`), objectives: obj, rewards: reward(c, 40) };
  },
  questDone(c) {
    c.n.st.stock.timber = (c.n.st.stock.timber ?? 0) + 6;
  },
};

const pilgrimage: GoalDef = {
  kind: 'pilgrimage',
  want: { blessed: 1 },
  facts(c) {
    return { blessed: c.g.data.done ? 1 : 0, far: c.g.data.poi ? 1 : 0 };
  },
  actions: [
    { id: 'journey', pre: { far: 1 }, eff: { blessed: 1 }, cost: (c) => 2 - T(c).piety },
    { id: 'vigil', pre: {}, eff: { blessed: 1 }, cost: (c) => 3 + T(c).openness },
  ],
  tasks(a, c) {
    if (a === 'journey') {
      const at: Vec3 = [Number(c.g.data.x), Number(c.g.data.y), Number(c.g.data.z)];
      return [{ k: 'travel', to: at, hours: travelHours(c, at) * 2 + 2, label: `on pilgrimage to the ${c.g.data.poiName}` }, { k: 'effect', fx: 'bless', label: 'returned from pilgrimage' }];
    }
    const t = buildingPos(c, ['temple', 'shrine']) ?? plazaPos(c);
    return [{ k: 'goto', to: t, label: 'keeping a vigil' }, { k: 'work', anims: ['pray'], hours: 4, label: 'keeping a night-long vigil', at: t }, { k: 'effect', fx: 'bless', label: 'vigil kept' }];
  },
  effect(fx, c) {
    if (fx !== 'bless') return false;
    c.n.st.needs.faith = 1;
    c.n.st.needs.safety = 1;
    c.g.data.done = 1;
    remember(c, `${c.n.rec.given} returned from ${c.g.data.poi ? `the ${c.g.data.poiName}` : 'a long vigil'} with a light in their eyes`, 'personal', 0.4);
    return true;
  },
};

const avenge: GoalDef = {
  kind: 'avenge',
  want: { avenged: 1 },
  facts(c) {
    return { avenged: c.g.data.done ? 1 : 0, bold: T(c).courage > 0 ? 1 : 0, tracked: c.g.data.tracked ? 1 : 0, beast: c.g.data.species !== undefined && Number(c.g.data.species) >= 0 ? 1 : 0 };
  },
  actions: [
    { id: 'track', pre: { beast: 1 }, eff: { tracked: 1 }, cost: () => 1 },
    { id: 'slay', pre: { tracked: 1, bold: 1 }, eff: { avenged: 1 }, cost: (c) => 2 - T(c).courage },
    { id: 'mourn', pre: {}, eff: { avenged: 1 }, cost: (c) => 4 + T(c).courage * 2 - T(c).agreeableness - T(c).piety },
    askHelp({ avenged: 1 }, 2.2),
  ],
  tasks(a, c) {
    const wilds = c.h.outskirts(c.n.rec, 'wilds');
    switch (a) {
      case 'track':
        return [{ k: 'goto', to: wilds, label: `hunting for the killer of ${c.g.data.victim}` }, { k: 'work', anims: ['harvest'], hours: 1.5, label: 'searching for tracks', at: wilds }, { k: 'effect', fx: 'track', label: 'found a trail' }];
      case 'slay':
        return [{ k: 'hunt', hours: 3, label: `seeking vengeance for ${c.g.data.victim}`, at: wilds }, { k: 'effect', fx: 'slay', label: 'took revenge' }];
      case 'mourn': {
        const t = buildingPos(c, ['temple', 'shrine']) ?? homePos(c);
        return [{ k: 'goto', to: t, label: `mourning ${c.g.data.victim}` }, { k: 'work', anims: ['pray', 'sit'], hours: 3, label: `grieving for ${c.g.data.victim}`, at: t }, { k: 'effect', fx: 'mourn', label: 'made peace' }];
      }
      case 'askHelp':
        return [{ k: 'askHelp', hours: 48, label: `seeking someone to avenge ${c.g.data.victim}` }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('avenge', c.g.id, fx);
    switch (fx) {
      case 'track':
        c.g.data.tracked = 1;
        return true;
      case 'slay':
        if (c.g.data.done) return true;
        if (rng.chance(0.35 + JOBS[c.n.rec.job].combat * 0.4)) {
          c.g.data.done = 1;
          news(c, `${c.n.rec.given} avenged ${c.g.data.victim} and slew the ${c.g.data.creatureName}`, 'event', 0.7, 0.7);
          return true;
        }
        if (rng.chance(0.25)) c.h.kill(c.n.rec.id, `was slain hunting the ${c.g.data.creatureName}`, String(c.g.data.creatureName));
        else c.h.injure(c.n.rec.id, rng.range(0.3, 0.7));
        return false;
      case 'mourn':
        c.g.data.done = 1;
        c.n.st.needs.faith = clamp(c.n.st.needs.faith + 0.3, 0, 1);
        return true;
    }
    return false;
  },
  quest(c, giverId) {
    const sp = Number(c.g.data.species);
    const obj: QuestSpec['objectives'] = Number.isFinite(sp) && sp >= 0
      ? [{ kind: 'kill', text: `Slay the ${c.g.data.creatureName} that killed ${c.g.data.victim}`, species: sp, count: 1, pos: c.h.outskirts(c.n.rec, 'wilds') }]
      : [{ kind: 'kill', text: `Hunt down ${c.g.data.victim}'s killers`, faction: 'hostile', tag: 'bandit', count: 2 }];
    if (giverId !== undefined) obj.push({ kind: 'talk', text: `Tell ${name(c)} that ${c.g.data.victim} is avenged`, npc: giverId });
    return { ...questBase(c, giverId, `Vengeance for ${c.g.data.victim}`, `${c.n.rec.name} grieves for ${c.g.data.victim} and wants the killer brought to justice.`), objectives: obj, rewards: reward(c, 60) };
  },
  questDone(c) {
    c.g.data.done = 1;
  },
};

const heal: GoalDef = {
  kind: 'heal',
  want: { healed: 1 },
  facts(c) {
    const p = c.h.ref(String(c.g.data.target));
    return { healed: !p || !p.st.alive || p.st.injury < 0.15 ? 1 : 0, herbs: (c.n.st.stock.herbs ?? 0) >= 1 ? 1 : 0 };
  },
  actions: [
    { id: 'gather', pre: {}, eff: { herbs: 1 }, cost: (c) => 2 - T(c).courage * 0.5 },
    { id: 'tend', pre: { herbs: 1 }, eff: { healed: 1 }, cost: () => 1 },
    { id: 'pray', pre: {}, eff: { healed: 1 }, cost: (c) => 3.5 - T(c).piety * 2 },
  ],
  tasks(a, c) {
    const p = c.h.ref(String(c.g.data.target));
    switch (a) {
      case 'gather': {
        const w = c.h.outskirts(c.n.rec, 'wilds');
        return [{ k: 'goto', to: w, label: 'gathering herbs' }, { k: 'work', anims: ['harvest', 'pickup'], hours: 1.5, label: 'gathering herbs', at: w }, { k: 'effect', fx: 'herbs', label: 'found herbs' }];
      }
      case 'tend':
        return [{ k: 'visit', npc: String(c.g.data.target), hours: 1, label: `tending ${p?.rec.given ?? 'the wounded'}`, topic: 'heal' }, { k: 'effect', fx: 'tend', label: 'tended the wounds' }];
      case 'pray':
        return [{ k: 'visit', npc: String(c.g.data.target), hours: 1, label: `praying over ${p?.rec.given ?? 'the wounded'}`, topic: 'heal' }, { k: 'effect', fx: 'pray', label: 'prayed for healing' }];
    }
    return [];
  },
  effect(fx, c) {
    const p = c.h.ref(String(c.g.data.target));
    switch (fx) {
      case 'herbs':
        c.n.st.stock.herbs = (c.n.st.stock.herbs ?? 0) + 3;
        return true;
      case 'tend':
      case 'pray':
        if (!p) return false;
        if (fx === 'tend') c.n.st.stock.herbs = Math.max(0, (c.n.st.stock.herbs ?? 0) - 1);
        p.st.injury = Math.max(0, p.st.injury - (fx === 'tend' ? 0.6 : 0.35));
        c.h.adjustRel(p.rec.id, c.n.rec.id, 15);
        c.h.remember(p.rec.id, { text: `${c.n.rec.given} nursed ${p.rec.given} back to health`, kind: 'help', imp: 0.5, about: c.n.rec.id });
        return true;
    }
    return false;
  },
};

const gatherHerbs: GoalDef = {
  kind: 'gatherHerbs',
  want: { herbs: 1 },
  facts(c) {
    return { herbs: (c.n.st.stock.herbs ?? 0) + (c.n.st.stock.reagents ?? 0) >= 4 ? 1 : 0, bold: T(c).courage > -0.3 ? 1 : 0 };
  },
  actions: [{ id: 'forage', pre: { bold: 1 }, eff: { herbs: 1 }, cost: () => 1.5 }, askHelp({ herbs: 1 }, 2.8)],
  tasks(a, c) {
    if (a === 'askHelp') return [{ k: 'askHelp', hours: 30, label: 'hoping for a herb-gatherer' }];
    const w = c.h.outskirts(c.n.rec, 'wilds');
    return [{ k: 'goto', to: w, label: 'foraging' }, { k: 'work', anims: ['harvest', 'pickup', 'dig'], hours: 2.5, label: 'gathering herbs and reagents', at: w }, { k: 'effect', fx: 'forage', label: 'foraged' }];
  },
  effect(fx, c) {
    if (fx !== 'forage') return false;
    c.n.st.stock.herbs = (c.n.st.stock.herbs ?? 0) + 3;
    c.n.st.stock.reagents = (c.n.st.stock.reagents ?? 0) + 2;
    return true;
  },
  quest(c, giverId) {
    const obj: QuestSpec['objectives'] = [{ kind: 'collect', text: 'Gather 4 healing herbs', itemDef: GOODS_ITEM.herbs, count: 4 }];
    if (giverId !== undefined) obj.push({ kind: 'deliver', text: `Bring the herbs to ${name(c)}`, itemDef: GOODS_ITEM.herbs, count: 4, toNpc: giverId });
    return { ...questBase(c, giverId, `Herbs for ${name(c)}`, `${c.n.rec.name} has run out of herbs for remedies.`), objectives: obj, rewards: { ...reward(c, 25), xp: { alchemy: 40 } } };
  },
  questDone(c) {
    c.n.st.stock.herbs = (c.n.st.stock.herbs ?? 0) + 4;
  },
};

const feast: GoalDef = {
  kind: 'feast',
  want: { held: 1 },
  facts(c) {
    return { held: c.g.data.done ? 1 : 0, food: (c.n.st.stock.meat ?? 0) >= 4 ? 1 : 0, supplier: supplierOf(c, 'meat') ? 1 : 0, rich: c.n.st.coins >= 30 ? 1 : 0 };
  },
  actions: [
    { id: 'buyFood', pre: { supplier: 1, rich: 1 }, eff: { food: 1 }, cost: (c) => 1.5 + T(c).greed * 2 },
    { id: 'huntFood', pre: {}, eff: { food: 1 }, cost: (c) => 3 - T(c).courage },
    { id: 'host', pre: { food: 1 }, eff: { held: 1 }, cost: () => 1 },
    askHelp({ food: 1 }, 2.2),
  ],
  tasks(a, c) {
    switch (a) {
      case 'buyFood': {
        const s = supplierOf(c, 'meat');
        return [{ k: 'goto', to: s?.rec.work ?? plazaPos(c), label: 'buying meat for a feast' }, { k: 'work', anims: ['talk'], hours: 0.5, label: 'haggling over meat' }, { k: 'effect', fx: 'buyFood', label: 'bought meat' }];
      }
      case 'huntFood': {
        const w = c.h.outskirts(c.n.rec, 'wilds');
        return [{ k: 'goto', to: w, label: 'hunting for the feast' }, { k: 'work', anims: ['shoot_bow', 'pickup'], hours: 3, label: 'hunting game', at: w }, { k: 'effect', fx: 'huntFood', label: 'hunted' }];
      }
      case 'host':
        return [{ k: 'goto', to: plazaPos(c), label: 'preparing the feast' }, { k: 'work', anims: ['cheer', 'talk', 'gesture_wave'], hours: 1, label: 'announcing a feast', at: plazaPos(c) }, { k: 'effect', fx: 'host', label: 'feast held' }];
      case 'askHelp':
        return [{ k: 'askHelp', hours: 30, label: 'hoping someone brings meat for the feast' }];
    }
    return [];
  },
  effect(fx, c) {
    const rng = c.h.rng('feast', c.g.id, fx);
    switch (fx) {
      case 'buyFood': {
        const s = supplierOf(c, 'meat');
        c.n.st.coins -= 30;
        if (s) s.st.coins += 30;
        c.n.st.stock.meat = (c.n.st.stock.meat ?? 0) + 5;
        return true;
      }
      case 'huntFood':
        if (!rng.chance(0.5 + JOBS[c.n.rec.job].combat * 0.4)) return false;
        c.n.st.stock.meat = (c.n.st.stock.meat ?? 0) + 4;
        return true;
      case 'host':
        c.n.st.stock.meat = Math.max(0, (c.n.st.stock.meat ?? 0) - 4);
        if (c.n.rec.siteId) c.h.setSiteFlag(c.n.rec.siteId, 'feast', 18);
        c.g.data.done = 1;
        news(c, `${c.n.rec.given} is throwing a feast on the square tonight`, 'event', 0.55, 1);
        return true;
    }
    return false;
  },
  quest(c, giverId) {
    const obj: QuestSpec['objectives'] = [{ kind: 'collect', text: 'Bring 4 cuts of fresh meat', itemDef: GOODS_ITEM.meat, count: 4 }];
    if (giverId !== undefined) obj.push({ kind: 'deliver', text: `Deliver the meat to ${name(c)}`, itemDef: GOODS_ITEM.meat, count: 4, toNpc: giverId });
    return { ...questBase(c, giverId, 'Meat for the Feast', `${c.n.rec.name} wants to throw a feast for ${c.h.site(site(c))?.name ?? 'the town'}.`), objectives: obj, rewards: reward(c, 30) };
  },
  questDone(c) {
    c.n.st.stock.meat = (c.n.st.stock.meat ?? 0) + 4;
  },
};

const recruit: GoalDef = {
  kind: 'recruit',
  want: { recruited: 1 },
  facts(c) {
    return { recruited: c.g.data.done ? 1 : 0, persuasive: T(c).extraversion + T(c).agreeableness > 0 ? 1 : 0 };
  },
  actions: [
    { id: 'persuade', pre: { persuasive: 1 }, eff: { recruited: 1 }, cost: () => 1.5 },
    { id: 'pay', pre: {}, eff: { recruited: 1 }, cost: (c) => 2.5 + T(c).greed * 2 },
  ],
  tasks(a, c) {
    const t = c.h.ref(String(c.g.data.target));
    return [{ k: 'visit', npc: String(c.g.data.target), hours: 0.75, label: `trying to win over ${t?.rec.given ?? 'a recruit'}`, topic: 'recruit' }, { k: 'effect', fx: a, label: 'made an offer' }];
  },
  effect(fx, c) {
    const t = c.h.ref(String(c.g.data.target));
    if (!t) return false;
    const rng = c.h.rng('recruit', c.g.id, fx);
    const ok = fx === 'pay' ? rng.chance(0.7) : rng.chance(0.45 + T(c).extraversion * 0.2 + t.rec.traits.agreeableness * 0.2);
    if (fx === 'pay') c.n.st.coins = Math.max(0, c.n.st.coins - 15);
    if (!ok) {
      c.h.adjustRel(t.rec.id, c.n.rec.id, -4);
      return false;
    }
    c.h.setRelKind(t.rec.id, c.n.rec.id, 'mentor');
    c.h.setRelKind(c.n.rec.id, t.rec.id, 'apprentice');
    c.h.adjustRel(t.rec.id, c.n.rec.id, 15);
    c.g.data.done = 1;
    news(c, `${t.rec.given} has taken up an apprenticeship with ${c.n.rec.given}`, 'gossip', 0.4, 0.5);
    return true;
  },
};

export const GOALS: Partial<Record<GoalKind, GoalDef>> = {
  restock, tradeRun, hunt, investigate, clearCamp, protectFields, courtship, rivalry, repayDebt, ambition, rebuild, pilgrimage, avenge, heal, gatherHerbs, feast, recruit,
};

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ planning & proposals

/** (Re)plan a goal; returns false when no plan exists (goal fails). */
export function planGoal(c: GoalCtx): boolean {
  const def = GOALS[c.g.kind];
  if (!def) return false;
  const p = plan(def.facts(c), def.want, def.actions, c, c.g.blocked);
  if (!p) return false;
  c.g.plan = p;
  c.g.step = 0;
  c.g.tasks = p.length ? def.tasks(p[0], c) : [];
  c.g.taskIdx = 0;
  c.g.taskT = 0;
  c.g.help = p[0] === 'askHelp';
  return true;
}

/** Advance to the next plan step (after the current step's tasks completed). Returns false when the plan is finished. */
export function nextStep(c: GoalCtx): boolean {
  const def = GOALS[c.g.kind]!;
  c.g.step++;
  if (c.g.step >= c.g.plan.length) return false;
  c.g.tasks = def.tasks(c.g.plan[c.g.step], c);
  c.g.taskIdx = 0;
  c.g.taskT = 0;
  c.g.help = c.g.plan[c.g.step] === 'askHelp';
  return true;
}

export function goalSatisfied(c: GoalCtx): boolean {
  const def = GOALS[c.g.kind];
  if (!def) return true;
  const f = def.facts(c);
  for (const k in def.want) if ((f[k] ?? 0) < def.want[k]) return false;
  return true;
}

export function runEffect(fx: string, c: GoalCtx): boolean {
  return GOALS[c.g.kind]?.effect(fx, c) ?? false;
}

export function questFor(c: GoalCtx, giverId: number | undefined, playerName: string): QuestSpec | null {
  return GOALS[c.g.kind]?.quest?.(c, giverId, playerName) ?? null;
}

export function questCompleted(c: GoalCtx, playerName: string) {
  GOALS[c.g.kind]?.questDone?.(c, playerName);
}

export function canQuest(kind: GoalKind): boolean {
  return !!GOALS[kind]?.quest;
}

interface Proposal {
  kind: GoalKind;
  pri: number;
  desc: string;
  data: Record<string, string | number>;
  days: number;
}

const POI_NAME: Record<PoiKind, string> = {
  ruin: 'old ruin', shrine: 'forgotten shrine', camp: 'bandit camp', lair: 'beast lair', grove: 'strange grove', monolith: 'standing stone',
  tower: 'lonely tower', battlefield: 'old battlefield', crashsite: 'fallen star', well: 'old well', wayshrine: 'wayshrine', obelisk: 'black obelisk',
};

export function poiName(kind: PoiKind): string {
  return POI_NAME[kind] ?? kind;
}

/**
 * Propose a new goal for an NPC from its circumstances. Proposals compete by
 * priority (+ noise), so two smiths in the same situation may still pick
 * different agendas.
 */
export function proposeGoal(n: NpcRef, h: GoalHost): Goal | null {
  const rec = n.rec, st = n.st, t = rec.traits;
  if (rec.ageStage === 'child' || !st.alive) return null;
  const rng = h.rng('propose', rec.id, Math.floor(h.now()));
  const props: Proposal[] = [];
  const jobGoals = JOBS[rec.job].goals;
  const s = rec.siteId ? h.site(rec.siteId) : null;
  const here: Vec3 = s ? [s.x, s.plateau, s.z] : rec.work;
  const active = new Set(st.goals.map((g) => g.kind));
  const has = (k: GoalKind) => active.has(k);
  const relOf = (kind: string) => Object.entries(rec.relations).find(([id, r]) => (st.relKind[id] ?? r.kind) === kind && h.ref(id)?.st.alive);

  // Restock: the trade needs inputs.
  const needs = JOBS[rec.job].needs;
  if (needs && !has('restock') && jobGoals.includes('restock')) {
    const good = needs.find((g) => (st.stock[g] ?? 0) < 2) ;
    if (good) {
      const gn = GOODS_NAME[good] ?? good;
      const where: Partial<Record<NpcJob, string>> = { smith: 'for the forge', innkeeper: 'for the larder', cook: 'for the kitchen', tailor: 'for the loom', carpenter: 'for the workshop', mason: 'for the stone yard', alchemist: 'for the alembics', healer: 'for remedies', mage: 'for the next working' };
      const desc = rec.job === 'merchant' ? `restock the stall with fresh ${gn}` : `get ${gn} ${where[rec.job] ?? 'for the trade'}`;
      props.push({ kind: 'restock', pri: 0.6 + rng.float() * 0.3, desc, data: { good, need: rng.int(3, 6), cost: rng.int(18, 40) }, days: 4 });
    }
  }
  // Trade runs to linked towns.
  if (jobGoals.includes('tradeRun') && !has('tradeRun') && rec.siteId) {
    const links = h.linked(rec.siteId);
    if (links.length) {
      const dest = rng.pick(links);
      // Danger: bandit camps near the road raise it.
      let danger = 0.08;
      for (const p of h.pois((dest.x + here[0]) / 2, (dest.z + here[2]) / 2, Math.hypot(dest.x - here[0], dest.z - here[2]) / 2 + 150)) if (p.kind === 'camp' && h.campStrength(p.id) > 0) danger += 0.25;
      props.push({ kind: 'tradeRun', pri: 0.5 + t.greed * 0.2 + rng.float() * 0.3, desc: `take a cart of goods to ${dest.name}`, data: { dest: dest.id, danger }, days: 4 });
    }
  }
  // Threats: predators seen recently → hunters hunt, farmers protect fields, the bereaved avenge.
  for (const m of st.mem) {
    if (h.now() - m.t > 72 || !m.about?.startsWith('S:')) continue;
    const species = Number(m.about.slice(2));
    const cn = h.speciesName(species);
    if (m.kind === 'monster' && jobGoals.includes('hunt') && !has('hunt')) props.push({ kind: 'hunt', pri: 0.7 + m.imp * 0.4 + t.courage * 0.2, desc: `hunt down the ${cn} prowling nearby`, data: { species, creatureName: cn, role: 'predator', pack: rng.int(1, 3) }, days: 3 });
    if (m.kind === 'monster' && jobGoals.includes('protectFields') && !has('protectFields')) props.push({ kind: 'protectFields', pri: 0.65 + m.imp * 0.4, desc: `keep the ${cn} away from the ${rec.job === 'herder' ? 'herd' : 'fields'}`, data: { species, creatureName: cn }, days: 3 });
    if (m.kind === 'death' && m.imp >= 0.75 && !has('avenge') && m.about) props.push({ kind: 'avenge', pri: 0.8 + t.courage * 0.3 - t.agreeableness * 0.2, desc: `avenge ${m.text.split(' ')[0]}`, data: { species, creatureName: cn, victim: m.text.split(' ')[0] }, days: 5 });
  }
  // Murders by bandits/players → avenge (death memories whose subject is not a species).
  for (const m of st.mem) {
    if (m.kind !== 'death' || m.heard || h.now() - m.t > 96 || has('avenge')) continue;
    if (m.about && !m.about.startsWith('S:') && m.imp >= 0.85) props.push({ kind: 'avenge', pri: 0.75 + t.courage * 0.2, desc: `see justice done for the dead`, data: { species: -1, creatureName: 'killers', victim: m.text.split(' ')[0] }, days: 6 });
  }
  // Ordinary hunting.
  if (jobGoals.includes('hunt') && !has('hunt') && rec.siteId) {
    const sp = h.speciesFor(rec.siteId, 'grazer');
    if (sp.length) {
      const species = rng.pick(sp);
      props.push({ kind: 'hunt', pri: 0.35 + rng.float() * 0.3, desc: `bring home a ${h.speciesName(species)}`, data: { species, creatureName: h.speciesName(species), role: 'grazer' }, days: 2 });
    }
  }
  // Curiosity about nearby POIs.
  if (jobGoals.includes('investigate') && !has('investigate') && s) {
    const pois = h.pois(s.x, s.z, 900).filter((p) => p.kind !== 'camp');
    if (pois.length) {
      const p = rng.pick(pois);
      const way = h.describeWay(here, [p.x, p.y, p.z]);
      const danger = p.kind === 'lair' || p.kind === 'battlefield' || p.kind === 'crashsite' ? 0.6 : p.kind === 'ruin' || p.kind === 'tower' ? 0.35 : 0.15;
      props.push({ kind: 'investigate', pri: 0.45 + t.openness * 0.3 + rng.float() * 0.25, desc: `learn the secrets of the ${poiName(p.kind)} to the ${way.dir}`, data: { poi: p.id, poiKind: p.kind, poiName: poiName(p.kind), x: p.x, y: p.y, z: p.z, danger, way: `to the ${way.dir}` }, days: 5 });
    }
  }
  // Bandit camps: captains and nobles want them gone.
  if ((rec.captain || rec.job === 'noble' || (rec.job === 'adventurer')) && !has('clearCamp')) {
    const camp = nearestCamp({ n, g: { data: {} } as Goal, h });
    if (camp) {
      const way = h.describeWay(here, [camp.x, camp.y, camp.z]);
      props.push({ kind: 'clearCamp', pri: 0.85 + t.courage * 0.2, desc: `rid the land of the bandits camped to the ${way.dir}`, data: { poi: camp.id, x: camp.x, y: camp.y, z: camp.z, way: `to the ${way.dir}` }, days: 6 });
    }
  }
  // Love.
  const crush = relOf('crush');
  if (crush && !has('courtship')) props.push({ kind: 'courtship', pri: 0.55 + t.extraversion * 0.15 + rng.float() * 0.3, desc: `win the heart of ${h.ref(crush[0])!.rec.given}`, data: { target: crush[0] }, days: 6 });
  // Rivalry.
  const rival = relOf('rival');
  if (rival && !has('rivalry') && rng.chance(0.6)) props.push({ kind: 'rivalry', pri: 0.4 - t.agreeableness * 0.2 + rng.float() * 0.3, desc: `get the better of ${h.ref(rival[0])!.rec.given}`, data: { target: rival[0] }, days: 4 });
  // Debts.
  const creditor = relOf('creditor');
  if (creditor && !has('repayDebt')) props.push({ kind: 'repayDebt', pri: 0.5 + t.conscientiousness * 0.3 + (1 - st.needs.wealth) * 0.2, desc: `pay back what is owed to ${h.ref(creditor[0])!.rec.given}`, data: { target: creditor[0], amount: rng.int(20, 70) }, days: 6 });
  // Healing the injured.
  if ((rec.job === 'healer' || rec.job === 'priest') && !has('heal') && rec.siteId) {
    const hurt = h.residents(rec.siteId).find((r) => r !== n && r.st.alive && r.st.injury > 0.3);
    if (hurt) props.push({ kind: 'heal', pri: 0.9, desc: `tend to ${hurt.rec.given}'s wounds`, data: { target: hurt.rec.id }, days: 2 });
  }
  if (jobGoals.includes('gatherHerbs') && !has('gatherHerbs') && (st.stock.herbs ?? 0) < 2) props.push({ kind: 'gatherHerbs', pri: 0.45 + rng.float() * 0.2, desc: 'restock herbs and reagents', data: {}, days: 3 });
  // Feasts after good news (weddings, cleared camps) or just because.
  if (jobGoals.includes('feast') && !has('feast') && rng.chance(0.25 + t.extraversion * 0.15)) props.push({ kind: 'feast', pri: 0.35 + t.extraversion * 0.2, desc: `throw a feast for ${s?.name ?? 'everyone'}`, data: {}, days: 4 });
  // Faith.
  if (t.piety > 0.35 && !has('pilgrimage') && (st.needs.faith < 0.5 || jobGoals.includes('pilgrimage')) && s) {
    const shrines = h.pois(s.x, s.z, 1200).filter((p) => p.kind === 'shrine' || p.kind === 'wayshrine' || p.kind === 'monolith');
    const p = shrines.length ? rng.pick(shrines) : null;
    props.push({ kind: 'pilgrimage', pri: 0.3 + t.piety * 0.4, desc: p ? `make a pilgrimage to the ${poiName(p.kind)}` : 'keep a holy vigil', data: p ? { poi: p.id, poiName: poiName(p.kind), x: p.x, y: p.y, z: p.z } : {}, days: 5 });
  }
  // Apprentices.
  if (jobGoals.includes('recruit') && !has('recruit') && rec.siteId && !Object.values(rec.relations).some((r) => r.kind === 'apprentice')) {
    const cands = h.residents(rec.siteId).filter((r) => r.rec.ageStage === 'adult' && r.rec.age < rec.age && r !== n && !rec.relations[r.rec.id] && r.st.alive);
    if (cands.length) {
      const c = rng.pick(cands);
      const desc = rec.job === 'elder' || rec.job === 'noble' ? `groom ${c.rec.given} to take a seat on the council` : rec.job === 'priest' ? `bring ${c.rec.given} into the service of the temple` : `take ${c.rec.given} on as an apprentice`;
      props.push({ kind: 'recruit', pri: 0.3 + rng.float() * 0.2, desc, data: { target: c.rec.id }, days: 4 });
    }
  }
  // Destroyed buildings: the NPC system flags owners and builders ("ruined:<what>:x:y:z").
  for (const [k, v] of Object.entries(st.flags)) {
    if (!k.startsWith('ruined:') || !v || has('rebuild')) continue;
    const [, what, x, y, z] = k.split(':');
    props.push({ kind: 'rebuild', pri: 0.75 + t.conscientiousness * 0.2, desc: `rebuild the ruined ${what}`, data: { what, x: +x, y: +y, z: +z }, days: 6 });
    delete st.flags[k];
  }
  // Life dream (low priority, always available).
  if (!has('ambition') && jobGoals.includes('ambition')) props.push({ kind: 'ambition', pri: 0.2 + t.openness * 0.1 + rng.float() * 0.2, desc: rec.ambition.replace(/^to /, ''), data: { p: 0 }, days: 10 });

  if (!props.length) return null;
  for (const p of props) p.pri += rng.float() * 0.15;
  props.sort((a, b) => b.pri - a.pri);
  const p = props[0];
  const now = h.now();
  return {
    id: `${rec.id}:g${Math.floor(now * 10)}`, kind: p.kind, desc: p.desc, data: p.data, plan: [], step: 0, tasks: [], taskIdx: 0, taskT: 0, status: 'active',
    created: now, deadline: now + p.days * 24, blocked: [], help: false, quests: {}, progress: 0,
  };
}

export function failGoal(c: GoalCtx) {
  GOALS[c.g.kind]?.failed?.(c);
}

export type { NpcJob };
