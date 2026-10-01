/**
 * Crafting: recipes discovered from the items module (normalized in data.ts),
 * searchable list, ingredient availability from the inventory, station and
 * skill requirements, craft ×1 / ×N. Degrades to an explanatory empty state.
 */
import { Panel, type UiHost } from '../host';
import { h, setChildren } from '../dom';
import { tooltip } from '../widgets';
import { getRecipes, loadItemData, skillOrStub, itemDefOf, type UiRecipe } from '../data';
import { itemFallbackIcon, glyphSvg } from '../icons';
import { titleize } from '../format';

export class CraftingPanel extends Panel {
  readonly id = 'crafting' as const;
  private list: HTMLElement;
  private detail: HTMLElement;
  private search = '';
  private station: string | null = null;
  private selected: string | null = null;
  private onlyCraftable = false;

  constructor(host: UiHost) {
    super(host, 'Crafting', 'n-craft-panel');
    this.dim = true;
    this.list = h('div', { class: 'n-list n-craft-list' });
    this.detail = h('div', { class: 'n-craft-detail' });
    const search = h('input', { class: 'n-input', attrs: { type: 'search', placeholder: 'Search recipes…', 'aria-label': 'Search recipes' } });
    search.addEventListener('input', () => {
      this.search = search.value.trim().toLowerCase();
      this.render();
    });
    search.addEventListener('keydown', (e) => e.key !== 'Escape' && e.stopPropagation());
    const only = h('label', { class: 'n-toggle' }, h('span', { text: 'Craftable only' }), h('span', { class: 'n-switch' }, h('input', { attrs: { type: 'checkbox' }, onchange: (e: Event) => { this.onlyCraftable = (e.target as HTMLInputElement).checked; this.render(); } }), h('i')));
    this.body.classList.add('n-craft-body');
    this.body.append(h('div', { class: 'n-craft-left' }, search, only, this.list), this.detail);
  }

  protected override async onOpen(data?: unknown) {
    const d = data as { station?: string } | string | undefined;
    this.station = typeof d === 'string' ? d : d?.station ?? null;
    this.head.querySelector('.n-panel-sub')?.remove();
    if (this.station) this.headerExtra(h('span', { class: 'n-panel-sub', text: `at the ${titleize(this.station)}` }));
    await loadItemData();
    this.render();
  }

  protected override onClose() {
    tooltip.hide();
  }

  refresh() {
    if (this.isOpen) this.render();
  }

  private have(defId: string): number {
    const p = this.host.ctx.state.player;
    return (p?.inventory.items ?? []).filter((i) => i.defId === defId).reduce((s, i) => s + i.count, 0);
  }

  private craftable(r: UiRecipe): number {
    let n = Infinity;
    for (const i of r.inputs) n = Math.min(n, Math.floor(this.have(i.defId) / Math.max(1, i.count)));
    const lvl = r.skill ? this.host.ctx.state.player?.skills.skills[r.skill]?.level ?? 0 : 0;
    if (r.level && lvl < r.level) return 0;
    return Number.isFinite(n) ? n : 0;
  }

