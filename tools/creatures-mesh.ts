/** Mesh build timing per species (npx tsx tools/creatures-mesh.ts [seed]). */
import { createProfile } from '../src/world/profile';
import { generateSpecies } from '../src/creatures/species';
import { buildBody } from '../src/creatures/body';
import { buildCreatureGeometry } from '../src/creatures/client/creatureMesh';
const seed = Number(process.argv[2] ?? 1);
const list = generateSpecies(createProfile(seed));
let tot = 0;
for (const s of list) {
  const b = buildBody(s);
  const t0 = performance.now();
  const g1 = buildCreatureGeometry(b, 26);
  const t1 = performance.now();
  const g0 = buildCreatureGeometry(b, 60);
  const t2 = performance.now();
  tot += t2 - t0;
  console.log(`${s.index} ${s.plan.padEnd(10)} lod1 ${(t1 - t0).toFixed(0)}ms ${g1.body.index!.count / 3}t  lod0 ${(t2 - t1).toFixed(0)}ms ${g0.body.index!.count / 3}t bounds ${b.min.map((v) => v.toFixed(1))} ${b.max.map((v) => v.toFixed(1))}`);
}
console.log('total', tot.toFixed(0), 'ms');
