/**
 * The item database: every base item (ItemDef) in Norgo.
 *
 * Bases are archetypes — "Longsword", "Mail Hauberk", "Healing Draught" —
 * and instances are rolled from them by `src/items/gen/generate.ts` with a
 * material, quality, rarity, affixes and a culture style. Numbers here are
 * the *baseline* (iron / oak / leather / linen at quality 0.5).
 *
 * `visual.shape` is the shape-family vocabulary shared with the client mesh
 * builders (`src/items/client/meshes/*`) and the wearable resolver.
 *
 * Shared (server + client): no three.js here.
 */
import type { EquipSlot, ItemCategory, ItemDef, MatClass, StatMods } from '../types';
import type { DamageType } from '../../shared/types';
import { GEMS, type RGB } from './materials';

// ------------------------------------------------------------------ helpers

const C = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

const METAL = C(0x8a8a8e), DARK = C(0x2a2622), WOOD = C(0x6a4a2c), LEATHER = C(0x5a3a22), BRASS = C(0xb08d57), CLOTH = C(0xc8bca0);

function vis(shape: string, material: string, primary: RGB, secondary: RGB = DARK, accent: RGB = BRASS, glow = 0, glowColor: RGB = [0, 0, 0]): ItemDef['visual'] {
  return { shape, material, primary, secondary, accent, glow, glowColor, wear: 0.15, style: 'human' };
}

const DEFS: ItemDef[] = [];
function add(d: ItemDef) {
  DEFS.push(d);
  return d;
}

interface WeaponSpec {
  id: string; name: string; shape: string; dmg: number; type: DamageType; speed: number; reach: number; skill: string;
  weight: number; value: number; tier: number; desc: string; two?: boolean; ranged?: boolean; cls?: MatClass; mods?: StatMods;
  slots?: EquipSlot[]; ammo?: ItemDef['ammo']; stack?: number; tags?: string[]; base?: string; requires?: Record<string, number>;
}

function weapon(w: WeaponSpec) {
  const cls = w.cls ?? 'metal';
  const primary = cls === 'wood' ? WOOD : cls === 'bone' ? C(0xd8d0b8) : METAL;
  return add({
    id: w.id, name: w.name, category: 'weapon', slots: w.slots ?? (w.two ? ['mainhand'] : ['mainhand', 'offhand']), twoHanded: w.two,
    weight: w.weight, baseValue: w.value, stackable: !!w.stack, maxStack: w.stack ?? 1,
    weapon: { damage: w.dmg, type: w.type, speed: w.speed, reach: w.reach, skill: w.skill, ranged: w.ranged },
    baseMods: w.mods, description: w.desc, matClass: cls, baseMaterial: w.base ?? (cls === 'wood' ? 'oak' : cls === 'bone' ? 'bone' : 'iron'),
    tier: w.tier, ammo: w.ammo, tags: ['weapon', w.skill, ...(w.tags ?? [])], requires: w.requires,
    visual: vis(w.shape, cls === 'wood' ? 'wood' : cls === 'bone' ? 'bone' : 'metal', primary, LEATHER, BRASS),
  });
}

// ------------------------------------------------------------------ weapons

// Blades
weapon({ id: 'dagger', name: 'Dagger', shape: 'dagger', dmg: 7, type: 'pierce', speed: 1.5, reach: 1.6, skill: 'blades', weight: 0.6, value: 18, tier: 0, desc: 'A double-edged blade for close, quick work — and for the back of a careless foe.', mods: { critChance: 0.05 } });
weapon({ id: 'dagger_curved', name: 'Curved Dagger', shape: 'dagger.curved', dmg: 7.5, type: 'slash', speed: 1.45, reach: 1.6, skill: 'blades', weight: 0.6, value: 24, tier: 1, desc: 'A wicked hooked blade favoured by desert raiders and umbral assassins.', mods: { critChance: 0.06 } });
weapon({ id: 'sword_short', name: 'Shortsword', shape: 'sword.short', dmg: 10, type: 'slash', speed: 1.25, reach: 1.9, skill: 'blades', weight: 1.2, value: 40, tier: 0, desc: 'A soldier\'s sidearm: short enough for a shield wall, long enough to matter.' });
weapon({ id: 'sword_long', name: 'Longsword', shape: 'sword.long', dmg: 13, type: 'slash', speed: 1.05, reach: 2.2, skill: 'blades', weight: 1.5, value: 75, tier: 1, desc: 'The knightly sword — a hand-and-a-half grip, a long fuller, and a cruciform guard.' });
weapon({ id: 'sword_sabre', name: 'Sabre', shape: 'sword.sabre', dmg: 12, type: 'slash', speed: 1.15, reach: 2.1, skill: 'blades', weight: 1.3, value: 70, tier: 1, desc: 'A cavalry blade with a gentle curve and a knuckle-bow guard.', mods: { attackSpeed: 0.04 } });
weapon({ id: 'sword_scimitar', name: 'Scimitar', shape: 'sword.scimitar', dmg: 12.5, type: 'slash', speed: 1.1, reach: 2.0, skill: 'blades', weight: 1.4, value: 72, tier: 1, desc: 'A deeply curved, widening blade that bites hardest near the tip.' });
weapon({ id: 'sword_rapier', name: 'Rapier', shape: 'sword.rapier', dmg: 11, type: 'pierce', speed: 1.3, reach: 2.4, skill: 'blades', weight: 1.1, value: 95, tier: 2, desc: 'A slender duelling blade behind a swept-hilt cage.', mods: { critChance: 0.04 } });
weapon({ id: 'sword_great', name: 'Greatsword', shape: 'sword.great', dmg: 22, type: 'slash', speed: 0.75, reach: 2.7, skill: 'blades', weight: 3.4, value: 140, tier: 2, two: true, desc: 'A two-handed blade as tall as a halfling, with a leather-wrapped ricasso.' });
// Axes
weapon({ id: 'axe_hand', name: 'Hand Axe', shape: 'axe.hand', dmg: 11, type: 'slash', speed: 1.1, reach: 1.8, skill: 'axes', weight: 1.3, value: 30, tier: 0, desc: 'Equally at home splitting kindling or skulls.' });
weapon({ id: 'axe_bearded', name: 'Bearded Axe', shape: 'axe.bearded', dmg: 14, type: 'slash', speed: 0.95, reach: 2.0, skill: 'axes', weight: 1.8, value: 55, tier: 1, desc: 'The long lower "beard" of the head hooks shields and ankles alike.' });
weapon({ id: 'axe_battle', name: 'Battle Axe', shape: 'axe.battle', dmg: 17, type: 'slash', speed: 0.88, reach: 2.1, skill: 'axes', weight: 2.4, value: 85, tier: 2, desc: 'A double-bitted war axe, balanced for the swing back.' });
weapon({ id: 'axe_great', name: 'Greataxe', shape: 'axe.great', dmg: 25, type: 'slash', speed: 0.68, reach: 2.6, skill: 'axes', weight: 4.2, value: 130, tier: 2, two: true, desc: 'A crescent head on a long haft. Every swing is a commitment.' });
// Blunt
weapon({ id: 'club', name: 'Cudgel', shape: 'mace.club', dmg: 9, type: 'blunt', speed: 1.05, reach: 1.9, skill: 'blunt', weight: 1.6, value: 6, tier: 0, cls: 'wood', desc: 'A knotted length of hardwood, iron-banded if you are lucky.' });
weapon({ id: 'mace_flanged', name: 'Flanged Mace', shape: 'mace.flanged', dmg: 14, type: 'blunt', speed: 0.95, reach: 1.9, skill: 'blunt', weight: 2.2, value: 60, tier: 1, desc: 'Radiating flanges concentrate each blow — the answer to plate.', mods: { 'damage.blunt': 1 } });
weapon({ id: 'mace_morningstar', name: 'Morningstar', shape: 'mace.morningstar', dmg: 15, type: 'blunt', speed: 0.9, reach: 2.0, skill: 'blunt', weight: 2.4, value: 65, tier: 1, desc: 'A spiked ball atop a stout shaft. Inelegant. Effective.', mods: { 'damage.pierce': 2 } });
weapon({ id: 'hammer_war', name: 'Warhammer', shape: 'hammer.war', dmg: 15, type: 'blunt', speed: 0.9, reach: 2.0, skill: 'blunt', weight: 2.3, value: 70, tier: 1, desc: 'A hammer face for denting helms, a back-spike for opening them.' });
weapon({ id: 'hammer_maul', name: 'Maul', shape: 'hammer.maul', dmg: 27, type: 'blunt', speed: 0.62, reach: 2.4, skill: 'blunt', weight: 5.5, value: 120, tier: 2, two: true, desc: 'A great block of a head on a long haft. Staggers anything that stands.' });
weapon({ id: 'flail', name: 'Flail', shape: 'flail', dmg: 16, type: 'blunt', speed: 0.85, reach: 2.1, skill: 'blunt', weight: 2.4, value: 75, tier: 2, desc: 'A spiked head on a chain — it swings around shields.' });
// Polearms
weapon({ id: 'spear', name: 'Spear', shape: 'spear', dmg: 14, type: 'pierce', speed: 1.0, reach: 2.9, skill: 'polearms', weight: 2.0, value: 35, tier: 0, two: true, desc: 'The oldest and most democratic weapon of war.', cls: 'metal' });
weapon({ id: 'glaive', name: 'Glaive', shape: 'glaive', dmg: 20, type: 'slash', speed: 0.8, reach: 3.0, skill: 'polearms', weight: 3.2, value: 95, tier: 2, two: true, desc: 'A single-edged blade on a long pole for sweeping cuts.' });
weapon({ id: 'halberd', name: 'Halberd', shape: 'halberd', dmg: 23, type: 'slash', speed: 0.72, reach: 3.1, skill: 'polearms', weight: 3.8, value: 120, tier: 2, two: true, desc: 'Axe, spike and hook in one — the infantry\'s answer to cavalry.' });
weapon({ id: 'staff_quarter', name: 'Quarterstaff', shape: 'staff.quarter', dmg: 11, type: 'blunt', speed: 1.15, reach: 2.4, skill: 'polearms', weight: 1.8, value: 12, tier: 0, two: true, cls: 'wood', desc: 'Iron-shod at both ends; a pilgrim\'s walking stick and a brawler\'s best friend.', mods: { 'skill.shields': 2 } });
// Magic implements
weapon({ id: 'staff_gnarled', name: 'Gnarled Staff', shape: 'staff.gnarled', dmg: 8, type: 'blunt', speed: 1.0, reach: 2.2, skill: 'blunt', weight: 1.7, value: 60, tier: 1, two: true, cls: 'wood', desc: 'A twisted root-staff, its knots worn smooth by a hedge-witch\'s hands.', mods: { spellPower: 0.1, manaRegen: 0.3 }, tags: ['focus'] });
weapon({ id: 'staff_crystal', name: 'Crystal Staff', shape: 'staff.crystal', dmg: 9, type: 'force', speed: 1.0, reach: 2.2, skill: 'blunt', weight: 1.6, value: 160, tier: 3, two: true, cls: 'wood', base: 'ash', desc: 'A focusing crystal caged in carved wood; it hums when spells gather.', mods: { spellPower: 0.16, maxMana: 15 }, tags: ['focus'] });
weapon({ id: 'staff_antler', name: 'Antler Staff', shape: 'staff.antler', dmg: 8, type: 'blunt', speed: 1.0, reach: 2.2, skill: 'blunt', weight: 1.5, value: 90, tier: 2, two: true, cls: 'wood', desc: 'Crowned with a shed antler and hung with charms — the druid\'s staff.', mods: { spellPower: 0.08, hpRegen: 0.3, 'skill.herbalism': 3 }, tags: ['focus'] });
weapon({ id: 'wand', name: 'Wand', shape: 'wand', dmg: 4, type: 'force', speed: 1.3, reach: 1.4, skill: 'blunt', weight: 0.3, value: 70, tier: 1, cls: 'wood', desc: 'A slender rod with a gem set in its tip. Spells leave it quicker.', mods: { spellPower: 0.08, castSpeed: 0.1 }, tags: ['focus'] });
// Ranged
weapon({ id: 'bow_short', name: 'Shortbow', shape: 'bow.short', dmg: 12, type: 'pierce', speed: 1.1, reach: 30, skill: 'archery', weight: 0.9, value: 35, tier: 0, two: true, ranged: true, cls: 'wood', ammo: 'arrow', desc: 'A hunter\'s bow, quick to draw from the saddle or the brush.' });
weapon({ id: 'bow_long', name: 'Longbow', shape: 'bow.long', dmg: 17, type: 'pierce', speed: 0.8, reach: 45, skill: 'archery', weight: 1.3, value: 80, tier: 1, two: true, ranged: true, cls: 'wood', base: 'yew', ammo: 'arrow', desc: 'A tall self-bow of heavy draw weight; years of practice to master.' });
weapon({ id: 'bow_recurve', name: 'Recurve Bow', shape: 'bow.recurve', dmg: 15, type: 'pierce', speed: 0.95, reach: 38, skill: 'archery', weight: 1.0, value: 95, tier: 2, two: true, ranged: true, cls: 'wood', ammo: 'arrow', desc: 'Horn, sinew and wood laminated into a compact, powerful bow.', mods: { critChance: 0.02 } });
weapon({ id: 'crossbow', name: 'Crossbow', shape: 'crossbow', dmg: 22, type: 'pierce', speed: 0.5, reach: 50, skill: 'archery', weight: 3.2, value: 110, tier: 2, two: true, ranged: true, cls: 'wood', ammo: 'bolt', desc: 'A steel prod on a wooden tiller. Slow to span; punches through mail.' });
weapon({ id: 'sling', name: 'Sling', shape: 'sling', dmg: 7, type: 'blunt', speed: 1.1, reach: 25, skill: 'archery', weight: 0.15, value: 4, tier: 0, ranged: true, cls: 'leather', base: 'leather', ammo: 'stone', desc: 'A leather cradle on two cords. Any stone becomes a missile.', slots: ['mainhand'] });
// Thrown
weapon({ id: 'throwing_knife', name: 'Throwing Knife', shape: 'throw.knife', dmg: 6, type: 'pierce', speed: 1.6, reach: 18, skill: 'throwing', weight: 0.2, value: 6, tier: 0, ranged: true, stack: 20, desc: 'Weighted toward the tip, balanced for a single spin.', slots: ['mainhand', 'offhand'] });
weapon({ id: 'throwing_axe', name: 'Throwing Axe', shape: 'throw.axe', dmg: 10, type: 'slash', speed: 1.0, reach: 15, skill: 'throwing', weight: 0.7, value: 12, tier: 1, ranged: true, stack: 10, desc: 'A light francisca that tumbles end over end.', slots: ['mainhand', 'offhand'] });
weapon({ id: 'javelin', name: 'Javelin', shape: 'javelin', dmg: 13, type: 'pierce', speed: 0.8, reach: 25, skill: 'throwing', weight: 1.0, value: 10, tier: 0, ranged: true, stack: 6, desc: 'A light spear made to be thrown, and thrown again.', slots: ['mainhand'] });

