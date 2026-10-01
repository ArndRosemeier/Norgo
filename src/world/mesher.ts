/**
 * Naive Surface Nets mesher producing non-indexed triangles with
 * per-triangle material triples (for smooth 3-way material blending in the
 * terrain shader via gl_VertexID % 3) and per-vertex ambient occlusion.
 *
 * Vertex layout (interleaved by attribute, not by vertex):
 *   position: Float32 x3 (local to chunk origin, meters)
 *   normal:   Int8 x4 normalized (xyz normal, w = sky visibility 0..127)
 *   mats:     Uint8 x4 (m0, m1, m2, ao)  — m* = materials of the triangle's 3 corners
 */
import { CHUNK_SIZE, CHUNK_PAD, GRID_N } from './constants';
import type { ChunkData } from './generator';
import { Mat } from './materials';

export interface ChunkMesh {
  positions: Float32Array;
  normals: Int8Array;
  mats: Uint8Array;
  vertexCount: number;
  /** Local AABB of the mesh. */
  min: [number, number, number];
  max: [number, number, number];
}

const N = GRID_N;
const NN = N * N;
// Cube corner offsets.
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const CORNER_IDX = CORNERS.map(([x, y, z]) => x + y * N + z * NN);
// 12 cube edges as corner pairs.
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * @param overlap number of extra cells emitted beyond the chunk on every side
 *   (hides cracks between LODs).
 */
