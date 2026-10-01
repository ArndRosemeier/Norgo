/**
 * Entity views for players and NPCs: MakeHuman-based bodies built in a
 * worker (placeholder capsule until ready, builds prioritized by camera
 * distance, identical appearances share geometry), procedural animation,
 * equipment, LODs with throttled far animation, sky occlusion and sockets.
 */
import type * as THREE from 'three';
import type { ClientContext, ClientModule, EntityView, EntityViewFactory } from '../../client/context';
import type { EntitySnapshot, GameEvent } from '../../shared/protocol';
import { BodyService, geometryKey } from './BodyService';
import { HumanoidRig } from './HumanoidRig';
import { randomAppearance } from '../appearance';
import type { GroundFn } from './anim/Animator';

export class HumanoidViews implements EntityViewFactory, ClientModule {
  readonly name = 'humanoids';
  readonly kinds = ['player' as const, 'npc' as const];
  private ctx: ClientContext | null = null;
  private collectT = 0;

  async init(ctx: ClientContext) {
    this.ctx = ctx;
    // Preload assets and shared GPU data; views created before this resolves show placeholders.
    BodyService.get().ready().catch((e) => console.error('[humanoid] asset load failed', e));
  }

  update(dt: number) {
    this.collectT += dt;
    if (this.collectT > 10) {
      this.collectT = 0;
      BodyService.get().collect();
    }
  }

  create(snap: EntitySnapshot, ctx: ClientContext): EntityView | null {
    this.ctx ??= ctx;
    const app = snap.humanoid ?? (snap.kind === 'npc' ? randomAppearance('human', snap.id) : null);
    if (!app) return null;
    const cam = ctx.camera.position;
    const dist = Math.hypot(snap.pos[0] - cam.x, snap.pos[1] - cam.y, snap.pos[2] - cam.z);
    const isPlayer = snap.kind === 'player';
    const terrain = ctx.terrain;
    const ground: GroundFn = (x, y, z) => {
      const g = terrain.groundBelow(x, y, z, 1.4);
      return Number.isFinite(g) ? g : null;
    };
    const rig = new HumanoidRig(app, { priority: isPlayer && snap.id === ctx.state.playerId ? -1 : dist, ground, alwaysDrawn: isPlayer });
    let key = geometryKey(app);
    let appRef = snap.humanoid;
    const view: EntityView = {
      object: rig.object,
      get headHeight() { return rig.height * (snap.scale ?? 1) + 0.12; },
      get radius() { return 0.38 * rig.app.scale * (snap.scale ?? 1); },
      update(s: EntitySnapshot, dt: number, time: number) {
        if (s.humanoid && s.humanoid !== appRef) {
          appRef = s.humanoid;
          const k = geometryKey(s.humanoid);
          if (k !== key || JSON.stringify(s.humanoid) !== JSON.stringify(rig.app)) {
            key = k;
            void rig.setAppearance(s.humanoid);
          }
        }
        rig.update(s, dt, time, ctx.camera.position);
      },
      onEvent(ev: GameEvent) {
        if (ev.type === 'damage') {
          // Recoil away from the attacker (or from the impact point).
          const src = ev.source !== undefined ? ctx.state.entities.get(ev.source) : undefined;
          const from = src?.pos ?? ev.pos;
          rig.onHit(from[0], from[2], Math.min(1.5, 0.3 + ev.amount / 25));
        }
        else if (ev.type === 'knockback') rig.onHit(rig.object.position.x - ev.impulse[0], rig.object.position.z - ev.impulse[2], 1.2);
      },
      getSocket(name: string): THREE.Object3D | null {
        return rig.getSocket(name);
      },
      setVisible(v: boolean) {
        rig.setVisible(v);
      },
      setSkyVis(v: number) {
        rig.setSkyVis(v);
      },
      dispose() {
        rig.dispose();
      },
    };
    return view;
  }
}
