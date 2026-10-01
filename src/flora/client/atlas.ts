/**
 * Procedural flora texture atlas (per world).
 *
 * One 2048×1024 RGBA atlas (8×4 cells of 256 px) holds every bark, leaf
 * cluster, petal, moss, cap, crystal… texture used by all flora. Channels are
 * *data*, not color, so a single texture serves every species:
 *   R = luminance / detail (multiplies the vertex color)
 *   G = mask selecting the secondary vertex color (veins, spots, birch marks, dry tips)
 *   B = emissive mask (glowing spots, ember cracks, crystal cores)
 *   A = coverage (alpha-tested cut-outs)
 *
 * Shapes vary per world (leaf width, serration, needle density…), drawn with
 * Canvas2D from a seeded RNG, then RGB is dilated into transparent texels so
 * mipmaps never bleed black fringes.
 */
import * as THREE from 'three';
import { Rng } from '../../core/rng';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;
export const CELL_PX = 256;

/** Atlas cell indices. */
export const enum Cell {
  BarkRough = 0, BarkSmooth, BarkBirch, BarkPlates, BarkRings, BarkFibrous, BarkEmber, BarkAlien,
  LeafBroad, LeafNeedle, LeafLobed, LeafSmall, LeafWillow, LeafFrond, LeafFern, LeafBlade,
  LeafHeart, Petal, FlowerHead, Moss, Lichen, Cap, Gills, Cactus,
  Crystal, Bone, Kelp, Plain, Spray, VineLeaf, Stem, Grass,
}

