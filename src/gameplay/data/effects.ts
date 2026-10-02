/**
 * Status effect catalog (shared by server, UI and FX).
 *
 * Effects are the single mechanism for buffs, debuffs, damage/heal over time,
 * movement modifiers (read by the client player controller via
 * MOVEMENT_EFFECTS), crowd control (read by NPC/creature AI via
 * `isIncapacitated`/`hasEffect`), and aura visuals (fx tags).
 *
 * `mods` scale with the effect magnitude (1.0 = nominal), `flat` do not.
 */
import { EntFlag } from '../../shared/types';
import type { EffectDef } from '../types';

const E = (id: string, name: string, kind: EffectDef['kind'], icon: string, description: string, o: Partial<EffectDef> = {}): EffectDef => ({
  id, name, kind, icon, description, stack: 'refresh', ...o,
});

export const EFFECTS: EffectDef[] = [
  // ---------------------------------------------------------------- movement (controller understands these ids)
  E('haste', 'Haste', 'buff', '»', 'Moving faster.', { mods: { moveSpeed: 0.3 }, movement: true, fx: 'haste', stack: 'max' }),
  E('slow', 'Slowed', 'debuff', '«', 'Moving slower.', { mods: { moveSpeed: -0.3, attackSpeed: -0.15 }, movement: true, fx: 'slow', stack: 'max', preventedBy: ['unstoppable'] }),
  E('root', 'Rooted', 'debuff', '⚓', 'Cannot move, but can still fight and cast.', { movement: true, fx: 'roots', preventedBy: ['unstoppable'] }),
  E('stun', 'Stunned', 'debuff', '✷', 'Cannot move or act.', { movement: true, incapacitate: true, fx: 'stun', preventedBy: ['unstoppable'] }),
  // Marker for a following light orb (the orb itself is a zone): shows it with its countdown.
  E('light_orb', 'Light Orb', 'buff', '💡', 'A floating orb of light follows you and lights your way.', {}),
  E('featherfall', 'Featherfall', 'buff', '🪶', 'Falling gently; no fall damage.', { movement: true, gravityMul: 0.35, flat: { fallResist: 1 }, fx: 'feather' }),
  E('levitate', 'Levitating', 'buff', '☁', 'Floating above the ground.', { movement: true, gravityMul: 0.05, flags: EntFlag.Levitating, flat: { fallResist: 1 }, fx: 'levitate' }),
  E('waterwalk', 'Waterwalking', 'buff', '≈', 'Water bears your weight.', { movement: true, fx: 'frostfeet' }),
  E('gravity_low', 'Lightened', 'buff', '◌', 'Gravity barely holds you: higher jumps, softer landings.', { movement: true, gravityMul: 0.45, mods: { jump: 0.5, fallResist: 0.5 }, fx: 'gravlow' }),
  E('gravity_high', 'Crushed', 'debuff', '●', 'Crushing gravity: slow, heavy and grounded.', { movement: true, gravityMul: 2.2, mods: { moveSpeed: -0.35, jump: -0.5 }, fx: 'gravhigh', preventedBy: ['unstoppable'] }),
  E('climb_boost', 'Sure Grip', 'buff', '⛰', 'Climbing is fast and cheap.', { movement: true, fx: 'grip' }),
  E('swim_boost', 'Swift Stroke', 'buff', '🌊', 'Swimming fast.', { movement: true, fx: 'water' }),
  E('leap_boost', 'Coiled Legs', 'buff', '⤒', 'The next jumps go much higher.', { movement: true, mods: { jump: 0.6 }, fx: 'leap' }),
  E('glide', 'Gliding', 'buff', '🪂', 'Hold jump while falling to glide.', { movement: true, gravityMul: 0.6, flat: { fallResist: 0.6 }, fx: 'glide' }),
  E('phase', 'Phased', 'buff', '◇', 'Partly out of the world: pass through creatures, attacks may miss.', { movement: true, flat: { dodge: 0.5 }, fx: 'phase' }),

  // ---------------------------------------------------------------- damage / heal over time
  E('burning', 'Burning', 'debuff', '🔥', 'Taking fire damage over time.', { dot: 'fire', flags: EntFlag.Burning, fx: 'burning', stack: 'max', removes: ['frozen', 'chilled', 'wet'] }),
  E('poisoned', 'Poisoned', 'debuff', '☠', 'Taking poison damage over time; weaker regeneration.', { dot: 'poison', mods: { hpRegen: -1 }, fx: 'poison', stack: 'stack', maxStacks: 5 }),
  E('bleeding', 'Bleeding', 'debuff', '🩸', 'Losing blood.', { dot: 'slash', fx: 'bleed', stack: 'stack', maxStacks: 5 }),
  E('shocked', 'Shocked', 'debuff', '⚡', 'Twitching from current; actions are slower.', { dot: 'shock', mods: { attackSpeed: -0.2, castSpeed: -0.2 }, fx: 'shock' }),
  E('decay', 'Withering', 'debuff', '☾', 'Shadow eats at your life force.', { dot: 'shadow', mods: { hpRegen: -2 }, fx: 'shadow' }),
  E('regen', 'Regenerating', 'buff', '✚', 'Healing over time.', { hot: true, fx: 'regen', stack: 'max' }),
  E('mana_flow', 'Mana Flow', 'buff', '✧', 'Mana returns quickly.', { mot: true, fx: 'mana' }),

  // ---------------------------------------------------------------- elemental states
  E('chilled', 'Chilled', 'debuff', '❄', 'Cold slows the limbs.', { mods: { moveSpeed: -0.2, attackSpeed: -0.15 }, movement: false, fx: 'chill', removes: ['burning'] }),
  E('frozen', 'Frozen', 'debuff', '🧊', 'Encased in ice.', { incapacitate: true, flags: EntFlag.Frozen, mods: { 'resist.blunt': -0.4 }, fx: 'frozen', removes: ['burning'], preventedBy: ['unstoppable'] }),
  E('wet', 'Soaked', 'neutral', '💧', 'Wet: resists fire, vulnerable to frost and shock.', { mods: { 'resist.fire': 0.3, 'resist.frost': -0.25, 'resist.shock': -0.25 }, fx: 'wet', removes: ['burning'] }),

  // ---------------------------------------------------------------- crowd control (AI reads these)
  E('blinded', 'Blinded', 'debuff', '◉', 'Cannot see: perception collapses, attacks often miss.', { mods: { perception: -40, critChance: -0.2 }, flat: { dodge: -0.1 }, fx: 'blind' }),
  E('feared', 'Terrified', 'debuff', '😱', 'Flees from the source of fear.', { fx: 'fear', breakOnDamage: false, preventedBy: ['unstoppable', 'courage'] }),
  E('calmed', 'Calmed', 'debuff', '☮', 'Pacified; will not start a fight.', { fx: 'calm', breakOnDamage: true }),
  E('charmed', 'Charmed', 'debuff', '♥', 'Regards the charmer as a friend.', { fx: 'charm', breakOnDamage: true }),
  E('asleep', 'Asleep', 'debuff', 'z', 'Sound asleep.', { incapacitate: true, flags: EntFlag.Sleeping, fx: 'sleep', breakOnDamage: true }),
  E('silenced', 'Silenced', 'debuff', '🔇', 'Cannot cast spells.', { silence: true, fx: 'silence' }),
  E('staggered', 'Staggered', 'debuff', '≋', 'Off balance: open to attacks.', { mods: { 'resist.slash': -0.2, 'resist.pierce': -0.2, 'resist.blunt': -0.2, moveSpeed: -0.3 }, fx: 'stagger' }),
  E('distracted', 'Distracted', 'debuff', '?', 'Attention drawn elsewhere; perception reduced.', { mods: { perception: -25 }, fx: 'distract' }),
  E('taunted', 'Taunted', 'debuff', '!', 'Compelled to attack the taunter.', { fx: 'taunt' }),
  E('marked', 'Hunter\'s Mark', 'debuff', '◎', 'Marked prey: takes extra damage and cannot hide.', { mods: { stealth: -50 }, fx: 'marked' }),
  E('vulnerable', 'Vulnerable', 'debuff', '⚠', 'Takes more damage from every source.', { fx: 'vulnerable', stack: 'max' }),
  E('weakened', 'Weakened', 'debuff', '↓', 'Deals less damage.', { mods: { 'damage.slash': -0.25, 'damage.pierce': -0.25, 'damage.blunt': -0.25, spellPower: -0.2 }, fx: 'weak' }),
  E('exposed', 'Exposed', 'debuff', '☼', 'Revealed by light; cannot be invisible.', { mods: { stealth: -80 }, fx: 'exposed', removes: ['invisible', 'shadow_cloak'] }),

  // ---------------------------------------------------------------- defensive buffs
  E('force_shield', 'Force Shield', 'buff', '⛉', 'An invisible barrier absorbs damage (magnitude = absorb pool).', { fx: 'shield', stack: 'max' }),
  E('stoneskin', 'Stoneskin', 'buff', '🪨', 'Skin hard as granite.', { mods: { armor: 25, moveSpeed: -0.08, 'resist.slash': 0.1, 'resist.pierce': 0.15 }, fx: 'stone' }),
  E('fortified', 'Fortified', 'buff', '⛨', 'Braced: much higher armor.', { mods: { armor: 20 }, fx: 'fortify' }),
  E('ward', 'Warded', 'buff', '✡', 'Runes deflect hostile magic.', { mods: { 'resist.fire': 0.2, 'resist.frost': 0.2, 'resist.shock': 0.2, 'resist.shadow': 0.2, 'resist.radiant': 0.2, 'resist.psychic': 0.2 }, fx: 'ward' }),
  E('reflect', 'Reflecting', 'buff', '⟲', 'Projectiles bounce back to their sender.', { fx: 'reflect' }),
  E('blocking', 'Blocking', 'neutral', '🛡', 'Raised guard.', { mods: { moveSpeed: -0.35 } }),
  E('parry', 'Parry Window', 'buff', '⚔', 'A perfectly timed parry.', {}),
  E('riposte', 'Riposte Ready', 'buff', '↺', 'Your next strike punishes the parried foe.', { fx: 'riposte' }),
  E('evasive', 'Evasive', 'buff', '↯', 'Hard to hit.', { flat: { dodge: 0.35 }, fx: 'evasive' }),
  E('unstoppable', 'Unstoppable', 'buff', '➤', 'Immune to slows, roots, stuns and knockdowns.', { fx: 'unstoppable', removes: ['slow', 'root', 'stun', 'frozen', 'gravity_high', 'staggered'] }),
  E('flame_cloak', 'Flame Cloak', 'buff', '♨', 'Wreathed in fire: burns melee attackers, resists cold.', { mods: { 'resist.frost': 0.35, 'resist.fire': 0.2 }, fx: 'flamecloak', removes: ['chilled', 'frozen', 'wet'] }),
  E('frost_armor', 'Frost Armor', 'buff', '❆', 'Ice plates chill attackers.', { mods: { armor: 15, 'resist.fire': 0.15 }, fx: 'frostarmor' }),
  E('thorns', 'Thorns', 'buff', '❦', 'Barbed bark wounds melee attackers.', { fx: 'thorns' }),
  E('courage', 'Courage', 'buff', '♚', 'Immune to fear.', { removes: ['feared'], fx: 'courage' }),
  E('halo', 'Halo', 'buff', '◯', 'Radiant protection against shadow; sheds light.', { mods: { 'resist.shadow': 0.4, 'resist.radiant': 0.2, lightRadius: 6 }, flags: EntFlag.Glowing, fx: 'halo' }),

  // ---------------------------------------------------------------- offensive buffs
  E('enchant_fire', 'Flame Weapon', 'buff', '🔥', 'Weapon strikes deal extra fire damage and may ignite.', { fx: 'ench_fire' }),
  E('enchant_frost', 'Frost Weapon', 'buff', '❄', 'Weapon strikes deal extra frost damage and chill.', { fx: 'ench_frost' }),
  E('enchant_shock', 'Storm Weapon', 'buff', '⚡', 'Weapon strikes deal extra shock damage.', { fx: 'ench_shock' }),
  E('enchant_radiant', 'Blessed Weapon', 'buff', '☀', 'Weapon strikes deal extra radiant damage.', { fx: 'ench_radiant' }),
  E('enchant_poison', 'Envenomed', 'buff', '☠', 'Weapon strikes poison.', { fx: 'ench_poison' }),
  E('sharpened', 'Honed Edge', 'buff', '◢', 'A freshly sharpened weapon.', { mods: { 'damage.slash': 0.15, 'damage.pierce': 0.15, critChance: 0.05 } }),
  E('berserk', 'Berserk', 'buff', '☄', 'Furious: more damage and speed, less defense.', { mods: { 'damage.slash': 0.3, 'damage.blunt': 0.3, 'damage.pierce': 0.3, attackSpeed: 0.25, armor: -15 }, fx: 'rage', preventedBy: [] }),
  E('focus', 'Battle Focus', 'buff', '◎', 'Steady aim and keen strikes.', { mods: { critChance: 0.15, perception: 10 }, fx: 'focus' }),
  E('empowered', 'Empowered', 'buff', '✦', 'Spells hit harder.', { mods: { spellPower: 0.3 }, fx: 'empower' }),
  E('inspired', 'Inspired', 'buff', '♪', 'Rousing words: better at everything.', { mods: { 'damage.slash': 0.1, 'damage.blunt': 0.1, 'damage.pierce': 0.1, spellPower: 0.1, staminaRegen: 4 }, fx: 'inspire' }),
  E('second_wind', 'Second Wind', 'buff', '↻', 'Stamina floods back.', { mods: { staminaRegen: 25 }, fx: 'wind' }),
  E('wolf_spirit', 'Wolf Spirit', 'buff', '🐺', 'The pack runs with you.', { mods: { moveSpeed: 0.2, perception: 20, 'damage.slash': 0.1, 'damage.pierce': 0.1 }, fx: 'spirit' }),

  // ---------------------------------------------------------------- stealth & senses
  E('invisible', 'Invisible', 'buff', '◌', 'Unseen until you strike.', { flags: EntFlag.Invisible, mods: { stealth: 80 }, fx: 'invis', breakOnAction: true }),
  E('shadow_cloak', 'Shadow Cloak', 'buff', '☽', 'Wrapped in shadow; draining mana.', { flags: EntFlag.Invisible, mods: { stealth: 60, moveSpeed: -0.1 }, fx: 'shadowcloak', breakOnAction: true }),
  E('sneak_boost', 'Light Feet', 'buff', '👣', 'Silent movement.', { mods: { stealth: 25 } }),
  E('darkvision', 'Umbral Sight', 'buff', '👁', 'See in darkness.', { mods: { perception: 20, lightRadius: 10 } }),
  E('beast_sense', 'Beast Sense', 'buff', '🐾', 'You feel nearby animals.', { mods: { perception: 15 } }),
  E('ore_sense', 'Ore Sense', 'buff', '⛏', 'Ore veins whisper to you.', {}),
  E('forage_sense', 'Forager\'s Eye', 'buff', '🌿', 'Useful plants stand out.', { mods: { perception: 5 } }),
  E('tracking', 'Tracking', 'buff', '⇢', 'Following trails.', { mods: { perception: 20, moveSpeed: 0.05 } }),
  E('lockpicking', 'Deft Hands', 'buff', '🔓', 'Steady hands for locks and pockets.', {}),
  E('persuasive', 'Silver Tongue', 'buff', '💬', 'Words come easily.', { mods: { 'skill.persuasion': 15, 'skill.barter': 10 } }),
  E('menacing', 'Menacing', 'buff', '😠', 'You radiate threat.', { mods: { 'skill.intimidation': 15 } }),
  E('glowing', 'Glowing', 'neutral', '✺', 'Shedding light.', { flags: EntFlag.Glowing, mods: { lightRadius: 8 }, fx: 'glow' }),

  // ---------------------------------------------------------------- well-being
  E('well_fed', 'Well Fed', 'buff', '🍖', 'A good meal: better regeneration and stamina.', { mods: { hpRegen: 0.5, staminaRegen: 3, maxStamina: 10 } }),
  E('warmth', 'Warmth', 'buff', '♨', 'Warm by the fire: regenerating, resisting cold.', { mods: { hpRegen: 1.5, 'resist.frost': 0.3 }, fx: 'warm' }),
  E('exhausted', 'Exhausted', 'debuff', '…', 'Out of breath.', { mods: { staminaRegen: -6, moveSpeed: -0.1 } }),
  E('tamed_bond', 'Bonded', 'neutral', '❤', 'Bound to a master.', { fx: 'bond' }),

  // ---------------------------------------------------------------- consumables (items system; magnitudes as the item data uses them)
  E('poison', 'Poisoned', 'debuff', '☠', 'Venom in the blood (damage per second = magnitude).', { dot: 'poison', mods: { hpRegen: -0.5 }, fx: 'poison', stack: 'max' }),
  E('water_breathing', 'Water Breathing', 'buff', '🫧', 'You can breathe underwater.', { mods: { maxStamina: 10 }, fx: 'water' }),
  E('strength', 'Strength', 'buff', '💪', 'Thickened muscle: physical damage and carry weight (magnitude = fraction).', {
    mods: { 'damage.slash': 1, 'damage.pierce': 1, 'damage.blunt': 1, carry: 100 },
  }),
  E('fortitude', 'Fortitude', 'buff', '🛡', 'Hardy as old leather (magnitude = bonus health).', { mods: { maxHp: 1, 'resist.poison': 0.004 } }),
  E('clarity', 'Clarity', 'buff', '💠', 'A clear mind: spell power and mana regeneration (magnitude = fraction).', { mods: { spellPower: 1, manaRegen: 5, castSpeed: 0.5 } }),
  E('luck', 'Fortune', 'buff', '🍀', 'Things just go your way.', { mods: { critChance: 0.05, barter: 0.05, dodge: 0.03 } }),
  E('fortify_armor', 'Fortified Armor', 'buff', '⛨', 'A skin of force (magnitude = armor).', { mods: { armor: 1 }, fx: 'fortify' }),
  E('reveal', 'Revealing', 'buff', '👁', 'Hidden things shine faintly (magnitude = meters).', { mods: { perception: 1 } }),
  E('clumsy', 'Clumsy', 'debuff', '🍺', 'A little unsteady.', { mods: { dodge: -0.05, attackSpeed: -0.08, stealth: -10 } }),
  E('light', 'Light', 'neutral', '✺', 'Shedding light.', { flags: EntFlag.Glowing, fx: 'glow' }),
  ...(['fire', 'frost', 'shock', 'poison', 'shadow', 'radiant', 'psychic', 'force'] as const).map((t) =>
    E('resist_' + t, `${t.charAt(0).toUpperCase() + t.slice(1)} Ward`, 'buff', '◈', `Resisting ${t} (magnitude = percent).`, { mods: { ['resist.' + t]: 0.01 } }),
  ),
];

/** Alternative effect ids used by other systems → canonical ids. */
export const EFFECT_ALIASES: Record<string, string> = {
  regen_hp: 'regen', invisibility: 'invisible', night_vision: 'darkvision', regen_mana: 'mana_flow', poisoned_weak: 'poison',
};

export function canonicalEffect(id: string): string {
  return EFFECT_ALIASES[id] ?? id;
}

const BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

export function effectDef(id: string): EffectDef | undefined {
  return BY_ID.get(id) ?? BY_ID.get(EFFECT_ALIASES[id]);
}
