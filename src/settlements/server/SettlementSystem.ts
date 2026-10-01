/**
 * Server settlement system: owns the layout cache, answers settlement queries
 * (sites, buildings, interiors) for NPCs/GM/items, registers building and POI
 * pieces as destructible objects with the ObjectService, decides structural
 * collapses (pieces whose supports were destroyed fall a moment later, so
 * every client sees the same cascade), and handles door/seat interactions.
 */
import type { ServerContext, ServerSystem, SettlementService, ObjectProvider } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import type { Vec3 } from '../../shared/types';
import type { BuildingInfo, SettlementLayout } from '../types';
import { SettlementCache, worldFromGenerator, type Unit } from '../cache';
import { parsePieceId, unsupported } from '../pieces';
import { rotXZ } from '../build/kit';

interface Collapse {
  id: string;
  at: number;
}

export class SettlementSystem implements ServerSystem, SettlementService {
  readonly name = 'settlements';
  private ctx!: ServerContext;
  cache!: SettlementCache;
  /** Open doors (piece ids). */
  private open = new Set<string>();
  private queue: Collapse[] = [];

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.cache = new SettlementCache(worldFromGenerator(ctx.gen));
    this.cache.max = 64;
    const provider: ObjectProvider = {
      info: (id) => this.pieceInfo(id),
      near: (pos, r) => this.piecesNear(pos, r),
      onDestroyed: (id) => this.onDestroyed(id),
    };
    ctx.services.objects.registerProvider('B', provider);
    ctx.services.objects.registerProvider('P', provider);
  }

  // ---------------------------------------------------------------- SettlementService

  layout(siteId: string): SettlementLayout | null {
    return this.cache.layoutById(siteId);
  }

  siteAt(pos: Vec3) {
    return this.ctx.gen.siteAt(pos[0], pos[2]);
  }

  sitesNear(pos: Vec3, r: number) {
    return this.ctx.gen.sites.sitesNear(pos[0], pos[2], r).filter((s) => Math.hypot(s.x - pos[0], s.z - pos[2]) <= r + s.radius * 1.8);
  }

  buildingsNear(pos: Vec3, r: number): BuildingInfo[] {
    const out: BuildingInfo[] = [];
    for (const s of this.ctx.gen.sites.sitesNear(pos[0], pos[2], r)) {
      if (Math.hypot(s.x - pos[0], s.z - pos[2]) > r + s.radius * 2.5) continue;
      const l = this.cache.layout(s);
      if (Math.hypot(s.x - pos[0], s.z - pos[2]) > r + (l.extent ?? s.radius * 2)) continue;
      for (const b of l.buildings) {
        const br = Math.hypot(b.size[0], b.size[1]) / 2;
        if (Math.hypot(b.pos[0] - pos[0], b.pos[2] - pos[2]) <= r + br) out.push(b);
      }
    }
    for (const p of this.ctx.gen.sites.poisNear(pos[0], pos[2], r)) {
      const l = this.cache.poi(p);
      out.push(l.structure);
    }
    return out;
  }

  insideBuilding(pos: Vec3): BuildingInfo | null {
    for (const b of this.buildingsNear(pos, 4)) {
      if (b.role === 'wall' || b.role === 'bridge' || b.role === 'dock' || b.role === 'well') continue;
      const [lx, lz] = rotXZ(pos[0] - b.pos[0], pos[2] - b.pos[2], -b.yaw);
      const inside = b.round ? Math.hypot(lx, lz) < b.size[0] / 2 : Math.abs(lx) < b.size[0] / 2 && Math.abs(lz) < b.size[1] / 2;
      if (inside && pos[1] > b.pos[1] - 1.2 && pos[1] < b.pos[1] + b.size[2]) return b;
    }
    return null;
  }

  // ---------------------------------------------------------------- pieces

  private resolve(id: string): { unit: Unit; piece: number } | null {
    const ref = parsePieceId(id);
    if (!ref) return null;
    const unit = this.cache.unit(ref.building);
    if (!unit) return null;
    const bp = unit.blueprint();
    if (ref.piece < 0 || ref.piece >= bp.pieces.length) return null;
    return { unit, piece: ref.piece };
  }

  private worldOf(unit: Unit, x: number, y: number, z: number): Vec3 {
    const [ox, oz] = rotXZ(x, z, unit.yaw);
    return [unit.pos[0] + ox, unit.pos[1] + y, unit.pos[2] + oz];
  }

  private pieceInfo(id: string) {
    const r = this.resolve(id);
    if (!r) return null;
    const p = r.unit.blueprint().pieces[r.piece];
    return { kind: `building:${p.kind}`, pos: this.worldOf(r.unit, p.cx, p.cy, p.cz), radius: p.r, maxHp: p.hp, material: p.mat };
  }

  private piecesNear(pos: Vec3, r: number) {
    const out: { id: string; kind: string; pos: Vec3; radius: number }[] = [];
    const owners = new Set<string>();
    for (const s of this.ctx.gen.sites.sitesNear(pos[0], pos[2], r)) if (Math.hypot(s.x - pos[0], s.z - pos[2]) < r + s.radius * 2.6) owners.add(s.id);
    for (const p of this.ctx.gen.sites.poisNear(pos[0], pos[2], r)) owners.add(p.id);
    for (const o of owners) {
      const units = this.cache.unitsOf(o);
      if (!units) continue;
      for (const u of units.values()) {
        const ur = u.building ? Math.hypot(u.building.size[0], u.building.size[1], u.building.size[2]) / 2 + 2 : 40;
        if (Math.hypot(u.pos[0] - pos[0], u.pos[2] - pos[2]) > r + ur) continue;
        const bp = u.blueprint();
        bp.pieces.forEach((p, i) => {
          const wp = this.worldOf(u, p.cx, p.cy, p.cz);
          if (Math.hypot(wp[0] - pos[0], wp[1] - pos[1], wp[2] - pos[2]) <= r + p.r) out.push({ id: `${u.id}:${i}`, kind: `building:${p.kind}`, pos: wp, radius: p.r });
        });
      }
    }
    return out;
  }

  private destroyed(id: string) {
    return this.ctx.services.objects.state(id)?.state === 'destroyed';
  }

  /** A piece fell: schedule everything it was holding up (breadth-first cascade). */
  private onDestroyed(id: string) {
    this.open.delete(id);
    const r = this.resolve(id);
    if (!r) return;
    const bp = r.unit.blueprint();
    const fall = unsupported(bp, (i) => this.destroyed(`${r.unit.id}:${i}`), [r.piece]);
    const now = this.ctx.time.now;
    fall.forEach((i, k) => {
      const pid = `${r.unit.id}:${i}`;
      if (!this.queue.some((q) => q.id === pid)) this.queue.push({ id: pid, at: now + 0.25 + Math.min(2.5, k * 0.12) });
    });
  }

  tick() {
    if (!this.queue.length) return;
    const now = this.ctx.time.now;
    const due = this.queue.filter((q) => q.at <= now);
    if (!due.length) return;
    this.queue = this.queue.filter((q) => q.at > now);
    for (const q of due) if (!this.destroyed(q.id)) this.ctx.services.objects.damage(q.id, 1e6, 'force');
  }

  // ---------------------------------------------------------------- interaction

  onMessage(player: ServerEntity, msg: ClientMessage): boolean {
    if (msg.t !== 'interact' || typeof msg.object !== 'string') return false;
    if (!(msg.object.startsWith('B:') || msg.object.startsWith('P:'))) return false;
    const r = this.resolve(msg.object);
    if (!r || this.destroyed(msg.object)) return false;
    const p = r.unit.blueprint().pieces[r.piece];
    if (p.door) {
      const open = !this.open.has(msg.object);
      if (open) this.open.add(msg.object);
      else this.open.delete(msg.object);
      const hinge = this.worldOf(r.unit, p.door.x, 0, p.door.z);
      this.ctx.broadcast({ type: 'fx', fx: open ? 'door_open' : 'door_close', pos: hinge }, hinge, 120);
      this.ctx.broadcast({ type: 'sound', sound: open ? 'door_open' : 'door_close', pos: hinge, volume: 0.7 }, hinge, 40);
      return true;
    }
    if (p.seat) {
      const sp = this.worldOf(r.unit, p.seat.x, p.seat.y, p.seat.z);
      if (Math.hypot(sp[0] - player.pos[0], sp[2] - player.pos[2]) > 4) return true;
      player.yaw = p.seat.yaw + r.unit.yaw + Math.PI;
      player.anim = { ...player.anim, move: p.interact === 'Sleep' ? 'sleep' : 'sit' };
      player.dirty = true;
      this.ctx.send(player.id, { t: 'correct', pos: sp, vel: [0, 0, 0], reason: p.interact === 'Sleep' ? 'sleep' : 'sit' });
      return true;
    }
    return false;
  }

  onPlayerJoin(player: ServerEntity) {
    if (!this.open.size) return;
    const events = [];
    for (const id of this.open) {
      const r = this.resolve(id);
      const d = r?.unit.blueprint().pieces[r.piece].door;
      if (r && d) events.push({ type: 'fx' as const, fx: 'door_open', pos: this.worldOf(r.unit, d.x, 0, d.z) });
    }
    if (events.length) this.ctx.send(player.id, { t: 'events', events });
  }

  save() {
    return { open: [...this.open] };
  }

  load(data: unknown) {
    const d = data as { open?: string[] } | null;
    this.open = new Set(d?.open ?? []);
  }
}
