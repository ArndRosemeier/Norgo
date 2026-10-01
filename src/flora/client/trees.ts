/**
 * Procedural tree growth.
 *
 * Each species is grown once per variant into a *skeleton* (branch polylines
 * with radii + leaf spots), from which meshes for several detail tiers are
 * emitted:
 *   tier 0: full tubes, every leaf card              (LOD-0 chunks, near)
 *   tier 1: coarser tubes, half the cards ×1.45      (LOD-1 chunks)
 *   tier 2: trunk + limbs, a quarter of the cards ×2 (LOD-2 chunks)
 * Tier 3 is an impostor (see impostors.ts).
 *
 * Growth algorithms (selected by species.form):
 *   recursive parametric branching   oak, kapok, birch, acacia, baobab, juniper, snag, charred, mangrove, emergent, glasstree
 *   whorled excurrent                fir, pine
 *   pendulous strands                willow
 *   curved monopodial + fronds       palm
 *   clumped culms                    bamboo
 *   lathe-based                      giantshroom, saguaro, bulb, umbrella
 *   helical                          spiral
 */
import { Rng } from '../../core/rng';
import type { FloraSpecies } from '../species';
import { Cell } from './atlas';
import { GeoBuilder, V3, VertexStyle, add, cross, len, lerp3, lin, mulc, norm, perp, rotate, scale, style, sub } from './geo';

interface Seg {
  pts: V3[];
  rad: number[];
  level: number;
  phase: number;
  /** Rendered as a tube (false = leaf-bearing virtual twig). */
  solid: boolean;
}

interface LeafSpot {
  p: V3;
  /** Card up axis (twig direction). */
  up: V3;
  /** Card right axis. */
  right: V3;
  size: number;
  phase: number;
  /** Use color B (second leaf color) for this card. */
  alt: boolean;
  /** Card aspect (w/h). */
  aspect: number;
}

interface Extra {
  /** Additional geometry emitted for each tier (fins, fronds, caps...). */
  build: (g: GeoBuilder, tier: number) => void;
}

export interface Skeleton {
  segs: Seg[];
  leaves: LeafSpot[];
  height: number;
  crown: V3;
  leafCell: Cell;
  barkCell: Cell;
  extras: Extra[];
}

interface LevelSpec {
  children: [number, number];
  start: number;
  end: number;
  angle: [number, number];
  lenRatio: number;
  radRatio: number;
  gravity: number;
  wobble: number;
  segs: number;
  /** Child length shape over its attach position t. */
  shape?: (t: number) => number;
  /** Leaves on this level's branches: count per meter, start fraction. */
  leaves?: { perM: number; from: number };
  /** Branches of this level are virtual (no tube). */
  virtual?: boolean;
}

const UP: V3 = [0, 1, 0];

/** Point and direction along a polyline at fraction t. */
function along(pts: V3[], t: number): { p: V3; d: V3; i: number } {
  const n = pts.length - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(f);
  const k = f - i;
  return { p: lerp3(pts[i], pts[i + 1], k), d: norm(sub(pts[i + 1], pts[i])), i };
}

function radAt(rad: number[], t: number): number {
  const n = rad.length - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(f);
  return rad[i] + (rad[i + 1] - rad[i]) * (f - i);
}

class Grower {
  sk: Skeleton;
  constructor(readonly rng: Rng, height: number, leafCell: Cell, barkCell: Cell) {
    this.sk = { segs: [], leaves: [], height, crown: [0, height * 0.7, 0], leafCell, barkCell, extras: [] };
  }

  /** Grow a branch polyline from p along d, then recurse into children per level specs. */
  branch(p: V3, d: V3, length: number, radius: number, level: number, specs: LevelSpec[], tipRadius = 0.25, leafSize = 1, leafAspect = 1) {
    const spec = specs[level];
    const rng = this.rng;
    const segs = Math.max(2, spec ? spec.segs : 3);
    const pts: V3[] = [p];
    const rad: number[] = [radius];
    let dir = norm(d);
    let cur = p;
    const sl = length / segs;
    const wob = spec ? spec.wobble : 0.15;
    const grav = spec ? spec.gravity : 0;
    for (let s = 1; s <= segs; s++) {
      dir = norm(add(add(dir, [rng.range(-wob, wob), rng.range(-wob, wob) * 0.5, rng.range(-wob, wob)]), scale(UP, grav * sl / Math.max(1, length * 0.25))));
      cur = add(cur, scale(dir, sl));
      pts.push(cur);
      rad.push(radius * (1 - (s / segs) * (1 - tipRadius)));
    }
    const isVirtual = !!spec?.virtual;
    this.sk.segs.push({ pts, rad, level, phase: rng.float(), solid: !isVirtual });
    // Leaves along this branch.
    if (spec?.leaves) {
      const n = Math.max(1, Math.round(length * spec.leaves.perM));
      for (let i = 0; i < n; i++) {
        const t = spec.leaves.from + (1 - spec.leaves.from) * ((i + rng.float()) / n);
        const a = along(pts, t);
        this.leaf(a.p, a.d, leafSize * rng.range(0.8, 1.2), leafAspect);
      }
    }
    const next = specs[level + 1];
    if (!next) return;
    const nc = rng.int(next.children[0], next.children[1]);
    const roll0 = rng.float() * Math.PI * 2;
    for (let c = 0; c < nc; c++) {
      const t = next.start + (next.end - next.start) * ((c + rng.range(0.2, 0.8)) / nc);
      const a = along(pts, t);
      const ang = rng.range(next.angle[0], next.angle[1]);
      // Phyllotaxis: golden-angle roll around the parent axis.
      const axis = rotate(perp(a.d), a.d, roll0 + c * 2.39996 + rng.range(-0.3, 0.3));
      const cd = rotate(a.d, axis, ang);
      const shape = next.shape ? next.shape(t) : 1;
      const cl = length * next.lenRatio * shape * rng.range(0.85, 1.15);
      const cr = radAt(rad, t) * next.radRatio;
      if (cl < 0.05) continue;
      this.branch(a.p, cd, cl, cr, level + 1, specs, tipRadius, leafSize, leafAspect);
    }
  }

  leaf(p: V3, d: V3, size: number, aspect = 1) {
    const rng = this.rng;
    // Twig-aligned card with random roll, slightly turned upward.
    const up = norm(add(d, [rng.range(-0.4, 0.4), rng.range(0, 0.5), rng.range(-0.4, 0.4)]));
    const right = norm(rotate(perp(up), up, rng.float() * Math.PI * 2));
    this.sk.leaves.push({ p: add(p, scale(up, -size * 0.15)), up, right, size, phase: rng.float(), alt: rng.chance(0.3), aspect });
  }
}

// ------------------------------------------------------------------ growth by form

