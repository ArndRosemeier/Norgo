/**
 * Settlements sandbox: settlements of every culture and size (plus one of each
 * POI kind) laid out on a flat test ground, rendered by the real
 * SettlementRenderer with a free camera.
 *
 * Controls: click = mouse look, WASD/QE fly (Shift fast), 1-9/0 jump to a
 * settlement, P = next POI, T = toggle day/night, F = interact (doors),
 * X = destroy the piece under the crosshair (with server-like collapse),
 * G = toggle far-LOD-only view. `?view=textures` shows the texture layers.
 * `window.sb` exposes the scene for automation (sb.goto(i), sb.look(...)).
 */
import * as THREE from 'three';
import { RenderCore } from '../render/renderCore';
import { Emitter } from '../core/events';
import { Biome } from '../world/biomes';
import type { SiteInfo, PoiInfo, PoiKind, SiteSize } from '../world/sites';
import type { ClientContext, ClientEvents, StaticCollider } from '../client/context';
import { StaticColliderStore } from '../client/staticColliders';
import type { ObjectState } from '../shared/protocol';
import type { Vec3 } from '../shared/types';
import { SettlementRenderer } from '../settlements/client/SettlementRenderer';
import type { SettlementWorld } from '../settlements/cache';
import { parsePieceId, unsupported } from '../settlements/pieces';
import { hashString } from '../core/rng';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;

if (params.get('view') === 'textures') {
  const { showTexturePreview } = await import('../settlements/client/texturePreview');
  showTexturePreview(app);
} else {
  start();
}

