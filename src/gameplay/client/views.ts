/**
 * Entity views owned by the FX module:
 *  - ProjectileView ('projectile' entities): a physical mesh (arrow, knife,
 *    axe, stone, boulder, flask, bolas, disc, javelin) and/or a glowing core,
 *    oriented along velocity, with continuous trails emitted along the path
 *    travelled each frame (no gaps at high speed).
 *  - ZoneView ('effect' entities with `zone:<kind>`): persistent area spells
 *    — fire walls, blizzards, gravity wells, sanctuaries, light orbs,
 *    campfires, rune traps, darkness, smoke, decoys...
 * Entity lights (`snap.light`) are rendered by the core's LightManager.
 */
import * as THREE from 'three';
import type { EntityView } from '../../client/context';
import type { EntitySnapshot } from '../../shared/protocol';
import { EntFlag } from '../../shared/types';
import { patchSkyOcclusion } from '../../render/skyOcclusion';
import { glowTexture } from './sprites';
import { DecalKind, type Decal, MeshFxKind } from './pools';
import { FxLibrary, opts, STYLES, type Style } from './fxLibrary';

// ------------------------------------------------------------------ shared assets

/** Sky-visibility uniforms of all lit fx materials (caves darken them). */
const SKY: { value: number }[] = [];
const MATS = new Map<string, THREE.Material>();
const GEOS = new Map<string, THREE.BufferGeometry>();
const SPRITE_MATS = new Map<string, THREE.SpriteMaterial>();

function litMat(key: string, color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.Material {
  let m = MATS.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...o });
    const p = patchSkyOcclusion(m, 'uniform');
    // Fx meshes are small and short-lived: they share the camera's sky visibility.
    if (p.uniform) SKY.push(p.uniform);
    MATS.set(key, m);
  }
  return m;
}

/** Shared sky visibility for fx meshes (called by FxSystem from the camera). */
export function setFxSkyVis(v: number) {
  for (const u of SKY) u.value = v;
}

function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = GEOS.get(key);
  if (!g) GEOS.set(key, (g = make()));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Tiny manual merge (non-indexed) to avoid pulling in BufferGeometryUtils.
  const geos = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let n = 0;
  for (const g of geos) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/** Projectile meshes are modelled pointing along −Z (forward). */
