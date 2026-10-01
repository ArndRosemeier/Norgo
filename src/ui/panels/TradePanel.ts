/**
 * Barter window: merchant stock (buy prices) vs. the player's bag (sell
 * prices), click-to-add carts on both sides, running balance against coins,
 * single confirm that sends {t:'trade', npc, buy, sell}.
 */
import { Panel, type UiHost } from '../host';
import { h, setChildren } from '../dom';
import { tooltip } from '../widgets';
import { itemTooltip } from '../tooltips';
import { applyItemIcon } from '../hud/hud';
import { RARITY_COLOR, fmtCoins } from '../format';
import { glyphSvg } from '../icons';
import type { ServerMessage } from '../../shared/protocol';
import type { ItemInstance } from '../../items/types';

type TradeMsg = Extract<ServerMessage, { t: 'trade' }>;

export class TradePanel extends Panel {
  readonly id = 'trade' as const;
  private msg: TradeMsg | null = null;
  private buy = new Set<string>();
  private sell = new Set<string>();
  private stockEl: HTMLElement;
  private bagEl: HTMLElement;
  private summary: HTMLElement;
  private merchantName: HTMLElement;

  constructor(host: UiHost) {
    super(host, 'Trade', 'n-trade-panel');
    this.dim = true;
    this.merchantName = h('span', { class: 'n-panel-sub' });
    this.headerExtra(this.merchantName);
    this.stockEl = h('div', { class: 'n-trade-list' });
    this.bagEl = h('div', { class: 'n-trade-list' });
    this.summary = h('div', { class: 'n-trade-summary' });
    this.body.classList.add('n-trade-body');
    this.body.append(
      h('div', { class: 'n-trade-cols' },
        h('section', null, h('div', { class: 'n-heading', text: 'Merchant’s wares' }), this.stockEl),
        h('section', null, h('div', { class: 'n-heading', text: 'Your pack' }), this.bagEl),
      ),
      this.summary,
    );
  }

  setTrade(m: TradeMsg) {
    this.msg = m;
    // Drop selections that no longer exist (sold out / already traded).
    for (const uid of [...this.buy]) if (!m.stock.some((s) => s.uid === uid)) this.buy.delete(uid);
    const inv = this.host.ctx.state.player?.inventory.items ?? [];
    for (const uid of [...this.sell]) if (!inv.some((s) => s.uid === uid)) this.sell.delete(uid);
    const npc = this.host.ctx.state.entities.get(m.npc);
    this.merchantName.textContent = npc?.name ? `with ${npc.name}${npc.title ? `, ${npc.title}` : ''}` : '';
    this.render();
  }

  refresh() {
    if (this.isOpen) this.render();
  }

  protected override onClose() {
    tooltip.hide();
    this.buy.clear();
    this.sell.clear();
  }

  private priceOf(uid: string, side: 'buy' | 'sell', item: ItemInstance): number {
    // Server prices are per unit; whole stacks trade together.
    const table = side === 'buy' ? this.msg?.prices : this.msg?.sellPrices;
    const unit = table?.[uid] ?? table?.[item.defId] ?? (side === 'buy' ? Math.ceil(item.value * 1.25) : Math.floor(item.value * 0.4));
    return unit * item.count;
  }

  private row(it: ItemInstance, side: 'buy' | 'sell', set: Set<string>): HTMLElement {
    const price = this.priceOf(it.uid, side, it);
    const on = set.has(it.uid);
    const el = h('div', {
      class: `n-row n-trade-row ${on ? 'active' : ''}`,
      attrs: { tabindex: 0, role: 'checkbox', 'aria-checked': on },
      onclick: () => this.toggleSel(set, it.uid),
      onkeydown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && this.toggleSel(set, it.uid),
    },
      applyItemIcon(h('img', { class: 'n-trade-icon', style: { borderColor: RARITY_COLOR[it.rarity] }, attrs: { alt: '' } }), it),
      h('span', { class: 'n-trade-name', style: { color: RARITY_COLOR[it.rarity] }, text: it.name + (it.count > 1 ? ` ×${it.count}` : '') }),
      h('span', { class: 'n-trade-price', html: `${glyphSvg('coin', 12, '#e9cd6f')} ${fmtCoins(price)}` }),
    );
    tooltip.bind(el, () => itemTooltip(it, side === 'buy' ? this.host.ctx.state.player?.equipment ?? null : null, { price: { label: side === 'buy' ? 'Click to add to purchase' : 'Click to offer for sale', value: price } }), true);
    return el;
  }

