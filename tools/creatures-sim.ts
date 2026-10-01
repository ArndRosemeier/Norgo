/**
 * Headless ecology test: runs the real GameServer with one player and reports
 * creature counts, behaviour mix and creature-system tick cost.
 *   npx tsx tools/creatures-sim.ts [seed] [seconds]
 */
import { GameServer } from '../src/server/GameServer';
import type { CreatureSystem } from '../src/creatures/server/CreatureSystem';

const seed = Number(process.argv[2] ?? 1);
const secs = Number(process.argv[3] ?? 60);
const srv = new GameServer(seed);
const handler = srv.connect(() => {});
handler({ t: 'hello', version: 1, name: 'Tester', appearance: {} as never });
const player = srv.players()[0];
// Optional 4th arg 'uw': start in the underworld (find an open cavern floor near the spawn).
if (process.argv[4] === 'uw') {
  for (let i = 0; i < 400; i++) {
    const x = player.pos[0] + (i % 20) * 15, z = player.pos[2] + Math.floor(i / 20) * 15;
    const y = srv.gen.findGround(x, -160, z, 160);
    if (Number.isFinite(y) && srv.gen.isUnderworld(x, y + 1, z)) { player.pos = [x, y, z]; srv.entities.reindex(player); console.log('underworld at', x, y, z, 'biome', srv.gen.cachedColumn(x, z).uwBiome); break; }
  }
}
const cs = srv.systems.find((s) => s.name === 'creatures') as CreatureSystem;
let csTime = 0, maxTick = 0;
const origTick = cs.tick.bind(cs);
cs.tick = (dt: number) => { const t0 = performance.now(); origTick(dt); const d = performance.now() - t0; csTime += d; maxTick = Math.max(maxTick, d); };
const origSlow = cs.slowTick.bind(cs);
let slowTime = 0, maxSlow = 0;
cs.slowTick = (dt: number) => { const t0 = performance.now(); origSlow(dt); const d = performance.now() - t0; slowTime += d; maxSlow = Math.max(maxSlow, d); };
const t0 = performance.now();
for (let i = 0; i < secs * 20; i++) {
  // Walk the player slowly east so spawning/despawning is exercised.
  if (i % 20 === 0 && i > 0 && process.argv[4] !== 'uw') {
    const gy = srv.gen.findGround(player.pos[0] + 3, player.pos[1] + 30, player.pos[2], 80);
    player.pos = [player.pos[0] + 3, Number.isFinite(gy) ? gy : player.pos[1], player.pos[2]];
    srv.entities.reindex(player);
  }
  srv.tick();
  if ((i + 1) % (20 * 10) === 0) {
    const cr = [...srv.entities.all.values()].filter((e) => e.kind === 'creature');
    const beh: Record<string, number> = {};
    for (const c of cr) beh[c.creature!.behavior ?? '?'] = (beh[c.creature!.behavior ?? '?'] ?? 0) + 1;
    const sp: Record<string, number> = {};
    for (const c of cr) sp[c.name] = (sp[c.name] ?? 0) + 1;
    const nan = cr.filter((c) => c.pos.some((v) => !Number.isFinite(v))).length;
    console.log(`t=${(i + 1) / 20}s creatures=${cr.length} alive=${cr.filter((c) => c.alive).length} nan=${nan} player=${player.pos.map((v) => v.toFixed(0))} hp=${player.hp.toFixed(0)} biome=${srv.gen.biomeAt(player.pos[0], player.pos[2])}`);
    console.log('   behaviours', JSON.stringify(beh));
    console.log('   species', JSON.stringify(sp));
  }
}
const wall = performance.now() - t0;
console.log(`creature tick avg ${(csTime / (secs * 20)).toFixed(3)} ms (max ${maxTick.toFixed(2)}), slowTick avg ${(slowTime / secs).toFixed(2)} ms (max ${maxSlow.toFixed(1)}), wall ${(wall / 1000).toFixed(1)} s`);
