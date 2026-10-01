/**
 * Item icons for the UI: each item's real procedural mesh rendered offscreen
 * (own small WebGL renderer, studio lighting + room environment for metal
 * reflections), auto-framed, long items laid diagonally, and cached as PNG
 * data URLs keyed by (def, visual, size).
 *
 * `itemIconUrl` is synchronous: it renders immediately while the per-frame
 * budget allows (~12 ms), otherwise returns a lightweight SVG placeholder and
 * queues the render; `onIconReady` / `whenIconReady` notify when the real
 * icon exists so UIs can swap the <img> src. A window event
 * `norgo:itemIcon` ({ detail: { key, url } }) is dispatched as well.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ItemInstance, ItemVisual } from '../types';
import { buildItemObject } from './buildItem';
import { disposeItemObject } from './materials';
import { itemDef } from '../data/catalog';

type IconItem = Pick<ItemInstance, 'defId' | 'visual'>;

const cache = new Map<string, string>();
const placeholders = new Map<string, string>();
const queue = new Map<string, { item: IconItem; size: number }>();
const listeners = new Map<string, ((url: string) => void)[]>();
const BUDGET_MS = 12;
let budgetResetScheduled = false;
let frameSpent = 0;
let pumpScheduled = false;

// ------------------------------------------------------------------ studio

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let out2d: HTMLCanvasElement;

function studio() {
  if (renderer) return renderer;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.75;
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(2, 3, 4);
  const rim = new THREE.DirectionalLight(0xa0c0ff, 1.6);
  rim.position.set(-3, 2, -3);
  scene.add(key, rim, new THREE.HemisphereLight(0xdde8ff, 0x302820, 0.7));
  camera = new THREE.PerspectiveCamera(24, 1, 0.01, 50);
  out2d = document.createElement('canvas');
  return renderer;
}

const box = new THREE.Box3();
const sphere = new THREE.Sphere();
const dir = new THREE.Vector3(0.18, 0.32, 1).normalize();

function render(item: IconItem, size: number): string {
  const r = studio();
  const obj = buildItemObject(item.defId, item.visual);
  // Long held items (blades, hafts, staves) read best on the diagonal.
  box.setFromObject(obj);
  const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y, sz = box.max.z - box.min.z;
  const pivot = new THREE.Group();
  const turn = new THREE.Group();
  turn.add(obj);
  pivot.add(turn);
  // Held items put their edge on +Z; turn the flat of the blade toward the camera,
  // then lay it on the diagonal.
  if (sy > 1.8 * Math.max(sx, sz)) {
    turn.rotation.y = -Math.PI / 2 + 0.25;
    pivot.rotation.z = -Math.PI / 4;
  }
  else if (sx > 1.8 * Math.max(sy, sz)) pivot.rotation.z = Math.PI / 6;
  else pivot.rotation.y = 0.35;
  scene.add(pivot);
  pivot.updateMatrixWorld(true);
  box.setFromObject(pivot);
  box.getBoundingSphere(sphere);
  // Frame by the box's screen-plane extent (tight for thin diagonal blades), not the sphere.
  const fov = (camera.fov * Math.PI) / 180;
  const ex = box.max.x - box.min.x, ey = box.max.y - box.min.y, ez = box.max.z - box.min.z;
  const dist = (Math.max(ex, ey) * 0.56) / Math.tan(fov / 2) + ez * 0.5;
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.near = Math.max(0.005, dist - sphere.radius * 2);
  camera.far = dist + sphere.radius * 2;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  const px = Math.min(256, size * 2);
  r.setSize(px, px, false);
  r.render(scene, camera);
  out2d.width = out2d.height = size;
  const g = out2d.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  g.imageSmoothingQuality = 'high';
  g.drawImage(r.domElement, 0, 0, px, px, 0, 0, size, size);
  const url = out2d.toDataURL('image/png');
  scene.remove(pivot);
  disposeItemObject(obj);
  return url;
}

// ------------------------------------------------------------------ keys & placeholders

function visKey(v: ItemVisual): string {
  const c = (a: number[]) => a.map((x) => Math.round(x * 255).toString(16)).join('');
  return `${v.shape}|${v.seed}|${c(v.primary)}|${c(v.secondary)}|${c(v.accent)}|${v.material}|${Math.round(v.glow * 20)}|${c(v.glowColor)}|${Math.round(v.wear * 10)}|${v.style}`;
}

export function iconKey(item: IconItem, size = 64): string {
  return `${item.defId}#${visKey(item.visual)}#${size}`;
}

const CAT_GLYPH: Record<string, string> = {
  weapon: '⚔', armor: '⛨', clothing: '👕', jewelry: '💍', tool: '⚒', consumable: '⚗', material: '◆', reagent: '✿', food: '🍞', book: '📖', key: '🗝', quest: '★', trinket: '✦', ammo: '➶', light: '🔥',
};

/** Cheap SVG placeholder: item colour disc + category glyph. */
function placeholder(item: IconItem, size: number): string {
  const cat = itemDef(item.defId)?.category ?? 'material';
  const k = cat + size + item.visual.primary.join(',');
  let p = placeholders.get(k);
  if (!p) {
    const [r, g, b] = item.visual.primary.map((x) => Math.round(Math.pow(x, 1 / 1.2) * 255));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><circle cx="32" cy="32" r="22" fill="rgb(${r},${g},${b})" opacity="0.35"/><text x="32" y="41" font-size="24" text-anchor="middle" fill="#ddd" opacity="0.8">${CAT_GLYPH[cat] ?? '◆'}</text></svg>`;
    p = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    placeholders.set(k, p);
  }
  return p;
}

// ------------------------------------------------------------------ public API

/** Returns a data URL of a rendered icon (or a placeholder while it is queued). */
export function itemIconUrl(item: IconItem, size = 64): string {
  if (!item?.visual) return '';
  const key = iconKey(item, size);
  const hit = cache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return '';
  // The budget resets on the next animation frame, not by wall time, so one
  // synchronous loop over a whole inventory cannot render everything at once.
  if (!budgetResetScheduled) {
    budgetResetScheduled = true;
    nextFrame(() => {
      budgetResetScheduled = false;
      frameSpent = 0;
    });
  }
  if (frameSpent < BUDGET_MS) {
    const t0 = performance.now();
    const url = safeRender(item, size);
    frameSpent += performance.now() - t0;
    cache.set(key, url);
    return url;
  }
  queue.set(key, { item, size });
  schedulePump();
  return placeholder(item, size);
}

/** Resolves with the final icon URL (renders if needed). */
export function whenIconReady(item: IconItem, size = 64): Promise<string> {
  const key = iconKey(item, size);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((res) => {
    onIconReady(key, res);
    queue.set(key, { item, size });
    schedulePump();
  });
}

/** Register a one-shot callback for when the icon with `key` is rendered. */
export function onIconReady(key: string, cb: (url: string) => void) {
  const hit = cache.get(key);
  if (hit) return cb(hit);
  const arr = listeners.get(key) ?? [];
  arr.push(cb);
  listeners.set(key, arr);
}

/** Drop cached icons (e.g. after a graphics context loss). */
export function clearIconCache() {
  cache.clear();
}

function safeRender(item: IconItem, size: number): string {
  try {
    return render(item, size);
  } catch (err) {
    console.warn('[items] icon render failed', item.defId, err);
    return placeholder(item, size);
  }
}

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  nextFrame(pump);
}

/** rAF when visible; timers when the page is hidden (rAF is paused there). */
function nextFrame(cb: () => void) {
  if (document.visibilityState === 'hidden') setTimeout(cb, 16);
  else requestAnimationFrame(cb);
}

function pump() {
  pumpScheduled = false;
  const t0 = performance.now();
  for (const [key, job] of queue) {
    if (performance.now() - t0 > BUDGET_MS) break;
    queue.delete(key);
    const url = safeRender(job.item, job.size);
    cache.set(key, url);
    const ls = listeners.get(key);
    listeners.delete(key);
    ls?.forEach((cb) => cb(url));
    window.dispatchEvent(new CustomEvent('norgo:itemIcon', { detail: { key, url } }));
  }
  if (queue.size) schedulePump();
}