export function growTree(sp: FloraSpecies, variant: number): Skeleton {
  const rng = new Rng(sp.seed ^ Math.imul(variant + 1, 0x9e3779b1));
  const H = sp.size * rng.range(0.9, 1.1);
  const P = sp.p;
  const tr = P.trunkR ?? 0.3;
  const leafSize = (P.leafSize ?? 1.2) * 1.3 * Math.max(0.8, H / 14);
  switch (sp.form) {
    case 'oak':
    case 'kapok':
    case 'mangrove': {
      const lobed = sp.form === 'oak' && (sp.seed & 1) === 1;
      const g = new Grower(rng, H, lobed ? Cell.LeafLobed : Cell.LeafBroad, Cell.BarkRough);
      const crownW = (P.crownW ?? 1) * H * 0.5;
      const trunkFrac = P.trunkFrac ?? 0.35;
      const gnarl = P.gnarl ?? 0.25;
      const flat = sp.form === 'kapok';
      const base = sp.form === 'mangrove' ? (P.rootH ?? 1.8) : -0.4;
      const trunkLen = H * (trunkFrac + 0.3) - base;
      const dens = P.density ?? 1;
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0.05, wobble: gnarl * 0.25, segs: 7 },
        {
          children: [4, 7], start: trunkFrac / (trunkFrac + 0.3), end: 1, angle: flat ? [0.95, 1.3] : [0.45, 0.95], lenRatio: crownW / trunkLen * 1.25, radRatio: 0.62,
          gravity: flat ? 0.02 : 0.12, wobble: 0.12 + gnarl * 0.3, segs: 5, shape: (t) => 0.75 + 0.35 * Math.sin(Math.PI * t),
        },
        { children: [3, 5], start: 0.25, end: 1, angle: [0.45, 0.9], lenRatio: 0.55, radRatio: 0.55, gravity: -0.04, wobble: 0.2, segs: 3 },
        { children: [3, 4], start: 0.3, end: 1, angle: [0.4, 0.9], lenRatio: 0.45, radRatio: 0.5, gravity: 0.05, wobble: 0.25, segs: 2, virtual: true, leaves: { perM: 2.4 * dens, from: 0.1 } },
      ];
      g.branch([0, base, 0], [rng.range(-0.05, 0.05), 1, rng.range(-0.05, 0.05)], trunkLen, tr, 0, specs, 0.3, leafSize);
      g.sk.crown = [0, H * (trunkFrac + 0.35), 0];
      if (sp.form === 'kapok' || (P.buttress ?? 0) > 0) buttress(g, tr, P.buttress ?? 0.5, sp);
      if (sp.form === 'mangrove') propRoots(g, tr, base, P.roots ?? 8);
      return g.sk;
    }
    case 'birch': {
      const g = new Grower(rng, H, Cell.LeafSmall, Cell.BarkBirch);
      const droop = P.droop ?? 0.2;
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.04, segs: 8 },
        { children: [12, 18], start: 0.3, end: 0.97, angle: [0.45, 0.85], lenRatio: 0.3, radRatio: 0.4, gravity: -droop * 0.5, wobble: 0.15, segs: 4, shape: (t) => 1.15 - t * 0.75, leaves: { perM: 1.6, from: 0.4 } },
        { children: [2, 4], start: 0.3, end: 1, angle: [0.4, 0.8], lenRatio: 0.45, radRatio: 0.5, gravity: -droop, wobble: 0.2, segs: 2, virtual: true, leaves: { perM: 3, from: 0.1 } },
      ];
      const lean = P.lean ?? 0.05;
      g.branch([0, -0.3, 0], [rng.range(-lean, lean), 1, rng.range(-lean, lean)], H, tr, 0, specs, 0.08, leafSize * 0.85);
      g.sk.crown = [0, H * 0.65, 0];
      return g.sk;
    }
    case 'willow': {
      const g = new Grower(rng, H, Cell.LeafWillow, Cell.BarkRough);
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.08, segs: 5 },
        { children: [3, 5], start: 0.85, end: 1, angle: [0.4, 0.75], lenRatio: 0.9, radRatio: 0.6, gravity: 0.08, wobble: 0.15, segs: 4 },
        { children: [3, 5], start: 0.3, end: 1, angle: [0.5, 1.0], lenRatio: 0.55, radRatio: 0.5, gravity: -0.05, wobble: 0.15, segs: 3 },
      ];
      g.branch([0, -0.3, 0], [0, 1, 0], H * 0.45, tr, 0, specs, 0.3, leafSize);
      // Pendulous strands from the outer branches.
      const ends = g.sk.segs.filter((s) => s.level >= 1);
      const strands = P.strands ?? 26;
      const curtains: { pts: V3[]; w: number; phase: number }[] = [];
      for (let i = 0; i < strands; i++) {
        const s = ends[i % ends.length];
        const a = along(s.pts, rng.range(0.4, 1));
        const pts: V3[] = [a.p];
        const out = norm([a.p[0], 0, a.p[2]]);
        const drop = Math.max(1.5, (a.p[1] - 0.6) * (P.droop ?? 0.8) * rng.range(0.8, 1.05));
        const n = 6;
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          pts.push([a.p[0] + out[0] * 0.6 * Math.sin(t * 1.4) + rng.range(-0.05, 0.05), a.p[1] + 0.25 * Math.sin(t * 2.2) - drop * t * t * 0.9 - drop * t * 0.1, a.p[2] + out[2] * 0.6 * Math.sin(t * 1.4)]);
        }
        curtains.push({ pts, w: leafSize * rng.range(0.45, 0.65), phase: rng.float() });
      }
      g.sk.crown = [0, H * 0.6, 0];
      const leafA = lin(sp.leaf), leafB = lin(sp.leaf2);
      g.sk.extras.push({
        build: (gb, tier) => {
          const step = tier === 0 ? 1 : tier === 1 ? 2 : 4;
          for (let i = 0; i < curtains.length; i += step) {
            const c = curtains[i];
            const w = c.w * (tier === 0 ? 1 : tier === 1 ? 1.5 : 2.2);
            for (const rollOff of tier === 2 ? [0] : [0, Math.PI / 2]) {
              const side = rotate([1, 0, 0], UP, c.phase * Math.PI * 2 + rollOff);
              const sides = c.pts.map(() => side);
              const widths = c.pts.map((_, k) => w * (0.6 + 0.4 * Math.sin((k / (c.pts.length - 1)) * Math.PI * 0.9 + 0.2)));
              const s = style({ a: leafA, b: leafB, cell: Cell.LeafWillow, flutter: 1, phase: c.phase });
              const l = len(sub(c.pts[c.pts.length - 1], c.pts[0]));
              gb.strip(c.pts, sides, widths, s, null, [l / 2.2, 0], [0, 1], (t) => 0.4 + t * 0.6);
            }
          }
        },
      });
      return g.sk;
    }
    case 'acacia': {
      const g = new Grower(rng, H, Cell.LeafSmall, Cell.BarkRough);
      const forks = P.forks ?? 3;
      const spread = P.spread ?? 0.7;
      const crownR = (P.crownW ?? 1.2) * H * 0.45;
      const trunkLen = H * rng.range(0.25, 0.38);
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.12, segs: 4 },
        { children: [forks, forks + 1], start: 0.92, end: 1, angle: [spread * 0.8, spread * 1.15], lenRatio: (H * 0.75) / trunkLen, radRatio: 0.65, gravity: 0.35, wobble: 0.12, segs: 5 },
        { children: [3, 5], start: 0.55, end: 1, angle: [0.7, 1.2], lenRatio: 0.45, radRatio: 0.5, gravity: -0.05, wobble: 0.15, segs: 3 },
      ];
      g.branch([0, -0.3, 0], [rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)], trunkLen, tr, 0, specs, 0.25, leafSize);
      // Flat canopy layer(s): horizontal cards around L2 tips.
      const tips = g.sk.segs.filter((s) => s.level === 2).map((s) => s.pts[s.pts.length - 1]);
      for (const t of tips) {
        const n = rng.int(3, 5);
        for (let i = 0; i < n; i++) {
          const ang = rng.float() * Math.PI * 2;
          const r = rng.range(0, crownR * 0.28);
          const p: V3 = [t[0] + Math.cos(ang) * r, t[1] + rng.range(-0.25, 0.35), t[2] + Math.sin(ang) * r];
          const right = rotate([1, 0, 0], UP, rng.float() * Math.PI * 2);
          const up = norm(cross(right, [rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)]));
          g.sk.leaves.push({ p, up: scale(up, -1), right, size: leafSize * rng.range(1.4, 1.9), phase: rng.float(), alt: rng.chance(0.3), aspect: 1 });
        }
      }
      g.sk.crown = [0, H * 0.75, 0];
      return g.sk;
    }
    case 'baobab': {
      const g = new Grower(rng, H, Cell.LeafSmall, Cell.BarkFibrous);
      const topY = H * 0.62;
      const bulge = P.bulge ?? 1.3;
      const profile: [number, number][] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const r = tr * (1.1 + (bulge - 1) * Math.sin(Math.PI * Math.min(1, t * 1.25)) * 1.0 - t * 0.55);
        profile.push([Math.max(tr * 0.35, r), -0.5 + t * (topY + 0.5)]);
      }
      g.sk.extras.push({
        build: (gb, tier) => {
          const s = style({ a: lin(sp.bark), b: lin(sp.bark2), cell: Cell.BarkFibrous, bend: 0 });
          gb.lathe([0, 0, 0], profile, tier === 0 ? 16 : tier === 1 ? 10 : 7, s, { vScale: 0.25, uRepeat: 3 });
        },
      });
      const limbs = P.limbs ?? 7;
      const specs: LevelSpec[] = [
        { children: [2, 3], start: 0.4, end: 1, angle: [0.4, 0.8], lenRatio: 0.55, radRatio: 0.5, gravity: 0.1, wobble: 0.25, segs: 3 },
        { children: [2, 4], start: 0.4, end: 1, angle: [0.4, 0.9], lenRatio: 0.5, radRatio: 0.5, gravity: 0.1, wobble: 0.25, segs: 2, virtual: true, leaves: { perM: 1.5, from: 0.2 } },
      ];
      for (let i = 0; i < limbs; i++) {
        const ang = (i / limbs) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const out: V3 = [Math.cos(ang), rng.range(0.6, 1.4), Math.sin(ang)];
        const r0 = tr * 0.45;
        g.branch([Math.cos(ang) * r0 * 0.6, topY - 0.3, Math.sin(ang) * r0 * 0.6], out, H * rng.range(0.25, 0.4), tr * 0.35, 0, specs, 0.25, leafSize * 0.8);
      }
      g.sk.crown = [0, topY + H * 0.2, 0];
      return g.sk;
    }
    case 'juniper': {
      const g = new Grower(rng, H, Cell.Spray, Cell.BarkFibrous);
      const tw = P.twist ?? 0.7;
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0.1, wobble: 0.25 * tw, segs: 6 },
        { children: [2, 4], start: 0.35, end: 1, angle: [0.4, 1.0], lenRatio: 0.6, radRatio: 0.6, gravity: 0.15, wobble: 0.3 * tw, segs: 4 },
        { children: [2, 4], start: 0.4, end: 1, angle: [0.4, 1.0], lenRatio: 0.5, radRatio: 0.5, gravity: 0.1, wobble: 0.3, segs: 2, virtual: true, leaves: { perM: 4.5, from: 0.2 } },
      ];
      const lean = rng.range(-0.3, 0.3);
      g.branch([0, -0.2, 0], [lean, 1, rng.range(-0.3, 0.3)], H * 0.75, tr, 0, specs, 0.3, leafSize * 0.9);
      g.sk.crown = [0, H * 0.6, 0];
      return g.sk;
    }
    case 'snag':
    case 'charred': {
      const g = new Grower(rng, H, Cell.LeafSmall, sp.form === 'charred' ? Cell.BarkEmber : Cell.BarkRough);
      const broken = P.broken ?? 0.4;
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.08, segs: 6 },
        { children: [P.limbs ?? 4, (P.limbs ?? 4) + 2], start: 0.35, end: 0.95, angle: [0.6, 1.2], lenRatio: 0.35, radRatio: 0.45, gravity: 0.05, wobble: 0.25, segs: 3, shape: (t) => 1 - t * 0.5 },
        { children: [1, 3], start: 0.3, end: 1, angle: [0.4, 0.9], lenRatio: 0.45, radRatio: 0.5, gravity: 0.0, wobble: 0.3, segs: 2 },
      ];
      g.branch([0, -0.3, 0], [rng.range(-0.08, 0.08), 1, rng.range(-0.08, 0.08)], H * (1 - broken * 0.4), tr, 0, specs, 0.55, 0);
      g.sk.crown = [0, H * 0.6, 0];
      return g.sk;
    }
    case 'emergent': {
      const g = new Grower(rng, H, Cell.LeafBroad, Cell.BarkSmooth);
      const bare = P.bare ?? 0.68;
      const specs: LevelSpec[] = [
        { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.04, segs: 8 },
        { children: [4, 6], start: bare, end: 1, angle: [0.85, 1.25], lenRatio: 0.32, radRatio: 0.5, gravity: 0.18, wobble: 0.15, segs: 4 },
        { children: [3, 5], start: 0.3, end: 1, angle: [0.5, 0.9], lenRatio: 0.5, radRatio: 0.5, gravity: 0.0, wobble: 0.2, segs: 3 },
        { children: [3, 4], start: 0.3, end: 1, angle: [0.4, 0.9], lenRatio: 0.45, radRatio: 0.5, gravity: 0.05, wobble: 0.25, segs: 2, virtual: true, leaves: { perM: 2.2, from: 0.1 } },
      ];
      g.branch([0, -0.4, 0], [0, 1, 0], H * 0.9, tr, 0, specs, 0.3, leafSize);
      buttress(g, tr, P.buttress ?? 0.8, sp);
      // Lianas hanging from the crown.
      const limbs = g.sk.segs.filter((s) => s.level === 1);
      const lianas: V3[][] = [];
      for (let i = 0; i < Math.min(4, limbs.length); i++) {
        const a = along(limbs[i].pts, rng.range(0.4, 0.9)).p;
        const pts: V3[] = [];
        const n = 8;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          pts.push([a[0] * (1 - t * 0.2) + Math.sin(t * 5 + i) * 0.3, a[1] * (1 - t) + 0.2, a[2] * (1 - t * 0.2) + Math.cos(t * 4 + i) * 0.3]);
        }
        lianas.push(pts);
      }
      g.sk.extras.push({
        build: (gb, tier) => {
          if (tier > 1) return;
          const s = style({ a: lin(sp.bark2), b: lin(sp.leaf), cell: Cell.Stem, bend: 0.25, phase: 0.3 });
          for (const l of lianas) gb.tube(l, l.map(() => 0.05), tier === 0 ? 4 : 3, s, { vScale: 0.5 });
        },
      });
      g.sk.crown = [0, H * 0.82, 0];
      return g.sk;
    }
    case 'fir':
    case 'pine': {
      const pine = sp.form === 'pine';
      const g = new Grower(rng, H, Cell.LeafNeedle, pine ? Cell.BarkPlates : Cell.BarkRough);
      const bare = P.bare ?? (pine ? 0.55 : 0.1);
      const crownW = (P.crownW ?? 0.35) * H;
      const droop = P.droop ?? 0.3;
      // Trunk.
      const lean = pine ? (P.lean ?? 0.08) : 0.02;
      const trunk: V3[] = [];
      const rad: number[] = [];
      const ts = 9;
      const lx = rng.range(-lean, lean), lz = rng.range(-lean, lean);
      for (let i = 0; i <= ts; i++) {
        const t = i / ts;
        trunk.push([lx * H * t * t + rng.range(-0.04, 0.04), -0.4 + t * (H + 0.4), lz * H * t * t + rng.range(-0.04, 0.04)]);
        rad.push(tr * (1 - t * 0.92) + 0.015);
      }
      g.sk.segs.push({ pts: trunk, rad, level: 0, phase: rng.float(), solid: true });
      const ls = leafSize * (pine ? 1.25 : 1.05);
      if (!pine) {
        const whorls = P.whorls ?? 12;
        for (let w = 0; w < whorls; w++) {
          const t = bare + (0.97 - bare) * (w / (whorls - 1));
          const a = along(trunk, t);
          const nb = rng.int(5, 7);
          const L = crownW * Math.pow(1 - (t - bare) / (1 - bare), 0.95) + 0.35;
          const r0 = radAt(rad, t);
          for (let b = 0; b < nb; b++) {
            const ang = (b / nb) * Math.PI * 2 + w * 0.7 + rng.range(-0.25, 0.25);
            const out: V3 = [Math.cos(ang), -droop * rng.range(0.4, 1.0) + 0.15, Math.sin(ang)];
            const spec: LevelSpec[] = [
              { children: [0, 0], start: 0, end: 0, angle: [0, 0], lenRatio: 0, radRatio: 0, gravity: -droop * 0.6, wobble: 0.06, segs: 3, leaves: { perM: 3.2, from: 0.1 } },
            ];
            g.branch(a.p, out, L * rng.range(0.85, 1.1), Math.max(0.025, r0 * 0.35), 0, spec, 0.25, ls * Math.min(1, 0.55 + L / crownW * 0.6));
            g.sk.segs[g.sk.segs.length - 1].level = 1;
          }
        }
        // Leader tuft.
        for (let i = 0; i < 4; i++) g.leaf([trunk[ts][0], H - 0.8 + i * 0.25, trunk[ts][2]], [rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)], ls * 0.7);
      } else {
        const nb = rng.int(10, 15);
        for (let b = 0; b < nb; b++) {
          const t = bare + (0.98 - bare) * ((b + rng.float()) / nb);
          const a = along(trunk, t);
          const ang = b * 2.39996 + rng.range(-0.3, 0.3);
          const out: V3 = [Math.cos(ang), rng.range(0.1, 0.5), Math.sin(ang)];
          const L = crownW * (1.05 - (t - bare) / (1 - bare) * 0.6) * rng.range(0.7, 1.1);
          const spec: LevelSpec[] = [
            { children: [0, 0], start: 0, end: 0, angle: [0, 0], lenRatio: 0, radRatio: 0, gravity: 0.12, wobble: 0.15, segs: 3 },
            { children: [2, 3], start: 0.4, end: 1, angle: [0.4, 0.8], lenRatio: 0.45, radRatio: 0.5, gravity: 0.2, wobble: 0.2, segs: 2, virtual: true, leaves: { perM: 5, from: 0.3 } },
          ];
          g.branch(a.p, out, L, radAt(rad, t) * 0.4, 0, spec, 0.3, ls);
        }
      }
      g.sk.crown = [0, pine ? H * 0.82 : H * 0.55, 0];
      return g.sk;
    }
    case 'palm':
      return growPalm(sp, rng, H);
    case 'bamboo':
      return growBamboo(sp, rng, H);
    case 'giantshroom':
      return growGiantShroom(sp, rng, H);
    case 'glasstree':
      return growGlass(sp, rng, H);
    case 'spiral':
      return growSpiral(sp, rng, H);
    case 'bulb':
      return growBulb(sp, rng, H);
    case 'umbrella':
      return growUmbrella(sp, rng, H);
    case 'saguaro':
      return growSaguaro(sp, rng, H);
    default: {
      const g = new Grower(rng, H, Cell.LeafBroad, Cell.BarkRough);
      g.branch([0, -0.3, 0], [0, 1, 0], H, tr, 0, [{ children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.1, segs: 5, leaves: { perM: 1, from: 0.5 } }], 0.2, leafSize);
      return g.sk;
    }
  }
}

