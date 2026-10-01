/**
 * Procedural convolution reverb.
 *
 * Impulse responses are synthesized (two-band exponentially decaying noise +
 * early reflection taps + optional slap echo) for a handful of acoustic
 * spaces. The listener probe picks a space; we crossfade between two
 * ConvolverNodes so switching never clicks.
 */
import { toBuffer } from './dsp';

export type SpaceKind = 'open' | 'forest' | 'mountain' | 'cave' | 'cavern' | 'underworld' | 'indoor' | 'hall' | 'crystal' | 'underwater';

export interface SpaceSpec {
  /** Low-band RT60 (s). */
  decay: number;
  /** High-band decay as fraction of `decay` (air/foliage absorption). */
  hfRatio: number;
  predelay: number;
  /** Early reflection count, spread (s) and level. */
  early: number;
  earlySpread: number;
  earlyGain: number;
  /** Overall IR lowpass (Hz). */
  tone: number;
  /** Default wet send level for this space. */
  wet: number;
  /** Discrete echo (mountain walls, vast caverns). */
  echo?: { delay: number; gain: number; repeats: number };
}

export const SPACES: Record<SpaceKind, SpaceSpec> = {
  // Open air: a hint of ground reflection, short diffuse tail.
  open: { decay: 0.7, hfRatio: 0.45, predelay: 0.006, early: 3, earlySpread: 0.03, earlyGain: 0.35, tone: 7000, wet: 0.12 },
  // Forest: many soft scattered reflections, trunks diffuse, leaves eat highs.
  forest: { decay: 1.3, hfRatio: 0.35, predelay: 0.012, early: 14, earlySpread: 0.09, earlyGain: 0.3, tone: 5200, wet: 0.24 },
  // Mountains/canyons: open with a distinct delayed echo off distant walls.
  mountain: { decay: 0.9, hfRatio: 0.4, predelay: 0.01, early: 4, earlySpread: 0.05, earlyGain: 0.25, tone: 6000, wet: 0.16, echo: { delay: 0.42, gain: 0.32, repeats: 2 } },
  cave: { decay: 2.2, hfRatio: 0.55, predelay: 0.008, early: 18, earlySpread: 0.05, earlyGain: 0.55, tone: 6500, wet: 0.38 },
  cavern: { decay: 4.2, hfRatio: 0.5, predelay: 0.025, early: 12, earlySpread: 0.14, earlyGain: 0.4, tone: 5200, wet: 0.45, echo: { delay: 0.31, gain: 0.18, repeats: 2 } },
  underworld: { decay: 7.5, hfRatio: 0.35, predelay: 0.05, early: 10, earlySpread: 0.3, earlyGain: 0.3, tone: 3600, wet: 0.5, echo: { delay: 0.85, gain: 0.22, repeats: 3 } },
  indoor: { decay: 0.55, hfRatio: 0.6, predelay: 0.003, early: 10, earlySpread: 0.018, earlyGain: 0.6, tone: 8000, wet: 0.22 },
  hall: { decay: 1.6, hfRatio: 0.6, predelay: 0.012, early: 12, earlySpread: 0.05, earlyGain: 0.45, tone: 7500, wet: 0.3 },
  // Crystal/ice caves: bright, glassy, long highs.
  crystal: { decay: 3.2, hfRatio: 1.05, predelay: 0.01, early: 20, earlySpread: 0.06, earlyGain: 0.5, tone: 12000, wet: 0.42 },
  underwater: { decay: 1.1, hfRatio: 0.2, predelay: 0.002, early: 6, earlySpread: 0.01, earlyGain: 0.5, tone: 1400, wet: 0.5 },
};

