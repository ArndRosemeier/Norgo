/**
 * Rigid worn parts: helmets, hats, crowns, masks, gorgets, jewelry,
 * pauldrons, bracers, gauntlet cuffs, belts, tassets, greaves, knee cops,
 * boot cuffs, sabaton toes, clasps. Each builder returns a fresh Object3D in
 * SOCKET SPACE (see the convention in ./fit.ts), fitted to a BodyFit.
 *
 * Left/right parts are always built for the LEFT side (outward = +X);
 * right-side copies are mirrored by the caller (`mirrorX`).
 */
import * as THREE from 'three';
import type { BodyFit } from '../../wearable';
import type { ItemMatKit } from '../materials';
import { mesh, lathe, cyl, type V2 } from '../meshes/util';
import { limbs, taperedTube, sphereShell, frontPhi, displace, rivetRing } from './fit';
import { mainMaterial, patternMaterial, voidMaterial, type Look } from './look';
import type { Rng } from '../../../core/rng';
import { styleOf } from '../../data/styles';

const PI = Math.PI;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface PartCtx {
  kit: ItemMatKit;
  look: Look;
  fit: BodyFit;
  rng: Rng;
}

// ------------------------------------------------------------------ head

/** Horizontal scale of helmets: heads are narrower than deep; pointed ears widen it. */
function headScale(fit: BodyFit) {
  return 0.9 + Math.max(0, fit.earPoint) * 0.08;
}

/** Grommet rings where horns pass through closed helmets (drawn as reinforced holes). */
function hornGrommets(c: PartCtx, R: number): THREE.Object3D[] {
  if (!c.fit.hasHorns) return [];
  const out: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const t = mesh(new THREE.TorusGeometry(R * 0.2, R * 0.045, 6, 16), c.kit.get('trim'), s * R * 0.62, R * 0.72, R * 0.2);
    t.lookAt(s * R * 1.4, R * 1.5, R * 0.45);
    out.push(t);
  }
  return out;
}

function helmBand(c: PartCtx, R: number, y: number, h = 0.12) {
  const g = new THREE.Group();
  g.add(mesh(cyl(R * 1.03, R * 1.03, y - R * h * 0.5, y + R * h * 0.5, 28, true), c.kit.get('trim')));
  g.add(rivetRing(c.kit.get('trim'), R * 1.05, R * 1.05, y, 14, R * 0.035));
  return g;
}

