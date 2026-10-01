/**
 * Item instance generation: turns a base ItemDef + seed into a unique
 * ItemInstance — material, quality, rarity, affixes, culture style, final
 * stats, generated name, visuals, lore and value. Pure and deterministic:
 * same (defId, opts, seed) → identical item on every machine.
 *
 *   "Fine Dwarven Steel Warhammer of the Iron Tortoise"   (rare)
 *   "Thalith Starwhisper" — Elven Mithril Longsword        (legendary)
 *
 * Shared (server + client; the sandbox renders generated loot directly).
 */
import type { ItemAffix, ItemDef, ItemInstance, ItemVisual, Rarity, StatMods } from '../types';
import { Rng, hashString } from '../../core/rng';
import { clamp, mixRgb } from '../../core/math';
import { itemDef } from '../data/catalog';
import { GEMS, MATERIALS, materialCandidates, materialDef, type GemDef, type MaterialDef, type RGB } from '../data/materials';
import { STYLES, styleOf } from '../data/styles';
import { AFFIXES, affixName, type AffixDef, type AffixTarget } from '../data/affixes';
import { UNIQUES, uniqueDef, type UniqueDef } from '../data/uniques';
import { generateBook, legendaryLore, legendaryName, makersMark } from '../data/lore';
import { learnableRecipes } from '../data/recipes';

export interface CreateOpts {
  count?: number;
  /** Item level 1..40 (drives material tier, affix tiers, rarity odds). */
  level?: number;
  rarity?: Rarity | string;
  /** Minimum rarity when rolling (boss drops). */
  minRarity?: Rarity;
  material?: string;
  seed?: number;
  /** Culture style (race id). */
  style?: string;
  quality?: number;
  uid?: string;
  /** How it came to be: affects wear and the origin line. */
  source?: 'loot' | 'merchant' | 'crafted' | 'outfit' | 'quest';
  /** Crafting skill level 0..100 (crafted items: quality & affix chance). */
  craftSkill?: number;
  /** Rarity luck multiplier (>1 = better odds). */
  luck?: number;
  /** Extra JSON data to attach (key target, quest id...). */
  data?: Record<string, string | number | boolean>;
  /** Book: force a skill for skill books. */
  skill?: string;
  worldName?: string;
}

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'unique'];
export const RARITY_COLORS: Record<Rarity, RGB> = {
  common: [0.85, 0.85, 0.82], uncommon: [0.35, 0.85, 0.35], rare: [0.3, 0.55, 1], epic: [0.7, 0.35, 1], legendary: [1, 0.6, 0.15], unique: [0.95, 0.85, 0.45],
};
const RARITY_VALUE: Record<Rarity, number> = { common: 1, uncommon: 1.5, rare: 2.4, epic: 4, legendary: 6.5, unique: 9 };
const AFFIX_COUNT: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, unique: 0 };

export const SKILL_BOOK_SKILLS = ['blades', 'axes', 'blunt', 'polearms', 'archery', 'throwing', 'unarmed', 'shields', 'heavy_armor', 'light_armor', 'mining', 'woodcutting', 'herbalism', 'foraging', 'smithing', 'alchemy', 'cooking', 'tailoring', 'enchanting'];

/** Can this def roll magic properties (affixes, rarity)? */
export function isGear(d: ItemDef): boolean {
  return d.slots.length > 0 && !d.stackable && d.category !== 'quest';
}

/** Affix target class for a def. */
export function affixTarget(d: ItemDef): AffixTarget | null {
  if (d.tags?.includes('shield')) return 'shield';
  switch (d.category) {
    case 'weapon':
      if (d.tags?.includes('focus')) return 'focus';
      return d.weapon?.ranged ? 'ranged' : 'melee';
    case 'armor': return 'armor';
    case 'clothing': return 'clothing';
    case 'jewelry': return 'jewelry';
    case 'trinket': return 'trinket';
    case 'tool': return 'tool';
    case 'light': return 'light';
    default: return null;
  }
}

