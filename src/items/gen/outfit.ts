/**
 * NPC outfits: what a farmer, guard, mage or noble of a given race and
 * settlement wealth wears and carries. Produces a plan of def ids (+ level
 * hints); the ItemSystem turns it into equipped instances. Deterministic per
 * NPC seed, so a village always looks the same.
 *
 * Shared.
 */
import { Rng } from '../../core/rng';
import { clamp } from '../../core/math';

export interface OutfitPiece {
  defId: string;
  /** Item level hint (wealth & role). */
  level: number;
  /** Prefer this material (e.g. guards in uniform iron). */
  material?: string;
}

type Choice = string | [string, number][];

/** Per job: list of slot choices. Each choice: def id, weighted alternatives, or '' for nothing. Probability via '?p' suffix: "hat_straw?0.6". */
const JOBS: Record<string, Choice[]> = {
  farmer: [[['tunic_wool', 2], ['shirt_linen', 2], ['tunic_linen', 1]], [['trousers_wool', 2], ['trousers_linen', 1], ['breeches_leather', 1]], [['boots_leather', 2], ['shoes_leather', 1], ['sandals', 1]], 'hat_straw?0.6', 'belt_rope?0.6', 'sickle?0.35'],
  smith: [[['shirt_linen', 1], ['tunic_wool', 1]], 'vest_leather', 'trousers_wool', 'boots_leather', 'gloves_leather', 'belt_leather', 'hammer_smith?0.8'],
  merchant: [[['doublet', 3], ['coat_long', 1]], 'trousers_wool', [['shoes_leather', 2], ['boots_tall', 1]], 'belt_pouches', 'hat_wide?0.4', 'ring_signet?0.6', 'scarf_wool?0.2'],
  innkeeper: ['shirt_linen', 'vest_leather?0.7', 'trousers_wool', 'shoes_leather', 'belt_leather'],
  cook: ['shirt_linen', 'trousers_linen', 'shoes_leather', 'belt_rope', 'knife_iron?0.6'],
  guard: [[['gambeson', 3], ['hauberk_mail', 2], ['brigandine', 1], ['armor_scale', 0.5]], [['helm_nasal', 2], ['helm_kettle', 2], ['coif_mail', 1]], [['chausses_mail', 1], ['leggings_padded', 2], ['leggings_leather', 1]], 'boots_leather', [['gloves_leather', 2], ['gauntlets_mail', 1]], 'belt_leather', [['spear', 3], ['sword_short', 2], ['halberd', 1], ['sword_long', 1]], [['shield_round', 2], ['shield_kite', 2], ['', 2]], 'cloak_wool?0.3'],
  priest: [[['robe_priest', 3], ['robe_apprentice', 1]], [['sandals', 1], ['shoes_leather', 2]], [['pendant', 2], ['amulet', 1]], 'staff_quarter?0.3', 'belt_rope?0.5'],
  hunter: ['jerkin_leather', 'leggings_leather', 'boots_tall', [['hood_cloth', 2], ['hat_wide', 1]], 'bracers_leather', [['bow_short', 3], ['bow_long', 2], ['bow_recurve', 1]], 'cloak_ranger?0.5', 'knife_iron?0.5', 'belt_leather'],
  scholar: [[['robe_apprentice', 3], ['robe_mage', 1], ['doublet', 1]], 'shoes_leather', 'hat_wide?0.25', 'belt_rope?0.5'],
  mage: ['robe_mage', 'hat_pointed?0.5', [['staff_gnarled', 2], ['staff_crystal', 1], ['wand', 2]], 'circlet?0.25', 'amulet?0.4', 'shoes_leather', 'ring_gem?0.3', 'cloak_wool?0.3'],
  miner: [[['shirt_linen', 1], ['tunic_wool', 1]], 'trousers_wool', 'boots_leather', 'cap_leather?0.7', 'pick_iron', 'gloves_leather?0.5', 'belt_leather'],
  woodcutter: [[['tunic_wool', 2], ['shirt_linen', 1]], 'trousers_wool', 'boots_leather', 'axe_wood', 'gloves_leather?0.4', 'cap_leather?0.3'],
  fisher: ['shirt_linen', 'trousers_linen', [['sandals', 1], ['boots_tall', 1]], 'hat_wide?0.5', 'fishing_rod?0.7'],
  healer: [[['robe_apprentice', 2], ['tunic_linen', 1]], 'shoes_leather', 'belt_pouches', 'pendant?0.4', 'gloves_cloth?0.3'],
  bard: [[['doublet', 3], ['shirt_linen', 1]], 'trousers_wool', 'boots_tall', 'cape_silk?0.6', 'hat_wide?0.5', 'ring_band?0.4'],
  child: [[['tunic_linen', 2], ['tunic_wool', 1]], [['shoes_leather', 1], ['sandals', 1], ['', 1]]],
  elder: [[['robe_apprentice', 1], ['tunic_wool', 2]], 'cloak_wool?0.6', 'shoes_leather', 'staff_quarter?0.5', 'scarf_wool?0.3'],
  noble: [[['doublet', 2], ['gown_silk', 2], ['coat_long', 1]], 'trousers_linen', [['boots_tall', 2], ['shoes_leather', 1]], [['cape_silk', 2], ['cloak_wool', 1]], [['circlet', 3], ['crown', 0.3], ['', 3]], 'ring_signet', 'ring_gem?0.6', 'amulet?0.6', 'sword_rapier?0.5', 'sash_silk?0.4'],
  beggar: [[['tunic_linen', 2], ['shirt_linen', 1]], 'trousers_linen?0.7', 'belt_rope?0.4'],
  thief: ['jerkin_leather', 'leggings_leather', 'hood_cloth', 'mask_cloth?0.6', 'gloves_leather', [['dagger', 3], ['dagger_curved', 1]], 'boots_leather', 'belt_pouches?0.5'],
  bandit: [[['jerkin_leather', 3], ['brigandine', 1], ['hide_armor', 1], ['gambeson', 1]], [['hood_cloth', 2], ['cap_leather', 2], ['helm_nasal', 1]], 'mask_cloth?0.5', 'leggings_leather', 'boots_leather', [['axe_hand', 2], ['sword_short', 2], ['club', 2], ['mace_flanged', 1], ['bow_short', 1]], 'shield_round?0.35', 'belt_leather'],
  adventurer: [[['hauberk_mail', 2], ['brigandine', 2], ['jerkin_leather', 2], ['armor_scale', 1]], [['helm_nasal', 2], ['coif_mail', 1], ['hood_cloth', 1], ['', 1]], [['leggings_leather', 2], ['chausses_mail', 1]], [['boots_leather', 2], ['boots_tall', 1]], [['sword_long', 3], ['axe_bearded', 2], ['mace_flanged', 1], ['spear', 1]], 'shield_kite?0.5', 'belt_pouches', 'cloak_wool?0.6', 'gloves_leather?0.6'],
  pilgrim: ['tunic_wool', 'cloak_wool', 'sandals', 'staff_quarter', 'pendant?0.5'],
  herder: ['tunic_wool', 'trousers_wool', 'boots_leather', 'hat_straw?0.4', 'staff_quarter?0.6', 'cloak_wool?0.3'],
  tailor: [[['doublet', 2], ['shirt_linen', 1]], 'trousers_linen', 'shoes_leather', 'sash_silk?0.5', 'scarf_wool?0.3'],
  alchemist: [[['robe_apprentice', 2], ['coat_long', 1]], 'gloves_leather', 'mask_leather?0.3', 'shoes_leather', 'belt_pouches'],
  carpenter: ['shirt_linen', 'trousers_wool', 'boots_leather', 'belt_leather', 'hammer_smith?0.5', 'cap_leather?0.3'],
  mason: ['tunic_wool', 'trousers_wool', 'boots_leather', 'gloves_leather', 'hammer_smith?0.5'],
};

