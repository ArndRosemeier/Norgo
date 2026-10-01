/**
 * Status-effect auras. The server replicates active effect visuals as fx tags
 * ("a:<fx>") on EntitySnapshot.fx; every frame we emit rate-limited particles
 * around the entity's interpolated view (body, head, feet or weapon hand),
 * and keep a force-field bubble on shielded entities. Invisible entities only
 * show their auras to themselves.
 */
import * as THREE from 'three';
import type { EntityView } from '../../client/context';
import type { EntitySnapshot } from '../../shared/protocol';
import { EntFlag, type EntityId } from '../../shared/types';
import { MeshFxKind } from './pools';
import { FxLibrary, opts, STYLES, type Style } from './fxLibrary';

type At = 'body' | 'head' | 'feet' | 'hand' | 'halo' | 'orbit';

interface AuraDef {
  style: Style;
  rate: number;
  at: At;
  color?: [number, number, number];
  speed?: number;
  up?: number;
  size?: number;
  /** Only while moving (speed lines). */
  moving?: boolean;
  /** Accumulator key (precomputed so the hot loop never builds strings). */
  key?: string;
}

const A = (style: Style, rate: number, at: At, o: Partial<AuraDef> = {}): AuraDef => ({ style, rate, at, ...o });

/** Tag → look. Keys include the "a:" prefix so no string slicing is needed per frame. */
const AURAS: Record<string, AuraDef[]> = {
  'a:burning': [A(STYLES.fire, 34, 'body', { up: 1 }), A(STYLES.ember, 8, 'body', { up: 1.2 }), A(STYLES.smoke, 4, 'head', { up: 1, size: 0.8 })],
  'a:poison': [A(STYLES.bubble, 7, 'body', { up: 0.4 })],
  'a:bleed': [A(STYLES.blood, 7, 'body', { speed: 0.5 })],
  'a:shock': [A(STYLES.spark, 14, 'body', { speed: 3, color: [0.4, 0.6, 1.4] })],
  'a:shadow': [A(STYLES.wisp, 6, 'body', { up: 0.5, size: 0.7 })],
  'a:regen': [A(STYLES.mote, 7, 'body', { up: 1, color: [0.4, 1.4, 0.5] })],
  'a:mana': [A(STYLES.mote, 7, 'body', { up: 1, color: [0.5, 0.8, 2] })],
  'a:chill': [A(STYLES.snowflake, 5, 'body', { speed: 0.3 }), A(STYLES.mist, 2, 'body', { size: 0.6 })],
  'a:frozen': [A(STYLES.frost, 10, 'body', { speed: 0.4 }), A(STYLES.mist, 4, 'body', { size: 0.8 })],
  'a:wet': [A(STYLES.blood, 6, 'body', { speed: 0.2, color: [1.2, 1.8, 2.6] })],
  'a:blind': [A(STYLES.wisp, 4, 'head', { size: 0.4 })],
  'a:fear': [A(STYLES.shadowGlow, 5, 'head', { up: 0.6 }), A(STYLES.wisp, 3, 'head', { size: 0.4 })],
  'a:calm': [A(STYLES.mote, 3, 'head', { up: 0.5, color: [0.6, 1.4, 0.9] })],
  'a:charm': [A(STYLES.heart, 2, 'head', { up: 0.6 })],
  'a:sleep': [A(STYLES.zzz, 0.9, 'head', { up: 0.4 })],
  'a:silence': [A(STYLES.ring, 1.2, 'head', { color: [0.6, 0.6, 0.7] })],
  'a:stun': [A(STYLES.star, 9, 'orbit', { color: [1.6, 1.4, 0.6] })],
  'a:stagger': [A(STYLES.star, 4, 'orbit', { color: [1, 1, 1] })],
  'a:roots': [A(STYLES.leaf, 5, 'feet', { up: 0.8 })],
  'a:slow': [A(STYLES.mist, 2, 'feet', { size: 0.5, color: [0.6, 0.7, 1] })],
  'a:haste': [A(STYLES.streak, 12, 'feet', { color: [1.4, 1.4, 1.8], moving: true })],
  'a:feather': [A(STYLES.leaf, 2.5, 'body', { color: [3, 3, 3], speed: 0.3 })],
  'a:levitate': [A(STYLES.glow, 8, 'feet', { color: [0.9, 0.7, 1.8], up: -0.4, size: 0.6 })],
  'a:gravlow': [A(STYLES.mote, 6, 'feet', { up: 1.2, color: [1, 0.7, 2] })],
  'a:gravhigh': [A(STYLES.ring, 2, 'head', { color: [1.2, 0.6, 2], up: -2.5 }), A(STYLES.dust, 3, 'feet', { size: 0.5 })],
  'a:frostfeet': [A(STYLES.mist, 4, 'feet', { size: 0.5 })],
  'a:grip': [A(STYLES.mote, 3, 'hand', { color: [1.2, 1, 0.7] })],
  'a:water': [A(STYLES.bubble, 3, 'body', { color: [0.6, 1.2, 2] })],
  'a:leap': [A(STYLES.mote, 5, 'feet', { up: 1.5, color: [1.6, 1.4, 0.8] })],
  'a:glide': [A(STYLES.streak, 8, 'body', { color: [1.2, 1.2, 1.4], moving: true })],
  'a:phase': [A(STYLES.shadowGlow, 16, 'body', { color: [0.7, 0.9, 1.6] })],
  'a:shield': [],
  'a:stone': [A(STYLES.chunk, 2, 'body', { speed: 0.3 })],
  'a:fortify': [A(STYLES.mote, 3, 'body', { color: [1.4, 1.2, 0.8] })],
  'a:ward': [A(STYLES.rune, 2.5, 'orbit', { color: [0.4, 1.8, 1.5] })],
  'a:reflect': [A(STYLES.hex, 4, 'body', { color: [1.4, 1.6, 2.2] })],
  'a:riposte': [A(STYLES.spark, 6, 'hand', { speed: 0.6 })],
  'a:evasive': [A(STYLES.streak, 6, 'body', { color: [1.2, 1.2, 1.4] })],
  'a:unstoppable': [A(STYLES.ember, 8, 'feet', { color: [1.4, 0.8, 0.5], up: 1 })],
  'a:flamecloak': [A(STYLES.fire, 28, 'body', { up: 1.2, size: 0.8 }), A(STYLES.ember, 6, 'body', { up: 1 })],
  'a:frostarmor': [A(STYLES.frost, 8, 'body', { speed: 0.3 }), A(STYLES.snowflake, 3, 'body')],
  'a:thorns': [A(STYLES.leaf, 3, 'body', { color: [0.6, 0.4, 0.2] })],
  'a:courage': [A(STYLES.mote, 2, 'head', { color: [2, 1.6, 0.6] })],
  'a:halo': [A(STYLES.star, 10, 'halo', { color: [2.2, 1.9, 1.1] })],
  'a:ench_fire': [A(STYLES.fire, 22, 'hand', { size: 0.4, up: 0.6 })],
  'a:ench_frost': [A(STYLES.frost, 14, 'hand', { speed: 0.3 })],
  'a:ench_shock': [A(STYLES.spark, 18, 'hand', { speed: 1.5, color: [0.5, 0.7, 1.6] })],
  'a:ench_radiant': [A(STYLES.star, 10, 'hand', { color: [2, 1.7, 0.9] })],
  'a:ench_poison': [A(STYLES.bubble, 8, 'hand', { size: 0.6 })],
  'a:rage': [A(STYLES.ember, 10, 'body', { color: [1.6, 0.25, 0.2], up: 1 })],
  'a:focus': [A(STYLES.mote, 2, 'head', { color: [1.6, 1.6, 2] })],
  'a:empower': [A(STYLES.rune, 3, 'orbit', { color: [1.4, 0.9, 2.2] })],
  'a:inspire': [A(STYLES.mote, 4, 'body', { color: [2, 1.6, 0.6], up: 0.8 })],
  'a:wind': [A(STYLES.streak, 6, 'body', { color: [1.2, 1.4, 1.2] })],
  'a:spirit': [A(STYLES.wisp, 4, 'feet', { color: [3, 3, 3.4], size: 0.6 })],
  'a:invis': [A(STYLES.shadowGlow, 3, 'body', { color: [0.6, 0.7, 1] })],
  'a:shadowcloak': [A(STYLES.wisp, 7, 'body', { size: 0.6 })],
  'a:glow': [A(STYLES.mote, 3, 'body', { color: [1.8, 1.6, 1.2] })],
  'a:warm': [A(STYLES.ember, 1.5, 'body', { up: 0.6 })],
  'a:bond': [A(STYLES.heart, 0.3, 'head', { up: 0.5 })],
  'a:marked': [A(STYLES.ring, 1.5, 'head', { color: [2.4, 0.4, 0.3] })],
  'a:exposed': [A(STYLES.star, 3, 'body', { color: [1.8, 1.5, 0.7] })],
  'a:vulnerable': [A(STYLES.shard, 3, 'body', { color: [2, 0.4, 0.3] })],
  'a:weak': [A(STYLES.mist, 2, 'body', { color: [0.5, 0.5, 0.5], size: 0.5 })],
  'a:taunt': [A(STYLES.ember, 3, 'head', { color: [2, 0.4, 0.3] })],
  'a:distract': [A(STYLES.mote, 1.5, 'head', { color: [1.4, 1.4, 1.4] })],
  'a:block': [],
};

