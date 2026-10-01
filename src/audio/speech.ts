/**
 * "Simlish" — procedural gibberish speech for NPCs.
 *
 * A small formant synthesizer: glottal pulse oscillator + breath noise through
 * three animated formant filters, plus a consonant noise channel. The actual
 * dialog text drives the syllables (its vowels pick formant targets, its
 * consonants pick onsets, punctuation shapes pauses & intonation), so a line
 * always "sounds like" itself while remaining unintelligible. Race, gender,
 * age, body scale, mood and speaking style shape pitch, timbre and cadence.
 */
import type { HumanoidAppearance } from '../humanoid/types';
import { hashString, hash32 } from '../core/rng';

export interface SpeechVoice {
  /** Mean pitch (Hz). */
  f0: number;
  /** Intonation range multiplier (1 = normal). */
  range: number;
  /** Formant scale (vocal tract length; >1 smaller/brighter). */
  formant: number;
  /** Syllables per second. */
  rate: number;
  /** Breathiness 0..1. */
  breath: number;
  /** Roughness/creak 0..1. */
  rough: number;
  /** Vibrato depth (cents). */
  vibrato: number;
  /** Sibilance emphasis (hissing races). */
  sib: number;
  /** Rolled R / trill on liquids 0..1. */
  trill: number;
  /** Vowel preference rotation (accent): index shift into the vowel table. */
  accent: number;
}

interface RaceVoice {
  f0: number;
  formant: number;
  rate: number;
  range: number;
  breath: number;
  rough: number;
  vibrato: number;
  sib: number;
  trill: number;
  accent: number;
}

/** Race baselines (multipliers on human f0 / formant). */
const RACES: Record<string, RaceVoice> = {
  human: { f0: 1, formant: 1, rate: 4.6, range: 1, breath: 0.08, rough: 0.05, vibrato: 0, sib: 1, trill: 0, accent: 0 },
  elf: { f0: 1.1, formant: 1.07, rate: 4.0, range: 1.5, breath: 0.25, rough: 0, vibrato: 12, sib: 0.8, trill: 0, accent: 1 },
  dwarf: { f0: 0.86, formant: 0.9, rate: 4.9, range: 0.9, breath: 0.08, rough: 0.25, vibrato: 0, sib: 1, trill: 0.8, accent: 3 },
  orc: { f0: 0.74, formant: 0.84, rate: 3.8, range: 0.8, breath: 0.2, rough: 0.6, vibrato: 0, sib: 0.7, trill: 0.4, accent: 4 },
  halfling: { f0: 1.22, formant: 1.14, rate: 5.6, range: 1.35, breath: 0.08, rough: 0, vibrato: 0, sib: 1, trill: 0, accent: 2 },
  goblin: { f0: 1.42, formant: 1.25, rate: 6.6, range: 1.6, breath: 0.12, rough: 0.25, vibrato: 0, sib: 1.3, trill: 0.2, accent: 1 },
  sylvan: { f0: 1.05, formant: 1.04, rate: 3.4, range: 1.3, breath: 0.5, rough: 0, vibrato: 18, sib: 1.2, trill: 0, accent: 2 },
  drakeborn: { f0: 0.7, formant: 0.86, rate: 3.6, range: 0.9, breath: 0.25, rough: 0.45, vibrato: 0, sib: 2.2, trill: 0.3, accent: 4 },
  umbral: { f0: 0.9, formant: 0.95, rate: 3.8, range: 0.7, breath: 0.55, rough: 0.1, vibrato: 25, sib: 1.4, trill: 0, accent: 3 },
  giantkin: { f0: 0.56, formant: 0.76, rate: 3.0, range: 0.85, breath: 0.15, rough: 0.3, vibrato: 0, sib: 0.8, trill: 0.2, accent: 4 },
};

