/**
 * Client views for 'creature' entities.
 *
 * Each species gets procedurally meshed skinned geometry (two LODs, shared by
 * all individuals) from its genome; each individual gets its own skeleton,
 * materials (per-individual colour jitter, sky occlusion, glow & hurt flash)
 * and a CreatureRig that animates it procedurally from the replicated motion.
 *
 * LOD: < ~35 m (scaled by size) full-res mesh, foot raycasts, shadows;
 * < ~90 m low-res mesh, IK without raycasts, animated at half rate;
 * beyond that the rig ticks at a quarter rate and eyes are hidden.
 * The high-res geometry is built lazily (one species per frame) the first
 * time an individual comes close.
 */
import * as THREE from 'three';
import type { ClientContext, ClientModule, EntityView, EntityViewFactory } from '../../client/context';
import type { EntitySnapshot, GameEvent } from '../../shared/protocol';
import { EntFlag } from '../../shared/types';
import { speciesList, individualScale, type Species } from '../species';
import { buildBody, type BodyLayout } from '../body';
import type { MeshJob, MeshResult, PackedGeometry } from './creatureMesh.worker';
import { buildCreatureGeometry, eyeGeometry, type CreatureGeometries } from './creatureMesh';
import { createBodyMaterial, createEyeMaterial, createMembraneMaterial, makeCreatureUniforms, type CreatureUniforms } from './creatureMaterial';
import { CreatureRig, type GroundSampler } from './rig';
import { clamp, smoothstep } from '../../core/math';

/** Per-species shared assets. */
export interface SpeciesAssets {
  sp: Species;
  body: BodyLayout;
  lod1: CreatureGeometries;
  lod0: CreatureGeometries | null;
  pendingLod0: boolean;
}

const assetCache = new Map<string, SpeciesAssets>();
const buildQueue: SpeciesAssets[] = [];

/** Shared per-species meshes (also used by the sandbox bestiary). */
export function speciesAssets(sp: Species, faunaSeed: number): SpeciesAssets {
  const key = faunaSeed + ':' + sp.index;
  let a = assetCache.get(key);
  if (!a) {
    const body = buildBody(sp);
    a = { sp, body, lod1: buildCreatureGeometry(body, 26), lod0: null, pendingLod0: false };
    assetCache.set(key, a);
  }
  return a;
}

function requestLod0(a: SpeciesAssets) {
  if (a.lod0 || a.pendingLod0) return;
  a.pendingLod0 = true;
  buildQueue.push(a);
}

// ------------------------------------------------------------------ high-res meshing worker

/** World seed for worker-side species regeneration (set by CreatureViews.init). */
let workerSeed: number | null = null;
let meshWorker: Worker | null = null;
let meshJobId = 1;
const meshJobs = new Map<number, SpeciesAssets>();

function unpack(p: PackedGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const a of p.attributes) g.setAttribute(a.name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (p.index) g.setIndex(new THREE.BufferAttribute(p.index, 1));
  g.computeBoundingSphere();
  return g;
}

function ensureWorker(): Worker {
  if (meshWorker) return meshWorker;
  meshWorker = new Worker(new URL('./creatureMesh.worker.ts', import.meta.url), { type: 'module' });
  meshWorker.onmessage = (ev: MessageEvent<MeshResult>) => {
    const a = meshJobs.get(ev.data.id);
    meshJobs.delete(ev.data.id);
    if (!a) return;
    a.lod0 = { body: unpack(ev.data.body), membrane: ev.data.membrane ? unpack(ev.data.membrane) : null };
    a.pendingLod0 = false;
  };
  meshWorker.onerror = (e) => console.error('[creatures] mesh worker error', e.message);
  return meshWorker;
}

/**
 * Dispatch queued high-res species meshes (call once per frame). In the game they
 * build in a worker; without a world seed (sandboxes) one is built synchronously.
 */
export function pumpCreatureBuilds(budgetMs = 12): void {
  if (workerSeed !== null) {
    const w = ensureWorker();
    while (buildQueue.length) {
      const a = buildQueue.shift()!;
      const id = meshJobId++;
      meshJobs.set(id, a);
      w.postMessage({ id, seed: workerSeed, species: a.sp.index, res: 60 } satisfies MeshJob);
    }
    return;
  }
  const t0 = performance.now();
  while (buildQueue.length && performance.now() - t0 < budgetMs) {
    const a = buildQueue.shift()!;
    a.lod0 = buildCreatureGeometry(a.body, 60);
    a.pendingLod0 = false;
    break;
  }
}

const _identity = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();

export interface CreatureViewOptions {
  ground: GroundSampler;
  /** Camera position for LOD selection. */
  camera: THREE.Camera;
  /** 0..1 darkness for bioluminescence (night). */
  darkness: () => number;
  /** Server time (for action phase), or NaN if unknown. */
  serverTime: () => number;
}

