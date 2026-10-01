/**
 * Ranged weapons & ammunition: bows (short/long/recurve), crossbow, sling,
 * arrows, bolts and sling stones.
 *
 * Bows: weapon space +Y along the limbs, grip at origin, the string on −X
 * (archer side), arrows fly toward +X (→ item +Z). Crossbow: the stock runs
 * along +X (forward → item +Z), +Y up, origin at the trigger grip. Arrows &
 * bolts: origin at the nock, +Y toward the head.
 */
import * as THREE from 'three';
import { mesh, lathe, cyl, extrudeOutline, wrappedGrip, type V2 } from './util';
import { type WCtx, sweep, mergeAll, place, rod, deform, smooth } from './weapons_parts';

const V = THREE.Vector3;
const Z = new V(0, 0, 1);

/** Bow limbs + string. `curl` > 0 makes recurve tips. Returns tip points. */
function bow(c: WCtx, L: number, depth: number, curl: number, w0: number, t0: number) {
  const { kit, g } = c;
  const half = L / 2;
  const n = 14;
  const pts: THREE.Vector3[] = [];
  const xAt = (s: number) => -depth * s * s + curl * Math.pow(smooth(0.68, 1, s), 2) * depth * 4;
  for (let i = -n; i <= n; i++) {
    const s = Math.abs(i / n);
    pts.push(new V(xAt(s), (i / n) * half, 0));
  }
  // Thickness (along X ~ frame normal) and width (along Z) taper toward tips;
  // the riser at the centre is thick.
  const limb = sweep(pts, (t) => {
    const s = Math.abs(t * 2 - 1);
    const riser = Math.exp(-((s / 0.1) ** 2));
    return [t0 * (1 - 0.6 * s) + t0 * 0.9 * riser, w0 * (1 - 0.55 * s) + w0 * 0.15 * riser];
  }, { segs: 56, radial: 8, plane: Z });
  const lm = mesh(limb, kit.get('wood'));
  g.add(lm);
  c.heads.push(lm);
  // Belly laminate (horn/sinew) on recurves.
  if (curl > 0) {
    const belly = sweep(pts.map((p) => p.clone().add(new V(-t0 * 0.55, 0, 0))), (t) => {
      const s = Math.abs(t * 2 - 1);
      return [t0 * 0.35 * (1 - 0.6 * s), w0 * 0.85 * (1 - 0.55 * s)];
    }, { segs: 40, radial: 6, plane: Z });
    g.add(mesh(belly, kit.get('bone')));
  }
  g.add(mesh(wrappedGrip(t0 * 1.6, -0.055, 0.055, 7, 10), kit.get('grip')));
  // Arrow rest.
  g.add(mesh(new THREE.BoxGeometry(0.012, 0.01, 0.012), kit.get('leather'), t0 * 0.8, 0.06, 0.006));
  // Nocks (horn caps) and string.
  const tipTop = new V(xAt(1), half, 0), tipBot = new V(xAt(1), -half, 0);
  for (const tp of [tipTop, tipBot]) g.add(mesh(new THREE.SphereGeometry(t0 * 0.55, 8, 6), kit.get('bone'), tp.x, tp.y, tp.z));
  const sTop = new V(curl > 0 ? xAt(0.82) : tipTop.x, curl > 0 ? half * 0.82 : half - 0.01, 0);
  const sBot = new V(sTop.x, -sTop.y, 0);
  const strMat = c.v.glow > 0.05 ? kit.get('glow') : kit.get('string');
  g.add(mesh(rod(sBot, sTop, 0.0013, 4), strMat));
  // Serving where the arrow nocks.
  g.add(mesh(cyl(0.0022, 0.0022, -0.03, 0.03, 5), kit.get('dark'), sTop.x, 0, 0));
  return { tipTop, tipBot };
}

/** Feather vane outline (y along shaft). */
function vane(len: number, h: number): V2[] {
  return [[0, 0], [h * 0.6, len * 0.15], [h, len * 0.55], [h * 0.8, len * 0.95], [0, len]];
}

