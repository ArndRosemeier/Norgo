/**
 * Octree LOD terrain streaming.
 *
 * The world is covered by root nodes of MAX_LOD size; nodes split while the
 * camera is closer than `splitFactor * size`. Every leaf is a 32³ chunk at its
 * LOD, generated & meshed in workers. Transitions never show holes: if a leaf
 * is not ready yet, the nearest ready ancestor (or previously drawn
 * descendants) is shown instead.
 *
 * Other systems (flora, rocks) attach objects to `ChunkEntry.group`, so they
 * appear and disappear together with the terrain they belong to.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, MAX_LOD, WORLD_MIN_Y, WORLD_MAX_Y, CAVE_LOD_LIMIT } from './constants';
import { Column, type WorldGenerator } from './generator';
import type { ChunkJobResult } from './chunkJob';
import { ChunkWorkerPool } from './workerPool';
import { buildTerrainGeometry, TerrainMaterialHandle } from './terrainMaterial';
import { EditStore, TerrainEdit } from './edits';
import { TerrainCollider } from './collider';
import type { ScatterBatch } from './scatterTypes';
import { Emitter } from '../core/events';
import { budgets } from '../core/budgets';

export interface ChunkEntry {
  key: string;
  lod: number;
  cx: number;
  cy: number;
  cz: number;
  ox: number;
  oy: number;
  oz: number;
  size: number;
  state: 'idle' | 'pending' | 'ready';
  empty: boolean;
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  lastWanted: number;
  handle: ReturnType<ChunkWorkerPool['submit']>['handle'] | null;
  /** Edit version this entry was generated with. */
  version: number;
  dirty: boolean;
  scattered: boolean;
  drawn: boolean;
}

export interface StreamerEvents extends Record<string, unknown> {
  /** First generation of a chunk finished, with deterministic scatter data. */
  chunkScatter: { entry: ChunkEntry; batches: ScatterBatch[] };
  /** Chunk evicted: owners must dispose objects they attached to entry.group. */
  chunkDisposed: { entry: ChunkEntry };
  chunkMeshed: { entry: ChunkEntry };
}

export interface StreamerOptions {
  splitFactor: number;
  /** Root grid radius in root nodes. */
  rootRadius: number;
  maxEntries: number;
  shadowLod: number;
}

const tmpBox = new THREE.Box3();
const tmpSphere = new THREE.Sphere();

/** Chunks disposed per frame at most when trimming the cache (see evict). */
const EVICT_PER_FRAME = 24;

export class TerrainStreamer {
  readonly root = new THREE.Group();
  readonly events = new Emitter<StreamerEvents>();
  readonly entries = new Map<string, ChunkEntry>();
  readonly edits: EditStore;
  readonly collider: TerrainCollider;
  readonly pool: ChunkWorkerPool;
  opts: StreamerOptions;
  private frame = 0;
  private editVersion = 0;
  private camPos = new THREE.Vector3();
  private lastUpdatePos = new THREE.Vector3(1e9, 0, 0);
  private camUnderground = false;
  /** Meters of rock between camera and the 2D surface. */
  private camDepth = 0;
  /** Leaves wanted this update. */
  private wanted: ChunkEntry[] = [];
  stats = { entries: 0, drawn: 0, pending: 0, triangles: 0, leaves: 0 };
  /** Optional timing sink for main-thread work done when chunk results arrive (profiling). */
  timing: ((label: string, ms: number) => void) | null = null;

  constructor(readonly gen: WorldGenerator, readonly mat: TerrainMaterialHandle, opts: Partial<StreamerOptions> = {}, edits?: EditStore) {
    this.opts = { splitFactor: 1.6, rootRadius: 3, maxEntries: budgets.chunkCache, shadowLod: 3, ...opts };
    this.edits = edits ?? new EditStore();
    this.collider = new TerrainCollider(gen, this.edits);
    this.collider.maxGrids = budgets.colliderGrids;
    this.pool = new ChunkWorkerPool(gen.seed);
    this.root.name = 'terrain';
  }

