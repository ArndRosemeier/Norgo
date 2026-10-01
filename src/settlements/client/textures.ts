/**
 * Procedural surface textures for settlement architecture.
 *
 * Every `Surf` id (see build/kit.ts) gets one layer in two texture arrays:
 *  - albedo: sRGB colour + roughness in alpha,
 *  - normal: tangent-space normal (OpenGL convention, +Y = +v) + cavity AO in alpha.
 *
 * Layers tile seamlessly over one UV unit; the mesher divides meters by
 * SURF_TILE[surf], so feature sizes here are authored against those tile
 * sizes (e.g. planks: 8 boards per 1.6 m tile). Rows of roofing (shingle,
 * slate, clay tile) run along u with v pointing up the slope.
 *
 * Everything is generated deterministically on the CPU with periodic noise
 * fields precomputed once and resampled with integer scales/offsets (which
 * keeps every derived pattern seamless) — the whole set takes ~100-200 ms.
 */
import * as THREE from 'three';
import { hash2i, hashToFloat } from '../../core/rng';
import { SURF_COUNT, Surf } from '../build/kit';

export const LAYER_SIZE = 256;
const N = LAYER_SIZE;
const M = N - 1;
const NN = N * N;
const SEED = 0x5e771e;

// ------------------------------------------------------------------ math helpers

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const fract = (x: number) => x - Math.floor(x);
const h2 = (s: number, x: number, y: number) => hashToFloat(hash2i(s, x, y));

/** Lattice value tables per (seed, period): hashing once per lattice point keeps generation fast. */
const latticeCache = new Map<string, Float32Array>();
function lattice(seed: number, period: number): Float32Array {
  const key = seed + ':' + period;
  let t = latticeCache.get(key);
  if (!t) {
    t = new Float32Array(period * period);
    for (let y = 0; y < period; y++) for (let x = 0; x < period; x++) t[y * period + x] = h2(seed, x, y);
    latticeCache.set(key, t);
  }
  return t;
}

/** Periodic value noise on a period-cell lattice sampled at u,v ∈ [0,1). */
function vnoise(seed: number, u: number, v: number, period: number, t = lattice(seed, period)): number {
  const x = u * period, y = v * period;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period, y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = t[y0 * period + x0], b = t[y0 * period + x1], c = t[y1 * period + x0], d = t[y1 * period + x1];
  return mix(mix(a, b, sx), mix(c, d, sx), sy);
}

/** Precomputed periodic fBm fields (values ~0..1), indexed [y*N + x]. */
const FIELD_PERIODS = [2, 4, 8, 16, 32, 64];
let fields: Float32Array[] | null = null;
function buildFields(): Float32Array[] {
  const out: Float32Array[] = [];
  FIELD_PERIODS.forEach((p0, fi) => {
    const f = new Float32Array(NN);
    let amp = 0.5, norm = 0, p = p0;
    for (let o = 0; o < 4 && p <= N; o++) {
      const seed = SEED + fi * 101 + o * 7;
      const tab = lattice(seed, p);
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) f[y * N + x] += vnoise(seed, x / N, y / N, p, tab) * amp;
      norm += amp;
      amp *= 0.5;
      p *= 2;
    }
    for (let i = 0; i < NN; i++) f[i] /= norm;
    out.push(f);
  });
  return out;
}

/** Sample field `fi` with integer scales (kx, ky) and pixel offsets — stays periodic. */
function F(fi: number, x: number, y: number, kx = 1, ky = 1, ox = 0, oy = 0): number {
  const f = fields![fi];
  return f[(((y * ky + oy) & M) << 8) | ((x * kx + ox) & M)];
}

/** Periodic Worley noise: jittered points on a cw×ch grid. Returns f1, f2 (in cell units) and nearest cell id. */
interface Cell {
  f1: number;
  f2: number;
  id: number;
  cx: number;
  cy: number;
  /** Offset from nearest point (cell units). */
  dx: number;
  dy: number;
}
const jitterCache = new Map<string, Float32Array>();
let lastJ: { seed: number; cw: number; ch: number; jitter: number; t: Float32Array } | null = null;
function jitterPts(seed: number, cw: number, ch: number, jitter: number): Float32Array {
  if (lastJ && lastJ.seed === seed && lastJ.cw === cw && lastJ.ch === ch && lastJ.jitter === jitter) return lastJ.t;
  const key = seed + ':' + cw + ':' + ch + ':' + jitter;
  let t = jitterCache.get(key);
  if (!t) {
    t = new Float32Array(cw * ch * 2);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        t[(y * cw + x) * 2] = 0.5 + (h2(seed, x, y) - 0.5) * jitter;
        t[(y * cw + x) * 2 + 1] = 0.5 + (h2(seed + 1, x, y) - 0.5) * jitter;
      }
    jitterCache.set(key, t);
  }
  lastJ = { seed, cw, ch, jitter, t };
  return t;
}
const cellOut: Cell = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0, dx: 0, dy: 0 };
function worley(seed: number, u: number, v: number, cw: number, ch: number, jitter = 0.85, stretchX = 1): Cell {
  const x = u * cw, y = v * ch;
  const ix = Math.floor(x), iy = Math.floor(y);
  const pts = jitterPts(seed, cw, ch, jitter);
  let f1 = 1e9, f2 = 1e9, id = 0, bcx = 0, bcy = 0, bdx = 0, bdy = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const wx = ((cx % cw) + cw) % cw, wy = ((cy % ch) + ch) % ch;
      const pi = (wy * cw + wx) * 2;
      const px = cx + pts[pi];
      const py = cy + pts[pi + 1];
      const dx = (x - px) * stretchX, dy = y - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = wy * cw + wx;
        bcx = wx;
        bcy = wy;
        bdx = dx;
        bdy = dy;
      } else if (d < f2) f2 = d;
    }
  cellOut.f1 = f1;
  cellOut.f2 = f2;
  cellOut.id = id;
  cellOut.cx = bcx;
  cellOut.cy = bcy;
  cellOut.dx = bdx;
  cellOut.dy = bdy;
  return cellOut;
}

