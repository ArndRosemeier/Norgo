/** Run the chunk jobs the streamer requests around a point; report slow ones. */
import { WorldGenerator } from '../src/world/generator';
import { runChunkJob } from '../src/world/chunkJob';
const g = new WorldGenerator(Number(process.argv[2] ?? 1234));
const [px, py, pz] = [978, 22, -1265];
const jobs: [number, number, number, number][] = [];
for (let lod = 0; lod <= 4; lod++) {
  const s = 32 << lod;
  for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
    jobs.push([lod, (Math.floor(px / s) + dx) * s, (Math.floor(py / s) + dy) * s, (Math.floor(pz / s) + dz) * s]);
}
let n = 0;
for (const [lod, ox, oy, oz] of jobs) {
  const t = performance.now();
  runChunkJob(g, { type: 'chunk', id: 1, key: 'k', ox, oy, oz, lod, edits: [], wantGrid: lod === 0, wantScatter: lod <= 3 });
  const ms = performance.now() - t;
  n++;
  if (ms > 300) console.log('SLOW', lod, ox, oy, oz, ms.toFixed(0) + 'ms');
}
console.log('done', n);
