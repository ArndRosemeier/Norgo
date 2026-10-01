/**
 * Reusable sound-design gestures (whooshes, crackles, bubbles, creaks,
 * debris...) composed from Synth primitives, plus SoundDef construction
 * defaults. Every recipe in sounds/* is built from these.
 */
import type { Synth } from '../dsp';
import type { SoundDef } from '../engine';

/** Modal partial tables: [ratio, amplitude, decay seconds]. */
export type Partials = readonly (readonly [number, number, number])[];

export const METAL: Partials = [[1, 1, 0.9], [2.32, 0.6, 0.6], [4.25, 0.45, 0.42], [6.63, 0.3, 0.3], [9.38, 0.18, 0.2], [12.6, 0.1, 0.12]];
export const BELL: Partials = [[0.5, 0.5, 2.2], [1, 1, 1.8], [1.19, 0.35, 1.2], [1.5, 0.4, 1.0], [2, 0.3, 0.8], [2.74, 0.2, 0.6], [3.76, 0.12, 0.4]];
export const WOOD: Partials = [[1, 1, 0.1], [2.57, 0.45, 0.06], [4.1, 0.25, 0.04], [6.3, 0.1, 0.025]];
export const GLASS: Partials = [[1, 1, 0.55], [2.76, 0.6, 0.38], [5.4, 0.42, 0.24], [8.93, 0.25, 0.15]];
export const STONE: Partials = [[1, 1, 0.05], [1.71, 0.6, 0.035], [3.13, 0.35, 0.025], [4.9, 0.2, 0.015]];
export const ICE: Partials = [[1, 1, 0.3], [2.9, 0.5, 0.18], [6.1, 0.3, 0.1]];

/** SoundDef with sensible defaults. */
export function sd(o: Partial<SoundDef> & Pick<SoundDef, 'dur' | 'render'>): SoundDef {
  return {
    variants: 4, bus: 'sfx', group: 'foley', gain: 1, ref: 2, range: 90, jitter: 0.05, reverb: 1, priority: 1, ...o,
  };
}

/**
 * Air whoosh: bandpassed noise whose centre frequency sweeps up then down
 * with an amplitude swell (blade/limb/arrow moving past).
 */
export function whoosh(s: Synth, t: number, dur: number, fLo: number, fHi: number, peak: number, q = 2.5, color: 'white' | 'pink' = 'pink', dest?: AudioNode): void {
  const T = s.t + t;
  const g = s.gain(0, dest ?? s.out);
  const f = s.filter('bandpass', fLo, q, g);
  const peakAt = dur * s.r(0.35, 0.55);
  f.frequency.setValueAtTime(fLo, T);
  f.frequency.exponentialRampToValueAtTime(fHi, T + peakAt);
  f.frequency.exponentialRampToValueAtTime(fLo * 0.8, T + dur);
  g.gain.setValueAtTime(0, T);
  g.gain.linearRampToValueAtTime(peak * 0.25, T + peakAt * 0.6);
  g.gain.linearRampToValueAtTime(peak, T + peakAt);
  g.gain.exponentialRampToValueAtTime(0.0005, T + dur);
  s.noiseSrc(color, T, dur, f);
}

/** Random crackles (fire, frost, electricity, splinters). */
export function crackles(s: Synth, t: number, dur: number, count: number, fLo: number, fHi: number, peak: number, dest?: AudioNode): void {
  for (let i = 0; i < count; i++) {
    const tt = t + Math.pow(s.rand(), 1.3) * dur;
    s.burst({ t: tt, dur: s.r(0.003, 0.018), f: s.r(fLo, fHi), q: s.r(1, 4), peak: peak * s.r(0.3, 1), a: 0.0004, dest });
  }
}

/** Water bubbles: short sines with an upward chirp (Minnaert resonance). */
export function bubbles(s: Synth, t: number, dur: number, count: number, fLo: number, fHi: number, peak: number, dest?: AudioNode): void {
  for (let i = 0; i < count; i++) {
    const f = s.r(fLo, fHi);
    const d = s.r(0.02, 0.07);
    s.tone({ t: t + s.rand() * dur, f, f2: f * s.r(1.3, 2.2), a: 0.002, d, peak: peak * s.r(0.4, 1), dest });
  }
}

