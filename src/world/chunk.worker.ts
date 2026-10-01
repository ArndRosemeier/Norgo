import { WorldGenerator } from './generator';
import { runChunkJob, ChunkJob } from './chunkJob';

let gen: WorldGenerator | null = null;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    gen = new WorldGenerator(msg.seed as number);
    (self as unknown as Worker).postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'chunk') {
    if (!gen) throw new Error('chunk worker not initialised');
    const { result, transfer } = runChunkJob(gen, msg as ChunkJob);
    (self as unknown as Worker).postMessage(result, transfer);
  }
};
