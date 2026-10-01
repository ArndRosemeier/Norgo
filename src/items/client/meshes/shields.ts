/**
 * Shields: buckler, round, kite and tower — planks, boss, rim, rivets,
 * straps, and painted heraldry on a per-item CanvasTexture (division +
 * charge chosen from the seed and the culture motif, worn and chipped by
 * `wear`). Built directly in item space: painted face toward +Z, origin at
 * the grip/strap centre behind the shield, +Y up.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { styleOf } from '../../data/styles';
import { mesh, lathe, extrudeOutline, type V2 } from './util';
import { deform, mergeAll, sweep } from './weapons_parts';

type RGB = [number, number, number];
const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const shade = (c: RGB, k: number): RGB => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

type Ctx2D = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; g: Ctx2D } {
  const canvas = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })) as HTMLCanvasElement;
  return { canvas, g: canvas.getContext('2d') as Ctx2D };
}

/** Heraldic charge drawn centred at (0,0) with unit size s. */
function charge(g: Ctx2D, kind: string, s: number, rng: Rng) {
  g.beginPath();
  switch (kind) {
    case 'cross': {
      const a = s * 0.18, b = s * 0.75;
      g.moveTo(-a, -b); g.lineTo(a, -b); g.lineTo(a * 0.6, -a); g.lineTo(b, -a); g.lineTo(b, a); g.lineTo(a * 0.6, a);
      g.lineTo(a, b); g.lineTo(-a, b); g.lineTo(-a * 0.6, a); g.lineTo(-b, a); g.lineTo(-b, -a); g.lineTo(-a * 0.6, -a); g.closePath();
      g.fill();
      return;
    }
    case 'star': {
      const n = rng.pick([5, 6, 8]);
      for (let i = 0; i < n * 2; i++) {
        const r = i % 2 ? s * 0.32 : s * 0.8, a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath(); g.fill();
      return;
    }
    case 'sun': {
      g.arc(0, 0, s * 0.35, 0, Math.PI * 2); g.fill();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.beginPath();
        g.moveTo(Math.cos(a - 0.12) * s * 0.42, Math.sin(a - 0.12) * s * 0.42);
        g.lineTo(Math.cos(a) * s * (i % 2 ? 0.7 : 0.85), Math.sin(a) * s * (i % 2 ? 0.7 : 0.85));
        g.lineTo(Math.cos(a + 0.12) * s * 0.42, Math.sin(a + 0.12) * s * 0.42);
        g.fill();
      }
      return;
    }
    case 'crescent':
      g.arc(0, 0, s * 0.7, 0, Math.PI * 2);
      g.arc(s * 0.25, -s * 0.18, s * 0.58, 0, Math.PI * 2, true);
      g.fill('evenodd');
      return;
    case 'leaf':
      g.moveTo(0, s * 0.85);
      g.quadraticCurveTo(s * 0.75, 0, 0, -s * 0.85);
      g.quadraticCurveTo(-s * 0.75, 0, 0, s * 0.85);
      g.fill();
      g.save(); g.globalCompositeOperation = 'destination-out'; g.lineWidth = s * 0.05;
      g.beginPath(); g.moveTo(0, s * 0.8); g.lineTo(0, -s * 0.7);
      for (let i = -2; i <= 2; i++) { g.moveTo(0, i * s * 0.25); g.lineTo(s * 0.3, i * s * 0.25 - s * 0.2); g.moveTo(0, i * s * 0.25); g.lineTo(-s * 0.3, i * s * 0.25 - s * 0.2); }
      g.stroke(); g.restore();
      return;
    case 'tree':
      g.rect(-s * 0.08, 0, s * 0.16, s * 0.8);
      g.fill();
      g.beginPath(); g.arc(0, -s * 0.2, s * 0.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(-s * 0.35, s * 0.1, s * 0.3, 0, Math.PI * 2); g.arc(s * 0.35, s * 0.1, s * 0.3, 0, Math.PI * 2); g.fill();
      return;
    case 'hammer':
      g.rect(-s * 0.08, -s * 0.3, s * 0.16, s * 1.05);
      g.rect(-s * 0.5, -s * 0.75, s * 1.0, s * 0.45);
      g.fill();
      return;
    case 'anvil':
      g.moveTo(-s * 0.85, -s * 0.35); g.lineTo(s * 0.55, -s * 0.35); g.quadraticCurveTo(s * 0.8, -s * 0.3, s * 0.85, -s * 0.15);
      g.lineTo(s * 0.3, -s * 0.05); g.lineTo(s * 0.2, s * 0.4); g.lineTo(s * 0.5, s * 0.65); g.lineTo(-s * 0.5, s * 0.65); g.lineTo(-s * 0.2, s * 0.4);
      g.lineTo(-s * 0.3, -s * 0.05); g.lineTo(-s * 0.6, -s * 0.15); g.closePath(); g.fill();
      return;
    case 'mountain':
      g.moveTo(-s * 0.9, s * 0.6); g.lineTo(-s * 0.3, -s * 0.4); g.lineTo(-s * 0.05, -s * 0.05); g.lineTo(s * 0.3, -s * 0.7); g.lineTo(s * 0.9, s * 0.6); g.closePath();
      g.fill();
      return;
    case 'stones':
      for (const [x, w, h] of [[-0.55, 0.28, 1.1], [0, 0.32, 1.4], [0.55, 0.28, 1.0]]) g.rect((x - w / 2) * s, (0.6 - h) * s, w * s, h * s);
      g.rect(-0.75 * s, -0.85 * s, 1.5 * s, 0.22 * s);
      g.fill();
      return;
    case 'rune': {
      g.lineWidth = s * 0.16; g.lineCap = 'square';
      g.moveTo(-s * 0.3, s * 0.8); g.lineTo(-s * 0.3, -s * 0.8); g.lineTo(s * 0.4, -s * 0.3); g.lineTo(-s * 0.3, s * 0.1);
      g.moveTo(-s * 0.3, s * 0.1); g.lineTo(s * 0.4, s * 0.8);
      g.stroke();
      return;
    }
    case 'skull':
      g.arc(0, -s * 0.15, s * 0.55, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.rect(-s * 0.3, s * 0.2, s * 0.6, s * 0.45); g.fill();
      g.save(); g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.arc(-s * 0.22, -s * 0.12, s * 0.15, 0, Math.PI * 2); g.arc(s * 0.22, -s * 0.12, s * 0.15, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(0, s * 0.05); g.lineTo(s * 0.08, s * 0.2); g.lineTo(-s * 0.08, s * 0.2); g.fill();
      for (let i = -2; i <= 2; i++) g.fillRect(i * s * 0.11 - s * 0.02, s * 0.42, s * 0.04, s * 0.25);
      g.restore();
      return;
    case 'fang':
      for (const sx of [-1, 1]) {
        g.beginPath(); g.moveTo(sx * s * 0.5, -s * 0.8); g.quadraticCurveTo(sx * s * 0.6, s * 0.2, sx * s * 0.1, s * 0.85); g.quadraticCurveTo(sx * s * 0.2, 0, sx * s * 0.1, -s * 0.8); g.fill();
      }
      return;
    case 'hand':
      g.rect(-s * 0.4, -s * 0.05, s * 0.8, s * 0.75);
      for (let i = 0; i < 4; i++) g.rect(-s * 0.4 + i * s * 0.205, -s * 0.75, s * 0.16, s * 0.75);
      g.fill();
      g.beginPath(); g.ellipse(-s * 0.55, s * 0.1, s * 0.12, s * 0.35, -0.6, 0, Math.PI * 2); g.fill();
      return;
    case 'eye':
      g.moveTo(-s * 0.9, 0); g.quadraticCurveTo(0, -s * 0.8, s * 0.9, 0); g.quadraticCurveTo(0, s * 0.8, -s * 0.9, 0); g.fill();
      g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(0, 0, s * 0.28, 0, Math.PI * 2); g.fill(); g.restore();
      g.beginPath(); g.arc(0, 0, s * 0.14, 0, Math.PI * 2); g.fill();
      return;
    case 'dragon':
      // Stylised wyvern: body S-curve with spread wings.
      g.moveTo(0, -s * 0.7); g.quadraticCurveTo(s * 0.25, -s * 0.5, s * 0.1, -s * 0.2);
      g.lineTo(s * 0.9, -s * 0.6); g.lineTo(s * 0.7, -s * 0.1); g.lineTo(s * 0.85, 0); g.lineTo(s * 0.15, s * 0.1);
      g.quadraticCurveTo(s * 0.3, s * 0.5, -s * 0.1, s * 0.85); g.quadraticCurveTo(s * 0.05, s * 0.45, -s * 0.15, s * 0.1);
      g.lineTo(-s * 0.85, 0); g.lineTo(-s * 0.7, -s * 0.1); g.lineTo(-s * 0.9, -s * 0.6); g.lineTo(-s * 0.1, -s * 0.2);
      g.quadraticCurveTo(-s * 0.25, -s * 0.5, 0, -s * 0.7); g.fill();
      return;
    case 'flame':
      g.moveTo(0, s * 0.85); g.bezierCurveTo(-s * 0.9, s * 0.4, -s * 0.2, -s * 0.2, -s * 0.15, -s * 0.85);
      g.bezierCurveTo(s * 0.1, -s * 0.4, s * 0.3, -s * 0.5, s * 0.25, -s * 0.7); g.bezierCurveTo(s * 0.8, -s * 0.1, s * 0.7, s * 0.5, 0, s * 0.85); g.fill();
      return;
    case 'tower':
      g.rect(-s * 0.35, -s * 0.4, s * 0.7, s * 1.2);
      for (let i = 0; i < 3; i++) g.rect(-s * 0.45 + i * s * 0.35, -s * 0.75, s * 0.2, s * 0.4);
      g.rect(-s * 0.45, -s * 0.45, s * 0.9, s * 0.12);
      g.fill();
      g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(0, s * 0.55, s * 0.15, Math.PI, 0); g.rect(-s * 0.15, s * 0.55, s * 0.3, s * 0.25); g.fill(); g.restore();
      return;
    case 'sword':
      g.moveTo(0, -s * 0.9); g.lineTo(s * 0.08, -s * 0.75); g.lineTo(s * 0.08, s * 0.35); g.lineTo(-s * 0.08, s * 0.35); g.lineTo(-s * 0.08, -s * 0.75); g.closePath();
      g.rect(-s * 0.35, s * 0.35, s * 0.7, s * 0.09); g.rect(-s * 0.05, s * 0.44, s * 0.1, s * 0.3);
      g.fill(); g.beginPath(); g.arc(0, s * 0.8, s * 0.09, 0, Math.PI * 2); g.fill();
      return;
    case 'diamond':
      g.moveTo(0, -s * 0.85); g.lineTo(s * 0.55, 0); g.lineTo(0, s * 0.85); g.lineTo(-s * 0.55, 0); g.closePath(); g.fill();
      return;
    default:
      g.arc(0, 0, s * 0.6, 0, Math.PI * 2); g.fill();
  }
}

const CHARGES: Record<string, string[]> = {
  knotwork: ['cross', 'star', 'tower', 'sword', 'sun'],
  leafvine: ['leaf', 'tree', 'star'],
  runic: ['hammer', 'anvil', 'rune', 'mountain'],
  spikes: ['skull', 'fang', 'hand'],
  rough: ['eye', 'hand', 'skull'],
  geometric: ['sun', 'diamond', 'star'],
  scales: ['dragon', 'flame', 'sun'],
  crescent: ['crescent', 'star', 'eye'],
  megalith: ['mountain', 'stones', 'sun'],
};

/**
 * Paint a shield face. `outline` (in canvas pixels) clips the paint; planks
 * show through chips when the shield is worn.
 */
function heraldry(v: ItemVisual, rng: Rng, w: number, h: number, outline: (g: Ctx2D) => void, opts: { planks: boolean; base: RGB }): THREE.CanvasTexture {
  const { canvas, g } = makeCanvas(w, h);
  const st = styleOf(v.style);
  // Base: planks or metal.
  g.fillStyle = css(opts.base);
  g.fillRect(0, 0, w, h);
  if (opts.planks) {
    const n = 4 + rng.int(0, 2);
    for (let i = 0; i < n; i++) {
      g.fillStyle = css(shade(opts.base, 0.85 + rng.float() * 0.3));
      g.fillRect((i / n) * w, 0, w / n, h);
      g.strokeStyle = css(shade(opts.base, 0.75), 0.35);
      g.lineWidth = 1;
      for (let k = 0; k < 10; k++) {
        const x = (i / n) * w + rng.float() * (w / n);
        g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + 6, h * 0.3, x - 6, h * 0.6, x + 3, h); g.stroke();
      }
      g.fillStyle = css(shade(opts.base, 0.4), 0.9);
      g.fillRect((i / n) * w - 1, 0, 2, h);
    }
  }
  // Tinctures with guaranteed contrast.
  const field: RGB = v.secondary;
  let second: RGB = rng.chance(0.5) ? v.accent : shade(field, lum(field) > 0.4 ? 0.45 : 2.2);
  if (Math.abs(lum(second) - lum(field)) < 0.12) second = lum(field) > 0.45 ? [0.12, 0.1, 0.09] : [0.9, 0.85, 0.7];
  let chg: RGB = rng.chance(0.6) ? v.accent : [0.92, 0.88, 0.75];
  const bgL = (lum(field) + lum(second)) / 2;
  if (Math.abs(lum(chg) - bgL) < 0.25) chg = bgL > 0.45 ? [0.08, 0.07, 0.07] : [0.95, 0.9, 0.75];
  g.save();
  outline(g);
  g.clip();
  g.globalAlpha = 0.95;
  g.fillStyle = css(field);
  g.fillRect(0, 0, w, h);
  g.fillStyle = css(second);
  const div = rng.pick(['plain', 'pale', 'fess', 'bend', 'quarterly', 'chevron', 'saltire', 'bordure', 'gyronny', 'paly']);
  g.beginPath();
  switch (div) {
    case 'pale': g.rect(w / 2, 0, w / 2, h); g.fill(); break;
    case 'fess': g.rect(0, h / 2, w, h / 2); g.fill(); break;
    case 'bend': g.moveTo(0, 0); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fill(); break;
    case 'quarterly': g.rect(w / 2, 0, w / 2, h / 2); g.rect(0, h / 2, w / 2, h / 2); g.fill(); break;
    case 'chevron': g.moveTo(0, h * 0.85); g.lineTo(w / 2, h * 0.35); g.lineTo(w, h * 0.85); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fill(); break;
    case 'saltire': g.lineWidth = w * 0.16; g.strokeStyle = css(second); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke(); break;
    case 'gyronny':
      for (let i = 0; i < 8; i += 2) {
        const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
        g.moveTo(w / 2, h / 2); g.lineTo(w / 2 + Math.cos(a0) * w * 2, h / 2 + Math.sin(a0) * w * 2); g.lineTo(w / 2 + Math.cos(a1) * w * 2, h / 2 + Math.sin(a1) * w * 2); g.closePath();
      }
      g.fill(); break;
    case 'paly': for (let i = 1; i < 6; i += 2) g.rect((i / 6) * w, 0, w / 6, h); g.fill(); break;
    case 'bordure': g.lineWidth = Math.min(w, h) * 0.16; g.strokeStyle = css(second); outline(g); g.stroke(); break;
    default: break;
  }
  // Charge.
  const pool = CHARGES[st.motif] ?? CHARGES.knotwork;
  g.fillStyle = css(chg);
  g.strokeStyle = css(chg);
  g.save();
  g.translate(w / 2, h * (h > w ? 0.42 : 0.5));
  g.beginPath();
  charge(g, rng.pick(pool), Math.min(w, h) * 0.3, rng);
  g.restore();
  // Outline of charge edge (thin dark line for legibility).
  g.globalAlpha = 1;
  // Wear: chips revealing the base, scratches, grime toward the rim.
  const wear = v.wear;
  const chips = Math.round(6 + wear * 60);
  for (let i = 0; i < chips; i++) {
    const x = rng.float() * w, y = rng.float() * h, r = 1 + rng.float() * (3 + wear * 8);
    g.fillStyle = css(shade(opts.base, 0.9 + rng.float() * 0.2));
    g.beginPath();
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; const rr = r * (0.5 + rng.float() * 0.7); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    g.fill();
  }
  g.strokeStyle = 'rgba(20,15,10,0.35)';
  for (let i = 0; i < 4 + wear * 20; i++) {
    const x = rng.float() * w, y = rng.float() * h, a = rng.float() * Math.PI, l = 8 + rng.float() * 30;
    g.lineWidth = 0.5 + rng.float();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const grime = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.7);
  grime.addColorStop(0, 'rgba(0,0,0,0)');
  grime.addColorStop(1, `rgba(30,22,12,${0.15 + wear * 0.4})`);
  g.fillStyle = grime;
  g.fillRect(0, 0, w, h);
  g.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Shape geometry from an outline with UVs normalised to its bounds. */
function faceGeometry(outline: V2[]): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ShapeGeometry(shape, 12);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (p.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
  return g;
}

function paintMat(kit: ItemMatKit, tex: THREE.Texture, metal: boolean) {
  return kit.adopt('paint', new THREE.MeshStandardMaterial({ map: tex, roughness: metal ? 0.45 : 0.75, metalness: metal ? 0.4 : 0, bumpMap: tex, bumpScale: 0.3 }));
}

/** Canvas-space clip path from an outline in shield units. */
function clipFrom(outline: V2[], w: number, h: number): (g: Ctx2D) => void {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const [x, y] of outline) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  return (g) => {
    g.beginPath();
    outline.forEach(([x, y], i) => {
      const cx = ((x - minx) / (maxx - minx)) * w, cy = (1 - (y - miny) / (maxy - miny)) * h;
      if (i) g.lineTo(cx, cy); else g.moveTo(cx, cy);
    });
    g.closePath();
  };
}

/** Rivets along an outline, inset. */
function rivets(outline: V2[], count: number, z: (x: number) => number, r: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(outline.map(([x, y]) => new THREE.Vector3(x, y, 0)), true);
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const p = curve.getPointAt(i / count);
    const s = new THREE.SphereGeometry(r, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    s.rotateX(Math.PI / 2);
    s.translate(p.x * 0.94, p.y * 0.94, z(p.x * 0.94));
    geos.push(s);
  }
  return mergeAll(geos);
}

/** Rim tube following an outline, bent by z(x). */
function rim(outline: V2[], r: number, z: (x: number) => number): THREE.BufferGeometry {
  const pts = outline.map(([x, y]) => new THREE.Vector3(x, y, z(x)));
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), outline.length * 3, r, 5, true);
}

