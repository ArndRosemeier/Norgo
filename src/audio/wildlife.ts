/**
 * Per-world ambient wildlife voices: songbirds, night birds, gulls, crickets,
 * cicadas and frogs. Every world seed breeds its own species (song
 * structure, pitch, tempo, timbre, biome preferences), so the dawn chorus of
 * one world never sounds like another's.
 */
import type { Synth } from './dsp';
import { Rng, deriveSeed } from '../core/rng';
import { Biome, SURFACE_BIOMES, UNDERWORLD_BIOMES } from '../world/biomes';

export type BirdKind = 'whistle' | 'trill' | 'warble' | 'chirp' | 'coo' | 'gull' | 'caw' | 'hoot' | 'piper';

interface BirdNote {
  f0: number;
  f1: number;
  d: number;
  gap: number;
  shape: 'sweep' | 'trill' | 'harsh' | 'soft';
  am: number;
}

export interface BirdSpecies {
  id: number;
  kind: BirdKind;
  notes: BirdNote[];
  /** Times the motif repeats in a song. */
  repeats: number;
  repeatGap: number;
  /** Biomes where it lives (empty = anywhere with trees/grass). */
  biomes: Set<Biome>;
  night: boolean;
  coastal: boolean;
  /** Song duration estimate (s). */
  dur: number;
  /** Singing frequency multiplier. */
  rate: number;
  /** Alien timbre (FM) for weird worlds. */
  fm: number;
}

export interface InsectSpecies {
  /** Carrier (Hz), pulses per chirp, pulse rate, chirp period (s). */
  carrier: number;
  pulses: number;
  pulseRate: number;
  period: number;
}

export interface FrogSpecies {
  f0: number;
  pulses: number;
  pulseRate: number;
  formant: number;
  rough: number;
  dur: number;
}

export interface Wildlife {
  birds: BirdSpecies[];
  crickets: InsectSpecies[];
  cicada: { carrier: number; buzz: number; swell: number };
  frogs: FrogSpecies[];
  /** Species indices used for distant howls (creature voices). */
  howlers: number[];
}

const KIND_BASE: Record<BirdKind, [number, number]> = {
  whistle: [1800, 4200], trill: [3000, 6500], warble: [1800, 4000], chirp: [3200, 7500], coo: [280, 600], gull: [700, 1400], caw: [450, 900], hoot: [240, 460], piper: [2500, 5000],
};

function makeBird(rng: Rng, id: number, weird: number, night: boolean, coastal: boolean): BirdSpecies {
  const kind: BirdKind = night
    ? rng.pick(['hoot', 'hoot', 'whistle', 'coo'] as BirdKind[])
    : coastal
      ? 'gull'
      : rng.weighted(['whistle', 'trill', 'warble', 'chirp', 'coo', 'caw', 'piper'] as BirdKind[], (_, i) => [3, 2, 3, 3, 1, 1, 1.5][i]);
  const [lo, hi] = KIND_BASE[kind];
  const base = rng.range(lo, hi);
  const n = kind === 'hoot' || kind === 'coo' ? rng.int(2, 4) : kind === 'gull' || kind === 'caw' ? rng.int(1, 4) : rng.int(2, 7);
  const notes: BirdNote[] = [];
  let f = base;
  for (let i = 0; i < n; i++) {
    const shape: BirdNote['shape'] = kind === 'gull' || kind === 'caw' ? 'harsh' : kind === 'hoot' || kind === 'coo' ? 'soft' : kind === 'trill' && rng.chance(0.6) ? 'trill' : rng.chance(0.15) ? 'trill' : 'sweep';
    const sweep = shape === 'soft' ? rng.range(0.85, 1.12) : rng.range(0.55, 1.8);
    const d = shape === 'soft' ? rng.range(0.25, 0.6) : shape === 'harsh' ? rng.range(0.15, 0.35) : shape === 'trill' ? rng.range(0.15, 0.5) : rng.range(0.04, 0.22);
    notes.push({ f0: f, f1: f * sweep, d, gap: rng.range(0.03, shape === 'soft' ? 0.35 : 0.15), shape, am: rng.range(25, 70) });
    // Melodic contour: wander within ~an octave around base.
    f = Math.min(base * 1.9, Math.max(base * 0.6, f * rng.range(0.75, 1.3)));
  }
  const biomes = new Set<Biome>();
  const pool = SURFACE_BIOMES;
  const count = rng.int(3, 7);
  for (let i = 0; i < count; i++) biomes.add(rng.pick(pool));
  const motif = notes.reduce((s, x) => s + x.d + x.gap, 0);
  const repeats = kind === 'hoot' ? 1 : rng.int(1, kind === 'chirp' || kind === 'piper' ? 4 : 3);
  const repeatGap = rng.range(0.1, 0.5);
  return {
    id, kind, notes, repeats, repeatGap, biomes, night, coastal,
    dur: Math.min(6, (motif + repeatGap) * repeats + 0.3), rate: rng.range(0.6, 1.5),
    fm: rng.chance(weird * 0.6) ? rng.range(0.5, 3) : 0,
  };
}

