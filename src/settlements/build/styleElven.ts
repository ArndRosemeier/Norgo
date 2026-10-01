/**
 * Elven architecture (style 'elven'): white marble halls framed by living-wood
 * columns with spiralling vines, steep leaf-shingle roofs swept out by flared
 * eave skirts with upturned tips, pointed-arch windows glowing pale cyan,
 * slender multi-spired temples, tapering mage towers wrapped in tendrils with
 * a crystal at the tip, and tree-houses: a living tree grows at a back corner
 * of the ground hall, carrying a canopy platform with a cabin reached by a
 * spiral stair around the trunk.
 */
import { deriveSeed } from '../../core/rng';
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, type BuildCtx, type StyleBuilder } from './common';
import { buildTimber } from './styleTimber';
import { eaveSkirt, gmin, lantern, leafCanopy, livingColumn, silBody } from './styleElvenUtil';

const LEAF = 0x5e9a48;

/** ~30% of elven homes are tree-houses (stable per building seed). */
export function isTreehouse(c: BuildCtx): boolean {
  return c.b.role === 'house' && !c.b.round && deriveSeed(c.b.seed, 'treehouse') % 100 < 26;
}

function marble(c: BuildCtx): number {
  return c.wall.surf === Surf.Marble ? c.wall.col : jitter(0xece9df, c.rng, 0.03);
}

/** Slender spire (round shaft + needle roof) standing on the ground at (x, z). */
function spire(k: Kit, c: BuildCtx, x: number, z: number, r: number, h: number, sup: number) {
  k.piece('spire', 'stone', [sup], 1);
  const col = marble(c);
  k.cyl(x, gmin(c) - 0.3, z, r * 1.25, r * 1.15, 0.8 - gmin(c), Surf.Marble, scaleHex(col, 0.92), { seg: 10 });
  k.cyl(x, 0.5, z, r * 1.1, r * 0.85, h - 0.5, Surf.Marble, col, { seg: 10 });
  k.col(x, 0, z, r * 2, h, r * 2, true);
  // Bands & slit windows.
  for (let y = 3; y < h - 1; y += 3.2) {
    k.cyl(x, y, z, r * 1.02, r * 1.02, 0.14, Surf.Bark, c.trim.col, { seg: 10, lod: 1 });
    k.box(x, y + 0.6, z + r * 0.9, 0.22, 1.1, 0.12, Surf.Window, 0x4a5a6a, { emit: c.st.glow, emitI: 2.4, night: true, lod: 1 });
  }
  k.cyl(x, h, z, r * 1.25, 0, r * 6.5, c.roof.surf, c.roof.col, { seg: 10 });
  k.cyl(x, h - 0.15, z, r * 1.3, r * 1.25, 0.15, Surf.Bark, c.trim.col, { seg: 10, lod: 1 });
  k.cyl(x, h + r * 6.3, z, 0.05, 0.0, 1.2, Surf.Metal, 0xd8c070, { seg: 5, lod: 1 });
}

/** Living tree with canopy platform, cabin and spiral stair (tree-house). */
function treeSide(c: BuildCtx): number {
  return deriveSeed(c.b.seed, 'treeside') & 1 ? 1 : -1;
}

