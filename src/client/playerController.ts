/**
 * Client-predicted player movement against the voxel terrain and static
 * colliders. Handles walking/running/sprinting/crouching, jumping under local
 * gravity, sliding on steep slopes, swimming, climbing steep rock, gliding and
 * movement effects (haste, root, levitate, featherfall, waterwalk...).
 */
import * as THREE from 'three';
import type { TerrainCollider } from '../world/collider';
import type { WorldGenerator } from '../world/generator';
import type { StaticColliders, StaticCollider } from './context';
import type { MoveState } from '../shared/types';
import { capsulePushOut } from './staticColliders';
import { SEA_LEVEL, UNDERWORLD_SEA_LEVEL } from '../world/constants';
import { clamp, damp, lerpAngle } from '../core/math';

export interface MoveInput {
  /** Camera-relative input axes in [-1,1]. */
  forward: number;
  right: number;
  jump: boolean;
  jumpPressed: boolean;
  sprint: boolean;
  crouch: boolean;
  walk: boolean;
  /** Camera yaw (radians, three.js convention). */
  camYaw: number;
  camPitch: number;
  /** Face the camera direction (aiming, blocking, attacking). */
  faceCamera: boolean;
  /** With faceCamera: face this yaw instead of the camera's (soft-facing the tab target). */
  faceYaw?: number;
}

export interface Modifiers {
  moveSpeed: number;
  jump: number;
  gravityMul: number;
  effects: Set<string>;
  stamina: number;
  scale: number;
}

const STEP = 1 / 120;
const BASE_JUMP_V = Math.sqrt(2 * 9.81 * 1.15);
const tmpCols: StaticCollider[] = [];

export class PlayerController {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  grounded = false;
  groundNormal = new THREE.Vector3(0, 1, 0);
  groundMaterial = 0;
  move: MoveState = 'idle';
  swimming = false;
  climbing = false;
  gliding = false;
  radius = 0.33;
  height = 1.75;
  /** Seconds since leaving the ground (coyote time). */
  private airTime = 0;
  private jumpCooldown = 0;
  /** True from a real jump (or knockback launch) until landing — running uphill is not a jump. */
  private airborneLaunch = false;
  private acc = 0;
  /** Accumulated horizontal distance for footstep cadence. */
  stepDistance = 0;
  /** Last landing impact speed (for camera shake / sounds), consumed by Game. */
  landingSpeed = 0;
  private wasGrounded = false;
  waterLevel = -1e9;

  constructor(
    private terrain: TerrainCollider,
    private gen: WorldGenerator,
    private colliders: StaticColliders,
    private gravityAt: (x: number, y: number, z: number) => number,
  ) {}

  teleport(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.airTime = 0;
  }

  applyImpulse(x: number, y: number, z: number) {
    this.vel.x += x;
    this.vel.y += y;
    this.vel.z += z;
    if (y > 0.5) {
      this.grounded = false;
      this.airborneLaunch = true;
    }
  }