export function buildHeadwear(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, fit, look, rng } = c;
  const R = fit.headRadius * 1.12;
  const root = new THREE.Group();
  const hs = headScale(fit);
  const metal = kit.get('metal');
  const trim = kit.get('trim');
  const main = mainMaterial(kit, look);
  const style = styleOf(kit.v.style);
  switch (shape) {
    case 'cap.leather': {
      const dome = mesh(sphereShell(R * 1.0, 0, PI * 2, 0, PI * 0.56, 28, 12), main);
      root.add(dome);
      // Stitched seams (meridians) and a rolled rim.
      const seam = kit.get('dark');
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * PI * 2 + PI / 4;
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 8; k++) {
          const th = (k / 8) * PI * 0.54;
          pts.push(V(Math.sin(th) * Math.sin(a) * R * 1.01, Math.cos(th) * R * 1.01, Math.sin(th) * Math.cos(a) * R * 1.01));
        }
        root.add(mesh(taperedTube(pts, () => R * 0.018, 5, 16), seam));
      }
      root.add(mesh(new THREE.TorusGeometry(R * 0.985, R * 0.04, 6, 32).rotateX(PI / 2), main, 0, Math.cos(PI * 0.56) * R, 0));
      for (const s of [1, -1]) {
        const flap = mesh(new THREE.CylinderGeometry(R * 0.32, R * 0.36, R * 0.06, 16), main, s * R * 0.96, -R * 0.38, 0, 0, 0, PI / 2);
        flap.scale.set(1, 1, 1.25);
        root.add(flap);
      }
      root.scale.x = hs;
      root.rotation.x = -0.12;
      break;
    }
    case 'helm.nasal':
    case 'helm.horned': {
      const prof: V2[] = [[1.0, 0.18], [1.0, 0.4], [0.93, 0.68], [0.75, 0.95], [0.45, 1.17], [0.15, 1.3], [0.02, 1.33]];
      root.add(mesh(lathe(prof.map(([r, y]) => [r * R, y * R] as V2), 28), metal));
      root.add(helmBand(c, R, R * 0.22));
      // Spangen: four riveted meridian strips.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * PI * 2 + PI / 4;
        const pts = prof.map(([r, y]) => V(Math.sin(a) * r * R * 1.025, y * R, Math.cos(a) * r * R * 1.025));
        root.add(mesh(taperedTube(pts, (t) => R * (0.05 - t * 0.03), 4, 18), trim));
      }
      // Nasal guard.
      const nasal = mesh(new THREE.BoxGeometry(R * 0.16, R * 0.62, R * 0.04), metal, 0, -R * 0.03, R * 1.03, 0.08);
      root.add(nasal);
      if (shape === 'helm.horned' && !fit.hasHorns) {
        for (const s of [1, -1]) {
          const pts = [V(0.85, 0.6, 0), V(1.3, 0.85, -0.05), V(1.62, 1.28, 0.12), V(1.6, 1.72, 0.42)].map((p) => V(p.x * s * R, p.y * R, p.z * R));
          root.add(mesh(taperedTube(pts, (t) => R * (0.17 * (1 - t) + 0.012), 10, 28), kit.get('bone')));
        }
      }
      for (const g of hornGrommets(c, R)) root.add(g);
      root.scale.x = hs;
      root.rotation.x = -0.15;
      break;
    }
    case 'helm.kettle': {
      root.add(mesh(lathe([[R * 1.0, R * 0.12], [R * 1.0, R * 0.45], [R * 0.85, R * 0.9], [R * 0.5, R * 1.17], [0.001, R * 1.25]], 28), metal));
      // Brim, sloping down, with a rolled edge.
      root.add(mesh(lathe([[R * 1.66, -R * 0.08], [R * 1.55, R * 0.0], [R * 1.25, R * 0.12], [R * 1.0, R * 0.18]], 32), metal));
      root.add(mesh(new THREE.TorusGeometry(R * 1.66, R * 0.035, 6, 40).rotateX(PI / 2), trim, 0, -R * 0.08, 0));
      root.add(helmBand(c, R, R * 0.28, 0.1));
      // Medial ridge.
      const ridge: THREE.Vector3[] = [];
      for (let k = 0; k <= 10; k++) {
        const th = -PI / 2 + (k / 10) * PI;
        ridge.push(V(0, Math.cos(th) * R * 0.95 + R * 0.3, Math.sin(th) * R * 0.95));
      }
      root.add(mesh(taperedTube(ridge, () => R * 0.035, 5, 20), metal));
      // Chin strap.
      for (const s of [1, -1])
        root.add(mesh(taperedTube([V(s * R * 0.92, R * 0.15, 0), V(s * R * 0.72, -R * 0.55, R * 0.25), V(0, -R * 0.95, R * 0.42)], () => R * 0.03, 4, 12), kit.get('leather')));
      for (const g of hornGrommets(c, R)) root.add(g);
      root.scale.x = hs;
      root.rotation.x = -0.1;
      break;
    }
    case 'helm.barbute': {
      const prof: V2[] = [[0.02, 1.25], [0.45, 1.15], [0.8, 0.92], [1.0, 0.55], [1.04, 0.2], [1.02, -0.25], [0.95, -0.6], [0.86, -0.85], [0.95, -1.0]];
      const cut = (y0: number, y1: number, gap: number) => {
        const pts = sliceProfile(prof, y0, y1).map(([r, y]) => [r * R, y * R] as V2);
        return mesh(lathe(pts, 32, gap / 2, PI * 2 - gap), metal);
      };
      root.add(cut(0.35, 1.25, 0));
      root.add(cut(-0.25, 0.35, 1.1));
      root.add(cut(-1.0, -0.25, 0.42));
      // Reinforced opening edges and a brow lip.
      for (const s of [1, -1]) {
        root.add(mesh(taperedTube([V(Math.sin(s * 0.55) * R * 1.02, R * 0.35, Math.cos(0.55) * R * 1.02), V(Math.sin(s * 0.55) * R * 1.03, -R * 0.25, Math.cos(0.55) * R * 1.03), V(Math.sin(s * 0.21) * R * 0.97, -R * 0.27, Math.cos(0.21) * R * 0.97), V(Math.sin(s * 0.21) * R * 0.92, -R * 0.95, Math.cos(0.21) * R * 0.92)], () => R * 0.03, 4, 24), trim));
      }
      root.add(mesh(new THREE.TorusGeometry(R * 1.04, R * 0.035, 5, 24, 1.3).rotateX(PI / 2).rotateY(PI / 2 - 0.65), trim, 0, R * 0.36, 0));
      for (const g of hornGrommets(c, R)) root.add(g);
      root.scale.x = hs;
      root.rotation.x = -0.05;
      break;
    }
    case 'helm.great': {
      root.add(mesh(lathe([[R * 1.05, -R * 1.05], [R * 1.08, -R * 0.4], [R * 1.07, R * 0.6], [R * 1.0, R * 0.95], [R * 0.6, R * 1.05], [0.001, R * 1.08]], 32), metal));
      // Eye slits (two dark bars) and breathing holes on the right cheek.
      const dark = voidMaterial(kit);
      for (const s of [1, -1]) {
        const a = s * 0.28;
        const slit = mesh(new THREE.BoxGeometry(R * 0.5, R * 0.07, R * 0.05), dark, Math.sin(a) * R * 1.07, R * 0.2, Math.cos(a) * R * 1.07, 0, a, 0);
        root.add(slit);
      }
      const hole = new THREE.CircleGeometry(R * 0.035, 8);
      for (let j = 0; j < 3; j++)
        for (let i = 0; i < 4; i++) {
          const a = -0.25 - i * 0.16;
          const m = mesh(hole, dark, Math.sin(a) * R * 1.085, -R * (0.25 + j * 0.16), Math.cos(a) * R * 1.085, 0, a, 0);
          root.add(m);
        }
      // Cross reinforcement on the face plate.
      root.add(mesh(new THREE.BoxGeometry(R * 0.1, R * 1.9, R * 0.05), trim, 0, -R * 0.05, R * 1.09));
      root.add(mesh(new THREE.BoxGeometry(R * 1.1, R * 0.1, R * 0.05), trim, 0, R * 0.38, R * 1.06).rotateY(0));
      root.add(helmBand(c, R * 1.04, R * 0.85, 0.08));
      if (fit.hasHorns) root.add(...hornGrommets(c, R * 1.05));
      root.scale.x = hs * 1.02;
      break;
    }
    case 'helm.skull': {
      const bone = kit.get('bone');
      root.add(mesh(lathe([[R * 1.02, R * 0.1], [R * 1.0, R * 0.5], [R * 0.82, R * 0.95], [R * 0.45, R * 1.22], [0.001, R * 1.3]], 24), bone).translateZ(-R * 0.05));
      // Snout of the beast projecting over the brow, with eye sockets and teeth.
      const snout = mesh(taperedTube([V(0, R * 0.8, R * 0.5), V(0, R * 0.7, R * 1.2), V(0, R * 0.5, R * 1.9)], (t) => R * (0.42 - t * 0.22), 8, 12), bone);
      snout.scale.x = 1.25;
      root.add(snout);
      const dark = voidMaterial(kit);
      for (const s of [1, -1]) {
        root.add(mesh(new THREE.SphereGeometry(R * 0.17, 10, 8), dark, s * R * 0.38, R * 0.9, R * 0.86));
        root.add(mesh(new THREE.TorusGeometry(R * 0.18, R * 0.05, 6, 14), bone, s * R * 0.38, R * 0.92, R * 0.9));
        for (let i = 0; i < 4; i++) {
          const t = i / 4;
          root.add(mesh(new THREE.ConeGeometry(R * 0.05, R * (0.22 - t * 0.08), 6), bone, s * R * (0.3 - t * 0.12), R * (0.42 - t * 0.12), R * (1.0 + t * 0.8), PI));
        }
        root.add(mesh(taperedTube([V(s * R * 0.7, R * 1.0, -R * 0.2), V(s * R * 1.1, R * 1.25, -R * 0.55), V(s * R * 1.05, R * 1.6, -R * 0.9)], (t) => R * (0.12 * (1 - t) + 0.01), 8, 16), bone));
      }
      root.scale.x = hs;
      break;
    }
    case 'hood':
    case 'coif.mail': {
      const mat = patternMaterial(kit, look, look.family === 'chain' ? [8, 6] : [2, 2]);
      const prof: V2[] = [[0.02, 1.22], [0.6, 1.12], [0.96, 0.75], [1.08, 0.2], [1.06, -0.3], [0.95, -0.7], [1.2, -1.05], [1.75, -1.25]];
      const pts = prof.map(([r, y]) => [r * R * 1.02, y * R] as V2);
      // Face opening at the front between eyebrow and chin.
      root.add(mesh(lathe(sliceProfile(pts, R * 0.35, R * 1.25), 28), mat));
      root.add(mesh(lathe(sliceProfile(pts, -R * 0.85, R * 0.35), 28, 0.6, PI * 2 - 1.2), mat));
      root.add(mesh(lathe(sliceProfile(pts, -R * 1.3, -R * 0.85), 28), mat));
      if (shape === 'hood') {
        // Hood peak drooping behind.
        root.add(mesh(new THREE.ConeGeometry(R * 0.35, R * 0.9, 12, 1, true), mat, 0, R * 0.9, -R * 0.75, -1.9));
        root.add(mesh(new THREE.TorusGeometry(R * 0.62, R * 0.05, 6, 20, PI * 1.1).rotateZ(-0.05 * PI), kit.get('trim'), 0, -R * 0.25, R * 0.86).rotateY(0));
      }
      root.scale.x = hs;
      root.scale.z = 1.05;
      break;
    }
    case 'hat.straw': {
      const mat = patternMaterial(kit, look, [6, 3], 'straw');
      root.add(mesh(lathe([[R * 2.1, R * 0.12], [R * 1.5, R * 0.35], [R * 1.0, R * 0.62], [R * 0.4, R * 0.98], [0.001, R * 1.12]], 36), mat));
      root.add(mesh(new THREE.TorusGeometry(R * 0.95, R * 0.035, 5, 32).rotateX(PI / 2), kit.get('accent'), 0, R * 0.66, 0));
      root.position.y = -R * 0.0;
      break;
    }
    case 'hat.wide': {
      const crown = mesh(lathe([[R * 1.0, R * 0.32], [R * 0.98, R * 0.8], [R * 0.86, R * 1.12], [R * 0.4, R * 1.18], [0.001, R * 1.12]], 28), main);
      displace(crown.geometry, (p) => { if (p.y > R * 1.0) p.y -= Math.max(0, R * 0.12 - Math.abs(p.x) * 0.5) * 1.2; });
      root.add(crown);
      const brim = mesh(lathe([[R * 1.85, R * 0.3], [R * 1.4, R * 0.33], [R * 0.98, R * 0.36]], 40), main);
      displace(brim.geometry, (p) => { p.y += (p.x * p.x) / (R * R) * R * 0.09 - (p.z > 0 ? (p.z / R) * R * 0.04 : 0); });
      root.add(brim);
      root.add(mesh(cyl(R * 1.0, R * 0.99, R * 0.36, R * 0.5, 28, true), kit.get('leather')));
      // Feather tucked into the band.
      const f = mesh(new THREE.SphereGeometry(R * 0.5, 10, 6), kit.tinted('cloth', look.accent, 'feather'), R * 0.85, R * 0.75, -R * 0.3, 0.4, 0.3, -0.9);
      f.scale.set(0.18, 1, 0.45);
      root.add(f);
      root.scale.x = hs;
      root.rotation.x = -0.08;
      break;
    }
    case 'hat.pointed': {
      const mat = patternMaterial(kit, look, [3, 2]);
      const brim = mesh(lathe([[R * 1.9, R * 0.22], [R * 1.5, R * 0.28], [R * 0.98, R * 0.32]], 40), mat);
      displace(brim.geometry, (p) => { const a = Math.atan2(p.x, p.z); p.y += Math.sin(a * 5) * R * 0.04 * (Math.hypot(p.x, p.z) / (R * 1.9)); });
      root.add(brim);
      const cone = mesh(lathe([[R * 1.0, R * 0.3], [R * 0.82, R * 0.9], [R * 0.5, R * 1.7], [R * 0.2, R * 2.4], [0.001, R * 2.8]], 24, 0, PI * 2), mat);
      // The tip flops backwards.
      displace(cone.geometry, (p) => {
        const k = Math.max(0, p.y - R * 1.4) / R;
        p.z -= k * k * R * 0.5;
        p.y -= k * k * R * 0.18;
      });
      root.add(cone);
      root.add(mesh(cyl(R * 1.0, R * 0.95, R * 0.32, R * 0.5, 28, true), kit.get('trim')));
      root.add(mesh(new THREE.OctahedronGeometry(R * 0.08), kit.get('gem'), 0, R * 0.42, R * 0.99));
      root.scale.x = hs;
      break;
    }
    case 'circlet': {
      const band = mesh(new THREE.TorusGeometry(R * 0.98, R * 0.028, 6, 48).rotateX(PI / 2), metal, 0, R * 0.3, 0);
      root.add(band);
      const motif = style.motif;
      const plate = mesh(new THREE.CylinderGeometry(R * 0.13, R * 0.13, R * 0.03, motif === 'leafvine' ? 3 : motif === 'runic' ? 6 : 4), metal, 0, R * 0.32, R * 0.98, PI / 2);
      root.add(plate);
      root.add(mesh(new THREE.OctahedronGeometry(R * 0.08), kit.get('gem'), 0, R * 0.32, R * 1.02).rotateZ(PI / 4));
      // Side filigree: tiny beads.
      for (let i = 1; i <= 5; i++)
        for (const s of [1, -1]) {
          const a = s * i * 0.22;
          root.add(mesh(new THREE.SphereGeometry(R * 0.025, 6, 4), trim, Math.sin(a) * R * 0.99, R * 0.3, Math.cos(a) * R * 0.99));
        }
      root.scale.x = hs;
      root.rotation.x = -0.2;
      break;
    }
    case 'crown': {
      root.add(mesh(cyl(R * 1.04, R * 1.08, R * 0.22, R * 0.48, 36, true), metal));
      root.add(mesh(new THREE.TorusGeometry(R * 1.05, R * 0.03, 5, 40).rotateX(PI / 2), trim, 0, R * 0.22, 0));
      root.add(mesh(new THREE.TorusGeometry(R * 1.08, R * 0.03, 5, 40).rotateX(PI / 2), trim, 0, R * 0.48, 0));
      const n = 8;
      const gem = kit.get('gem');
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2;
        const big = i % 2 === 0;
        const tine = mesh(new THREE.ConeGeometry(R * (big ? 0.13 : 0.08), R * (big ? 0.42 : 0.26), 4), metal, Math.sin(a) * R * 1.08, R * (0.48 + (big ? 0.21 : 0.13)), Math.cos(a) * R * 1.08, 0, a + PI / 4, 0);
        root.add(tine);
        root.add(mesh(new THREE.SphereGeometry(R * (big ? 0.05 : 0.035), 8, 6), big ? gem : trim, Math.sin(a) * R * 1.08, R * (0.48 + (big ? 0.44 : 0.28)), Math.cos(a) * R * 1.08));
        const g = mesh(new THREE.OctahedronGeometry(R * 0.06), gem, Math.sin(a + PI / n) * R * 1.1, R * 0.35, Math.cos(a + PI / n) * R * 1.1);
        g.scale.set(1, 1.3, 0.6);
        g.rotation.y = a + PI / n;
        root.add(g);
      }
      root.scale.x = hs;
      root.rotation.x = -0.12;
      break;
    }
    default:
      return null;
  }
  return root;
}

