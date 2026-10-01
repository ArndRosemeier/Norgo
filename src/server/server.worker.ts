/**
 * Runs the GameServer inside a Web Worker, communicating with the client only
 * through serialized protocol messages — the same boundary a network socket
 * would impose.
 */
import { GameServer, TICK_RATE, SaveFile } from './GameServer';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { applyDeviceClass, type DeviceClass } from '../core/budgets';

let server: GameServer | null = null;
let handler: ((msg: ClientMessage) => void) | null = null;
const post = (msg: ServerMessage) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (ev: MessageEvent) => {
  const data = ev.data as { kind: 'init'; seed: number; save?: string; deviceClass?: DeviceClass } | { kind: 'msg'; msg: ClientMessage };
  if (data.kind === 'init') {
    // Workers can't see the device; the client tells us which cache budgets apply.
    if (data.deviceClass) applyDeviceClass(data.deviceClass);
    server = new GameServer(data.seed);
    if (data.save) {
      try {
        server.load(JSON.parse(data.save) as SaveFile);
      } catch (err) {
        console.error('[server] failed to load save', err);
      }
    }
    handler = server.connect(post);
    let last = performance.now();
    let acc = 0;
    const step = 1000 / TICK_RATE;
    setInterval(() => {
      const now = performance.now();
      acc += Math.min(500, now - last);
      last = now;
      while (acc >= step) {
        server!.tick();
        acc -= step;
      }
    }, step / 2);
    (self as unknown as Worker).postMessage({ t: '__ready' });
    return;
  }
  if (data.kind === 'msg' && handler) handler(data.msg);
};
