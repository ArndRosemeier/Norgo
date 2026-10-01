/**
 * Fortifications per culture family: stone curtain walls with walkways and
 * crenellations (humans, dwarves, elves, drakeborn, umbral), sharpened-log
 * palisades with fighting platforms (orcs, goblins), thorn-root hedges
 * (sylvan), hedge-topped field walls (halflings) and megalith rings with
 * lintels (giantkin). Gatehouses with arches, portcullises and banners;
 * towers stone (round/square with crenellated tops) or timber platforms.
 *
 * Wall buildings: local x runs along the wall (length = size[0]), +z points
 * outward, thickness = size[1], height = size[2]. Each ~5 m section is its own
 * destructible piece.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildRound } from './round';
import { roofLook, roundSpec, windowLook, type BuildCtx } from './common';
import { heraldicPanel } from './heraldry';

type Family = 'stone' | 'palisade' | 'hedge' | 'megalith';

function family(c: BuildCtx): Family {
  switch (c.st.id) {
    case 'orcish':
    case 'goblin':
      return 'palisade';
    case 'sylvan':
    case 'burrow':
      return 'hedge';
    case 'megalith':
      return 'megalith';
    default:
      return 'stone';
  }
}

function stoneOf(c: BuildCtx): { surf: Surf; col: number } {
  if (c.st.id === 'timber') return { surf: Surf.StoneBrick, col: jitter(0xa8a090, c.rng, 0.04) };
  if (c.st.id === 'elven') return { surf: Surf.Marble, col: jitter(0xe4e2d8, c.rng, 0.03) };
  return c.wall.surf === Surf.Crystal || c.wall.surf === Surf.Plaster ? { surf: c.base.surf, col: c.base.col } : c.wall;
}

/** Wall segment between two towers/gates. */
export function buildWall(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const L = c.b.size[0], T = c.b.size[1], H = c.b.size[2];
  const fam = family(c);
  const n = Math.max(1, Math.round(L / 5));
  const sec = L / n;
  const g = c.ground;
  const gmin = Math.min(...g) - 0.8;
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + (i + 0.5) * sec;
    k.piece('wall', fam === 'palisade' ? 'wood' : fam === 'hedge' ? 'plant' : 'stone');
    switch (fam) {
      case 'stone': {
        const st = stoneOf(c);
        k.solid(x, gmin, 0, sec + 0.02, H - gmin, T, st.surf, st.col);
        // Walkway parapet on the outer edge with merlons; inner low rail.
        k.solid(x, H, T / 2 - 0.25, sec + 0.02, 1.0, 0.5, st.surf, st.col);
        for (let m = 0; m < Math.floor(sec / 1.2); m++) k.box(x - sec / 2 + 0.6 + m * 1.2, H + 1.0, T / 2 - 0.25, 0.6, 0.6, 0.5, st.surf, st.col, { lod: 1 });
        k.box(x, H, -T / 2 + 0.15, sec, 0.5, 0.3, st.surf, scaleHex(st.col, 0.95), { lod: 1 });
        // Plinth batter and string course.
        k.frustum(x, gmin, T / 2 + 0.2, sec + 0.02, 0.8, sec + 0.02, 0.1, -gmin + 1.2, st.surf, scaleHex(st.col, 0.9), { lod: 1, oz: -0.3 });
        k.box(x, H - 0.6, T / 2 + 0.05, sec, 0.18, 0.12, Surf.StoneBrick, scaleHex(st.col, 0.85), { lod: 1 });
        if (c.st.id === 'drakeborn' && i % 2 === 0) {
          k.box(x, H * 0.5, T / 2 + 0.06, 0.5, H * 0.4, 0.04, Surf.Fire, 0xff6a20, { emit: 0xff4a10, emitI: 1.5, lod: 1 });
        }
        if (c.st.id === 'umbral') k.cyl(x, H + 1.0, T / 2 - 0.25, 0.2, 0, 1.6, Surf.Crystal, 0x7a5ab0, { seg: 5, emit: 0x9a50ff, emitI: 1.4, lod: 1 });
        if (c.st.id === 'elven' && i % 2 === 1) k.pole(x - sec / 2, gmin, T / 2 + 0.15, x + sec / 2, H + 0.6, T / 2 + 0.15, 0.12, 0.05, Surf.Bark, 0x8a7458, { lod: 1, seg: 6 });
        break;
      }
      case 'palisade': {
        const logs = Math.ceil(sec / 0.42);
        for (let j = 0; j < logs; j++) {
          const lx = x - sec / 2 + (j + 0.5) * (sec / logs);
          const h = H + c.rng.range(-0.4, 0.5);
          const col = jitter(0x6a5038, c.rng, 0.12);
          k.cyl(lx, gmin, 0, 0.22, 0.2, h - gmin, Surf.Bark, col, { seg: 6 });
          k.cyl(lx, h, 0, 0.2, 0.0, 0.6, Surf.Timber, scaleHex(col, 1.2), { seg: 6, lod: 1 });
        }
        k.col(x, gmin, 0, sec, H - gmin, 0.5, true);
        // Inner fighting platform.
        k.box(x, H - 1.5, -0.9, sec, 0.12, 1.4, Surf.Planks, 0x7a6048);
        k.col(x, H - 1.5, -0.9, sec, 0.12, 1.4, true);
        k.box(x, H * 0.3, 0.25, sec, 0.12, 0.12, Surf.Rope, 0x7a6040, { lod: 1 });
        for (const sx of [-1, 1]) k.pole(x + (sx * sec) / 2 - sx * 0.3, 0, -1.5, x + (sx * sec) / 2 - sx * 0.3, H - 1.4, -1.5, 0.1, 0.1, Surf.Bark, 0x5a4430);
        if (c.st.id === 'goblin' && i % 2 === 0) k.box(x, H * 0.4, 0.28, sec * 0.6, 1.2, 0.04, Surf.Metal, jitter(0x8a5a3a, c.rng, 0.15), { rz: c.rng.range(-0.15, 0.15), lod: 1 });
        if (c.st.id === 'orcish' && i % 2 === 1) k.sphere(x, H - 0.1, 0.25, 0.18, 0.2, 0.2, Surf.Bone, 0xe8dcc0, { seg: 6, lod: 1 });
        break;
      }
      case 'hedge': {
        if (c.st.id === 'sylvan') {
          // Interlaced giant roots with glowing thorn buds.
          for (let j = 0; j < 3; j++) {
            const y0 = gmin, y1 = H * (0.7 + j * 0.15);
            k.pole(x - sec / 2, y0, (j - 1) * 0.6, x + sec / 2, y1, (1 - j) * 0.6, 0.5, 0.35, Surf.Bark, jitter(0x5a4a38, c.rng, 0.1), { seg: 7 });
          }
          k.box(x, 0, 0, sec, H * 0.85, T * 0.7, Surf.Leaf, jitter(0x3a6a3a, c.rng, 0.1));
          k.sphere(x, H * 0.8, T / 2, 0.15, 0.15, 0.15, Surf.Glow, 0x60ffc0, { emit: 0x60ffc0, emitI: 2, seg: 6, lod: 1 });
          k.col(x, 0, 0, sec, H, T, true);
        } else {
          const hh = Math.min(H, 2.2);
          k.solid(x, gmin, 0, sec, hh * 0.55 - gmin, T, Surf.Rubble, jitter(0xa49884, c.rng, 0.05));
          k.box(x, hh * 0.55, 0, sec, hh * 0.6, T * 0.9, Surf.Leaf, jitter(0x4a7a30, c.rng, 0.08));
          k.col(x, hh * 0.55, 0, sec, hh * 0.6, T * 0.9, true);
        }
        break;
      }
      case 'megalith': {
        // Standing stones capped by lintels every other section.
        const col = jitter(0x8c887e, c.rng, 0.06);
        k.frustum(x - sec / 4, gmin, 0, sec * 0.42, T, sec * 0.36, T * 0.85, H - gmin, Surf.Rubble, col, { rz: c.rng.range(-0.03, 0.03) });
        k.frustum(x + sec / 4, gmin, 0, sec * 0.42, T, sec * 0.36, T * 0.85, H - gmin - 0.4, Surf.Rubble, jitter(col, c.rng, 0.05));
        k.col(x, gmin, 0, sec, H - gmin, T, true);
        if (i % 2 === 0) k.box(x, H - 0.2, 0, sec + 0.4, 0.9, T * 0.8, Surf.Rubble, scaleHex(col, 0.95));
        k.box(x, H * 0.55, T / 2 - 0.05, 0.8, 0.8, 0.04, Surf.Glow, 0x80c0ff, { emit: 0x5090ff, emitI: 0.9, lod: 1 });
        break;
      }
    }
  }
  return null;
}