function projectileMesh(kind: string): THREE.Object3D | null {
  switch (kind) {
    case 'arrow':
    case 'arrow_power':
    case 'arrow_fire':
    case 'rope_arrow': {
      const g = geo('arrow', () => {
        const shaft = new THREE.CylinderGeometry(0.012, 0.012, 0.8, 5).rotateX(Math.PI / 2);
        const head = new THREE.ConeGeometry(0.03, 0.09, 4).rotateX(-Math.PI / 2).translate(0, 0, -0.44);
        const f1 = new THREE.PlaneGeometry(0.12, 0.05).rotateY(Math.PI / 2).translate(0, 0.02, 0.34);
        const f2 = new THREE.PlaneGeometry(0.12, 0.05).rotateY(Math.PI / 2).rotateZ(Math.PI / 2).translate(-0.02, 0, 0.34);
        return merge([shaft, head, f1, f2]);
      });
      return new THREE.Mesh(g, litMat('arrow', 0x8a6a45, { side: THREE.DoubleSide }));
    }
    case 'knife':
      return new THREE.Mesh(geo('knife', () => merge([new THREE.BoxGeometry(0.03, 0.008, 0.2).translate(0, 0, -0.08), new THREE.BoxGeometry(0.025, 0.02, 0.09).translate(0, 0, 0.07)])), litMat('steel', 0xc8ccd2, { metalness: 0.9, roughness: 0.3 }));
    case 'axe':
      return new THREE.Mesh(geo('axe', () => merge([new THREE.CylinderGeometry(0.018, 0.02, 0.45, 6).rotateX(Math.PI / 2), new THREE.BoxGeometry(0.02, 0.16, 0.12).translate(0, 0.07, -0.2)])), litMat('steel', 0xc8ccd2, { metalness: 0.9, roughness: 0.3 }));
    case 'javelin':
      return new THREE.Mesh(geo('javelin', () => merge([new THREE.CylinderGeometry(0.015, 0.015, 1.6, 6).rotateX(Math.PI / 2), new THREE.ConeGeometry(0.035, 0.18, 5).rotateX(-Math.PI / 2).translate(0, 0, -0.88)])), litMat('wood', 0x7a5a38));
    case 'stone':
      return new THREE.Mesh(geo('stone', () => new THREE.IcosahedronGeometry(0.08, 0)), litMat('stone', 0x777168, { flatShading: true }));
    case 'boulder':
      return new THREE.Mesh(geo('boulder', () => new THREE.IcosahedronGeometry(0.45, 1)), litMat('boulder', 0x6e6052, { flatShading: true, roughness: 0.95 }));
    case 'flask':
    case 'flask_green':
      return new THREE.Mesh(
        geo('flask', () => merge([new THREE.SphereGeometry(0.08, 10, 8), new THREE.CylinderGeometry(0.025, 0.03, 0.08, 8).translate(0, 0.09, 0)])),
        litMat(kind, kind === 'flask' ? 0xff6a20 : 0x60ff40, { roughness: 0.1, transparent: true, opacity: 0.85, emissive: kind === 'flask' ? 0x802000 : 0x208010, emissiveIntensity: 1.5 }),
      );
    case 'bolas':
      return new THREE.Mesh(geo('bolas', () => merge([new THREE.SphereGeometry(0.05, 8, 6).translate(0.25, 0, 0), new THREE.SphereGeometry(0.05, 8, 6).translate(-0.25, 0, 0), new THREE.CylinderGeometry(0.006, 0.006, 0.5, 4).rotateZ(Math.PI / 2)])), litMat('bolas', 0x5a4a3a));
    case 'disc':
      return new THREE.Mesh(geo('disc', () => new THREE.CylinderGeometry(0.16, 0.16, 0.02, 16)), litMat('steel', 0xc8ccd2, { metalness: 0.9, roughness: 0.3 }));
    case 'ice_lance':
      return new THREE.Mesh(geo('ice_lance', () => new THREE.ConeGeometry(0.07, 1.4, 6).rotateX(-Math.PI / 2)), litMat('ice', 0xbfe8ff, { roughness: 0.05, transparent: true, opacity: 0.8, emissive: 0x3070a0, emissiveIntensity: 1 }));
  }
  return null;
}

function coreSprite(color: number, size: number): THREE.Sprite {
  const key = color.toString(16);
  let m = SPRITE_MATS.get(key);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(color).multiplyScalar(3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true });
    SPRITE_MATS.set(key, m);
  }
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

/** Trail definition per projectile fx id. */
interface ProjLook {
  core?: { color: number; size: number };
  spin?: number;
  trails: { style: Style; rate: number; speed?: number; color?: [number, number, number]; sizeMul?: number; up?: number }[];
}

const LOOKS: Record<string, ProjLook> = {
  fireball: { core: { color: 0xff7a20, size: 1.1 }, trails: [{ style: STYLES.fire, rate: 90, speed: 0.6, sizeMul: 1.1 }, { style: STYLES.ember, rate: 40, speed: 1 }, { style: STYLES.smoke, rate: 18, speed: 0.3, sizeMul: 0.8 }] },
  frost_bolt: { core: { color: 0x80c8ff, size: 0.7 }, trails: [{ style: STYLES.frost, rate: 40, speed: 0.6 }, { style: STYLES.mist, rate: 14, speed: 0.2, sizeMul: 0.5 }] },
  ice_lance: { core: { color: 0x80c8ff, size: 0.6 }, trails: [{ style: STYLES.frost, rate: 50, speed: 0.4 }, { style: STYLES.snowflake, rate: 20, speed: 0.4 }] },
  shadow_bolt: { core: { color: 0x9040ff, size: 0.8 }, trails: [{ style: STYLES.wisp, rate: 30, speed: 0.3, sizeMul: 0.6 }, { style: STYLES.shadowGlow, rate: 40, speed: 0.4 }] },
  arrow: { trails: [{ style: STYLES.streak, rate: 25, color: [0.6, 0.6, 0.6] }] },
  arrow_power: { trails: [{ style: STYLES.streak, rate: 60, color: [1.5, 1.4, 1.1] }, { style: STYLES.glow, rate: 20, color: [0.6, 0.55, 0.4] }] },
  arrow_fire: { core: { color: 0xff7a20, size: 0.4 }, trails: [{ style: STYLES.fire, rate: 50, sizeMul: 0.5 }, { style: STYLES.ember, rate: 20 }] },
  rope_arrow: { trails: [{ style: STYLES.streak, rate: 25, color: [0.6, 0.5, 0.3] }] },
  knife: { spin: 25, trails: [{ style: STYLES.streak, rate: 20, color: [0.8, 0.8, 0.9] }] },
  axe: { spin: 18, trails: [{ style: STYLES.streak, rate: 20, color: [0.8, 0.8, 0.9] }] },
  javelin: { trails: [{ style: STYLES.streak, rate: 25, color: [0.7, 0.7, 0.7] }] },
  stone: { spin: 10, trails: [] },
  boulder: { spin: 4, trails: [{ style: STYLES.dust, rate: 25, speed: 0.4 }, { style: STYLES.chunk, rate: 10, speed: 0.5 }] },
  flask: { spin: 8, trails: [{ style: STYLES.ember, rate: 15, speed: 0.3 }] },
  flask_green: { spin: 8, trails: [{ style: STYLES.bubble, rate: 12, speed: 0.3 }] },
  bolas: { spin: 22, trails: [] },
  disc: { spin: 30, trails: [{ style: STYLES.streak, rate: 30, color: [1, 1, 1.2] }] },
};