/** Derive a voice from appearance (or race alone). Deterministic per appearance seed. */
export function speechVoice(race: string, app?: HumanoidAppearance, seed = 0): SpeechVoice {
  const r = RACES[race] ?? RACES.human;
  const r2 = app?.race2 ? RACES[app.race2] : undefined;
  const mix = r2 ? app!.raceMix : 0;
  const m = (k: keyof RaceVoice) => r[k] * (1 - mix) + (r2 ? r2[k] * mix : 0);
  const gender = app ? app.gender : (hash32(seed) & 1) ? 1 : 0;
  const age = app ? app.age : 0.5;
  const h = hash32((app?.seed ?? seed) ^ 0x5eec);
  const jit = (k: number) => 1 + (((h >>> (k * 4)) & 15) / 15 - 0.5) * 0.16;
  let f0 = (205 - 95 * gender) * m('f0') * jit(0);
  let formant = (1.16 - 0.16 * gender) * m('formant') * jit(1);
  let breath = m('breath');
  let vibrato = m('vibrato');
  let rate = m('rate') * jit(2);
  if (age < 0.2) {
    // Children: higher, smaller tract, quicker.
    const k = 1 - age / 0.2;
    f0 *= 1 + 0.6 * k;
    formant *= 1 + 0.25 * k;
    rate *= 1 + 0.1 * k;
  } else if (age > 0.7) {
    const k = (age - 0.7) / 0.3;
    breath += 0.15 * k;
    vibrato += 20 * k; // tremor
    rate *= 1 - 0.15 * k;
    f0 *= gender > 0.5 ? 1 - 0.06 * k : 1 - 0.1 * k;
  }
  if (app) formant /= Math.pow(Math.max(0.4, app.scale), 0.35);
  return {
    f0, formant, rate, breath: Math.min(0.9, breath), vibrato,
    range: m('range') * jit(3), rough: m('rough'), sib: m('sib'), trill: m('trill'), accent: Math.round(m('accent')),
  };
}

// ------------------------------------------------------------------ text → syllables

type Onset = 'none' | 'plosive' | 'fric' | 'sib' | 'nasal' | 'liquid';

interface Syl {
  onset: Onset;
  vowel: number;
  /** Relative stress 0..1. */
  stress: number;
  /** Pause after (s). */
  pause: number;
  /** Ends with a stop consonant (clipped release). */
  coda: boolean;
  /** Intonation mark on phrase end. */
  end?: 'q' | '!' | '.';
}

/** Vowel formants (adult male reference): a e i o u schwa ae. */
const VOWELS: [number, number, number][] = [
  [730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240], [500, 1500, 2500], [660, 1720, 2410],
];
const VOWEL_OF: Record<string, number> = { a: 0, e: 1, i: 2, o: 3, u: 4, y: 2 };

function onsetOf(c: string): Onset {
  if (!c) return 'none';
  const ch = c[0];
  if ('ptkbdgcq'.includes(ch)) return 'plosive';
  if ('szxj'.includes(ch) || c.startsWith('sh') || c.startsWith('ch')) return 'sib';
  if ('fvh'.includes(ch) || c.startsWith('th')) return 'fric';
  if ('mn'.includes(ch)) return 'nasal';
  if ('lrw'.includes(ch)) return 'liquid';
  return 'plosive';
}

