/**
 * Apparel display models: how worn items look when NOT worn — lying on the
 * ground, in inventory icons, in the sandbox. Soft garments become hollow,
 * mannequin-less garments (torso, sleeves, skirts, hoods, legs, boots,
 * gloves) wearing the same pattern texture the body shell would; rigid parts
 * reuse the socket-space builders from ./rigid with the default body fit.
 *
 * Space: origin at the resting base (lowest point at y = 0, centred in XZ),
 * +Y up, +Z front. Meters.
 */
import * as THREE from 'three';
import type { ItemMatKit } from '../materials';
import { mesh, lathe, cyl, type V2 } from '../meshes/util';
import { DEFAULT_FIT, taperedTube, displace, mirrorX, rivetRing } from './fit';
import { patternMaterial, voidMaterial, type Look } from './look';
import type { DisplayPattern } from './patterns';
import {
  buildHeadwear, buildMask, buildNeckPiece, buildPauldron, buildBracer, buildBelt, buildGreave, buildKneeCop, buildRingBody, buildPendantBody,
  buildBrooch, buildBoneRibs, buildBootCuff, buildTasset, type PartCtx,
} from './rigid';
import type { Rng } from '../../../core/rng';

const PI = Math.PI;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Re-centre an object so it rests on y = 0, centred in XZ. */
export function grounded(obj: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.add(obj);
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    obj.position.y -= box.min.y;
  }
  return g;
}

// ------------------------------------------------------------------ torso garments

interface TorsoSpec {
  /** Sleeve length (m); 0 = sleeveless. */
  sleeves: number;
  /** Sleeve flare: 0 = straight, 1 = wide bell. */
  bell?: number;
  skirt: number;
  flare?: number;
  slits?: number;
  /** Open front gap (radians) for coats. */
  open?: number;
  belt?: boolean;
  collar?: 'none' | 'laced' | 'high' | 'lapel';
  buttons?: boolean;
  /** Visible under-layer (gambeson under mail etc.). */
  under?: { sleeves: number; skirt: number; pattern: DisplayPattern };
  ragged?: boolean;
  cuirass?: boolean;
  ribs?: boolean;
}

export const TORSO: Record<string, TorsoSpec> = {
  shirt: { sleeves: 0.5, skirt: 0.06, collar: 'laced' },
  tunic: { sleeves: 0.27, skirt: 0.3, flare: 0.35, slits: 2, belt: true, collar: 'laced' },
  vest: { sleeves: 0, skirt: 0.04, buttons: true, collar: 'none' },
  doublet: { sleeves: 0.5, skirt: 0.09, buttons: true, collar: 'high' },
  'robe.short': { sleeves: 0.46, bell: 0.6, skirt: 0.32, flare: 0.4, belt: true, collar: 'none' },
  'robe.long': { sleeves: 0.5, bell: 0.9, skirt: 0.95, flare: 0.45, belt: true, collar: 'high' },
  'robe.gown': { sleeves: 0.52, bell: 1.2, skirt: 1.0, flare: 0.7, collar: 'none' },
  'coat.long': { sleeves: 0.5, skirt: 0.75, flare: 0.3, open: 0.4, collar: 'lapel', buttons: true, belt: true },
  gambeson: { sleeves: 0.5, skirt: 0.18, flare: 0.2, collar: 'high', buttons: true },
  jerkin: { sleeves: 0.05, skirt: 0.13, belt: true, collar: 'laced' },
  brigandine: { sleeves: 0, skirt: 0.15, flare: 0.15, collar: 'none', under: { sleeves: 0.48, skirt: 0.22, pattern: 'quilted' } },
  hide: { sleeves: 0.12, skirt: 0.22, flare: 0.3, ragged: true, belt: true, buttons: true, collar: 'none' },
  hauberk: { sleeves: 0.32, skirt: 0.38, flare: 0.25, slits: 2, belt: true, collar: 'high', under: { sleeves: 0.5, skirt: 0.43, pattern: 'quilted' } },
  scale: { sleeves: 0.13, skirt: 0.26, flare: 0.25, belt: true, collar: 'none', under: { sleeves: 0.45, skirt: 0.32, pattern: 'quilted' } },
  lamellar: { sleeves: 0.13, skirt: 0.3, flare: 0.25, slits: 2, belt: true, collar: 'none', under: { sleeves: 0.45, skirt: 0.34, pattern: 'quilted' } },
  cuirass: { sleeves: 0, skirt: 0, cuirass: true, collar: 'none', under: { sleeves: 0.42, skirt: 0.3, pattern: 'chainmail' } },
  'harness.bone': { sleeves: 0, skirt: 0.15, ribs: true, belt: true, collar: 'none' },
};