// ------------------------------------------------------------------ layer canvas

/** Working buffers for one layer. Colours are sRGB 0..1. */
class Layer {
  h = new Float32Array(NN);
  r = new Float32Array(NN);
  g = new Float32Array(NN);
  b = new Float32Array(NN);
  rough = new Float32Array(NN);
  /** Normal strength (height units → slope). */
  strength = 2;
  /** Cavity AO strength. */
  ao = 1;
  set(i: number, h: number, r: number, g: number, b: number, rough: number) {
    this.h[i] = h;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    this.rough[i] = rough;
  }
}

type Gen = (L: Layer) => void;

/** Iterate pixels with u,v ∈ [0,1). */
function each(fn: (x: number, y: number, u: number, v: number, i: number) => void) {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) fn(x, y, x / N, y / N, (y << 8) | x);
}

// ------------------------------------------------------------------ layer generators

const plaster: Gen = (L) => {
  L.strength = 1.4;
  each((x, y, u, v, i) => {
    const big = F(1, x, y, 1, 1, 30, 70);
    const fine = F(5, x, y, 1, 1, 13, 5);
    const trowel = F(4, x, y, 1, 2, 7, 3);
    const stain = smooth(0.55, 0.75, F(0, x, y, 1, 1, 90, 20));
    const crack = worley(SEED + 3, u, v, 5, 5);
    const crackLine = (1 - smooth(0.0, 0.015, crack.f2 - crack.f1)) * smooth(0.66, 0.74, F(2, x, y, 1, 1, 50, 50)) * 0.5;
    const h = big * 0.35 + trowel * 0.4 + fine * 0.25 - crackLine * 0.5;
    const k = 0.9 + (big - 0.5) * 0.12 + (fine - 0.5) * 0.08 - stain * 0.1 - crackLine * 0.35;
    L.set(i, h, 0.9 * k, 0.88 * k, 0.83 * k - stain * 0.03, 0.92);
  });
};

const planks: Gen = (L) => {
  L.strength = 2.4;
  const rows = 8;
  each((x, y, u, v, i) => {
    const row = Math.floor(v * rows);
    const t = fract(v * rows);
    // Two butt joints per board row at hashed positions.
    const j1 = h2(SEED + 11, row, 0), j2 = fract(j1 + 0.35 + h2(SEED + 12, row, 0) * 0.3);
    const segA = fract(u - j1), segB = fract(u - j2);
    const seg = segA < fract(j2 - j1) ? 0 : 1;
    const dEnd = Math.min(segA, 1 - segA, segB, 1 - segB) * 1.6; // meters to nearest joint
    const board = row * 2 + seg;
    const tone = h2(SEED + 13, board, 1);
    const grain = F(5, x, y, 1, 8, board * 37, 0);
    const rings = Math.sin((v * rows * 6 + F(2, x, y, 1, 4, board * 11, 0) * 9) * Math.PI) * 0.5 + 0.5;
    const knotC = worley(SEED + 14, u, v, 6, rows);
    const knot = (1 - smooth(0.0, 0.18, knotC.f1)) * (h2(SEED + 15, knotC.cx, knotC.cy) > 0.7 ? 1 : 0);
    const gap = smooth(0.0, 0.06, t) * smooth(0.0, 0.06, 1 - t) * smooth(0.0, 0.012, dEnd);
    // Nail heads near joints.
    const nailT = Math.min(Math.abs(t - 0.28), Math.abs(t - 0.72)) * 0.2;
    const nail = 1 - smooth(0.006, 0.011, Math.hypot(dEnd - 0.03, nailT));
    const wear = smooth(0.65, 0.9, F(1, x, y, 1, 1, 40, 0)) * 0.08;
    const h = gap * (0.75 + grain * 0.15 + rings * 0.06 - knot * 0.15) + nail * 0.12;
    let k = (0.82 + (tone - 0.5) * 0.28 + (grain - 0.5) * 0.25 + rings * 0.06 - knot * 0.3 + wear) * (0.35 + 0.65 * gap);
    const nailMix = nail;
    const r = mix(0.62 * k, 0.32, nailMix), g = mix(0.45 * k, 0.31, nailMix), b = mix(0.29 * k, 0.3, nailMix);
    L.set(i, h, r, g, b, mix(0.78, 0.45, nailMix));
  });
};

const timber: Gen = (L) => {
  L.strength = 2.2;
  each((x, y, u, v, i) => {
    const warp = F(2, x, y, 1, 3, 10, 20) * 6;
    const rings = Math.sin((v * 22 + warp) * Math.PI);
    const grain = F(5, x, y, 1, 8, 3, 9);
    const fine = F(5, x, y, 1, 16, 77, 41);
    // Long checks (drying cracks) along the grain.
    const crk = smooth(0.08, 0.0, Math.abs(F(3, x, y, 1, 4, 5, 60) - 0.5)) * smooth(0.55, 0.7, F(1, x, y, 1, 1, 60, 10));
    const h = 0.55 + rings * 0.08 + grain * 0.2 + fine * 0.1 - crk * 0.45;
    const k = 0.75 + rings * 0.08 + (grain - 0.5) * 0.35 + (fine - 0.5) * 0.15 - crk * 0.45;
    L.set(i, h, 0.56 * k, 0.4 * k, 0.27 * k, 0.82);
  });
};

