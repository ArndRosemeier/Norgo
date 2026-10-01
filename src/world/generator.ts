/**
 * The world density function.
 *
 * density(x,y,z) > 0 means solid, < 0 means air. Near the surface the value
 * approximates a signed distance in meters, which the mesher, physics and
 * deformation code rely on.
 *
 * The world is *not* a height map: on top of a 2D base surface we add 3D
 * overhangs, natural arches, karst towers, crystal spires, floating islands,
 * spaghetti tunnels, caverns, vertical shafts and a continent-spanning
 * underworld cavern layer with its own biomes.
 */
import { Noise, cellular2, CellResult } from '../core/noise';
import { deriveSeed, hash2i, hashToFloat, hash3i } from '../core/rng';
import { clamp, lerp, smoothstep, saturate } from '../core/math';
import { Biome, BIOMES, TerrainParams, TERRAIN_KEYS } from './biomes';
import { Mat } from './materials';
import { WorldProfile, BiomeInstance, createProfile } from './profile';
import {
  CHUNK_SIZE, CHUNK_PAD, GRID_N, SEA_LEVEL, BEDROCK_Y, UNDERWORLD_CEIL, UNDERWORLD_FLOOR, UNDERWORLD_SEA_LEVEL,
  CAVE_LOD_LIMIT, WORLD_MAX_Y, WORLD_MIN_Y,
} from './constants';
import { SiteMap, segDist, SiteInfo } from './sites';

/** Everything the generator knows about one (x,z) column. Reused objects, no allocation in hot loops. */
export class Column {
  x = 0;
  z = 0;
  /** Final 2D surface height (incl. settlement flattening and roads). */
  height = 0;
  /** Height before settlement/road shaping. */
  natural = 0;
  land = 0;
  continental = 0;
  temp = 0;
  humid = 0;
  weird = 0;
  biome: Biome = Biome.Grassland;
  biome2: Biome = Biome.Grassland;
  blend = 0;
  /** Rockiness 0..1 (mountains / steep zones). */
  rock = 0;
  river = 0;
  road = 0;
  /** Settlement influence 0..1 */
  site = 0;
  siteId: string | null = null;
  overhang = 0;
  arches = 0;
  islands = 0;
  pillars = 0;
  spikes = 0;
  caveEntrance = 0;
  // karst pillar (nearest)
  pDist = 1e9;
  pR = 0;
  pTop = -1e9;
  pBase = 0;
  // crystal spike feature
  sPx = 0;
  sPz = 0;
  sH0 = 0;
  sR = 0;
  sH = 0;
  sTx = 0;
  sTz = 0;
  // floating island
  iTop = -1e9;
  iBot = 1e9;
  // natural stone arch (nearest)
  aX = 0;
  aZ = 0;
  aY = -1e9;
  aR = 0;
  aT = 0;
  aCos = 1;
  aSin = 0;
  // underworld
  uwFloor = 0;
  uwCeil = 0;
  uwBiome: Biome = Biome.GlowCaverns;
  uwPDist = 1e9;
  uwPR = 0;
  // shaft
  shX = 0;
  shZ = 0;
  shR = 0;
  shBottom = 0;
  /** Temperature at sea level after lapse etc. */
  snowLine = 300;
}

export interface ChunkData {
  /** Chunk origin in world meters (minimum corner of cell 0). */
  ox: number;
  oy: number;
  oz: number;
  lod: number;
  step: number;
  /** GRID_N^3 density samples, index = x + y*N + z*N*N, sample i ↔ origin + (i - CHUNK_PAD) * step. */
  density: Float32Array;
  /** Material per sample (only meaningful near the surface). */
  mats: Uint8Array;
  /** Fully air or solid chunks skip meshing. */
  uniform: 'air' | 'solid' | null;
  /** GRID_N^2 2D surface heights per sample column (for sky occlusion). */
  heights?: Float32Array;
}

interface ArchInfo {
  x: number;
  z: number;
  /** Base height (ground at centre). */
  y: number;
  /** Arch radius (centre of tube) and tube thickness. */
  R: number;
  t: number;
  yaw: number;
}

const ARCH_CELL = 190;

interface IslandInfo {
  x: number;
  z: number;
  R: number;
  A: number;
  seed: number;
}

const ISLAND_CELL = 240;
const PILLAR_CELL = 38;
const SPIKE_CELL = 24;
const SHAFT_CELL = 820;
const UW_PILLAR_CELL = 120;
const LATTICE = 4;
const NCH = 8; // lattice channels

export class WorldGenerator {
  readonly profile: WorldProfile;
  readonly sites: SiteMap;
  readonly seed: number;
  private nCont: Noise;
  private nWarp: Noise;
  private nRidge: Noise;
  private nHill: Noise;
  private nDetail: Noise;
  private nClimate: Noise;
  private nCanyon: Noise;
  private nRiver: Noise;
  private nDune: Noise;
  private nCave: Noise;
  private nCave2: Noise;
  private nCavern: Noise;
  private nOver: Noise;
  private nArch: Noise;
  private nIsland: Noise;
  private nUw: Noise;
  private nOre: Noise;
  private nMisc: Noise;
  private present: BiomeInstance[];
  private islandCache = new Map<number, IslandInfo | null>();
  private cell: CellResult = { f1: 0, f2: 0, cx: 0, cy: 0, cz: 0, id: 0, px: 0, py: 0, pz: 0 };
  private tmpCol = new Column();
  private tmpParams: TerrainParams;
  private colCache = new Map<number, Column>();
  private colCacheOrder: number[] = [];

  constructor(profileOrSeed: WorldProfile | number) {
    this.profile = typeof profileOrSeed === 'number' ? createProfile(profileOrSeed) : profileOrSeed;
    const s = (this.seed = this.profile.seed);
    const N = (tag: string) => new Noise(deriveSeed(s, 'noise', tag));
    this.nCont = N('cont');
    this.nWarp = N('warp');
    this.nRidge = N('ridge');
    this.nHill = N('hill');
    this.nDetail = N('detail');
    this.nClimate = N('climate');
    this.nCanyon = N('canyon');
    this.nRiver = N('river');
    this.nDune = N('dune');
    this.nCave = N('cave');
    this.nCave2 = N('cave2');
    this.nCavern = N('cavern');
    this.nOver = N('over');
    this.nArch = N('arch');
    this.nIsland = N('island');
    this.nUw = N('uw');
    this.nOre = N('ore');
    this.nMisc = N('misc');
    this.present = this.profile.biomes.filter((b) => b && b.weight > 0 && b.id !== Biome.Ocean);
    this.tmpParams = { ...BIOMES[Biome.Grassland].terrain };
    this.sites = new SiteMap(this.profile, {
      baseHeight: (x, z) => this.column(x, z, this.tmpCol, false, false).natural,
      biomeAt: (x, z) => this.column(x, z, this.tmpCol, false, false).biome,
      landness: (x, z) => this.column(x, z, this.tmpCol, false, false).land,
    });
  }

  // ------------------------------------------------------------------ climate & biomes

