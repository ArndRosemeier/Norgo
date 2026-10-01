/**
 * Sylvan architecture (style 'sylvan'): homes are giant mushrooms — a pale
 * stem as the round wall with round windows and an arched door, crowned by a
 * huge spotted cap with a glowing gill ring and smaller sibling mushrooms —
 * or root dwellings: turf domes held by arching roots. Civic buildings are
 * hollow tree stumps with jagged bark crowns, mossy roofs sprouting
 * mushrooms, shelf fungi and buttress roots. Everything glows softly at night.
 */
import { deriveSeed } from '../../core/rng';
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell } from './shell';
import { buildRound } from './round';
import { doorLook, furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, type BuildCtx, type StyleBuilder } from './common';
import { buildTimber } from './styleTimber';
import { gmin, lantern, leafCanopy, miniMushroom, mushroomCap } from './styleElvenUtil';

const MOSS = 0x5a7a34;

function isRootDwelling(c: BuildCtx) {
  return deriveSeed(c.b.seed, 'root') % 100 < 30;
}

function glowOf(c: BuildCtx) {
  return c.st.accent || 0x60ffc0;
}

function stemCol(c: BuildCtx) {
  return c.wall.surf === Surf.Mushroom ? c.wall.col : jitter(0xece4d2, c.rng, 0.04);
}

/** Arched glowing trim over a round building's door; R = outer radius of the front wall. */
function doorArch(k: Kit, c: BuildCtx, R: number, w: number, h: number) {
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    k.boxC(Math.cos(a) * (w / 2 + 0.1), h + Math.sin(a) * (w / 2 + 0.1) * 0.8, R + 0.04, 0.26, 0.16, 0.12, Surf.Bark, c.trim.col, { rz: a - Math.PI / 2, lod: 1 });
  }
  k.cyl(0, h + 0.02, R - 0.02, w / 2, w / 2, 0.06, Surf.Glow, glowOf(c), { rx: Math.PI / 2, seg: 10, sz: 0.8, emit: glowOf(c), emitI: 1.4, night: true, lod: 1 });
}

/** Round mushroom house or root dwelling. */
function mushroomHome(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const rng = c.rng;
  const root = isRootDwelling(c) || c.b.role === 'barn';
  const r = c.w / 2;
  const glow = glowOf(c);
  const bark = jitter(0x6a5640, rng, 0.08);
  const door = doorLook(c, { x: 0, w: 1.15 * c.s, h: 2.2 * c.s, col: jitter(0x6a5a3a, rng, 0.1), bands: false });
  const spec = roundSpec(c, {
    seg: 14,
    taper: root ? 1 : 0.9,
    walls: [{ surf: root ? Surf.Bark : Surf.Mushroom, col: root ? bark : stemCol(c) }],
    roof: roofLook(c, root ? 'dome' : 'flat', { surf: root ? Surf.Turf : c.roof.surf, col: root ? jitter(MOSS, rng, 0.08) : c.roof.col, pitch: 0.75, overhang: 0.25, trimSurf: Surf.Bark, trimCol: bark, finial: false }),
    door,
    win: windowLook(c, { shape: 'round', glow: c.st.glow }),
  });
  const out = buildRound(k, spec);
  // Outer radius of the ground storey (round.ts tapers per storey).
  const r0 = (r * (2 - (1 - spec.taper) / Math.max(1, spec.floors))) / 2;
  k.use(out.walls[0][0]);
  doorArch(k, c, r0, Math.min(door.w, 2 * r * Math.sin(Math.PI / spec.seg) - 0.3), door.h);
  k.use(out.roof);
  if (!root) {
    const R = r * rng.range(1.45, 1.75), H = r * rng.range(0.75, 1.1);
    mushroomCap(k, 0, out.wallTop - 0.1, 0, R, H, c.roof.col, glow, rng, 10);
    k.light(0, out.wallTop - 0.6, r + 0.6, glow, 2.5, 7, true, 0.05);
  } else {
    // Arching roots over the turf dome, a sapling on top.
    const apex = out.ridge;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.5) continue;
      const bx = Math.sin(a) * (r + 1.3), bz = Math.cos(a) * (r + 1.3);
      const mx = Math.sin(a) * (r + 0.15), mz = Math.cos(a) * (r + 0.15);
      k.pole(bx, gmin(c) - 0.2, bz, mx, out.wallTop * 0.8, mz, 0.32, 0.22, Surf.Bark, bark, { seg: 6 });
      k.pole(mx, out.wallTop * 0.8, mz, Math.sin(a) * 0.4, apex - 0.1, Math.cos(a) * 0.4, 0.22, 0.12, Surf.Bark, bark, { seg: 6 });
    }
    k.pole(0, apex - 0.2, 0, 0.1, apex + 2.2, 0, 0.14, 0.06, Surf.Bark, bark, { seg: 5, lod: 1 });
    leafCanopy(k, 0.1, apex + 2.6, 0, 1.0, 0x4e8a40, rng, 4);
  }
  // Sibling mushrooms and glow clusters around the base (never in front of the door).
  k.piece('deco', 'plant', [out.found], 1);
  const sib = rng.chance(0.6) && !root;
  if (sib) {
    const a = rng.range(1.6, 4.6);
    const sx = Math.sin(a) * (r + 0.55), sz = Math.cos(a) * (r + 0.55);
    const h = out.wallTop * rng.range(0.55, 0.8);
    k.cyl(sx, gmin(c), sz, 0.5 * c.s, 0.4 * c.s, h - gmin(c), Surf.Mushroom, stemCol(c), { seg: 10 });
    mushroomCap(k, sx, h, sz, r * 0.75, r * 0.5, jitter(c.roof.col, rng, 0.15), glow, rng, 5);
    k.col(sx, gmin(c), sz, 1, h - gmin(c), 1, true);
  }
  for (let i = 0; i < 4; i++) {
    const a = rng.range(1.1, 5.2);
    miniMushroom(k, Math.sin(a) * (r + 0.6), 0, Math.cos(a) * (r + 0.6), rng.range(0.6, 1.1) * c.s, jitter(c.roof.col, rng, 0.2), glow, rng);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out, true);
}

