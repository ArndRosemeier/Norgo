/**
 * Dwarven stonekeep architecture: heavy ashlar halls, low and wide, thick
 * battered walls with carved bands and softly glowing amber runes, massive
 * banded doors under keystoned lintels, flat parapet roofs or low slate hips,
 * squat round towers, earth berms mounded against back and sides (houses dug
 * into the land), stone chimneys with ember glow, brass accents; great halls
 * with stepped pyramidal roofs and ancestor statues flanking the entrance;
 * grand forges with glowing vents and smoking stacks.
 */
import { Rng, deriveSeed } from '../../core/rng';
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { buildShell, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, shellSpec, windowLook, doorLook, type BuildCtx, type StyleBuilder } from './common';
import { figure } from './props';

const RUNE = 0xffa040;
const BRASS = 0xc09a48;

/** Push a frame on the outer face line of a wall side (x along wall, +z outward). */
export function pushFace(k: Kit, side: number, w: number, d: number, y: number) {
  if (side === 0) k.push(0, y, d / 2, 0);
  else if (side === 1) k.push(w / 2, y, 0, Math.PI / 2);
  else if (side === 2) k.push(0, y, -d / 2, Math.PI);
  else k.push(-w / 2, y, 0, -Math.PI / 2);
}

/** Battered (sloped) stone skirt along every wall, split around the front door. */
export function batter(k: Kit, c: BuildCtx, out: ShellOut, h: number, depth: number, surf: Surf, col: number, seam = 0) {
  for (let side = 0; side < 4; side++) {
    k.use(out.walls[0][side]);
    const L = side % 2 === 0 ? c.w : c.d;
    pushFace(k, side, c.w, c.d, 0);
    // Wall segments between this side's door openings (plus a margin for the frame).
    const segs: [number, number][] = [];
    let x0 = -L / 2;
    for (const o of (out.openings ?? []).filter((o) => o.side === side).sort((a, b) => a.x - b.x)) {
      segs.push([x0, o.x - o.w / 2 - 0.35]);
      x0 = o.x + o.w / 2 + 0.35;
    }
    segs.push([x0, L / 2]);
    for (const [a, b] of segs) {
      if (b - a < 0.3) continue;
      const m = (a + b) / 2;
      // Front/back faces flare out over the corners to meet the side faces; never into
      // the door opening (the flare only applies at the wall's real ends).
      const eL = side % 2 === 0 && a <= -L / 2 + 1e-6 ? depth : 0;
      const eR = side % 2 === 0 && b >= L / 2 - 1e-6 ? depth : 0;
      const bm = m + (eR - eL) / 2;
      k.frustum(bm, -0.3, depth / 2, b - a + eL + eR, depth, b - a, 0.06, h + 0.3, surf, col, { ox: m - bm, oz: -depth / 2 + 0.03, lod: 1 });
      if (seam) k.box(m, h * 0.35, depth * 0.62 + 0.01, b - a - 0.2, 0.06, 0.03, Surf.Fire, seam, { emit: seam, emitI: 2.2, lod: 1, rx: -Math.atan2(depth, h) });
    }
    k.pop();
  }
}

/** Carved band with a rune line around the building at height y. */
function runeBand(k: Kit, c: BuildCtx, out: ShellOut, floor: number, y: number) {
  for (let side = 0; side < 4; side++) {
    k.use(out.walls[floor][side]);
    const L = side % 2 === 0 ? c.w : c.d;
    pushFace(k, side, c.w, c.d, y);
    k.box(0, 0, 0.04, L + 0.1, 0.42 * c.s, 0.1, Surf.Carved, scaleHex(c.wall.col, 0.85), { lod: 1 });
    k.box(0, 0.19 * c.s, 0.1, L - 0.4, 0.03, 0.02, Surf.Glow, RUNE, { emit: RUNE, emitI: 0.4, lod: 1 });
    k.pop();
  }
}

