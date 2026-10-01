/**
 * Procedural heraldry built from primitives (no textures): field divisions
 * and an emblem in the settlement's tinctures. Used on banners, shields and
 * tavern/shop signs. Drawn in the current frame's XY plane facing +z (and
 * mirrored on the back so cloth reads from both sides).
 */
import type { Heraldry } from '../types';
import { Kit, Surf, scaleHex, type Lod } from './kit';

/** Panel of width w and height h, bottom-left at (−w/2, y0), cloth thickness t centred on z = 0. */
export function heraldicPanel(k: Kit, her: Heraldry, w: number, h: number, y0: number, t = 0.04, lod: Lod = 1) {
  const o = { lod };
  const f1 = her.field, f2 = her.field2, ch = her.charge;
  const yc = y0 + h / 2;
  const z = 0;
  // Field (with a swallow-tail notch at the bottom made of two small wedges).
  switch (her.division) {
    case 'party':
      k.box(-w / 4, y0, z, w / 2, h, t, Surf.Cloth, f1, o);
      k.box(w / 4, y0, z, w / 2, h, t, Surf.Cloth, f2, o);
      break;
    case 'fess':
      k.box(0, y0, z, w, h, t, Surf.Cloth, f1, o);
      k.box(0, y0 + h * 0.36, z, w, h * 0.28, t + 0.006, Surf.Cloth, f2, o);
      break;
    case 'pale':
      k.box(0, y0, z, w, h, t, Surf.Cloth, f1, o);
      k.box(0, y0, z, w * 0.34, h, t + 0.006, Surf.Cloth, f2, o);
      break;
    case 'quarterly':
      for (const [sx, sy, c] of [[-1, 1, f1], [1, 1, f2], [-1, -1, f2], [1, -1, f1]] as const) k.box((sx * w) / 4, yc + (sy < 0 ? -h / 2 : 0), z, w / 2, h / 2, t, Surf.Cloth, c, o);
      break;
    case 'chevron':
      k.box(0, y0, z, w, h, t, Surf.Cloth, f1, o);
      for (const sx of [-1, 1]) k.boxC((sx * w) / 4, yc - h * 0.05, z, w * 0.62, h * 0.12, t + 0.006, Surf.Cloth, f2, { ...o, rz: sx * -0.7 });
      break;
    case 'bend':
      k.box(0, y0, z, w, h, t, Surf.Cloth, f1, o);
      k.boxC(0, yc, z, Math.hypot(w, h) * 0.98, Math.min(w, h) * 0.22, t + 0.006, Surf.Cloth, f2, { ...o, rz: -Math.atan2(h, w) });
      break;
    case 'saltire':
      k.box(0, y0, z, w, h, t, Surf.Cloth, f1, o);
      for (const sgn of [-1, 1]) k.boxC(0, yc, z, Math.hypot(w, h) * 0.98, Math.min(w, h) * 0.16, t + 0.006, Surf.Cloth, f2, { ...o, rz: sgn * Math.atan2(h, w) });
      break;
    default:
      k.box(0, y0, z, w, h, t, Surf.Cloth, f1, o);
  }
  // Emblem on both faces.
  const er = Math.min(w, h) * 0.3;
  for (const side of [1, -1]) {
    k.push(0, yc, side * (t / 2 + 0.012), side > 0 ? 0 : Math.PI);
    emblem(k, her.emblem, er, ch, her.field, lod);
    k.pop();
  }
  // Fringe.
  k.box(0, y0 - 0.06, z, w, 0.06, t * 0.8, Surf.Rope, scaleHex(0xd0a020, 0.9), o);
}

