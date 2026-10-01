/**
 * AudioEngine — the WebAudio backbone of Norgo.
 *
 *   sources → Voice (gain → air-absorption lowpass → HRTF panner) → bus
 *                                    └→ reverb send ──→ ReverbBus ┐
 *   buses: sfx / voice / ambience ──→ world (muffle LP) ──────────┴→ master → limiter → out
 *          music / ui ───────────────────────────────────────────────→ master
 *
 * Responsibilities: lazy context creation on the first user gesture, bus
 * volumes (persisted per browser), voice limits & stealing, pre-rendered
 * variant banks (OfflineAudioContext) with live-render fallback, listener
 * transform, and the global "world" filter used for underwater/snow muffling.
 */
import type { Vec3 } from '../shared/types';
import { Synth, renderOffline } from './dsp';
import { ReverbBus } from './reverb';

export type BusName = 'master' | 'music' | 'sfx' | 'ambience' | 'voice' | 'ui';
export const BUS_NAMES: BusName[] = ['master', 'music', 'sfx', 'ambience', 'voice', 'ui'];

export type VolumeSettings = Record<BusName, number>;
export const DEFAULT_VOLUMES: VolumeSettings = { master: 0.85, music: 0.55, sfx: 0.9, ambience: 0.75, voice: 0.9, ui: 0.6 };
const VOLUME_KEY = 'norgo.audio.volumes';

/** A procedural sound: a recipe plus playback metadata. */
export interface SoundDef {
  /** Rendered length incl. tail (s). */
  dur: number;
  /** Builds the sound on a Synth (`s.t` is the start time, output `s.out`). */
  render: (s: Synth) => void;
  /** Number of pre-rendered variants (0 = always render live). */
  variants: number;
  bus: BusName;
  /** Voice-limit group. */
  group: string;
  /** Linear gain. */
  gain: number;
  /** Panner reference distance (m) — bigger for loud sources. */
  ref: number;
  /** Max audible distance (m); farther plays are culled. */
  range: number;
  /** Random playback-rate jitter (± fraction). */
  jitter: number;
  /** Reverb send multiplier. */
  reverb: number;
  /** Stealing priority (higher survives). */
  priority: number;
  /** Render stereo (only for non-spatial sounds). */
  stereo?: boolean;
  /** Use the cheap equal-power panner instead of HRTF (ambient emitters). */
  cheapPan?: boolean;
}

export interface PlayOpts {
  pos?: Vec3;
  volume?: number;
  /** Playback-rate multiplier (pitch). */
  pitch?: number;
  /** Absolute context start time (defaults to now). */
  when?: number;
  /** Extra lowpass (Hz) e.g. for distant/muffled variants. */
  lowpass?: number;
  /** Reverb send multiplier on top of the def's. */
  reverb?: number;
  /** Override bus. */
  bus?: BusName;
}

/** Voice-limit groups (max simultaneous voices per group). */
const GROUP_LIMITS: Record<string, number> = {
  step: 10, foley: 10, combat: 12, magic: 12, world: 10, ui: 6, creature: 8, speech: 5, ambient: 14, loop: 8, music: 64, big: 5,
};
const MAX_VOICES = 56;

/** One playing sound with its spatial chain. */
export class Voice {
  readonly input: GainNode;
  readonly out: GainNode;
  filter: BiquadFilterNode | null = null;
  panner: PannerNode | null = null;
  send: GainNode | null = null;
  sources: AudioScheduledSourceNode[] = [];
  ended = false;
  /** Score used for stealing (priority × loudness at listener). */
  score = 0;

  constructor(
    readonly engine: AudioEngine, readonly group: string, public end: number, readonly priority: number, public pos: Vec3 | null,
  ) {
    const c = engine.ctx!;
    this.input = c.createGain();
    this.out = c.createGain();
    this.input.connect(this.out);
  }

  /** Move a spatial voice (smoothly). */
  setPosition(p: Vec3): void {
    this.pos = p;
    if (this.panner) setPannerPos(this.panner, p, this.engine.ctx!.currentTime, 0.03);
    this.engine.updateAir(this);
  }

