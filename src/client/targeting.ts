/**
 * Tab targeting (client side). Picks a creature/NPC/player as the local player's "target":
 * Tab walks through valid targets (hostile first, then neutral, then friendly; nearest to the
 * crosshair first) in a stable order, Shift+Tab walks backwards. The selection is purely a
 * client convenience — attacks and abilities send the id with `lock: true` and the server
 * re-validates range and line of sight before aiming at it (multiplayer-safe).
 *
 * Drops the target when it dies (after a short linger so the HUD can show it), despawns, turns
 * invisible, goes beyond TARGET_KEEP_RANGE, stays out of sight for TARGET_LOS_GRACE seconds,
 * when the player dies, or on request (Esc via the UI: ClientEvents.targetRequest).
 *
 * Visuals: a ground ring under the target, sized to it and tinted by disposition. The HUD
 * target frame listens to ClientEvents.target.
 */
import * as THREE from 'three';
import type { ClientContext, EntityView, TargetInfo } from './context';
import type { EntitySnapshot } from '../shared/protocol';
import type { EntityId, Vec3 } from '../shared/types';
import { EntFlag } from '../shared/types';
import {
  CYCLE_MEMORY, TARGET_DEAD_LINGER, TARGET_KEEP_RANGE, TARGET_LOS_GRACE, TARGET_PICK_RANGE,
  dispositionOf, isEngaged, isTargetable, mergeCycle, rankTargets, stepCycle, type Disposition, type RankInput,
} from './targetRules';

const tmp = new THREE.Vector3();
const ndc = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camDir = new THREE.Vector3();

export class TargetSystem {
  private info: TargetInfo | null = null;
  private cycle: EntityId[] = [];
  private cycleAt = -1e9;
  private time = 0;
  private hiddenFor = 0;
  private deadFor = 0;
  private losTimer = 0;
  private marker: TargetMarker | null = null;
  private offs: (() => void)[] = [];

  constructor(private ctx: ClientContext) {}

  /** Currently selected target id (also while it lingers dead). */
  get id(): EntityId | null {
    return this.info?.id ?? null;
  }

  /** Target that attacks/abilities should aim at: selected and alive. */
  get lockId(): EntityId | undefined {
    return this.info && this.info.snap.hp > 0 ? this.info.id : undefined;
  }

  /** Feet position of the lock target (ground-targeted abilities). */
  lockPoint(): Vec3 | undefined {
    if (this.lockId === undefined) return;
    const p = this.info!.snap.pos;
    return [p[0], p[1], p[2]];
  }

  /** Chest height point of the lock target (local aim direction for animations). */
  lockChest(): Vec3 | undefined {
    if (this.lockId === undefined) return;
    const s = this.info!.snap;
    const v = this.ctx.views.get(s.id);
    return [s.pos[0], s.pos[1] + (v?.headHeight ?? 1.6) * 0.55, s.pos[2]];
  }

