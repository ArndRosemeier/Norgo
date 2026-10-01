/**
 * Skills, abilities, stats and status effects (shared).
 * Advancement is use-based: performing actions grants skill XP; crossing
 * thresholds unlocks abilities.
 *
 * Abilities are *data*: besides UI metadata each ability carries an `ops`
 * recipe (strike, projectile, area, terrain, zone, gravity, teleport...) that
 * the server interprets (src/gameplay/server/ops.ts). This keeps 100+
 * abilities consistent and lets NPCs/creatures use exactly the same code path.
 */
import type { DamageType, EntityId, Vec3 } from '../shared/types';

export type SkillCategory = 'combat' | 'magic' | 'utility' | 'craft' | 'social' | 'survival';

export interface SkillDef {
  id: string;
  name: string;
  category: SkillCategory;
  /** Magic school id if this is a magic skill. */
  school?: string;
  description: string;
  /** Level thresholds (skill level) at which abilities unlock. */
  unlocks: { level: number; ability: string }[];
  icon: string;
  /** UI accent color (sRGB 0..1). */
  color?: [number, number, number];
  /** Short hint how this skill is trained (shown in the skills panel). */
  training?: string;
}

export interface SkillProgress {
  level: number;
  xp: number;
}

export interface SkillsState {
  skills: Record<string, SkillProgress>;
  /** Unlocked ability ids. */
  abilities: string[];
  /** Hotbar slots → ability ids (or item uid prefixed with "item:"). */
  hotbar: (string | null)[];
  /** Currently active toggle abilities (shadow cloak, levitate...). Server maintained. */
  toggles?: string[];
}

export type AbilityTargeting = 'self' | 'aim' | 'entity' | 'ground' | 'cone' | 'aura' | 'passive';

/** An effect application inside an ability recipe. */
export interface EffectApply {
  id: string;
  magnitude: number;
  duration: number;
  /** 0..1 chance (default 1). */
  chance?: number;
}

/** Where a recipe step is centred. */
export type OpAnchor = 'self' | 'point' | 'target';
/** Who an area step affects. */
export type OpWho = 'hostile' | 'ally' | 'all' | 'others';

/**
 * One step of an ability recipe (server-interpreted). Numbers are base values
 * at skill level 0; the server scales damage/heal/magnitude by caster power.
 */