// Ammunition
function ammo(id: string, name: string, shape: string, kind: 'arrow' | 'bolt' | 'stone', value: number, desc: string, mods?: StatMods, dmg = 0, type: DamageType = 'pierce') {
  add({
    id, name, category: 'ammo', slots: [], weight: 0.05, baseValue: value, stackable: true, maxStack: 99, ammo: kind, description: desc, baseMods: mods,
    weapon: dmg ? { damage: dmg, type, speed: 1, reach: 0, skill: kind === 'stone' ? 'archery' : 'archery', ranged: true } : undefined,
    visual: vis(shape, kind === 'stone' ? 'stone' : 'wood', kind === 'stone' ? C(0x77736a) : WOOD, METAL, C(0xd8d0c0)), tags: ['ammo'],
  });
}
ammo('arrow', 'Arrow', 'ammo.arrow', 'arrow', 1, 'A goose-fletched arrow with a bodkin head.', undefined, 2);
ammo('arrow_broadhead', 'Broadhead Arrow', 'ammo.arrow', 'arrow', 2, 'A wide, barbed hunting head that leaves a bleeding wound.', { 'damage.slash': 2 }, 3, 'slash');
ammo('arrow_fire', 'Fire Arrow', 'ammo.arrow', 'arrow', 5, 'Pitch-soaked tow wrapped behind the head; light it and loose.', { 'damage.fire': 4 }, 2, 'fire');
ammo('bolt', 'Crossbow Bolt', 'ammo.bolt', 'bolt', 2, 'A stubby, square-headed quarrel.', undefined, 3);
ammo('sling_stone', 'Sling Stone', 'ammo.stone', 'stone', 0.2, 'A smooth river stone of a good weight.', undefined, 1, 'blunt');

// ------------------------------------------------------------------ shields

function shield(id: string, name: string, shape: string, armor: number, weight: number, value: number, tier: number, cls: MatClass, desc: string, mods?: StatMods) {
  add({
    id, name, category: 'armor', slots: ['offhand'], weight, baseValue: value, stackable: false, maxStack: 1,
    armor: { armor, coverage: 0.3, heaviness: weight / 12 }, weapon: { damage: 4 + weight, type: 'blunt', speed: 0.9, reach: 1.4, skill: 'shields' },
    baseMods: mods, description: desc, matClass: cls, baseMaterial: cls === 'wood' ? 'oak' : 'iron', tier, tags: ['shield', 'shields'],
    visual: vis(shape, cls === 'wood' ? 'wood' : 'metal', cls === 'wood' ? WOOD : METAL, C(0x7a2a22), BRASS),
  });
}
shield('shield_buckler', 'Buckler', 'shield.buckler', 4, 1.5, 25, 0, 'metal', 'A fist-sized steel boss for parrying — strapped to the hand, not the arm.', { 'skill.shields': 3 });
shield('shield_round', 'Round Shield', 'shield.round', 7, 4, 35, 0, 'wood', 'Planks behind an iron boss, rimmed in rawhide and painted with clan colours.');
shield('shield_kite', 'Kite Shield', 'shield.kite', 10, 5.5, 75, 1, 'wood', 'A tall, tapering shield that guards the rider\'s leg; bears the owner\'s arms.');
shield('shield_tower', 'Tower Shield', 'shield.tower', 15, 9, 120, 2, 'metal', 'A wall you carry. Arrows clatter off it like hail.', { moveSpeed: -0.05, 'resist.pierce': 8 });

// ------------------------------------------------------------------ armor & clothing

/**
 * Armor families: chest armor value at baseline + heaviness (hinders casting
 * & stealth) + governing skill. Other slots scale by SLOT_FACTOR.
 */
