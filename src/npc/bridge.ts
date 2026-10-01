/**
 * NPC ↔ dialog bridge. The dialog system needs deep, read-mostly access to NPC
 * minds (memories, goals, relations, needs) and a few verbs (start/stop
 * talking, offer/accept quests, adjust prices). The NpcSystem implements this
 * on top of `NpcService`; the dialog system feature-detects it on
 * `ctx.services.npcs` so the two domains stay decoupled at the type level.
 */
import type { Vec3 } from '../shared/types';
import type { ServerEntity } from '../server/entity';
import type { NpcService } from '../server/context';
import type { SettlementLayout } from '../settlements/types';
import type { SiteInfo } from '../world/sites';
import type { QuestSpec } from '../gm/types';
import type { Deity, NpcIntrospection } from './types';
import type { NpcRecord } from './population';
import type { Goal, Memory, Mood, NpcState } from './mind';
import type { ActivityKind } from './jobs';

export interface NpcPerson {
  id: string;
  name: string;
  given: string;
  job: string;
  relation: string | null;
  affinity: number;
  alive: boolean;
  away: boolean;
  activity: string;
}

export interface NpcDialogInfo {
  entity: ServerEntity;
  rec: NpcRecord;
  st: NpcState;
  site: SiteInfo | null;
  layout: SettlementLayout | null;
  activity: ActivityKind;
  activityLabel: string;
  mood: Mood;
  deity: Deity | null;
  /** Current active goal (if any). */
  goal: Goal | null;
  /** World time in hours. */
  now: number;
  /** Is this a wanderer / camp member. */
  wanderer: string | null;
}

export interface QuestOffer {
  goalId: string;
  spec: QuestSpec;
  /** Goal clause for the pitch ("find iron ore for the forge"). */
  goal: string;
  /** Player was explicitly asked by the NPC (help wanted) vs. offering help. */
  wanted: boolean;
}

export interface NpcDialogBridge extends NpcService, NpcIntrospection {
  npcInfo(entityId: number): NpcDialogInfo | null;
  /** NPC stops, faces the player and enters 'talk' activity. */
  beginTalk(entityId: number, player: ServerEntity): void;
  endTalk(entityId: number, player: ServerEntity): void;
  /** Lip-flap & expression while a line is "spoken". */
  setTalking(entityId: number, talking: boolean, mood?: Mood): void;
  /** Play a one-shot gesture on the NPC. */
  gesture(entityId: number, anim: string, dur?: number): void;
  dispositionInfo(entityId: number, player: ServerEntity): { value: number; reasons: string[] };
  /** People the NPC knows (family, friends, rivals, neighbours) with resolved names. */
  people(entityId: number): NpcPerson[];
  /** Memories worth telling the player (rumors), freshest & juiciest first. */
  rumors(entityId: number, n: number): Memory[];
  /** Mark a memory as told (reduces repetition). */
  told(entityId: number, memoryId: string): void;
  /** Quest the NPC could give this player now. */
  questOffer(entityId: number, player: ServerEntity): QuestOffer | null;
  /** Accept: creates the quest via the game master and links it to the goal. `rewardMul` scales coin rewards (negotiation). Returns quest id or null. */
  acceptQuest(entityId: number, player: ServerEntity, goalId: string, rewardMul?: number): string | null;
  /** Has this player an open quest from this NPC (goal id → quest id). */
  openQuests(entityId: number, player: ServerEntity): { goal: string; quest: string }[];
  /** Barter/persuasion results: multiply prices for this player (clamped). */
  setPriceModifier(entityId: number, player: ServerEntity, mult: number): void;
  /** Store a memory about the player for this NPC. */
  rememberPlayer(entityId: number, player: ServerEntity, text: string, kind: Memory['kind'], importance: number): void;
  /** Places worth giving directions to from here (sites, POIs, buildings). */
  landmarks(entityId: number): { id: string; name: string; kind: string; pos: Vec3 }[];
  /** Nearby creature species names seen recently (for rumors). */
  creaturesNear(entityId: number): string[];
  /** World facts for LLM prompts (time, weather, place, leader...). */
  worldFacts(entityId: number): Record<string, string>;
}

export function isBridge(x: unknown): x is NpcDialogBridge {
  return !!x && typeof (x as NpcDialogBridge).npcInfo === 'function';
}
