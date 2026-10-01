/**
 * Headless Game Master simulation: `npx tsx tools/gm-sim.ts [seed] [minutes] [--real] [--quiet]`
 *
 * Joins a fake player, walks it around the world (toward unexplored places and
 * tracked quest objectives), fights whatever the director sends, accepts quests,
 * talks to the GM, commits a crime, dies once, then saves, reloads into a fresh
 * server and reconnects to check recaps and persistence. Prints the GM's output
 * plus pacing/variety statistics.
 *
 * By default it tries the real GameServer; if other domains are mid-refactor and
 * it fails to load (or with --mini), it uses a self-contained mini server that
 * runs the lead's World/Player systems + the GameMaster with simple service stubs
 * (which *do* spawn creatures/NPC entities so encounters and kill quests work).
 */
import { WorldGenerator } from '../src/world/generator';
import { TerrainCollider } from '../src/world/collider';
import { EditStore, clampEdit, type TerrainEdit } from '../src/world/edits';
import { Rng, deriveSeed } from '../src/core/rng';
import { Emitter } from '../src/core/events';
import { EntityStore, makeEntity, type ServerEntity } from '../src/server/entity';
import type { ServerContext, ServerSystem, ServerBusEvents, Services, ServerTime } from '../src/server/context';
import type { ClientMessage, GameEvent, ServerMessage } from '../src/shared/protocol';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import type { EntityId, Vec3, WeatherState, DamageType } from '../src/shared/types';
import { PlayerSystem } from '../src/server/systems/PlayerSystem';
import { WorldSystem } from '../src/server/systems/WorldSystem';
import { GameMaster } from '../src/gm/server/GameMaster';
import { randomAppearance } from '../src/humanoid/appearance';
import type { ItemInstance } from '../src/items/types';
import type { GmMessage } from '../src/gm/types';

const args = process.argv.slice(2);
const seed = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
const minutes = Number(args.filter((a) => /^\d+$/.test(a))[1] ?? 30);
const QUIET = args.includes('--quiet');
const FORCE_MINI = args.includes('--mini');

// ------------------------------------------------------------------ mini server

const SPECIES = ['ash wolf', 'gloomstalker', 'thornback boar', 'skreel', 'marrow bear', 'glass mantis'];

/** Minimal ServerContext: lead's World/Player systems + GameMaster + spawning stubs. */
class MiniServer implements ServerContext {
  readonly seed: number;
  readonly gen: WorldGenerator;
  readonly edits = new EditStore();
  readonly terrain: TerrainCollider;
  readonly entities = new EntityStore();
  readonly bus = new Emitter<ServerBusEvents>();
  readonly time: ServerTime = { now: 0, dt: 0.05, timeOfDay: 0.3, day: 0, hour: 7 };
  weather: WeatherState = { kind: 'clear', intensity: 0, windX: 1, windZ: 0 };
  readonly systems: ServerSystem[] = [];
  readonly services: Services;
  readonly playerSys = new PlayerSystem();
  readonly worldSys = new WorldSystem();
  readonly gm = new GameMaster();
  private conns = new Map<EntityId, (m: ServerMessage) => void>();
  private slowAcc = 0;
  private editId = 1;
  events: GameEvent[] = [];

