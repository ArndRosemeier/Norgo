/** Keyboard/mouse input with pointer lock and action mapping. */

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'walk' | 'interact'
  | 'attack' | 'block' | 'hot1' | 'hot2' | 'hot3' | 'hot4' | 'hot5' | 'hot6' | 'hot7' | 'hot8' | 'hot9' | 'hot0'
  | 'camera' | 'freecam' | 'target';

/** Default key code → action map. `target` (Tab) is rebindable from Settings → Controls. */
export const DEFAULT_KEYS: Readonly<Record<string, Action>> = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyC: 'crouch', ControlLeft: 'crouch', AltLeft: 'walk', KeyE: 'interact', KeyF: 'interact',
  Digit1: 'hot1', Digit2: 'hot2', Digit3: 'hot3', Digit4: 'hot4', Digit5: 'hot5', Digit6: 'hot6', Digit7: 'hot7', Digit8: 'hot8', Digit9: 'hot9', Digit0: 'hot0',
  KeyV: 'camera', F8: 'freecam', Tab: 'target',
};

/** Actions the player may move to another key (the rest are fixed). */
export const REBINDABLE: readonly Action[] = ['target'];

export class Input {
  private down = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  /** Actions whose press this frame came with Shift held (Shift+Tab cycles targets backwards). */
  private shifted = new Set<Action>();
  keys: Record<string, Action> = { ...DEFAULT_KEYS };
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  sensitivity = 0.0022;
  invertY = false;
  /** When false, gameplay input is ignored (UI panels open). */
  enabled = true;
  private locked = false;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      // Tab would move browser focus between buttons; it never does anything useful in the game.
      if (e.code === 'Tab') e.preventDefault();
      const a = this.keys[e.code];
      if (!a) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.enabled) return;
      if (!this.down.has(a)) {
        this.pressed.add(a);
        if (e.shiftKey) this.shifted.add(a);
      }
      this.down.add(a);
    });
    addEventListener('keyup', (e) => {
      const a = this.keys[e.code];
      if (!a) return;
      if (this.down.has(a)) this.released.add(a);
      this.down.delete(a);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) {
        this.lock();
        return;
      }
      const a: Action | null = e.button === 0 ? 'attack' : e.button === 2 ? 'block' : null;
      if (a) {
        this.pressed.add(a);
        this.down.add(a);
      }
    });
    addEventListener('mouseup', (e) => {
      const a: Action | null = e.button === 0 ? 'attack' : e.button === 2 ? 'block' : null;
      if (a && this.down.has(a)) {
        this.released.add(a);
        this.down.delete(a);
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
    });
    addEventListener('blur', () => this.releaseAll());
  }

  lock() {
    if (!this.enabled) return;
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => undefined);
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get isLocked() {
    return this.locked;
  }

  private releaseAll() {
    for (const a of this.down) this.released.add(a);
    this.down.clear();
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) {
      this.releaseAll();
      this.unlock();
    }
  }

  isDown(a: Action) {
    return this.enabled && this.down.has(a);
  }

  wasPressed(a: Action) {
    return this.enabled && this.pressed.has(a);
  }

  wasReleased(a: Action) {
    return this.released.has(a);
  }

  /** Pressed this frame together with Shift. */
  wasPressedShift(a: Action) {
    return this.enabled && this.pressed.has(a) && this.shifted.has(a);
  }

  /**
   * Move a rebindable action to another key code. Falls back to the default key when the code is
   * empty or already used by another action (gameplay keys must never silently disappear).
   */
  setBinding(a: Action, code: string | undefined) {
    if (!REBINDABLE.includes(a)) return;
    const def = Object.keys(DEFAULT_KEYS).find((k) => DEFAULT_KEYS[k] === a);
    const taken = (c: string) => this.keys[c] !== undefined && this.keys[c] !== a;
    const next = code && !taken(code) ? code : def;
    for (const k of Object.keys(this.keys)) if (this.keys[k] === a) delete this.keys[k];
    if (next && !taken(next)) this.keys[next] = a;
    if (this.down.delete(a)) this.released.add(a);
  }

  /** Key code currently bound to an action (first match). */
  bindingOf(a: Action): string | undefined {
    return Object.keys(this.keys).find((k) => this.keys[k] === a);
  }

  /** Call at end of frame. */
  endFrame() {
    this.pressed.clear();
    this.shifted.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
