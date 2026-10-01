/**
 * Generative ambient score.
 *
 * A `MusicTheme` is derived deterministically from the WorldProfile: tuning
 * (12-TET modes for mundane worlds; stretched octaves, n-EDO, just-intonation
 * or Bohlen-Pierce scales for strange ones), tempo, meter, instrument
 * timbres, drum patterns (Euclidean) and per-biome key shifts.
 *
 * The `MusicDirector` plays it live: sparse episodes separated by silence,
 * Markov chord progressions, motif-based melodies that mutate (transpose,
 * invert, retrograde, augment, ornament) and are regularly replaced, and
 * layers (drone, pad, lead, arpeggio, bass, choir, bells, percussion) whose
 * presence follows the mood: biome, day/night, underground, combat.
 * Note-level choices are cosmetic randomness, so it never repeats.
 */
import type { WorldProfile } from '../world/profile';
import { Biome, BIOME_COUNT } from '../world/biomes';
import { Rng, deriveSeed } from '../core/rng';
import { clamp, lerp } from '../core/math';
import type { AudioEngine } from './engine';
import { karplus, toBuffer } from './dsp';
import { generateIR } from './reverb';
import type { UiTuning } from './sounds/ui';

export type LeadInstrument = 'bell' | 'pluck' | 'flute' | 'glass' | 'kalimba' | 'choir';

export interface MusicTheme {
  tuning: UiTuning;
  /** Human readable scale name (debug/sandbox). */
  scaleName: string;
  tempo: number;
  meter: number;
  swing: number;
  padWave: OscillatorType;
  padDetune: number;
  padBright: number;
  leadDay: LeadInstrument;
  leadNight: LeadInstrument;
  leadDeep: LeadInstrument;
  bellRatio: number;
  /** Euclidean drum patterns [hits, steps] for low drum, frame drum, shaker. */
  drums: [number, number][];
  drumTone: number;
  /** Per biome transposition (scale degrees). */
  biomeShift: number[];
  density: number;
  weird: number;
}

const MODES: [string, number[]][] = [
  ['ionian', [0, 200, 400, 500, 700, 900, 1100]],
  ['dorian', [0, 200, 300, 500, 700, 900, 1000]],
  ['aeolian', [0, 200, 300, 500, 700, 800, 1000]],
  ['lydian', [0, 200, 400, 600, 700, 900, 1100]],
  ['mixolydian', [0, 200, 400, 500, 700, 900, 1000]],
  ['major pentatonic', [0, 200, 400, 700, 900]],
  ['minor pentatonic', [0, 300, 500, 700, 1000]],
  ['phrygian', [0, 100, 300, 500, 700, 800, 1000]],
  ['harmonic minor', [0, 200, 300, 500, 700, 800, 1100]],
  ['hirajoshi', [0, 200, 300, 700, 800]],
  ['in-sen', [0, 100, 500, 700, 1000]],
  ['phrygian dominant', [0, 100, 400, 500, 700, 800, 1000]],
];

function centsOf(r: number): number {
  return 1200 * Math.log2(r);
}

/** Pick a tuning; strangeness grows with world weirdness. */
function pickTuning(rng: Rng, weird: number): { scale: number[]; octave: number; name: string } {
  const roll = rng.float();
  if (weird > 0.6 && roll < (weird - 0.45) * 1.3) {
    const kind = rng.int(0, 4);
    if (kind === 0) {
      // n-EDO subset
      const edo = rng.pick([5, 7, 9, 13, 17, 19, 22]);
      const step = 1200 / edo;
      const count = Math.min(edo, rng.int(5, 7));
      const idx = new Set<number>([0]);
      while (idx.size < count) idx.add(rng.int(1, edo - 1));
      return { scale: [...idx].sort((a, b) => a - b).map((i) => i * step), octave: 1200, name: `${edo}-EDO` };
    }
    if (kind === 1) {
      // Harmonic-series (just) scale with septimal/undecimal colour.
      const pool = [9 / 8, 5 / 4, 11 / 8, 3 / 2, 13 / 8, 7 / 4, 15 / 8, 7 / 6, 21 / 16];
      const picks = rng.sample(pool, rng.int(4, 6)).map(centsOf).sort((a, b) => a - b);
      return { scale: [0, ...picks], octave: 1200, name: 'harmonic just' };
    }
    if (kind === 2) {
      // Bohlen-Pierce: the "octave" is a tritave (3:1).
      const bp = 1902 / 13;
      const steps = [0, 2, 3, 4, 6, 7, 9, 10, 12].filter((s) => s === 0 || rng.chance(0.7));
      return { scale: steps.map((s) => s * bp), octave: 1902, name: 'Bohlen-Pierce' };
    }
    if (kind === 3) {
      // Slendro-like near-equal pentatonic with a stretched octave.
      const o = rng.range(1210, 1240);
      return { scale: [0, 1, 2, 3, 4].map((i) => (i * o) / 5 + rng.range(-25, 25) * (i ? 1 : 0)), octave: o, name: 'slendro' };
    }
    // Pelog-like uneven heptatonic.
    const pel = [0, 120, 270, 540, 670, 785, 950];
    return { scale: pel.map((c, i) => c + (i ? rng.range(-20, 20) : 0)), octave: 1200 + rng.range(0, 30), name: 'pelog' };
  }
  const [name, sc] = MODES[Math.floor(rng.float() * (weird > 0.35 ? MODES.length : 9))];
  // Mildly odd worlds: stretched octaves (gamelan/piano-like inharmonicity).
  const octave = weird > 0.35 && rng.chance(weird) ? rng.range(1205, 1230) : 1200;
  return { scale: sc.map((c) => (c * octave) / 1200), octave, name };
}