/** Torso body profile (radius, y) from the hips (y = 0) to the neck hole. */
const BODY: V2[] = [[0.165, 0], [0.152, 0.12], [0.17, 0.26], [0.186, 0.36], [0.178, 0.44], [0.115, 0.49], [0.068, 0.52]];
const DEPTH = 0.62;

function underLook(look: Look, pattern: DisplayPattern): Look {
  const chain = pattern === 'chainmail';
  return {
    ...look,
    family: chain ? 'chain' : 'padded',
    pattern,
    color: chain ? [0.55, 0.56, 0.58] : [0.64, 0.58, 0.46],
    color2: chain ? [0.3, 0.3, 0.32] : [0.38, 0.33, 0.26],
    roughness: chain ? 0.4 : 0.92,
    metalness: chain ? 0.85 : 0,
    metallic: chain,
  };
}

function patRep(look: Look): [number, number] {
  switch (look.pattern) {
    case 'chainmail': return [12, 6];
    case 'scales': return [8, 4];
    case 'lamellar': return [5, 3];
    case 'studded': return [5, 3];
    case 'quilted': return [4, 3];
    case 'plates': return [2, 3];
    case 'embroidered': return [1, 1];
    case 'checks': return [3, 3];
    default: return [2, 2];
  }
}

/** Hanging sleeve from the left shoulder (mirrored for right). */
function sleeve(len: number, bell: number, mat: THREE.Material, side: 1 | -1, r = 0.062): THREE.Object3D {
  const g = new THREE.Group();
  g.position.set(side * 0.18, 0.43, 0);
  g.rotation.z = side * 0.32;
  const rEnd = r * (0.85 + bell * 0.9);
  const m = mesh(cyl(rEnd, r, -len, 0, 16, true), mat);
  if (bell > 0.3) displace(m.geometry, (p) => { const t = -p.y / len; p.z += t * t * bell * 0.04; p.x += Math.sin(Math.atan2(p.x, p.z) * 6) * 0.004 * t; });
  m.scale.z = 0.92;
  g.add(m);
  g.userData.end = len;
  return g;
}

function skirtGeo(len: number, flare: number, r0: number, phiStart = 0, phiLen = PI * 2, ragged = false): THREE.BufferGeometry {
  const r1 = r0 + flare * len * 0.6;
  const geo = lathe([[r0, 0], [r0 + (r1 - r0) * 0.3, -len * 0.35], [r1, -len]], 40, phiStart, phiLen);
  displace(geo, (p) => {
    const t = -p.y / len;
    const a = Math.atan2(p.x, p.z);
    const fold = 1 + Math.sin(a * 11) * 0.03 * t * (0.5 + flare);
    p.x *= fold;
    p.z *= fold;
    if (ragged && t > 0.85) p.y += (Math.sin(a * 23) * 0.5 + 0.5) * len * 0.12 * (t - 0.85) / 0.15;
  });
  return geo;
}

