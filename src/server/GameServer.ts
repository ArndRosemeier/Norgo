/**
 * Authoritative (mock) game server. Runs in a Web Worker in single player but
 * is written exactly like a real server: clients only send intents, the
 * server owns world state and replicates it via snapshots and events.
 */
import { WorldGenerator } from '../world/generator';
import { TerrainCollider } from '../world/collider';
import { EditStore, TerrainEdit, clampEdit } from '../world/edits';
import { Rng, deriveSeed } from '../core/rng';
import { Emitter } from '../core/events';
import { EntityStore, ServerEntity, snapshotOf } from './entity';
import type { ServerContext, ServerSystem, ServerBusEvents, Services, ServerTime } from './context';
import type { ClientMessage, GameEvent, ServerMessage, EntitySnapshot } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';
import type { EntityId, Vec3, WeatherState } from '../shared/types';
import { PlayerSystem } from './systems/PlayerSystem';
import { WorldSystem } from './systems/WorldSystem';
import { GameplaySystem } from '../gameplay/server/GameplaySystem';
import { ItemSystem } from '../items/server/ItemSystem';
import { ObjectSystem } from '../flora/server/ObjectSystem';
import { SettlementSystem } from '../settlements/server/SettlementSystem';
import { NpcSystem } from '../npc/server/NpcSystem';
import { DialogSystem } from '../dialog/server/DialogSystem';
import { GameMaster } from '../gm/server/GameMaster';
import { CreatureSystem } from '../creatures/server/CreatureSystem';

export const TICK_RATE = 20;
const SNAPSHOT_EVERY = 2; // ticks → 10 Hz snapshots
export const INTEREST_RADIUS = 170;

interface ClientConn {
  playerId: EntityId;
  send: (msg: ServerMessage) => void;
  known: Set<EntityId>;
  pendingEvents: GameEvent[];
  dirtyKeys: Set<string>;
  lastAck: number;
}

export interface SaveFile {
  version: number;
  seed: number;
  time: { now: number; timeOfDay: number; day: number };
  edits: TerrainEdit[];
  entities: { nextId: number };
  systems: Record<string, unknown>;
}

export class GameServer implements ServerContext {
  readonly seed: number;
  readonly gen: WorldGenerator;
  readonly edits = new EditStore();
  readonly terrain: TerrainCollider;
  readonly entities = new EntityStore();
  readonly bus = new Emitter<ServerBusEvents>();
  readonly time: ServerTime = { now: 0, dt: 1 / TICK_RATE, timeOfDay: 0.3, day: 0, hour: 7 };
  weather: WeatherState = { kind: 'clear', intensity: 0, windX: 1, windZ: 0.2 };
  readonly systems: ServerSystem[] = [];
  readonly services: Services;
  private conns = new Map<EntityId, ClientConn>();
  private editId = 1;
  private tickCount = 0;
  private slowAcc = 0;
  readonly playerSys: PlayerSystem;
  readonly worldSys: WorldSystem;
  private pendingEdits: TerrainEdit[] = [];
  /** Debug/perf info. */
  stats = { tickMs: 0, entities: 0 };

  constructor(seed: number) {
    this.seed = seed;
    this.gen = new WorldGenerator(seed);
    this.terrain = new TerrainCollider(this.gen, this.edits);
    this.time.timeOfDay = 0.3;

    const gameplay = new GameplaySystem();
    const items = new ItemSystem();
    const objects = new ObjectSystem();
    const settlements = new SettlementSystem();
    const npcs = new NpcSystem();
    const dialog = new DialogSystem();
    const gm = new GameMaster();
    const creatures = new CreatureSystem();
    this.playerSys = new PlayerSystem();
    this.worldSys = new WorldSystem();
    this.services = { combat: gameplay, skills: gameplay, items, objects, settlements, npcs, creatures, dialog, gm };
    this.systems.push(this.worldSys, this.playerSys, gameplay, items, objects, settlements, npcs, creatures, dialog, gm);
    for (const s of this.systems) s.init?.(this);
  }

