/**
 * Items sandbox: browse every base item, rolled loot, uniques and NPC
 * outfits for any seed — 3D meshes (or in-game ground views with rarity
 * beams), rendered UI icons, and full tooltip data.
 *   /sandbox/items.html?mode=loot&seed=7&level=20&filter=sword&fit=1&ground=1
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ITEM_DEFS, itemDef } from '../items/data/catalog';
import { STYLES } from '../items/data/styles';
import { UNIQUES } from '../items/data/uniques';
import { buildItemObject, attachItemLight, animateItem } from '../items/client/buildItem';
import { disposeItemObject } from '../items/client/materials';
import { ItemViews } from '../items/client/ItemViews';
import { itemIconUrl, onIconReady, iconKey } from '../items/client/icons';
import { createItem, RARITY_COLORS, itemWeight } from '../items/gen/generate';
import { rollLootTable, LOOT_TABLES } from '../items/gen/loot';
import { outfitPlan } from '../items/gen/outfit';
import type { ItemInstance } from '../items/types';
import { Rng } from '../core/rng';
import type { EntitySnapshot } from '../shared/protocol';
import type { EntityView, ClientContext } from '../client/context';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $('view'), side = $('side'), tip = $('tip');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202329);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x403020, 0.8));
const sun = new THREE.DirectionalLight(0xfff0dd, 2.2);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.95 }));
floor.receiveShadow = true;
floor.position.y = -0.001;
scene.add(floor);
const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 300);
camera.position.set(0, 3, 8);
const controls = new OrbitControls(camera, renderer.domElement);
const holder = new THREE.Group();
scene.add(holder);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const styleSel = $<HTMLSelectElement>('style');
for (const s of Object.keys(STYLES)) styleSel.append(new Option(s, s));
const modeSel = $<HTMLSelectElement>('mode');
for (const t of Object.keys(LOOT_TABLES)) modeSel.append(new Option('table: ' + t, 'table:' + t));

// ------------------------------------------------------------------ item sets

interface Entry {
  item: ItemInstance;
  group?: string;
}

function makeSet(): Entry[] {
  const seed = Number($<HTMLInputElement>('seed').value) || 1;
  const level = Number($<HTMLInputElement>('level').value) || 10;
  const style = styleSel.value || undefined;
  const filter = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  const mode = modeSel.value;
  const races = Object.keys(STYLES);
  let out: Entry[] = [];
  let uid = 0;
  const U = () => 'sb' + uid++;
  if (mode === 'defs') {
    out = ITEM_DEFS.filter((d) => !filter || d.id.includes(filter) || d.visual.shape.includes(filter) || d.category.includes(filter)).map((d, i) => ({
      item: createItem(d.id, { seed: seed * 7919 + i, level, style: style ?? races[(seed + i) % races.length], uid: U(), count: d.stackable ? Math.min(d.maxStack, 5) : 1 }),
    }));
  } else if (mode === 'loot') {
    const gear = ITEM_DEFS.filter((d) => d.slots.length && !d.stackable && (!filter || d.id.includes(filter) || d.visual.shape.includes(filter) || d.category.includes(filter)));
    const pick = new Rng(seed);
    for (let i = 0; i < 60 && gear.length; i++) {
      const d = pick.pick(gear);
      out.push({ item: createItem(d.id, { seed: seed * 1000 + i, level, style: style ?? races[(seed * 7 + i) % races.length], luck: 2.5, uid: U() }) });
    }
  } else if (mode === 'uniques') {
    out = UNIQUES.map((u, i) => ({ item: createItem(u.id, { seed: seed + i, uid: U() }) }));
  } else if (mode === 'outfits') {
    const jobs = ['farmer', 'smith', 'guard', 'mage', 'noble', 'hunter', 'priest', 'bandit', 'thief', 'merchant'];
    jobs.forEach((job, j) => {
      const race = style ?? races[(seed + j) % races.length];
      for (const p of outfitPlan(race, job, 0.3 + (j % 3) * 0.3, seed * 100 + j))
        out.push({ group: `${race} ${job}`, item: createItem(p.defId, { level: p.level, material: p.material, style: race, source: 'outfit', seed: seed * 977 + out.length, uid: U() }) });
    });
  } else if (mode.startsWith('table:')) {
    const t = mode.slice(6);
    for (let k = 0; k < 6; k++) for (const it of rollLootTable(t, level, seed * 13 + k, { style, uid: U })) out.push({ group: `${t} #${k + 1}`, item: it });
  }
  if (filter && mode !== 'defs' && mode !== 'loot') out = out.filter((e) => e.item.name.toLowerCase().includes(filter) || e.item.defId.includes(filter) || e.item.visual.shape.includes(filter));
  return out;
}

// ------------------------------------------------------------------ tooltip

const rarityCss = (r: string) => {
  const c = RARITY_COLORS[r as keyof typeof RARITY_COLORS] ?? [1, 1, 1];
  return `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
};
const fmtMod = (k: string, v: number) => {
  const pct = ['critChance', 'attackSpeed', 'castSpeed', 'spellPower', 'moveSpeed', 'jump'].includes(k);
  const val = pct ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}%` : `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`;
  return `${val} ${k.replace('resist.', 'resist ').replace('damage.', 'dmg ').replace('skill.', '')}`;
};
function tooltipHtml(it: ItemInstance): string {
  const d = itemDef(it.defId)!;
  const lines: string[] = [];
  lines.push(`<div style="font-weight:700;color:${rarityCss(it.rarity)}">${it.name}${it.count > 1 ? ' ×' + it.count : ''}</div>`);
  if (it.data?.baseName) lines.push(`<div class="sub">${it.data.baseName}</div>`);
  lines.push(`<div class="sub">${it.rarity} ${d.category}${d.slots.length ? ' · ' + d.slots.join('/') : ''}${d.twoHanded ? ' · two-handed' : ''} · ${it.material} · ${it.visual.style}</div>`);
  if (it.weapon) lines.push(`<div>${it.weapon.damage} ${it.weapon.type} · speed ${it.weapon.speed} · reach ${it.weapon.reach} m · ${it.weapon.skill}</div>`);
  if (it.tool) lines.push(`<div>${it.tool.kind} power ${it.tool.power}</div>`);
  if (d.consumable) lines.push(`<div>${d.consumable.effects.map((e) => `${e.id} ${e.magnitude}${e.duration ? ` for ${e.duration}s` : ''}`).join(', ')}</div>`);
  const mods = Object.entries(it.mods);
  if (mods.length) lines.push(`<div style="color:#8cf">${mods.map(([k, v]) => fmtMod(k, v)).join('<br>')}</div>`);
  for (const a of it.affixes) if (a.grants) lines.push(`<div style="color:#fc8">Grants: ${a.grants}</div>`);
  lines.push(`<div class="sub">quality ${(it.quality * 100).toFixed(0)}% · durability ${Math.round(it.durability)}/${it.maxDurability} · ${itemWeight(it).toFixed(2)} kg · ${it.value} coins · lvl ${it.level}</div>`);
  lines.push(`<div style="color:#aaa;font-style:italic;margin-top:4px">${d.description}</div>`);
  if (it.lore) lines.push(`<div style="color:#d8c8a0;margin-top:4px">${it.lore.replace(/\n/g, '<br>')}</div>`);
  if (it.origin) lines.push(`<div class="sub">${it.origin}</div>`);
  return lines.join('');
}

// ------------------------------------------------------------------ build

let entries: Entry[] = [];
const views: EntityView[] = [];
const factory = new ItemViews();
const pickables: { obj: THREE.Object3D; entry: Entry }[] = [];

function clear() {
  for (const c of [...holder.children]) {
    holder.remove(c);
    if (!c.userData.isView) disposeItemObject(c);
  }
  for (const v of views) v.dispose();
  views.length = 0;
  pickables.length = 0;
  side.innerHTML = '';
}

function build() {
  clear();
  entries = makeSet();
  const fit = $<HTMLInputElement>('fit')?.checked;
  const ground = $<HTMLInputElement>('ground')?.checked;
  const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length * 1.6)));
  const cell = fit || ground ? 1.4 : 1.1;
  entries.forEach((e, i) => {
    const x = (i % cols) * cell - (cols * cell) / 2, z = Math.floor(i / cols) * cell * 1.2;
    let obj: THREE.Object3D;
    if (ground) {
      const snap = { id: i + 1, kind: 'item', pos: [x, 0, z], vel: [0, 0, 0], yaw: 0, anim: { move: 'idle' }, hp: 1, maxHp: 1, flags: 0, item: { defId: e.item.defId, name: e.item.name, count: e.item.count, visual: e.item.visual, rarity: e.item.rarity } } as EntitySnapshot;
      const v = factory.create(snap, {} as ClientContext)!;
      views.push(v);
      obj = v.object;
      obj.userData.isView = true;
      obj.userData.snap = snap;
    } else {
      obj = buildItemObject(e.item.defId, e.item.visual);
      attachItemLight(obj, 0.5);
      const sz0 = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
      // Long held items have their edge on +Z: show the flat toward the default camera.
      if (sz0.y > 1.8 * Math.max(sz0.x, sz0.z)) obj.rotation.y = -Math.PI / 2;
      if (fit) {
        const s = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
        obj.scale.setScalar(0.9 / Math.max(0.05, s.x, s.y, s.z));
      }
      obj.position.set(x, 0, z);
    }
    obj.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = true) : 0));
    holder.add(obj);
    pickables.push({ obj, entry: e });
    side.append(card(e, obj));
  });
  $('stats').textContent = `${entries.length} items`;
}

function card(e: Entry, obj: THREE.Object3D): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  const img = document.createElement('img');
  img.src = itemIconUrl(e.item, 64);
  const key = iconKey(e.item, 64);
  onIconReady(key, (u) => (img.src = u));
  const txt = document.createElement('div');
  txt.innerHTML = `<div class="nm" style="color:${rarityCss(e.item.rarity)}">${e.item.name}${e.item.count > 1 ? ' ×' + e.item.count : ''}</div><div class="sub">${e.group ? e.group + ' · ' : ''}${e.item.defId} · ${e.item.material} · ${e.item.value}c</div>`;
  el.append(img, txt);
  el.onmouseenter = (ev) => showTip(e.item, ev.clientX, ev.clientY);
  el.onmousemove = (ev) => moveTip(ev.clientX, ev.clientY);
  el.onmouseleave = hideTip;
  el.onclick = () => {
    const b = new THREE.Box3().setFromObject(obj);
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(0.3, b.getSize(new THREE.Vector3()).length());
    controls.target.copy(c);
    camera.position.copy(c).add(new THREE.Vector3(0.3, 0.35, 1).normalize().multiplyScalar(r * 1.6));
    document.querySelectorAll('.card.sel').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
  };
  return el;
}

function showTip(it: ItemInstance, x: number, y: number) {
  tip.innerHTML = tooltipHtml(it);
  tip.style.display = 'block';
  moveTip(x, y);
}
function moveTip(x: number, y: number) {
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(innerWidth - w - 8, x + 16) + 'px';
  tip.style.top = Math.min(innerHeight - h - 8, y + 12) + 'px';
}
function hideTip() {
  tip.style.display = 'none';
}

// 3D hover tooltips.
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
renderer.domElement.addEventListener('mousemove', (ev) => {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObjects(pickables.map((p) => p.obj), true);
  if (!hits.length) return hideTip();
  let o: THREE.Object3D | null = hits[0].object;
  while (o && !pickables.find((p) => p.obj === o)) o = o.parent;
  const p = pickables.find((x) => x.obj === o);
  if (p) showTip(p.entry.item, ev.clientX, ev.clientY);
});
renderer.domElement.addEventListener('mouseleave', hideTip);

// Extra toggles in the bar.
const bar = $('bar');
for (const [id, label] of [['fit', 'Fit'], ['ground', 'Ground views']]) {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" id="${id}"> ${label}`;
  bar.insertBefore(l, $('go'));
}

const qp = new URLSearchParams(location.search);
for (const k of ['filter', 'seed', 'level']) if (qp.get(k)) $<HTMLInputElement>(k).value = qp.get(k)!;
if (qp.get('mode')) modeSel.value = qp.get('mode')!;
if (qp.get('style')) styleSel.value = qp.get('style')!;
if (qp.get('fit')) $<HTMLInputElement>('fit').checked = true;
if (qp.get('ground')) $<HTMLInputElement>('ground').checked = true;
$('go').onclick = build;
for (const id of ['filter', 'seed', 'level']) $<HTMLInputElement>(id).addEventListener('keydown', (e) => e.key === 'Enter' && build());
modeSel.onchange = build;
styleSel.onchange = build;
build();

let last = performance.now();
renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  controls.update();
  for (const v of views) v.update(v.object.userData.snap as EntitySnapshot, dt, t / 1000);
  for (const c of holder.children) if (!c.userData.isView) animateItem(c, t / 1000);
  renderer.render(scene, camera);
});