/** Keep the part of a lathe profile between y0 and y1 (inclusive), interpolating the cut points. */
function sliceProfile(prof: V2[], y0: number, y1: number): V2[] {
  const out: V2[] = [];
  const sorted = prof.slice().sort((a, b) => a[1] - b[1]);
  const at = (y: number): V2 => {
    for (let i = 0; i < sorted.length - 1; i++) {
      const [ra, ya] = sorted[i], [rb, yb] = sorted[i + 1];
      if (y >= ya && y <= yb) return [ra + ((rb - ra) * (y - ya)) / (yb - ya || 1), y];
    }
    return y < sorted[0][1] ? sorted[0] : sorted[sorted.length - 1];
  };
  out.push(at(y0));
  for (const p of sorted) if (p[1] > y0 && p[1] < y1) out.push(p);
  out.push(at(y1));
  return out;
}

// ------------------------------------------------------------------ face

export function buildMask(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, fit, look } = c;
  const R = fit.headRadius * 1.08;
  const root = new THREE.Group();
  const face = (thetaA: number, thetaB: number, width: number, mat: THREE.Material, rr = 1) => {
    const [ps, pl] = frontPhi(width);
    const m = mesh(sphereShell(R * rr, ps, pl, thetaA, thetaB - thetaA, 24, 14), mat);
    m.scale.set(0.9, 1.25, 1.0);
    return m;
  };
  switch (shape) {
    case 'mask.cloth': {
      const mat = patternMaterial(kit, look, [2, 1]);
      const wrap = face(PI * 0.52, PI * 0.82, PI * 1.25, mat, 1.04);
      displace(wrap.geometry, (p) => {
        // Bulge over the nose, gentle horizontal folds.
        const front = Math.max(0, p.z / R);
        p.z += Math.pow(front, 6) * R * 0.12 * Math.max(0, 1 - Math.abs(p.y / R + 0.05) * 2);
        p.multiplyScalar(1 + Math.sin(p.y / R * 30) * 0.01);
      });
      root.add(wrap);
      // Knot at the back with two short tails.
      root.add(mesh(new THREE.SphereGeometry(R * 0.12, 8, 6), mat, 0, -R * 0.25, -R * 0.98));
      for (const s of [1, -1]) root.add(mesh(taperedTube([V(0, -R * 0.25, -R * 1.0), V(s * R * 0.1, -R * 0.55, -R * 1.08), V(s * R * 0.16, -R * 0.85, -R * 1.02)], (t) => R * (0.07 - t * 0.04), 6, 10), mat));
      break;
    }
    case 'mask.leather': {
      const main = kit.get('primary');
      root.add(face(PI * 0.36, PI * 0.56, PI * 0.95, main, 1.05));
      const lens = kit.custom('lens', () => new THREE.MeshStandardMaterial({ color: 0x101820, roughness: 0.05, metalness: 0.4 }));
      for (const s of [1, -1]) {
        const l = mesh(new THREE.CylinderGeometry(R * 0.17, R * 0.17, R * 0.12, 16), lens, s * R * 0.34, R * 0.1, R * 1.0, PI / 2);
        root.add(l);
        root.add(mesh(new THREE.TorusGeometry(R * 0.17, R * 0.035, 6, 16), kit.get('trim'), s * R * 0.34, R * 0.1, R * 1.06));
      }
      root.add(mesh(new THREE.TorusGeometry(R * 0.97, R * 0.025, 4, 32).rotateX(PI / 2), kit.get('dark'), 0, R * 0.1, 0));
      break;
    }
    case 'mask.bone':
    case 'mask.metal': {
      const metal = shape === 'mask.metal';
      const mat = metal ? kit.get('metal') : kit.get('bone');
      root.add(face(PI * 0.3, PI * 0.8, PI * 0.95, mat, 1.06));
      const dark = voidMaterial(kit);
      for (const s of [1, -1]) {
        const eye = mesh(new THREE.SphereGeometry(R * 0.11, 10, 6), dark, s * R * 0.3, R * 0.1, R * 1.0);
        eye.scale.set(metal ? 1.4 : 1, metal ? 0.35 : 1, 0.4);
        root.add(eye);
      }
      // Nose ridge and lips / teeth.
      root.add(mesh(new THREE.ConeGeometry(R * 0.09, R * 0.35, 4), mat, 0, -R * 0.08, R * 1.08, -0.25, PI / 4));
      if (metal) {
        for (const s of [1, -1]) root.add(mesh(new THREE.TorusGeometry(R * 0.12, R * 0.02, 5, 12, PI * 0.8), mat, 0, -R * 0.42 + s * R * 0.01, R * 1.0, 0, 0, s > 0 ? 0.1 * PI : 1.1 * PI));
        root.add(mesh(new THREE.TorusGeometry(R * 0.55, R * 0.02, 5, 24, PI * 0.9), kit.get('trim'), 0, R * 0.35, R * 0.72, -PI / 2.4, 0, 0.05 * PI));
      } else {
        for (let i = -3; i <= 3; i++) root.add(mesh(new THREE.ConeGeometry(R * 0.035, R * 0.12, 5), mat, i * R * 0.07, -R * 0.55, R * (0.98 - Math.abs(i) * 0.02), PI));
        // Carved ritual lines.
        for (const s of [1, -1]) root.add(mesh(taperedTube([V(s * R * 0.15, R * 0.45, R * 1.02), V(s * R * 0.5, R * 0.2, R * 0.92), V(s * R * 0.55, -R * 0.3, R * 0.82)], () => R * 0.02, 4, 12), kit.tinted('primary', look.accent, 'paint')));
      }
      break;
    }
    case 'veil': {
      const mat = kit.custom('veil', () => {
        const m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...kit.v.primary, THREE.SRGBColorSpace), roughness: 0.5, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
        return m;
      });
      const [ps, pl] = frontPhi(PI * 1.1);
      const sheet = mesh(new THREE.CylinderGeometry(R * 1.02, R * 1.15, R * 1.1, 28, 6, true, ps - PI / 2, pl), mat, 0, -R * 0.45, 0);
      sheet.rotation.y = 0;
      displace(sheet.geometry, (p) => { p.x *= 0.92; p.z += Math.sin(Math.atan2(p.x, p.z) * 9) * R * 0.02 * (0.5 - p.y / R); });
      root.add(sheet);
      // Coin/bead fringe along the lower edge.
      const n = 15;
      for (let i = 0; i < n; i++) {
        const a = -pl / 2 + (pl * (i + 0.5)) / n;
        root.add(mesh(new THREE.CylinderGeometry(R * 0.035, R * 0.035, R * 0.01, 8), kit.get('trim'), Math.sin(a) * R * 1.1, -R * 1.02, Math.cos(a) * R * 1.12, PI / 2, 0, 0));
      }
      root.add(mesh(new THREE.TorusGeometry(R * 1.0, R * 0.02, 4, 32).rotateX(PI / 2), kit.get('trim'), 0, R * 0.1, 0));
      break;
    }
    default:
      return null;
  }
  root.scale.x *= headScale(fit);
  return root;
}

