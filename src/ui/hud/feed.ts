/**
 * Transient messages: notifications & loot, XP gains, level-up / ability-unlock
 * banners, area & biome toasts, Game Master narration.
 */
import type { UiHost } from '../host';
import { h } from '../dom';
import { glyphSvg, abilityIcon, skillIcon } from '../icons';
import { abilityOrStub, skillDef, skillOrStub, xpForLevel } from '../data';
import type { GmMessage } from '../../gm/types';
import { keyHint } from '../controls';

type Tone = 'info' | 'good' | 'bad' | 'warn';

const TONE_GLYPH: Record<Tone, string> = { info: 'rune', good: 'sparkle', bad: 'skull', warn: 'bolt' };

export class Notifications {
  readonly el = h('div', { class: 'n-notes n-scaled', attrs: { 'aria-live': 'polite' } });
  private recent = new Map<string, { el: HTMLElement; n: number; timer: number }>();

  push(text: string, tone: Tone = 'info', icon?: string) {
    // Collapse identical messages into a counter.
    const dup = this.recent.get(text);
    if (dup) {
      dup.n++;
      dup.el.dataset.count = `×${dup.n}`;
      clearTimeout(dup.timer);
      dup.timer = window.setTimeout(() => this.drop(text), 5200);
      dup.el.classList.remove('bump');
      void dup.el.offsetWidth;
      dup.el.classList.add('bump');
      return;
    }
    const el = h('div', { class: `n-note ${tone}` },
      icon ? h('img', { class: 'n-note-img', attrs: { src: icon, alt: '' } }) : h('span', { class: 'n-note-icon', html: glyphSvg(TONE_GLYPH[tone], 14) }),
      h('span', { text }),
    );
    this.el.prepend(el);
    const timer = window.setTimeout(() => this.drop(text), 5200);
    this.recent.set(text, { el, n: 1, timer });
    while (this.el.children.length > 7) {
      const last = this.el.lastElementChild as HTMLElement;
      for (const [k, v] of this.recent) if (v.el === last) this.recent.delete(k);
      last.remove();
    }
  }

  private drop(text: string) {
    const r = this.recent.get(text);
    if (!r) return;
    this.recent.delete(text);
    r.el.classList.add('out');
    setTimeout(() => r.el.remove(), 400);
  }
}

/** Big centred banners queued so they never overlap. */
export class Banners {
  readonly el = h('div', { class: 'n-banners' });
  private queue: HTMLElement[] = [];
  private busy = false;

  show(kind: 'level' | 'unlock' | 'quest' | 'discover' | 'death', title: string, sub: string, icon?: string) {
    const el = h('div', { class: `n-banner ${kind}` },
      icon ? h('img', { class: 'n-banner-icon', attrs: { src: icon, alt: '' } }) : null,
      h('div', { class: 'n-banner-kicker', text: { level: 'Skill improved', unlock: 'New ability', quest: 'Quest', discover: 'Discovered', death: '' }[kind] }),
      h('div', { class: 'n-banner-title', text: title }),
      sub ? h('div', { class: 'n-banner-sub', text: sub }) : null,
      h('div', { class: 'n-banner-orn' }),
    );
    this.queue.push(el);
    this.next();
  }

  private next() {
    if (this.busy) return;
    const el = this.queue.shift();
    if (!el) return;
    this.busy = true;
    this.el.append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        this.busy = false;
        this.next();
      }, 600);
    }, this.queue.length ? 2200 : 3400);
  }
}

/** "+12 Pyromancy" gains with a mini progress bar, aggregated per skill. */
export class XpFeed {
  readonly el = h('div', { class: 'n-xpfeed n-scaled' });
  private rows = new Map<string, { el: HTMLElement; amt: number; text: HTMLElement; bar: HTMLElement; timer: number }>();

  constructor(private host: UiHost) {}

  gain(skill: string, amount: number, level: number) {
    const prog = this.host.ctx.state.player?.skills?.skills[skill];
    const need = xpForLevel(level);
    const frac = prog ? Math.min(1, prog.xp / Math.max(1, need)) : 0;
    let r = this.rows.get(skill);
    if (!r) {
      const text = h('span');
      const bar = h('i');
      const el = h('div', { class: 'n-xp-row' },
        h('img', { attrs: { src: skillIcon(skillOrStub(skill)), alt: '' } }),
        h('div', { class: 'n-xp-main' }, text, h('div', { class: 'n-xpbar' }, bar)),
      );
      r = { el, amt: 0, text, bar, timer: 0 };
      this.rows.set(skill, r);
      this.el.append(el);
    }
    r.amt += amount;
    r.text.innerHTML = `<b>+${Math.round(r.amt)}</b> ${skillOrStub(skill).name} <span class="n-dim">${level}</span>`;
    r.bar.style.transform = `scaleX(${frac.toFixed(3)})`;
    r.el.classList.remove('out');
    clearTimeout(r.timer);
    const row = r;
    r.timer = window.setTimeout(() => {
      row.el.classList.add('out');
      setTimeout(() => {
        if (this.rows.get(skill) === row && row.el.classList.contains('out')) {
          row.el.remove();
          this.rows.delete(skill);
        }
      }, 500);
    }, 3200);
  }

  levelUp(skill: string, level: number, banners: Banners) {
    const def = skillOrStub(skill);
    const next = def.unlocks.filter((u) => u.level > level).sort((a, b) => a.level - b.level)[0];
    banners.show('level', `${def.name} ${level}`, next ? `Next: ${abilityOrStub(next.ability).name} at ${next.level}` : '', skillIcon(def));
  }

  unlock(ability: string, banners: Banners) {
    const def = abilityOrStub(ability);
    banners.show('unlock', def.name, `${skillOrStub(def.skill).name} · drag it from the skill book${keyHint('skills')} onto your hotbar`, abilityIcon(def, skillDef(def.skill)));
  }
}

/** Area/biome name toast (top-centre, cinematic). */
export class AreaToast {
  readonly el = h('div', { class: 'n-area' });
  private timer = 0;

  show(title: string, sub: string) {
    this.el.replaceChildren(h('div', { class: 'n-area-sub', text: sub }), h('div', { class: 'n-area-title', text: title }), h('div', { class: 'n-area-line' }));
    this.el.classList.remove('show');
    void this.el.offsetWidth;
    this.el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), 4200);
  }
}

const GM_KIND_LABEL: Record<string, string> = {
  narration: '', hint: 'A whisper', event: 'Event', quest: 'Quest', rumor: 'Rumor', reply: 'The Game Master', omen: 'Omen', recap: 'Previously',
};

/** Game Master narration lines, one at a time, reading time scaled to length. */
export class Narration {
  readonly el = h('div', { class: 'n-narration', attrs: { 'aria-live': 'polite' } });
  private queue: GmMessage[] = [];
  private busy = false;
  enabled = true;

  push(m: GmMessage) {
    if (!this.enabled) return;
    this.queue.push(m);
    if (this.queue.length > 4) this.queue.shift();
    this.next();
  }

  private next() {
    if (this.busy) return;
    const m = this.queue.shift();
    if (!m) return;
    this.busy = true;
    const label = m.title ?? GM_KIND_LABEL[m.kind] ?? '';
    const el = h('div', { class: `n-narr ${m.kind} ${m.tone ?? ''}` }, label ? h('div', { class: 'n-narr-kind', text: label }) : null, h('div', { class: 'n-narr-text', text: m.text }));
    this.el.replaceChildren(el);
    const dur = Math.min(11000, 3200 + m.text.length * 55);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        this.busy = false;
        this.next();
      }, 700);
    }, dur);
  }
}