export type AbilityOp =
  /** Weapon strike in an arc in front of the caster (uses the equipped weapon). */
  | { op: 'strike'; mult: number; arc?: number; reach?: number; maxHits?: number; knockback?: number; type?: DamageType; effect?: EffectApply; delay?: number; lunge?: number; bonusUnaware?: number }
  /** Spawn projectile(s) along the aim direction. */
  | {
      op: 'projectile'; fx: string; speed: number; gravity?: number; radius?: number; life?: number; count?: number; spread?: number;
      pierce?: number; homing?: number; damage?: number; type?: DamageType; useWeapon?: boolean; onHit?: AbilityOp[]; effect?: EffectApply;
      light?: [number, number, number]; knockback?: number; volley?: boolean; arc?: boolean;
    }
  /** Instant effect on everything in a sphere. */
  | {
      op: 'area'; radius: number; at?: OpAnchor; damage?: number; type?: DamageType; heal?: number; effect?: EffectApply; knockback?: number;
      lift?: number; who?: OpWho; fx?: string; objects?: { amount: number; kind: DamageType | 'chop' | 'mine' }; mana?: number; stamina?: number;
    }
  /** Instant effect in a cone in front of the caster. */
  | { op: 'cone'; range: number; angle: number; damage?: number; type?: DamageType; effect?: EffectApply; knockback?: number; fx?: string; who?: OpWho; objects?: { amount: number; kind: DamageType | 'chop' | 'mine' } }
  /** Instant ray hitting the first entity or terrain. */
  | { op: 'beam'; range: number; fx: string; damage?: number; type?: DamageType; effect?: EffectApply; heal?: number; pierce?: boolean; knockback?: number; objects?: { amount: number; kind: DamageType | 'chop' | 'mine' } }
  /** Apply a status effect to self or the target. */
  | { op: 'effect'; to: 'self' | 'target'; id: string; magnitude: number; duration: number; scale?: boolean }
  /** Heal (instant or over time via `regen`). */
  | { op: 'heal'; to: 'self' | 'target'; amount: number }
  /** Remove debuffs (or buffs with `buffs`). */
  | { op: 'cleanse'; to: 'self' | 'target' | 'area'; radius?: number; buffs?: boolean; max?: number }
  /** Deform terrain (realistic, small). Shapes compose several clamped sphere edits. */
  | { op: 'terrain'; shape: 'crater' | 'wall' | 'pillar' | 'bore' | 'bridge' | 'floe' | 'spike' | 'mound'; edit: 'dig' | 'fill'; radius: number; length?: number; height?: number; mat?: number; strength?: number; at?: OpAnchor; yields?: boolean; count?: number; spread?: number }
  /** Persistent area ("effect" entity) that ticks recipe steps at its centre or triggers once (traps). */
  | {
      op: 'zone'; kind: string; radius: number; duration: number; at?: OpAnchor; tick?: number; ops?: AbilityOp[]; trigger?: boolean; light?: [number, number, number];
      lightIntensity?: number; gravity?: number; follow?: boolean; length?: number; hidden?: boolean; max?: number;
    }
  /** Temporary gravity field (broadcast to clients and applied to server entities). */
  | { op: 'gravity'; radius: number; factor: number; duration: number; at?: OpAnchor }
  /** Reposition the caster. */
  | { op: 'teleport'; mode: 'blink' | 'behind' | 'swap' | 'recall'; range: number }
  /** Impulse on the caster (dodge, leap, charge). */
  | { op: 'dash'; speed: number; up?: number; dir?: 'aim' | 'back' | 'flat' | 'up'; hit?: { damage: number; type: DamageType; knockback: number; radius: number } }
  /** Push (positive) or pull (negative) entities and loose items. */
  | { op: 'push'; radius: number; force: number; at?: OpAnchor; up?: number; who?: OpWho; cone?: number }
  /** Broadcast a cosmetic fx event. */
  | { op: 'fx'; fx: string; at?: OpAnchor; radius?: number; color?: [number, number, number]; duration?: number }
  /** Summon a beast companion via the creature service. */
  | { op: 'summon'; role: string; duration: number; count?: number }
  /** Run nested steps after a delay (leap slam landing, meteor impact). */
  | { op: 'delay'; t: number; ops: AbilityOp[] }
  /** Hand-written behaviour (tame, detect ores, pick lock, persuade...). */
  | { op: 'special'; fn: string; power?: number; radius?: number; duration?: number };

export interface AbilityDef {
  id: string;
  name: string;
  skill: string;
  kind: 'physical' | 'magic';
  /** Is it primarily combat or utility. */
  role: 'combat' | 'utility' | 'movement' | 'defense' | 'social' | 'crafting';
  targeting: AbilityTargeting;
  range: number;
  cost: { stamina?: number; mana?: number; hp?: number };
  cooldown: number;
  castTime: number;
  /** Animation id for casters. */
  anim: string;
  description: string;
  icon: string;
  damage?: { amount: number; type: DamageType };
  /** Free-form tags for systems (e.g. "terrain", "gravity", "light", "summon", "heal", "teleport"). */
  tags: string[];
  /** Is it a toggled/channel ability. */
  channel?: boolean;
  toggle?: boolean;

  // ---- extensions (optional, interpreted by the gameplay module) ----
  /** Server recipe. */
  ops?: AbilityOp[];
  /** Stat mods granted permanently while unlocked (targeting 'passive'). */
  passive?: Record<string, number>;
  /** Per-second upkeep for toggles/channels. */
  upkeep?: { mana?: number; stamina?: number };
  /** Hold-to-charge time in seconds (client sends `charge` 0..1). */
  chargeTime?: number;
  /** Area radius (UI preview / ground reticle). */
  radius?: number;
  /** Requirements to use. */
  requires?: { weaponSkill?: string[]; shield?: boolean; tool?: string; grounded?: boolean; target?: 'creature' | 'npc' | 'any' | 'object' };
  /** Accent color for UI & fx (sRGB 0..1). */
  color?: [number, number, number];
  /** Skill level at which this unlocks (derived from SKILLS, filled at load). */
  unlockLevel?: number;
}

