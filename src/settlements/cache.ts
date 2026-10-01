/**
 * Shared settlement/POI cache (server and client each own one): layouts by
 * site id, POI layouts, and "units" — anything that owns destructible pieces
 * (buildings, prop groups, POI structures) — resolvable from a piece id.
 */
import type { SiteInfo, PoiInfo } from '../world/sites';
import type { BuildingInfo, PoiLayout, SettlementLayout } from './types';
import type { Vec3 } from '../shared/types';
import { layoutSettlement, type LayoutTerrain } from './layout';
import { layoutPoi, poiBlueprint } from './poi';
import { blueprintFor, propGroupBlueprint, propGroups, type PropGroup } from './build/blueprint';
import type { Blueprint } from './build/kit';
import { parsePieceId } from './pieces';

/** World queries the settlement module needs. WorldGenerator provides them via `worldFromGenerator`. */
export interface SettlementWorld {
  terrain: LayoutTerrain;
  siteInCell(cx: number, cz: number): SiteInfo | null;
  poiInCell(cx: number, cz: number): PoiInfo | null;
  sitesNear(x: number, z: number, r: number): SiteInfo[];
  poisNear(x: number, z: number, r: number): PoiInfo[];
}

export function worldFromGenerator(gen: {
  heightAt(x: number, z: number): number;
  cachedColumn(x: number, z: number): { road: number };
  sites: {
    siteInCell(cx: number, cz: number): SiteInfo | null;
    poiInCell(cx: number, cz: number): PoiInfo | null;
    sitesNear(x: number, z: number, r: number): SiteInfo[];
    poisNear(x: number, z: number, r: number): PoiInfo[];
    roadsNear(x: number, z: number, r: number): import('../world/sites').RoadSegment[];
    roadsOfCell(cx: number, cz: number): import('../world/sites').RoadSegment[];
  };
}): SettlementWorld {
  return {
    terrain: {
      heightAt: (x, z) => gen.heightAt(x, z),
      roadAt: (x, z) => gen.cachedColumn(x, z).road,
      roadsNear: (x, z, r) => gen.sites.roadsNear(x, z, r),
      roadsOfCell: (cx, cz) => gen.sites.roadsOfCell(cx, cz),
    },
    siteInCell: (cx, cz) => gen.sites.siteInCell(cx, cz),
    poiInCell: (cx, cz) => gen.sites.poiInCell(cx, cz),
    sitesNear: (x, z, r) => gen.sites.sitesNear(x, z, r),
    poisNear: (x, z, r) => gen.sites.poisNear(x, z, r),
  };
}

/** Something that owns pieces: building, prop group or POI structure. */
export interface Unit {
  /** Building id (`B:<site>:<token>` or `P:<poiId>`). */
  id: string;
  pos: Vec3;
  yaw: number;
  /** Site or POI id. */
  owner: string;
  building: BuildingInfo | null;
  group: PropGroup | null;
  blueprint(): Blueprint;
}

const CELL_RE = /^[SP](-?\d+)_(-?\d+)$/;

export class SettlementCache {
  private layouts = new Map<string, SettlementLayout>();
  private pois = new Map<string, PoiLayout>();
  private units = new Map<string, Map<string, Unit>>();
  private order: string[] = [];
  /** Max cached layouts before the oldest are dropped. */
  max = 48;

  constructor(readonly world: SettlementWorld) {}

  site(id: string): SiteInfo | null {
    const m = CELL_RE.exec(id);
    if (!m || id[0] !== 'S') return null;
    return this.world.siteInCell(Number(m[1]), Number(m[2]));
  }

  poiInfo(id: string): PoiInfo | null {
    const m = CELL_RE.exec(id);
    if (!m || id[0] !== 'P') return null;
    return this.world.poiInCell(Number(m[1]), Number(m[2]));
  }

  private touch(id: string) {
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(id);
    while (this.order.length > this.max) {
      const old = this.order.shift()!;
      this.layouts.delete(old);
      this.pois.delete(old);
      this.units.delete(old);
    }
  }

  layout(site: SiteInfo): SettlementLayout {
    let l = this.layouts.get(site.id);
    if (!l) {
      l = layoutSettlement(site, this.world.terrain);
      this.layouts.set(site.id, l);
    }
    this.touch(site.id);
    return l;
  }

  layoutById(id: string): SettlementLayout | null {
    const hit = this.layouts.get(id);
    if (hit) return hit;
    const s = this.site(id);
    return s ? this.layout(s) : null;
  }

  poi(p: PoiInfo): PoiLayout {
    let l = this.pois.get(p.id);
    if (!l) {
      l = layoutPoi(p, this.world.terrain);
      this.pois.set(p.id, l);
    }
    this.touch(p.id);
    return l;
  }

  /** All units (buildings + prop groups, or the POI structure) of a site / POI id. */
  unitsOf(owner: string): Map<string, Unit> | null {
    const hit = this.units.get(owner);
    if (hit) return hit;
    const m = new Map<string, Unit>();
    if (owner[0] === 'S') {
      const l = this.layoutById(owner);
      if (!l) return null;
      const her = l.heraldry;
      for (const b of l.buildings) m.set(b.id, { id: b.id, pos: b.pos, yaw: b.yaw, owner, building: b, group: null, blueprint: () => blueprintFor(b, her) });
      for (const g of propGroups(l)) m.set(g.id, { id: g.id, pos: g.pos, yaw: 0, owner, building: null, group: g, blueprint: () => propGroupBlueprint(g, her) });
    } else {
      const info = this.poiInfo(owner);
      if (!info) return null;
      const l = this.poi(info);
      const b = l.structure;
      m.set(b.id, { id: b.id, pos: b.pos, yaw: b.yaw, owner, building: b, group: null, blueprint: () => poiBlueprint(l) });
    }
    this.units.set(owner, m);
    return m;
  }

  unit(buildingId: string): Unit | null {
    const ref = parsePieceId(buildingId + ':0');
    if (!ref) return null;
    return this.unitsOf(ref.owner)?.get(buildingId) ?? null;
  }
}
