/**
 * Interface sounds & fanfares (stereo, UI bus, no world reverb). Pitched
 * material is tuned to the world's musical theme so a level-up in one world
 * rings in a different key/scale than in another.
 */
import type { Synth } from '../dsp';
import type { SoundDef } from '../engine';
import { sd, crunch, whoosh, METAL } from './common';

/** Minimal tuning contract (provided by the music theme). */
export interface UiTuning {
  /** Root frequency (Hz) around middle register. */
  root: number;
  /** Scale steps in cents within one octave (ascending, starting at 0). */
  scale: number[];
  /** Octave size in cents (1200 normally; stretched in strange worlds). */
  octave: number;
}

export const DEFAULT_TUNING: UiTuning = { root: 261.63, scale: [0, 200, 400, 700, 900], octave: 1200 };

/** Frequency of scale degree `d` (may be negative / beyond one octave). */
export function degreeHz(tu: UiTuning, d: number): number {
  const n = tu.scale.length;
  const oct = Math.floor(d / n);
  const idx = ((d % n) + n) % n;
  return tu.root * Math.pow(2, (oct * tu.octave + tu.scale[idx]) / 1200);
}

/** Brass-like note: detuned saws with an opening lowpass. */
function brass(s: Synth, t: number, f: number, dur: number, peak: number, pan = 0) {
  const T = s.t + t;
  const p = s.stereo(pan, s.out);
  const g = s.gain(0, p);
  const lp = s.filter('lowpass', f * 1.5, 1.5, g);
  lp.frequency.setValueAtTime(f * 1.2, T);
  lp.frequency.linearRampToValueAtTime(f * 6, T + 0.08);
  lp.frequency.exponentialRampToValueAtTime(f * 2.5, T + dur);
  for (const det of [-6, 5]) {
    const o = s.osc('sawtooth', f, T, dur + 0.3, lp);
    o.detune.value = det;
  }
  g.gain.setValueAtTime(0, T);
  g.gain.linearRampToValueAtTime(peak, T + 0.04);
  g.gain.setValueAtTime(peak * 0.8, T + dur * 0.6);
  g.gain.linearRampToValueAtTime(0, T + dur + 0.25);
}

/** Soft mallet/bell tone (FM). */
function bell(s: Synth, t: number, f: number, d: number, peak: number, pan = 0) {
  const p = s.stereo(pan, s.out);
  s.fm(t, f, 3.5, 1.2, d, peak, p);
  s.tone({ t, f: f * 2, d: d * 0.4, peak: peak * 0.3, dest: p });
}

function sparkle(s: Synth, t: number, count: number, f0: number, dur: number, peak: number) {
  for (let i = 0; i < count; i++) {
    const p = s.stereo(s.r(-0.8, 0.8), s.out);
    s.tone({ t: t + s.rand() * dur, f: f0 * s.r(1, 2.5), d: s.r(0.15, 0.4), peak: peak * s.r(0.4, 1), dest: p });
  }
}