// ------------------------------------------------------------------ special features

function buttress(g: Grower, tr: number, strength: number, sp: FloraSpecies) {
  const rng = g.rng;
  const fins: { ang: number; h: number; r: number }[] = [];
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) fins.push({ ang: (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3), h: tr * rng.range(3, 6) * strength + 0.5, r: tr * rng.range(2.5, 4.5) * strength + tr });
  g.sk.extras.push({
    build: (gb, tier) => {
      if (tier > 1) return;
      const s = style({ a: lin(sp.bark), b: lin(sp.bark2), cell: Cell.BarkSmooth });
      for (const f of fins) {
        const dir: V3 = [Math.cos(f.ang), 0, Math.sin(f.ang)];
        const side = cross(dir, [0, 1, 0]);
        const th = 0.08 + tr * 0.12;
        // Curved fin profile: concave top edge from trunk to ground.
        const n = 6;
        const top: V3[] = [], bot: V3[] = [];
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const r = tr * 0.8 + (f.r - tr * 0.8) * t;
          const y = f.h * Math.pow(1 - t, 1.8) - 0.3;
          top.push([dir[0] * r, y, dir[2] * r]);
          bot.push([dir[0] * r, -0.4, dir[2] * r]);
        }
        for (const sgn of [-1, 1]) {
          const off = scale(side, th * sgn);
          const nrm = scale(side, sgn);
          let pa = -1, pb = -1;
          for (let k = 0; k <= n; k++) {
            const a = gb.vertex(add(top[k], off), nrm, k / n, top[k][1] * 0.3 + 0.2, s);
            const b = gb.vertex(add(bot[k], off), nrm, k / n, 0, s);
            if (pa >= 0) {
              if (sgn > 0) gb.quad(pb, b, a, pa);
              else gb.quad(pb, pa, a, b);
            }
            pa = a;
            pb = b;
          }
        }
        // Fin top edge cap.
        const capS = style({ a: lin(sp.bark), b: lin(sp.bark2), cell: Cell.BarkSmooth });
        let pa = -1, pb = -1;
        for (let k = 0; k <= n; k++) {
          const nn: V3 = [0, 1, 0];
          const a = gb.vertex(add(top[k], scale(side, th)), nn, k / n, 0, capS);
          const b = gb.vertex(add(top[k], scale(side, -th)), nn, k / n, 0.1, capS);
          if (pa >= 0) gb.quad(pa, pb, b, a);
          pa = a;
          pb = b;
        }
      }
    },
  });
}