/** Roll a rarity for gear at a level. */
export function rollRarity(rng: Rng, level: number, luck = 1): Rarity {
  const L = clamp(level, 1, 40) / 40;
  const w = [60 - L * 25, 26 + L * 4, (9 + L * 10) * luck, (3.5 + L * 7) * luck, (0.6 + L * 3) * luck];
  return rng.weighted(RARITY_ORDER.slice(0, 5), (_, i) => w[i]);
}

/** Pick a material of a class fitting the item level and culture. */
export function pickMaterial(rng: Rng, d: ItemDef, level: number, style: string): MaterialDef {
  const cls = d.matClass!;
  const cands = materialCandidates(cls, d.category === 'weapon');
  const target = clamp(level / 6, 0, 6);
  const fav = styleOf(style).favored;
  const m = rng.weighted(cands, (m) => {
    if (m.tier > target + 1.2) return 0;
    const near = Math.exp(-Math.pow((m.tier - target) / 1.4, 2));
    return m.weight0 * (0.15 + near) * (fav.includes(m.id) ? 2.5 : 1);
  });
  return m ?? materialDef(d.baseMaterial ?? 'iron')!;
}

function qualityWord(q: number): string {
  if (q < 0.12) return 'Crude';
  if (q < 0.28) return 'Shoddy';
  if (q > 0.95) return 'Masterwork';
  if (q > 0.82) return 'Fine';
  return '';
}

/** Strip a leading material word from a base name ("Leather Boots" → "Boots"). */
function stripMaterial(name: string): string {
  for (const m of MATERIALS) if (m.name && name.startsWith(m.name + ' ')) return name.slice(m.name.length + 1);
  for (const w of ['Wool ', 'Linen ', 'Silk ', 'Leather ', 'Fur ', 'Bone ', 'Iron ', 'Brass ']) if (name.startsWith(w)) return name.slice(w.length);
  return name;
}

function addMods(into: StatMods, from: StatMods | undefined, mul = 1) {
  if (!from) return;
  for (const k in from) {
    const v = from[k] * mul;
    into[k] = Math.round(((into[k] ?? 0) + v) * 1000) / 1000;
  }
}

/** Value of an instance (per unit), from its def, material, quality, rarity and affixes. */
export function computeValue(d: ItemDef, mat: MaterialDef | undefined, quality: number, rarity: Rarity, affixes: ItemAffix[], gem?: GemDef): number {
  // Compressed so exotic materials stay within a coin economy merchants can afford.
  const matMul = d.matClass && mat ? Math.pow(mat.value, 0.7) : 1;
  const qMul = d.stackable ? 1 : 0.5 + quality;
  let v = d.baseValue * matMul * qMul * RARITY_VALUE[rarity];
  for (const a of affixes) v += 8 + Object.keys(a.mods).length * 6 + (a.grants ? 40 : 0);
  if (gem) v += gem.value;
  return Math.max(d.baseValue > 0 ? 1 : 0, Math.round(v * (v < 10 ? 10 : 1)) / (v < 10 ? 10 : 1));
}

/** Per-unit weight of an instance (material scales gear weight). */
export function itemWeight(it: Pick<ItemInstance, 'defId' | 'material'>): number {
  const d = itemDef(it.defId);
  if (!d) return 0.5;
  const m = d.matClass ? materialDef(it.material) : undefined;
  return d.weight * (m ? m.weight : 1);
}

let uidSeq = 0;

/**
 * Create an item instance. Throws for unknown def ids (callers decide how to
 * handle). Unique ids ("u_dawnbreaker") create that unique.
 */
