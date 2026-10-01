/**
 * Human timber-framed & stone architecture (and the generic palette-driven
 * fallback for any style without a dedicated builder): framed plaster houses
 * with jetties, thatch/shingle/slate/clay roofs and brick chimneys; stone
 * temples with bell towers, rose windows and buttresses; halls, taverns with
 * porches and balconies, smithies with forge lean-tos, barns with hay lofts,
 * warehouses with hoist beams, arcaded market halls, windmills with turning
 * sails, round mage towers and crenellated watchtowers.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell, roof, windowAt, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roundSpec, shellSpec, windowLook, roofLook, type BuildCtx } from './common';
import { heraldicPanel } from './heraldry';

/** Windmill sails on a spinning hub at the front of a round mill. */
export function windmillSails(k: Kit, c: BuildCtx, out: ShellOut, r: number) {
  k.piece('deco', 'wood', [out.roof], 1);
  const hy = out.wallTop + 0.6;
  const hz = r + 0.6;
  k.box(0, hy - 0.2, r * 0.4, 0.4, 0.4, r + 0.4, Surf.Timber, c.trim.col);
  k.cyl(0, hy, hz - 0.1, 0.3, 0.25, 0.5, Surf.Timber, scaleHex(c.trim.col, 0.8), { rx: Math.PI / 2, seg: 8 });
  const L = Math.max(5, r * 2.2);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    k.push(0, 0, 0, 0);
    // Arm along angle a in the XY plane at z = hz.
    const ex = Math.cos(a) * L, ey = Math.sin(a) * L;
    k.beam(0, hy, hz + 0.25, ex, hy + ey, hz + 0.25, 0.14, Surf.Timber, c.trim.col, { d: 0.12 });
    // Lattice sail (cloth) on one side of the arm.
    const nx = -Math.sin(a), ny = Math.cos(a);
    const sw = 0.9;
    k.boxC(ex * 0.6 + nx * sw * 0.55, hy + ey * 0.6 + ny * sw * 0.55, hz + 0.3, L * 0.75, sw, 0.03, Surf.Cloth, jitter(0xe8e0cc, c.rng, 0.05), { rz: a });
    for (let j = 1; j <= 4; j++) {
      const u = 0.25 + j * 0.17;
      k.beam(ex * u, hy + ey * u, hz + 0.3, ex * u + nx * sw * 1.1, hy + ey * u + ny * sw * 1.1, hz + 0.3, 0.05, Surf.Timber, c.trim.col, { lod: 1 });
    }
    k.pop();
  }
  k.spin(0, hy, hz + 0.25, 0, 0.6);
}

/** Square bell tower with a pyramid spire at the front of a temple. */
function bellTower(k: Kit, c: BuildCtx, out: ShellOut) {
  const tw = Math.min(4, c.w * 0.38);
  const th = out.ridge + 3.5 * c.s;
  k.piece('tower', 'stone', [out.found], 1);
  const z = c.d / 2 - tw / 2 + 0.6;
  // Hollow-ish shaft: four walls (door passes through the front of the nave).
  const wallSurf = c.wall.surf === Surf.Plaster ? Surf.StoneBrick : c.wall.surf;
  const col = c.wall.surf === Surf.Plaster ? jitter(0xb0a898, c.rng, 0.05) : c.wall.col;
  for (const sx of [-1, 1]) k.solid((sx * (tw - 0.5)) / 2, 0, z, 0.5, th, tw, wallSurf, col);
  k.solid(0, out.wallTop, z + tw / 2 - 0.25, tw, th - out.wallTop, 0.5, wallSurf, col);
  k.solid(0, out.wallTop, z - tw / 2 + 0.25, tw, th - out.wallTop, 0.5, wallSurf, col);
  // Belfry openings & bell.
  for (const sz of [1, -1]) k.box(0, th - 2.6, z + (sz * tw) / 2, 1.0, 1.6, 0.55, Surf.Window, 0x141418, { lod: 1 });
  k.sphere(0, th - 2.2, z, 0.45, 0.55, 0.45, Surf.Metal, 0xb08a40, { lat0: 0, lat1: Math.PI / 2 + 0.4, seg: 10, lod: 1 });
  k.box(0, th, z, tw + 0.3, 0.25, tw + 0.3, Surf.StoneBrick, scaleHex(col, 0.9));
  k.frustum(0, th + 0.25, z, tw + 0.2, tw + 0.2, 0, 0, tw * 2.2, c.roof.surf === Surf.Thatch ? Surf.Slate : c.roof.surf, c.roof.surf === Surf.Thatch ? 0x4e5462 : c.roof.col);
  k.cyl(0, th + 0.25 + tw * 2.2 - 0.2, z, 0.06, 0.02, 1.6, Surf.Metal, 0xc0a040, { seg: 6, lod: 1 });
  k.box(0, th + 0.25 + tw * 2.2 + 0.9, z, 0.6, 0.06, 0.06, Surf.Metal, 0xc0a040, { lod: 1 });
  // Rose window on the front gable.
  k.use(out.roof);
}