/** Keystoned lintel, pilasters and brass studs around the front door. */
function doorSurround(k: Kit, c: BuildCtx, out: ShellOut, dw: number, dh: number) {
  k.use(out.walls[0][0]);
  pushFace(k, 0, c.w, c.d, 0);
  const x = c.doorX;
  const stone = scaleHex(c.wall.col, 0.8);
  for (const sx of [-1, 1]) {
    k.box(x + sx * (dw / 2 + 0.3), 0, 0.12, 0.5, dh + 0.2, 0.26, Surf.Carved, stone, { lod: 1 });
    k.box(x + sx * (dw / 2 + 0.3), dh + 0.2, 0.15, 0.62, 0.22, 0.32, Surf.StoneBrick, stone, { lod: 1 });
  }
  k.box(x, dh + 0.1, 0.15, dw + 1.3, 0.55, 0.34, Surf.StoneBrick, stone, { lod: 1 });
  k.frustum(x, dh + 0.05, 0.36, 0.42, 0.14, 0.62, 0.14, 0.7, Surf.Carved, scaleHex(stone, 1.1), { lod: 1 });
  k.box(x, dh + 0.42, 0.44, 0.18, 0.18, 0.02, Surf.Glow, RUNE, { emit: RUNE, emitI: 1.6, lod: 1 });
  k.pop();
}

/** Earth berm mounded against back and sides: the house is dug into the land. */
function berm(k: Kit, c: BuildCtx, out: ShellOut, h: number) {
  k.piece('deco', 'plant', [out.found], 0);
  const turf = jitter(0x5e7a3a, c.rng, 0.08), rock = jitter(0x7a746a, c.rng, 0.06);
  const dep = 2.6 * c.s;
  // Back.
  k.frustum(0, -0.4, -c.d / 2 - dep / 2 + 0.2, c.w + dep * 2, dep, c.w + 0.4, 0.4, h + 0.4, Surf.Turf, turf, { oz: dep / 2 - 0.25 });
  k.col(0, -0.4, -c.d / 2 - dep / 2 + 0.3, c.w + dep, h * 0.6, dep, true);
  // Sides (lower toward the front).
  for (const sx of [-1, 1]) {
    k.frustum(sx * (c.w / 2 + dep / 2 - 0.2), -0.4, -c.d * 0.1, dep, c.d * 0.8, 0.4, c.d * 0.5, h * 0.75, Surf.Turf, turf, { ox: -sx * (dep / 2 - 0.25), oz: -c.d * 0.12 });
    k.col(sx * (c.w / 2 + dep / 2 - 0.1), -0.4, -c.d * 0.1, dep, h * 0.45, c.d * 0.8, true);
  }
  for (let i = 0; i < 5; i++) {
    const r = new Rng(deriveSeed(c.b.seed, 'rock', i));
    k.sphere(r.range(-c.w / 2, c.w / 2), r.range(0.2, h * 0.5), -c.d / 2 - r.range(1, dep), r.range(0.4, 0.8), r.range(0.3, 0.6), r.range(0.4, 0.8), Surf.Rubble, rock, { seg: 6, lod: 1 });
  }
}

/** Glowing brazier on a stone plinth (always lit). */
export function brazier(k: Kit, x: number, z: number, s: number, fire = 0xff6a10) {
  k.box(x, 0, z, 0.6 * s, 0.7 * s, 0.6 * s, Surf.StoneBrick, 0x6a645c);
  k.cyl(x, 0.7 * s, z, 0.25 * s, 0.4 * s, 0.25 * s, Surf.Metal, 0x4a3a2a, { seg: 8 });
  k.cyl(x, 0.95 * s, z, 0.32 * s, 0.02, 0.6 * s, Surf.Fire, 0xffb050, { emit: fire, emitI: 5, seg: 6 });
  k.col(x, 0, z, 0.6 * s, 1.0 * s, 0.6 * s, true);
  k.light(x, 1.4 * s, z, 0xff8a30, 4, 9, false, 1);
}

