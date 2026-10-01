/**
 * Round (polygonal) building shell: towers, mills, huts and tents. The wall
 * ring is made of straight segments (door hole in the front one, windows in
 * a few), grouped into four destructible pieces per storey. Supports spiral
 * stairs, tapering (battered) towers, conical / dome / flat roofs and a
 * crenellated walkable top for watchtowers.
 */
import { Kit, Surf, scaleHex } from './kit';
import { wallBoxes, windowAt, type DoorLook, type RoofLook, type ShellOut, type WallLook, type WindowLook } from './shell';

const SLAB_T = 0.24;

export interface RoundSpec {
  r: number;
  floors: number;
  storey: number;
  wallT: number;
  scale: number;
  ground: [number, number, number, number];
  plinth: number;
  baseSurf: Surf;
  baseCol: number;
  walls: WallLook[];
  floorSurf: Surf;
  floorCol: number;
  door: DoorLook | null;
  win: WindowLook;
  roof: RoofLook;
  /** Polygon sides of the wall ring. */
  seg: number;
  /** Top radius factor (< 1 tapers the tower). */
  taper: number;
  /** Spiral stair along the back half of the wall. */
  stairs: boolean;
  /** Walkable crenellated top instead of a roof (watchtowers). */
  platform: boolean;
}

