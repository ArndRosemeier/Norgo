/**
 * Body layout: turns a species genome into a rest-pose skeleton plus the
 * implicit-surface primitives, membranes and eyes that the client meshes.
 *
 * Pure math (no three.js) so it can be unit-tested in Node and reused by the
 * server if it ever needs exact dimensions.
 *
 * Model space: meters at adult size, +Y up, **+Z forward**, +X = left side.
 * The origin is on the ground below the centre of support for walkers, and at
 * the body centre for swimmers & floaters (`originCenter`).
 *
 * All bones have identity rest rotations: a bone's rest transform is just its
 * position offset from the parent. Limb chains are laid out with the same
 * two-bone IK the animation rig uses at runtime, so rest pose == solved pose.
 */
import { Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import type { Species } from './species';

export type V3 = [number, number, number];

export type BoneKind = 'root' | 'spine' | 'neck' | 'head' | 'jaw' | 'tail' | 'leg' | 'arm' | 'wing' | 'antenna' | 'tentacle' | 'fin' | 'bell' | 'ear';

export interface BoneDef {
  name: string;
  parent: number;
  /** Rest position in model space. */
  pos: V3;
  kind: BoneKind;
}

/** Surface part tags (shader uses them). */
export const enum Part {
  Skin = 0,
  /** Horn, claw, hoof, beak, teeth, spikes. */
  Keratin = 1,
  /** Shell, plates, carapace (hard, integument coloured). */
  Shell = 2,
  /** Glowing organ (gas sac, construct core, lure). */
  Glow = 3,
  /** Inner mouth / gums. */
  Mouth = 4,
}

export interface Prim {
  type: 'cone' | 'ellipsoid' | 'box';
  /** cone: segment a→b, radii ra/rb. ellipsoid: centre a, radii (ra*sx, ra*sy, ra*sz) with sz from b[0]. box: segment a→b, half extents ra*sx, ra*sy. */
  a: V3;
  b: V3;
  ra: number;
  rb: number;
  /** Cross-section squash (x = side, y = up) relative to the segment frame. */
  sx: number;
  sy: number;
  /** Driving bone. */
  bone: number;
  /** Smooth-union blend radius (m). */
  k: number;
  part: Part;
  /** 0 body, 1 limb, 2 head (pattern masking). */
  region: number;
}

export interface Membrane {
  /** Leading edge points & bones, trailing edge points & bones (same length). */
  lead: V3[];
  leadBone: number[];
  trail: V3[];
  trailBone: number[];
  /** 0 bat/dragon skin, 1 feathers, 2 insect, 3 fin. */
  style: number;
  /** Chordwise subdivisions. */
  rows: number;
}

export interface EyeDef {
  bone: number;
  pos: V3;
  radius: number;
  /** Look direction (unit). */
  dir: V3;
}

export type LegPole = 'fwd' | 'back' | 'up' | 'out';

export interface LegDef {
  /** Chain bones from hip; the foot end is `foot` (not a bone). */
  bones: number[];
  /** Segment lengths (bones.length entries). */
  lens: number[];
  foot: V3;
  side: number;
  /** 0 = rearmost .. 1 = frontmost (or angle/2π for radial). */
  along: number;
  /** Index within its side (0 = rearmost). */
  pairIndex: number;
  pole: LegPole;
  /** 3-segment digitigrade: last segment held at a fixed lean. */
  digitigrade: boolean;
  /** Lean of the last segment for 3-seg legs: offset (up, fwd) direction of ankle from foot. */
  ankleUp: number;
  ankleFwd: number;
  kind: 'leg' | 'arm' | 'radial';
}

export interface ChainDef {
  bones: number[];
  /** Tip position (end of the last bone). */
  tip: V3;
  side: number;
}

export interface BodyLayout {
  bones: BoneDef[];
  prims: Prim[];
  membranes: Membrane[];
  eyes: EyeDef[];
  legs: LegDef[];
  arms: LegDef[];
  spine: number[];
  neck: number[];
  head: number;
  jaw: number;
  tail: number[];
  tailTip: V3;
  wings: ChainDef[];
  antennae: ChainDef[];
  tentacles: ChainDef[];
  fins: ChainDef[];
  ears: number[];
  /** Bell bone of radial floaters (-1 otherwise). */
  bell: number;
  originCenter: boolean;
  /** Bounding box min/max of all prims (model space). */
  min: V3;
  max: V3;
  /** Head top height (m) and approx ground clearance of the torso. */
  headHeight: number;
  /** Rest stride-relevant leg length (m). */
  legLength: number;
  /** Height of the pelvis above the origin. */
  pelvisHeight: number;
}

// ------------------------------------------------------------------ vector helpers

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * Analytic two-bone IK: knee position for hip h, target t, segment lengths and
 * a pole direction (bend plane). Shared with the runtime rig.
 */
export function solveKnee(h: V3, t: V3, l1: number, l2: number, pole: V3, out: V3 = [0, 0, 0]): V3 {
  let dx = t[0] - h[0], dy = t[1] - h[1], dz = t[2] - h[2];
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) { dx = 0; dy = -1; dz = 0; d = 1e-6; }
  const ix = dx / d, iy = dy / d, iz = dz / d;
  const dc = clamp(d, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const hgt = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // Pole direction orthogonalised against the hip→target axis.
  const pd = pole[0] * ix + pole[1] * iy + pole[2] * iz;
  let px = pole[0] - ix * pd, py = pole[1] - iy * pd, pz = pole[2] - iz * pd;
  const pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) { px = 0; py = 0; pz = 1; } else { px /= pl; py /= pl; pz /= pl; }
  out[0] = h[0] + ix * a + px * hgt;
  out[1] = h[1] + iy * a + py * hgt;
  out[2] = h[2] + iz * a + pz * hgt;
  return out;
}

// ------------------------------------------------------------------ builder

class Builder {
  bones: BoneDef[] = [];
  prims: Prim[] = [];
  membranes: Membrane[] = [];
  eyes: EyeDef[] = [];
  bone(name: string, parent: number, pos: V3, kind: BoneKind): number {
    this.bones.push({ name, parent, pos: [pos[0], pos[1], pos[2]], kind });
    return this.bones.length - 1;
  }
  cone(a: V3, b: V3, ra: number, rb: number, bone: number, k: number, part = Part.Skin, region = 0, sx = 1, sy = 1) {
    this.prims.push({ type: 'cone', a: [...a] as V3, b: [...b] as V3, ra, rb, sx, sy, bone, k, part, region });
  }
  ell(c: V3, r: V3, bone: number, k: number, part = Part.Skin, region = 0) {
    const m = Math.max(r[0], r[1], r[2]);
    this.prims.push({ type: 'ellipsoid', a: [...c] as V3, b: [r[2] / m, 0, 0], ra: m, rb: m, sx: r[0] / m, sy: r[1] / m, bone, k, part, region });
  }
  box(a: V3, b: V3, hx: number, hy: number, bone: number, k: number, part = Part.Skin, region = 0) {
    const m = Math.max(hx, hy);
    this.prims.push({ type: 'box', a: [...a] as V3, b: [...b] as V3, ra: m, rb: m, sx: hx / m, sy: hy / m, bone, k, part, region });
  }
}

