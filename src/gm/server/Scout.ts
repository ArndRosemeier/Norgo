/**
 * World scout: finds interesting, not-yet-explored features around a player so
 * the game master can nudge, answer "where" questions and anchor quests:
 * points of interest, settlements, shafts down to the underworld, cave mouths,
 * floating islands and gravity anomalies.
 *
 * POIs and settlements come from the deterministic SiteMap. Shafts and gravity
 * anomalies are enumerated from the same cellular layout the generator uses and
 * then *verified* against the generator (column data / gravityAt), so a change
 * in the generator degrades to "fewer hints" rather than wrong hints. Cave mouths
 * and islands are found by amortised column sampling (a few columns per second).
 */
import type { WorldGenerator } from '../../world/generator';
import type { PoiInfo, SiteInfo } from '../../world/sites';
import { POI_CELL, SITE_CELL } from '../../world/sites';
import { hash2i, hashToFloat } from '../../core/rng';
import type { Vec3 } from '../../shared/types';

export type FeatureKind = 'poi' | 'site' | 'shaft' | 'cave' | 'island' | 'anomaly';

export interface Feature {
  /** Stable id: POI/site ids, or "shaft:x,z" etc. */
  id: string;
  kind: FeatureKind;
  x: number;
  y: number;
  z: number;
  /** Extra: POI kind, site size, 'heavy'/'light'... */
  sub?: string;
  /** Influence radius (m). */
  radius: number;
}

const SHAFT_CELL = 820;
const ANOMALY_CELL = 520;

/** Look up a POI by id ("P{cx}_{cz}"). */
export function poiById(gen: WorldGenerator, id: string): PoiInfo | null {
  const m = /^P(-?\d+)_(-?\d+)$/.exec(id);
  return m ? gen.sites.poiInCell(Number(m[1]), Number(m[2])) : null;
}

/** Look up a settlement by id ("S{cx}_{cz}"). */
export function siteById(gen: WorldGenerator, id: string): SiteInfo | null {
  const m = /^S(-?\d+)_(-?\d+)$/.exec(id);
  return m ? gen.sites.siteInCell(Number(m[1]), Number(m[2])) : null;
}

/** Shafts linking surface and underworld within range (verified). */
export function shaftsNear(gen: WorldGenerator, x: number, z: number, range: number): Feature[] {
  const out: Feature[] = [];
  const seed = gen.seed ^ 0x5af7;
  const freq = gen.profile.shaftFrequency;
  const c0x = Math.floor((x - range) / SHAFT_CELL), c1x = Math.floor((x + range) / SHAFT_CELL);
  const c0z = Math.floor((z - range) / SHAFT_CELL), c1z = Math.floor((z + range) / SHAFT_CELL);
  for (let cz = c0z; cz <= c1z; cz++)
    for (let cx = c0x; cx <= c1x; cx++) {
      const h = hash2i(seed, cx, cz);
      if (hashToFloat(h) >= 0.22 * freq) continue;
      // Same feature-point formula as cellular2 (jitter 0.7).
      const fx = (cx + 0.5 + (hashToFloat(h) - 0.5) * 0.7) * SHAFT_CELL;
      const fz = (cz + 0.5 + (hashToFloat(h * 2654435761) - 0.5) * 0.7) * SHAFT_CELL;
      if (Math.hypot(fx - x, fz - z) > range) continue;
      const col = gen.cachedColumn(fx, fz);
      if (col.shR <= 0) continue;
      out.push({ id: `shaft:${Math.round(col.shX)},${Math.round(col.shZ)}`, kind: 'shaft', x: col.shX, y: col.height, z: col.shZ, radius: col.shR });
    }
  return out;
}

/** Gravity anomalies within range (verified by sampling gravity at the centre). */
export function anomaliesNear(gen: WorldGenerator, x: number, z: number, range: number): Feature[] {
  const out: Feature[] = [];
  const seed = gen.seed ^ 0x6a1;
  const freq = gen.profile.gravityAnomalyFrequency;
  const base = gen.profile.baseGravity;
  const c0x = Math.floor((x - range) / ANOMALY_CELL), c1x = Math.floor((x + range) / ANOMALY_CELL);
  const c0z = Math.floor((z - range) / ANOMALY_CELL), c1z = Math.floor((z + range) / ANOMALY_CELL);
  for (let cz = c0z; cz <= c1z; cz++)
    for (let cx = c0x; cx <= c1x; cx++) {
      const h = hash2i(seed, cx, cz);
      if (hashToFloat(h) >= 0.18 * freq) continue;
      const fx = (cx + 0.5 + (hashToFloat(h) - 0.5) * 0.8) * ANOMALY_CELL;
      const fz = (cz + 0.5 + (hashToFloat(h * 2654435761) - 0.5) * 0.8) * ANOMALY_CELL;
      if (Math.hypot(fx - x, fz - z) > range) continue;
      const fy = gen.heightAt(fx, fz) + 10;
      const g = gen.gravityAt(fx, fy, fz);
      const ratio = g / base;
      if (ratio > 0.85 && ratio < 1.15) continue;
      const R = 30 + hashToFloat(Math.imul(h, 3) + 1) * 70;
      out.push({ id: `grav:${Math.round(fx)},${Math.round(fz)}`, kind: 'anomaly', x: fx, y: fy, z: fz, radius: R, sub: ratio > 1 ? 'heavy' : 'light' });
    }
  return out;
}

