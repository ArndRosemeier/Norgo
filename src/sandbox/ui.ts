/**
 * UI sandbox: `/sandbox/ui.html` runs the in-game UI against a mock ClientContext
 * (real WorldGenerator, fake player/entities, a tiny mock server that answers
 * UI messages) over a simple three.js terrain patch. `?menu` shows the title
 * menu instead. A control strip (top-left) fires GameEvents / server messages.
 *
 * Controls: WASD move (no panel open) · drag on the world to orbit the camera.
 */
import * as THREE from 'three';
import { UI } from '../ui/UI';
import { showMainMenu } from '../ui/menu';
import { Emitter } from '../core/events';
import { parseSeed } from '../core/rng';
import { WorldGenerator } from '../world/generator';
import { SKILLS, ABILITIES } from '../gameplay/data/catalog';
import { RACES, randomAppearance } from '../humanoid/appearance';
import { itemSlots } from '../ui/data';
import { EntFlag } from '../shared/types';
import type { ClientContext, ClientEvents, EntityView } from '../client/context';
import type { ClientMessage, EntitySnapshot, PlayerState, GameEvent } from '../shared/protocol';
import type { ItemInstance, EquipSlot, Rarity } from '../items/types';
import type { SkillDef, AbilityDef } from '../gameplay/types';
import type { DialogView } from '../dialog/types';
import type { RaceId } from '../humanoid/types';
import type { Vec3 } from '../shared/types';

const params = new URLSearchParams(location.search);


// ------------------------------------------------------------------ mock catalog (only if the real one is still empty)

