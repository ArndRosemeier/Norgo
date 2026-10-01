/**
 * Creature vocalizations.
 *
 * Every species gets a deterministic "voice genome" derived from the world's
 * fauna seed + species index: call types, pitch/formant multipliers,
 * roughness, breathiness, contour, pulse patterns and (in weird worlds)
 * alien FM/ring modulation. Body size (from the view's radius & scale)
 * shifts pitch and formants physically: big animals rumble, small ones chirp.
 *
 * Calls are rendered into small variant banks per (species, size bucket,
 * situation) and then replayed cheaply with jitter.
 */
import type { Synth } from './dsp';
import type { SoundDef } from './engine';
import { Rng, deriveSeed } from '../core/rng';
import { sd } from './sounds/common';

export type CallKind = 'growl' | 'roar' | 'bellow' | 'howl' | 'hoot' | 'chirp' | 'squeak' | 'trill' | 'hiss' | 'click' | 'drone' | 'croak';
export const CALL_KINDS: CallKind[] = ['growl', 'roar', 'bellow', 'howl', 'hoot', 'chirp', 'squeak', 'trill', 'hiss', 'click', 'drone', 'croak'];
export type CallSituation = 'idle' | 'alert' | 'attack' | 'pain' | 'death';

export interface CreatureVoice {
  /** Calm/social call and aggressive call. */
  primary: CallKind;
  aggressive: CallKind;
  pitchMul: number;
  formantMul: number;
  rough: number;
  roughRate: number;
  breath: number;
  /** Pitch contour bias: -1 falling … 1 rising. */
  contour: number;
  pulses: number;
  pulseRate: number;
  durMul: number;
  vibrato: number;
  wave: OscillatorType;
  /** Audio-rate FM (alien timbre); 0 = natural. */
  fmRatio: number;
  fmIndex: number;
  /** Idle call frequency multiplier (some species are chatty). */
  chatty: number;
}

/** Base pitch per kind for a 1 m creature. */
const KIND_F0: Record<CallKind, number> = {
  growl: 85, roar: 130, bellow: 75, howl: 380, hoot: 330, chirp: 2800, squeak: 2200, trill: 2000, hiss: 0, click: 0, drone: 160, croak: 170,
};

/** Call pools by size class (tiny → huge). */
const POOLS: CallKind[][] = [
  ['chirp', 'squeak', 'click', 'drone', 'trill'],
  ['chirp', 'squeak', 'hiss', 'hoot', 'croak', 'trill', 'click'],
  ['growl', 'howl', 'hoot', 'hiss', 'bellow', 'croak', 'chirp', 'trill'],
  ['growl', 'roar', 'bellow', 'hoot', 'howl', 'drone'],
  ['roar', 'bellow', 'drone', 'growl'],
];
const AGGRO: CallKind[][] = [
  ['squeak', 'click', 'hiss'],
  ['hiss', 'squeak', 'growl', 'click'],
  ['growl', 'hiss', 'roar'],
  ['roar', 'growl', 'bellow'],
  ['roar', 'bellow'],
];

export function sizeClass(size: number): number {
  return size < 0.35 ? 0 : size < 0.8 ? 1 : size < 1.8 ? 2 : size < 3.5 ? 3 : 4;
}

/** Explicit hints from the creature domain (optional; see report). */
const hints = new Map<number, Partial<CreatureVoice>>();
/** Let the creature module override voice traits for a species (e.g. `{ primary: 'hoot' }`). */
export function setSpeciesVoiceHint(species: number, hint: Partial<CreatureVoice>): void {
  hints.set(species, hint);
}

const voiceCache = new Map<string, CreatureVoice>();