  /** Yaw (three.js convention) from (x, z) toward the lock target, if within `maxDist`. */
  yawFrom(x: number, z: number, maxDist: number): number | undefined {
    if (this.lockId === undefined) return;
    const p = this.info!.snap.pos;
    const dx = p[0] - x, dz = p[2] - z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05 || d > maxDist) return;
    return Math.atan2(-dx, -dz);
  }

  // ---------------------------------------------------------------- selection

  /** Tab / Shift+Tab. Returns false when nothing could be selected. */
  cycleTargets(dir: 1 | -1): boolean {
    const ctx = this.ctx;
    const pid = ctx.state.playerId;
    const cam = ctx.camera;
    cam.getWorldPosition(camPos);
    cam.getWorldDirection(camDir);
    const [px, py, pz] = ctx.playerPos();
    const cands: RankInput[] = [];
    for (const s of ctx.state.entities.values()) {
      if (!isTargetable(s, pid)) continue;
      const dist = Math.hypot(s.pos[0] - px, s.pos[1] - py, s.pos[2] - pz);
      if (dist > TARGET_PICK_RANGE) continue;
      const view = ctx.views.get(s.id);
      if (!view) continue;
      const engaged = isEngaged(s, pid);
      tmp.set(s.pos[0], s.pos[1] + view.headHeight * 0.55, s.pos[2]).sub(camPos);
      const len = tmp.length() || 1;
      const cos = tmp.dot(camDir) / len;
      ndc.set(s.pos[0], s.pos[1] + view.headHeight * 0.55, s.pos[2]).project(cam);
      const onScreen = cos > 0 && ndc.z <= 1 && ndc.z >= -1 && Math.abs(ndc.x) <= 1.05 && Math.abs(ndc.y) <= 1.1;
      // Off-screen only counts for something already biting the player at close range.
      if (!onScreen && !(engaged && dist < 8)) continue;
      if (!this.sees(camPos.x, camPos.y, camPos.z, s, view) && !this.seesFromPlayer(s, view)) continue;
      cands.push({ id: s.id, disposition: dispositionOf(s, pid), engaged, angle: Math.acos(Math.max(-1, Math.min(1, cos))), dist });
    }
    const ranked = rankTargets(cands);
    const order = this.cycle.length && this.time - this.cycleAt < CYCLE_MEMORY ? mergeCycle(this.cycle, ranked) : ranked;
    this.cycle = order;
    this.cycleAt = this.time;
    // A lingering dead target is never part of the order: stepping from it starts over.
    const next = stepCycle(order, this.lockId ?? null, dir);
    if (next === null) {
      try {
        ctx.audio.play('ui.hover', undefined, { volume: 0.5 });
      } catch {
        /* audio optional */
      }
      return false;
    }
    // Only candidate is the current target: acknowledge with a ring pulse.
    this.select(next, true);
    return true;
  }

  /** Select a specific entity (e.g. from UI). `refresh` re-pulses the ring on the same target. */
  select(id: EntityId, refresh = false) {
    const ctx = this.ctx;
    const s = ctx.state.entities.get(id);
    if (!s || !isTargetable(s, ctx.state.playerId)) return;
    this.hook();
    this.ensureMarker()?.pop();
    if (this.info?.id === id && refresh) return;
    const [px, py, pz] = ctx.playerPos();
    this.info = {
      id, snap: s, disposition: dispositionOf(s, ctx.state.playerId), visible: true, age: 0,
      dist: Math.hypot(s.pos[0] - px, s.pos[1] - py, s.pos[2] - pz),
    };
    this.hiddenFor = 0;
    this.deadFor = 0;
    this.losTimer = 0.25;
    try {
      ctx.audio.play('ui.tab', undefined, { volume: 0.55 });
    } catch {
      /* audio optional */
    }
    ctx.events.emit('target', this.info);
  }

  clear() {
    if (!this.info) return;
    this.info = null;
    this.hiddenFor = this.deadFor = 0;
    this.marker?.hide();
    this.ctx.events.emit('target', null);
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, playerAlive: boolean) {
    this.time += dt;
    this.hook();
    const marker = this.marker;
    const info = this.info;
    if (!info) {
      marker?.update(dt);
      return;
    }
    const ctx = this.ctx;
    const pid = ctx.state.playerId;
    const s = ctx.state.entities.get(info.id);
    if (!s || !playerAlive || (s.flags & EntFlag.Invisible) !== 0) return this.clear();
    const [px, py, pz] = ctx.playerPos();
    info.snap = s;
    info.age += dt;
    info.dist = Math.hypot(s.pos[0] - px, s.pos[1] - py, s.pos[2] - pz);
    if (info.dist > TARGET_KEEP_RANGE) return this.clear();
    if (s.hp <= 0) {
      this.deadFor += dt;
      if (this.deadFor > TARGET_DEAD_LINGER) return this.clear();
    } else this.deadFor = 0;
    const view = ctx.views.get(s.id);
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.25;
      readCamera(ctx);
      info.visible = !view || this.seesFromPlayer(s, view) || this.sees(camPos.x, camPos.y, camPos.z, s, view);
    }
    if (!info.visible && s.hp > 0) {
      this.hiddenFor += dt;
      if (this.hiddenFor > TARGET_LOS_GRACE) return this.clear();
    } else this.hiddenFor = 0;
    info.disposition = dispositionOf(s, pid);
    const m = this.ensureMarker();
    if (m) {
      const radius = Math.max(0.5, Math.min(9, (view?.radius ?? 0.45) * 1.2 + 0.25));
      m.show(s, radius, info.disposition, s.hp <= 0 ? 1 - this.deadFor / TARGET_DEAD_LINGER : info.visible ? 1 : 0.45, isEngaged(s, pid));
      m.update(dt);
    }
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.marker) {
      this.marker.mesh.removeFromParent();
      this.marker.dispose();
      this.marker = null;
    }
    this.info = null;
  }

  // ---------------------------------------------------------------- internals

  private hooked = false;

  private hook() {
    if (this.hooked) return;
    this.hooked = true;
    const ev = this.ctx.events;
    this.offs.push(
      ev.on('entityRemoved', ({ id }) => {
        if (id === this.info?.id) this.clear();
      }),
      ev.on('targetRequest', ({ op }) => {
        if (op === 'clear') this.clear();
        else this.cycleTargets(op === 'next' ? 1 : -1);
      }),
    );
  }

  private ensureMarker(): TargetMarker | null {
    if (this.marker) return this.marker;
    try {
      this.marker = new TargetMarker(this.ctx);
      this.ctx.scene.add(this.marker.mesh);
    } catch (err) {
      console.warn('[targeting] marker unavailable', err);
      return null;
    }
    return this.marker;
  }

  private seesFromPlayer(s: EntitySnapshot, view: EntityView): boolean {
    const [px, py, pz] = this.ctx.playerPos();
    const self = this.ctx.views.get(this.ctx.state.playerId);
    return this.sees(px, py + (self?.headHeight ?? 1.7) * 0.92, pz, s, view);
  }

  /** Terrain + solid-collider line of sight from a point to the target's chest or head. */
  private sees(ox: number, oy: number, oz: number, s: EntitySnapshot, view: EntityView): boolean {
    const ctx = this.ctx;
    for (const k of [0.55, 0.95]) {
      const tx = s.pos[0], ty = s.pos[1] + view.headHeight * k, tz = s.pos[2];
      const dx = tx - ox, dy = ty - oy, dz = tz - oz;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.5) return true;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      const reach = d - Math.max(0.3, view.radius * 0.8);
      if (reach <= 0) return true;
      if (ctx.terrain.raycast(ox, oy, oz, ux, uy, uz, reach)) continue;
      if (ctx.colliders.raycast([ox, oy, oz], [ux, uy, uz], reach, (c) => c.solid)) continue;
      return true;
    }
    return false;
  }
}

