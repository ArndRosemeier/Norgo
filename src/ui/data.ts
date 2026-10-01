/**
 * Catalog access for the UI. Skills/abilities/races come from their contract
 * modules; item definitions and crafting recipes are *optional* exports of the
 * items module, discovered at runtime (via a Vite glob) so the UI degrades
 * gracefully if they're not present yet.
 */
import { SKILLS, ABILITIES, xpForLevel } from '../gameplay/data/catalog';
import type { AbilityDef, SkillDef, SkillCategory } from '../gameplay/types';
import { RACES, type RaceDef } from '../humanoid/appearance';
import { RACE_IDS, type RaceId } from '../humanoid/types';
import type { ItemDef, ItemInstance, ItemCategory, EquipSlot } from '../items/types';
import { titleize } from './format';
import { itemDef as catalogItemDef } from '../items/data/catalog';
import { RECIPES } from '../items/data/recipes';

export { xpForLevel };

export function skillDef(id: string): SkillDef | undefined {
  return SKILLS.find((s) => s.id === id);
}

export function abilityDef(id: string): AbilityDef | undefined {
  return ABILITIES.find((a) => a.id === id);
}

/** Skill def, or a synthesized one for ids that only appear in player state. */
export function skillOrStub(id: string): SkillDef {
  return skillDef(id) ?? { id, name: titleize(id), category: 'utility', description: '', unlocks: [], icon: id };
}

export function abilityOrStub(id: string): AbilityDef {
  return (
    abilityDef(id) ?? {
      id, name: titleize(id.replace(/^ench\./, '')), skill: '', kind: 'magic', role: 'utility', targeting: 'self', range: 0, cost: {},
      cooldown: 0, castTime: 0, anim: 'cast_self', description: '', icon: id, tags: [],
    }
  );
}

export const SKILL_CATEGORIES: { id: SkillCategory; name: string }[] = [
  { id: 'combat', name: 'Combat' }, { id: 'magic', name: 'Magic' }, { id: 'utility', name: 'Utility' },
  { id: 'craft', name: 'Crafting' }, { id: 'survival', name: 'Survival' }, { id: 'social', name: 'Social' },
];

// ------------------------------------------------------------------ races

const RACE_FALLBACK: Record<RaceId, [string, string, string]> = {
  human: ['Human', 'Humans', 'Adaptable and restless, humans settle every land they reach and master any craft given time.'],
  elf: ['Elf', 'Elves', 'Long-lived and keen of sense, elves walk lightly through old forests and older magic.'],
  dwarf: ['Dwarf', 'Dwarves', 'Stout delvers and peerless smiths who read stone as others read books.'],
  orc: ['Orc', 'Orcs', 'Proud, strong and fiercely loyal clans who prize strength earned and debts repaid.'],
  halfling: ['Halfling', 'Halflings', 'Small, nimble and lucky folk with a gift for going unnoticed and eating well.'],
  goblin: ['Goblin', 'Goblins', 'Quick-witted tinkerers and scavengers, thriving where others would starve.'],
  sylvan: ['Sylvan', 'Sylvans', 'Bark-skinned children of grove and fungus, kin to every growing thing.'],
  drakeborn: ['Drakeborn', 'Drakeborn', 'Scaled descendants of dragons, with fire in the blood and pride to match.'],
  umbral: ['Umbral', 'Umbrals', 'Pale-eyed wanderers of twilight places, attuned to shadow and silence.'],
  giantkin: ['Giantkin', 'Giantkin', 'Towering mountain folk, slow to anger and impossible to move once set.'],
};

export function raceDef(id: RaceId): RaceDef {
  const r = (RACES as Partial<Record<RaceId, RaceDef>>)[id];
  if (r) return r;
  const [name, plural, description] = RACE_FALLBACK[id] ?? [titleize(id), titleize(id) + 's', ''];
  return { id, name, plural, description, lifespan: 80, skillBonus: {}, statMods: {} };
}

export function raceIds(): RaceId[] {
  const keys = Object.keys(RACES) as RaceId[];
  return keys.length ? RACE_IDS.filter((r) => keys.includes(r)).concat(keys.filter((k) => !RACE_IDS.includes(k))) : RACE_IDS.slice();
}

// ------------------------------------------------------------------ item database & recipes

/** Recipe shape used by the crafting panel (normalized from the items module). */
export interface UiRecipe {
  id: string;
  name: string;
  inputs: { defId: string; count: number; name: string }[];
  output: { defId: string; count: number; name: string };
  station?: string;
  skill?: string;
  level?: number;
  category?: string;
  description?: string;
  /** Must be learned from a folio before it can be crafted. */
  learnable?: boolean;
}

