/**
 * Humanoid sandbox: race gallery (several random individuals per race),
 * single-character editor with sliders for every appearance parameter,
 * animation tester (locomotion states with real velocity on a bumpy ground
 * for foot IK, every action id, moods, talking, look-at), held items and
 * worn equipment from the item catalog.
 *
 * URL: ?mode=gallery|single&race=elf&seed=3&n=4&move=walk&action=swing_1h&view=face|body
 * Debug handle: window.hsb
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BodyService } from '../humanoid/client/BodyService';
import { HumanoidRig, type RigSnap } from '../humanoid/client/HumanoidRig';
import { randomAppearance, RACES, HAIR_STYLES, BEARD_STYLES, BROW_STYLES } from '../humanoid/appearance';
import { RACE_IDS, type HumanoidAppearance, type RaceId } from '../humanoid/types';
import { ACTIONS } from '../humanoid/client/anim/actions';
import { clipLibrary, clipLibraryReady } from '../humanoid/client/anim/clips';
import type { AnimState, MoveState } from '../shared/types';
import type { EquipmentVisuals, EquipSlot, ItemDef } from '../items/types';
import { ITEM_DEFS as ITEMS } from '../items/data/catalog';

const Q = new URLSearchParams(location.search);
const appEl = document.getElementById('app')!;
const panel = document.getElementById('panel')!;
const statsEl = document.getElementById('stats')!;
const labelsEl = document.getElementById('labels')!;

// ------------------------------------------------------------------ renderer & scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(appEl.clientWidth, appEl.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
appEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa6bf);
scene.fog = new THREE.Fog(0x8fa6bf, 30, 90);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;
const camera = new THREE.PerspectiveCamera(32, appEl.clientWidth / appEl.clientHeight, 0.03, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
sun.position.set(-4, 7, -5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -9;
sc.right = sc.top = 9;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xc4d8ff, 0x5a4a38, 0.75);
scene.add(hemi);
const rim = new THREE.DirectionalLight(0xbfd2ff, 1.2);
rim.position.set(3, 3, 6);
scene.add(rim);

/** Gentle analytic hills for the foot IK test. */
let bumpy = Q.get('ground') === 'bumpy';
const heightAt = (x: number, z: number) => (bumpy ? Math.sin(x * 0.9) * 0.18 + Math.cos(z * 0.7 + x * 0.3) * 0.15 : 0);
const groundGeo = new THREE.PlaneGeometry(80, 80, 200, 200);
groundGeo.rotateX(-Math.PI / 2);
function shapeGround() {
  const p = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  p.needsUpdate = true;
  groundGeo.computeVertexNormals();
}
shapeGround();
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: 0x5d6650, roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);
const groundFn = (x: number, _y: number, z: number) => heightAt(x, z);

// ------------------------------------------------------------------ state

interface Actor {
  rig: HumanoidRig;
  home: THREE.Vector3;
  label: HTMLDivElement;
  yaw: number;
  phase: number;
  /** Actions mode: this actor's action id and frozen progress (or -1 = loop). */
  actionId?: string;
  progress?: number;
  /** States mode: locomotion state and speed. */
  moveId?: MoveState;
  moveSpeed?: number;
}
const actors: Actor[] = [];
const state = {
  mode: (Q.get('mode') ?? 'gallery') as 'gallery' | 'single' | 'actions' | 'states',
  /** Actions mode: shared progress 0..1, or -1 to loop in real time. */
  progress: Number(Q.get('p') ?? -1),
  race: (Q.get('race') ?? 'human') as RaceId,
  seed: Number(Q.get('seed') ?? 1),
  n: Number(Q.get('n') ?? 4),
  move: (Q.get('move') ?? 'idle') as MoveState,
  speed: Number(Q.get('speed') ?? 0),
  circle: Q.get('circle') === '1',
  action: Q.get('action') ?? '',
  actionDur: 1.0,
  actionT0: -100,
  loopAction: Q.get('loop') === '1',
  mood: (Q.get('mood') ?? 'neutral') as NonNullable<AnimState['mood']>,
  talking: Q.get('talk') === '1',
  combat: Q.get('combat') === '1',
  lookCam: Q.get('look') !== '0',
  equipment: {} as EquipmentVisuals,
  /** 0 freezes animation (inspect a pose); see hsb.pose(). */
  timeScale: 1,
  /** Library clip preview ('' = off) and its normalized time (< 0 = play). */
  clip: Q.get('clip') ?? '',
  clipU: -0.01,
  app: null as HumanoidAppearance | null,
};
let time = 0;