/** Ashlar / brick courses with running bond. */
function masonry(L: Layer, rows: number, perRow: number, mortar: number, base: [number, number, number], seedOff: number, chip = 1) {
  each((x, y, u, v, i) => {
    const row = Math.floor(v * rows);
    const off = (row % 2) * 0.5 + (h2(SEED + seedOff, row, 0) - 0.5) * 0.3;
    const bu = u * perRow + off;
    const col = Math.floor(bu);
    const tx = fract(bu), ty = fract(v * rows);
    const brick = ((col % perRow) + perRow) % perRow + row * 31;
    // Edge distance in meters-ish (tile ≈ 2 m).
    const ex = Math.min(tx, 1 - tx) / perRow, ey = Math.min(ty, 1 - ty) / rows;
    const ed = Math.min(ex, ey) + (F(4, x, y, 1, 1, brick * 13, 0) - 0.5) * 0.006 * chip;
    const inBrick = smooth(mortar * 0.5, mortar, ed);
    const bevel = smooth(mortar, mortar * 2.6, ed);
    const tone = h2(SEED + seedOff + 1, brick, 7);
    const surf = F(4, x, y, 1, 1, brick * 7, brick * 3) * 0.5 + F(5, x, y, 1, 1, 0, brick * 5) * 0.5;
    const chipN = smooth(0.7, 0.85, F(3, x, y, 1, 1, brick * 17, 0)) * chip;
    const h = inBrick * (0.6 + bevel * 0.25 + surf * 0.2 - chipN * 0.15);
    const moss = (1 - inBrick) * smooth(0.55, 0.75, F(1, x, y, 1, 1, 20, 90)) * 0.7;
    const mk = 0.85 + (F(5, x, y, 1, 1, 50, 50) - 0.5) * 0.2;
    const k = 0.8 + (tone - 0.5) * 0.3 + (surf - 0.5) * 0.3 - chipN * 0.1;
    const r = mix(0.74 * mk, base[0] * k, inBrick), g = mix(0.71 * mk, base[1] * k, inBrick), b = mix(0.64 * mk, base[2] * k, inBrick);
    L.set(i, h, mix(r, 0.32, moss), mix(g, 0.4, moss), mix(b, 0.22, moss), mix(0.95, 0.82, inBrick));
  });
}

const stoneBrick: Gen = (L) => {
  L.strength = 3;
  masonry(L, 6, 4, 0.012, [0.78, 0.77, 0.74], 21);
};

/** Irregular Voronoi stones (rubble, cobble). */
function stones(L: Layer, cw: number, ch: number, base: [number, number, number], gapCol: [number, number, number], dome: number, seed: number, mortarW = 0.08, stretch = 1) {
  each((x, y, u, v, i) => {
    const c = worley(seed, u, v, cw, ch, 0.9, stretch);
    const edge = c.f2 - c.f1;
    const inS = smooth(mortarW * 0.5, mortarW, edge);
    const tone = h2(seed + 5, c.id, 3);
    const tint = h2(seed + 6, c.id, 4) - 0.5;
    const surf = F(4, x, y, 1, 1, c.id * 13, 0) * 0.6 + F(5, x, y, 1, 1, 0, c.id * 7) * 0.4;
    const round = Math.sqrt(clamp01(edge * 2.2));
    const h = inS * (0.45 + round * dome + surf * 0.18) + (1 - inS) * F(4, x, y, 1, 1, 9, 9) * 0.15;
    const k = 0.75 + (tone - 0.5) * 0.4 + (surf - 0.5) * 0.25 + round * 0.08;
    const r = mix(gapCol[0], base[0] * k * (1 + tint * 0.15), inS);
    const g = mix(gapCol[1], base[1] * k, inS);
    const b = mix(gapCol[2], base[2] * k * (1 - tint * 0.15), inS);
    L.set(i, h, r, g, b, mix(0.97, 0.78, inS));
  });
}

const rubble: Gen = (L) => {
  L.strength = 3.2;
  stones(L, 7, 9, [0.74, 0.72, 0.68], [0.5, 0.47, 0.41], 0.35, SEED + 31, 0.09, 0.75);
};

const thatch: Gen = (L) => {
  L.strength = 2.8;
  const courses = 5;
  each((x, y, u, v, i) => {
    const course = Math.floor(v * courses);
    const t = fract(v * courses);
    const strands = F(5, x, y, 6, 1, course * 41, 0);
    const strands2 = F(4, x, y, 8, 1, course * 13 + 7, 0);
    const clump = F(3, x, y, 2, 1, course * 29, 0);
    // Each course: thick lower butt end, thinner toward the top where the next course covers it.
    const lay = 1 - t * 0.55;
    const ends = smooth(0.0, 0.05, t) * (0.85 + (strands - 0.5) * 0.4);
    const h = lay * 0.5 + strands * 0.25 + strands2 * 0.15 + clump * 0.1 - (1 - ends) * 0.15;
    const dark = smooth(0.3, 0.0, t) * 0.25; // shadow under the course above
    const k = 0.78 + (strands - 0.5) * 0.45 + (strands2 - 0.5) * 0.25 + (clump - 0.5) * 0.2 - dark;
    const aged = smooth(0.45, 0.8, F(1, x, y, 1, 1, 33, 3)) * 0.35;
    L.set(i, h, mix(0.82, 0.55, aged) * k, mix(0.68, 0.5, aged) * k, mix(0.42, 0.36, aged) * k, 0.96);
  });
};

/** Hashed shift of split point k in a roof row (periodic in k). */
function splitOff(seed: number, row: number, k: number, perRow: number, irregular: number): number {
  return (h2(seed + 3, row, ((k % perRow) + perRow) % perRow) - 0.5) * irregular * 0.5;
}

