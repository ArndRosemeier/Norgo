/**
 * Creatures sandbox: a living bestiary for any seed.
 *
 * Every species of the world is spawned twice (an adult and a juvenile with
 * different individual seeds) in its own pen on a rolling test ground. They
 * walk / trot / gallop circles, flyers take off and land, fish school in a
 * pond, floaters drift. Select a species on the right to focus it, inspect its
 * genome and trigger actions. Time-of-day & cave toggles show sky occlusion
 * and bioluminescence.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createProfile } from '../world/profile';
import { speciesList, type Species } from '../creatures/species';
import { CreatureView, speciesAssets, pumpCreatureBuilds, darknessAt } from '../creatures/client/CreatureViews';
import type { GroundSampler } from '../creatures/client/rig';
import type { EntitySnapshot } from '../shared/protocol';
import type { MoveState } from '../shared/types';
import { BIOMES } from '../world/biomes';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fb4c8, 60, 260);
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x50402a, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60; sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const camera = new THREE.PerspectiveCamera(45, 1, 0.03, 600);
camera.position.set(0, 14, 34);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;

// ------------------------------------------------------------------ test ground

const POND = { x: -26, z: -14, r: 11 };
function groundH(x: number, z: number): number {
  let h = Math.sin(x * 0.13) * Math.cos(z * 0.11) * 0.7 + Math.sin(x * 0.53 + z * 0.37) * 0.18 + Math.sin(z * 0.9 - x * 0.2) * 0.06;
  const d = Math.hypot(x - POND.x, z - POND.z);
  if (d < POND.r + 6) h -= (1 - THREE.MathUtils.smoothstep(d, POND.r - 2, POND.r + 6)) * 4;
  return h;
}
const groundGeo = new THREE.PlaneGeometry(320, 320, 220, 220);
groundGeo.rotateX(-Math.PI / 2);
{
  const p = groundGeo.attributes.position as THREE.BufferAttribute;
  const col: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const h = groundH(x, z);
    p.setY(i, h);
    const n = Math.sin(x * 1.7) * Math.sin(z * 1.3) * 0.5 + 0.5;
    const c = h < -1.5 ? new THREE.Color(0.38, 0.33, 0.26) : new THREE.Color().setHSL(0.24 + n * 0.04, 0.35, 0.22 + n * 0.06);
    col.push(c.r, c.g, c.b);
  }
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);
const water = new THREE.Mesh(new THREE.CircleGeometry(POND.r + 4, 48), new THREE.MeshStandardMaterial({ color: 0x2a5a78, transparent: true, opacity: 0.55, roughness: 0.1 }));
water.rotation.x = -Math.PI / 2;
water.position.set(POND.x, -0.4, POND.z);
scene.add(water);
const sampler: GroundSampler = { height: (x, _y, z) => groundH(x, z) };

// ------------------------------------------------------------------ bestiary

interface Actor {
  sp: Species;
  view: CreatureView;
  snap: EntitySnapshot;
  center: THREE.Vector3;
  radius: number;
  angle: number;
  phase: number;
  label: HTMLDivElement;
  forced: { move?: MoveState; until: number } | null;
}
let actors: Actor[] = [];
let selected = -1;
let clock = 0;
let tod = 0.4;
let cave = false;
let profileFaunaSeed = 0;
const labelLayer = document.createElement('div');
labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
view.appendChild(labelLayer);

function clear() {
  for (const a of actors) {
    scene.remove(a.view.object);
    a.view.dispose();
    a.label.remove();
  }
  actors = [];
}

function hex(c: [number, number, number]) {
  return '#' + new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace).getHexString();
}

function build() {
  clear();
  const seed = Number(($('seed') as HTMLInputElement).value) >>> 0;
  const profile = createProfile(seed);
  profileFaunaSeed = profile.faunaSeed;
  const list = speciesList(profile);
  const t0 = performance.now();
  // Lay species out in rows by role; fish go to the pond.
  let x = -40, z = 6, rowDepth = 0;
  const fish = list.filter((s) => s.medium === 'water');
  for (const sp of list) {
    const a = speciesAssets(sp, profile.faunaSeed);
    void a;
    const isFish = sp.medium === 'water';
    const span = Math.max(3.2, sp.totalLength * 2.6 + 1);
    let center: THREE.Vector3;
    if (isFish) {
      const i = fish.indexOf(sp);
      const ang = (i / Math.max(1, fish.length)) * Math.PI * 2;
      center = new THREE.Vector3(POND.x + Math.cos(ang) * POND.r * 0.45, -2.0, POND.z + Math.sin(ang) * POND.r * 0.45);
    } else {
      if (x + span > 44) { x = -40; z += rowDepth + 2; rowDepth = 0; }
      center = new THREE.Vector3(x + span / 2, 0, z + span / 2);
      x += span + 1.5;
      rowDepth = Math.max(rowDepth, span);
    }
    for (let k = 0; k < 2; k++) {
      const iseed = (seed * 31 + sp.index * 977 + k * 7919) >>> 0;
      const growth = k === 0 ? 1 : 0.55;
      const v = new CreatureView(speciesAssets(sp, profile.faunaSeed), iseed, growth, {
        ground: sampler, camera, darkness: () => darknessAt(tod), serverTime: () => clock,
      });
      scene.add(v.object);
      const snap: EntitySnapshot = {
        id: actors.length + 1, kind: 'creature', pos: [center.x, 0, center.z], vel: [0, 0, 0], yaw: 0, anim: { move: 'idle' }, hp: sp.hp, maxHp: sp.hp, flags: 0,
        creature: { species: sp.index, seed: iseed, growth },
      };
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = k === 0 ? sp.name : '';
      labelLayer.appendChild(label);
      actors.push({ sp, view: v, snap, center, radius: Math.max(0.6, span * 0.3) * (k ? 0.6 : 1), angle: k * Math.PI, phase: (sp.index * 0.37 + k * 0.5) % 1, label, forced: null });
    }
  }
  $('stats').textContent = `${profile.name}: ${list.length} species, life weirdness ${profile.lifeWeirdness.toFixed(2)} — built LOD1 in ${(performance.now() - t0).toFixed(0)} ms`;
  // Side list.
  const side = $('side');
  side.innerHTML = '';
  list.forEach((sp) => {
    const d = document.createElement('div');
    d.className = 'card';
    const c = sp.colors;
    d.innerHTML = `<div class="nm"><span class="sw" style="background:${hex(c.base)}"></span><span class="sw" style="background:${hex(c.secondary)}"></span>${sp.name}</div>
      <div class="sub">${sp.role} · ${sp.plan} · ${sp.integument} · ${sp.size} · ${sp.sociality} · ${sp.temperament} · ${sp.activity}</div>
      <div class="sub">${sp.biomes.map((b) => BIOMES[b].name).join(', ')}</div>`;
    d.onclick = () => select(sp.index);
    side.appendChild(d);
  });
  select(-1);
}

function select(idx: number) {
  selected = idx;
  [...$('side').children].forEach((c, i) => c.classList.toggle('sel', i === idx));
  const info = $('info');
  if (idx < 0) {
    info.style.display = 'none';
    return;
  }
  const a = actors.find((x) => x.sp.index === idx)!;
  const sp = a.sp;
  controls.target.copy(a.center).setY(a.center.y + sp.height * 0.5);
  const dist = Math.max(2.5, sp.totalLength * 3.2);
  camera.position.copy(controls.target).add(new THREE.Vector3(dist * 0.8, dist * 0.45, dist));
  info.style.display = 'block';
  const h = sp.head;
  info.innerHTML = `<b>${sp.name}</b> <span class="sub">(${sp.id})</span>
${sp.role} · ${sp.plan} · ${sp.medium} · ${sp.integument}${sp.translucent ? ' (translucent)' : ''} · pattern ${sp.colors.pattern}${sp.colors.glowAmount > 0 ? ' · glow ' + sp.colors.glowAmount.toFixed(2) : ''}
torso ${sp.length.toFixed(2)} m · total ${sp.totalLength.toFixed(2)} m · ${sp.mass.toFixed(1)} kg (${sp.size}) · legs ${sp.limbs.pairs * 2}${sp.limbs.digitigrade ? ' digitigrade' : ''} ${sp.limbs.foot} · gait ${sp.gait}
head: eyes ${h.eyes} (${h.pupil})${h.horns ? ' · horns ' + h.horns : ''}${h.antlers ? ' · antlers' : ''}${h.beak ? ' · beak' : ''}${h.mandibles ? ' · mandibles' : ''}${h.tusks ? ' · tusks' : ''}${h.antennae ? ' · antennae' : ''}${h.frill ? ' · frill' : ''}${h.crest ? ' · crest' : ''}
wings ${sp.wings.kind} · tail ${sp.tail.length.toFixed(2)} (${sp.tail.tip}) · spikes ${sp.dorsal.spikes}${sp.dorsal.shell ? ' · shell' : ''}${sp.dorsal.sail ? ' · sail' : ''}
${sp.diet} · ${sp.activity} · ${sp.sociality} ${sp.groupSize.join('-')} · ${sp.temperament}
hp ${sp.hp} · dmg ${sp.damage} ${sp.damageType} · speed ${sp.walkSpeed.toFixed(1)}/${sp.runSpeed.toFixed(1)} m/s · sight ${sp.sight.toFixed(0)} m · attacks ${sp.attacks.join(', ')}
loot: ${sp.loot.join(', ')} · tame ${(sp.tameDifficulty * 100).toFixed(0)}%
<div id="acts">${['bite', 'claw', 'charge', 'roar', 'pounce', 'sting', 'spit', 'graze', 'drink', 'flinch', 'sleep', 'die'].map((x) => `<button data-a="${x}">${x}</button>`).join('')}</div>`;
  info.querySelectorAll('button').forEach((b) => {
    b.onclick = () => trigger(idx, (b as HTMLButtonElement).dataset.a!);
  });
}

function trigger(idx: number, id: string) {
  for (const a of actors) {
    if (a.sp.index !== idx) continue;
    if (id === 'sleep') a.forced = { move: 'sleep', until: clock + 8 };
    else if (id === 'die') a.forced = { move: 'dead', until: clock + 6 };
    else {
      const dur = id === 'graze' || id === 'drink' ? 3 : id === 'roar' ? 1.6 : id === 'pounce' ? 1.1 : 0.8;
      a.snap.anim = { ...a.snap.anim, action: { id, t0: clock, dur } };
      a.forced = { move: 'idle', until: clock + dur };
    }
  }
}

// ------------------------------------------------------------------ simulation of motion

const speedSel = $('spd') as HTMLSelectElement;
function stepActor(a: Actor, dt: number) {
  const sp = a.sp;
  const s = a.snap;
  const cyc = (clock / 22 + a.phase) % 1;
  let mode: 'idle' | 'walk' | 'run' = cyc < 0.18 ? 'idle' : cyc < 0.45 ? 'walk' : cyc < 0.65 ? 'run' : cyc < 0.85 ? 'walk' : 'idle';
  if (speedSel.value !== 'auto') mode = speedSel.value as typeof mode;
  let move: MoveState = mode;
  if (a.forced && clock > a.forced.until) {
    a.forced = null;
    if (s.anim.action) s.anim = { move: s.anim.move };
  }
  if (a.forced) { mode = 'idle'; move = a.forced.move ?? 'idle'; }
  const growthScale = a.snap.creature!.growth < 1 ? 0.7 : 1;
  let speed = mode === 'idle' ? 0 : mode === 'walk' ? sp.walkSpeed : sp.runSpeed * 0.8;
  speed *= growthScale;
  if (sp.medium === 'water') { move = 'swim'; speed = Math.max(speed, sp.walkSpeed); }
  const flyer = sp.medium === 'air';
  const floater = sp.medium === 'float';
  const airborne = flyer && cyc > 0.35 && cyc < 0.85 && !a.forced;
  if (airborne) { move = cyc > 0.7 ? 'glide' : 'fly'; speed = Math.max(speed, sp.runSpeed * 0.5); }
  if (floater) { move = 'fly'; speed = sp.walkSpeed * 0.5; }
  // Circle path.
  const r = airborne ? a.radius * 2.5 + 2 : a.radius;
  const w = speed / Math.max(0.3, r);
  a.angle += w * dt;
  const px = a.center.x + Math.cos(a.angle) * r, pz = a.center.z + Math.sin(a.angle) * r;
  let py: number;
  const gh = groundH(px, pz);
  if (sp.medium === 'water') py = a.center.y + Math.sin(clock * 0.7 + a.phase * 6) * 0.4;
  else if (floater) py = gh + 1.5 + sp.height * 0.6 + Math.sin(clock * 0.5 + a.phase * 6) * 0.4;
  else if (airborne) py = gh + 3 + Math.sin(clock * 0.8 + a.phase * 3) * 1.5 + (cyc - 0.35) * 4;
  else py = gh;
  const ny = airborne ? py : py;
  // Velocity from motion.
  const vx = (px - s.pos[0]) / Math.max(dt, 1e-3), vy = (ny - s.pos[1]) / Math.max(dt, 1e-3), vz = (pz - s.pos[2]) / Math.max(dt, 1e-3);
  const okVel = Math.hypot(vx, vz) < 50;
  s.vel = okVel ? [vx, vy, vz] : [0, 0, 0];
  s.pos = [px, ny, pz];
  // Yaw: facing the direction of travel (yaw 0 faces −Z).
  const dx = -Math.sin(a.angle), dz = Math.cos(a.angle);
  if (speed > 0.01) s.yaw = Math.atan2(-dx, -dz);
  s.anim = { ...s.anim, move: speed > 0.01 && move === 'idle' ? (mode as MoveState) : move };
  if (mode === 'idle' && !a.forced && !flyer) s.anim.lookAt = [camera.position.x, camera.position.y, camera.position.z];
  else delete s.anim.lookAt;
}

// ------------------------------------------------------------------ UI wiring & loop

$('go').onclick = build;
$('rand').onclick = () => {
  ($('seed') as HTMLInputElement).value = String((Math.random() * 1e9) | 0);
  build();
};
($('tod') as HTMLInputElement).oninput = (e) => (tod = Number((e.target as HTMLInputElement).value));
($('cave') as HTMLInputElement).onchange = (e) => (cave = (e.target as HTMLInputElement).checked);
const qp = new URLSearchParams(location.search);
if (qp.get('seed')) ($('seed') as HTMLInputElement).value = qp.get('seed')!;
if (qp.get('tod')) { tod = Number(qp.get('tod')); ($('tod') as HTMLInputElement).value = String(tod); }
build();
if (qp.get('sel')) select(Number(qp.get('sel')));

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const _p = new THREE.Vector3();
let last = performance.now();
let fpsAcc = 0, fpsN = 0;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  fpsAcc += dt; fpsN++;
  // Lighting from time of day.
  const ang = (tod - 0.25) * Math.PI * 2;
  sun.position.set(Math.cos(ang) * 80, Math.sin(ang) * 80, 30);
  const day = THREE.MathUtils.smoothstep(Math.sin(ang), -0.12, 0.2);
  const skyVis = cave ? 0 : 1;
  sun.intensity = 2.6 * day * skyVis;
  hemi.intensity = (0.15 + 0.85 * day) * (cave ? 0.05 : 1);
  const bg = new THREE.Color().setHSL(0.6, 0.35, 0.05 + 0.55 * day * skyVis);
  scene.background = bg;
  (scene.fog as THREE.Fog).color.copy(bg);
  pumpCreatureBuilds();
  const showLabels = ($('labels') as HTMLInputElement).checked;
  const w = view.clientWidth, h = view.clientHeight;
  for (const a of actors) {
    stepActor(a, dt);
    a.view.setSkyVis(skyVis);
    a.view.update(a.snap, dt, clock);
    if (showLabels && a.label.textContent) {
      _p.set(a.snap.pos[0], a.snap.pos[1] + a.view.headHeight + 0.2, a.snap.pos[2]).project(camera);
      const vis = _p.z < 1 && Math.abs(_p.x) < 1.1 && Math.abs(_p.y) < 1.1 && camera.position.distanceTo(a.view.object.position) < 45;
      a.label.style.display = vis ? 'block' : 'none';
      if (vis) a.label.style.transform = `translate(${((_p.x + 1) / 2) * w}px, ${((1 - _p.y) / 2) * h}px) translate(-50%, -100%)`;
    } else a.label.style.display = 'none';
  }
  controls.update();
  renderer.render(scene, camera);
  if (fpsAcc > 1) {
    const base = $('stats').textContent!.split(' | ')[0];
    $('stats').textContent = `${base} | ${(fpsN / fpsAcc).toFixed(0)} fps · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris`;
    fpsAcc = 0; fpsN = 0;
  }
}
renderer.setAnimationLoop(() => { if (!document.hidden) frame(); });
// Background tabs get no rAF: keep simulating on a timer so automated screenshots stay live.
// Self-scheduling with an idle gap so automation scripts can still get the main thread.
const bgLoop = () => { if (document.hidden) frame(); setTimeout(bgLoop, 80); };
setTimeout(bgLoop, 80);
/** Debug helper: frame one individual from the side (used for automated visual checks). */
function look(idx: number, k = 0, d = 1, h = 0.5, side = 1, speed = 'idle') {
  const a = actors.filter((x) => x.sp.index === idx)[k];
  if (!a) return 'none';
  const p = a.view.object.position, s = a.sp;
  const dist = Math.max(0.6, s.totalLength * 2.2) * d;
  controls.target.set(p.x, p.y + s.height * 0.45, p.z);
  camera.position.set(p.x + dist * side, p.y + s.height * 0.5 + dist * h * 0.4, p.z + dist * 0.3);
  speedSel.value = speed;
  return s.name + ' ' + s.plan + ' ' + s.integument;
}
(window as unknown as { bestiary: unknown }).bestiary = { select, trigger, camera, controls, look, frame, actors: () => actors };
if (qp.get('look')) setTimeout(() => look(Number(qp.get('look')), 0, Number(qp.get('d') ?? 1)), 100);
void profileFaunaSeed;