function start() {
  const GROUND = 10;
  const SPACING = 560;
  const defs: [string, string | null, SiteSize, boolean, Biome][] = [
    ['human', null, 'town', false, Biome.Grassland],
    ['dwarf', null, 'village', false, Biome.Tundra],
    ['elf', null, 'village', false, Biome.TemperateForest],
    ['orc', null, 'village', true, Biome.Badlands],
    ['halfling', null, 'village', false, Biome.Grassland],
    ['goblin', null, 'village', false, Biome.Swamp],
    ['sylvan', null, 'village', false, Biome.FungalGrove],
    ['drakeborn', null, 'village', false, Biome.Volcanic],
    ['umbral', null, 'village', false, Biome.CrystalWastes],
    ['giantkin', null, 'village', false, Biome.Glacier],
    ['human', 'dwarf', 'city', true, Biome.Grassland],
    ['human', null, 'hamlet', false, Biome.Grassland],
    ['elf', 'sylvan', 'town', true, Biome.TemperateForest],
  ];
  const sites: SiteInfo[] = defs.map(([race, race2, size, walled, biome], i) => {
    const cx = (i % 5) * 2, cz = Math.floor(i / 5) * 2;
    return {
      id: `S${cx}_${cz}`, cellX: cx, cellZ: cz, x: (i % 5) * SPACING, z: Math.floor(i / 5) * SPACING, plateau: GROUND,
      radius: { hamlet: 42, village: 70, town: 105, city: 150 }[size], size, race, race2, biome,
      name: `${race}${race2 ? '-' + race2 : ''} ${size}`, seed: hashString('sandbox' + i), links: [], walled,
    };
  });
  const kinds: PoiKind[] = ['ruin', 'shrine', 'camp', 'lair', 'grove', 'monolith', 'tower', 'battlefield', 'crashsite', 'well', 'wayshrine', 'obelisk'];
  const pois: PoiInfo[] = kinds.map((kind, i) => ({
    id: `P${i * 3}_${-4}`, kind, x: i * 90, z: -420, y: GROUND, seed: hashString('poi' + i), biome: Biome.Grassland,
    radius: kind === 'ruin' || kind === 'battlefield' ? 28 : 14,
  }));
  const world: SettlementWorld = {
    terrain: { heightAt: () => GROUND, roadAt: () => 0, roadsNear: () => [], roadsOfCell: () => [] },
    siteInCell: (cx, cz) => sites.find((s) => s.cellX === cx && s.cellZ === cz) ?? null,
    poiInCell: (cx, cz) => pois.find((p) => p.id === `P${cx}_${cz}`) ?? null,
    sitesNear: (x, z, r) => sites.filter((s) => Math.hypot(s.x - x, s.z - z) < r + 400),
    poisNear: (x, z, r) => pois.filter((p) => Math.hypot(p.x - x, p.z - z) < r + p.radius),
  };

  const core = new RenderCore(app);
  const scene = core.scene;
  const camera = core.camera;
  scene.background = new THREE.Color(0x9cc4e8);
  scene.fog = new THREE.FogExp2(0xa8c4dc, 0.0007);
  const sun = new THREE.DirectionalLight(0xfff0dd, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = sc.bottom = -90;
  sc.right = sc.top = 90;
  sc.near = 1;
  sc.far = 500;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a5040, 0.7);
  scene.add(hemi);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: 0x4f6a34, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(1200, GROUND, 400);
  ground.receiveShadow = true;
  scene.add(ground);

  // Minimal client context.
  const events = new Emitter<ClientEvents>();
  const colliders = new StaticColliderStore();
  const objects = new Map<number | string, ObjectState>();
  const debrisList: { m: THREE.Object3D; v: THREE.Vector3; w: THREE.Vector3; t: number }[] = [];
  let serverTime = 0;
  const env = { sunDir: new THREE.Vector3(0.4, 0.8, 0.3).normalize(), wind: { dir: new THREE.Vector2(1, 0.3).normalize(), strength: 0.35, time: 0 } };
  const ctx = {
    seed: 1, scene, camera, core, env, colliders, events,
    state: { objects, get serverTime() { return serverTime; }, entities: new Map(), timeOfDay: 0.3, day: 0 },
    debris: {
      spawn() {},
      shatter(mesh: THREE.Mesh, origin: Vec3, force: number) {
        scene.add(mesh);
        const v = new THREE.Vector3(mesh.position.x - origin[0], mesh.position.y - origin[1] + 1, mesh.position.z - origin[2]).normalize().multiplyScalar(force);
        debrisList.push({ m: mesh, v, w: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3), t: 0 });
      },
    },
    audio: { play() {}, footstep() {} },
    send() {},
    playerPos: () => [camera.position.x, camera.position.y, camera.position.z] as Vec3,
  } as unknown as ClientContext;

  const renderer = new SettlementRenderer({ world });
  renderer.init(ctx);

  // Camera.
  let yaw = -2.4, pitch = -0.32;
  let target = 0;
  const goto = (i: number) => {
    target = i;
    const s = sites[i];
    camera.position.set(s.x + s.radius * 0.9, GROUND + 35, s.z + s.radius * 0.9);
    yaw = Math.atan2(camera.position.x - s.x, camera.position.z - s.z);
    pitch = -0.38;
  };
  let poiI = -1;
  const gotoPoi = (i: number) => {
    const p = pois[i];
    camera.position.set(p.x + 18, GROUND + 9, p.z + 18);
    yaw = Math.PI / 4;
    pitch = -0.3;
  };
  goto(Number(params.get('site') ?? 0));
  const keys = new Set<string>();
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (/^Digit\d$/.test(e.code)) goto((Number(e.code.slice(5)) + 9) % 10);
    if (e.code === 'Minus') goto(10);
    if (e.code === 'Equal') goto(11);
    if (e.code === 'Backspace') goto(12);
    if (e.code === 'KeyP') gotoPoi((poiI = (poiI + 1) % pois.length));
    if (e.code === 'KeyT') night = !night;
    if (e.code === 'KeyF') interact();
    if (e.code === 'KeyX') destroyAim();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  core.canvas.addEventListener('click', () => core.canvas.requestPointerLock());
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement) {
      yaw -= e.movementX * 0.0022;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.0022));
    }
  });

  let night = params.get('night') === '1';
  const aimDir = () => new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const aim = (): StaticCollider | null => {
    const d = aimDir();
    const hit = colliders.raycast([camera.position.x, camera.position.y, camera.position.z], [d.x, d.y, d.z], 60);
    return hit?.collider ?? null;
  };
  function interact() {
    const c = aim();
    if (c) events.emit('uiOpen', { panel: 'interactObject', data: c });
  }
  /** Mimic the server: destroy the aimed piece and cascade unsupported pieces. */
  function destroyAim() {
    const c = aim();
    if (!c || typeof c.objectId !== 'string') return;
    destroy(c.objectId, 0);
  }
  function destroy(id: string, delay: number) {
    setTimeout(() => {
      if (objects.get(id)?.state === 'destroyed') return;
      const st: ObjectState = { id, hp: 0, maxHp: 100, state: 'destroyed', t: serverTime };
      objects.set(id, st);
      events.emit('objects', [st]);
      const ref = parsePieceId(id);
      const unit = ref && renderer.cache.unit(ref.building);
      if (!ref || !unit) return;
      const fall = unsupported(unit.blueprint(), (i) => objects.get(`${unit.id}:${i}`)?.state === 'destroyed', [ref.piece]);
      fall.forEach((i, k) => destroy(`${unit.id}:${i}`, 250 + k * 120));
    }, delay);
  }

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:10px;top:10px;color:#fff;font:12px/1.4 monospace;text-shadow:0 0 3px #000;white-space:pre;pointer-events:none';
  document.body.appendChild(hud);
  const cross = document.createElement('div');
  cross.style.cssText = 'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px;border-radius:50%;background:#fff8;pointer-events:none';
  document.body.appendChild(cross);

  let last = performance.now();
  let tod = night ? 0.95 : 0.36;
  (window as unknown as { sb: unknown }).sb = {
    renderer, camera, sites, pois, goto, gotoPoi, core, colliders, destroy,
    look(x: number, y: number, z: number, ya: number, pi: number) {
      camera.position.set(x, y, z);
      yaw = ya;
      pitch = pi;
    },
    setNight(v: boolean) {
      night = v;
    },
    /** Run n frames synchronously (dt each). */
    step(n = 60, dt = 1 / 30) {
      for (let i = 0; i < n; i++) tick(dt);
    },
  };
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
    requestAnimationFrame(frame);
  }
  /** One simulation + render step (also driven by sb.step for background automation). */
  function tick(dt: number) {
    serverTime += dt;
    const sp = keys.has('ShiftLeft') ? 120 : 18;
    const f = aimDir();
    const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (keys.has('KeyW')) camera.position.addScaledVector(f, sp * dt);
    if (keys.has('KeyS')) camera.position.addScaledVector(f, -sp * dt);
    if (keys.has('KeyD')) camera.position.addScaledVector(r, sp * dt);
    if (keys.has('KeyA')) camera.position.addScaledVector(r, -sp * dt);
    if (keys.has('KeyE')) camera.position.y += sp * dt;
    if (keys.has('KeyQ')) camera.position.y -= sp * dt;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    // Day/night.
    tod += ((night ? 0.97 : 0.36) - tod) * Math.min(1, dt * 2);
    const ang = (tod - 0.25) * Math.PI * 2;
    env.sunDir.set(Math.cos(ang) * 0.6, Math.sin(ang), 0.35).normalize();
    const day = THREE.MathUtils.smoothstep(env.sunDir.y, -0.1, 0.2);
    sun.intensity = 3 * day + 0.25;
    sun.color.setRGB(day > 0.2 ? 1 : 0.5, day > 0.2 ? 0.95 : 0.58, day > 0.2 ? 0.88 : 0.85);
    hemi.intensity = 0.15 + 0.6 * day;
    (scene.background as THREE.Color).setRGB(0.02 + 0.6 * day, 0.03 + 0.74 * day, 0.07 + 0.83 * day);
    (scene.fog as THREE.FogExp2).color.copy(scene.background as THREE.Color);
    const sd = day > 0.05 ? env.sunDir : new THREE.Vector3(-0.3, 0.8, 0.2).normalize();
    sun.position.copy(camera.position).addScaledVector(sd, 200);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    renderer.update(dt, serverTime);
    for (let i = debrisList.length - 1; i >= 0; i--) {
      const d = debrisList[i];
      d.t += dt;
      d.v.y -= 9.8 * dt;
      d.m.position.addScaledVector(d.v, dt);
      if (d.m.position.y < GROUND) {
        d.m.position.y = GROUND;
        d.v.multiplyScalar(0.3);
        d.v.y = Math.abs(d.v.y) * 0.3;
      }
      d.m.rotation.x += d.w.x * dt;
      d.m.rotation.z += d.w.z * dt;
      if (d.t > 6) {
        scene.remove(d.m);
        (d.m as THREE.Mesh).geometry.dispose();
        debrisList.splice(i, 1);
      }
    }
    core.render();
    const s = sites[target];
    const st = renderer.stats;
    const a = aim();
    hud.textContent =
      `${s.name} (${s.race}${s.race2 ? '+' + s.race2 : ''}) — 1-0,-,=,⌫ sites · P pois · T night · F interact · X destroy\n` +
      `places ${st.places} tiles ${st.tiles} tris ${(st.triangles / 1000).toFixed(0)}k colliders ${st.colliders} calls ${core.renderer.info.render.calls}\n` +
      `pos ${camera.position.x.toFixed(0)},${camera.position.y.toFixed(0)},${camera.position.z.toFixed(0)}  ${a ? `${a.objectId} ${a.interact ?? ''}` : ''}`;
  }
  frame();
}
