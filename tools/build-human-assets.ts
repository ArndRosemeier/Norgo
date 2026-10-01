/**
 * Converts the CC0 MakeHuman 1.1 base data (mesh, targets, skeleton, weights,
 * expression units) into Norgo's compact runtime format in
 * `public/assets/human/` (`human.bin` + `manifest.json`, see
 * `src/humanoid/assetFormat.ts`).
 *
 * Usage:  npx tsx tools/build-human-assets.ts [path/to/makehuman/data]
 *         (or set MH_DATA). The converted output is committed, so the raw
 *         MakeHuman checkout is only needed to regenerate it.
 *
 * What it does:
 *  1. Parses `3dobjs/base.obj`, keeps the body, tongue, teeth, eyelashes and
 *     the eye helper spheres (for fitting procedural eyeballs); drops all
 *     other helper/joint geometry. Quads → triangles (shorter diagonal), UV
 *     seams split into render vertices.
 *  2. Builds a reduced 69-bone game skeleton from `rigs/default.mhskel`
 *     (face/metacarpal/toe bones merged into their nearest kept ancestor) and
 *     stores bone heads/tails as *virtual vertices* (means of MakeHuman's
 *     joint helper vertices) so the runtime can recompute joints from any
 *     morphed body. Weights from `default_weights.mhw`, top 4 per vertex.
 *  3. Macro targets (gender/age/muscle/weight/height/proportions/ethnicity/
 *     breast; ~112 MB of text): evaluates MakeHuman's exact macro weighting
 *     (`src/humanoid/macro.ts`) over thousands of sampled parameter sets,
 *     finds a PCA basis of the resulting bodies by subspace iteration, and
 *     stores the int16 basis + mean + a per-target projection matrix. At
 *     runtime coefficients = Σ_t w_t(params)·P_t − P_mean, i.e. the exact
 *     MakeHuman morph projected onto the basis.
 *  4. Selected local targets (face, ears, measurements, limbs...) as sparse
 *     int16 deltas; facial expression units (averaged over the three ethnic
 *     sets) as a dense face-vertex block for a shared GPU texture.
 *  5. Two decimated LODs of the body by half-edge-collapse QEM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeMacroVars, macroTargetWeights, type MacroParams } from '../src/humanoid/macro.ts';
import { HUMAN_ASSET_VERSION, type BoneDef, type HumanManifest, type LocalTargetDef, type Section, type SectionType, type SubMesh } from '../src/humanoid/assetFormat.ts';
import { dot, subspacePCA } from './humanoid-linalg.ts';
import { decimate } from './humanoid-decimate.ts';

const DEFAULT_MH = 'C:/Users/windo/AppData/Local/Temp/claude/C--Projekte-Norgo/19376ca2-5f49-4117-8b7c-2b9e43f10587/scratchpad/mh/makehuman/data';
const MH = process.argv[2] ?? process.env.MH_DATA ?? DEFAULT_MH;
const OUT = path.resolve('public/assets/human');
const PCA_COMPONENTS = Number(process.env.PCA_K ?? 40);
const PCA_SAMPLES = 2400;
const LOD_TRIS = [6000, 2400];

if (!fs.existsSync(path.join(MH, '3dobjs/base.obj'))) {
  console.error(`MakeHuman data not found at ${MH}. Pass the path to makehuman/data.`);
  process.exit(1);
}
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ------------------------------------------------------------------ OBJ

interface Face { g: string; v: number[]; t: number[] }
const objText = fs.readFileSync(path.join(MH, '3dobjs/base.obj'), 'utf8');
const mhPos: number[] = [];
const mhUV: number[] = [];
const faces: Face[] = [];
{
  let g = '';
  for (const line of objText.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') mhPos.push(+p[1], +p[2], +p[3]);
    else if (p[0] === 'vt') mhUV.push(+p[1], +p[2]);
    else if (p[0] === 'g') g = p[1];
    else if (p[0] === 'f') {
      const v: number[] = [], t: number[] = [];
      for (const s of p.slice(1)) {
        const [a, b] = s.split('/');
        v.push(+a - 1);
        t.push(+b - 1);
      }
      faces.push({ g, v, t });
    }
  }
}
const MH_VERTS = mhPos.length / 3;
log('base.obj', MH_VERTS, 'verts', faces.length, 'faces');

/** MakeHuman decimeters, facing +Z → Norgo meters facing −Z (180° turn about Y). */
const S = 0.1;
const toNorgo = (x: number, y: number, z: number): [number, number, number] => [-x * S, y * S, -z * S];

