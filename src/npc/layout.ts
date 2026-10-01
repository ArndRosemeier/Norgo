/**
 * Settlement geometry for NPCs: a robust fallback layout (used while the
 * settlement module has not produced one for a site), building footprint tests
 * for "don't walk through walls", and a street graph with A* pathfinding so
 * NPCs walk along streets and roads instead of cutting through houses.
 *
 * Everything here is deterministic from the site seed and pure (no ctx access);
 * the caller passes a terrain height probe.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Vec3 } from '../shared/types';
import type { SiteInfo } from '../world/sites';
import type { ArchStyle, BuildingInfo, BuildingRole, SettlementLayout, SmartSpot } from '../settlements/types';
import type { RaceId } from '../humanoid/types';

export type HeightProbe = (x: number, z: number) => number;

const STYLE_OF: Record<RaceId, ArchStyle> = {
  human: 'timber', elf: 'elven', dwarf: 'stonekeep', orc: 'orcish', halfling: 'burrow', goblin: 'goblin', sylvan: 'sylvan',
  drakeborn: 'drakeborn', umbral: 'umbral', giantkin: 'megalith',
};

const HOME_ROLE_OF: Partial<Record<RaceId, BuildingRole>> = { halfling: 'burrow', goblin: 'hut', orc: 'longhouse', giantkin: 'longhouse', sylvan: 'hut' };

/** Footprint sizes per role [w, d, h]. */
const ROLE_SIZE: Partial<Record<BuildingRole, [number, number, number]>> = {
  house: [7, 8, 6], hut: [5, 5, 4], longhouse: [7, 14, 6], burrow: [6, 6, 3], tent: [4, 4, 3], tavern: [11, 13, 8], smithy: [8, 9, 6],
  market: [10, 8, 4], temple: [11, 16, 11], shrine: [4, 4, 4], barracks: [9, 14, 6], watchtower: [5, 5, 13], farm: [9, 10, 6],
  barn: [9, 12, 7], mill: [7, 7, 10], workshop: [8, 9, 6], library: [10, 11, 9], mage_tower: [7, 7, 18], stable: [8, 12, 5],
  warehouse: [10, 12, 7], hall: [13, 18, 10], well: [2, 2, 2], gate: [6, 3, 8],
};

function jitterRace(site: SiteInfo, rng: Rng): RaceId {
  return (site.race2 && rng.chance(0.3) ? site.race2 : site.race) as RaceId;
}

/**
 * Synthesize a plausible layout around a site: a central plaza with a well,
 * radial streets (plus a ring street for towns/cities), civic buildings near the
 * plaza, homes along the streets, farms at the edge and gate posts at the
 * street ends. Spots mirror what the settlement module provides.
 */