function propRoots(g: Grower, tr: number, base: number, n: number) {
  const rng = g.rng;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const y0 = base * rng.range(0.55, 1.05);
    const R = rng.range(1.3, 2.6) + tr * 2;
    const p0: V3 = [Math.cos(ang) * tr * 0.6, y0, Math.sin(ang) * tr * 0.6];
    const p2: V3 = [Math.cos(ang) * R, -0.5, Math.sin(ang) * R];
    const p1: V3 = [Math.cos(ang) * R * 0.55, y0 + rng.range(0.2, 0.6), Math.sin(ang) * R * 0.55];
    const pts: V3[] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const a = lerp3(p0, p1, t), b = lerp3(p1, p2, t);
      pts.push(lerp3(a, b, t));
    }
    g.sk.segs.push({ pts, rad: pts.map((_, k) => tr * 0.32 * (1 - k / 12)), level: 1, phase: rng.float(), solid: true });
  }
  // Short trunk below the root crown.
  g.sk.segs.push({ pts: [[0, -0.3, 0], [0, base + 0.2, 0]], rad: [tr * 0.6, tr * 0.9], level: 0, phase: 0, solid: true });
}

function growPalm(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.LeafFrond, Cell.BarkRings);
  const P = sp.p;
  const tr = P.trunkR ?? 0.22;
  const curve = P.curve ?? 0.2;
  const dirAng = rng.float() * Math.PI * 2;
  const cd: V3 = [Math.cos(dirAng), 0, Math.sin(dirAng)];
  const trunk: V3[] = [];
  const rad: number[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = curve * H * t * t;
    trunk.push([cd[0] * off, -0.4 + t * (H + 0.4), cd[2] * off]);
    rad.push(tr * (1.35 - t * 0.45 + (t < 0.08 ? (0.08 - t) * 4 : 0)));
  }
  g.sk.segs.push({ pts: trunk, rad, level: 0, phase: rng.float(), solid: true });
  const top = trunk[n];
  const fronds = P.fronds ?? 9;
  const fl = (P.frondLen ?? 0.4) * H;
  const droop = P.droop ?? 0.5;
  const fr: { pts: V3[]; side: V3; w: number; phase: number }[] = [];
  for (let i = 0; i < fronds; i++) {
    const ang = (i / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const elev = rng.range(0.15, 0.85);
    const d0: V3 = norm([Math.cos(ang), elev, Math.sin(ang)]);
    const pts: V3[] = [];
    const m = 7;
    let p = top, d = d0;
    pts.push(p);
    for (let k = 1; k <= m; k++) {
      d = norm(add(d, [0, -droop * 0.32, 0]));
      p = add(p, scale(d, fl / m));
      pts.push(p);
    }
    fr.push({ pts, side: norm(cross(d0, UP)), w: fl * rng.range(0.3, 0.4), phase: rng.float() });
  }
  const nuts: V3[] = [];
  for (let i = 0; i < rng.int(0, 6); i++) {
    const a = rng.float() * Math.PI * 2;
    nuts.push([top[0] + Math.cos(a) * tr * 1.2, top[1] - rng.range(0.2, 0.6), top[2] + Math.sin(a) * tr * 1.2]);
  }
  g.sk.extras.push({
    build: (gb, tier) => {
      const s = style({ a: lin(sp.leaf), b: lin(sp.leaf2), cell: Cell.LeafFrond, flutter: 0.8 });
      for (const f of fr) {
        const nP = f.pts.length;
        // V-folded frond: two half-strips tilted down from the rachis.
        for (const sgn of [-1, 1]) {
          const sides = f.pts.map(() => norm(add(scale(f.side, sgn), [0, -0.45, 0])));
          const widths = f.pts.map((_, k) => f.w * Math.sin(Math.PI * Math.min(1, (k / (nP - 1)) * 0.95 + 0.08)));
          const pts = f.pts.map((p, k) => add(p, scale(sides[k], widths[k] / 2)));
          gb.strip(pts, sides, widths, { ...s, phase: f.phase }, null, [0, 1], sgn < 0 ? [0, 0.5] : [0.5, 1], (t) => t);
          if (tier === 2) break;
        }
      }
      if (tier < 2)
        for (const c of nuts) gb.ellipsoid(c, 0.16, 0.19, 0.16, tier === 0 ? 8 : 5, style({ a: lin(sp.bark2), b: lin(sp.leaf), cell: Cell.Plain }));
    },
  });
  g.sk.crown = top;
  return g.sk;
}