/** Back straps (enarmes) and padding. */
function straps(g: THREE.Group, kit: ItemMatKit, zBack: number) {
  for (const sy of [0.07, -0.09]) {
    const s = sweep([new THREE.Vector3(-0.09, sy, zBack), new THREE.Vector3(-0.04, sy, zBack - 0.035), new THREE.Vector3(0.04, sy, zBack - 0.035), new THREE.Vector3(0.09, sy, zBack)], () => [0.003, 0.016], { segs: 12, radial: 4 });
    g.add(mesh(s, kit.get('leather')));
  }
  g.add(mesh(new THREE.BoxGeometry(0.12, 0.2, 0.012), kit.tinted('cloth', [0.55, 0.45, 0.32], 'pad'), 0, 0, zBack - 0.004));
}

export function buildShield(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  const g = new THREE.Group();
  const wooden = v.material === 'wood';
  const baseCol: RGB = v.primary;
  switch (shape) {
    case 'shield.buckler': {
      // Hammered metal dome with concentric ridges, rolled rim and boss.
      const R = 0.17;
      const prof: [number, number][] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const r = R * (1 - t);
        prof.push([r, 0.045 * Math.sqrt(1 - (r / R) ** 2) + (i % 4 === 2 ? 0.004 : 0)]);
      }
      const dome = lathe(prof.map(([r, y]) => [r, y]), 28);
      dome.rotateX(Math.PI / 2);
      const dm = mesh(dome, kit.get('blade'), 0, 0, 0.035);
      g.add(dm);
      g.add(mesh(new THREE.TorusGeometry(R, 0.007, 6, 32), kit.get('dark'), 0, 0, 0.035));
      const boss = lathe([[0.05, 0], [0.048, 0.015], [0.035, 0.035], [0.012, 0.045], [0, 0.07]], 16);
      boss.rotateX(Math.PI / 2);
      g.add(mesh(boss, c2(kit, rng), 0, 0, 0.035 + 0.04));
      g.add(mesh(rivets(circle(R * 0.85, 24), 10, () => 0.035 + 0.012, 0.006), kit.get('trim')));
      // Central handle bar behind the boss.
      g.add(mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.11, 8), kit.get('grip'), 0, 0, 0.012, 0, 0, Math.PI / 2));
      addGlow(g, v, dm);
      return g;
    }
    case 'shield.round': {
      const R = 0.42, T = 0.018, dome = 0.03, z0 = 0.03;
      const zf = (x: number, y = 0) => z0 + T / 2 + dome * (1 - (x * x + y * y) / (R * R));
      const body = new THREE.CylinderGeometry(R, R, T, 40, 1);
      body.rotateX(Math.PI / 2);
      g.add(mesh(body, kit.get('wood'), 0, 0, z0));
      const face = new THREE.CircleGeometry(R * 0.995, 40, 0, Math.PI * 2);
      deform(face, (p) => { p.z = zf(p.x, p.y) - z0 + 0.0008; });
      const tex = heraldry(v, rng, 256, 256, (c) => { c.beginPath(); c.arc(128, 128, 128, 0, Math.PI * 2); }, { planks: wooden, base: wooden ? baseCol : baseCol });
      const fm = mesh(face, paintMat(kit, tex, !wooden), 0, 0, z0);
      g.add(fm);
      // Rawhide/iron rim.
      g.add(mesh(new THREE.TorusGeometry(R, 0.011, 6, 48), rng.chance(0.5) ? kit.get('leather') : kit.get('dark'), 0, 0, z0 + T / 2));
      const boss = lathe([[0.1, 0], [0.098, 0.008], [0.08, 0.03], [0.045, 0.06], [0.0, 0.07]], 18);
      boss.rotateX(Math.PI / 2);
      const bm = mesh(boss, c2(kit, rng), 0, 0, zf(0) - 0.005);
      g.add(bm);
      g.add(mesh(rivets(circle(R * 0.98, 32), 16, (x) => zf(x * 0.98, 0) - 0.0, 0.007), kit.get('dark')));
      g.add(mesh(rivets(circle(0.105, 12), 8, () => zf(0.1) + 0.002, 0.006), kit.get('trim')));
      // Back: braces and the centre grip.
      for (const by of [0.15, -0.15]) g.add(mesh(new THREE.BoxGeometry(0.7, 0.04, 0.012), kit.get('wood'), 0, by, z0 - T / 2 - 0.006));
      g.add(mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.14, 8), kit.get('grip'), 0, 0, 0.012, 0, 0, Math.PI / 2));
      addGlow(g, v, bm);
      return g;
    }
    case 'shield.kite': {
      const W = 0.3, top = 0.4, bot = -0.62;
      const ol: V2[] = [];
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (i / 8);
        ol.push([Math.cos(a) * W, top - 0.12 + Math.sin(a) * 0.12]);
      }
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        ol.push([-W * (1 - t * t) * (1 - t * 0.15), top - 0.12 - t * (top - 0.12 - bot)]);
      }
      for (let i = 9; i >= 1; i--) {
        const t = i / 10;
        ol.push([W * (1 - t * t) * (1 - t * 0.15), top - 0.12 - t * (top - 0.12 - bot)]);
      }
      const bend = (x: number) => 0.05 - 0.55 * x * x;
      buildFlat(g, kit, v, rng, ol, 0.016, bend, wooden, 256, 384);
      // Optional boss for older kite shields.
      if (rng.chance(0.4)) {
        const boss = lathe([[0.06, 0], [0.05, 0.02], [0.02, 0.04], [0, 0.045]], 14);
        boss.rotateX(Math.PI / 2);
        g.add(mesh(boss, c2(kit, rng), 0, 0.05, bend(0) + 0.008));
      }
      straps(g, kit, bend(0) - 0.012);
      return g;
    }
    case 'shield.tower': {
      const W = 0.32, H = 0.62;
      const ol: V2[] = [[-W, -H], [W, -H], [W, H - 0.06], [W * 0.5, H], [0, H + 0.04], [-W * 0.5, H], [-W, H - 0.06]];
      // Densify straight edges so the bend deforms them.
      const dense: V2[] = [];
      for (let i = 0; i < ol.length; i++) {
        const a = ol[i], b = ol[(i + 1) % ol.length];
        for (let k = 0; k < 3; k++) dense.push([a[0] + (b[0] - a[0]) * (k / 3), a[1] + (b[1] - a[1]) * (k / 3)]);
      }
      const bend = (x: number) => 0.06 - 0.5 * x * x;
      buildFlat(g, kit, v, rng, dense, 0.022, bend, wooden, 256, 512);
      // Vertical reinforcing spine and horizontal bands with rivets.
      const spine = new THREE.BoxGeometry(0.05, H * 2, 0.008);
      g.add(mesh(spine, kit.get('dark'), 0, 0, bend(0) + 0.013));
      for (const by of [-H * 0.6, H * 0.55]) {
        const band = new THREE.BoxGeometry(W * 2, 0.035, 0.006, 12, 1, 1);
        deform(band, (p) => { p.z += bend(p.x) + 0.012; });
        g.add(mesh(band, kit.get('dark'), 0, by, 0));
      }
      // View slit near the top.
      g.add(mesh(new THREE.BoxGeometry(0.14, 0.012, 0.01), kit.tinted('dark', [0.02, 0.02, 0.02], 'slit'), 0, H - 0.12, bend(0) + 0.012));
      straps(g, kit, bend(0) - 0.016);
      return g;
    }
    default:
      return null;
  }
}

