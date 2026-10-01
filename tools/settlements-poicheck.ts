/** POI structure check: every kind builds deterministically with sane piece counts. npx tsx tools/settlements-poicheck.ts */
import { WorldGenerator } from '../src/world/generator';
import { layoutPoi, poiBlueprint } from '../src/settlements/poi';
import { terrainFromGenerator } from '../src/settlements/layout';
import type { PoiInfo } from '../src/world/sites';
const gen = new WorldGenerator(1234);
const t = terrainFromGenerator(gen);
const seen = new Map<string, PoiInfo>();
for (let r = 0; r < 40 && seen.size < 12; r++)
  for (let cz = -r; cz <= r; cz++)
    for (let cx = -r; cx <= r; cx++) {
      const p = gen.sites.poiInCell(cx, cz);
      if (p && !seen.has(p.kind)) seen.set(p.kind, p);
    }
for (const p of seen.values()) {
  const t0 = performance.now();
  const l = layoutPoi(p, t);
  const bp = poiBlueprint(l);
  const again = JSON.stringify(layoutPoi(p, t)) === JSON.stringify(l);
  const prims = bp.pieces.reduce((n, q) => n + q.prims.length, 0);
  console.log(`${p.kind.padEnd(12)} pieces=${bp.pieces.length} prims=${prims} spots=${l.spots.length} det=${again} ${(performance.now() - t0).toFixed(1)}ms — ${l.description}`);
}