function clearActors() {
  for (const a of actors) { a.rig.dispose(); a.label.remove(); }
  actors.length = 0;
}

function addActor(app: HumanoidAppearance, x: number, z: number, label: string) {
  const rig = new HumanoidRig(app, { ground: groundFn, alwaysDrawn: true, priority: Math.abs(x) + Math.abs(z) });
  rig.object.position.set(x, heightAt(x, z), z);
  scene.add(rig.object);
  const el = document.createElement('div');
  el.textContent = label;
  labelsEl.appendChild(el);
  actors.push({ rig, home: new THREE.Vector3(x, 0, z), label: el, yaw: 0, phase: Math.random() * 6 });
  return rig;
}

function buildScene() {
  clearActors();
  if (state.mode === 'states') {
    const app = randomAppearance(state.race, state.seed);
    const states: [MoveState, number][] = [['idle', 0], ['walk', 1.5], ['run', 4.2], ['sprint', 7], ['crouch', 1.2], ['crouch', 0], ['swim', 1.4], ['swim', 0], ['climb', 0], ['jump', 0], ['fall', 0], ['glide', 6], ['fly', 0], ['sit', 0], ['sleep', 0], ['dead', 0], ['stunned', 0], ['knockdown', 0]];
    states.forEach(([m, sp], i) => {
      const x = ((i % 6) - 2.5) * 1.6, z = Math.floor(i / 6) * 2.4;
      addActor(app, x, z, `${m} ${sp}`);
      actors[actors.length - 1].moveId = m;
      actors[actors.length - 1].moveSpeed = sp;
    });
    camera.position.set(-6, 4, -8);
    controls.target.set(0, 0.8, 2.4);
    return;
  }
  if (state.mode === 'actions') {
    // Every action id on the same individual, in a grid (geometry is shared).
    const app = randomAppearance(state.race, state.seed);
    const ids = Object.keys(ACTIONS);
    const cols = 9;
    ids.forEach((id, i) => {
      const x = ((i % cols) - (cols - 1) / 2) * 1.3, z = Math.floor(i / cols) * 2.0;
      addActor(app, x, z, id);
      actors[actors.length - 1].actionId = id;
    });
    camera.position.set(0, 5, -9);
    controls.target.set(0, 0.9, 3);
    return;
  }
  if (state.mode === 'gallery') {
    const races: RaceId[] = Q.get('all') === '0' ? [state.race] : RACE_IDS;
    races.forEach((r, ri) => {
      for (let k = 0; k < state.n; k++) {
        const a = randomAppearance(r, state.seed * 1000 + k * 7 + 1, k === state.n - 1 && r !== 'human' ? { race2: 'human' } : {});
        const x = (k - (state.n - 1) / 2) * 1.0 * Math.max(1, a.scale);
        const z = (ri - (races.length - 1) / 2) * 2.2;
        addActor(a, x * (r === 'giantkin' ? 1.4 : 1), z, `${RACES[r].name}${a.race2 ? '/' + RACES[a.race2].name : ''} ${a.gender > 0.5 ? '♂' : '♀'} ${Math.round(a.age * 100)}`);
      }
    });
    camera.position.set(0, 6, -14);
    controls.target.set(0, 0.9, 0);
  } else {
    state.app ??= randomAppearance(state.race, state.seed);
    addActor(state.app, 0, 0, RACES[state.app.race].name);
    setView(Q.get('view') ?? 'body');
  }
}

