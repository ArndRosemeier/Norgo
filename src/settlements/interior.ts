/**
 * Interior planner: furnishes a building footprint by role (beds for every
 * resident, hearths, bars, forges, altars, pews, bookcases...) and derives the
 * NPC smart spots from the furniture. Pure and deterministic — the layout calls
 * it so spots exist on the server, the blueprint builds the same furniture.
 *
 * Coordinates are building-local (x right, +z toward the front door, y = floor
 * height of the storey). Furniture `yaw` uses rotation.y semantics with 0
 * facing local +z: items against the back wall face the door.
 */
import type { BuildingInfo, BuildingRole, FurnitureInfo, FurnitureKind, SmartSpot } from './types';
import { Rng } from '../core/rng';
import { stairRect } from './build/shell';
import { rotXZ } from './build/kit';

/** Base footprints (w along the wall, d away from it) before race scale. */
const SIZE: Record<FurnitureKind, [number, number]> = {
  bed: [1.0, 2.0], bunk: [1.0, 2.0], table: [1.3, 0.9], longtable: [3.2, 1.0], chair: [0.5, 0.5], stool: [0.4, 0.4], bench: [1.6, 0.45],
  hearth: [1.6, 0.8], shelf: [1.2, 0.4], bookcase: [1.3, 0.45], anvil: [0.5, 0.9], forge: [1.8, 1.2], altar: [1.8, 0.9],
  counter: [3.0, 0.7], barrel: [0.65, 0.65], crate: [0.75, 0.75], chest: [0.95, 0.55], wardrobe: [1.2, 0.6], workbench: [1.9, 0.8],
  cauldron: [0.9, 0.9], rack: [1.4, 0.45], desk: [1.3, 0.7], pew: [2.4, 0.6], throne: [1.2, 1.0], lectern: [0.6, 0.5],
  haybale: [1.3, 0.9], millstone: [1.8, 1.8], sacks: [1.0, 0.7], trough: [2.0, 0.6], rug: [2.2, 1.5], loom: [1.4, 1.0], orb: [0.8, 0.8],
};

interface Grid {
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  cell: number;
  occ: Uint8Array;
}

const CELL = 0.25;

function makeGrid(iw: number, id: number): Grid {
  const nx = Math.max(1, Math.floor(iw / CELL)), nz = Math.max(1, Math.floor(id / CELL));
  return { x0: -iw / 2, z0: -id / 2, nx, nz, cell: CELL, occ: new Uint8Array(nx * nz) };
}

/** Footprint rectangle of an item at (x, z) with yaw (multiples of π/2). */
function rect(x: number, z: number, w: number, d: number, yaw: number): [number, number, number, number] {
  const q = Math.round(yaw / (Math.PI / 2)) & 1;
  const hw = (q ? d : w) / 2, hd = (q ? w : d) / 2;
  return [x - hw, z - hd, x + hw, z + hd];
}

function free(g: Grid, r: [number, number, number, number], round: number): boolean {
  const i0 = Math.floor((r[0] - g.x0) / g.cell + 0.001), i1 = Math.ceil((r[2] - g.x0) / g.cell - 0.001);
  const j0 = Math.floor((r[1] - g.z0) / g.cell + 0.001), j1 = Math.ceil((r[3] - g.z0) / g.cell - 0.001);
  if (i0 < 0 || j0 < 0 || i1 > g.nx || j1 > g.nz) return false;
  for (let j = j0; j < j1; j++)
    for (let i = i0; i < i1; i++) {
      if (g.occ[i + j * g.nx]) return false;
      if (round > 0) {
        // Round rooms: keep cell centres inside the circle.
        const cx = g.x0 + (i + 0.5) * g.cell, cz = g.z0 + (j + 0.5) * g.cell;
        if (cx * cx + cz * cz > round * round) return false;
      }
    }
  return true;
}

function mark(g: Grid, r: [number, number, number, number], v = 1) {
  const i0 = Math.max(0, Math.floor((r[0] - g.x0) / g.cell + 0.001)), i1 = Math.min(g.nx, Math.ceil((r[2] - g.x0) / g.cell - 0.001));
  const j0 = Math.max(0, Math.floor((r[1] - g.z0) / g.cell + 0.001)), j1 = Math.min(g.nz, Math.ceil((r[3] - g.z0) / g.cell - 0.001));
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) g.occ[i + j * g.nx] = v;
}

