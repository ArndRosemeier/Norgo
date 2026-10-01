/**
 * Umbral architecture (style 'umbral'): dark basalt with violet undertones,
 * sharp angular forms — battered walls with blade-like buttress fins, steep
 * needle roofs, pointed arches glowing violet — and dark crystal growing
 * through everything: hexagonal spires jutting from roof corners and walls,
 * crystal bands at the eaves, and shards floating above towers and temples.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, type BuildCtx, type StyleBuilder } from './common';
import { buildTimber } from './styleTimber';
import { crystalSpire, gmin, shard, silBody } from './styleElvenUtil';

function glowOf(c: BuildCtx) {
  return c.st.accent || 0x9a50ff;
}

function crystalCol(c: BuildCtx) {
  return jitter(0x5a3e8a, c.rng, 0.1);
}

function stone(c: BuildCtx) {
  return c.wall.surf === Surf.Crystal ? { surf: Surf.Basalt, col: jitter(0x3a3444, c.rng, 0.05) } : c.wall;
}

/** Angular hall: battered walls, fins, steep pyramid/needle roof with crystal spires. */
function umbralHall(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const rng = c.rng;
  const role = c.b.role;
  const glow = glowOf(c);
  const st = stone(c);
  const walls = [];
  for (let f = 0; f < c.floors; f++) walls.push({ surf: st.surf, col: f % 2 ? scaleHex(st.col, 1.08) : st.col, quoin: { surf: Surf.Basalt, col: scaleHex(st.col, 0.8) } });
  const pitch = role === 'temple' ? 2.6 : rng.range(1.6, 2.4);
  const rl = roofLook(c, 'hip', { pitch, overhang: 0.3, finial: false, thick: 0.2, crenel: false, trimSurf: Surf.Crystal, trimCol: crystalCol(c) });
  const spec = shellSpec(c, {
    walls,
    roof: rl,
    storey: role === 'temple' ? Math.max(c.storey * 1.8, 5.8 * c.s) : role === 'hall' ? c.storey * 1.5 : c.storey,
    win: windowLook(c, { shape: 'pointed', glow: c.st.glow, shutterCol: null, flowerbox: false, ...(role === 'temple' ? { h: 3.2 * c.s, sill: 1.4 * c.s, spacing: 3 * c.s, lit: 3 } : {}) }),
    chimneySurf: Surf.Basalt,
    chimneyCol: scaleHex(st.col, 0.85),
  });
  const out = buildShell(k, spec);
  const W = c.w, D = out.topD;
  // Glowing crystal band at the eaves + crystal spires at the roof corners.
  k.use(out.roof);
  for (const [sx, sz, rot] of [[0, 1, 0], [0, -1, 0], [1, 0, 1], [-1, 0, 1]] as const) {
    if (rot) k.box(sx * (W / 2 + 0.06), out.wallTop - 0.35, 0, 0.08, 0.12, D, Surf.Crystal, crystalCol(c), { emit: glow, emitI: 1.1, night: true, lod: 1 });
    else k.box(0, out.wallTop - 0.35, sz * (D / 2 + 0.06), W, 0.12, 0.08, Surf.Crystal, crystalCol(c), { emit: glow, emitI: 1.1, night: true, lod: 1 });
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    if (!rng.chance(role === 'house' ? 0.6 : 0.9)) continue;
    const len = rng.range(1.6, 3.2) * c.s;
    crystalSpire(k, sx * (W / 2 + 0.1), out.wallTop - 0.2, sz * (D / 2 + 0.1), len, 0.22 * c.s, sz * 0.45, -sx * 0.45, crystalCol(c), glow);
  }
  // Floating shard above the apex.
  shard(k, 0, out.ridge + 1.3, 0, (role === 'temple' ? 2.4 : 1.1) * c.s, scaleHex(crystalCol(c), 1.3), glow, 0, role === 'temple' ? 0 : 1);
  k.light(0, out.ridge + 1.5, 0, glow, role === 'temple' ? 6 : 3, role === 'temple' ? 16 : 9, true, 0.1);
  // Blade fins along the long walls.
  for (const sx of [-1, 1]) {
    k.use(out.walls[0][sx > 0 ? 1 : 3]);
    const n = Math.max(1, Math.floor(D / 3.6));
    for (let i = 0; i < n; i++) {
      const z = -D / 2 + ((i + 0.5) * D) / n;
      k.frustum(sx * (W / 2 + 0.4), 0, z, 0.8, 0.28, 0.05, 0.22, out.wallTop * rng.range(0.75, 1.0), Surf.Basalt, scaleHex(st.col, 0.85), { ox: -sx * 0.38, lod: 1 });
    }
  }
  // Crystal clusters bursting from the ground at a corner.
  k.piece('deco', 'crystal', [out.found], 1);
  const cs = rng.sign();
  for (let i = 0; i < 4; i++) {
    crystalSpire(k, cs * (W / 2 + 0.4) + rng.range(-0.4, 0.4), -0.2, -D / 2 + rng.range(0.2, 1.4), rng.range(0.8, 2.2) * c.s, 0.18 * c.s, rng.range(-0.4, 0.4), rng.range(-0.4, 0.4), crystalCol(c), glow, 1);
  }
  if (role === 'temple') {
    // A great crystal piercing the nave roof.
    k.piece('spire', 'crystal', [out.found], 1);
    crystalSpire(k, 0, 0.2, -D * 0.15, out.ridge + 6 * c.s, 0.9 * c.s, -0.08, 0.05, crystalCol(c), glow);
    k.col(0, 0, -D * 0.15, 1.6 * c.s, out.ridge + 4, 1.6 * c.s, true);
  }
  // Brazier-like crystal lamps flanking the door.
  if (spec.door) {
    k.use(out.walls[0][0]);
    for (const sx of [-1, 1]) {
      const x = spec.door.x + sx * (spec.door.w / 2 + 0.5);
      k.box(x, spec.door.h - 0.2, c.d / 2 + 0.12, 0.12, 0.12, 0.25, Surf.Metal, 0x2a2430, { lod: 1 });
      shard(k, x, spec.door.h + 0.15, c.d / 2 + 0.28, 0.35, crystalCol(c), glow, 0, 1);
      k.light(x, spec.door.h + 0.2, c.d / 2 + 0.5, glow, 2.5, 7, true, 0.1);
    }
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

/** Needle tower with a ring of floating shards. */
function umbralTower(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const rng = c.rng;
  const role = c.b.role;
  const watch = role === 'watchtower';
  const glow = glowOf(c);
  const st = stone(c);
  const spec = roundSpec(c, {
    r: Math.min(c.w, c.d) / 2,
    seg: role === 'mage_tower' ? 6 : 8,
    taper: role === 'mage_tower' ? 0.7 : 0.82,
    walls: [{ surf: st.surf, col: st.col }],
    roof: roofLook(c, 'conical', { pitch: role === 'mage_tower' ? 3.2 : 2.2, overhang: 0.3, finial: true, crenel: false, trimSurf: Surf.Crystal, trimCol: crystalCol(c) }),
    platform: watch,
    win: windowLook(c, { shape: 'pointed', lit: 3, glow: c.st.glow }),
  });
  const out = buildRound(k, spec);
  const rt = spec.r * spec.taper;
  k.use(out.roof);
  const n = role === 'mage_tower' ? 6 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(0, 0.4);
    shard(k, Math.sin(a) * (rt + 1.6), out.wallTop + rng.range(0.5, 2.5), Math.cos(a) * (rt + 1.6), rng.range(0.5, 0.9) * c.s, crystalCol(c), glow, rng.range(-0.3, 0.3));
  }
  shard(k, 0, out.ridge + 1.6, 0, 1.4 * c.s, scaleHex(crystalCol(c), 1.3), glow, 0, 0);
  k.light(0, out.ridge + 1.6, 0, glow, 5, 16, true, 0.1);
  // Crystal ribs climbing the shaft.
  k.piece('deco', 'crystal', [out.found], 1);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    crystalSpire(k, Math.sin(a) * (spec.r + 0.1), -0.2, Math.cos(a) * (spec.r + 0.1), out.wallTop * rng.range(0.3, 0.55), 0.25 * c.s, Math.cos(a) * 0.12, -Math.sin(a) * 0.12, crystalCol(c), glow, 1);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out, true);
}

