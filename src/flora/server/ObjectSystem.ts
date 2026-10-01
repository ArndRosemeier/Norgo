/**
 * ObjectSystem — authoritative state of destructible / harvestable world objects.
 *
 * Scatter objects (trees, rocks, crystals, herbs, mushrooms, logs…) are not
 * stored anywhere: their existence is a pure function of the seed. The server
 * recomputes LOD-0 scatter (`gen.fillChunk(…, 0)` + `scatterChunk(objectsOnly)`)
 * for chunks on demand and keeps an LRU of the resulting object records, so
 * object ids (stable world-cell hashes) resolve to species, position and size.
 *
 * Only *changes* are state: damaged / felled / destroyed objects, kept in a
 * spatial index, persisted, and replicated as `ObjectState` to players in range
 * (all relevant states on join and whenever they approach new regions).
 * Harvested plants regrow after a while (sent as 'damaged' with hp = maxHp,
 * which clients treat as "restored").
 *
 * String ids ("prefix:...") are delegated to registered providers (e.g.
 * settlement building pieces) — this system tracks their hp and replication.
 */
import type { ObjectProvider, ObjectService, ServerContext, ServerSystem } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import { budgets } from '../../core/budgets';
import type { ClientMessage, ObjectState } from '../../shared/protocol';
import type { DamageType, EntityId, Vec3 } from '../../shared/types';
import type { ItemInstance } from '../../items/types';
import { CHUNK_SIZE } from '../../world/constants';
import { SCATTER_STRIDE } from '../../world/scatterTypes';
import { hash32, hashToFloat } from '../../core/rng';
import { scatterChunk } from '../scatter';
import { getFloraCatalog, parseKind, FloraCatalog, FloraSpecies, Yield, materialYields, oreFor } from '../species';

/** One scatter object known to the server. */
interface ObjRec {
  id: number;
  sp: FloraSpecies;
  mat: number;
  pos: Vec3;
  scale: number;
  maxHp: number;
  /** Interaction reach helpers: capsule height & radius in meters. */
  h: number;
  r: number;
}

interface ChunkRecs {
  recs: ObjRec[];
  lastUsed: number;
}

interface StateRec {
  st: ObjectState;
  kind: string;
  pos: Vec3;
  /** Server time at which a harvested plant regrows (0 = never). */
  regrowAt: number;
  version: number;
}

const STATE_CELL = 128;
const SYNC_RADIUS = 900;
/** Chunk record cache size: `budgets.objectChunks` (the main thread sends the device class to the server worker). */
const maxChunks = () => budgets.objectChunks;
const HARVEST_REACH = 5.5;
const HARVEST_COOLDOWN = 0.42;

function chunkKey(cx: number, cy: number, cz: number) {
  return cx + ',' + cy + ',' + cz;
}

/** Damage multiplier by object material family and damage kind. */
function damageMultiplier(material: string, kind: DamageType | 'chop' | 'mine'): number {
  const wood = material === 'wood' || material === 'plant';
  const stone = material === 'stone' || material === 'metal';
  const crystal = material === 'crystal' || material === 'ice';
  switch (kind) {
    case 'chop': return wood ? 1 : crystal ? 0.25 : 0.1;
    case 'mine': return stone || crystal ? 1 : wood ? 0.35 : 0.5;
    case 'slash': return wood ? 0.45 : 0.08;
    case 'pierce': return wood ? 0.15 : 0.04;
    case 'blunt': return stone ? 0.45 : crystal ? 0.7 : 0.25;
    case 'fire': return wood ? 1.4 : 0.05;
    case 'force': return 1.1;
    case 'shock': return wood ? 0.6 : 0.2;
    case 'frost': return crystal ? 0.3 : 0.15;
    default: return 0.15;
  }
}