const tv = new THREE.Vector3();
const tq = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, -1);

export class ProjectileView implements EntityView {
  readonly object = new THREE.Group();
  headHeight = 0.2;
  radius = 0.2;
  private look: ProjLook;
  private body: THREE.Object3D | null;
  private acc: number[];
  private last = new THREE.Vector3();
  private hasLast = false;
  private spinAngle = 0;
  private core: THREE.Sprite | null = null;

  constructor(snap: EntitySnapshot, private lib: FxLibrary) {
    const fx = snap.projectile?.fx ?? 'arrow';
    this.look = LOOKS[fx] ?? { core: { color: 0xffffff, size: 0.6 }, trails: [{ style: STYLES.mote, rate: 30 }] };
    this.body = projectileMesh(fx);
    if (this.body) {
      this.body.castShadow = fx === 'boulder';
      this.object.add(this.body);
    }
    if (this.look.core) {
      this.core = coreSprite(this.look.core.color, this.look.core.size);
      this.object.add(this.core);
    }
    this.acc = this.look.trails.map(() => 0);
    this.object.name = 'projectile:' + fx;
    this.object.position.set(snap.pos[0], snap.pos[1], snap.pos[2]);
  }

  update(snap: EntitySnapshot, dt: number, time: number) {
    const p = this.object.position;
    p.set(snap.pos[0], snap.pos[1], snap.pos[2]);
    const v = snap.vel;
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp > 0.1 && this.body) {
      tv.set(v[0] / sp, v[1] / sp, v[2] / sp);
      this.body.quaternion.setFromUnitVectors(FWD, tv);
      if (this.look.spin) {
        this.spinAngle += dt * this.look.spin;
        tq.setFromAxisAngle(tv.set(1, 0, 0), this.spinAngle);
        this.body.quaternion.multiply(tq);
      }
    }
    if (this.core) this.core.scale.setScalar(this.look.core!.size * (0.9 + 0.15 * Math.sin(time * 30)));
    // Trails: distribute this frame's particles along the travelled segment.
    if (!this.hasLast) {
      this.last.copy(p);
      this.hasLast = true;
    }
    for (let i = 0; i < this.look.trails.length; i++) {
      const t = this.look.trails[i];
      this.acc[i] += dt * t.rate;
      const n = Math.floor(this.acc[i]);
      if (!n) continue;
      this.acc[i] -= n;
      const o = opts();
      o.speed = t.speed ?? 0.2;
      o.color = t.color ?? null;
      o.sizeMul = t.sizeMul ?? 1;
      o.up = t.up ?? 0;
      for (let k = 0; k < n; k++) {
        const f = (k + Math.random()) / n;
        this.lib.emit(t.style, this.last.x + (p.x - this.last.x) * f, this.last.y + (p.y - this.last.y) * f, this.last.z + (p.z - this.last.z) * f, 1, o);
      }
    }
    this.last.copy(p);
  }

  dispose() {
    this.object.removeFromParent();
  }
}

// ------------------------------------------------------------------ zones

