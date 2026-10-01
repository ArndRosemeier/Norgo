/**
 * NPC scenario checks (headless): quest hand-off & completion, assault and
 * murder reactions, GM wanderer kinds, bandit camps, building destruction and
 * off-screen catch-up. Prints PASS/FAIL per scenario.
 *
 *   npx tsx tools/npc-scenarios.ts [seed]
 */
import { GameServer } from '../src/server/GameServer';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { randomAppearance } from '../src/humanoid/appearance';
import type { NpcSystem } from '../src/npc/server/NpcSystem';
import type { ServerEntity } from '../src/server/entity';

const seed = Number(process.argv[2] ?? 4242);
const server = new GameServer(seed);
const npcs = server.services.npcs as unknown as NpcSystem;
const handle = server.connect(() => {});
handle({ t: 'hello', version: PROTOCOL_VERSION, name: 'Hero', appearance: randomAppearance('human', 3) });
const player = server.players()[0];
const site = server.gen.siteAt(player.pos[0], player.pos[2]) ?? server.gen.sites.sitesNear(player.pos[0], player.pos[2], 800)[0];
const tp = (x: number, z: number) => {
  handle({ t: 'debug', cmd: 'tp', args: [x, NaN, z] });
  for (let i = 0; i < 25; i++) server.tick();
};
const ticks = (n: number) => {
  for (let i = 0; i < n; i++) server.tick();
};
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const liveNpcs = () => [...server.entities.all.values()].filter((e) => e.kind === 'npc' && e.alive && npcs.isNpc(e.id));

tp(site.x + 4, site.z + 4);
console.log(`site ${site.name} (${site.size}), live NPCs ${npcs.liveCount()}`);

// 1. Quest hand-off: give everyone time to form goals, then accept & complete one.
for (let h = 0; h < 40 && !liveNpcs().some((e) => npcs.questOffer(e.id, player)); h++) {
  server.time.day += 0; // goals form over in-game hours
  ticks(400);
}
const giver = liveNpcs().find((e) => npcs.questOffer(e.id, player));
if (giver) {
  const offer = npcs.questOffer(giver.id, player)!;
  const before = npcs.disposition(giver.id, player.id);
  const qid = npcs.acceptQuest(giver.id, player, offer.goalId, 1.2);
  server.bus.emit('questEvent', { player, quest: qid!, event: 'completed' });
  const info = npcs.npcInfo(giver.id)!;
  const g = info.st.goals.find((x) => x.id === offer.goalId)!;
  check('quest accepted & completed resolves the goal', !!qid && g.status !== 'waiting', `"${offer.spec.title}" → goal ${g.status}`);
  check('helping raises disposition', npcs.disposition(giver.id, player.id) > before, `${before} → ${npcs.disposition(giver.id, player.id)}`);
} else check('an NPC offers a quest within 40 game hours', false);

// 2. Assault: witnesses remember, guards respond.
const victim = liveNpcs().find((e) => !e.tags.has('guard') && !e.tags.has('child'));
if (victim) {
  tp(victim.pos[0] + 1.5, victim.pos[2]);
  server.services.combat.damage(victim, 4, 'blunt', player);
  ticks(10);
  const mem = npcs.npcInfo(victim.id)!.st.mem.filter((m) => m.kind === 'crime');
  const guards = liveNpcs().filter((e) => e.tags.has('guard') && e.target === player.id);
  check('assault is remembered by the victim', mem.length > 0, mem[0]?.text);
  check('victim disposition drops', npcs.disposition(victim.id, player.id) < 0, String(npcs.disposition(victim.id, player.id)));
  console.log(`      guards engaging: ${guards.length}`);
  // 3. Murder: family & friends grieve and hate the killer.
  const rec = npcs.npcInfo(victim.id)!.rec;
  server.services.combat.kill(victim, player);
  ticks(5);
  const dbg = npcs.debugSite(site.id)!;
  const mourners = dbg.people.filter((p) => p.st.mem.some((m) => m.kind === 'death' && m.text.startsWith(rec.given)));
  check('death spreads to relatives/neighbours', mourners.length > 0, `${mourners.length} remember ${rec.given}'s death`);
  check('dead NPC stays dead in the mind store', dbg.people.find((p) => p.rec.id === rec.id)?.st.alive === false);
}

// 4. GM wanderer kinds with matching tags.
for (const kind of ['bandit', 'merchant', 'pilgrim', 'adventurer', 'bounty_hunter', 'angry_owner', 'messenger']) {
  const e = npcs.spawnWanderer(kind, [player.pos[0] + 10, player.pos[1], player.pos[2] + 10], 77);
  check(`spawnWanderer('${kind}')`, !!e && e.tags.has(kind), e ? `${e.name}, ${e.title}, faction ${e.faction}` : 'null');
}
ticks(100);

// 5. Bandit camp: spawn on approach, clear by killing everyone.
const camp = server.gen.sites.poisNear(site.x, site.z, 3500).find((p) => p.kind === 'camp');
if (camp) {
  tp(camp.x + 30, camp.z);
  ticks(40);
  const bandits = liveNpcs().filter((e) => e.tags.has('bandit') && Math.hypot(e.pos[0] - camp.x, e.pos[2] - camp.z) < 60);
  check('bandit camp populates on approach', bandits.length > 0, `${bandits.length} bandits`);
  for (const b of bandits) server.services.combat.kill(b, player);
  ticks(5);
  check('killing all bandits clears the camp', npcs.campStrength(camp.id) === 0);
} else console.log('SKIP  no bandit camp within 3.5 km');

// 6. Destruction: owners & builders want to rebuild.
tp(site.x + 4, site.z + 4);
const lay = npcs.layout(site.id)!;
const b = lay.buildings.find((x) => x.residents > 0)!;
server.bus.emit('objectDestroyed', { id: `B:${site.id}:${b.id}:0`, source: player, kind: 'wall', pos: b.pos });
const flagged = npcs.debugSite(site.id)!.people.filter((p) => Object.keys(p.st.flags).some((k) => k.startsWith('ruined:')) || p.st.goals.some((g) => g.kind === 'rebuild'));
check('destroyed building gives owners a rebuild agenda', flagged.length > 0, `${flagged.length} NPCs`);

// 7. Off-screen life: leave, let two days pass, come back.
const doneBefore = npcs.debugSite(site.id)!.people.reduce((s, p) => s + p.st.goalsDone + p.st.goalsFailed, 0);
tp(site.x + 3000, site.z + 3000);
ticks(60);
check('site deactivates when the player leaves', npcs.debugSite(site.id)!.people.every((p) => p.pos === null));
server.time.day += 2;
ticks(40);
tp(site.x + 4, site.z + 4);
const doneAfter = npcs.debugSite(site.id)!.people.reduce((s, p) => s + p.st.goalsDone + p.st.goalsFailed, 0);
check('goals progress off-screen', doneAfter > doneBefore, `${doneBefore} → ${doneAfter} finished goals`);

// 8. Save/load keeps deaths & camps.
const s2 = new GameServer(seed);
s2.load(JSON.parse(JSON.stringify(server.save())));
const n2 = s2.services.npcs as unknown as NpcSystem;
check('save/load keeps the dead dead', n2.debugSite(site.id)!.people.filter((p) => !p.st.alive).length === npcs.debugSite(site.id)!.people.filter((p) => !p.st.alive).length);
if (camp) check('save/load keeps the camp cleared', n2.campStrength(camp.id) === 0);

console.log(failures ? `\n${failures} FAILED` : '\nall scenarios passed');
void (null as unknown as ServerEntity);
process.exit(failures ? 1 : 0);
