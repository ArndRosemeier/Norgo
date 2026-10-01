/**
 * Reusable UI widgets: ornate frames, sliders, toggles, segmented controls, tabs,
 * a global tooltip, context menu, confirm modal and a pointer-based drag & drop
 * manager (used for inventory ↔ equipment ↔ hotbar ↔ skills book).
 */
import { h, placeFloating, clear } from './dom';
import { onHold, claimPointer, pointerClaim, TOUCH_SLOP } from './gestures';

export function corners(): HTMLElement[] {
  return ['tl', 'tr', 'bl', 'br'].map((c) => h('i', { class: `n-corner ${c}` }));
}

/** Ornate framed box. */
export function frame(cls = '', ...children: (Node | string | null | false)[]): HTMLDivElement {
  return h('div', { class: `n-frame ${cls}` }, ...corners(), ...children);
}

export interface SliderOpts {
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export function slider(label: string, value: number, o: SliderOpts): HTMLLabelElement & { setValue(v: number): void } {
  const input = h('input', { class: 'n-range', attrs: { type: 'range', min: o.min, max: o.max, step: o.step ?? 0.01, 'aria-label': label } });
  const out = h('output');
  const fmt = o.format ?? ((v: number) => v.toFixed(2));
  const paint = (v: number) => {
    input.style.setProperty('--p', `${((v - o.min) / (o.max - o.min)) * 100}%`);
    out.textContent = fmt(v);
  };
  input.value = String(value);
  paint(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    o.onInput(v);
  });
  const el = h('label', { class: 'n-slider' }, h('span', { text: label }), input, out) as HTMLLabelElement & { setValue(v: number): void };
  el.setValue = (v: number) => {
    input.value = String(v);
    paint(v);
  };
  return el;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const input = h('input', { attrs: { type: 'checkbox' } });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'n-toggle' }, h('span', { text: label }), h('span', { class: 'n-switch' }, input, h('i')));
}

export function segmented<T extends string>(options: { id: T; label: string }[], value: T, onChange: (v: T) => void): HTMLDivElement {
  const el = h('div', { class: 'n-seg', attrs: { role: 'radiogroup' } });
  const btns = options.map((o) =>
    h('button', {
      text: o.label,
      class: o.id === value ? 'active' : '',
      attrs: { type: 'button', role: 'radio', 'aria-checked': o.id === value },
      onclick: () => {
        for (const b of btns) b.classList.toggle('active', b === btnOf(o.id));
        onChange(o.id);
      },
    }),
  );
  const btnOf = (id: T) => btns[options.findIndex((o) => o.id === id)];
  el.append(...btns);
  return el;
}

export interface Tabs<T extends string> {
  el: HTMLDivElement;
  value: T;
  set(id: T): void;
  setCount(id: T, n: number | null): void;
}

export function tabs<T extends string>(options: { id: T; label: string }[], value: T, onChange: (v: T) => void): Tabs<T> {
  const el = h('div', { class: 'n-tabs', attrs: { role: 'tablist' } });
  const counts = new Map<T, HTMLElement>();
  const btns = new Map<T, HTMLButtonElement>();
  for (const o of options) {
    const c = h('span', { class: 'n-count' });
    counts.set(o.id, c);
    const b = h('button', { class: 'n-tab', attrs: { type: 'button', role: 'tab' }, onclick: () => api.set(o.id) }, o.label, c);
    btns.set(o.id, b);
    el.append(b);
  }
  const api: Tabs<T> = {
    el,
    value,
    set(id: T) {
      api.value = id;
      for (const [k, b] of btns) {
        b.classList.toggle('active', k === id);
        b.setAttribute('aria-selected', String(k === id));
      }
      onChange(id);
    },
    setCount(id: T, n: number | null) {
      const c = counts.get(id);
      if (c) c.textContent = n ? String(n) : '';
    },
  };
  for (const [k, b] of btns) b.classList.toggle('active', k === value);
  return api;
}

// ------------------------------------------------------------------ tooltip

class TooltipManager {
  private el: HTMLDivElement | null = null;
  private owner: Element | null = null;
  /** Shown by a long-press (touch): stays put until the next tap anywhere else. */
  private pinned = false;
  private x = 0;
  private y = 0;