  constructor(seed: number) {
    this.seed = seed;
    this.gen = new WorldGenerator(seed);
    this.terrain = new TerrainCollider(this.gen, this.edits);
    let uid = 1;
    const self = this;
    const services = {
      combat: {
        damage(target: ServerEntity, amount: number, type: DamageType, source?: ServerEntity) {
          if (!target.alive) return 0;
          target.hp -= amount;
          target.lastAttacker = source?.id;
          self.bus.emit('damage', { target, source, amount, type });
          if (target.hp <= 0) this.kill(target, source);
          return amount;
        },
        heal(t: ServerEntity, a: number) {
          t.hp = Math.min(t.maxHp, t.hp + a);
          return a;
        },
        kill(target: ServerEntity, killer?: ServerEntity) {
          if (!target.alive) return;
          target.alive = false;
          target.hp = 0;
          self.bus.emit('death', { entity: target, killer });
          if (target.kind === 'player') self.bus.emit('playerDied', { player: target, killer });
        },
        isHostile: (a: ServerEntity, b: ServerEntity) => a.faction !== b.faction && (a.faction === 'hostile' || b.faction === 'hostile'),
        applyEffect() {},
        knockback() {},
      },
      skills: {
        grantXp(e: ServerEntity, skill: string, amount: number) {
          const s = e.skills!;
          const p = (s.skills[skill] ??= { level: 0, xp: 0 });
          p.xp += amount;
          while (p.xp >= 40 * Math.pow(p.level + 1, 1.55)) {
            p.xp -= 40 * Math.pow(p.level + 1, 1.55);
            p.level++;
            self.bus.emit('skillXp', { entity: e, skill, amount, level: p.level, leveled: true });
          }
        },
        level: (e: ServerEntity, s: string) => e.skills?.skills[s]?.level ?? 0,
        recomputeStats(e: ServerEntity) {
          e.stats = { maxHp: 100, maxStamina: 100, maxMana: 100, hpRegen: 0.5, staminaRegen: 8, manaRegen: 1, armor: 0, moveSpeed: 1, jump: 1, carry: 120, stealth: 0, perception: 0, resist: {} };
          e.maxHp = 100;
        },
        initSkills(e: ServerEntity) {
          // A seasoned character so the director may field bosses.
          e.skills = { skills: { swords: { level: 14, xp: 0 }, survival: { level: 6, xp: 0 }, archery: { level: 4, xp: 0 } }, abilities: [], hotbar: [] };
        },
      },
      items: {
        create(defId: string, opts: { count?: number } = {}): ItemInstance {
          return { uid: 'i' + uid++, defId, count: opts.count ?? 1, name: defId.replace(/_/g, ' '), rarity: 'common', quality: 0.5, material: 'iron', affixes: [], mods: {}, durability: 100, maxDurability: 100, value: 5, visual: { shape: 'misc', seed: 1, primary: [0.5, 0.5, 0.5], secondary: [0.3, 0.3, 0.3], accent: [0.8, 0.7, 0.2], material: 'metal', glow: 0, glowColor: [0, 0, 0], wear: 0, style: 'human' } };
        },
        rollLoot(table: string, level: number, s: number) {
          return new Rng(s).chance(0.5) ? [this.create(`${table.split('.')[0]}_trinket`)] : [];
        },
        give(e: ServerEntity, it: ItemInstance, how: ServerBusEvents['itemAcquired']['how'] = 'gift') {
          e.inventory?.items.push(it);
          self.bus.emit('itemAcquired', { entity: e, item: it, how });
          return true;
        },
        take(e: ServerEntity, u: string) {
          const i = e.inventory!.items.findIndex((x) => x.uid === u);
          return i < 0 ? null : e.inventory!.items.splice(i, 1)[0];
        },
        drop(pos: Vec3, it: ItemInstance) {
          const e = makeEntity(self.newEntityId(), 'item', pos, 'items', self.time.now);
          e.item = it;
          return self.spawn(e);
        },
        equip: () => false,
        outfitFor() {},
        valueOf: (it: ItemInstance) => it.value,
        def: () => undefined,
      },
      objects: { registerProvider() {}, damage: () => 0, near: () => [], state: () => undefined },
      settlements: { layout: () => null, siteAt: (p: Vec3) => self.gen.siteAt(p[0], p[2]), sitesNear: (p: Vec3, r: number) => self.gen.sites.sitesNear(p[0], p[2], r), buildingsNear: () => [], insideBuilding: () => null },
      npcs: {
        profile: () => undefined, ensureSettlement() {}, adjustDisposition() {}, disposition: () => 0, remember() {},
        spawnWanderer(kind: string, pos: Vec3, s: number) {
          const e = makeEntity(self.newEntityId(), 'npc', pos, 'npcs', self.time.now);
          e.name = `${kind} #${s % 100}`;
          e.faction = kind === 'bandit' || kind === 'bounty_hunter' ? 'hostile' : 'neutral';
          e.tags.add(kind);
          e.inventory = { items: [], capacity: 10, coins: 0 };
          return self.spawn(e);
        },
      },
      creatures: {
        speciesCount: () => SPECIES.length,
        spawn(species: number, pos: Vec3, opts: { seed?: number; boss?: boolean; growth?: number } = {}) {
          const e = makeEntity(self.newEntityId(), 'creature', pos, 'creatures', self.time.now);
          e.creature = { species, seed: opts.seed ?? 1, growth: opts.growth ?? 1 };
          e.faction = 'hostile';
          e.maxHp = e.hp = opts.boss ? 400 : 60;
          if (opts.boss) e.tags.add('boss');
          return self.spawn(e);
        },
        speciesFor: (_b: number, role: string) => (role === 'boss' ? [4] : [0, 1, 2, 3, 5]),
        speciesName: (s: number) => SPECIES[s] ?? 'beast',
        tryTame: () => false,
      },
      dialog: { start() {}, end() {} },
      gm: this.gm,
    };
    this.services = services as unknown as Services;
    this.systems.push(this.worldSys, this.playerSys, this.gm);
    for (const s of this.systems) s.init?.(this);
  }