/** Emblem centred at the frame origin in the XY plane, size ≈ radius r, facing +z. */
export function emblem(k: Kit, e: Heraldry['emblem'], r: number, col: number, bg: number, lod: Lod) {
  const th = 0.015;
  const disc = (x: number, y: number, rr: number, c: number, z = 0, sy = 1) => k.cyl(x, y, z - th / 2, rr, rr, th, Surf.Cloth, c, { rx: Math.PI / 2, seg: 12, lod, sz: sy });
  const bar = (x: number, y: number, w: number, h: number, rot: number, c: number, z = 0) => k.boxC(x, y, z, w, h, th, Surf.Cloth, c, { rz: rot, lod });
  switch (e) {
    case 'sun':
      disc(0, 0, r * 0.5, col);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        bar(Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75, r * 0.4, r * 0.12, a, col);
      }
      break;
    case 'moon':
      disc(0, 0, r * 0.7, col);
      disc(r * 0.3, r * 0.12, r * 0.6, bg, 0.006);
      break;
    case 'star':
      for (let i = 0; i < 4; i++) bar(0, 0, r * 1.7, r * 0.18, (i / 4) * Math.PI, col);
      disc(0, 0, r * 0.3, col);
      break;
    case 'tree':
      bar(0, -r * 0.45, r * 0.18, r * 0.9, 0, scaleHex(col, 0.75));
      disc(0, r * 0.25, r * 0.55, col);
      disc(-r * 0.4, 0, r * 0.38, col);
      disc(r * 0.4, 0, r * 0.38, col);
      break;
    case 'tower':
      bar(0, -r * 0.1, r * 0.8, r * 1.4, 0, col);
      for (const x of [-0.3, 0, 0.3]) bar(x * r, r * 0.68, r * 0.18, r * 0.25, 0, col);
      bar(0, -r * 0.55, r * 0.25, r * 0.5, 0, bg, 0.006);
      break;
    case 'hammer':
      bar(0, -r * 0.2, r * 0.16, r * 1.4, 0, scaleHex(col, 0.8));
      bar(0, r * 0.5, r * 0.9, r * 0.38, 0, col);
      break;
    case 'skull':
      disc(0, r * 0.15, r * 0.55, col);
      bar(0, -r * 0.45, r * 0.6, r * 0.35, 0, col);
      disc(-r * 0.22, r * 0.12, r * 0.14, bg, 0.006);
      disc(r * 0.22, r * 0.12, r * 0.14, bg, 0.006);
      break;
    case 'flame':
      for (const [x, s, rot] of [[0, 1, 0], [-0.3, 0.7, 0.3], [0.3, 0.7, -0.3]] as const) {
        k.push(x * r, -r * 0.5, 0, 0);
        k.frustum(0, 0, -th / 2, r * 0.5 * s, th, 0, th, r * 1.4 * s, Surf.Cloth, col, { lod, rz: rot });
        k.pop();
      }
      break;
    case 'leaf':
      // Flattened ellipsoid: with only a roll (rz) the rotation stays in the panel plane.
      k.sphere(0, 0, 0, r * 0.3, r * 0.62, th, Surf.Cloth, col, { rz: 0.5, seg: 12, lod });
      bar(0, 0, r * 0.06, r * 1.4, 0.5, scaleHex(col, 0.7), 0.004);
      break;
    case 'crown':
      bar(0, -r * 0.3, r * 1.3, r * 0.35, 0, col);
      for (const x of [-0.5, 0, 0.5]) {
        k.frustum(x * r, -r * 0.15, -th / 2, r * 0.38, th, 0, th, r * 0.7, Surf.Cloth, col, { lod });
        disc(x * r, r * 0.6, r * 0.09, col);
      }
      break;
    case 'eye':
      k.cyl(0, 0, -th / 2, r * 0.8, r * 0.8, th, Surf.Cloth, col, { rx: Math.PI / 2, seg: 14, lod, sz: 0.5 });
      disc(0, 0, r * 0.3, bg, 0.006);
      disc(0, 0, r * 0.13, col, 0.01);
      break;
    case 'mountain':
      k.frustum(-r * 0.3, -r * 0.6, -th / 2, r * 1.3, th, 0, th, r * 1.2, Surf.Cloth, col, { lod });
      k.frustum(r * 0.45, -r * 0.6, -th / 2 + 0.004, r * 0.9, th, 0, th, r * 0.85, Surf.Cloth, scaleHex(col, 0.85), { lod });
      break;
    case 'boar':
      k.cyl(0, 0, -th / 2, r * 0.6, r * 0.6, th, Surf.Cloth, col, { rx: Math.PI / 2, seg: 12, lod, sz: 0.6 });
      disc(-r * 0.62, r * 0.05, r * 0.3, col);
      for (const x of [-0.3, 0.3]) bar(x * r, -r * 0.45, r * 0.12, r * 0.4, 0, col);
      bar(-r * 0.8, -r * 0.05, r * 0.3, r * 0.06, 0.6, bg, 0.006);
      break;
    case 'wave':
      for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) bar(-r * 0.75 + j * r * 0.5, -r * 0.5 + i * r * 0.5, r * 0.45, r * 0.1, j % 2 ? -0.5 : 0.5, col);
      break;
    case 'cross':
      bar(0, 0, r * 0.3, r * 1.6, 0, col);
      bar(0, r * 0.2, r * 1.2, r * 0.3, 0, col);
      break;
    case 'crystal':
      bar(0, 0, r * 0.8, r * 0.8, Math.PI / 4, col);
      bar(0, 0, r * 0.4, r * 0.4, Math.PI / 4, bg, 0.006);
      break;
  }
}
