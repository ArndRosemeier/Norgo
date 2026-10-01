/**
 * Halfling burrows (style 'burrow'): homes dug into grassy turf mounds. A
 * stone-and-plaster facade stands at the foot of the mound with a round,
 * brightly painted door (brass knob in the middle) inside a round stone
 * frame, round windows with flower boxes, a lantern and a little bench; the
 * room behind is a cosy round chamber with plastered walls and an exposed-
 * beam ceiling, its chimney poking out of the grass. Bigger buildings
 * (taverns, halls, workshops) are elongated mounds with a long facade and a
 * second hump; mills are cheerful windmills.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell, wallBoxes, windowAt, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, doorLook, type BuildCtx, type StyleBuilder } from './common';
import { windmillSails } from './styleTimber';

const TURF = [0x6aa040, 0x5e9438, 0x78aa48, 0x64983c];
const FLOWERS = [0xd04050, 0xe0c040, 0xc060c0, 0xf08040, 0xf0f0e0, 0x6080e0];

function flowers(k: Kit, x: number, y: number, z: number, w: number, rng: Kit['rng']) {
  k.box(x, y, z, w, 0.2, 0.26, Surf.Planks, 0x6a4a30, { lod: 1 });
  const n = Math.max(3, Math.round(w / 0.16));
  for (let i = 0; i < n; i++) k.sphere(x - w / 2 + ((i + 0.5) * w) / n, y + 0.24, z + rng.range(-0.05, 0.05), 0.09, 0.08, 0.08, Surf.Leaf, rng.pick(FLOWERS), { seg: 5, lod: 1 });
}

/** Round door piece in a facade frame (frame: facade centre line at z, +z outward). */
function roundDoor(k: Kit, c: BuildCtx, sup: number, x: number, z: number, r: number) {
  const door = k.piece('door', 'wood', [sup], 1);
  k.push(x, 0, z, 0);
  k.cyl(0, r, -0.045, r - 0.02, r - 0.02, 0.09, Surf.Planks, c.doorCol, { rx: Math.PI / 2, seg: 16, lod: 1 });
  // Plank seams and the brass knob in the middle.
  for (const u of [-0.5, 0, 0.5]) k.box(u * r, 0.08, 0.05, 0.02, 2 * r - 0.16, 0.01, Surf.Planks, scaleHex(c.doorCol, 0.75), { lod: 1 });
  k.sphere(0, r, 0.09, 0.07, 0.07, 0.05, Surf.Metal, 0xd8b040, { seg: 8, lod: 1 });
  k.cyl(0, r, 0.04, 0.1, 0.1, 0.02, Surf.Metal, 0xc0a040, { rx: Math.PI / 2, seg: 8, lod: 1 });
  k.col(0, 0, 0, 2 * r, 2 * r, 0.12, true);
  k.door(-r, 0, 2 * r, 2 * r, 1.7);
  k.pop();
  return door;
}

/** Ring of stones around a round opening (fills the square hole corners). Frame: wall centre at z = 0. */
function roundFrame(k: Kit, x: number, cy: number, r: number, t: number, col: number) {
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    if (cy + Math.sin(a) * (r + 0.15) < 0.02) continue;
    k.boxC(x + Math.cos(a) * (r + 0.15), cy + Math.sin(a) * (r + 0.15), 0, 0.36, (2 * Math.PI * (r + 0.15)) / n + 0.04, t + 0.08, Surf.Rubble, jitter(col, k.rng, 0.06), { rz: a });
  }
}

