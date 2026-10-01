/**
 * Virtual Game Master messages & journal model.
 * Inspired by the "virtual game master" idea: an always-on narrator/director
 * that observes the player, paces tension, weaves events and quests, and can
 * be addressed directly by the player.
 */
import type { Vec3 } from '../shared/types';

export type GmMessageKind = 'narration' | 'hint' | 'event' | 'quest' | 'rumor' | 'reply' | 'omen' | 'recap';

export interface GmMessage {
  id: string;
  kind: GmMessageKind;
  text: string;
  /** Server time. */
  t: number;
  /** Optional location marker. */
  pos?: Vec3;
  /** Related quest id. */
  quest?: string;
  /** Short heading (place / quest name) for toasts. */
  title?: string;
  /** Tone hint for styling. */
  tone?: GmMessageExtras['tone'];
}

export type QuestStatus = 'offered' | 'active' | 'completed' | 'failed' | 'abandoned';

export interface QuestObjective {
  id: string;
  text: string;
  done: boolean;
  /** Progress counter (e.g. 3/5). */
  count?: number;
  target?: number;
  pos?: Vec3;
  optional?: boolean;
}

export interface QuestView {
  id: string;
  title: string;
  giver?: string;
  summary: string;
  status: QuestStatus;
  objectives: QuestObjective[];
  rewards: string[];
  /** Origin: npc agenda, gm event, poi discovery... */
  source: string;
  tracked?: boolean;
  expiresAt?: number;
  category?: QuestViewExtras['category'];
  level?: number;
  updatedAt?: number;
}

export interface JournalState {
  quests: QuestView[];
  /** Recent GM messages (most recent last). */
  log: GmMessage[];
  /** Discovered places. */
  discoveries: { id: string; name: string; pos: Vec3; kind: string }[];
}

/** Declarative quest description any system can submit to the game master. */
export interface QuestSpec {
  title: string;
  summary: string;
  /** NPC entity id or name of the quest giver. */
  giver?: string;
  giverId?: number;
  source: 'npc' | 'gm' | 'poi' | 'settlement' | 'player';
  objectives: QuestObjectiveSpec[];
  rewards: { coins?: number; items?: string[]; xp?: Record<string, number>; reputation?: Record<string, number>; text?: string };
  /** Seconds until it expires (optional). */
  timeLimit?: number;
  /** Arbitrary data for the originating system. */
  meta?: Record<string, unknown>;
  /** Skip the offer step: the quest starts active (e.g. accepted inside a dialog). */
  autoAccept?: boolean;
  category?: QuestViewExtras['category'];
}

export type QuestObjectiveSpec =
  | { kind: 'kill'; text: string; species?: number; faction?: string; tag?: string; count: number; pos?: Vec3 }
  | { kind: 'collect'; text: string; itemDef: string; count: number }
  | { kind: 'deliver'; text: string; itemDef: string; count: number; toNpc: number }
  | { kind: 'goto'; text: string; pos: Vec3; radius: number }
  | { kind: 'talk'; text: string; npc: number }
  | { kind: 'escort'; text: string; npc: number; pos: Vec3; radius: number }
  | { kind: 'harvest'; text: string; objectKind: string; count: number }
  | { kind: 'discover'; text: string; poi?: string; site?: string }
  | { kind: 'ability'; text: string; ability: string; count: number }
  | { kind: 'custom'; text: string; event: string; count: number };

// ------------------------------------------------------------------ extensions (all optional, compatible)

/**
 * Optional presentation hints carried by GM messages. The UI may ignore them;
 * they let a journal/HUD style omens differently from quest notices.
 */
export interface GmMessageExtras {
  /** Short heading (e.g. quest title, place name) for toasts. */
  title?: string;
  /** Emotional tone for styling: 'calm' | 'tense' | 'dread' | 'wonder' | 'triumph' | 'grief'. */
  tone?: 'calm' | 'tense' | 'dread' | 'wonder' | 'triumph' | 'grief';
}

/** Extra optional QuestView fields the game master fills in. */
export interface QuestViewExtras {
  /** True for the single quest the player chose to track (HUD marker). */
  tracked?: boolean;
  /** Server time when the quest expires. */
  expiresAt?: number;
  /** Quest flavour: personal 'arc' stories, 'side' quests, 'bounty' consequences, 'event' world events, 'npc' requests. */
  category?: 'arc' | 'side' | 'bounty' | 'event' | 'npc';
  /** Recommended power level (sum of the player's best skills, rough). */
  level?: number;
  /** Status change time (server time). */
  updatedAt?: number;
}

/**
 * Bus convention for 'custom' quest objectives: any system may emit
 * `ctx.bus.emit('questCustom', { player, event, count? })` (player = ServerEntity);
 * the game master advances every active custom objective whose `event` matches.
 */
export const QUEST_CUSTOM_EVENT = 'questCustom';