function livingTree(k: Kit, c: BuildCtx, out: ShellOut) {
  const rng = c.rng;
  const s = c.s;
  const side = treeSide(c);
  const tx = side * (c.w / 2 + 0.6), tz = -(c.d / 2 + 0.6);
  const tr = (0.85 + rng.float() * 0.3) * s;
  const g = gmin(c) - 0.4;
  const P = out.ridge + 1.2; // platform height above the hall roof
  const top = P + 7 * s;
  const bark = jitter(0x8a7458, rng, 0.08);
  const tree = k.piece('tree', 'wood');
  // Trunk: four tapering segments with a gentle lean.
  let px = tx, pz = tz, py = g;
  for (let i = 0; i < 4; i++) {
    const nx = tx + rng.range(-0.25, 0.25), nz = tz + rng.range(-0.25, 0.25);
    const ny = g + ((top - g) * (i + 1)) / 4;
    k.pole(px, py, pz, nx, ny, nz, tr * (1 - i * 0.14), tr * (1 - (i + 1) * 0.14), Surf.Bark, bark, { seg: 10, smooth: true });
    px = nx; pz = nz; py = ny;
  }
  k.col(tx, g, tz, tr * 1.7, top - g, tr * 1.7, true);
  // Root flares.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng.range(-0.2, 0.2);
    k.pole(tx + Math.cos(a) * tr * 0.6, 1.4, tz + Math.sin(a) * tr * 0.6, tx + Math.cos(a) * tr * 2.3, g + 0.3, tz + Math.sin(a) * tr * 2.3, tr * 0.42, tr * 0.12, Surf.Bark, scaleHex(bark, 0.92), { seg: 6 });
  }
  // Branches with canopies.
  const nb = 4 + rng.int(0, 2);
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const by = P + 2 + rng.range(0, 4) * s;
    const len = rng.range(2.5, 4.5) * s;
    const ex = tx + Math.cos(a) * len, ez = tz + Math.sin(a) * len, ey = by + rng.range(1, 2.5);
    k.pole(tx, by, tz, ex, ey, ez, tr * 0.38, tr * 0.12, Surf.Bark, bark, { seg: 6 });
    leafCanopy(k, ex, ey + 0.6, ez, rng.range(1.8, 2.6) * s, LEAF, rng, 4);
  }
  leafCanopy(k, tx, top + 0.6, tz, 3.4 * s, LEAF, rng, 6);

  // Platform ring around the trunk.
  const pr = tr + 3.6 * s;
  const plat = k.piece('platform', 'wood', [tree], 1);
  k.cyl(tx, P - 0.22, tz, pr, pr, 0.22, Surf.Planks, jitter(0xa08460, rng, 0.06), { seg: 16 });
  k.col(tx, P - 0.22, tz, pr * 1.5, 0.22, pr * 1.5, true);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.pole(tx + Math.cos(a) * tr, P - 2.5, tz + Math.sin(a) * tr, tx + Math.cos(a) * (pr - 0.4), P - 0.2, tz + Math.sin(a) * (pr - 0.4), 0.1, 0.08, Surf.Bark, bark, { seg: 5, lod: 1 });
  }
  const nr = 22;
  for (let i = 0; i < nr; i++) {
    const a = (i / nr) * Math.PI * 2;
    k.box(tx + Math.cos(a) * (pr - 0.1), P, tz + Math.sin(a) * (pr - 0.1), 0.07, 1.0, 0.07, Surf.Bark, bark, { lod: 1 });
    const b2 = ((i + 1) / nr) * Math.PI * 2;
    k.beam(tx + Math.cos(a) * (pr - 0.1), P + 1.0, tz + Math.sin(a) * (pr - 0.1), tx + Math.cos(b2) * (pr - 0.1), P + 1.0, tz + Math.sin(b2) * (pr - 0.1), 0.07, Surf.Bark, bark, { lod: 1 });
  }
  // Cabin on the outer side of the platform.
  const ca = Math.atan2(tz, tx);
  const cr = 1.7 * s;
  const cx = tx + Math.cos(ca) * (tr + cr + 0.2), cz = tz + Math.sin(ca) * (tr + cr + 0.2);
  k.piece('wall', 'wood', [plat], 1);
  const ch = 2.5 * s;
  k.cyl(cx, P, cz, cr, cr * 0.94, ch, Surf.Plaster, marble(c), { seg: 12 });
  k.col(cx, P, cz, cr * 1.6, ch, cr * 1.6, true);
  for (let i = 0; i < 4; i++) {
    const a = ca + Math.PI / 2 + (i / 4) * Math.PI;
    k.boxC(cx + Math.cos(a) * cr, P + 1.35 * s, cz + Math.sin(a) * cr, 0.42, 0.95, 0.12, Surf.Window, 0x5a6878, { ry: Math.atan2(Math.cos(a), Math.sin(a)), emit: c.st.glow, emitI: 2.6, night: true, lod: 1 });
  }
  // Sweeping cabin roof: flared skirt + needle.
  k.cyl(cx, P + ch - 0.25, cz, cr + 0.9, cr + 0.15, 0.45, c.roof.surf, scaleHex(c.roof.col, 0.92), { seg: 12 });
  k.cyl(cx, P + ch + 0.2, cz, cr + 0.15, 0, cr * 2.6, c.roof.surf, c.roof.col, { seg: 12 });
  k.cyl(cx, P + ch + cr * 2.5, cz, 0.05, 0, 0.9, Surf.Metal, 0xd8c070, { seg: 5, lod: 1 });
  lantern(k, cx + Math.cos(ca + 1.2) * (cr + 0.5), P + ch - 0.9, cz + Math.sin(ca + 1.2) * (cr + 0.5), c.st.accent || 0xd8f0ff, s);

  // Spiral stair around the trunk from the ground to the platform.
  k.piece('stairs', 'wood', [tree], 1);
  const steps = Math.ceil(P / 0.3);
  const rise = P / steps;
  const a0 = Math.atan2(-tz, -tx) + Math.PI; // start facing away from the hall
  for (let i = 0; i < steps; i++) {
    const a = a0 + i * 0.32;
    const sx = tx + Math.cos(a) * (tr + 0.55), sz = tz + Math.sin(a) * (tr + 0.55);
    const yaw = Math.atan2(Math.cos(a), Math.sin(a)); // tread runs radially
    k.boxC(sx, i * rise + rise / 2, sz, 0.32, 0.08, 0.95, Surf.Planks, jitter(0xa08460, rng, 0.06), { ry: yaw });
    k.col(sx, i * rise + rise / 2 - 0.04, sz, 0.32, 0.08, 0.95, true, yaw);
    if (i % 2 === 0) k.pole(tx + Math.cos(a) * (tr + 1.0), i * rise, tz + Math.sin(a) * (tr + 1.0), tx + Math.cos(a) * (tr + 1.0), i * rise + 1.0, tz + Math.sin(a) * (tr + 1.0), 0.03, 0.03, Surf.Bark, bark, { seg: 4, lod: 1 });
  }
}

