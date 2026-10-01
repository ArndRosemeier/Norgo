/**
 * Procedural, tileable terrain texture synthesis (runs in a worker).
 * Produces per material an albedo layer (rgb + roughness) and a normal layer
 * (xy normal + height + cavity). Colors come from the world profile, so every
 * world has its own palette of rock, soil, sand and vegetation.
 */
import { MATERIALS, MAT_COUNT, MaterialDef, TexStyle } from './materials';
import type { WorldProfile, RGB } from './profile';
import { clamp, lerp, mixRgb, saturate, smoothstep } from '../core/math';
import { Rng, hash2i, hashToFloat } from '../core/rng';

export const TEX_SIZE = 256;

/** Periodic gradient noise (Perlin) with integer period. */
class PNoise {
  private gx: Float32Array;
  private gy: Float32Array;
  constructor(seed: number, private period: number) {
    this.gx = new Float32Array(period * period);
    this.gy = new Float32Array(period * period);
    const r = new Rng(seed);
    for (let i = 0; i < period * period; i++) {
      const a = r.float() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }
  /** x,y in lattice units; period wraps. */
  n(x: number, y: number): number {
    const P = this.period;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P;
    const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
    const dot = (ix: number, iy: number, dx: number, dy: number) => this.gx[ix + iy * P] * dx + this.gy[ix + iy * P] * dy;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = dot(x0, y0, fx, fy), b = dot(x1, y0, fx - 1, fy);
    const c = dot(x0, y1, fx, fy - 1), d = dot(x1, y1, fx - 1, fy - 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v) * 1.4;
  }
}

/** Fractal periodic noise over [0,1)² with base frequency f (integer). */
function fbm(noises: PNoise[], u: number, v: number, f: number, oct: number, gain = 0.5): number {
  let s = 0, a = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    const fr = f << o;
    s += noises[o % noises.length].n(u * fr, v * fr) * a;
    n += a;
    a *= gain;
  }
  return s / n;
}

/** Periodic Worley over [0,1)² with `cells` cells per axis. Returns [f1, f2, id]. */
function worley(seed: number, u: number, v: number, cells: number, jitter = 0.9): [number, number, number] {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
      const h = hash2i(seed, wx, wy);
      const px = cx + 0.5 + (hashToFloat(h) - 0.5) * jitter;
      const py = cy + 0.5 + (hashToFloat(Math.imul(h, 747796405) + 1) - 0.5) * jitter;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
      } else if (d < f2) f2 = d;
    }
  return [f1, f2, id];
}

export interface MaterialColors {
  color: RGB;
  color2: RGB;
}

/** Apply world palette tints to material base colors. */
export function materialColors(def: MaterialDef, p: WorldProfile): MaterialColors {
  let c = def.color, c2 = def.color2;
  const tintWith = (base: RGB, tint: RGB, amt: number): RGB => {
    // Preserve luminance of base, take chroma from tint.
    const lb = 0.3 * base[0] + 0.59 * base[1] + 0.11 * base[2];
    const lt = 0.3 * tint[0] + 0.59 * tint[1] + 0.11 * tint[2] || 1;
    const t: RGB = [tint[0] * (lb / lt), tint[1] * (lb / lt), tint[2] * (lb / lt)];
    return mixRgb(base, t, amt);
  };
  switch (def.tint) {
    case 'foliage':
      c = tintWith(c, p.foliage, 0.9);
      c2 = tintWith(c2, p.foliageDry, 0.85);
      break;
    case 'rock':
      c = tintWith(c, p.rockTint, 0.6);
      c2 = tintWith(c2, p.rockTint, 0.5);
      break;
    case 'sand':
      c = tintWith(c, p.sandTint, 0.75);
      c2 = tintWith(c2, p.sandTint, 0.6);
      break;
    case 'soil':
      c = tintWith(c, p.soilTint, 0.5);
      c2 = tintWith(c2, p.soilTint, 0.4);
      break;
    case 'crystal':
      c = tintWith(c, p.crystalTint, 0.9);
      c2 = tintWith(c2, p.crystalTint, 0.9);
      break;
    case 'fungal':
      c = tintWith(c, p.fungalTint, 0.85);
      c2 = tintWith(c2, p.fungalTint, 0.7);
      break;
  }
  return { color: c as RGB, color2: c2 as RGB };
}

