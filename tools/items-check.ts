/**
 * Items self-check (Node): validates that every id referenced by loot tables,
 * recipes, uniques and other modules exists, that generation is deterministic,
 * and prints a sample of generated loot.
 *   npx tsx tools/items-check.ts [--samples]
 */
import { ITEM_DEFS, itemDef } from '../src/items/data/catalog';
import { LOOT_TABLES, rollLootTable } from '../src/items/gen/loot';
import { RECIPES } from '../src/items/data/recipes';
import { UNIQUES } from '../src/items/data/uniques';
import { createItem } from '../src/items/gen/generate';
import { materialDef } from '../src/items/data/materials';
import { outfitPlan } from '../src/items/gen/outfit';

let errors = 0;
const err = (m: string) => {
  errors++;
  console.error('  ✗ ' + m);
};

// Ids other modules rely on.
const REQUIRED = [
  'tunic_linen', 'trousers_wool', 'boots_leather', 'knife_iron', 'torch', 'bread', 'waterskin', 'pick_iron',
  'log', 'stick', 'bark', 'resin', 'fiber', 'plank', 'stone', 'flint', 'clay', 'sand', 'coal', 'iron_ore', 'copper_ore', 'silver_ore', 'gold_ore', 'raw_gem',
  'crystal_shard', 'obsidian', 'salt', 'herb_healing', 'herb_mana', 'herb_stamina', 'herb_poison', 'herb_rare', 'mushroom_edible', 'mushroom_glow', 'mushroom_toxic',
  'berries', 'flower', 'seed', 'cactus_flesh', 'reed', 'bone', 'hide', 'meat_raw', 'meat_cooked', 'feather', 'chitin', 'venom_sac', 'scale', 'fang', 'glowsap', 'soil',
];
console.log(`defs: ${ITEM_DEFS.length}`);
const ids = new Set<string>();
for (const d of ITEM_DEFS) {
  if (ids.has(d.id)) err(`duplicate def ${d.id}`);
  ids.add(d.id);
  if (d.baseMaterial && !materialDef(d.baseMaterial) && !d.id.startsWith('gem_')) err(`${d.id}: unknown baseMaterial ${d.baseMaterial}`);
}
for (const id of REQUIRED) if (!itemDef(id)) err(`missing required def ${id}`);
for (const [tid, t] of Object.entries(LOOT_TABLES))
  for (const e of [...t.entries, ...(t.always ?? [])]) if (!e.id.startsWith('@') && !itemDef(e.id)) err(`table ${tid}: unknown ${e.id}`);
for (const r of RECIPES) {
  if (!itemDef(r.output.id)) err(`recipe ${r.id}: unknown output ${r.output.id}`);
  for (const i of r.inputs) if (!itemDef(i.id)) err(`recipe ${r.id}: unknown input ${i.id}`);
  if (r.output.material && !materialDef(r.output.material)) err(`recipe ${r.id}: unknown material`);
}
for (const u of UNIQUES) if (!itemDef(u.base) || !materialDef(u.material)) err(`unique ${u.id}: bad base/material`);

// Every def can be created.
for (const d of ITEM_DEFS) {
  try {
    createItem(d.id, { seed: 1, level: 10 });
  } catch (e) {
    err(`create ${d.id}: ${(e as Error).message}`);
  }
}
// Determinism.
const a = JSON.stringify(rollLootTable('chest.ruin', 12, 4242));
const b = JSON.stringify(rollLootTable('chest.ruin', 12, 4242));
if (a !== b) err('rollLootTable not deterministic');
const c = JSON.stringify(createItem('sword_long', { seed: 99, level: 20, uid: 'x' }));
const d = JSON.stringify(createItem('sword_long', { seed: 99, level: 20, uid: 'x' }));
if (c !== d) err('createItem not deterministic');
// Outfits reference valid defs.
for (const race of ['human', 'elf', 'dwarf', 'orc', 'goblin', 'giantkin'])
  for (const job of ['farmer', 'smith', 'guard', 'mage', 'noble', 'bandit', 'priest', 'beggar', 'hunter'])
    for (const p of outfitPlan(race, job, 0.5, 7)) if (!itemDef(p.defId)) err(`outfit ${race}/${job}: unknown ${p.defId}`);

if (process.argv.includes('--samples')) {
  for (const t of ['creature.boss', 'chest.ruin', 'chest.tomb', 'merchant.smith', 'npc.noble']) {
    console.log(`\n== ${t} (lvl 18)`);
    for (const it of rollLootTable(t, 18, 7)) console.log(`  [${it.rarity}] ${it.count > 1 ? it.count + '× ' : ''}${it.name}  (${it.material}, q${it.quality.toFixed(2)}, ${it.value}c) ${JSON.stringify(it.mods)}`);
  }
  for (let s = 0; s < 8; s++) {
    const it = createItem('sword_long', { seed: s, level: 30, style: ['elf', 'dwarf', 'orc', 'umbral'][s % 4], luck: 4 });
    console.log(`  [${it.rarity}] ${it.name} dmg ${it.weapon?.damage} ${JSON.stringify(it.mods)}${it.lore ? '\n     ' + it.lore : ''}`);
  }
  const bk = createItem('book_lore', { seed: 5 });
  console.log(`\n${bk.name}\n${bk.lore}`);
}
console.log(errors ? `\n${errors} error(s)` : '\nall checks passed');
process.exit(errors ? 1 : 0);
