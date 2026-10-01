/**
 * Synthesis primitives shared by every procedural sound in Norgo.
 *
 * There are no audio files: every sound is a "recipe" — a function that builds
 * a small WebAudio node graph on a `Synth`. The same recipe runs on the live
 * AudioContext (zero-latency first play) or on an OfflineAudioContext (to
 * pre-render a bank of variants that later plays as cheap buffer sources).
 *
 * Also contains plain-JS DSP helpers (noise generation, loop folding, simple
 * filters, Karplus-Strong) used where per-sample control is easier than nodes.
 */

export type NoiseColor = 'white' | 'pink' | 'brown';

// ------------------------------------------------------------------ noise tables

interface NoiseSet {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

const noiseSets = new Map<number, NoiseSet>();
const NOISE_SECONDS = 3;

/**
 * Shared noise buffers per sample rate. AudioBuffers are context independent,
 * so offline renders and the live context reuse the same tables.
 */
export function noiseBuffers(sampleRate: number): NoiseSet {
  let set = noiseSets.get(sampleRate);
  if (set) return set;
  const len = Math.floor(sampleRate * NOISE_SECONDS);
  const white = new Float32Array(len);
  const pink = new Float32Array(len);
  const brown = new Float32Array(len);
  // Cosmetic randomness only (noise content is not replicated state).
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    white[i] = w;
    // Paul Kellet's refined pink filter.
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    pink[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    br = (br + 0.02 * w) / 1.02;
    brown[i] = br * 3.5;
  }
  // Fold the ends so looping noise sources never click.
  const fold = (a: Float32Array) => foldLoop(a, Math.floor(sampleRate * 0.05));
  set = {
    white: toBuffer([fold(white)], sampleRate),
    pink: toBuffer([fold(pink)], sampleRate),
    brown: toBuffer([fold(brown)], sampleRate),
  };
  noiseSets.set(sampleRate, set);
  return set;
}

export function toBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate });
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c] as Float32Array<ArrayBuffer>, c);
  return buf;
}

/**
 * Make a sample array loop seamlessly: the last `xfade` samples are
 * crossfaded into the beginning and removed (equal-power).
 */
export function foldLoop(a: Float32Array, xfade: number): Float32Array {
  const n = a.length - xfade;
  const out = a.slice(0, n);
  for (let i = 0; i < xfade; i++) {
    const t = i / xfade;
    const gIn = Math.sin(t * Math.PI * 0.5);
    const gOut = Math.cos(t * Math.PI * 0.5);
    out[i] = a[i] * gIn + a[n + i] * gOut;
  }
  return out;
}

/** Fold every channel of a rendered buffer into a seamless loop. */
export function loopBuffer(buf: AudioBuffer, xfadeSec: number): AudioBuffer {
  const x = Math.floor(xfadeSec * buf.sampleRate);
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(foldLoop(buf.getChannelData(c), x));
  return toBuffer(chans, buf.sampleRate);
}

// ------------------------------------------------------------------ offline rendering

