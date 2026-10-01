/**
 * Procedural creature animation.
 *
 * Nothing is keyframed. Every frame the rig derives a pose from the creature's
 * replicated motion (velocity, yaw, move state, current action):
 *
 *  - Legs: phase-based gaits (lateral walk, diagonal trot, rotary gallop,
 *    bound, hop, biped stride, hexapod alternating tripod, metachronal waves
 *    for many legs / radial arms). Stance feet stay planted in world space on
 *    terrain found by raycasts; swing feet arc to a predicted landing spot.
 *    Two-bone analytic IK (+ fixed-lean metatarsus for digitigrade legs).
 *  - Body: height & pitch/roll from planted feet, gait bob, spine sway,
 *    serpentine undulation, fish swimming waves, breathing.
 *  - Spring chains: tails, antennae, tentacles react to turning & acceleration.
 *  - Head look-at spread over the neck, ear twitches, jaw.
 *  - Wings: flapping (fast down-stroke), gliding, folding on the ground;
 *    insect wing buzz; fin sculling; floater bell pulsing.
 *  - Actions: bite, claw, charge, roar, pounce, sting, spit, graze, drink,
 *    sleep, flinch, die — additive overlays on the procedural pose.
 *
 * Hot path: no allocations per frame (all temporaries preallocated).
 */
import * as THREE from 'three';
import type { BodyLayout, LegDef } from '../body';
import { solveKnee } from '../body';
import type { Species } from '../species';
import { clamp, damp, angleDiff, lerp, smoothstep } from '../../core/math';
import type { MoveState, Vec3 } from '../../shared/types';

export interface GroundSampler {
  /** Ground height below (x, yHint+up, z) or NaN. */
  height(x: number, yHint: number, z: number): number;
}

export interface RigInput {
  pos: Vec3;
  yaw: number;
  vel: Vec3;
  move: MoveState;
  action: { id: string; t: number; dur: number } | null;
  lookAt: Vec3 | null;
  behavior: string;
  time: number;
  /** 0 full, 1 reduced, 2 far (no IK). */
  lod: number;
  scale: number;
}

interface LegState {
  def: LegDef;
  bones: THREE.Bone[];
  planted: THREE.Vector3;
  lift: THREE.Vector3;
  target: THREE.Vector3;
  swinging: boolean;
  groundY: number;
  offset: number;
  restFoot: THREE.Vector3;
  /** rest direction of each segment in its bone's local frame */
  restDirs: THREE.Vector3[];
  pole: THREE.Vector3;
  /** Smoothed foot (for far LOD & transitions). */
  foot: THREE.Vector3;
  initialized: boolean;
}

interface SpringBone {
  bone: THREE.Bone;
  yaw: number;
  pitch: number;
  vy: number;
  vp: number;
}

// Scratch objects (shared across rigs: update() is synchronous).
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e0 = new THREE.Euler();
const _m0 = new THREE.Matrix4();
const _hip: Vec3 = [0, 0, 0], _tgt: Vec3 = [0, 0, 0], _pole: Vec3 = [0, 0, 0], _knee: Vec3 = [0, 0, 0];
const AX_X = new THREE.Vector3(1, 0, 0), AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);

/** World rotation of an object from its (uniformly scaled) matrixWorld. */
function worldQuat(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  const e = o.matrixWorld.elements;
  const sx = Math.hypot(e[0], e[1], e[2]) || 1;
  _m0.set(e[0] / sx, e[4] / sx, e[8] / sx, 0, e[1] / sx, e[5] / sx, e[9] / sx, 0, e[2] / sx, e[6] / sx, e[10] / sx, 0, 0, 0, 0, 1);
  return out.setFromRotationMatrix(_m0);
}

function setEuler(b: THREE.Bone, x: number, y: number, z: number) {
  _e0.set(x, y, z, 'YXZ');
  b.quaternion.setFromEuler(_e0);
}

const ease = (t: number) => t * t * (3 - 2 * t);

export class CreatureRig {
  readonly bones: THREE.Bone[];
  private legs: LegState[] = [];
  private arms: LegState[] = [];
  private tail: SpringBone[] = [];
  private antennae: SpringBone[][] = [];
  private tentacles: SpringBone[][] = [];
  private neck: THREE.Bone[];
  private head: THREE.Bone;
  private jaw: THREE.Bone | null;
  private root: THREE.Bone;
  private spine: THREE.Bone[];
  private wings: { bones: THREE.Bone[]; side: number }[];
  private fins: { bone: THREE.Bone; side: number }[];
  private ears: THREE.Bone[];
  private bell: THREE.Bone | null;

  private phase = 0;
  private gaitBlend = 0;
  private yawPrev = 0;
  private turnRate = 0;
  private speedS = 0;
  private velPrev = new THREE.Vector3();
  private accel = new THREE.Vector3();
  private bodyLift = 0;
  private bodyPitch = 0;
  private bodyRoll = 0;
  private headYaw = 0;
  private headPitch = 0;
  private lieDown = 0;
  private deadT = 0;
  private flyBlend = 0;
  private swimBlend = 0;
  private flapPhase = 0;
  private wavePhase = 0;
  private earTimer = 0;
  private earTwitch = 0;
  private hopLift = 0;
  private lastTime = -1;
  private seedF: number;
  /** Fold of insect/bird wings 0 spread .. 1 folded. */
  private fold = 1;
  private readonly legLen: number;
  private readonly walker: boolean;
  private readonly isFish: boolean;
  private readonly isFloater: boolean;
  private readonly isSnake: boolean;

