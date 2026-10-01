/**
 * Drakeborn architecture: obsidian & basalt, angular battered walls tapering
 * upward with glowing ember seams in the plinths, steep pyramid / hip roofs
 * crowned by bronze ridge spikes and horn-shaped finials, braziers burning at
 * every threshold, stepped ziggurat temples with a flame altar on the summit,
 * forges venting lava light. Palette: black, oxblood and bronze.
 */
import { deriveSeed } from '../../core/rng';
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, doorLook, type BuildCtx, type StyleBuilder } from './common';
import { batter, brazier, pushFace } from './styleStonekeep';

const BRONZE = 0x9a6a3a;
const EMBER = 0xff5a10;

/** Curved horn rising from (x, y, z) outward along ±x (frame-local). */
function horn(k: Kit, x: number, y: number, z: number, sx: number, size: number, col: number) {
  const p0: [number, number, number] = [x, y, z];
  const p1: [number, number, number] = [x + sx * 0.45 * size, y + 0.55 * size, z];
  const p2: [number, number, number] = [x + sx * 0.55 * size, y + 1.15 * size, z - 0.1 * size];
  const p3: [number, number, number] = [x + sx * 0.25 * size, y + 1.5 * size, z - 0.15 * size];
  k.pole(...p0, ...p1, 0.16 * size, 0.12 * size, Surf.Bone, col, { lod: 1 });
  k.pole(...p1, ...p2, 0.12 * size, 0.08 * size, Surf.Bone, col, { lod: 1 });
  k.pole(...p2, ...p3, 0.08 * size, 0.01, Surf.Bone, col, { lod: 1 });
}

/** Bronze spikes along the roof ridge (or at the apex of a pyramid). */
function ridgeSpikes(k: Kit, c: BuildCtx, out: ShellOut, pyramid: boolean) {
  k.use(out.roof);
  const top = out.ridge;
  if (pyramid) {
    k.cyl(0, top - 0.3, 0, 0.16, 0, 2.2 * c.s, Surf.Metal, BRONZE, { seg: 6, lod: 1 });
    k.sphere(0, top + 0.4, 0, 0.2, 0.2, 0.2, Surf.Metal, BRONZE, { seg: 6, lod: 1 });
    return;
  }
  const along = c.w >= c.d;
  const L = Math.max(0.1, Math.abs(c.w - c.d));
  const n = Math.max(2, Math.round(L / 1.6) + 1);
  for (let i = 0; i < n; i++) {
    const u = -L / 2 + (i * L) / (n - 1);
    const x = along ? u : 0, z = along ? 0 : u;
    const h = i === 0 || i === n - 1 ? 1.6 : 0.7;
    k.cyl(x, top - 0.15, z, 0.1, 0, h * c.s, Surf.Metal, BRONZE, { seg: 5, lod: 1 });
  }
  // Horns at the ridge ends.
  const ex = along ? L / 2 : 0, ez = along ? 0 : L / 2;
  for (const sgn of [-1, 1]) {
    k.push(sgn * ex, 0, sgn * ez, along ? 0 : Math.PI / 2);
    horn(k, 0, top - 0.1, 0, sgn, 0.9 * c.s, 0xd8ccb0);
    k.pop();
  }
}

/** Stepped ziggurat terraces on a flat roof with a flame altar at the summit. */
function ziggurat(k: Kit, c: BuildCtx, out: ShellOut) {
  k.use(out.roof);
  let w = c.w - 0.6, d = c.d - 0.6, y = out.wallTop + 0.3;
  const col = scaleHex(c.wall.col, 0.95);
  for (let i = 0; i < 3; i++) {
    const h = 1.6 * c.s;
    w -= 2.4;
    d -= 2.4;
    if (w < 2.4 || d < 2.4) break;
    k.solid(0, y, 0, w, h, d, Surf.Basalt, i % 2 ? scaleHex(col, 0.9) : col);
    k.box(0, y + h - 0.1, 0, w + 0.2, 0.15, d + 0.2, Surf.Metal, BRONZE, { lod: 1 });
    k.box(0, y + 0.4, d / 2 + 0.01, w - 0.4, 0.07, 0.02, Surf.Fire, EMBER, { emit: EMBER, emitI: 2, lod: 1 });
    y += h;
  }
  // Flame altar.
  k.box(0, y, 0, 1.6, 0.9, 1.6, Surf.Basalt, scaleHex(col, 0.8));
  k.cyl(0, y + 0.9, 0, 0.6, 0.9, 0.4, Surf.Metal, BRONZE, { seg: 8 });
  k.cyl(0, y + 1.3, 0, 0.7, 0.02, 2.2, Surf.Fire, 0xffb050, { emit: 0xff6a10, emitI: 6, seg: 7 });
  k.cyl(0.15, y + 1.3, 0.1, 0.4, 0.01, 1.4, Surf.Fire, 0xffe090, { emit: 0xffc060, emitI: 6, seg: 5 });
  k.light(0, y + 2.4, 0, 0xff8030, 9, 22, false, 1);
  k.smoke(0, y + 3.2, 0);
  for (const sx of [-1, 1]) horn(k, sx * 0.8, y + 0.9, 0, sx, 1.4 * c.s, 0x2a2624);
}