/** Overlapping roof rows (shingles, slate): rows along u, v up the slope, butt edges at the bottom of each row. */
function roofRows(L: Layer, rows: number, perRow: number, base: [number, number, number], seed: number, gapW: number, irregular: number, rough: number, grain = 0) {
  each((x, y, u, v, i) => {
    const row = Math.floor(v * rows);
    const t = fract(v * rows);
    const off = (row % 2) * 0.5 + (h2(seed, row, 0) - 0.5) * 0.2;
    const bu = u * perRow + off;
    // Variable widths: warp the unit coordinate per row.
    // Variable widths: each split point k is shifted by a hashed e_k (periodic per row → seamless).
    const k0 = Math.floor(bu);
    let s0: number, s1: number, unit: number;
    if (bu < k0 + splitOff(seed, row, k0, perRow, irregular)) {
      unit = k0 - 1;
      s0 = k0 - 1 + splitOff(seed, row, k0 - 1, perRow, irregular);
      s1 = k0 + splitOff(seed, row, k0, perRow, irregular);
    } else {
      unit = k0;
      s0 = k0 + splitOff(seed, row, k0, perRow, irregular);
      s1 = k0 + 1 + splitOff(seed, row, k0 + 1, perRow, irregular);
    }
    const tx = (bu - s0) / (s1 - s0);
    const uid = row * 97 + ((unit % perRow) + perRow) % perRow;
    const edgeJag = (h2(seed + 1, uid, 2) - 0.5) * irregular;
    const bottom = t - edgeJag * 0.3;
    const gap = smooth(0, gapW, Math.min(tx, 1 - tx));
    const lay = 1 - clamp01(bottom) * 0.7;
    const butt = smooth(-0.02, 0.04, bottom);
    const surf = F(5, x, y, 1, 2, uid * 9, 0) * (1 - grain) + F(5, x, y, 4, 1, uid * 9, 0) * grain;
    const h = (lay * 0.7 + surf * 0.15) * gap * (0.4 + 0.6 * butt);
    const tone = h2(seed + 2, uid, 5);
    const shadow = smooth(0.28, 0.0, t) * 0.3;
    const k = (0.82 + (tone - 0.5) * 0.35 + (surf - 0.5) * 0.2 - shadow) * (0.45 + 0.55 * gap);
    const lichen = smooth(0.66, 0.8, F(2, x, y, 1, 1, 70, 31)) * 0.5;
    L.set(i, h, mix(base[0] * k, 0.6, lichen * 0.6), mix(base[1] * k, 0.62, lichen * 0.6), mix(base[2] * k, 0.4, lichen * 0.6), rough);
  });
}

const shingle: Gen = (L) => {
  L.strength = 3;
  roofRows(L, 8, 9, [0.64, 0.58, 0.53], SEED + 41, 0.05, 0.9, 0.86, 0.85);
};

const slate: Gen = (L) => {
  L.strength = 2.6;
  roofRows(L, 10, 7, [0.6, 0.62, 0.64], SEED + 43, 0.03, 0.7, 0.55);
};

const hide: Gen = (L) => {
  L.strength = 1.8;
  each((x, y, u, v, i) => {
    // Panels separated by wobbly stitched seams.
    const su = u * 2 + (F(1, x, y, 1, 1, 0, 0) - 0.5) * 0.12;
    const sv = v * 2 + (F(1, x, y, 1, 1, 60, 0) - 0.5) * 0.12;
    const ex = Math.min(fract(su), 1 - fract(su)), ey = Math.min(fract(sv), 1 - fract(sv));
    const seamD = Math.min(ex, ey);
    const seam = 1 - smooth(0.0, 0.02, seamD);
    const along = ex < ey ? sv : su;
    const stitch = (1 - smooth(0.02, 0.035, Math.abs(seamD - 0.035))) * (fract(along * 40) < 0.5 ? 1 : 0);
    const panel = Math.floor(su) * 3 + Math.floor(sv);
    const tone = h2(SEED + 51, ((panel % 4) + 4) % 4, 0);
    const wrinkle = F(3, x, y, 1, 1, panel * 31, 0);
    const pores = F(5, x, y, 2, 2, 0, 0);
    const spots = smooth(0.6, 0.75, F(2, x, y, 1, 1, panel * 17, 9)) * 0.15;
    const h = 0.6 + wrinkle * 0.3 + pores * 0.08 - seam * 0.3 + stitch * 0.15;
    const k = 0.85 + (tone - 0.5) * 0.25 + (wrinkle - 0.5) * 0.25 - seam * 0.3 - spots;
    L.set(i, h, mix(0.8 * k, 0.35, stitch), mix(0.67 * k, 0.28, stitch), mix(0.5 * k, 0.2, stitch), 0.72);
  });
};

const crystal: Gen = (L) => {
  L.strength = 2.5;
  each((x, y, u, v, i) => {
    const c = worley(SEED + 61, u, v, 5, 4, 0.9, 0.6);
    // Facet: each cell is a tilted plane.
    const gx = h2(SEED + 62, c.id, 0) - 0.5, gy = h2(SEED + 63, c.id, 0) - 0.5;
    const plane = 0.5 + c.dx * gx * 0.9 + c.dy * gy * 0.9;
    const edge = smooth(0.0, 0.022, c.f2 - c.f1);
    const inner = F(3, x, y, 1, 1, c.id * 7, 0);
    const streak = Math.pow(Math.abs(Math.sin((u * 3 + v * 7 + inner) * Math.PI * 2)), 12);
    const h = plane * 0.6 * edge + edge * 0.3;
    const k = 0.78 + (h2(SEED + 64, c.id, 1) - 0.5) * 0.3 + inner * 0.15 + streak * 0.08 - (1 - edge) * 0.2;
    L.set(i, h, 0.86 * k, 0.86 * k, 0.92 * k, 0.18 + (1 - edge) * 0.3);
  });
};

const bark: Gen = (L) => {
  L.strength = 3.4;
  each((x, y, u, v, i) => {
    const warp = (F(2, x, y, 1, 1, 0, 0) - 0.5) * 30;
    const xx = (x + Math.round(warp)) & M;
    const ridgeN = F(1, xx, y, 4, 1, 0, 0);
    const ridge = 1 - Math.abs(ridgeN * 2 - 1);
    const plates = F(2, xx, y, 2, 1, 50, 0);
    const fine = F(5, x, y, 1, 2, 0, 0);
    const h = Math.pow(ridge, 1.3) * 0.7 + plates * 0.2 + fine * 0.06;
    const moss = smooth(0.6, 0.78, F(1, x, y, 1, 1, 10, 80)) * (1 - ridge) * 0.6;
    const k = 0.55 + h * 0.6 + (fine - 0.5) * 0.15;
    L.set(i, h, mix(0.6 * k, 0.32, moss), mix(0.5 * k, 0.42, moss), mix(0.42 * k, 0.2, moss), 0.95);
  });
};