function mockCatalog() {
  if (!SKILLS.length) {
    const sk = (id: string, name: string, category: SkillDef['category'], description: string, unlocks: [number, string][], school?: string): SkillDef =>
      ({ id, name, category, school, description, icon: id, unlocks: unlocks.map(([level, ability]) => ({ level, ability })) });
    SKILLS.push(
      sk('blades', 'Blades', 'combat', 'Swords, sabres and knives. Trained by striking foes with edged weapons.', [[3, 'riposte'], [8, 'whirlwind'], [15, 'execute']]),
      sk('archery', 'Archery', 'combat', 'Bows and crossbows.', [[4, 'power_shot'], [10, 'volley']]),
      sk('block', 'Shieldcraft', 'combat', 'Blocking blows with shield or weapon.', [[5, 'shield_bash']]),
      sk('pyromancy', 'Pyromancy', 'magic', 'The school of flame: destruction and warmth.', [[1, 'firebolt'], [5, 'flame_wall'], [12, 'meteor']], 'fire'),
      sk('cryomancy', 'Cryomancy', 'magic', 'Ice and stillness.', [[1, 'frost_shard'], [7, 'glacial_ward']], 'frost'),
      sk('gravitism', 'Gravitism', 'magic', 'Bend the pull of the world itself.', [[2, 'levitate'], [9, 'gravity_well']], 'astral'),
      sk('restoration', 'Restoration', 'magic', 'Healing and protection.', [[1, 'mend'], [6, 'renewal']], 'life'),
      sk('athletics', 'Athletics', 'utility', 'Running, jumping and climbing.', [[4, 'dash'], [11, 'leap']]),
      sk('stealth', 'Stealth', 'utility', 'Moving unseen.', [[6, 'shadowstep']]),
      sk('smithing', 'Smithing', 'craft', 'Working metal at the forge.', []),
      sk('alchemy', 'Alchemy', 'craft', 'Brewing potions.', []),
      sk('speech', 'Speech', 'social', 'Persuasion, bartering and lies.', [[5, 'inspire']]),
      sk('foraging', 'Foraging', 'survival', 'Finding herbs and food.', []),
    );
  }
  if (!ABILITIES.length) {
    const ab = (id: string, name: string, skill: string, kind: AbilityDef['kind'], role: AbilityDef['role'], o: Partial<AbilityDef>): AbilityDef =>
      ({ id, name, skill, kind, role, targeting: 'aim', range: 20, cost: {}, cooldown: 4, castTime: 0, anim: 'cast_forward', description: '', icon: '', tags: [], ...o });
    ABILITIES.push(
      ab('firebolt', 'Firebolt', 'pyromancy', 'magic', 'combat', { cost: { mana: 12 }, cooldown: 2.5, damage: { amount: 22, type: 'fire' }, description: 'Hurl a bolt of fire that ignites what it strikes.', tags: ['projectile', 'fire'] }),
      ab('flame_wall', 'Wall of Flame', 'pyromancy', 'magic', 'combat', { targeting: 'ground', cost: { mana: 35 }, cooldown: 14, damage: { amount: 10, type: 'fire' }, description: 'Raise a line of fire.', tags: ['fire', 'area'] }),
      ab('meteor', 'Meteor', 'pyromancy', 'magic', 'combat', { targeting: 'ground', cost: { mana: 80 }, cooldown: 60, castTime: 2, damage: { amount: 120, type: 'fire' }, description: 'Call down a burning star.', tags: ['fire', 'terrain'] }),
      ab('frost_shard', 'Frost Shard', 'cryomancy', 'magic', 'combat', { cost: { mana: 10 }, cooldown: 2, damage: { amount: 16, type: 'frost' }, description: 'A piercing splinter of ice that slows.', tags: ['projectile', 'frost'] }),
      ab('glacial_ward', 'Glacial Ward', 'cryomancy', 'magic', 'defense', { targeting: 'self', cost: { mana: 30 }, cooldown: 30, description: 'Encase yourself in protective ice.', tags: ['ward'] }),
      ab('levitate', 'Levitate', 'gravitism', 'magic', 'movement', { targeting: 'self', cost: { mana: 20 }, cooldown: 12, toggle: true, description: 'Float above the ground.', tags: ['gravity'] }),
      ab('gravity_well', 'Gravity Well', 'gravitism', 'magic', 'combat', { targeting: 'ground', cost: { mana: 45 }, cooldown: 25, description: 'Crush foes under tenfold weight.', tags: ['gravity'] }),
      ab('mend', 'Mend', 'restoration', 'magic', 'utility', { targeting: 'self', cost: { mana: 15 }, cooldown: 6, castTime: 1, description: 'Knit wounds closed.', tags: ['heal'] }),
      ab('renewal', 'Renewal', 'restoration', 'magic', 'utility', { targeting: 'self', cost: { mana: 40 }, cooldown: 40, description: 'Heal over time.', tags: ['heal'] }),
      ab('riposte', 'Riposte', 'blades', 'physical', 'combat', { targeting: 'entity', range: 3, cost: { stamina: 15 }, cooldown: 5, damage: { amount: 18, type: 'slash' }, description: 'Counter-strike after a block.', tags: ['melee'] }),
      ab('whirlwind', 'Whirlwind', 'blades', 'physical', 'combat', { targeting: 'aura', range: 3, cost: { stamina: 35 }, cooldown: 12, damage: { amount: 25, type: 'slash' }, description: 'Spin, striking all around.', tags: ['melee', 'area'] }),
      ab('execute', 'Execute', 'blades', 'physical', 'combat', { targeting: 'entity', range: 3, cost: { stamina: 40 }, cooldown: 20, description: 'Finish a wounded foe.', tags: ['melee'] }),
      ab('power_shot', 'Power Shot', 'archery', 'physical', 'combat', { cost: { stamina: 20 }, cooldown: 6, damage: { amount: 35, type: 'pierce' }, description: 'A fully drawn shot.', tags: ['projectile'] }),
      ab('volley', 'Volley', 'archery', 'physical', 'combat', { targeting: 'ground', cost: { stamina: 40 }, cooldown: 18, description: 'Rain arrows on an area.', tags: ['area'] }),
      ab('shield_bash', 'Shield Bash', 'block', 'physical', 'combat', { targeting: 'entity', range: 2.5, cost: { stamina: 20 }, cooldown: 8, damage: { amount: 8, type: 'blunt' }, description: 'Stagger a foe.', tags: ['stun'] }),
      ab('dash', 'Dash', 'athletics', 'physical', 'movement', { targeting: 'self', cost: { stamina: 25 }, cooldown: 5, description: 'Burst forward.', tags: ['movement'] }),
      ab('leap', 'Great Leap', 'athletics', 'physical', 'movement', { targeting: 'self', cost: { stamina: 30 }, cooldown: 10, description: 'Jump thrice as high.', tags: ['movement'] }),
      ab('shadowstep', 'Shadowstep', 'stealth', 'magic', 'movement', { targeting: 'aim', cost: { mana: 25 }, cooldown: 15, description: 'Step through the shadows.', tags: ['teleport', 'shadow'] }),
      ab('inspire', 'Inspire', 'speech', 'physical', 'social', { targeting: 'aura', cost: { stamina: 10 }, cooldown: 60, description: 'Rally nearby allies.', tags: ['social'] }),
    );
  }
  if (!Object.keys(RACES).length) {
    const r = RACES as Record<RaceId, (typeof RACES)[RaceId]>;
    const mk = (id: RaceId, name: string, plural: string, description: string, lifespan: number, skillBonus: Record<string, number>, statMods: Record<string, number>) => (r[id] = { id, name, plural, description, lifespan, skillBonus, statMods });
    mk('human', 'Human', 'Humans', 'Adaptable and ambitious, humans thrive anywhere and learn any craft.', 80, { speech: 5, blades: 3 }, { maxStamina: 10 });
    mk('elf', 'Elf', 'Elves', 'Long-lived wardens of old forests, keen-eyed and attuned to magic.', 400, { archery: 6, cryomancy: 3 }, { maxMana: 20, perception: 5 });
    mk('dwarf', 'Dwarf', 'Dwarves', 'Stout delvers and smiths who read stone like scripture.', 250, { smithing: 8, block: 3 }, { maxHp: 15, 'resist.poison': 0.15 });
    mk('orc', 'Orc', 'Orcs', 'Proud clans who prize strength earned and debts repaid.', 60, { blades: 6, athletics: 3 }, { maxHp: 20 });
    mk('halfling', 'Halfling', 'Halflings', 'Small, nimble and impossibly lucky.', 120, { stealth: 7, foraging: 3 }, { stealth: 10 });
    mk('goblin', 'Goblin', 'Goblins', 'Quick-witted scavengers and tinkerers.', 45, { alchemy: 5, stealth: 4 }, { moveSpeed: 0.05 });
    mk('sylvan', 'Sylvan', 'Sylvans', 'Bark-skinned children of grove and fungus.', 300, { restoration: 6, foraging: 5 }, { hpRegen: 0.5 });
    mk('drakeborn', 'Drakeborn', 'Drakeborn', 'Scaled heirs of dragons with fire in the blood.', 150, { pyromancy: 8 }, { 'resist.fire': 0.25 });
    mk('umbral', 'Umbral', 'Umbrals', 'Pale wanderers of twilight, attuned to shadow and silence.', 200, { stealth: 5, gravitism: 4 }, { 'resist.shadow': 0.2 });
    mk('giantkin', 'Giantkin', 'Giantkin', 'Towering mountain folk, slow to anger and impossible to move.', 180, { block: 5, athletics: 3 }, { maxHp: 30, carry: 50 });
  }
}