function setView(v: string) {
  const a = actors[0];
  if (!a) return;
  const h = a.rig.height;
  if (v === 'face') {
    controls.target.set(a.rig.object.position.x, a.rig.object.position.y + h * 0.93, a.rig.object.position.z);
    camera.position.set(controls.target.x + 0.12, controls.target.y + 0.02, controls.target.z - 0.62 * Math.max(0.6, h / 1.8));
  } else {
    controls.target.set(a.rig.object.position.x, a.rig.object.position.y + h * 0.55, a.rig.object.position.z);
    camera.position.set(controls.target.x + 1.2, controls.target.y + 0.3, controls.target.z - 3.2 * Math.max(0.6, h / 1.8));
  }
}

// ------------------------------------------------------------------ panel UI

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}
function section(title: string) {
  panel.appendChild(h('h2', {}, title));
}
function row(label: string, el: HTMLElement, val?: HTMLElement) {
  const r = h('div', { class: 'row' });
  r.append(h('label', {}, label), el);
  if (val) r.append(val);
  panel.appendChild(r);
}
function select(label: string, options: string[], value: string, on: (v: string) => void) {
  const s = h('select');
  for (const o of options) s.appendChild(h('option', { value: o }, o));
  s.value = value;
  s.onchange = () => on(s.value);
  row(label, s);
  return s;
}
function slider(label: string, min: number, max: number, value: number, on: (v: number) => void, step = 0.01) {
  const s = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
  s.value = String(value);
  const v = h('span', { class: 'v' }, value.toFixed(2));
  s.oninput = () => { v.textContent = Number(s.value).toFixed(2); on(Number(s.value)); };
  row(label, s, v);
  return s;
}
function button(text: string, on: () => void, parent: HTMLElement = panel) {
  const b = h('button', {}, text);
  b.onclick = on;
  parent.appendChild(b);
  return b;
}
const toHex = (c: [number, number, number]) => '#' + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): [number, number, number] => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
function color(label: string, value: [number, number, number], on: (c: [number, number, number]) => void) {
  const c = h('input', { type: 'color' });
  c.value = toHex(value);
  c.oninput = () => on(fromHex(c.value));
  row(label, c);
}

let rebuildTimer = 0;
function appChanged(geometry = true) {
  if (state.mode !== 'single' || !state.app || !actors[0]) return;
  clearTimeout(rebuildTimer);
  const app = { ...state.app, face: { ...state.app.face }, body: { ...state.app.body }, horns: { ...state.app.horns }, tail: { ...state.app.tail } };
  rebuildTimer = window.setTimeout(() => void actors[0].rig.setAppearance(app), geometry ? 120 : 0);
}

