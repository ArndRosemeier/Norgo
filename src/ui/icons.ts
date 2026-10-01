/**
 * Procedural SVG icons for abilities, skills, status effects and item fallbacks.
 * Abilities/skills only carry an `icon` id string; we map it (and the ability's
 * tags / damage type / school) onto a hand-drawn glyph and tint a rune badge, so
 * every catalog entry gets a distinct, cohesive icon without any image assets.
 */
import type { AbilityDef, SkillDef } from '../gameplay/types';
import type { ItemCategory, ItemInstance } from '../items/types';
import { DAMAGE_COLOR, RARITY_COLOR } from './format';

/** Glyphs: inner SVG markup in a 24×24 box, drawn with currentColor. `S:` prefix = stroked. */
const G: Record<string, string> = {
  flame: '<path d="M12 2c1 4-3 5.5-3 9.5a3 3 0 0 0 6 0c0-1.6-.8-2.6-1-4 2.4 1.6 4 4.2 4 7a6 6 0 0 1-12 0C6 9.4 11 7.6 12 2z"/>',
  frost: 'S:<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5M3 10.5l3.7-1.3L6 5.5M21 13.5l-3.7 1.3.7 3.7M3 13.5l3.7 1.3L6 18.5M21 10.5l-3.7-1.3.7-3.7"/>',
  bolt: '<path d="M13.5 2 4 14h7l-1.5 8L19 10h-7l1.5-8z"/>',
  shield: '<path d="M12 2 4 5v6c0 5.2 3.4 9.3 8 11 4.6-1.7 8-5.8 8-11V5l-8-3zm0 3 5 1.9V11c0 3.7-2.2 6.7-5 8z" fill-rule="evenodd"/>',
  sword: 'S:<path d="M20 4h-4.5L6 13.5 10.5 18 20 8.5zM4.5 15l4.5 4.5M7 17.5 3.5 21"/>',
  axe: 'S:<path d="M5 21 15 8M12 4c3-1.5 6.5-1 8 1.5 1 2-.2 5.5-3 7.5-1-3-3-5.5-5-9z"/>',
  bow: 'S:<path d="M6 3c7.5 2 13 7.5 15 15M6 3l15 15M3.5 20.5l9-9M3.5 20.5h4M3.5 20.5v-4"/>',
  dagger: 'S:<path d="M19 5 9.5 14.5M15 4l5 5M7 12l5 5M7.5 16.5 4 20"/>',
  fist: '<path d="M6 10V7a1.5 1.5 0 0 1 3 0V6a1.5 1.5 0 0 1 3 0 1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6.5 7S5 17.5 5 14v-2.5A1.5 1.5 0 0 1 6 10z"/>',
  skull: '<path fill-rule="evenodd" d="M12 2.5a7.5 7.5 0 0 0-7.5 7.5c0 2.6 1.3 4.5 3 5.5V19a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3.5c1.7-1 3-2.9 3-5.5A7.5 7.5 0 0 0 12 2.5zM9 9a1.9 1.9 0 1 1 0 3.8A1.9 1.9 0 0 1 9 9zm6 0a1.9 1.9 0 1 1 0 3.8A1.9 1.9 0 0 1 15 9zm-3 4.2 1.2 2.3h-2.4z"/>',
  heart: '<path d="M12 21s-8.5-5.2-8.5-11.2A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.5 3.2C20.5 15.8 12 21 12 21z"/>',
  cross: '<path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z"/>',
  leaf: '<path d="M4.5 20c-.5-9.5 5.5-15.5 16-16-.3 10.5-6.5 16.4-16 16zm1.6-1.4 8-8-.8-.8-8 8z" fill-rule="evenodd"/>',
  drop: '<path d="M12 2.5s6.5 7.2 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.5 12 2.5z"/>',
  star: '<path d="m12 2 2.7 6.6 7.1.5-5.4 4.6 1.7 6.9L12 16.9l-6.1 3.7 1.7-6.9-5.4-4.6 7.1-.5z"/>',
  sparkle: '<path d="M12 2c.6 4.8 2.2 6.4 7 7-4.8.6-6.4 2.2-7 7-.6-4.8-2.2-6.4-7-7 4.8-.6 6.4-2.2 7-7zM18.5 15c.3 2.2 1 3 3.2 3.2-2.2.3-2.9 1-3.2 3.3-.3-2.3-1-3-3.3-3.3 2.3-.2 3-1 3.3-3.2z"/>',
  moon: '<path d="M15.5 2.5a9.5 9.5 0 1 0 6 16.6A8 8 0 0 1 15.5 2.5z"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  spiral: 'S:<path d="M12.5 12a.8.8 0 1 1-1.2-.7 2.6 2.6 0 1 1-1.5 4.6 4.6 4.6 0 1 1 7.6-3.9 6.8 6.8 0 1 1-6.5-6.8 8.8 8.8 0 0 1 8.9 7.9"/>',
  eye: '<path fill-rule="evenodd" d="M1.5 12S5.5 4.8 12 4.8 22.5 12 22.5 12 18.5 19.2 12 19.2 1.5 12 1.5 12zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z"/>',
  wind: 'S:<path d="M3 8.5h11a3 3 0 1 0-3-3M3 12.5h15.5a3 3 0 1 1-3 3M3 16.5h7"/>',
  feather: 'S:<path d="M20.5 3.5C11 3.5 5.5 9.5 5 20.5M4 21.5l2-2M8.5 15.5h6M10.5 11.5h7.5M13.5 7.5h6"/>',
  mountain: '<path d="M1.5 20.5 9 6.5l4.2 6.4 2.9-3.9 6.4 11.5z"/><path d="m9 6.5 1.8 3.3-1.8-.9-1.6 1.1z" fill="#000" fill-opacity=".35"/>',
  quake: 'S:<path d="M2 15h4l2-5 3 9 3-12 2.5 8H22M4 20.5h16"/>',
  orb: '<circle cx="12" cy="12" r="4.8"/><ellipse cx="12" cy="12" rx="10" ry="3.6" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(-24 12 12)"/>',
  gravity: 'S:<path d="M12 3v12M7 10l5 5 5-5M4 20.5h16M7 18h10"/>',
  portal: 'S:<ellipse cx="12" cy="12" rx="6" ry="9.5"/><ellipse cx="12" cy="12" rx="3" ry="6"/><path d="M12 6v12"/>',
  hand: '<path d="M8 13V5.2a1.4 1.4 0 0 1 2.8 0V11V3.8a1.4 1.4 0 0 1 2.8 0V11V5.2a1.4 1.4 0 0 1 2.8 0V11V7.8a1.4 1.4 0 0 1 2.8 0V14c0 4.4-3 7.5-7.2 7.5-3 0-5-1.6-6.3-4.2l-2-4c-.6-1.2.9-2.3 1.9-1.4z"/>',
  hammer: '<path d="m14.2 3.6 6.2 6.2-2.4 2.4-1.7-1.7-1.6 1.6-2.4-2.4 1.6-1.6-1.4-1.4zM11.6 9.3l2.4 2.4-9.1 9.1a1.7 1.7 0 0 1-2.4-2.4z"/>',
  pick: 'S:<path d="M5 20 15 10M5 7.5C9 3.5 15 3 20 6.5c-3.5-.5-6.5.5-8.5 2.5M16.5 4c3.5 4 3.5 8.5 3 10.5-.5-3-1.5-5.5-3.5-7"/>',
  anvil: '<path d="M2.5 7.5H16c0 2.9 2 4.1 5.5 4.1v2.2h-6.3l2 3.2v2.5H6.8V17l2-3.2C4.7 13.8 2.5 11.5 2.5 7.5z"/>',
  flask: 'S:<path d="M9 3h6M10 3v6.5l-5.3 9A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.5-2.5l-5.3-9V3M7.5 15.5h9"/>',
  speech: '<path d="M3 4.5h18v11.5H10l-5.5 4.5v-4.5H3z"/><path d="M7 9h10M7 12h7" stroke="#000" stroke-opacity=".35" stroke-width="1.6"/>',
  mask: '<path fill-rule="evenodd" d="M2.5 8.5c4-3 15-3 19 0-.4 7-4.5 10.5-9.5 10.5S2.9 15.5 2.5 8.5zm5.5 2.2c-1.6 0-2.6.8-2.8 1.8 1 .9 3.7 1 4.8-.4-.4-.9-1.1-1.4-2-1.4zm8 0c-.9 0-1.6.5-2 1.4 1.1 1.4 3.8 1.3 4.8.4-.2-1-1.2-1.8-2.8-1.8z"/>',
  key: '<path fill-rule="evenodd" d="M7.5 7.5a5 5 0 0 1 4.8 3.5H22v3h-2v3h-3v-3h-4.7a5 5 0 1 1-4.8-6.5zm0 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  footsteps: '<ellipse cx="8" cy="7.5" rx="2.6" ry="4"/><ellipse cx="8" cy="14.2" rx="1.8" ry="1.4"/><ellipse cx="16" cy="11.5" rx="2.6" ry="4"/><ellipse cx="16" cy="18.2" rx="1.8" ry="1.4"/>',
  tree: '<path d="M12 1.8 18.5 11h-3.2l4.2 6.2h-15L8.7 11H5.5zM10.8 17.2h2.4V22h-2.4z"/>',
  crystal: '<path d="m12 1.5 5.5 6.5L12 22.5 6.5 8z"/><path d="M12 1.5 9.5 8 12 22.5z" fill="#000" fill-opacity=".25"/>',
  paw: '<ellipse cx="12" cy="15.5" rx="5" ry="4.2"/><ellipse cx="5.2" cy="9.8" rx="2" ry="2.6"/><ellipse cx="9.3" cy="5.8" rx="2" ry="2.7"/><ellipse cx="14.7" cy="5.8" rx="2" ry="2.7"/><ellipse cx="18.8" cy="9.8" rx="2" ry="2.6"/>',
  wave: 'S:<path d="M2 9c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0M2 15c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0"/>',
  arrow: 'S:<path d="M3 21 20 4M14 4h6v6M3 21l1-4M3 21l4-1"/>',
  burst: '<path d="m12 1.5 2 6.4 5.9-3.4-3.4 5.9 6.4 2-6.4 2 3.4 5.9-5.9-3.4-2 6.4-2-6.4-5.9 3.4 3.4-5.9-6.4-2 6.4-2L4.1 4.5l5.9 3.4z"/>',
  chain: 'S:<path d="M10 14.5 14.5 10M8.5 11.5l-3 3a3.2 3.2 0 0 0 4.5 4.5l3-3M15.5 12.5l3-3A3.2 3.2 0 0 0 14 5l-3 3"/>',
  rune: 'S:<path d="M12 2.5 20.5 12 12 21.5 3.5 12zM12 6.5v11M8.5 10l7 4M15.5 10l-7 4"/>',
  tunic: '<path d="M8 3 3 6l2 5 3-1v11h8V10l3 1 2-5-5-3c-.8 1.6-2.2 2.4-4 2.4S8.8 4.6 8 3z"/>',
  ring: '<circle cx="12" cy="14.5" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m12 2.5 3 3.5-3 3-3-3z"/>',
  ingot: '<path d="M2.5 16.5 6 9h12l3.5 7.5z"/><path d="M6 9h12l-1.5 3h-9z" fill="#fff" fill-opacity=".25"/>',
  apple: '<path d="M12 7.5c-2-1.8-7-1.4-7 4.5 0 4.5 3 9 5 9 .9 0 1.3-.5 2-.5s1.1.5 2 .5c2 0 5-4.5 5-9 0-5.9-5-6.3-7-4.5zM12 7.5c0-2 1-4 3-5"/>',
  book: '<path d="M3.5 4h6.5a2 2 0 0 1 2 2v14.5a2 2 0 0 0-2-2H3.5zM20.5 4H14a2 2 0 0 0-2 2v14.5a2 2 0 0 1 2-2h6.5z"/>',
  scroll: '<path d="M6 2.5h9l4 4V21.5H6z"/><path d="M15 2.5v4h4" fill="#000" fill-opacity=".3"/><path d="M9 11h7M9 14h7M9 17h5" stroke="#000" stroke-opacity=".45" stroke-width="1.4"/>',
  lantern: '<path d="M9 2.5h6v2H9zM7.5 5.5h9l-1 12h-7zM9.5 18.5h5V21h-5z"/><path d="M12 8.5c1.2 1.5 1.8 2.5 1.8 3.6a1.8 1.8 0 0 1-3.6 0c0-1.1.6-2.1 1.8-3.6z" fill="#000" fill-opacity=".45"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="#000" stroke-opacity=".3" stroke-width="1.4"/>',
  hourglass: 'S:<path d="M6 2.5h12M6 21.5h12M7.5 2.5c0 5 9 5 9 9.5s-9 4.5-9 9.5M16.5 2.5c0 5-9 5-9 9.5s9 4.5 9 9.5"/>',
  music: '<path d="M9 17.5V5l11-2.5V15" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6.5" cy="17.5" r="3"/><circle cx="17.5" cy="15" r="3"/>',
  web: 'S:<path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1M12 7l3.5 1.5L17 12l-1.5 3.5L12 17l-3.5-1.5L7 12l1.5-3.5z"/>',
};

