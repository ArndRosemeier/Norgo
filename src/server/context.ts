/**
 * Server context & service contracts.
 *
 * The GameServer owns the world state and a set of systems. Each domain module
 * implements one or more systems and exposes its public API as a service
 * interface below, so other systems can call it without importing internals.
 */
import type { WorldGenerator } from '../world/generator';
import type { TerrainCollider } from '../world/collider';
import type { EditStore, TerrainEdit } from '../world/edits';
import type { Rng } from '../core/rng';
import type { Emitter } from '../core/events';
import type { EntityStore, ServerEntity } from './entity';
import type { ClientMessage, GameEvent, ServerMessage, ObjectState } from '../shared/protocol';
import type { DamageType, EntityId, Vec3, WeatherState } from '../shared/types';
import type { ItemInstance } from '../items/types';
import type { SettlementLayout, BuildingInfo } from '../settlements/types';
import type { NpcProfile } from '../npc/types';
import type { GmMessageKind, QuestSpec } from '../gm/types';
import type { SiteInfo, PoiInfo } from '../world/sites';

// ------------------------------------------------------------------ bus events

/**
 * Server-wide event bus. Every notable thing that happens is published here,
 * so the game master, quests, NPC memories, skills etc. can react.
 */
export interface ServerBusEvents extends Record<string, unknown> {
  damage: { target: ServerEntity; source?: ServerEntity; amount: number; type: DamageType; ability?: string };
  death: { entity: ServerEntity; killer?: ServerEntity };
  heal: { target: ServerEntity; source?: ServerEntity; amount: number };
  abilityUsed: { caster: ServerEntity; ability: string; target?: ServerEntity; point?: Vec3 };
  skillXp: { entity: ServerEntity; skill: string; amount: number; level: number; leveled: boolean };
  abilityUnlocked: { entity: ServerEntity; ability: string };
  itemAcquired: { entity: ServerEntity; item: ItemInstance; how: 'loot' | 'buy' | 'craft' | 'harvest' | 'gift' | 'quest' | 'steal' | 'pickup' };
  itemLost: { entity: ServerEntity; item: ItemInstance; how: 'sell' | 'drop' | 'consume' | 'give' | 'break' };
  itemEquipped: { entity: ServerEntity; item: ItemInstance };
  objectDamaged: { id: number | string; source?: ServerEntity; amount: number; kind: string; pos: Vec3 };
  objectDestroyed: { id: number | string; source?: ServerEntity; kind: string; pos: Vec3 };
  harvest: { entity: ServerEntity; kind: string; pos: Vec3; items: ItemInstance[] };
  terrainEdited: { edit: TerrainEdit; source?: ServerEntity };
  enterSite: { player: ServerEntity; site: SiteInfo };
  leaveSite: { player: ServerEntity; site: SiteInfo };
  discoverPoi: { player: ServerEntity; poi: PoiInfo };
  enterBiome: { player: ServerEntity; biome: number; name: string };
  dialogStarted: { player: ServerEntity; npc: ServerEntity };
  dialogEvent: { player: ServerEntity; npc: ServerEntity; event: string; data?: unknown };
  questEvent: { player: ServerEntity; quest: string; event: 'offered' | 'accepted' | 'progress' | 'completed' | 'failed' | 'abandoned' };
  crime: { offender: ServerEntity; victim?: ServerEntity; kind: 'assault' | 'murder' | 'theft' | 'vandalism' | 'trespass'; pos: Vec3 };
  playerJoined: { player: ServerEntity };
  playerDied: { player: ServerEntity; killer?: ServerEntity };
  timeOfDay: { hour: number; day: number };
  weatherChanged: { weather: WeatherState };
  gmAsk: { player: ServerEntity; text: string };
}

// ------------------------------------------------------------------ services

