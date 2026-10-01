/**
 * Adaptive score routing — the pure, data-driven half of the stem layer
 * (no WebAudio here, so it runs headless in `tools/selftest.ts`).
 *
 *  - Manifest contract & validation for `public/assets/audio/music/manifest.json`
 *    (written by `tools/music/build_stems.py`).
 *  - The ONE table that maps game context to stem sets (biome → exploration
 *    set, settlement race → settlement set, cave / underworld / night /
 *    combat / boss) plus fallbacks for sets that are missing.
 *  - Per-world flavour: preferred variation per layer, a global playback-rate
 *    shift, optional biome → set remaps for weird worlds.
 *  - Tuning policy: pitched stems only for 12-TET-compatible MusicThemes.
 *  - `StemSelector`: context → stable set id with hysteresis and dwell times so
 *    biome borders, dusk and short skirmishes don't flap the score.
 */
import { Biome, BIOME_COUNT } from '../world/biomes';
import { Rng, deriveSeed, hashString, hash32 } from '../core/rng';

// ------------------------------------------------------------------ manifest contract

export type StemLayer = 'drone' | 'texture' | 'melody' | 'perc';
export const STEM_LAYERS: readonly StemLayer[] = ['drone', 'texture', 'melody', 'perc'];
/** Layers locked to the set's beat grid (start time matters); the others are free-time. */
export const LOCKED_LAYERS: readonly StemLayer[] = ['texture', 'perc'];

export interface StemSetInfo {
  id: string;
  tonic: string;
  mode: string;
  tonicHz: number;
  scaleCents: number[];
  /**
   * Degrees shared by the set's mode and its plain major/minor key (the generator
   * sometimes renders modes as plain major/minor). In-key accents use these so they
   * never clash. Falls back to scaleCents for older manifests.
   */
  safeCents: number[];
  bpm: number;
  beatsPerBar: number;
  bars: number;
  /** Exact length of every file in the set (s, at playbackRate 1). */
  loopSeconds: number;
  /** File paths relative to the manifest's folder. `drone` is always non-empty. */
  layers: Record<StemLayer, string[]>;
}

export interface StemManifest {
  version: number;
  sampleRate: number;
  sets: Record<string, StemSetInfo>;
}

const finite = (x: unknown, min = -Infinity): x is number => typeof x === 'number' && isFinite(x) && x > min;

/**
 * Validate a parsed manifest. Malformed sets are dropped individually (the
 * pipeline writes the manifest progressively); returns null when nothing usable
 * is left.
 */
export function parseManifest(raw: unknown): StemManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !r.sets || typeof r.sets !== 'object') return null;
  const sets: Record<string, StemSetInfo> = {};
  for (const [id, sv] of Object.entries(r.sets as Record<string, unknown>)) {
    if (!sv || typeof sv !== 'object') continue;
    const s = sv as Record<string, unknown>;
    if (!finite(s.tonicHz, 0) || !finite(s.bpm, 0) || !finite(s.loopSeconds, 1) || !finite(s.beatsPerBar, 0) || !finite(s.bars, 0)) continue;
    if (!Array.isArray(s.scaleCents) || !s.scaleCents.length || !s.scaleCents.every((c) => finite(c))) continue;
    const safe = Array.isArray(s.safeCents) && s.safeCents.length && s.safeCents.every((c) => finite(c)) ? (s.safeCents as number[]) : (s.scaleCents as number[]);
    const lr = (s.layers ?? {}) as Record<string, unknown>;
    const layers = {} as Record<StemLayer, string[]>;
    for (const l of STEM_LAYERS) {
      const a = lr[l];
      // Paths must stay inside the music folder.
      layers[l] = Array.isArray(a) ? a.filter((p): p is string => typeof p === 'string' && p.length > 0 && !p.includes('..') && !/^[a-z]+:|^\//i.test(p)) : [];
    }
    if (!layers.drone.length) continue;
    sets[id] = {
      id, tonic: String(s.tonic ?? '?'), mode: String(s.mode ?? '?'), tonicHz: s.tonicHz, scaleCents: s.scaleCents as number[], safeCents: safe,
      bpm: s.bpm, beatsPerBar: Math.round(s.beatsPerBar), bars: Math.round(s.bars), loopSeconds: s.loopSeconds, layers,
    };
  }
  if (!Object.keys(sets).length) return null;
  return { version: 1, sampleRate: finite(r.sampleRate, 0) ? r.sampleRate : 48000, sets };
}