// ------------------------------------------------------------------ neck & chest

export function buildNeckPiece(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, fit, look } = c;
  const nr = fit.neckRadius;
  const root = new THREE.Group();
  const depth = Math.min(1, fit.chestDepth / (fit.shoulderWidth * 0.62));
  switch (shape) {
    case 'gorget': {
      const metal = kit.get('metal');
      const sw = fit.shoulderWidth * 0.5;
      for (let i = 0; i < 3; i++) {
        const y = 0.07 - i * 0.035;
        const r0 = nr * 1.25 + i * 0.022, r1 = nr * 1.3 + (i + 1) * 0.03;
        const band = mesh(lathe([[r1, y - 0.045], [r0, y]], 32), metal);
        root.add(band);
        root.add(rivetRing(kit.get('trim'), r0 + 0.004, r0 + 0.004, y - 0.006, 10, 0.003));
      }
      // Wide bib over the collarbones.
      root.add(mesh(lathe([[sw * 0.78, -0.085], [sw * 0.72, -0.07], [nr * 1.3 + 0.09, -0.035]], 32), metal));
      root.add(mesh(new THREE.TorusGeometry(nr * 1.25, 0.005, 5, 32).rotateX(PI / 2), kit.get('trim'), 0, 0.07, 0));
      root.scale.z = depth;
      break;
    }
    case 'torc': {
      const pts: THREE.Vector3[] = [];
      const R = nr * 1.42;
      for (let k = 0; k <= 24; k++) {
        const a = 0.35 + (k / 24) * (PI * 2 - 0.7);
        pts.push(V(Math.sin(a) * R, -0.012 - Math.cos(a) * 0.012, Math.cos(a) * R));
      }
      root.add(mesh(taperedTube(pts, (t) => 0.0065 + 0.0015 * Math.sin(t * 80), 8, 96), kit.get('metal')));
      for (const s of [1, -1]) root.add(mesh(new THREE.SphereGeometry(0.011, 10, 8), kit.get('trim'), Math.sin(s * 0.35) * R, -0.024, Math.cos(0.35) * R));
      root.scale.z = depth;
      break;
    }
    case 'amulet':
    case 'pendant': {
      const cordMat = shape === 'amulet' ? kit.get('trim') : kit.get('leather');
      const front = fit.chestDepth * 0.5 + 0.012;
      const pts = [V(0, 0.03, -nr * 1.15), V(nr * 1.3, 0.0, -nr * 0.2), V(nr * 1.6, -0.05, front * 0.6), V(0, -0.12, front), V(-nr * 1.6, -0.05, front * 0.6), V(-nr * 1.3, 0.0, -nr * 0.2)];
      root.add(mesh(taperedTube(pts, () => (shape === 'amulet' ? 0.0016 : 0.0022), 5, 64, true), cordMat));
      const p = buildPendantBody(shape, c);
      p.position.set(0, -0.12, front + 0.004);
      root.add(p);
      break;
    }
    case 'scarf': {
      const mat = patternMaterial(kit, look, [3, 1]);
      for (const [s, len] of [[1, 0.26], [-1, 0.2]] as [number, number][]) {
        const pts = [V(s * 0.03, -0.02, nr + 0.04), V(s * 0.05, -0.1, fit.chestDepth * 0.5 + 0.03), V(s * 0.06, -0.02 - len, fit.chestDepth * 0.5 + 0.045)];
        const tail = mesh(taperedTube(pts, (t) => 0.028 - t * 0.004, 8, 12), mat);
        tail.scale.z = 0.35;
        root.add(tail);
      }
      root.add(mesh(new THREE.TorusGeometry(nr * 1.3, 0.028, 8, 24).rotateX(PI / 2), mat, 0, 0.0, 0));
      break;
    }
    case 'mantle.fur': {
      const fur = patternMaterial(kit, look, [4, 1], 'fur');
      const sw = fit.shoulderWidth * 0.5;
      const m = mesh(lathe([[nr * 1.25, 0.06], [nr * 1.8, 0.07], [sw * 0.8, 0.02], [sw * 1.08, -0.06], [sw * 1.12, -0.12]], 32), fur);
      displace(m.geometry, (p) => { const a = Math.atan2(p.x, p.z); const r = Math.hypot(p.x, p.z); const k = 1 + Math.sin(a * 13) * 0.025 * (r / sw); p.x *= k; p.z *= k; });
      m.scale.z = depth * 0.95;
      root.add(m);
      // The pelt's head draped on the left shoulder.
      const head = mesh(new THREE.SphereGeometry(0.045, 10, 8), kit.get('fur'), sw * 0.55, 0.04, fit.chestDepth * 0.38);
      head.scale.set(1, 0.7, 1.5);
      root.add(head);
      const dark = voidMaterial(kit);
      for (const s of [1, -1]) root.add(mesh(new THREE.SphereGeometry(0.006, 6, 4), dark, sw * 0.55 + s * 0.02, 0.065, fit.chestDepth * 0.38 + 0.04));
      break;
    }
    case 'clasp': {
      root.add(buildBrooch(c));
      root.position.set(0.05, -0.02, fit.chestDepth * 0.5 + 0.02);
      break;
    }
    default:
      return null;
  }
  return root;
}