export interface CombatService {
  /** Apply damage with resistances/armor; returns damage dealt. Publishes bus + client events. */
  damage(target: ServerEntity, amount: number, type: DamageType, source?: ServerEntity, opts?: { ability?: string; pos?: Vec3; crit?: boolean; knockback?: number }): number;
  heal(target: ServerEntity, amount: number, source?: ServerEntity): number;
  kill(target: ServerEntity, killer?: ServerEntity): void;
  /** Hostility check used by AI and auto-targeting. */
  isHostile(a: ServerEntity, b: ServerEntity): boolean;
  applyEffect(target: ServerEntity, effectId: string, magnitude: number, duration: number, source?: ServerEntity): void;
  /** Push an entity (client players receive a knockback event). */
  knockback(target: ServerEntity, impulse: Vec3): void;
}

export interface SkillService {
  /** Grant skill XP for using a skill. Handles level-ups & unlocks. */
  grantXp(entity: ServerEntity, skill: string, amount: number): void;
  level(entity: ServerEntity, skill: string): number;
  /** Recompute derived stats after equipment/effects change. */
  recomputeStats(entity: ServerEntity): void;
  /** Create the default skills state for a new character (race-aware). */
  initSkills(entity: ServerEntity): void;
}

export interface ItemService {
  create(defId: string, opts?: { count?: number; level?: number; rarity?: string; material?: string; seed?: number; style?: string }): ItemInstance;
  /** Random loot from a loot table id (e.g. "creature.small", "chest.ruin", "npc.guard") */
  rollLoot(table: string, level: number, seed: number): ItemInstance[];
  give(entity: ServerEntity, item: ItemInstance, how?: ServerBusEvents['itemAcquired']['how']): boolean;
  take(entity: ServerEntity, uid: string, count?: number): ItemInstance | null;
  /** Spawn an item entity on the ground. */
  drop(pos: Vec3, item: ItemInstance, vel?: Vec3): ServerEntity;
  equip(entity: ServerEntity, uid: string, slot?: string): boolean;
  /** Generate a fitting outfit for an NPC (race, job, wealth). */
  outfitFor(entity: ServerEntity, job: string, wealth: number, seed: number): void;
  valueOf(item: ItemInstance): number;
  def(defId: string): import('../items/types').ItemDef | undefined;
}

/** Source of destructible objects with string ids of the form "prefix:..." (e.g. building pieces "B:siteId:building:piece"). */
export interface ObjectProvider {
  info(id: string): { kind: string; pos: Vec3; radius: number; maxHp: number; material: string } | null;
  near(pos: Vec3, r: number): { id: string; kind: string; pos: Vec3; radius: number }[];
  /** Called once when the object is destroyed (spawn loot, notify NPCs...). */
  onDestroyed?(id: string, source?: ServerEntity): void;
}

export interface ObjectService {
  /** Register a provider for string ids starting with "prefix:". Numeric ids are scatter objects (trees, rocks...). */
  registerProvider(prefix: string, provider: ObjectProvider): void;
  /** Damage a destructible world object (tree, rock, building piece). Returns remaining hp. */
  damage(id: number | string, amount: number, kind: DamageType | 'chop' | 'mine', source?: ServerEntity, pos?: Vec3): number;
  /** Known objects near a point (scatter objects + building pieces). */
  near(pos: Vec3, r: number): { id: number | string; kind: string; pos: Vec3; radius: number; hp: number }[];
  state(id: number | string): ObjectState | undefined;
}

export interface SettlementService {
  layout(siteId: string): SettlementLayout | null;
  siteAt(pos: Vec3): SiteInfo | null;
  sitesNear(pos: Vec3, r: number): SiteInfo[];
  buildingsNear(pos: Vec3, r: number): BuildingInfo[];
  /** Is a point inside a building footprint (for NPC navigation & collision). */
  insideBuilding(pos: Vec3): BuildingInfo | null;
}

export interface NpcService {
  profile(entityId: EntityId): NpcProfile | undefined;
  /** Spawn/ensure the population of a settlement is loaded. */
  ensureSettlement(siteId: string): void;
  /** Change disposition of an NPC toward an entity. */
  adjustDisposition(npc: EntityId, toward: EntityId, delta: number, reason: string): void;
  disposition(npc: EntityId, toward: EntityId): number;
  /** Spawn a wandering NPC (merchant caravan, bandit, pilgrim...) — used by the game master. */
  spawnWanderer(kind: string, pos: Vec3, seed: number): ServerEntity | null;
  /** Let an NPC remember something (GM, events, crimes). */
  remember(npc: EntityId, fact: string, importance: number): void;
}