export const GLYPHS = Object.keys(G);

/** School/skill keyword → glyph + color. Ordered: first match wins. */
const THEMES: [RegExp, string, string][] = [
  [/pyro|fire|flame|ember|burn|inferno|ignite|heat/, 'flame', '#ff7a2e'],
  [/cryo|frost|ice|snow|cold|freez|glacial|chill/, 'frost', '#7fd0ff'],
  [/storm|shock|lightning|thunder|spark|volt|electr/, 'bolt', '#b9a5ff'],
  [/geo|earth|stone|rock|terra|quake|dig|tremor/, 'mountain', '#c49a5a'],
  [/aero|wind|air|gust|tempest|glide/, 'wind', '#a9e8d6'],
  [/hydro|water|tide|wave|swim|aqua/, 'wave', '#4fb2e8'],
  [/grav|astral|void|levitat|float|weight/, 'orb', '#9b7cff'],
  [/necro|death|undead|bone|soul|drain|blight/, 'skull', '#86d07a'],
  [/shadow|umbra|dark|night|shade/, 'moon', '#a06cf0'],
  [/radian|light|holy|sun|divine|smite|blind/, 'sun', '#ffd86a'],
  [/restor|heal|mend|cure|regen|life|vital|renew/, 'heart', '#7ee0a0'],
  [/illus|psych|mind|charm|enthrall|fear|dream|confus/, 'spiral', '#ff86d4'],
  [/nature|druid|grow|vine|root|thorn|wild|beast|tam/, 'leaf', '#8fd35a'],
  [/poison|venom|toxi|acid/, 'drop', '#a6e05a'],
  [/teleport|blink|portal|phase|warp|recall/, 'portal', '#78b8ff'],
  [/ward|shield|barrier|block|parry|defen|guard|armor|protect/, 'shield', '#d8c27a'],
  [/arcan|mana|spell|rune|enchant|magic/, 'sparkle', '#8aa8ff'],
  [/archer|bow|shoot|arrow|marks/, 'bow', '#d5b98a'],
  [/axe|cleave/, 'axe', '#e0d3bc'],
  [/dagger|stab|backstab|assassin|knife/, 'dagger', '#d8d8e6'],
  [/blade|sword|slash|swords/, 'sword', '#e6dfcc'],
  [/unarmed|punch|brawl|kick|fist|grapple/, 'fist', '#e3b48a'],
  [/mace|hammer|blunt|smash|slam|bludgeon/, 'hammer', '#d0b48e'],
  [/stealth|sneak|thie|shadowstep|lockpick|pickpocket/, 'mask', '#9e9cb8'],
  [/lock|key/, 'key', '#d9c48a'],
  [/smith|forge|craft|anvil|armorsmith|weaponsmith/, 'anvil', '#d9a06a'],
  [/alchem|potion|brew|cook/, 'flask', '#9fe0c6'],
  [/mining|mine|ore/, 'pick', '#bcb2a2'],
  [/wood|lumber|chop|forest|carpent/, 'tree', '#9fcf6a'],
  [/speech|persua|barter|trade|social|intimid|diploma|charisma|lie|bard/, 'speech', '#f0cf8a'],
  [/athlet|run|sprint|jump|leap|climb|acrobat|move|dash|haste/, 'footsteps', '#e6c88a'],
  [/surviv|forag|harvest|herb|gather|hunt/, 'paw', '#c8b07a'],
  [/percep|scout|sense|detect|track|reveal/, 'eye', '#e8e2b8'],
  [/crystal|gem|geode/, 'crystal', '#88f0f0'],
  [/time|slow|haste|temporal/, 'hourglass', '#e0d090'],
  [/song|music|chant/, 'music', '#f0b0d0'],
  [/bind|chain|root|snare|web/, 'chain', '#b8b0a0'],
];