/** Medallion / carved pendant body, facing +Z, hanging from its top (origin at the loop). */
export function buildPendantBody(shape: string, c: PartCtx): THREE.Object3D {
  const { kit } = c;
  const g = new THREE.Group();
  const motif = styleOf(kit.v.style).motif;
  if (shape === 'amulet') {
    const sides = motif === 'runic' ? 6 : motif === 'crescent' ? 32 : motif === 'geometric' ? 4 : 24;
    const disc = mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.005, sides), kit.get('metal'), 0, -0.026, 0, PI / 2, 0, sides === 4 ? PI / 4 : 0);
    g.add(disc);
    g.add(mesh(new THREE.TorusGeometry(0.022, 0.0025, 6, sides === 4 ? 4 : 28), kit.get('trim'), 0, -0.026, 0.002, 0, 0, sides === 4 ? PI / 4 : 0));
    const gem = mesh(new THREE.OctahedronGeometry(0.01), kit.get('gem'), 0, -0.026, 0.005);
    gem.scale.set(1, 1.2, 0.6);
    g.add(gem);
    g.add(mesh(new THREE.TorusGeometry(0.004, 0.0012, 4, 10), kit.get('trim'), 0, -0.002, 0));
  } else {
    // Teardrop carving of bone/wood/stone on a little bail.
    const drop = mesh(lathe([[0.0005, 0], [0.007, -0.006], [0.012, -0.02], [0.009, -0.032], [0.0005, -0.036]], 10), kit.get('primary'));
    drop.scale.z = 0.45;
    g.add(drop);
    g.add(mesh(new THREE.TorusGeometry(0.0035, 0.0012, 4, 10), kit.get('trim'), 0, 0.002, 0));
  }
  return g;
}

/** Cloak brooch (penannular ring + pin) facing +Z. */
export function buildBrooch(c: PartCtx): THREE.Object3D {
  const { kit } = c;
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusGeometry(0.022, 0.0045, 8, 24, PI * 1.75), kit.get('trim'), 0, 0, 0, 0, 0, PI * 0.625));
  for (const s of [1, -1]) g.add(mesh(new THREE.SphereGeometry(0.0065, 8, 6), kit.get('trim'), Math.sin(s * 0.39) * 0.022 * 0.0 + s * 0.008, -0.021, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.0018, 0.001, 0.06, 5), kit.get('metal'), 0.004, 0.0, 0.004, 0, 0, 0.5));
  g.add(mesh(new THREE.OctahedronGeometry(0.006), kit.get('gem'), 0, 0.022, 0.003));
  return g;
}

/** Bone ribs over the chest (harness.bone), chest socket space. */
export function buildBoneRibs(c: PartCtx): THREE.Object3D {
  const { kit, fit } = c;
  const g = new THREE.Group();
  const bone = kit.get('bone');
  const rx = fit.shoulderWidth * 0.46, rz = fit.chestDepth * 0.58;
  for (let i = 0; i < 5; i++) {
    const y = 0.1 - i * 0.05;
    const k = 1 - i * 0.04;
    for (const s of [1, -1]) {
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 6; j++) {
        const a = s * (0.12 + (j / 6) * 1.25);
        pts.push(V(Math.sin(a) * rx * k, y - j * 0.006, Math.cos(a) * rz * k));
      }
      g.add(mesh(taperedTube(pts, (t) => 0.009 * (1 - t * 0.4), 6, 14), bone));
    }
  }
  g.add(mesh(new THREE.BoxGeometry(0.035, 0.26, 0.016), bone, 0, -0.0, rz + 0.004));
  return g;
}

// ------------------------------------------------------------------ shoulders

