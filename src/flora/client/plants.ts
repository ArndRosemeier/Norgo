/**
 * Mesh builders for everything that is not a tree: shrubs, ground cover,
 * flowers, herbs, mushrooms, cacti, water plants, cave flora, rocks and props.
 *
 * All builders produce geometry in the shared flora vertex layout (geo.ts) at
 * the species' reference size, with the base at the origin and +Y up (hanging
 * species grow along +Y as well; the scatter flips them onto ceilings).
 */
import { Rng } from '../../core/rng';
import { Noise } from '../../core/noise';
import type { FloraSpecies } from '../species';
import { Cell } from './atlas';
import { GeoBuilder, V3, add, cross, lerp3, lin, mulc, norm, perp, rotate, scale, style, sub } from './geo';
import { mushroomCap } from './trees';

const UP: V3 = [0, 1, 0];

/** Ring of crossed cards (grass tufts, reeds, ferns at low detail). */
function crossCards(gb: GeoBuilder, n: number, w: number, h: number, a: V3, b: V3, cell: number, rng: Rng, bend: number, lean = 0.15, flutter = 0.4) {
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI + rng.range(-0.2, 0.2);
    const right: V3 = [Math.cos(ang), 0, Math.sin(ang)];
    const up = norm([rng.range(-lean, lean), 1, rng.range(-lean, lean)]);
    const s = style({ a, b, cell, bend, flutter, phase: rng.float() });
    // Two segments so the card can bend in the wind.
    const p0: V3 = [rng.range(-0.06, 0.06) * w, 0, rng.range(-0.06, 0.06) * w];
    const pts: V3[] = [p0, add(p0, scale(up, h * 0.5)), add(p0, add(scale(up, h), [up[0] * h * 0.15, 0, up[2] * h * 0.15]))];
    gb.strip(pts, [right, right, right], [w, w * 0.95, w * 0.9], s, null, [0, 1], [0, 1], (t) => t * flutter);
  }
}

/** Leafy clump: a ball of leaf cards around a center (bushes, crowns of herbs). */
function leafBall(gb: GeoBuilder, c: V3, R: number, n: number, size: number, a: V3, b: V3, cell: number, rng: Rng, glow = 0) {
  for (let i = 0; i < n; i++) {
    const dir = norm([rng.range(-1, 1), rng.range(-0.3, 1), rng.range(-1, 1)]);
    const p = add(c, scale(dir, R * Math.cbrt(rng.float())));
    const up = norm(add(dir, [0, 0.6, 0]));
    const right = rotate(perp(up), up, rng.float() * Math.PI * 2);
    const alt = rng.chance(0.3);
    gb.card(add(p, scale(up, -size * 0.3)), right, up, size, size, style({ a: alt ? b : a, b: alt ? a : b, cell, flutter: 1, phase: rng.float(), glow }), dir, true);
  }
}

/** Single stalk tube. */
function stalk(gb: GeoBuilder, pts: V3[], r0: number, r1: number, col: V3, radial: number, phase: number, cell = Cell.Stem) {
  gb.tube(pts, pts.map((_, i) => r0 + (r1 - r0) * (i / (pts.length - 1))), radial, style({ a: col, cell, phase }), { vScale: 1.5 });
}

function curve(base: V3, dir: V3, length: number, bendDir: V3, bendAmt: number, n: number): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(add(base, add(scale(dir, length * t), scale(bendDir, bendAmt * length * t * t))));
  }
  return pts;
}

// ------------------------------------------------------------------ rocks

/** Displaced icosphere rock. `angular` 0..1 → rounded boulder … faceted block. */
export function rockGeometry(gb: GeoBuilder, seed: number, detail: number, opts: { rough: number; angular: number; flat: number; sink?: number; vein?: number; colA: V3; colB: V3 }) {
  const n = new Noise(seed);
  const rng = new Rng(seed);
  // Build an icosphere (detail subdivisions).
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => norm(v as V3));
  let faces: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let d = 0; d < detail; d++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? a + ',' + b : b + ',' + a;
      let i = cache.get(k);
      if (i === undefined) {
        i = verts.length;
        verts.push(norm(lerp3(verts[a], verts[b], 0.5)));
        cache.set(k, i);
      }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  // Planar cuts make angular rocks; noise makes rounded ones lumpy.
  const planes: { n: V3; d: number }[] = [];
  const np = Math.round(4 + opts.angular * 8);
  for (let i = 0; i < np; i++) planes.push({ n: norm([rng.range(-1, 1), rng.range(-0.6, 1), rng.range(-1, 1)]), d: rng.range(0.55, 0.85) });
  const sx = rng.range(0.85, 1.25), sz = rng.range(0.8, 1.2), sy = opts.flat * rng.range(0.85, 1.15);
  const sink = opts.sink ?? 0.25;
  verts = verts.map((v) => {
    let r = 1 + n.fbm3(v[0] * 1.3, v[1] * 1.3, v[2] * 1.3, 4) * opts.rough;
    for (const p of planes) {
      const dd = v[0] * p.n[0] + v[1] * p.n[1] + v[2] * p.n[2];
      if (dd * r > p.d) r = Math.min(r, p.d / Math.max(0.2, dd) + (r - p.d / Math.max(0.2, dd)) * (1 - opts.angular));
    }
    return [v[0] * r * sx * 0.5, (v[1] * r * sy + sy * (1 - sink)) * 0.5, v[2] * r * sz * 0.5] as V3;
  });
  // Smooth normals.
  const nrm: V3[] = verts.map(() => [0, 0, 0]);
  for (const [a, b, c] of faces) {
    const fn = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
    for (const i of [a, b, c]) nrm[i] = add(nrm[i], fn);
  }
  const s = style({ a: opts.colA, b: opts.colB, cell: Cell.Plain, glow: opts.vein ?? 0 });
  const base = gb.count;
  for (let i = 0; i < verts.length; i++) gb.vertex(verts[i], norm(nrm[i]), 0, 0, s);
  for (const [a, b, c] of faces) gb.tri(base + a, base + b, base + c);
}