  /** Climate in [-1,1] (temp, humid) and [0,1] weird. */
  private climate(x: number, z: number, out: Column) {
    const p = this.profile;
    const cs = p.climateScale;
    const n = this.nClimate;
    // Large-scale "latitude" banding so long journeys cross climate zones.
    const lat = Math.sin(z / (cs * 5.3) + 1.3) * 0.35;
    out.temp = clamp(n.fbm2(x / cs, z / cs, 3) * 0.85 + lat + p.tempOffset, -1.2, 1.2);
    out.humid = clamp(n.fbm2(x / cs + 71.3, z / cs - 13.1, 3) * 0.9 + p.humidOffset, -1.2, 1.2);
    const w = 0.5 + 0.5 * n.fbm2(x / (cs * 0.8) - 41.7, z / (cs * 0.8) + 93.1, 2) * 1.4;
    out.weird = clamp(w * 0.85 + (p.weirdness - 0.5) * 0.5, 0, 1);
  }

  private selectBiomes(out: Column) {
    let b1: BiomeInstance | null = null, b2: BiomeInstance | null = null;
    let s1 = -1, s2 = -1;
    const T = out.temp, H = out.humid, W = out.weird;
    for (let i = 0; i < this.present.length; i++) {
      const b = this.present[i];
      const dt = T - b.temp, dh = H - b.humid, dw = W - b.weird;
      const d2 = dt * dt + dh * dh + dw * dw * 1.3;
      const s = b.weight * Math.exp(-d2 / 0.09);
      if (s > s1) {
        s2 = s1; b2 = b1;
        s1 = s; b1 = b;
      } else if (s > s2) {
        s2 = s; b2 = b;
      }
    }
    if (!b1) {
      out.biome = out.biome2 = Biome.Grassland;
      out.blend = 0;
      return;
    }
    out.biome = b1.id;
    out.biome2 = b2 ? b2.id : b1.id;
    // Sharpen transitions: ~100-300 m blend zones.
    const a = s1 * s1 * s1, c = Math.max(0, s2) * Math.max(0, s2) * Math.max(0, s2);
    out.blend = c / (a + c + 1e-9);
  }

  // ------------------------------------------------------------------ column

  /**
   * Compute all 2D data of a column. `withSites=false` skips settlement/road
   * shaping (used by the site placer itself to avoid recursion).
   */
  column(x: number, z: number, out: Column = new Column(), withSites = true, withFeatures = true): Column {
    const p = this.profile;
    out.x = x;
    out.z = z;
    this.climate(x, z, out);
    this.selectBiomes(out);

    // Blend terrain params of the two dominant biomes.
    const P = this.tmpParams;
    const ta = p.biomes[out.biome].terrain, tb = p.biomes[out.biome2].terrain;
    for (let i = 0; i < TERRAIN_KEYS.length; i++) {
      const k = TERRAIN_KEYS[i];
      P[k] = ta[k] + (tb[k] - ta[k]) * out.blend;
    }

    // Domain warp for organic, eroded-looking shapes.
    const ew = p.erosionWarp;
    const wx = x + this.nWarp.fbm2(x / 520, z / 520, 3) * ew;
    const wz = z + this.nWarp.fbm2(x / 520 + 37.1, z / 520 - 11.9, 3) * ew;

    // Continents.
    const cs = p.continentScale;
    let c = this.nCont.fbm2(wx / cs, wz / cs, 5, 2.1, 0.48) + p.landBias;
    c += this.nCont.n2(wx / 260, wz / 260) * 0.05 * p.coastRoughness;
    out.continental = c;
    const land = smoothstep(-0.06, 0.08, c);
    out.land = land;
    let h: number;
    if (c < -0.28) h = -75 + (c + 0.28) * 120;
    else if (c < -0.02) h = lerp(-75, -3, (c + 0.28) / 0.26);
    else if (c < 0.07) h = lerp(-3, 4, (c + 0.02) / 0.09);
    else h = 4 + (c - 0.07) * 90;
    h = Math.max(h, -160);

    // Mountain ranges (ridged, warped), masked to inland zones.
    const rs = p.ridgeScale;
    const ridge = this.nRidge.ridged2(wx / rs, wz / rs, 5, 2.05, 0.5, p.ridgeSharpness);
    const rangeMask = smoothstep(-0.25, 0.45, this.nRidge.n2(x / (rs * 2.7) + 5.5, z / (rs * 2.7) - 3.3)) * smoothstep(0.02, 0.3, c);
    const mtn = Math.pow(ridge, 1.6) * rangeMask * P.mountain;
    out.rock = saturate(mtn * 1.6);
    h += mtn * p.mountainHeight;

    // Hills.
    h += this.nHill.fbm2(wx / P.hillScale, wz / P.hillScale, 4) * P.hillAmp * (0.3 + 0.7 * land);

    // Dunes: asymmetric ridges with a dominant wind direction.
    if (P.dune > 0.02) {
      const dx = x + this.nDune.n2(x / 700, z / 700) * 180;
      const ridgeD = 1 - Math.abs(this.nDune.n2(dx / 110, z / 46));
      const dune2 = this.nDune.billow2(x / 260, z / 260, 2);
      h += (Math.pow(ridgeD, 2.2) * 13 + dune2 * 9) * P.dune * land;
    }

    // Canyons with steep walls.
    if (P.canyon > 0.02) {
      const cn = Math.abs(this.nCanyon.fbm2(wx / 900, wz / 900, 2));
      const width = 0.05 + 0.02 * this.nCanyon.n2(x / 300, z / 300);
      const k = 1 - smoothstep(width * 0.55, width, cn);
      h -= k * 55 * P.canyon * p.canyonMul * land;
    }

    // Terraces (mesas).
    if (P.terrace > 0.02) {
      const step = P.terraceStep;
      const t = h / step;
      const f = t - Math.floor(t);
      const terr = (Math.floor(t) + smoothstep(0.3, 0.7, f)) * step;
      h = lerp(h, terr, clamp(P.terrace, 0, 1));
    }

    // Craters.
    if (P.crater > 0.05) {
      const cr = cellular2(this.seed ^ 0x51, x / 380, z / 380, 0.9, this.cell);
      if (hashToFloat(cr.id) < 0.35 * P.crater) {
        const R = 0.18 + hashToFloat(cr.id * 7 + 1) * 0.22;
        const q = cr.f1 / R;
        if (q < 1.4) {
          const bowl = q < 1 ? (1 - q * q) * -1 : 0;
          const rim = Math.exp(-((q - 1) * (q - 1)) / 0.02) * 0.25;
          h += (bowl + rim) * R * 380 * 0.22;
        }
      }
    }

    // Flatten (swamps, salt flats).
    if (P.flatten > 0.02) {
      const level = 0.4 + this.nDetail.n2(x / 90, z / 90) * 1.1;
      h = lerp(h, Math.max(level, h * 0.15), P.flatten * land);
    }

    // Fine detail.
    h += this.nDetail.fbm2(x / 28, z / 28, 3) * P.rough;

    // Rivers carve valleys down to slightly below sea level.
    const rv = Math.abs(this.nRiver.fbm2(wx / 1500, wz / 1500, 3) + this.nRiver.n2(x / 240, z / 240) * 0.03);
    const rw = 0.012 * p.riverDensity;
    const bed = 1 - smoothstep(rw * 0.5, rw, rv);
    const valley = 1 - smoothstep(rw, rw * 6, rv);
    out.river = bed * land;
    if (land > 0 && h > -2) {
      const target = -2.6;
      const vh = lerp(h, Math.min(h, target + (h - target) * 0.35), valley);
      h = lerp(vh, Math.min(h, target), bed);
    }

    // Ocean biome blending.
    if (land < 1) {
      if (land < 0.5) {
        out.biome2 = out.biome;
        out.biome = Biome.Ocean;
        out.blend = land;
      }
    }

    out.natural = h;
    out.height = h;
    out.site = 0;
    out.siteId = null;
    out.road = 0;
    if (withSites) this.applySites(out);

    // 3D feature parameters. Settlements and roads are built on the 2D height (streets,
    // foundations, fences and props all sample it), so 3D surface features must be fully
    // off wherever anything is built, not merely faded with the town's soft outer weight:
    // otherwise the real ground sinks or bulges by metres under streets and houses.
    const built = Math.max(smoothstep(0, 0.1, out.site), out.road);
    const keep = 1 - built;
    out.overhang = P.overhang * p.overhangMul * (0.3 + 0.7 * out.rock + 0.4 * P.overhang) * land * keep;
    out.arches = P.arches * p.archMul * land * keep;
    out.islands = P.islands * p.islandMul;
    out.pillars = P.pillars * p.pillarMul * land * keep;
    out.spikes = P.spikes * land * keep;
    out.caveEntrance = smoothstep(0.55, 0.75, this.nCave.n2(x / 310, z / 310)) * p.caveDensity * keep;
    out.snowLine = p.snowLine + this.nMisc.n2(x / 400, z / 400) * 40 - out.temp * 160;

    if (withFeatures) this.features(out);
    return out;
  }