export function buildRound(k: Kit, s: RoundSpec): ShellOut {
  const r = s.r, t = s.wallT, storey = s.storey;
  const gmin = Math.min(...s.ground);
  const N = s.seg;
  const found = k.piece('foundation', 'stone');
  k.cyl(0, gmin - 0.6, 0, r + 0.12, r + 0.12, -gmin + 0.6, s.baseSurf, s.baseCol, { seg: N });
  k.col(0, gmin - 0.6, 0, r * 1.6, -gmin + 0.6, r * 1.6, true);
  k.cyl(0, 0, 0, r - t + 0.02, r - t + 0.02, 0.03, s.floorSurf, s.floorCol, { seg: N, lod: 2 });
  const frontG = Math.min(s.ground[2], s.ground[3]);
  if (s.door && frontG < -0.18) {
    const n = Math.min(12, Math.ceil(-frontG / 0.2));
    const sh = -frontG / n;
    for (let i = 0; i < n; i++) {
      const depth = (n - i) * 0.3;
      k.solid(0, frontG + i * sh - 0.3, r + depth / 2, s.door.w + 0.7, sh + 0.3, depth, s.baseSurf, s.baseCol);
    }
  }
  const walls: number[][] = [];
  const slabs: number[] = [];
  const segLen = 2 * r * Math.sin(Math.PI / N) + 0.04;
  const radiusAt = (f: number) => {
    const k0 = 1 - (1 - s.taper) * (f / Math.max(1, s.floors));
    const k1 = 1 - (1 - s.taper) * ((f + 1) / Math.max(1, s.floors));
    return (r * (k0 + k1)) / 2;
  };
  for (let f = 0; f < s.floors; f++) {
    const look = s.walls[Math.min(f, s.walls.length - 1)];
    const rr = radiusAt(f);
    if (f > 0) {
      const slab = k.piece('floor', 'wood', walls[f - 1], 2);
      k.cyl(0, f * storey - SLAB_T, 0, rr - t + 0.05, rr - t + 0.05, SLAB_T, s.floorSurf, s.floorCol, { seg: N });
      slabs.push(slab);
    }
    const row: number[] = [];
    const mat = look.surf === Surf.Planks || look.surf === Surf.Timber || look.surf === Surf.Bark ? 'wood' : look.surf === Surf.Hide ? 'cloth' : look.surf === Surf.Crystal ? 'crystal' : 'stone';
    for (let q = 0; q < 4; q++) row.push(k.piece('wall', mat, f === 0 ? [found] : [walls[f - 1][q], slabs[f - 1]], 1));
    const winEvery = Math.max(2, Math.round(N / (s.floors > 2 ? 4 : 5)));
    for (let i = 0; i < N; i++) {
      // Segment i centred at angle a; i = 0 faces the front (+z).
      const a = (i / N) * Math.PI * 2;
      const q = Math.floor((((i + N / 8) % N) / N) * 4) % 4;
      k.use(row[q]);
      k.push(Math.sin(a) * (rr - t / 2), f * storey, Math.cos(a) * (rr - t / 2), a);
      const L = segLen * (rr / r);
      const holes = f === 0 && i === 0 && s.door ? [{ x: 0, w: Math.min(s.door.w, L - 0.3), h: s.door.h }] : [];
      wallBoxes(k, L, storey, t, holes, look.surf, look.col);
      const stairSide = s.stairs && a > Math.PI * 0.5 && a < Math.PI * 1.45;
      const wantWin = !holes.length && i % winEvery === f % 2 && !stairSide;
      if (wantWin && L > s.win.w + 0.4) windowAt(k, 0, t, s.win);
      if (holes.length && s.door) {
        const o = holes[0];
        k.box(-o.w / 2 - 0.07, 0, t / 2 + 0.01, 0.14, o.h, 0.1, s.door.frameSurf, s.door.frameCol, { lod: 1 });
        k.box(o.w / 2 + 0.07, 0, t / 2 + 0.01, 0.14, o.h, 0.1, s.door.frameSurf, s.door.frameCol, { lod: 1 });
        k.box(0, o.h, t / 2 + 0.01, o.w + 0.4, 0.18, 0.12, s.door.frameSurf, s.door.frameCol, { lod: 1 });
      }
      if (look.frame && f > 0) k.box(0, 0, t / 2 + 0.015, L, look.frame.w, 0.06, look.frame.surf, look.frame.col, { lod: 1 });
      if (f === 0 && s.plinth > 0.05) k.box(0, 0, t / 2 + 0.02, L, Math.min(0.5, s.plinth + 0.2), 0.06, s.baseSurf, s.baseCol, { lod: 1 });
      k.pop();
    }
    walls.push(row);
  }
  let doorPiece = -1;
  if (s.door) {
    const dl = s.door;
    const lw = Math.min(dl.w, segLen - 0.3) - 0.04;
    doorPiece = k.piece('door', 'wood', [walls[0][0]], 1);
    k.push(0, 0, radiusAt(0) - t / 2, 0);
    k.box(0, 0.01, 0, lw, dl.h - 0.02, 0.09, dl.surf, dl.col, { lod: 1 });
    if (dl.bands) for (const by of [0.3, dl.h - 0.5]) k.box(0, by, 0.05, lw - 0.06, 0.08, 0.02, Surf.Metal, 0x2a2826, { lod: 1 });
    k.cyl(lw / 2 - 0.15, dl.h * 0.48, 0.05, 0.035, 0.035, 0.06, Surf.Metal, 0xb08a40, { rx: Math.PI / 2, seg: 6, lod: 1 });
    k.col(0, 0, 0, lw, dl.h, 0.12, true);
    k.door(-lw / 2, 0, lw, dl.h, 1.65);
    k.pop();
  }
  const wallTop = s.floors * storey;
  if (s.stairs && s.floors > 1) {
    k.piece('stairs', 'wood', [found], 1);
    const per = Math.ceil(storey / 0.22);
    const rise = storey / per;
    for (let f = 0; f < s.floors - 1; f++) {
      const ri = radiusAt(f) - t - 0.55;
      for (let i = 0; i < per; i++) {
        const a = Math.PI * 0.55 + (i / per) * Math.PI * 0.9;
        const y = f * storey + i * rise;
        k.boxC(Math.sin(a) * ri, y + rise / 2, Math.cos(a) * ri, 1.0, rise, 0.42, Surf.Planks, scaleHex(s.floorCol, 0.95), { ry: a + Math.PI / 2, lod: 2 });
        k.col(Math.sin(a) * ri, y, Math.cos(a) * ri, 0.9, rise, 0.4, true, a + Math.PI / 2);
      }
    }
  }
  const topWalls = walls[walls.length - 1];
  const rt = radiusAt(s.floors - 1);
  const rs = s.roof.surf;
  const roofMat = rs === Surf.Thatch || rs === Surf.Turf || rs === Surf.Mushroom || rs === Surf.Leaf ? 'plant' : rs === Surf.Shingle ? 'wood' : rs === Surf.Hide ? 'cloth' : rs === Surf.Crystal ? 'crystal' : 'stone';
  const roofPiece = k.piece('roof', roofMat, topWalls, 2);
  let ridge = wallTop;
  const o = s.roof.overhang;
  const topLook = s.walls[s.walls.length - 1];
  if (s.platform) {
    k.cyl(0, wallTop - 0.2, 0, rt + 0.35, rt + 0.35, 0.3, s.baseSurf, s.baseCol, { seg: N });
    k.col(0, wallTop - 0.2, 0, rt * 1.5, 0.3, rt * 1.5, true);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      k.push(Math.sin(a) * (rt + 0.18), wallTop + 0.1, Math.cos(a) * (rt + 0.18), a);
      k.solid(0, 0, 0, 2 * (rt + 0.35) * Math.sin(Math.PI / N) + 0.06, 1.0, 0.34, topLook.surf, topLook.col);
      if (s.roof.crenel && i % 2 === 0) k.box(0, 1.0, 0, 0.6, 0.55, 0.34, topLook.surf, topLook.col, { lod: 1 });
      k.pop();
    }
    ridge = wallTop + 1.6;
    if (s.roof.kind === 'conical') {
      // Pole-mounted canopy over the platform.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        k.box(Math.sin(a) * (rt - 0.15), wallTop + 0.1, Math.cos(a) * (rt - 0.15), 0.14, 2.3, 0.14, Surf.Timber, s.roof.trimCol);
      }
      k.cyl(0, wallTop + 2.4, 0, rt + o + 0.3, 0, (rt + o) * s.roof.pitch, rs, s.roof.col, { seg: N });
      ridge = wallTop + 2.4 + (rt + o) * s.roof.pitch;
    }
  } else if (s.roof.kind === 'dome') {
    k.cyl(0, wallTop - 0.05, 0, rt + 0.15, rt + 0.15, 0.25, s.roof.trimSurf, s.roof.trimCol, { seg: N });
    const H = Math.max(1.2, s.roof.pitch * rt);
    k.sphere(0, wallTop + 0.2, 0, rt + o, H, rt + o, rs, s.roof.col, { lat0: 0, lat1: Math.PI / 2, seg: Math.max(12, N) });
    if (s.roof.finial) k.cyl(0, wallTop + 0.1 + H, 0, 0.09, 0, 1.0, s.roof.trimSurf, s.roof.trimCol, { seg: 6, lod: 1 });
    ridge = wallTop + 0.2 + H;
  } else if (s.roof.kind === 'flat') {
    k.cyl(0, wallTop, 0, rt + 0.1, rt + 0.1, 0.3, rs, s.roof.col, { seg: N });
    ridge = wallTop + 0.3;
  } else {
    const H = s.roof.pitch * (rt + o) * 1.4;
    k.cyl(0, wallTop - 0.1, 0, rt + o, 0, H, rs, s.roof.col, { seg: Math.max(8, N) });
    k.cyl(0, wallTop - 0.25, 0, rt + o + 0.05, rt + o, 0.18, s.roof.trimSurf, s.roof.trimCol, { seg: Math.max(8, N), lod: 1 });
    if (s.roof.finial) k.cyl(0, wallTop + H - 0.35, 0, 0.09, 0, 1.4, s.roof.trimSurf, s.roof.trimCol, { seg: 6, lod: 1 });
    ridge = wallTop - 0.1 + H;
  }
  // Interior ceiling.
  if (!s.platform) k.cyl(0, wallTop - 0.08, 0, rt - t + 0.02, rt - t + 0.02, 0.06, Surf.Planks, 0x7a6048, { seg: N, lod: 2 });
  return { found, walls, slabs, roof: roofPiece, gables: [], door: doorPiece, wallTop, ridge, topD: 2 * r };
}
