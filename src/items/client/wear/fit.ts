/**
 * Body-fit constants and small geometry helpers for worn items.
 *
 * SOCKET SPACE CONVENTION (shared with the humanoid module)
 * ---------------------------------------------------------
 * All rigid parts are built in the local space of a socket, in meters:
 *  - Body-aligned sockets — head, neck, chest, spine, pelvis, back,
 *    shoulder.L/R, hip.L/R: +Y = up, +Z = forward (the way the body faces),
 *    +X = the character's LEFT side. Origins:
 *      head      = centre of the skull (roughly between the ears)
 *      neck      = base of the neck (top of the sternum / C7 level)
 *      chest     = chest bone head (mid-sternum height, centre of the ribcage)
 *      pelvis    = pelvis bone head (between the hip joints)
 *      shoulder.* / hip.* = the shoulder / hip joint centre
 *  - Limb sockets — upperarm, forearm, thigh, shin (L/R): origin at the
 *    proximal joint, +Y along the bone toward its child (elbow→wrist,
 *    knee→ankle...), +Z = forward of the body in rest pose, +X = the
 *    character's left.
 *  - hand.L/R: origin at the wrist, +Y toward the fingers, +Z = back of
 *    the hand (dorsal side), +X toward the thumb for the RIGHT hand.
 *  - foot.L/R: origin at the ankle, +Y toward the toes, +Z = up (top of the
 *    foot).
 *
 * Right-side parts are built as the left part mirrored with scale.x = -1
 * (three.js flips the face winding for negative-determinant objects).
 */
import * as THREE from 'three';
import type { BodyFit } from '../../wearable';

/** Average adult human proportions, used for display models and as fallback. */
export const DEFAULT_FIT: BodyFit = {
  height: 1.75,
  headRadius: 0.11,
  neckRadius: 0.06,
  shoulderWidth: 0.42,
  chestDepth: 0.24,
  waistRadius: 0.15,
  upperArmRadius: 0.05,
  forearmRadius: 0.04,
  handLength: 0.19,
  thighRadius: 0.08,
  shinRadius: 0.055,
  footLength: 0.26,
  earPoint: 0,
  hasHorns: false,
};

/** Limb lengths derived from height (anthropometric ratios). */
export function limbs(fit: BodyFit) {
  const h = fit.height;
  return {
    upperArm: 0.172 * h,
    forearm: 0.148 * h,
    thigh: 0.245 * h,
    shin: 0.246 * h,
    torso: 0.3 * h,
  };
}

/**
 * Tube with a radius profile along a curve: `radius(t)` for t in 0..1.
 * Used for horns, straps, chains with taper, scarf tails.
 */
export function taperedTube(points: THREE.Vector3[], radius: (t: number) => number, radial = 8, segs = 24, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, closed);
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, closed);
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = radius(t);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      p.setXYZ(k, c.x + (p.getX(k) - c.x) * r, c.y + (p.getY(k) - c.y) * r, c.z + (p.getZ(k) - c.z) * r);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Wrap an object so it is mirrored across X (right-side copy of a left part). */
export function mirrorX(obj: THREE.Object3D): THREE.Object3D {
  const g = new THREE.Group();
  g.scale.x = -1;
  g.add(obj);
  return g;
}

/** Partial sphere shell (three.js angles: phi around Y with +Z at π/2, theta from +Y down). */
export function sphereShell(r: number, phiStart: number, phiLen: number, thetaStart: number, thetaLen: number, ws = 24, hs = 12): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, ws, hs, phiStart, phiLen, thetaStart, thetaLen);
}

/** Front-centred phi start for a sphere segment of width `w` radians facing +Z. */
export function frontPhi(w: number): [number, number] {
  return [Math.PI / 2 - w / 2, w];
}

/** Displace a geometry's vertices with a function (in place). */
export function displace(g: THREE.BufferGeometry, f: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    f(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Ring of small rivets (instanced spheres) along a circle / ellipse at height y. */
export function rivetRing(mat: THREE.Material, rx: number, rz: number, y: number, count: number, size = 0.0045, arc = Math.PI * 2, arcStart = 0): THREE.InstancedMesh {
  const geo = new THREE.SphereGeometry(size, 6, 4);
  const im = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const a = arcStart + (arc * (i + 0.5)) / count;
    m.makeTranslation(Math.sin(a) * rx, y, Math.cos(a) * rz);
    im.setMatrixAt(i, m);
  }
  im.castShadow = true;
  return im;
}
