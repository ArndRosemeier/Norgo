/**
 * Construction kit: the pure (three.js-free) data model every settlement and
 * POI structure is built from, plus a small builder with a transform stack.
 *
 * A *blueprint* is a list of destructible *pieces* (wall sections, roofs,
 * doors, furniture, props...). Each piece owns primitives (`Prim`, meshed by
 * the client), collision boxes, a support list for structural collapse, and
 * optional lights / chimney smoke / animation pivots. Blueprints are generated
 * deterministically from a BuildingInfo, so the server (hit points, support
 * graph, object queries) and every client (meshes, colliders) agree on piece
 * indices and positions without ever sending geometry over the wire.
 *
 * Coordinates are building-local: x right, y up (0 = ground-floor level),
 * +z = front (the main door faces local +z). World = pos + rotY(yaw) · local.
 */
import { Rng } from '../../core/rng';
import { clamp, lerp } from '../../core/math';

// ------------------------------------------------------------------ surfaces

/** Surface (texture layer) ids. The client builds one texture-array layer per id. */
export const enum Surf {
  Plaster = 0,
  Planks = 1,
  Timber = 2,
  StoneBrick = 3,
  Rubble = 4,
  Thatch = 5,
  Shingle = 6,
  Slate = 7,
  Hide = 8,
  Crystal = 9,
  Bark = 10,
  Mushroom = 11,
  Basalt = 12,
  Turf = 13,
  Metal = 14,
  Cloth = 15,
  Window = 16,
  Cobble = 17,
  Soil = 18,
  Bone = 19,
  Carved = 20,
  ClayTile = 21,
  Straw = 22,
  Marble = 23,
  Leaf = 24,
  Glow = 25,
  Rope = 26,
  Fire = 27,
}

export const SURF_COUNT = 28;

/** World-space tile size (m) per surface — texel density for planar UVs. */
export const SURF_TILE: number[] = [
  2.5, // Plaster
  1.6, // Planks
  1.2, // Timber
  2.0, // StoneBrick
  2.2, // Rubble
  2.0, // Thatch
  1.6, // Shingle
  1.6, // Slate
  2.0, // Hide
  1.5, // Crystal
  1.8, // Bark
  2.4, // Mushroom
  2.2, // Basalt
  2.4, // Turf
  1.2, // Metal
  1.0, // Cloth
  1.0, // Window
  2.0, // Cobble
  3.0, // Soil
  1.0, // Bone
  1.6, // Carved
  1.6, // ClayTile
  1.5, // Straw
  2.4, // Marble
  1.6, // Leaf
  1.0, // Glow
  0.6, // Rope
  1.0, // Fire
];

/** Impact/debris material class (matches StaticCollider.material). */
export type PieceMat = 'wood' | 'stone' | 'metal' | 'crystal' | 'flesh' | 'plant' | 'cloth' | 'ice';

export const SURF_MAT: PieceMat[] = [
  'stone', 'wood', 'wood', 'stone', 'stone', 'plant', 'wood', 'stone', 'cloth', 'crystal', 'wood', 'plant', 'stone', 'plant',
  'metal', 'cloth', 'crystal', 'stone', 'stone', 'stone', 'stone', 'stone', 'plant', 'stone', 'plant', 'crystal', 'cloth', 'stone',
];

/** Hit points per cubic meter of piece volume, by material (clamped per piece). */
const HP_DENSITY: Record<PieceMat, number> = {
  wood: 70, stone: 140, metal: 220, crystal: 120, flesh: 50, plant: 35, cloth: 25, ice: 60,
};

// ------------------------------------------------------------------ primitives

export const enum Shape {
  /** Rectangular frustum: bottom w×d, top tw×td, height h, top offset (ox, oz). Anchor = bottom centre. */
  Frustum = 0,
  /** Cylinder / cone: bottom radius a, top radius b, height h, `seg` sides, ellipse scale (sx, sz). Anchor = bottom centre. */
  Cyl = 1,
  /** Ellipsoid section: radii (a, h, b), latitude range [lat0, lat1] (0 = top pole, π = bottom). Anchor = centre. */
  Sphere = 2,
}

/** Level of detail a primitive belongs to: 0 = structure (all LODs), 1 = exterior detail, 2 = interior/furniture. */
export type Lod = 0 | 1 | 2;