function theme(text: string): [string, string] | null {
  const t = text.toLowerCase();
  for (const [re, g, c] of THEMES) if (re.test(t)) return [g, c];
  return null;
}

const cache = new Map<string, string>();

/** Render a rune badge (data URL). shape: round for abilities, hex for skills, square for effects. */
export function badgeSvg(glyph: string, color: string, shape: 'round' | 'hex' | 'diamond' | 'square' = 'round', dim = false): string {
  const key = `${glyph}|${color}|${shape}|${dim}`;
  const c = cache.get(key);
  if (c) return c;
  const raw = G[glyph] ?? G.rune;
  const stroked = raw.startsWith('S:');
  const inner = stroked ? raw.slice(2) : raw;
  const frame =
    shape === 'hex'
      ? '<path d="M32 3 57 17.5v29L32 61 7 46.5v-29z"/>'
      : shape === 'diamond'
        ? '<path d="M32 2 62 32 32 62 2 32z"/>'
        : shape === 'square'
          ? '<rect x="4" y="4" width="56" height="56" rx="10"/>'
          : '<circle cx="32" cy="32" r="29"/>';
  const glyphAttrs = stroked
    ? `fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"`
    : `fill="${color}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><radialGradient id="b" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="${color}" stop-opacity="${dim ? 0.12 : 0.34}"/><stop offset=".55" stop-color="#15121a" stop-opacity=".96"/><stop offset="1" stop-color="#07060a"/></radialGradient>
<filter id="g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<g fill="url(#b)" stroke="${color}" stroke-opacity="${dim ? 0.3 : 0.75}" stroke-width="2">${frame}</g>
<g transform="translate(14 14) scale(1.5)" color="${color}" ${glyphAttrs} filter="url(#g)" opacity="${dim ? 0.45 : 1}">${inner}</g></svg>`;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  cache.set(key, url);
  return url;
}

