/**
 * Formatting & presentation constants shared by every UI surface: rarity colors,
 * damage-type colors, stat labels, time of day, numbers.
 */
import type { Rarity, ItemInstance, EquipSlot } from '../items/types';
import type { DamageType } from '../shared/types';

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#cfc8b8',
  uncommon: '#7ccf62',
  rare: '#5b9cf0',
  epic: '#b874f0',
  legendary: '#f2992e',
  unique: '#e9cd6f',
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', unique: 'Unique',
};

export const DAMAGE_COLOR: Record<DamageType, string> = {
  slash: '#e8e0d0', pierce: '#d8d2c4', blunt: '#cfc3ad', fire: '#ff8a3c', frost: '#8fd6ff', shock: '#c7b8ff',
  force: '#f0e6a8', poison: '#9be36b', radiant: '#ffe58a', shadow: '#b07cff', psychic: '#ff7ad9', fall: '#d4c2a4',
};

export const SLOT_LABEL: Record<EquipSlot, string> = {
  head: 'Head', face: 'Face', neck: 'Neck', shoulders: 'Shoulders', chest: 'Chest', back: 'Back', wrists: 'Wrists',
  hands: 'Hands', waist: 'Waist', legs: 'Legs', feet: 'Feet', ring1: 'Ring', ring2: 'Ring', mainhand: 'Main Hand',
  offhand: 'Off Hand', trinket: 'Trinket',
};

const STAT_LABEL: Record<string, string> = {
  maxHp: 'Health', maxStamina: 'Stamina', maxMana: 'Mana', hpRegen: 'Health regen', staminaRegen: 'Stamina regen',
  manaRegen: 'Mana regen', armor: 'Armor', moveSpeed: 'Move speed', jump: 'Jump', carry: 'Carry capacity',
  stealth: 'Stealth', perception: 'Perception', damage: 'Damage', attackSpeed: 'Attack speed', crit: 'Critical chance',
  critDamage: 'Critical damage', spellPower: 'Spell power', castSpeed: 'Cast speed', block: 'Block', lifesteal: 'Life steal',
};

const PERCENT_STATS = new Set(['moveSpeed', 'jump', 'attackSpeed', 'crit', 'critDamage', 'castSpeed', 'lifesteal']);

export function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "fire_bolt" / "fireBolt" → "Fire Bolt". */
export function titleize(id: string): string {
  return id
    .replace(/^[a-z]+\./, (m) => (m === 'skill.' || m === 'resist.' ? m : ''))
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(cap)
    .join(' ');
}

/** Human readable stat modifier label & value, e.g. ["Fire resistance", "+12%"]. */
export function statLine(key: string, v: number): [string, string] {
  let label: string;
  let pct = PERCENT_STATS.has(key);
  if (key.startsWith('resist.')) {
    label = `${cap(key.slice(7))} resistance`;
    pct = Math.abs(v) <= 1;
  } else if (key.startsWith('skill.')) label = titleize(key.slice(6));
  else label = STAT_LABEL[key] ?? titleize(key);
  const val = pct && Math.abs(v) <= 3 ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%` : `${v >= 0 ? '+' : ''}${fmtNum(v)}`;
  return [label, val];
}

export function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v));
}

export function fmtCoins(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

export function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

/** Seconds → "1m 05s" / "42s" / "2h 10m". */
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '∞';
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Time of day 0..1 → "14:35". */
export function fmtClock(t: number): string {
  const mins = Math.floor((((t % 1) + 1) % 1) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function dayPhase(t: number): string {
  const h = (((t % 1) + 1) % 1) * 24;
  if (h < 4.5) return 'Deep night';
  if (h < 6.5) return 'Dawn';
  if (h < 11) return 'Morning';
  if (h < 14) return 'Midday';
  if (h < 17.5) return 'Afternoon';
  if (h < 20) return 'Dusk';
  if (h < 22.5) return 'Evening';
  return 'Night';
}

export function rgbCss(c: readonly [number, number, number], a = 1): string {
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

export function rgbHex(c: readonly [number, number, number]): string {
  return '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rarityOf(item: Pick<ItemInstance, 'rarity'>): string {
  return RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