const mushroom: Gen = (L) => {
  L.strength = 1.4;
  each((x, y, u, v, i) => {
    const fib = F(5, x, y, 1, 6, 0, 0);
    const soft = F(2, x, y, 1, 1, 30, 0);
    const c = worley(SEED + 71, u, v, 6, 6, 0.9);
    const spot = (1 - smooth(0.18, 0.3, c.f1)) * (h2(SEED + 72, c.id, 0) > 0.55 ? 1 : 0);
    const h = 0.5 + fib * 0.2 + soft * 0.2 + spot * 0.12;
    const k = 0.9 + (fib - 0.5) * 0.12 + (soft - 0.5) * 0.12;
    L.set(i, h, mix(0.92 * k, 0.98, spot * 0.6), mix(0.89 * k, 0.96, spot * 0.6), mix(0.84 * k, 0.9, spot * 0.6), 0.7 - spot * 0.15);
  });
};

const basalt: Gen = (L) => {
  L.strength = 3;
  each((x, y, u, v, i) => {
    const c = worley(SEED + 81, u, v, 6, 3, 0.55, 1.6);
    const edge = smooth(0.0, 0.06, c.f2 - c.f1);
    const top = h2(SEED + 82, c.id, 0);
    const fine = F(5, x, y, 1, 1, c.id * 11, 0);
    const vesicle = 1 - smooth(0.0, 0.25, F(5, x, y, 2, 2, 0, c.id * 5) - 0.3);
    const h = edge * (0.55 + top * 0.3 + fine * 0.1) - vesicle * 0.06;
    const k = 0.85 + (top - 0.5) * 0.25 + (fine - 0.5) * 0.25 - (1 - edge) * 0.4;
    L.set(i, h, 0.45 * k, 0.44 * k, 0.45 * k, 0.75 + (1 - edge) * 0.2);
  });
};

const turf: Gen = (L) => {
  L.strength = 2.2;
  each((x, y, u, v, i) => {
    const blades = F(5, x, y, 3, 1, 0, 0) * 0.5 + F(5, x, y, 2, 3, 40, 0) * 0.5;
    const clump = F(3, x, y, 1, 1, 0, 0);
    const dirt = smooth(0.62, 0.76, F(2, x, y, 1, 1, 77, 7));
    const flower = h2(SEED + 91, x >> 2, y >> 2) > 0.985 ? 1 : 0;
    const h = blades * 0.6 + clump * 0.3 - dirt * 0.2;
    const k = 0.7 + (blades - 0.5) * 0.6 + (clump - 0.5) * 0.3;
    let r = mix(0.46 * k, 0.48, dirt), g = mix(0.62 * k, 0.38, dirt), b = mix(0.3 * k, 0.26, dirt);
    if (flower) {
      r = 0.95;
      g = 0.9;
      b = 0.55;
    }
    L.set(i, h, r, g, b, 0.95);
  });
};

const metal: Gen = (L) => {
  L.strength = 2;
  each((x, y, u, v, i) => {
    const c = worley(SEED + 101, u, v, 14, 14, 0.8);
    const dent = 1 - clamp01(c.f1 * 1.6);
    // Plates 0.6 m (½ tile) with rivet rows along seams.
    const pu = fract(u * 2), pv = fract(v * 2);
    const sd = Math.min(pu, 1 - pu, pv, 1 - pv);
    const seam = 1 - smooth(0.0, 0.012, sd);
    const along = Math.min(pu, 1 - pu) < Math.min(pv, 1 - pv) ? v : u;
    const rivD = Math.hypot(fract(along * 16) - 0.5, (sd - 0.04) * 16);
    const rivet = 1 - smooth(0.18, 0.28, rivD);
    const rust = smooth(0.6, 0.78, F(2, x, y, 1, 1, 11, 41)) * 0.6 + seam * 0.3;
    const scratch = F(5, x, y, 1, 4, 0, 0);
    const h = 0.6 - dent * 0.15 - seam * 0.25 + rivet * 0.25;
    const k = 0.78 + (scratch - 0.5) * 0.2 + dent * 0.06 + rivet * 0.1;
    L.set(i, h, mix(0.58 * k, 0.5, rust), mix(0.59 * k, 0.3, rust), mix(0.62 * k, 0.18, rust), mix(0.4, 0.85, rust) - rivet * 0.1);
  });
};

const cloth: Gen = (L) => {
  L.strength = 1.6;
  const threads = 64;
  each((x, y, u, v, i) => {
    const tu = u * threads, tv = v * threads;
    const iu = Math.floor(tu), iv = Math.floor(tv);
    const over = (iu + iv) & 1;
    const wu = Math.sin(fract(tu) * Math.PI), wv = Math.sin(fract(tv) * Math.PI);
    const h = over ? wv * 0.6 + wu * 0.2 : wu * 0.6 + wv * 0.2;
    const slub = F(5, x, y, 1, 1, 0, 0);
    const k = 0.82 + h * 0.18 + (slub - 0.5) * 0.12 + (h2(SEED + 111, over ? iv : iu, over) - 0.5) * 0.06;
    L.set(i, h * 0.7 + slub * 0.3, 0.86 * k, 0.84 * k, 0.8 * k, 0.95);
  });
};

const windowL: Gen = (L) => {
  L.strength = 2.5;
  L.ao = 0.5;
  const cols = 3, rows = 4;
  each((x, y, u, v, i) => {
    // Diamond-leaded panes inside a mullion grid.
    const mu = fract(u * cols), mv = fract(v * rows);
    const mullion = 1 - smooth(0.035, 0.055, Math.min(Math.min(mu, 1 - mu), Math.min(mv, 1 - mv)));
    const du = u * cols * 2 + v * rows * 2, dv = u * cols * 2 - v * rows * 2;
    const leadLine = 1 - smooth(0.0, 0.05, 0.5 - Math.max(Math.abs(fract(du) - 0.5), Math.abs(fract(dv) - 0.5)));
    const pane = Math.floor(du) * 7 + Math.floor(dv) * 13;
    const tint = h2(SEED + 121, pane & 63, 0);
    const wav = F(4, x, y, 1, 1, 0, 0);
    const streak = smooth(0.4, 0.6, Math.sin((u + v * 0.6) * Math.PI * 6) * 0.5 + 0.5) * 0.06;
    const glass = 0.24 + (tint - 0.5) * 0.08 + (wav - 0.5) * 0.06 + streak;
    const isMetal = Math.max(mullion, leadLine * 0.95);
    const h = (1 - isMetal) * (0.3 + wav * 0.1) + isMetal * 0.75;
    L.set(i, h, mix(glass * 0.82, 0.07, isMetal), mix(glass * 0.95, 0.065, isMetal), mix(glass * 1.08, 0.06, isMetal), mix(0.12, 0.55, isMetal));
  });
};

