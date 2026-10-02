/**
 * Gameplay self-test (Node): `npx tsx tools/gameplay-selftest.ts [seed]`
 *
 * Runs the real GameplaySystem inside GameplayHarness (real world generator,
 * terrain, entity store; stand-in services) and:
 *  1. validates the skill/ability/effect catalog,
 *  2. levels a test character in every skill (unlocking everything),
 *  3. casts every active ability against dummies on pristine terrain,
 *  4. exercises melee, parry/block, bows & ammo, digging, falls, deaths,
 *  5. checks the AI API, skill checks, item-effect ids and gear conventions,
 *     and press/release charging.
 * Exits non-zero on any failure.
 */
import { WorldGenerator } from '../src/world/generator';
import type { GameEvent } from '../src/shared/protocol';
import type { Vec3 } from '../src/shared/types';
import { makeEntity } from '../src/server/entity';
import { GameplayHarness, harnessItem } from '../src/gameplay/server/testHarness';
import { ABILITIES, SKILLS, validateCatalog } from '../src/gameplay/data/catalog';
import { useAbility, chooseAbility, checkSkill, tryPickLock, effectiveGravity } from '../src/gameplay/server/api';

const seed = Number(process.argv[2] ?? 1234);
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log('  ✗ ' + msg);
};
const ok = (msg: string) => console.log('  ✓ ' + msg);

const h = new GameplayHarness(new WorldGenerator(seed));
const gameplay = h.gameplay;
const events: GameEvent[] = [];
const personal: GameEvent[] = [];
h.onBroadcast = (ev) => events.push(ev);
h.onSend = (_id, m) => {
  if (m.t === 'events') personal.push(...m.events);
};

const spawn = h.flatSpot();
console.log(`Norgo gameplay selftest — seed ${seed}, arena ${spawn.map((v) => v.toFixed(0)).join(',')}`);

// ------------------------------------------------------------------ 1. catalog
console.log('1. catalog');
const problems = validateCatalog();
for (const p of problems) fail(p);
const actives = ABILITIES.filter((a) => a.targeting !== 'passive');
ok(`${SKILLS.length} skills, ${ABILITIES.length} abilities (${actives.length} active, ${ABILITIES.length - actives.length} passive), ${problems.length} problems`);
const required = ['blades', 'axes', 'blunt', 'polearms', 'archery', 'throwing', 'unarmed', 'shields', 'heavy_armor', 'light_armor', 'acrobatics', 'athletics', 'pyromancy', 'cryomancy', 'geomancy', 'gravitas', 'vitae', 'luminism', 'umbramancy', 'kinesis', 'animism', 'runecraft', 'climbing', 'swimming', 'stealth', 'lockpicking', 'mining', 'woodcutting', 'herbalism', 'foraging', 'cooking', 'smithing', 'alchemy', 'tailoring', 'enchanting', 'persuasion', 'intimidation', 'barter', 'tracking', 'survival', 'lore'];
for (const id of required) if (!SKILLS.find((s) => s.id === id)) fail('missing required skill ' + id);
const fresh = h.addPlayer(spawn, 0);
ok(`new character starts with ${fresh.skills!.abilities.length} abilities: ${fresh.skills!.abilities.join(', ')}`);
h.despawn(fresh.id);

// ------------------------------------------------------------------ 2. progression
console.log('2. progression');
const player = h.addPlayer(spawn, 80);
if (player.skills!.abilities.length !== ABILITIES.length) fail(`unlocked ${player.skills!.abilities.length}/${ABILITIES.length} at level 80`);
else ok(`all ${ABILITIES.length} abilities unlocked; hotbar ${player.skills!.hotbar.filter(Boolean).length}/10 filled`);
for (const [k, v] of Object.entries(player.stats!)) if (typeof v === 'number' && !Number.isFinite(v)) fail(`stat ${k} = ${v}`);
const st = player.stats!;
ok(`stats: hp ${st.maxHp} st ${st.maxStamina} mana ${st.maxMana} armor ${st.armor.toFixed(1)} move ${st.moveSpeed.toFixed(2)} dodge ${(st.dodge ?? 0).toFixed(2)} block ${(st.block ?? 0).toFixed(2)}`);
if (!personal.some((e) => e.type === 'unlock')) fail('no unlock events were sent');