/** Gatehouse: passage with flanking towers (or log/megalith variants). Local +z outward. */
export function buildGate(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const W = c.b.size[0], D = c.b.size[1], H = c.b.size[2];
  const fam = family(c);
  const pass = Math.min(4.2 * c.s, W * 0.42);
  const g = Math.min(...c.ground) - 0.8;
  const tw = (W - pass) / 2;
  const st = stoneOf(c);
  const sides: number[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (pass / 2 + tw / 2);
    sides.push(k.piece('tower', fam === 'palisade' ? 'wood' : 'stone'));
    if (fam === 'palisade') {
      for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(x + px * (tw / 2 - 0.3), g, pz * (D / 2 - 0.3), 0.28, 0.24, H + 2 - g, Surf.Bark, jitter(0x5e4630, c.rng, 0.1), { seg: 6 });
      k.solid(x, H, 0, tw + 0.3, 0.2, D + 0.3, Surf.Planks, 0x7a6048);
      for (let i = 0; i < 6; i++) k.cyl(x - tw / 2 + 0.3 + i * ((tw - 0.6) / 5), H + 0.2, D / 2, 0.12, 0.0, 1.4, Surf.Bark, 0x5a4430, { seg: 5, lod: 1 });
      k.cyl(x, H + 2.0, 0, tw * 0.85, 0, 2.0, Surf.Hide, jitter(0x8a6a4c, c.rng, 0.1), { seg: 6 });
      k.col(x, g, 0, tw, H + 2 - g, D, true);
      k.sphere(x, H - 1, D / 2 + 0.3, 0.3, 0.32, 0.34, Surf.Bone, 0xe8dcc0, { seg: 7, lod: 1 });
    } else if (fam === 'megalith') {
      k.frustum(x, g, 0, tw, D, tw * 0.85, D * 0.85, H + 2 - g, Surf.Rubble, jitter(0x8c887e, c.rng, 0.05));
      k.col(x, g, 0, tw, H + 2 - g, D, true);
    } else if (fam === 'hedge') {
      k.solid(x, g, 0, tw, H - g, D, c.st.id === 'sylvan' ? Surf.Bark : Surf.Rubble, c.st.id === 'sylvan' ? 0x5a4a38 : 0xa49884);
      k.sphere(x, H, 0, tw * 0.6, 1.2, D * 0.6, Surf.Leaf, jitter(0x4a7a30, c.rng, 0.08), { lat0: 0, lat1: Math.PI / 2, seg: 8 });
    } else {
      k.solid(x, g, 0, tw, H + 2 - g, D, st.surf, st.col);
      // Crenellated top & machicolation band.
      k.box(x, H + 2, 0, tw + 0.4, 0.3, D + 0.4, st.surf, scaleHex(st.col, 0.9));
      for (let i = 0; i < 4; i++) k.box(x - tw / 2 + 0.3 + i * ((tw - 0.6) / 3), H + 2.3, D / 2, 0.55, 0.7, 0.45, st.surf, st.col, { lod: 1 });
      for (const wz of [1, -1]) k.box(x, H * 0.55, (wz * D) / 2, 0.3, 1.0, 0.1, Surf.Window, 0x141418, { lod: 1, emit: c.st.glow, emitI: 1.5, night: true });
      if (c.st.id === 'drakeborn') k.light(x, H + 3, D / 2, 0xff7a30, 5, 12, false, 1);
    }
  }
  // Arch / lintel over the passage.
  const top = k.piece('wall', fam === 'palisade' ? 'wood' : 'stone', sides, 2);
  if (fam === 'stone') {
    k.solid(0, H - 1.6, 0, pass + 0.1, 3.6, D, st.surf, st.col);
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI;
      k.boxC(Math.cos(a) * (pass / 2), H - 1.6 + Math.sin(a) * 1.2 - 0.6, D / 2 + 0.05, 0.5, 0.4, 0.3, Surf.StoneBrick, scaleHex(st.col, 0.85), { rz: a - Math.PI / 2, lod: 1 });
    }
    for (let i = 0; i < 4; i++) k.box(-pass / 2 + 0.4 + i * ((pass - 0.8) / 3), H + 2, D / 2 - 0.25, 0.5, 0.6, 0.5, st.surf, st.col, { lod: 1 });
    // Raised portcullis.
    for (let i = 0; i < 7; i++) k.box(-pass / 2 + 0.3 + i * ((pass - 0.6) / 6), H - 2.4, D / 2 - 0.6, 0.07, 2.2, 0.07, Surf.Metal, 0x2a2826, { lod: 1 });
    k.box(0, H - 2.4, D / 2 - 0.6, pass, 0.08, 0.08, Surf.Metal, 0x2a2826, { lod: 1 });
    // Banners on the outer face.
    for (const sx of [-1, 1]) {
      k.push(sx * (pass / 2 + tw / 2), H + 0.6, D / 2 + 0.1, 0);
      heraldicPanel(k, c.her, 1.4 * c.s, 2.8 * c.s, -2.8 * c.s, 0.03, 1);
      k.pop();
    }
  } else if (fam === 'palisade') {
    k.box(0, H - 0.4, D / 2, pass + 0.6, 0.5, 0.5, Surf.Bark, 0x5e4630);
    k.box(0, H + 0.1, D / 2, pass + 0.2, 0.9, 0.12, Surf.Hide, c.her.field, { lod: 1 });
    // Swung-open log gates.
    for (const sx of [-1, 1]) {
      k.push(sx * (pass / 2), 0, D / 2 - 0.2, sx * -1.35);
      for (let i = 0; i < 5; i++) k.cyl(-sx * (0.2 + i * 0.42), 0, 0, 0.2, 0.18, H - 0.8, Surf.Bark, jitter(0x6a5038, c.rng, 0.1), { seg: 6 });
      k.pop();
    }
  } else if (fam === 'megalith') {
    k.box(0, H + 1.2, 0, W * 0.85, 1.3, D * 0.8, Surf.Rubble, jitter(0x8c887e, c.rng, 0.05));
    k.box(0, H + 1.4, D * 0.4 + 0.02, 1.4, 0.8, 0.04, Surf.Glow, 0x80c0ff, { emit: 0x5090ff, emitI: 1.4, lod: 1 });
  } else {
    k.pole(-pass / 2, H * 0.8, 0, 0, H * 1.25, 0, 0.35, 0.3, Surf.Bark, 0x5a4a38, { seg: 7 });
    k.pole(pass / 2, H * 0.8, 0, 0, H * 1.25, 0, 0.35, 0.3, Surf.Bark, 0x5a4a38, { seg: 7 });
    k.sphere(0, H * 1.25, 0, 1.2, 0.8, 1.0, Surf.Leaf, jitter(0x4a7a30, c.rng, 0.08), { seg: 8 });
  }
  void top;
  // Cobbled passage floor.
  k.piece('floor', 'stone');
  k.box(0, -0.2, 0, pass, 0.25, D, Surf.Cobble, 0x7a766c, { lod: 1 });
  return null;
}