  private applySites(out: Column) {
    const x = out.x, z = out.z;
    let h = out.height;
    const sites = this.sites.sitesNear(x, z, 0);
    for (const s of sites) {
      const d = Math.hypot(x - s.x, z - s.z);
      const outer = s.radius * 1.9;
      if (d > outer) continue;
      const w = 1 - smoothstep(s.radius * 0.85, outer, d);
      // Gentle undulation inside towns so they don't look like a billiard table.
      const local = s.plateau + this.nDetail.n2(x / 60, z / 60) * 1.2;
      h = lerp(h, local, w);
      if (w > out.site) {
        out.site = w;
        out.siteId = s.id;
      }
    }
    // Roads: meandering path between linked settlements.
    const roads = this.sites.roadsNear(x, z, 8);
    if (roads.length) {
      const mx = x + this.nMisc.n2(x / 140, z / 140) * 9;
      const mz = z + this.nMisc.n2(x / 140 + 9.1, z / 140 - 3.7) * 9;
      for (const r of roads) {
        const [d, t] = segDist(mx, mz, r);
        if (d < r.width * 2.5) {
          const roadY = lerp(r.ay, r.by, t);
          const k = 1 - smoothstep(r.width * 0.6, r.width * 2.5, d);
          // Roads follow terrain but are smoothed and cut slightly in.
          const smoothed = lerp(h, Math.max(Math.min(h, roadY + 25), roadY - 25), 0.15) - 0.25;
          if (h > 0.5) h = lerp(h, smoothed, k);
          out.road = Math.max(out.road, 1 - smoothstep(r.width * 0.5, r.width, d));
        }
      }
    }
    out.height = h;
  }

  private archCache = new Map<number, ArchInfo | null>();

  /** Sparse natural arches: half tori standing on the ground. */
  private archAt(cx: number, cz: number): ArchInfo | null {
    const key = (cx * 73856093) ^ (cz * 83492791);
    const c = this.archCache.get(key);
    if (c !== undefined) return c;
    let res: ArchInfo | null = null;
    const h = hash2i(this.seed ^ 0xa2c4, cx, cz);
    const x = (cx + 0.15 + hashToFloat(h) * 0.7) * ARCH_CELL;
    const z = (cz + 0.15 + hashToFloat(Math.imul(h, 31) + 7) * 0.7) * ARCH_CELL;
    const col = this.column(x, z, new Column(), false, false);
    // col.arches already includes the world's arch multiplier and land/site masks.
    const strength = clamp(col.arches, 0, 1.5);
    if (col.land > 0.8 && col.height > 2 && hashToFloat(Math.imul(h, 131) + 3) < 0.55 * strength) {
      const R = 9 + hashToFloat(Math.imul(h, 17) + 5) * 24;
      res = { x, z, y: col.height - 2, R, t: 1.8 + R * (0.1 + hashToFloat(Math.imul(h, 5) + 1) * 0.08), yaw: hashToFloat(Math.imul(h, 9) + 2) * Math.PI };
    }
    this.archCache.set(key, res);
    if (this.archCache.size > 4096) this.archCache.clear();
    return res;
  }

  private islandAt(cx: number, cz: number): IslandInfo | null {
    const key = (cx * 73856093) ^ (cz * 19349663);
    const c = this.islandCache.get(key);
    if (c !== undefined) return c;
    let res: IslandInfo | null = null;
    const h = hash2i(this.seed ^ 0x1517, cx, cz);
    const x = (cx + 0.2 + hashToFloat(h) * 0.6) * ISLAND_CELL;
    const z = (cz + 0.2 + hashToFloat(Math.imul(h, 31) + 7) * 0.6) * ISLAND_CELL;
    const col = this.column(x, z, new Column(), false, false);
    const prob = clamp(col.islands, 0, 1.2) * 0.75;
    if (hashToFloat(Math.imul(h, 131) + 3) < prob) {
      const R = 28 + hashToFloat(Math.imul(h, 17) + 5) * 75;
      const A = Math.max(col.height, SEA_LEVEL) + 60 + hashToFloat(Math.imul(h, 7) + 9) * 210;
      res = { x, z, R, A: Math.min(A, WORLD_MAX_Y - 80), seed: h };
    }
    this.islandCache.set(key, res);
    if (this.islandCache.size > 4096) this.islandCache.clear();
    return res;
  }

