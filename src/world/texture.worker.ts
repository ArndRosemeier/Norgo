import { createProfile } from './profile';
import { synthesizeTerrainTextures } from './terrainTextures';

self.onmessage = (ev: MessageEvent) => {
  const { seed, size } = ev.data as { seed: number; size: number };
  const data = synthesizeTerrainTextures(createProfile(seed), size);
  (self as unknown as Worker).postMessage(data, [data.albedo.buffer, data.normal.buffer]);
};