/** Deterministic theme for a world. */
export function createTheme(p: WorldProfile): MusicTheme {
  const rng = new Rng(deriveSeed(p.seed, 'music'));
  const weird = p.weirdness;
  const t = pickTuning(rng, weird);
  const root = 110 * Math.pow(2, rng.int(0, 11) / 12) * (rng.chance(0.5) ? 1 : 2);
  const leads: LeadInstrument[] = ['bell', 'pluck', 'flute', 'glass', 'kalimba'];
  const biomeShift: number[] = [];
  const n = t.scale.length;
  for (let b = 0; b < BIOME_COUNT; b++) biomeShift[b] = rng.chance(0.55) ? 0 : rng.pick([-3, -2, -1, 1, 2, 3, 4].map((d) => Math.round((d * n) / 7)));
  const euclid = (): [number, number] => {
    const steps = rng.pick([8, 12, 16, 10, 14]);
    return [rng.int(Math.floor(steps / 4), Math.floor(steps / 2)), steps];
  };
  return {
    tuning: { root: root < 150 ? root * 2 : root, scale: t.scale, octave: t.octave },
    scaleName: t.name,
    tempo: rng.range(54, 88) * (weird > 0.7 ? rng.range(0.8, 1.15) : 1),
    meter: weird > 0.5 && rng.chance(0.5) ? rng.pick([5, 7, 3]) : rng.pick([4, 4, 3, 6]),
    swing: rng.chance(0.4) ? rng.range(0.05, 0.18) : 0,
    padWave: rng.pick(['sawtooth', 'triangle', 'square', 'sawtooth'] as OscillatorType[]),
    padDetune: rng.range(4, 18),
    padBright: rng.range(0.6, 1.4),
    leadDay: rng.pick(leads),
    leadNight: rng.pick(['bell', 'glass', 'flute', 'kalimba'] as LeadInstrument[]),
    leadDeep: rng.pick(['choir', 'glass', 'bell'] as LeadInstrument[]),
    bellRatio: weird > 0.5 ? rng.pick([1.41, 2.76, 3.5, 4.2, 1.73]) : rng.pick([2, 3.5, 4]),
    drums: [euclid(), euclid(), euclid()],
    drumTone: rng.range(0.7, 1.4),
    biomeShift,
    density: rng.range(0.35, 0.8),
    weird,
  };
}

/** Biome musical flavour: lead override, percussion, choir, bells, tempo, brightness. */
interface Flavor {
  lead?: LeadInstrument;
  perc: number;
  choir: number;
  bells: number;
  tempo: number;
  bright: number;
  dark: number;
}
const F = (o: Partial<Flavor>): Flavor => ({ perc: 0, choir: 0, bells: 0, tempo: 1, bright: 1, dark: 0, ...o });
const FLAVORS: Partial<Record<Biome, Flavor>> = {
  [Biome.Grassland]: F({ bright: 1.1 }),
  [Biome.TemperateForest]: F({ lead: 'flute' }),
  [Biome.Taiga]: F({ bells: 0.4, tempo: 0.9, dark: 0.2 }),
  [Biome.Jungle]: F({ lead: 'kalimba', perc: 0.3 }),
  [Biome.Savanna]: F({ lead: 'pluck', perc: 0.35 }),
  [Biome.Desert]: F({ lead: 'pluck', perc: 0.4, dark: 0.2 }),
  [Biome.Badlands]: F({ lead: 'pluck', perc: 0.3, dark: 0.2 }),
  [Biome.Tundra]: F({ lead: 'glass', bells: 0.4, tempo: 0.85, bright: 0.9 }),
  [Biome.Glacier]: F({ lead: 'glass', bells: 0.7, tempo: 0.8 }),
  [Biome.Swamp]: F({ lead: 'flute', choir: 0.3, dark: 0.5, bright: 0.7 }),
  [Biome.Volcanic]: F({ perc: 0.5, choir: 0.3, dark: 0.8, bright: 0.6 }),
  [Biome.CrystalWastes]: F({ lead: 'glass', bells: 0.8, bright: 1.3 }),
  [Biome.FungalGrove]: F({ lead: 'kalimba', choir: 0.2, dark: 0.3 }),
  [Biome.FloatingIsles]: F({ lead: 'bell', bells: 0.5, bright: 1.3, tempo: 0.9 }),
  [Biome.KarstPillars]: F({ lead: 'flute', perc: 0.15 }),
  [Biome.SaltFlats]: F({ lead: 'glass', bells: 0.3, tempo: 0.8 }),
  [Biome.GlowCaverns]: F({ lead: 'kalimba', choir: 0.4, dark: 0.4 }),
  [Biome.Geodes]: F({ lead: 'glass', bells: 0.8, choir: 0.3 }),
  [Biome.MagmaDepths]: F({ perc: 0.5, choir: 0.4, dark: 0.9, bright: 0.5 }),
  [Biome.UnderSea]: F({ lead: 'glass', choir: 0.5, dark: 0.6, bright: 0.6 }),
  [Biome.BoneHollows]: F({ lead: 'choir', choir: 0.7, dark: 1, bright: 0.5 }),
  [Biome.RootCathedral]: F({ lead: 'choir', choir: 0.6, dark: 0.3 }),
};
const DEFAULT_FLAVOR = F({});