const cobble: Gen = (L) => {
  L.strength = 3.4;
  stones(L, 8, 8, [0.7, 0.68, 0.64], [0.36, 0.31, 0.25], 0.5, SEED + 131, 0.1);
};

const soil: Gen = (L) => {
  L.strength = 2.6;
  const furrows = 6;
  each((x, y, u, v, i) => {
    const warp = (F(1, x, y, 1, 1, 0, 0) - 0.5) * 0.08;
    const fr = Math.sin((v + warp) * furrows * Math.PI * 2) * 0.5 + 0.5;
    const clods = F(5, x, y, 1, 1, 0, 0) * 0.6 + F(4, x, y, 1, 1, 0, 0) * 0.4;
    const pebble = smooth(0.78, 0.85, F(5, x, y, 2, 2, 13, 5));
    const h = fr * 0.55 + clods * 0.35 + pebble * 0.15;
    const k = 0.62 + fr * 0.3 + (clods - 0.5) * 0.3;
    L.set(i, h, mix(0.5 * k, 0.6, pebble), mix(0.38 * k, 0.58, pebble), mix(0.27 * k, 0.54, pebble), 0.97);
  });
};

const bone: Gen = (L) => {
  L.strength = 1.6;
  each((x, y, u, v, i) => {
    const c = worley(SEED + 141, u, v, 4, 4, 0.9);
    const crack = (1 - smooth(0.0, 0.02, c.f2 - c.f1)) * (h2(SEED + 142, c.id, 0) > 0.4 ? 1 : 0);
    const pores = smooth(0.62, 0.72, F(5, x, y, 2, 2, 0, 0));
    const lay = F(3, x, y, 1, 3, 0, 0);
    const h = 0.6 + lay * 0.25 - crack * 0.4 - pores * 0.08;
    const k = 0.9 + (lay - 0.5) * 0.15 - crack * 0.4 - pores * 0.12;
    L.set(i, h, 0.9 * k, 0.86 * k, 0.74 * k, 0.6);
  });
};

/** Simple runic glyph strokes in a unit cell (cell coords 0..1). Returns stroke mask. */
function glyph(seed: number, gx: number, gy: number): number {
  let m = 0;
  const strokes = 2 + Math.floor(h2(seed, 0, 0) * 3);
  for (let s = 0; s < strokes; s++) {
    // Endpoints on a 3×3 grid of nodes inside the cell.
    const a = Math.floor(h2(seed, s, 1) * 9), b = Math.floor(h2(seed, s, 2) * 9);
    const ax = 0.2 + (a % 3) * 0.3, ay = 0.15 + Math.floor(a / 3) * 0.35;
    const bx = 0.2 + (b % 3) * 0.3, by = 0.15 + Math.floor(b / 3) * 0.35;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp01(((gx - ax) * dx + (gy - ay) * dy) / l2);
    const d = Math.hypot(gx - ax - dx * t, gy - ay - dy * t);
    m = Math.max(m, 1 - smooth(0.045, 0.08, d));
  }
  return m;
}

const carved: Gen = (L) => {
  L.strength = 3.2;
  // Two courses of large slabs; the upper slab carries a rune band, the lower a knotwork band.
  each((x, y, u, v, i) => {
    const row = Math.floor(v * 2);
    const ty = fract(v * 2);
    const off = row * 0.5;
    const bu = u * 2 + off;
    const tx = fract(bu);
    const slab = Math.floor(bu) + row * 5;
    const ed = Math.min(Math.min(tx, 1 - tx) / 2, Math.min(ty, 1 - ty) / 2);
    const inS = smooth(0.006, 0.012, ed);
    const surf = F(4, x, y, 1, 1, slab * 23, 0);
    let engr = 0;
    // Band borders.
    const bandLo = 0.3, bandHi = 0.7;
    const border = (1 - smooth(0.008, 0.02, Math.abs(ty - bandLo))) + (1 - smooth(0.008, 0.02, Math.abs(ty - bandHi)));
    if (ty > bandLo + 0.03 && ty < bandHi - 0.03) {
      const bv = (ty - bandLo - 0.03) / (bandHi - bandLo - 0.06);
      if (row === 1) {
        const cellsPer = 8;
        const cu = u * cellsPer * 2;
        const cell = Math.floor(cu);
        engr = glyph(SEED + 151 + cell * 31, fract(cu), bv);
      } else {
        // Interlaced knot: two phase-shifted sine ribbons.
        const s1 = Math.abs(bv - 0.5 - 0.32 * Math.sin(u * Math.PI * 16));
        const s2 = Math.abs(bv - 0.5 + 0.32 * Math.sin(u * Math.PI * 16));
        const r1 = 1 - smooth(0.06, 0.1, s1), r2 = 1 - smooth(0.06, 0.1, s2);
        const top = Math.sin(u * Math.PI * 16) > 0 ? 1 : 0;
        engr = Math.max(r1 * (top ? 1 : 1 - r2 * 0.9), r2 * (top ? 1 - r1 * 0.9 : 1)) * 0.9;
      }
    }
    engr = Math.max(engr, Math.min(1, border) * 0.8);
    const h = inS * (0.65 + surf * 0.2 - engr * 0.35);
    const k = (0.82 + (h2(SEED + 152, slab & 31, 0) - 0.5) * 0.2 + (surf - 0.5) * 0.25 - engr * 0.3) * (0.6 + 0.4 * inS);
    L.set(i, h, 0.76 * k, 0.74 * k, 0.7 * k, 0.85);
  });
};

