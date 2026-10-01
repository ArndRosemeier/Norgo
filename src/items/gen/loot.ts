/**
 * Loot tables & rolling. Tables are referenced by id from other systems:
 *   creature.small|medium|large|boss, chest.ruin|camp|tomb, npc.<job>,
 *   poi.<kind>, merchant.<kind>
 * Unknown ids fall back sensibly (npc.* → npc.default, poi.* → chest.ruin...).
 *
 * Entries are either item def ids or *selectors* ("@weapon", "@potion",
 * "@gear"...) which pick a level-appropriate def from the catalog. Rolling
 * is deterministic from (table, level, seed).
 *
 * Shared (server; sandbox previews tables).
 */
import type { ItemDef, ItemInstance } from '../types';
import { Rng, deriveSeed } from '../../core/rng';
import { clamp } from '../../core/math';
import { ITEM_DEFS, itemDef } from '../data/catalog';
import { UNIQUES } from '../data/uniques';
import { createItem, isGear, type CreateOpts } from './generate';

export interface LootEntry {
  /** Def id, unique id or selector ("@weapon"). */
  id: string;
  /** Relative weight. */
  w: number;
  /** Count range for stackables. */
  n?: [number, number];
  /** Rarity luck multiplier for gear. */
  luck?: number;
  /** Minimum rarity for gear. */
  min?: 'uncommon' | 'rare' | 'epic';
}

export interface LootTable {
  /** Number of weighted rolls [min, max]. */
  rolls: [number, number];
  entries: LootEntry[];
  /** Always-dropped entries (each rolled once). */
  always?: LootEntry[];
  /** Coins [min, max] at level 1; scaled by level. */
  coins?: [number, number];
  /** Chance per roll of nothing (0..1). */
  empty?: number;
}

const E = (id: string, w: number, n?: [number, number], luck?: number, min?: LootEntry['min']): LootEntry => ({ id, w, n, luck, min });

