/**
 * StemMusic — the adaptive stem layer of Norgo's score.
 *
 * Plays pre-generated, beat-synchronised loops (tools/music/build_stems.py →
 * public/assets/audio/music/) and mixes them live from game state, on top of /
 * in place of parts of the generative MusicDirector:
 *
 *   layer source (loop, whole buffer) → layer gain ┐
 *   … 4 layers per set (drone/texture/melody/perc) ┴→ slot gain (crossfade) ┐
 *   up to 3 slots (active + fading + spare) ─────────────────────────────────┴→ stem bus → lowpass → engine music bus
 *
 *  - Manifest loaded once (graceful no-op when missing/malformed); buffers are
 *    fetched + decoded lazily (only the chosen variation of each layer), the most
 *    likely next sets are preloaded, at most MAX_SETS sets stay resident (LRU).
 *  - All layers of a set share one timeline (t0 + offset): late-loading layers
 *    join phase-aligned, so locked layers (texture, perc) never drift apart.
 *  - Set changes crossfade (exploration ≈5–7 s, combat entry ≈1.2 s on the next
 *    beat of the current set, combat exit ≈6 s after the selector's hold).
 *  - Layers: drone = bed, texture mostly on, melody in phrases (1–2 loops on,
 *    a while off, new variation each entry), perc by context (sparse + movement
 *    when exploring, mostly on in settlements, full in combat).
 *  - Exploration music respects the MusicDirector's episodes (silences); combat
 *    and boss always play.
 * Routing tables, hysteresis and the tuning policy live in `stemRouting.ts`.
 */
import type { AudioEngine } from './engine';
import type { ScoreAccompaniment } from './music';
import {
  StemSelector, StemManifest, StemSetInfo, StemLayer, StemContext, StemCategory, StemTuningPolicy, StemWorldFlavor,
  STEM_LAYERS, parseManifest, categoryOfSet, preferredVariation, RACE_STEM_SET, SPECIAL_SETS,
} from './stemRouting';

/** Resident decoded sets (≈15 MB per 38 s stereo stem → a full set is 60–90 MB). */
const MAX_SETS = 3;
/** Hard cap on decoded bytes (melody variations accumulate). */
const MAX_BYTES = 240 * 1024 * 1024;
const MAX_MELODY_RESIDENT = 2;
const MAX_LOADS = 2;
/** Overall stem level into the music bus (stems are loudness-normalised to ≈ −21 dBFS RMS per layer). */
const STEM_LEVEL = 0.85;
const LOOKAHEAD = 0.06;
const MANIFEST_RETRY = 120;

const L_DRONE = 0, L_TEX = 1, L_MEL = 2, L_PERC = 3;

/** Per-category mix: layer levels, perc behaviour and generative accent level. */
interface Mix {
  drone: number;
  texture: number;
  melody: number;
  /** Perc level when its gate is open (settlements/combat) … */
  perc: number;
  /** … probability per loop that the gate opens (1 = always). */
  percChance: number;
  /** Extra perc from player movement (exploration). */
  percMove: number;
  /** Chance per loop that the texture drops out for a loop. */
  texRest: number;
  /** Melody: first entry after (loops), on for (loops), off for (s). */
  melFirst: [number, number];
  melLoops: [number, number];
  melOff: [number, number];
  /** Generative lead/bells level while this set plays (pitched policy). */
  accent: number;
  fadeIn: number;
  /** Bars before the texture joins the drone (build-up). */
  texDelayBars: number;
}
const M = (o: Partial<Mix>): Mix => ({
  drone: 0.85, texture: 0.7, melody: 0.7, perc: 0.5, percChance: 0.3, percMove: 0.5, texRest: 0.2,
  melFirst: [0.5, 1.1], melLoops: [1, 2], melOff: [45, 100], accent: 0.55, fadeIn: 6, texDelayBars: 2, ...o,
});
const MIX: Record<StemCategory, Mix> = {
  explore: M({}),
  night: M({ texture: 0.6, melody: 0.6, perc: 0.35, percChance: 0.15, percMove: 0.3, accent: 0.5, melOff: [55, 110] }),
  cave: M({ drone: 0.9, texture: 0.6, melody: 0.55, perc: 0.4, percChance: 0.25, percMove: 0.3, accent: 0.45 }),
  under: M({ drone: 0.9, texture: 0.65, melody: 0.6, perc: 0.4, percChance: 0.25, percMove: 0.3, accent: 0.45 }),
  settlement: M({ drone: 0.75, texture: 0.8, melody: 0.65, perc: 0.7, percChance: 0.85, percMove: 0, texRest: 0.12, melFirst: [0.3, 0.6], melOff: [30, 60], accent: 0.3, fadeIn: 4, texDelayBars: 1 }),
  combat: M({ drone: 0.8, texture: 0.9, melody: 0.75, perc: 1, percChance: 1, percMove: 0, texRest: 0, melFirst: [0.1, 0.25], melLoops: [2, 3], melOff: [8, 16], accent: 0, fadeIn: 1.2, texDelayBars: 0 }),
  boss: M({ drone: 0.9, texture: 1, melody: 0.8, perc: 1, percChance: 1, percMove: 0, texRest: 0, melFirst: [0.05, 0.1], melLoops: [3, 4], melOff: [7, 12], accent: 0, fadeIn: 1.5, texDelayBars: 0 }),
};

