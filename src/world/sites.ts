/**
 * Settlement sites, roads and points of interest. Deterministic from the seed and
 * computed lazily per grid cell. The terrain generator flattens ground around sites,
 * the settlement system builds towns on them, and the game master uses POIs as
 * hooks for events and quests.
 */
import { Rng, deriveSeed, hash2i, hashToFloat } from '../core/rng';
import { clamp } from '../core/math';
import { Biome, BIOMES } from './biomes';
import type { WorldProfile } from './profile';

export const SITE_CELL = 720;
export const POI_CELL = 260;

export type SiteSize = 'hamlet' | 'village' | 'town' | 'city';

export interface SiteInfo {
  id: string;
  cellX: number;
  cellZ: number;
  x: number;
  z: number;
  /** Flattened ground height. */
  plateau: number;
  /** Radius of the flattened core (m). */
  radius: number;
  size: SiteSize;
  /** Primary and (optional) secondary culture race id. */
  race: string;
  race2: string | null;
  biome: Biome;
  /** Settlement name. */
  name: string;
  seed: number;
  /** Ids of connected sites. */
  links: string[];
  walled: boolean;
}

export type PoiKind =
  | 'ruin' | 'shrine' | 'camp' | 'lair' | 'grove' | 'monolith' | 'tower' | 'battlefield' | 'crashsite' | 'well' | 'wayshrine' | 'obelisk';

export interface PoiInfo {
  id: string;
  kind: PoiKind;
  x: number;
  z: number;
  /** Ground height at the POI. */
  y: number;
  seed: number;
  biome: Biome;
  /** Radius of influence (m). */
  radius: number;
}

export interface RoadSegment {
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  width: number;
}

/** Height-only sampler the site system needs from the generator (no site influence). */
export interface BaseTerrain {
  baseHeight(x: number, z: number): number;
  biomeAt(x: number, z: number): Biome;
  landness(x: number, z: number): number;
}

const RACE_BIOME_AFFINITY: Record<string, Partial<Record<Biome, number>>> = {
  human: { [Biome.Grassland]: 2, [Biome.TemperateForest]: 1.2, [Biome.Savanna]: 1.2, [Biome.Taiga]: 1 },
  elf: { [Biome.TemperateForest]: 2.5, [Biome.Jungle]: 1.5, [Biome.FloatingIsles]: 1.8, [Biome.KarstPillars]: 1.4 },
  dwarf: { [Biome.Tundra]: 1.6, [Biome.Taiga]: 1.4, [Biome.Volcanic]: 1.3, [Biome.Badlands]: 1.3, [Biome.Glacier]: 1 },
  orc: { [Biome.Badlands]: 2, [Biome.Savanna]: 1.6, [Biome.Volcanic]: 1.4, [Biome.Desert]: 1.2 },
  halfling: { [Biome.Grassland]: 2.5, [Biome.TemperateForest]: 1.2 },
  goblin: { [Biome.Swamp]: 2, [Biome.FungalGrove]: 1.8, [Biome.Jungle]: 1.2 },
  sylvan: { [Biome.FungalGrove]: 2, [Biome.Jungle]: 2, [Biome.TemperateForest]: 1.5 },
  drakeborn: { [Biome.Volcanic]: 2.5, [Biome.Desert]: 1.6, [Biome.Badlands]: 1.4 },
  umbral: { [Biome.CrystalWastes]: 2, [Biome.SaltFlats]: 1.4, [Biome.Swamp]: 1.2 },
  giantkin: { [Biome.Glacier]: 2, [Biome.Tundra]: 1.8, [Biome.KarstPillars]: 1.2 },
};