/** Render a recipe into a buffer. `channels` 1 = mono (spatial), 2 = stereo (UI/ambience). */
export async function renderOffline(
  sampleRate: number, seconds: number, channels: number, recipe: (s: Synth) => void, rand: () => number = Math.random,
): Promise<AudioBuffer> {
  const oc = new OfflineAudioContext(channels, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
  const s = new Synth(oc, oc.destination, 0.005, rand);
  recipe(s);
  return oc.startRendering();
}

// ------------------------------------------------------------------ the Synth builder

export type EnvPoint = readonly [number, number];

/** Options for a filtered noise burst. */
export interface BurstOpts {
  t?: number;
  dur: number;
  color?: NoiseColor;
  type?: BiquadFilterType;
  f: number;
  /** Optional sweep target frequency at the end of `dur`. */
  f2?: number;
  q?: number;
  a?: number;
  peak: number;
  /** Decay shape: exponential (natural) or linear. */
  lin?: boolean;
  dest?: AudioNode;
  rate?: number;
}

export interface ToneOpts {
  t?: number;
  type?: OscillatorType;
  wave?: PeriodicWave;
  f: number;
  f2?: number;
  /** Time over which f→f2 happens (default d). */
  glide?: number;
  a?: number;
  d: number;
  peak: number;
  dest?: AudioNode;
  detune?: number;
  /** Vibrato depth (cents) and rate (Hz). */
  vib?: number;
  vibRate?: number;
  lin?: boolean;
}

/**
 * Graph builder. `t` is the reference start time; all helper times are
 * relative to it unless stated otherwise. Every source created is stopped,
 * so graphs free themselves once finished.
 */
export class Synth {
  readonly noise: NoiseSet;
  /** Intensity / variation knob recipes may read (0..1+). */
  p = 1;

  constructor(readonly ctx: BaseAudioContext, readonly out: AudioNode, readonly t: number, readonly rand: () => number = Math.random) {
    this.noise = noiseBuffers(ctx.sampleRate);
  }

  /** Same graph target with the time base shifted by `dt` (or routed to `out`). */
  at(dt: number, out?: AudioNode): Synth {
    const s = new Synth(this.ctx, out ?? this.out, this.t + dt, this.rand);
    s.p = this.p;
    return s;
  }

  r(a: number, b: number): number {
    return a + (b - a) * this.rand();
  }

  ri(a: number, b: number): number {
    return a + Math.floor(this.rand() * (b - a + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rand() * arr.length)];
  }

  chance(p: number): boolean {
    return this.rand() < p;
  }

  /** Gain node; `dest` may be a node or an AudioParam (modulation). */
  gain(v = 1, dest?: AudioNode | AudioParam): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest instanceof AudioParam) g.connect(dest);
    else if (dest) g.connect(dest);
    return g;
  }

  filter(type: BiquadFilterType, f: number, q = 0.707, dest?: AudioNode, gainDb = 0): BiquadFilterNode {
    const n = this.ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = clampF(f);
    n.Q.value = q;
    n.gain.value = gainDb;
    if (dest) n.connect(dest);
    return n;
  }

  /** Soft-clipping waveshaper (amount 0..1+). */
  shaper(amount: number, dest?: AudioNode): WaveShaperNode {
    const ws = this.ctx.createWaveShaper();
    ws.curve = shaperCurve(amount);
    ws.oversample = '2x';
    if (dest) ws.connect(dest);
    return ws;
  }

  stereo(pan: number, dest?: AudioNode): StereoPannerNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    if (dest) p.connect(dest);
    return p;
  }

  delay(time: number, max = 2, dest?: AudioNode): DelayNode {
    const d = this.ctx.createDelay(max);
    d.delayTime.value = time;
    if (dest) d.connect(dest);
    return d;
  }

  /** Looping noise source starting at a random offset (absolute times). */
  noiseSrc(color: NoiseColor, start: number, dur: number, dest?: AudioNode, rate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise[color];
    src.loop = true;
    src.playbackRate.value = rate;
    if (dest) src.connect(dest);
    src.start(start, this.rand() * (NOISE_SECONDS - 0.2));
    src.stop(start + dur + 0.05);
    return src;
  }

  /** Oscillator (absolute times). */
  osc(type: OscillatorType, f: number, start: number, dur: number, dest?: AudioNode, wave?: PeriodicWave): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave);
    else o.type = type;
    o.frequency.value = clampF(f);
    if (dest) o.connect(dest);
    o.start(start);
    o.stop(start + dur + 0.05);
    return o;
  }

  /** Buffer playback (absolute time). */
  buffer(buf: AudioBuffer, start: number, dest: AudioNode, rate = 1, offset = 0, dur?: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(start, offset);
    if (dur !== undefined) src.stop(start + dur);
    return src;
  }

  /**
   * Piecewise envelope (absolute start `t0`, points relative). Exponential
   * segments are used when `exp` (values are clamped above zero).
   */
  env(param: AudioParam, t0: number, pts: readonly EnvPoint[], exp = false): void {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(pts[0][1], t0 + pts[0][0]);
    for (let i = 1; i < pts.length; i++) {
      const [dt, v] = pts[i];
      if (exp) param.exponentialRampToValueAtTime(Math.max(1e-4, v), t0 + dt);
      else param.linearRampToValueAtTime(v, t0 + dt);
    }
  }

  /** Percussive envelope: 0 → peak in `a`, then decays to silence over `d`. */
  perc(param: AudioParam, t0: number, a: number, peak: number, d: number, lin = false): void {
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(peak, t0 + Math.max(0.001, a));
    if (lin) param.linearRampToValueAtTime(0, t0 + a + d);
    else {
      param.exponentialRampToValueAtTime(Math.max(1e-4, peak * 0.001), t0 + a + d);
      param.setValueAtTime(0, t0 + a + d + 0.001);
    }
  }

  /** Filtered noise burst — the workhorse for foley. */
  burst(o: BurstOpts): AudioBufferSourceNode {
    const t = this.t + (o.t ?? 0);
    const a = o.a ?? 0.003;
    const g = this.gain(0, o.dest ?? this.out);
    const f = this.filter(o.type ?? 'bandpass', o.f, o.q ?? 1, g);
    if (o.f2 !== undefined) {
      f.frequency.setValueAtTime(clampF(o.f), t);
      f.frequency.exponentialRampToValueAtTime(clampF(o.f2), t + a + o.dur);
    }
    this.perc(g.gain, t, a, o.peak, o.dur, o.lin);
    return this.noiseSrc(o.color ?? 'white', t, a + o.dur, f, o.rate ?? 1);
  }

  /** Enveloped oscillator with optional pitch glide & vibrato. */
  tone(o: ToneOpts): OscillatorNode {
    const t = this.t + (o.t ?? 0);
    const a = o.a ?? 0.005;
    const g = this.gain(0, o.dest ?? this.out);
    const osc = this.osc(o.type ?? 'sine', o.f, t, a + o.d, g, o.wave);
    if (o.detune) osc.detune.value = o.detune;
    if (o.f2 !== undefined) {
      osc.frequency.setValueAtTime(clampF(o.f), t);
      osc.frequency.exponentialRampToValueAtTime(clampF(o.f2), t + (o.glide ?? a + o.d));
    }
    if (o.vib) {
      const lfo = this.osc('sine', o.vibRate ?? 5.5, t, a + o.d);
      const lg = this.gain(o.vib, osc.detune);
      lfo.connect(lg);
    }
    this.perc(g.gain, t, a, o.peak, o.d, o.lin);
    return osc;
  }

  /**
   * Modal resonator bank: a struck object as a sum of damped sinusoids.
   * partials: [frequency ratio, amplitude, decay seconds].
   */
  modal(t: number, f: number, partials: readonly (readonly [number, number, number])[], peak: number, dest?: AudioNode, spread = 0.01): void {
    for (const [ratio, amp, dec] of partials) {
      const fr = f * ratio * (1 + this.r(-spread, spread));
      if (fr > 18000) continue;
      this.tone({ t, f: fr, a: 0.0015, d: dec, peak: peak * amp, dest });
    }
  }

  /** FM bell/tine: carrier f, modulator f*ratio, decaying modulation index. */
  fm(t: number, f: number, ratio: number, index: number, d: number, peak: number, dest?: AudioNode, a = 0.002): void {
    const T = this.t + t;
    const car = this.osc('sine', f, T, a + d);
    const mod = this.osc('sine', f * ratio, T, a + d);
    const mg = this.gain(0);
    mod.connect(mg);
    mg.connect(car.frequency);
    mg.gain.setValueAtTime(f * index, T);
    mg.gain.exponentialRampToValueAtTime(Math.max(0.01, f * index * 0.05), T + a + d);
    const g = this.gain(0, dest ?? this.out);
    car.connect(g);
    this.perc(g.gain, T, a, peak, d);
  }

  /** Short bright transient (stick/click). */
  click(t: number, f: number, peak: number, dest?: AudioNode, dur = 0.012): void {
    this.burst({ t, dur, f, q: 0.8, type: 'bandpass', peak, a: 0.0005, dest });
  }

  /** Low body thump: sine with fast pitch drop. */
  thump(t: number, f: number, peak: number, d: number, dest?: AudioNode, drop = 0.45): void {
    this.tone({ t, f: f * 1.8, f2: f * drop, glide: d * 0.6, a: 0.002, d, peak, dest });
  }
}

