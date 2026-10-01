/**
 * Inventory & equipment: paper doll (HumanoidPreview with equipment visuals)
 * surrounded by 16 equip slots, filterable/sortable item grid, coins and
 * encumbrance, derived stats, drag & drop (grid ↔ slots ↔ hotbar), context menu.
 */
import { Panel, type UiHost } from '../host';
import { h, setChildren } from '../dom';
import { tooltip, drag, contextMenu, tabs, type MenuItem } from '../widgets';
import { itemTooltip } from '../tooltips';
import { iconForItem, applyItemIcon } from '../hud/hud';
import { itemCategory, itemSlots, itemWeight, itemDefOf } from '../data';
import { RARITY_COLOR, SLOT_LABEL, fmtCoins, fmtNum, statLine, cap } from '../format';
import { glyphSvg } from '../icons';
import { EQUIP_SLOTS, type EquipSlot, type ItemInstance, type EquipmentVisuals, type ItemCategory } from '../../items/types';
import type { PlayerState } from '../../shared/protocol';
import { HumanoidPreview } from '../../humanoid/client/preview';

type Filter = 'all' | 'weapons' | 'armor' | 'consumables' | 'materials' | 'misc';
const FILTER_CATS: Record<Exclude<Filter, 'all'>, ItemCategory[]> = {
  weapons: ['weapon', 'ammo', 'tool'],
  armor: ['armor', 'clothing', 'jewelry', 'trinket', 'light'],
  consumables: ['consumable', 'food'],
  materials: ['material', 'reagent'],
  misc: ['book', 'key', 'quest'],
};
type Sort = 'recent' | 'rarity' | 'value' | 'name' | 'type';
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'unique'];

const LEFT: EquipSlot[] = ['head', 'face', 'neck', 'shoulders', 'back', 'chest', 'wrists', 'hands'];
const RIGHT: EquipSlot[] = ['waist', 'legs', 'feet', 'ring1', 'ring2', 'trinket', 'mainhand', 'offhand'];

const SLOT_GLYPH: Record<EquipSlot, string> = {
  head: 'mask', face: 'eye', neck: 'ring', shoulders: 'shield', chest: 'tunic', back: 'feather', wrists: 'chain', hands: 'hand',
  waist: 'chain', legs: 'footsteps', feet: 'footsteps', ring1: 'ring', ring2: 'ring', mainhand: 'sword', offhand: 'shield', trinket: 'sparkle',
};

export class InventoryPanel extends Panel {
  readonly id = 'inventory' as const;
  private grid: HTMLElement;
  private slotEls = new Map<EquipSlot, HTMLElement>();
  private coins: HTMLElement;
  private weight: HTMLElement;
  private weightBar: HTMLElement;
  private stats: HTMLElement;
  private filter: Filter = 'all';
  private sort: Sort = 'recent';
  private search = '';
  private canvas: HTMLCanvasElement;
  private preview: HumanoidPreview | null = null;
  private previewReady = false;
  private yaw = 0;
  private sig = '';
  private tabs: ReturnType<typeof tabs<Filter>>;