/** Hollow tree-stump hall for civic and rectangular roles. */
function stumpHall(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const rng = c.rng;
  const role = c.b.role;
  const glow = glowOf(c);
  const bark = jitter(0x5e4c3a, rng, 0.08);
  const spec = shellSpec(c, {
    walls: [{ surf: Surf.Bark, col: bark }],
    storey: role === 'temple' ? c.storey * 1.7 : role === 'hall' ? c.storey * 1.4 : c.storey,
    floors: role === 'temple' || role === 'hall' ? 1 : c.floors,
    roof: roofLook(c, 'flat', { surf: Surf.Turf, col: jitter(MOSS, rng, 0.08), crenel: false, trimSurf: Surf.Bark, trimCol: scaleHex(bark, 0.85) }),
    win: windowLook(c, { shape: 'round', glow: c.st.glow, shutterCol: null }),
    chimneySurf: Surf.Rubble,
    chimneyCol: 0x7a7468,
    porch: null,
  });
  const out = buildShell(k, spec);
  const W = c.w, D = out.topD;
  const top = out.wallTop + 0.3 + 0.6;
  k.use(out.roof);
  // Jagged bark crown around the parapet.
  for (const [len, horiz] of [[W, true], [D, false]] as const) {
    for (const sgn of [-1, 1]) {
      for (let u = -len / 2 + 0.45; u < len / 2; u += rng.range(0.6, 1.1)) {
        const x = horiz ? u : sgn * (W / 2 - 0.15), z = horiz ? sgn * (D / 2 - 0.15) : u;
        k.frustum(x, top - 0.05, z, 0.6, 0.4, 0.06, 0.06, rng.range(0.35, 1.5), Surf.Bark, jitter(bark, rng, 0.06), { lod: 1, rz: rng.range(-0.15, 0.15) });
      }
    }
  }
  // Mushrooms sprouting from the mossy roof.
  const n = role === 'temple' ? 1 : rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const big = role === 'temple' || role === 'hall';
    const x = big ? 0 : rng.range(-W / 4, W / 4), z = big ? 0 : rng.range(-D / 4, D / 4);
    const h = (big ? 5 : rng.range(1.5, 3.2)) * c.s;
    const R = big ? Math.min(W, D) * 0.48 : rng.range(1.0, 1.8) * c.s;
    k.cyl(x, out.wallTop + 0.3, z, R * 0.22, R * 0.17, h, Surf.Mushroom, stemCol(c), { seg: 10 });
    mushroomCap(k, x, out.wallTop + 0.3 + h, z, R, R * 0.55, jitter(c.st.roof[0].cols[i % c.st.roof[0].cols.length], rng, 0.08), glow, rng, big ? 14 : 6);
    k.light(x, out.wallTop + h * 0.8, z, glow, big ? 5 : 2.5, big ? 14 : 8, true, 0.05);
  }
  // Buttress roots at the corners, shelf fungi on the walls.
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    k.piece('pillar', 'wood', [out.found], 1);
    const cx = sx * (W / 2), cz = sz * (D / 2);
    for (let j = 0; j < 2; j++) {
      const ox = j ? sx * 1.6 : sx * 0.6, oz = j ? sz * 0.6 : sz * 1.6;
      k.pole(cx, out.wallTop * 0.6, cz, cx + ox, gmin(c) - 0.2, cz + oz, 0.4 * c.s, 0.18, Surf.Bark, scaleHex(bark, 0.92), { seg: 6 });
    }
    k.col(cx, gmin(c), cz, 1.2, out.wallTop * 0.6 - gmin(c), 1.2, true);
  }
  k.piece('deco', 'plant', [out.found], 1);
  for (let i = 0; i < 6; i++) {
    const side = rng.int(1, 3); // never on the front wall
    const y = rng.range(1.0, out.wallTop - 0.6);
    const u = rng.range(-0.35, 0.35);
    const [x, z, yaw] = side === 1 ? [W / 2, u * D, Math.PI / 2] : side === 2 ? [u * W, -D / 2, Math.PI] : [-W / 2, u * D, -Math.PI / 2];
    k.push(x, y, z, yaw);
    k.sphere(0, 0, 0.05, 0.7 * c.s, 0.14, 0.45 * c.s, Surf.Mushroom, jitter(0xd8a860, rng, 0.15), { lat0: 0, lat1: Math.PI / 2, seg: 10, lod: 1 });
    k.cyl(0, -0.02, 0.05, 0.62 * c.s, 0.62 * c.s, 0.03, Surf.Glow, glow, { seg: 10, sz: 0.62, emit: glow, emitI: 1.2, night: true, lod: 1 });
    k.pop();
  }
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, Math.PI * 2);
    const x = Math.sin(a) * (W / 2 + 0.7), z = Math.cos(a) * (D / 2 + 0.7);
    if (z > D / 2 && Math.abs(x - c.doorX) < 2) continue;
    miniMushroom(k, x, 0, z, rng.range(0.6, 1.2) * c.s, jitter(c.roof.col, rng, 0.2), glow, rng);
  }
  if (spec.door) {
    k.use(out.walls[0][0]);
    for (const sx of [-1, 1]) lantern(k, spec.door.x + sx * (spec.door.w / 2 + 0.45), spec.door.h + 0.1, c.d / 2 + 0.3, glow, c.s);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

/** Tall mushroom tower (mage towers, watchtowers). */
function mushroomTower(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const rng = c.rng;
  const watch = c.b.role === 'watchtower';
  const glow = glowOf(c);
  const spec = roundSpec(c, {
    r: Math.min(c.w, c.d) / 2,
    seg: 14,
    taper: 0.84,
    walls: [{ surf: Surf.Mushroom, col: stemCol(c) }],
    roof: roofLook(c, 'flat', { surf: c.roof.surf, col: c.roof.col, crenel: false }),
    platform: watch,
    win: windowLook(c, { shape: 'round', lit: 3, glow }),
  });
  const out = buildRound(k, spec);
  const rt = spec.r * spec.taper;
  k.use(out.roof);
  if (watch) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      k.pole(Math.sin(a) * (rt - 0.2), out.wallTop, Math.cos(a) * (rt - 0.2), Math.sin(a) * (rt - 0.5), out.wallTop + 2.6, Math.cos(a) * (rt - 0.5), 0.1, 0.08, Surf.Bark, c.trim.col, { seg: 5 });
    }
    mushroomCap(k, 0, out.wallTop + 2.6, 0, rt + 1.2, (rt + 1) * 0.5, c.roof.col, glow, rng, 8);
  } else {
    mushroomCap(k, 0, out.wallTop, 0, rt * 1.9, rt * 1.1, c.roof.col, glow, rng, 12);
    k.light(0, out.ridge + rt, 0, glow, 4, 14, true, 0.05);
  }
  // Shelf fungi rings up the stem.
  k.piece('deco', 'plant', [out.found], 1);
  for (const f of [0.35, 0.65]) {
    const y = out.wallTop * f;
    const rr = spec.r * (1 - (1 - spec.taper) * f);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + f * 3;
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.4 && y < 3) continue;
      k.push(Math.sin(a) * rr, y, Math.cos(a) * rr, a);
      k.sphere(0, 0, 0.1, 0.75 * c.s, 0.16, 0.5 * c.s, Surf.Mushroom, jitter(0xc89a60, rng, 0.12), { lat0: 0, lat1: Math.PI / 2, seg: 9, lod: 1 });
      k.cyl(0, -0.02, 0.1, 0.65 * c.s, 0.65 * c.s, 0.03, Surf.Glow, glow, { seg: 9, sz: 0.66, emit: glow, emitI: 1.4, night: true, lod: 1 });
      k.pop();
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = rng.range(1.0, 5.3);
    miniMushroom(k, Math.sin(a) * (spec.r + 0.6), 0, Math.cos(a) * (spec.r + 0.6), rng.range(0.7, 1.2) * c.s, jitter(c.roof.col, rng, 0.2), glow, rng);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out, true);
}