export function createItem(defId: string, opts: CreateOpts = {}): ItemInstance {
  const uq = uniqueDef(defId);
  if (uq) return createUnique(uq, opts);
  const d = itemDef(defId);
  if (!d) throw new Error(`Unknown item def "${defId}"`);
  const seed = (opts.seed ?? hashString(defId + ':' + uidSeq++)) >>> 0;
  const rng = new Rng(seed);
  const level = clamp(Math.round(opts.level ?? (d.tier ?? 0) * 5 + 1), 1, 40);
  const style = opts.style && STYLES[opts.style] ? opts.style : 'human';
  const st = styleOf(style);
  const gear = isGear(d);
  const source = opts.source ?? 'loot';

  // --- rarity
  let rarity: Rarity = 'common';
  if (gear) {
    if (opts.rarity && RARITY_ORDER.includes(opts.rarity as Rarity) && opts.rarity !== 'unique') rarity = opts.rarity as Rarity;
    else if (source === 'crafted') rarity = rollRarity(rng.fork('rar'), level, 0.4 + (opts.craftSkill ?? 0) / 60);
    else if (source === 'outfit') rarity = rng.chance(0.08) ? 'uncommon' : 'common';
    else rarity = rollRarity(rng.fork('rar'), level, opts.luck ?? 1);
    if (opts.minRarity && RARITY_ORDER.indexOf(rarity) < RARITY_ORDER.indexOf(opts.minRarity)) rarity = opts.minRarity;
  }

  // --- material
  let mat: MaterialDef | undefined;
  if (d.matClass) {
    mat = (opts.material && materialDef(opts.material)) || (gear || d.category === 'tool' || d.category === 'light' ? pickMaterial(rng.fork('mat'), d, source === 'outfit' ? Math.max(1, level * 0.5) : level, style) : materialDef(d.baseMaterial ?? 'iron'));
    if (source === 'outfit' && !opts.material && rng.chance(0.55)) mat = materialDef(d.baseMaterial ?? mat?.id ?? 'iron') ?? mat;
  } else mat = materialDef(d.baseMaterial ?? '') ?? undefined;
  const matId = mat?.id ?? d.baseMaterial ?? 'organic';

  // --- quality
  let quality = 0.5;
  if (gear || d.category === 'tool') {
    if (opts.quality !== undefined) quality = clamp(opts.quality, 0, 1);
    else if (source === 'crafted') quality = clamp(rng.normalIn(0.15, 0.75) + (opts.craftSkill ?? 0) / 220, 0, 1);
    else quality = clamp(rng.normalIn(0.05, 0.85) + RARITY_ORDER.indexOf(rarity) * 0.05, 0, 1);
  }
  const qMul = 0.8 + quality * 0.4;

  // --- gem for jewelry / gem-set gear
  let gem: GemDef | undefined;
  const gemmed = (d.matClass === 'gem' && d.visual.shape !== 'ring.band' && d.visual.shape !== 'pendant') || d.visual.shape === 'wand' || d.visual.shape === 'staff.crystal';
  if (gemmed) {
    const tgt = level / 8;
    gem = rng.fork('gem').weighted(GEMS, (g) => (g.tier > tgt + 1 ? 0 : 1 + g.tier * 0.3));
  }

  // --- affixes
  const affixes: ItemAffix[] = [];
  let glow = mat?.glow ?? d.visual.glow ?? 0;
  let glowColor: RGB = mat?.glowColor ?? (d.visual.glowColor as RGB);
  const target = affixTarget(d);
  if (gear && target && AFFIX_COUNT[rarity] > 0) {
    const ar = rng.fork('affix');
    const n = AFFIX_COUNT[rarity];
    const usedGroups = new Set<string>();
    let pre = 0, suf = 0;
    const dtype = d.weapon?.type;
    const pool = AFFIXES.filter((a) => {
      if (!(a.targets.includes(target) || (target === 'focus' && a.targets.includes('melee') && a.group !== 'phys'))) return false;
      // Physical prefixes must match how the weapon actually hurts (no "Crushing" rapiers).
      if (a.id === 'keen') return dtype === 'slash';
      if (a.id === 'heavy') return dtype === 'blunt';
      if (a.id === 'piercing') return dtype === 'pierce';
      return true;
    });
    for (let i = 0; i < n * 3 && affixes.length < n; i++) {
      const wantPrefix = pre < 2 && (suf >= 2 || ar.chance(0.5));
      const cands = pool.filter((a) => a.prefix === wantPrefix && !usedGroups.has(a.group) && (a.minLevel ?? 0) <= level);
      if (!cands.length) continue;
      const a = ar.weighted(cands, (x) => x.weight);
      usedGroups.add(a.group);
      if (a.prefix) pre++;
      else suf++;
      const tier = clamp(Math.floor(level / 8) + (ar.chance(0.3) ? 1 : 0) - (ar.chance(0.25) ? 1 : 0) + (rarity === 'legendary' ? 1 : 0), 0, 4);
      affixes.push(makeAffix(a, tier, ar));
      if (a.glow) {
        const gl = 0.12 + tier * 0.1;
        if (gl > glow * 0.9) {
          glow = Math.max(glow, gl);
          glowColor = a.glow;
        }
      }
    }
  }

  // --- stats
  const mods: StatMods = {};
  addMods(mods, d.baseMods, d.stackable ? 1 : qMul);
  const isWeaponish = !!d.weapon && d.category !== 'light';
  if (mat && d.matClass && gear) addMods(mods, isWeaponish && !d.armor ? mat.wMods : mat.aMods);
  if (d.armor) {
    const a = d.armor.armor * (mat && d.matClass ? mat.armor : 1) * qMul * (1 + (level - 1) * 0.012);
    mods.armor = Math.round(((mods.armor ?? 0) + a) * 10) / 10;
  }
  if (gem) addMods(mods, gem.mods);
  for (const a of affixes) addMods(mods, a.mods);
  for (const k of Object.keys(mods)) if (mods[k] === 0) delete mods[k];

  let weapon: ItemInstance['weapon'];
  if (d.weapon) {
    const dm = (mat && d.matClass ? mat.damage : 1) * qMul * (1 + (level - 1) * 0.01);
    weapon = { ...d.weapon, damage: Math.round(d.weapon.damage * dm * 10) / 10 };
  }
  let tool: ItemInstance['tool'];
  if (d.tool) tool = { kind: d.tool.kind, power: Math.round(d.tool.power * (mat && d.matClass ? Math.sqrt(mat.damage * mat.durability) : 1) * qMul * 100) / 100 };

  // --- durability
  let maxDurability = Math.round(100 * (mat && d.matClass ? mat.durability : 1) * (0.7 + quality * 0.6));
  if (d.charges) maxDurability = d.charges;
  else if (d.light?.fuel) maxDurability = d.light.fuel;
  else if (!gear && d.category !== 'tool') maxDurability = 100;
  const durability = maxDurability;

  // --- name
  let name = d.name;
  const data: Record<string, string | number | boolean> = { ...(opts.data ?? {}) };
  let lore: string | undefined;
  let origin: string | undefined;
  if (gear || d.category === 'tool' || (d.category === 'light' && d.matClass)) {
    const parts: string[] = [];
    const prefix = affixes.find((a) => a.prefix);
    const suffix = affixes.find((a) => !a.prefix);
    if (prefix) parts.push(prefix.name);
    const qw = qualityWord(quality);
    if (qw && !prefix) parts.push(qw);
    if (style !== 'human' && d.matClass && rng.chance(0.5)) parts.push(st.adj);
    if (gem) parts.push(gem.name + '-set');
    if (mat && d.matClass && mat.name) parts.push(mat.name);
    parts.push(d.matClass ? stripMaterial(d.name) : d.name);
    name = parts.join(' ') + (suffix ? ' ' + suffix.name : '');
    if (rarity === 'legendary') {
      const lr = rng.fork('legend');
      const pn = legendaryName(lr, style);
      const ep = lr.pick(st.epithets);
      const base = parts.slice(parts.length - (mat?.name ? 2 : 1)).join(' ');
      data.baseName = base;
      name = ep.startsWith('the ') ? `${pn}, ${ep.charAt(0).toUpperCase()}${ep.slice(1)}` : `${pn} ${ep}`;
      lore = legendaryLore(lr, style, base);
    }
  }
  if (gem) data.gem = gem.id;

  // --- books, keys, quests
  if (d.book) {
    const br = rng.fork('book');
    if (d.book.kind === 'skill') {
      const skill = opts.skill ?? (data.skill as string) ?? br.pick(SKILL_BOOK_SKILLS);
      const b = generateBook(br, { skill, worldName: opts.worldName });
      data.skill = skill;
      data.xp = 150 + level * 40;
      data.title = b.title;
      data.author = b.author;
      name = `${b.title}`;
      lore = b.text;
    } else if (d.book.kind === 'recipe') {
      const recs = learnableRecipes();
      const r = (data.recipe && recs.find((x) => x.id === data.recipe)) || br.pick(recs);
      data.recipe = r.id;
      name = `Recipe: ${r.name}`;
      lore = `Careful notes on making ${r.name.toLowerCase()}: ${r.inputs.map((i) => `${i.count}× ${itemDef(i.id)?.name ?? i.id}`).join(', ')}${r.station ? ` at a ${r.station}` : ''}. Study it to learn the recipe.`;
    } else {
      const b = generateBook(br, { genre: d.book.kind === 'journal' ? 'diary' : undefined, worldName: opts.worldName });
      data.title = b.title;
      data.author = b.author;
      data.genre = b.genre;
      name = d.book.kind === 'journal' ? `Journal of ${b.author.split(' ')[0]}` : `${b.title}`;
      lore = b.text;
    }
  }

  // --- visuals
  const visual = makeVisual(d, mat, gem, rng.fork('vis'), style, glow, glowColor, source, quality);

  if (!origin) {
    if (source === 'crafted') origin = makersMark(rng.fork('mark'), style, 'crafted');
    else if (gear && style !== 'human') origin = makersMark(rng.fork('mark'), style, 'merchant');
  }

  const count = d.stackable ? clamp(Math.round(opts.count ?? 1), 1, d.maxStack) : 1;
  const inst: ItemInstance = {
    uid: opts.uid ?? 'i' + seed.toString(36),
    defId: d.id, count, name, rarity, quality: Math.round(quality * 1000) / 1000, material: matId, affixes, mods,
    durability, maxDurability, visual, value: computeValue(d, mat, quality, rarity, affixes, gem), level,
  };
  if (lore) inst.lore = lore;
  if (origin) inst.origin = origin;
  if (weapon) inst.weapon = weapon;
  if (tool) inst.tool = tool;
  if (Object.keys(data).length) inst.data = data;
  return inst;
}

