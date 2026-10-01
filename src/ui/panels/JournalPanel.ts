/**
 * Journal: quests (active / offered / finished) with objectives, rewards and
 * track / accept / abandon actions; the Game Master's chronicle; discoveries
 * with distance and "show on map".
 */
import { Panel, type UiHost } from '../host';
import { h, setChildren } from '../dom';
import { tabs, confirmModal } from '../widgets';
import { glyphSvg } from '../icons';
import { fmtDist, fmtDuration, cap } from '../format';
import { POI_LABEL } from '../map/markers';
import type { QuestView, GmMessage } from '../../gm/types';
import type { PoiKind } from '../../world/sites';

type Tab = 'quests' | 'chronicle' | 'discoveries';

const STATUS_ORDER: Record<string, number> = { active: 0, offered: 1, completed: 2, failed: 3, abandoned: 4 };
const KIND_GLYPH: Record<string, string> = { narration: 'scroll', hint: 'eye', event: 'burst', quest: 'star', rumor: 'speech', reply: 'rune', omen: 'moon', recap: 'book' };

export class JournalPanel extends Panel {
  readonly id = 'journal' as const;
  private tabs: ReturnType<typeof tabs<Tab>>;
  private content: HTMLElement;
  private selected: string | null = null;
  private sig = '';

  constructor(host: UiHost) {
    super(host, 'Journal', 'n-journal-panel');
    this.dim = true;
    this.content = h('div', { class: 'n-journal-content' });
    this.tabs = tabs<Tab>([{ id: 'quests', label: 'Quests' }, { id: 'chronicle', label: 'Chronicle' }, { id: 'discoveries', label: 'Discoveries' }], 'quests', () => {
      this.sig = '';
      this.render();
    });
    this.body.classList.add('n-journal-body');
    this.body.append(this.tabs.el, this.content);
  }

  protected override onOpen(data?: unknown) {
    const d = data as { quest?: string; tab?: Tab } | undefined;
    if (d?.tab) this.tabs.set(d.tab);
    if (d?.quest) {
      this.tabs.set('quests');
      this.selected = d.quest;
    }
    this.sig = '';
    this.refresh();
  }

  refresh() {
    if (!this.isOpen) return;
    const j = this.host.ctx.state.player?.journal;
    const sig = JSON.stringify([j, this.host.trackedQuest, this.selected, this.tabs.value]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.render();
  }

  private render() {
    const j = this.host.ctx.state.player?.journal;
    if (!j) return;
    this.tabs.setCount('quests', j.quests.filter((q) => q.status === 'active' || q.status === 'offered').length);
    this.tabs.setCount('discoveries', j.discoveries.length);
    if (this.tabs.value === 'quests') this.renderQuests(j.quests);
    else if (this.tabs.value === 'chronicle') this.renderChronicle(j.log);
    else this.renderDiscoveries(j.discoveries);
  }

  private renderQuests(quests: QuestView[]) {
    const sorted = quests.slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    if (!sorted.length) {
      setChildren(this.content, h('div', { class: 'n-empty', text: 'No quests yet. Talk to people, explore ruins, listen for rumors — the world has stories waiting.' }));
      return;
    }
    if (!this.selected || !sorted.some((q) => q.id === this.selected)) this.selected = sorted[0].id;
    const groups: [string, QuestView[]][] = [
      ['Active', sorted.filter((q) => q.status === 'active')],
      ['Offered', sorted.filter((q) => q.status === 'offered')],
      ['Finished', sorted.filter((q) => q.status !== 'active' && q.status !== 'offered')],
    ];
    const list = h('div', { class: 'n-list n-quest-list' });
    for (const [label, qs] of groups) {
      if (!qs.length) continue;
      list.append(h('div', { class: 'n-school', text: label }));
      for (const q of qs) {
        const done = q.objectives.filter((o) => o.done && !o.optional).length, total = q.objectives.filter((o) => !o.optional).length;
        list.append(h('div', {
          class: `n-row n-quest-row ${q.id === this.selected ? 'active' : ''} ${q.status}`,
          attrs: { tabindex: 0 },
          onclick: () => { this.selected = q.id; this.render(); },
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { this.selected = q.id; this.render(); } },
        },
          h('span', { class: 'n-quest-mark', html: glyphSvg(q.id === this.host.trackedQuest ? 'star' : q.status === 'completed' ? 'sparkle' : q.status === 'failed' ? 'skull' : 'scroll', 14, q.id === this.host.trackedQuest ? '#ffcf4a' : undefined) }),
          h('span', { class: 'n-quest-title', text: q.title }),
          q.status === 'active' ? h('span', { class: 'n-faint', text: `${done}/${total}` }) : h('span', { class: 'n-pill', text: q.status }),
        ));
      }
    }
    const q = sorted.find((x) => x.id === this.selected)!;
    const tracked = q.id === this.host.trackedQuest;
    const pp = this.host.ctx.playerPos();
    const detail = h('div', { class: 'n-quest-detail' },
      h('div', { class: 'n-qd-title', text: q.title }),
      h('div', { class: 'n-qd-sub', text: [q.giver ? `From ${q.giver}` : '', cap(q.category ?? q.source), cap(q.status)].filter(Boolean).join(' · ') }),
      q.expiresAt && q.status !== 'completed' ? h('div', { class: 'n-qd-sub', style: 'color:#a0401c', text: q.expiresAt > this.host.serverNow() ? `Expires in ${fmtDuration(q.expiresAt - this.host.serverNow())}` : 'Expired' }) : null,
      h('p', { class: 'n-qd-summary', text: q.summary }),
      h('div', { class: 'n-heading', text: 'Objectives' }),
      h('ul', { class: 'n-qd-objs' }, ...q.objectives.map((o) => h('li', { class: `${o.done ? 'done' : ''} ${o.optional ? 'optional' : ''}` },
        h('i', { class: 'n-tracker-check' }),
        h('span', { text: o.text + (o.target ? ` (${o.count ?? 0}/${o.target})` : '') + (o.optional ? ' — optional' : '') }),
        o.pos && !o.done ? h('button', { class: 'n-btn small ghost', html: `${glyphSvg('arrow', 12)} ${fmtDist(Math.hypot(o.pos[0] - pp[0], o.pos[2] - pp[2]))}`, title: 'Show on map', onclick: () => this.host.open('map', { x: o.pos![0], z: o.pos![2] }) }) : null,
      ))),
      q.rewards.length ? h('div', { class: 'n-heading', text: 'Rewards' }) : null,
      q.rewards.length ? h('div', { class: 'n-qd-rewards' }, ...q.rewards.map((r) => h('span', { class: 'n-pill', text: r }))) : null,
      h('div', { class: 'n-qd-actions' },
        q.status === 'offered' ? h('button', { class: 'n-btn primary', text: 'Accept', onclick: () => this.action(q, 'accept') }) : null,
        q.status === 'active' ? h('button', { class: `n-btn ${tracked ? '' : 'primary'}`, html: `${glyphSvg('star', 13)} ${tracked ? 'Untrack' : 'Track'}`, onclick: () => this.track(q, !tracked) }) : null,
        q.status === 'active' || q.status === 'offered'
          ? h('button', {
            class: 'n-btn danger', text: q.status === 'offered' ? 'Decline' : 'Abandon',
            onclick: async () => {
              if (await confirmModal(q.status === 'offered' ? 'Decline quest?' : 'Abandon quest?', `“${q.title}” will be lost.`, q.status === 'offered' ? 'Decline' : 'Abandon', true)) this.action(q, 'abandon');
            },
          })
          : null,
      ),
    );
    setChildren(this.content, h('div', { class: 'n-journal-cols' }, list, detail));
  }