const groupOf = (g: string): SubMesh['name'] | 'eyeL' | 'eyeR' | null => {
  if (g === 'body') return 'body';
  if (g === 'helper-tongue') return 'tongue';
  if (g === 'helper-upper-teeth' || g === 'helper-lower-teeth') return 'teeth';
  if (g.includes('eyelashes')) return 'lashes';
  if (g === 'helper-l-eye') return 'eyeL';
  if (g === 'helper-r-eye') return 'eyeR';
  return null;
};

// Morph vertex order: body, tongue, eyeL, eyeR, lashes, teeth (MakeHuman's
// own index order, so the kept ranges are contiguous).
const groupVerts: Record<string, Set<number>> = {};
for (const f of faces) {
  const g = groupOf(f.g);
  if (!g) continue;
  for (const v of f.v) (groupVerts[g] ??= new Set()).add(v);
}
const morphOrder = ['body', 'tongue', 'eyeL', 'eyeR', 'lashes', 'teeth'];
const mhToMorph = new Int32Array(MH_VERTS).fill(-1);
const morphToMh: number[] = [];
const groupRanges: Record<string, [number, number]> = {};
for (const g of morphOrder) {
  const vs = [...groupVerts[g]].sort((a, b) => a - b);
  groupRanges[g] = [morphToMh.length, vs.length];
  for (const v of vs) {
    mhToMorph[v] = morphToMh.length;
    morphToMh.push(v);
  }
}
const REAL = morphToMh.length;
log('real morph verts', REAL, groupRanges);

// ------------------------------------------------------------------ skeleton

interface MhSkel { bones: Record<string, { head: string; tail: string; parent: string | null }>; joints: Record<string, number[]> }
const skel: MhSkel = JSON.parse(fs.readFileSync(path.join(MH, 'rigs/default.mhskel'), 'utf8'));

const sides = ['L', 'R'];
const KEEP: string[] = ['root', 'spine05', 'spine04', 'spine03', 'spine02', 'spine01', 'neck01', 'neck02', 'neck03', 'head', 'jaw'];
for (const s of sides) {
  KEEP.push(`clavicle.${s}`, `shoulder01.${s}`, `upperarm01.${s}`, `upperarm02.${s}`, `lowerarm01.${s}`, `lowerarm02.${s}`, `wrist.${s}`);
  for (let f = 1; f <= 5; f++) for (let k = 1; k <= 3; k++) KEEP.push(`finger${f}-${k}.${s}`);
}
for (const s of sides) KEEP.push(`pelvis.${s}`, `upperleg01.${s}`, `upperleg02.${s}`, `lowerleg01.${s}`, `lowerleg02.${s}`, `foot.${s}`, `toes.${s}`);

/** Virtual vertices: weighted MakeHuman vertex lists. */
const virtuals: { name: string; refs: number[]; w: number[] }[] = [];
const virtualIndex = new Map<string, number>();
function virtualFor(name: string, refs: number[], w?: number[]): number {
  const ex = virtualIndex.get(name);
  if (ex !== undefined) return ex;
  const idx = REAL + virtuals.length;
  virtuals.push({ name, refs, w: w ?? refs.map(() => 1 / refs.length) });
  virtualIndex.set(name, idx);
  return idx;
}
const jointVirtual = (j: string) => virtualFor(j, skel.joints[j]);
/** Average of several joints (merged toe bone). */
function avgJoints(name: string, joints: string[]): number {
  const refs: number[] = [], w: number[] = [];
  for (const j of joints) for (const r of skel.joints[j]) {
    refs.push(r);
    w.push(1 / skel.joints[j].length / joints.length);
  }
  return virtualFor(name, refs, w);
}

const bones: BoneDef[] = [];
const boneIndex = new Map<string, number>();
for (const name of KEEP) {
  let head: number, tail: number, parentName: string | null;
  if (name.startsWith('toes.')) {
    const s = name.slice(5);
    head = avgJoints(`toes.${s}____head`, [1, 2, 3, 4, 5].map((t) => skel.bones[`toe${t}-1.${s}`].head));
    tail = avgJoints(`toes.${s}____tail`, [1, 2, 3, 4, 5].map((t) => skel.bones[t === 1 ? `toe1-2.${s}` : `toe${t}-3.${s}`].tail));
    parentName = `foot.${s}`;
  } else {
    const b = skel.bones[name];
    head = jointVirtual(b.head);
    tail = jointVirtual(b.tail);
    parentName = b.parent;
    while (parentName && !KEEP.includes(parentName)) parentName = skel.bones[parentName].parent;
  }
  const parent = parentName ? boneIndex.get(parentName)! : -1;
  if (parentName && parent === undefined) throw new Error(`parent ${parentName} of ${name} not yet defined`);
  boneIndex.set(name, bones.length);
  bones.push({ name, parent, head, tail });
}
/** Map every MakeHuman bone to the kept bone that inherits its weights. */
function keptFor(mhBone: string): number {
  const toe = /^toe\d-\d\.(L|R)$/.exec(mhBone);
  if (toe) return boneIndex.get(`toes.${toe[1]}`)!;
  let b: string | null = mhBone;
  while (b && !boneIndex.has(b)) b = skel.bones[b].parent;
  return b ? boneIndex.get(b)! : 0;
}
const VIRT = virtuals.length;
const N = REAL + VIRT;
log('bones', bones.length, 'virtual verts', VIRT);

