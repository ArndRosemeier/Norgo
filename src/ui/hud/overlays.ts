/**
 * Full-screen overlays: death screen (respawn) and the F3 debug overlay.
 */
import type { UiHost } from '../host';
import { h } from '../dom';
import { glyphSvg } from '../icons';

const EPITAPHS = [
  'The world turns on without you — for now.',
  'Even legends stumble.',
  'Dust to dust, and back again.',
  'Your story is not over.',
  'Somewhere, a bard is already exaggerating this.',
  'The gods are not done with you.',
];

export class DeathScreen {
  readonly el: HTMLElement;
  private cause: HTMLElement;
  private btn: HTMLButtonElement;
  private epitaph: HTMLElement;
  shown = false;
  private enableTimer = 0;

  constructor(private host: UiHost) {
    this.cause = h('div', { class: 'n-death-cause' });
    this.epitaph = h('div', { class: 'n-death-epitaph' });
    this.btn = h('button', { class: 'n-btn primary n-death-btn', html: `${glyphSvg('sun', 16)} Rise again`, onclick: () => this.respawn() });
    this.el = h('div', { class: 'n-death n-hidden', attrs: { role: 'alertdialog', 'aria-label': 'You died' } },
      h('div', { class: 'n-death-inner' },
        h('div', { class: 'n-death-title', text: 'You have fallen' }),
        this.cause,
        this.epitaph,
        this.btn,
        h('div', { class: 'n-death-hint n-faint', text: 'You will return at your last place of rest.' }),
      ),
    );
  }

  show(killer?: string) {
    if (this.shown) return;
    this.shown = true;
    this.cause.textContent = killer ? `Slain by ${killer}` : '';
    this.epitaph.textContent = EPITAPHS[Math.floor(Math.random() * EPITAPHS.length)];
    this.el.classList.remove('n-hidden');
    this.btn.disabled = true;
    // Short grace period so a held key/click doesn't skip the moment.
    clearTimeout(this.enableTimer);
    this.enableTimer = window.setTimeout(() => {
      this.btn.disabled = false;
      this.btn.focus();
    }, 1600);
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.el.classList.add('n-hidden');
  }

  respawn() {
    if (this.btn.disabled) return;
    this.host.ctx.send({ t: 'respawn' });
    this.btn.disabled = true;
    this.host.sound('ui.respawn');
  }
}

export class DebugOverlay {
  readonly el = h('pre', { class: 'n-debug n-hidden' });
  visible = false;
  private lines: string[] = [];
  private fps = 0;
  private frames = 0;
  private acc = 0;
  private extra: () => string[] = () => [];

  constructor(extra?: () => string[]) {
    if (extra) this.extra = extra;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('n-hidden', !this.visible);
    if (this.visible) this.render();
  }

  set(lines: string[]) {
    this.lines = lines;
  }

  update(dt: number) {
    this.frames++;
    this.acc += dt;
    if (this.acc >= 0.5) {
      this.fps = this.frames / this.acc;
      this.frames = 0;
      this.acc = 0;
      if (this.visible) this.render();
    }
  }

  private render() {
    this.el.textContent = [`ui ${this.fps.toFixed(0)} fps`, ...this.lines, ...this.extra()].join('\n');
  }
}
