/**
 * A self-contained gameplay test server: a ServerContext around a real
 * WorldGenerator / terrain collider / entity store with small stand-in
 * services (items, objects, creatures, npcs...), running only the
 * GameplaySystem. Used by tools/gameplay-selftest.ts (Node) and the FX
 * sandbox (browser) — never by the real game.
 */
import type { WorldGenerator } from '../../world/generator';
import { TerrainCollider } from '../../world/collider';
import { EditStore, clampEdit, type TerrainEdit } from '../../world/edits';
import { Emitter } from '../../core/events';
import { Rng, deriveSeed } from '../../core/rng';
import { EntityStore, makeEntity, type ServerEntity } from '../../server/entity';
import type { ServerBusEvents, ServerContext, Services } from '../../server/context';
import type { GameEvent, ServerMessage } from '../../shared/protocol';
import type { EntityId, Vec3, WeatherState } from '../../shared/types';
import type { ItemDef, ItemInstance } from '../../items/types';
import type { PlayerData } from '../../server/systems/PlayerSystem';
import { GameplaySystem } from './GameplaySystem';
import { SKILLS, totalXpForLevel } from '../data/catalog';

/** Item definitions the stand-in item service knows. */
export const HARNESS_ITEMS: Record<string, Partial<ItemDef>> = {
  sword_iron: { category: 'weapon', slots: ['mainhand'], weapon: { damage: 12, type: 'slash', speed: 1.1, reach: 2.2, skill: 'blades' } },
  spear_iron: { category: 'weapon', slots: ['mainhand'], twoHanded: true, weapon: { damage: 13, type: 'pierce', speed: 1, reach: 3, skill: 'polearms' } },
  bow_hunting: { category: 'weapon', slots: ['mainhand'], twoHanded: true, weapon: { damage: 10, type: 'pierce', speed: 1, reach: 1, skill: 'archery', ranged: true } },
  arrow: { category: 'ammo', slots: [], stackable: true },
  shield_round: { category: 'armor', slots: ['offhand'], armor: { armor: 12, coverage: 0.3, heaviness: 0.4 } },
  pick_iron: { category: 'tool', slots: ['mainhand'], tool: { kind: 'pick', power: 2 } },
  bread: { category: 'food', slots: [], consumable: { effects: [] } },
  crystal_shard: { category: 'material', slots: [] },
  chain_mail: { category: 'armor', slots: ['chest'], armor: { armor: 25, coverage: 0.5, heaviness: 0.8 } },
};

let uid = 1;
export function harnessItem(defId: string, count = 1): ItemInstance {
  return {
    uid: 'h' + uid++, defId, count, name: defId.replace(/_/g, ' '), rarity: 'common', quality: 0.5, material: 'iron', affixes: [], mods: {},
    durability: 80, maxDurability: 100, value: 5,
    visual: { shape: defId, seed: 1, primary: [0.5, 0.5, 0.5], secondary: [0.3, 0.3, 0.3], accent: [0.8, 0.7, 0.2], material: 'metal', glow: 0, glowColor: [0, 0, 0], wear: 0, style: 'human' },
  };
}

export interface HarnessTree {
  id: number;
  kind: string;
  pos: Vec3;
  radius: number;
  hp: number;
}

export class GameplayHarness implements ServerContext {
  readonly seed: number;
  edits = new EditStore();
  terrain: TerrainCollider;
  readonly entities = new EntityStore();
  readonly bus = new Emitter<ServerBusEvents>();
  readonly time = { now: 0, dt: 0.05, timeOfDay: 0.4, day: 0, hour: 10 };
  weather: WeatherState = { kind: 'clear', intensity: 0, windX: 1, windZ: 0.2 };
  readonly services: Services;
  readonly gameplay = new GameplaySystem();
  readonly playerData = new Map<EntityId, PlayerData>();
  /** Accessor used by getPlayerData(). */
  readonly playerSys = { playerData: (id: EntityId) => this.playerData.get(id) };
  readonly trees: HarnessTree[] = [];
  /** Event sinks (selftest collects, sandbox forwards to FxSystem). */
  onBroadcast: (ev: GameEvent) => void = () => {};
  onSend: (to: EntityId, msg: ServerMessage) => void = () => {};
  onEdit: (e: TerrainEdit) => void = () => {};
  editCount = 0;
  private slowAcc = 0;
  worstTickMs = 0;