/** Rectangular elven hall/house/civic building. */
function elvenHall(k: Kit, c: BuildCtx, tree: boolean): Blueprint['interior'] {
  const role = c.b.role;
  const framed = c.rng.chance(0.45);
  const col = marble(c);
  const walls = [];
  for (let f = 0; f < c.floors; f++) {
    walls.push({
      surf: f === 0 || !c.st2 ? (c.wall.surf === Surf.Bark ? Surf.Marble : c.wall.surf) : c.st2.wall[0].surf,
      col: f === 0 || !c.st2 ? col : c.st2.wall[0].cols[0],
      frame: framed ? { surf: Surf.Bark, col: c.trim.col, braces: false, w: 0.16 * c.s } : undefined,
    });
  }
  const grand = role === 'temple' || role === 'hall' || role === 'library';
  const pitch = role === 'temple' ? 2.3 : c.rng.range(1.35, 2.0);
  const rl = roofLook(c, c.b.roof === 'gable' && !grand ? 'gable' : 'hip', { pitch, overhang: 0.18, finial: true, thick: 0.2, dormers: 0, crenel: false });
  const porch = role === 'hall' || role === 'library' || role === 'tavern' || (role === 'house' && c.rng.chance(0.25))
    ? { depth: 2.2 * c.s, surf: Surf.Marble, col: scaleHex(col, 0.92), postSurf: Surf.Bark, postCol: c.trim.col, roofSurf: rl.surf, roofCol: rl.col }
    : null;
  const spec = shellSpec(c, {
    walls,
    roof: rl,
    porch,
    storey: role === 'temple' ? Math.max(c.storey * 1.8, 5.8 * c.s) : role === 'hall' ? c.storey * 1.5 : c.storey,
    win: windowLook(c, role === 'temple' ? { h: 3.0 * c.s, w: 1.0 * c.s, sill: 1.4 * c.s, spacing: 3.2 * c.s, lit: 2.6 } : { shutterCol: null }),
    chimneySurf: Surf.Marble,
    chimneyCol: scaleHex(col, 0.9),
    balcony: c.floors > 1 && c.rng.chance(0.35),
  });
  const out = buildShell(k, spec);
  // Flared eave skirt (concave sweep).
  k.use(out.roof);
  eaveSkirt(k, c.w, out.topD, out.wallTop + 0.06, (0.9 + c.rng.float() * 0.5) * c.s, rl.surf, scaleHex(rl.col, 0.88), c.trim.col);
  // Living-wood columns at the corners.
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    if (tree && sz < 0 && sx === treeSide(c)) continue; // the tree stands at this corner
    k.piece('pillar', 'wood', [out.found], 1);
    livingColumn(k, sx * (c.w / 2 + 0.04), sz * (out.topD / 2 + 0.04), 0, out.wallTop + 0.25, 0.2 * c.s, jitter(c.trim.col, c.rng, 0.06), c.rng);
    k.col(sx * (c.w / 2 + 0.04), 0, sz * (out.topD / 2 + 0.04), 0.45 * c.s, out.wallTop, 0.45 * c.s, true);
  }
  // Lanterns flanking the door.
  if (spec.door) {
    k.use(out.walls[0][0]);
    for (const sx of [-1, 1]) lantern(k, spec.door.x + sx * (spec.door.w / 2 + 0.45), spec.door.h + 0.05, c.d / 2 + 0.3, c.st.glow, c.s);
  }
  if (role === 'temple') {
    for (const sx of [-1, 1]) spire(k, c, sx * (c.w / 2 + 0.2), c.d / 2 + 0.2, 0.85 * c.s, out.ridge + 2 * c.s, out.found);
    if (c.w > 9) spire(k, c, 0, -c.d / 2 - 0.3, 1.1 * c.s, out.ridge + 5 * c.s, out.found);
  } else if (role === 'library' || role === 'hall') {
    spire(k, c, (c.rng.sign() * c.w) / 2, -c.d / 2, 0.8 * c.s, out.ridge + 1.5 * c.s, out.found);
  }
  if (tree) livingTree(k, c, out);
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

