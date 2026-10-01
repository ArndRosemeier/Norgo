/**
 * The effect library: named one-shot effects (GameEvent 'fx' names, impacts,
 * damage, deaths, terrain edits) and continuous emitters (projectile trails,
 * zone ambience, auras, weather) built from a handful of primitives:
 * particle styles, beams, ground decals, animated meshes and flash lights.
 *
 * Hot paths (per-frame emitters) write into the shared spawn scratch `P` and a
 * reusable options object — no allocation per particle or per frame.
 */
import * as THREE from 'three';
import type { DamageType } from '../../shared/types';
import { MATERIALS } from '../../world/materials';
import { P, ParticlePool } from './particles';
import { Sprite } from './sprites';
import { BeamKind, BeamPool, DecalKind, DecalPool, FlashLights, MeshFxKind, MeshFxPool } from './pools';

export type RGB = [number, number, number];

/** A particle look: everything except position/velocity. */
export interface Style {
  sprite: Sprite;
  additive: boolean;
  life: [number, number];
  size: [number, number];
  /** End size = start size × grow. */
  grow: number;
  c0: [number, number, number, number];
  c1: [number, number, number, number];
  gravity: number;
  drag: number;
  stretch?: number;
  turb?: number;
  spin?: number;
}

const S = (o: Style) => o;

/** Built-in styles. Colors are linear HDR (additive values > 1 bloom). */
export const STYLES = {
  fire: S({ sprite: Sprite.Flame, additive: true, life: [0.35, 0.8], size: [0.35, 0.7], grow: 0.25, c0: [2.2, 0.85, 0.18, 0.75], c1: [0.9, 0.12, 0.01, 0], gravity: -3.5, drag: 1.6, turb: 0.15, spin: 1 }),
  flameBig: S({ sprite: Sprite.Flame, additive: true, life: [0.5, 1.1], size: [0.9, 1.6], grow: 0.3, c0: [2.4, 0.95, 0.2, 0.6], c1: [0.9, 0.14, 0.01, 0], gravity: -4, drag: 1.2, turb: 0.3, spin: 0.6 }),
  ember: S({ sprite: Sprite.Spark, additive: true, life: [0.8, 1.8], size: [0.04, 0.09], grow: 0.4, c0: [6, 2.4, 0.5, 1], c1: [2, 0.3, 0, 0], gravity: -0.8, drag: 0.6, turb: 0.5 }),
  spark: S({ sprite: Sprite.Spark, additive: true, life: [0.2, 0.5], size: [0.04, 0.08], grow: 0.3, c0: [6, 4, 2, 1], c1: [3, 0.8, 0.1, 0], gravity: 9, drag: 1.5, stretch: 0.06 }),
  smoke: S({ sprite: Sprite.Smoke, additive: false, life: [1.4, 2.8], size: [0.6, 1.2], grow: 2.6, c0: [0.05, 0.045, 0.04, 0.6], c1: [0.16, 0.16, 0.16, 0], gravity: -0.9, drag: 1.4, turb: 0.4, spin: 0.4 }),
  dust: S({ sprite: Sprite.Smoke, additive: false, life: [0.8, 1.8], size: [0.4, 0.9], grow: 2.4, c0: [0.5, 0.45, 0.38, 0.5], c1: [0.55, 0.5, 0.45, 0], gravity: -0.15, drag: 2.2, turb: 0.2, spin: 0.3 }),
  chunk: S({ sprite: Sprite.Chunk, additive: false, life: [0.7, 1.4], size: [0.06, 0.16], grow: 0.9, c0: [0.45, 0.4, 0.35, 1], c1: [0.45, 0.4, 0.35, 0], gravity: 14, drag: 0.4, spin: 9 }),
  frost: S({ sprite: Sprite.Shard, additive: true, life: [0.4, 0.9], size: [0.08, 0.18], grow: 0.4, c0: [1.4, 2.2, 3.2, 1], c1: [0.3, 0.6, 1.2, 0], gravity: 6, drag: 1.2, spin: 6 }),
  mist: S({ sprite: Sprite.Smoke, additive: false, life: [1, 2.2], size: [0.6, 1.1], grow: 2.2, c0: [0.75, 0.88, 1, 0.35], c1: [0.85, 0.92, 1, 0], gravity: 0.3, drag: 2, turb: 0.3, spin: 0.2 }),
  snowflake: S({ sprite: Sprite.Snow, additive: false, life: [0.8, 1.6], size: [0.05, 0.1], grow: 1, c0: [1, 1, 1, 0.9], c1: [0.9, 0.95, 1, 0], gravity: 1, drag: 1.5, turb: 0.4, spin: 1.5 }),
  glow: S({ sprite: Sprite.Glow, additive: true, life: [0.3, 0.6], size: [0.3, 0.6], grow: 1.6, c0: [2, 2, 2, 1], c1: [1, 1, 1, 0], gravity: 0, drag: 2 }),
  flash: S({ sprite: Sprite.Glow, additive: true, life: [0.12, 0.22], size: [2.5, 3.5], grow: 1.5, c0: [8, 6, 4, 1], c1: [2, 1, 0.5, 0], gravity: 0, drag: 0 }),
  mote: S({ sprite: Sprite.Glow, additive: true, life: [0.8, 1.6], size: [0.05, 0.12], grow: 0.3, c0: [2, 2, 2, 1], c1: [1, 1, 1, 0], gravity: -0.8, drag: 0.8, turb: 0.35 }),
  star: S({ sprite: Sprite.Star, additive: true, life: [0.5, 1.1], size: [0.08, 0.2], grow: 0.2, c0: [3, 3, 3, 1], c1: [1, 1, 1, 0], gravity: -0.3, drag: 1.2, spin: 2, turb: 0.2 }),
  wisp: S({ sprite: Sprite.Wisp, additive: false, life: [0.8, 1.6], size: [0.4, 0.8], grow: 1.6, c0: [0.06, 0.02, 0.1, 0.75], c1: [0.15, 0.05, 0.25, 0], gravity: -0.6, drag: 1.5, turb: 0.5, spin: 1.2 }),
  shadowGlow: S({ sprite: Sprite.Glow, additive: true, life: [0.4, 0.9], size: [0.2, 0.5], grow: 1.4, c0: [0.9, 0.3, 1.8, 0.8], c1: [0.2, 0.05, 0.5, 0], gravity: -0.4, drag: 1.5, turb: 0.3 }),
  blood: S({ sprite: Sprite.Glow, additive: false, life: [0.4, 0.8], size: [0.04, 0.09], grow: 0.8, c0: [0.35, 0.01, 0.01, 1], c1: [0.2, 0.0, 0.0, 0], gravity: 12, drag: 0.6, stretch: 0.03 }),
  bloodMist: S({ sprite: Sprite.Smoke, additive: false, life: [0.3, 0.6], size: [0.15, 0.3], grow: 2.5, c0: [0.4, 0.02, 0.02, 0.45], c1: [0.3, 0.02, 0.02, 0], gravity: 1, drag: 3 }),
  leaf: S({ sprite: Sprite.Leaf, additive: false, life: [1.2, 2.4], size: [0.08, 0.16], grow: 1, c0: [0.25, 0.55, 0.12, 1], c1: [0.35, 0.5, 0.1, 0], gravity: 1.2, drag: 1.4, turb: 0.5, spin: 4 }),
  rune: S({ sprite: Sprite.Rune, additive: true, life: [0.8, 1.4], size: [0.12, 0.22], grow: 0.6, c0: [2, 2, 2, 1], c1: [1, 1, 1, 0], gravity: -0.7, drag: 1, turb: 0.15, spin: 0.5 }),
  ring: S({ sprite: Sprite.Ring, additive: true, life: [0.3, 0.45], size: [0.3, 0.3], grow: 8, c0: [2, 2, 2, 1], c1: [1, 1, 1, 0], gravity: 0, drag: 0 }),
  bubble: S({ sprite: Sprite.Hex, additive: true, life: [0.5, 1], size: [0.1, 0.2], grow: 0.8, c0: [1.2, 2.4, 0.6, 1], c1: [0.3, 0.8, 0.1, 0], gravity: -1, drag: 1, turb: 0.25 }),
  zzz: S({ sprite: Sprite.Zzz, additive: false, life: [1.6, 2.2], size: [0.18, 0.28], grow: 1.3, c0: [0.85, 0.9, 1, 0.9], c1: [0.9, 0.95, 1, 0], gravity: -0.4, drag: 0.5, turb: 0.2 }),
  heart: S({ sprite: Sprite.Heart, additive: true, life: [0.9, 1.4], size: [0.12, 0.2], grow: 0.8, c0: [2.4, 0.5, 0.9, 1], c1: [1, 0.2, 0.4, 0], gravity: -0.9, drag: 0.8 }),
  hex: S({ sprite: Sprite.Hex, additive: true, life: [0.4, 0.8], size: [0.12, 0.22], grow: 1.2, c0: [1, 1.4, 2.2, 1], c1: [0.4, 0.6, 1.2, 0], gravity: 0, drag: 2, spin: 1 }),
  shard: S({ sprite: Sprite.Shard, additive: true, life: [0.5, 0.9], size: [0.06, 0.12], grow: 0.6, c0: [2, 2, 2, 1], c1: [1, 1, 1, 0], gravity: 2, drag: 1.5, spin: 4 }),
  streak: S({ sprite: Sprite.Streak, additive: true, life: [0.15, 0.3], size: [0.03, 0.05], grow: 1, c0: [2, 2, 2, 0.8], c1: [1, 1, 1, 0], gravity: 0, drag: 0, stretch: 0.08 }),
} satisfies Record<string, Style>;

