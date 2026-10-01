/** Server-side ObjectSystem smoke test: npx tsx tools/flora-servertest.ts [seed] */
import { GameServer } from '../src/server/GameServer';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/shared/protocol';
import type { ObjectSystem } from '../src/flora/server/ObjectSystem';
import { randomAppearance } from '../src/humanoid/appearance';

const seed = Number(process.argv[2] ?? 1234);
const s = new GameServer(seed);
const inbox: ServerMessage[] = [];
const send = s.connect((m) => inbox.push(m));
send({ t: 'hello', version: PROTOCOL_VERSION, name: 'Tester', appearance: randomAppearance('human' as never, 1) });
const player = s.players()[0];
console.log('player at', player.pos.map((v) => v.toFixed(1)).join(','));
const objs = s.services.objects as ObjectSystem;
let t0 = performance.now();
const near = objs.near(player.pos, 40 > 12 ? 10 : 10);
console.log('near(10):', near.length, 'objects in', (performance.now() - t0).toFixed(0), 'ms; kinds', [...new Set(near.map((o) => o.kind))].join(','));
const far = objs.near(player.pos, 30);
console.log('near(30) cached-only:', far.length);
for (let i = 0; i < 40; i++) s.tick();
console.log('after ticks near(30):', objs.near(player.pos, 30).length, 'stats', JSON.stringify(objs.stats));
// Harvest each object type once by teleporting next to it.
const kinds = new Set<string>();
for (const o of objs.near(player.pos, 30)) {
  if (kinds.has(o.kind)) continue;
  kinds.add(o.kind);
  player.pos = [o.pos[0] + 1, o.pos[1], o.pos[2]];
  const before = player.inventory?.items.length ?? 0;
  let hp = o.hp;
  for (let k = 0; k < 60 && hp > 0; k++) {
    s.time.now += 0.5;
    send({ t: 'harvest', object: o.id, point: [o.pos[0], o.pos[1] + 1, o.pos[2]] });
    hp = objs.state(o.id)?.hp ?? hp;
  }
  const st = objs.state(o.id);
  console.log(o.kind.padEnd(9), 'id', o.id, 'hp', o.hp, '->', st?.state, st?.hp, 'items', (player.inventory?.items.length ?? 0) - before, player.inventory?.items.slice(-3).map((i) => i.defId + 'x' + i.count).join(' '));
}
const save = objs.save();
console.log('save states', (save as { states: unknown[] }).states.length);
s.time.now += 4000;
s.slowTick?.(1);
(s as unknown as { systems: { slowTick?: (dt: number) => void }[] }).systems.forEach((x) => x.slowTick?.(1));
console.log('after regrow, states', objs.stats.states, 'objects msgs', inbox.filter((m) => m.t === 'objects').length);
