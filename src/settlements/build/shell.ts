/**
 * Generic rectangular building shell: foundation that reaches down into sloped
 * ground, storeys of walls (door holes, windows, timber framing, quoins,
 * jetties), floor slabs with stairwells, interior stairs, roofs of every kind
 * (gable, hip, conical, dome, mansard, flat with parapet, shed), chimneys with
 * smoke anchors, porches and balconies. Style builders configure it via
 * ShellSpec and decorate the result.
 *
 * Wall sides: 0 = front (+z), 1 = right (+x), 2 = back (−z), 3 = left (−x).
 * A wall frame has its origin on the wall centre line, x along the wall and
 * +z pointing outward.
 */
import type { RoofKind } from '../types';
import { Kit, Surf, scaleHex, type Lod } from './kit';

export interface WallLook {
  surf: Surf;
  col: number;
  /** Timber framing over the wall (exterior detail). */
  frame?: { surf: Surf; col: number; braces: boolean; w: number };
  /** Corner stones on the front/back walls. */
  quoin?: { surf: Surf; col: number };
}

export interface WindowLook {
  shape: 'rect' | 'arch' | 'round' | 'slit' | 'pointed';
  w: number;
  h: number;
  sill: number;
  spacing: number;
  frameSurf: Surf;
  frameCol: number;
  shutterCol: number | null;
  glassCol: number;
  glow: number;
  /** Emissive intensity of the lit window at night (0 = dark house). */
  lit: number;
  flowerbox: boolean;
}

export interface DoorLook {
  /** Offset along the front wall. */
  x: number;
  w: number;
  h: number;
  surf: Surf;
  col: number;
  frameSurf: Surf;
  frameCol: number;
  arch: boolean;
  /** Metal studs / bands. */
  bands: boolean;
}

export interface RoofLook {
  kind: RoofKind;
  pitch: number;
  overhang: number;
  surf: Surf;
  col: number;
  thick: number;
  trimSurf: Surf;
  trimCol: number;
  dormers: number;
  finial: boolean;
  /** Crenellated parapet for flat roofs. */
  crenel: boolean;
}

export interface ShellSpec {
  w: number;
  d: number;
  floors: number;
  storey: number;
  wallT: number;
  /** Race body scale (doors, steps, furniture). */
  scale: number;
  ground: [number, number, number, number];
  plinth: number;
  baseSurf: Surf;
  baseCol: number;
  /** Look per storey (the last one repeats). */
  walls: WallLook[];
  /** Upper-storey overhang on front and back (timber jetty). */
  jetty: number;
  floorSurf: Surf;
  floorCol: number;
  door: DoorLook | null;
  backDoor: boolean;
  win: WindowLook;
  /** Walls without windows (0..3), e.g. a forge's back wall. */
  blind?: number[];
  roof: RoofLook;
  /** Chimney position along the back wall (local x) or null. */
  chimneyX: number | null;
  chimneySurf: Surf;
  chimneyCol: number;
  porch: { depth: number; surf: Surf; col: number; postSurf: Surf; postCol: number; roofSurf: Surf; roofCol: number } | null;
  balcony: boolean;
  stairs: boolean;
}

export interface ShellOut {
  found: number;
  /** walls[floor][side] piece indices. */
  walls: number[][];
  slabs: number[];
  roof: number;
  gables: number[];
  door: number;
  /** Height of the wall tops / roof base and the roof apex (local y). */
  wallTop: number;
  ridge: number;
  /** Outer footprint of the top storey (with jetty). */
  topD: number;
}

const SLAB_T = 0.24;

/** Stair rectangle (local, ground floor) reserved by the interior planner: [x0, z0, x1, z1]. */
export function stairRect(w: number, d: number, t: number, storey: number): [number, number, number, number] {
  const run = Math.ceil(storey / 0.2) * 0.26;
  const x0 = -w / 2 + t + 0.05;
  const z1 = d / 2 - t - 1.1;
  return [x0, z1 - run, x0 + 0.95, z1];
}

/** Outer length of a wall side for a footprint (front/back span the full width). */
function sideLen(side: number, w: number, d: number, t: number) {
  return side % 2 === 0 ? w : d - 2 * t;
}

/** Push a wall frame for a side at height y. */
function pushSide(k: Kit, side: number, w: number, d: number, t: number, y: number) {
  if (side === 0) k.push(0, y, d / 2 - t / 2, 0);
  else if (side === 1) k.push(w / 2 - t / 2, y, 0, Math.PI / 2);
  else if (side === 2) k.push(0, y, -d / 2 + t / 2, Math.PI);
  else k.push(-w / 2 + t / 2, y, 0, -Math.PI / 2);
}

interface Opening {
  x: number;
  w: number;
  h: number;
}

