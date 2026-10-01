/**
 * Spell sounds per magic school: a `<school>_cast` (launch/channel burst)
 * and `<school>_impact` (arrival/effect) for each, plus generic charge,
 * fizzle, shield, teleport, summon, buff/debuff.
 */
import type { Synth } from '../dsp';
import type { SoundDef } from '../engine';
import { sd, whoosh, crackles, bubbles, rumble, chirpDown, breath, debris, crunch, GLASS, STONE, BELL } from './common';

export const SCHOOLS = ['fire', 'frost', 'earth', 'gravity', 'heal', 'light', 'shadow', 'force', 'beast', 'rune', 'shock', 'poison', 'water', 'wind', 'arcane'] as const;
export type School = (typeof SCHOOLS)[number];

/** Pentatonic-ish sparkle notes (Hz) for heal/light chimes. */
const SPARKLE = [880, 987.8, 1108.7, 1318.5, 1480, 1760, 1975.5, 2217.5, 2637];

/** Shimmer: cluster of high partials with tremolo, swelling. */
function shimmer(s: Synth, t: number, dur: number, base: number, count: number, peak: number) {
  for (let i = 0; i < count; i++) {
    const f = base * s.r(1, 3.2);
    s.tone({ t: t + s.r(0, dur * 0.3), f, a: dur * s.r(0.2, 0.5), d: dur * s.r(0.4, 0.7), peak: peak / count * 2, vib: s.r(5, 25), vibRate: s.r(5, 11), lin: true });
  }
}

/** Formant-swept noise whisper (shadow magic). */
function whisper(s: Synth, t: number, dur: number, peak: number) {
  const T = s.t + t;
  const g = s.gain(0, s.out);
  const src = s.noiseSrc('white', T, dur);
  const vowels: [number, number][] = [[700, 1200], [400, 2000], [300, 900], [600, 1700], [500, 1000]];
  const f1 = s.filter('bandpass', 600, 6, g);
  const f2 = s.filter('bandpass', 1500, 8, g);
  src.connect(f1);
  src.connect(f2);
  let tt = T;
  while (tt < T + dur) {
    const [a, b] = s.pick(vowels);
    f1.frequency.setTargetAtTime(a, tt, 0.03);
    f2.frequency.setTargetAtTime(b, tt, 0.03);
    tt += s.r(0.07, 0.16);
  }
  // Syllabic amplitude flutter
  g.gain.setValueAtTime(0, T);
  let t2 = T;
  while (t2 < T + dur - 0.05) {
    g.gain.linearRampToValueAtTime(peak * s.r(0.3, 1), t2 + 0.03);
    g.gain.linearRampToValueAtTime(peak * 0.1, t2 + s.r(0.06, 0.12));
    t2 += s.r(0.08, 0.17);
  }
  g.gain.linearRampToValueAtTime(0, T + dur);
}

/** Electrical zap: band-limited saw with jittered pitch + crackles. */
function zap(s: Synth, t: number, dur: number, peak: number) {
  const T = s.t + t;
  const o = s.osc('sawtooth', s.r(80, 160), T, dur);
  for (let tt = 0; tt < dur; tt += 0.015) o.frequency.setValueAtTime(s.r(60, 900), T + tt);
  const g = s.gain(0, s.out);
  const hp = s.filter('highpass', 600, 0.7, g);
  const sh = s.shaper(0.6, hp);
  o.connect(sh);
  s.perc(g.gain, T, 0.003, peak, dur);
  crackles(s, t, dur, Math.round(dur * 60), 2000, 9000, peak * 0.8);
}

/** Growl-roar for beast magic: saw with rough AM through formants. */
function beastRoar(s: Synth, t: number, dur: number, f0: number, peak: number) {
  const T = s.t + t;
  const o = s.osc('sawtooth', f0, T, dur);
  o.frequency.setValueAtTime(f0 * 0.8, T);
  o.frequency.linearRampToValueAtTime(f0 * 1.25, T + dur * 0.35);
  o.frequency.linearRampToValueAtTime(f0 * 0.7, T + dur);
  const am = s.gain(0.6);
  const lfo = s.osc('square', s.r(25, 45), T, dur);
  const lg = s.gain(0.4, am.gain);
  lfo.connect(lg);
  o.connect(am);
  const g = s.gain(0, s.out);
  const fa = s.filter('bandpass', 500, 4, g);
  const fb = s.filter('bandpass', 1100, 5, g);
  am.connect(fa);
  am.connect(fb);
  const n = s.noiseSrc('pink', T, dur);
  const ng = s.gain(0.35, fa);
  n.connect(ng);
  g.gain.setValueAtTime(0, T);
  g.gain.linearRampToValueAtTime(peak, T + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.001, T + dur);
}