/** Bronze door frame with horns above the lintel. */
function doorFrame(k: Kit, c: BuildCtx, out: ShellOut, dw: number, dh: number) {
  k.use(out.walls[0][0]);
  pushFace(k, 0, c.w, c.d, 0);
  const x = c.doorX;
  for (const sx of [-1, 1]) k.frustum(x + sx * (dw / 2 + 0.25), 0, 0.12, 0.5, 0.3, 0.3, 0.2, dh + 0.3, Surf.Basalt, scaleHex(c.wall.col, 0.75), { lod: 1 });
  k.frustum(x, dh + 0.1, 0.14, dw + 1.2, 0.34, dw + 0.4, 0.2, 0.7, Surf.Basalt, scaleHex(c.wall.col, 0.75), { lod: 1 });
  k.box(x, dh + 0.25, 0.32, dw + 0.4, 0.08, 0.04, Surf.Metal, BRONZE, { lod: 1 });
  for (const sx of [-1, 1]) horn(k, x + sx * (dw / 2 + 0.2), dh + 0.7, 0.2, sx, 0.6 * c.s, 0xd8ccb0);
  k.pop();
}

export const buildDrakeborn: StyleBuilder = (k: Kit, c: BuildCtx): Blueprint['interior'] => {
  const b = c.b;
  const role = b.role;
  const s = c.s;
  // Lifted basalt tones so the black stone still reads in shadow; oxblood or bronze roofs.
  const wall = { surf: Surf.Basalt, col: jitter(c.rng.pick([0x5e544e, 0x524a46, 0x685a50, 0x584c4a]), c.rng, 0.04) };
  const bronzeRoof = c.rng.chance(0.3);
  const roofSurf = bronzeRoof ? Surf.Metal : Surf.Slate;
  const roofCol = bronzeRoof ? jitter(0x7a5030, c.rng, 0.06) : jitter(c.rng.pick([0x6a2e28, 0x5a2a2a, 0x4a3030, 0x3e3434]), c.rng, 0.06);

  if (b.round || role === 'mage_tower' || role === 'mill') {
    const spec = roundSpec(c, {
      wallT: Math.min(0.7, c.w * 0.12),
      taper: 0.74,
      seg: 8,
      walls: [wall],
      roof: roofLook(c, 'conical', { pitch: 2.0, surf: roofSurf, col: roofCol, overhang: 0.25, finial: false, trimSurf: Surf.Metal, trimCol: BRONZE }),
      platform: role === 'watchtower',
      win: windowLook(c, { shape: 'slit', lit: 2.6 }),
    });
    const out = buildRound(k, spec);
    k.use(out.found);
    k.cyl(0, -0.3, 0, spec.r + 0.7, spec.r + 0.05, 1.6 * s, Surf.Basalt, scaleHex(wall.col, 0.85), { seg: 8, lod: 1 });
    k.cyl(0, 0.9 * s, 0, spec.r + 0.33, spec.r + 0.3, 0.06, Surf.Fire, EMBER, { seg: 8, emit: EMBER, emitI: 2, lod: 1 });
    k.use(out.roof);
    k.cyl(0, out.ridge - 0.3, 0, 0.16, 0, 2.0, Surf.Metal, BRONZE, { seg: 6, lod: 1 });
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }

  const small = c.w < 9 && c.d < 9;
  const kind = role === 'temple' || role === 'barracks' ? 'flat' : b.roof === 'flat' && role !== 'house' ? 'flat' : small ? 'conical' : 'hip';
  const o: Parameters<typeof shellSpec>[1] = {
    walls: Array.from({ length: c.floors }, (_, f) => ({ surf: wall.surf, col: f ? scaleHex(wall.col, 1.08) : wall.col, quoin: { surf: Surf.Basalt, col: scaleHex(wall.col, 0.7) } })),
    win: windowLook(c, { shape: 'slit', w: 0.36 * s, h: 1.5 * s, sill: 1.2 * s, spacing: 2.3 * s, frameSurf: Surf.Metal, frameCol: BRONZE, shutterCol: null, flowerbox: false, glow: 0xff7a2a }),
    door: doorLook(c, { w: (role === 'hall' || role === 'temple' ? 2.4 : role === 'barn' || role === 'warehouse' || role === 'stable' ? 2.6 : 1.3) * s, h: (role === 'hall' || role === 'temple' ? 3.2 : 2.4) * s, bands: true, arch: false, col: jitter(0x3a2420, c.rng, 0.08), frameSurf: Surf.Metal, frameCol: BRONZE }),
    roof: roofLook(c, kind, { pitch: kind === 'conical' ? c.rng.range(1.3, 1.8) : c.rng.range(1.1, 1.6), surf: roofSurf, col: roofCol, trimSurf: Surf.Metal, trimCol: BRONZE, overhang: 0.35, finial: false, crenel: role === 'barracks', dormers: 0 }),
    chimneySurf: Surf.Basalt,
    chimneyCol: scaleHex(wall.col, 0.8),
  };
  if (role === 'temple') o.storey = c.storey * 1.6;
  if (role === 'hall') o.storey = c.storey * 1.5;
  const spec = shellSpec(c, o);
  const out = buildShell(k, spec);
  batter(k, c, out, 1.7 * s, 0.85, Surf.Basalt, scaleHex(wall.col, 0.82), EMBER);
  if (spec.door) doorFrame(k, c, out, spec.door.w, spec.door.h);
  if (kind !== 'flat') ridgeSpikes(k, c, out, kind === 'conical');
  if (role === 'temple') ziggurat(k, c, out);
  // Braziers at the threshold.
  if (spec.door && (role !== 'house' || deriveSeed(b.seed, 'braz') % 3 === 0)) {
    k.piece('deco', 'metal', [out.found], 0);
    for (const sx of [-1, 1]) brazier(k, c.doorX + sx * (spec.door.w / 2 + 1.1 * s), c.d / 2 + 0.9, s, EMBER);
  }
  if (role === 'smithy') {
    // Lava trough vent along the forge wall.
    k.piece('deco', 'stone', [out.found], 1);
    k.box(0, 0, -c.d / 2 - 0.6, c.w * 0.6, 0.6, 1.0, Surf.Basalt, scaleHex(wall.col, 0.8));
    k.box(0, 0.6, -c.d / 2 - 0.6, c.w * 0.55, 0.04, 0.8, Surf.Fire, 0xff6a20, { emit: EMBER, emitI: 4 });
    k.light(0, 1.2, -c.d / 2 - 0.8, 0xff6020, 5, 10, false, 0.8);
    k.smoke(0, 1.0, -c.d / 2 - 0.6);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
};

/** Far LOD: tapered dark block with a steep pyramid/hip roof, ember windows at night. */
export const silhouetteDrakeborn = (k: Kit, c: BuildCtx) => {
  const b = c.b;
  const gmin = Math.min(...(b.ground ?? [0, 0, 0, 0]));
  const storey = c.storey * (b.role === 'temple' ? 1.6 : b.role === 'hall' ? 1.5 : 1);
  const H = (b.floors ?? 1) * storey;
  const col = 0x5a504a;
  if (b.round) {
    k.cyl(0, gmin, 0, c.w / 2, c.w * 0.37, H - gmin, Surf.Basalt, col, { seg: 8 });
    k.cyl(0, H, 0, c.w * 0.42, 0, c.w * 1.0, Surf.Slate, 0x5a2e2a, { seg: 8 });
  } else {
    k.frustum(0, gmin, 0, c.w + 1.2, c.d + 1.2, c.w, c.d, H - gmin, Surf.Basalt, col);
    if (b.role === 'temple') k.frustum(0, H, 0, c.w - 2, c.d - 2, c.w - 6, c.d - 6, 4.5, Surf.Basalt, col);
    else k.frustum(0, H - 0.1, 0, c.w + 0.6, c.d + 0.6, c.w < 9 && c.d < 9 ? 0 : Math.max(0.1, c.w - c.d), 0.1, Math.min(c.w, c.d) * 0.7, Surf.Slate, 0x5a2e2a);
  }
  k.box(0, gmin + 0.6, c.d / 2 + 0.55, c.w * 0.8, 0.08, 0.04, Surf.Fire, EMBER, { emit: EMBER, emitI: 2 });
  if ((deriveSeed(b.seed, 'lit') & 255) < 200) for (const sx of [-0.25, 0.25]) for (const sz of [1, -1]) k.box(sx * c.w, 1.3 * c.s, sz * (c.d / 2 + 0.02), 0.4, 1.3, 0.06, Surf.Window, 0x30384a, { emit: 0xff7a2a, emitI: 2.2, night: true });
};
