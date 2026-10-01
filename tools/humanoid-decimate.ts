/**
 * Quadric-error-metric mesh decimation using *half-edge collapses* (a vertex
 * u is merged into an existing neighbour v). Because no new vertices are
 * created, every LOD vertex is an original render vertex: LOD meshes share the
 * full-resolution vertex buffer (morphs, skin weights and UVs come for free)
 * and only need their own index buffer.
 *
 * Boundary vertices (mesh holes and UV seams, which appear as boundaries in
 * the seam-split render mesh) are locked so silhouettes and texture seams stay
 * intact.
 */

class Heap {
  private cost: number[] = [];
  private a: number[] = [];
  private b: number[] = [];
  private stamp: number[] = [];
  get size() { return this.cost.length; }
  push(c: number, u: number, v: number, s: number) {
    this.cost.push(c); this.a.push(u); this.b.push(v); this.stamp.push(s);
    let i = this.cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const r: [number, number, number, number] = [this.cost[0], this.a[0], this.b[0], this.stamp[0]];
    const last = this.cost.length - 1;
    this.swap(0, last);
    this.cost.pop(); this.a.pop(); this.b.pop(); this.stamp.pop();
    let i = 0;
    const n = this.cost.length;
    for (;;) {
      const l = i * 2 + 1, rr = l + 1;
      let m = i;
      if (l < n && this.cost[l] < this.cost[m]) m = l;
      if (rr < n && this.cost[rr] < this.cost[m]) m = rr;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return r;
  }
  private swap(i: number, j: number) {
    [this.cost[i], this.cost[j]] = [this.cost[j], this.cost[i]];
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
    [this.b[i], this.b[j]] = [this.b[j], this.b[i]];
    [this.stamp[i], this.stamp[j]] = [this.stamp[j], this.stamp[i]];
  }
}

/**
 * Decimate `tris` (vertex index triples into `pos`) to each of `targets`
 * triangle counts (descending). Returns one index array per target.
 */
export function decimate(pos: Float32Array, tris: Uint32Array, targets: number[], extraLocked?: Uint8Array): Uint32Array[] {
  const nv = pos.length / 3;
  const T = tris.slice();
  const nt = T.length / 3;
  const alive = new Uint8Array(nt).fill(1);
  const vtris: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vtris[T[t * 3 + k]].push(t);

  // Boundary detection: an edge used by exactly one triangle.
  const edgeCount = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const key = ek(T[t * 3 + k], T[t * 3 + ((k + 1) % 3)]);
    edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
  }
  const locked = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = T[t * 3 + k], b = T[t * 3 + ((k + 1) % 3)];
    if (edgeCount.get(ek(a, b)) !== 2) { locked[a] = 1; locked[b] = 1; }
  }
  if (extraLocked) for (let i = 0; i < nv; i++) if (extraLocked[i]) locked[i] = 1;

  // Quadrics (10 unique entries of the symmetric 4x4).
  const Q = new Float64Array(nv * 10);
  const addPlane = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const q = v * 10;
    Q[q] += w * a * a; Q[q + 1] += w * a * b; Q[q + 2] += w * a * c; Q[q + 3] += w * a * d;
    Q[q + 4] += w * b * b; Q[q + 5] += w * b * c; Q[q + 6] += w * b * d;
    Q[q + 7] += w * c * c; Q[q + 8] += w * c * d; Q[q + 9] += w * d * d;
  };
  for (let t = 0; t < nt; t++) {
    const i0 = T[t * 3] * 3, i1 = T[t * 3 + 1] * 3, i2 = T[t * 3 + 2] * 3;
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1e-12;
    const area = len / 2;
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * pos[i0] + ny * pos[i0 + 1] + nz * pos[i0 + 2]);
    for (let k = 0; k < 3; k++) addPlane(T[t * 3 + k], nx, ny, nz, d, area);
  }
  const quadCost = (u: number, v: number) => {
    const qu = u * 10, qv = v * 10;
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let c = 0;
    const q = (i: number) => Q[qu + i] + Q[qv + i];
    c += q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x;
    c += q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y;
    c += q(7) * z * z + 2 * q(8) * z + q(9);
    return Math.max(0, c);
  };

  const stamp = new Int32Array(nv);
  const heap = new Heap();
  const neighbours = (v: number) => {
    const s = new Set<number>();
    for (const t of vtris[v]) if (alive[t]) for (let k = 0; k < 3; k++) s.add(T[t * 3 + k]);
    s.delete(v);
    return s;
  };
  const pushVertex = (u: number) => {
    if (locked[u]) return;
    stamp[u]++;
    for (const v of neighbours(u)) heap.push(quadCost(u, v), u, v, stamp[u]);
  };
  for (let v = 0; v < nv; v++) pushVertex(v);

  const triNormal = (a: number, b: number, c: number, out: number[]) => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l > 0) { out[0] /= l; out[1] /= l; out[2] /= l; }
    return l;
  };
  const n0 = [0, 0, 0], n1 = [0, 0, 0];

  let live = nt;
  const results: Uint32Array[] = [];
  const snapshot = () => {
    const out: number[] = [];
    for (let t = 0; t < nt; t++) if (alive[t]) out.push(T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
    return Uint32Array.from(out);
  };
  for (const target of targets) {
    while (live > target && heap.size > 0) {
      const [, u, v, s] = heap.pop();
      if (s !== stamp[u] || locked[u]) continue;
      // Edge must still exist.
      let shared = 0;
      for (const t of vtris[u]) if (alive[t]) {
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        if (a === v || b === v || c === v) shared++;
      }
      if (shared === 0) continue;
      // Link condition: common neighbours must equal shared triangle count.
      const nu = neighbours(u), nvv = neighbours(v);
      let common = 0;
      for (const x of nu) if (nvv.has(x)) common++;
      if (common !== shared) continue;
      // Reject flips / slivers.
      let ok = true;
      for (const t of vtris[u]) if (alive[t]) {
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        if (a === v || b === v || c === v) continue;
        triNormal(a, b, c, n0);
        const l = triNormal(a === u ? v : a, b === u ? v : b, c === u ? v : c, n1);
        if (l < 1e-10 || n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0.3) { ok = false; break; }
      }
      if (!ok) { stamp[u]++; continue; }
      // Collapse u → v.
      for (const t of vtris[u]) if (alive[t]) {
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        if (a === v || b === v || c === v) { alive[t] = 0; live--; continue; }
        for (let k = 0; k < 3; k++) if (T[t * 3 + k] === u) T[t * 3 + k] = v;
        vtris[v].push(t);
      }
      vtris[u] = [];
      for (let i = 0; i < 10; i++) Q[v * 10 + i] += Q[u * 10 + i];
      locked[u] = 1; // removed
      stamp[u]++;
      pushVertex(v);
      for (const x of neighbours(v)) pushVertex(x);
    }
    results.push(snapshot());
  }
  return results;
}