/** Rock-material species (ground-colored). */
export function buildRock(sp: FloraSpecies, variant: number, tier: number, colA: V3, colB: V3): GeoBuilder {
  const gb = new GeoBuilder();
  const rng = new Rng(sp.seed ^ Math.imul(variant + 7, 0x85ebca6b));
  const P = sp.p;
  const S = sp.size;
  const detail = tier === 0 ? 3 : tier === 1 ? 2 : 1;
  switch (sp.form) {
    case 'boulder':
    case 'rock':
    case 'orerock': {
      rockGeometry(gb, sp.seed + variant * 101, detail, { rough: P.rough ?? 0.3, angular: P.angular ?? 0.4, flat: P.flat ?? 0.7, vein: sp.form === 'orerock' ? 1 : 0, colA, colB: sp.form === 'orerock' ? lin(sp.accent) : colB });
      scaleAll(gb, S);
      break;
    }
    case 'slab': {
      rockGeometry(gb, sp.seed + variant * 131, Math.max(1, detail - 1), { rough: 0.12, angular: 0.9, flat: (P.thick ?? 0.18) * 2, sink: 0.35, colA, colB });
      scaleAll(gb, S);
      break;
    }
    case 'pebbles': {
      const count = P.count ?? 5;
      for (let i = 0; i < count; i++) {
        const sub = new GeoBuilder();
        rockGeometry(sub, sp.seed + i * 17 + variant * 991, 1, { rough: 0.25, angular: P.angular ?? 0.5, flat: rng.range(0.5, 0.8), colA, colB });
        const s = S * rng.range(0.12, 0.3);
        const a = rng.float() * Math.PI * 2, r = rng.range(0, S * 0.4);
        transformAll(sub, s, rng.float() * Math.PI * 2, [Math.cos(a) * r, -s * 0.15, Math.sin(a) * r]);
        gb.merge(sub);
      }
      break;
    }
    case 'stalagmite':
    case 'stalactite': {
      // Dripstone cone with irregular rings; stalactites are built pointing up and flipped by scatter.
      const prof: [number, number][] = [];
      const thin = P.thin ?? 0.16;
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const r = S * thin * Math.pow(1 - t, 1.2) * (1 + 0.12 * Math.sin(t * 17 + variant)) + 0.015;
        prof.push([r, -0.2 + t * S]);
      }
      gb.lathe([0, 0, 0], prof, tier === 0 ? 12 : 7, style({ a: colA, b: colB, cell: Cell.Plain }), { vScale: 0.4 });
      if (sp.form === 'stalagmite' && variant === 2) {
        // Twin dripstone.
        const sub = new GeoBuilder();
        sub.lathe([0, 0, 0], prof.map(([r, y]) => [r * 0.6, y * 0.55] as [number, number]), tier === 0 ? 10 : 6, style({ a: colA, b: colB, cell: Cell.Plain }));
        transformAll(sub, 1, 0, [S * thin * 1.1, 0, 0]);
        gb.merge(sub);
      }
      break;
    }
  }
  return gb;
}

function scaleAll(gb: GeoBuilder, s: number) {
  for (let i = 0; i < gb.pos.length; i++) gb.pos[i] *= s;
}

function transformAll(gb: GeoBuilder, s: number, yaw: number, off: V3) {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  for (let i = 0; i < gb.pos.length; i += 3) {
    const x = gb.pos[i] * s, y = gb.pos[i + 1] * s, z = gb.pos[i + 2] * s;
    gb.pos[i] = x * c - z * sn + off[0];
    gb.pos[i + 1] = y + off[1];
    gb.pos[i + 2] = x * sn + z * c + off[2];
    const nx = gb.nrm[i], nz = gb.nrm[i + 2];
    gb.nrm[i] = nx * c - nz * sn;
    gb.nrm[i + 2] = nx * sn + nz * c;
  }
}

// ------------------------------------------------------------------ plants & props

