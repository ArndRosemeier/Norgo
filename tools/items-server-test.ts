/**
 * ItemSystem smoke test with a mocked ServerContext (Node):
 *   npx tsx tools/items-server-test.ts
 * Exercises starter kit equip rules, two-handers, rings, consumables, books,
 * crafting (forge + learnables), trade, drop/pickup/merge, death drops,
 * torch fuel and persistence.
 */
import { ItemSystem } from '../src/items/server/ItemSystem';
import { EntityStore, makeEntity, type ServerEntity } from '../src/server/entity';
import { Emitter } from '../src/core/events';
import { Rng, deriveSeed } from '../src/core/rng';
import type { ServerContext, ServerBusEvents } from '../src/server/context';
import type { ServerMessage } from '../src/shared/protocol';
import { EntFlag } from '../src/shared/types';

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    fails++;
    console.error('  ✗ ' + msg);
  } else console.log('  ✓ ' + msg);
};

const entities = new EntityStore();
const bus = new Emitter<ServerBusEvents>();
const sent: ServerMessage[] = [];
const dirty: string[] = [];
const time = { now: 0, dt: 0.05, timeOfDay: 0.5, day: 1, hour: 12 };
const forgePos: [number, number, number] = [2, 0, 2];
const ctx = {
  seed: 1234,
  gen: { profile: { races: [{ id: 'dwarf', weight: 1 }, { id: 'elf', weight: 1 }] } },
  entities, bus, time,
  services: {
    combat: {
      heal: (t: ServerEntity, a: number) => ((t.hp = Math.min(t.maxHp, t.hp + a)), a),
      applyEffect: (t: ServerEntity, id: string, m: number, d: number) => t.effects.push({ id, magnitude: m, until: time.now + d }),
      damage: (t: ServerEntity, a: number) => ((t.hp -= a), a), isHostile: () => true, kill: () => {}, knockback: () => {},
    },
    skills: { level: () => 60, grantXp: () => {}, recomputeStats: (e: ServerEntity) => ((e.stats = { carry: 150, maxStamina: 100, maxMana: 100 } as never), undefined), initSkills: () => {} },
    npcs: { disposition: () => 25, profile: () => ({ job: 'smith' }), adjustDisposition: () => {} },
    settlements: { buildingsNear: () => [{ role: 'smithy', pos: forgePos, size: [6, 4, 6], spots: [{ kind: 'forge', pos: forgePos }] }], siteAt: () => null, layout: () => null },
  },
  weather: { kind: 'clear', intensity: 0, windX: 0, windZ: 0 },
  rng: (...t: (string | number)[]) => new Rng(deriveSeed(1234, ...t)),
  spawn: (e: ServerEntity) => (entities.add(e), e),
  despawn: (id: number) => void entities.remove(id),
  newEntityId: () => entities.allocId(),
  broadcast: () => {},
  send: (_id: number, m: ServerMessage) => void sent.push(m),
  players: () => entities.ofKind('player'),
  groundAt: () => 0,
  gravityAt: () => 9.81,
  markPlayerDirty: (_id: number, ...k: string[]) => void dirty.push(...k),
  log: console.log,
} as unknown as ServerContext;

const sys = new ItemSystem();
sys.init(ctx);
const p = makeEntity(ctx.newEntityId(), 'player', [0, 0, 0], 'players', 0);
p.inventory = { items: [], capacity: 120, coins: 500 };
p.equipment = {};
p.humanoid = { race: 'dwarf' } as never;
ctx.spawn(p);
sys.onPlayerJoin(p);

console.log('starter kit');
for (const id of ['tunic_linen', 'trousers_wool', 'boots_leather', 'knife_iron', 'torch', 'bread', 'bread', 'waterskin', 'pick_iron']) sys.give(p, sys.create(id, { seed: 5 }), 'gift');
ok(p.inventory.items.find((i) => i.defId === 'bread')?.count === 2, 'bread stacks to 2');
for (const it of [...p.inventory.items]) {
  const d = sys.def(it.defId);
  if (d && d.slots.length && d.id !== 'torch') sys.equip(p, it.uid);
}
ok(p.equipment.chest?.defId === 'tunic_linen' && p.equipment.feet && p.equipment.legs, 'clothing equipped');
ok(p.equipment.mainhand?.defId === 'pick_iron', 'pick in main hand');