function makeAffix(a: AffixDef, tier: number, rng: Rng): ItemAffix {
  const r = rng.float();
  const af: ItemAffix = { id: a.id + ':' + tier, name: affixName(a, tier, rng), prefix: a.prefix, mods: a.mods(tier, r) };
  const g = a.grants?.(tier);
  if (g) af.grants = g;
  return af;
}

/** Build the ItemVisual from def, material, style. */
function makeVisual(d: ItemDef, mat: MaterialDef | undefined, gem: GemDef | undefined, rng: Rng, style: string, glow: number, glowColor: RGB, source: string, quality: number): ItemVisual {
  const st = styleOf(style);
  const dv = d.visual;
  let primary = dv.primary as RGB, secondary = dv.secondary as RGB, accent = dv.accent as RGB;
  const dye = rng.pick(st.dyes), dye2 = rng.pick(st.dyes), trim = rng.pick(st.trims);
  const jit = (c: RGB, a: number): RGB => [clamp(c[0] + (rng.float() - 0.5) * a, 0, 1), clamp(c[1] + (rng.float() - 0.5) * a, 0, 1), clamp(c[2] + (rng.float() - 0.5) * a, 0, 1)];
  let family = dv.material;
  if (mat && d.matClass) {
    family = mat.family;
    switch (d.matClass) {
      case 'cloth':
        // Undyed linen/wool sometimes; otherwise culture dyes over the fibre colour.
        primary = rng.chance(0.25) ? jit(mat.color, 0.05) : mixRgb(dye, mat.color, 0.25);
        secondary = rng.chance(0.5) ? dye2 : mixRgb(mat.color2, [0.3, 0.2, 0.12], 0.5);
        accent = trim;
        break;
      case 'leather':
        primary = mixRgb(mat.color, dye, mat.id === 'fur' ? 0.05 : 0.18);
        secondary = mixRgb(dye2, mat.color2, 0.4);
        accent = trim;
        break;
      case 'wood':
        primary = jit(mat.color, 0.04);
        secondary = mixRgb(dye, [0.3, 0.2, 0.12], 0.5);
        accent = trim;
        break;
      case 'gem':
        primary = mat.color;
        secondary = mat.color2;
        accent = gem ? gem.color : trim;
        break;
      default:
        // Metal/bone/stone gear: material head, dyed grip/padding/surcoat, culture trim.
        primary = jit(mat.color, 0.025);
        secondary = d.category === 'weapon' || d.category === 'tool' ? mixRgb(dye, [0.25, 0.16, 0.09], 0.55) : dye;
        accent = gem ? gem.color : trim;
    }
  } else {
    primary = jit(primary, 0.06);
  }
  if (gem && !(d.matClass === 'gem')) accent = gem.color;
  let wear = source === 'crafted' ? 0.02 : source === 'merchant' ? rng.range(0, 0.15) : source === 'outfit' ? rng.range(0.1, 0.45) : rng.range(0.1, 0.65);
  wear = clamp(wear * (1.2 - quality * 0.5), 0, 1);
  return {
    shape: dv.shape, seed: rng.nextU32(), primary: round3(primary), secondary: round3(secondary), accent: round3(accent), material: family,
    glow: Math.round(clamp(glow, 0, 1) * 100) / 100, glowColor: round3(glowColor ?? [0, 0, 0]), wear: Math.round(wear * 100) / 100, style,
  };
}