export type StyleId = keyof typeof STYLES;

/** Reusable emit options (`E`); call `opts()` to reset before filling. */
export interface EmitOpts {
  /** Random position radius around the origin. */
  spread: number;
  speed: number;
  speedVar: number;
  /** Direction bias (unit) and cone half-angle cosine-ish weight (0 = isotropic, 1 = along dir). */
  dx: number; dy: number; dz: number;
  focus: number;
  /** Extra upward speed. */
  up: number;
  /** Color multiplier (null = style colors). */
  color: ArrayLike<number> | null;
  sizeMul: number;
  lifeMul: number;
  /** Flatten the spread to a horizontal disc. */
  flat: boolean;
}

export const E: EmitOpts = { spread: 0, speed: 1, speedVar: 0.5, dx: 0, dy: 1, dz: 0, focus: 0, up: 0, color: null, sizeMul: 1, lifeMul: 1, flat: false };
export function opts(): EmitOpts {
  E.spread = 0; E.speed = 1; E.speedVar = 0.5; E.dx = 0; E.dy = 1; E.dz = 0; E.focus = 0; E.up = 0; E.color = null; E.sizeMul = 1; E.lifeMul = 1; E.flat = false;
  return E;
}

const rnd = Math.random;
const rr = (a: number, b: number) => a + (b - a) * rnd();

/** Context the library needs from the client (terrain & entity lookups). */
export interface FxHost {
  groundY(x: number, y: number, z: number): number;
  normalAt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;
  objectOf(id: number): THREE.Object3D | undefined;
  camera: THREE.Camera;
}

const MAT_COLOR = new Map<string, RGB>();
for (const m of MATERIALS) MAT_COLOR.set(m.name, [Math.pow(m.color[0], 2.2), Math.pow(m.color[1], 2.2), Math.pow(m.color[2], 2.2)]);
/** Linear color of a terrain material (by name or numeric id). */
export function materialColor(name: string | number): RGB {
  if (typeof name === 'number' || /^\d+$/.test(name)) {
    const m = MATERIALS[Number(name)] ?? MATERIALS[2];
    return MAT_COLOR.get(m.name)!;
  }
  return MAT_COLOR.get(name) ?? (name === 'wood' ? [0.18, 0.1, 0.05] : [0.2, 0.19, 0.18]);
}

const DMG_COLORS: Record<DamageType, RGB> = {
  slash: [0.35, 0.01, 0.01], pierce: [0.35, 0.01, 0.01], blunt: [0.3, 0.02, 0.02], fire: [4, 1.4, 0.2], frost: [1.2, 2, 3], shock: [1.6, 2, 4],
  force: [1.2, 1.6, 2.4], poison: [0.6, 2.2, 0.3], radiant: [4, 3.2, 1.4], shadow: [0.8, 0.25, 1.6], psychic: [2.4, 0.6, 2.2], fall: [0.4, 0.38, 0.34],
};

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const nrm = new THREE.Vector3();

export class FxLibrary {
  constructor(
    readonly add: ParticlePool,
    readonly alpha: ParticlePool,
    readonly lights: FlashLights,
    readonly beams: BeamPool,
    readonly decals: DecalPool,
    readonly meshes: MeshFxPool,
    readonly host: FxHost,
  ) {}

  // ------------------------------------------------------------------ primitives