/** Solid wall boxes (with colliders) around door holes. Frame: wall centre line, y = 0 at bottom. */
export function wallBoxes(k: Kit, L: number, H: number, t: number, holes: Opening[], surf: Surf, col: number) {
  const hs = holes.slice().sort((a, b) => a.x - b.x);
  let x0 = -L / 2;
  for (const o of hs) {
    const a = o.x - o.w / 2, b = o.x + o.w / 2;
    if (a - x0 > 0.01) k.solid((x0 + a) / 2, 0, 0, a - x0, H, t, surf, col);
    if (H - o.h > 0.01) k.solid(o.x, o.h, 0, o.w, H - o.h, t, surf, col);
    x0 = b;
  }
  if (L / 2 - x0 > 0.01) k.solid((x0 + L / 2) / 2, 0, 0, L / 2 - x0, H, t, surf, col);
}

/** A window centred at x on a wall frame (glass through the wall + exterior trim). */
export function windowAt(k: Kit, x: number, t: number, win: WindowLook, outerZ = t / 2) {
  const { w, h, sill } = win;
  const lod: Lod = 1;
  const emit = win.lit > 0 ? win.glow : 0;
  const glass = { emit, emitI: win.lit, night: true, lod } as const;
  const fs = win.frameSurf, fc = win.frameCol;
  const fz = outerZ + 0.03;
  switch (win.shape) {
    case 'round': {
      const r = w / 2;
      k.cyl(x, sill + r, outerZ + 0.02, r, r, t + 0.04, Surf.Window, win.glassCol, { ...glass, rx: Math.PI / 2, seg: 12 });
      // Frame ring of small blocks.
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        k.boxC(x + Math.cos(a) * (r + 0.07), sill + r + Math.sin(a) * (r + 0.07), fz, 0.16, 0.13, 0.08, fs, fc, { rz: a + Math.PI / 2, lod });
      }
      break;
    }
    case 'arch':
    case 'pointed': {
      const rect = h - w * (win.shape === 'arch' ? 0.5 : 0.6);
      k.box(x, sill, 0, w, rect, t + 0.04, Surf.Window, win.glassCol, glass);
      if (win.shape === 'arch') {
        k.cyl(x, sill + rect, -(t + 0.03) / 2, w / 2, w / 2, t + 0.03, Surf.Window, win.glassCol, { ...glass, rx: Math.PI / 2, seg: 12 });
      } else {
        k.frustum(x, sill + rect, 0, w, t + 0.03, 0, t + 0.03, w * 0.6, Surf.Window, win.glassCol, glass);
      }
      // Voussoirs / pointed trim.
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI;
        const rr = w / 2 + 0.08;
        const px = x + Math.cos(a) * rr;
        const py = sill + rect + Math.sin(a) * rr * (win.shape === 'pointed' ? 1.25 : 1);
        k.boxC(px, py, fz, 0.2, 0.14, 0.08, fs, fc, { rz: a - Math.PI / 2, lod });
      }
      k.box(x - w / 2 - 0.06, sill, fz - 0.04, 0.1, rect, 0.08, fs, fc, { lod });
      k.box(x + w / 2 + 0.06, sill, fz - 0.04, 0.1, rect, 0.08, fs, fc, { lod });
      k.box(x, sill - 0.1, fz - 0.02, w + 0.3, 0.1, 0.16, fs, fc, { lod });
      break;
    }
    default: {
      const ww = win.shape === 'slit' ? Math.min(w, 0.32) : w;
      k.box(x, sill, 0, ww, h, t + 0.04, Surf.Window, win.glassCol, glass);
      // Frame: jambs, lintel, sill.
      k.box(x - ww / 2 - 0.05, sill, fz - 0.03, 0.1, h, 0.08, fs, fc, { lod });
      k.box(x + ww / 2 + 0.05, sill, fz - 0.03, 0.1, h, 0.08, fs, fc, { lod });
      k.box(x, sill + h, fz - 0.03, ww + 0.3, 0.14, 0.1, fs, fc, { lod });
      k.box(x, sill - 0.09, fz - 0.01, ww + 0.26, 0.09, 0.18, fs, fc, { lod });
      if (win.shutterCol !== null && win.shape === 'rect') {
        const sw = ww / 2 + 0.02;
        for (const s of [-1, 1]) {
          k.box(x + s * (ww / 2 + 0.12 + sw / 2), sill, fz, sw, h, 0.04, Surf.Planks, win.shutterCol, { lod });
          k.box(x + s * (ww / 2 + 0.12 + sw / 2), sill + h * 0.2, fz + 0.025, sw * 0.9, 0.06, 0.02, Surf.Metal, 0x2a2622, { lod });
        }
      }
      if (win.flowerbox) {
        k.box(x, sill - 0.32, fz + 0.12, ww + 0.2, 0.22, 0.24, Surf.Planks, 0x6a4a30, { lod });
        for (let i = 0; i < 4; i++) {
          const fx = x - ww / 2 + (i + 0.5) * (ww / 4);
          const hue = [0xd04050, 0xe0c040, 0xc060c0, 0xf08040][(i + Math.round(x * 7)) & 3];
          k.sphere(fx, sill - 0.08, fz + 0.12, 0.12, 0.1, 0.1, Surf.Leaf, hue, { lod, seg: 6 });
        }
      }
    }
  }
}

