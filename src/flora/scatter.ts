/**
 * Worker-side placement of vegetation, rocks and small props for one chunk.
 *
 * Runs inside the chunk workers (client) and inside the server worker (the
 * ObjectSystem recomputes LOD-0 scatter on demand), so it must stay free of
 * three.js / DOM and fully deterministic.
 *
 * Placement model
 * ---------------
 * Every layer (trees, shrubs, small plants, grass, boulders, debris, walls &
 * ceilings) owns a WORLD-ALIGNED jittered grid. A cell yields at most one
 * object per floor stratum, its position, species and stable id derive only
 * from the world cell coordinates — never from the chunk — so the same tree is
 * found by an LOD-3 chunk 600 m away, by the LOD-0 chunk under the player and
 * by the server, with the same id. Coarse LODs only differ in the surface
 * height estimate (snapped to their coarser density grid).
 *
 * Floors are found per grid column (sign changes air-over-solid), refined at
 * the candidate's exact x/z by bilinear interpolation. Walls & ceilings use 3D
 * cells projected onto the density iso-surface along its gradient.
 *
 * Instance layout: see scatterTypes.ts. Slot 7 packs two values:
 *   floor(slot7) = sky visibility * 31 (0..31), fract(slot7) = random 0..1.
 */
import type { WorldGenerator, ChunkData, Column } from '../world/generator';
import { SCATTER_STRIDE, type ScatterBatch } from '../world/scatterTypes';
import { CHUNK_SIZE, CHUNK_PAD, GRID_N, SEA_LEVEL, UNDERWORLD_CEIL, UNDERWORLD_SEA_LEVEL } from '../world/constants';
import { Mat } from '../world/materials';
import { Noise } from '../core/noise';
import { SettleMask, MaskHit } from './settleMask';
import { deriveSeed, hash3i, hashToFloat, hash32 } from '../core/rng';
import { clamp, smoothstep } from '../core/math';
import {
  getFloraCatalog, FloraCatalog, FloraSpecies, Layer, LAYER_COUNT, WaterMode, CaveMode, Orient, BiomeFlora, kindOf, usesGroundMaterial,
  rockMaterialFor,
} from './species';

// ------------------------------------------------------------------ layer grid configuration

/** World-aligned cell size (m) per layer. */
export const LAYER_CELL = [6.5, 3.0, 1.5, 0.72, 15, 11, 2.4];
/** Max chunk LOD processed per layer. */
const LAYER_MAX_LOD = [3, 1, 0, 0, 2, 1, 0];
/** Jitter fraction of the cell. */
const LAYER_JITTER = [0.85, 0.9, 0.95, 1.0, 0.8, 0.9, 0.9];
/** Clearance (m) from streets, plazas, buildings and fields per layer. */
const LAYER_MARGIN = [2.5, 1.2, 0.5, 0.15, 2.5, 2.0, 0];
/** Lattice used for LOD-stable height references when computing strata. */
const REF_LATTICE = 8;
const STRATUM_H = 32;

export interface ScatterOptions {
  /** Only emit species with a stable id (destructible / harvestable): used by the server. */
  objectsOnly?: boolean;
}

// ------------------------------------------------------------------ per-world context

interface WorldCtx {
  cat: FloraCatalog;
  grove: Noise;
  patch: Noise;
  stand: Noise;
  layerSeed: number[];
  idSeed: number[];
  /** Max probability of each layer over all tables (fast reject). */
  maxProb: number[];
}

const ctxCache = new WeakMap<WorldGenerator, WorldCtx>();

function worldCtx(gen: WorldGenerator): WorldCtx {
  let c = ctxCache.get(gen);
  if (c) return c;
  const p = gen.profile;
  const cat = getFloraCatalog(p);
  const maxProb = new Array(LAYER_COUNT).fill(0);
  for (const t of [...cat.biomes, ...cat.caves]) {
    if (!t) continue;
    for (let l = 0; l < LAYER_COUNT; l++) maxProb[l] = Math.max(maxProb[l], t.prob[l] * 1.6);
  }
  c = {
    cat,
    grove: new Noise(deriveSeed(p.floraSeed, 'grove')),
    patch: new Noise(deriveSeed(p.floraSeed, 'patch')),
    stand: new Noise(deriveSeed(p.floraSeed, 'stand')),
    layerSeed: Array.from({ length: LAYER_COUNT }, (_, i) => deriveSeed(p.floraSeed, 'layer', i)),
    idSeed: Array.from({ length: LAYER_COUNT }, (_, i) => deriveSeed(p.floraSeed, 'id', i)),
    maxProb,
  };
  ctxCache.set(gen, c);
  return c;
}

