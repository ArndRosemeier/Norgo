/**
 * Shared building context & helpers for style builders: deterministic
 * palette picks, door/window/roof looks, furnishing (furniture pieces with
 * supports on the right storey), and the generic palette-driven building that
 * every style can start from (rectangular shell or round tower by role).
 */
import type { ArchStyle, BuildingInfo, Heraldry, RoofKind } from '../types';
import { Rng, deriveSeed } from '../../core/rng';
import { clamp } from '../../core/math';
import { Kit, Surf, jitter, rotXZ, scaleHex, type Blueprint } from './kit';
import { STYLES, RACE_SCALE, type StyleDef } from './styles';
import { buildShell, type DoorLook, type RoofLook, type ShellOut, type ShellSpec, type WallLook, type WindowLook } from './shell';
import { buildRound, type RoundSpec } from './round';
import { buildFurniture, type FurnishCtx } from './furniture';

export interface BuildCtx {
  b: BuildingInfo;
  st: StyleDef;
  /** Secondary style for mixed households (upper storey / roof accents). */
  st2: StyleDef | null;
  s: number;
  rng: Rng;
  her: Heraldry;
  wealth: number;
  w: number;
  d: number;
  floors: number;
  storey: number;
  t: number;
  doorX: number;
  /** Local x of the hearth/forge on the back wall (chimney), or null. */
  hearthX: number | null;
  wall: { surf: Surf; col: number };
  base: { surf: Surf; col: number };
  trim: { surf: Surf; col: number };
  roof: { surf: Surf; col: number };
  doorCol: number;
  furnish: FurnishCtx;
  ground: [number, number, number, number];
}

function pickCol(rng: Rng, cols: number[], amt = 0.05) {
  return jitter(rng.pick(cols), rng, amt);
}

/** Build context for a building (palette choices are stable per building seed). */
export function makeCtx(b: BuildingInfo, her: Heraldry): BuildCtx {
  const st = STYLES[b.style] ?? STYLES.timber;
  const st2 = b.style2 ? STYLES[b.style2] ?? null : null;
  const rng = new Rng(deriveSeed(b.seed, 'bp'));
  const s = RACE_SCALE[b.race] ?? 1;
  const wealth = b.wealth ?? 0.5;
  // Rich households & civic buildings prefer later (nobler) wall/roof options.
  const civic = b.role === 'temple' || b.role === 'hall' || b.role === 'library' || b.role === 'barracks' || b.role === 'mage_tower' || b.role === 'watchtower' || b.role === 'gate' || b.role === 'wall';
  const rough = b.role === 'barn' || b.role === 'stable' || b.role === 'warehouse' || b.role === 'farm' || b.role === 'mill';
  const wi = rough && st.wall.length > 2 ? st.wall.length - 1 : civic && st.wall.length > 1 ? 1 : rng.chance(0.15 + wealth * 0.2) && st.wall.length > 1 ? 1 : 0;
  const wsel = st.wall[clamp(wi, 0, st.wall.length - 1)];
  const ri = clamp(Math.floor(rng.float() * 0.6 * st.roof.length + wealth * st.roof.length * 0.6), 0, st.roof.length - 1);
  const rsel = (st2 && rng.chance(0.5) ? st2.roof : st.roof)[clamp(ri, 0, (st2 ? Math.min(st.roof.length, st2.roof.length) : st.roof.length) - 1)];
  // Door x from the stored world door position.
  let doorX = 0;
  if (b.doors.length) {
    const [lx] = rotXZ(b.doors[0][0] - b.pos[0], b.doors[0][2] - b.pos[2], -b.yaw);
    doorX = Math.abs(lx) < 0.05 ? 0 : lx;
  }
  let hearthX: number | null = null;
  for (const f of b.furniture ?? []) if ((f.kind === 'hearth' || f.kind === 'forge') && f.y === 0 && Math.abs(f.yaw) < 0.01) hearthX = f.x;
  const t = st.wallT * (b.role === 'temple' || b.role === 'hall' ? 1.25 : 1);
  const trim = { surf: st.trim.surf, col: pickCol(rng, st.trim.cols) };
  const base = { surf: st.base.surf, col: pickCol(rng, st.base.cols) };
  return {
    b, st, st2, s, rng, her, wealth,
    w: b.size[0], d: b.size[1], floors: b.floors ?? 1, storey: st.storey * s, t,
    doorX, hearthX,
    wall: { surf: wsel.surf, col: pickCol(rng, wsel.cols) },
    base,
    trim,
    roof: { surf: rsel.surf, col: pickCol(rng, rsel.cols) },
    doorCol: pickCol(rng, st.doorCols, 0.06),
    furnish: {
      st, s, wealth,
      wood: st.trim.surf === Surf.Timber || st.trim.surf === Surf.Bark ? scaleHex(trim.col, 1.5) : 0x8a6a48,
      stone: base.col,
      cloth: rng.pick([0x8a2a2a, 0x2a4a7a, 0x3a6a3a, 0x7a5a2a, 0x5a2a6a, her.field]),
    },
    ground: b.ground ?? [0, 0, 0, 0],
  };
}

