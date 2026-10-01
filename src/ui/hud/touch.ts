/**
 * On-screen touch controls, shown only in touch input mode (platform.inputMode) while no
 * panel, dialog or death screen is up. Everything is built from the command registry
 * (src/client/commands.ts): a command with `touch.method` 'button' gets a button in the
 * action cluster, 'menu' a button in the menu bar, 'gesture' a gesture on another button;
 * adding a command there offers it here automatically.
 *
 *  - Left (right when left-handed): a floating thumb-stick appears where the thumb lands.
 *    Analog walk/run; pushed past the outer ring it sprints (same stamina rules as Shift).
 *  - Elsewhere on free screen space: drag to look, pinch with two fingers to zoom.
 *  - Action cluster (thumb-reachable, ≥ 56 px): attack, block (hold), jump, sneak (toggle),
 *    interact (only while something is in reach), target (tap: next, swipe left: previous,
 *    hold: clear), first/third person.
 *  - Menu bar: inventory, skills, journal, map, Game Master, guide, pause.
 *
 * Multi-touch: every pointer is tracked by id with its own role (stick, look, pinch, button),
 * so stick + look + a button work at the same time. All gameplay goes through
 * `ctx.controls` (VirtualControls) into the same actions as keyboard and mouse.
 */
import { h } from '../dom';
import { glyphSvg } from '../icons';
import { HOLD_MS } from '../gestures';
import { COMMANDS, primaryKey, type CommandDef, type CommandId, type GameAction, type UiCommand } from '../../client/commands';
import type { FocusTarget, TargetInfo } from '../../client/context';
import type { TouchSettings } from '../settings';
import type { UiHost } from '../host';
import { appShell } from '../../client/appShell';

export interface TouchHost extends UiHost {
  /** Run an interface command (panel toggles, guide, pause, clear target). */
  runCommand(id: UiCommand): void;
}

/** Stick radius at size 1× (px). */
const STICK_R = 62;
/** Inner dead zone as a fraction of the radius. */
const DEAD = 0.12;
/** Sprint when the thumb is this far out (× radius), stop again below SPRINT_OFF (hysteresis). */
const SPRINT_ON = 1.2;
const SPRINT_OFF = 1.06;
/** Horizontal swipe on a button that counts as "swipe left" (px). */
const SWIPE = 30;
/** Pinch: accumulate this many zoom steps before applying (finger jitter must not flip first person). */
const PINCH_STEP = 0.12;

/**
 * Cluster positions of the known buttons: [inset from the side edge, from the bottom, size] in
 * px (mirrored for the left-handed layout). Buttons for commands added later stack up beside it.
 */
const LAYOUT: Partial<Record<CommandId, [number, number, number]>> = {
  attack: [28, 36, 88],
  jump: [136, 28, 66],
  block: [36, 140, 66],
  interact: [124, 112, 62],
  crouch: [216, 24, 58],
  target: [40, 222, 58],
  camera: [134, 204, 50],
};

type Role =
  | { kind: 'stick'; ox: number; oy: number }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'button' };

export class TouchControls {
  readonly el: HTMLElement;
  private zone: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private ghost: HTMLElement;
  private cluster: HTMLElement;
  private menu: HTMLElement;
  private buttons = new Map<CommandId, HTMLElement>();
  private pointers = new Map<number, Role>();
  private pinch: { a: number; b: number; dist: number; acc: number } | null = null;
  private sprinting = false;
  private visible = false;
  private settings: TouchSettings = { lookSensitivity: 1, stickSize: 1, leftHanded: false, opacity: 0.85, sprintRing: true };
  private focusInReach = false;

  constructor(private host: TouchHost) {
    this.zone = h('div', { class: 'n-touch-zone' });
    this.knob = h('div', { class: 'n-stick-knob' });
    this.stick = h('div', { class: 'n-stick n-hidden' }, h('div', { class: 'n-stick-ring' }), this.knob);
    this.ghost = h('div', { class: 'n-stick n-stick-ghost' }, h('div', { class: 'n-stick-ring' }), h('div', { class: 'n-stick-knob' }));
    this.cluster = h('div', { class: 'n-touch-cluster' });
    this.menu = h('nav', { class: 'n-touch-menu', attrs: { 'aria-label': 'Menu' } });
    this.el = h('div', { class: 'n-touch n-hidden' }, this.zone, this.ghost, this.stick, this.cluster, this.menu);

    let extra = 0;
    for (const c of COMMANDS) {
      if (c.debug) continue;
      if (c.touch.method === 'button') {
        const b = this.button(c);
        const pos = LAYOUT[c.id] ?? [216, 100 + 70 * extra++, 56];
        b.style.setProperty('--side', `${pos[0]}px`);
        b.style.setProperty('--bottom', `${pos[1]}px`);
        b.style.setProperty('--size', `${pos[2]}px`);
        if (c.touch.when) b.classList.add('n-hidden');
        this.buttons.set(c.id, b);
        this.cluster.append(b);
      } else if (c.touch.method === 'menu') {
        const key = primaryKey(c.id);
        const b = h('button', {
          class: 'n-touch-mbtn', html: glyphSvg(c.glyph, 22),
          attrs: { type: 'button', 'aria-label': c.label, title: key ? `${c.label} (${key})` : c.label },
          onclick: () => this.host.runCommand(c.id as UiCommand),
        });
        this.menu.append(b);
      }
    }
    this.bindZone();
    // Fingers lifted while the app was away never send pointerup: start clean.
    addEventListener('blur', () => this.reset());
    appShell.onBackground(() => this.reset());
  }