const round3 = (c: RGB): [number, number, number] => [Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000, Math.round(c[2] * 1000) / 1000];

/** Create a unique artifact. */
function createUnique(u: UniqueDef, opts: CreateOpts): ItemInstance {
  const base = createItem(u.base, { ...opts, material: u.material, style: u.style, quality: u.quality, rarity: 'common', level: Math.max(opts.level ?? u.minLevel, u.minLevel), seed: opts.seed ?? hashString(u.id) });
  const d = itemDef(u.base)!;
  const mods: StatMods = { ...base.mods };
  addMods(mods, u.mods);
  const aff: ItemAffix = { id: u.id, name: u.name, prefix: true, mods: u.mods };
  if (u.grants) aff.grants = u.grants;
  const v = base.visual;
  if (u.primary) v.primary = u.primary;
  if (u.secondary) v.secondary = u.secondary;
  if (u.accent) v.accent = u.accent;
  if (u.glow !== undefined) v.glow = u.glow;
  if (u.glowColor) v.glowColor = u.glowColor;
  v.wear = 0.05;
  return {
    ...base, defId: d.id, name: u.name, material: u.material, rarity: 'unique', affixes: [aff], mods, lore: u.lore, origin: `${styleOf(u.style).adj} artifact`,
    value: computeValue(d, materialDef(u.material), u.quality, 'unique', [aff]), data: { ...(base.data ?? {}), unique: u.id },
  };
}

/** All unique ids (loot rolls them rarely). */
export function uniqueIds(): string[] {
  return UNIQUES.map((u) => u.id);
}
