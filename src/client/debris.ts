/**
 * Lightweight rigid-body debris: fragments of shattered rocks, felled trees,
 * building pieces. Bodies are spheres for collision (against terrain density
 * and static colliders), with full rotational motion for visuals. Gravity is
 * local (WorldGenerator.gravityAt + temporary gravity fields).
 */
import * as THREE from 'three';
import type { DebrisAPI, DebrisOptions, StaticColliders } from './context';
import type { TerrainCollider } from '../world/collider';
import type { WorldGenerator } from '../world/generator';
import type { Vec3 } from '../shared/types';
import { capsulePushOut } from './staticColliders';

interface Body {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  radius: number;
  life: number;
  age: number;
  bounce: number;
  friction: number;
  sleeping: boolean;
  fadeMats: THREE.Material[];
}

export interface GravityField {
  pos: Vec3;
  radius: number;
  factor: number;
  until: number;
}

const MAX_BODIES = 260;
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

export class DebrisSystem implements DebrisAPI {
  private bodies: Body[] = [];
  readonly group = new THREE.Group();
  /** Temporary gravity fields (spells), shared with the player controller. */
  fields: GravityField[] = [];
  time = 0;

  constructor(private terrain: TerrainCollider, private gen: WorldGenerator, private colliders: StaticColliders) {
    this.group.name = 'debris';
  }

  /** Effective gravity at a point including temporary fields. */
  gravityAt(x: number, y: number, z: number): number {
    let g = this.gen.gravityAt(x, y, z);
    for (const f of this.fields) {
      const d = Math.hypot(x - f.pos[0], y - f.pos[1], z - f.pos[2]);
      if (d < f.radius) g *= f.factor;
    }
    return g;
  }