function torsoLayer(spec: TorsoSpec, mat: THREE.Material, trim: THREE.Material | null, inflate: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Group();
  body.scale.z = DEPTH;
  g.add(body);
  const prof = BODY.map(([r, y]) => [r + inflate, y] as V2);
  if (spec.open) {
    body.add(mesh(lathe(prof, 36, spec.open / 2, PI * 2 - spec.open), mat));
  } else body.add(mesh(lathe(prof, 36), mat));
  // Skirt (with slits in the lower half).
  if (spec.skirt > 0) {
    const r0 = BODY[0][0] + inflate;
    const flare = spec.flare ?? 0.1;
    if (spec.open) body.add(mesh(skirtGeo(spec.skirt, flare, r0, spec.open / 2, PI * 2 - spec.open, spec.ragged), mat));
    else if (spec.slits) {
      const n = spec.slits;
      const gap = 0.18;
      for (let i = 0; i < n; i++) {
        const start = (i / n) * PI * 2 + gap / 2;
        body.add(mesh(skirtGeo(spec.skirt, flare, r0, start, (PI * 2) / n - gap, spec.ragged), mat));
      }
    } else body.add(mesh(skirtGeo(spec.skirt, flare, r0, 0, PI * 2, spec.ragged), mat));
    if (trim) {
      const rEnd = r0 + flare * spec.skirt * 0.6;
      body.add(mesh(new THREE.TorusGeometry(rEnd, 0.006, 5, 40).rotateX(PI / 2), trim, 0, -spec.skirt, 0));
    }
  } else if (trim) body.add(mesh(new THREE.TorusGeometry(BODY[0][0] + inflate, 0.006, 5, 40).rotateX(PI / 2), trim, 0, 0, 0));
  if (spec.sleeves > 0)
    for (const s of [1, -1] as const) {
      const sl = sleeve(spec.sleeves, spec.bell ?? 0, mat, s, 0.062 + inflate);
      if (trim) {
        const rEnd = (0.062 + inflate) * (0.85 + (spec.bell ?? 0) * 0.9);
        sl.add(mesh(new THREE.TorusGeometry(rEnd, 0.005, 5, 20).rotateX(PI / 2), trim, 0, -spec.sleeves, 0));
      }
      g.add(sl);
    }
  if (trim) body.add(mesh(new THREE.TorusGeometry(BODY[BODY.length - 1][0] + inflate, 0.007, 5, 28).rotateX(PI / 2), trim, 0, BODY[BODY.length - 1][1], 0));
  return g;
}

function buildTorsoDisplay(shape: string, c: PartCtx): THREE.Object3D | null {
  const spec = TORSO[shape];
  if (!spec) return null;
  const { kit } = c;
  // The bone harness is strapped onto a dark leather jerkin.
  const look: Look = shape === 'harness.bone'
    ? { ...c.look, pattern: 'leather', color: [0.36, 0.24, 0.15], color2: [0.2, 0.13, 0.08], metallic: false, roughness: 0.7, metalness: 0 }
    : c.look;
  const root = new THREE.Group();
  const clothy = look.family === 'cloth' || look.family === 'robe' || look.family === 'padded';
  const trim = clothy ? kit.tinted('cloth', look.accent, 'trim') : look.metallic ? kit.get('trim') : kit.get('dark');
  if (spec.under) {
    const ul = underLook(look, spec.under.pattern);
    const um = patternMaterial(kit, ul, patRep(ul), spec.under.pattern, ':under');
    root.add(torsoLayer({ sleeves: spec.under.sleeves, skirt: spec.under.skirt, flare: 0.15, collar: 'none' }, um, null, 0));
  }
  if (spec.cuirass) root.add(buildCuirass(c));
  else {
    const mat = patternMaterial(kit, look, patRep(look));
    root.add(torsoLayer(spec, mat, trim, spec.under ? 0.008 : 0));
  }
  // Collar details.
  const top = BODY[BODY.length - 1];
  if (spec.collar === 'high') root.add(mesh(cyl(top[0] + 0.01, top[0] + 0.004, top[1] - 0.01, top[1] + 0.05, 24, true), patternMaterial(kit, look, [2, 1])).translateZ(0).rotateY(0));
  if (spec.collar === 'lapel')
    for (const s of [1, -1]) {
      const lap = mesh(new THREE.PlaneGeometry(0.06, 0.2), patternMaterial(kit, look, [1, 1]), s * 0.05, 0.42, 0.105, -0.25, s * 0.35, s * 0.25);
      root.add(lap);
    }
  if (spec.collar === 'laced') {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) pts.push(V((i % 2 ? 1 : -1) * 0.012, 0.52 - i * 0.022, 0.07 + i * 0.0045));
    root.add(mesh(taperedTube(pts, () => 0.0018, 4, 30), kit.get('dark')));
  }
  if (spec.buttons) {
    const btn = look.family === 'fur' ? kit.get('bone') : kit.get('trim');
    for (let i = 0; i < 6; i++) {
      const y = 0.45 - i * 0.075;
      const prof = y > 0.36 ? 0.183 : 0.165;
      root.add(mesh(new THREE.SphereGeometry(look.family === 'fur' ? 0.009 : 0.0065, 8, 6), btn, spec.open ? 0.07 : 0, y, prof * DEPTH + 0.012));
    }
  }
  if (spec.belt) {
    const belt = new THREE.Group();
    belt.scale.z = DEPTH;
    const r = BODY[1][0] + (spec.under ? 0.014 : 0.006);
    const beltMat = look.family === 'robe' ? kit.tinted('cloth', look.color2, 'sash') : kit.get('leather');
    belt.add(mesh(cyl(r, r, 0.1, 0.14, 32, true), beltMat));
    root.add(belt);
    root.add(mesh(new THREE.BoxGeometry(0.03, 0.035, 0.008), kit.get('trim'), 0, 0.12, r * DEPTH + 0.004));
  }
  if (spec.ribs) {
    const ribs = buildBoneRibs(c);
    ribs.position.set(0, 0.32, 0);
    ribs.scale.set(1, 1, 0.9);
    root.add(ribs);
  }
  return root;
}