  private ensure(): HTMLDivElement {
    if (!this.el) {
      this.el = h('div', { class: 'n-tooltip n-frame' });
      document.body.appendChild(this.el);
      window.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        this.x = e.clientX;
        this.y = e.clientY;
        if (this.owner && !this.pinned && this.el?.classList.contains('show')) placeFloating(this.el, this.x, this.y, 18);
      }, { passive: true });
      // A pinned (touch) tooltip goes away with the next touch outside it.
      window.addEventListener('pointerdown', (e) => {
        if (this.pinned && !this.el?.contains(e.target as Node)) this.hide();
      }, { capture: true, passive: true });
    }
    return this.el;
  }

  private fill(owner: Element, content: Node | Node[], wide: boolean): HTMLDivElement {
    const el = this.ensure();
    this.owner = owner;
    clear(el);
    el.className = wide ? 'n-tooltip wide' : 'n-tooltip n-frame';
    for (const n of Array.isArray(content) ? content : [content]) el.appendChild(n);
    el.classList.add('show');
    return el;
  }

  /** Show content near the cursor. `wide` = several cards side by side (comparisons). */
  show(owner: Element, content: Node | Node[], wide = false): void {
    this.pinned = false;
    placeFloating(this.fill(owner, content, wide), this.x, this.y, 18);
  }

  /** Pin content near a point until the next tap elsewhere (touch: a map marker under the finger). */
  showAt(owner: Element, content: Node | Node[], x: number, y: number, wide = false): void {
    placeFloating(this.fill(owner, content, wide), x, y, 26);
    this.pinned = true;
  }

  /** Show content beside an element (touch: a finger would cover a cursor-placed card). */
  showBeside(owner: Element, content: Node | Node[], wide = false): void {
    const el = this.fill(owner, content, wide);
    this.pinned = true;
    const r = owner.getBoundingClientRect();
    const w = el.offsetWidth, hgt = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    // Prefer the left side: a context menu opened by the same long-press unfolds to the right.
    let px = r.left - w - 10;
    if (px < 6) px = r.right + 10;
    let py = r.top + r.height / 2 - hgt / 2;
    if (px + w > vw - 6) {
      // No room on either side: centre it above (or below) the element.
      px = Math.max(6, Math.min(vw - w - 6, r.left + r.width / 2 - w / 2));
      py = r.top - hgt - 10 >= 6 ? r.top - hgt - 10 : r.bottom + 10;
    }
    py = Math.max(6, Math.min(vh - hgt - 6, py));
    el.style.transform = `translate(${px | 0}px, ${py | 0}px)`;
  }

  hide(owner?: Element): void {
    if (owner && owner !== this.owner) return;
    this.owner = null;
    this.pinned = false;
    this.el?.classList.remove('show');
  }

  /**
   * Bind details to an element: hover with a mouse, long-press on touch (dismissed by the
   * next tap elsewhere). `build` is called lazily. `holdWhen` can veto the long-press (the
   * hotbar charges abilities on hold during play).
   */
  bind(target: HTMLElement, build: () => Node | Node[] | null, wide = false, opts: { holdWhen?: () => boolean } = {}): void {
    target.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.x = e.clientX;
      this.y = e.clientY;
      if (drag.active) return;
      const c = build();
      if (c) this.show(target, c, wide);
    });
    target.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.hide(target);
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') this.hide(target);
    });
    onHold(target, () => {
      if (drag.active) return;
      const c = build();
      if (c) this.showBeside(target, c, wide);
    }, opts.holdWhen);
  }
}

export const tooltip = new TooltipManager();

// ------------------------------------------------------------------ context menu

export interface MenuItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  action?: () => void;
  separator?: boolean;
}

let ctxEl: HTMLDivElement | null = null;

export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const el = h('div', { class: 'n-ctx n-frame', attrs: { role: 'menu' } });
  for (const it of items) {
    if (it.separator) {
      el.append(h('hr'));
      continue;
    }
    el.append(
      h('button', {
        html: (it.icon ?? '') + `<span>${it.label}</span>`,
        attrs: { role: 'menuitem', disabled: !!it.disabled },
        class: it.danger ? 'n-bad' : '',
        onclick: () => {
          closeContextMenu();
          it.action?.();
        },
      }),
    );
  }
  document.body.appendChild(el);
  placeFloating(el, x - 14, y - 14, 2);
  ctxEl = el;
  (el.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.focus();
  const off = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
    if (e instanceof PointerEvent && el.contains(e.target as Node)) return;
    if (e instanceof KeyboardEvent) e.stopPropagation();
    closeContextMenu();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', off, true);
  });
  (el as unknown as { _off: (e: Event) => void })._off = off;
}

export function closeContextMenu(): boolean {
  if (!ctxEl) return false;
  const off = (ctxEl as unknown as { _off: (e: Event) => void })._off;
  window.removeEventListener('pointerdown', off, true);
  window.removeEventListener('keydown', off, true);
  ctxEl.remove();
  ctxEl = null;
  return true;
}

// ------------------------------------------------------------------ confirm modal

export function confirmModal(title: string, text: string, okLabel = 'Confirm', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      back.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        done(false);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        e.preventDefault();
        done(true);
      }
    };
    const ok = h('button', { class: `n-btn ${danger ? 'danger' : 'primary'}`, text: okLabel, onclick: () => done(true) });
    const back = h(
      'div',
      { class: 'n-modal-back nui-modal' },
      frame(
        'n-modal',
        h('div', { class: 'n-panel-title', text: title }),
        h('p', { text }),
        h('div', { class: 'n-actions' }, h('button', { class: 'n-btn', text: 'Cancel', onclick: () => done(false) }), ok),
      ),
    );
    document.body.appendChild(back);
    window.addEventListener('keydown', onKey, true);
    ok.focus();
  });
}

