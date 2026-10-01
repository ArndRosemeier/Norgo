/**
 * Crafting recipes: smelting & smithing at a forge, cooking at a fire,
 * alchemy, tailoring & leatherwork, woodworking, scribing and enchanting.
 *
 * Metal gear is generated per metal ("smith:sword_long:steel" → Steel
 * Longsword from 3 steel ingots), so the ingot you use decides what you get;
 * harder metals need more smithing skill. Wood/cloth/leather outputs roll
 * their material from the crafter's skill. A few advanced recipes must be
 * learned from recipe folios first (`learnable`).
 *
 * Shared (server validates; UI lists).
 */
export type Station = 'forge' | 'fire' | 'alchemy' | 'workbench' | 'loom' | null;

export interface RecipeDef {
  id: string;
  name: string;
  /** Output def id and count; output material optional (metal variants). */
  output: { id: string; count: number; material?: string };
  inputs: { id: string; count: number }[];
  skill: string;
  /** Minimum skill level (0..100). */
  level: number;
  station: Station;
  /** XP granted to `skill` on success. */
  xp: number;
  /** Must be learned from a recipe folio first. */
  learnable?: boolean;
  /** Category for UI grouping. */
  group: 'smelting' | 'smithing' | 'jewelcraft' | 'woodworking' | 'tailoring' | 'leatherwork' | 'cooking' | 'alchemy' | 'scribing' | 'enchanting';
  /** Output is a random cut gem (gem cutting). */
  randomGem?: boolean;
}

const R: RecipeDef[] = [];
const rec = (r: RecipeDef) => R.push(r);
const I = (id: string, count = 1) => ({ id, count });

// ------------------------------------------------------------------ smelting
const SMELT: [string, string, [string, number][], number][] = [
  ['copper', 'Copper Ingot', [['copper_ore', 2], ['coal', 1]], 0],
  ['bronze', 'Bronze Ingot', [['copper_ore', 3], ['coal', 1], ['flint', 1]], 5],
  ['iron', 'Iron Ingot', [['iron_ore', 2], ['coal', 1]], 5],
  ['steel', 'Steel Ingot', [['iron_ingot', 2], ['coal', 2]], 18],
  ['silver', 'Silver Ingot', [['silver_ore', 2], ['coal', 1]], 12],
  ['gold', 'Gold Ingot', [['gold_ore', 2], ['coal', 1]], 15],
  ['darksteel', 'Darksteel Ingot', [['steel_ingot', 1], ['obsidian', 1], ['coal', 3]], 35],
  ['mithril', 'Mithril Ingot', [['mithril_ore', 3], ['coal', 2]], 50],
  ['adamant', 'Adamant Ingot', [['adamant_ore', 3], ['coal', 3]], 65],
  ['starmetal', 'Starmetal Ingot', [['starmetal_ore', 2], ['crystal_shard', 1], ['coal', 3]], 80],
];
for (const [m, name, ins, lvl] of SMELT)
  rec({ id: `smelt:${m}`, name, output: { id: `${m}_ingot`, count: 1 }, inputs: ins.map(([i, c]) => I(i, c)), skill: 'smithing', level: lvl, station: 'forge', xp: 8 + lvl / 2, group: 'smelting', learnable: lvl >= 50 });
rec({ id: 'smelt:charcoal', name: 'Charcoal', output: { id: 'charcoal', count: 3 }, inputs: [I('log')], skill: 'smithing', level: 0, station: 'fire', xp: 3, group: 'smelting' });
rec({ id: 'smelt:coal', name: 'Coal (from charcoal)', output: { id: 'coal', count: 1 }, inputs: [I('charcoal', 2)], skill: 'smithing', level: 0, station: 'forge', xp: 2, group: 'smelting' });
rec({ id: 'smelt:glass', name: 'Empty Vials', output: { id: 'glass_vial', count: 3 }, inputs: [I('sand', 2), I('coal')], skill: 'alchemy', level: 0, station: 'forge', xp: 5, group: 'smelting' });

