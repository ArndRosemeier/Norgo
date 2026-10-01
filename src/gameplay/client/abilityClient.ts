/**
 * Client-side ability helpers for the input core and the UI:
 *  - buildAbilityUse(): AbilityUse from an ability id + crosshair aim
 *    (drop-in compatible with src/client/abilityInput.ts's AimInfo, plus
 *    optional movement direction, focused object and charge),
 *  - AbilityInput: press/release handling (hold-to-charge, toggles) that
 *    returns the ClientMessages to send,
 *  - UI queries: targeting mode, range, radius, cooldown remaining/fraction,
 *    affordability, toggle state and tooltip text,
 *  - TargetPreview: a ground reticle / range ring while aiming.
 */
import * as THREE from 'three';
import type { ClientMessage, PlayerState } from '../../shared/protocol';
import type { EntityId, Vec3 } from '../../shared/types';
import type { AbilityDef, AbilityTargeting, AbilityUse, SkillsState, Stats } from '../types';
import { abilityDef, effectDef, skillDef } from '../data/catalog';
import { abilityPower, effectiveCooldown, effectiveCost } from '../shared/combat';
import { effectiveLevel, formatMod, modLabel } from '../shared/stats';
import type { DecalPool, Decal } from './pools';
import { DecalKind } from './pools';

/** Aim data from the camera/crosshair (same fields as the core's AimInfo, plus extras). */
export interface AimInfo {
  aimOrigin: Vec3;
  aimDir: Vec3;
  /** Terrain/collider point under the crosshair (or a far point). */
  aimPoint: Vec3;
  focusEntity?: EntityId;
  self: EntityId;
  /** Focused destructible object (tree, rock, door) id. */
  focusObject?: number | string;
  /** Horizontal movement input direction in world space (dodge rolls go this way). */
  moveDir?: Vec3;
  /**
   * `focusEntity` is the player's tab target rather than whatever the crosshair touches: the
   * request carries `lock` so the server aims at it (after validating range & line of sight).
   */
  lock?: boolean;
  /** Feet position of the locked target (ground-targeted abilities land there). */
  lockPoint?: Vec3;
}

export function abilityTargeting(id: string): AbilityTargeting | undefined {
  return abilityDef(id)?.targeting;
}

export function abilityRange(id: string): number {
  return abilityDef(id)?.range ?? 0;
}

/** Area radius for reticles (0 if not an area ability). */
export function abilityRadius(id: string): number {
  return abilityDef(id)?.radius ?? 0;
}

export function isChargeable(id: string): boolean {
  return !!abilityDef(id)?.chargeTime;
}

export function isToggleActive(state: Pick<PlayerState, 'skills'>, id: string): boolean {
  return !!state.skills?.toggles?.includes(id);
}

/** Build the request for an ability use from the crosshair aim. */
export function buildAbilityUse(ability: string, aim: AimInfo, charge?: number): AbilityUse {
  const def = abilityDef(ability);
  const use: AbilityUse = { ability, dir: aim.aimDir, point: aim.aimPoint };
  if (aim.focusObject !== undefined) use.object = aim.focusObject;
  if (charge !== undefined) use.charge = Math.max(0, Math.min(1, charge));
  switch (def?.targeting) {
    case 'self':
    case 'aura':
    case 'passive':
      use.target = aim.self;
      // Movement abilities (dodge roll...) travel along the movement input.
      if (def.tags.includes('movedir') && aim.moveDir && Math.hypot(aim.moveDir[0], aim.moveDir[2]) > 0.1) use.dir = aim.moveDir;
      break;
    case 'entity':
      use.target = aim.focusEntity;
      if (aim.lock && use.target !== undefined) use.lock = true;
      break;
    case 'ground': {
      if (aim.lock && aim.focusEntity !== undefined && aim.lockPoint) {
        use.target = aim.focusEntity;
        use.lock = true;
        use.point = [...aim.lockPoint] as Vec3;
      }
      // Clamp the reticle to the ability range along the aim ray.
      const o = aim.aimOrigin, p = use.point ?? aim.aimPoint;
      const d = Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
      if (def.range > 0 && d > def.range) {
        const k = def.range / d;
        use.point = [o[0] + (p[0] - o[0]) * k, o[1] + (p[1] - o[1]) * k, o[2] + (p[2] - o[2]) * k];
      }
      break;
    }
    default:
      if (aim.focusEntity !== undefined && aim.focusEntity !== aim.self) {
        use.target = aim.focusEntity;
        if (aim.lock) use.lock = true;
      }
  }
  return use;
}

