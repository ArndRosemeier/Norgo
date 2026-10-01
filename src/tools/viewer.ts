/**
 * Free-fly terrain viewer for world-generation work (`/?viewer&seed=...`).
 * WASD/QE fly, Shift fast, T advances time, click to capture the mouse.
 */
import * as THREE from 'three';
import { RenderCore } from '../render/renderCore';
import { Environment } from '../render/environment';
import { WorldGenerator } from '../world/generator';
import { TerrainStreamer } from '../world/streamer';
import { createTerrainMaterial, createTerrainTextures } from '../world/terrainMaterial';
import { synthesizeInWorker } from '../world/textureLoader';
import { parseSeed } from '../core/rng';

const params = new URLSearchParams(location.search);
const seed = parseSeed(params.get('seed') ?? '1234');
const app = document.getElementById('app')!;
const core = new RenderCore(app);
const gen = new WorldGenerator(seed);
const env = new Environment(core.scene, gen);
env.timeOfDay = Number(params.get('t') ?? 0.36);
const tex = createTerrainTextures(await synthesizeInWorker(seed));
const mat = createTerrainMaterial(tex);
const streamer = new TerrainStreamer(gen, mat);
core.scene.add(streamer.root);
await streamer.whenReady();
const spawn = gen.findSpawn();
const cam = core.camera;
const px = params.get('x'), pz = params.get('z');
cam.position.set(px ? Number(px) : spawn[0], spawn[1] + Number(params.get('h') ?? 30), pz ? Number(pz) : spawn[2]);
if (params.get('y')) cam.position.y = Number(params.get('y'));
let yaw = Number(params.get('yaw') ?? 0), pitch = Number(params.get('pitch') ?? -0.2);
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
core.canvas.addEventListener('click', () => core.canvas.requestPointerLock());
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement) {
    yaw -= e.movementX * 0.002;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.002));
  }
});
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000;white-space:pre;z-index:50';
document.body.appendChild(hud);
let last = performance.now(), t = 0;
(window as unknown as Record<string, unknown>).dbg = { core, gen, streamer, env, cam };
function loop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  t += dt;
  const sp = keys.has('ShiftLeft') ? 200 : 25;
  const fwd = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  if (keys.has('KeyW')) cam.position.addScaledVector(fwd, sp * dt);
  if (keys.has('KeyS')) cam.position.addScaledVector(fwd, -sp * dt);
  if (keys.has('KeyD')) cam.position.addScaledVector(right, sp * dt);
  if (keys.has('KeyA')) cam.position.addScaledVector(right, -sp * dt);
  if (keys.has('KeyE')) cam.position.y += sp * dt;
  if (keys.has('KeyQ')) cam.position.y -= sp * dt;
  if (keys.has('KeyT')) env.timeOfDay = (env.timeOfDay + dt * 0.05) % 1;
  cam.rotation.set(pitch, yaw, 0, 'YXZ');
  cam.updateMatrixWorld();
  streamer.update(cam);
  env.update(cam, dt, t);
  core.render();
  const s = streamer.stats;
  hud.textContent = `${gen.profile.name} seed ${seed}  pos ${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)}\nbiome ${env.biomeName(cam.position.x, cam.position.y, cam.position.z)}  g=${gen.gravityAt(cam.position.x, cam.position.y, cam.position.z).toFixed(2)}\nentries ${s.entries} drawn ${s.drawn} leaves ${s.leaves} pending ${s.pending} job ${streamer.pool.avgMs.toFixed(1)}ms\ncalls ${core.renderer.info.render.calls}`;
  requestAnimationFrame(loop);
}
loop();