/** Stone buttresses along the long walls. */
function buttresses(k: Kit, c: BuildCtx, out: ShellOut) {
  const n = Math.max(2, Math.floor(c.d / 4));
  for (const sx of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const z = -c.d / 2 + ((i + 0.5) * c.d) / n;
      k.use(out.walls[0][sx > 0 ? 1 : 3]);
      k.frustum(sx * (c.w / 2 + 0.45), 0, z, 0.9, 0.7, 0.3, 0.5, out.wallTop * 0.85, c.base.surf === Surf.Rubble ? Surf.StoneBrick : c.base.surf, scaleHex(c.wall.surf === Surf.Plaster ? 0xa8a090 : c.wall.col, 0.92), { lod: 1, ox: -sx * 0.25 });
    }
  }
}

/** Open lean-to on the side of a smithy with a work anvil. */
function leanTo(k: Kit, c: BuildCtx, out: ShellOut) {
  k.piece('porch', 'wood', [out.found], 1);
  const dw = 3 * c.s, dd = c.d * 0.7;
  const x0 = c.w / 2;
  const h = 2.6 * c.s;
  for (const sz of [-1, 1]) {
    k.box(x0 + dw - 0.15, 0, (sz * (dd - 0.3)) / 2, 0.16, h, 0.16, Surf.Timber, c.trim.col);
    k.col(x0 + dw - 0.15, 0, (sz * (dd - 0.3)) / 2, 0.16, h, 0.16, true);
  }
  const rise = 0.8;
  k.boxC(x0 + dw / 2, h + rise / 2 + 0.05, 0, Math.hypot(dw + 0.4, rise), 0.12, dd + 0.4, c.roof.surf === Surf.Thatch ? Surf.Shingle : c.roof.surf, c.roof.surf === Surf.Thatch ? 0x6a4e38 : c.roof.col, { rz: Math.atan2(rise, dw + 0.4) });
  k.box(x0 + dw / 2, 0, 0, dw - 0.2, 0.05, dd - 0.2, Surf.Cobble, 0x6a665e, { lod: 1 });
  k.cyl(x0 + dw / 2, 0, 0.3, 0.3, 0.32, 0.5, Surf.Bark, 0x5a4430, { seg: 8, lod: 1 });
  k.box(x0 + dw / 2, 0.5, 0.3, 0.3, 0.25, 0.6, Surf.Metal, 0x404044, { lod: 1 });
  k.box(x0 + dw - 0.4, 0, -dd / 2 + 0.8, 0.6, 0.9, 1.2, Surf.Planks, 0x6a5038, { lod: 1 });
  k.light(x0 + dw / 2, 1.5, 0, 0xff7a30, 2, 5, false, 0.6);
}

/** Hoist beam with rope & pulley over the loft door of a warehouse/barn. */
function hoist(k: Kit, c: BuildCtx, out: ShellOut) {
  k.use(out.roof);
  const y = out.wallTop + 0.4;
  k.box(0, y, c.d / 2 + 0.2, 0.2, 0.2, 1.6, Surf.Timber, c.trim.col, { lod: 1 });
  k.cyl(0, y - 0.25, c.d / 2 + 0.85, 0.12, 0.12, 0.08, Surf.Metal, 0x4a4440, { rz: Math.PI / 2, seg: 8, lod: 1 });
  k.box(0, y - 2.6, c.d / 2 + 0.85, 0.03, 2.4, 0.03, Surf.Rope, 0x8a6a3a, { lod: 1 });
  k.box(0, out.wallTop - 1.6, c.d / 2 - c.t / 2, 1.4, 1.5, c.t + 0.06, Surf.Planks, scaleHex(c.doorCol, 0.9), { lod: 1 });
}