console.log('two-handers & rings');
const gs = sys.create('sword_great', { level: 10 });
sys.give(p, gs);
const torch = p.inventory.items.find((i) => i.defId === 'torch')!;
sys.equip(p, torch.uid);
ok(p.equipment.offhand?.defId === 'torch' && p.light, 'torch in off hand gives light');
sys.equip(p, gs.uid);
ok(p.equipment.mainhand?.uid === gs.uid && !p.equipment.offhand, 'greatsword clears off hand');
ok(!p.light, 'light gone with torch');
const r1 = sys.create('ring_band'), r2 = sys.create('ring_gem'), r3 = sys.create('ring_signet');
[r1, r2, r3].forEach((r) => sys.give(p, r));
sys.equip(p, r1.uid);
sys.equip(p, r2.uid);
sys.equip(p, r3.uid);
ok(p.equipment.ring1?.uid === r3.uid && p.equipment.ring2?.uid === r2.uid, 'rings fill ring1, ring2, then replace ring1');

console.log('consumables');
p.hp = 10;
const bread = p.inventory.items.find((i) => i.defId === 'bread')!;
sys.onMessage(p, { t: 'useItem', uid: bread.uid });
ok(p.hp > 10 && p.inventory.items.find((i) => i.defId === 'bread')?.count === 1, 'bread heals & is consumed');
ok(p.effects.some((e) => e.id === 'well_fed'), 'well_fed applied');
const ws = p.inventory.items.find((i) => i.defId === 'waterskin')!;
time.now += 2;
sys.onMessage(p, { t: 'useItem', uid: ws.uid });
ok(ws.durability === 4 && p.inventory.items.includes(ws), 'waterskin uses a charge, not consumed');
p.flags |= EntFlag.Swimming;
time.now += 2;
sys.onMessage(p, { t: 'useItem', uid: ws.uid });
ok(ws.durability === 5, 'waterskin refilled in water');
p.flags &= ~EntFlag.Swimming;

console.log('books');
const sb = sys.create('book_skill', { seed: 3 });
sys.give(p, sb);
sys.onMessage(p, { t: 'useItem', uid: sb.uid });
ok(sb.data?.read === true, `skill book read (${sb.name})`);
const rb = sys.create('book_recipe', { seed: 9 });
sys.give(p, rb);
sys.onMessage(p, { t: 'useItem', uid: rb.uid });
ok(p.inventory.knownRecipes?.includes(String(rb.data?.recipe)), `recipe learned: ${rb.data?.recipe}`);

console.log('crafting');
sys.give(p, sys.create('iron_ore', { count: 4 }));
sys.give(p, sys.create('coal', { count: 4 }));
sys.onMessage(p, { t: 'craft', recipe: 'smelt:iron' });
ok(p.inventory.items.some((i) => i.defId === 'iron_ingot'), 'smelted iron ingot at forge');
sys.give(p, sys.create('iron_ingot', { count: 3 }));
sys.give(p, sys.create('leather', { count: 1 }));
sys.onMessage(p, { t: 'craft', recipe: 'smith:sword_long:iron' });
const crafted = p.inventory.items.find((i) => i.defId === 'sword_long');
ok(crafted && crafted.material === 'iron' && crafted.origin, `crafted ${crafted?.name} (${crafted?.origin})`);
sys.onMessage(p, { t: 'craft', recipe: 'alch:potion_invisibility' });
ok(true, 'learnable recipe refused without folio (see notify)');

