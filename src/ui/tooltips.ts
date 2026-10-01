/**
 * Rich tooltip cards: items (stats, affixes, lore, value, weight, comparison with
 * the equipped item), abilities (costs, cooldown, damage, unlock source) and
 * status effects.
 */
import type { ItemInstance, Equipment, EquipSlot } from '../items/types';
import type { AbilityDef, ActiveEffect } from '../gameplay/types';
import { h } from './dom';
import { RARITY_COLOR, RARITY_LABEL, DAMAGE_COLOR, statLine, cap, titleize, fmtNum, fmtCoins, fmtDuration } from './format';
import { itemDefOf, itemCategory, itemSlots, skillOrStub } from './data';
import { frame } from './widgets';
import { glyphSvg } from './icons';

const SKIP_STATS = new Set(['damage', 'armor']);

export function itemCard(item: ItemInstance, opts: { compare?: ItemInstance; label?: string; price?: { label: string; value: number }; hint?: string } = {}): HTMLElement {
  const def = itemDefOf(item.defId);
  const color = RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common;
  const cat = def?.category ?? itemCategory(item);
  const slots = def?.slots ?? itemSlots(item);
  const card = frame('n-tip-card');
  card.style.borderColor = color + '88';
  card.style.boxShadow = `0 0 24px ${color}22, var(--n-shadow)`;
  if (opts.label) card.append(h('div', { class: 'n-tip-tag', text: opts.label }));
  card.append(h('div', { class: 'n-tip-title', text: item.count > 1 ? `${item.name} ×${item.count}` : item.name, style: { color } }));
  const sub = [RARITY_LABEL[item.rarity], item.material && item.material !== 'none' ? cap(item.material) : '', cat ? cap(cat) : '', slots.length ? slots.map(slotName).filter(uniq).join(' / ') : '']
    .filter(Boolean)
    .join(' · ');
  card.append(h('div', { class: 'n-tip-sub', text: sub }));
  if (def?.twoHanded) card.append(h('div', { class: 'n-tip-sub', text: 'Two-handed' }));

  // Headline numbers: weapon damage or armor.
  const w = def?.weapon;
  const q = 0.75 + item.quality * 0.5;
  const cmp = opts.compare;
  if (w) {
    const dmg = (item.mods.damage ?? w.damage * q);
    const cdmg = cmp ? cmp.mods.damage ?? (itemDefOf(cmp.defId)?.weapon?.damage ?? 0) * (0.75 + cmp.quality * 0.5) : null;
    card.append(
      h('div', { style: 'display:flex;align-items:baseline;gap:8px;margin-top:8px' },
        h('span', { class: 'n-tip-big', text: fmtNum(Math.round(dmg)) }),
        h('span', { class: 'n-dim', html: `<span style="color:${DAMAGE_COLOR[w.type]}">${cap(w.type)}</span> damage` }),
        cdmg !== null ? delta(dmg - cdmg) : null,
      ),
      h('div', { class: 'n-tip-stats' },
        h('span', { class: 'n-dim', text: 'Speed' }), h('span', { class: 'v', text: w.speed.toFixed(2) }),
        h('span', { class: 'n-dim', text: 'Reach' }), h('span', { class: 'v', text: `${w.reach.toFixed(1)} m` }),
        h('span', { class: 'n-dim', text: 'Skill' }), h('span', { class: 'v', text: skillOrStub(w.skill).name }),
      ),
    );
  } else if (def?.armor || item.mods.armor) {
    const ar = item.mods.armor ?? (def?.armor?.armor ?? 0) * q;
    const car = cmp ? cmp.mods.armor ?? 0 : null;
    card.append(
      h('div', { style: 'display:flex;align-items:baseline;gap:8px;margin-top:8px' },
        h('span', { class: 'n-tip-big', text: fmtNum(Math.round(ar)) }),
        h('span', { class: 'n-dim', text: 'Armor' }),
        car !== null ? delta(ar - car) : null,
      ),
    );
    if (def?.armor && def.armor.heaviness > 0.5) card.append(h('div', { class: 'n-tip-sub n-warn', text: 'Heavy — hinders spellcasting & stealth' }));
  }
  if (def?.tool) card.append(h('div', { class: 'n-tip-stats' }, h('span', { class: 'n-dim', text: `${cap(def.tool.kind)} power` }), h('span', { class: 'v', text: fmtNum(def.tool.power) })));

  // Stat modifiers (with comparison deltas).
  const keys = Object.keys(item.mods).filter((k) => !SKIP_STATS.has(k) && item.mods[k]);
  const cmpKeys = cmp ? Object.keys(cmp.mods).filter((k) => !SKIP_STATS.has(k) && cmp.mods[k] && !keys.includes(k)) : [];
  if (keys.length || cmpKeys.length) {
    const grid = h('div', { class: 'n-tip-stats' });
    for (const k of keys) {
      const [label, val] = statLine(k, item.mods[k]);
      const d = cmp ? item.mods[k] - (cmp.mods[k] ?? 0) : 0;
      grid.append(h('span', { text: label }), h('span', { class: `v ${d > 1e-6 ? 'up' : d < -1e-6 ? 'down' : ''}`, text: val }));
    }
    for (const k of cmpKeys) {
      const [label] = statLine(k, cmp!.mods[k]);
      grid.append(h('span', { class: 'n-faint', text: label }), h('span', { class: 'v down', text: statLine(k, -cmp!.mods[k])[1] }));
    }
    card.append(grid);
  }

  if (def?.consumable) {
    for (const e of def.consumable.effects)
      card.append(h('div', { class: 'n-tip-affix', text: `${titleize(e.id)} ${fmtNum(e.magnitude)}${e.duration ? ` for ${fmtDuration(e.duration)}` : ''}` }));
  }
  if (def?.light) card.append(h('div', { class: 'n-tip-affix', text: `Sheds light (${def.light.radius} m)` }));
  for (const a of item.affixes) {
    card.append(h('div', { class: 'n-tip-affix', text: `${a.prefix ? 'Prefix' : 'Suffix'} · ${a.name}` }));
    if (a.grants) card.append(h('div', { class: 'n-tip-affix grant', html: `${glyphSvg('sparkle', 12)} Grants: ${titleize(a.grants.replace(/^ench\./, ''))}` }));
  }
  if (def?.requires) {
    for (const [s, lvl] of Object.entries(def.requires)) card.append(h('div', { class: 'n-tip-sub', text: `Requires ${skillOrStub(s).name} ${lvl}` }));
  }
  const lore = item.lore ?? def?.description;
  if (lore) card.append(h('div', { class: 'n-tip-lore', text: lore }));
  if (item.origin) card.append(h('div', { class: 'n-tip-sub', style: 'margin-top:6px;text-transform:none;letter-spacing:0', text: item.origin }));

  const foot = h('div', { class: 'n-tip-foot' });
  const quality = item.quality >= 0.85 ? 'Masterwork' : item.quality >= 0.65 ? 'Fine' : item.quality >= 0.35 ? 'Standard' : 'Crude';
  foot.append(h('span', { text: quality }));
  if (item.maxDurability > 0) {
    const pct = item.durability / item.maxDurability;
    foot.append(h('span', { class: pct < 0.25 ? 'n-bad' : '', text: `${Math.ceil(item.durability)}/${item.maxDurability}` }));
  }
  if (def) foot.append(h('span', { text: `${fmtNum(+(def.weight * item.count).toFixed(1))} wt` }));
  foot.append(h('span', { class: 'n-gold', html: `${glyphSvg('coin', 12, '#e9cd6f')} ${fmtCoins(opts.price?.value ?? item.value * item.count)}` }));
  card.append(foot);
  if (opts.price) card.append(h('div', { class: 'n-tip-hint', text: opts.price.label }));
  if (opts.hint) card.append(h('div', { class: 'n-tip-hint', text: opts.hint }));
  return card;
}