// ------------------------------------------------------------------ routing table (the one place)

export type StemCategory = 'explore' | 'night' | 'cave' | 'under' | 'settlement' | 'combat' | 'boss';

export const EXPLORATION_SETS = ['meadow', 'woodland', 'jungle', 'highland', 'desert', 'coast', 'wonder', 'ember'] as const;

/** Surface & underworld biome → set. Chosen from the biomes' look and the sets' intent (tools/music/sets.py). */
const BIOME_SET_TABLE: [Biome, string][] = [
  [Biome.Ocean, 'coast'],
  [Biome.Grassland, 'meadow'],
  [Biome.Savanna, 'meadow'],
  [Biome.TemperateForest, 'woodland'],
  [Biome.Taiga, 'woodland'],
  [Biome.Jungle, 'jungle'],
  [Biome.Swamp, 'jungle'],
  [Biome.Desert, 'desert'],
  [Biome.Badlands, 'desert'],
  [Biome.SaltFlats, 'desert'],
  [Biome.Tundra, 'highland'],
  [Biome.Glacier, 'highland'],
  [Biome.KarstPillars, 'highland'],
  [Biome.FloatingIsles, 'coast'],
  [Biome.CrystalWastes, 'wonder'],
  [Biome.FungalGrove, 'wonder'],
  [Biome.Volcanic, 'ember'],
  // underworld
  [Biome.GlowCaverns, 'underglow'],
  [Biome.Geodes, 'underglow'],
  [Biome.RootCathedral, 'underglow'],
  [Biome.UnderSea, 'underglow'],
  [Biome.MagmaDepths, 'underdread'],
  [Biome.BoneHollows, 'underdread'],
];

/** Settlement culture (RaceId of the site) → set. */
export const RACE_STEM_SET: Readonly<Record<string, string>> = {
  human: 'hearth', halfling: 'hearth', giantkin: 'hearth',
  elf: 'sylvan', sylvan: 'sylvan',
  dwarf: 'forge', drakeborn: 'forge',
  orc: 'wild', goblin: 'wild', umbral: 'wild',
};

export const SPECIAL_SETS = { night: 'night', cave: 'cave', combat: 'combat', boss: 'boss', underDefault: 'underglow' } as const;

/** Exploration sets that keep their identity above the snow line (they are already "extreme"). */
const ALPINE_KEEPS = new Set(['ember', 'wonder']);

/**
 * When a set is missing (still generating, failed to decode), use this instead.
 * '@explore' = the biome's exploration set; null = no stems (generative score carries).
 * A wrong-mood stem is worse than the generative score, so exploration sets fall back to null.
 */
const FALLBACK: Readonly<Record<string, string | null>> = {
  boss: 'combat', combat: null,
  underglow: 'cave', underdread: 'cave', cave: null,
  hearth: '@explore', sylvan: '@explore', forge: '@explore', wild: '@explore',
  night: '@explore',
};

export function categoryOfSet(id: string): StemCategory {
  if (id === 'boss' || id === 'combat') return id;
  if (id === 'night') return 'night';
  if (id === 'cave') return 'cave';
  if (id === 'underglow' || id === 'underdread') return 'under';
  if (id === 'hearth' || id === 'sylvan' || id === 'forge' || id === 'wild') return 'settlement';
  return 'explore';
}

// ------------------------------------------------------------------ tuning policy

/**
 * Which stems a world may use, decided by its generative MusicTheme tuning:
 *  - 'full': 12-TET-compatible (octave exactly 1200 cents, every degree a whole
 *    semitone) → all layers; the generative score steps back to retuned accents.
 *  - 'perc': anything else (n-EDO, harmonic/just, Bohlen-Pierce, slendro, pelog,
 *    stretched octaves) → pitched stems would clash with the world's own tuning,
 *    so only the unpitched perc layer plays and the generative score stays in full
 *    (its beat clock locks to the stem grid, its own percussion steps aside).
 */
export type StemTuningPolicy = 'full' | 'perc';

export function stemTuningPolicy(tuning: { scale: readonly number[]; octave: number }): StemTuningPolicy {
  if (Math.abs(tuning.octave - 1200) > 0.01) return 'perc';
  for (const c of tuning.scale) if (Math.abs(c / 100 - Math.round(c / 100)) > 0.005) return 'perc';
  return 'full';
}