interface Px {
  /** albedo rgb 0..1 */
  r: number;
  g: number;
  b: number;
  rough: number;
  height: number;
  /** emissive mask 0..1 */
  emit: number;
}

type Painter = (u: number, v: number, out: Px) => void;

function makePainter(style: TexStyle, seed: number, c1: RGB, c2: RGB, def: MaterialDef): Painter {
  const ns = [0, 1, 2, 3, 4, 5].map((i) => new PNoise(seed + i * 101, 64));
  const set = (out: Px, col: RGB, rough: number, height: number, emit = 0) => {
    out.r = col[0]; out.g = col[1]; out.b = col[2]; out.rough = rough; out.height = height; out.emit = emit;
  };
  const mix = (t: number) => mixRgb(c1, c2, saturate(t));
  const vary = (col: RGB, n: number, amt: number): RGB => [col[0] * (1 + n * amt), col[1] * (1 + n * amt), col[2] * (1 + n * amt)];
  switch (style) {
    case 'rock':
      return (u, v, o) => {
        const big = fbm(ns, u, v, 3, 5);
        const [f1, f2] = worley(seed, u, v, 6);
        const crack = smoothstep(0.0, 0.06, f2 - f1);
        const grain = fbm(ns, u, v, 32, 2);
        const h = big * 0.5 + 0.5 - (1 - crack) * 0.35 + grain * 0.08;
        set(o, vary(mix(0.5 + big * 0.8), grain * 0.6 - (1 - crack) * 0.8, 0.25), 0.85 - big * 0.1, h);
      };
    case 'strata':
      return (u, v, o) => {
        const warp = fbm(ns, u, v, 2, 3) * 0.06;
        const band = Math.sin((v + warp) * Math.PI * 2 * 7) * 0.5 + 0.5;
        const fine = Math.sin((v + warp * 2) * Math.PI * 2 * 23) * 0.5 + 0.5;
        const grain = fbm(ns, u, v, 24, 3);
        const t = band * 0.7 + fine * 0.2 + grain * 0.3;
        set(o, vary(mix(t), grain, 0.15), 0.9, t * 0.6 + grain * 0.2);
      };
    case 'soil':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 8, 4);
        const pebbles = worley(seed, u, v, 22);
        const peb = smoothstep(0.32, 0.18, pebbles[0]) * (hashToFloat(pebbles[2]) > 0.6 ? 1 : 0);
        const col = peb > 0 ? mixRgb(mix(n + 0.5), [0.45, 0.43, 0.4], 0.6) : mix(0.5 + n);
        set(o, vary(col, fbm(ns, u, v, 32, 2), 0.2), 0.95, 0.4 + n * 0.3 + peb * 0.4);
      };
    case 'grass':
      return (u, v, o) => {
        const patches = fbm(ns, u, v, 4, 3);
        const blade = fbm(ns, u, v * 0.4, 48, 2);
        const dirt = smoothstep(0.25, 0.45, -patches + fbm(ns, u, v, 16, 2) * 0.3);
        let col = mix(0.4 + patches * 0.9 + blade * 0.5);
        col = mixRgb(col, [0.3, 0.23, 0.16], dirt * 0.7);
        set(o, vary(col, blade, 0.25), 0.95, 0.5 + blade * 0.35 - dirt * 0.2);
      };
    case 'sand':
      return (u, v, o) => {
        const ripple = Math.sin((u * 18 + fbm(ns, u, v, 3, 3) * 2.5) * Math.PI * 2) * 0.5 + 0.5;
        const grain = (hashToFloat(hash2i(seed, Math.floor(u * 256), Math.floor(v * 256))) - 0.5);
        const n = fbm(ns, u, v, 4, 3);
        set(o, vary(mix(0.5 + n * 0.8 + ripple * 0.2), grain, 0.12), 0.95, ripple * 0.5 + n * 0.2);
      };
    case 'snow':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 4, 4);
        const sparkle = hashToFloat(hash2i(seed, Math.floor(u * 256), Math.floor(v * 256))) > 0.985 ? 1 : 0;
        set(o, vary(mix(0.5 + n * 0.6), sparkle * 0.5, 0.2), 0.75 - sparkle * 0.5, 0.5 + n * 0.4);
      };
    case 'ice':
      return (u, v, o) => {
        const [f1, f2] = worley(seed, u, v, 5);
        const crack = 1 - smoothstep(0, 0.03, f2 - f1);
        const n = fbm(ns, u, v, 3, 4);
        set(o, vary(mix(0.5 + n + crack * 0.6), 0, 0), 0.1 + crack * 0.4, 0.6 - crack * 0.4 + n * 0.1);
      };
    case 'gravel':
      return (u, v, o) => {
        const [f1, f2, id] = worley(seed, u, v, 26, 1);
        const stone = smoothstep(0.45, 0.25, f1);
        const tone = hashToFloat(id);
        const col = mixRgb(mix(tone), [0.2, 0.18, 0.16], 1 - stone * 0.85);
        set(o, vary(col, fbm(ns, u, v, 32, 2), 0.15), 0.9, stone * (0.6 + tone * 0.4));
      };
    case 'mud':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 5, 4);
        const wet = smoothstep(0.05, 0.3, n);
        set(o, vary(mix(0.5 + n), fbm(ns, u, v, 24, 2), 0.15), lerp(0.85, 0.25, wet), 0.5 - wet * 0.3 + n * 0.2);
      };
    case 'moss':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 6, 5);
        const clump = worley(seed, u, v, 14);
        const bump = smoothstep(0.6, 0.0, clump[0]);
        const spots = def.emissive > 0 ? smoothstep(0.12, 0.04, worley(seed + 7, u, v, 18)[0]) * (hashToFloat(worley(seed + 7, u, v, 18)[2]) > 0.55 ? 1 : 0) : 0;
        set(o, vary(mix(0.4 + n + bump * 0.4), fbm(ns, u, v, 40, 2), 0.3), 0.95, bump * 0.6 + n * 0.3, spots);
      };
    case 'crystal':
      return (u, v, o) => {
        const [f1, f2, id] = worley(seed, u, v, 7, 1);
        const facet = hashToFloat(id);
        const edge = 1 - smoothstep(0, 0.05, f2 - f1);
        const glow = smoothstep(0.5, 0.0, f1) * 0.8;
        set(o, vary(mix(facet * 0.8 + edge * 0.5), 0, 0), 0.15 + edge * 0.3, facet * 0.7 + (1 - edge) * 0.3, glow);
      };
    case 'glass':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 3, 4);
        const [f1, f2] = worley(seed, u, v, 4);
        const ridge = 1 - smoothstep(0, 0.08, f2 - f1);
        set(o, mix(n * 0.5 + 0.5 + ridge * 0.4), 0.08 + ridge * 0.3, 0.5 + n * 0.3 - ridge * 0.2);
      };
    case 'cobble':
      return (u, v, o) => {
        const [f1, f2, id] = worley(seed, u, v, 9, 0.75);
        const mortar = 1 - smoothstep(0.02, 0.09, f2 - f1);
        const tone = hashToFloat(id);
        const n = fbm(ns, u, v, 32, 3);
        const col = mortar > 0.5 ? mixRgb(c2, [0.25, 0.22, 0.2], 0.5) : mix(tone * 0.7 + n * 0.3);
        set(o, vary(col, n, 0.2), 0.8, (1 - mortar) * (0.7 - f1 * 0.4) + n * 0.05);
      };
    case 'salt':
      return (u, v, o) => {
        const [f1, f2] = worley(seed, u, v, 5, 0.8);
        const ridge = 1 - smoothstep(0, 0.04, f2 - f1);
        const n = fbm(ns, u, v, 16, 3);
        set(o, vary(mix(0.3 + n * 0.5 - ridge * 0.4), 0, 0), 0.7, 0.4 + ridge * 0.5 + n * 0.1);
      };
    case 'magma':
      return (u, v, o) => {
        const [f1, f2] = worley(seed, u, v, 6, 0.9);
        const crack = 1 - smoothstep(0.0, 0.1, f2 - f1);
        const n = fbm(ns, u, v, 8, 3);
        const hot = saturate(crack * 1.2 + n * 0.2);
        const col = mixRgb(c1, c2, hot);
        set(o, col, 0.9 - hot * 0.5, (1 - crack) * 0.7 + n * 0.1, hot);
      };
    case 'ore':
      return (u, v, o) => {
        const big = fbm(ns, u, v, 3, 4);
        const [f1] = worley(seed, u, v, 12);
        const fleck = smoothstep(0.22, 0.08, f1) * (fbm(ns, u, v, 6, 2) > 0 ? 1 : 0);
        const col = fleck > 0.2 ? c2 : mixRgb(c1, [c1[0] * 0.6, c1[1] * 0.6, c1[2] * 0.6], 0.5 - big);
        set(o, col, fleck > 0.2 ? 0.35 : 0.85, 0.4 + big * 0.3 + fleck * 0.3, def.emissive > 0 ? fleck : 0);
      };
    case 'litter':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 6, 4);
        const [f1, , id] = worley(seed, u, v, 20, 1);
        const leaf = smoothstep(0.35, 0.2, f1);
        const tone = hashToFloat(id);
        const leafCol: RGB = tone > 0.66 ? [0.45, 0.3, 0.12] : tone > 0.33 ? [0.35, 0.26, 0.12] : [0.3, 0.32, 0.12];
        const col = leaf > 0.3 ? mixRgb(mix(n + 0.5), leafCol, 0.6) : mix(0.5 + n);
        set(o, vary(col, fbm(ns, u, v, 40, 2), 0.2), 0.92, 0.4 + leaf * 0.4 + n * 0.2);
      };
    case 'ash':
      return (u, v, o) => {
        const n = fbm(ns, u, v, 6, 5);
        const ember = hashToFloat(hash2i(seed, Math.floor(u * 128), Math.floor(v * 128))) > 0.997 ? 1 : 0;
        set(o, vary(mix(0.5 + n), 0, 0), 0.98, 0.4 + n * 0.4, ember);
      };
    case 'marble':
      return (u, v, o) => {
        const w = fbm(ns, u, v, 3, 5);
        const vein = 1 - smoothstep(0.0, 0.05, Math.abs(Math.sin((u + w * 0.6) * Math.PI * 4)) * 0.2);
        set(o, mix(vein * 0.9 + w * 0.2), 0.35, 0.5 + w * 0.1);
      };
  }
}

