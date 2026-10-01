/**
 * Goblin architecture (style 'goblin'): rickety stacked shanties. Every storey
 * is a little offset, twisted and resized, walls are mismatched planks with
 * scrap-metal patches in rusty tints, roofs are lopsided sheds of corrugated
 * scrap, chimneys are crooked metal pipes, upper floors are reached by outside
 * ladders, balconies hang on ropes, junk lanterns glow sickly green-yellow.
 * In swamps (and some lots) the whole shack stands on stilts with a ramp.
 */
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { wallBoxes, windowAt, roof, stairRect, type ShellOut } from './shell';
import { buildRound } from './round';
import { furnishAll, interiorOf, roofLook, roundSpec, windowLook, type BuildCtx, type StyleBuilder } from './common';
import { windmillSails } from './styleTimber';

const SCRAP = [0xb07a4a, 0x9a8a78, 0x8a9094, 0xc08850, 0x7a6a5a, 0xa8603a, 0x6a8a7a];
const PLANKS = [0xa08a6c, 0x8c7458, 0xa89070, 0x7e6a54, 0xb09a78, 0x94806a];
const LANTERN = 0xc8ff60;

function lantern(k: Kit, x: number, y: number, z: number) {
  k.box(x, y + 0.32, z, 0.02, 0.3, 0.02, Surf.Rope, 0x6a5038, { lod: 1 });
  k.cyl(x, y, z, 0.11, 0.09, 0.3, Surf.Window, 0xe8ffc0, { seg: 6, emit: LANTERN, emitI: 3, night: true, lod: 1 });
  k.cyl(x, y + 0.3, z, 0.14, 0.02, 0.1, Surf.Metal, 0x5a4a3e, { seg: 6, lod: 1 });
  k.light(x, y + 0.1, z, LANTERN, 3, 8, true, 0.3);
}

/** Scrap patches & odd planks nailed over a wall face (wall frame: centre line, +z outward). */
function patches(k: Kit, c: BuildCtx, L: number, H: number, t: number) {
  const n = c.rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const metal = c.rng.chance(0.6);
    const pw = c.rng.range(0.5, 1.3), ph = c.rng.range(0.4, 1.1);
    const x = c.rng.range(-L / 2 + pw / 2, L / 2 - pw / 2), y = c.rng.range(0.1, Math.max(0.2, H - ph - 0.1));
    k.boxC(x, y + ph / 2, t / 2 + 0.025, pw, ph, 0.03, metal ? Surf.Metal : Surf.Planks, jitter(c.rng.pick(metal ? SCRAP : PLANKS), c.rng, 0.12), { rz: c.rng.range(-0.15, 0.15), lod: 1 });
  }
}