/** Parse text into syllables (bounded count). */
export function syllabify(text: string, accent: number, maxSyl = 36): Syl[] {
  const out: Syl[] = [];
  const tokens = text.toLowerCase().match(/[a-zà-ÿ']+|[.,!?;:…]+/g) ?? [];
  for (const tok of tokens) {
    if (out.length >= maxSyl) break;
    if (/^[.,!?;:…]+$/.test(tok)) {
      const last = out[out.length - 1];
      if (!last) continue;
      if (tok.includes('?')) { last.pause = 0.38; last.end = 'q'; }
      else if (tok.includes('!')) { last.pause = 0.34; last.end = '!'; }
      else if (tok.includes('.') || tok.includes('…')) { last.pause = 0.36; last.end = '.'; }
      else last.pause = 0.16;
      continue;
    }
    const w = tok.replace(/[^a-z]/g, '') || 'a';
    const parts = w.match(/[^aeiouy]*[aeiouy]+/g) ?? [w + 'e'];
    const tail = w.slice(parts.join('').length);
    // Long words get compressed (gibberish shouldn't drone on).
    const take = parts.length > 3 ? parts.filter((_, i) => i % 2 === 0 || i === parts.length - 1) : parts;
    take.forEach((p, i) => {
      if (out.length >= maxSyl) return;
      const cons = p.match(/^[^aeiouy]*/)![0];
      const v = p.slice(cons.length);
      let vowel = VOWEL_OF[v[0]] ?? 5;
      // Accent: rotate some vowels per race; diphthong-ish groups → ae/schwa.
      if (v.length > 1 && (hashString(p) & 3) === 0) vowel = v[0] === 'a' ? 6 : 5;
      if (accent && (hashString(p + accent) % 3 === 0)) vowel = (vowel + accent) % 5;
      out.push({ onset: onsetOf(cons), vowel, stress: i === 0 ? (take.length > 1 ? 1 : 0.6) : 0.3, pause: 0, coda: i === take.length - 1 && /[ptkbdg]$/.test(tail) });
    });
    if (out.length) out[out.length - 1].pause = Math.max(out[out.length - 1].pause, 0.04);
  }
  if (out.length && !out[out.length - 1].end) out[out.length - 1].end = '.';
  return out;
}

// ------------------------------------------------------------------ synthesis

export type SpeechStyle = 'say' | 'shout' | 'whisper' | 'think';
export type Mood = 'neutral' | 'happy' | 'angry' | 'sad' | 'afraid' | 'surprised' | 'disgusted' | 'focused' | 'pain';

const MOODS: Record<Mood, { f0: number; range: number; rate: number; rough: number; breath: number; loud: number }> = {
  neutral: { f0: 1, range: 1, rate: 1, rough: 0, breath: 0, loud: 1 },
  happy: { f0: 1.08, range: 1.35, rate: 1.08, rough: 0, breath: 0, loud: 1.05 },
  angry: { f0: 1.04, range: 0.9, rate: 1.12, rough: 0.3, breath: 0.05, loud: 1.3 },
  sad: { f0: 0.92, range: 0.6, rate: 0.82, rough: 0, breath: 0.15, loud: 0.8 },
  afraid: { f0: 1.15, range: 1.2, rate: 1.22, rough: 0, breath: 0.15, loud: 0.9 },
  surprised: { f0: 1.12, range: 1.6, rate: 1.05, rough: 0, breath: 0.05, loud: 1.1 },
  disgusted: { f0: 0.95, range: 0.8, rate: 0.95, rough: 0.15, breath: 0.1, loud: 1 },
  focused: { f0: 0.98, range: 0.85, rate: 0.95, rough: 0, breath: 0, loud: 1 },
  pain: { f0: 1.1, range: 1.2, rate: 1, rough: 0.4, breath: 0.2, loud: 1.2 },
};

const glottal = new WeakMap<BaseAudioContext, PeriodicWave>();
/** Glottal-pulse-like spectrum (≈ -12 dB/oct rolloff, softened odd/even balance). */
function glottalWave(ctx: BaseAudioContext): PeriodicWave {
  let w = glottal.get(ctx);
  if (w) return w;
  const n = 48;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let k = 1; k < n; k++) im[k] = 1 / Math.pow(k, 1.15) * (k % 2 ? 1 : 0.8);
  w = ctx.createPeriodicWave(re, im);
  glottal.set(ctx, w);
  return w;
}

/**
 * Schedule an utterance into `dest` starting at absolute time `t0`.
 * Returns its duration (s). All nodes stop themselves afterwards.
 */
export function speak(ctx: BaseAudioContext, dest: AudioNode, t0: number, v: SpeechVoice, syls: Syl[], mood: Mood = 'neutral', style: SpeechStyle = 'say', rand: () => number = Math.random): number {
  if (!syls.length || style === 'think') return 0;
  const md = MOODS[mood] ?? MOODS.neutral;
  const shout = style === 'shout';
  const whisper = style === 'whisper';
  const rate = v.rate * md.rate * (shout ? 0.9 : 1);
  const f0 = v.f0 * md.f0 * (shout ? 1.3 : 1);
  const range = v.range * md.range;
  const breath = whisper ? 1 : Math.min(0.95, v.breath + md.breath);
  const rough = Math.min(1, v.rough + md.rough);
  const fm = v.formant * (shout ? 1.05 : 1);

  // Timeline
  let t = t0 + 0.02;
  const times: { s: number; on: number; v0: number; v1: number }[] = [];
  for (const sy of syls) {
    const base = 1 / rate;
    const d = base * (0.62 + sy.stress * 0.3 + rand() * 0.16) * (sy.end ? 1.25 : 1);
    const on = sy.onset === 'none' ? 0 : sy.onset === 'plosive' ? 0.035 : sy.onset === 'nasal' || sy.onset === 'liquid' ? 0.06 : 0.07;
    times.push({ s: t, on, v0: t + on, v1: t + d * (sy.coda ? 0.85 : 1) });
    t += d + sy.pause;
  }
  const T1 = t + 0.1;
  const dur = T1 - t0;

  // ---- graph
  const out = ctx.createGain();
  // Shouts are mostly louder through brightness/pitch; cap the gain so barks don't clip.
  out.gain.value = Math.min(0.62, (shout ? 1.15 : whisper ? 0.55 : 1) * md.loud * 0.5);
  out.connect(dest);
  const src = ctx.createOscillator();
  src.setPeriodicWave(glottalWave(ctx));
  src.frequency.value = f0;
  const voiced = ctx.createGain();
  voiced.gain.value = 0;
  src.connect(voiced);
  // Vibrato / tremor
  if (v.vibrato > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5 + rand() * 1.5;
    const lg = ctx.createGain();
    lg.gain.value = v.vibrato;
    lfo.connect(lg);
    lg.connect(src.detune);
    lfo.start(t0);
    lfo.stop(T1);
  }
  // Creak / growl roughness
  let head: AudioNode = voiced;
  if (rough > 0.05) {
    const am = ctx.createGain();
    am.gain.value = 1 - rough * 0.45;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 28 + rand() * 20;
    const lg = ctx.createGain();
    lg.gain.value = rough * 0.45;
    lfo.connect(lg);
    lg.connect(am.gain);
    voiced.connect(am);
    head = am;
    lfo.start(t0);
    lfo.stop(T1);
  }
  // Breath noise follows the voiced envelope.
  const noise = ctx.createBufferSource();
  noise.buffer = whiteBuffer(ctx);
  noise.loop = true;
  const breathG = ctx.createGain();
  breathG.gain.value = 0;
  noise.connect(breathG);
  const tract = ctx.createGain();
  head.connect(tract);
  breathG.connect(tract);
  const formants: BiquadFilterNode[] = [];
  const fq = [7, 11, 13];
  const fg = [1, 0.55, 0.28];
  for (let i = 0; i < 3; i++) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = fq[i];
    bp.frequency.value = VOWELS[5][i] * fm;
    const g = ctx.createGain();
    g.gain.value = fg[i] * (i === 0 ? 2.2 : 3);
    tract.connect(bp);
    bp.connect(g);
    g.connect(out);
    formants.push(bp);
  }
  // Consonant channel
  const cons = ctx.createBiquadFilter();
  cons.type = 'bandpass';
  cons.Q.value = 1.5;
  const consG = ctx.createGain();
  consG.gain.value = 0;
  noise.connect(cons);
  cons.connect(consG);
  consG.connect(out);

  // ---- automation
  const vAmp = whisper ? 0 : 1;
  const bAmp = breath * (whisper ? 0.9 : 0.35);
  const n = syls.length;
  for (let i = 0; i < n; i++) {
    const sy = syls[i];
    const tm = times[i];
    // Pitch: declination over the phrase + stress + random prosody + phrase-final contour.
    const prog = i / Math.max(1, n - 1);
    let p = f0 * (1.08 - 0.16 * prog) * (1 + (sy.stress - 0.4) * 0.18 * range) * (1 + (rand() - 0.5) * 0.12 * range);
    if (sy.end === 'q') p *= 1 + 0.35 * range;
    if (sy.end === '!') p *= 1 + 0.15 * range;
    if (sy.end === '.') p *= 1 - 0.1 * range;
    src.frequency.setTargetAtTime(p, tm.s, 0.03);
    if (sy.end === 'q') src.frequency.setTargetAtTime(p * 1.18, tm.v0 + 0.05, 0.08);
    if (sy.end === '.') src.frequency.setTargetAtTime(p * 0.88, tm.v0 + 0.05, 0.1);
    // Formants glide to this vowel (coarticulation via time constant).
    const vf = VOWELS[sy.vowel];
    const open = shout ? 1.12 : 1;
    for (let k = 0; k < 3; k++) {
      let f = vf[k] * fm * (k === 0 ? open : 1);
      if (sy.onset === 'nasal' && k === 0) formants[k].frequency.setTargetAtTime(260 * fm, tm.s, 0.01);
      if (sy.onset === 'liquid' && k === 1) formants[k].frequency.setTargetAtTime(1100 * fm, tm.s, 0.01);
      f = Math.min(f, 9000);
      formants[k].frequency.setTargetAtTime(f, tm.v0, 0.025);
    }
    // Onset consonant
    const stressAmp = 0.75 + sy.stress * 0.35;
    switch (sy.onset) {
      case 'plosive':
        cons.frequency.setValueAtTime(1200 + rand() * 2500, tm.s);
        consG.gain.setValueAtTime(0, tm.s + 0.012);
        consG.gain.linearRampToValueAtTime(0.5, tm.s + 0.016);
        consG.gain.exponentialRampToValueAtTime(0.01, tm.s + 0.04);
        consG.gain.setValueAtTime(0, tm.s + 0.041);
        break;
      case 'sib':
        cons.frequency.setValueAtTime(5200 + rand() * 1800, tm.s);
        consG.gain.setValueAtTime(0, tm.s);
        consG.gain.linearRampToValueAtTime(0.25 * v.sib, tm.s + 0.03);
        consG.gain.linearRampToValueAtTime(0, tm.v0 + 0.01 + (v.sib > 1.5 ? 0.05 : 0));
        break;
      case 'fric':
        cons.frequency.setValueAtTime(1600 + rand() * 1500, tm.s);
        consG.gain.setValueAtTime(0, tm.s);
        consG.gain.linearRampToValueAtTime(0.18, tm.s + 0.03);
        consG.gain.linearRampToValueAtTime(0, tm.v0 + 0.01);
        break;
      default:
        break;
    }
    // Voicing envelope: nasals/liquids voice through the onset (quieter).
    const vStart = sy.onset === 'nasal' || sy.onset === 'liquid' ? tm.s : tm.v0;
    const preAmp = sy.onset === 'nasal' ? 0.35 : sy.onset === 'liquid' ? 0.5 : 0;
    voiced.gain.setValueAtTime(preAmp * vAmp, vStart);
    voiced.gain.linearRampToValueAtTime(vAmp * stressAmp, tm.v0 + 0.03);
    voiced.gain.setValueAtTime(vAmp * stressAmp * 0.85, Math.max(tm.v0 + 0.031, tm.v1 - 0.04));
    voiced.gain.linearRampToValueAtTime(0, tm.v1);
    breathG.gain.setValueAtTime(0, vStart);
    breathG.gain.linearRampToValueAtTime(bAmp * stressAmp, tm.v0 + 0.03);
    breathG.gain.linearRampToValueAtTime(0, tm.v1);
    // Rolled R: brief amplitude flutter on liquids
    if (sy.onset === 'liquid' && v.trill > 0.3) {
      for (let k = 0; k < 3; k++) {
        voiced.gain.setValueAtTime(0.15 * vAmp, tm.s + k * 0.02);
        voiced.gain.setValueAtTime(0.5 * vAmp, tm.s + k * 0.02 + 0.01);
      }
    }
  }
  src.start(t0);
  src.stop(T1);
  noise.start(t0, rand() * 1.5);
  noise.stop(T1);
  return dur;
}