function growBamboo(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.LeafBlade, Cell.BarkRings);
  const P = sp.p;
  const culms = P.culms ?? 9;
  const spread = P.spread ?? 1;
  for (let c = 0; c < culms; c++) {
    const a = rng.float() * Math.PI * 2, r = Math.sqrt(rng.float()) * spread * 0.6;
    const base: V3 = [Math.cos(a) * r, -0.3, Math.sin(a) * r];
    const h = H * rng.range(0.6, 1.05);
    const out = norm([Math.cos(a) * rng.range(0.03, 0.12), 1, Math.sin(a) * rng.range(0.03, 0.12)]);
    const pts: V3[] = [];
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push(add(base, add(scale(out, h * t), [out[0] * t * t * h * 0.15, 0, out[2] * t * t * h * 0.15])));
    }
    const rr = (P.trunkR ?? 0.08) * rng.range(0.7, 1.2);
    g.sk.segs.push({ pts, rad: pts.map((_, k) => rr * (1 - k / n * 0.4)), level: 0, phase: rng.float(), solid: true });
    // Leaf sprays at upper nodes.
    for (let k = 0; k < 7; k++) {
      const t = rng.range(0.45, 1);
      const p = along(pts, t).p;
      const d = norm([rng.range(-1, 1), rng.range(0.1, 0.6), rng.range(-1, 1)]);
      g.leaf(p, d, (P.leafSize ?? 1.1) * rng.range(0.8, 1.2), 1);
    }
  }
  g.sk.crown = [0, H * 0.7, 0];
  return g.sk;
}