/** One animated creature. Exported for the sandbox. */
export class CreatureView implements EntityView {
  readonly object = new THREE.Group();
  headHeight: number;
  radius: number;
  readonly rig: CreatureRig;
  readonly uniforms: CreatureUniforms;
  private mesh: THREE.SkinnedMesh;
  private membrane: THREE.SkinnedMesh | null = null;
  private eyes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private skeleton: THREE.Skeleton;
  private lod = -1;
  private acc = 0;
  private skyVis = 1;
  private actionKey = '';
  private actionStart = 0;
  private localAction: { id: string; start: number; dur: number } | null = null;
  private scale = 1;
  private visible = true;
  readonly assets: SpeciesAssets;

  constructor(assets: SpeciesAssets, private seed: number, growth: number, private opts: CreatureViewOptions) {
    this.assets = assets;
    const sp = assets.sp, body = assets.body;
    this.uniforms = makeCreatureUniforms();
    this.scale = individualScale(sp, seed, growth);
    // Skeleton: identity rest rotations, positions relative to parents.
    const bones: THREE.Bone[] = body.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      return bone;
    });
    const inverses: THREE.Matrix4[] = [];
    body.bones.forEach((b, i) => {
      const pp = b.parent >= 0 ? body.bones[b.parent].pos : [0, 0, 0];
      bones[i].position.set(b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]);
      if (b.parent >= 0) bones[b.parent].add(bones[i]);
      inverses.push(new THREE.Matrix4().makeTranslation(-b.pos[0], -b.pos[1], -b.pos[2]));
    });
    this.object.add(bones[0]);
    this.skeleton = new THREE.Skeleton(bones, inverses);
    const bodyMat = createBodyMaterial(sp, seed, this.uniforms);
    this.materials.push(bodyMat);
    this.mesh = new THREE.SkinnedMesh(assets.lod1.body, bodyMat);
    this.mesh.bind(this.skeleton, _identity);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.setBounds(assets.lod1);
    this.object.add(this.mesh);
    if (assets.lod1.membrane) {
      const mm = createMembraneMaterial(sp, seed, this.uniforms);
      this.materials.push(mm);
      this.membrane = new THREE.SkinnedMesh(assets.lod1.membrane, mm);
      this.membrane.bind(this.skeleton, _identity);
      this.membrane.castShadow = true;
      this.object.add(this.membrane);
    }
    if (body.eyes.length) {
      const em = createEyeMaterial(sp, this.uniforms);
      this.materials.push(em);
      for (const e of body.eyes) {
        const m = new THREE.Mesh(eyeGeometry(), em);
        const hb = body.bones[e.bone].pos;
        m.position.set(e.pos[0] - hb[0], e.pos[1] - hb[1], e.pos[2] - hb[2]);
        m.scale.setScalar(e.radius);
        _dir.set(e.dir[0], e.dir[1], e.dir[2]);
        m.quaternion.copy(_q.setFromUnitVectors(_fwd, _dir));
        bones[e.bone].add(m);
        this.eyes.push(m);
      }
    }
    this.headHeight = body.headHeight * this.scale;
    this.radius = sp.radius * this.scale;
    this.object.name = 'creature:' + sp.name;
    this.rig = new CreatureRig(sp, body, bones, this.object, opts.ground, seed);
  }

  private setBounds(g: CreatureGeometries) {
    const bs = g.body.boundingSphere!;
    // Generous sphere so animated limbs never get frustum-culled.
    const s = new THREE.Sphere(bs.center.clone(), bs.radius * 1.6);
    this.mesh.boundingSphere = s;
    if (this.membrane) this.membrane.boundingSphere = s.clone();
  }

  private setLod(l: number) {
    if (l === this.lod) return;
    const a = this.assets;
    if (l === 0) {
      if (!a.lod0) {
        requestLod0(a);
        l = 1;
      }
    }
    if (l === this.lod) return;
    this.lod = l;
    const g = l === 0 && a.lod0 ? a.lod0 : a.lod1;
    if (this.mesh.geometry !== g.body) {
      this.mesh.geometry = g.body;
      if (this.membrane && g.membrane) this.membrane.geometry = g.membrane;
      this.setBounds(g);
    }
    this.mesh.castShadow = l <= 1;
    if (this.membrane) this.membrane.castShadow = l === 0;
    for (const e of this.eyes) e.visible = l < 2;
  }

  update(snap: EntitySnapshot, dt: number, time: number): void {
    const cam = this.opts.camera.position;
    const dx = snap.pos[0] - cam.x, dy = snap.pos[1] - cam.y, dz = snap.pos[2] - cam.z;
    const sizeK = clamp(this.assets.sp.totalLength * this.scale, 0.4, 8);
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.sqrt(sizeK);
    const lod = dist < 26 ? 0 : dist < 70 ? 1 : 2;
    // Re-request the high-res mesh once it finished building.
    if (lod === 0 && this.lod !== 0) this.lod = -1;
    this.setLod(lod);
    const u = this.uniforms;
    u.time.value = time;
    u.hurt.value = Math.max(0, u.hurt.value - dt * 3);
    const dark = this.opts.darkness();
    u.glowLevel.value = clamp(1 - (1 - dark) * this.skyVis, 0, 1);
    u.dead.value = snap.anim.move === 'dead' ? Math.min(1, u.dead.value + dt * 0.5) : 0;
    // Animate at reduced rate when far away.
    this.acc += dt;
    const every = lod === 0 ? 0 : lod === 1 ? 1 / 30 : 1 / 12;
    if (this.acc < every) return;
    const step = this.acc;
    this.acc = 0;
    const scale = this.scale * (snap.scale ?? 1);
    this.headHeight = this.assets.body.headHeight * scale;
    this.radius = this.assets.sp.radius * scale;
    // Action timing: prefer server clock, fall back to local first-seen time.
    let action: { id: string; t: number; dur: number } | null = null;
    const a = snap.anim.action;
    if (a) {
      const key = a.id + ':' + a.t0;
      if (key !== this.actionKey) {
        this.actionKey = key;
        const st = this.opts.serverTime();
        const late = Number.isFinite(st) ? clamp(st - a.t0, 0, a.dur) : 0;
        this.actionStart = time - late;
      }
      const t = time - this.actionStart;
      if (t <= a.dur) action = { id: a.id, t, dur: a.dur };
    }
    if (!action && this.localAction) {
      const t = time - this.localAction.start;
      if (t <= this.localAction.dur) action = { id: this.localAction.id, t, dur: this.localAction.dur };
      else this.localAction = null;
    }
    if (snap.flags & EntFlag.Sleeping && !action) action = { id: 'sleep', t: 0, dur: 1 };
    this.rig.update(step, {
      pos: snap.pos, yaw: snap.yaw, vel: snap.vel, move: snap.anim.move, action,
      lookAt: snap.anim.lookAt ?? null, behavior: snap.creature?.behavior ?? '', time, lod, scale,
    });
  }

  onEvent(ev: GameEvent): void {
    if (ev.type === 'damage') {
      this.uniforms.hurt.value = 1;
      if (!this.localAction) this.localAction = { id: 'flinch', start: this.uniforms.time.value, dur: 0.35 };
    }
  }

  getSocket(name: string): THREE.Object3D | null {
    const b = this.assets.body;
    const bones = this.skeleton.bones;
    if (name === 'head' || name === 'mouth') return bones[name === 'mouth' && b.jaw >= 0 ? b.jaw : b.head] ?? null;
    if (name === 'chest' || name === 'back') return bones[b.spine[b.spine.length - 1]] ?? null;
    return null;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.object.visible = v;
  }

  setSkyVis(v: number): void {
    this.skyVis = v;
    for (const s of this.uniforms.skyVis) s.value = v;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.object.removeFromParent();
  }
}