/**
 * Per-player amortised scanner for features that need column sampling
 * (cave mouths, floating islands). Keeps a bounded memory of found features.
 */
export class ScoutMemory {
  /** Found sampled features (caves/islands), by id. */
  found = new Map<string, Feature>();
  /** Feature ids the player has been near (explored). */
  visited = new Set<string>();
  /** Feature ids already nudged (avoid repeating a hint). */
  nudged = new Set<string>();
  private ring = 0;
  private step = 0;

  /** Sample a few columns around the player (call once per second). */
  scan(gen: WorldGenerator, pos: Vec3, budget = 10) {
    const RING_STEP = 60, MAX_RINGS = 9;
    for (let i = 0; i < budget; i++) {
      const r = (this.ring + 1) * RING_STEP;
      const n = Math.max(8, Math.round((Math.PI * 2 * r) / RING_STEP));
      const a = (this.step / n) * Math.PI * 2;
      const x = pos[0] + Math.cos(a) * r, z = pos[2] + Math.sin(a) * r;
      const col = gen.cachedColumn(x, z);
      if (col.caveEntrance > 0.6 && col.land > 0.6) {
        // Snap to a 120 m grid so the same cave mouth gets one id.
        const gx = Math.round(x / 120), gz = Math.round(z / 120);
        const id = `cave:${gx},${gz}`;
        if (!this.found.has(id)) this.found.set(id, { id, kind: 'cave', x, y: col.height, z, radius: 30 });
      }
      if (col.iTop > -1e8) {
        const gx = Math.round(x / 180), gz = Math.round(z / 180);
        const id = `isle:${gx},${gz}`;
        if (!this.found.has(id)) this.found.set(id, { id, kind: 'island', x, y: col.iTop, z, radius: 60 });
      }
      this.step++;
      if (this.step >= n) {
        this.step = 0;
        this.ring = (this.ring + 1) % MAX_RINGS;
      }
    }
    if (this.found.size > 300) {
      // Forget the oldest finds.
      const it = this.found.keys();
      for (let i = 0; i < 100; i++) this.found.delete(it.next().value as string);
    }
  }

  /** Mark features within their radius as visited. */
  markVisited(features: Feature[], pos: Vec3) {
    for (const f of features) if (Math.hypot(f.x - pos[0], f.z - pos[2]) < f.radius + 25) this.visited.add(f.id);
  }

  save() {
    return { visited: [...this.visited].slice(-500), nudged: [...this.nudged].slice(-500) };
  }

  load(d: { visited?: string[]; nudged?: string[] } | undefined) {
    if (!d) return;
    this.visited = new Set(d.visited ?? []);
    this.nudged = new Set(d.nudged ?? []);
  }
}

/** All known features within range of a position (cheap: no sampling). */
export function featuresNear(gen: WorldGenerator, mem: ScoutMemory, pos: Vec3, range: number): Feature[] {
  const out: Feature[] = [];
  for (const p of gen.sites.poisNear(pos[0], pos[2], Math.min(range, POI_CELL * 6))) out.push({ id: p.id, kind: 'poi', x: p.x, y: p.y, z: p.z, sub: p.kind, radius: p.radius });
  for (const s of gen.sites.sitesNear(pos[0], pos[2], Math.min(range, SITE_CELL * 2))) {
    if (Math.hypot(s.x - pos[0], s.z - pos[2]) <= range) out.push({ id: s.id, kind: 'site', x: s.x, y: s.plateau, z: s.z, sub: s.size, radius: s.radius });
  }
  out.push(...shaftsNear(gen, pos[0], pos[2], range));
  out.push(...anomaliesNear(gen, pos[0], pos[2], range));
  for (const f of mem.found.values()) if (Math.hypot(f.x - pos[0], f.z - pos[2]) <= range) out.push(f);
  return out;
}