// ------------------------------------------------------------------ batch accumulation

class BatchAcc {
  data: Float32Array;
  ids: Uint32Array | null;
  n = 0;
  constructor(readonly kind: string, withIds: boolean) {
    this.data = new Float32Array(SCATTER_STRIDE * 16);
    this.ids = withIds ? new Uint32Array(16) : null;
  }
  push(x: number, y: number, z: number, yaw: number, scale: number, tx: number, tz: number, packed: number, id: number) {
    if ((this.n + 1) * SCATTER_STRIDE > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
      if (this.ids) {
        const ii = new Uint32Array(this.ids.length * 2);
        ii.set(this.ids);
        this.ids = ii;
      }
    }
    const o = this.n * SCATTER_STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = yaw;
    d[o + 4] = scale;
    d[o + 5] = tx;
    d[o + 6] = tz;
    d[o + 7] = packed;
    if (this.ids) this.ids[this.n] = id;
    this.n++;
  }
  finish(): ScatterBatch {
    const b: ScatterBatch = { kind: this.kind, data: this.data.slice(0, this.n * SCATTER_STRIDE) };
    if (this.ids) b.ids = this.ids.slice(0, this.n);
    return b;
  }
}

// ------------------------------------------------------------------ scratch (reused between calls in one worker)

const N = GRID_N;
const NN = N * N;
const MAX_FLOORS = 6;
const floorCount = new Uint8Array(NN);
const floorJ = new Int16Array(NN * MAX_FLOORS);
const G = 9; // coarse column lattice per axis
const latBiome = new Uint8Array(G * G);
const latBiome2 = new Uint8Array(G * G);
const latUw = new Uint8Array(G * G);
const latBlend = new Float32Array(G * G);
const latSite = new Float32Array(G * G);
const latRoad = new Float32Array(G * G);
const latRiver = new Float32Array(G * G);
const latRock = new Float32Array(G * G);
const latH = new Float32Array(G * G);
const latUwFloor = new Float32Array(G * G);
const latUwOpen = new Float32Array(G * G);

/** Local sample of all per-candidate inputs (reused object). */
interface Site {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  mat: number;
  sky: number;
  /** Interpolated column data. */
  biome: number;
  site: number;
  road: number;
  river: number;
  rock: number;
  h: number;
  /** Context: 0 surface, 1 cave, 2 underworld. */
  ctxKind: number;
  sea: number;
  table: BiomeFlora | null;
}
const S: Site = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, mat: 0, sky: 1, biome: 0, site: 0, road: 0, river: 0, rock: 0, h: 0, ctxKind: 0, sea: 0, table: null };
const candW = new Float32Array(64);
const candSp = new Int32Array(64);

// ------------------------------------------------------------------ main entry

/**
 * Decide placements for a freshly generated (unedited) chunk.
 * @param cx,cy,cz chunk coordinates at this LOD (origin / (CHUNK_SIZE << lod))
 */