const NAME_PARTS: Record<string, [string[], string[]]> = {
  human: [['Ash', 'Bright', 'Cold', 'Elm', 'Fair', 'Gold', 'Green', 'Hollow', 'Mill', 'Oak', 'Red', 'Stone', 'Wil', 'Thorn', 'Har'], ['ford', 'ton', 'brook', 'wick', 'stead', 'field', 'bury', 'haven', 'mere', 'dale', 'gate']],
  elf: [['Ael', 'Cael', 'Ith', 'Lor', 'Sil', 'Thal', 'Yl', 'Ny', 'Eru', 'Faen'], ['wen', 'ion', 'thas', 'lorien', 'aran', 'ethil', 'nore', 'iel', 'sara']],
  dwarf: [['Khaz', 'Dun', 'Bar', 'Grim', 'Thor', 'Kar', 'Bol', 'Dur', 'Mor'], ['grund', 'dum', 'hold', 'forge', 'heim', 'gard', 'delve', 'rak']],
  orc: [['Gor', 'Ug', 'Mok', 'Zug', 'Krag', 'Ruk', 'Grub', 'Thrak'], ['ash', 'mog', 'gul', 'nak', 'tuk', 'rok', 'za']],
  halfling: [['Bramble', 'Butter', 'Clover', 'Honey', 'Puddle', 'Tumble', 'Willow'], ['bottom', 'burrow', 'hill', 'hollow', 'dell', 'by']],
  goblin: [['Snik', 'Grik', 'Nub', 'Rat', 'Muck', 'Skab', 'Zib'], ['nook', 'pit', 'warren', 'muck', 'snag', 'hole']],
  sylvan: [['Moss', 'Fern', 'Bloom', 'Spore', 'Root', 'Dew', 'Lichen'], ['heart', 'cradle', 'circle', 'veil', 'glade', 'song']],
  drakeborn: [['Vyr', 'Skal', 'Rhaz', 'Ix', 'Thyr', 'Kael', 'Zar'], ['kesh', 'thar', 'ravax', 'ion', 'oth', 'ix']],
  umbral: [['Nyx', 'Vel', 'Sha', 'Mor', 'Eth', 'Ul', 'Qeth'], ['mire', 'veil', 'hollow', 'spire', 'shade', 'reach']],
  giantkin: [['Jot', 'Hrim', 'Ymr', 'Brok', 'Stor', 'Fjal'], ['heim', 'stead', 'garth', 'fell', 'berg']],
};

export function settlementName(race: string, rng: Rng): string {
  const p = NAME_PARTS[race] ?? NAME_PARTS.human;
  return rng.pick(p[0]) + rng.pick(p[1]);
}

export class SiteMap {
  private siteCache = new Map<string, SiteInfo | null>();
  private poiCache = new Map<string, PoiInfo | null>();
  private roadCache = new Map<string, RoadSegment[]>();
  private seed: number;

  constructor(private profile: WorldProfile, private terrain: BaseTerrain) {
    this.seed = deriveSeed(profile.seed, 'sites');
  }

  private cacheTrim<K, V>(m: Map<K, V>, max: number) {
    if (m.size > max) {
      const it = m.keys();
      for (let i = 0; i < max / 4; i++) m.delete(it.next().value as K);
    }
  }

  /** Site in a grid cell or null. */
  siteInCell(cx: number, cz: number): SiteInfo | null {
    const key = cx + ',' + cz;
    const cached = this.siteCache.get(key);
    if (cached !== undefined) return cached;
    const s = this.computeSite(cx, cz);
    this.siteCache.set(key, s);
    this.cacheTrim(this.siteCache, 4096);
    return s;
  }