export interface Prim {
  shape: Shape;
  x: number;
  y: number;
  z: number;
  /** Rotation, Euler order YXZ (yaw, pitch, roll). */
  ry: number;
  rx: number;
  rz: number;
  /** Shape parameters (see Shape). Frustum: a=w, b=d, c=tw, d=td, h, e=ox, f=oz. Cyl: a=r0, b=r1, h, e=sx, f=sz. Sphere: a=rx, b=rz, h=ry, e=lat0, f=lat1. */
  a: number;
  b: number;
  c: number;
  d: number;
  h: number;
  e: number;
  f: number;
  /** Segment count (cylinders, spheres). */
  seg: number;
  surf: Surf;
  /** sRGB tint (0xRRGGBB). */
  col: number;
  /** Emissive sRGB colour (0 = none) and intensity. */
  emit: number;
  emitI: number;
  /** Emission only at night (lit windows) vs always (crystals, embers). */
  night: boolean;
  lod: Lod;
  /** Smooth shading (spheres, organic forms). */
  smooth: boolean;
}

export interface ColBox {
  /** Box centre (local). */
  x: number;
  y: number;
  z: number;
  /** Half extents. */
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  solid: boolean;
}

export interface LightSpec {
  x: number;
  y: number;
  z: number;
  /** sRGB colour hex. */
  color: number;
  intensity: number;
  radius: number;
  /** Only lit at night (lanterns, window light) vs always (braziers, forges, crystals). */
  night: boolean;
  /** Flicker amount 0..1 (fire). */
  flicker: number;
}

/** Door leaf pivot: rotates about a vertical axis at (x, z) by up to `swing` radians. */
export interface DoorSpec {
  x: number;
  z: number;
  /** Local yaw of the closed leaf. */
  yaw: number;
  swing: number;
  width: number;
  height: number;
}

/** Continuously spinning part (windmill sails, water wheels). Axis is local horizontal at angle `yaw`. */
export interface SpinSpec {
  x: number;
  y: number;
  z: number;
  /** Direction of the spin axis (local yaw; axis = (sin yaw, 0, cos yaw)). */
  yaw: number;
  speed: number;
}

export type PieceKind =
  | 'foundation' | 'wall' | 'floor' | 'roof' | 'gable' | 'door' | 'chimney' | 'tower' | 'stairs' | 'beam' | 'porch' | 'balcony'
  | 'furniture' | 'prop' | 'fence' | 'deco' | 'pillar' | 'platform' | 'spire' | 'tree';

export interface Piece {
  kind: PieceKind;
  mat: PieceMat;
  hp: number;
  prims: Prim[];
  cols: ColBox[];
  /** Indices of pieces that carry this one. */
  sup: number[];
  /** Minimum number of intact supports to stay up (0 = rests on the ground). */
  need: number;
  /** Interaction prompt (door "Open", furniture "Sit"/"Sleep"/"Read"/"Pray"). */
  interact?: string;
  door?: DoorSpec;
  spin?: SpinSpec;
  /** Sways in the wind (banners): pivot at the top edge. */
  sway?: { x: number; y: number; z: number };
  lights: LightSpec[];
  smoke: [number, number, number][];
  /** Bounding sphere (local), computed by `finish`. */
  cx: number;
  cy: number;
  cz: number;
  r: number;
  /** Seat/bed anchor for interact (local), furniture only. */
  seat?: { x: number; y: number; z: number; yaw: number };
}

export interface Blueprint {
  pieces: Piece[];
  /** Interior volume used for darkening inner faces (sky occlusion): half extents & height. */
  interior: { hx: number; hz: number; h: number; round: boolean } | null;
  /** Bounding radius (local, XZ) and max height. */
  radius: number;
  top: number;
}

// ------------------------------------------------------------------ helpers

/** Deterministic colour jitter in sRGB (brightness ± amt, slight hue drift). */
export function jitter(hex: number, rng: Rng, amt = 0.08): number {
  const k = 1 + (rng.float() * 2 - 1) * amt;
  const h = (rng.float() * 2 - 1) * amt * 0.35;
  let r = ((hex >> 16) & 255) * (k + h);
  let g = ((hex >> 8) & 255) * k;
  let b = (hex & 255) * (k - h);
  r = clamp(Math.round(r), 0, 255);
  g = clamp(Math.round(g), 0, 255);
  b = clamp(Math.round(b), 0, 255);
  return (r << 16) | (g << 8) | b;
}

