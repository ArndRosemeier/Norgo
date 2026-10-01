/**
 * Source-agnostic gameplay input. Several sources feed the same actions:
 *
 *  - keyboard & mouse: key → action map derived from the command registry
 *    (src/client/commands.ts), mouse buttons, pointer-locked mouse look, wheel zoom;
 *  - virtual controls (`VirtualControls`): touch thumb-stick, touch buttons, tappable
 *    hotbar slots, touch look and pinch zoom — anything on screen that acts like a key.
 *
 * Actions are held per source, so a button released on one source never cancels the same
 * action held on another. A press and release within one frame still produce a visible
 * press: the release is deferred to the next frame (hold-to-charge abilities and the jump
 * key always see a down frame).
 *
 * Movement is analog: `moveForward` / `moveRight` are in [-1, 1] (keys give ±1, the stick
 * anything in between, so a half-pushed stick walks). Look deltas are in radians.
 *
 * Pointer lock is only requested in mouse mode; in touch mode the camera is dragged.
 */
import {
  HOTBAR_ACTIONS, bindingOfEvent, keyMap, keysOf, overridesFromControls,
  type BindingOverrides, type CommandId, type GameAction,
} from './commands';
import { platform } from '../core/platform';
import { appShell } from './appShell';

export type Action = GameAction;
export { HOTBAR_ACTIONS };

/** The on-screen control surface (touch): what the UI may drive. */
export interface VirtualControls {
  /** False while a panel captures input (gameplay suspended). */
  readonly enabled: boolean;
  /** Hold an action down until `release` (touch button, hotbar slot). */
  press(a: GameAction): void;
  release(a: GameAction): void;
  /** Press and release (a tap); the release lands on the next frame. */
  tap(a: GameAction): void;
  /** Latch a hold action on/off (crouch toggle on touch). Returns the new state. */
  toggle(a: GameAction): boolean;
  /** Held by the virtual source (latched or pressed). */
  isHeld(a: GameAction): boolean;
  /** Analog movement from the thumb-stick, camera-relative, each in [-1, 1]. */
  setMove(forward: number, right: number): void;
  /** Look by a screen-space drag (pixels; sensitivity and invert-Y are applied here). */
  look(dx: number, dy: number): void;
  /** Zoom steps (positive = out), fractional allowed. */
  zoom(steps: number): void;
  /** Drop everything the virtual source holds (controls hidden, mode switch). */
  releaseAll(): void;
}

type Source = 'keys' | 'mouse' | 'virtual';

/** Default mouse look: radians per pixel at sensitivity 1×. */
export const MOUSE_RAD_PER_PX = 0.0022;
/** Default touch look: radians per dragged pixel at sensitivity 1× (a 1000 px swipe ≈ 260°). */
export const TOUCH_RAD_PER_PX = 0.0045;

const MOUSE_BUTTON: Record<number, string> = { 0: 'Mouse0', 1: 'Mouse1', 2: 'Mouse2' };