// ------------------------------------------------------------------ 3. every ability
console.log('3. abilities');
const results: string[] = [];
const dummies: ReturnType<typeof h.addDummy>[] = [];
const clearArena = () => {
  for (const d of dummies.splice(0)) h.despawn(d.id);
  for (const e of [...h.entities.all.values()]) if (e.kind === 'effect' || e.kind === 'projectile' || e.kind === 'item' || e.tags.has('summon')) h.despawn(e.id);
};
for (const a of actives) {
  clearArena();
  h.resetTerrain();
  h.trees.length = 0;
  h.trees.push({ id: 1, kind: 'tree_oak', pos: [spawn[0] + 2.5, spawn[1], spawn[2] - 0.2], radius: 0.4, hp: 300 });
  const close = a.range > 0 && a.range <= 4.5;
  const npcOnly = a.requires?.target === 'npc';
  const target = h.addDummy(spawn[0], spawn[2] + (close ? -1.8 : -6), spawn[1], npcOnly ? 'villager' : 'hostile', npcOnly ? 'npc' : 'creature');
  dummies.push(target, h.addDummy(spawn[0] + (close ? 1.2 : 2), spawn[2] + (close ? -1.4 : -5), spawn[1]), h.addDummy(spawn[0] - 3, spawn[2] + 3, spawn[1]));
  h.playerData.get(player.id)!.cooldowns = {};
  player.alive = true;
  player.hp = player.maxHp;
  player.mana = player.stats!.maxMana;
  player.stamina = player.stats!.maxStamina;
  player.effects = [];
  player.skills!.toggles = [];
  h.place(player, spawn[0], spawn[2], spawn[1]);
  player.yaw = 0;
  const archery = a.requires?.weaponSkill?.includes('archery');
  const polearm = a.requires?.weaponSkill?.includes('polearms');
  player.equipment!.mainhand = harnessItem(archery ? 'bow_hunting' : polearm ? 'spear_iron' : 'sword_iron');
  gameplay.recomputeStats(player);
  const hp0 = target.hp, ev0 = events.length, ed0 = h.editCount;
  personal.length = 0;
  const eye: Vec3 = [player.pos[0], player.pos[1] + 1.5, player.pos[2]];
  const tp: Vec3 = [target.pos[0], target.pos[1] + 1, target.pos[2]];
  const l = Math.hypot(tp[0] - eye[0], tp[1] - eye[1], tp[2] - eye[2]);
  let reason = '';
  let good = false;
  try {
    const r = gameplay.abilities.use(player, { ability: a.id, target: target.id, point: tp, dir: [(tp[0] - eye[0]) / l, (tp[1] - eye[1]) / l, (tp[2] - eye[2]) / l], charge: 1 }, true);
    good = r.ok;
    if (!r.ok) reason = r.reason;
    h.tick(a.castTime + 1.6);
  } catch (err) {
    reason = 'EXCEPTION ' + (err as Error).stack;
  }
  const evs = [...new Set(events.slice(ev0).map((e) => (e.type === 'fx' ? 'fx:' + e.fx : e.type)))].slice(0, 6).join(',');
  const note = personal.find((e) => e.type === 'notify') as { text: string } | undefined;
  const line = `${a.id.padEnd(20)} ${good ? 'ok ' : 'NO '} dmg ${(hp0 - target.hp).toFixed(1).padStart(6)} edits ${h.editCount - ed0} ev ${evs}${note ? ' | ' + note.text : ''}${good ? '' : ' | ' + reason}`;
  results.push(line);
  if (!good) fail(line);
}
for (const l of results) console.log('    ' + l);
ok(`worst gameplay tick: ${h.worstTickMs.toFixed(2)} ms`);