export function synthesizeLayout(site: SiteInfo, height: HeightProbe): SettlementLayout {
  const rng = new Rng(deriveSeed(site.seed, 'npc-fallback-layout'));
  const cx = site.x, cz = site.z;
  const y0 = site.plateau;
  const hAt = (x: number, z: number) => {
    const h = height(x, z);
    return Number.isFinite(h) ? h : y0;
  };
  const R = site.radius;
  const spokes = { hamlet: 3, village: 4, town: 5, city: 6 }[site.size];
  const plazaR = { hamlet: 7, village: 10, town: 14, city: 18 }[site.size];
  const base = rng.float() * Math.PI * 2;
  const angles: number[] = [];
  for (let i = 0; i < spokes; i++) angles.push(base + (i / spokes) * Math.PI * 2 + rng.range(-0.18, 0.18));

  const streets: SettlementLayout['streets'] = [];
  for (const a of angles) {
    const pts: Vec3[] = [];
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const d = plazaR + ((R * 0.98 - plazaR) * s) / steps;
      const bend = Math.sin(s * 0.9 + a * 3) * 0.06;
      const x = cx + Math.cos(a + bend) * d, z = cz + Math.sin(a + bend) * d;
      pts.push([x, hAt(x, z), z]);
    }
    streets.push({ points: pts, width: site.size === 'city' ? 4 : 3 });
  }
  // Plaza ring connects the spoke starts.
  {
    const ring: Vec3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = cx + Math.cos(a) * plazaR, z = cz + Math.sin(a) * plazaR;
      ring.push([x, hAt(x, z), z]);
    }
    streets.push({ points: ring, width: 3 });
  }
  if (site.size === 'town' || site.size === 'city') {
    const ring: Vec3[] = [];
    const rr = R * 0.55;
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      ring.push([x, hAt(x, z), z]);
    }
    streets.push({ points: ring, width: 3 });
  }

  // ---- building program
  const civic: BuildingRole[] = [];
  const add = (r: BuildingRole, n = 1) => {
    for (let i = 0; i < n; i++) civic.push(r);
  };
  switch (site.size) {
    case 'hamlet':
      add('shrine'), add(rng.chance(0.5) ? 'smithy' : 'workshop'), add('farm', 2), add(rng.chance(0.5) ? 'barn' : 'stable');
      if (rng.chance(0.5)) add('tavern');
      break;
    case 'village':
      add('tavern'), add('smithy'), add('market'), add('shrine'), add('farm', 2), add('barn'), add('mill'), add('workshop'), add('watchtower'), add('hall');
      break;
    case 'town':
      add('tavern'), add('smithy'), add('market', 2), add('temple'), add('farm', 2), add('barn'), add('workshop', 2), add('barracks'), add('library'),
        add('hall'), add('warehouse'), add('stable'), add('watchtower', 2), add('mill');
      break;
    case 'city':
      add('tavern', 2), add('smithy', 2), add('market', 3), add('temple'), add('shrine'), add('farm', 3), add('barn'), add('workshop', 3), add('barracks', 2),
        add('library'), add('mage_tower'), add('hall'), add('warehouse', 2), add('stable'), add('watchtower', 3), add('mill');
      break;
  }
  const homes = { hamlet: rng.int(3, 4), village: rng.int(6, 8), town: rng.int(9, 12), city: rng.int(13, 17) }[site.size];

  // Candidate lots along spokes (both sides), ordered by distance from the plaza.
  interface Lot { x: number; z: number; yaw: number; d: number; sx: number; sz: number }
  const lots: Lot[] = [];
  for (const a of angles) {
    const dirX = Math.cos(a), dirZ = Math.sin(a);
    const nX = -dirZ, nZ = dirX;
    for (let d = plazaR + 9; d < R * 0.95; d += 13) {
      for (const side of [-1, 1]) {
        const off = 9.5;
        const x = cx + dirX * d + nX * off * side, z = cz + dirZ * d + nZ * off * side;
        // Face the street: the door side points back towards the spoke.
        const sx = cx + dirX * d, sz = cz + dirZ * d;
        lots.push({ x, z, yaw: Math.atan2(-(sx - x), -(sz - z)), d, sx, sz });
      }
    }
  }
  lots.sort((a, b) => a.d - b.d);

  const buildings: BuildingInfo[] = [];
  const spots: SmartSpot[] = [];
  let lotIdx = 0;
  const outerFirst = (r: BuildingRole) => r === 'farm' || r === 'barn' || r === 'mill' || r === 'stable' || r === 'watchtower';
  const order = [...civic.filter((r) => !outerFirst(r)), ...Array.from({ length: homes }, () => 'house' as BuildingRole)];
  const outer = civic.filter(outerFirst);

  const place = (role: BuildingRole, lot: Lot, idx: number) => {
    const race = jitterRace(site, rng);
    const r: BuildingRole = role === 'house' ? HOME_ROLE_OF[race] ?? 'house' : role;
    const size = ROLE_SIZE[r] ?? [7, 8, 6];
    const y = hAt(lot.x, lot.z);
    const id = `${site.id}:fb${idx}`;
    // Door on the street-facing side (local -Z rotated by yaw → world direction to street).
    const fx = -Math.sin(lot.yaw), fz = -Math.cos(lot.yaw);
    const door: Vec3 = [lot.x + fx * (size[1] / 2 + 0.4), y, lot.z + fz * (size[1] / 2 + 0.4)];
    const residents = r === 'house' || r === 'hut' || r === 'burrow' || r === 'longhouse' ? rng.int(2, r === 'longhouse' ? 7 : 5)
      : r === 'barracks' ? rng.int(3, 5) : r === 'tavern' || r === 'farm' || r === 'hall' ? rng.int(1, 3) : r === 'smithy' || r === 'workshop' ? rng.int(0, 2) : 0;
    const b: BuildingInfo = { id, role: r, style: STYLE_OF[race], race, pos: [lot.x, y, lot.z], yaw: lot.yaw, size, doors: [door], spots: [], residents, pieceCount: 0, seed: deriveSeed(site.seed, 'fb', idx) };
    // Local → world helper (x right, z back).
    const lw = (lx: number, lz: number, yawOff = 0): [Vec3, number] => {
      const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw);
      const wx = lot.x + lx * c + lz * s, wz = lot.z - lx * s + lz * c;
      return [[wx, y, wz], lot.yaw + yawOff];
    };
    let n = 0;
    const spot = (kind: SmartSpot['kind'], lx: number, lz: number, yawOff = 0) => {
      const [p, yw] = lw(lx, lz, yawOff);
      b.spots.push({ id: `${id}:s${n++}`, kind, pos: p, yaw: yw, building: id });
    };
    const w2 = size[0] / 2 - 1, d2 = size[1] / 2 - 1;
    for (let i = 0; i < Math.max(residents, 0); i++) spot('bed', -w2 + ((i % 3) * w2), d2 - Math.floor(i / 3) * 1.6, Math.PI);
    switch (r) {
      case 'smithy': spot('forge', 0, -d2 + 1.5), spot('work', w2 - 0.5, 0); break;
      case 'tavern': spot('counter', 0, -d2 + 2), spot('cook', w2 - 0.5, d2 - 0.5), spot('drink', -w2 + 1, 0), spot('seat', -1, 0.5), spot('seat', 1.5, 1), spot('seat', 1, -1), spot('drink', -w2 + 1, 2); break;
      case 'market': spot('market', -2.5, -d2 - 1.5), spot('market', 2.5, -d2 - 1.5), spot('counter', 0, 0); break;
      case 'temple': spot('pray', 0, d2 - 1), spot('pray', -2, 1), spot('pray', 2, 1), spot('read', w2 - 0.5, d2 - 1); break;
      case 'shrine': spot('pray', 0, -d2 - 1.2, Math.PI); break;
      case 'barracks': spot('guard', 0, -d2 - 1.5), spot('work', 0, 0); break;
      case 'watchtower': spot('guard', 0, -d2 - 1.2); break;
      case 'farm': for (let i = 0; i < 4; i++) spot('farm', -6 + i * 4, d2 + 6 + (i % 2) * 3); break;
      case 'barn': case 'stable': spot('work', 0, -d2 - 2), spot('farm', 3, d2 + 4); break;
      case 'mill': spot('work', 0, -d2 - 1); break;
      case 'workshop': spot('work', -1.5, 0), spot('work', 1.5, -1), spot('counter', 0, -d2 + 1); break;
      case 'library': spot('read', -2, 0), spot('read', 2, 1), spot('seat', 0, -1); break;
      case 'mage_tower': spot('read', 0, 0), spot('work', 1, 1); break;
      case 'warehouse': spot('work', 0, -d2 + 1), spot('counter', 1, -d2 + 1); break;
      case 'hall': spot('seat', 0, d2 - 1.5), spot('counter', 0, 0), spot('seat', -2, 0), spot('seat', 2, 0), spot('cook', w2 - 1, -d2 + 1); break;
      default: spot('seat', 0, 0); spot('cook', w2 - 0.6, -d2 + 0.6);
    }
    buildings.push(b);
  };

  let bi = 0;
  for (const role of order) {
    // Skip lots that collide with an earlier building (dense small hamlets).
    while (lotIdx < lots.length && buildings.some((b) => Math.hypot(b.pos[0] - lots[lotIdx].x, b.pos[2] - lots[lotIdx].z) < 11)) lotIdx++;
    if (lotIdx >= lots.length) break;
    place(role, lots[lotIdx++], bi++);
  }
  // Outer buildings at the far end of lots.
  for (let i = 0; i < outer.length; i++) {
    const a = angles[i % angles.length] + 0.35 + (i >> 2) * 0.25;
    const d = R * (0.82 + (i % 2) * 0.12);
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    place(outer[i], { x, z, yaw: Math.atan2(-(cx - x), -(cz - z)), d, sx: cx, sz: cz }, bi++);
  }

  // ---- free spots: plaza, well, stalls, benches, gates.
  let si = 0;
  const free = (kind: SmartSpot['kind'], x: number, z: number, yaw: number) => spots.push({ id: `${site.id}:fs${si++}`, kind, pos: [x, hAt(x, z), z], yaw });
  free('drink', cx + 1.5, cz, 0);
  for (let i = 0; i < 6; i++) {
    const a = base + (i / 6) * Math.PI * 2 + 0.3;
    free(i % 2 ? 'seat' : 'idle', cx + Math.cos(a) * plazaR * 0.7, cz + Math.sin(a) * plazaR * 0.7, a + Math.PI);
  }
  for (let i = 0; i < (site.size === 'hamlet' ? 1 : site.size === 'village' ? 3 : 5); i++) {
    const a = base + 0.9 + i * 0.7;
    free('market', cx + Math.cos(a) * plazaR * 0.45, cz + Math.sin(a) * plazaR * 0.45, a + Math.PI);
  }
  for (const a of angles) free('guard', cx + Math.cos(a) * R * 0.97, cz + Math.sin(a) * R * 0.97, a + Math.PI);
  free('pray', cx - plazaR * 0.3, cz + plazaR * 0.3, 0);

  const population = buildings.reduce((s, b) => s + b.residents, 0);
  return {
    siteId: site.id, name: site.name, race: site.race as RaceId, race2: (site.race2 as RaceId) ?? null,
    center: [cx, y0, cz], radius: R, buildings, streets, plaza: [cx, hAt(cx, cz), cz], walls: site.walled, spots, population,
    wealth: new Rng(deriveSeed(site.seed, 'wealth')).range(0.15, 0.6) + (site.size === 'city' ? 0.3 : site.size === 'town' ? 0.15 : 0),
    defense: (site.walled ? 0.5 : 0.15) + buildings.filter((b) => b.role === 'barracks' || b.role === 'watchtower').length * 0.1,
  };
}

