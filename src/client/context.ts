/**
 * Client-side contracts. The client core (game loop, input, camera, physics,
 * networking) wires domain modules together through these interfaces.
 */
import type * as THREE from 'three';
import type { WorldGenerator } from '../world/generator';
import type { WorldProfile } from '../world/profile';
import type { TerrainStreamer } from '../world/streamer';
import type { TerrainCollider } from '../world/collider';
import type { RenderCore } from '../render/renderCore';
import type { Environment } from '../render/environment';
import type { Emitter } from '../core/events';
import type { ClientMessage, EntitySnapshot, GameEvent, ObjectState, PlayerState, ServerMessage } from '../shared/protocol';
import type { EntityId, EntityKind, Vec3 } from '../shared/types';
import type { DialogView } from '../dialog/types';
import type { GmMessage } from '../gm/types';
import type { ItemInstance } from '../items/types';
import type { Disposition } from './targetRules';

// ------------------------------------------------------------------ entity views

export interface EntityView {
  readonly object: THREE.Object3D;
  /**
   * Called every frame with the interpolated snapshot. Views animate
   * themselves (procedural animation driven by snap.anim / velocity).
   */
  update(snap: EntitySnapshot, dt: number, time: number): void;
  /** Game events targeting this entity (damage flinch, death, cast...). */
  onEvent?(ev: GameEvent): void;
  /** Named attachment points: "hand.R", "hand.L", "head", "back", "mouth", "chest". */
  getSocket?(name: string): THREE.Object3D | null;
  /** Height of the head top (for nameplates/speech bubbles), meters above pos. */
  headHeight: number;
  /** Raycast/selection radius & height. */
  radius: number;
  /** Set visibility for first-person / culling. */
  setVisible?(v: boolean): void;
  /** Sky visibility 0..1 (caves) — views should apply it to their materials. */
  setSkyVis?(v: number): void;
  dispose(): void;
}

export interface EntityViewFactory {
  readonly kinds: EntityKind[];
  /** Return null to let another factory handle it. May build asynchronously by returning a placeholder view. */
  create(snap: EntitySnapshot, ctx: ClientContext): EntityView | null;
}

// ------------------------------------------------------------------ world objects & colliders

export interface StaticCollider {
  /** Unique collider id. */
  id: string;
  /** Owning system (for bulk removal), e.g. "flora:<chunkKey>", "settlement:<siteId>". */
  owner: string;
  shape: 'capsule' | 'box' | 'sphere';
  /** Capsule: base point + height + radius (vertical). Sphere: centre + radius. Box: centre + half extents + yaw. */
  pos: Vec3;
  radius?: number;
  height?: number;
  half?: Vec3;
  yaw?: number;
  /** Destructible/interactable world object id (server ObjectService id). */
  objectId?: number | string;
  /** Interaction prompt, e.g. "Chop", "Mine", "Open", "Sit". */
  interact?: string;
  /** Material for impact sounds/fx. */
  material?: 'wood' | 'stone' | 'metal' | 'crystal' | 'flesh' | 'plant' | 'cloth' | 'ice';
  /** Blocks movement (false = only for raycasts/interaction, e.g. grass or doors that are open). */
  solid: boolean;
}

export interface StaticColliders {
  add(c: StaticCollider): void;
  remove(id: string): void;
  removeOwner(owner: string): void;
  /** Colliders overlapping an AABB. */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out?: StaticCollider[]): StaticCollider[];
  /** Raycast against colliders. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, filter?: (c: StaticCollider) => boolean): { collider: StaticCollider; dist: number; point: Vec3; normal: Vec3 } | null;
}

// ------------------------------------------------------------------ debris physics

export interface DebrisOptions {
  /** Mesh or group to simulate (ownership transfers to the debris system; it will dispose). */
  object: THREE.Object3D;
  pos: Vec3;
  vel: Vec3;
  angVel?: Vec3;
  /** Collision radius. */
  radius: number;
  /** Seconds before fading out. */
  life?: number;
  bounce?: number;
  friction?: number;
}