// ------------------------------------------------------------------ 4. combat & terrain
console.log('4. combat & terrain');
clearArena();
h.resetTerrain();
player.equipment!.mainhand = harnessItem('sword_iron');
player.effects = [];
gameplay.recomputeStats(player);
const foe = h.addDummy(spawn[0], spawn[2] - 1.6, spawn[1]);
dummies.push(foe);
const rt = gameplay.runtime(player);
rt.nextAttackAt = 0;
let b = foe.hp;
gameplay.onMessage(player, { t: 'attack', dir: [0, 0, -1], target: foe.id });
h.tick(1);
if (foe.hp < b) ok(`melee hit for ${(b - foe.hp).toFixed(1)}`);
else fail('melee attack did not hit a dummy 1.6 m ahead');
// Tab targeting (lock): the server aims at a validated target, ignores invalid ones.
{
  const [px, py, pz] = player.pos;
  const side = h.addDummy(px + 1.5, pz, py);
  dummies.push(side);
  player.anim = { ...player.anim, lookAt: [px, py + 1.6, pz - 20] };
  rt.nextAttackAt = 0;
  let sb = side.hp;
  gameplay.onMessage(player, { t: 'attack', dir: [0, 0, -1], target: side.id });
  h.tick(1);
  if (side.hp === sb) ok('unlocked swing ahead leaves a dummy at the side untouched');
  else fail('unlocked swing hit a dummy 90° to the side');
  rt.nextAttackAt = 0;
  player.stamina = player.stats!.maxStamina;
  sb = side.hp;
  gameplay.onMessage(player, { t: 'attack', dir: [0, 0, -1], target: side.id, lock: true });
  h.tick(1);
  if (side.hp < sb) ok(`locked swing turns to the tab target at the side (${(sb - side.hp).toFixed(1)})`);
  else fail('locked swing did not hit the tab target beside the player');
  const far = h.addDummy(px + 70, pz, py);
  dummies.push(far);
  if (gameplay.melee.lockedTarget(player, far.id, 999) === undefined) ok('lock on a target 70 m away is rejected');
  else fail('server accepted a lock beyond the lock range');
  if (gameplay.melee.lockedTarget(player, player.id, 999) === undefined) ok('lock on yourself is rejected');
  else fail('server accepted a self lock');
  const mainhand = player.equipment!.mainhand;
  player.equipment!.mainhand = harnessItem('bow_hunting');
  const diag = h.addDummy(px + 9, pz - 9, py);
  dummies.push(diag);
  rt.nextAttackAt = 0;
  player.stamina = player.stats!.maxStamina;
  sb = diag.hp;
  gameplay.onMessage(player, { t: 'attack', dir: [0, 0.05, -1], target: diag.id, lock: true });
  h.tick(2);
  if (diag.hp < sb) ok(`locked arrow flies to a tab target 45° off the aim (${(sb - diag.hp).toFixed(1)})`);
  else fail('locked arrow missed the tab target');
  player.equipment!.mainhand = mainhand;
  h.playerData.get(player.id)!.cooldowns = {};
  player.mana = player.stats!.maxMana;
  sb = diag.hp;
  const fr = gameplay.onMessage(player, { t: 'ability', use: { ability: 'fireball', dir: [0, 0, -1], target: diag.id, lock: true } });
  h.tick(3);
  if (fr && diag.hp < sb) ok(`locked fireball hits the tab target (${(sb - diag.hp).toFixed(1)})`);
  else fail('locked fireball missed the tab target');
  // Checked ranged attacks: can't hit → message and nothing spent; can hit → certain hit.
  {
    const pd = h.playerData.get(player.id)!;
    pd.cooldowns = {};
    player.mana = player.stats!.maxMana;
    const farTarget = h.addDummy(px + 45, pz, py);
    dummies.push(farTarget);
    const mana0 = player.mana;
    gameplay.onMessage(player, { t: 'ability', use: { ability: 'ignite', dir: [1, 0, 0], target: farTarget.id, lock: true } });
    h.tick(0.5);
    if (player.mana === mana0 && !pd.cooldowns.ignite) ok('locked spell out of range: refused, nothing spent');
    else fail(`locked spell out of range was cast anyway (mana ${mana0} → ${player.mana})`);
    if (gameplay.melee.rangedBlocker(player, farTarget, 20) === 'Out of range.') ok('ranged check reports "Out of range."');
    else fail('ranged check did not report out of range');
    pd.cooldowns = {};
    player.mana = player.stats!.maxMana;
    sb = diag.hp;
    gameplay.onMessage(player, { t: 'ability', use: { ability: 'ignite', dir: [0, 0, -1], target: diag.id, lock: true } });
    h.tick(0.5);
    if (diag.hp < sb) ok(`locked beam (ignite) lands on the tab target (${(sb - diag.hp).toFixed(1)})`);
    else fail('locked beam missed the tab target');
  }
  for (const d of [side, far, diag]) h.despawn(d.id);
  player.hp = player.maxHp;
  player.stamina = player.stats!.maxStamina;
}
player.hp = player.maxHp;
player.stamina = player.stats!.maxStamina;
player.yaw = 0;
gameplay.onMessage(player, { t: 'block', on: true });
const hp0 = player.hp;
gameplay.damage(player, 20, 'slash', foe, { melee: true });
if (player.hp === hp0) ok('parry within the window negates damage');
else fail('parry failed');
h.tick(0.5);
gameplay.damage(player, 20, 'slash', foe, { melee: true });
if (player.hp < hp0 && hp0 - player.hp < 20) ok(`block reduced 20 → ${(hp0 - player.hp).toFixed(1)}`);
else if (player.hp === hp0) ok('blocked hit was dodged (dodge chance)');
else fail('block did not reduce damage');
gameplay.onMessage(player, { t: 'block', on: false });
player.equipment!.mainhand = harnessItem('bow_hunting');
rt.nextAttackAt = 0;
const arrows0 = player.inventory!.items.find((i) => i.defId === 'arrow')!.count;
b = foe.hp;
gameplay.onMessage(player, { t: 'attack', dir: [0, 0.05, -1] });
h.tick(1);
const arrows1 = player.inventory!.items.find((i) => i.defId === 'arrow')?.count ?? 0;
if (arrows1 === arrows0 - 1) ok('bow consumes one arrow');
else fail(`arrows ${arrows0} → ${arrows1}`);
if (foe.hp < b) ok(`arrow hit for ${(b - foe.hp).toFixed(1)}`);
else fail('arrow missed a dummy straight ahead');
player.equipment!.mainhand = harnessItem('pick_iron');
const gp: Vec3 = [player.pos[0] + 1.2, player.pos[1], player.pos[2]];
const gy = h.groundAt(gp[0], gp[1] + 2, gp[2], 6);
const e0 = h.editCount, inv0 = player.inventory!.items.length;
for (let i = 0; i < 6; i++) {
  rt.nextDigAt = 0;
  gameplay.onMessage(player, { t: 'dig', point: [gp[0], gy, gp[2]], normal: [0, 1, 0] });
}
if (h.editCount > e0) ok(`dig made ${h.editCount - e0} edits; inventory stacks ${inv0} → ${player.inventory!.items.length}`);
else fail('dig did not edit terrain');
const f0 = player.hp;
gameplay.damage(player, 30, 'fall');
ok(`fall 30 → took ${(f0 - player.hp).toFixed(1)} (fallResist ${(player.stats!.fallResist ?? 0).toFixed(2)})`);
const victim = h.addDummy(spawn[0] + 4, spawn[2] + 4, spawn[1]);
dummies.push(victim);
let died = false;
h.bus.on('death', ({ entity }) => {
  if (entity === victim) died = true;
});
gameplay.damage(victim, 1e6, 'fire', player);
if (died && !victim.alive) ok('kill emits death');
else fail('kill failed');

