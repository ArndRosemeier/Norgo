/**
 * Ability catalog: physical & magical, combat and utility. Each active ability
 * carries a server recipe (`ops`, see AbilityOp in ../types.ts); passives carry
 * permanent stat mods. Numbers are base values at skill level 0 — the server
 * scales damage/heal/magnitude with skill level, spell power and charge.
 *
 * Conventions: ranges in meters, durations/cooldowns in seconds, `upkeep` per
 * second. `targeting` drives client aiming (see client/abilityClient.ts).
 */
import { Mat } from '../../world/materials';
import type { AbilityDef, AbilityOp, AbilityTargeting, EffectApply } from '../types';

type Opt = Partial<AbilityDef> & { description: string; icon: string };

const MAGIC_SKILLS = new Set(['pyromancy', 'cryomancy', 'geomancy', 'gravitas', 'vitae', 'luminism', 'umbramancy', 'kinesis', 'animism', 'runecraft', 'enchanting']);

function A(id: string, name: string, skill: string, targeting: AbilityTargeting, o: Opt): AbilityDef {
  return {
    id, name, skill, targeting,
    kind: MAGIC_SKILLS.has(skill) ? 'magic' : 'physical',
    role: 'combat', range: 0, cost: {}, cooldown: 1, castTime: 0,
    anim: MAGIC_SKILLS.has(skill) ? 'cast_forward' : 'swing_1h', tags: [],
    ...o,
  };
}

/** Passive: permanent stat mods while unlocked. */
function P(id: string, name: string, skill: string, icon: string, description: string, passive: Record<string, number>, role: AbilityDef['role'] = 'utility'): AbilityDef {
  return A(id, name, skill, 'passive', { icon, description, passive, role, anim: '', cooldown: 0, tags: ['passive'] });
}

const fx = (e: string, at: 'self' | 'point' | 'target' = 'point', radius?: number): AbilityOp => ({ op: 'fx', fx: e, at, radius });
const eff = (id: string, magnitude: number, duration: number, chance?: number): EffectApply => ({ id, magnitude, duration, chance });
const self = (id: string, magnitude: number, duration: number): AbilityOp => ({ op: 'effect', to: 'self', id, magnitude, duration });
const tgt = (id: string, magnitude: number, duration: number): AbilityOp => ({ op: 'effect', to: 'target', id, magnitude, duration });
const special = (fn: string, power = 1, radius?: number, duration?: number): AbilityOp => ({ op: 'special', fn, power, radius, duration });

const BOW = { weaponSkill: ['archery'] };
const SHIELD = { shield: true };

