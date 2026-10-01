/**
 * Combat & destruction: weapon whooshes, material impacts, blocks/parries,
 * bows/arrows, explosions, digging, trees, rocks, thunder.
 */
import type { Synth } from '../dsp';
import type { SoundDef } from '../engine';
import { sd, whoosh, crunch, creak, debris, rumble, chirpDown, crackles, breath, METAL, WOOD, STONE, GLASS, ICE } from './common';

/** Material impact family used by hit_* sounds. */
export type HitMaterial = 'metal' | 'wood' | 'stone' | 'flesh' | 'crystal' | 'ice' | 'plant' | 'cloth' | 'soil';

const HIT: Record<HitMaterial, (s: Synth) => void> = {
  metal(s) {
    s.click(0, 5000, 0.5);
    s.modal(0, s.r(450, 1100), METAL, 0.22, undefined, 0.02);
    s.burst({ dur: 0.12, f: 6000, q: 0.7, peak: 0.12, type: 'highpass' });
    s.thump(0, 140, 0.25, 0.05);
  },
  wood(s) {
    s.click(0, 2500, 0.35);
    s.modal(0, s.r(140, 320), WOOD, 0.7);
    s.thump(0, 90, 0.4, 0.08);
    crackles(s, 0.005, 0.06, 5, 1500, 5000, 0.08);
  },
  stone(s) {
    s.burst({ dur: 0.03, f: s.r(1500, 2600), q: 1, peak: 0.55 });
    s.thump(0, s.r(80, 120), 0.5, 0.08);
    s.modal(0, s.r(600, 1100), STONE, 0.18);
    crunch(s, 0.02, 0.15, 9, 2000, 6000, 0.08);
  },
  flesh(s) {
    s.thump(0, s.r(60, 90), 0.8, 0.12);
    s.burst({ dur: 0.07, f: s.r(250, 450), q: 0.7, peak: 0.6, type: 'lowpass', color: 'pink' });
    s.burst({ t: 0.004, dur: 0.05, f: s.r(900, 1500), q: 1.5, peak: 0.25 });
    // Wet tail
    s.burst({ t: 0.03, dur: 0.12, f: 700, f2: 400, q: 3, peak: 0.08, color: 'pink' });
  },
  crystal(s) {
    s.click(0, 7000, 0.4);
    s.modal(0, s.r(1600, 3000), GLASS, 0.2, undefined, 0.02);
    for (let i = 0; i < 4; i++) s.modal(s.r(0.01, 0.12), s.r(3000, 7000), GLASS, 0.04);
  },
  ice(s) {
    s.click(0, 6000, 0.45);
    s.modal(0, s.r(1200, 2200), ICE, 0.15);
    chirpDown(s, 0.005, s.r(3000, 4500), s.r(400, 700), 0.09, 0.08);
    crunch(s, 0.01, 0.1, 6, 3000, 8000, 0.08);
  },
  plant(s) {
    s.burst({ dur: 0.18, f: 3000, q: 0.7, peak: 0.25, a: 0.01 });
    crunch(s, 0, 0.15, 10, 2000, 7000, 0.12, 2);
    s.thump(0, 100, 0.2, 0.05);
  },
  cloth(s) {
    s.thump(0, 80, 0.4, 0.07);
    s.burst({ dur: 0.08, f: 1500, q: 0.7, peak: 0.25, color: 'pink' });
  },
  soil(s) {
    s.thump(0, 65, 0.6, 0.1);
    s.burst({ dur: 0.12, f: 500, q: 0.7, peak: 0.45, type: 'lowpass', color: 'pink' });
    crunch(s, 0.02, 0.15, 10, 900, 3000, 0.1);
  },
};

export const HIT_MATERIALS = Object.keys(HIT) as HitMaterial[];

function explosion(s: Synth, size: number) {
  // Sub boom
  s.tone({ f: 70 * (1.4 - size * 0.4), f2: 22, glide: 0.8, a: 0.004, d: 0.9 + size, peak: 1 });
  // Blast: broadband → darkening
  s.burst({ dur: 0.6 + size * 1.4, f: 6000, f2: 180, q: 0.5, type: 'lowpass', peak: 0.9, color: 'pink', a: 0.003 });
  s.burst({ dur: 0.08, f: 3000, q: 0.5, peak: 0.6, color: 'white' });
  rumble(s, 0.05, 1.5 + size * 2.5, 160, 0.7, 0.08);
  // Debris rain and crackle
  debris(s, 0.25, Math.round(6 + size * 14), 700, STONE, 0.18, 1.6);
  crackles(s, 0.05, 0.8 + size, Math.round(10 + size * 20), 800, 4000, 0.1);
}