/** Left pauldron in shoulder.L socket space (outward = +X). */
export function buildPauldron(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, fit, look } = c;
  const g = new THREE.Group();
  const rp = fit.upperArmRadius * 2.05;
  const tilt = -0.55; // dome axis leans outward
  let mat: THREE.Material;
  let lames = 3;
  switch (shape) {
    case 'pauldron.plate': mat = kit.get('metal'); break;
    case 'pauldron.leather': mat = patternMaterial(kit, look, [2, 1]); lames = 2; break;
    case 'pauldron.scale': mat = patternMaterial(kit, look, [4, 2]); lames = 2; break;
    case 'pauldron.bone': mat = kit.v.material === 'bone' ? kit.get('bone') : kit.get('primary'); lames = 1; break;
    default: return null;
  }
  const dome = mesh(sphereShell(rp, 0, PI * 2, 0, PI * 0.52, 24, 10), mat, 0.012, 0.012, 0, 0, 0, tilt);
  dome.scale.set(1, 0.8, 1.05);
  g.add(dome);
  for (let i = 0; i < lames; i++) {
    const r = rp * (1.02 + i * 0.05);
    const band = mesh(sphereShell(r, PI * 0.15, PI * 1.25, PI * (0.45 + i * 0.07), PI * 0.12, 20, 2), mat, 0.012 + i * 0.006, 0.0 - i * 0.026, 0, 0, -PI / 2 + PI * 0.1, tilt);
    band.scale.set(1, 0.85, 1.05);
    g.add(band);
  }
  if (shape === 'pauldron.plate') {
    g.add(rivetRing(kit.get('trim'), rp * 0.75, rp * 0.75, rp * 0.45, 8, 0.004).rotateZ(tilt));
    // Raised haute-piece guarding the neck.
    g.add(mesh(new THREE.CylinderGeometry(rp * 0.6, rp * 0.6, 0.004, 16, 1, false, -PI / 2, PI), kit.get('metal'), -0.02, rp * 0.75, 0, 0, 0, -0.25));
  } else if (shape === 'pauldron.bone') {
    for (let i = 0; i < 3; i++) {
      const a = -0.6 + i * 0.6;
      g.add(mesh(new THREE.ConeGeometry(0.012, 0.07 - i * 0.012, 6), kit.get('bone'), 0.04 + Math.sin(-tilt) * 0.02, rp * 0.75, a * rp * 0.6, 0, 0, tilt * 0.8));
    }
  } else if (shape === 'pauldron.leather') {
    g.add(mesh(new THREE.TorusGeometry(rp * 0.95, 0.003, 4, 24, PI * 1.2), kit.get('dark'), 0.012, 0.0, 0, PI / 2, 0, tilt));
  }
  return g;
}

// ------------------------------------------------------------------ arms & hands

/** Left forearm guard in forearm.L socket space. */
export function buildBracer(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, fit, look } = c;
  const L = limbs(fit).forearm;
  const r0 = fit.forearmRadius * 1.38, r1 = fit.forearmRadius * 1.12;
  const y0 = L * 0.4, y1 = L * 0.93;
  const g = new THREE.Group();
  switch (shape) {
    case 'bracers.leather': {
      g.add(mesh(cyl(r0, r1, y0, y1, 18, true), patternMaterial(kit, look, [2, 1])));
      // Lacing up the inside.
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) pts.push(V((i % 2 ? 1 : -1) * 0.008, y0 + ((y1 - y0) * i) / 10, -(r0 + (r1 - r0) * (i / 10)) - 0.002));
      g.add(mesh(taperedTube(pts, () => 0.0018, 4, 40), kit.get('dark')));
      for (const y of [y0 + 0.005, y1 - 0.005]) g.add(mesh(new THREE.TorusGeometry(y === y0 + 0.005 ? r0 : r1, 0.0025, 4, 20).rotateX(PI / 2), kit.get('dark'), 0, y, 0));
      break;
    }
    case 'bracers.metal': {
      g.add(mesh(cyl(r0 * 0.98, r1 * 0.98, y0, y1, 18, true), kit.get('leather')));
      for (let i = 0; i < 4; i++) {
        const t = (i + 0.5) / 4;
        const y = y0 + (y1 - y0) * t;
        g.add(mesh(cyl(r0 + (r1 - r0) * t + 0.003, r0 + (r1 - r0) * t + 0.003, y - 0.012, y + 0.012, 18, true), kit.get('metal')));
        g.add(rivetRing(kit.get('trim'), r0 + (r1 - r0) * t + 0.004, r0 + (r1 - r0) * t + 0.004, y, 6, 0.0025));
      }
      break;
    }
    case 'vambraces':
    case 'gauntlet.cuff': {
      const metal = kit.get('metal');
      if (shape === 'vambraces') {
        g.add(mesh(cyl(r0 * 1.1 + 0.003, r1 + 0.003, L * 0.12, y1, 20, true), metal));
        g.add(mesh(new THREE.TorusGeometry(r0 * 1.1 + 0.004, 0.003, 5, 20).rotateX(PI / 2), kit.get('trim'), 0, L * 0.12, 0));
        g.add(mesh(taperedTube([V(0, L * 0.14, r0 * 1.1 + 0.004), V(0, y1, r1 + 0.004)], () => 0.0035, 4, 6), metal));
        // Elbow cop.
        const cop = mesh(sphereShell(0.04, 0, PI * 2, 0, PI * 0.45, 14, 6), metal, 0, L * 0.1, -fit.forearmRadius * 0.95, -PI / 2);
        g.add(cop);
        g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.003, 12), metal, fit.forearmRadius * 1.4, L * 0.11, -0.012, 0, 0, PI / 2));
      }
      // Flared cuff at the wrist (also used alone for gauntlets).
      g.add(mesh(cyl(r1 + 0.004, r1 * 1.6, L * 0.8, L * 1.0, 20, true), metal));
      g.add(mesh(new THREE.TorusGeometry(r1 * 1.6, 0.003, 5, 20).rotateX(PI / 2), kit.get('trim'), 0, L * 1.0, 0));
      break;
    }
    case 'gauntlet.cuff.leather': {
      g.add(mesh(cyl(r1 + 0.003, r1 * 1.45, L * 0.82, L * 1.0, 18, true), kit.get('leather')));
      break;
    }
    default:
      return null;
  }
  return g;
}

/** Knuckle plate on the back of the hand (hand socket space, +Z dorsal). */
export function buildKnucklePlate(c: PartCtx): THREE.Object3D {
  const { kit, fit } = c;
  const g = new THREE.Group();
  const metal = kit.get('metal');
  const hl = fit.handLength;
  const plate = mesh(sphereShell(0.06, 0, PI * 2, 0, PI * 0.28, 12, 4), metal, 0, hl * 0.3, -0.035, PI / 2);
  plate.scale.set(0.8, 1, 1.4);
  g.add(plate);
  for (let i = 0; i < 4; i++) g.add(mesh(new THREE.SphereGeometry(0.008, 8, 6), metal, (i - 1.5) * 0.019, hl * 0.52, 0.018));
  return g;
}

/** A ring on the ring finger (hand socket space; right-hand finger layout). */
export function buildRing(shape: string, c: PartCtx): THREE.Object3D {
  const { kit, fit } = c;
  const g = buildRingBody(shape, c);
  // Torus axis along the finger (+Y), setting on the back of the finger (+Z).
  g.rotation.x = -PI / 2;
  g.position.set(-0.018, fit.handLength * 0.66, 0.0);
  g.scale.setScalar(fit.handLength / 0.19);
  const out = new THREE.Group();
  out.add(g);
  void kit;
  return out;
}

