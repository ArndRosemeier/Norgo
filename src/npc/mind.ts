/**
 * NPC mind state: needs, memories (with gossip-friendly stable ids),
 * dispositions with reasons, goals in progress and persistent life facts
 * (death, travel, debts...). Everything here is JSON-safe so it can be saved
 * verbatim and restored after the settlement is regenerated.
 */
import { clamp } from '../core/math';
import { hashString, type Rng } from '../core/rng';
import type { Vec3 } from '../shared/types';
import type { GoalKind } from './jobs';
import type { NeedId, NpcTraits } from './types';
import type { NpcRecord } from './population';

export type MemoryKind =
  | 'death' | 'crime' | 'monster' | 'weather' | 'destroyed' | 'gossip' | 'quest' | 'player' | 'trade' | 'event' | 'rumor'
  | 'personal' | 'love' | 'travel' | 'combat' | 'help';

export interface Memory {
  /** Stable id so the same fact spreading by gossip is not duplicated. */
  id: string;
  /** A clause usable after "I heard that ..." / as {fact}: "a wolf killed Bram's goats near the mill". */
  text: string;
  kind: MemoryKind;
  /** 0..1 */
  imp: number;
  /** World time in hours (day * 24 + hour). */
  t: number;
  /** Subject key (record id, 'P:<player name>', species id...). */
  about?: string;
  /** Learned second-hand. */
  heard?: boolean;
  /** Who told it (record id or name). */
  from?: string;
  pos?: Vec3;
  /** How often this memory has been passed on (limits gossip spam). */
  told?: number;
}

export interface DispReason {
  r: string;
  d: number;
  t: number;
}

export interface DispEntry {
  /** Accumulated delta on top of the base attitude. */
  v: number;
  reasons: DispReason[];
}

/** One step of a goal plan. Tasks are executed physically when the NPC is spawned and abstractly by time otherwise. */
export type Task =
  | { k: 'goto'; to: Vec3; label: string; run?: boolean; building?: string | null }
  | { k: 'work'; anims: string[]; hours: number; label: string; at?: Vec3; yaw?: number }
  | { k: 'travel'; to: Vec3; site?: string | null; hours: number; label: string }
  | { k: 'askHelp'; hours: number; label: string }
  | { k: 'visit'; npc: string; hours: number; label: string; topic: 'court' | 'rival' | 'debt' | 'gossip' | 'recruit' | 'heal' }
  | { k: 'hunt'; hours: number; label: string; at: Vec3 }
  | { k: 'effect'; fx: string; label: string };

export type GoalStatus = 'active' | 'waiting' | 'done' | 'failed';

export interface Goal {
  id: string;
  kind: GoalKind;
  /** Clause: "find iron ore for the forge". */
  desc: string;
  data: Record<string, string | number>;
  /** GOAP plan (action ids) and execution cursor. */
  plan: string[];
  step: number;
  tasks: Task[];
  taskIdx: number;
  /** Hours spent on the current task. */
  taskT: number;
  status: GoalStatus;
  created: number;
  deadline: number;
  /** Actions that failed — excluded on replanning. */
  blocked: string[];
  /** The NPC would welcome a player's help (Questgiver). */
  help: boolean;
  /** Quest created for a player: questId → player key. */
  quests: Record<string, string>;
  progress: number;
}

export interface NpcState {
  alive: boolean;
  death?: { t: number; cause: string; by?: string };
  needs: Record<NeedId, number>;
  coins: number;
  stock: Record<string, number>;
  mem: Memory[];
  disp: Record<string, DispEntry>;
  /** Affinity changes toward other NPCs (record id → delta). */
  rel: Record<string, number>;
  /** Relation kind overrides (courtship → spouse, feud → enemy...). */
  relKind: Record<string, string>;
  goals: Goal[];
  /** World hour at which new goals may be considered. */
  nextGoalAt: number;
  goalsDone: number;
  goalsFailed: number;
  /** Away from the settlement until world hour `until`. */
  away?: { until: number; site?: string | null; label: string };
  jailedUntil?: number;
  injury: number;
  /** Last talk with players (key → world hour). */
  talked: Record<string, number>;
  /** Trade price modifier per player key (barter results). */
  price: Record<string, number>;
  /** Free-form flags (secret revealed, camp cleared, ...). */
  flags: Record<string, number>;
  /** Last known position (restored when re-spawned). */
  pos?: Vec3;
}