/** Facade with a round door hole, round windows and dressing. Frame: facade centre line, +z outward. Returns hole spec. */
function facade(k: Kit, c: BuildCtx, W: number, H: number, t: number, doorX: number, doorR: number) {
  const plaster = jitter(c.rng.pick([0xf0e2c0, 0xe8d8b4, 0xf2e8d0]), c.rng, 0.03);
  const stone = jitter(0xa89c88, c.rng, 0.05);
  wallBoxes(k, W, H, t, [{ x: doorX, w: 2 * doorR + 0.02, h: 2 * doorR + 0.02 }], Surf.Plaster, plaster);
  roundFrame(k, doorX, doorR, doorR, t, stone);
  // Stone footing & coping.
  k.box(0, 0, t / 2 + 0.03, W + 0.1, 0.45, 0.08, Surf.Rubble, stone, { lod: 1 });
  k.box(0, H - 0.05, 0, W + 0.3, 0.2, t + 0.25, Surf.Rubble, stone, { lod: 1 });
  // Round windows either side of the door.
  const win = windowLook(c, { shape: 'round', w: 0.75 * c.s, sill: 0.95 * c.s, glow: 0xffc070, flowerbox: false });
  const xs = [doorX - doorR - 1.0 * c.s, doorX + doorR + 1.0 * c.s].filter((x) => Math.abs(x) < W / 2 - 0.5);
  for (const x of xs) {
    windowAt(k, x, t, win);
    flowers(k, x, win.sill - 0.25, t / 2 + 0.15, 0.8 * c.s, c.rng);
  }
  return win;
}

/** Turf mound (half ellipsoid) with a grassy collar where it meets the ground. */
function mound(k: Kit, x: number, z: number, rx: number, h: number, rz: number, rng: Kit['rng']) {
  const col = jitter(rng.pick(TURF), rng, 0.05);
  k.sphere(x, -0.25, z, rx, h + 0.25, rz, Surf.Turf, col, { lat0: 0, lat1: Math.PI / 2, seg: 18 });
  // A few stones and tufts on the slope.
  for (let i = 0; i < 4; i++) {
    const a = rng.range(0, Math.PI * 2), f = rng.range(0.55, 0.85);
    const px = x + Math.sin(a) * rx * f, pz = z + Math.cos(a) * rz * f;
    const py = -0.25 + (h + 0.25) * Math.sqrt(Math.max(0, 1 - f * f));
    if (rng.chance(0.5)) k.sphere(px, py - 0.05, pz, 0.3, 0.18, 0.25, Surf.Rubble, jitter(0x9a9282, rng, 0.08), { seg: 6, lod: 1 });
    else k.sphere(px, py, pz, 0.35, 0.22, 0.35, Surf.Leaf, jitter(0x4a8a30, rng, 0.1), { seg: 6, lod: 1 });
  }
}