interface PlanCtx {
  g: Grid;
  iw: number;
  id: number;
  s: number;
  rng: Rng;
  out: FurnitureInfo[];
  round: number;
  y: number;
}

/** Place an item against a wall. Walls: 0 back, 1 right, 2 left, 3 front. Returns the item or null. */
function onWall(c: PlanCtx, kind: FurnitureKind, walls: number[] = [0, 1, 2, 3], prefer: 'center' | 'corner' | 'any' = 'any', gap = kind === 'counter' ? 0.95 : 0.1): FurnitureInfo | null {
  const [bw, bd] = SIZE[kind];
  const w = bw * c.s, d = bd * c.s;
  const cands: [number, number, number, number][] = [];
  for (const wall of walls) {
    const yaw = wall === 0 ? 0 : wall === 1 ? -Math.PI / 2 : wall === 2 ? Math.PI / 2 : Math.PI;
    const along = wall === 0 || wall === 3 ? c.iw : c.id;
    const n = Math.floor((along - w) / CELL);
    for (let i = 0; i <= n; i++) {
      const u = -along / 2 + w / 2 + i * CELL;
      let x: number, z: number;
      const inset = c.round > 0 ? Math.sqrt(Math.max(0, c.round * c.round - u * u)) : 0;
      if (wall === 0) { x = u; z = (c.round > 0 ? -inset : -c.id / 2) + d / 2 + gap; }
      else if (wall === 3) { x = u; z = (c.round > 0 ? inset : c.id / 2) - d / 2 - gap; }
      else if (wall === 1) { z = u; x = (c.round > 0 ? inset : c.iw / 2) - d / 2 - gap; }
      else { z = u; x = (c.round > 0 ? -inset : -c.iw / 2) + d / 2 + gap; }
      const score = prefer === 'center' ? Math.abs(u) : prefer === 'corner' ? -Math.abs(u) : c.rng.float();
      cands.push([x, z, yaw, score + wall * 0.01]);
    }
  }
  cands.sort((a, b) => a[3] - b[3]);
  for (const [x, z, yaw] of cands) {
    const r = rect(x, z, w, d, yaw);
    if (!free(c.g, r, c.round)) continue;
    mark(c.g, r);
    const f: FurnitureInfo = { kind, x, z, y: c.y, yaw, w, d };
    c.out.push(f);
    return f;
  }
  return null;
}

/** Place an item in the open floor (no wall contact needed). */
function inRoom(c: PlanCtx, kind: FurnitureKind, yaw: number, near?: [number, number], margin = 0.5): FurnitureInfo | null {
  const [bw, bd] = SIZE[kind];
  const w = bw * c.s, d = bd * c.s;
  const cands: [number, number, number][] = [];
  for (let z = -c.id / 2 + d / 2 + margin; z <= c.id / 2 - d / 2 - margin; z += CELL)
    for (let x = -c.iw / 2 + w / 2 + margin; x <= c.iw / 2 - w / 2 - margin; x += CELL) {
      const sc = near ? Math.hypot(x - near[0], z - near[1]) : Math.hypot(x, z * 0.8) + c.rng.float() * 0.3;
      cands.push([x, z, sc]);
    }
  cands.sort((a, b) => a[2] - b[2]);
  for (const [x, z] of cands) {
    // Keep a walking margin around room items.
    const r = rect(x, z, w + margin, d + margin, yaw);
    const rr = rect(x, z, w, d, yaw);
    if (!free(c.g, r, c.round)) continue;
    mark(c.g, rr);
    const f: FurnitureInfo = { kind, x, z, y: c.y, yaw, w, d };
    c.out.push(f);
    return f;
  }
  return null;
}

