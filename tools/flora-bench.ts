/** Flora scatter benchmark: npx tsx tools/flora-bench.ts [seed] */
import { WorldGenerator } from '../src/world/generator';
import { scatterChunk } from '../src/flora/scatter';
import { getFloraCatalog, parseKind } from '../src/flora/species';
import { BIOMES } from '../src/world/biomes';
import { SCATTER_STRIDE } from '../src/world/scatterTypes';

const seed = Number(process.argv[2] ?? 1234);
const g = new WorldGenerator(seed);
const t0 = performance.now();
const cat = getFloraCatalog(g.profile);
console.log('catalog', cat.species.length, 'species in', (performance.now() - t0).toFixed(1), 'ms; trees:',
  cat.species.filter((s) => s.cls === 'tree').map((s) => s.form + ':' + s.name).join(', '));
const sp = g.findSpawn();
const counts = new Map<string, number>();
for (const lod of [0, 1, 2, 3]) {
  const s = 32 << lod;
  let ms = 0, fillMs = 0, n = 0, inst = 0, ids = 0;
  for (let dz = -2; dz <= 2; dz++)
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const ox = (Math.floor(sp[0] / s) + dx) * s, oy = (Math.floor(sp[1] / s) + dy) * s, oz = (Math.floor(sp[2] / s) + dz) * s;
        const t1 = performance.now();
        const c = g.fillChunk(ox, oy, oz, lod);
        const t2 = performance.now();
        fillMs += t2 - t1;
        if (c.uniform) continue;
        const b = scatterChunk(g, c, ox / s, oy / s, oz / s);
        ms += performance.now() - t2;
        n++;
        for (const bb of b) {
          const k = parseKind(bb.kind);
          const name = cat.species[k.sp].form;
          const cnt = bb.data.length / SCATTER_STRIDE;
          inst += cnt;
          if (bb.ids) ids += cnt;
          if (lod === 0) counts.set(name, (counts.get(name) ?? 0) + cnt);
        }
      }
  console.log('lod', lod, 'chunks', n, 'scatter avg ms', (ms / Math.max(1, n)).toFixed(2), 'fill avg ms', (fillMs / 75).toFixed(2), 'instances', inst, 'ids', ids);
}
console.log('lod0 forms', [...counts.entries()].map(([k, v]) => k + ':' + v).join(' '));
console.log('spawn biome', BIOMES[g.biomeAt(sp[0], sp[2])].name);
// id stability: tree ids found at LOD 0 vs LOD 2 over the same volume (eight 128 m LOD-2 chunks)
const big = 128;
const bx = Math.floor(sp[0] / big) * big, by = Math.floor(sp[1] / big) * big, bz = Math.floor(sp[2] / big) * big;
const idsAt = (lod: number) => {
  const s = 32 << lod, set = new Set<number>();
  for (let y = by - big; y < by + big; y += s)
    for (let z = bz; z < bz + big * 2; z += s)
      for (let x = bx; x < bx + big * 2; x += s) {
        const c = g.fillChunk(x, y, z, lod);
        if (c.uniform) continue;
        for (const b of scatterChunk(g, c, x / s, y / s, z / s)) {
          const k = parseKind(b.kind);
          if (cat.species[k.sp].cls === 'tree' && b.ids) for (const id of b.ids) set.add(id);
        }
      }
  return set;
};
const a = idsAt(0), b2 = idsAt(2), b3 = idsAt(3);
let common = 0, common3 = 0;
for (const id of a) {
  if (b2.has(id)) common++;
  if (b3.has(id)) common3++;
}
console.log('tree ids lod0', a.size, 'lod2', b2.size, 'common', common, '| lod3', b3.size, 'common', common3);