function readCamera(ctx: ClientContext) {
  ctx.camera.getWorldPosition(camPos);
  ctx.camera.getWorldDirection(camDir);
}

// ------------------------------------------------------------------ ground ring

const COLORS: Record<Disposition, THREE.Color> = {
  hostile: new THREE.Color(1.0, 0.22, 0.14),
  neutral: new THREE.Color(1.0, 0.62, 0.12),
  friendly: new THREE.Color(0.32, 0.9, 0.4),
};

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uPulse;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float aa = fwidth(r) * 1.5;
  float th = atan(vUv.y, vUv.x);
  // Crisp main rim.
  float rim = 1.0 - smoothstep(0.024, 0.024 + aa, abs(r - 0.84));
  // Three short outer arcs turning slowly (reads as "selected" without shouting).
  float seg = fract((th + uTime * 0.45) / 6.2831853 * 3.0);
  float arcs = (1.0 - smoothstep(0.018, 0.018 + aa, abs(r - 0.95))) * smoothstep(0.0, 0.03, seg) * (1.0 - smoothstep(0.24, 0.27, seg));
  // Faint fill fading toward the centre so the ground stays readable.
  float fill = smoothstep(0.15, 0.84, r) * (1.0 - smoothstep(0.82, 0.84, r)) * 0.14;
  // Engaged hostiles: a slow breathing glow on the rim.
  float pulse = uPulse * (0.5 + 0.5 * sin(uTime * 4.0)) * (1.0 - smoothstep(0.0, 0.12, abs(r - 0.84))) * 0.35;
  float a = (max(rim * 0.95, arcs * 0.75) + fill + pulse) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

