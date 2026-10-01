/**
 * Giantkin megalith architecture (style 'megalith'): longhouses and halls of
 * huge rough-hewn stones laid in irregular courses, trilithon door frames,
 * towering corner menhirs carved with cold-blue glowing runes, and heavy
 * turf / thatch / hide roofs carried on tree-trunk timbers whose crossed
 * gable ends and ridge logs jut out. Everything is built at giant scale.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, doorLook, type BuildCtx, type StyleBuilder } from './common';
import { windmillSails } from './styleTimber';

const RUNE = 0x80c0ff;
const STONE = [0x9a968e, 0x8c887e, 0xa6a296, 0x7e7a70, 0x928c80];

/** Glowing rune strip (vertical) on a stone face at frame z. */
function runes(k: Kit, x: number, y: number, z: number, h: number, rng: Kit['rng']) {
  const n = Math.max(2, Math.floor(h / 0.35));
  for (let i = 0; i < n; i++) {
    if (rng.chance(0.25)) continue;
    const yy = y + i * (h / n);
    const kind = rng.int(0, 2);
    if (kind === 0) k.box(x, yy, z, 0.06, h / n - 0.08, 0.02, Surf.Glow, RUNE, { emit: RUNE, emitI: 1.1, lod: 1 });
    else if (kind === 1) k.boxC(x, yy + h / n / 2, z, 0.05, h / n - 0.06, 0.02, Surf.Glow, RUNE, { rz: 0.5, emit: RUNE, emitI: 1.1, lod: 1 });
    else {
      k.box(x - 0.07, yy, z, 0.04, h / n - 0.1, 0.02, Surf.Glow, RUNE, { emit: RUNE, emitI: 1.1, lod: 1 });
      k.box(x, yy + (h / n) * 0.4, z, 0.18, 0.04, 0.02, Surf.Glow, RUNE, { emit: RUNE, emitI: 1.1, lod: 1 });
    }
  }
}

/** Menhir (rough standing stone) with runes on its front. */
function menhir(k: Kit, x: number, z: number, h: number, w: number, rng: Kit['rng'], yaw = 0, base = -0.6) {
  const col = jitter(rng.pick(STONE), rng, 0.06);
  k.push(x, 0, z, yaw);
  k.frustum(0, base, 0, w, w * 0.7, w * 0.75, w * 0.5, h - base, Surf.Rubble, col, { rz: rng.range(-0.04, 0.04), ox: rng.range(-0.08, 0.08) });
  k.col(0, base, 0, w, h - base, w * 0.7, true);
  runes(k, 0, h * 0.25, w * 0.33 + 0.02, h * 0.5, rng);
  k.pop();
}

