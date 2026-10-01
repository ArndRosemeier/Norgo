/**
 * Points of interest: layout (one structure record + spots) and blueprint.
 * Pure & deterministic. Detailed per-kind structures live in build/poiBuild.ts.
 */
import type { PoiInfo } from '../world/sites';
import type { BuildingRole, PoiLayout, SmartSpot } from './types';
import { deriveSeed } from '../core/rng';
import type { LayoutTerrain } from './layout';
import { Kit, type Blueprint } from './build/kit';
import { buildPoiStructure, poiDescription, poiSpots } from './build/poiBuild';

const ROLE: Record<string, BuildingRole> = {
  ruin: 'ruin', shrine: 'shrine', camp: 'camp', lair: 'ruin', grove: 'monument', monolith: 'monument', tower: 'watchtower',
  battlefield: 'ruin', crashsite: 'monument', well: 'well', wayshrine: 'shrine', obelisk: 'monument',
};

export function layoutPoi(p: PoiInfo, terrain: LayoutTerrain): PoiLayout {
  const seed = deriveSeed(p.seed, 'poi');
  // Ground samples under the footprint (structure sits on the lowest high point).
  const R = p.radius;
  const g: number[] = [];
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.push(terrain.heightAt(p.x + dx * R * 0.5, p.z + dz * R * 0.5));
  const yc = terrain.heightAt(p.x, p.z);
  const y = yc;
  const yaw = ((seed >>> 8) / 16777216) * Math.PI * 2;
  const id = `P:${p.id}`;
  const structure = {
    id, role: ROLE[p.kind] ?? 'monument', style: 'ruined' as const, race: 'human' as const,
    pos: [p.x, y, p.z] as [number, number, number], yaw,
    size: [R * 2, R * 2, 6] as [number, number, number],
    doors: [], spots: [] as SmartSpot[], residents: 0, pieceCount: 0, seed,
    ground: g.map((h) => h - y) as [number, number, number, number],
  };
  const l: PoiLayout = { poiId: p.id, kind: p.kind, center: [p.x, y, p.z], structure, spots: [], description: poiDescription(p), extent: R * 1.6 };
  l.spots = poiSpots(l, terrain);
  structure.spots = l.spots;
  return l;
}

const cache = new Map<string, Blueprint>();

export function poiBlueprint(l: PoiLayout): Blueprint {
  const hit = cache.get(l.poiId);
  if (hit) return hit;
  const k = new Kit(deriveSeed(l.structure.seed, 'kit'));
  buildPoiStructure(k, l);
  const bp = k.finish(null);
  cache.set(l.poiId, bp);
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return bp;
}