/** Cap profiles (r, y) normalized by cap radius. */
const CAP_PROFILES: [number, number][][] = [
  [[1, 0], [0.97, 0.18], [0.85, 0.42], [0.6, 0.62], [0.3, 0.74], [0, 0.78]],
  [[1, -0.06], [0.97, 0.04], [0.75, 0.12], [0.4, 0.17], [0, 0.2]],
  [[1, 0], [0.8, 0.3], [0.55, 0.7], [0.3, 1.05], [0.1, 1.3], [0, 1.36]],
  [[0.9, -0.38], [0.97, -0.12], [0.95, 0.15], [0.78, 0.48], [0.45, 0.75], [0, 0.85]],
  [[1, -0.04], [0.92, 0.08], [0.6, 0.16], [0.3, 0.22], [0, 0.24]],
];

/** Emit a mushroom cap (top + gills) centered at c with radius R. */
export function mushroomCap(gb: GeoBuilder, c: V3, R: number, styleIdx: number, stemR: number, top: VertexStyle, under: VertexStyle, radial: number) {
  const prof = CAP_PROFILES[styleIdx % CAP_PROFILES.length];
  gb.lathe(c, prof.map(([r, y]) => [r * R, y * R] as [number, number]), radial, top, { vScale: 1 / Math.max(0.5, R * 2.2), uRepeat: 2 });
  // Gills underside: from the rim inwards to the stem, slightly raised.
  const rim = prof[0];
  const gl: [number, number][] = [[stemR * 1.05, rim[1] * R + R * 0.12], [rim[0] * R * 0.55, rim[1] * R + R * 0.06], [rim[0] * R * 0.985, rim[1] * R]];
  gb.lathe(c, gl, radial, under, { vScale: 0.6 });
}

function growGiantShroom(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.Cap, Cell.Stem);
  const P = sp.p;
  const stems = P.stems ?? 1;
  const caps: { c: V3; R: number; style: number; stemR: number }[] = [];
  for (let s = 0; s < stems; s++) {
    const k = s === 0 ? 1 : rng.range(0.35, 0.6);
    const a = rng.float() * Math.PI * 2, r = s === 0 ? 0 : rng.range(1.0, 2.2) * (P.trunkR ?? 0.5) * 2;
    const base: V3 = [Math.cos(a) * r, -0.4, Math.sin(a) * r];
    const h = H * k * 0.82;
    const bend = (P.bend ?? 0.15) * rng.range(0.5, 1.2);
    const bd = rng.float() * Math.PI * 2;
    const pts: V3[] = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const off = Math.sin(t * Math.PI * 0.8) * bend * h;
      pts.push(add(base, [Math.cos(bd) * off + (s ? Math.cos(a) * t * 0.6 : 0), t * h, Math.sin(bd) * off + (s ? Math.sin(a) * t * 0.6 : 0)]));
    }
    const sr = (P.trunkR ?? 0.5) * k;
    g.sk.segs.push({ pts, rad: pts.map((_, i) => sr * (1 + Math.pow(1 - i / n, 3) * 0.9 - (i / n) * 0.15)), level: 0, phase: rng.float(), solid: true });
    const R = H * (P.capR ?? 0.45) * k;
    const st = P.capStyle ?? 0;
    caps.push({ c: pts[n], R, style: st, stemR: sr * 0.85 });
    if (st === 4) caps.push({ c: add(pts[n], [0, -h * 0.28, 0]), R: R * 1.35, style: 1, stemR: sr });
  }
  g.sk.extras.push({
    build: (gb, tier) => {
      const radial = tier === 0 ? 24 : tier === 1 ? 14 : 9;
      const top = style({ a: lin(sp.leaf), b: lin(P.spots ? sp.accent : sp.leaf2), cell: Cell.Cap, glow: sp.glow, bend: 0.1 });
      const under = style({ a: lin(sp.leaf2), b: lin(sp.accent), cell: Cell.Gills, glow: sp.glow, bend: 0.1 });
      for (const c of caps) mushroomCap(gb, c.c, c.R, c.style, c.stemR, top, under, radial);
    },
  });
  g.sk.crown = [0, H * 0.85, 0];
  return g.sk;
}

function growGlass(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.Crystal, Cell.Crystal);
  const P = sp.p;
  const specs: LevelSpec[] = [
    { children: [1, 1], start: 0, end: 0, angle: [0, 0], lenRatio: 1, radRatio: 1, gravity: 0, wobble: 0.18, segs: 3 },
    { children: [3, 6], start: 0.35, end: 1, angle: [0.5, 0.95], lenRatio: 0.5, radRatio: 0.5, gravity: 0.2, wobble: 0.2, segs: 2 },
    { children: [2, 3], start: 0.4, end: 1, angle: [0.4, 0.8], lenRatio: 0.55, radRatio: 0.5, gravity: 0.1, wobble: 0.2, segs: 2 },
  ];
  g.branch([0, -0.3, 0], [0, 1, 0], H * 0.65, P.trunkR ?? 0.25, 0, specs, 0.35, 0);
  const tips = g.sk.segs.filter((s) => s.level >= 1).map((s) => ({ p: s.pts[s.pts.length - 1], d: norm(sub(s.pts[s.pts.length - 1], s.pts[s.pts.length - 2])) }));
  const shard = (P.shardSize ?? 0.6) * H * 0.18;
  const facets = P.facets ?? 5;
  g.sk.extras.push({
    build: (gb, tier) => {
      const s = style({ a: lin(sp.leaf), b: lin(sp.leaf2), cell: Cell.Crystal, glow: sp.glow, bend: 0.05 });
      for (let i = 0; i < tips.length; i++) {
        const t = tips[i];
        const n = tier === 0 ? 3 : tier === 1 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const d = norm(add(t.d, [Math.sin(i * 3.1 + k) * 0.6, 0.3, Math.cos(i * 1.7 + k * 2) * 0.6]));
          gb.crystal(t.p, d, shard * (1 - k * 0.25), shard * 0.22, facets, s, i + k);
        }
      }
    },
  });
  g.sk.crown = [0, H * 0.6, 0];
  return g.sk;
}