  /** Emit `n` particles of a style. Uses the current `E` options. */
  emit(st: Style, x: number, y: number, z: number, n: number, o: EmitOpts = E) {
    const pool = st.additive ? this.add : this.alpha;
    const col = o.color;
    for (let i = 0; i < n; i++) {
      let px = 0, py = 0, pz = 0;
      if (o.spread > 0) {
        const a = rnd() * 6.2832, r = Math.sqrt(rnd()) * o.spread;
        px = Math.cos(a) * r;
        pz = Math.sin(a) * r;
        py = o.flat ? 0 : (rnd() * 2 - 1) * o.spread * 0.6;
      }
      // Random direction, biased toward (dx,dy,dz) by `focus`.
      let ux = rnd() * 2 - 1, uy = rnd() * 2 - 1, uz = rnd() * 2 - 1;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      ux = ux * (1 - o.focus) + o.dx * o.focus;
      uy = uy * (1 - o.focus) + o.dy * o.focus;
      uz = uz * (1 - o.focus) + o.dz * o.focus;
      const sp = o.speed * (1 + (rnd() * 2 - 1) * o.speedVar);
      P.x = x + px; P.y = y + py; P.z = z + pz;
      P.vx = ux * sp; P.vy = uy * sp + o.up; P.vz = uz * sp;
      P.life = rr(st.life[0], st.life[1]) * o.lifeMul;
      P.size0 = rr(st.size[0], st.size[1]) * o.sizeMul;
      P.size1 = P.size0 * st.grow;
      P.rot = rnd() * 6.2832;
      P.spin = (st.spin ?? 0) * (rnd() * 2 - 1);
      const cr = col ? col[0] : 1, cg = col ? col[1] : 1, cb = col ? col[2] : 1;
      P.r0 = st.c0[0] * cr; P.g0 = st.c0[1] * cg; P.b0 = st.c0[2] * cb; P.a0 = st.c0[3];
      P.r1 = st.c1[0] * cr; P.g1 = st.c1[1] * cg; P.b1 = st.c1[2] * cb; P.a1 = st.c1[3];
      P.sprite = st.sprite;
      P.gravity = st.gravity;
      P.drag = st.drag;
      P.stretch = st.stretch ?? 0;
      P.turb = st.turb ?? 0;
      pool.spawn(P);
    }
  }

