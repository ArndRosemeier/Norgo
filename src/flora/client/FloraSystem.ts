/**
 * FloraSystem — client module rendering vegetation, rocks and small props.
 *
 *  - Listens to `streamer.events.chunkScatter`: per chunk and scatter kind one
 *    InstancedMesh is attached to `entry.group`, so flora shares the terrain's
 *    LOD visibility. Detail tier follows the chunk LOD (0 full … 2 low, 3 impostor).
 *  - Registers static colliders (LOD-0 chunks) for destructible / harvestable
 *    objects with their server object id and an interaction prompt.
 *  - Applies replicated ObjectStates: trees fall over along `dir` and break
 *    into logs, rocks shatter, damaged objects shake and crack, harvested plants
 *    shrink away; regrown plants reappear.
 *  - Drives the shared flora uniforms (wind, time, player push, sun translucency).
 */
import * as THREE from 'three';
import type { ClientContext, ClientModule, StaticCollider } from '../../client/context';
import type { ChunkEntry } from '../../world/streamer';
import type { ScatterBatch } from '../../world/scatterTypes';
import { SCATTER_STRIDE } from '../../world/scatterTypes';
import type { ObjectState } from '../../shared/protocol';
import type { Vec3 } from '../../shared/types';
import { parseKind, FloraSpecies, ParsedKind } from '../species';
import { FloraLibrary } from './library';

/** One InstancedMesh of a chunk. */
interface ChunkMesh {
  mesh: THREE.InstancedMesh;
  sp: FloraSpecies;
  variant: number;
  mat: number;
  tier: number;
  data: Float32Array;
  ids: Uint32Array | null;
  /** Ground cover that fades with distance: hidden entirely once its chunk is past the fade range. */
  fades: boolean;
}

interface ChunkFlora {
  entry: ChunkEntry;
  meshes: ChunkMesh[];
  owner: string;
  stumps: THREE.Mesh[];
  stumped: Set<number>;
  hasColliders: boolean;
  /** Chunk lies entirely below the 2D surface (cave flora): skipped while the camera is above ground. */
  deep: boolean;
  /** Last applied cull visibility of the deep flora. */
  deepShown: boolean;
}

interface InstRef {
  cf: ChunkFlora;
  cm: ChunkMesh;
  i: number;
}

interface FallAnim {
  mesh: THREE.Mesh;
  sp: FloraSpecies;
  base: THREE.Vector3;
  axis: THREE.Vector3;
  dir: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  scale: number;
  angle: number;
  vel: number;
  height: number;
  sky: number;
}

interface ShakeAnim {
  refs: InstRef[];
  t: number;
  dur: number;
  amp: number;
  axis: THREE.Vector3;
}

interface ShrinkAnim {
  refs: InstRef[];
  t: number;
  dur: number;
}

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpE = new THREE.Euler(0, 0, 0, 'XZY');
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const kindTmp: ParsedKind = { sp: -1, variant: 0, mat: -1 };

/**
 * Keep a deterministic `density` fraction (0.25..1) of a scatter batch: a per-instance hash
 * decides, so the thinning is even (not a cut-off region) and stable across re-streams.
 * Returns the input unchanged at density ≥ 1.
 */
function thinInstances(d: Float32Array, density: number, salt: number): Float32Array {
  if (!(density < 1)) return d;
  const n = d.length / SCATTER_STRIDE;
  const keep = Math.max(0.25, density);
  const out = new Float32Array(d.length);
  let k = 0;
  for (let i = 0; i < n; i++) {
    let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    if (((h ^ (h >>> 13)) >>> 0) / 4294967296 >= keep) continue;
    out.set(d.subarray(i * SCATTER_STRIDE, (i + 1) * SCATTER_STRIDE), k * SCATTER_STRIDE);
    k++;
  }
  return out.slice(0, k * SCATTER_STRIDE);
}

/** Compose an instance matrix from scatter data (local to the chunk group). */
function composeInstance(d: Float32Array, o: number, out: THREE.Matrix4, extraQ?: THREE.Quaternion, scaleMul = 1) {
  tmpE.set(d[o + 5], d[o + 3], d[o + 6], 'XZY');
  tmpQ.setFromEuler(tmpE);
  if (extraQ) tmpQ.premultiply(extraQ);
  const s = d[o + 4] * scaleMul;
  tmpP.set(d[o], d[o + 1], d[o + 2]);
  tmpS.set(s, s, s);
  return out.compose(tmpP, tmpQ, tmpS);
}

