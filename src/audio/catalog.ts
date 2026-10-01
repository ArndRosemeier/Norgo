/**
 * Sound catalog: every named procedural sound, plus forgiving name
 * resolution so ids coming from other domains (server 'sound' events, fx
 * ids, animation ids) always map to something sensible — never silence.
 */
import type { SoundDef } from './engine';
import { foleyDefs, STEP_FAMILIES } from './sounds/foley';
import { combatDefs } from './sounds/combat';
import { magicDefs, SCHOOLS, School } from './sounds/magic';
import { uiDefs, DEFAULT_TUNING, UiTuning } from './sounds/ui';
import { sd, rumble, debris, crackles, whoosh, crunch, creak, STONE, WOOD, METAL, GLASS } from './sounds/common';
import { degreeHz } from './sounds/ui';

/** Direct aliases (lowercase). */
const ALIASES: Record<string, string> = {
  swing_1h: 'swing', swing_2h: 'swing_heavy', stab: 'swing_light', slam: 'swing_heavy', attack: 'swing', attack_heavy: 'swing_heavy',
  whoosh: 'swing', shoot_bow: 'bow_release', bow: 'bow_release', bow_shoot: 'bow_release', arrow: 'arrow_hit', arrow_whiz: 'arrow_fly',
  landing: 'land', land_hard: 'land_heavy', fall: 'land_heavy', fall_damage: 'land_heavy',
  hit: 'hit_flesh', hurt: 'hit_flesh', crit: 'hit_crit', critical: 'hit_crit', clang: 'hit_metal', clash: 'parry',
  click: 'ui_click', hover: 'ui_hover', open: 'ui_open', close: 'ui_close', error: 'ui_error', confirm: 'ui_confirm', deny: 'ui_error',
  levelup: 'level_up', level: 'level_up', quest: 'quest_update', quest_accept: 'quest_start', quest_done: 'quest_complete', quest_finish: 'quest_complete',
  chop: 'tree_chop', axe: 'tree_chop', mine: 'dig_stone', pickaxe: 'dig_stone', shovel: 'dig', harvest: 'hit_plant', gather: 'hit_plant',
  loot: 'coins', gold: 'coins', coin: 'coins', buy: 'ui_buy', sell: 'ui_buy', trade: 'ui_buy',
  explode: 'explosion', boom: 'explosion', blast: 'explosion', bomb: 'explosion',
  cast: 'spell_charge', charge: 'spell_charge', channel: 'spell_charge', fizzle: 'spell_fizzle', fail: 'spell_fizzle',
  heal: 'heal_impact', door: 'door_open', chest: 'chest_open', open_chest: 'chest_open',
  tree_fell: 'tree_fall', tree_felled: 'tree_fall', tree_crash: 'tree_fall', rock_break: 'rock_shatter', rock_destroy: 'rock_shatter',
  glass: 'crystal_shatter', shatter: 'rock_shatter', crack: 'ice_crack', quake: 'rumble', earthquake: 'rumble',
  splash_large: 'splash_big', dive: 'water_enter', stroke: 'swim', walk: 'step_soil', step: 'step_soil', footstep: 'step_soil',
  eat_food: 'eat', drink_potion: 'potion', use_potion: 'potion', anvil: 'hammer', work_hammer: 'hammer', work_saw: 'saw', craft_done: 'craft',
  page: 'ui_page', book: 'ui_page', journal: 'ui_page', notify_info: 'notify', notification: 'notify', discover: 'discovery', discovered: 'discovery',
  death: 'death_sting', died: 'death_sting',
  // ---- names used by other modules (UI host.sound, flora, server 'sound' events)
  ui_slot: 'ui_tab', ui_waypoint: 'ui_confirm', ui_equip: 'equip', ui_unequip: 'unequip', ui_use: 'ui_confirm', ui_quest: 'quest_start',
  ui_questcomplete: 'quest_complete', ui_coins: 'ui_buy', ui_discover: 'discovery', ui_levelup: 'level_up', ui_unlock: 'unlock',
  crystal_hit: 'hit_crystal', crystal_break: 'crystal_shatter', rockbreak: 'rock_shatter', treefall: 'tree_creak', treeland: 'tree_land',
  pick: 'pluck', item_pickup: 'pickup', tremor: 'rumble', meteor: 'meteor_fall',
};