export function buildPlant(sp: FloraSpecies, variant: number, tier: number): GeoBuilder {
  const gb = new GeoBuilder();
  const rng = new Rng(sp.seed ^ Math.imul(variant + 3, 0x27d4eb2d));
  const P = sp.p;
  const S = sp.size;
  const leafA = lin(sp.leaf), leafB = lin(sp.leaf2), barkA = lin(sp.bark), barkB = lin(sp.bark2), acc = lin(sp.accent);
  const hi = tier === 0;
  // Ground plants sway proportional to their height.
  gb.bendFn = (p, base) => base + Math.max(0, p[1]) * 0.06;
  switch (sp.form) {
    case 'grass':
    case 'tallgrass': {
      const tall = sp.form === 'tallgrass';
      const n = tall ? 4 : 4;
      gb.bendFn = (p) => Math.pow(Math.max(0, p[1]) / S, 1.5) * S * 0.55;
      crossCards(gb, n, S * (tall ? 0.55 : 0.75), S, leafA, leafB, Cell.Grass, rng, 0, 0.2, 0.5);
      if (tall && (P.heads ?? 0) > 0) {
        // Seed heads on a few stalks.
        for (let i = 0; i < 3; i++) {
          const base: V3 = [rng.range(-0.1, 0.1), 0, rng.range(-0.1, 0.1)];
          const pts = curve(base, norm([rng.range(-0.2, 0.2), 1, rng.range(-0.2, 0.2)]), S * 1.15, [1, 0, 0], 0.08, 3);
          stalk(gb, pts, 0.008, 0.005, leafB, 3, rng.float());
          // Seed head: a slim spindle along the stalk tip.
          const dir = norm(sub(pts[3], pts[2]));
          gb.tube([pts[3], add(pts[3], scale(dir, S * 0.07)), add(pts[3], scale(dir, S * 0.14))], [S * 0.01, S * 0.014, S * 0.004], 4, style({ a: lin(sp.accent), b: leafB, cell: Cell.Stem, flutter: 0.2 }), { capStart: true });
        }
      }
      break;
    }
    case 'bush':
    case 'berrybush': {
      const clumps = P.clumps ?? 6;
      const ls = (P.leafSize ?? 0.6) * S;
      // Woody stems from the base.
      if (hi)
        for (let i = 0; i < 5; i++) {
          const d = norm([rng.range(-1, 1), rng.range(0.8, 1.6), rng.range(-1, 1)]);
          stalk(gb, curve([0, -0.05, 0], d, S * 0.6, [0, 1, 0], 0.1, 3), 0.035, 0.012, barkA, 4, rng.float(), Cell.BarkRough);
        }
      for (let c = 0; c < clumps; c++) {
        const a = (c / clumps) * Math.PI * 2 + rng.float();
        const r = S * rng.range(0.1, 0.35);
        const cc: V3 = [Math.cos(a) * r, S * rng.range(0.35, 0.7), Math.sin(a) * r];
        leafBall(gb, cc, S * 0.3, hi ? 7 : 3, ls * (hi ? 1 : 1.5), leafA, leafB, Cell.LeafBroad, rng);
      }
      if (sp.form === 'berrybush' && hi) {
        const nb = P.berries ?? 20;
        const bs = style({ a: acc, b: mulc(acc, 0.6), cell: Cell.Plain, bend: 0.05 });
        for (let i = 0; i < nb; i++) {
          const d = norm([rng.range(-1, 1), rng.range(-0.2, 1), rng.range(-1, 1)]);
          const p: V3 = [d[0] * S * 0.45, S * 0.45 + d[1] * S * 0.3, d[2] * S * 0.45];
          gb.ellipsoid(p, 0.035, 0.035, 0.035, 5, bs);
        }
      }
      break;
    }
    case 'deadbush': {
      const tw = P.twigs ?? 18;
      for (let i = 0; i < tw; i++) {
        const d = norm([rng.range(-1, 1), rng.range(0.2, 1.4) * (P.round ?? 0.6), rng.range(-1, 1)]);
        const L = S * rng.range(0.4, 0.75);
        const pts = curve([0, -0.05, 0], d, L, norm([rng.range(-1, 1), 0.3, rng.range(-1, 1)]), 0.25, hi ? 3 : 2);
        stalk(gb, pts, 0.02, 0.006, rng.chance(0.5) ? barkA : barkB, hi ? 3 : 3, rng.float(), Cell.BarkFibrous);
        if (hi && rng.chance(0.5)) {
          const m = pts[2];
          const d2 = norm(add(d, [rng.range(-0.8, 0.8), 0.2, rng.range(-0.8, 0.8)]));
          stalk(gb, curve(m, d2, L * 0.4, [0, -1, 0], 0.1, 2), 0.008, 0.003, barkB, 3, rng.float(), Cell.BarkFibrous);
        }
      }
      break;
    }
    case 'fern':
    case 'giantleaf': {
      const giant = sp.form === 'giantleaf';
      const n = giant ? (P.leaves ?? 6) : (P.fronds ?? 10);
      const arch = P.arch ?? 0.5;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
        const out: V3 = [Math.cos(ang), 0, Math.sin(ang)];
        const elev = giant ? rng.range(0.9, 1.4) : rng.range(0.5, 1.1);
        const L = S * rng.range(0.75, 1.05);
        const pts: V3[] = [];
        const m = hi ? 6 : 3;
        for (let k = 0; k <= m; k++) {
          const t = k / m;
          const h = Math.sin(t * Math.PI * 0.5 * (1 + arch * 0.3)) * L * (giant ? 0.75 : 0.55) * elev - t * t * arch * L * 0.35;
          pts.push([out[0] * L * t * (giant ? 0.45 : 0.85), h, out[2] * L * t * (giant ? 0.45 : 0.85)]);
        }
        if (giant) {
          // Petiole then a big heart leaf card at its tip, facing outward/up.
          stalk(gb, pts, 0.03, 0.015, leafB, hi ? 4 : 3, rng.float());
          const tip = pts[m];
          const up = norm(add(out, [0, 0.6, 0]));
          const right = norm(cross(UP, out));
          const sz = S * rng.range(0.55, 0.75);
          gb.card(tip, right, up, sz * 0.9, sz, style({ a: leafA, b: leafB, cell: Cell.LeafHeart, flutter: 0.6, phase: rng.float() }), norm(add(up, [0, 1, 0])), true);
        } else {
          const side = norm(cross(UP, out));
          const widths = pts.map((_, k) => S * 0.32 * Math.sin(Math.PI * Math.min(1, (k / m) * 0.9 + 0.1)));
          gb.strip(pts, pts.map(() => side), widths, style({ a: leafA, b: leafB, cell: Cell.LeafFern, phase: rng.float() }), null, [0, 1], [0, 1], (t) => t);
        }
      }
      break;
    }
    case 'flower':
    case 'emberbloom':
    case 'herb': {
      const isHerb = sp.form === 'herb';
      const ember = sp.form === 'emberbloom';
      const heads = isHerb ? 1 : (P.heads ?? 2);
      // Basal leaves.
      const nl = isHerb ? (P.leaves ?? 7) : 4;
      for (let i = 0; i < nl; i++) {
        const ang = (i / nl) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const out: V3 = [Math.cos(ang), 0, Math.sin(ang)];
        const up = norm(add(out, [0, isHerb ? 1.4 : 0.8, 0]));
        const sz = S * (isHerb ? 0.55 : 0.35);
        gb.card([0, 0, 0], norm(cross(UP, out)), up, sz * 0.6, sz, style({ a: leafA, b: isHerb ? acc : leafB, cell: isHerb && (P.style ?? 0) % 2 ? Cell.LeafLobed : Cell.LeafBroad, flutter: 0.5, phase: rng.float(), glow: isHerb ? sp.glow * 0.3 : 0 }), out, true);
      }
      const style_ = P.style ?? 0;
      for (let h = 0; h < heads; h++) {
        const d = norm([rng.range(-0.25, 0.25), 1, rng.range(-0.25, 0.25)]);
        const L = S * rng.range(0.75, 1.05);
        const pts = curve([rng.range(-0.04, 0.04), 0, rng.range(-0.04, 0.04)], d, L, norm([rng.range(-1, 1), 0, rng.range(-1, 1)]), 0.12, hi ? 3 : 2);
        stalk(gb, pts, 0.012, 0.007, ember ? lin(sp.leaf) : leafB, 3, rng.float());
        const top = pts[pts.length - 1];
        const headStyle = style({ a: acc, b: ember ? [1, 0.9, 0.5] : mulc(acc, 0.5), cell: Cell.Petal, glow: sp.glow, flutter: 0.3, phase: rng.float() });
        const sz = S * 0.18 * (P.petalLen ?? 1);
        if (isHerb) {
          // Herbs: a small cluster of buds/berries (mask = accent).
          const bs = style({ a: acc, b: acc, cell: Cell.Plain, glow: sp.glow });
          const nb = P.berries ? 6 : 3;
          for (let k = 0; k < nb; k++) gb.ellipsoid(add(top, [rng.range(-0.04, 0.04), rng.range(-0.03, 0.04), rng.range(-0.04, 0.04)]), 0.02 + S * 0.03, 0.02 + S * 0.03, 0.02 + S * 0.03, 5, bs);
        } else if (style_ === 0 || ember) {
          // Radial head (daisy / ember star): petals as cards around the center.
          const np = P.petals ?? 7;
          const nrm: V3 = norm(add(sub(top, pts[pts.length - 2]), [0, 0.5, 0]));
          const ax = perp(nrm);
          for (let k = 0; k < np; k++) {
            const pd = rotate(ax, nrm, (k / np) * Math.PI * 2);
            const pu = norm(add(pd, scale(nrm, ember ? 0.5 : 0.15)));
            gb.card(top, norm(cross(nrm, pd)), pu, sz * 0.55, sz, headStyle, nrm, true);
          }
          gb.ellipsoid(add(top, scale(nrm, 0.01)), sz * 0.22, sz * 0.12, sz * 0.22, 6, style({ a: ember ? [1, 0.85, 0.4] : [0.95, 0.8, 0.25], b: acc, cell: Cell.Plain, glow: ember ? 1 : 0 }));
        } else if (style_ === 1) {
          // Hanging bells.
          const nbells = 3;
          for (let k = 0; k < nbells; k++) {
            const p = add(top, [rng.range(-0.08, 0.08), -k * sz * 0.5, rng.range(-0.08, 0.08)]);
            gb.lathe(p, [[0.001, 0], [sz * 0.35, -sz * 0.15], [sz * 0.42, -sz * 0.65], [sz * 0.55, -sz * 0.8]], 7, style({ a: acc, b: mulc(acc, 0.6), cell: Cell.Plain, glow: sp.glow }));
          }
        } else if (style_ === 2) {
          // Spike (lupine): stacked small petal pairs up the stalk.
          for (let k = 0; k < 8; k++) {
            const t = 0.45 + k * 0.07;
            const p = lerp3(pts[0], top, t);
            const r = rotate([1, 0, 0], UP, k * 2.4);
            gb.card(p, r, norm([r[0] * 0.6, 1, r[2] * 0.6]), sz * 0.5 * (1.2 - t), sz * 0.6 * (1.2 - t), headStyle, null, true);
          }
        } else if (style_ === 3) {
          // Umbel: many tiny flower heads on spokes.
          for (let k = 0; k < 9; k++) {
            const r = rotate([1, 0, 0], UP, k * 0.7);
            const p = add(top, [r[0] * sz * 0.6, sz * 0.2, r[2] * sz * 0.6]);
            gb.card(p, [1, 0, 0], [0, 0, 1], sz * 0.55, sz * 0.55, style({ a: acc, b: [1, 0.9, 0.6], cell: Cell.FlowerHead, flutter: 0.2 }), [0, 1, 0], false);
          }
        } else {
          // Tulip cup.
          gb.lathe(top, [[0.001, -sz * 0.1], [sz * 0.35, 0], [sz * 0.45, sz * 0.5], [sz * 0.3, sz * 0.9]], 8, style({ a: acc, b: mulc(acc, 0.7), cell: Cell.Petal, glow: sp.glow }));
        }
      }
      break;
    }
    case 'mushroom':
    case 'glowshroom': {
      const count = P.count ?? 3;
      for (let i = 0; i < count; i++) {
        const k = i === 0 ? 1 : rng.range(0.45, 0.8);
        const a = rng.float() * Math.PI * 2, r = i === 0 ? 0 : rng.range(0.05, 0.18) * S * 3;
        const h = S * k * rng.range(0.8, 1.2);
        const base: V3 = [Math.cos(a) * r, 0, Math.sin(a) * r];
        const pts = curve(base, norm([rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)]), h, [1, 0, 0], 0.05, 3);
        const sr = S * 0.08 * k;
        gb.tube(pts, [sr * 1.3, sr, sr * 0.9, sr * 0.85], hi ? 6 : 4, style({ a: barkA, b: barkA, cell: Cell.Stem, glow: sp.glow * 0.3 }));
        const top = style({ a: leafA, b: P.spots ? lin(sp.accent) : leafA, cell: Cell.Cap, glow: sp.glow });
        const under = style({ a: mulc(barkA, 0.9), b: acc, cell: Cell.Gills, glow: sp.glow });
        mushroomCap(gb, pts[3], S * 0.35 * k, P.capStyle ?? 0, sr * 0.85, top, under, hi ? 12 : 7);
      }
      break;
    }
    case 'glowshelf': {
      // Bracket fungi on walls: half-discs stacked; +Y is the wall normal → shelves stick out along +Y.
      const n = P.shelves ?? 3;
      for (let i = 0; i < n; i++) {
        const R = S * rng.range(0.25, 0.45);
        const c: V3 = [rng.range(-S * 0.3, S * 0.3), 0, rng.range(-S * 0.4, S * 0.4)];
        // Build a disc in the plane spanned by +Y (out from wall) and X; attach edge at y=0.
        const prof: [number, number][] = [[R, 0], [R * 0.95, R * 0.12], [R * 0.6, R * 0.2], [0.001, R * 0.22]];
        const sub = new GeoBuilder();
        sub.lathe([0, 0, 0], prof, 10, style({ a: leafA, b: acc, cell: Cell.Cap, glow: sp.glow }));
        sub.lathe([0, 0, 0], [[0.001, -0.01], [R * 0.98, -0.005]], 10, style({ a: barkA, b: acc, cell: Cell.Gills, glow: sp.glow }));
        // Rotate so the disc axis is along Z (parallel to wall), then move its center out along +Y by R.
        for (let k = 0; k < sub.pos.length; k += 3) {
          const x = sub.pos[k], y = sub.pos[k + 1], z = sub.pos[k + 2];
          sub.pos[k] = x + c[0];
          sub.pos[k + 1] = z * 0.6 + R * 0.6;
          sub.pos[k + 2] = -y + c[2];
          const nx = sub.nrm[k], ny = sub.nrm[k + 1], nz = sub.nrm[k + 2];
          sub.nrm[k] = nx;
          sub.nrm[k + 1] = nz;
          sub.nrm[k + 2] = -ny;
        }
        gb.merge(sub);
      }
      break;
    }
    case 'sporepod': {
      const pods = P.pods ?? 4;
      for (let i = 0; i < pods; i++) {
        const a = rng.float() * Math.PI * 2, r = i === 0 ? 0 : rng.range(0.05, 0.25) * S;
        const h = S * (P.stalk ?? 0.5) * rng.range(0.3, 1);
        const base: V3 = [Math.cos(a) * r, 0, Math.sin(a) * r];
        const pts = curve(base, norm([rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)]), Math.max(0.03, h), [1, 0, 0], 0.1, 2);
        if (h > 0.05) stalk(gb, pts, 0.02, 0.015, mulc(leafA, 0.8), 4, rng.float());
        const pr = S * rng.range(0.14, 0.24);
        gb.ellipsoid(add(pts[2], [0, pr * 0.8, 0]), pr, pr * 1.1, pr, hi ? 10 : 6, style({ a: leafA, b: acc, cell: Cell.Cap, glow: sp.glow }), (d) => 1 + 0.06 * Math.sin(d[0] * 9) * Math.sin(d[2] * 7));
      }
      break;
    }
    case 'barrel': {
      const ribs = P.ribs ?? 14;
      if (P.pads) {
        // Prickly pear: flat oval pads stacked.
        const pad = (c: V3, ang: number, s: number, depth: number) => {
          const sub = new GeoBuilder();
          sub.ellipsoid([0, s * 0.5, 0], s * 0.36, s * 0.5, s * 0.1, hi ? 10 : 6, style({ a: barkA, b: [0.95, 0.92, 0.8], cell: Cell.Cactus }));
          transformAll(sub, 1, ang, c);
          gb.merge(sub);
          if (depth > 0)
            for (let k = 0; k < 2; k++) if (rng.chance(0.75)) pad(add(c, [Math.cos(ang) * s * 0.0, s * 0.85, Math.sin(ang) * s * 0.0 + (k ? 0.1 : -0.1) * s]), ang + rng.range(-0.8, 0.8), s * 0.8, depth - 1);
        };
        pad([0, -0.05, 0], rng.float() * 3, S * 0.6, 2);
      } else {
        const prof: [number, number][] = [];
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          prof.push([S * 0.45 * Math.sin(Math.PI * (0.15 + t * 0.85)) + 0.01, -0.05 + t * S * 0.85]);
        }
        gb.lathe([0, 0, 0], prof, hi ? 20 : 10, style({ a: barkA, b: [0.95, 0.9, 0.7], cell: Cell.Cactus }), { ribFn: (a) => 1 + 0.09 * Math.cos(a * ribs), vScale: 1.2 });
      }
      if (P.flower) gb.card([0, S * (P.pads ? 1.25 : 0.85), 0], [1, 0, 0], [0, 0, 1], S * 0.35, S * 0.35, style({ a: acc, b: [1, 0.95, 0.6], cell: Cell.FlowerHead }), [0, 1, 0], false);
      break;
    }
    case 'succulent': {
      const n = P.leaves ?? 12;
      for (let i = 0; i < n; i++) {
        const ang = i * 2.39996;
        const t = i / n;
        const out: V3 = [Math.cos(ang), 0, Math.sin(ang)];
        const up = norm(add(out, [0, 0.6 + t * 1.6, 0]));
        const L = S * (1 - t * 0.55);
        const pts = curve([0, 0, 0], up, L, out, (P.spike ?? 0.5) * -0.15, 3);
        const widths = [S * 0.18 * (1 - t * 0.4), S * 0.16 * (1 - t * 0.4), S * 0.1, S * 0.01];
        gb.strip(pts, pts.map(() => norm(cross(UP, out))), widths, style({ a: leafA, b: acc, cell: Cell.Plain, phase: rng.float() }), null);
      }
      if (P.flower && hi) {
        const pts = curve([0, 0, 0], [0, 1, 0], S * 1.6, [1, 0, 0], 0.1, 3);
        stalk(gb, pts, 0.02, 0.01, leafB, 4, 0);
        for (let k = 0; k < 5; k++) gb.ellipsoid(lerp3(pts[2], pts[3], k / 5), 0.03, 0.05, 0.03, 5, style({ a: acc, b: acc, cell: Cell.Plain }));
      }
      break;
    }
    case 'reed': {
      const n = P.stems ?? 12;
      for (let i = 0; i < n; i++) {
        const a = rng.float() * Math.PI * 2, r = rng.range(0, S * 0.18);
        const d = norm([rng.range(-0.12, 0.12), 1, rng.range(-0.12, 0.12)]);
        const L = S * rng.range(0.7, 1.05);
        const base: V3 = [Math.cos(a) * r, -0.1, Math.sin(a) * r];
        const pts = curve(base, d, L, [d[0], 0, d[2]], 0.2, 3);
        stalk(gb, pts, 0.014, 0.006, leafA, 3, rng.float());
        if (rng.chance(P.heads ?? 0.6)) {
          // Cattail head.
          const top = pts[3];
          const dd = norm(sub(pts[3], pts[2]));
          gb.tube([add(top, scale(dd, -0.25)), add(top, scale(dd, -0.05))], [0.03, 0.03], 5, style({ a: barkA, b: barkA, cell: Cell.BarkFibrous }), { capEnd: true, capStart: true });
        }
        // Blade leaves.
        if (hi && i % 2 === 0) {
          const bd = norm([rng.range(-0.5, 0.5), 1, rng.range(-0.5, 0.5)]);
          const bp = curve(base, bd, L * 0.8, [bd[0], -0.3, bd[2]], 0.4, 3);
          gb.strip(bp, bp.map(() => norm(cross(UP, [bd[0], 0, bd[2]]))), [0.05, 0.04, 0.03, 0.005], style({ a: leafA, b: leafB, cell: Cell.Plain, phase: rng.float() }), null, [0, 1], [0, 1], (t) => t * 0.5);
        }
      }
      break;
    }
    case 'lilypad': {
      const n = P.pads ?? 4;
      for (let i = 0; i < n; i++) {
        const a = rng.float() * Math.PI * 2, r = i === 0 ? 0 : rng.range(0.3, 0.9) * S;
        const R = S * rng.range(0.25, 0.45);
        const c: V3 = [Math.cos(a) * r, 0.01, Math.sin(a) * r];
        // Disc with a notch (fan of triangles leaving out a wedge).
        const notch = rng.float() * Math.PI * 2;
        const s = style({ a: leafA, b: leafB, cell: Cell.LeafHeart, flutter: 0.1, phase: rng.float() });
        const ci = gb.vertex(c, [0, 1, 0], 0.5, 0.5, s);
        const seg = hi ? 16 : 8;
        let prev = -1;
        for (let k = 0; k <= seg; k++) {
          const ang = notch + 0.25 + (k / seg) * (Math.PI * 2 - 0.5);
          const v = gb.vertex([c[0] + Math.cos(ang) * R, 0.01, c[2] + Math.sin(ang) * R], [0, 1, 0], 0.5 + Math.cos(ang) * 0.45, 0.5 + Math.sin(ang) * 0.45, s);
          if (prev >= 0) gb.tri(ci, v, prev);
          prev = v;
        }
      }
      if (rng.float() < (P.flower ?? 0.4)) {
        const fs = style({ a: acc, b: [1, 0.95, 0.6], cell: Cell.Petal, glow: sp.glow });
        for (let k = 0; k < 8; k++) {
          const pd = rotate([1, 0, 0], UP, (k / 8) * Math.PI * 2);
          gb.card([0, 0.03, 0], norm(cross(UP, pd)), norm(add(pd, [0, 0.9, 0])), 0.1, 0.2, fs, [0, 1, 0], true);
        }
      }
      break;
    }
    case 'kelp': {
      const n = P.strands ?? 4;
      for (let i = 0; i < n; i++) {
        const a = rng.float() * Math.PI * 2;
        const L = S * rng.range(0.6, 1.0);
        const pts: V3[] = [];
        const m = hi ? 10 : 5;
        for (let k = 0; k <= m; k++) {
          const t = k / m;
          pts.push([Math.cos(a) * 0.15 + Math.sin(t * 6 + i) * 0.25 * t, t * L, Math.sin(a) * 0.15 + Math.cos(t * 5 + i) * 0.25 * t]);
        }
        const side = rotate([1, 0, 0], UP, a);
        gb.bendFn = (p) => Math.max(0, p[1]) * 0.15;
        gb.strip(pts, pts.map(() => side), pts.map(() => S * 0.07), style({ a: leafA, b: mulc(leafA, 1.3), cell: Cell.Kelp, phase: rng.float() }), null, [L / (S * 0.5), 0], [0, 1], () => 0.8);
      }
      break;
    }
    case 'coral': {
      const branchy = (P.style ?? 0) === 0;
      const s = style({ a: leafA, b: acc, cell: Cell.Plain, glow: sp.glow });
      if (branchy) {
        const grow = (p: V3, d: V3, L: number, r: number, depth: number) => {
          const pts = curve(p, d, L, norm([rng.range(-1, 1), 0.5, rng.range(-1, 1)]), 0.2, 2);
          gb.tube(pts, [r, r * 0.8, r * 0.6], hi ? 5 : 3, s, { capEnd: depth === 0 });
          if (depth > 0) for (let k = 0; k < 2; k++) grow(pts[2], norm(add(d, [rng.range(-0.8, 0.8), 0.3, rng.range(-0.8, 0.8)])), L * 0.7, r * 0.65, depth - 1);
        };
        const nb = Math.min(6, P.branches ?? 6);
        for (let i = 0; i < nb; i++) grow([rng.range(-0.1, 0.1), -0.05, rng.range(-0.1, 0.1)], norm([rng.range(-0.6, 0.6), 1, rng.range(-0.6, 0.6)]), S * 0.4, S * 0.05, 2);
      } else {
        // Brain / fan coral: lumpy dome or vertical fan.
        if (rng.chance(0.5)) gb.ellipsoid([0, S * 0.15, 0], S * 0.45, S * 0.35, S * 0.45, hi ? 14 : 8, s, (d) => 1 + 0.08 * Math.sin(d[0] * 15) * Math.sin(d[2] * 13));
        else {
          const right: V3 = [1, 0, 0];
          gb.card([0, -0.05, 0], right, [0, 1, 0], S * 0.9, S * 0.8, style({ a: leafA, b: acc, cell: Cell.LeafLobed, glow: sp.glow }), null, true);
        }
      }
      break;
    }
    case 'vine':
    case 'root': {
      // Hanging strands (+Y = down after the scatter flips them). Vines: leafy strips; roots: tapered tubes.
      const n = P.strands ?? 5;
      const root = sp.form === 'root';
      for (let i = 0; i < n; i++) {
        const a = rng.float() * Math.PI * 2, r = rng.range(0, S * 0.12);
        const L = S * rng.range(0.4, 1);
        const pts: V3[] = [];
        const m = hi ? 8 : 4;
        for (let k = 0; k <= m; k++) {
          const t = k / m;
          pts.push([Math.cos(a) * r + Math.sin(t * 4 + i) * 0.15 * t, t * L, Math.sin(a) * r + Math.cos(t * 3 + i) * 0.15 * t]);
        }
        gb.bendFn = (p) => Math.max(0, p[1]) * 0.08;
        if (root) {
          gb.tube(pts, pts.map((_, k) => S * 0.035 * (1 - k / (m + 1)) + 0.01), hi ? 5 : 3, style({ a: barkA, b: acc, cell: Cell.BarkFibrous, glow: sp.glow, phase: rng.float() }), { vScale: 0.5 });
          if (sp.glow > 0 && hi) gb.ellipsoid(pts[m], 0.05, 0.08, 0.05, 5, style({ a: acc, b: acc, cell: Cell.Cap, glow: sp.glow }));
        } else {
          const side = rotate([1, 0, 0], UP, a);
          for (const sd of [side, rotate(side, UP, Math.PI / 2)]) {
            gb.strip(pts, pts.map(() => sd), pts.map((_, k) => 0.3 * (1 - (k / m) * 0.4)), style({ a: leafA, b: acc, cell: Cell.VineLeaf, phase: rng.float() }), null, [0, L / 0.8], [0, 1], () => 0.8);
          }
        }
      }
      break;
    }
    case 'moss':
    case 'lichen': {
      // Flat patches hugging the surface (+Y = surface normal).
      const n = P.blobs ?? 5;
      const cell = sp.form === 'moss' ? Cell.Moss : Cell.Lichen;
      for (let i = 0; i < n; i++) {
        const a = rng.float() * Math.PI * 2, r = rng.range(0, S * 0.45);
        const sz = S * rng.range(0.45, 0.85);
        const right = rotate([1, 0, 0], UP, rng.float() * Math.PI * 2);
        const c: V3 = [Math.cos(a) * r, 0.03 + i * 0.004, Math.sin(a) * r];
        gb.card(c, right, norm(cross(right, [0, 1, 0])), sz, sz, style({ a: leafA, b: sp.form === 'moss' ? lin(sp.leaf2) : leafB, cell, glow: sp.glow, flutter: 0 }), [0, 1, 0], false);
      }
      break;
    }
    case 'crystal': {
      const n = P.shards ?? 6;
      const spread = P.spread ?? 0.5;
      const s = style({ a: leafA, b: leafB, cell: Cell.Crystal, glow: sp.glow });
      for (let i = 0; i < n; i++) {
        const d = norm([rng.range(-spread, spread), 1, rng.range(-spread, spread)]);
        const L = S * rng.range(0.4, 1) * (i === 0 ? 1.1 : 1);
        gb.crystal([rng.range(-0.1, 0.1) * S, -0.1 * S, rng.range(-0.1, 0.1) * S], d, L, L * rng.range(0.12, 0.2), P.facets ?? 5, s, rng.float());
      }
      break;
    }
    case 'saltcrust': {
      const n = P.shards ?? 8;
      const s = style({ a: barkA, b: lin(sp.leaf), cell: Cell.Crystal, glow: 0 });
      for (let i = 0; i < n; i++) {
        const d = norm([rng.range(-0.9, 0.9), rng.range(0.4, 1), rng.range(-0.9, 0.9)]);
        const L = S * rng.range(0.25, 0.6);
        gb.crystal([rng.range(-0.3, 0.3) * S, -0.08, rng.range(-0.3, 0.3) * S], d, L, L * 0.3, 4, s, rng.float());
      }
      break;
    }
    case 'floatbloom': {
      // A tethered balloon-flower hovering above the ground.
      const bulbs = P.bulbs ?? 2;
      for (let i = 0; i < bulbs; i++) {
        const a = rng.float() * Math.PI * 2;
        const top: V3 = [Math.cos(a) * S * 0.25 * i, S * rng.range(0.7, 1.0), Math.sin(a) * S * 0.25 * i];
        const pts: V3[] = [[0, 0, 0], [top[0] * 0.3 + 0.05, top[1] * 0.4, top[2] * 0.3], [top[0] * 0.8, top[1] * 0.8, top[2] * 0.8], top];
        stalk(gb, pts, 0.01, 0.006, leafA, 3, rng.float());
        const R = S * rng.range(0.12, 0.18);
        gb.ellipsoid(add(top, [0, R, 0]), R, R * 1.15, R, hi ? 12 : 7, style({ a: acc, b: leafB, cell: Cell.Cap, glow: sp.glow, bend: 0.15 }));
        for (let k = 0; k < 5; k++) {
          const pd = rotate([1, 0, 0], UP, (k / 5) * Math.PI * 2);
          gb.card(add(top, [0, R * 0.2, 0]), norm(cross(UP, pd)), norm(add(pd, [0, -0.6, 0])), R * 0.9, R * 1.6, style({ a: leafA, b: acc, cell: Cell.Petal, flutter: 0.8 }), pd, true);
        }
      }
      break;
    }
    case 'bones': {
      const bs = style({ a: barkA, b: mulc(barkA, 0.7), cell: Cell.Bone });
      if ((P.style ?? 0) === 1) {
        // Giant ribcage arching out of the ground + spine.
        const ribs = P.ribs ?? 8;
        const spine: V3[] = [];
        for (let k = 0; k <= 8; k++) spine.push([0, S * 0.08 + Math.sin(k / 8 * Math.PI) * S * 0.08, -S * 0.5 + (k / 8) * S]);
        gb.tube(spine, spine.map(() => S * 0.03), hi ? 6 : 4, bs);
        for (let i = 0; i < ribs; i++) {
          const z = -S * 0.4 + (i / (ribs - 1)) * S * 0.8;
          const h = S * 0.45 * Math.sin(Math.PI * (0.15 + 0.7 * i / (ribs - 1)));
          for (const sgn of [-1, 1]) {
            const pts: V3[] = [];
            for (let k = 0; k <= 6; k++) {
              const t = k / 6;
              pts.push([sgn * Math.sin(t * Math.PI * 0.85) * h * 0.75, S * 0.1 + Math.sin(t * Math.PI) * h * 0.2 + (1 - t) * h * 0.05 - t * t * S * 0.12 + h * 0.6 * Math.sin(t * Math.PI * 0.6), z]);
            }
            gb.tube(pts, pts.map((_, k) => S * 0.022 * (1 - k / 10)), hi ? 5 : 3, bs, { capEnd: true });
          }
        }
      } else {
        // Skull + scattered long bones.
        const sk = S * 0.22;
        gb.ellipsoid([0, sk * 0.8, 0], sk, sk * 0.85, sk * 1.2, hi ? 10 : 6, bs, (d) => 1 - 0.25 * Math.max(0, -d[1]) * Math.max(0, d[2]));
        for (let i = 0; i < 3; i++) {
          const a = rng.float() * Math.PI * 2;
          const p0: V3 = [Math.cos(a) * S * 0.3, 0.04, Math.sin(a) * S * 0.3];
          const d = rotate([1, 0, 0], UP, rng.float() * Math.PI * 2);
          gb.tube([p0, add(p0, scale(d, S * 0.5))], [0.035, 0.03], hi ? 5 : 3, bs, { capEnd: true, capStart: true });
        }
      }
      break;
    }
    case 'log':
    case 'driftwood': {
      // Fallen trunk lying along X with broken ends, roots/branches stubs, moss on top.
      const R = (P.r ?? 0.3) * (sp.form === 'driftwood' ? 1 : 1);
      const L = S;
      const pts: V3[] = [];
      const m = hi ? 8 : 4;
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        pts.push([-L / 2 + t * L, R * 0.75 + Math.sin(t * 3 + variant) * R * 0.15, Math.sin(t * 2.3 + variant * 2) * R * 0.5]);
      }
      const cell = P.charred ? Cell.BarkEmber : sp.form === 'driftwood' ? Cell.BarkFibrous : Cell.BarkRough;
      const moss = P.moss ?? 0;
      const s = style({ a: barkA, b: P.charred ? acc : moss > 0 ? lin([0.3, 0.45, 0.15]) : barkB, cell, glow: sp.glow });
      gb.tube(pts, pts.map((_, k) => R * (1 - k / m * 0.25)), hi ? 9 : 5, s, { vScale: 0.5, uRepeat: 2, capEnd: true, capStart: true });
      for (let i = 0; i < (hi ? 3 : 1); i++) {
        const t = rng.range(0.2, 0.8);
        const p = lerp3(pts[0], pts[m], t);
        const d = norm([rng.range(-0.3, 0.3), rng.range(0.3, 1), rng.range(-1, 1)]);
        gb.tube([p, add(p, scale(d, R * 3))], [R * 0.3, R * 0.12], 4, s, { capEnd: true });
      }
      break;
    }
    default: {
      leafBall(gb, [0, S * 0.5, 0], S * 0.4, 6, S * 0.5, leafA, leafB, Cell.LeafBroad, rng);
    }
  }
  return gb;
}

