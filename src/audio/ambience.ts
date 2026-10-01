/**
 * Layered, biome/time/weather-aware soundscapes.
 *
 * Two kinds of material:
 *  - Beds: continuous loops (live filtered noise for wind/drones, offline
 *    pre-rendered seamless loops for leaves, rain, waves, streams, insects,
 *    settlement murmur, lava). Their gains follow targets computed from the
 *    smoothed AudioEnv, so walking across a biome border crossfades them.
 *  - Emitters: Poisson-scheduled spatial one-shots placed around the
 *    listener (per-world birdsong, owls, frogs, distant howls, drips, crystal
 *    chimes, spore puffs, volcanic booms, echoes, creaks, sand hiss, ice
 *    cracks, thunder, settlement work sounds).
 */
import type { AudioEngine, SoundDef } from './engine';
import type { AudioEnv } from './probe';
import { Biome, BIOME_COUNT } from '../world/biomes';
import { clamp, lerp, smoothstep } from '../core/math';
import { Synth, renderOffline, loopBuffer } from './dsp';
import { sd, crunch, creak, rumble, bubbles, debris, crackles, GLASS, STONE, WOOD, METAL } from './sounds/common';
import { createWildlife, birdFits, renderBird, renderFrog, renderCrickets, renderCicadas, Wildlife } from './wildlife';
import { renderCreatureCall } from './creatureVoice';
import { speechVoice, syllabify, speak } from './speech';
import type { UiTuning } from './sounds/ui';
import { degreeHz } from './sounds/ui';
import type { Vec3 } from '../shared/types';

/** Per-biome ambience profile (0..1+ weights). */
interface Amb {
  wind: number; leaves: number; birds: number; nightBirds: number; crickets: number; cicadas: number; frogs: number;
  drips: number; chimes: number; spores: number; volcanic: number; echoes: number; creaks: number; sand: number;
  howls: number; hum: number; drone: number; ice: number; lap: number;
}
const A = (o: Partial<Amb>): Amb => ({
  wind: 0.5, leaves: 0, birds: 0, nightBirds: 0, crickets: 0, cicadas: 0, frogs: 0, drips: 0, chimes: 0, spores: 0, volcanic: 0, echoes: 0,
  creaks: 0, sand: 0, howls: 0, hum: 0, drone: 0, ice: 0, lap: 0, ...o,
});

const AMB: Amb[] = [];
AMB[Biome.Ocean] = A({ wind: 0.8, birds: 0.15 });
AMB[Biome.Grassland] = A({ wind: 0.6, leaves: 0.2, birds: 0.8, nightBirds: 0.4, crickets: 1, cicadas: 0.3, howls: 0.2 });
AMB[Biome.TemperateForest] = A({ wind: 0.4, leaves: 1, birds: 1, nightBirds: 0.8, crickets: 0.6, creaks: 0.6, howls: 0.3 });
AMB[Biome.Taiga] = A({ wind: 0.6, leaves: 0.6, birds: 0.5, nightBirds: 0.6, crickets: 0.2, creaks: 0.7, howls: 0.7 });
AMB[Biome.Jungle] = A({ wind: 0.3, leaves: 0.9, birds: 1.2, nightBirds: 0.6, crickets: 1, cicadas: 1, frogs: 0.6, drips: 0.2 });
AMB[Biome.Savanna] = A({ wind: 0.7, leaves: 0.2, birds: 0.5, crickets: 0.8, cicadas: 0.8, howls: 0.4 });
AMB[Biome.Desert] = A({ wind: 0.9, sand: 1, crickets: 0.2, birds: 0.1 });
AMB[Biome.Badlands] = A({ wind: 0.9, sand: 0.6, birds: 0.2, echoes: 0.2, howls: 0.3 });
AMB[Biome.Tundra] = A({ wind: 1, birds: 0.1, howls: 0.6, sand: 0.2 });
AMB[Biome.Glacier] = A({ wind: 1.2, ice: 1, chimes: 0.15 });
AMB[Biome.Swamp] = A({ wind: 0.3, leaves: 0.5, birds: 0.5, frogs: 1, crickets: 0.8, drips: 0.3, nightBirds: 0.5, cicadas: 0.4 });
AMB[Biome.Volcanic] = A({ wind: 0.5, volcanic: 1, sand: 0.3 });
AMB[Biome.CrystalWastes] = A({ wind: 0.6, chimes: 1, hum: 0.6 });
AMB[Biome.FungalGrove] = A({ wind: 0.2, drips: 0.6, spores: 1, crickets: 0.3, hum: 0.2 });
AMB[Biome.FloatingIsles] = A({ wind: 1.1, birds: 0.6, chimes: 0.3 });
AMB[Biome.KarstPillars] = A({ wind: 0.5, leaves: 0.7, birds: 0.9, drips: 0.3, frogs: 0.2, crickets: 0.6 });
AMB[Biome.SaltFlats] = A({ wind: 0.8, sand: 0.4, hum: 0.15 });
AMB[Biome.GlowCaverns] = A({ wind: 0, drips: 0.8, spores: 0.8, drone: 0.6, hum: 0.3, crickets: 0.25 });
AMB[Biome.Geodes] = A({ wind: 0, drips: 0.4, chimes: 1, drone: 0.5, hum: 0.6 });
AMB[Biome.MagmaDepths] = A({ wind: 0, volcanic: 1, drone: 0.7, echoes: 0.5 });
AMB[Biome.UnderSea] = A({ wind: 0, drips: 1, frogs: 0.3, drone: 0.6, echoes: 0.6, lap: 1 });
AMB[Biome.BoneHollows] = A({ wind: 0.3, echoes: 1, drone: 0.8, creaks: 0.2 });
AMB[Biome.RootCathedral] = A({ wind: 0, drips: 0.6, creaks: 0.8, drone: 0.4, leaves: 0.2, crickets: 0.2 });
const AMB_KEYS = Object.keys(A({})) as (keyof Amb)[];

