/**
 * Destructible piece ids and the structural support graph.
 *
 * Ids: building pieces `B:<siteId>:<building>:<piece>` (building token is the
 * layout index, or `p<n>` for prop groups), POI pieces `P:<poiId>:<piece>`.
 * The server decides collapses (pieces whose supports are gone) so all
 * clients agree; clients only visualise the resulting object states.
 */
import type { Blueprint } from './build/kit';

export interface PieceRef {
  /** 'B' (settlement) or 'P' (point of interest). */
  kind: 'B' | 'P';
  /** Site id (B) or POI id (P). */
  owner: string;
  /** Building record id (`B:<site>:<token>` or `P:<poiId>`). */
  building: string;
  /** Building token within the site (`12`, `p5051`) — empty for POIs. */
  token: string;
  piece: number;
}

export function parsePieceId(id: string | number): PieceRef | null {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts[0] === 'B' && parts.length === 4) {
    const piece = Number(parts[3]);
    if (!Number.isInteger(piece)) return null;
    return { kind: 'B', owner: parts[1], building: `B:${parts[1]}:${parts[2]}`, token: parts[2], piece };
  }
  if (parts[0] === 'P' && parts.length === 3) {
    const piece = Number(parts[2]);
    if (!Number.isInteger(piece)) return null;
    return { kind: 'P', owner: parts[1], building: `P:${parts[1]}`, token: '', piece };
  }
  return null;
}

export function pieceId(buildingId: string, piece: number): string {
  return `${buildingId}:${piece}`;
}

/** Reverse support edges (who rests on piece i), cached per blueprint. */
const dependents = new WeakMap<Blueprint, number[][]>();

function dependentsOf(bp: Blueprint): number[][] {
  let d = dependents.get(bp);
  if (d) return d;
  d = bp.pieces.map(() => [] as number[]);
  bp.pieces.forEach((p, i) => {
    for (const s of p.sup) if (s >= 0 && s < bp.pieces.length) d![s].push(i);
  });
  dependents.set(bp, d);
  return d;
}

/**
 * Pieces that lose their footing once `destroyed` pieces are gone. A piece
 * with `need` > 0 falls when fewer than min(need, sup.length) of its supports
 * remain. Returns newly unsupported piece indices in collapse order
 * (breadth-first from the destroyed pieces, so cascades read naturally).
 */
export function unsupported(bp: Blueprint, isDestroyed: (i: number) => boolean, seeds: number[]): number[] {
  const deps = dependentsOf(bp);
  const gone = new Set<number>();
  const out: number[] = [];
  const queue = seeds.slice();
  const dead = (i: number) => gone.has(i) || isDestroyed(i);
  while (queue.length) {
    const i = queue.shift()!;
    for (const j of deps[i] ?? []) {
      if (dead(j)) continue;
      const p = bp.pieces[j];
      if (p.need <= 0 || !p.sup.length) continue;
      let alive = 0;
      for (const s of p.sup) if (!dead(s)) alive++;
      if (alive < Math.min(p.need, p.sup.length)) {
        gone.add(j);
        out.push(j);
        queue.push(j);
      }
    }
  }
  return out;
}
