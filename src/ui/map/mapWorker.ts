/**
 * Map worker: rasterizes world regions from the deterministic WorldGenerator
 * (biomes, hillshaded heights, water, rivers, snow, roads, settlements) into
 * ImageBitmaps. Used by the world map, minimap and the main-menu world preview.
 *
 * Protocol:
 *   → { type:'init', seed }                       ← { type:'ready' }
 *   → { type:'job', id, layer, x0, z0, mpp, w, h } ← { type:'done', id, bitmap }
 * `layer` is 'surface' or 'under' (the underworld cavern band).
 */
import { WorldGenerator, Column } from '../../world/generator';
import { SEA_LEVEL, UNDERWORLD_SEA_LEVEL } from '../../world/constants';
import { Biome } from '../../world/biomes';
import { buildPalette, type MapPalette } from './palette';

export interface MapJob {
  type: 'job';
  id: number;
  layer: 'surface' | 'under';
  x0: number;
  z0: number;
  mpp: number;
  w: number;
  h: number;
}

let gen: WorldGenerator | null = null;
let pal: MapPalette | null = null;
const col = new Column();
const scope = self as unknown as Worker;

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    gen = new WorldGenerator(msg.seed as number);
    pal = buildPalette(gen.profile);
    scope.postMessage({ type: 'ready' });
  } else if (msg.type === 'job') {
    const job = msg as MapJob;
    const data = job.layer === 'under' ? renderUnder(job) : renderSurface(job);
    createImageBitmap(new ImageData(data, job.w, job.h)).then((bitmap) => {
      scope.postMessage({ type: 'done', id: job.id, bitmap }, [bitmap]);
    });
  }
};

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Surface: sample a (w+2)×(h+2) grid so hillshade has neighbours at tile borders. */
function renderSurface(job: MapJob): Uint8ClampedArray<ArrayBuffer> {
  const g = gen!, P = pal!;
  const { w, h, mpp } = job;
  const W = w + 2, H = h + 2;
  const heights = new Float32Array(W * H);
  const out = new Uint8ClampedArray(w * h * 4);
  // Fine zoom: include settlement/road shaping; coarse zoom skips it (sub-pixel anyway, drawn as vectors).
  const withSites = mpp <= 4;
  const rgb = new Float32Array(w * h * 3);
  const water = new Uint8Array(w * h);
  const depth = new Float32Array(w * h);
  for (let j = 0; j < H; j++) {
    const z = job.z0 + (j - 0.5) * mpp;
    for (let i = 0; i < W; i++) {
      const x = job.x0 + (i - 0.5) * mpp;
      const inner = i > 0 && j > 0 && i <= w && j <= h;
      g.column(x, z, col, withSites && inner, false);
      heights[j * W + i] = col.height;
      if (!inner) continue;
      const o = (j - 1) * w + (i - 1);
      const b1 = col.biome * 3, b2 = col.biome2 * 3, t = col.biome === Biome.Ocean ? 0 : col.blend;
      let r = P.biome[b1] + (P.biome[b2] - P.biome[b1]) * t;
      let gg = P.biome[b1 + 1] + (P.biome[b2 + 1] - P.biome[b1 + 1]) * t;
      let b = P.biome[b1 + 2] + (P.biome[b2 + 2] - P.biome[b1 + 2]) * t;
      // Rocky highlands.
      const rk = smooth(0.25, 0.9, col.rock);
      r += (P.rock[0] - r) * rk; gg += (P.rock[1] - gg) * rk; b += (P.rock[2] - b) * rk;
      // Snow caps.
      const sn = smooth(col.snowLine - 10, col.snowLine + 25, col.height);
      r += (P.snow[0] - r) * sn; gg += (P.snow[1] - gg) * sn; b += (P.snow[2] - b) * sn;
      // Settlement grounds & roads.
      if (col.site > 0.3) {
        const k = smooth(0.3, 0.9, col.site) * 0.45;
        r += (P.paving[0] - r) * k; gg += (P.paving[1] - gg) * k; b += (P.paving[2] - b) * k;
      }
      if (col.road > 0.2) {
        const k = smooth(0.2, 0.7, col.road) * 0.85;
        r += (P.road[0] - r) * k; gg += (P.road[1] - gg) * k; b += (P.road[2] - b) * k;
      }
      const isWater = col.height < SEA_LEVEL - 0.15 || (col.river > 0.45 && col.height < SEA_LEVEL + 0.5);
      if (isWater) {
        water[o] = 1;
        depth[o] = SEA_LEVEL - col.height;
      } else if (col.height < SEA_LEVEL + 1.2 && col.land < 0.95) {
        // Beach band.
        const k = 0.55;
        r += (P.shore[0] - r) * k; gg += (P.shore[1] - gg) * k; b += (P.shore[2] - b) * k;
      }
      rgb[o * 3] = r; rgb[o * 3 + 1] = gg; rgb[o * 3 + 2] = b;
    }
  }
  // Shading pass: hillshade (light from north-west), contour lines, water depth.
  const zScale = 1 / Math.max(1, mpp);
  const contour = mpp <= 8 ? (mpp <= 2 ? 10 : 40) : 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = j * w + i;
      const c = (j + 1) * W + (i + 1);
      let r = rgb[o * 3], gg = rgb[o * 3 + 1], b = rgb[o * 3 + 2];
      if (water[o]) {
        const d = smooth(0, 70, depth[o]);
        r = P.water[0] + (P.deep[0] - P.water[0]) * d;
        gg = P.water[1] + (P.deep[1] - P.water[1]) * d;
        b = P.water[2] + (P.deep[2] - P.water[2]) * d;
        // Shoreline glint.
        const nearLand = !water[o - 1 >= 0 ? o - 1 : o] || !water[o + 1 < w * h ? o + 1 : o] || (j > 0 && !water[o - w]) || (j < h - 1 && !water[o + w]);
        if (nearLand && i > 0 && i < w - 1) { r = r * 0.6 + 0.4 * 0.85; gg = gg * 0.6 + 0.4 * 0.9; b = b * 0.6 + 0.4 * 0.92; }
      } else {
        const dx = heights[c + 1] - heights[c - 1];
        const dz = heights[c + W] - heights[c - W];
        // Light from NW and above: positive when slope faces the light.
        const s = (-dx - dz) * 0.5 * zScale;
        const shade = Math.max(0.45, Math.min(1.45, 1 + s * 0.9));
        r *= shade; gg *= shade; b *= shade;
        if (contour) {
          const a = Math.floor(heights[c] / contour), n1 = Math.floor(heights[c + 1] / contour), n2 = Math.floor(heights[c + W] / contour);
          if (a !== n1 || a !== n2) { r *= 0.82; gg *= 0.8; b *= 0.76; }
        }
      }
      const p = o * 4;
      out[p] = r * 255; out[p + 1] = gg * 255; out[p + 2] = b * 255; out[p + 3] = 255;
    }
  }
  return out;
}