/** Round, tapering tower wrapped in tendrils (mage towers, watchtowers, round civic buildings). */
function elvenTower(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const role = c.b.role;
  const tall = role === 'mage_tower';
  const watch = role === 'watchtower';
  const col = marble(c);
  const spec = roundSpec(c, {
    r: Math.min(c.w, c.d) / 2,
    taper: tall ? 0.72 : watch ? 0.84 : 0.92,
    seg: 14,
    walls: [{ surf: Surf.Marble, col }],
    roof: roofLook(c, 'conical', { pitch: tall ? 2.8 : watch ? 1.6 : 2.0, overhang: 0.4, finial: true, crenel: false }),
    platform: watch,
    win: windowLook(c, tall ? { lit: 3, glow: c.st.accent || 0xd8f0ff } : {}),
  });
  const out = buildRound(k, spec);
  const r = spec.r;
  // Secondary spires leaning on the main shaft.
  if (tall || c.rng.chance(0.4)) {
    const n = tall ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (0.65 + i * 0.7) + c.rng.range(-0.2, 0.2);
      spire(k, c, Math.sin(a) * (r + 0.35), Math.cos(a) * (r + 0.35), 0.6 * c.s, out.wallTop * c.rng.range(0.5, 0.75), out.found);
    }
  }
  // Tendrils spiralling up the tower.
  k.piece('deco', 'wood', [out.found], 1);
  const strands = tall ? 2 : 1;
  for (let sIdx = 0; sIdx < strands; sIdx++) {
    const ph = sIdx * Math.PI + c.rng.range(0, 1);
    const steps = Math.ceil(out.wallTop / 0.45);
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= steps; i++) {
      const y = (i / steps) * out.wallTop;
      const rr = r * (1 - (1 - spec.taper) * (y / out.wallTop)) + 0.08;
      const a = ph + y * 0.55;
      const p: [number, number, number] = [Math.sin(a) * rr, y, Math.cos(a) * rr];
      if (prev) k.pole(prev[0], prev[1], prev[2], p[0], p[1], p[2], 0.07, 0.06, Surf.Bark, c.trim.col, { seg: 4, lod: 1 });
      if (i % 5 === 2) k.sphere(p[0], p[1], p[2], 0.22, 0.14, 0.22, Surf.Leaf, jitter(LEAF, c.rng, 0.1), { seg: 6, lod: 1 });
      prev = p;
    }
  }
  if (tall) {
    // Floating crystal above the needle.
    k.use(out.roof);
    const glow = c.st.accent || 0x9fe8c8;
    k.sphere(0, out.ridge + 1.0, 0, 0.3, 0.55, 0.3, Surf.Crystal, glow, { emit: glow, emitI: 4, seg: 8 });
    k.light(0, out.ridge + 1.0, 0, glow, 4, 14, true, 0.1);
  }
  k.use(out.walls[0][0]);
  if (spec.door) for (const sx of [-1, 1]) lantern(k, sx * (spec.door.w / 2 + 0.4), spec.door.h, r + 0.3, c.st.glow, c.s);
  furnishAll(k, c, out);
  return interiorOf(c, out, true);
}

