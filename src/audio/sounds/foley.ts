/**
 * Foley: footsteps per terrain sound family, water, jumps/landings,
 * cloth/armor movement, items, eating & crafting.
 */
import type { Synth } from '../dsp';
import type { SoundDef } from '../engine';
import { sd, crunch, bubbles, creak, whoosh, debris, breath, METAL, WOOD, STONE, GLASS, ICE } from './common';

export type StepFamily = 'stone' | 'soil' | 'sand' | 'snow' | 'ice' | 'mud' | 'crystal' | 'wood' | 'grass' | 'water' | 'metal' | 'leaves';
export const STEP_FAMILIES: StepFamily[] = ['stone', 'soil', 'sand', 'snow', 'ice', 'mud', 'crystal', 'wood', 'grass', 'water', 'metal', 'leaves'];

/** Heel-then-toe structure shared by all steps: two contacts ~40-80 ms apart. */
function contacts(s: Synth): [number, number] {
  return [0, s.r(0.035, 0.08)];
}

const STEPS: Record<StepFamily, (s: Synth) => void> = {
  stone(s) {
    const [h, toe] = contacts(s);
    s.thump(h, s.r(70, 110), 0.5, 0.07);
    s.burst({ t: h, dur: 0.02, f: s.r(1800, 3200), q: 1.2, peak: 0.35 });
    s.burst({ t: toe, dur: 0.05, f: s.r(2500, 5000), q: 0.8, peak: 0.16, type: 'highpass' });
    // Grit scuff
    crunch(s, toe, 0.05, 5, 3000, 7000, 0.07, 2);
  },
  soil(s) {
    const [h, toe] = contacts(s);
    s.thump(h, s.r(60, 90), 0.5, 0.09);
    s.burst({ t: h, dur: 0.08, f: s.r(350, 700), q: 0.8, peak: 0.45, type: 'lowpass', color: 'pink' });
    crunch(s, toe, 0.06, 6, 900, 2400, 0.12, 2);
  },
  grass(s) {
    const [h, toe] = contacts(s);
    s.thump(h, s.r(60, 85), 0.35, 0.08);
    s.burst({ t: h, dur: 0.07, f: 500, q: 0.7, peak: 0.25, type: 'lowpass', color: 'pink' });
    // Blade swish + crackle
    s.burst({ t: h + 0.005, dur: s.r(0.1, 0.16), f: s.r(3500, 6000), q: 0.9, peak: 0.16, a: 0.025, color: 'white' });
    crunch(s, toe, 0.08, 7, 4000, 9000, 0.06, 3);
  },
  leaves(s) {
    const [h] = contacts(s);
    s.thump(h, 70, 0.3, 0.07);
    s.burst({ t: h, dur: 0.18, f: s.r(2500, 4500), q: 0.6, peak: 0.2, a: 0.02 });
    crunch(s, h + 0.01, 0.16, 12, 2500, 8000, 0.13, 2.5);
  },
  sand(s) {
    const [h, toe] = contacts(s);
    s.burst({ t: h, dur: 0.07, f: 400, q: 0.7, peak: 0.3, type: 'lowpass', color: 'pink' });
    // Pouring grains
    crunch(s, h, 0.14, 16, 2000, 6000, 0.07, 1.2);
    s.burst({ t: toe, dur: s.r(0.08, 0.14), f: s.r(3000, 5000), q: 0.6, peak: 0.12, a: 0.02 });
  },
  snow(s) {
    const [h] = contacts(s);
    s.burst({ t: h, dur: 0.06, f: 300, q: 0.7, peak: 0.28, type: 'lowpass', color: 'pink' });
    // Compression squeak/crunch: dense irregular mid-band grains.
    crunch(s, h + 0.01, s.r(0.14, 0.22), s.ri(10, 16), 900, 3200, 0.22, 3);
    if (s.chance(0.35)) s.tone({ t: h + 0.05, f: s.r(900, 1400), f2: s.r(700, 1000), d: 0.04, peak: 0.02, type: 'triangle' });
  },
  ice(s) {
    const [h, toe] = contacts(s);
    s.burst({ t: h, dur: 0.012, f: s.r(4000, 7000), q: 1, peak: 0.4 });
    s.thump(h, s.r(90, 130), 0.35, 0.05);
    s.modal(h, s.r(1800, 3200), ICE, 0.05);
    s.burst({ t: toe, dur: s.r(0.06, 0.12), f: 6000, q: 0.6, peak: 0.08, type: 'highpass', a: 0.01 });
  },
  mud(s) {
    const [h, toe] = contacts(s);
    s.thump(h, 55, 0.4, 0.1);
    // Squelch: resonant band sweeping up then down.
    const T = s.t + h;
    const g = s.gain(0, s.out);
    const f = s.filter('bandpass', 300, 5, g);
    f.frequency.setValueAtTime(260, T);
    f.frequency.exponentialRampToValueAtTime(s.r(800, 1200), T + 0.06);
    f.frequency.exponentialRampToValueAtTime(350, T + 0.18);
    s.perc(g.gain, T, 0.01, 0.5, 0.18);
    s.noiseSrc('pink', T, 0.2, f);
    // Suction pop on lift-off
    s.tone({ t: toe + 0.1, f: s.r(250, 400), f2: s.r(700, 1100), d: 0.035, peak: 0.12 });
    bubbles(s, toe + 0.05, 0.12, 3, 300, 800, 0.04);
  },
  crystal(s) {
    const [h, toe] = contacts(s);
    s.burst({ t: h, dur: 0.01, f: 5000, q: 1, peak: 0.35 });
    s.thump(h, 100, 0.3, 0.05);
    s.modal(h, s.r(2200, 3600), GLASS, 0.07, undefined, 0.02);
    if (s.chance(0.6)) s.modal(toe, s.r(3000, 5200), GLASS, 0.035, undefined, 0.02);
  },
  wood(s) {
    const [h, toe] = contacts(s);
    s.modal(h, s.r(150, 240), WOOD, 0.55);
    s.burst({ t: h, dur: 0.015, f: 2500, q: 1, peak: 0.25 });
    s.modal(toe, s.r(220, 320), WOOD, 0.2);
    if (s.chance(0.25)) creak(s, toe + 0.02, s.r(0.15, 0.3), s.r(30, 60), s.r(25, 50), s.r(400, 800), 0.05);
  },
  metal(s) {
    const [h, toe] = contacts(s);
    s.modal(h, s.r(380, 600), METAL, 0.12);
    s.burst({ t: h, dur: 0.02, f: 3000, q: 1, peak: 0.3 });
    s.thump(h, 90, 0.3, 0.06);
    s.modal(toe, s.r(500, 800), METAL, 0.05);
  },
  water(s) {
    const [h, toe] = contacts(s);
    // Slosh: lowpassed noise sweep + bubbles
    s.burst({ t: h, dur: 0.18, f: 600, f2: 2400, q: 0.9, peak: 0.35, color: 'pink', a: 0.015 });
    s.burst({ t: toe, dur: 0.22, f: 3000, f2: 900, q: 0.8, peak: 0.18, a: 0.02 });
    bubbles(s, h + 0.03, 0.2, 7, 400, 1600, 0.05);
  },
};