export const LOOT_TABLES: Record<string, LootTable> = {
  // ------------------------------------------------------------ creatures
  'creature.small': { rolls: [1, 2], empty: 0.25, entries: [E('meat_raw', 5), E('hide', 2), E('bone', 3), E('feather', 3), E('fang', 1), E('scale', 1), E('chitin', 1), E('venom_sac', 0.6)] },
  'creature.medium': { rolls: [1, 3], entries: [E('meat_raw', 6, [1, 2]), E('hide', 5), E('fur_pelt', 2), E('bone', 4, [1, 2]), E('fang', 2), E('venom_sac', 1), E('chitin', 1.5), E('scale', 1.5), E('feather', 1, [2, 5])] },
  'creature.large': { rolls: [2, 4], entries: [E('meat_raw', 6, [2, 4]), E('hide', 5, [1, 2]), E('fur_pelt', 3), E('bone', 4, [2, 3]), E('fang', 3, [1, 2]), E('scale', 2, [2, 4]), E('chitin', 2, [1, 3]), E('venom_sac', 1.5), E('raw_gem', 0.6), E('crystal_shard', 0.6)] },
  'creature.boss': {
    rolls: [4, 6], coins: [40, 90], always: [E('@gear', 1, undefined, 3.5, 'rare')],
    entries: [E('meat_raw', 3, [3, 6]), E('hide', 3, [2, 3]), E('fang', 3, [2, 4]), E('scale', 2, [3, 6]), E('bone', 2, [3, 5]), E('raw_gem', 2, [1, 3]), E('crystal_shard', 2, [2, 4]), E('dragon_scale', 0.5), E('essence_fire', 0.8), E('essence_shadow', 0.8), E('@gear', 3, undefined, 2.5), E('@unique', 0.25)],
  },
  // ------------------------------------------------------------ containers
  'chest.ruin': { rolls: [2, 4], coins: [8, 30], entries: [E('@gear', 6, undefined, 1.3), E('@potion', 4), E('@scroll', 2), E('@book', 2), E('@gem', 1.5), E('@ingot', 1.5), E('key_iron', 0.6), E('relic_fragment', 0.4), E('lockpicks', 1, [1, 3]), E('@unique', 0.04), E('@trinket', 1)] },
  'chest.camp': { rolls: [2, 4], coins: [3, 15], entries: [E('@food', 6, [1, 3]), E('@ammo', 3, [5, 15]), E('torch', 3, [1, 3]), E('rope', 2), E('@potion', 2), E('@weapon', 2, undefined, 0.8), E('waterskin', 1), E('ale', 2, [1, 2]), E('map_treasure', 0.3), E('lockpicks', 1)] },
  'chest.tomb': { rolls: [2, 5], coins: [15, 60], entries: [E('@jewelry', 5, undefined, 1.6), E('@gear', 5, undefined, 2), E('@scroll', 2), E('bone', 2, [2, 5]), E('ectoplasm', 1.5), E('@gem', 2), E('book_lore', 1), E('idol_cursed', 0.3), E('@unique', 0.08), E('key_skeleton', 0.15)] },
  'chest.house': { rolls: [1, 3], coins: [2, 18], entries: [E('@food', 5, [1, 3]), E('@clothing', 3, undefined, 0.6), E('book_lore', 1.5), E('journal', 1), E('@potion', 1.5), E('thread', 1, [1, 3]), E('@trinket', 0.6), E('key_brass', 0.4)] },
  // ------------------------------------------------------------ points of interest
  'poi.ruin': { rolls: [2, 4], coins: [10, 35], entries: [E('@gear', 6, undefined, 1.4), E('@book', 2), E('relic_fragment', 1), E('@gem', 2), E('@scroll', 2), E('@potion', 2), E('@unique', 0.05)] },
  'poi.shrine': { rolls: [1, 3], coins: [5, 20], entries: [E('@scroll', 4), E('@potion', 4), E('wax', 2, [1, 3]), E('book_lore', 2), E('@jewelry', 1.5, undefined, 1.4), E('flower', 2, [2, 5]), E('essence_radiant', 0.5)] },
  'poi.wayshrine': { rolls: [1, 2], coins: [2, 10], entries: [E('@food', 4), E('potion_heal_minor', 3), E('torch', 2, [1, 2]), E('scroll_light', 2), E('book_lore', 1)] },
  'poi.camp': { rolls: [2, 4], coins: [5, 20], entries: [E('@food', 5, [1, 3]), E('@weapon', 3), E('@armor', 2), E('@ammo', 3, [5, 15]), E('ale', 2), E('lockpicks', 1, [1, 2]), E('map_treasure', 0.5)] },
  'poi.lair': { rolls: [2, 5], coins: [10, 40], entries: [E('bone', 6, [2, 6]), E('hide', 3), E('@gear', 4, undefined, 1.6), E('@gem', 2), E('fang', 3, [1, 3]), E('@unique', 0.06)] },
  'poi.grove': { rolls: [2, 4], entries: [E('herb_healing', 4, [2, 5]), E('herb_mana', 3, [1, 4]), E('herb_rare', 1.5), E('flower', 4, [2, 6]), E('berries', 4, [3, 8]), E('mushroom_edible', 3, [2, 5]), E('essence_life', 0.8), E('staff_antler', 0.4)] },
  'poi.monolith': { rolls: [1, 3], entries: [E('crystal_shard', 4, [1, 3]), E('dust_arcane', 3, [1, 3]), E('relic_fragment', 2), E('@scroll', 2), E('obsidian', 2), E('@focus', 1, undefined, 1.5)] },
  'poi.obelisk': { rolls: [1, 3], entries: [E('crystal_shard', 3, [1, 3]), E('dust_arcane', 3, [1, 3]), E('relic_fragment', 2), E('@scroll', 3), E('essence_shadow', 1), E('@focus', 1, undefined, 1.5)] },
  'poi.tower': { rolls: [2, 4], coins: [10, 40], entries: [E('@book', 4), E('@scroll', 4), E('@potion', 3), E('@focus', 2, undefined, 1.5), E('dust_arcane', 2, [1, 3]), E('ink', 1), E('parchment', 1, [2, 4]), E('@unique', 0.04)] },
  'poi.battlefield': { rolls: [2, 5], coins: [3, 20], entries: [E('@weapon', 6, undefined, 1.1), E('@armor', 5, undefined, 1.1), E('arrow', 3, [3, 12]), E('bone', 3, [1, 4]), E('signet_lost', 0.4), E('@unique', 0.03)] },
  'poi.crashsite': { rolls: [2, 4], entries: [E('starmetal_ore', 3, [1, 2]), E('crystal_shard', 4, [2, 4]), E('obsidian', 2, [1, 3]), E('dust_arcane', 2, [1, 3]), E('@gem', 1.5)] },
  'poi.well': { rolls: [1, 2], coins: [1, 12], empty: 0.3, entries: [E('lucky_coin', 1), E('@jewelry', 1, undefined, 0.8), E('key_iron', 1), E('bone', 1)] },
  // ------------------------------------------------------------ NPC drops (on death / pickpocket)
  'npc.default': { rolls: [0, 2], coins: [1, 10], entries: [E('@food', 4), E('book_lore', 0.5), E('@trinket', 0.5), E('torch', 1)] },
  'npc.farmer': { rolls: [1, 2], coins: [1, 6], entries: [E('seed', 4, [2, 6]), E('bread', 3), E('apple', 3, [1, 3]), E('cheese', 1), E('sickle', 0.5)] },
  'npc.smith': { rolls: [1, 3], coins: [4, 16], entries: [E('@ingot', 5, [1, 2]), E('coal', 3, [1, 4]), E('hammer_smith', 1), E('@weapon', 1)] },
  'npc.merchant': { rolls: [1, 3], coins: [20, 60], entries: [E('@gem', 3), E('@jewelry', 2), E('book_lore', 1), E('ledger_stolen', 0.2), E('wine', 2)] },
  'npc.innkeeper': { rolls: [1, 3], coins: [8, 25], entries: [E('ale', 4, [1, 3]), E('wine', 2), E('stew', 2), E('bread', 3), E('key_brass', 1)] },
  'npc.cook': { rolls: [1, 3], coins: [3, 10], entries: [E('stew', 3), E('bread', 3), E('meat_cooked', 3), E('salt', 2), E('knife_iron', 0.5)] },
  'npc.guard': { rolls: [1, 2], coins: [5, 15], entries: [E('@weapon', 2), E('potion_heal_minor', 3), E('bread', 2), E('key_iron', 1)] },
  'npc.priest': { rolls: [1, 2], coins: [3, 12], entries: [E('@scroll', 3), E('potion_heal_minor', 3), E('wax', 2), E('book_lore', 2)] },
  'npc.hunter': { rolls: [1, 3], coins: [2, 10], entries: [E('arrow', 4, [4, 12]), E('hide', 3), E('meat_raw', 3, [1, 2]), E('fur_pelt', 2), E('fang', 1)] },
  'npc.scholar': { rolls: [1, 3], coins: [4, 15], entries: [E('@book', 5), E('ink', 2), E('parchment', 2, [1, 4]), E('book_recipe', 0.6)] },
  'npc.mage': { rolls: [1, 3], coins: [10, 30], entries: [E('@scroll', 4), E('potion_mana', 3), E('dust_arcane', 2, [1, 3]), E('crystal_shard', 2), E('@focus', 0.6)] },
  'npc.miner': { rolls: [1, 3], coins: [2, 10], entries: [E('iron_ore', 4, [1, 3]), E('copper_ore', 3, [1, 3]), E('coal', 3, [1, 4]), E('raw_gem', 0.6), E('pick_iron', 0.5)] },
  'npc.woodcutter': { rolls: [1, 2], coins: [2, 8], entries: [E('log', 3), E('stick', 3, [2, 5]), E('resin', 2), E('axe_wood', 0.4)] },
  'npc.fisher': { rolls: [1, 2], coins: [1, 8], entries: [E('fish_raw', 5, [1, 3]), E('fish_cooked', 2), E('rope', 1), E('fishing_rod', 0.4)] },
  'npc.healer': { rolls: [1, 3], coins: [4, 15], entries: [E('herb_healing', 4, [2, 4]), E('potion_heal_minor', 4), E('potion_heal', 1.5), E('antidote', 2)] },
  'npc.bard': { rolls: [1, 2], coins: [3, 15], entries: [E('ale', 3), E('wine', 2), E('lucky_coin', 0.5), E('book_lore', 2), E('music_box', 0.3)] },
  'npc.thief': { rolls: [1, 3], coins: [5, 25], entries: [E('lockpicks', 4, [1, 4]), E('@jewelry', 2), E('dagger', 1), E('potion_poison', 1), E('ledger_stolen', 0.2)] },
  'npc.bandit': { rolls: [1, 3], coins: [5, 30], entries: [E('@weapon', 3), E('@armor', 1.5), E('ale', 2), E('potion_heal_minor', 2), E('map_treasure', 0.3)] },
  'npc.adventurer': { rolls: [2, 3], coins: [10, 40], entries: [E('@gear', 4, undefined, 1.3), E('potion_heal', 3), E('torch', 2), E('rope', 1), E('@scroll', 1)] },
  'npc.pilgrim': { rolls: [1, 2], coins: [1, 8], entries: [E('bread', 4), E('waterskin', 1), E('book_lore', 2), E('wax', 1)] },
  'npc.herder': { rolls: [1, 2], coins: [1, 6], entries: [E('cheese', 4), E('hide', 2), E('wool_cloth', 1)] },
  'npc.tailor': { rolls: [1, 3], coins: [3, 12], entries: [E('linen_cloth', 3), E('wool_cloth', 3), E('thread', 4, [2, 5]), E('silk_cloth', 0.6)] },
  'npc.alchemist': { rolls: [1, 3], coins: [5, 18], entries: [E('@potion', 5), E('glass_vial', 2, [1, 3]), E('herb_mana', 2), E('glowsap', 1)] },
  'npc.carpenter': { rolls: [1, 2], coins: [2, 10], entries: [E('plank', 4, [1, 3]), E('stick', 2, [2, 5]), E('resin', 1)] },
  'npc.mason': { rolls: [1, 2], coins: [2, 10], entries: [E('stone', 4, [2, 5]), E('clay', 2), E('flint', 2)] },
  'npc.child': { rolls: [0, 1], coins: [0, 2], entries: [E('apple', 3), E('feather_charm', 1), E('berries', 2, [1, 4])] },
  'npc.elder': { rolls: [1, 2], coins: [3, 15], entries: [E('book_lore', 3), E('heirloom_locket', 0.5), E('@trinket', 1)] },
  'npc.noble': { rolls: [1, 3], coins: [30, 90], entries: [E('@jewelry', 5, undefined, 1.5), E('wine', 2), E('letter_sealed', 1), E('@gem', 2)] },
  'npc.beggar': { rolls: [0, 1], coins: [0, 2], entries: [E('bread', 2), E('lucky_coin', 0.3)] },
  // ------------------------------------------------------------ merchant stock (ItemSystem uses these for shops)
  'merchant.general': { rolls: [10, 16], entries: [E('@food', 6, [2, 6]), E('torch', 4, [3, 8]), E('rope', 2, [1, 3]), E('waterskin', 2), E('@tool', 4), E('@clothing', 4, undefined, 0.6), E('potion_heal_minor', 3, [1, 3]), E('arrow', 2, [10, 30]), E('lantern', 1), E('glass_vial', 2, [2, 6]), E('thread', 2, [2, 6]), E('lockpicks', 1, [2, 5]), E('book_lore', 1)] },
  'merchant.smith': { rolls: [8, 13], entries: [E('@weapon', 6), E('@armor', 5), E('@tool', 3), E('@ingot', 3, [1, 4]), E('coal', 2, [3, 8]), E('throwing_knife', 1, [5, 10]), E('arrow', 1, [10, 20]), E('bolt', 1, [10, 20])] },
  'merchant.alchemist': { rolls: [9, 14], entries: [E('@potion', 10, [1, 3]), E('glass_vial', 3, [3, 8]), E('herb_healing', 2, [2, 6]), E('herb_mana', 2, [2, 5]), E('mushroom_glow', 1, [1, 4]), E('glowsap', 1), E('salt', 1, [2, 5]), E('book_recipe', 0.8)] },
  'merchant.tailor': { rolls: [8, 12], entries: [E('@clothing', 8, undefined, 0.9), E('@lightarmor', 4), E('linen_cloth', 2, [2, 5]), E('wool_cloth', 2, [2, 5]), E('silk_cloth', 1, [1, 3]), E('thread', 2, [3, 8]), E('leather', 2, [1, 4])] },
  'merchant.food': { rolls: [7, 11], entries: [E('@food', 10, [2, 6]), E('ale', 3, [2, 6]), E('wine', 2, [1, 3]), E('salt', 1, [2, 5]), E('honey', 1)] },
  'merchant.jeweler': { rolls: [6, 10], entries: [E('@jewelry', 8, undefined, 1.3), E('@gem', 4), E('@trinket', 2), E('raw_gem', 1, [1, 3]), E('silver_ingot', 1), E('gold_ingot', 1)] },
  'merchant.mage': { rolls: [8, 12], entries: [E('@scroll', 6, [1, 2]), E('@focus', 4, undefined, 1.2), E('potion_mana', 3, [1, 3]), E('@book', 2), E('dust_arcane', 2, [1, 4]), E('crystal_shard', 2, [1, 3]), E('robe_mage', 1), E('hat_pointed', 1), E('book_recipe', 1)] },
  'merchant.fletcher': { rolls: [7, 11], entries: [E('@ranged', 6), E('arrow', 4, [20, 50]), E('arrow_broadhead', 2, [10, 25]), E('arrow_fire', 1, [5, 15]), E('bolt', 2, [15, 30]), E('bowstring', 2, [1, 3]), E('feather', 2, [10, 20]), E('bracers_leather', 1), E('cloak_ranger', 0.6)] },
  'merchant.books': { rolls: [7, 11], entries: [E('@book', 10), E('book_recipe', 2), E('ink', 2, [1, 3]), E('parchment', 2, [3, 8]), E('@scroll', 2)] },
  'merchant.fence': { rolls: [7, 11], entries: [E('@gear', 6, undefined, 1.4), E('@jewelry', 3, undefined, 1.2), E('lockpicks', 3, [3, 8]), E('potion_poison', 2), E('key_skeleton', 0.3), E('potion_invisibility', 0.5), E('mask_cloth', 1)] },
  'merchant.temple': { rolls: [6, 10], entries: [E('potion_heal_minor', 4, [2, 5]), E('potion_heal', 2, [1, 3]), E('antidote', 3, [1, 3]), E('@scroll', 4), E('wax', 2, [2, 6]), E('robe_priest', 1), E('book_lore', 2)] },
  'merchant.hunter': { rolls: [7, 11], entries: [E('hide', 3, [2, 5]), E('fur_pelt', 3, [1, 4]), E('meat_raw', 3, [2, 6]), E('@ranged', 3), E('arrow', 3, [15, 40]), E('@lightarmor', 2), E('fang', 1, [2, 5])] },
  'merchant.miner': { rolls: [7, 10], entries: [E('iron_ore', 3, [3, 8]), E('copper_ore', 3, [3, 8]), E('coal', 4, [4, 12]), E('silver_ore', 1, [1, 3]), E('pick_iron', 2), E('lantern', 1), E('raw_gem', 1)] },
};

