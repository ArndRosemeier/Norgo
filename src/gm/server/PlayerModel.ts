/**
 * Player model: watches what a player actually does and infers a playstyle
 * profile (explorer / fighter / socializer / crafter / mage / sneak), plus a
 * factual history used for recaps, adaptive quests and fair difficulty.
 *
 * Style scores are exponentially decayed evidence (half-life ≈ 20 min of play),
 * so the model adapts when a player changes how they play.
 */
import type { ServerEntity } from '../../server/entity';
import { abilityDef } from '../../gameplay/data/catalog';

export type Playstyle = 'explorer' | 'fighter' | 'socializer' | 'crafter' | 'mage' | 'sneak';
export const PLAYSTYLES: Playstyle[] = ['explorer', 'fighter', 'socializer', 'crafter', 'mage', 'sneak'];

export interface PlayerHistory {
  kills: number;
  /** Kills per creature/npc label (top entries kept). */
  killsBy: Record<string, number>;
  bossKills: string[];
  discoveries: number;
  sitesVisited: number;
  biomesVisited: number[];
  crimes: Record<string, number>;
  questsCompleted: number;
  questsFailed: number;
  deaths: number;
  killedBy: Record<string, number>;
  itemsAcquired: number;
  notableItems: string[];
  crafted: number;
  harvested: number;
  abilities: string[];
  levelUps: number;
  /** Highest skill levels reached. */
  topSkills: Record<string, number>;
  distance: number;
  deepest: number;
  highest: number;
  playTime: number;
  conversations: number;
  abilityUses: number;
  coinsEarned: number;
  heroics: number;
}

export interface PlayerModelState {
  style: Record<Playstyle, number>;
  history: PlayerHistory;
}

const HALF_LIFE = 1200;

function emptyHistory(): PlayerHistory {
  return {
    kills: 0, killsBy: {}, bossKills: [], discoveries: 0, sitesVisited: 0, biomesVisited: [], crimes: {}, questsCompleted: 0, questsFailed: 0,
    deaths: 0, killedBy: {}, itemsAcquired: 0, notableItems: [], crafted: 0, harvested: 0, abilities: [], levelUps: 0, topSkills: {}, distance: 0,
    deepest: 0, highest: 0, playTime: 0, conversations: 0, abilityUses: 0, coinsEarned: 0, heroics: 0,
  };
}

export class PlayerModel {
  style: Record<Playstyle, number> = { explorer: 1, fighter: 1, socializer: 1, crafter: 1, mage: 1, sneak: 1 };
  history: PlayerHistory = emptyHistory();
  private sneakTime = 0;

  /** Add evidence for a style. */
  bump(s: Playstyle, amount: number) {
    this.style[s] += amount;
  }

  /** Called once per second: decay, passive evidence (movement, sneaking). */
  tick(p: ServerEntity, moved: number, dt: number) {
    const k = Math.pow(0.5, dt / HALF_LIFE);
    for (const s of PLAYSTYLES) this.style[s] = Math.max(0.2, this.style[s] * k);
    this.history.playTime += dt;
    if (moved > 0 && moved < 200) {
      this.history.distance += moved;
      // Covering ground is (weak) explorer evidence.
      this.bump('explorer', moved * 0.0015);
    }
    if (p.anim.move === 'crouch') {
      this.sneakTime += dt;
      this.bump('sneak', 0.02 * dt);
    }
    this.history.deepest = Math.min(this.history.deepest, p.pos[1]);
    this.history.highest = Math.max(this.history.highest, p.pos[1]);
  }

  /** Normalised style weights (sum 1). */
  weights(): Record<Playstyle, number> {
    let sum = 0;
    for (const s of PLAYSTYLES) sum += this.style[s];
    const out = {} as Record<Playstyle, number>;
    for (const s of PLAYSTYLES) out[s] = this.style[s] / sum;
    return out;
  }

  dominant(): Playstyle {
    let best: Playstyle = 'explorer';
    for (const s of PLAYSTYLES) if (this.style[s] > this.style[best]) best = s;
    return best;
  }

  /** Is the dominant style clearly ahead (vs. a balanced player)? */
  confidence(): number {
    const w = this.weights();
    const sorted = PLAYSTYLES.map((s) => w[s]).sort((a, b) => b - a);
    return sorted[0] - sorted[1];
  }

  // ------------------------------------------------------------ observations