for (const [tag, defs] of Object.entries(AURAS)) defs.forEach((d, k) => (d.key = k === 0 ? tag : tag + '#' + k));
const MAX_DIST2 = 70 * 70;
const pos = new THREE.Vector3();
const hand = new THREE.Vector3();

export class AuraEmitter {
  private acc = new Map<EntityId, Map<string, number>>();
  private shielded = new Map<EntityId, THREE.Object3D>();
  private seen = new Set<EntityId>();

  constructor(private lib: FxLibrary) {}

  update(dt: number, entities: Map<EntityId, EntitySnapshot>, views: Map<EntityId, EntityView>, cam: THREE.Vector3, localId: EntityId) {
    const lib = this.lib;
    this.seen.clear();
    for (const [id, snap] of entities) {
      const tags = snap.fx;
      if (!tags || !tags.length) continue;
      const view = views.get(id);
      const obj = view?.object;
      if (obj) pos.copy(obj.position);
      else pos.set(snap.pos[0], snap.pos[1], snap.pos[2]);
      if (pos.distanceToSquared(cam) > MAX_DIST2) continue;
      const invisible = (snap.flags & EntFlag.Invisible) !== 0 && id !== localId;
      const h = Math.max(0.6, view?.headHeight ?? 1.8 * (snap.scale ?? 1));
      const r = Math.max(0.25, (view?.radius ?? 0.35) * 0.9);
      const moving = Math.abs(snap.vel[0]) + Math.abs(snap.vel[2]) > 1;
      let acc = this.acc.get(id);
      for (const tag of tags) {
        if (tag === 'a:shield') {
          this.seen.add(id);
          if (obj && !this.shielded.has(id) && !invisible) {
            lib.meshes.spawn(MeshFxKind.Bubble, pos, pos, h * 0.62, 3600, [0.4, 0.7, 1.4], obj);
            this.shielded.set(id, obj);
          }
          continue;
        }
        const defs = AURAS[tag];
        // Invisible entities keep their secrets (only their owner sees their auras).
        if (!defs || invisible) continue;
        if (!acc) this.acc.set(id, (acc = new Map()));
        for (let k = 0; k < defs.length; k++) {
          const d = defs[k];
          if (d.moving && !moving) continue;
          const key = d.key!;
          let a = (acc.get(key) ?? Math.random()) + d.rate * dt;
          const n = Math.floor(a);
          a -= n;
          acc.set(key, a);
          if (!n) continue;
          const o = opts();
          o.color = d.color ?? null;
          o.speed = d.speed ?? 0.25;
          o.up = d.up ?? 0;
          o.sizeMul = d.size ?? 1;
          for (let i = 0; i < n; i++) {
            let x = pos.x, y = pos.y, z = pos.z;
            switch (d.at) {
              case 'body': {
                const a2 = Math.random() * 6.2832, rr = r * Math.sqrt(Math.random());
                x += Math.cos(a2) * rr;
                z += Math.sin(a2) * rr;
                y += h * (0.1 + Math.random() * 0.8);
                break;
              }
              case 'head':
                y += h + 0.15;
                x += (Math.random() - 0.5) * 0.3;
                z += (Math.random() - 0.5) * 0.3;
                break;
              case 'feet': {
                const a2 = Math.random() * 6.2832;
                x += Math.cos(a2) * r;
                z += Math.sin(a2) * r;
                y += 0.05;
                break;
              }
              case 'hand': {
                const sock = view?.getSocket?.('hand.R');
                if (sock) {
                  sock.getWorldPosition(hand);
                  x = hand.x + (Math.random() - 0.5) * 0.15;
                  y = hand.y + Math.random() * 0.5;
                  z = hand.z + (Math.random() - 0.5) * 0.15;
                } else y += h * 0.55;
                break;
              }
              case 'halo':
              case 'orbit': {
                const a2 = (performance.now() / 1000) * (d.at === 'halo' ? 1.5 : 3) + Math.random() * 0.6;
                const rr = d.at === 'halo' ? 0.28 : r + 0.25;
                x += Math.cos(a2) * rr;
                z += Math.sin(a2) * rr;
                y += d.at === 'halo' ? h + 0.3 : h + 0.1;
                break;
              }
            }
            lib.emit(d.style, x, y, z, 1, o);
          }
        }
      }
    }
    // Drop bubbles of entities that lost their shield (or vanished).
    for (const [id, obj] of this.shielded) {
      if (this.seen.has(id)) continue;
      lib.meshes.releaseFollower(obj);
      this.shielded.delete(id);
    }
    if (this.acc.size > 512) for (const id of this.acc.keys()) if (!entities.has(id)) this.acc.delete(id);
  }

  forget(id: EntityId) {
    this.acc.delete(id);
    const obj = this.shielded.get(id);
    if (obj) {
      this.lib.meshes.releaseFollower(obj);
      this.shielded.delete(id);
    }
  }
}