  whenReady() {
    return this.pool.whenReady();
  }

  private keyOf(lod: number, cx: number, cy: number, cz: number) {
    return lod + ':' + cx + ':' + cy + ':' + cz;
  }

  private getEntry(lod: number, cx: number, cy: number, cz: number, create: boolean): ChunkEntry | undefined {
    const key = this.keyOf(lod, cx, cy, cz);
    let e = this.entries.get(key);
    if (!e && create) {
      const size = CHUNK_SIZE << lod;
      const group = new THREE.Group();
      group.position.set(cx * size, cy * size, cz * size);
      group.visible = false;
      group.matrixAutoUpdate = false;
      group.updateMatrix();
      e = {
        key, lod, cx, cy, cz, ox: cx * size, oy: cy * size, oz: cz * size, size, state: 'idle', empty: false, group, mesh: null,
        lastWanted: 0, handle: null, version: -1, dirty: false, scattered: false, drawn: false,
      };
      this.entries.set(key, e);
      this.root.add(group);
    }
    return e;
  }

  /** Apply a replicated terrain edit. */
  applyEdit(edit: TerrainEdit) {
    this.edits.add(edit);
    this.editVersion++;
    const r = edit.radius + 2;
    this.collider.invalidate(edit.x - r, edit.y - r, edit.z - r, edit.x + r, edit.y + r, edit.z + r);
    for (const e of this.entries.values()) {
      if (e.lod > 2) continue;
      if (edit.x + r < e.ox - 2 * (1 << e.lod) || edit.x - r > e.ox + e.size + 2 * (1 << e.lod)) continue;
      if (edit.y + r < e.oy - 2 * (1 << e.lod) || edit.y - r > e.oy + e.size + 2 * (1 << e.lod)) continue;
      if (edit.z + r < e.oz - 2 * (1 << e.lod) || edit.z - r > e.oz + e.size + 2 * (1 << e.lod)) continue;
      e.dirty = true;
    }
  }

  /**
   * Cheap column for LOD relevance: terrain + 3D features but no settlement/road shaping
   * (computing sites lazily on the main thread caused frame hitches). Cached per sample point;
   * node corners are grid-aligned so hits are frequent.
   */
  private lodCols = new Map<number, { height: number; islands: number; pTop: number }>();
  private lodColumn(x: number, z: number) {
    const key = Math.round(x) * 7919 + Math.round(z) * 104729;
    let c = this.lodCols.get(key);
    if (!c) {
      const col = this.gen.column(x, z, this.lodTmp, false, true);
      c = { height: col.height, islands: col.islands, pTop: col.pTop };
      if (this.lodCols.size > 60000) this.lodCols.clear();
      this.lodCols.set(key, c);
    }
    return c;
  }
  private lodTmp = new Column();