export function uiDefs(tu: UiTuning = DEFAULT_TUNING): Record<string, SoundDef> {
  const N = (d: number) => degreeHz(tu, d);
  const ui = (o: Partial<SoundDef> & Pick<SoundDef, 'dur' | 'render'>) =>
    sd({ bus: 'ui', group: 'ui', stereo: true, reverb: 0, variants: 3, jitter: 0.01, priority: 2, ...o });
  return {
    ui_hover: ui({ dur: 0.08, gain: 0.25, variants: 4, render: (s) => s.tone({ f: N(s.ri(7, 9)) * 2, d: 0.03, peak: 0.12, type: 'sine', a: 0.002 }) }),
    ui_click: ui({
      dur: 0.15, gain: 0.5, render(s) {
        s.click(0, 3000, 0.25, undefined, 0.006);
        s.tone({ f: N(5), d: 0.06, peak: 0.12, type: 'triangle' });
      },
    }),
    ui_tab: ui({ dur: 0.15, gain: 0.45, render: (s) => { s.click(0, 2200, 0.2); s.tone({ f: N(4), f2: N(5), d: 0.07, peak: 0.1, type: 'triangle' }); } }),
    ui_open: ui({
      dur: 0.6, gain: 0.5, render(s) {
        whoosh(s, 0, 0.25, 500, 3000, 0.12, 1.2);
        bell(s, 0.05, N(3), 0.4, 0.12, -0.2);
        bell(s, 0.12, N(5), 0.45, 0.1, 0.2);
      },
    }),
    ui_close: ui({
      dur: 0.5, gain: 0.45, render(s) {
        whoosh(s, 0, 0.2, 2500, 400, 0.1, 1.2);
        bell(s, 0.02, N(5), 0.3, 0.08, 0.2);
        bell(s, 0.09, N(2), 0.35, 0.08, -0.2);
      },
    }),
    ui_confirm: ui({ dur: 0.5, gain: 0.5, render: (s) => { bell(s, 0, N(4), 0.3, 0.12); bell(s, 0.08, N(7), 0.4, 0.12); } }),
    ui_error: ui({
      dur: 0.4, gain: 0.45, render(s) {
        for (const t of [0, 0.12]) {
          const g = s.gain(0, s.out);
          const lp = s.filter('lowpass', 900, 1, g);
          s.osc('square', 110, s.t + t, 0.1, lp);
          s.osc('square', 116, s.t + t, 0.1, lp);
          s.perc(g.gain, s.t + t, 0.005, 0.12, 0.09, true);
        }
      },
    }),
    ui_page: ui({
      dur: 0.4, gain: 0.4, variants: 4, render(s) {
        s.burst({ dur: 0.18, f: 3500, f2: 6000, q: 0.6, peak: 0.25, a: 0.04, color: 'white' });
        crunch(s, 0.05, 0.12, 6, 3000, 8000, 0.05);
      },
    }),
    ui_drag: ui({ dur: 0.2, gain: 0.35, render: (s) => s.burst({ dur: 0.1, f: 1500, q: 1, peak: 0.2, color: 'pink', a: 0.01 }) }),
    ui_drop: ui({ dur: 0.25, gain: 0.45, render: (s) => { s.thump(0, 150, 0.3, 0.06); s.click(0, 1800, 0.15); } }),
    ui_buy: ui({
      dur: 0.9, gain: 0.5, render(s) {
        for (let i = 0; i < 5; i++) s.modal(i * s.r(0.03, 0.06), s.r(2600, 4000), [[1, 1, 0.25], [2.76, 0.5, 0.15]], 0.05);
        bell(s, 0.15, N(7), 0.5, 0.1);
      },
    }),
    xp_tick: ui({ dur: 0.4, gain: 0.3, variants: 4, render: (s) => sparkle(s, 0, 3, N(s.ri(5, 9)) * 2, 0.15, 0.06) }),
    notify: ui({ dur: 0.6, gain: 0.45, render: (s) => { bell(s, 0, N(5), 0.4, 0.12); } }),
    notify_good: ui({ dur: 0.8, gain: 0.5, render: (s) => { bell(s, 0, N(2), 0.4, 0.1, -0.3); bell(s, 0.09, N(4), 0.4, 0.1); bell(s, 0.18, N(7), 0.6, 0.12, 0.3); } }),
    notify_bad: ui({
      dur: 0.8, gain: 0.5, render(s) {
        bell(s, 0, N(4), 0.4, 0.1);
        bell(s, 0.14, N(1) * Math.pow(2, -100 / 1200), 0.6, 0.12);
        s.tone({ f: N(-5), d: 0.5, peak: 0.08, type: 'triangle' });
      },
    }),
    notify_warn: ui({ dur: 0.7, gain: 0.5, render: (s) => { for (const t of [0, 0.18]) bell(s, t, N(6), 0.3, 0.12); } }),
    discovery: ui({
      dur: 3.5, gain: 0.55, variants: 2, render(s) {
        // Gentle ascending motif over a soft pad — new region found.
        [0, 2, 4, 7].forEach((d, i) => bell(s, i * 0.28, N(d), 1.4, 0.1, -0.4 + i * 0.25));
        const g = s.gain(0, s.out);
        const lp = s.filter('lowpass', 1200, 0.7, g);
        for (const d of [-7, -3, 0]) s.osc('triangle', N(d), s.t, 3.2, lp);
        g.gain.setValueAtTime(0, s.t);
        g.gain.linearRampToValueAtTime(0.06, s.t + 1);
        g.gain.linearRampToValueAtTime(0, s.t + 3.2);
      },
    }),
    level_up: ui({
      dur: 3.2, gain: 0.7, variants: 2, priority: 3, render(s) {
        // Fanfare: arpeggio to the octave, sustained top chord, sparkles, sub.
        const n = tu.scale.length;
        const steps = [0, Math.round(n * 0.4), Math.round(n * 0.6), n];
        steps.forEach((d, i) => brass(s, i * 0.12, N(d), i === 3 ? 1.6 : 0.25, 0.09, -0.3 + i * 0.2));
        brass(s, 0.36, N(steps[1]), 1.5, 0.05, -0.4);
        brass(s, 0.36, N(steps[2]), 1.5, 0.05, 0.4);
        sparkle(s, 0.4, 18, N(n) * 2, 1.5, 0.05);
        s.tone({ t: 0.36, f: N(-n), d: 1.5, peak: 0.15, a: 0.02 });
        s.burst({ t: 0.36, dur: 1.4, f: 8000, q: 0.5, peak: 0.03, type: 'highpass', a: 0.1 });
      },
    }),
    unlock: ui({
      dur: 2.6, gain: 0.6, variants: 2, priority: 3, render(s) {
        // Magical "new power": rising sweep into a bell chord.
        whoosh(s, 0, 0.7, 300, 5000, 0.12, 1.5);
        s.tone({ f: N(0) / 2, f2: N(0) * 2, glide: 0.6, d: 0.7, peak: 0.06, type: 'triangle' });
        [0, 2, 4, 6].forEach((d, i) => bell(s, 0.6 + i * 0.03, N(d), 1.8, 0.07, -0.5 + i * 0.33));
        sparkle(s, 0.6, 14, N(7) * 2, 1.2, 0.05);
      },
    }),
    quest_start: ui({
      dur: 2.6, gain: 0.6, variants: 2, priority: 3, render(s) {
        // Horn call: fifth up, held; frame drum
        brass(s, 0, N(0) / 2, 0.45, 0.1);
        brass(s, 0.5, N(Math.round(tu.scale.length * 0.6)) / 2, 1.3, 0.1);
        s.thump(0, 70, 0.4, 0.3);
        s.thump(0.5, 70, 0.3, 0.3);
      },
    }),
    quest_update: ui({ dur: 1.2, gain: 0.5, render: (s) => { bell(s, 0, N(4), 0.6, 0.1, -0.2); bell(s, 0.15, N(5), 0.8, 0.1, 0.2); } }),
    quest_complete: ui({
      dur: 3.8, gain: 0.7, variants: 2, priority: 3, render(s) {
        const n = tu.scale.length;
        const mel = [0, 2, 4, n, n + 2];
        mel.forEach((d, i) => brass(s, i * 0.16, N(d), i === mel.length - 1 ? 2.0 : 0.2, 0.08, -0.3 + i * 0.15));
        brass(s, 0.64, N(2), 2.0, 0.05, -0.5);
        brass(s, 0.64, N(4), 2.0, 0.05, 0.5);
        s.tone({ t: 0.64, f: N(-n), d: 2.2, peak: 0.16, a: 0.03 });
        for (const t of [0, 0.32, 0.64]) s.thump(t, 65, 0.4, 0.3);
        s.modal(0.64, 1200, METAL, 0.03);
        sparkle(s, 0.7, 20, N(n) * 2, 2, 0.04);
      },
    }),
    death_sting: sd({
      dur: 5, bus: 'music', group: 'ui', stereo: true, reverb: 0.8, variants: 1, gain: 0.8, priority: 3, render(s) {
        // Low, falling minor cluster
        const g = s.gain(0, s.out);
        const lp = s.filter('lowpass', 900, 1, g);
        lp.frequency.setValueAtTime(1500, s.t);
        lp.frequency.exponentialRampToValueAtTime(200, s.t + 4.5);
        for (const [f, det] of [[N(-5), 0], [N(-5) * 1.189, 7], [N(-5) * 1.498, -5], [N(-10), 3]] as [number, number][]) {
          const o = s.osc('sawtooth', f, s.t, 4.6, lp);
          o.detune.value = det;
          o.frequency.setValueAtTime(f, s.t + 0.5);
          o.frequency.exponentialRampToValueAtTime(f * 0.94, s.t + 4.5);
        }
        g.gain.setValueAtTime(0, s.t);
        g.gain.linearRampToValueAtTime(0.12, s.t + 0.2);
        g.gain.linearRampToValueAtTime(0, s.t + 4.6);
        s.thump(0, 40, 0.8, 1.2, undefined, 0.5);
      },
    }),
  };
}