/** Derived/base stats of an entity. Additive stat mod keys: same names, plus "resist.<damage>", "skill.<id>". */
export interface Stats {
  maxHp: number;
  maxStamina: number;
  maxMana: number;
  hpRegen: number;
  staminaRegen: number;
  manaRegen: number;
  armor: number;
  moveSpeed: number;
  jump: number;
  carry: number;
  stealth: number;
  perception: number;
  resist: Partial<Record<DamageType, number>>;
  // ---- extensions (optional so older producers stay valid) ----
  /** Spell damage/heal multiplier bonus (0.1 = +10%). */
  spellPower?: number;
  /** 0..1 critical chance. */
  critChance?: number;
  /** Critical damage multiplier (default 1.6). */
  critMult?: number;
  /** Attack speed multiplier bonus (0.1 = +10%). */
  attackSpeed?: number;
  /** Cast speed multiplier bonus. */
  castSpeed?: number;
  /** Extra light radius (glow). */
  lightRadius?: number;
  /** Outgoing damage multiplier bonus per damage type ("damage.<type>" mods). */
  damage?: Partial<Record<DamageType, number>>;
  /** Bonus skill levels from gear/effects ("skill.<id>" mods). */
  skillBonus?: Record<string, number>;
  /** Chance 0..1 to evade an incoming melee/projectile hit. */
  dodge?: number;
  /** Damage fraction stopped when blocking (0..1). */
  block?: number;
  /** Trade price advantage (0.1 = 10% better prices). */
  barter?: number;
  /** Fall damage reduction 0..1. */
  fallResist?: number;
  /** Multiplier on gravity felt by this entity (effects). */
  gravityMul?: number;
  /**
   * Flat bonus damage per weapon hit from gear ("damage.<type>" item mods,
   * e.g. a Flaming sword adds +12 fire per hit). Physical types add to the
   * weapon's base damage, elemental types land as an extra hit.
   */
  flatDamage?: Partial<Record<DamageType, number>>;
  /** Skill XP gain bonus (0.05 = +5%). */
  xpGain?: number;
}

export interface ActiveEffect {
  id: string;
  /** Source entity. */
  source?: EntityId;
  magnitude: number;
  /** Server time when it expires (Infinity for permanent/toggles). */
  until: number;
  /** Visual tag for clients (aura color etc). */
  fx?: string;
  stacks?: number;
  /** Server time it was applied (UI duration bars). */
  t0?: number;
  /** Ability that created it (toggles). */
  ability?: string;
}

/** Client → server ability use request. */
export interface AbilityUse {
  ability: string;
  target?: EntityId;
  /** World-space aim point (from crosshair raycast). */
  point?: Vec3;
  /** Aim direction. */
  dir?: Vec3;
  /** Charge 0..1 for charged abilities. */
  charge?: number;
  /** Destructible world object id under the crosshair (chop, mine, ignite, pick lock). */
  object?: number | string;
  /**
   * `target` is the caster's tab target: aimed abilities (projectiles, cones, ground areas,
   * strikes) are pointed at it instead of the crosshair when the server finds it valid
   * (alive, within range, in line of sight). Without it the aim is the crosshair as usual.
   */
  lock?: boolean;
}

/** Status effect definition (data in src/gameplay/data/effects.ts). */
export interface EffectDef {
  id: string;
  name: string;
  description: string;
  kind: 'buff' | 'debuff' | 'neutral';
  icon: string;
  /** Stat mods per 1.0 magnitude (same keys as item mods). */
  mods?: Record<string, number>;
  /** Flat stat mods independent of magnitude. */
  flat?: Record<string, number>;
  /** Damage over time: `magnitude` damage per second of this type. */
  dot?: DamageType;
  /** Heal over time: `magnitude` hp per second. */
  hot?: boolean;
  /** Mana over time per second. */
  mot?: boolean;
  /** EntFlag bits set while active. */
  flags?: number;
  /** Aura fx tag replicated in EntitySnapshot.fx (prefixed "a:" by the server). */
  fx?: string;
  /** Movement-related (client player controller understands it). */
  movement?: boolean;
  stack?: 'refresh' | 'stack' | 'max';
  maxStacks?: number;
  /** Multiplier on felt gravity (per effect, not per magnitude). */
  gravityMul?: number;
  /** Cannot move/act (stun, sleep, frozen). */
  incapacitate?: boolean;
  /** Cannot cast spells. */
  silence?: boolean;
  /** Removed when taking damage. */
  breakOnDamage?: boolean;
  /** Removed when the bearer attacks or casts (invisibility). */
  breakOnAction?: boolean;
  /** Effect ids that this one removes when applied (frozen removes burning...). */
  removes?: string[];
  /** Effect ids that prevent this one (unstoppable prevents root...). */
  preventedBy?: string[];
}