  private render() {
    const all = getRecipes(this.host.ctx.state.player?.inventory.knownRecipes ?? []);
    if (!all.length) {
      this.list.replaceChildren();
      setChildren(this.detail, h('div', { class: 'n-empty' },
        h('div', { html: glyphSvg('anvil', 40, 'rgba(212,175,106,.4)') }),
        h('p', { text: 'You know no recipes yet.' }),
        h('p', { class: 'n-faint', style: 'font-style:normal;font-family:var(--n-sans);font-size:12px', text: 'Recipes are learned from books, teachers and practice — and some can only be worked at a forge, loom or alchemy table.' })));
      return;
    }
    let rs = all.filter((r) => !this.search || `${r.name} ${r.category ?? ''} ${r.inputs.map((i) => i.name).join(' ')}`.toLowerCase().includes(this.search));
    if (this.onlyCraftable) rs = rs.filter((r) => this.craftable(r) > 0);
    rs.sort((a, b) => (this.craftable(b) > 0 ? 1 : 0) - (this.craftable(a) > 0 ? 1 : 0) || a.name.localeCompare(b.name));
    if (!this.selected || !rs.some((r) => r.id === this.selected)) this.selected = rs[0]?.id ?? null;
    let lastCat = '';
    const rows: HTMLElement[] = [];
    for (const r of rs) {
      const cat = r.category ?? (r.station ? titleize(r.station) : 'General');
      if (cat !== lastCat) {
        lastCat = cat;
        rows.push(h('div', { class: 'n-school', text: titleize(cat) }));
      }
      const n = this.craftable(r);
      rows.push(h('div', {
        class: `n-row ${r.id === this.selected ? 'active' : ''} ${n ? '' : 'n-faint'}`,
        attrs: { tabindex: 0 },
        onclick: () => { this.selected = r.id; this.render(); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { this.selected = r.id; this.render(); } },
      },
        h('img', { class: 'n-craft-icon', attrs: { src: itemFallbackIcon({ defId: r.output.defId, rarity: 'common' }, itemDefOf(r.output.defId)?.category), alt: '' } }),
        h('span', { style: 'flex:1', text: r.name }),
        n ? h('span', { class: 'n-pill', text: `×${n}` }) : null,
      ));
    }
    this.list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'n-empty', text: 'No matching recipes.' })]));
    const r = rs.find((x) => x.id === this.selected);
    if (!r) {
      setChildren(this.detail, h('div', { class: 'n-empty', text: 'Select a recipe.' }));
      return;
    }
    const n = this.craftable(r);
    const lvl = r.skill ? this.host.ctx.state.player?.skills.skills[r.skill]?.level ?? 0 : 0;
    setChildren(this.detail,
      h('div', { class: 'n-sd-head' },
        h('img', { class: 'n-sd-icon', attrs: { src: itemFallbackIcon({ defId: r.output.defId, rarity: 'uncommon' }, itemDefOf(r.output.defId)?.category), alt: '' } }),
        h('div', null, h('div', { class: 'n-sd-name', text: r.output.count > 1 ? `${r.name} ×${r.output.count}` : r.name }), h('div', { class: 'n-sd-sub', text: titleize(r.category ?? itemDefOf(r.output.defId)?.category ?? 'Item') })),
      ),
      r.description || itemDefOf(r.output.defId)?.description ? h('p', { class: 'n-sd-desc', text: r.description ?? itemDefOf(r.output.defId)!.description }) : null,
      h('div', { class: 'n-heading', text: 'Requires' }),
      h('div', { class: 'n-craft-inputs' }, ...r.inputs.map((i) => {
        const have = this.have(i.defId);
        return h('div', { class: `n-craft-in ${have >= i.count ? 'ok' : 'missing'}` },
          h('img', { attrs: { src: itemFallbackIcon({ defId: i.defId, rarity: 'common' }, itemDefOf(i.defId)?.category), alt: '' } }),
          h('span', { text: i.name }),
          h('b', { text: `${have}/${i.count}` }),
        );
      })),
      r.station ? h('div', { class: `n-craft-req ${r.station === this.station ? 'n-good' : 'n-warn'}`, html: `${glyphSvg('anvil', 13)} Requires a ${titleize(r.station)}${r.station === this.station ? '' : ' nearby (found in settlements)'}` }) : null,
      r.learnable ? h('div', { class: 'n-craft-req n-gold', html: `${glyphSvg('book', 13)} Learned from a recipe folio` }) : null,
      r.skill ? h('div', { class: `n-craft-req ${!r.level || lvl >= r.level ? 'n-good' : 'n-bad'}`, html: `${glyphSvg('star', 13)} ${skillOrStub(r.skill).name} ${r.level ?? ''} (you: ${lvl})` }) : null,
      h('div', { class: 'n-craft-actions' },
        h('button', { class: 'n-btn primary', text: 'Craft', attrs: { disabled: !n }, onclick: () => this.craft(r, 1) }),
        n > 1 ? h('button', { class: 'n-btn', text: `Craft all (${n})`, onclick: () => this.craft(r, n) }) : null,
      ),
    );
  }

  private craft(r: UiRecipe, times: number) {
    for (let i = 0; i < times; i++) this.host.ctx.send({ t: 'craft', recipe: r.id, station: this.station ?? undefined });
    this.host.sound('ui.craft');
  }
}
