/**
 * Core HUD widgets. All per-frame work writes transforms / CSS variables only,
 * and only when values actually change (no layout thrash).
 */
import * as THREE from 'three';
import type { PlayerState } from '../../shared/protocol';
import type { FocusTarget } from '../../client/context';
import type { WeatherState, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { UiHost } from '../host';
import { h, setChildren } from '../dom';
import { abilityOrStub, skillDef, itemCategory } from '../data';
import { abilityIcon, effectIcon, isHarmfulEffect, itemFallbackIcon, glyphSvg } from '../icons';
import { itemIconUrl, whenIconReady, iconKey } from '../../items/client/icons';
import { tooltip, drag, contextMenu, type DragPayload } from '../widgets';
import { onSecondary, touchMode } from '../gestures';
import { HOTBAR_ACTIONS, command, primaryKey } from '../../client/commands';
import { currentOverrides } from '../controls';
import { abilityCard, itemTooltip, effectCard } from '../tooltips';
import { fmtClock, dayPhase, fmtDist, fmtDuration, cap, titleize } from '../format';
import type { ItemInstance } from '../../items/types';

const tmpDir = new THREE.Vector3();

/** Camera heading in radians, 0 = north (−Z), clockwise positive (east = +π/2). */
export function cameraHeading(cam: THREE.Camera): number {
  cam.getWorldDirection(tmpDir);
  return Math.atan2(tmpDir.x, -tmpDir.z);
}

export function iconForItem(item: Pick<ItemInstance, 'defId' | 'visual' | 'rarity'>, size = 64): string {
  let url = '';
  try {
    url = itemIconUrl(item, size);
  } catch {
    url = '';
  }
  return url || itemFallbackIcon(item, itemCategory(item));
}

/**
 * Set an <img> to an item's icon; the items module may first return a cheap
 * placeholder and render the real icon later, so upgrade when it's ready.
 */
export function applyItemIcon(img: HTMLImageElement, item: Pick<ItemInstance, 'defId' | 'visual' | 'rarity'>, size = 64): HTMLImageElement {
  img.src = iconForItem(item, size);
  if (!item.visual) return img;
  const key = iconKey(item, size);
  img.dataset.ik = key;
  whenIconReady(item, size).then((url) => {
    if (url && img.dataset.ik === key && img.src !== url) img.src = url;
  }, () => undefined);
  return img;
}

// ------------------------------------------------------------------ vitals

class Bar {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private trail: HTMLElement;
  private text: HTMLElement;
  private shown = -1;
  private trailV = 1;
  private trailHold = 0;
  private lastText = '';
  private lastMax = 0;

  constructor(kind: 'hp' | 'stamina' | 'mana', label: string) {
    this.fill = h('i', { class: 'n-bar-fill' });
    this.trail = h('i', { class: 'n-bar-trail' });
    this.text = h('span', { class: 'n-bar-text' });
    this.el = h('div', { class: `n-bar n-bar-${kind}`, attrs: { role: 'meter', 'aria-label': label } }, this.trail, this.fill, h('i', { class: 'n-bar-gloss' }), this.text);
  }

  update(v: number, max: number, dt: number) {
    const target = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
    if (this.shown < 0) this.shown = this.trailV = target;
    const prev = this.shown;
    // Ease toward the target; snap when close.
    this.shown += (target - this.shown) * (1 - Math.exp(-dt * 12));
    if (Math.abs(this.shown - target) < 0.001) this.shown = target;
    if (target < this.trailV) {
      if (this.trailHold <= 0 && prev > target + 0.002) this.trailHold = 0.45;
      this.trailHold -= dt;
      if (this.trailHold <= 0) this.trailV += (target - this.trailV) * (1 - Math.exp(-dt * 5));
    } else this.trailV = this.shown;
    this.fill.style.transform = `scaleX(${this.shown.toFixed(4)})`;
    this.trail.style.transform = `scaleX(${this.trailV.toFixed(4)})`;
    const t = `${Math.ceil(v)} / ${Math.round(max)}`;
    if (t !== this.lastText) {
      this.text.textContent = t;
      this.lastText = t;
    }
    if (max !== this.lastMax) {
      // Longer bars for bigger pools, within limits.
      this.el.style.setProperty('--len', String(Math.max(0.75, Math.min(1.35, 0.6 + max / 250))));
      this.lastMax = max;
    }
    this.el.classList.toggle('low', target < 0.25);
  }
}

export class Vitals {
  readonly el: HTMLElement;
  private hp = new Bar('hp', 'Health');
  private st = new Bar('stamina', 'Stamina');
  private mp = new Bar('mana', 'Mana');
  private hurt: HTMLElement;
  private lastHp = -1;

  constructor(private host: UiHost) {
    this.hurt = h('div', { class: 'n-hurt' });
    this.el = h('div', { class: 'n-vitals n-scaled' }, this.hp.el, this.st.el, this.mp.el);
  }

  get hurtOverlay(): HTMLElement {
    return this.hurt;
  }

  update(dt: number) {
    const p = this.host.ctx.state.player;
    if (!p) return;
    const s = p.stats;
    this.hp.update(p.hp, s.maxHp, dt);
    this.st.update(p.stamina, s.maxStamina, dt);
    this.mp.update(p.mana, s.maxMana, dt);
    if (this.lastHp >= 0 && p.hp < this.lastHp - 0.5) {
      // Damage flash proportional to the hit.
      const k = Math.min(1, (this.lastHp - p.hp) / Math.max(1, s.maxHp) * 4);
      this.hurt.style.setProperty('--k', k.toFixed(2));
      this.hurt.classList.remove('flash');
      void this.hurt.offsetWidth;
      this.hurt.classList.add('flash');
    }
    this.hurt.classList.toggle('critical', p.hp > 0 && p.hp / s.maxHp < 0.2);
    this.lastHp = p.hp;
  }
}

// ------------------------------------------------------------------ hotbar

interface Slot {
  el: HTMLElement;
  img: HTMLImageElement;
  count: HTMLElement;
  cd: HTMLElement;
  cdText: HTMLElement;
  key: HTMLElement;
  value: string | null;
  cdTotal: number;
  lastCd: string;
}

export class Hotbar {
  readonly el: HTMLElement;
  private slots: Slot[] = [];
  private sig = '';

  constructor(private host: UiHost) {
    this.el = h('div', { class: 'n-hotbar n-scaled', attrs: { role: 'toolbar', 'aria-label': 'Hotbar' } });
    for (let i = 0; i < 10; i++) {
      const img = h('img', { class: 'n-slot-icon', attrs: { alt: '', draggable: 'false' } });
      const count = h('span', { class: 'n-slot-count' });
      const cd = h('i', { class: 'n-slot-cd' });
      const cdText = h('span', { class: 'n-slot-cdtext' });
      const key = h('span', { class: 'n-slot-key', text: primaryKey(HOTBAR_ACTIONS[i], currentOverrides()) });
      const el = h('div', { class: 'n-slot n-interactive empty' }, img, cd, cdText, count, key);
      const slot: Slot = { el, img, count, cd, cdText, key, value: null, cdTotal: 0, lastCd: '' };
      this.slots.push(slot);
      this.el.append(el);
      // During play a finger on a slot uses it (hold = charge); with a panel open it inspects.
      const inspecting = () => this.host.ctx.uiCaptured || !this.host.ctx.controls;
      tooltip.bind(el, () => this.tooltipFor(slot), false, { holdWhen: inspecting });
      this.bindTouchUse(el, i, inspecting);
      drag.target(el, (p) => p.kind === 'ability' || p.kind === 'hotbar' || (p.kind === 'item' && this.usable(p.uid)), (p) => this.drop(i, p));
      drag.source(
        el,
        () => (slot.value && this.host.ctx.uiCaptured ? { kind: 'hotbar', slot: i, value: slot.value } : null),
        () => slot.img.src,
        // Dragged off the bar: clear the slot.
        (p) => p.kind === 'hotbar' && this.set(p.slot, null),
      );
      onSecondary(el, (x, y, source) => {
        if (!slot.value) return;
        // Right-click clears at once (as always); a long-press asks first (it also shows details).
        if (source === 'mouse') this.set(i, null);
        else contextMenu(x, y, [{ label: 'Clear slot', icon: glyphSvg('cross', 14), danger: true, action: () => this.set(i, null) }]);
      }, inspecting);
    }
  }

  /** Touch: press the slot's hotbar action on touch-down, release on lift (charged abilities). */
  private bindTouchUse(el: HTMLElement, i: number, inspecting: () => boolean) {
    el.addEventListener('pointerdown', (e) => {
      const controls = this.host.ctx.controls;
      if (e.pointerType === 'mouse' || inspecting() || !controls) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const id = e.pointerId, action = HOTBAR_ACTIONS[i];
      controls.press(action);
      this.flash(i);
      const up = (u: PointerEvent) => {
        if (u.pointerId !== id) return;
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        controls.release(action);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  /** Key labels follow the registry (and rebinds). */
  refreshKeys() {
    for (let i = 0; i < this.slots.length; i++) this.slots[i].key.textContent = primaryKey(HOTBAR_ACTIONS[i], currentOverrides());
  }

  private usable(uid: string): boolean {
    const it = this.host.ctx.findItem(uid);
    if (!it) return false;
    const c = itemCategory(it);
    return c === 'consumable' || c === 'food' || c === 'tool' || c === 'weapon' || c === 'light' || c === 'book';
  }

  private set(slot: number, value: string | null) {
    this.host.ctx.send({ t: 'hotbar', slot, value });
    // Optimistic local update so the bar responds instantly.
    const hb = this.host.ctx.state.player?.skills?.hotbar;
    if (hb) {
      while (hb.length < 10) hb.push(null);
      hb[slot] = value;
      this.sig = '';
    }
    this.host.sound('ui.slot');
  }

  private drop(i: number, p: DragPayload) {
    if (p.kind === 'ability') this.set(i, p.id);
    else if (p.kind === 'item') this.set(i, `item:${p.uid}`);
    else if (p.kind === 'hotbar' && p.slot !== i) {
      const other = this.slots[i].value;
      this.set(i, p.value);
      this.set(p.slot, other);
    }
  }

  private tooltipFor(slot: Slot): Node | Node[] | null {
    if (!slot.value) return null;
    const ctx = this.host.ctx;
    if (slot.value.startsWith('item:')) {
      const it = ctx.findItem(slot.value.slice(5));
      return it ? itemTooltip(it, null, { hint: touchMode() ? 'In play: tap to use · drag to rearrange' : `Press ${slot.key.textContent} to use · right-click to clear` }) : null;
    }
    const def = abilityOrStub(slot.value);
    const left = (ctx.state.player.cooldowns?.[slot.value] ?? 0) - this.host.serverNow();
    return abilityCard(def, { unlocked: true, cooldownLeft: left, hint: touchMode() ? 'In play: tap to use, hold to charge · drag to rearrange' : 'Right-click to clear · drag to rearrange' });
  }

  flash(i: number) {
    const s = this.slots[i];
    if (!s) return;
    s.el.classList.remove('pressed');
    void s.el.offsetWidth;
    s.el.classList.add('pressed');
  }

  /** Rebuild icons when hotbar or inventory changed. */
  refresh(p: PlayerState) {
    const hb = p.skills?.hotbar ?? [];
    const counts = new Map<string, number>();
    for (const it of p.inventory?.items ?? []) counts.set(it.uid, it.count);
    const sig = hb.join('|') + '#' + [...counts].join(',');
    if (sig === this.sig) return;
    this.sig = sig;
    for (let i = 0; i < 10; i++) {
      const s = this.slots[i];
      const v = hb[i] ?? null;
      s.value = v;
      s.el.classList.toggle('empty', !v);
      s.el.classList.remove('missing');
      s.count.textContent = '';
      if (!v) {
        s.img.removeAttribute('src');
        continue;
      }
      if (v.startsWith('item:')) {
        const it = this.host.ctx.findItem(v.slice(5));
        if (it) {
          applyItemIcon(s.img, it);
          if (it.count > 1) s.count.textContent = String(it.count);
        } else {
          // Item used up or dropped: keep the binding but show it greyed.
          s.el.classList.add('missing');
          s.img.src = itemFallbackIcon({ defId: v.slice(5), rarity: 'common' });
        }
      } else {
        const def = abilityOrStub(v);
        s.img.src = abilityIcon(def, def.skill ? skillDef(def.skill) : undefined);
        s.cdTotal = def.cooldown;
      }
    }
  }

  update() {
    const p = this.host.ctx.state.player;
    if (!p) return;
    const now = this.host.serverNow();
    for (const s of this.slots) {
      if (!s.value || s.value.startsWith('item:')) {
        if (s.lastCd) {
          s.el.classList.remove('cooling');
          s.lastCd = '';
        }
        continue;
      }
      const ready = p.cooldowns?.[s.value] ?? 0;
      const left = ready - now;
      let key = '';
      if (left > 0.05) {
        if (left > s.cdTotal) s.cdTotal = left; // unknown/longer cooldown: learn its length
        const frac = Math.min(1, left / Math.max(0.001, s.cdTotal));
        key = frac.toFixed(3);
        if (key !== s.lastCd) {
          s.cd.style.setProperty('--cd', `${(frac * 360).toFixed(1)}deg`);
          s.cdText.textContent = left >= 10 ? String(Math.ceil(left)) : left.toFixed(1);
        }
      }
      if (!key && s.lastCd) s.el.classList.add('ready-flash');
      s.el.classList.toggle('cooling', !!key);
      if (key) s.el.classList.remove('ready-flash');
      s.lastCd = key;
      // Unaffordable costs dim the slot.
      const def = abilityOrStub(s.value);
      const poor = (def.cost.mana ?? 0) > p.mana || (def.cost.stamina ?? 0) > p.stamina || (def.cost.hp ?? 0) >= p.hp;
      if (s.el.classList.contains('poor') !== poor) s.el.classList.toggle('poor', poor);
    }
  }
}

// ------------------------------------------------------------------ effects

export class EffectsBar {
  readonly el = h('div', { class: 'n-effects n-scaled' });
  private items = new Map<string, { el: HTMLElement; time: HTMLElement; last: string }>();
  private sig = '';

  constructor(private host: UiHost) {}

  refresh(p: PlayerState) {
    const effs = p.effects ?? [];
    const sig = effs.map((e) => `${e.id}:${e.until}:${e.stacks ?? 1}`).join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    const keep = new Set<string>();
    for (const e of effs) {
      const key = e.id;
      keep.add(key);
      if (this.items.has(key)) continue;
      const harmful = isHarmfulEffect(e.id);
      const time = h('span', { class: 'n-eff-time' });
      const el = h('div', { class: `n-eff n-interactive ${harmful ? 'bad' : 'good'}` }, h('img', { attrs: { src: effectIcon(e.id, harmful), alt: '' } }), time);
      tooltip.bind(el, () => {
        const cur = this.host.ctx.state.player.effects.find((x) => x.id === key);
        return cur ? effectCard(cur, this.host.serverNow(), harmful) : null;
      });
      this.items.set(key, { el, time, last: '' });
      this.el.append(el);
    }
    for (const [k, v] of this.items)
      if (!keep.has(k)) {
        v.el.remove();
        this.items.delete(k);
      }
  }

  update() {
    const p = this.host.ctx.state.player;
    if (!p || !this.items.size) return;
    const now = this.host.serverNow();
    for (const e of p.effects) {
      const it = this.items.get(e.id);
      if (!it) continue;
      const left = e.until - now;
      const txt = !Number.isFinite(left) ? '' : left < 60 ? `${Math.max(0, Math.ceil(left))}s` : `${Math.ceil(left / 60)}m`;
      const label = (e.stacks && e.stacks > 1 ? `×${e.stacks} ` : '') + txt;
      if (label !== it.last) {
        it.time.textContent = label;
        it.last = label;
        it.el.classList.toggle('expiring', Number.isFinite(left) && left < 5);
      }
    }
  }
}

// ------------------------------------------------------------------ status: time, weather, gravity

const WEATHER_GLYPH: Record<string, string> = {
  clear: 'sun', cloudy: 'wind', rain: 'drop', storm: 'bolt', snow: 'frost', fog: 'wave', ashfall: 'flame', sporefall: 'leaf',
};

export class StatusCluster {
  readonly el: HTMLElement;
  private time: HTMLElement;
  private weather: HTMLElement;
  private grav: HTMLElement;
  private gravText: HTMLElement;
  private last = '';
  private lastG = '';
  weatherState: WeatherState | null = null;
  /** Temporary gravity fields from GameEvents. */
  fields: { pos: Vec3; radius: number; factor: number; until: number }[] = [];

  constructor(private host: UiHost) {
    this.time = h('span', { class: 'n-status-time' });
    this.weather = h('span', { class: 'n-status-weather' });
    this.gravText = h('span');
    this.grav = h('div', { class: 'n-status-grav n-interactive' }, h('span', { class: 'n-grav-icon', html: glyphSvg('gravity', 13) }), this.gravText);
    tooltip.bind(this.grav, () => h('div', null,
      h('div', { class: 'n-tip-title n-gold', text: 'Local gravity' }),
      h('div', { class: 'n-tip-sub', style: 'text-transform:none;letter-spacing:0', text: 'Jump height, fall damage and projectiles all follow the local pull. Skyreach lands are light; anomalies may crush.' }),
    ));
    this.el = h('div', { class: 'n-status n-scaled' }, h('div', { class: 'n-status-row' }, this.time, this.weather), this.grav);
  }

  update() {
    const ctx = this.host.ctx;
    const st = ctx.state;
    const w = this.weatherState;
    const key = `${fmtClock(st.timeOfDay)}|${st.day}|${w?.kind}|${w ? Math.round(w.intensity * 4) : ''}`;
    if (key !== this.last) {
      this.last = key;
      this.time.innerHTML = `${glyphSvg(st.timeOfDay > 0.25 && st.timeOfDay < 0.78 ? 'sun' : 'moon', 13)} <b>${fmtClock(st.timeOfDay)}</b> <span class="n-dim">Day ${st.day + 1} · ${dayPhase(st.timeOfDay)}</span>`;
      if (w) {
        const intensity = w.kind === 'clear' ? '' : w.intensity > 0.7 ? 'Heavy ' : w.intensity < 0.3 ? 'Light ' : '';
        const name = w.kind === 'clear' ? 'Clear skies' : w.kind === 'cloudy' ? 'Overcast' : `${intensity}${cap(w.kind === 'storm' ? 'thunderstorm' : w.kind)}`;
        this.weather.innerHTML = `${glyphSvg(WEATHER_GLYPH[w.kind] ?? 'wind', 13)} ${name}`;
      }
    }
    const pos = ctx.playerPos();
    let g = ctx.gen.gravityAt(pos[0], pos[1], pos[2]) * (st.player?.gravityMul ?? 1);
    const now = this.host.serverNow();
    this.fields = this.fields.filter((f) => f.until > now);
    for (const f of this.fields) if (Math.hypot(pos[0] - f.pos[0], pos[1] - f.pos[1], pos[2] - f.pos[2]) < f.radius) g *= f.factor;
    const ratio = g / 9.81;
    const gk = ratio.toFixed(2);
    if (gk !== this.lastG) {
      this.lastG = gk;
      this.gravText.innerHTML = `${(g).toFixed(1)} m/s² <span class="n-dim">· ${ctx.gen.gravityLabel(g)}</span>`;
      this.grav.classList.toggle('light', ratio < 0.85);
      this.grav.classList.toggle('heavy', ratio > 1.15);
      this.grav.style.setProperty('--g', String(Math.min(2, Math.max(0.2, ratio))));
    }
  }
}

// ------------------------------------------------------------------ crosshair & prompt

export class Crosshair {
  readonly el: HTMLElement;
  private prompt: HTMLElement;
  private focus: FocusTarget | null = null;
  private style = '';

  constructor(private host: UiHost) {
    this.prompt = h('div', { class: 'n-prompt' });
    this.el = h('div', { class: 'n-crosshair' }, h('i', { class: 'n-ch' }), this.prompt);
  }

  setStyle(s: string) {
    if (s === this.style) return;
    this.style = s;
    this.el.dataset.style = s;
  }

  setFocus(f: FocusTarget | null) {
    this.focus = f;
    if (!f || !f.prompt) {
      this.prompt.classList.remove('show');
      this.el.classList.remove('hostile', 'friendly');
      return;
    }
    let name = '';
    let hostile = false;
    if (f.kind === 'entity') {
      const s = f.snap;
      name = s.item ? `${s.item.name}${s.item.count > 1 ? ` ×${s.item.count}` : ''}` : s.name ?? '';
      hostile = (s.flags & EntFlag.Hostile) !== 0;
    } else if (f.kind === 'object') name = '';
    // Terrain is dug with the attack command; everything else is used with interact.
    const cmd = f.kind === 'terrain' ? 'attack' : 'interact';
    setChildren(this.prompt,
      touchMode()
        ? h('span', { class: 'n-key n-key-glyph', html: glyphSvg(command(cmd).glyph, 13) })
        : h('span', { class: 'n-key', text: primaryKey(cmd, currentOverrides()) }),
      h('span', { class: 'n-prompt-verb', text: f.prompt }),
      name ? h('span', { class: 'n-prompt-name', text: name }) : null,
    );
    this.prompt.classList.add('show');
    this.el.classList.toggle('hostile', hostile);
    this.el.classList.toggle('friendly', !hostile && f.kind === 'entity');
  }

  get current() {
    return this.focus;
  }
}

// ------------------------------------------------------------------ quest tracker

export class QuestTracker {
  readonly el = h('div', { class: 'n-tracker n-scaled n-hidden' });
  private sig = '';
  private distEls: { el: HTMLElement; pos: Vec3 }[] = [];
  private t = 0;

  constructor(private host: UiHost) {}

  refresh() {
    const p = this.host.ctx.state.player;
    const q = p?.journal?.quests.find((x) => x.id === this.host.trackedQuest && x.status === 'active');
    const sig = q ? JSON.stringify([q.id, q.title, q.objectives.map((o) => [o.text, o.done, o.count, o.target])]) : '';
    if (sig === this.sig) return;
    const changed = this.sig && sig && JSON.parse(this.sig)[0] === q?.id;
    this.sig = sig;
    this.distEls = [];
    if (!q) {
      this.el.classList.add('n-hidden');
      return;
    }
    this.el.classList.remove('n-hidden');
    const list = h('ul', { class: 'n-tracker-list' });
    for (const o of q.objectives) {
      const dist = h('span', { class: 'n-tracker-dist' });
      if (o.pos && !o.done) this.distEls.push({ el: dist, pos: o.pos });
      list.append(h('li', { class: `${o.done ? 'done' : ''} ${o.optional ? 'optional' : ''}` },
        h('i', { class: 'n-tracker-check' }),
        h('span', { text: o.text + (o.target ? ` (${o.count ?? 0}/${o.target})` : '') + (o.optional ? ' — optional' : '') }),
        dist,
      ));
    }
    setChildren(this.el, h('div', { class: 'n-tracker-title', html: `${glyphSvg('star', 12, '#ffcf4a')} ${q.title}` }), list);
    if (changed) {
      this.el.classList.remove('pulse');
      void this.el.offsetWidth;
      this.el.classList.add('pulse');
    }
  }

  update(dt: number) {
    this.t -= dt;
    if (this.t > 0 || !this.distEls.length) return;
    this.t = 0.5;
    const pp = this.host.ctx.playerPos();
    for (const d of this.distEls) d.el.textContent = fmtDist(Math.hypot(d.pos[0] - pp[0], d.pos[2] - pp[2]));
  }
}

