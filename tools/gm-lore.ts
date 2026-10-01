/**
 * Dump the generated lore of a world: `npx tsx tools/gm-lore.ts [seed...]`.
 * Prints the world summary, legends, nearby POI legends and settlement lore so
 * writers can eyeball variety across seeds.
 */
import { createProfile } from '../src/world/profile';
import { WorldGenerator } from '../src/world/generator';
import { getLore, loreSummary, poiLore, siteLore } from '../src/gm/lore';

const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
for (const seed of seeds.length ? seeds : [1, 42, 1337]) {
  const profile = createProfile(seed);
  const lore = getLore(profile);
  console.log(`\n=================== seed ${seed} ===================`);
  console.log(loreSummary(profile));
  console.log('\n-- legends --');
  for (const l of lore.legends.filter((x) => !x.id.startsWith('god.') && !x.id.startsWith('figure.'))) console.log(`* ${l.title}: ${l.text}`);
  const gen = new WorldGenerator(profile);
  console.log('\n-- points of interest near origin --');
  for (const poi of gen.sites.poisNear(0, 0, 1600).slice(0, 8)) {
    const pl = poiLore(profile, poi);
    console.log(`* [${poi.kind}] ${pl.name}: ${pl.legend} HOOK: ${pl.hook}`);
  }
  console.log('\n-- settlements near origin --');
  for (const s of gen.sites.sitesNear(0, 0, 2000).slice(0, 4)) {
    const sl = siteLore(profile, s);
    console.log(`* ${sl.line} Trouble: ${sl.trouble}.`);
  }
}