export interface DebrisAPI {
  spawn(opts: DebrisOptions): void;
  /** Break a mesh into chunky fragments and throw them. */
  shatter(mesh: THREE.Mesh, origin: Vec3, force: number, pieces?: number, life?: number): void;
}

// ------------------------------------------------------------------ audio

export interface AudioAPI {
  /** Play a named procedural sound at a world position (or UI if pos undefined). */
  play(sound: string, pos?: Vec3, opts?: { volume?: number; pitch?: number }): void;
  /** Footstep on a terrain material id. */
  footstep(material: number, pos: Vec3, intensity: number): void;
}

// ------------------------------------------------------------------ client state & events

export interface ClientEvents extends Record<string, unknown> {
  serverMessage: ServerMessage;
  gameEvent: GameEvent;
  playerState: PlayerState;
  dialog: DialogView;
  gm: GmMessage[];
  objects: ObjectState[];
  trade: Extract<ServerMessage, { t: 'trade' }>;
  /** Local player focus changed (what the crosshair points at). */
  focus: FocusTarget | null;
  /**
   * Tab target selected, changed or cleared (null). The same TargetInfo object is updated in
   * place every frame while it stays selected, so HUD code can simply keep a reference.
   */
  target: TargetInfo | null;
  /** Requests to the targeting system (e.g. the UI clearing the target on Esc). */
  targetRequest: { op: 'clear' | 'next' | 'prev' };
  /** Entity views created/removed. */
  entityAdded: { id: EntityId; snap: EntitySnapshot };
  entityRemoved: { id: EntityId };
  /** UI requests. */
  uiOpen: { panel: string; data?: unknown };
  notify: { text: string; tone?: 'info' | 'good' | 'bad' | 'warn' };
}

export type FocusTarget =
  | { kind: 'entity'; id: EntityId; snap: EntitySnapshot; dist: number; prompt: string }
  | { kind: 'object'; collider: StaticCollider; point: Vec3; dist: number; prompt: string }
  | { kind: 'terrain'; point: Vec3; normal: Vec3; material: number; dist: number; prompt: string };

/** The local player's tab target (client-side selection; the server validates every use). */
export interface TargetInfo {
  id: EntityId;
  /** Latest interpolated snapshot. */
  snap: EntitySnapshot;
  disposition: Disposition;
  /** Distance from the local player (m). */
  dist: number;
  /** In the player's line of sight right now. */
  visible: boolean;
  /** Seconds since it was selected. */
  age: number;
}

export interface ClientState {
  playerId: EntityId;
  player: PlayerState;
  serverTime: number;
  /** Latest interpolated snapshots by id. */
  entities: Map<EntityId, EntitySnapshot>;
  /** Object states by id (destroyed trees etc.). */
  objects: Map<number | string, ObjectState>;
  timeOfDay: number;
  day: number;
}

export interface ClientModule {
  readonly name: string;
  init?(ctx: ClientContext): void | Promise<void>;
  /** Per frame. */
  update?(dt: number, time: number): void;
  dispose?(): void;
}

export interface ClientContext {
  readonly seed: number;
  readonly gen: WorldGenerator;
  readonly profile: WorldProfile;
  readonly core: RenderCore;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly env: Environment;
  readonly streamer: TerrainStreamer;
  readonly terrain: TerrainCollider;
  readonly colliders: StaticColliders;
  readonly debris: DebrisAPI;
  readonly audio: AudioAPI;
  readonly events: Emitter<ClientEvents>;
  readonly state: ClientState;
  /** Entity views by id (includes the local player). */
  readonly views: Map<EntityId, EntityView>;
  send(msg: ClientMessage): void;
  /** Local player's current predicted position. */
  playerPos(): Vec3;
  /** Lookup item instance in the local inventory/equipment. */
  findItem(uid: string): ItemInstance | undefined;
  /** UI root element for DOM overlays. */
  readonly uiRoot: HTMLElement;
  /** Input focus: when a UI panel captures input, gameplay input is suspended. */
  setUiCapture(captured: boolean): void;
  readonly uiCaptured: boolean;
}
