/**
 * Contract between chunk workers (which decide *where* things grow/lie) and the
 * client systems that render them (flora, rocks, props).
 *
 * Scatter runs inside the chunk worker on freshly generated (unedited) chunk data,
 * so placements are deterministic and stable: the same object always gets the
 * same id, which the server uses to track destruction.
 */

/** Floats per instance in ScatterBatch.data. */
export const SCATTER_STRIDE = 8;

export interface ScatterBatch {
  /**
   * Renderer-defined kind, e.g. "tree:3" (species index), "rock:1", "grass", "shroom:7".
   * The owning client system interprets it.
   */
  kind: string;
  /**
   * Instances, SCATTER_STRIDE floats each:
   *   0..2 position relative to chunk origin (m)
   *   3    yaw (radians)
   *   4    uniform scale
   *   5    tilt x (radians) — align to slope / leaning trees
   *   6    tilt z (radians)
   *   7    per-instance random 0..1 (color variation, animation phase)
   */
  data: Float32Array;
  /** Stable object ids (for destructible objects); same length as instance count, or undefined. */
  ids?: Uint32Array;
}

export interface ScatterResult {
  batches: ScatterBatch[];
}

/** Stable object id for the n-th scatter object of a kind group in an LOD-0 chunk. */
export function scatterId(cx: number, cy: number, cz: number, group: number, n: number): number {
  let h = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ Math.imul(group + 1, 0x297a2d39) ^ Math.imul(n + 1, 0x9e3779b1);
  h ^= h >>> 13;
  return h >>> 0;
}