/** One continuous bed layer. */
class Bed {
  gain: GainNode | null = null;
  filter: BiquadFilterNode | null = null;
  private srcs: AudioScheduledSourceNode[] = [];
  private quiet = 0;
  private ctx: AudioContext | null = null;
  level = 0;

  constructor(
    private engine: AudioEngine,
    /** Builds the sources into `dest` (null when not ready, e.g. buffer still rendering). */
    private build: (ctx: AudioContext, dest: AudioNode) => AudioScheduledSourceNode[] | null,
    private lpBase = 18000,
  ) {}

  /** Set the level (0..1) and an extra lowpass (muffling); starts/stops lazily. */
  set(level: number, lp: number, dt: number, tc = 1.2): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (ctx !== this.ctx) {
      // Context changed: drop nodes that belong to the old one.
      this.srcs = [];
      this.gain = null;
      this.filter = null;
      this.ctx = ctx;
    }
    this.level = level;
    if (level > 0.003 && !this.srcs.length) {
      if (!this.gain) {
        const g = ctx.createGain();
        g.gain.value = 0;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = Math.min(this.lpBase, lp);
        f.connect(g);
        g.connect(this.engine.bus.ambience);
        this.gain = g;
        this.filter = f;
      }
      // Sources may not be ready yet (loop still rendering) — retry next frame.
      const srcs = this.build(ctx, this.filter!);
      if (srcs) {
        this.srcs = srcs;
        this.quiet = 0;
      }
    }
    if (!this.gain) return;
    const now = ctx.currentTime;
    this.gain.gain.setTargetAtTime(level, now, tc);
    this.filter!.frequency.setTargetAtTime(Math.max(150, Math.min(this.lpBase, lp)), now, 0.5);
    // Free the graph after it has been silent for a while (CPU).
    if (level < 0.003) {
      this.quiet += dt;
      if (this.quiet > 6) this.stop();
    } else this.quiet = 0;
  }

  stop(): void {
    for (const s of this.srcs) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.srcs = [];
    this.gain?.disconnect();
    this.gain = null;
    this.filter = null;
  }
}

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();

export class Ambience {
  readonly wild: Wildlife;
  private beds: Record<string, Bed> = {};
  private gust = 0.5;
  private gustTarget = 0.5;
  private gustTimer = 0;
  private windHi: BiquadFilterNode | null = null;
  private windLo: BiquadFilterNode | null = null;
  private whistle: BiquadFilterNode | null = null;
  private amb: Amb = A({});
  private defs = new Map<string, SoundDef>();
  private thunderCooldown = 5;
  /** Debug: per-emitter rates last frame. */
  rates: Record<string, number> = {};

  constructor(private engine: AudioEngine, private faunaSeed: number, private weird: number, private tuning: UiTuning) {
    this.wild = createWildlife(faunaSeed, weird);
    this.makeBeds();
  }

