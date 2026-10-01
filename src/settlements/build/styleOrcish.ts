/**
 * Orcish architecture (style 'orcish'): round huts of low log walls under
 * steep conical hide roofs stretched over pole frames (poles bristle out of
 * the apex, lashed with rope), war tents, longhouses and mead halls with log
 * walls, crossed gable rafters and huge hide/thatch roofs, bone & tusk
 * trophies, skulls over doors, red/black war paint, heraldic war banners and
 * sharpened stakes around fighting buildings.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, doorLook, type BuildCtx, type StyleBuilder } from './common';
import { heraldicPanel } from './heraldry';
import { windmillSails } from './styleTimber';

const BONE = 0xe6dcc4;
const PAINT_RED = 0x9a2a22;
const PAINT_BLACK = 0x1e1a18;

/** Skull with horns/tusks mounted at (x, y, z) facing +z of the current frame. */
function skull(k: Kit, x: number, y: number, z: number, s: number, horns: boolean) {
  k.sphere(x, y, z, 0.2 * s, 0.2 * s, 0.24 * s, Surf.Bone, BONE, { seg: 8, lod: 1 });
  k.box(x, y - 0.24 * s, z + 0.06 * s, 0.24 * s, 0.1 * s, 0.22 * s, Surf.Bone, scaleHex(BONE, 0.95), { lod: 1 });
  for (const sx of [-1, 1]) {
    k.sphere(x + sx * 0.08 * s, y + 0.02 * s, z + 0.2 * s, 0.05 * s, 0.05 * s, 0.03, Surf.Basalt, 0x101010, { seg: 5, lod: 1 });
    if (horns) k.pole(x + sx * 0.16 * s, y + 0.08 * s, z, x + sx * 0.6 * s, y + 0.45 * s, z - 0.15 * s, 0.07 * s, 0.01, Surf.Bone, 0xd8ccb0, { lod: 1, seg: 5 });
    else k.pole(x + sx * 0.1 * s, y - 0.25 * s, z + 0.15 * s, x + sx * 0.22 * s, y + 0.1 * s, z + 0.35 * s, 0.04 * s, 0.005, Surf.Bone, BONE, { lod: 1, seg: 4 });
  }
}

/** Curved tusks flanking a doorway. */
function tusks(k: Kit, x: number, z: number, w: number, h: number, s: number) {
  for (const sx of [-1, 1]) {
    const bx = x + sx * (w / 2 + 0.25);
    // Curved tusk from three tapering segments, curling outward then back in.
    k.pole(bx, -0.1, z + 0.15, bx + sx * 0.18, h * 0.45, z + 0.35, 0.11 * s, 0.09 * s, Surf.Bone, BONE, { lod: 1, seg: 7 });
    k.pole(bx + sx * 0.18, h * 0.45, z + 0.35, bx + sx * 0.12, h * 0.8, z + 0.6, 0.09 * s, 0.06 * s, Surf.Bone, BONE, { lod: 1, seg: 7 });
    k.pole(bx + sx * 0.12, h * 0.8, z + 0.6, bx - sx * 0.12, h * 1.0, z + 0.7, 0.06 * s, 0.005, Surf.Bone, scaleHex(BONE, 0.95), { lod: 1, seg: 7 });
  }
}

/** Sharpened stakes leaning outward along a line (frame x from a to b at z). */
function stakes(k: Kit, a: number, b: number, z: number, s: number, rng: Kit['rng']) {
  for (let x = a; x <= b; x += 0.55) {
    const h = rng.range(1.0, 1.6) * s;
    k.pole(x, -0.2, z, x + rng.range(-0.05, 0.05), h, z + 0.55, 0.07, 0.0, Surf.Bark, jitter(0x5a4430, rng, 0.1), { lod: 1, seg: 5 });
  }
}

/** Banner on a pole planted at (x, z). */
function warBanner(k: Kit, c: BuildCtx, x: number, z: number, h: number) {
  k.cyl(x, 0, z, 0.07, 0.05, h, Surf.Bark, 0x4a3424, { seg: 6 });
  k.box(x, h - 0.2, z + 0.06, 1.2 * c.s, 0.06, 0.06, Surf.Timber, 0x3a2a1e, { lod: 1 });
  k.push(x, 0, z + 0.12, 0);
  heraldicPanel(k, c.her, 1.0 * c.s, 1.9 * c.s, h - 2.15 * c.s, 0.03, 1);
  k.pop();
  skull(k, x, h + 0.15, z, 0.8, true);
}

