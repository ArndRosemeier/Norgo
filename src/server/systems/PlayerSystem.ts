/**
 * Player entities: joining, movement validation (client-predicted movement with
 * server sanity checks), exploration events, respawn, debug commands, player
 * state replication and persistence.
 */
import type { ServerContext, ServerSystem } from '../context';
import { makeEntity, ServerEntity } from '../entity';
import type { ClientMessage, PlayerState } from '../../shared/protocol';
import type { HumanoidAppearance } from '../../humanoid/types';
import type { EntityId, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import { BIOMES, Biome } from '../../world/biomes';
import type { SiteInfo } from '../../world/sites';
import type { WorldSystem } from './WorldSystem';
import type { WeatherKind } from '../../shared/types';
import type { JournalState } from '../../gm/types';

export interface PlayerData {
  home: Vec3;
  reputation: Record<string, number>;
  journal: JournalState;
  cooldowns: Record<string, number>;
  gravityMul: number;
  lastSite: SiteInfo | null;
  lastBiome: number;
  discovered: Set<string>;
  lastMoveTime: number;
  lastPos: Vec3;
  fallStartY: number;
  falling: boolean;
  maxFallSpeed: number;
}

interface SavedPlayer {
  name: string;
  pos: Vec3;
  yaw: number;
  hp: number;
  stamina: number;
  mana: number;
  appearance: HumanoidAppearance;
  inventory: ServerEntity['inventory'];
  equipment: ServerEntity['equipment'];
  skills: ServerEntity['skills'];
  effects: ServerEntity['effects'];
  data: Omit<PlayerData, 'discovered' | 'lastSite'> & { discovered: string[] };
}

export class PlayerSystem implements ServerSystem {
  readonly name = 'players';
  private ctx!: ServerContext;
  readonly data = new Map<EntityId, PlayerData>();
  private saved = new Map<string, SavedPlayer>();

  init(ctx: ServerContext) {
    this.ctx = ctx;
  }

  join(name: string, appearance: HumanoidAppearance): ServerEntity {
    const ctx = this.ctx;
    const sp = ctx.gen.findSpawn();
    const e = makeEntity(ctx.newEntityId(), 'player', sp, 'players', ctx.time.now);
    e.name = name || 'Wanderer';
    e.humanoid = appearance;
    e.faction = 'player';
    e.radius = 0.35;
    e.height = 1.75 * (appearance.scale || 1);
    e.inventory = { items: [], capacity: 120, coins: 25 };
    e.equipment = {};
    e.tags.add('player');
    const d: PlayerData = {
      home: [sp[0], sp[1], sp[2]],
      reputation: {},
      journal: { quests: [], log: [], discoveries: [] },
      cooldowns: {},
      gravityMul: 1,
      lastSite: null,
      lastBiome: -1,
      discovered: new Set(),
      lastMoveTime: ctx.time.now,
      lastPos: [sp[0], sp[1], sp[2]],
      fallStartY: sp[1],
      falling: false,
      maxFallSpeed: 0,
    };
    const saved = this.saved.get(e.name);
    ctx.services.skills.initSkills(e);
    if (saved) {
      e.pos = saved.pos;
      e.yaw = saved.yaw;
      e.humanoid = saved.appearance;
      e.inventory = saved.inventory;
      e.equipment = saved.equipment;
      if (saved.skills) e.skills = saved.skills;
      // JSON turns Infinity (toggles/permanent effects) into null; toggles are re-applied by gameplay.
      e.effects = (saved.effects ?? []).filter((x) => typeof x.until === 'number' && Number.isFinite(x.until));
      Object.assign(d, saved.data, { discovered: new Set(saved.data.discovered), lastSite: null });
      d.lastPos = [...e.pos] as Vec3;
    } else {
      this.starterKit(e);
    }
    ctx.services.skills.recomputeStats(e);
    if (saved) {
      e.hp = Math.min(saved.hp, e.maxHp);
      e.stamina = saved.stamina;
      e.mana = saved.mana;
    } else {
      e.hp = e.maxHp;
      e.stamina = e.stats?.maxStamina ?? 100;
      e.mana = e.stats?.maxMana ?? 100;
    }
    this.data.set(e.id, d);
    ctx.spawn(e);
    return e;
  }

  private starterKit(e: ServerEntity) {
    const items = this.ctx.services.items;
    const kit = ['tunic_linen', 'trousers_wool', 'boots_leather', 'knife_iron', 'torch', 'bread', 'bread', 'waterskin', 'pick_iron'];
    for (const id of kit) {
      try {
        const it = items.create(id, { seed: this.ctx.rng('starter', e.name, id).nextU32() });
        items.give(e, it, 'gift');
      } catch {
        /* unknown def in stub item system */
      }
    }
    for (const it of [...(e.inventory?.items ?? [])]) {
      const def = items.def(it.defId);
      if (def && def.slots.length && !['torch'].includes(def.id)) items.equip(e, it.uid);
    }
    // New travellers start with a torch lit in the off hand.
    const torch = e.inventory?.items.find((x) => x.defId === 'torch');
    if (torch) items.equip(e, torch.uid, 'offhand');
  }

  playerData(id: EntityId) {
    return this.data.get(id);
  }

  onMessage(p: ServerEntity, msg: ClientMessage): boolean {
    if (p.kind !== 'player') return false;
    const d = this.data.get(p.id);
    if (!d) return false;
    switch (msg.t) {
      case 'move':
        this.onMove(p, d, msg);
        return true;
      case 'respawn':
        if (!p.alive) this.respawn(p, d);
        return true;
      case 'hotbar':
        if (p.skills && msg.slot >= 0 && msg.slot < 12) {
          p.skills.hotbar[msg.slot] = msg.value;
          this.ctx.markPlayerDirty(p.id, 'skills');
        }
        return true;
      case 'debug':
        // Unknown commands fall through to other systems (llmConfig, gmLlmConfig...).
        return this.debug(p, d, msg.cmd, msg.args ?? []);
      case 'chat':
        p.speech = { text: msg.text.slice(0, 200), until: this.ctx.time.now + 6, style: 'say' };
        return true;
    }
    return false;
  }

  private onMove(p: ServerEntity, d: PlayerData, msg: Extract<ClientMessage, { t: 'move' }>) {
    if (!p.alive) return;
    const ctx = this.ctx;
    const dtReal = Math.max(0.02, ctx.time.now - d.lastMoveTime);
    const dx = msg.pos[0] - p.pos[0], dy = msg.pos[1] - p.pos[1], dz = msg.pos[2] - p.pos[2];
    const dist = Math.hypot(dx, dz);
    // Generous speed sanity check (allow blink/leap abilities via 'teleportGrace' tag).
    const maxSpeed = 60 * (p.tags.has('teleportGrace') ? 20 : 1);
    if (dist > maxSpeed * dtReal + 5 && !p.tags.has('teleportGrace')) {
      ctx.send(p.id, { t: 'correct', pos: p.pos, reason: 'speed' });
      return;
    }
    p.tags.delete('teleportGrace');
    // Fall damage: track fall speed; apply on landing.
    if (!msg.grounded && msg.vel[1] < -1) {
      d.falling = true;
      d.maxFallSpeed = Math.max(d.maxFallSpeed, -msg.vel[1]);
    } else if (msg.grounded && d.falling) {
      d.falling = false;
      const v = d.maxFallSpeed;
      d.maxFallSpeed = 0;
      const safe = 13 * Math.sqrt(ctx.gravityAt(p.pos) / 9.81);
      if (v > safe && msg.move !== 'swim') {
        const dmg = Math.pow(v - safe, 1.6) * 2.2;
        ctx.services.combat.damage(p, dmg, 'fall');
      }
    }
    p.pos = [msg.pos[0], msg.pos[1], msg.pos[2]];
    p.vel = [msg.vel[0], msg.vel[1], msg.vel[2]];
    p.yaw = msg.yaw;
    p.grounded = msg.grounded;
    p.anim = { ...p.anim, move: msg.move, lookAt: msg.aim };
    if (msg.move === 'swim') p.flags |= EntFlag.Swimming;
    else p.flags &= ~EntFlag.Swimming;
    if (msg.move === 'crouch') p.flags |= EntFlag.Sneaking;
    else p.flags &= ~EntFlag.Sneaking;
    ctx.entities.reindex(p);
    // Exertion.
    if (msg.move === 'sprint') p.stamina = Math.max(0, p.stamina - 10 * dtReal);
    if (msg.move === 'climb') p.stamina = Math.max(0, p.stamina - 6 * dtReal);
    if (msg.move === 'swim') p.stamina = Math.max(0, p.stamina - 3 * dtReal);
    d.lastMoveTime = ctx.time.now;
    d.lastPos = p.pos;
  }

  slowTick() {
    const ctx = this.ctx;
    for (const p of ctx.players()) {
      const d = this.data.get(p.id);
      if (!d) continue;
      // Settlement enter/leave.
      const site = ctx.gen.siteAt(p.pos[0], p.pos[2]);
      if (site?.id !== d.lastSite?.id) {
        if (d.lastSite) ctx.bus.emit('leaveSite', { player: p, site: d.lastSite });
        if (site) {
          ctx.bus.emit('enterSite', { player: p, site });
          if (!d.discovered.has(site.id)) {
            d.discovered.add(site.id);
            d.journal.discoveries.push({ id: site.id, name: site.name, pos: [site.x, site.plateau, site.z], kind: 'settlement' });
            ctx.markPlayerDirty(p.id, 'journal');
          }
        }
        d.lastSite = site;
      }
      // Biome change.
      const col = ctx.gen.cachedColumn(p.pos[0], p.pos[2]);
      const underworld = ctx.gen.isUnderworld(p.pos[0], p.pos[1], p.pos[2]);
      const biome = underworld ? col.uwBiome : col.biome === Biome.Ocean ? col.biome2 : col.biome;
      if (biome !== d.lastBiome) {
        d.lastBiome = biome;
        ctx.bus.emit('enterBiome', { player: p, biome, name: BIOMES[biome].name });
      }
      // POI discovery.
      for (const poi of ctx.gen.sites.poisNear(p.pos[0], p.pos[2], 40)) {
        if (d.discovered.has(poi.id)) continue;
        d.discovered.add(poi.id);
        d.journal.discoveries.push({ id: poi.id, name: poi.kind, pos: [poi.x, poi.y, poi.z], kind: poi.kind });
        ctx.bus.emit('discoverPoi', { player: p, poi });
        ctx.markPlayerDirty(p.id, 'journal');
      }
      // Gravity changes are surfaced to UI through stats; nothing else here.
      if (p.alive) ctx.markPlayerDirty(p.id, 'vitals');
    }
  }

  respawn(p: ServerEntity, d: PlayerData) {
    p.alive = true;
    p.hp = p.maxHp * 0.6;
    p.stamina = p.stats?.maxStamina ?? 100;
    p.pos = [d.home[0], d.home[1] + 0.5, d.home[2]];
    p.vel = [0, 0, 0];
    p.anim = { move: 'idle' };
    p.effects = [];
    p.tags.add('teleportGrace');
    this.ctx.entities.reindex(p);
    this.ctx.send(p.id, { t: 'correct', pos: p.pos, vel: [0, 0, 0], reason: 'respawn' });
    this.ctx.markPlayerDirty(p.id, 'vitals', 'effects');
  }

  private debug(p: ServerEntity, d: PlayerData, cmd: string, args: unknown[]): boolean {
    const ctx = this.ctx;
    switch (cmd) {
      case 'tp': {
        const [x, y, z] = (args as unknown[]).map((v) => (v === null || v === undefined ? NaN : Number(v)));
        if (!Number.isFinite(x) || !Number.isFinite(z)) break;
        const gy = Number.isFinite(y) ? y : ctx.gen.findGround(x, 600, z, 1200);
        p.pos = [x, (Number.isFinite(gy) ? gy : 100) + 1, z];
        p.tags.add('teleportGrace');
        ctx.entities.reindex(p);
        ctx.send(p.id, { t: 'correct', pos: p.pos, vel: [0, 0, 0], reason: 'teleport' });
        break;
      }
      case 'time':
        ctx.time.timeOfDay = ((Number(args[0]) % 1) + 1) % 1;
        break;
      case 'give': {
        const it = ctx.services.items.create(String(args[0]), { count: Number(args[1] ?? 1), rarity: args[2] as string | undefined });
        ctx.services.items.give(p, it, 'gift');
        break;
      }
      case 'heal':
        p.hp = p.maxHp;
        p.mana = p.stats?.maxMana ?? 100;
        p.stamina = p.stats?.maxStamina ?? 100;
        ctx.markPlayerDirty(p.id, 'vitals');
        break;
      case 'xp':
        ctx.services.skills.grantXp(p, String(args[0]), Number(args[1] ?? 1000));
        break;
      case 'spawn': {
        const sp = Number(args[0] ?? 0);
        // args: [species, boss?] — e.g. spawn [3, true] for a boss (music/boss testing).
        ctx.services.creatures.spawn(sp, [p.pos[0] + 6, p.pos[1] + 1, p.pos[2]], args[1] ? { boss: true } : undefined);
        break;
      }
      case 'weather': {
        const kind = String(args[0] ?? 'clear') as WeatherKind;
        const ws = (ctx as unknown as { worldSys: WorldSystem }).worldSys;
        ws.setWeather({ kind, intensity: Number(args[1] ?? 0.8), windX: 1, windZ: 0.3 }, 600);
        break;
      }
      case 'home':
        d.home = [...p.pos] as Vec3;
        break;
      default:
        return false;
    }
    return true;
  }

  // ------------------------------------------------------------ state replication

  fullState(p: ServerEntity): PlayerState {
    const d = this.data.get(p.id)!;
    return {
      id: p.id,
      name: p.name,
      appearance: p.humanoid!,
      hp: p.hp,
      stamina: p.stamina,
      mana: p.mana,
      stats: p.stats!,
      skills: p.skills!,
      inventory: p.inventory!,
      equipment: p.equipment!,
      effects: p.effects,
      cooldowns: d.cooldowns,
      journal: d.journal,
      reputation: d.reputation,
      gravityMul: d.gravityMul,
      home: d.home,
    };
  }

  partialState(p: ServerEntity, keys: Set<string>): Partial<PlayerState> {
    const d = this.data.get(p.id)!;
    const s: Partial<PlayerState> = {};
    for (const k of keys) {
      switch (k) {
        case 'vitals':
          s.hp = p.hp;
          s.stamina = p.stamina;
          s.mana = p.mana;
          break;
        case 'stats':
          s.stats = p.stats;
          break;
        case 'skills':
          s.skills = p.skills;
          break;
        case 'inventory':
          s.inventory = p.inventory;
          break;
        case 'equipment':
          s.equipment = p.equipment;
          s.inventory = p.inventory;
          break;
        case 'effects':
          s.effects = p.effects;
          break;
        case 'cooldowns':
          s.cooldowns = d.cooldowns;
          break;
        case 'journal':
          s.journal = d.journal;
          break;
        case 'reputation':
          s.reputation = d.reputation;
          break;
        case 'gravity':
          s.gravityMul = d.gravityMul;
          break;
        case 'appearance':
          s.appearance = p.humanoid;
          break;
      }
    }
    // Vitals ride along on every update.
    s.hp = p.hp;
    s.stamina = p.stamina;
    s.mana = p.mana;
    return s;
  }

  // ------------------------------------------------------------ persistence

  save() {
    for (const p of this.ctx.players()) this.storePlayer(p);
    return [...this.saved.values()];
  }

  private storePlayer(p: ServerEntity) {
    const d = this.data.get(p.id);
    if (!d) return;
    const { discovered, lastSite, ...rest } = d;
    this.saved.set(p.name, {
      name: p.name, pos: p.pos, yaw: p.yaw, hp: p.hp, stamina: p.stamina, mana: p.mana, appearance: p.humanoid!,
      inventory: p.inventory, equipment: p.equipment, skills: p.skills, effects: p.effects,
      data: { ...rest, discovered: [...discovered] },
    });
  }

  load(data: unknown) {
    for (const sp of data as SavedPlayer[]) this.saved.set(sp.name, sp);
  }

  onEntityRemoved(e: ServerEntity) {
    if (e.kind === 'player') {
      this.storePlayer(e);
      this.data.delete(e.id);
    }
  }
}