const FAMILY: Record<string, { cls: MatClass; armor: number; heavy: number; cat: ItemCategory; skill?: string; mat: string; color: RGB }> = {
  cloth: { cls: 'cloth', armor: 1, heavy: 0, cat: 'clothing', mat: 'linen', color: CLOTH },
  robe: { cls: 'cloth', armor: 2, heavy: 0, cat: 'clothing', mat: 'wool', color: C(0x4a4a6a) },
  padded: { cls: 'cloth', armor: 6, heavy: 0.1, cat: 'armor', skill: 'light_armor', mat: 'linen', color: C(0xb0a080) },
  leather: { cls: 'leather', armor: 8, heavy: 0.15, cat: 'armor', skill: 'light_armor', mat: 'leather', color: LEATHER },
  fur: { cls: 'leather', armor: 7, heavy: 0.2, cat: 'armor', skill: 'light_armor', mat: 'fur', color: C(0x7a6650) },
  studded: { cls: 'leather', armor: 11, heavy: 0.3, cat: 'armor', skill: 'light_armor', mat: 'hardleather', color: C(0x4a2e1a) },
  bone: { cls: 'bone', armor: 12, heavy: 0.4, cat: 'armor', skill: 'heavy_armor', mat: 'bone', color: C(0xd8d0b8) },
  chain: { cls: 'metal', armor: 15, heavy: 0.5, cat: 'armor', skill: 'heavy_armor', mat: 'iron', color: METAL },
  scale: { cls: 'metal', armor: 17, heavy: 0.55, cat: 'armor', skill: 'heavy_armor', mat: 'iron', color: METAL },
  lamellar: { cls: 'metal', armor: 19, heavy: 0.65, cat: 'armor', skill: 'heavy_armor', mat: 'steel', color: METAL },
  plate: { cls: 'metal', armor: 24, heavy: 0.85, cat: 'armor', skill: 'heavy_armor', mat: 'steel', color: C(0xa8aab0) },
};
const SLOT_FACTOR: Partial<Record<EquipSlot, number>> = {
  head: 0.45, face: 0.15, neck: 0.15, shoulders: 0.3, chest: 1, back: 0.15, wrists: 0.2, hands: 0.25, waist: 0.15, legs: 0.6, feet: 0.3,
};
const SLOT_WEIGHT: Partial<Record<EquipSlot, number>> = {
  head: 0.18, face: 0.06, neck: 0.08, shoulders: 0.15, chest: 1, back: 0.25, wrists: 0.08, hands: 0.1, waist: 0.08, legs: 0.45, feet: 0.2,
};
const FAMILY_WEIGHT: Record<string, number> = { cloth: 0.6, robe: 1.6, padded: 4, leather: 6, fur: 6, studded: 8, bone: 9, chain: 11, scale: 13, lamellar: 14, plate: 16 };
const FAMILY_VALUE: Record<string, number> = { cloth: 6, robe: 25, padded: 30, leather: 45, fur: 40, studded: 80, bone: 60, chain: 120, scale: 140, lamellar: 170, plate: 260 };

function wear(id: string, name: string, slot: EquipSlot, shape: string, family: string, desc: string, extra: Partial<ItemDef> = {}, tier = 0, armorMul = 1) {
  const f = FAMILY[family];
  const sf = SLOT_FACTOR[slot] ?? 0.2;
  const armor = Math.round(f.armor * sf * armorMul * 10) / 10;
  const def: ItemDef = {
    id, name, category: f.cat, slots: [slot], weight: Math.round(FAMILY_WEIGHT[family] * (SLOT_WEIGHT[slot] ?? 0.1) * 100) / 100,
    baseValue: Math.max(2, Math.round(FAMILY_VALUE[family] * (0.3 + sf * 0.7))), stackable: false, maxStack: 1,
    armor: { armor, coverage: sf, heaviness: f.heavy }, description: desc, matClass: f.cls, baseMaterial: f.mat, tier,
    tags: ['wearable', family, ...(f.skill ? [f.skill] : [])],
    visual: vis(shape, f.cls === 'metal' ? 'metal' : f.cls === 'bone' ? 'bone' : family === 'fur' ? 'fur' : f.cls === 'leather' ? 'leather' : 'cloth', f.color, f.cls === 'metal' ? LEATHER : C(0x3a2a1a), BRASS),
    ...extra,
  };
  if (extra.tags) def.tags = ['wearable', family, ...(f.skill ? [f.skill] : []), ...extra.tags];
  return add(def);
}