export function combatDefs(): Record<string, SoundDef> {
  const out: Record<string, SoundDef> = {};
  // ---- whooshes (weapon swings)
  out.swing_light = sd({ dur: 0.35, variants: 8, group: 'combat', gain: 0.4, ref: 1.6, range: 40, jitter: 0.1, render: (s) => whoosh(s, 0, s.r(0.16, 0.22), 700, s.r(2200, 3500), 0.5, 2.5) });
  out.swing = sd({
    dur: 0.5, variants: 8, group: 'combat', gain: 0.45, ref: 1.8, range: 45, jitter: 0.08, render(s) {
      whoosh(s, 0, s.r(0.24, 0.32), 450, s.r(1500, 2500), 0.6, 2);
      breath(s, 0, 0.12, 700, 1200, 0.03);
    },
  });
  out.swing_heavy = sd({
    dur: 0.8, variants: 6, group: 'combat', gain: 0.55, ref: 2.2, range: 55, jitter: 0.06, render(s) {
      whoosh(s, 0, s.r(0.4, 0.5), 220, s.r(900, 1400), 0.7, 1.6);
      whoosh(s, 0.04, 0.4, 120, 400, 0.4, 1.2, 'pink');
      breath(s, 0, 0.18, 550, 1100, 0.06);
    },
  });
  out.throw = sd({ dur: 0.4, variants: 6, group: 'combat', gain: 0.4, render: (s) => whoosh(s, 0, 0.25, 600, 2000, 0.45, 2) });
  out.punch = sd({
    dur: 0.4, variants: 6, group: 'combat', gain: 0.7, ref: 1.8, render(s) {
      whoosh(s, 0, 0.1, 500, 1500, 0.2, 1.5);
      // Whoosh precedes the contact.
      HIT.flesh(s.at(0.09));
    },
  });
  out.kick = sd({
    dur: 0.45, variants: 6, group: 'combat', gain: 0.75, ref: 1.8, render(s) {
      whoosh(s, 0, 0.14, 350, 1100, 0.25, 1.4);
      s.thump(0.12, 60, 0.8, 0.13);
      s.burst({ t: 0.12, dur: 0.08, f: 400, q: 0.7, peak: 0.5, type: 'lowpass', color: 'pink' });
    },
  });

  // ---- impacts by material
  for (const m of HIT_MATERIALS) {
    out['hit_' + m] = sd({ dur: m === 'metal' ? 1.2 : m === 'crystal' ? 0.9 : 0.5, variants: 6, group: 'combat', gain: 0.75, ref: 2.2, range: 70, jitter: 0.07, priority: 1.2, render: HIT[m] });
  }
  out.hit_crit = sd({
    dur: 1.2, variants: 4, group: 'combat', gain: 0.9, ref: 2.5, range: 80, priority: 1.6, render(s) {
      HIT.flesh(s);
      s.tone({ f: 60, f2: 30, d: 0.35, peak: 0.6 });
      // Sharp sting accent
      s.modal(0, s.r(1800, 2400), METAL, 0.06);
      s.burst({ dur: 0.25, f: 8000, f2: 3000, q: 0.7, peak: 0.12, type: 'highpass' });
    },
  });
  out.block = sd({
    dur: 1.0, variants: 6, group: 'combat', gain: 0.85, ref: 2.2, range: 70, priority: 1.3, render(s) {
      s.thump(0, 100, 0.7, 0.1);
      s.modal(0, s.r(280, 420), METAL, 0.2, undefined, 0.02);
      s.modal(0, s.r(120, 180), WOOD, 0.4);
      s.burst({ dur: 0.05, f: 2000, q: 0.8, peak: 0.4 });
    },
  });
  out.parry = sd({
    dur: 1.8, variants: 6, group: 'combat', gain: 0.85, ref: 2.5, range: 80, priority: 1.4, render(s) {
      s.click(0, 6000, 0.5);
      const f = s.r(1100, 1700);
      s.modal(0, f, [[1, 1, 1.4], [2.32, 0.6, 1], [4.25, 0.4, 0.6], [6.63, 0.25, 0.4]], 0.18, undefined, 0.01);
      s.modal(0.004, f * 1.012, [[1, 1, 1.2], [2.32, 0.5, 0.8]], 0.08);
      // Blade scrape
      s.burst({ t: 0.01, dur: s.r(0.15, 0.3), f: 5000, f2: 2500, q: 5, peak: 0.12, lin: true });
    },
  });
  out.bow_draw = sd({
    dur: 0.9, variants: 4, group: 'combat', gain: 0.3, ref: 1.5, range: 30, render(s) {
      creak(s, 0, 0.7, 25, 90, s.r(600, 900), 0.18);
      s.burst({ dur: 0.6, f: 3000, q: 4, peak: 0.03, a: 0.3, lin: true });
    },
  });
  out.bow_release = sd({
    dur: 0.8, variants: 6, group: 'combat', gain: 0.75, ref: 2, range: 55, jitter: 0.06, render(s) {
      // String twang: low pluck with pitch settle + vibration buzz
      const f = s.r(95, 140);
      s.tone({ f: f * 1.6, f2: f, glide: 0.03, d: 0.35, peak: 0.45, type: 'triangle' });
      s.tone({ f: f * 3.02, d: 0.12, peak: 0.15, type: 'sawtooth' });
      s.burst({ dur: 0.04, f: 1500, q: 0.9, peak: 0.5 });
      s.thump(0, 120, 0.4, 0.06);
      whoosh(s, 0.02, 0.2, 1200, 4000, 0.15, 3);
    },
  });
  out.arrow_fly = sd({
    dur: 0.7, variants: 6, group: 'combat', gain: 0.35, ref: 1.5, range: 40, render(s) {
      // Doppler-ish whistle passing by
      const T = s.t;
      const g = s.gain(0, s.out);
      const f = s.filter('bandpass', 3000, 12, g);
      f.frequency.setValueAtTime(s.r(3200, 4200), T);
      f.frequency.exponentialRampToValueAtTime(s.r(1600, 2200), T + 0.5);
      g.gain.setValueAtTime(0, T);
      g.gain.linearRampToValueAtTime(0.5, T + 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, T + 0.55);
      s.noiseSrc('white', T, 0.6, f);
    },
  });
  out.arrow_hit = sd({
    dur: 0.7, variants: 6, group: 'combat', gain: 0.7, ref: 2, range: 55, render(s) {
      s.click(0, 3000, 0.35);
      s.thump(0, 140, 0.4, 0.05);
      // Shaft vibration (fast AM "boing")
      const T = s.t + 0.005;
      const o = s.osc('triangle', s.r(180, 260), T, 0.35);
      const am = s.gain(0.5);
      const lfo = s.osc('sine', s.r(28, 40), T, 0.35);
      const lg = s.gain(0.5, am.gain);
      lfo.connect(lg);
      const g = s.gain(0, s.out);
      o.connect(am);
      am.connect(g);
      s.perc(g.gain, T, 0.002, 0.12, 0.3);
    },
  });

  // ---- destruction
  out.explosion = sd({ dur: 4.5, variants: 3, group: 'big', gain: 1, ref: 10, range: 900, jitter: 0.08, priority: 3, reverb: 1.4, render: (s) => explosion(s, 1) });
  out.explosion_small = sd({ dur: 2.5, variants: 4, group: 'big', gain: 0.85, ref: 6, range: 500, jitter: 0.08, priority: 2.2, reverb: 1.2, render: (s) => explosion(s, 0.3) });
  out.debris = sd({
    dur: 2.0, variants: 5, group: 'world', gain: 0.6, ref: 3, range: 90, render(s) {
      debris(s, 0, s.ri(8, 14), s.r(500, 900), STONE, 0.2, 1.4);
      s.burst({ dur: 1.2, f: 2500, q: 0.5, peak: 0.05, a: 0.1, color: 'pink' });
    },
  });
  out.dig = sd({
    dur: 0.7, variants: 6, group: 'world', gain: 0.65, ref: 2, range: 50, render(s) {
      // Shovel scrape into soil + crumble
      s.burst({ dur: 0.15, f: 1800, f2: 900, q: 1.5, peak: 0.3, a: 0.03 });
      s.thump(0.1, 70, 0.5, 0.1);
      crunch(s, 0.12, 0.25, 14, 700, 2500, 0.12);
      s.burst({ t: 0.25, dur: 0.3, f: 500, q: 0.6, peak: 0.18, type: 'lowpass', color: 'pink', a: 0.04 });
    },
  });
  out.dig_stone = sd({
    dur: 1.0, variants: 6, group: 'world', gain: 0.75, ref: 2.5, range: 70, render(s) {
      // Pick strike: metal ring + rock crack + pebbles
      s.click(0, 4500, 0.5);
      s.modal(0, s.r(1300, 1900), METAL, 0.08);
      s.modal(0, s.r(500, 900), STONE, 0.3);
      s.burst({ dur: 0.04, f: 2200, q: 0.7, peak: 0.4 });
      debris(s, 0.08, s.ri(4, 7), 1200, STONE, 0.08, 0.8);
    },
  });
  out.tree_chop = sd({
    dur: 0.9, variants: 6, group: 'world', gain: 0.8, ref: 2.5, range: 90, render(s) {
      s.click(0, 3500, 0.35);
      s.modal(0, s.r(110, 170), WOOD, 0.8);
      s.thump(0, 85, 0.5, 0.1);
      crackles(s, 0.01, 0.08, 8, 1500, 5000, 0.1);
    },
  });
  out.tree_creak = sd({
    dur: 3.2, variants: 4, group: 'world', gain: 0.7, ref: 4, range: 150, render(s) {
      creak(s, 0, s.r(1.6, 2.4), s.r(14, 25), s.r(35, 70), s.r(250, 450), 0.4);
      creak(s, 0.6, s.r(1.2, 1.8), s.r(30, 50), s.r(12, 22), s.r(500, 800), 0.18);
      // Fibres snapping
      crackles(s, 1.5, 1.5, 18, 800, 4000, 0.25);
    },
  });
  out.tree_fall = sd({
    dur: 5.0, variants: 3, group: 'big', gain: 1, ref: 7, range: 300, priority: 2, reverb: 1.3, render(s) {
      // Rush of foliage through air
      whoosh(s, 0, 1.4, 300, 2500, 0.35, 0.7, 'white');
      // Ground impact + branches breaking
      s.thump(1.25, 40, 1, 0.5, undefined, 0.4);
      rumble(s, 1.25, 1.8, 200, 0.6, 0.03);
      for (let i = 0; i < 10; i++) s.modal(1.25 + s.r(0, 0.6), s.r(90, 300), WOOD, s.r(0.2, 0.6));
      crackles(s, 1.25, 1.2, 40, 600, 4000, 0.25);
      // Leaves settling
      crunch(s, 1.5, 2.5, 30, 2500, 8000, 0.05, 1);
    },
  });
  out.rock_shatter = sd({
    dur: 2.6, variants: 4, group: 'big', gain: 0.95, ref: 5, range: 220, priority: 1.8, render(s) {
      s.burst({ dur: 0.05, f: 2500, q: 0.5, peak: 0.9 });
      s.thump(0, 60, 0.9, 0.3);
      rumble(s, 0, 1.0, 300, 0.4, 0.01);
      debris(s, 0.05, 18, 700, STONE, 0.25, 1.1);
      s.burst({ t: 0.1, dur: 1.5, f: 3000, q: 0.5, peak: 0.08, a: 0.1, color: 'pink' });
    },
  });
  out.crystal_shatter = sd({
    dur: 2.4, variants: 4, group: 'big', gain: 0.85, ref: 4, range: 180, priority: 1.6, render(s) {
      s.burst({ dur: 0.04, f: 6000, q: 0.5, peak: 0.7 });
      for (let i = 0; i < 26; i++) s.modal(Math.pow(s.rand(), 1.6) * 1.2, s.r(1800, 8000), GLASS, s.r(0.02, 0.09), undefined, 0.02);
      s.burst({ t: 0.02, dur: 1, f: 7000, q: 0.6, peak: 0.08, type: 'highpass', a: 0.01 });
    },
  });
  out.ice_crack = sd({
    dur: 1.6, variants: 4, group: 'world', gain: 0.8, ref: 4, range: 200, render(s) {
      s.burst({ dur: 0.02, f: 5000, q: 0.6, peak: 0.6 });
      for (let i = 0; i < 4; i++) chirpDown(s, s.r(0, 0.25), s.r(2500, 5000), s.r(150, 400), s.r(0.15, 0.4), 0.15);
      s.thump(0, 70, 0.5, 0.2);
    },
  });
  out.thunder = sd({
    dur: 7.0, variants: 4, group: 'big', gain: 1, ref: 40, range: 6000, priority: 2.5, reverb: 0.8, render(s) {
      // Close crack + rolling rumble with irregular swells
      s.burst({ dur: 0.25, f: 5000, f2: 800, q: 0.4, type: 'lowpass', peak: 0.8, color: 'white' });
      crackles(s, 0, 0.35, 25, 1500, 6000, 0.35);
      const n = s.ri(4, 7);
      for (let i = 0; i < n; i++) rumble(s, 0.1 + s.r(0, 3.5), s.r(1.5, 3.5), s.r(120, 260), s.r(0.35, 0.8), s.r(0.05, 0.5));
      s.tone({ f: 45, f2: 28, d: 3, peak: 0.5 });
    },
  });
  out.thunder_far = sd({
    dur: 7.0, variants: 4, group: 'big', gain: 0.8, ref: 60, range: 9000, priority: 2, reverb: 1, render(s) {
      const n = s.ri(3, 6);
      for (let i = 0; i < n; i++) rumble(s, s.r(0, 3), s.r(2, 4), s.r(80, 160), s.r(0.3, 0.7), s.r(0.3, 1));
    },
  });
  out.fire_crackle = sd({
    dur: 2.0, variants: 5, group: 'world', gain: 0.5, ref: 2, range: 40, render(s) {
      rumble(s, 0, 1.9, 400, 0.15, 0.3);
      crackles(s, 0, 1.9, 30, 1200, 6000, 0.25);
      for (let i = 0; i < 4; i++) s.burst({ t: s.r(0, 1.6), dur: 0.05, f: s.r(600, 1200), q: 2, peak: 0.2 });
    },
  });
  return out;
}