// ------------------------------------------------------------------ weights

const mhw: { weights: Record<string, [number, number][]> } = JSON.parse(fs.readFileSync(path.join(MH, 'rigs/default_weights.mhw'), 'utf8'));
const vWeights: Map<number, number>[] = Array.from({ length: REAL }, () => new Map());
for (const [bname, list] of Object.entries(mhw.weights)) {
  const kb = keptFor(bname);
  for (const [v, w] of list) {
    const m = mhToMorph[v];
    if (m < 0) continue;
    vWeights[m].set(kb, (vWeights[m].get(kb) ?? 0) + w);
  }
}
const skinIdx = new Uint8Array(REAL * 4);
const skinW = new Uint8Array(REAL * 4);
for (let i = 0; i < REAL; i++) {
  const top = [...vWeights[i].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length === 0) top.push([boneIndex.get('head')!, 1]);
  const sum = top.reduce((s, e) => s + e[1], 0);
  // Quantize to bytes summing exactly 255.
  let acc = 0;
  top.forEach(([b, w], k) => {
    const q = k === top.length - 1 ? 255 - acc : Math.round((w / sum) * 255);
    skinIdx[i * 4 + k] = b;
    skinW[i * 4 + k] = q;
    acc += q;
  });
}

// ------------------------------------------------------------------ base positions

const basePos = new Float32Array(N * 3);
for (let i = 0; i < REAL; i++) {
  const v = morphToMh[i];
  basePos.set(toNorgo(mhPos[v * 3], mhPos[v * 3 + 1], mhPos[v * 3 + 2]), i * 3);
}
virtuals.forEach((vv, k) => {
  let x = 0, y = 0, z = 0;
  vv.refs.forEach((r, j) => { x += vv.w[j] * mhPos[r * 3]; y += vv.w[j] * mhPos[r * 3 + 1]; z += vv.w[j] * mhPos[r * 3 + 2]; });
  basePos.set(toNorgo(x, y, z), (REAL + k) * 3);
});

// ------------------------------------------------------------------ targets

/** Parse a .target into dense morph-space deltas (virtual vertices included). */
const scratch = new Float64Array(MH_VERTS * 3);
function loadTarget(rel: string): Float32Array {
  const text = fs.readFileSync(path.join(MH, 'targets', rel + '.target'), 'utf8');
  scratch.fill(0);
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.split(' ');
    if (p.length < 4) continue;
    const v = +p[0];
    scratch[v * 3] = +p[1]; scratch[v * 3 + 1] = +p[2]; scratch[v * 3 + 2] = +p[3];
  }
  const out = new Float32Array(N * 3);
  for (let i = 0; i < REAL; i++) {
    const v = morphToMh[i];
    out[i * 3] = -scratch[v * 3] * S;
    out[i * 3 + 1] = scratch[v * 3 + 1] * S;
    out[i * 3 + 2] = -scratch[v * 3 + 2] * S;
  }
  virtuals.forEach((vv, k) => {
    let x = 0, y = 0, z = 0;
    vv.refs.forEach((r, j) => { x += vv.w[j] * scratch[r * 3]; y += vv.w[j] * scratch[r * 3 + 1]; z += vv.w[j] * scratch[r * 3 + 2]; });
    const o = (REAL + k) * 3;
    out[o] = -x * S; out[o + 1] = y * S; out[o + 2] = -z * S;
  });
  return out;
}

// ---- macro targets
const macroNames: string[] = [];
const macroFiles: string[] = [];
const md = path.join(MH, 'targets/macrodetails');
for (const f of fs.readdirSync(md)) if (f.endsWith('.target')) { macroNames.push(f.slice(0, -7)); macroFiles.push('macrodetails/' + f.slice(0, -7)); }
for (const sub of ['height', 'proportions']) for (const f of fs.readdirSync(path.join(md, sub))) if (f.endsWith('.target')) {
  macroNames.push(f.slice(0, -7));
  macroFiles.push(`macrodetails/${sub}/${f.slice(0, -7)}`);
}
for (const f of fs.readdirSync(path.join(MH, 'targets/breast'))) if (/^(fe)?male-.*cup.*firmness\.target$/.test(f)) {
  macroNames.push(f.slice(0, -7));
  macroFiles.push('breast/' + f.slice(0, -7));
}
const macroVars = encodeMacroVars(macroNames);
log('macro targets', macroNames.length);
const D: Float32Array[] = macroFiles.map((f) => loadTarget(f));
log('macro targets loaded');