// ------------------------------------------------------------------ drag & drop

export type DragPayload =
  | { kind: 'item'; uid: string; from: 'inventory' | 'equipment'; slot?: string }
  | { kind: 'ability'; id: string }
  | { kind: 'hotbar'; slot: number; value: string };

type DropHandler = (p: DragPayload) => void;
type DropAccept = (p: DragPayload) => boolean;

class DragManager {
  active: DragPayload | null = null;
  private ghost: HTMLDivElement | null = null;
  private targets = new Map<HTMLElement, { accept: DropAccept; drop: DropHandler }>();
  private hover: HTMLElement | null = null;
  /** Called when dropped on nothing. */
  private onNowhere: DropHandler | null = null;

  /** Register a drop target. Returns an unregister function. */
  target(el: HTMLElement, accept: DropAccept, drop: DropHandler): () => void {
    this.targets.set(el, { accept, drop });
    return () => this.targets.delete(el);
  }

  /**
   * Make `el` a drag source. The drag starts after a few pixels of movement, so clicks still
   * work; on touch a still finger becomes a long-press instead (see gestures.ts), and a
   * vertical swipe inside a scrolling list scrolls it (CSS `touch-action: pan-y` on sources;
   * the browser then cancels the pointer).
   */
  source(el: HTMLElement, payload: () => DragPayload | null, icon: () => string, onNowhere?: DropHandler): void {
    el.classList.add('n-drag-src');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const id = e.pointerId, sx = e.clientX, sy = e.clientY;
      const slop = e.pointerType === 'mouse' ? 5 : TOUCH_SLOP - 2;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== id || Math.hypot(m.clientX - sx, m.clientY - sy) < slop) return;
        cleanup();
        // A long-press already fired for this finger: it showed details, it does not drag.
        if (pointerClaim(id) === 'hold') return;
        const p = payload();
        if (p && claimPointer(id, 'drag')) this.start(p, icon(), m, onNowhere ?? null);
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
    });
  }

  private start(p: DragPayload, iconUrl: string, e: PointerEvent, onNowhere: DropHandler | null) {
    tooltip.hide();
    closeContextMenu();
    this.active = p;
    this.onNowhere = onNowhere;
    this.ghost = h('div', { class: 'n-drag-ghost' }, h('img', { attrs: { src: iconUrl, alt: '' } }));
    document.body.appendChild(this.ghost);
    document.body.style.cursor = 'grabbing';
    for (const [el, t] of this.targets) if (el.isConnected && t.accept(p)) el.classList.add('n-drop-ok');
    const id = e.pointerId;
    const move = (m: PointerEvent) => {
      if (m.pointerId === id) this.move(m);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.end(u, u.type === 'pointercancel');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.move(e);
  }

  /**
   * Drop target under the pointer. Looks through the whole element stack so targets
   * that show through a translucent backdrop (the hotbar under an open panel's dimmed
   * background) still accept drops; a solid panel in front blocks.
   */
  private findTarget(x: number, y: number): HTMLElement | null {
    for (const hit of document.elementsFromPoint(x, y) as HTMLElement[]) {
      for (let el: HTMLElement | null = hit; el; el = el.parentElement) {
        if (this.targets.has(el)) return el;
      }
      if (hit.closest('.n-panel, .n-modal-back, .n-ctx')) return null;
    }
    return null;
  }

  private move(e: PointerEvent) {
    if (!this.ghost || !this.active) return;
    this.ghost.style.transform = `translate(${e.clientX - 26}px, ${e.clientY - 26}px)`;
    const t = this.findTarget(e.clientX, e.clientY);
    const ok = t && this.targets.get(t)!.accept(this.active) ? t : null;
    if (ok !== this.hover) {
      this.hover?.classList.remove('n-drop-hover');
      ok?.classList.add('n-drop-hover');
      this.hover = ok;
    }
  }

  private end(e: PointerEvent, cancelled = false) {
    const p = this.active!;
    this.ghost?.remove();
    this.ghost = null;
    document.body.style.cursor = '';
    for (const el of this.targets.keys()) el.classList.remove('n-drop-ok', 'n-drop-hover');
    this.hover = null;
    this.active = null;
    if (cancelled) {
      // The browser took the pointer (system gesture): abandon the drag, drop nothing.
      this.onNowhere = null;
      return;
    }
    const t = this.findTarget(e.clientX, e.clientY);
    const entry = t ? this.targets.get(t)! : null;
    if (entry && entry.accept(p)) entry.drop(p);
    else if (!t) this.onNowhere?.(p);
    this.onNowhere = null;
  }
}

export const drag = new DragManager();