/** Decide glyph & color for an ability (icon id → tags → damage type → skill theme). */
export function abilityLook(def: Partial<AbilityDef> & { id: string }, skill?: SkillDef): [string, string] {
  let color = def.damage ? DAMAGE_COLOR[def.damage.type] : undefined;
  const fromSkill = theme(`${skill?.school ?? ''} ${skill?.id ?? ''} ${def.skill ?? ''}`);
  if (!color) color = fromSkill?.[1] ?? (def.kind === 'magic' ? '#8aa8ff' : '#e0d2b4');
  let glyph = def.icon && G[def.icon] ? def.icon : undefined;
  // Shape of the effect first (so a school's abilities differ), element via color.
  if (!glyph) glyph = shapeGlyph(`${def.id} ${def.name ?? ''}`);
  if (!glyph) glyph = theme(`${def.icon ?? ''} ${def.id} ${(def.tags ?? []).join(' ')} ${def.name ?? ''}`)?.[0];
  if (!glyph && def.damage) glyph = { fire: 'flame', frost: 'frost', shock: 'bolt', poison: 'drop', radiant: 'sun', shadow: 'moon', psychic: 'spiral', force: 'burst', slash: 'sword', pierce: 'arrow', blunt: 'hammer', fall: 'gravity' }[def.damage.type];
  if (!glyph) glyph = fromSkill?.[0];
  if (!glyph) glyph = { combat: 'sword', utility: 'sparkle', movement: 'footsteps', defense: 'shield', social: 'speech', crafting: 'anvil' }[def.role ?? 'utility'] ?? 'rune';
  return [glyph, color];
}