/** Chairs around a table (as many as fit, up to n). */
function chairsAround(c: PlanCtx, t: FurnitureInfo, n: number, kind: FurnitureKind = 'chair') {
  const [bw] = SIZE[kind];
  const cw = bw * c.s;
  const q = Math.round(t.yaw / (Math.PI / 2)) & 1;
  const tw = q ? t.d : t.w, td = q ? t.w : t.d;
  const slots: [number, number, number][] = [];
  const nAlong = kind === 'bench' ? 1 : Math.max(1, Math.floor(tw / 0.7));
  for (let i = 0; i < nAlong; i++) {
    const x = t.x - tw / 2 + ((i + 0.5) * tw) / nAlong;
    slots.push([x, t.z + td / 2 + cw * 0.5, Math.PI], [x, t.z - td / 2 - cw * 0.5, 0]);
  }
  if (kind !== 'bench') slots.push([t.x - tw / 2 - cw * 0.5, t.z, Math.PI / 2], [t.x + tw / 2 + cw * 0.5, t.z, -Math.PI / 2]);
  let placed = 0;
  for (const [x, z, yaw] of slots) {
    if (placed >= n) break;
    const [bw2, bd2] = SIZE[kind];
    const w = kind === 'bench' ? tw : bw2 * c.s, d = bd2 * c.s;
    const r = rect(x, z, w, d, yaw);
    if (!free(c.g, r, c.round)) continue;
    mark(c.g, r);
    // Chairs face the table: yaw points from the chair toward the table centre.
    c.out.push({ kind, x, z, y: c.y, yaw: kind === 'bench' ? yaw : Math.atan2(t.x - x, t.z - z), w, d });
    placed++;
  }
}

export interface InteriorPlan {
  furniture: FurnitureInfo[];
  /** Local x of the hearth on the back wall (chimney) or null. */
  hearthX: number | null;
}

export interface InteriorInput {
  role: BuildingRole;
  w: number;
  d: number;
  t: number;
  floors: number;
  storey: number;
  scale: number;
  doorX: number;
  doorW: number;
  residents: number;
  round: boolean;
  /** Whether the culture uses an indoor hearth with chimney (vs a fire pit / none). */
  hearth: 'wall' | 'pit' | 'none';
  stairs: boolean;
  seed: number;
}

