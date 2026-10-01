/**
 * Status effects on the server: application rules (refresh/stack/max,
 * prevention, mutual removal), expiry, damage/heal/mana over time, toggle
 * upkeep, and the derived replicated state — stats, EntFlag bits, aura fx
 * tags ("a:<fx>"), effect light and the player's gravity multiplier.
 */
import type { ServerEntity } from '../../server/entity';
import { getPlayerData } from '../../server/systems/playerData';
import { EntFlag } from '../../shared/types';
import { EFFECTS, effectDef } from '../data/catalog';
import { canonicalEffect } from '../data/effects';
import { computeStats } from '../shared/stats';
import type { GameplaySystem } from './GameplaySystem';
import { raceBlend } from './progression';

/** Union of all flag bits effects may set. */
const EFFECT_FLAG_MASK = EFFECTS.reduce((m, e) => m | (e.flags ?? 0), 0);
const TICK = 0.5;

/** Light tint for effect-driven glow (halo, glowing). */
const GLOW_COLOR: [number, number, number] = [1, 0.9, 0.7];

export class EffectEngine {
  private warned = new Set<string>();

  constructor(private g: GameplaySystem) {}

  magnitude(e: ServerEntity, id: string): number {
    let m = 0;
    for (const x of e.effects) if (x.id === id) m += x.magnitude * (x.stacks ?? 1);
    return m;
  }

