/**
 * Infrastructure: wells (per culture), bridges where roads cross water
 * (timber trestles or stone arches, sectioned into destructible spans with
 * piers down to the riverbed) and fishing piers on shores.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import type { BuildCtx } from './common';

export function buildWell(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const s = c.s;
  const r = 0.95 * s;
  const st = c.st.id;
  const stoneSurf = st === 'elven' ? Surf.Marble : st === 'drakeborn' || st === 'umbral' ? Surf.Basalt : Surf.Rubble;
  const stoneCol = st === 'elven' ? 0xe0ded4 : st === 'drakeborn' ? 0x3a3432 : st === 'umbral' ? 0x34303e : jitter(0x9a968c, c.rng, 0.06);
  k.piece('foundation', 'stone');
  k.cyl(0, -1.5, 0, r, r, 2.4, stoneSurf, stoneCol, { seg: 12 });
  k.cyl(0, 0.9, 0, r + 0.08, r + 0.08, 0.12, stoneSurf, scaleHex(stoneCol, 0.9), { seg: 12, lod: 1 });
  k.cyl(0, 0.6, 0, r - 0.2, r - 0.2, 0.05, Surf.Window, 0x1a2a34, { seg: 12 });
  k.col(0, 0, 0, r * 2, 1.0, r * 2, true);
  const roof = k.piece('roof', st === 'orcish' || st === 'goblin' ? 'wood' : 'wood', [0], 1);
  if (st === 'sylvan') {
    k.cyl(0, 0, -r - 0.2, 0.15, 0.12, 2.6, Surf.Mushroom, 0xe8e0d0, { seg: 8 });
    k.sphere(0, 2.6, -r * 0.4, 1.3, 0.6, 1.3, Surf.Mushroom, 0x3a8a7a, { lat0: 0, lat1: Math.PI / 2 + 0.2, seg: 12 });
    k.cyl(0, 2.45, -r * 0.4, 1.0, 1.0, 0.04, Surf.Glow, 0x60ffc0, { emit: 0x60ffc0, emitI: 2, seg: 12 });
    k.light(0, 2.2, 0, 0x60ffc0, 3, 8, true, 0.05);
  } else if (st === 'megalith' || st === 'stonekeep') {
    for (const sx of [-1, 1]) k.box(sx * (r + 0.15), 0, 0, 0.45, 2.4 * s, 0.6, Surf.StoneBrick, scaleHex(stoneCol, 0.95));
    k.box(0, 2.4 * s, 0, 2 * r + 1, 0.4, 1.2, Surf.StoneBrick, stoneCol);
    k.cyl(-r, 1.7 * s, 0, 0.1, 0.1, 2 * r, Surf.Timber, 0x5a4430, { rz: -Math.PI / 2, seg: 6, lod: 1 });
  } else {
    const wood = st === 'elven' ? 0x8a7458 : 0x5a4430;
    for (const sx of [-1, 1]) k.box(sx * (r + 0.05), 0.9, 0, 0.14, 1.7 * s, 0.14, Surf.Timber, wood);
    k.cyl(-r, 1.85 * s, 0, 0.09, 0.09, 2 * r, Surf.Timber, wood, { rz: -Math.PI / 2, seg: 6, lod: 1 });
    k.box(r + 0.25, 1.75 * s, 0, 0.06, 0.06, 0.4, Surf.Timber, wood, { lod: 1 });
    // Small gable roof.
    const rs = st === 'orcish' ? Surf.Hide : st === 'elven' ? Surf.Shingle : st === 'goblin' ? Surf.Metal : Surf.Shingle;
    const rc = st === 'elven' ? 0x4e7a5a : st === 'goblin' ? 0x8a5a3a : 0x6a4e38;
    for (const sz of [1, -1]) k.boxC(0, 2.75 * s, sz * 0.45, 2 * r + 0.8, 0.08, 1.3, rs, rc, { rx: sz * 0.7 });
    // Bucket on the rope.
    k.box(0, 1.15 * s, 0, 0.02, 0.7 * s, 0.02, Surf.Rope, 0x8a6a3a, { lod: 1 });
    k.cyl(0, 0.95 * s, 0, 0.16, 0.19, 0.24, Surf.Planks, 0x7a5a3a, { seg: 8, lod: 1 });
  }
  if (st === 'drakeborn') {
    k.cyl(r + 0.5, 0, r + 0.5, 0.12, 0.12, 1.2, Surf.Metal, 0x2a2624, { seg: 6 });
    k.cyl(r + 0.5, 1.2, r + 0.5, 0.25, 0.35, 0.25, Surf.Metal, 0x3a2e28, { seg: 8 });
    k.cyl(r + 0.5, 1.45, r + 0.5, 0.3, 0.02, 0.6, Surf.Fire, 0xffb050, { emit: 0xff6a10, emitI: 5, seg: 6 });
    k.light(r + 0.5, 1.8, r + 0.5, 0xff8030, 4, 9, false, 1);
  }
  void roof;
  return null;
}

/** Bridge: local +z runs along the bridge, width = size[0], length = size[1]. */
export function buildBridge(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const W = c.b.size[0], L = c.b.size[1];
  const stone = c.st.id === 'stonekeep' || c.st.id === 'elven' || c.st.id === 'drakeborn' || c.st.id === 'umbral' || (c.st.id === 'timber' && L < 26 && c.rng.chance(0.6));
  const g = c.ground;
  const g0 = (g[0] + g[1]) / 2, g1 = (g[2] + g[3]) / 2;
  const bed = Math.min(g0, g1) - 4;
  const n = Math.max(1, Math.round(L / 6));
  const sec = L / n;
  const deckT = stone ? 0.6 : 0.25;
  const col = stone ? (c.st.id === 'elven' ? 0xd8d6cc : c.st.id === 'drakeborn' || c.st.id === 'umbral' ? scaleHex(c.base.col, 1.1) : jitter(0x9a948a, c.rng, 0.05)) : jitter(0x7a5a3a, c.rng, 0.06);
  const piers: number[] = [];
  // Abutments at both ends.
  for (const sz of [-1, 1]) {
    piers.push(k.piece('foundation', 'stone'));
    const gz = sz < 0 ? g0 : g1;
    k.solid(0, gz - 1, (sz * L) / 2 - sz * 1.2, W + 0.8, -gz + 1 - deckT, 2.4, Surf.Rubble, jitter(0x8a867c, c.rng, 0.05));
  }
  // Intermediate piers.
  for (let i = 1; i < n; i++) {
    piers.push(k.piece('pillar', stone ? 'stone' : 'wood'));
    const z = -L / 2 + i * sec;
    if (stone) {
      k.solid(0, bed, z, W * 0.8, -bed - deckT, 1.4, Surf.StoneBrick, col);
      // Cutwaters.
      for (const sx of [-1, 1]) k.frustum((sx * W * 0.8) / 2 + sx * 0.4, bed, z, 0.8, 1.4, 0.05, 1.4, -bed - deckT - 0.4, Surf.StoneBrick, scaleHex(col, 0.92), { ox: -sx * 0.4, lod: 1 });
    } else {
      for (const sx of [-1, 1]) {
        k.pole(sx * (W / 2 - 0.3), bed, z, sx * (W / 2 - 0.3), -deckT, z, 0.18, 0.18, Surf.Bark, 0x5a4430);
        k.col(sx * (W / 2 - 0.3), bed, z, 0.4, -bed - deckT, 0.4, true);
      }
      k.beam(-W / 2 + 0.3, bed + 1, z, W / 2 - 0.3, -deckT - 0.3, z, 0.12, Surf.Timber, 0x4a3424, { lod: 1 });
      k.box(0, -deckT - 0.3, z, W, 0.3, 0.3, Surf.Timber, 0x4a3424);
    }
  }
  // Deck spans, each carried by the piers at its ends.
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? piers[0] : piers[1 + i];
    const b = i === n - 1 ? piers[1] : piers[2 + i];
    k.piece('floor', stone ? 'stone' : 'wood', [a, b].filter((x) => x !== undefined), 1);
    const z = -L / 2 + (i + 0.5) * sec;
    if (stone) {
      k.solid(0, -deckT, z, W, deckT, sec + 0.02, Surf.StoneBrick, col);
      k.box(0, 0, z, W - 0.8, 0.03, sec, Surf.Cobble, 0x7a766c, { lod: 1 });
      // Arch soffit beneath.
      k.cyl(-W * 0.4, -deckT - sec * 0.25, z, sec * 0.42, sec * 0.42, W * 0.8, Surf.StoneBrick, scaleHex(col, 0.9), { rz: -Math.PI / 2, seg: 10, lod: 1 });
      for (const sx of [-1, 1]) k.solid((sx * (W - 0.4)) / 2, 0, z, 0.4, 0.9, sec + 0.02, Surf.StoneBrick, scaleHex(col, 0.95));
    } else {
      k.solid(0, -deckT, z, W, deckT, sec + 0.02, Surf.Planks, col);
      for (const sx of [-1, 1]) {
        k.box((sx * (W - 0.1)) / 2, 0.95, z, 0.1, 0.1, sec, Surf.Timber, 0x5a4430);
        k.box((sx * (W - 0.1)) / 2, 0, z - sec / 2 + 0.1, 0.12, 1.05, 0.12, Surf.Timber, 0x5a4430);
        k.col((sx * (W - 0.1)) / 2, 0, z, 0.12, 1.05, sec, true);
      }
    }
  }
  // Lamps at both ends.
  k.piece('deco', 'metal', [piers[0]], 1);
  for (const sz of [-1, 1]) {
    const z = (sz * L) / 2 - sz * 0.6;
    k.box(W / 2 - 0.25, 0, z, 0.12, 2.4, 0.12, Surf.Metal, 0x2e2c2a);
    k.cyl(W / 2 - 0.25, 2.4, z, 0.12, 0.12, 0.3, Surf.Window, 0xfff0c8, { seg: 6, emit: 0xffc070, emitI: 3, night: true });
    k.light(W / 2 - 0.25, 2.6, z, 0xffb060, 4, 10, true, 0.1);
  }
  return null;
}