/** Timber framing on a wall face. Frame: wall centre line; spans x ∈ [−Lf/2, Lf/2]. */
function framing(k: Kit, Lf: number, H: number, t: number, look: NonNullable<WallLook['frame']>, posts: number[], noBrace: [number, number][], railY: number) {
  const fw = look.w;
  const z = t / 2 + 0.015;
  const lod: Lod = 1;
  const xs = Array.from(new Set([-Lf / 2 + fw / 2, Lf / 2 - fw / 2, ...posts].map((v) => Math.round(v * 100) / 100))).sort((a, b) => a - b);
  // Add fill posts so panels stay narrow.
  const all: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    all.push(xs[i]);
    if (i < xs.length - 1) {
      const gap = xs[i + 1] - xs[i];
      const n = Math.floor(gap / 1.25);
      for (let j = 1; j <= n; j++) all.push(xs[i] + (gap * j) / (n + 1));
    }
  }
  for (const x of all) k.box(x, 0, z, fw, H, 0.06, look.surf, look.col, { lod });
  k.box(0, 0, z + 0.005, Lf, fw, 0.07, look.surf, look.col, { lod });
  k.box(0, H - fw, z + 0.005, Lf, fw, 0.07, look.surf, look.col, { lod });
  if (railY > 0.4) {
    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i], b = all[i + 1];
      const mid = (a + b) / 2;
      if (noBrace.some(([u, v]) => mid > u && mid < v && railY < 2)) continue;
      k.box(mid, railY, z, b - a, fw * 0.8, 0.06, look.surf, look.col, { lod });
    }
  }
  if (!look.braces) return;
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i] + fw / 2, b = all[i + 1] - fw / 2;
    const mid = (a + b) / 2;
    if (b - a < 0.5 || b - a > 1.5) continue;
    if (noBrace.some(([u, v]) => b > u && a < v)) continue;
    const dir = mid < 0 ? 1 : -1;
    const y0 = fw, y1 = H - fw;
    if (dir > 0) k.beam(a, y0, z, b, y1, z, fw * 0.8, look.surf, look.col, { lod, d: 0.06 });
    else k.beam(b, y0, z, a, y1, z, fw * 0.8, look.surf, look.col, { lod, d: 0.06 });
  }
}

