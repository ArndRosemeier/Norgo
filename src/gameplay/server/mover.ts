/**
 * Displacement of server-simulated bodies (creatures, NPCs, loose items) by
 * knockback, pushes, pulls, gravity fields and dashes. Players are moved by
 * their own client (knockback events); everything else is integrated here
 * for the short time it is airborne/sliding, with terrain collision, local
 * gravity and fall damage. Owning AI systems keep steering as usual — they
 * should read `isDisplaced(ctx, id)` to pause locomotion while flung.
 */
import type { ServerEntity } from '../../server/entity';
import type { EntityId, Vec3 } from '../../shared/types';
import type { GameplaySystem } from './GameplaySystem';
import { effectiveGravity } from './zones';

interface Motion {
  vel: Vec3;
  until: number;
  airborne: boolean;
}

export class Mover {
  private moving = new Map<EntityId, Motion>();

  constructor(private g: GameplaySystem) {}

  isMoving(id: EntityId) {
    return this.moving.has(id);
  }

  push(e: ServerEntity, imp: Vec3) {
    if (e.kind === 'player' || e.tags.has('immovable')) return;
    const now = this.g.ctx.time.now;
    let m = this.moving.get(e.id);
    if (!m) this.moving.set(e.id, (m = { vel: [0, 0, 0], until: 0, airborne: false }));
    m.vel[0] += imp[0];
    m.vel[1] += imp[1];
    m.vel[2] += imp[2];
    m.until = now + 6;
    if (imp[1] > 0.5) m.airborne = true;
  }

  tick(dt: number) {
    if (!this.moving.size) return;
    const ctx = this.g.ctx;
    const now = ctx.time.now;
    for (const [id, m] of this.moving) {
      const e = ctx.entities.get(id);
      if (!e || now > m.until || (!e.alive && e.kind !== 'item')) {
        this.moving.delete(id);
        continue;
      }
      const grav = effectiveGravity(ctx, e.pos, e);
      m.vel[1] -= grav * dt;
      const nx = e.pos[0] + m.vel[0] * dt, ny = e.pos[1] + m.vel[1] * dt, nz = e.pos[2] + m.vel[2] * dt;
      const h = Math.max(0.4, e.height * e.scale);
      // Walls: stop horizontal motion if the body would enter rock at chest height.
      let x = nx, z = nz;
      if (ctx.terrain.density(nx, e.pos[1] + h * 0.6, nz) > 0) {
        x = e.pos[0];
        z = e.pos[2];
        m.vel[0] *= -0.2;
        m.vel[2] *= -0.2;
      }
      let y = ny;
      const ground = ctx.groundAt(x, Math.max(e.pos[1], ny) + h * 0.5, z, h * 0.5 + Math.max(1, -m.vel[1] * dt * 2));
      if (!Number.isNaN(ground) && y <= ground + 0.02 && m.vel[1] <= 0) {
        y = ground;
        if (m.airborne && e.kind !== 'item') {
          const v = -m.vel[1];
          const safe = 13 * Math.sqrt(Math.max(0.1, ctx.gravityAt(e.pos)) / 9.81);
          if (v > safe) this.g.damage(e, Math.pow(v - safe, 1.6) * 2.2, 'fall');
        }
        m.airborne = false;
        m.vel[1] = 0;
        const fr = Math.exp(-(e.kind === 'item' ? 5 : 9) * dt);
        m.vel[0] *= fr;
        m.vel[2] *= fr;
      } else {
        m.airborne = true;
        // Air drag keeps flung bodies from flying forever in light gravity.
        const dr = Math.exp(-0.15 * dt);
        m.vel[0] *= dr;
        m.vel[2] *= dr;
      }
      if (ctx.terrain.density(x, y + 0.05, z) > 0.5) {
        // Never bury a body: push it back up.
        const up = ctx.groundAt(x, y + h + 2, z, h + 3);
        if (!Number.isNaN(up)) y = up;
      }
      e.pos = [x, y, z];
      e.vel = [m.vel[0], m.vel[1], m.vel[2]];
      e.grounded = !m.airborne;
      e.dirty = true;
      ctx.entities.reindex(e);
      if (!m.airborne && Math.hypot(m.vel[0], m.vel[2]) < 0.25 && grav > 0) {
        e.vel = [0, 0, 0];
        this.moving.delete(id);
      }
    }
  }

  forget(id: EntityId) {
    this.moving.delete(id);
  }
}