// ------------------------------------------------------------------ smithing (per metal)
/** Smithable metal bases: [defId, ingots, extra inputs, base level]. */
const SMITH: [string, number, [string, number][], number][] = [
  ['dagger', 1, [['leather', 1]], 0], ['knife_iron', 1, [['stick', 1]], 0], ['sword_short', 2, [['leather', 1]], 5], ['sword_long', 3, [['leather', 1]], 12],
  ['sword_sabre', 3, [['leather', 1]], 15], ['sword_great', 5, [['leather', 2]], 22], ['axe_hand', 1, [['stick', 2]], 3], ['axe_bearded', 2, [['plank', 1]], 10],
  ['axe_great', 4, [['plank', 2]], 20], ['mace_flanged', 3, [['plank', 1]], 12], ['hammer_war', 3, [['plank', 1]], 14], ['hammer_maul', 5, [['plank', 2]], 22],
  ['spear', 1, [['plank', 2]], 3], ['halberd', 3, [['plank', 2]], 20], ['helm_nasal', 2, [['leather', 1]], 8], ['helm_great', 4, [['leather', 1]], 25],
  ['coif_mail', 2, [], 12], ['hauberk_mail', 6, [['leather', 1]], 18], ['cuirass_plate', 7, [['leather', 2]], 30], ['gauntlets_plate', 2, [['leather', 1]], 25],
  ['vambraces_plate', 2, [['leather', 1]], 22], ['legplates', 5, [['leather', 1]], 28], ['sabatons', 2, [['leather', 1]], 24], ['shield_buckler', 2, [['leather', 1]], 8],
  ['pick_iron', 2, [['stick', 2]], 0], ['axe_wood', 2, [['stick', 2]], 0], ['hammer_smith', 1, [['stick', 1]], 0], ['sickle', 1, [['stick', 1]], 0], ['shovel', 1, [['plank', 1]], 0],
  ['lantern', 1, [['glass_vial', 2], ['wax', 1]], 8],
];
const METALS: [string, string, number][] = [
  ['copper', 'Copper', 0], ['bronze', 'Bronze', 5], ['iron', 'Iron', 8], ['steel', 'Steel', 20], ['silver', 'Silver', 25], ['darksteel', 'Darksteel', 40],
  ['mithril', 'Mithril', 55], ['adamant', 'Adamant', 70], ['starmetal', 'Starmetal', 85],
];
const TOOL_METALS = new Set(['copper', 'bronze', 'iron', 'steel']);
for (const [m, mname, mlvl] of METALS)
  for (const [def, n, extra, blvl] of SMITH) {
    if (['pick_iron', 'axe_wood', 'hammer_smith', 'sickle', 'shovel', 'knife_iron'].includes(def) && !TOOL_METALS.has(m)) continue;
    if (m === 'silver' && !['dagger', 'sword_short', 'sword_long', 'sword_sabre', 'mace_flanged', 'lantern', 'helm_nasal'].includes(def)) continue;
    if (def === 'lantern' && !['bronze', 'iron', 'silver'].includes(m)) continue;
    const lvl = Math.min(100, mlvl + blvl);
    const nice = def.replace(/_iron$/, '').replace(/_/g, ' ');
    rec({
      id: `smith:${def}:${m}`, name: `${mname} ${nice.replace(/\b\w/g, (c) => c.toUpperCase())}`, output: { id: def, count: 1, material: m },
      inputs: [I(`${m}_ingot`, n), ...extra.map(([i, c]) => I(i, c))], skill: 'smithing', level: lvl, station: 'forge', xp: 10 + n * 4 + lvl / 3, group: 'smithing', learnable: mlvl >= 55,
    });
  }