/** Massive forge stack with glowing vents on the back wall. */
function forgeStack(k: Kit, c: BuildCtx, out: ShellOut) {
  k.piece('chimney', 'stone', [out.found], 1);
  const x = c.hearthX ?? 0;
  const z = -c.d / 2 - 0.5;
  const top = out.ridge + 3.2 * c.s;
  const col = scaleHex(c.wall.col, 0.85);
  k.frustum(x, -0.3, z, 2.4, 1.8, 1.4, 1.2, top + 0.3, Surf.StoneBrick, col);
  k.col(x, 0, z, 2.2, top, 1.6, true);
  for (let i = 0; i < 3; i++) {
    const y = 1.2 + i * ((top - 2) / 3);
    k.box(x, y, z + 0.92 - (i * 0.3) / 3, 0.5, 0.18, 0.06, Surf.Fire, 0xff7a20, { emit: 0xff5a10, emitI: 3, lod: 1 });
  }
  k.box(x, top, z, 1.6, 0.3, 1.4, Surf.Carved, scaleHex(col, 0.9));
  k.cyl(x, top + 0.3, z, 0.55, 0.45, 0.5, Surf.Metal, BRASS, { seg: 8, lod: 1 });
  k.smoke(x, top + 1.0, z);
  k.smoke(x + 0.2, top + 1.0, z - 0.1);
  k.light(x, top + 0.6, z, 0xff7030, 3, 8, false, 0.8);
}