/** Arcaded market hall: pillars carrying a hip roof over open trading floor. */
function marketHall(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const found = k.piece('foundation', 'stone');
  const gmin = Math.min(...c.ground);
  k.solid(0, gmin - 0.6, 0, c.w + 0.2, -gmin + 0.6, c.d + 0.2, c.base.surf, c.base.col);
  k.box(0, 0, 0, c.w - 0.3, 0.04, c.d - 0.3, Surf.Cobble, 0x7a766c, { lod: 1 });
  const h = 3.6 * c.s;
  const nx = Math.max(2, Math.round(c.w / 3.2)), nz = Math.max(2, Math.round(c.d / 3.2));
  const pillars: number[] = [];
  const pcol = c.wall.surf === Surf.Plaster ? jitter(0xb4ac9c, c.rng, 0.05) : c.wall.col;
  const pts: [number, number][] = [];
  for (let i = 0; i <= nx; i++) pts.push([-c.w / 2 + 0.4 + (i * (c.w - 0.8)) / nx, c.d / 2 - 0.4], [-c.w / 2 + 0.4 + (i * (c.w - 0.8)) / nx, -c.d / 2 + 0.4]);
  for (let j = 1; j < nz; j++) pts.push([c.w / 2 - 0.4, -c.d / 2 + 0.4 + (j * (c.d - 0.8)) / nz], [-c.w / 2 + 0.4, -c.d / 2 + 0.4 + (j * (c.d - 0.8)) / nz]);
  for (const [x, z] of pts) {
    pillars.push(k.piece('pillar', 'stone', [found], 1));
    k.solid(x, 0, z, 0.55, 0.3, 0.55, Surf.StoneBrick, scaleHex(pcol, 0.9));
    k.cyl(x, 0.3, z, 0.22 * c.s, 0.2 * c.s, h - 0.6, Surf.StoneBrick, pcol, { seg: 8 });
    k.col(x, 0, z, 0.5, h, 0.5, true);
    k.box(x, h - 0.3, z, 0.6, 0.3, 0.6, Surf.StoneBrick, scaleHex(pcol, 0.9), { lod: 1 });
  }
  const roofP = k.piece('roof', c.roof.surf === Surf.Thatch ? 'plant' : 'stone', pillars, Math.ceil(pillars.length / 2));
  // Beams & upper storey band.
  k.box(0, h, 0, c.w, 0.5, c.d, Surf.Timber, c.trim.col);
  k.col(0, h, 0, c.w, 0.5, c.d, true);
  const rl = roofLook(c, 'hip');
  const apex = roof(k, rl, c.w, c.d, h + 0.5, 0.3, null, pillars, []);
  // Lantern cupola on the ridge.
  k.cyl(0, apex - 0.3, 0, 0.6, 0.6, 1.2, Surf.Timber, c.trim.col, { seg: 6 });
  k.cyl(0, apex + 0.9, 0, 0.9, 0, 1.0, rl.surf, rl.col, { seg: 6 });
  const H = apex - h;
  furnishAll(k, c, { found, walls: [], slabs: [], roof: roofP, gables: [], door: -1, wallTop: h, ridge: h + H, topD: c.d });
  return null;
}

/** Banner hanging from a wall (heraldry), as part of the given piece. */
export function wallBanner(k: Kit, c: BuildCtx, x: number, y: number, z: number, yaw: number, scale = 1) {
  k.push(x, y, z, yaw);
  k.box(0, 0, 0.05, 1.3 * scale, 0.06, 0.06, Surf.Timber, c.trim.col, { lod: 1 });
  k.push(0, 0, 0.1, 0);
  heraldicPanel(k, c.her, 1.1 * scale, 2.0 * scale, -2.05 * scale, 0.03, 1);
  k.pop();
  k.pop();
}