  private get controls() {
    return this.host.ctx.controls;
  }

  // ---------------------------------------------------------------- buttons

  private button(c: CommandDef): HTMLElement {
    const b = h('button', {
      class: `n-tbtn n-tb-${c.id}`,
      html: `${glyphSvg(c.glyph, 30)}<span class="n-tbtn-cap">${c.short}</span>`,
      attrs: { type: 'button', 'aria-label': c.label },
    });
    // Gestures other commands perform on this button (target: swipe left / hold).
    const extra = COMMANDS.filter((g) => g.touch.method === 'gesture' && g.touch.on === c.id);
    const onHold = extra.find((g) => g.touch.gesture === 'hold');
    const onSwipe = extra.find((g) => g.touch.gesture === 'swipeLeft');
    const latch = c.kind === 'hold' && c.touch.kind === 'toggle';
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { kind: 'button' });
      b.classList.add('down');
      const id = e.pointerId, sx = e.clientX;
      if (!extra.length) {
        // Immediate: press on touch-down (responsive), release on lift.
        if (c.scope === 'ui') this.host.runCommand(c.id as UiCommand);
        else if (latch) this.controls?.toggle(c.id as GameAction);
        else this.controls?.press(c.id as GameAction);
        const up = (u: PointerEvent) => {
          if (u.pointerId !== id) return;
          b.removeEventListener('pointerup', up);
          b.removeEventListener('pointercancel', up);
          b.classList.remove('down');
          this.pointers.delete(id);
          if (c.scope === 'game' && !latch) this.controls?.release(c.id as GameAction);
        };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        return;
      }
      // Deferred: the gesture decides — tap (own command), swipe left, or hold.
      let done = false;
      const timer = onHold ? window.setTimeout(() => {
        done = true;
        b.classList.add('held');
        this.run(onHold);
      }, HOLD_MS) : 0;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== id || done || !onSwipe) return;
        if (m.clientX - sx < -SWIPE) {
          done = true;
          clearTimeout(timer);
          this.run(onSwipe);
        }
      };
      const up = (u: PointerEvent) => {
        if (u.pointerId !== id) return;
        clearTimeout(timer);
        b.removeEventListener('pointermove', move);
        b.removeEventListener('pointerup', up);
        b.removeEventListener('pointercancel', up);
        b.classList.remove('down', 'held');
        this.pointers.delete(id);
        if (!done && u.type === 'pointerup') this.run(c);
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    });
    // Touch buttons never open menus, select text or show the iOS callout.
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }

  private run(c: CommandDef) {
    if (c.scope === 'ui') this.host.runCommand(c.id as UiCommand);
    else if (c.scope === 'game') this.controls?.tap(c.id as GameAction);
  }

  // ---------------------------------------------------------------- stick, look, pinch

  private bindZone() {
    const z = this.zone;
    z.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      z.setPointerCapture(e.pointerId);
      const leftSide = e.clientX < innerWidth * 0.4;
      const stickSide = this.settings.leftHanded ? e.clientX > innerWidth * 0.6 : leftSide;
      if (stickSide && !this.hasRole('stick')) {
        const r = this.radius();
        // Keep the whole ring on screen.
        const ox = Math.max(r + 8, Math.min(innerWidth - r - 8, e.clientX));
        const oy = Math.max(r + 8, Math.min(innerHeight - r - 8, e.clientY));
        this.pointers.set(e.pointerId, { kind: 'stick', ox, oy });
        this.stick.style.transform = `translate(${ox}px, ${oy}px)`;
        this.stick.classList.remove('n-hidden');
        this.ghost.classList.add('n-hidden');
        this.moveStick(ox, oy, e.clientX, e.clientY);
        return;
      }
      this.pointers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY });
      const looks = this.lookIds();
      if (looks.length === 2) this.startPinch(looks[0], looks[1]);
    });
    z.addEventListener('pointermove', (e) => {
      const r = this.pointers.get(e.pointerId);
      if (!r) return;
      if (r.kind === 'stick') this.moveStick(r.ox, r.oy, e.clientX, e.clientY);
      else if (r.kind === 'look') {
        const dx = e.clientX - r.x, dy = e.clientY - r.y;
        r.x = e.clientX;
        r.y = e.clientY;
        if (this.pinch) this.updatePinch();
        else this.controls?.look(dx, dy);
      }
    });
    const end = (e: PointerEvent) => {
      const r = this.pointers.get(e.pointerId);
      if (!r || r.kind === 'button') return;
      this.pointers.delete(e.pointerId);
      if (r.kind === 'stick') this.endStick();
      else if (this.pinch && (this.pinch.a === e.pointerId || this.pinch.b === e.pointerId)) this.pinch = null;
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
    z.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private hasRole(kind: Role['kind']) {
    for (const r of this.pointers.values()) if (r.kind === kind) return true;
    return false;
  }

  private lookIds(): number[] {
    const out: number[] = [];
    for (const [id, r] of this.pointers) if (r.kind === 'look') out.push(id);
    return out;
  }

  private radius() {
    return STICK_R * this.settings.stickSize;
  }

  private moveStick(ox: number, oy: number, x: number, y: number) {
    const R = this.radius();
    const dx = x - ox, dy = y - oy;
    const d = Math.hypot(dx, dy);
    const k = d > R ? R / d : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    // Dead zone, then linear up to the ring: a half push walks, a full push runs.
    const mag = d <= R * DEAD ? 0 : Math.min(1, (d / R - DEAD) / (1 - DEAD));
    const nx = d > 0 ? dx / d : 0, ny = d > 0 ? dy / d : 0;
    this.controls?.setMove(-ny * mag, nx * mag);
    const sprint = this.settings.sprintRing && (this.sprinting ? d > R * SPRINT_OFF : d > R * SPRINT_ON);
    if (sprint !== this.sprinting) {
      this.sprinting = sprint;
      if (sprint) this.controls?.press('sprint');
      else this.controls?.release('sprint');
      this.stick.classList.toggle('sprint', sprint);
    }
  }

  private endStick() {
    this.controls?.setMove(0, 0);
    if (this.sprinting) this.controls?.release('sprint');
    this.sprinting = false;
    this.stick.classList.add('n-hidden');
    this.stick.classList.remove('sprint');
    this.knob.style.transform = '';
    this.ghost.classList.remove('n-hidden');
  }

  private pinchDist(a: number, b: number): number {
    const ra = this.pointers.get(a), rb = this.pointers.get(b);
    if (ra?.kind !== 'look' || rb?.kind !== 'look') return 0;
    return Math.hypot(ra.x - rb.x, ra.y - rb.y);
  }

  private startPinch(a: number, b: number) {
    this.pinch = { a, b, dist: Math.max(1, this.pinchDist(a, b)), acc: 0 };
  }

  private updatePinch() {
    const p = this.pinch!;
    const d = Math.max(1, this.pinchDist(p.a, p.b));
    // Fingers apart → zoom in (negative steps, like the wheel scrolled up).
    p.acc += Math.log(p.dist / d) / Math.log(1.15);
    p.dist = d;
    if (Math.abs(p.acc) >= PINCH_STEP) {
      this.controls?.zoom(p.acc);
      p.acc = 0;
    }
  }

  // ---------------------------------------------------------------- state

  /** Drop every touch (controls hidden, window blurred, mode switch). */
  reset() {
    for (const [id, r] of this.pointers) {
      if (r.kind === 'stick') this.endStick();
      this.pointers.delete(id);
    }
    this.pinch = null;
    for (const b of this.buttons.values()) b.classList.remove('down', 'held');
    this.controls?.releaseAll();
  }

  setVisible(v: boolean) {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('n-hidden', !v);
    if (!v) this.reset();
  }

  applySettings(t: TouchSettings) {
    this.settings = t;
    // The HUD around the controls mirrors too (vitals swap sides), hence on <html>.
    this.el.dataset.hand = document.documentElement.dataset.hand = t.leftHanded ? 'left' : 'right';
    this.el.style.setProperty('--touch-opacity', String(t.opacity));
    this.el.style.setProperty('--stick-r', `${Math.round(this.radius())}px`);
  }

  /** Interaction focus from the core: the interact button only shows while something is in reach. */
  setFocus(f: FocusTarget | null) {
    this.focusInReach = !!f && !!f.prompt && f.kind !== 'terrain';
    for (const c of COMMANDS) if (c.touch.when === 'focus') this.buttons.get(c.id)?.classList.toggle('n-hidden', !this.focusInReach);
  }

  setTarget(t: TargetInfo | null) {
    this.buttons.get('target')?.classList.toggle('on', !!t);
  }

  update() {
    if (!this.visible) return;
    const ctl = this.controls;
    // Latched holds (sneak) show their state; the core may drop them (panel opened, death).
    for (const c of COMMANDS) {
      if (c.kind !== 'hold' || c.touch.kind !== 'toggle') continue;
      const b = this.buttons.get(c.id);
      const on = !!ctl?.isHeld(c.id as GameAction);
      if (b && b.classList.contains('on') !== on) b.classList.toggle('on', on);
    }
  }
}