// ---- sample macro parameter space
let rs = 12345;
const rnd = () => ((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296);
function sampleParams(): MacroParams {
  const gr = rnd();
  const gender = gr < 0.35 ? rnd() * 0.15 : gr < 0.7 ? 0.85 + rnd() * 0.15 : rnd();
  const age = rnd() < 0.15 ? rnd() * 0.5 : 0.3 + rnd() * 0.7;
  const e = [-Math.log(rnd() + 1e-9), -Math.log(rnd() + 1e-9), -Math.log(rnd() + 1e-9)];
  if (rnd() < 0.3) e[Math.floor(rnd() * 3)] += 4;
  const es = e[0] + e[1] + e[2];
  return {
    gender, age, muscle: rnd(), weight: rnd(), height: rnd(), proportions: rnd(),
    african: e[0] / es, asian: e[1] / es, caucasian: e[2] / es, breastSize: rnd(), breastFirmness: rnd(),
  };
}
const TM = D.length;
const wS = new Float64Array(TM);
const mu = new Float64Array(TM);
const G = new Float64Array(TM * TM);
for (let s = 0; s < PCA_SAMPLES; s++) {
  macroTargetWeights(sampleParams(), macroVars, wS);
  for (let a = 0; a < TM; a++) {
    const wa = wS[a];
    if (wa === 0) continue;
    mu[a] += wa;
    for (let b = 0; b < TM; b++) G[a * TM + b] += wa * wS[b];
  }
}
for (let a = 0; a < TM; a++) mu[a] /= PCA_SAMPLES;
for (let a = 0; a < TM; a++) for (let b = 0; b < TM; b++) G[a * TM + b] = G[a * TM + b] / PCA_SAMPLES - mu[a] * mu[b];

const L = N * 3;
const mean = new Float64Array(L);
for (let t = 0; t < TM; t++) if (mu[t]) for (let i = 0; i < L; i++) mean[i] += mu[t] * D[t][i];

log('pca: subspace iteration, K =', PCA_COMPONENTS);
const { basis, variance } = subspacePCA(D, G, PCA_COMPONENTS, 14);
log('pca variance (first 8):', Array.from(variance.slice(0, 8)).map((v) => v.toExponential(2)).join(' '));

// Quantize: the mean and the high-variance components need int16; components
// whose coefficients stay small (σ·4 · step < 0.03 mm) are stored as int8.
const quant = (v: Float64Array | Float32Array, bits: 8 | 16 = 16) => {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  const qmax = bits === 16 ? 32767 : 127;
  const scale = m / qmax || 1e-9;
  const q = bits === 16 ? new Int16Array(v.length) : new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { q, scale, bits };
};
const K = PCA_COMPONENTS;
const qBasis = basis.map((b, k) => {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i]));
  const err8 = (m / 127) * 4 * Math.sqrt(Math.max(0, variance[k]));
  return quant(b, err8 < 3e-5 ? 8 : 16);
});
// int16 components must form a prefix (they are the high-variance ones).
let K16 = qBasis.findIndex((b) => b.bits === 8);
if (K16 < 0) K16 = K;
for (let k = K16; k < K; k++) if (qBasis[k].bits === 16) qBasis[k] = quant(basis[k], 8);
log('pca int16 components', K16, 'int8 components', K - K16);
const qMean = quant(mean);
const deqBasis = qBasis.map(({ q, scale }) => Float64Array.from(q, (x) => x * scale));
const deqMean = Float64Array.from(qMean.q, (x) => x * qMean.scale);
const proj = new Float32Array(TM * K);
for (let t = 0; t < TM; t++) for (let k = 0; k < K; k++) proj[t * K + k] = dot(D[t], deqBasis[k]);
const meanProj = deqBasis.map((b) => dot(deqMean, b));

// Evaluate reconstruction error on fresh samples (real vertices only).
let errMax = 0, errSq = 0, errN = 0, errFaceMax = 0;
{
  const exact = new Float64Array(L), approx = new Float64Array(L), c = new Float64Array(K);
  const headBone = boneIndex.get('head')!;
  for (let s = 0; s < 200; s++) {
    macroTargetWeights(sampleParams(), macroVars, wS);
    exact.fill(0);
    for (let t = 0; t < TM; t++) if (wS[t]) { const d = D[t]; for (let i = 0; i < L; i++) exact[i] += wS[t] * d[i]; }
    for (let k = 0; k < K; k++) { let a = -meanProj[k]; for (let t = 0; t < TM; t++) a += wS[t] * proj[t * K + k]; c[k] = a; }
    approx.set(deqMean);
    for (let k = 0; k < K; k++) { const b = deqBasis[k], ck = c[k]; for (let i = 0; i < L; i++) approx[i] += ck * b[i]; }
    for (let v = 0; v < REAL; v++) {
      const e = Math.hypot(exact[v * 3] - approx[v * 3], exact[v * 3 + 1] - approx[v * 3 + 1], exact[v * 3 + 2] - approx[v * 3 + 2]);
      errMax = Math.max(errMax, e);
      if (skinIdx[v * 4] === headBone) errFaceMax = Math.max(errFaceMax, e);
      errSq += e * e; errN++;
    }
  }
}
const errRms = Math.sqrt(errSq / errN);
log(`pca error: rms ${(errRms * 1000).toFixed(2)} mm, max ${(errMax * 1000).toFixed(2)} mm, head max ${(errFaceMax * 1000).toFixed(2)} mm`);