/** Racial substitutions: [from, to, probability]. */
const RACE_SWAP: Record<string, [string, string, number][]> = {
  dwarf: [['helm_kettle', 'helm_horned', 0.5], ['boots_tall', 'boots_leather', 0.8], ['hat_straw', 'cap_leather', 0.7], ['gambeson', 'hauberk_mail', 0.5], ['spear', 'axe_bearded', 0.6], ['sword_short', 'hammer_war', 0.5]],
  orc: [['tunic_wool', 'hide_armor', 0.4], ['jerkin_leather', 'hide_armor', 0.5], ['helm_nasal', 'helm_horned', 0.5], ['cap_leather', 'helm_skull', 0.3], ['shoes_leather', 'boots_fur', 0.6], ['sword_short', 'axe_hand', 0.6], ['cloak_wool', 'cloak_fur', 0.6], ['doublet', 'vest_leather', 0.8]],
  goblin: [['boots_leather', 'sandals', 0.5], ['shoes_leather', '', 0.4], ['helm_nasal', 'cap_leather', 0.6], ['sword_long', 'sword_short', 0.8], ['spear', 'dagger', 0.4], ['hood_cloth', 'mask_cloth', 0.3]],
  elf: [['tunic_wool', 'tunic_linen', 0.6], ['cloak_wool', 'cloak_ranger', 0.5], ['bow_short', 'bow_long', 0.6], ['helm_kettle', 'helm_barbute', 0.3], ['sword_short', 'sword_sabre', 0.5], ['doublet', 'gown_silk', 0.3]],
  sylvan: [['cloak_wool', 'cloak_ranger', 0.6], ['hauberk_mail', 'armor_bone', 0.4], ['boots_leather', 'sandals', 0.5], ['helm_nasal', 'hood_cloth', 0.6], ['spear', 'staff_quarter', 0.4]],
  giantkin: [['tunic_wool', 'hide_armor', 0.3], ['cloak_wool', 'cloak_fur', 0.7], ['spear', 'hammer_maul', 0.5], ['sword_short', 'club', 0.6], ['boots_leather', 'boots_fur', 0.6]],
  drakeborn: [['belt_leather', 'sash_silk', 0.5], ['gambeson', 'armor_scale', 0.5], ['spear', 'glaive', 0.4], ['cape_silk', 'cloak_wool', 0.2]],
  umbral: [['hat_wide', 'hood_cloth', 0.7], ['cloak_wool', 'cloak_ranger', 0.5], ['sword_short', 'dagger_curved', 0.5], ['circlet', 'veil_silk', 0.4], ['mask_cloth', 'veil_silk', 0.3]],
  halfling: [['boots_leather', '', 0.5], ['shoes_leather', '', 0.5], ['spear', 'sling', 0.5], ['sword_long', 'sword_short', 0.8], ['hat_straw', 'hat_wide', 0.3]],
  human: [],
};