/** Map an NPC job to the shop table it sells from (null = not a merchant). */
export function merchantTableFor(job: string): string {
  switch (job) {
    case 'smith': return 'merchant.smith';
    case 'alchemist': case 'healer': return 'merchant.alchemist';
    case 'tailor': return 'merchant.tailor';
    case 'innkeeper': case 'cook': case 'farmer': case 'herder': case 'fisher': return 'merchant.food';
    case 'mage': return 'merchant.mage';
    case 'hunter': return 'merchant.hunter';
    case 'scholar': return 'merchant.books';
    case 'thief': case 'bandit': return 'merchant.fence';
    case 'priest': return 'merchant.temple';
    case 'miner': case 'mason': return 'merchant.miner';
    case 'noble': return 'merchant.jeweler';
    default: return 'merchant.general';
  }
}

/** Resolve a table id with fallbacks. */
export function lootTable(id: string): LootTable {
  const t = LOOT_TABLES[id];
  if (t) return t;
  if (id.startsWith('npc.')) return LOOT_TABLES['npc.default'];
  if (id.startsWith('merchant.')) return LOOT_TABLES[merchantTableFor(id.slice(9))] ?? LOOT_TABLES['merchant.general'];
  if (id.startsWith('poi.') || id.startsWith('chest.')) return LOOT_TABLES['chest.ruin'];
  if (id.startsWith('creature.')) return LOOT_TABLES['creature.medium'];
  return LOOT_TABLES['chest.camp'];
}

