/**
 * Client side of the map worker pool: a prioritized, de-duplicated tile queue
 * plus an LRU ImageBitmap cache. Tiles are 128 px at power-of-two meters/pixel
 * levels; consumers call `want()` while drawing and get notified via `onTile`
 * listeners as tiles arrive, so maps fill in progressively (coarse first).
 */
import type { MapJob } from './mapWorker';

export type MapLayer = 'surface' | 'under';

export const TILE = 128;
export const MIN_LEVEL = 0; // 1 m/px
export const MAX_LEVEL = 8; // 256 m/px

interface Want {
  key: string;
  job: Omit<MapJob, 'id' | 'type'>;
  priority: number;
  stamp: number;
  resolve?: (b: ImageBitmap) => void;
}

interface WorkerSlot {
  w: Worker;
  busy: Want | null;
  jobId: number;
}

export class MapRenderer {
  private workers: WorkerSlot[] = [];
  private queue = new Map<string, Want>();
  private cache = new Map<string, ImageBitmap>();
  private nextId = 1;
  private gen = 0;
  private listeners = new Set<(key: string) => void>();
  private disposed = false;
  seed: number;
  maxTiles: number;

  constructor(seed: number, workerCount = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 3))), maxTiles = 420) {
    this.seed = seed;
    this.maxTiles = maxTiles;
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./mapWorker.ts', import.meta.url), { type: 'module' });
      const slot: WorkerSlot = { w, busy: null, jobId: 0 };
      w.onmessage = (ev) => this.onMessage(slot, ev.data);
      w.onerror = (e) => {
        console.error('map worker error', e);
        slot.busy = null;
      };
      w.postMessage({ type: 'init', seed });
      this.workers.push(slot);
    }
  }

  /** Switch world (menu preview while typing a seed). Clears cache and queue. */
  setSeed(seed: number): void {
    if (seed === this.seed) return;
    this.seed = seed;
    this.gen++;
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    this.queue.clear();
    for (const s of this.workers) {
      s.w.postMessage({ type: 'init', seed });
      // In-flight results from the old seed are discarded via the job id check.
      s.busy = null;
      s.jobId = -1;
    }
  }

  onTile(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  static key(layer: MapLayer, level: number, tx: number, tz: number): string {
    return `${layer}:${level}:${tx}:${tz}`;
  }

  get(key: string): ImageBitmap | undefined {
    const b = this.cache.get(key);
    if (b) {
      // LRU touch.
      this.cache.delete(key);
      this.cache.set(key, b);
    }
    return b;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Request a tile (no-op if cached). Lower priority = sooner. */
  want(layer: MapLayer, level: number, tx: number, tz: number, priority: number): void {
    const key = MapRenderer.key(layer, level, tx, tz);
    if (this.cache.has(key)) return;
    const now = performance.now();
    const q = this.queue.get(key);
    if (q) {
      q.priority = Math.min(priority, q.priority + 0.001 * (now - q.stamp));
      q.stamp = now;
      return;
    }
    const mpp = Math.pow(2, level);
    this.queue.set(key, { key, priority, stamp: now, job: { layer, x0: tx * TILE * mpp, z0: tz * TILE * mpp, mpp, w: TILE, h: TILE } });
    this.pump();
  }

  /** One-off region render (menu preview). Not cached by tile key. */
  region(job: Omit<MapJob, 'id' | 'type'>, priority = 0): Promise<ImageBitmap> {
    return new Promise((resolve) => {
      const key = `region:${this.nextId++}`;
      this.queue.set(key, { key, job, priority, stamp: Infinity, resolve });
      this.pump();
    });
  }

  /** Drop queued work not re-requested recently (view moved away). */
  private prune(now: number) {
    for (const [k, q] of this.queue) if (now - q.stamp > 1500) this.queue.delete(k);
  }

  private pump() {
    if (this.disposed) return;
    const now = performance.now();
    this.prune(now);
    for (const slot of this.workers) {
      if (slot.busy) continue;
      let best: Want | null = null;
      for (const q of this.queue.values()) if (!best || q.priority < best.priority) best = q;
      if (!best) return;
      this.queue.delete(best.key);
      slot.busy = best;
      slot.jobId = this.nextId++;
      slot.w.postMessage({ type: 'job', id: slot.jobId, ...best.job });
    }
  }

  private onMessage(slot: WorkerSlot, msg: { type: string; id?: number; bitmap?: ImageBitmap }) {
    if (msg.type !== 'done' || !msg.bitmap) return;
    const want = slot.busy;
    if (!want || msg.id !== slot.jobId) {
      // Result from a previous seed: drop it, but the worker is free again.
      msg.bitmap.close();
      if (slot.jobId === -1) slot.busy = null;
      this.pump();
      return;
    }
    slot.busy = null;
    if (want.resolve) want.resolve(msg.bitmap);
    else {
      this.cache.set(want.key, msg.bitmap);
      while (this.cache.size > this.maxTiles) {
        const oldest = this.cache.keys().next().value as string;
        this.cache.get(oldest)?.close();
        this.cache.delete(oldest);
      }
      for (const l of [...this.listeners]) l(want.key);
    }
    this.pump();
  }

  get pending(): number {
    return this.queue.size + this.workers.filter((w) => w.busy).length;
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.workers) s.w.terminate();
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    this.queue.clear();
    this.listeners.clear();
  }
}