export function meshChunk(chunk: ChunkData, overlap = 1): ChunkMesh | null {
  const { density, mats, step } = chunk;
  const C = N - 1; // cells per axis
  const vIndex = new Int32Array(C * C * C).fill(-1);
  // Per-cell vertex data (indexed temp storage).
  let cap = 4096;
  let vpos = new Float32Array(cap * 3);
  let vnrm = new Float32Array(cap * 3);
  let vmat = new Uint8Array(cap);
  let vao = new Uint8Array(cap);
  let vsky = new Uint8Array(cap);
  let vcount = 0;

  const corner = new Float32Array(8);
  for (let z = 0; z < C; z++)
    for (let y = 0; y < C; y++)
      for (let x = 0; x < C; x++) {
        const base = x + y * N + z * NN;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const d = density[base + CORNER_IDX[c]];
          corner[c] = d;
          if (d > 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        // Vertex = average of edge crossings.
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          const da = corner[a], db = corner[b];
          if (da > 0 === db > 0) continue;
          const t = da / (da - db);
          const ca = CORNERS[a], cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          cnt++;
        }
        sx /= cnt; sy /= cnt; sz /= cnt;
        // Gradient of the trilinear interpolant at the vertex → normal (pointing to air).
        const fx = sx, fy = sy, fz = sz;
        const gx =
          (corner[1] - corner[0]) * (1 - fy) * (1 - fz) + (corner[3] - corner[2]) * fy * (1 - fz) +
          (corner[5] - corner[4]) * (1 - fy) * fz + (corner[7] - corner[6]) * fy * fz;
        const gy =
          (corner[2] - corner[0]) * (1 - fx) * (1 - fz) + (corner[3] - corner[1]) * fx * (1 - fz) +
          (corner[6] - corner[4]) * (1 - fx) * fz + (corner[7] - corner[5]) * fx * fz;
        const gz =
          (corner[4] - corner[0]) * (1 - fx) * (1 - fy) + (corner[5] - corner[1]) * fx * (1 - fy) +
          (corner[6] - corner[2]) * (1 - fx) * fy + (corner[7] - corner[3]) * fx * fy;
        let nx = -gx, ny = -gy, nz = -gz;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        // Material: the solid corner with highest density among those nearest the surface,
        // favouring upper corners so ground tops win over cliff sides.
        let best = -1e9, m: number = Mat.Stone;
        for (let c = 0; c < 8; c++) {
          const d = corner[c];
          if (d <= 0) continue;
          const mm = mats[base + CORNER_IDX[c]];
          if (!mm) continue;
          const score = -d + CORNERS[c][1] * 0.25 * step;
          if (score > best) {
            best = score;
            m = mm;
          }
        }

        if (vcount >= cap) {
          cap *= 2;
          const p2 = new Float32Array(cap * 3); p2.set(vpos); vpos = p2;
          const n2 = new Float32Array(cap * 3); n2.set(vnrm); vnrm = n2;
          const m2 = new Uint8Array(cap); m2.set(vmat); vmat = m2;
          const a2 = new Uint8Array(cap); a2.set(vao); vao = a2;
          const s2 = new Uint8Array(cap); s2.set(vsky); vsky = s2;
        }
        const vi = vcount++;
        vpos[vi * 3] = (x + sx - CHUNK_PAD) * step;
        vpos[vi * 3 + 1] = (y + sy - CHUNK_PAD) * step;
        vpos[vi * 3 + 2] = (z + sz - CHUNK_PAD) * step;
        vnrm[vi * 3] = nx;
        vnrm[vi * 3 + 1] = ny;
        vnrm[vi * 3 + 2] = nz;
        vmat[vi] = m;
        vao[vi] = ambientOcclusion(density, x, y, z, nx, ny, nz);
        vsky[vi] = skyVisibility(chunk, density, x, y, z, vpos[vi * 3 + 1]);
        vIndex[x + y * C + z * C * C] = vi;
      }

  if (vcount === 0) return null;

  // Emit quads for sign-changing edges. Edge from sample s to s+axis is surrounded
  // by 4 cells. Emit only edges whose base sample lies within the chunk's range
  // (+ overlap) to avoid gaps and limit duplication.
  const lo = CHUNK_PAD - overlap;
  const hi = CHUNK_PAD + CHUNK_SIZE + overlap; // exclusive for base samples
  const tris: number[] = [];
  for (let z = 1; z < C; z++)
    for (let y = 1; y < C; y++)
      for (let x = 1; x < C; x++) {
        const s = x + y * N + z * NN;
        const d0 = density[s];
        const inX = x >= lo && x < hi, inY = y >= lo && y < hi, inZ = z >= lo && z < hi;
        // +X edge
        if (x < C && inX && inY && inZ) {
          const d1 = density[s + 1];
          if (d0 > 0 !== d1 > 0) {
            const a = vIndex[x + (y - 1) * C + (z - 1) * C * C];
            const b = vIndex[x + y * C + (z - 1) * C * C];
            const c = vIndex[x + y * C + z * C * C];
            const d = vIndex[x + (y - 1) * C + z * C * C];
            pushQuad(tris, a, b, c, d, d0 > 0);
          }
        }
        // +Y edge
        if (y < C && inX && inY && inZ) {
          const d1 = density[s + N];
          if (d0 > 0 !== d1 > 0) {
            const a = vIndex[(x - 1) + y * C + (z - 1) * C * C];
            const b = vIndex[(x - 1) + y * C + z * C * C];
            const c = vIndex[x + y * C + z * C * C];
            const d = vIndex[x + y * C + (z - 1) * C * C];
            pushQuad(tris, a, b, c, d, d0 > 0);
          }
        }
        // +Z edge
        if (z < C && inX && inY && inZ) {
          const d1 = density[s + NN];
          if (d0 > 0 !== d1 > 0) {
            const a = vIndex[(x - 1) + (y - 1) * C + z * C * C];
            const b = vIndex[x + (y - 1) * C + z * C * C];
            const c = vIndex[x + y * C + z * C * C];
            const d = vIndex[(x - 1) + y * C + z * C * C];
            pushQuad(tris, a, b, c, d, d0 > 0);
          }
        }
      }

  if (tris.length === 0) return null;

  // Skirts: every open mesh edge lies on a chunk border. Hang a short strip from
  // it into the ground so cracks between chunks of different LOD stay closed.
  {
    const edgeCount = new Map<number, number>();
    const BIG = 1 << 20;
    const n = tris.length;
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k], b = tris[t + ((k + 1) % 3)];
        const key = a < b ? a * BIG + b : b * BIG + a;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    const L = Math.max(1, step) * 1.6;
    const skirtOf = new Map<number, number>();
    const skirtVertex = (vi: number): number => {
      let s = skirtOf.get(vi);
      if (s !== undefined) return s;
      if (vcount >= cap) {
        cap *= 2;
        const p2 = new Float32Array(cap * 3); p2.set(vpos); vpos = p2;
        const n2 = new Float32Array(cap * 3); n2.set(vnrm); vnrm = n2;
        const m2 = new Uint8Array(cap); m2.set(vmat); vmat = m2;
        const a2 = new Uint8Array(cap); a2.set(vao); vao = a2;
        const s2 = new Uint8Array(cap); s2.set(vsky); vsky = s2;
      }
      s = vcount++;
      // Push down mostly vertically (terrain), partly along the inverse normal.
      const nx = vnrm[vi * 3], ny = vnrm[vi * 3 + 1], nz = vnrm[vi * 3 + 2];
      vpos[s * 3] = vpos[vi * 3] - nx * L * 0.5;
      vpos[s * 3 + 1] = vpos[vi * 3 + 1] - (Math.abs(ny) * 0.5 + 0.5) * L * Math.sign(ny || 1);
      vpos[s * 3 + 2] = vpos[vi * 3 + 2] - nz * L * 0.5;
      vnrm[s * 3] = nx; vnrm[s * 3 + 1] = ny; vnrm[s * 3 + 2] = nz;
      vmat[s] = vmat[vi];
      vao[s] = vao[vi];
      vsky[s] = vsky[vi];
      skirtOf.set(vi, s);
      return s;
    };
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k], b = tris[t + ((k + 1) % 3)];
        const key = a < b ? a * BIG + b : b * BIG + a;
        if (edgeCount.get(key) !== 1) continue;
        const as = skirtVertex(a), bs = skirtVertex(b);
        // Triangle winding (a,b,c) is front-facing; the strip below edge a→b keeps the
        // same side facing outward when wound (b, a, as) / (b, as, bs).
        tris.push(b, a, as, b, as, bs);
      }
    }
  }

  const triCount = tris.length / 3;
  const vc = triCount * 3;
  const positions = new Float32Array(vc * 3);
  const normals = new Int8Array(vc * 4);
  const outMats = new Uint8Array(vc * 4);
  const min: [number, number, number] = [1e9, 1e9, 1e9];
  const max: [number, number, number] = [-1e9, -1e9, -1e9];
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
    const m0 = vmat[i0], m1 = vmat[i1], m2 = vmat[i2];
    for (let k = 0; k < 3; k++) {
      const vi = tris[t * 3 + k];
      const o = t * 3 + k;
      for (let a = 0; a < 3; a++) {
        const p = vpos[vi * 3 + a];
        positions[o * 3 + a] = p;
        if (p < min[a]) min[a] = p;
        if (p > max[a]) max[a] = p;
        normals[o * 4 + a] = Math.round(vnrm[vi * 3 + a] * 127);
      }
      normals[o * 4 + 3] = vsky[vi];
      outMats[o * 4] = m0;
      outMats[o * 4 + 1] = m1;
      outMats[o * 4 + 2] = m2;
      outMats[o * 4 + 3] = vao[vi];
    }
  }
  return { positions, normals, mats: outMats, vertexCount: vc, min, max };
}