// ------------------------------------------------------------------ footprints

/** Is (x, z) inside the building footprint, shrunk/grown by `margin`. */
export function insideFootprint(b: BuildingInfo, x: number, z: number, margin = 0): boolean {
  const dx = x - b.pos[0], dz = z - b.pos[2];
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  // World → local (inverse of the rotation used in synthesizeLayout).
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) < b.size[0] / 2 + margin && Math.abs(lz) < b.size[1] / 2 + margin;
}

// ------------------------------------------------------------------ street graph

export interface NavGraph {
  /** Node positions (x, y, z interleaved). */
  pos: Float32Array;
  /** Adjacency lists. */
  adj: number[][];
  count: number;
}

/** Build a walkable graph from street polylines (subdivided, junctions welded). */
export function buildNavGraph(layout: SettlementLayout): NavGraph {
  const pts: Vec3[] = [];
  const adj: number[][] = [];
  const addNode = (p: Vec3) => {
    pts.push(p);
    adj.push([]);
    return pts.length - 1;
  };
  const link = (a: number, b: number) => {
    if (a === b || adj[a].includes(b)) return;
    adj[a].push(b);
    adj[b].push(a);
  };
  for (const st of layout.streets) {
    let prev = -1;
    for (let i = 0; i < st.points.length; i++) {
      const p = st.points[i];
      if (prev >= 0) {
        // Subdivide long segments so the graph offers nearby entry points.
        const q = pts[prev];
        const len = Math.hypot(p[0] - q[0], p[2] - q[2]);
        const n = Math.floor(len / 12);
        for (let k = 1; k <= n; k++) {
          const t = k / (n + 1);
          const m = addNode([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, q[2] + (p[2] - q[2]) * t]);
          link(prev, m);
          prev = m;
        }
      }
      const id = addNode([p[0], p[1], p[2]]);
      if (prev >= 0) link(prev, id);
      prev = id;
    }
  }
  // Weld junctions: nodes of different streets that nearly touch.
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i][0] - pts[j][0], pts[i][2] - pts[j][2]) < 7) link(i, j);
    }
  // Plaza node so the centre is always reachable.
  const plaza = addNode([layout.plaza[0], layout.plaza[1], layout.plaza[2]]);
  let best = -1, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i][0] - layout.plaza[0], pts[i][2] - layout.plaza[2]);
    if (d < 22) link(plaza, i);
    if (d < bd) (bd = d), (best = i);
  }
  if (best >= 0) link(plaza, best);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => pos.set(p, i * 3));
  return { pos, adj, count: pts.length };
}