  /** Fade out and release. */
  stop(fade = 0.06): void {
    if (this.ended) return;
    const c = this.engine.ctx!;
    const now = c.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + fade);
    for (const s of this.sources) {
      try {
        s.stop(now + fade + 0.02);
      } catch {
        /* already stopped */
      }
    }
    this.end = Math.min(this.end, now + fade + 0.05);
  }

  /** Disconnect everything (called by the engine once finished). */
  dispose(): void {
    this.ended = true;
    this.out.disconnect();
    this.input.disconnect();
    this.filter?.disconnect();
    this.panner?.disconnect();
    this.send?.disconnect();
  }
}

function setPannerPos(p: PannerNode, v: Vec3, now: number, tc: number) {
  if (p.positionX) {
    p.positionX.setTargetAtTime(v[0], now, tc);
    p.positionY.setTargetAtTime(v[1], now, tc);
    p.positionZ.setTargetAtTime(v[2], now, tc);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(v[0], v[1], v[2]);
  }
}

interface Bank {
  buffers: AudioBuffer[];
  pending: boolean;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  readonly volumes: VolumeSettings = { ...DEFAULT_VOLUMES };
  bus!: Record<BusName, GainNode>;
  /** Per-bus duck multipliers (dialog ducking, death, menus). */
  private duck: Record<BusName, number> = { master: 1, music: 1, sfx: 1, ambience: 1, voice: 1, ui: 1 };
  private worldFilter!: BiquadFilterNode;
  private limiter!: DynamicsCompressorNode;
  reverb!: ReverbBus;
  readonly listener: Vec3 = [0, 0, 0];
  /** Air absorption distance constant (m) — humid/foggy air absorbs more. */
  airDistance = 150;
  private voices: Voice[] = [];
  private banks = new Map<string, Bank>();
  private renderQueue: { key: string; def: SoundDef }[] = [];
  private rendering = 0;
  private startHandlers: (() => void)[] = [];
  private unlockInstalled = false;
  muted = false;

  constructor() {
    try {
      const raw = globalThis.localStorage?.getItem(VOLUME_KEY);
      if (raw) {
        const v = JSON.parse(raw) as Partial<VolumeSettings>;
        for (const k of BUS_NAMES) if (typeof v[k] === 'number' && isFinite(v[k]!)) this.volumes[k] = Math.max(0, Math.min(1, v[k]!));
      }
    } catch {
      /* storage unavailable — defaults */
    }
  }

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Register a callback for when the context first starts (after a user gesture). */
  onStart(fn: () => void): void {
    if (this.ctx) fn();
    else this.startHandlers.push(fn);
  }

