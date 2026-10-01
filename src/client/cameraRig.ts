/** Third-person orbit camera with terrain/collider avoidance, zoom, shoulder offset and shake. */
import * as THREE from 'three';
import type { TerrainCollider } from '../world/collider';
import type { StaticColliders } from './context';
import { clamp, damp } from '../core/math';

export class CameraRig {
  yaw = 0;
  pitch = -0.25;
  distance = 4.2;
  targetDistance = 4.2;
  minDistance = 0.0;
  maxDistance = 14;
  shoulder = 0.55;
  fov = 62;
  /** Current effective distance after collision. */
  private effDist = 4.2;
  private shake = 0;
  private shakeT = 0;
  private smoothTarget = new THREE.Vector3();
  private initialized = false;
  firstPerson = false;
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, private terrain: TerrainCollider, private colliders: StaticColliders) {}

  addShake(s: number) {
    this.shake = Math.min(1.5, this.shake + s);
  }

  rotate(dx: number, dy: number, sens: number, invertY: boolean) {
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.45, 1.35);
  }

  zoom(steps: number) {
    this.targetDistance = clamp(this.targetDistance * Math.pow(1.15, steps), this.minDistance, this.maxDistance);
    if (this.targetDistance < 0.7 && steps < 0) this.targetDistance = 0;
    if (this.targetDistance > 0 && this.targetDistance < 0.7 && steps > 0) this.targetDistance = 1.2;
  }

  /**
   * @param head world position of the character's head pivot
   */
  update(dt: number, head: THREE.Vector3) {
    if (!this.initialized) {
      this.smoothTarget.copy(head);
      this.initialized = true;
    }
    // Smooth vertical motion a bit (stairs, landing), keep horizontal tight.
    this.smoothTarget.x = head.x;
    this.smoothTarget.z = head.z;
    this.smoothTarget.y += (head.y - this.smoothTarget.y) * damp(18, dt);
    this.distance += (this.targetDistance - this.distance) * damp(10, dt);
    this.firstPerson = this.distance < 0.35;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const pivot = this.smoothTarget.clone();
    if (!this.firstPerson) pivot.addScaledVector(right, this.shoulder * Math.min(1, this.distance / 2.5));
    const want = this.firstPerson ? this.distance : this.distance;
    // Collision: march from pivot backwards.
    const back = fwd.clone().negate();
    let allowed = want;
    if (want > 0.05) {
      // Cast the centre ray plus four rays toward the near-plane corners, so the view
      // can't slip past walls and ceilings in tight caves.
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      const end = pivot.clone().addScaledVector(back, want);
      const dir = new THREE.Vector3();
      for (const [sx, sy] of [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const target = end.clone().addScaledVector(right, sx * 0.28).addScaledVector(up, sy * 0.2);
        dir.subVectors(target, pivot);
        const len = dir.length();
        if (len < 1e-4) continue;
        dir.multiplyScalar(1 / len);
        const hit = this.terrain.raycast(pivot.x, pivot.y, pivot.z, dir.x, dir.y, dir.z, len + 0.3);
        // Project the hit distance back onto the centre axis.
        if (hit) allowed = Math.min(allowed, Math.max(0.15, (hit.dist / len) * want - 0.3));
      }
      const ch = this.colliders.raycast([pivot.x, pivot.y, pivot.z], [back.x, back.y, back.z], want + 0.3, (c) => c.solid);
      if (ch) allowed = Math.min(allowed, Math.max(0.15, ch.dist - 0.25));
    }
    // Move in fast when blocked, ease out when free.
    this.effDist = allowed < this.effDist ? allowed : this.effDist + (allowed - this.effDist) * damp(4, dt);
    const camPos = pivot.clone().addScaledVector(back, this.effDist);
    // Keep a little clearance from any terrain surface (floor, wall or ceiling) by pushing
    // out along the surface normal — not just upward, which would push into cave ceilings.
    for (let i = 0; i < 4; i++) {
      const d = this.terrain.density(camPos.x, camPos.y, camPos.z);
      if (d < -0.3) break;
      const n = this.terrain.normal(camPos.x, camPos.y, camPos.z);
      camPos.x += n[0] * (d + 0.32);
      camPos.y += n[1] * (d + 0.32);
      camPos.z += n[2] * (d + 0.32);
    }

    // Shake.
    this.shakeT += dt;
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.12;
      camPos.x += Math.sin(this.shakeT * 37.1) * s;
      camPos.y += Math.sin(this.shakeT * 41.7 + 1) * s;
      camPos.z += Math.sin(this.shakeT * 29.3 + 2) * s;
      this.shake *= Math.exp(-dt * 4);
    }
    this.camera.position.copy(camPos);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.aimOrigin.copy(camPos);
    this.aimDir.copy(fwd);
  }
}