export class FloraSystem implements ClientModule {
  readonly name = 'flora';
  private ctx!: ClientContext;
  lib!: FloraLibrary;
  private chunks = new Map<string, ChunkFlora>();
  private idIndex = new Map<number, InstRef[]>();
  private states = new Map<number | string, ObjectState>();
  private falls: FallAnim[] = [];
  private shakes: ShakeAnim[] = [];
  private shrinks: ShrinkAnim[] = [];
  private animating = new Set<number>();
  private offs: (() => void)[] = [];
  private stumpGeo: THREE.CylinderGeometry | null = null;
  /** Stats for the debug overlay. */
  stats = { chunks: 0, meshes: 0, instances: 0 };

  init(ctx: ClientContext) {
    this.ctx = ctx;
    this.lib = new FloraLibrary(ctx.profile, ctx.core.renderer);
    const ev = ctx.streamer.events;
    this.offs.push(ev.on('chunkScatter', ({ entry, batches }) => this.onScatter(entry, batches)));
    this.offs.push(ev.on('chunkDisposed', ({ entry }) => this.onDisposed(entry)));
    this.offs.push(ev.on('chunkMeshed', ({ entry }) => this.onMeshed(entry)));
    this.offs.push(ctx.events.on('objects', (states) => this.onStates(states, true)));
    // Impostor atlas lives only on the GPU: redraw it after a context loss (iOS background tabs).
    this.offs.push(ctx.core.onContextRestored(() => this.lib.recaptureImpostors()));
    // States known before we were initialised (save loaded, join).
    if (ctx.state.objects.size) this.onStates([...ctx.state.objects.values()], false);
  }

  // ------------------------------------------------------------------ chunk lifecycle