/** Stepped pyramidal roof over a flat roof (great halls, temples). */
function steppedRoof(k: Kit, c: BuildCtx, out: ShellOut, tiers: number) {
  k.use(out.roof);
  let w = c.w - 1.0, d = c.d - 1.0, y = out.wallTop + 0.3;
  const slate = jitter(0x4a4e58, c.rng, 0.05);
  for (let i = 0; i < tiers; i++) {
    const h = 1.3 * c.s;
    k.frustum(0, y, 0, w, d, w - 1.2, d - 1.2, h, i % 2 ? Surf.Slate : Surf.StoneBrick, i % 2 ? slate : scaleHex(c.wall.col, 0.9));
    k.box(0, y + h - 0.12, 0, w - 1.0, 0.18, d - 1.0, Surf.Carved, scaleHex(c.wall.col, 0.8), { lod: 1 });
    y += h;
    w -= 2.2;
    d -= 2.2;
    if (w < 2 || d < 2) break;
  }
  k.frustum(0, y, 0, Math.max(1.2, w + 1), Math.max(1.2, d + 1), 0, 0, 2.2 * c.s, Surf.Slate, slate);
  k.cyl(0, y + 2.0 * c.s, 0, 0.18, 0.0, 1.2, Surf.Metal, BRASS, { seg: 6, lod: 1 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.sphere(sx * (c.w / 2 - 0.3), out.wallTop + 1.4, sz * (c.d / 2 - 0.3), 0.22, 0.22, 0.22, Surf.Metal, BRASS, { seg: 6, lod: 1 });
}

/** Ancestor statues flanking the entrance. */
function ancestors(k: Kit, c: BuildCtx, out: ShellOut) {
  k.piece('deco', 'stone', [out.found], 0);
  const stone = jitter(0x8e887e, c.rng, 0.04);
  for (const sx of [-1, 1]) {
    const x = c.doorX + sx * (1.9 * c.s + 0.6);
    k.push(x, 0, c.d / 2 + 1.0, 0);
    k.box(0, 0, 0, 1.3, 1.0, 1.3, Surf.Carved, scaleHex(stone, 0.85));
    k.push(0, 1.0, 0, 0);
    figure(k, 1.25 * c.s, stone, c.rng);
    // Beard & axe for dwarven ancestors.
    k.frustum(0, 1.25 * c.s, 0.18, 0.34, 0.1, 0.12, 0.06, 0.6, Surf.Marble, stone, { lod: 1 });
    k.pop();
    k.col(0, 0, 0, 1.3, 3.6 * c.s, 1.3, true);
    k.pop();
  }
}

export const buildStonekeep: StyleBuilder = (k: Kit, c: BuildCtx): Blueprint['interior'] => {
  const b = c.b;
  const role = b.role;
  const s = c.s;
  const stone = { surf: Surf.StoneBrick, col: c.wall.surf === Surf.Carved ? c.wall.col : jitter(c.wall.col, c.rng, 0.03) };

  // ---- round: squat towers (mage tower, round watchtowers)
  if (b.round || role === 'mage_tower' || role === 'mill') {
    const tall = role === 'mage_tower';
    const spec = roundSpec(c, {
      wallT: Math.min(0.9, c.w * 0.14),
      taper: tall ? 0.88 : 0.82,
      seg: 10,
      walls: [stone],
      roof: roofLook(c, tall ? 'conical' : 'flat', { pitch: tall ? 0.9 : 0.5, crenel: true, surf: Surf.Slate, col: jitter(0x4a4e58, c.rng, 0.05), overhang: 0.35, finial: true }),
      platform: role === 'watchtower',
      win: windowLook(c, { shape: 'slit', lit: 2.4, glow: tall ? 0xffc070 : c.st.glow }),
    });
    const out = buildRound(k, spec);
    // Carved bands around each storey.
    for (let f = 0; f < c.floors; f++) {
      k.use(out.walls[f][f % 4]);
      const rr = spec.r * (1 - (1 - spec.taper) * ((f + 0.5) / c.floors)) + 0.06;
      k.cyl(0, f * c.storey + 0.05, 0, rr, rr, 0.35, Surf.Carved, scaleHex(stone.col, 0.85), { seg: 10, lod: 1 });
      k.cyl(0, f * c.storey + 0.2, 0, rr + 0.02, rr + 0.02, 0.04, Surf.Glow, RUNE, { seg: 10, lod: 1, emit: RUNE, emitI: 0.8 });
    }
    k.use(out.found);
    k.frustum(0, -0.4, 0, spec.r * 2 + 1.4, spec.r * 2 + 1.4, spec.r * 2 + 0.1, spec.r * 2 + 0.1, 1.2, Surf.Rubble, scaleHex(c.base.col, 1.05), { lod: 1 });
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }

  // ---- rectangular
  const o: Parameters<typeof shellSpec>[1] = {
    walls: Array.from({ length: c.floors }, (_, f) => ({ surf: f === 0 ? stone.surf : Surf.StoneBrick, col: f === 0 ? stone.col : scaleHex(stone.col, 1.06), quoin: { surf: Surf.Carved, col: scaleHex(stone.col, 0.9) } })),
    win: windowLook(c, { shape: 'slit', w: 0.42 * s, h: 1.3 * s, sill: 1.05 * s, spacing: 2.6 * s, frameSurf: Surf.Carved, frameCol: scaleHex(stone.col, 0.8), shutterCol: null, flowerbox: false }),
    door: doorLook(c, { w: (role === 'hall' || role === 'temple' ? 2.4 : role === 'barn' || role === 'warehouse' || role === 'stable' ? 2.6 : 1.3) * s, h: (role === 'hall' || role === 'temple' ? 3.0 : 2.3) * s, bands: true, arch: false, col: jitter(0x4a3020, c.rng, 0.06), frameSurf: Surf.Carved, frameCol: scaleHex(stone.col, 0.8) }),
    chimneySurf: Surf.StoneBrick,
    chimneyCol: scaleHex(stone.col, 0.82),
  };
  const kind = b.roof === 'gable' ? 'hip' : b.roof ?? 'flat';
  o.roof = roofLook(c, role === 'hall' || role === 'temple' || role === 'barracks' ? 'flat' : kind === 'flat' ? 'flat' : 'hip', {
    pitch: c.rng.range(0.35, 0.55), crenel: role !== 'house' && role !== 'farm', surf: kind === 'flat' ? Surf.StoneBrick : Surf.Slate,
    col: kind === 'flat' ? scaleHex(stone.col, 0.9) : jitter(0x4a4e58, c.rng, 0.05), trimSurf: Surf.Carved, trimCol: scaleHex(stone.col, 0.8), overhang: 0.3, finial: false,
  });
  if (role === 'hall') o.storey = c.storey * 1.7;
  if (role === 'temple') o.storey = c.storey * 1.9;
  if (role === 'smithy') o.chimneyX = null;
  if (role === 'barn' || role === 'stable' || role === 'warehouse') o.storey = c.storey * 1.3;
  const spec = shellSpec(c, o);
  const out = buildShell(k, spec);

  batter(k, c, out, 1.1 * s, 0.55, Surf.Rubble, scaleHex(c.base.col, 1.05));
  runeBand(k, c, out, c.floors - 1, spec.storey * c.floors - (spec.jetty > 0 ? 0.24 : 0) - 0.55 * s);
  if (spec.door) doorSurround(k, c, out, spec.door.w, spec.door.h);

  // Ember glow in the chimney mouth.
  if (spec.chimneyX !== null) {
    k.piece('deco', 'stone', [out.found], 1);
    const top = Math.max(out.wallTop + 1.2, out.ridge - (spec.roof.kind === 'flat' ? -1.2 : 0.2) + 0.6);
    k.box(spec.chimneyX, top + 0.02, -c.d / 2 + spec.wallT / 2, 0.45, 0.06, 0.4, Surf.Fire, 0xff7a20, { emit: 0xff5a10, emitI: 2.5, lod: 1 });
  }
  switch (role) {
    case 'smithy':
      forgeStack(k, c, out);
      break;
    case 'hall':
    case 'temple':
      steppedRoof(k, c, out, role === 'hall' ? 3 : 2);
      ancestors(k, c, out);
      if (role === 'temple') {
        k.use(out.found);
        for (const sx of [-1, 1]) brazier(k, c.doorX + sx * (spec.door!.w / 2 + 3.4 * s), c.d / 2 + 1.4, s);
      }
      break;
    case 'barracks':
    case 'library':
    case 'warehouse':
    case 'market':
      k.use(out.roof);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(sx * (c.w / 2 - 0.4), out.wallTop + 0.3, sz * (c.d / 2 - 0.4), 0.35, 0.35, 1.6, Surf.StoneBrick, scaleHex(stone.col, 0.9), { seg: 8 });
      break;
    default:
      if ((role === 'house' || role === 'farm' || role === 'workshop' || role === 'barn' || role === 'tavern') && c.rng.chance(0.65)) berm(k, c, out, out.wallTop * 0.85);
  }
  if (role === 'tavern') {
    k.use(out.walls[0][0]);
    pushFace(k, 0, c.w, c.d, 0);
    for (const sx of [-1, 1]) {
      k.box(c.doorX + sx * 1.4 * s, 2.3 * s, 0.25, 0.08, 0.5, 0.5, Surf.Metal, BRASS, { lod: 1 });
      k.cyl(c.doorX + sx * 1.4 * s, 1.8 * s, 0.45, 0.14, 0.14, 0.32, Surf.Window, 0xfff0c8, { seg: 6, emit: 0xffb060, emitI: 3, night: true, lod: 1 });
    }
    k.light(c.doorX, 2.2 * s, 0.7, 0xffb060, 3, 8, true, 0.2);
    k.pop();
  }
  furnishAll(k, c, out);
  return interiorOf(c, out);
};

/** Far LOD: low wide block, flat or low-hip roof, slit windows glowing at night. */
export const silhouetteStonekeep = (k: Kit, c: BuildCtx) => {
  const b = c.b;
  const gmin = Math.min(...(b.ground ?? [0, 0, 0, 0]));
  const storey = c.storey * (b.role === 'hall' ? 1.7 : b.role === 'temple' ? 1.9 : 1);
  const H = (b.floors ?? 1) * storey;
  const col = c.wall.col;
  if (b.round) {
    k.cyl(0, gmin, 0, c.w / 2, c.w * 0.41, H - gmin, Surf.StoneBrick, col, { seg: 8 });
    k.cyl(0, H, 0, c.w * 0.45, 0, b.role === 'mage_tower' ? c.w * 0.6 : 0.6, Surf.Slate, 0x4a4e58, { seg: 8 });
  } else {
    k.frustum(0, gmin, 0, c.w + 0.8, c.d + 0.8, c.w, c.d, H - gmin, Surf.StoneBrick, col);
    if (b.role === 'hall' || b.role === 'temple') k.frustum(0, H, 0, c.w - 1, c.d - 1, 1, 1, Math.min(c.w, c.d) * 0.5, Surf.Slate, 0x4a4e58);
    else if (b.roof === 'flat') k.box(0, H, 0, c.w + 0.1, 0.9, c.d + 0.1, Surf.StoneBrick, scaleHex(col, 0.9));
    else k.frustum(0, H - 0.1, 0, c.w + 0.6, c.d + 0.6, Math.max(0.1, c.w - c.d), 0.1, Math.min(c.w, c.d) * 0.22, Surf.Slate, 0x4a4e58);
  }
  if (b.role !== 'barn' && b.role !== 'warehouse' && (deriveSeed(b.seed, 'lit') & 255) < 200) {
    for (const sx of [-0.25, 0.25]) for (const sz of [1, -1]) k.box(sx * c.w, 1.2 * c.s, sz * (c.d / 2 + 0.02), 0.45, 1.1, 0.06, Surf.Window, 0x30384a, { emit: c.st.glow, emitI: 2.2, night: true });
  }
};