  private computeSite(cx: number, cz: number): SiteInfo | null {
    const h = hash2i(this.seed, cx, cz);
    const rng = new Rng(h);
    if (rng.float() > clamp(0.5 * this.profile.settlementDensity, 0, 0.9)) return null;
    const x = (cx + 0.2 + rng.float() * 0.6) * SITE_CELL;
    const z = (cz + 0.2 + rng.float() * 0.6) * SITE_CELL;
    if (this.terrain.landness(x, z) < 0.7) return null;
    const biome = this.terrain.biomeAt(x, z);
    const bdef = BIOMES[biome];
    if (rng.float() > bdef.habitable + 0.1) return null;
    // flatness test
    let minH = Infinity, maxH = -Infinity, sum = 0, n = 0;
    for (let a = 0; a < 8; a++) {
      for (const r of [0, 30, 60]) {
        const px = x + Math.cos((a / 8) * Math.PI * 2) * r;
        const pz = z + Math.sin((a / 8) * Math.PI * 2) * r;
        const hh = this.terrain.baseHeight(px, pz);
        minH = Math.min(minH, hh);
        maxH = Math.max(maxH, hh);
        sum += hh;
        n++;
        if (r === 0) break;
      }
    }
    if (minH < 2.5) return null;
    if (maxH - minH > 38) return null;
    const plateau = Math.max(3, sum / n);
    if (plateau > 420) return null;
    const roll = rng.float();
    const size: SiteSize = roll < 0.42 ? 'hamlet' : roll < 0.8 ? 'village' : roll < 0.96 ? 'town' : 'city';
    const radius = { hamlet: 42, village: 70, town: 105, city: 150 }[size];
    // culture
    const races = this.profile.races;
    const race = rng.weighted(races, (r) => r.weight * ((RACE_BIOME_AFFINITY[r.id]?.[biome] ?? 0.5) + 0.2)).id;
    let race2: string | null = null;
    if (races.length > 1 && rng.chance(size === 'hamlet' ? 0.15 : size === 'village' ? 0.3 : 0.6)) {
      const others = races.filter((r) => r.id !== race);
      race2 = rng.weighted(others, (r) => r.weight).id;
    }
    return {
      id: `S${cx}_${cz}`,
      cellX: cx,
      cellZ: cz,
      x, z, plateau, radius, size, race, race2, biome,
      name: settlementName(race, rng.fork('name')),
      seed: h,
      links: [],
      walled: size === 'city' || (size === 'town' && rng.chance(0.5)),
    };
  }