  rng(...tag: (string | number)[]) {
    return new Rng(deriveSeed(this.seed, ...tag));
  }
  newEntityId() {
    return this.entities.allocId();
  }
  spawn(e: ServerEntity) {
    this.entities.add(e);
    return e;
  }
  despawn(id: EntityId) {
    const e = this.entities.remove(id);
    if (e) for (const s of this.systems) s.onEntityRemoved?.(e);
  }
  broadcast(ev: GameEvent) {
    this.events.push(ev);
  }
  send(id: EntityId, msg: ServerMessage) {
    this.conns.get(id)?.(msg);
  }
  players() {
    return [...this.conns.keys()].map((id) => this.entities.get(id)).filter((e): e is ServerEntity => !!e);
  }
  editTerrain(edit: Omit<TerrainEdit, 'id'>, source?: ServerEntity) {
    const e = clampEdit({ ...edit, id: this.editId++ });
    this.edits.add(e);
    this.bus.emit('terrainEdited', { edit: e, source });
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
    console.log('[mini]', ...a);
  }
  connect(send: (m: ServerMessage) => void) {
    let pid: EntityId | null = null;
    return (msg: ClientMessage) => {
      if (msg.t === 'hello') {
        const p = this.playerSys.join(msg.name, msg.appearance);
        pid = p.id;
        this.conns.set(p.id, send);
        for (const s of this.systems) s.onPlayerJoin?.(p);
        this.bus.emit('playerJoined', { player: p });
        send({ t: 'welcome', version: PROTOCOL_VERSION, playerId: p.id, seed: this.seed, serverTime: this.time.now, spawn: p.pos, player: this.playerSys.fullState(p) });
        return;
      }
      const p = pid !== null ? this.entities.get(pid) : undefined;
      if (!p) return;
      for (const s of this.systems) if (s.onMessage?.(p, msg)) return;
    };
  }
  disconnect(id: EntityId) {
    this.conns.delete(id);
    this.despawn(id);
  }
  tick() {
    this.time.now += 0.05;
    for (const s of this.systems) s.tick?.(0.05);
    this.slowAcc += 0.05;
    if (this.slowAcc >= 1) {
      for (const s of this.systems) s.slowTick?.(this.slowAcc);
      this.slowAcc = 0;
    }
  }
  save() {
    const systems: Record<string, unknown> = {};
    for (const s of this.systems) systems[s.name] = s.save?.();
    return { time: { ...this.time }, systems };
  }
  load(d: { time: ServerTime; systems: Record<string, unknown> }) {
    Object.assign(this.time, d.time);
    for (const s of this.systems) if (d.systems[s.name] !== undefined) s.load?.(JSON.parse(JSON.stringify(d.systems[s.name])));
  }
}

// ------------------------------------------------------------------ server factory

interface SimServer {
  ctx: ServerContext;
  gm: GameMaster;
  connect(send: (m: ServerMessage) => void): (msg: ClientMessage) => void;
  disconnect(id: EntityId): void;
  tick(): void;
  save(): unknown;
  load(d: unknown): void;
}