export function scatterChunk(gen: WorldGenerator, chunk: ChunkData, cx: number, cy: number, cz: number, opts: ScatterOptions = {}): ScatterBatch[] {
  if (chunk.uniform !== null) return [];
  const W = worldCtx(gen);
  const cat = W.cat;
  const { density, mats, step, lod, ox, oy, oz } = chunk;
  const size = CHUNK_SIZE * step;
  const objectsOnly = !!opts.objectsOnly;
  const heights = chunk.heights;

  // ---- floors per column
  for (let k = 0; k < N; k++)
    for (let i = 0; i < N; i++) {
      const c = i + k * N;
      let n = 0;
      for (let j = 0; j < N - 1 && n < MAX_FLOORS; j++) {
        const a = density[i + j * N + k * NN], b = density[i + (j + 1) * N + k * NN];
        if (a > 0 && b <= 0) floorJ[c * MAX_FLOORS + n++] = j;
      }
      floorCount[c] = n;
    }

  // ---- coarse column lattice (biomes, sites, roads...)
  const latStep = size / (G - 1);
  for (let k = 0; k < G; k++)
    for (let i = 0; i < G; i++) {
      const col: Column = gen.cachedColumn(ox + i * latStep, oz + k * latStep);
      const o = i + k * G;
      latBiome[o] = col.biome;
      latBiome2[o] = col.biome2;
      latBlend[o] = col.blend;
      latSite[o] = col.site;
      latRoad[o] = col.road;
      latRiver[o] = col.river;
      latRock[o] = col.rock;
      latH[o] = col.height;
      latUw[o] = col.uwBiome;
      latUwFloor[o] = col.uwFloor;
      latUwOpen[o] = col.uwCeil - col.uwFloor;
    }

  // Settlement streets / plazas / buildings / fields (deterministic layouts).
  const mask = SettleMask.of(gen).forArea(ox, oz, ox + size, oz + size);

  const batches = new Map<string, BatchAcc>();
  const emit = (sp: FloraSpecies, variant: number, mat: number, lx: number, ly: number, lz: number, yaw: number, scale: number, tx: number, tz: number, sky: number, rnd: number, id: number) => {
    const key = kindOf(sp.idx, variant, mat);
    let acc = batches.get(key);
    const withIds = sp.interact !== '';
    if (!acc) batches.set(key, (acc = new BatchAcc(key, withIds)));
    const packed = Math.round(clamp(sky, 0, 1) * 31) + Math.min(0.999, rnd);
    acc.push(lx, ly, lz, yaw, scale, tx, tz, packed, withIds ? id || 1 : 0);
  };

  // ---- helpers bound to this chunk
  const gxOf = (x: number) => (x - ox) / step + CHUNK_PAD;
  const gzOf = (z: number) => (z - oz) / step + CHUNK_PAD;
  const yMin = oy - CHUNK_PAD * step;

  /** Bilinear density at fractional column (gx,gz), integer level j. */
  const bil = (gx: number, gz: number, j: number) => {
    const i0 = Math.min(N - 2, Math.max(0, Math.floor(gx))), k0 = Math.min(N - 2, Math.max(0, Math.floor(gz)));
    const fx = gx - i0, fz = gz - k0;
    const b = i0 + j * N + k0 * NN;
    const d00 = density[b], d10 = density[b + 1], d01 = density[b + NN], d11 = density[b + NN + 1];
    return (d00 + (d10 - d00) * fx) * (1 - fz) + (d01 + (d11 - d01) * fx) * fz;
  };

  /** Trilinear density at fractional grid coordinates. */
  const tri = (gx: number, gy: number, gz: number) => {
    const i0 = Math.min(N - 2, Math.max(0, Math.floor(gx)));
    const j0 = Math.min(N - 2, Math.max(0, Math.floor(gy)));
    const k0 = Math.min(N - 2, Math.max(0, Math.floor(gz)));
    const fx = gx - i0, fy = gy - j0, fz = gz - k0;
    const b = i0 + j0 * N + k0 * NN;
    const c00 = density[b] + (density[b + 1] - density[b]) * fx;
    const c10 = density[b + N] + (density[b + N + 1] - density[b + N]) * fx;
    const c01 = density[b + NN] + (density[b + NN + 1] - density[b + NN]) * fx;
    const c11 = density[b + NN + N] + (density[b + NN + N + 1] - density[b + NN + N]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  };

  /** 2D surface height (exact column heights, bilinear). */
  const heightAt = (gx: number, gz: number) => {
    if (!heights) return 0;
    const i0 = Math.min(N - 2, Math.max(0, Math.floor(gx))), k0 = Math.min(N - 2, Math.max(0, Math.floor(gz)));
    const fx = clamp(gx - i0, 0, 1), fz = clamp(gz - k0, 0, 1);
    const b = i0 + k0 * N;
    return (heights[b] * (1 - fx) + heights[b + 1] * fx) * (1 - fz) + (heights[b + N] * (1 - fx) + heights[b + N + 1] * fx) * fz;
  };

  /** LOD-independent reference height: exact column height on the 8 m world lattice. */
  const refHeight = (x: number, z: number) => {
    if (!heights) return 0;
    const lx = Math.floor(x / REF_LATTICE) * REF_LATTICE, lz = Math.floor(z / REF_LATTICE) * REF_LATTICE;
    const i = Math.round((lx - ox) / step) + CHUNK_PAD, k = Math.round((lz - oz) / step) + CHUNK_PAD;
    return heights[Math.min(N - 1, Math.max(0, i)) + Math.min(N - 1, Math.max(0, k)) * N];
  };

  /** Fill S with lattice column data at (x,z) (bilinear for continuous values, dithered nearest for biomes). */
  const sampleColumn = (x: number, z: number, rnd: number) => {
    const fx = clamp((x - ox) / latStep, 0, G - 1.0001), fz = clamp((z - oz) / latStep, 0, G - 1.0001);
    const i0 = Math.floor(fx), k0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - k0;
    const o = i0 + k0 * G;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    S.site = latSite[o] * w00 + latSite[o + 1] * w10 + latSite[o + G] * w01 + latSite[o + G + 1] * w11;
    S.road = latRoad[o] * w00 + latRoad[o + 1] * w10 + latRoad[o + G] * w01 + latRoad[o + G + 1] * w11;
    S.river = latRiver[o] * w00 + latRiver[o + 1] * w10 + latRiver[o + G] * w01 + latRiver[o + G + 1] * w11;
    S.rock = latRock[o] * w00 + latRock[o + 1] * w10 + latRock[o + G] * w01 + latRock[o + G + 1] * w11;
    // Dithered biome choice among the 4 lattice corners → organic transitions.
    let r = rnd, c = o;
    if (r < w00) c = o;
    else if ((r -= w00) < w10) c = o + 1;
    else if ((r -= w10) < w01) c = o + G;
    else c = o + G + 1;
    const r2 = hashToFloat(hash32(Math.floor(rnd * 4294967295)));
    S.biome = r2 < latBlend[c] ? latBiome2[c] : latBiome[c];
    return c;
  };

  /** Decide context table for a floor/wall at (x,y,z). */
  const chooseContext = (latCorner: number, x: number, y: number, z: number, href: number) => {
    const uwOpen = latUwOpen[latCorner] > 1;
    if (uwOpen && y < UNDERWORLD_CEIL + 25 && y > latUwFloor[latCorner] - 12 && y < href - 30) {
      S.ctxKind = 2;
      S.table = cat.biomes[latUw[latCorner]];
      S.sea = UNDERWORLD_SEA_LEVEL;
      return;
    }
    S.sea = SEA_LEVEL;
    if (y < href - 6) {
      S.ctxKind = 1;
      S.table = cat.caves[S.biome] ?? null;
      return;
    }
    S.ctxKind = 0;
    S.table = cat.biomes[S.biome] ?? null;
  };

  /** Sky visibility estimate (mirrors terrain mesher: depth below 2D surface + overhang shade). */
  const skyVis = (gi: number, gj: number, gk: number, y: number, h: number) => {
    let v = 1;
    const depth = h - y;
    if (depth > 1.5) {
      const t = Math.min(1, (depth - 1.5) / (10 + step * 2));
      v = 1 - t * t * (3 - 2 * t);
    }
    if (v > 0) {
      const i = Math.min(N - 1, Math.max(0, gi)), k = Math.min(N - 1, Math.max(0, gk));
      for (let jj = gj + 3; jj < N; jj++) {
        if (density[i + jj * N + k * NN] > 0) {
          v *= 0.4;
          break;
        }
      }
    }
    return v;
  };

  /** Normal at a sample (central differences), written into S.nx/ny/nz. */
  const normalAtSample = (i: number, j: number, k: number) => {
    i = Math.min(N - 2, Math.max(1, i));
    j = Math.min(N - 2, Math.max(1, j));
    k = Math.min(N - 2, Math.max(1, k));
    const b = i + j * N + k * NN;
    const gx = density[b - 1] - density[b + 1];
    const gy = density[b - N] - density[b + N];
    const gz = density[b - NN] - density[b + NN];
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    S.nx = gx / l;
    S.ny = gy / l;
    S.nz = gz / l;
  };

  /** Pick a species from a layer list for the current site S. Returns index or -1. */
  const pickSpecies = (list: { sp: number; w: number }[], layer: Layer, rnd: number, x: number, z: number): number => {
    let n = 0, total = 0;
    for (let e = 0; e < list.length && n < 64; e++) {
      const sp = cat.species[list[e].sp];
      if (sp.lods < lod) continue;
      if (objectsOnly && sp.interact === '') continue;
      if (S.ny < sp.slope) continue;
      if (sp.mats !== 0 && !(sp.mats & (1 << S.mat))) continue;
      if (sp.cave === CaveMode.Sky && S.sky < 0.6) continue;
      if (sp.cave === CaveMode.Dark && S.sky > 0.35) continue;
      const dy = S.y - S.sea;
      switch (sp.water) {
        case WaterMode.Land: if (dy < 0.25) continue; break;
        case WaterMode.Shore: if (dy < -0.9 || dy > 1.8) continue; break;
        case WaterMode.Under: if (dy > -1.0) continue; break;
        case WaterMode.Float: if (dy > -0.25 || dy < -2.6) continue; break;
      }
      if (sp.orient === Orient.Hang && S.ny > -0.55) continue;
      if (layer === Layer.Surface3D && sp.orient === Orient.Up) continue;
      // Stands: each species has its own low-frequency presence field.
      const scaleN = layer === Layer.Small || layer === Layer.Grass ? 22 : layer === Layer.Shrub ? 40 : 75;
      const st = 0.5 + 0.5 * W.stand.n2(x / scaleN + sp.idx * 17.31, z / scaleN - sp.idx * 9.17);
      let w = list[e].w * Math.pow(clamp(st * 1.25, 0.02, 1.25), 1 + sp.cluster * 3);
      // Shore lovers thrive along rivers; river beds keep trees away.
      if (sp.water === WaterMode.Shore) w *= 1 + S.river * 4;
      if (w <= 0) continue;
      candW[n] = w;
      candSp[n] = sp.idx;
      total += w;
      n++;
    }
    if (n === 0 || total <= 0) return -1;
    let r = rnd * total;
    for (let e = 0; e < n; e++) {
      r -= candW[e];
      if (r <= 0) return candSp[e];
    }
    return candSp[n - 1];
  };

  /** Probability modulation per layer at a point (groves, clearings, patches). */
  const layerMod = (layer: Layer, x: number, z: number) => {
    switch (layer) {
      case Layer.Tree: {
        const g = W.grove.n2(x / 85, z / 85) * 0.7 + W.grove.n2(x / 27, z / 27) * 0.3;
        return (0.22 + 1.15 * smoothstep(-0.4, 0.45, g)) * clamp(1 - S.site * 2.2, 0, 1) * (1 - S.river);
      }
      case Layer.Shrub: {
        const g = W.grove.n2(x / 60 + 31.1, z / 60 - 7.7);
        return (0.45 + 0.9 * smoothstep(-0.5, 0.6, g)) * (1 - smoothstep(0.35, 0.55, S.site)) * (1 - S.road);
      }
      case Layer.Small:
        return (0.35 + 1.0 * smoothstep(-0.5, 0.5, W.patch.n2(x / 19, z / 19))) * (1 - 0.85 * smoothstep(0.4, 0.6, S.site)) * (1 - S.road);
      case Layer.Grass: {
        const g = W.patch.n2(x / 31 + 9.3, z / 31 + 2.1) * 0.65 + W.patch.n2(x / 7, z / 7) * 0.35;
        // Settlement interiors stay trodden: only a few tufts survive past site > 0.5.
        return smoothstep(-0.65, 0.15, g) * (1 - S.road) * (1 - 0.8 * smoothstep(0.4, 0.6, S.site));
      }
      case Layer.Boulder:
        return (0.45 + S.rock * 1.6) * clamp(1 - S.site * 1.5, 0, 1) * (1 - S.road);
      case Layer.Debris: {
        const g = W.grove.n2(x / 85, z / 85);
        return (0.5 + 0.8 * smoothstep(-0.3, 0.5, g)) * clamp(1 - S.site * 1.5, 0, 1) * (1 - S.road);
      }
      default:
        return 1;
    }
  };

  // ---- 2D floor layers
  for (let li = 0; li < LAYER_COUNT; li++) {
    const layer = li as Layer;
    if (layer === Layer.Surface3D) continue;
    if (lod > LAYER_MAX_LOD[layer]) continue;
    if (objectsOnly && layer === Layer.Grass) continue;
    const cell = LAYER_CELL[layer];
    const jit = LAYER_JITTER[layer];
    const lseed = W.layerSeed[layer];
    const idSeed = W.idSeed[layer];
    const maxP = W.maxProb[layer];
    if (maxP <= 0) continue;
    const ix0 = Math.floor(ox / cell), ix1 = Math.floor((ox + size - 1e-6) / cell);
    const iz0 = Math.floor(oz / cell), iz1 = Math.floor((oz + size - 1e-6) / cell);
    for (let iz = iz0; iz <= iz1; iz++)
      for (let ix = ix0; ix <= ix1; ix++) {
        const h0 = hash3i(lseed, ix, iz, 0);
        const pr = hashToFloat(h0);
        // Fast reject: the main-surface decision uses pr directly (other strata re-roll below).
        if (pr > maxP && lod >= 2) continue;
        const h1 = hash32(h0 ^ 0x68e31da4), h2 = hash32(h1 ^ 0x1b56c4e9);
        const x = (ix + 0.5 + (hashToFloat(h1) - 0.5) * jit) * cell;
        const z = (iz + 0.5 + (hashToFloat(h2) - 0.5) * jit) * cell;
        if (x < ox || x >= ox + size || z < oz || z >= oz + size) continue;
        const gx = gxOf(x), gz = gzOf(z);
        const ci = Math.round(gx), ck = Math.round(gz);
        const col = ci + ck * N;
        const nf = floorCount[col];
        if (nf === 0 || (nf === 1 && pr > maxP)) continue;
        const latCorner = sampleColumn(x, z, hashToFloat(hash32(h2 ^ 0x2545f491)));
        const href = refHeight(x, z);
        const h2d = heightAt(gx, gz);
        const masked = mask ? mask.test(x, z, LAYER_MARGIN[layer]) !== MaskHit.Free : false;
        // Floors from the top: track per-stratum ordinals for unique ids.
        let lastStratum = 1e9, ordinal = 0;
        for (let f = nf - 1; f >= 0; f--) {
          const j = floorJ[col * MAX_FLOORS + f];
          // Refine the crossing at the exact x/z.
          let y = NaN;
          for (let jj = Math.max(0, j - 1); jj <= Math.min(N - 2, j + 1); jj++) {
            const a = bil(gx, gz, jj), b = bil(gx, gz, jj + 1);
            if (a > 0 && b <= 0) {
              y = yMin + (jj + a / (a - b)) * step;
              break;
            }
          }
          if (Number.isNaN(y)) {
            const a = density[ci + j * N + ck * NN], b = density[ci + (j + 1) * N + ck * NN];
            y = yMin + (j + a / (a - b)) * step;
          }
          const stratum = Math.round((y - href) / STRATUM_H);
          if (stratum === lastStratum) ordinal++;
          else {
            ordinal = 0;
            lastStratum = stratum;
          }
          if (y < oy || y >= oy + size) continue;
          // Town features only clear the ground level (caves beneath keep their flora).
          if (masked && Math.abs(y - h2d) < 8) continue;
          S.x = x;
          S.y = y;
          S.z = z;
          normalAtSample(ci, j, ck);
          let m = mats[ci + j * N + ck * NN];
          if (!m && j > 0) m = mats[ci + (j - 1) * N + ck * NN];
          S.mat = m || Mat.Stone;
          S.h = h2d;
          S.sky = skyVis(ci, j, ck, y, h2d);
          chooseContext(latCorner, x, y, z, href);
          const table = S.table;
          if (!table) continue;
          const list = table.layers[layer];
          if (!list.length) continue;
          // Per-floor random stream (stratum-aware so stacked floors differ).
          const hs = hash3i(lseed, ix, iz, 1000 + stratum * 8 + ordinal);
          let p = table.prob[layer] * layerMod(layer, x, z);
          if (S.ctxKind === 0 && S.y - S.sea < 0.25 && layer === Layer.Tree) p *= 0.5;
          const pDecide = stratum === 0 ? pr : hashToFloat(hs);
          if (pDecide >= p) continue;
          // Trees avoid roads and settlement cores precisely (exact column at fine LODs).
          if (layer === Layer.Tree || layer === Layer.Boulder || layer === Layer.Debris) {
            if (S.road > 0.05 || S.site > 0.3) {
              if (lod >= 2) continue;
              const ec = gen.cachedColumn(x, z);
              if (ec.road > 0.02 || ec.site > 0.3) continue;
            }
            if (S.mat === Mat.Path || S.mat === Mat.Cobble) continue;
          }
          const r1 = hashToFloat(hash32(hs ^ 0x9e3779b9));
          const spi = pickSpecies(list, layer, r1, x, z);
          if (spi < 0) continue;
          const sp = cat.species[spi];
          const r2 = hashToFloat(hash32(hs ^ 0x85ebca6b));
          const r3 = hashToFloat(hash32(hs ^ 0xc2b2ae35));
          const r4 = hashToFloat(hash32(hs ^ 0x27d4eb2f));
          placeInstance(sp, layer, r2, r3, r4, x, y, z, hash3i(idSeed, ix, iz, stratum * 8 + ordinal));
        }
      }
  }

  // ---- walls & ceilings (3D cells, LOD 0 only)
  if (lod === 0) {
    const layer = Layer.Surface3D;
    const cell = LAYER_CELL[layer];
    const lseed = W.layerSeed[layer], idSeed = W.idSeed[layer];
    const ix0 = Math.floor(ox / cell), ix1 = Math.floor((ox + size - 1e-6) / cell);
    const iy0 = Math.floor(oy / cell), iy1 = Math.floor((oy + size - 1e-6) / cell);
    const iz0 = Math.floor(oz / cell), iz1 = Math.floor((oz + size - 1e-6) / cell);
    for (let iz = iz0; iz <= iz1; iz++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let ix = ix0; ix <= ix1; ix++) {
          const h0 = hash3i(lseed, ix, iy, iz);
          const pr = hashToFloat(h0);
          if (pr > W.maxProb[layer]) continue;
          const h1 = hash32(h0 ^ 0x68e31da4), h2 = hash32(h1 ^ 0x1b56c4e9), h3 = hash32(h2 ^ 0x7f4a7c15);
          let x = (ix + 0.5 + (hashToFloat(h1) - 0.5) * 0.9) * cell;
          let y = (iy + 0.5 + (hashToFloat(h2) - 0.5) * 0.9) * cell;
          let z = (iz + 0.5 + (hashToFloat(h3) - 0.5) * 0.9) * cell;
          if (x < ox || x >= ox + size || y < oy || y >= oy + size || z < oz || z >= oz + size) continue;
          if (mask && mask.test(x, z, 0) === MaskHit.Hard && Math.abs(y - heightAt(gxOf(x), gzOf(z))) < 10) continue;
          let gx = gxOf(x), gy = (y - yMin) / step, gz = gzOf(z);
          const d = tri(gx, gy, gz);
          if (d > 1.3 || d < -1.3) continue;
          const e = 0.5;
          const ggx = tri(gx + e, gy, gz) - tri(gx - e, gy, gz);
          const ggy = tri(gx, gy + e, gz) - tri(gx, gy - e, gz);
          const ggz = tri(gx, gy, gz + e) - tri(gx, gy, gz - e);
          const gl = Math.sqrt(ggx * ggx + ggy * ggy + ggz * ggz);
          if (gl < 1e-4) continue;
          // Outward normal (towards air) and projection onto the iso-surface.
          const nx = -ggx / gl, ny = -ggy / gl, nz = -ggz / gl;
          if (ny > 0.5) continue; // floors belong to the 2D layers
          const dist = d / (gl / (2 * e));
          x += nx * dist;
          y += ny * dist;
          z += nz * dist;
          gx = gxOf(x);
          gy = (y - yMin) / step;
          gz = gzOf(z);
          S.x = x;
          S.y = y;
          S.z = z;
          S.nx = nx;
          S.ny = ny;
          S.nz = nz;
          const si = Math.round(gx), sj = Math.round(gy), sk = Math.round(gz);
          let m = 0;
          for (let dd = 0; dd <= 1 && !m; dd++) {
            const ii = Math.min(N - 1, Math.max(0, Math.round(gx - nx * dd)));
            const jj = Math.min(N - 1, Math.max(0, Math.round(gy - ny * dd)));
            const kk = Math.min(N - 1, Math.max(0, Math.round(gz - nz * dd)));
            m = mats[ii + jj * N + kk * NN];
          }
          S.mat = m || Mat.Stone;
          const latCorner = sampleColumn(x, z, hashToFloat(hash32(h3 ^ 0x2545f491)));
          const href = refHeight(x, z);
          const h2d = heightAt(gx, gz);
          S.h = h2d;
          S.sky = ny < -0.5 && y < h2d - 3 ? 0 : skyVis(si, sj, sk, y, h2d);
          chooseContext(latCorner, x, y, z, href);
          const table = S.table;
          if (!table) continue;
          const list = table.layers[layer];
          if (!list.length) continue;
          if (pr / W.maxProb[layer] >= table.prob[layer]) continue;
          const r1 = hashToFloat(hash32(h0 ^ 0x9e3779b9));
          const spi = pickSpecies(list, layer, r1, x, z);
          if (spi < 0) continue;
          const sp = cat.species[spi];
          placeInstance(sp, layer, hashToFloat(hash32(h0 ^ 0x85ebca6b)), hashToFloat(hash32(h0 ^ 0xc2b2ae35)), hashToFloat(hash32(h0 ^ 0x27d4eb2f)), x, y, z, hash3i(idSeed, ix, iy, iz));
        }
  }

  // ---- shared instance placement
  function placeInstance(sp: FloraSpecies, layer: Layer, r2: number, r3: number, r4: number, x: number, y: number, z: number, id: number) {
    const yaw = r2 * Math.PI * 2;
    const scale = sp.scale[0] + (sp.scale[1] - sp.scale[0]) * Math.pow(r3, 1.3);
    let tx = 0, tz = 0;
    let nx = S.nx, ny = S.ny, nz = S.nz;
    switch (sp.orient) {
      case Orient.Up: {
        // Slight lean (more for small plants, a hint of downhill lean for trees).
        const lean = layer === Layer.Tree ? 0.05 : 0.12;
        tx = (r4 - 0.5) * lean + nz * 0.08;
        tz = (hashToFloat(hash32(id ^ 0x5bd1e995)) - 0.5) * lean - nx * 0.08;
        break;
      }
      case Orient.Half: {
        nx *= 0.6;
        nz *= 0.6;
        ny = ny * 0.6 + 0.4;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        tz = Math.asin(clamp(-nx, -1, 1));
        tx = Math.atan2(nz, ny);
        break;
      }
      case Orient.Normal:
        tz = Math.asin(clamp(-nx, -1, 1));
        tx = Math.atan2(nz, ny);
        break;
      case Orient.Hang:
        tx = Math.PI + (r4 - 0.5) * 0.08;
        tz = 0;
        break;
    }
    if (sp.water === WaterMode.Float) {
      y = S.sea + 0.03;
      tx = tz = 0;
    }
    const variant = sp.variants > 1 ? Math.min(sp.variants - 1, Math.floor(hashToFloat(hash32(id ^ 0x3c6ef372)) * sp.variants)) : 0;
    const mat = usesGroundMaterial(sp) ? rockMaterialFor(S.mat) : -1;
    emit(sp, variant, mat, x - ox, y - oy, z - oz, yaw, scale, tx, tz, S.sky, r4, id);
  }

  const out: ScatterBatch[] = [];
  for (const acc of batches.values()) if (acc.n > 0) out.push(acc.finish());
  return out;
}

/** Decode packed slot 7 → sky visibility 0..1. */
export function unpackSky(v: number): number {
  return Math.floor(v) / 31;
}

/** Decode packed slot 7 → per-instance random 0..1. */
export function unpackRand(v: number): number {
  return v - Math.floor(v);
}
