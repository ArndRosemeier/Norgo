/**
 * Hand-written ability behaviours that do not reduce to generic recipe steps:
 * taming, sensing, lockpicking, pickpocketing, social checks, crafting
 * utilities, recall anchors, decoys, grappling, ricochets and more.
 * Each returns false when it could not do anything (the cast is refunded).
 */
import { makeEntity, type ServerEntity } from '../../server/entity';
import type { GameEvent } from '../../shared/protocol';
import type { DamageType, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { ItemInstance } from '../../items/types';
import type { AbilityOp } from '../types';
import { Mat, matDef } from '../../world/materials';
import { hashString, hash32, hashCombine } from '../../core/rng';
import { effectiveLevel } from '../shared/stats';
import { skillCheck, skillCheckChance, hasEffect } from '../shared/checks';
import type { GameplaySystem } from './GameplaySystem';
import { solidMaterial } from './terrainOps';
import type { CastCtx } from './abilities';
import { capsuleDist, chestOf, eyeOf, hnorm, isCombatant, masterOf, setMaster, vcopy, vdist, vlen, vnorm, vsub, yawDir } from './util';

type SpecialOp = Extract<AbilityOp, { op: 'special' }>;

const PLANT_RE = /herb|bush|berry|berries|mushroom|flower|plant|fern|shrub|fung|reed|vine|moss/;
const FOOD_RE = /bread|meat|fish|berr|apple|stew|cheese|food|jerky|pie|soup|fruit|egg|honey|carrot|potato|mushroom/;
const RUNE_NAMES: Partial<Record<DamageType, string>> = { fire: 'Ember-runed', frost: 'Rime-runed', radiant: 'Sun-runed', shadow: 'Night-runed', shock: 'Storm-runed' };
const RUNE_GLOW: Partial<Record<DamageType, [number, number, number]>> = {
  fire: [1, 0.45, 0.1], frost: [0.5, 0.85, 1], radiant: [1, 0.9, 0.5], shadow: [0.55, 0.3, 0.9], shock: [0.6, 0.75, 1],
};
const ORE_COLORS: Record<number, [number, number, number]> = {
  [Mat.OreIron]: [0.85, 0.45, 0.25], [Mat.OreGold]: [1, 0.8, 0.25], [Mat.OreGem]: [0.3, 1, 0.8], [Mat.Crystal]: [0.7, 0.45, 1],
};
const TRANSMUTE: [string, string, number][] = [
  ['iron_ore', 'gold_ore', 3], ['clay', 'crystal_shard', 4], ['stone', 'salt', 2], ['sand', 'salt', 3], ['soil', 'clay', 2],
];

/** Rough "level" of any entity (lore, calm/tame/intimidate difficulty). */
export function powerLevel(e: ServerEntity): number {
  let skills = 0;
  if (e.skills) for (const s of Object.values(e.skills.skills)) skills = Math.max(skills, s.level);
  return Math.round(e.maxHp / 8 + skills * 0.6 + (e.tags.has('boss') ? 25 : 0));
}

export class Specials {
  private anchors = new Map<string, Vec3>();
  private scavenged = new Set<string>();
  private picked = new Set<string>();
  private loreSeen = new Set<string>();

  constructor(private g: GameplaySystem) {}

  run(cx: CastCtx, op: SpecialOp): boolean {
    const fn = (this as unknown as Record<string, (cx: CastCtx, op: SpecialOp) => boolean>)['sp_' + op.fn];
    if (!fn) {
      this.g.ctx.log('gameplay: unknown special', op.fn);
      return true;
    }
    return fn.call(this, cx, op);
  }

  private day() {
    return this.g.ctx.time.day;
  }

  private ping(c: ServerEntity, events: GameEvent[]) {
    this.g.sendEvents(c, events);
  }

  private needTarget(cx: CastCtx, maxDist: number): ServerEntity | null {
    const t = cx.target;
    if (!t || t === cx.caster || !t.alive) {
      this.g.notify(cx.caster, 'No target.', 'warn');
      return null;
    }
    if (capsuleDist(eyeOf(cx.caster), t) > maxDist) {
      this.g.notify(cx.caster, 'Too far away.', 'warn');
      return null;
    }
    return t;
  }

  // ------------------------------------------------------------------ movement & combat

  private sp_grapple(cx: CastCtx): boolean {
    const c = cx.caster;
    const d = vsub(cx.point, c.pos);
    const dist = vlen(d);
    if (dist < 2) return true;
    const dir = vnorm(d);
    const speed = Math.min(26, 6 + dist * 1.1);
    this.g.ops.impulse(c, [dir[0] * speed, dir[1] * speed + 3.5, dir[2] * speed]);
    this.g.effects.apply(c, 'featherfall', 1, 2.5, c);
    this.g.ctx.broadcast({ type: 'fx', fx: 'rope', pos: chestOf(c), dir: vnorm(vsub(cx.point, chestOf(c))), radius: dist, duration: 0.6 }, c.pos);
    return true;
  }

  /** Bounce to further enemies (ricochet). */
  private sp_chain(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g;
    const jumps = op.power ?? 3, radius = op.radius ?? 9;
    const visited = new Set<number>();
    if (cx.target) visited.add(cx.target.id);
    let from = cx.target ? chestOf(cx.target) : vcopy(cx.point);
    let dmg = (cx.def.damage?.amount ?? 10) * cx.power;
    const type = cx.def.damage?.type ?? 'slash';
    for (let k = 0; k < jumps; k++) {
      let best: ServerEntity | undefined, bd = Infinity;
      for (const e of g.ctx.entities.near(from, radius)) {
        if (visited.has(e.id) || !isCombatant(e) || !g.isHostile(cx.caster, e)) continue;
        const d = vdist(chestOf(e), from);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      if (!best) break;
      visited.add(best.id);
      dmg *= 0.8;
      const to = chestOf(best);
      g.ctx.broadcast({ type: 'fx', fx: 'chain', pos: from, dir: vnorm(vsub(to, from)), radius: bd, color: cx.def.color, target: best.id }, from);
      g.damage(best, dmg, type, cx.caster, { ability: cx.def.id, ranged: true, pos: to });
      from = to;
    }
    return true;
  }

  private sp_throw(cx: CastCtx): boolean {
    const t = this.needTarget(cx, 2.8);
    if (!t) return false;
    const g = this.g, c = cx.caster;
    const back = yawDir(c.yaw);
    g.knockback(t, [-back[0] * 7, 6.5, -back[2] * 7]);
    g.damage(t, 8 * cx.power, 'blunt', c, { ability: cx.def.id, melee: true, noBlock: true });
    g.effects.apply(t, 'stun', 1, 1.2, c);
    return true;
  }

  private sp_tk_hurl(cx: CastCtx): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const f = hnorm(cx.dir, yawDir(c.yaw));
    const fx = c.pos[0] + f[0] * 2, fz = c.pos[2] + f[2] * 2;
    const gy = ctx.groundAt(fx, c.pos[1] + 2, fz, 6);
    if (Number.isNaN(gy)) {
      g.notify(c, 'There is no ground to tear a stone from.', 'warn');
      return false;
    }
    const m = solidMaterial(ctx, fx, gy - 0.3, fz);
    if (matDef(m).hardness >= 100) {
      g.notify(c, 'The ground will not yield.', 'warn');
      return false;
    }
    ctx.editTerrain({ op: 'dig', x: fx, y: gy - 0.25, z: fz, radius: 0.8, strength: 0.65 }, c);
    ctx.broadcast({ type: 'fx', fx: 'earth_rise', pos: [fx, gy, fz], radius: 1, color: cx.def.color }, c.pos);
    const origin: Vec3 = [fx, gy + 1.6, fz];
    const dir = vnorm(vsub(cx.point, origin), cx.dir);
    g.projectiles.spawn({ ...cx, origin, dir }, {
      op: 'projectile', fx: 'boulder', speed: 30, gravity: 0.45, radius: 0.45, damage: 24, type: 'blunt', knockback: 8,
      onHit: [{ op: 'area', radius: 2.2, damage: 8, type: 'blunt', who: 'hostile' }, { op: 'fx', fx: 'rock_burst', at: 'point', radius: 2 }],
    });
    return true;
  }

  private sp_decoy(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const e = makeEntity(ctx.newEntityId(), 'effect', vcopy(c.pos), 'gameplay', ctx.time.now);
    e.name = c.name;
    e.yaw = c.yaw;
    e.faction = c.faction;
    e.hp = e.maxHp = 25 + cx.level;
    e.radius = c.radius;
    e.height = c.height;
    e.projectile = { fx: 'zone:decoy', owner: c.id };
    e.fx = ['zone:decoy', 'r:0.50', 'len:0.0', 'dur:' + (op.duration ?? 8).toFixed(1)];
    e.anim = { move: 'idle' };
    e.tags.add('decoy').add('owner:' + c.id);
    ctx.spawn(e);
    g.zones.trackSummon(e, ctx.time.now + (op.duration ?? 8));
    for (const h of ctx.entities.near(c.pos, op.radius ?? 12)) {
      if (h === c || !isCombatant(h) || h.kind === 'player' || !g.isHostile(c, h)) continue;
      g.effects.apply(h, 'taunted', 1, 4, e);
      h.target = e.id;
      h.dirty = true;
    }
    return true;
  }

  // ------------------------------------------------------------------ beasts

  private sp_calm(cx: CastCtx): boolean {
    const t = this.needTarget(cx, cx.def.range + 2);
    if (!t) return false;
    const g = this.g, c = cx.caster;
    const chance = skillCheckChance(cx.level + 10, powerLevel(t) + (t.faction === 'hostile' ? 10 : 0));
    if (g.rng.float() < chance) {
      g.clearAggro(c, t);
      g.effects.apply(t, 'calmed', 1, 20 + cx.level * 0.5, c);
      if (t.target === c.id) t.target = undefined;
      g.ctx.broadcast({ type: 'fx', fx: 'calm', pos: chestOf(t), target: t.id, color: cx.def.color }, t.pos);
      g.notify(c, `The ${t.name || 'creature'} calms down.`, 'good');
      g.grantXp(c, 'animism', 4);
    } else g.notify(c, `The ${t.name || 'creature'} resists your calming.`, 'bad');
    return true;
  }

  private sp_tame(cx: CastCtx): boolean {
    const t = this.needTarget(cx, cx.def.range + 2);
    if (!t) return false;
    const g = this.g, ctx = g.ctx, c = cx.caster;
    if (masterOf(t) !== undefined) {
      g.notify(c, masterOf(t) === c.id ? 'Already bonded to you.' : 'It is bonded to someone else.', 'warn');
      return false;
    }
    const power = cx.level + (hasEffect(t, 'calmed') ? 15 : 0) + (hasEffect(t, 'charmed') ? 10 : 0) + (1 - t.hp / Math.max(1, t.maxHp)) * 30 - (t.tags.has('boss') ? 40 : 0);
    let ok = false;
    try {
      ok = ctx.services.creatures.tryTame(t, c, power);
    } catch (err) {
      ctx.log('gameplay: tryTame failed', err);
    }
    if (ok) {
      setMaster(t, c.id);
      t.flags |= EntFlag.Tamed;
      t.faction = c.faction;
      t.target = undefined;
      g.clearAggro(c, t);
      g.effects.apply(t, 'tamed_bond', 1, 1e7, c);
      ctx.broadcast({ type: 'fx', fx: 'tame', pos: chestOf(t), target: t.id, color: cx.def.color }, t.pos);
      g.notify(c, `The ${t.name || 'creature'} bonds with you.`, 'good');
      g.grantXp(c, 'animism', 25);
    } else {
      g.notify(c, `The ${t.name || 'creature'} refuses your bond.`, 'bad');
      g.grantXp(c, 'animism', 3);
      if (!hasEffect(t, 'calmed') && g.rng.float() < 0.5) g.addAggro(c, t, 20);
    }
    return true;
  }

  private sp_rally_pets(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster;
    const pets = g.ctx.entities.near(c.pos, op.radius ?? 40, (e) => e.alive && masterOf(e) === c.id && e.kind !== 'effect');
    if (!pets.length) {
      g.notify(c, 'You have no beasts nearby.', 'warn');
      return false;
    }
    let target = cx.target && cx.target !== c && !g.isAlly(c, cx.target) ? cx.target : undefined;
    target ??= g.abilities.pick(c, eyeOf(c), cx.dir, 40);
    for (const p of pets) {
      g.effects.apply(p, 'haste', 1, 10, c);
      g.effects.apply(p, 'berserk', 1, 10, c);
      if (target && target !== p) {
        p.target = target.id;
        g.addAggro(p, target, 30);
      }
      p.dirty = true;
    }
    return true;
  }

  private sp_sense_beasts(cx: CastCtx, op: SpecialOp): boolean {
    const c = cx.caster;
    const evs: GameEvent[] = [];
    for (const e of this.g.ctx.entities.near(c.pos, op.radius ?? 80)) {
      if (e.kind !== 'creature' || !e.alive) continue;
      evs.push({ type: 'fx', fx: 'reveal', pos: chestOf(e), target: e.id, duration: 10, color: [0.95, 0.75, 0.35] });
      if (evs.length >= 40) break;
    }
    this.ping(c, evs);
    this.g.notify(c, evs.length ? `You sense ${evs.length} creature${evs.length > 1 ? 's' : ''} nearby.` : 'No animals nearby.', 'info');
    return true;
  }

  // ------------------------------------------------------------------ runes

  private sp_inscribe(cx: CastCtx): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const w = c.equipment?.mainhand;
    if (!w) {
      g.notify(c, 'Hold the weapon you want to inscribe.', 'warn');
      return false;
    }
    const reagent = c.inventory?.items.find((it) => /crystal|gem/.test(it.defId));
    if (!reagent) {
      g.notify(c, 'You need a crystal shard or a raw gem.', 'warn');
      return false;
    }
    ctx.services.items.take(c, reagent.uid, 1);
    const schools: [string, DamageType][] = [['pyromancy', 'fire'], ['cryomancy', 'frost'], ['luminism', 'radiant'], ['umbramancy', 'shadow']];
    let type: DamageType = 'shock', best = 5;
    for (const [s, t] of schools) {
      const l = effectiveLevel(c.skills, c.stats, s);
      if (l > best) {
        best = l;
        type = t;
      }
    }
    // Replace an older rune.
    const old = w.affixes.findIndex((a) => a.id.startsWith('rune_'));
    if (old >= 0) {
      for (const [k, v] of Object.entries(w.affixes[old].mods)) w.mods[k] = (w.mods[k] ?? 0) - v;
      w.name = w.name.replace(/^\S+-runed /, '');
      w.affixes.splice(old, 1);
    }
    const mods: Record<string, number> = { ['damage.' + type]: Math.round((0.08 + cx.level * 0.003) * 100) / 100, 'skill.runecraft': 2 };
    w.affixes.push({ id: 'rune_' + type, name: RUNE_NAMES[type]!, prefix: true, mods });
    for (const [k, v] of Object.entries(mods)) w.mods[k] = (w.mods[k] ?? 0) + v;
    w.name = `${RUNE_NAMES[type]} ${w.name}`;
    w.visual = { ...w.visual, glow: Math.max(w.visual.glow, 0.35), glowColor: RUNE_GLOW[type]! };
    g.effects.recompute(c);
    c.dirty = true;
    ctx.markPlayerDirty(c.id, 'equipment', 'inventory');
    ctx.broadcast({ type: 'fx', fx: 'inscribe', pos: chestOf(c), target: c.id, color: RUNE_GLOW[type] }, c.pos);
    g.notify(c, `You carve a rune: ${w.name}.`, 'good');
    g.grantXp(c, 'runecraft', 20);
    g.grantXp(c, 'enchanting', 8);
    return true;
  }

  private anchorKey(c: ServerEntity) {
    return c.kind === 'player' ? 'p:' + c.name : 'e:' + c.id;
  }

  private sp_recall(cx: CastCtx): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const key = this.anchorKey(c);
    const a = this.anchors.get(key);
    if (!a) {
      this.anchors.set(key, vcopy(c.pos));
      ctx.broadcast({ type: 'fx', fx: 'glyph_burst', pos: vcopy(c.pos), radius: 1.5, color: cx.def.color }, c.pos);
      g.notify(c, 'You carve an anchor rune. Cast again to return here.', 'good');
      return true;
    }
    if (ctx.terrain.density(a[0], a[1] + 1, a[2]) > 0) {
      this.anchors.delete(key);
      g.notify(c, 'Your anchor rune was buried. It is lost.', 'bad');
      return true;
    }
    this.anchors.delete(key);
    ctx.broadcast({ type: 'fx', fx: 'blink_out', pos: vcopy(c.pos), color: cx.def.color, target: c.id }, c.pos);
    g.ops.setPos(c, [a[0], a[1] + 0.1, a[2]], 'recall');
    ctx.broadcast({ type: 'fx', fx: 'blink_in', pos: vcopy(a), color: cx.def.color, target: c.id }, a);
    return true;
  }

  // ------------------------------------------------------------------ stealth & thievery

  private sp_drop_aggro(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster;
    for (const r of g.rt.values()) r.aggro.delete(c.id);
    g.runtime(c).aggro.clear();
    for (const e of g.ctx.entities.near(c.pos, op.radius ?? 30)) {
      if (e.kind === 'player' || e.target !== c.id) continue;
      e.target = undefined;
      g.effects.apply(e, 'distracted', 1, 3, c);
      e.dirty = true;
    }
    return true;
  }

  private sp_distract(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster, p = cx.point;
    g.ctx.broadcast({ type: 'sound', sound: 'pebble', pos: vcopy(p), volume: 0.6 }, p);
    for (const e of g.ctx.entities.near(p, op.radius ?? 10)) {
      if (e === c || e.kind === 'player' || !isCombatant(e) || g.isAlly(c, e)) continue;
      g.effects.apply(e, 'distracted', 1, 5, c);
      e.anim = { ...e.anim, lookAt: vcopy(p) };
      e.dirty = true;
    }
    return true;
  }

  private sp_pick_lock(cx: CastCtx): boolean {
    const g = this.g, c = cx.caster;
    const lvl = effectiveLevel(c.skills, c.stats, 'lockpicking');
    g.effects.apply(c, 'lockpicking', lvl + 10, 20, c);
    g.notify(c, 'You ready your picks. Open a locked door or chest now.', 'info');
    return true;
  }

  private sp_pickpocket(cx: CastCtx): boolean {
    const t = this.needTarget(cx, 2.8);
    if (!t) return false;
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const behind = vsub(c.pos, t.pos);
    const f = yawDir(t.yaw);
    const fromBehind = (behind[0] * f[0] + behind[2] * f[2]) < 0;
    const diff = 15 + (t.stats?.perception ?? 10) * 0.6 + (t.target === c.id ? 30 : 0) - (fromBehind ? 15 : 0) - (hasEffect(t, 'distracted') ? 15 : 0) - (hasEffect(t, 'asleep') ? 40 : 0);
    const lvl = effectiveLevel(c.skills, c.stats, 'lockpicking') + effectiveLevel(c.skills, c.stats, 'stealth') * 0.3;
    const roll = g.rng.float();
    if (roll < skillCheckChance(lvl, diff)) {
      const key = t.id + ':' + this.day();
      let got = '';
      const coins = t.inventory?.coins ?? 0;
      if (coins > 0) {
        const n = Math.min(coins, Math.ceil(coins * 0.1 + 3 + lvl * 0.2));
        t.inventory!.coins -= n;
        if (c.inventory) c.inventory.coins += n;
        got = `${n} coins`;
      } else {
        const loose = t.inventory?.items.filter((it) => !Object.values(t.equipment ?? {}).includes(it)) ?? [];
        if (loose.length) {
          const it = loose[g.rng.int(0, loose.length - 1)];
          const taken = ctx.services.items.take(t, it.uid, 1);
          if (taken) {
            ctx.services.items.give(c, taken, 'steal');
            got = taken.name;
          }
        } else if (!this.picked.has(key) && c.inventory) {
          // Townsfolk always carry a little pocket change (once per day).
          const n = 2 + (hash32(t.id * 977 + this.day()) % 12);
          c.inventory.coins += n;
          got = `${n} coins`;
        }
      }
      this.picked.add(key);
      ctx.markPlayerDirty(c.id, 'inventory');
      g.notify(c, got ? `You lift ${got}.` : 'Their pockets are empty.', got ? 'good' : 'info');
      g.grantXp(c, 'lockpicking', 8);
      g.grantXp(c, 'stealth', 3);
    } else {
      ctx.bus.emit('crime', { offender: c, victim: t, kind: 'theft', pos: vcopy(t.pos) });
      try {
        ctx.services.npcs.adjustDisposition(t.id, c.id, -25, 'caught pickpocketing');
      } catch (err) {
        ctx.log('gameplay: adjustDisposition failed', err);
      }
      t.speech = { text: 'Thief!', until: ctx.time.now + 3, style: 'shout' };
      t.dirty = true;
      g.notify(c, `${t.name || 'They'} caught you!`, 'bad');
      g.grantXp(c, 'lockpicking', 2);
    }
    return true;
  }

  // ------------------------------------------------------------------ senses

  private sp_detect_ores(cx: CastCtx, op: SpecialOp): boolean {
    const ctx = this.g.ctx, c = cx.caster;
    const R = op.radius ?? 16, step = 2.5;
    const cells = new Map<string, { pos: Vec3; mat: number; n: number }>();
    const cxp = c.pos[0], cyp = c.pos[1] + 1, czp = c.pos[2];
    for (let dz = -R; dz <= R; dz += step)
      for (let dy = -R; dy <= R; dy += step)
        for (let dx = -R; dx <= R; dx += step) {
          if (dx * dx + dy * dy + dz * dz > R * R) continue;
          const x = cxp + dx, y = cyp + dy, z = czp + dz;
          if (ctx.terrain.density(x, y, z) <= 0) continue;
          const m = solidMaterial(ctx, x, y, z);
          if (!(m in ORE_COLORS)) continue;
          const k = Math.floor(x / 4) + ',' + Math.floor(y / 4) + ',' + Math.floor(z / 4) + ':' + m;
          const cell = cells.get(k);
          if (cell) cell.n++;
          else cells.set(k, { pos: [x, y, z], mat: m, n: 1 });
        }
    const list = [...cells.values()].sort((a, b) => vdist(a.pos, c.pos) - vdist(b.pos, c.pos)).slice(0, 24);
    this.ping(c, list.map((o) => ({ type: 'fx', fx: 'ore_ping', pos: o.pos, color: ORE_COLORS[o.mat], radius: Math.min(2, 0.6 + o.n * 0.25), duration: 30 } as GameEvent)));
    const counts = new Map<string, number>();
    for (const o of list) counts.set(matDef(o.mat).name, (counts.get(matDef(o.mat).name) ?? 0) + 1);
    this.g.notify(c, list.length ? 'You sense ' + [...counts].map(([n, k]) => `${n} (${k})`).join(', ') + '.' : 'No ore veins within reach.', list.length ? 'good' : 'info');
    return true;
  }

  private sp_sense_plants(cx: CastCtx, op: SpecialOp): boolean {
    const c = cx.caster;
    const list = this.g.ctx.services.objects.near(c.pos, op.radius ?? 35).filter((o) => o.hp > 0 && PLANT_RE.test(o.kind)).slice(0, 30);
    this.ping(c, list.map((o) => ({ type: 'fx', fx: 'plant_ping', pos: o.pos, color: [0.45, 1, 0.4], duration: 25 } as GameEvent)));
    this.g.notify(c, list.length ? `You spot ${list.length} useful plant${list.length > 1 ? 's' : ''}.` : 'Nothing useful grows nearby.', 'info');
    return true;
  }

  private sp_track(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster;
    const evs: GameEvent[] = [];
    for (const e of g.ctx.entities.near(c.pos, op.radius ?? 90)) {
      if (e === c || !e.alive || (e.kind !== 'creature' && e.kind !== 'npc') || masterOf(e) === c.id) continue;
      const d = Math.hypot(e.vel[0], e.vel[2]) > 0.3 ? hnorm(e.vel) : yawDir(e.yaw);
      evs.push({ type: 'fx', fx: 'track', pos: vcopy(e.pos), dir: d, target: e.id, duration: 25, color: g.isHostile(c, e) ? [1, 0.35, 0.25] : [0.9, 0.8, 0.5] });
      if (evs.length >= 24) break;
    }
    this.ping(c, evs);
    g.notify(c, evs.length ? `You read ${evs.length} fresh trail${evs.length > 1 ? 's' : ''}.` : 'No fresh trails here.', 'info');
    return true;
  }

  private sp_sense_hostiles(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster;
    const evs: GameEvent[] = [];
    for (const e of g.ctx.entities.near(c.pos, op.radius ?? 60)) {
      if (!isCombatant(e) || !g.isHostile(c, e)) continue;
      evs.push({ type: 'fx', fx: 'reveal', pos: chestOf(e), target: e.id, duration: 10, color: [1, 0.25, 0.2] });
    }
    this.ping(c, evs);
    g.notify(c, evs.length ? `${evs.length} hostile presence${evs.length > 1 ? 's' : ''} nearby.` : 'Nothing hostile nearby.', evs.length ? 'warn' : 'info');
    return true;
  }

  private sp_arcane_sight(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster;
    const evs: GameEvent[] = [];
    for (const e of g.ctx.entities.near(c.pos, op.radius ?? 20)) {
      if (e === c || g.isAlly(c, e)) continue;
      const hidden = (e.flags & EntFlag.Invisible) !== 0;
      const magic = e.tags.has('decoy') || e.kind === 'effect';
      if (!hidden && !magic) continue;
      if (isCombatant(e)) g.effects.apply(e, 'exposed', 1, 10, c);
      evs.push({ type: 'fx', fx: 'reveal', pos: chestOf(e), target: e.id, duration: 10, color: [0.75, 0.55, 1] });
    }
    this.ping(c, evs);
    g.notify(c, evs.length ? `Arcane traces: ${evs.length}.` : 'You see no hidden magic.', 'info');
    return true;
  }

  // ------------------------------------------------------------------ gathering & crafting

  private sp_mine(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const o = eyeOf(c);
    const reach = 4.5;
    const obj = g.ops.objectAlongRay(cx, o, cx.dir, reach);
    const power = op.power ?? 1.5;
    if (obj) {
      ctx.services.objects.damage(obj.id, 60 * power * cx.power, 'mine', c, obj.pos);
      g.grantXp(c, 'mining', 4);
      return true;
    }
    const hit = ctx.terrain.raycast(o[0], o[1], o[2], cx.dir[0], cx.dir[1], cx.dir[2], reach);
    if (!hit) {
      g.notify(c, 'Nothing to mine within reach.', 'warn');
      return false;
    }
    const m = solidMaterial(ctx, hit.x - hit.nx * 0.3, hit.y - hit.ny * 0.3, hit.z - hit.nz * 0.3);
    const md = matDef(m);
    if (md.hardness >= 100) {
      g.notify(c, 'Too hard to mine.', 'warn');
      return false;
    }
    const hasPick = Object.values(c.equipment ?? {}).some((it) => it && ctx.services.items.def(it.defId)?.tool?.kind === 'pick');
    const eff = hasPick ? 1 : 0.35;
    const radius = Math.min(1.4, 0.55 + cx.level * 0.006);
    const strength = Math.min(1, Math.max(0.2, (eff * 1.8) / Math.pow(md.hardness, 0.5)));
    ctx.editTerrain({ op: 'dig', x: hit.x - hit.nx * radius * 0.3, y: hit.y - hit.ny * radius * 0.3, z: hit.z - hit.nz * radius * 0.3, radius, strength }, c);
    ctx.broadcast({ type: 'impact', pos: [hit.x, hit.y, hit.z], normal: [hit.nx, hit.ny, hit.nz], material: md.name, force: 1 }, c.pos);
    g.terrainOps.yieldMaterial(c, m, (4 / 3) * Math.PI * Math.pow(radius * strength, 3), power, [hit.x, hit.y, hit.z]);
    g.grantXp(c, 'mining', 2 + md.hardness * 0.5);
    return true;
  }

  private sp_scavenge(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const cell = op.radius ?? 12;
    const key = `${Math.round(c.pos[0] / cell)},${Math.round(c.pos[2] / cell)}:${this.day()}`;
    if (this.scavenged.has(key)) {
      g.notify(c, 'You already searched here today.', 'info');
      return false;
    }
    this.scavenged.add(key);
    const items = ctx.services.items;
    const seed = hashCombine(hashString(key), ctx.seed);
    let found: ItemInstance[] = [];
    try {
      found = items.rollLoot('forage', cx.level, seed);
    } catch {
      found = [];
    }
    if (!found.length) {
      const uw = ctx.gen.isUnderworld(c.pos[0], c.pos[1], c.pos[2]);
      const pool = uw ? ['mushroom', 'glowcap', 'crystal_shard', 'bone', 'flint'] : ['berries', 'mushroom', 'herb', 'stick', 'flint', 'feather', 'resin', 'acorn'];
      const known = pool.filter((id) => !!items.def(id));
      const use = known.length ? known : pool;
      const n = 1 + (hash32(seed) % 3);
      for (let i = 0; i < n; i++) {
        try {
          found.push(items.create(use[hash32(seed + i * 101) % use.length], { count: 1 + (hash32(seed ^ i) % 2) }));
        } catch {
          /* unknown item ids are skipped */
        }
      }
    }
    if (!found.length) {
      g.notify(c, 'Nothing useful here.', 'info');
      return true;
    }
    for (const it of found) if (!items.give(c, it, 'harvest')) items.drop(vcopy(c.pos), it, [0, 1, 0]);
    ctx.bus.emit('harvest', { entity: c, kind: 'scavenge', pos: vcopy(c.pos), items: found });
    g.notify(c, 'You find: ' + found.map((it) => (it.count > 1 ? `${it.count}× ` : '') + it.name).join(', ') + '.', 'good');
    g.grantXp(c, 'foraging', 5);
    return true;
  }

  private sp_grow(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster, p = cx.point;
    const md = matDef(solidMaterial(ctx, p[0], p[1] - 0.3, p[2]));
    if (!md.fertile) {
      g.notify(c, `Nothing will grow in ${md.name}.`, 'warn');
      return false;
    }
    const items = ctx.services.items;
    const pool = ['herb_healroot', 'herb_manabloom', 'herb_frostleaf', 'herb_emberroot', 'herb'];
    const known = pool.filter((id) => !!items.def(id));
    const use = known.length ? known : ['herb'];
    const n = 2 + (cx.level > 60 ? 2 : cx.level > 45 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = g.rng.float() * Math.PI * 2, r = g.rng.float() * (op.radius ?? 3);
      const x = p[0] + Math.cos(a) * r, z = p[2] + Math.sin(a) * r;
      const gy = ctx.groundAt(x, p[1] + 2, z, 5);
      try {
        items.drop([x, (Number.isNaN(gy) ? p[1] : gy) + 0.2, z], items.create(use[g.rng.int(0, use.length - 1)], { count: 1 }), [0, 2, 0]);
      } catch (err) {
        ctx.log('gameplay: grow could not create herb', err);
        return false;
      }
    }
    g.grantXp(c, 'herbalism', 3);
    return true;
  }

  private foodItems(c: ServerEntity): ItemInstance[] {
    const items = this.g.ctx.services.items;
    return (c.inventory?.items ?? []).filter((it) => {
      const d = items.def(it.defId);
      return d?.category === 'food' || d?.tags?.includes('food') || (!d && FOOD_RE.test(it.defId));
    });
  }

  private consumeFood(c: ServerEntity): ItemInstance | null {
    const food = this.foodItems(c).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    if (!food.length) {
      this.g.notify(c, 'You have nothing to eat.', 'warn');
      return null;
    }
    const it = food[0];
    const taken = this.g.ctx.services.items.take(c, it.uid, 1);
    if (taken) this.g.ctx.bus.emit('itemLost', { entity: c, item: taken, how: 'consume' });
    this.g.ctx.markPlayerDirty(c.id, 'inventory');
    return taken ?? it;
  }

  private sp_eat(cx: CastCtx): boolean {
    const g = this.g, c = cx.caster;
    const food = this.consumeFood(c);
    if (!food) return false;
    const cook = effectiveLevel(c.skills, c.stats, 'cooking');
    const heal = 12 + (food.value ?? 2) * 1.5 + cook * 0.4;
    g.heal(c, heal * 0.5, c);
    g.effects.apply(c, 'regen', heal / 16, 8, c);
    g.effects.apply(c, 'well_fed', 1 + cook * 0.01, 300 + cook * 3, c);
    for (const e of g.ctx.services.items.def(food.defId)?.consumable?.effects ?? []) g.effects.apply(c, e.id, e.magnitude, e.duration, c);
    g.notify(c, `You eat ${food.name}.`, 'good');
    g.grantXp(c, 'cooking', 4);
    return true;
  }

  private sp_feast(cx: CastCtx, op: SpecialOp): boolean {
    const g = this.g, c = cx.caster;
    const food = this.consumeFood(c);
    if (!food) return false;
    const cook = effectiveLevel(c.skills, c.stats, 'cooking');
    for (const e of g.ctx.entities.near(c.pos, op.radius ?? 6)) {
      if (!isCombatant(e) || !g.isAlly(c, e)) continue;
      g.heal(e, 20 + cook * 0.4, c);
      g.effects.apply(e, 'well_fed', 1.5 + cook * 0.01, 600, c);
    }
    g.ctx.broadcast({ type: 'fx', fx: 'feast', pos: vcopy(c.pos), radius: op.radius ?? 6 }, c.pos);
    g.grantXp(c, 'cooking', 10);
    return true;
  }

  private repair(cx: CastCtx, materials: RegExp, skill: string, verb: string): boolean {
    const g = this.g, c = cx.caster;
    const lvl = effectiveLevel(c.skills, c.stats, skill);
    let fixed = 0;
    for (const it of Object.values(c.equipment ?? {})) {
      if (!it || it.durability >= it.maxDurability || !materials.test(it.visual?.material ?? '')) continue;
      it.durability = Math.min(it.maxDurability, it.durability + it.maxDurability * (0.15 + lvl * 0.006));
      fixed++;
    }
    if (!fixed) {
      g.notify(c, 'Nothing needs ' + verb + '.', 'info');
      return false;
    }
    g.ctx.markPlayerDirty(c.id, 'equipment');
    g.notify(c, `You ${verb === 'repairing' ? 'repair' : 'mend'} ${fixed} item${fixed > 1 ? 's' : ''}.`, 'good');
    g.grantXp(c, skill, 4 + fixed * 2);
    return true;
  }

  private sp_repair(cx: CastCtx): boolean {
    return this.repair(cx, /metal|wood|bone|stone|crystal|chitin|glass/, 'smithing', 'repairing');
  }

  private sp_repair_cloth(cx: CastCtx): boolean {
    return this.repair(cx, /cloth|leather|silk|fur|wool/, 'tailoring', 'mending');
  }

  private sp_transmute(cx: CastCtx): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const items = ctx.services.items;
    for (const [from, to, n] of TRANSMUTE) {
      const stack = c.inventory?.items.find((it) => it.defId === from && it.count >= n);
      if (!stack) continue;
      items.take(c, stack.uid, n);
      try {
        const out = items.create(to, { count: 1 });
        if (!items.give(c, out, 'craft')) items.drop(vcopy(c.pos), out, [0, 1, 0]);
        g.notify(c, `${n}× ${stack.name} becomes ${out.name}.`, 'good');
      } catch (err) {
        ctx.log('gameplay: transmute target missing', to, err);
      }
      ctx.broadcast({ type: 'fx', fx: 'transmute', pos: chestOf(c), target: c.id, color: cx.def.color }, c.pos);
      g.grantXp(c, 'alchemy', 12);
      return true;
    }
    g.notify(c, 'Transmutation needs: ' + TRANSMUTE.map(([f, t, n]) => `${n} ${f} → ${t}`).join(', ') + '.', 'warn');
    return false;
  }

  // ------------------------------------------------------------------ healing

  private sp_bandage(cx: CastCtx): boolean {
    const g = this.g, c = cx.caster;
    const bleeding = hasEffect(c, 'bleeding');
    if (!bleeding && c.hp >= c.maxHp - 0.5) {
      g.notify(c, 'You are not wounded.', 'info');
      return false;
    }
    g.effects.remove(c, 'bleeding');
    g.heal(c, 5 * cx.power, c);
    g.effects.apply(c, 'regen', 3 * cx.power, 8, c);
    return true;
  }

  private sp_poultice(cx: CastCtx): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    if (c.hp >= c.maxHp - 0.5 && !hasEffect(c, 'poisoned') && !hasEffect(c, 'poison')) {
      g.notify(c, 'You are not wounded.', 'info');
      return false;
    }
    const items = ctx.services.items;
    const herb = c.inventory?.items.find((it) => it.defId.includes('herb') || items.def(it.defId)?.tags?.includes('herb'));
    if (herb) {
      items.take(c, herb.uid, 1);
      ctx.markPlayerDirty(c.id, 'inventory');
    }
    const k = herb ? 2 : 1;
    g.heal(c, 10 * cx.power * k, c);
    g.effects.apply(c, 'regen', 2 * cx.power * k, 10, c);
    if (herb) g.effects.cleanse(c, false, 1);
    return true;
  }

  // ------------------------------------------------------------------ social

  private talkCheck(cx: CastCtx, skill: string, difficulty: number, tag: string) {
    const c = cx.caster, t = cx.target!;
    const seed = hashCombine(hashCombine(t.id, c.id), hashString(tag + ':' + Math.floor(this.g.ctx.time.now / 60)));
    return skillCheck(c, skill, difficulty, seed);
  }

  private sp_persuade(cx: CastCtx): boolean {
    const t = this.needTarget(cx, 7);
    if (!t) return false;
    const g = this.g, ctx = g.ctx, c = cx.caster;
    let disp = 0;
    try {
      disp = ctx.services.npcs.disposition(t.id, c.id);
    } catch {
      disp = 0;
    }
    const r = this.talkCheck(cx, 'persuasion', 20 + Math.max(0, -disp) * 0.4, 'persuade');
    try {
      ctx.services.npcs.adjustDisposition(t.id, c.id, r.success ? 8 + Math.max(0, r.margin) * 0.2 : -2, r.success ? 'persuaded' : 'pestered');
    } catch (err) {
      ctx.log('gameplay: adjustDisposition failed', err);
    }
    ctx.bus.emit('dialogEvent', { player: c, npc: t, event: 'persuade', data: { success: r.success, chance: r.chance } });
    g.notify(c, r.success ? `${t.name || 'They'} warms to you.` : `${t.name || 'They'} is not convinced.`, r.success ? 'good' : 'bad');
    g.grantXp(c, 'persuasion', r.success ? 6 + Math.max(0, -r.margin) * 0.2 : 2);
    return true;
  }

  private sp_pacify(cx: CastCtx): boolean {
    const t = this.needTarget(cx, cx.def.range + 2);
    if (!t) return false;
    const g = this.g, c = cx.caster;
    const r = this.talkCheck(cx, 'persuasion', 25 + powerLevel(t) * 0.5, 'pacify');
    if (r.success) {
      g.clearAggro(c, t);
      g.effects.apply(t, 'calmed', 1, 30, c);
      if (t.target === c.id) t.target = undefined;
      t.speech = { text: 'Fine... fine.', until: g.ctx.time.now + 3, style: 'say' };
      t.dirty = true;
      g.notify(c, `${t.name || 'They'} lowers their guard.`, 'good');
      g.grantXp(c, 'persuasion', 8);
    } else {
      g.notify(c, `${t.name || 'They'} will not listen.`, 'bad');
      g.grantXp(c, 'persuasion', 2);
    }
    g.ctx.bus.emit('dialogEvent', { player: c, npc: t, event: 'pacify', data: { success: r.success } });
    return true;
  }

  private sp_intimidate(cx: CastCtx): boolean {
    const t = this.needTarget(cx, cx.def.range + 2);
    if (!t) return false;
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const diff = 15 + powerLevel(t) * 0.6 + (t.tags.has('guard') ? 15 : 0) - (c.maxHp - t.maxHp) * 0.05;
    const r = this.talkCheck(cx, 'intimidation', diff, 'intimidate');
    if (r.success) {
      g.effects.apply(t, 'feared', 1, t.kind === 'creature' ? 4 : 2, c);
      t.speech = t.kind === 'npc' ? { text: 'Alright, alright!', until: ctx.time.now + 3, style: 'say' } : t.speech;
      t.dirty = true;
      g.notify(c, `${t.name || 'It'} backs down.`, 'good');
    } else {
      g.notify(c, `${t.name || 'It'} is not impressed.`, 'bad');
      if (t.kind === 'creature' && g.rng.float() < 0.5) g.addAggro(c, t, 20);
    }
    if (t.kind === 'npc') {
      try {
        ctx.services.npcs.adjustDisposition(t.id, c.id, r.success ? -4 : -8, 'intimidated');
      } catch (err) {
        ctx.log('gameplay: adjustDisposition failed', err);
      }
      ctx.bus.emit('dialogEvent', { player: c, npc: t, event: 'intimidate', data: { success: r.success } });
    }
    g.grantXp(c, 'intimidation', r.success ? 6 : 2);
    return true;
  }

  private sp_appraise(cx: CastCtx): boolean {
    const g = this.g, ctx = g.ctx, c = cx.caster;
    const t = cx.target && cx.target !== c ? cx.target : g.abilities.pick(c, eyeOf(c), cx.dir, 10, cx.def, 0.15);
    if (!t) {
      g.notify(c, 'Nothing to appraise.', 'warn');
      return false;
    }
    const items = ctx.services.items;
    const lvl = effectiveLevel(c.skills, c.stats, 'barter');
    const err = Math.max(0.03, 0.35 - lvl * 0.0035);
    const fuzz = 1 + (g.rng.float() * 2 - 1) * err;
    let value = 0, what = '';
    if (t.item) {
      value = items.valueOf(t.item) * t.item.count;
      what = t.item.name;
    } else if (t.inventory || t.equipment) {
      for (const it of t.inventory?.items ?? []) value += items.valueOf(it) * it.count;
      for (const it of Object.values(t.equipment ?? {})) if (it) value += items.valueOf(it);
      value += t.inventory?.coins ?? 0;
      what = `${t.name || 'They'} carries goods`;
    }
    if (!what) g.notify(c, 'Nothing of value.', 'info');
    else g.notify(c, `${what} worth about ${Math.max(1, Math.round((value * fuzz) / 5) * 5)} coins.`, 'info');
    g.grantXp(c, 'barter', 2);
    return true;
  }

  private sp_lore(cx: CastCtx): boolean {
    const t = this.needTarget(cx, cx.def.range + 2);
    if (!t) return false;
    const g = this.g, c = cx.caster;
    const lvl = cx.level;
    const parts: string[] = [`${t.name || 'Unknown'}${t.title ? ` (${t.title})` : ''}: about level ${powerLevel(t)}, ${Math.round(t.hp)}/${Math.round(t.maxHp)} hp.`];
    const res = t.stats?.resist ?? {};
    if (lvl >= 10) {
      const strong = Object.entries(res).filter(([, v]) => (v ?? 0) >= 0.2).map(([k]) => k);
      const weak = Object.entries(res).filter(([, v]) => (v ?? 0) < 0).map(([k]) => k);
      if (strong.length) parts.push(`Resists ${strong.join(', ')}.`);
      if (weak.length) parts.push(`Vulnerable to ${weak.join(', ')}.`);
      if (!strong.length && !weak.length) parts.push('No notable resistances.');
    }
    if (lvl >= 25 && t.effects.length) parts.push('Affected by: ' + t.effects.map((e) => e.id.replace(/_/g, ' ')).join(', ') + '.');
    if (lvl >= 5) parts.push(g.isHostile(c, t) ? 'It is hostile to you.' : 'It is not hostile.');
    g.notify(c, parts.join(' '), 'info');
    const kindKey = c.id + ':' + (t.creature ? 'c' + t.creature.species : t.kind + ':' + t.faction);
    g.grantXp(c, 'lore', this.loreSeen.has(kindKey) ? 2 : 12);
    this.loreSeen.add(kindKey);
    return true;
  }

  // ------------------------------------------------------------------ housekeeping & persistence

  slowTick() {
    const day = this.day();
    if (this.scavenged.size > 2000) for (const k of this.scavenged) if (!k.endsWith(':' + day)) this.scavenged.delete(k);
    if (this.picked.size > 2000) for (const k of this.picked) if (!k.endsWith(':' + day)) this.picked.delete(k);
  }

  saveAnchors(): Record<string, Vec3> {
    return Object.fromEntries([...this.anchors].filter(([k]) => k.startsWith('p:')));
  }

  loadAnchors(a: Record<string, Vec3>) {
    for (const [k, v] of Object.entries(a)) if (Array.isArray(v) && v.length === 3) this.anchors.set(k, v);
  }

  saveScavenged(): string[] {
    const day = ':' + this.day();
    return [...this.scavenged].filter((k) => k.endsWith(day));
  }

  loadScavenged(list: string[]) {
    for (const k of list) this.scavenged.add(k);
  }

  /** Lockpicking power (0 if not prepared): used by tryPickLock in api.ts. */
  lockPower(e: ServerEntity): number {
    return this.g.effects.magnitude(e, 'lockpicking');
  }

  /** Has this entity carved a recall anchor (UI hint for the recall rune)? */
  hasAnchor(e: ServerEntity): boolean {
    return this.anchors.has(this.anchorKey(e));
  }
}