/** Ring in its own space: band in the XY plane (axis Z), setting on top (+Y). */
export function buildRingBody(shape: string, c: PartCtx): THREE.Group {
  const { kit } = c;
  const g = new THREE.Group();
  const r = 0.0095;
  const band = mesh(new THREE.TorusGeometry(r, shape === 'ring.signet' ? 0.0026 : 0.0018, 8, 32), kit.get('metal'));
  g.add(band);
  if (shape === 'ring.signet') {
    const face = mesh(new THREE.CylinderGeometry(0.0065, 0.0055, 0.004, 16), kit.get('metal'), 0, r + 0.003, 0);
    g.add(face);
    g.add(mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.0008, 6), kit.get('dark'), 0, r + 0.0052, 0));
  } else if (shape === 'ring.gem') {
    // Four-claw setting with a faceted stone.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2 + PI / 4;
      g.add(mesh(new THREE.CylinderGeometry(0.0007, 0.0009, 0.006, 4), kit.get('trim'), Math.cos(a) * 0.0035, r + 0.004, Math.sin(a) * 0.0035));
    }
    const gem = mesh(new THREE.OctahedronGeometry(0.0045, 0), kit.get('gem'), 0, r + 0.0055, 0);
    gem.scale.set(1, 0.8, 1);
    g.add(gem);
    g.add(mesh(new THREE.CylinderGeometry(0.004, 0.0025, 0.002, 12), kit.get('trim'), 0, r + 0.0018, 0));
  } else {
    // A plain band gets an engraved groove.
    g.add(mesh(new THREE.TorusGeometry(r + 0.0015, 0.0004, 4, 32), kit.get('dark')));
  }
  return g;
}

// ------------------------------------------------------------------ waist

/** Belt in pelvis socket space. Pouches, buckle, tails, faulds included. */
export function buildBelt(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, fit, look } = c;
  const g = new THREE.Group();
  const rb = fit.waistRadius * 1.2;
  const dz = 0.8;
  const y = 0.09;
  const band = new THREE.Group();
  band.scale.z = dz;
  g.add(band);
  const front = rb * dz;
  switch (shape) {
    case 'belt.rope': {
      const rope = kit.tinted('cloth', [0.62, 0.52, 0.34], 'rope');
      band.add(mesh(taperedTube(ringPts(rb, y, 32), (t) => 0.007 + 0.0012 * Math.sin(t * 300), 6, 120, true), rope));
      g.add(mesh(new THREE.SphereGeometry(0.014, 8, 6), rope, rb * 0.5, y, front * 0.86));
      for (const s of [0, 1]) g.add(mesh(taperedTube([V(rb * 0.5, y, front * 0.9), V(rb * (0.52 + s * 0.06), y - 0.12, front * 0.95), V(rb * (0.5 + s * 0.1), y - 0.24 + s * 0.04, front * 0.92)], (t) => 0.0065 * (1 - t * 0.3), 6, 16), rope));
      return g;
    }
    case 'sash': {
      const mat = patternMaterial(kit, look, [4, 1]);
      band.add(mesh(cyl(rb * 1.02, rb, y - 0.045, y + 0.045, 28, true), mat));
      g.add(mesh(new THREE.SphereGeometry(0.025, 8, 6), mat, rb * 0.75, y, front * 0.6));
      for (const [s, len] of [[0, 0.32], [1, 0.25]] as [number, number][]) {
        const t = mesh(taperedTube([V(rb * 0.78, y - 0.01, front * 0.62), V(rb * (0.82 + s * 0.05), y - len * 0.5, front * 0.7), V(rb * (0.84 + s * 0.06), y - len, front * 0.66)], (k) => 0.03 - k * 0.006, 8, 14), mat);
        t.scale.z = 0.4;
        g.add(t);
      }
      return g;
    }
    case 'belt.leather':
    case 'belt.pouches':
    case 'belt.plated': {
      const leather = kit.v.material === 'leather' ? kit.get('primary') : kit.get('leather');
      band.add(mesh(cyl(rb * 1.01, rb, y - 0.022, y + 0.022, 32, true), leather));
      if (shape === 'belt.plated') {
        const metal = kit.get('metal');
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * PI * 2 + PI / 12;
          band.add(mesh(new THREE.BoxGeometry(0.03, 0.04, 0.004), metal, Math.sin(a) * (rb + 0.004), y, Math.cos(a) * (rb + 0.004), 0, a, 0));
        }
      }
      // Buckle frame + prong + belt tip.
      const trim = kit.get('trim');
      const buckle = new THREE.Group();
      buckle.position.set(0, y, front + 0.004);
      const bw = 0.04, bh = 0.05;
      buckle.add(mesh(new THREE.BoxGeometry(bw, 0.006, 0.006), trim, 0, bh / 2));
      buckle.add(mesh(new THREE.BoxGeometry(bw, 0.006, 0.006), trim, 0, -bh / 2));
      buckle.add(mesh(new THREE.BoxGeometry(0.006, bh, 0.006), trim, -bw / 2, 0));
      buckle.add(mesh(new THREE.BoxGeometry(0.006, bh, 0.006), trim, bw / 2, 0));
      buckle.add(mesh(new THREE.BoxGeometry(0.004, 0.003, 0.03), trim, 0, 0, 0.004, 0, 0, PI / 2).rotateZ(PI / 2));
      g.add(buckle);
      g.add(mesh(new THREE.BoxGeometry(0.035, 0.04, 0.004), leather, -0.035, y - 0.02, front + 0.002, 0, 0, 0.2));
      const pouchCount = shape === 'belt.pouches' ? 3 : shape === 'belt.leather' ? 1 : 0;
      const angles = [0.95, -1.1, 1.6];
      for (let i = 0; i < pouchCount; i++) {
        const a = angles[i];
        const p = buildPouch(c, i === 2 ? 0.8 : 1);
        p.position.set(Math.sin(a) * (rb + 0.02), y - 0.04, Math.cos(a) * (rb * dz + 0.02));
        p.rotation.y = a;
        g.add(p);
      }
      if (shape === 'belt.pouches') {
        // Dagger frog: a small sheath on the back-left.
        const a = PI * 0.78;
        const sheath = mesh(new THREE.CylinderGeometry(0.012, 0.006, 0.2, 8), leather, Math.sin(a) * (rb + 0.02), y - 0.1, Math.cos(a) * (rb * dz + 0.02), 0.3, 0, 0.35);
        sheath.scale.z = 0.5;
        g.add(sheath);
        g.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), trim, Math.sin(a) * (rb + 0.01) + 0.02, y + 0.02, Math.cos(a) * (rb * dz + 0.01)));
      }
      return g;
    }
    default:
      return null;
  }
}

function ringPts(r: number, y: number, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2;
    out.push(V(Math.sin(a) * r, y + Math.sin(a * 3) * 0.003, Math.cos(a) * r));
  }
  return out;
}

