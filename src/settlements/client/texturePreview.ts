/**
 * Texture preview for the settlements sandbox (`?view=textures`): every
 * surface layer on a slowly tilting tile, lit by an orbiting sun so normal
 * maps read, using the real settlement material. Press N to toggle night
 * (window/glow emission), +/- to change UV repeats.
 */
import * as THREE from 'three';
import { createSettlementMaterial } from './material';
import { SURF_NAMES, textureGenMs } from './textures';
import { SURF_COUNT, Surf } from '../build/kit';

function tileGeometry(layer: number, repeat: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, 1);
  const n = g.attributes.position.count;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) uv.setXY(i, uv.getX(i) * repeat, uv.getY(i) * repeat);
  const col = new Float32Array(n * 3).fill(1);
  const lay = new Float32Array(n).fill(layer);
  const emit = new Float32Array(n * 4);
  const sky = new Float32Array(n).fill(1);
  const em: [number, number, number, number] | null =
    layer === Surf.Window ? [2.2, 1.3, 0.55, 1] : layer === Surf.Glow ? [0.25, 0.5, 0.8, 0] : layer === Surf.Fire ? [1.2, 0.5, 0.12, 0] : null;
  if (em) for (let i = 0; i < n; i++) emit.set(em, i * 4);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aLayer', new THREE.BufferAttribute(lay, 1));
  g.setAttribute('aEmit', new THREE.BufferAttribute(emit, 4));
  g.setAttribute('skyVis', new THREE.BufferAttribute(sky, 1));
  return g;
}

export function showTexturePreview(root: HTMLElement): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(root.clientWidth, root.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  root.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15191e);
  const camera = new THREE.PerspectiveCamera(30, root.clientWidth / root.clientHeight, 0.1, 100);
  const sun = new THREE.DirectionalLight(0xfff2dd, 3);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xb8d0ff, 0x403830, 0.7));
  const { material, uniforms } = createSettlementMaterial();
  const cols = 7, rows = Math.ceil(SURF_COUNT / cols);
  const tiles: THREE.Mesh[] = [];
  let repeat = 1;
  const labels: HTMLDivElement[] = [];
  for (let i = 0; i < SURF_COUNT; i++) {
    const m = new THREE.Mesh(tileGeometry(i, repeat), material);
    const cx = i % cols, cy = Math.floor(i / cols);
    m.position.set((cx - (cols - 1) / 2) * 1.15, ((rows - 1) / 2 - cy) * 1.25, 0);
    scene.add(m);
    tiles.push(m);
    const l = document.createElement('div');
    l.textContent = `${i} ${SURF_NAMES[i]}`;
    l.style.cssText = 'position:fixed;color:#e8e2d0;font:12px Inter,sans-serif;text-shadow:0 0 3px #000;pointer-events:none;transform:translate(-50%,0)';
    document.body.appendChild(l);
    labels.push(l);
  }
  camera.position.set(0, 0, 13.2);
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000';
  document.body.appendChild(hud);
  let night = false;
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyN') night = !night;
    if (e.key === '+' || e.key === '-') {
      repeat = Math.max(1, Math.min(4, repeat + (e.key === '+' ? 1 : -1)));
      tiles.forEach((t, i) => {
        t.geometry.dispose();
        t.geometry = tileGeometry(i, repeat);
      });
    }
  });
  addEventListener('resize', () => {
    camera.aspect = root.clientWidth / root.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(root.clientWidth, root.clientHeight);
  });
  const v = new THREE.Vector3();
  const t0 = performance.now();
  const loop = () => {
    const t = (performance.now() - t0) / 1000;
    sun.position.set(Math.cos(t * 0.5) * 5, Math.sin(t * 0.5) * 5, 4);
    uniforms.uNight.value = night ? 1 : 0;
    uniforms.uTime.value = t;
    sun.intensity = night ? 0.15 : 3;
    tiles.forEach((m, i) => {
      m.rotation.x = Math.sin(t * 0.4 + i) * 0.25;
      m.rotation.y = Math.cos(t * 0.33 + i * 0.7) * 0.25;
      v.copy(m.position);
      v.y -= 0.58;
      v.project(camera);
      labels[i].style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      labels[i].style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    });
    hud.textContent = `settlement textures: ${SURF_COUNT} layers, generated in ${textureGenMs().toFixed(0)} ms — N: night, +/-: repeat (${repeat})`;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();
}