/** Breed this world's wildlife voices. */
export function createWildlife(faunaSeed: number, weird: number): Wildlife {
  const rng = new Rng(deriveSeed(faunaSeed, 'wildlife-audio'));
  const birds: BirdSpecies[] = [];
  const dayCount = rng.int(4, 7);
  for (let i = 0; i < dayCount; i++) birds.push(makeBird(rng.fork('bird', i), birds.length, weird, false, false));
  const nightCount = rng.int(1, 2);
  for (let i = 0; i < nightCount; i++) birds.push(makeBird(rng.fork('night', i), birds.length, weird, true, false));
  birds.push(makeBird(rng.fork('gull'), birds.length, weird, false, true));
  const crickets: InsectSpecies[] = [];
  for (let i = 0; i < rng.int(1, 3); i++) {
    crickets.push({ carrier: rng.range(2800, 6200), pulses: rng.int(2, 6), pulseRate: rng.range(18, 45), period: rng.range(0.25, 1.1) });
  }
  const frogs: FrogSpecies[] = [];
  for (let i = 0; i < rng.int(1, 3); i++) {
    frogs.push({ f0: rng.range(90, 520), pulses: rng.int(1, 5), pulseRate: rng.range(6, 22), formant: rng.range(500, 1600), rough: rng.range(0.2, 1), dur: rng.range(0.15, 0.6) });
  }
  const howlers = [rng.int(0, 40), rng.int(0, 40), rng.int(0, 40)];
  return {
    birds, crickets, frogs, howlers,
    cicada: { carrier: rng.range(3500, 7500), buzz: rng.range(90, 260), swell: rng.range(2.5, 7) },
  };
}

/** Does a bird live in a biome? (Underground: none.) */
export function birdFits(b: BirdSpecies, biome: Biome): boolean {
  if (UNDERWORLD_BIOMES.includes(biome)) return false;
  return b.biomes.has(biome) || b.biomes.size === 0;
}

// ------------------------------------------------------------------ recipes

/** Render one bird song (mono). Variation: random note drops & transposition. */
export function renderBird(s: Synth, b: BirdSpecies): void {
  const tr = s.r(0.94, 1.06);
  let t = 0;
  for (let r = 0; r < b.repeats; r++) {
    for (const n of b.notes) {
      if (b.notes.length > 2 && s.chance(0.12)) {
        t += n.d * 0.5;
        continue;
      }
      const f0 = n.f0 * tr;
      const f1 = n.f1 * tr;
      const T = s.t + t;
      switch (n.shape) {
        case 'sweep':
        case 'soft': {
          const g = s.gain(0, s.out);
          const o = s.osc('sine', f0, T, n.d);
          o.frequency.setValueAtTime(f0, T);
          o.frequency.exponentialRampToValueAtTime(f1, T + n.d);
          if (b.fm > 0) {
            const m = s.osc('sine', f0 * b.fm, T, n.d);
            m.connect(s.gain(f0 * 0.6, o.frequency));
          }
          o.connect(g);
          const a = n.shape === 'soft' ? n.d * 0.3 : Math.min(0.012, n.d * 0.2);
          g.gain.setValueAtTime(0, T);
          g.gain.linearRampToValueAtTime(n.shape === 'soft' ? 0.35 : 0.25, T + a);
          g.gain.linearRampToValueAtTime(0, T + n.d);
          // Soft hoots get a breathy second harmonic.
          if (n.shape === 'soft') s.tone({ t, f: f0 * 2, f2: f1 * 2, a, d: n.d, peak: 0.04, lin: true });
          break;
        }
        case 'trill': {
          const g = s.gain(0, s.out);
          const o = s.osc('sine', f0, T, n.d);
          o.frequency.setValueAtTime(f0, T);
          o.frequency.linearRampToValueAtTime(f1, T + n.d);
          const am = s.gain(0.5);
          const lfo = s.osc('sine', n.am, T, n.d);
          lfo.connect(s.gain(0.5, am.gain));
          o.connect(am);
          am.connect(g);
          g.gain.setValueAtTime(0, T);
          g.gain.linearRampToValueAtTime(0.25, T + 0.02);
          g.gain.linearRampToValueAtTime(0, T + n.d);
          break;
        }
        case 'harsh': {
          // Gull/crow: harmonic-rich source through a nasal formant.
          const g = s.gain(0, s.out);
          const bp = s.filter('bandpass', f0 * 2.2, 3, g);
          const o = s.osc('sawtooth', f0, T, n.d);
          o.frequency.setValueAtTime(f0, T);
          o.frequency.exponentialRampToValueAtTime(f1, T + n.d);
          o.connect(bp);
          const nz = s.noiseSrc('pink', T, n.d);
          nz.connect(s.gain(0.3, bp));
          g.gain.setValueAtTime(0, T);
          g.gain.linearRampToValueAtTime(0.35, T + 0.02);
          g.gain.setValueAtTime(0.3, T + n.d * 0.6);
          g.gain.linearRampToValueAtTime(0, T + n.d);
          break;
        }
      }
      t += n.d + n.gap * s.r(0.8, 1.2);
    }
    t += b.repeatGap;
  }
}