// ------------------------------------------------------------------ per-world flavour

export interface StemWorldFlavor {
  /** Biome index → set id (after weird-world remaps). */
  biomeSet: string[];
  /** Global playback-rate shift in semitones (same for every stem → sync holds). */
  semitones: number;
  /** 2^(semitones/12). Also scales tempo. */
  rate: number;
  /** Biomes whose set was remapped (debug). */
  remapped: number;
  seed: number;
}

export function stemWorldFlavor(profile: { seed: number; weirdness: number }): StemWorldFlavor {
  const rng = new Rng(deriveSeed(profile.seed, 'stems'));
  const biomeSet: string[] = new Array(BIOME_COUNT).fill('meadow');
  for (const [b, s] of BIOME_SET_TABLE) biomeSet[b] = s;
  // ±0.35..1 semitone: every world sits in a slightly different key and tempo.
  const semitones = rng.sign() * rng.range(0.35, 1);
  // Strange worlds re-colour a few surface biomes with another exploration set.
  let remapped = 0;
  const w = profile.weirdness;
  if (w > 0.55) {
    const p = (w - 0.5) * 0.7;
    for (const [b] of BIOME_SET_TABLE) {
      if (b >= Biome.GlowCaverns || !rng.chance(p)) continue;
      biomeSet[b] = rng.pick(EXPLORATION_SETS);
      remapped++;
    }
  }
  return { biomeSet, semitones, rate: Math.pow(2, semitones / 12), remapped, seed: profile.seed };
}

/** Deterministic preferred variation of a layer for this world. */
export function preferredVariation(fl: StemWorldFlavor, setId: string, layer: StemLayer, count: number): number {
  if (count <= 1) return 0;
  return hash32((deriveSeed(fl.seed, 'stemvar') ^ hashString(setId + '/' + layer)) >>> 0) % count;
}

// ------------------------------------------------------------------ context → set (with hysteresis)

/** Game state the stem layer reacts to (AudioSystem fills one preallocated instance per frame). */
export interface StemContext {
  /** 0 night … 1 day. */
  day: number;
  /** Surface cave factor 0..1. */
  cave: number;
  underworld: number;
  /** Dominant biome (underworld biome while in the underworld). */
  biome: number;
  /** 0..1 above the local snow line (mountains). */
  alpine: number;
  storm: number;
  indoor: number;
  underwater: boolean;
  /** 0..1 inside a settlement. */
  settlement: number;
  /** RaceId of the settlement the player is in (null outside). */
  siteRace: string | null;
  /** Smoothed combat intensity 0..1. */
  combat: number;
  /** A boss is fighting the player. */
  boss: boolean;
  /** Player movement 0 idle … 0.35 walk … 0.7 run … 1 sprint. */
  move: number;
  /** MusicDirector is in a 'play' episode (exploration music respects its silences). */
  episode: boolean;
}

export function createStemContext(): StemContext {
  return {
    day: 1, cave: 0, underworld: 0, biome: Biome.Grassland, alpine: 0, storm: 0, indoor: 0, underwater: false,
    settlement: 0, siteRace: null, combat: 0, boss: false, move: 0, episode: false,
  };
}

/** Thresholds & times (s). */
const T = {
  combatOn: 0.42, combatOff: 0.2, combatHold: 3.5, bossHold: 6,
  settleOn: 0.3, settleOff: 0.12,
  caveOn: 0.55, caveOff: 0.3,
  nightOn: 0.3, nightOff: 0.55,
  alpineOn: 0.6, alpineOff: 0.3,
  /** Candidate must be stable this long before switching (by kind of change). */
  stableBiome: 6, stableNight: 4, stablePlace: 2.5,
  /** Minimum time on one exploration set before a biome change may replace it. */
  dwellBiome: 20,
};

export class StemSelector {
  /** Stable set id (null = no stems for this context). */
  current: string | null = null;
  category: StemCategory = 'explore';
  /** Raw (unstable) choice of the last update (debug). */
  raw: string | null = null;
  /** The last update wanted a set the manifest doesn't have (triggers a manifest re-check). */
  wantedMissing = false;
  private combatOn = false;
  private combatLow = 0;
  private bossOn = false;
  private bossOff = 0;
  private settleOn = false;
  private caveOn = false;
  private nightOn = false;
  private alpineOn = false;
  private pending: string | null = null;
  private pendingT = 0;
  private dwell = 0;
  private started = false;