/** Granular crunch (snow, gravel, sand): rapid irregular bandpass bursts. */
export function crunch(s: Synth, t: number, dur: number, grains: number, fLo: number, fHi: number, peak: number, q = 1.5, dest?: AudioNode): void {
  for (let i = 0; i < grains; i++) {
    const tt = t + (i / grains) * dur + s.r(-0.004, 0.004);
    const env = Math.sin(Math.PI * Math.min(1, (i + 0.5) / grains));
    s.burst({ t: Math.max(0, tt), dur: s.r(0.004, 0.02), f: s.r(fLo, fHi), q, peak: peak * env * s.r(0.4, 1), a: 0.0008, dest });
  }
}

/**
 * Stick-slip creak (wood, leather, rope): a pulse train with a wandering rate
 * through resonant body filters.
 */
export function creak(s: Synth, t: number, dur: number, rate0: number, rate1: number, body: number, peak: number, dest?: AudioNode): void {
  const T = s.t + t;
  const o = s.osc('sawtooth', rate0, T, dur);
  o.frequency.setValueAtTime(rate0, T);
  o.frequency.linearRampToValueAtTime((rate0 + rate1) * 0.5 * s.r(0.8, 1.2), T + dur * 0.5);
  o.frequency.linearRampToValueAtTime(rate1, T + dur);
  const g = s.gain(0, dest ?? s.out);
  const b1 = s.filter('bandpass', body, 8, g);
  const b2 = s.filter('bandpass', body * s.r(2.1, 2.9), 10, g);
  const hp = s.filter('highpass', 80, 0.7);
  o.connect(hp);
  hp.connect(b1);
  hp.connect(b2);
  g.gain.setValueAtTime(0, T);
  g.gain.linearRampToValueAtTime(peak, T + dur * 0.15);
  g.gain.setValueAtTime(peak, T + dur * 0.7);
  g.gain.linearRampToValueAtTime(0, T + dur);
}

/** Bouncing debris: a series of small modal clacks with shrinking gaps. */
export function debris(s: Synth, t: number, count: number, f: number, partials: Partials, peak: number, spread = 1.2, dest?: AudioNode): void {
  let tt = t;
  for (let i = 0; i < count; i++) {
    tt += s.r(0.02, 0.18) * spread * (1 - (i / count) * 0.6);
    const ff = f * s.r(0.6, 1.8);
    s.modal(tt, ff, partials, peak * s.r(0.2, 1) * (1 - (i / count) * 0.5), dest, 0.03);
    s.click(tt, ff * 3, peak * 0.3, dest);
  }
}

/** Low rumble: brown noise lowpassed with a swell envelope. */
export function rumble(s: Synth, t: number, dur: number, f: number, peak: number, attack = 0.3, dest?: AudioNode): void {
  const T = s.t + t;
  const g = s.gain(0, dest ?? s.out);
  const lp = s.filter('lowpass', f, 0.9, g);
  g.gain.setValueAtTime(0, T);
  g.gain.linearRampToValueAtTime(peak, T + attack);
  g.gain.exponentialRampToValueAtTime(0.0005, T + dur);
  s.noiseSrc('brown', T, dur, lp);
}

/** Dispersive chirp — the "pew" of cracking ice/tension (high → low sine). */
export function chirpDown(s: Synth, t: number, f0: number, f1: number, d: number, peak: number, dest?: AudioNode): void {
  s.tone({ t, f: f0, f2: f1, glide: d * 0.8, a: 0.0008, d, peak, dest });
}

/** Breath/whisper: noise through two vowel-ish formants. */
export function breath(s: Synth, t: number, dur: number, f1: number, f2: number, peak: number, dest?: AudioNode): void {
  const T = s.t + t;
  const g = s.gain(0, dest ?? s.out);
  const a = s.filter('bandpass', f1, 5, g);
  const b = s.filter('bandpass', f2, 6, g);
  const src = s.noiseSrc('white', T, dur);
  src.connect(a);
  src.connect(b);
  g.gain.setValueAtTime(0, T);
  g.gain.linearRampToValueAtTime(peak, T + dur * 0.3);
  g.gain.linearRampToValueAtTime(0, T + dur);
}

/** Note number (semitones from A4) → Hz. */
export function hz(semi: number): number {
  return 440 * Math.pow(2, semi / 12);
}
