/**
 * Tiny DOM helpers for the vanilla-TS UI. Keeps panel code declarative without a
 * framework: `h('div', { class: 'x', onclick }, child, 'text')`.
 */

type Child = Node | string | number | null | undefined | false;
type Handler = (ev: never) => void;

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  style?: string | Partial<Record<string, string>>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean>;
  [on: `on${string}`]: Handler | undefined;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const key in props) {
      const v = (props as Record<string, unknown>)[key];
      if (v === undefined || v === null) continue;
      if (key === 'class') el.className = v as string;
      else if (key === 'text') el.textContent = String(v);
      else if (key === 'html') el.innerHTML = v as string;
      else if (key === 'title') el.title = v as string;
      else if (key === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const s in v as Record<string, string>) el.style.setProperty(s, (v as Record<string, string>)[s]);
      } else if (key === 'dataset') Object.assign(el.dataset, v);
      else if (key === 'attrs') {
        for (const a in v as Record<string, unknown>) {
          const av = (v as Record<string, unknown>)[a];
          if (av === false) continue;
          el.setAttribute(a, av === true ? '' : String(av));
        }
      } else if (key.startsWith('on') && typeof v === 'function') {
        el.addEventListener(key.slice(2), v as EventListener);
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace all children. */
export function setChildren(el: Element, ...children: (Child | Child[])[]): void {
  clear(el);
  append(el, children);
}

/** Inline SVG from markup (trusted, internal strings only). */
export function svg(markup: string, cls = ''): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const s = t.content.firstElementChild as SVGSVGElement;
  if (cls) s.setAttribute('class', cls);
  return s;
}

/** Is the keyboard event coming from a text field (so hotkeys should be ignored)? */
export function isTyping(ev: KeyboardEvent): boolean {
  const t = ev.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** Keep a floating element inside the viewport near (x, y). */
export function placeFloating(el: HTMLElement, x: number, y: number, pad = 14): void {
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let px = x + pad, py = y + pad;
  if (px + w > vw - 6) px = Math.max(6, x - w - pad);
  if (py + hgt > vh - 6) py = Math.max(6, vh - hgt - 6);
  el.style.transform = `translate(${px | 0}px, ${py | 0}px)`;
}