type Ctx = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function rgba(l: number, m: number, g: number, a = 1): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgba(${c(l)},${c(m)},${c(g)},${a})`;
}

// ------------------------------------------------------------------ periodic value noise (tileable bark)

class TileNoise {
  private v: Float32Array;
  constructor(rng: Rng, private p: number) {
    this.v = new Float32Array(p * p);
    for (let i = 0; i < this.v.length; i++) this.v[i] = rng.float();
  }
  /** x,y in [0,1) tile space, freq = lattice cells over the tile (must divide period). */
  at(x: number, y: number, fx: number, fy: number): number {
    const px = x * fx, py = y * fy;
    const ix = Math.floor(px), iy = Math.floor(py);
    const tx = px - ix, ty = py - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const mx = fx, my = fy;
    const g = (i: number, j: number) => this.v[(((i % mx) + mx) % mx) % this.p + ((((j % my) + my) % my) % this.p) * this.p];
    const a = g(ix, iy), b = g(ix + 1, iy), c = g(ix, iy + 1), d = g(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  fbm(x: number, y: number, fx: number, fy: number, oct: number): number {
    let s = 0, a = 1, n = 0;
    for (let o = 0; o < oct; o++) {
      s += this.at(x, y, fx << o, fy << o) * a;
      n += a;
      a *= 0.5;
    }
    return s / n;
  }
}

/** Per-pixel cell painter (RGBA 0..1). */
function paintPixels(ctx: Ctx, fn: (u: number, v: number, out: number[]) => void) {
  const img = ctx.createImageData(CELL_PX, CELL_PX);
  const out = [0, 0, 0, 1];
  for (let y = 0; y < CELL_PX; y++)
    for (let x = 0; x < CELL_PX; x++) {
      out[0] = out[1] = out[2] = 0;
      out[3] = 1;
      // v = 0 at the bottom of the cell (matches geometry uv).
      fn(x / CELL_PX, 1 - y / CELL_PX, out);
      const o = (x + y * CELL_PX) * 4;
      img.data[o] = Math.max(0, Math.min(255, out[0] * 255));
      img.data[o + 1] = Math.max(0, Math.min(255, out[1] * 255));
      img.data[o + 2] = Math.max(0, Math.min(255, out[2] * 255));
      img.data[o + 3] = Math.max(0, Math.min(255, out[3] * 255));
    }
  ctx.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ vector shapes

/** Leaf outline: base at (0,0), tip at (0,-len) in local coords (canvas y down). */
function leafPath(ctx: Ctx, len: number, wid: number, shape: { tip: number; serr: number; lobes: number; round: number }, rng: Rng) {
  const pts: [number, number][] = [];
  const n = 18;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i <= n; i++) {
      const t = side < 0 ? i / n : 1 - i / n;
      // Width profile: round base, pointed tip.
      let w = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75 + shape.round * 0.5)), 0.6 + shape.tip) * wid;
      if (shape.lobes > 0) w *= 0.65 + 0.35 * Math.abs(Math.sin(t * Math.PI * shape.lobes));
      if (shape.serr > 0 && i % 2 === 0) w *= 1 + shape.serr * 0.25 * (rng.float() * 0.5 + 0.5);
      pts.push([side * w, -t * len]);
    }
  }
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.closePath();
}

function drawLeaf(ctx: Ctx, x: number, y: number, ang: number, len: number, wid: number, shape: { tip: number; serr: number; lobes: number; round: number }, rng: Rng, mask: number, veinDark: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  leafPath(ctx, len, wid, shape, rng);
  const l = 0.78 + rng.float() * 0.22;
  const grad = ctx.createLinearGradient(-wid, 0, wid, 0);
  grad.addColorStop(0, rgba(l * 0.82, mask, 0));
  grad.addColorStop(0.5, rgba(l, mask, 0));
  grad.addColorStop(1, rgba(l * 0.86, mask, 0));
  ctx.fillStyle = grad;
  ctx.fill();
  // Midrib and side veins.
  ctx.strokeStyle = rgba(l * (1 - veinDark), mask, 0);
  ctx.lineWidth = Math.max(0.8, wid * 0.07);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.92);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.5, wid * 0.035);
  const nv = Math.max(3, Math.round(len / (wid * 0.6)));
  for (let i = 1; i < nv; i++) {
    const t = i / nv;
    ctx.beginPath();
    ctx.moveTo(0, -len * t);
    ctx.lineTo(-wid * 0.7 * Math.sin(Math.PI * t), -len * (t + 0.12));
    ctx.moveTo(0, -len * t);
    ctx.lineTo(wid * 0.7 * Math.sin(Math.PI * t), -len * (t + 0.12));
    ctx.stroke();
  }
  ctx.restore();
}

function twig(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, l = 0.45) {
  ctx.strokeStyle = rgba(l, 0, 0);
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo((x0 + x1) / 2 + (y1 - y0) * 0.08, (y0 + y1) / 2, x1, y1);
  ctx.stroke();
}

// ------------------------------------------------------------------ cell painters

interface AtlasStyle {
  leafWid: number;
  tip: number;
  serr: number;
  round: number;
  lobes: number;
  leafCount: number;
  needleLen: number;
  vein: number;
}

function paintCell(cell: Cell, ctx: Ctx, rng: Rng, st: AtlasStyle) {
  const S = CELL_PX;
  const noise = new TileNoise(rng.fork('noise'), 64);
  ctx.clearRect(0, 0, S, S);
  switch (cell) {
    // ------------------------------------------------------------------ barks (opaque, tileable)
    case Cell.BarkRough:
      paintPixels(ctx, (u, v, o) => {
        const ridge = 1 - Math.abs(noise.fbm(u, v, 8, 2, 3) * 2 - 1);
        const fine = noise.fbm(u + 0.37, v + 0.11, 16, 8, 2);
        o[0] = 0.35 + Math.pow(ridge, 1.6) * 0.55 + (fine - 0.5) * 0.2;
        o[1] = noise.fbm(u + 0.5, v + 0.3, 4, 2, 3) > 0.7 ? 1 : 0;
      });
      break;
    case Cell.BarkSmooth:
      paintPixels(ctx, (u, v, o) => {
        const n = noise.fbm(u, v, 4, 8, 3);
        const len = Math.max(0, noise.at(u, v, 32, 64) - 0.82) * 4;
        o[0] = 0.72 + (n - 0.5) * 0.25 - len * 0.4;
        o[1] = noise.fbm(u + 0.2, v, 2, 4, 3) > 0.66 ? 1 : 0;
      });
      break;
    case Cell.BarkBirch:
      paintPixels(ctx, (u, v, o) => {
        const n = noise.fbm(u, v, 4, 4, 3);
        // Horizontal dark lenticel dashes and blotches → mask selects the dark color B.
        const dash = noise.at(u, v, 8, 64) > 0.8 && noise.at(u + 0.5, v, 16, 64) > 0.45 ? 1 : 0;
        const blot = noise.fbm(u + 0.3, v + 0.7, 4, 6, 3) > 0.68 ? 1 : 0;
        o[0] = 0.85 + (n - 0.5) * 0.18;
        o[1] = Math.max(dash, blot);
      });
      break;
    case Cell.BarkPlates: {
      // Voronoi plates (pine), tile-periodic.
      const P = 10;
      const pts: [number, number][] = [];
      for (let i = 0; i < P * 2; i++) pts.push([rng.float(), rng.float()]);
      paintPixels(ctx, (u, v, o) => {
        let d1 = 9, d2 = 9, id = 0;
        for (let i = 0; i < pts.length; i++)
          for (let ox = -1; ox <= 1; ox++)
            for (let oy = -1; oy <= 1; oy++) {
              const dx = (pts[i][0] + ox - u) * 1.0, dy = (pts[i][1] + oy - v) * 0.45;
              const d = dx * dx + dy * dy;
              if (d < d1) {
                d2 = d1;
                d1 = d;
                id = i;
              } else if (d < d2) d2 = d;
            }
        const edge = Math.sqrt(d2) - Math.sqrt(d1);
        const crack = edge < 0.025 ? 0.25 : 1;
        o[0] = (0.55 + (id % 5) * 0.06 + (noise.at(u, v, 32, 32) - 0.5) * 0.2) * crack;
        o[1] = id % 3 === 0 ? 1 : 0;
      });
      break;
    }
    case Cell.BarkRings:
      paintPixels(ctx, (u, v, o) => {
        const band = (v * 4) % 1;
        const ring = Math.exp(-Math.pow((band - 0.05) / 0.035, 2));
        const fiber = noise.at(u, v, 64, 8);
        o[0] = 0.62 + (fiber - 0.5) * 0.25 - ring * 0.35 + band * 0.12;
        o[1] = ring > 0.4 ? 1 : 0;
      });
      break;
    case Cell.BarkFibrous:
      paintPixels(ctx, (u, v, o) => {
        const streak = noise.at(u, v, 64, 4);
        const wrinkle = Math.sin((v * 24 + noise.fbm(u, v, 4, 4, 2) * 6) * Math.PI * 2) * 0.5 + 0.5;
        o[0] = 0.62 + (streak - 0.5) * 0.25 - Math.pow(wrinkle, 8) * 0.25;
        o[1] = noise.fbm(u, v + 0.5, 4, 4, 3) > 0.64 ? 1 : 0;
      });
      break;
    case Cell.BarkEmber: {
      const pts: [number, number][] = [];
      for (let i = 0; i < 18; i++) pts.push([rng.float(), rng.float()]);
      paintPixels(ctx, (u, v, o) => {
        let d1 = 9, d2 = 9;
        for (const p of pts)
          for (let ox = -1; ox <= 1; ox++)
            for (let oy = -1; oy <= 1; oy++) {
              const dx = p[0] + ox - u, dy = (p[1] + oy - v) * 0.6;
              const d = dx * dx + dy * dy;
              if (d < d1) {
                d2 = d1;
                d1 = d;
              } else if (d < d2) d2 = d;
            }
        const edge = Math.sqrt(d2) - Math.sqrt(d1);
        const crack = edge < 0.02 ? 1 : 0;
        o[0] = 0.3 + noise.at(u, v, 16, 16) * 0.25 + crack * 0.6;
        o[1] = crack;
        o[2] = crack * (0.6 + 0.4 * noise.at(u, v, 8, 8));
      });
      break;
    }
    case Cell.BarkAlien:
      paintPixels(ctx, (u, v, o) => {
        const s = (u + v * 2 + noise.fbm(u, v, 4, 4, 2) * 0.3) % 1;
        const stripe = s < 0.5 ? 1 : 0;
        const line = Math.exp(-Math.pow((s - 0.5) / 0.02, 2));
        o[0] = 0.6 + noise.at(u, v, 32, 32) * 0.3;
        o[1] = stripe;
        o[2] = line;
      });
      break;
    case Cell.Stem:
      paintPixels(ctx, (u, v, o) => {
        o[0] = 0.78 + (noise.at(u, v, 64, 4) - 0.5) * 0.2 + (noise.at(u, v, 8, 8) - 0.5) * 0.1;
        o[1] = 0;
      });
      break;
    case Cell.Plain:
      paintPixels(ctx, (u, v, o) => {
        o[0] = 0.88 + (noise.fbm(u, v, 8, 8, 3) - 0.5) * 0.2;
      });
      break;
    case Cell.Bone:
      paintPixels(ctx, (u, v, o) => {
        const crack = Math.abs(noise.fbm(u, v, 4, 8, 3) - 0.5) < 0.012 ? 0.6 : 1;
        o[0] = (0.85 + (noise.at(u, v, 16, 16) - 0.5) * 0.15) * crack;
      });
      break;
    case Cell.Cactus:
      paintPixels(ctx, (u, v, o) => {
        // u wraps around the stem: ribs + areoles with pale spines (mask).
        const rib = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 12);
        const ar = ((v * 20) % 1);
        const spine = rib > 0.92 && ar < 0.12 ? 1 : 0;
        o[0] = 0.55 + rib * 0.35 + (noise.at(u, v, 16, 16) - 0.5) * 0.1;
        o[1] = spine;
      });
      break;
    case Cell.Cap:
      paintPixels(ctx, (u, v, o) => {
        // v = 0 rim → 1 top. Spots scattered (mask + glow).
        const spot = noise.at(u, v, 16, 8);
        const s = spot > 0.74 ? 1 : 0;
        o[0] = 0.65 + v * 0.3 + (noise.fbm(u, v, 8, 4, 2) - 0.5) * 0.15;
        o[1] = s;
        o[2] = s;
      });
      break;
    case Cell.Gills:
      paintPixels(ctx, (u, v, o) => {
        const g = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 64);
        o[0] = 0.55 + g * 0.35;
        o[1] = 0;
        o[2] = g * (0.4 + 0.6 * v);
      });
      break;
    case Cell.Crystal:
      paintPixels(ctx, (u, v, o) => {
        const streak = noise.at(u, v, 8, 2);
        o[0] = 0.75 + v * 0.25 + (streak - 0.5) * 0.15;
        o[1] = streak > 0.6 ? 1 : 0;
        o[2] = 0.25 + v * 0.75;
      });
      break;
    // ------------------------------------------------------------------ alpha shapes
    case Cell.LeafBroad: {
      twig(ctx, S / 2, S, S / 2 + rng.range(-20, 20), S * 0.08, 5);
      const n = Math.round(10 + st.leafCount * 8);
      for (let i = 0; i < n; i++) {
        const t = rng.range(0.08, 0.95);
        const side = i % 2 ? 1 : -1;
        const x = S / 2 + (rng.float() - 0.5) * 24, y = S - t * S * 0.9;
        const len = rng.range(0.22, 0.32) * S * (1 - t * 0.3);
        drawLeaf(ctx, x, y, side * rng.range(0.4, 1.3), len, len * st.leafWid, st, rng, rng.chance(0.3) ? 1 : 0, st.vein);
      }
      drawLeaf(ctx, S / 2, S * 0.2, rng.range(-0.2, 0.2), S * 0.2, S * 0.2 * st.leafWid, st, rng, 0, st.vein);
      break;
    }
    case Cell.LeafLobed: {
      twig(ctx, S / 2, S, S / 2, S * 0.15, 4);
      const n = Math.round(6 + st.leafCount * 4);
      const sh = { ...st, lobes: 2.5, tip: 0.2, round: 0.8 };
      for (let i = 0; i < n; i++) {
        const t = rng.range(0.1, 0.9);
        const side = i % 2 ? 1 : -1;
        const len = rng.range(0.26, 0.36) * S;
        drawLeaf(ctx, S / 2, S - t * S * 0.85, side * rng.range(0.5, 1.2), len, len * 0.55, sh, rng, rng.chance(0.3) ? 1 : 0, st.vein);
      }
      break;
    }
    case Cell.LeafSmall: {
      // Fine twigs with many small leaflets (birch, acacia, mimosa).
      const branches = 5;
      for (let b = 0; b < branches; b++) {
        const x0 = S / 2, y0 = S;
        const ang = -Math.PI / 2 + (b - (branches - 1) / 2) * 0.35 + rng.range(-0.1, 0.1);
        const L = S * rng.range(0.7, 0.95);
        const x1 = x0 + Math.cos(ang) * L, y1 = y0 + Math.sin(ang) * L;
        twig(ctx, x0, y0, x1, y1, 2.5);
        const n = 14;
        for (let i = 0; i < n; i++) {
          const t = 0.2 + (i / n) * 0.8;
          const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
          const len = S * 0.075 * rng.range(0.8, 1.2);
          drawLeaf(ctx, x, y, ang + Math.PI / 2 + (i % 2 ? 1 : -1) * rng.range(0.7, 1.2), len, len * Math.max(0.35, st.leafWid), st, rng, rng.chance(0.25) ? 1 : 0, st.vein * 0.5);
        }
      }
      break;
    }
    case Cell.LeafNeedle: {
      // Needle sprays: twigs with dense needles.
      const nb = 4;
      for (let b = 0; b < nb; b++) {
        const x0 = S * (0.2 + b * 0.2), y0 = S;
        const ang = -Math.PI / 2 + rng.range(-0.35, 0.35);
        const L = S * rng.range(0.75, 0.95);
        const x1 = x0 + Math.cos(ang) * L, y1 = y0 + Math.sin(ang) * L;
        twig(ctx, x0, y0, x1, y1, 3, 0.35);
        const n = 50;
        for (let i = 0; i < n; i++) {
          const t = 0.05 + (i / n) * 0.95;
          const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
          const a = ang + (i % 2 ? 1 : -1) * rng.range(0.5, 1.1);
          const nl = S * st.needleLen * (1 - t * 0.35);
          ctx.strokeStyle = rgba(rng.range(0.7, 1), rng.chance(0.2) ? 1 : 0, 0);
          ctx.lineWidth = rng.range(1.5, 2.6);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(a) * nl, y + Math.sin(a) * nl);
          ctx.stroke();
        }
      }
      break;
    }
    case Cell.Spray: {
      // Scale-leaf sprays (juniper / cypress): forking flat fronds of tiny scales.
      const draw = (x: number, y: number, ang: number, L: number, depth: number) => {
        const x1 = x + Math.cos(ang) * L, y1 = y + Math.sin(ang) * L;
        const n = Math.max(3, Math.round(L / 5));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          ctx.fillStyle = rgba(rng.range(0.7, 1), rng.chance(0.15) ? 1 : 0, 0);
          ctx.beginPath();
          ctx.ellipse(x + (x1 - x) * t, y + (y1 - y) * t, 4.5 * (1 - t * 0.5), 3, ang, 0, Math.PI * 2);
          ctx.fill();
        }
        if (depth > 0) {
          for (let k = 0; k < 3; k++) {
            const t = rng.range(0.3, 0.8);
            draw(x + (x1 - x) * t, y + (y1 - y) * t, ang + (k % 2 ? 1 : -1) * rng.range(0.4, 0.8), L * 0.5, depth - 1);
          }
        }
      };
      for (let b = 0; b < 3; b++) draw(S * (0.3 + b * 0.2), S, -Math.PI / 2 + rng.range(-0.3, 0.3), S * 0.7, 2);
      break;
    }
    case Cell.LeafWillow: {
      // Long narrow leaves hanging along vertical strands (texture tiles vertically).
      for (let s = 0; s < 4; s++) {
        const x = S * (0.15 + s * 0.23);
        twig(ctx, x, 0, x + rng.range(-6, 6), S, 2, 0.5);
        for (let i = 0; i < 16; i++) {
          const y = (i / 16) * S + rng.range(0, 8);
          const len = S * rng.range(0.13, 0.2);
          for (const yy of [y, y - S, y + S]) drawLeaf(ctx, x, yy, Math.PI + (i % 2 ? 0.45 : -0.45) + rng.range(-0.15, 0.15), len, len * 0.16, st, rng, rng.chance(0.25) ? 1 : 0, st.vein * 0.4);
        }
      }
      break;
    }
    case Cell.VineLeaf: {
      // Small heart leaves on a strand (tiles vertically).
      const x = S / 2;
      twig(ctx, x, 0, x, S, 3, 0.4);
      for (let i = 0; i < 9; i++) {
        const y = (i / 9) * S;
        const side = i % 2 ? 1 : -1;
        const len = S * 0.16;
        for (const yy of [y, y - S, y + S]) {
          drawLeaf(ctx, x, yy, side * 1.2 + Math.PI, len, len * 0.6, { ...st, round: 1, tip: 0.3 }, rng, rng.chance(0.2) ? 1 : 0, st.vein * 0.5);
          if (rng.chance(0.15)) {
            ctx.fillStyle = rgba(1, 1, 0.6);
            ctx.beginPath();
            ctx.arc(x - side * len * 0.4, yy + len * 0.4, 6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      break;
    }
    case Cell.LeafFrond:
    case Cell.LeafFern: {
      // Rachis bottom → top, pinnae on both sides (palm / fern).
      const fern = cell === Cell.LeafFern;
      ctx.strokeStyle = rgba(0.55, 0, 0);
      ctx.lineWidth = fern ? 3 : 5;
      ctx.beginPath();
      ctx.moveTo(S / 2, S);
      ctx.lineTo(S / 2, 0);
      ctx.stroke();
      const n = fern ? 22 : 18;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const y = S - t * S;
        const env = fern ? Math.sin(Math.PI * Math.min(1, t * 1.15)) : 1 - t * 0.55;
        const len = (fern ? S * 0.4 : S * 0.48) * env;
        for (const side of [-1, 1]) {
          const ang = side * (fern ? 1.15 : 1.25) + Math.PI * 0;
          drawLeaf(ctx, S / 2, y, ang + (fern ? 0 : side * -0.1), len, len * (fern ? 0.22 : 0.12), fern ? { ...st, serr: 0.8, lobes: 0 } : { ...st, tip: 0.8 }, rng, rng.chance(0.15) ? 1 : 0, 0.15);
        }
      }
      break;
    }
    case Cell.LeafBlade: {
      // Long blades (bamboo, giant grasses).
      for (let i = 0; i < 7; i++) {
        const x = S * (0.12 + i * 0.13);
        const len = S * rng.range(0.7, 0.95);
        drawLeaf(ctx, x, S, rng.range(-0.25, 0.25), len, len * 0.09, { ...st, tip: 1.2, serr: 0 }, rng, rng.chance(0.25) ? 1 : 0, 0.15);
      }
      break;
    }
    case Cell.LeafHeart: {
      // One large heart / elephant-ear leaf filling the cell.
      ctx.save();
      ctx.translate(S / 2, S * 0.97);
      const len = S * 0.92, wid = S * 0.46;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-wid * 1.4, -len * 0.05, -wid * 1.2, -len * 0.75, 0, -len);
      ctx.bezierCurveTo(wid * 1.2, -len * 0.75, wid * 1.4, -len * 0.05, 0, 0);
      ctx.closePath();
      const g = ctx.createLinearGradient(-wid, 0, wid, 0);
      g.addColorStop(0, rgba(0.75, 0, 0));
      g.addColorStop(0.5, rgba(1, 0, 0));
      g.addColorStop(1, rgba(0.8, 0, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = rgba(0.95, 1, 0);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -len * 0.95);
      ctx.stroke();
      ctx.lineWidth = 2;
      for (let i = 1; i < 8; i++) {
        const t = i / 8;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(0, -len * t * 0.9);
          ctx.quadraticCurveTo(s * wid * 0.5, -len * (t * 0.9 + 0.02), s * wid * 0.85 * Math.sin(Math.PI * (0.15 + t * 0.8)), -len * (t * 0.9 + 0.14));
          ctx.stroke();
        }
      }
      ctx.restore();
      break;
    }
    case Cell.Petal: {
      ctx.save();
      ctx.translate(S / 2, S);
      const len = S * 0.95, wid = S * 0.42 * (0.6 + st.round * 0.5);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-wid, -len * 0.25, -wid * 1.1, -len * 0.85, 0, -len);
      ctx.bezierCurveTo(wid * 1.1, -len * 0.85, wid, -len * 0.25, 0, 0);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, -len);
      g.addColorStop(0, rgba(0.7, 1, 0));
      g.addColorStop(0.22, rgba(0.9, 0.6, 0));
      g.addColorStop(0.4, rgba(1, 0, 0));
      g.addColorStop(1, rgba(0.92, 0, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = rgba(0.82, 0, 0);
      ctx.lineWidth = 1.2;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(0, -4);
        ctx.quadraticCurveTo(i * wid * 0.15, -len * 0.5, i * wid * 0.22, -len * 0.92);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case Cell.FlowerHead: {
      // Top view of a composite flower: petals (A) and a center disc (B, glow).
      const n = 14;
      ctx.save();
      ctx.translate(S / 2, S / 2);
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI * 2 + rng.range(-0.05, 0.05));
        leafPath(ctx, S * 0.47, S * 0.075, { tip: 0.1, serr: 0, lobes: 0, round: 1 }, rng);
        ctx.fillStyle = rgba(rng.range(0.85, 1), 0, 0.2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = rgba(0.85, 1, 0.8);
      ctx.beginPath();
      ctx.arc(0, 0, S * 0.13, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 60; i++) {
        const a = i * 2.39996, r = Math.sqrt(i / 60) * S * 0.12;
        ctx.fillStyle = rgba(0.6, 1, 1);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case Cell.Moss: {
      // Soft blobby cushion patch with sporophyte speckles (mask) and glow dots.
      for (let i = 0; i < 260; i++) {
        const a = rng.float() * Math.PI * 2, r = Math.pow(rng.float(), 0.7) * S * 0.42;
        const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
        ctx.fillStyle = rgba(rng.range(0.6, 1), 0, 0, 0.9);
        ctx.beginPath();
        ctx.arc(x, y, rng.range(6, 16) * (1 - r / (S * 0.5)), 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 90; i++) {
        const a = rng.float() * Math.PI * 2, r = Math.pow(rng.float(), 0.8) * S * 0.38;
        ctx.fillStyle = rgba(1, 1, 1);
        ctx.beginPath();
        ctx.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, rng.range(1.5, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case Cell.Lichen: {
      for (let k = 0; k < 7; k++) {
        const cx = S / 2 + rng.range(-60, 60), cy = S / 2 + rng.range(-60, 60), R = rng.range(30, 70);
        for (let ring = 6; ring >= 1; ring--) {
          const rr = (R * ring) / 6;
          ctx.fillStyle = rgba(0.65 + (ring % 2) * 0.3, ring === 6 ? 1 : 0, 0);
          ctx.beginPath();
          for (let i = 0; i <= 24; i++) {
            const a = (i / 24) * Math.PI * 2;
            const w = rr * (0.85 + 0.15 * Math.sin(a * 7 + k));
            if (i === 0) ctx.moveTo(cx + Math.cos(a) * w, cy + Math.sin(a) * w);
            else ctx.lineTo(cx + Math.cos(a) * w, cy + Math.sin(a) * w);
          }
          ctx.fill();
        }
      }
      break;
    }
    case Cell.Kelp: {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40, y = S - t * S;
        const w = S * (0.18 + 0.08 * Math.sin(t * 19)) * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
        if (i === 0) ctx.moveTo(S / 2 - w, y);
        else ctx.lineTo(S / 2 - w, y);
      }
      for (let i = 40; i >= 0; i--) {
        const t = i / 40, y = S - t * S;
        const w = S * (0.18 + 0.08 * Math.sin(t * 23 + 1)) * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
        ctx.lineTo(S / 2 + w, y);
      }
      ctx.closePath();
      ctx.fillStyle = rgba(0.85, 0, 0);
      ctx.fill();
      ctx.strokeStyle = rgba(0.6, 1, 0);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(S / 2, S);
      ctx.lineTo(S / 2, 0);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case Cell.Grass: {
      // Clump of tapered blades fanning out; tips use the mask (dry/seed color).
      const n = 9;
      for (let i = 0; i < n; i++) {
        const x0 = S / 2 + rng.range(-S * 0.25, S * 0.25);
        const lean = rng.range(-0.35, 0.35);
        const h = S * rng.range(0.6, 0.98);
        const w = rng.range(7, 13);
        ctx.beginPath();
        ctx.moveTo(x0 - w / 2, S);
        ctx.quadraticCurveTo(x0 + lean * h * 0.4, S - h * 0.6, x0 + lean * h, S - h);
        ctx.quadraticCurveTo(x0 + lean * h * 0.4 + w * 0.3, S - h * 0.55, x0 + w / 2, S);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, S, 0, S - h);
        const l = rng.range(0.8, 1);
        g.addColorStop(0, rgba(l * 0.55, 0, 0));
        g.addColorStop(0.6, rgba(l * 0.9, 0.15, 0));
        g.addColorStop(1, rgba(l, 0.9, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
      break;
    }
  }
}

// ------------------------------------------------------------------ atlas

export interface FloraAtlas {
  texture: THREE.DataTexture;
  /** Grayscale rock detail texture (tileable): R = detail, G = vein mask, B = crack. */
  rockTexture: THREE.DataTexture;
}

/**
 * Pull-push fill: transparent texels take the average RGB of nearby opaque texels
 * (via a mip pyramid that stops at one texel per cell, so cells never bleed into
 * each other). Keeps mipmapped cut-outs from developing dark fringes. O(n).
 */
function pullPush(data: Uint8ClampedArray, w: number, h: number) {
  const levels: { w: number; h: number; c: Float32Array; a: Float32Array }[] = [];
  // Level 0: premultiplied by binary coverage.
  const c0 = new Float32Array(w * h * 3), a0 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const cov = data[i * 4 + 3] > 8 ? 1 : 0;
    a0[i] = cov;
    c0[i * 3] = data[i * 4] * cov;
    c0[i * 3 + 1] = data[i * 4 + 1] * cov;
    c0[i * 3 + 2] = data[i * 4 + 2] * cov;
  }
  levels.push({ w, h, c: c0, a: a0 });
  // Pull: downsample until one texel per cell.
  let lw = w, lh = h;
  while (lw > ATLAS_COLS && lh > ATLAS_ROWS) {
    const pw = lw, prev = levels[levels.length - 1];
    lw >>= 1;
    lh >>= 1;
    const c = new Float32Array(lw * lh * 3), a = new Float32Array(lw * lh);
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        const o = x + y * lw;
        for (let k = 0; k < 4; k++) {
          const j = x * 2 + (k & 1) + (y * 2 + (k >> 1)) * pw;
          a[o] += prev.a[j];
          c[o * 3] += prev.c[j * 3];
          c[o * 3 + 1] += prev.c[j * 3 + 1];
          c[o * 3 + 2] += prev.c[j * 3 + 2];
        }
      }
    levels.push({ w: lw, h: lh, c, a });
  }
  // Push: fill empty texels from their parent (normalized).
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], P = levels[l + 1];
    for (let y = 0; y < L.h; y++)
      for (let x = 0; x < L.w; x++) {
        const o = x + y * L.w;
        if (L.a[o] > 0) continue;
        const po = (x >> 1) + (y >> 1) * P.w;
        const pa = P.a[po];
        if (pa <= 0) continue;
        L.a[o] = 1;
        L.c[o * 3] = P.c[po * 3] / pa;
        L.c[o * 3 + 1] = P.c[po * 3 + 1] / pa;
        L.c[o * 3 + 2] = P.c[po * 3 + 2] / pa;
      }
  }
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > 8) continue;
    const a = a0[i] || 1;
    data[i * 4] = c0[i * 3] / a;
    data[i * 4 + 1] = c0[i * 3 + 1] / a;
    data[i * 4 + 2] = c0[i * 3 + 2] / a;
  }
}

const atlasCache = new Map<number, FloraAtlas>();

/** Build (or fetch) the flora atlas of a world. */
export function getFloraAtlas(floraSeed: number): FloraAtlas {
  const hit = atlasCache.get(floraSeed);
  if (hit) return hit;
  const rng = new Rng(floraSeed ^ 0x5a17a5);
  const st: AtlasStyle = {
    leafWid: rng.range(0.28, 0.6),
    tip: rng.range(0.1, 0.9),
    serr: rng.chance(0.5) ? rng.range(0.2, 1) : 0,
    round: rng.float(),
    lobes: 0,
    leafCount: rng.range(0.5, 1.5),
    needleLen: rng.range(0.12, 0.22),
    vein: rng.range(0.1, 0.35),
  };
  const W = ATLAS_COLS * CELL_PX, H = ATLAS_ROWS * CELL_PX;
  const atlas = makeCanvas(W, H);
  const actx = atlas.getContext('2d', { willReadFrequently: true })!;
  const cellCanvas = makeCanvas(CELL_PX, CELL_PX);
  const cctx = cellCanvas.getContext('2d', { willReadFrequently: true })!;
  for (let c = 0; c < ATLAS_COLS * ATLAS_ROWS; c++) {
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, CELL_PX, CELL_PX);
    paintCell(c as Cell, cctx, rng.fork('cell', c), st);
    // Cell row 0 is the bottom of the texture (v = 0): canvas rows are flipped below.
    const col = c % ATLAS_COLS, row = Math.floor(c / ATLAS_COLS);
    actx.drawImage(cellCanvas, col * CELL_PX, (ATLAS_ROWS - 1 - row) * CELL_PX);
  }
  const img = actx.getImageData(0, 0, W, H);
  pullPush(img.data, W, H);
  // Flip vertically into a DataTexture (row 0 = bottom = v 0).
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) data.set(img.data.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  // Rock detail texture (tileable).
  const RS = 256;
  const rdata = new Uint8Array(RS * RS * 4);
  const rn = new TileNoise(rng.fork('rock'), 64);
  for (let y = 0; y < RS; y++)
    for (let x = 0; x < RS; x++) {
      const u = x / RS, v = y / RS;
      const n = rn.fbm(u, v, 4, 4, 5);
      const vein = Math.abs(rn.fbm(u + 0.31, v + 0.77, 2, 2, 4) - 0.5);
      const crack = Math.abs(rn.fbm(u + 0.6, v + 0.2, 4, 4, 3) - 0.5);
      const o = (x + y * RS) * 4;
      rdata[o] = Math.round((0.55 + (n - 0.5) * 0.9 - (crack < 0.015 ? 0.25 : 0)) * 255);
      rdata[o + 1] = vein < 0.04 ? 255 : vein < 0.06 ? 120 : 0;
      rdata[o + 2] = crack < 0.02 ? 255 : 0;
      rdata[o + 3] = 255;
    }
  const rockTexture = new THREE.DataTexture(rdata, RS, RS, THREE.RGBAFormat, THREE.UnsignedByteType);
  rockTexture.colorSpace = THREE.NoColorSpace;
  rockTexture.wrapS = rockTexture.wrapT = THREE.RepeatWrapping;
  rockTexture.magFilter = THREE.LinearFilter;
  rockTexture.minFilter = THREE.LinearMipmapLinearFilter;
  rockTexture.generateMipmaps = true;
  rockTexture.anisotropy = 4;
  rockTexture.needsUpdate = true;

  const out = { texture: tex, rockTexture };
  atlasCache.set(floraSeed, out);
  return out;
}