const SHAPES: [RegExp, string][] = [
  [/wall|barrier|bulwark|rampart/, 'mountain'], [/meteor|comet|star/, 'star'], [/inferno|nova|explo|storm|blast|burst|eruption/, 'burst'],
  [/ball|orb|sphere|globe/, 'orb'], [/bolt|shard|spear|lance|arrow|dart|spike|needle/, 'arrow'], [/cloak|mantle|aura|skin|armou?r/, 'mask'],
  [/ward|shield|aegis|guard/, 'shield'], [/heal|mend|cure|renew|restor/, 'heart'], [/step|blink|dash|leap|jump|stride|glide/, 'footsteps'],
  [/summon|call|conjur|portal|gate/, 'portal'], [/chain|bind|snare|root|web/, 'chain'], [/pull|push|grip|grab|hand|telekin|throw/, 'hand'],
  [/sight|vision|detect|reveal|sense|eye/, 'eye'], [/quake|tremor|slam|stomp/, 'quake'], [/wave|tide|surge|flood/, 'wave'],
  [/ignite|kindle|spark|light|torch/, 'sun'], [/well|vortex|whirl|spiral|maelstrom/, 'spiral'], [/fear|terror|charm|dream|confus/, 'spiral'],
];

function shapeGlyph(text: string): string | undefined {
  const t = text.toLowerCase();
  return SHAPES.find(([re]) => re.test(t))?.[1];
}