// ------------------------------------------------------------------ selectors

const SELECTORS: Record<string, (d: ItemDef) => boolean> = {
  gear: (d) => isGear(d) && d.category !== 'trinket',
  weapon: (d) => d.category === 'weapon' && !d.stackable,
  ranged: (d) => d.category === 'weapon' && !!d.weapon?.ranged && !d.stackable,
  focus: (d) => !!d.tags?.includes('focus'),
  armor: (d) => d.category === 'armor',
  lightarmor: (d) => d.category === 'armor' && !!d.tags?.includes('light_armor'),
  clothing: (d) => d.category === 'clothing',
  jewelry: (d) => d.category === 'jewelry',
  trinket: (d) => d.category === 'trinket',
  tool: (d) => d.category === 'tool' || d.category === 'light',
  potion: (d) => !!d.tags?.includes('potion'),
  scroll: (d) => !!d.tags?.includes('scroll'),
  food: (d) => d.category === 'food' && !d.tags?.includes('raw'),
  book: (d) => d.category === 'book' && d.book?.kind !== 'journal',
  gem: (d) => d.id.startsWith('gem_'),
  ingot: (d) => d.id.endsWith('_ingot'),
  ammo: (d) => d.category === 'ammo',
  reagent: (d) => d.category === 'reagent',
};
const selCache = new Map<string, ItemDef[]>();
function selectorDefs(sel: string): ItemDef[] {
  let arr = selCache.get(sel);
  if (!arr) {
    const f = SELECTORS[sel];
    arr = f ? ITEM_DEFS.filter((d) => f(d) && d.category !== 'quest' && d.id !== 'coins') : [];
    selCache.set(sel, arr);
  }
  return arr;
}