  /** Listen for the first user gesture to create/resume the context (autoplay policy). */
  installUnlock(): void {
    if (this.unlockInstalled || typeof window === 'undefined') return;
    this.unlockInstalled = true;
    const evs = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    const handler = () => {
      this.start();
      if (this.ctx && this.ctx.state === 'running') for (const e of evs) window.removeEventListener(e, handler, true);
    };
    for (const e of evs) window.addEventListener(e, handler, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      // Save CPU/battery while hidden; resume when visible again.
      if (document.hidden) void this.ctx.suspend();
      else if (!this.muted) void this.ctx.resume();
    });
  }

  /** Create (or resume) the context. Must be called from a user gesture the first time. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.buildGraph(ctx);
    void ctx.resume();
    const hs = this.startHandlers;
    this.startHandlers = [];
    for (const h of hs) h();
  }

  private buildGraph(ctx: AudioContext) {
    const mk = () => ctx.createGain();
    this.bus = { master: mk(), music: mk(), sfx: mk(), ambience: mk(), voice: mk(), ui: mk() };
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 6;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.bus.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    // World chain: sfx/voice/ambience share the muffle filter (underwater, snow, deafness).
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.frequency.value = 20000;
    this.worldFilter.Q.value = 0.5;
    this.worldFilter.connect(this.bus.master);
    this.bus.sfx.connect(this.worldFilter);
    this.bus.voice.connect(this.worldFilter);
    this.bus.ambience.connect(this.worldFilter);
    this.bus.music.connect(this.bus.master);
    this.bus.ui.connect(this.bus.master);
    this.reverb = new ReverbBus(ctx, this.worldFilter);
    this.reverb.setSpace('open', 0.01);
    this.reverb.setWet(0.12, 0.01);
    this.applyVolumes(0.01);
  }

  // ---------------------------------------------------------------- volumes

  setVolumes(v: Partial<VolumeSettings>): void {
    for (const k of BUS_NAMES) {
      const x = v[k];
      if (typeof x === 'number' && isFinite(x)) this.volumes[k] = Math.max(0, Math.min(1, x));
    }
    try {
      globalThis.localStorage?.setItem(VOLUME_KEY, JSON.stringify(this.volumes));
    } catch {
      /* ignore */
    }
    this.applyVolumes(0.05);
  }

  /** Temporarily scale a bus (e.g. duck music under dialog). */
  setDuck(bus: BusName, mul: number, tc = 0.4): void {
    if (this.duck[bus] === mul) return;
    this.duck[bus] = mul;
    this.applyVolumes(tc);
  }

  private applyVolumes(tc: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const k of BUS_NAMES) {
      // Perceptual (squared) taper so sliders feel linear.
      const base = this.volumes[k];
      const g = base * base * this.duck[k] * (k === 'master' && this.muted ? 0 : 1);
      this.bus[k].gain.setTargetAtTime(g, now, tc);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes(0.05);
  }

  /** Global world lowpass (Hz); 20000 = open. */
  setMuffle(hz: number, tc = 0.25): void {
    if (!this.ctx) return;
    this.worldFilter.frequency.setTargetAtTime(Math.max(200, Math.min(20000, hz)), this.ctx.currentTime, tc);
  }

  // ---------------------------------------------------------------- listener

  setListener(pos: Vec3, fwd: Vec3, up: Vec3): void {
    this.listener[0] = pos[0];
    this.listener[1] = pos[1];
    this.listener[2] = pos[2];
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      // Short ramps avoid zipper noise when the camera moves fast.
      l.positionX.setTargetAtTime(pos[0], t, 0.015);
      l.positionY.setTargetAtTime(pos[1], t, 0.015);
      l.positionZ.setTargetAtTime(pos[2], t, 0.015);
      l.forwardX.setTargetAtTime(fwd[0], t, 0.015);
      l.forwardY.setTargetAtTime(fwd[1], t, 0.015);
      l.forwardZ.setTargetAtTime(fwd[2], t, 0.015);
      l.upX.setTargetAtTime(up[0], t, 0.015);
      l.upY.setTargetAtTime(up[1], t, 0.015);
      l.upZ.setTargetAtTime(up[2], t, 0.015);
    } else {
      const ll = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      ll.setPosition(pos[0], pos[1], pos[2]);
      ll.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
    }
  }

  distTo(p: Vec3): number {
    const l = this.listener;
    return Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]);
  }

  // ---------------------------------------------------------------- voices

  /**
   * Reserve a voice slot; returns null if the sound loses against the
   * currently playing ones (or is out of range). Steals the weakest voice
   * when limits are hit.
   */
  allocVoice(def: SoundDef, opts: PlayOpts, end: number): Voice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const vol = (opts.volume ?? 1) * def.gain;
    if (vol <= 0.0005) return null;
    let att = 1;
    if (opts.pos) {
      const d = this.distTo(opts.pos);
      if (d > def.range) return null;
      att = def.ref / (def.ref + Math.max(0, d - def.ref));
    }
    const score = def.priority * vol * att;
    if (score < 0.0004) return null;
    this.reap();
    const limit = GROUP_LIMITS[def.group] ?? 8;
    let inGroup = 0;
    let weakestGroup: Voice | null = null;
    let weakest: Voice | null = null;
    for (const v of this.voices) {
      if (v.ended) continue;
      if (v.group === def.group) {
        inGroup++;
        if (!weakestGroup || v.score < weakestGroup.score) weakestGroup = v;
      }
      if (!weakest || v.score < weakest.score) weakest = v;
    }
    if (inGroup >= limit) {
      if (!weakestGroup || weakestGroup.score > score) return null;
      weakestGroup.stop(0.04);
    } else if (this.voices.length >= MAX_VOICES) {
      if (!weakest || weakest.score > score) return null;
      weakest.stop(0.04);
    }
    const v = new Voice(this, def.group, end, def.priority, opts.pos ?? null);
    v.score = score;
    v.out.gain.value = vol;
    const bus = this.bus[opts.bus ?? def.bus];
    if (opts.pos) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 0.5;
      v.filter = f;
      const p = ctx.createPanner();
      p.panningModel = def.cheapPan ? 'equalpower' : 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = def.ref;
      p.rolloffFactor = 1;
      p.maxDistance = 100000;
      if (p.positionX) {
        p.positionX.value = opts.pos[0];
        p.positionY.value = opts.pos[1];
        p.positionZ.value = opts.pos[2];
      } else setPannerPos(p, opts.pos, 0, 0);
      v.panner = p;
      v.out.connect(f);
      f.connect(p);
      p.connect(bus);
      const sendAmt = def.reverb * (opts.reverb ?? 1);
      if (sendAmt > 0) {
        const s = ctx.createGain();
        v.send = s;
        p.connect(s);
        s.connect(this.reverb.input);
      }
      this.updateAir(v, opts.lowpass);
    } else {
      v.out.connect(bus);
      const sendAmt = def.reverb * (opts.reverb ?? 1);
      if (sendAmt > 0 && def.bus !== 'ui') {
        const s = ctx.createGain();
        s.gain.value = sendAmt * 0.6;
        v.send = s;
        v.out.connect(s);
        s.connect(this.reverb.input);
      }
    }
    this.voices.push(v);
    return v;
  }

  /** Recompute air absorption + distance-dependent reverb send for a voice. */
  updateAir(v: Voice, extraLp?: number): void {
    if (!v.pos || !v.filter || !this.ctx) return;
    const d = this.distTo(v.pos);
    const air = 19000 * Math.exp(-d / this.airDistance);
    const f = Math.max(350, Math.min(extraLp ?? 20000, air));
    v.filter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
    if (v.send) {
      // Far sources are more reverberant (direct path drops faster than the field).
      const wet = 0.35 + 0.65 * Math.min(1, d / 35);
      v.send.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.05);
    }
  }

  private reap() {
    const now = this.now;
    let w = 0;
    for (const v of this.voices) {
      if (!v.ended && v.end <= now) v.dispose();
      if (!v.ended) this.voices[w++] = v;
    }
    this.voices.length = w;
  }

  /** Per-frame housekeeping. */
  update(): void {
    if (!this.ctx) return;
    this.reap();
    this.pumpRenders();
  }

  activeVoices(): number {
    return this.voices.length;
  }

  // ---------------------------------------------------------------- playing defs

  /**
   * Play a sound definition. Uses a pre-rendered variant when available,
   * otherwise renders the recipe live (and queues a bank render).
   */
  play(def: SoundDef, key: string, opts: PlayOpts = {}): Voice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const when = Math.max(ctx.currentTime, opts.when ?? ctx.currentTime);
    const bank = def.variants > 0 ? this.bankFor(key, def) : null;
    if (bank && !bank.buffers.length) {
      if (bank.pending) {
        // First use: fast-track the render and play as soon as it lands (a few ms).
        // Banks are peak-normalized, so playing the raw recipe live would be at the wrong level.
        this.waiting.push({ def, key, opts, at: ctx.currentTime });
        const qi = this.renderQueue.findIndex((j) => j.key === key);
        if (qi > 0) this.renderQueue.unshift(...this.renderQueue.splice(qi, 1));
        this.pumpRenders();
        return null;
      }
    }
    const buf = bank && bank.buffers.length ? bank.buffers[Math.floor(Math.random() * bank.buffers.length)] : null;
    const rate = (opts.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * def.jitter);
    const dur = buf ? buf.duration / rate : def.dur;
    const v = this.allocVoice(def, opts, when + dur + 0.1);
    if (!v) return null;
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(v.input);
      src.start(when);
      v.sources.push(src);
    } else {
      const s = new Synth(ctx, v.input, when + 0.002);
      def.render(s);
    }
    return v;
  }

  /** Open a sustained voice (loops, speech) the caller feeds; stop() it when done. */
  openVoice(def: SoundDef, opts: PlayOpts = {}): Voice | null {
    return this.allocVoice(def, opts, Infinity);
  }

  private bankFor(key: string, def: SoundDef): Bank {
    let b = this.banks.get(key);
    if (!b) {
      b = { buffers: [], pending: true };
      this.banks.set(key, b);
      this.renderQueue.push({ key, def });
    }
    return b;
  }

  /** Pre-render a sound's variants in the background. */
  preload(def: SoundDef, key: string): void {
    if (def.variants > 0 && this.ctx) this.bankFor(key, def);
  }

  isReady(key: string): boolean {
    const b = this.banks.get(key);
    return !!b && b.buffers.length > 0;
  }

  /** Render queued banks a few at a time (offline renders run off the audio thread). */
  private pumpRenders() {
    // One job per frame: building the offline graphs runs on the main thread and
    // starting several at once caused visible frame hitches.
    let started = 0;
    while (this.rendering < 2 && this.renderQueue.length && started++ < 1) {
      const job = this.renderQueue.shift()!;
      const bank = this.banks.get(job.key)!;
      this.rendering++;
      const sr = this.ctx!.sampleRate;
      const ch = job.def.stereo ? 2 : 1;
      const jobs: Promise<AudioBuffer>[] = [];
      for (let i = 0; i < job.def.variants; i++) jobs.push(renderOffline(sr, job.def.dur, ch, job.def.render));
      Promise.all(jobs)
        .then((bufs) => {
          normalizeBank(bufs, 0.9);
          bank.buffers = bufs;
        })
        .catch(() => {
          // Leave the bank empty: plays fall back to the live recipe.
        })
        .finally(() => {
          bank.pending = false;
          this.rendering--;
          this.flushWaiting(job.key);
        });
    }
  }

  private waiting: { def: SoundDef; key: string; opts: PlayOpts; at: number }[] = [];

  /** Play requests that arrived before their bank existed (dropped if > 0.35 s late). */
  private flushWaiting(key: string) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const ready = this.waiting.filter((w) => w.key === key);
    this.waiting = this.waiting.filter((w) => w.key !== key && now - w.at < 2);
    for (const w of ready) {
      if (now - w.at > 0.35) continue;
      const bank = this.banks.get(key);
      if (bank && bank.buffers.length) this.play(w.def, key, { ...w.opts, when: undefined });
      else this.playLive(w.def, w.opts);
    }
  }

  /** Render a recipe directly into a voice (fallback when offline rendering fails). */
  private playLive(def: SoundDef, opts: PlayOpts) {
    const ctx = this.ctx!;
    const when = ctx.currentTime;
    const v = this.allocVoice(def, opts, when + def.dur + 0.1);
    if (v) def.render(new Synth(ctx, v.input, when + 0.002));
  }

  /** Cached arbitrary buffer (loops, JS-rendered material). */
  private bufferCache = new Map<string, AudioBuffer | Promise<AudioBuffer>>();
  getBuffer(key: string, make: () => Promise<AudioBuffer> | AudioBuffer): AudioBuffer | null {
    const c = this.bufferCache.get(key);
    if (c instanceof AudioBuffer) return c;
    if (c) return null;
    const r = make();
    if (r instanceof AudioBuffer) {
      this.bufferCache.set(key, r);
      return r;
    }
    this.bufferCache.set(key, r);
    r.then((b) => this.bufferCache.set(key, b)).catch(() => this.bufferCache.delete(key));
    return null;
  }

  dispose(): void {
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** Scale a bank so its loudest variant peaks at `target` (variants keep relative levels). */
function normalizeBank(bufs: AudioBuffer[], target: number) {
  let pk = 0;
  for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) {
    const a = b.getChannelData(c);
    for (let i = 0; i < a.length; i++) {
      const x = Math.abs(a[i]);
      if (x > pk) pk = x;
    }
  }
  if (pk < 1e-5) return;
  const k = target / pk;
  for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) {
    const a = b.getChannelData(c);
    for (let i = 0; i < a.length; i++) a[i] *= k;
  }
}
