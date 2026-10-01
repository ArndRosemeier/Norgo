/**
 * Terrain interaction: digging with tools (`dig` messages) and the terrain
 * shaping recipe steps (craters, walls, pillars, bores, bridges, ice floes).
 * Everything is built from small clamped sphere edits (MAX_EDIT_RADIUS), so
 * deformation stays "realistic": a pick chips a fist-sized dent, a fireball
 * scorches a shallow crater, a geomancer raises a man-high wall.
 * Digging yields the material's item (soil, sand, stone, clay, ores...).
 */
import type { ServerEntity } from '../../server/entity';
import type { ServerContext } from '../../server/context';
import type { ClientMessage } from '../../shared/protocol';
import type { Vec3 } from '../../shared/types';
import type { AbilityOp } from '../types';
import { Mat, matDef } from '../../world/materials';
import { SEA_LEVEL, UNDERWORLD_SEA_LEVEL, BEDROCK_Y } from '../../world/constants';
import { effectiveLevel } from '../shared/stats';
import type { GameplaySystem } from './GameplaySystem';
import type { CastCtx } from './abilities';
import { capsuleDist, eyeOf, hnorm, isVec3, vadd, vdist, vnorm, vsub, yawDir } from './util';

type TerrainOp = Extract<AbilityOp, { op: 'terrain' }>;

const ORES = new Set<number>([Mat.OreIron, Mat.OreGold, Mat.OreGem, Mat.Crystal]);

/**
 * Material of solid terrain at a point. The server has no voxel grids, so the
 * analytic generator does not know about spell-made fills (walls, pillars,
 * ice): those are resolved from the edit store, and points just above an
 * eroded surface fall back to the material a little deeper.
 */
export function solidMaterial(ctx: ServerContext, x: number, y: number, z: number): Mat {
  const m = ctx.terrain.material(x, y, z);
  if (m !== Mat.Air) return m;
  const edits = ctx.edits.query(x - 0.1, y - 0.1, z - 0.1, x + 0.1, y + 0.1, z + 0.1);
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (e.op === 'fill' && Math.hypot(x - e.x, y - e.y, z - e.z) <= e.radius * e.strength + 0.6) return e.mat ?? Mat.Dirt;
  }
  for (const dy of [0.5, 1.1, 2]) {
    const d = ctx.gen.materialAt(x, y - dy, z);
    if (d !== Mat.Air) return d;
  }
  return Mat.Dirt;
}

export class TerrainOps {
  constructor(private g: GameplaySystem) {}

  // ------------------------------------------------------------------ digging