/** Frog croak (mono). */
export function renderFrog(s: Synth, f: FrogSpecies): void {
  const per = 1 / f.pulseRate;
  for (let i = 0; i < f.pulses; i++) {
    const T = s.t + i * per * s.r(0.9, 1.1);
    const d = Math.min(per * 0.8, f.dur);
    const g = s.gain(0, s.out);
    const bp = s.filter('bandpass', f.formant, 4, g);
    const bp2 = s.filter('bandpass', f.formant * 2.3, 6, g);
    const o = s.osc('square', f.f0, T, d);
    o.frequency.setValueAtTime(f.f0 * 0.9, T);
    o.frequency.linearRampToValueAtTime(f.f0 * 1.08, T + d * 0.4);
    o.frequency.linearRampToValueAtTime(f.f0 * 0.95, T + d);
    const am = s.gain(1 - f.rough * 0.5);
    const lfo = s.osc('square', 40 + f.f0 * 0.1, T, d);
    lfo.connect(s.gain(f.rough * 0.5, am.gain));
    o.connect(am);
    am.connect(bp);
    am.connect(bp2);
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(0.45, T + 0.01);
    g.gain.linearRampToValueAtTime(0, T + d);
  }
}

/** Seamless stereo cricket bed with several individuals (rendered as a loop). */
export function renderCrickets(s: Synth, species: InsectSpecies[], seconds: number): void {
  const n = 5;
  for (let k = 0; k < n; k++) {
    const sp = species[k % species.length];
    const pan = s.stereo(s.r(-0.9, 0.9), s.out);
    const g = s.gain(s.r(0.15, 0.6), pan);
    const car = sp.carrier * s.r(0.97, 1.03);
    const period = sp.period * s.r(0.9, 1.1);
    for (let t = s.r(0, period); t < seconds; t += period * s.r(0.95, 1.05)) {
      for (let p = 0; p < sp.pulses; p++) {
        s.tone({ t: t + p / sp.pulseRate, f: car, d: 0.6 / sp.pulseRate, a: 0.002, peak: 0.12, dest: g, lin: true });
      }
    }
  }
}

/** Cicada buzz bed (stereo loop). */
export function renderCicadas(s: Synth, c: Wildlife['cicada'], seconds: number): void {
  for (let k = 0; k < 3; k++) {
    const pan = s.stereo(s.r(-0.8, 0.8), s.out);
    const T = s.t;
    const g = s.gain(0, pan);
    const bp = s.filter('bandpass', c.carrier * s.r(0.9, 1.1), 4, g);
    const am = s.gain(0.5, bp);
    const buzz = s.osc('sawtooth', c.buzz * s.r(0.95, 1.05), T, seconds);
    buzz.connect(s.gain(0.5, am.gain));
    s.noiseSrc('white', T, seconds, am);
    // Slow swells (pattern repeats exactly so the loop folds cleanly).
    const sw = c.swell * s.r(0.8, 1.2);
    g.gain.setValueAtTime(0, T);
    for (let t = s.r(0, sw); t < seconds - 0.5; t += sw) {
      g.gain.linearRampToValueAtTime(s.r(0.15, 0.4), T + t + sw * 0.4);
      g.gain.linearRampToValueAtTime(0.02, T + t + sw * 0.9);
    }
  }
}