export function doorLook(c: BuildCtx, o: Partial<DoorLook> = {}): DoorLook {
  const wide = c.b.role === 'barn' || c.b.role === 'warehouse' || c.b.role === 'stable';
  const grand = c.b.role === 'temple' || c.b.role === 'hall';
  return {
    x: c.doorX,
    w: (wide ? 2.4 : grand ? 2.0 : 1.05) * c.s,
    h: (wide ? 2.8 : grand ? 3.0 : 2.15) * c.s,
    surf: Surf.Planks,
    col: c.doorCol,
    frameSurf: c.trim.surf,
    frameCol: c.trim.col,
    arch: c.st.window === 'arch' || c.st.window === 'pointed' || grand,
    bands: c.wealth > 0.4 || grand || c.st.id === 'stonekeep',
    ...o,
  };
}

/** Window light: deterministic per building (some houses stay dark at night). */
export function windowLook(c: BuildCtx, o: Partial<WindowLook> = {}): WindowLook {
  const shape = c.st.window;
  const lit = c.rng.chance(c.b.role === 'tavern' || c.b.role === 'hall' || c.b.role === 'temple' ? 1 : 0.72) ? 1.3 + c.rng.float() * 0.8 : 0;
  return {
    shape,
    w: (shape === 'slit' ? 0.35 : shape === 'round' ? 0.8 : 0.85) * c.s,
    h: (shape === 'pointed' ? 1.7 : shape === 'arch' ? 1.5 : 1.15) * c.s,
    sill: 0.95 * c.s,
    spacing: (shape === 'slit' ? 2.4 : 2.7) * c.s,
    frameSurf: c.trim.surf,
    frameCol: c.trim.col,
    shutterCol: c.st.id === 'timber' && c.rng.chance(0.6) ? jitter(c.rng.pick(c.st.doorCols), c.rng, 0.08) : null,
    glassCol: 0x5a6878,
    glow: c.st.glow,
    lit,
    flowerbox: (c.st.id === 'timber' || c.st.id === 'burrow' || c.st.id === 'elven') && c.rng.chance(0.3),
    ...o,
  };
}

export function roofLook(c: BuildCtx, kind: RoofKind = c.b.roof ?? 'gable', o: Partial<RoofLook> = {}): RoofLook {
  const pitch = c.rng.range(c.st.pitch[0], c.st.pitch[1]);
  const thatch = c.roof.surf === Surf.Thatch || c.roof.surf === Surf.Turf;
  return {
    kind,
    pitch,
    overhang: (thatch ? 0.6 : 0.45) * c.s,
    surf: c.roof.surf,
    col: c.roof.col,
    thick: thatch ? 0.42 : 0.18,
    trimSurf: c.trim.surf,
    trimCol: c.trim.col,
    dormers: kind === 'gable' && c.wealth > 0.65 && c.w > 7 && c.floors > 1 ? Math.floor(c.w / 3.5) : 0,
    finial: c.wealth > 0.55 || c.b.role === 'temple' || c.b.role === 'mage_tower',
    crenel: c.b.fortification === true || c.st.id === 'stonekeep' || c.b.role === 'watchtower' || c.b.role === 'barracks',
    ...o,
  };
}

/** Wall look for a storey, honouring timber framing and mixed households. */
export function wallLookFor(c: BuildCtx, floor: number, framed: boolean): WallLook {
  const st = floor > 0 && c.st2 ? c.st2 : c.st;
  const wall = floor > 0 && c.st2 ? { surf: st.wall[0].surf, col: jitter(st.wall[0].cols[0], c.rng, 0.05) } : c.wall;
  const look: WallLook = { surf: wall.surf, col: wall.col };
  if (framed && (wall.surf === Surf.Plaster || wall.surf === Surf.Marble)) look.frame = { surf: c.trim.surf, col: c.trim.col, braces: c.rng.chance(0.75), w: 0.18 * c.s };
  if (wall.surf === Surf.StoneBrick || wall.surf === Surf.Basalt) look.quoin = { surf: c.base.surf === Surf.Rubble ? Surf.StoneBrick : c.base.surf, col: scaleHex(wall.col, 0.9) };
  return look;
}