/** Keyword → magic school (checked in order). */
const SCHOOL_WORDS: [RegExp, School][] = [
  [/fire|flame|burn|ember|inferno|magma|lava|pyro/, 'fire'],
  [/frost|ice|cold|freez|chill|snow|glacia|cryo/, 'frost'],
  [/shock|lightning|spark|thunder|electr|volt|static/, 'shock'],
  [/poison|acid|venom|toxi|plague|rot/, 'poison'],
  [/grav|weight|levitat|float|singular|warp/, 'gravity'],
  [/heal|restor|mend|regen|life|cure|bless/, 'heal'],
  [/shadow|dark|void|necro|umbr|curse|night|fear/, 'shadow'],
  [/light|radian|holy|sun|divine|glow|flash/, 'light'],
  [/earth|stone|rock|quake|boulder|terra|mud|geo/, 'earth'],
  [/force|push|kinetic|shove|repuls|impulse/, 'force'],
  [/beast|animal|wild|claw|fang|roar|howl|feral/, 'beast'],
  [/rune|glyph|ward|enchant|sigil|seal/, 'rune'],
  [/water|wave|tide|aqua|hydro|rain/, 'water'],
  [/wind|gust|air|tornado|cyclone|zephyr/, 'wind'],
  [/arcane|magic|mana|spell|mystic|missile/, 'arcane'],
];

export function schoolOf(name: string): School | null {
  const n = name.toLowerCase();
  for (const [re, s] of SCHOOL_WORDS) if (re.test(n)) return s;
  return null;
}

export class SoundCatalog {
  defs: Record<string, SoundDef> = {};
  tuning: UiTuning = DEFAULT_TUNING;
  private resolved = new Map<string, string>();

  constructor(tuning: UiTuning = DEFAULT_TUNING) {
    this.rebuild(tuning);
  }

  /** (Re)build all defs; UI fanfares follow the world tuning. */
  rebuild(tuning: UiTuning): void {
    this.tuning = tuning;
    this.defs = {
      ...foleyDefs(),
      ...combatDefs(),
      ...magicDefs(),
      ...uiDefs(tuning),
      rumble: sd({
        dur: 3.5, variants: 3, group: 'big', gain: 0.8, ref: 10, range: 600, priority: 1.5, render(s) {
          rumble(s, 0, 3.2, 120, 0.8, 0.4);
          debris(s, 0.3, 10, 500, STONE, 0.08, 2);
        },
      }),
      ...extraDefs(tuning),
    };
    this.resolved.clear();
  }

  /** All playable names (sorted) — for the sandbox and docs. */
  names(): string[] {
    return Object.keys(this.defs).sort();
  }

  /**
   * Resolve any incoming id to a catalog name:
   * exact → alias → step_/hit_ families → school keywords (cast/impact) → generic.
   */
  resolve(raw: string): string {
    const hit = this.resolved.get(raw);
    if (hit) return hit;
    const r = this.resolveUncached(raw);
    this.resolved.set(raw, r);
    return r;
  }

  private resolveUncached(raw: string): string {
    const n = raw.toLowerCase().trim().replace(/[\s.-]+/g, '_');
    if (this.defs[n]) return n;
    if (ALIASES[n]) return ALIASES[n];
    // Family prefixes
    if (n.startsWith('step') || n.startsWith('foot')) {
      const fam = STEP_FAMILIES.find((f) => n.includes(f));
      return 'step_' + (fam ?? 'soil');
    }
    if (n.startsWith('hit') || n.startsWith('impact')) {
      for (const m of ['metal', 'wood', 'stone', 'flesh', 'crystal', 'ice', 'plant', 'cloth', 'soil']) if (n.includes(m)) return 'hit_' + m;
    }
    if (/explo|blast|detonat/.test(n)) return /small|mini|minor/.test(n) ? 'explosion_small' : 'explosion';
    if (/splash/.test(n)) return 'splash';
    if (/teleport|blink|portal/.test(n)) return 'teleport';
    if (/shield|barrier|aegis/.test(n)) return 'shield';
    if (/summon|conjur/.test(n)) return 'summon';
    if (/buff|empower|haste/.test(n)) return 'buff';
    if (/debuff|weaken|slow|hex/.test(n)) return 'debuff';
    if (/coin|gold|money/.test(n)) return 'coins';
    if (/ui_|button|menu/.test(n)) return 'ui_click';
    const sch = schoolOf(n);
    if (sch) {
      const impact = /hit|impact|explo|burst|nova|land|strike|aoe|area|ground|zone|field/.test(n);
      return sch + (impact ? '_impact' : '_cast');
    }
    if (/swing|slash|cut|whoosh|swipe/.test(n)) return 'swing';
    if (/dig|shovel/.test(n)) return 'dig';
    if (/wood|tree|log/.test(n)) return 'hit_wood';
    if (/stone|rock|ore/.test(n)) return 'hit_stone';
    if (/metal|iron|steel|sword|blade/.test(n)) return 'hit_metal';
    return 'drop';
  }