rec({ id: 'smith:arrow', name: 'Arrows ×10', output: { id: 'arrow', count: 10 }, inputs: [I('iron_ingot'), I('stick', 5), I('feather', 5)], skill: 'smithing', level: 0, station: 'forge', xp: 6, group: 'smithing' });
rec({ id: 'smith:arrow_broadhead', name: 'Broadhead Arrows ×10', output: { id: 'arrow_broadhead', count: 10 }, inputs: [I('steel_ingot'), I('stick', 5), I('feather', 5)], skill: 'smithing', level: 15, station: 'forge', xp: 10, group: 'smithing' });
rec({ id: 'smith:bolt', name: 'Crossbow Bolts ×10', output: { id: 'bolt', count: 10 }, inputs: [I('iron_ingot'), I('stick', 5)], skill: 'smithing', level: 5, station: 'forge', xp: 6, group: 'smithing' });
rec({ id: 'smith:throwing_knife', name: 'Throwing Knives ×5', output: { id: 'throwing_knife', count: 5 }, inputs: [I('iron_ingot', 2)], skill: 'smithing', level: 8, station: 'forge', xp: 10, group: 'smithing' });
rec({ id: 'smith:lockpicks', name: 'Lockpicks ×5', output: { id: 'lockpicks', count: 5 }, inputs: [I('iron_ingot')], skill: 'smithing', level: 10, station: 'forge', xp: 8, group: 'smithing' });
rec({ id: 'smith:key_iron', name: 'Iron Key', output: { id: 'key_iron', count: 1 }, inputs: [I('iron_ingot')], skill: 'smithing', level: 5, station: 'forge', xp: 4, group: 'smithing' });

// ------------------------------------------------------------------ jewelcraft
for (const [m, mname, mlvl] of [['copper', 'Copper', 0], ['silver', 'Silver', 15], ['gold', 'Gold', 25], ['mithril', 'Mithril', 55]] as [string, string, number][]) {
  rec({ id: `jewel:ring_band:${m}`, name: `${mname} Band`, output: { id: 'ring_band', count: 1, material: m }, inputs: [I(`${m}_ingot`)], skill: 'smithing', level: mlvl, station: 'forge', xp: 8 + mlvl / 3, group: 'jewelcraft' });
  rec({ id: `jewel:ring_gem:${m}`, name: `${mname} Gem Ring`, output: { id: 'ring_gem', count: 1, material: m }, inputs: [I(`${m}_ingot`), I('raw_gem')], skill: 'smithing', level: mlvl + 10, station: 'forge', xp: 14 + mlvl / 3, group: 'jewelcraft' });
  rec({ id: `jewel:amulet:${m}`, name: `${mname} Amulet`, output: { id: 'amulet', count: 1, material: m }, inputs: [I(`${m}_ingot`, 2), I('raw_gem')], skill: 'smithing', level: mlvl + 15, station: 'forge', xp: 18 + mlvl / 3, group: 'jewelcraft' });
  rec({ id: `jewel:circlet:${m}`, name: `${mname} Circlet`, output: { id: 'circlet', count: 1, material: m }, inputs: [I(`${m}_ingot`, 2), I('raw_gem')], skill: 'smithing', level: mlvl + 20, station: 'forge', xp: 20 + mlvl / 3, group: 'jewelcraft' });
}
rec({ id: 'jewel:cut_gem', name: 'Cut Gemstone', output: { id: 'gem_garnet', count: 1 }, inputs: [I('raw_gem')], skill: 'smithing', level: 10, station: 'workbench', xp: 12, group: 'jewelcraft', randomGem: true });

