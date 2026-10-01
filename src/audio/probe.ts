/**
 * Listener environment probe: turns world queries into smoothed acoustic
 * context for reverb, ambience, music and muffling.
 *
 *  - biome weights sampled on two rings around the listener (crossfades
 *    ambience as you walk across biome borders),
 *  - underground / underworld / cave enclosure via round-robin terrain rays
 *    (also estimates room size → small cave vs vast cavern),
 *  - roofs from static colliders (indoors),
 *  - water: coast, rivers, underwater,
 *  - settlements, altitude, time of day and weather.
 *
 * All expensive queries are amortized over frames.
 */
import type { ClientContext } from '../client/context';
import type { Vec3, WeatherKind } from '../shared/types';
import { Biome, BIOMES, BIOME_COUNT } from '../world/biomes';
import { SEA_LEVEL, UNDERWORLD_SEA_LEVEL } from '../world/constants';
import { clamp, smoothstep } from '../core/math';
import type { SpaceKind } from './reverb';

export interface AudioEnv {
  pos: Vec3;
  /** Smoothed biome weights (sum ≈ 1). */
  biomeW: Float32Array;
  dominant: Biome;
  underworld: number;
  /** Underground (non-underworld) cave factor. */
  cave: number;
  /** Fraction of probe rays that hit nearby rock (0 open … 1 enclosed). */
  enclosure: number;
  /** Mean free path of probe rays (m). */
  roomSize: number;
  indoor: number;
  /** Height above sea level and above the 2D surface. */
  altitude: number;
  aboveGround: number;
  /** 0..1 how far above the local snow line (high mountains). */
  alpine: number;
  coast: number;
  river: number;
  forest: number;
  settlement: number;
  siteRace: string | null;
  underwater: boolean;
  day: number;
  dawn: number;
  dusk: number;
  night: number;
  weather: WeatherKind;
  rain: number;
  storm: number;
  snow: number;
  fog: number;
  ash: number;
  spores: number;
  /** Overall wind strength 0..1+. */
  wind: number;
  /** Local temperature (climate units -1..1). */
  temp: number;
  space: SpaceKind;
}

export function createEnv(): AudioEnv {
  const biomeW = new Float32Array(BIOME_COUNT);
  biomeW[Biome.Grassland] = 1;
  return {
    pos: [0, 0, 0], biomeW, dominant: Biome.Grassland, underworld: 0, cave: 0, enclosure: 0, roomSize: 60, indoor: 0,
    altitude: 10, aboveGround: 2, alpine: 0, coast: 0, river: 0, forest: 0, settlement: 0, siteRace: null, underwater: false,
    day: 1, dawn: 0, dusk: 0, night: 0, weather: 'clear', rain: 0, storm: 0, snow: 0, fog: 0, ash: 0, spores: 0, wind: 0.3, temp: 0, space: 'open',
  };
}