function pushQuad(out: number[], a: number, b: number, c: number, d: number, flip: boolean) {
  if (a < 0 || b < 0 || c < 0 || d < 0) return;
  if (flip) {
    out.push(a, b, c, a, c, d);
  } else {
    out.push(a, c, b, a, d, c);
  }
}

/**
 * Sky visibility 0..127 at a vertex: fades out below the 2D surface (caves,
 * underworld) and darkens under overhangs detected inside the chunk grid.
 */
function skyVisibility(chunk: ChunkData, density: Float32Array, x: number, y: number, z: number, localY: number): number {
  const worldY = chunk.oy + localY;
  let vis = 1;
  if (chunk.heights) {
    const cx = Math.min(N - 1, x + 1), cz = Math.min(N - 1, z + 1);
    const h = chunk.heights[cx + cz * N];
    const depth = h - worldY;
    if (depth > 1.5) {
      const t = Math.min(1, (depth - 1.5) / (10 + chunk.step * 2));
      vis = 1 - t * t * (3 - 2 * t);
    }
  }
  if (vis > 0) {
    // Rock directly above inside this chunk → overhang shade.
    const sx = Math.min(N - 1, x + 1), sz = Math.min(N - 1, z + 1);
    for (let yy = y + 2; yy < N; yy++) {
      if (density[sx + yy * N + sz * NN] > 0) {
        vis *= 0.4;
        break;
      }
    }
  }
  return Math.round(vis * 127);
}

/** Openness around a vertex: 255 = fully open, lower = occluded (crevices, caves). */
function ambientOcclusion(density: Float32Array, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  let open = 0, total = 0;
  for (let k = -2; k <= 3; k += 1)
    for (let j = -2; j <= 3; j += 1)
      for (let i = -2; i <= 3; i += 1) {
        // Hemisphere along the normal.
        const dot = (i - 0.5) * nx + (j - 0.5) * ny + (k - 0.5) * nz;
        if (dot < 0.5) continue;
        const sx = x + i, sy = y + j, sz = z + k;
        if (sx < 0 || sy < 0 || sz < 0 || sx >= N || sy >= N || sz >= N) continue;
        const w = 1 / (1 + dot * 0.5);
        total += w;
        if (density[sx + sy * N + sz * NN] <= 0) open += w;
      }
  if (total === 0) return 255;
  const o = open / total;
  return Math.max(0, Math.min(255, Math.round(Math.pow(o, 0.8) * 255)));
}