export class ObjectSystem implements ServerSystem, ObjectService {
  readonly name = 'objects';
  private ctx!: ServerContext;
  private cat!: FloraCatalog;
  private chunks = new Map<string, ChunkRecs>();
  private byId = new Map<number, ObjRec>();
  private states = new Map<number | string, StateRec>();
  private grid = new Map<string, Set<number | string>>();
  private known = new Map<EntityId, Map<number | string, number>>();
  private providers = new Map<string, ObjectProvider>();
  private cooldown = new Map<EntityId, number>();
  /** State changes batched per player, flushed once per tick. */
  private outbox = new Map<EntityId, Map<number | string, ObjectState>>();
  private prefetch: [number, number, number][] = [];
  private prefetchSet = new Set<string>();
  private useClock = 0;
  private version = 0;
  /** Diagnostics. */
  stats = { chunks: 0, objects: 0, states: 0, genMs: 0 };

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.cat = getFloraCatalog(ctx.gen.profile);
    ctx.bus.on('terrainEdited', ({ edit }) => this.onTerrainEdited(edit.x, edit.y, edit.z, edit.radius));
  }

  // ------------------------------------------------------------------ providers

  registerProvider(prefix: string, provider: ObjectProvider): void {
    this.providers.set(prefix, provider);
  }

  private providerOf(id: string): ObjectProvider | undefined {
    const i = id.indexOf(':');
    return i > 0 ? this.providers.get(id.slice(0, i)) : undefined;
  }

  // ------------------------------------------------------------------ scatter cache

  /** Object records of one LOD-0 chunk (computed on demand, LRU cached). */
  private chunkRecs(cx: number, cy: number, cz: number): ObjRec[] {
    const key = chunkKey(cx, cy, cz);
    const hit = this.chunks.get(key);
    if (hit) {
      hit.lastUsed = ++this.useClock;
      return hit.recs;
    }
    const t0 = performance.now();
    const gen = this.ctx.gen;
    const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    const recs: ObjRec[] = [];
    const chunk = gen.fillChunk(ox, oy, oz, 0);
    if (chunk.uniform === null) {
      const batches = scatterChunk(gen, chunk, cx, cy, cz, { objectsOnly: true });
      for (const b of batches) {
        if (!b.ids) continue;
        const k = parseKind(b.kind);
        const sp = this.cat.species[k.sp];
        if (!sp) continue;
        for (let i = 0; i < b.ids.length; i++) {
          const o = i * SCATTER_STRIDE;
          const scale = b.data[o + 4];
          const col = sp.col;
          const rec: ObjRec = {
            id: b.ids[i],
            sp,
            mat: k.mat,
            pos: [ox + b.data[o], oy + b.data[o + 1], oz + b.data[o + 2]],
            scale,
            maxHp: sp.harvest ? 1 : Math.max(1, Math.round(sp.hp * Math.pow(scale, 1.5))),
            h: col ? (col.shape === 'capsule' ? col.h * scale : col.h * scale * 2) : 0.5,
            r: col ? Math.max(0.3, col.r * scale) : 0.4,
          };
          recs.push(rec);
          this.byId.set(rec.id, rec);
        }
      }
    }
    this.chunks.set(key, { recs, lastUsed: ++this.useClock });
    this.stats.genMs = this.stats.genMs * 0.9 + (performance.now() - t0) * 0.1;
    if (this.chunks.size > maxChunks()) this.evict();
    this.stats.chunks = this.chunks.size;
    this.stats.objects = this.byId.size;
    return recs;
  }

  private evict() {
    const arr = [...this.chunks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = arr.length - Math.floor(maxChunks() * 0.8);
    for (let i = 0; i < drop; i++) {
      for (const r of arr[i][1].recs) this.byId.delete(r.id);
      this.chunks.delete(arr[i][0]);
    }
  }

  /** Chunks overlapping a sphere; `compute` false = only already cached chunks. */
  private recsAround(p: Vec3, r: number, compute: boolean, out: ObjRec[] = []): ObjRec[] {
    // Objects belong to the chunk containing their base; tall trees reach up to ~10 m above it.
    const C = CHUNK_SIZE;
    for (let cz = Math.floor((p[2] - r) / C); cz <= Math.floor((p[2] + r) / C); cz++)
      for (let cy = Math.floor((p[1] - r - 10) / C); cy <= Math.floor((p[1] + r) / C); cy++)
        for (let cx = Math.floor((p[0] - r) / C); cx <= Math.floor((p[0] + r) / C); cx++) {
          if (!compute) {
            const hit = this.chunks.get(chunkKey(cx, cy, cz));
            if (!hit) {
              this.queuePrefetch(cx, cy, cz);
              continue;
            }
            hit.lastUsed = ++this.useClock;
            for (const rec of hit.recs) out.push(rec);
          } else for (const rec of this.chunkRecs(cx, cy, cz)) out.push(rec);
        }
    return out;
  }

  private queuePrefetch(cx: number, cy: number, cz: number) {
    const k = chunkKey(cx, cy, cz);
    if (this.prefetchSet.has(k) || this.chunks.has(k)) return;
    this.prefetchSet.add(k);
    this.prefetch.push([cx, cy, cz]);
  }

  /** Distance from a point to an object's interaction capsule. */
  private distTo(rec: ObjRec, p: Vec3): number {
    const dx = p[0] - rec.pos[0], dz = p[2] - rec.pos[2];
    const dyRaw = p[1] - rec.pos[1];
    const dy = dyRaw < 0 ? dyRaw : dyRaw > rec.h ? dyRaw - rec.h : 0;
    return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - rec.r);
  }

  private resolve(id: number, hint?: Vec3): ObjRec | undefined {
    let rec = this.byId.get(id);
    if (!rec && hint) {
      this.recsAround(hint, 3, true);
      rec = this.byId.get(id);
    }
    return rec;
  }

  // ------------------------------------------------------------------ state store

  private cellKey(p: Vec3) {
    return Math.floor(p[0] / STATE_CELL) + ',' + Math.floor(p[2] / STATE_CELL);
  }

  private setState(id: number | string, st: ObjectState, kind: string, pos: Vec3, regrowAt = 0) {
    const prev = this.states.get(id);
    const rec: StateRec = { st, kind, pos, regrowAt, version: ++this.version };
    this.states.set(id, rec);
    if (!prev) {
      const k = this.cellKey(pos);
      let s = this.grid.get(k);
      if (!s) this.grid.set(k, (s = new Set()));
      s.add(id);
    }
    this.stats.states = this.states.size;
    this.replicate(id, rec);
  }

  private clearState(id: number | string) {
    const prev = this.states.get(id);
    if (!prev) return;
    this.states.delete(id);
    this.grid.get(this.cellKey(prev.pos))?.delete(id);
    this.stats.states = this.states.size;
  }

  /** Send a state change to all players in range (and remember they know it). */
  private replicate(id: number | string, rec: StateRec) {
    for (const p of this.ctx.players()) {
      const dx = p.pos[0] - rec.pos[0], dz = p.pos[2] - rec.pos[2];
      if (dx * dx + dz * dz > SYNC_RADIUS * SYNC_RADIUS) continue;
      let q = this.outbox.get(p.id);
      if (!q) this.outbox.set(p.id, (q = new Map()));
      q.set(id, rec.st);
      this.knownOf(p.id).set(id, rec.version);
    }
  }

  private knownOf(pid: EntityId) {
    let k = this.known.get(pid);
    if (!k) this.known.set(pid, (k = new Map()));
    return k;
  }

  /** Send every state near a player that it hasn't seen in its current version. */
  private syncPlayer(p: ServerEntity) {
    const known = this.knownOf(p.id);
    const out: ObjectState[] = [];
    const R = Math.ceil(SYNC_RADIUS / STATE_CELL);
    const cx0 = Math.floor(p.pos[0] / STATE_CELL), cz0 = Math.floor(p.pos[2] / STATE_CELL);
    for (let cz = cz0 - R; cz <= cz0 + R; cz++)
      for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
        const s = this.grid.get(cx + ',' + cz);
        if (!s) continue;
        for (const id of s) {
          const rec = this.states.get(id);
          if (!rec || known.get(id) === rec.version) continue;
          known.set(id, rec.version);
          out.push(rec.st);
        }
      }
    if (out.length) this.ctx.send(p.id, { t: 'objects', states: out });
  }

  state(id: number | string): ObjectState | undefined {
    return this.states.get(id)?.st;
  }

  private alive(id: number | string): boolean {
    const s = this.states.get(id)?.st;
    if (!s) return true;
    if (s.state === 'damaged') return s.hp > 0;
    return false;
  }

  // ------------------------------------------------------------------ ObjectService

  near(pos: Vec3, r: number): { id: number | string; kind: string; pos: Vec3; radius: number; hp: number }[] {
    const out: { id: number | string; kind: string; pos: Vec3; radius: number; hp: number }[] = [];
    // Small queries (melee, harvesting) compute missing chunks; large ones (spells, senses) use the cache.
    const recs = this.recsAround(pos, r, r <= 12);
    for (const rec of recs) {
      if (this.distTo(rec, pos) > r) continue;
      if (!this.alive(rec.id)) continue;
      const st = this.states.get(rec.id)?.st;
      out.push({ id: rec.id, kind: rec.sp.kind, pos: rec.pos, radius: rec.r, hp: st ? st.hp : rec.maxHp });
    }
    for (const [prefix, prov] of this.providers) {
      void prefix;
      for (const o of prov.near(pos, r)) {
        if (!this.alive(o.id)) continue;
        const st = this.states.get(o.id)?.st;
        const info = st ? null : prov.info(o.id);
        out.push({ id: o.id, kind: o.kind, pos: o.pos, radius: o.radius, hp: st ? st.hp : info?.maxHp ?? 100 });
      }
    }
    return out;
  }

  damage(id: number | string, amount: number, kind: DamageType | 'chop' | 'mine', source?: ServerEntity, pos?: Vec3): number {
    if (amount <= 0) return this.states.get(id)?.st.hp ?? 0;
    if (typeof id === 'string') return this.damageProvided(id, amount, kind, source);
    const rec = this.resolve(id, pos ?? source?.pos);
    if (!rec || !this.alive(id)) return 0;
    const sp = rec.sp;
    const cur = this.states.get(id)?.st.hp ?? rec.maxHp;
    const dealt = sp.harvest ? (amount > 0 ? cur : 0) : amount * damageMultiplier(sp.material, kind);
    const hp = Math.max(0, cur - dealt);
    const dir = this.dirFrom(rec.pos, source?.pos, pos);
    this.ctx.bus.emit('objectDamaged', { id, source, amount: dealt, kind: sp.kind, pos: rec.pos });
    this.ctx.broadcast({ type: 'impact', pos: pos ?? [rec.pos[0], rec.pos[1] + 1, rec.pos[2]], normal: [-dir[0], 0, -dir[2]], material: sp.material, force: Math.min(1, dealt / 20) }, rec.pos, 60);
    if (hp <= 0) {
      // Fire / force destroy without a proper harvest: fewer yields.
      const proper = kind === 'chop' || kind === 'mine' || sp.harvest;
      this.destroy(rec, source, dir, proper ? 1 : 0.4);
      return 0;
    }
    this.setState(id, { id, hp, maxHp: rec.maxHp, state: 'damaged', dir, t: this.ctx.time.now }, sp.kind, rec.pos);
    return hp;
  }

  private damageProvided(id: string, amount: number, kind: DamageType | 'chop' | 'mine', source?: ServerEntity): number {
    const prov = this.providerOf(id);
    const info = prov?.info(id);
    if (!prov || !info || !this.alive(id)) return 0;
    const cur = this.states.get(id)?.st.hp ?? info.maxHp;
    const dealt = amount * damageMultiplier(info.material, kind);
    const hp = Math.max(0, cur - dealt);
    const dir = this.dirFrom(info.pos, source?.pos);
    this.ctx.bus.emit('objectDamaged', { id, source, amount: dealt, kind: info.kind, pos: info.pos });
    if (hp <= 0) {
      this.setState(id, { id, hp: 0, maxHp: info.maxHp, state: 'destroyed', dir, t: this.ctx.time.now }, info.kind, info.pos);
      prov.onDestroyed?.(id, source);
      this.ctx.bus.emit('objectDestroyed', { id, source, kind: info.kind, pos: info.pos });
      return 0;
    }
    this.setState(id, { id, hp, maxHp: info.maxHp, state: 'damaged', dir, t: this.ctx.time.now }, info.kind, info.pos);
    return hp;
  }

  private dirFrom(target: Vec3, from?: Vec3, hit?: Vec3): Vec3 {
    const o = from ?? hit;
    if (!o) return [1, 0, 0];
    let dx = target[0] - o[0], dz = target[2] - o[2];
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return [1, 0, 0];
    dx /= l;
    dz /= l;
    return [dx, 0, dz];
  }

  // ------------------------------------------------------------------ destruction & yields

  private destroy(rec: ObjRec, source: ServerEntity | undefined, dir: Vec3, yieldMul: number) {
    const sp = rec.sp;
    const now = this.ctx.time.now;
    const felled = sp.cls === 'tree' && sp.material === 'wood';
    const regrowAt = sp.regrow > 0 ? now + sp.regrow * (0.8 + hashToFloat(hash32(rec.id ^ 0x51ed27)) * 0.4) : 0;
    this.setState(rec.id, { id: rec.id, hp: 0, maxHp: rec.maxHp, state: felled ? 'felled' : 'destroyed', dir, t: now }, sp.kind, rec.pos, regrowAt);
    this.ctx.bus.emit('objectDestroyed', { id: rec.id, source, kind: sp.kind, pos: rec.pos });
    this.ctx.broadcast({ type: 'sound', sound: felled ? 'treefall' : sp.material === 'stone' ? 'rockbreak' : sp.material === 'crystal' ? 'crystal_break' : 'pick', pos: rec.pos, volume: 1 }, rec.pos, 120);
    if (felled) this.ctx.broadcast({ type: 'shake', pos: rec.pos, strength: Math.min(0.6, rec.scale * sp.size * 0.02) }, rec.pos, 40);
    if (yieldMul <= 0) return;
    const items = this.rollYields(rec, source, yieldMul);
    if (!items.length) return;
    const given: ItemInstance[] = [];
    const near = source && source.kind === 'player' && Math.hypot(source.pos[0] - rec.pos[0], source.pos[2] - rec.pos[2]) < 12;
    for (const it of items) {
      if (near && this.ctx.services.items.give(source!, it, 'harvest')) given.push(it);
      else {
        const a = hashToFloat(hash32(rec.id + given.length * 7919)) * Math.PI * 2;
        this.ctx.services.items.drop([rec.pos[0] + dir[0] * 1.2 + Math.cos(a) * 0.4, rec.pos[1] + 0.6, rec.pos[2] + dir[2] * 1.2 + Math.sin(a) * 0.4], it, [Math.cos(a) * 1.5, 2.5, Math.sin(a) * 1.5]);
        given.push(it);
      }
    }
    if (source) {
      this.ctx.bus.emit('harvest', { entity: source, kind: sp.kind, pos: rec.pos, items: given });
      // Skill XP proportional to the effort (object hp / size).
      const xp = sp.harvest ? 4 : Math.min(40, 6 + rec.maxHp * 0.08);
      if (source.skills) this.ctx.services.skills.grantXp(source, sp.skill, xp);
    }
  }

  private rollYields(rec: ObjRec, source: ServerEntity | undefined, mul: number): ItemInstance[] {
    const sp = rec.sp;
    // Deterministic per object & harvest count (regrown plants roll again differently).
    let h = hash32(rec.id ^ Math.floor(this.ctx.time.now));
    const rnd = () => {
      h = hash32(h + 0x6d2b79f5);
      return hashToFloat(h);
    };
    const lvl = source?.skills ? this.ctx.services.skills.level(source, sp.skill) : 0;
    const skillMul = 1 + Math.min(1, lvl * 0.02);
    const sizeMul = Math.max(0.5, Math.pow(rec.scale, 1.5));
    const list: Yield[] = [...sp.yields];
    if (sp.form === 'orerock') list.push({ item: oreFor(rec.id, rec.pos[1]), min: 2, max: 4, scaled: true });
    if (rec.mat >= 0 && sp.cls === 'rock' && sp.form !== 'crystal') list.push(...materialYields(rec.mat));
    const counts = new Map<string, number>();
    for (const y of list) {
      if (y.chance !== undefined && rnd() > Math.min(1, y.chance * skillMul)) continue;
      let n = y.min + Math.floor(rnd() * (y.max - y.min + 1));
      if (y.scaled) n = Math.round(n * sizeMul);
      n = Math.round(n * mul * (y.chance === undefined ? skillMul : 1));
      if (n <= 0) continue;
      counts.set(y.item, (counts.get(y.item) ?? 0) + n);
    }
    const out: ItemInstance[] = [];
    for (const [item, count] of counts) {
      try {
        out.push(this.ctx.services.items.create(item, { count, seed: rec.id }));
      } catch (err) {
        this.ctx.log('objects: cannot create item', item, err);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ messages

  onMessage(player: ServerEntity, msg: ClientMessage): boolean {
    if (msg.t === 'harvest') return this.handleHarvest(player, msg.object, msg.point), true;
    if (msg.t === 'interact' && msg.object !== undefined && typeof msg.object === 'number') {
      const rec = this.resolve(msg.object, msg.point ?? player.pos);
      if (!rec || !rec.sp.interact) return false;
      this.handleHarvest(player, msg.object, msg.point ?? rec.pos);
      return true;
    }
    return false;
  }

  /** Player intent: chop / mine / gather / pick the object. */
  private handleHarvest(player: ServerEntity, id: number | string, point: Vec3) {
    const now = this.ctx.time.now;
    if (!player.alive) return;
    if ((this.cooldown.get(player.id) ?? 0) > now) return;
    this.cooldown.set(player.id, now + HARVEST_COOLDOWN);
    const tool = this.toolOf(player);
    if (typeof id === 'string') {
      const info = this.providerOf(id)?.info(id);
      if (!info || Math.hypot(player.pos[0] - info.pos[0], player.pos[2] - info.pos[2]) > HARVEST_REACH + info.radius) return;
      this.damage(id, tool.power * 10, tool.kind === 'axe' ? 'chop' : tool.kind === 'pick' ? 'mine' : 'blunt', player, point);
      return;
    }
    const rec = this.resolve(id, point);
    if (!rec || !this.alive(id)) return;
    const eye: Vec3 = [player.pos[0], player.pos[1] + 1.4, player.pos[2]];
    if (this.distTo(rec, eye) > HARVEST_REACH && this.distTo(rec, player.pos) > HARVEST_REACH) return;
    const sp = rec.sp;
    let anim = 'harvest';
    if (sp.harvest) {
      // Sickles & knives improve gathering yields.
      const bonus = tool.kind === 'sickle' || tool.kind === 'knife' ? 1.35 : 1;
      this.destroy(rec, player, this.dirFrom(rec.pos, player.pos), bonus);
    } else {
      const lvl = player.skills ? this.ctx.services.skills.level(player, sp.skill) : 0;
      const skill = 1 + lvl * 0.04;
      let amount: number, kind: DamageType | 'chop' | 'mine';
      if (sp.interact === 'Chop') {
        anim = 'chop';
        if (tool.kind === 'axe') (amount = 12 * tool.power * skill), (kind = 'chop');
        else if (tool.weaponType === 'slash') (amount = Math.max(4, tool.weaponDamage * 0.5)), (kind = 'slash');
        else (amount = 3 * skill), (kind = 'chop');
      } else if (sp.interact === 'Mine') {
        anim = 'mine';
        if (tool.kind === 'pick') (amount = 12 * tool.power * skill), (kind = 'mine');
        else if (tool.kind === 'hammer') (amount = 8 * tool.power * skill), (kind = 'mine');
        else if (tool.weaponType === 'blunt') (amount = Math.max(3, tool.weaponDamage * 0.4)), (kind = 'blunt');
        else (amount = 1.5 * skill), (kind = 'mine');
      } else (amount = 6 * skill), (kind = 'slash');
      this.damage(id, amount, kind, player, point);
      // Small XP for every swing; the felling / breaking bonus comes from destroy().
      if (player.skills) this.ctx.services.skills.grantXp(player, sp.skill, 1);
      player.stamina = Math.max(0, player.stamina - 2.5);
      this.ctx.markPlayerDirty(player.id, 'vitals');
    }
    player.anim = { ...player.anim, action: { id: anim, t0: now, dur: anim === 'harvest' ? 0.7 : 0.85 } };
    player.dirty = true;
  }

  private toolOf(p: ServerEntity): { kind: string; power: number; weaponType: string; weaponDamage: number } {
    const it = p.equipment?.mainhand;
    if (!it) return { kind: '', power: 0, weaponType: '', weaponDamage: 2 };
    const def = this.ctx.services.items.def(it.defId);
    return {
      kind: def?.tool?.kind ?? '',
      power: (def?.tool?.power ?? 1) * (0.75 + it.quality * 0.5),
      weaponType: def?.weapon?.type ?? '',
      weaponDamage: def?.weapon?.damage ?? 2,
    };
  }

  // ------------------------------------------------------------------ terrain edits

  /** Ground dug away under objects: trees topple, everything else is lost. */
  private onTerrainEdited(x: number, y: number, z: number, radius: number) {
    const p: Vec3 = [x, y, z];
    const recs = this.recsAround(p, radius + 2, false);
    for (const rec of recs) {
      if (!this.alive(rec.id)) continue;
      const dx = rec.pos[0] - x, dy = rec.pos[1] - y, dz = rec.pos[2] - z;
      if (dx * dx + dy * dy + dz * dz > (radius + 1.2) * (radius + 1.2)) continue;
      const t = this.ctx.terrain;
      const hanging = rec.sp.orient === 2;
      const supported = hanging ? t.density(rec.pos[0], rec.pos[1] + 0.25, rec.pos[2]) > 0 : t.density(rec.pos[0], rec.pos[1] - 0.25, rec.pos[2]) > 0 || t.density(rec.pos[0], rec.pos[1] - 0.6, rec.pos[2]) > 0;
      if (supported) continue;
      this.destroy(rec, undefined, this.dirFrom(rec.pos, p), 0);
    }
  }

  // ------------------------------------------------------------------ ticking

  onPlayerJoin(player: ServerEntity) {
    this.known.set(player.id, new Map());
    this.syncPlayer(player);
  }

  onEntityRemoved(e: ServerEntity) {
    if (e.kind === 'player') {
      this.known.delete(e.id);
      this.cooldown.delete(e.id);
      this.outbox.delete(e.id);
    }
  }

  tick() {
    for (const [pid, q] of this.outbox) if (q.size) this.ctx.send(pid, { t: 'objects', states: [...q.values()] });
    this.outbox.clear();
    // Amortized prefetch: at most one chunk per tick, nearest players first.
    if (this.prefetch.length) {
      const [cx, cy, cz] = this.prefetch.shift()!;
      this.prefetchSet.delete(chunkKey(cx, cy, cz));
      this.chunkRecs(cx, cy, cz);
    }
  }

  slowTick() {
    const now = this.ctx.time.now;
    // Regrowth of harvested plants.
    for (const [id, rec] of this.states) {
      if (rec.regrowAt > 0 && now >= rec.regrowAt) {
        const st: ObjectState = { id, hp: rec.st.maxHp, maxHp: rec.st.maxHp, state: 'damaged', t: now };
        // Replicate the restore, then forget the state (intact objects carry no state).
        const restored: StateRec = { st, kind: rec.kind, pos: rec.pos, regrowAt: 0, version: ++this.version };
        this.replicate(id, restored);
        this.clearState(id);
        for (const k of this.known.values()) k.delete(id);
      }
    }
    for (const p of this.ctx.players()) {
      this.syncPlayer(p);
      // Prefetch the chunks around each player so harvesting never stalls a tick.
      const C = CHUNK_SIZE;
      const pcx = Math.floor(p.pos[0] / C), pcy = Math.floor(p.pos[1] / C), pcz = Math.floor(p.pos[2] / C);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 0; dy++) this.queuePrefetch(pcx + dx, pcy + dy, pcz + dz);
    }
    // Keep the queue bounded (players move on).
    if (this.prefetch.length > 64) {
      for (const [cx, cy, cz] of this.prefetch.splice(0, this.prefetch.length - 64)) this.prefetchSet.delete(chunkKey(cx, cy, cz));
    }
  }

  // ------------------------------------------------------------------ persistence

  save(): unknown {
    const states: [number | string, string, number, number, number, number, number, string, number, number, number, number][] = [];
    for (const [id, r] of this.states) {
      const d = r.st.dir ?? [0, 0, 0];
      states.push([id, r.kind, r.pos[0], r.pos[1], r.pos[2], r.st.hp, r.st.maxHp, r.st.state, r.st.t, r.regrowAt, d[0], d[2]]);
    }
    return { v: 1, states };
  }

  load(data: unknown): void {
    const d = data as { v?: number; states?: unknown[] } | null;
    if (!d || !Array.isArray(d.states)) return;
    this.states.clear();
    this.grid.clear();
    for (const row of d.states) {
      if (!Array.isArray(row) || row.length < 10) continue;
      const [id, kind, x, y, z, hp, maxHp, state, t, regrowAt, dx, dz] = row as [number | string, string, number, number, number, number, number, ObjectState['state'], number, number, number, number];
      const st: ObjectState = { id, hp, maxHp, state, t, dir: [dx ?? 1, 0, dz ?? 0] };
      const rec: StateRec = { st, kind, pos: [x, y, z], regrowAt, version: ++this.version };
      this.states.set(id, rec);
      const k = this.cellKey(rec.pos);
      let s = this.grid.get(k);
      if (!s) this.grid.set(k, (s = new Set()));
      s.add(id);
    }
    this.stats.states = this.states.size;
    for (const k of this.known.values()) k.clear();
  }
}