function uniq(v: string, i: number, a: string[]) {
  return a.indexOf(v) === i;
}

function slotName(s: EquipSlot): string {
  return s === 'ring1' || s === 'ring2' ? 'Ring' : s === 'mainhand' ? 'Main hand' : s === 'offhand' ? 'Off hand' : cap(s);
}

function delta(d: number): HTMLElement | null {
  if (Math.abs(d) < 0.5) return null;
  return h('span', { class: d > 0 ? 'n-good' : 'n-bad', style: 'font-weight:600', text: `${d > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(Math.round(d)))}` });
}

/** Item tooltip content with comparison card for the equipped counterpart. */
export function itemTooltip(item: ItemInstance, equipment: Equipment | null, extra: Parameters<typeof itemCard>[1] = {}): HTMLElement[] {
  if (!equipment) return [itemCard(item, extra)];
  const isEquipped = Object.values(equipment).some((e) => e?.uid === item.uid);
  if (isEquipped) return [itemCard(item, { ...extra, label: 'Equipped' })];
  const slots = itemSlots(item);
  const other = slots.map((s) => equipment[s]).find((e): e is ItemInstance => !!e);
  if (!other) return [itemCard(item, extra)];
  return [itemCard(item, { ...extra, compare: other }), itemCard(other, { label: 'Currently equipped' })];
}