/**
 * Midpoint-subdivide a triangle soup (positions + uvs) `iters` times. Large
 * earcut triangles would otherwise cut chords through the bent surface.
 */
function subdivide(src: THREE.BufferGeometry, iters: number): THREE.BufferGeometry {
  let g = src.index ? src.toNonIndexed() : src;
  for (let it = 0; it < iters; it++) {
    const p = g.attributes.position.array as ArrayLike<number>;
    const u = g.attributes.uv.array as ArrayLike<number>;
    const np: number[] = [], nu: number[] = [];
    for (let t = 0; t < p.length / 9; t++) {
      const P = (k: number) => [p[t * 9 + k * 3], p[t * 9 + k * 3 + 1], p[t * 9 + k * 3 + 2]];
      const U = (k: number) => [u[t * 6 + k * 2], u[t * 6 + k * 2 + 1]];
      const mid = (a: number[], b: number[]) => a.map((x, i) => (x + b[i]) / 2);
      const a = P(0), b = P(1), c = P(2), ua = U(0), ub = U(1), uc = U(2);
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a), uab = mid(ua, ub), ubc = mid(ub, uc), uca = mid(uc, ua);
      for (const [x, y, z, ux, uy, uz] of [[a, ab, ca, ua, uab, uca], [ab, b, bc, uab, ub, ubc], [ca, bc, c, uca, ubc, uc], [ab, bc, ca, uab, ubc, uca]]) {
        np.push(...x, ...y, ...z);
        nu.push(...ux, ...uy, ...uz);
      }
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(nu, 2));
  }
  return g;
}