interface BufEntry {
  path: string;
  set: string;
  state: 'queued' | 'loading' | 'ready' | 'error';
  buffer: AudioBuffer | null;
  bytes: number;
  lastUse: number;
  /** Lower = sooner. */
  prio: number;
  retryAt: number;
}

interface LayerSlot {
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  path: string | null;
  applied: number;
}

interface Slot {
  out: GainNode;
  set: StemSetInfo | null;
  category: StemCategory;
  layers: LayerSlot[];
  state: 'idle' | 'live' | 'fading';
  t0: number;
  /** Buffer position (s) at t0. */
  offset: number;
  fadeEnd: number;
  loopIdx: number;
  texOn: boolean;
  texAt: number;
  percGate: boolean;
  melOn: boolean;
  melNext: number;
  melEnd: number;
  melFree: number;
  outTarget: number;
}

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();

function musicBase(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return base + 'assets/audio/music/';
}

export interface StemStatus {
  enabled: boolean;
  policy: StemTuningPolicy;
  manifest: 'loading' | 'ready' | 'missing' | 'idle';
  sets: string[];
  rate: number;
  semitones: number;
  context: string | null;
  raw: string | null;
  target: string | null;
  forced: string | null;
  active: null | { set: string; category: StemCategory; t0: number; layers: Record<StemLayer, { gain: number; file: string | null }> };
  fading: string[];
  resident: { set: string; files: number; mb: number }[];
  loading: string[];
  queued: number;
}

export class StemMusic {
  /** User setting ("Adaptive score"); false = generative only. */
  enabled = true;
  /** Debug: force a set (always plays, ignores episodes). */
  forced: string | null = null;
  readonly selector: StemSelector;
  /** Filled every update for the MusicDirector. */
  readonly acc: ScoreAccompaniment;
  private manifest: StemManifest | null = null;
  private manifestState: 'idle' | 'loading' | 'ready' | 'missing' = 'idle';
  private manifestAt = -1e9;
  private manifestTries = 0;
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private lp!: BiquadFilterNode;
  private lpApplied = 0;
  private slots: Slot[] = [];
  private active: Slot | null = null;
  private target: string | null = null;
  private waitT = 0;
  private bufs = new Map<string, BufEntry>();
  private loading = 0;
  /** Something may be queued (lets pump() skip the map scan on idle frames). */
  private queueDirty = false;
  private preloadIds: string[] = [];
  private preloadTimer = 0;
  private move = 0;
  private clock = 0;
  private suppressUntil = 0;
  private readonly hasFn = (id: string) => this.has(id);

  constructor(private engine: AudioEngine, readonly flavor: StemWorldFlavor, readonly policy: StemTuningPolicy) {
    this.selector = new StemSelector(flavor);
    this.acc = { active: false, pitched: false, perc: false, rootHz: 220, scale: [0, 200, 400, 500, 700, 900, 1100], accent: 0, leadGate: 1, gridT0: 0, beatDur: 0, beatsPerBar: 4 };
    this.loadManifest();
  }

  // ================================================================ manifest & buffers