  constructor(public flavor: StemWorldFlavor) {}

  /** Hysteresis on the individual context switches. */
  private latch(c: StemContext, dt: number) {
    if (c.boss) {
      this.bossOn = true;
      this.bossOff = 0;
    } else if (this.bossOn && (this.bossOff += dt) > T.bossHold) this.bossOn = false;
    if (c.combat >= T.combatOn || this.bossOn) {
      this.combatOn = true;
      this.combatLow = 0;
    } else if (this.combatOn) {
      this.combatLow = c.combat < T.combatOff ? this.combatLow + dt : 0;
      if (this.combatLow > T.combatHold) this.combatOn = false;
    }
    this.settleOn = this.settleOn ? c.settlement > T.settleOff && !!c.siteRace : c.settlement > T.settleOn && !!c.siteRace;
    this.caveOn = this.caveOn ? c.cave > T.caveOff : c.cave > T.caveOn;
    this.nightOn = this.nightOn ? c.day < T.nightOff : c.day < T.nightOn;
    this.alpineOn = this.alpineOn ? c.alpine > T.alpineOff : c.alpine > T.alpineOn;
  }

  private exploreSet(c: StemContext): string {
    const s = this.flavor.biomeSet[c.biome] ?? 'meadow';
    return this.alpineOn && !ALPINE_KEEPS.has(s) ? 'highland' : s;
  }

  /** Raw set for the current context, resolved through fallbacks against `has`. */
  private rawSet(c: StemContext, has: (id: string) => boolean): string | null {
    let want: string;
    if (this.bossOn) want = SPECIAL_SETS.boss;
    else if (this.combatOn) want = SPECIAL_SETS.combat;
    else if (c.underworld > 0.5) {
      const s = this.flavor.biomeSet[c.biome];
      want = s === 'underglow' || s === 'underdread' ? s : SPECIAL_SETS.underDefault;
    } else if (this.settleOn && c.siteRace) want = RACE_STEM_SET[c.siteRace] ?? 'hearth';
    else if (this.caveOn) want = SPECIAL_SETS.cave;
    else if (this.nightOn) want = SPECIAL_SETS.night;
    else want = this.exploreSet(c);
    // Resolve fallbacks (bounded: the chains are short and acyclic).
    let id: string | null = want;
    for (let i = 0; i < 4 && id !== null && !has(id); i++) {
      this.wantedMissing = true;
      const f: string | null | undefined = FALLBACK[id];
      id = f === undefined ? null : f === '@explore' ? this.exploreSet(c) : f;
    }
    return id !== null && has(id) ? id : null;
  }

  /** Advance; returns the stable set id. */
  update(dt: number, c: StemContext, has: (id: string) => boolean): string | null {
    this.wantedMissing = false;
    this.latch(c, dt);
    const raw = this.rawSet(c, has);
    this.raw = raw;
    this.dwell += dt;
    if (!this.started) {
      this.started = true;
      this.commit(raw);
      return this.current;
    }
    if (raw === this.current) {
      this.pending = null;
      return this.current;
    }
    if (raw !== this.pending) {
      this.pending = raw;
      this.pendingT = 0;
    } else this.pendingT += dt;
    const to = raw === null ? 'explore' : categoryOfSet(raw);
    const from = this.current === null ? 'explore' : categoryOfSet(this.current);
    let need: number;
    if (to === 'combat' || to === 'boss' || from === 'combat' || from === 'boss') need = 0; // combat exit already held by the latch
    else if (to === 'explore' && from === 'explore') need = this.dwell < T.dwellBiome ? Infinity : T.stableBiome;
    else if (to === 'night' || from === 'night') need = T.stableNight;
    else need = T.stablePlace;
    if (this.pendingT >= need) this.commit(raw);
    return this.current;
  }

  /** Drop combat/boss latches (player death). */
  reset(): void {
    this.combatOn = false;
    this.bossOn = false;
    this.combatLow = 0;
    this.bossOff = 0;
  }

  private commit(id: string | null) {
    this.current = id;
    this.category = id === null ? 'explore' : categoryOfSet(id);
    this.pending = null;
    this.pendingT = 0;
    this.dwell = 0;
  }
}
