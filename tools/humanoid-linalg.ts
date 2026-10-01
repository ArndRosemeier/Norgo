/**
 * Small dense linear algebra helpers for the human asset converter:
 * Jacobi eigen-decomposition, Gram-Schmidt, and a subspace-iteration PCA that
 * never materializes the (samples × vertices) data matrix.
 *
 * The macro morph of a body is x(p) = Σ_t w_t(p) · D_t (D_t = target deltas).
 * For sampled parameter sets the sample covariance in vertex space is
 * C = Dᵀ G D with G = cov(w) (targets × targets), so a PCA basis can be found
 * by subspace iteration using only products with D and G.
 */

/** Symmetric eigen-decomposition (cyclic Jacobi). Returns eigenvalues (desc) and column eigenvectors. */
export function jacobiEigen(Ain: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  const A = Float64Array.from(Ain);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const app = A[p * n + p], aqq = A[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b * n + b] - A[a * n + a]);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  order.forEach((src, dst) => {
    values[dst] = A[src * n + src];
    for (let k = 0; k < n; k++) vectors[k * n + dst] = V[k * n + src];
  });
  return { values, vectors };
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** In-place modified Gram-Schmidt on a list of vectors. */
export function orthonormalize(vs: Float64Array[]) {
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < i; j++) {
        const d = dot(v, vs[j]);
        const u = vs[j];
        for (let k = 0; k < v.length; k++) v[k] -= d * u[k];
      }
    }
    const n = Math.sqrt(dot(v, v)) || 1;
    for (let k = 0; k < v.length; k++) v[k] /= n;
  }
}

/**
 * Top-K principal directions of C = Dᵀ G D.
 * `D` = target deltas (rows of length L), `G` = T×T weight covariance.
 */
export function subspacePCA(D: Float32Array[], G: Float64Array, K: number, iters: number, seed = 1): { basis: Float64Array[]; variance: Float64Array } {
  const T = D.length, L = D[0].length, Kp = K + 10;
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
  let Y: Float64Array[] = Array.from({ length: Kp }, () => {
    const v = new Float64Array(L);
    for (let i = 0; i < L; i++) v[i] = rnd();
    return v;
  });
  orthonormalize(Y);
  const Z = new Float64Array(T * Kp);
  const Z2 = new Float64Array(T * Kp);
  const project = () => {
    // Z = D Y
    for (let t = 0; t < T; t++) for (let k = 0; k < Kp; k++) Z[t * Kp + k] = dot(D[t], Y[k]);
    // Z2 = G Z
    Z2.fill(0);
    for (let a = 0; a < T; a++) for (let b = 0; b < T; b++) {
      const g = G[a * T + b];
      if (g === 0) continue;
      for (let k = 0; k < Kp; k++) Z2[a * Kp + k] += g * Z[b * Kp + k];
    }
  };
  for (let it = 0; it < iters; it++) {
    project();
    const Yn = Array.from({ length: Kp }, () => new Float64Array(L));
    for (let t = 0; t < T; t++) {
      const d = D[t];
      for (let k = 0; k < Kp; k++) {
        const z = Z2[t * Kp + k];
        if (z === 0) continue;
        const y = Yn[k];
        for (let i = 0; i < L; i++) y[i] += z * d[i];
      }
    }
    orthonormalize(Yn);
    Y = Yn;
    process.stdout.write(`  pca iteration ${it + 1}/${iters}\r`);
  }
  process.stdout.write('\n');
  // Rayleigh–Ritz: A = Yᵀ C Y = Zᵀ G Z, rotate Y to the eigenbasis.
  project();
  const A = new Float64Array(Kp * Kp);
  for (let i = 0; i < Kp; i++) for (let j = 0; j < Kp; j++) {
    let acc = 0;
    for (let t = 0; t < T; t++) acc += Z[t * Kp + i] * Z2[t * Kp + j];
    A[i * Kp + j] = acc;
  }
  for (let i = 0; i < Kp; i++) for (let j = i + 1; j < Kp; j++) {
    const m = (A[i * Kp + j] + A[j * Kp + i]) / 2;
    A[i * Kp + j] = A[j * Kp + i] = m;
  }
  const { values, vectors } = jacobiEigen(A, Kp);
  const basis: Float64Array[] = [];
  for (let c = 0; c < K; c++) {
    const b = new Float64Array(L);
    for (let k = 0; k < Kp; k++) {
      const w = vectors[k * Kp + c];
      const y = Y[k];
      for (let i = 0; i < L; i++) b[i] += w * y[i];
    }
    basis.push(b);
  }
  return { basis, variance: values.slice(0, K) };
}