/** Plate cuirass: smooth breast/back with medial ridge, arm-hole rolls, fauld lames, rivets. */
function buildCuirass(c: PartCtx): THREE.Object3D {
  const { kit } = c;
  const metal = kit.get('metal');
  const trim = kit.get('trim');
  const g = new THREE.Group();
  const body = new THREE.Group();
  body.scale.z = DEPTH;
  g.add(body);
  const prof: V2[] = [[0.168, 0.08], [0.16, 0.14], [0.18, 0.26], [0.196, 0.35], [0.185, 0.43], [0.13, 0.48], [0.09, 0.5]];
  const shell = mesh(lathe(prof, 40), metal);
  // Pigeon-breast: push the front outward toward the centre line.
  displace(shell.geometry, (p) => { const a = Math.atan2(p.x, p.z); if (Math.abs(a) < 1.2) { const k = Math.cos(a / 1.2 * PI / 2); p.z += k * k * 0.018 * Math.sin(Math.min(1, (p.y - 0.08) / 0.4) * PI); } });
  body.add(shell);
  body.add(mesh(taperedTube([V(0, 0.1, 0.168), V(0, 0.26, 0.212), V(0, 0.4, 0.2)], () => 0.004, 4, 16), metal));
  // Fauld: three overlapping lames below the waist.
  for (let i = 0; i < 3; i++) {
    const y0 = 0.08 - i * 0.045;
    body.add(mesh(lathe([[0.175 + i * 0.01, y0 - 0.05], [0.165 + i * 0.008, y0]], 40), metal));
    body.add(rivetRing(trim, 0.168 + i * 0.008, 0.168 + i * 0.008, y0 - 0.01, 12, 0.0038));
  }
  body.add(mesh(new THREE.TorusGeometry(0.092, 0.007, 6, 28).rotateX(PI / 2), trim, 0, 0.5, 0));
  g.add(rivetRing(trim, 0.17, 0.17 * DEPTH, 0.44, 10, 0.004, PI * 0.8, -PI * 0.4));
  // Arm-hole rolls.
  for (const s of [1, -1]) {
    const roll = mesh(new THREE.TorusGeometry(0.07, 0.008, 6, 20, PI * 1.3), trim, s * 0.17, 0.4, 0, 0, PI / 2, s > 0 ? -PI * 0.15 : PI * 1.15);
    g.add(roll);
  }
  return g;
}

// ------------------------------------------------------------------ cloaks

function buildCloakDisplay(shape: string, c: PartCtx): THREE.Object3D {
  const { kit, look } = c;
  const root = new THREE.Group();
  const fur = shape === 'cloak.fur';
  const cape = shape === 'cape';
  const mat = patternMaterial(kit, look, fur ? [4, 3] : patRep(look));
  const H = cape ? 0.5 : 1.05;
  const gap = cape ? PI * 0.9 : 0.6;
  const geo = lathe([[0.075, H], [0.17, H - 0.06], [0.24, H - 0.14], [0.27, H * 0.55], [0.33, 0]], 48, gap / 2, PI * 2 - gap);
  displace(geo, (p) => {
    const t = 1 - p.y / H;
    const a = Math.atan2(p.x, p.z);
    const k = 1 + Math.sin(a * 9) * 0.06 * t * t;
    p.x *= k;
    p.z *= k;
    if (fur && t > 0.9) p.y += Math.sin(a * 17) * 0.015;
  });
  const cloth = mesh(geo, mat);
  cloth.scale.z = 0.72;
  root.add(cloth);
  if (!cape && shape !== 'cloak.fur') {
    // Folded hood lying on the shoulders at the back.
    const hood = mesh(new THREE.SphereGeometry(0.13, 18, 10, PI * 0.15, PI * 0.7, 0, PI * 0.6), mat, 0, H - 0.08, -0.06, -0.9);
    hood.scale.set(1.15, 0.9, 1);
    root.add(hood);
  }
  if (fur) {
    const collar = mesh(new THREE.TorusGeometry(0.13, 0.045, 8, 28), patternMaterial(kit, look, [6, 1], 'fur', ':collar'), 0, H - 0.05, 0, PI / 2);
    collar.scale.set(1.1, 0.75, 1);
    root.add(collar);
  }
  const brooch = buildBrooch(c);
  brooch.position.set(0.035, H - 0.05, 0.075);
  root.add(brooch);
  if (!fur) {
    // Hem trim following the cloak's folds.
    const hem = new THREE.Group();
    hem.scale.z = 0.72;
    const tg = new THREE.TorusGeometry(0.33, 0.006, 5, 64, PI * 2 - gap).rotateX(PI / 2).rotateY(PI * 1.5 - gap / 2);
    displace(tg, (p) => { const a = Math.atan2(p.x, p.z); const k = 1 + Math.sin(a * 9) * 0.06; p.x *= k; p.z *= k; });
    hem.add(mesh(tg, kit.tinted('cloth', look.accent, 'trim'), 0, 0.004, 0));
    root.add(hem);
  }
  return root;
}

