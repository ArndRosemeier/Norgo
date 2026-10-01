/**
 * Trade pricing and merchant stock. Prices depend on the item's value, the
 * merchant's disposition toward the buyer (-100..100), the buyer's barter
 * skill (0..100), the merchant's speciality and local wealth. Stock is
 * generated per merchant & in-game day from a loot table, so it is stable
 * through a day and restocks overnight.
 *
 * Shared (server authoritative; UI can show the same numbers).
 */
import type { ItemInstance } from '../types';
import { clamp } from '../../core/math';
import { deriveSeed } from '../../core/rng';
import { itemDef } from '../data/catalog';
import { merchantTableFor, rollLootTable } from './loot';

export interface PriceContext {
  /** NPC disposition toward the trader, -100..100. */
  disposition: number;
  /** Trader's barter skill level 0..100. */
  barter: number;
  /** Merchant's table (speciality); specialists pay more for their goods. */
  table?: string;
  /** Settlement wealth 0..1 (rich towns pay & charge more). */
  wealth?: number;
}

/** Fraction of value the merchant charges (≥ 1). */
export function buyMultiplier(pc: PriceContext): number {
  const disp = clamp(pc.disposition, -100, 100) / 100;
  const m = 1.65 - disp * 0.3 - clamp(pc.barter, 0, 100) * 0.004 + (pc.wealth ?? 0.5) * 0.15;
  return Math.max(1.05, m);
}

/** Fraction of value the merchant pays (< buy multiplier always). */
export function sellMultiplier(pc: PriceContext, item?: ItemInstance): number {
  const disp = clamp(pc.disposition, -100, 100) / 100;
  let m = 0.3 + disp * 0.12 + clamp(pc.barter, 0, 100) * 0.0025 + (pc.wealth ?? 0.5) * 0.08;
  if (item && pc.table && specialtyMatches(pc.table, item)) m += 0.1;
  return clamp(m, 0.1, buyMultiplier(pc) - 0.15);
}

/** Does this merchant specialise in this kind of item? */
export function specialtyMatches(table: string, it: ItemInstance): boolean {
  const d = itemDef(it.defId);
  if (!d) return false;
  switch (table) {
    case 'merchant.smith': return d.category === 'weapon' || d.category === 'armor' || d.id.endsWith('_ingot') || d.id.endsWith('_ore');
    case 'merchant.alchemist': return d.category === 'reagent' || !!d.tags?.includes('potion');
    case 'merchant.tailor': return d.category === 'clothing' || d.matClass === 'cloth' || d.matClass === 'leather';
    case 'merchant.food': return d.category === 'food';
    case 'merchant.jeweler': return d.category === 'jewelry' || d.id.startsWith('gem_') || d.id === 'raw_gem';
    case 'merchant.mage': return !!d.tags?.includes('scroll') || !!d.tags?.includes('focus') || d.category === 'reagent';
    case 'merchant.fletcher': return d.category === 'ammo' || !!d.weapon?.ranged;
    case 'merchant.books': return d.category === 'book';
    case 'merchant.hunter': return ['hide', 'fur_pelt', 'meat_raw', 'fang', 'bone', 'feather', 'scale', 'chitin'].includes(d.id);
    case 'merchant.miner': return d.id.endsWith('_ore') || ['coal', 'stone', 'raw_gem', 'crystal_shard', 'obsidian'].includes(d.id);
    case 'merchant.fence': return true;
    default: return false;
  }
}

export function buyPrice(it: ItemInstance, pc: PriceContext, count = it.count): number {
  return Math.max(1, Math.ceil(it.value * buyMultiplier(pc) * count));
}

export function sellPrice(it: ItemInstance, pc: PriceContext, count = it.count): number {
  if (it.defId === 'coins' || itemDef(it.defId)?.category === 'quest') return 0;
  const broken = it.durability <= 0 && it.maxDurability > 0 ? 0.3 : 1;
  return Math.max(0, Math.floor(it.value * sellMultiplier(pc, it) * count * broken));
}

/**
 * Generate a merchant's stock for a day. `level` ≈ local danger/wealth band.
 * Coins come back separately (merchant purse).
 */
export function merchantStock(job: string, merchantSeed: number, day: number, level: number, wealth: number, style: string, uid: () => string): { items: ItemInstance[]; coins: number; table: string } {
  const table = merchantTableFor(job);
  const seed = deriveSeed(merchantSeed, 'stock', day);
  const items = rollLootTable(table, level, seed, { style, source: 'merchant', uid, luck: 0.8 + wealth * 0.6 });
  // Rich towns stock a second, pricier roll.
  if (wealth > 0.6) items.push(...rollLootTable(table, level + 4, deriveSeed(seed, 'rich'), { style, source: 'merchant', uid, luck: 1.4 }));
  const coins = Math.round(150 + wealth * 900 + level * 25);
  return { items: items.filter((i) => i.defId !== 'coins'), coins, table };
}