/** Deterministic voice genome for a species at a typical adult size. */
export function creatureVoice(faunaSeed: number, species: number, size: number, weirdness: number): CreatureVoice {
  const sc = sizeClass(size);
  const key = faunaSeed + ':' + species + ':' + sc;
  const c = voiceCache.get(key);
  if (c) return c;
  // The genome itself does not depend on size class, only the call pool.
  const rng = new Rng(deriveSeed(faunaSeed, 'voice', species));
  const pickRoll = rng.float();
  const aggroRoll = rng.float();
  const pool = POOLS[sc];
  const ag = AGGRO[sc];
  const alien = rng.chance(0.1 + weirdness * 0.55);
  const v: CreatureVoice = {
    primary: pool[Math.floor(pickRoll * pool.length)],
    aggressive: ag[Math.floor(aggroRoll * ag.length)],
    pitchMul: Math.exp(rng.gaussian(0, 0.25)),
    formantMul: Math.exp(rng.gaussian(0, 0.18)),
    rough: rng.range(0, 1),
    roughRate: rng.range(18, 60),
    breath: rng.range(0.05, 0.6),
    contour: rng.range(-1, 1),
    pulses: rng.weighted([1, 2, 3, 4, 6], (_, i) => [3, 2, 1.5, 1, 0.5][i]),
    pulseRate: rng.range(3, 12),
    durMul: rng.range(0.7, 1.4),
    vibrato: rng.chance(0.4) ? rng.range(10, 60) : 0,
    wave: rng.pick(['sawtooth', 'sawtooth', 'square', 'triangle'] as OscillatorType[]),
    fmRatio: alien ? rng.pick([0.5, 1.41, 2.76, 3.5, 0.71]) : 0,
    fmIndex: alien ? rng.range(0.4, 3) : 0,
    chatty: rng.range(0.4, 1.8),
  };
  Object.assign(v, hints.get(species));
  voiceCache.set(key, v);
  return v;
}

interface CallParams {
  kind: CallKind;
  f0: number;
  fs: number;
  dur: number;
  contour: number;
  peak: number;
  v: CreatureVoice;
  pulses: number;
}

/**
 * Generic vocal tract: oscillator (+FM, +roughness AM, +vibrato) and breath
 * noise through parallel formant filters; pitch contour f0→fPeak→f1.
 */
function tract(s: Synth, t: number, o: { f0: number; fPeak: number; f1: number; peakAt: number; dur: number; wave: OscillatorType; rough: number; roughRate: number; breath: number; formants: [number, number, number][]; vib: number; peak: number; attack: number; fmRatio: number; fmIndex: number; gate?: { rate: number; duty: number } }) {
  const T = s.t + t;
  const D = o.dur;
  const src = s.osc(o.wave, o.f0, T, D);
  src.frequency.setValueAtTime(o.f0, T);
  src.frequency.exponentialRampToValueAtTime(Math.max(20, o.fPeak), T + D * o.peakAt);
  src.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), T + D);
  if (o.vib > 0) {
    const lfo = s.osc('sine', s.r(4, 7), T, D);
    lfo.connect(s.gain(o.vib, src.detune));
  }
  if (o.fmIndex > 0) {
    const mod = s.osc('sine', o.f0 * o.fmRatio, T, D);
    const mg = s.gain(o.f0 * o.fmIndex);
    mod.connect(mg);
    mg.connect(src.frequency);
  }
  const voiced = s.gain(1 - o.breath * 0.6);
  src.connect(voiced);
  // Roughness: amplitude modulation at sub-audio/low-audio rate (growl, croak).
  let head: AudioNode = voiced;
  if (o.rough > 0.05) {
    const am = s.gain(1 - o.rough * 0.5);
    const lfo = s.osc('square', o.roughRate, T, D);
    lfo.frequency.setValueAtTime(o.roughRate * s.r(0.8, 1.2), T + D * 0.5);
    lfo.connect(s.gain(o.rough * 0.5, am.gain));
    voiced.connect(am);
    head = am;
  }
  const out = s.gain(0, s.out);
  const sum = s.gain(1);
  head.connect(sum);
  if (o.breath > 0.02) {
    const n = s.noiseSrc('pink', T, D);
    n.connect(s.gain(o.breath * 1.5, sum));
  }
  for (const [f, q, g] of o.formants) {
    const bp = s.filter('bandpass', f, q);
    sum.connect(bp);
    bp.connect(s.gain(g, out));
  }
  // Amplitude envelope (optionally gated into pulses)
  const pk = o.peak;
  out.gain.setValueAtTime(0, T);
  if (o.gate) {
    const per = 1 / o.gate.rate;
    for (let tt = 0; tt < D - 0.01; tt += per) {
      const env = Math.sin(Math.PI * Math.min(1, (tt + per * 0.5) / D));
      out.gain.setValueAtTime(0, T + tt);
      out.gain.linearRampToValueAtTime(pk * (0.5 + env * 0.5), T + tt + per * o.gate.duty * 0.3);
      out.gain.linearRampToValueAtTime(0, T + tt + per * o.gate.duty);
    }
  } else {
    out.gain.linearRampToValueAtTime(pk, T + o.attack);
    out.gain.setValueAtTime(pk, T + Math.max(o.attack, D * 0.6));
    out.gain.linearRampToValueAtTime(0, T + D);
  }
}