function roundHut(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const tent = c.b.role === 'tent';
  const r = c.w / 2;
  const wallH = (tent ? 1.4 : 1.9) * c.s;
  const spec = roundSpec(c, {
    storey: Math.max(wallH, 1.6),
    floors: 1,
    seg: Math.max(9, Math.round(r * 2.6)),
    walls: [{ surf: tent ? Surf.Hide : Surf.Bark, col: tent ? jitter(0x9a7a58, c.rng, 0.1) : jitter(0x6a5038, c.rng, 0.08) }],
    door: doorLook(c, { x: 0, surf: Surf.Hide, col: jitter(0x7a5a3c, c.rng, 0.1), frameSurf: Surf.Bark, frameCol: 0x4a3424, arch: false, bands: false, h: Math.min(Math.max(wallH, 1.6) - 0.05, 2.0 * c.s) }),
    win: windowLook(c, { shape: 'slit', h: 0.5 * c.s, sill: 0.9 * c.s, lit: 1.4, glow: 0xff8a3a }),
    roof: roofLook(c, 'conical', { surf: Surf.Hide, col: jitter(c.rng.pick([0x8a6a4c, 0x9a7a58, 0x7a5c40]), c.rng, 0.08), overhang: 0.7 * c.s, pitch: tent ? 1.25 : 1.05, finial: false }),
    plinth: 0.1,
    stairs: false,
  });
  const out = buildRound(k, spec);
  const rr = r + spec.roof.overhang;
  const H = spec.roof.pitch * rr * 1.4;
  const top = out.wallTop - 0.1 + H;
  // Pole frame bristling out of the apex, lashed with rope.
  k.use(out.roof);
  const n = tent ? 6 : 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.2;
    const bx = Math.sin(a) * rr * 0.98, bz = Math.cos(a) * rr * 0.98;
    // Rafter along the roof surface, extended beyond the apex.
    const ex = -bx * 0.12, ez = -bz * 0.12;
    k.pole(bx, out.wallTop - 0.15, bz, ex, top + 0.9 * c.s, ez, 0.07, 0.05, Surf.Bark, jitter(0x5a4430, c.rng, 0.1), { lod: 1, seg: 5 });
  }
  k.cyl(0, top - 0.55 * c.s, 0, 0.28, 0.2, 0.35, Surf.Rope, 0x7a6040, { seg: 8, lod: 1 });
  // War paint bands on the hide.
  const band = (y0: number, h: number, col: number) => {
    const ra = rr * (1 - (y0 - out.wallTop + 0.1) / H) + 0.03, rb = rr * (1 - (y0 + h - out.wallTop + 0.1) / H) + 0.03;
    if (rb > 0.2) k.cyl(0, y0, 0, ra, rb, h, Surf.Hide, col, { seg: Math.max(9, n * 2), lod: 1 });
  };
  band(out.wallTop + H * 0.18, 0.22 * c.s, PAINT_RED);
  if (c.rng.chance(0.6)) band(out.wallTop + H * 0.3, 0.12 * c.s, PAINT_BLACK);
  // Smoke hole.
  k.smoke(0, top + 0.5, 0);
  // Door trophies.
  k.use(out.walls[0][0]);
  // Skull on a stake beside the entrance.
  const stx = -(spec.door!.w / 2 + 0.9);
  k.cyl(stx, 0, r + 0.6, 0.05, 0.04, 2.0 * c.s, Surf.Bark, 0x4a3424, { seg: 5, lod: 1 });
  skull(k, stx, 2.0 * c.s + 0.12, r + 0.6, c.s, c.rng.chance(0.6));
  if (!tent) tusks(k, 0, r, spec.door!.w, Math.max(wallH, 1.6), c.s);
  // Hanging hides & a rack of bones beside the entrance.
  if (c.rng.chance(0.6)) {
    k.box(r * 0.75, 0.8, r * 0.75, 0.8, 1.0, 0.04, Surf.Hide, jitter(0xa08060, c.rng, 0.12), { ry: Math.PI / 4, lod: 1 });
  }
  furnishAll(k, c, out);
  return interiorOf(c, out, true);
}