// ------------------------------------------------------------------ legs

interface LegSpec {
  /** Leg covers from knee (true = breeches) or ankle. */
  short?: boolean;
  kilt?: boolean;
  knees?: 'metal' | 'leather';
  greaves?: boolean;
  tassets?: boolean;
}

const LEGS: Record<string, LegSpec> = {
  trousers: {},
  breeches: { short: true },
  kilt: { kilt: true },
  'leggings.padded': {},
  'leggings.leather': { knees: 'leather' },
  chausses: {},
  'leggings.scale': { knees: 'metal' },
  legplates: { knees: 'metal', greaves: true, tassets: true },
};

function buildLegDisplay(shape: string, c: PartCtx): THREE.Object3D | null {
  const spec = LEGS[shape];
  if (!spec) return null;
  const { kit, look } = c;
  const root = new THREE.Group();
  const mat = patternMaterial(kit, look, look.pattern === 'chainmail' ? [6, 10] : look.pattern === 'scales' ? [4, 8] : [2, 3]);
  const pelvis = new THREE.Group();
  pelvis.scale.z = 0.66;
  root.add(pelvis);
  if (spec.kilt) {
    const kilt = mesh(skirtGeo(0.42, 0.45, 0.17), mat, 0, 0.95, 0);
    // Pleats: fine radial ripples.
    displace(kilt.geometry, (p) => { const a = Math.atan2(p.x, p.z); const k = 1 + Math.abs(Math.sin(a * 24)) * 0.03; p.x *= k; p.z *= k; });
    pelvis.add(kilt);
    pelvis.add(mesh(cyl(0.172, 0.172, 0.93, 0.98, 32, true), kit.get('leather')));
    const sporran = mesh(new THREE.SphereGeometry(0.045, 12, 8), kit.get('fur'), 0, 0.8, 0.135);
    sporran.scale.set(1, 1.3, 0.45);
    root.add(sporran);
    root.add(mesh(new THREE.SphereGeometry(0.006, 6, 4), kit.get('trim'), 0, 0.86, 0.157));
    return root;
  }
  pelvis.add(mesh(lathe([[0.155, 0.76], [0.17, 0.86], [0.165, 0.97]], 32), mat));
  pelvis.add(mesh(new THREE.TorusGeometry(0.166, 0.007, 5, 32).rotateX(PI / 2), look.metallic ? kit.get('leather') : kit.tinted('cloth', look.color2, 'band'), 0, 0.965, 0));
  const y0 = spec.short ? 0.36 : 0.0;
  const prof: V2[] = ([[0.052, 0], [0.06, 0.2], [0.056, 0.42], [0.075, 0.64], [0.09, 0.8]] as V2[]).filter(([, y]) => y >= y0 - 0.001);
  if (spec.short) prof.unshift([0.058, y0]);
  for (const s of [1, -1]) {
    const leg = mesh(lathe(prof, 20), mat, s * 0.088, 0, 0);
    leg.rotation.z = s * 0.02;
    root.add(leg);
    const cuffR = prof[0][0];
    root.add(mesh(new THREE.TorusGeometry(cuffR, 0.004, 4, 16).rotateX(PI / 2), look.metallic ? kit.get('trim') : kit.tinted('cloth', look.color2, 'band'), s * 0.088, prof[0][1], 0));
    const side = (o: THREE.Object3D) => (s > 0 ? o : mirrorX(o));
    if (spec.knees) {
      const k = side(buildKneeCop(c, spec.knees));
      const w = new THREE.Group();
      w.scale.y = -1;
      w.position.set(s * 0.088, 0.43, 0.008);
      w.add(k);
      root.add(w);
    }
    if (spec.greaves) {
      const w = new THREE.Group();
      w.scale.y = -1;
      w.position.set(s * 0.088, 0.43, 0.0);
      w.add(side(buildGreave(c, 'metal')));
      root.add(w);
    }
    if (spec.tassets) {
      const w = new THREE.Group();
      w.scale.y = -1;
      w.position.set(s * 0.088, 0.84, 0.0);
      w.add(side(buildTasset(c)));
      root.add(w);
    }
  }
  return root;
}