export const buildElven: StyleBuilder = (k, c) => {
  const role = c.b.role;
  if (role === 'market' || role === 'mill') return buildTimber(k, c);
  if (c.b.round || role === 'mage_tower' || role === 'watchtower') return elvenTower(k, c);
  return elvenHall(k, c, isTreehouse(c));
};

/** Far-LOD silhouettes: steep roofs, needle towers, tree-house canopies. */
export const silhouetteElven = (k: Kit, c: BuildCtx) => {
  const st = c.st;
  const H = (c.b.floors ?? 1) * st.storey * c.s * (c.b.role === 'temple' ? 1.9 : 1);
  const col = marble(c);
  if (c.b.round || c.b.role === 'mage_tower' || c.b.role === 'watchtower') {
    const r = c.w / 2;
    k.cyl(0, gmin(c), 0, r, r * 0.8, H - gmin(c), Surf.Marble, col, { seg: 8 });
    k.cyl(0, H - 0.1, 0, r * 0.8 + 0.4, 0, (r + 0.4) * 3.2, c.roof.surf, c.roof.col, { seg: 8 });
    k.box(0, H * 0.6, r * 0.95, 0.5, 0.8, 0.2, Surf.Window, 0x30384a, { emit: st.glow, emitI: 2.2, night: true });
    return;
  }
  const rh = Math.min(c.w, c.d) * 0.85;
  silBody(k, c, H, rh, 1, Surf.Marble, col, c.roof.surf, c.roof.col, st.glow);
  if (isTreehouse(c)) {
    const tx = treeSide(c) * (c.w / 2 + 0.6), tz = -(c.d / 2 + 0.6);
    const P = H + rh + 1.2;
    k.cyl(tx, gmin(c), tz, 1, 0.6, P + 7, Surf.Bark, 0x8a7458, { seg: 6 });
    k.cyl(tx, P - 0.2, tz, 4.4, 4.4, 0.3, Surf.Planks, 0xa08460, { seg: 8 });
    k.sphere(tx, P + 7.5, tz, 5, 3, 5, Surf.Leaf, LEAF, { seg: 8 });
    k.box(tx - treeSide(c) * 2.6, P + 1, tz, 0.5, 0.8, 0.5, Surf.Window, 0x30384a, { emit: st.glow, emitI: 2.2, night: true });
  }
  if (c.b.role === 'temple') for (const sx of [-1, 1]) k.cyl(sx * (c.w / 2 + 0.2), 0, c.d / 2 + 0.2, 1, 0.8, H + rh + 2, Surf.Marble, col, { seg: 6 });
};