/**
 * Kite/tower body as a bent slab: painted front (finely tessellated so it
 * follows the curvature), plain back and side walls, plus rim and rivets.
 */
function buildFlat(g: THREE.Group, kit: ItemMatKit, v: ItemVisual, rng: Rng, ol: V2[], T: number, bend: (x: number) => number, wooden: boolean, cw: number, ch: number) {
  const bodyMat = wooden ? kit.get('wood') : kit.get('metal');
  // Front (painted).
  const face = subdivide(faceGeometry(ol), 3);
  deform(face, (p) => { p.z = bend(p.x) + T / 2; });
  const tex = heraldry(v, rng, cw, ch, clipFrom(ol, cw, ch), { planks: wooden, base: v.primary });
  const fm = mesh(face, paintMat(kit, tex, !wooden));
  g.add(fm);
  // Back: same outline, flipped winding.
  const back = subdivide(faceGeometry(ol), 2);
  deform(back, (p) => { p.z = bend(p.x) - T / 2; });
  const bp = back.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < bp.count; i += 3) {
    const x = bp.getX(i + 1), y = bp.getY(i + 1), z = bp.getZ(i + 1);
    bp.setXYZ(i + 1, bp.getX(i + 2), bp.getY(i + 2), bp.getZ(i + 2));
    bp.setXYZ(i + 2, x, y, z);
  }
  back.computeVertexNormals();
  g.add(mesh(back, bodyMat));
  // Side walls along the outline.
  const wall: number[] = [];
  for (let i = 0; i < ol.length; i++) {
    const [x0, y0] = ol[i], [x1, y1] = ol[(i + 1) % ol.length];
    const f0 = bend(x0) + T / 2, f1 = bend(x1) + T / 2, b0 = f0 - T, b1 = f1 - T;
    wall.push(x0, y0, b0, x1, y1, b1, x1, y1, f1, x0, y0, b0, x1, y1, f1, x0, y0, f0);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
  wg.computeVertexNormals();
  g.add(mesh(wg, bodyMat));
  g.add(mesh(rim(ol, 0.009, (x) => bend(x)), rng.chance(0.5) || !wooden ? kit.get('dark') : kit.get('leather')));
  g.add(mesh(rivets(ol, Math.min(28, Math.round(ol.length * 0.8)), (x) => bend(x) + T / 2 + 0.001, 0.006), kit.get('trim')));
  addGlow(g, v, fm);
}

function circle(r: number, n: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) out.push([Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r]);
  return out;
}

/** Boss/fittings material: polished trim or plain metal. */
function c2(kit: ItemMatKit, rng: Rng): THREE.Material {
  return rng.chance(0.4) ? kit.get('trim') : kit.get('blade');
}

/** Enchanted shields: a faint additive shell over the face. */
function addGlow(g: THREE.Group, v: ItemVisual, face: THREE.Mesh) {
  if (v.glow <= 0.05) return;
  const col = new THREE.Color().setRGB(v.glowColor[0], v.glowColor[1], v.glowColor[2], THREE.SRGBColorSpace);
  const m = new THREE.Mesh(face.geometry.clone(), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 + v.glow * 0.2, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  m.position.copy(face.position);
  m.position.z += 0.004;
  m.rotation.copy(face.rotation);
  m.renderOrder = 2;
  g.add(m);
}