  dig(p: ServerEntity, msg: Extract<ClientMessage, { t: 'dig' }>) {
    const g = this.g, ctx = g.ctx;
    if (!p.alive || !isVec3(msg.point)) return;
    const r = g.runtime(p);
    const now = ctx.time.now;
    if (now < r.nextDigAt - 0.03) return;
    const point = msg.point;
    const eye = eyeOf(p);
    if (vdist(eye, point) > 6.5) return;
    if (point[1] < BEDROCK_Y + 2) return this.tooHard(p, point, 'Bedrock. Nothing can dig deeper.');
    const n = vnorm(isVec3(msg.normal) ? msg.normal : [0, 1, 0], [0, 1, 0]);
    // Tool: an explicit uid (inventory/equipment) or the mainhand.
    const items = ctx.services.items;
    let tool = p.equipment?.mainhand;
    if (msg.tool) {
      tool = Object.values(p.equipment ?? {}).find((it) => it?.uid === msg.tool) ?? p.inventory?.items.find((it) => it.uid === msg.tool) ?? tool;
    }
    const tdef = tool ? items.def(tool.defId)?.tool : undefined;
    const kind = tdef?.kind;
    const power = tdef?.power ?? 0;
    const mat = solidMaterial(ctx, point[0] - n[0] * 0.3, point[1] - n[1] * 0.3, point[2] - n[2] * 0.3);
    const md = matDef(mat);
    if (md.hardness >= 100) return this.tooHard(p, point, 'Too hard to dig.');
    const soft = md.hardness <= 1.5;
    let eff: number;
    switch (kind) {
      case 'pick': eff = soft ? 0.7 : 1; break;
      case 'shovel': eff = soft ? 1.35 : 0.25; break;
      case 'hammer': eff = soft ? 0.4 : 0.7; break;
      case 'axe': eff = 0.3; break;
      default: eff = soft ? 0.45 : md.hardness <= 2.5 ? 0.12 : 0;
    }
    if (eff <= 0) return this.tooHard(p, point, `You need a pickaxe to break ${md.name}.`);
    const mining = effectiveLevel(p.skills, p.stats, 'mining');
    const radius = Math.min(1.1, Math.max(0.35, 0.4 + power * 0.1 + mining * 0.004)) * (kind === 'shovel' && soft ? 1.15 : 1);
    const strength = Math.min(1, Math.max(0.12, ((eff * 1.4) / Math.pow(md.hardness, 0.6)) * (1 + mining * 0.008)));
    const cost = 2.5;
    if (p.stamina < cost) {
      g.notify(p, 'Too exhausted to dig.', 'warn');
      return;
    }
    p.stamina -= cost;
    r.staminaUsedAt = now;
    r.nextDigAt = now + (0.55 / (1 + (p.stats?.attackSpeed ?? 0))) * (kind ? 1 : 1.35);
    const c: Vec3 = [point[0] - n[0] * radius * 0.35, point[1] - n[1] * radius * 0.35, point[2] - n[2] * radius * 0.35];
    ctx.editTerrain({ op: 'dig', x: c[0], y: c[1], z: c[2], radius, strength }, p);
    p.anim = { ...p.anim, action: { id: kind === 'pick' || !soft ? 'mine' : 'dig', t0: now, dur: 0.5, aim: vnorm(vsub(point, eye)) } };
    p.dirty = true;
    ctx.broadcast({ type: 'impact', pos: [point[0], point[1], point[2]], normal: n, material: md.name, force: 0.4 + strength * 0.6 }, point);
    this.yieldMaterial(p, mat, (4 / 3) * Math.PI * Math.pow(radius * strength, 3), 1, point);
    g.grantXp(p, 'mining', 1 + md.hardness * 0.35 + (ORES.has(mat) ? 3 : 0));
    if (tool && tool.durability > 0) {
      tool.durability = Math.max(0, tool.durability - 0.15 * Math.max(1, md.hardness * 0.5));
      if (tool.durability === 0) g.notify(p, `Your ${tool.name} is worn out.`, 'bad');
    }
  }

  private tooHard(p: ServerEntity, point: Vec3, text: string) {
    const ctx = this.g.ctx;
    const n = ctx.terrain.normal(point[0], point[1], point[2]);
    ctx.broadcast({ type: 'impact', pos: [point[0], point[1], point[2]], normal: n, material: 'stone', force: 0.6 }, point);
    this.g.notify(p, text, 'warn');
  }

  /**
   * Give the material's yield for a dug volume (m³). Fractional amounts are
   * rolled so small chips still pay out on average.
   */
  yieldMaterial(p: ServerEntity, mat: number, volume: number, bonus: number, at: Vec3) {
    const g = this.g, ctx = g.ctx;
    const md = matDef(mat);
    if (!md.yields || !p.inventory) return;
    const mining = effectiveLevel(p.skills, p.stats, 'mining');
    let expected = volume * 3.2 * (1 + mining * 0.01) * bonus * (ORES.has(mat) ? 1.4 : 1);
    let count = Math.floor(expected);
    expected -= count;
    if (g.rng.float() < expected) count++;
    if (count <= 0) return;
    const items = ctx.services.items;
    try {
      const it = items.create(md.yields, { count });
      if (!items.give(p, it, 'harvest')) items.drop(at, it, [0, 1.5, 0]);
      ctx.bus.emit('harvest', { entity: p, kind: 'terrain:' + md.name, pos: [...at] as Vec3, items: [it] });
    } catch (err) {
      ctx.log('gameplay: no item for terrain yield', md.yields, err);
    }
  }