// ------------------------------------------------------------------ helpers

export function clampF(f: number): number {
  return Math.max(10, Math.min(22000, f));
}

const shaperCache = new Map<number, Float32Array<ArrayBuffer>>();
export function shaperCurve(amount: number): Float32Array<ArrayBuffer> {
  const key = Math.round(amount * 100);
  let c = shaperCache.get(key);
  if (c) return c;
  const n = 1024;
  c = new Float32Array(n);
  const k = 1 + amount * 12;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  shaperCache.set(key, c);
  return c;
}

/** Equal-tempered/ratio helpers. */
export function cents(c: number): number {
  return Math.pow(2, c / 1200);
}

/**
 * Karplus-Strong plucked string rendered in JS (mono). `bright` 0..1 shapes
 * the excitation; `damp` 0..1 the loop filter.
 */
export function karplus(sampleRate: number, f: number, seconds: number, bright = 0.6, damp = 0.5, rand: () => number = Math.random): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  const period = Math.max(2, Math.round(sampleRate / f));
  const ring = new Float32Array(period);
  let lp = 0;
  for (let i = 0; i < period; i++) {
    const w = rand() * 2 - 1;
    lp += (w - lp) * (0.2 + bright * 0.8);
    ring[i] = lp;
  }
  // Loop filter: weighted two-point average (s=0.5 is the classic dull
  // string, s→1 keeps highs ringing) times a per-pass loss k.
  const s = 0.5 + (1 - damp) * 0.42;
  const k = 0.9985 - damp * 0.012;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const cur = ring[idx];
    const nxt = ring[(idx + 1) % period];
    ring[idx] = k * (s * cur + (1 - s) * nxt);
    out[i] = cur;
    idx = (idx + 1) % period;
  }
  // Short fade in/out to avoid clicks.
  const fi = Math.min(n, 64);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  const fo = Math.min(n, Math.floor(sampleRate * 0.05));
  for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  return out;
}

/** Simple deterministic PRNG returning a () => number (mulberry32) for recipes that must be reproducible. */
export function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
