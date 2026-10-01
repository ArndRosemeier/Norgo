/**
 * Gameplay & FX sandbox (/sandbox/gameplay.html).
 *
 * Runs the real GameplaySystem in-page (GameplayHarness: real terrain and
 * entities, stand-in services) next to the real FxSystem and terrain
 * streamer, so every ability, effect, aura and weather type can be cast and
 * inspected against training dummies. Server events and terrain edits are
 * piped straight into the client modules, exactly as the network would.
 *
 * Controls: orbit with the mouse (left drag), aim with the cursor, click an
 * ability to cast it at the cursor; Space re-casts the last ability.
 * `window.fxSandbox` exposes cast/play/weather helpers for automation.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderCore } from '../render/renderCore';
import { Environment } from '../render/environment';
import { WorldGenerator } from '../world/generator';
import { TerrainStreamer } from '../world/streamer';
import { createTerrainMaterial, createTerrainTextures } from '../world/terrainMaterial';
import { synthesizeInWorker } from '../world/textureLoader';
import { parseSeed } from '../core/rng';
import { Emitter } from '../core/events';
import { snapshotOf, type ServerEntity } from '../server/entity';
import type { ClientContext, ClientEvents, EntityView } from '../client/context';
import type { EntitySnapshot, PlayerState } from '../shared/protocol';
import type { EntityId, Vec3, WeatherKind } from '../shared/types';
import { GameplayHarness, harnessItem } from '../gameplay/server/testHarness';
import { FxSystem } from '../gameplay/client/FxSystem';
import { ABILITIES, EFFECTS, SKILLS, abilityDef, abilitiesOfSkill } from '../gameplay/data/catalog';
import { buildAbilityUse, describeAbility, TargetPreview, type AimInfo } from '../gameplay/client/abilityClient';

const params = new URLSearchParams(location.search);
const seed = parseSeed(params.get('seed') ?? '1234');
const app = document.getElementById('app')!;
const core = new RenderCore(app);
const gen = new WorldGenerator(seed);
const env = new Environment(core.scene, gen);
env.timeOfDay = Number(params.get('t') ?? 0.38);
const tex = createTerrainTextures(await synthesizeInWorker(seed));
const streamer = new TerrainStreamer(gen, createTerrainMaterial(tex));
core.scene.add(streamer.root);
await streamer.whenReady();

// ------------------------------------------------------------------ server side (in-page)

const harness = new GameplayHarness(gen);
const arena = harness.flatSpot();
const player = harness.addPlayer(arena, 80);
const dummies: ServerEntity[] = [];
function spawnDummies() {
  for (const d of dummies.splice(0)) harness.despawn(d.id);
  const ring = [[0, -7], [3, -9], [-3, -9], [6, -5], [-6, -5]];
  for (const [dx, dz] of ring) dummies.push(harness.addDummy(arena[0] + dx, arena[2] + dz, arena[1]));
  dummies.push(harness.addDummy(arena[0] + 7, arena[2] + 2, arena[1], 'villager', 'npc', 200));
  harness.trees.length = 0;
  harness.trees.push({ id: 1, kind: 'tree_oak', pos: [arena[0] - 5, arena[1], arena[2] - 2], radius: 0.4, hp: 400 });
}
spawnDummies();

// ------------------------------------------------------------------ client context

const events = new Emitter<ClientEvents>();
const views = new Map<EntityId, EntityView>();
const state = {
  playerId: player.id, player: {} as PlayerState, serverTime: 0, entities: new Map<EntityId, EntitySnapshot>(), objects: new Map(), timeOfDay: env.timeOfDay, day: 0,
};
const ctx = {
  seed, gen, profile: gen.profile, core, scene: core.scene, camera: core.camera, env, streamer, terrain: streamer.collider,
  colliders: null, debris: null, audio: { play() {}, footstep() {} }, events, state, views,
  send() {}, playerPos: () => player.pos, findItem: () => undefined, uiRoot: document.body, setUiCapture() {}, uiCaptured: false,
} as unknown as ClientContext;
const fx = new FxSystem();
fx.init(ctx);
const preview = new TargetPreview(fx.lib.decals);

// Player motion from knockback/dash events (the real client predicts this).
const pvel = new THREE.Vector3();
let airborne = false;
const logLines: string[] = [];
function log(s: string) {
  logLines.unshift(s);
  logLines.length = Math.min(logLines.length, 30);
  const el = document.getElementById('log');
  if (el) el.textContent = logLines.join('\n');
}
harness.onBroadcast = (ev) => {
  events.emit('gameEvent', ev);
  if (ev.type === 'knockback' && ev.target === player.id) {
    pvel.x += ev.impulse[0];
    pvel.y += ev.impulse[1];
    pvel.z += ev.impulse[2];
    airborne = true;
  }
};
harness.onSend = (_id, m) => {
  if (m.t === 'events')
    for (const ev of m.events) {
      events.emit('gameEvent', ev);
      if (ev.type === 'notify') log('• ' + ev.text);
      if (ev.type === 'unlock') log('★ unlocked ' + ev.ability);
    }
  if (m.t === 'correct') {
    player.pos = [m.pos[0], m.pos[1], m.pos[2]];
    pvel.set(0, 0, 0);
  }
};
harness.onEdit = (e) => {
  streamer.applyEdit(e);
  fx.terrainEdit(e);
};

// ------------------------------------------------------------------ simple entity views

class DummyView implements EntityView {
  readonly object = new THREE.Group();
  headHeight = 1.8;
  radius = 0.4;
  private body: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  constructor(snap: EntitySnapshot) {
    const color = snap.kind === 'player' ? 0x5a7ad8 : snap.kind === 'npc' ? 0x6fb06a : snap.faction === 'hostile' ? 0xb0503c : 0xb09a5c;
    this.mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.05, 6, 12).translate(0, 0.85, 0), this.mat);
    this.body.castShadow = true;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 8).rotateX(-Math.PI / 2).translate(0, 1.45, -0.32), this.mat);
    this.object.add(this.body, nose);
    const hand = new THREE.Object3D();
    hand.position.set(0.38, 1.0, -0.25);
    hand.name = 'hand.R';
    this.object.add(hand);
  }
  update(s: EntitySnapshot) {
    this.object.position.set(s.pos[0], s.pos[1], s.pos[2]);
    this.object.rotation.set(s.hp <= 0 ? -Math.PI / 2 : 0, s.yaw, 0, 'YXZ');
    const burning = s.flags & (1 << 9), frozen = s.flags & (1 << 10);
    this.mat.emissive.setRGB(burning ? 0.35 : frozen ? 0.15 : 0, burning ? 0.1 : frozen ? 0.3 : 0, frozen ? 0.45 : 0);
    this.object.visible = !(s.flags & (1 << 5)) || s.id === player.id;
  }
  getSocket(name: string) {
    return this.object.getObjectByName(name) ?? null;
  }
  dispose() {
    this.body.geometry.dispose();
    this.mat.dispose();
  }
}

class ItemView implements EntityView {
  readonly object = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.12, 0.25), new THREE.MeshStandardMaterial({ color: 0xd8c070, roughness: 0.4, metalness: 0.4 }));
  headHeight = 0.2;
  radius = 0.2;
  update(s: EntitySnapshot, _dt: number, time: number) {
    this.object.position.set(s.pos[0], s.pos[1] + 0.12 + Math.sin(time * 3) * 0.04, s.pos[2]);
    this.object.rotation.y = time;
  }
  dispose() {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------ camera, aim & casting

const cam = core.camera;
const controls = new OrbitControls(cam, core.canvas);
controls.enableDamping = true;
controls.target.set(arena[0], arena[1] + 1.2, arena[2]);
cam.position.set(arena[0] + 9, arena[1] + 7, arena[2] + 12);
const mouse = new THREE.Vector2(0, 0);
const ray = new THREE.Raycaster();
let aimPoint: Vec3 = [arena[0], arena[1], arena[2] - 7];
let aimEntity: EntityId | undefined;
core.canvas.addEventListener('pointermove', (e) => {
  const r = core.canvas.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});

function updateAim() {
  ray.setFromCamera(mouse, cam);
  const o = ray.ray.origin, d = ray.ray.direction;
  const hit = streamer.collider.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 200);
  if (hit) aimPoint = [hit.x, hit.y, hit.z];
  aimEntity = undefined;
  let best = 2.2;
  for (const e of harness.entities.all.values()) {
    if (e === player || !e.alive || (e.kind !== 'creature' && e.kind !== 'npc')) continue;
    const dd = Math.hypot(e.pos[0] - aimPoint[0], e.pos[2] - aimPoint[2]);
    if (dd < best) {
      best = dd;
      aimEntity = e.id;
    }
  }
}

function aimInfo(): AimInfo {
  const eye: Vec3 = [player.pos[0], player.pos[1] + 1.55, player.pos[2]];
  const t = aimEntity !== undefined ? harness.entities.get(aimEntity) : undefined;
  const p: Vec3 = t ? [t.pos[0], t.pos[1] + 1, t.pos[2]] : aimPoint;
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { aimOrigin: eye, aimDir: [d[0] / l, d[1] / l, d[2] / l], aimPoint: p, focusEntity: aimEntity, self: player.id, moveDir: [d[0] / l, 0, d[2] / l] };
}

let infinite = true;
let lastCast = 'fireball';
let selected: string | null = null;
function cast(id: string) {
  const def = abilityDef(id);
  if (!def) return;
  lastCast = id;
  const weaponSkill = def.requires?.weaponSkill?.[0];
  player.equipment!.mainhand = harnessItem(weaponSkill === 'archery' ? 'bow_hunting' : weaponSkill === 'polearms' ? 'spear_iron' : 'sword_iron');
  harness.gameplay.recomputeStats(player);
  if (infinite) {
    harness.playerData.get(player.id)!.cooldowns = {};
    player.mana = player.stats!.maxMana;
    player.stamina = player.stats!.maxStamina;
  }
  const aim = aimInfo();
  player.yaw = Math.atan2(-aim.aimDir[0], -aim.aimDir[2]);
  const r = harness.gameplay.abilities.use(player, buildAbilityUse(id, aim, 1), true);
  log((r.ok ? '✓ ' : '✗ ') + def.name + (r.ok ? '' : ' — ' + r.reason));
}

function attack(heavy: boolean) {
  const aim = aimInfo();
  player.equipment!.mainhand = harnessItem('sword_iron');
  harness.gameplay.recomputeStats(player);
  harness.gameplay.runtime(player).nextAttackAt = 0;
  harness.gameplay.onMessage(player, { t: 'attack', heavy, dir: aim.aimDir, point: aim.aimPoint, target: aim.focusEntity });
}

addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    cast(lastCast);
    e.preventDefault();
  }
  if (e.code === 'KeyF') attack(e.shiftKey);
  if (e.code === 'KeyG') {
    const a = aimInfo();
    harness.gameplay.runtime(player).nextDigAt = 0;
    player.equipment!.mainhand = harnessItem('pick_iron');
    harness.gameplay.onMessage(player, { t: 'dig', point: a.aimPoint, normal: [0, 1, 0] });
  }
});

// ------------------------------------------------------------------ UI panel

const panel = document.getElementById('panel')!;
const tip = document.getElementById('tip')!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', parent: HTMLElement = panel): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}
el('h1', 'Norgo · Gameplay & FX');
el('div', 'Cursor aims · click an ability to cast · Space recast · F attack (Shift heavy) · G dig');
const opt = el('div');
const inf = el('label', '', opt);
const infBox = el('input', '', inf);
infBox.type = 'checkbox';
infBox.checked = true;
infBox.onchange = () => (infinite = infBox.checked);
inf.append('infinite mana & no cooldowns');
el('button', 'Respawn dummies', opt).onclick = spawnDummies;
el('button', 'Heal all', opt).onclick = () => {
  for (const e of harness.entities.all.values()) if (e.alive) e.hp = e.maxHp;
};
let demo = false;
const demoBtn = el('button', 'Auto demo', opt);
demoBtn.onclick = () => {
  demo = !demo;
  demoBtn.classList.toggle('on', demo);
};

el('h2', 'Weather');
const wrow = el('div');
const kinds: WeatherKind[] = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'ashfall', 'sporefall'];
for (const k of kinds) el('button', k, wrow).onclick = () => setWeather(k);
const intensity = el('input', '', el('label', 'intensity ', wrow));
intensity.type = 'range';
intensity.min = '0';
intensity.max = '1';
intensity.step = '0.05';
intensity.value = '0.8';
intensity.oninput = () => (env.weather = { ...env.weather, intensity: Number(intensity.value) });
const tod = el('input', '', el('label', 'time ', wrow));
tod.type = 'range';
tod.min = '0';
tod.max = '1';
tod.step = '0.005';
tod.value = String(env.timeOfDay);
tod.oninput = () => (env.timeOfDay = Number(tod.value));
el('button', '⚡ bolt', wrow).onclick = () => fx.weather.bolt(aimPoint[0], aimPoint[1], aimPoint[2], aimPoint[1] + 160);
function setWeather(kind: WeatherKind) {
  env.weather = { kind, intensity: Number(intensity.value), windX: 1.2, windZ: 0.4 };
  harness.weather = env.weather;
}

el('h2', 'Status effects on aimed dummy');
const effSel = el('select');
for (const e of EFFECTS) {
  const o = el('option', `${e.icon} ${e.name}`, effSel);
  o.value = e.id;
}
el('button', 'apply').onclick = () => {
  const t = aimEntity !== undefined ? harness.entities.get(aimEntity) : dummies[0];
  if (t) harness.gameplay.applyEffect(t, effSel.value, effSel.value === 'force_shield' ? 60 : 3, 12, player);
};

el('h2', 'FX gallery (at cursor)');
const gal = el('div');
const FX_NAMES = [
  'explosion_fire', 'explosion_big', 'frost_nova', 'frost_burst', 'shatter', 'earth_spike', 'quake', 'fissure', 'slam', 'whirl', 'sunburst', 'heal', 'cleanse',
  'bloom', 'blink_in', 'implosion', 'force_ring', 'gravity_ring', 'meteor_fall', 'glyph_burst', 'levelup', 'parry', 'shield_hit', 'smoke_puff', 'rock_burst',
  'reveal', 'ore_ping', 'track', 'summon', 'tame', 'feast', 'firestorm',
];
for (const n of FX_NAMES)
  el('button', n, gal).onclick = () => {
    const p: Vec3 = [aimPoint[0], aimPoint[1] + (['heal', 'cleanse', 'levelup', 'parry', 'shield_hit', 'blink_in', 'reveal'].includes(n) ? 1.2 : 0), aimPoint[2]];
    const d = [aimPoint[0] - player.pos[0], 0, aimPoint[2] - player.pos[2]];
    const l = Math.hypot(d[0], d[2]) || 1;
    fx.lib.play(n, p, [d[0] / l, 0, d[2] / l], n === 'fissure' ? 10 : 3, [1, 0.8, 0.4], 1.2);
  };
el('h2', 'Log');
const logEl = el('div');
logEl.id = 'log';

el('h2', `Abilities (${ABILITIES.length})`);
for (const s of SKILLS) {
  el('h3', `${s.icon} ${s.name}`);
  const row = el('div');
  for (const a of abilitiesOfSkill(s.id)) {
    const b = el('button', `${a.icon} ${a.name}`, row);
    if (a.targeting === 'passive') b.classList.add('locked');
    b.onclick = () => (a.targeting === 'passive' ? log(`${a.name} is passive`) : cast(a.id));
    b.onmouseenter = () => {
      tip.style.display = 'block';
      tip.textContent = describeAbility(a, player).join('\n');
      selected = a.targeting === 'passive' ? null : a.id;
    };
    b.onmouseleave = () => {
      tip.style.display = 'none';
      selected = null;
    };
  }
}

// ------------------------------------------------------------------ loop

const hud = document.getElementById('hud')!;
let last = performance.now(), time = 0, serverAcc = 0, fps = 60, demoT = 0, demoI = 0;
const demoList = ABILITIES.filter((a) => a.targeting !== 'passive' && a.kind === 'magic').map((a) => a.id);
const extrap: Vec3 = [0, 0, 0];
const camTarget = new THREE.Vector3();

function syncEntities(dt: number) {
  const seen = new Set<EntityId>();
  for (const e of harness.entities.all.values()) {
    seen.add(e.id);
    const snap = snapshotOf(e, false);
    // Extrapolate fast movers between 20 Hz server ticks.
    extrap[0] = e.pos[0] + e.vel[0] * serverAcc;
    extrap[1] = e.pos[1] + e.vel[1] * serverAcc;
    extrap[2] = e.pos[2] + e.vel[2] * serverAcc;
    if (e.kind === 'projectile') snap.pos = [extrap[0], extrap[1], extrap[2]];
    state.entities.set(e.id, snap);
    let v = views.get(e.id);
    if (!v) {
      v = e.kind === 'projectile' || e.kind === 'effect' ? fx.create(snap) : e.kind === 'item' ? new ItemView() : new DummyView(snap);
      views.set(e.id, v);
      core.scene.add(v.object);
    }
    v.update(snap, dt, time);
  }
  for (const [id, v] of views) {
    if (seen.has(id)) continue;
    v.dispose();
    v.object.removeFromParent();
    views.delete(id);
    state.entities.delete(id);
    events.emit('entityRemoved', { id });
  }
}

function playerPhysics(dt: number) {
  if (!airborne && pvel.lengthSq() < 0.01) return;
  const g = gen.gravityAt(player.pos[0], player.pos[1], player.pos[2]) * (player.stats?.gravityMul ?? 1);
  pvel.y -= g * dt;
  const nx = player.pos[0] + pvel.x * dt, ny = player.pos[1] + pvel.y * dt, nz = player.pos[2] + pvel.z * dt;
  const gy = streamer.collider.groundBelow(nx, Math.max(ny, player.pos[1]) + 1.5, nz, 4);
  if (!Number.isNaN(gy) && ny <= gy && pvel.y <= 0) {
    player.pos = [nx, gy, nz];
    pvel.multiplyScalar(0.0);
    airborne = false;
  } else player.pos = [nx, ny, nz];
  harness.entities.reindex(player);
}

function loop() {
  const now = performance.now();
  frame(Math.min(0.05, (now - last) / 1000));
  last = now;
  // Keep simulating when the tab is hidden (automation, side-by-side windows).
  if (document.hidden) setTimeout(loop, 16);
  else requestAnimationFrame(loop);
}

/** One simulation + render frame. */
function frame(dt: number) {
  time += dt;
  fps += (1 / Math.max(1e-3, dt) - fps) * 0.05;
  updateAim();
  playerPhysics(dt);
  serverAcc += dt;
  while (serverAcc >= 0.05) {
    serverAcc -= 0.05;
    harness.tick(0.05);
  }
  state.serverTime = harness.time.now;
  if (demo && (demoT -= dt) <= 0) {
    demoT = 2.2;
    const t = dummies.find((d) => d.alive);
    if (t) aimPoint = [t.pos[0], t.pos[1], t.pos[2]];
    cast(demoList[demoI++ % demoList.length]);
  }
  syncEntities(dt);
  preview.update(selected, aimInfo(), player.pos, (x, y, z) => streamer.collider.groundBelow(x, y, z, 10));
  controls.target.lerp(camTarget.set(player.pos[0], player.pos[1] + 1.2, player.pos[2]), 0.05);
  controls.update();
  cam.updateMatrixWorld();
  streamer.update(cam);
  env.update(cam, dt, time);
  fx.update(dt, time);
  core.render();
  const s = fx.stats();
  hud.textContent = `${fps.toFixed(0)} fps   calls ${core.renderer.info.render.calls}\nparticles spawned ${s.additive + s.alpha}  weather/frame ${s.weather}\nserver tick worst ${harness.worstTickMs.toFixed(2)} ms  entities ${harness.entities.all.size}\nterrain edits ${harness.editCount}  weather ${env.weather.kind}`;
}
loop();

/** Advance `seconds` synchronously at 60 fps (automation in throttled background tabs). */
function step(seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) frame(1 / 60);
}

(window as unknown as Record<string, unknown>).fxSandbox = { harness, fx, cast, attack, play: (n: string) => fx.lib.play(n, aimPoint, [0, 0, -1], 3, [1, 0.8, 0.4], 1.2), setWeather, step, cam, controls, player, dummies, env, aim: () => aimPoint, setAim: (p: Vec3) => (aimPoint = p) };
