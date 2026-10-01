/**
 * Item materials: what an item instance is *made of*. A material scales
 * damage/armor/weight/value/durability, adds signature stat mods (silver
 * wards against shadow, dragonscale shrugs off fire, mithril is feather
 * light...) and drives the item's colors and PBR shading on the client.
 *
 * Shared (server + client): no three.js here.
 */
import type { MatClass, StatMods } from '../types';

export type RGB = [number, number, number];

export interface MaterialDef {
  id: string;
  /** Adjective used in item names ("Steel Longsword", "Yew Longbow"). */
  name: string;
  cls: MatClass;
  /** Power tier 0..6 — loot picks materials whose tier fits the item level. */
  tier: number;
  /** Base and secondary colors (sRGB 0..1). */
  color: RGB;
  color2: RGB;
  /** Shading family written into ItemVisual.material. */
  family: string;
  roughness: number;
  metalness: number;
  /** Multipliers relative to the class' baseline material. */
  damage: number;
  armor: number;
  weight: number;
  value: number;
  durability: number;
  /** Signature mods applied to weapons (w) and worn items (a). */
  wMods?: StatMods;
  aMods?: StatMods;
  /** Innate glow (crystal, starmetal...). */
  glow?: number;
  glowColor?: RGB;
  /** Rarity weight in random rolls (higher = more common), before tier filtering. */
  weight0: number;
  /** One line of flavour for tooltips. */
  blurb: string;
}

const M = (d: MaterialDef) => d;

