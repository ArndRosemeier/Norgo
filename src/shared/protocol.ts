/**
 * Network protocol between client and (mock) server.
 *
 * Messages are plain structured-clone/JSON-safe objects so the same protocol
 * works over a Worker MessagePort today and a WebSocket later. Typed arrays
 * are allowed only where noted (worker transport transfers them; a socket
 * transport would encode them).
 */
import type { AnimState, EntityId, EntityKind, Speech, Vec3, DamageType, WeatherState } from './types';
import type { HumanoidAppearance } from '../humanoid/types';
import type { CreatureRef } from '../creatures/types';
import type { EquipmentVisuals, Inventory, Equipment, ItemInstance, EquipSlot, ItemVisual } from '../items/types';
import type { SkillsState, Stats, ActiveEffect, AbilityUse } from '../gameplay/types';
import type { DialogView } from '../dialog/types';
import type { GmMessage, JournalState } from '../gm/types';
import type { TerrainEdit } from '../world/edits';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- snapshots

export interface EntitySnapshot {
  id: EntityId;
  kind: EntityKind;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  anim: AnimState;
  hp: number;
  maxHp: number;
  name?: string;
  /** Short title, e.g. "Village Smith", "Ember Stalker (juvenile)". */
  title?: string;
  flags: number;
  faction?: string;
  humanoid?: HumanoidAppearance;
  creature?: CreatureRef;
  equipment?: EquipmentVisuals;
  /** Dropped item on the ground. */
  item?: { defId: string; name: string; count: number; visual: ItemVisual; rarity: string };
  /** Projectile / spell visual id. */
  projectile?: { fx: string; owner: EntityId };
  /** Visual effect tags (auras). */
  fx?: string[];
  speech?: Speech;
  /** Scale multiplier (giants, juveniles, enlarged by magic). */
  scale?: number;
  target?: EntityId;
  /** Light emitted by the entity (torch, glowing creature, spell) */
  light?: { color: [number, number, number]; intensity: number; radius: number };
}

/** Destructible world object state (trees, rocks, building pieces). */
export interface ObjectState {
  id: number | string;
  hp: number;
  maxHp: number;
  /** 'intact' objects are omitted; 'damaged' shows cracks; 'destroyed' removes and spawns debris once. */
  state: 'damaged' | 'destroyed' | 'felled';
  /** Direction of fall/impact for felled trees & debris. */
  dir?: Vec3;
  /** Time destroyed (server time). Clients only play the destruction animation if recent. */
  t: number;
}

// ---------------------------------------------------------------- server events

export type GameEvent =
  | { type: 'damage'; target: EntityId; source?: EntityId; amount: number; dtype: DamageType; crit?: boolean; pos: Vec3 }
  | { type: 'heal'; target: EntityId; amount: number; pos: Vec3 }
  | { type: 'death'; target: EntityId; killer?: EntityId }
  | { type: 'fx'; fx: string; pos: Vec3; dir?: Vec3; radius?: number; color?: [number, number, number]; target?: EntityId; duration?: number }
  | { type: 'sound'; sound: string; pos: Vec3; volume?: number }
  | { type: 'impact'; pos: Vec3; normal: Vec3; material: string; force: number }
  | { type: 'xp'; skill: string; amount: number; level: number; leveled: boolean }
  | { type: 'unlock'; ability: string; skill: string }
  | { type: 'loot'; items: string[] }
  | { type: 'notify'; text: string; tone?: 'info' | 'good' | 'bad' | 'warn' }
  | { type: 'shake'; pos: Vec3; strength: number }
  | { type: 'gravity'; pos: Vec3; radius: number; factor: number; until: number }
  | { type: 'knockback'; target: EntityId; impulse: Vec3 };

// ---------------------------------------------------------------- player state

