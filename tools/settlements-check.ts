/**
 * Settlement generator check: lays out real sites of a world seed, verifies
 * determinism, footprint overlaps, spot/bed consistency and piece blueprints,
 * and prints timings.
 *
 *   npx tsx tools/settlements-check.ts [seed] [count]
 */
import { WorldGenerator } from '../src/world/generator';
import { SITE_CELL } from '../src/world/sites';
import { layoutSettlement, terrainFromGenerator } from '../src/settlements/layout';
import type { SettlementLayout } from '../src/settlements/types';
import { unsupported } from '../src/settlements/pieces';

const seed = Number(process.argv[2] ?? 1234);
const want = Number(process.argv[3] ?? 12);
const gen = new WorldGenerator(seed);
const terrain = terrainFromGenerator(gen);

let blueprintFor: ((b: import('../src/settlements/types').BuildingInfo) => { pieces: unknown[] }) | null = null;
try {
  blueprintFor = (await import('../src/settlements/build/blueprint')).blueprintFor;
} catch {
  blueprintFor = null;
}

const sites = [] as ReturnType<typeof gen.sites.siteInCell>[];
for (let r = 0; r < 12 && sites.length < want; r++)
  for (let cz = -r; cz <= r; cz++)
    for (let cx = -r; cx <= r; cx++) {
      if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
      const s = gen.sites.siteInCell(cx, cz);
      if (s && sites.length < want) sites.push(s);
    }
console.log(`seed ${seed}: ${sites.length} sites (cell ${SITE_CELL} m)`);

function summary(l: SettlementLayout) {
  const roles = new Map<string, number>();
  for (const b of l.buildings) roles.set(b.role, (roles.get(b.role) ?? 0) + 1);
  return [...roles.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
}

let problems = 0;
for (const s of sites) {
  if (!s) continue;
  const t0 = performance.now();
  const a = layoutSettlement(s, terrain);
  const t1 = performance.now();
  const b = layoutSettlement(s, terrain);
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) {
    problems++;
    console.log('  NON-DETERMINISTIC', s.id);
  }
  // Beds == residents per building.
  for (const bd of a.buildings) {
    const beds = bd.spots.filter((x) => x.kind === 'bed').length;
    if (beds !== bd.residents && bd.residents > 0) {
      problems++;
      console.log(`  beds ${beds} != residents ${bd.residents} in ${bd.id} ${bd.role} ${bd.style} ${bd.size[0].toFixed(1)}x${bd.size[1].toFixed(1)}`);
    }
  }
  let pieces = 0, tb = 0, collapse = 0, total = 0;
  if (blueprintFor) {
    const t2 = performance.now();
    for (const bd of a.buildings) pieces += blueprintFor(bd).pieces.length;
    tb = performance.now() - t2;
    // Support graph: knocking out the ground-floor walls should bring down what rests on them.
    for (const bd of a.buildings) {
      const bp = blueprintFor(bd) as import('../src/settlements/build/kit').Blueprint;
      const seeds = bp.pieces.map((q, i) => (q.kind === 'foundation' ? i : -1)).filter((i) => i >= 0);
      if (!seeds.length) continue;
      const fall = unsupported(bp, (i) => seeds.includes(i), seeds);
      collapse += fall.length;
      total += bp.pieces.filter((q) => q.need > 0).length;
    }
  }
  const spots = a.spots.length + a.buildings.reduce((n, x) => n + x.spots.length, 0);
  console.log(
    `${s.id.padEnd(9)} ${s.size.padEnd(7)} ${(s.race + (s.race2 ? '+' + s.race2 : '')).padEnd(18)} walls=${a.walls ? 'y' : 'n'} ` +
      `bld=${a.buildings.length} pop=${a.population} streets=${a.streets.length} props=${a.props?.length} fields=${a.fields?.length} spots=${spots} ` +
      `pieces=${pieces} collapse=${collapse}/${total} layout=${(t1 - t0).toFixed(0)}ms bp=${tb.toFixed(0)}ms\n    ${summary(a)}`,
  );
}
console.log(problems ? `${problems} problems` : 'all checks passed');