/** Linear blend of two sRGB hex colours. */
export function mixHex(a: number, b: number, t: number): number {
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return (r << 16) | (g << 8) | bl;
}

export function scaleHex(a: number, k: number): number {
  const r = clamp(Math.round(((a >> 16) & 255) * k), 0, 255);
  const g = clamp(Math.round(((a >> 8) & 255) * k), 0, 255);
  const b = clamp(Math.round((a & 255) * k), 0, 255);
  return (r << 16) | (g << 8) | b;
}

/** Yaw that faces a direction (three.js convention: yaw 0 looks toward −Z). */
export function yawToward(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Rotate a local XZ offset by yaw (three.js rotation.y). */
export function rotXZ(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

export interface PrimOpts {
  rx?: number;
  ry?: number;
  rz?: number;
  emit?: number;
  emitI?: number;
  night?: boolean;
  lod?: Lod;
  smooth?: boolean;
  seg?: number;
}

interface Frame {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Builder with a yaw/translation frame stack. All coordinates passed to the
 * primitive helpers are relative to the current frame.
 */
export class Kit {
  readonly pieces: Piece[] = [];
  /** Current piece receiving primitives. */
  cur!: Piece;
  /** Default LOD for new primitives. */
  lod: Lod = 0;
  private f: Frame = { x: 0, y: 0, z: 0, yaw: 0 };
  private stack: Frame[] = [];
  /** Whether to emit geometry (servers can skip it but still need bounds — kept on for exact bounds). */
  readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  // ---- frames

  push(x: number, y: number, z: number, yaw = 0) {
    this.stack.push(this.f);
    const [ox, oz] = rotXZ(x, z, this.f.yaw);
    this.f = { x: this.f.x + ox, y: this.f.y + y, z: this.f.z + oz, yaw: this.f.yaw + yaw };
  }

  pop() {
    const f = this.stack.pop();
    if (f) this.f = f;
  }

  /** Transform a frame-local point to blueprint-local coordinates. */
  toLocal(x: number, y: number, z: number): [number, number, number] {
    const [ox, oz] = rotXZ(x, z, this.f.yaw);
    return [this.f.x + ox, this.f.y + y, this.f.z + oz];
  }

  get frameYaw() {
    return this.f.yaw;
  }

  // ---- pieces

  /** Start a new piece; subsequent primitives go into it. Returns its index. */
  piece(kind: PieceKind, mat: PieceMat, sup: number[] = [], need = sup.length ? 1 : 0): number {
    const p: Piece = { kind, mat, hp: 0, prims: [], cols: [], sup: sup.slice(), need, lights: [], smoke: [], cx: 0, cy: 0, cz: 0, r: 0 };
    this.pieces.push(p);
    this.cur = p;
    return this.pieces.length - 1;
  }

  /** Continue adding to an existing piece. */
  use(index: number) {
    this.cur = this.pieces[index];
  }

  // ---- primitives

  private add(shape: Shape, x: number, y: number, z: number, a: number, b: number, c: number, d: number, h: number, e: number, f: number, surf: Surf, col: number, o?: PrimOpts): Prim {
    const [lx, ly, lz] = this.toLocal(x, y, z);
    const p: Prim = {
      shape, x: lx, y: ly, z: lz, ry: this.f.yaw + (o?.ry ?? 0), rx: o?.rx ?? 0, rz: o?.rz ?? 0,
      a, b, c, d, h, e, f, seg: o?.seg ?? 8, surf, col, emit: o?.emit ?? 0, emitI: o?.emitI ?? 0, night: o?.night ?? false,
      lod: o?.lod ?? this.lod, smooth: o?.smooth ?? shape === Shape.Sphere,
    };
    this.cur.prims.push(p);
    return p;
  }

  /** Axis-aligned (in frame) box; (x, z) centre, y = bottom. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, surf: Surf, col: number, o?: PrimOpts): Prim {
    return this.add(Shape.Frustum, x, y, z, w, d, w, d, h, 0, 0, surf, col, o);
  }

  /** Box given by its centre, with arbitrary rotation about that centre. */
  boxC(cx: number, cy: number, cz: number, w: number, h: number, d: number, surf: Surf, col: number, o: PrimOpts = {}): Prim {
    // Anchor = centre − R·(0, h/2, 0), R = Ry Rx Rz.
    const rx = o.rx ?? 0, rz = o.rz ?? 0, ry = o.ry ?? 0;
    const hy = h / 2;
    // R·(0,hy,0): Rz → (−sin rz·hy, cos rz·hy, 0); Rx → (x, y cos rx, y sin rx); Ry yaw.
    const x1 = -Math.sin(rz) * hy, y1 = Math.cos(rz) * hy;
    const y2 = y1 * Math.cos(rx), z2 = y1 * Math.sin(rx);
    const [x3, z3] = rotXZ(x1, z2, ry);
    return this.add(Shape.Frustum, cx - x3, cy - y2, cz - z3, w, d, w, d, h, 0, 0, surf, col, o);
  }

  /** Frustum: bottom w×d, top tw×td, height h, top offset (ox, oz). */
  frustum(x: number, y: number, z: number, w: number, d: number, tw: number, td: number, h: number, surf: Surf, col: number, o?: PrimOpts & { ox?: number; oz?: number }): Prim {
    return this.add(Shape.Frustum, x, y, z, w, d, tw, td, h, o?.ox ?? 0, o?.oz ?? 0, surf, col, o);
  }

  /** Cylinder/cone with bottom radius r0, top radius r1 (ellipse scale sx/sz). */
  cyl(x: number, y: number, z: number, r0: number, r1: number, h: number, surf: Surf, col: number, o?: PrimOpts & { sx?: number; sz?: number }): Prim {
    return this.add(Shape.Cyl, x, y, z, r0, r1, 0, 0, h, o?.sx ?? 1, o?.sz ?? 1, surf, col, o);
  }

  /** Ellipsoid (section) centred at (x, y, z). lat0/lat1 in [0, π] (0 = top). */
  sphere(x: number, y: number, z: number, rx: number, ry: number, rz: number, surf: Surf, col: number, o?: PrimOpts & { lat0?: number; lat1?: number }): Prim {
    return this.add(Shape.Sphere, x, y, z, rx, rz, 0, 0, ry, o?.lat0 ?? 0, o?.lat1 ?? Math.PI, surf, col, { smooth: true, seg: 12, ...o });
  }

  /** Square beam between two frame-local points. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, surf: Surf, col: number, o?: PrimOpts & { d?: number }): Prim {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    const rx = Math.acos(clamp(dy / len, -1, 1));
    const ry = Math.atan2(dx, dz);
    return this.add(Shape.Frustum, ax, ay, az, w, o?.d ?? w, w, o?.d ?? w, len, 0, 0, surf, col, { ...o, rx, ry: (o?.ry ?? 0) + ry, rz: 0 });
  }

  /** Round pole between two points (cylinder along the segment). */
  pole(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r0: number, r1: number, surf: Surf, col: number, o?: PrimOpts): Prim {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    const rx = Math.acos(clamp(dy / len, -1, 1));
    const ry = Math.atan2(dx, dz);
    return this.add(Shape.Cyl, ax, ay, az, r0, r1, 0, 0, len, 1, 1, surf, col, { seg: 6, ...o, rx, ry: (o?.ry ?? 0) + ry, rz: 0 });
  }

  // ---- colliders, lights, effects

  /** Collision box: (x, z) centre, y = bottom, full sizes. */
  col(x: number, y: number, z: number, w: number, h: number, d: number, solid = true, yaw = 0) {
    const [lx, ly, lz] = this.toLocal(x, y + h / 2, z);
    this.cur.cols.push({ x: lx, y: ly, z: lz, hx: w / 2, hy: h / 2, hz: d / 2, yaw: this.f.yaw + yaw, solid });
  }

  /** Box primitive plus a matching collider. */
  solid(x: number, y: number, z: number, w: number, h: number, d: number, surf: Surf, col: number, o?: PrimOpts): Prim {
    this.col(x, y, z, w, h, d, true, o?.ry ?? 0);
    return this.box(x, y, z, w, h, d, surf, col, o);
  }

  light(x: number, y: number, z: number, color: number, intensity: number, radius: number, night = true, flicker = 0) {
    const [lx, ly, lz] = this.toLocal(x, y, z);
    this.cur.lights.push({ x: lx, y: ly, z: lz, color, intensity, radius, night, flicker });
  }

  smoke(x: number, y: number, z: number) {
    this.cur.smoke.push(this.toLocal(x, y, z));
  }

  door(x: number, z: number, width: number, height: number, swing = 1.6) {
    const [lx, , lz] = this.toLocal(x, 0, z);
    this.cur.door = { x: lx, z: lz, yaw: this.f.yaw, swing, width, height };
    this.cur.interact = 'Open';
  }

  seat(x: number, y: number, z: number, yaw: number, prompt: 'Sit' | 'Sleep' | 'Read' | 'Pray' | 'Use') {
    const [lx, ly, lz] = this.toLocal(x, y, z);
    this.cur.seat = { x: lx, y: ly, z: lz, yaw: this.f.yaw + yaw };
    this.cur.interact = prompt;
  }

  spin(x: number, y: number, z: number, axisYaw: number, speed: number) {
    const [lx, ly, lz] = this.toLocal(x, y, z);
    this.cur.spin = { x: lx, y: ly, z: lz, yaw: this.f.yaw + axisYaw, speed };
  }

  sway(x: number, y: number, z: number) {
    const [lx, ly, lz] = this.toLocal(x, y, z);
    this.cur.sway = { x: lx, y: ly, z: lz };
  }

  // ---- finishing

  /** Compute bounds and hit points; returns the blueprint. */
  finish(interior: Blueprint['interior']): Blueprint {
    let radius = 0, top = 0;
    for (const p of this.pieces) {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let vol = 0;
      for (const q of p.prims) {
        const [cx, cy, cz, r, v] = primBounds(q);
        minX = Math.min(minX, cx - r); maxX = Math.max(maxX, cx + r);
        minY = Math.min(minY, cy - r); maxY = Math.max(maxY, cy + r);
        minZ = Math.min(minZ, cz - r); maxZ = Math.max(maxZ, cz + r);
        vol += v;
      }
      if (!p.prims.length) {
        minX = minY = minZ = maxX = maxY = maxZ = 0;
      }
      p.cx = (minX + maxX) / 2;
      p.cy = (minY + maxY) / 2;
      p.cz = (minZ + maxZ) / 2;
      p.r = Math.max(0.2, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
      if (!p.hp) p.hp = Math.round(clamp(vol * HP_DENSITY[p.mat], 15, p.kind === 'tower' || p.kind === 'foundation' ? 4000 : 1500));
      radius = Math.max(radius, Math.hypot(p.cx, p.cz) + p.r * 0.8);
      top = Math.max(top, maxY);
    }
    return { pieces: this.pieces, interior, radius, top };
  }
}

/** Rough bounding sphere (centre, radius) and solid volume of a primitive. */
export function primBounds(q: Prim): [number, number, number, number, number] {
  let hx: number, hy: number, hz: number, vol: number, cyOff: number;
  if (q.shape === Shape.Frustum) {
    hx = Math.max(q.a, q.c) / 2 + Math.abs(q.e) / 2;
    hz = Math.max(q.b, q.d) / 2 + Math.abs(q.f) / 2;
    hy = q.h / 2;
    cyOff = q.h / 2;
    vol = ((q.a * q.b + q.c * q.d) / 2) * q.h;
  } else if (q.shape === Shape.Cyl) {
    const r = Math.max(q.a, q.b);
    hx = r * q.e;
    hz = r * q.f;
    hy = q.h / 2;
    cyOff = q.h / 2;
    vol = Math.PI * ((q.a + q.b) / 2) ** 2 * q.h * q.e * q.f;
  } else {
    hx = q.a;
    hz = q.b;
    hy = q.h;
    cyOff = 0;
    vol = (4 / 3) * Math.PI * q.a * q.b * q.h * ((Math.cos(q.e) - Math.cos(q.f)) / 2) * 0.5;
  }
  // Rotate the centre offset (0, cyOff, 0) by the prim rotation (yaw-pitch-roll).
  const x1 = -Math.sin(q.rz) * cyOff, y1 = Math.cos(q.rz) * cyOff;
  const y2 = y1 * Math.cos(q.rx), z2 = y1 * Math.sin(q.rx);
  const [x3, z3] = rotXZ(x1, z2, q.ry);
  return [q.x + x3, q.y + y2, q.z + z3, Math.hypot(hx, hy, hz), vol];
}