export interface PlayerState {
  id: EntityId;
  name: string;
  appearance: HumanoidAppearance;
  hp: number;
  stamina: number;
  mana: number;
  stats: Stats;
  skills: SkillsState;
  inventory: Inventory;
  equipment: Equipment;
  effects: ActiveEffect[];
  /** Ability cooldowns: ability id → server time ready. */
  cooldowns: Record<string, number>;
  journal: JournalState;
  /** Reputation with factions -100..100. */
  reputation: Record<string, number>;
  /** Player-specific gravity modifier from effects (multiplier). */
  gravityMul: number;
  /** Respawn point. */
  home: Vec3;
}

// ---------------------------------------------------------------- C2S

export type ClientMessage =
  | { t: 'hello'; version: number; name: string; appearance: HumanoidAppearance; save?: string }
  | {
      t: 'move';
      seq: number;
      pos: Vec3;
      vel: Vec3;
      yaw: number;
      move: AnimState['move'];
      grounded: boolean;
      /** Camera aim (for look-at + server-side aim validation). */
      aim?: Vec3;
    }
  | { t: 'ability'; use: AbilityUse }
  | { t: 'abilityRelease'; ability: string }
  | {
      t: 'attack';
      heavy?: boolean;
      dir: Vec3;
      point?: Vec3;
      target?: EntityId;
      /**
       * `target` is the player's tab target (not just what the crosshair touches): the server
       * aims the swing/shot at it when it is valid (alive, in range, in line of sight).
       */
      lock?: boolean;
    }
  | { t: 'block'; on: boolean }
  | { t: 'interact'; target?: EntityId; object?: number | string; point?: Vec3 }
  | { t: 'harvest'; object: number | string; point: Vec3 }
  | { t: 'dig'; point: Vec3; normal: Vec3; tool?: string }
  | { t: 'place'; point: Vec3; normal: Vec3; itemUid: string }
  | { t: 'talk'; npc: EntityId }
  | { t: 'dialogChoice'; session: string; choice: string }
  | { t: 'dialogText'; session: string; text: string }
  | { t: 'dialogEnd'; session: string }
  | { t: 'equip'; uid: string; slot?: EquipSlot }
  | { t: 'unequip'; slot: EquipSlot }
  | { t: 'useItem'; uid: string }
  | { t: 'dropItem'; uid: string; count?: number }
  | { t: 'pickup'; entity: EntityId }
  | { t: 'trade'; npc: EntityId; buy?: string[]; sell?: string[] }
  | { t: 'craft'; recipe: string; station?: string }
  | { t: 'hotbar'; slot: number; value: string | null }
  | { t: 'gmAsk'; text: string }
  | { t: 'questAction'; quest: string; action: 'accept' | 'abandon' | 'track' }
  | { t: 'chat'; text: string }
  | { t: 'respawn' }
  | { t: 'save' }
  | { t: 'debug'; cmd: string; args?: unknown[] };

// ---------------------------------------------------------------- S2C

export type ServerMessage =
  | { t: 'welcome'; version: number; playerId: EntityId; seed: number; serverTime: number; spawn: Vec3; player: PlayerState }
  | { t: 'snapshot'; time: number; entities: EntitySnapshot[]; removed: EntityId[]; ack: number }
  | { t: 'terrainEdits'; edits: TerrainEdit[] }
  | { t: 'objects'; states: ObjectState[] }
  | { t: 'events'; events: GameEvent[] }
  | { t: 'player'; state: Partial<PlayerState> }
  | { t: 'dialog'; view: DialogView }
  | { t: 'gm'; messages: GmMessage[] }
  | { t: 'world'; timeOfDay: number; day: number; weather: WeatherState }
  | { t: 'correct'; pos: Vec3; vel?: Vec3; reason: string }
  | { t: 'trade'; npc: EntityId; stock: ItemInstance[]; prices: Record<string, number>; sellPrices: Record<string, number> }
  | { t: 'saved'; data: string }
  | { t: 'error'; message: string };

export type { EntityId, Vec3 };