function hall(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const s = c.s;
  const role = c.b.role;
  const flat = role === 'watchtower';
  const winSpacing = 5.5 * s;
  const roofSurf = c.roof.surf === Surf.Turf || c.roof.surf === Surf.Thatch || c.roof.surf === Surf.Hide ? c.roof.surf : Surf.Turf;
  const spec = shellSpec(c, {
    walls: [{ surf: Surf.Rubble, col: jitter(c.rng.pick(STONE), c.rng, 0.04) }],
    storey: flat ? c.storey : c.storey * (role === 'hall' || role === 'temple' ? 1.25 : 1),
    jetty: 0,
    porch: null,
    balcony: false,
    plinth: 0.3,
    door: doorLook(c, { surf: Surf.Planks, col: jitter(0x5a4430, c.rng, 0.08), frameSurf: Surf.Rubble, frameCol: 0x7a766c, arch: false, bands: true }),
    win: windowLook(c, { shape: 'slit', spacing: winSpacing, lit: 1.8, glow: 0xffa860, frameSurf: Surf.Rubble, frameCol: 0x7a766c, shutterCol: null, flowerbox: false }),
    roof: flat
      ? roofLook(c, 'flat', { surf: Surf.Rubble, col: 0x8a867c, crenel: true, trimSurf: Surf.Rubble, trimCol: 0x7a766c })
      : roofLook(c, 'gable', { surf: roofSurf, col: roofSurf === Surf.Turf ? jitter(0x6a8040, c.rng, 0.08) : c.roof.col, overhang: 0.8 * s, thick: 0.6, pitch: c.rng.range(0.7, 1.0), trimSurf: Surf.Bark, trimCol: 0x5a4430, dormers: 0, finial: false }),
  });
  const out = buildShell(k, spec);
  const t = spec.wallT;
  const H = out.wallTop;
  const dl = spec.door!;
  // Irregular stone courses proud of each wall (skip door & window openings).
  for (let side = 0; side < 4; side++) {
    for (let f = 0; f < out.walls.length; f++) {
      k.use(out.walls[f][side]);
      const L = side % 2 === 0 ? c.w : c.d - 2 * t;
      const y0 = f * spec.storey;
      const Hf = spec.storey;
      if (side === 0) k.push(0, y0, c.d / 2 - t / 2, 0);
      else if (side === 1) k.push(c.w / 2 - t / 2, y0, 0, Math.PI / 2);
      else if (side === 2) k.push(0, y0, -c.d / 2 + t / 2, Math.PI);
      else k.push(-c.w / 2 + t / 2, y0, 0, -Math.PI / 2);
      const n = Math.max(0, Math.floor((L - 0.8) / winSpacing));
      const gaps: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + ((i + 0.5) * L) / n;
        gaps.push([x - 0.4, x + 0.4]);
      }
      if (side === 0 && f === 0) gaps.push([dl.x - dl.w / 2 - 0.9, dl.x + dl.w / 2 + 0.9]);
      let y = 0;
      let course = 0;
      while (y < Hf - 0.2) {
        const ch = Math.min(Hf - y, c.rng.range(0.7, 1.1) * s);
        let x = -L / 2 + (course % 2 ? c.rng.range(0.2, 0.8) : 0);
        while (x < L / 2 - 0.3) {
          const bl = Math.min(L / 2 - x, c.rng.range(1.1, 2.4) * s);
          const mid = x + bl / 2;
          const blocked = gaps.some(([a, b]) => x + bl > a && x < b) && y < (side === 0 && f === 0 ? dl.h + 0.6 : Hf);
          if (!blocked) k.boxC(mid, y + ch / 2, t / 2 + c.rng.range(0.03, 0.12), bl - 0.06, ch - 0.06, 0.14, Surf.Rubble, jitter(c.rng.pick(STONE), c.rng, 0.06), { rz: c.rng.range(-0.02, 0.02), ry: c.rng.range(-0.02, 0.02), lod: 1 });
          x += bl;
        }
        y += ch;
        course++;
      }
      k.pop();
    }
  }
  // Trilithon door frame.
  k.use(out.walls[0][0]);
  const fh = dl.h + 0.9 * s;
  for (const sx of [-1, 1]) {
    k.frustum(dl.x + sx * (dl.w / 2 + 0.45 * s), -0.3, c.d / 2 + 0.25, 0.85 * s, 0.7, 0.7 * s, 0.55, fh + 0.3, Surf.Rubble, jitter(0x8c887e, c.rng, 0.05));
    runes(k, dl.x + sx * (dl.w / 2 + 0.45 * s), 0.4, c.d / 2 + 0.62, dl.h * 0.8, c.rng);
  }
  k.box(dl.x, fh - 0.05, c.d / 2 + 0.25, dl.w + 2.4 * s, 0.75 * s, 0.85, Surf.Rubble, jitter(0x8c887e, c.rng, 0.05));
  k.box(dl.x, fh + 0.2, c.d / 2 + 0.68, 1.2, 0.08, 0.02, Surf.Glow, RUNE, { emit: RUNE, emitI: 1.3, lod: 1 });
  // Corner menhirs rising above the eaves.
  k.piece('pillar', 'stone', [out.found], 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) menhir(k, sx * (c.w / 2 + 0.25), sz * (c.d / 2 + 0.25), H + (flat ? 1.6 : 1.1) * s, 1.1 * s, c.rng, sz > 0 ? 0 : Math.PI);
  if (!flat) {
    // Tree-trunk timbers: ridge log, crossed gable ends, purlin stubs.
    k.use(out.roof);
    const along = c.w >= c.d;
    const W = along ? c.w : c.d, D = along ? c.d : c.w;
    const Hr = spec.roof.pitch * (D / 2);
    k.push(0, 0, 0, along ? 0 : Math.PI / 2);
    k.cyl(-W / 2 - 1.2, H + Hr + 0.3, 0, 0.32 * s, 0.28 * s, W + 2.4, Surf.Bark, 0x5a4430, { rz: -Math.PI / 2, seg: 8, lod: 1 });
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 + spec.roof.overhang * 0.7);
      for (const sz of [-1, 1]) k.pole(x, H + Hr * 0.3, sz * D * 0.32, x, H + Hr + 1.8 * s, -sz * D * 0.1, 0.24 * s, 0.16 * s, Surf.Bark, 0x5a4430, { seg: 7, lod: 1 });
      for (const sz of [-1, 1]) k.cyl(x - sx * 0.2, H + Hr * 0.5, sz * D * 0.22, 0.2, 0.2, 0.6, Surf.Bark, 0x4e3a28, { rz: (sx * Math.PI) / 2, seg: 6, lod: 1 });
    }
    k.pop();
    k.smoke(0, H + Hr + 0.6, 0);
  }
  // Hall/temple forecourt: a pair of great standing stones.
  if (role === 'hall' || role === 'temple' || role === 'shrine') {
    k.piece('deco', 'stone', [out.found], 0);
    for (const sx of [-1, 1]) menhir(k, dl.x + sx * (dl.w / 2 + 3 * s), c.d / 2 + 3 * s, 4.5 * s, 1.3 * s, c.rng);
    k.light(dl.x, 2.4 * s, c.d / 2 + 2, RUNE, 2.5, 9, false, 0.1);
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

export const buildMegalith: StyleBuilder = (k: Kit, c: BuildCtx) => {
  if (c.b.round) {
    const spec = roundSpec(c, {
      walls: [{ surf: Surf.Rubble, col: jitter(c.rng.pick(STONE), c.rng, 0.05) }],
      roof: roofLook(c, 'conical', { surf: Surf.Turf, col: jitter(0x6a8040, c.rng, 0.08), pitch: c.b.role === 'mage_tower' ? 1.4 : 0.9, overhang: 0.6 }),
      taper: c.b.role === 'mill' ? 0.84 : 0.9,
      win: windowLook(c, { shape: 'slit', lit: 1.8, glow: 0xffa860 }),
      door: doorLook(c, { x: 0, surf: Surf.Planks, col: jitter(0x5a4430, c.rng, 0.08), frameSurf: Surf.Rubble, frameCol: 0x7a766c, arch: false, bands: true }),
    });
    const out = buildRound(k, spec);
    if (c.b.role === 'mill') windmillSails(k, c, out, spec.r * spec.taper);
    k.piece('pillar', 'stone', [out.found], 0);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.6;
      menhir(k, Math.sin(a) * (spec.r + 1.2), Math.cos(a) * (spec.r + 1.2), c.rng.range(2.2, 3.6) * c.s, 0.8 * c.s, c.rng, a);
    }
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }
  return hall(k, c);
};