  private features(out: Column) {
    const x = out.x, z = out.z, h = out.height;
    // Karst pillars.
    out.pDist = 1e9;
    out.pTop = -1e9;
    if (out.pillars > 0.03) {
      const c = cellular2(this.seed ^ 0x7a11, x / PILLAR_CELL, z / PILLAR_CELL, 0.8, this.cell);
      const hp = hashToFloat(c.id);
      if (hp < 0.5 * Math.min(1, out.pillars)) {
        out.pDist = c.f1 * PILLAR_CELL;
        out.pR = 4 + hashToFloat(Math.imul(c.id, 13) + 1) * 9;
        out.pBase = h;
        out.pTop = h + (22 + hashToFloat(Math.imul(c.id, 29) + 2) * 75) * Math.min(1.3, out.pillars);
      }
    }
    // Crystal spikes.
    out.sR = 0;
    if (out.spikes > 0.03) {
      const c = cellular2(this.seed ^ 0x5b1e, x / SPIKE_CELL, z / SPIKE_CELL, 0.9, this.cell);
      if (hashToFloat(c.id) < 0.45 * Math.min(1, out.spikes)) {
        out.sPx = c.px * SPIKE_CELL;
        out.sPz = c.py * SPIKE_CELL;
        out.sH0 = h - 3;
        out.sR = 1.8 + hashToFloat(Math.imul(c.id, 3) + 1) * 5;
        out.sH = 10 + hashToFloat(Math.imul(c.id, 5) + 2) * 38;
        out.sTx = (hashToFloat(Math.imul(c.id, 7) + 3) - 0.5) * 0.7;
        out.sTz = (hashToFloat(Math.imul(c.id, 11) + 4) - 0.5) * 0.7;
      }
    }
    // Floating islands.
    out.aY = -1e9;
    if (out.arches > 0.05) {
      const acx = Math.floor(x / ARCH_CELL), acz = Math.floor(z / ARCH_CELL);
      for (let dz = -1; dz <= 1 && out.aY < -1e8; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const a = this.archAt(acx + dx, acz + dz);
          if (!a) continue;
          if (Math.hypot(x - a.x, z - a.z) > a.R + a.t + 4) continue;
          out.aX = a.x; out.aZ = a.z; out.aY = a.y; out.aR = a.R; out.aT = a.t;
          out.aCos = Math.cos(a.yaw); out.aSin = Math.sin(a.yaw);
          break;
        }
    }
    out.iTop = -1e9;
    out.iBot = 1e9;
    if (out.islands > 0.05) {
      const icx = Math.floor(x / ISLAND_CELL), icz = Math.floor(z / ISLAND_CELL);
      let best = -1e9;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const isl = this.islandAt(icx + dx, icz + dz);
          if (!isl) continue;
          const ang = Math.atan2(z - isl.z, x - isl.x);
          const wob = 1 + this.nIsland.n2(Math.cos(ang) * 1.3 + isl.seed % 97, Math.sin(ang) * 1.3) * 0.28;
          const q = Math.hypot(x - isl.x, z - isl.z) / (isl.R * wob);
          if (q >= 1) continue;
          const top = isl.A + (1 - q * q) * isl.R * 0.1 + this.nIsland.n2(x / 30, z / 30) * 2.5;
          const bot = isl.A - Math.pow(1 - q, 0.65) * isl.R * 0.95 - Math.abs(this.nIsland.n2(x / 14, z / 14)) * isl.R * 0.25 * (1 - q);
          const thick = top - bot;
          if (thick > best) {
            best = thick;
            out.iTop = top;
            out.iBot = bot;
          }
        }
    }
    // Underworld.
    const uw = this.nUw;
    const open = smoothstep(-0.2, 0.25, uw.fbm2(x / 1300, z / 1300, 2) * 0.8 + uw.n2(x / 330, z / 330) * 0.25 + (this.profile.underworldOpenness - 0.5));
    let ceil = UNDERWORLD_CEIL - 8 + uw.fbm2(x / 260, z / 260, 2) * 22 + uw.n2(x / 55, z / 55) * 4;
    let floor = UNDERWORLD_FLOOR + 32 + uw.fbm2(x / 340 + 9, z / 340 - 4, 3) * 30;
    // Stalactites & stalagmites.
    const st = cellular2(this.seed ^ 0x57a1, x / 11, z / 11, 0.9, this.cell);
    const sh = hashToFloat(st.id);
    if (sh < 0.45) {
      const k = Math.max(0, 1 - st.f1 / 0.5);
      ceil -= k * k * (5 + sh * 40);
    } else if (sh > 0.8) {
      const k = Math.max(0, 1 - st.f1 / 0.45);
      floor += k * k * (3 + (sh - 0.8) * 60);
    }
    // Underworld biome via large Voronoi regions.
    const ub = cellular2(this.seed ^ 0x4e7, x / 900, z / 900, 0.85, this.cell);
    const uws = this.profile.underworld;
    let tot = 0;
    for (const b of uws) tot += b.weight;
    let r = hashToFloat(ub.id) * tot;
    let uwBiome = uws[0].id;
    for (const b of uws) {
      r -= b.weight;
      if (r <= 0) {
        uwBiome = b.id;
        break;
      }
    }
    out.uwBiome = uwBiome;
    if (uwBiome === Biome.UnderSea) floor = Math.min(floor, UNDERWORLD_SEA_LEVEL - 6 - Math.abs(uw.n2(x / 120, z / 120)) * 30);
    if (uwBiome === Biome.RootCathedral) ceil += 18;
    if (uwBiome === Biome.MagmaDepths) floor -= 8;
    ceil = lerp(floor - 1, ceil, open);
    out.uwFloor = floor;
    out.uwCeil = ceil;
    const up = cellular2(this.seed ^ 0x9f1, x / UW_PILLAR_CELL, z / UW_PILLAR_CELL, 0.8, this.cell);
    if (hashToFloat(up.id) < 0.4) {
      out.uwPDist = up.f1 * UW_PILLAR_CELL;
      out.uwPR = 5 + hashToFloat(Math.imul(up.id, 5) + 1) * 14;
    } else {
      out.uwPDist = 1e9;
      out.uwPR = 0;
    }
    // Shafts linking surface and underworld.
    out.shR = 0;
    const sc = cellular2(this.seed ^ 0x5af7, x / SHAFT_CELL, z / SHAFT_CELL, 0.7, this.cell);
    if (hashToFloat(sc.id) < 0.22 * this.profile.shaftFrequency && out.site < 0.01) {
      const R = 9 + hashToFloat(Math.imul(sc.id, 3) + 1) * 18;
      if (sc.f1 * SHAFT_CELL < R * 2.2) {
        out.shX = sc.px * SHAFT_CELL;
        out.shZ = sc.py * SHAFT_CELL;
        out.shR = R;
        out.shBottom = floor + 4;
      }
    }
  }

  // ------------------------------------------------------------------ public 2D queries

  /** Surface height without 3D features (fast). */
  heightAt(x: number, z: number): number {
    return this.cachedColumn(x, z).height;
  }

  biomeAt(x: number, z: number): Biome {
    return this.cachedColumn(x, z).biome;
  }

  /** Column cached on a 1 m grid (for gameplay queries; not for meshing). */
  cachedColumn(x: number, z: number): Column {
    const ix = Math.round(x), iz = Math.round(z);
    const key = ix * 1000003 + iz;
    let c = this.colCache.get(key);
    if (c) return c;
    c = this.column(ix, iz, new Column());
    this.colCache.set(key, c);
    this.colCacheOrder.push(key);
    if (this.colCacheOrder.length > 20000) {
      for (const k of this.colCacheOrder.splice(0, 5000)) this.colCache.delete(k);
    }
    return c;
  }

  // ------------------------------------------------------------------ 3D density

  /** Raw lattice noise channels at a point (cave A/B, cave2 A/B, cavern, overhang, arch A/B). */
  private channels(x: number, y: number, z: number, out: Float32Array, o: number, caves: boolean) {
    const p = this.profile;
    if (caves) {
      const s = 1 / (62 * p.caveWidth);
      // Mild vertical compression keeps tunnels mostly walkable (not shafts) without
      // squashing them into crawl spaces.
      out[o] = this.nCave.n3(x * s, y * s * 1.25, z * s);
      out[o + 1] = this.nCave.n3(x * s + 31.4, y * s * 1.25 - 17.7, z * s + 9.1);
      const s2 = 1 / 150;
      out[o + 2] = this.nCave2.n3(x * s2, y * s2 * 1.2, z * s2);
      out[o + 3] = this.nCave2.n3(x * s2 - 51.2, y * s2 * 1.2 + 3.3, z * s2 + 22.8);
      out[o + 4] = this.nCavern.fbm3(x / 130, y / 75, z / 130, 2);
    } else {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 1;
      out[o + 4] = -1;
    }
    out[o + 5] = this.nOver.fbm3(x / 46, y / 30, z / 46, 2);
    out[o + 6] = this.nArch.n3(x / 85, y / 48, z / 85);
    out[o + 7] = this.nArch.n3(x / 85 + 13.7, y / 48 - 7.3, z / 85 + 41.1);
  }

  /**
   * Combine 2D column data and interpolated 3D channels into the final density.
   * `ch` holds NCH channel values for this point.
   */
  private combine(col: Column, x: number, y: number, z: number, ch: Float32Array, o: number, caves: boolean): number {
    const p = this.profile;
    const h = col.height;
    let d = h - y;

    // Overhangs & cliffs.
    if (col.overhang > 0.01) {
      const band = 1 - smoothstep(16, 42, Math.abs(d));
      if (band > 0) d += ch[o + 5] * 24 * col.overhang * band;
    }
    // Natural arches: a weathered half torus standing in a vertical plane.
    if (col.aY > -1e8 && y > col.aY - 4 && y < col.aY + col.aR + col.aT + 2) {
      const lx = x - col.aX, lz = z - col.aZ;
      const u = lx * col.aCos + lz * col.aSin; // along the arch span
      const w = -lx * col.aSin + lz * col.aCos; // across (thickness direction)
      const v = y - col.aY;
      const ring = Math.hypot(u, v) - col.aR;
      const tube = Math.hypot(ring, w * 0.8) - col.aT * (1 + ch[o + 5] * 0.35);
      d = Math.max(d, -tube);
    }
    // Karst pillars.
    if (col.pTop > -1e8 && y < col.pTop + 4) {
      const hh = (y - col.pBase) / Math.max(1, col.pTop - col.pBase);
      const rr = col.pR * (1 - 0.3 * clamp(hh, 0, 1)) * (1 + ch[o + 5] * 0.35);
      const dp = Math.min(rr - col.pDist, col.pTop - y);
      d = Math.max(d, dp);
    }
    // Crystal spikes (tilted cones).
    if (col.sR > 0 && y > col.sH0 - 4 && y < col.sH0 + col.sH) {
      const t = y - col.sH0;
      const dx = x - (col.sPx + col.sTx * t), dz = z - (col.sPz + col.sTz * t);
      const r = col.sR * (1 - t / col.sH);
      d = Math.max(d, r - Math.sqrt(dx * dx + dz * dz));
    }
    // Floating islands.
    if (col.iTop > -1e8 && y > col.iBot - 6 && y < col.iTop + 6) {
      const di = Math.min(col.iTop - y, y - col.iBot) + ch[o + 5] * 3;
      d = Math.max(d, di);
    }

    if (caves && y < h + 3) {
      const depth = h - y;
      // Caves are meant to be explored, so tunnels are never narrowed to fit: they keep their
      // full width and are capped instead. Away from entrances a tunnel ends under a flat rock
      // ceiling `cover` metres below the surface; at entrances the cover is zero and the
      // tunnel opens to the sky at full width. (Offsetting the field instead pinched tunnels
      // into crawl spaces and slits near the surface.)
      const entrance = smoothstep(0.35, 0.55, col.caveEntrance);
      const cover = (1 - entrance) * 7;
      const a = ch[o], b = ch[o + 1];
      // Width has a solid floor; the world's cave density mostly shapes how often caves open up.
      const r1 = 0.13 * (0.85 + 0.15 * p.caveDensity);
      let cave = Math.min((r1 - Math.sqrt(a * a + b * b)) * 85, (depth - cover) * 3);
      // Deep tunnel network, below 20 m under sea level (capped the same way, never tapered).
      const a2 = ch[o + 2], b2 = ch[o + 3];
      if (y < -20) cave = Math.max(cave, Math.min((0.1 - Math.sqrt(a2 * a2 + b2 * b2)) * 160, (-20 - y) * 3, (depth - cover) * 3));
      // Big caverns between surface and underworld.
      const cavernMask = smoothstep(h - 30, h - 60, y) * smoothstep(UNDERWORLD_CEIL - 10, UNDERWORLD_CEIL + 30, y);
      if (cavernMask > 0) cave = Math.max(cave, (ch[o + 4] - (0.58 - 0.1 * p.cavernFrequency)) * 140 - (1 - cavernMask) * 60);
      if (cave > -6) d = Math.min(d, -cave);
    }

    // Underworld cavern layer.
    if (y < UNDERWORLD_CEIL + 60 && y > UNDERWORLD_FLOOR - 40) {
      let cav = Math.min(y - col.uwFloor, col.uwCeil - y);
      if (col.uwPR > 0) {
        const flare = 1 + 1.4 * Math.pow(1 - saturate(Math.min(y - col.uwFloor, col.uwCeil - y) / 30), 2);
        cav = Math.min(cav, col.uwPDist - col.uwPR * flare);
      }
      cav += ch[o + 5] * 6;
      if (cav > -8) d = Math.min(d, -cav);
    }

    // Shafts.
    if (col.shR > 0 && y > col.shBottom - 4 && y < h + 12) {
      const wob = col.shR * 0.55;
      const sx = col.shX + this.nMisc.n2(y / 70, col.shR) * wob;
      const sz = col.shZ + this.nMisc.n2(col.shR + 17.3, y / 70) * wob;
      const flare = 1 + smoothstep(h - 25, h + 6, y) * 0.8;
      const ds = col.shR * flare - Math.hypot(x - sx, z - sz);
      if (ds > -8) d = Math.min(d, -ds);
    }

    // Bedrock and world ceiling.
    if (y < BEDROCK_Y + 8) d = Math.max(d, BEDROCK_Y + 8 - y);
    if (y > WORLD_MAX_Y - 8) d = Math.min(d, WORLD_MAX_Y - 8 - y);
    return d;
  }

  private chScratch = new Float32Array(NCH * 8);
  private chOne = new Float32Array(NCH);

  /** Analytic density at a point (matches chunk grids up to interpolation error). */
  density(x: number, y: number, z: number, col?: Column): number {
    const c = col ?? this.cachedColumnExact(x, z);
    const caves = true;
    // Interpolate lattice channels exactly like fillChunk does for LOD 0/1.
    const lx = x / LATTICE, ly = y / LATTICE, lz = z / LATTICE;
    const ix = Math.floor(lx), iy = Math.floor(ly), iz = Math.floor(lz);
    const fx = lx - ix, fy = ly - iy, fz = lz - iz;
    const s = this.chScratch;
    for (let k = 0; k < 8; k++) {
      this.channels((ix + (k & 1)) * LATTICE, (iy + ((k >> 1) & 1)) * LATTICE, (iz + ((k >> 2) & 1)) * LATTICE, s, k * NCH, caves);
    }
    const o = this.chOne;
    for (let ch = 0; ch < NCH; ch++) {
      const c00 = lerp(s[ch], s[NCH + ch], fx);
      const c10 = lerp(s[2 * NCH + ch], s[3 * NCH + ch], fx);
      const c01 = lerp(s[4 * NCH + ch], s[5 * NCH + ch], fx);
      const c11 = lerp(s[6 * NCH + ch], s[7 * NCH + ch], fx);
      o[ch] = lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
    }
    return this.combine(c, x, y, z, o, 0, caves);
  }

  private exactKeyX = NaN;
  private exactKeyZ = NaN;
  private exactCol = new Column();
  private cachedColumnExact(x: number, z: number): Column {
    if (x !== this.exactKeyX || z !== this.exactKeyZ) {
      this.column(x, z, this.exactCol);
      this.exactKeyX = x;
      this.exactKeyZ = z;
    }
    return this.exactCol;
  }

  // ------------------------------------------------------------------ chunk filling

  /**
   * Fill a chunk grid. Origin must be aligned to CHUNK_SIZE * step.
   * Samples span origin + (i - CHUNK_PAD) * step, i ∈ [0, GRID_N).
   */
  fillChunk(ox: number, oy: number, oz: number, lod: number): ChunkData {
    const step = 1 << lod;
    const N = GRID_N;
    const density = new Float32Array(N * N * N);
    const mats = new Uint8Array(N * N * N);
    const res: ChunkData = { ox, oy, oz, lod, step, density, mats, uniform: null };
    const caves = lod < CAVE_LOD_LIMIT;

    // ---- columns
    const cols: Column[] = new Array(N * N);
    let minH = Infinity, maxTop = -Infinity, minBottomFeature = Infinity;
    let anyUnderworldOpen = false, anyShaft = false;
    for (let k = 0; k < N; k++)
      for (let i = 0; i < N; i++) {
        const x = ox + (i - CHUNK_PAD) * step, z = oz + (k - CHUNK_PAD) * step;
        const c = this.column(x, z, new Column());
        cols[i + k * N] = c;
        const h = c.height;
        minH = Math.min(minH, h);
        let top = h + 45 * c.overhang + 6;
        if (c.aY > -1e8) top = Math.max(top, c.aY + c.aR + c.aT + 4);
        if (c.pTop > -1e8) top = Math.max(top, c.pTop + 4);
        if (c.sR > 0) top = Math.max(top, c.sH0 + c.sH + 2);
        if (c.iTop > -1e8) {
          top = Math.max(top, c.iTop + 8);
          minBottomFeature = Math.min(minBottomFeature, c.iBot - 8);
        }
        maxTop = Math.max(maxTop, top);
        if (c.uwCeil - c.uwFloor > 1) anyUnderworldOpen = true;
        if (c.shR > 0) anyShaft = true;
      }

    const yMin = oy - CHUNK_PAD * step, yMax = oy + (N - 1 - CHUNK_PAD) * step;
    // ---- uniform chunk early-outs
    if (yMin > maxTop) {
      res.uniform = 'air';
      return res;
    }
    const intersectsUw = yMax > UNDERWORLD_FLOOR - 50 && yMin < UNDERWORLD_CEIL + 70 && anyUnderworldOpen;
    const belowSurface = yMax < minH - 50 * (1 + 0) - 6;
    if (belowSurface && !caves && !intersectsUw && !anyShaft && yMin > BEDROCK_Y + 10) {
      res.uniform = 'solid';
      return res;
    }

    // ---- lattice channels
    let latStep: number;
    let lx0: number, ly0: number, lz0: number, ln: number;
    let lat: Float32Array;
    if (step < LATTICE) {
      latStep = LATTICE;
      lx0 = Math.floor((ox - CHUNK_PAD * step) / LATTICE);
      ly0 = Math.floor(yMin / LATTICE);
      lz0 = Math.floor((oz - CHUNK_PAD * step) / LATTICE);
      ln = Math.ceil(((N - 1) * step) / LATTICE) + 2;
      lat = new Float32Array(ln * ln * ln * NCH);
      for (let k = 0; k < ln; k++)
        for (let j = 0; j < ln; j++)
          for (let i = 0; i < ln; i++) {
            this.channels((lx0 + i) * LATTICE, (ly0 + j) * LATTICE, (lz0 + k) * LATTICE, lat, (i + j * ln + k * ln * ln) * NCH, caves);
          }
    } else {
      latStep = step;
      lx0 = ly0 = lz0 = 0;
      ln = 0;
      lat = new Float32Array(0);
    }

    const ch = new Float32Array(NCH);
    let nSolid = 0;
    const total = N * N * N;
    for (let k = 0; k < N; k++) {
      const z = oz + (k - CHUNK_PAD) * step;
      for (let j = 0; j < N; j++) {
        const y = yMin + j * step;
        for (let i = 0; i < N; i++) {
          const x = ox + (i - CHUNK_PAD) * step;
          const col = cols[i + k * N];
          if (ln > 0) {
            const fxl = x / latStep - lx0, fyl = y / latStep - ly0, fzl = z / latStep - lz0;
            const ix = Math.floor(fxl), iy = Math.floor(fyl), iz = Math.floor(fzl);
            const fx = fxl - ix, fy = fyl - iy, fz = fzl - iz;
            const b = (ix + iy * ln + iz * ln * ln) * NCH;
            const sx = NCH, sy = ln * NCH, sz = ln * ln * NCH;
            for (let c = 0; c < NCH; c++) {
              const p = b + c;
              const c00 = lat[p] + (lat[p + sx] - lat[p]) * fx;
              const c10 = lat[p + sy] + (lat[p + sy + sx] - lat[p + sy]) * fx;
              const c01 = lat[p + sz] + (lat[p + sz + sx] - lat[p + sz]) * fx;
              const c11 = lat[p + sz + sy] + (lat[p + sz + sy + sx] - lat[p + sz + sy]) * fx;
              const c0 = c00 + (c10 - c00) * fy;
              const c1 = c01 + (c11 - c01) * fy;
              ch[c] = c0 + (c1 - c0) * fz;
            }
          } else {
            // Coarse LOD: evaluate channels directly, only where they can matter.
            const h = col.height;
            const near = Math.abs(h - y) < 50 + step * 2 || (col.iTop > -1e8 && y > col.iBot - 10 && y < col.iTop + 10) ||
              (y < UNDERWORLD_CEIL + 60 && y > UNDERWORLD_FLOOR - 40);
            if (near) this.channels(x, y, z, ch, 0, false);
            else {
              ch[0] = ch[1] = ch[2] = ch[3] = 1;
              ch[4] = -1;
              ch[5] = 0;
              ch[6] = ch[7] = 1;
            }
          }
          const d = this.combine(col, x, y, z, ch, 0, caves);
          const idx = i + j * N + k * N * N;
          density[idx] = d;
          if (d > 0) nSolid++;
        }
      }
    }
    if (nSolid === 0) {
      res.uniform = 'air';
      return res;
    }
    if (nSolid === total) {
      res.uniform = 'solid';
      return res;
    }
    this.fillMaterials(res, cols);
    const heights = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) heights[i] = cols[i].height;
    res.heights = heights;
    return res;
  }

  /** Assign materials to solid samples adjacent to air (+ a margin). */
  private fillMaterials(res: ChunkData, cols: Column[]) {
    const N = GRID_N;
    const { density, mats, step, ox, oz } = res;
    const yMin = res.oy - CHUNK_PAD * step;
    const NN = N * N;
    for (let k = 1; k < N - 1; k++)
      for (let j = 1; j < N - 1; j++)
        for (let i = 1; i < N - 1; i++) {
          const idx = i + j * N + k * NN;
          const d = density[idx];
          if (d <= 0) continue;
          if (d > 4 * step) {
            mats[idx] = Mat.Stone;
            continue;
          }
          // Gradient → surface normal (points from solid to air).
          const gx = density[idx - 1] - density[idx + 1];
          const gy = density[idx - N] - density[idx + N];
          const gz = density[idx - NN] - density[idx + NN];
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
          const ny = gy / gl;
          const x = ox + (i - CHUNK_PAD) * step, y = yMin + j * step, z = oz + (k - CHUNK_PAD) * step;
          mats[idx] = this.materialFor(cols[i + k * N], x, y, z, d, ny);
        }
    // Edge samples: copy nearest interior.
    for (let k = 0; k < N; k++)
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          if (i > 0 && j > 0 && k > 0 && i < N - 1 && j < N - 1 && k < N - 1) continue;
          const idx = i + j * N + k * NN;
          if (density[idx] <= 0) continue;
          const ci = Math.min(N - 2, Math.max(1, i)), cj = Math.min(N - 2, Math.max(1, j)), ck = Math.min(N - 2, Math.max(1, k));
          mats[idx] = mats[ci + cj * N + ck * NN] || Mat.Stone;
        }
  }

  /**
   * Material for a solid point at depth d (≈ meters below the nearest surface)
   * whose surface normal has vertical component ny.
   */
  materialFor(col: Column, x: number, y: number, z: number, d: number, ny: number): Mat {
    const p = this.profile;
    // Underworld?
    const inUw = y < UNDERWORLD_CEIL + 25 && y > col.uwFloor - 25 && col.uwCeil - col.uwFloor > 1 && y < col.height - 30;
    // Organic dithering: low-frequency noise with a little per-voxel jitter, so
    // biome and material transitions form natural patches rather than pixel noise.
    const dither = clamp(
      0.5 + this.nMisc.n2(x / 11 + y * 0.03, z / 11) * 0.42 + this.nMisc.n2(x / 3.1, z / 3.1 + y * 0.2) * 0.12 +
        (hashToFloat(hash3i(this.seed, Math.floor(x), Math.floor(y), Math.floor(z))) - 0.5) * 0.08,
      0, 1,
    );
    let biome = col.blend > dither ? col.biome2 : col.biome;
    if (inUw) biome = col.uwBiome;
    const bd = BIOMES[biome];

    // Deep rock & ores.
    if (d > 2.5) {
      const ore = this.nOre.n3(x / 9, y / 9, z / 9);
      const thr = 0.78 - 0.06 * p.oreRichness;
      if (ore > thr) {
        if (y < UNDERWORLD_CEIL) return ore > thr + 0.08 ? Mat.OreGem : Mat.OreGold;
        if (y < -40 && ore > thr + 0.06) return Mat.OreGold;
        return Mat.OreIron;
      }
      if (biome === Biome.Volcanic || biome === Biome.MagmaDepths) return Mat.Basalt;
      if (biome === Biome.KarstPillars) return Mat.Limestone;
      return d > 6 ? Mat.Stone : bd.sub === Mat.Mud || bd.sub === Mat.Dirt ? Mat.Dirt : bd.sub;
    }

    // Floating island / pillar top surfaces etc. use the regular rules below.
    const underwater = !inUw && y < SEA_LEVEL - 1.2 && col.height < SEA_LEVEL + 1;
    // Cave floors deep under the surface: no grass or sand, but rock, gravel and damp moss.
    const caveDepth = col.height - y;
    if (!inUw && caveDepth > 7 && ny > 0.35 && (col.iTop < -1e8 || y < col.iBot - 2)) {
      if (biome === Biome.Volcanic) return dither < 0.3 ? Mat.Ash : Mat.Basalt;
      if (biome === Biome.FungalGrove) return dither < 0.6 ? Mat.Mycelium : Mat.Stone;
      if (biome === Biome.Glacier || biome === Biome.Tundra) return dither < 0.4 ? Mat.Ice : Mat.Stone;
      return dither < 0.22 ? Mat.Moss : dither < 0.55 ? Mat.Gravel : Mat.Stone;
    }
    if (ny > 0.62) {
      // Upward facing ground.
      if (inUw) {
        if (biome === Biome.MagmaDepths && dither < 0.25 && y < col.uwFloor + 3) return Mat.Magma;
        if (biome === Biome.UnderSea && y < UNDERWORLD_SEA_LEVEL) return Mat.Mud;
        return bd.top;
      }
      if (col.road > 0.5 && Math.abs(y - col.height) < 3) return col.site > 0.5 ? Mat.Cobble : Mat.Path;
      if (underwater) return col.river > 0.3 ? Mat.Gravel : bd.bed;
      if (col.river > 0.4 && y < 1.5) return Mat.Gravel;
      const altitudeCold = y > col.snowLine + (dither - 0.5) * 30;
      if (altitudeCold || (biome === Biome.Tundra || biome === Biome.Glacier)) return d > 1.2 && biome === Biome.Glacier ? Mat.Ice : Mat.Snow;
      if (y < 2.2 + this.nMisc.n2(x / 40, z / 40) * 1.5 && col.height < 6 && bd.top !== Mat.Mud && bd.top !== Mat.Salt) return Mat.Sand;
      if (d > 1.2 * Math.max(1, ny * 2)) return bd.sub;
      // Rocky outcrops on mountains.
      if (col.rock > 0.65 && dither < (col.rock - 0.65) * 2.5) return Mat.Gravel;
      return bd.top;
    }
    if (ny > 0.35) {
      if (inUw) return bd.sub === Mat.Dirt ? Mat.Stone : bd.sub;
      if (underwater) return bd.bed;
      if (y > col.snowLine + 20) return Mat.Snow;
      if (bd.top === Mat.Grass || bd.top === Mat.Moss || bd.top === Mat.ForestFloor) return ny > 0.5 && dither > 0.3 ? bd.top : Mat.Dirt;
      return bd.sub;
    }
    // Cliffs, walls, ceilings.
    if (inUw && biome === Biome.Geodes) return dither < 0.6 ? Mat.Crystal : Mat.Marble;
    if (inUw && biome === Biome.MagmaDepths) return dither < 0.15 ? Mat.Magma : Mat.Basalt;
    const cliff = bd.cliff;
    if (cliff === Mat.Sandstone || cliff === Mat.Limestone) {
      // Sedimentary strata.
      const band = Math.floor(y / 3.2 + this.nMisc.n2(x / 120, z / 120) * 2.5);
      const b3 = ((band % 3) + 3) % 3;
      if (cliff === Mat.Sandstone) return b3 === 0 ? Mat.Clay : Mat.Sandstone;
      return b3 === 0 ? Mat.Stone : Mat.Limestone;
    }
    if (biome === Biome.CrystalWastes && ny < 0.35) return Mat.Crystal;
    if (ny < -0.4 && y < col.height - 4) return biome === Biome.FungalGrove || biome === Biome.GlowCaverns ? Mat.Mycelium : Mat.Stone;
    return cliff;
  }

  /** Material at an arbitrary solid point (for mining yields). */
  materialAt(x: number, y: number, z: number): Mat {
    const d = this.density(x, y, z);
    if (d <= 0) return Mat.Air;
    const e = 0.75;
    const gy = this.density(x, y - e, z) - this.density(x, y + e, z);
    const gx = this.density(x - e, y, z) - this.density(x + e, y, z);
    const gz = this.density(x, y, z - e) - this.density(x, y, z + e);
    const gl = Math.hypot(gx, gy, gz) || 1;
    return this.materialFor(this.cachedColumnExact(x, z), x, y, z, d, gy / gl);
  }

  // ------------------------------------------------------------------ gravity

  /**
   * Local gravity magnitude (m/s², always pointing down). Skyreach regions are
   * light, some anomalies are crushing.
   */
  gravityAt(x: number, y: number, z: number): number {
    const p = this.profile;
    const col = this.cachedColumn(x, z);
    let g = p.baseGravity;
    // Skyreach biomes lighten gravity, more so with altitude.
    const iw = clamp(col.islands, 0, 1);
    if (iw > 0) g *= 1 - p.lowGravityStrength * iw * (0.6 + 0.4 * smoothstep(col.height, col.height + 150, y));
    // Anomaly spheres.
    const c = cellular2(this.seed ^ 0x6a1, x / 520, z / 520, 0.8, this.cell);
    const h = hashToFloat(c.id);
    if (h < 0.18 * p.gravityAnomalyFrequency) {
      const R = 30 + hashToFloat(Math.imul(c.id, 3) + 1) * 70;
      const ax = c.px * 520, az = c.py * 520;
      const ay = this.heightAt(ax, az) + 10;
      const dist = Math.hypot(x - ax, (y - ay) * 0.6, z - az);
      const k = 1 - smoothstep(R * 0.6, R, dist);
      if (k > 0) {
        const heavy = hashToFloat(Math.imul(c.id, 7) + 2) < 0.35;
        g *= heavy ? 1 + 0.9 * k : 1 - 0.85 * k;
      }
    }
    // Underworld is a little heavier.
    if (y < UNDERWORLD_CEIL) g *= 1.06;
    return g;
  }

  /** Describe local gravity for UI. */
  gravityLabel(g: number): string {
    const r = g / 9.81;
    if (r < 0.35) return 'Feather-light';
    if (r < 0.7) return 'Light';
    if (r < 1.15) return 'Normal';
    if (r < 1.5) return 'Heavy';
    return 'Crushing';
  }

  // ------------------------------------------------------------------ helpers

  /** March down to find walkable ground below (x, yStart, z). Returns NaN if none within range. */
  findGround(x: number, yStart: number, z: number, maxDrop = 400): number {
    let y = yStart;
    let prev = this.density(x, y, z);
    if (prev > 0) {
      // Inside rock: march up first.
      for (let i = 0; i < 200 && prev > 0; i++) {
        y += Math.max(0.5, Math.min(prev, 8));
        prev = this.density(x, y, z);
      }
    }
    const end = yStart - maxDrop;
    while (y > end) {
      const stepY = Math.max(0.4, Math.min(-prev * 0.8, 8));
      const ny = y - stepY;
      const d = this.density(x, ny, z);
      if (d > 0) {
        // Bisection between ny (solid) and y (air).
        let lo = ny, hi = y;
        for (let i = 0; i < 10; i++) {
          const m = (lo + hi) / 2;
          if (this.density(x, m, z) > 0) lo = m;
          else hi = m;
        }
        return (lo + hi) / 2;
      }
      y = ny;
      prev = d;
    }
    return NaN;
  }

  /** Surface normal at a point via central differences. */
  normalAt(x: number, y: number, z: number, e = 0.6): [number, number, number] {
    const gx = this.density(x - e, y, z) - this.density(x + e, y, z);
    const gy = this.density(x, y - e, z) - this.density(x, y + e, z);
    const gz = this.density(x, y, z - e) - this.density(x, y, z + e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  }

  /** Is a point inside the underworld band and open? */
  isUnderworld(x: number, y: number, z: number): boolean {
    if (y > UNDERWORLD_CEIL + 30 || y < UNDERWORLD_FLOOR - 30) return false;
    const c = this.cachedColumn(x, z);
    return y > c.uwFloor - 5 && y < c.uwCeil + 5 && c.uwCeil - c.uwFloor > 1;
  }

  /** Site influence at a point (for gameplay). */
  siteAt(x: number, z: number): SiteInfo | null {
    for (const s of this.sites.sitesNear(x, z, 0)) if (Math.hypot(x - s.x, z - s.z) < s.radius * 1.4) return s;
    return null;
  }

  /** Find a pleasant spawn position near the origin: on land, near a settlement if possible. */
  /**
   * Ground height at (x, z) if it is a safe place to put a player down, else NaN:
   * dry, flat around (no slope or ledge to slide off), open sky above (no overhang
   * or cave ceiling) and solid underneath (not a thin crust over a cave).
   */
  safeGround(x: number, z: number, from: number): number {
    const y = this.findGround(x, from, z, 400);
    if (Number.isNaN(y) || y < SEA_LEVEL + 1.5) return NaN;
    for (const [r, tol] of [[2.5, 0.6], [6, 1.8]] as const) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const gy = this.findGround(x + Math.cos(a) * r, y + 12, z + Math.sin(a) * r, 30);
        if (Number.isNaN(gy) || Math.abs(gy - y) > tol || gy < SEA_LEVEL + 0.5) return NaN;
      }
    }
    for (const dy of [0.6, 1.4, 2.4, 4]) if (this.density(x, y + dy, z) > 0) return NaN;
    for (const dy of [1, 2.5]) if (this.density(x, y - dy, z) <= 0) return NaN;
    return y;
  }

  /** New-game spawn: a safe, flat spot just outside a settlement near the origin. */
  findSpawn(): [number, number, number] {
    for (let r = 0; r < 40; r++) {
      const ang = r * 2.4;
      const dist = r * 400;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const sites = this.sites.sitesNear(x, z, 1500);
      for (const s of sites) {
        // Ring just outside the town, starting at the old fixed spot (+x), 16 directions.
        for (const k of [1.3, 1.5, 1.7, 1.15]) {
          for (let j = 0; j < 16; j++) {
            const a = (j % 2 ? 1 : -1) * Math.ceil(j / 2) * (Math.PI / 8);
            const sx = s.x + Math.cos(a) * s.radius * k, sz = s.z + Math.sin(a) * s.radius * k;
            const y = this.safeGround(sx, sz, s.plateau + 80);
            if (!Number.isNaN(y)) return [sx, y + 0.05, sz];
          }
        }
      }
    }
    for (let r = 0; r < 400; r++) {
      const x = r * 97.3, z = r * -41.1;
      const c = this.column(x, z);
      if (c.land > 0.9 && c.height > 3) {
        const y = this.safeGround(x, z, c.height + 60);
        if (!Number.isNaN(y)) return [x, y + 0.05, z];
      }
    }
    return [0, 60, 0];
  }
}

export { CHUNK_SIZE, GRID_N, CHUNK_PAD, WORLD_MIN_Y };
