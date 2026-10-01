/**
 * Central interaction behaviour for mouse *and* touch. Widgets and panels describe
 * intent ("secondary action", "double activation", "show details on hold") and this
 * module maps it onto the current input mode, instead of every panel wiring
 * `contextmenu` / `dblclick` / hover by hand:
 *
 *  - `onSecondary(el, fn)`  right-click with a mouse, long-press (~450 ms, finger still) on touch
 *  - `onDouble(el, fn)`     double-click with a mouse, double-tap on touch
 *  - `onHold(el, fn)`       long-press only (tooltips use it in touch mode)
 *  - `claimPointer(id, …)`  coordinates long-press with drag & drop: a drag starts on movement
 *                           and cancels the pending long-press; a fired long-press blocks a drag
 *  - `verbs`                mode-aware words for hint texts ("Double-tap" vs "Double-click")
 *
 * It also installs the global touch guards once (no page pinch-zoom / double-tap zoom / iOS
 * callout or text selection in the game UI, no native long-press context menu) and keeps text
 * fields visible above the on-screen keyboard (visualViewport → `--vv-top` / `--vv-bottom`,
 * `data-kb="open"` on <html>).
 */
import { platform } from '../core/platform';

export const HOLD_MS = 450;
/** A finger may wander this far (px) and still count as "still" for long-press and taps. */
export const TOUCH_SLOP = 10;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 26;

export type PointerSource = 'mouse' | 'touch';
type SecondaryFn = (x: number, y: number, source: PointerSource) => void;
type HoldFn = (x: number, y: number) => void;

interface Rec {
  hold: { fn: HoldFn; when?: () => boolean }[];
  secondary: { fn: SecondaryFn; when?: () => boolean }[];
  double: (() => void)[];
  lastTap: { t: number; x: number; y: number } | null;
}

const recs = new WeakMap<HTMLElement, Rec>();
const claims = new Map<number, 'hold' | 'drag'>();
let lastPointer: PointerSource = 'mouse';
let lastPointerAt = 0;

/** True in touch mode (the platform's live input mode). */
export function touchMode(): boolean {
  return platform.inputMode === 'touch';
}

/** Was the most recent pointer-down a finger or pen (for events without a pointer type)? */
export function lastWasTouch(): boolean {
  return lastPointer === 'touch';
}

/** Claim a pointer for a gesture. Returns false when another gesture already owns it. */
export function claimPointer(id: number, kind: 'hold' | 'drag'): boolean {
  const c = claims.get(id);
  if (c && c !== kind) return false;
  claims.set(id, kind);
  return true;
}

export function pointerClaim(id: number): 'hold' | 'drag' | undefined {
  return claims.get(id);
}

function rec(el: HTMLElement): Rec {
  let r = recs.get(el);
  if (r) return r;
  const R: Rec = { hold: [], secondary: [], double: [], lastTap: null };
  recs.set(el, R);
  r = R;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    const id = e.pointerId, sx = e.clientX, sy = e.clientY;
    let moved = false;
    let fired = false;
    const timer = window.setTimeout(() => {
      const holds = R.hold.filter((h) => !h.when || h.when());
      const secs = R.secondary.filter((h) => !h.when || h.when());
      if (!holds.length && !secs.length) return;
      if (!claimPointer(id, 'hold')) return;
      fired = true;
      suppressNextClick();
      (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(8);
      for (const h of holds) h.fn(sx, sy);
      for (const f of secs) f.fn(sx, sy, 'touch');
    }, HOLD_MS);
    const move = (m: PointerEvent) => {
      if (m.pointerId !== id) return;
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > TOUCH_SLOP) {
        moved = true;
        clearTimeout(timer);
      }
    };
    const end = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      clearTimeout(timer);
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', end, true);
      removeEventListener('pointercancel', end, true);
      if (u.type === 'pointerup' && !moved && !fired && R.double.length) {
        const now = performance.now();
        const lt = R.lastTap;
        if (lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(u.clientX - lt.x, u.clientY - lt.y) < DOUBLE_TAP_DIST) {
          R.lastTap = null;
          for (const f of R.double) f();
        } else R.lastTap = { t: now, x: u.clientX, y: u.clientY };
      }
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', end, true);
    addEventListener('pointercancel', end, true);
  });
  el.addEventListener('contextmenu', (e) => {
    if (!R.secondary.length) return;
    e.preventDefault();
    // A finger's long-press is recognised above; browsers may also send contextmenu for it.
    if (lastWasTouch()) return;
    for (const f of R.secondary) f.fn(e.clientX, e.clientY, 'mouse');
  });
  el.addEventListener('dblclick', () => {
    if (lastWasTouch()) return;
    for (const f of R.double) f();
  });
  return r;
}