// Head
wear('hood_cloth', 'Hood', 'head', 'hood', 'cloth', 'A loose hood that keeps off rain and curious eyes.', { baseMods: { stealth: 2 } });
wear('hat_straw', 'Straw Hat', 'head', 'hat.straw', 'cloth', 'Woven from summer straw. Farmers swear by the shade.', { matClass: undefined, baseMaterial: 'linen', visual: vis('hat.straw', 'cloth', C(0xd8c078), C(0x8a6a2a), C(0x7a2a22)) });
wear('hat_wide', 'Wide-brimmed Hat', 'head', 'hat.wide', 'leather', 'A traveller\'s felt-and-leather hat with a generous brim.', { baseMods: { 'resist.frost': 1 } });
wear('hat_pointed', 'Pointed Hat', 'head', 'hat.pointed', 'robe', 'Tall, soft and slightly ridiculous. Every hedge-mage owns one.', { baseMods: { maxMana: 8 } });
wear('cap_leather', 'Leather Cap', 'head', 'cap.leather', 'leather', 'A snug cap of boiled leather with ear flaps.');
wear('coif_mail', 'Mail Coif', 'head', 'coif.mail', 'chain', 'A hood of riveted rings worn over an arming cap.');
wear('helm_nasal', 'Nasal Helm', 'head', 'helm.nasal', 'chain', 'A conical helm with a strip guarding the nose.', {}, 1, 1.15);
wear('helm_kettle', 'Kettle Hat', 'head', 'helm.kettle', 'chain', 'A wide-brimmed infantry helm that sheds arrows and rain.', {}, 1, 1.2);
wear('helm_barbute', 'Barbute', 'head', 'helm.barbute', 'plate', 'A close helm with a T-shaped face opening.', { baseMods: { perception: -2 } }, 2);
wear('helm_great', 'Great Helm', 'head', 'helm.great', 'plate', 'A flat-topped barrel helm, breathing holes and a narrow sight.', { baseMods: { perception: -5 } }, 2, 1.2);
wear('helm_horned', 'Horned Helm', 'head', 'helm.horned', 'chain', 'Iron spangenhelm crowned with curling horns. Mostly for intimidation.', { baseMods: { 'resist.psychic': 3 } }, 1, 1.1);
wear('helm_skull', 'Skull Helm', 'head', 'helm.skull', 'bone', 'The hollowed skull of something with far too many teeth.', { baseMods: { 'resist.shadow': 3 } }, 1);
// Face
wear('mask_cloth', 'Face Scarf', 'face', 'mask.cloth', 'cloth', 'A wrap across mouth and nose against dust — or witnesses.', { baseMods: { stealth: 3 } });
wear('mask_leather', 'Leather Mask', 'face', 'mask.leather', 'leather', 'A stitched half-mask with dark lenses.', { baseMods: { stealth: 2, 'resist.poison': 3 } });
wear('mask_bone', 'Bone Mask', 'face', 'mask.bone', 'bone', 'A carved ritual mask of polished bone.', { baseMods: { 'resist.psychic': 4 } });
wear('mask_metal', 'Visage', 'face', 'mask.metal', 'plate', 'A hammered face plate cast in a serene, inhuman expression.', {}, 2, 1.5);
wear('veil_silk', 'Veil', 'face', 'veil', 'cloth', 'Gauzy silk that hides the face but not the eyes.', { baseMaterial: 'silk', baseMods: { 'skill.speech': 2 } });
// Neck (armor & cloth; amulets are jewelry below)
wear('gorget_plate', 'Gorget', 'neck', 'gorget', 'plate', 'A steel collar for the throat — the one place nobody forgives.', {}, 1, 1.5);
wear('scarf_wool', 'Wool Scarf', 'neck', 'scarf', 'cloth', 'Knitted by someone who cared.', { baseMaterial: 'wool', baseMods: { 'resist.frost': 3 } });
// Shoulders
wear('mantle_fur', 'Fur Mantle', 'shoulders', 'mantle.fur', 'fur', 'A pelt across the shoulders, the head still attached.', { baseMods: { 'resist.frost': 4 } });
wear('pauldrons_leather', 'Leather Pauldrons', 'shoulders', 'pauldron.leather', 'leather', 'Layered leather shoulder guards.');
wear('spaulders_scale', 'Scale Spaulders', 'shoulders', 'pauldron.scale', 'scale', 'Overlapping scales riveted to leather.', {}, 1);
wear('pauldrons_plate', 'Plate Pauldrons', 'shoulders', 'pauldron.plate', 'plate', 'Articulated lames fanning over the shoulder.', {}, 2);
wear('pauldrons_bone', 'Bone Pauldrons', 'shoulders', 'pauldron.bone', 'bone', 'Shoulder blades of a great beast, lashed with sinew.', {}, 1);
// Chest
wear('shirt_linen', 'Linen Shirt', 'chest', 'shirt', 'cloth', 'A plain shirt with a laced collar.');
wear('tunic_linen', 'Linen Tunic', 'chest', 'tunic', 'cloth', 'A knee-length tunic belted at the waist. Practical and cool.');
wear('tunic_wool', 'Wool Tunic', 'chest', 'tunic', 'cloth', 'Thick, scratchy, warm.', { baseMaterial: 'wool' });
wear('vest_leather', 'Leather Vest', 'chest', 'vest', 'leather', 'A sleeveless leather vest with horn buttons.', {}, 0, 0.5);
wear('doublet', 'Doublet', 'chest', 'doublet', 'padded', 'A fitted, quilted jacket in the townsman\'s fashion.', { baseMaterial: 'cotton', baseMods: { 'skill.speech': 2 } }, 1, 0.7);
wear('robe_apprentice', 'Apprentice Robe', 'chest', 'robe.short', 'robe', 'A simple, hip-length robe with deep sleeves and ink stains.', { baseMods: { maxMana: 10 } });
wear('robe_mage', 'Mage Robe', 'chest', 'robe.long', 'robe', 'Floor-length, embroidered with sigils that are slightly too symmetrical.', { baseMods: { maxMana: 20, spellPower: 0.05 } }, 1);
wear('robe_priest', 'Vestments', 'chest', 'robe.long', 'robe', 'Ceremonial vestments with a stole in temple colours.', { baseMaterial: 'linen', baseMods: { maxMana: 12, 'resist.shadow': 4 } }, 1);
wear('gown_silk', 'Gown', 'chest', 'robe.gown', 'robe', 'A flowing gown for courts and feasts.', { baseMaterial: 'silk', baseMods: { 'skill.speech': 4 } }, 2);
wear('coat_long', 'Long Coat', 'chest', 'coat.long', 'leather', 'A heavy coat with split tails for riding.', { baseMods: { 'resist.frost': 3 } }, 1, 0.8);
wear('gambeson', 'Gambeson', 'chest', 'gambeson', 'padded', 'Dozens of quilted linen layers. Stops more than you would think.');
wear('jerkin_leather', 'Leather Jerkin', 'chest', 'jerkin', 'leather', 'A sleeveless leather coat, buckled at the side.');
wear('brigandine', 'Brigandine', 'chest', 'brigandine', 'studded', 'Small steel plates riveted inside a cloth-faced coat.', {}, 1);
wear('hide_armor', 'Hide Armor', 'chest', 'hide', 'fur', 'Thick furs over boiled hide, belted with bone toggles.', { baseMods: { 'resist.frost': 5 } });
wear('hauberk_mail', 'Mail Hauberk', 'chest', 'hauberk', 'chain', 'Thirty thousand riveted rings, knee-length, split for riding.', {}, 1);
wear('armor_scale', 'Scale Armor', 'chest', 'scale', 'scale', 'Fish-scale plates on a leather backing; rustles like dry leaves.', {}, 2);
wear('armor_lamellar', 'Lamellar Cuirass', 'chest', 'lamellar', 'lamellar', 'Rows of small plates laced together in silk cord.', {}, 2);
wear('cuirass_plate', 'Plate Cuirass', 'chest', 'cuirass', 'plate', 'Breast- and backplate with a fauld of lames.', {}, 3);
wear('armor_bone', 'Bone Harness', 'chest', 'harness.bone', 'bone', 'Ribs and plates of bone lashed over hide.', {}, 1);
// Back
wear('cloak_wool', 'Travel Cloak', 'back', 'cloak', 'cloth', 'A hooded wool cloak, clasped at the shoulder.', { baseMaterial: 'wool', baseMods: { 'resist.frost': 3 } });
wear('cloak_fur', 'Fur Cloak', 'back', 'cloak.fur', 'fur', 'A great pelt worn as a cloak. Warm as a hearth.', { baseMods: { 'resist.frost': 8 } });
wear('cape_silk', 'Cape', 'back', 'cape', 'cloth', 'A short shoulder cape. Mostly for show.', { baseMaterial: 'silk', baseMods: { 'skill.speech': 2 } }, 1);
wear('cloak_ranger', 'Ranger\'s Cloak', 'back', 'cloak', 'cloth', 'Mottled greens and browns; you lose sight of its wearer among the trees.', { baseMaterial: 'wool', baseMods: { stealth: 5 } }, 1);
// Wrists
wear('wraps_cloth', 'Arm Wraps', 'wrists', 'wraps', 'cloth', 'Strips of cloth bound around the forearms.', { baseMods: { 'skill.unarmed': 2 } });
wear('bracers_leather', 'Leather Bracers', 'wrists', 'bracers.leather', 'leather', 'Laced forearm guards — an archer\'s staple.', { baseMods: { 'skill.archery': 2 } });
wear('bracers_metal', 'Banded Bracers', 'wrists', 'bracers.metal', 'chain', 'Iron bands riveted to leather cuffs.', {}, 1);
wear('vambraces_plate', 'Plate Vambraces', 'wrists', 'vambraces', 'plate', 'Tubular forearm plates hinged and strapped.', {}, 2);
// Hands
wear('gloves_cloth', 'Wool Gloves', 'hands', 'gloves.cloth', 'cloth', 'Fingerless, darned, warm.', { baseMaterial: 'wool' });
wear('gloves_leather', 'Leather Gloves', 'hands', 'gloves.leather', 'leather', 'Supple gloves with reinforced palms.');
wear('gauntlets_mail', 'Mail Mittens', 'hands', 'gauntlets.mail', 'chain', 'Mail mittens with leather palms.', {}, 1);
wear('gauntlets_plate', 'Plate Gauntlets', 'hands', 'gauntlets.plate', 'plate', 'Articulated fingers and a flared cuff.', { baseMods: { 'skill.unarmed': 3 } }, 2);
// Waist
wear('belt_rope', 'Rope Belt', 'waist', 'belt.rope', 'cloth', 'A length of rope knotted at the hip.', { baseMods: { carry: 2 } });
wear('belt_leather', 'Leather Belt', 'waist', 'belt.leather', 'leather', 'A broad belt with a cast buckle and a small pouch.', { baseMods: { carry: 6 } });
wear('belt_pouches', 'Adventurer\'s Belt', 'waist', 'belt.pouches', 'leather', 'Pouches, loops and a scabbard frog. Everything within reach.', { baseMods: { carry: 15 } }, 1);
wear('sash_silk', 'Silk Sash', 'waist', 'sash', 'cloth', 'A long sash wound twice around the waist, its ends hanging.', { baseMaterial: 'silk', baseMods: { 'skill.speech': 1 } });
wear('belt_plated', 'Plated Girdle', 'waist', 'belt.plated', 'plate', 'A war belt hung with steel tassets.', { baseMods: { carry: 5 } }, 2, 2);
// Legs
wear('trousers_wool', 'Wool Trousers', 'legs', 'trousers', 'cloth', 'Sturdy trousers with a drawstring waist.', { baseMaterial: 'wool' });
wear('trousers_linen', 'Linen Trousers', 'legs', 'trousers', 'cloth', 'Light summer trousers.');
wear('breeches_leather', 'Leather Breeches', 'legs', 'breeches', 'leather', 'Knee breeches of soft leather.', {}, 0, 0.7);
wear('kilt', 'Kilt', 'legs', 'kilt', 'cloth', 'Pleated wool in clan tartan.', { baseMaterial: 'wool', baseMods: { moveSpeed: 0.01 } });
wear('leggings_padded', 'Padded Leggings', 'legs', 'leggings.padded', 'padded', 'Quilted hose worn under mail.');
wear('leggings_leather', 'Leather Leggings', 'legs', 'leggings.leather', 'leather', 'Hard leather leggings with knee cops.');
wear('chausses_mail', 'Mail Chausses', 'legs', 'chausses', 'chain', 'Mail leggings laced to the belt.', {}, 1);
wear('leggings_scale', 'Scale Leggings', 'legs', 'leggings.scale', 'scale', 'Scaled tassets and greaves.', {}, 2);
wear('legplates', 'Plate Legguards', 'legs', 'legplates', 'plate', 'Cuisses, poleyns and greaves. Each step clanks.', {}, 3);
// Feet
wear('sandals', 'Sandals', 'feet', 'sandals', 'leather', 'Thong sandals. Desert-cool, mountain-cold.', { baseMods: { moveSpeed: 0.01 } }, 0, 0.3);
wear('shoes_leather', 'Shoes', 'feet', 'shoes', 'leather', 'Turnshoes of soft leather.', {}, 0, 0.6);
wear('boots_leather', 'Leather Boots', 'feet', 'boots.leather', 'leather', 'Calf-high boots with hobnailed soles.');
wear('boots_tall', 'Riding Boots', 'feet', 'boots.tall', 'leather', 'Knee-high boots, folded at the top.', { baseMods: { moveSpeed: 0.02 } }, 1);
wear('boots_fur', 'Fur Boots', 'feet', 'boots.fur', 'fur', 'Fur-lined boots with the fur turned out at the cuff.', { baseMods: { 'resist.frost': 4 } });
wear('sabatons', 'Sabatons', 'feet', 'sabatons', 'plate', 'Pointed, articulated plate shoes.', { baseMods: { moveSpeed: -0.02 } }, 2);

// ------------------------------------------------------------------ jewelry & trinkets

function jewel(id: string, name: string, slots: EquipSlot[], shape: string, value: number, desc: string, mods?: StatMods, tier = 0) {
  add({
    id, name, category: 'jewelry', slots, weight: 0.05, baseValue: value, stackable: false, maxStack: 1, baseMods: mods, description: desc,
    matClass: 'gem', baseMaterial: 'silver', tier, tags: ['jewelry'], visual: vis(shape, 'metal', C(0xd0d2d8), C(0x808288), C(0x8a1a2a)),
  });
}
jewel('ring_band', 'Band', ['ring1', 'ring2'], 'ring.band', 20, 'A plain band, worn smooth.');
jewel('ring_signet', 'Signet Ring', ['ring1', 'ring2'], 'ring.signet', 45, 'A heavy ring with an engraved seal for wax.', { 'skill.speech': 2 });
jewel('ring_gem', 'Gem Ring', ['ring1', 'ring2'], 'ring.gem', 70, 'A raised claw setting holds a cut stone.', undefined, 1);
jewel('amulet', 'Amulet', ['neck'], 'amulet', 60, 'A gem-set medallion on a fine chain.', undefined, 1);
jewel('pendant', 'Pendant', ['neck'], 'pendant', 35, 'A small carved pendant on a leather cord.');
jewel('torc', 'Torc', ['neck'], 'torc', 80, 'A rigid twisted neck ring, open at the front with knobbed terminals.', { maxHp: 5 }, 1);
jewel('circlet', 'Circlet', ['head'], 'circlet', 90, 'A thin band worn on the brow, a single stone at its centre.', { maxMana: 8 }, 1);
jewel('crown', 'Crown', ['head'], 'crown', 400, 'A crown of tines and stones. Heavy, in every sense.', { 'skill.speech': 6 }, 3);

