/**
 * Skill catalog. Every skill is trained by use; its `unlocks` thresholds grant
 * abilities (see abilities.ts). Level cap is SKILL_CAP.
 */
import type { SkillDef } from '../types';

export const SKILL_CAP = 100;

type C = [number, number, number];
const S = (
  id: string, name: string, category: SkillDef['category'], icon: string, color: C, description: string, training: string,
  unlocks: [number, string][], school?: string,
): SkillDef => ({ id, name, category, icon, color, description, training, school, unlocks: unlocks.map(([level, ability]) => ({ level, ability })) });

export const SKILLS: SkillDef[] = [
  // ------------------------------------------------------------------ combat
  S('blades', 'Blades', 'combat', '🗡', [0.8, 0.82, 0.9], 'Swords, daggers and knives: fast cuts, parries and flowing combinations.', 'Hit things with bladed weapons.',
    [[1, 'power_strike'], [10, 'lunge'], [22, 'parry_riposte'], [35, 'rending_cut'], [55, 'blade_flurry'], [75, 'whirlwind']]),
  S('axes', 'Axes', 'combat', '🪓', [0.75, 0.55, 0.4], 'Axes of war and work: wide cleaves, crippling blows and thrown hatchets.', 'Fight with axes.',
    [[1, 'cleave'], [12, 'hamstring'], [25, 'sunder'], [40, 'axe_throw'], [60, 'rampage']]),
  S('blunt', 'Blunt Weapons', 'combat', '🔨', [0.7, 0.65, 0.6], 'Maces, hammers and clubs: staggering impacts that shake the ground itself.', 'Fight with maces, hammers and clubs.',
    [[1, 'crushing_blow'], [12, 'leap_slam'], [28, 'ground_pound'], [45, 'skull_crack'], [65, 'earthshaker']]),
  S('polearms', 'Polearms', 'combat', '🔱', [0.8, 0.75, 0.55], 'Spears, glaives and staves: reach, sweeps and acrobatic vaults.', 'Fight with spears and polearms.',
    [[1, 'thrust'], [12, 'sweep'], [26, 'pole_vault'], [42, 'impale'], [60, 'pinwheel']]),
  S('archery', 'Archery', 'combat', '🏹', [0.65, 0.8, 0.45], 'Bows and crossbows: patient aim, volleys and trick arrows.', 'Hit targets with arrows.',
    [[1, 'aimed_shot'], [10, 'quick_shot'], [22, 'volley'], [36, 'piercing_arrow'], [50, 'grapple_shot'], [70, 'explosive_arrow']]),
  S('throwing', 'Throwing', 'combat', '🎯', [0.85, 0.7, 0.45], 'Knives, stones, bolas and bombs thrown by hand.', 'Throw things at things.',
    [[1, 'hurl'], [12, 'fan_of_knives'], [28, 'bolas'], [45, 'ricochet'], [60, 'smoke_bomb']]),
  S('unarmed', 'Unarmed', 'combat', '👊', [0.9, 0.7, 0.55], 'Fists, feet and grapples, refined into a martial art.', 'Fight without weapons.',
    [[1, 'flurry'], [10, 'kick'], [22, 'grapple_throw'], [40, 'pressure_point'], [60, 'ki_palm']]),
  S('shields', 'Shields', 'combat', '🛡', [0.6, 0.7, 0.85], 'Blocking, bashing and protecting allies.', 'Block attacks with a shield.',
    [[1, 'shield_bash'], [12, 'shield_wall'], [28, 'shield_charge'], [45, 'reflect'], [60, 'bulwark']]),
  S('heavy_armor', 'Heavy Armor', 'combat', '⛨', [0.55, 0.58, 0.62], 'Moving and fighting in plate and mail.', 'Take hits while wearing heavy armor.',
    [[10, 'iron_skin'], [20, 'brace'], [40, 'unstoppable'], [65, 'juggernaut']]),
  S('light_armor', 'Light Armor', 'combat', '🧥', [0.65, 0.5, 0.35], 'Leather and hide: protection that never slows you down.', 'Take hits while wearing light armor.',
    [[10, 'evasion'], [25, 'nimble'], [45, 'deflect'], [65, 'windrunner']]),
  S('acrobatics', 'Acrobatics', 'combat', '🤸', [0.95, 0.75, 0.5], 'Rolls, leaps, flips and controlled falls.', 'Jump, dodge and survive falls.',
    [[0, 'dodge_roll'], [10, 'leap'], [20, 'featherstep'], [35, 'backflip'], [55, 'glide']]),
  S('athletics', 'Athletics', 'combat', '🏃', [0.95, 0.6, 0.4], 'Endurance, speed and raw strength.', 'Run, sprint and carry heavy loads.',
    [[0, 'sprint_burst'], [12, 'second_wind'], [25, 'marathon'], [40, 'charge'], [60, 'titan_grip']]),

  // ------------------------------------------------------------------ magic schools
  S('pyromancy', 'Pyromancy', 'magic', '🔥', [1.0, 0.45, 0.12], 'The school of flame: ignition, explosions and walls of fire.', 'Cast fire spells.',
    [[1, 'ignite'], [6, 'fireball'], [18, 'flame_wall'], [30, 'flame_cloak'], [46, 'meteor'], [70, 'inferno']], 'fire'),
  S('cryomancy', 'Cryomancy', 'magic', '❄', [0.5, 0.85, 1.0], 'The school of frost: bolts, walls of ice and frozen water.', 'Cast frost spells.',
    [[1, 'frost_bolt'], [8, 'freeze_water'], [18, 'ice_wall'], [30, 'frost_nova'], [44, 'ice_lance'], [55, 'frost_armor'], [70, 'blizzard']], 'frost'),
  S('geomancy', 'Geomancy', 'magic', '⛰', [0.7, 0.55, 0.35], 'Shaping earth and stone: spikes, pillars, walls, tunnels and quakes.', 'Shape the earth with magic.',
    [[1, 'earth_spike'], [6, 'dig_bore'], [16, 'raise_pillar'], [26, 'raise_wall'], [38, 'quake'], [52, 'stone_skin'], [66, 'earthen_bridge']], 'earth'),
  S('gravitas', 'Gravitas', 'magic', '🌀', [0.65, 0.45, 1.0], 'Command of weight itself: falling softly, floating and crushing.', 'Bend gravity.',
    [[1, 'featherfall'], [8, 'lighten'], [18, 'levitate'], [28, 'gravity_well'], [40, 'crush'], [55, 'gravity_flip'], [75, 'singularity']], 'gravity'),
  S('vitae', 'Vitae', 'magic', '🌿', [0.4, 0.95, 0.45], 'Life and growth: healing, regeneration, roots and thorns.', 'Heal and nurture with magic.',
    [[1, 'mend'], [10, 'regenerate'], [18, 'entangling_roots'], [28, 'cleanse'], [38, 'grow'], [48, 'thorns'], [62, 'sanctuary']], 'life'),
  S('luminism', 'Luminism', 'magic', '☀', [1.0, 0.88, 0.5], 'Light made solid: orbs, lances, blinding flashes and radiant wards.', 'Wield light.',
    [[1, 'light_orb'], [8, 'sunlance'], [18, 'blind'], [30, 'halo'], [42, 'sunburst'], [64, 'dawn']], 'light'),
  S('umbramancy', 'Umbramancy', 'magic', '☽', [0.55, 0.35, 0.85], 'Shadow and illusion: cloaks of darkness, blinks and terror.', 'Wield shadow and illusion.',
    [[1, 'shadow_bolt'], [8, 'shadow_cloak'], [18, 'shadow_step'], [30, 'fear'], [40, 'umbral_sight'], [52, 'mirror_image'], [68, 'night_shroud']], 'shadow'),
  S('kinesis', 'Kinesis', 'magic', '✋', [0.6, 0.8, 1.0], 'Raw force: pushing, pulling, shielding and hurling.', 'Move things with your mind.',
    [[1, 'force_push'], [10, 'force_pull'], [20, 'force_shield'], [32, 'telekinetic_hurl'], [44, 'kinetic_leap'], [58, 'shockwave'], [74, 'crushing_grip']], 'force'),
  S('animism', 'Animism', 'magic', '🐾', [0.75, 0.65, 0.35], 'Kinship with beasts: calming, sensing, taming and calling the wild.', 'Calm, sense and tame animals.',
    [[1, 'calm_beast'], [8, 'beast_sense'], [18, 'tame'], [32, 'call_of_the_wild'], [46, 'wolf_spirit'], [60, 'pack_command']], 'beast'),
  S('runecraft', 'Runecraft', 'magic', 'ᚱ', [0.35, 0.95, 0.85], 'Runes and glyphs: wards, traps, enchantments and anchors.', 'Inscribe runes.',
    [[1, 'enchant_weapon'], [10, 'ward_rune'], [20, 'trap_rune'], [32, 'binding_rune'], [46, 'inscribe_weapon'], [58, 'recall_rune'], [72, 'glyph_of_warding']], 'rune'),

  // ------------------------------------------------------------------ utility
  S('climbing', 'Climbing', 'utility', '🧗', [0.7, 0.68, 0.62], 'Scaling cliffs, walls and trees.', 'Climb steep terrain.',
    [[1, 'wall_climb_surge'], [15, 'iron_grip'], [30, 'mantle_leap'], [50, 'spider_climb']]),
  S('swimming', 'Swimming', 'utility', '🏊', [0.35, 0.6, 0.95], 'Moving through water with grace and endurance.', 'Swim.',
    [[1, 'swift_stroke'], [15, 'deep_lungs'], [30, 'tidal_grace'], [45, 'aquatic_dash']]),
  S('stealth', 'Stealth', 'utility', '👤', [0.45, 0.45, 0.55], 'Moving unseen and striking from the shadows.', 'Sneak near others without being noticed.',
    [[1, 'backstab'], [12, 'vanish'], [25, 'shadow_stride'], [40, 'distraction'], [60, 'assassinate']]),
  S('lockpicking', 'Lockpicking', 'utility', '🔓', [0.8, 0.75, 0.5], 'Locks, latches and other people\'s pockets.', 'Pick locks and pockets.',
    [[1, 'pick_lock'], [20, 'deft_fingers'], [35, 'pickpocket'], [55, 'master_locksmith']]),
  S('mining', 'Mining', 'utility', '⛏', [0.6, 0.55, 0.5], 'Breaking stone and finding ore.', 'Dig and mine.',
    [[1, 'mining_strike'], [10, 'detect_ores'], [25, 'prospector'], [45, 'excavate']]),
  S('woodcutting', 'Woodcutting', 'utility', '🌲', [0.55, 0.42, 0.25], 'Felling trees and splitting timber.', 'Chop trees.',
    [[1, 'lumberjack_chop'], [15, 'felling_strike'], [30, 'woodsman'], [50, 'splitter']]),

  // ------------------------------------------------------------------ survival
  S('herbalism', 'Herbalism', 'survival', '🌱', [0.45, 0.8, 0.35], 'Knowledge of healing and harmful plants.', 'Harvest herbs and use them.',
    [[1, 'poultice'], [15, 'antidote'], [30, 'toxin_coat'], [50, 'verdant_blood']]),
  S('foraging', 'Foraging', 'survival', '🍄', [0.75, 0.6, 0.4], 'Finding food and useful things in the wild.', 'Gather from the land.',
    [[1, 'forage_sense'], [15, 'scavenge'], [30, 'keen_nose']]),
  S('tracking', 'Tracking', 'survival', '👣', [0.65, 0.55, 0.4], 'Reading trails and marking prey.', 'Follow tracks and hunt.',
    [[1, 'track'], [15, 'hunters_mark'], [30, 'trailblazer'], [50, 'predator_sense']]),
  S('survival', 'Survival', 'survival', '⛺', [0.8, 0.5, 0.3], 'Enduring the wild: camps, wounds and weather.', 'Endure harsh conditions and wounds.',
    [[1, 'make_camp'], [15, 'endure_elements'], [30, 'bandage'], [50, 'weathered']]),
  S('lore', 'Lore', 'survival', '📜', [0.85, 0.8, 0.6], 'Knowledge of beasts, peoples, runes and history.', 'Study creatures, ruins and texts.',
    [[1, 'recall_lore'], [15, 'scholar'], [30, 'ancient_tongue'], [50, 'arcane_insight']]),

  // ------------------------------------------------------------------ craft
  S('cooking', 'Cooking', 'craft', '🍲', [0.95, 0.7, 0.4], 'Turning raw ingredients into strength.', 'Cook and eat good food.',
    [[1, 'quick_meal'], [20, 'hearty_cook'], [40, 'feast']]),
  S('smithing', 'Smithing', 'craft', '⚒', [0.75, 0.6, 0.5], 'Forging, repairing and honing metal.', 'Smith and repair gear.',
    [[1, 'field_repair'], [15, 'sharpen'], [35, 'temper_armor'], [60, 'masterwork']]),
  S('alchemy', 'Alchemy', 'craft', '⚗', [0.6, 0.9, 0.55], 'Potions, poisons, volatile flasks and transmutation.', 'Brew and throw concoctions.',
    [[1, 'volatile_flask'], [20, 'toxic_cloud'], [35, 'elixir_mastery'], [55, 'transmute']]),
  S('tailoring', 'Tailoring', 'craft', '🧵', [0.8, 0.6, 0.75], 'Cloth, leather and clever garments.', 'Sew and mend clothing.',
    [[1, 'patch_up'], [15, 'insulated_layers'], [30, 'cloak_glide'], [50, 'silkweave']]),
  S('enchanting', 'Enchanting', 'craft', '✨', [0.75, 0.55, 1.0], 'Binding magic into objects and bodies.', 'Enchant items and empower magic.',
    [[1, 'arcane_sight'], [15, 'empower'], [30, 'imbue_armor'], [50, 'mana_well']]),

  // ------------------------------------------------------------------ social
  S('persuasion', 'Persuasion', 'social', '💬', [0.55, 0.8, 0.95], 'Convincing, inspiring and calming people.', 'Win arguments and dialog checks.',
    [[1, 'persuade'], [15, 'inspire'], [30, 'silver_tongue'], [50, 'pacify']]),
  S('intimidation', 'Intimidation', 'social', '😠', [0.9, 0.35, 0.3], 'Threats, war cries and an air of menace.', 'Threaten people and beasts.',
    [[1, 'intimidate'], [15, 'war_cry'], [30, 'menacing_presence'], [50, 'demoralize']]),
  S('barter', 'Barter', 'social', '⚖', [0.95, 0.8, 0.35], 'Knowing the worth of things and getting a good deal.', 'Trade and appraise.',
    [[1, 'appraise'], [20, 'haggler'], [40, 'merchants_eye'], [60, 'smooth_deal']]),
];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));
export function skillById(id: string): SkillDef | undefined {
  return BY_ID.get(id);
}

/** Magic school ids → skill id. */
export const SCHOOLS: Record<string, string> = Object.fromEntries(SKILLS.filter((s) => s.school).map((s) => [s.school!, s.id]));