const whiteBufs = new WeakMap<BaseAudioContext, AudioBuffer>();
function whiteBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = whiteBufs.get(ctx);
  if (b) return b;
  const n = ctx.sampleRate * 2;
  b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  whiteBufs.set(ctx, b);
  return b;
}

// ------------------------------------------------------------------ nonverbal barks

export type BarkKind = 'pain' | 'effort' | 'death' | 'laugh' | 'cheer' | 'gasp' | 'grunt' | 'hmm' | 'greet' | 'shout' | 'sigh';
export const BARK_KINDS: BarkKind[] = ['pain', 'effort', 'death', 'laugh', 'cheer', 'gasp', 'grunt', 'hmm', 'greet', 'shout', 'sigh'];

/** Syllable scripts + delivery for vocal barks. */
export function barkScript(kind: BarkKind, rand: () => number = Math.random): { syls: Syl[]; mood: Mood; style: SpeechStyle; rateMul: number } {
  const S = (onset: Onset, vowel: number, stress = 1, pause = 0, end?: Syl['end']): Syl => ({ onset, vowel, stress, pause, coda: false, end });
  switch (kind) {
    case 'pain':
      return { syls: [S(rand() < 0.5 ? 'none' : 'fric', rand() < 0.5 ? 0 : 4, 1, 0, '!')], mood: 'pain', style: 'shout', rateMul: 2.2 };
    case 'effort':
      return { syls: [S('fric', 0, 1, 0, '.')], mood: 'focused', style: 'say', rateMul: 2.6 };
    case 'death':
      return { syls: [S('none', 0, 1, 0, '.'), S('none', 5, 0.3, 0, '.')], mood: 'pain', style: 'shout', rateMul: 0.55 };
    case 'laugh':
      return { syls: [S('fric', 0, 1), S('fric', 0, 0.8), S('fric', 0, 0.6), S('fric', 0, 0.4, 0, '.')], mood: 'happy', style: 'say', rateMul: 1.9 };
    case 'cheer':
      return { syls: [S('fric', 1, 0.8), S('liquid', 0, 1, 0, '!')], mood: 'happy', style: 'shout', rateMul: 1.1 };
    case 'gasp':
      return { syls: [S('fric', 0, 1, 0, 'q')], mood: 'surprised', style: 'whisper', rateMul: 2 };
    case 'grunt':
      return { syls: [S('nasal', 5, 0.8, 0, '.')], mood: 'focused', style: 'say', rateMul: 2.4 };
    case 'hmm':
      return { syls: [S('nasal', 5, 0.6), S('nasal', 5, 0.4, 0, 'q')], mood: 'neutral', style: 'say', rateMul: 1.1 };
    case 'greet':
      return { syls: [S('fric', 0, 1), S('none', 2, 0.6, 0, '!')], mood: 'happy', style: 'say', rateMul: 1.3 };
    case 'shout':
      return { syls: [S('plosive', 3, 1), S('none', 1, 0.8, 0, '!')], mood: 'angry', style: 'shout', rateMul: 1.3 };
    case 'sigh':
      return { syls: [S('fric', 0, 0.6, 0, '.')], mood: 'sad', style: 'whisper', rateMul: 0.6 };
  }
}

/** Estimate how long `speak` will take for a text (for scheduling). */
export function estimateDuration(syls: Syl[], v: SpeechVoice): number {
  let d = 0;
  for (const s of syls) d += (1 / v.rate) * (0.7 + s.stress * 0.3) + s.pause;
  return d + 0.15;
}

export type { Syl };
