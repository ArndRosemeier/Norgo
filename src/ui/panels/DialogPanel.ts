/**
 * Conversation window: speaker header with disposition meter, scrolling lines
 * (speaker, mood, typewriter reveal), numbered choices with skill-check hints
 * and success chances, free-text input when an LLM brain is active, trade.
 */
import { Panel, type UiHost } from '../host';
import { h, setChildren } from '../dom';
import type { DialogView, DialogChoice, DialogLine } from '../../dialog/types';
import { skillOrStub } from '../data';
import { glyphSvg } from '../icons';
import { autoFocusField } from '../gestures';

const MOOD_GLYPH: Record<string, string> = {
  happy: 'sun', angry: 'flame', sad: 'drop', afraid: 'eye', surprised: 'sparkle', disgusted: 'skull', focused: 'rune', pain: 'burst', neutral: '',
};

export class DialogPanel extends Panel {
  readonly id = 'dialog' as const;
  view: DialogView | null = null;
  private lines: HTMLElement;
  private choices: HTMLElement;
  private input: HTMLInputElement;
  private inputRow: HTMLElement;
  private who: HTMLElement;
  private disp: HTMLElement;
  private tradeBtn: HTMLButtonElement;
  private shown = 0;
  private session = '';
  private typing: { el: HTMLElement; text: string; i: number } | null = null;
  private typeQueue: { el: HTMLElement; text: string }[] = [];
  private closeTimer = 0;
  private waiting: HTMLElement;
  private suspended = false;