export const MATERIALS: MaterialDef[] = [
  // ------------------------------------------------------------- metals
  M({ id: 'copper', name: 'Copper', cls: 'metal', tier: 0, color: [0.72, 0.42, 0.26], color2: [0.42, 0.55, 0.45], family: 'metal', roughness: 0.42, metalness: 1, damage: 0.72, armor: 0.7, weight: 1.05, value: 0.6, durability: 0.6, weight0: 6, blurb: 'Soft and quick to verdigris, but easy to work.' }),
  M({ id: 'bronze', name: 'Bronze', cls: 'metal', tier: 1, color: [0.7, 0.5, 0.25], color2: [0.35, 0.28, 0.16], family: 'metal', roughness: 0.38, metalness: 1, damage: 0.85, armor: 0.85, weight: 1.1, value: 0.8, durability: 0.85, aMods: { 'resist.shock': 2 }, weight0: 8, blurb: 'The old alloy of copper and tin; holds an edge better than one expects.' }),
  M({ id: 'iron', name: 'Iron', cls: 'metal', tier: 1, color: [0.5, 0.5, 0.52], color2: [0.26, 0.25, 0.25], family: 'metal', roughness: 0.55, metalness: 1, damage: 1, armor: 1, weight: 1, value: 1, durability: 1, weight0: 12, blurb: 'Honest bloomery iron. Rusts, bends, endures.' }),
  M({ id: 'steel', name: 'Steel', cls: 'metal', tier: 2, color: [0.66, 0.68, 0.72], color2: [0.3, 0.31, 0.34], family: 'metal', roughness: 0.3, metalness: 1, damage: 1.18, armor: 1.2, weight: 0.97, value: 1.8, durability: 1.35, weight0: 10, blurb: 'Folded and quenched; the backbone of every standing army.' }),
  M({ id: 'silver', name: 'Silver', cls: 'metal', tier: 2, color: [0.85, 0.86, 0.9], color2: [0.45, 0.47, 0.52], family: 'metal', roughness: 0.22, metalness: 1, damage: 0.95, armor: 0.9, weight: 1.15, value: 3.2, durability: 0.8, wMods: { 'damage.radiant': 3 }, aMods: { 'resist.shadow': 6 }, weight0: 4, blurb: 'Bane of the restless dead; the umbral flinch at its shine.' }),
  M({ id: 'gold', name: 'Gold', cls: 'metal', tier: 2, color: [0.95, 0.75, 0.32], color2: [0.6, 0.4, 0.12], family: 'metal', roughness: 0.25, metalness: 1, damage: 0.65, armor: 0.6, weight: 1.6, value: 6, durability: 0.5, aMods: { 'resist.psychic': 4 }, weight0: 2, blurb: 'Too soft for war, perfect for vanity — and for spellwork.' }),
  M({ id: 'darksteel', name: 'Darksteel', cls: 'metal', tier: 3, color: [0.24, 0.25, 0.3], color2: [0.55, 0.12, 0.1], family: 'metal', roughness: 0.35, metalness: 1, damage: 1.35, armor: 1.4, weight: 1.05, value: 3.5, durability: 1.6, wMods: { 'damage.shadow': 2 }, aMods: { 'resist.fire': 3 }, weight0: 5, blurb: 'Smelted in deep forges with coal from the underworld seams.' }),
  M({ id: 'mithril', name: 'Mithril', cls: 'metal', tier: 4, color: [0.8, 0.88, 0.95], color2: [0.45, 0.6, 0.75], family: 'metal', roughness: 0.18, metalness: 1, damage: 1.45, armor: 1.55, weight: 0.5, value: 9, durability: 2, wMods: { attackSpeed: 0.05 }, aMods: { moveSpeed: 0.02, maxMana: 10 }, glow: 0.05, glowColor: [0.6, 0.8, 1], weight0: 2.5, blurb: 'Light as linen, hard as a promise. Sings softly when struck.' }),
  M({ id: 'adamant', name: 'Adamant', cls: 'metal', tier: 5, color: [0.36, 0.48, 0.42], color2: [0.15, 0.22, 0.2], family: 'metal', roughness: 0.28, metalness: 1, damage: 1.7, armor: 1.85, weight: 1.15, value: 14, durability: 3, aMods: { 'resist.force': 5, 'resist.blunt': 4 }, weight0: 1.2, blurb: 'Neither file nor fire marks it. Smiths pass the tongs down for generations.' }),
  M({ id: 'starmetal', name: 'Starmetal', cls: 'metal', tier: 6, color: [0.3, 0.3, 0.42], color2: [0.75, 0.7, 1], family: 'metal', roughness: 0.2, metalness: 1, damage: 1.9, armor: 1.9, weight: 0.85, value: 22, durability: 2.6, wMods: { 'damage.shock': 6, critChance: 0.03 }, aMods: { 'resist.shock': 10, maxMana: 15 }, glow: 0.35, glowColor: [0.55, 0.6, 1], weight0: 0.5, blurb: 'Fell burning from the sky. Faint constellations crawl across its surface.' }),
  M({ id: 'obsidian', name: 'Obsidian', cls: 'stone', tier: 3, color: [0.08, 0.07, 0.1], color2: [0.32, 0.18, 0.4], family: 'glass', roughness: 0.08, metalness: 0.1, damage: 1.4, armor: 0.9, weight: 0.9, value: 2.5, durability: 0.55, wMods: { critChance: 0.05, 'damage.fire': 2 }, weight0: 4, blurb: 'Volcanic glass, knapped to an edge finer than any forge can grind.' }),
  M({ id: 'crystal', name: 'Crystal', cls: 'crystal', tier: 4, color: [0.65, 0.85, 0.95], color2: [0.3, 0.5, 0.9], family: 'crystal', roughness: 0.05, metalness: 0, damage: 1.25, armor: 1.1, weight: 0.8, value: 8, durability: 0.9, wMods: { spellPower: 0.08 }, aMods: { maxMana: 15, manaRegen: 0.3 }, glow: 0.45, glowColor: [0.5, 0.8, 1], weight0: 2, blurb: 'Grown, not forged — in the luminous caverns below the world.' }),
  M({ id: 'flint', name: 'Flint', cls: 'stone', tier: 0, color: [0.4, 0.38, 0.35], color2: [0.25, 0.2, 0.18], family: 'stone', roughness: 0.6, metalness: 0, damage: 0.65, armor: 0.5, weight: 1.1, value: 0.3, durability: 0.4, weight0: 5, blurb: 'Knapped stone lashed to wood: the oldest tool there is.' }),
  M({ id: 'stone', name: 'Stone', cls: 'stone', tier: 0, color: [0.48, 0.46, 0.43], color2: [0.3, 0.29, 0.27], family: 'stone', roughness: 0.85, metalness: 0, damage: 0.7, armor: 0.6, weight: 1.4, value: 0.25, durability: 0.7, weight0: 4, blurb: 'Heavy, crude, effective.' }),

  // ------------------------------------------------------------- organics (hard)
  M({ id: 'bone', name: 'Bone', cls: 'bone', tier: 0, color: [0.86, 0.82, 0.7], color2: [0.55, 0.48, 0.36], family: 'bone', roughness: 0.6, metalness: 0, damage: 0.8, armor: 0.75, weight: 0.8, value: 0.6, durability: 0.7, wMods: { 'damage.shadow': 1 }, weight0: 7, blurb: 'Carved from the great beasts of the wilds.' }),
  M({ id: 'chitin', name: 'Chitin', cls: 'bone', tier: 2, color: [0.25, 0.3, 0.2], color2: [0.55, 0.6, 0.25], family: 'chitin', roughness: 0.3, metalness: 0.05, damage: 1.05, armor: 1.15, weight: 0.65, value: 1.9, durability: 1.1, aMods: { 'resist.poison': 6 }, weight0: 4, blurb: 'Shell of a giant crawler — light, glossy, and faintly iridescent.' }),
  M({ id: 'dragonbone', name: 'Dragonbone', cls: 'bone', tier: 5, color: [0.92, 0.88, 0.76], color2: [0.7, 0.3, 0.15], family: 'bone', roughness: 0.45, metalness: 0, damage: 1.75, armor: 1.7, weight: 0.85, value: 16, durability: 2.4, wMods: { 'damage.fire': 5 }, aMods: { 'resist.fire': 10, maxHp: 15 }, glow: 0.12, glowColor: [1, 0.5, 0.2], weight0: 0.7, blurb: 'Still warm, they say, a hundred years after the wyrm fell.' }),

  // ------------------------------------------------------------- woods
  M({ id: 'pine', name: 'Pine', cls: 'wood', tier: 0, color: [0.72, 0.56, 0.36], color2: [0.45, 0.32, 0.18], family: 'wood', roughness: 0.75, metalness: 0, damage: 0.8, armor: 0.7, weight: 0.85, value: 0.5, durability: 0.7, weight0: 8, blurb: 'Soft, resinous, everywhere.' }),
  M({ id: 'oak', name: 'Oak', cls: 'wood', tier: 1, color: [0.55, 0.4, 0.25], color2: [0.35, 0.24, 0.14], family: 'wood', roughness: 0.7, metalness: 0, damage: 1, armor: 1, weight: 1, value: 1, durability: 1, weight0: 10, blurb: 'Dense and dependable.' }),
  M({ id: 'ash', name: 'Ash', cls: 'wood', tier: 1, color: [0.78, 0.68, 0.52], color2: [0.5, 0.42, 0.3], family: 'wood', roughness: 0.65, metalness: 0, damage: 1.05, armor: 0.95, weight: 0.9, value: 1.2, durability: 1.15, wMods: { attackSpeed: 0.03 }, weight0: 8, blurb: 'Springy and straight-grained: the spear-maker\'s wood.' }),
  M({ id: 'yew', name: 'Yew', cls: 'wood', tier: 2, color: [0.7, 0.42, 0.24], color2: [0.88, 0.75, 0.5], family: 'wood', roughness: 0.55, metalness: 0, damage: 1.2, armor: 1, weight: 0.9, value: 2, durability: 1.2, wMods: { critChance: 0.02 }, weight0: 6, blurb: 'Heartwood and sapwood in one stave — nature\'s own composite.' }),
  M({ id: 'ironwood', name: 'Ironwood', cls: 'wood', tier: 3, color: [0.3, 0.24, 0.2], color2: [0.18, 0.14, 0.12], family: 'wood', roughness: 0.5, metalness: 0.05, damage: 1.4, armor: 1.45, weight: 1.25, value: 3.5, durability: 2, aMods: { 'resist.slash': 3 }, weight0: 4, blurb: 'Sinks in water and blunts axes. Sylvan wardens grow it on purpose.' }),
  M({ id: 'elderwood', name: 'Elderwood', cls: 'wood', tier: 4, color: [0.45, 0.5, 0.35], color2: [0.75, 0.85, 0.5], family: 'wood', roughness: 0.55, metalness: 0, damage: 1.45, armor: 1.3, weight: 0.85, value: 8, durability: 1.8, wMods: { spellPower: 0.1, manaRegen: 0.2 }, aMods: { hpRegen: 0.2 }, glow: 0.15, glowColor: [0.6, 1, 0.5], weight0: 2, blurb: 'Cut, with permission, from trees older than the kingdoms.' }),
  M({ id: 'ghostwood', name: 'Ghostwood', cls: 'wood', tier: 5, color: [0.88, 0.9, 0.92], color2: [0.55, 0.7, 0.8], family: 'wood', roughness: 0.4, metalness: 0, damage: 1.6, armor: 1.4, weight: 0.6, value: 13, durability: 1.9, wMods: { spellPower: 0.15, 'damage.frost': 3 }, aMods: { stealth: 4, 'resist.shadow': 5 }, glow: 0.25, glowColor: [0.7, 0.9, 1], weight0: 0.8, blurb: 'Pale timber from forests that grew in the land of the dead.' }),

  // ------------------------------------------------------------- leathers
  M({ id: 'rawhide', name: 'Rawhide', cls: 'leather', tier: 0, color: [0.62, 0.5, 0.36], color2: [0.4, 0.3, 0.2], family: 'leather', roughness: 0.8, metalness: 0, damage: 0.8, armor: 0.7, weight: 1, value: 0.5, durability: 0.7, weight0: 7, blurb: 'Scraped, dried, still smells of the animal.' }),
  M({ id: 'leather', name: 'Leather', cls: 'leather', tier: 1, color: [0.45, 0.3, 0.18], color2: [0.28, 0.18, 0.1], family: 'leather', roughness: 0.65, metalness: 0, damage: 1, armor: 1, weight: 1, value: 1, durability: 1, weight0: 12, blurb: 'Bark-tanned and oiled.' }),
  M({ id: 'hardleather', name: 'Boiled Leather', cls: 'leather', tier: 2, color: [0.36, 0.22, 0.13], color2: [0.2, 0.12, 0.07], family: 'leather', roughness: 0.5, metalness: 0, damage: 1.1, armor: 1.3, weight: 1.05, value: 1.8, durability: 1.3, weight0: 8, blurb: 'Hardened in hot wax until it turns aside a blade.' }),
  M({ id: 'wyrmhide', name: 'Wyrmhide', cls: 'leather', tier: 4, color: [0.25, 0.35, 0.22], color2: [0.6, 0.5, 0.2], family: 'leather', roughness: 0.4, metalness: 0.05, damage: 1.3, armor: 1.65, weight: 0.95, value: 7, durability: 1.9, aMods: { 'resist.fire': 8, 'resist.poison': 4 }, weight0: 1.5, blurb: 'Pebbled scales still set in the hide.' }),
  M({ id: 'shadowhide', name: 'Shadowhide', cls: 'leather', tier: 5, color: [0.1, 0.09, 0.12], color2: [0.35, 0.25, 0.45], family: 'leather', roughness: 0.55, metalness: 0, damage: 1.35, armor: 1.6, weight: 0.8, value: 12, durability: 1.8, aMods: { stealth: 8, 'resist.shadow': 6 }, weight0: 0.8, blurb: 'Drinks the light. Footsteps in it make no sound.' }),
  M({ id: 'fur', name: 'Fur', cls: 'leather', tier: 1, color: [0.5, 0.42, 0.33], color2: [0.78, 0.72, 0.62], family: 'fur', roughness: 0.95, metalness: 0, damage: 0.9, armor: 0.9, weight: 1.1, value: 1.3, durability: 0.9, aMods: { 'resist.frost': 6 }, weight0: 5, blurb: 'Thick pelts, the hair turned inward against the cold.' }),

  // ------------------------------------------------------------- cloths
  M({ id: 'linen', name: 'Linen', cls: 'cloth', tier: 0, color: [0.86, 0.82, 0.72], color2: [0.62, 0.56, 0.46], family: 'cloth', roughness: 0.9, metalness: 0, damage: 1, armor: 1, weight: 0.9, value: 1, durability: 0.8, weight0: 10, blurb: 'Flax, retted and woven.' }),
  M({ id: 'wool', name: 'Wool', cls: 'cloth', tier: 0, color: [0.62, 0.55, 0.45], color2: [0.4, 0.35, 0.3], family: 'cloth', roughness: 0.95, metalness: 0, damage: 1, armor: 1.1, weight: 1.1, value: 1, durability: 1, aMods: { 'resist.frost': 2 }, weight0: 10, blurb: 'Warm even when wet.' }),
  M({ id: 'cotton', name: 'Cotton', cls: 'cloth', tier: 1, color: [0.92, 0.9, 0.85], color2: [0.7, 0.65, 0.6], family: 'cloth', roughness: 0.88, metalness: 0, damage: 1, armor: 1.05, weight: 0.85, value: 1.4, durability: 0.95, weight0: 6, blurb: 'Soft southern weave, takes dye beautifully.' }),
  M({ id: 'velvet', name: 'Velvet', cls: 'cloth', tier: 2, color: [0.42, 0.08, 0.15], color2: [0.25, 0.04, 0.08], family: 'silk', roughness: 0.75, metalness: 0, damage: 1, armor: 1.05, weight: 1, value: 3.5, durability: 0.9, aMods: { 'skill.barter': 2 }, weight0: 3, blurb: 'Rich pile cloth; doors open for those who wear it.' }),
  M({ id: 'silk', name: 'Silk', cls: 'cloth', tier: 2, color: [0.9, 0.85, 0.75], color2: [0.7, 0.5, 0.3], family: 'silk', roughness: 0.35, metalness: 0, damage: 1, armor: 1.1, weight: 0.6, value: 4, durability: 1.1, aMods: { maxMana: 5 }, weight0: 4, blurb: 'Shimmering, cool, impossibly strong for its weight.' }),
  M({ id: 'spidersilk', name: 'Spidersilk', cls: 'cloth', tier: 3, color: [0.82, 0.85, 0.88], color2: [0.5, 0.55, 0.65], family: 'silk', roughness: 0.3, metalness: 0, damage: 1, armor: 1.5, weight: 0.5, value: 7, durability: 1.6, aMods: { 'resist.poison': 5, stealth: 3 }, weight0: 2, blurb: 'Harvested from the webs of cave weavers — at some risk.' }),
  M({ id: 'moonweave', name: 'Moonweave', cls: 'cloth', tier: 4, color: [0.7, 0.75, 0.95], color2: [0.35, 0.38, 0.7], family: 'silk', roughness: 0.3, metalness: 0, damage: 1, armor: 1.5, weight: 0.5, value: 11, durability: 1.5, aMods: { maxMana: 20, manaRegen: 0.4, spellPower: 0.05 }, glow: 0.2, glowColor: [0.6, 0.7, 1], weight0: 1.2, blurb: 'Spun only under a full moon, from thread that remembers its light.' }),
  M({ id: 'voidcloth', name: 'Voidcloth', cls: 'cloth', tier: 5, color: [0.06, 0.04, 0.1], color2: [0.45, 0.2, 0.7], family: 'silk', roughness: 0.4, metalness: 0, damage: 1, armor: 1.7, weight: 0.45, value: 18, durability: 1.6, aMods: { spellPower: 0.12, 'resist.psychic': 8, maxMana: 25 }, glow: 0.3, glowColor: [0.6, 0.25, 1], weight0: 0.5, blurb: 'Woven by umbral seers from the dark between the stars.' }),

  // ------------------------------------------------------------- misc
  M({ id: 'glass', name: 'Glass', cls: 'glass', tier: 0, color: [0.8, 0.9, 0.88], color2: [0.5, 0.6, 0.6], family: 'glass', roughness: 0.05, metalness: 0, damage: 1, armor: 1, weight: 1, value: 1, durability: 1, weight0: 1, blurb: 'Blown glass.' }),
  M({ id: 'paper', name: 'Paper', cls: 'cloth', tier: 0, color: [0.88, 0.82, 0.66], color2: [0.45, 0.25, 0.15], family: 'cloth', roughness: 0.9, metalness: 0, damage: 1, armor: 1, weight: 1, value: 1, durability: 1, weight0: 0, blurb: 'Vellum and ink.' }),
  M({ id: 'organic', name: '', cls: 'bone', tier: 0, color: [0.6, 0.5, 0.4], color2: [0.4, 0.3, 0.2], family: 'leather', roughness: 0.8, metalness: 0, damage: 1, armor: 1, weight: 1, value: 1, durability: 1, weight0: 0, blurb: '' }),
];