/** Footstep defs keyed `step_<family>`. */
export function footstepDefs(): Record<string, SoundDef> {
  const out: Record<string, SoundDef> = {};
  for (const f of STEP_FAMILIES) {
    out['step_' + f] = sd({
      dur: 0.42, render: STEPS[f], variants: 8, group: 'step', gain: 0.55, ref: 1.6, range: 45, jitter: 0.08, reverb: 0.6, priority: 0.6,
    });
  }
  return out;
}

export function foleyDefs(): Record<string, SoundDef> {
  return {
    ...footstepDefs(),
    // ---- water
    splash_small: sd({
      dur: 0.6, group: 'foley', gain: 0.6, ref: 2, render(s) {
        s.burst({ dur: 0.25, f: 700, f2: 3000, q: 0.8, peak: 0.4, color: 'pink', a: 0.01 });
        bubbles(s, 0.04, 0.35, 10, 500, 2200, 0.05);
      },
    }),
    splash: sd({
      dur: 1.3, group: 'foley', gain: 0.8, ref: 3, render(s) {
        s.thump(0, 70, 0.4, 0.15);
        s.burst({ dur: 0.5, f: 500, f2: 2500, q: 0.6, peak: 0.6, color: 'pink', a: 0.02 });
        s.burst({ t: 0.08, dur: 0.7, f: 4000, f2: 1500, q: 0.6, peak: 0.25, a: 0.05 });
        bubbles(s, 0.05, 0.9, 22, 300, 1800, 0.06);
      },
    }),
    splash_big: sd({
      dur: 2.4, variants: 3, group: 'world', gain: 1, ref: 6, range: 160, render(s) {
        s.thump(0, 50, 0.8, 0.35);
        s.burst({ dur: 0.9, f: 300, f2: 2200, q: 0.5, peak: 0.8, color: 'pink', a: 0.03 });
        s.burst({ t: 0.25, dur: 1.5, f: 3500, f2: 900, q: 0.5, peak: 0.35, a: 0.2 });
        bubbles(s, 0.1, 1.6, 40, 200, 1400, 0.07);
      },
    }),
    swim: sd({
      dur: 0.9, variants: 6, group: 'step', gain: 0.5, ref: 2, range: 40, render(s) {
        s.burst({ dur: 0.45, f: 400, f2: 1500, q: 0.7, peak: 0.3, color: 'pink', a: 0.12 });
        s.burst({ t: 0.2, dur: 0.4, f: 2500, f2: 800, q: 0.7, peak: 0.12, a: 0.08 });
        bubbles(s, 0.15, 0.5, 6, 400, 1300, 0.035);
      },
    }),
    water_enter: sd({
      dur: 1.2, group: 'foley', gain: 0.7, ref: 3, render(s) {
        s.burst({ dur: 0.35, f: 800, f2: 200, q: 0.6, peak: 0.6, color: 'pink', type: 'lowpass', a: 0.01 });
        bubbles(s, 0.05, 0.9, 30, 200, 1200, 0.06);
      },
    }),
    water_exit: sd({
      dur: 1.0, group: 'foley', gain: 0.5, ref: 2, render(s) {
        s.burst({ dur: 0.3, f: 1200, f2: 3000, q: 0.6, peak: 0.3, a: 0.05 });
        // Dripping off
        for (let i = 0; i < 7; i++) {
          const f = s.r(900, 2400);
          s.tone({ t: 0.15 + s.rand() * 0.8, f, f2: f * 1.8, d: 0.03, peak: 0.04 });
        }
      },
    }),

    // ---- body movement
    jump: sd({
      dur: 0.5, variants: 6, group: 'foley', gain: 0.32, ref: 1.6, range: 40, render(s) {
        s.burst({ dur: 0.05, f: 2500, q: 0.9, peak: 0.12 });
        whoosh(s, 0.01, 0.3, 400, 1600, 0.2, 1.2);
        breath(s, 0.02, 0.18, s.r(600, 800), s.r(1100, 1500), 0.06);
      },
    }),
    land: sd({
      dur: 0.6, variants: 6, group: 'foley', gain: 0.7, ref: 2, range: 50, render(s) {
        s.thump(0, s.r(55, 75), 0.8, 0.14);
        s.burst({ dur: 0.1, f: 600, q: 0.6, peak: 0.45, type: 'lowpass', color: 'pink' });
        crunch(s, 0.03, 0.1, 8, 1500, 5000, 0.09, 1.5);
        s.burst({ t: 0.02, dur: 0.15, f: 3000, q: 0.8, peak: 0.08, a: 0.02 });
      },
    }),
    land_heavy: sd({
      dur: 1.1, variants: 4, group: 'foley', gain: 0.9, ref: 3, range: 70, priority: 1.3, render(s) {
        s.thump(0, 45, 1, 0.3, undefined, 0.35);
        s.burst({ dur: 0.25, f: 400, q: 0.6, peak: 0.7, type: 'lowpass', color: 'brown' });
        debris(s, 0.04, 8, 900, STONE, 0.12, 0.8);
        breath(s, 0.03, 0.2, 500, 1100, 0.07);
      },
    }),
    roll: sd({
      dur: 0.7, group: 'foley', gain: 0.5, render(s) {
        s.burst({ dur: 0.5, f: 700, q: 0.6, peak: 0.3, color: 'pink', a: 0.08 });
        crunch(s, 0.05, 0.4, 10, 1000, 4000, 0.06);
      },
    }),
    cloth: sd({
      dur: 0.5, variants: 8, group: 'foley', gain: 0.25, ref: 1.2, range: 25, render(s) {
        const n = s.ri(2, 4);
        for (let i = 0; i < n; i++) {
          s.burst({ t: s.r(0, 0.2), dur: s.r(0.06, 0.18), f: s.r(1500, 4500), q: s.r(0.8, 2), peak: s.r(0.08, 0.18), a: s.r(0.01, 0.04), color: 'pink' });
        }
      },
    }),
    armor_light: sd({
      dur: 0.5, variants: 6, group: 'foley', gain: 0.25, ref: 1.2, range: 25, render(s) {
        creak(s, 0, s.r(0.15, 0.3), s.r(40, 90), s.r(30, 70), s.r(500, 1100), 0.12);
        s.burst({ t: 0.02, dur: 0.12, f: 2500, q: 1, peak: 0.07, a: 0.02, color: 'pink' });
      },
    }),
    armor_heavy: sd({
      dur: 0.6, variants: 6, group: 'foley', gain: 0.3, ref: 1.5, range: 35, render(s) {
        // Chain jingle + plate clank
        for (let i = 0; i < 9; i++) s.modal(s.r(0, 0.12), s.r(3000, 7000), METAL, 0.012, undefined, 0.05);
        s.modal(s.r(0, 0.03), s.r(500, 900), METAL, 0.05);
        s.burst({ dur: 0.08, f: 5000, q: 0.8, peak: 0.05 });
      },
    }),

    // ---- items
    pickup: sd({
      dur: 0.5, variants: 4, group: 'foley', gain: 0.55, ref: 1.5, range: 30, render(s) {
        s.burst({ dur: 0.07, f: 1800, q: 0.8, peak: 0.15, color: 'pink', a: 0.01 });
        s.tone({ t: 0.03, f: s.r(880, 990), f2: s.r(1300, 1500), d: 0.12, peak: 0.08, type: 'triangle' });
        s.tone({ t: 0.08, f: s.r(1700, 1900), d: 0.25, peak: 0.04 });
      },
    }),
    drop: sd({
      dur: 0.5, group: 'foley', gain: 0.5, render(s) {
        s.thump(0, 90, 0.4, 0.08);
        s.burst({ dur: 0.05, f: 900, q: 0.8, peak: 0.25, color: 'pink' });
        crunch(s, 0.02, 0.06, 4, 1500, 4000, 0.06);
      },
    }),
    coins: sd({
      dur: 1.0, variants: 6, group: 'foley', gain: 0.5, ref: 1.5, range: 30, render(s) {
        const n = s.ri(4, 8);
        let t = 0;
        for (let i = 0; i < n; i++) {
          t += s.r(0.02, 0.09);
          const f = s.r(2400, 4200);
          s.modal(t, f, [[1, 1, 0.25], [2.76, 0.5, 0.18], [5.4, 0.3, 0.1]], s.r(0.03, 0.08), undefined, 0.03);
          s.click(t, 7000, 0.04);
        }
      },
    }),
    equip: sd({
      dur: 0.7, group: 'foley', gain: 0.5, ref: 1.5, render(s) {
        // Leather + metallic scrape-ring (sheathing)
        s.burst({ dur: 0.08, f: 1200, q: 0.8, peak: 0.15, color: 'pink' });
        const T = s.t + 0.04;
        const g = s.gain(0, s.out);
        const f = s.filter('bandpass', 3000, 6, g);
        f.frequency.setValueAtTime(2500, T);
        f.frequency.exponentialRampToValueAtTime(6000, T + 0.25);
        s.perc(g.gain, T, 0.08, 0.12, 0.2);
        s.noiseSrc('white', T, 0.35, f);
        s.modal(0.3, s.r(1400, 2000), METAL, 0.04);
      },
    }),
    unequip: sd({
      dur: 0.6, group: 'foley', gain: 0.45, ref: 1.5, render(s) {
        s.burst({ dur: 0.2, f: 5000, f2: 2200, q: 4, peak: 0.08, a: 0.04 });
        s.burst({ t: 0.18, dur: 0.08, f: 900, q: 0.8, peak: 0.18, color: 'pink' });
        s.thump(0.2, 90, 0.2, 0.06);
      },
    }),
    eat: sd({
      dur: 0.8, group: 'foley', gain: 0.45, ref: 1.3, range: 20, render(s) {
        for (let i = 0; i < 3; i++) crunch(s, i * s.r(0.18, 0.24), 0.08, 6, 1500, 5000, 0.12, 1.5);
      },
    }),
    drink: sd({
      dur: 1.0, group: 'foley', gain: 0.45, ref: 1.3, range: 20, render(s) {
        for (let i = 0; i < 3; i++) {
          const t = i * s.r(0.22, 0.3);
          s.tone({ t, f: s.r(180, 240), f2: s.r(350, 450), d: 0.09, peak: 0.12, type: 'triangle' });
          s.burst({ t, dur: 0.08, f: 600, q: 3, peak: 0.06, color: 'pink' });
        }
      },
    }),
    potion: sd({
      dur: 1.4, group: 'foley', gain: 0.5, ref: 1.3, range: 25, render(s) {
        // Cork pop, gulp, magic shimmer
        s.tone({ f: 500, f2: 1400, d: 0.03, peak: 0.25 });
        s.burst({ dur: 0.02, f: 2000, q: 1, peak: 0.2 });
        s.tone({ t: 0.25, f: 200, f2: 420, d: 0.1, peak: 0.12, type: 'triangle' });
        for (let i = 0; i < 8; i++) s.tone({ t: 0.45 + i * 0.06, f: s.r(1800, 4000), d: 0.4, peak: 0.02 });
      },
    }),
    hammer: sd({
      dur: 1.6, variants: 5, group: 'world', gain: 0.6, ref: 3, range: 110, render(s) {
        // Hammer on anvil: bright ring
        s.click(0, 4000, 0.4);
        s.modal(0, s.r(900, 1200), METAL, 0.18);
        s.thump(0, 120, 0.2, 0.05);
      },
    }),
    saw: sd({
      dur: 1.2, group: 'world', gain: 0.4, ref: 2, render(s) {
        for (let i = 0; i < 3; i++) {
          const t = i * 0.36;
          s.burst({ t, dur: 0.3, f: s.r(2500, 3500), f2: s.r(3500, 4500), q: 3, peak: 0.12, a: 0.08, lin: true });
          crunch(s, t, 0.3, 10, 2000, 6000, 0.03, 4);
        }
      },
    }),
    craft: sd({
      dur: 1.2, group: 'foley', gain: 0.5, render(s) {
        s.modal(0, 300, WOOD, 0.3);
        s.modal(0.18, 1100, METAL, 0.06);
        s.burst({ t: 0.3, dur: 0.2, f: 2000, q: 0.8, peak: 0.08, color: 'pink' });
        s.modal(0.45, 250, WOOD, 0.25);
      },
    }),
    door_open: sd({
      dur: 1.6, variants: 4, group: 'world', gain: 0.6, ref: 2.5, render(s) {
        s.click(0, 3000, 0.2);
        s.modal(0, 1500, METAL, 0.04);
        creak(s, 0.08, s.r(0.8, 1.2), s.r(20, 40), s.r(60, 110), s.r(450, 800), 0.18);
      },
    }),
    door_close: sd({
      dur: 1.0, variants: 4, group: 'world', gain: 0.7, ref: 2.5, render(s) {
        creak(s, 0, 0.3, 80, 40, 600, 0.08);
        s.modal(0.3, s.r(110, 160), WOOD, 0.7);
        s.thump(0.3, 70, 0.5, 0.12);
        s.click(0.42, 3500, 0.15);
      },
    }),
    chest_open: sd({
      dur: 1.4, group: 'world', gain: 0.6, ref: 2, render(s) {
        s.modal(0, 1300, METAL, 0.06);
        s.click(0, 2800, 0.15);
        creak(s, 0.1, 0.7, 25, 70, 500, 0.15);
        s.thump(0.85, 80, 0.3, 0.08);
      },
    }),
  };
}
