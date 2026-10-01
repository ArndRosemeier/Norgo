/**
 * Snapshot interpolation for remote entities: render ~110 ms in the past and
 * interpolate between buffered server snapshots for smooth motion at 10 Hz.
 */
import type { EntitySnapshot } from '../shared/protocol';
import type { EntityId } from '../shared/types';
import { lerpAngle } from '../core/math';

interface Buffered {
  t: number;
  s: EntitySnapshot;
}

export const INTERP_DELAY = 0.11;

export class SnapshotBuffer {
  private buf = new Map<EntityId, Buffered[]>();
  /** Estimated server time on the client clock. */
  private offset = 0;
  private offsetInit = false;

  /** Record a server snapshot batch. */
  push(serverTime: number, clientTime: number, snaps: EntitySnapshot[]) {
    const off = serverTime - clientTime;
    if (!this.offsetInit) {
      this.offset = off;
      this.offsetInit = true;
    } else this.offset += (off - this.offset) * 0.1;
    for (const s of snaps) {
      let b = this.buf.get(s.id);
      if (!b) this.buf.set(s.id, (b = []));
      b.push({ t: serverTime, s });
      if (b.length > 8) b.shift();
    }
  }

  remove(id: EntityId) {
    this.buf.delete(id);
  }

  serverNow(clientTime: number) {
    return clientTime + this.offset;
  }

  ids() {
    return this.buf.keys();
  }

  /** Interpolated snapshot at render time (reuses `out` object when provided). */
  sample(id: EntityId, clientTime: number): EntitySnapshot | null {
    const b = this.buf.get(id);
    if (!b || !b.length) return null;
    const t = clientTime + this.offset - INTERP_DELAY;
    if (t <= b[0].t || b.length === 1) return b[0].s;
    for (let i = 0; i < b.length - 1; i++) {
      const a = b[i], c = b[i + 1];
      if (t >= a.t && t <= c.t) {
        const k = (t - a.t) / Math.max(1e-4, c.t - a.t);
        return mixSnap(a.s, c.s, k);
      }
    }
    // Extrapolate briefly past the newest snapshot.
    const last = b[b.length - 1];
    const ex = Math.min(0.25, t - last.t);
    if (ex <= 0) return last.s;
    return {
      ...last.s,
      pos: [last.s.pos[0] + last.s.vel[0] * ex, last.s.pos[1] + last.s.vel[1] * ex, last.s.pos[2] + last.s.vel[2] * ex],
    };
  }
}

function mixSnap(a: EntitySnapshot, b: EntitySnapshot, k: number): EntitySnapshot {
  return {
    ...b,
    pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * k, a.pos[1] + (b.pos[1] - a.pos[1]) * k, a.pos[2] + (b.pos[2] - a.pos[2]) * k],
    vel: [a.vel[0] + (b.vel[0] - a.vel[0]) * k, a.vel[1] + (b.vel[1] - a.vel[1]) * k, a.vel[2] + (b.vel[2] - a.vel[2]) * k],
    yaw: lerpAngle(a.yaw, b.yaw, k),
    hp: a.hp + (b.hp - a.hp) * k,
  };
}