/** Plan an outfit (def ids + level hints). */
export function outfitPlan(race: string, job: string, wealth: number, seed: number): OutfitPiece[] {
  const rng = new Rng(seed);
  const choices = JOBS[job] ?? JOBS.farmer;
  const w = clamp(wealth, 0, 1);
  // Wealthier settlements field better-made gear (and a few magical trinkets).
  const roleBoost = job === 'noble' ? 10 : job === 'guard' || job === 'adventurer' ? 6 : job === 'mage' ? 6 : job === 'beggar' ? -5 : 0;
  const level = clamp(Math.round(1 + w * 16 + roleBoost + rng.range(-2, 3)), 1, 30);
  const out: OutfitPiece[] = [];
  const swaps = RACE_SWAP[race] ?? [];
  for (const c of choices) {
    let id = '';
    if (typeof c === 'string') {
      const [base, p] = c.split('?');
      if (p === undefined || rng.chance(Number(p) * (0.6 + w * 0.6))) id = base;
    } else id = rng.weighted(c, (x) => x[1])[0];
    if (!id) continue;
    for (const [from, to, p] of swaps) if (id === from && rng.chance(p)) id = to;
    if (!id) continue;
    // Poor folk sometimes simply lack the item.
    if (w < 0.25 && job !== 'guard' && rng.chance(0.15)) continue;
    const piece: OutfitPiece = { defId: id, level };
    // Guards wear uniform iron/steel depending on wealth.
    if (job === 'guard' && /hauberk|helm|coif|chausses|gauntlets|spear|sword|halberd/.test(id)) piece.material = w > 0.6 ? 'steel' : 'iron';
    out.push(piece);
  }
  return out;
}