function shanty(k: Kit, c: BuildCtx): Blueprint['interior'] {
  const { w, d, s } = c;
  const t = 0.16;
  const storey = c.storey;
  const floors = c.floors;
  const gmin = Math.min(...c.ground);
  const stilts = gmin < -0.9;
  const rng = c.rng;

  // ---- foundation: stilts with a deck, or a plank skirt
  const found = k.piece('foundation', 'wood');
  if (stilts) {
    k.solid(0, -0.22, 0, w + 0.5, 0.22, d + 0.5, Surf.Planks, jitter(0x5e5040, rng, 0.08));
    const nx = Math.max(2, Math.ceil(w / 2.2)), nz = Math.max(2, Math.ceil(d / 2.2));
    for (let i = 0; i <= nx; i++)
      for (let j = 0; j <= nz; j++) {
        if (i > 0 && i < nx && j > 0 && j < nz) continue;
        const x = -w / 2 + (i * w) / nx, z = -d / 2 + (j * d) / nz;
        k.pole(x + rng.range(-0.25, 0.25), gmin - 0.5, z + rng.range(-0.25, 0.25), x, -0.2, z, 0.13, 0.11, Surf.Bark, jitter(0x4a3e30, rng, 0.1), { seg: 5 });
        k.col(x, gmin - 0.5, z, 0.3, -gmin + 0.3, 0.3, true);
      }
    // Cross bracing.
    for (const sz of [-1, 1]) {
      k.beam(-w / 2, gmin + 0.2, (sz * d) / 2, w / 2, -0.3, (sz * d) / 2, 0.08, Surf.Timber, 0x4a3e30, { lod: 1 });
      k.beam(w / 2, gmin + 0.2, (sz * d) / 2, -w / 2, -0.3, (sz * d) / 2, 0.08, Surf.Timber, 0x4a3e30, { lod: 1 });
    }
  } else {
    k.solid(0, gmin - 0.4, 0, w + 0.1, -gmin + 0.4, d + 0.1, Surf.Planks, jitter(0x52463a, rng, 0.08));
  }
  k.box(0, 0, 0, w - 2 * t, 0.03, d - 2 * t, Surf.Planks, jitter(0x6a5844, rng, 0.06), { lod: 2 });
  // Ramp / rickety steps up to the door.
  const frontG = Math.min(c.ground[2], c.ground[3]);
  if (frontG < -0.2) {
    const n = Math.min(14, Math.ceil(-frontG / 0.24));
    const sh = -frontG / n;
    for (let i = 0; i < n; i++) {
      const z = d / 2 + 0.25 + (n - i) * 0.3;
      k.solid(c.doorX + rng.range(-0.04, 0.04), frontG + i * sh - 0.08, z, 1.1 * s, 0.08, 0.32, Surf.Planks, jitter(0x6a5844, rng, 0.1), { rz: rng.range(-0.04, 0.04) });
      k.col(c.doorX, frontG + i * sh - 0.3, z, 1.1 * s, sh + 0.3, 0.32, true);
    }
    for (const sx of [-1, 1]) k.pole(c.doorX + sx * 0.55 * s, frontG, d / 2 + 0.3 + n * 0.3, c.doorX + sx * 0.55 * s, 0.9, d / 2 + 0.3, 0.03, 0.03, Surf.Rope, 0x7a6040, { lod: 1, seg: 4 });
  }

  // ---- storeys
  const walls: number[][] = [];
  const slabs: number[] = [];
  const doorW = 0.95 * s, doorH = Math.min(storey - 0.1, 2.0 * s);
  let topFrame = { ox: 0, oz: 0, yaw: 0, w, d };
  const win = windowLook(c, { shape: 'rect', w: 0.6 * s, h: 0.65 * s, sill: 0.9 * s, shutterCol: rng.chance(0.5) ? jitter(rng.pick(PLANKS), rng, 0.1) : null, flowerbox: false, glow: 0xffe070 });
  for (let f = 0; f < floors; f++) {
    const ox = f ? rng.range(-0.35, 0.35) : 0, oz = f ? rng.range(-0.3, 0.3) : 0, yj = f ? rng.range(-0.07, 0.07) : 0;
    const fw = f ? Math.max(3, w + rng.range(-0.7, 0.3)) : w, fd = f ? Math.max(3, d + rng.range(-0.7, 0.3)) : d;
    if (f > 0) {
      const slab = k.piece('floor', 'wood', walls[f - 1], 2);
      const sy = f * storey - 0.18;
      if (f === 1) {
        const [x0, z0, x1, z1] = stairRect(w, d, c.t, c.storey);
        k.solid((x1 + w / 2) / 2, sy, 0, w / 2 - x1, 0.18, d, Surf.Planks, jitter(0x6a5844, rng, 0.08));
        k.solid((-w / 2 + x1) / 2, sy, (z1 + d / 2) / 2, x1 + w / 2, 0.18, d / 2 - z1, Surf.Planks, jitter(0x6a5844, rng, 0.08));
        k.solid((-w / 2 + x1) / 2, sy, (-d / 2 + z0) / 2, x1 + w / 2, 0.18, z0 + d / 2, Surf.Planks, jitter(0x6a5844, rng, 0.08));
      } else k.solid(0, sy, 0, w, 0.18, d, Surf.Planks, jitter(0x6a5844, rng, 0.08));
      // Struts propping the wobbly upper storey.
      for (const sx of [-1, 1]) k.beam(sx * (w / 2), sy - 1.1, d / 2 - 0.1, sx * (fw / 2 + ox * sx), sy, d / 2 + 0.15, 0.09, Surf.Timber, 0x4a3e30, { lod: 1 });
      slabs.push(slab);
    }
    k.push(ox, f * storey, oz, yj);
    const row: number[] = [];
    for (let side = 0; side < 4; side++) {
      const metal = rng.chance(0.25);
      const surf = metal ? Surf.Metal : Surf.Planks;
      const col = jitter(rng.pick(metal ? SCRAP : PLANKS), rng, 0.08);
      const sup = f === 0 ? [found] : [walls[f - 1][side], slabs[f - 1]];
      const pi = k.piece('wall', metal ? 'metal' : 'wood', sup, 1);
      row.push(pi);
      const L = side % 2 === 0 ? fw : fd - 2 * t;
      if (side === 0) k.push(0, 0, fd / 2 - t / 2, 0);
      else if (side === 1) k.push(fw / 2 - t / 2, 0, 0, Math.PI / 2);
      else if (side === 2) k.push(0, 0, -fd / 2 + t / 2, Math.PI);
      else k.push(-fw / 2 + t / 2, 0, 0, -Math.PI / 2);
      const holes = f === 0 && side === 0 ? [{ x: c.doorX, w: doorW, h: doorH }] : [];
      wallBoxes(k, L, storey, t, holes, surf, col);
      const nwin = L > 2.4 ? rng.int(0, L > 4.5 ? 2 : 1) : 0;
      for (let i = 0; i < nwin; i++) {
        const x = -L / 2 + ((i + 0.5) * L) / nwin + rng.range(-0.3, 0.3);
        if (holes.some((o) => Math.abs(o.x - x) < o.w / 2 + 0.6)) continue;
        windowAt(k, x, t, { ...win, lit: rng.chance(0.75) ? 2.4 : 0 });
      }
      patches(k, c, L, storey, t);
      // Corner posts, slightly crooked.
      k.box(-L / 2 + 0.06, 0, t / 2 + 0.02, 0.12, storey, 0.06, Surf.Timber, 0x3e3428, { lod: 1, rz: rng.range(-0.03, 0.03) });
      if (holes.length) {
        const o = holes[0];
        k.box(o.x, o.h, t / 2 + 0.02, o.w + 0.3, 0.12, 0.08, Surf.Timber, 0x3e3428, { lod: 1, rz: rng.range(-0.06, 0.06) });
        lantern(k, o.x + o.w / 2 + 0.35, o.h - 0.2, t / 2 + 0.25);
      }
      k.pop();
    }
    walls.push(row);
    k.pop();
    topFrame = { ox, oz, yaw: yj, w: fw, d: fd };
  }

  // ---- door
  const door = k.piece('door', 'wood', [walls[0][0]], 1);
  k.push(c.doorX, 0, d / 2 - t / 2, 0);
  const lw = doorW - 0.04;
  k.box(0, 0.01, 0, lw, doorH - 0.02, 0.07, Surf.Planks, c.doorCol, { lod: 1 });
  k.box(0, doorH * 0.3, 0.045, lw - 0.08, 0.3, 0.02, Surf.Metal, jitter(rng.pick(SCRAP), rng, 0.1), { lod: 1, rz: 0.08 });
  k.beam(-lw / 2 + 0.05, 0.1, 0.045, lw / 2 - 0.05, doorH - 0.15, 0.045, 0.07, Surf.Planks, scaleHex(c.doorCol, 0.8), { lod: 1, d: 0.02 });
  k.col(0, 0, 0, lw, doorH, 0.1, true);
  k.door(-lw / 2, 0, lw, doorH, 1.7);
  k.pop();

  // ---- interior stairs
  const wallTop = floors * storey;
  if (floors > 1) {
    k.piece('stairs', 'wood', [found], 1);
    const [x0, z0, x1, z1] = stairRect(w, d, c.t, c.storey);
    const n = Math.ceil(storey / 0.2);
    const rise = storey / n, run = (z1 - z0) / n;
    for (let i = 0; i < n; i++) {
      const z = z1 - (i + 0.5) * run;
      k.box((x0 + x1) / 2, i * rise, z, x1 - x0, rise, run, Surf.Planks, jitter(0x6a5844, rng, 0.1), { lod: 2 });
      k.col((x0 + x1) / 2, i * rise, z, x1 - x0, rise, run, true);
    }
    // Outside ladder too (goblins like options).
    k.piece('deco', 'wood', [walls[0][1]], 1);
    for (const sz of [-0.22, 0.22]) k.pole(w / 2 + 0.25, 0, sz, w / 2 + 0.15, wallTop - storey + 0.9, sz, 0.035, 0.035, Surf.Timber, 0x4a3e30, { lod: 1, seg: 4 });
    for (let y = 0.3; y < wallTop - storey + 0.8; y += 0.32) k.box(w / 2 + 0.2, y, 0, 0.05, 0.04, 0.5, Surf.Timber, 0x4a3e30, { lod: 1 });
  }

  // ---- roof (shed on the top storey's frame)
  const top = walls[walls.length - 1];
  const roofPiece = k.piece('roof', 'metal', top, 2);
  k.push(topFrame.ox, 0, topFrame.oz, topFrame.yaw + (rng.chance(0.5) ? 0 : Math.PI));
  const rl = roofLook(c, rng.chance(0.75) ? 'shed' : 'gable', { surf: rng.chance(0.4) ? Surf.Metal : Surf.Planks, col: jitter(rng.pick(SCRAP), rng, 0.1), overhang: 0.35, thick: 0.08, pitch: rng.range(0.35, 0.8), dormers: 0, finial: false });
  const gables: number[] = [];
  const apex = roof(k, rl, topFrame.w, topFrame.d, wallTop, t, { surf: Surf.Planks, col: jitter(rng.pick(PLANKS), rng, 0.08) }, top, gables);
  // Rag flag on a stick.
  k.use(roofPiece);
  k.pole(topFrame.w / 2 - 0.3, apex - 0.2, 0, topFrame.w / 2 - 0.2, apex + 1.6, 0.1, 0.03, 0.02, Surf.Timber, 0x4a3e30, { lod: 1, seg: 4 });
  k.box(topFrame.w / 2 + 0.1, apex + 1.1, 0.1, 0.6, 0.4, 0.02, Surf.Cloth, jitter(c.her.field, rng, 0.2), { lod: 1, rz: 0.1 });
  k.pop();

  // ---- crooked metal chimney pipe
  if (c.hearthX !== null) {
    k.piece('chimney', 'metal', [found], 1);
    const cx = c.hearthX, cz = -d / 2 + t / 2;
    k.solid(cx, 0, cz, 0.8, Math.min(wallTop, storey * 0.9), 0.6, Surf.Rubble, 0x6a645c);
    let px = cx, py = Math.min(wallTop, storey * 0.9), pz = cz - 0.2;
    const endY = apex + 1.1;
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const nx = px + rng.range(-0.35, 0.35), nz = pz - (i === 0 ? 0.3 : rng.range(-0.15, 0.15)), ny = py + (endY - py) / (steps - i);
      k.pole(px, py, pz, nx, ny, nz, 0.14, 0.14, Surf.Metal, jitter(0x5a4a3e, rng, 0.15), { seg: 7 });
      k.sphere(nx, ny, nz, 0.15, 0.15, 0.15, Surf.Metal, 0x4a3e34, { seg: 6, lod: 1 });
      px = nx; py = ny; pz = nz;
    }
    k.cyl(px, py + 0.1, pz, 0.3, 0.05, 0.25, Surf.Metal, 0x6a5040, { seg: 6 });
    k.smoke(px, py + 0.4, pz);
  }

  // ---- hanging balcony with rope rail on the top storey
  if (floors > 1 && rng.chance(0.65)) {
    k.piece('balcony', 'wood', [top[0]], 1);
    k.push(topFrame.ox, wallTop - storey, topFrame.oz, topFrame.yaw);
    const bw = Math.min(topFrame.w * 0.7, 2.6), bz = topFrame.d / 2 + 0.55;
    k.solid(0, -0.1, bz, bw, 0.1, 1.0, Surf.Planks, jitter(0x6a5844, rng, 0.1));
    for (const sx of [-1, 1]) {
      k.pole(sx * bw / 2, 0, bz + 0.45, sx * bw / 2 * 0.9, storey * 0.85, topFrame.d / 2, 0.02, 0.02, Surf.Rope, 0x7a6040, { lod: 1, seg: 4 });
      k.box(sx * bw / 2, 0, bz + 0.45, 0.06, 0.9, 0.06, Surf.Timber, 0x4a3e30, { lod: 1 });
    }
    k.box(0, 0.85, bz + 0.45, bw, 0.03, 0.03, Surf.Rope, 0x7a6040, { lod: 1 });
    lantern(k, bw / 2 - 0.1, 1.3, bz + 0.45);
    k.pop();
  }

  const out: ShellOut = { found, walls, slabs, roof: roofPiece, gables, door, wallTop, ridge: apex, topD: d };
  furnishAll(k, c, out);
  return interiorOf(c, out);
}