  constructor(
    readonly sp: Species,
    readonly body: BodyLayout,
    bones: THREE.Bone[],
    readonly object: THREE.Object3D,
    private ground: GroundSampler,
    seed: number,
  ) {
    this.bones = bones;
    this.root = bones[0];
    this.spine = body.spine.map((i) => bones[i]);
    this.neck = body.neck.map((i) => bones[i]);
    this.head = bones[body.head];
    this.jaw = body.jaw >= 0 ? bones[body.jaw] : null;
    this.wings = body.wings.map((w) => ({ bones: w.bones.map((i) => bones[i]), side: w.side }));
    this.fins = body.fins.map((f) => ({ bone: bones[f.bones[0]], side: f.side }));
    this.ears = body.ears.map((i) => bones[i]);
    this.bell = body.bell >= 0 ? bones[body.bell] : null;
    this.seedF = (seed % 1000) / 1000;
    this.legLen = body.legLength;
    this.walker = body.legs.length > 0;
    this.isFish = sp.plan === 'finned';
    this.isFloater = sp.plan === 'radial' && sp.role === 'floater';
    this.isSnake = sp.plan === 'serpentine' && body.legs.length === 0;
    const mkLeg = (d: LegDef): LegState => {
      const bs = d.bones.map((i) => bones[i]);
      const restDirs: THREE.Vector3[] = [];
      for (let i = 0; i < bs.length; i++) {
        const nextPos = i + 1 < bs.length ? body.bones[d.bones[i + 1]].pos : d.foot;
        const p = body.bones[d.bones[i]].pos;
        restDirs.push(new THREE.Vector3(nextPos[0] - p[0], nextPos[1] - p[1], nextPos[2] - p[2]).normalize());
      }
      const s = d.side;
      const pole = d.pole === 'fwd' ? new THREE.Vector3(s * 0.1, 0, 1) : d.pole === 'back' ? new THREE.Vector3(s * 0.1, 0, -1) : d.pole === 'up' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(s, 0.3, 0);
      if (d.kind === 'radial') {
        const hp = body.bones[d.bones[0]].pos;
        pole.set(hp[0] * 0.5, 1, hp[2] * 0.5).normalize();
      }
      return {
        def: d, bones: bs, planted: new THREE.Vector3(), lift: new THREE.Vector3(), target: new THREE.Vector3(), swinging: false, groundY: 0,
        offset: 0, restFoot: new THREE.Vector3(...d.foot), restDirs, pole: pole.normalize(), foot: new THREE.Vector3(), initialized: false,
      };
    };
    this.legs = body.legs.map(mkLeg);
    this.arms = body.arms.map(mkLeg);
    this.tail = body.tail.map((i) => ({ bone: bones[i], yaw: 0, pitch: 0, vy: 0, vp: 0 }));
    this.antennae = body.antennae.map((c) => c.bones.map((i) => ({ bone: bones[i], yaw: 0, pitch: 0, vy: 0, vp: 0 })));
    this.tentacles = body.tentacles.map((c) => c.bones.map((i) => ({ bone: bones[i], yaw: 0, pitch: 0, vy: 0, vp: 0 })));
    this.applyGaitOffsets(false, 1);
  }

  // ------------------------------------------------------------------ gaits

  private gaitKind(running: boolean): string {
    const g = this.sp.gait;
    const legs = this.legs.length;
    if (legs === 0) return g;
    if (g === 'tripod' || g === 'wave' || g === 'hop') return g;
    if (legs === 2) return 'stride';
    if (!running) return 'walk';
    return g === 'walk' || g === 'stride' || g === 'waddle' ? 'trot' : g;
  }

  /** Phase offsets & duty for the current gait. */
  private applyGaitOffsets(running: boolean, blend: number) {
    const kind = this.gaitKind(running);
    const n = this.legs.length;
    const pairs = Math.max(1, Math.ceil(n / 2));
    for (const L of this.legs) {
      const d = L.def;
      const left = d.side > 0;
      let o = 0;
      switch (kind) {
        case 'walk': o = (left ? 0 : 0.5) + (d.pairIndex >= 1 ? 0.25 : 0); break;
        case 'trot': o = (left ? 0 : 0.5) + (d.pairIndex >= 1 ? 0.5 : 0); break;
        case 'gallop': o = (left ? 0 : 0.1) + (d.pairIndex >= 1 ? 0.55 : 0); break;
        case 'bound': o = (left ? 0 : 0.06) + (d.pairIndex >= 1 ? 0.5 : 0); break;
        case 'hop': o = left ? 0 : 0.03; break;
        case 'stride': case 'waddle': o = left ? 0 : 0.5; break;
        case 'tripod': o = ((d.pairIndex + (left ? 0 : 1)) % 2) * 0.5; break;
        default:
          if (d.kind === 'radial') o = d.along;
          else o = (((-d.pairIndex / pairs) * 0.85) % 1 + 1) % 1 + (left ? 0 : 0.5);
      }
      o = ((o % 1) + 1) % 1;
      // Blend circularly toward the new offset.
      let diff = o - L.offset;
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      L.offset = (((L.offset + diff * blend) % 1) + 1) % 1;
    }
  }

  private dutyFor(running: boolean): number {
    const k = this.gaitKind(running);
    switch (k) {
      case 'walk': return 0.68;
      case 'trot': return 0.5;
      case 'gallop': return 0.36;
      case 'bound': return 0.4;
      case 'hop': return 0.45;
      case 'stride': case 'waddle': return running ? 0.38 : 0.62;
      case 'tripod': return running ? 0.5 : 0.6;
      default: return running ? 0.6 : 0.75;
    }
  }