  /** Squared distance from camera to node AABB. */
  private distTo(ox: number, oy: number, oz: number, size: number): number {
    const p = this.camPos;
    const dx = Math.max(ox - p.x, 0, p.x - (ox + size));
    const dy = Math.max(oy - p.y, 0, p.y - (oy + size));
    const dz = Math.max(oz - p.z, 0, p.z - (oz + size));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Can this node contain visible terrain? Conservative estimate from 2D surface data. */
  private relevant(lod: number, ox: number, oy: number, oz: number, size: number): boolean {
    if (oy > WORLD_MAX_Y || oy + size < WORLD_MIN_Y) return false;
    let minH = Infinity, maxH = -Infinity, extra = 110;
    const pts = lod >= 4 ? 3 : 2;
    for (let j = 0; j <= pts; j++)
      for (let i = 0; i <= pts; i++) {
        const c = this.lodColumn(ox + (size * i) / pts, oz + (size * j) / pts);
        minH = Math.min(minH, c.height);
        maxH = Math.max(maxH, c.height);
        if (c.islands > 0.05) extra = Math.max(extra, 420);
        if (c.pTop > -1e8) extra = Math.max(extra, c.pTop - c.height + 20);
      }
    // The cheap columns skip settlement shaping, but a city levels ground up to 1.9 × its
    // radius to its plateau — cut into a hillside, that is 100 m+ below the natural surface,
    // and the town's chunks were culled as "underground" (a hole in the ground). Sites are
    // cached per 720 m cell, so one lookup per node is cheap.
    for (const s of this.gen.sites.sitesNear(ox + size / 2, oz + size / 2, size / 2)) {
      const reach = s.radius * 1.9;
      const dx = Math.max(ox - s.x, 0, s.x - (ox + size)), dz = Math.max(oz - s.z, 0, s.z - (oz + size));
      if (dx * dx + dz * dz > reach * reach) continue;
      minH = Math.min(minH, s.plateau - 3);
      maxH = Math.max(maxH, s.plateau + 3);
    }
    if (oy > maxH + extra) return false;
    // Deep underground the surface world is invisible (except through shafts nearby).
    if (this.camDepth > 50 && lod >= 2 && oy > this.camPos.y + 140) return false;
    // Fully underground nodes are invisible from the surface (cave mouths lie in nodes that
    // touch the surface anyway). Underground cameras get fine LODs all around them.
    const depthCut = minH - (this.camUnderground ? 60 : 14) - (lod >= 3 ? size * 0.25 : 0);
    if (oy + size < depthCut) {
      if (!this.camUnderground) return false;
      if (lod > CAVE_LOD_LIMIT + 1) return false;
      // Underground: only within a sphere around the camera.
      if (this.distTo(ox, oy, oz, size) > 260) return false;
    }
    return true;
  }

  update(camera: THREE.Camera, force = false) {
    this.frame++;
    this.collider.frame();
    camera.getWorldPosition(this.camPos);
    const moved = this.camPos.distanceTo(this.lastUpdatePos);
    if (force || moved > 1.5 || this.frame % 20 === 0) {
      this.lastUpdatePos.copy(this.camPos);
      const surf = this.gen.heightAt(this.camPos.x, this.camPos.z);
      this.camUnderground = this.camPos.y < surf - 6;
      this.camDepth = surf - this.camPos.y;
      let t = performance.now();
      const lap = (label: string) => {
        const n = performance.now();
        this.timing?.('stream.' + label, n - t);
        t = n;
      };
      this.selectLeaves();
      lap('select');
      this.request();
      lap('request');
      this.resolveDrawn();
      lap('resolve');
      this.evict();
      lap('evict');
    } else {
      // Still pick up freshly arrived chunks.
      this.resolveDrawn();
    }
  }

  private selectLeaves() {
    const rootSize = CHUNK_SIZE << MAX_LOD;
    const rcx = Math.floor(this.camPos.x / rootSize), rcz = Math.floor(this.camPos.z / rootSize);
    const rr = this.opts.rootRadius;
    const y0 = Math.floor(WORLD_MIN_Y / rootSize), y1 = Math.floor(WORLD_MAX_Y / rootSize);
    this.wanted = [];
    for (let rz = rcz - rr; rz <= rcz + rr; rz++)
      for (let rx = rcx - rr; rx <= rcx + rr; rx++) {
        if (Math.hypot(rx - rcx, rz - rcz) > rr + 0.75) continue;
        for (let ry = y0; ry <= y1; ry++) this.visit(MAX_LOD, rx, ry, rz);
      }
    this.stats.leaves = this.wanted.length;
  }

  private visit(lod: number, cx: number, cy: number, cz: number) {
    const size = CHUNK_SIZE << lod;
    const ox = cx * size, oy = cy * size, oz = cz * size;
    if (!this.relevant(lod, ox, oy, oz, size)) return;
    const d = this.distTo(ox, oy, oz, size);
    if (lod > 0 && d < size * this.opts.splitFactor) {
      for (let k = 0; k < 8; k++) this.visit(lod - 1, cx * 2 + (k & 1), cy * 2 + ((k >> 1) & 1), cz * 2 + ((k >> 2) & 1));
      return;
    }
    const e = this.getEntry(lod, cx, cy, cz, true)!;
    e.lastWanted = this.frame;
    this.wanted.push(e);
  }

  private request() {
    for (const e of this.wanted) {
      const d = this.distTo(e.ox, e.oy, e.oz, e.size);
      const prio = d / e.size - e.lod * 0.25 + (e.state === 'ready' ? 2 : 0);
      if (e.state === 'pending' && e.handle) {
        this.pool.setPriority(e.handle, prio);
        continue;
      }
      if (e.state === 'idle' || (e.state === 'ready' && (e.dirty || e.version < 0))) {
        this.submit(e, prio);
      }
    }
    // Cancel queued jobs nobody wants anymore.
    for (const e of this.entries.values()) {
      if (e.state === 'pending' && e.lastWanted !== this.frame && e.handle && !e.drawn) {
        this.pool.cancel(e.handle);
        e.handle = null;
        e.state = e.mesh || e.empty ? 'ready' : 'idle';
      }
    }
    this.pool.resort();
  }

  private submit(e: ChunkEntry, prio: number) {
    const pad = 3 * (1 << e.lod);
    // Edits are a few meters wide: invisible beyond LOD 2 (and a spatial query over a
    // 2 km node would touch hundreds of thousands of cells).
    const edits = e.lod <= 2 ? this.edits.query(e.ox - pad, e.oy - pad, e.oz - pad, e.ox + e.size + pad, e.oy + e.size + pad, e.oz + e.size + pad) : [];
    const wasReady = e.state === 'ready';
    const version = this.editVersion;
    e.dirty = false;
    const { promise, handle } = this.pool.submit(
      { key: e.key, ox: e.ox, oy: e.oy, oz: e.oz, lod: e.lod, edits, wantGrid: e.lod === 0, wantScatter: !e.scattered && e.lod <= 3 },
      prio,
    );
    e.handle = handle;
    if (!wasReady) e.state = 'pending';
    promise.then((r) => this.onResult(e, r, version));
  }

  private onResult(e: ChunkEntry, r: ChunkJobResult, version: number) {
    const t0 = performance.now();
    try {
      this.applyResult(e, r, version);
    } finally {
      this.timing?.('chunk', performance.now() - t0);
    }
  }

  private applyResult(e: ChunkEntry, r: ChunkJobResult, version: number) {
    e.handle = null;
    if (!this.entries.has(e.key)) return; // evicted meanwhile
    e.version = version;
    e.state = 'ready';
    if (e.mesh) {
      e.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh = null;
    }
    e.empty = !r.mesh;
    if (r.mesh) {
      const geo = buildTerrainGeometry(r.mesh.positions, r.mesh.normals, r.mesh.mats);
      tmpBox.min.set(...r.mesh.min);
      tmpBox.max.set(...r.mesh.max);
      geo.boundingBox = tmpBox.clone();
      geo.boundingSphere = tmpBox.getBoundingSphere(tmpSphere).clone();
      const mesh = new THREE.Mesh(geo, this.mat.material);
      mesh.customDepthMaterial = this.mat.depthMaterial;
      mesh.receiveShadow = true;
      mesh.castShadow = e.lod <= this.opts.shadowLod;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'terrain:' + e.key;
      mesh.userData.chunk = e;
      e.group.add(mesh);
      e.mesh = mesh;
      this.stats.triangles += r.mesh.vertexCount / 3;
    }
    if (r.density && r.mats) this.collider.setGrid(e.ox, e.oy, e.oz, r.density, r.mats);
    if (r.scatter && !e.scattered) {
      e.scattered = true;
      const ts = performance.now();
      this.events.emit('chunkScatter', { entry: e, batches: r.scatter });
      this.timing?.('scatter', performance.now() - ts);
    }
    if (e.dirty) this.submit(e, 0);
    this.events.emit('chunkMeshed', { entry: e });
  }

  private resolveDrawn() {
    const draw = new Set<ChunkEntry>();
    const fallbacks = new Set<ChunkEntry>();
    for (const e of this.wanted) {
      if (e.state === 'ready') continue;
      // Find ready ancestor.
      let found: ChunkEntry | null = null;
      for (let l = e.lod + 1, cx = e.cx, cy = e.cy, cz = e.cz; l <= MAX_LOD; l++) {
        cx = Math.floor(cx / 2); cy = Math.floor(cy / 2); cz = Math.floor(cz / 2);
        const a = this.getEntry(l, cx, cy, cz, false);
        if (a && a.state === 'ready') {
          found = a;
          break;
        }
      }
      if (found) fallbacks.add(found);
      else this.collectReadyDescendants(e, draw);
    }
    for (const e of this.wanted) {
      if (e.state !== 'ready') continue;
      if (this.underFallback(e, fallbacks)) continue;
      draw.add(e);
    }
    for (const f of fallbacks) draw.add(f);
    let drawn = 0;
    for (const e of this.entries.values()) {
      const vis = draw.has(e);
      e.drawn = vis;
      if (e.group.visible !== vis) e.group.visible = vis;
      if (vis && e.mesh) drawn++;
    }
    this.stats.drawn = drawn;
    this.stats.entries = this.entries.size;
    this.stats.pending = this.pool.queued + this.pool.busy;
  }

  private underFallback(e: ChunkEntry, fallbacks: Set<ChunkEntry>): boolean {
    if (!fallbacks.size) return false;
    for (let l = e.lod + 1, cx = e.cx, cy = e.cy, cz = e.cz; l <= MAX_LOD; l++) {
      cx = Math.floor(cx / 2); cy = Math.floor(cy / 2); cz = Math.floor(cz / 2);
      const a = this.entries.get(this.keyOf(l, cx, cy, cz));
      if (a && fallbacks.has(a)) return true;
    }
    return false;
  }

  private collectReadyDescendants(e: ChunkEntry, out: Set<ChunkEntry>) {
    if (e.lod === 0) return;
    for (let k = 0; k < 8; k++) {
      const c = this.getEntry(e.lod - 1, e.cx * 2 + (k & 1), e.cy * 2 + ((k >> 1) & 1), e.cz * 2 + ((k >> 2) & 1), false);
      if (!c) continue;
      if (c.state === 'ready') out.add(c);
      else this.collectReadyDescendants(c, out);
    }
  }

  /**
   * Trim the chunk cache gradually: start a little below the limit and dispose at most
   * EVICT_PER_FRAME of the least recently wanted chunks per frame. (Dropping 15 % of the
   * cache at once disposed hundreds of meshes and their scatter in one 40 ms frame.)
   */
  private evict() {
    const max = this.opts.maxEntries;
    if (this.entries.size <= max * 0.9) return;
    const cands = [...this.entries.values()].filter((e) => !e.drawn && e.lastWanted !== this.frame && e.state !== 'pending');
    if (!cands.length) return;
    cands.sort((a, b) => a.lastWanted - b.lastWanted);
    const toRemove = Math.min(EVICT_PER_FRAME, this.entries.size - Math.floor(max * 0.85), cands.length);
    for (let i = 0; i < toRemove; i++) this.dispose(cands[i]);
  }

  private dispose(e: ChunkEntry) {
    this.events.emit('chunkDisposed', { entry: e });
    if (e.mesh) {
      e.mesh.geometry.dispose();
      this.stats.triangles -= (e.mesh.geometry.getAttribute('position').count || 0) / 3;
    }
    this.root.remove(e.group);
    this.entries.delete(e.key);
  }

  /** Is the terrain around a point loaded at full detail (for spawning / physics readiness)? */
  isDetailedAt(x: number, y: number, z: number): boolean {
    if (this.collider.hasGrid(x, y, z)) return true;
    const e = this.entries.get(this.keyOf(0, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
    return !!e && e.state === 'ready';
  }

  dispose_all() {
    for (const e of [...this.entries.values()]) this.dispose(e);
    this.pool.dispose();
  }
}