export const buildGoblin: StyleBuilder = (k: Kit, c: BuildCtx) => {
  if (c.b.round) {
    const spec = roundSpec(c, {
      walls: [{ surf: Surf.Planks, col: jitter(0x6a5844, c.rng, 0.08) }],
      roof: roofLook(c, c.b.roof === 'dome' ? 'dome' : 'conical', { surf: Surf.Metal, col: jitter(0x8a5a3a, c.rng, 0.1), pitch: 1.0, finial: false }),
      taper: c.b.role === 'mill' ? 0.84 : 0.92,
      win: windowLook(c, { glow: 0xffe070 }),
    });
    const out = buildRound(k, spec);
    if (c.b.role === 'mill') windmillSails(k, c, out, spec.r * spec.taper);
    // Scrap plates riveted around the drum.
    k.use(out.walls[0][1]);
    for (let i = 0; i < 6; i++) {
      const a = c.rng.range(0, Math.PI * 2);
      const r = spec.r + 0.02;
      k.boxC(Math.sin(a) * r, c.rng.range(0.6, out.wallTop - 0.6), Math.cos(a) * r, 0.9, 0.7, 0.03, Surf.Metal, jitter(c.rng.pick(SCRAP), c.rng, 0.12), { ry: a, rz: c.rng.range(-0.2, 0.2), lod: 1 });
    }
    lantern(k, 0.8, 2.0 * c.s, spec.r + 0.3);
    furnishAll(k, c, out);
    return interiorOf(c, out, true);
  }
  return shanty(k, c);
};