  private toggleSel(set: Set<string>, uid: string) {
    if (set.has(uid)) set.delete(uid);
    else set.add(uid);
    this.host.sound('ui.click');
    this.render();
  }

  private render() {
    const m = this.msg;
    const p = this.host.ctx.state.player;
    if (!m || !p) return;
    const equipped = new Set(Object.values(p.equipment).map((e) => e?.uid));
    const sellable = p.inventory.items.filter((i) => !equipped.has(i.uid) && (m.sellPrices[i.uid] ?? m.sellPrices[i.defId] ?? 1) > 0);
    this.stockEl.replaceChildren(...(m.stock.length ? m.stock.map((it) => this.row(it, 'buy', this.buy)) : [h('div', { class: 'n-empty', text: 'Sold out.' })]));
    this.bagEl.replaceChildren(...(sellable.length ? sellable.map((it) => this.row(it, 'sell', this.sell)) : [h('div', { class: 'n-empty', text: 'Nothing to sell.' })]));
    const cost = [...this.buy].reduce((s, uid) => {
      const it = m.stock.find((x) => x.uid === uid);
      return s + (it ? this.priceOf(uid, 'buy', it) : 0);
    }, 0);
    const gain = [...this.sell].reduce((s, uid) => {
      const it = p.inventory.items.find((x) => x.uid === uid);
      return s + (it ? this.priceOf(uid, 'sell', it) : 0);
    }, 0);
    const net = gain - cost;
    const after = p.inventory.coins + net;
    const ok = (this.buy.size || this.sell.size) && after >= 0;
    setChildren(this.summary,
      h('div', { class: 'n-trade-figs' },
        h('span', { class: 'n-dim', text: `Buying ${this.buy.size} · ${fmtCoins(cost)}` }),
        h('span', { class: 'n-dim', text: `Selling ${this.sell.size} · ${fmtCoins(gain)}` }),
        h('span', { class: net >= 0 ? 'n-good' : 'n-bad', html: `Balance ${net >= 0 ? '+' : '−'}${fmtCoins(Math.abs(net))}` }),
        h('span', { html: `${glyphSvg('coin', 14, '#e9cd6f')} ${fmtCoins(p.inventory.coins)} → <b class="${after < 0 ? 'n-bad' : ''}">${fmtCoins(after)}</b>` }),
      ),
      h('div', { class: 'n-trade-actions' },
        h('button', { class: 'n-btn small ghost', text: 'Clear', attrs: { disabled: !this.buy.size && !this.sell.size }, onclick: () => { this.buy.clear(); this.sell.clear(); this.render(); } }),
        h('button', {
          class: 'n-btn primary', text: after < 0 ? 'Not enough coin' : 'Confirm trade', attrs: { disabled: !ok },
          onclick: () => {
            const withCount = (uid: string, list: ItemInstance[]) => `${uid}:${list.find((x) => x.uid === uid)?.count ?? 1}`;
            this.host.ctx.send({ t: 'trade', npc: m.npc, buy: [...this.buy].map((u) => withCount(u, m.stock)), sell: [...this.sell].map((u) => withCount(u, p.inventory.items)) });
            this.host.sound('ui.coins');
            this.buy.clear();
            this.sell.clear();
            this.render();
          },
        }),
      ),
    );
  }
}