let recipes: UiRecipe[] | null = null;

/** Kept for API compatibility: item data is statically available now. */
export function loadItemData(): Promise<void> {
  return Promise.resolve();
}

function allRecipes(): UiRecipe[] {
  if (!recipes) {
    recipes = RECIPES.map((r) => ({
      id: r.id,
      name: r.name,
      inputs: r.inputs.map((i) => ({ defId: i.id, count: i.count, name: itemName(i.id) })),
      output: { defId: r.output.id, count: r.output.count, name: itemName(r.output.id) },
      station: r.station ?? undefined,
      skill: r.skill,
      level: r.level,
      category: r.group,
      learnable: r.learnable,
    }));
  }
  return recipes;
}

export function itemDefOf(defId: string): ItemDef | undefined {
  return catalogItemDef(defId);
}

export function itemName(defId: string): string {
  return itemDefOf(defId)?.name ?? titleize(defId.replace(/^.*[:/]/, ''));
}

/** Recipes the player can see: all common ones plus learned folio recipes. */
export function getRecipes(known: readonly string[] = []): UiRecipe[] {
  return allRecipes().filter((r) => !r.learnable || known.includes(r.id));
}

/** Category guess when no def is available. */
export function itemCategory(item: Pick<ItemInstance, 'defId' | 'visual'>): ItemCategory | undefined {
  const d = itemDefOf(item.defId);
  if (d) return d.category;
  const s = `${item.visual?.shape ?? ''} ${item.defId}`.toLowerCase();
  if (/sword|axe|bow|dagger|mace|hammer|spear|staff|wand|club|maul/.test(s)) return 'weapon';
  if (/helm|mail|plate|cuirass|greave|gauntlet|shield|pauldron|armor/.test(s)) return 'armor';
  if (/robe|shirt|tunic|coat|cloak|boots|shoe|hat|hood|glove|pants|belt|trousers/.test(s)) return 'clothing';
  if (/ring|amulet|necklace|pendant/.test(s)) return 'jewelry';
  if (/potion|elixir|vial|flask|scroll\.spell/.test(s)) return 'consumable';
  if (/bread|meat|fruit|apple|stew|cheese|fish|berry/.test(s)) return 'food';
  if (/pick|shovel|sickle|rod|lockpick|tool/.test(s)) return 'tool';
  if (/ore|ingot|plank|log|hide|cloth|bar|stone|fiber/.test(s)) return 'material';
  if (/herb|root|leaf|flower|mushroom|essence|dust/.test(s)) return 'reagent';
  if (/book|tome/.test(s)) return 'book';
  if (/key/.test(s)) return 'key';
  if (/arrow|bolt/.test(s)) return 'ammo';
  if (/torch|lantern|candle/.test(s)) return 'light';
  return undefined;
}

/** Slots an item fits into (def if known, else a heuristic from its shape). */
export function itemSlots(item: Pick<ItemInstance, 'defId' | 'visual'>): EquipSlot[] {
  const d = itemDefOf(item.defId);
  if (d) return d.slots;
  const s = `${item.visual?.shape ?? ''} ${item.defId}`.toLowerCase();
  const map: [RegExp, EquipSlot[]][] = [
    [/shield|buckler|torch|lantern|tome/, ['offhand']],
    [/sword|axe|bow|dagger|mace|hammer|spear|staff|wand|club|maul|pick|shovel|sickle|rod/, ['mainhand', 'offhand']],
    [/helm|hat|hood|cap|crown|circlet/, ['head']],
    [/mask|veil|goggle/, ['face']],
    [/amulet|necklace|pendant|torc/, ['neck']],
    [/pauldron|mantle|shoulder/, ['shoulders']],
    [/cloak|cape|backpack|quiver/, ['back']],
    [/bracer|vambrace|wrist/, ['wrists']],
    [/glove|gauntlet/, ['hands']],
    [/belt|sash|girdle/, ['waist']],
    [/pants|trousers|greave|leg|skirt|kilt/, ['legs']],
    [/boot|shoe|sandal/, ['feet']],
    [/ring/, ['ring1', 'ring2']],
    [/robe|shirt|tunic|coat|vest|mail|cuirass|breastplate|jerkin|chest/, ['chest']],
    [/charm|talisman|idol|trinket|totem/, ['trinket']],
  ];
  return map.find(([re]) => re.test(s))?.[1] ?? [];
}

export function itemWeight(item: ItemInstance): number {
  const d = itemDefOf(item.defId);
  return d ? d.weight * item.count : 0;
}