/** Generate a stereo impulse response for a space (plain JS, a few ms). */
export function generateIR(sampleRate: number, spec: SpaceSpec, rand: () => number = Math.random): AudioBuffer {
  const tail = spec.decay * 1.15 + spec.predelay + (spec.echo ? spec.echo.delay * (spec.echo.repeats + 1) : 0);
  const n = Math.floor(sampleRate * Math.min(9, tail + 0.1));
  const chans: Float32Array[] = [];
  const lpCoef = 1 - Math.exp((-2 * Math.PI * 550) / sampleRate);
  const toneCoef = 1 - Math.exp((-2 * Math.PI * spec.tone) / sampleRate);
  const kLow = -6.9078 / (spec.decay * sampleRate);
  const kHigh = -6.9078 / (spec.decay * spec.hfRatio * sampleRate);
  const pre = Math.floor(spec.predelay * sampleRate);
  const build = Math.floor(0.02 * sampleRate);
  for (let c = 0; c < 2; c++) {
    const a = new Float32Array(n);
    let lp = 0;
    let tl = 0;
    for (let i = pre; i < n; i++) {
      const j = i - pre;
      const w = rand() * 2 - 1;
      lp += (w - lp) * lpCoef;
      const hi = w - lp;
      let v = lp * 2.2 * Math.exp(kLow * j) + hi * Math.exp(kHigh * j);
      // Diffuse tail builds up over the first ~20 ms.
      if (j < build) v *= j / build;
      tl += (v - tl) * toneCoef;
      a[i] = tl;
    }
    // Early reflections: sparse taps with decreasing level, decorrelated per ear.
    for (let e = 0; e < spec.early; e++) {
      const t = spec.predelay + Math.pow(rand(), 1.4) * spec.earlySpread;
      const idx = Math.floor(t * sampleRate);
      if (idx >= n - 4) continue;
      const g = spec.earlyGain * (1 - (t - spec.predelay) / (spec.earlySpread * 1.3)) * (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.4);
      // Smeared tap (3 samples) sounds less "digital" than a single spike.
      a[idx] += g * 0.6;
      a[idx + 1] += g;
      a[idx + 2] += g * 0.4;
    }
    // Slap echoes: low-passed copies of the early part.
    if (spec.echo) {
      const seg = Math.min(n, Math.floor(0.08 * sampleRate));
      for (let r = 1; r <= spec.echo.repeats; r++) {
        const off = Math.floor((spec.echo.delay * r + (c ? 0.013 * r : 0)) * sampleRate);
        const g = Math.pow(spec.echo.gain, r);
        let el = 0;
        for (let i = 0; i < seg && off + i < n; i++) {
          el += (a[i + pre] - el) * 0.25;
          a[off + i] += el * g * 3;
        }
      }
    }
    chans.push(a);
  }
  // Normalize energy so spaces differ by character, not loudness.
  let e = 0;
  for (const a of chans) for (let i = 0; i < n; i++) e += a[i] * a[i];
  const norm = 1 / Math.sqrt(e / 2 + 1e-9) * 0.9;
  for (const a of chans) for (let i = 0; i < n; i++) a[i] *= norm;
  return toBuffer(chans, sampleRate);
}

/**
 * Two-slot convolution reverb with crossfading between spaces and a
 * continuous wet level.
 */
export class ReverbBus {
  readonly input: GainNode;
  readonly output: GainNode;
  private slots: { conv: ConvolverNode; gain: GainNode; kind: SpaceKind | null }[];
  private active = 0;
  private cache = new Map<SpaceKind, AudioBuffer>();
  kind: SpaceKind | null = null;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.output.connect(dest);
    // Pre-filter: keep sub-bass out of the reverb (mud) — subtle highpass.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    this.input.connect(hp);
    this.slots = [0, 1].map(() => {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      hp.connect(conv);
      conv.connect(gain);
      gain.connect(this.output);
      return { conv, gain, kind: null };
    });
  }

  private ir(kind: SpaceKind): AudioBuffer {
    let b = this.cache.get(kind);
    if (!b) {
      b = generateIR(this.ctx.sampleRate, SPACES[kind]);
      this.cache.set(kind, b);
    }
    return b;
  }

  /** Switch to a space (crossfade `fade` seconds). */
  setSpace(kind: SpaceKind, fade = 1.5): void {
    if (kind === this.kind) return;
    this.kind = kind;
    const now = this.ctx.currentTime;
    const next = 1 - this.active;
    const slot = this.slots[next];
    if (slot.kind !== kind) {
      // A convolver's buffer can only be swapped while it is silent (its gain is ~0 here).
      slot.conv.buffer = this.ir(kind);
      slot.kind = kind;
    }
    const cur = this.slots[this.active];
    cur.gain.gain.cancelScheduledValues(now);
    cur.gain.gain.setTargetAtTime(0, now, fade / 3);
    slot.gain.gain.cancelScheduledValues(now);
    slot.gain.gain.setTargetAtTime(1, now, fade / 3);
    this.active = next;
  }

  /** Overall reverb return level (smoothed). */
  setWet(v: number, tc = 0.6): void {
    this.output.gain.setTargetAtTime(v, this.ctx.currentTime, tc);
  }
}