  private track(q: QuestView, on: boolean) {
    this.host.setTrackedQuest(on ? q.id : null);
    // The server toggles tracking for the quest.
    this.host.ctx.send({ t: 'questAction', quest: q.id, action: 'track' });
    this.sig = '';
    this.render();
  }

  private action(q: QuestView, a: 'accept' | 'abandon') {
    this.host.ctx.send({ t: 'questAction', quest: q.id, action: a });
    if (a === 'accept' && !this.host.trackedQuest) this.host.setTrackedQuest(q.id);
    if (a === 'abandon' && this.host.trackedQuest === q.id) this.host.setTrackedQuest(null);
    this.host.sound(a === 'accept' ? 'ui.quest' : 'ui.click');
  }

  private renderChronicle(log: GmMessage[]) {
    if (!log.length) {
      setChildren(this.content, h('div', { class: 'n-empty', text: 'The chronicle of your journey is still unwritten.' }));
      return;
    }
    const now = this.host.serverNow();
    const entries = log.slice().reverse().map((m) => {
      const ago = Math.max(0, now - m.t);
      const when = ago < 60 ? 'moments ago' : ago < 3600 ? `${Math.round(ago / 60)} min ago` : `${(ago / 3600).toFixed(1)} h ago`;
      return h('div', { class: `n-chron ${m.kind}` },
        h('span', { class: 'n-chron-icon', html: glyphSvg(KIND_GLYPH[m.kind] ?? 'scroll', 15) }),
        h('div', { class: 'n-chron-main' },
          h('div', { class: 'n-chron-meta', text: `${cap(m.kind)} · ${when}` }),
          h('div', { class: 'n-chron-text', text: m.text }),
        ),
        m.pos ? h('button', { class: 'n-btn small ghost', html: glyphSvg('arrow', 12), title: 'Show on map', onclick: () => this.host.open('map', { x: m.pos![0], z: m.pos![2] }) }) : null,
      );
    });
    setChildren(this.content, h('div', { class: 'n-chronicle' }, ...entries));
  }

  private renderDiscoveries(ds: { id: string; name: string; pos: [number, number, number]; kind: string }[]) {
    if (!ds.length) {
      setChildren(this.content, h('div', { class: 'n-empty', text: 'Nothing discovered yet. Ruins, shrines and stranger things await off the beaten road.' }));
      return;
    }
    const pp = this.host.ctx.playerPos();
    const sorted = ds.slice().sort((a, b) => Math.hypot(a.pos[0] - pp[0], a.pos[2] - pp[2]) - Math.hypot(b.pos[0] - pp[0], b.pos[2] - pp[2]));
    setChildren(this.content, h('div', { class: 'n-disc-grid' }, ...sorted.map((d) => h('div', { class: 'n-disc' },
      h('div', { class: 'n-disc-name', text: d.name }),
      h('div', { class: 'n-disc-kind', text: POI_LABEL[d.kind as PoiKind] ?? cap(d.kind) }),
      h('div', { class: 'n-disc-foot' },
        h('span', { class: 'n-dim', text: fmtDist(Math.hypot(d.pos[0] - pp[0], d.pos[2] - pp[2])) }),
        h('button', { class: 'n-btn small', html: `${glyphSvg('arrow', 12)} Map`, onclick: () => this.host.open('map', { x: d.pos[0], z: d.pos[2] }) }),
        h('button', { class: 'n-btn small ghost', text: 'Waypoint', onclick: () => { this.host.setWaypoint(d.pos); this.host.notify(`Waypoint set: ${d.name}`, 'info'); } }),
      ),
    ))));
  }
}