/** Unlit, fog-free ground ring that follows the target and leans with the terrain. */
class TargetMarker {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private alpha = 0;
  private wantAlpha = 0;
  private popT = 1;
  private radius = 1;
  private color = new THREE.Color();
  private normal = new THREE.Vector3(0, 1, 0);
  private wantNormal = new THREE.Vector3(0, 1, 0);
  private ground = { x: NaN, z: NaN, y: NaN, t: 0 };
  private clock = 0;
  private q = new THREE.Quaternion();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(private ctx: ClientContext) {
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 } },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'target.ring';
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Brief scale-in when a target is (re)selected. */
  pop() {
    this.popT = 0;
  }

  show(s: EntitySnapshot, radius: number, disp: Disposition, opacity: number, engaged: boolean) {
    const [x, y, z] = s.pos;
    const g = this.ground;
    // Ground height & slope: re-sampled when the target moved or every 0.15 s (density lookups).
    if (Number.isNaN(g.y) || Math.hypot(x - g.x, z - g.z) > 0.2 || this.clock - g.t > 0.15 || Math.abs(y - g.y) > 1.5) {
      const terrain = this.ctx.terrain;
      const gy = terrain.groundBelow(x, y + 0.8, z, 2.6);
      g.x = x;
      g.z = z;
      g.t = this.clock;
      if (Number.isNaN(gy)) {
        // Flying, swimming or standing on a building floor: a level ring at the feet.
        g.y = y;
        this.wantNormal.set(0, 1, 0);
      } else {
        g.y = gy;
        const n = terrain.normal(x, gy, z, Math.max(0.35, Math.min(2.5, radius * 0.5)));
        this.wantNormal.set(n[0], n[1], n[2]);
        if (this.wantNormal.y < 0.35) this.wantNormal.set(0, 1, 0);
      }
    }
    this.color.copy(COLORS[disp]);
    if (!this.mesh.visible) {
      // Appearing: no tilt/colour easing from wherever the ring was last.
      this.normal.copy(this.wantNormal);
      (this.mat.uniforms.uColor.value as THREE.Color).copy(this.color);
    }
    this.radius = radius;
    // Feet below the sampled ground (interpolation) never sink the ring; flyers keep theirs.
    const baseY = Math.max(g.y, Math.min(y, g.y + 0.25));
    this.mesh.position.set(x, baseY, z).addScaledVector(this.normal, 0.06 + radius * 0.01);
    this.wantAlpha = opacity;
    this.mat.uniforms.uPulse.value = engaged ? 1 : 0;
    this.mesh.visible = true;
  }

  hide() {
    this.wantAlpha = 0;
  }

  update(dt: number) {
    this.clock += dt;
    if (!this.mesh.visible) return;
    this.alpha += (this.wantAlpha - this.alpha) * Math.min(1, dt * (this.wantAlpha > this.alpha ? 14 : 8));
    if (this.wantAlpha === 0 && this.alpha < 0.01) {
      this.alpha = 0;
      this.mesh.visible = false;
      return;
    }
    this.normal.lerp(this.wantNormal, Math.min(1, dt * 10)).normalize();
    this.q.setFromUnitVectors(TargetMarker.UP, this.normal);
    this.mesh.quaternion.copy(this.q);
    this.popT = Math.min(1, this.popT + dt / 0.22);
    const k = 1 + 0.35 * (1 - this.popT) * (1 - this.popT);
    this.mesh.scale.setScalar(this.radius * k);
    const u = this.mat.uniforms;
    (u.uColor.value as THREE.Color).lerp(this.color, Math.min(1, dt * 10));
    u.uOpacity.value = this.alpha * 0.9;
    u.uTime.value += dt;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