/** Render one call. */
function call(s: Synth, p: CallParams): void {
  const { v, f0, fs, contour } = p;
  const up = 1 + Math.max(0, contour) * 0.5;
  const down = 1 - Math.max(0, -contour) * 0.4;
  const base = { wave: v.wave, rough: v.rough, roughRate: v.roughRate, breath: v.breath, vib: v.vibrato, fmRatio: v.fmRatio, fmIndex: v.fmIndex, peak: p.peak };
  const F = (a: number, b: number, c = 0): [number, number, number][] => {
    const r: [number, number, number][] = [[a * fs, 4, 1], [b * fs, 5, 0.6]];
    if (c) r.push([c * fs, 6, 0.3]);
    return r;
  };
  switch (p.kind) {
    case 'growl':
      tract(s, 0, { ...base, f0: f0 * 0.9, fPeak: f0 * up, f1: f0 * 0.8 * down, peakAt: 0.4, dur: p.dur, rough: Math.max(0.6, v.rough), breath: Math.max(0.3, v.breath), formants: F(380, 900, 2200), attack: p.dur * 0.2 });
      break;
    case 'roar':
      tract(s, 0, { ...base, f0: f0 * 0.8, fPeak: f0 * 1.35 * up, f1: f0 * 0.6 * down, peakAt: 0.3, dur: p.dur, rough: Math.max(0.5, v.rough), breath: Math.max(0.45, v.breath), formants: F(700, 1250, 2600), attack: p.dur * 0.15 });
      break;
    case 'bellow':
      tract(s, 0, { ...base, wave: 'sawtooth', f0, fPeak: f0 * 1.1 * up, f1: f0 * 0.75 * down, peakAt: 0.5, dur: p.dur, rough: v.rough * 0.4, formants: F(300, 700, 2000), attack: p.dur * 0.25 });
      break;
    case 'howl':
      tract(s, 0, { ...base, wave: 'triangle', f0: f0 * 0.75, fPeak: f0 * 1.3 * up, f1: f0 * 0.65 * down, peakAt: 0.3, dur: p.dur * 1.4, rough: 0, breath: v.breath * 0.4, vib: Math.max(15, v.vibrato), formants: F(350, 800), attack: p.dur * 0.3 });
      break;
    case 'hoot': {
      const n = Math.max(1, Math.min(4, p.pulses));
      for (let i = 0; i < n; i++) {
        const ff = f0 * (i === n - 1 ? 0.92 : 1) * (1 + contour * 0.05 * i);
        tract(s, i * (0.25 + 0.1 / v.pulseRate), { ...base, wave: 'sine', f0: ff * 0.95, fPeak: ff * 1.04, f1: ff * 0.9, peakAt: 0.3, dur: p.dur * 0.35, rough: 0, breath: 0.15, vib: 0, formants: F(ff / fs, ff * 2 / fs), attack: 0.03 });
      }
      break;
    }
    case 'chirp': {
      const n = Math.max(1, p.pulses + 1);
      for (let i = 0; i < n; i++) {
        const ff = f0 * s.r(0.9, 1.1);
        const d = s.r(0.035, 0.08);
        const st = i / (v.pulseRate * 2 + 6);
        const dir = contour >= 0 ? 1.5 : 0.65;
        s.tone({ t: st, f: ff, f2: ff * dir, d, peak: p.peak * 0.6, type: v.fmIndex > 0 ? 'triangle' : 'sine', a: 0.004 });
      }
      break;
    }
    case 'squeak':
      tract(s, 0, { ...base, wave: 'square', f0: f0 * 0.8, fPeak: f0 * 1.3, f1: f0 * 0.9 * down, peakAt: 0.4, dur: Math.min(0.25, p.dur * 0.25), rough: 0, breath: 0.1, vib: 0, formants: F(f0 * 1.1 / fs, f0 * 2.4 / fs), attack: 0.01 });
      break;
    case 'trill':
      tract(s, 0, { ...base, wave: 'sine', f0, fPeak: f0 * (1 + contour * 0.25), f1: f0 * 0.9, peakAt: 0.6, dur: p.dur * 0.6, rough: 0, breath: 0.05, formants: F(f0 / fs, f0 * 2 / fs), attack: 0.02, gate: { rate: 18 + v.pulseRate * 2, duty: 0.6 } });
      break;
    case 'hiss': {
      const fc = 3500 * fs;
      s.burst({ dur: p.dur * 0.8, f: fc, f2: fc * (contour > 0 ? 1.3 : 0.8), q: 1.2, peak: p.peak * 0.9, a: p.dur * 0.1, color: 'white' });
      s.burst({ dur: p.dur * 0.8, f: fc * 1.8, q: 2, peak: p.peak * 0.4, a: 0.02 });
      break;
    }
    case 'click': {
      const n = 4 + p.pulses * 3;
      const rate = 10 + v.pulseRate * 2.5;
      for (let i = 0; i < n; i++) s.burst({ t: i / rate + s.r(0, 0.008), dur: 0.006, f: 2400 * fs * s.r(0.9, 1.1), q: 6, peak: p.peak * 1.2, a: 0.0005 });
      break;
    }
    case 'drone':
      tract(s, 0, { ...base, wave: 'sawtooth', f0, fPeak: f0 * (1 + contour * 0.15), f1: f0 * 0.95, peakAt: 0.5, dur: p.dur, rough: 0.7, roughRate: 30 + v.roughRate, breath: 0.05, vib: 30, formants: F(f0 * 3 / fs, f0 * 6 / fs), attack: p.dur * 0.2 });
      break;
    case 'croak': {
      const n = Math.max(1, Math.min(3, p.pulses));
      for (let i = 0; i < n; i++) {
        tract(s, i * 0.22, { ...base, wave: 'square', f0, fPeak: f0 * 1.05, f1: f0 * 0.85, peakAt: 0.3, dur: p.dur * 0.3, rough: 0.9, roughRate: 35 + v.roughRate * 0.5, breath: 0.1, vib: 0, formants: F(500, 1300), attack: 0.01 });
      }
      break;
    }
  }
}