  constructor(host: UiHost) {
    super(host, 'Inventory', 'n-inv-panel');
    this.dim = true;
    this.headerExtra(h('button', { class: 'n-btn small', html: `${glyphSvg('anvil', 14)} Crafting`, onclick: () => host.open('crafting') }));
    this.canvas = h('canvas', { class: 'n-doll-canvas', attrs: { width: 300, height: 460, 'aria-label': 'Character' } });
    this.bindDollRotate();
    const mk = (s: EquipSlot) => {
      const el = h('div', { class: 'n-eq n-interactive', dataset: { slot: s }, attrs: { tabindex: 0, 'aria-label': SLOT_LABEL[s] } },
        h('span', { class: 'n-eq-ph', html: glyphSvg(SLOT_GLYPH[s], 22, 'rgba(212,175,106,.28)') }),
        h('img', { class: 'n-eq-img', attrs: { alt: '', draggable: 'false' } }),
        h('span', { class: 'n-eq-label', text: SLOT_LABEL[s] }),
      );
      this.slotEls.set(s, el);
      tooltip.bind(el, () => {
        const it = this.player()?.equipment[s];
        return it ? itemTooltip(it, null, { label: SLOT_LABEL[s], hint: 'Drag to inventory or double-click to unequip' }) : h('div', null, h('div', { class: 'n-tip-title', text: SLOT_LABEL[s] }), h('div', { class: 'n-tip-sub', text: 'Empty' }));
      }, true);
      drag.target(el, (p) => p.kind === 'item' && p.from === 'inventory' && this.fits(p.uid, s), (p) => p.kind === 'item' && this.equip(p.uid, s));
      drag.source(el, () => {
        const it = this.player()?.equipment[s];
        return it ? { kind: 'item', uid: it.uid, from: 'equipment', slot: s } : null;
      }, () => (el.querySelector('.n-eq-img') as HTMLImageElement).src);
      el.addEventListener('dblclick', () => this.player()?.equipment[s] && this.unequip(s));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const it = this.player()?.equipment[s];
        if (it) contextMenu(e.clientX, e.clientY, [{ label: 'Unequip', icon: glyphSvg('arrow', 14), action: () => this.unequip(s) }]);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this.player()?.equipment[s]) this.unequip(s);
      });
      return el;
    };
    const doll = h('div', { class: 'n-doll' },
      h('div', { class: 'n-eq-col' }, ...LEFT.map(mk)),
      h('div', { class: 'n-doll-stage' }, h('div', { class: 'n-doll-halo' }), this.canvas),
      h('div', { class: 'n-eq-col' }, ...RIGHT.map(mk)),
    );
    this.stats = h('div', { class: 'n-inv-stats' });

    this.grid = h('div', { class: 'n-inv-grid', attrs: { role: 'grid' } });
    drag.target(this.grid, (p) => p.kind === 'item' && p.from === 'equipment', (p) => p.kind === 'item' && p.slot && this.unequip(p.slot as EquipSlot));
    this.tabs = tabs<Filter>(
      [{ id: 'all', label: 'All' }, { id: 'weapons', label: 'Arms' }, { id: 'armor', label: 'Apparel' }, { id: 'consumables', label: 'Provisions' }, { id: 'materials', label: 'Materials' }, { id: 'misc', label: 'Misc' }],
      'all',
      (f) => {
        this.filter = f;
        this.renderGrid();
      },
    );
    const searchInput = h('input', { class: 'n-input n-inv-search', attrs: { type: 'search', placeholder: 'Search…', 'aria-label': 'Search items' } });
    searchInput.addEventListener('input', () => {
      this.search = searchInput.value.trim().toLowerCase();
      this.renderGrid();
    });
    searchInput.addEventListener('keydown', (e) => e.key !== 'Escape' && e.stopPropagation());
    const sortSel = h('select', { class: 'n-select n-inv-sort', attrs: { 'aria-label': 'Sort' } },
      ...(['recent', 'rarity', 'value', 'name', 'type'] as Sort[]).map((s) => h('option', { text: `Sort: ${cap(s)}`, attrs: { value: s } })));
    sortSel.addEventListener('change', () => {
      this.sort = sortSel.value as Sort;
      this.renderGrid();
    });
    this.coins = h('span', { class: 'n-coins' });
    this.weightBar = h('i');
    this.weight = h('span');
    this.body.classList.add('n-inv-body');
    this.body.append(
      h('div', { class: 'n-inv-left' }, doll, this.stats),
      h('div', { class: 'n-inv-right' },
        this.tabs.el,
        h('div', { class: 'n-inv-tools' }, searchInput, sortSel),
        this.grid,
        h('div', { class: 'n-inv-foot' },
          this.coins,
          h('div', { class: 'n-weight' }, h('span', { class: 'n-weight-icon', html: glyphSvg('ingot', 14) }), this.weight, h('div', { class: 'n-weight-bar' }, this.weightBar)),
        ),
      ),
    );
  }

  private player(): PlayerState | undefined {
    return this.host.ctx.state.player;
  }

  private fits(uid: string, slot: EquipSlot): boolean {
    const it = this.host.ctx.findItem(uid);
    if (!it) return false;
    const slots = itemSlots(it);
    const norm = (s: EquipSlot) => (s === 'ring2' ? 'ring1' : s);
    return slots.some((s) => norm(s) === norm(slot));
  }

  private equip(uid: string, slot?: EquipSlot) {
    this.host.ctx.send({ t: 'equip', uid, slot });
    this.host.sound('ui.equip');
  }

  private unequip(slot: EquipSlot) {
    this.host.ctx.send({ t: 'unequip', slot });
    this.host.sound('ui.unequip');
  }

  private bindDollRotate() {
    let down = false, lx = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = true;
      lx = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      this.yaw += (e.clientX - lx) * 0.012;
      lx = e.clientX;
      this.preview?.setYaw(this.yaw);
    });
    this.canvas.addEventListener('pointerup', () => (down = false));
  }

  protected override async onOpen() {
    this.sig = '';
    this.refresh();
    if (!this.preview) {
      try {
        this.preview = new HumanoidPreview(this.canvas);
        await this.preview.ready();
        this.previewReady = true;
        this.preview.setPose('idle');
        this.preview.setFocus('body');
        this.applyDoll();
      } catch (e) {
        console.warn('paper doll preview unavailable', e);
      }
    } else this.applyDoll();
  }

  protected override onClose() {
    tooltip.hide();
  }

  private applyDoll() {
    const p = this.player();
    if (!p || !this.preview || !this.previewReady) return;
    this.preview.setAppearance(p.appearance);
    const vis: EquipmentVisuals = {};
    for (const [s, it] of Object.entries(p.equipment) as [EquipSlot, ItemInstance | undefined][]) if (it) vis[s] = { defId: it.defId, visual: it.visual };
    this.preview.setEquipment(vis);
    this.preview.setYaw(this.yaw);
  }

  /** Called on playerState updates. */
  refresh() {
    if (!this.isOpen) return;
    const p = this.player();
    if (!p) return;
    const sig = JSON.stringify([p.inventory.items.map((i) => [i.uid, i.count, i.durability]), Object.values(p.equipment).map((i) => i?.uid), p.inventory.coins, p.stats]);
    if (sig === this.sig) return;
    const equipChanged = !this.sig || JSON.parse(this.sig)[1].join() !== Object.values(p.equipment).map((i) => i?.uid).join();
    this.sig = sig;
    for (const s of EQUIP_SLOTS) {
      const el = this.slotEls.get(s)!;
      const it = p.equipment[s];
      const img = el.querySelector('.n-eq-img') as HTMLImageElement;
      el.classList.toggle('filled', !!it);
      if (it) {
        applyItemIcon(img, it);
        el.style.setProperty('--rc', RARITY_COLOR[it.rarity]);
        el.classList.toggle('broken', it.maxDurability > 0 && it.durability <= 0);
      } else {
        img.removeAttribute('src');
        el.style.removeProperty('--rc');
      }
    }
    this.renderGrid();
    this.renderStats(p);
    this.coins.innerHTML = `${glyphSvg('coin', 15, '#e9cd6f')} <b>${fmtCoins(p.inventory.coins)}</b>`;
    const wt = p.inventory.items.reduce((s, it) => s + itemWeight(it), 0) + Object.values(p.equipment).reduce((s, it) => s + (it ? itemWeight(it) : 0), 0);
    const cap = p.inventory.capacity || p.stats.carry || 1;
    const frac = wt / cap;
    this.weight.textContent = `${fmtNum(+wt.toFixed(1))} / ${fmtNum(cap)}`;
    this.weightBar.style.transform = `scaleX(${Math.min(1, frac).toFixed(3)})`;
    this.weight.parentElement!.classList.toggle('over', frac > 1);
    this.weight.parentElement!.classList.toggle('heavy', frac > 0.85 && frac <= 1);
    this.weight.parentElement!.title = frac > 1 ? 'Over-encumbered: you move slowly and tire quickly.' : 'Carried weight';
    if (equipChanged) this.applyDoll();
  }

  private renderStats(p: PlayerState) {
    const s = p.stats;
    const row = (label: string, value: string, cls = '') => h('div', { class: `n-stat ${cls}` }, h('span', { text: label }), h('b', { text: value }));
    const res = Object.entries(s.resist ?? {}).filter(([, v]) => v);
    setChildren(this.stats,
      h('div', { class: 'n-heading', text: p.name }),
      h('div', { class: 'n-stat-grid' },
        row('Health', fmtNum(Math.round(s.maxHp)), 'hp'),
        row('Stamina', fmtNum(Math.round(s.maxStamina)), 'st'),
        row('Mana', fmtNum(Math.round(s.maxMana)), 'mp'),
        row('Armor', fmtNum(Math.round(s.armor))),
        row('Speed', `${Math.round(s.moveSpeed * 100)}%`),
        row('Stealth', fmtNum(Math.round(s.stealth))),
        row('Perception', fmtNum(Math.round(s.perception))),
        row('Carry', fmtNum(Math.round(s.carry))),
      ),
      res.length ? h('div', { class: 'n-res' }, ...res.map(([k, v]) => h('span', { class: 'n-pill', text: statLine(`resist.${k}`, v as number).reverse().join(' ') }))) : null,
    );
  }

  private visibleItems(): ItemInstance[] {
    const p = this.player();
    if (!p) return [];
    let items = p.inventory.items.slice();
    if (this.filter !== 'all') {
      const cats = FILTER_CATS[this.filter];
      items = items.filter((i) => {
        const c = itemCategory(i);
        return c ? cats.includes(c) : this.filter === 'misc';
      });
    }
    if (this.search) items = items.filter((i) => `${i.name} ${i.material} ${i.affixes.map((a) => a.name).join(' ')}`.toLowerCase().includes(this.search));
    const by: Record<Sort, (a: ItemInstance, b: ItemInstance) => number> = {
      recent: () => 0,
      rarity: (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity),
      value: (a, b) => b.value * b.count - a.value * a.count,
      name: (a, b) => a.name.localeCompare(b.name),
      type: (a, b) => (itemCategory(a) ?? 'z').localeCompare(itemCategory(b) ?? 'z'),
    };
    if (this.sort === 'recent') items.reverse();
    else items.sort(by[this.sort]);
    return items;
  }

  private renderGrid() {
    const p = this.player();
    if (!p) return;
    const items = this.visibleItems();
    for (const f of ['weapons', 'armor', 'consumables', 'materials', 'misc'] as const) {
      const cats = FILTER_CATS[f];
      this.tabs.setCount(f, p.inventory.items.filter((i) => {
        const c = itemCategory(i);
        return c ? cats.includes(c) : f === 'misc';
      }).length);
    }
    this.tabs.setCount('all', p.inventory.items.length);
    const cells: HTMLElement[] = items.map((it) => this.cell(it));
    // Pad with empty sockets so the grid reads as a bag.
    const pad = Math.max(0, Math.ceil(Math.max(cells.length, 30) / 6) * 6 - cells.length);
    for (let i = 0; i < pad; i++) cells.push(h('div', { class: 'n-cell empty' }));
    this.grid.replaceChildren(...cells);
    if (!items.length && (this.search || this.filter !== 'all')) this.grid.prepend(h('div', { class: 'n-empty n-grid-empty', text: 'Nothing here.' }));
  }

  private cell(it: ItemInstance): HTMLElement {
    const el = h('div', {
      class: `n-cell n-interactive r-${it.rarity}`,
      style: { '--rc': RARITY_COLOR[it.rarity] },
      attrs: { tabindex: 0, role: 'gridcell', 'aria-label': it.name },
    },
      applyItemIcon(h('img', { attrs: { alt: '', draggable: 'false' } }), it),
      it.count > 1 ? h('span', { class: 'n-cell-count', text: String(it.count) }) : null,
      it.maxDurability > 0 && it.durability / it.maxDurability < 0.25 ? h('span', { class: 'n-cell-warn', title: 'Badly worn', text: '!' }) : null,
    );
    const p = this.player()!;
    tooltip.bind(el, () => itemTooltip(it, p.equipment, { hint: this.hintFor(it) }), true);
    drag.source(el, () => ({ kind: 'item', uid: it.uid, from: 'inventory' }), () => iconForItem(it));
    el.addEventListener('dblclick', () => this.primary(it));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.primary(it);
      else if (e.key === 'Delete') this.host.ctx.send({ t: 'dropItem', uid: it.uid, count: it.count });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, this.menuFor(it));
    });
    return el;
  }

  private hintFor(it: ItemInstance): string {
    const slots = itemSlots(it);
    const c = itemCategory(it);
    if (slots.length) return 'Double-click or drag to equip · right-click for options';
    if (c === 'consumable' || c === 'food') return 'Double-click to use · drag onto the hotbar';
    return 'Right-click for options';
  }

  private primary(it: ItemInstance) {
    const slots = itemSlots(it);
    if (slots.length) this.equip(it.uid);
    else {
      this.host.ctx.send({ t: 'useItem', uid: it.uid });
      this.host.sound('ui.use');
    }
  }

  private menuFor(it: ItemInstance): MenuItem[] {
    const slots = itemSlots(it);
    const c = itemCategory(it);
    const def = itemDefOf(it.defId);
    const usable = c === 'consumable' || c === 'food' || c === 'book' || !!def?.consumable;
    const items: MenuItem[] = [];
    if (slots.length) {
      if (slots.length > 1 && slots.includes('mainhand') && slots.includes('offhand')) {
        items.push({ label: 'Equip main hand', icon: glyphSvg('sword', 14), action: () => this.equip(it.uid, 'mainhand') });
        items.push({ label: 'Equip off hand', icon: glyphSvg('shield', 14), action: () => this.equip(it.uid, 'offhand') });
      } else items.push({ label: 'Equip', icon: glyphSvg('shield', 14), action: () => this.equip(it.uid) });
    }
    if (usable) items.push({ label: c === 'book' ? 'Read' : c === 'food' ? 'Eat' : 'Use', icon: glyphSvg('flask', 14), action: () => this.host.ctx.send({ t: 'useItem', uid: it.uid }) });
    const free = (this.player()?.skills.hotbar ?? []).findIndex((v, i) => i < 10 && !v);
    items.push({
      label: 'Add to hotbar', icon: glyphSvg('star', 14), disabled: free < 0 && (this.player()?.skills.hotbar.length ?? 0) >= 10,
      action: () => {
        const hb = this.player()?.skills.hotbar ?? [];
        const slot = free >= 0 ? free : hb.length;
        this.host.ctx.send({ t: 'hotbar', slot, value: `item:${it.uid}` });
      },
    });
    items.push({ separator: true, label: '' });
    if (it.count > 1) {
      items.push({ label: 'Drop one', icon: glyphSvg('arrow', 14), action: () => this.host.ctx.send({ t: 'dropItem', uid: it.uid, count: 1 }) });
      items.push({ label: `Drop all (${it.count})`, icon: glyphSvg('arrow', 14), danger: true, action: () => this.host.ctx.send({ t: 'dropItem', uid: it.uid, count: it.count }) });
    } else items.push({ label: 'Drop', icon: glyphSvg('arrow', 14), danger: c === 'quest', disabled: c === 'quest', action: () => this.host.ctx.send({ t: 'dropItem', uid: it.uid }) });
    return items;
  }

  override update(dt: number) {
    // Gentle idle sway of the paper doll when not dragged.
    if (this.preview && this.previewReady) {
      this.yaw += Math.sin(performance.now() / 2400) * dt * 0.08;
      this.preview.setYaw(this.yaw);
    }
  }

  dispose() {
    this.preview?.dispose();
  }
}