  // ------------------------------------------------------------ ServerContext API

  rng(...tag: (string | number)[]): Rng {
    return new Rng(deriveSeed(this.seed, ...tag));
  }

  newEntityId(): EntityId {
    return this.entities.allocId();
  }

  spawn(e: ServerEntity): ServerEntity {
    this.entities.add(e);
    return e;
  }

  despawn(id: EntityId): void {
    const e = this.entities.remove(id);
    if (!e) return;
    for (const s of this.systems) s.onEntityRemoved?.(e);
  }

  broadcast(ev: GameEvent, pos?: Vec3, radius = INTEREST_RADIUS): void {
    for (const c of this.conns.values()) {
      if (pos) {
        const p = this.entities.get(c.playerId);
        if (!p) continue;
        const dx = p.pos[0] - pos[0], dy = p.pos[1] - pos[1], dz = p.pos[2] - pos[2];
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      }
      c.pendingEvents.push(ev);
    }
  }

  send(playerId: EntityId, msg: ServerMessage): void {
    this.conns.get(playerId)?.send(msg);
  }

  players(): ServerEntity[] {
    const out: ServerEntity[] = [];
    for (const c of this.conns.values()) {
      const p = this.entities.get(c.playerId);
      if (p) out.push(p);
    }
    return out;
  }

  editTerrain(edit: Omit<TerrainEdit, 'id'>, source?: ServerEntity): TerrainEdit {
    const e = clampEdit({ ...edit, id: this.editId++ });
    this.edits.add(e);
    this.terrain.invalidate(e.x - e.radius - 2, e.y - e.radius - 2, e.z - e.radius - 2, e.x + e.radius + 2, e.y + e.radius + 2, e.z + e.radius + 2);
    this.pendingEdits.push(e);
    this.bus.emit('terrainEdited', { edit: e, source });
    return e;
  }

  groundAt(x: number, y: number, z: number, maxDrop = 80): number {
    return this.terrain.groundBelow(x, y, z, maxDrop);
  }

  gravityAt(pos: Vec3): number {
    return this.gen.gravityAt(pos[0], pos[1], pos[2]);
  }

  markPlayerDirty(playerId: EntityId, ...keys: string[]): void {
    const c = this.conns.get(playerId);
    if (!c) return;
    for (const k of keys) c.dirtyKeys.add(k);
  }

  log(...args: unknown[]): void {
    console.log('[server]', ...args);
  }

  // ------------------------------------------------------------ connections

  /** Register a client connection. Returns the message handler for that client. */
  connect(send: (msg: ServerMessage) => void): (msg: ClientMessage) => void {
    let conn: ClientConn | null = null;
    return (msg: ClientMessage) => {
      try {
        if (msg.t === 'hello') {
          if (msg.version !== PROTOCOL_VERSION) {
            send({ t: 'error', message: `protocol mismatch ${msg.version} != ${PROTOCOL_VERSION}` });
            return;
          }
          const player = this.playerSys.join(msg.name, msg.appearance);
          conn = { playerId: player.id, send, known: new Set(), pendingEvents: [], dirtyKeys: new Set(), lastAck: 0 };
          this.conns.set(player.id, conn);
          for (const s of this.systems) s.onPlayerJoin?.(player);
          this.bus.emit('playerJoined', { player });
          send({
            t: 'welcome', version: PROTOCOL_VERSION, playerId: player.id, seed: this.seed, serverTime: this.time.now,
            spawn: player.pos, player: this.playerSys.fullState(player),
          });
          if (this.edits.count) send({ t: 'terrainEdits', edits: this.edits.list() });
          send({ t: 'world', timeOfDay: this.time.timeOfDay, day: this.time.day, weather: this.weather });
          return;
        }
        if (!conn) return;
        const player = this.entities.get(conn.playerId);
        if (!player) return;
        if (msg.t === 'move') conn.lastAck = msg.seq;
        if (msg.t === 'save') {
          send({ t: 'saved', data: JSON.stringify(this.save()) });
          return;
        }
        for (const s of this.systems) if (s.onMessage?.(player, msg)) return;
      } catch (err) {
        console.error('[server] message error', msg.t, err);
      }
    };
  }