// ---- local targets
const LOCAL: string[] = [];
const lr = (names: string[]) => { for (const s of ['l', 'r']) for (const n of names) LOCAL.push(n.replace('%', s)); };
const pairs = (base: string, a: string, b: string) => [`${base}-${a}`, `${base}-${b}`];
LOCAL.push(
  ...pairs('head/head-age', 'decr', 'incr'), ...pairs('head/head-fat', 'decr', 'incr'),
  'head/head-oval', 'head/head-round', 'head/head-rectangular', 'head/head-square', 'head/head-triangular', 'head/head-invertedtriangular', 'head/head-diamond',
  ...pairs('head/head-scale-depth', 'decr', 'incr'), ...pairs('head/head-scale-horiz', 'decr', 'incr'), ...pairs('head/head-scale-vert', 'decr', 'incr'),
  ...pairs('forehead/forehead-nubian', 'decr', 'incr'), ...pairs('forehead/forehead-scale-vert', 'decr', 'incr'),
  ...pairs('forehead/forehead-trans', 'backward', 'forward'), ...pairs('forehead/forehead-temple', 'decr', 'incr'),
  ...pairs('eyebrows/eyebrows-trans', 'backward', 'forward'), ...pairs('eyebrows/eyebrows-angle', 'down', 'up'), ...pairs('eyebrows/eyebrows-trans', 'down', 'up'),
  ...pairs('nose/nose-scale-vert', 'decr', 'incr'), ...pairs('nose/nose-scale-horiz', 'decr', 'incr'), ...pairs('nose/nose-scale-depth', 'decr', 'incr'),
  ...pairs('nose/nose-hump', 'decr', 'incr'), ...pairs('nose/nose-greek', 'decr', 'incr'), ...pairs('nose/nose-point', 'down', 'up'),
  ...pairs('nose/nose-point-width', 'decr', 'incr'), ...pairs('nose/nose-nostrils-width', 'decr', 'incr'), ...pairs('nose/nose-flaring', 'decr', 'incr'),
  ...pairs('nose/nose-trans', 'backward', 'forward'), ...pairs('nose/nose-trans', 'down', 'up'), ...pairs('nose/nose-curve', 'concave', 'convex'),
  ...pairs('nose/nose-volume', 'decr', 'incr'), ...pairs('nose/nose-septumangle', 'decr', 'incr'),
  ...pairs('mouth/mouth-scale-horiz', 'decr', 'incr'), ...pairs('mouth/mouth-upperlip-volume', 'decr', 'incr'), ...pairs('mouth/mouth-lowerlip-volume', 'decr', 'incr'),
  ...pairs('mouth/mouth-angles', 'down', 'up'), ...pairs('mouth/mouth-cupidsbow', 'decr', 'incr'), ...pairs('mouth/mouth-trans', 'backward', 'forward'),
  ...pairs('mouth/mouth-laugh-lines', 'in', 'out'), ...pairs('mouth/mouth-dimples', 'in', 'out'), ...pairs('mouth/mouth-upperlip-height', 'decr', 'incr'),
  ...pairs('mouth/mouth-lowerlip-height', 'decr', 'incr'), ...pairs('mouth/mouth-scale-vert', 'decr', 'incr'),
  ...pairs('chin/chin-prominent', 'decr', 'incr'), ...pairs('chin/chin-width', 'decr', 'incr'), ...pairs('chin/chin-height', 'decr', 'incr'),
  ...pairs('chin/chin-bones', 'decr', 'incr'), ...pairs('chin/chin-prognathism', 'decr', 'incr'), 'chin/chin-cleft-incr', 'chin/chin-triangle',
  ...pairs('chin/chin-jaw-drop', 'decr', 'incr'),
  ...pairs('neck/neck-scale-horiz', 'decr', 'incr'), ...pairs('neck/neck-scale-depth', 'decr', 'incr'), ...pairs('neck/neck-scale-vert', 'decr', 'incr'), 'neck/neck-double-incr',
  ...pairs('torso/torso-vshape', 'decr', 'incr'), ...pairs('torso/torso-muscle-pectoral', 'decr', 'incr'), ...pairs('torso/torso-muscle-dorsi', 'decr', 'incr'),
  ...pairs('torso/torso-scale-horiz', 'decr', 'incr'), ...pairs('torso/torso-scale-depth', 'decr', 'incr'),
  ...pairs('hip/hip-scale-horiz', 'decr', 'incr'), ...pairs('hip/hip-waist', 'down', 'up'),
  ...pairs('stomach/stomach-pregnant', 'decr', 'incr'), ...pairs('buttocks/buttocks-volume', 'decr', 'incr'),
);
for (const m of ['shoulder-dist', 'waist-circ', 'hips-circ', 'bust-circ', 'upperarm-length', 'lowerarm-length', 'upperleg-height', 'lowerleg-height',
  'neck-circ', 'neck-height', 'upperarm-circ', 'thigh-circ', 'calf-circ', 'wrist-circ', 'ankle-circ']) LOCAL.push(...pairs(`measure/measure-${m}`, 'decr', 'incr'));
