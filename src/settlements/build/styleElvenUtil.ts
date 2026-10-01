/**
 * Shared ornament helpers for the "living" and arcane styles (elven, sylvan,
 * umbral): living-wood columns with spiralling vines, leaf canopies, flared
 * eave skirts, glowing lanterns, crystal spires & floating shards, mushroom
 * caps with bioluminescent spots, and cheap far-LOD silhouette bodies.
 */
import { Rng } from '../../core/rng';
import { Kit, Surf, jitter, scaleHex, type Lod } from './kit';
import type { BuildCtx } from './common';

/** Hanging glow lantern (night light). */
export function lantern(k: Kit, x: number, y: number, z: number, glow: number, s = 1, lod: Lod = 1) {
  k.box(x, y + 0.42 * s, z, 0.03, 0.3 * s, 0.03, Surf.Rope, 0x6a5a40, { lod });
  k.sphere(x, y + 0.25 * s, z, 0.16 * s, 0.22 * s, 0.16 * s, Surf.Glow, glow, { emit: glow, emitI: 3.2, night: true, seg: 8, lod });
  k.cyl(x, y + 0.42 * s, z, 0.1 * s, 0.02, 0.12 * s, Surf.Bark, 0x7a6448, { seg: 6, lod });
  k.light(x, y + 0.2 * s, z, glow, 3.5, 9, true, 0.05);
}

/** Living-wood column at (x, z) of height h, with vines spiralling up (lod 1). */
export function livingColumn(k: Kit, x: number, z: number, y0: number, h: number, r: number, col: number, rng: Rng) {
  // Slightly bent trunk made of three tapering segments.
  let px = x, pz = z, py = y0;
  const n = 3;
  for (let i = 0; i < n; i++) {
    const nx = x + rng.range(-0.08, 0.08), nz = z + rng.range(-0.08, 0.08);
    const ny = y0 + (h * (i + 1)) / n;
    k.pole(px, py, pz, nx, ny, nz, r * (1 - i * 0.12), r * (1 - (i + 1) * 0.12), Surf.Bark, col, { seg: 7 });
    px = nx; pz = nz; py = ny;
  }
  // Root flare.
  k.cyl(x, y0 - 0.2, z, r * 1.7, r, 0.6, Surf.Bark, scaleHex(col, 0.9), { seg: 7 });
  // Spiral vine.
  const turns = h / 1.4;
  const steps = Math.ceil(turns * 6);
  const ph = rng.range(0, 6.28);
  let ax = x + Math.cos(ph) * (r + 0.04), az = z + Math.sin(ph) * (r + 0.04), ay = y0;
  for (let i = 1; i <= steps; i++) {
    const a = ph + (i / 6) * Math.PI * 2;
    const bx = x + Math.cos(a) * (r + 0.04), bz = z + Math.sin(a) * (r + 0.04), by = y0 + (h * i) / steps;
    k.pole(ax, ay, az, bx, by, bz, 0.045, 0.04, Surf.Bark, scaleHex(col, 1.15), { seg: 4, lod: 1 });
    if (i % 4 === 0) k.sphere(bx, by, bz, 0.14, 0.09, 0.14, Surf.Leaf, jitter(0x6aa050, rng, 0.12), { seg: 5, lod: 1 });
    ax = bx; ay = by; az = bz;
  }
}

/** Cluster of leaf spheres forming a canopy around (x, y, z). */
export function leafCanopy(k: Kit, x: number, y: number, z: number, r: number, col: number, rng: Rng, n = 7) {
  k.sphere(x, y, z, r, r * 0.6, r, Surf.Leaf, jitter(col, rng, 0.08), { seg: 10 });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = r * rng.range(0.55, 0.85);
    const rr = r * rng.range(0.45, 0.65);
    k.sphere(x + Math.cos(a) * d, y + rng.range(-0.4, 0.5) * r * 0.5, z + Math.sin(a) * d, rr, rr * 0.7, rr, Surf.Leaf, jitter(col, rng, 0.12), { seg: 8, lod: i < 3 ? 0 : 1 });
  }
}

/** Flared eave skirt below a roof: wide at the bottom, meeting the walls at the top (concave sweep). */
export function eaveSkirt(k: Kit, W: number, D: number, yTop: number, e: number, surf: Surf, col: number, tipCol: number) {
  const h = e * 0.42;
  k.frustum(0, yTop - h, 0, W + 2 * e, D + 2 * e, W + 0.2, D + 0.2, h, surf, col);
  // Upturned corner tips.
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const cx = sx * (W / 2 + e), cz = sz * (D / 2 + e);
    k.pole(cx * 0.97, yTop - h, cz * 0.97, cx + sx * 0.35, yTop - h + 0.55, cz + sz * 0.35, 0.09, 0.0, Surf.Bark, tipCol, { seg: 5, lod: 1 });
  }
}

