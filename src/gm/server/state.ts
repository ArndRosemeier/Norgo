/**
 * Per-player game master state and the host interface the GM's sub-modules
 * (narrator, director, quest book, oracle) use to talk back to the GameMaster.
 * State is keyed by player *name* (like the PlayerSystem's save) so it survives
 * reconnects and save/load; entity ids are per session.
 */
import type { ServerContext } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { Rng } from '../../core/rng';
import type { GmMessageKind, GmMessage, QuestObjectiveSpec, QuestSpec, QuestStatus } from '../types';
import type { Vec3, EntityId } from '../../shared/types';
import type { WorldLore } from '../lore';
import { PlayerModel, type PlayerModelState } from './PlayerModel';
import { VarietyMemory, type VarietyState } from '../text';
import { ScoutMemory } from './Scout';

export interface SayExtra {
  pos?: Vec3;
  quest?: string;
  title?: string;
  tone?: GmMessage['tone'];
  /** Ambient messages wait in a queue so narration never floods; urgent ones go out now. */
  priority?: 'ambient' | 'normal' | 'urgent';
  /** Past-tense line to record as a story beat for recaps ("Completed X"). */
  beat?: string;
  /** Do not add to the journal log. */
  noLog?: boolean;
}

/** Notable moments, kept for recaps and the "story so far". */
export interface StoryBeat {
  t: number;
  day: number;
  text: string;
}

export type Phase = 'calm' | 'build' | 'peak' | 'relief';

export interface DirectorState {
  phase: Phase;
  phaseUntil: number;
  /** 0..1 smoothed tension the player experiences. */
  tension: number;
  /** Director-injected intensity (decays). */
  intensity: number;
  nextDecisionAt: number;
  /** Recent decisions (type → server time), for variety & cooldowns. */
  lastByType: Record<string, number>;
  history: { type: string; t: number }[];
  /** Pre-committed peak event, foreshadowed by an omen. */
  planned: { type: string; dir: number; omen: boolean; at: number; data?: Record<string, unknown> } | null;
  lastCombatAt: number;
  lastHurtAt: number;
  lastDeathAt: number;
  lastNearDeathAt: number;
  inDialogUntil: number;
  /** Entities spawned by the director (hostile encounters) still alive. */
  spawned: EntityId[];
  /** Server time of the last ambient narration. */
  lastAmbientAt: number;
}

export interface NemesisRecord {
  id: string;
  name: string;
  species: number;
  seed: number;
  /** Times encountered / times it beat the player. */
  encounters: number;
  victories: number;
  scars: string[];
  defeated: boolean;
  lastSeen: number;
  growth: number;
}

export interface RecurringCharacter {
  name: string;
  race: string;
  kind: string;
  seed: number;
  meetings: number;
  lastMet: number;
  /** Figure id if this is a living legend from the lore. */
  figure?: string;
}

export interface ObjectiveRuntime {
  spec: QuestObjectiveSpec;
  id: string;
  count: number;
  done: boolean;
  optional?: boolean;
  /** GM-only mechanics attached to an objective. */
  aux?: {
    /** Stay within radius for `secs` (optionally only at night) → advances a custom objective. */
    linger?: { pos: Vec3; radius: number; secs: number; night?: boolean; acc: number; hint?: string };
    /** Spawn targets for a kill objective when the player comes near. */
    spawn?: {
      kind: 'creature' | 'wanderer';
      species?: number;
      wanderer?: string;
      count: number;
      pos: Vec3;
      boss?: boolean;
      name?: string;
      title?: string;
      ids: EntityId[];
      seed: number;
      failed?: boolean;
    };
    /** Riddle answers (lowercase keywords) spoken to the GM near pos. */
    riddle?: { answers: string[]; pos: Vec3; question: string };
  };
}

export interface QuestRecord {
  id: string;
  spec: QuestSpec;
  status: QuestStatus;
  objectives: ObjectiveRuntime[];
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
  expiresAt?: number;
  /** Offered quests lapse if ignored. */
  offerExpiresAt?: number;
  tracked: boolean;
  /** Reveal objectives one by one. */
  sequential: boolean;
  /** Personal arc id + stage. */
  arc?: { id: string; stage: number };
  /** Origin POI/site/event id (dedupe). */
  origin?: string;
}

export interface ArcState {
  id: string;
  style: string;
  stage: number;
  done: boolean;
  /** Named pieces (relic, figure, villain...). */
  data: Record<string, string | number>;
}

export interface PlayerGmSave {
  name: string;
  firstSeen: number;
  lastSeen: number;
  lastDay: number;
  sessions: number;
  model: PlayerModelState;
  variety: VarietyState;
  flags: Record<string, number>;
  director: DirectorState;
  quests: QuestRecord[];
  bounty: Record<string, number>;
  nemeses: NemesisRecord[];
  recurring: RecurringCharacter[];
  beats: StoryBeat[];
  arc: ArcState | null;
  scout: ReturnType<ScoutMemory['save']>;
  rngCounter: number;
  seenSpecies: string[];
  visitedBiomes: number[];
  generatedOrigins: string[];
}