const clayTile: Gen = (L) => {
  L.strength = 3.2;
  const rows = 7, cols = 8;
  each((x, y, u, v, i) => {
    const row = Math.floor(v * rows);
    const t = fract(v * rows);
    const cu = fract(u * cols); // barrel tiles align in columns
    const col = Math.floor(u * cols);
    const profile = Math.cos((cu - 0.5) * Math.PI) ; // rounded barrel
    const under = cu < 0.12 || cu > 0.88 ? 1 : 0;
    const lay = 1 - t * 0.5;
    const butt = smooth(0.0, 0.05, t);
    const id = row * 13 + col;
    const tone = h2(SEED + 161, id, 0);
    const surf = F(5, x, y, 1, 1, id * 5, 0);
    const h = (profile * 0.55 + lay * 0.3 + surf * 0.1) * (0.5 + 0.5 * butt);
    const shade = smooth(0.25, 0.0, t) * 0.3 + under * 0.15;
    const k = 0.8 + (tone - 0.5) * 0.3 + profile * 0.12 + (surf - 0.5) * 0.15 - shade;
    L.set(i, h, 0.74 * k, 0.68 * k, 0.63 * k, 0.8);
  });
};

const straw: Gen = (L) => {
  L.strength = 2.2;
  each((x, y, u, v, i) => {
    const a = F(5, x, y, 6, 1, 0, 0);
    const b = F(5, x, y, 1, 6, 30, 50);
    const c = F(5, x, (x + y) & M, 5, 1, 10, 0);
    const s = Math.max(Math.pow(a, 3), Math.pow(b, 3), Math.pow(c, 3));
    const clump = F(3, x, y, 1, 1, 0, 0);
    const h = s * 0.6 + clump * 0.4;
    const k = 0.6 + s * 0.6 + (clump - 0.5) * 0.2;
    L.set(i, h, 0.86 * k, 0.74 * k, 0.46 * k, 0.95);
  });
};

const marble: Gen = (L) => {
  L.strength = 1.1;
  each((x, y, u, v, i) => {
    const w = F(1, x, y, 1, 1, 0, 0) * 3 + F(3, x, y, 1, 1, 0, 0) * 1.5;
    const vein = Math.pow(1 - Math.abs(Math.sin((u * 2 + v + w) * Math.PI)), 18);
    const vein2 = Math.pow(1 - Math.abs(Math.sin((u - v * 2 + w * 1.3) * Math.PI * 2)), 30) * 0.6;
    // Large slab joints 2×2.
    const ju = fract(u * 2), jv = fract(v * 2);
    const joint = 1 - smooth(0.0, 0.004, Math.min(ju, 1 - ju, jv, 1 - jv));
    const cloud = F(2, x, y, 1, 1, 33, 0);
    const h = 0.7 - joint * 0.4 - vein * 0.03;
    const k = 0.93 + (cloud - 0.5) * 0.08 - vein * 0.35 - vein2 * 0.2 - joint * 0.3;
    L.set(i, h, 0.92 * k, 0.91 * k, 0.88 * k, 0.32 + joint * 0.4);
  });
};

const leaf: Gen = (L) => {
  L.strength = 2.4;
  each((x, y, u, v, i) => {
    const c = worley(SEED + 171, u, v, 12, 12, 0.95);
    // Leaf ellipse oriented per cell.
    const ang = h2(SEED + 172, c.id, 0) * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const lx = c.dx * ca + c.dy * sa, ly = -c.dx * sa + c.dy * ca;
    const e = Math.hypot(lx * 1.0, ly * 2.0);
    const inside = 1 - smooth(0.58, 0.68, e);
    const rib = (1 - smooth(0.0, 0.04, Math.abs(ly))) * inside;
    const tone = h2(SEED + 173, c.id, 1);
    const dome = Math.sqrt(clamp01(1 - e * 1.5));
    const h = inside * (0.5 + dome * 0.4) - rib * 0.08;
    const k = (0.75 + (tone - 0.5) * 0.45 + dome * 0.1 - rib * 0.1) * (0.5 + 0.5 * inside);
    L.set(i, h, 0.56 * k, 0.74 * k, 0.38 * k, 0.75);
  });
};

const glow: Gen = (L) => {
  L.strength = 0.6;
  L.ao = 0.2;
  each((x, y, u, v, i) => {
    const n = F(2, x, y, 1, 1, 0, 0) * 0.6 + F(4, x, y, 1, 1, 0, 0) * 0.4;
    const k = 0.72 + n * 0.28;
    L.set(i, n, k, k, k, 0.5);
  });
};

const rope: Gen = (L) => {
  L.strength = 2.8;
  each((x, y, u, v, i) => {
    const strands = 3;
    const s = fract((u * 2 + v * 4) * strands);
    const prof = Math.sin(s * Math.PI);
    const fib = Math.sin((u * 24 - v * 40) * Math.PI) * 0.5 + 0.5;
    const n = F(5, x, y, 1, 1, 0, 0);
    const h = prof * 0.7 + fib * 0.15 + n * 0.15;
    const k = 0.55 + prof * 0.45 + (n - 0.5) * 0.2;
    L.set(i, h, 0.76 * k, 0.64 * k, 0.44 * k, 0.95);
  });
};

const fire: Gen = (L) => {
  L.strength = 0.8;
  L.ao = 0.1;
  each((x, y, u, v, i) => {
    const f = F(4, x, y, 3, 1, 0, 0) * 0.6 + F(3, x, y, 2, 1, 50, 0) * 0.4;
    const streak = Math.pow(f, 2.2);
    const ember = smooth(0.8, 0.9, F(5, x, y, 1, 1, 9, 9));
    const t = clamp01(streak * 1.6 + ember * 0.5);
    L.set(i, t, mix(0.85, 1, t), mix(0.3, 0.88, t * t), mix(0.06, 0.5, t * t * t), 1);
  });
};