  // ---------------------------------------------------------------- beds

  private loopBed(key: string, seconds: number, rate: number, render: (s: Synth) => void, lpBase = 18000): Bed {
    return new Bed(this.engine, (ctx, dest) => {
      const buf = this.engine.getBuffer('amb:' + key + ':' + this.faunaSeed, () =>
        renderOffline(rate, seconds + 1.5, 2, render).then((b) => loopBuffer(b, 1.5)),
      );
      if (!buf) return null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(dest);
      src.start(ctx.currentTime, R() * buf.duration);
      return [src];
    }, lpBase);
  }

  private makeBeds() {
    const e = this.engine;
    const W = this.wild;
    // Wind: live noise through two bands + a resonant whistle (all modulated by gusts).
    this.beds.wind = new Bed(e, (ctx, dest) => {
      const s = new Synth(ctx, dest, ctx.currentTime);
      const lo = s.filter('lowpass', 400, 0.7, dest);
      const hi = s.filter('bandpass', 900, 0.8, dest);
      const wh = s.filter('bandpass', 1400, 18);
      const whg = s.gain(0.25, dest);
      wh.connect(whg);
      this.windLo = lo;
      this.windHi = hi;
      this.whistle = wh;
      const a = ctx.createBufferSource();
      a.buffer = s.noise.brown;
      a.loop = true;
      a.connect(lo);
      const b = ctx.createBufferSource();
      b.buffer = s.noise.pink;
      b.loop = true;
      const bg = s.gain(0.35, hi);
      b.connect(bg);
      b.connect(wh);
      a.start(ctx.currentTime, R() * 2);
      b.start(ctx.currentTime, R() * 2);
      return [a, b];
    });
    this.beds.leaves = this.loopBed('leaves', 8, 44100, (s) => {
      // Granular rustle: many short highpassed bursts in stereo.
      for (let i = 0; i < 260; i++) {
        const p = s.stereo(s.r(-1, 1), s.out);
        s.burst({ t: s.r(0, 8), dur: s.r(0.02, 0.12), f: s.r(2500, 8000), q: s.r(0.6, 2), peak: s.r(0.02, 0.08), a: s.r(0.005, 0.03), dest: p });
      }
      const g = s.gain(0.05, s.out);
      s.noiseSrc('pink', s.t, 9.5, s.filter('highpass', 2500, 0.7, g));
    });
    this.beds.rain = this.loopBed('rain', 6, 44100, (s) => {
      const g = s.gain(0.22, s.out);
      s.noiseSrc('pink', s.t, 7.5, s.filter('bandpass', 2500, 0.4, g));
      const g2 = s.gain(0.12, s.out);
      s.noiseSrc('white', s.t, 7.5, s.filter('highpass', 6000, 0.7, g2));
      // Individual drops
      for (let i = 0; i < 500; i++) {
        const p = s.stereo(s.r(-1, 1), s.out);
        const f = s.r(1500, 6000);
        s.tone({ t: s.r(0, 7.4), f, f2: f * s.r(1.1, 1.6), d: s.r(0.008, 0.03), peak: s.r(0.01, 0.05), dest: p });
      }
    });
    this.beds.waves = this.loopBed('waves', 16, 22050, (s) => {
      // Swells of brown/pink noise with crash + wash.
      const T = s.t;
      for (let w = 0; w < 3; w++) {
        const t0 = w * 5.4 + s.r(0, 1);
        const p = s.stereo(s.r(-0.5, 0.5), s.out);
        const g = s.gain(0, p);
        const lp = s.filter('lowpass', 500, 0.7, g);
        lp.frequency.setValueAtTime(400, T + t0);
        lp.frequency.linearRampToValueAtTime(2500, T + t0 + 2.2);
        lp.frequency.exponentialRampToValueAtTime(500, T + t0 + 5.5);
        g.gain.setValueAtTime(0.05, T + t0);
        g.gain.linearRampToValueAtTime(0.5, T + t0 + 2.2);
        g.gain.exponentialRampToValueAtTime(0.03, T + t0 + 5.8);
        s.noiseSrc('pink', T + t0, 6, lp);
        bubbles(s, t0 + 2.4, 2.5, 30, 600, 2500, 0.015, p);
      }
      const bed = s.gain(0.1, s.out);
      s.noiseSrc('brown', T, 17.5, s.filter('lowpass', 300, 0.7, bed));
    }, 9000);
    this.beds.stream = this.loopBed('stream', 6, 44100, (s) => {
      const g = s.gain(0.12, s.out);
      s.noiseSrc('pink', s.t, 7.5, s.filter('bandpass', 1200, 0.6, g));
      for (let i = 0; i < 6; i++) bubbles(s, s.r(0, 7), 1, 30, 300, 2000, 0.05, s.stereo(s.r(-0.8, 0.8), s.out));
    });
    this.beds.crickets = this.loopBed('crickets', 6, 44100, (s) => renderCrickets(s, W.crickets, 7.5));
    this.beds.cicadas = this.loopBed('cicadas', 8, 44100, (s) => renderCicadas(s, W.cicada, 9.5));
    this.beds.murmur = this.loopBed('murmur', 10, 22050, (s) => {
      // Crowd: overlapping gibberish voices of the local people, distant & muffled.
      const races = ['human', 'elf', 'dwarf', 'orc', 'halfling', 'goblin'];
      for (let i = 0; i < 14; i++) {
        const v = speechVoice(s.pick(races), undefined, Math.floor(s.r(0, 1e6)));
        const p = s.stereo(s.r(-0.9, 0.9), s.out);
        const g = s.gain(s.r(0.15, 0.4), p);
        const text = s.pick(['ah well then so', 'the market is busy today', 'did you hear that', 'more bread please', 'hey over here', 'no no no', 'ha ha']);
        speak(s.ctx, g, s.t + s.r(0, 9), v, syllabify(text, 0, 10), 'neutral', 'say', s.rand);
      }
      const bed = s.gain(0.04, s.out);
      s.noiseSrc('pink', s.t, 11.5, s.filter('bandpass', 500, 0.8, bed));
    }, 3500);
    this.beds.lava = this.loopBed('lava', 8, 22050, (s) => {
      const g = s.gain(0.35, s.out);
      s.noiseSrc('brown', s.t, 9.5, s.filter('lowpass', 180, 0.8, g));
      for (let i = 0; i < 26; i++) {
        const p = s.stereo(s.r(-0.8, 0.8), s.out);
        const f = s.r(60, 160);
        s.tone({ t: s.r(0, 9), f, f2: f * s.r(1.5, 2.5), d: s.r(0.08, 0.2), peak: s.r(0.1, 0.3), dest: p });
      }
      crackles(s, 0, 9, 50, 800, 3000, 0.04);
    }, 6000);
    // Cave drone: two low detuned tones + filtered brown noise, slowly breathing.
    this.beds.drone = new Bed(e, (ctx, dest) => {
      const s = new Synth(ctx, dest, ctx.currentTime);
      const f0 = rr(38, 55);
      const lp = s.filter('lowpass', 220, 1, dest);
      const o1 = ctx.createOscillator();
      o1.frequency.value = f0;
      const o2 = ctx.createOscillator();
      o2.frequency.value = f0 * 1.5 * 1.004;
      const og = s.gain(0.25, lp);
      o1.connect(og);
      o2.connect(s.gain(0.12, lp));
      const n = ctx.createBufferSource();
      n.buffer = s.noise.brown;
      n.loop = true;
      n.connect(s.gain(0.25, lp));
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      lfo.connect(s.gain(0.12, og.gain));
      for (const x of [o1, o2, lfo]) x.start();
      n.start(ctx.currentTime, R() * 2);
      return [o1, o2, n, lfo];
    });
    // Underworld: deep sub rumble with slow beating + distant air.
    this.beds.deep = new Bed(e, (ctx, dest) => {
      const s = new Synth(ctx, dest, ctx.currentTime);
      const lp = s.filter('lowpass', 120, 0.8, dest);
      const o1 = ctx.createOscillator();
      o1.frequency.value = 27;
      const o2 = ctx.createOscillator();
      o2.frequency.value = 27.6;
      o1.connect(s.gain(0.12, lp));
      o2.connect(s.gain(0.12, lp));
      const n = ctx.createBufferSource();
      n.buffer = s.noise.brown;
      n.loop = true;
      n.connect(s.gain(0.22, lp));
      const air = ctx.createBufferSource();
      air.buffer = s.noise.pink;
      air.loop = true;
      air.connect(s.filter('bandpass', 700, 0.5, s.gain(0.05, dest)));
      for (const x of [o1, o2]) x.start();
      n.start(ctx.currentTime, R() * 2);
      air.start(ctx.currentTime, R() * 2);
      return [o1, o2, n, air];
    });
    // Crystal hum: high beating partials tuned to the world's scale.
    this.beds.hum = new Bed(e, (ctx, dest) => {
      const s = new Synth(ctx, dest, ctx.currentTime);
      const srcs: AudioScheduledSourceNode[] = [];
      for (let i = 0; i < 4; i++) {
        const f = degreeHz(this.tuning, Math.floor(R() * 6)) * 4;
        for (const det of [0, rr(0.5, 2)]) {
          const o = ctx.createOscillator();
          o.frequency.value = f + det;
          const p = s.stereo(rr(-0.8, 0.8), dest);
          o.connect(s.gain(0.02, p));
          o.start();
          srcs.push(o);
        }
      }
      return srcs;
    });
    // Underwater: muffled pressure rumble.
    this.beds.underwater = new Bed(e, (ctx, dest) => {
      const s = new Synth(ctx, dest, ctx.currentTime);
      const n = ctx.createBufferSource();
      n.buffer = s.noise.brown;
      n.loop = true;
      n.connect(s.filter('lowpass', 300, 1, s.gain(0.35, dest)));
      n.start(ctx.currentTime, R() * 2);
      return [n];
    });
  }