// ------------------------------------------------------------------ mock items

let uidN = 1;
function item(defId: string, name: string, rarity: Rarity, shape: string, o: Partial<ItemInstance> = {}): ItemInstance {
  const c = { common: [0.7, 0.68, 0.62], uncommon: [0.4, 0.7, 0.35], rare: [0.3, 0.5, 0.9], epic: [0.6, 0.35, 0.85], legendary: [0.95, 0.6, 0.2], unique: [0.9, 0.8, 0.4] }[rarity] as [number, number, number];
  return {
    uid: `u${uidN++}`, defId, count: 1, name, rarity, quality: 0.6, material: 'iron', affixes: [], mods: {}, durability: 80, maxDurability: 100,
    visual: { shape, seed: uidN, primary: c, secondary: [0.3, 0.25, 0.2], accent: [0.9, 0.8, 0.4], material: 'metal', glow: 0, glowColor: [1, 0.6, 0.2], wear: 0.2, style: 'human' },
    value: 25, ...o,
  };
}

function mockPlayer(spawn: Vec3): PlayerState {
  const sword = item('sword.long', 'Emberwrought Longsword', 'epic', 'sword.long', {
    material: 'steel', quality: 0.82, value: 640, mods: { damage: 31, 'resist.fire': 0.1, 'skill.pyromancy': 3 },
    affixes: [{ id: 'ember', name: 'Emberwrought', prefix: true, mods: { 'resist.fire': 0.1 } }, { id: 'fox', name: 'of the Ember Fox', prefix: false, mods: { 'skill.pyromancy': 3 }, grants: 'ench.flame_strike' }],
    lore: 'Forged in the ash-vents of Khazdum by a smith who swore she heard the blade sing.', origin: 'Taken from the ruin of Ixthar',
  });
  const helm = item('helm.nasal', 'Iron Nasal Helm', 'common', 'helm.nasal', { mods: { armor: 6 }, value: 40 });
  const inv: ItemInstance[] = [
    item('potion.health', 'Draught of Mending', 'uncommon', 'potion.round', { count: 4, value: 30, mods: {}, maxDurability: 0, lore: 'Smells of mint and copper.' }),
    item('potion.mana', 'Azure Tincture', 'uncommon', 'potion.tall', { count: 2, value: 35, maxDurability: 0 }),
    item('food.bread', 'Hearth Bread', 'common', 'food.bread', { count: 6, value: 3, maxDurability: 0 }),
    item('axe.bearded', 'Bearded Axe', 'rare', 'axe.bearded', { mods: { damage: 26, critDamage: 0.2 }, value: 210 }),
    item('bow.long', 'Yew Longbow of the Hawk', 'rare', 'bow.long', { mods: { damage: 24, perception: 4 }, value: 260, material: 'yew' }),
    item('chest.mail', 'Riveted Hauberk', 'uncommon', 'chest.mail', { mods: { armor: 22, moveSpeed: -0.03 }, value: 180 }),
    item('boots.tall', 'Wanderer’s Boots', 'common', 'boots.tall', { mods: { armor: 4, moveSpeed: 0.04 }, value: 45, material: 'leather' }),
    item('ring.gold', 'Ring of Quiet Steps', 'legendary', 'ring.band', { mods: { stealth: 12, 'skill.stealth': 5 }, value: 1250, material: 'gold', lore: 'No one remembers who wore it last. That is rather the point.' }),
    item('ore.iron', 'Iron Ore', 'common', 'ore.chunk', { count: 12, value: 4, maxDurability: 0 }),
    item('herb.emberleaf', 'Emberleaf', 'common', 'herb.leaf', { count: 7, value: 6, maxDurability: 0 }),
    item('book.tome', 'Treatise on Gravitation', 'rare', 'book.tome', { value: 90, maxDurability: 0 }),
    item('key.iron', 'Rusty Cellar Key', 'common', 'key.iron', { value: 0, maxDurability: 0 }),
    item('amulet.moon', 'Moonstone Amulet', 'unique', 'amulet.pendant', { mods: { maxMana: 40, manaRegen: 1.5 }, value: 2000, lore: 'It is cold to the touch even in the fire.' }),
  ];
  return {
    id: 1, name: 'Marric', appearance: randomAppearance('human', 1234),
    hp: 84, stamina: 70, mana: 55,
    stats: { maxHp: 120, maxStamina: 100, maxMana: 90, hpRegen: 1, staminaRegen: 8, manaRegen: 2, armor: 34, moveSpeed: 1, jump: 1, carry: 120, stealth: 14, perception: 22, resist: { fire: 0.1, frost: 0.05 } },
    skills: {
      skills: { blades: { level: 9, xp: 420 }, pyromancy: { level: 6, xp: 190 }, cryomancy: { level: 2, xp: 30 }, gravitism: { level: 3, xp: 55 }, restoration: { level: 1, xp: 20 }, athletics: { level: 5, xp: 260 }, archery: { level: 4, xp: 100 }, smithing: { level: 3, xp: 40 }, speech: { level: 2, xp: 50 } },
      abilities: ['firebolt', 'flame_wall', 'frost_shard', 'levitate', 'mend', 'riposte', 'whirlwind', 'power_shot', 'dash'],
      hotbar: ['firebolt', 'flame_wall', 'whirlwind', 'frost_shard', 'levitate', 'mend', null, `item:${inv[0].uid}`, null, 'dash'],
    },
    inventory: { items: inv, capacity: 120, coins: 1834 },
    equipment: { mainhand: sword, head: helm },
    effects: [
      { id: 'haste', magnitude: 0.2, until: 45 },
      { id: 'burning', magnitude: 3, until: 9, stacks: 2 },
      { id: 'blessing_of_dawn', magnitude: 1, until: Infinity },
    ],
    cooldowns: { flame_wall: 9, whirlwind: 6 },
    journal: {
      quests: [
        { id: 'q1', title: 'The Silent Bell', giver: 'Elder Hesk', summary: 'The chapel bell of the village has not rung for three days, and the bell-ringer is missing. Find out what happened.', status: 'active', source: 'npc', rewards: ['120 coins', 'Speech XP', 'Reputation with the village'],
          objectives: [{ id: 'o1', text: 'Speak with the bell-ringer’s wife', done: true }, { id: 'o2', text: 'Search the old mill', done: false, pos: [spawn[0] + 140, spawn[1], spawn[2] - 220] }, { id: 'o3', text: 'Collect bell fragments', done: false, count: 1, target: 3 }, { id: 'o4', text: 'Keep it quiet', done: false, optional: true }] },
        { id: 'q2', title: 'Ashes on the Wind', summary: 'The Game Master whispers of a crashed star to the north-east.', status: 'offered', source: 'gm', rewards: ['A glimpse of the unknown'], objectives: [{ id: 'o1', text: 'Find the crash site', done: false, pos: [spawn[0] + 600, spawn[1], spawn[2] - 900] }] },
        { id: 'q3', title: 'Wolves at the Fold', summary: 'Drive off the wolves.', status: 'completed', source: 'settlement', rewards: ['60 coins'], objectives: [{ id: 'o1', text: 'Slay wolves', done: true, count: 5, target: 5 }] },
      ],
      log: [
        { id: 'g1', kind: 'narration', text: 'The road behind you is already fading into mist.', t: 2 },
        { id: 'g2', kind: 'rumor', text: 'They say the mill wheel turns at night, though the river is low.', t: 10 },
        { id: 'g3', kind: 'omen', text: 'Two moons rise together. The old folk bar their doors.', t: 20, pos: [spawn[0] - 200, spawn[1], spawn[2] + 150] },
      ],
      discoveries: [{ id: 'd1', name: 'Ruins of Ixthar', pos: [spawn[0] - 160, spawn[1], spawn[2] - 90], kind: 'ruin' }, { id: 'd2', name: 'Weeping Shrine', pos: [spawn[0] + 80, spawn[1], spawn[2] + 200], kind: 'shrine' }],
    },
    reputation: {}, gravityMul: 1, home: spawn,
  };
}