  get(name: string): SoundDef {
    return this.defs[name] ?? this.defs[this.resolve(name)] ?? this.defs.drop;
  }
}

/** Sounds requested by other domains that need their own recipes. */
function extraDefs(tu: UiTuning): Record<string, SoundDef> {
  const N = (d: number) => degreeHz(tu, d);
  return {
    // Tree hitting the ground (flora plays 'treefall' → tree_creak when the fall starts).
    tree_land: sd({
      dur: 3.5, variants: 3, group: 'big', gain: 1, ref: 7, range: 300, priority: 2, reverb: 1.3, render(s) {
        s.thump(0, 40, 1, 0.5, undefined, 0.4);
        rumble(s, 0, 1.6, 200, 0.6, 0.03);
        for (let i = 0; i < 10; i++) s.modal(s.r(0, 0.6), s.r(90, 300), WOOD, s.r(0.2, 0.6));
        crackles(s, 0, 1.2, 40, 600, 4000, 0.25);
        crunch(s, 0.2, 2.5, 30, 2500, 8000, 0.05, 1);
      },
    }),
    meteor_fall: sd({
      dur: 3.2, variants: 3, group: 'big', gain: 0.9, ref: 25, range: 2500, priority: 2.5, reverb: 1.2, render(s) {
        // Descending shriek + roaring fire trail.
        const T = s.t;
        const g = s.gain(0, s.out);
        const bp = s.filter('bandpass', 3000, 3, g);
        bp.frequency.setValueAtTime(4000, T);
        bp.frequency.exponentialRampToValueAtTime(500, T + 3);
        g.gain.setValueAtTime(0, T);
        g.gain.linearRampToValueAtTime(0.5, T + 2.6);
        g.gain.linearRampToValueAtTime(0, T + 3.1);
        s.noiseSrc('white', T, 3.1, bp);
        rumble(s, 0.5, 2.6, 300, 0.6, 2);
        crackles(s, 1, 2, 40, 1000, 5000, 0.12);
      },
    }),
    meteor_impact: sd({
      dur: 6, variants: 3, group: 'big', gain: 1, ref: 30, range: 3000, priority: 3, reverb: 1.5, render(s) {
        s.tone({ f: 60, f2: 18, glide: 1.2, a: 0.003, d: 2.2, peak: 1 });
        s.burst({ dur: 2.5, f: 7000, f2: 120, q: 0.5, type: 'lowpass', peak: 1, color: 'pink', a: 0.002 });
        rumble(s, 0.05, 5.5, 140, 0.9, 0.1);
        debris(s, 0.4, 30, 600, STONE, 0.2, 2.2);
        crackles(s, 0.1, 4, 60, 800, 5000, 0.15);
      },
    }),
    item_break: sd({
      dur: 1.2, variants: 4, group: 'foley', gain: 0.7, ref: 2, render(s) {
        s.burst({ dur: 0.03, f: 3000, q: 0.6, peak: 0.6 });
        s.modal(0, s.r(700, 1100), METAL, 0.12);
        crackles(s, 0, 0.15, 12, 1500, 6000, 0.2);
        debris(s, 0.08, 5, 1400, METAL, 0.03, 0.8);
      },
    }),
    pebble: sd({ dur: 0.8, variants: 6, group: 'world', gain: 0.5, ref: 2, render: (s) => debris(s, 0, s.ri(2, 5), s.r(1200, 2200), STONE, 0.12, 0.7) }),
    pluck: sd({
      dur: 0.4, variants: 6, group: 'foley', gain: 0.4, ref: 1.5, range: 30, render(s) {
        s.burst({ dur: 0.06, f: 2500, q: 1, peak: 0.25, a: 0.01 });
        crunch(s, 0.02, 0.06, 5, 3000, 8000, 0.08, 2);
        s.click(0.05, 1800, 0.15);
      },
    }),
    poof: sd({
      dur: 1, variants: 4, group: 'magic', gain: 0.5, ref: 2, render(s) {
        s.burst({ dur: 0.5, f: 1800, f2: 500, q: 0.5, peak: 0.5, type: 'lowpass', color: 'pink', a: 0.01 });
        whoosh(s, 0, 0.4, 400, 1600, 0.2, 1);
      },
    }),
    serenade: sd({
      dur: 3.5, variants: 3, group: 'magic', gain: 0.5, ref: 3, render(s) {
        // A short plucked phrase in the world's own scale.
        let t = 0;
        let d = s.ri(0, 3);
        for (let i = 0; i < 7; i++) {
          const f = N(d);
          s.tone({ t, f, d: 0.6, peak: 0.25, type: 'triangle', a: 0.003 });
          s.tone({ t, f: f * 2, d: 0.25, peak: 0.08, a: 0.003 });
          t += s.pick([0.18, 0.25, 0.36]);
          d += s.pick([-1, 1, 1, 2, -2]);
        }
      },
    }),
    aurora: sd({
      dur: 9, variants: 2, bus: 'ambience', group: 'ambient', stereo: true, gain: 0.35, reverb: 0.5, priority: 1, render(s) {
        // Sky-wide shimmering choir, tuned to the world scale.
        for (let i = 0; i < 9; i++) {
          const p = s.stereo(s.r(-0.9, 0.9), s.out);
          s.tone({ t: s.r(0, 3), f: N(s.ri(0, 8)) * 2, a: s.r(2, 3.5), d: s.r(3, 5), peak: 0.05, vib: s.r(6, 20), vibRate: s.r(0.3, 1.5), lin: true, dest: p });
        }
      },
    }),
    eclipse: sd({
      dur: 10, variants: 1, bus: 'music', group: 'ui', stereo: true, gain: 0.6, reverb: 0.5, priority: 3, render(s) {
        // Ominous low swell with slow beating.
        const g = s.gain(0, s.out);
        const lp = s.filter('lowpass', 500, 1, g);
        for (const [f, det] of [[N(-10), 0], [N(-10) * 1.06, 4], [N(-15), -3]] as [number, number][]) {
          const o = s.osc('sawtooth', f, s.t, 9.5, lp);
          o.detune.value = det;
        }
        g.gain.setValueAtTime(0, s.t);
        g.gain.linearRampToValueAtTime(0.15, s.t + 4);
        g.gain.linearRampToValueAtTime(0, s.t + 9.5);
        s.thump(0, 35, 0.5, 2, undefined, 0.6);
      },
    }),
    ui_respawn: sd({
      dur: 3, variants: 1, bus: 'ui', group: 'ui', stereo: true, reverb: 0, gain: 0.55, priority: 3, render(s) {
        whoosh(s, 0, 1.2, 200, 3000, 0.1, 1.2);
        [0, 2, 4, 7].forEach((d, i) => s.fm(0.6 + i * 0.12, N(d), 2, 1, 1.6, 0.08));
      },
    }),
    ui_craft: sd({
      dur: 1.6, variants: 2, bus: 'ui', group: 'ui', stereo: true, reverb: 0, gain: 0.55, priority: 2, render(s) {
        s.modal(0, 1000, METAL, 0.12);
        s.click(0, 4000, 0.2);
        s.modal(0.2, N(7) * 2, GLASS, 0.06);
      },
    }),
    creak: sd({ dur: 1.5, variants: 4, group: 'world', gain: 0.5, render: (s) => creak(s, 0, 1.2, 20, 50, 500, 0.3) }),
  };
}

