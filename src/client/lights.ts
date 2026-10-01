/**
 * Dynamic point light budget: entities with `snap.light`, carried torches and
 * lanterns get one of a few pooled point lights, nearest to the camera first.
 */
import * as THREE from 'three';
import type { EntitySnapshot } from '../shared/protocol';
import type { EntityView } from './context';
import type { EntityId } from '../shared/types';

const POOL = 8;
const LIGHT_ITEMS: Record<string, { color: [number, number, number]; intensity: number; radius: number }> = {
  torch: { color: [1.0, 0.62, 0.3], intensity: 1, radius: 14 },
  lantern: { color: [1.0, 0.78, 0.45], intensity: 0.9, radius: 12 },
  lantern_brass: { color: [1.0, 0.78, 0.45], intensity: 0.9, radius: 12 },
  glowstone: { color: [0.5, 0.85, 1.0], intensity: 0.8, radius: 9 },
};

/** Held light source item, if any (lights carried in hand follow the hand socket). */
function heldLight(snap: EntitySnapshot) {
  const eq = snap.equipment;
  if (!eq) return null;
  for (const slot of ['offhand', 'mainhand'] as const) {
    const it = eq[slot];
    if (it && LIGHT_ITEMS[it.defId]) return LIGHT_ITEMS[it.defId];
  }
  return null;
}

/**
 * Light emitted by an entity. `intensity` is relative (≈0..1.5); the light manager
 * converts it to a physical intensity that reaches roughly `radius` meters.
 */
export function lightOf(snap: EntitySnapshot): { color: [number, number, number]; intensity: number; radius: number } | null {
  return snap.light ?? heldLight(snap);
}

export class LightManager {
  private lights: THREE.PointLight[] = [];
  private flicker = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      // Always visible (intensity 0 when idle): toggling visibility changes the scene's
      // light count, which forces every material to recompile its shader.
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.6);
      scene.add(l);
      this.lights.push(l);
    }
  }

  update(dt: number, camPos: THREE.Vector3, entries: { id: EntityId; snap: EntitySnapshot; view?: EntityView }[]) {
    this.flicker += dt;
    const cands: { d: number; pos: THREE.Vector3; l: NonNullable<ReturnType<typeof lightOf>>; torch: boolean }[] = [];
    const tmp = new THREE.Vector3();
    for (const e of entries) {
      const l = lightOf(e.snap);
      if (!l) continue;
      const held = heldLight(e.snap);
      const sock = held ? e.view?.getSocket?.(e.snap.equipment?.offhand && LIGHT_ITEMS[e.snap.equipment.offhand.defId] ? 'hand.L' : 'hand.R') ?? null : null;
      const pos = new THREE.Vector3();
      if (sock) {
        // At the flame, nudged away from the holder's body axis so the light falls on
        // the surroundings rather than flooding the character carrying it.
        sock.getWorldPosition(pos);
        pos.y += 0.4;
        const dx = pos.x - e.snap.pos[0], dz = pos.z - e.snap.pos[2];
        const r = Math.hypot(dx, dz);
        if (r > 1e-3) {
          const push = Math.max(0, 0.75 - r) / r;
          pos.x += dx * push;
          pos.z += dz * push;
        }
      } else pos.set(e.snap.pos[0], e.snap.pos[1] + (held ? 1.4 : 0.5), e.snap.pos[2]);
      const d = tmp.copy(pos).sub(camPos).lengthSq();
      cands.push({ d, pos, l, torch: !!held });
    }
    cands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < POOL; i++) {
      const L = this.lights[i];
      const c = cands[i];
      if (!c) {
        L.intensity = 0;
        continue;
      }
      L.position.copy(c.pos);
      L.color.setRGB(c.l.color[0], c.l.color[1], c.l.color[2]);
      const fl = c.torch ? 0.85 + 0.15 * Math.sin(this.flicker * 13 + i * 3) * Math.sin(this.flicker * 7.3 + i) : 1;
      // Linear falloff with a physical intensity scaled so the light still reaches its
      // radius: much flatter than inverse-square, so whatever is right next to the flame
      // (the holder) isn't blown out while the area around stays lit.
      L.intensity = c.l.intensity * c.l.radius * 0.8 * fl;
      L.distance = c.l.radius * 1.6;
      L.decay = 1;
    }
  }
}