/** Fishing pier: local +z points out over the water. */
export function buildDock(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const W = c.b.size[0], L = c.b.size[1];
  const g = c.ground;
  const n = Math.max(2, Math.round(L / 3));
  const sec = L / n;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const z = -L / 2 + (i + 0.5) * sec;
    const t = (i + 0.5) / n;
    const gz = (g[0] + g[1]) / 2 * (1 - t) + (g[2] + g[3]) / 2 * t - 0.5;
    const p = k.piece('floor', 'wood', prev >= 0 ? [prev] : [], prev >= 0 ? 0 : 0);
    k.solid(0, -0.18, z, W, 0.18, sec + 0.02, Surf.Planks, jitter(0x7a5a3a, c.rng, 0.06));
    for (const sx of [-1, 1]) {
      k.pole(sx * (W / 2 - 0.15), gz - 1, z + sec / 2 - 0.2, sx * (W / 2 - 0.15), 0.7, z + sec / 2 - 0.2, 0.13, 0.12, Surf.Bark, 0x4a3a2a);
      k.col(sx * (W / 2 - 0.15), gz - 1, z + sec / 2 - 0.2, 0.3, 1.7 - gz, 0.3, true);
    }
    k.box(0, -0.45, z, W, 0.2, 0.2, Surf.Timber, 0x4a3424, { lod: 1 });
    prev = p;
  }
  // End details: crates, rope coil, lantern post.
  k.piece('deco', 'wood', [prev], 1);
  k.box(-W / 2 + 0.5, 0, L / 2 - 0.8, 0.6, 0.6, 0.6, Surf.Planks, 0x8a6a48);
  k.cyl(W / 2 - 0.5, 0, L / 2 - 1.2, 0.3, 0.3, 0.12, Surf.Rope, 0x9a7a4a, { seg: 10, lod: 1 });
  k.box(W / 2 - 0.2, 0, L / 2 - 0.2, 0.12, 2.2, 0.12, Surf.Timber, 0x4a3424);
  k.cyl(W / 2 - 0.2, 2.2, L / 2 - 0.2, 0.12, 0.12, 0.3, Surf.Window, 0xfff0c8, { seg: 6, emit: 0xffc070, emitI: 3, night: true });
  k.light(W / 2 - 0.2, 2.4, L / 2 - 0.2, 0xffb060, 4, 10, true, 0.1);
  return null;
}