// ------------------------------------------------------------------ woodworking (skill: woodcutting)
const WOOD: [string, string, number, { id: string; count: number }[], number, Station][] = [
  ['plank', 'Planks ×2', 2, [I('log')], 0, null],
  ['stick', 'Sticks ×4', 4, [I('plank')], 0, null],
  ['torch', 'Torches ×2', 2, [I('stick'), I('resin')], 0, null],
  ['club', 'Cudgel', 1, [I('log')], 0, null],
  ['staff_quarter', 'Quarterstaff', 1, [I('plank', 2)], 5, 'workbench'],
  ['bow_short', 'Shortbow', 1, [I('plank', 2), I('bowstring')], 8, 'workbench'],
  ['bow_long', 'Longbow', 1, [I('plank', 3), I('bowstring')], 20, 'workbench'],
  ['bow_recurve', 'Recurve Bow', 1, [I('plank', 2), I('bone', 2), I('bowstring'), I('resin')], 30, 'workbench'],
  ['crossbow', 'Crossbow', 1, [I('plank', 3), I('steel_ingot'), I('bowstring')], 35, 'workbench'],
  ['shield_round', 'Round Shield', 1, [I('plank', 4), I('iron_ingot'), I('hide')], 10, 'workbench'],
  ['shield_kite', 'Kite Shield', 1, [I('plank', 5), I('iron_ingot', 2), I('leather')], 25, 'workbench'],
  ['fishing_rod', 'Fishing Rod', 1, [I('stick', 2), I('thread')], 0, null],
  ['javelin', 'Javelins ×3', 3, [I('stick', 3), I('flint', 3)], 5, null],
  ['staff_gnarled', 'Gnarled Staff', 1, [I('log'), I('resin', 2), I('herb_mana')], 15, 'workbench'],
  ['staff_antler', 'Antler Staff', 1, [I('plank', 2), I('bone', 3), I('feather', 2), I('herb_healing')], 25, 'workbench'],
  ['staff_crystal', 'Crystal Staff', 1, [I('plank', 2), I('crystal_shard', 3), I('silver_ingot')], 40, 'workbench'],
  ['wand', 'Wand', 1, [I('stick'), I('raw_gem'), I('dust_arcane')], 30, 'workbench'],
  ['totem_wood', 'Spirit Totem', 1, [I('plank'), I('feather', 3)], 10, null],
];
for (const [id, name, count, inputs, lvl, station] of WOOD)
  rec({ id: `wood:${id}`, name, output: { id, count }, inputs, skill: 'woodcutting', level: lvl, station, xp: 4 + lvl / 2, group: 'woodworking', learnable: lvl >= 40 });