lr([
  ...pairs('eyes/%-eye-scale', 'decr', 'incr'), ...pairs('eyes/%-eye-trans', 'in', 'out'), ...pairs('eyes/%-eye-trans', 'down', 'up'),
  ...pairs('eyes/%-eye-bag', 'decr', 'incr'), ...pairs('eyes/%-eye-epicanthus', 'in', 'out'), ...pairs('eyes/%-eye-eyefold-angle', 'down', 'up'),
  ...pairs('eyes/%-eye-corner1', 'down', 'up'), ...pairs('eyes/%-eye-corner2', 'down', 'up'), ...pairs('eyes/%-eye-height2', 'decr', 'incr'),
  ...pairs('eyes/%-eye-eyefold', 'concave', 'convex'), ...pairs('eyes/%-eye-push1', 'in', 'out'),
  ...pairs('ears/%-ear-scale', 'decr', 'incr'), 'ears/%-ear-shape-pointed', 'ears/%-ear-shape-round', 'ears/%-ear-shape-square', 'ears/%-ear-shape-triangle',
  ...pairs('ears/%-ear-lobe', 'decr', 'incr'), ...pairs('ears/%-ear-wing', 'decr', 'incr'), ...pairs('ears/%-ear-rot', 'backward', 'forward'),
  ...pairs('ears/%-ear-flap', 'decr', 'incr'), ...pairs('ears/%-ear-scale-vert', 'decr', 'incr'), ...pairs('ears/%-ear-trans', 'down', 'up'),
  ...pairs('cheek/%-cheek-bones', 'decr', 'incr'), ...pairs('cheek/%-cheek-volume', 'decr', 'incr'), ...pairs('cheek/%-cheek-inner', 'decr', 'incr'),
  ...pairs('armslegs/%-hand-scale', 'decr', 'incr'), ...pairs('armslegs/%-foot-scale', 'decr', 'incr'), ...pairs('armslegs/%-hand-fingers-length', 'decr', 'incr'),
  ...pairs('armslegs/%-hand-fingers-diameter', 'decr', 'incr'), ...pairs('armslegs/%-upperarm-muscle', 'decr', 'incr'), ...pairs('armslegs/%-lowerarm-muscle', 'decr', 'incr'),
  ...pairs('armslegs/%-upperleg-muscle', 'decr', 'incr'), ...pairs('armslegs/%-lowerleg-muscle', 'decr', 'incr'),
]);
for (const b of ['man-trapezoid', 'man-invert-triangle', 'man-apple', 'man-lean-column', 'fem-full-hourglass', 'fem-triangle', 'fem-lean-column', 'fem-apple']) LOCAL.push(`bodyshapes/bodyshapes-elvs-${b}`);