// ------------------------------------------------------------------ feet

function buildBootDisplay(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, look } = c;
  const heights: Record<string, number> = { sandals: 0, shoes: 0.08, 'boots.leather': 0.24, 'boots.tall': 0.4, 'boots.fur': 0.27, sabatons: 0.14 };
  if (!(shape in heights)) return null;
  const h = heights[shape];
  const root = new THREE.Group();
  const plate = shape === 'sabatons';
  const mat = plate ? kit.get('metal') : shape === 'boots.fur' ? patternMaterial(kit, look, [2, 2]) : look.family === 'leather' ? patternMaterial(kit, look, [2, 1]) : kit.get('leather');
  const soleMat = kit.custom('sole', () => new THREE.MeshStandardMaterial({ color: 0x2a1e16, roughness: 0.9 }));
  for (const s of [1, -1]) {
    const b = new THREE.Group();
    b.position.set(s * 0.075, 0, 0);
    b.rotation.y = s * 0.08;
    // Sole + heel.
    const sole = mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.014, 20), soleMat, 0, 0.007, 0.045);
    sole.scale.set(1, 1, 2.75);
    b.add(sole);
    if (shape !== 'sandals') b.add(mesh(new THREE.BoxGeometry(0.06, 0.022, 0.05), soleMat, 0, 0.011, -0.06));
    if (shape === 'sandals') {
      const leather = kit.get('leather');
      for (let i = 0; i < 3; i++) b.add(mesh(new THREE.TorusGeometry(0.04, 0.004, 4, 14, PI), leather, 0, 0.012, 0.11 - i * 0.05));
      b.add(mesh(new THREE.TorusGeometry(0.042, 0.004, 4, 18).rotateX(PI / 2), leather, 0, 0.075, -0.035));
      b.add(mesh(taperedTube([V(0, 0.014, 0.08), V(0, 0.06, 0.0), V(0, 0.075, -0.03)], () => 0.004, 4, 8), leather));
      root.add(b);
      continue;
    }
    // Foot volume.
    const foot = mesh(new THREE.SphereGeometry(0.05, 18, 12), mat, 0, 0.045, 0.04);
    foot.scale.set(0.95, 0.85, 2.55);
    if (plate) displace(foot.geometry, (p) => { if (p.z > 0.03) { p.x *= 1 - (p.z - 0.03) * 12; p.y *= 1 - (p.z - 0.03) * 6; } });
    b.add(foot);
    if (h > 0.06) {
      const shaft = mesh(cyl(0.053, 0.056 + h * 0.06, 0.04, h, 18, true), mat, 0, 0, -0.035);
      b.add(shaft);
      if (shape === 'boots.tall') b.add(mesh(lathe([[0.06, h - 0.07], [0.075, h - 0.06], [0.072, h + 0.005]], 18), mat, 0, 0, -0.035));
      if (shape === 'boots.fur') {
        const ruff = mesh(new THREE.TorusGeometry(0.066, 0.022, 8, 20), patternMaterial(kit, look, [4, 1], 'fur', ':ruff'), 0, h, -0.035, PI / 2);
        b.add(ruff);
      }
      if (shape === 'boots.leather') {
        b.add(mesh(new THREE.TorusGeometry(0.058, 0.004, 4, 16).rotateX(PI / 2), kit.get('trim'), 0, h * 0.55, -0.035));
        b.add(mesh(new THREE.BoxGeometry(0.014, 0.012, 0.004), kit.get('trim'), 0.05, h * 0.55, -0.02, 0, PI / 2.5, 0));
      }
      if (plate) {
        for (let i = 0; i < 4; i++) b.add(mesh(new THREE.CylinderGeometry(0.052 - i * 0.004, 0.054 - i * 0.004, 0.035, 16, 1, true, PI / 2, PI), mat, 0, 0.05 - i * 0.006, 0.03 + i * 0.03, PI / 2 + 0.25, 0, 0));
        b.add(mesh(new THREE.TorusGeometry(0.057, 0.004, 4, 16).rotateX(PI / 2), kit.get('trim'), 0, h, -0.035));
      }
    }
    // Lace / seam over the instep for leather shoes.
    if (!plate) b.add(mesh(taperedTube([V(0, 0.085, 0.07), V(0, 0.095, 0.02), V(0, 0.1, -0.01)], () => 0.0025, 4, 8), kit.get('dark')));
    root.add(b);
  }
  return root;
}