export interface MusicMood {
  /** 0 night … 1 day. */
  day: number;
  underground: number;
  underworld: number;
  /** 0..1 combat intensity. */
  combat: number;
  biome: Biome;
  storm: number;
  indoor: number;
}

/**
 * What the adaptive stem layer (stems.ts) is currently playing, so the generative
 * score can step back and stay in key / in time. Filled in place every frame.
 *
 *  - `pitched` (12-TET worlds): stems carry the harmony → drone, pad, arpeggio,
 *    bass, choir and percussion are muted; only sparse lead/bells remain at
 *    `accent` level, retuned to the stem key (`rootHz`, `scale` = the set's
 *    safe degrees) with the chord locked to the tonic.
 *  - not pitched (perc-only worlds with exotic tunings): the full generative score
 *    plays; only its percussion yields to the stem perc (`perc`).
 *  - `beatDur > 0`: the stem set is beat-locked; the director's beat clock follows
 *    its grid (`gridT0` = context time of a downbeat) so notes land on the stems' beat.
 */
export interface ScoreAccompaniment {
  active: boolean;
  pitched: boolean;
  /** Stem percussion audible. */
  perc: boolean;
  rootHz: number;
  scale: number[];
  /** 0..1 lead/bells level while pitched stems play. */
  accent: number;
  /** 0 while the stem melody plays (the generative lead answers in its rests). */
  leadGate: number;
  gridT0: number;
  beatDur: number;
  beatsPerBar: number;
}

interface Note {
  deg: number;
  beats: number;
}

/** Euclidean rhythm (Bjorklund via bresenham form). */
function euclid(k: number, n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + 1) * k) / n) !== Math.floor((i * k) / n));
  return out;
}

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();
const pick = <T,>(a: readonly T[]): T => a[Math.floor(R() * a.length)];

export class MusicDirector {
  readonly theme: MusicTheme;
  private ctx: AudioContext | null = null;
  private input!: GainNode;
  private tone!: BiquadFilterNode;
  private layer!: Record<'drone' | 'pad' | 'lead' | 'arp' | 'bass' | 'perc' | 'choir' | 'bells', GainNode>;
  private droneOsc: OscillatorNode[] = [];
  private droneTarget = 0;
  // ---- state
  private mode: 'rest' | 'play' = 'rest';
  private modeTimer = rr(6, 14);
  private nextBeat = 0;
  private beat = 0;
  private bar = 0;
  private chordRoot = 0;
  private chordBars = 2;
  private leadFree = 0;
  private motif: Note[] = [];
  private motifUses = 0;
  private shift = 0;
  private shiftTarget = 0;
  private mood: MusicMood = { day: 1, underground: 0, underworld: 0, combat: 0, biome: Biome.Grassland, storm: 0, indoor: 0 };
  private intensity = 0;
  private patterns: boolean[][];
  private pluckCache = new Map<string, AudioBuffer>();
  /** Debug: force playing (sandbox). */
  forcePlay = false;
  /** Stem layer state (null = no stems; set by AudioSystem). */
  private acc: ScoreAccompaniment | null = null;
  private gridT0 = -1;
  private gridDur = 0;
  /** Time (s) the director has been resting (for requestEpisode). */
  private restFor = 0;

  constructor(private engine: AudioEngine, profile: WorldProfile) {
    this.theme = createTheme(profile);
    this.patterns = this.theme.drums.map(([k, n]) => euclid(k, n));
    this.newMotif();
  }