/** Round burrow home: chamber of radius c.w/2 under a turf dome, facade in front. */
function roundBurrow(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const s = c.s;
  const rw = c.w / 2; // outer wall radius = footprint
  const t = c.t;
  const storey = Math.max(c.storey, 2.0 * s);
  const R = rw + 0.65;
  const domeH = (storey + 0.45) / Math.sqrt(1 - (rw / R) ** 2);
  const gmin = Math.min(...c.ground);
  const rng = c.rng;
  const found = k.piece('foundation', 'stone');
  k.cyl(0, gmin - 0.5, 0, R, R, -gmin + 0.48, Surf.Rubble, jitter(0x8a8070, rng, 0.05), { seg: 16 });
  k.col(0, gmin - 0.5, 0, rw * 1.5, -gmin + 0.48, rw * 1.5, true);
  k.cyl(0, 0, 0, rw - t + 0.02, rw - t + 0.02, 0.03, Surf.Planks, jitter(0x9a7450, rng, 0.05), { seg: 16, lod: 2 });

  // Chamber walls (round, 4 pieces), opening toward the vestibule.
  const N = 14;
  const walls: number[] = [];
  for (let q = 0; q < 4; q++) walls.push(k.piece('wall', 'stone', [found], 1));
  const doorR = 0.78 * s;
  const plaster = jitter(0xf0e2c0, rng, 0.03);
  const segLen = 2 * rw * Math.sin(Math.PI / N) + 0.04;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const q = Math.floor((((i + N / 8) % N) / N) * 4) % 4;
    k.use(walls[q]);
    k.push(Math.sin(a) * (rw - t / 2), 0, Math.cos(a) * (rw - t / 2), a);
    wallBoxes(k, segLen, storey, t, i === 0 ? [{ x: 0, w: Math.min(segLen - 0.2, 2 * doorR + 0.3), h: 2 * doorR + 0.2 }] : [], Surf.Plaster, plaster);
    // Wood panelling inside (lod 2).
    k.box(0, 0, -t / 2 - 0.02, segLen, 0.9 * s, 0.03, Surf.Planks, jitter(0x8a6a48, rng, 0.05), { lod: 2 });
    k.pop();
  }
  // Ceiling with exposed beams.
  const roofP = k.piece('roof', 'plant', walls, 2);
  k.cyl(0, storey, 0, rw, rw, 0.12, Surf.Planks, jitter(0x7a5a3a, rng, 0.05), { seg: N, lod: 2 });
  for (let i = -1; i <= 1; i++) k.box(i * rw * 0.5, storey - 0.18, 0, 0.18, 0.18, 2 * rw * Math.sqrt(1 - (i * 0.5) ** 2) - 0.2, Surf.Timber, 0x5a4030, { lod: 2 });
  // The mound itself (part of the roof piece).
  mound(k, 0, 0, R, domeH, R, rng);
  k.col(0, storey, 0, rw * 1.4, domeH - storey - 0.3, rw * 1.4, true);

  // Vestibule from the chamber to the facade.
  const fz = R + 0.15;
  const vest = k.piece('wall', 'stone', [found], 1);
  const vw = 2 * doorR + 0.5;
  const vl = fz - rw + t;
  for (const sx of [-1, 1]) k.solid(sx * (vw / 2 + 0.12), 0, rw - t + vl / 2, 0.24, storey * 0.95, vl, Surf.Plaster, plaster);
  k.box(0, 2 * doorR + 0.35, rw - t + vl / 2, vw + 0.48, 0.2, vl, Surf.Planks, 0x7a5a3a);
  // Facade (stone & plaster wall at the foot of the mound).
  const FW = Math.min(2 * R - 0.4, Math.max(4.2 * s, 2 * doorR + 3.4 * s));
  const FH = Math.max(2 * doorR + 0.75, storey * 0.95);
  const front = k.piece('wall', 'stone', [found], 1);
  k.push(0, 0, fz, 0);
  facade(k, c, FW, FH, 0.32, 0, doorR);
  // Bench & lantern by the door.
  k.box(doorR + 0.9 * s, 0, 0.55, 0.9 * s, 0.4 * s, 0.35, Surf.Planks, 0x7a5a3a, { lod: 1 });
  k.box(-doorR - 0.25, 2 * doorR + 0.05, 0.3, 0.06, 0.06, 0.3, Surf.Metal, 0x2e2c2a, { lod: 1 });
  k.cyl(-doorR - 0.25, 2 * doorR - 0.35, 0.42, 0.09, 0.09, 0.3, Surf.Window, 0xfff0c8, { seg: 6, emit: 0xffc070, emitI: 3, night: true, lod: 1 });
  k.light(-doorR - 0.25, 2 * doorR - 0.2, 0.6, 0xffb060, 3, 8, true, 0.1);
  k.pop();
  // Door leaf sits near the outer face so its colour reads from the lane.
  const door = roundDoor(k, c, front, 0, fz + 0.1, doorR);
  void vest;

  // Chimney through the grass at the back.
  k.piece('chimney', 'stone', [found], 1);
  const cz = -rw * 0.45, cx = rng.range(-0.3, 0.3) * rw;
  const surfH = -0.25 + (domeH + 0.25) * Math.sqrt(Math.max(0, 1 - (cx * cx + cz * cz) / (R * R)));
  k.box(cx, storey, cz, 0.6, surfH - storey + 0.9, 0.6, Surf.Rubble, jitter(0x9a8a7a, rng, 0.06));
  k.box(cx, surfH + 0.9, cz, 0.75, 0.12, 0.75, Surf.Rubble, 0x8a7a6a, { lod: 1 });
  k.cyl(cx, surfH + 1.02, cz, 0.12, 0.12, 0.3, Surf.ClayTile, 0xa05a3a, { seg: 6, lod: 1 });
  k.smoke(cx, surfH + 1.4, cz);
  // Skylight round window on the mound's side.
  k.use(roofP);
  const sa = rng.range(0.9, 1.6) * (rng.chance(0.5) ? 1 : -1);
  const sf = 0.72;
  const sx = Math.sin(sa) * R * sf, sz = Math.cos(sa) * R * sf;
  const sy = -0.25 + (domeH + 0.25) * Math.sqrt(1 - sf * sf);
  k.cyl(sx, sy - 0.2, sz, 0.35, 0.35, 0.3, Surf.Rubble, 0x9a9282, { seg: 10, lod: 1 });
  k.cyl(sx, sy + 0.08, sz, 0.26, 0.26, 0.04, Surf.Window, 0x5a6878, { seg: 10, emit: 0xffc070, emitI: 1.5, night: true, lod: 1 });

  const out: ShellOut = { found, walls: [walls], slabs: [], roof: roofP, gables: [], door, wallTop: storey, ridge: domeH, topD: 2 * R };
  furnishAll(k, c, out);
  return { hx: rw - t * 0.5, hz: rw - t * 0.5, h: storey, round: true };
}