/** Build the shell. Pieces are appended to the kit. */
export function buildShell(k: Kit, s: ShellSpec): ShellOut {
  const { w, d, t, storey } = { w: s.w, d: s.d, t: s.wallT, storey: s.storey };
  const gmin = Math.min(...s.ground);
  const rng = k.rng;

  // ---- foundation (reaches below the lowest ground corner)
  const found = k.piece('foundation', 'stone');
  const fb = gmin - 0.6;
  k.solid(0, fb, 0, w + 0.1, -fb, d + 0.1, s.baseSurf, s.baseCol);
  // Interior floor surface.
  k.box(0, 0, 0, w - 2 * t + 0.02, 0.03, d - 2 * t + 0.02, s.floorSurf, s.floorCol, { lod: 2 });
  // Steps up to the front door when the floor sits above the ground.
  const frontG = Math.min(s.ground[2], s.ground[3]);
  if (s.door && frontG < -0.18) {
    const n = Math.min(12, Math.ceil(-frontG / 0.2));
    const sh = -frontG / n;
    for (let i = 0; i < n; i++) {
      const y = frontG + i * sh;
      const depth = (n - i) * 0.3;
      k.solid(s.door.x, y - 0.3, d / 2 + 0.05 + depth / 2, s.door.w + 0.7, sh + 0.3, depth, s.baseSurf, scaleHex(s.baseCol, 0.95));
    }
  }

  const walls: number[][] = [];
  const slabs: number[] = [];
  let doorPiece = -1;
  for (let f = 0; f < s.floors; f++) {
    const look = s.walls[Math.min(f, s.walls.length - 1)];
    const jet = f > 0 ? s.jetty : 0;
    const dd = d + 2 * jet;
    const y0 = f * storey;
    const H = storey - (f < s.floors - 1 && s.jetty > 0 ? SLAB_T : 0);
    // Slab under upper storeys.
    if (f > 0) {
      const below = walls[f - 1];
      const slab = k.piece('floor', 'wood', below, 2);
      const sw = s.jetty > 0 ? w : w - 2 * t;
      const sd = s.jetty > 0 ? dd : d - 2 * t;
      const sy = y0 - SLAB_T;
      if (s.stairs && f === 1) {
        const [x0, z0, x1, z1] = stairRect(w, d, t, storey);
        // Slab with a stairwell hole: three boxes around the hole.
        const left = -sw / 2, right = sw / 2, front = sd / 2, back = -sd / 2;
        k.solid((x1 + right) / 2, sy, 0, right - x1, SLAB_T, sd, s.floorSurf, s.floorCol);
        k.solid((left + x1) / 2, sy, (z1 + front) / 2, x1 - left, SLAB_T, front - z1, s.floorSurf, s.floorCol);
        k.solid((left + x1) / 2, sy, (back + z0) / 2, x1 - left, SLAB_T, z0 - back, s.floorSurf, s.floorCol);
      } else k.solid(0, sy, 0, sw, SLAB_T, sd, s.floorSurf, s.floorCol);
      if (jet > 0) {
        // Joist ends under the overhang.
        const n = Math.max(2, Math.floor(w / 0.7));
        for (const sz of [1, -1])
          for (let i = 0; i < n; i++) k.box(-w / 2 + (i + 0.5) * (w / n), sy - 0.14, sz * (d / 2 + jet / 2 - 0.02), 0.14, 0.14, jet + 0.04, s.walls[0].frame?.surf ?? Surf.Timber, s.walls[0].frame?.col ?? 0x4a3424, { lod: 1 });
      }
      slabs.push(slab);
    }
    const row: number[] = [];
    for (let side = 0; side < 4; side++) {
      const sup = f === 0 ? [found] : [walls[f - 1][side], slabs[f - 1]];
      const pi = k.piece('wall', look.surf === Surf.Planks || look.surf === Surf.Timber || look.surf === Surf.Bark ? 'wood' : look.surf === Surf.Hide ? 'cloth' : 'stone', sup, 1);
      row.push(pi);
      const L = sideLen(side, w, dd, t);
      pushSide(k, side, w, dd, t, y0);
      // Openings.
      const holes: Opening[] = [];
      if (f === 0 && side === 0 && s.door) holes.push({ x: s.door.x, w: s.door.w, h: s.door.h });
      if (f === 0 && side === 2 && s.backDoor) holes.push({ x: -s.door!.x * 0.5, w: 0.9 * s.scale, h: 2.0 * s.scale });
      wallBoxes(k, L, H, t, holes, look.surf, look.col);
      // Windows.
      const winXs: number[] = [];
      const blind = s.blind?.includes(side) && f === 0;
      if (!blind) {
        const n = Math.max(0, Math.floor((L - 0.8) / s.win.spacing));
        for (let i = 0; i < n; i++) {
          const x = -L / 2 + ((i + 0.5) * L) / n;
          if (holes.some((o) => Math.abs(o.x - x) < o.w / 2 + s.win.w / 2 + 0.35)) continue;
          if (side === 2 && s.chimneyX !== null && Math.abs(-x - s.chimneyX) < 0.9 + s.win.w / 2) continue;
          if (f === 0 && side === 3 && s.stairs) {
            // Stair runs along the left wall: windows there sit too low for the treads; keep them.
          }
          winXs.push(x);
          windowAt(k, x, t, s.win);
        }
      }
      // Door frame / arch.
      for (const o of holes) {
        const fs = s.door?.frameSurf ?? Surf.Timber, fc = s.door?.frameCol ?? 0x4a3424;
        k.box(o.x - o.w / 2 - 0.07, 0, t / 2 + 0.01, 0.14, o.h, 0.1, fs, fc, { lod: 1 });
        k.box(o.x + o.w / 2 + 0.07, 0, t / 2 + 0.01, 0.14, o.h, 0.1, fs, fc, { lod: 1 });
        k.box(o.x, o.h, t / 2 + 0.01, o.w + 0.42, 0.18, 0.12, fs, fc, { lod: 1 });
        if (s.door?.arch && o.w > 0.8 && H - o.h > o.w * 0.55) {
          k.cyl(o.x, o.h + 0.18, t / 2 - 0.02, o.w / 2, o.w / 2, 0.06, Surf.Window, s.win.glassCol, { rx: Math.PI / 2, seg: 10, lod: 1, emit: s.win.glow, emitI: s.win.lit * 0.8, night: true });
          for (let i = 0; i <= 6; i++) {
            const a = (i / 6) * Math.PI;
            k.boxC(o.x + Math.cos(a) * (o.w / 2 + 0.08), o.h + 0.18 + Math.sin(a) * (o.w / 2 + 0.08), t / 2 + 0.04, 0.22, 0.16, 0.1, fs, fc, { rz: a - Math.PI / 2, lod: 1 });
          }
        }
      }
      // Framing & quoins.
      if (look.frame) {
        const Lf = side % 2 === 0 ? L : L + 2 * t;
        const posts: number[] = [];
        const noBrace: [number, number][] = [];
        for (const x of winXs) {
          const ww = s.win.shape === 'slit' ? 0.32 : s.win.w;
          posts.push(x - ww / 2 - 0.16, x + ww / 2 + 0.16);
          noBrace.push([x - ww / 2 - 0.2, x + ww / 2 + 0.2]);
        }
        for (const o of holes) {
          posts.push(o.x - o.w / 2 - 0.2, o.x + o.w / 2 + 0.2);
          noBrace.push([o.x - o.w / 2 - 0.3, o.x + o.w / 2 + 0.3]);
        }
        framing(k, Lf, H, t, look.frame, posts, noBrace, s.win.sill - 0.12);
      }
      if (look.quoin && side % 2 === 0) {
        for (const sx of [-1, 1]) {
          let y = 0, i = 0;
          while (y < H - 0.1) {
            const qh = Math.min(0.34, H - y);
            const qw = i % 2 ? 0.34 : 0.56;
            k.box(sx * (L / 2 - qw / 2 + 0.02), y, t / 2 + 0.02, qw, qh - 0.02, 0.06, look.quoin.surf, look.quoin.col, { lod: 1 });
            y += qh;
            i++;
          }
        }
      }
      // Base course on the ground floor.
      if (f === 0 && s.plinth > 0.05) k.box(0, 0, t / 2 + 0.02, L + (side % 2 ? 2 * t : 0.06), Math.min(0.5, s.plinth + 0.2), 0.06, s.baseSurf, s.baseCol, { lod: 1 });
      k.pop();
    }
    walls.push(row);
  }

  // ---- door leaf
  if (s.door) {
    const dl = s.door;
    doorPiece = k.piece('door', 'wood', [walls[0][0]], 1);
    k.push(dl.x, 0, d / 2 - t / 2, 0);
    const lw = dl.w - 0.04;
    k.box(0, 0.01, 0, lw, dl.h - 0.02, 0.09, dl.surf, dl.col, { lod: 1 });
    // Low-detail fill so mid/far LOD doors aren't holes.
    if (dl.bands) {
      for (const by of [0.3, dl.h - 0.5]) k.box(0, by, 0.05, lw - 0.06, 0.08, 0.02, Surf.Metal, 0x2a2826, { lod: 1 });
    }
    k.cyl(lw / 2 - 0.15, dl.h * 0.48, 0.05, 0.035, 0.035, 0.06, Surf.Metal, 0xb08a40, { rx: Math.PI / 2, seg: 6, lod: 1 });
    k.col(0, 0, 0, lw, dl.h, 0.12, true);
    k.door(-lw / 2, 0, lw, dl.h, 1.65);
    k.pop();
  }

  // ---- interior stairs
  const wallTop = s.floors * storey;
  if (s.stairs && s.floors > 1) {
    k.piece('stairs', 'wood', [found], 1);
    const [x0, z0, x1, z1] = stairRect(w, d, t, storey);
    const n = Math.ceil(storey / 0.2);
    const rise = storey / n;
    const run = (z1 - z0) / n;
    for (let i = 0; i < n; i++) {
      const z = z1 - (i + 0.5) * run;
      k.box((x0 + x1) / 2, i * rise, z, x1 - x0, rise, run, Surf.Planks, scaleHex(s.floorCol, 0.95), { lod: 2 });
      k.col((x0 + x1) / 2, i * rise, z, x1 - x0, rise, run, true);
    }
    // Stringer & handrail.
    k.beam(x1, 0.1, z1, x1, storey + 0.1, z0, 0.08, Surf.Timber, 0x4a3424, { lod: 2, d: 0.08 });
    k.beam(x1, 1.0, z1, x1, storey + 1.0, z0, 0.06, Surf.Timber, 0x4a3424, { lod: 2, d: 0.06 });
  }

  // ---- roof
  const topD = d + (s.floors > 1 ? 2 * s.jetty : 0);
  const topWalls = walls[walls.length - 1];
  const roofPiece = k.piece('roof', s.roof.surf === Surf.Thatch || s.roof.surf === Surf.Turf ? 'plant' : s.roof.surf === Surf.Shingle || s.roof.surf === Surf.Planks ? 'wood' : s.roof.surf === Surf.Hide ? 'cloth' : 'stone', topWalls, 2);
  const topLook = s.walls[Math.min(s.floors - 1, s.walls.length - 1)];
  const gables: number[] = [];
  const ridge = roof(k, s.roof, w, topD, wallTop, t, topLook, topWalls, gables);

  // ---- chimney (stands on the foundation)
  if (s.chimneyX !== null) {
    k.piece('chimney', 'stone', [found], 1);
    const cx = s.chimneyX;
    const top = s.roof.kind === 'flat' ? ridge + 0.8 : Math.max(wallTop + 1.4, Math.min(ridge + 0.4, wallTop + 3.4));
    const cz = -d / 2 + t / 2;
    k.solid(cx, 0, cz, 1.0, wallTop, 0.95, s.chimneySurf, s.chimneyCol);
    k.solid(cx, wallTop, cz, 0.75, top - wallTop, 0.7, s.chimneySurf, s.chimneyCol);
    k.box(cx, top, cz, 0.92, 0.14, 0.86, s.chimneySurf, scaleHex(s.chimneyCol, 0.85), { lod: 1 });
    k.box(cx - 0.2, top + 0.14, cz, 0.18, 0.28, 0.18, Surf.ClayTile, 0x9a5a3a, { lod: 1 });
    k.box(cx + 0.18, top + 0.14, cz, 0.18, 0.22, 0.18, Surf.ClayTile, 0x8a4a32, { lod: 1 });
    k.smoke(cx, top + 0.45, cz);
  }

  // ---- porch
  if (s.porch && s.door) {
    const p = s.porch;
    k.piece('porch', 'wood', [found], 1);
    const pw = Math.min(w - 0.4, s.door.w + 2.4 * s.scale);
    const pz = d / 2 + p.depth / 2;
    const fy = Math.min(0, frontG);
    k.solid(s.door.x, fy - 0.2, pz, pw, -fy + 0.2 - 0.02, p.depth, p.surf, p.col);
    const ph = Math.min(storey * 0.85, 2.6 * s.scale);
    for (const sx of [-1, 1]) {
      const px = s.door.x + sx * (pw / 2 - 0.12);
      k.box(px, 0, d / 2 + p.depth - 0.12, 0.16, ph, 0.16, p.postSurf, p.postCol);
      k.col(px, 0, d / 2 + p.depth - 0.12, 0.16, ph, 0.16, true);
      // Corbel brackets.
      k.beam(px, ph - 0.5, d / 2 + p.depth - 0.12, px, ph, d / 2 + p.depth - 0.5, 0.1, p.postSurf, p.postCol, { lod: 1 });
    }
    // Shed roof over the porch.
    const rise = 0.45;
    const len = Math.hypot(p.depth + 0.3, rise);
    k.boxC(s.door.x, ph + rise / 2 + 0.06, d / 2 + (p.depth + 0.3) / 2, pw + 0.4, 0.1, len, p.roofSurf, p.roofCol, { rx: Math.atan2(rise, p.depth + 0.3) });
    k.box(s.door.x, ph, d / 2 + p.depth - 0.12, pw, 0.14, 0.16, p.postSurf, p.postCol, { lod: 1 });
    // Railing.
    for (const sx of [-1, 1]) {
      const rx0 = s.door.x + sx * (pw / 2 - 0.12);
      k.box(rx0, 0.85, d / 2 + p.depth / 2, 0.06, 0.06, p.depth, p.postSurf, p.postCol, { lod: 1 });
      for (let i = 1; i < 4; i++) k.box(rx0, 0, d / 2 + (i * p.depth) / 4, 0.04, 0.85, 0.04, p.postSurf, p.postCol, { lod: 1 });
    }
  }

  // ---- balcony on the first upper storey
  if (s.balcony && s.floors > 1) {
    k.piece('balcony', 'wood', [walls[1][0]], 1);
    const bw = Math.min(w * 0.6, 3.2);
    const by = storey;
    const bz = topD / 2 + 0.5;
    const ty = s.walls[1].frame?.col ?? 0x4a3424;
    k.solid(0, by - 0.12, bz, bw, 0.12, 1.0, Surf.Planks, 0x8a6a48);
    for (const sx of [-1, 1]) k.beam(sx * (bw / 2 - 0.2), by - 0.9, topD / 2, sx * (bw / 2 - 0.2), by - 0.12, bz + 0.4, 0.12, Surf.Timber, ty, { lod: 1 });
    k.box(0, by + 0.9, bz + 0.47, bw, 0.07, 0.07, Surf.Timber, ty, { lod: 1 });
    const n = Math.floor(bw / 0.18);
    for (let i = 0; i <= n; i++) k.box(-bw / 2 + (i * bw) / n, by, bz + 0.47, 0.05, 0.9, 0.05, Surf.Timber, ty, { lod: 1 });
    for (const sx of [-1, 1]) k.box(sx * (bw / 2), by, bz, 0.06, 0.95, 1.0, Surf.Timber, ty, { lod: 1 });
    k.col(0, by, bz + 0.47, bw, 1.0, 0.1, true);
  }

  // Keep rng advancing deterministically regardless of branches.
  rng.float();
  return { found, walls, slabs, roof: roofPiece, gables, door: doorPiece, wallTop, ridge, topD };
}