export function nearestNode(g: NavGraph, x: number, z: number): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.count; i++) {
    const d = (g.pos[i * 3] - x) ** 2 + (g.pos[i * 3 + 2] - z) ** 2;
    if (d < bd) (bd = d), (best = i);
  }
  return best;
}

/** A* over the street graph; returns node indices from a to b (inclusive), or [] when unreachable. */
export function findPath(g: NavGraph, a: number, b: number): number[] {
  if (a < 0 || b < 0) return [];
  if (a === b) return [a];
  const n = g.count;
  const gScore = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open: number[] = [a];
  gScore[a] = 0;
  const h = (i: number) => Math.hypot(g.pos[i * 3] - g.pos[b * 3], g.pos[i * 3 + 2] - g.pos[b * 3 + 2]);
  const fScore = new Float64Array(n).fill(Infinity);
  fScore[a] = h(a);
  let iter = 0;
  while (open.length && iter++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bi]]) bi = i;
    const cur = open[bi];
    if (cur === b) {
      const path = [cur];
      let c = cur;
      while (from[c] >= 0) path.push((c = from[c]));
      return path.reverse();
    }
    open.splice(bi, 1);
    closed[cur] = 1;
    for (const nb of g.adj[cur]) {
      if (closed[nb]) continue;
      const d = gScore[cur] + Math.hypot(g.pos[cur * 3] - g.pos[nb * 3], g.pos[cur * 3 + 2] - g.pos[nb * 3 + 2]);
      if (d < gScore[nb]) {
        gScore[nb] = d;
        from[nb] = cur;
        fScore[nb] = d + h(nb);
        if (!open.includes(nb)) open.push(nb);
      }
    }
  }
  return [];
}