export function buildTimber(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const b = c.b;
  const role = b.role;
  // ---- round roles
  if (b.round || role === 'mill' || role === 'mage_tower') {
    const tall = role === 'mage_tower';
    const isMill = role === 'mill';
    const spec = roundSpec(c, {
      floors: c.floors,
      taper: isMill ? 0.82 : tall ? 0.9 : 1,
      seg: tall ? 12 : isMill ? 10 : Math.max(8, Math.round(c.w * 1.6)),
      walls: tall || isMill || role === 'watchtower'
        ? [{ surf: isMill && c.st.id === 'timber' ? Surf.Plaster : Surf.StoneBrick, col: isMill ? jitter(0xe8dcc8, c.rng, 0.04) : jitter(c.wall.surf === Surf.Plaster ? 0xa8a296 : c.wall.col, c.rng, 0.05) }]
        : [{ surf: c.wall.surf, col: c.wall.col }],
      roof: roofLook(c, b.roof === 'dome' ? 'dome' : 'conical', { pitch: tall ? 1.6 : isMill ? 0.9 : c.rng.range(c.st.pitch[0], c.st.pitch[1]), overhang: tall ? 0.5 : 0.35, finial: tall }),
      platform: role === 'watchtower',
      win: windowLook(c, tall ? { glow: c.st.accent || 0x9ab8ff, lit: 3 } : {}),
    });
    if (role === 'watchtower') {
      spec.roof = roofLook(c, c.rng.chance(0.5) ? 'conical' : 'flat', { crenel: true });
      spec.taper = 0.92;
    }
    const out = buildRound(k, spec);
    if (isMill) windmillSails(k, c, out, spec.r * spec.taper);
    if (tall) {
      // Balcony ring below the roof.
      k.piece('balcony', 'stone', [out.walls[out.walls.length - 1][0]], 1);
      const y = out.wallTop - c.storey + 0.05;
      k.cyl(0, y - 0.25, 0, spec.r * spec.taper + 0.9, spec.r * spec.taper + 0.9, 0.25, Surf.StoneBrick, scaleHex(spec.walls[0].col, 0.9), { seg: 16 });
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        k.box(Math.sin(a) * (spec.r * spec.taper + 0.8), y, Math.cos(a) * (spec.r * spec.taper + 0.8), 0.08, 0.9, 0.08, Surf.Metal, 0x2a2828, { lod: 1 });
      }
      k.cyl(0, y + 0.9, 0, spec.r * spec.taper + 0.85, spec.r * spec.taper + 0.85, 0.06, Surf.Metal, 0x2a2828, { seg: 16, lod: 1 });
      k.light(0, out.ridge + 0.6, 0, c.st.accent || 0x9ab8ff, 4, 14, true, 0.2);
      k.sphere(0, out.ridge + 0.6, 0, 0.25, 0.25, 0.25, Surf.Crystal, c.st.accent || 0x9ab8ff, { emit: c.st.accent || 0x9ab8ff, emitI: 4, seg: 8 });
    }
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }

  // ---- open market hall
  if (role === 'market') return marketHall(k, c);

  // ---- rectangular roles
  const o: Parameters<typeof shellSpec>[1] = {};
  switch (role) {
    case 'temple': {
      o.walls = [{ surf: Surf.StoneBrick, col: jitter(c.st.id === 'timber' ? 0xb8b0a2 : c.wall.col, c.rng, 0.04), quoin: { surf: Surf.StoneBrick, col: 0xa49a8a } }];
      o.roof = roofLook(c, 'gable', { pitch: Math.max(1.1, c.st.pitch[1]), surf: c.roof.surf === Surf.Thatch ? Surf.Slate : c.roof.surf, col: c.roof.surf === Surf.Thatch ? 0x5a6070 : c.roof.col, finial: true });
      o.win = windowLook(c, { shape: c.st.window === 'rect' ? 'pointed' : c.st.window, w: 1.0 * c.s, h: 2.6 * c.s, sill: 1.6 * c.s, spacing: 3.4 * c.s, lit: 2.4, glow: 0xffd090, shutterCol: null, flowerbox: false });
      o.storey = Math.max(c.storey * 1.9, 5.5 * c.s);
      break;
    }
    case 'hall': {
      o.storey = c.storey * 1.6;
      o.walls = [{ surf: c.st.id === 'timber' ? Surf.StoneBrick : c.wall.surf, col: c.st.id === 'timber' ? jitter(0xa8a090, c.rng, 0.05) : c.wall.col, quoin: { surf: Surf.StoneBrick, col: 0x9a9284 } }];
      o.porch = { depth: 2.6 * c.s, surf: Surf.StoneBrick, col: c.base.col, postSurf: Surf.Timber, postCol: c.trim.col, roofSurf: c.roof.surf, roofCol: c.roof.col };
      o.win = windowLook(c, { h: 1.9 * c.s, sill: 1.4 * c.s, lit: 2.8 });
      break;
    }
    case 'tavern':
      o.porch = c.rng.chance(0.7) ? { depth: 2.2 * c.s, surf: Surf.Planks, col: 0x8a6a48, postSurf: Surf.Timber, postCol: c.trim.col, roofSurf: c.roof.surf === Surf.Thatch ? Surf.Shingle : c.roof.surf, roofCol: c.roof.col } : null;
      o.balcony = c.floors > 1 && c.rng.chance(0.5);
      o.win = windowLook(c, { lit: 3.2 });
      break;
    case 'smithy':
      o.walls = [{ surf: Surf.StoneBrick, col: jitter(c.st.id === 'timber' ? 0x9a9284 : c.wall.col, c.rng, 0.05) }];
      o.blind = [2];
      break;
    case 'barn':
    case 'stable':
    case 'warehouse':
      if (c.st.id === 'timber') o.walls = [{ surf: Surf.Planks, col: jitter(role === 'barn' ? 0x8a3a2a : 0x8a6a48, c.rng, 0.08), frame: { surf: Surf.Timber, col: c.trim.col, braces: true, w: 0.2 } }];
      o.storey = c.storey * (role === 'barn' ? 1.5 : 1.2);
      o.win = windowLook(c, { w: 0.7, h: 0.6, sill: 1.9, spacing: 4, lit: 0, shutterCol: 0x5a4030, flowerbox: false });
      o.chimneyX = null;
      break;
    case 'farm':
    case 'house':
      if (c.rng.chance(role === 'farm' ? 0.5 : 0.18)) o.porch = { depth: 1.8 * c.s, surf: Surf.Planks, col: 0x8a6a48, postSurf: Surf.Timber, postCol: c.trim.col, roofSurf: c.roof.surf === Surf.Thatch ? Surf.Shingle : c.roof.surf, roofCol: c.roof.col };
      o.balcony = c.floors > 1 && c.wealth > 0.7 && c.rng.chance(0.4);
      break;
    case 'barracks':
      o.walls = [{ surf: Surf.StoneBrick, col: jitter(c.st.id === 'timber' ? 0xa09888 : c.wall.col, c.rng, 0.05), quoin: { surf: Surf.StoneBrick, col: 0x8a8274 } }];
      o.roof = roofLook(c, 'flat', { crenel: true, surf: Surf.StoneBrick, col: 0x8a8476 });
      break;
    case 'library':
      o.walls = [{ surf: Surf.StoneBrick, col: jitter(c.st.id === 'timber' ? 0xc4bcae : c.wall.col, c.rng, 0.04), quoin: { surf: Surf.Marble, col: 0xd8d2c4 } }];
      o.roof = roofLook(c, c.rng.chance(0.4) ? 'mansard' : 'hip', { surf: c.roof.surf === Surf.Thatch ? Surf.Slate : c.roof.surf, col: c.roof.surf === Surf.Thatch ? 0x4e5462 : c.roof.col });
      o.porch = { depth: 2.4 * c.s, surf: Surf.Marble, col: 0xd0cabc, postSurf: Surf.Marble, postCol: 0xe0dacc, roofSurf: Surf.Slate, roofCol: 0x4e5462 };
      o.win = windowLook(c, { shape: 'arch', h: 1.9 * c.s, lit: 2.6, glow: 0xffe0a0 });
      break;
    case 'watchtower':
      o.floors = 3;
      o.walls = [{ surf: Surf.StoneBrick, col: jitter(0x9a9284, c.rng, 0.05) }, { surf: Surf.StoneBrick, col: jitter(0x9a9284, c.rng, 0.05) }, wallLookTop(c)];
      o.roof = roofLook(c, 'flat', { crenel: true, surf: Surf.Planks, col: 0x7a6048 });
      o.win = windowLook(c, { shape: 'slit', lit: 1.5 });
      o.stairs = false;
      break;
    default:
      break;
  }
  const spec = shellSpec(c, o);
  const out = buildShell(k, spec);
  // Role decorations.
  if (role === 'temple') {
    bellTower(k, c, out);
    buttresses(k, c, out);
    // Rose window above the door.
    k.use(out.walls[0][0]);
    k.push(0, spec.storey * 0.62, c.d / 2 - spec.wallT / 2, 0);
    windowAt(k, 0, spec.wallT, { ...spec.win, shape: 'round', w: 1.6 * c.s, h: 1.6 * c.s, sill: 0, lit: 2.8, glow: 0xffc0a0 });
    k.pop();
  }
  if (role === 'smithy') leanTo(k, c, out);
  if (role === 'warehouse' || role === 'barn') hoist(k, c, out);
  if (role === 'hall' || role === 'barracks') {
    k.use(out.walls[0][0]);
    for (const sx of [-1, 1]) wallBanner(k, c, sx * (c.w / 2 - 1.2), out.wallTop - 0.3, c.d / 2, 0, c.s);
  }
  if (role === 'stable') {
    // Stall partitions along one side.
    k.use(out.found);
    const n = Math.floor((c.d - 2) / 2.4);
    for (let i = 0; i < n; i++) k.box(c.w / 2 - 1.6, 0, -c.d / 2 + 1.2 + i * 2.4, 2.6, 1.3, 0.1, Surf.Planks, 0x7a5a3a, { lod: 2 });
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

function wallLookTop(c: BuildCtx) {
  return { surf: Surf.Plaster, col: jitter(0xe8dcc0, c.rng, 0.04), frame: { surf: Surf.Timber, col: c.trim.col, braces: true, w: 0.18 } };
}
