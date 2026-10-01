/**
 * Lightweight frame profiler: per-section timings for every frame, plus a ring
 * buffer of slow frames with their breakdown. Main-thread work that happens
 * between frames (worker results, server messages) is attributed to the next
 * frame under "async:<label>".
 *
 * Inspect from the console: `norgo.prof.report()`.
 */
/** One main-thread freeze, with the browser's attribution (long-animation-frame API). */
export interface HitchEntry {
  /** Seconds since the session (game) started; negative = during loading. */
  t: number;
  ms: number;
  /** Time the main thread was blocked beyond 50 ms per task. */
  block: number;
  /** Heaviest scripts in that frame: duration, invoker, function@file:char. */
  scripts: string[];
  /** Style/layout forced by scripts (ms). */
  layout: number;
  /** Game frame breakdown of the slowest recent frame (if the freeze was inside a frame). */
  frame?: string;
}

const JOURNAL_KEY = 'norgo.hitches';

export class FrameProfiler {
  private cur = new Map<string, number>();
  private t0 = 0;
  private section = '';
  private sectionT = 0;
  /** Sum of section times across all frames (for averages). */
  private totals = new Map<string, number>();
  private frames = 0;
  /** Slow frames: total ms and the top contributors. */
  readonly slow: { t: number; ms: number; parts: [string, number][]; compiled?: string[] }[] = [];
  /** Shader programs first seen during the current frame (see notePrograms). */
  private compiled: string[] = [];
  private knownPrograms = new Set<string>();
  private programCount = -1;
  /** Threshold for logging slow frames (ms). */
  slowMs = 28;
  enabled = true;
  /** Print slow frames to the console as they happen. */
  log = new URLSearchParams(location.search).has('prof');
  /** Main-thread long tasks (>50 ms) reported by the browser, incl. ones between frames. */
  readonly longTasks: { t: number; ms: number }[] = [];
  /** Wall-clock gap between consecutive frames (catches stalls outside our code). */
  private lastBegin = 0;
  readonly gaps: { t: number; ms: number }[] = [];

  /**
   * Persistent hitch journal: every main-thread freeze ≥ 120 ms with script attribution,
   * kept across reloads in localStorage (`norgo.prof.hitches()`), so a bad start can be
   * diagnosed after the fact.
   */
  readonly journal: { session: string; startedAt: string; entries: HitchEntry[] } = { session: '', startedAt: '', entries: [] };
  private sessionT0 = performance.now();
  private saveTimer = 0;

  /** Start a new journal session (called when a game starts). */
  startSession(name: string) {
    this.journal.session = name;
    this.journal.startedAt = new Date().toISOString();
    this.journal.entries.length = 0;
    this.sessionT0 = performance.now();
    this.persist();
  }