function longhouse(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const role = c.b.role;
  const grand = role === 'hall' || role === 'tavern' || role === 'temple' || role === 'barracks';
  const spec = shellSpec(c, {
    walls: [{ surf: Surf.Bark, col: jitter(0x6a5038, c.rng, 0.08) }],
    storey: c.storey * (grand ? 1.15 : 0.9),
    floors: 1,
    stairs: false,
    plinth: 0.15,
    baseSurf: Surf.Rubble,
    jetty: 0,
    porch: null,
    balcony: false,
    door: doorLook(c, { surf: Surf.Planks, col: jitter(0x4a3424, c.rng, 0.08), frameSurf: Surf.Bark, frameCol: 0x3e2c1e, arch: false, bands: true }),
    win: windowLook(c, { shape: 'slit', lit: 1.8, glow: 0xff7a30, shutterCol: null, flowerbox: false }),
    roof: roofLook(c, 'gable', { surf: c.roof.surf, col: c.roof.col, overhang: 0.9 * c.s, thick: 0.4, pitch: c.rng.range(0.9, 1.25), trimSurf: Surf.Bark, trimCol: 0x4a3424, dormers: 0, finial: false }),
    chimneyX: null,
  });
  const out = buildShell(k, spec);
  const t = spec.wallT;
  const along = c.w >= c.d;
  const W = along ? c.w : c.d, D = along ? c.d : c.w;
  const H = spec.roof.pitch * (D / 2);
  // Corner log ends (horizontal logs crossing at the corners).
  k.use(out.walls[0][0]);
  const courses = Math.floor(out.wallTop / (0.38 * c.s));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    for (let i = 0; i < courses; i++) {
      const y = 0.2 + i * 0.38 * c.s;
      if (i % 2 === 0) k.cyl(sx * (c.w / 2 + 0.35), y, sz * (c.d / 2 - t / 2), 0.17, 0.17, 0.7, Surf.Bark, jitter(0x5e4630, c.rng, 0.1), { rz: Math.PI / 2, seg: 6, lod: 1 });
      else k.cyl(sx * (c.w / 2 - t / 2), y, sz * (c.d / 2 + 0.35), 0.17, 0.17, 0.7, Surf.Bark, jitter(0x5e4630, c.rng, 0.1), { rx: Math.PI / 2, seg: 6, lod: 1 });
    }
  }
  // Painted war motifs (zigzag of red/black boards) on the long walls.
  for (const side of [1, 3]) {
    k.use(out.walls[0][side]);
    const sx = side === 1 ? 1 : -1;
    const n = Math.floor(c.d / 1.6);
    for (let i = 0; i < n; i++) {
      const z = -c.d / 2 + 0.8 + i * 1.6;
      k.boxC(sx * (c.w / 2 + 0.02), out.wallTop * 0.62, z, 0.03, 0.18 * c.s, 0.9, Surf.Cloth, i % 2 ? PAINT_RED : PAINT_BLACK, { rx: i % 2 ? 0.6 : -0.6, lod: 1 });
    }
  }
  // Crossed rafters at the gable ends and a ridge log.
  k.use(out.roof);
  k.push(0, 0, 0, along ? 0 : Math.PI / 2);
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 + spec.roof.overhang * 0.5);
    for (const sz of [-1, 1]) k.pole(x, out.wallTop + H * 0.4, sz * D * 0.25, x, out.wallTop + H + 1.4 * c.s, -sz * D * 0.12, 0.13, 0.08, Surf.Bark, 0x4a3424, { seg: 6, lod: 1 });
    skull(k, x + sx * 0.1, out.wallTop + H + 0.95 * c.s, 0, c.s, true);
  }
  k.cyl(-W / 2 - spec.roof.overhang * 0.6, out.wallTop + H + 0.12, 0, 0.2, 0.2, W + spec.roof.overhang * 1.2, Surf.Bark, 0x4e3a28, { rz: -Math.PI / 2, seg: 7, lod: 1 });
  // Lashings along the roof edge (hide weighted by ropes and stones).
  for (let i = 0; i < Math.floor(W / 2.2); i++) {
    const x = -W / 2 + 1.1 + i * 2.2;
    for (const sz of [-1, 1]) k.sphere(x, out.wallTop - spec.roof.overhang * spec.roof.pitch * 0.9 + 0.05, sz * (D / 2 + spec.roof.overhang * 0.9), 0.2, 0.15, 0.2, Surf.Rubble, jitter(0x7a766c, c.rng, 0.1), { seg: 6, lod: 1 });
  }
  k.pop();
  k.smoke(0, out.wallTop + H + 0.3, 0);
  // Entrance trophies.
  k.use(out.walls[0][0]);
  const dl = spec.door!;
  skull(k, dl.x, dl.h + 0.45, c.d / 2 + 0.15, c.s * 1.2, true);
  tusks(k, dl.x, c.d / 2, dl.w, dl.h, c.s);
  // Banners & stakes for martial buildings.
  if (grand || role === 'smithy') {
    k.piece('deco', 'cloth', [out.found], 1);
    for (const sx of [-1, 1]) warBanner(k, c, sx * (c.w / 2 - 0.3), c.d / 2 + 1.4, 4.2 * c.s);
    if (role === 'barracks' || role === 'hall') {
      k.push(0, 0, 0, 0);
      stakes(k, -c.w / 2 + 0.3, dl.x - dl.w / 2 - 1.2, c.d / 2 + 2.2, c.s, c.rng);
      stakes(k, dl.x + dl.w / 2 + 1.2, c.w / 2 - 0.3, c.d / 2 + 2.2, c.s, c.rng);
      k.pop();
    }
  }
  if (role === 'smithy') {
    // Open forge pit with glowing coals beside the house.
    k.piece('deco', 'stone', [out.found], 1);
    const fx = c.w / 2 + 1.4;
    k.cyl(fx, 0, 0, 0.8, 0.9, 0.7, Surf.Rubble, 0x5a5650, { seg: 8 });
    k.cyl(fx, 0.7, 0, 0.6, 0.6, 0.04, Surf.Fire, 0xff8a30, { seg: 8, emit: 0xff5a10, emitI: 4 });
    k.col(fx, 0, 0, 1.7, 0.75, 1.7, true);
    k.light(fx, 1.3, 0, 0xff6a20, 5, 9, false, 0.8);
    k.smoke(fx, 1.2, 0);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

/** Log watchtower: enclosed log storeys, flat fighting top ringed with stakes under a hide canopy. */
function tower(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const spec = shellSpec(c, {
    walls: [{ surf: Surf.Bark, col: jitter(0x6a5038, c.rng, 0.08) }],
    plinth: 0.15,
    jetty: 0,
    door: doorLook(c, { surf: Surf.Planks, col: jitter(0x4a3424, c.rng, 0.08), frameSurf: Surf.Bark, frameCol: 0x3e2c1e, arch: false, bands: true }),
    win: windowLook(c, { shape: 'slit', lit: 1.4, glow: 0xff7a30, shutterCol: null, flowerbox: false }),
    roof: roofLook(c, 'flat', { surf: Surf.Planks, col: 0x6a5038, crenel: false, trimSurf: Surf.Bark, trimCol: 0x4a3424 }),
    chimneyX: null,
  });
  const out = buildShell(k, spec);
  const H = out.wallTop + 0.3;
  const r = Math.min(c.w, c.d) / 2;
  // Stakes around the top and a canopy on poles.
  k.use(out.roof);
  for (let i = 0; i < 4; i++) {
    const half = (i % 2 === 0 ? c.w : c.d) / 2;
    const other = (i % 2 === 0 ? c.d : c.w) / 2;
    k.push(0, H, 0, (i * Math.PI) / 2);
    for (let x = -half; x <= half; x += 0.45) k.cyl(x, 0.5, other + 0.05, 0.07, 0.0, 1.0 * c.s, Surf.Bark, jitter(0x5a4430, c.rng, 0.1), { seg: 5, lod: 1 });
    k.pop();
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(sx * (c.w / 2 - 0.3), H, sz * (c.d / 2 - 0.3), 0.14, 2.4, 0.14, Surf.Bark, 0x4a3424);
  k.cyl(0, H + 2.4, 0, r * 1.7, 0, r * 1.3, Surf.Hide, jitter(0x8a6a4c, c.rng, 0.08), { seg: 7 });
  skull(k, 0, H + 2.4 + r * 1.3, 0, c.s, true);
  k.light(0, H + 1.6, 0, 0xff8a30, 5, 12, false, 1);
  k.cyl(r * 0.6, H + 0.9, r * 0.6, 0.1, 0.13, 0.3, Surf.Fire, 0xffb050, { emit: 0xff7a20, emitI: 4, seg: 5, lod: 1 });
  k.use(out.walls[0][0]);
  skull(k, spec.door!.x, spec.door!.h + 0.4, c.d / 2 + 0.15, c.s, true);
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

export const buildOrcish: StyleBuilder = (k: Kit, c: BuildCtx) => {
  const role = c.b.role;
  if (role === 'watchtower') return tower(k, c);
  if (role === 'mill') {
    const out = buildRound(k, roundSpec(c, { walls: [{ surf: Surf.Bark, col: jitter(0x6a5038, c.rng, 0.08) }], roof: roofLook(c, 'conical', { surf: Surf.Hide, col: c.roof.col, pitch: 1.0 }), taper: 0.85 }));
    windmillSails(k, c, out, (c.w / 2) * 0.85);
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }
  if (c.b.round) {
    if (role === 'mage_tower') {
      const out = buildRound(k, roundSpec(c, { walls: [{ surf: Surf.Rubble, col: jitter(0x6a645c, c.rng, 0.06) }], roof: roofLook(c, 'conical', { surf: Surf.Hide, col: c.roof.col, pitch: 1.6, finial: true }), taper: 0.88 }));
      k.use(out.roof);
      skull(k, 0, out.ridge + 0.3, 0, 1.4, true);
      k.light(0, out.ridge - 1, 0, 0xff5020, 3, 10, true, 0.6);
      furnishAll(k, c, out);
      return interiorOf(c, out, true);
    }
    return roundHut(k, c);
  }
  return longhouse(k, c);
};

/** Far LOD: cones for huts, low boxes with big roofs for longhouses. */
export const silhouetteOrcish: ((k: Kit, c: BuildCtx) => void) | undefined = (k: Kit, c: BuildCtx) => {
  const b = c.b;
  const gmin = Math.min(...(b.ground ?? [0, 0, 0, 0]));
  const lit = c.rng.chance(0.7);
  if (b.round) {
    const r = b.size[0] / 2;
    const wh = 1.9 * c.s;
    k.cyl(0, gmin, 0, r, r, wh - gmin, Surf.Bark, 0x6a5038, { seg: 7 });
    k.cyl(0, wh - 0.1, 0, r + 0.6, 0, (r + 0.6) * 1.45, Surf.Hide, c.roof.col, { seg: 7 });
    if (lit) k.box(0, wh * 0.45, r, 0.6, 0.8, 0.1, Surf.Window, 0x30384a, { emit: 0xff8a3a, emitI: 2.2, night: true });
    return;
  }
  const H = c.storey;
  k.box(0, gmin, 0, b.size[0], H - gmin, b.size[1], Surf.Bark, 0x6a5038);
  const along = b.size[0] >= b.size[1];
  const span = along ? b.size[1] : b.size[0];
  if (along) k.frustum(0, H - 0.2, 0, b.size[0] + 1.6, b.size[1] + 1.6, b.size[0] + 1.6, 0, span * 0.55, Surf.Hide, c.roof.col);
  else k.frustum(0, H - 0.2, 0, b.size[0] + 1.6, b.size[1] + 1.6, 0, b.size[1] + 1.6, span * 0.55, Surf.Hide, c.roof.col);
  if (lit) k.box(0, H * 0.45, b.size[1] / 2 + 0.02, 0.8, 0.5, 0.06, Surf.Window, 0x30384a, { emit: 0xff8a3a, emitI: 2.2, night: true });
};
