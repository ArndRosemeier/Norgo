/**
 * Flora sandbox.
 *
 *  - Species gallery: every species of a world (trees in both variants, shrubs,
 *    plants, cave flora, water plants, rocks), at a selectable detail tier
 *    (0..2 meshes, 3 = captured impostor). Click a species on the right to focus.
 *  - Biome patch: picks a location of the chosen biome, generates real chunks
 *    (density → surface nets → worker scatter) at a chosen LOD and renders them
 *    through the real FloraSystem with a minimal client context, including
 *    colliders, destruction states and debris.
 *  - Wind / sun sliders; buttons replay felled / shattered / harvested / damaged states.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WorldGenerator } from '../world/generator';
import { BIOMES, Biome, SURFACE_BIOMES, UNDERWORLD_BIOMES } from '../world/biomes';
import { MATERIALS } from '../world/materials';
import { materialColors } from '../world/terrainTextures';
import { CHUNK_SIZE } from '../world/constants';
import { meshChunk } from '../world/mesher';
import { EditStore } from '../world/edits';
import { TerrainCollider } from '../world/collider';
import type { ChunkEntry, StreamerEvents } from '../world/streamer';
import { SCATTER_STRIDE, type ScatterBatch } from '../world/scatterTypes';
import { Emitter } from '../core/events';
import { scatterChunk } from '../flora/scatter';
import { parseKind, type FloraSpecies } from '../flora/species';
import { FloraSystem } from '../flora/client/FloraSystem';
import { FloraLibrary } from '../flora/client/library';
import { StaticColliderStore } from '../client/staticColliders';
import { DebrisSystem } from '../client/debris';
import type { ClientContext, ClientEvents } from '../client/context';
import type { ObjectState } from '../shared/protocol';
import { patchSkyOcclusion } from '../render/skyOcclusion';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $('view');
const side = $('side');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const fog = new THREE.Fog(0x9fb4c8, 120, 900);
scene.fog = fog;
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x50402a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dd, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -90;
sun.shadow.camera.right = 90;
sun.shadow.camera.top = 90;
sun.shadow.camera.bottom = -90;
sun.shadow.camera.far = 600;
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
camera.position.set(0, 25, 60);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 5, 0);
controls.enableDamping = true;
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff5533 }));
scene.add(marker);
const labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
const labelRoot = document.createElement('div');
labelRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
view.appendChild(labelRoot);

const wind = { dir: new THREE.Vector2(1, 0.3).normalize(), strength: 0.4, time: 0 };
let world: { gen: WorldGenerator; lib: FloraLibrary } | null = null;
let content = new THREE.Group();
scene.add(content);
let flora: FloraSystem | null = null;
let fakeStreamerEvents: Emitter<StreamerEvents> | null = null;
let clientEvents: Emitter<ClientEvents> | null = null;
let entries: ChunkEntry[] = [];
const objectState = new Map<number | string, ObjectState>();
let serverTime = 100;
let objectsList: { id: number; sp: FloraSpecies; pos: THREE.Vector3 }[] = [];

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function clearContent() {
  if (flora) {
    for (const e of entries) fakeStreamerEvents?.emit('chunkDisposed', { entry: e });
    flora.dispose();
    flora = null;
  }
  scene.remove(content);
  content.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && m.geometry && m.userData.ownGeo) m.geometry.dispose();
  });
  content = new THREE.Group();
  scene.add(content);
  entries = [];
  objectsList = [];
  objectState.clear();
  for (const l of labels) l.el.remove();
  labels.length = 0;
}

function addLabel(text: string, pos: THREE.Vector3) {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = text;
  labelRoot.appendChild(el);
  labels.push({ el, pos: pos.clone() });
}

function getWorld(seed: number) {
  if (world && world.gen.seed === seed) return world;
  world?.lib.dispose();
  const gen = new WorldGenerator(seed);
  world = { gen, lib: new FloraLibrary(gen.profile, renderer) };
  const sel = $<HTMLSelectElement>('biome');
  sel.innerHTML = '';
  for (const b of [...SURFACE_BIOMES, Biome.Ocean, ...UNDERWORLD_BIOMES]) {
    const present = UNDERWORLD_BIOMES.includes(b) || b === Biome.Ocean || (gen.profile.biomes[b]?.weight ?? 0) > 0;
    if (!present) continue;
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = BIOMES[b].name;
    sel.appendChild(o);
  }
  return world;
}

const css = (c: readonly number[]) => `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;

function renderSide(lib: FloraLibrary, focus: (sp: FloraSpecies) => void) {
  side.innerHTML = '';
  const p = lib.profile;
  const head = document.createElement('div');
  head.innerHTML = `<h4>${p.name} — ${lib.cat.species.length} species</h4><div class="sub" style="padding:0 8px">weirdness ${p.weirdness.toFixed(2)}, life weirdness ${p.lifeWeirdness.toFixed(2)}, flora density ${p.floraDensity.toFixed(2)}</div>`;
  side.appendChild(head);
  for (const sp of lib.cat.species) {
    const d = document.createElement('div');
    d.className = 'card';
    const sw = [sp.bark, sp.leaf, sp.leaf2, sp.accent].map((c) => `<span class="sw" style="background:${css(c)}"></span>`).join('');
    const y = sp.yields.map((y) => y.item).join(', ');
    d.innerHTML = `<div class="nm">${sw} ${sp.name}</div><div class="sub">#${sp.idx} ${sp.form} · ${sp.cls} · tag ${sp.tag || '-'} · ${sp.size.toFixed(1)} m${sp.interact ? ' · ' + sp.interact + ' (' + sp.skill + ')' : ''}${sp.glow ? ' · glow' : ''}</div>${y ? `<div class="sub">→ ${y}</div>` : ''}`;
    d.onclick = () => focus(sp);
    side.appendChild(d);
  }
}

// ------------------------------------------------------------------ gallery

function gallery(seed: number, tier: number) {
  clearContent();
  const { gen, lib } = getWorld(seed);
  const rows: Record<string, FloraSpecies[]> = { tree: [], shrub: [], plant: [], rock: [], low: [], hang: [] };
  for (const sp of lib.cat.species) {
    if (sp.cls === 'tree') rows.tree.push(sp);
    else if (sp.cls === 'shrub' || sp.cls === 'debris') rows.shrub.push(sp);
    else if (sp.cls === 'rock') rows.rock.push(sp);
    else if (sp.cls === 'hang') rows.hang.push(sp);
    else if (sp.cls === 'cover' || sp.cls === 'water' || sp.cls === 'grass') rows.low.push(sp);
    else rows.plant.push(sp);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 400), new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...materialColors(MATERIALS[4], gen.profile).color, THREE.SRGBColorSpace), roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.ownGeo = true;
  content.add(ground);
  const positions = new Map<number, THREE.Vector3>();
  let z = -90;
  const order = ['tree', 'shrub', 'plant', 'low', 'rock', 'hang'];
  const perRow: Record<string, number> = { tree: 8, shrub: 12, plant: 14, low: 14, rock: 12, hang: 12 };
  for (const row of order) {
    const list = rows[row];
    if (!list.length) continue;
    // Items laid out in a grid, wrapping after perRow entries.
    const items: { sp: FloraSpecies; v: number; fg: ReturnType<FloraLibrary['geometry']> }[] = [];
    for (const sp of list) {
      const variants = sp.cls === 'tree' ? Math.min(2, sp.variants) : 1;
      for (let v = 0; v < variants; v++) {
        const fg = tier === 3 && sp.cls === 'tree' ? lib.impostor(sp.idx, v) : lib.geometry(sp.idx, v, 2, Math.min(2, tier));
        if (fg) items.push({ sp, v, fg });
      }
    }
    const n = perRow[row];
    for (let r0 = 0; r0 < items.length; r0 += n) {
      const chunk = items.slice(r0, r0 + n);
      const spans = chunk.map((it) => Math.max(1.6, it.fg.radius * 2.1));
      const total = spans.reduce((a, b) => a + b + 1.2, 0);
      let x = -total / 2;
      let rowDepth = 3;
      chunk.forEach(({ sp, v, fg }, k) => {
        const span = spans[k];
        x += span / 2;
        const mesh = new THREE.InstancedMesh(fg.geo, lib.materials[fg.kind], 1);
        mesh.customDepthMaterial = lib.depthMaterials[fg.kind];
        mesh.castShadow = fg.kind !== 'grass';
        mesh.receiveShadow = true;
        const hang = sp.cls === 'hang';
        const hy = Math.max(4, sp.size * 1.05);
        const m = new THREE.Matrix4();
        if (hang) m.compose(new THREE.Vector3(x, hy, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)), new THREE.Vector3(1, 1, 1));
        else m.makeTranslation(x, sp.water === 3 ? 0.05 : 0, z);
        mesh.setMatrixAt(0, m);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([0.5, 1, 0]), 3);
        content.add(mesh);
        if (hang) {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.4, 1.5), new THREE.MeshStandardMaterial({ color: 0x555555 }));
          beam.position.set(x, hy + 0.2, z);
          beam.userData.ownGeo = true;
          content.add(beam);
        }
        if (v === 0) {
          positions.set(sp.idx, new THREE.Vector3(x, 0, z));
          addLabel(sp.name, new THREE.Vector3(x, (hang ? hy : fg.height) + 0.6, z));
        }
        x += span / 2 + 1.2;
        rowDepth = Math.max(rowDepth, span);
      });
      z += rowDepth + 3;
    }
    z += 4;
  }
  camera.position.set(0, 30, 90);
  controls.target.set(0, 4, -10);
  renderSide(lib, (sp) => {
    const p = positions.get(sp.idx);
    if (!p) return;
    controls.target.set(p.x, Math.min(8, sp.size * 0.5), p.z);
    camera.position.set(p.x + sp.size * 1.2 + 3, sp.size * 0.8 + 2, p.z + sp.size * 1.8 + 4);
  });
  $('stats').textContent = `${lib.cat.species.length} species`;
}

// ------------------------------------------------------------------ patch (real scatter through FloraSystem)

function terrainMaterial(gen: WorldGenerator) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  patchSkyOcclusion(m, 'attribute');
  void gen;
  return m;
}

function findBiome(gen: WorldGenerator, b: Biome): [number, number] | null {
  const uw = UNDERWORLD_BIOMES.includes(b);
  for (let i = 0; i < 1500; i++) {
    const a = i * 2.39996, r = 200 + i * 37;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const c = gen.cachedColumn(x, z);
    if (uw) {
      if (c.uwBiome === b && c.uwCeil - c.uwFloor > 20) return [x, z];
    } else if (c.biome === b && c.blend < 0.25 && (b === Biome.Ocean ? c.height < -6 : c.land > 0.9 && c.height > 2)) return [x, z];
  }
  return null;
}

function patch(seed: number, biome: Biome, lod: number) {
  clearContent();
  const { gen, lib } = getWorld(seed);
  const loc = findBiome(gen, biome);
  if (!loc) {
    $('stats').textContent = 'biome not found near origin';
    return;
  }
  const uw = UNDERWORLD_BIOMES.includes(biome);
  const size = CHUNK_SIZE << lod;
  const R = lod === 0 ? 2 : 2;
  const ccx = Math.floor(loc[0] / size), ccz = Math.floor(loc[1] / size);
  const edits = new EditStore();
  const terrain = new TerrainCollider(gen, edits);
  const colliders = new StaticColliderStore();
  const debris = new DebrisSystem(terrain, gen, colliders);
  scene.add(debris.group);
  content.userData.debris = debris;
  fakeStreamerEvents = new Emitter<StreamerEvents>();
  clientEvents = new Emitter<ClientEvents>();
  const center = new THREE.Vector3(loc[0], 0, loc[1]);
  const c0 = gen.cachedColumn(loc[0], loc[1]);
  center.y = uw ? c0.uwFloor + 2 : Math.max(c0.height, 0);
  const ctx = {
    seed, gen, profile: gen.profile, core: { renderer, settings: { vegetation: 1 }, onContextRestored: () => () => undefined }, scene, camera,
    env: { wind, sun },
    streamer: { events: fakeStreamerEvents, opts: { splitFactor: lod === 0 ? 3 : 1.6 }, edits },
    terrain, colliders, debris,
    audio: { play() {}, footstep() {} },
    events: clientEvents,
    state: { objects: objectState, get serverTime() { return serverTime; } },
    playerPos: () => [controls.target.x, controls.target.y, controls.target.z],
  } as unknown as ClientContext;
  flora = new FloraSystem();
  flora.init(ctx);
  const tmat = terrainMaterial(gen);
  let nInst = 0, ms = 0;
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      const cx = ccx + dx, cz = ccz + dz;
      let minH = Infinity, maxH = -Infinity;
      for (let k = 0; k <= 2; k++)
        for (let i = 0; i <= 2; i++) {
          const c = gen.cachedColumn(cx * size + (i * size) / 2, cz * size + (k * size) / 2);
          const h = uw ? c.uwFloor : c.height;
          minH = Math.min(minH, h);
          maxH = Math.max(maxH, uw ? c.uwCeil : c.height + 30 + (c.pTop > -1e8 ? c.pTop - c.height : 0));
        }
      for (let cy = Math.floor((minH - 12) / size); cy <= Math.floor((maxH + 10) / size); cy++) {
        const ox = cx * size, oy = cy * size, oz = cz * size;
        const chunk = gen.fillChunk(ox, oy, oz, lod);
        if (chunk.uniform) continue;
        const t0 = performance.now();
        const batches: ScatterBatch[] = scatterChunk(gen, chunk, cx, cy, cz);
        ms += performance.now() - t0;
        const group = new THREE.Group();
        group.position.set(ox, oy, oz);
        group.updateMatrix();
        group.matrixAutoUpdate = false;
        content.add(group);
        const entry = { key: lod + ':' + cx + ':' + cy + ':' + cz, lod, cx, cy, cz, ox, oy, oz, size, state: 'ready', empty: false, group, mesh: null, lastWanted: 0, handle: null, version: 0, dirty: false, scattered: true, drawn: true } as unknown as ChunkEntry;
        entries.push(entry);
        const mesh = meshChunk(chunk, lod === 0 ? 0 : 1);
        if (mesh) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
          const nrm = new Float32Array(mesh.vertexCount * 3), col = new Float32Array(mesh.vertexCount * 3), sky = new Float32Array(mesh.vertexCount);
          for (let v = 0; v < mesh.vertexCount; v++) {
            nrm[v * 3] = mesh.normals[v * 4] / 127;
            nrm[v * 3 + 1] = mesh.normals[v * 4 + 1] / 127;
            nrm[v * 3 + 2] = mesh.normals[v * 4 + 2] / 127;
            sky[v] = mesh.normals[v * 4 + 3] / 127;
            const mid = mesh.mats[v * 4 + (v % 3)];
            const c = materialColors(MATERIALS[mid] ?? MATERIALS[2], gen.profile).color;
            const ao = mesh.mats[v * 4 + 3] / 255;
            const lc = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
            col[v * 3] = lc.r * (0.4 + ao * 0.6);
            col[v * 3 + 1] = lc.g * (0.4 + ao * 0.6);
            col[v * 3 + 2] = lc.b * (0.4 + ao * 0.6);
          }
          g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          g.setAttribute('skyVis', new THREE.BufferAttribute(sky, 1));
          const tm = new THREE.Mesh(g, tmat);
          tm.receiveShadow = true;
          tm.castShadow = true;
          tm.userData.ownGeo = true;
          group.add(tm);
        }
        if (lod === 0 && chunk.density) terrain.setGrid(ox, oy, oz, chunk.density, chunk.mats);
        for (const b of batches) {
          nInst += b.data.length / SCATTER_STRIDE;
          if (!b.ids) continue;
          const sp = lib.cat.species[parseKind(b.kind).sp];
          for (let i = 0; i < b.ids.length; i++) {
            const o = i * SCATTER_STRIDE;
            objectsList.push({ id: b.ids[i], sp, pos: new THREE.Vector3(ox + b.data[o], oy + b.data[o + 1], oz + b.data[o + 2]) });
          }
        }
        fakeStreamerEvents.emit('chunkScatter', { entry, batches });
      }
    }
  // Ocean: a simple water plane.
  if (!uw) {
    const water = new THREE.Mesh(new THREE.PlaneGeometry(size * 5, size * 5), new THREE.MeshStandardMaterial({ color: 0x2a5a78, transparent: true, opacity: 0.55, roughness: 0.1 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(ccx * size + size / 2, 0, ccz * size + size / 2);
    water.userData.ownGeo = true;
    content.add(water);
  }
  const span = size * (R * 2 + 1);
  controls.target.copy(center);
  camera.position.set(center.x + span * 0.18, center.y + Math.max(14, span * 0.12), center.z + span * 0.3);
  fog.near = uw ? 20 : span * 0.6;
  fog.far = uw ? 140 : span * 2.5;
  scene.background = new THREE.Color(uw ? 0x0a0c10 : 0x9fb4c8);
  fog.color.set(uw ? 0x0a0c10 : 0x9fb4c8);
  hemi.intensity = uw ? 0.05 : 0.9;
  $('stats').textContent = `${BIOMES[biome].name} @ ${loc.map((v) => v.toFixed(0)).join(',')} · ${entries.length} chunks · ${nInst} instances · ${objectsList.length} objects · scatter ${(ms / Math.max(1, entries.length)).toFixed(2)} ms/chunk · colliders ${colliders.query(center.x - 80, center.y - 80, center.z - 80, center.x + 80, center.y + 80, center.z + 80).length}`;
  renderSide(lib, (sp) => {
    const o = objectsList.find((x) => x.sp === sp);
    if (o) {
      controls.target.copy(o.pos);
      camera.position.set(o.pos.x + 8, o.pos.y + 6, o.pos.z + 10);
    }
  });
}

function sendStates(filter: (o: { sp: FloraSpecies }) => boolean, state: ObjectState['state'], frac: number) {
  if (!clientEvents) return;
  const t = controls.target;
  const near = objectsList.filter((o) => filter(o) && o.pos.distanceTo(t) < 45).slice(0, 25);
  const out: ObjectState[] = near.map((o) => {
    const dir = new THREE.Vector3(o.pos.x - camera.position.x, 0, o.pos.z - camera.position.z).normalize();
    return { id: o.id, hp: state === 'damaged' ? 50 : 0, maxHp: 100, state, dir: [dir.x, 0, dir.z], t: serverTime };
  });
  void frac;
  for (const s of out) objectState.set(s.id, s);
  clientEvents.emit('objects', out);
}

$('fell').onclick = () => sendStates((o) => o.sp.cls === 'tree', 'felled', 1);
$('smash').onclick = () => sendStates((o) => o.sp.cls === 'rock' && !o.sp.harvest, 'destroyed', 1);
$('pick').onclick = () => sendStates((o) => o.sp.harvest, 'destroyed', 1);
$('hit').onclick = () => sendStates((o) => o.sp.hp > 0, 'damaged', 0.5);

function generate() {
  const seed = parseInt($<HTMLInputElement>('seed').value, 10) || 1;
  const mode = $<HTMLSelectElement>('mode').value;
  getWorld(seed);
  if (mode === 'gallery') {
    fog.near = 200;
    fog.far = 1500;
    scene.background = new THREE.Color(0x9fb4c8);
    hemi.intensity = 0.9;
    gallery(seed, parseInt($<HTMLSelectElement>('tier').value, 10));
  } else {
    const b = parseInt($<HTMLSelectElement>('biome').value, 10) as Biome;
    patch(seed, Number.isNaN(b) ? Biome.Grassland : b, parseInt($<HTMLSelectElement>('plod').value, 10));
  }
}
$('go').onclick = generate;
$('rand').onclick = () => {
  $<HTMLInputElement>('seed').value = String((Math.random() * 1e9) | 0);
  world = null;
  generate();
};
$('seed').onchange = () => {
  world = null;
};
$('mode').onchange = generate;
$('tier').onchange = generate;

const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  step(Math.min(0.05, clock.getDelta()));
}
/** One simulation + render step (also callable manually: floraSandbox.step(dt), e.g. from tests in background tabs). */
function step(dt: number) {
  serverTime += dt;
  wind.time += dt;
  wind.strength = parseFloat($<HTMLInputElement>('wind').value);
  const tod = parseFloat($<HTMLInputElement>('tod').value);
  const ang = tod * Math.PI;
  sun.position.set(Math.cos(ang) * 200 + controls.target.x, Math.sin(ang) * 200 + 20 + controls.target.y, 80 + controls.target.z);
  sun.target.position.copy(controls.target);
  sun.intensity = 3.2 * Math.max(0, Math.sin(ang));
  controls.update();
  marker.position.copy(controls.target);
  if (flora) flora.update(dt, serverTime);
  else if (world) {
    // Gallery: drive the shared uniforms directly.
    const sh = world.lib.shared;
    sh.uTime.value = wind.time;
    sh.uWind.value.set(wind.dir.x, wind.dir.y, wind.strength);
    sh.uPlayer.value.set(controls.target.x, controls.target.y, controls.target.z, 1.1);
    tmpV.copy(sun.position).sub(sun.target.position).normalize().transformDirection(camera.matrixWorldInverse);
    sh.uSunView.value.copy(tmpV);
    sh.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity / 3.2);
    sh.uFade.value.set(1e5, 2e5);
  }
  const debris = content.userData.debris as DebrisSystem | undefined;
  debris?.update(dt);
  renderer.render(scene, camera);
  const show = $<HTMLInputElement>('labels').checked;
  const w = view.clientWidth, h = view.clientHeight;
  for (const l of labels) {
    tmpV.copy(l.pos).project(camera);
    const vis = show && tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1 && l.pos.distanceTo(camera.position) < 120;
    l.el.style.display = vis ? 'block' : 'none';
    if (vis) {
      l.el.style.left = ((tmpV.x * 0.5 + 0.5) * w).toFixed(0) + 'px';
      l.el.style.top = ((-tmpV.y * 0.5 + 0.5) * h).toFixed(0) + 'px';
    }
  }
}
// URL parameters (?seed=&mode=patch&biome=&lod=&tier=) survive dev-server reloads.
{
  const q = new URLSearchParams(location.search);
  if (q.get('seed')) $<HTMLInputElement>('seed').value = q.get('seed')!;
  getWorld(parseInt($<HTMLInputElement>('seed').value, 10) || 1);
  if (q.get('mode')) $<HTMLSelectElement>('mode').value = q.get('mode')!;
  if (q.get('biome')) $<HTMLSelectElement>('biome').value = q.get('biome')!;
  if (q.get('lod')) $<HTMLSelectElement>('plod').value = q.get('lod')!;
  if (q.get('tier')) $<HTMLSelectElement>('tier').value = q.get('tier')!;
}
generate();
frame();
(window as unknown as Record<string, unknown>).floraSandbox = { scene, camera, controls, renderer, step: (n: number, dt = 1 / 30) => { for (let i = 0; i < n; i++) step(dt); }, get world() { return world; }, get flora() { return flora; } };