async function makeServer(s: number): Promise<{ server: SimServer; kind: string }> {
  if (!FORCE_MINI) {
    try {
      const mod = await import('../src/server/GameServer');
      const gs = new mod.GameServer(s);
      const gm = gs.systems.find((x) => x.name === 'gm') as GameMaster;
      return {
        kind: 'real GameServer',
        server: { ctx: gs, gm, connect: (f) => gs.connect(f), disconnect: (id) => gs.disconnect(id), tick: () => gs.tick(), save: () => gs.save(), load: (d) => gs.load(d as Parameters<typeof gs.load>[0]) },
      };
    } catch (err) {
      console.log(`(real GameServer unavailable: ${(err as Error).message.split('\n')[0]} — using mini server)`);
    }
  }
  const ms = new MiniServer(s);
  return { kind: 'mini server', server: { ctx: ms, gm: ms.gm, connect: (f) => ms.connect(f), disconnect: (id) => ms.disconnect(id), tick: () => ms.tick(), save: () => ms.save(), load: (d) => ms.load(d as Parameters<typeof ms.load>[0]) } };
}

// ------------------------------------------------------------------ simulation

interface Client {
  id: EntityId;
  send: (m: ClientMessage) => void;
  msgs: GmMessage[];
  questsOffered: Set<string>;
  seq: number;
}

