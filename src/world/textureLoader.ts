import type { TerrainTextureData } from './terrainTextures';

/** Synthesize the per-world terrain textures off the main thread. */
export function synthesizeInWorker(seed: number, size = 256): Promise<TerrainTextureData> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./texture.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      resolve(ev.data as TerrainTextureData);
      w.terminate();
    };
    w.onerror = (e) => reject(e);
    w.postMessage({ seed, size });
  });
}