export const buildUmbral: StyleBuilder = (k, c) => {
  const role = c.b.role;
  if (role === 'market' || role === 'mill') return buildTimber(k, c);
  if (c.b.round || role === 'mage_tower' || role === 'watchtower') return umbralTower(k, c);
  return umbralHall(k, c);
};

/** Far LOD: dark blocks under needle roofs with a glowing shard on top. */
export const silhouetteUmbral = (k: Kit, c: BuildCtx) => {
  const H = (c.b.floors ?? 1) * c.st.storey * c.s * (c.b.role === 'temple' ? 1.8 : 1);
  const st = stone(c);
  const glow = glowOf(c);
  if (c.b.round || c.b.role === 'mage_tower' || c.b.role === 'watchtower') {
    const r = c.w / 2;
    k.cyl(0, gmin(c), 0, r, r * 0.75, H - gmin(c), st.surf, st.col, { seg: 6 });
    k.cyl(0, H, 0, r * 0.8 + 0.3, 0, (r + 0.3) * 4, c.roof.surf, c.roof.col, { seg: 6 });
    k.cyl(0, H + (r + 0.3) * 4 + 0.6, 0, 0.5, 0, 1.6, Surf.Crystal, 0x5a3e8a, { seg: 5, emit: glow, emitI: 2.5 });
    return;
  }
  const rh = Math.min(c.w, c.d) * 0.5 * 2.1;
  silBody(k, c, H, rh, 1, st.surf, st.col, c.roof.surf, c.roof.col, c.st.glow);
  k.cyl(0, H + rh + 0.8, 0, 0.4, 0, 1.4, Surf.Crystal, 0x5a3e8a, { seg: 5, emit: glow, emitI: 2.5 });
};