/** Darkness 0 (noon) .. 1 (night) from a time of day 0..1. */
export function darknessAt(timeOfDay: number): number {
  const sunH = Math.sin((timeOfDay - 0.25) * Math.PI * 2);
  return 1 - smoothstep(-0.12, 0.2, sunH);
}

export class CreatureViews implements EntityViewFactory, ClientModule {
  readonly name = 'creatures';
  readonly kinds = ['creature' as const];
  private ctx!: ClientContext;
  private ground!: GroundSampler;

  init(ctx: ClientContext) {
    this.ctx = ctx;
    workerSeed = ctx.seed;
    const terrain = ctx.terrain;
    this.ground = {
      height(x: number, yHint: number, z: number): number {
        const hit = terrain.raycast(x, yHint + 2.5, z, 0, -1, 0, 9);
        return hit ? hit.y : NaN;
      },
    };
  }

  create(snap: EntitySnapshot, ctx: ClientContext): EntityView | null {
    const ref = snap.creature;
    if (!ref) return null;
    if (!this.ctx) this.init(ctx);
    const list = speciesList(ctx.profile);
    const sp = list[ref.species];
    if (!sp) return null;
    const assets = speciesAssets(sp, ctx.profile.faunaSeed);
    const view = new CreatureView(assets, ref.seed, ref.growth, {
      ground: this.ground,
      camera: ctx.camera,
      darkness: () => darknessAt(ctx.env?.timeOfDay ?? ctx.state.timeOfDay),
      serverTime: () => ctx.state.serverTime,
    });
    view.object.position.set(snap.pos[0], snap.pos[1], snap.pos[2]);
    return view;
  }

  update(_dt: number, _time: number) {
    pumpCreatureBuilds();
  }
}