function growSpiral(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.LeafHeart, Cell.BarkAlien);
  const P = sp.p;
  const turns = P.twist ?? 2.5;
  const R = H * 0.12;
  const pts: V3[] = [];
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    const r = R * Math.sin(Math.PI * Math.min(1, t * 1.2)) + 0.05;
    pts.push([Math.cos(a) * r, -0.4 + t * (H + 0.4), Math.sin(a) * r]);
  }
  const tr = P.trunkR ?? 0.3;
  g.sk.segs.push({ pts, rad: pts.map((_, i) => tr * (1 - (i / n) * 0.8)), level: 0, phase: rng.float(), solid: true });
  const pods = P.pods ?? 7;
  const orbs: { stalk: V3[]; c: V3; r: number }[] = [];
  for (let i = 0; i < pods; i++) {
    const t = 0.35 + 0.62 * (i / pods);
    const a = along(pts, t);
    const out = norm([a.p[0] + rng.range(-0.3, 0.3), rng.range(-0.2, 0.6), a.p[2] + rng.range(-0.3, 0.3)]);
    const L = H * rng.range(0.12, 0.22) * (1.2 - t * 0.5);
    const end = add(a.p, scale(out, L));
    orbs.push({ stalk: [a.p, lerp3(a.p, end, 0.5), end], c: end, r: H * rng.range(0.04, 0.07) });
    for (let k = 0; k < 2; k++) g.leaf(lerp3(a.p, end, 0.6), norm(add(out, [0, 0.5, 0])), H * 0.12, 1);
  }
  g.sk.extras.push({
    build: (gb, tier) => {
      const stalk = style({ a: lin(sp.bark), b: lin(sp.bark2), cell: Cell.Stem, bend: 0.15 });
      const orb = style({ a: lin(sp.leaf), b: lin(sp.leaf2), cell: Cell.Cap, glow: Math.max(0.3, sp.glow), bend: 0.2, flutter: 0.2 });
      for (const o of orbs) {
        if (tier < 2) gb.tube(o.stalk, [0.06, 0.05, 0.04], tier === 0 ? 5 : 3, stalk);
        gb.ellipsoid(o.c, o.r, o.r * 1.1, o.r, tier === 0 ? 12 : tier === 1 ? 8 : 5, orb);
      }
    },
  });
  g.sk.crown = [0, H * 0.7, 0];
  return g.sk;
}

function growBulb(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.LeafFrond, Cell.BarkAlien);
  const P = sp.p;
  const tr = (P.trunkR ?? 0.3) * 1.6;
  const prof: [number, number][] = [];
  const bul = rng.int(2, 3);
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const r = tr * (0.55 + 0.6 * Math.pow(Math.abs(Math.sin(t * Math.PI * bul)), 1.5) * (1 - t * 0.5)) + 0.04;
    prof.push([r, -0.4 + t * H * 0.85]);
  }
  const topY = H * 0.85 - 0.4;
  const pods: { stalk: V3[]; c: V3; r: number }[] = [];
  const nP = P.pods ?? 7;
  for (let i = 0; i < nP; i++) {
    const a = (i / nP) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const L = H * rng.range(0.18, 0.3);
    const p0: V3 = [0, topY, 0];
    const p1: V3 = [Math.cos(a) * L * 0.7, topY + L * 0.4, Math.sin(a) * L * 0.7];
    const p2: V3 = [Math.cos(a) * L, topY - L * (P.droop ?? 0.3), Math.sin(a) * L];
    pods.push({ stalk: [p0, p1, p2], c: add(p2, [0, -H * 0.05, 0]), r: H * rng.range(0.05, 0.08) });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.leaf([0, topY + 0.2, 0], norm([Math.cos(a), 0.9, Math.sin(a)]), H * 0.28, 0.5);
  }
  g.sk.extras.push({
    build: (gb, tier) => {
      gb.lathe([0, 0, 0], prof, tier === 0 ? 16 : tier === 1 ? 10 : 7, style({ a: lin(sp.bark), b: lin(sp.bark2), cell: Cell.BarkAlien, glow: sp.glow * 0.5 }), { vScale: 0.3, uRepeat: 2 });
      const stalk = style({ a: lin(sp.bark2), b: lin(sp.bark), cell: Cell.Stem, bend: 0.25 });
      const pod = style({ a: lin(sp.leaf), b: lin(sp.leaf2), cell: Cell.Cap, glow: Math.max(0.25, sp.glow), bend: 0.35 });
      for (const p of pods) {
        if (tier < 2) gb.tube(p.stalk, [0.07, 0.05, 0.035], tier === 0 ? 5 : 3, stalk);
        gb.ellipsoid(p.c, p.r * 0.85, p.r * 1.25, p.r * 0.85, tier === 0 ? 10 : 6, pod);
      }
    },
  });
  g.sk.crown = [0, topY, 0];
  return g.sk;
}

function growUmbrella(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.LeafHeart, Cell.BarkAlien);
  const P = sp.p;
  const tr = (P.trunkR ?? 0.3) * 0.7;
  const pts: V3[] = [];
  const sw = rng.range(0.03, 0.08) * H;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push([Math.sin(t * 3.5) * sw, -0.4 + t * (H + 0.4), Math.cos(t * 2.7) * sw * 0.6]);
  }
  g.sk.segs.push({ pts, rad: pts.map((_, i) => tr * (1.3 - i / 10 * 0.6)), level: 0, phase: rng.float(), solid: true });
  const tiers = P.tiers ?? 3;
  const discs: { c: V3; R: number }[] = [];
  for (let i = 0; i < tiers; i++) {
    const t = tiers === 1 ? 1 : 0.55 + 0.45 * (i / (tiers - 1));
    discs.push({ c: along(pts, t).p, R: H * 0.36 * (1 - (i / Math.max(1, tiers)) * 0.55) * rng.range(0.85, 1.1) });
  }
  const droop = P.droop ?? 0.3;
  g.sk.extras.push({
    build: (gb, tier) => {
      const radial = tier === 0 ? 22 : tier === 1 ? 14 : 9;
      const top = style({ a: lin(sp.leaf), b: lin(sp.leaf2), cell: Cell.Cap, glow: sp.glow, bend: 0.25, flutter: 0.15 });
      const under = style({ a: lin(sp.leaf2), b: lin(sp.accent), cell: Cell.Gills, glow: sp.glow, bend: 0.25 });
      for (const d of discs) {
        const prof: [number, number][] = [[d.R, -d.R * droop * 0.35], [d.R * 0.9, 0], [d.R * 0.55, d.R * 0.08], [0, d.R * 0.12]];
        gb.lathe(d.c, prof, radial, top, { vScale: 0.5, uRepeat: 3 });
        gb.lathe(d.c, [[tr, d.R * 0.02], [d.R * 0.98, -d.R * droop * 0.33]], radial, under, { vScale: 0.5 });
      }
    },
  });
  g.sk.crown = [0, H * 0.8, 0];
  return g.sk;
}