function trinket(id: string, name: string, shape: string, value: number, desc: string, mods: StatMods, mat = 'wood', primary: RGB = WOOD, extra: Partial<ItemDef> = {}) {
  add({
    id, name, category: 'trinket', slots: ['trinket'], weight: 0.2, baseValue: value, stackable: false, maxStack: 1, baseMods: mods, description: desc,
    tags: ['trinket'], visual: vis(shape, mat, primary, DARK, BRASS), ...extra,
  });
}
trinket('charm_rabbit', 'Rabbit\'s Foot', 'trinket.charm', 15, 'Not lucky for the rabbit.', { critChance: 0.02 }, 'fur', C(0xb8a890));
trinket('idol_bone', 'Bone Idol', 'trinket.idol', 40, 'A squat figure carved from knucklebone; its eyes follow you.', { 'resist.shadow': 5, maxMana: 5 }, 'bone', C(0xd8d0b8));
trinket('compass_brass', 'Brass Compass', 'trinket.compass', 60, 'Its needle points to true north — usually.', { perception: 4, moveSpeed: 0.01 }, 'metal', BRASS);
trinket('lucky_coin', 'Lucky Coin', 'trinket.coin', 25, 'An ancient coin with a hole punched through. Heads every time.', { 'skill.barter': 3 }, 'metal', C(0xd8b050));
trinket('totem_wood', 'Spirit Totem', 'trinket.totem', 45, 'A carved animal spirit, feathers bound at its base.', { hpRegen: 0.2, 'skill.foraging': 2 }, 'wood', WOOD);
trinket('orb_glass', 'Scrying Orb', 'trinket.orb', 120, 'A palm-sized sphere of clouded glass; mists swirl inside.', { spellPower: 0.05, perception: 3 }, 'glass', C(0xa0c8e8), { slots: ['trinket', 'offhand'], tags: ['trinket', 'focus'] });
trinket('hourglass', 'Pocket Hourglass', 'trinket.hourglass', 90, 'The sand falls a little slower when you need it to.', { castSpeed: 0.05, attackSpeed: 0.03 }, 'glass', BRASS);
trinket('feather_charm', 'Feather Charm', 'trinket.charm', 30, 'Three bright feathers bound with copper wire.', { jump: 0.05 }, 'fur', C(0x4a8ac8));
trinket('music_box', 'Music Box', 'trinket.box', 75, 'A tiny tin melody that calms frayed nerves.', { 'resist.psychic': 6, 'skill.speech': 2 }, 'wood', C(0x7a4a2a));

// ------------------------------------------------------------------ tools & lights

function tool(id: string, name: string, shape: string, kind: NonNullable<ItemDef['tool']>['kind'], power: number, weight: number, value: number, desc: string, dmg: number, dtype: DamageType, skill: string, extra: Partial<ItemDef> = {}) {
  add({
    id, name, category: 'tool', slots: ['mainhand'], weight, baseValue: value, stackable: false, maxStack: 1, tool: { kind, power },
    weapon: { damage: dmg, type: dtype, speed: 1, reach: 1.8, skill }, description: desc, matClass: 'metal', baseMaterial: 'iron', tier: 0,
    tags: ['tool', kind], visual: vis(shape, 'metal', METAL, WOOD, BRASS), ...extra,
  });
}
tool('pick_iron', 'Pickaxe', 'pick', 'pick', 1, 2.5, 25, 'A miner\'s pick: point for rock, flat for prying.', 8, 'pierce', 'blunt', { tags: ['tool', 'pick', 'mining'] });
tool('axe_wood', 'Woodcutter\'s Axe', 'axe.wood', 'axe', 1, 2.2, 22, 'A long-hafted felling axe with a thin, wedge-ground bit.', 10, 'slash', 'axes', { tags: ['tool', 'axe', 'woodcutting'] });
tool('shovel', 'Shovel', 'shovel', 'shovel', 1, 2.0, 15, 'Moves earth. Buries secrets.', 6, 'blunt', 'blunt', { tags: ['tool', 'shovel', 'digging'] });
tool('sickle', 'Sickle', 'sickle', 'sickle', 1, 0.6, 12, 'A crescent blade for reaping grain and herbs alike.', 6, 'slash', 'blades', { tags: ['tool', 'sickle', 'herbalism'], slots: ['mainhand', 'offhand'] });
tool('fishing_rod', 'Fishing Rod', 'rod.fishing', 'rod', 1, 1.0, 10, 'A springy rod, line and a bone hook.', 1, 'blunt', 'blunt', { matClass: 'wood', baseMaterial: 'ash', tags: ['tool', 'rod', 'fishing'], visual: vis('rod.fishing', 'wood', C(0x9a7a4a), C(0xd8d0c0), METAL) });
tool('hammer_smith', 'Smith\'s Hammer', 'hammer.smith', 'hammer', 1, 1.4, 18, 'A cross-peen hammer with a wear-polished face.', 8, 'blunt', 'blunt', { tags: ['tool', 'hammer', 'smithing'] });
tool('knife_iron', 'Knife', 'knife', 'knife', 1, 0.3, 8, 'A sturdy utility knife: skinning, whittling, bread and, in a pinch, defence.', 6, 'slash', 'blades', { slots: ['mainhand', 'offhand'], tags: ['tool', 'knife', 'cooking'] });
add({
  id: 'lockpicks', name: 'Lockpicks', category: 'tool', slots: [], weight: 0.1, baseValue: 20, stackable: true, maxStack: 20, tool: { kind: 'lockpick', power: 1 },
  description: 'A tension wrench and a ring of slender picks. Each one breaks eventually.', tags: ['tool', 'lockpick'],
  visual: vis('lockpick', 'metal', METAL, LEATHER, BRASS),
});

add({
  id: 'torch', name: 'Torch', category: 'light', slots: ['offhand', 'mainhand'], weight: 0.6, baseValue: 2, stackable: true, maxStack: 10,
  light: { radius: 10, color: [1, 0.62, 0.28], fuel: 900 }, weapon: { damage: 3, type: 'fire', speed: 1, reach: 1.6, skill: 'blunt' },
  description: 'Pitch-soaked rags on a stick. Burns for a quarter hour; keeps the dark — and some of what lives in it — at bay.',
  baseMods: { lightRadius: 10 }, tags: ['light', 'fire'], visual: vis('torch', 'wood', WOOD, C(0x3a3020), C(0xffa040), 1, [1, 0.55, 0.2]),
});
add({
  id: 'lantern', name: 'Lantern', category: 'light', slots: ['offhand'], weight: 1.2, baseValue: 30, stackable: false, maxStack: 1,
  light: { radius: 14, color: [1, 0.78, 0.5], fuel: 3600 }, description: 'A horn-paned lantern with a wire bail. Steadier than any torch.',
  baseMods: { lightRadius: 14 }, matClass: 'metal', baseMaterial: 'bronze', tags: ['light'], visual: vis('lantern', 'metal', BRASS, DARK, C(0xffc070), 1, [1, 0.7, 0.35]),
});
add({
  id: 'lantern_crystal', name: 'Glowstone Lantern', category: 'light', slots: ['offhand'], weight: 0.8, baseValue: 140, stackable: false, maxStack: 1, tier: 3,
  light: { radius: 16, color: [0.55, 0.85, 1] }, description: 'A cage of silver around a cave crystal that never dims.',
  baseMods: { lightRadius: 16, perception: 2 }, matClass: 'metal', baseMaterial: 'silver', tags: ['light'], visual: vis('lantern', 'metal', C(0xd0d2d8), DARK, C(0x80d0ff), 1, [0.5, 0.85, 1]),
});

// ------------------------------------------------------------------ consumables

type Eff = { id: string; magnitude: number; duration: number };
function consumable(id: string, name: string, category: ItemCategory, shape: string, mat: string, primary: RGB, value: number, weight: number, effects: Eff[], desc: string, extra: Partial<ItemDef> = {}, accent: RGB = BRASS, glow = 0) {
  add({
    id, name, category, slots: [], weight, baseValue: value, stackable: true, maxStack: extra.maxStack ?? 20, consumable: { effects }, description: desc,
    tags: [category], visual: vis(shape, mat, primary, DARK, accent, glow, glow ? primary : [0, 0, 0]), ...extra,
  });
}
const e = (id: string, magnitude: number, duration = 0): Eff => ({ id, magnitude, duration });