/** Probe ray directions (normalized): up, 4 horizontal, 4 upward diagonals. */
const RAYS: Vec3[] = [
  [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [0.6, 0.6, 0.53], [-0.6, 0.6, -0.53], [0.53, 0.6, -0.6], [-0.53, 0.6, 0.6],
];
const RAY_MAX = 48;

/** Time-of-day helpers (0.25 sunrise, 0.75 sunset). */
export function dayFactors(t: number) {
  const day = smoothstep(0.21, 0.29, t) * (1 - smoothstep(0.71, 0.79, t));
  const dawn = Math.exp(-Math.pow((t - 0.255) / 0.035, 2));
  const dusk = Math.exp(-Math.pow((t - 0.745) / 0.035, 2));
  return { day, dawn, dusk, night: 1 - day };
}

export class EnvProbe {
  readonly env: AudioEnv = createEnv();
  /** Sandbox override (partial fields win over probing). */
  override: Partial<AudioEnv> | null = null;
  private rayHits = new Float32Array(RAYS.length).fill(RAY_MAX);
  private rayIdx = 0;
  private sampleTimer = 0;
  private targetW = new Float32Array(BIOME_COUNT);
  /** Smoothed biome weights (kept separate so an override can't be mutated). */
  private w = this.env.biomeW;
  private target = { coast: 0, river: 0, forest: 0, settlement: 0, cave: 0, underworld: 0, indoor: 0, alpine: 0 };
  private spaceCandidate: SpaceKind = 'open';
  private spaceTimer = 0;

  constructor(private ctx: ClientContext | null) {}

  update(dt: number, pos: Vec3): AudioEnv {
    const e = this.env;
    e.pos[0] = pos[0];
    e.pos[1] = pos[1];
    e.pos[2] = pos[2];
    const ctx = this.ctx;
    if (ctx) {
      this.probeRays(pos);
      this.sampleTimer -= dt;
      if (this.sampleTimer <= 0) {
        this.sampleTimer = 0.4;
        this.sampleWorld(pos);
      }
      // Time & weather
      const tod = ctx.env.timeOfDay ?? ctx.state.timeOfDay;
      const df = dayFactors(tod);
      e.day = df.day;
      e.dawn = df.dawn;
      e.dusk = df.dusk;
      e.night = df.night;
      const w = ctx.env.weather;
      e.weather = w.kind;
      const k = (kind: WeatherKind) => (w.kind === kind ? w.intensity : 0);
      e.rain = k('rain') + k('storm');
      e.storm = k('storm');
      e.snow = k('snow');
      e.fog = k('fog');
      e.ash = k('ashfall');
      e.spores = k('sporefall');
      const windMag = Math.min(1.5, Math.hypot(w.windX, w.windZ) / 8);
      e.wind = 0.25 + windMag * 0.3 + e.storm * 0.7 + e.snow * 0.3 + (w.kind === 'cloudy' ? 0.1 : 0);
      // Smooth spatial targets (≈2 s crossfades while walking).
      const a = 1 - Math.exp(-dt * 0.6);
      const W = this.w;
      let sum = 0;
      for (let i = 0; i < BIOME_COUNT; i++) {
        W[i] += (this.targetW[i] - W[i]) * a;
        sum += W[i];
      }
      if (sum > 0) for (let i = 0; i < BIOME_COUNT; i++) W[i] /= sum;
      e.biomeW = W;
      const t = this.target;
      const b = 1 - Math.exp(-dt * 1.2);
      e.coast += (t.coast - e.coast) * a;
      e.river += (t.river - e.river) * a;
      e.forest += (t.forest - e.forest) * a;
      e.settlement += (t.settlement - e.settlement) * a;
      e.alpine += (t.alpine - e.alpine) * a;
      e.cave += (t.cave - e.cave) * b;
      e.underworld += (t.underworld - e.underworld) * b;
      e.indoor += (t.indoor - e.indoor) * b;
      // Enclosure from rays
      let hits = 0;
      let free = 0;
      for (let i = 0; i < RAYS.length; i++) {
        if (this.rayHits[i] < RAY_MAX) hits++;
        free += this.rayHits[i];
      }
      const enc = hits / RAYS.length;
      e.enclosure += (enc - e.enclosure) * b;
      e.roomSize += (free / RAYS.length - e.roomSize) * b;
    }
    if (this.override) Object.assign(e, this.override);
    let best = 0;
    for (let i = 0; i < BIOME_COUNT; i++) if (e.biomeW[i] > e.biomeW[best]) best = i;
    e.dominant = best as Biome;
    this.chooseSpace(dt);
    return e;
  }

  /** One or two terrain rays per frame, round-robin. */
  private probeRays(pos: Vec3) {
    const terrain = this.ctx!.terrain;
    for (let k = 0; k < 2; k++) {
      const i = this.rayIdx;
      this.rayIdx = (this.rayIdx + 1) % RAYS.length;
      const d = RAYS[i];
      try {
        const hit = terrain.raycast(pos[0], pos[1] + 0.3, pos[2], d[0], d[1], d[2], RAY_MAX);
        this.rayHits[i] = hit ? hit.dist : RAY_MAX;
      } catch {
        this.rayHits[i] = RAY_MAX;
      }
    }
  }

  private sampleWorld(pos: Vec3) {
    const ctx = this.ctx!;
    const gen = ctx.gen;
    const e = this.env;
    const tw = this.targetW;
    tw.fill(0);
    const [x, y, z] = pos;
    const col = gen.cachedColumn(x, z);
    const inUw = gen.isUnderworld(x, y, z);
    e.altitude = y - SEA_LEVEL;
    e.aboveGround = y - col.height;
    e.temp = col.temp;
    // Underworld: weights from underworld biome
    const t = this.target;
    t.underworld = inUw ? 1 : 0;
    t.cave = !inUw && y < col.height - 6 ? clamp((col.height - 6 - y) / 14, 0, 1) : 0;
    // Mountains: terrain (and listener) around/above the snow line.
    t.alpine = inUw ? 0 : smoothstep(col.snowLine - 70, col.snowLine, Math.min(y, col.height + 30)) * (1 - t.cave);
    if (inUw) {
      tw[col.uwBiome] = 1;
    } else {
      // Two rings of samples on an 8 m grid (cache-friendly), centre weighted.
      let wsum = 0;
      let water = 0;
      let samples = 0;
      let veg = 0;
      const add = (sx: number, sz: number, w: number) => {
        const c = gen.cachedColumn(Math.round(sx / 8) * 8, Math.round(sz / 8) * 8);
        tw[c.biome] += w * (1 - c.blend);
        tw[c.biome2] += w * c.blend;
        wsum += w;
        samples++;
        if (c.height < SEA_LEVEL - 0.5) water++;
        const bd = BIOMES[c.biome];
        veg += (bd.vegetation * (1 - c.blend) + BIOMES[c.biome2].vegetation * c.blend) * (1 - c.site * 0.6);
      };
      add(x, z, 2);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(x + Math.cos(a) * 30, z + Math.sin(a) * 30, 1);
        add(x + Math.cos(a + 0.5) * 75, z + Math.sin(a + 0.5) * 75, 0.6);
      }
      for (let i = 0; i < BIOME_COUNT; i++) tw[i] /= wsum;
      // Coast: nearby open water and the listener near sea level.
      const nearSea = 1 - smoothstep(15, 70, Math.abs(y - SEA_LEVEL));
      t.coast = clamp((water / samples) * 2.2, 0, 1) * nearSea * (1 - t.cave);
      t.river = clamp(col.river * 1.5, 0, 1) * (1 - smoothstep(4, 25, y - col.height)) * (1 - t.cave);
      t.forest = clamp((veg / samples) / 1.3, 0, 1) * (1 - t.cave) * (1 - smoothstep(25, 80, y - col.height));
    }
    // Underwater (sea or underworld sea)
    e.underwater = inUw ? y < UNDERWORLD_SEA_LEVEL - 0.3 : y < SEA_LEVEL - 0.3 && col.height < y + 1;
    // Settlements
    const site = inUw ? null : gen.siteAt(x, z);
    t.settlement = site ? clamp(1 - Math.hypot(x - site.x, z - site.z) / (site.radius * 1.5), 0, 1) : 0;
    e.siteRace = site ? site.race : null;
    // Indoors: a solid collider (roof) above the listener within 8 m.
    let roof = false;
    try {
      const hit = ctx.colliders.raycast([x, y + 0.2, z], [0, 1, 0], 8, (c) => c.solid);
      roof = !!hit;
    } catch {
      roof = false;
    }
    t.indoor = roof && !inUw && t.cave < 0.5 ? 1 : 0;
  }

  /** Pick a reverb space with hysteresis (stable for ~0.8 s before switching). */
  private chooseSpace(dt: number) {
    const e = this.env;
    let s: SpaceKind;
    const crystalish = (e.biomeW[Biome.Geodes] ?? 0) + (e.biomeW[Biome.CrystalWastes] ?? 0) + (e.biomeW[Biome.Glacier] ?? 0) * 0.6;
    if (e.underwater) s = 'underwater';
    else if (e.underworld > 0.5) s = e.roomSize < 18 && e.enclosure > 0.8 ? 'cavern' : crystalish > 0.5 ? 'crystal' : 'underworld';
    else if (e.indoor > 0.5) s = e.roomSize > 10 ? 'hall' : 'indoor';
    else if (e.cave > 0.4 || e.enclosure > 0.75) s = crystalish > 0.4 ? 'crystal' : e.roomSize > 22 ? 'cavern' : 'cave';
    else if (e.forest > 0.45) s = 'forest';
    else if (e.altitude > 120 && e.enclosure > 0.15) s = 'mountain';
    else if (e.enclosure > 0.4) s = 'mountain';
    else s = 'open';
    if (s !== this.spaceCandidate) {
      this.spaceCandidate = s;
      this.spaceTimer = 0;
    } else this.spaceTimer += dt;
    if (this.spaceTimer > 0.8 || this.override?.space) e.space = this.override?.space ?? s;
  }
}