  spawn(o: DebrisOptions): void {
    if (this.bodies.length >= MAX_BODIES) this.kill(this.bodies[0]);
    const obj = o.object;
    obj.position.set(o.pos[0], o.pos[1], o.pos[2]);
    obj.matrixAutoUpdate = true;
    this.group.add(obj);
    const fadeMats: THREE.Material[] = [];
    obj.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) fadeMats.push(mm);
      c.castShadow = true;
    });
    this.bodies.push({
      obj,
      pos: new THREE.Vector3(...o.pos),
      vel: new THREE.Vector3(...o.vel),
      angVel: new THREE.Vector3(...(o.angVel ?? [Math.random() * 4 - 2, Math.random() * 4 - 2, Math.random() * 4 - 2])),
      radius: o.radius,
      life: o.life ?? 12,
      age: 0,
      bounce: o.bounce ?? 0.25,
      friction: o.friction ?? 0.6,
      sleeping: false,
      fadeMats,
    });
  }

  /**
   * Split a mesh into chunky fragments: triangles are clustered around random
   * seed points (a cheap Voronoi), each cluster becomes a closed-looking shard.
   */
  shatter(mesh: THREE.Mesh, origin: Vec3, force: number, pieces = 8, life = 10): void {
    mesh.updateWorldMatrix(true, false);
    const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = src.getAttribute('position') as THREE.BufferAttribute;
    const nrm = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const triCount = Math.floor(pos.count / 3);
    if (triCount === 0) return;
    src.computeBoundingBox();
    const bb = src.boundingBox!;
    const seeds: THREE.Vector3[] = [];
    for (let i = 0; i < pieces; i++) {
      seeds.push(new THREE.Vector3(
        THREE.MathUtils.lerp(bb.min.x, bb.max.x, Math.random()),
        THREE.MathUtils.lerp(bb.min.y, bb.max.y, Math.random()),
        THREE.MathUtils.lerp(bb.min.z, bb.max.z, Math.random()),
      ));
    }
    const groups: number[][] = seeds.map(() => []);
    const c = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      c.set(0, 0, 0);
      for (let k = 0; k < 3; k++) c.x += pos.getX(t * 3 + k), c.y += pos.getY(t * 3 + k), c.z += pos.getZ(t * 3 + k);
      c.multiplyScalar(1 / 3);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const d = seeds[i].distanceToSquared(c);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      groups[bi].push(t);
    }
    const scale = new THREE.Vector3();
    mesh.matrixWorld.decompose(tmpV, tmpQ, scale);
    const material = mesh.material;
    for (let i = 0; i < groups.length; i++) {
      const tris = groups[i];
      if (!tris.length) continue;
      // Centroid of the fragment.
      const cen = new THREE.Vector3();
      for (const t of tris) for (let k = 0; k < 3; k++) cen.x += pos.getX(t * 3 + k), cen.y += pos.getY(t * 3 + k), cen.z += pos.getZ(t * 3 + k);
      cen.multiplyScalar(1 / (tris.length * 3));
      const p = new Float32Array(tris.length * 9);
      const n = new Float32Array(tris.length * 9);
      const u = uv ? new Float32Array(tris.length * 6) : null;
      let maxR = 0.05;
      tris.forEach((t, j) => {
        for (let k = 0; k < 3; k++) {
          const vi = t * 3 + k;
          // Shrink fragments slightly towards their centroid so they read as separate pieces.
          const x = cen.x + (pos.getX(vi) - cen.x) * 0.94, y = cen.y + (pos.getY(vi) - cen.y) * 0.94, z = cen.z + (pos.getZ(vi) - cen.z) * 0.94;
          p.set([x - cen.x, y - cen.y, z - cen.z], j * 9 + k * 3);
          maxR = Math.max(maxR, Math.hypot(x - cen.x, y - cen.y, z - cen.z));
          if (nrm) n.set([nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi)], j * 9 + k * 3);
          if (u && uv) u.set([uv.getX(vi), uv.getY(vi)], j * 6 + k * 2);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      else g.computeVertexNormals();
      if (u) g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
      const frag = new THREE.Mesh(g, material);
      frag.scale.copy(scale);
      frag.quaternion.copy(tmpQ);
      const world = cen.clone().applyMatrix4(mesh.matrixWorld);
      const dir = world.clone().sub(new THREE.Vector3(...origin));
      const dl = dir.length() || 1;
      dir.multiplyScalar(1 / dl);
      const sp = force * (0.6 + Math.random() * 0.8) / (0.6 + maxR * scale.x);
      this.spawn({
        object: frag,
        pos: [world.x, world.y, world.z],
        vel: [dir.x * sp, dir.y * sp + force * 0.35, dir.z * sp],
        radius: Math.max(0.05, maxR * scale.x * 0.6),
        life: life * (0.7 + Math.random() * 0.6),
      });
    }
    if (src !== mesh.geometry) src.dispose();
  }

  update(dt: number) {
    this.time += dt;
    this.fields = this.fields.filter((f) => f.until > this.time);
    const sub = dt > 1 / 45 ? 2 : 1;
    const h = dt / sub;
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      b.age += dt;
      if (b.age > b.life) {
        this.kill(b);
        continue;
      }
      if (!b.sleeping) {
        for (let s = 0; s < sub; s++) this.step(b, h);
        b.obj.position.copy(b.pos);
        const w = b.angVel.length();
        if (w > 1e-4) {
          tmpQ.setFromAxisAngle(tmpV.copy(b.angVel).multiplyScalar(1 / w), w * dt);
          b.obj.quaternion.premultiply(tmpQ);
        }
      }
      // Sink & fade near end of life.
      const rem = b.life - b.age;
      if (rem < 1.5) {
        b.obj.position.y -= (1.5 - rem) * b.radius * dt * 1.5;
        b.obj.scale.multiplyScalar(1 - dt * 0.5);
      }
    }
  }

  private step(b: Body, h: number) {
    const g = this.gravityAt(b.pos.x, b.pos.y, b.pos.z);
    b.vel.y -= g * h;
    b.vel.multiplyScalar(1 - 0.05 * h);
    b.pos.addScaledVector(b.vel, h);
    const c = this.terrain.sphereContact(b.pos.x, b.pos.y, b.pos.z, b.radius);
    if (c) {
      b.pos.x += c.px;
      b.pos.y += c.py;
      b.pos.z += c.pz;
      const vn = b.vel.x * c.nx + b.vel.y * c.ny + b.vel.z * c.nz;
      if (vn < 0) {
        // Reflect normal component, damp tangential.
        b.vel.x -= (1 + b.bounce) * vn * c.nx;
        b.vel.y -= (1 + b.bounce) * vn * c.ny;
        b.vel.z -= (1 + b.bounce) * vn * c.nz;
        b.vel.multiplyScalar(1 - b.friction * 0.3);
        b.angVel.multiplyScalar(0.8);
      }
      if (b.vel.lengthSq() < 0.04 && c.ny > 0.5) {
        b.sleeping = true;
        b.vel.set(0, 0, 0);
      }
    }
    const near = this.colliders.query(b.pos.x - b.radius, b.pos.y - b.radius, b.pos.z - b.radius, b.pos.x + b.radius, b.pos.y + b.radius, b.pos.z + b.radius);
    for (const col of near) {
      const push = capsulePushOut(b.pos.x, b.pos.y - b.radius, b.pos.z, b.radius, b.radius * 2, col);
      if (push) {
        b.pos.x += push[0];
        b.pos.y += push[1];
        b.pos.z += push[2];
        b.vel.multiplyScalar(0.6);
      }
    }
  }

  private kill(b: Body) {
    this.group.remove(b.obj);
    b.obj.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  /** Wake sleeping bodies near a point (after explosions / terrain edits). */
  wake(pos: Vec3, radius: number, impulse = 0) {
    for (const b of this.bodies) {
      const d = Math.hypot(b.pos.x - pos[0], b.pos.y - pos[1], b.pos.z - pos[2]);
      if (d < radius) {
        b.sleeping = false;
        if (impulse) {
          tmpV.set(b.pos.x - pos[0], b.pos.y - pos[1] + 0.5, b.pos.z - pos[2]).normalize().multiplyScalar(impulse * (1 - d / radius));
          b.vel.add(tmpV);
        }
      }
    }
  }

  get count() {
    return this.bodies.length;
  }
}