const CAST: Record<School, (s: Synth) => void> = {
  fire(s) {
    whoosh(s, 0, 0.7, 180, 1400, 0.6, 0.9, 'pink');
    rumble(s, 0, 0.9, 380, 0.35, 0.15);
    crackles(s, 0.1, 0.9, 28, 1500, 7000, 0.18);
  },
  frost(s) {
    whoosh(s, 0, 0.6, 1500, 6000, 0.25, 1.2, 'white');
    for (let i = 0; i < 14; i++) s.modal(Math.pow(s.rand(), 0.8) * 0.7, s.r(2500, 7500), GLASS, s.r(0.015, 0.04), undefined, 0.02);
    for (let i = 0; i < 3; i++) chirpDown(s, s.r(0.1, 0.6), s.r(4000, 6000), s.r(800, 1500), 0.08, 0.05);
  },
  earth(s) {
    rumble(s, 0, 1.4, 140, 0.8, 0.4);
    // Grinding rock: noise with rough AM
    const T = s.t + 0.1;
    const g = s.gain(0, s.out);
    const bp = s.filter('bandpass', 500, 1.5, g);
    const am = s.gain(0.5, bp);
    const lfo = s.osc('square', s.r(14, 24), T, 1.1);
    const lg = s.gain(0.5, am.gain);
    lfo.connect(lg);
    s.noiseSrc('brown', T, 1.1, am);
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(0.5, T + 0.6);
    g.gain.linearRampToValueAtTime(0, T + 1.1);
    s.burst({ t: 1.0, dur: 0.05, f: 2000, q: 0.6, peak: 0.6 });
    s.thump(1.0, 60, 0.7, 0.2);
    debris(s, 1.05, 6, 800, STONE, 0.1, 0.8);
  },
  gravity(s) {
    // Detuned sub hum bending down + warp wobble
    const T = s.t;
    for (const det of [0, s.r(1, 2.5)]) {
      const o = s.osc('sine', 62 + det, T, 1.6);
      o.frequency.setValueAtTime(62 + det, T);
      o.frequency.exponentialRampToValueAtTime(34 + det, T + 1.4);
      const g = s.gain(0, s.out);
      o.connect(g);
      g.gain.setValueAtTime(0, T);
      g.gain.linearRampToValueAtTime(0.45, T + 0.8);
      g.gain.linearRampToValueAtTime(0, T + 1.5);
    }
    s.fm(0, 180, 0.51, 6, 1.4, 0.18, undefined, 0.6);
    whoosh(s, 0.5, 1.0, 150, 700, 0.2, 2, 'pink');
  },
  heal(s) {
    const notes = s.pick([[0, 2, 4, 6], [0, 3, 5, 7], [1, 3, 5, 8]]);
    notes.forEach((n, i) => s.fm(i * s.r(0.08, 0.13), SPARKLE[n], 2, 1.2, 1.4, 0.14));
    shimmer(s, 0.1, 1.4, 2200, 8, 0.08);
    s.tone({ f: 220, a: 0.4, d: 1.2, peak: 0.12, type: 'triangle' });
  },
  light(s) {
    shimmer(s, 0, 1.3, 1800, 12, 0.18);
    // Bright choral swell (detuned high saws, lowpassed)
    const T = s.t;
    const g = s.gain(0, s.out);
    const lp = s.filter('lowpass', 3500, 0.8, g);
    for (const f of [660, 663.5, 990, 1320]) s.osc('sawtooth', f, T, 1.2, lp);
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(0.06, T + 0.5);
    g.gain.linearRampToValueAtTime(0, T + 1.2);
    s.fm(0.45, SPARKLE[s.ri(4, 8)], 3.01, 1.5, 1.2, 0.08);
  },
  shadow(s) {
    whisper(s, 0, s.r(0.9, 1.3), 0.35);
    // Reversed swell into a dark drone
    const T = s.t;
    const g = s.gain(0, s.out);
    const lp = s.filter('lowpass', 400, 2, g);
    s.osc('sawtooth', 55, T, 1.3, lp);
    s.osc('sawtooth', 58.3, T, 1.3, lp);
    g.gain.setValueAtTime(0, T);
    g.gain.exponentialRampToValueAtTime(0.25, T + 1.0);
    g.gain.linearRampToValueAtTime(0, T + 1.25);
  },
  force(s) {
    whoosh(s, 0, 0.2, 200, 900, 0.4, 1.2, 'pink');
    s.thump(0.12, 55, 1, 0.25, undefined, 0.35);
    s.burst({ t: 0.12, dur: 0.25, f: 1200, f2: 200, q: 0.5, type: 'lowpass', peak: 0.6, color: 'pink' });
  },
  beast(s) {
    beastRoar(s, 0, s.r(0.9, 1.3), s.r(90, 140), 0.5);
    breath(s, 0, 0.6, 400, 900, 0.1);
  },
  rune(s) {
    // Harmonic rune hum with inscription glyph tones
    const T = s.t;
    const f0 = s.pick([110, 123.5, 130.8, 146.8]);
    const g = s.gain(0, s.out);
    const bp = s.filter('bandpass', f0 * 6, 6, g);
    const bp2 = s.filter('bandpass', f0 * 11, 10, g);
    const o = s.osc('sawtooth', f0, T, 1.5);
    o.connect(bp);
    o.connect(bp2);
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(0.5, T + 0.4);
    g.gain.setValueAtTime(0.5, T + 1.1);
    g.gain.linearRampToValueAtTime(0, T + 1.5);
    for (let i = 0; i < 5; i++) s.tone({ t: 0.2 + i * 0.16, f: f0 * s.pick([8, 9, 10, 12, 15, 16]), d: 0.25, peak: 0.07, type: 'triangle' });
    crackles(s, 0.2, 1.1, 10, 3000, 8000, 0.05);
  },
  shock(s) {
    zap(s, 0, s.r(0.4, 0.6), 0.35);
    s.burst({ dur: 0.04, f: 4000, q: 0.5, peak: 0.6 });
  },
  poison(s) {
    bubbles(s, 0, 0.8, 26, 300, 1200, 0.1);
    s.burst({ dur: 0.8, f: 4000, f2: 2000, q: 0.8, peak: 0.15, a: 0.1, type: 'highpass' });
    whoosh(s, 0, 0.5, 300, 1000, 0.25, 1.5, 'pink');
  },
  water(s) {
    whoosh(s, 0, 0.7, 300, 1600, 0.4, 0.8, 'pink');
    bubbles(s, 0.05, 0.7, 24, 300, 1500, 0.08);
    s.burst({ t: 0.2, dur: 0.6, f: 2500, f2: 900, q: 0.7, peak: 0.2, a: 0.1 });
  },
  wind(s) {
    whoosh(s, 0, 1.0, 300, 2200, 0.5, 1.6, 'pink');
    whoosh(s, 0.15, 0.8, 600, 3500, 0.25, 6, 'white');
  },
  arcane(s) {
    s.fm(0, 330, 1.5, 3, 0.9, 0.2, undefined, 0.15);
    shimmer(s, 0, 0.9, 1400, 6, 0.1);
    whoosh(s, 0, 0.5, 500, 2000, 0.2, 2);
  },
};