function fletch(c: WCtx, y0: number, len: number, h: number, count: number, r: number, mat: THREE.Material) {
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const vg = extrudeOutline(vane(len, h), 0.0008);
    vg.translate(r, y0, 0);
    vg.rotateY((i / count) * Math.PI * 2 + 0.3);
    geos.push(vg);
  }
  c.g.add(mesh(mergeAll(geos), mat));
}

export function buildRanged(shape: string, c: WCtx): boolean {
  const { kit, rng, g } = c;
  switch (shape) {
    case 'bow.short':
      bow(c, rng.range(1.08, 1.2), 0.15, 0, 0.022, 0.012);
      return true;
    case 'bow.long':
      bow(c, rng.range(1.7, 1.85), 0.2, 0, 0.026, 0.016);
      return true;
    case 'bow.recurve': {
      bow(c, rng.range(1.15, 1.3), 0.1, 0.35 + c.st.curve * 0.2, 0.024, 0.013);
      if (c.st.motif === 'scales' || c.st.motif === 'leafvine' || rng.chance(0.4)) for (const sy of [1, -1]) g.add(mesh(new THREE.TorusGeometry(0.02, 0.003, 5, 12), kit.get('trim'), 0, sy * 0.1, 0, Math.PI / 2));
      return true;
    }
    case 'crossbow': {
      // Stock (side profile, extruded across Z).
      const ol: V2[] = [[-0.45, 0.02], [-0.42, 0.06], [-0.1, 0.05], [0.31, 0.04], [0.32, 0.0], [0.05, -0.01], [0.03, -0.03], [0.015, -0.1], [-0.025, -0.11], [-0.03, -0.03], [-0.1, -0.02], [-0.44, -0.06]];
      g.add(mesh(extrudeOutline(ol, 0.042, 0.004), kit.get('wood')));
      // Rail with bolt groove.
      g.add(mesh(new THREE.BoxGeometry(0.4, 0.008, 0.014), kit.get('bone'), 0.1, 0.048, 0));
      // Prod: steel bow across Z at the front, tips pulled back.
      const prodPts: THREE.Vector3[] = [];
      for (let i = -8; i <= 8; i++) {
        const s = i / 8;
        prodPts.push(new V(0.29 - 0.07 * s * s, 0.035, s * 0.33));
      }
      const prod = sweep(prodPts, (t) => { const s = Math.abs(t * 2 - 1); return [0.012 * (1 - s * 0.5), 0.008 * (1 - s * 0.4)]; }, { segs: 32, radial: 6, plane: new V(0, 1, 0) });
      const pm = mesh(prod, c.v.material === 'wood' ? kit.get('dark') : kit.get('blade'));
      g.add(pm);
      c.heads.push(pm);
      g.add(mesh(new THREE.BoxGeometry(0.04, 0.05, 0.06), kit.get('dark'), 0.29, 0.035, 0));
      // String spanned back to the nut.
      const nut = new V(0.02, 0.055, 0);
      for (const sz of [1, -1]) g.add(mesh(rod(new V(0.22, 0.035, sz * 0.33), nut, 0.0015, 4), kit.get('string')));
      g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.022, 10), kit.get('bone'), 0.02, 0.05, 0, Math.PI / 2));
      // Stirrup loop at the front.
      const stir = new THREE.TorusGeometry(0.05, 0.005, 5, 14, Math.PI);
      g.add(mesh(stir, kit.get('dark'), 0.335, 0.035, 0, 0, 0, -Math.PI / 2));
      // Trigger lever under the stock.
      g.add(mesh(sweep([new V(-0.02, -0.02, 0), new V(-0.06, -0.06, 0), new V(-0.13, -0.08, 0), new V(-0.2, -0.075, 0)], () => [0.004, 0.004], { segs: 10, radial: 5 }), kit.get('dark')));
      // Bindings & rivets.
      for (const bx of [0.24, 0.27]) g.add(mesh(new THREE.BoxGeometry(0.008, 0.08, 0.048), kit.get('string'), bx, 0.02, 0));
      for (const [rx, ry] of [[-0.3, 0.0], [-0.2, 0.02], [0.15, 0.02]]) g.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.046, 6), kit.get('trim'), rx, ry, 0, Math.PI / 2));
      return true;
    }
    case 'sling': {
      // Finger loop at the origin, two cords to a leather cradle with a stone.
      g.add(mesh(new THREE.TorusGeometry(0.012, 0.002, 5, 12), kit.get('string'), 0, 0, 0));
      const pouchY = -0.5;
      for (const sx of [1, -1]) g.add(mesh(sweep([new V(0, -0.01, 0), new V(sx * 0.01, -0.2, 0), new V(sx * 0.025, -0.4, 0), new V(sx * 0.04, pouchY, 0)], () => [0.0016, 0.0016], { segs: 16, radial: 4 }), kit.get('string')));
      const pouch = new THREE.SphereGeometry(0.04, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55);
      pouch.scale(1.2, 0.8, 0.9);
      g.add(mesh(pouch, kit.get('leather'), 0, pouchY + 0.025, 0));
      g.add(mesh(new THREE.IcosahedronGeometry(0.02, 1), kit.tinted('stone', [0.45, 0.44, 0.42], 'pebble'), 0, pouchY - 0.005, 0));
      return true;
    }
    case 'ammo.arrow': {
      const L = 0.75;
      g.add(mesh(cyl(0.004, 0.004, 0, L, 6), kit.get('wood')));
      // Nock.
      g.add(mesh(lathe([[0.0045, 0], [0.0045, 0.012], [0.004, 0.016]], 6), kit.get('bone'), 0, -0.004, 0));
      fletch(c, 0.025, 0.11, 0.011, 3, 0.003, kit.tinted('cloth', c.v.accent, 'fletch'));
      // Head: bodkin or broadhead.
      if (rng.chance(0.5)) g.add(mesh(new THREE.ConeGeometry(0.006, 0.05, 4), kit.get('dark'), 0, L + 0.025, 0));
      else {
        const hd = extrudeOutline([[0, 0], [0.016, 0.012], [0.004, 0.012], [0, 0.055], [-0.004, 0.012], [-0.016, 0.012]], 0.0025, 0.0005);
        g.add(mesh(hd, kit.get('dark'), 0, L - 0.005, 0));
        g.add(mesh(cyl(0.005, 0.0045, L - 0.015, L + 0.005, 6), kit.get('dark')));
      }
      // Cresting bands.
      g.add(mesh(cyl(0.0042, 0.0042, 0.15, 0.16, 6), kit.tinted('cloth', c.v.accent, 'crest')));
      return true;
    }
    case 'ammo.bolt': {
      const L = 0.36;
      g.add(mesh(cyl(0.006, 0.0055, 0, L, 6), kit.get('wood')));
      fletch(c, 0.01, 0.07, 0.012, 2, 0.004, kit.get('leather'));
      g.add(mesh(lathe([[0.0065, 0], [0.008, 0.01], [0.0035, 0.035], [0, 0.04]], 4), kit.get('dark'), 0, L - 0.005, 0));
      return true;
    }
    case 'ammo.stone': {
      const geos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const s = new THREE.IcosahedronGeometry(0.02, 1);
        const sx = 0.9 + rng.float() * 0.4, sy = 0.65 + rng.float() * 0.25;
        deform(s, (p) => p.set(p.x * sx, p.y * sy, p.z));
        place(s, (i % 2) * 0.035 - 0.017, 0.013 + (i === 3 ? 0.022 : 0), Math.floor(i / 2) * 0.03 - 0.015, rng.float(), rng.float() * 3, 0);
        geos.push(s);
      }
      g.add(mesh(mergeAll(geos), kit.get('stone')));
      return true;
    }
    default:
      return false;
  }
}
