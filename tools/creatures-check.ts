/** Sanity check for the species generator & body layout across seeds (npx tsx tools/creatures-check.ts). */
import { createProfile } from '../src/world/profile';
import { generateSpecies } from '../src/creatures/species';
import { buildBody } from '../src/creatures/body';

const seeds = process.argv.slice(2).map(Number);
for (const seed of seeds.length ? seeds : [1, 2, 3, 42, 1337, 99999]) {
  const p = createProfile(seed);
  const t0 = performance.now();
  const list = generateSpecies(p);
  const t1 = performance.now();
  let bones = 0, prims = 0, bad = 0;
  for (const s of list) {
    const b = buildBody(s);
    bones = Math.max(bones, b.bones.length);
    prims = Math.max(prims, b.prims.length);
    const nums = JSON.stringify([b.bones, b.prims, b.membranes, b.eyes]);
    if (/null|NaN/.test(nums)) { bad++; console.log('  BAD', s.name, s.plan); }
  }
  console.log(`seed ${seed} '${p.name}' weird=${p.lifeWeirdness.toFixed(2)} species=${list.length} gen=${(t1 - t0).toFixed(1)}ms maxBones=${bones} maxPrims=${prims} bad=${bad}`);
  for (const s of list) console.log(`  ${s.index.toString().padStart(2)} ${s.role.padEnd(12)} ${s.plan.padEnd(10)} ${s.integument.padEnd(8)} ${s.size.padEnd(6)} L=${s.length.toFixed(2)} hp=${s.hp} dmg=${s.damage} ${s.sociality}/${s.temperament} ${s.gait} biomes=${s.biomes.join(',')} :: ${s.name}`);
}
