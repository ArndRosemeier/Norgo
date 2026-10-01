/**
 * Text toolkit for the game master: a tiny combinatorial template language,
 * an anti-repetition memory, and helpers that turn numbers into evocative words
 * (directions, distances, times of day).
 *
 * Template syntax:
 *   {a|b|c}      pick one alternative (alternatives may nest: {a {x|y}|b})
 *   {?text}      optional: included half of the time
 *   $name        substitute vars.name (missing vars collapse to '')
 * After expansion "a"/"an" are fixed, whitespace is tidied and the first letter
 * is capitalised, so templates can be written naturally.
 *
 * Pure & shared (no server imports) so dialog/NPC code can reuse it.
 */
import { Rng, hashString } from '../core/rng';

export type Vars = Record<string, string | number | undefined | null>;

/** Expand a template with the given RNG and variables. */
export function expand(template: string, rng: Rng, vars: Vars = {}): string {
  let s = expandBraces(template, rng);
  s = s.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
  return tidy(s);
}

/** Resolve {a|b} groups innermost-first so nesting works. */
function expandBraces(t: string, rng: Rng): string {
  let guard = 0;
  while (t.includes('{') && guard++ < 200) {
    // Innermost group: a '{' followed by no other brace until '}'.
    const m = /\{([^{}]*)\}/.exec(t);
    if (!m) break;
    const body = m[1];
    let rep: string;
    if (body.startsWith('?')) rep = rng.chance(0.5) ? body.slice(1) : '';
    else {
      const opts = body.split('|');
      rep = opts[Math.floor(rng.float() * opts.length)];
    }
    t = t.slice(0, m.index) + rep + t.slice(m.index + m[0].length);
  }
  return t;
}

/** Article agreement, spacing and capitalisation fixes. */
export function tidy(s: string): string {
  s = s.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?=[^\s\d])/g, '$1 ');
  s = s.replace(/\b([Aa]) (?=[aeiouAEIOU])(?!(?:one|uni|use|usu|eu|ur)\w*)/g, (_, a: string) => (a === 'A' ? 'An ' : 'an '));
  s = s.replace(/\b([Aa]n) (?=[^aeiouAEIOU\s])(?!(?:hour|honest|honou?r|heir)\w*)/g,(_, a: string) => (a === 'An' ? 'A ' : 'a '));
  s = s.replace(/([^.])\.\s+\.(?!\.)/g, '$1.').trim();
  // Capitalise sentence starts.
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  return s;
}

export function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "a", "a and b", "a, b and c". */
export function list(items: string[], conj = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(', ') + ' ' + conj + ' ' + items[items.length - 1];
}

/**
 * Compass words. Norgo maps use north = −Z (the direction a yaw of 0 faces) and
 * east = +X, matching three.js' default top-down orientation.
 */
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function compass(dx: number, dz: number): string {
  const ang = Math.atan2(dx, -dz); // 0 = north, +π/2 = east
  const i = Math.round(((ang / (Math.PI * 2)) * 8 + 8)) % 8;
  return COMPASS[i];
}

/** Evocative distance description. */
export function distanceWords(m: number): string {
  if (m < 40) return 'a stone\'s throw away';
  if (m < 120) return 'close by';
  if (m < 350) return `some ${Math.round(m / 50) * 50} paces off`;
  if (m < 900) return `perhaps ${Math.round(m / 100) * 100} paces away`;
  if (m < 2500) return 'an hour\'s walk away';
  if (m < 6000) return 'a long day\'s march away';
  return 'many days\' journey away';
}

/** "to the northeast, some 300 paces off". */
export function bearing(from: { x: number; z: number }, to: { x: number; z: number }): string {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 25) return 'right here';
  return `to the ${compass(dx, dz)}, ${distanceWords(d)}`;
}

export function hourWords(hour: number): string {
  if (hour < 4) return 'the dead of night';
  if (hour < 6) return 'the grey hour before dawn';
  if (hour < 8) return 'early morning';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 19) return 'evening';
  if (hour < 21) return 'dusk';
  return 'night';
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function numberWord(n: number): string {
  const w = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return n >= 0 && n < w.length ? w[n] : String(n);
}

// ------------------------------------------------------------------ variety

export interface VarietyState {
  /** key → recently used option indices (most recent last). */
  recent: Record<string, number[]>;
  /** Hashes of recently produced sentences. */
  said: number[];
}

/**
 * Remembers which template variants and which exact sentences were used
 * recently, so the narrator never repeats itself verbatim and rotates through
 * template pools before reusing one.
 */
export class VarietyMemory {
  private recent = new Map<string, number[]>();
  private said: number[] = [];
  private saidSet = new Set<number>();
  constructor(private readonly maxSaid = 400) {}

  /** Choose an index from `n` options, avoiding the most recently used ones. */
  pickIndex(key: string, n: number, rng: Rng): number {
    if (n <= 1) return 0;
    const used = this.recent.get(key) ?? [];
    const avoid = new Set(used.slice(-Math.max(1, Math.floor(n * 0.6))));
    const free: number[] = [];
    for (let i = 0; i < n; i++) if (!avoid.has(i)) free.push(i);
    const idx = free.length ? free[Math.floor(rng.float() * free.length)] : Math.floor(rng.float() * n);
    used.push(idx);
    if (used.length > 24) used.shift();
    this.recent.set(key, used);
    return idx;
  }

  pick<T>(key: string, options: readonly T[], rng: Rng): T {
    return options[this.pickIndex(key, options.length, rng)];
  }

  /**
   * Expand a template from a pool, retrying until the produced sentence has not
   * been said recently (combinatorial templates make this cheap).
   */
  compose(key: string, pool: readonly string[], rng: Rng, vars: Vars = {}): string {
    let text = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      text = expand(this.pick(key, pool, rng), rng, vars);
      if (!this.saidSet.has(hashString(text))) break;
    }
    this.remember(text);
    return text;
  }

  remember(text: string) {
    const h = hashString(text);
    if (this.saidSet.has(h)) return;
    this.said.push(h);
    this.saidSet.add(h);
    while (this.said.length > this.maxSaid) this.saidSet.delete(this.said.shift()!);
  }

  wasSaid(text: string): boolean {
    return this.saidSet.has(hashString(text));
  }

  save(): VarietyState {
    return { recent: Object.fromEntries(this.recent), said: this.said.slice() };
  }

  load(s: VarietyState | undefined) {
    if (!s) return;
    this.recent = new Map(Object.entries(s.recent ?? {}));
    this.said = (s.said ?? []).slice(-this.maxSaid);
    this.saidSet = new Set(this.said);
  }
}
