/**
 * Settlement props: barrels, crates, carts, market stalls with striped awnings,
 * fences, haystacks, hanging signs, heraldic banners, statues, graves,
 * campfires, scarecrows, street lamps of every culture, benches, woodpiles,
 * troughs, totems, braziers, crystal clusters, glowing mushrooms, planters,
 * boats, tents and standing stones. Each prop is one destructible piece.
 * Frame: prop origin on the ground, +z = prop front.
 */
import type { Heraldry, PropInfo } from '../types';
import { Kit, Surf, jitter, scaleHex, type PieceMat } from './kit';
import { heraldicPanel, emblem } from './heraldry';
import { STYLES } from './styles';
import { fencePosts } from '../layout';
import { Rng } from '../../core/rng';

const PROP_MAT: Partial<Record<PropInfo['kind'], PieceMat>> = {
  statue: 'stone', grave: 'stone', standing_stone: 'stone', crystal: 'crystal', brazier: 'metal', anvil: 'metal', haystack: 'plant',
  mushroom: 'plant', banner: 'cloth', tent: 'cloth', sacks: 'cloth', campfire: 'stone', well: 'stone',
};

const AWNING = [0xb03a2a, 0x2a5a9a, 0x3a8a4a, 0xd0a030, 0x7a3a8a, 0xd06a2a];

