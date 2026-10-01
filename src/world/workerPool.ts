/** Priority job pool over chunk workers. */
import type { ChunkJob, ChunkJobResult } from './chunkJob';

interface Pending {
  job: ChunkJob;
  priority: number;
  resolve: (r: ChunkJobResult) => void;
  cancelled: boolean;
}

export class ChunkWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Pending[] = [];
  private inflight = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void>;
  readonly size: number;
  /** Rolling average of job time (ms) for diagnostics. */
  avgMs = 0;

  constructor(seed: number, count = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2))) {
    this.size = count;
    const readies: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      readies.push(
        new Promise((res) => {
          const onReady = (ev: MessageEvent) => {
            if (ev.data?.type === 'ready') {
              w.removeEventListener('message', onReady);
              res();
            }
          };
          w.addEventListener('message', onReady);
        }),
      );
      w.addEventListener('message', (ev) => this.onResult(w, ev.data));
      w.addEventListener('error', (e) => console.error('chunk worker error', e));
      w.postMessage({ type: 'init', seed });
      this.workers.push(w);
      this.idle.push(w);
    }
    this.ready = Promise.all(readies).then(() => undefined);
  }

  whenReady() {
    return this.ready;
  }

  get queued() {
    return this.queue.length;
  }

  get busy() {
    return this.inflight.size;
  }

  /** Submit a job; lower priority value = sooner. Returns a handle for cancellation/reprioritization. */
  submit(job: Omit<ChunkJob, 'id' | 'type'>, priority: number): { promise: Promise<ChunkJobResult>; handle: Pending } {
    const full: ChunkJob = { ...job, type: 'chunk', id: this.nextId++ };
    let resolve!: (r: ChunkJobResult) => void;
    const promise = new Promise<ChunkJobResult>((r) => (resolve = r));
    const p: Pending = { job: full, priority, resolve, cancelled: false };
    this.queue.push(p);
    this.pump();
    return { promise, handle: p };
  }

  cancel(h: Pending) {
    h.cancelled = true;
  }

  setPriority(h: Pending, priority: number) {
    h.priority = priority;
  }

  private sortPending = false;
  /** Call once per frame after priorities were updated. */
  resort() {
    this.sortPending = true;
    this.pump();
  }

  private pump() {
    if (!this.idle.length || !this.queue.length) return;
    if (this.sortPending) {
      this.queue = this.queue.filter((p) => !p.cancelled);
      this.queue.sort((a, b) => a.priority - b.priority);
      this.sortPending = false;
    }
    while (this.idle.length && this.queue.length) {
      // Pick best priority (queue mostly sorted; do a linear scan of the head for safety).
      let bi = -1, bp = Infinity;
      const scan = Math.min(this.queue.length, 64);
      for (let i = 0; i < scan; i++) {
        const q = this.queue[i];
        if (q.cancelled) continue;
        if (q.priority < bp) {
          bp = q.priority;
          bi = i;
        }
      }
      if (bi < 0) {
        this.queue.splice(0, scan);
        continue;
      }
      const p = this.queue.splice(bi, 1)[0];
      const w = this.idle.pop()!;
      this.inflight.set(p.job.id, p);
      w.postMessage(p.job);
    }
  }

  private onResult(w: Worker, data: ChunkJobResult | { type: string }) {
    if (data.type !== 'chunk') return;
    const r = data as ChunkJobResult;
    const p = this.inflight.get(r.id);
    this.inflight.delete(r.id);
    this.idle.push(w);
    this.avgMs = this.avgMs * 0.95 + r.ms * 0.05;
    if (p && !p.cancelled) p.resolve(r);
    this.pump();
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
  }
}