/** Right-click (mouse) or long-press (touch); `when` can veto the long-press. */
export function onSecondary(el: HTMLElement, fn: SecondaryFn, when?: () => boolean): void {
  rec(el).secondary.push({ fn, when });
}

/** Double-click (mouse) or double-tap (touch). */
export function onDouble(el: HTMLElement, fn: () => void): void {
  rec(el).double.push(fn);
}

/** Long-press on touch only; `when` can veto it (e.g. hotbar slots charge abilities instead). */
export function onHold(el: HTMLElement, fn: HoldFn, when?: () => boolean): void {
  rec(el).hold.push({ fn, when });
}

/** The click that follows a long-press must not also activate the element. */
function suppressNextClick() {
  const kill = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  addEventListener('click', kill, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', kill, { capture: true }), 700);
}

/** Mode-aware words for hint texts (read when the hint is built, so they follow the mode). */
export const verbs = {
  get click() {
    return touchMode() ? 'Tap' : 'Click';
  },
  get double() {
    return touchMode() ? 'Double-tap' : 'Double-click';
  },
  get secondary() {
    return touchMode() ? 'hold' : 'right-click';
  },
  get drag() {
    return 'drag';
  },
};

// ------------------------------------------------------------------ global guards

function install() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    lastPointerAt = performance.now();
  }, { capture: true, passive: true });
  const release = (e: PointerEvent) => {
    // Claims live for one pointer's lifetime.
    setTimeout(() => claims.delete(e.pointerId), 0);
  };
  addEventListener('pointerup', release, { capture: true, passive: true });
  addEventListener('pointercancel', release, { capture: true, passive: true });
  // Native long-press menus (Android) and the iOS callout: the game has its own.
  addEventListener('contextmenu', (e) => {
    if (lastWasTouch() && performance.now() - lastPointerAt < 2000 && !isTextField(e.target)) e.preventDefault();
  }, { capture: true });
  // iOS Safari ignores user-scalable=no: block page pinch-zoom gestures directly.
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions);
  // Multi-finger moves never pan or zoom the page (scrollable lists still scroll with one finger).
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  installSoftKeyboard();
}

function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/**
 * On-screen keyboard: keep the focused field visible. The visual viewport shrinks (and on
 * iOS scrolls) when the keyboard opens; panels inset themselves by `--vv-top`/`--vv-bottom`.
 */
function installSoftKeyboard() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;
  const update = () => {
    const top = Math.max(0, vv.offsetTop);
    const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    root.style.setProperty('--vv-bottom', `${Math.round(bottom)}px`);
    const open = bottom > 80 && isTextField(document.activeElement);
    if (open) root.dataset.kb = 'open';
    else delete root.dataset.kb;
    if (open) (document.activeElement as HTMLElement).scrollIntoView({ block: 'nearest' });
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  addEventListener('focusin', () => setTimeout(update, 60));
  addEventListener('focusout', () => {
    setTimeout(() => {
      update();
      // iOS leaves the page scrolled after the keyboard closes; the game never scrolls.
      if (!isTextField(document.activeElement) && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
    }, 60);
  });
}

install();

/**
 * Focus a text field when a panel opens — except in touch mode, where it would pop the
 * on-screen keyboard over the panel unasked (the player taps the field when they want it).
 */
export function autoFocusField(el: HTMLElement, delay = 30): void {
  if (touchMode()) return;
  setTimeout(() => el.focus(), delay);
}