  /** Particles on a ring (shockwaves, rising circles). */
  ring(st: Style, x: number, y: number, z: number, radius: number, n: number, outSpeed: number, up: number, color: ArrayLike<number> | null = null) {
    const o = opts();
    o.color = color;
    o.speedVar = 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.2832 + rnd() * 0.2;
      const c = Math.cos(a), s = Math.sin(a);
      o.dx = c; o.dy = 0; o.dz = s; o.focus = 1; o.speed = outSpeed * rr(0.85, 1.15); o.up = up;
      this.emit(st, x + c * radius, y, z + s * radius, 1, o);
    }
  }

  /** Particles along a segment. */
  line(st: Style, a: THREE.Vector3, b: THREE.Vector3, n: number, speed: number, color: ArrayLike<number> | null = null) {
    const o = opts();
    o.speed = speed;
    o.color = color;
    for (let i = 0; i < n; i++) {
      const t = rnd();
      this.emit(st, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, 1, o);
    }
  }

  private ground(x: number, y: number, z: number) {
    const g = this.host.groundY(x, y + 1.5, z);
    return Number.isFinite(g) ? g : y;
  }

  private groundDecal(x: number, y: number, z: number, radius: number, kind: DecalKind, color: ArrayLike<number>, life: number, alpha = 1) {
    const gy = this.ground(x, y, z);
    this.host.normalAt(x, gy - 0.2, z, nrm);
    if (nrm.y < 0.3) nrm.set(0, 1, 0);
    return this.decals.spawn(v1.set(x, gy, z), radius, kind, color, life, { normal: nrm, alpha });
  }

  // ------------------------------------------------------------------ composite effects

  explosion(x: number, y: number, z: number, radius: number, color: RGB = [1, 0.5, 0.15], big = false) {
    const k = radius / 2.5;
    let o = opts();
    o.sizeMul = 1.4 * k;
    this.emit(STYLES.flash, x, y, z, 2, o);
    o = opts();
    o.speed = 5 * k; o.speedVar = 0.6; o.sizeMul = k; o.color = color.map((c) => c / 0.5) as RGB; o.spread = 0.3 * k;
    this.emit(STYLES.flameBig, x, y, z, big ? 60 : 32, o);
    o = opts();
    o.speed = 11 * k; o.speedVar = 0.7; o.up = 3;
    this.emit(STYLES.ember, x, y, z, big ? 90 : 45, o);
    this.emit(STYLES.spark, x, y, z, big ? 50 : 25, o);
    o = opts();
    o.speed = 2.5 * k; o.spread = 0.8 * k; o.sizeMul = 1.5 * k; o.up = 1.2; o.lifeMul = big ? 1.8 : 1.2;
    this.emit(STYLES.smoke, x, y + 0.3, z, big ? 40 : 20, o);
    o = opts();
    o.speed = 8 * k; o.up = 5; o.speedVar = 0.6;
    this.emit(STYLES.chunk, x, y, z, big ? 40 : 18, o);
    this.ring(STYLES.dust, x, this.ground(x, y, z) + 0.2, z, 0.5, big ? 28 : 16, 7 * k, 0.4);
    this.groundDecal(x, y, z, radius * 1.6, DecalKind.Shockwave, [1.4, 0.6, 0.2], 0.55);
    this.lights.flash(x, y + 0.5, z, [1, 0.55, 0.2], big ? 160 : 70, radius * 6, big ? 0.9 : 0.5);
  }

  frostBurst(x: number, y: number, z: number, radius: number, nova = false) {
    let o = opts();
    o.speed = nova ? 9 : 4; o.speedVar = 0.5; o.up = 2;
    this.emit(STYLES.frost, x, y + 0.5, z, nova ? 70 : 30, o);
    o = opts();
    o.spread = radius * 0.6; o.speed = 1.2; o.flat = true; o.sizeMul = 1.4;
    this.emit(STYLES.mist, x, y + 0.4, z, nova ? 36 : 18, o);
    o = opts();
    o.spread = radius * 0.7; o.speed = 0.6; o.up = 0.5;
    this.emit(STYLES.snowflake, x, y + 0.8, z, 40, o);
    if (nova) {
      this.ring(STYLES.frost, x, y + 0.6, z, 0.4, 48, 10, 0.5);
      this.groundDecal(x, y, z, radius, DecalKind.Shockwave, [0.6, 1.2, 2], 0.7);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * 6.28 + rnd() * 0.3, d = radius * rr(0.5, 0.9);
        const gy = this.ground(x + Math.cos(a) * d, y, z + Math.sin(a) * d);
        this.meshes.spawn(MeshFxKind.Crystal, v1.set(x, y + 0.2, z), v2.set(x + Math.cos(a) * d, gy + 0.3, z + Math.sin(a) * d), rr(0.6, 1.2), 2.4);
      }
    }
    this.lights.flash(x, y + 1, z, [0.5, 0.8, 1], nova ? 40 : 15, radius * 5, 0.4);
  }

  shockwave(x: number, y: number, z: number, radius: number, color: RGB, dust = true) {
    this.groundDecal(x, y, z, radius, DecalKind.Shockwave, color, 0.6);
    const gy = this.ground(x, y, z);
    if (dust) this.ring(STYLES.dust, x, gy + 0.2, z, 0.6, Math.round(14 + radius * 4), radius * 2.2, 0.6);
    this.ring(STYLES.glow, x, gy + 0.6, z, 0.3, 24, radius * 3, 0, color);
  }

  quake(x: number, y: number, z: number, radius: number) {
    const gy = this.ground(x, y, z);
    this.ring(STYLES.dust, x, gy + 0.2, z, 0.5, 40, radius * 1.4, 0.8);
    let o = opts();
    o.spread = radius * 0.8; o.flat = true; o.speed = 3; o.up = 5; o.focus = 0.3;
    this.emit(STYLES.chunk, x, gy + 0.2, z, 40, o);
    o = opts();
    o.spread = radius * 0.8; o.flat = true; o.speed = 1; o.sizeMul = 1.8;
    this.emit(STYLES.dust, x, gy + 0.3, z, 30, o);
    this.groundDecal(x, y, z, radius, DecalKind.Shockwave, [0.6, 0.45, 0.3], 0.9, 0.7);
  }

  /** Expanding circle of rising runes in a color (casts, glyph bursts, level ups). */
  glyphBurst(x: number, y: number, z: number, radius: number, color: ArrayLike<number>, life = 1.2) {
    this.groundDecal(x, y, z, radius, DecalKind.Glyph, color, life);
    const gy = this.ground(x, y, z);
    this.ring(STYLES.rune, x, gy + 0.1, z, radius * 0.9, 12, 0, 1.2, color);
    this.ring(STYLES.mote, x, gy + 0.1, z, radius * 0.8, 24, 0.3, 1.5, color);
  }

  heal(x: number, y: number, z: number, color: ArrayLike<number> = [0.5, 1.6, 0.6], amount = 1) {
    const o = opts();
    o.spread = 0.5; o.speed = 0.4; o.up = 1.4; o.color = color;
    this.emit(STYLES.mote, x, y - 0.3, z, Math.round(10 + amount * 12), o);
    this.emit(STYLES.star, x, y, z, 4, o);
  }

  blink(x: number, y: number, z: number, color: ArrayLike<number> = [0.6, 0.3, 1]) {
    let o = opts();
    o.spread = 0.4; o.speed = 2.5; o.up = 0.5;
    this.emit(STYLES.wisp, x, y + 1, z, 22, o);
    o = opts();
    o.spread = 0.3; o.speed = 4; o.color = color;
    this.emit(STYLES.shadowGlow, x, y + 1, z, 20, o);
    this.emit(STYLES.spark, x, y + 1, z, 12, o);
    this.lights.flash(x, y + 1, z, [0.6, 0.3, 1], 25, 8, 0.3);
  }

  ping(x: number, y: number, z: number, radius: number, color: ArrayLike<number>, life: number, seeThrough = true) {
    this.decals.spawn(v1.set(x, y, z), radius, DecalKind.Shockwave, color, Math.min(2.5, life), { seeThrough, alpha: 1.2 });
    const d = this.decals.spawn(v1.set(x, y, z), radius * 0.6, DecalKind.Reticle, color, life, { seeThrough, alpha: 0.8 });
    d.fadeIn = 0.3;
    const o = opts();
    o.speed = 0.3; o.up = 1.5; o.color = color; o.spread = radius * 0.3;
    this.emit(STYLES.mote, x, y, z, 10, o);
  }

  // ------------------------------------------------------------------ named effects

  /**
   * Play a named effect (GameEvent 'fx'). Unknown names fall back to a soft
   * colored puff so nothing a server sends is ever invisible.
   */
  play(name: string, pos: ArrayLike<number>, dir?: ArrayLike<number>, radius?: number, color?: ArrayLike<number>, duration?: number, target?: number) {
    const x = pos[0], y = pos[1], z = pos[2];
    const col: RGB = color ? [color[0], color[1], color[2]] : [1, 1, 1];
    const hdr: RGB = [col[0] * 2.2, col[1] * 2.2, col[2] * 2.2];
    const R = radius ?? 2;
    const tObj = target !== undefined ? this.host.objectOf(target) : undefined;
    const d = dir ? v3.set(dir[0], dir[1], dir[2]).normalize() : v3.set(0, 1, 0);
    if (name.startsWith('hit:')) return this.projectileImpact(name.slice(4), x, y, z, d, col);
    if (name.startsWith('zone_end:')) return this.zoneEnd(name.slice(9), x, y, z, R);
    let o: EmitOpts;
    switch (name) {
      case 'cast': {
        const dur = duration ?? 0.6;
        // Keep the caster's circle modest: it sits right under the camera and bloom amplifies it.
        const castR = Math.min(R, 1.4);
        const soft: RGB = [hdr[0] * 0.4, hdr[1] * 0.4, hdr[2] * 0.4];
        const dd = this.groundDecal(x, y, z, castR, DecalKind.Glyph, soft, dur + 0.35);
        dd.fadeIn = 0.1;
        o = opts();
        o.spread = castR * 0.7; o.flat = true; o.speed = 0.2; o.up = 1.2; o.color = soft; o.lifeMul = Math.max(0.6, dur);
        this.emit(STYLES.mote, x, y + 0.1, z, Math.round(8 + dur * 14), o);
        return;
      }
      case 'launch':
        o = opts();
        o.speed = 2; o.dx = d.x; o.dy = d.y; o.dz = d.z; o.focus = 0.7; o.color = hdr;
        this.emit(STYLES.glow, x + d.x * 0.6, y + d.y * 0.6, z + d.z * 0.6, 4, o);
        return;
      case 'dash': {
        const gy = this.ground(x, y, z);
        o = opts();
        o.speed = 2; o.dx = -d.x; o.dy = 0.2; o.dz = -d.z; o.focus = 0.6; o.spread = 0.3;
        this.emit(STYLES.dust, x, gy + 0.2, z, 10, o);
        o.color = hdr;
        this.emit(STYLES.streak, x, y + 1, z, 8, o);
        return;
      }
      case 'whirl':
        this.ring(STYLES.streak, x, y + 1, z, R * 0.8, 36, 4, 0, [2.5, 2.5, 2.8]);
        this.ring(STYLES.dust, x, this.ground(x, y, z) + 0.2, z, R * 0.6, 18, 3, 0.3);
        return;
      case 'slam':
        this.shockwave(x, y, z, R * 1.4, [1, 0.8, 0.5]);
        this.quake(x, y, z, R);
        return;
      case 'quake':
        this.quake(x, y, z, R);
        return;
      case 'fissure': {
        const gy = this.ground(x, y, z);
        for (let i = 0; i < 14; i++) {
          const t = (i / 14) * R;
          const px = x + d.x * t, pz = z + d.z * t;
          const py = this.ground(px, gy, pz);
          o = opts();
          o.speed = 2.5; o.up = 4 + rnd() * 3; o.spread = 0.4;
          this.emit(STYLES.chunk, px, py + 0.1, pz, 5, o);
          o.up = 0.6; o.sizeMul = 1.4;
          this.emit(STYLES.dust, px, py + 0.2, pz, 3, o);
          if (i % 3 === 0) this.meshes.spawn(MeshFxKind.Spike, v1.set(px, py - 0.4, pz), v1, rr(0.5, 0.8), 1.4);
        }
        return;
      }
      case 'earth_spike': {
        const gy = this.ground(x, y, z);
        this.meshes.spawn(MeshFxKind.Spike, v1.set(x, gy - 0.3, z), v1, R * 0.9, 1.6);
        for (let i = 0; i < 3; i++) {
          const a = rnd() * 6.28;
          this.meshes.spawn(MeshFxKind.Spike, v1.set(x + Math.cos(a) * R * 0.7, gy - 0.4, z + Math.sin(a) * R * 0.7), v1, R * rr(0.35, 0.5), 1.4);
        }
        o = opts();
        o.speed = 4; o.up = 5; o.spread = 0.5;
        this.emit(STYLES.chunk, x, gy + 0.2, z, 24, o);
        this.ring(STYLES.dust, x, gy + 0.2, z, 0.4, 16, 3, 0.4);
        return;
      }
      case 'earth_rise': {
        const gy = this.ground(x, y, z);
        o = opts();
        o.spread = R; o.flat = true; o.speed = 1.2; o.up = 2; o.sizeMul = 1.5;
        this.emit(STYLES.dust, x, gy + 0.2, z, 24, o);
        o.up = 4;
        this.emit(STYLES.chunk, x, gy + 0.2, z, 24, o);
        return;
      }
      case 'bore': {
        for (let i = 0; i < 10; i++) {
          const t = (i / 10) * R;
          o = opts();
          o.speed = 2; o.dx = -d.x; o.dy = -d.y; o.dz = -d.z; o.focus = 0.5; o.sizeMul = 1.3;
          this.emit(STYLES.dust, x + d.x * t, y + d.y * t, z + d.z * t, 3, o);
          this.emit(STYLES.chunk, x + d.x * t, y + d.y * t, z + d.z * t, 3, o);
        }
        return;
      }
      case 'explosion_fire':
        return this.explosion(x, y, z, R, [1, 0.5, 0.15]);
      case 'explosion_big':
        this.explosion(x, y, z, R, [1, 0.45, 0.1], true);
        this.quake(x, y, z, R * 1.2);
        return;
      case 'flask_fire':
        this.explosion(x, y, z, R * 0.8, [1, 0.55, 0.15]);
        o = opts();
        o.speed = 4; o.up = 2;
        this.emit(STYLES.spark, x, y, z, 14, o);
        return;
      case 'meteor_fall': {
        const dur = duration ?? 1.2;
        const from = v1.set(x - 25, y + 70, z - 12);
        this.meshes.spawn(MeshFxKind.Rock, from, v2.set(x, y + 0.5, z), R * 0.35, dur);
        this.trailBeam(from, v2, [3, 1.2, 0.3], R * 0.5, dur);
        this.groundDecal(x, y, z, R, DecalKind.Reticle, [2, 0.6, 0.15], dur);
        return;
      }
      case 'frost_burst':
        return this.frostBurst(x, y, z, R);
      case 'frost_nova':
        return this.frostBurst(x, y, z, R, true);
      case 'shatter':
        o = opts();
        o.speed = 6; o.up = 2; o.sizeMul = 1.6;
        this.emit(STYLES.frost, x, y, z, 40, o);
        return;
      case 'ignite':
      case 'sunlance':
      case 'crush':
      case 'shadow_tendril':
      case 'grip':
      case 'pull_beam':
      case 'chain':
      case 'rope':
        return this.beamEffect(name, x, y, z, d, R, col, duration, tObj);
      case 'flash':
      case 'force_cone':
      case 'roar_cone':
        return this.coneEffect(name, x, y, z, d, R, col);
      case 'sunburst':
        o = opts();
        o.sizeMul = R * 0.6;
        this.emit(STYLES.flash, x, y + 1, z, 2, o);
        this.ring(STYLES.streak, x, y + 1, z, 0.3, 48, R * 3, 0, [4, 3.4, 1.8]);
        this.shockwave(x, y, z, R, [2, 1.6, 0.6], false);
        o = opts();
        o.spread = R * 0.6; o.speed = 1; o.up = 1; o.color = [2, 1.6, 0.8];
        this.emit(STYLES.star, x, y + 1, z, 30, o);
        this.lights.flash(x, y + 1.5, z, [1, 0.9, 0.6], 90, R * 5, 0.5);
        return;
      case 'heal':
        this.heal(x, y, z, hdr.some((c) => c !== 2.2) ? hdr : [0.5, 1.6, 0.6]);
        return;
      case 'cleanse':
        o = opts();
        o.spread = 0.6; o.speed = 0.8; o.up = 1.5; o.color = [1.4, 1.8, 2.4];
        this.emit(STYLES.bubble, x, y - 0.4, z, 16, o);
        this.emit(STYLES.star, x, y, z, 10, o);
        return;
      case 'bloom':
        o = opts();
        o.spread = R; o.flat = true; o.speed = 0.6; o.up = 1.6;
        this.emit(STYLES.leaf, x, this.ground(x, y, z) + 0.1, z, 30, o);
        o.color = [1.2, 2, 0.8];
        this.emit(STYLES.mote, x, this.ground(x, y, z) + 0.1, z, 20, o);
        return;
      case 'rally':
      case 'roar':
        this.shockwave(x, y, z, R, name === 'rally' ? [2, 1.6, 0.6] : [1.6, 0.6, 0.4], name === 'roar');
        if (name === 'rally') this.glyphBurst(x, y, z, Math.min(R, 3), [2, 1.6, 0.6]);
        return;
      case 'force_ring':
      case 'gravity_ring':
      case 'implosion': {
        const c: RGB = name === 'force_ring' ? [1, 1.4, 2.2] : [1.2, 0.6, 2.4];
        this.groundDecal(x, y, z, R, name === 'force_ring' ? DecalKind.Shockwave : DecalKind.Vortex, c, 0.8);
        this.ring(STYLES.ring, x, y + 1, z, 0.1, 1, 0, 0, c);
        this.ring(STYLES.glow, x, y + 1, z, name === 'implosion' ? R : 0.3, 30, name === 'implosion' ? -R * 2 : R * 3, 0, c);
        if (name === 'implosion') this.explosion(x, y, z, R * 0.6, [0.5, 0.25, 1]);
        return;
      }
      case 'blink_out':
      case 'blink_in':
        return this.blink(x, y, z, col);
      case 'smoke_puff':
        o = opts();
        o.spread = 0.6; o.speed = 1.5; o.sizeMul = 1.6;
        this.emit(STYLES.smoke, x, y + 0.8, z, 30, o);
        return;
      case 'pebble':
        this.groundDecal(x, y, z, 1.2, DecalKind.Shockwave, [1, 1, 1], 0.5, 0.6);
        o = opts();
        o.speed = 1.5; o.up = 2;
        this.emit(STYLES.dust, x, y + 0.1, z, 6, o);
        return;
      case 'reveal':
      case 'ore_ping':
      case 'plant_ping':
        return this.ping(x, y, z, R || 1, hdr, duration ?? 8);
      case 'track':
        return this.track(x, y, z, d, col, duration ?? 20);
      case 'mark':
        o = opts();
        o.color = [3, 0.6, 0.4];
        this.ring(STYLES.mote, x, y + 1, z, 0.6, 16, 0, 0.3, [3, 0.6, 0.4]);
        return;
      case 'levelup':
        this.glyphBurst(x, y - 1, z, 1.4, hdr, 2);
        o = opts();
        o.spread = 0.6; o.speed = 0.3; o.up = 3; o.color = hdr; o.lifeMul = 1.4;
        this.emit(STYLES.star, x, y - 1, z, 30, o);
        this.lights.flash(x, y, z, col, 20, 8, 1);
        return;
      case 'dodge':
        o = opts();
        o.spread = 0.3; o.speed = 1.2; o.color = [1.6, 1.6, 2];
        this.emit(STYLES.streak, x, y, z, 10, o);
        return;
      case 'parry':
        o = opts();
        o.speed = 6; o.speedVar = 0.6;
        this.emit(STYLES.spark, x, y, z, 30, o);
        o.sizeMul = 0.5;
        this.emit(STYLES.flash, x, y, z, 1, o);
        this.ring(STYLES.ring, x, y, z, 0.1, 1, 0, 0, [3, 2.6, 2]);
        this.lights.flash(x, y, z, [1, 0.9, 0.7], 18, 6, 0.15);
        return;
      case 'block':
        o = opts();
        o.speed = 4;
        this.emit(STYLES.spark, x, y, z, 12, o);
        return;
      case 'shield_hit':
        o = opts();
        o.speed = 1.5; o.spread = 0.4; o.color = [0.6, 1, 2];
        this.emit(STYLES.bubble, x, y, z, 12, o);
        return;
      case 'resist':
        o = opts();
        o.speed = 1; o.up = 1; o.color = [1.2, 1.2, 1.2];
        this.emit(STYLES.glow, x, y, z, 8, o);
        return;
      case 'fizzle':
        o = opts();
        o.speed = 1.5; o.up = 0.6; o.color = col;
        this.emit(STYLES.smoke, x, y, z, 10, o);
        this.emit(STYLES.spark, x, y, z, 10, o);
        return;
      case 'summon':
      case 'tame':
      case 'calm':
      case 'unsummon': {
        const c: RGB = name === 'unsummon' ? [0.8, 0.8, 0.8] : hdr;
        this.glyphBurst(x, y - 0.8, z, 1.4, c, 1.5);
        o = opts();
        o.spread = 0.8; o.speed = 1; o.up = 1;
        this.emit(STYLES.leaf, x, y, z, 16, o);
        if (name === 'tame' || name === 'calm') this.emit(STYLES.heart, x, y + 0.6, z, name === 'tame' ? 8 : 3, o);
        return;
      }
      case 'inscribe':
      case 'transmute':
      case 'glyph_burst':
        this.glyphBurst(x, y - (name === 'glyph_burst' ? 0 : 1), z, Math.max(1.2, R), hdr, 1.6);
        o = opts();
        o.spread = 0.3; o.speed = 1.5; o.color = hdr;
        this.emit(STYLES.rune, x, y, z, 12, o);
        return;
      case 'feast':
        o = opts();
        o.spread = R * 0.6; o.flat = true; o.speed = 0.4; o.up = 1; o.color = [2.4, 1.6, 0.6];
        this.emit(STYLES.mote, x, y + 0.5, z, 40, o);
        return;
      case 'wood_chips':
        o = opts();
        o.speed = 4; o.dx = d.x; o.dy = d.y + 0.4; o.dz = d.z; o.focus = 0.5;
        o.color = [0.55, 0.38, 0.22];
        this.emit(STYLES.chunk, x + d.x * 1.5, y - 0.3, z + d.z * 1.5, 18, o);
        return;
      case 'rock_burst':
        o = opts();
        o.speed = 6; o.up = 3; o.sizeMul = 2;
        this.emit(STYLES.chunk, x, y, z, 36, o);
        o.sizeMul = 1.5;
        this.emit(STYLES.dust, x, y, z, 16, o);
        return;
      case 'recall':
        this.blink(x, y, z, [0.6, 0.8, 1]);
        this.glyphBurst(x, y, z, 1.6, [1.2, 1.8, 2.4]);
        return;
      case 'firestorm':
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * 6.28;
          this.explosion(x + Math.cos(a) * R * 0.6, y, z + Math.sin(a) * R * 0.6, R * 0.4);
        }
        return;
      default:
        // Unknown names still read as "something magical happened here".
        o = opts();
        o.spread = Math.min(R, 2) * 0.5; o.speed = 1.5; o.up = 0.8; o.color = hdr;
        this.emit(STYLES.glow, x, y, z, 12, o);
        this.emit(STYLES.mote, x, y, z, 16, o);
    }
  }

  private trailBeam(from: THREE.Vector3, to: THREE.Vector3, color: RGB, width: number, life: number) {
    const b = this.beams.spawn(from, to, BeamKind.Straight, color, width, life, life);
    return b;
  }

  private beamEffect(name: string, x: number, y: number, z: number, d: THREE.Vector3, len: number, col: RGB, duration: number | undefined, tObj: THREE.Object3D | undefined) {
    const from = v1.set(x, y, z);
    const to = v2.copy(from).addScaledVector(d, len);
    let o: EmitOpts;
    switch (name) {
      case 'ignite':
        this.beams.spawn(from, to, BeamKind.Tendril, [3, 1.1, 0.2], 0.25, 0.35, 0.12);
        o = opts();
        o.speed = 2; o.up = 1;
        this.emit(STYLES.fire, to.x, to.y, to.z, 18, o);
        this.emit(STYLES.ember, to.x, to.y, to.z, 14, o);
        this.lights.flash(to.x, to.y, to.z, [1, 0.5, 0.15], 20, 6, 0.4);
        return;
      case 'sunlance':
        this.beams.spawn(from, to, BeamKind.Straight, [2.2, 1.8, 0.9], 0.28, 0.45, 0.05);
        o = opts();
        o.speed = 3; o.color = [1.6, 1.4, 0.8];
        this.emit(STYLES.star, to.x, to.y, to.z, 14, o);
        this.lights.flash(to.x, to.y, to.z, [1, 0.9, 0.6], 30, 8, 0.3);
        return;
      case 'crush':
        this.beams.spawn(from, to, BeamKind.Spiral, [1.2, 0.5, 2.4], 0.18, 0.4, 0.1);
        this.ring(STYLES.ring, to.x, to.y + 1.2, to.z, 0.1, 1, 0, -3, [1.4, 0.7, 2.6]);
        o = opts();
        o.speed = 2;
        this.emit(STYLES.dust, to.x, to.y - 0.8, to.z, 14, o);
        return;
      case 'shadow_tendril':
      case 'grip':
        this.beams.spawn(from, to, BeamKind.Tendril, name === 'grip' ? [1, 1.4, 2.4] : [0.8, 0.25, 1.6], 0.3, 0.6, 0.15);
        o = opts();
        o.speed = 1;
        this.emit(STYLES.wisp, to.x, to.y, to.z, 12, o);
        return;
      case 'pull_beam':
        this.beams.spawn(from, to, BeamKind.Spiral, [1, 1.4, 2.4], 0.4, 0.4, 0.1);
        return;
      case 'chain': {
        const b = this.beams.spawn(from, to, BeamKind.Lightning, col[0] + col[1] + col[2] > 0.1 ? [col[0] * 3, col[1] * 3, col[2] * 3] : [1.5, 2, 4], 0.12, 0.3);
        if (tObj) {
          b.toObj = tObj;
          b.toOffset = 1.1;
        }
        o = opts();
        o.speed = 4;
        o.color = [0.6, 0.8, 1.6];
        this.emit(STYLES.spark, to.x, to.y, to.z, 10, o);
        return;
      }
      case 'rope':
        this.beams.spawn(from, to, BeamKind.Rope, [0.35, 0.27, 0.16], 0.05, duration ?? 0.6, 0.15);
        return;
    }
  }

  private coneEffect(name: string, x: number, y: number, z: number, d: THREE.Vector3, range: number, col: RGB) {
    const o = opts();
    o.dx = d.x; o.dy = d.y; o.dz = d.z; o.focus = 0.78; o.speed = range * 2.2; o.speedVar = 0.3;
    if (name === 'flash') {
      o.color = [3, 2.8, 2];
      this.emit(STYLES.glow, x + d.x, y + d.y, z + d.z, 30, o);
      o.sizeMul = 0.7;
      this.emit(STYLES.flash, x + d.x, y + d.y, z + d.z, 1, o);
      this.lights.flash(x + d.x * 2, y, z + d.z * 2, [1, 0.95, 0.8], 120, range * 2, 0.25);
    } else if (name === 'force_cone') {
      o.color = [0.8, 1.1, 1.8];
      this.emit(STYLES.ring, x + d.x, y + d.y, z + d.z, 6, o);
      this.emit(STYLES.streak, x + d.x, y + d.y, z + d.z, 24, o);
    } else {
      o.color = [1.6, 0.5, 0.35];
      this.emit(STYLES.ring, x + d.x, y + d.y, z + d.z, 5, o);
      this.emit(STYLES.dust, x + d.x, y - 0.8, z + d.z, 14, o);
    }
  }

  private track(x: number, y: number, z: number, d: THREE.Vector3, col: RGB, life: number) {
    // Footprints trailing back from where the creature is.
    const hx = Math.hypot(d.x, d.z) > 0.01 ? d.x / Math.hypot(d.x, d.z) : 0, hz = Math.hypot(d.x, d.z) > 0.01 ? d.z / Math.hypot(d.x, d.z) : 1;
    const yaw = Math.atan2(hx, hz);
    for (let i = 1; i <= 8; i++) {
      const side = i % 2 ? 0.18 : -0.18;
      const px = x - hx * i * 0.8 + hz * side, pz = z - hz * i * 0.8 - hx * side;
      const gy = this.ground(px, y, pz);
      this.decals.spawn(v1.set(px, gy, pz), 0.18, DecalKind.Footprint, [col[0] * 1.5, col[1] * 1.5, col[2] * 1.5], life * (1 - i * 0.06), { yaw, alpha: 0.9 });
    }
    this.ping(x, y + 1, z, 0.6, [col[0] * 2, col[1] * 2, col[2] * 2], Math.min(life, 6));
  }

  /** Impact of a projectile that hit terrain/air (entity hits come as damage events). */
  projectileImpact(fx: string, x: number, y: number, z: number, n: THREE.Vector3, col: RGB) {
    let o = opts();
    switch (fx) {
      case 'fireball':
      case 'arrow_fire':
        return; // their on-hit explosion fx covers it
      case 'frost_bolt':
      case 'ice_lance':
        o.speed = 4; o.dx = n.x; o.dy = n.y; o.dz = n.z; o.focus = 0.5;
        this.emit(STYLES.frost, x, y, z, 20, o);
        this.emit(STYLES.mist, x, y, z, 6, o);
        return;
      case 'shadow_bolt':
        o.speed = 2;
        this.emit(STYLES.wisp, x, y, z, 12, o);
        o.color = [1, 0.4, 2];
        this.emit(STYLES.shadowGlow, x, y, z, 10, o);
        return;
      case 'boulder':
      case 'stone':
        o.speed = 4; o.up = 2; o.sizeMul = fx === 'boulder' ? 2 : 1;
        this.emit(STYLES.chunk, x, y, z, fx === 'boulder' ? 30 : 8, o);
        this.emit(STYLES.dust, x, y, z, fx === 'boulder' ? 14 : 4, o);
        return;
      case 'flask':
      case 'flask_green':
        o.speed = 3; o.up = 1.5; o.color = fx === 'flask_green' ? [0.6, 2, 0.4] : [1.6, 1.6, 1.8];
        this.emit(STYLES.frost, x, y, z, 14, o);
        return;
      default:
        // Arrows, knives, discs: a puff of dust and a few sparks.
        o.speed = 2; o.dx = n.x; o.dy = n.y; o.dz = n.z; o.focus = 0.6;
        this.emit(STYLES.dust, x, y, z, 5, o);
        o = opts();
        o.speed = 4; o.dx = n.x; o.dy = n.y; o.dz = n.z; o.focus = 0.5;
        this.emit(STYLES.spark, x, y, z, 5, o);
    }
  }

  private zoneEnd(kind: string, x: number, y: number, z: number, r: number) {
    const o = opts();
    o.spread = r * 0.7; o.flat = true; o.speed = 0.6; o.up = 0.8;
    switch (kind) {
      case 'flame_wall':
      case 'inferno':
      case 'campfire':
        this.emit(STYLES.smoke, x, y + 0.3, z, 20, o);
        this.emit(STYLES.ember, x, y + 0.3, z, 20, o);
        return;
      case 'blizzard':
        this.emit(STYLES.mist, x, y + 0.5, z, 20, o);
        return;
      case 'light_orb':
        o.color = [2, 1.8, 1.4];
        this.emit(STYLES.star, x, y, z, 12, o);
        return;
      default:
        o.color = [1.2, 1.2, 1.2];
        this.emit(STYLES.mote, x, y + 0.2, z, 14, o);
    }
  }

  // ------------------------------------------------------------------ combat feedback

  damage(x: number, y: number, z: number, amount: number, type: DamageType, crit: boolean, fromDir: THREE.Vector3 | null, creature: boolean, ichor: RGB | null) {
    const k = Math.min(2.5, 0.5 + amount / 20) * (crit ? 1.5 : 1);
    let o = opts();
    switch (type) {
      case 'slash':
      case 'pierce':
      case 'blunt': {
        if (fromDir) {
          o.dx = fromDir.x; o.dy = fromDir.y + 0.3; o.dz = fromDir.z; o.focus = 0.6;
        }
        o.speed = 3 * k; o.up = 1;
        o.color = creature && ichor ? [ichor[0] / 0.35, ichor[1] / 0.35, ichor[2] / 0.35] : null;
        this.emit(STYLES.blood, x, y, z, Math.round(8 * k), o);
        this.emit(STYLES.bloodMist, x, y, z, Math.round(2 * k), o);
        if (type === 'blunt') {
          o.color = null;
          this.emit(STYLES.dust, x, y, z, 3, o);
        }
        break;
      }
      case 'fire':
        o.speed = 2; o.up = 1;
        this.emit(STYLES.fire, x, y, z, Math.round(6 * k), o);
        this.emit(STYLES.ember, x, y, z, Math.round(6 * k), o);
        break;
      case 'frost':
        o.speed = 3;
        this.emit(STYLES.frost, x, y, z, Math.round(10 * k), o);
        break;
      case 'shock':
        o.speed = 5;
        o.color = [0.5, 0.7, 1.4];
        this.emit(STYLES.spark, x, y, z, Math.round(12 * k), o);
        break;
      case 'poison':
        o.speed = 1; o.up = 0.6;
        this.emit(STYLES.bubble, x, y, z, Math.round(5 * k), o);
        break;
      case 'radiant':
        o.speed = 2; o.color = [1.4, 1.2, 0.6];
        this.emit(STYLES.star, x, y, z, Math.round(8 * k), o);
        break;
      case 'shadow':
        o.speed = 1.5;
        this.emit(STYLES.wisp, x, y, z, Math.round(5 * k), o);
        break;
      case 'force':
      case 'psychic':
        o.color = DMG_COLORS[type];
        this.emit(STYLES.ring, x, y, z, 1, o);
        o.speed = 2;
        this.emit(STYLES.glow, x, y, z, Math.round(5 * k), o);
        break;
      case 'fall':
        o.speed = 2; o.spread = 0.3; o.flat = true;
        this.emit(STYLES.dust, x, y - 0.8, z, Math.round(8 * k), o);
        break;
    }
    if (crit) {
      o = opts();
      o.speed = 5;
      this.emit(STYLES.spark, x, y, z, 14, o);
      o.sizeMul = 0.35;
      this.emit(STYLES.flash, x, y, z, 1, o);
    }
  }

  death(x: number, y: number, z: number, creature: boolean) {
    let o = opts();
    o.spread = 0.6; o.flat = true; o.speed = 1; o.sizeMul = 1.4;
    this.emit(STYLES.dust, x, y + 0.1, z, 14, o);
    o = opts();
    o.spread = 0.4; o.speed = 0.4; o.up = 1.2; o.color = creature ? [1, 1.1, 1] : [1.2, 1.2, 1.6];
    this.emit(STYLES.mote, x, y + 0.8, z, 16, o);
  }

  /** Terrain hit by a tool, weapon or projectile. `force` 0..1. */
  impact(x: number, y: number, z: number, n: ArrayLike<number>, material: string, force: number) {
    const c = materialColor(material);
    let o = opts();
    o.dx = n[0]; o.dy = n[1]; o.dz = n[2]; o.focus = 0.55; o.speed = 2 + force * 4; o.color = [c[0] / 0.45, c[1] / 0.4, c[2] / 0.35];
    this.emit(STYLES.chunk, x, y, z, Math.round(4 + force * 10), o);
    o.color = [c[0] / 0.5 + 0.1, c[1] / 0.45 + 0.1, c[2] / 0.38 + 0.1];
    o.speed = 1 + force;
    this.emit(STYLES.dust, x, y, z, Math.round(2 + force * 6), o);
    const hard = /stone|basalt|granite|marble|ore|obsidian|crystal|cobble|limestone|ice|metal|bedrock|sandstone/.test(material);
    if (hard && force > 0.35) {
      o = opts();
      o.dx = n[0]; o.dy = n[1]; o.dz = n[2]; o.focus = 0.5; o.speed = 5;
      this.emit(STYLES.spark, x, y, z, Math.round(force * 10), o);
    }
    if (/crystal|gem/.test(material)) {
      o = opts();
      o.speed = 2; o.color = [1.2, 0.8, 2];
      this.emit(STYLES.star, x, y, z, 6, o);
    }
  }

  /** Dust & debris for a replicated terrain edit. */
  terrainEdit(op: string, x: number, y: number, z: number, radius: number, strength: number, materialName: string) {
    const c = materialColor(materialName);
    const k = Math.min(2, radius * strength * 1.5 + 0.3);
    let o = opts();
    if (op === 'dig') {
      o.spread = radius * 0.6; o.speed = 2.5 * k; o.up = 2.5; o.color = [c[0] / 0.45, c[1] / 0.4, c[2] / 0.35];
      this.emit(STYLES.chunk, x, y + radius * 0.3, z, Math.round(10 * k), o);
      o = opts();
      o.spread = radius * 0.5; o.speed = 1.2 * k; o.up = 0.6; o.sizeMul = 1 + radius * 0.4; o.color = [c[0] / 0.5 + 0.08, c[1] / 0.45 + 0.08, c[2] / 0.38 + 0.08];
      this.emit(STYLES.dust, x, y + radius * 0.4, z, Math.round(8 * k), o);
    } else if (op === 'fill') {
      const ice = /ice/.test(materialName);
      o.spread = radius; o.speed = 0.8; o.up = 1.5; o.sizeMul = 1.3; o.flat = true;
      o.color = ice ? [1.4, 1.6, 1.8] : [c[0] / 0.5 + 0.1, c[1] / 0.45 + 0.1, c[2] / 0.38 + 0.1];
      this.emit(ice ? STYLES.mist : STYLES.dust, x, y - radius * 0.5, z, Math.round(6 * k), o);
      if (ice) {
        o = opts();
        o.spread = radius; o.speed = 1;
        this.emit(STYLES.frost, x, y, z, 6, o);
      } else {
        o = opts();
        o.spread = radius; o.speed = 1; o.up = 3; o.color = [c[0] / 0.45, c[1] / 0.4, c[2] / 0.35];
        this.emit(STYLES.chunk, x, y + radius * 0.5, z, 6, o);
      }
    }
  }

  update(dt: number, time: number, cam: THREE.Vector3) {
    this.add.update(dt);
    this.alpha.update(dt);
    this.lights.update(dt, cam);
    this.beams.update(dt, cam, time);
    this.decals.update(dt, time);
    this.meshes.update(dt, time);
  }
}

export { DMG_COLORS };