/** Far LOD: offset stacked boxes with a shed roof. */
export const silhouetteGoblin: ((k: Kit, c: BuildCtx) => void) | undefined = (k: Kit, c: BuildCtx) => {
  const b = c.b;
  const gmin = Math.min(...(b.ground ?? [0, 0, 0, 0]));
  const floors = b.floors ?? 1;
  const st = c.storey;
  if (b.round) {
    k.cyl(0, gmin, 0, b.size[0] / 2, b.size[0] * 0.45, floors * st - gmin, Surf.Planks, 0x6a5844, { seg: 7 });
    k.cyl(0, floors * st, 0, b.size[0] / 2 + 0.4, 0, b.size[0] * 0.6, Surf.Metal, 0x8a5a3a, { seg: 7 });
    return;
  }
  k.box(0, gmin, 0, b.size[0], -gmin, b.size[1], Surf.Planks, 0x4a3e30);
  for (let f = 0; f < floors; f++) {
    const ox = f ? c.rng.range(-0.35, 0.35) : 0;
    k.box(ox, f * st, 0, b.size[0], st, b.size[1], Surf.Planks, jitter(0x6a5844, c.rng, 0.1), { ry: f ? c.rng.range(-0.07, 0.07) : 0 });
    if (c.rng.chance(0.7)) k.box(ox, f * st + st * 0.45, b.size[1] / 2 + 0.03, 0.6, 0.6, 0.05, Surf.Window, 0x30384a, { emit: 0xffe070, emitI: 2.2, night: true });
  }
  k.boxC(0, floors * st + 0.3, 0, b.size[0] + 0.6, 0.1, b.size[1] + 0.6, Surf.Metal, 0x8a5a3a, { rx: 0.25 });
};
