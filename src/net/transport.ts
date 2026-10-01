/**
 * Client ↔ server transports. The game only talks to `Transport`; today the
 * server runs locally in a worker, later a WebSocketTransport can connect to a
 * real multiplayer server without touching game code.
 */
import type { ClientMessage, ServerMessage } from '../shared/protocol';

export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: ServerMessage) => void): void;
  close(): void;
  /** Simulated or measured round trip (ms). */
  readonly latency: number;
}

/** Local server in a Web Worker (single player). Optional artificial latency for testing netcode. */
export class WorkerTransport implements Transport {
  private worker: Worker;
  private cbs: ((msg: ServerMessage) => void)[] = [];
  latency = 0;
  readonly ready: Promise<void>;

  constructor(seed: number, save?: string, simulatedLatencyMs = 0) {
    this.latency = simulatedLatencyMs * 2;
    this.worker = new Worker(new URL('../server/server.worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((res) => {
      const on = (ev: MessageEvent) => {
        if (ev.data?.t === '__ready') {
          this.worker.removeEventListener('message', on);
          res();
        }
      };
      this.worker.addEventListener('message', on);
    });
    this.worker.addEventListener('message', (ev) => {
      const msg = ev.data as ServerMessage | { t: '__ready' };
      if (msg.t === '__ready') return;
      if (simulatedLatencyMs > 0) setTimeout(() => this.dispatch(msg as ServerMessage), simulatedLatencyMs);
      else this.dispatch(msg as ServerMessage);
    });
    this.worker.addEventListener('error', (e) => console.error('[server worker]', e.message, e));
    this.worker.postMessage({ kind: 'init', seed, save });
  }

  private dispatch(msg: ServerMessage) {
    for (const cb of this.cbs) cb(msg);
  }

  send(msg: ClientMessage) {
    const lat = this.latency / 2;
    if (lat > 0) setTimeout(() => this.worker.postMessage({ kind: 'msg', msg }), lat);
    else this.worker.postMessage({ kind: 'msg', msg });
  }

  onMessage(cb: (msg: ServerMessage) => void) {
    this.cbs.push(cb);
  }

  close() {
    this.worker.terminate();
  }
}

/** Placeholder for a future networked server. Messages are JSON over WebSocket. */
export class WebSocketTransport implements Transport {
  private ws: WebSocket;
  private cbs: ((msg: ServerMessage) => void)[] = [];
  private queue: ClientMessage[] = [];
  latency = 0;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      for (const m of this.queue) this.ws.send(JSON.stringify(m));
      this.queue = [];
    };
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      for (const cb of this.cbs) cb(msg);
    };
  }
  send(msg: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }
  onMessage(cb: (msg: ServerMessage) => void) {
    this.cbs.push(cb);
  }
  close() {
    this.ws.close();
  }
}