  // ------------------------------------------------------------------ shaping spells

  private edit(op: 'dig' | 'fill', c: Vec3, radius: number, strength: number, mat: number | undefined, source: ServerEntity, allowOverlap?: ServerEntity) {
    const ctx = this.g.ctx;
    if (c[1] < BEDROCK_Y + 3) return false;
    if (op === 'fill') {
      // Never entomb a living body inside new rock.
      for (const e of ctx.entities.near(c, radius + 3)) {
        if (e === allowOverlap || !e.alive || (e.kind !== 'player' && e.kind !== 'npc' && e.kind !== 'creature')) continue;
        if (capsuleDist(c, e) < radius * 0.85) return false;
      }
    }
    ctx.editTerrain({ op, x: c[0], y: c[1], z: c[2], radius, strength, mat: op === 'fill' ? ((mat ?? Mat.Stone) as Mat) : undefined }, source);
    return true;
  }

  private ground(x: number, y: number, z: number, fallback: number): number {
    const gy = this.g.ctx.groundAt(x, y + 3, z, 10);
    return Number.isNaN(gy) ? fallback : gy;
  }

  shape(cx: CastCtx, op: TerrainOp): boolean {
    const g = this.g, ctx = g.ctx;
    const caster = cx.caster;
    const r = op.radius;
    const base = g.ops.anchor(cx, op.at);
    switch (op.shape) {
      case 'crater': {
        const count = op.count ?? 1;
        for (let i = 0; i < count; i++) {
          let c = base;
          if (count > 1) {
            const a = g.rng.float() * Math.PI * 2, d = 1 + g.rng.float() * (op.spread ?? 3);
            const x = base[0] + Math.cos(a) * d, z = base[2] + Math.sin(a) * d;
            c = [x, this.ground(x, base[1], z, base[1]), z];
          }
          const hard = matDef(solidMaterial(ctx, c[0], c[1] - 0.4, c[2])).hardness;
          if (hard >= 100) continue;
          const s = (op.strength ?? 0.6) * Math.min(1, Math.max(0.35, 2 / hard));
          this.edit('dig', [c[0], c[1] - r * 0.35, c[2]], r, s, undefined, caster);
        }
        return true;
      }
      case 'wall': {
        const f = hnorm(vsub(cx.point, caster.pos), yawDir(caster.yaw));
        const dir: Vec3 = [-f[2], 0, f[0]];
        const len = op.length ?? 6, H = op.height ?? 2.5;
        const cols = Math.max(2, Math.round(len / (r * 1.25)));
        const rows = Math.max(1, Math.ceil(H / (r * 1.3)));
        for (let c = 0; c < cols; c++) {
          const off = -len / 2 + ((c + 0.5) * len) / cols;
          const x = base[0] + dir[0] * off, z = base[2] + dir[2] * off;
          const gy = this.ground(x, base[1], z, base[1]);
          for (let row = 0; row < rows; row++) this.edit('fill', [x, gy + r * 0.35 + row * r * 1.3, z], r, 1, op.mat, caster);
        }
        return true;
      }
      case 'pillar': {
        const gy = this.ground(base[0], base[1], base[2], base[1]);
        const H = op.height ?? 4;
        const rows = Math.max(1, Math.ceil(H / (r * 1.05)));
        const riding = Math.hypot(caster.pos[0] - base[0], caster.pos[2] - base[2]) < r + 0.6 && Math.abs(caster.pos[1] - gy) < 1.5;
        if (riding) g.ops.impulse(caster, [0, Math.sqrt(2 * Math.max(1, ctx.gravityAt(caster.pos)) * (H + 0.8)) + 1, 0]);
        for (let i = 0; i < rows; i++) this.edit('fill', [base[0], gy + r * 0.3 + i * r * 1.05, base[2]], r * (1 - i * 0.04), 1, op.mat, caster, riding ? caster : undefined);
        return true;
      }
      case 'spike':
      case 'mound': {
        const gy = this.ground(base[0], base[1], base[2], base[1]);
        if (op.shape === 'mound') return this.edit('fill', [base[0], gy - r * 0.45, base[2]], r, 1, op.mat, caster);
        const H = op.height ?? 2.5;
        for (let i = 0, y = gy; y < gy + H; i++) {
          const rr = r * Math.pow(0.68, i);
          this.edit('fill', [base[0], y + rr * 0.5, base[2]], Math.max(0.3, rr), 1, op.mat, caster);
          y += rr;
        }
        return true;
      }
      case 'bore': {
        const o = eyeOf(caster);
        const range = Math.max(cx.def.range, 3);
        const hit = ctx.terrain.raycast(o[0], o[1], o[2], cx.dir[0], cx.dir[1], cx.dir[2], range + 1);
        if (!hit) {
          g.notify(caster, 'Nothing to bore into.', 'warn');
          return false;
        }
        const len = op.length ?? 5;
        const step = r * 0.8;
        const steps = Math.max(1, Math.ceil(len / step));
        const yields = new Map<number, number>();
        for (let i = 0; i < steps; i++) {
          const c = vadd([hit.x, hit.y, hit.z], cx.dir, r * 0.3 + i * step);
          const m = solidMaterial(ctx, c[0], c[1], c[2]);
          const hard = matDef(m).hardness;
          if (hard >= 100 || c[1] < BEDROCK_Y + 3) break;
          if (ctx.terrain.density(c[0], c[1], c[2]) > -0.5) yields.set(m, (yields.get(m) ?? 0) + 1);
          this.edit('dig', c, r, Math.min(1, Math.max(0.45, 2.5 / hard)), undefined, caster);
        }
        ctx.broadcast({ type: 'fx', fx: 'bore', pos: [hit.x, hit.y, hit.z], dir: cx.dir, radius: len, color: cx.def.color }, caster.pos);
        if (op.yields) for (const [m, k] of yields) this.yieldMaterial(caster, m, k * 0.35, 1, [hit.x, hit.y, hit.z]);
        return true;
      }
      case 'bridge': {
        const f = hnorm(cx.dir, yawDir(caster.yaw));
        const len = op.length ?? 10;
        const step = r * 1.1;
        for (let i = 0; i * step < len; i++) {
          const c: Vec3 = [caster.pos[0] + f[0] * (0.8 + i * step), caster.pos[1] - r * 0.7, caster.pos[2] + f[2] * (0.8 + i * step)];
          if (ctx.terrain.density(c[0], c[1] + r * 0.5, c[2]) > 0) continue;
          this.edit('fill', c, r, 1, op.mat, caster);
        }
        ctx.broadcast({ type: 'fx', fx: 'earth_rise', pos: [...caster.pos] as Vec3, dir: f, radius: len, color: cx.def.color }, caster.pos);
        return true;
      }
      case 'floe': {
        const p = cx.point;
        const water = Math.abs(p[1] - SEA_LEVEL) < 4 ? SEA_LEVEL : Math.abs(p[1] - UNDERWORLD_SEA_LEVEL) < 4 ? UNDERWORLD_SEA_LEVEL : NaN;
        // Only freeze real water: the column must be open below the surface.
        if (Number.isNaN(water) || ctx.terrain.density(p[0], water - 0.6, p[2]) > 0) return true;
        const cy = water - r + 0.35;
        this.edit('fill', [p[0], cy, p[2]], r, 1, op.mat ?? Mat.Ice, caster);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + g.rng.float() * 0.5;
          const d = r * (1.1 + g.rng.float() * 0.4);
          this.edit('fill', [p[0] + Math.cos(a) * d, cy, p[2] + Math.sin(a) * d], r * 0.85, 1, op.mat ?? Mat.Ice, caster);
        }
        return true;
      }
    }
    return true;
  }
}