export const MAX_MEMORIES = 28;

export function newState(rec: NpcRecord, rng: Rng): NpcState {
  const r = () => rng.range(0.55, 0.95);
  return {
    alive: true,
    needs: { hunger: r(), energy: r(), social: r(), fun: r(), safety: 1, wealth: clamp(0.3 + rec.wealth * 0.6, 0, 1), faith: r() },
    coins: Math.round(5 + rec.wealth * 180 * rng.range(0.6, 1.4)),
    stock: {},
    mem: [],
    disp: {},
    rel: {},
    relKind: {},
    goals: [],
    nextGoalAt: rng.range(0, 10),
    goalsDone: 0,
    goalsFailed: 0,
    injury: 0,
    talked: {},
    price: {},
    flags: {},
  };
}

export function memoryId(kind: MemoryKind, text: string): string {
  return kind[0] + hashString(text).toString(36);
}

/**
 * Store a memory. Duplicates refresh importance; capacity pressure evicts the
 * least valuable memory (importance decays with age).
 */
export function addMemory(s: NpcState, m: Omit<Memory, 'id'> & { id?: string }, now: number): Memory {
  const id = m.id ?? memoryId(m.kind, m.text);
  const ex = s.mem.find((x) => x.id === id);
  if (ex) {
    ex.imp = Math.max(ex.imp, m.imp);
    ex.t = Math.max(ex.t, m.t);
    return ex;
  }
  const mem: Memory = { ...m, id };
  s.mem.push(mem);
  if (s.mem.length > MAX_MEMORIES) {
    let worst = 0, ws = Infinity;
    for (let i = 0; i < s.mem.length; i++) {
      const v = memoryValue(s.mem[i], now);
      if (v < ws) (ws = v), (worst = i);
    }
    s.mem.splice(worst, 1);
  }
  return mem;
}

/** Salience of a memory now: importance fading over ~10 days, first-hand memories stick better. */
export function memoryValue(m: Memory, now: number): number {
  const ageDays = Math.max(0, now - m.t) / 24;
  return m.imp * (m.heard ? 0.8 : 1) / (1 + ageDays * 0.25);
}

/** The memory most worth sharing (for gossip & rumors), excluding ids in `skip`. */
export function juiciest(s: NpcState, now: number, skip?: (m: Memory) => boolean): Memory | null {
  let best: Memory | null = null, bv = 0.12;
  for (const m of s.mem) {
    if (skip?.(m)) continue;
    if (m.kind === 'personal' && m.imp < 0.6) continue;
    const v = memoryValue(m, now) / (1 + (m.told ?? 0) * 0.35);
    if (v > bv) (bv = v), (best = m);
  }
  return best;
}

// ------------------------------------------------------------------ needs

/** Per-hour need drift while awake; activities restore needs in `satisfy`. */
const DECAY: Record<NeedId, number> = { hunger: 0.065, energy: 0.05, social: 0.045, fun: 0.035, safety: -0.12, wealth: 0.004, faith: 0.02 };

export function decayNeeds(s: NpcState, t: NpcTraits, hours: number, sleeping: boolean) {
  const n = s.needs;
  n.hunger = clamp(n.hunger - DECAY.hunger * hours * (sleeping ? 0.4 : 1), 0, 1);
  n.energy = clamp(n.energy + (sleeping ? 0.13 : -DECAY.energy * (1 + s.injury)) * hours, 0, 1);
  n.social = clamp(n.social - DECAY.social * hours * (1 + t.extraversion * 0.6) * (sleeping ? 0.3 : 1), 0, 1);
  n.fun = clamp(n.fun - DECAY.fun * hours * (1 + t.openness * 0.3) * (sleeping ? 0.3 : 1), 0, 1);
  n.safety = clamp(n.safety + 0.12 * hours, 0, 1);
  n.faith = clamp(n.faith - DECAY.faith * hours * Math.max(0, 0.3 + t.piety), 0, 1);
  s.injury = clamp(s.injury - 0.02 * hours, 0, 1);
}