  disconnect(playerId: EntityId) {
    this.conns.delete(playerId);
    this.despawn(playerId);
  }

  // ------------------------------------------------------------ simulation

  tick() {
    const t0 = performance.now();
    const dt = 1 / TICK_RATE;
    this.time.dt = dt;
    this.time.now += dt;
    this.tickCount++;
    for (const s of this.systems) {
      try {
        s.tick?.(dt);
      } catch (err) {
        console.error('[server] system tick error', s.name, err);
      }
    }
    this.slowAcc += dt;
    if (this.slowAcc >= 1) {
      for (const s of this.systems) {
        try {
          s.slowTick?.(this.slowAcc);
        } catch (err) {
          console.error('[server] system slowTick error', s.name, err);
        }
      }
      this.slowAcc = 0;
    }
    if (this.pendingEdits.length) {
      const edits = this.pendingEdits;
      this.pendingEdits = [];
      for (const c of this.conns.values()) c.send({ t: 'terrainEdits', edits });
    }
    if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    for (const c of this.conns.values()) {
      if (c.pendingEvents.length) {
        c.send({ t: 'events', events: c.pendingEvents });
        c.pendingEvents = [];
      }
      if (c.dirtyKeys.size) {
        const p = this.entities.get(c.playerId);
        if (p) c.send({ t: 'player', state: this.playerSys.partialState(p, c.dirtyKeys) });
        c.dirtyKeys.clear();
      }
    }
    this.stats.tickMs = performance.now() - t0;
    this.stats.entities = this.entities.all.size;
  }

  private sendSnapshots() {
    for (const c of this.conns.values()) {
      const p = this.entities.get(c.playerId);
      if (!p) continue;
      const visible = this.entities.near(p.pos, INTEREST_RADIUS);
      const snaps: EntitySnapshot[] = [];
      const now = new Set<EntityId>();
      for (const e of visible) {
        now.add(e.id);
        snaps.push(snapshotOf(e, true));
      }
      const removed: EntityId[] = [];
      for (const id of c.known) if (!now.has(id)) removed.push(id);
      c.known = now;
      c.send({ t: 'snapshot', time: this.time.now, entities: snaps, removed, ack: c.lastAck });
    }
  }

  // ------------------------------------------------------------ persistence

  save(): SaveFile {
    const systems: Record<string, unknown> = {};
    for (const s of this.systems) {
      try {
        const d = s.save?.();
        if (d !== undefined) systems[s.name] = d;
      } catch (err) {
        console.error('[server] save error', s.name, err);
      }
    }
    return {
      version: 1,
      seed: this.seed,
      time: { now: this.time.now, timeOfDay: this.time.timeOfDay, day: this.time.day },
      edits: this.edits.list(),
      entities: { nextId: this.entities.allocId() },
      systems,
    };
  }

  load(data: SaveFile) {
    if (data.seed !== this.seed) throw new Error('save belongs to a different world seed');
    this.time.now = data.time.now;
    this.time.timeOfDay = data.time.timeOfDay;
    this.time.day = data.time.day;
    for (const e of data.edits) {
      this.edits.add(e);
      this.editId = Math.max(this.editId, e.id + 1);
    }
    this.entities.reserve(data.entities.nextId);
    for (const s of this.systems) {
      if (data.systems[s.name] !== undefined) {
        try {
          s.load?.(data.systems[s.name]);
        } catch (err) {
          console.error('[server] load error', s.name, err);
        }
      }
    }
  }
}
