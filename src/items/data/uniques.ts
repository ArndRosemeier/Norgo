/**
 * Unique items: hand-authored artifacts with fixed names, stats, looks and
 * lore. Only one of each is meant to exist per world; the loot roller picks
 * them very rarely from boss/tomb tables (the ItemSystem tracks which have
 * already dropped).
 *
 * Shared (server + client).
 */
import type { StatMods } from '../types';
import type { RGB } from './materials';

export interface UniqueDef {
  id: string;
  name: string;
  /** Base item def id. */
  base: string;
  material: string;
  style: string;
  quality: number;
  mods: StatMods;
  grants?: string;
  lore: string;
  /** Optional overrides for visuals. */
  primary?: RGB;
  secondary?: RGB;
  accent?: RGB;
  glow?: number;
  glowColor?: RGB;
  /** Minimum loot level before it can drop. */
  minLevel: number;
}

export const UNIQUES: UniqueDef[] = [
  {
    id: 'u_dawnbreaker', name: 'Dawnbreaker', base: 'sword_long', material: 'silver', style: 'human', quality: 0.95, minLevel: 12,
    mods: { 'damage.radiant': 14, 'resist.shadow': 15, lightRadius: 6 }, grants: 'ench.sunburst', glow: 0.7, glowColor: [1, 0.85, 0.5], accent: [0.95, 0.75, 0.3],
    lore: 'Forged at sunrise on the longest day by a smith who had buried three sons to the night-things. The blade has never been sheathed in darkness: it lights the scabbard from within.',
  },
  {
    id: 'u_whisper', name: 'Whisper of Nyx\'ara', base: 'dagger_curved', material: 'darksteel', style: 'umbral', quality: 0.9, minLevel: 10,
    mods: { critChance: 0.15, stealth: 15, 'damage.shadow': 8 }, grants: 'ench.backstab', glow: 0.4, glowColor: [0.5, 0.2, 0.9],
    lore: 'Umbral assassins say the blade was quenched in a sleeping god\'s dream. It makes no sound leaving the sheath — or entering anything else.',
  },
  {
    id: 'u_anvilsong', name: 'Anvilsong', base: 'hammer_war', material: 'adamant', style: 'dwarf', quality: 1, minLevel: 18,
    mods: { 'damage.blunt': 12, 'damage.shock': 8, 'skill.smithing': 15, armor: 6 }, grants: 'ench.thunderclap', glow: 0.35, glowColor: [0.6, 0.75, 1], accent: [0.8, 0.55, 0.25],
    lore: 'The hammer of Thrain Deepdelver, who struck it on the mountain\'s heart to wake the forges. Every blow still rings a note of the old song, and dwarves stop to listen.',
  },
  {
    id: 'u_rootheart', name: 'Rootheart', base: 'staff_antler', material: 'elderwood', style: 'sylvan', quality: 0.95, minLevel: 8,
    mods: { spellPower: 0.25, hpRegen: 1.5, 'skill.herbalism': 12, 'resist.poison': 20 }, grants: 'ench.overgrowth', glow: 0.5, glowColor: [0.5, 1, 0.4],
    lore: 'Sylvan wardens grew this staff for a century inside a living oak. Flowers open along it when it is held by someone kind. They have not opened in a long while.',
  },
  {
    id: 'u_skyreach', name: 'Skyreach', base: 'bow_long', material: 'ghostwood', style: 'elf', quality: 0.95, minLevel: 15,
    mods: { 'damage.frost': 10, critChance: 0.08, perception: 12, 'skill.archery': 10 }, grants: 'ench.seeking_arrow', glow: 0.45, glowColor: [0.7, 0.9, 1],
    lore: 'Strung with a single hair from the tail of a comet — or so the elves claim. Arrows loosed from it leave a thin trail of frost across the sky.',
  },
  {
    id: 'u_gutripper', name: 'Gutripper', base: 'axe_great', material: 'darksteel', style: 'orc', quality: 0.85, minLevel: 12,
    mods: { 'damage.slash': 18, attackSpeed: 0.1, maxHp: 40, 'resist.psychic': -10 }, grants: 'ench.bloodrage', glow: 0.3, glowColor: [0.9, 0.15, 0.1],
    lore: 'Warchief Throk Gutripper carried this axe through nine clan wars and never once cleaned it. The orcs say the axe is hungry. The orcs are right.',
  },
  {
    id: 'u_emberheart', name: 'Emberheart Cuirass', base: 'cuirass_plate', material: 'dragonbone', style: 'drakeborn', quality: 0.95, minLevel: 20,
    mods: { 'resist.fire': 40, maxHp: 60, armor: 10, hpRegen: 0.8 }, glow: 0.4, glowColor: [1, 0.45, 0.15],
    lore: 'Plates carved from the ribcage of Vyraxx the Ashfather by his own drakeborn descendants. The armor is warm, and on cold nights it breathes.',
  },
  {
    id: 'u_moonveil', name: 'Moonveil', base: 'cloak_wool', material: 'moonweave', style: 'elf', quality: 0.95, minLevel: 10,
    mods: { stealth: 20, maxMana: 30, manaRegen: 0.8, moveSpeed: 0.05 }, glow: 0.3, glowColor: [0.6, 0.7, 1],
    lore: 'Woven in a single night by the priestesses of the silver moon. Under moonlight its wearer\'s shadow vanishes entirely.',
  },
  {
    id: 'u_stonegrip', name: 'Gauntlets of the Slow Avalanche', base: 'gauntlets_plate', material: 'iron', style: 'giantkin', quality: 0.9, minLevel: 8,
    mods: { 'skill.unarmed': 15, 'damage.blunt': 8, carry: 40, 'skill.mining': 10 }, accent: [0.5, 0.5, 0.45],
    lore: 'Made for a giantkin quarry-master who could lift a cart with one hand. On a smaller wearer they still remember how.',
  },
  {
    id: 'u_luckpenny', name: 'Pip\'s Unspent Penny', base: 'lucky_coin', material: 'gold', style: 'halfling', quality: 1, minLevel: 1,
    mods: { critChance: 0.05, 'skill.barter': 15, perception: 5, 'skill.speech': 8 },
    lore: 'Pip Burrowguard swore she never spent this penny, and never needed to — something always turned up. Halflings consider it bad manners to ask where it is now.',
  },
  {
    id: 'u_ringofthedeep', name: 'Ring of the Drowned King', base: 'ring_gem', material: 'silver', style: 'human', quality: 0.9, minLevel: 12,
    mods: { 'resist.frost': 20, maxMana: 25, staminaRegen: 1.5 }, grants: 'ench.water_breathing', accent: [0.1, 0.5, 0.7], glow: 0.25, glowColor: [0.3, 0.7, 0.9],
    lore: 'The drowned king of Kel Morrow wore it when the sea took his city. Its wearer can breathe beneath the waves — and sometimes hears bells there.',
  },
  {
    id: 'u_grinbiter', name: 'Snik\'s Grinbiter', base: 'sword_short', material: 'copper', style: 'goblin', quality: 0.6, minLevel: 3,
    mods: { critChance: 0.12, 'damage.poison': 10, stealth: 6, 'skill.barter': -5 }, grants: 'ench.dirty_trick',
    lore: 'A goblin blade notched into a toothy grin. Snik claimed it bit people on its own. Several witnesses agree, though none will say who held it at the time.',
  },
  {
    id: 'u_crownofash', name: 'Crown of Ash', base: 'crown', material: 'darksteel', style: 'drakeborn', quality: 0.95, minLevel: 22,
    mods: { spellPower: 0.2, 'damage.fire': 10, 'resist.fire': 25, 'skill.speech': 10 }, glow: 0.5, glowColor: [1, 0.4, 0.1], accent: [1, 0.3, 0.05],
    lore: 'Worn by the ember-kings of the drakeborn, it smoulders on the brow of anyone with a claim to rule — and burns anyone without one.',
  },
  {
    id: 'u_hollowlantern', name: 'The Hollow Lantern', base: 'lantern', material: 'silver', style: 'umbral', quality: 0.9, minLevel: 6,
    mods: { lightRadius: 10, 'resist.shadow': 20, perception: 10 }, glow: 0.8, glowColor: [0.55, 0.9, 1],
    lore: 'Its flame burns without fuel and casts no warmth. By its light, the invisible are seen, and the dead see you.',
  },
  {
    id: 'u_thornmail', name: 'Thornwarden\'s Harness', base: 'armor_bone', material: 'ironwood', style: 'sylvan', quality: 0.9, minLevel: 14,
    mods: { armor: 12, 'resist.slash': 12, hpRegen: 1, 'resist.poison': 15 }, grants: 'ench.thorns', glow: 0.2, glowColor: [0.5, 0.9, 0.3],
    lore: 'Living ironwood trained over decades into a breastplate. It still grows — slowly — and the thorns along its edges are new each spring.',
  },
  {
    id: 'u_starfall', name: 'Starfall', base: 'staff_crystal', material: 'starmetal', style: 'elf', quality: 1, minLevel: 25,
    mods: { spellPower: 0.4, maxMana: 60, castSpeed: 0.15, 'damage.shock': 10 }, grants: 'ench.starfall', glow: 0.9, glowColor: [0.65, 0.65, 1],
    lore: 'The crystal at its head fell from the sky in the year the elves call the Weeping. Archmages have killed for it. One of them is still looking.',
  },
];

const BY_ID = new Map(UNIQUES.map((u) => [u.id, u]));
export function uniqueDef(id: string) {
  return BY_ID.get(id);
}
