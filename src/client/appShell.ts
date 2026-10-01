/**
 * App shell: everything about running as an app on a tablet/phone rather than a page.
 *
 *  - Lifecycle: one `background` / `foreground` signal from visibilitychange, pagehide /
 *    pageshow (iOS Safari, bfcache) and freeze / resume (Chromium), de-duplicated.
 *  - Screen Wake Lock while the game wants it (playing, visible, no menu open); the browser
 *    drops the lock when the page is hidden, so it is re-requested on return. Needs a secure
 *    context (https or localhost): on a LAN dev server over http it is simply unavailable.
 *  - Fullscreen: standard or webkit-prefixed element fullscreen on the first touch of a
 *    touch-first device (needs a user gesture). iPhone Safari has no element fullscreen and
 *    some iPadOS versions only the prefixed API; where neither works and the game isn't
 *    installed, a one-time hint recommends "Add to Home Screen" (runs fullscreen from there).
 *  - Orientation: a "rotate to landscape" overlay on touch-first devices in portrait (pure
 *    CSS, see styles/platform.css), plus a landscape lock where the browser allows it
 *    (Android in fullscreen; iOS has no lock API).
 *
 * The DOM it adds is styled by `src/ui/styles/platform.css`.
 */
import { platform, DEBUG_CAPS } from '../core/platform';

type Listener = () => void;

interface WakeLockSentinelLike extends EventTarget {
  released: boolean;
  release(): Promise<void>;
}

const HINT_KEY = 'norgo.shell.a2hsHint';

class AppShell {
  private installed = false;
  private hidden = false;
  private bg = new Set<Listener>();
  private fg = new Set<(awayMs: number) => void>();
  private hiddenAt = 0;
  private wantAwake = false;
  private lock: WakeLockSentinelLike | null = null;
  private lockPending = false;
  private lockRetryAt = 0;
  /** Diagnostics. */
  readonly state = { wakeLock: 'idle' as string, fullscreen: 'idle' as string, backgrounds: 0 };