/**
 * Roof over an outer footprint w×d at height y0. Adds to the current piece
 * (the caller started the roof piece); gable walls become their own pieces.
 * Returns the apex height.
 */
export function roof(k: Kit, r: RoofLook, w: number, d: number, y0: number, t: number, gableLook: WallLook | null, sup: number[], gables: number[]): number {
  const roofPiece = k.pieces.indexOf(k.cur);
  const o = r.overhang;
  // Ridge along the longer side: rotate the frame so the ridge always runs along local x.
  const along = w >= d;
  const W = along ? w : d, D = along ? d : w;
  k.push(0, 0, 0, along ? 0 : Math.PI / 2);
  // Ceiling of the top storey (seen from inside).
  k.box(0, y0 - 0.06, 0, W - 2 * t, 0.06, D - 2 * t, Surf.Planks, 0x7a6048, { lod: 2 });
  let apex = y0;
  switch (r.kind) {
    case 'gable': {
      const H = r.pitch * (D / 2);
      const a = Math.atan2(H, D / 2);
      const span = D / 2 + o;
      const S = span / Math.cos(a);
      const L = W + o * 1.2;
      for (const sz of [1, -1]) {
        // Top surface line runs from the eave (z = sz·span, y = y0 − o·tanα) to the ridge.
        const zc = (sz * span) / 2;
        const yc = y0 + H - (span / 2) * Math.tan(a);
        const nz = sz * Math.sin(a), ny = Math.cos(a);
        k.boxC(0, yc - (ny * r.thick) / 2, zc - (nz * r.thick) / 2, L, r.thick, S, r.surf, r.col, { rx: sz * a });
        if (r.dormers > 0 && sz === 1) {
          for (let i = 0; i < r.dormers; i++) {
            const dx = -W / 2 + ((i + 0.5) * W) / r.dormers;
            const dz = D / 2 - 0.9;
            const dy = y0 + (D / 2 - dz) * Math.tan(a) - 0.4;
            k.box(dx, dy, dz, 1.1, 1.25, 1.2, gableLook?.surf ?? Surf.Plaster, gableLook?.col ?? 0xe8dcc0, { lod: 1 });
            k.box(dx, dy + 0.25, dz + 0.6, 0.6, 0.75, 0.06, Surf.Window, 0x30384a, { lod: 1, emit: 0xffb35c, emitI: 0.6, night: true });
            k.frustum(dx, dy + 1.25, dz, 1.4, 1.5, 0, 1.5, 0.55, r.surf, r.col, { lod: 1, ry: Math.PI / 2 });
          }
        }
      }
      // Ridge cap.
      if (r.surf === Surf.Thatch || r.surf === Surf.Turf) k.cyl(-L / 2, y0 + H - 0.05, 0, 0.32, 0.32, L, r.surf, r.col, { rz: -Math.PI / 2, seg: 8, lod: 1 });
      else k.box(0, y0 + H - 0.04, 0, L, 0.16, 0.3, r.trimSurf, r.trimCol, { lod: 1 });
      if (r.finial) for (const sx of [-1, 1]) k.cyl(sx * (L / 2 - 0.1), y0 + H, 0, 0.08, 0.0, 0.8, r.trimSurf, r.trimCol, { seg: 6, lod: 1 });
      // Gable walls: own pieces, carried by the walls under them.
      for (const sx of [-1, 1]) {
        const gi = k.piece('gable', gableLook?.surf === Surf.Plaster || gableLook?.surf === Surf.StoneBrick ? 'stone' : 'wood', along ? [sup[sx > 0 ? 1 : 3]] : [sup[sx > 0 ? 2 : 0]], 1);
        gables.push(gi);
        k.frustum(sx * (W / 2 - t / 2), y0, 0, t, D, t, 0, H, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col);
        k.col(sx * (W / 2 - t / 2), y0, 0, t, H * 0.6, D * 0.7, true);
        if (gableLook?.frame) {
          const fz = gableLook.frame;
          k.box(sx * (W / 2 + 0.01), y0, 0, 0.06, H - 0.1, fz.w, fz.surf, fz.col, { lod: 1 });
          k.beam(sx * (W / 2 + 0.01), y0 + 0.05, D / 2 - 0.1, sx * (W / 2 + 0.01), y0 + H - 0.1, 0, fz.w, fz.surf, fz.col, { lod: 1, d: 0.06 });
          k.beam(sx * (W / 2 + 0.01), y0 + 0.05, -D / 2 + 0.1, sx * (W / 2 + 0.01), y0 + H - 0.1, 0, fz.w, fz.surf, fz.col, { lod: 1, d: 0.06 });
          k.box(sx * (W / 2 + 0.01), y0 + H * 0.4, 0, 0.06, fz.w, D * 0.6, fz.surf, fz.col, { lod: 1 });
        }
        // Bargeboards along the gable edges.
        for (const sz of [1, -1]) {
          k.beam(sx * (W / 2 + o * 0.6), y0 - o * Math.tan(a) - 0.05, sz * span, sx * (W / 2 + o * 0.6), y0 + H, 0, 0.22, r.trimSurf, r.trimCol, { lod: 1, d: 0.06 });
        }
        // Small attic window in the gable.
        if (H > 1.6) k.box(sx * (W / 2 - t / 2), y0 + H * 0.3, 0, t + 0.04, 0.6, 0.5, Surf.Window, 0x30384a, { lod: 1, emit: 0xffb35c, emitI: 0.4, night: true, ry: 0 });
        k.use(roofPiece);
      }
      apex = y0 + H + r.thick;
      break;
    }
    case 'hip':
    case 'mansard': {
      if (r.kind === 'mansard') {
        const h1 = Math.min(2.2, D * 0.35);
        const ins = 0.7;
        k.frustum(0, y0 - 0.1, 0, W + 2 * o, D + 2 * o, W - 2 * ins, D - 2 * ins, h1, r.surf, r.col);
        // Dormers on the steep part.
        const n = Math.max(1, Math.floor(W / 2.6));
        for (let i = 0; i < n; i++) {
          const dx = -W / 2 + ((i + 0.5) * W) / n;
          for (const sz of [1, -1]) {
            k.box(dx, y0 + 0.3, sz * (D / 2 - 0.1), 0.9, 1.1, 0.5, Surf.Plaster, 0xe6dccc, { lod: 1 });
            k.box(dx, y0 + 0.45, sz * (D / 2 + 0.16), 0.5, 0.7, 0.04, Surf.Window, 0x30384a, { lod: 1, emit: 0xffb35c, emitI: 0.6, night: true });
            k.frustum(dx, y0 + 1.4, sz * (D / 2 - 0.1), 1.1, 0.7, 0, 0.7, 0.4, r.surf, r.col, { lod: 1, ry: Math.PI / 2 });
          }
        }
        const H2 = r.pitch * 0.35 * (D / 2 - ins);
        k.frustum(0, y0 - 0.1 + h1, 0, W - 2 * ins, D - 2 * ins, Math.max(0.02, W - D), 0, H2, r.surf, r.col);
        apex = y0 + h1 + H2;
      } else {
        const H = r.pitch * (D / 2);
        const drop = o * r.pitch;
        k.frustum(0, y0 - drop, 0, W + 2 * o, D + 2 * o, Math.max(0.02, W - D), 0, H + drop, r.surf, r.col);
        k.box(0, y0 + H - 0.08, 0, Math.max(0.3, W - D), 0.14, 0.24, r.trimSurf, r.trimCol, { lod: 1 });
        apex = y0 + H;
      }
      if (r.finial) k.cyl(0, apex - 0.1, 0, 0.1, 0, 1.0, r.trimSurf, r.trimCol, { seg: 6, lod: 1 });
      break;
    }
    case 'conical': {
      const H = r.pitch * (D / 2) * 1.2;
      k.frustum(0, y0 - o * 0.5, 0, W + 2 * o, D + 2 * o, 0, 0, H + o * 0.5, r.surf, r.col);
      if (r.finial) k.cyl(0, y0 + H - 0.2, 0, 0.09, 0, 1.4, r.trimSurf, r.trimCol, { seg: 6, lod: 1 });
      apex = y0 + H;
      break;
    }
    case 'dome': {
      const H = Math.max(1.2, r.pitch * (D / 2));
      k.box(0, y0 - 0.1, 0, W + 0.2, 0.3, D + 0.2, r.trimSurf, r.trimCol);
      k.sphere(0, y0 + 0.2, 0, W / 2 + o * 0.5, H, D / 2 + o * 0.5, r.surf, r.col, { lat0: 0, lat1: Math.PI / 2, seg: 16 });
      if (r.finial) k.cyl(0, y0 + 0.2 + H - 0.1, 0, 0.1, 0, 1.0, r.trimSurf, r.trimCol, { seg: 6, lod: 1 });
      apex = y0 + 0.2 + H;
      break;
    }
    case 'shed': {
      const H = r.pitch * D * 0.5;
      const a = Math.atan2(H, D);
      const span = D + 2 * o;
      const S = span / Math.cos(a);
      k.boxC(0, y0 + H / 2 + r.thick / 2, 0, W + o * 1.2, r.thick, S, r.surf, r.col, { rx: a });
      // Back wall extension up to the high eave, triangular side walls under the slope.
      k.box(0, y0, -D / 2 + t / 2, W, H, t, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col);
      for (const sx of [-1, 1]) k.frustum(sx * (W / 2 - t / 2), y0, 0, t, D, t, 0.02, H, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col, { oz: -D / 2 + 0.01 });
      apex = y0 + H + r.thick;
      break;
    }
    case 'flat': {
      k.solid(0, y0, 0, W + 0.12, 0.3, D + 0.12, r.surf, r.col);
      const ph = r.crenel ? 1.0 : 0.6;
      const pt = Math.max(0.25, t * 0.6);
      for (const sz of [1, -1]) k.solid(0, y0 + 0.3, sz * (D / 2 - pt / 2 + 0.06), W + 0.12, ph, pt, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col);
      for (const sx of [-1, 1]) k.solid(sx * (W / 2 - pt / 2 + 0.06), y0 + 0.3, 0, pt, ph, D - 2 * pt + 0.12, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col);
      if (r.crenel) {
        const step = 0.9;
        for (const sz of [1, -1]) for (let x = -W / 2 + 0.3; x < W / 2 - 0.2; x += step) k.box(x + 0.25, y0 + 0.3 + ph, sz * (D / 2 - pt / 2 + 0.06), 0.5, 0.5, pt, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col, { lod: 1 });
        for (const sx of [-1, 1]) for (let z = -D / 2 + 0.3; z < D / 2 - 0.2; z += step) k.box(sx * (W / 2 - pt / 2 + 0.06), y0 + 0.3 + ph, z + 0.25, pt, 0.5, 0.5, gableLook?.surf ?? r.surf, gableLook?.col ?? r.col, { lod: 1 });
      }
      // Cornice.
      k.box(0, y0 - 0.12, 0, W + 0.3, 0.14, D + 0.3, r.trimSurf, r.trimCol, { lod: 1 });
      apex = y0 + 0.3 + ph + (r.crenel ? 0.5 : 0);
      break;
    }
    case 'none':
      apex = y0;
      break;
  }
  k.pop();
  return apex;
}