// ------------------------------------------------------------------ tailoring & leatherwork
const TAILOR: [string, string, number, { id: string; count: number }[], number, string, RecipeDef['group']][] = [
  ['thread', 'Thread ×3', 3, [I('fiber', 2)], 0, 'tailoring', 'tailoring'],
  ['rope', 'Rope', 1, [I('fiber', 5)], 0, 'tailoring', 'tailoring'],
  ['bowstring', 'Bowstring', 1, [I('fiber', 3), I('wax')], 0, 'tailoring', 'tailoring'],
  ['linen_cloth', 'Linen Cloth', 1, [I('fiber', 4)], 0, 'tailoring', 'tailoring'],
  ['wool_cloth', 'Wool Cloth', 1, [I('fur_pelt')], 5, 'tailoring', 'tailoring'],
  ['tunic_linen', 'Tunic', 1, [I('linen_cloth', 2), I('thread')], 0, 'tailoring', 'tailoring'],
  ['shirt_linen', 'Shirt', 1, [I('linen_cloth', 2), I('thread')], 0, 'tailoring', 'tailoring'],
  ['trousers_wool', 'Trousers', 1, [I('wool_cloth', 2), I('thread')], 0, 'tailoring', 'tailoring'],
  ['hood_cloth', 'Hood', 1, [I('linen_cloth'), I('thread')], 0, 'tailoring', 'tailoring'],
  ['cloak_wool', 'Travel Cloak', 1, [I('wool_cloth', 3), I('thread', 2)], 8, 'tailoring', 'tailoring'],
  ['scarf_wool', 'Scarf', 1, [I('wool_cloth'), I('thread')], 0, 'tailoring', 'tailoring'],
  ['gambeson', 'Gambeson', 1, [I('linen_cloth', 5), I('thread', 3)], 12, 'tailoring', 'tailoring'],
  ['robe_apprentice', 'Apprentice Robe', 1, [I('wool_cloth', 3), I('thread', 2)], 10, 'tailoring', 'tailoring'],
  ['robe_mage', 'Mage Robe', 1, [I('silk_cloth', 3), I('thread', 3), I('dust_arcane')], 30, 'tailoring', 'tailoring'],
  ['hat_pointed', 'Pointed Hat', 1, [I('wool_cloth', 2), I('thread')], 8, 'tailoring', 'tailoring'],
  ['sash_silk', 'Silk Sash', 1, [I('silk_cloth'), I('thread')], 15, 'tailoring', 'tailoring'],
  ['gown_silk', 'Gown', 1, [I('silk_cloth', 4), I('thread', 3)], 35, 'tailoring', 'tailoring'],
  ['leather', 'Tan Leather', 1, [I('hide'), I('bark', 2), I('salt')], 0, 'tailoring', 'leatherwork'],
  ['parchment', 'Parchment ×3', 3, [I('hide')], 0, 'tailoring', 'leatherwork'],
  ['gloves_leather', 'Leather Gloves', 1, [I('leather'), I('thread')], 5, 'tailoring', 'leatherwork'],
  ['boots_leather', 'Leather Boots', 1, [I('leather', 2), I('thread')], 5, 'tailoring', 'leatherwork'],
  ['belt_leather', 'Leather Belt', 1, [I('leather'), I('iron_ingot')], 3, 'tailoring', 'leatherwork'],
  ['belt_pouches', 'Adventurer\'s Belt', 1, [I('leather', 3), I('thread', 2), I('iron_ingot')], 20, 'tailoring', 'leatherwork'],
  ['bracers_leather', 'Leather Bracers', 1, [I('leather'), I('thread')], 5, 'tailoring', 'leatherwork'],
  ['cap_leather', 'Leather Cap', 1, [I('leather'), I('thread')], 5, 'tailoring', 'leatherwork'],
  ['jerkin_leather', 'Leather Jerkin', 1, [I('leather', 4), I('thread', 2)], 10, 'tailoring', 'leatherwork'],
  ['leggings_leather', 'Leather Leggings', 1, [I('leather', 3), I('thread', 2)], 10, 'tailoring', 'leatherwork'],
  ['brigandine', 'Brigandine', 1, [I('leather', 4), I('iron_ingot', 2), I('thread', 2)], 25, 'tailoring', 'leatherwork'],
  ['hide_armor', 'Hide Armor', 1, [I('fur_pelt', 3), I('hide', 2), I('bone', 2)], 8, 'tailoring', 'leatherwork'],
  ['cloak_fur', 'Fur Cloak', 1, [I('fur_pelt', 3), I('thread')], 10, 'tailoring', 'leatherwork'],
  ['boots_fur', 'Fur Boots', 1, [I('fur_pelt'), I('leather'), I('thread')], 8, 'tailoring', 'leatherwork'],
  ['mantle_fur', 'Fur Mantle', 1, [I('fur_pelt', 2)], 5, 'tailoring', 'leatherwork'],
  ['sling', 'Sling', 1, [I('leather'), I('fiber', 2)], 0, 'tailoring', 'leatherwork'],
  ['waterskin', 'Waterskin', 1, [I('leather', 2), I('thread')], 0, 'tailoring', 'leatherwork'],
  ['mask_bone', 'Bone Mask', 1, [I('bone', 3), I('fiber')], 10, 'tailoring', 'leatherwork'],
  ['armor_bone', 'Bone Harness', 1, [I('bone', 8), I('hide', 2), I('fiber', 4)], 20, 'tailoring', 'leatherwork'],
  ['helm_skull', 'Skull Helm', 1, [I('bone', 5), I('leather')], 15, 'tailoring', 'leatherwork'],
];
for (const [id, name, count, inputs, lvl, skill, group] of TAILOR)
  rec({ id: `tailor:${id}`, name, output: { id, count }, inputs, skill, level: lvl, station: lvl >= 10 ? 'loom' : null, xp: 4 + lvl / 2, group });