export const buildSylvan: StyleBuilder = (k, c) => {
  const role = c.b.role;
  if (role === 'market' || role === 'mill') return buildTimber(k, c);
  if (role === 'mage_tower' || role === 'watchtower') return mushroomTower(k, c);
  if (c.b.round) return mushroomHome(k, c);
  return stumpHall(k, c);
};

/** Far LOD: stems with caps, stumps with a roof mushroom. */
export const silhouetteSylvan = (k: Kit, c: BuildCtx) => {
  const H = (c.b.floors ?? 1) * c.st.storey * c.s;
  const g = gmin(c);
  const glow = c.st.glow;
  if (c.b.round || c.b.role === 'mage_tower' || c.b.role === 'watchtower') {
    const r = c.w / 2;
    const tower = c.b.role === 'mage_tower' || c.b.role === 'watchtower';
    const root = !tower && isRootDwelling(c);
    k.cyl(0, g, 0, r, r * 0.9, H - g, root ? Surf.Bark : Surf.Mushroom, root ? 0x6a5640 : 0xece4d2, { seg: 8 });
    if (root) k.sphere(0, H, 0, r, r * 0.75, r, Surf.Turf, MOSS, { lat0: 0, lat1: Math.PI / 2, seg: 8 });
    else k.sphere(0, H, 0, r * (tower ? 1.8 : 1.6), r * 0.95, r * (tower ? 1.8 : 1.6), Surf.Mushroom, c.roof.col, { lat0: 0, lat1: Math.PI / 2 + 0.2, seg: 10 });
    k.box(0, 1.2 * c.s, r, 0.6, 0.6, 0.1, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true });
    return;
  }
  k.box(0, g, 0, c.w, H + 0.9 - g, c.d, Surf.Bark, 0x5e4c3a);
  const R = Math.min(c.w, c.d) * 0.35;
  k.cyl(0, H, 0, R * 0.2, R * 0.2, 3, Surf.Mushroom, 0xece4d2, { seg: 6 });
  k.sphere(0, H + 3, 0, R, R * 0.5, R, Surf.Mushroom, c.roof.col, { lat0: 0, lat1: Math.PI / 2, seg: 8, emit: c.st.accent, emitI: 0.4, night: true });
  k.box(0, 1.2 * c.s, c.d / 2 + 0.02, 0.7, 0.7, 0.06, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true });
};