/** Gemstones: set into jewelry, staves, wands and hilts (accent color + signature mods). */
export interface GemDef {
  id: string;
  name: string;
  color: RGB;
  tier: number;
  mods: StatMods;
  value: number;
}

export const GEMS: GemDef[] = [
  { id: 'garnet', name: 'Garnet', color: [0.55, 0.06, 0.1], tier: 0, mods: { maxHp: 8 }, value: 15 },
  { id: 'amethyst', name: 'Amethyst', color: [0.55, 0.3, 0.8], tier: 0, mods: { maxMana: 10 }, value: 18 },
  { id: 'topaz', name: 'Topaz', color: [0.95, 0.7, 0.2], tier: 1, mods: { 'resist.shock': 6 }, value: 25 },
  { id: 'jade', name: 'Jade', color: [0.3, 0.7, 0.45], tier: 1, mods: { hpRegen: 0.3 }, value: 30 },
  { id: 'onyx', name: 'Onyx', color: [0.06, 0.06, 0.07], tier: 1, mods: { stealth: 4 }, value: 28 },
  { id: 'emerald', name: 'Emerald', color: [0.1, 0.75, 0.35], tier: 2, mods: { 'resist.poison': 8, staminaRegen: 0.5 }, value: 60 },
  { id: 'sapphire', name: 'Sapphire', color: [0.12, 0.25, 0.85], tier: 2, mods: { 'resist.frost': 8, manaRegen: 0.3 }, value: 65 },
  { id: 'ruby', name: 'Ruby', color: [0.85, 0.06, 0.12], tier: 2, mods: { 'resist.fire': 8, 'damage.fire': 2 }, value: 70 },
  { id: 'moonstone', name: 'Moonstone', color: [0.8, 0.85, 0.95], tier: 3, mods: { perception: 5, 'resist.psychic': 5 }, value: 90 },
  { id: 'diamond', name: 'Diamond', color: [0.92, 0.96, 1], tier: 4, mods: { armor: 4, spellPower: 0.04 }, value: 160 },
  { id: 'voidstone', name: 'Voidstone', color: [0.25, 0.05, 0.4], tier: 5, mods: { spellPower: 0.08, 'damage.shadow': 3 }, value: 240 },
  { id: 'sunstone', name: 'Sunstone', color: [1, 0.6, 0.15], tier: 5, mods: { 'damage.radiant': 4, lightRadius: 2 }, value: 240 },
];

const BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));
const GEM_BY_ID = new Map(GEMS.map((g) => [g.id, g]));

export function materialDef(id: string): MaterialDef | undefined {
  return BY_ID.get(id);
}

export function gemDef(id: string): GemDef | undefined {
  return GEM_BY_ID.get(id);
}

/** All materials of a class, sorted by tier. */
export function materialsOf(cls: MatClass): MaterialDef[] {
  return MATERIALS.filter((m) => (m.cls === cls || (cls === 'metal' && m.id === 'obsidian')) && m.weight0 > 0).sort((a, b) => a.tier - b.tier);
}

/**
 * Material classes an item class may be rolled in. Melee weapons in the
 * "metal" class also accept obsidian/crystal/bone/chitin heads so loot from
 * primitive cultures and deep caves feels different.
 */
export function materialCandidates(cls: MatClass, isWeapon: boolean): MaterialDef[] {
  if (cls === 'metal') {
    const extra = isWeapon ? ['obsidian', 'crystal', 'bone', 'chitin', 'dragonbone', 'flint'] : ['bone', 'chitin', 'dragonbone', 'crystal'];
    return MATERIALS.filter((m) => m.weight0 > 0 && (m.cls === 'metal' ? m.id !== 'gold' : extra.includes(m.id)));
  }
  if (cls === 'gem') return MATERIALS.filter((m) => ['copper', 'bronze', 'silver', 'gold', 'mithril', 'starmetal'].includes(m.id));
  if (cls === 'stone') return MATERIALS.filter((m) => m.cls === 'stone' && m.weight0 > 0);
  return MATERIALS.filter((m) => m.cls === cls && m.weight0 > 0);
}