/** Need effects of performing an activity for `hours`. */
export function satisfy(s: NpcState, activity: string, hours: number) {
  const n = s.needs;
  switch (activity) {
    case 'eat':
      n.hunger = clamp(n.hunger + 0.9 * hours, 0, 1);
      n.social = clamp(n.social + 0.05 * hours, 0, 1);
      break;
    case 'socialize':
    case 'talk':
      n.social = clamp(n.social + 0.35 * hours, 0, 1);
      n.fun = clamp(n.fun + 0.1 * hours, 0, 1);
      break;
    case 'tavern':
      n.social = clamp(n.social + 0.3 * hours, 0, 1);
      n.fun = clamp(n.fun + 0.3 * hours, 0, 1);
      n.hunger = clamp(n.hunger + 0.2 * hours, 0, 1);
      break;
    case 'play':
    case 'wander':
      n.fun = clamp(n.fun + 0.3 * hours, 0, 1);
      break;
    case 'pray':
      n.faith = clamp(n.faith + 0.6 * hours, 0, 1);
      n.safety = clamp(n.safety + 0.1 * hours, 0, 1);
      break;
    case 'work':
    case 'market':
    case 'beg':
      n.wealth = clamp(n.wealth + 0.01 * hours, 0, 1);
      break;
  }
}

export type Mood = 'neutral' | 'happy' | 'angry' | 'sad' | 'afraid' | 'surprised' | 'disgusted' | 'focused' | 'pain';

/** Facial mood from needs, recent memories and personality. */
export function moodOf(s: NpcState, t: NpcTraits, now: number): Mood {
  if (!s.alive) return 'neutral';
  if (s.injury > 0.5) return 'pain';
  if (s.needs.safety < 0.35) return 'afraid';
  // Fresh grief or anger dominates for a while.
  for (const m of s.mem) {
    if (now - m.t > 30 || m.heard) continue;
    if (m.kind === 'death' && m.imp >= 0.75) return 'sad';
    if (m.kind === 'crime' && m.imp >= 0.7 && t.agreeableness < 0.2) return 'angry';
  }
  const avg = (s.needs.hunger + s.needs.energy + s.needs.social + s.needs.fun) / 4;
  if (avg < 0.3) return t.neuroticism > 0.2 ? 'sad' : 'angry';
  if (avg > 0.72 && t.neuroticism < 0.3) return 'happy';
  return 'neutral';
}

// ------------------------------------------------------------------ disposition

export function dispDelta(s: NpcState, key: string): number {
  return s.disp[key]?.v ?? 0;
}

export function addDisp(s: NpcState, key: string, delta: number, reason: string, now: number) {
  const e = (s.disp[key] ??= { v: 0, reasons: [] });
  e.v = clamp(e.v + delta, -160, 160);
  // Merge repeated reasons so the list stays meaningful.
  const ex = e.reasons.find((r) => r.r === reason);
  if (ex) {
    ex.d += delta;
    ex.t = now;
  } else e.reasons.push({ r: reason, d: delta, t: now });
  if (e.reasons.length > 8) {
    e.reasons.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    e.reasons.length = 8;
  }
}

/** Strongest reasons behind a disposition (for dialog: "You helped me with the ore"). */
export function topReasons(s: NpcState, key: string, n = 2): DispReason[] {
  const e = s.disp[key];
  if (!e) return [];
  return [...e.reasons].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, n);
}

/** Disposition tier names used by dialog greetings. */
export function dispTier(v: number): 'hostile' | 'cold' | 'neutral' | 'warm' | 'friend' {
  return v <= -50 ? 'hostile' : v <= -15 ? 'cold' : v < 20 ? 'neutral' : v < 55 ? 'warm' : 'friend';
}

export function worldHours(day: number, hour: number): number {
  return day * 24 + hour;
}