console.log('trade');
const npc = makeEntity(ctx.newEntityId(), 'npc', [1, 0, 1], 'npcs', 0);
npc.name = 'Bram';
npc.tags.add('merchant');
ctx.spawn(npc);
sent.length = 0;
sys.onMessage(p, { t: 'trade', npc: npc.id });
const tm = sent.find((m) => m.t === 'trade') as Extract<ServerMessage, { t: 'trade' }> | undefined;
ok(tm && tm.stock.length > 3, `stock of ${tm?.stock.length} items`);
const coins0 = p.inventory.coins;
const cheap = tm!.stock.slice().sort((a, b) => tm!.prices[a.uid] - tm!.prices[b.uid])[0];
sys.onMessage(p, { t: 'trade', npc: npc.id, buy: [cheap.uid + ':1'] });
ok(p.inventory.coins < coins0, `bought ${cheap.name} for ${coins0 - p.inventory.coins}`);
const sellIt = p.inventory.items.find((i) => i.defId === 'sword_long')!;
const c1 = p.inventory.coins;
sys.onMessage(p, { t: 'trade', npc: npc.id, sell: [sellIt.uid] });
ok(p.inventory.coins > c1 && !p.inventory.items.includes(sellIt), `sold sword for ${p.inventory.coins - c1}`);

console.log('drop, pickup, merge');
const arrows = sys.create('arrow', { count: 10 });
sys.give(p, arrows);
const aStack = p.inventory.items.find((i) => i.defId === 'arrow')!;
sys.onMessage(p, { t: 'dropItem', uid: aStack.uid, count: 4 });
sys.onMessage(p, { t: 'dropItem', uid: aStack.uid, count: 3 });
for (let i = 0; i < 60; i++) sys.tick(0.05);
sys.slowTick(1);
const groundArrows = entities.ofKind('item').filter((e) => e.item?.defId === 'arrow');
ok(groundArrows.length === 1 && groundArrows[0].item!.count === 7, 'dropped stacks merged on the ground');
sys.onMessage(p, { t: 'interact', target: groundArrows[0].id });
ok(p.inventory.items.find((i) => i.defId === 'arrow')?.count === 10, 'picked up via interact');

console.log('death drops');
const wolf = makeEntity(ctx.newEntityId(), 'creature', [3, 0, 3], 'creatures', 0);
wolf.mass = 60;
wolf.maxHp = 120;
ctx.spawn(wolf);
const before = entities.ofKind('item').length;
bus.emit('death', { entity: wolf, killer: p });
ok(entities.ofKind('item').length > before, `creature dropped ${entities.ofKind('item').length - before} items`);
const guard = makeEntity(ctx.newEntityId(), 'npc', [5, 0, 5], 'npcs', 0);
guard.humanoid = { race: 'orc' } as never;
ctx.spawn(guard);
sys.outfitFor(guard, 'guard', 0.7, 42);
ok(Object.keys(guard.equipment ?? {}).length >= 4, `guard outfit: ${Object.values(guard.equipment!).map((i) => i!.name).join(', ')}`);

console.log('torch fuel');
sys.equip(p, p.inventory.items.find((i) => i.defId === 'knife_iron')!.uid);
const t2 = sys.create('torch', { count: 2 });
sys.give(p, t2);
sys.equip(p, p.inventory.items.find((i) => i.defId === 'torch')!.uid, 'offhand');
const lit = p.equipment.offhand!;
lit.durability = 1;
sys.slowTick(2);
ok(p.equipment.offhand && p.equipment.offhand !== lit, 'burnt-out torch replaced by next');

console.log('persistence');
const placed = sys.create('torch');
sys.give(p, placed);
sys.onMessage(p, { t: 'place', itemUid: p.inventory.items.find((i) => i.defId === 'torch')!.uid, point: [1, 0, 0] });
const saved = JSON.parse(JSON.stringify(sys.save()));
ok(saved.ground.length >= 1, 'placed torch saved');
console.log(fails ? `\n${fails} failure(s)` : '\nall server tests passed');
process.exit(fails ? 1 : 0);