/** Hexagonal crystal spire from (x, y, z), tilted by (rx, rz). Emits always (faint) — brighter glow via light. */
export function crystalSpire(k: Kit, x: number, y: number, z: number, len: number, r: number, rx: number, rz: number, col: number, glow: number, lod: Lod = 0) {
  k.cyl(x, y, z, r, r * 0.8, len * 0.72, Surf.Crystal, col, { seg: 6, rx, rz, emit: glow, emitI: 0.9, lod });
  // Tip: continue along the same axis.
  // Axis = Rx·Rz·(0,1,0).
  const dx = -Math.sin(rz), dy = Math.cos(rx) * Math.cos(rz), dz = Math.sin(rx) * Math.cos(rz);
  const L = len * 0.72;
  k.cyl(x + dx * L, y + dy * L, z + dz * L, r * 0.8, 0, len * 0.28, Surf.Crystal, scaleHex(col, 1.25), { seg: 6, rx, rz, emit: glow, emitI: 1.6, lod });
}

/** Floating double-pointed shard centred at (x, y, z). */
export function shard(k: Kit, x: number, y: number, z: number, size: number, col: number, glow: number, rz = 0, lod: Lod = 1) {
  k.cyl(x, y, z, size * 0.32, 0, size, Surf.Crystal, col, { seg: 5, emit: glow, emitI: 2.2, rz, lod });
  k.cyl(x, y, z, size * 0.32, 0, size * 0.6, Surf.Crystal, col, { seg: 5, emit: glow, emitI: 2.2, rx: Math.PI, rz: -rz, lod });
}

/** Mushroom cap with gill ring and glowing spots, centred on the stem axis at height y. */
export function mushroomCap(k: Kit, x: number, y: number, z: number, R: number, H: number, col: number, glow: number, rng: Rng, spots = 9) {
  k.sphere(x, y, z, R, H, R, Surf.Mushroom, col, { lat0: 0, lat1: Math.PI / 2 + 0.28, seg: 18 });
  const under = y - Math.sin(0.28) * H;
  // Gill ring underneath (glows softly at night).
  k.cyl(x, under - 0.04, z, R * 0.93, R * 0.45, 0.06, Surf.Glow, scaleHex(glow, 0.8), { seg: 18, emit: glow, emitI: 1.2, night: true, lod: 1 });
  for (let i = 0; i < spots; i++) {
    const lat = rng.range(0.25, 1.25), lon = rng.range(0, Math.PI * 2);
    const sr = R * rng.range(0.06, 0.12);
    const px = x + Math.sin(lat) * Math.sin(lon) * R, py = y + Math.cos(lat) * H, pz = z + Math.sin(lat) * Math.cos(lon) * R;
    k.sphere(px, py, pz, sr, sr * 0.45, sr, Surf.Glow, 0xf4f0e0, { emit: glow, emitI: 1.6, night: true, seg: 8, lod: 1 });
  }
}

/** Small decorative mushroom (stem + cap) standing at (x, z) on y. */
export function miniMushroom(k: Kit, x: number, y: number, z: number, s: number, cap: number, glow: number, rng: Rng) {
  const h = s * rng.range(0.7, 1.2);
  k.cyl(x, y, z, 0.12 * s, 0.09 * s, h, Surf.Mushroom, 0xece4d4, { seg: 6, rz: rng.range(-0.15, 0.15), lod: 1 });
  k.sphere(x, y + h, z, 0.42 * s, 0.24 * s, 0.42 * s, Surf.Mushroom, cap, { lat0: 0, lat1: Math.PI / 2 + 0.2, seg: 9, lod: 1 });
  k.cyl(x, y + h - 0.08 * s, z, 0.34 * s, 0.34 * s, 0.03, Surf.Glow, glow, { seg: 9, emit: glow, emitI: 1.4, night: true, lod: 1 });
}

/** Ground offset helper: lowest ground under the footprint (≤ 0). */
export function gmin(c: BuildCtx) {
  return Math.min(...c.ground);
}

/** Silhouette body: walls + roof shape + two lit windows per side (far LOD). */
export function silBody(k: Kit, c: BuildCtx, H: number, roofH: number, roofTop: number, wallSurf: Surf, wallCol: number, roofSurf: Surf, roofCol: number, glow: number) {
  const w = c.w, d = c.d, g = gmin(c);
  if (c.b.round) {
    k.cyl(0, g, 0, w / 2, w / 2, H - g, wallSurf, wallCol, { seg: 8 });
  } else {
    k.box(0, g, 0, w, H - g, d, wallSurf, wallCol);
    k.frustum(0, H - 0.2, 0, w + 1.2, d + 1.2, Math.max(0.1, w - d) * roofTop, 0.05, roofH, roofSurf, roofCol);
  }
  if ((c.b.seed & 255) < 200) {
    const y = 1.3 * c.s;
    for (const sx of [-0.25, 0.25]) {
      k.box(sx * w, y, d / 2 + 0.02, 0.6, 1.0, 0.06, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true });
      k.box(sx * w, y, -d / 2 - 0.02, 0.6, 1.0, 0.06, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true });
    }
  }
}