/** Underworld band: open cavern floors colored by underworld biome; solid rock dark. */
function renderUnder(job: MapJob): Uint8ClampedArray<ArrayBuffer> {
  const g = gen!, P = pal!;
  const { w, h, mpp } = job;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const z = job.z0 + (j + 0.5) * mpp;
    for (let i = 0; i < w; i++) {
      const x = job.x0 + (i + 0.5) * mpp;
      g.column(x, z, col, false, true);
      const open = col.uwCeil - col.uwFloor;
      let r: number, gg: number, b: number;
      if (open > 1) {
        const bi = col.uwBiome * 3;
        r = P.biome[bi]; gg = P.biome[bi + 1]; b = P.biome[bi + 2];
        if (col.uwFloor < UNDERWORLD_SEA_LEVEL) { r = P.deep[0] * 1.4; gg = P.deep[1] * 1.4; b = P.deep[2] * 1.6; }
        const k = 0.55 + 0.45 * smooth(1, 40, open);
        r *= k; gg *= k; b *= k;
      } else {
        r = P.cave[0]; gg = P.cave[1]; b = P.cave[2];
      }
      const p = (j * w + i) * 4;
      out[p] = r * 255; out[p + 1] = gg * 255; out[p + 2] = b * 255; out[p + 3] = 255;
    }
  }
  return out;
}