/** Fortification tower (ring node). */
export function buildFortTower(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const fam = family(c);
  const H = c.b.size[2];
  const r = c.b.size[0] / 2;
  if (fam === 'stone') {
    const st = stoneOf(c);
    const floors = Math.max(2, Math.round(H / (3.2 * c.s)));
    const storey = H / floors;
    const spec = roundSpec(c, {
      r,
      floors,
      storey,
      wallT: 0.6,
      walls: [{ surf: st.surf, col: st.col }],
      door: null,
      platform: true,
      taper: c.st.id === 'drakeborn' ? 0.82 : 0.94,
      seg: c.b.round ? 12 : 4,
      roof: roofLook(c, c.st.id === 'elven' || c.st.id === 'umbral' || c.rng.chance(0.4) ? 'conical' : 'flat', { crenel: true, pitch: c.st.id === 'elven' || c.st.id === 'umbral' ? 2.2 : 1.1 }),
      win: windowLook(c, { shape: 'slit', lit: 1.2 }),
      stairs: false,
    });
    const out = buildRound(k, spec);
    if (c.st.id === 'drakeborn' || c.st.id === 'stonekeep') {
      k.use(out.roof);
      k.cyl(0, out.wallTop + 0.1, 0, 0.3, 0.5, 0.5, Surf.Metal, 0x3a2e28, { seg: 8 });
      k.cyl(0, out.wallTop + 0.6, 0, 0.45, 0.02, 1.0, Surf.Fire, 0xffb050, { emit: 0xff6a10, emitI: 5, seg: 6 });
      k.light(0, out.wallTop + 1.3, 0, 0xff8030, 7, 16, false, 1);
    }
    return null;
  }
  // Timber / log / megalith / root towers: four legs, platform, railing, roof.
  const legs = k.piece('tower', fam === 'megalith' ? 'stone' : 'wood');
  const g = Math.min(...c.ground) - 0.6;
  const hw = r * 0.85;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (fam === 'megalith') k.frustum(sx * hw * 0.7, g, sz * hw * 0.7, 1.0, 1.0, 0.8, 0.8, H - g, Surf.Rubble, jitter(0x8c887e, c.rng, 0.05));
    else k.pole(sx * hw, g, sz * hw, sx * hw * 0.8, H, sz * hw * 0.8, 0.22, 0.18, fam === 'hedge' ? Surf.Bark : Surf.Bark, jitter(0x5e4630, c.rng, 0.1), { seg: 6 });
    k.col(sx * hw * 0.8, g, sz * hw * 0.8, 0.5, H - g, 0.5, true);
  }
  for (const y of [H * 0.35, H * 0.7]) {
    k.beam(-hw * 0.9, y, -hw * 0.9, hw * 0.9, y + 1.2, hw * 0.9, 0.12, Surf.Timber, 0x5a4430, { lod: 1 });
    k.beam(hw * 0.9, y, -hw * 0.9, -hw * 0.9, y + 1.2, hw * 0.9, 0.12, Surf.Timber, 0x5a4430, { lod: 1 });
  }
  const plat = k.piece('platform', 'wood', [legs], 1);
  k.solid(0, H, 0, r * 2 + 0.4, 0.2, r * 2 + 0.4, Surf.Planks, 0x7a6048);
  for (const [sx, sz, rot] of [[0, 1, 0], [0, -1, 0], [1, 0, 1], [-1, 0, 1]] as const) {
    const w = r * 2 + 0.4;
    if (rot) k.box(sx * (w / 2), H + 0.2, 0, 0.12, 1.1, w, Surf.Planks, 0x6a5038);
    else k.box(0, H + 0.2, sz * (w / 2), w, 1.1, 0.12, Surf.Planks, 0x6a5038);
  }
  k.col(0, H + 0.2, r + 0.2, r * 2 + 0.4, 1.1, 0.15, true);
  k.col(0, H + 0.2, -r - 0.2, r * 2 + 0.4, 1.1, 0.15, true);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(sx * r * 0.9, H + 0.2, sz * r * 0.9, 0.14, 2.4, 0.14, Surf.Timber, 0x5a4430);
  const roofSurf = fam === 'palisade' ? Surf.Hide : fam === 'megalith' ? Surf.Turf : Surf.Leaf;
  k.cyl(0, H + 2.6, 0, r * 1.5, 0, r * 1.2, roofSurf, jitter(fam === 'palisade' ? 0x8a6a4c : fam === 'megalith' ? 0x6a8040 : 0x4a7a3a, c.rng, 0.08), { seg: 6 });
  k.light(0, H + 1.8, 0, 0xff9040, 4, 10, true, 1);
  k.cyl(r * 0.6, H + 1.2, r * 0.6, 0.08, 0.12, 0.3, Surf.Fire, 0xffb050, { emit: 0xff7a20, emitI: 4, seg: 5, lod: 1 });
  void plat;
  return null;
}