// ------------------------------------------------------------------ game mock

async function bootGame() {
  mockCatalog();
  const seedText = params.get('seed') ?? 'amber-tide-42';
  const seed = parseSeed(seedText);
  const gen = new WorldGenerator(seed);
  const spawn = gen.findSpawn();
  const app = document.getElementById('app')!;

  // --- minimal 3D backdrop: terrain patch + capsules for entities
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  app.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const p = gen.profile;
  scene.background = new THREE.Color(...p.skyHorizon);
  scene.fog = new THREE.Fog(new THREE.Color(...p.fogColor), 80, 420);
  scene.add(new THREE.HemisphereLight(new THREE.Color(...p.skyZenith), new THREE.Color(...p.soilTint), 1.4));
  const sun = new THREE.DirectionalLight(new THREE.Color(...p.sunColor), 2.2);
  sun.position.set(1, 2, 0.6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 2000);
  {
    const N = 120, S = 4;
    const geo = new THREE.PlaneGeometry(N * S, N * S, N, N);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + spawn[0], z = pos.getZ(i) + spawn[2];
      const hgt = gen.heightAt(x, z);
      pos.setY(i, hgt);
      const c = hgt < 0 ? p.waterColor : hgt > 120 ? p.rockTint : p.foliage;
      col.set(c, i * 3);
    }
    pos.needsUpdate = true;
    geo.translate(spawn[0], 0, spawn[2]);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  const events = new Emitter<ClientEvents>();
  const player = mockPlayer(spawn);
  const playerPos: Vec3 = [...spawn];
  const entities = new Map<number, EntitySnapshot>();
  const views = new Map<number, EntityView>();
  let serverTime = 0;
  const snap = (id: number, kind: EntitySnapshot['kind'], dx: number, dz: number, o: Partial<EntitySnapshot>): EntitySnapshot => {
    const x = spawn[0] + dx, z = spawn[2] + dz;
    return { id, kind, pos: [x, gen.heightAt(x, z), z], vel: [0, 0, 0], yaw: 0, anim: { move: 'idle' }, hp: 100, maxHp: 100, flags: 0, ...o };
  };
  const ents: EntitySnapshot[] = [
    snap(10, 'npc', 6, -8, { name: 'Elder Hesk', title: 'Village Elder', flags: EntFlag.Talkable | EntFlag.Questgiver, speech: { text: 'The bell… you must find out why it is silent.', until: 1e9, style: 'say' } }),
    snap(11, 'npc', -7, -12, { name: 'Brunhild', title: 'Smith', flags: EntFlag.Talkable | EntFlag.Merchant }),
    snap(12, 'creature', 14, -22, { name: 'Ember Stalker', title: 'juvenile', hp: 40, maxHp: 90, flags: EntFlag.Hostile | EntFlag.InCombat }),
    snap(13, 'creature', -18, -30, { name: 'Moss Grazer', hp: 60, maxHp: 60 }),
    snap(14, 'item', 2, -4, { item: { defId: 'gem.ruby', name: 'Flawed Ruby', count: 1, rarity: 'rare', visual: player.inventory.items[0].visual } }),
    snap(15, 'npc', 20, -6, { name: 'Wandering Monk', title: 'Pilgrim', flags: EntFlag.Talkable, speech: { text: 'Hmm…', until: 1e9, style: 'think' } }),
  ];
  const meshes = new Map<number, THREE.Mesh>();
  for (const e of ents) {
    entities.set(e.id, e);
    const height = e.kind === 'item' ? 0.3 : e.kind === 'creature' ? 1.3 : 1.8;
    views.set(e.id, { object: new THREE.Object3D(), headHeight: height, radius: 0.5, update() {}, dispose() {} });
    const m = new THREE.Mesh(
      e.kind === 'item' ? new THREE.OctahedronGeometry(0.25) : new THREE.CapsuleGeometry(e.kind === 'creature' ? 0.5 : 0.35, height - 0.8, 4, 8),
      new THREE.MeshLambertMaterial({ color: e.flags & EntFlag.Hostile ? 0xaa3322 : e.kind === 'item' ? 0xff4466 : 0xd8c8a8 }),
    );
    m.position.set(e.pos[0], e.pos[1] + (e.kind === 'item' ? 0.3 : height / 2), e.pos[2]);
    scene.add(m);
    meshes.set(e.id, m);
  }
  const playerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1, 4, 8), new THREE.MeshLambertMaterial({ color: 0x5a7ab0 }));
  scene.add(playerMesh);

  let captured = false;
  const dialogView = (lines: DialogView['lines'], ended = false): DialogView => ({
    sessionId: 's1', npcId: 10, npcName: 'Elder Hesk', npcTitle: 'Village elder, worried', disposition: 32, canTrade: true, freeText: true, ended, lines,
    choices: ended ? [] : [
      { id: 'c1', text: 'What happened to the bell-ringer?' },
      { id: 'c2', text: 'I could find him — for a price.', check: { skill: 'speech', difficulty: 25, chance: 0.64 }, hint: 'Persuade him to pay more' },
      { id: 'c3', text: '[Intimidate] Tell me what you are hiding.', check: { skill: 'speech', difficulty: 40, chance: 0.22 } },
      { id: 'c4', text: 'Show me your wares.', hint: 'Opens trade' },
      { id: 'bye', text: 'Farewell.', exit: true },
    ],
  });
    const emitPlayer = () => events.emit('playerState', player);
  const findItem = (uid: string) => player.inventory.items.find((i) => i.uid === uid) ?? Object.values(player.equipment).find((i) => i?.uid === uid);
  const stock = [item('sword.short', 'Steel Shortsword', 'uncommon', 'sword.short', { value: 120, mods: { damage: 18 } }), item('shield.round', 'Oaken Round Shield', 'common', 'shield.round', { value: 60, mods: { armor: 10 } }), item('potion.health', 'Draught of Mending', 'uncommon', 'potion.round', { count: 1, value: 30 })];

  const server = (m: ClientMessage) => {
    console.log('[send]', m);
    switch (m.t) {
      case 'hotbar':
        player.skills.hotbar[m.slot] = m.value;
        emitPlayer();
        break;
      case 'equip': {
        const it = player.inventory.items.find((i) => i.uid === m.uid);
        if (!it) break;
        const slot = (m.slot ?? itemSlots(it)[0]) as EquipSlot | undefined;
        if (!slot) break;
        player.inventory.items = player.inventory.items.filter((i) => i !== it);
        const prev = player.equipment[slot];
        if (prev) player.inventory.items.push(prev);
        player.equipment[slot] = it;
        emitPlayer();
        break;
      }
      case 'unequip': {
        const it = player.equipment[m.slot];
        if (it) {
          delete player.equipment[m.slot];
          player.inventory.items.push(it);
          emitPlayer();
        }
        break;
      }
      case 'useItem': {
        const it = findItem(m.uid);
        if (!it) break;
        it.count--;
        if (it.count <= 0) player.inventory.items = player.inventory.items.filter((i) => i !== it);
        player.hp = Math.min(player.stats.maxHp, player.hp + 25);
        fire({ type: 'heal', target: 1, amount: 25, pos: playerPos });
        emitPlayer();
        break;
      }
      case 'dropItem':
        player.inventory.items = player.inventory.items.filter((i) => i.uid !== m.uid || ((i.count -= m.count ?? i.count) > 0));
        emitPlayer();
        break;
      case 'dialogChoice':
        if (m.choice === 'bye') {
          events.emit('dialog', dialogView([{ speaker: 'Elder Hesk', text: 'May the road be kind to you.', mood: 'neutral' }], true));
        } else if (m.choice === 'c4') server({ t: 'trade', npc: 10 });
        else {
          events.emit('dialog', { ...dialogView([{ speaker: 'Marric', speakerId: 1, text: dialogView([]).choices.find((c) => c.id === m.choice)!.text }]), thinking: true });
          setTimeout(() => events.emit('dialog', dialogView([{ speaker: '', text: 'Hesk glances toward the river.' }, { speaker: 'Elder Hesk', text: 'He went to the old mill at dusk, and he did not come back. The mill has been dark since the flood… but some nights, the wheel turns.', mood: 'afraid' }])), 500);
        }
        break;
      case 'dialogText':
        events.emit('dialog', { ...dialogView([{ speaker: 'Marric', speakerId: 1, text: m.text }]), thinking: true });
        setTimeout(() => events.emit('dialog', dialogView([{ speaker: 'Elder Hesk', text: `“${m.text}”? Hm. You speak strangely, traveller.`, mood: 'surprised' }])), 700);
        break;
      case 'trade':
        if (m.buy?.length || m.sell?.length) {
          for (const uid of m.buy ?? []) {
            const it = stock.find((s) => s.uid === uid);
            if (it) { player.inventory.coins -= Math.ceil(it.value * 1.25); player.inventory.items.push(it); stock.splice(stock.indexOf(it), 1); }
          }
          for (const uid of m.sell ?? []) {
            const it = player.inventory.items.find((s) => s.uid === uid);
            if (it) { player.inventory.coins += Math.floor(it.value * it.count * 0.4); player.inventory.items = player.inventory.items.filter((x) => x !== it); stock.push(it); }
          }
          emitPlayer();
        }
        events.emit('trade', { t: 'trade', npc: 11, stock: [...stock], prices: {}, sellPrices: {} });
        break;
      case 'questAction': {
        const q = player.journal.quests.find((x) => x.id === m.quest);
        if (q && m.action === 'accept') q.status = 'active';
        if (q && m.action === 'abandon') q.status = 'abandoned';
        emitPlayer();
        break;
      }
      case 'gmAsk':
        setTimeout(() => events.emit('gm', [{ id: `r${Date.now()}`, kind: 'reply', text: `You ask “${m.text}”. The wind shifts toward the mill. Some answers must be walked to.`, t: serverTime, pos: [spawn[0] + 140, spawn[1], spawn[2] - 220] }]), 1500);
        break;
      case 'save':
        setTimeout(() => {
          const data = JSON.stringify({ v: 1, player: player.name, t: Date.now() });
          // Mimic the client core: store under the typed seed, then emit.
          events.emit('serverMessage', { t: 'saved', data });
          localStorage.setItem(`norgo.save.${seedText}.${player.name}`, data);
          events.emit('notify', { text: 'Game saved', tone: 'good' });
        }, 300);
        break;
      case 'respawn':
        player.hp = player.stats.maxHp;
        emitPlayer();
        break;
      case 'craft':
        events.emit('notify', { text: `Crafted ${m.recipe}`, tone: 'good' });
        break;
    }
  };

  const ctx = {
    seed, gen, profile: gen.profile, core: {} as never, scene, camera, env: {} as never, streamer: {} as never, terrain: {} as never,
    colliders: {} as never, debris: {} as never, audio: { play() {}, footstep() {} }, events,
    state: { playerId: 1, player, serverTime: 0, entities, objects: new Map(), timeOfDay: 0.62, day: 3 },
    views, send: server, playerPos: () => playerPos, findItem, uiRoot: document.getElementById('ui')!,
    setUiCapture(c: boolean) { captured = c; },
    get uiCaptured() { return captured; },
  } as unknown as ClientContext;

  const ui = new UI();
  ui.init(ctx);
  ui.onGraphicsChange((g) => console.log('[graphics]', g));
  ui.setDebugInfo([`${gen.profile.name} — seed ${seed}`, 'sandbox mock context']);
  (window as unknown as Record<string, unknown>).sandbox = { ui, ctx, events, player, fire };
  events.emit('serverMessage', { t: 'world', timeOfDay: 0.62, day: 3, weather: { kind: 'rain', intensity: 0.5, windX: 1, windZ: 0 } });

  function fire(ev: GameEvent) {
    events.emit('gameEvent', ev);
  }

  // --- control strip
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    b.style.cssText = 'font:11px Inter,sans-serif;padding:3px 7px;background:#221d26;color:#ece2c8;border:1px solid #5a4a30;border-radius:3px;cursor:pointer';
    return b;
  };
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:8px;top:8px;z-index:100;display:flex;flex-wrap:wrap;gap:4px;max-width:520px;opacity:.85';
  const npcPos = (id: number) => entities.get(id)!.pos;
  bar.append(
    btn('dmg', () => { const e = entities.get(12)!; e.hp = Math.max(1, e.hp - 12); fire({ type: 'damage', target: 12, source: 1, amount: 12 + Math.random() * 10, dtype: 'fire', crit: Math.random() < 0.3, pos: npcPos(12) }); }),
    btn('hurt me', () => { player.hp = Math.max(1, player.hp - 30); fire({ type: 'damage', target: 1, source: 12, amount: 30, dtype: 'slash', pos: playerPos }); emitPlayer(); }),
    btn('heal', () => { player.hp = Math.min(player.stats.maxHp, player.hp + 40); fire({ type: 'heal', target: 1, amount: 40, pos: playerPos }); emitPlayer(); }),
    btn('xp', () => fire({ type: 'xp', skill: 'pyromancy', amount: 14, level: 6, leveled: false })),
    btn('level', () => fire({ type: 'xp', skill: 'blades', amount: 30, level: 10, leveled: true })),
    btn('unlock', () => { player.skills.abilities.push('meteor'); fire({ type: 'unlock', ability: 'meteor', skill: 'pyromancy' }); emitPlayer(); }),
    btn('loot', () => fire({ type: 'loot', items: ['Iron Ore ×3', 'Wolf Pelt'] })),
    btn('notify', () => events.emit('notify', { text: 'You feel lighter.', tone: 'info' })),
    btn('narrate', () => events.emit('gm', [{ id: `n${Date.now()}`, kind: 'event', text: 'A bell tolls once in the distance — though no bell remains in the village.', t: serverTime }])),
    btn('dialog', () => events.emit('dialog', dialogView([{ speaker: 'Elder Hesk', text: 'Ah, a traveller. These are strange days to arrive in Oakbrook.', mood: 'sad' }]))),
    btn('trade', () => server({ t: 'trade', npc: 11 })),
    btn('quest+', () => { player.journal.quests.push({ id: `q${Date.now()}`, title: 'The Drowned Lantern', summary: 'A lantern glows beneath the lake.', status: 'active', source: 'poi', rewards: [], objectives: [{ id: 'a', text: 'Dive to the lantern', done: false, pos: [spawn[0] - 300, 0, spawn[2] + 60] }] }); emitPlayer(); }),
    btn('quest✓', () => { const q = player.journal.quests.find((x) => x.status === 'active'); if (q) { q.status = 'completed'; emitPlayer(); } }),
    btn('discover', () => { player.journal.discoveries.push({ id: `d${Date.now()}`, name: 'The Hollow Obelisk', pos: [playerPos[0] + 30, playerPos[1], playerPos[2] + 30], kind: 'obelisk' }); emitPlayer(); }),
    btn('cooldown', () => { player.cooldowns = { ...player.cooldowns, firebolt: serverTime + 2.5, frost_shard: serverTime + 8, mend: serverTime + 6 }; emitPlayer(); }),
    btn('gravity', () => fire({ type: 'gravity', pos: playerPos, radius: 30, factor: 0.3, until: serverTime + 10 })),
    btn('weather', () => events.emit('serverMessage', { t: 'world', timeOfDay: Math.random(), day: 4, weather: { kind: (['clear', 'storm', 'snow', 'fog', 'ashfall'] as const)[Math.floor(Math.random() * 5)], intensity: Math.random(), windX: 0, windZ: 0 } })),
    btn('die', () => { player.hp = 0; fire({ type: 'death', target: 1, killer: 12 }); emitPlayer(); }),
    btn('focus', () => events.emit('focus', { kind: 'entity', id: 10, snap: entities.get(10)!, dist: 3, prompt: 'Talk' })),
  );
  document.body.appendChild(bar);

  // --- camera orbit & movement
  let camYaw = 0.6, camPitch = 0.32, dragging = false, lx = 0, ly = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  addEventListener('pointerup', () => (dragging = false));
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    camYaw -= (e.clientX - lx) * 0.006;
    camPitch = Math.max(-0.2, Math.min(1.2, camPitch + (e.clientY - ly) * 0.004));
    lx = e.clientX; ly = e.clientY;
  });
  const keys = new Set<string>();
  addEventListener('keydown', (e) => keys.add(e.code));
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frame(dt, now);
    requestAnimationFrame(loop);
  };
  // Manual stepping for automated checks in background tabs (rAF is throttled there).
  (window as unknown as { sandbox: Record<string, unknown> }).sandbox.step = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) frame(dt, performance.now());
  };
  function frame(dt: number, now: number) {
    serverTime += dt;
    ctx.state.serverTime = serverTime;
    ctx.state.timeOfDay = (ctx.state.timeOfDay + dt / 600) % 1;
    if (!captured) {
      const sp = (keys.has('ShiftLeft') ? 30 : 8) * dt;
      const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
      if (keys.has('KeyW')) { playerPos[0] += fx * sp; playerPos[2] += fz * sp; }
      if (keys.has('KeyS')) { playerPos[0] -= fx * sp; playerPos[2] -= fz * sp; }
      if (keys.has('KeyA')) { playerPos[0] += fz * sp; playerPos[2] -= fx * sp; }
      if (keys.has('KeyD')) { playerPos[0] -= fz * sp; playerPos[2] += fx * sp; }
    }
    playerPos[1] = gen.heightAt(playerPos[0], playerPos[2]);
    playerMesh.position.set(playerPos[0], playerPos[1] + 0.85, playerPos[2]);
    const d = 7;
    camera.position.set(playerPos[0] + Math.sin(camYaw) * Math.cos(camPitch) * d, playerPos[1] + 1.6 + Math.sin(camPitch) * d, playerPos[2] + Math.cos(camYaw) * Math.cos(camPitch) * d);
    camera.lookAt(playerPos[0], playerPos[1] + 1.6, playerPos[2]);
    camera.updateMatrixWorld();
    // Wandering creature.
    const c = entities.get(13)!;
    c.pos = [spawn[0] - 18 + Math.sin(serverTime * 0.3) * 6, 0, spawn[2] - 30 + Math.cos(serverTime * 0.3) * 6];
    c.pos[1] = gen.heightAt(c.pos[0], c.pos[2]);
    meshes.get(13)!.position.set(c.pos[0], c.pos[1] + 0.65, c.pos[2]);
    // Regen.
    player.stamina = Math.min(player.stats.maxStamina, player.stamina + dt * 3);
    player.mana = Math.min(player.stats.maxMana, player.mana + dt * 1.5);
    ui.update(dt, now / 1000);
    renderer.render(scene, camera);
  }
  loop();
}

// Boot last so module-level state above is initialized.
if (params.has('menu')) {
  showMainMenu(document.getElementById('ui')!).then((c) => {
    console.log('NewGameChoice', c);
    document.body.insertAdjacentHTML('beforeend', `<pre style="color:#d4af6a;font:13px monospace;padding:20px;position:fixed;inset:0;overflow:auto">${JSON.stringify({ ...c, save: c.save ? `${c.save.length} chars` : undefined }, null, 2)}</pre>`);
  });
} else {
  bootGame();
}