/**
 * Draw the map around (cx, cz) into a 2D context whose transform already has the
 * view centre at the origin (callers may rotate). `halfW/halfH` = visible half
 * extents in screen pixels. Missing tiles fall back to cached coarser levels.
 */
export function drawMapTiles(
  ctx: CanvasRenderingContext2D, r: MapRenderer, layer: MapLayer, cx: number, cz: number, mpp: number, halfW: number, halfH: number, priorityBias = 0,
): number {
  const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.floor(Math.log2(mpp) + 0.7)));
  const tmpp = Math.pow(2, level);
  const S = TILE * tmpp; // tile world size
  const x0 = cx - halfW * mpp, x1 = cx + halfW * mpp;
  const z0 = cz - halfH * mpp, z1 = cz + halfH * mpp;
  const tx0 = Math.floor(x0 / S), tx1 = Math.floor(x1 / S);
  const tz0 = Math.floor(z0 / S), tz1 = Math.floor(z1 / S);
  const px = S / mpp;
  let missing = 0;
  for (let tz = tz0; tz <= tz1; tz++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const dx = (tx * S - cx) / mpp, dy = (tz * S - cz) / mpp;
      const key = MapRenderer.key(layer, level, tx, tz);
      const bmp = r.get(key);
      if (bmp) {
        ctx.drawImage(bmp, dx, dy, px + 0.6, px + 0.6);
        continue;
      }
      missing++;
      const dc = Math.hypot(tx * S + S / 2 - cx, tz * S + S / 2 - cz) / S;
      r.want(layer, level, tx, tz, priorityBias + level * 0.01 + dc);
      // Fallback: nearest cached ancestor, cropped to this tile.
      for (let up = 1; up <= 4 && level + up <= MAX_LEVEL; up++) {
        const L = level + up, f = 1 << up;
        const ax = Math.floor(tx / f), az = Math.floor(tz / f);
        const anc = r.get(MapRenderer.key(layer, L, ax, az));
        if (!anc) continue;
        const sub = TILE / f;
        ctx.drawImage(anc, (tx - ax * f) * sub, (tz - az * f) * sub, sub, sub, dx, dy, px + 0.6, px + 0.6);
        break;
      }
    }
  }
  // Always keep a coarse overview warm so fallbacks exist while panning/zooming.
  if (missing && level + 2 <= MAX_LEVEL) {
    const L = level + 2, S2 = TILE * Math.pow(2, L);
    for (let tz = Math.floor(z0 / S2); tz <= Math.floor(z1 / S2); tz++)
      for (let tx = Math.floor(x0 / S2); tx <= Math.floor(x1 / S2); tx++) r.want(layer, L, tx, tz, priorityBias - 1);
  }
  return missing;
}

const shared = new Map<number, { r: MapRenderer; refs: number }>();

/** Shared renderer per seed (minimap + world map reuse tiles). Release with `releaseMapRenderer`. */
export function acquireMapRenderer(seed: number): MapRenderer {
  let e = shared.get(seed);
  if (!e) shared.set(seed, (e = { r: new MapRenderer(seed), refs: 0 }));
  e.refs++;
  return e.r;
}

export function releaseMapRenderer(r: MapRenderer): void {
  const e = shared.get(r.seed);
  if (!e || e.r !== r) return;
  if (--e.refs <= 0) {
    r.dispose();
    shared.delete(r.seed);
  }
}