// ------------------------------------------------------------------ cooking
const COOK: [string, string, number, { id: string; count: number }[], number][] = [
  ['meat_cooked', 'Roast Meat', 1, [I('meat_raw')], 0],
  ['fish_cooked', 'Grilled Fish', 1, [I('fish_raw')], 0],
  ['bread', 'Bread ×2', 2, [I('seed', 4)], 0],
  ['stew', 'Hearty Stew', 1, [I('meat_raw'), I('mushroom_edible', 2), I('herb_healing')], 10],
  ['pie_berry', 'Berry Pie', 1, [I('berries', 4), I('seed', 2)], 15],
  ['ale', 'Ale ×2', 2, [I('seed', 3), I('herb_stamina')], 8],
  ['cheese', 'Smoked Cheese', 1, [I('meat_raw'), I('salt')], 20],
];
for (const [id, name, count, inputs, lvl] of COOK) rec({ id: `cook:${id}`, name, output: { id, count }, inputs, skill: 'cooking', level: lvl, station: 'fire', xp: 4 + lvl / 2, group: 'cooking' });

// ------------------------------------------------------------------ alchemy
const ALCH: [string, string, { id: string; count: number }[], number, boolean?][] = [
  ['potion_heal_minor', 'Minor Healing Draught', [I('herb_healing', 2), I('glass_vial')], 0],
  ['potion_heal', 'Healing Draught', [I('herb_healing', 3), I('mushroom_edible'), I('glass_vial')], 15],
  ['potion_heal_greater', 'Greater Healing Draught', [I('herb_healing', 3), I('herb_rare'), I('glowsap'), I('glass_vial')], 45, true],
  ['potion_mana_minor', 'Minor Mana Tonic', [I('herb_mana', 2), I('glass_vial')], 0],
  ['potion_mana', 'Mana Tonic', [I('herb_mana', 3), I('mushroom_glow'), I('glass_vial')], 15],
  ['potion_mana_greater', 'Greater Mana Tonic', [I('herb_mana', 3), I('crystal_shard'), I('glowsap'), I('glass_vial')], 45, true],
  ['potion_stamina', 'Stamina Brew', [I('herb_stamina', 2), I('glass_vial')], 5],
  ['antidote', 'Antidote', [I('herb_healing'), I('venom_sac'), I('salt'), I('glass_vial')], 10],
  ['potion_poison', 'Vial of Venom', [I('herb_poison', 2), I('venom_sac'), I('glass_vial')], 12],
  ['potion_fire_resist', 'Emberward Potion', [I('cactus_flesh', 2), I('scale'), I('glass_vial')], 20],
  ['potion_frost_resist', 'Hearthblood Potion', [I('herb_stamina'), I('resin'), I('fang'), I('glass_vial')], 20],
  ['potion_shock_resist', 'Groundling Potion', [I('clay'), I('herb_healing'), I('chitin'), I('glass_vial')], 22],
  ['potion_nightsight', 'Owl\'s Eye Tincture', [I('mushroom_glow', 2), I('feather'), I('glass_vial')], 12],
  ['potion_waterbreath', 'Gillwort Draught', [I('reed', 2), I('scale'), I('glass_vial')], 18],
  ['potion_featherfall', 'Featherfall Philter', [I('feather', 3), I('glass_vial')], 15],
  ['potion_haste', 'Quicksilver Draught', [I('herb_stamina', 2), I('silver_ore'), I('glass_vial')], 30],
  ['potion_levitation', 'Skyreach Philter', [I('feather', 2), I('crystal_shard'), I('glowsap'), I('glass_vial')], 45, true],
  ['potion_invisibility', 'Draught of Unseeing', [I('herb_rare'), I('ectoplasm'), I('glass_vial')], 50, true],
  ['elixir_strength', 'Elixir of the Ox', [I('meat_raw', 2), I('herb_stamina', 2), I('fang'), I('glass_vial')], 35, true],
  ['elixir_fortitude', 'Elixir of Fortitude', [I('bone', 2), I('herb_healing', 3), I('chitin'), I('glass_vial')], 45, true],
  ['elixir_clarity', 'Elixir of Clarity', [I('herb_mana', 3), I('crystal_shard'), I('herb_rare'), I('glass_vial')], 50, true],
  ['elixir_leaping', 'Elixir of the Hare', [I('herb_stamina', 2), I('feather', 2), I('glass_vial')], 25],
  ['elixir_luck', 'Elixir of Fortune', [I('herb_rare', 2), I('gold_ore'), I('flower', 4), I('glass_vial')], 60, true],
  ['ink', 'Ink', [I('bark'), I('coal')], 0],
];
for (const [id, name, inputs, lvl, learn] of ALCH) rec({ id: `alch:${id}`, name, output: { id, count: 1 }, inputs, skill: 'alchemy', level: lvl, station: lvl >= 15 ? 'alchemy' : null, xp: 6 + lvl / 2, group: 'alchemy', learnable: !!learn });