  // ---------------------------------------------------------------- update

  update(dt: number, env: AudioEnv, listener: Vec3): void {
    if (!this.engine.running) return;
    // Blend biome profiles by weight.
    const a = this.amb;
    for (const k of AMB_KEYS) a[k] = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const w = env.biomeW[b];
      if (w < 0.01 || !AMB[b]) continue;
      const p = AMB[b];
      for (const k of AMB_KEYS) a[k] += p[k] * w;
    }
    const under = Math.max(env.cave, env.underworld);
    const open = (1 - under) * (1 - env.indoor * 0.85);
    const shelter = 1 - env.enclosure * 0.7;
    const wet = env.rain;
    const day = env.day;
    const night = env.night;
    const indoorLp = lerp(18000, 900, env.indoor);
    const snowLp = lerp(18000, 5500, env.snow);
    const lp = Math.min(indoorLp, snowLp);

    // ---- gusts (smoothed random walk)
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = rr(1.5, 5);
      this.gustTarget = rr(0.2, 1);
    }
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt * 0.8));
    const g = this.gust;

    // ---- wind: altitude, weather, biome; enclosed spaces & caves block it.
    const altitude = smoothstep(20, 300, env.altitude);
    const wind = clamp((a.wind * 0.6 + altitude * 0.7 + env.wind * 0.6) * open * shelter * (0.55 + g * 0.6), 0, 1.4);
    this.beds.wind.set(wind * 0.5, lp, dt, 0.6);
    const now = this.engine.now;
    if (this.windLo) this.windLo.frequency.setTargetAtTime(250 + g * 500 + env.storm * 300, now, 0.4);
    if (this.windHi) this.windHi.frequency.setTargetAtTime(600 + g * 1400 + altitude * 800, now, 0.5);
    if (this.whistle) this.whistle.frequency.setTargetAtTime(900 + g * 1600 + altitude * 900, now, 0.8);

    // ---- beds
    const tree = env.forest * open;
    this.beds.leaves.set(clamp(tree * (a.leaves * 0.6 + 0.3) * (0.35 + g * 0.8) * (1 + env.storm), 0, 1) * 0.55, lp, dt);
    this.beds.rain.set(clamp(wet * (1 - under * 0.9), 0, 1) * 0.7, lerp(lp, 1400, env.indoor), dt, 1.5);
    const insectsOk = (1 - wet * 0.8) * (1 - env.snow) * open;
    this.beds.crickets.set(clamp(a.crickets * night * insectsOk + under * (a.crickets * 0.5), 0, 1) * 0.45, lp, dt, 2);
    const heat = smoothstep(-0.1, 0.6, env.temp);
    this.beds.cicadas.set(clamp(a.cicadas * day * heat * insectsOk, 0, 1) * 0.3, lp, dt, 2);
    this.beds.waves.set(clamp(env.coast * (1 - under) + a.lap * env.underworld * 0.5, 0, 1) * 0.7 * (1 + env.storm * 0.5), lp, dt, 2);
    this.beds.stream.set(clamp(env.river, 0, 1) * 0.5, lp, dt, 2);
    this.beds.murmur.set(clamp(env.settlement * (0.25 + 0.75 * day) * (1 - wet * 0.6), 0, 1) * 0.35, lp, dt, 2);
    this.beds.lava.set(clamp(a.volcanic, 0, 1) * 0.5, lp, dt, 2);
    this.beds.drone.set(clamp(env.cave * 0.7 + a.drone * env.underworld * 0.6, 0, 1) * 0.5, 18000, dt, 2.5);
    this.beds.deep.set(clamp(env.underworld, 0, 1) * 0.6, 18000, dt, 3);
    this.beds.hum.set(clamp(a.hum + a.chimes * 0.2, 0, 1) * 0.4, 18000, dt, 3);
    this.beds.underwater.set(env.underwater ? 0.7 : 0, 18000, dt, 0.3);

    if (env.underwater) return; // emitters are inaudible underwater

    // ---- emitters (rates per minute, Poisson)
    const r = this.rates;
    const birdOk = (1 - wet * 0.85) * (1 - env.snow * 0.7) * open * (1 - env.storm);
    r.bird = (a.birds * (day * 6 + env.dawn * 26 + env.dusk * 8)) * birdOk * (0.4 + env.forest * 0.8);
    r.owl = a.nightBirds * night * 3 * birdOk;
    r.gull = env.coast * day * 3 * birdOk;
    r.frog = a.frogs * (2 + night * 14 + wet * 6) * (1 - env.snow) + env.river * night * 4;
    r.howl = a.howls * night * 0.9 * open;
    r.drip = a.drips * 10 * (0.3 + under) + env.cave * 8 + wet * env.indoor * 6;
    r.chime = a.chimes * 9;
    r.spore = a.spores * 7 + env.spores * 8;
    r.volcanic = a.volcanic * 3;
    r.echo = a.echoes * 3 + env.underworld * 1.2 + env.cave * 0.6;
    r.creak = a.creaks * (1 + g * 4) * (0.4 + env.wind) * (under > 0.5 ? 0.6 : env.forest);
    r.sand = a.sand * g * 5 * open;
    r.ice = a.ice * 2.5;
    r.work = env.settlement * day * 9 * (1 - wet * 0.7);
    r.thunder = env.storm > 0.3 ? 3 * env.storm : 0;
    for (const k in r) {
      const rate = r[k] / 60;
      if (rate > 0 && R() < rate * dt) this.emit(k, env, listener);
    }
  }

  // ---------------------------------------------------------------- emitters

  private def(key: string, make: () => SoundDef): SoundDef {
    let d = this.defs.get(key);
    if (!d) {
      d = make();
      this.defs.set(key, d);
    }
    return d;
  }

  /** Random point around the listener (ring), with height offset. */
  private around(l: Vec3, rMin: number, rMax: number, hMin: number, hMax: number): Vec3 {
    const a = R() * Math.PI * 2;
    const d = rr(rMin, rMax);
    return [l[0] + Math.cos(a) * d, l[1] + rr(hMin, hMax), l[2] + Math.sin(a) * d];
  }

  private amb_(o: Partial<SoundDef> & Pick<SoundDef, 'dur' | 'render'>): SoundDef {
    return sd({ bus: 'ambience', group: 'ambient', cheapPan: true, variants: 3, priority: 0.5, range: 400, jitter: 0.04, ...o });
  }

  private emit(kind: string, env: AudioEnv, l: Vec3) {
    const e = this.engine;
    const W = this.wild;
    switch (kind) {
      case 'bird':
      case 'owl':
      case 'gull': {
        const cands = W.birds.filter((b) => (kind === 'gull' ? b.coastal : kind === 'owl' ? b.night : !b.night && !b.coastal && birdFits(b, env.dominant)));
        const pool = cands.length ? cands : W.birds.filter((b) => !b.night && !b.coastal);
        if (!pool.length) return;
        const b = pool[Math.floor(R() * pool.length)];
        if (R() > b.rate / 1.5) return;
        const def = this.def('bird' + b.id, () => this.amb_({ dur: b.dur + 0.3, gain: kind === 'gull' ? 0.5 : 0.4, ref: 6, render: (s) => renderBird(s, b) }));
        e.play(def, `bird:${this.faunaSeed}:${b.id}`, { pos: this.around(l, 12, 60, 3, 14) });
        // Dawn chorus: neighbours answer.
        if (env.dawn > 0.4 && R() < 0.5) e.play(def, `bird:${this.faunaSeed}:${b.id}`, { pos: this.around(l, 25, 80, 3, 14), when: e.now + rr(0.8, 2.5), volume: 0.6 });
        break;
      }
      case 'frog': {
        const i = Math.floor(R() * W.frogs.length);
        const f = W.frogs[i];
        const def = this.def('frog' + i, () => this.amb_({ dur: f.pulses / f.pulseRate + f.dur + 0.2, gain: 0.35, ref: 3, render: (s) => renderFrog(s, f) }));
        e.play(def, `frog:${this.faunaSeed}:${i}`, { pos: this.around(l, 6, 40, -1, 0.5) });
        break;
      }
      case 'howl': {
        const sp = W.howlers[Math.floor(R() * W.howlers.length)];
        const def = this.def('howl' + sp, () => this.amb_({ dur: 4, gain: 0.45, ref: 30, range: 3000, render: (s) => { renderCreatureCall(s, this.faunaSeed, sp, 1.4, 'alert', this.weird); } }));
        e.play(def, `howl:${this.faunaSeed}:${sp}`, { pos: this.around(l, 150, 450, 0, 30), reverb: 1.5 });
        break;
      }
      case 'drip': {
        const def = this.def('drip', () => this.amb_({
          dur: 0.4, variants: 8, gain: 0.4, ref: 2, render(s) {
            const f = s.r(700, 2200);
            s.tone({ f, f2: f * s.r(1.6, 2.6), glide: 0.03, d: s.r(0.05, 0.12), peak: 0.4 });
            s.burst({ dur: 0.02, f: 3000, q: 1, peak: 0.08 });
          },
        }));
        e.play(def, 'amb:drip', { pos: this.around(l, 2, 18, 0, 6), reverb: 1.6 });
        break;
      }
      case 'chime': {
        const tu = this.tuning;
        const def = this.def('chime', () => this.amb_({
          dur: 3, variants: 6, gain: 0.3, ref: 4, render(s) {
            const n = s.ri(1, 3);
            for (let i = 0; i < n; i++) s.modal(i * s.r(0.1, 0.5), degreeHz(tu, s.ri(0, 9)) * 4, GLASS, 0.15, undefined, 0.002);
          },
        }));
        e.play(def, 'amb:chime:' + this.faunaSeed, { pos: this.around(l, 5, 35, 0, 8) });
        break;
      }
      case 'spore': {
        const def = this.def('spore', () => this.amb_({
          dur: 1.2, variants: 5, gain: 0.35, ref: 2, render(s) {
            s.burst({ dur: s.r(0.3, 0.7), f: s.r(600, 1400), q: 0.6, peak: 0.25, a: 0.05, color: 'pink', type: 'lowpass' });
            s.tone({ f: s.r(150, 300), f2: s.r(400, 700), d: 0.05, peak: 0.12 });
            bubbles(s, 0.05, 0.4, 4, 800, 2000, 0.03);
          },
        }));
        e.play(def, 'amb:spore', { pos: this.around(l, 3, 20, 0, 3) });
        break;
      }
      case 'volcanic': {
        const def = this.def('volcanic', () => this.amb_({
          dur: 5, variants: 4, gain: 0.7, ref: 30, range: 2000, render(s) {
            if (s.chance(0.5)) {
              rumble(s, 0, s.r(2.5, 4.5), 120, 0.8, s.r(0.2, 1));
              debris(s, s.r(0.3, 1), 6, 500, STONE, 0.05, 2);
            } else {
              // Vent hiss
              s.burst({ dur: s.r(1.5, 3), f: s.r(2500, 5000), q: 0.6, peak: 0.25, a: 0.3, type: 'bandpass' });
              crackles(s, 0, 2, 20, 1500, 5000, 0.05);
            }
          },
        }));
        e.play(def, 'amb:volcanic', { pos: this.around(l, 40, 300, -5, 20) });
        break;
      }
      case 'echo': {
        const def = this.def('echo', () => this.amb_({
          dur: 4, variants: 5, gain: 0.5, ref: 25, range: 2500, reverb: 2, render(s) {
            const k = s.ri(0, 2);
            if (k === 0) debris(s, 0, s.ri(5, 12), 600, STONE, 0.15, 1.5);
            else if (k === 1) { s.thump(0, 45, 0.6, 0.6); rumble(s, 0, 2, 150, 0.4, 0.05); }
            else creak(s, 0, s.r(1.5, 3), s.r(8, 15), s.r(15, 30), s.r(150, 300), 0.3); // stone groan
          },
        }));
        e.play(def, 'amb:echo', { pos: this.around(l, 60, 250, -20, 40), lowpass: 2500, reverb: 2 });
        break;
      }
      case 'creak': {
        const def = this.def('creak', () => this.amb_({
          dur: 2.4, variants: 6, gain: 0.35, ref: 4, render(s) {
            creak(s, 0, s.r(0.8, 2), s.r(15, 40), s.r(20, 60), s.r(300, 700), 0.25);
            if (s.chance(0.4)) s.modal(s.r(0.5, 1.5), s.r(150, 300), WOOD, 0.08);
          },
        }));
        e.play(def, 'amb:creak', { pos: this.around(l, 6, 40, 2, 10) });
        break;
      }
      case 'sand': {
        const def = this.def('sand', () => this.amb_({
          dur: 4, variants: 4, gain: 0.35, ref: 10, render(s) {
            s.burst({ dur: s.r(2, 3.5), f: s.r(2500, 5000), q: 0.5, peak: 0.35, a: s.r(0.8, 1.5), lin: true });
            crunch(s, 0.5, 2.5, 50, 3000, 8000, 0.03, 1);
          },
        }));
        e.play(def, 'amb:sand', { pos: this.around(l, 10, 50, 0, 3) });
        break;
      }
      case 'ice': {
        const def = this.def('icecrack', () => this.amb_({
          dur: 2, variants: 5, gain: 0.5, ref: 25, range: 1500, render(s) {
            s.burst({ dur: 0.02, f: 4000, q: 0.6, peak: 0.4 });
            for (let i = 0; i < 4; i++) s.tone({ t: s.r(0, 0.3), f: s.r(2500, 5000), f2: s.r(150, 400), glide: 0.25, d: 0.35, peak: 0.12 });
            s.thump(0.02, 50, 0.4, 0.5);
          },
        }));
        e.play(def, 'amb:ice', { pos: this.around(l, 30, 200, -10, 5) });
        break;
      }
      case 'work': {
        const def = this.def('work', () => this.amb_({
          dur: 3, variants: 6, gain: 0.45, ref: 6, range: 600, render(s) {
            const k = s.ri(0, 3);
            if (k <= 1) for (let i = 0; i < s.ri(2, 5); i++) { s.modal(i * s.r(0.45, 0.7), s.r(900, 1300), METAL, 0.12); s.click(i * 0.55, 4000, 0.2); }
            else if (k === 2) for (let i = 0; i < 3; i++) s.modal(i * s.r(0.3, 0.6), s.r(120, 220), WOOD, 0.5);
            else creak(s, 0, 1.2, 25, 60, 500, 0.2);
          },
        }));
        e.play(def, 'amb:work', { pos: this.around(l, 15, 70, 0, 4) });
        break;
      }
      case 'thunder': {
        if (this.thunderCooldown > e.now) return;
        this.thunderCooldown = e.now + rr(4, 12);
        // Distance → delay is implicit (sound arrives later than the flash); farther = darker.
        const far = R() < 0.65;
        const d = far ? rr(1200, 4500) : rr(250, 1100);
        const def = this.def(far ? 'thunder_far' : 'thunder_near', () => this.amb_({
          dur: 7, variants: 4, gain: 1, ref: 400, range: 20000, priority: 2, render(s) {
            if (!far) {
              s.burst({ dur: 0.3, f: 5000, f2: 700, q: 0.4, type: 'lowpass', peak: 0.7 });
              crackles(s, 0, 0.4, 20, 1500, 6000, 0.25);
            }
            for (let i = 0; i < s.ri(3, 6); i++) rumble(s, s.r(0, 3), s.r(2, 4), s.r(100, 220), s.r(0.35, 0.8), s.r(0.1, 0.8));
          },
        }));
        e.play(def, far ? 'amb:thunderfar' : 'amb:thunder', { pos: this.around(l, d, d, 200, 600), lowpass: far ? 900 : 4000 });
        break;
      }
    }
  }

  dispose(): void {
    for (const b of Object.values(this.beds)) b.stop();
  }
}