function buildPanel() {
  panel.innerHTML = '';
  panel.appendChild(h('h1', {}, 'Norgo · Humanoids'));
  const modes = h('div', { class: 'tags' });
  button('Gallery', () => { state.mode = 'gallery'; buildScene(); buildPanel(); }, modes).classList.toggle('on', state.mode === 'gallery');
  button('Single', () => { state.mode = 'single'; state.app = null; buildScene(); buildPanel(); }, modes).classList.toggle('on', state.mode === 'single');
  button('Actions', () => { state.mode = 'actions'; buildScene(); buildPanel(); }, modes).classList.toggle('on', state.mode === 'actions');
  button('Face', () => setView('face'), modes);
  button('Body', () => setView('body'), modes);
  panel.appendChild(modes);

  section('Individual');
  select('Race', RACE_IDS, state.race, (v) => { state.race = v as RaceId; state.app = null; buildScene(); buildPanel(); });
  const seedIn = h('input', { type: 'number', value: String(state.seed) });
  seedIn.onchange = () => { state.seed = Number(seedIn.value); state.app = null; buildScene(); buildPanel(); };
  row('Seed', seedIn);
  button('🎲 Random', () => { state.seed = Math.floor(Math.random() * 1e6); state.app = null; buildScene(); buildPanel(); });
  if (state.mode === 'gallery') {
    slider('Per race', 1, 8, state.n, (v) => { state.n = v; buildScene(); }, 1);
  }
  const ground = h('input', { type: 'checkbox' });
  ground.checked = bumpy;
  ground.onchange = () => { bumpy = ground.checked; shapeGround(); };
  row('Bumpy ground', ground);

  if (state.mode === 'single' && state.app) {
    const a = state.app;
    select('Mixed with', ['-', ...RACE_IDS], a.race2 ?? '-', (v) => { a.race2 = v === '-' ? null : (v as RaceId); appChanged(); });
    slider('Mix', 0, 1, a.raceMix, (v) => { a.raceMix = v; appChanged(); });
    section('Macro');
    for (const k of ['gender', 'age', 'muscle', 'weight', 'height', 'proportions', 'african', 'asian', 'caucasian'] as const) slider(k, 0, 1, a[k], (v) => { a[k] = v; appChanged(); });
    slider('scale', 0.5, 2, a.scale, (v) => { a.scale = v; appChanged(); });
    section('Face');
    for (const k of Object.keys(a.face) as (keyof HumanoidAppearance['face'])[]) slider(k, -1, k === 'earPoint' ? 1.3 : 1, a.face[k], (v) => { a.face[k] = v; appChanged(); });
    section('Body');
    for (const k of Object.keys(a.body) as (keyof HumanoidAppearance['body'])[]) slider(k, -1, 1, a.body[k], (v) => { a.body[k] = v; appChanged(); });
    section('Look');
    color('Skin', a.skinTone, (c) => { a.skinTone = c; appChanged(false); });
    color('Accent', a.skinAccent, (c) => { a.skinAccent = c; appChanged(false); });
    select('Pattern', ['none', 'freckles', 'scales', 'bark', 'spots', 'tattoos', 'veins', 'stripes', 'crystals'], a.skinPattern, (v) => { a.skinPattern = v as HumanoidAppearance['skinPattern']; if (!a.patternStrength) a.patternStrength = 0.7; appChanged(false); });
    slider('Pattern str.', 0, 1, a.patternStrength, (v) => { a.patternStrength = v; appChanged(false); });
    color('Eyes', a.eyeColor, (c) => { a.eyeColor = c; appChanged(); });
    slider('Eye glow', 0, 1, a.eyeGlow, (v) => { a.eyeGlow = v; appChanged(); });
    select('Pupil', ['round', 'slit', 'goat', 'none'], a.pupil, (v) => { a.pupil = v as HumanoidAppearance['pupil']; appChanged(); });
    color('Hair', a.hairColor, (c) => { a.hairColor = c; appChanged(); });
    select('Hair style', HAIR_STYLES, a.hairStyle, (v) => { a.hairStyle = v; appChanged(); });
    select('Beard', BEARD_STYLES, a.beardStyle, (v) => { a.beardStyle = v; appChanged(); });
    select('Brows', BROW_STYLES, a.browStyle, (v) => { a.browStyle = v; appChanged(false); });
    slider('Tusks', 0, 1, a.tusks, (v) => { a.tusks = v; appChanged(); });
    select('Horns', ['none', 'ram', 'straight', 'swept', 'antler', 'crown'], a.horns.style, (v) => { a.horns.style = v as HumanoidAppearance['horns']['style']; if (!a.horns.size) a.horns.size = 0.7; appChanged(); });
    slider('Horn size', 0, 1, a.horns.size, (v) => { a.horns.size = v; appChanged(); });
    select('Tail', ['none', 'reptile', 'furred', 'thin'], a.tail.style, (v) => { a.tail.style = v as HumanoidAppearance['tail']['style']; if (!a.tail.length) a.tail.length = 0.9; appChanged(); });
    const marks = h('input', { type: 'text', value: a.marks.join(',') });
    marks.onchange = () => { a.marks = marks.value.split(',').map((s) => s.trim()).filter(Boolean); appChanged(false); };
    row('Marks', marks);
  }

  section('Animation');
  select('Move', ['idle', 'walk', 'run', 'sprint', 'crouch', 'swim', 'climb', 'jump', 'fall', 'glide', 'fly', 'sit', 'sleep', 'dead', 'stunned', 'knockdown'], state.move, (v) => {
    state.move = v as MoveState;
    const sp: Record<string, number> = { idle: 0, walk: 1.5, run: 4.2, sprint: 7, crouch: 1.1, swim: 1.4, climb: 0, glide: 6 };
    state.speed = sp[v] ?? 0;
    speedS.value = String(state.speed);
  });
  const speedS = slider('Speed m/s', 0, 9, state.speed, (v) => (state.speed = v));
  // Library clip preview (anim/clips.ts): the whole body from one clip, scrubbed or playing.
  select('Clip', ['-', ...(clipLibrary()?.clips.keys() ?? [])], state.clip || '-', (v) => (state.clip = v === '-' ? '' : v));
  slider('Clip time', -0.01, 1, state.clipU, (v) => (state.clipU = v));
  const circ = h('input', { type: 'checkbox' });
  circ.checked = state.circle;
  circ.onchange = () => (state.circle = circ.checked);
  row('Walk circle', circ);
  select('Mood', ['neutral', 'happy', 'angry', 'sad', 'afraid', 'surprised', 'disgusted', 'focused', 'pain'], state.mood, (v) => (state.mood = v as typeof state.mood));
  const talk = h('input', { type: 'checkbox' });
  talk.checked = state.talking;
  talk.onchange = () => (state.talking = talk.checked);
  row('Talking', talk);
  const combat = h('input', { type: 'checkbox' });
  combat.checked = state.combat;
  combat.onchange = () => (state.combat = combat.checked);
  row('In combat', combat);
  const look = h('input', { type: 'checkbox' });
  look.checked = state.lookCam;
  look.onchange = () => (state.lookCam = look.checked);
  row('Look at camera', look);
  const loop = h('input', { type: 'checkbox' });
  loop.checked = state.loopAction;
  loop.onchange = () => (state.loopAction = loop.checked);
  row('Loop action', loop);
  slider('Action dur', 0.3, 4, state.actionDur, (v) => (state.actionDur = v));
  const acts = h('div', { class: 'tags' });
  for (const id of Object.keys(ACTIONS)) button(id, () => { state.action = id; state.actionT0 = time; }, acts);
  panel.appendChild(acts);

  section('Equipment');
  const slots: EquipSlot[] = ['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet', 'hands', 'shoulders', 'back', 'waist', 'neck', 'wrists', 'face', 'ring1', 'ring2'];
  for (const slot of slots) {
    const defs = (ITEMS as ItemDef[]).filter((d) => d.slots.includes(slot));
    select(slot, ['-', ...defs.map((d) => d.id)], state.equipment[slot]?.defId ?? '-', (v) => {
      if (v === '-') delete state.equipment[slot];
      else {
        const d = defs.find((x) => x.id === v)!;
        state.equipment[slot] = { defId: d.id, visual: { ...d.visual, seed: d.visual.seed ?? 1234 } };
      }
      state.equipment = { ...state.equipment };
    });
  }
  button('Random outfit', () => {
    const pick = (slot: EquipSlot) => {
      const defs = (ITEMS as ItemDef[]).filter((d) => d.slots.includes(slot));
      return defs[Math.floor(Math.random() * defs.length)];
    };
    const eq: EquipmentVisuals = {};
    for (const slot of ['chest', 'legs', 'feet', 'head', 'hands', 'mainhand'] as EquipSlot[]) {
      if (Math.random() < 0.85) { const d = pick(slot); if (d) eq[slot] = { defId: d.id, visual: { ...d.visual, seed: Math.floor(Math.random() * 1e6) } }; }
    }
    state.equipment = eq;
    buildPanel();
  });
  button('Clear', () => { state.equipment = {}; buildPanel(); });
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
function frame() {
  const dt = Math.min(0.05, clock.getDelta()) * state.timeScale;
  time += dt;
  controls.update();
  for (const a of actors) {
    let x = a.home.x, z = a.home.z, vx = 0, vz = 0;
    const sp = state.speed;
    if (sp > 0 && (state.circle || state.mode === 'single')) {
      // Walk a circle so velocity, yaw and stride are real.
      const R = state.mode === 'single' ? 3 : 0.0001;
      if (state.mode === 'single' && state.circle) {
        a.phase += (sp / R) * dt;
        x = a.home.x + Math.cos(a.phase) * R;
        z = a.home.z + Math.sin(a.phase) * R;
        vx = -Math.sin(a.phase) * sp;
        vz = Math.cos(a.phase) * sp;
        a.yaw = Math.atan2(-vx, -vz);
      } else {
        // Treadmill: moves in place but reports velocity facing the camera's side.
        vx = 0; vz = -sp;
        a.yaw = 0;
      }
    } else if (sp > 0) {
      vz = -sp;
    }
    let act = state.action && (time - state.actionT0 < state.actionDur || state.loopAction) ? { id: state.action, t0: state.loopAction ? state.actionT0 + Math.floor((time - state.actionT0) / state.actionDur) * state.actionDur : state.actionT0, dur: state.actionDur, aim: [0, 0.1, -1] as [number, number, number] } : undefined;
    if (a.actionId) {
      const dur = 1.6;
      const p = state.progress >= 0 ? state.progress : (time % (dur + 0.5)) / dur;
      act = { id: a.actionId, t0: time - Math.min(p, 1.2) * dur, dur, aim: [0, 0.1, -1] as [number, number, number] };
    }
    const mv = a.moveId ?? state.move;
    if (a.moveId) { vx = 0; vz = -(a.moveSpeed ?? 0); a.yaw = 0; }
    const snap: RigSnap = {
      pos: [x, heightAt(x, z), z],
      vel: [vx, a.moveId === 'jump' ? 3 : a.moveId === 'fall' ? -6 : a.moveId === 'climb' ? 0.8 : 0, vz],
      yaw: a.yaw,
      anim: { move: mv, action: act, mood: state.mood, talking: state.talking, lookAt: state.lookCam ? [camera.position.x, camera.position.y, camera.position.z] : undefined },
      flags: state.combat ? 4 : 0,
      equipment: state.equipment,
    };
    if (a.rig.animator) a.rig.animator.preview = state.clip ? { name: state.clip, u: state.clipU } : null;
    a.rig.update(snap, dt, time, camera.position);
    tmp.set(x, heightAt(x, z) + a.rig.height * a.rig.app.scale * 0 + a.rig.height + 0.15, z).project(camera);
    a.label.style.display = tmp.z < 1 ? '' : 'none';
    a.label.style.left = `${((tmp.x + 1) / 2) * appEl.clientWidth}px`;
    a.label.style.top = `${((1 - tmp.y) / 2) * appEl.clientHeight}px`;
  }
  renderer.render(scene, camera);
  const info = renderer.info;
  statsEl.textContent = `chars ${actors.length}  builds ${BodyService.get().stats.builds} (avg ${BodyService.get().stats.avgMs.toFixed(0)} ms, pending ${BodyService.get().pending})\ncalls ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  programs ${info.programs?.length ?? 0}`;
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  renderer.setSize(appEl.clientWidth, appEl.clientHeight);
  camera.aspect = appEl.clientWidth / appEl.clientHeight;
  camera.updateProjectionMatrix();
});

/** Debug: show action `id` frozen at progress p (0..1). */
function pose(id: string, p: number) {
  state.action = id;
  state.timeScale = 1;
  state.actionT0 = time - p * state.actionDur;
  setTimeout(() => (state.timeScale = 0), 120);
}
// The clip list fills in once the library has loaded.
void clipLibraryReady().then(() => buildPanel());
(window as unknown as Record<string, unknown>).hsb = { pose, THREE, scene, camera, controls, renderer, actors, state, setView, buildScene, buildPanel, randomAppearance, svc: BodyService.get() };
if (Q.get('equip')) {
  for (const id of Q.get('equip')!.split(',')) {
    const d = (ITEMS as ItemDef[]).find((x) => x.id === id);
    if (d && d.slots[0]) state.equipment[d.slots[0]] = { defId: d.id, visual: { ...d.visual, seed: d.visual.seed ?? 99 } };
  }
}
buildScene();
buildPanel();
frame();