// Food (restore_* are instant; regen/well_fed are timed effects)
consumable('bread', 'Bread', 'food', 'food.bread', 'organic', C(0xc08a4a), 2, 0.3, [e('restore_hp', 12), e('restore_stamina', 25), e('well_fed', 1, 300)], 'A dense round loaf with a cross cut into the crust.');
consumable('meat_cooked', 'Roast Meat', 'food', 'food.meat', 'organic', C(0x7a3a1a), 4, 0.4, [e('restore_hp', 22), e('regen_hp', 1, 20), e('well_fed', 1, 450)], 'Charred outside, juicy within. Smells like a campfire evening.');
consumable('meat_raw', 'Raw Meat', 'food', 'food.meat', 'organic', C(0xb03a3a), 1, 0.4, [e('restore_hp', 4), e('poison', 1.5, 6)], 'Better cooked. Much better cooked.', { tags: ['food', 'material', 'raw'] });
consumable('fish_raw', 'Raw Fish', 'food', 'food.fish', 'organic', C(0x8a9aa8), 1, 0.4, [e('restore_hp', 4)], 'Still glistening.', { tags: ['food', 'material', 'raw'] });
consumable('fish_cooked', 'Grilled Fish', 'food', 'food.fish', 'organic', C(0xb0804a), 4, 0.35, [e('restore_hp', 18), e('regen_mana', 0.5, 30), e('well_fed', 1, 400)], 'Crisp skin, flaky flesh, a squeeze of something sour.');
consumable('berries', 'Berries', 'food', 'food.fruit', 'organic', C(0x6a1a4a), 1, 0.1, [e('restore_hp', 5), e('restore_stamina', 10)], 'A handful of wild berries, sweet-tart and staining.', { maxStack: 50, tags: ['food', 'material', 'harvest'] });
consumable('apple', 'Apple', 'food', 'food.apple', 'organic', C(0xb02a1a), 1, 0.15, [e('restore_hp', 6), e('restore_stamina', 15)], 'Crisp and a little sour.');
consumable('cheese', 'Cheese Wedge', 'food', 'food.cheese', 'organic', C(0xe8c060), 5, 0.3, [e('restore_hp', 15), e('well_fed', 1, 500)], 'Sharp, crumbly, rind waxed in red.');
consumable('stew', 'Hearty Stew', 'food', 'food.stew', 'organic', C(0x7a4a22), 8, 0.6, [e('restore_hp', 35), e('regen_stamina', 2, 60), e('well_fed', 2, 900)], 'Meat, roots and herbs simmered until the spoon stands up.', { maxStack: 5 });
consumable('pie_berry', 'Berry Pie', 'food', 'food.pie', 'organic', C(0xd0a060), 9, 0.5, [e('restore_hp', 25), e('restore_stamina', 40), e('well_fed', 2, 800)], 'A lattice crust oozing dark berry syrup.', { maxStack: 5 });
consumable('honey', 'Jar of Honey', 'food', 'food.jar', 'glass', C(0xe0a020), 6, 0.4, [e('restore_hp', 10), e('regen_hp', 1, 30), e('cure_poison', 1)], 'Wildflower honey. Soothes throats and, they say, wounds.');
consumable('mushroom_edible', 'Field Mushroom', 'food', 'food.mushroom', 'organic', C(0xd8c8a8), 1, 0.1, [e('restore_hp', 4)], 'A pale-capped mushroom with pink gills. Probably safe.', { maxStack: 50, tags: ['food', 'material', 'harvest', 'reagent'] });
consumable('cactus_flesh', 'Cactus Flesh', 'food', 'food.fruit', 'organic', C(0x6a9a3a), 1, 0.2, [e('restore_stamina', 15), e('resist_fire', 5, 60)], 'Peeled, slimy, wonderfully cool on a desert afternoon.', { maxStack: 50, tags: ['food', 'material', 'harvest'] });
consumable('waterskin', 'Waterskin', 'food', 'waterskin', 'leather', C(0x6a4a2a), 3, 0.8, [e('restore_stamina', 35), e('regen_stamina', 2, 15)], 'A goatskin bag of water. Refill it at any river or lake.', { stackable: false, maxStack: 1, charges: 5 });
consumable('ale', 'Mug of Ale', 'food', 'food.mug', 'wood', C(0xc08a2a), 2, 0.5, [e('restore_stamina', 20), e('courage', 1, 120), e('clumsy', 1, 60)], 'Brown, foamy, warm. Courage in a cup.');
consumable('wine', 'Bottle of Wine', 'food', 'potion.bottle', 'glass', C(0x5a0a1a), 10, 0.8, [e('restore_hp', 8), e('regen_mana', 0.4, 60)], 'A dusty bottle of something red from a hillside vineyard.');

// Potions & elixirs
function potion(id: string, name: string, shape: string, color: RGB, value: number, effects: Eff[], desc: string, tier = 0) {
  consumable(id, name, 'consumable', shape, 'glass', color, value, 0.3, effects, desc, { tier, tags: ['consumable', 'potion'] }, C(0x8a5a2a), 0.35);
}
potion('potion_heal_minor', 'Minor Healing Draught', 'potion.round', [0.85, 0.1, 0.12], 15, [e('restore_hp', 30)], 'Red and faintly sweet; knits small wounds in moments.');
potion('potion_heal', 'Healing Draught', 'potion.round', [0.9, 0.08, 0.1], 40, [e('restore_hp', 70), e('regen_hp', 2, 10)], 'The surgeon\'s friend. Burns going down; worth it.', 1);
potion('potion_heal_greater', 'Greater Healing Draught', 'potion.flask', [1, 0.15, 0.2], 110, [e('restore_hp', 160), e('regen_hp', 4, 15)], 'Thick and glowing; bones set themselves with an audible click.', 3);
potion('potion_mana_minor', 'Minor Mana Tonic', 'potion.round', [0.15, 0.3, 0.95], 18, [e('restore_mana', 30)], 'Tastes of copper and rain.');
potion('potion_mana', 'Mana Tonic', 'potion.round', [0.12, 0.25, 1], 45, [e('restore_mana', 70), e('regen_mana', 1, 15)], 'Blue as a glacier crevasse; your fingertips tingle.', 1);
potion('potion_mana_greater', 'Greater Mana Tonic', 'potion.flask', [0.3, 0.4, 1], 120, [e('restore_mana', 160), e('regen_mana', 2, 20)], 'Starlight in a bottle, or something close.', 3);
potion('potion_stamina', 'Stamina Brew', 'potion.round', [0.2, 0.8, 0.2], 25, [e('restore_stamina', 80), e('regen_stamina', 4, 30)], 'Bitter, green, and makes your heart race.');
potion('antidote', 'Antidote', 'potion.tall', [0.75, 0.85, 0.5], 20, [e('cure_poison', 1), e('resist_poison', 20, 120)], 'Cloudy and chalky. Purges venom and rot.');
potion('potion_fire_resist', 'Emberward Potion', 'potion.tall', [1, 0.45, 0.1], 50, [e('resist_fire', 40, 180)], 'Smoky orange; your skin feels like hot stone afterwards.', 1);
potion('potion_frost_resist', 'Hearthblood Potion', 'potion.tall', [0.8, 0.25, 0.05], 50, [e('resist_frost', 40, 180)], 'Warms you from the belly outward for hours.', 1);
potion('potion_shock_resist', 'Groundling Potion', 'potion.tall', [0.9, 0.9, 0.3], 50, [e('resist_shock', 40, 180)], 'Tastes of iron filings and thunderstorms.', 1);
potion('potion_invisibility', 'Draught of Unseeing', 'potion.flask', [0.75, 0.8, 0.9], 140, [e('invisibility', 1, 30)], 'Clear as air — you can barely see the bottle, then not your hand.', 3);
potion('potion_haste', 'Quicksilver Draught', 'potion.flask', [0.75, 0.75, 0.8], 80, [e('haste', 0.3, 30)], 'Liquid metal that runs uphill. So will you.', 2);
potion('potion_waterbreath', 'Gillwort Draught', 'potion.tall', [0.2, 0.7, 0.65], 45, [e('swim_boost', 1, 180), e('water_breathing', 1, 180)], 'Briny; you feel faint slits open behind your ears.', 1);
potion('potion_featherfall', 'Featherfall Philter', 'potion.round', [0.9, 0.9, 1], 40, [e('featherfall', 1, 60)], 'Weightless in the hand. Drink it before you jump, not after.', 1);
potion('potion_levitation', 'Skyreach Philter', 'potion.flask', [0.7, 0.85, 1], 120, [e('levitate', 1, 20)], 'Bubbles rise inside it forever. Soon, so will you.', 3);
potion('potion_nightsight', 'Owl\'s Eye Tincture', 'potion.tall', [0.55, 0.4, 0.75], 35, [e('night_vision', 1, 300)], 'Your pupils swell until the dark turns grey and friendly.', 1);
potion('potion_poison', 'Vial of Venom', 'potion.vial', [0.3, 0.75, 0.1], 30, [e('poison', 3, 10)], 'For blades, not lips. (Drinking it is a bad idea.)');
potion('elixir_strength', 'Elixir of the Ox', 'potion.vial', [0.7, 0.35, 0.15], 150, [e('strength', 0.25, 600)], 'Dark and heavy; your muscles thicken and your carry-sack lightens.', 2);
potion('elixir_fortitude', 'Elixir of Fortitude', 'potion.vial', [0.9, 0.5, 0.2], 180, [e('fortitude', 40, 600)], 'Your skin takes on the toughness of old leather for a while.', 3);
potion('elixir_clarity', 'Elixir of Clarity', 'potion.vial', [0.6, 0.9, 1], 180, [e('clarity', 0.2, 600)], 'Thoughts snap into focus; spells come easier.', 3);
potion('elixir_leaping', 'Elixir of the Hare', 'potion.vial', [0.6, 0.8, 0.3], 90, [e('leap_boost', 1, 300)], 'Your legs twitch to jump. Let them.', 2);
potion('elixir_luck', 'Elixir of Fortune', 'potion.vial', [1, 0.85, 0.3], 220, [e('luck', 1, 900)], 'Gold-flecked and fizzing. Things just... go your way.', 4);

// Scrolls (one-use spells)
function scroll(id: string, name: string, color: RGB, value: number, effects: Eff[], desc: string, tier = 1) {
  consumable(id, name, 'consumable', 'scroll', 'cloth', [0.86, 0.8, 0.64], value, 0.1, effects, desc, { tier, tags: ['consumable', 'scroll'] }, color, 0.4);
}
scroll('scroll_recall', 'Scroll of Recall', [0.6, 0.8, 1], 90, [e('recall', 1)], 'Reading it aloud folds the road between you and home.', 2);
scroll('scroll_firestorm', 'Scroll of Firestorm', [1, 0.4, 0.1], 120, [e('firestorm', 45)], 'The words are hot to the tongue. Everything near you burns — except you.', 3);
scroll('scroll_light', 'Scroll of Everlight', [1, 0.95, 0.7], 30, [e('light', 12, 600)], 'Summons a mote of light that follows you for ten minutes.', 0);
scroll('scroll_featherfall', 'Scroll of Featherfall', [0.9, 0.9, 1], 35, [e('featherfall', 1, 120)], 'Your weight forgets itself for a while.', 1);
scroll('scroll_haste', 'Scroll of Swiftness', [0.8, 1, 0.6], 60, [e('haste', 0.35, 45)], 'The world slows; you do not.', 2);
scroll('scroll_ward', 'Scroll of Warding', [0.5, 0.7, 1], 70, [e('fortify_armor', 25, 120)], 'A shimmering skin of force hardens around you.', 2);
scroll('scroll_reveal', 'Scroll of Revealing', [1, 0.85, 0.4], 50, [e('reveal', 25, 120)], 'Hidden things shine faintly for those who read it.', 1);
scroll('scroll_waterwalk', 'Scroll of Waterwalking', [0.4, 0.8, 1], 55, [e('waterwalk', 1, 120)], 'The surface tension of every lake becomes a floor.', 2);