/** Furnish a building. */
export function planInterior(p: InteriorInput): InteriorPlan {
  const rng = new Rng(p.seed);
  const iw = p.w - 2 * p.t - 0.1, id = p.d - 2 * p.t - 0.1;
  const g = makeGrid(iw, id);
  const round = p.round ? Math.min(iw, id) / 2 - 0.05 : 0;
  const c: PlanCtx = { g, iw, id, s: p.scale, rng, out: [], round, y: 0 };
  // Door clearance.
  mark(g, [p.doorX - p.doorW / 2 - 0.4, id / 2 - 1.5 * p.scale, p.doorX + p.doorW / 2 + 0.4, id / 2 + 0.1]);
  if (p.stairs && p.floors > 1) {
    const [x0, z0, x1, z1] = stairRect(p.w, p.d, p.t, p.storey);
    mark(g, [x0 - 0.1, z0 - 0.6, x1 + 0.4, z1 + 0.6]);
  }
  if (p.round && p.floors > 1) {
    // Spiral stair along the back-left wall of towers (see build/round.ts).
    for (let j = 0; j < g.nz; j++)
      for (let i = 0; i < g.nx; i++) {
        const x = g.x0 + (i + 0.5) * CELL, z = g.z0 + (j + 0.5) * CELL;
        let a = Math.atan2(x, z);
        if (a < 0) a += Math.PI * 2;
        if (Math.hypot(x, z) > round - 1.25 && a > Math.PI * 0.45 && a < Math.PI * 1.55) g.occ[i + j * g.nx] = 1;
      }
  }
  let hearthX: number | null = null;
  const addHearth = () => {
    if (p.hearth === 'wall') {
      const h = onWall(c, 'hearth', [0], 'any');
      if (h) hearthX = h.x;
      return h;
    }
    if (p.hearth === 'pit') return inRoom(c, 'cauldron', 0, [0, 0], 0.8);
    return null;
  };
  const beds = (n: number, bunks = false) => {
    let left = n;
    while (left > 0) {
      const useBunk = bunks || (left >= 2 && iw * id < 22 && rng.chance(0.5));
      const b = onWall(c, useBunk ? 'bunk' : 'bed', [1, 2, 0], 'corner', 0.05);
      if (!b) {
        // Fall back to a bedroll anywhere in the room.
        const r = inRoom(c, 'bed', rng.chance(0.5) ? 0 : Math.PI / 2, undefined, 0.2);
        if (!r) break;
      }
      left -= b && useBunk ? 2 : 1;
    }
  };
  const many = (kind: FurnitureKind, n: number, walls?: number[]) => {
    for (let i = 0; i < n; i++) onWall(c, kind, walls);
  };

  switch (p.role) {
    case 'tavern': {
      const bar = onWall(c, 'counter', [0, 1, 2], 'center');
      if (bar) {
        // Barrels behind the bar.
        many('barrel', 2, [0]);
      }
      addHearth();
      const n = Math.max(1, Math.floor((iw * id) / 14));
      for (let i = 0; i < n; i++) {
        const t = inRoom(c, rng.chance(0.3) ? 'longtable' : 'table', rng.chance(0.5) ? 0 : Math.PI / 2, undefined, 0.6);
        if (t) chairsAround(c, t, t.kind === 'longtable' ? 2 : 4, t.kind === 'longtable' ? 'bench' : rng.chance(0.5) ? 'chair' : 'stool');
      }
      beds(Math.max(1, p.residents));
      many('crate', 1);
      break;
    }
    case 'smithy': {
      onWall(c, 'forge', [0], 'center', 0.05);
      const f = c.out[c.out.length - 1];
      if (f && f.kind === 'forge') hearthX = f.x;
      inRoom(c, 'anvil', Math.PI / 2, [f ? f.x : 0, f ? f.z + 1.8 : 0], 0.4);
      onWall(c, 'workbench', [1, 2]);
      onWall(c, 'rack', [1, 2]);
      onWall(c, 'barrel', [1, 2]);
      beds(p.residents);
      many('chest', 1);
      break;
    }
    case 'temple':
    case 'shrine': {
      onWall(c, 'altar', [0], 'center', 0.3);
      if (p.role === 'temple') {
        onWall(c, 'lectern', [0], 'center', 1.6);
        for (let row = 0; row < 6; row++) {
          const z = -id / 2 + 2.8 * p.scale + row * 1.25 * p.scale;
          if (z > id / 2 - 2) break;
          for (const sx of [-1, 1]) {
            const x = sx * Math.min(iw / 4 + 0.2, 1.6 * p.scale);
            const r = rect(x, z, SIZE.pew[0] * p.scale, SIZE.pew[1] * p.scale, Math.PI);
            if (free(g, r, round)) {
              mark(g, r);
              c.out.push({ kind: 'pew', x, z, y: 0, yaw: Math.PI, w: SIZE.pew[0] * p.scale, d: SIZE.pew[1] * p.scale });
            }
          }
        }
      }
      beds(p.residents);
      many('chest', 1, [1, 2]);
      onWall(c, 'shelf', [1, 2]);
      break;
    }
    case 'barracks': {
      beds(p.residents, true);
      many('rack', 2);
      const t = inRoom(c, 'table', 0, undefined, 0.5);
      if (t) chairsAround(c, t, 4, 'stool');
      many('chest', 2);
      break;
    }
    case 'library': {
      const n = Math.max(3, Math.floor((iw + id) / 1.6));
      many('bookcase', n);
      for (let i = 0; i < Math.max(1, Math.floor((iw * id) / 16)); i++) {
        const t = inRoom(c, 'desk', rng.chance(0.5) ? 0 : Math.PI, undefined, 0.6);
        if (t) chairsAround(c, t, 2, 'chair');
      }
      onWall(c, 'lectern', [0]);
      beds(p.residents);
      break;
    }
    case 'mage_tower': {
      inRoom(c, 'orb', 0, [0, 0], 0.4);
      many('bookcase', 2);
      onWall(c, 'desk', [1, 2, 0]);
      onWall(c, 'cauldron', [0, 1, 2]);
      beds(p.residents);
      many('chest', 1);
      break;
    }
    case 'workshop': {
      many('workbench', 2);
      if (rng.chance(0.5)) onWall(c, 'loom');
      onWall(c, 'shelf');
      many('crate', 2);
      beds(p.residents);
      addHearth();
      break;
    }
    case 'warehouse': {
      for (let i = 0; i < 10; i++) {
        const k: FurnitureKind = rng.pick(['crate', 'crate', 'barrel', 'sacks']);
        if (!onWall(c, k) && !inRoom(c, k, rng.chance(0.5) ? 0 : Math.PI / 2, undefined, 0.3)) break;
      }
      onWall(c, 'counter', [3, 1], 'any');
      beds(p.residents);
      break;
    }
    case 'barn':
    case 'stable': {
      many(p.role === 'stable' ? 'trough' : 'haybale', p.role === 'stable' ? 2 : 4);
      many(p.role === 'stable' ? 'haybale' : 'sacks', 2);
      onWall(c, 'rack');
      beds(p.residents);
      break;
    }
    case 'mill': {
      inRoom(c, 'millstone', 0, [0, -0.5], 0.4);
      many('sacks', 3);
      many('barrel', 1);
      beds(p.residents);
      break;
    }
    case 'hall':
    case 'longhouse': {
      if (p.role === 'hall') onWall(c, 'throne', [0], 'center', 0.4);
      const lt = inRoom(c, 'longtable', p.d > p.w ? Math.PI / 2 : 0, [0, 0.4], 0.6);
      if (lt) chairsAround(c, lt, 2, 'bench');
      if (p.hearth === 'wall') addHearth();
      else inRoom(c, 'cauldron', 0, undefined, 0.6);
      beds(p.residents);
      many('chest', 2);
      many('barrel', 1);
      if (p.role === 'longhouse') many('rack', 1);
      break;
    }
    case 'watchtower':
    case 'gate': {
      beds(p.residents);
      onWall(c, 'rack');
      onWall(c, 'chest');
      break;
    }
    case 'market': {
      many('counter', 2, [0, 1, 2]);
      many('crate', 3);
      many('barrel', 2);
      beds(p.residents);
      break;
    }
    default: {
      // Homes: house, hut, burrow, tent, farm.
      beds(p.residents);
      addHearth();
      const t = inRoom(c, p.round && iw < 4 ? 'stool' : 'table', rng.chance(0.5) ? 0 : Math.PI / 2, undefined, 0.45);
      if (t && t.kind === 'table') chairsAround(c, t, Math.min(4, Math.max(2, p.residents)), rng.chance(0.65) ? 'chair' : 'stool');
      onWall(c, 'chest');
      if (rng.chance(0.7)) onWall(c, 'shelf');
      if (rng.chance(0.5)) onWall(c, rng.chance(0.5) ? 'wardrobe' : 'barrel');
      if (p.role === 'farm') {
        many('sacks', 2);
        many('barrel', 1);
      }
      if (rng.chance(0.6)) {
        const r = rect(0, 0, SIZE.rug[0] * p.scale, SIZE.rug[1] * p.scale, 0);
        // Rugs may lie under furniture; only check against walls.
        if (r[0] > -iw / 2 && r[2] < iw / 2) c.out.push({ kind: 'rug', x: 0, z: rng.range(-0.5, 0.5), y: 0, yaw: rng.chance(0.5) ? 0 : Math.PI / 2, w: SIZE.rug[0] * p.scale, d: SIZE.rug[1] * p.scale });
      }
    }
  }

  // Upper storeys: storage & decoration only (no NPC spots).
  for (let f = 1; f < p.floors; f++) {
    const g2 = makeGrid(iw, id);
    const c2: PlanCtx = { ...c, g: g2, y: f * p.storey };
    if (p.stairs) {
      const [x0, z0, x1, z1] = stairRect(p.w, p.d, p.t, p.storey);
      mark(g2, [x0 - 0.1, z0 - 0.4, x1 + 0.4, z1 + 0.4]);
    }
    const kinds: FurnitureKind[] = p.role === 'library' || p.role === 'mage_tower' ? ['bookcase', 'bookcase', 'desk', 'chest'] : ['bed', 'chest', 'shelf', 'crate', 'wardrobe', 'barrel'];
    for (const k of kinds) if (rng.chance(0.75)) onWall(c2, k, [0, 1, 2]);
  }
  return { furniture: c.out, hearthX };
}