const IMPACT: Record<School, (s: Synth) => void> = {
  fire(s) {
    s.thump(0, 60, 0.8, 0.25);
    s.burst({ dur: 0.5, f: 3000, f2: 300, q: 0.5, type: 'lowpass', peak: 0.7, color: 'pink', a: 0.005 });
    rumble(s, 0.02, 1.4, 500, 0.3, 0.05);
    crackles(s, 0.05, 1.4, 40, 1200, 7000, 0.2);
  },
  frost(s) {
    s.burst({ dur: 0.03, f: 6000, q: 0.5, peak: 0.6 });
    for (let i = 0; i < 18; i++) s.modal(Math.pow(s.rand(), 1.5) * 0.6, s.r(2000, 8000), GLASS, s.r(0.02, 0.07), undefined, 0.02);
    for (let i = 0; i < 4; i++) chirpDown(s, s.r(0, 0.3), s.r(3000, 5000), s.r(300, 600), s.r(0.1, 0.25), 0.1);
    crunch(s, 0, 0.3, 14, 2500, 8000, 0.1);
  },
  earth(s) {
    s.thump(0, 45, 1, 0.4, undefined, 0.4);
    s.burst({ dur: 0.06, f: 1800, q: 0.6, peak: 0.7 });
    rumble(s, 0, 1.6, 180, 0.6, 0.02);
    debris(s, 0.05, 14, 600, STONE, 0.22, 1.2);
  },
  gravity(s) {
    s.tone({ f: 90, f2: 25, glide: 0.8, d: 1.2, peak: 0.9 });
    s.fm(0, 120, 0.5, 8, 1.0, 0.2);
    whoosh(s, 0, 0.6, 1500, 150, 0.3, 1.5, 'pink');
  },
  heal(s) {
    for (let i = 0; i < 6; i++) s.fm(i * 0.06 + s.r(0, 0.03), SPARKLE[s.ri(2, 8)], 2, 0.8, 1.0, 0.07);
    s.tone({ f: 330, a: 0.3, d: 1.0, peak: 0.1, type: 'triangle' });
  },
  light(s) {
    s.burst({ dur: 0.4, f: 7000, f2: 2500, q: 0.6, peak: 0.25, type: 'highpass' });
    s.modal(0, s.r(700, 900), BELL, 0.12);
    shimmer(s, 0, 1.0, 2400, 8, 0.12);
  },
  shadow(s) {
    s.thump(0, 50, 0.7, 0.3);
    whisper(s, 0.02, 0.6, 0.25);
    whoosh(s, 0, 0.8, 800, 120, 0.25, 1.5, 'pink');
  },
  force(s) {
    s.thump(0, 48, 1, 0.35, undefined, 0.3);
    s.burst({ dur: 0.35, f: 2000, f2: 150, q: 0.5, type: 'lowpass', peak: 0.8, color: 'pink' });
    s.burst({ dur: 0.03, f: 1500, q: 0.6, peak: 0.4 });
  },
  beast(s) {
    // Claw rake + snarl
    for (let i = 0; i < 3; i++) s.burst({ t: i * 0.035, dur: 0.08, f: s.r(2500, 4500), f2: s.r(1200, 2000), q: 2, peak: 0.35 });
    s.thump(0.02, 70, 0.5, 0.1);
    beastRoar(s, 0.05, 0.4, s.r(140, 200), 0.25);
  },
  rune(s) {
    s.modal(0, s.pick([220, 246.9, 261.6]), BELL, 0.18);
    crackles(s, 0, 0.6, 18, 2500, 8000, 0.12);
    s.thump(0, 80, 0.5, 0.15);
  },
  shock(s) {
    s.burst({ dur: 0.05, f: 3500, q: 0.4, peak: 0.9 });
    zap(s, 0, 0.35, 0.4);
    s.thump(0, 90, 0.5, 0.1);
  },
  poison(s) {
    bubbles(s, 0, 0.6, 20, 250, 900, 0.1);
    s.burst({ dur: 0.6, f: 5000, q: 0.8, peak: 0.2, type: 'highpass', a: 0.01 });
    s.burst({ dur: 0.15, f: 400, q: 0.7, peak: 0.3, type: 'lowpass', color: 'pink' });
  },
  water(s) {
    s.thump(0, 70, 0.5, 0.15);
    s.burst({ dur: 0.6, f: 500, f2: 2500, q: 0.6, peak: 0.5, color: 'pink', a: 0.02 });
    bubbles(s, 0.05, 0.8, 24, 300, 1800, 0.07);
  },
  wind(s) {
    whoosh(s, 0, 0.5, 2000, 400, 0.5, 1, 'pink');
    s.thump(0, 70, 0.4, 0.12);
  },
  arcane(s) {
    s.thump(0, 70, 0.6, 0.15);
    s.fm(0, 440, 2.5, 4, 0.7, 0.18);
    crackles(s, 0, 0.4, 10, 2000, 7000, 0.08);
  },
};