/** Build one prop at frame-local (x, y, z) with yaw. Returns the piece index. */
export function buildProp(k: Kit, p: PropInfo, x: number, y: number, z: number, her: Heraldry): number {
  const r = new Rng(p.seed);
  const st = STYLES[p.style] ?? STYLES.timber;
  const s = p.scale;
  const pi = k.piece(p.kind === 'fence' ? 'fence' : 'prop', PROP_MAT[p.kind] ?? 'wood');
  k.push(x, y, z, p.yaw);
  const wood = jitter(st.trim.surf === Surf.Timber || st.trim.surf === Surf.Bark ? st.trim.cols[0] : 0x6a5038, r, 0.08);
  const plank = jitter(0x8a6a48, r, 0.08);
  const lod1 = { lod: 1 as const };
  switch (p.kind) {
    case 'barrel': {
      const rr = 0.32 * s, h = 0.95 * s;
      k.cyl(0, 0, 0, rr * 0.88, rr, h / 2, Surf.Planks, plank, { seg: 10 });
      k.cyl(0, h / 2, 0, rr, rr * 0.88, h / 2, Surf.Planks, plank, { seg: 10 });
      for (const hy of [0.08, h / 2 - 0.03, h - 0.12]) k.cyl(0, hy, 0, rr + 0.01, rr + 0.01, 0.05, Surf.Metal, 0x3a3634, { seg: 10, lod: 1 });
      k.col(0, 0, 0, rr * 2, h, rr * 2, true);
      break;
    }
    case 'crate': {
      const c = 0.75 * s;
      k.box(0, 0, 0, c, c, c, Surf.Planks, plank);
      for (const sy of [0, c - 0.06]) k.box(0, sy, 0, c + 0.02, 0.06, c + 0.02, Surf.Timber, scaleHex(plank, 0.7), lod1);
      if (r.chance(0.5)) k.box(r.range(-0.1, 0.1), c, r.range(-0.1, 0.1), c * 0.8, c * 0.7, c * 0.8, Surf.Planks, jitter(plank, r, 0.1));
      k.col(0, 0, 0, c, c, c, true);
      break;
    }
    case 'sacks': {
      for (let i = 0; i < 4; i++) k.sphere(r.range(-0.4, 0.4), 0.25 * s + (i === 3 ? 0.35 : 0), r.range(-0.3, 0.3), 0.26 * s, 0.28 * s, 0.22 * s, Surf.Cloth, jitter(0xb09a70, r, 0.08), { seg: 8 });
      k.col(0, 0, 0, 1.0, 0.8, 0.8, true);
      break;
    }
    case 'cart': {
      const L = 2.4 * s, W = 1.3 * s, wy = 0.45 * s;
      k.box(0, wy + 0.05, 0, W, 0.08, L, Surf.Planks, plank);
      for (const sx of [-1, 1]) k.box((sx * W) / 2, wy + 0.13, 0, 0.06, 0.4 * s, L, Surf.Planks, plank);
      k.box(0, wy + 0.13, -L / 2, W, 0.4 * s, 0.06, Surf.Planks, plank);
      for (const sx of [-1, 1]) {
        k.cyl((sx * (W + 0.12)) / 2 - (sx > 0 ? 0 : 0.08), wy, -0.2, wy, wy, 0.08, Surf.Planks, scaleHex(plank, 0.75), { rz: -Math.PI / 2, seg: 12 });
        k.cyl((sx * (W + 0.12)) / 2 - (sx > 0 ? 0 : 0.08) - 0.02, wy, -0.2, 0.08, 0.08, 0.12, Surf.Metal, 0x3a3634, { rz: -Math.PI / 2, seg: 6, lod: 1 });
      }
      k.box(0, wy - 0.05, -0.2, W + 0.2, 0.08, 0.08, Surf.Timber, wood);
      for (const sx of [-1, 1]) k.beam(sx * 0.3, wy, L / 2, sx * 0.25, 0.05, L / 2 + 1.6 * s, 0.07, Surf.Timber, wood);
      // Cargo.
      if (r.chance(0.6)) for (let i = 0; i < 3; i++) k.sphere(r.range(-0.3, 0.3), wy + 0.4, r.range(-0.7, 0.7), 0.3, 0.25, 0.25, Surf.Cloth, jitter(0xb09a70, r, 0.1), { seg: 7, lod: 1 });
      else k.box(0, wy + 0.13, 0, W - 0.2, 0.35, L - 0.4, Surf.Straw, 0xd0b870, lod1);
      k.col(0, 0, 0, W + 0.3, wy + 0.6, L, true);
      break;
    }
    case 'stall': {
      const W = 2.6 * s, D = 1.6 * s, H = 2.4 * s;
      const aw = r.pick(AWNING);
      k.box(0, 0, 0.2, W, 0.9 * s, 0.7 * s, Surf.Planks, plank);
      k.box(0, 0.9 * s, 0.2, W + 0.1, 0.06, 0.8 * s, Surf.Planks, scaleHex(plank, 0.85));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box((sx * (W - 0.1)) / 2, 0, (sz * (D - 0.1)) / 2, 0.09, H - (sz > 0 ? 0.25 : 0), 0.09, Surf.Timber, wood);
      // Striped awning sloping toward the customer.
      const n = 6;
      for (let i = 0; i < n; i++) {
        const sx = -W / 2 - 0.1 + ((i + 0.5) * (W + 0.2)) / n;
        k.boxC(sx, H - 0.1, 0.1, (W + 0.2) / n + 0.001, 0.04, D + 0.6, Surf.Cloth, i % 2 ? 0xf0e8d8 : aw, { rx: 0.22 });
      }
      for (let i = 0; i < 7; i++) k.box(-W / 2 + (i + 0.5) * (W / 7), H - 0.58, D / 2 + 0.38, W / 7 - 0.02, 0.22, 0.02, Surf.Cloth, i % 2 ? aw : 0xf0e8d8, lod1);
      // Goods.
      const goods = r.int(0, 3);
      for (let i = 0; i < 5; i++) {
        const gx = -W / 2 + 0.35 + i * ((W - 0.7) / 4), gz = 0.25;
        if (goods === 0) k.sphere(gx, 0.98 * s, gz, 0.13, 0.11, 0.13, Surf.Leaf, r.pick([0xc03a2a, 0x8ab03a, 0xe0a030]), { seg: 6, lod: 2 });
        else if (goods === 1) k.box(gx, 0.96 * s, gz, 0.3, 0.06, 0.4, Surf.Cloth, r.pick(AWNING), { lod: 2 });
        else if (goods === 2) k.cyl(gx, 0.96 * s, gz, 0.08, 0.06, 0.25, Surf.ClayTile, r.pick([0xa06040, 0x8a7a60, 0x5a6a7a]), { seg: 6, lod: 2 });
        else k.box(gx, 0.96 * s, gz, 0.22, 0.04, 0.5, Surf.Metal, 0x9a9a9a, { lod: 2 });
      }
      k.box(0, 0, -0.5, 0.8, 0.5, 0.5, Surf.Planks, plank, lod1);
      k.col(0, 0, 0.2, W, 0.95 * s, 0.8 * s, true);
      break;
    }
    case 'fence':
    case 'gate_fence': {
      const L = p.len ?? 4;
      const n = fencePosts(L);
      const fh = 1.05 * s;
      const sink = 0.35;
      // Ground height under post i (relative to the prop origin); flat when no profile.
      const gAt = (i: number) => p.ground?.[i] ?? 0;
      const gLerp = (t: number) => {
        const f = t * n, i = Math.min(n - 1, Math.floor(f));
        return gAt(i) + (gAt(i + 1) - gAt(i)) * (f - i);
      };
      const postX = (i: number) => -L / 2 + (i * L) / n;
      const hedge = p.style === 'burrow' || p.style === 'elven';
      if (hedge && r.chance(0.5)) {
        // One hedge block per span so it steps with the slope.
        const leaf = jitter(0x4a7a30, r, 0.1);
        for (let i = 0; i < n; i++) {
          const g0 = Math.min(gAt(i), gAt(i + 1));
          k.box((postX(i) + postX(i + 1)) / 2, g0 - sink, 0, L / n + 0.15, fh * 0.9 + sink + Math.abs(gAt(i + 1) - gAt(i)) * 0.5, 0.7, Surf.Leaf, leaf);
        }
      } else if (p.style === 'orcish' || p.style === 'goblin') {
        for (let i = 0; i <= n * 2; i++) {
          const t = i / (n * 2);
          const px = -L / 2 + t * L;
          k.cyl(px, gLerp(t) - sink, r.range(-0.05, 0.05), 0.07, 0.05, fh * r.range(0.9, 1.35) + sink, Surf.Bark, jitter(wood, r, 0.1), { seg: 5, rz: r.range(-0.1, 0.1) });
        }
        for (let i = 0; i < n; i++) k.beam(postX(i), gAt(i) + fh * 0.6, 0, postX(i + 1), gAt(i + 1) + fh * 0.6, 0, 0.06, Surf.Rope, 0x8a6a3a, lod1);
      } else {
        for (let i = 0; i <= n; i++) k.box(postX(i), gAt(i) - sink, 0, 0.12, fh + sink, 0.12, Surf.Timber, wood);
        // Rails run post to post, following the slope.
        for (const ry of [0.35, 0.8]) for (let i = 0; i < n; i++) k.beam(postX(i), gAt(i) + ry * fh, 0, postX(i + 1), gAt(i + 1) + ry * fh, 0, 0.08, Surf.Planks, plank, { ...lod1, d: 0.05 });
      }
      for (let i = 0; i < n; i++) {
        const g0 = Math.min(gAt(i), gAt(i + 1)), g1 = Math.max(gAt(i), gAt(i + 1));
        k.col((postX(i) + postX(i + 1)) / 2, g0, 0, L / n, fh + (g1 - g0), 0.2, true);
      }
      break;
    }
    case 'haystack': {
      k.sphere(0, 0, 0, 1.3 * s, 1.6 * s, 1.3 * s, Surf.Straw, jitter(0xd8c070, r, 0.08), { lat0: 0, lat1: Math.PI / 2, seg: 10 });
      k.cyl(0, 0, 0, 1.3 * s, 1.25 * s, 0.4, Surf.Straw, jitter(0xc8b060, r, 0.08), { seg: 10 });
      k.col(0, 0, 0, 2.2 * s, 1.6 * s, 2.2 * s, true);
      break;
    }
    case 'sign': {
      const ph = 2.6;
      k.box(0, 0, 0, 0.14, ph, 0.14, Surf.Timber, wood);
      k.box(0.45, ph - 0.2, 0, 1.0, 0.1, 0.1, Surf.Timber, wood);
      k.beam(0, ph - 0.7, 0, 0.6, ph - 0.22, 0, 0.07, Surf.Timber, wood, lod1);
      for (const cx of [0.2, 0.7]) k.box(cx, ph - 0.55, 0, 0.02, 0.35, 0.02, Surf.Metal, 0x2a2826, lod1);
      k.push(0.45, ph - 1.15, 0, Math.PI / 2);
      k.box(0, 0, 0, 0.8, 0.62, 0.05, Surf.Planks, scaleHex(plank, 0.9));
      k.box(0, -0.03, 0, 0.86, 0.68, 0.035, Surf.Timber, wood, lod1);
      for (const side of [1, -1]) {
        k.push(0, 0.31, side * 0.035, side > 0 ? 0 : Math.PI);
        emblem(k, r.pick(['star', 'hammer', 'crown', 'moon', 'boar', 'sun'] as const), 0.2, 0xe0c060, scaleHex(plank, 0.9), 1);
        k.pop();
      }
      k.pop();
      k.col(0, 0, 0, 0.2, ph, 0.2, true);
      break;
    }
    case 'banner': {
      const ph = 4.2 * s;
      k.cyl(0, 0, 0, 0.07, 0.05, ph, Surf.Timber, wood, { seg: 6 });
      k.sphere(0, ph + 0.05, 0, 0.1, 0.1, 0.1, Surf.Metal, 0xc0a040, { seg: 6 });
      k.box(0, ph - 0.15, 0.05, 1.2 * s, 0.06, 0.06, Surf.Timber, wood);
      k.push(0, 0, 0.12, 0);
      heraldicPanel(k, her, 1.0 * s, 1.8 * s, ph - 2.05 * s, 0.03, 0);
      k.pop();
      k.sway(0, ph - 0.15, 0.12);
      k.col(0, 0, 0, 0.2, ph, 0.2, true);
      break;
    }
    case 'statue': {
      const stone = jitter(0xc8c2b4, r, 0.05);
      k.box(0, 0, 0, 1.6 * s, 0.5 * s, 1.6 * s, Surf.StoneBrick, scaleHex(stone, 0.85));
      k.box(0, 0.5 * s, 0, 1.2 * s, 1.0 * s, 1.2 * s, Surf.Marble, stone);
      k.box(0, 1.5 * s, 0, 1.4 * s, 0.15 * s, 1.4 * s, Surf.Marble, scaleHex(stone, 0.9));
      k.push(0, 1.65 * s, 0, 0);
      figure(k, s * 1.3, stone, r);
      k.pop();
      k.col(0, 0, 0, 1.6 * s, 1.65 * s + 2.2 * s, 1.6 * s, true);
      break;
    }
    case 'grave': {
      const stone = jitter(0x9a968c, r, 0.08);
      const v = r.int(0, 3);
      k.box(0, 0, -0.9, 0.9, 0.18, 1.9, Surf.Soil, 0x5a4a3a);
      if (v === 0) {
        k.box(0, 0, 0, 0.6, 0.85, 0.14, Surf.StoneBrick, stone);
        k.cyl(0, 0.85, -0.07, 0.3, 0.3, 0.14, Surf.StoneBrick, stone, { rx: Math.PI / 2, seg: 10 });
      } else if (v === 1) {
        k.box(0, 0, 0, 0.12, 1.1, 0.12, Surf.StoneBrick, stone);
        k.box(0, 0.7, 0, 0.6, 0.12, 0.12, Surf.StoneBrick, stone);
      } else if (v === 2) {
        k.box(0, 0, 0, 0.7, 0.7, 0.16, Surf.Rubble, stone, { rz: r.range(-0.15, 0.15) });
      } else {
        k.box(0, 0, -0.9, 0.8, 0.45, 1.8, Surf.StoneBrick, stone);
        k.box(0, 0.45, -0.9, 0.9, 0.08, 1.9, Surf.Marble, scaleHex(stone, 1.1));
      }
      k.col(0, 0, -0.5, 0.9, 0.9, 1.0, true);
      break;
    }
    case 'campfire': {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        k.sphere(Math.cos(a) * 0.75 * s, 0.1, Math.sin(a) * 0.75 * s, 0.2, 0.16, 0.18, Surf.Rubble, jitter(0x6a665e, r, 0.1), { seg: 6 });
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.3;
        k.pole(Math.cos(a) * 0.55, 0.05, Math.sin(a) * 0.55, 0, 0.55, 0, 0.07, 0.05, Surf.Bark, 0x4a3424);
      }
      k.cyl(0, 0.05, 0, 0.45 * s, 0.02, 1.0 * s, Surf.Fire, 0xffb050, { emit: 0xff7a20, emitI: 4.5, seg: 7 });
      k.cyl(0.1, 0.05, 0.05, 0.25 * s, 0.01, 0.7 * s, Surf.Fire, 0xffe090, { emit: 0xffc060, emitI: 5, seg: 5 });
      k.col(0, 0, 0, 1.6 * s, 0.4, 1.6 * s, true);
      k.light(0, 0.8, 0, 0xff8a30, 8, 12, false, 1);
      k.smoke(0, 1.3, 0);
      break;
    }
    case 'scarecrow': {
      k.box(0, 0, 0, 0.1, 2.3 * s, 0.1, Surf.Timber, wood);
      k.box(0, 1.6 * s, 0, 1.6 * s, 0.08, 0.08, Surf.Timber, wood);
      k.box(0, 1.0 * s, 0, 0.55 * s, 0.75 * s, 0.3, Surf.Cloth, jitter(0x7a5a3a, r, 0.15));
      for (const sx of [-1, 1]) k.box(sx * 0.5 * s, 1.5 * s, 0, 0.6 * s, 0.22, 0.24, Surf.Cloth, jitter(0x7a5a3a, r, 0.15), lod1);
      k.sphere(0, 2.0 * s, 0, 0.2, 0.24, 0.2, Surf.Cloth, 0xc8b080, { seg: 8 });
      k.cyl(0, 2.15 * s, 0, 0.42, 0.12, 0.28, Surf.Straw, 0xb89a5c, { seg: 10, lod: 1 });
      k.col(0, 0, 0, 0.3, 2.3 * s, 0.3, true);
      break;
    }
    case 'lamp': {
      const ph = 3.0 * s;
      const torch = (p.len ?? 0) > 0;
      if (torch) {
        k.cyl(0, 0, 0, 0.08, 0.06, ph * 0.75, Surf.Bark, wood, { seg: 6 });
        k.cyl(0, ph * 0.75, 0, 0.1, 0.13, 0.25, Surf.Rope, 0x6a4a2a, { seg: 6, lod: 1 });
        k.cyl(0, ph * 0.75 + 0.25, 0, 0.12, 0.01, 0.45, Surf.Fire, 0xffb050, { emit: 0xff7a20, emitI: 5, seg: 5 });
        k.light(0, ph * 0.75 + 0.5, 0, 0xff9040, 6, 11, true, 1);
      } else {
        k.cyl(0, 0, 0, 0.13, 0.1, 0.4, Surf.StoneBrick, 0x7a766c, { seg: 6 });
        k.cyl(0, 0.4, 0, 0.06, 0.05, ph - 0.4, Surf.Metal, 0x2e2c2a, { seg: 6 });
        k.box(0, ph - 0.1, 0.25, 0.06, 0.06, 0.55, Surf.Metal, 0x2e2c2a, lod1);
        k.cyl(0, ph - 0.62, 0.5, 0.12, 0.12, 0.34, Surf.Window, 0xfff0c8, { seg: 6, emit: 0xffc070, emitI: 3.5, night: true });
        k.cyl(0, ph - 0.28, 0.5, 0.15, 0.03, 0.18, Surf.Metal, 0x2e2c2a, { seg: 6, lod: 1 });
        k.cyl(0, ph - 0.68, 0.5, 0.1, 0.14, 0.06, Surf.Metal, 0x2e2c2a, { seg: 6, lod: 1 });
        k.light(0, ph - 0.5, 0.5, 0xffb060, 5, 12, true, 0.1);
      }
      k.col(0, 0, 0, 0.25, ph, 0.25, true);
      break;
    }
    case 'bench': {
      const L = 1.7 * s;
      if (p.style === 'orcish' || p.style === 'megalith' || p.style === 'goblin') {
        k.cyl(-L / 2, 0.22 * s, 0, 0.22 * s, 0.22 * s, L, Surf.Bark, jitter(0x5a4430, r, 0.1), { rz: -Math.PI / 2, seg: 8 });
      } else {
        k.box(0, 0.42 * s, 0, L, 0.06, 0.4 * s, Surf.Planks, plank);
        for (const sx of [-1, 1]) k.box((sx * (L - 0.3)) / 2, 0, 0, 0.1, 0.42 * s, 0.36 * s, p.style === 'stonekeep' ? Surf.StoneBrick : Surf.Timber, wood);
        k.box(0, 0.48 * s, -0.18 * s, L, 0.4 * s, 0.05, Surf.Planks, plank, lod1);
      }
      k.col(0, 0, 0, L, 0.45 * s, 0.45 * s, false);
      k.seat(0, 0.45 * s, 0, 0, 'Sit');
      break;
    }
    case 'woodpile': {
      const L = 1.8 * s;
      for (let row = 0; row < 4; row++)
        for (let i = 0; i < 5 - row; i++) k.cyl(-L / 2, 0.12 + row * 0.21, -0.45 + (i + row * 0.5) * 0.22, 0.11, 0.11, L, Surf.Bark, jitter(0x6a5038, r, 0.12), { rz: -Math.PI / 2, seg: 6 });
      k.boxC(0, 1.05, 0, L + 0.3, 0.06, 1.3, Surf.Planks, plank, { rx: 0.2, lod: 1 });
      k.col(0, 0, 0, L, 1.0, 1.1, true);
      break;
    }
    case 'trough': {
      k.box(0, 0, 0, 2.0 * s, 0.55 * s, 0.6 * s, Surf.Planks, plank);
      k.box(0, 0.42 * s, 0, 1.85 * s, 0.08, 0.48 * s, Surf.Window, 0x3a5a6a);
      k.col(0, 0, 0, 2.0 * s, 0.55 * s, 0.6 * s, true);
      break;
    }
    case 'totem': {
      const h = 3.6 * s;
      const segs = 3;
      for (let i = 0; i < segs; i++) {
        const y0 = (i * h) / segs;
        k.cyl(0, y0, 0, 0.32 * s, 0.3 * s, h / segs - 0.04, Surf.Carved, jitter(0x7a5a40, r, 0.12), { seg: 8 });
        // Painted face band.
        k.box(0, y0 + h / segs / 2 - 0.1, 0.27 * s, 0.4 * s, 0.12, 0.08, Surf.Cloth, r.pick([0xb02a2a, 0xe0d0b0, 0x1a1a1a]), lod1);
        for (const sx of [-0.12, 0.12]) k.sphere(sx * s, y0 + h / segs / 2 + 0.08, 0.28 * s, 0.06, 0.06, 0.04, Surf.Bone, 0xe8dcc0, { seg: 6, lod: 1 });
      }
      // Skull & horns on top.
      k.sphere(0, h + 0.18, 0.05, 0.22 * s, 0.22 * s, 0.26 * s, Surf.Bone, 0xe8dcc0, { seg: 8 });
      for (const sx of [-1, 1]) k.pole(sx * 0.18 * s, h + 0.25, 0, sx * 0.7 * s, h + 0.75, -0.1, 0.07, 0.01, Surf.Bone, 0xd8ccb0, { lod: 1 });
      k.box(0, h - 0.4, 0, 1.2 * s, 0.08, 0.08, Surf.Timber, wood, lod1);
      for (const sx of [-1, 1]) k.box(sx * 0.55 * s, h - 1.2, 0, 0.3, 0.8, 0.02, Surf.Cloth, her.field, lod1);
      k.col(0, 0, 0, 0.7 * s, h, 0.7 * s, true);
      break;
    }
    case 'brazier': {
      const h = 1.1 * s;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        k.pole(Math.cos(a) * 0.35 * s, 0, Math.sin(a) * 0.35 * s, Math.cos(a) * 0.2 * s, h, Math.sin(a) * 0.2 * s, 0.035, 0.03, Surf.Metal, 0x2a2624);
      }
      k.cyl(0, h - 0.05, 0, 0.22 * s, 0.4 * s, 0.3 * s, Surf.Metal, 0x3a2e28, { seg: 10 });
      k.cyl(0, h + 0.2 * s, 0, 0.32 * s, 0.02, 0.7 * s, Surf.Fire, 0xffb050, { emit: p.style === 'umbral' ? 0x9a50ff : 0xff6a10, emitI: 5, seg: 7 });
      k.col(0, 0, 0, 0.8 * s, h + 0.3, 0.8 * s, true);
      k.light(0, h + 0.6 * s, 0, p.style === 'umbral' ? 0xb070ff : 0xff8030, 7, 12, false, 1);
      break;
    }
    case 'crystal': {
      const glow = st.accent || 0x9a70ff;
      const n = r.int(3, 6);
      for (let i = 0; i < n; i++) {
        const a = r.range(0, Math.PI * 2), d = i === 0 ? 0 : r.range(0.2, 0.5) * s;
        const h = (i === 0 ? 2.4 : r.range(0.8, 1.7)) * s;
        k.cyl(Math.cos(a) * d, -0.1, Math.sin(a) * d, 0.18 * s, 0.0, h, Surf.Crystal, jitter(glow, r, 0.1), { seg: 6, rx: i ? r.range(-0.35, 0.35) : 0, rz: i ? r.range(-0.35, 0.35) : 0, emit: glow, emitI: 1.6 });
      }
      k.cyl(0, 0, 0, 0.6 * s, 0.4 * s, 0.25, Surf.Basalt, 0x2a2630, { seg: 7 });
      k.col(0, 0, 0, 0.8 * s, 2.3 * s, 0.8 * s, true);
      k.light(0, 1.4 * s, 0, glow, 4, 10, true, 0.05);
      break;
    }
    case 'mushroom': {
      const h = 2.2 * s;
      const cap = r.pick([0x3a9a8a, 0x7a4aa0, 0x2a6aa0, 0xa04a7a]);
      const glow = st.id === 'sylvan' ? 0x60ffc0 : 0x60c0ff;
      k.cyl(0, 0, 0, 0.18 * s, 0.13 * s, h, Surf.Mushroom, 0xe8e0d0, { seg: 8, rz: r.range(-0.08, 0.08) });
      k.sphere(0, h, 0, 0.75 * s, 0.45 * s, 0.75 * s, Surf.Mushroom, cap, { lat0: 0, lat1: Math.PI / 2 + 0.25, seg: 12 });
      k.cyl(0, h - 0.12 * s, 0, 0.6 * s, 0.6 * s, 0.05, Surf.Glow, glow, { seg: 12, emit: glow, emitI: 2.2 });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + r.float();
        k.sphere(Math.cos(a) * 0.45 * s, h + 0.25 * s, Math.sin(a) * 0.45 * s, 0.07, 0.04, 0.07, Surf.Glow, glow, { seg: 5, emit: glow, emitI: 2.5, lod: 1 });
      }
      k.col(0, 0, 0, 0.4 * s, h, 0.4 * s, true);
      k.light(0, h - 0.4, 0, glow, 3.5, 9, true, 0.05);
      break;
    }
    case 'planter': {
      k.box(0, 0, 0, 1.0, 0.45, 0.5, Surf.Planks, plank);
      k.box(0, 0.42, 0, 0.92, 0.04, 0.42, Surf.Soil, 0x4a3a2a);
      for (let i = 0; i < 5; i++) k.sphere(-0.38 + i * 0.19, 0.55, r.range(-0.08, 0.08), 0.12, 0.14, 0.12, Surf.Leaf, r.pick([0xd04050, 0xe0c040, 0xc060c0, 0x4a8a3a, 0xf08040]), { seg: 6, lod: 1 });
      k.col(0, 0, 0, 1.0, 0.6, 0.5, true);
      break;
    }
    case 'anvil': {
      k.cyl(0, 0, 0, 0.3 * s, 0.32 * s, 0.5 * s, Surf.Bark, 0x5a4430, { seg: 8 });
      k.box(0, 0.5 * s, 0, 0.3 * s, 0.25 * s, 0.6 * s, Surf.Metal, 0x404044);
      k.col(0, 0, 0, 0.6 * s, 0.75 * s, 0.7 * s, true);
      break;
    }
    case 'rack': {
      for (const sx of [-1, 1]) k.box(sx * 0.6, 0, 0, 0.08, 1.6, 0.08, Surf.Timber, wood);
      k.box(0, 1.5, 0, 1.3, 0.07, 0.08, Surf.Timber, wood);
      for (let i = 0; i < 3; i++) k.box(-0.4 + i * 0.4, 0.4, 0.02, 0.5, 0.9, 0.03, Surf.Hide, jitter(0x9a7a58, r, 0.12), lod1);
      k.col(0, 0, 0, 1.3, 1.6, 0.3, true);
      break;
    }
    case 'pole': {
      const h = 3.5;
      k.pole(0, 0, 0, r.range(-0.2, 0.2), h, r.range(-0.2, 0.2), 0.08, 0.05, Surf.Timber, wood);
      for (let i = 0; i < 3; i++) k.box(r.range(-0.2, 0.2), h - 0.6 - i * 0.7, 0.1, 0.5, 0.35, 0.02, Surf.Cloth, r.pick(AWNING), lod1);
      k.cyl(0.2, h - 0.4, 0, 0.1, 0.1, 0.2, Surf.Window, 0xfff0c8, { seg: 6, emit: 0x9aff60, emitI: 2.5, night: true, lod: 1 });
      k.light(0.2, h - 0.3, 0, 0xc0ff80, 3, 8, true, 0.2);
      k.col(0, 0, 0, 0.3, h, 0.3, true);
      break;
    }
    case 'boat': {
      const L = 4.2 * s, W = 1.4 * s;
      k.frustum(0, -0.2, 0, W * 0.6, L * 0.85, W, L, 0.7, Surf.Planks, jitter(0x7a5a3a, r, 0.1));
      k.frustum(0, 0.5, L / 2 - 0.05, W, 0.4, 0.05, 0.05, 0.6, Surf.Planks, jitter(0x7a5a3a, r, 0.1), { lod: 1 });
      for (const bz of [-0.6, 0.6]) k.box(0, 0.25, bz, W - 0.1, 0.06, 0.25, Surf.Planks, plank, lod1);
      k.beam(0.3, 0.4, -0.4, 1.4, 0.2, -1.6, 0.05, Surf.Timber, wood, lod1);
      k.col(0, -0.2, 0, W, 0.8, L, true);
      break;
    }
    case 'tent': {
      const R = 2.2 * s;
      k.cyl(0, 0, 0, R, 0.08, 2.6 * s, Surf.Hide, jitter(0x9a7a58, r, 0.1), { seg: 8 });
      k.cyl(0, 2.4 * s, 0, 0.05, 0.05, 0.8, Surf.Timber, wood, { seg: 5 });
      k.col(0, 0, 0, R * 1.4, 2.4 * s, R * 1.4, true);
      break;
    }
    case 'standing_stone': {
      const h = r.range(2.5, 4.2) * s;
      k.frustum(0, -0.3, 0, 1.1 * s, 0.7 * s, 0.8 * s, 0.5 * s, h, Surf.Rubble, jitter(0x8a867c, r, 0.08), { rz: r.range(-0.06, 0.06), ox: r.range(-0.1, 0.1) });
      k.box(0, h * 0.5, 0.36 * s, 0.4, 0.8, 0.02, Surf.Glow, 0x80c0ff, { emit: 0x5090ff, emitI: 1.2, lod: 1 });
      k.col(0, 0, 0, 1.1 * s, h, 0.7 * s, true);
      break;
    }
    case 'well': {
      k.cyl(0, 0, 0, 1.0, 1.0, 0.9, Surf.Rubble, 0x9a968c, { seg: 12 });
      k.col(0, 0, 0, 2, 0.9, 2, true);
      break;
    }
  }
  k.pop();
  return pi;
}

