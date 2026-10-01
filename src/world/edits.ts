/**
 * Terrain deformation. Edits are authoritative on the server, replicated to
 * clients, and re-applied whenever a chunk is regenerated, so they persist.
 */
import { CHUNK_PAD, GRID_N, MAX_EDIT_RADIUS, BEDROCK_Y } from './constants';
import type { ChunkData } from './generator';
import { Mat } from './materials';

export type EditOp = 'dig' | 'fill' | 'smooth';

export interface TerrainEdit {
  id: number;
  op: EditOp;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0..1 — fraction of full effect (explosions fade, picks chip). */
  strength: number;
  /** Material for fill operations. */
  mat?: Mat;
}

export function clampEdit(e: TerrainEdit): TerrainEdit {
  return { ...e, radius: Math.min(MAX_EDIT_RADIUS, Math.max(0.3, e.radius)), strength: Math.min(1, Math.max(0, e.strength)) };
}

/** Effect of one edit on a density value at distance `dist` from its centre. */
export function editDensity(d: number, e: TerrainEdit, dist: number, y: number): number {
  const r = e.radius;
  if (dist > r + 1.5) return d;
  if (e.op === 'dig') {
    if (y < BEDROCK_Y + 2) return d;
    // Smooth subtraction of a sphere, scaled by strength (partial chips leave dents).
    const sd = dist - r * e.strength;
    return Math.min(d, sd + (1 - e.strength) * 0.5);
  }
  if (e.op === 'fill') {
    const sd = r * e.strength - dist;
    return Math.max(d, sd);
  }
  // smooth: pull towards 0 crossing gently (used by water erosion / footprints)
  const k = Math.max(0, 1 - dist / r) * e.strength * 0.5;
  return d * (1 - k);
}

/** Apply a list of edits to a chunk grid in-place. Returns true if anything changed. */
export function applyEditsToChunk(chunk: ChunkData, edits: TerrainEdit[]): boolean {
  if (!edits.length) return false;
  const { density, mats, step, ox, oy, oz } = chunk;
  const N = GRID_N;
  let changed = false;
  for (const e of edits) {
    const reach = e.radius + 1.5;
    const i0 = Math.max(0, Math.floor((e.x - reach - ox) / step) + CHUNK_PAD);
    const i1 = Math.min(N - 1, Math.ceil((e.x + reach - ox) / step) + CHUNK_PAD);
    const j0 = Math.max(0, Math.floor((e.y - reach - oy) / step) + CHUNK_PAD);
    const j1 = Math.min(N - 1, Math.ceil((e.y + reach - oy) / step) + CHUNK_PAD);
    const k0 = Math.max(0, Math.floor((e.z - reach - oz) / step) + CHUNK_PAD);
    const k1 = Math.min(N - 1, Math.ceil((e.z + reach - oz) / step) + CHUNK_PAD);
    if (i0 > i1 || j0 > j1 || k0 > k1) continue;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = ox + (i - CHUNK_PAD) * step, y = oy + (j - CHUNK_PAD) * step, z = oz + (k - CHUNK_PAD) * step;
          const dist = Math.hypot(x - e.x, y - e.y, z - e.z);
          const idx = i + j * N + k * N * N;
          const before = density[idx];
          const after = editDensity(before, e, dist, y);
          if (after !== before) {
            density[idx] = after;
            changed = true;
            if (e.op === 'fill' && before <= 0 && after > 0) mats[idx] = e.mat ?? Mat.Dirt;
            if (e.op === 'dig' && after > 0 && !mats[idx]) mats[idx] = Mat.Stone;
          }
        }
  }
  if (changed) chunk.uniform = null;
  return changed;
}

/** Does an edit touch an axis-aligned box? */
export function editTouches(e: TerrainEdit, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  const r = e.radius + 2;
  return e.x + r >= minX && e.x - r <= maxX && e.y + r >= minY && e.y - r <= maxY && e.z + r >= minZ && e.z - r <= maxZ;
}

/** Spatial index of edits for fast lookups. */
export class EditStore {
  private cells = new Map<string, TerrainEdit[]>();
  private all: TerrainEdit[] = [];
  static readonly CELL = 32;

  add(e: TerrainEdit) {
    this.all.push(e);
    const r = e.radius + 2;
    const C = EditStore.CELL;
    for (let cz = Math.floor((e.z - r) / C); cz <= Math.floor((e.z + r) / C); cz++)
      for (let cy = Math.floor((e.y - r) / C); cy <= Math.floor((e.y + r) / C); cy++)
        for (let cx = Math.floor((e.x - r) / C); cx <= Math.floor((e.x + r) / C); cx++) {
          const k = cx + ',' + cy + ',' + cz;
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(e);
        }
  }

  get count() {
    return this.all.length;
  }

  list(): TerrainEdit[] {
    return this.all;
  }

  /** Edits overlapping a box, in insertion order. */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): TerrainEdit[] {
    const C = EditStore.CELL;
    const out: TerrainEdit[] = [];
    // Large boxes: a linear scan of the edits is far cheaper than visiting every cell.
    const cells = (Math.floor(maxX / C) - Math.floor(minX / C) + 1) * (Math.floor(maxY / C) - Math.floor(minY / C) + 1) * (Math.floor(maxZ / C) - Math.floor(minZ / C) + 1);
    if (cells > this.all.length * 4 + 64) {
      for (const e of this.all) if (editTouches(e, minX, minY, minZ, maxX, maxY, maxZ)) out.push(e);
      return out;
    }
    const seen = new Set<number>();
    for (let cz = Math.floor(minZ / C); cz <= Math.floor(maxZ / C); cz++)
      for (let cy = Math.floor(minY / C); cy <= Math.floor(maxY / C); cy++)
        for (let cx = Math.floor(minX / C); cx <= Math.floor(maxX / C); cx++) {
          const l = this.cells.get(cx + ',' + cy + ',' + cz);
          if (!l) continue;
          for (const e of l) {
            if (seen.has(e.id)) continue;
            if (!editTouches(e, minX, minY, minZ, maxX, maxY, maxZ)) continue;
            seen.add(e.id);
            out.push(e);
          }
        }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** Density with edits applied (for physics/server queries). */
  apply(d: number, x: number, y: number, z: number): number {
    const C = EditStore.CELL;
    const l = this.cells.get(Math.floor(x / C) + ',' + Math.floor(y / C) + ',' + Math.floor(z / C));
    if (!l) return d;
    for (const e of l) d = editDensity(d, e, Math.hypot(x - e.x, y - e.y, z - e.z), y);
    return d;
  }
}