const GENERATORS: Record<number, Gen> = {
  [Surf.Plaster]: plaster,
  [Surf.Planks]: planks,
  [Surf.Timber]: timber,
  [Surf.StoneBrick]: stoneBrick,
  [Surf.Rubble]: rubble,
  [Surf.Thatch]: thatch,
  [Surf.Shingle]: shingle,
  [Surf.Slate]: slate,
  [Surf.Hide]: hide,
  [Surf.Crystal]: crystal,
  [Surf.Bark]: bark,
  [Surf.Mushroom]: mushroom,
  [Surf.Basalt]: basalt,
  [Surf.Turf]: turf,
  [Surf.Metal]: metal,
  [Surf.Cloth]: cloth,
  [Surf.Window]: windowL,
  [Surf.Cobble]: cobble,
  [Surf.Soil]: soil,
  [Surf.Bone]: bone,
  [Surf.Carved]: carved,
  [Surf.ClayTile]: clayTile,
  [Surf.Straw]: straw,
  [Surf.Marble]: marble,
  [Surf.Leaf]: leaf,
  [Surf.Glow]: glow,
  [Surf.Rope]: rope,
  [Surf.Fire]: fire,
};

/** Human-readable layer names (preview/debug). */
export const SURF_NAMES = [
  'Plaster', 'Planks', 'Timber', 'StoneBrick', 'Rubble', 'Thatch', 'Shingle', 'Slate', 'Hide', 'Crystal', 'Bark', 'Mushroom', 'Basalt', 'Turf',
  'Metal', 'Cloth', 'Window', 'Cobble', 'Soil', 'Bone', 'Carved', 'ClayTile', 'Straw', 'Marble', 'Leaf', 'Glow', 'Rope', 'Fire',
];

// ------------------------------------------------------------------ packing

/** sRGB byte → linear lookup (avoids per-pixel pow). */
const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Separable periodic box blur (radius r). */
function blur(src: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(NN), out = new Float32Array(NN);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < N; y++) {
    const row = y << 8;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row | (k & M)];
    for (let x = 0; x < N; x++) {
      tmp[row | x] = s * inv;
      s += src[row | ((x + r + 1) & M)] - src[row | ((x - r) & M)];
    }
  }
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[((k & M) << 8) | x];
    for (let y = 0; y < N; y++) {
      out[(y << 8) | x] = s * inv;
      s += tmp[(((y + r + 1) & M) << 8) | x] - tmp[(((y - r) & M) << 8) | x];
    }
  }
  return out;
}

function packLayer(L: Layer, albedo: Uint8Array, normal: Uint8Array, layer: number, means: Float32Array) {
  const o = layer * NN * 4;
  const h = L.h;
  const avg = blur(h, 5);
  const s = L.strength * 4; // height units per pixel → slope
  let mr = 0, mg = 0, mb = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = (y << 8) | x;
      const xl = (x - 1) & M, xr = (x + 1) & M, yd = (y - 1) & M, yu = (y + 1) & M;
      // Sobel gradients (periodic).
      const tl = h[(yu << 8) | xl], t = h[(yu << 8) | x], tr = h[(yu << 8) | xr];
      const l = h[(y << 8) | xl], r = h[(y << 8) | xr];
      const bl = h[(yd << 8) | xl], b = h[(yd << 8) | x], br = h[(yd << 8) | xr];
      const dx = (tr + 2 * r + br - tl - 2 * l - bl) * 0.125;
      const dy = (tl + 2 * t + tr - bl - 2 * b - br) * 0.125;
      let nx = -dx * s, ny = -dy * s, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const cav = clamp01(1 - Math.max(0, avg[i] - h[i]) * 3.2 * L.ao);
      const p = o + i * 4;
      normal[p] = (nx * 127.5 + 128) | 0;
      normal[p + 1] = (ny * 127.5 + 128) | 0;
      normal[p + 2] = (nz * 127.5 + 128) | 0;
      normal[p + 3] = (cav * 255 + 0.5) | 0;
      const R = (clamp01(L.r[i]) * 255 + 0.5) | 0, G = (clamp01(L.g[i]) * 255 + 0.5) | 0, B = (clamp01(L.b[i]) * 255 + 0.5) | 0;
      albedo[p] = R;
      albedo[p + 1] = G;
      albedo[p + 2] = B;
      albedo[p + 3] = (clamp01(L.rough[i]) * 255 + 0.5) | 0;
      mr += SRGB_LUT[R] * cav;
      mg += SRGB_LUT[G] * cav;
      mb += SRGB_LUT[B] * cav;
    }
  means[layer * 3] = mr / NN;
  means[layer * 3 + 1] = mg / NN;
  means[layer * 3 + 2] = mb / NN;
}

// ------------------------------------------------------------------ public API

interface TextureSet {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  means: Float32Array;
  ms: number;
}

let cached: TextureSet | null = null;
/** Debug: [fields, layer0, layer1, ...] generation times in ms. */
export const layerMs: number[] = [];

function generate(): TextureSet {
  const t0 = performance.now();
  if (!fields) fields = buildFields();
  const albedo = new Uint8Array(NN * 4 * SURF_COUNT);
  const normal = new Uint8Array(NN * 4 * SURF_COUNT);
  const means = new Float32Array(SURF_COUNT * 3);
  const L = new Layer();
  const tf = performance.now();
  layerMs.length = 0;
  layerMs.push(tf - t0);
  for (let s = 0; s < SURF_COUNT; s++) {
    const tl = performance.now();
    L.strength = 2;
    L.ao = 1;
    (GENERATORS[s] ?? plaster)(L);
    packLayer(L, albedo, normal, s, means);
    layerMs.push(performance.now() - tl);
  }
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataArrayTexture(data, N, N, SURF_COUNT);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const set = { albedo: mk(albedo, true), normal: mk(normal, false), means, ms: performance.now() - t0 };
  return set;
}

/** Lazily generated settlement texture arrays (one layer per Surf). */
export function getSettlementTextures(): { albedo: THREE.DataArrayTexture; normal: THREE.DataArrayTexture } {
  if (!cached) cached = generate();
  return cached;
}

/** Mean albedo per layer (linear RGB, AO-weighted), for far-LOD materials. Length SURF_COUNT*3. */
export function layerMeanColors(): Float32Array {
  if (!cached) cached = generate();
  return cached.means;
}

/** Generation time of the texture set in ms (debug). */
export function textureGenMs(): number {
  return cached ? cached.ms : 0;
}

