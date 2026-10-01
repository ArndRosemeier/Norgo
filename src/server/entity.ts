/**
 * Server-side entity record. Holds data common to all entities; systems keep
 * their own private component maps keyed by entity id (creature brains, NPC
 * minds, projectile state...).
 */
import type { AnimState, EntityId, EntityKind, Speech, Vec3 } from '../shared/types';
import type { HumanoidAppearance } from '../humanoid/types';
import type { CreatureRef } from '../creatures/types';
import type { Equipment, Inventory, ItemInstance } from '../items/types';
import type { ActiveEffect, SkillsState, Stats } from '../gameplay/types';
import type { EntitySnapshot } from '../shared/protocol';

export interface ServerEntity {
  id: EntityId;
  kind: EntityKind;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  anim: AnimState;
  grounded: boolean;
  /** Collision capsule. */
  radius: number;
  height: number;
  mass: number;

  hp: number;
  maxHp: number;
  stamina: number;
  mana: number;
  alive: boolean;
  /** Server time of death (for corpse cleanup). */
  diedAt?: number;

  name: string;
  title?: string;
  faction: string;
  flags: number;
  scale: number;

  humanoid?: HumanoidAppearance;
  creature?: CreatureRef;
  inventory?: Inventory;
  equipment?: Equipment;
  skills?: SkillsState;
  /** Final stats after equipment & effects (recomputed by gameplay). */
  stats?: Stats;
  effects: ActiveEffect[];
  /** Ground item payload. */
  item?: ItemInstance;
  projectile?: { fx: string; owner: EntityId };
  speech?: Speech;
  fx?: string[];
  target?: EntityId;
  light?: { color: [number, number, number]; intensity: number; radius: number };

  /** Who last damaged this entity (for kill credit, aggression). */
  lastAttacker?: EntityId;
  /** Owning system name (who simulates it). */
  owner: string;
  /** Free-form tags for cross-system queries ("merchant", "guard", "boss", "summon"...). */
  tags: Set<string>;
  /** Snapshot dirty bit — set when something visible changed. */
  dirty: boolean;
  /** Entities flagged persistent are saved with the world. */
  persistent: boolean;
  createdAt: number;
}

export function makeEntity(id: EntityId, kind: EntityKind, pos: Vec3, owner: string, now: number): ServerEntity {
  return {
    id, kind, pos: [pos[0], pos[1], pos[2]], vel: [0, 0, 0], yaw: 0, anim: { move: 'idle' }, grounded: true,
    radius: 0.35, height: 1.8, mass: 70, hp: 100, maxHp: 100, stamina: 100, mana: 100, alive: true,
    name: '', faction: 'neutral', flags: 0, scale: 1, effects: [], owner, tags: new Set(), dirty: true, persistent: false, createdAt: now,
  };
}

export function snapshotOf(e: ServerEntity, equipmentVisuals: boolean): EntitySnapshot {
  const s: EntitySnapshot = {
    id: e.id, kind: e.kind, pos: e.pos, vel: e.vel, yaw: e.yaw, anim: e.anim, hp: e.hp, maxHp: e.maxHp, flags: e.flags,
  };
  if (e.name) s.name = e.name;
  if (e.title) s.title = e.title;
  if (e.faction !== 'neutral') s.faction = e.faction;
  if (e.humanoid) s.humanoid = e.humanoid;
  if (e.creature) s.creature = e.creature;
  if (equipmentVisuals && e.equipment) {
    const v: EntitySnapshot['equipment'] = {};
    for (const [slot, it] of Object.entries(e.equipment)) if (it) v[slot as keyof typeof v] = { defId: it.defId, visual: it.visual };
    s.equipment = v;
  }
  if (e.item) s.item = { defId: e.item.defId, name: e.item.name, count: e.item.count, visual: e.item.visual, rarity: e.item.rarity };
  if (e.projectile) s.projectile = e.projectile;
  if (e.fx && e.fx.length) s.fx = e.fx;
  if (e.speech) s.speech = e.speech;
  if (e.scale !== 1) s.scale = e.scale;
  if (e.target !== undefined) s.target = e.target;
  if (e.light) s.light = e.light;
  return s;
}

/** Uniform-grid spatial index over entities (XZ). */
export class EntityStore {
  readonly all = new Map<EntityId, ServerEntity>();
  private grid = new Map<string, Set<ServerEntity>>();
  private cellOf = new Map<EntityId, string>();
  private nextId = 1;
  static readonly CELL = 24;

  allocId(): EntityId {
    return this.nextId++;
  }

  /** Ensure future ids are above n (after loading a save). */
  reserve(n: number) {
    this.nextId = Math.max(this.nextId, n + 1);
  }

  private cellKey(p: Vec3) {
    return Math.floor(p[0] / EntityStore.CELL) + ',' + Math.floor(p[2] / EntityStore.CELL);
  }

  add(e: ServerEntity) {
    this.all.set(e.id, e);
    this.reindex(e);
  }

  get(id: EntityId | undefined): ServerEntity | undefined {
    return id === undefined ? undefined : this.all.get(id);
  }

  remove(id: EntityId): ServerEntity | undefined {
    const e = this.all.get(id);
    if (!e) return;
    this.all.delete(id);
    const k = this.cellOf.get(id);
    if (k) this.grid.get(k)?.delete(e);
    this.cellOf.delete(id);
    return e;
  }

  /** Call after changing e.pos. */
  reindex(e: ServerEntity) {
    const k = this.cellKey(e.pos);
    const old = this.cellOf.get(e.id);
    if (old === k) return;
    if (old) this.grid.get(old)?.delete(e);
    let s = this.grid.get(k);
    if (!s) this.grid.set(k, (s = new Set()));
    s.add(e);
    this.cellOf.set(e.id, k);
  }

  /** Entities within radius (3D distance), optional filter. */
  near(p: Vec3, r: number, filter?: (e: ServerEntity) => boolean): ServerEntity[] {
    const out: ServerEntity[] = [];
    const C = EntityStore.CELL;
    const r2 = r * r;
    for (let cz = Math.floor((p[2] - r) / C); cz <= Math.floor((p[2] + r) / C); cz++)
      for (let cx = Math.floor((p[0] - r) / C); cx <= Math.floor((p[0] + r) / C); cx++) {
        const s = this.grid.get(cx + ',' + cz);
        if (!s) continue;
        for (const e of s) {
          const dx = e.pos[0] - p[0], dy = e.pos[1] - p[1], dz = e.pos[2] - p[2];
          if (dx * dx + dy * dy + dz * dz <= r2 && (!filter || filter(e))) out.push(e);
        }
      }
    return out;
  }

  ofKind(kind: EntityKind): ServerEntity[] {
    const out: ServerEntity[] = [];
    for (const e of this.all.values()) if (e.kind === kind) out.push(e);
    return out;
  }
}