export function magicDefs(): Record<string, SoundDef> {
  const out: Record<string, SoundDef> = {};
  for (const sc of SCHOOLS) {
    out[sc + '_cast'] = sd({ dur: 1.8, variants: 4, group: 'magic', gain: 0.6, ref: 3, range: 120, jitter: 0.05, priority: 1.4, reverb: 1.2, render: CAST[sc] });
    out[sc + '_impact'] = sd({ dur: 2.0, variants: 4, group: 'magic', gain: 0.85, ref: 3.5, range: 150, jitter: 0.06, priority: 1.5, reverb: 1.2, render: IMPACT[sc] });
  }
  out.spell_charge = sd({
    dur: 1.6, variants: 4, group: 'magic', gain: 0.45, ref: 2, range: 50, render(s) {
      // Rising hum + gathering particles
      const T = s.t;
      const o = s.osc('triangle', 180, T, 1.5);
      o.frequency.setValueAtTime(160, T);
      o.frequency.exponentialRampToValueAtTime(520, T + 1.4);
      const g = s.gain(0, s.out);
      const lp = s.filter('lowpass', 1500, 2, g);
      o.connect(lp);
      g.gain.setValueAtTime(0, T);
      g.gain.linearRampToValueAtTime(0.18, T + 1.3);
      g.gain.linearRampToValueAtTime(0, T + 1.5);
      shimmer(s, 0.3, 1.2, 1500, 6, 0.08);
      whoosh(s, 0, 1.4, 300, 2500, 0.15, 3);
    },
  });
  out.spell_fizzle = sd({
    dur: 0.8, variants: 3, group: 'magic', gain: 0.5, ref: 2, render(s) {
      s.tone({ f: 600, f2: 120, d: 0.4, peak: 0.15, type: 'square' });
      s.burst({ dur: 0.5, f: 3000, f2: 600, q: 1, peak: 0.15, a: 0.01 });
      crackles(s, 0, 0.4, 8, 1500, 5000, 0.08);
    },
  });
  out.shield = sd({
    dur: 1.6, variants: 3, group: 'magic', gain: 0.6, ref: 2.5, render(s) {
      s.fm(0, 196, 1.5, 2, 1.3, 0.2, undefined, 0.15);
      s.fm(0.02, 293.7, 1.5, 1.5, 1.3, 0.15, undefined, 0.15);
      whoosh(s, 0, 0.5, 400, 1600, 0.2, 2);
    },
  });
  out.teleport = sd({
    dur: 1.6, variants: 3, group: 'magic', gain: 0.7, ref: 3, render(s) {
      s.tone({ f: 200, f2: 2400, glide: 0.5, d: 0.6, peak: 0.2, type: 'triangle' });
      whoosh(s, 0, 0.6, 300, 5000, 0.4, 1.5);
      s.thump(0.5, 70, 0.6, 0.2);
      shimmer(s, 0.5, 0.9, 1800, 8, 0.1);
    },
  });
  out.summon = sd({
    dur: 2.5, variants: 3, group: 'magic', gain: 0.6, ref: 3, render(s) {
      rumble(s, 0, 2.2, 160, 0.5, 1.0);
      s.fm(0.9, 110, 1.41, 5, 1.5, 0.25, undefined, 0.3);
      whoosh(s, 0.6, 1.4, 200, 1800, 0.3, 1.2, 'pink');
      s.thump(1.6, 50, 0.8, 0.3);
    },
  });
  out.buff = sd({
    dur: 1.2, variants: 3, group: 'magic', gain: 0.5, ref: 2, render(s) {
      [0, 4, 7].forEach((n, i) => s.fm(i * 0.07, 440 * Math.pow(2, n / 12), 2, 1, 0.9, 0.1));
      shimmer(s, 0.1, 0.9, 2000, 5, 0.06);
    },
  });
  out.debuff = sd({
    dur: 1.2, variants: 3, group: 'magic', gain: 0.5, ref: 2, render(s) {
      [0, -1, -6].forEach((n, i) => s.fm(i * 0.09, 330 * Math.pow(2, n / 12), 1.41, 1.5, 0.9, 0.1));
      whoosh(s, 0, 0.8, 1200, 200, 0.15, 2, 'pink');
    },
  });
  out.heal = out.heal_impact;
  return out;
}