/** Route between two world points via streets (when both are inside the settlement). */
export function routeVia(g: NavGraph, from: Vec3, to: Vec3): Vec3[] {
  const direct = Math.hypot(to[0] - from[0], to[2] - from[2]);
  if (direct < 14 || g.count === 0) return [[to[0], to[1], to[2]]];
  const a = nearestNode(g, from[0], from[2]);
  const b = nearestNode(g, to[0], to[2]);
  const nodes = findPath(g, a, b);
  const out: Vec3[] = [];
  for (const i of nodes) out.push([g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
  // Skip a leading node that is behind us (we may already be past it).
  if (out.length > 1) {
    const d0 = Math.hypot(out[1][0] - from[0], out[1][2] - from[2]);
    const d01 = Math.hypot(out[1][0] - out[0][0], out[1][2] - out[0][2]);
    if (d0 < d01) out.shift();
  }
  // Same for the trailing node relative to the destination.
  if (out.length > 1) {
    const n = out.length;
    const dl = Math.hypot(out[n - 2][0] - to[0], out[n - 2][2] - to[2]);
    const dll = Math.hypot(out[n - 2][0] - out[n - 1][0], out[n - 2][2] - out[n - 1][2]);
    if (dl < dll) out.pop();
  }
  out.push([to[0], to[1], to[2]]);
  return out;
}