function fmtTime(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function join(server: SimServer, name: string): Client {
  const c: Client = { id: -1, send: () => {}, msgs: [], questsOffered: new Set(), seq: 0 };
  c.send = server.connect((m) => {
    if (m.t === 'welcome') c.id = m.playerId;
    if (m.t === 'gm') {
      for (const g of m.messages) {
        c.msgs.push(g);
        if (g.kind === 'quest' && g.quest) c.questsOffered.add(g.quest);
        if (!QUIET) console.log(`[${fmtTime(g.t)}] ${g.kind.toUpperCase().padEnd(9)} ${g.title ? `«${g.title}» ` : ''}${g.text}`);
      }
    }
  });
  c.send({ t: 'hello', version: PROTOCOL_VERSION, name, appearance: randomAppearance('human', 1234) });
  return c;
}

async function run() {
  const { server, kind } = await makeServer(seed);
  const ctx = server.ctx;
  console.log(`=== Norgo GM sim — seed ${seed}, world ${ctx.gen.profile.name}, ${minutes} min, ${kind} ===`);
  const t0 = Date.now();
  let client = join(server, 'Aria');
  const rng = new Rng(seed ^ 0x51);
  const questions = ['Where am I?', 'What should I do?', 'Tell me about the gods', 'Where is the nearest town?', 'Is there a way down to the underworld?', 'How is the weather?', 'Who rules here?', 'Any rumors?', 'Give me a challenge!', 'What is my quest?', 'Why is gravity strange here?', 'How am I doing?', 'recap please'];
  let qi = 0;
  const phaseLog: string[] = [];
  let lastPhase = '';
  let crimeDone = false, deathDone = false, savedOnce = false;
  let target: Vec3 | null = null;
  let uwReturn = -1;
  let surface: Vec3 | null = null;
  const totalTicks = minutes * 60 * 20;
  const tensionSamples: number[] = [];

  for (let tick = 0; tick < totalTicks; tick++) {
    const p = ctx.entities.get(client.id);
    if (!p) break;
    const now = ctx.time.now;
    // --- choose where to walk: tracked quest objective, else an unexplored POI ---
    if (tick % 20 === 0) {
      const d = (ctx as unknown as { playerSys: PlayerSystem }).playerSys.playerData(p.id);
      const quests = d?.journal.quests ?? [];
      for (const q of quests) if (q.status === 'offered') client.send({ t: 'questAction', quest: q.id, action: 'accept' });
      const tracked = quests.find((q) => q.status === 'active' && q.tracked) ?? quests.find((q) => q.status === 'active');
      const obj = tracked?.objectives.find((o) => !o.done && o.pos);
      if (obj?.pos) target = obj.pos;
      else if (!target || Math.hypot(target[0] - p.pos[0], target[2] - p.pos[2]) < 15) {
        const pois = ctx.gen.sites.poisNear(p.pos[0], p.pos[2], 900).filter((x) => !d?.discovered.has(x.id));
        target = pois.length ? [pois[0].x, pois[0].y, pois[0].z] : [p.pos[0] + rng.range(-400, 400), 0, p.pos[2] + rng.range(-400, 400)];
      }
    }
    // --- move (teleport if very far, else walk at 7 m/s; idle near targets so lingers complete) ---
    if (target && p.alive && !(tick > 20 * 60 * 15 && tick < uwReturn)) {
      const dx = target[0] - p.pos[0], dz = target[2] - p.pos[2];
      const dist = Math.hypot(dx, dz);
      if (dist > 900) {
        client.send({ t: 'debug', cmd: 'tp', args: [target[0] - dx / dist * 60, NaN, target[2] - dz / dist * 60] });
      } else if (dist > 6) {
        const step = Math.min(dist, 0.35);
        const nx = p.pos[0] + (dx / dist) * step, nz = p.pos[2] + (dz / dist) * step;
        const ny = ctx.gen.heightAt(nx, nz);
        const yaw = Math.atan2(-dx, -dz);
        client.send({ t: 'move', seq: client.seq++, pos: [nx, Math.max(ny, 0.2), nz], vel: [0, 0, 0], yaw, move: 'walk', grounded: true });
      }
    }
    // --- fight what the director sends: kill GM-spawned hostiles within 40 m after a short exchange ---
    if (tick % 40 === 0 && p.alive) {
      const foes = ctx.entities.near(p.pos, 45, (e) => e.alive && e !== p && (e.faction === 'hostile' || e.tags.has('bandit')));
      for (const f of foes.slice(0, 2)) {
        ctx.services.combat.damage(p, 6, 'slash', f);
        ctx.services.combat.damage(f, 1000, 'slash', p);
      }
    }
    if (!p.alive && tick % 100 === 0) client.send({ t: 'respawn' });
    // --- the LLM config debug command reaches the GM (empty config = scripted brain) ---
    if (tick === 300) client.send({ t: 'debug', cmd: 'gmLlmConfig', args: [{}] });
    // --- talk to the GM ---
    if (tick % (20 * 75) === 600) client.send({ t: 'gmAsk', text: questions[qi++ % questions.length] });
    // Riddles: a well-read adventurer tries the classic answers when standing at a riddle.
    if (tick % 200 === 100) {
      const d = (ctx as unknown as { playerSys: PlayerSystem }).playerSys.playerData(p.id);
      const rq = d?.journal.quests.find((q) => q.status === 'active' && q.objectives.some((o) => !o.done && /riddle/i.test(o.text) && o.pos && Math.hypot(o.pos[0] - p.pos[0], o.pos[2] - p.pos[2]) < 40));
      if (rq) client.send({ t: 'gmAsk', text: 'Is the answer an echo, a mountain, footsteps, night, breath, fire, wind, a stone or a coffin?' });
    }
    // --- lose to a named beast once (nemesis); it should come back for revenge later ---
    if (!deathDone && now > 540 && p.alive && p.hp > 50) {
      const sp = ctx.services.creatures.spawn(4, [p.pos[0] + 8, p.pos[1], p.pos[2]], { boss: true, seed: 99 });
      if (sp) {
        sp.name = 'Gutmaw the Unfed';
        ctx.services.combat.damage(p, 1000, 'slash', sp);
        deathDone = true;
      }
    }
    // --- an excursion into the underworld (and back) to exercise depth narration ---
    if (tick === 20 * 60 * 15) {
      for (let k = 0; k < 400; k++) {
        const x = p.pos[0] + (k % 20) * 25 - 250, z = p.pos[2] + Math.floor(k / 20) * 25 - 250;
        const col = ctx.gen.cachedColumn(x, z);
        if (col.uwCeil - col.uwFloor > 14) {
          client.send({ t: 'debug', cmd: 'tp', args: [x, col.uwFloor + 0.5, z] });
          uwReturn = tick + 20 * 70;
          surface = [p.pos[0], p.pos[1], p.pos[2]];
          break;
        }
      }
    }
    if (tick === uwReturn && surface) client.send({ t: 'debug', cmd: 'tp', args: [surface[0], NaN, surface[2]] });
    if (tick > 20 * 60 * 15 && tick < uwReturn) target = null;
    // --- a crime ---
    if (!crimeDone && now > 420) {
      ctx.bus.emit('crime', { offender: p, kind: 'theft', pos: p.pos });
      crimeDone = true;
    }
    // --- save, reload into a fresh server, reconnect ---
    if (!savedOnce && tick === Math.floor(totalTicks * 0.6)) {
      savedOnce = true;
      const data = JSON.parse(JSON.stringify(server.save()));
      console.log(`\n----- saving (${JSON.stringify(data).length} bytes) and reloading into a fresh server -----\n`);
      const fresh = (await makeServer(seed)).server;
      fresh.load(data);
      const prevMsgs = client.msgs;
      client = join(fresh, 'Aria');
      client.msgs.unshift(...prevMsgs);
      return finish(fresh, client, phaseLog, tensionSamples, t0, totalTicks - tick);
    }
    server.tick();
    const st = server.gm.debugState(p);
    if (st.phase !== lastPhase) {
      phaseLog.push(`${fmtTime(ctx.time.now)} ${st.phase}`);
      lastPhase = st.phase;
    }
    if (tick % 200 === 0) tensionSamples.push(st.tension);
  }
  report(server, client, phaseLog, tensionSamples, t0);
}

/** Continue the second half after reload (simpler loop: walk + tick). */
async function finish(server: SimServer, client: Client, phaseLog: string[], tension: number[], t0: number, ticks: number) {
  const ctx = server.ctx;
  for (let i = 0; i < ticks; i++) {
    const p = ctx.entities.get(client.id);
    if (!p) break;
    if (i % 20 === 0) {
      const d = (ctx as unknown as { playerSys: PlayerSystem }).playerSys.playerData(p.id);
      for (const q of d?.journal.quests ?? []) if (q.status === 'offered') client.send({ t: 'questAction', quest: q.id, action: 'accept' });
    }
    if (i % 40 === 0 && p.alive) {
      for (const f of ctx.entities.near(p.pos, 45, (e) => e.alive && e !== p && (e.faction === 'hostile' || e.tags.has('bandit'))).slice(0, 2)) ctx.services.combat.damage(f, 1000, 'slash', p);
    }
    if (i === 400) client.send({ t: 'gmAsk', text: 'What happened so far?' });
    if (i === 900) client.send({ t: 'gmAsk', text: 'pay my bounty' });
    if (!p.alive && i % 100 === 0) client.send({ t: 'respawn' });
    const ang = i / 900;
    const nx = p.pos[0] + Math.cos(ang) * 0.3, nz = p.pos[2] + Math.sin(ang) * 0.3;
    client.send({ t: 'move', seq: client.seq++, pos: [nx, Math.max(ctx.gen.heightAt(nx, nz), 0.2), nz], vel: [0, 0, 0], yaw: 0, move: 'walk', grounded: true });
    server.tick();
    if (i % 200 === 0) tension.push(server.gm.debugState(p).tension);
  }
  report(server, client, phaseLog, tension, t0);
}

function report(server: SimServer, client: Client, phaseLog: string[], tension: number[], t0: number) {
  const msgs = client.msgs;
  const byKind: Record<string, number> = {};
  for (const m of msgs) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  const texts = msgs.map((m) => m.text);
  const unique = new Set(texts).size;
  const p = server.ctx.entities.get(client.id);
  console.log('\n=================== summary ===================');
  console.log(`messages: ${msgs.length} (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`unique texts: ${unique}/${texts.length} (${((unique / Math.max(1, texts.length)) * 100).toFixed(1)}%)`);
  console.log(`phases: ${phaseLog.slice(0, 24).join(' → ')}${phaseLog.length > 24 ? ' …' : ''}`);
  console.log(`tension samples: ${tension.map((t) => t.toFixed(2)).join(' ')}`);
  if (p) {
    const st = server.gm.debugState(p);
    console.log(`dominant style: ${st.dominant} ${JSON.stringify(Object.fromEntries(Object.entries(st.style).map(([k, v]) => [k, +v.toFixed(2)])))}`);
    console.log(`quests: ${st.quests.map((q) => `${q.title} [${q.status}]`).join('; ')}`);
    console.log(`bounty: ${JSON.stringify(st.bounty)}; nemeses: ${st.nemeses.map((n) => `${n.name}${n.defeated ? ' (defeated)' : ''}`).join(', ') || 'none'}; arc: ${st.arc ? `${st.arc.id} stage ${st.arc.stage}` : 'none'}`);
    console.log(`history: kills ${st.history.kills}, discoveries ${st.history.discoveries}, quests ${st.history.questsCompleted}/${st.history.questsFailed} failed, deaths ${st.history.deaths}`);
  }
  console.log(`tension(): ${server.gm.tension().toFixed(2)}; wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