/**
 * fx ids used by gameplay / GM ('fx' game events) → sound. null = silent
 * visual (status markers, social flavour). Unknown ids fall back to keywords.
 */
const FX_SOUNDS: Record<string, string | null> = {
  arrow: null, arrow_fire: null, arrow_power: null, assault: 'swing_heavy', aurora: 'aurora', axe: 'throw', bleed: null, bless: 'buff',
  blind: 'light_impact', blink_in: 'teleport', blink_out: 'teleport', block: 'block', bolas: 'throw', bond: 'buff', bore: 'dig_stone',
  boulder: 'earth_cast', build: 'hammer', burning: 'fire_crackle', buy: 'ui_buy', calm: null, cast: 'spell_charge', chain: 'shock_impact',
  challenge: null, charm: 'arcane_cast', chill: 'frost_impact', claim: null, courage: 'buff', crush: 'earth_impact', dash: 'swing_heavy',
  disc: 'arcane_cast', distract: null, dodge: 'swing_light', drill: 'dig_stone', dust: 'debris', earn: 'coins', earth_rise: 'earth_cast',
  earth_spike: 'earth_impact', eclipse: 'eclipse', empower: 'buff', ench_fire: 'fire_cast', ench_frost: 'frost_cast', ench_poison: 'poison_cast',
  ench_radiant: 'light_cast', ench_shock: 'shock_cast', evasive: 'buff', explosion: 'explosion', exposed: 'debuff', fear: 'shadow_cast',
  feast: 'eat', feather: 'wind_cast', fence: null, fetched: 'pickup', fireball: 'fire_cast', fireball_impact: 'fire_impact',
  firestorm: 'fire_impact', fissure: 'earth_impact', fizzle: 'spell_fizzle', flamecloak: 'fire_cast', flash: 'light_impact', flask: 'potion',
  flask_green: 'potion', focus: 'buff', force_cone: 'force_cast', fortify: 'shield', frost_bolt: 'frost_cast', frost_nova: 'frost_impact',
  frostarmor: 'frost_cast', frostfeet: 'frost_cast', frozen: 'ice_crack', gathered: 'pickup', gift: 'pickup', glide: 'wind_cast', glow: null,
  glyph_burst: 'rune_impact', gravhigh: 'gravity_cast', gravity_tide: 'gravity_impact', gravlow: 'gravity_cast', grip: 'earth_cast', guards: null,
  halo: 'light_cast', haste: 'buff', heirloom: null, herbs: 'pluck', hire: 'coins', host: null, ice_lance: 'frost_cast', ignite: 'fire_cast',
  inscribe: 'rune_cast', inspire: 'buff', invis: 'shadow_cast', kill: null, knife: 'throw', launch: 'force_impact', leap: 'jump',
  levelup: null, levitate: 'gravity_cast', mana: 'arcane_cast', marked: 'debuff', meteor: 'meteor_fall', meteor_fall: 'meteor_fall',
  meteor_impact: 'meteor_impact', mourn: null, muster: null, notes: 'ui_page', ore_ping: 'rune_impact', outwork: null, parry: 'parry',
  pay: 'coins', phase: 'teleport', plant_ping: 'heal_impact', poison: 'poison_impact', pray: 'heal_cast', progress: null, propose: null,
  pull_beam: 'gravity_cast', rage: 'beast_cast', recall: 'teleport', reconcile: null, reflect: 'shield', regen: 'heal_cast', resist: 'shield',
  reveal: 'light_cast', riposte: 'parry', roar_cone: 'beast_cast', rock_burst: 'rock_shatter', roots: 'earth_cast', rope: 'throw',
  rope_arrow: 'bow_release', scare: 'shadow_cast', serenade: 'serenade', shadow: 'shadow_cast', shadow_bolt: 'shadow_cast',
  shadow_tendril: 'shadow_impact', shadowcloak: 'shadow_cast', shatter: 'crystal_shatter', shield: 'shield', shield_hit: 'block',
  shock: 'shock_impact', silence: 'debuff', slander: null, slay: 'hit_crit', sleep: 'debuff', slow: 'debuff', smoke_puff: 'poof',
  spirit: 'arcane_cast', spit: 'poison_cast', stagger: null, steal: 'pickup', stone: 'earth_cast', study: 'ui_page', stun: 'force_impact',
  summon: 'summon', sunlance: 'light_cast', tame: 'beast_cast', taunt: null, tend: 'heal_cast', thorns: 'hit_plant', track: null, tracked: null,
  transmute: 'arcane_impact', trap: 'hit_metal', unstoppable: 'buff', unsummon: 'teleport', vulnerable: 'debuff', ward: 'shield',
  warm: 'fire_crackle', watch: null, water: 'water_cast', weak: 'debuff', wet: 'splash_small', wind: 'wind_cast', wood: 'hit_wood',
  wood_chips: 'hit_wood',
};

/** Sounds that are 2D (no world position) even when an fx/sound event carries one. */
export const GLOBAL_SOUNDS = new Set(['aurora', 'eclipse', 'level_up', 'unlock', 'quest_start', 'quest_complete', 'discovery', 'death_sting']);

/** Map an fx id (from 'fx' game events) to a sound name, or null for silent visual fx. */
export function soundForFx(cat: SoundCatalog, fx: string): string | null {
  const n = fx.toLowerCase();
  if (n in FX_SOUNDS) return FX_SOUNDS[n];
  if (/^(aura|glow|sparkle_idle|trail|highlight|marker|indicator|ambient|idle)/.test(n)) return null;
  if (/level/.test(n)) return 'level_up';
  if (/blood|gore/.test(n)) return 'hit_flesh';
  if (/dust|debris|rubble/.test(n)) return 'debris';
  if (/footstep|step/.test(n)) return null;
  if (/fire|flame/.test(n) && /burning|crackle/.test(n)) return 'fire_crackle';
  const r = cat.resolve(n);
  // Unknown visual-only ids resolve to the generic fallback — keep those silent.
  return r === 'drop' ? null : r;
}

export { SCHOOLS };