// ------------------------------------------------------------------ books, keys, quest items

function book(id: string, name: string, shape: string, kind: NonNullable<ItemDef['book']>['kind'], value: number, desc: string, primary: RGB, extra: Partial<ItemDef> = {}) {
  add({
    id, name, category: 'book', slots: [], weight: 0.6, baseValue: value, stackable: false, maxStack: 1, book: { kind }, description: desc,
    tags: ['book', kind], visual: vis(shape, 'leather', primary, C(0xe8dcc0), BRASS), ...extra,
  });
}
book('book_lore', 'Book', 'book', 'lore', 15, 'A bound volume. Who knows what it says until you read it.', C(0x5a2a1a));
book('book_skill', 'Treatise', 'tome', 'skill', 120, 'A practical manual. Studying it improves a skill — once.', C(0x2a3a5a), { tier: 1 });
book('book_recipe', 'Recipe Folio', 'book', 'recipe', 60, 'Loose pages of instructions, diagrams and stains.', C(0x6a5a2a));
book('journal', 'Journal', 'book.small', 'journal', 5, 'A personal diary, half-filled in a cramped hand.', C(0x3a2a1a));

function key(id: string, name: string, value: number, desc: string, primary: RGB) {
  add({ id, name, category: 'key', slots: [], weight: 0.05, baseValue: value, stackable: false, maxStack: 1, description: desc, tags: ['key'], visual: vis('key', 'metal', primary, DARK, BRASS) });
}
key('key_iron', 'Iron Key', 2, 'A plain key. Its lock is out there somewhere.', METAL);
key('key_brass', 'Brass Key', 5, 'A key with an ornate bow.', BRASS);
key('key_skeleton', 'Skeleton Key', 150, 'A key with a filed-down bit that fits — once — almost any lock.', C(0xd8d0b8));

function quest(id: string, name: string, shape: string, desc: string, primary: RGB, mat = 'cloth', glow = 0) {
  add({ id, name, category: 'quest', slots: [], weight: 0.2, baseValue: 0, stackable: false, maxStack: 1, description: desc, tags: ['quest'], visual: vis(shape, mat, primary, C(0x7a1a1a), BRASS, glow, glow ? primary : [0, 0, 0]) });
}
quest('letter_sealed', 'Sealed Letter', 'letter', 'A folded letter closed with a wax seal. It is not addressed to you.', C(0xe8dcc0));
quest('relic_fragment', 'Relic Fragment', 'relic', 'A shard of carved stone thrumming with old power.', C(0x8a8a9a), 'stone', 0.4);
quest('signet_lost', 'Lost Signet', 'ring.signet', 'A family signet ring, engraved with a crest you have seen before.', C(0xd8b050), 'metal');
quest('ledger_stolen', 'Stolen Ledger', 'book', 'Columns of numbers that someone would kill to keep hidden.', C(0x3a2a1a), 'leather');
quest('idol_cursed', 'Cursed Idol', 'trinket.idol', 'A grinning idol. It is warm. It should not be warm.', C(0x2a6a3a), 'stone', 0.5);
quest('map_treasure', 'Treasure Map', 'scroll', 'A crude map; an X marks a place you could find.', C(0xd8c090));
quest('heirloom_locket', 'Heirloom Locket', 'pendant', 'A tarnished locket with a faded portrait inside.', C(0xc8c0b0), 'metal');

// ------------------------------------------------------------------ materials & reagents