export const ABILITIES: AbilityDef[] = [
  // =================================================================== BLADES
  A('power_strike', 'Power Strike', 'blades', 'aim', {
    icon: '💥', description: 'A committed, two-handed swing that hits much harder and shoves the target back.',
    cost: { stamina: 18 }, cooldown: 4, anim: 'swing_2h', range: 3, ops: [{ op: 'strike', mult: 1.8, knockback: 4, delay: 0.3 }],
  }),
  A('lunge', 'Lunge', 'blades', 'aim', {
    icon: '➶', description: 'Close the distance in a heartbeat and run your blade through the foe.',
    cost: { stamina: 20 }, cooldown: 7, anim: 'stab', range: 7, role: 'combat', tags: ['movement'],
    ops: [{ op: 'dash', speed: 12, dir: 'flat' }, { op: 'strike', mult: 1.4, reach: 0.8, arc: 50, delay: 0.25, type: 'pierce' }],
  }),
  A('parry_riposte', 'Parry & Riposte', 'blades', 'self', {
    icon: '⚔', description: 'Raise a perfect guard for a moment. A parried attacker is staggered and your next strike deals triple damage.',
    cost: { stamina: 12 }, cooldown: 5, anim: 'block', role: 'defense', ops: [self('parry', 1, 0.7)],
  }),
  A('rending_cut', 'Rending Cut', 'blades', 'aim', {
    icon: '🩸', description: 'A dragging cut that leaves the target bleeding heavily.',
    cost: { stamina: 20 }, cooldown: 8, anim: 'swing_1h', range: 3, ops: [{ op: 'strike', mult: 1.2, effect: eff('bleeding', 4, 6), delay: 0.25 }],
  }),
  A('blade_flurry', 'Blade Flurry', 'blades', 'aim', {
    icon: '✶', description: 'Three lightning-fast slashes.',
    cost: { stamina: 30 }, cooldown: 10, anim: 'swing_1h', range: 3,
    ops: [{ op: 'strike', mult: 0.8, delay: 0.15 }, { op: 'strike', mult: 0.8, delay: 0.38 }, { op: 'strike', mult: 1.0, delay: 0.6, knockback: 3 }],
  }),
  A('whirlwind', 'Whirlwind', 'blades', 'aura', {
    icon: '🌪', description: 'Spin with blade extended, cutting everything around you.',
    cost: { stamina: 35 }, cooldown: 12, anim: 'swing_2h', range: 3, radius: 3,
    ops: [{ op: 'strike', mult: 1.3, arc: 360, maxHits: 8, knockback: 4, delay: 0.2 }, fx('whirl', 'self', 3)],
  }),

  // =================================================================== AXES
  A('cleave', 'Cleave', 'axes', 'aim', {
    icon: '🪓', description: 'A wide horizontal chop that hits up to four enemies.',
    cost: { stamina: 20 }, cooldown: 5, anim: 'swing_2h', range: 3, ops: [{ op: 'strike', mult: 1.4, arc: 150, maxHits: 4, delay: 0.3 }],
  }),
  A('hamstring', 'Hamstring', 'axes', 'aim', {
    icon: '🦵', description: 'Hack at the legs: the target is badly slowed.',
    cost: { stamina: 15 }, cooldown: 8, range: 3, ops: [{ op: 'strike', mult: 0.9, effect: eff('slow', 1.5, 6), delay: 0.25 }],
  }),
  A('sunder', 'Sunder', 'axes', 'aim', {
    icon: '⛓', description: 'Split armor and hide: the target takes more damage from everything.',
    cost: { stamina: 22 }, cooldown: 10, anim: 'swing_2h', range: 3, ops: [{ op: 'strike', mult: 1.3, effect: eff('vulnerable', 0.3, 8), delay: 0.3 }],
  }),
  A('axe_throw', 'Axe Throw', 'axes', 'aim', {
    icon: '↻', description: 'Hurl a spinning hatchet. It drops where it lands.',
    cost: { stamina: 20 }, cooldown: 8, anim: 'throw', range: 30,
    ops: [{ op: 'projectile', fx: 'axe', speed: 26, gravity: 1, radius: 0.2, useWeapon: true, damage: 1.3, knockback: 2 }],
  }),
  A('rampage', 'Rampage', 'axes', 'self', {
    icon: '☄', description: 'Let the fury take you: more damage and attack speed, less defense.',
    cost: { stamina: 25 }, cooldown: 40, anim: 'cheer', ops: [self('berserk', 1, 12), fx('roar', 'self')],
  }),

  // =================================================================== BLUNT
  A('crushing_blow', 'Crushing Blow', 'blunt', 'aim', {
    icon: '🔨', description: 'An overhead smash that staggers the target.',
    cost: { stamina: 20 }, cooldown: 6, anim: 'slam', range: 3, ops: [{ op: 'strike', mult: 1.6, knockback: 5, effect: eff('staggered', 1, 3), delay: 0.35, type: 'blunt' }],
  }),
  A('leap_slam', 'Leap Slam', 'blunt', 'aim', {
    icon: '⤓', description: 'Leap into the air and come down weapon-first, knocking everyone back.',
    cost: { stamina: 28 }, cooldown: 12, anim: 'slam', range: 10, radius: 3, tags: ['movement'],
    ops: [
      { op: 'dash', speed: 8, up: 7, dir: 'flat' },
      { op: 'delay', t: 0.7, ops: [{ op: 'area', radius: 3, at: 'self', damage: 16, type: 'blunt', knockback: 7, lift: 3, who: 'hostile' }, fx('slam', 'self', 3), { op: 'terrain', shape: 'crater', edit: 'dig', radius: 0.9, strength: 0.35, at: 'self' }] },
    ],
  }),
  A('ground_pound', 'Ground Pound', 'blunt', 'aura', {
    icon: '🌋', description: 'Strike the earth so hard it cracks, throwing nearby foes off their feet.',
    cost: { stamina: 30 }, cooldown: 14, anim: 'slam', radius: 4, tags: ['terrain'],
    ops: [
      { op: 'area', radius: 4, at: 'self', damage: 12, type: 'blunt', knockback: 6, lift: 3, effect: eff('staggered', 1, 2), who: 'hostile' },
      { op: 'terrain', shape: 'crater', edit: 'dig', radius: 1.2, strength: 0.4, at: 'self' }, fx('quake', 'self', 4),
    ],
  }),
  A('skull_crack', 'Skull Crack', 'blunt', 'aim', {
    icon: '💫', description: 'A precise blow to the head that stuns.',
    cost: { stamina: 25 }, cooldown: 14, anim: 'swing_1h', range: 3, ops: [{ op: 'strike', mult: 1.3, effect: eff('stun', 1, 2), delay: 0.3, type: 'blunt' }],
  }),
  A('earthshaker', 'Earthshaker', 'blunt', 'cone', {
    icon: '⚡', description: 'Send a fissure racing through the ground, hurling enemies into the air.',
    cost: { stamina: 40 }, cooldown: 20, anim: 'slam', range: 10, tags: ['terrain'],
    ops: [
      { op: 'cone', range: 10, angle: 40, damage: 26, type: 'blunt', knockback: 6, effect: eff('staggered', 1, 3), fx: 'fissure' },
      { op: 'push', radius: 10, cone: 40, force: 4, up: 7, at: 'self', who: 'hostile' },
    ],
  }),

  // =================================================================== POLEARMS
  A('thrust', 'Thrust', 'polearms', 'aim', {
    icon: '➹', description: 'A long, piercing thrust that outreaches any sword.',
    cost: { stamina: 14 }, cooldown: 3, anim: 'stab', range: 4, ops: [{ op: 'strike', mult: 1.5, reach: 1.2, arc: 30, type: 'pierce', delay: 0.22 }],
  }),
  A('sweep', 'Sweep', 'polearms', 'aim', {
    icon: '〰', description: 'Sweep the shaft through a wide arc, knocking enemies off balance.',
    cost: { stamina: 22 }, cooldown: 7, anim: 'swing_2h', range: 3, ops: [{ op: 'strike', mult: 1.0, arc: 200, maxHits: 6, knockback: 5, effect: eff('staggered', 1, 1.5), delay: 0.3 }],
  }),
  A('pole_vault', 'Pole Vault', 'polearms', 'aim', {
    icon: '⤴', description: 'Plant the shaft and vault high and far.',
    cost: { stamina: 18 }, cooldown: 6, anim: 'stab', role: 'movement', requires: { weaponSkill: ['polearms'] }, tags: ['movement'],
    ops: [{ op: 'dash', speed: 9, up: 9, dir: 'flat' }, self('featherfall', 1, 2.5)],
  }),
  A('impale', 'Impale', 'polearms', 'aim', {
    icon: '📌', description: 'Drive the point through the target, pinning it in place.',
    cost: { stamina: 28 }, cooldown: 12, anim: 'stab', range: 4,
    ops: [{ op: 'strike', mult: 2.0, reach: 1.5, arc: 25, type: 'pierce', effect: eff('root', 1, 2.5), delay: 0.3 }, tgt('bleeding', 3, 6)],
  }),
  A('pinwheel', 'Pinwheel', 'polearms', 'aura', {
    icon: '✺', description: 'Spin the polearm overhead and around, twice.',
    cost: { stamina: 35 }, cooldown: 14, anim: 'swing_2h', radius: 4,
    ops: [{ op: 'strike', mult: 1.1, arc: 360, maxHits: 10, knockback: 5, delay: 0.2 }, { op: 'strike', mult: 1.1, arc: 360, maxHits: 10, knockback: 6, delay: 0.6 }, fx('whirl', 'self', 4)],
  }),

  // =================================================================== ARCHERY
  A('aimed_shot', 'Aimed Shot', 'archery', 'aim', {
    icon: '🎯', description: 'Draw fully and loose a devastating arrow. Hold to charge.',
    cost: { stamina: 8 }, cooldown: 1.5, anim: 'shoot_bow', range: 120, chargeTime: 1.2, requires: BOW,
    ops: [{ op: 'projectile', fx: 'arrow', speed: 75, gravity: 0.6, radius: 0.05, useWeapon: true, damage: 2.0, knockback: 2 }],
  }),
  A('quick_shot', 'Quick Shot', 'archery', 'aim', {
    icon: '➵', description: 'Snap off two arrows in quick succession.',
    cost: { stamina: 10 }, cooldown: 4, anim: 'shoot_bow', range: 60, requires: BOW,
    ops: [{ op: 'projectile', fx: 'arrow', speed: 55, gravity: 1, radius: 0.05, useWeapon: true, damage: 0.8, count: 2, spread: 3 }],
  }),
  A('volley', 'Volley', 'archery', 'ground', {
    icon: '🌧', description: 'Loose arrows high into the sky to rain down on an area.',
    cost: { stamina: 25 }, cooldown: 14, anim: 'shoot_bow', range: 45, radius: 4, requires: BOW,
    ops: [{ op: 'projectile', fx: 'arrow', speed: 30, gravity: 1, radius: 0.05, useWeapon: true, damage: 0.7, count: 9, volley: true }],
  }),
  A('piercing_arrow', 'Piercing Arrow', 'archery', 'aim', {
    icon: '⇶', description: 'An arrow fired with such force it passes through several targets.',
    cost: { stamina: 18 }, cooldown: 8, anim: 'shoot_bow', range: 100, requires: BOW,
    ops: [{ op: 'projectile', fx: 'arrow_power', speed: 95, gravity: 0.4, radius: 0.06, useWeapon: true, damage: 1.6, pierce: 3, knockback: 3 }],
  }),
  A('grapple_shot', 'Grapple Shot', 'archery', 'aim', {
    icon: '🪝', description: 'Fire a rope arrow and reel yourself to where it sticks.',
    cost: { stamina: 15 }, cooldown: 10, anim: 'shoot_bow', range: 40, role: 'movement', requires: BOW, tags: ['movement'],
    ops: [{ op: 'projectile', fx: 'rope_arrow', speed: 70, gravity: 0.3, radius: 0.05, damage: 4, type: 'pierce', onHit: [special('grapple')] }],
  }),
  A('explosive_arrow', 'Explosive Arrow', 'archery', 'aim', {
    icon: '🧨', description: 'An arrow tipped with alchemical fire. Blows a small crater on impact.',
    cost: { stamina: 25 }, cooldown: 15, anim: 'shoot_bow', range: 80, radius: 3, requires: BOW, tags: ['terrain'],
    ops: [{
      op: 'projectile', fx: 'arrow_fire', speed: 60, gravity: 0.7, radius: 0.06, useWeapon: true, damage: 0.8, light: [1, 0.5, 0.2],
      onHit: [{ op: 'area', radius: 3, damage: 26, type: 'fire', knockback: 7, lift: 2, effect: eff('burning', 3, 4), objects: { amount: 40, kind: 'fire' } }, { op: 'terrain', shape: 'crater', edit: 'dig', radius: 1.1, strength: 0.6 }, fx('explosion_fire', 'point', 3)],
    }],
  }),

  // =================================================================== THROWING
  A('hurl', 'Hurl', 'throwing', 'aim', {
    icon: '🪨', description: 'Throw a stone (or your throwing weapon) hard and true.',
    cost: { stamina: 6 }, cooldown: 1.2, anim: 'throw', range: 35,
    ops: [{ op: 'projectile', fx: 'stone', speed: 26, gravity: 1, radius: 0.08, damage: 8, type: 'blunt', knockback: 1.5 }],
  }),
  A('fan_of_knives', 'Fan of Knives', 'throwing', 'aim', {
    icon: '🔪', description: 'Five knives fanned out in a deadly spread.',
    cost: { stamina: 18 }, cooldown: 8, anim: 'throw', range: 25,
    ops: [{ op: 'projectile', fx: 'knife', speed: 32, gravity: 0.8, radius: 0.05, damage: 7, type: 'pierce', count: 5, spread: 26, effect: eff('bleeding', 1, 4, 0.4) }],
  }),
  A('bolas', 'Bolas', 'throwing', 'aim', {
    icon: '⚭', description: 'Weighted cords that wrap around legs, rooting the target.',
    cost: { stamina: 14 }, cooldown: 10, anim: 'throw', range: 25,
    ops: [{ op: 'projectile', fx: 'bolas', speed: 22, gravity: 1, radius: 0.25, damage: 3, type: 'blunt', effect: eff('root', 1, 3) }],
  }),
  A('ricochet', 'Ricochet', 'throwing', 'aim', {
    icon: '⟳', description: 'A bladed disc that bounces between up to four enemies.',
    cost: { stamina: 18 }, cooldown: 9, anim: 'throw', range: 30,
    ops: [{ op: 'projectile', fx: 'disc', speed: 30, gravity: 0.2, radius: 0.15, damage: 12, type: 'slash', onHit: [special('chain', 3, 9)] }],
  }),
  A('smoke_bomb', 'Smoke Bomb', 'throwing', 'aim', {
    icon: '💨', description: 'A cloud of choking smoke: enemies inside are blinded, allies hidden.',
    cost: { stamina: 20 }, cooldown: 20, anim: 'throw', range: 20, radius: 4, role: 'utility',
    ops: [{
      op: 'projectile', fx: 'flask', speed: 18, gravity: 1, radius: 0.1, arc: true,
      onHit: [{ op: 'zone', kind: 'smoke', radius: 4, duration: 8, tick: 0.5, ops: [{ op: 'area', radius: 0, who: 'hostile', effect: eff('blinded', 1, 1.2) }, { op: 'area', radius: 0, who: 'ally', effect: eff('sneak_boost', 2, 1.2) }] }],
    }],
  }),

  // =================================================================== UNARMED
  A('flurry', 'Flurry of Blows', 'unarmed', 'aim', {
    icon: '👊', description: 'A rapid three-punch combination.',
    cost: { stamina: 12 }, cooldown: 3, anim: 'punch', range: 2,
    ops: [{ op: 'strike', mult: 0.6, delay: 0.1, type: 'blunt' }, { op: 'strike', mult: 0.6, delay: 0.25, type: 'blunt' }, { op: 'strike', mult: 0.9, delay: 0.42, type: 'blunt', knockback: 3 }],
  }),
  A('kick', 'Front Kick', 'unarmed', 'aim', {
    icon: '🦶', description: 'A powerful kick that sends the target flying.',
    cost: { stamina: 12 }, cooldown: 5, anim: 'kick', range: 2.2, ops: [{ op: 'strike', mult: 0.9, reach: 0.3, arc: 60, knockback: 10, type: 'blunt', delay: 0.25 }],
  }),
  A('grapple_throw', 'Grapple Throw', 'unarmed', 'entity', {
    icon: '🤼', description: 'Seize a foe and throw them over your shoulder.',
    cost: { stamina: 20 }, cooldown: 10, anim: 'punch', range: 2.5, requires: { target: 'any' }, ops: [special('throw', 1)],
  }),
  A('pressure_point', 'Pressure Point', 'unarmed', 'aim', {
    icon: '☝', description: 'Strike a nerve cluster: stuns and silences.',
    cost: { stamina: 18 }, cooldown: 14, anim: 'punch', range: 2, ops: [{ op: 'strike', mult: 0.5, effect: eff('stun', 1, 2), delay: 0.2, type: 'blunt' }, tgt('silenced', 1, 4)],
  }),
  A('ki_palm', 'Ki Palm', 'unarmed', 'cone', {
    icon: '🖐', description: 'Channel inner force through an open palm: a blast of pure force.',
    cost: { stamina: 24 }, cooldown: 10, anim: 'punch', range: 5,
    ops: [{ op: 'cone', range: 5, angle: 40, damage: 16, type: 'force', knockback: 12, fx: 'force_cone' }],
  }),

  // =================================================================== SHIELDS
  A('shield_bash', 'Shield Bash', 'shields', 'aim', {
    icon: '🛡', description: 'Slam your shield into the foe, stunning briefly.',
    cost: { stamina: 15 }, cooldown: 6, anim: 'punch', range: 2.2, requires: SHIELD,
    ops: [{ op: 'strike', mult: 0.7, arc: 70, type: 'blunt', knockback: 6, effect: eff('stun', 1, 1), delay: 0.2 }],
  }),
  A('shield_wall', 'Shield Wall', 'shields', 'self', {
    icon: '🧱', description: 'Brace behind your shield: greatly increased armor.',
    cost: { stamina: 15 }, cooldown: 18, anim: 'block', role: 'defense', requires: SHIELD, ops: [self('fortified', 1.5, 8)],
  }),
  A('shield_charge', 'Shield Charge', 'shields', 'aim', {
    icon: '🐂', description: 'Charge behind your shield, bowling over anything in the way.',
    cost: { stamina: 25 }, cooldown: 10, anim: 'block', range: 10, requires: SHIELD, tags: ['movement'],
    ops: [{ op: 'dash', speed: 14, dir: 'flat', hit: { damage: 10, type: 'blunt', knockback: 9, radius: 1.6 } }, self('unstoppable', 1, 0.8)],
  }),
  A('reflect', 'Reflect', 'shields', 'self', {
    icon: '⟲', description: 'Angle your shield to send projectiles back to their owner.',
    cost: { stamina: 20 }, cooldown: 20, anim: 'block', role: 'defense', requires: SHIELD, ops: [self('reflect', 1, 4)],
  }),
  A('bulwark', 'Bulwark', 'shields', 'aura', {
    icon: '🏰', description: 'Rally allies behind you: everyone nearby gains armor.',
    cost: { stamina: 30 }, cooldown: 40, anim: 'cheer', role: 'defense', radius: 8,
    ops: [{ op: 'area', radius: 8, at: 'self', who: 'ally', effect: eff('fortified', 1, 15) }, fx('rally', 'self', 8)],
  }),

  // =================================================================== HEAVY / LIGHT ARMOR
  P('iron_skin', 'Iron Skin', 'heavy_armor', '⛓', 'Years in mail have hardened you.', { armor: 8, 'resist.slash': 0.05 }, 'defense'),
  A('brace', 'Brace', 'heavy_armor', 'self', {
    icon: '⛨', description: 'Lock your stance and armor: much harder to hurt.', cost: { stamina: 15 }, cooldown: 25, anim: 'block', role: 'defense', ops: [self('fortified', 1.2, 12)],
  }),
  A('unstoppable', 'Unstoppable', 'heavy_armor', 'self', {
    icon: '➤', description: 'Shrug off slows, roots, stuns and knockdowns.', cost: { stamina: 25 }, cooldown: 30, anim: 'cheer', role: 'defense', ops: [self('unstoppable', 1, 6)],
  }),
  P('juggernaut', 'Juggernaut', 'heavy_armor', '🗿', 'You are a walking fortress.', { maxHp: 30, armor: 10 }, 'defense'),
  P('evasion', 'Evasion', 'light_armor', '↯', 'Light gear lets you slip blows.', { dodge: 0.05 }, 'defense'),
  P('nimble', 'Nimble', 'light_armor', '🦌', 'Quick on your feet.', { moveSpeed: 0.05, staminaRegen: 2 }, 'movement'),
  A('deflect', 'Deflect', 'light_armor', 'self', {
    icon: '〽', description: 'Twist and roll with the blows: very hard to hit for a few seconds.', cost: { stamina: 15 }, cooldown: 18, anim: 'block', role: 'defense', ops: [self('evasive', 1, 5)],
  }),
  P('windrunner', 'Windrunner', 'light_armor', '🍃', 'You move like the wind.', { moveSpeed: 0.08, dodge: 0.05 }, 'movement'),

  // =================================================================== ACROBATICS
  A('dodge_roll', 'Dodge Roll', 'acrobatics', 'self', {
    icon: '↩', description: 'Roll in your movement direction, briefly hard to hit.', cost: { stamina: 15 }, cooldown: 1.2, anim: 'flinch', role: 'movement', tags: ['movement', 'movedir'],
    ops: [{ op: 'dash', speed: 10, dir: 'flat' }, self('phase', 1, 0.4)],
  }),
  A('leap', 'Leap', 'acrobatics', 'self', {
    icon: '⤒', description: 'Spring high into the air; your legs stay coiled for a while.', cost: { stamina: 15 }, cooldown: 8, anim: 'cheer', role: 'movement', tags: ['movement'],
    ops: [{ op: 'dash', speed: 0, up: 7, dir: 'up' }, self('leap_boost', 1, 6)],
  }),
  P('featherstep', 'Featherstep', 'acrobatics', '🪶', 'You land like a cat.', { fallResist: 0.3, jump: 0.1 }, 'movement'),
  A('backflip', 'Backflip', 'acrobatics', 'self', {
    icon: '🔙', description: 'Flip backwards out of danger.', cost: { stamina: 15 }, cooldown: 4, anim: 'flinch', role: 'movement', tags: ['movement'],
    ops: [{ op: 'dash', speed: 9, up: 5, dir: 'back' }, self('phase', 1, 0.5)],
  }),
  A('glide', 'Glide', 'acrobatics', 'self', {
    icon: '🪂', description: 'Spread your cloak and glide. Toggle; drains stamina.', cost: { stamina: 10 }, cooldown: 2, anim: 'cast_self', role: 'movement', toggle: true, upkeep: { stamina: 2 }, tags: ['movement'],
    ops: [self('glide', 1, Infinity)],
  }),

  // =================================================================== ATHLETICS
  A('sprint_burst', 'Sprint Burst', 'athletics', 'self', {
    icon: '💨', description: 'An explosive burst of speed.', cost: { stamina: 20 }, cooldown: 12, anim: '', role: 'movement', tags: ['movement'], ops: [self('haste', 1.4, 4)],
  }),
  A('second_wind', 'Second Wind', 'athletics', 'self', {
    icon: '↻', description: 'Catch your breath: stamina floods back and minor wounds close.', cost: {}, cooldown: 60, anim: 'cheer', role: 'utility',
    ops: [self('second_wind', 1, 6), { op: 'heal', to: 'self', amount: 10 }],
  }),
  P('marathon', 'Marathon', 'athletics', '🏅', 'Endless endurance.', { maxStamina: 25, staminaRegen: 2 }, 'movement'),
  A('charge', 'Charge', 'athletics', 'aim', {
    icon: '🐗', description: 'Barrel forward, knocking down whatever you hit.', cost: { stamina: 25 }, cooldown: 12, anim: 'punch', range: 12, tags: ['movement'],
    ops: [{ op: 'dash', speed: 15, dir: 'flat', hit: { damage: 12, type: 'blunt', knockback: 9, radius: 1.6 } }],
  }),
  P('titan_grip', 'Titan Grip', 'athletics', '🏋', 'Remarkable strength.', { carry: 60, 'damage.blunt': 0.1 }, 'utility'),

  // =================================================================== PYROMANCY
  A('ignite', 'Ignite', 'pyromancy', 'aim', {
    icon: '🕯', description: 'Set a creature, tree or anything flammable ablaze.', cost: { mana: 10 }, cooldown: 2, castTime: 0.3, range: 20, tags: ['fire'],
    ops: [{ op: 'beam', range: 20, fx: 'ignite', damage: 4, type: 'fire', effect: eff('burning', 4, 6), objects: { amount: 45, kind: 'fire' } }],
  }),
  A('fireball', 'Fireball', 'pyromancy', 'aim', {
    icon: '☄', description: 'A roaring ball of fire that explodes on impact and scorches a small crater.', cost: { mana: 22 }, cooldown: 3, castTime: 0.5, range: 60, radius: 2.5, tags: ['fire', 'terrain'],
    ops: [{
      op: 'projectile', fx: 'fireball', speed: 28, gravity: 0.12, radius: 0.3, light: [1, 0.5, 0.15], damage: 6, type: 'fire',
      onHit: [
        { op: 'area', radius: 2.5, damage: 24, type: 'fire', knockback: 5, effect: eff('burning', 3, 4), objects: { amount: 30, kind: 'fire' } },
        { op: 'terrain', shape: 'crater', edit: 'dig', radius: 1.0, strength: 0.5 }, fx('explosion_fire', 'point', 2.5),
      ],
    }],
  }),
  A('flame_wall', 'Flame Wall', 'pyromancy', 'ground', {
    icon: '🔥', description: 'Raise a roaring wall of fire across the ground.', cost: { mana: 35 }, cooldown: 14, castTime: 0.6, range: 25, radius: 4, anim: 'cast_ground', tags: ['fire', 'zone'],
    ops: [{ op: 'zone', kind: 'flame_wall', radius: 1.2, length: 8, duration: 8, tick: 0.5, light: [1, 0.45, 0.12], lightIntensity: 8, ops: [{ op: 'area', radius: 0, who: 'all', damage: 6, type: 'fire', effect: eff('burning', 3, 3), objects: { amount: 12, kind: 'fire' } }] }],
  }),
  A('flame_cloak', 'Flame Cloak', 'pyromancy', 'self', {
    icon: '♨', description: 'Wreathe yourself in flame: melee attackers burn, cold cannot touch you.', cost: { mana: 25 }, cooldown: 30, anim: 'cast_self', role: 'defense', tags: ['fire'],
    ops: [self('flame_cloak', 1, 20)],
  }),
  A('meteor', 'Meteor', 'pyromancy', 'ground', {
    icon: '🌠', description: 'Call down a burning rock from the sky. Devastating, and it leaves a crater.', cost: { mana: 60 }, cooldown: 30, castTime: 1.0, range: 50, radius: 4, anim: 'cast_up', tags: ['fire', 'terrain'],
    ops: [
      { op: 'fx', fx: 'meteor_fall', at: 'point', radius: 4, duration: 1.2 },
      { op: 'delay', t: 1.2, ops: [
        { op: 'area', radius: 4.5, damage: 55, type: 'fire', knockback: 10, lift: 4, effect: eff('burning', 5, 5), objects: { amount: 120, kind: 'fire' } },
        { op: 'terrain', shape: 'crater', edit: 'dig', radius: 2.4, strength: 0.85 }, { op: 'terrain', shape: 'crater', edit: 'dig', radius: 1.2, strength: 0.6, count: 3, spread: 2.5 },
        fx('explosion_big', 'point', 4.5),
      ] },
    ],
  }),
  A('inferno', 'Inferno', 'pyromancy', 'aura', {
    icon: '🌋', description: 'Become the eye of a firestorm that follows you.', cost: { mana: 70 }, cooldown: 45, castTime: 0.8, anim: 'cast_self', radius: 6, tags: ['fire', 'zone'],
    ops: [{ op: 'zone', kind: 'inferno', radius: 6, duration: 6, tick: 0.5, follow: true, at: 'self', light: [1, 0.4, 0.1], lightIntensity: 14, ops: [{ op: 'area', radius: 0, who: 'hostile', damage: 9, type: 'fire', effect: eff('burning', 4, 3), objects: { amount: 15, kind: 'fire' } }] }],
  }),

  // =================================================================== CRYOMANCY
  A('frost_bolt', 'Frost Bolt', 'cryomancy', 'aim', {
    icon: '❄', description: 'A shard of ice that chills its target.', cost: { mana: 10 }, cooldown: 1.2, castTime: 0.3, range: 50, tags: ['frost'],
    ops: [{ op: 'projectile', fx: 'frost_bolt', speed: 34, gravity: 0.05, radius: 0.15, damage: 14, type: 'frost', effect: eff('chilled', 1, 4), light: [0.5, 0.8, 1] }],
  }),
  A('freeze_water', 'Freeze Water', 'cryomancy', 'ground', {
    icon: '🧊', description: 'Freeze the water surface into a floe and let your feet frost so you can walk on water.', cost: { mana: 15 }, cooldown: 6, range: 14, radius: 3, anim: 'cast_ground', role: 'utility', tags: ['frost', 'terrain', 'water'],
    ops: [{ op: 'terrain', shape: 'floe', edit: 'fill', radius: 2.2, mat: Mat.Ice }, self('waterwalk', 1, 30), fx('frost_burst', 'point', 3)],
  }),
  A('ice_wall', 'Ice Wall', 'cryomancy', 'ground', {
    icon: '🧱', description: 'Raise a wall of solid ice. It stays until broken.', cost: { mana: 30 }, cooldown: 12, castTime: 0.5, range: 20, anim: 'cast_ground', role: 'defense', tags: ['frost', 'terrain'],
    ops: [{ op: 'terrain', shape: 'wall', edit: 'fill', radius: 0.9, length: 6, height: 3, mat: Mat.Ice }, fx('frost_burst', 'point', 4)],
  }),
  A('frost_nova', 'Frost Nova', 'cryomancy', 'aura', {
    icon: '✳', description: 'Release a ring of killing cold that freezes enemies solid.', cost: { mana: 35 }, cooldown: 18, anim: 'cast_self', radius: 5, tags: ['frost'],
    ops: [{ op: 'area', radius: 5, at: 'self', who: 'hostile', damage: 12, type: 'frost', effect: eff('frozen', 1, 2.5) }, fx('frost_nova', 'self', 5)],
  }),
  A('ice_lance', 'Ice Lance', 'cryomancy', 'aim', {
    icon: '🗡', description: 'A long spear of ice that skewers several foes in a line.', cost: { mana: 28 }, cooldown: 6, castTime: 0.6, range: 70, tags: ['frost'],
    ops: [{ op: 'projectile', fx: 'ice_lance', speed: 60, gravity: 0.05, radius: 0.15, damage: 30, type: 'frost', pierce: 2, effect: eff('chilled', 1.5, 5), light: [0.5, 0.8, 1], knockback: 3 }],
  }),
  A('frost_armor', 'Frost Armor', 'cryomancy', 'self', {
    icon: '❆', description: 'Plates of living ice armor you and chill attackers.', cost: { mana: 25 }, cooldown: 35, anim: 'cast_self', role: 'defense', tags: ['frost'], ops: [self('frost_armor', 1, 30)],
  }),
  A('blizzard', 'Blizzard', 'cryomancy', 'ground', {
    icon: '🌨', description: 'Summon a howling storm of ice over an area.', cost: { mana: 70 }, cooldown: 40, castTime: 1.0, range: 40, radius: 6, anim: 'cast_up', tags: ['frost', 'zone'],
    ops: [{ op: 'zone', kind: 'blizzard', radius: 6, duration: 10, tick: 0.5, ops: [{ op: 'area', radius: 0, who: 'hostile', damage: 5, type: 'frost', effect: eff('chilled', 1.5, 1.5) }] }],
  }),

  // =================================================================== GEOMANCY
  A('earth_spike', 'Earth Spike', 'geomancy', 'ground', {
    icon: '⛰', description: 'A spike of stone erupts beneath the target, tossing it into the air.', cost: { mana: 12 }, cooldown: 2.5, castTime: 0.35, range: 22, radius: 1.4, anim: 'cast_ground', tags: ['earth'],
    ops: [{ op: 'area', radius: 1.5, damage: 16, type: 'pierce', knockback: 1, lift: 8, who: 'hostile' }, fx('earth_spike', 'point', 1.4)],
  }),
  A('dig_bore', 'Bore', 'geomancy', 'aim', {
    icon: '🕳', description: 'Bore a short tunnel straight into rock or earth. Yields the material.', cost: { mana: 18 }, cooldown: 4, castTime: 0.6, range: 8, role: 'utility', tags: ['earth', 'terrain'],
    ops: [{ op: 'terrain', shape: 'bore', edit: 'dig', radius: 1.2, length: 6, yields: true }],
  }),
  A('raise_pillar', 'Raise Pillar', 'geomancy', 'ground', {
    icon: '🗿', description: 'Raise a stone pillar from the ground — under yourself it lifts you up.', cost: { mana: 20 }, cooldown: 6, castTime: 0.4, range: 20, anim: 'cast_ground', role: 'utility', tags: ['earth', 'terrain'],
    ops: [{ op: 'terrain', shape: 'pillar', edit: 'fill', radius: 0.9, height: 4, mat: Mat.Stone }, fx('earth_rise', 'point', 1.2)],
  }),
  A('raise_wall', 'Raise Wall', 'geomancy', 'ground', {
    icon: '🧱', description: 'Pull a wall of stone up out of the earth.', cost: { mana: 30 }, cooldown: 10, castTime: 0.6, range: 20, anim: 'cast_ground', role: 'defense', tags: ['earth', 'terrain'],
    ops: [{ op: 'terrain', shape: 'wall', edit: 'fill', radius: 0.9, length: 6, height: 2.5, mat: Mat.Stone }, fx('earth_rise', 'point', 3)],
  }),
  A('quake', 'Quake', 'geomancy', 'aura', {
    icon: '〰', description: 'Shake the ground: foes are thrown down and small sinkholes open.', cost: { mana: 45 }, cooldown: 25, castTime: 0.7, anim: 'cast_ground', radius: 8, tags: ['earth', 'terrain'],
    ops: [
      { op: 'area', radius: 8, at: 'self', damage: 14, type: 'blunt', knockback: 5, lift: 4, effect: eff('staggered', 1, 2), who: 'hostile' },
      { op: 'terrain', shape: 'crater', edit: 'dig', radius: 0.9, strength: 0.45, at: 'self', count: 5, spread: 6 }, fx('quake', 'self', 8),
    ],
  }),
  A('stone_skin', 'Stone Skin', 'geomancy', 'self', {
    icon: '🪨', description: 'Your skin hardens to granite.', cost: { mana: 30 }, cooldown: 40, anim: 'cast_self', role: 'defense', tags: ['earth'], ops: [self('stoneskin', 1, 25)],
  }),
  A('earthen_bridge', 'Earthen Bridge', 'geomancy', 'aim', {
    icon: '🌉', description: 'Extrude a stone causeway straight ahead to cross chasms and water.', cost: { mana: 35 }, cooldown: 15, castTime: 0.8, range: 10, anim: 'cast_ground', role: 'utility', tags: ['earth', 'terrain'],
    ops: [{ op: 'terrain', shape: 'bridge', edit: 'fill', radius: 0.9, length: 10, mat: Mat.Stone }],
  }),

  // =================================================================== GRAVITAS
  A('featherfall', 'Featherfall', 'gravitas', 'self', {
    icon: '🪶', description: 'Fall as slowly as a feather.', cost: { mana: 8 }, cooldown: 6, anim: 'cast_self', role: 'movement', tags: ['gravity'], ops: [self('featherfall', 1, 20)],
  }),
  A('lighten', 'Lighten', 'gravitas', 'self', {
    icon: '◌', description: 'Halve your weight: leap far, fall softly.', cost: { mana: 14 }, cooldown: 12, anim: 'cast_self', role: 'movement', tags: ['gravity'], ops: [self('gravity_low', 1, 15)],
  }),
  A('levitate', 'Levitate', 'gravitas', 'self', {
    icon: '☁', description: 'Float in the air (jump to rise, crouch to sink). Toggle; drains mana.', cost: { mana: 10 }, cooldown: 2, anim: 'channel', role: 'movement', toggle: true, upkeep: { mana: 4 }, tags: ['gravity'],
    ops: [self('levitate', 1, Infinity)],
  }),
  A('gravity_well', 'Gravity Well', 'gravitas', 'ground', {
    icon: '🌀', description: 'Create a point of crushing gravity that drags everything toward it.', cost: { mana: 40 }, cooldown: 20, castTime: 0.6, range: 30, radius: 7, anim: 'cast_ground', tags: ['gravity', 'zone'],
    ops: [
      { op: 'gravity', radius: 7, factor: 2.2, duration: 6 },
      { op: 'zone', kind: 'gravity_well', radius: 7, duration: 6, tick: 0.25, gravity: 2.2, ops: [{ op: 'push', radius: 7, force: -4, who: 'others' }, { op: 'area', radius: 0, who: 'hostile', effect: eff('slow', 1, 0.5) }] },
    ],
  }),
  A('crush', 'Crush', 'gravitas', 'aim', {
    icon: '●', description: 'Multiply the weight of a single target, crushing it to the ground.', cost: { mana: 30 }, cooldown: 10, castTime: 0.4, range: 28, tags: ['gravity'],
    ops: [{ op: 'beam', range: 28, fx: 'crush', damage: 20, type: 'force', effect: eff('gravity_high', 1, 4) }],
  }),
  A('gravity_flip', 'Gravity Flip', 'gravitas', 'ground', {
    icon: '⇅', description: 'Invert gravity in an area: everything inside drifts upward, then crashes down.', cost: { mana: 50 }, cooldown: 30, castTime: 0.7, range: 30, radius: 8, anim: 'cast_up', tags: ['gravity'],
    ops: [{ op: 'gravity', radius: 8, factor: -0.25, duration: 5 }, { op: 'push', radius: 8, force: 0, up: 6, who: 'all' }, fx('gravity_ring', 'point', 8)],
  }),
  A('singularity', 'Singularity', 'gravitas', 'ground', {
    icon: '⚫', description: 'Tear open a point of infinite weight. Everything nearby is pulled in and ground apart.', cost: { mana: 80 }, cooldown: 60, castTime: 1.2, range: 35, radius: 9, anim: 'cast_forward', tags: ['gravity', 'zone'],
    ops: [
      { op: 'gravity', radius: 9, factor: 3, duration: 5 },
      { op: 'zone', kind: 'singularity', radius: 9, duration: 5, tick: 0.25, gravity: 3, light: [0.6, 0.3, 1], lightIntensity: 6, ops: [{ op: 'push', radius: 9, force: -8, who: 'others' }, { op: 'area', radius: 2.5, who: 'hostile', damage: 6, type: 'force' }] },
      { op: 'delay', t: 5, ops: [{ op: 'area', radius: 5, who: 'hostile', damage: 30, type: 'force', knockback: 12 }, fx('implosion', 'point', 5)] },
    ],
  }),

  // =================================================================== VITAE
  A('mend', 'Mend', 'vitae', 'entity', {
    icon: '✚', description: 'Knit wounds closed (target an ally, or yourself if none).', cost: { mana: 14 }, cooldown: 2, castTime: 0.8, range: 25, anim: 'cast_forward', role: 'utility', tags: ['heal'],
    ops: [{ op: 'heal', to: 'target', amount: 22 }, fx('heal', 'target')],
  }),
  A('regenerate', 'Regenerate', 'vitae', 'entity', {
    icon: '♻', description: 'Steady regeneration over time.', cost: { mana: 18 }, cooldown: 8, range: 25, role: 'utility', tags: ['heal'], ops: [tgt('regen', 4, 12), fx('heal', 'target')],
  }),
  A('entangling_roots', 'Entangling Roots', 'vitae', 'ground', {
    icon: '🌱', description: 'Roots burst from the soil and hold enemies fast.', cost: { mana: 25 }, cooldown: 14, castTime: 0.5, range: 25, radius: 3, anim: 'cast_ground', tags: ['nature', 'zone'],
    ops: [{ op: 'zone', kind: 'roots', radius: 3, duration: 5, tick: 0.5, ops: [{ op: 'area', radius: 0, who: 'hostile', damage: 2, type: 'pierce', effect: eff('root', 1, 0.8) }] }],
  }),
  A('cleanse', 'Cleanse', 'vitae', 'entity', {
    icon: '💧', description: 'Wash away poisons, curses and other afflictions.', cost: { mana: 15 }, cooldown: 10, castTime: 0.4, range: 25, role: 'utility', tags: ['heal'],
    ops: [{ op: 'cleanse', to: 'target' }, fx('cleanse', 'target')],
  }),
  A('grow', 'Grow', 'vitae', 'ground', {
    icon: '🌼', description: 'Coax wild herbs out of fertile ground.', cost: { mana: 25 }, cooldown: 30, castTime: 1.2, range: 10, radius: 3, anim: 'cast_ground', role: 'utility', tags: ['nature'],
    ops: [special('grow', 1, 3), fx('bloom', 'point', 3)],
  }),
  A('thorns', 'Thorns', 'vitae', 'self', {
    icon: '❦', description: 'Barbed bark covers you; melee attackers are wounded.', cost: { mana: 20 }, cooldown: 25, anim: 'cast_self', role: 'defense', tags: ['nature'], ops: [self('thorns', 1, 20)],
  }),
  A('sanctuary', 'Sanctuary', 'vitae', 'ground', {
    icon: '🌳', description: 'Consecrate a circle of living green that heals allies and cleanses them.', cost: { mana: 60 }, cooldown: 45, castTime: 1.0, range: 20, radius: 5, anim: 'cast_ground', role: 'utility', tags: ['heal', 'zone'],
    ops: [{ op: 'zone', kind: 'sanctuary', radius: 5, duration: 10, tick: 1, light: [0.5, 1, 0.5], lightIntensity: 4, ops: [{ op: 'area', radius: 0, who: 'ally', heal: 7 }, { op: 'cleanse', to: 'area', radius: 5, max: 1 }] }],
  }),

  // =================================================================== LUMINISM
  A('light_orb', 'Light Orb', 'luminism', 'self', {
    icon: '💡', description: 'Conjure a floating orb of light that follows you (lasts two minutes).', cost: { mana: 8 }, cooldown: 3, anim: 'cast_self', role: 'utility', radius: 14, tags: ['light'],
    ops: [{ op: 'zone', kind: 'light_orb', radius: 0.4, duration: 120, at: 'self', follow: true, light: [1, 0.92, 0.75], lightIntensity: 1.2, lightRadius: 16, max: 1 }],
  }),
  A('sunlance', 'Sunlance', 'luminism', 'aim', {
    icon: '☀', description: 'A lance of concentrated sunlight. Exposes hidden foes.', cost: { mana: 14 }, cooldown: 2, castTime: 0.35, range: 35, tags: ['light'],
    ops: [{ op: 'beam', range: 35, fx: 'sunlance', damage: 16, type: 'radiant', effect: eff('exposed', 1, 6) }],
  }),
  A('blind', 'Blinding Flash', 'luminism', 'cone', {
    icon: '◉', description: 'A searing flash blinds everyone in front of you.', cost: { mana: 18 }, cooldown: 12, range: 9, tags: ['light'],
    ops: [{ op: 'cone', range: 9, angle: 55, effect: eff('blinded', 1, 4), fx: 'flash', who: 'others' }],
  }),
  A('halo', 'Halo', 'luminism', 'self', {
    icon: '◯', description: 'A crown of light that wards against shadow and lights your way.', cost: { mana: 20 }, cooldown: 30, anim: 'cast_self', role: 'defense', tags: ['light'], ops: [self('halo', 1, 30)],
  }),
  A('sunburst', 'Sunburst', 'luminism', 'aura', {
    icon: '🌞', description: 'Explode with light: burns enemies, blinds them and reveals the invisible.', cost: { mana: 40 }, cooldown: 18, castTime: 0.5, anim: 'cast_up', radius: 7, tags: ['light'],
    ops: [{ op: 'area', radius: 7, at: 'self', who: 'hostile', damage: 20, type: 'radiant', effect: eff('blinded', 0.6, 2) }, { op: 'area', radius: 12, at: 'self', who: 'others', effect: eff('exposed', 1, 8) }, fx('sunburst', 'self', 7)],
  }),
  A('dawn', 'Dawn', 'luminism', 'ground', {
    icon: '🌅', description: 'Bring the sunrise to a place: foes burn, allies heal.', cost: { mana: 60 }, cooldown: 45, castTime: 1.0, range: 30, radius: 7, anim: 'cast_up', tags: ['light', 'zone'],
    ops: [{ op: 'zone', kind: 'dawn', radius: 7, duration: 8, tick: 1, light: [1, 0.85, 0.55], lightIntensity: 16, ops: [{ op: 'area', radius: 0, who: 'hostile', damage: 9, type: 'radiant', effect: eff('exposed', 1, 2) }, { op: 'area', radius: 0, who: 'ally', heal: 4 }] }],
  }),

  // =================================================================== UMBRAMANCY
  A('shadow_bolt', 'Shadow Bolt', 'umbramancy', 'aim', {
    icon: '☾', description: 'A seeking bolt of shadow that withers its target.', cost: { mana: 10 }, cooldown: 1.4, castTime: 0.3, range: 45, tags: ['shadow'],
    ops: [{ op: 'projectile', fx: 'shadow_bolt', speed: 26, gravity: 0, radius: 0.2, damage: 13, type: 'shadow', homing: 2.5, effect: eff('decay', 2, 4), light: [0.5, 0.2, 0.9] }],
  }),
  A('shadow_cloak', 'Shadow Cloak', 'umbramancy', 'self', {
    icon: '🌑', description: 'Wrap yourself in shadow and become nearly invisible. Toggle; drains mana; attacking breaks it.', cost: { mana: 10 }, cooldown: 3, anim: 'cast_self', role: 'utility', toggle: true, upkeep: { mana: 3 }, tags: ['shadow', 'stealth'],
    ops: [self('shadow_cloak', 1, Infinity)],
  }),
  A('shadow_step', 'Shadow Step', 'umbramancy', 'ground', {
    icon: '⇝', description: 'Step through the shadows and reappear where you aim.', cost: { mana: 18 }, cooldown: 8, range: 16, anim: 'cast_self', role: 'movement', tags: ['shadow', 'teleport', 'movement'],
    ops: [{ op: 'teleport', mode: 'blink', range: 16 }],
  }),
  A('fear', 'Fear', 'umbramancy', 'entity', {
    icon: '😱', description: 'Fill a creature\'s mind with nightmares: it flees in terror.', cost: { mana: 20 }, cooldown: 14, castTime: 0.4, range: 25, tags: ['shadow', 'mind'],
    ops: [{ op: 'beam', range: 25, fx: 'shadow_tendril', damage: 5, type: 'psychic', effect: eff('feared', 1, 5) }],
  }),
  A('umbral_sight', 'Umbral Sight', 'umbramancy', 'self', {
    icon: '👁', description: 'See clearly in the deepest darkness.', cost: { mana: 10 }, cooldown: 30, anim: 'cast_self', role: 'utility', tags: ['shadow'], ops: [self('darkvision', 1, 90)],
  }),
  A('mirror_image', 'Mirror Image', 'umbramancy', 'self', {
    icon: '👥', description: 'Leave a shadow double behind that draws enemies while you vanish.', cost: { mana: 30 }, cooldown: 30, anim: 'cast_self', role: 'defense', tags: ['shadow', 'illusion'],
    ops: [special('decoy', 1, 12, 8), self('invisible', 1, 3)],
  }),
  A('night_shroud', 'Night Shroud', 'umbramancy', 'ground', {
    icon: '🌌', description: 'Drown an area in supernatural darkness: enemies are blinded, allies hidden.', cost: { mana: 55 }, cooldown: 40, castTime: 0.8, range: 25, radius: 7, anim: 'cast_ground', tags: ['shadow', 'zone'],
    ops: [{ op: 'zone', kind: 'night', radius: 7, duration: 10, tick: 1, ops: [{ op: 'area', radius: 0, who: 'hostile', effect: eff('blinded', 1, 1.5) }, { op: 'area', radius: 0, who: 'ally', effect: eff('sneak_boost', 2, 1.5) }] }],
  }),

  // =================================================================== KINESIS
  A('force_push', 'Force Push', 'kinesis', 'cone', {
    icon: '✋', description: 'A wave of force that throws creatures and loose objects away from you.', cost: { mana: 10 }, cooldown: 3, range: 7, tags: ['force'],
    ops: [{ op: 'push', radius: 7, cone: 60, force: 13, up: 2, at: 'self', who: 'others' }, { op: 'cone', range: 7, angle: 60, damage: 5, type: 'force', fx: 'force_cone', who: 'hostile' }],
  }),
  A('force_pull', 'Force Pull', 'kinesis', 'aim', {
    icon: '🤏', description: 'Yank a creature or object toward you.', cost: { mana: 14 }, cooldown: 6, range: 22, tags: ['force'],
    ops: [{ op: 'push', radius: 22, cone: 10, force: -14, up: 2, at: 'self', who: 'others' }, { op: 'fx', fx: 'pull_beam', at: 'self', radius: 22 }],
  }),
  A('force_shield', 'Force Shield', 'kinesis', 'self', {
    icon: '⛉', description: 'A shimmering barrier that absorbs damage.', cost: { mana: 25 }, cooldown: 20, anim: 'cast_self', role: 'defense', tags: ['force'], ops: [{ op: 'effect', to: 'self', id: 'force_shield', magnitude: 40, duration: 12, scale: true }],
  }),
  A('telekinetic_hurl', 'Telekinetic Hurl', 'kinesis', 'aim', {
    icon: '🪨', description: 'Tear a boulder from the ground and fling it.', cost: { mana: 28 }, cooldown: 7, castTime: 0.6, range: 45, tags: ['force', 'terrain'], ops: [special('tk_hurl', 1)],
  }),
  A('kinetic_leap', 'Kinetic Leap', 'kinesis', 'self', {
    icon: '🚀', description: 'Launch yourself skyward on a pulse of force; descend gently.', cost: { mana: 15 }, cooldown: 6, anim: 'cast_self', role: 'movement', tags: ['force', 'movement'],
    ops: [{ op: 'dash', speed: 6, up: 12, dir: 'flat' }, self('featherfall', 1, 5), fx('force_ring', 'self', 2)],
  }),
  A('shockwave', 'Shockwave', 'kinesis', 'aura', {
    icon: '💢', description: 'Detonate a sphere of force around you.', cost: { mana: 40 }, cooldown: 18, castTime: 0.3, anim: 'cast_self', radius: 6, tags: ['force'],
    ops: [{ op: 'area', radius: 6, at: 'self', who: 'hostile', damage: 15, type: 'force' }, { op: 'push', radius: 6, force: 13, up: 3, at: 'self', who: 'others' }, fx('force_ring', 'self', 6)],
  }),
  A('crushing_grip', 'Crushing Grip', 'kinesis', 'entity', {
    icon: '✊', description: 'Lift a creature into the air and squeeze.', cost: { mana: 45 }, cooldown: 25, castTime: 0.5, range: 25, tags: ['force'], requires: { target: 'any' },
    ops: [tgt('levitate', 1, 3), tgt('stun', 1, 3), { op: 'beam', range: 25, fx: 'grip', damage: 30, type: 'force' }],
  }),

  // =================================================================== ANIMISM
  A('calm_beast', 'Calm Beast', 'animism', 'entity', {
    icon: '☮', description: 'Soothe an animal so it will not attack.', cost: { mana: 12 }, cooldown: 10, castTime: 0.6, range: 20, role: 'social', tags: ['beast'], requires: { target: 'creature' },
    ops: [special('calm', 1)],
  }),
  A('beast_sense', 'Beast Sense', 'animism', 'self', {
    icon: '🐾', description: 'Feel the heartbeat of every animal nearby.', cost: { mana: 8 }, cooldown: 20, anim: 'cast_self', role: 'utility', tags: ['beast', 'sense'], ops: [special('sense_beasts', 1, 80), self('beast_sense', 1, 60)],
  }),
  A('tame', 'Tame', 'animism', 'entity', {
    icon: '🦮', description: 'Bond with a wild creature. Calm or weakened beasts are easier.', cost: { mana: 30 }, cooldown: 30, castTime: 2.0, range: 12, anim: 'channel', role: 'social', tags: ['beast'], requires: { target: 'creature' },
    ops: [special('tame', 1)],
  }),
  A('call_of_the_wild', 'Call of the Wild', 'animism', 'self', {
    icon: '🐺', description: 'Call a local beast to fight at your side for a while.', cost: { mana: 45 }, cooldown: 120, castTime: 1.5, anim: 'cast_up', tags: ['beast', 'summon'],
    ops: [{ op: 'summon', role: 'predator', duration: 90 }],
  }),
  A('wolf_spirit', 'Wolf Spirit', 'animism', 'aura', {
    icon: '🌕', description: 'Share the pack spirit with yourself and nearby allies.', cost: { mana: 25 }, cooldown: 45, anim: 'cast_self', radius: 10, tags: ['beast'],
    ops: [self('wolf_spirit', 1, 30), { op: 'area', radius: 10, at: 'self', who: 'ally', effect: eff('wolf_spirit', 1, 30) }],
  }),
  A('pack_command', 'Pack Command', 'animism', 'aim', {
    icon: '📯', description: 'Command your beasts: they surge toward your target, frenzied.', cost: { mana: 20 }, cooldown: 20, anim: 'gesture_point', tags: ['beast'], ops: [special('rally_pets', 1, 40)],
  }),

  // =================================================================== RUNECRAFT
  A('enchant_weapon', 'Runic Edge', 'runecraft', 'self', {
    icon: 'ᚱ', description: 'Trace a storm rune along your weapon: strikes deal extra shock damage.', cost: { mana: 20 }, cooldown: 30, castTime: 1.0, anim: 'cast_self', role: 'crafting', tags: ['rune', 'enchant'],
    ops: [{ op: 'effect', to: 'self', id: 'enchant_shock', magnitude: 6, duration: 90, scale: true }],
  }),
  A('ward_rune', 'Ward Rune', 'runecraft', 'ground', {
    icon: '✡', description: 'Inscribe a glowing ward that protects allies standing on it from magic.', cost: { mana: 25 }, cooldown: 30, castTime: 1.0, range: 10, radius: 4, anim: 'cast_ground', role: 'defense', tags: ['rune', 'zone'],
    ops: [{ op: 'zone', kind: 'ward', radius: 4, duration: 30, tick: 1, light: [0.4, 1, 0.9], lightIntensity: 2, ops: [{ op: 'area', radius: 0, who: 'ally', effect: eff('ward', 1, 2) }] }],
  }),
  A('trap_rune', 'Fire Trap Rune', 'runecraft', 'ground', {
    icon: '⚠', description: 'A hidden rune that explodes when an enemy steps on it. Up to three at once.', cost: { mana: 20 }, cooldown: 6, castTime: 1.0, range: 8, radius: 3, anim: 'cast_ground', tags: ['rune', 'trap', 'fire'],
    ops: [{ op: 'zone', kind: 'trap_fire', radius: 1.6, duration: 600, trigger: true, hidden: true, max: 3, ops: [{ op: 'area', radius: 3, who: 'hostile', damage: 32, type: 'fire', knockback: 6, effect: eff('burning', 4, 4) }, fx('explosion_fire', 'point', 3), { op: 'terrain', shape: 'crater', edit: 'dig', radius: 0.8, strength: 0.4 }] }],
  }),
  A('binding_rune', 'Binding Rune', 'runecraft', 'ground', {
    icon: '⛓', description: 'A hidden rune that roots whatever steps on it. Up to three at once.', cost: { mana: 20 }, cooldown: 8, castTime: 1.0, range: 8, radius: 3, anim: 'cast_ground', tags: ['rune', 'trap'],
    ops: [{ op: 'zone', kind: 'trap_bind', radius: 1.6, duration: 600, trigger: true, hidden: true, max: 3, ops: [{ op: 'area', radius: 3, who: 'hostile', effect: eff('root', 1, 5) }, { op: 'area', radius: 3, who: 'hostile', effect: eff('slow', 1, 8) }, fx('glyph_burst', 'point', 3)] }],
  }),
  A('inscribe_weapon', 'Inscribe Weapon', 'runecraft', 'self', {
    icon: '✒', description: 'Permanently carve a rune into your weapon. Consumes a crystal shard or raw gem.', cost: { mana: 60 }, cooldown: 300, castTime: 3.0, anim: 'work_hammer', role: 'crafting', tags: ['rune', 'enchant'],
    ops: [special('inscribe', 1)],
  }),
  A('recall_rune', 'Recall Rune', 'runecraft', 'self', {
    icon: '⚓', description: 'First use carves an anchor rune here. Using it again returns you to the anchor.', cost: { mana: 30 }, cooldown: 20, castTime: 1.5, anim: 'channel', role: 'movement', tags: ['rune', 'teleport'],
    ops: [special('recall', 1)],
  }),
  A('glyph_of_warding', 'Glyph of Warding', 'runecraft', 'ground', {
    icon: '🔯', description: 'A vast glyph that wards allies and sears and slows enemies.', cost: { mana: 70 }, cooldown: 60, castTime: 1.5, range: 15, radius: 8, anim: 'cast_ground', tags: ['rune', 'zone'],
    ops: [{ op: 'zone', kind: 'glyph', radius: 8, duration: 20, tick: 1, light: [0.4, 1, 0.9], lightIntensity: 5, ops: [{ op: 'area', radius: 0, who: 'ally', effect: eff('ward', 1.5, 2) }, { op: 'area', radius: 0, who: 'hostile', damage: 6, type: 'radiant', effect: eff('slow', 1, 1.5) }] }],
  }),

  // =================================================================== CLIMBING
  A('wall_climb_surge', 'Climb Surge', 'climbing', 'self', {
    icon: '🧗', description: 'A burst of upward climbing power.', cost: { stamina: 15 }, cooldown: 10, anim: '', role: 'movement', tags: ['movement'],
    ops: [self('climb_boost', 1, 8), { op: 'dash', speed: 0, up: 4, dir: 'up' }],
  }),
  P('iron_grip', 'Iron Grip', 'climbing', '✊', 'Strong hands: climbing tires you less.', { staminaRegen: 2, carry: 10 }, 'movement'),
  A('mantle_leap', 'Mantle Leap', 'climbing', 'aim', {
    icon: '⤴', description: 'Spring up and over a ledge or wall.', cost: { stamina: 20 }, cooldown: 8, anim: '', role: 'movement', tags: ['movement'], ops: [{ op: 'dash', speed: 4, up: 8, dir: 'flat' }],
  }),
  A('spider_climb', 'Spider Climb', 'climbing', 'self', {
    icon: '🕷', description: 'Cling to any surface. Toggle; slowly drains stamina.', cost: { stamina: 10 }, cooldown: 3, anim: '', role: 'movement', toggle: true, upkeep: { stamina: 1.5 }, tags: ['movement'],
    ops: [self('climb_boost', 1.5, Infinity)],
  }),

  // =================================================================== SWIMMING
  A('swift_stroke', 'Swift Stroke', 'swimming', 'self', {
    icon: '🏊', description: 'Swim much faster for a while.', cost: { stamina: 10 }, cooldown: 12, anim: '', role: 'movement', tags: ['movement', 'water'], ops: [self('swim_boost', 1, 10)],
  }),
  P('deep_lungs', 'Deep Lungs', 'swimming', '🫁', 'Great lung capacity.', { maxStamina: 15, 'resist.frost': 0.05 }, 'movement'),
  P('tidal_grace', 'Tidal Grace', 'swimming', '🌊', 'Water-trained limbs.', { moveSpeed: 0.04, 'resist.frost': 0.1 }, 'movement'),
  A('aquatic_dash', 'Aquatic Dash', 'swimming', 'aim', {
    icon: '🐬', description: 'Dart forward like a dolphin.', cost: { stamina: 15 }, cooldown: 6, anim: '', role: 'movement', tags: ['movement', 'water'],
    ops: [{ op: 'dash', speed: 14, dir: 'aim' }, self('swim_boost', 1.3, 3)],
  }),

  // =================================================================== STEALTH
  A('backstab', 'Backstab', 'stealth', 'aim', {
    icon: '🗡', description: 'Strike an unaware target for triple damage.', cost: { stamina: 15 }, cooldown: 6, anim: 'stab', range: 2.5,
    ops: [{ op: 'strike', mult: 1.3, arc: 50, maxHits: 1, type: 'pierce', bonusUnaware: 2.0, delay: 0.2 }],
  }),
  A('vanish', 'Vanish', 'stealth', 'self', {
    icon: '💨', description: 'Disappear: enemies lose track of you.', cost: { stamina: 20 }, cooldown: 45, anim: '', role: 'utility', tags: ['stealth'],
    ops: [self('invisible', 1, 5), special('drop_aggro', 1, 30), fx('smoke_puff', 'self', 1.5)],
  }),
  P('shadow_stride', 'Shadow Stride', 'stealth', '👣', 'Soft steps.', { stealth: 15, moveSpeed: 0.03 }, 'utility'),
  A('distraction', 'Distraction', 'stealth', 'ground', {
    icon: '🪨', description: 'Toss a pebble: everyone nearby turns toward the noise.', cost: { stamina: 5 }, cooldown: 8, range: 30, radius: 10, anim: 'throw', role: 'utility', tags: ['stealth'],
    ops: [special('distract', 1, 10), fx('pebble', 'point', 1)],
  }),
  A('assassinate', 'Assassinate', 'stealth', 'aim', {
    icon: '☠', description: 'A killing blow on an unaware target.', cost: { stamina: 30 }, cooldown: 25, anim: 'stab', range: 2.5,
    ops: [{ op: 'strike', mult: 2.0, arc: 40, maxHits: 1, type: 'pierce', bonusUnaware: 4.0, delay: 0.25 }],
  }),

  // =================================================================== LOCKPICKING
  A('pick_lock', 'Pick Lock', 'lockpicking', 'aim', {
    icon: '🔓', description: 'Work a lock open (doors, chests). Steady hands for a few seconds.', cost: { stamina: 5 }, cooldown: 3, castTime: 1.5, range: 3, anim: 'harvest', role: 'utility', tags: ['lock'],
    ops: [special('pick_lock', 1)],
  }),
  P('deft_fingers', 'Deft Fingers', 'lockpicking', '🤌', 'Nimble fingers.', { 'skill.lockpicking': 5, stealth: 5 }),
  A('pickpocket', 'Pickpocket', 'lockpicking', 'entity', {
    icon: '👛', description: 'Lift coins or a trinket from someone\'s pocket. Getting caught is a crime.', cost: { stamina: 5 }, cooldown: 20, castTime: 0.8, range: 2.5, anim: 'pickup', role: 'utility', tags: ['crime'], requires: { target: 'npc' },
    ops: [special('pickpocket', 1)],
  }),
  P('master_locksmith', 'Master Locksmith', 'lockpicking', '🗝', 'No lock holds you for long.', { 'skill.lockpicking': 10, perception: 5 }),

  // =================================================================== MINING
  A('mining_strike', 'Mining Strike', 'mining', 'aim', {
    icon: '⛏', description: 'A heavy, precise blow that breaks more rock and finds more ore.', cost: { stamina: 20 }, cooldown: 3, range: 4, anim: 'mine', role: 'crafting', tags: ['terrain'],
    ops: [special('mine', 1.6)],
  }),
  A('detect_ores', 'Detect Ores', 'mining', 'self', {
    icon: '💎', description: 'Listen to the stone: nearby ore veins are revealed.', cost: { stamina: 10 }, cooldown: 20, anim: 'cast_ground', role: 'utility', radius: 16, tags: ['sense'],
    ops: [special('detect_ores', 1, 16), self('ore_sense', 1, 30)],
  }),
  P('prospector', 'Prospector', 'mining', '🪙', 'Hauling stone builds a strong back.', { carry: 30, maxStamina: 10 }, 'crafting'),
  A('excavate', 'Excavate', 'mining', 'aim', {
    icon: '🕳', description: 'Drive a short tunnel with a flurry of pick blows. Yields the material.', cost: { stamina: 35 }, cooldown: 10, castTime: 0.8, range: 5, anim: 'mine', role: 'crafting', tags: ['terrain'],
    ops: [{ op: 'terrain', shape: 'bore', edit: 'dig', radius: 1.1, length: 4, yields: true }],
  }),

  // =================================================================== WOODCUTTING
  A('lumberjack_chop', 'Lumberjack Chop', 'woodcutting', 'aim', {
    icon: '🪓', description: 'A practiced chop that bites deep into trees.', cost: { stamina: 18 }, cooldown: 2.5, range: 3.5, anim: 'chop', role: 'crafting',
    ops: [{ op: 'cone', range: 3.5, angle: 50, objects: { amount: 70, kind: 'chop' }, fx: 'wood_chips', who: 'hostile', damage: 6, type: 'slash' }],
  }),
  A('felling_strike', 'Felling Strike', 'woodcutting', 'aim', {
    icon: '🌲', description: 'A mighty swing that can fell a tree in one or two blows.', cost: { stamina: 30 }, cooldown: 10, range: 3.5, anim: 'chop', role: 'crafting',
    ops: [{ op: 'cone', range: 3.5, angle: 30, objects: { amount: 220, kind: 'chop' }, fx: 'wood_chips' }],
  }),
  P('woodsman', 'Woodsman', 'woodcutting', '🪵', 'Hardened by the forest.', { carry: 20, 'damage.slash': 0.05 }, 'crafting'),
  P('splitter', 'Splitter', 'woodcutting', '🔪', 'Rhythmic swings.', { attackSpeed: 0.05, maxStamina: 10 }, 'crafting'),

  // =================================================================== HERBALISM
  A('poultice', 'Poultice', 'herbalism', 'self', {
    icon: '🌿', description: 'Pack your wounds with crushed herbs (stronger if you carry herbs).', cost: { stamina: 5 }, cooldown: 15, castTime: 1.2, anim: 'harvest', role: 'utility', tags: ['heal'],
    ops: [special('poultice', 1)],
  }),
  A('antidote', 'Antidote', 'herbalism', 'self', {
    icon: '🧪', description: 'Chew bitter roots that purge poison and disease.', cost: { stamina: 5 }, cooldown: 20, castTime: 0.8, anim: 'eat', role: 'utility', tags: ['heal'],
    ops: [{ op: 'cleanse', to: 'self', max: 3 }, self('regen', 1, 6)],
  }),
  A('toxin_coat', 'Toxin Coat', 'herbalism', 'self', {
    icon: '☠', description: 'Coat your weapon with plant venom.', cost: { stamina: 10 }, cooldown: 45, castTime: 1.5, anim: 'harvest', role: 'crafting', tags: ['poison'],
    ops: [{ op: 'effect', to: 'self', id: 'enchant_poison', magnitude: 3, duration: 60, scale: true }],
  }),
  P('verdant_blood', 'Verdant Blood', 'herbalism', '🍃', 'Years of tasting plants made you resistant.', { 'resist.poison': 0.3, hpRegen: 0.5 }),

  // =================================================================== FORAGING
  A('forage_sense', 'Forager\'s Eye', 'foraging', 'self', {
    icon: '🍄', description: 'Spot useful plants, mushrooms and berries nearby.', cost: { stamina: 5 }, cooldown: 15, anim: 'gesture_point', role: 'utility', radius: 35, tags: ['sense'],
    ops: [special('sense_plants', 1, 35), self('forage_sense', 1, 60)],
  }),
  A('scavenge', 'Scavenge', 'foraging', 'self', {
    icon: '🧺', description: 'Search the area for anything useful. Each spot yields only once a day.', cost: { stamina: 10 }, cooldown: 30, castTime: 2.0, anim: 'harvest', role: 'utility', ops: [special('scavenge', 1, 12)],
  }),
  P('keen_nose', 'Keen Nose', 'foraging', '👃', 'Your senses sharpen.', { perception: 10 }),

  // =================================================================== TRACKING
  A('track', 'Track', 'tracking', 'self', {
    icon: '👣', description: 'Read the ground: creatures and people nearby reveal their trails.', cost: { stamina: 5 }, cooldown: 15, anim: 'harvest', role: 'utility', radius: 90, tags: ['sense'],
    ops: [special('track', 1, 90), self('tracking', 1, 60)],
  }),
  A('hunters_mark', 'Hunter\'s Mark', 'tracking', 'entity', {
    icon: '◎', description: 'Mark your prey: it takes extra damage and cannot hide.', cost: { stamina: 5 }, cooldown: 10, range: 40, anim: 'gesture_point', requires: { target: 'any' },
    ops: [tgt('marked', 1, 30), tgt('vulnerable', 0.15, 30), fx('mark', 'target')],
  }),
  P('trailblazer', 'Trailblazer', 'tracking', '🧭', 'Sure-footed on any trail.', { moveSpeed: 0.04, perception: 5 }, 'movement'),
  A('predator_sense', 'Predator Sense', 'tracking', 'self', {
    icon: '🦅', description: 'Sense every hostile presence nearby and steady your aim.', cost: { stamina: 10 }, cooldown: 30, anim: 'gesture_point', role: 'utility', radius: 60, tags: ['sense'],
    ops: [special('sense_hostiles', 1, 60), self('focus', 1, 20)],
  }),

  // =================================================================== SURVIVAL
  A('make_camp', 'Make Camp', 'survival', 'ground', {
    icon: '🏕', description: 'Build a campfire: warmth, light and regeneration for everyone nearby.', cost: { stamina: 10 }, cooldown: 120, castTime: 3.0, range: 4, radius: 4, anim: 'work_hammer', role: 'utility', tags: ['fire', 'zone'],
    ops: [{ op: 'zone', kind: 'campfire', radius: 4, duration: 240, tick: 2, max: 1, light: [1, 0.55, 0.22], lightIntensity: 7, ops: [{ op: 'area', radius: 0, who: 'ally', effect: eff('warmth', 1, 5) }] }],
  }),
  P('endure_elements', 'Endure Elements', 'survival', '🌡', 'Hardened against heat and cold.', { 'resist.frost': 0.1, 'resist.fire': 0.1 }, 'defense'),
  A('bandage', 'Bandage', 'survival', 'self', {
    icon: '🩹', description: 'Bind your wounds: stops bleeding and heals over time.', cost: { stamina: 5 }, cooldown: 20, castTime: 1.5, anim: 'harvest', role: 'utility', tags: ['heal'], ops: [special('bandage', 1)],
  }),
  P('weathered', 'Weathered', 'survival', '🪖', 'Tough as old leather.', { hpRegen: 0.5, maxHp: 15 }, 'defense'),

  // =================================================================== LORE
  A('recall_lore', 'Recall Lore', 'lore', 'entity', {
    icon: '📖', description: 'Remember what you know about a creature or person: strengths and weaknesses.', cost: {}, cooldown: 4, range: 40, anim: 'gesture_point', role: 'utility', requires: { target: 'any' },
    ops: [special('lore', 1)],
  }),
  P('scholar', 'Scholar', 'lore', '🎓', 'A trained mind.', { maxMana: 10, manaRegen: 0.3 }),
  P('ancient_tongue', 'Ancient Tongue', 'lore', '🗿', 'You read the old scripts.', { 'skill.persuasion': 5, 'skill.runecraft': 5 }, 'social'),
  P('arcane_insight', 'Arcane Insight', 'lore', '🔮', 'Deep understanding of magic.', { spellPower: 0.08 }),

  // =================================================================== COOKING
  A('quick_meal', 'Quick Meal', 'cooking', 'self', {
    icon: '🍖', description: 'Eat the best food in your pack, cooked over a pocket flame: heals and leaves you well fed.', cost: {}, cooldown: 5, castTime: 1.5, anim: 'eat', role: 'utility', ops: [special('eat', 1)],
  }),
  P('hearty_cook', 'Hearty Cook', 'cooking', '🍲', 'You eat well.', { hpRegen: 0.3, maxHp: 10 }),
  A('feast', 'Feast', 'cooking', 'aura', {
    icon: '🍗', description: 'Share a meal (uses one food item): everyone nearby is healed and well fed.', cost: { stamina: 10 }, cooldown: 120, castTime: 3.0, anim: 'eat', role: 'social', radius: 6, ops: [special('feast', 1, 6)],
  }),

  // =================================================================== SMITHING
  A('field_repair', 'Field Repair', 'smithing', 'self', {
    icon: '🔧', description: 'Hammer out dents and restore durability of your equipped gear.', cost: { stamina: 10 }, cooldown: 60, castTime: 2.5, anim: 'work_hammer', role: 'crafting', ops: [special('repair', 1)],
  }),
  A('sharpen', 'Sharpen', 'smithing', 'self', {
    icon: '◢', description: 'Hone your weapon: more damage and crits for five minutes.', cost: { stamina: 5 }, cooldown: 60, castTime: 2.0, anim: 'work_saw', role: 'crafting', ops: [self('sharpened', 1, 300)],
  }),
  A('temper_armor', 'Temper Armor', 'smithing', 'self', {
    icon: '🛠', description: 'Re-seat straps and rivets: your armor protects better for a while.', cost: { stamina: 10 }, cooldown: 120, castTime: 3.0, anim: 'work_hammer', role: 'crafting', ops: [self('fortified', 0.6, 300)],
  }),
  P('masterwork', 'Masterwork', 'smithing', '⚙', 'You keep your gear in perfect condition.', { armor: 5, critChance: 0.03 }, 'crafting'),

  // =================================================================== ALCHEMY
  A('volatile_flask', 'Volatile Flask', 'alchemy', 'aim', {
    icon: '⚗', description: 'Lob a flask of alchemist\'s fire.', cost: { stamina: 8 }, cooldown: 5, anim: 'throw', range: 25, radius: 2.5, tags: ['fire'],
    ops: [{ op: 'projectile', fx: 'flask', speed: 18, gravity: 1, radius: 0.1, arc: true, onHit: [{ op: 'area', radius: 2.5, damage: 14, type: 'fire', effect: eff('burning', 3, 4), objects: { amount: 20, kind: 'fire' } }, fx('flask_fire', 'point', 2.5)] }],
  }),
  A('toxic_cloud', 'Toxic Cloud', 'alchemy', 'aim', {
    icon: '☁', description: 'A flask that bursts into a lingering poison cloud.', cost: { stamina: 10 }, cooldown: 15, anim: 'throw', range: 25, radius: 3.5, tags: ['poison', 'zone'],
    ops: [{ op: 'projectile', fx: 'flask_green', speed: 18, gravity: 1, radius: 0.1, arc: true, onHit: [{ op: 'zone', kind: 'toxic', radius: 3.5, duration: 8, tick: 0.5, ops: [{ op: 'area', radius: 0, who: 'all', damage: 2, type: 'poison', effect: eff('poisoned', 2, 4) }] }] }],
  }),
  P('elixir_mastery', 'Elixir Mastery', 'alchemy', '🧴', 'Your body is used to potions.', { hpRegen: 0.5, manaRegen: 0.5, 'resist.poison': 0.15 }),
  A('transmute', 'Transmute', 'alchemy', 'self', {
    icon: '⚜', description: 'Transmute raw materials into rarer ones (iron ore → gold ore, stone → salt, clay → crystal shard).', cost: { mana: 40 }, cooldown: 120, castTime: 3.0, anim: 'channel', role: 'crafting', ops: [special('transmute', 1)],
  }),

  // =================================================================== TAILORING
  A('patch_up', 'Patch Up', 'tailoring', 'self', {
    icon: '🪡', description: 'Stitch tears in your clothing and leather.', cost: { stamina: 5 }, cooldown: 60, castTime: 2.5, anim: 'harvest', role: 'crafting', ops: [special('repair_cloth', 1)],
  }),
  P('insulated_layers', 'Insulated Layers', 'tailoring', '🧣', 'Clever layering against the elements.', { 'resist.frost': 0.15, 'resist.fire': 0.05 }, 'defense'),
  A('cloak_glide', 'Cloak Glide', 'tailoring', 'self', {
    icon: '🦇', description: 'Rig your cloak as a wing and glide for a while.', cost: { stamina: 10 }, cooldown: 20, anim: '', role: 'movement', tags: ['movement'], ops: [self('glide', 1, 15)],
  }),
  P('silkweave', 'Silkweave', 'tailoring', '🕸', 'Garments that move with you.', { dodge: 0.03, stealth: 5 }, 'defense'),

  // =================================================================== ENCHANTING
  A('arcane_sight', 'Arcane Sight', 'enchanting', 'self', {
    icon: '🔮', description: 'See the flow of magic: invisible creatures and illusions nearby are exposed.', cost: { mana: 10 }, cooldown: 15, anim: 'cast_self', role: 'utility', radius: 20, tags: ['sense'],
    ops: [special('arcane_sight', 1, 20)],
  }),
  A('empower', 'Empower', 'enchanting', 'self', {
    icon: '✦', description: 'Charge yourself with raw magic: spells hit much harder.', cost: { mana: 20 }, cooldown: 40, anim: 'cast_self', role: 'utility', ops: [self('empowered', 1, 20)],
  }),
  A('imbue_armor', 'Imbue Armor', 'enchanting', 'self', {
    icon: '🔰', description: 'Weave protective enchantments into your armor.', cost: { mana: 30 }, cooldown: 90, castTime: 1.5, anim: 'cast_self', role: 'defense', ops: [self('ward', 1, 120)],
  }),
  P('mana_well', 'Mana Well', 'enchanting', '🌊', 'A deep reservoir of mana.', { maxMana: 30, manaRegen: 0.5 }),

  // =================================================================== PERSUASION
  A('persuade', 'Persuade', 'persuasion', 'entity', {
    icon: '💬', description: 'Win someone over with reasoned words. Improves their disposition.', cost: {}, cooldown: 30, range: 6, anim: 'talk', role: 'social', requires: { target: 'npc' },
    ops: [special('persuade', 1)],
  }),
  A('inspire', 'Inspire', 'persuasion', 'aura', {
    icon: '♪', description: 'A rousing speech: you and nearby allies fight and work better.', cost: { stamina: 15 }, cooldown: 60, anim: 'cheer', role: 'social', radius: 10,
    ops: [{ op: 'area', radius: 10, at: 'self', who: 'ally', effect: eff('inspired', 1, 30) }, self('inspired', 1, 30), fx('rally', 'self', 10)],
  }),
  P('silver_tongue', 'Silver Tongue', 'persuasion', '🗣', 'Charming and convincing.', { barter: 0.05, 'skill.barter': 5 }, 'social'),
  A('pacify', 'Pacify', 'persuasion', 'entity', {
    icon: '🕊', description: 'Talk down an angry person: they stop fighting you.', cost: { stamina: 10 }, cooldown: 45, castTime: 1.0, range: 10, anim: 'gesture_shrug', role: 'social', requires: { target: 'npc' },
    ops: [special('pacify', 1)],
  }),

  // =================================================================== INTIMIDATION
  A('intimidate', 'Intimidate', 'intimidation', 'entity', {
    icon: '😠', description: 'Threaten someone. People grow wary; weak beasts flee.', cost: {}, cooldown: 20, range: 8, anim: 'gesture_point', role: 'social', requires: { target: 'any' },
    ops: [special('intimidate', 1)],
  }),
  A('war_cry', 'War Cry', 'intimidation', 'aura', {
    icon: '📢', description: 'A terrifying roar: enemies are weakened, you are fearless.', cost: { stamina: 20 }, cooldown: 40, anim: 'cheer', radius: 9,
    ops: [{ op: 'area', radius: 9, at: 'self', who: 'hostile', effect: eff('weakened', 1, 8) }, self('courage', 1, 12), fx('roar', 'self', 9)],
  }),
  P('menacing_presence', 'Menacing Presence', 'intimidation', '👹', 'People step aside for you.', { 'skill.intimidation': 5, armor: 3 }, 'social'),
  A('demoralize', 'Demoralize', 'intimidation', 'cone', {
    icon: '💀', description: 'Break the will of enemies in front of you; the weak flee.', cost: { stamina: 25 }, cooldown: 35, anim: 'gesture_point', range: 10,
    ops: [{ op: 'cone', range: 10, angle: 70, effect: eff('weakened', 1.5, 10), who: 'hostile' }, { op: 'cone', range: 10, angle: 70, effect: eff('feared', 1, 3, 0.5), who: 'hostile', fx: 'roar_cone' }],
  }),

  // =================================================================== BARTER
  A('appraise', 'Appraise', 'barter', 'entity', {
    icon: '⚖', description: 'Judge the worth of an item, or of what someone carries.', cost: {}, cooldown: 2, range: 10, anim: 'gesture_point', role: 'social', requires: { target: 'any' },
    ops: [special('appraise', 1)],
  }),
  P('haggler', 'Haggler', 'barter', '🤝', 'You always get a little more.', { barter: 0.05 }, 'social'),
  P('merchants_eye', 'Merchant\'s Eye', 'barter', '🧮', 'Efficient packing and sharp pricing.', { barter: 0.05, carry: 20 }, 'social'),
  A('smooth_deal', 'Smooth Deal', 'barter', 'self', {
    icon: '💰', description: 'Put on your best trading face: better prices and persuasion for two minutes.', cost: {}, cooldown: 300, anim: 'gesture_wave', role: 'social', ops: [self('persuasive', 1, 120)],
  }),
];

// ------------------------------------------------------------------ derived display data

/** First damage number found in a recipe (for tooltips) — fills `def.damage` when not set. */
function firstDamage(ops: AbilityOp[] | undefined): AbilityDef['damage'] | undefined {
  if (!ops) return;
  for (const o of ops) {
    if ((o.op === 'area' || o.op === 'cone' || o.op === 'beam') && o.damage) return { amount: o.damage, type: o.type ?? 'force' };
    if (o.op === 'projectile' && o.damage && !o.useWeapon) return { amount: o.damage, type: o.type ?? 'pierce' };
    if (o.op === 'projectile' && o.onHit) {
      const d = firstDamage(o.onHit);
      if (d) return d;
    }
    if (o.op === 'delay' || o.op === 'zone') {
      const d = firstDamage(o.ops);
      if (d) return d;
    }
  }
  return;
}

for (const a of ABILITIES) {
  if (!a.damage) {
    const d = firstDamage(a.ops);
    if (d) a.damage = d;
  }
}