  onKill(victim: ServerEntity, label: string, sneaking: boolean, boss: boolean) {
    const h = this.history;
    h.kills++;
    h.killsBy[label] = (h.killsBy[label] ?? 0) + 1;
    if (boss && victim.name) h.bossKills.push(victim.name);
    if (h.bossKills.length > 30) h.bossKills.shift();
    this.bump('fighter', boss ? 3 : 1);
    if (sneaking) this.bump('sneak', 1.2);
    // Keep the per-label map small.
    const keys = Object.keys(h.killsBy);
    if (keys.length > 40) {
      keys.sort((a, b) => h.killsBy[a] - h.killsBy[b]);
      for (const k2 of keys.slice(0, 10)) delete h.killsBy[k2];
    }
  }

  onDamageDealt(amount: number, ability?: string) {
    this.bump('fighter', Math.min(0.5, amount * 0.004));
    if (ability && abilityDef(ability)?.kind === 'magic') this.bump('mage', Math.min(0.5, amount * 0.004));
  }

  onAbility(ability: string) {
    this.history.abilityUses++;
    const def = abilityDef(ability);
    if (def?.kind === 'magic' || /spell|bolt|fire|frost|shock|arcane|heal|ward|levitat|blink|summon/.test(ability)) this.bump('mage', 0.6);
    else this.bump('fighter', 0.2);
    if (def?.role === 'social') this.bump('socializer', 0.4);
    if (def?.role === 'crafting') this.bump('crafter', 0.4);
    if (def?.tags.includes('stealth') || /sneak|shadow|vanish|invis|backstab/.test(ability)) this.bump('sneak', 0.8);
  }

  onItem(how: string, name: string, rarity: string, value: number) {
    const h = this.history;
    h.itemsAcquired++;
    if (how === 'craft') {
      h.crafted++;
      this.bump('crafter', 1.2);
    } else if (how === 'harvest') this.bump('crafter', 0.3);
    else if (how === 'buy') this.bump('socializer', 0.4);
    else if (how === 'steal') this.bump('sneak', 1.5);
    if (rarity !== 'common' && rarity !== 'uncommon') {
      h.notableItems.push(name);
      if (h.notableItems.length > 20) h.notableItems.shift();
    }
    h.coinsEarned += how === 'loot' ? value : 0;
  }

  onHarvest() {
    this.history.harvested++;
    this.bump('crafter', 0.35);
  }

  onDig() {
    this.bump('crafter', 0.08);
    this.bump('explorer', 0.03);
  }

  onDiscover(kind: 'poi' | 'site' | 'biome' | 'underworld') {
    const h = this.history;
    if (kind === 'poi') h.discoveries++;
    if (kind === 'site') h.sitesVisited++;
    this.bump('explorer', kind === 'underworld' ? 3 : kind === 'poi' ? 1.5 : 1);
  }

  onDialog() {
    this.history.conversations++;
    this.bump('socializer', 1);
  }

  onDialogEvent(event: string) {
    this.bump('socializer', 0.3);
    if (/persua|charm|bribe|flatter|haggle/.test(event)) this.bump('socializer', 0.5);
    if (/lie|deceiv|intimid/.test(event)) this.bump('sneak', 0.3);
  }

  onCrime(kind: string) {
    this.history.crimes[kind] = (this.history.crimes[kind] ?? 0) + 1;
    if (kind === 'theft' || kind === 'trespass') this.bump('sneak', 1.2);
    else this.bump('fighter', 0.5);
  }

  onDeath(killer: string | null) {
    this.history.deaths++;
    if (killer) this.history.killedBy[killer] = (this.history.killedBy[killer] ?? 0) + 1;
  }

  onSkill(skill: string, level: number, leveled: boolean) {
    if (leveled) this.history.levelUps++;
    this.history.topSkills[skill] = Math.max(this.history.topSkills[skill] ?? 0, level);
  }

  onUnlock(ability: string) {
    if (!this.history.abilities.includes(ability)) this.history.abilities.push(ability);
  }

  // ------------------------------------------------------------ persistence

  save(): PlayerModelState {
    return { style: { ...this.style }, history: this.history };
  }

  load(s: PlayerModelState | undefined) {
    if (!s) return;
    this.style = { ...this.style, ...s.style };
    this.history = { ...emptyHistory(), ...s.history };
  }
}

/**
 * Rough power estimate of a player (≈1 for a fresh character, ~10 for a veteran,
 * 20+ for a legend). Used to scale encounters so they challenge but never crush.
 */
export function powerLevel(p: ServerEntity): number {
  const levels = Object.values(p.skills?.skills ?? {}).map((s) => s.level).sort((a, b) => b - a);
  let top = 0;
  for (let i = 0; i < Math.min(4, levels.length); i++) top += levels[i];
  const hpBonus = Math.max(0, (p.maxHp - 100) / 40);
  const armor = (p.stats?.armor ?? 0) / 25;
  const abilities = (p.skills?.abilities.length ?? 0) * 0.15;
  return Math.max(1, 1 + top / 8 + hpBonus + armor + abilities);
}