// ------------------------------------------------------------------ hands

function buildGloveDisplay(shape: string, c: PartCtx): THREE.Object3D | null {
  const { kit, look } = c;
  if (!['gloves.cloth', 'gloves.leather', 'gauntlets.mail', 'gauntlets.plate'].includes(shape)) return null;
  const root = new THREE.Group();
  const plate = shape === 'gauntlets.plate';
  const mat = plate ? kit.get('leather') : patternMaterial(kit, look, look.pattern === 'chainmail' ? [4, 4] : [1, 1]);
  const fingerless = shape === 'gloves.cloth';
  for (const s of [1, -1]) {
    const h = new THREE.Group();
    h.position.set(s * 0.07, 0, 0);
    h.rotation.y = s * 0.25;
    const palm = mesh(new THREE.CapsuleGeometry(0.038, 0.045, 6, 12), mat, 0, 0.1, 0);
    palm.scale.set(1.05, 1, 0.42);
    h.add(palm);
    const fl = fingerless ? 0.018 : 0.055;
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 0.019;
      const len = fl * (i === 1 || i === 2 ? 1 : 0.85);
      const f = mesh(new THREE.CapsuleGeometry(0.0085, len, 4, 8), mat, x, 0.155 + len / 2, 0, 0, 0, -x * 1.2);
      h.add(f);
      if (plate)
        for (let k = 0; k < 3; k++) h.add(mesh(new THREE.CylinderGeometry(0.0105, 0.0105, len / 3.3, 8, 1, true, -PI / 2, PI), kit.get('metal'), x, 0.155 + (k + 0.5) * (len / 3), 0.001));
    }
    const thumb = mesh(new THREE.CapsuleGeometry(0.009, fingerless ? 0.015 : 0.04, 4, 8), mat, -s * 0.045, 0.11, 0.008, 0, 0, s * 0.8);
    h.add(thumb);
    // Cuff.
    const cuffMat = plate ? kit.get('metal') : mat;
    h.add(mesh(cyl(0.044, plate ? 0.06 : 0.048, -0.02, 0.06, 16, true), cuffMat, 0, 0.0, 0).translateY(0));
    if (plate) {
      const back = mesh(new THREE.SphereGeometry(0.045, 14, 8, 0, PI * 2, 0, PI * 0.35), kit.get('metal'), 0, 0.1, 0.002, PI / 2);
      back.scale.set(1, 1.2, 0.8);
      h.add(back);
      h.add(mesh(new THREE.TorusGeometry(0.06, 0.003, 4, 16).rotateX(PI / 2), kit.get('trim'), 0, -0.02, 0));
    }
    if (shape === 'gloves.leather') h.add(mesh(new THREE.TorusGeometry(0.047, 0.003, 4, 16).rotateX(PI / 2), kit.get('dark'), 0, 0.045, 0));
    root.add(h);
  }
  return root;
}

// ------------------------------------------------------------------ dispatch

const HEAD = new Set(['cap.leather', 'helm.nasal', 'helm.horned', 'helm.kettle', 'helm.barbute', 'helm.great', 'helm.skull', 'hood', 'coif.mail', 'hat.straw', 'hat.wide', 'hat.pointed', 'circlet', 'crown']);
const FACE = new Set(['mask.cloth', 'mask.leather', 'mask.bone', 'mask.metal', 'veil']);
const NECK = new Set(['gorget', 'torc', 'scarf', 'mantle.fur']);