/** Build the rest-pose body for a species (deterministic). */
export function buildBody(sp: Species): BodyLayout {
  const rng = new Rng(sp.seed ^ 0xb0d1);
  const B = new Builder();
  const L = sp.length;
  const R = L * sp.girth;
  const chunk = sp.chunky;
  const kBody = R * lerp(0.55, 0.12, chunk);
  const isInsect = sp.integument === 'chitin' && (sp.limbs.pairs >= 3 || sp.role === 'insect' || sp.limbs.foot === 'point');
  const construct = sp.role === 'construct';
  const originCenter = sp.plan === 'finned' || (sp.plan === 'radial' && sp.role === 'floater');

  const root = B.bone('root', -1, [0, 0, 0], 'root');

  // ---------------- leg reach → pelvis height
  const pairs = sp.limbs.pairs;
  const legLen = L * sp.limbs.length;
  const sprawl = sp.limbs.splay;
  let pelvisY: number;
  if (originCenter) pelvisY = 0;
  else if (pairs === 0) pelvisY = R * sp.bodyHeight * 0.92;
  else if (isInsect) pelvisY = legLen * 0.42 + R * 0.25;
  else pelvisY = legLen * (pairs === 2 ? sp.limbs.hindRatio : 1) * (1 - sprawl * 0.55) * 0.93 + R * 0.2;
  if (sp.plan === 'radial' && !originCenter) pelvisY = L * sp.armLen * 0.22 + R * sp.bodyHeight * 0.5;

  // ---------------- spine
  const spine: number[] = [];
  const nS = Math.max(1, sp.spineSegs);
  const biped = sp.limbs.pairs === 1 && !sp.upright;
  const bodyPitch = sp.upright ? Math.PI / 2 - 0.08 : biped ? (sp.role === 'bird' ? 0.42 : 0.18) : 0;
  const zBack = sp.upright || biped ? 0 : -L / 2;
  const spinePts: V3[] = [];
  for (let i = 0; i <= nS; i++) {
    const t = i / nS;
    const along = t * L;
    const arch = Math.sin(Math.PI * t) * sp.spineArch * L * 0.16;
    let y = pelvisY + along * Math.sin(bodyPitch) + arch * Math.cos(bodyPitch);
    let z = zBack + along * Math.cos(bodyPitch) - arch * Math.sin(bodyPitch);
    // Quadrupeds with long front legs stand front-high.
    if (pairs === 2 && !sp.upright && sp.plan !== 'serpentine' && !originCenter) y += (1 - sp.limbs.hindRatio) * legLen * 0.93 * (1 - sprawl * 0.55) * t;
    spinePts.push([0, y, z]);
  }
  if (sp.plan === 'radial') spinePts.length = 1;
  let parent = root;
  for (let i = 0; i < Math.max(1, spinePts.length - 1); i++) {
    const b = B.bone('spine' + i, parent, spinePts[i], 'spine');
    spine.push(b);
    parent = b;
  }
  const pelvis = spine[0];
  const chest = spine[spine.length - 1];
  const chestPt = spinePts[spinePts.length - 1];
  // Fish are fusiform: narrow at the tail root, deepest behind the head.
  const hipR = R * (sp.plan === 'serpentine' ? 1 : sp.plan === 'finned' ? 0.62 : lerp(0.85, 1, 1 / sp.chest));
  const chestR = R * (sp.plan === 'serpentine' ? 1 : clamp(sp.chest, 0.7, 1.5));
  const sx = sp.bodyWidth, sy = sp.bodyHeight;

  // ---------------- torso surface
  let bell = -1;
  if (sp.plan === 'radial') {
    const discR = L * 0.5;
    if (sp.role === 'floater') {
      bell = B.bone('bell', pelvis, [0, 0, 0], 'bell');
      B.ell([0, discR * 0.15 * sy, 0], [discR, discR * 0.85 * sy, discR], bell, kBody);
      // Frilled rim & oral column.
      B.ell([0, -discR * 0.25 * sy, 0], [discR * 1.04, discR * 0.22, discR * 1.04], bell, discR * 0.12);
      B.cone([0, -discR * 0.2, 0], [0, -discR * 0.95, 0], discR * 0.32, discR * 0.12, bell, discR * 0.2, Part.Skin, 1);
      for (let i = 0; i < sp.dorsal.sacs; i++) {
        const a = (i / Math.max(1, sp.dorsal.sacs)) * Math.PI * 2 + rng.float();
        B.ell([Math.cos(a) * discR * 0.45, discR * 0.55 * sy, Math.sin(a) * discR * 0.45], [discR * 0.3, discR * 0.38, discR * 0.3], bell, discR * 0.1, Part.Glow);
      }
      if (!sp.dorsal.sacs) B.ell([0, discR * 0.2 * sy, 0], [discR * 0.42, discR * 0.4 * sy, discR * 0.42], bell, discR * 0.05, Part.Glow);
    } else {
      B.ell([0, pelvisY, 0], [discR, R * sy * 0.6, discR], pelvis, kBody);
      B.ell([0, pelvisY + R * sy * 0.35, 0], [discR * 0.55, R * sy * 0.55, discR * 0.55], pelvis, kBody, Part.Shell);
    }
  } else {
    for (let i = 0; i < spinePts.length - 1; i++) {
      const t0 = i / (spinePts.length - 1), t1 = (i + 1) / (spinePts.length - 1);
      // Fish: smooth spindle, deepest at ~65% of the torso.
      const fishR = (t: number) => R * (0.6 + 0.4 * Math.sin(Math.PI * clamp(0.15 + t * 0.85, 0, 1) * 0.85 + 0.25));
      const r0 = sp.plan === 'finned' ? fishR(t0) : lerp(hipR, chestR, t0) * (sp.plan === 'serpentine' ? 1 : 1 - 0.12 * Math.sin(Math.PI * t0));
      const r1 = sp.plan === 'finned' ? fishR(t1) : lerp(hipR, chestR, t1);
      if (construct) B.box(spinePts[i], spinePts[i + 1], r0 * sx, r0 * sy, spine[i], kBody, Part.Skin, 0);
      else B.cone(spinePts[i], spinePts[i + 1], r0, r1, spine[i], kBody, Part.Skin, 0, sx, sy);
    }
    if (sp.plan !== 'serpentine' && sp.plan !== 'finned' && !construct) {
      // Rib cage & haunch volumes give the torso its silhouette.
      const mid = mix(spinePts[0], chestPt, 0.62);
      B.ell(add(mid, [0, -R * sp.belly * 0.6, 0]), [chestR * sx * 1.05, chestR * sy * (1 + sp.belly * 0.5), L * 0.36], spine[Math.floor((spine.length - 1) * 0.62)], kBody);
      B.ell(add(spinePts[0], [0, R * 0.05, 0]), [hipR * sx * 1.05, hipR * sy * 0.95, hipR * 1.1], pelvis, kBody);
    }
    if (construct) {
      // Glowing core visible between plates.
      B.ell(mix(spinePts[0], chestPt, 0.6), [chestR * 0.55, chestR * 0.55, chestR * 0.55], spine[spine.length - 1], chestR * 0.05, Part.Glow);
    }
    if (sp.dorsal.shell > 0) {
      const c = mix(spinePts[0], chestPt, 0.45);
      B.ell(add(c, [0, R * sy * 0.45, 0]), [R * sx * 1.25 * (0.8 + sp.dorsal.shell * 0.3), R * sy * (0.75 + sp.dorsal.shell * 0.35), L * 0.55], spine[Math.floor(spine.length / 2)], R * 0.08, Part.Shell);
    }
  }

  // ---------------- neck & head
  const neck: number[] = [];
  let headBone = chest, jaw = -1;
  const headR = L * sp.head.size;
  let headPos: V3 = [...chestPt] as V3;
  const fwd: V3 = [0, 0, 1];
  if (sp.plan !== 'radial') {
    const nLen = L * sp.neckLen;
    const raise = sp.upright ? Math.PI / 2 : sp.neckRaise;
    const nDir: V3 = sp.upright ? [0, 1, 0.05] : [0, Math.sin(raise), Math.cos(raise)];
    const nSeg = sp.neckSegs;
    let prev = chestPt;
    parent = chest;
    const neckBase = chestR * 0.62;
    for (let i = 0; i < nSeg; i++) {
      const t = (i + 1) / nSeg;
      // Neck curves: rises steeply then levels out (S-curve for long necks).
      const bend = sp.neckLen > 0.6 ? Math.sin(t * Math.PI) * 0.15 : 0;
      const p: V3 = add(prev, mul(norm(add(nDir, [0, -bend, bend])), nLen / nSeg));
      const b = B.bone('neck' + i, parent, prev, 'neck');
      neck.push(b);
      const r0 = lerp(neckBase, headR * 0.62, i / nSeg), r1 = lerp(neckBase, headR * 0.62, t);
      if (construct) B.box(prev, p, r0, r0, b, kBody * 0.6, Part.Skin, 0);
      else B.cone(prev, p, r0, r1, b, kBody * 0.8, Part.Skin, 0, sx * 0.95, sy);
      prev = p;
      parent = b;
    }
    headPos = add(prev, [0, headR * 0.15, 0]);
    headBone = B.bone('head', parent, prev, 'head');
    const h = headR;
    const hk = h * lerp(0.4, 0.12, chunk);
    // Cranium.
    if (construct) B.box(add(headPos, [0, 0, -h * 0.6]), add(headPos, [0, 0, h * 0.7]), h * 0.9, h * 0.8, headBone, hk, Part.Skin, 2);
    else B.ell(headPos, [h * 0.9, h * 0.85, h], headBone, hk, Part.Skin, 2);
    // Snout points forward and slightly down; long-necked grazers droop more.
    const snoutLen = h * sp.head.snout * 1.2;
    const snoutDir = norm([0, -0.25 - (sp.neckRaise > 0.6 ? 0.45 : 0), 1]);
    const snoutTip = add(headPos, mul(snoutDir, h * 0.5 + snoutLen));
    if (snoutLen > h * 0.15 && !construct) {
      B.cone(add(headPos, mul(snoutDir, h * 0.3)), snoutTip, h * 0.62, h * 0.62 * sp.head.snoutTip, headBone, hk, Part.Skin, 2, 1, 0.85);
      // Nose pad.
      B.ell(snoutTip, [h * 0.3 * sp.head.snoutTip, h * 0.24 * sp.head.snoutTip, h * 0.2], headBone, h * 0.08, Part.Mouth, 2);
    }
    // Lower jaw on its own bone so bites/roars open the mouth.
    const jawPivot: V3 = add(headPos, [0, -h * 0.35, -h * 0.2]);
    jaw = B.bone('jaw', headBone, jawPivot, 'jaw');
    if (!construct && (snoutLen > h * 0.2 || sp.head.beak)) {
      const jawTip = add(snoutTip, [0, -h * 0.25, -snoutLen * 0.08]);
      B.cone(add(jawPivot, [0, 0, h * 0.2]), jawTip, h * 0.45, h * 0.3 * sp.head.snoutTip, jaw, hk * 0.8, Part.Skin, 2, 0.9, 0.6);
      // Teeth row for carnivores.
      if (sp.diet === 'carnivore' && snoutLen > h * 0.4) {
        for (const s of [-1, 1]) {
          const fang = add(snoutTip, [s * h * 0.22 * sp.head.snoutTip, -h * 0.12, -snoutLen * 0.12]);
          B.cone(fang, add(fang, [0, -h * 0.32, h * 0.03]), h * 0.07, h * 0.005, headBone, h * 0.02, Part.Keratin, 2);
        }
      }
    }
    if (sp.head.beak) {
      const bl = h * sp.head.beak;
      const base = add(headPos, mul(snoutDir, h * 0.75));
      const tip = add(base, [0, -bl * 0.25 - sp.head.beakCurve * bl * 0.3, bl]);
      const mid = add(mix(base, tip, 0.5), [0, sp.head.beakCurve * bl * 0.12, 0]);
      B.cone(base, mid, h * 0.42, h * 0.26, headBone, h * 0.12, Part.Keratin, 2, 1, 1.1);
      B.cone(mid, tip, h * 0.26, h * 0.02, headBone, h * 0.05, Part.Keratin, 2);
      B.cone(add(base, [0, -h * 0.18, 0]), add(base, [0, -h * 0.32, bl * 0.75]), h * 0.3, h * 0.02, jaw, h * 0.05, Part.Keratin, 2);
    }
    if (sp.head.mandibles) {
      for (const s of [-1, 1]) {
        const base: V3 = add(headPos, [s * h * 0.45, -h * 0.25, h * 0.75]);
        const ml = h * sp.head.mandibles;
        const mid = add(base, [s * ml * 0.35, -ml * 0.05, ml * 0.5]);
        const tip = add(mid, [-s * ml * 0.35, 0, ml * 0.35]);
        B.cone(base, mid, h * 0.16, h * 0.11, jaw, h * 0.05, Part.Keratin, 2);
        B.cone(mid, tip, h * 0.11, h * 0.01, jaw, h * 0.03, Part.Keratin, 2);
      }
    }
    // Horns: curved cone chains.
    if (sp.head.horns > 0) {
      const n = sp.head.horns;
      for (let i = 0; i < n; i++) {
        const pairI = Math.floor(i / 2);
        const s = n === 1 ? 0 : i % 2 === 0 ? 1 : -1;
        const hl = h * sp.head.hornLen * (pairI ? 0.6 : 1);
        let p: V3 = n === 1 ? add(headPos, [0, h * 0.55, h * (0.5 + sp.head.snout * 0.5)]) : add(headPos, [s * h * (0.5 + pairI * 0.15), h * 0.6, h * (0.15 - pairI * 0.35)]);
        let dir: V3 = norm([s * (0.6 + pairI * 0.3), 1 - Math.max(0, sp.head.hornSweep) * 0.6, -sp.head.hornSweep * 0.8 + (n === 1 ? 0.6 : 0)]);
        let r = h * 0.2 * (pairI ? 0.7 : 1) * (0.7 + sp.head.hornLen * 0.25);
        const segs = 4;
        for (let k = 0; k < segs; k++) {
          const q = add(p, mul(dir, hl / segs));
          const r2 = r * (k === segs - 1 ? 0.06 : 0.7);
          B.cone(p, q, r, r2, headBone, r * 0.3, Part.Keratin, 2);
          // Curl: rotate the direction around the side axis & outward.
          const c = sp.head.hornCurl * 0.55;
          dir = norm(add(dir, [s * c * 0.3, -c * 0.5 * (k + 1) / segs, -c * 0.6]));
          p = q;
          r = r2;
        }
      }
    }
    if (sp.head.antlers) {
      for (const s of [-1, 1]) {
        const al = h * sp.head.hornLen;
        let p: V3 = add(headPos, [s * h * 0.45, h * 0.6, -h * 0.05]);
        let dir: V3 = norm([s * 0.7, 1, -0.4]);
        const r0 = h * 0.12;
        for (let k = 0; k < 3; k++) {
          const q = add(p, mul(dir, al / 3));
          B.cone(p, q, r0 * (1 - k * 0.25), r0 * (0.75 - k * 0.25), headBone, r0 * 0.4, Part.Keratin, 2);
          // Tines branch forward-up.
          for (let t = 0; t < Math.ceil(sp.head.antlerTines / 3); t++) {
            const tb = mix(p, q, 0.5 + t * 0.2);
            const tt = add(tb, mul(norm([s * 0.2, 1, 0.6 + rng.range(-0.2, 0.2)]), al * 0.28));
            B.cone(tb, tt, r0 * 0.5, r0 * 0.05, headBone, r0 * 0.2, Part.Keratin, 2);
          }
          dir = norm(add(dir, [s * 0.15, -0.1, -0.25]));
          p = q;
        }
      }
    }
    if (sp.head.tusks) {
      for (const s of [-1, 1]) {
        const tl = h * sp.head.tusks * 1.3;
        const base: V3 = add(snoutTip, [s * h * 0.28, -h * 0.25, -snoutLen * 0.3]);
        const mid = add(base, [s * tl * 0.25, -tl * 0.25, tl * 0.4]);
        const tip = add(mid, [s * tl * 0.1, tl * 0.35, tl * 0.25]);
        B.cone(base, mid, h * 0.11, h * 0.08, headBone, h * 0.04, Part.Keratin, 2);
        B.cone(mid, tip, h * 0.08, h * 0.01, headBone, h * 0.03, Part.Keratin, 2);
      }
    }
    if (sp.head.crest > 0) {
      const a = add(headPos, [0, h * 0.7, h * 0.3]);
      const b2 = add(headPos, [0, h * (0.8 + sp.head.crest * 0.6), -h * (0.6 + sp.head.crest * 0.7)]);
      B.cone(a, b2, h * 0.3, h * 0.08, headBone, h * 0.15, sp.integument === 'feathers' ? Part.Skin : Part.Shell, 2, 0.25, 1.6);
    }
    if (sp.head.frill > 0) {
      const fr = h * (1 + sp.head.frill);
      B.ell(add(headPos, [0, h * 0.2, -h * 0.7]), [fr, fr * 0.85, h * 0.12], headBone, h * 0.1, Part.Shell, 2);
    }
    // Ears: flattened cones on their own bones (twitch & flatten when angry).
    if (sp.head.ears > 0) {
      for (const s of [-1, 1]) {
        const el = h * sp.head.ears * 0.9;
        const base: V3 = add(headPos, [s * h * 0.55, h * 0.55, -h * 0.25]);
        const eb = B.bone('ear' + (s > 0 ? 'L' : 'R'), headBone, base, 'ear');
        const tip = add(base, mul(norm([s * 0.6, 1, -0.35]), el));
        B.cone(base, tip, h * 0.3 * (1.2 - sp.head.earPoint * 0.4), h * 0.03 + h * 0.15 * (1 - sp.head.earPoint), eb, h * 0.1, Part.Skin, 2, 1, 0.35);
        // dummy marker so the rig knows the ear bones
      }
    }
    // Eyes.
    const ne = sp.head.eyes;
    const er = h * 0.2 * sp.head.eyeSize * (sp.role === 'smallcritter' || sp.role === 'bird' ? 1.3 : 1) * (sp.head.pupil === 'compound' ? 1.25 : 1);
    if (ne > 0) {
      const frontal = sp.role === 'predator' || sp.role === 'apex' ? 0.65 : 0.25;
      for (let i = 0; i < ne; i++) {
        let s: number, row: number;
        if (ne === 1) { s = 0; row = 0; } else if (ne === 3) { s = i === 2 ? 0 : i === 0 ? 1 : -1; row = i === 2 ? 1 : 0; } else { s = i % 2 === 0 ? 1 : -1; row = Math.floor(i / 2); }
        const zf = h * (0.45 + frontal * 0.2) - row * h * 0.28;
        const ex = s * h * (0.62 - frontal * 0.18 - row * 0.05);
        const ey = h * (0.28 + row * 0.18) + (s === 0 && ne === 3 ? h * 0.25 : 0);
        // Project onto the cranium ellipsoid so the eyeball sits half-proud of the skull.
        const q = Math.hypot(ex / (h * 0.9), ey / (h * 0.85), zf / h) || 1;
        const sink = 0.98 - (er / h) * 0.45;
        const pos = add(headPos, [ex / q * sink, ey / q * sink, zf / q * sink]);
        const dir = norm([s * (1 - frontal), 0.15, 0.35 + frontal]);
        B.eyes.push({ bone: headBone, pos, radius: er * (row ? 0.75 : 1), dir });
        // Brow/socket bulge so eyes sit in the skull.
        if (!construct) B.ell(add(pos, mul(dir, -er * 0.5)), [er * 1.2, er * 1.1, er * 1.2], headBone, er * 0.6, Part.Skin, 2);
      }
    }
  }

  // ---------------- tail
  const tail: number[] = [];
  let tailTip: V3 = [...spinePts[0]] as V3;
  if (sp.tail.length > 0 && sp.plan !== 'radial') {
    const tl = L * sp.tail.length;
    const n = sp.tail.segments;
    let p: V3 = [...spinePts[0]] as V3;
    parent = pelvis;
    const baseDir: V3 = biped || sp.upright ? norm([0, -0.15, -1]) : norm([0, sp.plan === 'serpentine' || sp.plan === 'finned' ? 0 : -0.25, -1]);
    let r = hipR * (sp.plan === 'finned' ? 0.9 : sp.tail.thickness * (sp.plan === 'serpentine' ? 1.15 : 1));
    // Fish tails taper smoothly to a narrow peduncle.
    const taper = sp.plan === 'finned' ? Math.pow(0.28, 1 / n) : sp.plan === 'serpentine' ? 0.9 : 0.78;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      const curl = sp.tail.curl * (isInsect ? 1.4 : 0.5);
      // Curl lifts the tail progressively (scorpion arcs over the back).
      const ang = curl * t * t * 2.2;
      const d: V3 = norm([0, baseDir[1] + Math.sin(ang), baseDir[2] * Math.cos(ang)]);
      const q = add(p, mul(d, tl / n));
      const b = B.bone('tail' + i, parent, p, 'tail');
      tail.push(b);
      const r2 = Math.max(r * taper, R * 0.04);
      if (isInsect && i === 0 && sp.tail.tip !== 'sting') B.ell(mix(p, q, 0.5), [R * 1.1 * sx, R * sy, tl / n], b, kBody);
      else if (construct) B.box(p, q, r, r, b, kBody * 0.5);
      else B.cone(p, q, r, r2, b, kBody * 0.7, Part.Skin, 0, sx * (sp.plan === 'finned' ? 0.6 : 1), sy);
      r = r2;
      p = q;
      parent = b;
    }
    tailTip = p;
    const last = tail[tail.length - 1];
    const lastDir = norm(sub(p, B.bones[last].pos));
    switch (sp.tail.tip) {
      case 'club':
        B.ell(p, [r * 3, r * 2.5, r * 3.5], last, r, construct ? Part.Skin : Part.Shell);
        break;
      case 'sting':
        B.ell(p, [r * 2.2, r * 2.2, r * 2.6], last, r * 0.8);
        B.cone(add(p, mul(lastDir, r * 1.5)), add(p, add(mul(lastDir, r * 5), [0, -r * 3, 0])), r * 0.9, r * 0.05, last, r * 0.4, Part.Keratin);
        break;
      case 'tuft':
        B.ell(add(p, mul(lastDir, r * 2)), [r * 2.6, r * 2.6, r * 4], last, r, Part.Skin);
        break;
      case 'spikes':
        for (const s of [-1, 1]) for (let k = 0; k < 2; k++) {
          const c = sub(p, mul(lastDir, k * r * 3));
          B.cone(c, add(c, [s * r * 6, r * 3, -r * 2]), r * 0.8, r * 0.05, last, r * 0.3, Part.Keratin);
        }
        break;
    }
    if (sp.tail.tip === 'fin' || sp.tail.tip === 'fan' || sp.fins.tail > 0) {
      // Vertical caudal fin (fish) or horizontal fan (birds).
      const fl = L * (sp.fins.tail || 0.4) * 0.5;
      const horiz = sp.tail.tip === 'fan';
      const lead: V3[] = [], trail: V3[] = [], lb: number[] = [], tb: number[] = [];
      for (let i = 0; i <= 4; i++) {
        const u = i / 4 * 2 - 1; // -1..1 across the fin
        const spread = horiz ? [u * fl * 0.8, 0, 0] : [0, u * fl * 0.9, 0];
        lead.push(add(p, mul(lastDir, -fl * 0.05)));
        trail.push(add(add(p, mul(lastDir, fl * (0.9 - Math.abs(u) * (horiz ? 0.1 : -0.25)) * (horiz ? 1 : 0.9))), spread as V3));
        lb.push(last);
        tb.push(last);
      }
      B.membranes.push({ lead, leadBone: lb, trail, trailBone: tb, style: horiz ? 1 : 3, rows: 4 });
    }
  }

  // ---------------- dorsal ornaments
  if (sp.plan !== 'radial') {
    const back = spinePts.map((q, i) => ({ q, b: spine[Math.min(i, spine.length - 1)] }));
    const tailPts = tail.map((b) => ({ q: B.bones[b].pos, b }));
    const ridge = [...tailPts.slice(0, Math.ceil(tailPts.length / 2)).reverse(), ...back];
    if (sp.dorsal.spikes > 0 && ridge.length > 1) {
      for (let i = 0; i < sp.dorsal.spikes; i++) {
        const t = (i + 0.5) / sp.dorsal.spikes;
        const f = t * (ridge.length - 1);
        const i0 = Math.floor(f), i1 = Math.min(ridge.length - 1, i0 + 1);
        const c = mix(ridge[i0].q, ridge[i1].q, f - i0);
        const r = lerp(hipR, chestR, t) * (sp.dorsal.shell ? 1.25 : 0.95) * sy;
        const h2 = L * sp.dorsal.spikeLen * (0.6 + Math.sin(t * Math.PI) * 0.6);
        const base = add(c, [0, r * 0.85, 0]);
        if (sp.dorsal.plates) B.cone(base, add(base, [0, h2 * 1.3, -h2 * 0.2]), h2 * 0.55, h2 * 0.08, ridge[i0].b, h2 * 0.15, Part.Shell, 0, 0.18, 1);
        else B.cone(base, add(base, [0, h2, -h2 * 0.35]), Math.max(h2 * 0.25, R * 0.06), R * 0.008, ridge[i0].b, R * 0.06, sp.integument === 'crystal' ? Part.Glow : Part.Keratin, 0);
      }
    }
    if (sp.dorsal.sail > 0 || sp.fins.dorsal > 0) {
      const lead: V3[] = [], trail: V3[] = [], lb: number[] = [], tb: number[] = [];
      const src = sp.fins.dorsal > 0 ? back.slice(Math.floor(back.length * 0.2), Math.max(Math.floor(back.length * 0.2) + 2, Math.ceil(back.length * 0.8))) : back;
      const hgt = L * (sp.dorsal.sail || sp.fins.dorsal * 0.25);
      for (let i = 0; i < src.length; i++) {
        const t = src.length > 1 ? i / (src.length - 1) : 0.5;
        const r = lerp(hipR, chestR, t) * sy;
        const base = add(src[i].q, [0, r * 0.8, 0]);
        lead.push(base);
        trail.push(add(base, [0, hgt * Math.pow(Math.sin(Math.PI * clamp(t * 0.9 + 0.08, 0, 1)), 0.7), -hgt * 0.25]));
        lb.push(src[i].b);
        tb.push(src[i].b);
      }
      if (lead.length >= 2) B.membranes.push({ lead, leadBone: lb, trail, trailBone: tb, style: sp.fins.dorsal > 0 ? 3 : 0, rows: 3 });
    }
  }

  // ---------------- legs
  const legs: LegDef[] = [];
  const legBones = (name: string, parentB: number, hip: V3, foot: V3, lens: number[], pole: V3, dig: boolean, ankleUp: number, ankleFwd: number): number[] => {
    const out: number[] = [];
    let pts: V3[];
    if (lens.length === 3) {
      const ank = add(foot, mul(norm([0, ankleUp, ankleFwd]), lens[2]));
      const knee = solveKnee(hip, ank, lens[0], lens[1], pole);
      pts = [hip, knee, ank];
    } else {
      const knee = solveKnee(hip, foot, lens[0], lens[1], pole);
      pts = [hip, knee];
    }
    let par = parentB;
    for (let i = 0; i < pts.length; i++) {
      const b = B.bone(name + i, par, pts[i], 'leg');
      out.push(b);
      par = b;
    }
    return out;
  };
  const addLegPrims = (bones: number[], foot: V3, rTop: number, footStyle: string, region = 1, haunch = 0) => {
    const pts = bones.map((b) => B.bones[b].pos).concat([foot]);
    for (let i = 0; i < bones.length; i++) {
      const t0 = i / bones.length, t1 = (i + 1) / bones.length;
      const r0 = rTop * lerp(1, 0.42, t0), r1 = rTop * lerp(1, 0.42, t1);
      if (construct) B.box(pts[i], pts[i + 1], r0 * 1.1, r0 * 1.1, bones[i], r0 * 0.25, Part.Skin, region);
      else B.cone(pts[i], pts[i + 1], r0, r1, bones[i], Math.min(r0, r1) * 0.6, Part.Skin, region);
    }
    if (haunch > 0) B.ell(mix(pts[0], pts[1], 0.35), [rTop * 1.25 * haunch, rTop * 1.6 * haunch, rTop * 1.5 * haunch], bones[0], rTop * 0.8, Part.Skin, 0);
    const last = bones[bones.length - 1];
    const fr = rTop * 0.45 * sp.limbs.footSize;
    switch (footStyle) {
      case 'hoof':
        B.cone(add(foot, [0, fr * 1.3, 0]), add(foot, [0, fr * 0.2, fr * 0.25]), fr * 1.05, fr * 1.25, last, fr * 0.2, Part.Keratin, region);
        break;
      case 'paw':
        B.ell(add(foot, [0, fr * 0.65, fr * 0.6]), [fr * 1.3, fr * 0.7, fr * 1.6], last, fr * 0.5, Part.Skin, region);
        break;
      case 'claw':
        B.ell(add(foot, [0, fr * 0.6, fr * 0.5]), [fr * 1.25, fr * 0.65, fr * 1.5], last, fr * 0.5, Part.Skin, region);
        for (let c = -1; c <= 1; c++) {
          const cb = add(foot, [c * fr * 0.7, fr * 0.45, fr * 1.6]);
          B.cone(cb, add(cb, [c * fr * 0.15, -fr * 0.45, fr * 0.9]), fr * 0.28, fr * 0.02, last, fr * 0.1, Part.Keratin, region);
        }
        break;
      case 'pad':
        for (let c = -1; c <= 1; c++) B.ell(add(foot, [c * fr * 0.9, fr * 0.3, fr * 1.2 + (c === 0 ? fr * 0.4 : 0)]), [fr * 0.5, fr * 0.35, fr * 0.5], last, fr * 0.4, Part.Skin, region);
        B.ell(add(foot, [0, fr * 0.4, fr * 0.3]), [fr * 1.1, fr * 0.55, fr * 1.1], last, fr * 0.5, Part.Skin, region);
        break;
      case 'point':
        B.cone(add(foot, [0, rTop * 0.35, 0]), foot, rTop * 0.32, rTop * 0.1, last, 0, Part.Keratin, region);
        break;
    }
  };

  if (pairs > 0 && sp.plan !== 'radial') {
    // Rear→front ordered bones that can carry legs (centipedes walk on their tail segments too).
    const legSpine = sp.plan === 'serpentine' ? [...tail.slice(0, Math.ceil(tail.length * 0.6)).reverse(), ...spine] : spine;
    for (let j = 0; j < pairs; j++) {
      const t = pairs === 1 ? 0 : j / (pairs - 1);
      const hind = j === 0 && pairs > 1;
      const kneeFwd = hind || pairs === 1;
      let attach: V3;
      let parentB: number;
      if (isInsect && sp.plan !== 'serpentine' && pairs <= 4) {
        // All insect legs on the thorax (front 55% of the torso).
        const tt = lerp(0.45, 0.95, t);
        attach = mix(spinePts[0], chestPt, tt);
        parentB = spine[Math.min(spine.length - 1, Math.round(tt * (spine.length - 1)))];
      } else if (sp.plan === 'serpentine' || pairs > 3) {
        const idx = Math.min(legSpine.length - 1, Math.round(t * (legSpine.length - 1)));
        parentB = legSpine[idx] ?? pelvis;
        attach = [...B.bones[parentB].pos] as V3;
      } else if (pairs === 1) {
        attach = [...spinePts[0]] as V3;
        parentB = pelvis;
      } else {
        const idx = Math.round(t * (spine.length - 1));
        parentB = spine[idx];
        attach = t >= 1 ? [...chestPt] as V3 : [...spinePts[Math.round(t * (spinePts.length - 1))]] as V3;
        if (t >= 1) parentB = chest;
      }
      const ll = legLen * (hind ? sp.limbs.hindRatio : 1) * (sp.plan === 'quadruped' && j > 0 ? 1 : 1);
      const rTop = (isInsect ? R * sp.limbs.thickness * 1.6 : R * sp.limbs.thickness * (hind ? 1.1 : 1)) * (construct ? 1.2 : 1);
      for (const s of [1, -1]) {
        // Upright walkers need a stance wide enough that thick thighs don't fuse.
        const w = sp.upright ? Math.max(R * sx * 0.62, rTop * 1.5) : R * sx * (isInsect ? 0.75 : 0.62);
        const hip: V3 = add(attach, [s * w, isInsect ? 0 : -R * 0.35, 0]);
        let foot: V3;
        let lens: number[];
        let pole: V3;
        let dig = false, ankleUp = 1, ankleFwd = 0;
        if (isInsect) {
          const fan = (t - 0.5) * 1.1;
          const reach = ll * (0.7 + sprawl * 0.25);
          foot = [hip[0] + s * reach * Math.cos(fan * 0.9), 0, hip[2] + reach * Math.sin(fan * 0.9) * 1.1];
          lens = [ll * 0.48, ll * 0.62];
          pole = [s * 0.4, 1, 0];
        } else {
          foot = [hip[0] + s * (sprawl * ll * 0.7 + R * 0.04), originCenter ? hip[1] - ll * 0.9 : 0, hip[2] + (pairs === 1 ? 0.02 * L : 0)];
          dig = sp.limbs.digitigrade || (pairs === 1 && !sp.upright);
          if (dig || (pairs >= 2 && !hind && !sp.upright)) {
            lens = [ll * 0.4, ll * 0.4, ll * 0.27];
            if (kneeFwd) { ankleUp = 0.82; ankleFwd = -0.55; pole = [s * sprawl, 0, 1]; }
            else { ankleUp = 0.95; ankleFwd = 0.18; pole = [s * sprawl, 0, -1]; }
            dig = true;
          } else {
            lens = [ll * 0.5, ll * 0.52];
            pole = [s * sprawl * 1.5, sprawl * 0.8, kneeFwd ? 1 : -1];
          }
          if (sprawl > 0.4) pole = [s * 0.6, 1, kneeFwd ? 0.3 : -0.3];
        }
        const bones = legBones(`leg${j}${s > 0 ? 'L' : 'R'}`, parentB, hip, foot, lens, pole, dig, ankleUp, ankleFwd);
        const footStyle = sp.limbs.foot;
        addLegPrims(bones, foot, rTop, footStyle, 1, !isInsect && (hind || pairs === 1) ? 1.15 : !isInsect ? 0.9 : 0);
        legs.push({
          bones, lens, foot, side: s, along: t, pairIndex: j,
          pole: isInsect || sprawl > 0.4 ? 'up' : kneeFwd ? 'fwd' : 'back',
          digitigrade: lens.length === 3, ankleUp, ankleFwd, kind: 'leg',
        });
      }
    }
  }

  // Radial walkers: arms as legs around the disc.
  const tentacles: ChainDef[] = [];
  if (sp.plan === 'radial') {
    const n = sp.arms;
    const discR = L * 0.5;
    const al = L * sp.armLen;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      const dx = Math.sin(a), dz = Math.cos(a);
      if (sp.role === 'floater') {
        // Hanging tentacles from the bell rim, spring-simulated by the rig.
        const segs = 5;
        let p: V3 = [dx * discR * 0.8, -discR * 0.2, dz * discR * 0.8];
        let par = bell;
        const bonesT: number[] = [];
        const tl = al * rng.range(0.7, 1.15);
        for (let k = 0; k < segs; k++) {
          const q: V3 = add(p, [dx * tl * 0.03, -tl / segs, dz * tl * 0.03]);
          const b = B.bone('tent' + i + '_' + k, par, p, 'tentacle');
          bonesT.push(b);
          const r0 = discR * 0.09 * (1 - k / segs) + discR * 0.01;
          B.cone(p, q, r0, r0 * 0.75, b, r0 * 0.4, Part.Skin, 1);
          p = q;
          par = b;
        }
        tentacles.push({ bones: bonesT, tip: p, side: i % 2 ? 1 : -1 });
      } else {
        const hip: V3 = [dx * discR * 0.85, pelvisY, dz * discR * 0.85];
        const foot: V3 = [dx * (discR + al * 0.8), 0, dz * (discR + al * 0.8)];
        const lens = [al * 0.5, al * 0.55];
        const bones = legBones('arm' + i, pelvis, hip, foot, lens, [0, 1, 0], false, 1, 0);
        addLegPrims(bones, foot, R * 0.45, 'point', 1, 0);
        legs.push({ bones, lens, foot, side: dx >= 0 ? 1 : -1, along: i / n, pairIndex: i, pole: 'up', digitigrade: false, ankleUp: 1, ankleFwd: 0, kind: 'radial' });
      }
    }
  }

  // Upright arms (golems, apes).
  const arms: LegDef[] = [];
  if (sp.limbs.arms) {
    for (const s of [1, -1]) {
      const al = L * sp.limbs.armLength;
      const sh: V3 = add(chestPt, [s * chestR * sx * 1.05, -chestR * 0.15, 0]);
      const hand: V3 = add(sh, [s * al * 0.18, -al * 0.95, al * 0.12]);
      const lens = [al * 0.5, al * 0.5];
      const bones = legBones('arm' + (s > 0 ? 'L' : 'R'), chest, sh, hand, lens, [s * 0.2, 0, -1], false, 1, 0);
      const rTop = R * sp.limbs.thickness * 0.95;
      addLegPrims(bones, hand, rTop, construct ? 'none' : 'paw', 1, 0);
      if (construct) B.box(add(hand, [0, -rTop * 0.4, 0]), add(hand, [0, -rTop * 1.4, rTop * 0.2]), rTop * 0.8, rTop * 0.7, bones[1], rTop * 0.2, Part.Skin, 1);
      arms.push({ bones, lens, foot: hand, side: s, along: 1, pairIndex: 0, pole: 'back', digitigrade: false, ankleUp: 1, ankleFwd: 0, kind: 'arm' });
    }
  }

  // ---------------- wings
  const wings: ChainDef[] = [];
  if (sp.wings.kind !== 'none') {
    const span = L * sp.wings.span;
    const pairsW = sp.wings.kind === 'insect' ? sp.wings.pairs : 1;
    for (let wp = 0; wp < pairsW; wp++) {
      for (const s of [1, -1]) {
        const anchorT = sp.wings.kind === 'insect' ? 0.78 - wp * 0.18 : 0.88;
        const anchor = add(mix(spinePts[0], chestPt, anchorT), [s * R * sx * 0.6, R * sy * 0.55, 0]);
        const parentB = spine[Math.min(spine.length - 1, Math.round(anchorT * (spine.length - 1)))];
        if (sp.wings.kind === 'insect') {
          const b = B.bone(`wing${wp}${s > 0 ? 'L' : 'R'}`, parentB, anchor, 'wing');
          const tip = add(anchor, [s * span * (wp ? 0.85 : 1), 0, -span * 0.12]);
          const chord = span * sp.wings.chord * (wp ? 0.85 : 1);
          const lead: V3[] = [], trail: V3[] = [], lb: number[] = [], tb: number[] = [];
          for (let i = 0; i <= 6; i++) {
            const u = i / 6;
            const pL = mix(anchor, tip, u);
            lead.push(add(pL, [0, 0, chord * 0.15 * Math.sin(Math.PI * u)]));
            trail.push(add(pL, [0, 0, -chord * Math.pow(Math.sin(Math.PI * clamp(u * 0.92 + 0.06, 0, 1)), 0.6)]));
            lb.push(b);
            tb.push(b);
          }
          B.membranes.push({ lead, leadBone: lb, trail, trailBone: tb, style: 2, rows: 3 });
          wings.push({ bones: [b], tip, side: s });
        } else {
          const sh = B.bone(`wingS${s > 0 ? 'L' : 'R'}`, parentB, anchor, 'wing');
          const elbowP = add(anchor, [s * span * 0.32, span * 0.04, span * 0.04]);
          const el = B.bone(`wingE${s > 0 ? 'L' : 'R'}`, sh, elbowP, 'wing');
          const wristP = add(elbowP, [s * span * 0.3, 0, -span * 0.02]);
          const wr = B.bone(`wingW${s > 0 ? 'L' : 'R'}`, el, wristP, 'wing');
          const tip = add(wristP, [s * span * 0.38, -span * 0.02, -span * 0.12]);
          const armR = R * 0.16 * (sp.wings.kind === 'feather' ? 1.2 : 1);
          B.cone(anchor, elbowP, armR * 1.6, armR, sh, armR * 0.6, Part.Skin, 1);
          B.cone(elbowP, wristP, armR, armR * 0.7, el, armR * 0.4, Part.Skin, 1);
          if (sp.wings.kind === 'membrane') {
            B.cone(wristP, tip, armR * 0.6, armR * 0.2, wr, armR * 0.2, Part.Skin, 1);
            B.cone(wristP, add(wristP, [s * armR * 0.5, armR * 2, armR * 2]), armR * 0.5, armR * 0.05, wr, 0, Part.Keratin, 1);
          }
          const chord = span * sp.wings.chord;
          const lead: V3[] = [], trail: V3[] = [], lb: number[] = [], tb: number[] = [];
          const N = 9;
          for (let i = 0; i <= N; i++) {
            const u = i / N;
            let pL: V3, bone: number;
            if (u < 0.34) { pL = mix(anchor, elbowP, u / 0.34); bone = sh; }
            else if (u < 0.64) { pL = mix(elbowP, wristP, (u - 0.34) / 0.3); bone = el; }
            else { pL = mix(wristP, tip, (u - 0.64) / 0.36); bone = wr; }
            let c: number;
            if (sp.wings.kind === 'feather') c = chord * (u < 0.64 ? 1 : lerp(1, 0.35, (u - 0.64) / 0.36));
            else {
              // Bat: scalloped trailing edge between finger rays.
              const scal = 1 - 0.3 * Math.abs(Math.sin(u * Math.PI * 3.5));
              c = chord * Math.sin(Math.PI * clamp(u * 0.85 + 0.15, 0, 1)) * scal;
            }
            lead.push(pL);
            trail.push(add(pL, [0, -c * 0.04, -c]));
            lb.push(bone);
            tb.push(u < 0.1 ? parentB : bone);
          }
          B.membranes.push({ lead, leadBone: lb, trail, trailBone: tb, style: sp.wings.kind === 'feather' ? 1 : 0, rows: 4 });
          wings.push({ bones: [sh, el, wr], tip, side: s });
        }
      }
    }
  }

  // ---------------- pectoral fins (fish, sky whales)
  const fins: ChainDef[] = [];
  if (sp.fins.pectoral > 0) {
    for (const s of [1, -1]) {
      const anchor = add(mix(spinePts[0], chestPt, 0.75), [s * R * sx * 0.8, -R * sy * 0.25, 0]);
      const parentB = spine[Math.max(0, spine.length - 1)];
      const b = B.bone('fin' + (s > 0 ? 'L' : 'R'), parentB, anchor, 'fin');
      const fl = L * sp.fins.pectoral * 0.5;
      const tip = add(anchor, [s * fl, -fl * 0.15, -fl * 0.35]);
      const lead: V3[] = [], trail: V3[] = [], lb: number[] = [], tb: number[] = [];
      for (let i = 0; i <= 5; i++) {
        const u = i / 5;
        const pL = mix(anchor, tip, u);
        lead.push(pL);
        trail.push(add(pL, [0, 0, -fl * 0.55 * Math.sin(Math.PI * clamp(u * 0.9 + 0.1, 0, 1))]));
        lb.push(b);
        tb.push(b);
      }
      B.membranes.push({ lead, leadBone: lb, trail, trailBone: tb, style: 3, rows: 3 });
      fins.push({ bones: [b], tip, side: s });
    }
  }

  // ---------------- antennae & whiskers
  const antennae: ChainDef[] = [];
  if (sp.head.antennae > 0 && sp.plan !== 'radial') {
    const h = headR;
    for (const s of [1, -1]) {
      const al = L * sp.head.antennae;
      let p: V3 = add(headPos, [s * h * 0.3, h * 0.55, h * 0.55]);
      let par = headBone;
      const bonesA: number[] = [];
      let dir: V3 = norm([s * 0.5, 0.7, 0.8]);
      for (let k = 0; k < 3; k++) {
        const q = add(p, mul(dir, al / 3));
        const b = B.bone(`ant${s > 0 ? 'L' : 'R'}${k}`, par, p, 'antenna');
        bonesA.push(b);
        B.cone(p, q, h * 0.05 * (1 - k * 0.25), h * 0.04 * (1 - k * 0.3), b, 0, Part.Keratin, 2);
        dir = norm(add(dir, [s * 0.05, -0.3, 0.1]));
        p = q;
        par = b;
      }
      antennae.push({ bones: bonesA, tip: p, side: s });
    }
  }
  if (sp.head.whiskers && sp.plan !== 'radial') {
    const h = headR;
    const tipZ = h * (0.5 + sp.head.snout * 1.2);
    for (const s of [1, -1]) for (let k = 0; k < 3; k++) {
      const base = add(headPos, [s * h * 0.3, -h * 0.05 + k * h * 0.06, tipZ * 0.85]);
      B.cone(base, add(base, [s * h * 1.3, (k - 1) * h * 0.25, -h * 0.2]), h * 0.015, h * 0.004, headBone, 0, Part.Keratin, 2);
    }
  }

  // ---------------- bounds & summary
  const min: V3 = [1e9, 1e9, 1e9], max: V3 = [-1e9, -1e9, -1e9];
  const grow = (p: V3, r: number) => {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i] - r);
      max[i] = Math.max(max[i], p[i] + r);
    }
  };
  for (const pr of B.prims) {
    const r = pr.ra * Math.max(pr.sx, pr.sy, pr.type === 'ellipsoid' ? pr.b[0] : 1);
    grow(pr.a, r);
    if (pr.type !== 'ellipsoid') grow(pr.b, Math.max(pr.rb, pr.ra) * Math.max(pr.sx, pr.sy));
  }
  for (const m of B.membranes) for (const q of [...m.lead, ...m.trail]) grow(q, 0);
  const headHeight = max[1] - (originCenter ? min[1] : 0);
  return {
    bones: B.bones, prims: B.prims, membranes: B.membranes, eyes: B.eyes, legs, arms,
    spine, neck, head: headBone, jaw, tail, tailTip, wings, antennae, tentacles, fins,
    ears: B.bones.map((b, i) => (b.kind === 'ear' ? i : -1)).filter((i) => i >= 0),
    bell, originCenter, min, max, headHeight,
    legLength: legs.length ? legs[0].lens.reduce((a, b) => a + b, 0) : R,
    pelvisHeight: pelvisY,
  };
}

/** Exported helpers for the rig. */
export const vec = { add, sub, mul, len, norm, dot, mix };