/** Seconds until ready (server clock). */
export function cooldownRemaining(state: Pick<PlayerState, 'cooldowns'>, id: string, serverTime: number): number {
  return Math.max(0, (state.cooldowns?.[id] ?? 0) - serverTime);
}

/** 0..1 remaining fraction of the cooldown (for the hotbar sweep). */
export function cooldownFraction(state: Pick<PlayerState, 'cooldowns' | 'skills' | 'stats'>, id: string, serverTime: number): number {
  const def = abilityDef(id);
  const rem = cooldownRemaining(state, id, serverTime);
  if (!def || rem <= 0) return 0;
  const total = effectiveCooldown(def, effectiveLevel(state.skills, state.stats, def.skill));
  return Math.min(1, rem / Math.max(0.1, total));
}

export type UsableReason = 'ok' | 'locked' | 'passive' | 'cooldown' | 'stamina' | 'mana' | 'dead';

/** Can the local player use it right now (UI greying; the server has the final word)? */
export function canUse(state: PlayerState, id: string, serverTime: number): UsableReason {
  const def = abilityDef(id);
  if (!def || !state.skills?.abilities.includes(id)) return 'locked';
  if (def.targeting === 'passive') return 'passive';
  if (state.hp <= 0) return 'dead';
  if (isToggleActive(state, id)) return 'ok';
  if (cooldownRemaining(state, id, serverTime) > 0.05) return 'cooldown';
  const cost = effectiveCost(def, effectiveLevel(state.skills, state.stats, def.skill));
  if (state.stamina < cost.stamina) return 'stamina';
  if (state.mana < cost.mana) return 'mana';
  return 'ok';
}

/** Tooltip lines for an ability (name, costs, numbers at the player's level, unlock). */
export function describeAbility(def: AbilityDef, state?: { skills?: SkillsState; stats?: Stats }): string[] {
  const lvl = state ? effectiveLevel(state.skills, state.stats, def.skill) : 0;
  const lines = [`${def.icon} ${def.name}`, def.description];
  const sk = skillDef(def.skill);
  const tags = [def.kind === 'magic' ? 'Spell' : 'Technique', def.role, sk ? sk.name : def.skill];
  lines.push(tags.join(' · '));
  if (def.passive) {
    lines.push('Passive: ' + Object.entries(def.passive).map(([k, v]) => `${formatMod(k, v)} ${modLabel(k, (id) => skillDef(id)?.name)}`).join(', '));
  } else {
    const cost = effectiveCost(def, lvl);
    const parts: string[] = [];
    if (cost.mana) parts.push(`${Math.round(cost.mana)} mana`);
    if (cost.stamina) parts.push(`${Math.round(cost.stamina)} stamina`);
    if (def.upkeep) parts.push(`${def.upkeep.mana ?? def.upkeep.stamina}/s upkeep`);
    if (parts.length) lines.push('Cost: ' + parts.join(', '));
    const cd = effectiveCooldown(def, lvl);
    const meta: string[] = [];
    if (cd > 0.05) meta.push(`Cooldown ${cd.toFixed(1)}s`);
    if (def.castTime) meta.push(`Cast ${def.castTime.toFixed(1)}s`);
    if (def.chargeTime) meta.push(`Hold to charge (${def.chargeTime.toFixed(1)}s)`);
    if (def.range && def.targeting !== 'self' && def.targeting !== 'aura') meta.push(`Range ${def.range} m`);
    if (def.radius) meta.push(`Radius ${def.radius} m`);
    if (def.toggle) meta.push('Toggle');
    if (meta.length) lines.push(meta.join(' · '));
    if (def.damage) lines.push(`≈ ${Math.round(def.damage.amount * abilityPower(def, lvl))} ${def.damage.type} damage at your level`);
    const effs = new Set<string>();
    const scan = (ops: AbilityDef['ops']) => {
      for (const o of ops ?? []) {
        if (o.op === 'effect') effs.add(o.id);
        if ('effect' in o && o.effect) effs.add(o.effect.id);
        if (o.op === 'projectile' && o.onHit) scan(o.onHit);
        if ((o.op === 'zone' || o.op === 'delay') && o.ops) scan(o.ops);
      }
    };
    scan(def.ops);
    const names = [...effs].map((e) => effectDef(e)?.name ?? e);
    if (names.length) lines.push('Effects: ' + names.join(', '));
  }
  if (def.unlockLevel !== undefined) lines.push(`Unlocks at ${sk?.name ?? def.skill} ${def.unlockLevel}`);
  return lines;
}