export function abilityIcon(def: Partial<AbilityDef> & { id: string }, skill?: SkillDef, dim = false): string {
  const [g, c] = abilityLook(def, skill);
  return badgeSvg(g, c, 'round', dim);
}

export function skillLook(def: Partial<SkillDef> & { id: string }): [string, string] {
  const t = theme(`${def.icon ?? ''} ${def.school ?? ''} ${def.id} ${def.name ?? ''}`);
  const glyph = def.icon && G[def.icon] ? def.icon : t?.[0] ?? { combat: 'sword', magic: 'sparkle', utility: 'key', craft: 'anvil', social: 'speech', survival: 'paw' }[def.category ?? 'utility'] ?? 'rune';
  const color = t?.[1] ?? CATEGORY_COLOR[def.category ?? 'utility'] ?? '#d4af6a';
  return [glyph, color];
}

export const CATEGORY_COLOR: Record<string, string> = {
  combat: '#e0816a', magic: '#8aa8ff', utility: '#d9c48a', craft: '#d9a06a', social: '#f0cf8a', survival: '#9fcf6a',
};

export function skillIcon(def: Partial<SkillDef> & { id: string }): string {
  const [g, c] = skillLook(def);
  return badgeSvg(g, c, 'hex');
}

/** Status effect icon; buffs gold-green, debuffs red-ish, keyed by effect id keywords. */
export function effectIcon(id: string, harmful: boolean): string {
  const t = theme(id);
  const glyph = t?.[0] ?? (/stun|daze/.test(id) ? 'spiral' : /bleed|wound/.test(id) ? 'drop' : /slow|root/.test(id) ? 'chain' : 'sparkle');
  const color = harmful ? '#ff7a6a' : t?.[1] ?? '#9fe08a';
  return badgeSvg(glyph, color, 'square');
}