  constructor(host: UiHost) {
    super(host, '', 'n-dialog-panel');
    this.who = h('div', { class: 'n-dlg-who' });
    this.disp = h('div', { class: 'n-dlg-disp' });
    this.head.querySelector('.n-panel-title')!.replaceWith(this.who);
    this.tradeBtn = h('button', { class: 'n-btn small', html: `${glyphSvg('coin', 14)} Trade`, onclick: () => this.trade() });
    this.headerExtra(this.disp, this.tradeBtn);
    this.lines = h('div', { class: 'n-dlg-lines', attrs: { 'aria-live': 'polite' } });
    this.waiting = h('div', { class: 'n-dlg-wait' }, h('i'), h('i'), h('i'));
    this.choices = h('ol', { class: 'n-dlg-choices' });
    this.input = h('input', { class: 'n-input', attrs: { type: 'text', maxlength: 300, placeholder: 'Say something…', 'aria-label': 'Say something' } });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.sendText();
      else if (e.key === 'Escape') this.input.blur();
    });
    this.inputRow = h('div', { class: 'n-dlg-input' }, this.input, h('button', { class: 'n-btn small primary', text: 'Say', onclick: () => this.sendText() }));
    this.body.classList.add('n-dlg-body');
    this.body.append(this.lines, this.waiting, this.choices, this.inputRow);
  }

  /** New/updated view from the server. */
  setView(v: DialogView) {
    clearTimeout(this.closeTimer);
    const fresh = v.sessionId !== this.session;
    if (fresh) {
      this.session = v.sessionId;
      this.shown = 0;
      this.lines.replaceChildren();
      this.typeQueue = [];
      this.typing = null;
    }
    this.view = v;
    this.who.replaceChildren(h('div', { class: 'n-panel-title', text: v.npcName }), h('div', { class: 'n-panel-sub', text: v.npcTitle }));
    const d = Math.max(-100, Math.min(100, v.disposition));
    const word = v.tier ? v.tier.charAt(0).toUpperCase() + v.tier.slice(1) : d > 60 ? 'Devoted' : d > 25 ? 'Friendly' : d > -10 ? 'Neutral' : d > -50 ? 'Wary' : 'Hostile';
    setChildren(this.disp, h('span', { text: word }), h('div', { class: 'n-disp-bar' }, h('i', { style: { left: `${(d + 100) / 2}%` } })));
    this.disp.title = `Disposition ${d > 0 ? '+' : ''}${Math.round(d)}`;
    this.tradeBtn.classList.toggle('n-hidden', !v.canTrade);
    // Each update carries only the new lines: append them.
    v.lines.forEach((l, i) => this.addLine(l, i === v.lines.length - 1 || !fresh));
    this.shown += v.lines.length;
    this.waiting.classList.toggle('show', !!v.thinking);
    if (v.openTrade && v.canTrade !== false) this.trade();
    this.renderChoices(v);
    this.inputRow.classList.toggle('n-hidden', !v.freeText || v.ended);
    if (v.ended) {
      this.choices.replaceChildren(h('li', { class: 'n-dlg-end' }, h('button', { class: 'n-btn', text: 'Farewell', onclick: () => this.host.close('dialog') })));
      this.closeTimer = window.setTimeout(() => this.host.close('dialog'), 6000);
    }
  }

  private addLine(l: DialogLine, animate: boolean) {
    const isPlayer = l.speakerId === this.host.ctx.state.playerId || l.speaker === this.host.ctx.state.player?.name;
    const text = h('span', { class: 'n-dlg-text' });
    if (!l.speaker) {
      // Narration (stage directions, outcomes of checks).
      const row = h('div', { class: 'n-dlg-line narr' }, text);
      text.textContent = l.text;
      this.lines.append(row);
      this.lines.scrollTop = this.lines.scrollHeight;
      return;
    }
    const mood = l.mood && MOOD_GLYPH[l.mood] ? h('span', { class: `n-dlg-mood ${l.mood}`, title: l.mood, html: glyphSvg(MOOD_GLYPH[l.mood], 12) }) : null;
    const row = h('div', { class: `n-dlg-line ${isPlayer ? 'me' : 'them'}` }, h('div', { class: 'n-dlg-speaker' }, l.speaker, mood), text);
    this.lines.append(row);
    if (animate && !isPlayer) {
      this.typeQueue.push({ el: text, text: l.text });
      if (!this.typing) this.nextTyping();
    } else text.textContent = l.text;
    this.lines.scrollTop = this.lines.scrollHeight;
  }

  private nextTyping() {
    const n = this.typeQueue.shift();
    this.typing = n ? { el: n.el, text: n.text, i: 0 } : null;
  }

  private finishTyping() {
    if (this.typing) this.typing.el.textContent = this.typing.text;
    for (const q of this.typeQueue) q.el.textContent = q.text;
    this.typeQueue = [];
    this.typing = null;
  }

  private renderChoices(v: DialogView) {
    const items = v.choices.map((c, i) => {
      const chance = c.check ? Math.round(c.check.chance * (c.check.chance <= 1 ? 100 : 1)) : null;
      const tone = chance === null ? '' : chance >= 70 ? 'good' : chance >= 40 ? 'warn' : 'bad';
      const btn = h('button', {
        class: `n-dlg-choice ${c.exit ? 'exit' : ''}`,
        attrs: { type: 'button', disabled: !!c.disabled },
        onclick: () => this.choose(c),
      },
        h('span', { class: 'n-dlg-num', text: String(i + 1) }),
        h('span', { class: 'n-dlg-ctext', text: c.text }),
        c.check ? h('span', { class: `n-dlg-check ${tone}`, text: `[${skillOrStub(c.check.skill).name} ${c.check.difficulty}] ${chance}%` }) : null,
        c.hint ? h('span', { class: 'n-dlg-hint', text: c.hint }) : null,
      );
      return h('li', null, btn);
    });
    this.choices.replaceChildren(...items);
  }

  private choose(c: DialogChoice) {
    if (!this.view || c.disabled) return;
    this.finishTyping();
    this.host.ctx.send({ t: 'dialogChoice', session: this.view.sessionId, choice: c.id });
    this.host.sound('ui.click');
    this.waiting.classList.add('show');
    this.choices.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  }

  private sendText() {
    const text = this.input.value.trim();
    if (!text || !this.view) return;
    this.host.ctx.send({ t: 'dialogText', session: this.view.sessionId, text });
    // The echoed line arrives with the next view; show a thinking indicator meanwhile.
    this.input.value = '';
    this.waiting.classList.add('show');
  }

  private trade() {
    if (!this.view) return;
    this.host.ctx.send({ t: 'trade', npc: this.view.npcId });
    this.host.sound('ui.click');
  }

  protected override onOpen() {
    if (this.view?.freeText) autoFocusField(this.input, 50);
  }

  /** Hide for the trade window without ending the conversation. */
  suspend() {
    this.suspended = true;
  }

  resume() {
    this.suspended = false;
  }

  /** Trade closed and the dialog won't come back: end the session now. */
  endSuspended() {
    this.suspended = false;
    this.endSession();
  }

  private endSession() {
    if (this.view && !this.view.ended) this.host.ctx.send({ t: 'dialogEnd', session: this.view.sessionId });
    this.view = null;
    this.session = '';
  }

  protected override onClose() {
    clearTimeout(this.closeTimer);
    this.finishTyping();
    if (!this.suspended) this.endSession();
  }

  override onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown' || !this.view) return false;
    if (e.key === ' ' && (this.typing || this.typeQueue.length)) {
      this.finishTyping();
      return true;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      const c = this.view.choices[n - 1];
      if (c) this.choose(c);
      return true;
    }
    if (e.key === 'Enter' && this.view.freeText) {
      this.input.focus();
      return true;
    }
    return false;
  }

  override update(dt: number) {
    const t = this.typing;
    if (!t) return;
    // ~55 chars/s, punctuation pauses come naturally from chunking by words.
    t.i = Math.min(t.text.length, t.i + Math.max(1, Math.round(dt * 55)));
    t.el.textContent = t.text.slice(0, t.i);
    if (t.i >= t.text.length) this.nextTyping();
    this.lines.scrollTop = this.lines.scrollHeight;
  }
}