// Sparse local targets. Small-amplitude targets (face) are int8, large ones
// (limb lengths, torso) int16. Many "decr" targets are the exact negation of
// their "incr" partner; those share the partner's data with a negative scale.
const localDefs: LocalTargetDef[] = [];
const pools = { 8: { idx: [] as number[], delta: [] as number[] }, 16: { idx: [] as number[], delta: [] as number[] } };
const EPS = 1e-6;
const loadedLocal = new Map<string, { d: Float32Array; def: LocalTargetDef }>();
const partnerOf = (name: string): string | null => {
  const pairsList: [string, string][] = [['decr', 'incr'], ['down', 'up'], ['in', 'out'], ['backward', 'forward'], ['concave', 'convex']];
  for (const [a, b] of pairsList) {
    if (name.endsWith('-' + a)) return name.slice(0, -a.length) + b;
    if (name.endsWith('-' + b)) return name.slice(0, -b.length) + a;
  }
  return null;
};
let aliased = 0;
for (const rel of LOCAL) {
  const d = loadTarget(rel);
  const name = rel.split('/').pop()!;
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  const partner = partnerOf(name);
  const other = partner ? loadedLocal.get(partner) : undefined;
  if (other) {
    let diff = 0;
    for (let i = 0; i < d.length; i++) diff = Math.max(diff, Math.abs(d[i] + other.d[i]));
    if (diff < m * 0.01) {
      localDefs.push({ ...other.def, name, scale: -other.def.scale });
      aliased++;
      continue;
    }
  }
  const bits: 8 | 16 = m < 0.02 ? 8 : 16;
  const scale = m / (bits === 8 ? 127 : 32767) || 1e-9;
  const pool = pools[bits];
  const start = pool.idx.length;
  for (let v = 0; v < N; v++) {
    const x = d[v * 3], y = d[v * 3 + 1], z = d[v * 3 + 2];
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < EPS) continue;
    const q = [Math.round(x / scale), Math.round(y / scale), Math.round(z / scale)];
    if (q[0] === 0 && q[1] === 0 && q[2] === 0) continue;
    pool.idx.push(v);
    pool.delta.push(...q);
  }
  const def: LocalTargetDef = { name, start, count: pool.idx.length - start, scale, bits };
  localDefs.push(def);
  loadedLocal.set(name, { d, def });
}
log('local targets', localDefs.length, `(${aliased} aliased)`, 'entries int8', pools[8].idx.length, 'int16', pools[16].idx.length);

// ---- expression units (average of the three ethnic sets)
const exprDir = path.join(MH, 'targets/expression/units');
const exprNames = fs.readdirSync(path.join(exprDir, 'caucasian')).filter((f) => f.endsWith('.target')).map((f) => f.slice(0, -7)).sort();
const exprDense: Float32Array[] = exprNames.map((n) => {
  const acc = new Float32Array(N * 3);
  for (const e of ['african', 'asian', 'caucasian']) {
    const d = loadTarget(`expression/units/${e}/${n}`);
    for (let i = 0; i < acc.length; i++) acc[i] += d[i] / 3;
  }
  return acc;
});
const faceSet: number[] = [];
for (let v = 0; v < REAL; v++) {
  let mx = 0;
  for (const d of exprDense) mx = Math.max(mx, Math.abs(d[v * 3]) + Math.abs(d[v * 3 + 1]) + Math.abs(d[v * 3 + 2]));
  if (mx > 2e-5) faceSet.push(v);
}
let exprMax = 0;
for (const d of exprDense) for (const v of faceSet) for (let k = 0; k < 3; k++) exprMax = Math.max(exprMax, Math.abs(d[v * 3 + k]));
const exprScale = exprMax / 32767;
const exprDelta = new Int16Array(exprNames.length * faceSet.length * 3);
exprDense.forEach((d, u) => faceSet.forEach((v, i) => {
  for (let k = 0; k < 3; k++) exprDelta[(u * faceSet.length + i) * 3 + k] = Math.round(d[v * 3 + k] / exprScale);
}));
log('expression units', exprNames.length, 'face verts', faceSet.length);

// ------------------------------------------------------------------ render mesh