/** Situation-specific kind, pitch, duration and loudness. */
function situate(v: CreatureVoice, sit: CallSituation, size: number): CallParams {
  const kind = sit === 'attack' || sit === 'alert' ? (sit === 'alert' && v.primary !== 'chirp' ? v.primary : v.aggressive) : v.primary;
  const sizePitch = Math.pow(Math.max(0.05, size), -0.6);
  const kf = KIND_F0[kind] || 200;
  let f0 = Math.min(9000, Math.max(25, kf * v.pitchMul * sizePitch));
  const fs = Math.min(3, Math.max(0.35, v.formantMul * Math.pow(Math.max(0.05, size), -0.45)));
  let dur = Math.min(3.5, (0.5 + Math.pow(size, 0.4) * 0.6) * v.durMul);
  let contour = v.contour;
  let peak = 0.5;
  switch (sit) {
    case 'idle':
      dur *= 0.8;
      peak = 0.35;
      break;
    case 'alert':
      contour = Math.max(0.3, contour);
      peak = 0.5;
      break;
    case 'attack':
      dur *= 0.75;
      peak = 0.7;
      break;
    case 'pain':
      f0 *= 1.35;
      dur *= 0.4;
      contour = -0.8;
      peak = 0.6;
      break;
    case 'death':
      dur *= 1.6;
      contour = -1;
      peak = 0.55;
      break;
  }
  return { kind, f0, fs, dur, contour, peak, v, pulses: sit === 'pain' ? 1 : v.pulses };
}

const defCache = new Map<string, SoundDef>();

/** Quantize size so similar creatures share banks. */
export function sizeBucket(size: number): number {
  return Math.round(Math.log2(Math.max(0.05, size)) * 3) / 3;
}

/** SoundDef + bank key for a creature call. */
export function creatureCallDef(faunaSeed: number, species: number, size: number, sit: CallSituation, weirdness: number): { key: string; def: SoundDef } {
  const b = sizeBucket(size);
  const key = `cr:${faunaSeed}:${species}:${b}:${sit}`;
  let def = defCache.get(key);
  if (!def) {
    const qs = Math.pow(2, b);
    const v = creatureVoice(faunaSeed, species, qs, weirdness);
    const p = situate(v, sit, qs);
    const dur = Math.min(5, p.dur * 1.5 + (p.kind === 'hoot' || p.kind === 'croak' ? 1 : 0.4) + 0.3);
    def = sd({
      dur, variants: 3, group: 'creature', gain: 0.9, ref: 2 + qs * 2.2, range: 70 + qs * 70, jitter: 0.07, priority: sit === 'death' || sit === 'attack' ? 1.6 : 1, reverb: 1,
      render: (s) => call(s, p),
    });
    defCache.set(key, def);
  }
  return { key, def };
}

/** Raw render (for ambience: distant howls etc.). */
export function renderCreatureCall(s: Synth, faunaSeed: number, species: number, size: number, sit: CallSituation, weirdness: number): number {
  const v = creatureVoice(faunaSeed, species, size, weirdness);
  const p = situate(v, sit, size);
  call(s, p);
  return p.dur;
}
