/**
 * Settlement layout generator (pure, deterministic, shared by server & client).
 *
 * From a SiteInfo it grows an organic town plan:
 *  1. Plaza at the centre; main streets follow the real road centre lines the
 *     terrain generator drew toward linked sites (traced via `roadAt`), plus
 *     synthetic spines for dead-end hamlets; ring roads for towns/cities;
 *     meandering side streets branching off them and snapping onto neighbours.
 *  2. Fortifications for walled sites: towers, wall segments, gatehouses where
 *     main streets leave the ring (palisades for orcs/goblins).
 *  3. A culture/size dependent building programme placed onto street frontage
 *     slots by preference (civic buildings around the plaza, crafts along main
 *     streets, farms with fields and mills outside, towers at the edge), then
 *     houses fill the remaining frontage.
 *  4. Interiors (furniture → beds/work/seat spots), props (wells, stalls,
 *     lamps, carts, barrels, gardens, graves, banners...), docks on shores and
 *     bridges where owned roads cross water.
 */
import type { SiteInfo, RoadSegment } from '../world/sites';
import { segDist } from '../world/sites';
import type { RaceId } from '../humanoid/types';
import type { ArchStyle, BuildingInfo, BuildingRole, FieldInfo, PropInfo, PropKind, RoofKind, SettlementLayout, SmartSpot } from './types';
import type { Vec3 } from '../shared/types';
import { Rng, deriveSeed, hashString } from '../core/rng';
import { clamp, lerp } from '../core/math';
import { Biome } from '../world/biomes';
import { SEA_LEVEL } from '../world/constants';
import { RACE_SCALE, RACE_STYLE, STYLES, asRace } from './build/styles';
import { rotXZ, yawToward } from './build/kit';
import { planInterior, spotsFromFurniture } from './interior';
import { buildingTitle, makeHeraldry } from './names';

/** Terrain queries the layout needs (WorldGenerator satisfies them via `terrainFromGenerator`). */
/** Number of fence spans for a run of length L (posts = spans + 1); shared with the builder. */
export function fencePosts(L: number): number {
  return Math.max(1, Math.round(L / 2.2));
}

export interface LayoutTerrain {
  heightAt(x: number, z: number): number;
  /** Road strength 0..1 (as drawn by the terrain generator). */
  roadAt(x: number, z: number): number;
  roadsNear(x: number, z: number, range: number): RoadSegment[];
  /** Roads owned by a site cell (bridges are generated only for owned roads). */
  roadsOfCell(cx: number, cz: number): RoadSegment[];
}

/** Adapter for the world generator (or anything with the same surface). */
export function terrainFromGenerator(gen: {
  heightAt(x: number, z: number): number;
  cachedColumn(x: number, z: number): { road: number };
  sites: { roadsNear(x: number, z: number, r: number): RoadSegment[]; roadsOfCell(cx: number, cz: number): RoadSegment[] };
}): LayoutTerrain {
  return {
    heightAt: (x, z) => gen.heightAt(x, z),
    roadAt: (x, z) => gen.cachedColumn(x, z).road,
    roadsNear: (x, z, r) => gen.sites.roadsNear(x, z, r),
    roadsOfCell: (cx, cz) => gen.sites.roadsOfCell(cx, cz),
  };
}

const SIZE_IDX = { hamlet: 0, village: 1, town: 2, city: 3 } as const;

type P2 = [number, number];

interface Street {
  pts: P2[];
  width: number;
  kind: 'main' | 'ring' | 'side' | 'lane';
}

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  hw: number;
}

interface Foot {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  yaw: number;
}

interface Slot {
  x: number;
  z: number;
  nx: number;
  nz: number;
  hw: number;
  kind: Street['kind'] | 'plaza';
  d0: number;
}

const GRID = 16;

/** Spatial hash for street segments and footprints. */
class Hash<T> {
  private m = new Map<number, T[]>();
  private key(i: number, j: number) {
    return (i & 0xffff) * 65536 + (j & 0xffff);
  }
  add(x0: number, z0: number, x1: number, z1: number, v: T) {
    for (let j = Math.floor(z0 / GRID); j <= Math.floor(z1 / GRID); j++)
      for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) {
        const k = this.key(i, j);
        let a = this.m.get(k);
        if (!a) this.m.set(k, (a = []));
        a.push(v);
      }
  }
  query(x0: number, z0: number, x1: number, z1: number, out: Set<T>) {
    out.clear();
    for (let j = Math.floor(z0 / GRID); j <= Math.floor(z1 / GRID); j++)
      for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) {
        const a = this.m.get(this.key(i, j));
        if (a) for (const v of a) out.add(v);
      }
    return out;
  }
}

function corners(f: Foot): number[] {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  // local x axis → (c, −s), local z axis → (s, c)
  const out: number[] = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = u * f.hw, lz = v * f.hd;
    out.push(f.cx + lx * c + lz * s, f.cz - lx * s + lz * c);
  }
  return out;
}

