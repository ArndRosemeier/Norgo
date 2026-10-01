/**
 * Smaller panels: "Ask the Game Master" oracle, Settings, Pause menu.
 */
import { Panel, type UiHost } from '../host';
import { h } from '../dom';
import { glyphSvg } from '../icons';
import { SettingsView } from '../settingsView';
import { controlsTable } from '../controls';
import { confirmModal } from '../widgets';
import { autoFocusField } from '../gestures';
import type { GmMessage } from '../../gm/types';
import type { LlmSettings } from '../settings';
import { BIOMES } from '../../world/biomes';
import { fmtClock } from '../format';

const SUGGESTIONS = ['Where should I go next?', 'What is this place?', 'Who rules these lands?', 'Is there danger nearby?', 'Tell me a rumor.', 'What should I learn?'];

export class GmPanel extends Panel {
  readonly id = 'gm' as const;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private pending: HTMLElement;
  private pendingTimer = 0;
  private seen = new Set<string>();

  constructor(host: UiHost) {
    super(host, 'Ask the Game Master', 'n-gm-panel', 'The narrator of this world is listening');
    this.dim = true;
    this.log = h('div', { class: 'n-gm-log', attrs: { 'aria-live': 'polite' } },
      h('div', { class: 'n-gm-intro', text: 'Speak, traveller. Ask about the world, your path, or what lies beyond the next hill. The Game Master answers in its own time and its own way.' }));
    this.pending = h('div', { class: 'n-gm-pending' }, h('span', { class: 'n-gm-orb' }), 'The Game Master ponders…');
    this.input = h('textarea', { class: 'n-textarea n-gm-input', attrs: { rows: 2, maxlength: 400, placeholder: 'Ask anything…', 'aria-label': 'Ask the Game Master' } });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.ask(this.input.value);
      } else if (e.key === 'Escape') this.host.close('gm');
    });
    const chips = h('div', { class: 'n-gm-chips' }, ...SUGGESTIONS.map((s) => h('button', { class: 'n-chip n-gm-chip', text: s, onclick: () => this.ask(s) })));
    this.body.classList.add('n-gm-body');
    this.body.append(this.log, this.pending, chips, h('div', { class: 'n-gm-row' }, this.input, h('button', { class: 'n-btn primary', html: `${glyphSvg('eye', 14)} Ask`, onclick: () => this.ask(this.input.value) })));
  }

  private ask(text: string) {
    const t = text.trim();
    if (!t) return;
    this.host.ctx.send({ t: 'gmAsk', text: t });
    this.log.append(h('div', { class: 'n-gm-q' }, h('span', { class: 'n-gm-who', text: this.host.ctx.state.player?.name ?? 'You' }), h('span', { text: t })));
    this.input.value = '';
    this.pending.classList.add('show');
    clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => {
      this.pending.classList.remove('show');
      this.log.append(h('div', { class: 'n-gm-a quiet', text: 'Only the wind answers. (The Game Master is silent for now — try again later.)' }));
      this.scroll();
    }, 25000);
    this.scroll();
    this.host.sound('ui.click');
  }

  /** GM messages from the server; replies are shown here even if the panel is closed. */
  onGm(msgs: GmMessage[]) {
    for (const m of msgs) {
      if (m.kind !== 'reply' || this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      clearTimeout(this.pendingTimer);
      this.pending.classList.remove('show');
      this.log.append(h('div', { class: 'n-gm-a' }, h('span', { class: 'n-gm-who', text: 'Game Master' }), h('span', { text: m.text }),
        m.pos ? h('button', { class: 'n-btn small ghost', html: `${glyphSvg('arrow', 12)} Show on map`, onclick: () => this.host.open('map', { x: m.pos![0], z: m.pos![2] }) }) : null));
      this.scroll();
    }
  }

  private scroll() {
    this.log.scrollTop = this.log.scrollHeight;
  }

  protected override onOpen() {
    autoFocusField(this.input);
    this.scroll();
  }
}

export class SettingsPanel extends Panel {
  readonly id = 'settings' as const;

  constructor(host: UiHost, applyLlm: (which: 'llm' | 'gmLlm', cfg: LlmSettings) => void) {
    super(host, 'Settings', 'n-settings-panel', 'Changes apply instantly');
    this.dim = true;
    this.body.append(new SettingsView({ applyLlm }).el);
  }
}

export interface PauseActions {
  save(): void;
  quit(): void;
}

export class PausePanel extends Panel {
  readonly id = 'pause' as const;
  private info: HTMLElement;
  private keys: HTMLElement;
  private saveBtn: HTMLButtonElement;

  constructor(host: UiHost, private actions: PauseActions) {
    super(host, 'Paused', 'n-pause-panel');
    this.dim = true;
    this.info = h('div', { class: 'n-pause-info' });
    this.keys = h('div', { class: 'n-pause-keys n-hidden' });
    this.saveBtn = h('button', { class: 'n-pause-item', html: `${glyphSvg('book', 18)}<span>Save journey</span>`, onclick: () => this.save() });
    const item = (label: string, glyph: string, fn: () => void) => h('button', { class: 'n-pause-item', html: `${glyphSvg(glyph, 18)}<span>${label}</span>`, onclick: fn });
    this.body.classList.add('n-pause-body');
    this.body.append(
      this.info,
      h('nav', { class: 'n-pause-menu' },
        item('Resume', 'arrow', () => host.close('pause')),
        this.saveBtn,
        item('Journal', 'scroll', () => host.open('journal')),
        item('World map', 'mountain', () => host.open('map')),
        item('Settings', 'key', () => host.open('settings')),
        item('Controls', 'hand', () => {
          // Rebuilt on open so rebinds made in the settings (and the input mode) show up.
          if (this.keys.classList.contains('n-hidden')) this.keys.replaceChildren(controlsTable());
          this.keys.classList.toggle('n-hidden');
        }),
        item('Guide', 'book', () => {
          host.close('pause');
          host.ctx.events.emit('uiOpen', { panel: 'guide' });
        }),
        item('Quit to title', 'moon', async () => {
          if (await confirmModal('Quit to title?', 'Your journey is saved before you leave.', 'Save & quit')) this.actions.quit();
        }),
      ),
      this.keys,
    );
  }

  private save() {
    this.actions.save();
    this.saveBtn.disabled = true;
    this.saveBtn.querySelector('span')!.textContent = 'Saving…';
    setTimeout(() => {
      this.saveBtn.disabled = false;
      this.saveBtn.querySelector('span')!.textContent = 'Save journey';
    }, 1500);
  }

  protected override onOpen() {
    const ctx = this.host.ctx;
    const p = ctx.playerPos();
    const site = ctx.gen.siteAt(p[0], p[2]);
    const biome = BIOMES[ctx.gen.biomeAt(p[0], p[2])]?.name ?? '';
    this.info.replaceChildren(
      h('div', { class: 'n-pause-world', text: ctx.profile.name }),
      h('div', { class: 'n-dim', text: `${site ? `${site.name}, ` : ''}${biome} · Day ${ctx.state.day + 1}, ${fmtClock(ctx.state.timeOfDay)}` }),
      h('div', { class: 'n-faint', style: 'font-size:11px', text: `Seed ${ctx.seed >>> 0}` }),
    );
    (this.body.querySelector('.n-pause-item') as HTMLButtonElement)?.focus();
  }
}