/** Live per-player GM state. */
export class PlayerGm {
  entity: ServerEntity | null = null;
  name: string;
  firstSeen = 0;
  lastSeen = 0;
  lastDay = 0;
  sessions = 0;
  model = new PlayerModel();
  variety = new VarietyMemory();
  /** Throttle stamps & one-shot flags: key → server time. */
  flags: Record<string, number> = {};
  director: DirectorState;
  quests: QuestRecord[] = [];
  /** Bounty in coins per power id. */
  bounty: Record<string, number> = {};
  nemeses: NemesisRecord[] = [];
  recurring: RecurringCharacter[] = [];
  beats: StoryBeat[] = [];
  arc: ArcState | null = null;
  scout = new ScoutMemory();
  rngCounter = 0;
  seenSpecies = new Set<string>();
  visitedBiomes = new Set<number>();
  /** POI/site/event ids that already produced a quest. */
  generatedOrigins = new Set<string>();
  /** Session-only tracking. */
  live = {
    lastPos: [0, 0, 0] as Vec3,
    lastBiome: -1,
    underworld: false,
    gravityBand: 0 as -1 | 0 | 1,
    lastMoveAt: 0,
    idleSince: 0,
    queue: [] as { msg: GmMessage; extra: SayExtra; until: number }[],
    pendingRecap: false,
    joinedAt: 0,
    lastHp: 0,
  };

  constructor(name: string, now: number) {
    this.name = name;
    this.firstSeen = now;
    this.director = {
      phase: 'calm', phaseUntil: now + 150, tension: 0.1, intensity: 0, nextDecisionAt: now + 45, lastByType: {}, history: [], planned: null,
      lastCombatAt: -1e9, lastHurtAt: -1e9, lastDeathAt: -1e9, lastNearDeathAt: -1e9, inDialogUntil: 0, spawned: [], lastAmbientAt: -1e9,
    };
  }

  /** Has `key` been flagged within `cooldown` seconds? Sets the flag if not. */
  throttle(key: string, now: number, cooldown: number): boolean {
    const t = this.flags[key];
    if (t !== undefined && now - t < cooldown) return true;
    this.flags[key] = now;
    return false;
  }

  beat(text: string, now: number, day: number) {
    this.beats.push({ t: now, day, text });
    if (this.beats.length > 80) this.beats.shift();
  }

  save(): PlayerGmSave {
    return {
      name: this.name, firstSeen: this.firstSeen, lastSeen: this.lastSeen, lastDay: this.lastDay, sessions: this.sessions, model: this.model.save(),
      variety: this.variety.save(), flags: this.flags, director: { ...this.director, spawned: [] }, quests: this.quests, bounty: this.bounty,
      nemeses: this.nemeses, recurring: this.recurring, beats: this.beats, arc: this.arc, scout: this.scout.save(), rngCounter: this.rngCounter,
      seenSpecies: [...this.seenSpecies], visitedBiomes: [...this.visitedBiomes], generatedOrigins: [...this.generatedOrigins].slice(-400),
    };
  }

  static load(s: PlayerGmSave, now: number): PlayerGm {
    const g = new PlayerGm(s.name, now);
    g.firstSeen = s.firstSeen;
    g.lastSeen = s.lastSeen;
    g.lastDay = s.lastDay ?? 0;
    g.sessions = s.sessions;
    g.model.load(s.model);
    g.variety.load(s.variety);
    g.flags = s.flags ?? {};
    if (s.director) g.director = { ...g.director, ...s.director, spawned: [] };
    g.quests = s.quests ?? [];
    g.bounty = s.bounty ?? {};
    g.nemeses = s.nemeses ?? [];
    g.recurring = s.recurring ?? [];
    g.beats = s.beats ?? [];
    g.arc = s.arc ?? null;
    g.scout.load(s.scout);
    g.rngCounter = s.rngCounter ?? 0;
    g.seenSpecies = new Set(s.seenSpecies ?? []);
    g.visitedBiomes = new Set(s.visitedBiomes ?? []);
    g.generatedOrigins = new Set(s.generatedOrigins ?? []);
    return g;
  }
}

/** What GM sub-modules may ask of the GameMaster. */
export interface GmHost {
  readonly ctx: ServerContext;
  readonly lore: WorldLore;
  /** Send narration/hint/etc. to a player (queued, logged to the journal). */
  say(p: ServerEntity, kind: GmMessageKind, text: string, extra?: SayExtra): void;
  /** Runtime RNG for a player decision (seeded, advancing). */
  rng(g: PlayerGm, ...tag: (string | number)[]): Rng;
  state(p: ServerEntity): PlayerGm;
  /** Common template variables for narration (world, palette, lore names, biome...). */
  vars(p: ServerEntity): Record<string, string>;
}
