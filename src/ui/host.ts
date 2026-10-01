/**
 * Shared in-game UI host: what HUD widgets and panels need from the UI
 * orchestrator (context, panel control, notifications, local UI state like the
 * tracked quest and custom waypoint).
 */
import type { ClientContext } from '../client/context';
import type { Vec3 } from '../shared/types';
import { h } from './dom';
import { frame } from './widgets';
import { primaryKey } from '../client/commands';

export type PanelId = 'inventory' | 'skills' | 'journal' | 'map' | 'gm' | 'dialog' | 'trade' | 'crafting' | 'settings' | 'pause';

export interface UiHost {
  readonly ctx: ClientContext;
  open(id: PanelId, data?: unknown): void;
  close(id?: PanelId): void;
  toggle(id: PanelId): void;
  isPanelOpen(id: PanelId): boolean;
  notify(text: string, tone?: 'info' | 'good' | 'bad' | 'warn', icon?: string): void;
  /** Play a UI sound through the audio module. */
  sound(name: string): void;
  /** Quest id whose objectives drive compass/map markers & the tracker. */
  trackedQuest: string | null;
  setTrackedQuest(id: string | null): void;
  /** Player-placed map waypoint. */
  waypoint: Vec3 | null;
  setWaypoint(p: Vec3 | null): void;
  /** Server-time "now" estimate for countdowns between snapshots. */
  serverNow(): number;
}

/** Base class for full panels: frame, header, open/close lifecycle. */
export abstract class Panel {
  abstract readonly id: PanelId;
  readonly root: HTMLElement;
  protected readonly box: HTMLElement;
  protected readonly body: HTMLElement;
  protected readonly head: HTMLElement;
  isOpen = false;
  /** Needs the mouse (releases pointer lock & suspends gameplay input). */
  readonly captures: boolean = true;
  /** Dim the world behind the panel. */
  protected dim = false;

  constructor(protected host: UiHost, title: string, cls: string, sub = '') {
    this.head = h('div', { class: 'n-panel-head' },
      h('h2', { class: 'n-panel-title', text: title }),
      sub ? h('span', { class: 'n-panel-sub', text: sub }) : null,
      h('span', { class: 'n-spacer' }),
    );
    this.body = h('div', { class: 'n-panel-body' });
    this.box = frame(`n-panel ${cls}`, this.head, this.body);
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-label', title);
    this.head.append(h('button', { class: 'n-close', html: '✕', title: `Close (${primaryKey('pause')})`, attrs: { 'aria-label': 'Close' }, onclick: () => this.host.close(this.id) }));
    this.root = h('div', { class: 'n-panel-wrap n-hidden' }, this.box);
    this.root.addEventListener('pointerdown', (e) => {
      // Clicking the dimmed backdrop closes the panel.
      if (e.target === this.root && this.dim) this.host.close(this.id);
    });
  }

  protected headerExtra(...nodes: Node[]): void {
    const spacer = this.head.querySelector('.n-spacer')!;
    spacer.after(...nodes);
  }

  show(data?: unknown): void {
    this.isOpen = true;
    this.root.classList.remove('n-hidden');
    this.root.classList.toggle('n-dim-bg', this.dim);
    // Re-trigger entrance animation.
    this.box.style.animation = 'none';
    void this.box.offsetWidth;
    this.box.style.animation = '';
    this.onOpen(data);
  }

  hide(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.add('n-hidden');
    this.onClose();
  }

  /** Called when already open and opened again with new data. */
  reopen(data?: unknown): void {
    this.onOpen(data);
  }

  protected onOpen(_data?: unknown): void {}
  protected onClose(): void {}
  /** Per-frame update while open. */
  update(_dt: number): void {}
  /** Return true if the panel handled the key. */
  onKey(_e: KeyboardEvent): boolean {
    return false;
  }
}