/** Smart spots derived from furniture (ground floor only), in world space. */
export function spotsFromFurniture(b: Pick<BuildingInfo, 'id' | 'pos' | 'yaw' | 'role'>, furniture: FurnitureInfo[], scale: number): SmartSpot[] {
  const out: SmartSpot[] = [];
  let n = 0;
  const add = (kind: SmartSpot['kind'], lx: number, lz: number, ly: number, lyaw: number) => {
    const [ox, oz] = rotXZ(lx, lz, b.yaw);
    // Furniture yaw faces (sin, cos); spot yaw uses the "looks toward −Z" convention.
    out.push({ id: `${b.id}:s${n++}`, kind, pos: [b.pos[0] + ox, b.pos[1] + ly, b.pos[2] + oz], yaw: lyaw + b.yaw + Math.PI, building: b.id });
  };
  const front = (f: FurnitureInfo, dist: number): [number, number] => [f.x + Math.sin(f.yaw) * dist, f.z + Math.cos(f.yaw) * dist];
  for (const f of furniture) {
    if (f.y > 0.01) continue;
    switch (f.kind) {
      case 'bed':
        add('bed', f.x, f.z, 0.55 * scale, f.yaw);
        break;
      case 'bunk':
        add('bed', f.x, f.z, 0.5 * scale, f.yaw);
        add('bed', f.x, f.z, 1.55 * scale, f.yaw);
        break;
      case 'chair':
      case 'stool':
      case 'throne':
        add('seat', f.x, f.z, 0, f.yaw);
        break;
      case 'bench': {
        const q = Math.round(f.yaw / (Math.PI / 2)) & 1;
        const len = f.w;
        const m = Math.max(1, Math.floor(len / 0.65));
        for (let i = 0; i < m; i++) {
          const u = -len / 2 + ((i + 0.5) * len) / m;
          add('seat', f.x + (q ? 0 : u), f.z + (q ? u : 0), 0, f.yaw);
        }
        break;
      }
      case 'pew': {
        const m = Math.max(1, Math.floor(f.w / 0.7));
        for (let i = 0; i < m; i++) {
          const [ux, uz] = rotXZ(-f.w / 2 + ((i + 0.5) * f.w) / m, 0, f.yaw);
          add('pray', f.x + ux, f.z + uz, 0, f.yaw);
        }
        break;
      }
      case 'hearth':
      case 'cauldron': {
        const [x, z] = front(f, f.d / 2 + 0.55);
        add('cook', x, z, 0, f.yaw + Math.PI);
        break;
      }
      case 'counter': {
        // Keeper stands behind (wall side), patrons in front.
        const [bx, bz] = front(f, -(f.d / 2 + 0.45));
        add('counter', bx, bz, 0, f.yaw);
        if (b.role === 'tavern' || b.role === 'market') {
          for (const u of [-0.9, 0, 0.9]) {
            const [ux, uz] = rotXZ(u * scale, 0, f.yaw);
            const [fx, fz] = front(f, f.d / 2 + 0.45);
            add(b.role === 'tavern' ? 'drink' : 'market', fx + ux, fz + uz, 0, f.yaw + Math.PI);
          }
        }
        break;
      }
      case 'anvil':
      case 'forge': {
        const [x, z] = front(f, f.d / 2 + 0.6);
        add('forge', x, z, 0, f.yaw + Math.PI);
        break;
      }
      case 'workbench':
      case 'loom':
      case 'millstone':
      case 'trough':
      case 'orb': {
        const [x, z] = front(f, f.d / 2 + 0.5);
        add('work', x, z, 0, f.yaw + Math.PI);
        break;
      }
      case 'desk':
      case 'lectern':
      case 'bookcase': {
        const [x, z] = front(f, f.d / 2 + 0.5);
        add('read', x, z, 0, f.yaw + Math.PI);
        break;
      }
      case 'altar': {
        const [x, z] = front(f, f.d / 2 + 1.0);
        add('pray', x, z, 0, f.yaw + Math.PI);
        break;
      }
      case 'haybale':
      case 'sacks':
        if (b.role === 'barn' || b.role === 'mill') {
          const [x, z] = front(f, f.d / 2 + 0.5);
          add('work', x, z, 0, f.yaw + Math.PI);
        }
        break;
      default:
        break;
    }
  }
  return out;
}