  update(dt: number, input: MoveInput, mods: Modifiers) {
    this.height = 1.75 * mods.scale;
    this.radius = 0.33 * Math.max(0.6, Math.min(1.6, mods.scale));
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= STEP) {
      this.step(STEP, input, mods);
      this.acc -= STEP;
      input.jumpPressed = false;
    }
    // Facing.
    const moving = Math.hypot(this.vel.x, this.vel.z) > 0.3;
    if (input.faceCamera || this.climbing) {
      if (!this.climbing) this.yaw = lerpAngle(this.yaw, input.faceYaw ?? input.camYaw, damp(18, dt));
    } else if (moving && (Math.abs(input.forward) > 0.01 || Math.abs(input.right) > 0.01)) {
      const target = Math.atan2(-this.vel.x, -this.vel.z);
      this.yaw = lerpAngle(this.yaw, target, damp(this.swimming ? 5 : 11, dt));
    }
  }

  private waterSurfaceAt(x: number, y: number, z: number): number {
    // Sea & rivers: column must dip below sea level (same mask as the water shader).
    if (y < SEA_LEVEL + 3 && y > SEA_LEVEL - 120) {
      const c = this.gen.cachedColumn(x, z);
      if (c.height < SEA_LEVEL + 2.5) return SEA_LEVEL;
    }
    if (y < UNDERWORLD_SEA_LEVEL + 3 && this.gen.isUnderworld(x, y, z)) return UNDERWORLD_SEA_LEVEL;
    return -1e9;
  }

  private step(h: number, input: MoveInput, m: Modifiers) {
    const fx = m.effects;
    const rooted = fx.has('root') || fx.has('stun');
    let g = this.gravityAt(this.pos.x, this.pos.y, this.pos.z) * m.gravityMul;
    if (fx.has('gravity_low')) g *= 0.4;
    if (fx.has('gravity_high')) g *= 1.8;
    const levitate = fx.has('levitate');

    // --- environment
    this.waterLevel = this.waterSurfaceAt(this.pos.x, this.pos.y, this.pos.z);
    const depth = this.waterLevel - this.pos.y;
    const waterwalk = fx.has('waterwalk');
    // Hysteresis: start swimming in chest-deep water, keep swimming while floating higher
    // (front crawl lifts the body), stop only where it gets genuinely shallow.
    this.swimming = !waterwalk && depth > this.height * (this.swimming ? 0.36 : 0.62);

    // --- desired velocity
    let speed = 5.0;
    if (input.walk) speed = 2.0;
    else if (input.crouch) speed = 1.7;
    else if (input.sprint && m.stamina > 1) speed = 8.6;
    if (this.swimming) speed = fx.has('swim_boost') ? 5 : input.sprint && m.stamina > 1 ? 3.8 : 2.6;
    speed *= m.moveSpeed * (fx.has('haste') ? 1.45 : 1) * (fx.has('slow') ? 0.5 : 1);
    if (rooted) speed = 0;
    const sy = Math.sin(input.camYaw), cy = Math.cos(input.camYaw);
    // three.js yaw: forward = (-sin, 0, -cos)
    let dx = -sy * input.forward + cy * input.right;
    let dz = -cy * input.forward - sy * input.right;
    const dl = Math.hypot(dx, dz);
    if (dl > 1) {
      dx /= dl;
      dz /= dl;
    }
    const wantX = dx * speed, wantZ = dz * speed;

    // --- climbing detection (steep rock in front while pushing forward)
    if (!this.swimming && !rooted && input.forward > 0.5 && m.stamina > 2) {
      const fdx = -Math.sin(this.yaw), fdz = -Math.cos(this.yaw);
      const chest = this.pos.y + this.height * 0.55;
      const hit = this.terrain.raycast(this.pos.x, chest, this.pos.z, fdx, 0, fdz, this.radius + 0.45);
      if (hit && hit.ny < 0.45 && hit.ny > -0.5 && (!this.grounded || this.climbing || this.vel.y < 0.5)) {
        if (!this.climbing && !this.grounded) this.climbing = true;
        if (!this.climbing && this.grounded && input.jumpPressed) this.climbing = true;
      } else if (this.climbing) {
        // Lost the wall: if it was because we reached the top, vault up and over.
        const top = this.terrain.raycast(this.pos.x, this.pos.y + this.height + 0.3, this.pos.z, fdx, 0, fdz, this.radius + 0.6);
        if (!top) this.applyImpulse(fdx * 2.2, 3.2, fdz * 2.2);
        this.climbing = false;
      }
    } else if (this.climbing) this.climbing = false;
    if (m.stamina <= 0.5) this.climbing = false;

    if (this.climbing) {
      const fdx = -Math.sin(this.yaw), fdz = -Math.cos(this.yaw);
      const climbSpeed = (fx.has('climb_boost') ? 3.4 : 1.9) * m.moveSpeed;
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      this.vel.set(rx * input.right * climbSpeed * 0.7 + fdx * 0.6, input.forward * climbSpeed, rz * input.right * climbSpeed * 0.7 + fdz * 0.6);
      if (input.jumpPressed) {
        this.climbing = false;
        this.vel.set(-fdx * 3.5, BASE_JUMP_V * 0.8, -fdz * 3.5);
      }
    } else if (this.swimming) {
      // Buoyancy: treading water floats upright with head and shoulders out; swimming forward
      // the body lies horizontal (pivoting at the hips, see Animator.swim), so the hips must
      // float just under the surface — otherwise the whole body is submerged and it reads as
      // diving. Crouch dives, jump rises.
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const crawl = hs <= 0.2 ? 0 : hs >= 0.8 ? 1 : ((hs - 0.2) / 0.6) ** 2 * (3 - 2 * ((hs - 0.2) / 0.6));
      const targetY = this.waterLevel - this.height * (0.72 - 0.2 * crawl);
      let vy = (targetY - this.pos.y) * 3;
      if (input.crouch) vy = -2.2;
      if (input.jump) vy = 2.5;
      // Looking down while moving forward also dives.
      if (input.forward > 0.3 && input.camPitch < -0.45) vy = Math.min(vy, input.camPitch * 3);
      const k = 1 - Math.exp(-4 * h);
      this.vel.x += (wantX - this.vel.x) * k;
      this.vel.z += (wantZ - this.vel.z) * k;
      this.vel.y += (vy - this.vel.y) * k;
    } else {
      const control = this.grounded ? 1 - Math.exp(-14 * h) : 1 - Math.exp(-2.2 * h);
      this.vel.x += (wantX - this.vel.x) * control;
      this.vel.z += (wantZ - this.vel.z) * control;
      // Gravity and vertical modifiers.
      if (levitate) {
        const vy = input.jump ? 2.5 : input.crouch ? -2.5 : 0;
        this.vel.y += (vy - this.vel.y) * (1 - Math.exp(-5 * h));
      } else if (!this.grounded) {
        this.vel.y -= g * h;
        if (fx.has('featherfall')) this.vel.y = Math.max(this.vel.y, -2.5);
        this.gliding = (fx.has('glide') || fx.has('featherfall')) && input.jump && this.vel.y < 0;
        if (this.gliding) {
          this.vel.y = Math.max(this.vel.y, -1.6);
          const fdx = -Math.sin(this.yaw), fdz = -Math.cos(this.yaw);
          this.vel.x += fdx * 6 * h;
          this.vel.z += fdz * 6 * h;
        }
        // Terminal velocity.
        this.vel.y = Math.max(this.vel.y, -62);
      } else {
        this.gliding = false;
        // Slide down steep slopes.
        if (this.groundNormal.y < 0.62) {
          this.vel.x += this.groundNormal.x * g * h * 1.2;
          this.vel.z += this.groundNormal.z * g * h * 1.2;
          this.vel.y -= g * h;
        } else this.vel.y = Math.min(this.vel.y, 0);
      }
      // Jump.
      this.jumpCooldown -= h;
      if (input.jumpPressed && !rooted && (this.grounded || this.airTime < 0.12) && this.jumpCooldown <= 0 && !levitate) {
        const jv = BASE_JUMP_V * m.jump * (fx.has('leap_boost') ? 1.6 : 1) * (input.crouch ? 0.8 : 1);
        this.vel.y = jv;
        this.grounded = false;
        this.airTime = 1;
        this.airborneLaunch = true;
        this.jumpCooldown = 0.25;
      }
    }

    // Water walking: stand on the surface.
    if (waterwalk && this.waterLevel > -1e8 && this.pos.y < this.waterLevel && this.pos.y > this.waterLevel - 1.5) {
      this.pos.y = this.waterLevel;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // --- integrate
    this.pos.addScaledVector(this.vel, h);

    // --- terrain collision: three spheres along the capsule
    const r = this.radius;
    const heights = [r, this.height * 0.5, this.height - r];
    for (let iter = 0; iter < 2; iter++) {
      for (const sh of heights) {
        const c = this.terrain.sphereContact(this.pos.x, this.pos.y + sh, this.pos.z, r);
        if (!c) continue;
        // Treat walkable contacts on the lowest sphere as ground (push straight up to avoid sliding).
        if (sh === r && c.ny > 0.62) {
          this.pos.y += c.depth / Math.max(0.62, c.ny);
        } else {
          this.pos.x += c.px;
          this.pos.y += c.py;
          this.pos.z += c.pz;
        }
        const vn = this.vel.x * c.nx + this.vel.y * c.ny + this.vel.z * c.nz;
        if (vn < 0) {
          this.vel.x -= vn * c.nx;
          this.vel.y -= vn * c.ny;
          this.vel.z -= vn * c.nz;
        }
      }
      // Static colliders.
      tmpCols.length = 0;
      this.colliders.query(this.pos.x - r - 0.5, this.pos.y - 0.5, this.pos.z - r - 0.5, this.pos.x + r + 0.5, this.pos.y + this.height + 0.5, this.pos.z + r + 0.5, tmpCols);
      for (const col of tmpCols) {
        const push = capsulePushOut(this.pos.x, this.pos.y, this.pos.z, r, this.height, col);
        if (!push) continue;
        this.pos.x += push[0];
        this.pos.y += push[1];
        this.pos.z += push[2];
        const pl = Math.hypot(push[0], push[1], push[2]) || 1;
        const nx = push[0] / pl, ny = push[1] / pl, nz = push[2] / pl;
        const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
        if (vn < 0) {
          this.vel.x -= vn * nx;
          this.vel.y -= vn * ny;
          this.vel.z -= vn * nz;
        }
        if (ny > 0.7) {
          this.grounded = true;
          this.groundNormal.set(0, 1, 0);
        }
      }
    }

    // --- ground probe & snapping
    const prevGrounded = this.grounded;
    const reach = prevGrounded ? 0.45 : 0.08;
    const probe = this.terrain.raycast(this.pos.x, this.pos.y + r, this.pos.z, 0, -1, 0, r + reach);
    const canLand = (!this.airborneLaunch || this.vel.y <= 0.5) && !this.swimming && !this.climbing;
    // Building surfaces (steps, floors, porches) above the terrain are the real ground: stand and
    // snap on them, never through them onto the terrain underneath (that bounced players on stairs).
    const top = this.colliderGround(reach);
    if (top !== null && canLand && (!probe || top >= probe.y - 0.02)) {
      this.airborneLaunch = false;
      this.grounded = true;
      this.groundNormal.set(0, 1, 0);
      const gap = this.pos.y - top;
      if (gap > 0.005) this.pos.y -= Math.min(gap, 4 * h + gap * 0.5);
      this.airTime = 0;
    } else if (probe && probe.ny > 0.45 && canLand) {
      // Upward velocity from walking up slopes must not detach us from the ground; only a real launch does.
      this.airborneLaunch = false;
      this.grounded = true;
      this.groundNormal.set(probe.nx, probe.ny, probe.nz);
      // Snap down onto the ground when walking downhill.
      const gap = this.pos.y - probe.y;
      if (gap > 0.005 && probe.ny > 0.62) this.pos.y -= Math.min(gap, 4 * h + gap * 0.5);
      this.airTime = 0;
    } else if (!this.groundedByCollider()) {
      this.grounded = false;
      this.airTime += h;
    }
    if (this.grounded && !this.wasGrounded) this.landingSpeed = Math.max(this.landingSpeed, -this.vel.y);
    if (this.grounded && this.vel.y < 0) this.vel.y = 0;
    this.wasGrounded = this.grounded;
    if (this.grounded) this.stepDistance += Math.hypot(this.vel.x, this.vel.z) * h;

    // --- state label
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.climbing) this.move = 'climb';
    else if (this.swimming) this.move = 'swim';
    else if (levitate && !this.grounded) this.move = 'fly';
    else if (this.gliding) this.move = 'glide';
    else if (!this.grounded && this.airborneLaunch && this.vel.y > 0.5) this.move = 'jump';
    else if (!this.grounded && this.airTime > 0.3 && this.vel.y < -1.5) this.move = 'fall';
    else if (!this.grounded && (this.move === 'jump' || this.move === 'fall')) this.move = this.vel.y > 0 ? 'jump' : 'fall';
    else if (input.crouch) this.move = 'crouch';
    else if (hs < 0.25) this.move = 'idle';
    else if (hs < 2.6) this.move = 'walk';
    else if (hs < 6.8) this.move = 'run';
    else this.move = 'sprint';
  }

  /**
   * Highest walkable collider top under the capsule's footprint, from 0.3 above the feet down
   * to `reach` below them (centre plus four rim rays, so standing on a step edge counts).
   */
  private colliderGround(reach: number): number | null {
    let best: number | null = null;
    const rr = this.radius * 0.95;
    for (let i = 0; i < 5; i++) {
      const ox = i === 1 ? rr : i === 2 ? -rr : 0, oz = i === 3 ? rr : i === 4 ? -rr : 0;
      const hit = this.colliders.raycast([this.pos.x + ox, this.pos.y + 0.3, this.pos.z + oz], [0, -1, 0], 0.3 + reach, (c) => c.solid);
      if (hit && hit.normal[1] > 0.6 && (best === null || hit.point[1] > best)) best = hit.point[1];
    }
    return best;
  }

  private groundedByCollider(): boolean {
    // Standing on a static collider top (crates, walls) — probe colliders below the feet.
    const hit = this.colliders.raycast([this.pos.x, this.pos.y + 0.3, this.pos.z], [0, -1, 0], 0.42, (c) => c.solid);
    if (hit && hit.normal[1] > 0.6) {
      this.airTime = 0;
      return true;
    }
    return false;
  }

  /** Clamp a requested position correction from the server. */
  correct(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  get headY() {
    return this.pos.y + this.height * 0.92;
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }
}

export { clamp };