/** Leather pouch with flap and toggle; origin at its top-back (against the belt). */
export function buildPouch(c: PartCtx, s = 1): THREE.Object3D {
  const { kit } = c;
  const g = new THREE.Group();
  const leather = kit.get('leather');
  const body = mesh(new THREE.SphereGeometry(0.04 * s, 12, 8), leather, 0, -0.01 * s, 0.025 * s);
  body.scale.set(1, 1.15, 0.55);
  g.add(body);
  const flap = mesh(sphereShell(0.042 * s, 0, PI * 2, 0, PI * 0.45, 12, 4), leather, 0, 0.0, 0.025 * s);
  flap.scale.set(1, 0.6, 0.58);
  g.add(flap);
  g.add(mesh(new THREE.SphereGeometry(0.006 * s, 6, 4), kit.get('trim'), 0, -0.012 * s, 0.05 * s));
  return g;
}

/** Tasset lames hanging over the front-outer thigh (thigh.L socket; +Y runs down the thigh). */
export function buildTasset(c: PartCtx): THREE.Object3D {
  const { kit, fit } = c;
  const g = new THREE.Group();
  const metal = kit.get('metal');
  const r = fit.thighRadius * 1.45;
  for (let i = 0; i < 3; i++) {
    const y = -0.02 + i * 0.055;
    const lame = mesh(new THREE.CylinderGeometry(r + i * 0.003, r + i * 0.003 + 0.004, 0.065, 16, 1, true, -0.7, 2.3), metal, 0, y, 0);
    g.add(lame);
    g.add(rivetRing(kit.get('trim'), r + i * 0.003 + 0.002, r + i * 0.003 + 0.002, y - 0.025, 5, 0.003, 2.0, -0.55));
  }
  return g;
}

// ------------------------------------------------------------------ legs & feet

/** Greave over the front of the shin (shin.L socket; +Y toward the ankle). */
export function buildGreave(c: PartCtx, material: 'metal' | 'leather' = 'metal'): THREE.Object3D {
  const { kit, fit } = c;
  const L = limbs(fit).shin;
  const g = new THREE.Group();
  const mat = material === 'metal' ? kit.get('metal') : kit.get('leather');
  const r0 = fit.shinRadius * 1.38, r1 = fit.shinRadius * 1.08;
  const shell = mesh(new THREE.CylinderGeometry(r1, r0, L * 0.78, 18, 4, true, -1.75, 3.5), mat, 0, L * 0.5, 0.004);
  // Calf swell.
  displace(shell.geometry, (p) => { const t = (p.y + L * 0.39) / (L * 0.78); const k = 1 + Math.sin(t * PI) * 0.12 * (1 - t * 0.5); p.x *= k; p.z *= k; });
  g.add(shell);
  if (material === 'metal') {
    g.add(mesh(taperedTube([V(0, L * 0.12, r0 + 0.006), V(0, L * 0.5, r0 * 1.02 + 0.006), V(0, L * 0.88, r1 + 0.004)], () => 0.004, 4, 12), mat));
    g.add(mesh(new THREE.TorusGeometry(r1 + 0.002, 0.003, 4, 16, 3.5).rotateX(PI / 2).rotateY(-PI / 2 - 1.75 + PI), kit.get('trim'), 0, L * 0.89, 0.004));
  } else {
    for (const y of [0.25, 0.55, 0.8]) g.add(mesh(new THREE.TorusGeometry(fit.shinRadius * 1.25, 0.004, 4, 18).rotateX(PI / 2), kit.get('dark'), 0, L * y, 0));
  }
  return g;
}

/** Knee cop (shin socket space, origin at the knee). */
export function buildKneeCop(c: PartCtx, material: 'metal' | 'leather' = 'metal'): THREE.Object3D {
  const { kit, fit } = c;
  const g = new THREE.Group();
  const mat = material === 'metal' ? kit.get('metal') : kit.get('leather');
  const cop = mesh(sphereShell(0.05, 0, PI * 2, 0, PI * 0.42, 16, 6), mat, 0, 0.0, fit.shinRadius * 0.95, PI / 2);
  cop.scale.set(1, 1, 0.7);
  g.add(cop);
  if (material === 'metal') {
    // Fan-shaped wing on the outside of the knee.
    const wing = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.003, 16, 1, false, 0, PI), mat, fit.shinRadius * 1.15, 0, 0.02, 0, 0, PI / 2);
    g.add(wing);
    g.add(mesh(new THREE.SphereGeometry(0.006, 6, 4), kit.get('trim'), 0, 0, fit.shinRadius * 0.95 + 0.04));
  }
  return g;
}

/** Boot top (cuff fold or fur ruff) at shin fraction `at` (shin socket space). */
export function buildBootCuff(c: PartCtx, at: number, fur: boolean): THREE.Object3D {
  const { kit, fit, look } = c;
  const L = limbs(fit).shin;
  const r = fit.shinRadius * (1.4 - at * 0.25);
  const mat = fur ? patternMaterial(kit, look, [4, 1], 'fur') : kit.get('leather');
  const m = mesh(lathe([[r * 0.98, -0.005], [r * 1.18, 0.012], [r * 1.22, 0.045], [r * 1.05, 0.07]], 20), mat, 0, L * at, 0);
  if (fur) displace(m.geometry, (p) => { const a = Math.atan2(p.x, p.z); const k = 1 + Math.sin(a * 11) * 0.06; p.x *= k; p.z *= k; });
  return m;
}

/** Plate sabaton lames + pointed toe (foot socket space: +Y toes, +Z up). */
export function buildSabaton(c: PartCtx): THREE.Object3D {
  const { kit, fit } = c;
  const g = new THREE.Group();
  const metal = kit.get('metal');
  const fl = fit.footLength;
  for (let i = 0; i < 5; i++) {
    const y = fl * (0.05 + i * 0.13);
    const r = 0.048 - i * 0.004;
    const lame = mesh(new THREE.CylinderGeometry(r, r, fl * 0.15, 14, 1, true, -PI / 2, PI), metal, 0, y, -0.035 + i * -0.004, 0, 0, 0);
    g.add(lame);
  }
  const toe = mesh(lathe([[0.034, 0], [0.03, fl * 0.12], [0.012, fl * 0.24], [0.001, fl * 0.32]], 12, -PI / 2, PI), metal, 0, fl * 0.68, -0.055);
  toe.scale.z = 0.8;
  g.add(toe);
  // Rotate lames so their open side faces down (-Z): cylinders around Y have the half (-π/2..π/2) on +Z already.
  return g;
}

/** Sandal sole with crossing straps (foot socket space). */
export function buildSandal(c: PartCtx): THREE.Object3D {
  const { kit, fit } = c;
  const g = new THREE.Group();
  const leather = kit.get('leather');
  const fl = fit.footLength;
  const s2 = new THREE.Group();
  s2.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 20), leather));
  s2.scale.set(1, 1, fl / 0.09 * 0.62);
  s2.rotation.x = PI / 2;
  s2.position.set(0, fl * 0.35, -0.068);
  g.add(s2);
  for (let i = 0; i < 3; i++) {
    const y = fl * (0.12 + i * 0.22);
    g.add(mesh(new THREE.TorusGeometry(0.042 - i * 0.004, 0.0035, 4, 16, PI), leather, 0, y, -0.062 + i * 0.004, PI / 2, 0, 0));
  }
  g.add(mesh(new THREE.TorusGeometry(0.045, 0.004, 4, 20).rotateX(PI / 2), leather, 0, -0.005, 0.0));
  return g;
}