  private onScatter(entry: ChunkEntry, batches: ScatterBatch[]) {
    if (this.chunks.has(entry.key)) this.onDisposed(entry);
    const surf = this.ctx.gen.heightAt(entry.ox + entry.size / 2, entry.oz + entry.size / 2);
    const cf: ChunkFlora = { entry, meshes: [], owner: 'flora:' + entry.key, stumps: [], stumped: new Set(), hasColliders: false, deep: entry.oy + entry.size < surf - 12, deepShown: true };
    const lod = entry.lod;
    for (const b of batches) {
      parseKind(b.kind, kindTmp);
      const sp = this.lib.cat.species[kindTmp.sp];
      if (!sp) continue;
      const tier = Math.min(lod, 3);
      const fg = tier === 3 && sp.cls === 'tree' ? this.lib.impostor(sp.idx, kindTmp.variant) : this.lib.geometry(sp.idx, kindTmp.variant, kindTmp.mat, Math.min(tier, 2));
      if (!fg) continue;
      // Vegetation setting (graphics preset / device profile): thin decorative ground cover.
      // Only id-less batches (no server objects, colliders or states depend on their indices).
      const d = fg.kind === 'grass' && !b.ids ? thinInstances(b.data, this.ctx.core.settings.vegetation, entry.ox * 31 + entry.oz * 17 + entry.oy) : b.data;
      const n = d.length / SCATTER_STRIDE;
      if (n === 0) continue;
      const material = this.lib.materials[fg.kind];
      const mesh = new THREE.InstancedMesh(fg.geo, material, n);
      mesh.name = 'flora:' + sp.key;
      mesh.matrixAutoUpdate = false;
      mesh.customDepthMaterial = this.lib.depthMaterials[fg.kind];
      // Shadow casters are limited to what reads at distance: trees up to tier 1, big props at tier 0.
      mesh.castShadow = sp.shadow && (sp.cls === 'tree' ? tier <= 1 : tier === 0);
      mesh.receiveShadow = fg.kind !== 'impostor';
      const inst = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const o = i * SCATTER_STRIDE;
        const packed = d[o + 7];
        inst[i * 3] = packed - Math.floor(packed);
        inst[i * 3 + 1] = Math.floor(packed) / 31;
        inst[i * 3 + 2] = 0;
        composeInstance(d, o, tmpM);
        mesh.setMatrixAt(i, tmpM);
      }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(inst, 3);
      const cm: ChunkMesh = { mesh, sp, variant: kindTmp.variant, mat: kindTmp.mat, tier, data: d, ids: b.ids ?? null, fades: fg.kind === 'grass' };
      cf.meshes.push(cm);
      if (cm.ids) {
        for (let i = 0; i < n; i++) {
          const id = cm.ids[i];
          let l = this.idIndex.get(id);
          if (!l) this.idIndex.set(id, (l = []));
          l.push({ cf, cm, i });
        }
      }
      entry.group.add(mesh);
      this.stats.meshes++;
      this.stats.instances += n;
    }
    this.chunks.set(entry.key, cf);
    this.stats.chunks = this.chunks.size;
    // Apply known object states silently, then register colliders.
    for (const cm of cf.meshes) {
      if (!cm.ids) continue;
      for (let i = 0; i < cm.ids.length; i++) {
        const st = this.states.get(cm.ids[i]);
        if (st) this.applyToInstance({ cf, cm, i }, st, false);
      }
    }
    for (const cm of cf.meshes) {
      cm.mesh.instanceMatrix.needsUpdate = true;
      if (cm.mesh.instanceColor) cm.mesh.instanceColor.needsUpdate = true;
      cm.mesh.computeBoundingSphere();
    }
    if (lod === 0) this.addColliders(cf);
  }

  private onDisposed(entry: ChunkEntry) {
    const cf = this.chunks.get(entry.key);
    if (!cf) return;
    for (const cm of cf.meshes) {
      entry.group.remove(cm.mesh);
      cm.mesh.dispose();
      if (cm.ids) {
        for (const id of cm.ids) {
          const l = this.idIndex.get(id);
          if (!l) continue;
          const k = l.filter((r) => r.cf !== cf);
          if (k.length) this.idIndex.set(id, k);
          else this.idIndex.delete(id);
        }
      }
      this.stats.meshes--;
      this.stats.instances -= cm.data.length / SCATTER_STRIDE;
    }
    for (const s of cf.stumps) entry.group.remove(s);
    if (cf.hasColliders) this.ctx.colliders.removeOwner(cf.owner);
    this.chunks.delete(entry.key);
    this.stats.chunks = this.chunks.size;
  }

  /** After terrain edits regenerate a chunk: drop plants whose ground was dug away. */
  private onMeshed(entry: ChunkEntry) {
    if (entry.lod > 1) return;
    const cf = this.chunks.get(entry.key);
    if (!cf) return;
    const pad = 3;
    const edits = this.ctx.streamer.edits.query(entry.ox - pad, entry.oy - pad, entry.oz - pad, entry.ox + entry.size + pad, entry.oy + entry.size + pad, entry.oz + entry.size + pad);
    if (!edits.length) return;
    const terrain = this.ctx.terrain;
    for (const cm of cf.meshes) {
      const d = cm.data;
      const n = d.length / SCATTER_STRIDE;
      let changed = false;
      for (let i = 0; i < n; i++) {
        const o = i * SCATTER_STRIDE;
        const x = entry.ox + d[o], y = entry.oy + d[o + 1], z = entry.oz + d[o + 2];
        let near = false;
        for (const e of edits) {
          const dx = e.x - x, dy = e.y - y, dz = e.z - z;
          const r = e.radius + 1;
          if (dx * dx + dy * dy + dz * dz < r * r) {
            near = true;
            break;
          }
        }
        if (!near) continue;
        // Hanging species hold on to ceilings: test above; others need ground below.
        const hang = Math.abs(d[o + 5]) > 2;
        const supported = hang ? terrain.density(x, y + 0.25, z) > 0 : terrain.density(x, y - 0.25, z) > 0 || terrain.density(x, y - 0.6, z) > 0;
        if (!supported) {
          cm.mesh.setMatrixAt(i, ZERO);
          changed = true;
          if (cm.ids) this.ctx.colliders.remove('flora:' + cm.ids[i]);
        }
      }
      if (changed) cm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ colliders

  private addColliders(cf: ChunkFlora) {
    const e = cf.entry;
    for (const cm of cf.meshes) {
      const sp = cm.sp;
      if (!cm.ids || !sp.col) continue;
      const d = cm.data;
      const n = cm.ids.length;
      for (let i = 0; i < n; i++) {
        const id = cm.ids[i];
        const st = this.states.get(id);
        if (st && (st.state === 'destroyed' || st.state === 'felled') && !(st.hp >= st.maxHp)) continue;
        this.ctx.colliders.add(this.colliderFor(cf, cm, i, id, e, d));
        cf.hasColliders = true;
      }
    }
  }

  private colliderFor(cf: ChunkFlora, cm: ChunkMesh, i: number, id: number, e: ChunkEntry, d: Float32Array): StaticCollider {
    const sp = cm.sp;
    const col = sp.col!;
    const o = i * SCATTER_STRIDE;
    const s = d[o + 4];
    const x = e.ox + d[o], y = e.oy + d[o + 1], z = e.oz + d[o + 2];
    // Surface-aligned species: offset the sphere along their up axis.
    tmpE.set(d[o + 5], d[o + 3], d[o + 6], 'XZY');
    tmpV.set(0, 1, 0).applyEuler(tmpE);
    const c: StaticCollider = {
      id: 'flora:' + id,
      owner: cf.owner,
      shape: col.shape,
      pos: col.shape === 'sphere' ? [x + tmpV.x * col.h * s, y + tmpV.y * col.h * s, z + tmpV.z * col.h * s] : [x, y - 0.2, z],
      radius: Math.max(0.12, col.r * s),
      objectId: id,
      interact: sp.interact || undefined,
      material: sp.material,
      solid: col.solid,
    };
    if (col.shape === 'capsule') c.height = col.h * s;
    return c;
  }

  // ------------------------------------------------------------------ object states

  private onStates(states: ObjectState[], live: boolean) {
    const now = this.ctx.state.serverTime;
    for (const st of states) {
      const prev = this.states.get(st.id);
      this.states.set(st.id, st);
      if (typeof st.id !== 'number') continue;
      const refs = this.idIndex.get(st.id);
      if (!refs || !refs.length) continue;
      const recent = live && now - st.t < 6;
      this.applyState(st.id, refs, st, prev, recent);
    }
  }

  private applyState(id: number, refs: InstRef[], st: ObjectState, prev: ObjectState | undefined, animate: boolean) {
    const sp = refs[0].cm.sp;
    const restored = st.state === 'damaged' && st.hp >= st.maxHp;
    if (restored) {
      this.animating.delete(id);
      for (const r of refs) this.showInstance(r);
      this.refreshCollider(refs, true);
      return;
    }
    if (st.state === 'damaged') {
      for (const r of refs) this.applyToInstance(r, st, false);
      if (animate && (!prev || prev.hp > st.hp)) this.hitFeedback(refs, st, sp);
      return;
    }
    // Destroyed / felled.
    if (animate && !this.animating.has(id)) {
      const ref = this.visibleRef(refs);
      if (ref) {
        this.animating.add(id);
        if (st.state === 'felled' && sp.cls === 'tree') this.startFall(ref, st);
        else if (sp.harvest || sp.cls === 'plant' || sp.cls === 'shrub' || sp.cls === 'cover' || sp.cls === 'debris') this.startShrink(refs, id);
        else this.shatter(ref, st);
      }
    }
    for (const r of refs) {
      if (!this.shrinks.some((s) => s.refs.includes(r))) this.applyToInstance(r, st, false);
    }
    this.refreshCollider(refs, false);
  }

  /** Apply a state to one instance without animation. */
  private applyToInstance(r: InstRef, st: ObjectState, _anim: boolean) {
    const { cm, i } = r;
    const restored = st.state === 'damaged' && st.hp >= st.maxHp;
    if (restored) {
      this.showInstance(r);
      return;
    }
    if (st.state === 'damaged') {
      const dmg = Math.max(0, Math.min(1, 1 - st.hp / Math.max(1, st.maxHp)));
      const ic = cm.mesh.instanceColor!;
      ic.setZ(i, dmg);
      ic.needsUpdate = true;
      return;
    }
    cm.mesh.setMatrixAt(i, ZERO);
    cm.mesh.instanceMatrix.needsUpdate = true;
    if (st.state === 'felled' && cm.sp.cls === 'tree' && r.cf.entry.lod <= 1) this.addStump(r);
  }

  private showInstance(r: InstRef) {
    composeInstance(r.cm.data, r.i * SCATTER_STRIDE, tmpM);
    r.cm.mesh.setMatrixAt(r.i, tmpM);
    r.cm.mesh.instanceMatrix.needsUpdate = true;
    const ic = r.cm.mesh.instanceColor!;
    ic.setZ(r.i, 0);
    ic.needsUpdate = true;
  }

  private refreshCollider(refs: InstRef[], present: boolean) {
    for (const r of refs) {
      if (r.cf.entry.lod !== 0 || !r.cm.ids || !r.cm.sp.col) continue;
      const id = r.cm.ids[r.i];
      if (present) {
        this.ctx.colliders.add(this.colliderFor(r.cf, r.cm, r.i, id, r.cf.entry, r.cm.data));
        r.cf.hasColliders = true;
      } else this.ctx.colliders.remove('flora:' + id);
    }
  }

  private visibleRef(refs: InstRef[]): InstRef | null {
    let best: InstRef | null = null;
    for (const r of refs) {
      if (!r.cf.entry.group.visible) continue;
      if (!best || r.cf.entry.lod < best.cf.entry.lod) best = r;
    }
    return best;
  }

  /** World transform of an instance. */
  private worldMatrix(r: InstRef, out: THREE.Matrix4): THREE.Matrix4 {
    composeInstance(r.cm.data, r.i * SCATTER_STRIDE, tmpM2);
    r.cf.entry.group.updateMatrixWorld();
    return out.multiplyMatrices(r.cf.entry.group.matrixWorld, tmpM2);
  }

  private instancePos(r: InstRef): Vec3 {
    const o = r.i * SCATTER_STRIDE, d = r.cm.data, e = r.cf.entry;
    return [e.ox + d[o], e.oy + d[o + 1], e.oz + d[o + 2]];
  }

  private addStump(r: InstRef) {
    if (!this.stumpGeo) {
      this.stumpGeo = new THREE.CylinderGeometry(1, 1.15, 1, 9, 1);
      this.stumpGeo.translate(0, 0.5, 0);
    }
    const sp = r.cm.sp;
    const o = r.i * SCATTER_STRIDE, d = r.cm.data;
    const id = r.cm.ids ? r.cm.ids[r.i] : -1;
    if (r.cf.stumped.has(id)) return;
    r.cf.stumped.add(id);
    const s = d[o + 4];
    const tr = (sp.p.trunkR ?? 0.3) * s;
    if (sp.form === 'giantshroom' || sp.form === 'glasstree' || sp.form === 'bamboo' || sp.form === 'saguaro') return;
    const sky = r.cm.mesh.instanceColor!.getY(r.i);
    const m = new THREE.Mesh(this.stumpGeo, this.lib.plainMaterial(sp.bark, sky));
    m.position.set(d[o], d[o + 1] - 0.15, d[o + 2]);
    m.scale.set(tr, 0.45 + tr * 0.8, tr);
    m.rotation.y = d[o + 3];
    m.castShadow = true;
    m.receiveShadow = true;
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    r.cf.entry.group.add(m);
    r.cf.stumps.push(m);
  }

  // ------------------------------------------------------------------ destruction visuals

  private hitFeedback(refs: InstRef[], st: ObjectState, sp: FloraSpecies) {
    const ref = this.visibleRef(refs);
    if (!ref) return;
    const dir = st.dir ? tmpV.set(st.dir[0], 0, st.dir[2]) : tmpV.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const axis = new THREE.Vector3().crossVectors(UP, dir).normalize();
    this.shakes.push({ refs: refs.filter((r) => r.cf.entry.group.visible), t: 0, dur: 0.5, amp: sp.cls === 'tree' ? 0.035 : 0.06, axis });
    // Chips flying off.
    const p = this.instancePos(ref);
    const o = ref.i * SCATTER_STRIDE;
    const s = ref.cm.data[o + 4];
    const wood = sp.material === 'wood' || sp.material === 'plant';
    const color = wood ? sp.bark : sp.form === 'crystal' || sp.form === 'glasstree' ? sp.leaf : [0.5, 0.48, 0.45];
    const sky = ref.cm.mesh.instanceColor!.getY(ref.i);
    const hy = sp.cls === 'tree' ? 1.1 : (sp.col?.h ?? 0.3) * s + 0.2;
    for (let k = 0; k < 3; k++) {
      const g = new THREE.BoxGeometry(0.07 + Math.random() * 0.06, 0.04 + Math.random() * 0.04, 0.09 + Math.random() * 0.06);
      const mesh = new THREE.Mesh(g, this.lib.plainMaterial(color, sky));
      this.ctx.debris.spawn({
        object: mesh,
        pos: [p[0] - dir.x * 0.3, p[1] + hy, p[2] - dir.z * 0.3],
        vel: [-dir.x * 2 + (Math.random() - 0.5) * 2, 2 + Math.random() * 2, -dir.z * 2 + (Math.random() - 0.5) * 2],
        radius: 0.05,
        life: 2.5 + Math.random(),
      });
    }
    this.ctx.audio.play(sp.material === 'wood' ? 'chop' : sp.material === 'crystal' ? 'crystal_hit' : sp.material === 'stone' ? 'mine' : 'harvest', p, { volume: 0.8 });
  }

  private startFall(r: InstRef, st: ObjectState) {
    const sp = r.cm.sp;
    const fg = this.lib.geometry(sp.idx, r.cm.variant, -1, Math.min(r.cf.entry.lod, 2));
    const sky = r.cm.mesh.instanceColor!.getY(r.i);
    const rnd = r.cm.mesh.instanceColor!.getX(r.i);
    const mat = this.lib.singleMaterial(fg.kind === 'impostor' ? 'foliage' : fg.kind, sky);
    const mesh = new THREE.Mesh(fg.geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.lib.depthMaterials[fg.kind === 'impostor' ? 'foliage' : fg.kind];
    this.worldMatrix(r, tmpM);
    const base = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    tmpM.decompose(base, q, sc);
    mesh.position.copy(base);
    mesh.quaternion.copy(q);
    mesh.scale.copy(sc);
    mesh.userData.rnd = rnd;
    this.ctx.scene.add(mesh);
    const dir = new THREE.Vector3(st.dir?.[0] ?? 1, 0, st.dir?.[2] ?? 0);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const axis = new THREE.Vector3().crossVectors(UP, dir).normalize();
    this.falls.push({ mesh, sp, base, axis, dir, baseQuat: q.clone(), scale: sc.x, angle: 0.06, vel: 0.3, height: fg.height * sc.x, sky });
    this.ctx.audio.play('treefall', [base.x, base.y, base.z], { volume: 1 });
  }

  private updateFalls(dt: number) {
    for (let k = this.falls.length - 1; k >= 0; k--) {
      const f = this.falls[k];
      const g = this.ctx.gen.gravityAt(f.base.x, f.base.y, f.base.z);
      // Rigid rod pivoting at its base: θ'' = 3g/(2L)·sin θ.
      const L = Math.max(2, f.height * 0.6);
      f.vel += ((3 * g) / (2 * L)) * Math.sin(f.angle) * dt;
      f.angle += f.vel * dt;
      // Ground contact: stop when the crown reaches the terrain in the fall direction.
      const reach = Math.min(f.height * 0.75, 10);
      const tipX = f.base.x + f.dir.x * Math.sin(f.angle) * reach, tipZ = f.base.z + f.dir.z * Math.sin(f.angle) * reach;
      const tipY = f.base.y + Math.cos(f.angle) * reach;
      const ground = this.ctx.terrain.density(tipX, tipY - 0.3, tipZ) > 0;
      const done = f.angle > Math.PI * 0.5 + 0.08 || (f.angle > 0.6 && ground);
      tmpQ2.setFromAxisAngle(f.axis, f.angle);
      f.mesh.quaternion.copy(f.baseQuat).premultiply(tmpQ2);
      if (done) {
        this.breakIntoLogs(f);
        this.ctx.scene.remove(f.mesh);
        this.falls.splice(k, 1);
      }
    }
  }

  /** Felled tree hits the ground: logs + leaf clumps via debris. */
  private breakIntoLogs(f: FallAnim) {
    const sp = f.sp;
    const tr = Math.max(0.08, (sp.p.trunkR ?? 0.3) * f.scale);
    const H = f.height;
    const nLogs = Math.max(2, Math.min(5, Math.round(H / 4)));
    const segLen = Math.min(3.2, (H * 0.6) / nLogs);
    const mat = this.lib.plainMaterial(sp.bark, f.sky, sp.form === 'charred' ? 0.3 : 0);
    const dirAxisQ = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(f.dir.x, Math.cos(f.angle) * 0.2, f.dir.z).normalize());
    for (let i = 0; i < nLogs; i++) {
      const along = 0.6 + (i + 0.5) * segLen;
      const r = tr * (1 - (i / nLogs) * 0.5);
      const geo = new THREE.CylinderGeometry(r, r * 1.05, segLen * 0.92, 8, 1);
      const m = new THREE.Mesh(geo, mat);
      m.quaternion.copy(dirAxisQ);
      const p: Vec3 = [f.base.x + f.dir.x * along, f.base.y + r + 0.15 + Math.cos(f.angle) * along, f.base.z + f.dir.z * along];
      this.ctx.debris.spawn({
        object: m,
        pos: p,
        vel: [f.dir.x * 1.5 + (Math.random() - 0.5), 1 + Math.random() * 1.5, f.dir.z * 1.5 + (Math.random() - 0.5)],
        angVel: [(Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5],
        radius: Math.max(r, segLen * 0.3),
        life: 14 + Math.random() * 6,
        bounce: 0.15,
        friction: 0.8,
      });
    }
    // Crown: leafy clumps bursting where it hits.
    const leafy = sp.form !== 'snag' && sp.form !== 'charred';
    if (leafy) {
      const leafMat = this.lib.plainMaterial(sp.form === 'giantshroom' ? sp.leaf : sp.leaf, f.sky, sp.glow * 0.5);
      for (let i = 0; i < 6; i++) {
        const along = H * (0.55 + Math.random() * 0.35);
        const R = Math.max(0.4, H * 0.06) * (0.6 + Math.random() * 0.6);
        const g = new THREE.IcosahedronGeometry(R, 0);
        const m = new THREE.Mesh(g, leafMat);
        this.ctx.debris.spawn({
          object: m,
          pos: [f.base.x + f.dir.x * along + (Math.random() - 0.5) * 2, f.base.y + 1 + Math.random(), f.base.z + f.dir.z * along + (Math.random() - 0.5) * 2],
          vel: [(Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3],
          radius: R * 0.8,
          life: 3 + Math.random() * 2,
        });
      }
    }
    this.ctx.audio.play('treeland', [f.base.x + f.dir.x * H * 0.5, f.base.y, f.base.z + f.dir.z * H * 0.5], { volume: 1 });
  }

  private shatter(r: InstRef, st: ObjectState) {
    const sp = r.cm.sp;
    const fg = this.lib.geometry(sp.idx, r.cm.variant, r.cm.mat, 0);
    const sky = r.cm.mesh.instanceColor!.getY(r.i);
    const mesh = new THREE.Mesh(fg.geo, this.lib.singleMaterial(fg.kind === 'impostor' ? 'foliage' : fg.kind, sky));
    this.worldMatrix(r, mesh.matrix);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorld.copy(mesh.matrix);
    const p = this.instancePos(r);
    const origin: Vec3 = [p[0] - (st.dir?.[0] ?? 0), p[1] + 0.3, p[2] - (st.dir?.[2] ?? 0)];
    const pieces = sp.cls === 'tree' ? 10 : Math.max(4, Math.min(12, Math.round(fg.radius * r.cm.data[r.i * SCATTER_STRIDE + 4] * 6)));
    this.ctx.debris.shatter(mesh, origin, 3.5, pieces, 8);
    this.ctx.audio.play(sp.material === 'crystal' ? 'crystal_break' : 'rockbreak', p, { volume: 1 });
  }

  private startShrink(refs: InstRef[], id: number) {
    const vis = refs.filter((r) => r.cf.entry.group.visible);
    this.shrinks.push({ refs: vis, t: 0, dur: 0.35 });
    const ref = vis[0];
    if (ref) this.ctx.audio.play('pick', this.instancePos(ref), { volume: 0.7 });
    void id;
  }

  private updateAnims(dt: number) {
    for (let k = this.shakes.length - 1; k >= 0; k--) {
      const s = this.shakes[k];
      s.t += dt;
      const t = Math.min(1, s.t / s.dur);
      const a = Math.sin(s.t * 38) * s.amp * (1 - t);
      tmpQ2.setFromAxisAngle(s.axis, a);
      for (const r of s.refs) {
        const st = r.cm.ids ? this.states.get(r.cm.ids[r.i]) : undefined;
        if (st && st.state !== 'damaged') continue;
        composeInstance(r.cm.data, r.i * SCATTER_STRIDE, tmpM, t < 1 ? tmpQ2 : undefined);
        r.cm.mesh.setMatrixAt(r.i, tmpM);
        r.cm.mesh.instanceMatrix.needsUpdate = true;
      }
      if (t >= 1) this.shakes.splice(k, 1);
    }
    for (let k = this.shrinks.length - 1; k >= 0; k--) {
      const s = this.shrinks[k];
      s.t += dt;
      const t = Math.min(1, s.t / s.dur);
      for (const r of s.refs) {
        if (t >= 1) r.cm.mesh.setMatrixAt(r.i, ZERO);
        else {
          composeInstance(r.cm.data, r.i * SCATTER_STRIDE, tmpM, undefined, 1 - t * t);
          r.cm.mesh.setMatrixAt(r.i, tmpM);
        }
        r.cm.mesh.instanceMatrix.needsUpdate = true;
      }
      if (t >= 1) this.shrinks.splice(k, 1);
    }
    this.updateFalls(dt);
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number, _time: number) {
    const ctx = this.ctx;
    const sh = this.lib.shared;
    const w = ctx.env.wind;
    sh.uTime.value = w.time;
    sh.uWind.value.set(w.dir.x, w.dir.y, w.strength);
    const pp = ctx.playerPos();
    sh.uPlayer.value.set(pp[0], pp[1], pp[2], 1.1);
    // Light direction (sun or moon) in view space for leaf translucency.
    const sun = ctx.env.sun;
    tmpV.copy(sun.position).normalize().transformDirection(ctx.camera.matrixWorldInverse);
    sh.uSunView.value.copy(tmpV);
    sh.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity / 3.2);
    // Grass fades out just before the LOD-0 ring ends.
    const lod0 = 32 * ctx.streamer.opts.splitFactor;
    sh.uFade.value.set(lod0 * 0.62, lod0 * 0.95);
    this.updateAnims(dt);
    // Ground cover beyond its fade distance costs draw calls for nothing: hide whole meshes.
    if (++this.frameNo % 4 === 0) this.cullGroundCover(sh.uFade.value.y + 4);
  }

  private frameNo = 0;

  private cullGroundCover(maxDist: number) {
    const cam = this.ctx.camera.position;
    const camUnder = cam.y < this.ctx.gen.heightAt(cam.x, cam.z) - 6;
    for (const cf of this.chunks.values()) {
      const e = cf.entry;
      if (!e.group.visible) continue;
      const dx = Math.max(e.ox - cam.x, 0, cam.x - (e.ox + e.size));
      const dy = Math.max(e.oy - cam.y, 0, cam.y - (e.oy + e.size));
      const dz = Math.max(e.oz - cam.z, 0, cam.z - (e.oz + e.size));
      const d2 = dx * dx + dy * dy + dz * dz;
      // Cave flora is invisible from the surface (terrain occludes it) — save its draw calls.
      const showDeep = !cf.deep || camUnder || d2 < 30 * 30;
      const near = showDeep && d2 < maxDist * maxDist;
      if (showDeep !== cf.deepShown || e.lod === 0) {
        cf.deepShown = showDeep;
        for (const cm of cf.meshes) {
          const v = cm.fades ? near : showDeep;
          if (cm.mesh.visible !== v) cm.mesh.visible = v;
        }
      }
    }
  }

  dispose() {
    for (const off of this.offs) off();
    for (const cf of [...this.chunks.values()]) this.onDisposed(cf.entry);
    for (const f of this.falls) this.ctx.scene.remove(f.mesh);
    this.falls = [];
    this.stumpGeo?.dispose();
    this.lib?.dispose();
  }
}