function growSaguaro(sp: FloraSpecies, rng: Rng, H: number): Skeleton {
  const g = new Grower(rng, H, Cell.FlowerHead, Cell.Cactus);
  const P = sp.p;
  const R = (P.trunkR ?? 0.3) * 1.0;
  const ribs = P.ribs ?? 12;
  const rib = (a: number) => 1 + 0.07 * Math.cos(a * ribs);
  const main: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const r = t < 0.92 ? R : R * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.92) / 0.08, 2))) + 0.01;
    main.push([r, -0.3 + t * (H + 0.3)]);
  }
  const arms: V3[][] = [];
  const nArms = P.arms ?? 2;
  for (let i = 0; i < nArms; i++) {
    const a = rng.float() * Math.PI * 2;
    const y0 = H * rng.range(0.3, 0.6);
    const out = rng.range(0.55, 0.9);
    const up = H * rng.range(0.2, 0.38);
    const d: V3 = [Math.cos(a), 0, Math.sin(a)];
    const pts: V3[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const horiz = Math.min(1, t * 2) * out;
      const vert = t < 0.3 ? 0 : Math.pow((t - 0.3) / 0.7, 0.9) * up;
      pts.push([d[0] * (R * 0.6 + horiz), y0 + vert + Math.sin(Math.min(1, t * 2) * Math.PI * 0.5) * R * 0.6, d[2] * (R * 0.6 + horiz)]);
    }
    arms.push(pts);
  }
  const flower = !!P.flower;
  g.sk.extras.push({
    build: (gb, tier) => {
      const radial = tier === 0 ? 24 : tier === 1 ? 14 : 8;
      const s = style({ a: lin(sp.bark), b: [0.92, 0.88, 0.75], cell: Cell.Cactus, bend: 0 });
      gb.lathe([0, 0, 0], main, radial, s, { ribFn: (a) => rib(a), vScale: 0.35 });
      for (const a of arms) {
        gb.tube(a, a.map(() => R * 0.68), radial, s, { radiusFn: (_, ang) => rib(ang), vScale: 0.35, capEnd: true });
      }
      if (flower && tier < 2) {
        const fs = style({ a: lin(sp.accent), b: [1, 0.9, 0.5], cell: Cell.FlowerHead });
        for (let k = 0; k < 4; k++) {
          const ang = k * 1.7;
          gb.card([Math.cos(ang) * R * 0.5, H - 0.05, Math.sin(ang) * R * 0.5], [1, 0, 0], [0, 0, 1], 0.28, 0.28, fs, [0, 1, 0], false);
        }
      }
    },
  });
  g.sk.crown = [0, H * 0.5, 0];
  return g.sk;
}

// ------------------------------------------------------------------ meshing

/** Emit a tree skeleton into a builder at a detail tier (0..2). */
export function meshTree(sp: FloraSpecies, sk: Skeleton, tier: number): GeoBuilder {
  const gb = new GeoBuilder();
  const H = sk.height;
  // Sway: grows with height and distance from the trunk axis.
  gb.bendFn = (p, base) => base + 0.022 * H * Math.pow(Math.max(0, p[1]) / H, 2) + 0.03 * Math.hypot(p[0], p[2]);
  const barkA = lin(sp.bark), barkB = lin(sp.form === 'charred' ? sp.accent : sp.bark2);
  const glow = sp.form === 'charred' ? sp.glow : 0;
  const rad0 = tier === 0 ? 8 : tier === 1 ? 5 : 4;
  const vScale = sk.barkCell === Cell.BarkRings ? 1 / Math.max(0.2, sp.form === 'bamboo' ? (sp.p.nodes ?? 0.45) * 4 : 1.2) : 0.35;
  for (const s of sk.segs) {
    if (!s.solid) continue;
    const r = s.rad[0];
    if (tier === 2 && s.level > 1) continue;
    if (tier === 1 && s.level > 2 && r < 0.05) continue;
    const radial = s.level === 0 ? rad0 : Math.max(3, rad0 - 2 - s.level);
    const st = style({ a: barkA, b: barkB, cell: sk.barkCell, phase: s.phase, glow });
    gb.tube(s.pts, s.rad, radial, st, { vScale, uRepeat: s.level === 0 ? 2 : 1, capEnd: s.level === 0 && (sp.form === 'snag' || sp.form === 'charred') });
  }
  for (const e of sk.extras) e.build(gb, tier);
  // Leaf cards.
  const leafA = lin(sp.leaf), leafB = lin(sp.leaf2);
  const keepEvery = tier === 0 ? 1 : tier === 1 ? 2 : 4;
  const grow = tier === 0 ? 1 : tier === 1 ? 1.45 : 2.0;
  const leafGlow = sp.form === 'spiral' || sp.form === 'bulb' || sp.form === 'umbrella' ? sp.glow * 0.4 : 0;
  for (let i = 0; i < sk.leaves.length; i += keepEvery) {
    const l = sk.leaves[i];
    const st = style({ a: l.alt ? leafB : leafA, b: l.alt ? leafA : leafB, cell: sk.leafCell, flutter: 1, phase: l.phase, glow: leafGlow });
    const hint = norm(sub(l.p, sk.crown));
    const size = l.size * grow;
    gb.card(l.p, l.right, l.up, size * l.aspect, size, st, hint, true);
  }
  return gb;
}

/** Tree height in reference units (for impostors / colliders). */
export function skeletonBounds(sk: Skeleton): { height: number; radius: number } {
  let r = 0, h = 0;
  for (const s of sk.segs) for (const p of s.pts) {
    r = Math.max(r, Math.hypot(p[0], p[2]));
    h = Math.max(h, p[1]);
  }
  for (const l of sk.leaves) {
    r = Math.max(r, Math.hypot(l.p[0], l.p[2]) + l.size * 0.5);
    h = Math.max(h, l.p[1] + l.size);
  }
  return { height: Math.max(h, sk.height), radius: Math.max(r, 0.5) };
}