  apply(target: ServerEntity, id: string, magnitude: number, duration: number, source?: ServerEntity, ability?: string) {
    id = canonicalEffect(id);
    const def = effectDef(id);
    if (!def) {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        this.g.ctx.log('gameplay: unknown effect', id);
      }
      return;
    }
    if (!target.alive || !(duration > 0) || !Number.isFinite(magnitude)) return;
    if (def.preventedBy?.length && target.effects.some((x) => def.preventedBy!.includes(x.id))) {
      this.g.ctx.broadcast({ type: 'fx', fx: 'resist', pos: [target.pos[0], target.pos[1] + target.height, target.pos[2]], target: target.id }, target.pos);
      return;
    }
    // Bosses shrug off hard crowd control quickly.
    if (target.tags.has('boss') && (def.incapacitate || id === 'root' || id === 'feared')) duration *= 0.35;
    const now = this.g.ctx.time.now;
    if (def.removes) for (const r of def.removes) this.removeQuiet(target, r);
    const until = now + duration;
    const ex = target.effects.find((x) => x.id === id);
    if (ex) {
      if (def.stack === 'stack') {
        ex.stacks = Math.min(def.maxStacks ?? 5, (ex.stacks ?? 1) + 1);
        ex.magnitude = Math.max(ex.magnitude, magnitude);
        ex.until = Math.max(ex.until, until);
      } else {
        ex.magnitude = def.stack === 'max' ? Math.max(ex.magnitude, magnitude) : magnitude;
        ex.until = def.stack === 'max' ? Math.max(ex.until, until) : until;
      }
      if (source) ex.source = source.id;
      if (ability) ex.ability = ability;
    } else {
      target.effects.push({ id, source: source?.id, magnitude, until, fx: def.fx ? 'a:' + def.fx : undefined, stacks: 1, t0: now, ability });
    }
    if (def.incapacitate) {
      this.g.abilities.cancel(target);
      this.g.melee.setBlocking(target, false);
    }
    if (def.silence) this.g.abilities.cancel(target, true);
    this.changed(target);
  }

  remove(e: ServerEntity, id: string) {
    if (this.removeQuiet(e, id)) this.changed(e);
  }

  private removeQuiet(e: ServerEntity, id: string): boolean {
    const i = e.effects.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const ex = e.effects[i];
    e.effects.splice(i, 1);
    if (ex.ability) this.g.abilities.onToggleEffectGone(e, ex.ability);
    return true;
  }

  /** Remove up to `max` debuffs (or buffs). Returns how many were removed. */
  cleanse(e: ServerEntity, buffs = false, max = 99): number {
    let n = 0;
    for (let i = e.effects.length - 1; i >= 0 && n < max; i--) {
      const d = effectDef(e.effects[i].id);
      if (!d || d.kind !== (buffs ? 'buff' : 'debuff')) continue;
      if (e.effects[i].until === Infinity) continue;
      e.effects.splice(i, 1);
      n++;
    }
    if (n) this.changed(e);
    return n;
  }

  clearAll(e: ServerEntity) {
    if (!e.effects.length) return;
    for (const x of e.effects) if (x.ability) this.g.abilities.onToggleEffectGone(e, x.ability);
    e.effects.length = 0;
    this.changed(e);
  }

  onDamaged(e: ServerEntity, _amount: number) {
    let any = false;
    for (let i = e.effects.length - 1; i >= 0; i--) {
      if (effectDef(e.effects[i].id)?.breakOnDamage) {
        e.effects.splice(i, 1);
        any = true;
      }
    }
    if (any) this.changed(e);
  }

  /** Attacking or casting breaks invisibility. */
  onAction(e: ServerEntity) {
    let any = false;
    for (let i = e.effects.length - 1; i >= 0; i--) {
      const x = e.effects[i];
      if (effectDef(x.id)?.breakOnAction) {
        e.effects.splice(i, 1);
        if (x.ability) this.g.abilities.onToggleEffectGone(e, x.ability);
        any = true;
      }
    }
    if (any) this.changed(e);
  }

  /** Drop effects that cannot survive serialization (Infinity → null in JSON saves). */
  sanitize(e: ServerEntity) {
    e.effects = (e.effects ?? []).filter((x) => typeof x.until === 'number' && Number.isFinite(x.until) && !!effectDef(x.id));
  }

  /** Effects changed → recompute stats & replicate. */
  changed(e: ServerEntity) {
    this.recompute(e);
    if (e.kind === 'player') this.g.ctx.markPlayerDirty(e.id, 'effects');
  }

  tick(e: ServerEntity, dt: number) {
    const ctx = this.g.ctx;
    const now = ctx.time.now;
    let expired = false;
    for (let i = e.effects.length - 1; i >= 0; i--) {
      const x = e.effects[i];
      if (x.until <= now) {
        e.effects.splice(i, 1);
        if (x.ability) this.g.abilities.onToggleEffectGone(e, x.ability);
        expired = true;
      }
    }
    if (expired) this.changed(e);
    if (!e.effects.length) return;
    // Toggle upkeep (every tick, so resources drain smoothly).
    for (const x of e.effects) {
      if (!x.ability || x.until !== Infinity) continue;
      if (!this.g.abilities.payUpkeep(e, x.ability, dt)) {
        this.g.abilities.toggleOff(e, x.ability);
        this.g.notify(e, 'Not enough strength to keep it up.', 'warn');
        break;
      }
    }
    const r = this.g.runtime(e);
    r.effectAcc += dt;
    if (r.effectAcc < TICK) return;
    const step = r.effectAcc;
    r.effectAcc = 0;
    for (const x of [...e.effects]) {
      const d = effectDef(x.id);
      if (!d || !e.alive) continue;
      const amt = x.magnitude * (d.stack === 'stack' ? x.stacks ?? 1 : 1) * step;
      if (d.dot) this.g.damage(e, amt, d.dot, ctx.entities.get(x.source), { dot: true });
      if (d.hot) this.g.heal(e, amt, ctx.entities.get(x.source));
      if (d.mot && e.stats) e.mana = Math.min(e.stats.maxMana, e.mana + amt);
    }
  }

  /** Once per second for players: weather & water make you wet, fire dries you. */
  environment(p: ServerEntity) {
    const ctx = this.g.ctx;
    const w = ctx.weather;
    const swimming = (p.flags & EntFlag.Swimming) !== 0;
    const raining = (w.kind === 'rain' || w.kind === 'storm') && w.intensity > 0.3 && p.pos[1] > ctx.gen.heightAt(p.pos[0], p.pos[2]) - 2;
    if ((swimming || raining) && !p.effects.some((x) => x.id === 'burning' || x.id === 'flame_cloak')) this.apply(p, 'wet', 1, swimming ? 20 : 8);
  }

  /** Full stat recompute + derived replicated state. */
  recompute(e: ServerEntity) {
    const g = this.g, ctx = g.ctx;
    const r = g.runtime(e);
    if (e.kind !== 'player' && !r.base) r.base = { maxHp: e.maxHp };
    const prevMax = e.maxHp;
    const s = computeStats({
      skills: e.skills, equipment: e.equipment, effects: e.effects, raceMods: raceBlend(e, 'statMods'), base: r.base,
      itemDef: (id) => ctx.services.items.def(id),
    });
    e.stats = s;
    e.maxHp = s.maxHp;
    if (e.alive) {
      // Keep the wound fraction when max hp grows (level ups shouldn't feel like damage).
      if (prevMax > 0 && s.maxHp > prevMax && e.hp > 0) e.hp = Math.min(s.maxHp, e.hp + (s.maxHp - prevMax) * (e.hp / prevMax));
      e.hp = Math.min(e.hp, s.maxHp);
      e.stamina = Math.min(e.stamina, s.maxStamina);
      e.mana = Math.min(e.mana, s.maxMana);
    }

    // Flags owned by effects (never clear bits other systems set).
    let flags = 0;
    const tags: string[] = [];
    for (const x of e.effects) {
      const d = effectDef(x.id);
      if (!d) continue;
      flags |= d.flags ?? 0;
      if (x.fx && !tags.includes(x.fx)) tags.push(x.fx);
    }
    if (r.blockSince !== undefined) tags.push('a:block');
    flags &= EFFECT_FLAG_MASK;
    const before = e.flags;
    e.flags = (e.flags & ~(r.effFlags & ~flags)) | flags;
    r.effFlags = flags;
    tags.sort();
    const key = tags.join(',');
    if (key !== r.fxKey) {
      r.fxKey = key;
      const others = (e.fx ?? []).filter((t) => !t.startsWith('a:'));
      e.fx = others.concat(tags);
      e.dirty = true;
    }
    // Effect light (halo, glowing) unless another system already lights this entity.
    const lr = s.lightRadius ?? 0;
    if (lr > 0 && (!e.light || r.ownLight)) {
      e.light = { color: GLOW_COLOR, intensity: 1.5 + lr * 0.15, radius: lr };
      r.ownLight = true;
      e.dirty = true;
    } else if (lr <= 0 && r.ownLight) {
      delete e.light;
      r.ownLight = false;
      e.dirty = true;
    }
    if (before !== e.flags) e.dirty = true;

    if (e.kind === 'player') {
      const pd = getPlayerData(ctx, e.id);
      const gm = s.gravityMul ?? 1;
      if (pd && Math.abs(pd.gravityMul - gm) > 1e-4) {
        pd.gravityMul = gm;
        ctx.markPlayerDirty(e.id, 'gravity');
      }
      ctx.markPlayerDirty(e.id, 'stats', 'vitals');
    }
  }
}