/** Pick a def from a selector, weighted toward the level's tier band. */
export function pickFromSelector(rng: Rng, sel: string, level: number): ItemDef | null {
  const defs = selectorDefs(sel);
  if (!defs.length) return null;
  const tierCap = level / 5 + 1;
  return rng.weighted(defs, (d) => {
    const t = d.tier ?? 0;
    if (t > tierCap) return 0.02;
    // Cheap everyday items dominate early; let costly items appear later.
    return 1 / (1 + Math.max(0, d.baseValue - 20 * level) / 200) * (t <= tierCap - 2 ? 0.6 : 1);
  });
}

export interface RollOpts extends Omit<CreateOpts, 'seed' | 'level' | 'count' | 'uid'> {
  /** Unique ids that already exist in the world (excluded). */
  excludeUniques?: Set<string>;
  /** Coin multiplier (settlement wealth, boss...). */
  coinMul?: number;
  /** Override uid generator. */
  uid?: () => string;
}

/**
 * Roll a loot table. Returns item instances; coins come back as a 'coins'
 * stack item (callers may convert to purse coins).
 */
export function rollLootTable(tableId: string, level: number, seed: number, opts: RollOpts = {}): ItemInstance[] {
  const t = lootTable(tableId);
  const rng = new Rng(deriveSeed(seed, 'loot', tableId, level));
  const lvl = clamp(Math.round(level), 1, 40);
  const out: ItemInstance[] = [];
  const mk = (e: LootEntry, i: number) => {
    const r = rng.fork('e', i);
    let id = e.id;
    if (id === '@unique') {
      const pool = UNIQUES.filter((u) => u.minLevel <= lvl + 5 && !opts.excludeUniques?.has(u.id));
      if (!pool.length) id = '@gear';
      else id = r.pick(pool).id;
    }
    if (id.startsWith('@')) {
      const d = pickFromSelector(r, id.slice(1), lvl);
      if (!d) return;
      id = d.id;
    }
    const count = e.n ? r.int(e.n[0], e.n[1]) : 1;
    try {
      const it = createItem(id, { ...opts, uid: opts.uid?.(), level: lvl + r.int(-2, 2), seed: r.nextU32(), count, luck: (opts.luck ?? 1) * (e.luck ?? 1), minRarity: e.min ?? opts.minRarity, source: opts.source ?? 'loot' });
      out.push(it);
      if (id.startsWith('u_')) opts.excludeUniques?.add(id);
    } catch {
      // Defs referenced by tables are validated by tools/items-check.ts; skip silently at runtime.
    }
  };
  let i = 0;
  for (const e of t.always ?? []) mk(e, i++);
  const rolls = rng.int(t.rolls[0], t.rolls[1]);
  for (let k = 0; k < rolls; k++) {
    if (t.empty && rng.chance(t.empty)) continue;
    mk(rng.weighted(t.entries, (x) => x.w), i++);
  }
  if (t.coins) {
    const c = Math.round(rng.range(t.coins[0], t.coins[1]) * (1 + lvl * 0.12) * (opts.coinMul ?? 1));
    if (c > 0) out.push(createItem('coins', { count: c, seed: rng.nextU32(), uid: opts.uid?.() }));
  }
  // Merge identical stackables (same def & material).
  const merged: ItemInstance[] = [];
  for (const it of out) {
    const same = merged.find((m) => m.defId === it.defId && m.material === it.material && m.rarity === it.rarity && !m.affixes.length && !it.affixes.length && it.count > 0 && m.count < 1e6 && it.defId !== 'book_lore');
    if (same && (itemDef(it.defId)?.stackable ?? false)) same.count += it.count;
    else merged.push(it);
  }
  return merged;
}