function mat(id: string, name: string, shape: string, family: string, primary: RGB, value: number, weight: number, desc: string, category: ItemCategory = 'material', extra: Partial<ItemDef> = {}) {
  add({
    id, name, category, slots: [], weight, baseValue: value, stackable: true, maxStack: 50, description: desc, tags: [category, 'harvest'],
    visual: vis(shape, family, primary, DARK, BRASS), ...extra,
  });
}
// Wood & plant fibre
mat('log', 'Log', 'mat.log', 'wood', C(0x6a4a2c), 2, 4, 'A length of trunk, bark still on. Saw it into planks.', 'material', { maxStack: 20 });
mat('stick', 'Stick', 'mat.stick', 'wood', C(0x7a5a3a), 0.2, 0.2, 'A straight-ish stick. Handles, shafts, kindling.');
mat('bark', 'Bark', 'mat.bark', 'wood', C(0x5a4030), 0.3, 0.2, 'Strips of bark — tannin for leather, fibre for rope.');
mat('resin', 'Resin', 'mat.resin', 'crystal', C(0xd08a20), 1, 0.1, 'Sticky amber sap. Glue, torch-pitch, incense.');
mat('fiber', 'Plant Fiber', 'mat.fiber', 'cloth', C(0xa8a060), 0.3, 0.05, 'Retted stems ready for spinning or rope-making.');
mat('plank', 'Plank', 'mat.plank', 'wood', C(0xa07848), 1, 1.2, 'A sawn board, straight and true.', 'material', { maxStack: 30 });
mat('reed', 'Reed', 'mat.reed', 'cloth', C(0x9aa060), 0.2, 0.05, 'Hollow river reeds for thatch, arrows and pan-pipes.');
mat('seed', 'Seeds', 'mat.seed', 'organic', C(0x8a7040), 0.2, 0.01, 'A twist of seeds. Plant them, or feed the birds.');
mat('flower', 'Wildflower', 'herb', 'cloth', C(0xd060a0), 0.5, 0.02, 'A pretty bloom. Dyes, perfumes, apologies.', 'reagent');
// Stone & minerals
mat('stone', 'Stone', 'mat.stone', 'stone', C(0x7a7770), 0.1, 1, 'A fist-sized chunk of rock. Builders always need more.');
mat('flint', 'Flint', 'mat.flint', 'stone', C(0x3a3a40), 0.5, 0.3, 'Strike it on steel for sparks, or knap it to an edge.');
mat('clay', 'Clay', 'mat.lump', 'stone', C(0xa8684a), 0.3, 1, 'Wet, red clay. Bricks, pots, golems (allegedly).');
mat('sand', 'Sand', 'mat.sack', 'stone', C(0xd8c08a), 0.1, 1, 'A sack of fine sand — glass, if you have the heat.');
mat('soil', 'Soil', 'mat.sack', 'stone', C(0x4a3424), 0.05, 1, 'Rich dark earth. Good for planting.');
mat('coal', 'Coal', 'mat.ore', 'stone', C(0x1a1a1c), 1, 0.5, 'Black, greasy, hot-burning. Every forge hungers for it.');
mat('salt', 'Salt', 'mat.salt', 'crystal', C(0xe8e8e0), 1, 0.2, 'Coarse crystals. Preserves meat, wards away certain spirits.', 'reagent');
mat('obsidian', 'Obsidian', 'mat.crystal', 'glass', C(0x15121a), 4, 0.6, 'Glassy black stone from cooled lava; knaps to a razor edge.');
mat('crystal_shard', 'Crystal Shard', 'mat.crystal', 'crystal', C(0x80c8f0), 6, 0.2, 'A glowing shard from the deep caves. Hums when held near magic.', 'reagent', { visual: vis('mat.crystal', 'crystal', C(0x80c8f0), DARK, BRASS, 0.6, [0.5, 0.8, 1]) });
mat('raw_gem', 'Uncut Gem', 'mat.gem', 'crystal', C(0xb04a6a), 15, 0.1, 'A rough, cloudy stone. A jeweller could make something of it.');
// Ores & metals
mat('copper_ore', 'Copper Ore', 'mat.ore', 'stone', C(0x9a6040), 2, 1, 'Rock streaked with green and rust-red.');
mat('iron_ore', 'Iron Ore', 'mat.ore', 'stone', C(0x7a5040), 3, 1, 'Heavy, red-brown rock. Smelt it with coal.');
mat('silver_ore', 'Silver Ore', 'mat.ore', 'stone', C(0xb0b0b8), 8, 1, 'Grey rock threaded with bright metal.');
mat('gold_ore', 'Gold Ore', 'mat.ore', 'stone', C(0xc8a040), 15, 1, 'Quartz with fat yellow veins. Your heart beats faster.');
mat('mithril_ore', 'Mithril Ore', 'mat.ore', 'stone', C(0xa8c8e0), 40, 0.5, 'Pale blue ore that rings like a bell when struck.', 'material', { tier: 4 });
mat('adamant_ore', 'Adamant Ore', 'mat.ore', 'stone', C(0x4a6a5a), 60, 1.5, 'Green-black ore that blunts the pick that finds it.', 'material', { tier: 5 });
mat('starmetal_ore', 'Star-iron', 'mat.ore', 'metal', C(0x3a3a5a), 120, 1, 'A pitted lump of sky-iron, still faintly glittering.', 'material', { tier: 6, visual: vis('mat.ore', 'metal', C(0x3a3a5a), DARK, BRASS, 0.3, [0.6, 0.6, 1]) });
for (const [m, name, color, v] of [
  ['copper', 'Copper', 0xb87040, 4], ['bronze', 'Bronze', 0xb08040, 7], ['iron', 'Iron', 0x808085, 8], ['steel', 'Steel', 0xa8aab0, 15], ['silver', 'Silver', 0xd8d8e0, 20],
  ['gold', 'Gold', 0xf0c050, 40], ['darksteel', 'Darksteel', 0x3a3a48, 35], ['mithril', 'Mithril', 0xc8e0f0, 90], ['adamant', 'Adamant', 0x4a7060, 130], ['starmetal', 'Starmetal', 0x4a4a70, 250],
] as [string, string, number, number][]) {
  mat(`${m}_ingot`, `${name} Ingot`, 'mat.ingot', 'metal', C(color), v, 1, `A bar of ${name.toLowerCase()} ready for the anvil.`, 'material', { maxStack: 20, baseMaterial: m });
}
// Gems (cut)
for (const g of GEMS) mat(`gem_${g.id}`, g.name, 'mat.gemcut', 'crystal', g.color, g.value, 0.02, `A cut ${g.name.toLowerCase()}. Set it in a ring, amulet or staff.`, 'material', { tier: g.tier, baseMaterial: g.id, maxStack: 20 });
// Creature parts
mat('bone', 'Bone', 'mat.bone', 'bone', C(0xd8d0b8), 0.5, 0.4, 'A long bone, cracked for its marrow.');
mat('hide', 'Hide', 'mat.hide', 'leather', C(0x8a6a4a), 2, 1.5, 'An untanned animal hide. Tan it into leather.', 'material', { maxStack: 20 });
mat('feather', 'Feather', 'mat.feather', 'cloth', C(0xe8e0d0), 0.2, 0.01, 'Fletching for arrows, quills for scribes.');
mat('chitin', 'Chitin Plate', 'mat.chitin', 'chitin', C(0x3a4a2a), 3, 0.4, 'A curved plate of insect shell, light and hard.');
mat('venom_sac', 'Venom Sac', 'mat.sac', 'organic', C(0x6a9a2a), 5, 0.1, 'A quivering gland. Handle with gloves.', 'reagent');
mat('scale', 'Scale', 'mat.scale', 'chitin', C(0x3a6a5a), 3, 0.05, 'An iridescent reptile scale the size of a palm.');
mat('fang', 'Fang', 'mat.fang', 'bone', C(0xe8e0c8), 2, 0.05, 'A curved, wickedly sharp tooth.', 'reagent');
mat('glowsap', 'Glowsap', 'mat.jar', 'glass', C(0x60f0a0), 8, 0.2, 'Luminous sap from underworld trees. Bottled light.', 'reagent', { visual: vis('mat.jar', 'glass', C(0x60f0a0), DARK, BRASS, 0.8, [0.4, 1, 0.6]) });
mat('leather', 'Leather', 'mat.leather', 'leather', C(0x7a5030), 4, 0.8, 'A tanned, rolled skin ready for cutting.');
mat('fur_pelt', 'Fur Pelt', 'mat.hide', 'fur', C(0x8a7a6a), 5, 1, 'A thick pelt, cleaned and dried.');
// Herbs & fungi
mat('herb_healing', 'Healroot', 'herb', 'cloth', C(0x4a9a3a), 2, 0.02, 'Broad-leafed root that stops bleeding when chewed.', 'reagent');
mat('herb_mana', 'Bluebell Moss', 'herb', 'cloth', C(0x3a5ac0), 3, 0.02, 'Moss that glows faintly blue under starlight.', 'reagent');
mat('herb_stamina', 'Runner\'s Thistle', 'herb', 'cloth', C(0x9ab03a), 2, 0.02, 'Bitter thistle chewed by messengers on long roads.', 'reagent');
mat('herb_poison', 'Nightshade', 'herb', 'cloth', C(0x4a2a5a), 3, 0.02, 'Purple bells, black berries, and no second chances.', 'reagent');
mat('herb_rare', 'Starpetal', 'herb', 'cloth', C(0xe0d0ff), 20, 0.02, 'A six-petalled flower that only opens at night.', 'reagent', { visual: vis('herb', 'cloth', C(0xe0d0ff), DARK, BRASS, 0.4, [0.8, 0.7, 1]) });
mat('mushroom_glow', 'Glowcap', 'food.mushroom', 'organic', C(0x50e0c0), 4, 0.05, 'A luminous cave mushroom; alchemists prize it.', 'reagent', { visual: vis('food.mushroom', 'organic', C(0x50e0c0), DARK, BRASS, 0.7, [0.3, 1, 0.8]) });
mat('mushroom_toxic', 'Deathcap', 'food.mushroom', 'organic', C(0xa0a860), 2, 0.05, 'Pretty, pale, deadly.', 'reagent');
// Crafted intermediates
mat('linen_cloth', 'Linen Cloth', 'mat.cloth', 'cloth', C(0xd8d0b8), 3, 0.5, 'A bolt of woven linen.');
mat('wool_cloth', 'Wool Cloth', 'mat.cloth', 'cloth', C(0x9a8a70), 3, 0.6, 'A bolt of fulled wool.');
mat('silk_cloth', 'Silk Cloth', 'mat.cloth', 'silk', C(0xe8d8c0), 15, 0.3, 'Shimmering silk, carefully folded.');
mat('thread', 'Thread', 'mat.thread', 'cloth', C(0xd8c8a0), 0.5, 0.02, 'A spool of strong thread.');
mat('rope', 'Rope', 'mat.rope', 'cloth', C(0xa08a5a), 2, 0.6, 'A coil of hempen rope.');
mat('bowstring', 'Bowstring', 'mat.thread', 'cloth', C(0xe8e0c8), 2, 0.02, 'Waxed linen string, looped at both ends.');
mat('parchment', 'Parchment', 'mat.paper', 'cloth', C(0xe8dcb8), 1, 0.02, 'Scraped vellum, ready for ink.', 'reagent');
mat('ink', 'Ink', 'mat.jar', 'glass', C(0x101018), 2, 0.1, 'Oak-gall ink in a stoppered pot.', 'reagent');
mat('glass_vial', 'Empty Vial', 'potion.vial', 'glass', C(0xd0e8e8), 1, 0.1, 'A small stoppered vial waiting to be filled.');
mat('wax', 'Beeswax', 'mat.lump', 'organic', C(0xe0c060), 1, 0.1, 'Golden wax for candles, seals and bowstrings.', 'reagent');
mat('charcoal', 'Charcoal', 'mat.ore', 'wood', C(0x202020), 0.5, 0.2, 'Wood burned without air. Burns hotter than logs.');
// Arcane reagents
mat('dust_arcane', 'Arcane Dust', 'mat.dust', 'crystal', C(0xb080ff), 12, 0.02, 'Glittering residue left when enchantments break.', 'reagent', { visual: vis('mat.dust', 'crystal', C(0xb080ff), DARK, BRASS, 0.5, [0.7, 0.5, 1]) });
for (const [el, name, color, glowc] of [
  ['fire', 'Ember Essence', 0xff6020, [1, 0.4, 0.1]], ['frost', 'Rime Essence', 0x80d0ff, [0.5, 0.8, 1]], ['shock', 'Storm Essence', 0xe0e060, [1, 1, 0.5]],
  ['life', 'Verdant Essence', 0x60e060, [0.4, 1, 0.4]], ['shadow', 'Umbral Essence', 0x5a2a8a, [0.6, 0.2, 1]], ['radiant', 'Dawn Essence', 0xfff0a0, [1, 0.95, 0.6]],
] as [string, string, number, RGB][]) {
  mat(`essence_${el}`, name, 'mat.essence', 'glass', C(color), 25, 0.1, `Bottled ${el} — the raw stuff of enchantment.`, 'reagent', { tier: 2, visual: vis('mat.essence', 'glass', C(color), DARK, BRASS, 0.8, glowc) });
}
mat('ectoplasm', 'Ectoplasm', 'mat.jar', 'glass', C(0xc0f0e0), 18, 0.1, 'Cold, quivering residue of a departed spirit.', 'reagent', { visual: vis('mat.jar', 'glass', C(0xc0f0e0), DARK, BRASS, 0.5, [0.7, 1, 0.9]) });
mat('dragon_scale', 'Dragon Scale', 'mat.scale', 'chitin', C(0x8a2a1a), 200, 0.5, 'A shield-sized scale, warm to the touch.', 'material', { tier: 6, maxStack: 10 });

// Coins as an item (a pouch of coins dropped on the ground; picking it up adds to the purse)
add({
  id: 'coins', name: 'Coins', category: 'material', slots: [], weight: 0, baseValue: 1, stackable: true, maxStack: 1e6,
  description: 'Clinking coin of many mints.', tags: ['coins'], visual: vis('coins', 'metal', C(0xd8b050), C(0xb0b0b8), C(0xa06a3a)),
});

// ------------------------------------------------------------------ exports

const BY_ID = new Map(DEFS.map((d) => [d.id, d]));

/** Every item definition (read-only). */
export const ITEM_DEFS: readonly ItemDef[] = DEFS;

export function itemDef(id: string): ItemDef | undefined {
  return BY_ID.get(id);
}

/** Defs filtered by predicate (cached per call site by callers if hot). */
export function defsWhere(pred: (d: ItemDef) => boolean): ItemDef[] {
  return DEFS.filter(pred);
}

/** Register additional defs at runtime (uniques). */
export function registerDef(d: ItemDef) {
  if (!BY_ID.has(d.id)) {
    DEFS.push(d);
    BY_ID.set(d.id, d);
  }
}

/** True if the def is worn on the body (clothing/armor/jewelry in non-hand slots). */
export function isWearable(d: ItemDef): boolean {
  return d.slots.some((s) => s !== 'mainhand' && s !== 'offhand' && s !== 'trinket');
}