function sat(a: Foot, b: Foot, margin: number): boolean {
  const ca = corners({ ...a, hw: a.hw + margin / 2, hd: a.hd + margin / 2 });
  const cb = corners({ ...b, hw: b.hw + margin / 2, hd: b.hd + margin / 2 });
  for (const f of [a, b]) {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    for (const [ax, az] of [[c, -s], [s, c]]) {
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let i = 0; i < 8; i += 2) {
        const pa = ca[i] * ax + ca[i + 1] * az;
        const pb = cb[i] * ax + cb[i + 1] * az;
        amin = Math.min(amin, pa); amax = Math.max(amax, pa);
        bmin = Math.min(bmin, pb); bmax = Math.max(bmax, pb);
      }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

function distSeg(px: number, pz: number, s: Seg): number {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((px - s.ax) * dx + (pz - s.az) * dz) / l2, 0, 1);
  return Math.hypot(px - (s.ax + dx * t), pz - (s.az + dz * t));
}

/** Footprint & storey programme for a role in a style (meters, before race scale). */
function sizeFor(role: BuildingRole, style: ArchStyle, si: number, rng: Rng): { w: number; d: number; floors: number; round: boolean } {
  const st = STYLES[style];
  const fl = () => rng.int(st.floors[0], st.floors[1]);
  const r = (a: number, b: number) => rng.range(a, b);
  const roundHome = style === 'orcish' || style === 'sylvan' || style === 'burrow';
  switch (role) {
    case 'house': {
      if (roundHome) {
        const s = style === 'burrow' ? r(7, 9.5) : r(5.5, 7.5);
        return { w: s, d: s, floors: style === 'sylvan' ? fl() : 1, round: true };
      }
      if (style === 'goblin') return { w: r(4.5, 6), d: r(4.5, 6.5), floors: fl(), round: false };
      return { w: r(5.2, 7.2), d: r(6.2, 9.0), floors: Math.min(fl(), si >= 2 ? 3 : 2), round: false };
    }
    case 'hut':
      return style === 'goblin' ? { w: r(4.2, 5.6), d: r(4.4, 6), floors: rng.int(1, 3), round: false } : { w: r(5, 6.5), d: 0, floors: 1, round: true };
    case 'burrow': {
      const s = r(7, 9.5);
      return { w: s, d: s, floors: 1, round: true };
    }
    case 'tent': {
      const s = r(4, 5.2);
      return { w: s, d: s, floors: 1, round: true };
    }
    case 'longhouse':
      return { w: r(7.5, 9.5), d: r(14, 20), floors: 1, round: false };
    case 'tavern':
      return { w: r(9, 12), d: r(10, 13), floors: Math.max(1, Math.min(2, st.floors[1])), round: false };
    case 'smithy':
      return { w: r(7, 9), d: r(7, 9), floors: 1, round: false };
    case 'temple':
      return { w: r(10, 13), d: r(16, 21), floors: 1, round: false };
    case 'shrine':
      return { w: r(4.5, 5.5), d: r(5, 6.5), floors: 1, round: false };
    case 'barracks':
      return { w: r(9, 11), d: r(12, 15), floors: Math.min(2, st.floors[1]), round: false };
    case 'watchtower': {
      const s = r(4.4, 5.4);
      return { w: s, d: s, floors: 3, round: style === 'elven' || style === 'umbral' || style === 'timber' ? rng.chance(0.6) : false };
    }
    case 'farm':
      return roundHome ? { w: r(7, 8.5), d: 0, floors: 1, round: true } : { w: r(7, 9), d: r(8, 10), floors: 1, round: false };
    case 'barn':
      return { w: r(8, 10), d: r(11, 14), floors: 1, round: false };
    case 'mill':
      return { w: r(5.5, 6.5), d: 0, floors: 2, round: true };
    case 'workshop':
      return { w: r(6, 8), d: r(7, 9), floors: Math.min(fl(), 2), round: false };
    case 'library':
      return { w: r(9, 12), d: r(10, 13), floors: Math.min(2, Math.max(1, st.floors[1])), round: false };
    case 'mage_tower': {
      const s = r(6.5, 8);
      return { w: s, d: s, floors: rng.int(4, 6), round: true };
    }
    case 'stable':
      return { w: r(7, 8.5), d: r(12, 14), floors: 1, round: false };
    case 'warehouse':
      return { w: r(9, 11), d: r(12, 15), floors: 1, round: false };
    case 'hall':
      return { w: r(12, 15), d: r(18, 24), floors: 1, round: false };
    case 'market':
      return { w: r(10, 13), d: r(12, 15), floors: 1, round: false };
    default:
      return { w: 5, d: 5, floors: 1, round: false };
  }
}

function residentsFor(role: BuildingRole, w: number, d: number, s: number, rng: Rng): number {
  const area = (w * d) / (s * s);
  switch (role) {
    case 'house':
      return clamp(Math.round(area / 16 + rng.range(-0.6, 1.4)), 1, 6);
    case 'hut':
    case 'burrow':
      return rng.int(2, 4);
    case 'tent':
      return rng.int(1, 3);
    case 'longhouse':
      return rng.int(5, 9);
    case 'farm':
      return rng.int(3, 6);
    case 'tavern':
      return rng.int(2, 3);
    case 'smithy':
    case 'workshop':
      return rng.int(1, 3);
    case 'temple':
      return rng.int(1, 2);
    case 'barracks':
      return rng.int(6, 10);
    case 'hall':
      return rng.int(2, 4);
    case 'mill':
    case 'library':
    case 'mage_tower':
    case 'stable':
      return 1;
    case 'watchtower':
      return rng.int(0, 2);
    default:
      return 0;
  }
}

/** Home role for a culture. */
function homeRole(race: RaceId, rng: Rng): BuildingRole {
  switch (race) {
    case 'orc':
      return rng.chance(0.72) ? 'hut' : rng.chance(0.6) ? 'longhouse' : 'tent';
    case 'goblin':
      return 'hut';
    case 'halfling':
      return 'burrow';
    case 'giantkin':
      return rng.chance(0.7) ? 'longhouse' : 'house';
    default:
      return 'house';
  }
}

/** Civic building programme for a culture and size. */
function programme(race: RaceId, si: number, rng: Rng, walled: boolean): BuildingRole[] {
  const L: BuildingRole[] = [];
  const add = (r: BuildingRole, n: number) => {
    for (let i = 0; i < n; i++) L.push(r);
  };
  const crafts = race !== 'sylvan';
  add('tavern', si === 0 ? (rng.chance(0.55) ? 1 : 0) : [1, 1, 2, 3][si]);
  if (crafts) add('smithy', si === 0 ? (rng.chance(0.35) ? 1 : 0) : si === 1 ? 1 : race === 'dwarf' ? si + 1 : si);
  if (si >= 2) add('temple', 1);
  add('shrine', si >= 2 ? rng.int(0, 1) : rng.chance(0.6) ? 1 : 0);
  if (si >= 2) add('market', 1);
  if (si >= 2 || ((race === 'orc' || race === 'giantkin' || race === 'dwarf') && si >= 1)) add('hall', 1);
  if (si >= 2) add('barracks', si === 3 ? 2 : 1);
  else if (race === 'orc' && si >= 1) add('barracks', 1);
  if (!walled) add('watchtower', si === 0 ? (race === 'orc' || race === 'goblin' ? rng.int(0, 1) : 0) : si === 1 ? rng.int(1, 2) : rng.int(2, 3));
  if (si >= 2 && race !== 'orc' && race !== 'goblin' && race !== 'giantkin' && rng.chance(si === 3 ? 1 : 0.6)) add('library', 1);
  if ((si >= 2 && rng.chance(race === 'elf' || race === 'umbral' ? 1 : si === 3 ? 0.9 : 0.4)) || (si === 1 && (race === 'elf' || race === 'umbral') && rng.chance(0.5))) add('mage_tower', 1);
  add('workshop', [rng.int(0, 1), rng.int(1, 2), 3, 5][si]);
  add('warehouse', [0, rng.int(0, 1), 2, 3][si]);
  if (race !== 'sylvan' && race !== 'goblin' && race !== 'umbral') add('stable', [0, rng.int(0, 1), 1, 2][si]);
  const millers = race === 'human' || race === 'halfling' || race === 'goblin' || race === 'elf';
  if (millers) add('mill', [rng.int(0, 1), 1, rng.int(1, 2), 2][si]);
  let farms = [rng.int(2, 3), rng.int(3, 5), rng.int(4, 6), rng.int(5, 8)][si];
  if (race === 'halfling') farms = Math.round(farms * 1.5);
  if (race === 'dwarf' || race === 'umbral' || race === 'drakeborn') farms = Math.max(1, Math.round(farms * 0.5));
  add('farm', farms);
  add('barn', Math.ceil(farms / 2));
  return L;
}

/** Crop for a culture & biome. */
function cropFor(race: RaceId, biome: Biome, rng: Rng): FieldInfo['crop'] {
  if (race === 'sylvan' || race === 'umbral' || biome === Biome.FungalGrove) return rng.chance(0.7) ? 'mushroom' : 'cabbage';
  if (race === 'dwarf') return rng.pick(['mushroom', 'cabbage', 'wheat']);
  if (race === 'halfling') return rng.pick(['cabbage', 'pumpkin', 'wheat', 'corn']);
  if (race === 'elf') return rng.pick(['vines', 'flax', 'wheat']);
  if (race === 'orc' || race === 'giantkin') return rng.pick(['wheat', 'fallow', 'cabbage']);
  if (biome === Biome.Savanna || biome === Biome.Desert) return rng.pick(['corn', 'wheat', 'fallow']);
  return rng.pick(['wheat', 'wheat', 'corn', 'cabbage', 'flax', 'fallow', 'pumpkin']);
}

/**
 * Generate the full layout of a settlement. Cost: a few to a few tens of ms
 * (cities); callers cache by site id.
 */
export function layoutSettlement(site: SiteInfo, terrain: LayoutTerrain): SettlementLayout {
  const rng = new Rng(deriveSeed(site.seed, 'layout'));
  const race = asRace(site.race);
  const race2 = site.race2 ? asRace(site.race2) : null;
  const style = RACE_STYLE[race];
  const style2 = race2 ? RACE_STYLE[race2] : null;
  const si = SIZE_IDX[site.size];
  const R = site.radius;
  const cx = site.x, cz = site.z;
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  const plazaR = [7, 10, 14, 19][si] * (race === 'giantkin' ? 1.3 : 1);
  const walled = site.walled || (si >= 1 && (race === 'orc' || race === 'goblin') && rng.chance(0.6));
  const wallR = R * 0.93;
  const coreR = walled ? wallR - 5 : R * 0.95;

  const streets: Street[] = [];
  const segHash = new Hash<Seg>();
  const tmpSegs = new Set<Seg>();
  const addStreet = (s: Street) => {
    streets.push(s);
    for (let i = 0; i < s.pts.length - 1; i++) {
      const [ax, az] = s.pts[i], [bx, bz] = s.pts[i + 1];
      const seg: Seg = { ax, az, bx, bz, hw: s.width / 2 };
      segHash.add(Math.min(ax, bx) - 4, Math.min(az, bz) - 4, Math.max(ax, bx) + 4, Math.max(az, bz) + 4, seg);
    }
  };
  const streetDist = (x: number, z: number, r = 12): number => {
    let best = Infinity;
    for (const s of segHash.query(x - r, z - r, x + r, z + r, tmpSegs)) best = Math.min(best, distSeg(x, z, s) - s.hw);
    return best;
  };

  // ---------------------------------------------------------------- main streets along real roads
  const mainW = [3.2, 4, 5, 6][si];
  const roads = terrain.roadsNear(cx, cz, 4).filter((r) => (Math.hypot(r.ax - cx, r.az - cz) < 1 || Math.hypot(r.bx - cx, r.bz - cz) < 1));
  const dirs: number[] = [];
  const mainLen = R * 1.65;
  const traceRoad = (ang: number): P2[] => {
    const pts: P2[] = [[cx, cz]];
    let dx = Math.cos(ang), dz = Math.sin(ang);
    let px = cx, pz = cz;
    let off = 0;
    for (let dist = 6; dist <= mainLen; dist += 6) {
      const gx = cx + Math.cos(ang) * dist, gz = cz + Math.sin(ang) * dist;
      // Search perpendicular for the road centre (the terrain meanders roads by up to ~9 m).
      const nx = -Math.sin(ang), nz = Math.cos(ang);
      let best = -1, bestOff = off;
      const span = dist <= 6 ? 11 : 3.5;
      for (let o = off - span; o <= off + span; o += 0.75) {
        const v = terrain.roadAt(gx + nx * o, gz + nz * o);
        if (v > best + 1e-4 || (Math.abs(v - best) < 1e-4 && Math.abs(o - off) < Math.abs(bestOff - off))) {
          best = v;
          bestOff = o;
        }
      }
      if (best > 0.35) off = bestOff;
      const qx = gx + nx * off, qz = gz + nz * off;
      dx = qx - px;
      dz = qz - pz;
      px = qx;
      pz = qz;
      pts.push([qx, qz]);
    }
    return pts;
  };
  for (const r of roads) {
    const ox = Math.hypot(r.ax - cx, r.az - cz) < 1 ? r.bx : r.ax;
    const oz = Math.hypot(r.ax - cx, r.az - cz) < 1 ? r.bz : r.az;
    const ang = Math.atan2(oz - cz, ox - cx);
    if (dirs.some((a) => Math.abs(Math.atan2(Math.sin(a - ang), Math.cos(a - ang))) < 0.5)) continue;
    dirs.push(ang);
    addStreet({ pts: traceRoad(ang), width: mainW, kind: 'main' });
  }
  const wantMain = [1, 2, 3, 4][si];
  const synth = (ang: number): P2[] => {
    const pts: P2[] = [[cx, cz]];
    let a = ang;
    let px = cx, pz = cz;
    const wiggle = rng.range(0.04, 0.1);
    for (let dist = 6; dist <= mainLen * 0.85; dist += 6) {
      a += rng.range(-wiggle, wiggle);
      a = lerp(a, ang, 0.15);
      px += Math.cos(a) * 6;
      pz += Math.sin(a) * 6;
      pts.push([px, pz]);
    }
    return pts;
  };
  while (dirs.length < wantMain) {
    // Pick the direction farthest from existing ones.
    let bestA = rng.range(0, Math.PI * 2), bestGap = -1;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + rng.range(-0.1, 0.1);
      let gap = Math.PI;
      for (const b of dirs) gap = Math.min(gap, Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))));
      if (gap > bestGap) {
        bestGap = gap;
        bestA = a;
      }
    }
    dirs.push(bestA);
    addStreet({ pts: synth(bestA), width: mainW * 0.85, kind: 'main' });
  }

  // ---------------------------------------------------------------- ring roads
  const ringRadii = si === 2 ? [R * 0.55] : si === 3 ? [R * 0.4, R * 0.72] : [];
  if (walled && si >= 2) ringRadii.push(wallR - 7);
  for (const rr of ringRadii) {
    const pts: P2[] = [];
    const ph = rng.range(0, 6.28);
    const n = Math.max(16, Math.round((rr * Math.PI * 2) / 9));
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = rr * (1 + 0.07 * Math.sin(a * 3 + ph) + 0.04 * Math.sin(a * 5 + ph * 2));
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    addStreet({ pts, width: si === 3 ? 4 : 3.4, kind: 'ring' });
  }

  // ---------------------------------------------------------------- side streets
  if (si >= 1) {
    const maxLen = [0, 34, 52, 64][si];
    const spacing = [0, 34, 26, 22][si];
    const parents = streets.slice();
    const starts: P2[] = [];
    for (const par of parents) {
      let acc = rng.range(spacing * 0.4, spacing);
      for (let i = 0; i < par.pts.length - 1; i++) {
        const [ax, az] = par.pts[i], [bx, bz] = par.pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        acc -= L;
        if (acc > 0) continue;
        acc = spacing * rng.range(0.75, 1.3);
        const d0 = Math.hypot(ax - cx, az - cz);
        if (d0 < plazaR + 10 || d0 > coreR - 12) continue;
        for (const side of [-1, 1]) {
          if (rng.chance(si === 1 ? 0.55 : 0.2)) continue;
          if (starts.some(([sx, sz]) => Math.hypot(sx - ax, sz - az) < spacing * 0.5)) continue;
          const tx = (bx - ax) / L, tz = (bz - az) / L;
          // Perpendicular to the parent street (normal = (−tz, tx)·side), with some play.
          let a = Math.atan2(tx * side, -tz * side) + rng.range(-0.3, 0.3);
          const hw0 = par.width / 2;
          let px = ax + Math.cos(a) * (hw0 + 0.5), pz = az + Math.sin(a) * (hw0 + 0.5);
          const pts: P2[] = [[ax, az], [px, pz]];
          let len = 0;
          const curve = rng.range(-0.08, 0.08);
          let joined = false;
          while (len < maxLen) {
            a += curve + rng.range(-0.1, 0.1);
            const nx = px + Math.cos(a) * 5, nz = pz + Math.sin(a) * 5;
            if (Math.hypot(nx - cx, nz - cz) > coreR - 4) break;
            if (Math.hypot(nx - cx, nz - cz) < plazaR + 4) break;
            // Snap onto another street when close (avoid parallel near-misses).
            let snap: P2 | null = null;
            if (len > 8) {
              for (const s of segHash.query(nx - 8, nz - 8, nx + 8, nz + 8, tmpSegs)) {
                const dd = distSeg(nx, nz, s);
                if (dd < 7) {
                  const dx = s.bx - s.ax, dz = s.bz - s.az;
                  const l2 = dx * dx + dz * dz || 1;
                  const t = clamp(((nx - s.ax) * dx + (nz - s.az) * dz) / l2, 0, 1);
                  snap = [s.ax + dx * t, s.az + dz * t];
                  break;
                }
              }
            }
            if (snap) {
              pts.push(snap);
              joined = true;
              break;
            }
            px = nx;
            pz = nz;
            pts.push([px, pz]);
            len += 5;
          }
          if (len >= 10 || joined) {
            starts.push([ax, az]);
            addStreet({ pts, width: si === 1 ? 2.6 : 3, kind: si === 1 ? 'lane' : 'side' });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- buildings infrastructure
  const buildings: BuildingInfo[] = [];
  const foots: Foot[] = [];
  const footHash = new Hash<Foot>();
  const tmpFoot = new Set<Foot>();
  const circles: [number, number, number][] = [[cx, cz, plazaR]];
  const margin = [2.6, 2.0, 1.4, 1.0][si];
  const reserve = (f: Foot) => {
    foots.push(f);
    const r = Math.hypot(f.hw, f.hd) + 4;
    footHash.add(f.cx - r, f.cz - r, f.cx + r, f.cz + r, f);
  };
  const fits = (f: Foot, opts: { maxR: number; minR?: number; m?: number; slope?: number; streetGap?: number }): boolean => {
    const cs = corners(f);
    for (let i = 0; i < 8; i += 2) {
      const d = Math.hypot(cs[i] - cx, cs[i + 1] - cz);
      if (d > opts.maxR) return false;
    }
    const dc = Math.hypot(f.cx - cx, f.cz - cz);
    if (opts.minR !== undefined && dc < opts.minR) return false;
    const rr = Math.hypot(f.hw, f.hd);
    for (const [ox, oz, orad] of circles) if (Math.hypot(f.cx - ox, f.cz - oz) < orad + Math.min(f.hw, f.hd) * 0.9 + 0.8) return false;
    // Streets: sample perimeter & centre.
    const gap = opts.streetGap ?? 0.6;
    const samples: P2[] = [[f.cx, f.cz]];
    for (let i = 0; i < 8; i += 2) {
      const j = (i + 2) % 8;
      samples.push([cs[i], cs[i + 1]], [(cs[i] + cs[j]) / 2, (cs[i + 1] + cs[j + 1]) / 2]);
    }
    for (const [x, z] of samples) if (streetDist(x, z) < gap) return false;
    // Centre must not be deep inside a street's reach either (long buildings over thin lanes).
    for (const s of segHash.query(f.cx - rr - 4, f.cz - rr - 4, f.cx + rr + 4, f.cz + rr + 4, tmpSegs)) {
      // Segment midpoint inside footprint?
      const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
      const [lx, lz] = rotXZ(mx - f.cx, mz - f.cz, -f.yaw);
      if (Math.abs(lx) < f.hw + s.hw && Math.abs(lz) < f.hd + s.hw) return false;
    }
    for (const o of footHash.query(f.cx - rr - 2, f.cz - rr - 2, f.cx + rr + 2, f.cz + rr + 2, tmpFoot)) if (sat(f, o, opts.m ?? margin)) return false;
    // Ground: dry and not too steep.
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const h = H(cs[i], cs[i + 1]);
      mn = Math.min(mn, h);
      mx = Math.max(mx, h);
    }
    const hc = H(f.cx, f.cz);
    mn = Math.min(mn, hc);
    mx = Math.max(mx, hc);
    if (mn < SEA_LEVEL + 0.6) return false;
    if (mx - mn > (opts.slope ?? 2.5)) return false;
    return true;
  };

  // Frontage slots along streets.
  const slots: Slot[] = [];
  for (const s of streets) {
    let acc = 0;
    for (let i = 0; i < s.pts.length - 1; i++) {
      const [ax, az] = s.pts[i], [bx, bz] = s.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      for (let u = acc; u < L; u += 2) {
        const x = ax + tx * u, z = az + tz * u;
        const d0 = Math.hypot(x - cx, z - cz);
        for (const side of [-1, 1]) slots.push({ x, z, nx: -tz * side, nz: tx * side, hw: s.width / 2, kind: s.kind, d0 });
      }
      acc = (acc + Math.ceil((L - acc) / 2) * 2) - L;
    }
  }
  // Plaza ring slots (buildings facing the plaza).
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    slots.push({ x: cx + Math.cos(a) * plazaR, z: cz + Math.sin(a) * plazaR, nx: Math.cos(a), nz: Math.sin(a), hw: 0, kind: 'plaza', d0: plazaR });
  }

  const S = RACE_SCALE[race];
  const districtAngle = rng.range(0, Math.PI * 2);
  const districtSpan = race2 ? rng.range(0.6, 1.3) : 0;
  const cultureAt = (x: number, z: number, r: Rng): { race: RaceId; style: ArchStyle; style2?: ArchStyle; district: number } => {
    if (!race2 || !style2) return { race, style, district: 0 };
    const a = Math.atan2(z - cz, x - cx);
    const d = Math.abs(Math.atan2(Math.sin(a - districtAngle), Math.cos(a - districtAngle)));
    const inside = d < districtSpan;
    const border = Math.abs(d - districtSpan) < 0.25;
    if (border && r.chance(0.5)) {
      // Mixed household: one culture's main style with the other's accents.
      return inside ? { race: race2, style: style2, style2: style, district: 1 } : { race, style, style2, district: 0 };
    }
    return inside ? { race: race2, style: style2, district: 1 } : { race, style, district: 0 };
  };

  let bIndex = 0;
  const wealthBase = clamp(0.2 + si * 0.15 + rng.range(-0.1, 0.25) + (race === 'dwarf' ? 0.15 : race === 'elf' ? 0.1 : race === 'goblin' ? -0.2 : race === 'orc' ? -0.1 : 0), 0.05, 0.98);

  /** Create the building record (furniture, spots, doors) for a placed footprint. */
  const makeBuilding = (role: BuildingRole, f: Foot, floors: number, round: boolean, culture: ReturnType<typeof cultureAt>, extra: Partial<BuildingInfo> = {}): BuildingInfo => {
    const id = `B:${site.id}:${bIndex++}`;
    const seed = deriveSeed(site.seed, 'b', bIndex);
    const r = new Rng(seed);
    const st = STYLES[culture.style];
    const s = RACE_SCALE[culture.race];
    const w = f.hw * 2, d = f.hd * 2;
    // Ground offsets at the corners → floor level.
    const cs = corners(f);
    const gh: number[] = [];
    for (let i = 0; i < 8; i += 2) gh.push(H(cs[i], cs[i + 1]));
    const hc = H(f.cx, f.cz);
    const maxG = Math.max(...gh, hc);
    const stilts = culture.style === 'goblin' && (site.biome === Biome.Swamp || r.chance(0.25)) && role !== 'gate' && role !== 'wall';
    const y = maxG + st.plinth * s + (stilts ? 1.6 : 0);
    // Corner order of `corners`: (−x−z), (+x−z), (+x+z), (−x+z).
    const ground = gh.map((g) => g - y) as [number, number, number, number];
    const storey = st.storey * s;
    const t = st.wallT * (role === 'temple' || role === 'hall' ? 1.25 : 1);
    const wealth = clamp(wealthBase + r.range(-0.25, 0.25) + (role === 'hall' || role === 'temple' ? 0.25 : 0), 0, 1);
    const roofKind: RoofKind = round ? (culture.style === 'sylvan' || culture.style === 'burrow' ? 'dome' : 'conical') : r.weighted(st.roofs, (x) => x[1])[0];
    const doorW = (role === 'barn' || role === 'warehouse' || role === 'stable' ? 2.4 : role === 'temple' || role === 'hall' ? 2.0 : 1.05) * s;
    const doorX = role === 'house' && !round && w > 6 * s && r.chance(0.5) ? r.sign() * r.range(0.5, w / 2 - doorW / 2 - 1.4 * s) : 0;
    const residents = extra.residents ?? residentsFor(role, w, d, s, r);
    const hearth = culture.style === 'orcish' || culture.style === 'megalith' || culture.style === 'sylvan' || round ? 'pit' : 'wall';
    const needsInterior = !(role === 'wall' || role === 'gate' || role === 'well' || role === 'bridge' || role === 'dock' || role === 'monument') && !extra.fortification;
    const plan = needsInterior
      ? planInterior({ role, w, d, t, floors, storey, scale: s, doorX, doorW, residents, round, hearth: role === 'barn' || role === 'stable' || role === 'warehouse' ? 'none' : hearth, stairs: floors > 1 && !round, seed: deriveSeed(seed, 'interior') })
      : { furniture: [], hearthX: null };
    const [dxw, dzw] = rotXZ(doorX, d / 2 + 0.4, f.yaw);
    const b: BuildingInfo = {
      id, role, style: culture.style, race: culture.race,
      pos: [f.cx, y, f.cz], yaw: f.yaw,
      size: [w, d, floors * storey + Math.min(w, d) * 0.6],
      doors: needsInterior ? [[f.cx + dxw, y, f.cz + dzw]] : [],
      spots: [], residents, pieceCount: 0, seed,
      floors, roof: roofKind, round, ground, furniture: plan.furniture, wealth, district: culture.district,
      ...(culture.style2 ? { style2: culture.style2 } : {}),
      ...extra,
    };
    const title = buildingTitle(role, culture.race, site.name, r);
    if (title) b.title = title;
    b.spots = spotsFromFurniture(b, plan.furniture, s);
    // Residents are exactly the beds that fit (cramped huts house fewer people).
    if (needsInterior) b.residents = b.spots.filter((x) => x.kind === 'bed').length;
    return b;
  };

  // ---------------------------------------------------------------- fortifications
  const gates: Vec3[] = [];
  const fortSpots: SmartSpot[] = [];
  if (walled) {
    const towerEvery = race === 'orc' || race === 'goblin' ? 34 : 28;
    const nT = Math.max(6, Math.round((Math.PI * 2 * wallR) / towerEvery));
    const ph = rng.range(0, Math.PI * 2);
    const nodes: { a: number; gate: boolean }[] = [];
    for (let i = 0; i < nT; i++) nodes.push({ a: ph + (i / nT) * Math.PI * 2 + rng.range(-0.04, 0.04), gate: false });
    // Gates where main streets cross the ring.
    for (const s of streets) {
      if (s.kind !== 'main') continue;
      for (let i = 0; i < s.pts.length - 1; i++) {
        const d0 = Math.hypot(s.pts[i][0] - cx, s.pts[i][1] - cz), d1 = Math.hypot(s.pts[i + 1][0] - cx, s.pts[i + 1][1] - cz);
        if (d0 <= wallR && d1 > wallR) {
          const t = (wallR - d0) / (d1 - d0);
          const gx = lerp(s.pts[i][0], s.pts[i + 1][0], t), gz = lerp(s.pts[i][1], s.pts[i + 1][1], t);
          const a = Math.atan2(gz - cz, gx - cx);
          // Replace the nearest tower node with the gate.
          let bi = 0, bd = Infinity;
          for (let k = 0; k < nodes.length; k++) {
            const dd = Math.abs(Math.atan2(Math.sin(nodes[k].a - a), Math.cos(nodes[k].a - a)));
            if (dd < bd) {
              bd = dd;
              bi = k;
            }
          }
          nodes[bi] = { a, gate: true };
          break;
        }
      }
    }
    nodes.sort((p, q) => ((p.a % 6.2832) + 6.2832) % 6.2832 - ((((q.a % 6.2832) + 6.2832) % 6.2832)));
    const wr = (a: number) => wallR * (1 + 0.03 * Math.sin(a * 4 + ph));
    const towerR = 2.6 * S * (race === 'giantkin' ? 1.2 : 1);
    const gateW = 9 * Math.max(1, S * 0.9);
    const wallH = (race === 'orc' || race === 'goblin' ? 5 : race === 'dwarf' || race === 'giantkin' ? 8 : 7) * Math.max(1, S * 0.9);
    const nodePos = nodes.map((n) => [cx + Math.cos(n.a) * wr(n.a), cz + Math.sin(n.a) * wr(n.a)] as P2);
    const cult = { race, style, district: 0 };
    for (let k = 0; k < nodes.length; k++) {
      const [px, pz] = nodePos[k];
      const yawOut = yawToward(-(px - cx), -(pz - cz)); // local +z points outward
      if (nodes[k].gate) {
        const f: Foot = { cx: px, cz: pz, hw: gateW / 2, hd: 3.5 * S, yaw: yawOut };
        reserve(f);
        const b = makeBuilding('gate', f, 2, false, cult, { fortification: true, residents: 0 });
        b.size[2] = wallH + 3;
        buildings.push(b);
        gates.push([px, b.pos[1], pz]);
        // Guards outside the gate.
        for (const sx of [-1, 1]) {
          const [ox, oz] = rotXZ(sx * (gateW / 2 - 1), 4.5 * S, yawOut);
          fortSpots.push({ id: `${b.id}:g${sx}`, kind: 'guard', pos: [px + ox, H(px + ox, pz + oz), pz + oz], yaw: yawOut + Math.PI, building: b.id });
        }
      } else {
        const f: Foot = { cx: px, cz: pz, hw: towerR, hd: towerR, yaw: yawOut };
        reserve(f);
        const b = makeBuilding('watchtower', f, 3, style === 'elven' || style === 'umbral' || style === 'timber' || style === 'drakeborn', cult, { fortification: true, residents: 0 });
        b.size[2] = wallH + 4.5;
        b.spots.push({ id: `${b.id}:top`, kind: 'guard', pos: [px, b.pos[1] + b.size[2] - 1.2, pz], yaw: yawOut + Math.PI, building: b.id });
        buildings.push(b);
      }
    }
    // Wall segments between nodes.
    for (let k = 0; k < nodes.length; k++) {
      const [ax, az] = nodePos[k], [bx, bz] = nodePos[(k + 1) % nodes.length];
      const ra = nodes[k].gate ? gateW / 2 : towerR * 0.8, rb = nodes[(k + 1) % nodes.length].gate ? gateW / 2 : towerR * 0.8;
      const L = Math.hypot(bx - ax, bz - az);
      if (L - ra - rb < 2) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const sx = ax + ux * ra, sz = az + uz * ra, ex = bx - ux * rb, ez = bz - uz * rb;
      const mx = (sx + ex) / 2, mz = (sz + ez) / 2;
      let yaw = Math.atan2(-uz, ux);
      // local +z must point outward.
      const [ox, oz] = rotXZ(0, 1, yaw);
      if (ox * (mx - cx) + oz * (mz - cz) < 0) yaw += Math.PI;
      const thick = (race === 'orc' || race === 'goblin' ? 0.9 : race === 'giantkin' || race === 'dwarf' ? 3.2 : 2.6) * Math.max(1, S * 0.8);
      const f: Foot = { cx: mx, cz: mz, hw: (L - ra - rb) / 2, hd: thick / 2, yaw };
      reserve(f);
      const b = makeBuilding('wall', f, 1, false, cult, { fortification: true, residents: 0 });
      b.size[2] = wallH;
      // Walk the wall: a guard post at the middle of long segments.
      if (L > 18 && thick > 2) b.spots.push({ id: `${b.id}:walk`, kind: 'guard', pos: [mx, b.pos[1] + wallH, mz], yaw: yaw + Math.PI, building: b.id });
      buildings.push(b);
    }
  }

  // ---------------------------------------------------------------- plaza centrepiece (well / statue / campfire / totem)
  const props: PropInfo[] = [];
  const spots: SmartSpot[] = [];
  let propIndex = 0;
  /** Prop group token: props are grouped in 32 m tiles so ids stay stable and local. */
  const propId = (x: number, z: number) => {
    const gx = Math.floor((x - cx) / 32) + 50, gz = Math.floor((z - cz) / 32) + 50;
    return `B:${site.id}:p${gx * 100 + gz}:${propIndex++}`;
  };
  const addProp = (kind: PropKind, x: number, z: number, yaw: number, scale = 1, extra: Partial<PropInfo> = {}, st: ArchStyle = style): PropInfo => {
    const p: PropInfo = { id: propId(x, z), kind, pos: [x, H(x, z), z], yaw, scale, seed: hashString(site.id + ':' + propIndex), style: st, ...extra };
    // Fences follow the terrain: sample the ground under every post (same spacing as the builder).
    if ((kind === 'fence' || kind === 'gate_fence') && p.len) {
      const n = fencePosts(p.len);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      p.ground = [];
      for (let i = 0; i <= n; i++) {
        const lx = -p.len / 2 + (i * p.len) / n;
        p.ground.push(H(x + lx * c, z - lx * s) - p.pos[1]);
      }
    }
    props.push(p);
    return p;
  };
  const fireCulture = race === 'orc' || race === 'goblin' || race === 'giantkin';
  {
    // Well as a small building so it's destructible and has a spot.
    const wellOff = si >= 2 ? plazaR * 0.55 : 0;
    const wa = rng.range(0, Math.PI * 2);
    const wx = cx + Math.cos(wa) * wellOff, wz = cz + Math.sin(wa) * wellOff;
    const f: Foot = { cx: wx, cz: wz, hw: 1.3 * S, hd: 1.3 * S, yaw: rng.range(0, 6.28) };
    const b = makeBuilding('well', f, 1, true, { race, style, district: 0 }, { residents: 0 });
    b.pos[1] = H(wx, wz);
    b.ground = [0, 0, 0, 0];
    b.spots.push({ id: `${b.id}:draw`, kind: 'idle', pos: [wx + 1.8 * S, b.pos[1], wz], yaw: Math.PI / 2, building: b.id });
    buildings.push(b);
    reserve({ ...f, hw: f.hw + 1, hd: f.hd + 1 });
    if (si >= 2) {
      const sx = cx, sz = cz;
      addProp(race === 'giantkin' ? 'standing_stone' : fireCulture ? 'totem' : race === 'umbral' ? 'crystal' : race === 'sylvan' ? 'mushroom' : 'statue', sx, sz, rng.range(0, 6.28), 1.6 + si * 0.3);
      spots.push({ id: `${site.id}:statue`, kind: 'pray', pos: [sx, H(sx, sz + 3), sz + 3], yaw: 0 });
    }
    if (fireCulture || race === 'sylvan') {
      const fx = cx + Math.cos(wa + Math.PI) * plazaR * 0.5, fz = cz + Math.sin(wa + Math.PI) * plazaR * 0.5;
      addProp('campfire', fx, fz, 0, 1.2);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const lx = fx + Math.cos(a) * 2.2, lz = fz + Math.sin(a) * 2.2;
        addProp('bench', lx, lz, yawToward(lx - fx, lz - fz) + Math.PI / 2, 0.6);
        spots.push({ id: `${site.id}:fire${i}`, kind: i === 0 ? 'cook' : 'seat', pos: [lx, H(lx, lz), lz], yaw: yawToward(fx - lx, fz - lz) });
      }
    }
  }
  // Market stalls around the plaza.
  const nStalls = [0, 3, 6, 10][si] + (race === 'goblin' ? 2 : 0);
  for (let i = 0; i < nStalls; i++) {
    const a = (i / nStalls) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const rr = plazaR * 0.78;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    if (streetDist(x, z) < 0.5 && streetDist(x, z) > -10) {
      // Don't block main roads crossing the plaza.
      const onMain = streets.some((s) => s.kind === 'main' && s.pts.some((p, k) => k < s.pts.length - 1 && distSeg(x, z, { ax: p[0], az: p[1], bx: s.pts[k + 1][0], bz: s.pts[k + 1][1], hw: s.width / 2 }) < s.width / 2 + 1.5));
      if (onMain) continue;
    }
    const yaw = yawToward(-(x - cx), -(z - cz)) + Math.PI; // face the plaza centre
    addProp('stall', x, z, yaw, S);
    const [ox, oz] = rotXZ(0, -1.1 * S, yaw);
    spots.push({ id: `${site.id}:stall${i}`, kind: 'market', pos: [x + ox, H(x + ox, z + oz), z + oz], yaw: yaw + Math.PI });
  }
  // Plaza benches & idle spots.
  for (let i = 0; i < [2, 3, 5, 7][si]; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = plazaR * rng.range(0.35, 0.6);
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    spots.push({ id: `${site.id}:idle${i}`, kind: 'idle', pos: [x, H(x, z), z], yaw: rng.range(0, 6.28) });
  }

  // ---------------------------------------------------------------- building programme
  const prog = programme(race, si, rng, walled);
  if (race2) for (const r of programme(race2, Math.max(0, si - 2), rng.fork('p2'), true)) if (r !== 'farm' && r !== 'barn' && r !== 'watchtower' && rng.chance(0.5)) prog.push(r);
  const placeOn = (role: BuildingRole, slotFilter: (s: Slot) => boolean, score: (s: Slot) => number, opts: { maxR: number; minR?: number; slope?: number; setback?: [number, number] }): BuildingInfo | null => {
    const cands = slots.filter(slotFilter).map((s) => ({ s, sc: score(s) + rng.float() * 4 }));
    cands.sort((a, b) => a.sc - b.sc);
    const r = rng.fork(role, bIndex);
    for (let attempt = 0; attempt < Math.min(cands.length, 220); attempt++) {
      const { s } = cands[attempt];
      const cul = cultureAt(s.x, s.z, r);
      const sz = sizeFor(role, cul.style, si, r);
      const sc = RACE_SCALE[cul.race];
      const w = sz.w * sc, d = (sz.round ? sz.w : sz.d) * sc;
      const sb = opts.setback ?? [0.8, 2.2];
      const back = s.hw + r.range(sb[0], sb[1]) + d / 2;
      const f: Foot = { cx: s.x + s.nx * back, cz: s.z + s.nz * back, hw: w / 2, hd: d / 2, yaw: Math.atan2(-s.nx, -s.nz) };
      if (!fits(f, { maxR: opts.maxR, minR: opts.minR, slope: opts.slope })) continue;
      reserve(f);
      const b = makeBuilding(role, f, sz.floors, sz.round, cul);
      buildings.push(b);
      return b;
    }
    return null;
  };

  const civicNear = (s: Slot) => (s.kind === 'plaza' ? 0 : s.d0 - plazaR + 6);
  const fieldsOut: FieldInfo[] = [];
  const order: BuildingRole[] = ['hall', 'temple', 'tavern', 'market', 'library', 'barracks', 'smithy', 'mage_tower', 'stable', 'warehouse', 'workshop', 'shrine', 'watchtower', 'mill', 'farm', 'barn'];
  prog.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const farms: BuildingInfo[] = [];
  for (const role of prog) {
    let b: BuildingInfo | null = null;
    switch (role) {
      case 'hall':
      case 'temple':
      case 'tavern':
      case 'market':
      case 'library':
        b = placeOn(role, (s) => s.kind === 'plaza' || s.d0 < R * 0.5, civicNear, { maxR: coreR, setback: [0.3, 1.2] });
        break;
      case 'barracks':
        b = placeOn(role, (s) => s.kind !== 'plaza' && s.d0 > R * 0.35, (s) => (walled ? Math.min(...gates.map((g) => Math.hypot(g[0] - s.x, g[2] - s.z)), 999) : -s.d0 * 0.3), { maxR: coreR });
        break;
      case 'smithy':
      case 'stable':
      case 'warehouse':
      case 'workshop':
        b = placeOn(role, (s) => s.kind === 'main' || s.kind === 'ring' || s.kind === 'side', (s) => Math.abs(s.d0 - R * (role === 'stable' ? 0.7 : 0.45)) + (s.kind === 'main' ? 0 : 8), { maxR: coreR });
        break;
      case 'mage_tower':
        b = placeOn(role, (s) => s.kind !== 'plaza', (s) => (race === 'elf' || race === 'umbral' ? Math.abs(s.d0 - R * 0.3) : -s.d0), { maxR: coreR });
        break;
      case 'shrine':
        b = placeOn(role, () => true, (s) => Math.abs(s.d0 - R * 0.6), { maxR: walled ? coreR : R * 1.2 });
        break;
      case 'watchtower':
        b = placeOn(role, (s) => s.kind === 'main' && s.d0 > R * 0.75, (s) => -s.d0 * 0.2, { maxR: R * 1.3, slope: 4 });
        if (b) b.spots.push({ id: `${b.id}:top`, kind: 'guard', pos: [b.pos[0], b.pos[1] + STYLES[b.style].storey * RACE_SCALE[b.race] * 3 + 0.3, b.pos[2]], yaw: b.yaw + Math.PI, building: b.id });
        break;
      case 'mill':
        b = placeOn(role, (s) => s.kind === 'main' && s.d0 > R * (walled ? 1.05 : 0.8), (s) => Math.abs(s.d0 - R * 1.2), { maxR: R * 1.6, minR: walled ? wallR + 8 : R * 0.7, slope: 4.5 });
        break;
      case 'farm':
        b = placeOn(role, (s) => s.kind === 'main' && s.d0 > R * (walled ? 1.02 : 0.78), (s) => Math.abs(s.d0 - R * 1.15) + rng.float() * 10, { maxR: R * 1.65, minR: walled ? wallR + 8 : R * 0.7, slope: 4.5, setback: [3, 6] });
        if (b) farms.push(b);
        break;
      case 'barn': {
        // Barns next to a farm.
        const host = farms[Math.floor(rng.float() * farms.length)];
        if (host) b = placeOn(role, (s) => s.kind === 'main' && Math.hypot(s.x - host.pos[0], s.z - host.pos[2]) < 30, (s) => Math.hypot(s.x - host.pos[0], s.z - host.pos[2]), { maxR: R * 1.7, slope: 4.5, setback: [2, 5] });
        break;
      }
      default:
        break;
    }
    void b;
  }

  // Fields behind farms.
  for (const farm of farms) {
    const fr = new Rng(deriveSeed(farm.seed, 'fields'));
    const nf = fr.int(1, 3);
    for (let i = 0; i < nf; i++) {
      const fw = fr.range(14, 30), fd = fr.range(12, 24);
      const side = i === 0 ? 0 : fr.sign();
      const [bx, bz] = rotXZ(side * (farm.size[0] / 2 + fw / 2 + 3), side ? 0 : -(farm.size[1] / 2 + fd / 2 + 3), farm.yaw);
      const f: Foot = { cx: farm.pos[0] + bx, cz: farm.pos[2] + bz, hw: fw / 2, hd: fd / 2, yaw: farm.yaw + fr.range(-0.1, 0.1) };
      if (!fits(f, { maxR: R * 2.3, minR: walled ? wallR + 6 : 0, slope: 6, m: 2, streetGap: 1 })) continue;
      reserve(f);
      const field: FieldInfo = { pos: [f.cx, H(f.cx, f.cz), f.cz], yaw: f.yaw, w: fw, d: fd, crop: cropFor(race, site.biome, fr), seed: fr.nextU32() };
      fieldsOut.push(field);
      // Farm spots along the field's front edge.
      for (let k = 0; k < 3; k++) {
        const [ox, oz] = rotXZ((k - 1) * fw * 0.3, fd * fr.range(-0.3, 0.3), f.yaw);
        spots.push({ id: `${farm.id}:f${i}_${k}`, kind: 'farm', pos: [f.cx + ox, H(f.cx + ox, f.cz + oz), f.cz + oz], yaw: f.yaw + fr.range(-1, 1), building: farm.id });
      }
      if (field.crop !== 'fallow' && fr.chance(0.55)) {
        const [ox, oz] = rotXZ(fr.range(-0.3, 0.3) * fw, fr.range(-0.3, 0.3) * fd, f.yaw);
        addProp('scarecrow', f.cx + ox, f.cz + oz, fr.range(0, 6.28), S);
      }
      if (field.crop === 'fallow' || fr.chance(0.3)) {
        // Fence around pastures.
        const cs = corners(f);
        for (let e = 0; e < 8; e += 2) {
          const j = (e + 2) % 8;
          const mx = (cs[e] + cs[j]) / 2, mz = (cs[e + 1] + cs[j + 1]) / 2;
          const len = Math.hypot(cs[j] - cs[e], cs[j + 1] - cs[e + 1]);
          addProp('fence', mx, mz, Math.atan2(-(cs[j + 1] - cs[e + 1]), cs[j] - cs[e]), 1, { len });
        }
      }
    }
  }

  // ---------------------------------------------------------------- houses
  const total = Math.round([rng.range(8, 12), rng.range(20, 32), rng.range(48, 72), rng.range(95, 150)][si] * (race === 'giantkin' ? 0.6 : race === 'goblin' ? 1.25 : 1));
  const houseSlots = slots
    .filter((s) => s.d0 < coreR - 2)
    .map((s) => ({ s, sc: s.d0 * (1 + (s.kind === 'lane' ? 0.1 : 0)) + rng.float() * (si >= 2 ? 25 : 12) }))
    .sort((a, b) => a.sc - b.sc);
  let houses = 0;
  const houseTarget = Math.max(si === 0 ? 3 : 6, total - buildings.filter((b) => !b.fortification && b.role !== 'well').length);
  const hr = rng.fork('houses');
  for (const { s } of houseSlots) {
    if (houses >= houseTarget) break;
    const cul = cultureAt(s.x, s.z, hr);
    const role = homeRole(cul.race, hr);
    const sz = sizeFor(role, cul.style, si, hr);
    const sc = RACE_SCALE[cul.race];
    const w = sz.w * sc, d = (sz.round ? sz.w : sz.d || sz.w) * sc;
    const back = s.hw + hr.range(si >= 3 ? 0.4 : 0.9, si >= 2 ? 1.6 : 3) + d / 2;
    const f: Foot = { cx: s.x + s.nx * back, cz: s.z + s.nz * back, hw: w / 2, hd: d / 2, yaw: Math.atan2(-s.nx, -s.nz) + (sz.round ? hr.range(-0.3, 0.3) : 0) };
    if (!fits(f, { maxR: coreR })) continue;
    reserve(f);
    buildings.push(makeBuilding(role, f, sz.floors, sz.round, cul));
    houses++;
  }

  // ---------------------------------------------------------------- per-building props & yards
  for (const b of buildings) {
    if (b.fortification || b.role === 'well') continue;
    const r = new Rng(deriveSeed(b.seed, 'props'));
    const w = b.size[0], d = b.size[1];
    const at = (lx: number, lz: number): [number, number] => {
      const [ox, oz] = rotXZ(lx, lz, b.yaw);
      return [b.pos[0] + ox, b.pos[2] + oz];
    };
    const free = (x: number, z: number, rad: number) => {
      if (streetDist(x, z) < rad + 0.2) return false;
      for (const o of footHash.query(x - rad - 1, z - rad - 1, x + rad + 1, z + rad + 1, tmpFoot)) {
        const [lx, lz] = rotXZ(x - o.cx, z - o.cz, -o.yaw);
        if (Math.abs(lx) < o.hw + rad && Math.abs(lz) < o.hd + rad) return false;
      }
      return true;
    };
    const near = (kind: PropKind, lx: number, lz: number, scale = 1, extra?: Partial<PropInfo>) => {
      const [x, z] = at(lx, lz);
      if (!free(x, z, 0.7 * scale)) return null;
      return addProp(kind, x, z, b.yaw + r.range(-0.4, 0.4), scale, extra, b.style);
    };
    const frontZ = d / 2 + 0.9;
    switch (b.role) {
      case 'tavern': {
        near('sign', (b.doors.length ? 0 : 0) + w / 2 - 0.6, frontZ - 0.3, 1, { seed: hashString(b.title ?? 'tavern') });
        near('barrel', -w / 2 + 0.6, frontZ, 1);
        near('barrel', -w / 2 + 1.4, frontZ, 1);
        const bench = near('bench', w / 4, frontZ + 0.4, 1);
        if (bench) {
          for (const u of [-0.45, 0.45]) {
            const [x, z] = at(w / 4 + u, frontZ + 0.4);
            spots.push({ id: `${b.id}:bench${u}`, kind: 'seat', pos: [x, bench.pos[1], z], yaw: b.yaw + Math.PI, building: b.id });
          }
        }
        break;
      }
      case 'smithy':
        near('sign', w / 2 - 0.6, frontZ - 0.3, 1, { seed: hashString(b.title ?? 'smithy') });
        near('woodpile', w / 2 + 1.2, 0, 1);
        near('barrel', -w / 2 - 0.8, frontZ - 1, 1);
        near('rack', -w / 2 - 0.9, 0, 1);
        break;
      case 'farm':
      case 'barn':
        near('haystack', w / 2 + 2.5, -d / 4, 1 + r.float() * 0.4);
        if (r.chance(0.7)) near('cart', -w / 2 - 2.5, frontZ, 1);
        near('woodpile', -w / 2 - 1.2, -d / 3, 1);
        if (b.role === 'farm') near('trough', w / 2 + 1.5, d / 4, 1);
        break;
      case 'stable':
        near('trough', w / 2 + 1.2, 0, 1);
        near('haystack', -w / 2 - 2, -d / 4, 1);
        near('fence', w / 2 + 4, 0, 1, { len: d * 0.9 });
        break;
      case 'warehouse':
        for (let i = 0; i < 4; i++) near(r.chance(0.5) ? 'crate' : 'barrel', -w / 2 + 0.7 + i * 0.9, frontZ, 1);
        if (r.chance(0.6)) near('cart', w / 2 + 2, frontZ, 1);
        near('sacks', w / 2 + 0.9, 0, 1);
        break;
      case 'workshop':
        near('crate', w / 2 + 0.8, frontZ - 0.5, 1);
        near('woodpile', -w / 2 - 1, 0, 1);
        break;
      case 'temple': {
        // Graveyard behind the temple.
        if (race !== 'sylvan' && r.chance(0.8)) {
          for (let gx = 0; gx < 4; gx++)
            for (let gz = 0; gz < 3; gz++) if (r.chance(0.8)) near('grave', -w / 2 + 1.5 + gx * (w - 3) / 3, -d / 2 - 2.5 - gz * 2.2, 1);
        }
        near('banner', w / 2 + 0.6, frontZ, 1.2);
        near('banner', -w / 2 - 0.6, frontZ, 1.2);
        break;
      }
      case 'hall':
      case 'barracks':
        near('banner', w / 2 + 0.7, frontZ, 1.4);
        near('banner', -w / 2 - 0.7, frontZ, 1.4);
        if (b.role === 'barracks') {
          near('rack', w / 2 + 1, 0, 1);
          const [gx, gz] = at(b.doors.length ? 1.2 : 0, frontZ + 0.6);
          spots.push({ id: `${b.id}:door`, kind: 'guard', pos: [gx, H(gx, gz), gz], yaw: b.yaw + Math.PI, building: b.id });
        }
        break;
      case 'shrine':
        near('brazier', w / 2 + 0.6, frontZ, 0.8);
        near('brazier', -w / 2 - 0.6, frontZ, 0.8);
        break;
      default: {
        // Homes: a few household props, a fenced garden behind if there is room.
        const kinds: PropKind[] = race === 'orc' ? ['woodpile', 'rack', 'totem', 'barrel'] : race === 'goblin' ? ['crate', 'barrel', 'sacks', 'pole'] : race === 'sylvan' ? ['mushroom', 'planter'] : ['barrel', 'crate', 'woodpile', 'planter', 'bench'];
        const n = r.int(0, 2);
        for (let i = 0; i < n; i++) near(r.pick(kinds), r.sign() * (w / 2 + 0.8), r.range(-d / 3, d / 3), 1);
        if (r.chance(si <= 1 ? 0.55 : 0.25) && !b.round) {
          const gw = Math.min(w + 1, 7), gd = r.range(3, 5);
          const [gx, gz] = at(0, -d / 2 - 0.8 - gd / 2);
          const f: Foot = { cx: gx, cz: gz, hw: gw / 2, hd: gd / 2, yaw: b.yaw };
          if (fits(f, { maxR: walled ? coreR : R * 1.4, m: 0.5, slope: 3, streetGap: 0.4 })) {
            reserve(f);
            fieldsOut.push({ pos: [gx, H(gx, gz), gz], yaw: b.yaw, w: gw - 0.6, d: gd - 0.6, crop: r.pick(['cabbage', 'pumpkin', 'flax', 'vines'] as const), seed: r.nextU32() });
            const cs = corners(f);
            for (let e = 0; e < 8; e += 2) {
              if (e === 4) continue; // open toward the house
              const j = (e + 2) % 8;
              const len = Math.hypot(cs[j] - cs[e], cs[j + 1] - cs[e + 1]);
              addProp('fence', (cs[e] + cs[j]) / 2, (cs[e + 1] + cs[j + 1]) / 2, Math.atan2(-(cs[j + 1] - cs[e + 1]), cs[j] - cs[e]), 0.8, { len }, b.style);
            }
            const [sx, sz] = at(0, -d / 2 - 0.8 - gd / 2);
            spots.push({ id: `${b.id}:garden`, kind: 'farm', pos: [sx, H(sx, sz), sz], yaw: b.yaw, building: b.id });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- street lamps
  const lampKind = STYLES[style].lamp;
  if (lampKind !== 'none') {
    const lr = rng.fork('lamps');
    for (const s of streets) {
      const every = s.kind === 'main' ? (si >= 2 ? 16 : 22) : s.kind === 'ring' ? 20 : si >= 2 ? 26 : 0;
      if (!every) continue;
      let acc = every / 2, side = 1;
      for (let i = 0; i < s.pts.length - 1; i++) {
        const [ax, az] = s.pts[i], [bx, bz] = s.pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        let u = acc;
        while (u < L) {
          const x = ax + ((bx - ax) * u) / L, z = az + ((bz - az) * u) / L;
          const nx = -(bz - az) / L * side, nz = (bx - ax) / L * side;
          const px = x + nx * (s.width / 2 + 0.6), pz = z + nz * (s.width / 2 + 0.6);
          const dc = Math.hypot(px - cx, pz - cz);
          if (dc > plazaR + 1 && dc < (walled ? wallR - 3 : R * 1.15)) {
            let ok = true;
            for (const o of footHash.query(px - 2, pz - 2, px + 2, pz + 2, tmpFoot)) {
              const [lx, lz] = rotXZ(px - o.cx, pz - o.cz, -o.yaw);
              if (Math.abs(lx) < o.hw + 0.5 && Math.abs(lz) < o.hd + 0.5) ok = false;
            }
            if (ok) addProp(lampKind === 'mushroom' ? 'mushroom' : lampKind === 'crystal' ? 'crystal' : lampKind === 'brazier' ? 'brazier' : 'lamp', px, pz, Math.atan2(nx, nz), lampKind === 'mushroom' ? 1.3 : 1, { len: lampKind === 'torch' ? 1 : 0 });
          }
          side = -side;
          u += every * lr.range(0.85, 1.15);
        }
        acc = u - L;
      }
    }
  }
  // Carts & crates on the plaza edge for busier towns.
  for (let i = 0; i < si * 2; i++) {
    const a = rng.range(0, 6.28);
    const x = cx + Math.cos(a) * plazaR * 0.95, z = cz + Math.sin(a) * plazaR * 0.95;
    if (streetDist(x, z) > 0.8) addProp(rng.chance(0.4) ? 'cart' : rng.pick(['barrel', 'crate', 'sacks'] as const), x, z, rng.range(0, 6.28), 1);
  }

  // ---------------------------------------------------------------- docks on nearby shores
  let extent = R * 1.8;
  {
    let best: [number, number, number] | null = null;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      for (let rr = R * 0.9; rr < R * 1.9; rr += 6) {
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        if (H(x, z) < SEA_LEVEL - 1.2) {
          if (!best || rr < best[2]) best = [a, 0, rr];
          break;
        }
      }
    }
    if (best && rng.chance(0.85)) {
      const a = best[0];
      // Walk from the water back to the shore line.
      let rr = best[2];
      while (rr > R * 0.5 && H(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr) < SEA_LEVEL + 0.4) rr -= 1;
      const sx = cx + Math.cos(a) * rr, sz = cz + Math.sin(a) * rr;
      const len = rng.range(12, 22) * Math.max(1, S * 0.8);
      const mx = sx + Math.cos(a) * (len / 2 - 2), mz = sz + Math.sin(a) * (len / 2 - 2);
      const yaw = Math.atan2(Math.cos(a), Math.sin(a)); // local +z points out over the water
      const f: Foot = { cx: mx, cz: mz, hw: 1.6 * S, hd: len / 2, yaw };
      reserve(f);
      const b = makeBuilding('dock', f, 1, false, { race, style, district: 0 }, { residents: 0 });
      b.pos[1] = Math.max(SEA_LEVEL + 0.9, H(sx, sz) + 0.3);
      // Landward corners rest on the shore, seaward ones reach into the water.
      const gAt = (lx: number, lz: number) => {
        const [ox, oz] = rotXZ(lx, lz, yaw);
        return Math.min(H(mx + ox, mz + oz), SEA_LEVEL - 0.5) - b.pos[1];
      };
      b.ground = [gAt(-f.hw, -len / 2), gAt(f.hw, -len / 2), gAt(f.hw, len / 2) - 1.5, gAt(-f.hw, len / 2) - 1.5];
      const [ex, ez] = rotXZ(0, len / 2 - 1.2, yaw);
      b.spots.push({ id: `${b.id}:fish`, kind: 'work', pos: [mx + ex, b.pos[1], mz + ez], yaw: yaw + Math.PI, building: b.id });
      buildings.push(b);
      addProp('boat', mx + Math.cos(a + 0.3) * 4, mz + Math.sin(a + 0.3) * 4, yaw + 0.4, S);
      extent = Math.max(extent, rr + len + 6);
    }
  }

  // ---------------------------------------------------------------- bridges where owned roads cross water
  for (const road of terrain.roadsOfCell(site.cellX, site.cellZ)) {
    const L = Math.hypot(road.bx - road.ax, road.bz - road.az);
    const ux = (road.bx - road.ax) / L, uz = (road.bz - road.az) / L;
    let wetStart = -1;
    for (let u = 20; u < L - 20; u += 3) {
      const x = road.ax + ux * u, z = road.az + uz * u;
      const wet = H(x, z) < SEA_LEVEL + 0.2;
      if (wet && wetStart < 0) wetStart = u;
      if (!wet && wetStart >= 0) {
        const span = u - wetStart;
        if (span >= 3 && span <= 90) {
          // Locate the meandered road centre near the crossing and bridge it.
          const u0 = wetStart - 5, u1 = u + 4;
          const p0 = findRoadCentre(terrain, road.ax + ux * u0, road.az + uz * u0, -uz, ux);
          const p1 = findRoadCentre(terrain, road.ax + ux * u1, road.az + uz * u1, -uz, ux);
          const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
          const bl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          const yaw = Math.atan2(p1[0] - p0[0], p1[1] - p0[1]); // local +z along the bridge
          const f: Foot = { cx: mx, cz: mz, hw: road.width * 0.8 + 0.6, hd: bl / 2, yaw };
          const b = makeBuilding('bridge', f, 1, false, { race, style, district: 0 }, { residents: 0 });
          const h0 = H(p0[0], p0[1]), h1 = H(p1[0], p1[1]);
          b.pos[1] = Math.max(h0, h1, SEA_LEVEL + 1.2) + 0.15;
          b.ground = [h0 - b.pos[1], h0 - b.pos[1], h1 - b.pos[1], h1 - b.pos[1]];
          b.size[2] = Math.min(6, 1.5 + span * 0.06);
          buildings.push(b);
          extent = Math.max(extent, Math.hypot(mx - cx, mz - cz) + bl / 2 + 4);
        }
        wetStart = -1;
      }
    }
  }

  // ---------------------------------------------------------------- finish
  // Prop ids → group-local piece indices: `B:<site>:p<group>:<i>` with i counting within the group.
  {
    const counts = new Map<string, number>();
    for (const p of props) {
      const tok = p.id.split(':')[2];
      const n = counts.get(tok) ?? 0;
      p.id = `B:${site.id}:${tok}:${n}`;
      counts.set(tok, n + 1);
    }
  }
  let population = 0;
  for (const b of buildings) population += b.residents;
  const barracks = buildings.filter((b) => b.role === 'barracks').length;
  const towers = buildings.filter((b) => b.role === 'watchtower').length;
  const defense = clamp((walled ? 0.45 : 0) + barracks * 0.12 + towers * 0.03 + (race === 'orc' ? 0.15 : race === 'dwarf' ? 0.1 : 0), 0, 1);
  for (const s of fortSpots) spots.push(s);

  const outStreets = streets.map((s) => ({
    points: s.pts.map(([x, z]) => [x, H(x, z), z] as Vec3),
    width: s.width,
  }));
  return {
    siteId: site.id,
    name: site.name,
    race,
    race2,
    center: [cx, site.plateau, cz],
    radius: R,
    buildings,
    streets: outStreets,
    streetKinds: streets.map((s) => s.kind),
    plaza: [cx, H(cx, cz), cz],
    plazaRadius: plazaR,
    walls: walled,
    spots,
    population,
    wealth: wealthBase,
    defense,
    style,
    style2,
    props,
    fields: fieldsOut,
    gates,
    heraldry: makeHeraldry(race, rng.fork('heraldry')),
    extent,
  };
}

/** Find the road centre near (x, z) searching along (nx, nz). */
function findRoadCentre(t: LayoutTerrain, x: number, z: number, nx: number, nz: number): P2 {
  let best = -1, bx = x, bz = z;
  for (let o = -12; o <= 12; o += 0.75) {
    const v = t.roadAt(x + nx * o, z + nz * o);
    if (v > best) {
      best = v;
      bx = x + nx * o;
      bz = z + nz * o;
    }
  }
  return best > 0.3 ? [bx, bz] : [x, z];
}

/** Distance from a point to a road segment (re-exported helper for callers). */
export function roadDistance(x: number, z: number, r: RoadSegment): number {
  return segDist(x, z, r)[0];
}