  private strideFor(running: boolean): number {
    const k = this.gaitKind(running);
    const base = { walk: 0.9, trot: 1.35, gallop: 2.3, bound: 1.9, hop: 1.6, stride: running ? 1.9 : 1.05, waddle: 0.6, tripod: running ? 1.1 : 0.8, wave: 0.7 } as Record<string, number>;
    return (base[k] ?? 0.8) * this.legLen;
  }

  // ------------------------------------------------------------------ update

  update(dt: number, inp: RigInput) {
    dt = Math.min(dt, 0.1);
    const sp = this.sp;
    const obj = this.object;
    const scale = inp.scale;
    const t = inp.time;
    if (this.lastTime < 0) this.yawPrev = inp.yaw;
    this.lastTime = t;

    // ---- root transform
    obj.position.set(inp.pos[0], inp.pos[1], inp.pos[2]);
    obj.rotation.set(0, inp.yaw + Math.PI, 0);
    obj.scale.setScalar(scale);
    const dyaw = angleDiff(this.yawPrev, inp.yaw);
    this.yawPrev = inp.yaw;
    this.turnRate = lerp(this.turnRate, dt > 0 ? dyaw / dt : 0, damp(8, dt));
    const vx = inp.vel[0], vy = inp.vel[1], vz = inp.vel[2];
    const hSpeed = Math.hypot(vx, vz);
    this.speedS = lerp(this.speedS, hSpeed, damp(6, dt));
    _v0.set(vx, vy, vz);
    this.accel.subVectors(_v0, this.velPrev).divideScalar(Math.max(dt, 1e-3));
    this.velPrev.copy(_v0);
    // Local (model) velocity: forward = model +Z = world (−sin yaw, 0, −cos yaw).
    const fx = -Math.sin(inp.yaw), fz = -Math.cos(inp.yaw);
    const vFwd = vx * fx + vz * fz;
    const vSide = vx * -fz + vz * fx;

    const move = inp.move;
    const dead = move === 'dead';
    const sleeping = move === 'sleep' || inp.action?.id === 'sleep';
    const swimming = move === 'swim';
    const flying = move === 'fly' || move === 'glide' || ((this.isFloater || (this.isFish && !swimming)) && !dead);
    this.flyBlend = lerp(this.flyBlend, flying && !this.isFloater ? 1 : 0, damp(4, dt));
    this.swimBlend = lerp(this.swimBlend, swimming || this.isFish ? 1 : 0, damp(3, dt));
    this.deadT = dead ? Math.min(1, this.deadT + dt * 1.6) : Math.max(0, this.deadT - dt * 2);
    this.lieDown = lerp(this.lieDown, sleeping || dead ? 1 : 0, damp(sleeping ? 1.5 : 4, dt));

    const running = this.speedS > sp.walkSpeed * 1.45 * scale || move === 'run' || move === 'sprint';
    this.gaitBlend = Math.min(1, this.gaitBlend + dt * 3);
    this.applyGaitOffsets(running, damp(5, dt));
    const duty = this.dutyFor(running);

    // ---- action overlay channels
    const act = inp.action;
    const at = act ? clamp(act.t / Math.max(0.05, act.dur), 0, 1) : 0;
    const aid = act ? act.id : '';
    let lunge = 0, crouch = 0, aPitch = 0, aRoll = 0, headP = 0, headY = 0, jawOpen = 0, tailArc = 0, frontRaise = 0, shake = 0, leap = 0;
    switch (aid) {
      case 'bite': {
        const wind = smoothstep(0, 0.35, at) * (1 - smoothstep(0.4, 0.55, at));
        const strike = smoothstep(0.35, 0.55, at) * (1 - smoothstep(0.65, 1, at));
        lunge = strike * 0.22; headP = -wind * 0.35 + strike * 0.3; jawOpen = wind * 0.9 + strike * (at < 0.5 ? 0.8 : 0) ; crouch = wind * 0.1;
        break;
      }
      case 'claw': {
        const up = Math.sin(Math.PI * clamp(at * 1.2, 0, 1));
        aPitch = -up * 0.25; frontRaise = up; headP = -up * 0.15; jawOpen = up * 0.3; lunge = smoothstep(0.4, 0.6, at) * (1 - smoothstep(0.7, 1, at)) * 0.15;
        break;
      }
      case 'charge': {
        const s = Math.sin(Math.PI * at);
        headP = s * 0.55; crouch = s * 0.15; lunge = s * 0.35; aPitch = s * 0.08;
        break;
      }
      case 'roar': {
        const s = smoothstep(0, 0.25, at) * (1 - smoothstep(0.8, 1, at));
        headP = -s * 0.55; jawOpen = s; shake = s; aPitch = -s * 0.12;
        break;
      }
      case 'pounce': {
        const c = smoothstep(0, 0.35, at) * (1 - smoothstep(0.35, 0.45, at));
        const l = smoothstep(0.35, 0.55, at) * (1 - smoothstep(0.75, 1, at));
        crouch = c * 0.35; leap = l; aPitch = -l * 0.3 + c * 0.1; frontRaise = l * 0.8; jawOpen = l * 0.8; lunge = l * 0.3;
        break;
      }
      case 'sting': {
        const s = smoothstep(0, 0.4, at) * (1 - smoothstep(0.7, 1, at));
        tailArc = s + smoothstep(0.4, 0.55, at) * (1 - smoothstep(0.6, 0.9, at)) * 0.6; crouch = s * 0.08; aPitch = s * 0.06;
        break;
      }
      case 'spit': {
        const back = smoothstep(0, 0.4, at) * (1 - smoothstep(0.45, 0.55, at));
        const fwd = smoothstep(0.45, 0.6, at) * (1 - smoothstep(0.75, 1, at));
        headP = -back * 0.4 + fwd * 0.2; jawOpen = fwd * 1.0 + back * 0.2; lunge = fwd * 0.08 - back * 0.05;
        break;
      }
      case 'graze':
      case 'drink': {
        const s = smoothstep(0, 0.2, at) * (1 - smoothstep(0.85, 1, at));
        headP = s * (0.9 + sp.neckRaise * 0.8);
        jawOpen = s * (aid === 'graze' ? 0.25 + 0.25 * Math.sin(t * 9) : 0.15 + 0.15 * Math.sin(t * 14));
        crouch = s * (sp.neckLen < 0.35 ? 0.12 : 0.04);
        break;
      }
      case 'flinch': {
        const s = Math.sin(Math.PI * clamp(at * 1.4, 0, 1));
        aPitch = -s * 0.18; aRoll = s * 0.15 * (this.seedF > 0.5 ? 1 : -1); headY = s * 0.4; crouch = s * 0.08; jawOpen = s * 0.4;
        break;
      }
    }
    // Hostile display / hunting posture hints from behaviour.
    if (inp.behavior === 'threaten' && !act) { headP -= 0.15; jawOpen = Math.max(jawOpen, 0.35 + 0.15 * Math.sin(t * 7)); crouch += 0.08; }
    if ((inp.behavior === 'stalk' || move === 'crouch') && !act) crouch += 0.25;

    // ---- body pose on the root bone
    const L = this.legLen;
    const bobFreq = this.phase;
    const gk = this.gaitKind(running);
    const moving = this.speedS > 0.05 * scale;
    const amp = clamp(this.speedS / Math.max(0.1, sp.runSpeed * scale), 0, 1);
    let bob = 0, pitchOsc = 0, rollOsc = 0;
    if (this.walker && moving && this.flyBlend < 0.5 && !swimming) {
      const ph = bobFreq * Math.PI * 2;
      if (gk === 'gallop' || gk === 'bound') { bob = Math.sin(ph) * 0.06 * L; pitchOsc = Math.sin(ph + 1.2) * 0.12 * amp; }
      else if (gk === 'hop') { bob = 0; }
      else if (gk === 'stride' || gk === 'waddle') { bob = Math.abs(Math.sin(ph)) * 0.04 * L - 0.02 * L; rollOsc = Math.sin(ph) * (gk === 'waddle' ? 0.12 : 0.04); }
      else { bob = Math.sin(ph * 2) * 0.025 * L; rollOsc = Math.sin(ph) * 0.02; }
    }
    const breathe = Math.sin(t * (sleeping ? 1.3 : 2.4 + amp * 4) + this.seedF * 7) * (sleeping ? 0.03 : 0.015);
    const fishWave = this.swimBlend;

    // Terrain-following pitch/roll from planted feet.
    let targetPitch = 0, targetRoll = 0, targetLift = 0;
    if (this.walker && this.legs[0].initialized && inp.lod < 2 && this.flyBlend < 0.5 && !swimming) {
      let fy = 0, fn = 0, by = 0, bn = 0, ly = 0, ln = 0, ry = 0, rn = 0, all = 0;
      for (const Lg of this.legs) {
        const gy = (Lg.swinging ? Lg.groundY : Lg.planted.y) - inp.pos[1];
        all += gy;
        if (Lg.def.along > 0.5) { fy += gy; fn++; } else { by += gy; bn++; }
        if (Lg.def.side > 0) { ly += gy; ln++; } else { ry += gy; rn++; }
      }
      const span = Math.max(0.2, sp.length * scale);
      if (fn && bn) targetPitch = -Math.atan2(fy / fn - by / bn, span) * 0.8;
      if (ln && rn) targetRoll = Math.atan2(ly / ln - ry / rn, span * sp.girth * 2 + 0.2) * 0.5;
      targetLift = clamp(all / this.legs.length, -L * 0.4 * scale, L * 0.4 * scale) / scale;
    }
    this.bodyPitch = lerp(this.bodyPitch, clamp(targetPitch, -0.6, 0.6), damp(6, dt));
    this.bodyRoll = lerp(this.bodyRoll, clamp(targetRoll, -0.4, 0.4), damp(6, dt));
    this.bodyLift = lerp(this.bodyLift, targetLift, damp(8, dt));

    // Lying down / death drop.
    const ph = this.body.pelvisHeight;
    const lie = this.lieDown;
    const deathRoll = ease(this.deadT) * (Math.PI / 2 - 0.25) * (this.seedF > 0.5 ? 1 : -1);
    const sinkTo = this.originCenterSink();
    const rootY = this.bodyLift + bob + this.hopLift - crouch * ph - lie * (ph - sinkTo) + leap * ph * 0.5;
    let rootPitch = this.bodyPitch + pitchOsc + aPitch;
    let rootRoll = this.bodyRoll + rollOsc + aRoll + deathRoll + Math.sin(t * 38) * shake * 0.03;
    // Flying: pitch with climb/dive, bank into turns.
    if (this.flyBlend > 0.01) {
      const climb = Math.atan2(vy, Math.max(0.5, hSpeed));
      rootPitch = lerp(rootPitch, -climb * 0.7, this.flyBlend);
      rootRoll = lerp(rootRoll, clamp(-this.turnRate * 0.35, -0.8, 0.8), this.flyBlend);
    }
    if (this.isFish || swimming) rootPitch = lerp(rootPitch, -Math.atan2(vy, Math.max(0.3, hSpeed)) * 0.8, fishWave);
    if (this.isFloater) { rootPitch = Math.sin(t * 0.4 + this.seedF * 5) * 0.08; rootRoll = Math.sin(t * 0.33 + this.seedF * 3) * 0.08; }
    this.root.position.set(0, rootY, lunge * sp.length);
    setEuler(this.root, -rootPitch, 0, rootRoll);

    // ---- spine: sway / undulation / breathing
    const nSp = this.spine.length;
    this.wavePhase += dt * (this.isSnake || this.isFish || swimming ? 1.2 + this.speedS / Math.max(0.2, sp.length * scale) * 1.4 : 0);
    const sprawl = sp.limbs.splay;
    for (let i = 0; i < nSp; i++) {
      const b = this.spine[i];
      const u = nSp > 1 ? i / (nSp - 1) : 0;
      let yawS = 0, pitchS = 0;
      if (this.isSnake || ((this.isFish || swimming) && !this.walker)) {
        const a = this.isFish ? 0.06 + 0.08 * (1 - u) : 0.32;
        yawS = Math.sin(this.wavePhase * Math.PI * 2 - u * 4.2) * a * (this.isFish ? 1 : 0.7 + amp * 0.3);
      } else if (this.walker && moving && this.flyBlend < 0.5) {
        // Lizard-like lateral flex for sprawling walkers, subtle for mammals.
        yawS = Math.sin(this.phase * Math.PI * 2 + u * 1.5) * (0.03 + sprawl * 0.14) * amp;
        if (gk === 'gallop' || gk === 'bound') pitchS = Math.sin(this.phase * Math.PI * 2 + 0.5) * 0.08 * amp;
      }
      // Turning bends the spine into the turn.
      yawS += clamp(this.turnRate * 0.06, -0.15, 0.15) * (i > 0 ? 1 : 0);
      setEuler(b, pitchS, i === 0 ? 0 : yawS, 0);
      if (i === nSp - 1 || (nSp === 1 && !this.bell)) b.scale.set(1 + breathe, 1 + breathe * 1.4, 1);
    }

    // ---- floater bell pulse
    if (this.bell) {
      const pulse = Math.sin(t * (1.6 + amp * 2) + this.seedF * 6);
      const s = 1 + pulse * 0.09;
      this.bell.scale.set(s, 1 - pulse * 0.07, s);
    }

    // ---- neck & head look-at
    let tYaw = 0, tPitch = 0;
    if (inp.lookAt && !dead) {
      obj.updateMatrixWorld();
      _v1.set(inp.lookAt[0], inp.lookAt[1], inp.lookAt[2]);
      _m0.copy(obj.matrixWorld).invert();
      _v1.applyMatrix4(_m0);
      const hp = this.body.bones[this.body.head].pos;
      _v1.x -= hp[0]; _v1.y -= hp[1]; _v1.z -= hp[2];
      tYaw = Math.atan2(_v1.x, _v1.z);
      tPitch = Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z));
      if (Math.abs(tYaw) > 2.2) tYaw = 0; // behind: ignore
    } else {
      // Idle glances and looking into turns.
      const g = Math.sin(t * 0.37 + this.seedF * 11) * Math.sin(t * 0.23 + this.seedF * 3);
      tYaw = (moving ? clamp(this.turnRate * 0.35, -0.6, 0.6) : g * 0.7) + (Math.abs(vSide) > 0.2 ? 0 : 0);
      tPitch = moving ? 0 : Math.sin(t * 0.29 + this.seedF * 5) * 0.15;
    }
    tYaw = clamp(tYaw + headY, -1.3, 1.3);
    tPitch = clamp(tPitch, -0.7, 0.6);
    this.headYaw = lerp(this.headYaw, tYaw, damp(5, dt));
    this.headPitch = lerp(this.headPitch, tPitch, damp(5, dt));
    const nNeck = this.neck.length;
    const share = 1 / (nNeck + 1);
    const lieHead = lie * 0.5 + this.deadT * 0.3;
    const pitchDown = headP + lieHead - this.headPitch;
    for (let i = 0; i < nNeck; i++) {
      // Long necks swing a little with the gait.
      const sway = moving ? Math.sin(this.phase * Math.PI * 4 + i) * 0.03 : 0;
      setEuler(this.neck[i], pitchDown * share + sway, this.headYaw * share, 0);
    }
    setEuler(this.head, pitchDown * share - rootPitch * 0.4, this.headYaw * share, Math.sin(t * 0.5 + this.seedF) * 0.04);
    if (this.jaw) {
      const pant = running ? 0.12 + Math.sin(t * 10) * 0.05 : 0;
      const yawn = sleeping ? Math.max(0, Math.sin(t * 0.21 + this.seedF * 9) - 0.96) * 12 : 0;
      setEuler(this.jaw, clamp(jawOpen + pant + yawn + this.deadT * 0.3, 0, 1.1) * 0.55, 0, 0);
    }
    // Ears: twitch at random intervals, pin back when hostile.
    if (this.ears.length) {
      this.earTimer -= dt;
      if (this.earTimer < 0) { this.earTimer = 1.5 + ((Math.sin(t * 12.9898 + this.seedF * 78.2) * 43758.5) % 1 + 1) % 1 * 5; this.earTwitch = 1; }
      this.earTwitch = Math.max(0, this.earTwitch - dt * 6);
      const pin = inp.behavior === 'threaten' || inp.behavior === 'attack' || aid === 'roar' ? 0.8 : inp.behavior === 'alert' ? -0.3 : 0;
      for (let i = 0; i < this.ears.length; i++) {
        const s = i === 0 ? 1 : -1;
        setEuler(this.ears[i], -pin * 0.9 + lie * 0.5, s * this.earTwitch * 0.4 * (i === 0 ? 1 : 0.3), s * pin * 0.3);
      }
    }

    // ---- tail spring chain
    const turnK = clamp(-this.turnRate * 0.18, -0.6, 0.6);
    const tailRaise = (running ? 0.15 : 0) + (inp.behavior === 'threaten' ? 0.35 : 0) - lie * 0.2;
    const nT = this.tail.length;
    for (let i = 0; i < nT; i++) {
      const sb = this.tail[i];
      const u = (i + 1) / nT;
      let ty = turnK * u + Math.sin(t * (1.3 + amp * 2) - i * 0.6 + this.seedF * 4) * (0.05 + 0.04 * u) * (sleeping ? 0.2 : 1);
      let tp = -tailRaise * (i === 0 ? 1 : 0.25) - this.accel.y * 0.004 * u;
      if (this.isSnake || this.isFish || swimming) ty += Math.sin(this.wavePhase * Math.PI * 2 - (1 + u) * 4.2) * (this.isFish ? 0.28 * u + 0.08 : 0.3);
      if (sleeping || dead) ty += 0.45 * (this.seedF > 0.5 ? 1 : -1) * lie;
      if (tailArc > 0) tp -= tailArc * (0.5 + u * 0.5);
      if (this.walker && moving && (gk === 'stride' || gk === 'walk')) ty += Math.sin(this.phase * Math.PI * 2) * 0.06;
      const k = 60 / (1 + i * 0.4), c = 9 / (1 + i * 0.15);
      sb.vy += (k * (ty - sb.yaw) - c * sb.vy) * dt;
      sb.vp += (k * (tp - sb.pitch) - c * sb.vp) * dt;
      sb.yaw += sb.vy * dt;
      sb.pitch += sb.vp * dt;
      setEuler(sb.bone, sb.pitch, sb.yaw, 0);
    }

    // ---- antennae & tentacles
    for (let a = 0; a < this.antennae.length; a++) {
      const ch = this.antennae[a];
      for (let i = 0; i < ch.length; i++) {
        const sb = ch[i];
        const ty = turnK * 0.5 + Math.sin(t * 3.1 + a * 2 + i) * 0.12;
        const tp = Math.sin(t * 2.3 + a + i * 0.7) * 0.1 + this.accel.z * 0.003;
        sb.vy += (90 * (ty - sb.yaw) - 6 * sb.vy) * dt;
        sb.vp += (90 * (tp - sb.pitch) - 6 * sb.vp) * dt;
        sb.yaw += sb.vy * dt;
        sb.pitch += sb.vp * dt;
        setEuler(sb.bone, sb.pitch, sb.yaw, 0);
      }
    }
    for (let a = 0; a < this.tentacles.length; a++) {
      const ch = this.tentacles[a];
      for (let i = 0; i < ch.length; i++) {
        const sb = ch[i];
        // Trail against motion; slow waves travel down each tentacle.
        const w = Math.sin(t * 1.4 - i * 0.9 + a * 1.7) * 0.18;
        const tp = clamp(vFwd * 0.12, -0.5, 0.5) + w;
        const ty = clamp(-vSide * 0.12, -0.5, 0.5) + Math.cos(t * 1.1 - i * 0.8 + a) * 0.12;
        sb.vy += (30 * (ty - sb.yaw) - 4 * sb.vy) * dt;
        sb.vp += (30 * (tp - sb.pitch) - 4 * sb.vp) * dt;
        sb.yaw += sb.vy * dt;
        sb.pitch += sb.vp * dt;
        setEuler(sb.bone, sb.pitch, sb.yaw, 0);
      }
    }

    // ---- wings & fins
    const fl = this.flyBlend;
    this.fold = lerp(this.fold, fl > 0.3 ? 0 : 1, damp(fl > 0.3 ? 8 : 3, dt));
    const gliding = move === 'glide' || (fl > 0.5 && vy < -0.5 && hSpeed > sp.walkSpeed * 2);
    const flapRate = sp.wings.kind === 'insect' ? 22 : clamp(5.5 / Math.sqrt(Math.max(0.05, sp.length * scale)), 2, 14);
    this.flapPhase += dt * flapRate * (gliding ? 0.15 : 1) * (fl > 0.1 ? 1 : 0);
    for (const w of this.wings) {
      const s = w.side;
      const fp = this.flapPhase * Math.PI * 2;
      if (w.bones.length === 1) {
        // Insect: buzz when flying, fold back over the abdomen at rest.
        const buzz = Math.sin(fp) * 0.9 * (1 - this.fold);
        setEuler(w.bones[0], 0, s * this.fold * 1.25, s * (buzz - this.fold * 0.15));
      } else {
        // Down-stroke faster than up-stroke: skewed sine.
        const raw = Math.sin(fp + 0.35 * Math.sin(fp));
        const flap = gliding ? Math.sin(t * 1.3) * 0.06 + 0.05 : raw * 0.8;
        const lag = gliding ? 0 : Math.sin(fp - 0.9) * 0.45;
        const f = this.fold;
        setEuler(w.bones[0], 0.1 * f, s * f * 1.35, s * (flap * (1 - f) - f * 0.25));
        setEuler(w.bones[1], 0, -s * f * 2.7, s * lag * (1 - f) * 0.6);
        setEuler(w.bones[2], 0, s * f * 2.5, s * lag * (1 - f) * 0.8);
      }
    }
    for (const f of this.fins) {
      const scull = Math.sin(t * (2 + amp * 6) + (f.side > 0 ? 0 : Math.PI)) * (this.isFloater || sp.role === 'floater' ? 0.5 : 0.3);
      setEuler(f.bone, 0, f.side * scull * 0.4, f.side * scull);
    }

    // ---- legs
    if (this.walker) this.updateLegs(dt, inp, duty, running, frontRaise, lie, crouch, leap);
    if (this.arms.length) this.updateArms(dt, inp, frontRaise, lie);
  }

  /** How low the root sinks when lying down (keeps belly on the ground). */
  private originCenterSink(): number {
    if (this.body.originCenter) return this.body.pelvisHeight;
    const r = this.sp.length * this.sp.girth * this.sp.bodyHeight;
    return Math.min(this.body.pelvisHeight, r * 0.9);
  }

  private neutralFoot(L: LegState, out: THREE.Vector3): THREE.Vector3 {
    // Rest foot in world via the object transform (ignores body sway).
    return out.copy(L.restFoot).applyMatrix4(this.object.matrixWorld);
  }

  private updateLegs(dt: number, inp: RigInput, duty: number, running: boolean, frontRaise: number, lie: number, crouch: number, leap: number) {
    const obj = this.object;
    const scale = inp.scale;
    obj.updateMatrixWorld(true);
    const flying = this.flyBlend > 0.5;
    const swimming = this.swimBlend > 0.5 && inp.move === 'swim';
    const dead = inp.move === 'dead';
    const speed = this.speedS;
    const strideLen = Math.max(0.05, this.strideFor(running) * scale);
    // Phase advance: walking cadence; shuffle when feet are far from neutral.
    let maxErr = 0, anySwing = false;
    for (const L of this.legs) {
      if (!L.initialized) continue;
      this.neutralFoot(L, _v0);
      const e = Math.hypot(_v0.x - L.planted.x, _v0.z - L.planted.z);
      if (e > maxErr) maxErr = e;
      if (L.swinging) anySwing = true;
    }
    const moving = speed > 0.04 * scale;
    const needShuffle = maxErr > strideLen * 0.3;
    if (moving || anySwing || needShuffle) {
      const freq = moving ? clamp(speed / strideLen, 0.6, 9) : 1.6;
      this.phase = (this.phase + dt * freq) % 1;
    }
    const swingH = this.legLen * scale * (running ? 0.26 : 0.17);
    const yHint = inp.pos[1];
    const doRays = inp.lod === 0;
    let hopSwing = 0;
    for (let li = 0; li < this.legs.length; li++) {
      const L = this.legs[li];
      if (!L.initialized) {
        this.neutralFoot(L, L.planted);
        const gy = doRays ? this.ground.height(L.planted.x, yHint, L.planted.z) : NaN;
        L.planted.y = Number.isFinite(gy) ? gy : inp.pos[1];
        L.groundY = L.planted.y;
        L.foot.copy(L.planted);
        L.initialized = true;
      }
      const p = (this.phase + L.offset) % 1;
      const inSwing = p >= duty && (moving || anySwing || needShuffle);
      if (inSwing && !L.swinging) {
        L.swinging = true;
        L.lift.copy(L.planted);
      }
      if (L.swinging) {
        const s = clamp((p - duty) / (1 - duty), 0, 1);
        // Predict landing: neutral spot + half a stance of travel.
        this.neutralFoot(L, L.target);
        const stanceTime = duty / Math.max(0.6, speed / strideLen);
        L.target.x += inp.vel[0] * stanceTime * 0.5;
        L.target.z += inp.vel[2] * stanceTime * 0.5;
        if (s < 0.08 || !Number.isFinite(L.groundY) || (doRays && s > 0.6 && s < 0.7)) {
          const gy = doRays ? this.ground.height(L.target.x, yHint, L.target.z) : NaN;
          L.groundY = Number.isFinite(gy) ? gy : inp.pos[1] + (L.target.y - obj.position.y) * 0;
        }
        L.target.y = L.groundY;
        const e = ease(s);
        L.foot.lerpVectors(L.lift, L.target, e);
        L.foot.y += Math.sin(Math.PI * s) * swingH;
        if (p < duty || s >= 1 || !(moving || anySwing || needShuffle)) {
          L.swinging = false;
          L.planted.copy(L.target);
          L.foot.copy(L.planted);
        }
        if (this.sp.gait === 'hop' || this.gaitKind(running) === 'hop' || this.gaitKind(running) === 'bound') hopSwing = Math.max(hopSwing, Math.sin(Math.PI * s));
      } else {
        L.foot.copy(L.planted);
      }
      // Detach feet that are hopelessly far (teleports / respawn).
      this.neutralFoot(L, _v0);
      if (_v0.distanceToSquared(L.planted) > (strideLen * 3) ** 2) {
        L.planted.copy(_v0);
        L.planted.y = inp.pos[1];
        L.foot.copy(L.planted);
        L.swinging = false;
      }
    }
    this.hopLift = lerp(this.hopLift, hopSwing * this.legLen * (running ? 0.35 : 0.15), damp(12, dt));

    // Body has moved (root bone pose) — refresh hips, then solve each leg.
    this.root.updateMatrixWorld(true);
    for (const L of this.legs) {
      _v1.copy(L.foot);
      const d = L.def;
      const restF = L.restFoot;
      // Pose overrides: flying/swimming tuck, lying down folds, dead legs stiff, raised front paw.
      let tuck = 0;
      if (flying) tuck = 1;
      else if (swimming) tuck = 0.5;
      if (tuck > 0 || lie > 0.02 || dead || (frontRaise > 0 && d.along > 0.5 && d.side > 0) || leap > 0) {
        // Target in model space, then to world.
        _v2.copy(restF);
        if (tuck > 0) {
          const paddle = swimming ? Math.sin(inp.time * 5 + d.pairIndex * 1.7 + (d.side > 0 ? 0 : Math.PI)) * 0.3 : 0;
          _v2.set(restF.x * 0.6, this.body.pelvisHeight * (0.45 + 0.2 * tuck), restF.z - this.legLen * (0.35 + paddle) * (d.along > 0.5 ? -0.3 : 1));
        }
        if (lie > 0.02) {
          const hp = this.body.bones[d.bones[0]].pos;
          _v3.set(hp[0] + d.side * this.legLen * 0.25, this.body.pelvisHeight * 0.08, hp[2] + (d.along > 0.5 ? this.legLen * 0.45 : -this.legLen * 0.1));
          _v2.lerp(_v3, lie);
        }
        if (dead) {
          const hp = this.body.bones[d.bones[0]].pos;
          _v3.set(hp[0] + d.side * this.legLen * 0.9, hp[1] - this.legLen * 0.3, hp[2] + (d.along > 0.5 ? 0.3 : -0.3) * this.legLen);
          _v2.lerp(_v3, ease(this.deadT));
        }
        if (frontRaise > 0 && d.along > 0.5 && d.side > 0) {
          const hp = this.body.bones[d.bones[0]].pos;
          _v3.set(hp[0], hp[1] - this.legLen * 0.25, hp[2] + this.legLen * 0.8);
          _v2.lerp(_v3, frontRaise);
        }
        if (leap > 0) {
          const hp = this.body.bones[d.bones[0]].pos;
          _v3.set(hp[0], hp[1] - this.legLen * 0.5, hp[2] + (d.along > 0.5 ? this.legLen * 0.7 : -this.legLen * 0.7));
          _v2.lerp(_v3, leap);
        }
        _v2.applyMatrix4(this.root.matrixWorld);
        const w = clamp(Math.max(tuck, lie, dead ? 1 : 0, frontRaise > 0 && d.along > 0.5 && d.side > 0 ? frontRaise : 0, leap), 0, 1);
        _v1.lerp(_v2, w);
        if (w > 0.5) { L.planted.copy(_v1); L.swinging = false; }
      }
      void crouch;
      this.solveLeg(L, _v1, scale);
    }
  }

  /** Swing arms opposite to legs (upright bipeds); actions lift them. */
  private updateArms(dt: number, inp: RigInput, raise: number, lie: number) {
    this.root.updateMatrixWorld(true);
    for (const A of this.arms) {
      const d = A.def;
      const swing = Math.sin((this.phase + (d.side > 0 ? 0.5 : 0)) * Math.PI * 2) * clamp(this.speedS / Math.max(0.2, this.sp.walkSpeed), 0, 1.5) * 0.25;
      const hp = this.body.bones[d.bones[0]].pos;
      const len = d.lens[0] + d.lens[1];
      _v2.set(d.foot[0], d.foot[1] + Math.abs(swing) * len * 0.1, d.foot[2] + swing * len);
      if (raise > 0) {
        _v3.set(hp[0] - d.side * len * 0.1, hp[1] + len * 0.4, hp[2] + len * 0.6);
        _v2.lerp(_v3, raise);
      }
      if (lie > 0.02) {
        _v3.set(hp[0] + d.side * len * 0.5, this.body.pelvisHeight * 0.1, hp[2] + len * 0.3);
        _v2.lerp(_v3, lie);
      }
      _v2.applyMatrix4(this.root.matrixWorld);
      A.foot.lerp(_v2, damp(14, dt));
      this.solveLeg(A, A.foot, inp.scale);
    }
  }

  /** Two-bone IK (+ fixed-lean third segment) in world space, written into local bone rotations. */
  private solveLeg(L: LegState, footW: THREE.Vector3, scale: number) {
    const d = L.def;
    const bs = L.bones;
    const hipB = bs[0];
    const parent = hipB.parent as THREE.Object3D;
    // Hip world position (parent matrix is current; hip rotation does not move its origin).
    _v0.copy(hipB.position).applyMatrix4(parent.matrixWorld);
    worldQuat(parent, _q0); // parent world rotation
    // Pole & ankle lean in world space follow the object's yaw (not body sway).
    worldQuat(this.object, _q2);
    _v4.copy(L.pole).applyQuaternion(_q2);
    const l1 = d.lens[0] * scale, l2 = d.lens[1] * scale;
    // Target for the 2-bone part: the foot, or the ankle for digitigrade legs.
    if (d.digitigrade && bs.length === 3) {
      _v3.set(0, d.ankleUp, d.ankleFwd).normalize().applyQuaternion(_q2).multiplyScalar(d.lens[2] * scale);
      _v1.copy(footW).add(_v3); // ankle
    } else _v1.copy(footW);
    _hip[0] = _v0.x; _hip[1] = _v0.y; _hip[2] = _v0.z;
    _tgt[0] = _v1.x; _tgt[1] = _v1.y; _tgt[2] = _v1.z;
    _pole[0] = _v4.x; _pole[1] = _v4.y; _pole[2] = _v4.z;
    solveKnee(_hip, _tgt, l1, l2, _pole, _knee);
    _v2.set(_knee[0], _knee[1], _knee[2]);
    // Upper segment: hip → knee.
    _v3.subVectors(_v2, _v0).normalize().applyQuaternion(_q1.copy(_q0).invert());
    hipB.quaternion.setFromUnitVectors(L.restDirs[0], _v3);
    _q0.multiply(hipB.quaternion);
    // Lower segment: knee → ankle/foot.
    _v3.subVectors(_v1, _v2).normalize().applyQuaternion(_q1.copy(_q0).invert());
    bs[1].quaternion.setFromUnitVectors(L.restDirs[1], _v3);
    if (bs.length === 3) {
      _q0.multiply(bs[1].quaternion);
      _v3.subVectors(footW, _v1).normalize().applyQuaternion(_q1.copy(_q0).invert());
      bs[2].quaternion.setFromUnitVectors(L.restDirs[2], _v3);
    }
  }
}

export { AX_X, AX_Y, AX_Z };