  constructor(readonly gen: WorldGenerator) {
    this.seed = gen.seed;
    this.terrain = new TerrainCollider(gen, this.edits);
    const self = this;
    this.services = {
      combat: this.gameplay,
      skills: this.gameplay,
      items: {
        create: (defId, o) => harnessItem(defId, o?.count ?? 1),
        rollLoot: () => [],
        give: (e, it) => {
          const inv = e.inventory;
          if (!inv) return false;
          const same = inv.items.find((x) => x.defId === it.defId && HARNESS_ITEMS[it.defId]?.stackable);
          if (same) same.count += it.count;
          else inv.items.push(it);
          return true;
        },
        take: (e, u, count = 1) => {
          const inv = e.inventory;
          const i = inv?.items.findIndex((x) => x.uid === u) ?? -1;
          if (!inv || i < 0) return null;
          const it = inv.items[i];
          if (it.count > count) {
            it.count -= count;
            return { ...it, uid: 'h' + uid++, count };
          }
          return inv.items.splice(i, 1)[0];
        },
        drop: (pos, item) => {
          const e = makeEntity(self.newEntityId(), 'item', pos, 'items', self.time.now);
          e.item = item;
          return self.spawn(e);
        },
        equip: () => true,
        outfitFor: () => {},
        valueOf: (it) => it.value,
        def: (id) => (HARNESS_ITEMS[id] ? ({ id, name: id, weight: 1, baseValue: 1, stackable: false, maxStack: 1, description: '', visual: {}, slots: [], ...HARNESS_ITEMS[id] } as ItemDef) : undefined),
      },
      objects: {
        registerProvider: () => {},
        damage: (id, amount) => {
          const t = self.trees.find((x) => x.id === id);
          if (!t) return 0;
          t.hp -= amount;
          return t.hp;
        },
        near: (pos, r) => self.trees.filter((t) => Math.hypot(t.pos[0] - pos[0], t.pos[2] - pos[2]) < r + t.radius),
        state: () => undefined,
      },
      settlements: { layout: () => null, siteAt: () => null, sitesNear: () => [], buildingsNear: () => [], insideBuilding: () => null },
      npcs: { profile: () => undefined, ensureSettlement: () => {}, adjustDisposition: () => {}, disposition: () => 0, spawnWanderer: () => null, remember: () => {} },
      creatures: {
        speciesCount: () => 1,
        spawn: (_sp, pos, o) => {
          const e = makeEntity(self.newEntityId(), 'creature', pos, 'creatures', self.time.now);
          e.name = 'Wolf';
          e.faction = o?.hostile ? 'hostile' : 'wild';
          e.creature = { species: 0, seed: o?.seed ?? 1, growth: 1 };
          return self.spawn(e);
        },
        speciesFor: () => [0],
        speciesName: () => 'wolf',
        tryTame: () => true,
      },
      dialog: { start: () => {}, end: () => {} },
      gm: { narrate: () => {}, createQuest: () => 'q', offerQuest: () => {}, tension: () => 0.5 },
    };
    this.gameplay.init(this);
  }

  /** Fresh, unedited terrain. */
  resetTerrain() {
    this.edits = new EditStore();
    this.terrain = new TerrainCollider(this.gen, this.edits);
  }

  // ------------------------------------------------------------------ ServerContext
  rng(...tag: (string | number)[]) {
    return new Rng(deriveSeed(this.seed, ...tag));
  }
  spawn(e: ServerEntity) {
    this.entities.add(e);
    return e;
  }
  despawn(id: EntityId) {
    const e = this.entities.remove(id);
    if (e) this.gameplay.onEntityRemoved(e);
  }
  newEntityId() {
    return this.entities.allocId();
  }
  broadcast(ev: GameEvent) {
    this.onBroadcast(ev);
  }
  send(id: EntityId, msg: ServerMessage) {
    this.onSend(id, msg);
  }
  players() {
    return this.entities.ofKind('player');
  }
  editTerrain(edit: Omit<TerrainEdit, 'id'>, source?: ServerEntity) {
    const e = clampEdit({ ...edit, id: ++this.editCount });
    this.edits.add(e);
    this.terrain.invalidate(e.x - 5, e.y - 5, e.z - 5, e.x + 5, e.y + 5, e.z + 5);
    this.bus.emit('terrainEdited', { edit: e, source });
    this.onEdit(e);
    return e;
  }
  groundAt(x: number, y: number, z: number, maxDrop = 80) {
    return this.terrain.groundBelow(x, y, z, maxDrop);
  }
  gravityAt(p: Vec3) {
    return this.gen.gravityAt(p[0], p[1], p[2]);
  }
  markPlayerDirty() {}
  log(...a: unknown[]) {
    console.log('[harness]', ...a);
  }

