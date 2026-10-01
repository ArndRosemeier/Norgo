/**
 * Furniture pieces (interior LOD): beds, tables, hearths with fire light,
 * bars, forges, anvils, altars, bookcases, pews, thrones... Each item is one
 * destructible piece with a collider and (for beds/seats) an interaction
 * anchor. Local frame per item: +z = the side it faces (into the room).
 */
import type { FurnitureInfo } from '../types';
import { Kit, Surf, jitter, scaleHex, type PieceMat } from './kit';
import type { StyleDef } from './styles';

export interface FurnishCtx {
  st: StyleDef;
  /** Race scale. */
  s: number;
  /** Household wealth 0..1. */
  wealth: number;
  /** Wood tint for furniture. */
  wood: number;
  /** Stone tint. */
  stone: number;
  /** Fabric accent colour. */
  cloth: number;
}

const BOOK_COLS = [0x7a2a2a, 0x2a3a6a, 0x2a5a3a, 0x6a5a2a, 0x4a2a5a, 0x8a6a3a, 0x3a3a3a];

/** Build one furniture item as its own piece supported by `sup`. */
export function buildFurniture(k: Kit, f: FurnitureInfo, c: FurnishCtx, sup: number): number {
  const r = k.rng;
  const s = c.s;
  const mat: PieceMat = f.kind === 'hearth' || f.kind === 'forge' || f.kind === 'altar' || f.kind === 'millstone' ? 'stone' : f.kind === 'anvil' || f.kind === 'cauldron' ? 'metal' : f.kind === 'rug' || f.kind === 'sacks' ? 'cloth' : f.kind === 'haybale' ? 'plant' : 'wood';
  const pi = k.piece('furniture', mat, [sup], 1);
  const prevLod = k.lod;
  k.lod = 2;
  k.push(f.x, f.y, f.z, f.yaw);
  // Item extents in its own frame: w along x, d along z (back at −d/2).
  const w = f.w, d = f.d;
  const wood = jitter(c.wood, r, 0.06);
  const dark = scaleHex(wood, 0.7);
  switch (f.kind) {
    case 'bed':
    case 'bunk': {
      const levels = f.kind === 'bunk' ? [0, 1.05 * s] : [0];
      for (const ly of levels) {
        const fy = ly + 0.18 * s;
        k.box(0, fy, 0, w, 0.22 * s, d, Surf.Planks, wood);
        k.box(0, fy + 0.22 * s, 0.05, w - 0.08, 0.16 * s, d - 0.2, Surf.Cloth, 0xe8e0d0);
        k.box(0, fy + 0.3 * s, 0.25 * s, w - 0.04, 0.1 * s, d * 0.62, Surf.Cloth, jitter(c.cloth, r, 0.15));
        k.box(0, fy + 0.36 * s, -d / 2 + 0.3 * s, w * 0.7, 0.12 * s, 0.32 * s, Surf.Cloth, 0xf2eee6);
      }
      // Posts & headboard.
      const top = f.kind === 'bunk' ? 2.1 * s : 0.95 * s;
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box((sx * (w - 0.08)) / 2, 0, (sz * (d - 0.08)) / 2, 0.08, sz < 0 ? top : f.kind === 'bunk' ? top : 0.55 * s, 0.08, Surf.Timber, dark);
      k.box(0, 0.4 * s, -d / 2 + 0.04, w, 0.5 * s, 0.05, Surf.Planks, dark);
      if (f.kind === 'bunk') for (let i = 0; i < 4; i++) k.box(w / 2 + 0.03, 0.3 * s + i * 0.35 * s, d / 2 - 0.3, 0.05, 0.05, 0.4, Surf.Timber, dark);
      k.col(0, 0, 0, w, 0.55 * s, d, true);
      k.seat(0, 0.55 * s, 0, 0, 'Sleep');
      break;
    }
    case 'table':
    case 'longtable':
    case 'desk': {
      const th = 0.74 * s;
      k.box(0, th - 0.06, 0, w, 0.06, d, Surf.Planks, wood);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box((sx * (w - 0.16)) / 2, 0, (sz * (d - 0.16)) / 2, 0.08, th - 0.06, 0.08, Surf.Timber, dark);
      k.box(0, 0.12, 0, w - 0.2, 0.05, 0.05, Surf.Timber, dark);
      if (f.kind === 'desk') {
        k.box(w / 4, th - 0.3, 0, w / 2 - 0.1, 0.24, d - 0.1, Surf.Planks, dark);
        k.box(-w / 3, th, -d / 4, 0.3, 0.02, 0.22, Surf.Cloth, 0xe8dcc0);
        k.box(w / 3, th, -d / 3, 0.22, 0.06, 0.16, Surf.Cloth, r.pick(BOOK_COLS));
        k.cyl(0, th, -d / 3, 0.03, 0.03, 0.14, Surf.Cloth, 0xf0e8d0, { seg: 6 });
        k.sphere(0, th + 0.17, -d / 3, 0.02, 0.035, 0.02, Surf.Fire, 0xffc060, { emit: 0xffa040, emitI: 3, seg: 5 });
      } else {
        // Clutter: mugs, plates, a candle.
        const n = Math.max(2, Math.floor(w / 0.5));
        for (let i = 0; i < n; i++) {
          const x = -w / 2 + ((i + 0.5) * w) / n, z = r.range(-d / 4, d / 4);
          if (r.chance(0.5)) k.cyl(x, th, z, 0.05, 0.045, 0.11, Surf.Planks, scaleHex(wood, 1.15), { seg: 6 });
          else k.cyl(x, th, z, 0.12, 0.12, 0.015, Surf.ClayTile, 0xd8d0c0, { seg: 8 });
        }
        if (r.chance(0.6)) {
          k.cyl(0, th, 0, 0.035, 0.035, 0.16, Surf.Cloth, 0xf0e8d0, { seg: 6 });
          k.sphere(0, th + 0.19, 0, 0.02, 0.035, 0.02, Surf.Fire, 0xffc060, { emit: 0xffa040, emitI: 3, seg: 5 });
        }
      }
      k.col(0, 0, 0, w, th, d, true);
      break;
    }
    case 'chair':
    case 'throne': {
      const big = f.kind === 'throne';
      const sw = big ? 0.9 * s : 0.44 * s, sh = 0.46 * s;
      k.box(0, sh - 0.05, 0, sw, 0.05, sw, Surf.Planks, wood);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box((sx * (sw - 0.06)) / 2, 0, (sz * (sw - 0.06)) / 2, 0.05, sh - 0.05, 0.05, Surf.Timber, dark);
      const bh = big ? 1.9 * s : 0.5 * s;
      k.box(0, sh, -sw / 2 + 0.03, sw, bh, 0.05, Surf.Planks, wood);
      if (big) {
        k.box(0, sh, 0, sw - 0.1, 0.1, sw - 0.1, Surf.Cloth, c.cloth);
        k.box(0, sh + 0.1, -sw / 2 + 0.1, sw - 0.2, bh * 0.7, 0.06, Surf.Cloth, c.cloth);
        for (const sx of [-1, 1]) {
          k.box((sx * sw) / 2, sh, 0, 0.1, 0.35 * s, sw, Surf.Planks, wood);
          k.sphere((sx * sw) / 2, sh + bh, -sw / 2 + 0.03, 0.09, 0.09, 0.09, Surf.Metal, 0xc0a040, { seg: 6 });
        }
        k.box(0, 0, 0.2, sw + 0.6, 0.2, sw + 0.8, Surf.StoneBrick, c.stone);
      }
      k.col(0, 0, 0, sw, sh, sw, big);
      k.seat(0, sh, 0, 0, 'Sit');
      break;
    }
    case 'stool': {
      k.cyl(0, 0.42 * s, 0, 0.18 * s, 0.18 * s, 0.05, Surf.Planks, wood, { seg: 8 });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        k.pole(Math.cos(a) * 0.15 * s, 0, Math.sin(a) * 0.15 * s, Math.cos(a) * 0.08 * s, 0.42 * s, Math.sin(a) * 0.08 * s, 0.025, 0.025, Surf.Timber, dark);
      }
      k.col(0, 0, 0, 0.4 * s, 0.45 * s, 0.4 * s, false);
      k.seat(0, 0.45 * s, 0, 0, 'Sit');
      break;
    }
    case 'bench':
    case 'pew': {
      const sh = 0.45 * s;
      k.box(0, sh - 0.06, 0, w, 0.06, 0.38 * s, Surf.Planks, wood);
      for (const sx of [-1, 1]) k.box((sx * (w - 0.2)) / 2, 0, 0, 0.07, sh - 0.06, 0.34 * s, Surf.Planks, dark);
      if (f.kind === 'pew') {
        k.box(0, sh, -0.17 * s, w, 0.5 * s, 0.05, Surf.Planks, wood);
        for (const sx of [-1, 1]) k.box((sx * w) / 2, 0, 0, 0.06, 0.95 * s, 0.4 * s, Surf.Planks, dark);
      }
      k.col(0, 0, 0, w, sh, 0.4 * s, false);
      k.seat(0, sh, 0, 0, f.kind === 'pew' ? 'Pray' : 'Sit');
      break;
    }
    case 'hearth': {
      const hh = 1.25 * s;
      const stone = jitter(c.stone, r, 0.08);
      k.box(0, 0, -d / 2 + 0.2, w, hh, 0.4, Surf.StoneBrick, stone);
      for (const sx of [-1, 1]) k.box((sx * (w - 0.3)) / 2, 0, 0.05, 0.3, hh, d - 0.2, Surf.StoneBrick, stone);
      k.box(0, hh - 0.25, 0.05, w, 0.25, d - 0.2, Surf.StoneBrick, scaleHex(stone, 0.9));
      k.box(0, hh, 0.05, w + 0.2, 0.08, d, Surf.Planks, dark);
      k.box(0, 0, 0.1, w - 0.6, 0.06, d * 0.7, Surf.Rubble, 0x302a26);
      // Logs & fire.
      k.pole(-0.3 * s, 0.1, 0, 0.3 * s, 0.12, 0.05, 0.06, 0.06, Surf.Bark, 0x4a3424);
      k.pole(-0.25 * s, 0.12, 0.1, 0.25 * s, 0.1, -0.1, 0.05, 0.05, Surf.Bark, 0x3e2c1e);
      k.cyl(0, 0.1, 0.05, 0.28 * s, 0.02, 0.6 * s, Surf.Fire, 0xffb050, { emit: 0xff7a20, emitI: 4, seg: 6 });
      k.cyl(0.08, 0.1, 0.0, 0.16 * s, 0.01, 0.42 * s, Surf.Fire, 0xffe090, { emit: 0xffc060, emitI: 5, seg: 5 });
      // Pot hook & mantel clutter.
      k.cyl(0.25, hh + 0.08, 0.05, 0.05, 0.05, 0.2, Surf.ClayTile, 0xa06040, { seg: 6 });
      k.cyl(-0.3, hh + 0.08, 0.05, 0.06, 0.04, 0.18, Surf.Metal, 0x605850, { seg: 6 });
      k.col(0, 0, 0, w, hh, d, true);
      k.light(0, 0.6 * s, 0.6, 0xff9a40, 5, 8, false, 1);
      break;
    }
    case 'forge': {
      const stone = jitter(c.stone, r, 0.08);
      k.box(0, 0, 0, w, 0.85 * s, d, Surf.StoneBrick, stone);
      k.box(0, 0.85 * s, 0, w - 0.4, 0.06, d - 0.4, Surf.Fire, 0xff8a30, { emit: 0xff5a10, emitI: 4 });
      k.frustum(0, 1.7 * s, -0.1, w, d - 0.1, 0.6, 0.5, 1.1 * s, Surf.StoneBrick, scaleHex(stone, 0.85), { oz: -0.2 });
      for (const sx of [-1, 1]) k.box((sx * (w - 0.2)) / 2, 0.85 * s, -0.1, 0.2, 0.85 * s, d - 0.3, Surf.StoneBrick, stone);
      // Bellows.
      k.frustum(w / 2 + 0.35, 0.5, 0, 0.5, 0.8, 0.3, 0.6, 0.35, Surf.Hide, 0x6a4a30);
      k.col(0, 0, 0, w, 1.4 * s, d, true);
      k.light(0, 1.1 * s, d / 2 + 0.3, 0xff6a20, 6, 9, false, 0.8);
      break;
    }
    case 'anvil': {
      k.cyl(0, 0, 0, 0.3 * s, 0.32 * s, 0.5 * s, Surf.Bark, 0x5a4430, { seg: 8 });
      k.box(0, 0.5 * s, 0, 0.22 * s, 0.14 * s, 0.32 * s, Surf.Metal, 0x3a3a3c);
      k.box(0, 0.64 * s, 0, 0.3 * s, 0.14 * s, 0.6 * s, Surf.Metal, 0x404044);
      k.cyl(0, 0.71 * s, 0.3 * s, 0.07 * s, 0.0, 0.3 * s, Surf.Metal, 0x404044, { rx: Math.PI / 2, seg: 6 });
      k.box(0.1, 0.78 * s, -0.1, 0.06, 0.04, 0.3, Surf.Metal, 0x5a5048);
      k.col(0, 0, 0, 0.6 * s, 0.8 * s, 0.9 * s, true);
      break;
    }
    case 'altar': {
      const stone = c.st.id === 'umbral' || c.st.id === 'drakeborn' ? scaleHex(c.stone, 0.7) : jitter(0xd8d2c4, r, 0.05);
      k.box(0, 0, 0, w, 0.95 * s, d, Surf.Marble, stone);
      k.box(0, 0.95 * s, 0, w + 0.15, 0.08, d + 0.15, Surf.Marble, scaleHex(stone, 0.92));
      k.box(0, 0.4, d / 2 + 0.01, w * 0.5, 0.6, 0.02, Surf.Cloth, c.cloth);
      k.box(0, 1.03 * s, 0, 0.5, 0.02, d + 0.2, Surf.Cloth, c.cloth);
      for (const sx of [-1, 1]) {
        k.cyl((sx * w) / 2.6, 1.03 * s, 0, 0.04, 0.04, 0.3, Surf.Cloth, 0xf0e8d0, { seg: 6 });
        k.sphere((sx * w) / 2.6, 1.37 * s, 0, 0.025, 0.04, 0.025, Surf.Fire, 0xffc060, { emit: 0xffa040, emitI: 4, seg: 5 });
      }
      k.cyl(0, 1.03 * s, -0.1, 0.12, 0.08, 0.5, Surf.Metal, 0xc0a040, { seg: 8 });
      k.sphere(0, 1.6 * s, -0.1, 0.13, 0.13, 0.13, Surf.Metal, 0xd0b050, { seg: 8 });
      k.col(0, 0, 0, w, 1.0 * s, d, true);
      k.light(0, 1.6 * s, 0.4, 0xffc070, 2.5, 5, false, 0.3);
      k.seat(0, 0, d / 2 + 0.8, Math.PI, 'Pray');
      break;
    }
    case 'counter': {
      const ch = 1.05 * s;
      k.box(0, 0, 0.05, w, ch - 0.06, d - 0.15, Surf.Planks, wood);
      k.box(0, ch - 0.06, 0, w + 0.1, 0.07, d, Surf.Planks, scaleHex(wood, 0.85));
      k.box(0, 0.1, d / 2 - 0.05, w - 0.1, 0.06, 0.06, Surf.Metal, 0x8a7040);
      const n = Math.floor(w / 0.6);
      for (let i = 0; i < n; i++) if (r.chance(0.6)) k.cyl(-w / 2 + (i + 0.5) * (w / n), ch, r.range(-0.1, 0.1), 0.05, 0.045, 0.12, Surf.Planks, scaleHex(wood, 1.2), { seg: 6 });
      k.col(0, 0, 0, w, ch, d, true);
      break;
    }
    case 'barrel': {
      const rr = (w / 2) * 0.95, h = 0.95 * s;
      k.cyl(0, 0, 0, rr * 0.85, rr * 0.95, h / 2, Surf.Planks, wood, { seg: 10, rx: 0 });
      k.cyl(0, h / 2, 0, rr * 0.95, rr * 0.85, h / 2, Surf.Planks, wood, { seg: 10 });
      for (const hy of [0.1, h / 2 - 0.03, h - 0.14]) k.cyl(0, hy, 0, rr * 0.97, rr * 0.97, 0.05, Surf.Metal, 0x3a3634, { seg: 10 });
      k.col(0, 0, 0, w, h, w, true);
      break;
    }
    case 'crate':
    case 'chest': {
      const h = (f.kind === 'chest' ? 0.55 : 0.75) * s;
      k.box(0, 0, 0, w, h, d, Surf.Planks, wood);
      if (f.kind === 'chest') {
        k.cyl(-w / 2, h, 0, d / 2, d / 2, w, Surf.Planks, scaleHex(wood, 0.9), { rz: -Math.PI / 2, seg: 8 });
        for (const sx of [-0.3, 0.3]) k.box(sx * w, 0, 0, 0.05, h + 0.02, d + 0.02, Surf.Metal, 0x3a3634);
        k.box(0, h - 0.12, d / 2 + 0.02, 0.1, 0.12, 0.03, Surf.Metal, 0xb09040);
        k.col(0, 0, 0, w, h + d / 2, d, true);
      } else {
        for (const sy of [0, h - 0.06]) k.box(0, sy, 0, w + 0.02, 0.06, d + 0.02, Surf.Timber, dark);
        k.beam(-w / 2 + 0.05, 0.05, d / 2 + 0.01, w / 2 - 0.05, h - 0.05, d / 2 + 0.01, 0.06, Surf.Timber, dark, { d: 0.02 });
        k.col(0, 0, 0, w, h, d, true);
      }
      break;
    }
    case 'wardrobe':
    case 'shelf':
    case 'bookcase': {
      const h = (f.kind === 'shelf' ? 1.6 : 2.0) * s;
      k.box(0, 0, -d / 2 + 0.03, w, h, 0.04, Surf.Planks, dark);
      for (const sx of [-1, 1]) k.box((sx * (w - 0.04)) / 2, 0, 0, 0.04, h, d, Surf.Planks, wood);
      k.box(0, h - 0.04, 0, w, 0.04, d, Surf.Planks, wood);
      if (f.kind === 'wardrobe') {
        k.box(0, 0.05, d / 2 - 0.02, w - 0.04, h - 0.1, 0.04, Surf.Planks, wood);
        k.box(0, 0.05, d / 2, 0.02, h - 0.1, 0.03, Surf.Timber, dark);
        for (const sx of [-1, 1]) k.box(sx * 0.08, h * 0.5, d / 2 + 0.02, 0.03, 0.12, 0.03, Surf.Metal, 0xb09040);
      } else {
        const shelves = f.kind === 'shelf' ? 3 : 5;
        for (let i = 0; i < shelves; i++) {
          const y = 0.05 + (i * (h - 0.1)) / shelves;
          k.box(0, y, 0, w - 0.06, 0.03, d - 0.02, Surf.Planks, wood);
          if (f.kind === 'bookcase') {
            let x = -w / 2 + 0.06;
            while (x < w / 2 - 0.12) {
              const bw = r.range(0.04, 0.09), bh = r.range(0.2, 0.32) * s;
              k.box(x + bw / 2, y + 0.03, 0.02, bw, bh, d * 0.75, Surf.Cloth, r.pick(BOOK_COLS));
              x += bw + 0.005;
              if (r.chance(0.08)) x += 0.12;
            }
          } else {
            for (let j = 0; j < 3; j++) {
              const x = -w / 2 + 0.2 + j * ((w - 0.4) / 2);
              if (r.chance(0.5)) k.cyl(x, y + 0.03, 0, 0.07, 0.05, 0.18, Surf.ClayTile, r.pick([0xa06040, 0x8a7a60, 0x5a6a7a]), { seg: 6 });
              else k.box(x, y + 0.03, 0, 0.18, 0.12, 0.2, Surf.Planks, scaleHex(wood, 1.1));
            }
          }
        }
      }
      k.col(0, 0, 0, w, h, d, true);
      if (f.kind === 'bookcase') k.seat(0, 0, d / 2 + 0.5, Math.PI, 'Read');
      break;
    }
    case 'workbench':
    case 'loom': {
      const th = 0.85 * s;
      if (f.kind === 'loom') {
        for (const sx of [-1, 1]) k.box((sx * w) / 2, 0, 0, 0.08, 1.6 * s, d, Surf.Timber, dark);
        k.box(0, 1.5 * s, 0, w, 0.08, 0.08, Surf.Timber, dark);
        k.box(0, 0.7 * s, 0.1, w, 0.06, 0.4, Surf.Timber, dark);
        k.box(0, 0.75 * s, 0, w - 0.2, 0.75 * s, 0.01, Surf.Rope, jitter(c.cloth, r, 0.2));
      } else {
        k.box(0, th - 0.08, 0, w, 0.08, d, Surf.Planks, scaleHex(wood, 0.9));
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box((sx * (w - 0.12)) / 2, 0, (sz * (d - 0.12)) / 2, 0.1, th - 0.08, 0.1, Surf.Timber, dark);
        k.box(0, 0.2, 0, w - 0.2, 0.04, d - 0.2, Surf.Planks, dark);
        k.box(-w / 3, th, 0, 0.35, 0.02, 0.12, Surf.Metal, 0x7a7a7a);
        k.box(w / 4, th, 0.1, 0.05, 0.05, 0.3, Surf.Timber, dark);
        k.box(w / 4, th, 0.25, 0.12, 0.06, 0.06, Surf.Metal, 0x4a4a4a);
        k.box(w / 2 - 0.1, th, -0.2, 0.15, 0.15, 0.15, Surf.Metal, 0x3a3a3a);
        // Tool wall.
        for (let i = 0; i < 4; i++) k.box(-w / 2 + 0.3 + i * 0.4, th + 0.4, -d / 2 + 0.02, 0.04, 0.4, 0.03, Surf.Timber, dark);
      }
      k.col(0, 0, 0, w, th, d, true);
      break;
    }
    case 'cauldron': {
      // Fire pit with a cauldron on a tripod.
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        k.sphere(Math.cos(a) * 0.55 * s, 0.08, Math.sin(a) * 0.55 * s, 0.16, 0.12, 0.14, Surf.Rubble, jitter(0x7a746a, r, 0.1), { seg: 6 });
      }
      k.cyl(0, 0, 0, 0.3 * s, 0.03, 0.55 * s, Surf.Fire, 0xffb050, { emit: 0xff7a20, emitI: 4, seg: 6 });
      k.sphere(0, 0.75 * s, 0, 0.36 * s, 0.32 * s, 0.36 * s, Surf.Metal, 0x2e2c2a, { lat0: Math.PI / 2 - 0.2, lat1: Math.PI, seg: 10 });
      k.cyl(0, 0.82 * s, 0, 0.3 * s, 0.3 * s, 0.02, Surf.Glow, 0x6a8a3a, { emit: 0x3a5a10, emitI: 0.6, seg: 10 });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        k.pole(Math.cos(a) * 0.6 * s, 0, Math.sin(a) * 0.6 * s, 0, 1.4 * s, 0, 0.03, 0.03, Surf.Timber, dark);
      }
      k.col(0, 0, 0, 1.0 * s, 0.9 * s, 1.0 * s, true);
      k.light(0, 0.5, 0, 0xff8a30, 4, 7, false, 1);
      break;
    }
    case 'rack': {
      for (const sx of [-1, 1]) k.box((sx * (w - 0.1)) / 2, 0, 0, 0.08, 1.7 * s, 0.1, Surf.Timber, dark);
      k.box(0, 1.5 * s, 0, w, 0.08, 0.12, Surf.Timber, dark);
      k.box(0, 0.4 * s, 0.05, w, 0.06, 0.2, Surf.Timber, dark);
      const n = Math.floor(w / 0.28);
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 0.2 + (i * (w - 0.4)) / Math.max(1, n - 1);
        k.pole(x, 0.05, 0.06, x + 0.02, 1.9 * s, -0.02, 0.02, 0.02, Surf.Timber, 0x6a5038);
        if (i % 2 === 0) k.cyl(x, 1.9 * s, -0.02, 0.04, 0, 0.2, Surf.Metal, 0x8a8a8a, { seg: 4 });
      }
      k.cyl(0, 0.7 * s, d / 2 - 0.02, 0.32 * s, 0.32 * s, 0.05, Surf.Planks, jitter(c.cloth, r, 0.2), { rx: Math.PI / 2, seg: 10 });
      k.col(0, 0, 0, w, 1.7 * s, d, true);
      break;
    }
    case 'lectern': {
      k.cyl(0, 0, 0, 0.2, 0.25, 0.08, Surf.Planks, dark, { seg: 8 });
      k.box(0, 0.08, 0, 0.12, 1.0 * s, 0.12, Surf.Timber, wood);
      k.boxC(0, 1.15 * s, 0, 0.55, 0.05, 0.42, Surf.Planks, wood, { rx: 0.4 });
      k.boxC(0, 1.2 * s, 0.02, 0.45, 0.05, 0.32, Surf.Cloth, 0xe8dcc0, { rx: 0.4 });
      k.col(0, 0, 0, 0.6, 1.2 * s, 0.5, true);
      k.seat(0, 0, 0.6, Math.PI, 'Read');
      break;
    }
    case 'haybale': {
      k.box(0, 0, 0, w, 0.65 * s, d, Surf.Straw, jitter(0xd8c070, r, 0.08));
      for (const u of [-w / 4, w / 4]) k.box(u, -0.01, 0, 0.03, 0.67 * s, d + 0.02, Surf.Rope, 0x8a6a3a);
      k.col(0, 0, 0, w, 0.65 * s, d, true);
      break;
    }
    case 'millstone': {
      k.cyl(0, 0, 0, w / 2, w / 2, 0.45, Surf.StoneBrick, c.stone, { seg: 14 });
      k.cyl(0, 0.45, 0, w / 2 - 0.15, w / 2 - 0.15, 0.32, Surf.Rubble, scaleHex(c.stone, 1.08), { seg: 14 });
      k.cyl(0, 0.77, 0, 0.1, 0.1, 2.2 * s, Surf.Timber, dark, { seg: 6 });
      k.beam(0, 0.95, 0, w / 2 + 0.5, 0.95, 0, 0.1, Surf.Timber, dark);
      k.col(0, 0, 0, w, 0.8, d, true);
      break;
    }
    case 'sacks': {
      for (let i = 0; i < 3; i++) k.sphere(-w / 3 + (i * w) / 3, 0.25 * s, r.range(-0.1, 0.1), 0.24 * s, 0.28 * s, 0.2 * s, Surf.Cloth, jitter(0xb09a70, r, 0.08), { seg: 8 });
      k.sphere(0, 0.62 * s, 0, 0.22 * s, 0.2 * s, 0.18 * s, Surf.Cloth, jitter(0xa89068, r, 0.08), { seg: 8 });
      k.col(0, 0, 0, w, 0.7 * s, d, true);
      break;
    }
    case 'trough': {
      k.box(0, 0, 0, w, 0.5 * s, d, Surf.Planks, wood);
      k.box(0, 0.38 * s, 0, w - 0.12, 0.1, d - 0.12, Surf.Window, 0x3a5a6a);
      k.col(0, 0, 0, w, 0.5 * s, d, true);
      break;
    }
    case 'rug': {
      k.box(0, 0.035, 0, w, 0.015, d, Surf.Cloth, jitter(c.cloth, r, 0.2));
      k.box(0, 0.05, 0, w * 0.75, 0.005, d * 0.65, Surf.Cloth, scaleHex(jitter(c.cloth, r, 0.3), 0.7));
      break;
    }
    case 'orb': {
      k.cyl(0, 0, 0, 0.35, 0.25, 0.2, Surf.Marble, c.stone, { seg: 8 });
      k.cyl(0, 0.2, 0, 0.12, 0.1, 0.8 * s, Surf.Marble, c.stone, { seg: 8 });
      k.cyl(0, 0.2 + 0.8 * s, 0, 0.18, 0.25, 0.12, Surf.Metal, 0xc0a040, { seg: 8 });
      const glow = c.st.accent || 0x80c0ff;
      k.sphere(0, 1.35 * s, 0, 0.22, 0.22, 0.22, Surf.Crystal, glow, { emit: glow, emitI: 3, seg: 10 });
      k.col(0, 0, 0, 0.6, 1.5 * s, 0.6, true);
      k.light(0, 1.4 * s, 0, glow, 3, 7, false, 0.15);
      break;
    }
  }
  k.pop();
  k.lod = prevLod;
  return pi;
}