  /** (Re)load the manifest. Safe to call any time; never throws. */
  loadManifest(): void {
    if (this.manifestState === 'loading' || typeof fetch === 'undefined') return;
    this.manifestState = 'loading';
    this.manifestAt = this.clock;
    this.manifestTries++;
    fetch(musicBase() + 'manifest.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const m = parseManifest(j);
        // Keep a previously good manifest if a refresh comes back broken (file mid-write).
        if (m) this.manifest = m;
        this.manifestState = this.manifest ? 'ready' : 'missing';
      })
      .catch(() => {
        // 404 / dev-server HTML fallback / malformed JSON: the game simply runs without stems.
        this.manifestState = this.manifest ? 'ready' : 'missing';
      });
  }

  private setInfo(id: string): StemSetInfo | null {
    return this.manifest?.sets[id] ?? null;
  }

  /** Can this set be played under the tuning policy (and hasn't it failed)? */
  has(id: string): boolean {
    const s = this.setInfo(id);
    if (!s) return false;
    if (this.policy === 'perc') return this.pathFor(s, 'perc') !== null;
    return this.pathFor(s, 'drone') !== null;
  }

  /** Chosen file for a layer: the world's preferred variation, skipping failed files. */
  private pathFor(s: StemSetInfo, layer: StemLayer): string | null {
    const list = s.layers[layer];
    const n = list.length;
    if (!n) return null;
    const pref = preferredVariation(this.flavor, s.id, layer, n);
    for (let i = 0; i < n; i++) {
      const p = list[(pref + i) % n];
      const e = this.bufs.get(p);
      if (!e || e.state !== 'error' || e.retryAt <= this.clock) return p;
    }
    return null;
  }

  /** Layers this policy plays. */
  private wants(layer: number): boolean {
    return this.policy === 'full' || layer === L_PERC;
  }

  private request(set: string, path: string, prio: number): BufEntry {
    let e = this.bufs.get(path);
    if (!e) {
      e = { path, set, state: 'queued', buffer: null, bytes: 0, lastUse: this.clock, prio, retryAt: 0 };
      this.bufs.set(path, e);
      this.queueDirty = true;
    } else {
      if (e.state === 'error' && e.retryAt <= this.clock) {
        e.state = 'queued';
        this.queueDirty = true;
      }
      if (prio < e.prio) e.prio = prio;
      e.lastUse = this.clock;
    }
    return e;
  }

  private ready(path: string | null): AudioBuffer | null {
    if (!path) return null;
    const e = this.bufs.get(path);
    if (!e || e.state !== 'ready') return null;
    e.lastUse = this.clock;
    return e.buffer;
  }

  /** Queue the start layers of a set; returns true when it can start. */
  private ensureSet(id: string, prio: number): boolean {
    const s = this.setInfo(id);
    if (!s) return false;
    let ok = true;
    for (let l = 0; l < 4; l++) {
      if (!this.wants(l)) continue;
      const layer = STEM_LAYERS[l];
      const p = this.pathFor(s, layer);
      if (!p) {
        if (l === L_DRONE && this.policy === 'full') return false;
        continue;
      }
      // Melody is not needed to start (it enters later); it loads at a lower priority.
      const e = this.request(id, p, l === L_MEL ? prio + 1 : prio);
      if (l !== L_MEL && e.state !== 'ready' && e.state !== 'error') ok = false;
    }
    if (this.policy === 'full') return ok && this.ready(this.pathFor(s, 'drone')) !== null;
    return ok && this.ready(this.pathFor(s, 'perc')) !== null;
  }

  private pump() {
    const ctx = this.ctx;
    if (!ctx || !this.queueDirty) return;
    while (this.loading < MAX_LOADS) {
      let best: BufEntry | null = null;
      for (const e of this.bufs.values()) if (e.state === 'queued' && (!best || e.prio < best.prio)) best = e;
      if (!best) {
        this.queueDirty = false;
        return;
      }
      const e = best;
      e.state = 'loading';
      this.loading++;
      fetch(musicBase() + e.path)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => {
          if (this.bufs.get(e.path) !== e) return; // evicted meanwhile
          e.buffer = buf;
          e.bytes = buf.length * buf.numberOfChannels * 4;
          e.state = 'ready';
          const s = this.setInfo(e.set);
          if (s && Math.abs(buf.duration - s.loopSeconds) > 0.005) {
            console.warn(`[stems] ${e.path}: ${buf.duration.toFixed(4)} s ≠ loop ${s.loopSeconds} s (looping on the manifest length)`);
          }
        })
        .catch((err: unknown) => {
          if (this.bufs.get(e.path) !== e) return;
          e.state = 'error';
          e.retryAt = this.clock + 60;
          console.warn(`[stems] ${e.path} failed: ${(err as Error)?.message ?? err}`);
        })
        .finally(() => {
          this.loading--;
          this.evict();
        });
    }
  }

  /** LRU eviction by set (protected: playing, fading, target and preload sets). */
  private evict() {
    const use = new Map<string, number>();
    let bytes = 0;
    for (const e of this.bufs.values()) {
      if (e.state !== 'ready' && e.state !== 'loading') continue;
      use.set(e.set, Math.max(use.get(e.set) ?? -1e9, e.lastUse));
      bytes += e.bytes;
    }
    const prot = new Set<string>();
    for (const s of this.slots) if (s.state !== 'idle' && s.set) prot.add(s.set.id);
    if (this.forced) prot.add(this.forced);
    if (this.target) prot.add(this.target);
    for (const p of this.preloadIds) prot.add(p);
    while (use.size > MAX_SETS || bytes > MAX_BYTES) {
      let victim: string | null = null;
      let t = Infinity;
      for (const [id, lu] of use) if (!prot.has(id) && lu < t) {
        t = lu;
        victim = id;
      }
      if (!victim) break;
      use.delete(victim);
      for (const [p, e] of this.bufs) if (e.set === victim) {
        bytes -= e.bytes;
        this.bufs.delete(p);
      }
    }
  }

  /** Keep at most MAX_MELODY_RESIDENT melody buffers per set (drop the LRU idle one). */
  private trimMelodies(s: StemSetInfo, keep: string) {
    let n = 0;
    let lru: BufEntry | null = null;
    for (const p of s.layers.melody) {
      const e = this.bufs.get(p);
      if (!e || e.state === 'error') continue;
      n++;
      const playing = this.slots.some((sl) => sl.layers[L_MEL].path === p && sl.layers[L_MEL].src);
      if (p !== keep && !playing && (!lru || e.lastUse < lru.lastUse)) lru = e;
    }
    if (n > MAX_MELODY_RESIDENT && lru) this.bufs.delete(lru.path);
  }

  // ================================================================ graph

  private ensureGraph(): boolean {
    const ctx = this.engine.ctx;
    if (!ctx) return false;
    if (this.ctx === ctx) return true;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = STEM_LEVEL;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 18000;
    this.lp.Q.value = 0.5;
    this.lpApplied = 18000;
    this.bus.connect(this.lp);
    this.lp.connect(this.engine.bus.music);
    this.slots = [];
    for (let i = 0; i < 3; i++) {
      const out = ctx.createGain();
      out.gain.value = 0;
      out.connect(this.bus);
      const layers: LayerSlot[] = [];
      for (let l = 0; l < 4; l++) {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(out);
        layers.push({ gain: g, src: null, path: null, applied: 0 });
      }
      this.slots.push({
        out, set: null, category: 'explore', layers, state: 'idle', t0: 0, offset: 0, fadeEnd: 0, loopIdx: 0,
        texOn: false, texAt: 0, percGate: false, melOn: false, melNext: 0, melEnd: 0, melFree: 0, outTarget: 0,
      });
    }
    this.active = null;
    return true;
  }

  // ================================================================ timeline helpers

  /** Buffer position (s) of a slot's timeline at context time t. */
  private posAt(s: Slot, t: number): number {
    const L = s.set!.loopSeconds;
    const p = (s.offset + (t - s.t0) * this.flavor.rate) % L;
    return p < 0 ? p + L : p;
  }

  private beatDur(s: StemSetInfo): number {
    return 60 / (s.bpm * this.flavor.rate);
  }

  /** Is the set beat-locked (has texture or perc)? */
  private locked(s: StemSetInfo): boolean {
    return s.layers.texture.length > 0 || s.layers.perc.length > 0;
  }

  /** Next grid time (beat or bar) of a live slot at/after t. */
  private nextGrid(s: Slot, t: number, bars: boolean): number {
    const set = s.set!;
    const step = this.beatDur(set) * (bars ? set.beatsPerBar : 1);
    const g0 = s.t0 - s.offset / this.flavor.rate;
    return g0 + Math.ceil((t - g0) / step - 1e-6) * step;
  }

  private startSource(s: Slot, l: number, buf: AudioBuffer, path: string, when: number, pos: number) {
    const ctx = this.ctx!;
    const ls = s.layers[l];
    this.stopSource(ls, when);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const L = s.set!.loopSeconds;
    // Files are exactly loopSeconds long; guard against decoder padding so layers never drift.
    if (buf.duration - L > 0.0005) {
      src.loopStart = 0;
      src.loopEnd = L;
    }
    src.playbackRate.value = this.flavor.rate;
    src.connect(ls.gain);
    src.onended = () => src.disconnect();
    src.start(when, Math.min(pos, Math.max(0, buf.duration - 0.001)));
    ls.src = src;
    ls.path = path;
  }

  private stopSource(ls: LayerSlot, at: number) {
    if (!ls.src) return;
    try {
      ls.src.stop(Math.max(at, this.ctx!.currentTime));
    } catch {
      /* already stopped */
    }
    ls.src = null;
    ls.path = null;
  }

  private setGain(ls: LayerSlot, v: number, at: number, tc: number) {
    if (Math.abs(v - ls.applied) < 0.004) return;
    ls.applied = v;
    ls.gain.gain.setTargetAtTime(v, at, tc);
  }

  // ================================================================ slots

  private freeSlot(): Slot {
    const sl = this.slots;
    for (let i = 0; i < sl.length; i++) if (sl[i].state === 'idle') return sl[i];
    // All busy (rapid changes): recycle the fading slot that ends first.
    let best: Slot | null = null;
    for (let i = 0; i < sl.length; i++) if (sl[i] !== this.active && (!best || sl[i].fadeEnd < best.fadeEnd)) best = sl[i];
    this.kill(best!);
    return best!;
  }

  private kill(s: Slot) {
    const now = this.ctx!.currentTime;
    s.out.gain.cancelScheduledValues(now);
    s.out.gain.setValueAtTime(0, now);
    for (let l = 0; l < 4; l++) {
      const ls = s.layers[l];
      this.stopSource(ls, now);
      ls.gain.gain.cancelScheduledValues(now);
      ls.gain.gain.setValueAtTime(0, now);
      ls.applied = 0;
    }
    s.state = 'idle';
    s.set = null;
    if (this.active === s) this.active = null;
  }

  private fadeOut(s: Slot, fade: number, at?: number) {
    if (s.state !== 'live') return;
    const now = this.ctx!.currentTime;
    const t = Math.max(now, at ?? now);
    s.out.gain.setTargetAtTime(0, t, fade / 3.5);
    s.outTarget = 0;
    s.state = 'fading';
    s.fadeEnd = t + fade * 1.6 + 0.2;
    if (this.active === s) this.active = null;
  }

  private startSet(id: string, when: number, fadeIn: number) {
    const set = this.setInfo(id)!;
    const s = this.freeSlot();
    const cat = categoryOfSet(id);
    const mix = MIX[cat];
    const now = this.ctx!.currentTime;
    s.set = set;
    s.category = cat;
    s.state = 'live';
    s.t0 = when;
    // Exploration enters at a random bar (variety); combat/boss on the loop's downbeat.
    const barSec = (set.beatsPerBar * 60) / set.bpm;
    const bars = Math.max(1, Math.floor(set.loopSeconds / barSec + 1e-6));
    s.offset = cat === 'combat' || cat === 'boss' ? 0 : Math.min(set.loopSeconds - 0.01, Math.floor(R() * bars) * barSec);
    s.loopIdx = Math.floor(s.offset / set.loopSeconds);
    const loopReal = set.loopSeconds / this.flavor.rate;
    const barReal = barSec / this.flavor.rate;
    s.texOn = true;
    s.texAt = when + mix.texDelayBars * barReal;
    s.percGate = cat === 'combat' || cat === 'boss' || cat === 'settlement' ? R() < mix.percChance : R() < mix.percChance * 0.5;
    s.melOn = false;
    s.melNext = when + rr(mix.melFirst[0], mix.melFirst[1]) * loopReal;
    s.melEnd = 0;
    s.melFree = 0;
    for (let l = 0; l < 4; l++) {
      const ls = s.layers[l];
      ls.gain.gain.cancelScheduledValues(now);
      ls.gain.gain.setValueAtTime(0, now);
      ls.applied = 0;
      if (l === L_MEL || !this.wants(l)) continue;
      const p = this.pathFor(set, STEM_LAYERS[l]);
      const buf = this.ready(p);
      if (buf && p) this.startSource(s, l, buf, p, when, s.offset);
    }
    s.out.gain.cancelScheduledValues(now);
    s.out.gain.setValueAtTime(0, now);
    s.out.gain.setTargetAtTime(1, when, fadeIn / 3.5);
    s.outTarget = 1;
    this.active = s;
  }

  // ================================================================ update

  /**
   * Per-frame update. `c` is the shared context object (not retained).
   * Never allocates on the steady-state path.
   */
  update(dt: number, c: StemContext): void {
    this.clock += dt;
    if (this.manifestState === 'idle') this.loadManifest();
    const sel = this.selector;
    const context = sel.update(dt, c, this.hasFn);
    // Sets appear progressively while the pipeline runs: re-check the manifest now and then.
    if (sel.wantedMissing && this.manifestState === 'ready' && this.clock - this.manifestAt > MANIFEST_RETRY && this.manifestTries < 40) this.loadManifest();
    const acc = this.acc;
    if (!this.engine.running || !this.ensureGraph()) {
      acc.active = false;
      return;
    }
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    this.move += (c.move - this.move) * (1 - Math.exp(-dt * (c.move > this.move ? 0.5 : 0.2)));

    // ---- what should play
    let want: string | null = null;
    if (this.enabled && this.manifest) {
      if (this.forced && this.setInfo(this.forced)) want = this.forced;
      else if (context !== null && this.clock >= this.suppressUntil) {
        const cat = sel.category;
        const urgent = cat === 'combat' || cat === 'boss';
        // Perc-only worlds use stems where rhythm carries the scene; exploration stays generative.
        const percOk = this.policy === 'full' || urgent || cat === 'settlement';
        if (percOk && (urgent || c.episode)) want = context;
      }
    }
    this.transition(want, now, dt);

    // ---- preloading (once a second, cheap)
    this.preloadTimer -= dt;
    if (this.preloadTimer <= 0) {
      this.preloadTimer = 1;
      this.updatePreloads(c);
      this.evict();
    }
    this.pump();

    // ---- retire finished slots
    const sl = this.slots;
    for (let i = 0; i < sl.length; i++) if (sl[i].state === 'fading' && now >= sl[i].fadeEnd) this.kill(sl[i]);

    // ---- live mix
    const a = this.active;
    if (a && a.set) this.mix(a, c, now);
    this.shape(c, now);
    this.fillAccompaniment(now);
  }

  private transition(want: string | null, now: number, dt: number) {
    const a = this.active;
    const cur = a?.set?.id ?? null;
    if (want !== this.target) {
      this.target = want;
      this.waitT = 0;
    }
    if (want === cur) return;
    if (want === null) {
      // Episode ended / context without stems: slow fade (combat exit gets the same breath).
      if (a) this.fadeOut(a, a.category === 'combat' || a.category === 'boss' ? 6 : 7);
      return;
    }
    const cat = categoryOfSet(want);
    const urgent = cat === 'combat' || cat === 'boss';
    this.waitT += dt;
    if (!this.ensureSet(want, 0)) {
      // Not decoded yet. For combat, don't keep a calm set running meanwhile: the generative
      // score carries the fight until the stems are ready.
      if (urgent && a && this.waitT > 0.6) this.fadeOut(a, 2.5);
      return;
    }
    const mix = MIX[cat];
    let when = now + LOOKAHEAD;
    if (urgent && a && a.set && this.locked(a.set) && now >= a.t0) {
      // Enter on the next beat of the current (beat-locked) set.
      when = this.nextGrid(a, now + LOOKAHEAD, false);
    }
    const fromCat = a?.category;
    const fadeIn = !a ? mix.fadeIn : urgent ? mix.fadeIn : fromCat === 'combat' || fromCat === 'boss' ? 6 : 5;
    const fadeOutT = urgent ? 1.5 : fromCat === 'combat' || fromCat === 'boss' ? 6 : 6;
    if (a) this.fadeOut(a, fadeOutT, when);
    this.startSet(want, when, fadeIn);
  }

  private updatePreloads(c: StemContext) {
    const ids = this.preloadIds;
    ids.length = 0;
    if (!this.enabled || !this.manifest) return;
    const cat = this.selector.category;
    if (cat !== 'combat' && cat !== 'boss' && this.has(SPECIAL_SETS.combat)) ids.push(SPECIAL_SETS.combat);
    if (this.policy === 'full') {
      let next: string | null = null;
      if (c.boss && this.has(SPECIAL_SETS.boss)) next = SPECIAL_SETS.boss;
      else if (c.settlement > 0.04 && c.siteRace && cat !== 'settlement') next = RACE_STEM_SET[c.siteRace] ?? null;
      else if (c.cave > 0.15 && cat !== 'cave' && c.underworld < 0.5) next = SPECIAL_SETS.cave;
      else if (c.day < 0.6 && c.day > 0.2 && cat === 'explore') next = SPECIAL_SETS.night;
      if (next && this.has(next) && next !== this.target) ids.push(next);
    } else if (c.settlement > 0.04 && c.siteRace) {
      const r = RACE_STEM_SET[c.siteRace];
      if (r && this.has(r)) ids.push(r);
    }
    // Don't let preloads compete with an unstarted target.
    for (let i = 0; i < ids.length; i++) this.ensureSet(ids[i], 2);
  }

  /** Layer targets for the active slot (the adaptive part). */
  private mix(s: Slot, c: StemContext, now: number) {
    const set = s.set!;
    const mix = MIX[s.category];
    const urgent = s.category === 'combat' || s.category === 'boss';
    const loopReal = set.loopSeconds / this.flavor.rate;
    const pitched = this.policy === 'full';

    // Loop boundary decisions (texture rests, perc phrases).
    if (now >= s.t0) {
      const li = Math.floor((s.offset + (now - s.t0) * this.flavor.rate) / set.loopSeconds);
      if (li !== s.loopIdx) {
        s.loopIdx = li;
        if (s.texOn) s.texOn = R() >= mix.texRest;
        else s.texOn = R() < 0.75;
        s.percGate = R() < mix.percChance;
      }
    }

    // Late-loading layers join phase-aligned.
    for (let l = 0; l < 4; l++) {
      if (l === L_MEL || !this.wants(l) || s.layers[l].src) continue;
      const p = this.pathFor(set, STEM_LAYERS[l]);
      const buf = this.ready(p);
      if (buf && p) {
        const at = Math.max(now + LOOKAHEAD, s.t0);
        this.startSource(s, l, buf, p, at, this.posAt(s, at));
      }
    }

    const night = 1 - c.day;
    const nightAmt = s.category === 'night' || urgent ? 0 : night;
    const storm = c.storm;
    const indoor = c.indoor;

    // Drone: the bed.
    const drone = pitched ? mix.drone * (1 + 0.08 * night) : 0;
    // Texture: mostly on, joins after the build-up bars.
    const tex = pitched && s.texOn && now >= s.texAt ? mix.texture * (1 - 0.25 * storm - 0.2 * indoor - 0.2 * nightAmt) : 0;
    // Perc: context.
    let perc: number;
    if (urgent) perc = mix.perc;
    else {
      const gate = s.percGate ? mix.perc : 0;
      perc = Math.max(gate, this.move * mix.percMove) * (1 - 0.45 * nightAmt) * (1 - 0.35 * indoor);
    }
    if (!s.layers[L_PERC].src) perc = 0;

    this.setGain(s.layers[L_DRONE], drone, now, 2);
    this.setGain(s.layers[L_TEX], tex, now, urgent ? 0.4 : 1.6);
    this.setGain(s.layers[L_PERC], perc, now, urgent ? 0.3 : perc > s.layers[L_PERC].applied ? 1.2 : 2.2);

    // Melody phrases.
    if (pitched && set.layers.melody.length) this.melody(s, set, mix, now, loopReal, (1 - 0.2 * storm - 0.4 * indoor) * (1 - 0.15 * nightAmt));
  }

  private melody(s: Slot, set: StemSetInfo, mix: Mix, now: number, loopReal: number, level: number) {
    const ls = s.layers[L_MEL];
    if (!s.melOn) {
      // Keep the preferred variation warm so the first entry is ready.
      if (now >= s.melNext - 8 && now < s.melNext) {
        const p = this.pathFor(set, 'melody');
        if (p) this.request(set.id, p, 1);
      }
      if (now < s.melNext || now < s.t0) return;
      // Random variation each entry; fall back to whatever is decoded.
      const list = set.layers.melody;
      let path = list[Math.floor(R() * list.length)];
      let buf = this.ready(path);
      if (!buf) {
        this.request(set.id, path, 1);
        this.trimMelodies(set, path);
        path = '';
        for (const p of list) {
          const b = this.ready(p);
          if (b) {
            buf = b;
            path = p;
            break;
          }
        }
      }
      if (!buf) {
        s.melNext = now + 4;
        return;
      }
      const at = this.locked(set) ? this.nextGrid(s, now + LOOKAHEAD, true) : now + LOOKAHEAD;
      this.startSource(s, L_MEL, buf, path, at, 0);
      ls.applied = -1;
      this.setGain(ls, mix.melody * level, at, 0.7);
      s.melOn = true;
      const loops = Math.round(rr(mix.melLoops[0], mix.melLoops[1]));
      s.melEnd = at + loops * loopReal - 3.5;
      return;
    }
    if (now < s.melEnd) {
      this.setGain(ls, mix.melody * level, now, 1.5);
      return;
    }
    // Phrase over: fade, stop, rest.
    this.setGain(ls, 0, now, 1.1);
    this.stopSource(ls, now + 6);
    s.melOn = false;
    s.melFree = now + 5;
    s.melNext = now + rr(mix.melOff[0], mix.melOff[1]);
  }

  /** Night / storm / indoor / underwater tone shaping on the whole stem bus. */
  private shape(c: StemContext, now: number) {
    const cat = this.active?.category ?? 'explore';
    const urgent = cat === 'combat' || cat === 'boss';
    let f = 18000;
    f *= 1 - (urgent ? 0.15 : 0.4) * (1 - c.day);
    f *= 1 - 0.45 * c.storm;
    f *= 1 - 0.7 * c.indoor;
    if (c.underwater) f = Math.min(f, 700);
    f = Math.max(450, Math.min(18000, f));
    if (Math.abs(f - this.lpApplied) / this.lpApplied > 0.03) {
      this.lpApplied = f;
      this.lp.frequency.setTargetAtTime(f, now, c.underwater ? 0.1 : 1.5);
    }
  }

  private fillAccompaniment(now: number) {
    const acc = this.acc;
    const s = this.active;
    if (!s || !s.set || s.state !== 'live') {
      acc.active = false;
      return;
    }
    const set = s.set;
    acc.active = true;
    acc.pitched = this.policy === 'full';
    acc.perc = s.layers[L_PERC].applied > 0.05;
    acc.rootHz = set.tonicHz * this.flavor.rate;
    acc.scale = set.safeCents;
    acc.accent = MIX[s.category].accent;
    acc.leadGate = s.melOn || now < s.melFree ? 0 : 1;
    if (this.locked(set)) {
      acc.gridT0 = s.t0 - s.offset / this.flavor.rate;
      acc.beatDur = this.beatDur(set);
      acc.beatsPerBar = set.beatsPerBar;
    } else acc.beatDur = 0;
  }

  // ================================================================ control

  /** Player death etc.: fade out now and stay quiet for a moment. */
  silence(): void {
    this.selector.reset();
    this.suppressUntil = this.clock + 4;
    if (this.active && this.ctx) this.fadeOut(this.active, 2.5);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Debug: force a set id (null = automatic). */
  force(id: string | null): string {
    if (id !== null && !this.setInfo(id)) return `unknown set "${id}" (have: ${this.manifest ? Object.keys(this.manifest.sets).join(', ') : 'no manifest'})`;
    this.forced = id;
    return id ? `forcing ${id}` : 'automatic';
  }

  status(): StemStatus {
    const now = this.ctx?.currentTime ?? 0;
    const res = new Map<string, { files: number; bytes: number }>();
    const loading: string[] = [];
    let queued = 0;
    for (const e of this.bufs.values()) {
      if (e.state === 'ready') {
        const r = res.get(e.set) ?? { files: 0, bytes: 0 };
        r.files++;
        r.bytes += e.bytes;
        res.set(e.set, r);
      } else if (e.state === 'loading') loading.push(e.path);
      else if (e.state === 'queued') queued++;
    }
    const a = this.active;
    let active: StemStatus['active'] = null;
    if (a && a.set) {
      const layers = {} as Record<StemLayer, { gain: number; file: string | null }>;
      STEM_LAYERS.forEach((l, i) => (layers[l] = { gain: +a.layers[i].gain.gain.value.toFixed(3), file: a.layers[i].path }));
      active = { set: a.set.id, category: a.category, t0: +(a.t0 - now).toFixed(2), layers };
    }
    return {
      enabled: this.enabled, policy: this.policy, manifest: this.manifestState, sets: this.manifest ? Object.keys(this.manifest.sets) : [],
      rate: +this.flavor.rate.toFixed(4), semitones: +this.flavor.semitones.toFixed(2),
      context: this.selector.current, raw: this.selector.raw, target: this.target, forced: this.forced, active,
      fading: this.slots.filter((s) => s.state === 'fading' && s.set).map((s) => s.set!.id),
      resident: [...res].map(([set, r]) => ({ set, files: r.files, mb: +(r.bytes / 1048576).toFixed(1) })),
      loading, queued,
    };
  }

  /** One line for the F3 overlay. */
  debugLine(): string {
    const st = this.status();
    if (!st.enabled) return 'stems off (generative only)';
    if (st.manifest !== 'ready') return `stems: manifest ${st.manifest}`;
    const a = st.active;
    const lay = a ? STEM_LAYERS.map((l) => `${l[0]}${a.layers[l].file ? a.layers[l].gain.toFixed(2) : '-'}`).join(' ') : '';
    const mb = st.resident.reduce((s, r) => s + r.mb, 0);
    return `stems ${a ? a.set : '—'} [${lay}] ctx ${st.context ?? '-'}${st.forced ? ' (forced)' : ''} · ${st.policy} · ×${st.rate} · ${st.resident.length} sets ${mb.toFixed(0)} MB${st.loading.length ? ` · loading ${st.loading.length}` : ''}`;
  }

  dispose(): void {
    if (!this.ctx) return;
    for (const s of this.slots) this.kill(s);
    this.bus.disconnect();
    this.lp.disconnect();
    this.bufs.clear();
  }
}
