/**
 * Tiny GOAP (goal-oriented action planning) solver.
 *
 * World state is a flat map of numeric facts (booleans are 0/1). Actions have
 * preconditions (fact >= value, or fact must be 0), set/add effects and a cost
 * that depends on the actor (personality makes a timid smith prefer posting a
 * quest over walking into the mine). A forward A* search finds the cheapest
 * action sequence that satisfies the goal facts. State spaces are tiny (≤ ~12
 * facts, ≤ ~8 actions), so the search is cheap enough to run on demand.
 */

export type Facts = Record<string, number>;

export interface PlanAction<C> {
  id: string;
  /** Facts that must be >= the given value. */
  pre: Facts;
  /** Facts that must be 0 / absent. */
  not?: string[];
  /** Facts set to the given value. */
  eff: Facts;
  /** Facts incremented by the given value. */
  add?: Facts;
  /** Cost (≥ 0.1). Personality & circumstances shape it. */
  cost(c: C): number;
  /** Optional runtime gate (e.g. "no linked town exists"). */
  usable?(c: C): boolean;
}

function satisfied(s: Facts, goal: Facts): boolean {
  for (const k in goal) if ((s[k] ?? 0) < goal[k]) return false;
  return true;
}

function applicable<C>(s: Facts, a: PlanAction<C>): boolean {
  for (const k in a.pre) if ((s[k] ?? 0) < a.pre[k]) return false;
  if (a.not) for (const k of a.not) if ((s[k] ?? 0) > 0) return false;
  return true;
}

function keyOf(s: Facts): string {
  return Object.keys(s)
    .filter((k) => s[k])
    .sort()
    .map((k) => k + '=' + Math.round(s[k] * 100))
    .join(',');
}

function unsatisfiedCount(s: Facts, goal: Facts): number {
  let n = 0;
  for (const k in goal) if ((s[k] ?? 0) < goal[k]) n++;
  return n;
}

/**
 * Plan from `start` to a state satisfying `goal`. Returns the action ids, an
 * empty array when the goal already holds, or null when no plan exists.
 */
export function plan<C>(start: Facts, goal: Facts, actions: PlanAction<C>[], ctx: C, blocked: string[] = [], maxDepth = 7): string[] | null {
  if (satisfied(start, goal)) return [];
  const usable = actions.filter((a) => !blocked.includes(a.id) && (!a.usable || a.usable(ctx)));
  const costs = new Map<string, number>();
  for (const a of usable) costs.set(a.id, Math.max(0.1, a.cost(ctx)));
  interface Node { s: Facts; g: number; f: number; path: string[] }
  const open: Node[] = [{ s: start, g: 0, f: unsatisfiedCount(start, goal), path: [] }];
  const best = new Map<string, number>();
  best.set(keyOf(start), 0);
  let expanded = 0;
  while (open.length && expanded++ < 600) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const node = open.splice(bi, 1)[0];
    if (satisfied(node.s, goal)) return node.path;
    if (node.path.length >= maxDepth) continue;
    for (const a of usable) {
      if (!applicable(node.s, a)) continue;
      const s: Facts = { ...node.s, ...a.eff };
      if (a.add) for (const k in a.add) s[k] = (s[k] ?? 0) + a.add[k];
      const k = keyOf(s);
      const g = node.g + costs.get(a.id)!;
      if ((best.get(k) ?? Infinity) <= g) continue;
      best.set(k, g);
      open.push({ s, g, f: g + unsatisfiedCount(s, goal) * 0.5, path: [...node.path, a.id] });
    }
  }
  return null;
}