const renderKey = new Map<number, number>();
const renderSrc: number[] = [];
const renderUV: number[] = [];
const subIdx: Record<SubMesh['name'], number[]> = { body: [], tongue: [], teeth: [], lashes: [] };
const rv = (v: number, t: number) => {
  const key = v * 65536 + t;
  let r = renderKey.get(key);
  if (r === undefined) {
    r = renderSrc.length;
    renderKey.set(key, r);
    renderSrc.push(mhToMorph[v]);
    renderUV.push(mhUV[t * 2], mhUV[t * 2 + 1]);
  }
  return r;
};
const dist2 = (a: number, b: number) => {
  const dx = mhPos[a * 3] - mhPos[b * 3], dy = mhPos[a * 3 + 1] - mhPos[b * 3 + 1], dz = mhPos[a * 3 + 2] - mhPos[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
};
// Body first so its render vertices form a prefix (LOD buffers index into it).
for (const pass of ['body', 'tongue', 'teeth', 'lashes'] as const) {
  for (const f of faces) {
    if (groupOf(f.g) !== pass) continue;
    const r = f.v.map((v, k) => rv(v, f.t[k]));
    // Winding: the 180° turn keeps handedness, so OBJ CCW stays CCW.
    if (r.length === 3) subIdx[pass].push(r[0], r[1], r[2]);
    else if (dist2(f.v[0], f.v[2]) <= dist2(f.v[1], f.v[3])) subIdx[pass].push(r[0], r[1], r[2], r[0], r[2], r[3]);
    else subIdx[pass].push(r[0], r[1], r[3], r[1], r[2], r[3]);
  }
}
const RV = renderSrc.length;
const bodyRV = Math.max(...subIdx.body) + 1;
log('render verts', RV, 'body tris', subIdx.body.length / 3);

const indexAll: number[] = [];
const submeshes: SubMesh[] = [];
for (const n of ['body', 'tongue', 'teeth', 'lashes'] as const) {
  submeshes.push({ name: n, start: indexAll.length, count: subIdx[n].length });
  indexAll.push(...subIdx[n]);
}

// ---- LODs (body only)
const rPos = new Float32Array(bodyRV * 3);
for (let r = 0; r < bodyRV; r++) rPos.set(basePos.subarray(renderSrc[r] * 3, renderSrc[r] * 3 + 3), r * 3);
const lodTris = decimate(rPos, Uint32Array.from(subIdx.body), LOD_TRIS);
const lodIndex: number[] = [];
const lods = lodTris.map((t) => {
  const start = lodIndex.length;
  lodIndex.push(...t);
  return { tris: t.length / 3, start, count: t.length };
});
log('lods', lods.map((l) => l.tris).join(', '), 'tris');

// ------------------------------------------------------------------ write

const chunks: Buffer[] = [];
let offset = 0;
const sections: Record<string, Section> = {};
function addSection(name: string, type: SectionType, data: ArrayBufferView & { length: number }) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  sections[name] = { offset, length: data.length, type };
  chunks.push(buf);
  offset += buf.length;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
}
addSection('basePos', 'f32', basePos);
addSection('renderSrc', 'u16', Uint16Array.from(renderSrc));
addSection('renderUV', 'f32', Float32Array.from(renderUV));
addSection('index', 'u16', Uint16Array.from(indexAll));
addSection('lodIndex', 'u16', Uint16Array.from(lodIndex));
addSection('skinIdx', 'u8', skinIdx);
addSection('skinW', 'u8', skinW);
addSection('pcaMean', 'i16', qMean.q);
const basis16 = new Int16Array(K16 * L);
const basis8 = new Int8Array((K - K16) * L);
qBasis.forEach(({ q }, k) => (k < K16 ? basis16.set(q, k * L) : basis8.set(q, (k - K16) * L)));
addSection('pcaBasis16', 'i16', basis16);
addSection('pcaBasis8', 'i8', basis8);
addSection('pcaProj', 'f32', proj);
addSection('localIdx8', 'u16', Uint16Array.from(pools[8].idx));
addSection('localDelta8', 'i8', Int8Array.from(pools[8].delta));
addSection('localIdx16', 'u16', Uint16Array.from(pools[16].idx));
addSection('localDelta16', 'i16', Int16Array.from(pools[16].delta));
addSection('exprVerts', 'u16', Uint16Array.from(faceSet));
addSection('exprDelta', 'i16', exprDelta);

const manifest: HumanManifest = {
  version: HUMAN_ASSET_VERSION,
  license: 'CC0 — MakeHuman 1.1 base mesh, targets, skeleton and weights by the MakeHuman team (Data Collection AB, Joel Palmius, Jonas Hauquier). See LICENSE.txt.',
  file: 'human.bin',
  bytes: offset,
  realVerts: REAL,
  virtualVerts: VIRT,
  morphVerts: N,
  renderVerts: RV,
  sections,
  submeshes,
  lods,
  bones,
  groups: {
    eyeL: groupRanges.eyeL, eyeR: groupRanges.eyeR, tongue: groupRanges.tongue, teeth: groupRanges.teeth, lashes: groupRanges.lashes,
  },
  pca: {
    components: K, int16Components: K16, targets: macroNames, vars: macroVars, scales: qBasis.map((b) => b.scale), meanScale: qMean.scale,
    meanProj, error: { rms: errRms, max: errMax },
  },
  local: localDefs,
  expressions: { names: exprNames, faceVerts: faceSet.length, scale: exprScale },
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'human.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(OUT, 'LICENSE.txt'), `Norgo human base assets
=======================

human.bin and manifest.json in this folder are derived (converted, compressed,
re-indexed) by tools/build-human-assets.ts from the MakeHuman 1.1 data assets:
the base mesh (hm08), modelling targets, macro targets, expression units, the
default skeleton and its weights.

These MakeHuman assets were explicitly released under CC0 1.0 Universal
(public domain dedication) in September 2020 by the copyright holders at the
time: Data Collection AB, Joel Palmius, Jonas Hauquier.
https://www.makehumancommunity.org — https://creativecommons.org/publicdomain/zero/1.0/

We gratefully acknowledge the MakeHuman team. The derived data is likewise
offered under CC0.
`);
log(`wrote ${(offset / 1024 / 1024).toFixed(2)} MB to ${OUT}`);