/**
 * Press/release handling. Instant abilities fire on press; chargeable ones
 * fire on release with the measured charge (one message); channels end on
 * release. Returns the messages to send.
 */
export class AbilityInput {
  private holding: { id: string; t0: number } | null = null;

  press(id: string, aim: AimInfo, now: number): ClientMessage[] {
    const def = abilityDef(id);
    if (!def || def.targeting === 'passive') return [];
    if (def.chargeTime) {
      this.holding = { id, t0: now };
      return [];
    }
    return [{ t: 'ability', use: buildAbilityUse(id, aim) }];
  }

  release(id: string, aim: AimInfo, now: number): ClientMessage[] {
    const def = abilityDef(id);
    if (!def) return [];
    if (def.chargeTime && this.holding?.id === id) {
      const charge = Math.min(1, (now - this.holding.t0) / def.chargeTime);
      this.holding = null;
      return [{ t: 'ability', use: buildAbilityUse(id, aim, Math.max(0.15, charge)) }];
    }
    return def.channel ? [{ t: 'abilityRelease', ability: id }] : [];
  }

  /** Current charge for the UI (null when not charging). */
  charging(now: number): { id: string; charge: number } | null {
    if (!this.holding) return null;
    const def = abilityDef(this.holding.id);
    return { id: this.holding.id, charge: Math.min(1, (now - this.holding.t0) / (def?.chargeTime ?? 1)) };
  }

  cancel() {
    this.holding = null;
  }
}

/**
 * Aiming preview: a ground reticle at the (range-clamped) aim point for
 * ground-targeted abilities, and a ring around the player for auras.
 * Uses the FX decal pool (FxSystem.lib.decals).
 */
export class TargetPreview {
  private decal: Decal | null = null;
  private current = '';
  private tmp = new THREE.Vector3();

  constructor(private decals: DecalPool) {}

  /** Call every frame with the hovered/held ability (or null to hide). */
  update(id: string | null, aim: AimInfo | null, playerPos: Vec3 | null, groundY: (x: number, y: number, z: number) => number) {
    const def = id ? abilityDef(id) : undefined;
    const show = def && aim && (def.targeting === 'ground' || ((def.targeting === 'aura' || def.targeting === 'cone') && (def.radius || def.range)));
    if (!show || !def || !aim) {
      this.hide();
      return;
    }
    let x: number, y: number, z: number, r: number;
    if (def.targeting === 'ground') {
      const u = buildAbilityUse(def.id, aim);
      [x, y, z] = u.point!;
      const g = groundY(x, y + 1.5, z);
      if (Number.isFinite(g)) y = g;
      r = def.radius || 1.2;
    } else {
      if (!playerPos) return this.hide();
      [x, y, z] = playerPos;
      r = def.radius || def.range;
    }
    if (!this.decal || this.current !== def.id) {
      this.hide();
      this.decal = this.decals.spawn(this.tmp.set(x, y, z), r, DecalKind.Reticle, def.color ? [def.color[0] * 1.6, def.color[1] * 1.6, def.color[2] * 1.6] : [1.4, 1.4, 1.4], 1e9, { persistent: true, alpha: 0.85 });
      this.current = def.id;
    }
    this.decal.mesh.position.set(x, y + 0.06, z);
    this.decal.mesh.scale.setScalar(r);
  }

  hide() {
    if (this.decal) this.decals.release(this.decal);
    this.decal = null;
    this.current = '';
  }
}