  /** The journal of the current (or last) session, also readable after a reload. */
  hitches(): { session: string; startedAt: string; entries: HitchEntry[] } {
    if (this.journal.entries.length || this.journal.session) return this.journal;
    try {
      return JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? 'null') ?? this.journal;
    } catch {
      return this.journal;
    }
  }

  private persist() {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      try {
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(this.journal));
      } catch {
        /* storage unavailable */
      }
    }, 1500);
  }

  constructor() {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { blockingDuration?: number; scripts?: { duration: number; invoker?: string; sourceFunctionName?: string; sourceURL?: string; sourceCharPosition?: number; forcedStyleAndLayoutDuration?: number }[] })[]) {
          if (e.duration < 120) continue;
          const scripts = (e.scripts ?? []).slice().sort((a, b) => b.duration - a.duration);
          const last = this.slow[this.slow.length - 1];
          this.journal.entries.push({
            t: +((e.startTime - this.sessionT0) / 1000).toFixed(2),
            ms: Math.round(e.duration),
            block: Math.round(e.blockingDuration ?? 0),
            scripts: scripts.slice(0, 4).map((x) => `${Math.round(x.duration)}ms ${x.invoker ?? ''} ${x.sourceFunctionName || '?'}@${(x.sourceURL ?? '').split('/').pop()?.split('?')[0]}:${x.sourceCharPosition ?? -1}`),
            layout: Math.round(scripts.reduce((a, x) => a + (x.forcedStyleAndLayoutDuration ?? 0), 0)),
            frame: last && Math.abs(last.t * 1000 - (e.startTime + e.duration)) < 400 ? last.parts.map(([k, v]) => k + ':' + v).join(' ') : undefined,
          });
          if (this.journal.entries.length > 120) this.journal.entries.shift();
          this.persist();
        }
      });
      po.observe({ type: 'long-animation-frame', buffered: true });
    } catch {
      /* long-animation-frame unsupported */
    }
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.longTasks.push({ t: +(e.startTime / 1000).toFixed(1), ms: Math.round(e.duration) });
          if (this.longTasks.length > 100) this.longTasks.shift();
        }
      });
      po.observe({ type: 'longtask', buffered: false });
    } catch {
      /* longtask timing unsupported */
    }
  }

  beginFrame() {
    this.t0 = performance.now();
    if (this.lastBegin && this.t0 - this.lastBegin > 50 && !document.hidden) {
      this.gaps.push({ t: +(this.t0 / 1000).toFixed(1), ms: Math.round(this.t0 - this.lastBegin) });
      if (this.gaps.length > 100) this.gaps.shift();
    }
    this.lastBegin = this.t0;
  }

  /** Start timing a named section (ends the previous one). */
  mark(name: string) {
    if (!this.enabled) return;
    const now = performance.now();
    if (this.section) this.add(this.section, now - this.sectionT);
    this.section = name;
    this.sectionT = now;
  }

  /**
   * Record shader programs that appeared since the last call, so slow frames show
   * what was compiled in them. Cheap: only diffs when the program count changed.
   */
  notePrograms(programs: readonly { name: string; cacheKey: string }[] | undefined) {
    if (!programs || programs.length === this.programCount) return;
    const first = this.programCount < 0;
    this.programCount = programs.length;
    for (const pr of programs) {
      if (this.knownPrograms.has(pr.cacheKey)) continue;
      this.knownPrograms.add(pr.cacheKey);
      if (!first) this.compiled.push(pr.name || pr.cacheKey.split(',', 2).join(','));
    }
  }

  add(name: string, ms: number) {
    this.cur.set(name, (this.cur.get(name) ?? 0) + ms);
  }

  /** Wrap a callback that runs outside the frame (event handlers). */
  wrapAsync<A extends unknown[]>(label: string, fn: (...a: A) => void): (...a: A) => void {
    return (...a: A) => {
      const t = performance.now();
      try {
        fn(...a);
      } finally {
        this.add('async:' + label, performance.now() - t);
      }
    };
  }

  endFrame() {
    if (!this.enabled) return;
    this.mark('');
    const total = performance.now() - this.t0;
    this.frames++;
    let asyncMs = 0;
    for (const [k, v] of this.cur) {
      this.totals.set(k, (this.totals.get(k) ?? 0) + v);
      if (k.startsWith('async:')) asyncMs += v;
    }
    if (total + asyncMs > this.slowMs) {
      const parts = [...this.cur.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, +v.toFixed(1)] as [string, number]);
      const compiled = this.compiled.length ? this.compiled.slice() : undefined;
      this.slow.push({ t: +(performance.now() / 1000).toFixed(1), ms: +(total + asyncMs).toFixed(1), parts, compiled });
      if (this.log) console.warn('[hitch]', (total + asyncMs).toFixed(0) + 'ms', parts.map(([k, v]) => k + ':' + v).join(' '), compiled ? 'compiled: ' + compiled.join(' | ') : '');
      if (this.slow.length > 60) this.slow.shift();
    }
    this.cur.clear();
    this.compiled.length = 0;
  }

  /** Averages per frame (ms) and the recent slow frames. */
  report() {
    const avg: Record<string, number> = {};
    for (const [k, v] of [...this.totals.entries()].sort((a, b) => b[1] - a[1])) avg[k] = +(v / Math.max(1, this.frames)).toFixed(2);
    return { frames: this.frames, avg, slow: this.slow.slice(-20), longTasks: this.longTasks.slice(-20), gaps: this.gaps.slice(-20) };
  }

  reset() {
    this.totals.clear();
    this.frames = 0;
    this.slow.length = 0;
    this.longTasks.length = 0;
    this.gaps.length = 0;
  }
}