export function buildApparelDisplay(shape: string, c: PartCtx, _rng: Rng): THREE.Object3D | null {
  if (HEAD.has(shape)) {
    const h = buildHeadwear(shape, c);
    if (h && (shape === 'circlet' || shape === 'crown')) {
      // Tilt bands toward the viewer so icons read as rings, not lines.
      const t = new THREE.Group();
      t.rotation.x = 0.55;
      t.add(h);
      return grounded(t);
    }
    return groundedOrNull(h);
  }
  if (FACE.has(shape)) {
    const m = buildMask(shape, c);
    if (m) m.rotation.x = -0.15;
    return groundedOrNull(m);
  }
  if (NECK.has(shape)) return groundedOrNull(buildNeckPiece(shape, c));
  if (shape === 'amulet' || shape === 'pendant') {
    // Lying chain loop in an elegant oval with the pendant at its front, tilted toward the viewer.
    const g = new THREE.Group();
    const R = 0.055;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * PI * 2;
      pts.push(V(Math.sin(a) * R * 0.75, 0.002 + Math.sin(a * 5) * 0.0012, Math.cos(a) * R));
    }
    g.add(mesh(taperedTube(pts, () => (shape === 'amulet' ? 0.0016 : 0.0022), 5, 96, true), shape === 'amulet' ? c.kit.get('trim') : c.kit.get('leather')));
    const p = buildPendantBody(shape, c);
    p.rotation.x = -PI / 2 + 0.25;
    p.position.set(0, 0.006, R + 0.002);
    g.add(p);
    g.rotation.x = 0.5;
    return grounded(g);
  }
  if (shape.startsWith('ring.')) {
    const r = buildRingBody(shape, c);
    r.scale.setScalar(2.2);
    return grounded(r);
  }
  if (shape.startsWith('pauldron.')) {
    const g = new THREE.Group();
    const L = buildPauldron(shape, c);
    if (!L) return null;
    L.position.x = 0.13;
    const R = mirrorX(buildPauldron(shape, c)!);
    R.position.x = -0.13;
    g.add(L, R);
    return grounded(g);
  }
  if (shape === 'wraps' || shape.startsWith('bracers.') || shape === 'vambraces') {
    const g = new THREE.Group();
    for (const s of [1, -1]) {
      let b: THREE.Object3D | null;
      if (shape === 'wraps') b = buildWraps(c);
      else b = buildBracer(shape, c);
      if (!b) return null;
      const w = new THREE.Group();
      w.add(s > 0 ? b : mirrorX(b));
      w.position.x = s * 0.06;
      w.rotation.z = s * 0.1;
      g.add(w);
    }
    return grounded(g);
  }
  if (shape.startsWith('belt.') || shape === 'sash') {
    const b = buildBelt(shape, c);
    if (!b) return null;
    b.rotation.x = 0.35;
    return grounded(b);
  }
  if (shape === 'cloak' || shape === 'cloak.fur' || shape === 'cape') {
    // Show cloaks three-quarter from behind: their face is the back.
    const t = new THREE.Group();
    t.rotation.y = PI * 0.8;
    t.add(buildCloakDisplay(shape, c));
    return grounded(t);
  }
  return groundedOrNull(buildTorsoDisplay(shape, c) ?? buildLegDisplay(shape, c) ?? buildBootDisplay(shape, c) ?? buildGloveDisplay(shape, c));
}

function groundedOrNull(o: THREE.Object3D | null): THREE.Object3D | null {
  return o ? grounded(o) : null;
}

/** Cloth arm wraps for display: a spiral strip around a forearm-length tube. */
export function buildWraps(c: PartCtx): THREE.Object3D {
  const { kit, look, fit } = c;
  const g = new THREE.Group();
  const mat = patternMaterial(kit, look, [1, 4]);
  const L = fit.height * 0.148;
  const pts: THREE.Vector3[] = [];
  const turns = 7;
  for (let i = 0; i <= turns * 12; i++) {
    const t = i / (turns * 12);
    const a = t * turns * PI * 2;
    const r = fit.forearmRadius * (1.22 - t * 0.2);
    pts.push(V(Math.sin(a) * r, L * (0.4 + t * 0.58), Math.cos(a) * r));
  }
  const strip = mesh(taperedTube(pts, () => 0.012, 4, turns * 24), mat);
  strip.scale.set(1, 1, 1);
  g.add(strip);
  void voidMaterial;
  return g;
}

export { buildBootCuff };