export class Input implements VirtualControls {
  private held: Record<Source, Set<Action>> = { keys: new Set(), mouse: new Set(), virtual: new Set() };
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  /** Releases of actions pressed in the same frame, applied after that frame. */
  private deferred: [Source, Action][] = [];
  /** Key code → the action its keydown started (keyup releases exactly that one). */
  private codeAction = new Map<string, Action>();
  private overrides: BindingOverrides = {};
  /** Keyboard actions that latch (press = on, press again = off) instead of acting while held. */
  private latching = new Set<Action>();
  private keys = new Map<string, CommandId[]>();
  private stickF = 0;
  private stickR = 0;
  /** Look delta this frame in radians (mouse + touch). */
  lookX = 0;
  lookY = 0;
  /** Zoom steps this frame (wheel + pinch). */
  wheel = 0;
  /** Mouse look radians per pixel. */
  sensitivity = MOUSE_RAD_PER_PX;
  /** Touch look radians per pixel. */
  touchSensitivity = TOUCH_RAD_PER_PX;
  invertY = false;
  /** When false, gameplay input is ignored (UI panels open). */
  enabled = true;
  private locked = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.rebuildKeys();
    // The canvas never scrolls, zooms or selects: touch gestures belong to the game.
    canvas.style.touchAction = 'none';
    addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      // Tab would move browser focus between buttons; it never does anything useful in the game.
      if (e.code === 'Tab') e.preventDefault();
      const b = bindingOfEvent(e, this.keys);
      const a = this.actionFor(b);
      if (!a) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.enabled || e.repeat && this.codeAction.has(e.code)) return;
      if (this.latching.has(a)) {
        if (e.repeat) return;
        if (this.held.keys.has(a)) this.unhold('keys', a);
        else this.hold('keys', a);
        return;
      }
      this.codeAction.set(e.code, a);
      this.hold('keys', a);
    });
    addEventListener('keyup', (e) => {
      const a = this.codeAction.get(e.code) ?? this.actionFor(e.code);
      this.codeAction.delete(e.code);
      if (a) this.unhold('keys', a);
    });
    canvas.addEventListener('mousedown', (e) => {
      // Compatibility mouse events after a touch must not lock the pointer or attack.
      if (!this.enabled || platform.inputMode === 'touch') return;
      if (!this.locked) {
        this.lock();
        return;
      }
      const a = this.actionFor(MOUSE_BUTTON[e.button] ?? '');
      if (a) this.hold('mouse', a);
    });
    addEventListener('mouseup', (e) => {
      const a = this.actionFor(MOUSE_BUTTON[e.button] ?? '');
      if (a) this.unhold('mouse', a);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.lookX += e.movementX * this.sensitivity;
      this.lookY += e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.releaseSource('keys');
        this.releaseSource('mouse');
        this.codeAction.clear();
      }
    });
    const dropAll = () => {
      this.releaseSource('keys');
      this.releaseSource('mouse');
      this.releaseSource('virtual');
      this.codeAction.clear();
    };
    addEventListener('blur', dropAll);
    // App switch / tab hidden / page hide (iOS sends no blur or key/pointer ups then).
    appShell.onBackground(dropAll);
    // Switching to touch frees the mouse; touch controls take over.
    platform.onInputMode((m) => {
      if (m === 'touch') this.unlock();
      else this.releaseAll();
    });
  }

  private actionFor(binding: string): Action | undefined {
    return this.keys.get(binding)?.[0] as Action | undefined;
  }

  private rebuildKeys() {
    this.keys = keyMap('game', this.overrides);
  }

  // ---------------------------------------------------------------- holding

  private isHeldAny(a: Action) {
    return this.held.keys.has(a) || this.held.mouse.has(a) || this.held.virtual.has(a);
  }

  private hold(src: Source, a: Action) {
    if (!this.enabled) return;
    if (!this.isHeldAny(a)) this.pressed.add(a);
    this.held[src].add(a);
  }

  private unhold(src: Source, a: Action) {
    if (!this.held[src].has(a)) return;
    // Pressed this very frame: let the game see one held frame first.
    if (this.pressed.has(a)) {
      this.deferred.push([src, a]);
      return;
    }
    this.held[src].delete(a);
    if (!this.isHeldAny(a)) this.released.add(a);
  }

  private releaseSource(src: Source) {
    for (const a of [...this.held[src]]) {
      this.held[src].delete(a);
      if (!this.isHeldAny(a)) this.released.add(a);
    }
    if (src === 'virtual') {
      this.stickF = 0;
      this.stickR = 0;
    }
  }

  // ---------------------------------------------------------------- pointer lock

  lock() {
    if (!this.enabled || platform.inputMode === 'touch') return;
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => undefined);
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get isLocked() {
    return this.locked;
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) {
      this.releaseSource('keys');
      this.releaseSource('mouse');
      this.releaseSource('virtual');
      this.codeAction.clear();
      this.unlock();
    }
  }

  // ---------------------------------------------------------------- queries

  isDown(a: Action) {
    return this.enabled && this.isHeldAny(a);
  }

  wasPressed(a: Action) {
    return this.enabled && this.pressed.has(a);
  }

  wasReleased(a: Action) {
    return this.released.has(a);
  }

  /** Camera-relative forward axis in [-1, 1] (keys + stick). */
  get moveForward(): number {
    if (!this.enabled) return 0;
    const k = (this.isHeldAny('forward') ? 1 : 0) - (this.isHeldAny('back') ? 1 : 0);
    return clamp1(k + this.stickF);
  }

  /** Camera-relative right axis in [-1, 1] (keys + stick). */
  get moveRight(): number {
    if (!this.enabled) return 0;
    const k = (this.isHeldAny('right') ? 1 : 0) - (this.isHeldAny('left') ? 1 : 0);
    return clamp1(k + this.stickR);
  }

  // ---------------------------------------------------------------- bindings

  /** Apply the persisted control settings (sensitivities, invert-Y, rebinds). */
  applyControls(controls: { mouseSensitivity: number; invertY: boolean; toggleSprint?: boolean; toggleCrouch?: boolean }, touchLook = 1) {
    // Settings → Controls "Toggle sprint / crouch": those keys latch instead of being held.
    const latch = new Set<Action>();
    if (controls.toggleSprint) latch.add('sprint');
    if (controls.toggleCrouch) latch.add('crouch');
    for (const a of this.latching) if (!latch.has(a) && this.held.keys.has(a)) this.unhold('keys', a);
    this.latching = latch;
    this.sensitivity = MOUSE_RAD_PER_PX * controls.mouseSensitivity;
    this.touchSensitivity = TOUCH_RAD_PER_PX * touchLook;
    this.invertY = controls.invertY;
    const next = overridesFromControls(controls);
    if (JSON.stringify(next) === JSON.stringify(this.overrides)) return;
    this.overrides = next;
    this.rebuildKeys();
    // Keys held under the old map would never see their keyup mapping: release them.
    this.releaseSource('keys');
    this.codeAction.clear();
  }

  /** Key code currently bound to an action (first match). */
  bindingOf(a: Action): string | undefined {
    return keysOf(a, this.overrides)[0];
  }

  // ---------------------------------------------------------------- VirtualControls

  get virtual(): VirtualControls {
    return this;
  }

  press(a: Action) {
    this.hold('virtual', a);
  }

  release(a: Action) {
    this.unhold('virtual', a);
  }

  tap(a: Action) {
    this.hold('virtual', a);
    this.unhold('virtual', a);
  }

  toggle(a: Action): boolean {
    if (this.held.virtual.has(a)) {
      this.unhold('virtual', a);
      return false;
    }
    this.hold('virtual', a);
    return this.held.virtual.has(a);
  }

  isHeld(a: Action): boolean {
    return this.held.virtual.has(a);
  }

  setMove(forward: number, right: number) {
    this.stickF = this.enabled ? clamp1(forward) : 0;
    this.stickR = this.enabled ? clamp1(right) : 0;
  }

  look(dx: number, dy: number) {
    if (!this.enabled) return;
    this.lookX += dx * this.touchSensitivity;
    this.lookY += dy * this.touchSensitivity * (this.invertY ? -1 : 1);
  }

  zoom(steps: number) {
    if (this.enabled) this.wheel += steps;
  }

  releaseAll() {
    this.releaseSource('virtual');
  }

  /** Call at end of frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
    const d = this.deferred;
    this.deferred = [];
    for (const [src, a] of d) this.unhold(src, a);
  }
}

function clamp1(v: number) {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return e.isComposing || (!!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
}