  /** Install the global listeners and the orientation overlay (once, from main.ts). */
  install(): void {
    if (this.installed || typeof document === 'undefined') return;
    this.installed = true;
    this.hidden = document.hidden;
    const toBg = () => this.setHidden(true);
    const toFg = () => {
      if (!document.hidden) this.setHidden(false);
    };
    document.addEventListener('visibilitychange', () => (document.hidden ? toBg() : toFg()));
    addEventListener('pagehide', toBg);
    addEventListener('pageshow', toFg);
    document.addEventListener('freeze', toBg);
    document.addEventListener('resume', toFg);
    this.addOrientationOverlay();
    // Safari's own pinch events: iOS ignores user-scalable=no, so page zoom is stopped here
    // (touch-action: none in platform.css covers the rest; text inputs are unaffected).
    for (const g of ['gesturestart', 'gesturechange']) document.addEventListener(g, (e) => e.preventDefault(), { passive: false });
    if (platform.touchFirst && !platform.info.standalone) {
      // Fullscreen needs a gesture: try on the first tap (pointerup/touchend count as activation).
      const tryFs = () => {
        removeEventListener('pointerup', tryFs, true);
        removeEventListener('touchend', tryFs, true);
        void this.enterFullscreen();
      };
      addEventListener('pointerup', tryFs, { capture: true, passive: true });
      addEventListener('touchend', tryFs, { capture: true, passive: true });
    }
    platform.note('shell', this.state);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Called once each time the app goes to the background (hidden, page hide, freeze). */
  onBackground(fn: Listener): () => void {
    this.bg.add(fn);
    return () => this.bg.delete(fn);
  }

  /** Called once each time the app returns, with the time it was away (ms). */
  onForeground(fn: (awayMs: number) => void): () => void {
    this.fg.add(fn);
    return () => this.fg.delete(fn);
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  private setHidden(h: boolean) {
    if (h === this.hidden) return;
    this.hidden = h;
    if (h) {
      this.hiddenAt = performance.now();
      this.state.backgrounds++;
      for (const f of [...this.bg]) f();
      // The browser releases the wake lock on hide; forget ours so it is re-requested on return.
      this.lock = null;
    } else {
      const away = performance.now() - this.hiddenAt;
      for (const f of [...this.fg]) f(away);
      this.syncWakeLock();
    }
  }

  // ---------------------------------------------------------------- wake lock

  /** Whether the screen should stay on (the game calls this every frame; acts on changes). */
  setAwake(want: boolean): void {
    if (want !== this.wantAwake) {
      this.wantAwake = want;
      this.syncWakeLock();
      return;
    }
    // Same wish: only re-acquire when the lock was dropped (system release) after any back-off.
    if (want && !this.lock && !this.lockPending && !this.hidden && this.wakeLockSupported && performance.now() >= this.lockRetryAt) this.syncWakeLock();
  }

  get wakeLockSupported(): boolean {
    return !DEBUG_CAPS.has('nowakelock') && typeof navigator !== 'undefined' && 'wakeLock' in navigator && window.isSecureContext;
  }

  private syncWakeLock() {
    if (!this.wakeLockSupported) {
      this.state.wakeLock = window.isSecureContext ? 'unsupported' : 'unsupported (insecure context)';
      return;
    }
    if (this.wantAwake && !this.hidden && !this.lock && !this.lockPending && performance.now() >= this.lockRetryAt) {
      this.lockPending = true;
      (navigator as unknown as { wakeLock: { request(t: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock
        .request('screen')
        .then((s) => {
          this.lockPending = false;
          if (!this.wantAwake || this.hidden) {
            void s.release().catch(() => undefined);
            return;
          }
          this.lock = s;
          this.state.wakeLock = 'held';
          s.addEventListener('release', () => {
            if (this.lock === s) this.lock = null;
            this.state.wakeLock = 'released';
          });
        })
        .catch((e: Error) => {
          // NotAllowedError (battery saver, not visible…): try again a little later, not every frame.
          this.lockPending = false;
          this.lockRetryAt = performance.now() + 15000;
          this.state.wakeLock = 'refused: ' + (e?.name ?? 'error');
        });
    } else if ((!this.wantAwake || this.hidden) && this.lock) {
      const s = this.lock;
      this.lock = null;
      void s.release().catch(() => undefined);
      this.state.wakeLock = 'released';
    }
  }

  // ---------------------------------------------------------------- fullscreen

  /** Element fullscreen (standard or webkit-prefixed) is available. */
  get fullscreenSupported(): boolean {
    if (DEBUG_CAPS.has('nofullscreen') || typeof document === 'undefined') return false;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: unknown };
    return !!(document.fullscreenEnabled || (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled)
      && (typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function');
  }

  get isFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenElement?: Element | null };
    return !!(d.fullscreenElement ?? d.webkitFullscreenElement) || platform.info.standalone;
  }

  /** Enter fullscreen (call from a user gesture). Falls back to the Add-to-Home-Screen hint. */
  async enterFullscreen(): Promise<boolean> {
    if (this.isFullscreen) return true;
    if (!this.fullscreenSupported) {
      this.state.fullscreen = 'unsupported';
      this.showInstallHint();
      return false;
    }
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    try {
      if (typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' });
      else await el.webkitRequestFullscreen!();
      this.state.fullscreen = 'on';
      // Landscape lock: Android Chrome in fullscreen; iOS has no lock API (rejects or is missing).
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await o?.lock?.('landscape').catch(() => undefined);
      return true;
    } catch (e) {
      this.state.fullscreen = 'refused: ' + ((e as Error)?.name ?? 'error');
      this.showInstallHint();
      return false;
    }
  }

  async exitFullscreen(): Promise<void> {
    const d = document as Document & { webkitExitFullscreen?: () => void; webkitFullscreenElement?: Element | null };
    try {
      if (d.fullscreenElement) await d.exitFullscreen();
      else if (d.webkitFullscreenElement) d.webkitExitFullscreen?.();
    } catch {
      /* not in fullscreen */
    }
  }

  /** One-time tip for iPhone/iPad Safari: install to the home screen for fullscreen play. */
  private showInstallHint() {
    if (!platform.info.ios || platform.info.standalone) return;
    try {
      if (localStorage.getItem(HINT_KEY)) return;
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* storage blocked: show it anyway (once per session) */
    }
    if (document.querySelector('.np-hint')) return;
    const el = document.createElement('div');
    el.className = 'np-hint';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>For full-screen play, tap <b>Share</b> and choose <b>Add to Home Screen</b>.</span><button type="button" aria-label="Dismiss">✕</button>';
    el.querySelector('button')!.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 14000);
  }

  // ---------------------------------------------------------------- orientation

  /** "Rotate to landscape" overlay; shown by CSS only on touch-first devices in portrait. */
  private addOrientationOverlay() {
    const el = document.createElement('div');
    el.className = 'np-rotate';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="np-rotate-icon" aria-hidden="true"></div><div class="np-rotate-text">Rotate your device to landscape</div>';
    document.body.appendChild(el);
  }
}

/** The app-shell singleton (installed by main.ts). */
export const appShell = new AppShell();