/** Parse "key:value" fx tags (zone radius, length, duration). */
function tagNum(tags: string[] | undefined, key: string, fallback: number): number {
  if (!tags) return fallback;
  for (const t of tags) if (t.startsWith(key + ':')) return Number(t.slice(key.length + 1)) || fallback;
  return fallback;
}

const ZONE_COLORS: Record<string, [number, number, number]> = {
  flame_wall: [2.2, 0.8, 0.15], inferno: [2.2, 0.7, 0.12], blizzard: [0.8, 1.3, 2], gravity_well: [1.1, 0.55, 2.2], singularity: [1.2, 0.5, 2.4],
  roots: [0.5, 1.4, 0.3], sanctuary: [0.6, 1.8, 0.7], light_orb: [2, 1.8, 1.4], dawn: [2.2, 1.7, 0.9], night: [0.4, 0.15, 0.7], smoke: [0.6, 0.6, 0.6],
  toxic: [0.6, 1.8, 0.3], ward: [0.4, 1.8, 1.5], glyph: [0.5, 2, 1.7], trap_fire: [1.8, 0.6, 0.2], trap_bind: [0.5, 1.6, 1.4], campfire: [2, 1, 0.3], decoy: [0.6, 0.3, 1.2],
};

export class ZoneView implements EntityView {
  readonly object = new THREE.Group();
  headHeight = 1;
  radius: number;
  readonly kind: string;
  private len: number;
  private decals: Decal[] = [];
  private acc = new Float32Array(6);
  /** Ground heights sampled along the zone (walls) or at its centre. */
  private groundYs: number[] = [];
  private along = new THREE.Vector3();
  private t = 0;
  private dark: THREE.Mesh | null = null;
  private placed = false;

  constructor(snap: EntitySnapshot, private lib: FxLibrary, private localPlayer: () => number) {
    this.kind = (snap.projectile?.fx ?? snap.fx?.find((t) => t.startsWith('zone:')) ?? 'zone:unknown').replace('zone:', '');
    this.radius = tagNum(snap.fx, 'r', 2);
    this.len = tagNum(snap.fx, 'len', 0);
    this.object.name = 'zone:' + this.kind;
    this.object.position.set(snap.pos[0], snap.pos[1], snap.pos[2]);
    this.build(snap);
  }

  private color() {
    return ZONE_COLORS[this.kind] ?? [1.2, 1.2, 1.2];
  }

