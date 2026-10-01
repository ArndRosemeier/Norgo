/**
 * Pure inventory & equipment operations shared by the server (authoritative)
 * and the client UI (to predict/grey-out actions): stacking, splitting,
 * weight, slot resolution (two-handed weapons, ring slots, off-hand rules).
 */
import type { EquipSlot, Equipment, Inventory, ItemDef, ItemInstance } from './types';
import { itemDef } from './data/catalog';
import { itemWeight } from './gen/generate';

/** Two instances may share a stack: same def, material, rarity, no affixes, stackable def. */
export function canStack(a: ItemInstance, b: ItemInstance): boolean {
  if (a.defId !== b.defId || a.material !== b.material || a.rarity !== b.rarity) return false;
  if (a.affixes.length || b.affixes.length) return false;
  const d = itemDef(a.defId);
  return !!d?.stackable;
}

export function maxStackOf(it: ItemInstance): number {
  return itemDef(it.defId)?.maxStack ?? 1;
}

/**
 * Add an item to an inventory, merging into existing stacks first. The
 * passed instance may be mutated (count) and/or pushed. Returns the stacks
 * that received the items.
 */
export function addItem(inv: Inventory, item: ItemInstance): ItemInstance[] {
  const touched: ItemInstance[] = [];
  if (item.defId === 'coins') {
    inv.coins += item.count;
    return touched;
  }
  const max = maxStackOf(item);
  if (max > 1) {
    for (const s of inv.items) {
      if (item.count <= 0) break;
      if (s.count < max && canStack(s, item)) {
        const n = Math.min(max - s.count, item.count);
        s.count += n;
        item.count -= n;
        touched.push(s);
      }
    }
  }
  while (item.count > 0) {
    if (item.count <= max) {
      inv.items.push(item);
      touched.push(item);
      break;
    }
    // Oversized stacks are split into max-sized stacks with derived uids.
    const part = { ...item, uid: item.uid + '.' + inv.items.length, count: max };
    item.count -= max;
    inv.items.push(part);
    touched.push(part);
  }
  return touched;
}

/**
 * Remove `count` (default: whole stack) of an item by uid. Returns the
 * removed instance (a split copy with a new uid suffix when partial), or null.
 */
export function removeItem(inv: Inventory, uid: string, count?: number, newUid?: string): ItemInstance | null {
  const i = inv.items.findIndex((x) => x.uid === uid);
  if (i < 0) return null;
  const it = inv.items[i];
  const n = count === undefined ? it.count : Math.max(1, Math.min(it.count, Math.floor(count)));
  if (n >= it.count) {
    inv.items.splice(i, 1);
    return it;
  }
  it.count -= n;
  return { ...it, uid: newUid ?? it.uid + '~' + it.count, count: n, affixes: it.affixes.slice(), mods: { ...it.mods }, visual: { ...it.visual }, data: it.data ? { ...it.data } : undefined };
}

/** Total count of a def id in an inventory. */
export function countOf(inv: Inventory, defId: string): number {
  let n = 0;
  for (const it of inv.items) if (it.defId === defId) n += it.count;
  return n;
}

/** Consume `count` of a def id across stacks (lowest quality first). Returns false (and does nothing) if not enough. */
export function consumeDef(inv: Inventory, defId: string, count: number): ItemInstance[] | null {
  if (countOf(inv, defId) < count) return null;
  const used: ItemInstance[] = [];
  const stacks = inv.items.filter((x) => x.defId === defId).sort((a, b) => a.quality - b.quality);
  let left = count;
  for (const s of stacks) {
    if (left <= 0) break;
    const n = Math.min(left, s.count);
    const r = removeItem(inv, s.uid, n);
    if (r) used.push(r);
    left -= n;
  }
  return used;
}

/** Carried weight (inventory + equipment). */
export function carriedWeight(inv: Inventory | undefined, eq?: Equipment): number {
  let w = 0;
  if (inv) for (const it of inv.items) w += itemWeight(it) * it.count;
  if (eq) for (const it of Object.values(eq)) if (it) w += itemWeight(it);
  return Math.round(w * 100) / 100;
}

export interface EquipPlan {
  slot: EquipSlot;
  /** Slots whose current items must be unequipped first. */
  clear: EquipSlot[];
}

/**
 * Decide which slot an item goes to and what must be removed.
 * Rules: two-handed weapons occupy mainhand and clear offhand; equipping an
 * offhand item while a two-hander is held clears the mainhand; rings fill
 * ring1, then ring2, then replace ring1; items allowed in both hands go to
 * the free one (mainhand first).
 */
export function planEquip(def: ItemDef, eq: Equipment, requested?: EquipSlot): EquipPlan | null {
  if (!def.slots.length) return null;
  let slot: EquipSlot | undefined;
  if (requested && def.slots.includes(requested)) slot = requested;
  else if (def.slots.includes('ring1')) slot = !eq.ring1 ? 'ring1' : !eq.ring2 ? 'ring2' : 'ring1';
  else if (def.slots.includes('mainhand') && def.slots.includes('offhand')) {
    // Lights and off-hand-first items (torches) prefer the off hand.
    const preferOff = def.slots[0] === 'offhand';
    if (preferOff) slot = !eq.offhand || !eq.mainhand ? (!eq.offhand ? 'offhand' : 'mainhand') : 'offhand';
    else slot = !eq.mainhand ? 'mainhand' : !eq.offhand && !isTwoHanded(eq.mainhand) ? 'offhand' : 'mainhand';
  } else slot = def.slots[0];
  if (!slot) return null;
  const clear: EquipSlot[] = [slot];
  if (def.twoHanded && slot === 'mainhand') clear.push('offhand');
  if (slot === 'offhand' && isTwoHanded(eq.mainhand)) clear.push('mainhand');
  return { slot, clear: clear.filter((s) => !!eq[s]) };
}

export function isTwoHanded(it: ItemInstance | undefined): boolean {
  return !!it && !!itemDef(it.defId)?.twoHanded;
}

/** Equipped light source (torch/lantern) if any, with its def light. */
export function equippedLight(eq: Equipment | undefined): { item: ItemInstance; def: ItemDef } | null {
  if (!eq) return null;
  for (const s of ['offhand', 'mainhand'] as const) {
    const it = eq[s];
    const d = it && itemDef(it.defId);
    if (d?.light && it && it.durability > 0) return { item: it, def: d };
  }
  return null;
}

/** Sum of equipped item mods (convenience for stat derivation & UI). */
export function equipmentMods(eq: Equipment | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!eq) return out;
  for (const it of Object.values(eq)) {
    if (!it || it.durability <= 0) continue;
    for (const k in it.mods) out[k] = (out[k] ?? 0) + it.mods[k];
  }
  return out;
}