  private ensureGraph(): boolean {
    const ctx = this.engine.ctx;
    if (!ctx) return false;
    if (this.ctx === ctx) return true;
    // New context (first start, or recreated): reset clock-bound state.
    this.ctx = ctx;
    this.nextBeat = 0;
    this.droneOsc = [];
    this.droneTarget = 0;
    this.leadFree = 0;
    this.input = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 6000;
    this.tone.Q.value = 0.5;
    this.input.connect(this.tone);
    this.tone.connect(this.engine.bus.music);
    // Dedicated long, soft hall for the score (independent of the world space).
    const conv = ctx.createConvolver();
    conv.buffer = generateIR(ctx.sampleRate, { decay: 4.2, hfRatio: 0.55, predelay: 0.03, early: 8, earlySpread: 0.08, earlyGain: 0.25, tone: 6000, wet: 0.5 });
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.tone.connect(conv);
    conv.connect(wet);
    wet.connect(this.engine.bus.music);
    const mk = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.input);
      return g;
    };
    this.layer = { drone: mk(), pad: mk(), lead: mk(), arp: mk(), bass: mk(), perc: mk(), choir: mk(), bells: mk() };
    return true;
  }

  /** Pitched stems are playing: follow their key and keep out of their way. */
  private accompanied(): boolean {
    return !!this.acc && this.acc.active && this.acc.pitched;
  }

  /** Is an episode playing (exploration stems follow this rhythm of music and silence)? */
  get playing(): boolean {
    return this.mode === 'play';
  }

  /** Feed the stem layer's state (or null when stems are off). */
  setAccompaniment(a: ScoreAccompaniment | null): void {
    this.acc = a;
  }

  /**
   * Arrival cue (entering a settlement, the underworld…): start an episode early if
   * the current silence has lasted at least `minRest` seconds.
   */
  requestEpisode(minRest = 20): void {
    if (this.mode === 'rest' && this.restFor >= minRest) this.modeTimer = 0;
  }

  /** Beats per bar (the stem grid's while locked). */
  private meter(): number {
    const a = this.acc;
    return a && a.active && a.beatDur > 0 ? a.beatsPerBar : this.theme.meter;
  }

  /** Current scale with a darkening alteration for night/underground in 12-TET modes. */
  private scale(): number[] {
    if (this.accompanied()) return this.acc!.scale;
    const sc = this.theme.tuning.scale;
    const dark = this.darkness();
    if (dark > 0.6 && sc.length === 7 && this.theme.tuning.octave === 1200 && sc[2] === 400) {
      return sc.map((c, i) => (i === 2 || i === 5 ? c - 100 : c));
    }
    return sc;
  }

  private darkness(): number {
    const m = this.mood;
    const fl = this.flavor();
    return clamp((1 - m.day) * 0.6 + m.underground * 0.5 + m.underworld * 0.4 + fl.dark * 0.5 + m.storm * 0.3, 0, 1);
  }

  private flavor(): Flavor {
    return FLAVORS[this.mood.biome] ?? DEFAULT_FLAVOR;
  }

  /** Frequency of a scale degree relative to the current key/register. */
  private hz(deg: number, octShift = 0): number {
    const tu = this.theme.tuning;
    const sc = this.scale();
    const n = sc.length;
    if (this.accompanied()) {
      // Stem key: tonic (×playbackRate) lifted into the lead register; plain 1200-cent octaves.
      let root = this.acc!.rootHz;
      while (root < 180) root *= 2;
      const oct = Math.floor(deg / n) + octShift;
      const idx = ((deg % n) + n) % n;
      return root * Math.pow(2, (oct * 1200 + sc[idx]) / 1200);
    }
    const d = deg + this.shift;
    const oct = Math.floor(d / n) + octShift - (this.mood.underworld > 0.5 ? 1 : 0);
    const idx = ((d % n) + n) % n;
    return tu.root * Math.pow(2, (oct * tu.octave + sc[idx]) / 1200);
  }

  setMood(m: MusicMood): void {
    this.mood = m;
  }

  update(dt: number): void {
    if (!this.engine.running || !this.ensureGraph()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const m = this.mood;
    const fl = this.flavor();
    // Combat intensity is smoothed so music doesn't flap.
    this.intensity += (m.combat - this.intensity) * (1 - Math.exp(-dt * (m.combat > this.intensity ? 2 : 0.25)));
    const combat = this.intensity;

    // ---- episode state machine: sparse, with silences
    this.modeTimer -= dt;
    if (this.forcePlay && this.mode === 'rest') { this.mode = 'play'; this.modeTimer = rr(120, 240); }
    if (combat > 0.3 && this.mode === 'rest') {
      this.mode = 'play';
      this.modeTimer = 30;
    }
    if (this.modeTimer <= 0) {
      if (this.mode === 'play' && combat < 0.2 && !this.forcePlay) {
        this.mode = 'rest';
        this.modeTimer = rr(45, 150) * (m.underground > 0.5 ? 0.7 : 1);
      } else {
        this.mode = 'play';
        this.modeTimer = rr(100, 240);
        if (R() < 0.5) this.newMotif();
      }
    }
    this.restFor = this.mode === 'rest' ? this.restFor + dt : 0;
    const playing = this.mode === 'play' ? 1 : 0;
    const acc = this.acc && this.acc.active ? this.acc : null;
    // Pitched stems carry the harmony: everything but sparse lead/bells steps back.
    const bed = acc && acc.pitched ? 0 : 1;
    const accent = acc && acc.pitched ? acc.accent : 1;
    const ownPerc = acc && (acc.pitched || acc.perc) ? 0 : 1;

    // ---- layer levels (smoothed through setTargetAtTime)
    const dark = this.darkness();
    const day = m.day * (1 - m.underground);
    const set = (g: GainNode, v: number, tc = 2.5) => g.gain.setTargetAtTime(v, now, tc);
    const calm = 1 - combat;
    set(this.layer.drone, bed * playing * (0.06 + 0.06 * dark + 0.06 * combat));
    set(this.layer.pad, bed * playing * (0.12 * calm + 0.08 * combat) * (1 - m.indoor * 0.3));
    set(this.layer.lead, accent * (acc && acc.pitched ? acc.leadGate : 1) * playing * 0.22 * (0.6 + 0.4 * calm), acc ? 1.5 : 2.5);
    set(this.layer.arp, bed * playing * (0.1 * day * calm + 0.16 * combat));
    set(this.layer.bass, bed * playing * (0.1 * day + 0.2 * combat) * (1 - m.underworld * 0.3));
    set(this.layer.perc, ownPerc * playing * clamp(fl.perc * 0.3 * calm + combat * 0.7, 0, 1) * 0.6, 1.2);
    set(this.layer.choir, bed * playing * clamp(fl.choir + m.underground * 0.4 + m.underworld * 0.4, 0, 1) * 0.14 * (0.5 + 0.5 * calm));
    set(this.layer.bells, accent * playing * clamp(fl.bells + (1 - m.day) * 0.3 + (acc && acc.pitched ? 0.25 : 0), 0, 1) * 0.14);
    // Brightness: day, flavour, theme; darker underground; muffled indoors.
    const bright = this.theme.padBright * fl.bright * lerp(0.55, 1, day) * (1 - m.underground * 0.25) * (1 - m.indoor * 0.3) * (1 + combat * 0.3);
    this.tone.frequency.setTargetAtTime(clamp(1800 + bright * 5000, 800, 12000), now, 2);

    this.updateDrone(now, bed * playing, dark);

    // ---- beat clock (follows the stem grid while a beat-locked set plays)
    const grid = acc && acc.beatDur > 0 ? acc : null;
    let beatDur: number;
    let swing = this.theme.swing;
    if (grid) {
      beatDur = grid.beatDur;
      swing = 0;
      if (grid.gridT0 !== this.gridT0 || grid.beatDur !== this.gridDur) {
        // Re-align to the next grid beat after what is already scheduled.
        this.gridT0 = grid.gridT0;
        this.gridDur = grid.beatDur;
        const from = Math.max(now + 0.05, this.nextBeat);
        const k = Math.max(0, Math.ceil((from - grid.gridT0) / beatDur - 1e-6));
        this.nextBeat = grid.gridT0 + k * beatDur;
        this.beat = k;
      }
    } else {
      this.gridT0 = -1;
      this.gridDur = 0;
      beatDur = 60 / (this.theme.tempo * fl.tempo * (1 - (1 - m.day) * 0.1) * (1 + combat * 0.3));
    }
    if (this.nextBeat < now) this.nextBeat = now + 0.05;
    while (this.nextBeat < now + 0.3) {
      if (playing || combat > 0.05) this.onBeat(this.nextBeat, beatDur);
      const sw = this.beat % 2 === 0 ? 1 + swing : 1 - swing;
      this.nextBeat += beatDur * sw;
      this.beat++;
    }
  }

  private updateDrone(now: number, playing: number, dark: number) {
    const ctx = this.ctx!;
    const want = (playing > 0 || this.intensity > 0.2) && !this.accompanied();
    if (want && !this.droneOsc.length) {
      // Root + fifth-ish (scale degree ~ 4/7 of the octave) + sub; slow beating.
      const sc = this.scale();
      const fifth = Math.round(sc.length * 0.57);
      const freqs = [this.hz(0, -2), this.hz(0, -2) * 1.003, this.hz(fifth, -2)];
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300 + (1 - dark) * 400;
      lp.connect(this.layer.drone);
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.type = this.theme.weird > 0.6 ? 'square' : 'sawtooth';
        o.frequency.value = f;
        o.connect(lp);
        o.start();
        this.droneOsc.push(o);
      }
      this.droneTarget = 0;
    } else if (!want && this.droneOsc.length && (this.layer.drone.gain.value < 0.003)) {
      for (const o of this.droneOsc) o.stop();
      this.droneOsc = [];
    }
    if (this.droneOsc.length && this.droneTarget !== this.shift) {
      this.droneTarget = this.shift;
      const sc = this.scale();
      const fifth = Math.round(sc.length * 0.57);
      const f0 = this.hz(0, -2);
      const fs = [f0, f0 * 1.003, this.hz(fifth, -2)];
      this.droneOsc.forEach((o, i) => o.frequency.setTargetAtTime(fs[i], now, 3));
    }
  }

  // ---------------------------------------------------------------- composition

  private onBeat(t: number, beatDur: number) {
    const meter = this.meter();
    const b = this.beat % meter;
    const combat = this.intensity;
    if (b === 0) this.onBar(t, beatDur);
    if (this.accompanied()) {
      // Under pitched stems only sparse accents remain (lead phrases start in onBar).
      if (this.layer.bells.gain.value > 0.01 && R() < 0.07) {
        this.bell(this.layer.bells, t + (R() < 0.5 ? 0 : beatDur * 0.5), this.hz(pick(this.chordDegrees()), 1), 0.35 + R() * 0.25, 3.5);
      }
      return;
    }
    // Arpeggio / ostinato (eighths)
    const day = this.mood.day * (1 - this.mood.underground);
    const arpP = combat > 0.3 ? 0.9 : this.theme.density * day * 0.45;
    for (let h = 0; h < 2; h++) {
      const tt = t + h * beatDur * 0.5;
      if (R() < arpP * (h ? 0.6 : 1)) {
        const chord = this.chordDegrees();
        const deg = combat > 0.3 ? (R() < 0.6 ? chord[0] : chord[2]) : pick(chord) + (R() < 0.3 ? this.theme.tuning.scale.length : 0);
        this.pluck(this.layer.arp, tt, this.hz(deg, combat > 0.3 ? -1 : 0), 0.5 + R() * 0.3);
      }
    }
    // Percussion (sixteenth grid mapped over Euclidean patterns)
    if (this.layer.perc.gain.value > 0.01 || combat > 0.2) {
      for (let q = 0; q < 2; q++) {
        const step = this.beat * 2 + q;
        const tt = t + q * beatDur * 0.5;
        const [low, frame, shaker] = this.patterns;
        if (low[step % low.length]) this.drumLow(tt, b === 0 && q === 0 ? 1 : 0.7);
        if (frame[step % frame.length] && R() < 0.85) this.drumFrame(tt, 0.5 + R() * 0.3);
        if (shaker[step % shaker.length] && combat > 0.2) this.shaker(tt, 0.3 + R() * 0.3);
      }
    }
    // Night bells: star-like random high notes
    if (this.layer.bells.gain.value > 0.02 && R() < 0.12) {
      this.bell(this.layer.bells, t + R() * beatDur, this.hz(pick(this.chordDegrees()), 1), 0.4 + R() * 0.3, 3.5);
    }
  }

  private chordDegrees(): number[] {
    const n = this.scale().length;
    const r = this.chordRoot;
    // Stack scale thirds (or fourths-ish in pentatonic/odd scales).
    const step = n >= 7 ? 2 : n >= 5 ? 2 : 1;
    const deg = [r, r + step, r + step * 2];
    if (this.intensity > 0.4) deg.push(r + 1); // tension cluster in combat
    return deg;
  }

  private onBar(t: number, beatDur: number) {
    this.bar++;
    const n = this.scale().length;
    const barDur = beatDur * this.meter();
    if (this.accompanied()) {
      // The stems own the harmony: stay on the tonic, no pads/bass/choir.
      this.chordRoot = 0;
      this.leadPhrase(t, beatDur, barDur, 0.2 + this.theme.density * 0.2);
      return;
    }
    // Key shift by biome (modulate at bar lines only)
    this.shiftTarget = this.theme.biomeShift[this.mood.biome] ?? 0;
    if (this.shift !== this.shiftTarget && this.bar % this.chordBars === 0) this.shift = this.shiftTarget;
    if (this.bar % this.chordBars === 0) {
      // Markov chord walk with tonic gravity.
      const opts = [0, 3, 4, -2, 2, 5, 1, -3];
      const w = [this.chordRoot === 0 ? 0.3 : 2.2, 3, 3, 1.5, 1.4, 1, 0.6, 1];
      let tot = 0;
      for (const x of w) tot += x;
      let roll = R() * tot;
      let off = 0;
      for (let i = 0; i < opts.length; i++) {
        roll -= w[i];
        if (roll <= 0) {
          off = opts[i];
          break;
        }
      }
      this.chordRoot = off === 0 ? 0 : (((this.chordRoot + off) % n) + n) % n;
      if (this.chordRoot > n / 2 + 1) this.chordRoot -= n;
      this.chordBars = pick([2, 2, 3, 4]);
      const dur = barDur * this.chordBars;
      const chord = this.chordDegrees();
      this.pad(t, chord.map((d) => this.hz(d, -1)), dur + 2.5);
      if (this.layer.choir.gain.value > 0.01) this.choir(t, chord.slice(0, 3).map((d) => this.hz(d, -1)), dur + 2);
      this.bass(t, this.hz(this.chordRoot, -2), dur * 0.9);
    }
    this.leadPhrase(t, beatDur, barDur, 0.35 + this.theme.density * 0.4);
  }

  private leadPhrase(t: number, beatDur: number, barDur: number, p: number) {
    if (t < this.leadFree || this.layer.lead.gain.value <= 0.02 || R() >= p) return;
    const phrase = this.nextPhrase();
    let tt = t;
    const inst = this.leadInstrument();
    for (const note of phrase) {
      const d = note.beats * beatDur;
      if (note.deg > -99) this.leadNote(inst, tt, this.hz(note.deg), d);
      tt += d;
    }
    // Leave room to breathe after a phrase (more under stems: accents, not a second melody).
    this.leadFree = tt + barDur * (1 + Math.floor(R() * 3)) * (this.accompanied() ? 2 : 1);
  }

  private leadInstrument(): LeadInstrument {
    const m = this.mood;
    // (The choir lead routes through the choir layer, which pitched stems mute.)
    if (m.underground > 0.5 || m.underworld > 0.5) return this.theme.leadDeep === 'choir' && this.accompanied() ? 'glass' : this.theme.leadDeep;
    const fl = this.flavor();
    if (m.day < 0.4) return this.theme.leadNight;
    return fl.lead && R() < 0.6 ? fl.lead : this.theme.leadDay;
  }

  private newMotif() {
    const n = this.theme.tuning.scale.length;
    const len = 3 + Math.floor(R() * 4);
    const out: Note[] = [];
    let d = Math.floor(R() * n * 0.6);
    for (let i = 0; i < len; i++) {
      out.push({ deg: d, beats: pick([0.5, 1, 1, 1, 1.5, 2]) });
      const stepRoll = R();
      d += stepRoll < 0.35 ? 1 : stepRoll < 0.6 ? -1 : stepRoll < 0.75 ? 2 : stepRoll < 0.88 ? -2 : 3;
      d = clamp(d, -2, n + 3);
    }
    out[out.length - 1].beats += 1.5;
    this.motif = out;
    this.motifUses = 0;
  }

  /** Motif or a mutation of it; motifs retire after a few uses. */
  private nextPhrase(): Note[] {
    this.motifUses++;
    if (this.motifUses > 3 + Math.floor(R() * 4)) this.newMotif();
    const m = this.motif.map((x) => ({ ...x }));
    const r = R();
    if (this.motifUses === 1 || r < 0.2) return m;
    if (r < 0.4) return m.map((x) => ({ ...x, deg: x.deg + pick([-2, -1, 1, 2]) }));
    if (r < 0.55) {
      const pivot = m[0].deg;
      return m.map((x) => ({ ...x, deg: pivot - (x.deg - pivot) }));
    }
    if (r < 0.68) return m.reverse();
    if (r < 0.8) return m.map((x) => ({ ...x, beats: x.beats * 1.5 }));
    // Ornament: neighbour notes, and a cadence onto the chord root.
    const out: Note[] = [];
    for (const x of m) {
      if (R() < 0.4) {
        out.push({ deg: x.deg + 1, beats: 0.5 });
        out.push({ deg: x.deg, beats: Math.max(0.5, x.beats - 0.5) });
      } else out.push(x);
    }
    out.push({ deg: this.chordRoot, beats: 2 });
    return out;
  }

  // ---------------------------------------------------------------- instruments

  private env(g: GainNode, t: number, a: number, peak: number, hold: number, rel: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.linearRampToValueAtTime(0, t + a + hold + rel);
  }

  private pad(t: number, freqs: number[], dur: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(900 + this.theme.padBright * 900, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    lp.connect(g);
    g.connect(this.layer.pad);
    const end = t + dur + 0.1;
    for (const f of freqs) {
      for (const det of [-this.theme.padDetune, this.theme.padDetune]) {
        const o = ctx.createOscillator();
        o.type = this.theme.padWave;
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(end);
      }
    }
    this.env(g, t, Math.min(3, dur * 0.35), 0.12 / freqs.length * 2, dur * 0.3, dur * 0.35);
  }

  private choir(t: number, freqs: number[], dur: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(this.layer.choir);
    const vowel = pick([[650, 1080], [400, 800], [550, 1700]]);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = vowel[0];
    f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = vowel[1];
    f2.Q.value = 7;
    f1.connect(g);
    f2.connect(g);
    for (const f of freqs) {
      for (const det of [-9, 0, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det + (R() - 0.5) * 6;
        o.connect(f1);
        o.connect(f2);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
    }
    this.env(g, t, dur * 0.4, 0.35, dur * 0.2, dur * 0.4);
  }

  private bass(t: number, f: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    o.connect(g);
    g.connect(this.layer.bass);
    this.env(g, t, 0.08, 0.5, dur * 0.5, dur * 0.45);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  private leadNote(inst: LeadInstrument, t: number, f: number, d: number) {
    const L = this.layer.lead;
    const vel = 0.5 + R() * 0.35;
    switch (inst) {
      case 'bell':
        return this.bell(L, t, f, vel, Math.max(2, d * 2));
      case 'pluck':
        return this.pluck(L, t, f, vel);
      case 'kalimba':
        return this.kalimba(L, t, f, vel);
      case 'glass':
        return this.glass(L, t, f, vel, Math.max(2.5, d * 2));
      case 'flute':
        return this.flute(L, t, f, vel, d);
      case 'choir':
        return this.choir(t, [f], Math.max(1.5, d * 1.5));
    }
  }

  private bell(dest: AudioNode, t: number, f: number, vel: number, d: number) {
    const ctx = this.ctx!;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    car.frequency.value = f;
    mod.frequency.value = f * this.theme.bellRatio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 2, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + d);
    mod.connect(mg);
    mg.connect(car.frequency);
    const g = ctx.createGain();
    car.connect(g);
    g.connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + d);
    for (const o of [car, mod]) {
      o.start(t);
      o.stop(t + d + 0.05);
    }
  }

  private glass(dest: AudioNode, t: number, f: number, vel: number, d: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(dest);
    for (const [r, a] of [[1, 1], [2.76, 0.3], [5.4, 0.12]]) {
      if (f * r > 12000) continue;
      const o = ctx.createOscillator();
      o.frequency.value = f * r;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(0.18 * a * vel, t + 0.12);
      og.gain.exponentialRampToValueAtTime(0.0005, t + d / r);
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + d + 0.05);
    }
  }

  private kalimba(dest: AudioNode, t: number, f: number, vel: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(dest);
    for (const [r, a, d] of [[1, 1, 1.4], [5.9, 0.25, 0.15], [3.01, 0.08, 0.4]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * r;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(0.25 * a * vel, t + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0005, t + d);
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + d + 0.05);
    }
  }

  private flute(dest: AudioNode, t: number, f: number, vel: number, d: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(dest);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const s = ctx.createOscillator();
    s.frequency.value = f;
    const sg = ctx.createGain();
    sg.gain.value = 0.6;
    s.connect(sg);
    sg.connect(g);
    o.connect(g);
    // Delayed vibrato
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.8 + R();
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(14, t + Math.min(0.8, d * 0.6));
    lfo.connect(lg);
    lg.connect(o.detune);
    lg.connect(s.detune);
    // Breath
    const n = ctx.createBufferSource();
    n.buffer = this.engine.ctx ? noiseFor(ctx) : null;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2;
    bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.value = 0.25;
    n.connect(bp);
    bp.connect(ng);
    ng.connect(g);
    const hold = Math.max(0.05, d - 0.15);
    this.env(g, t, 0.07, 0.16 * vel, hold, 0.25);
    const end = t + d + 0.4;
    for (const x of [o, s, lfo]) {
      x.start(t);
      x.stop(end);
    }
    n.start(t, R());
    n.stop(end);
  }

  private pluck(dest: AudioNode, t: number, f: number, vel: number) {
    const ctx = this.ctx!;
    const key = f.toFixed(1);
    let buf = this.pluckCache.get(key);
    if (!buf) {
      buf = toBuffer([karplus(ctx.sampleRate, f, 2.2, 0.5 + this.theme.weird * 0.3, 0.35)], ctx.sampleRate);
      if (this.pluckCache.size > 160) this.pluckCache.clear();
      this.pluckCache.set(key, buf);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.35 * vel;
    src.connect(g);
    g.connect(dest);
    src.start(t);
  }

  private drumLow(t: number, vel: number) {
    const ctx = this.ctx!;
    const f = 70 * this.theme.drumTone;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * 1.8, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    const g = ctx.createGain();
    o.connect(g);
    g.connect(this.layer.perc);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.7 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.6);
    o.start(t);
    o.stop(t + 0.65);
  }

  private drumFrame(t: number, vel: number) {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = noiseFor(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 220 * this.theme.drumTone;
    bp.Q.value = 3;
    const g = ctx.createGain();
    n.connect(bp);
    bp.connect(g);
    g.connect(this.layer.perc);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * vel, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.25);
    n.start(t, R());
    n.stop(t + 0.3);
  }

  private shaker(t: number, vel: number) {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = noiseFor(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const g = ctx.createGain();
    n.connect(hp);
    hp.connect(g);
    g.connect(this.layer.perc);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.07);
    n.start(t, R());
    n.stop(t + 0.1);
  }

  /** Immediately fade everything (e.g. on dispose / player death). */
  silence(): void {
    if (!this.ctx) return;
    this.mode = 'rest';
    this.modeTimer = rr(20, 40);
    const now = this.ctx.currentTime;
    for (const g of Object.values(this.layer)) g.gain.setTargetAtTime(0, now, 0.8);
  }

  /** Debug info for the sandbox. */
  debug(): string {
    const a = this.acc && this.acc.active ? this.acc : null;
    const stems = a ? ` · under stems (${a.pitched ? `accents ${a.accent.toFixed(2)}${a.leadGate ? '' : ', lead resting'}` : 'perc'}${a.beatDur > 0 ? `, grid ${(60 / a.beatDur).toFixed(1)} bpm` : ''})` : '';
    return `${this.theme.scaleName} · ${this.theme.tempo.toFixed(0)} bpm · ${this.theme.meter}/4 · ${this.mode} (${this.modeTimer.toFixed(0)}s) · chord ${this.chordRoot} · combat ${this.intensity.toFixed(2)}${stems}`;
  }

  dispose(): void {
    for (const o of this.droneOsc) o.stop();
    this.droneOsc = [];
  }
}

const noiseBufs = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseFor(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBufs.get(ctx);
  if (!b) {
    const n = ctx.sampleRate * 2;
    b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseBufs.set(ctx, b);
  }
  return b;
}