/** Simple standing figure (statues): body, head, arms raised or holding a sword. */
export function figure(k: Kit, s: number, col: number, r: Rng) {
  k.cyl(0, 0, 0, 0.32 * s, 0.22 * s, 1.0 * s, Surf.Marble, col, { seg: 8 });
  k.cyl(0, 1.0 * s, 0, 0.22 * s, 0.26 * s, 0.6 * s, Surf.Marble, col, { seg: 8 });
  k.sphere(0, 1.8 * s, 0, 0.14 * s, 0.17 * s, 0.15 * s, Surf.Marble, col, { seg: 8 });
  const pose = r.int(0, 2);
  for (const sx of [-1, 1]) {
    const up = pose === 0 || (pose === 1 && sx > 0);
    k.pole(sx * 0.26 * s, 1.5 * s, 0, sx * (up ? 0.38 : 0.34) * s, (up ? 2.2 : 1.0) * s, up ? 0.1 : 0.05, 0.07 * s, 0.06 * s, Surf.Marble, col);
  }
  if (pose === 1) k.box(0.4 * s, 2.0 * s, 0.1, 0.06 * s, 1.1 * s, 0.12 * s, Surf.Metal, 0x9a9a9a);
  if (pose === 2) k.cyl(0.35 * s, 0.9 * s, 0.25 * s, 0.25 * s, 0.25 * s, 0.05, Surf.Marble, col, { rx: Math.PI / 2, seg: 10 });
}