// ------------------------------------------------------------------ 5. API, checks, integrations
console.log('5. AI API, checks & integrations');
clearArena();
const mage = makeEntity(h.newEntityId(), 'npc', spawn, 'npcs', h.time.now);
mage.name = 'Hedge Mage';
mage.faction = 'bandit';
h.spawn(mage);
h.place(mage, spawn[0] + 6, spawn[2], spawn[1]);
gameplay.initSkills(mage);
gameplay.recomputeStats(mage);
const pick = chooseAbility(h, mage, ['meteor', 'fireball', 'frost_bolt'], player);
const used = pick ? useAbility(h, mage, pick, player) : { ok: false as const, reason: 'none' };
h.tick(3);
if (used.ok) ok(`AI mage chose and cast ${pick}`);
else fail('AI mage could not cast: ' + used.reason);
h.despawn(mage.id);
const chk = checkSkill(h, player, 'persuasion', 40, 12345);
ok(`persuasion check vs 40: ${chk.success ? 'pass' : 'fail'} (chance ${(chk.chance * 100).toFixed(0)}%, level ${chk.level})`);
ok(`pick lock 50: ${tryPickLock(h, player, 50, 'door:1') ? 'opened' : 'failed'}`);
ok(`gravity at player ${effectiveGravity(h, player.pos, player).toFixed(2)} m/s²`);
// Item-system effect ids (and their magnitude conventions).
player.effects = [];
gameplay.recomputeStats(player);
const baseFire = player.stats!.resist.fire ?? 0, baseFrost = player.stats!.resist.frost ?? 0;
for (const id of ['regen_hp', 'well_fed', 'resist_fire', 'water_breathing', 'night_vision', 'invisibility', 'strength', 'fortitude', 'clarity', 'luck', 'fortify_armor', 'reveal', 'courage', 'clumsy', 'poison', 'burning', 'light', 'haste', 'featherfall', 'levitate', 'waterwalk', 'swim_boost', 'leap_boost']) {
  gameplay.applyEffect(player, id, id === 'resist_fire' ? 40 : 1, 5);
}
const missing = ['regen', 'well_fed', 'resist_fire', 'water_breathing', 'darkvision', 'invisible', 'strength', 'fortitude', 'clarity', 'luck', 'fortify_armor', 'reveal', 'courage', 'clumsy', 'poison', 'light', 'haste', 'featherfall', 'levitate', 'waterwalk', 'swim_boost', 'leap_boost'].filter((id) => !player.effects.some((e) => e.id === id));
if (missing.length) fail('item effects not applied: ' + missing.join(', '));
if (Math.abs((player.stats!.resist.fire ?? 0) - Math.min(0.85, baseFire + 0.4)) > 0.01) fail('resist_fire 40 should add 40% fire resistance');
else ok(`item effects applied; resist_fire 40 → ${(player.stats!.resist.fire! * 100).toFixed(0)}% fire resistance`);
// Gear conventions: percent resists, flat elemental damage, ench procs, rolled weapon stats.
const flaming = harnessItem('sword_iron');
flaming.mods = { 'damage.fire': 12, 'resist.frost': 20 };
flaming.affixes = [{ id: 'vampiric', name: 'Vampiric', prefix: true, mods: {}, grants: 'ench.lifesteal' }];
flaming.weapon = { damage: 15, type: 'slash', speed: 1.2, reach: 2.2, skill: 'blades' };
player.equipment!.mainhand = flaming;
player.effects = [];
gameplay.recomputeStats(player);
if (player.stats!.flatDamage?.fire === 12 && Math.abs((player.stats!.resist.frost ?? 0) - Math.min(0.85, baseFrost + 0.2)) < 0.01) ok('gear: +12 fire per hit, +20% frost resistance');
else fail('gear mod conversion wrong: ' + JSON.stringify(player.stats!.flatDamage) + ' frost ' + player.stats!.resist.frost);
const foe2 = h.addDummy(spawn[0], spawn[2] - 1.6, spawn[1]);
dummies.push(foe2);
rt.nextAttackAt = 0;
player.hp = player.maxHp * 0.5;
const fb = foe2.hp, evF = events.length, hpBefore = player.hp;
gameplay.onMessage(player, { t: 'attack', dir: [0, 0, -1], target: foe2.id });
h.tick(1);
if (events.slice(evF).some((e) => e.type === 'damage' && e.dtype === 'fire') && foe2.hp < fb) ok(`flaming sword adds fire damage (${(fb - foe2.hp).toFixed(1)} total)`);
else fail('flat fire damage did not apply');
if (player.hp > hpBefore) ok('ench.lifesteal healed the wielder');
else fail('ench.lifesteal did not heal');
// Hold-to-charge through press/release (the core's input flow).
player.equipment!.mainhand = harnessItem('bow_hunting');
h.playerData.get(player.id)!.cooldowns = {};
player.stamina = player.stats!.maxStamina;
const evC = events.length;
gameplay.onMessage(player, { t: 'ability', use: { ability: 'aimed_shot', dir: [0, 0, -1] } });
h.tick(0.8);
if (events.slice(evC).some((e) => e.type === 'fx' && e.fx === 'launch')) fail('aimed shot fired on press');
gameplay.onMessage(player, { t: 'abilityRelease', ability: 'aimed_shot' });
if (events.slice(evC).some((e) => e.type === 'fx' && e.fx === 'launch')) ok('aimed shot charges on press and fires on release');
else fail('charged release did not fire');
// Race skill aliases.
const elf = makeEntity(h.newEntityId(), 'player', spawn, 'players', 0);
elf.humanoid = { race: 'umbral' } as never;
gameplay.initSkills(elf);
ok(`umbral starting levels: umbramancy ${elf.skills!.skills.umbramancy.level}, stealth ${elf.skills!.skills.stealth.level}, blades ${elf.skills!.skills.blades.level}`);

console.log(`\nentities ${h.entities.all.size}, terrain edits ${h.editCount}, events ${events.length}`);
console.log(failures ? `FAILED: ${failures} problem(s)` : 'ALL GOOD');
process.exit(failures ? 1 : 0);