  // ------------------------------------------------------------------ helpers

  /** A flat, dry spot near the world spawn (arena). */
  flatSpot(): Vec3 {
    const sp = this.gen.findSpawn();
    let best: Vec3 = sp, bestVar = Infinity;
    for (let i = 0; i < 60; i++) {
      const x = sp[0] + (i % 8) * 23 - 80, z = sp[2] + Math.floor(i / 8) * 23 - 80;
      const ys: number[] = [];
      for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [5, 5], [-5, -5]]) ys.push(this.gen.findGround(x + dx, sp[1] + 60, z + dz, 200));
      if (ys.some((y) => Number.isNaN(y) || y < 1)) continue;
      const v = Math.max(...ys) - Math.min(...ys);
      if (v < bestVar) {
        bestVar = v;
        best = [x, ys[0], z];
      }
    }
    return best;
  }

  /** Put an entity on the ground at (x, z). */
  place(e: ServerEntity, x: number, z: number, yHint: number) {
    const gy = this.groundAt(x, yHint + 30, z, 80);
    e.pos = [x, Number.isNaN(gy) ? yHint : gy + 0.02, z];
    this.entities.reindex(e);
  }

  /** A player with every skill at `level` (all abilities unlocked), sword & shield, arrows, food. */
  addPlayer(pos: Vec3, level = 80): ServerEntity {
    const p = makeEntity(this.newEntityId(), 'player', pos, 'players', this.time.now);
    p.name = 'Tester';
    p.faction = 'player';
    p.inventory = { items: [harnessItem('arrow', 500), harnessItem('bread', 20), harnessItem('crystal_shard', 10)], capacity: 200, coins: 10 };
    p.equipment = { mainhand: harnessItem('sword_iron'), offhand: harnessItem('shield_round'), chest: harnessItem('chain_mail') };
    this.playerData.set(p.id, {
      home: [...pos] as Vec3, reputation: {}, journal: { quests: [], log: [], discoveries: [] }, cooldowns: {}, gravityMul: 1, lastSite: null, lastBiome: -1,
      discovered: new Set(), lastMoveTime: 0, lastPos: [...pos] as Vec3, fallStartY: 0, falling: false, maxFallSpeed: 0,
    });
    this.spawn(p);
    this.place(p, pos[0], pos[2], pos[1]);
    this.gameplay.initSkills(p);
    if (level > 0) for (const s of SKILLS) this.gameplay.grantXp(p, s.id, totalXpForLevel(level) + 1);
    this.gameplay.recomputeStats(p);
    this.gameplay.onPlayerJoin(p);
    p.hp = p.maxHp;
    p.mana = p.stats!.maxMana;
    p.stamina = p.stats!.maxStamina;
    return p;
  }

  /** A sturdy target dummy (creature or npc). */
  addDummy(x: number, z: number, yHint: number, faction = 'hostile', kind: 'creature' | 'npc' = 'creature', hp = 400): ServerEntity {
    const d = makeEntity(this.newEntityId(), kind, [x, yHint, z], kind === 'npc' ? 'npcs' : 'creatures', this.time.now);
    d.name = kind === 'npc' ? 'Villager' : 'Training Dummy';
    d.faction = faction;
    d.maxHp = d.hp = hp;
    if (kind === 'creature') d.creature = { species: d.id % 5, seed: d.id, growth: 1 };
    this.spawn(d);
    this.place(d, x, z, yHint);
    this.gameplay.setBaseStats(d, { maxHp: hp });
    d.hp = d.maxHp;
    return d;
  }

  /** Advance the server by `seconds` at 20 Hz. */
  tick(seconds: number) {
    const n = Math.max(1, Math.round(seconds / 0.05));
    for (let i = 0; i < n; i++) {
      this.time.now += 0.05;
      const t0 = performance.now();
      this.gameplay.tick(0.05);
      this.slowAcc += 0.05;
      if (this.slowAcc >= 1) {
        this.slowAcc = 0;
        this.gameplay.slowTick();
      }
      this.worstTickMs = Math.max(this.worstTickMs, performance.now() - t0);
    }
  }
}
