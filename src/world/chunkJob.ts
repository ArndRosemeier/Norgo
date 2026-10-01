/** Chunk generation job executed inside chunk workers. */
import { WorldGenerator } from './generator';
import { meshChunk, ChunkMesh } from './mesher';
import { applyEditsToChunk, TerrainEdit } from './edits';
import { CHUNK_SIZE } from './constants';
import type { ScatterBatch } from './scatterTypes';
import { scatterChunk } from '../flora/scatter';

export interface ChunkJob {
  type: 'chunk';
  id: number;
  key: string;
  ox: number;
  oy: number;
  oz: number;
  lod: number;
  edits: TerrainEdit[];
  /** Return density + material grids (LOD 0, for physics & digging). */
  wantGrid: boolean;
  /** Run vegetation/rock scatter (only on first generation; deterministic). */
  wantScatter: boolean;
}

export interface ChunkJobResult {
  type: 'chunk';
  id: number;
  key: string;
  lod: number;
  mesh: ChunkMesh | null;
  uniform: 'air' | 'solid' | null;
  density?: Float32Array;
  mats?: Uint8Array;
  scatter?: ScatterBatch[];
  ms: number;
}

export function runChunkJob(gen: WorldGenerator, job: ChunkJob): { result: ChunkJobResult; transfer: Transferable[] } {
  const t0 = performance.now();
  const chunk = gen.fillChunk(job.ox, job.oy, job.oz, job.lod);
  let scatter: ScatterBatch[] | undefined;
  if (job.wantScatter && chunk.uniform === null) {
    const s = CHUNK_SIZE << job.lod;
    try {
      scatter = scatterChunk(gen, chunk, Math.round(job.ox / s), Math.round(job.oy / s), Math.round(job.oz / s));
    } catch (e) {
      console.error('scatter failed', e);
    }
  }
  if (job.edits.length) {
    if (chunk.uniform !== null) {
      // Edits can open up uniform chunks: materialise a full grid first.
      const full = chunk.uniform;
      chunk.density.fill(full === 'solid' ? 8 : -8);
      if (full === 'solid') chunk.mats.fill(2);
      chunk.uniform = null;
      const changed = applyEditsToChunk(chunk, job.edits);
      if (!changed) chunk.uniform = full;
    } else applyEditsToChunk(chunk, job.edits);
  }
  const mesh = chunk.uniform === null ? meshChunk(chunk, job.lod === 0 ? 0 : 1) : null;
  const transfer: Transferable[] = [];
  const result: ChunkJobResult = { type: 'chunk', id: job.id, key: job.key, lod: job.lod, mesh, uniform: chunk.uniform, ms: 0 };
  if (mesh) transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.mats.buffer);
  // Uniform chunks carry no meaningful grid: physics falls back to the analytic field there.
  if (job.wantGrid && chunk.uniform === null) {
    result.density = chunk.density;
    result.mats = chunk.mats;
    transfer.push(chunk.density.buffer, chunk.mats.buffer);
  }
  if (scatter) {
    result.scatter = scatter;
    for (const b of scatter) {
      transfer.push(b.data.buffer);
      if (b.ids) transfer.push(b.ids.buffer);
    }
  }
  result.ms = performance.now() - t0;
  return { result, transfer };
}