export interface TerrainTextureData {
  size: number;
  layers: number;
  /** RGBA8: rgb albedo (sRGB), a roughness */
  albedo: Uint8Array;
  /** RGBA8: rg normal xy (0.5 centred), b height, a emissive mask */
  normal: Uint8Array;
}

export function synthesizeTerrainTextures(profile: WorldProfile, size = TEX_SIZE): TerrainTextureData {
  const layers = MAT_COUNT;
  const albedo = new Uint8Array(size * size * 4 * layers);
  const normal = new Uint8Array(size * size * 4 * layers);
  const heights = new Float32Array(size * size);
  const emits = new Float32Array(size * size);
  const px: Px = { r: 0, g: 0, b: 0, rough: 0, height: 0, emit: 0 };
  for (let m = 0; m < layers; m++) {
    const def = MATERIALS[m];
    const { color, color2 } = materialColors(def, profile);
    const painter = makePainter(def.style, (profile.seed ^ (m * 7919)) >>> 0, color, color2, def);
    const base = m * size * size * 4;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        painter(x / size, y / size, px);
        const i = base + (x + y * size) * 4;
        albedo[i] = clamp(Math.round(px.r * 255), 0, 255);
        albedo[i + 1] = clamp(Math.round(px.g * 255), 0, 255);
        albedo[i + 2] = clamp(Math.round(px.b * 255), 0, 255);
        albedo[i + 3] = clamp(Math.round(px.rough * 255), 0, 255);
        heights[x + y * size] = px.height;
        emits[x + y * size] = px.emit;
      }
    // Normal from height (wrapping).
    const strength = def.style === 'sand' || def.style === 'snow' ? 1.5 : def.style === 'ice' || def.style === 'glass' ? 1.2 : 3.0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const hl = heights[((x - 1 + size) % size) + y * size], hr = heights[((x + 1) % size) + y * size];
        const hd = heights[x + ((y - 1 + size) % size) * size], hu = heights[x + ((y + 1) % size) * size];
        let nx = (hl - hr) * strength, ny = (hd - hu) * strength;
        const nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        const i = base + (x + y * size) * 4;
        normal[i] = Math.round((nx * 0.5 + 0.5) * 255);
        normal[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normal[i + 2] = clamp(Math.round(heights[x + y * size] * 255), 0, 255);
        normal[i + 3] = clamp(Math.round(emits[x + y * size] * 255), 0, 255);
      }
  }
  return { size, layers, albedo, normal };
}