/** Far LOD: massive low block with a heavy roof and corner menhirs. */
export const silhouetteMegalith: ((k: Kit, c: BuildCtx) => void) | undefined = (k: Kit, c: BuildCtx) => {
  const b = c.b;
  const gmin = Math.min(...(b.ground ?? [0, 0, 0, 0]));
  const H = (b.floors ?? 1) * c.storey;
  if (b.round) {
    const r = b.size[0] / 2;
    k.cyl(0, gmin, 0, r, r * 0.9, H - gmin, Surf.Rubble, 0x8c887e, { seg: 8 });
    k.cyl(0, H, 0, r + 0.6, 0, r * 1.3, Surf.Turf, 0x6a8040, { seg: 8 });
    return;
  }
  k.box(0, gmin, 0, b.size[0], H - gmin, b.size[1], Surf.Rubble, 0x8c887e);
  const along = b.size[0] >= b.size[1];
  const span = along ? b.size[1] : b.size[0];
  if (along) k.frustum(0, H - 0.3, 0, b.size[0] + 1.6, b.size[1] + 1.6, b.size[0] + 1.6, 0, span * 0.45, Surf.Turf, 0x6a8040);
  else k.frustum(0, H - 0.3, 0, b.size[0] + 1.6, b.size[1] + 1.6, 0, b.size[1] + 1.6, span * 0.45, Surf.Turf, 0x6a8040);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(sx * (b.size[0] / 2 + 0.3), gmin, sz * (b.size[1] / 2 + 0.3), 1.2, H + 1.5 - gmin, 1.0, Surf.Rubble, 0x8a867c);
  if (c.rng.chance(0.75)) k.box(0, H * 0.4, b.size[1] / 2 + 0.03, 0.4, 1.0, 0.06, Surf.Window, 0x30384a, { emit: 0xffa860, emitI: 2.2, night: true });
  void scaleHex;
};