  private build(snap: EntitySnapshot) {
    const lib = this.lib;
    const p = this.object.position;
    this.along.set(-Math.sin(snap.yaw), 0, -Math.cos(snap.yaw));
    const samples = this.len > 0 ? 12 : 1;
    for (let i = 0; i < samples; i++) {
      const s = samples > 1 ? -this.len / 2 + (i / (samples - 1)) * this.len : 0;
      const g = lib.host.groundY(p.x + this.along.x * s, p.y + 2, p.z + this.along.z * s);
      this.groundYs.push(Number.isFinite(g) ? g : p.y);
    }
    const c = this.color();
    const mine = snap.projectile?.owner === this.localPlayer();
    const disc = (kind: DecalKind, r: number, alpha: number) => {
      const d = lib.decals.spawn(tv.set(p.x, this.groundYs[0], p.z), r, kind, c, 1e9, { persistent: true, alpha });
      this.decals.push(d);
    };
    switch (this.kind) {
      case 'gravity_well':
      case 'singularity':
        disc(DecalKind.Vortex, this.radius, 0.55);
        if (this.kind === 'singularity') {
          this.dark = new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 16), new THREE.MeshBasicMaterial({ color: 0x000000 }));
          this.dark.position.y = 1.4;
          this.object.add(this.dark);
          this.object.add(coreSprite(0x8040ff, 3.2));
          this.object.children[this.object.children.length - 1].position.y = 1.4;
        }
        break;
      case 'roots':
      case 'sanctuary':
      case 'dawn':
        disc(DecalKind.Disc, this.radius, this.kind === 'roots' ? 0.5 : 0.7);
        if (this.kind !== 'roots') disc(DecalKind.Glyph, this.radius * 0.9, 0.5);
        break;
      case 'ward':
      case 'glyph':
        disc(DecalKind.Glyph, this.radius, 0.9);
        disc(DecalKind.Disc, this.radius, 0.3);
        break;
      case 'trap_fire':
      case 'trap_bind':
        // Hidden traps: only their owner sees a faint glyph.
        if (mine) disc(DecalKind.Glyph, this.radius, 0.45);
        break;
      case 'light_orb':
        this.object.add(coreSprite(0xfff0d0, 0.9));
        break;
      case 'campfire': {
        const logGeo = geo('log', () => new THREE.CylinderGeometry(0.07, 0.08, 0.8, 7).rotateZ(Math.PI / 2));
        const mat = litMat('log', 0x3b2a1b, { roughness: 0.95 });
        for (let i = 0; i < 4; i++) {
          const m = new THREE.Mesh(logGeo, mat);
          m.rotation.y = (i / 4) * Math.PI;
          m.rotation.z = 0.25;
          m.position.y = 0.12;
          m.castShadow = true;
          this.object.add(m);
        }
        const stones = geo('ringstone', () => new THREE.IcosahedronGeometry(0.11, 0));
        const smat = litMat('stone', 0x777168, { flatShading: true });
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2;
          const m = new THREE.Mesh(stones, smat);
          m.position.set(Math.cos(a) * 0.55, 0.05, Math.sin(a) * 0.55);
          m.rotation.set(a, a * 2, 0);
          this.object.add(m);
        }
        break;
      }
      case 'decoy': {
        const m = new THREE.Mesh(
          geo('decoy', () => new THREE.CapsuleGeometry(0.3, 1.1, 6, 12).translate(0, 0.85, 0)),
          new THREE.MeshBasicMaterial({ color: 0x14081f, transparent: true, opacity: 0.75, depthWrite: false }),
        );
        this.dark = m;
        this.object.add(m);
        break;
      }
      case 'flame_wall':
      case 'inferno':
      case 'blizzard':
      case 'night':
      case 'smoke':
      case 'toxic':
        break;
      default:
        disc(DecalKind.Disc, this.radius, 0.5);
    }
    const hidden = (snap.flags & EntFlag.Invisible) !== 0 && !mine;
    this.object.visible = !hidden;
  }

  /** Random point on the zone floor (wall segment or disc). */
  private floor(out: THREE.Vector3, inner = 1): THREE.Vector3 {
    const p = this.object.position;
    if (this.len > 0) {
      const f = Math.random();
      const i = Math.min(this.groundYs.length - 1, Math.round(f * (this.groundYs.length - 1)));
      const s = -this.len / 2 + f * this.len;
      const side = (Math.random() * 2 - 1) * this.radius * 0.6;
      return out.set(p.x + this.along.x * s - this.along.z * side, this.groundYs[i], p.z + this.along.z * s + this.along.x * side);
    }
    const a = Math.random() * 6.2832, r = Math.sqrt(Math.random()) * this.radius * inner;
    return out.set(p.x + Math.cos(a) * r, this.groundYs[0], p.z + Math.sin(a) * r);
  }

  /** Rate-limited emission helper: returns how many particles to emit now for channel `i`. */
  private due(i: number, rate: number, dt: number) {
    this.acc[i] += rate * dt;
    const n = Math.floor(this.acc[i]);
    this.acc[i] -= n;
    return n;
  }

  update(snap: EntitySnapshot, dt: number, time: number) {
    const lib = this.lib;
    const pos = this.object.position;
    pos.set(snap.pos[0], snap.pos[1], snap.pos[2]);
    this.t += dt;
    const follow = this.kind === 'inferno' || this.kind === 'light_orb';
    if (follow) this.groundYs[0] = pos.y;
    if (!this.placed) {
      this.placed = true;
      if (this.kind === 'flame_wall') lib.shockwave(pos.x, this.groundYs[0], pos.z, this.len / 2 + 1, [2, 0.8, 0.2], false);
    }
    for (const d of this.decals) d.mesh.position.set(pos.x, this.groundYs[0] + 0.06, pos.z);
    if (!this.object.visible) return;
    const area = Math.PI * this.radius * this.radius + this.len * this.radius * 2;
    const c = this.color();
    let o;
    switch (this.kind) {
      case 'flame_wall':
      case 'inferno': {
        const n = this.due(0, Math.min(150, area * 7), dt);
        o = opts();
        o.speed = 0.5; o.up = 1.5; o.sizeMul = this.kind === 'inferno' ? 1.1 : 1.3;
        for (let i = 0; i < n; i++) {
          if (this.kind === 'inferno') {
            const a = Math.random() * 6.28, r = this.radius * (0.4 + Math.random() * 0.6);
            lib.emit(STYLES.flameBig, pos.x + Math.cos(a) * r, pos.y + 0.2, pos.z + Math.sin(a) * r, 1, o);
          } else {
            this.floor(tv);
            lib.emit(STYLES.flameBig, tv.x, tv.y + 0.15, tv.z, 1, o);
          }
        }
        o = opts();
        o.speed = 0.6; o.up = 2;
        for (let i = this.due(1, area * 4, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.ember, tv.x, tv.y + 0.6, tv.z, 1, o);
        }
        o = opts();
        o.speed = 0.3; o.up = 1.6; o.sizeMul = 1.4;
        for (let i = this.due(2, area * 1.2, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.smoke, tv.x, tv.y + 1.8, tv.z, 1, o);
        }
        break;
      }
      case 'blizzard': {
        o = opts();
        o.speed = 1.5; o.dx = 0.4; o.dy = -1; o.dz = 0.2; o.focus = 0.8; o.color = [1.2, 1.3, 1.5];
        for (let i = this.due(0, area * 18, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.snowflake, tv.x, tv.y + 3 + Math.random() * 3, tv.z, 1, o);
        }
        o = opts();
        o.speed = 7; o.dx = 0.3; o.dy = -1; o.dz = 0.1; o.focus = 0.9;
        for (let i = this.due(1, area * 4, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.frost, tv.x, tv.y + 4, tv.z, 1, o);
        }
        o = opts();
        o.speed = 2; o.dx = 1; o.dy = 0; o.dz = 0.3; o.focus = 0.5; o.sizeMul = 2.2;
        for (let i = this.due(2, area * 0.8, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.mist, tv.x, tv.y + 0.8, tv.z, 1, o);
        }
        break;
      }
      case 'gravity_well':
      case 'singularity': {
        // Spiral inflow: spawn on the rim with tangential + inward velocity.
        const n = this.due(0, this.kind === 'singularity' ? 120 : 70, dt);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.28, r = this.radius * (0.7 + Math.random() * 0.3);
          const cx = Math.cos(a), sz = Math.sin(a);
          o = opts();
          o.focus = 1; o.speedVar = 0.2;
          o.dx = -cx * 0.7 - sz * 0.7; o.dy = 0.15; o.dz = -sz * 0.7 + cx * 0.7; o.speed = r * 1.1; o.color = c;
          lib.emit(STYLES.mote, pos.x + cx * r, this.groundYs[0] + 0.3 + Math.random() * 2, pos.z + sz * r, 1, o);
        }
        o = opts();
        o.spread = this.radius * 0.8; o.flat = true; o.speed = 0.8; o.up = 1.5;
        for (let i = this.due(1, 20, dt); i > 0; i--) lib.emit(STYLES.dust, pos.x, this.groundYs[0] + 0.2, pos.z, 1, o);
        if (this.dark) this.dark.scale.setScalar(1 + 0.08 * Math.sin(time * 12));
        break;
      }
      case 'roots': {
        o = opts();
        o.speed = 1; o.up = 2.5; o.focus = 0.4;
        for (let i = this.due(0, area * 6, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.leaf, tv.x, tv.y + 0.1, tv.z, 1, o);
        }
        if (this.due(1, 2.5, dt)) {
          this.floor(tv, 0.8);
          lib.meshes.spawn(MeshFxKind.Spike, tv.setY(tv.y - 0.3), tv, 0.3, 1.2);
        }
        break;
      }
      case 'sanctuary':
      case 'dawn': {
        o = opts();
        o.speed = 0.2; o.up = 1.2; o.color = c;
        for (let i = this.due(0, area * 3, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.mote, tv.x, tv.y + 0.2, tv.z, 1, o);
        }
        if (this.kind === 'dawn') {
          o = opts();
          o.speed = 0; o.up = 3; o.color = [1.4, 1.1, 0.6]; o.sizeMul = 2;
          for (let i = this.due(1, area * 0.8, dt); i > 0; i--) {
            this.floor(tv);
            lib.emit(STYLES.streak, tv.x, tv.y + 0.5, tv.z, 1, o);
          }
        } else {
          o = opts();
          o.speed = 0.3; o.up = 0.8;
          for (let i = this.due(1, area * 0.6, dt); i > 0; i--) {
            this.floor(tv);
            lib.emit(STYLES.leaf, tv.x, tv.y + 1.5, tv.z, 1, o);
          }
        }
        break;
      }
      case 'ward':
      case 'glyph':
      case 'trap_fire':
      case 'trap_bind': {
        if (this.kind.startsWith('trap')) break;
        o = opts();
        o.speed = 0.1; o.up = 0.9; o.color = c;
        for (let i = this.due(0, area * 0.8, dt); i > 0; i--) {
          this.floor(tv, 0.95);
          lib.emit(STYLES.rune, tv.x, tv.y + 0.1, tv.z, 1, o);
        }
        break;
      }
      case 'light_orb': {
        o = opts();
        o.spread = 0.15; o.speed = 0.2; o.color = [1.6, 1.4, 1];
        for (let i = this.due(0, 14, dt); i > 0; i--) lib.emit(STYLES.star, pos.x, pos.y, pos.z, 1, o);
        break;
      }
      case 'night':
      case 'smoke':
      case 'toxic': {
        const st = this.kind === 'night' ? STYLES.wisp : STYLES.smoke;
        o = opts();
        o.speed = 0.4; o.up = 0.2; o.sizeMul = this.kind === 'night' ? 3 : 2.4; o.lifeMul = 1.6;
        o.color = this.kind === 'toxic' ? [0.9, 2.6, 0.6] : this.kind === 'night' ? [0.5, 0.4, 0.6] : [2.2, 2.2, 2.1];
        for (let i = this.due(0, area * 1.6, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(st, tv.x, tv.y + 0.4 + Math.random() * 1.6, tv.z, 1, o);
        }
        if (this.kind === 'toxic') {
          o = opts();
          o.speed = 0.3; o.up = 0.8;
          for (let i = this.due(1, area * 1.5, dt); i > 0; i--) {
            this.floor(tv);
            lib.emit(STYLES.bubble, tv.x, tv.y + 0.2, tv.z, 1, o);
          }
        }
        break;
      }
      case 'campfire': {
        o = opts();
        o.spread = 0.18; o.speed = 0.3; o.up = 0.6; o.sizeMul = 0.9;
        for (let i = this.due(0, 34, dt); i > 0; i--) lib.emit(STYLES.fire, pos.x, pos.y + 0.2, pos.z, 1, o);
        o = opts();
        o.spread = 0.2; o.speed = 0.4; o.up = 1.5;
        for (let i = this.due(1, 6, dt); i > 0; i--) lib.emit(STYLES.ember, pos.x, pos.y + 0.4, pos.z, 1, o);
        o = opts();
        o.spread = 0.2; o.speed = 0.2; o.up = 0.8; o.sizeMul = 0.8;
        for (let i = this.due(2, 3, dt); i > 0; i--) lib.emit(STYLES.smoke, pos.x, pos.y + 1.1, pos.z, 1, o);
        break;
      }
      case 'decoy': {
        if (this.dark) {
          this.dark.rotation.y = snap.yaw;
          ((this.dark.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.15 * Math.sin(time * 5));
        }
        o = opts();
        o.spread = 0.3; o.speed = 0.3; o.up = 0.5;
        for (let i = this.due(0, 12, dt); i > 0; i--) lib.emit(STYLES.wisp, pos.x, pos.y + 0.3 + Math.random() * 1.4, pos.z, 1, o);
        break;
      }
      default: {
        o = opts();
        o.speed = 0.2; o.up = 0.8; o.color = c;
        for (let i = this.due(0, area * 1.5, dt); i > 0; i--) {
          this.floor(tv);
          lib.emit(STYLES.mote, tv.x, tv.y + 0.2, tv.z, 1, o);
        }
      }
    }
  }

  dispose() {
    for (const d of this.decals) this.lib.decals.release(d);
    this.decals.length = 0;
    if (this.dark) {
      // Per-view materials (singularity core, decoy body); shared geometries stay cached.
      (this.dark.material as THREE.Material).dispose();
      if (this.kind === 'singularity') this.dark.geometry.dispose();
    }
    this.object.removeFromParent();
  }
}