export interface CreatureService {
  speciesCount(): number;
  /** Spawn a creature of species near pos. */
  spawn(species: number, pos: Vec3, opts?: { seed?: number; growth?: number; hostile?: boolean; tamedBy?: EntityId; boss?: boolean }): ServerEntity | null;
  /** Species suitable for a biome & role ('predator', 'grazer', 'boss', ...). */
  speciesFor(biome: number, role: string, underworld: boolean): number[];
  speciesName(species: number): string;
  /** Attempt to calm/tame (utility ability). */
  tryTame(creature: ServerEntity, by: ServerEntity, power: number): boolean;
}

export interface DialogService {
  start(player: ServerEntity, npc: ServerEntity): void;
  end(player: ServerEntity): void;
}

export interface GameMasterService {
  narrate(player: ServerEntity, text: string, kind?: GmMessageKind, pos?: Vec3): void;
  /** Create a quest from any system (NPC agendas, POIs, events). Returns quest id. Progress is tracked by the GM via bus events. */
  createQuest(player: ServerEntity, spec: QuestSpec): string;
  /** Offer an existing quest. */
  offerQuest(player: ServerEntity, questId: string): void;
  /** Current tension/pacing 0..1 (other systems may scale encounter difficulty with it). */
  tension(): number;
}

export interface Services {
  combat: CombatService;
  skills: SkillService;
  items: ItemService;
  objects: ObjectService;
  settlements: SettlementService;
  npcs: NpcService;
  creatures: CreatureService;
  dialog: DialogService;
  gm: GameMasterService;
}

// ------------------------------------------------------------------ context

export interface ServerTime {
  /** Seconds since server start (monotonic, used in snapshots). */
  now: number;
  dt: number;
  /** 0..1 time of day. */
  timeOfDay: number;
  day: number;
  /** In-game hour 0..24. */
  hour: number;
}

export interface ServerContext {
  readonly seed: number;
  readonly gen: WorldGenerator;
  /** Analytic terrain queries including edits. */
  readonly terrain: TerrainCollider;
  readonly edits: EditStore;
  readonly entities: EntityStore;
  readonly bus: Emitter<ServerBusEvents>;
  readonly time: ServerTime;
  readonly services: Services;
  weather: WeatherState;

  /** Derived deterministic RNG for a purpose (stable across reloads). */
  rng(...tag: (string | number)[]): Rng;
  /** Spawn (register) a new entity; returns it. */
  spawn(e: ServerEntity): ServerEntity;
  despawn(id: EntityId): void;
  newEntityId(): EntityId;
  /** Send a game event to all players within `radius` of `pos` (or everyone if no pos). */
  broadcast(ev: GameEvent, pos?: Vec3, radius?: number): void;
  /** Send a message to one player. */
  send(playerId: EntityId, msg: ServerMessage): void;
  players(): ServerEntity[];
  /** Apply & replicate a terrain edit (clamped to realistic size). */
  editTerrain(edit: Omit<TerrainEdit, 'id'>, source?: ServerEntity): TerrainEdit;
  /** Ground height under a point (NaN if none). */
  groundAt(x: number, y: number, z: number, maxDrop?: number): number;
  gravityAt(pos: Vec3): number;
  /** Mark that the player's state (inventory, skills...) changed and should be re-sent. */
  markPlayerDirty(playerId: EntityId, ...keys: string[]): void;
  log(...args: unknown[]): void;
}

/** Base class / interface for server systems. */
export interface ServerSystem {
  readonly name: string;
  /** Called once after all systems are constructed. */
  init?(ctx: ServerContext): void;
  /** Every server tick (20 Hz). */
  tick?(dt: number): void;
  /** Once per second. */
  slowTick?(dt: number): void;
  /** Handle a client message; return true if consumed. */
  onMessage?(player: ServerEntity, msg: ClientMessage): boolean;
  onPlayerJoin?(player: ServerEntity): void;
  onEntityRemoved?(e: ServerEntity): void;
  /** Persistence. Return JSON-safe data. */
  save?(): unknown;
  load?(data: unknown): void;
}