export function abilityCard(def: AbilityDef, opts: { unlocked: boolean; unlockLevel?: number; cooldownLeft?: number; hint?: string }): HTMLElement {
  const skill = def.skill ? skillOrStub(def.skill) : null;
  const card = frame('n-tip-card');
  card.append(
    h('div', { class: 'n-tip-title n-gold', text: def.name }),
    h('div', { class: 'n-tip-sub', text: [skill?.name, cap(def.kind), cap(def.role), def.targeting !== 'self' ? cap(def.targeting) : 'Self'].filter(Boolean).join(' · ') }),
  );
  const stats = h('div', { class: 'n-tip-stats' });
  const row = (k: string, v: string, cls = '') => stats.append(h('span', { class: 'n-dim', text: k }), h('span', { class: `v ${cls}`, text: v }));
  if (def.cost.mana) row('Mana', fmtNum(def.cost.mana), 'n-mana-text');
  if (def.cost.stamina) row('Stamina', fmtNum(def.cost.stamina));
  if (def.cost.hp) row('Health', fmtNum(def.cost.hp), 'down');
  if (def.damage) row('Damage', `${fmtNum(def.damage.amount)} ${def.damage.type}`);
  if (def.range) row('Range', `${fmtNum(def.range)} m`);
  row('Cast', def.channel ? 'Channeled' : def.toggle ? 'Toggle' : def.castTime > 0 ? `${def.castTime.toFixed(1)} s` : 'Instant');
  if (def.cooldown) row('Cooldown', fmtDuration(def.cooldown));
  card.append(stats);
  if (def.description) card.append(h('div', { class: 'n-tip-lore', style: 'font-style:normal;color:var(--n-ink)', text: def.description }));
  if (def.tags.length) card.append(h('div', { class: 'n-tip-sub', style: 'margin-top:8px', text: def.tags.join(' · ') }));
  if (!opts.unlocked && opts.unlockLevel !== undefined && skill) card.append(h('div', { class: 'n-tip-hint n-warn', text: `Unlocks at ${skill.name} ${opts.unlockLevel}` }));
  if (opts.cooldownLeft && opts.cooldownLeft > 0) card.append(h('div', { class: 'n-tip-hint', text: `Ready in ${fmtDuration(opts.cooldownLeft)}` }));
  if (opts.hint) card.append(h('div', { class: 'n-tip-hint', text: opts.hint }));
  return card;
}

export function effectCard(e: ActiveEffect, serverTime: number, harmful: boolean): HTMLElement {
  const left = e.until - serverTime;
  return frame(
    'n-tip-card',
    h('div', { class: `n-tip-title ${harmful ? 'n-bad' : 'n-good'}`, text: titleize(e.id) + (e.stacks && e.stacks > 1 ? ` ×${e.stacks}` : '') }),
    h('div', { class: 'n-tip-sub', text: harmful ? 'Affliction' : 'Blessing' }),
    h('div', { class: 'n-tip-stats' },
      h('span', { class: 'n-dim', text: 'Magnitude' }), h('span', { class: 'v', text: fmtNum(+e.magnitude.toFixed(2)) }),
      h('span', { class: 'n-dim', text: 'Remaining' }), h('span', { class: 'v', text: Number.isFinite(left) ? fmtDuration(left) : 'Permanent' }),
    ),
  );
}