// ------------------------------------------------------------------ scribing & enchanting
const SCRIBE: [string, string, { id: string; count: number }[], number, boolean?][] = [
  ['scroll_light', 'Scroll of Everlight', [I('parchment'), I('ink'), I('glowsap')], 0],
  ['scroll_featherfall', 'Scroll of Featherfall', [I('parchment'), I('ink'), I('feather', 2)], 10],
  ['scroll_reveal', 'Scroll of Revealing', [I('parchment'), I('ink'), I('mushroom_glow')], 15],
  ['scroll_haste', 'Scroll of Swiftness', [I('parchment'), I('ink'), I('essence_shock')], 25],
  ['scroll_ward', 'Scroll of Warding', [I('parchment'), I('ink'), I('dust_arcane', 2)], 25],
  ['scroll_waterwalk', 'Scroll of Waterwalking', [I('parchment'), I('ink'), I('essence_frost')], 30],
  ['scroll_recall', 'Scroll of Recall', [I('parchment'), I('ink'), I('dust_arcane'), I('crystal_shard')], 35, true],
  ['scroll_firestorm', 'Scroll of Firestorm', [I('parchment'), I('ink'), I('essence_fire', 2)], 45, true],
];
for (const [id, name, inputs, lvl, learn] of SCRIBE) rec({ id: `scribe:${id}`, name, output: { id, count: 1 }, inputs, skill: 'enchanting', level: lvl, station: lvl >= 20 ? 'alchemy' : null, xp: 8 + lvl / 2, group: 'scribing', learnable: !!learn });
const ENCH: [string, string, { id: string; count: number }[], number][] = [
  ['dust_arcane', 'Arcane Dust ×2', [I('crystal_shard'), I('mushroom_glow')], 0],
  ['essence_fire', 'Ember Essence', [I('dust_arcane'), I('coal'), I('resin'), I('glass_vial')], 15],
  ['essence_frost', 'Rime Essence', [I('dust_arcane'), I('crystal_shard'), I('salt'), I('glass_vial')], 15],
  ['essence_shock', 'Storm Essence', [I('dust_arcane'), I('copper_ore'), I('feather'), I('glass_vial')], 18],
  ['essence_life', 'Verdant Essence', [I('dust_arcane'), I('herb_healing', 2), I('seed'), I('glass_vial')], 18],
  ['essence_shadow', 'Umbral Essence', [I('dust_arcane'), I('obsidian'), I('ectoplasm'), I('glass_vial')], 30],
  ['essence_radiant', 'Dawn Essence', [I('dust_arcane'), I('gold_ore'), I('flower', 2), I('glass_vial')], 30],
];
for (const [id, name, inputs, lvl] of ENCH) rec({ id: `ench:${id}`, name, output: { id, count: id === 'dust_arcane' ? 2 : 1 }, inputs, skill: 'enchanting', level: lvl, station: 'alchemy', xp: 8 + lvl / 2, group: 'enchanting' });

// ------------------------------------------------------------------ exports

export const RECIPES: readonly RecipeDef[] = R;
const BY_ID = new Map(R.map((r) => [r.id, r]));

export function recipeDef(id: string): RecipeDef | undefined {
  return BY_ID.get(id);
}

/** Recipes that must be learned from folios (recipe books roll one of these). */
export function learnableRecipes(): RecipeDef[] {
  return R.filter((r) => r.learnable);
}
