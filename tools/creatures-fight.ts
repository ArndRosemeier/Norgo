/** Interaction test: predator vs player, grazer flight, taming (npx tsx tools/creatures-fight.ts [seed]). */
import { GameServer } from '../src/server/GameServer';
import type { CreatureSystem } from '../src/creatures/server/CreatureSystem';

const seed = Number(process.argv[2] ?? 7);
const srv = new GameServer(seed);
srv.connect(() => {})({ t: 'hello', version: 1, name: 'Tester', appearance: {} as never });
const p = srv.players()[0];
const cs = srv.systems.find((s) => s.name === 'creatures') as CreatureSystem;
const list = Array.from({ length: cs.speciesCount() }, (_, i) => cs.speciesInfo(i)!);
const pred = list.find((s) => s.temperament === 'aggressive' && (s.role === 'predator' || s.role === 'apex'))!;
const graz = list.find((s) => s.role === 'grazer' && s.temperament === 'skittish') ?? list.find((s) => s.role === 'grazer')!;
const terr = list.find((s) => s.temperament === 'territorial');
console.log("predator", pred.name, pred.plan, "grazer", graz.name, "territorial", terr?.name, terr?.medium, terr?.plan, terr?.runSpeed);
const at = (dx: number, dz: number): [number, number, number] => [p.pos[0] + dx, p.pos[1] + 2, p.pos[2] + dz];
const a = cs.spawn(pred.index, at(14, 0), { growth: 1 })!;
const g = cs.spawn(graz.index, at(-8, 6), { growth: 1 })!;
const t = terr ? cs.spawn(terr.index, at(-6, -10), { growth: 1 }) : null;
const boss = cs.spawn(pred.index, at(40, 40), { boss: true })!;
console.log('boss', boss.name, boss.title, 'hp', boss.maxHp, 'scale', boss.scale.toFixed(2));
for (let i = 0; i < 20 * 20; i++) {
  srv.tick();
  if (i % 20 === 0) {
    const d = (e: typeof a) => Math.hypot(e.pos[0] - p.pos[0], e.pos[2] - p.pos[2]).toFixed(1);
    console.log(`t=${i / 20}s playerHp=${p.hp.toFixed(0)} | pred ${a.creature!.behavior} ${a.anim.move}${a.anim.action ? '/' + a.anim.action.id : ''} d=${d(a)} | grazer ${g.creature!.behavior} ${g.anim.move} d=${d(g)}${t ? ` | terr ${t.creature!.behavior} ${t.anim.move} v=${Math.hypot(t.vel[0],t.vel[2]).toFixed(2)} y=${t.pos[1].toFixed(1)} d=${d(t)}` : ''}`);
  }
  if (!p.alive) { console.log('player died'); break; }
}
// Damage the grazer from the player and watch the reaction.
srv.services.combat.damage(g, 3, 'pierce', p);
srv.tick();
console.log('after hit grazer:', g.creature!.behavior);
const tamed = cs.tryTame(g, p, 100);
console.log('tame attempt:', tamed, g.creature!.behavior, g.faction);