/** Furniture pieces: ground floor items rest on the foundation, upper ones on the slab. */
export function furnishAll(k: Kit, c: BuildCtx, out: ShellOut) {
  for (const f of c.b.furniture ?? []) {
    const floor = Math.round(f.y / c.storey);
    const sup = floor <= 0 ? out.found : out.slabs[floor - 1] ?? out.found;
    buildFurniture(k, f, c.furnish, sup);
  }
}

/** Standard rectangular shell spec from the style palette. */
export function shellSpec(c: BuildCtx, o: Partial<ShellSpec> = {}): ShellSpec {
  const framed = c.st.id === 'timber' && c.wall.surf === Surf.Plaster && c.rng.chance(0.8);
  const walls: WallLook[] = [];
  for (let f = 0; f < c.floors; f++) {
    // Wealthy timber houses: stone ground floor, framed plaster above.
    if (f === 0 && c.floors > 1 && c.st.id === 'timber' && c.wealth > 0.55 && c.rng.chance(0.6)) walls.push({ surf: Surf.StoneBrick, col: jitter(0xb8b0a2, c.rng, 0.05), quoin: { surf: Surf.StoneBrick, col: 0xa49a8a } });
    else walls.push(wallLookFor(c, f, framed));
  }
  const roof = roofLook(c, c.b.roof === 'conical' || c.b.roof === 'dome' || c.b.roof === 'none' ? (c.b.roof === 'none' ? 'none' : 'hip') : c.b.roof ?? 'gable');
  return {
    w: c.w,
    d: c.d,
    floors: c.floors,
    storey: c.storey,
    wallT: c.t,
    scale: c.s,
    ground: c.ground,
    plinth: c.st.plinth * c.s,
    baseSurf: c.base.surf,
    baseCol: c.base.col,
    walls,
    jetty: c.st.id === 'timber' && c.floors > 1 && framed && c.rng.chance(0.55) ? 0.45 * c.s : 0,
    floorSurf: c.st.floor.surf,
    floorCol: jitter(c.st.floor.cols[0], c.rng, 0.05),
    door: doorLook(c),
    backDoor: c.d > 9 && c.rng.chance(0.3),
    win: windowLook(c),
    roof,
    chimneyX: c.hearthX,
    chimneySurf: c.st.id === 'timber' ? Surf.StoneBrick : c.base.surf,
    chimneyCol: c.st.id === 'timber' ? jitter(0x9a6a50, c.rng, 0.08) : scaleHex(c.base.col, 0.95),
    porch: null,
    balcony: false,
    stairs: c.floors > 1,
    ...o,
  };
}

export function roundSpec(c: BuildCtx, o: Partial<RoundSpec> = {}): RoundSpec {
  const r = c.w / 2;
  return {
    r,
    floors: c.floors,
    storey: c.storey,
    wallT: Math.min(c.t, r * 0.25),
    scale: c.s,
    ground: c.ground,
    plinth: c.st.plinth * c.s,
    baseSurf: c.base.surf,
    baseCol: c.base.col,
    walls: [wallLookFor(c, 0, false)],
    floorSurf: c.st.floor.surf,
    floorCol: jitter(c.st.floor.cols[0], c.rng, 0.05),
    door: doorLook(c, { x: 0 }),
    win: windowLook(c),
    roof: roofLook(c, c.b.roof === 'dome' ? 'dome' : 'conical'),
    seg: Math.max(8, Math.min(16, Math.round(r * 2.4))),
    taper: 1,
    stairs: c.floors > 1,
    platform: false,
    ...o,
  };
}

/** Interior volume for sky-occlusion darkening. */
export function interiorOf(c: BuildCtx, out: ShellOut, round = false): Blueprint['interior'] {
  return round ? { hx: c.w / 2 - c.t * 0.5, hz: c.w / 2 - c.t * 0.5, h: out.wallTop, round: true } : { hx: c.w / 2 - c.t * 0.5, hz: c.d / 2 - c.t * 0.5, h: out.wallTop, round: false };
}

/** Style registry type. */
export type StyleBuilder = (k: Kit, c: BuildCtx) => Blueprint['interior'];

export function styleOf(id: ArchStyle): StyleDef {
  return STYLES[id] ?? STYLES.timber;
}