const HARMFUL = /burn|poison|bleed|slow|root|stun|frozen|freeze|chill|curse|weak|fear|blind|silence|daze|shock|disease|hex|vulner|gravity_high|exhaust|hunger|cold|wet|confus|drain/;
export function isHarmfulEffect(id: string): boolean {
  return HARMFUL.test(id);
}

const CATEGORY_GLYPH: Record<ItemCategory, string> = {
  weapon: 'sword', armor: 'shield', clothing: 'tunic', jewelry: 'ring', tool: 'pick', consumable: 'flask', material: 'ingot',
  reagent: 'leaf', food: 'apple', book: 'book', key: 'key', quest: 'scroll', trinket: 'sparkle', ammo: 'arrow', light: 'lantern',
};

/** Fallback icon when the item module's renderer isn't available. Guesses glyph from the visual shape. */
export function itemFallbackIcon(item: Pick<ItemInstance, 'defId' | 'rarity'> & { visual?: { shape?: string } }, category?: ItemCategory): string {
  const s = `${item.visual?.shape ?? ''} ${item.defId}`.toLowerCase();
  let glyph = category ? CATEGORY_GLYPH[category] : undefined;
  if (!glyph) {
    const pairs: [RegExp, string][] = [
      [/sword|blade|sabre|scim|katana/, 'sword'], [/axe/, 'axe'], [/bow|crossbow/, 'bow'], [/dagger|knife/, 'dagger'],
      [/mace|hammer|maul|club/, 'hammer'], [/staff|wand|rod|scepter/, 'sparkle'], [/shield|buckler/, 'shield'],
      [/helm|hat|hood|cap|crown/, 'mask'], [/robe|shirt|tunic|coat|vest|cloak|armor|mail|cuirass/, 'tunic'],
      [/ring|amulet|necklace|pendant/, 'ring'], [/potion|flask|vial|elixir/, 'flask'], [/pick/, 'pick'],
      [/ore|ingot|bar|plank|log|stone/, 'ingot'], [/herb|leaf|flower|root|mushroom/, 'leaf'], [/bread|meat|fruit|apple|cheese|stew|fish/, 'apple'],
      [/book|tome/, 'book'], [/scroll|map|letter|note/, 'scroll'], [/key/, 'key'], [/arrow|bolt/, 'arrow'], [/torch|lantern|candle/, 'lantern'],
      [/coin|gold/, 'coin'], [/gem|crystal|shard/, 'crystal'], [/boot|shoe/, 'footsteps'], [/glove|gauntlet/, 'hand'],
    ];
    glyph = pairs.find(([re]) => re.test(s))?.[1] ?? 'rune';
  }
  return badgeSvg(glyph, RARITY_COLOR[item.rarity] ?? '#cfc8b8', 'square');
}

/** Raw glyph as an inline SVG string (for buttons, markers). */
export function glyphSvg(glyph: string, size = 18, color = 'currentColor'): string {
  const raw = G[glyph] ?? G.rune;
  const stroked = raw.startsWith('S:');
  const inner = stroked ? raw.slice(2) : raw;
  const attrs = stroked ? `fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"` : `fill="${color}"`;
  return `<svg class="n-glyph" viewBox="0 0 24 24" width="${size}" height="${size}" style="color:${color}" ${attrs}>${inner}</svg>`;
}