/** Elongated burrow (tavern, hall, workshop...): rectangular rooms under a long mound. */
function longBurrow(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const s = c.s;
  const rng = c.rng;
  const spec = shellSpec(c, {
    walls: [{ surf: Surf.Plaster, col: jitter(0xf0e2c0, rng, 0.03) }],
    floors: c.floors,
    jetty: 0,
    porch: null,
    balcony: false,
    plinth: 0.2,
    door: doorLook(c, { arch: true, bands: false, frameSurf: Surf.Rubble, frameCol: 0xa49884, w: Math.max(1.1, 1.2 * s), h: 2.1 * s }),
    win: windowLook(c, { shape: 'round', w: 0.8 * s, glow: 0xffc070, flowerbox: false }),
    roof: roofLook(c, 'none'),
    chimneyX: null,
  });
  const out = buildShell(k, spec);
  const wallTop = out.wallTop;
  // Long mound covering sides & back; its front edge meets the facade at ground.
  k.use(out.roof);
  const rx = c.w / 2 + 0.9, rz = c.d / 2 + 0.7;
  const oz = -0.7;
  // Height so the side walls stay covered at mid-depth.
  const need = wallTop + 0.6;
  const h = need / Math.sqrt(Math.max(0.05, 1 - (c.w / 2 / rx) ** 2));
  mound(k, 0, oz, rx, h, rz, rng);
  k.col(0, wallTop, oz, c.w * 0.9, h - wallTop - 0.3, c.d * 0.8, true);
  // Second hump for the big ones.
  if (c.b.role === 'tavern' || c.b.role === 'hall' || c.b.role === 'temple' || c.b.role === 'market') mound(k, c.w * 0.35, oz - c.d * 0.25, rx * 0.6, h * 1.12, rz * 0.6, rng);
  // Facade dressing: stone coping, flower boxes, a lantern.
  k.use(out.walls[0][0]);
  k.box(0, wallTop - 0.1, c.d / 2 - c.t / 2, c.w + 0.4, 0.25, c.t + 0.3, Surf.Rubble, 0xa49884, { lod: 1 });
  for (const sx of [-1, 1]) flowers(k, sx * (c.w / 2 - 1.0), 0.05, c.d / 2 + 0.25, 1.2 * s, rng);
  k.light(spec.door!.x + spec.door!.w / 2 + 0.4, spec.door!.h, c.d / 2 + 0.4, 0xffb060, 3.5, 9, true, 0.1);
  k.cyl(spec.door!.x + spec.door!.w / 2 + 0.4, spec.door!.h - 0.25, c.d / 2 + 0.35, 0.1, 0.1, 0.3, Surf.Window, 0xfff0c8, { seg: 6, emit: 0xffc070, emitI: 3, night: true, lod: 1 });
  // Chimney poking out of the grass over the hearth.
  if (c.hearthX !== null) {
    k.piece('chimney', 'stone', [out.found], 1);
    const cx = c.hearthX, cz = -c.d / 2 + c.t / 2;
    const f = Math.min(0.98, (cx / rx) ** 2 + ((cz - oz) / rz) ** 2);
    const surfH = -0.25 + (h + 0.25) * Math.sqrt(1 - f);
    k.solid(cx, 0, cz, 0.9, Math.max(wallTop, surfH) + 0.9, 0.8, Surf.Rubble, jitter(0x9a8a7a, rng, 0.06));
    k.cyl(cx, Math.max(wallTop, surfH) + 0.9, cz, 0.13, 0.13, 0.35, Surf.ClayTile, 0xa05a3a, { seg: 6, lod: 1 });
    k.smoke(cx, Math.max(wallTop, surfH) + 1.35, cz);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

export const buildBurrow: StyleBuilder = (k: Kit, c: BuildCtx) => {
  const role = c.b.role;
  if (role === 'mill' || role === 'mage_tower' || (role === 'watchtower' && c.b.round)) {
    const spec = roundSpec(c, {
      walls: [{ surf: Surf.Plaster, col: jitter(0xf2e8d0, c.rng, 0.03) }],
      roof: roofLook(c, 'conical', { surf: Surf.Thatch, col: jitter(0xc8a868, c.rng, 0.06), pitch: role === 'mage_tower' ? 1.4 : 0.95, finial: true }),
      taper: role === 'mill' ? 0.82 : 0.92,
      win: windowLook(c, { shape: 'round', glow: 0xffc070 }),
      door: doorLook(c, { x: 0, arch: true, frameSurf: Surf.Rubble, frameCol: 0xa49884 }),
    });
    const out = buildRound(k, spec);
    if (role === 'mill') windmillSails(k, c, out, spec.r * spec.taper);
    k.use(out.walls[0][0]);
    flowers(k, 0.9 * c.s + 0.6, 0.05, spec.r + 0.25, 0.9 * c.s, c.rng);
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }
  if (c.b.round) return roundBurrow(k, c);
  return longBurrow(k, c);
};

/** Far LOD: grassy dome (or long mound) with a glowing round window. */
export const silhouetteBurrow: ((k: Kit, c: BuildCtx) => void) | undefined = (k: Kit, c: BuildCtx) => {
  const b = c.b;
  const st = Math.max(c.storey, 2.0 * c.s);
  if (b.role === 'mill' || b.role === 'mage_tower') {
    const r = b.size[0] / 2;
    const H = (b.floors ?? 1) * c.storey;
    k.cyl(0, 0, 0, r, r * 0.85, H, Surf.Plaster, 0xf0e2c0, { seg: 8 });
    k.cyl(0, H, 0, r + 0.4, 0, r * 1.3, Surf.Thatch, 0xc8a868, { seg: 8 });
    return;
  }
  if (b.round) {
    const R = b.size[0] / 2 + 0.65;
    k.sphere(0, -0.25, 0, R, st + 1.0, R, Surf.Turf, 0x6aa040, { lat0: 0, lat1: Math.PI / 2, seg: 8 });
    k.box(0, 0, R, 2.6 * c.s, st * 0.95, 0.3, Surf.Plaster, 0xf0e2c0);
    if (c.rng.chance(0.75)) k.box(1.0 * c.s, st * 0.4, R + 0.17, 0.6, 0.6, 0.05, Surf.Window, 0x30384a, { emit: 0xffc070, emitI: 2.2, night: true });
    return;
  }
  const rx = b.size[0] / 2 + 0.9, rz = b.size[1] / 2 + 0.7;
  k.sphere(0, -0.25, -0.7, rx, st + 1.2, rz, Surf.Turf, 0x6aa040, { lat0: 0, lat1: Math.PI / 2, seg: 8 });
  k.box(0, 0, b.size[1] / 2 - 0.2, b.size[0], st, 0.4, Surf.Plaster, 0xf0e2c0);
  if (c.rng.chance(0.8)) k.box(0, st * 0.45, b.size[1] / 2 + 0.03, 0.8, 0.6, 0.05, Surf.Window, 0x30384a, { emit: 0xffc070, emitI: 2.2, night: true });
};