  /** All sites whose influence could reach the area. */
  sitesNear(x: number, z: number, range: number): SiteInfo[] {
    const out: SiteInfo[] = [];
    const c0x = Math.floor((x - range - 200) / SITE_CELL), c1x = Math.floor((x + range + 200) / SITE_CELL);
    const c0z = Math.floor((z - range - 200) / SITE_CELL), c1z = Math.floor((z + range + 200) / SITE_CELL);
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const s = this.siteInCell(cx, cz);
        if (s) out.push(s);
      }
    return out;
  }

  /** Roads owned by a cell (a site connects to up to 2 nearest neighbours). */
  roadsOfCell(cx: number, cz: number): RoadSegment[] {
    const key = cx + ',' + cz;
    const c = this.roadCache.get(key);
    if (c) return c;
    const out: RoadSegment[] = [];
    const s = this.siteInCell(cx, cz);
    if (s) {
      const cands: { s: SiteInfo; d: number }[] = [];
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dz) continue;
          const o = this.siteInCell(cx + dx, cz + dz);
          if (!o) continue;
          const d = Math.hypot(o.x - s.x, o.z - s.z);
          if (d < SITE_CELL * 2.1) cands.push({ s: o, d });
        }
      cands.sort((a, b) => a.d - b.d);
      for (const c2 of cands.slice(0, 2)) {
        // Deduplicate: only the lexicographically smaller id owns the road unless the
        // other side would not pick us (asymmetric nearest neighbour).
        if (s.id > c2.s.id) continue;
        if (!s.links.includes(c2.s.id)) s.links.push(c2.s.id);
        if (!c2.s.links.includes(s.id)) c2.s.links.push(s.id);
        out.push({ ax: s.x, az: s.z, ay: s.plateau, bx: c2.s.x, bz: c2.s.z, by: c2.s.plateau, width: s.size === 'city' || c2.s.size === 'city' ? 3.4 : 2.4 });
      }
      for (const c2 of cands.slice(0, 2)) {
        if (s.id > c2.s.id) {
          if (!s.links.includes(c2.s.id)) s.links.push(c2.s.id);
        }
      }
    }
    this.roadCache.set(key, out);
    this.cacheTrim(this.roadCache, 4096);
    return out;
  }

  roadsNear(x: number, z: number, range: number): RoadSegment[] {
    const out: RoadSegment[] = [];
    const r = range + SITE_CELL * 2.2;
    const c0x = Math.floor((x - r) / SITE_CELL), c1x = Math.floor((x + r) / SITE_CELL);
    const c0z = Math.floor((z - r) / SITE_CELL), c1z = Math.floor((z + r) / SITE_CELL);
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        for (const seg of this.roadsOfCell(cx, cz)) {
          // AABB rejection
          const minx = Math.min(seg.ax, seg.bx) - range, maxx = Math.max(seg.ax, seg.bx) + range;
          const minz = Math.min(seg.az, seg.bz) - range, maxz = Math.max(seg.az, seg.bz) + range;
          if (x < minx || x > maxx || z < minz || z > maxz) continue;
          out.push(seg);
        }
      }
    return out;
  }

  poiInCell(cx: number, cz: number): PoiInfo | null {
    const key = cx + ',' + cz;
    const cached = this.poiCache.get(key);
    if (cached !== undefined) return cached;
    const p = this.computePoi(cx, cz);
    this.poiCache.set(key, p);
    this.cacheTrim(this.poiCache, 8192);
    return p;
  }

  private computePoi(cx: number, cz: number): PoiInfo | null {
    const h = hash2i(this.seed ^ 0x5bd1e995, cx, cz);
    if (hashToFloat(h) > 0.22) return null;
    const rng = new Rng(h);
    const x = (cx + 0.15 + rng.float() * 0.7) * POI_CELL;
    const z = (cz + 0.15 + rng.float() * 0.7) * POI_CELL;
    if (this.terrain.landness(x, z) < 0.6) return null;
    // Keep away from settlements.
    for (const s of this.sitesNear(x, z, 0)) if (Math.hypot(s.x - x, s.z - z) < s.radius + 80) return null;
    const biome = this.terrain.biomeAt(x, z);
    const y = this.terrain.baseHeight(x, z);
    if (y < 1) return null;
    const weird = BIOMES[biome].weird;
    const kinds: [PoiKind, number][] = [
      ['ruin', 1.4], ['shrine', 1], ['camp', 1], ['lair', 0.9], ['grove', BIOMES[biome].vegetation], ['monolith', 0.5 + weird],
      ['tower', 0.5], ['battlefield', 0.4], ['crashsite', 0.15 + weird * 0.5], ['well', 0.4], ['wayshrine', 0.6], ['obelisk', 0.3 + weird],
    ];
    const kind = rng.weighted(kinds, (k) => k[1])[0];
    return { id: `P${cx}_${cz}`, kind, x, z, y, seed: h, biome, radius: kind === 'ruin' || kind === 'battlefield' ? 28 : 14 };
  }

  poisNear(x: number, z: number, range: number): PoiInfo[] {
    const out: PoiInfo[] = [];
    const c0x = Math.floor((x - range) / POI_CELL), c1x = Math.floor((x + range) / POI_CELL);
    const c0z = Math.floor((z - range) / POI_CELL), c1z = Math.floor((z + range) / POI_CELL);
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const p = this.poiInCell(cx, cz);
        if (p && Math.hypot(p.x - x, p.z - z) <= range + p.radius) out.push(p);
      }
    return out;
  }
}

/** Distance from point to segment in XZ, returns [distance, t]. */
export function segDist(px: number, pz: number, s: RoadSegment): [number, number] {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((px - s.ax) * dx + (pz - s.az) * dz) / l2, 0, 1);
  const qx = s.ax + dx * t, qz = s.az + dz * t;
  return [Math.hypot(px - qx, pz - qz), t];
}

export { deriveSeed };
