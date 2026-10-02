/**
 * Creature ecology & behaviour (server).
 *
 * Ecology: every second, each player's surroundings are topped up with fauna
 * fitting the local biome's fauna tags (surface, caves, underworld, water,
 * sky), the time of day (nocturnal species at night) and the world's
 * faunaDensity — as herds, packs, schools, swarms, flocks or loners. Far
 * creatures are despawned, corpses cleaned up; a global budget caps counts.
 *
 * Behaviour: utility AI per individual. Needs (hunger, thirst, energy, fear)
 * drift over time; perception uses sight cones, darkness and hearing (running
 * is loud, sneaking players are hard to notice). Behaviours compete by score:
 * wander, graze/forage, drink, rest/sleep, flee, hunt (stalk → charge/pounce),
 * eat, threaten (territorial warning before attacking), attack, curious
 * approach, follow/defend (tamed), plus medium-specific flying, schooling,
 * drifting, burrowing and climbing. Groups steer with boids (cohesion,
 * separation, alignment) around a leader; packs share targets.
 *
 * Movement: ground following with slope limits and water avoidance (cheap
 * cached 2D heights where the terrain has no 3D features, raycasts elsewhere),
 * local gravity for falls/leaps/floaters, swimming within water bounds.
 */
import type { CreatureService, ServerContext, ServerSystem } from '../../server/context';
import { makeEntity, type ServerEntity } from '../../server/entity';
import type { DamageType, EntityId, MoveState, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import { speciesList, speciesForBiome, individualScale, type Species, type AttackKind, type FaunaRole } from '../species';
import { BIOMES, Biome } from '../../world/biomes';
import { SEA_LEVEL, UNDERWORLD_CEIL, UNDERWORLD_SEA_LEVEL } from '../../world/constants';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { clamp, angleDiff, lerp } from '../../core/math';

type Behavior =
  | 'idle' | 'wander' | 'graze' | 'drink' | 'rest' | 'sleep' | 'flee' | 'hunt' | 'stalk' | 'attack' | 'threaten' | 'eat'
  | 'curious' | 'follow' | 'alert' | 'fly' | 'land' | 'school' | 'drift' | 'burrowed' | 'dead';

interface Brain {
  e: ServerEntity;
  sp: Species;
  group: number;
  home: Vec3;
  hunger: number;
  thirst: number;
  energy: number;
  fear: number;
  anger: number;
  behavior: Behavior;
  until: number;
  target?: EntityId;
  goal: Vec3 | null;
  /** Awareness 0..1 of the current most salient entity. */
  aware: number;
  awareOf?: EntityId;
  attackCd: number;
  pendingHit: { at: number; target: EntityId; kind: AttackKind } | null;
  vy: number;
  thinkAt: number;
  tamedBy?: EntityId;
  tamedName?: string;
  boss: boolean;
  warnedAt: number;
  hurtAt: number;
  wanderYaw: number;
  stuck: number;
  speed: number;
  /** Medium state */
  airborne: boolean;
  /** Seconds left before actions may change (graze/drink cycles). */
  actionUntil: number;
  rng: Rng;
  dmgMul: number;
}

interface Group {
  id: number;
  members: Set<EntityId>;
  leader: EntityId;
  species: number;
  center: Vec3;
  vel: Vec3;
  /** Shared target for packs. */
  target?: EntityId;
  alarm: number;
}

interface SavedCreature {
  species: number;
  seed: number;
  growth: number;
  pos: Vec3;
  hp: number;
  boss: boolean;
  name: string;
  tamedName?: string;
}

const SPAWN_MIN = 42;
const SPAWN_MAX = 105;
const DESPAWN_DIST = 160;
const CORPSE_TIME = 50;
const ACTION_DUR: Record<string, number> = { bite: 0.7, claw: 0.75, charge: 1.1, roar: 1.6, pounce: 1.1, sting: 0.9, spit: 0.9, graze: 3.2, drink: 3.0, flinch: 0.35, die: 1.2, sleep: 1 };

const tmpV: Vec3 = [0, 0, 0];

export class CreatureSystem implements ServerSystem, CreatureService {
  readonly name = 'creatures';
  private ctx!: ServerContext;
  private species: Species[] = [];
  private brains = new Map<EntityId, Brain>();
  private groups = new Map<number, Group>();
  private nextGroup = 1;
  private spawnSeq = 0;
  private groundCache = new Map<number, number>();
  private pendingSaved: SavedCreature[] = [];
  private budget = 80;

  // ================================================================ lifecycle

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.species = speciesList(ctx.gen.profile);
    this.budget = Math.round(70 * clamp(ctx.gen.profile.faunaDensity, 0.6, 1.4));
    ctx.bus.on('damage', (ev) => this.onDamage(ev.target, ev.source, ev.amount));
    ctx.bus.on('death', (ev) => this.onDeath(ev.entity, ev.killer));
    ctx.bus.on('terrainEdited', () => this.groundCache.clear());
  }

  onEntityRemoved(e: ServerEntity) {
    const b = this.brains.get(e.id);
    if (!b) return;
    this.brains.delete(e.id);
    const g = this.groups.get(b.group);
    if (g) {
      g.members.delete(e.id);
      if (!g.members.size) this.groups.delete(g.id);
      else if (g.leader === e.id) g.leader = g.members.values().next().value as EntityId;
    }
  }

  onPlayerJoin(player: ServerEntity) {
    // Re-attach tamed companions saved with this player.
    const keep: SavedCreature[] = [];
    for (const s of this.pendingSaved) {
      if (s.tamedName && s.tamedName === player.name) {
        const e = this.spawn(s.species, [player.pos[0] + 2, player.pos[1], player.pos[2] + 2], { seed: s.seed, growth: s.growth, tamedBy: player.id, boss: s.boss });
        if (e) e.hp = Math.min(e.maxHp, s.hp);
      } else keep.push(s);
    }
    this.pendingSaved = keep;
  }

  // ================================================================ service API

  speciesCount() {
    return this.species.length;
  }

  speciesFor(biome: number, role: string, underworld: boolean): number[] {
    return speciesForBiome(this.species, biome, role, underworld);
  }

  speciesName(species: number): string {
    return this.species[species]?.name ?? 'Unknown beast';
  }

  /** Species genome (for UI, GM descriptions, journal entries). */
  speciesInfo(species: number): Species | undefined {
    return this.species[species];
  }

  spawn(species: number, pos: Vec3, opts: { seed?: number; growth?: number; hostile?: boolean; tamedBy?: EntityId; boss?: boolean } = {}): ServerEntity | null {
    const sp = this.species[species];
    if (!sp) return null;
    const ctx = this.ctx;
    const seed = (opts.seed ?? hash32(deriveSeed(ctx.seed, 'creature', this.spawnSeq++, Math.floor(ctx.time.now * 10)))) >>> 0;
    const rng = new Rng(seed);
    const growth = clamp(opts.growth ?? 1, 0.3, 1);
    const boss = !!opts.boss;
    const e = makeEntity(ctx.newEntityId(), 'creature', pos, 'creatures', ctx.time.now);
    const iscale = individualScale(sp, seed, growth);
    const bossMul = boss ? rng.range(1.6, 2.2) : 1;
    e.scale = bossMul;
    const s = iscale * bossMul;
    e.creature = { species, seed, growth, behavior: 'idle' };
    e.name = boss ? rng.pick(sp.bossNames) : sp.name;
    e.title = boss ? `${sp.name}, ${rng.pick(['Matriarch', 'Alpha', 'Ancient', 'Dread', 'Elder', 'Tyrant'])}` : growth < 0.75 ? `${sp.name} (juvenile)` : undefined;
    e.radius = clamp(sp.radius * s, 0.05, 6);
    e.height = clamp(sp.height * s, 0.05, 14);
    e.mass = sp.mass * s * s * s;
    e.maxHp = Math.max(4, Math.round(sp.hp * lerp(0.45, 1, growth) * (boss ? 6 : 1)));
    e.hp = e.maxHp;
    e.yaw = rng.range(-Math.PI, Math.PI);
    const aggressive = sp.temperament === 'aggressive' || opts.hostile || boss;
    e.faction = aggressive ? 'hostile' : 'wildlife';
    e.tags.add('creature');
    e.tags.add(sp.role);
    // Species material hints for the item system's death loot (hide, scale, chitin, venom_sac...).
    for (const id of sp.loot) e.tags.add('loot:' + id);
    e.tags.add('species:' + sp.id);
    if (boss) { e.tags.add('boss'); e.persistent = true; e.flags |= EntFlag.Boss; }
    if (sp.colors.glowAmount > 0.5) e.flags |= EntFlag.Glowing;
    if (sp.colors.glowAmount > 0.6 && sp.size !== 'tiny') {
      const g = sp.colors.glow;
      e.light = { color: [g[0], g[1], g[2]], intensity: 0.4 + sp.colors.glowAmount * 0.6, radius: clamp(sp.totalLength * s * 3, 2, 10) };
    }
    if (sp.medium === 'water' || sp.medium === 'float') e.grounded = false;
    const brain: Brain = {
      e, sp, group: 0, home: [pos[0], pos[1], pos[2]],
      hunger: rng.range(0.1, 0.6), thirst: rng.range(0, 0.5), energy: rng.range(0.5, 1), fear: 0, anger: 0,
      behavior: 'idle', until: 0, goal: null, aware: 0, attackCd: 0, pendingHit: null, vy: 0, thinkAt: 0,
      boss, warnedAt: -99, hurtAt: -99, wanderYaw: e.yaw, stuck: 0, speed: 0, airborne: sp.medium === 'air' && rng.chance(0.5),
      actionUntil: 0, rng, dmgMul: (boss ? 2 : 1) * lerp(0.4, 1, growth),
    };
    if (opts.tamedBy !== undefined) this.makeTamed(brain, opts.tamedBy);
    // Snap to the right medium.
    const gy = this.ground(pos[0], pos[1] + 2, pos[2]);
    if (sp.medium === 'water') e.pos[1] = Math.min(pos[1], this.waterLevel(e.pos) - 0.6);
    else if (sp.medium === 'float') e.pos[1] = (Number.isFinite(gy) ? gy : pos[1]) + this.floatAltitude(brain);
    else if (brain.airborne) e.pos[1] = (Number.isFinite(gy) ? gy : pos[1]) + sp.altitude * rng.range(0.5, 1);
    else if (Number.isFinite(gy)) e.pos[1] = gy;
    this.brains.set(e.id, brain);
    ctx.spawn(e);
    return e;
  }

  tryTame(creature: ServerEntity, by: ServerEntity, power: number): boolean {
    const b = this.brains.get(creature.id);
    if (!b || !creature.alive || b.tamedBy !== undefined) return false;
    const sp = b.sp;
    if (sp.tameDifficulty >= 1 || b.boss) {
      this.say(creature, 'roar');
      return false;
    }
    // Hurt, hungry or calm animals are easier; juveniles much easier.
    const calm = b.behavior === 'attack' || b.behavior === 'flee' ? 0.5 : 1;
    const hurt = 1 + (1 - creature.hp / creature.maxHp) * 0.5;
    const juvenile = (creature.creature?.growth ?? 1) < 0.75 ? 1.5 : 1;
    const chance = clamp((power / 100) * (1 - sp.tameDifficulty) * 2.2 * calm * hurt * juvenile * (0.6 + b.hunger * 0.6), 0.02, 0.95);
    if (b.rng.float() < chance) {
      this.makeTamed(b, by.id);
      this.ctx.broadcast({ type: 'fx', fx: 'tame', pos: creature.pos, target: creature.id }, creature.pos);
      this.ctx.broadcast({ type: 'notify', text: `${creature.name} accepts you.`, tone: 'good' }, by.pos, 30);
      return true;
    }
    // Failure: skittish ones bolt, proud ones get angry.
    if (sp.temperament === 'territorial' || sp.temperament === 'aggressive') {
      b.anger = 1;
      b.target = by.id;
      this.setBehavior(b, 'threaten', 2.5);
    } else {
      b.fear = 1;
      b.target = by.id;
      this.setBehavior(b, 'flee', 6);
    }
    return false;
  }

  private makeTamed(b: Brain, owner: EntityId) {
    const e = b.e;
    const o = this.ctx.entities.get(owner);
    b.tamedBy = owner;
    b.tamedName = o?.name;
    e.flags |= EntFlag.Tamed;
    e.flags &= ~EntFlag.Hostile;
    e.faction = o?.faction ?? 'player';
    e.persistent = true;
    e.tags.add('tamed');
    b.fear = 0;
    b.anger = 0;
    b.target = undefined;
    // Leave the wild group.
    const g = this.groups.get(b.group);
    if (g) {
      g.members.delete(e.id);
      if (g.leader === e.id && g.members.size) g.leader = g.members.values().next().value as EntityId;
    }
    b.group = 0;
    this.setBehavior(b, 'follow', 2);
  }

  // ================================================================ persistence

  save(): unknown {
    const out: SavedCreature[] = [...this.pendingSaved];
    for (const b of this.brains.values()) {
      if (!b.e.alive || (!b.tamedName && !b.boss)) continue;
      const r = b.e.creature!;
      out.push({ species: r.species, seed: r.seed, growth: r.growth, pos: [...b.e.pos] as Vec3, hp: b.e.hp, boss: b.boss, name: b.e.name, tamedName: b.tamedName });
    }
    return { creatures: out };
  }

  load(data: unknown) {
    const d = data as { creatures?: SavedCreature[] };
    if (!d?.creatures) return;
    for (const s of d.creatures) {
      if (s.tamedName) this.pendingSaved.push(s);
      else {
        const e = this.spawn(s.species, s.pos, { seed: s.seed, growth: s.growth, boss: s.boss });
        if (e) { e.hp = Math.min(e.maxHp, s.hp); e.name = s.name; }
      }
    }
  }

  // ================================================================ ecology

  slowTick(dt: number) {
    const ctx = this.ctx;
    const players = ctx.players();
    // Needs drift.
    for (const b of this.brains.values()) {
      if (!b.e.alive) continue;
      const act = this.activeNow(b.sp);
      b.hunger = clamp(b.hunger + dt * (b.behavior === 'sleep' ? 0.002 : 0.006) * (b.sp.size === 'tiny' ? 1.5 : 1), 0, 1);
      b.thirst = clamp(b.thirst + dt * 0.005 * (BIOMES[ctx.gen.biomeAt(b.e.pos[0], b.e.pos[2])]?.temp > 0.6 ? 1.6 : 1), 0, 1);
      b.energy = clamp(b.energy + dt * (b.behavior === 'sleep' || b.behavior === 'rest' ? 0.03 : act ? -0.004 : -0.012) * (b.behavior === 'flee' || b.behavior === 'attack' ? 3 : 1), 0, 1);
      b.fear = Math.max(0, b.fear - dt * 0.05);
      b.anger = Math.max(0, b.anger - dt * 0.04);
    }
    // Despawn & corpse cleanup.
    for (const b of [...this.brains.values()]) {
      const e = b.e;
      if (!e.alive) {
        if (e.diedAt !== undefined && ctx.time.now - e.diedAt > CORPSE_TIME) ctx.despawn(e.id);
        continue;
      }
      if (b.tamedBy !== undefined) {
        // Owner left: wait to be re-attached on join.
        if (!ctx.entities.get(b.tamedBy)) {
          if (b.tamedName) this.pendingSaved.push({ species: e.creature!.species, seed: e.creature!.seed, growth: e.creature!.growth, pos: [...e.pos] as Vec3, hp: e.hp, boss: b.boss, name: e.name, tamedName: b.tamedName });
          ctx.despawn(e.id);
        }
        continue;
      }
      let near = Infinity;
      for (const p of players) near = Math.min(near, Math.hypot(p.pos[0] - e.pos[0], p.pos[2] - e.pos[2], (p.pos[1] - e.pos[1]) * 0.5));
      if (near > (b.boss ? DESPAWN_DIST * 2.5 : DESPAWN_DIST)) ctx.despawn(e.id);
    }
    // Group centres & velocities.
    for (const g of this.groups.values()) {
      let cx = 0, cy = 0, cz = 0, vx = 0, vz = 0, n = 0;
      for (const id of g.members) {
        const m = this.brains.get(id);
        if (!m || !m.e.alive) continue;
        cx += m.e.pos[0]; cy += m.e.pos[1]; cz += m.e.pos[2];
        vx += m.e.vel[0]; vz += m.e.vel[2];
        n++;
      }
      if (n) { g.center = [cx / n, cy / n, cz / n]; g.vel = [vx / n, 0, vz / n]; }
      g.alarm = Math.max(0, g.alarm - dt * 0.1);
    }
    // Top up the population around players.
    let total = 0;
    for (const b of this.brains.values()) if (b.e.alive) total++;
    for (const p of players) {
      if (!p.alive || total >= this.budget) break;
      let local = 0;
      const present = new Map<number, number>();
      const weighted = new Map<number, number>();
      for (const e of ctx.entities.near(p.pos, SPAWN_MAX + 10)) {
        if (e.kind !== 'creature' || !e.alive) continue;
        // Swarms of tiny critters count less toward the local quota.
        const sz = this.brains.get(e.id)?.sp.size;
        weighted.set(e.creature!.species, (weighted.get(e.creature!.species) ?? 0) + (sz === 'tiny' ? 0.3 : sz === 'small' ? 0.7 : 1));
        present.set(e.creature!.species, (present.get(e.creature!.species) ?? 0) + 1);
      }
      // One species (e.g. a big swarm) can only fill part of the local quota.
      for (const w of weighted.values()) local += Math.min(w, 4.5);
      const want = this.targetDensity(p);
      for (let tries = 0; tries < 2 && local < want && total < this.budget; tries++) {
        const n = this.spawnGroupNear(p, present);
        local += Math.min(4.5, n * (this.species[[...this.groups.values()].pop()?.species ?? 0]?.size === 'tiny' ? 0.3 : 1));
        total += n;
      }
    }
  }

  private isUnderground(p: Vec3): 'surface' | 'cave' | 'underworld' {
    if (p[1] < UNDERWORLD_CEIL + 20 && this.ctx.gen.isUnderworld(p[0], p[1], p[2])) return 'underworld';
    const h = this.ctx.gen.heightAt(p[0], p[2]);
    return p[1] < h - 8 ? 'cave' : 'surface';
  }

  private targetDensity(p: ServerEntity): number {
    const prof = this.ctx.gen.profile;
    const layer = this.isUnderground(p.pos);
    let base = layer === 'underworld' ? 11 : layer === 'cave' ? 5 : 15;
    if (layer === 'surface') {
      const bd = BIOMES[this.ctx.gen.biomeAt(p.pos[0], p.pos[2])];
      base *= clamp(0.45 + bd.vegetation * 0.45 + bd.habitable * 0.2, 0.35, 1.4);
      // Fewer wild animals inside settlements.
      if (this.ctx.gen.siteAt(p.pos[0], p.pos[2])) base *= 0.3;
    }
    return Math.round(base * prof.faunaDensity);
  }

  /** Is this species active at the current hour? */
  private activeNow(sp: Species): boolean {
    const h = this.ctx.time.hour;
    const day = h >= 6.5 && h < 19;
    const dusk = (h >= 5 && h < 8) || (h >= 17.5 && h < 21);
    switch (sp.activity) {
      case 'diurnal': return day;
      case 'nocturnal': return !day || dusk;
      case 'crepuscular': return dusk || (day && sp.role !== 'predator');
      default: return true;
    }
  }

  /** Spawn one ecologically fitting group near a player. Returns count spawned. */
  private spawnGroupNear(p: ServerEntity, present: Map<number, number> = new Map()): number {
    const ctx = this.ctx;
    const gen = ctx.gen;
    const rng = ctx.rng('spawn', this.spawnSeq++, Math.floor(ctx.time.now));
    const layer = this.isUnderground(p.pos);
    let x = 0, z = 0, y = NaN, biome: Biome = Biome.Grassland;
    let water = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const ang = rng.range(0, Math.PI * 2);
      const dist = layer === 'surface' ? rng.range(SPAWN_MIN, SPAWN_MAX) : rng.range(18, 55);
      x = p.pos[0] + Math.cos(ang) * dist;
      z = p.pos[2] + Math.sin(ang) * dist;
      if (layer === 'surface') {
        const col = gen.cachedColumn(x, z);
        biome = col.biome;
        water = col.height < SEA_LEVEL - 1.2;
        y = water ? col.height : this.surfaceGround(x, col.height + 30, z);
        if (!water && gen.siteAt(x, z)) { y = NaN; continue; }
      } else {
        // Cavern floors are uneven: probe from well above the player's level.
        y = ctx.groundAt(x, p.pos[1] + 22, z, 60);
        if (Number.isFinite(y) && layer === 'underworld' && !gen.isUnderworld(x, y + 1, z)) y = NaN;
        if (layer === 'underworld') {
          const col = gen.cachedColumn(x, z);
          biome = col.uwBiome;
          water = Number.isFinite(y) && y < UNDERWORLD_SEA_LEVEL - 1;
        } else biome = gen.biomeAt(x, z);
        // Require headroom.
        if (Number.isFinite(y) && ctx.terrain.density(x, y + 1.5, z) > 0) y = NaN;
      }
      if (Number.isFinite(y)) break;
    }
    if (!Number.isFinite(y)) return 0;
    // Choose a role from the biome's fauna tags.
    const def = BIOMES[biome];
    let roles: FaunaRole[] = (def.fauna as FaunaRole[]).slice();
    if (water) roles = ['fish', 'fish', 'amphibian'];
    else {
      roles = roles.filter((r) => r !== 'fish');
      if (layer === 'cave') roles = ['cavecritter', 'cavecritter', 'insect', 'burrower'];
      if (layer === 'surface' && rng.chance(0.06)) roles.push('apex');
      if (layer === 'surface' && (biome === Biome.Swamp || gen.cachedColumn(x, z).river > 0.2)) roles.push('amphibian');
    }
    const uw = layer === 'underworld';
    const candidates: Species[] = [];
    for (const r of roles) for (const i of this.speciesFor(biome, r, uw)) {
      const s = this.species[i];
      if (water !== (s.medium === 'water' || (s.medium === 'amphibious' && rng.chance(0.3)))) { if (water || s.medium === 'water') continue; }
      if (layer === 'cave' && !(s.cave || s.underworld || s.role === 'insect' || s.role === 'burrower')) continue;
      // Saturated: one or two groups of a species around is plenty.
      if ((present.get(s.index) ?? 0) >= Math.max(6, s.groupSize[1] * 1.5)) continue;
      candidates.push(s);
    }
    if (!candidates.length) return 0;
    // Prefer species not yet around (variety), awake ones, and rarely apex predators.
    const sp = rng.weighted(candidates, (s) => s.abundance * (this.activeNow(s) ? 1 : 0.18) * (s.role === 'apex' ? 0.4 : 1) / (1 + (present.get(s.index) ?? 0) * 0.8));
    // Group.
    const [gmin, gmax] = sp.groupSize;
    const n = rng.int(gmin, gmax);
    const g: Group = { id: this.nextGroup++, members: new Set(), leader: 0, species: sp.index, center: [x, y, z], vel: [0, 0, 0], alarm: 0 };
    const spread = Math.max(1.5, sp.totalLength * 1.8) * Math.sqrt(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const px = x + (i ? rng.range(-spread, spread) : 0), pz = z + (i ? rng.range(-spread, spread) : 0);
      let py = water ? Math.min(this.waterLevel([px, y, pz]) - 0.8, y + rng.range(1, 3)) : this.ground(px, y + 4, pz);
      if (!Number.isFinite(py)) py = y;
      if (water) {
        const gy = this.ground(px, py, pz);
        if (Number.isFinite(gy) && gy > py - 0.3) continue;
      }
      const growth = (sp.sociality === 'herd' || sp.sociality === 'pack' || sp.sociality === 'pair') && i > 0 && rng.chance(0.25) ? rng.range(0.45, 0.75) : rng.range(0.85, 1);
      const e = this.spawn(sp.index, [px, py, pz], { growth, seed: rng.nextU32() });
      if (!e) continue;
      const b = this.brains.get(e.id)!;
      b.group = g.id;
      g.members.add(e.id);
      if (!g.leader) g.leader = e.id;
      count++;
    }
    if (count) this.groups.set(g.id, g);
    return count;
  }

  // ================================================================ terrain helpers

  /** Surface ground: cheap 2D height where the terrain is a pure heightfield, raycast elsewhere. */
  private surfaceGround(x: number, yFrom: number, z: number): number {
    const col = this.ctx.gen.cachedColumn(x, z);
    if (col.overhang < 0.05 && col.arches < 0.05 && col.islands < 0.05 && col.pillars < 0.05 && col.spikes < 0.05 && col.caveEntrance < 0.05 && !this.editedNear(x, z)) return col.height;
    return this.ctx.groundAt(x, yFrom, z, yFrom - col.height + 60);
  }

  private editedNear(x: number, z: number): boolean {
    return this.ctx.edits.query(x - 4, -1e4, z - 4, x + 4, 1e4, z + 4).length > 0;
  }

  /**
   * Ground below (x, y, z): bilinear between the four surrounding 1 m grid samples.
   * (Snapping to the nearest sample put creatures up to half a metre × slope into the
   * ground — small critters on slopes were half buried and hard to hit.)
   */
  private ground(x: number, y: number, z: number): number {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const a = this.groundCell(x0, y, z0), b = this.groundCell(x0 + 1, y, z0);
    const c = this.groundCell(x0, y, z0 + 1), d = this.groundCell(x0 + 1, y, z0 + 1);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return this.groundCell(Math.round(x), y, Math.round(z));
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  /** Ground below a 1 m grid point — cached per 6 m height band. */
  private groundCell(ix: number, y: number, iz: number): number {
    const iy = Math.floor(y / 6);
    const key = ((ix + 32768) & 0xffff) * 4294967296 + ((iz + 32768) & 0xffff) * 65536 + ((iy + 32768) & 0xffff);
    let v = this.groundCache.get(key);
    if (v !== undefined) return v;
    const col = this.ctx.gen.cachedColumn(ix, iz);
    const simple = col.overhang < 0.05 && col.arches < 0.05 && col.islands < 0.05 && col.pillars < 0.05 && col.spikes < 0.05 && col.caveEntrance < 0.05;
    if (simple && Math.abs(y - col.height) < 5 && y > UNDERWORLD_CEIL + 40 && !this.editedNear(ix, iz)) v = col.height;
    else v = this.ctx.groundAt(ix, iy * 6 + 7, iz, 26);
    if (this.groundCache.size > 60000) this.groundCache.clear();
    this.groundCache.set(key, v);
    return v;
  }

  private waterLevel(p: Vec3): number {
    return p[1] < UNDERWORLD_CEIL ? UNDERWORLD_SEA_LEVEL : SEA_LEVEL;
  }

  private floatAltitude(b: Brain): number {
    const g = this.ctx.gravityAt(b.e.pos);
    // Gas-bags float higher where gravity is weak.
    return b.sp.altitude * clamp(Math.sqrt(9.81 / Math.max(1, g)), 0.6, 2.5) * (0.8 + 0.4 * Math.sin(this.ctx.time.now * 0.05 + b.e.id));
  }

  // ================================================================ per-tick simulation

  tick(dt: number) {
    const now = this.ctx.time.now;
    for (const b of this.brains.values()) {
      const e = b.e;
      if (!e.alive) {
        if (e.vel[0] || e.vel[1] || e.vel[2]) {
          // Corpses fall to the ground (fish float up belly-first).
          this.fallCorpse(b, dt);
        }
        continue;
      }
      b.attackCd -= dt;
      if (now >= b.thinkAt) {
        this.think(b);
        const near = this.nearestPlayerDist(e.pos);
        b.thinkAt = now + (near < 40 ? 0.25 : near < 90 ? 0.6 : 1.5) * b.rng.range(0.8, 1.2);
      }
      if (b.pendingHit && now >= b.pendingHit.at) this.resolveHit(b);
      this.move(b, dt);
    }
  }

  private nearestPlayerDist(p: Vec3): number {
    let d = Infinity;
    for (const pl of this.ctx.players()) d = Math.min(d, Math.hypot(pl.pos[0] - p[0], pl.pos[1] - p[1], pl.pos[2] - p[2]));
    return d;
  }

  // ================================================================ perception

  /** 0..1 how well `b` perceives `o` this think step. */
  private perceive(b: Brain, o: ServerEntity, dist: number): number {
    const sp = b.sp;
    const e = b.e;
    const h = this.ctx.time.hour;
    const daylight = h >= 6.5 && h < 19 ? 1 : h >= 5.5 && h < 20 ? 0.6 : 0.3;
    const nightEyes = sp.activity === 'nocturnal' || sp.activity === 'crepuscular' || sp.underworld || sp.cave ? 1 : daylight;
    const dark = this.isUnderground(e.pos) !== 'surface' && !(sp.underworld || sp.cave) ? 0.4 : 1;
    let sight = sp.sight * nightEyes * dark;
    const sneaking = (o.flags & EntFlag.Sneaking) !== 0;
    const stealth = clamp((o.stats?.stealth ?? 0) / 100, 0, 0.6);
    if (sneaking) sight *= 0.45;
    sight *= 1 - stealth;
    if (b.behavior === 'sleep') sight = 0;
    let p = 0;
    if (dist < sight) {
      // Field of view cone: facing = (−sin yaw, −cos yaw).
      const dx = o.pos[0] - e.pos[0], dz = o.pos[2] - e.pos[2];
      const ang = Math.abs(angleDiff(Math.atan2(-dx, -dz), e.yaw));
      if (ang < sp.fov / 2) p = 1 - (dist / sight) ** 2 * 0.6;
    }
    // Hearing: speed is noise; sneaking is nearly silent.
    const spd = Math.hypot(o.vel[0], o.vel[2]);
    const noise = (sneaking ? 0.12 : 0.3 + clamp(spd / 6, 0, 1)) * (1 - stealth);
    const hear = sp.hearing * noise * (b.behavior === 'sleep' ? 0.35 : 1);
    if (dist < hear) p = Math.max(p, 1 - dist / hear);
    if (dist < e.radius + o.radius + 1) p = 1; // touch
    return clamp(p, 0, 1);
  }

  // ================================================================ decision making

  private think(b: Brain) {
    const ctx = this.ctx;
    const e = b.e;
    const sp = b.sp;
    const now = ctx.time.now;
    const dtThink = 0.4;
    const g = this.groups.get(b.group);

    // --- tamed companions
    if (b.tamedBy !== undefined) {
      const owner = ctx.entities.get(b.tamedBy);
      if (!owner) return;
      const t = b.target !== undefined ? ctx.entities.get(b.target) : undefined;
      if (t && t.alive && Math.hypot(t.pos[0] - owner.pos[0], t.pos[2] - owner.pos[2]) < 25) {
        this.setBehavior(b, 'attack', 2);
        return;
      }
      b.target = undefined;
      const d = Math.hypot(owner.pos[0] - e.pos[0], owner.pos[2] - e.pos[2]);
      if (d > 60) {
        // Lost companions catch up out of sight.
        e.pos = [owner.pos[0] + 2, owner.pos[1] + 1, owner.pos[2] + 2];
        ctx.entities.reindex(e);
      }
      this.setBehavior(b, d > 4 + sp.radius * 2 ? 'follow' : b.energy < 0.2 ? 'rest' : 'idle', 1);
      b.goal = [owner.pos[0], owner.pos[1], owner.pos[2]];
      e.anim.lookAt = d < 8 ? [owner.pos[0], owner.pos[1] + owner.height * 0.9, owner.pos[2]] : undefined;
      return;
    }

    // --- scan surroundings
    const range = Math.max(sp.sight, sp.hearing) * 1.1 + 4;
    let threat: ServerEntity | null = null, threatScore = 0;
    let prey: ServerEntity | null = null, preyScore = 0;
    let curiousOf: ServerEntity | null = null;
    let intruder: ServerEntity | null = null;
    let bestAware = 0;
    const carnivore = sp.diet === 'carnivore' || sp.role === 'apex' || (sp.diet === 'omnivore' && b.hunger > 0.75);
    // Players/NPCs only provoke a fight inside a short aggro radius (unless they attacked us);
    // the sight/hearing range is for awareness and fleeing, not for charging across the map.
    const aggroR = b.boss ? 20 : clamp(sp.sight * 0.25, 7, 14);
    const territory = Math.min(aggroR, Math.max(6, sp.totalLength * 4 + (b.boss ? 10 : 0)));
    for (const o of ctx.entities.near(e.pos, range)) {
      if (o === e || !o.alive) continue;
      if (o.kind !== 'player' && o.kind !== 'creature' && o.kind !== 'npc') continue;
      const dist = Math.hypot(o.pos[0] - e.pos[0], o.pos[1] - e.pos[1], o.pos[2] - e.pos[2]);
      let seen = this.perceive(b, o, dist);
      if (o.id === b.awareOf) seen = Math.max(seen, b.aware * 0.9);
      if (seen <= 0.05) continue;
      const ob = o.kind === 'creature' ? this.brains.get(o.id) : undefined;
      if (ob && (ob.group === b.group && b.group !== 0)) continue;
      if (ob && ob.sp.index === sp.index && !carnivore) continue;
      // Relative strength: mass ratio (players ≈ 75 kg, armed).
      const om = o.kind === 'creature' ? o.mass : 75 * (o.kind === 'player' ? 1.8 : 1.3);
      const ratio = om / Math.max(0.01, e.mass * (g ? Math.sqrt(g.members.size) : 1));
      const hostileTo = o.id === b.target && b.anger > 0.3;
      const oPredator = ob ? (ob.sp.diet === 'carnivore' || ob.sp.role === 'apex') && ob.e.mass > e.mass * 0.6 && ob.tamedBy === undefined : o.kind !== 'creature';
      // Threat assessment.
      let ts = 0;
      const person = o.kind === 'player' || o.kind === 'npc';
      const provoking = o.id === e.lastAttacker && now - b.hurtAt < 20;
      // Brave creatures turn a threat into a fight, so people only count as threats up close.
      const braveSp = sp.temperament === 'aggressive' || sp.temperament === 'territorial' || b.boss || sp.role === 'construct';
      const outOfAggro = person && braveSp && dist > aggroR && !provoking && !hostileTo;
      if (oPredator && !(carnivore && ratio < 0.7) && !outOfAggro) ts = seen * clamp(ratio, 0.2, 3) * (1 - dist / range) * (o.kind === 'player' ? 1 : 1.2);
      if (o.id === e.lastAttacker && now - b.hurtAt < 20) ts += 1.5;
      if (ts > threatScore) { threatScore = ts; threat = o; }
      if (seen > bestAware) bestAware = seen;
      // Prey assessment for carnivores.
      // Aggressive beasts go for players/NPCs straying into their aggro radius, hungry or not.
      if ((sp.temperament === 'aggressive' || b.boss) && (o.kind === 'player' || o.kind === 'npc') && dist < aggroR && seen > 0.4) {
        const ps = seen * (1 - dist / range) * (b.boss ? 1.5 : 1);
        if (ps > preyScore) { preyScore = ps; prey = o; }
      }
      if (carnivore && b.hunger > 0.45) {
        let ps = 0;
        if (ob && ob.sp.index !== sp.index && ratio < 0.9 && ratio > 0.002 && ob.sp.role !== 'construct' && !ob.boss) ps = seen * (1 - dist / range) * (1.2 - ratio);
        if (o.kind === 'player' && dist < aggroR && (sp.temperament === 'aggressive' || b.boss) && (ratio < 1.6 || b.hunger > 0.85 || b.boss)) ps = seen * (1 - dist / range) * 0.9 * (sp.role === 'apex' ? 1.4 : 1);
        if (o.kind === 'npc' && dist < aggroR && sp.temperament === 'aggressive' && ratio < 1) ps = seen * (1 - dist / range) * 0.6;
        if (ps > preyScore) { preyScore = ps; prey = o; }
      }
      if (o.kind === 'player' || o.kind === 'npc') {
        if (sp.temperament === 'curious' && dist < sp.sight && !hostileTo) curiousOf = o;
        if ((sp.temperament === 'territorial' || b.boss) && dist < territory) intruder = o;
      }
      if (hostileTo && dist < range) { threat = o; threatScore = Math.max(threatScore, 1); }
    }
    if (threat) {
      if (b.awareOf === threat.id) b.aware = clamp(b.aware + dtThink * 2 * Math.max(0.2, bestAware), 0, 1);
      else { b.awareOf = threat.id; b.aware = bestAware * 0.6; }
    } else b.aware = Math.max(0, b.aware - dtThink * 0.5);
    const noticed = threat !== null && b.aware > 0.55;

    // Pack alarm propagates.
    if (g && noticed && threatScore > 0.4) g.alarm = Math.max(g.alarm, threatScore);
    const alarmed = g ? g.alarm > 0.5 : false;

    // --- fight or flight
    const hpFrac = e.hp / e.maxHp;
    const brave = sp.temperament === 'aggressive' || sp.temperament === 'territorial' || b.boss || sp.role === 'construct';
    const wasHurt = now - b.hurtAt < 12;
    if ((noticed || wasHurt || alarmed) && threat) {
      const ratio = (threat.kind === 'creature' ? threat.mass : 135) / Math.max(0.01, e.mass * (g && sp.sociality === 'pack' ? g.members.size : 1));
      const fight = (brave && hpFrac > 0.25 && (ratio < 4 || b.boss)) || (wasHurt && sp.temperament !== 'skittish' && hpFrac > 0.5 && ratio < 1.5) || b.anger > 0.6;
      if (fight) {
        b.target = threat.id;
        if (g && sp.sociality === 'pack') g.target = threat.id;
        const dist = Math.hypot(threat.pos[0] - e.pos[0], threat.pos[2] - e.pos[2]);
        // Territorial warning display before committing.
        if (!wasHurt && b.anger < 0.6 && (sp.temperament === 'territorial' || b.boss) && now - b.warnedAt > 15 && dist > territory * 0.45) {
          b.warnedAt = now;
          this.setBehavior(b, 'threaten', 2.4);
          this.say(e, 'roar');
          return;
        }
        if (b.behavior === 'threaten' && now < b.until) return;
        if (b.behavior === 'threaten' && dist > territory * 0.6 && !wasHurt) { this.setBehavior(b, 'alert', 2); return; }
        b.anger = Math.max(b.anger, 0.7);
        this.setBehavior(b, 'attack', 3);
        return;
      }
      if (threatScore > 0.25 || wasHurt || alarmed) {
        b.target = threat.id;
        b.fear = Math.max(b.fear, clamp(threatScore, 0.5, 1));
        this.setBehavior(b, b.sp.medium === 'burrow' && b.rng.chance(0.6) ? 'burrowed' : 'flee', b.rng.range(4, 8));
        return;
      }
    }
    if (b.behavior === 'flee' && now < b.until) return;
    if (b.behavior === 'burrowed' && now < b.until) return;
    if (b.behavior === 'attack' && b.target !== undefined) {
      const t = ctx.entities.get(b.target);
      if (t && t.alive && now - b.hurtAt < 25 && Math.hypot(t.pos[0] - e.pos[0], t.pos[2] - e.pos[2]) < range * 1.5) return;
      b.target = undefined;
    }
    // Pack hunting: follow the pack's target.
    if (g && g.target !== undefined && sp.sociality === 'pack') {
      const t = ctx.entities.get(g.target);
      if (t && t.alive && Math.hypot(t.pos[0] - e.pos[0], t.pos[2] - e.pos[2]) < range * 1.5) {
        b.target = t.id;
        this.setBehavior(b, b.behavior === 'attack' ? 'attack' : 'hunt', 2);
        return;
      }
      g.target = undefined;
    }

    // --- territorial intruders (non-threatening)
    if (intruder && now - b.warnedAt > 10) {
      b.warnedAt = now;
      b.target = intruder.id;
      this.setBehavior(b, 'threaten', 2.2);
      this.say(e, 'roar');
      return;
    }

    // --- hunting
    if (prey && preyScore > 0.15) {
      b.target = prey.id;
      if (g && sp.sociality === 'pack') g.target = prey.id;
      const dist = Math.hypot(prey.pos[0] - e.pos[0], prey.pos[2] - e.pos[2]);
      this.setBehavior(b, dist > 9 + sp.totalLength * 2 && b.behavior !== 'hunt' ? 'stalk' : 'hunt', 2);
      return;
    }
    // Eating a kill.
    if (b.behavior === 'eat' && now < b.until) return;
    if (carnivore && b.hunger > 0.3) {
      for (const o of ctx.entities.near(e.pos, 18)) {
        if (o.kind === 'creature' && !o.alive && o.id !== e.id) {
          b.goal = [o.pos[0], o.pos[1], o.pos[2]];
          b.target = o.id;
          this.setBehavior(b, 'eat', 6);
          return;
        }
      }
    }

    // Keep current timed behaviour.
    if (now < b.until && b.behavior !== 'alert' && b.behavior !== 'curious') return;

    // --- curiosity
    if (curiousOf && b.rng.chance(0.5) && b.fear < 0.2) {
      b.target = curiousOf.id;
      this.setBehavior(b, 'curious', b.rng.range(5, 10));
      return;
    }

    // --- needs & routines
    const active = this.activeNow(sp);
    if (sp.medium === 'water') { this.setBehavior(b, 'school', b.rng.range(4, 9)); return; }
    if (sp.medium === 'float') { this.setBehavior(b, 'drift', b.rng.range(5, 12)); return; }
    if ((!active && b.rng.chance(0.7)) || b.energy < 0.15) {
      if (sp.medium === 'air' && b.airborne) { this.setBehavior(b, 'land', 8); return; }
      this.setBehavior(b, 'sleep', b.rng.range(20, 45));
      return;
    }
    if (b.energy < 0.35 && b.rng.chance(0.4)) { this.setBehavior(b, 'rest', b.rng.range(6, 14)); return; }
    if (b.thirst > 0.65 && sp.medium !== 'air') {
      const w = this.findWater(e.pos, b.rng);
      if (w) { b.goal = w; this.setBehavior(b, 'drink', 25); return; }
    }
    if (sp.medium === 'air') {
      if (b.airborne) { this.setBehavior(b, b.rng.chance(0.25) ? 'land' : 'fly', b.rng.range(6, 16)); return; }
      if (b.rng.chance(0.35)) { b.airborne = true; this.setBehavior(b, 'fly', b.rng.range(8, 18)); return; }
    }
    if (sp.medium === 'burrow' && b.rng.chance(0.12)) { this.setBehavior(b, 'burrowed', b.rng.range(4, 12)); return; }
    if ((sp.diet === 'herbivore' || sp.diet === 'omnivore' || sp.diet === 'lithovore' || sp.diet === 'insectivore') && b.hunger > 0.3 && b.rng.chance(0.6)) {
      this.setBehavior(b, 'graze', b.rng.range(6, 14));
      return;
    }
    this.setBehavior(b, b.rng.chance(0.25) ? 'idle' : 'wander', b.rng.range(3, 9));
  }

  private setBehavior(b: Brain, beh: Behavior, dur: number) {
    const e = b.e;
    if (b.behavior !== beh) {
      b.behavior = beh;
      b.goal = beh === 'drink' || beh === 'eat' || beh === 'follow' ? b.goal : null;
      if (beh === 'wander' || beh === 'fly' || beh === 'school' || beh === 'drift') b.wanderYaw = e.yaw + b.rng.range(-1.4, 1.4);
      if (beh === 'burrowed') {
        this.ctx.broadcast({ type: 'fx', fx: 'dust', pos: [...e.pos] as Vec3, radius: e.radius * 2 }, e.pos, 60);
        this.ctx.broadcast({ type: 'sound', sound: 'dig', pos: e.pos, volume: 0.5 }, e.pos, 40);
      }
    }
    b.until = this.ctx.time.now + dur;
    if (e.creature) e.creature.behavior = beh;
    // Visible hostility flags.
    const hostile = beh === 'attack' || beh === 'threaten' || ((beh === 'hunt' || beh === 'stalk') && this.ctx.entities.get(b.target)?.kind === 'player');
    const was = e.flags;
    e.flags = hostile ? e.flags | EntFlag.Hostile | (beh === 'attack' ? EntFlag.InCombat : 0) : e.flags & ~(EntFlag.Hostile | EntFlag.InCombat);
    if (beh === 'sleep') e.flags |= EntFlag.Sleeping;
    else e.flags &= ~EntFlag.Sleeping;
    if (hostile && b.tamedBy === undefined) e.faction = 'hostile';
    else if (!hostile && b.tamedBy === undefined && b.sp.temperament !== 'aggressive' && !b.boss) e.faction = 'wildlife';
    if (e.flags !== was) e.dirty = true;
    e.target = hostile || beh === 'curious' || beh === 'flee' ? b.target : undefined;
  }

  /** Look for water within ~45 m (surface sea level / underworld sea / rivers). */
  private findWater(p: Vec3, rng: Rng): Vec3 | null {
    const lvl = this.waterLevel(p);
    const uw = p[1] < UNDERWORLD_CEIL;
    for (let i = 0; i < 10; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(8, 45);
      const x = p[0] + Math.cos(a) * d, z = p[2] + Math.sin(a) * d;
      const h = uw ? this.ground(x, p[1] + 4, z) : this.ctx.gen.cachedColumn(x, z).height;
      if (Number.isFinite(h) && h < lvl - 0.2 && h > lvl - 3) return [x, lvl, z];
    }
    return null;
  }

  private say(e: ServerEntity, action: string) {
    this.startAction(e, action);
    this.ctx.broadcast({ type: 'sound', sound: 'creature_' + action, pos: e.pos, volume: clamp(e.mass / 200, 0.3, 1.5) }, e.pos, 80);
  }

  private startAction(e: ServerEntity, id: string, dur = ACTION_DUR[id] ?? 1) {
    e.anim = { ...e.anim, action: { id, t0: this.ctx.time.now, dur } };
    e.dirty = true;
  }

  // ================================================================ steering & movement

  private move(b: Brain, dt: number) {
    const ctx = this.ctx;
    const e = b.e;
    const sp = b.sp;
    const now = ctx.time.now;
    const scale = individualScale(sp, e.creature!.seed, e.creature!.growth) * e.scale;
    const walk = sp.walkSpeed * Math.sqrt(scale);
    const run = sp.runSpeed * Math.sqrt(scale);
    let dirX = 0, dirZ = 0, speed = 0, moveState: MoveState = 'idle';
    let lookAt: Vec3 | undefined;
    const target = b.target !== undefined ? ctx.entities.get(b.target) : undefined;
    const fwdX = -Math.sin(e.yaw), fwdZ = -Math.cos(e.yaw);
    const acting = e.anim.action && now < e.anim.action.t0 + e.anim.action.dur;
    const g = this.groups.get(b.group);

    switch (b.behavior) {
      case 'wander':
      case 'fly':
      case 'school':
      case 'drift': {
        b.wanderYaw += b.rng.range(-0.6, 0.6) * dt;
        // Stay near home range.
        const hx = b.home[0] - e.pos[0], hz = b.home[2] - e.pos[2];
        const hd = Math.hypot(hx, hz);
        const homeR = sp.medium === 'air' ? 60 : 25 + sp.totalLength * 6;
        if (hd > homeR) b.wanderYaw = lerpYaw(b.wanderYaw, Math.atan2(-hx, -hz), dt * 0.8);
        dirX = -Math.sin(b.wanderYaw); dirZ = -Math.cos(b.wanderYaw);
        speed = b.behavior === 'fly' ? run * 0.6 : b.behavior === 'drift' ? walk * 0.6 : b.behavior === 'school' ? walk * 1.1 : walk * 0.7;
        moveState = b.behavior === 'fly' ? 'fly' : b.behavior === 'school' ? 'swim' : b.behavior === 'drift' ? 'fly' : 'walk';
        if (b.behavior === 'drift') { dirX += ctx.weather.windX * 0.4; dirZ += ctx.weather.windZ * 0.4; }
        break;
      }
      case 'graze': {
        // Step-graze-step: short moves between bites.
        if (now > b.actionUntil) {
          if (b.rng.chance(0.65)) this.startAction(e, sp.diet === 'lithovore' ? 'graze' : 'graze', ACTION_DUR.graze * b.rng.range(0.7, 1.3));
          b.actionUntil = now + b.rng.range(3.5, 6);
          b.wanderYaw += b.rng.range(-1, 1);
          b.hunger = Math.max(0, b.hunger - 0.08);
        }
        if (!acting) { dirX = -Math.sin(b.wanderYaw); dirZ = -Math.cos(b.wanderYaw); speed = walk * 0.35; moveState = 'walk'; }
        break;
      }
      case 'drink': {
        if (b.goal) {
          const dx = b.goal[0] - e.pos[0], dz = b.goal[2] - e.pos[2];
          const d = Math.hypot(dx, dz);
          const gy = this.ground(e.pos[0], e.pos[1] + 2, e.pos[2]);
          if (d < 1.5 || (Number.isFinite(gy) && gy < this.waterLevel(e.pos) + 0.3)) {
            if (now > b.actionUntil) { this.startAction(e, 'drink'); b.actionUntil = now + ACTION_DUR.drink + 0.5; b.thirst = Math.max(0, b.thirst - 0.35); }
            if (b.thirst < 0.1) b.until = now;
          } else { dirX = dx / d; dirZ = dz / d; speed = walk; moveState = 'walk'; }
        }
        break;
      }
      case 'rest':
      case 'idle':
      case 'alert':
        if (b.behavior === 'alert' && target) lookAt = [target.pos[0], target.pos[1] + target.height * 0.8, target.pos[2]];
        break;
      case 'sleep':
        moveState = 'sleep';
        break;
      case 'land':
        moveState = b.airborne ? 'fly' : 'idle';
        dirX = fwdX; dirZ = fwdZ; speed = b.airborne ? walk * 2 : 0;
        break;
      case 'flee': {
        if (target) {
          let ax = e.pos[0] - target.pos[0], az = e.pos[2] - target.pos[2];
          const d = Math.hypot(ax, az) || 1;
          ax /= d; az /= d;
          // Zig-zag a little and keep with the herd.
          const zig = Math.sin(now * 1.7 + e.id) * 0.35;
          dirX = ax - az * zig; dirZ = az + ax * zig;
          if (g) { dirX += (g.center[0] - e.pos[0]) * 0.02; dirZ += (g.center[2] - e.pos[2]) * 0.02; }
          if (d > Math.max(sp.sight, 30) * 1.4) b.until = now;
        } else { dirX = fwdX; dirZ = fwdZ; }
        speed = run * (0.7 + b.fear * 0.3) * (b.energy < 0.1 ? 0.6 : 1);
        moveState = speed > walk * 2.5 ? 'sprint' : 'run';
        if (sp.medium === 'water') moveState = 'swim';
        if (sp.medium === 'air') { b.airborne = true; moveState = 'fly'; }
        break;
      }
      case 'curious': {
        if (target) {
          const dx = target.pos[0] - e.pos[0], dz = target.pos[2] - e.pos[2];
          const d = Math.hypot(dx, dz);
          lookAt = [target.pos[0], target.pos[1] + target.height * 0.85, target.pos[2]];
          const keep = 4 + sp.totalLength * 2;
          if (d > keep) { dirX = dx / d; dirZ = dz / d; speed = walk * (d > keep * 2 ? 0.8 : 0.4); moveState = 'walk'; }
          else if (d < keep * 0.6) { dirX = -dx / d; dirZ = -dz / d; speed = walk * 0.6; moveState = 'walk'; }
          else if (now > b.actionUntil && b.rng.chance(0.02)) { b.actionUntil = now + 3; }
        }
        break;
      }
      case 'follow': {
        const owner = b.tamedBy !== undefined ? ctx.entities.get(b.tamedBy) : undefined;
        if (owner) {
          const dx = owner.pos[0] - e.pos[0], dz = owner.pos[2] - e.pos[2];
          const d = Math.hypot(dx, dz);
          const keep = 2.5 + sp.radius * 2;
          if (d > keep) {
            dirX = dx / d; dirZ = dz / d;
            const os = Math.hypot(owner.vel[0], owner.vel[2]);
            speed = clamp(Math.max(os * 1.05, (d - keep) * 0.8), 0, run);
            moveState = speed > walk * 1.6 ? 'run' : 'walk';
          }
          if (sp.medium === 'air') b.airborne = d > 6;
        }
        break;
      }
      case 'threaten': {
        if (target) {
          lookAt = [target.pos[0], target.pos[1] + target.height * 0.8, target.pos[2]];
          const dx = target.pos[0] - e.pos[0], dz = target.pos[2] - e.pos[2];
          dirX = dx; dirZ = dz;
          speed = 0.001; // face, don't advance
          if (now > b.actionUntil && !acting && b.rng.chance(0.25)) { this.say(e, 'roar'); b.actionUntil = now + 2.5; }
        }
        break;
      }
      case 'stalk':
      case 'hunt':
      case 'attack':
      case 'eat': {
        if (b.behavior === 'eat') {
          if (b.goal) {
            const dx = b.goal[0] - e.pos[0], dz = b.goal[2] - e.pos[2];
            const d = Math.hypot(dx, dz);
            if (d > e.radius + 0.8) { dirX = dx / d; dirZ = dz / d; speed = walk; moveState = 'walk'; }
            else if (now > b.actionUntil) { this.startAction(e, 'bite'); b.actionUntil = now + 1.4; b.hunger = Math.max(0, b.hunger - 0.15); }
            lookAt = [b.goal[0], b.goal[1], b.goal[2]];
          }
          break;
        }
        if (!target || !target.alive) { b.target = undefined; b.until = now; break; }
        const dx = target.pos[0] - e.pos[0], dz = target.pos[2] - e.pos[2], dy = target.pos[1] - e.pos[1];
        const d = Math.hypot(dx, dz);
        dirX = dx / (d || 1); dirZ = dz / (d || 1);
        lookAt = [target.pos[0], target.pos[1] + target.height * 0.6, target.pos[2]];
        // Pack tactics: approach from spread angles to surround.
        if (g && g.members.size > 1 && d > 3) {
          const slot = ((e.id * 2654435761) >>> 0) % 7 / 7 - 0.5;
          const ox = -dirZ * slot * 1.4, oz = dirX * slot * 1.4;
          dirX += ox; dirZ += oz;
        }
        const reach = sp.reach * scale + target.radius + e.radius * 0.3;
        if (b.behavior === 'stalk') {
          speed = walk * 0.55;
          moveState = 'crouch';
          if (d < 9 + sp.totalLength * 2 || b.aware > 0.9) this.setBehavior(b, 'hunt', 3);
          break;
        }
        if (acting) { speed = e.anim.action!.id === 'charge' || e.anim.action!.id === 'pounce' ? run * 1.2 : 0; moveState = 'run'; break; }
        if (d > reach) {
          speed = run * (d < reach * 2 ? 0.6 : 1);
          moveState = speed > walk * 2.5 ? 'sprint' : 'run';
          if (sp.medium === 'water') moveState = 'swim';
          if (sp.medium === 'air') { b.airborne = Math.abs(dy) > 1.5 || d > 8; if (b.airborne) moveState = 'fly'; }
          // Gap closers.
          if (b.attackCd <= 0) {
            if (sp.attacks.includes('pounce') && d < reach + 6 && d > reach + 1.5) this.attack(b, target, 'pounce');
            else if (sp.attacks.includes('charge') && d > reach + 3 && d < reach + 10) this.attack(b, target, 'charge');
            else if (sp.attacks.includes('spit') && d < 11 && d > reach + 2 && b.rng.chance(0.35)) this.attack(b, target, 'spit');
          }
        } else {
          speed = 0;
          if (b.attackCd <= 0) {
            const melee = sp.attacks.filter((a) => a === 'bite' || a === 'claw' || a === 'sting' || a === 'charge');
            this.attack(b, target, melee.length ? b.rng.pick(melee) : sp.attacks[0]);
          }
        }
        break;
      }
      case 'burrowed':
        moveState = 'idle';
        break;
      case 'dead':
        break;
    }

    // --- group cohesion (boids) for wandering/grazing herds
    if (g && g.members.size > 1 && (b.behavior === 'wander' || b.behavior === 'graze' || b.behavior === 'school' || b.behavior === 'fly' || b.behavior === 'drift' || b.behavior === 'idle')) {
      const cx = g.center[0] - e.pos[0], cz = g.center[2] - e.pos[2];
      const cd = Math.hypot(cx, cz);
      const spacing = Math.max(1, sp.totalLength * scale * 1.6);
      let sx = 0, sz = 0;
      for (const id of g.members) {
        if (id === e.id) continue;
        const m = ctx.entities.get(id);
        if (!m) continue;
        const ox = e.pos[0] - m.pos[0], oz = e.pos[2] - m.pos[2];
        const od = Math.hypot(ox, oz);
        if (od < spacing && od > 1e-3) { sx += (ox / od) * (spacing - od) / spacing; sz += (oz / od) * (spacing - od) / spacing; }
      }
      const coh = cd > spacing * Math.sqrt(g.members.size) * 0.8 ? 0.6 : 0;
      const al = 0.4;
      const gvx = g.vel[0], gvz = g.vel[2];
      dirX = dirX + (cd > 0 ? (cx / cd) * coh : 0) + sx * 1.2 + gvx * al * 0.3;
      dirZ = dirZ + (cd > 0 ? (cz / cd) * coh : 0) + sz * 1.2 + gvz * al * 0.3;
      if (b.behavior === 'idle' && (Math.abs(sx) + Math.abs(sz) > 0.3 || coh > 0)) { speed = Math.max(speed, walk * 0.5); moveState = 'walk'; }
      // Herd members follow the leader's wander heading.
      const leader = this.brains.get(g.leader);
      if (leader && leader !== b && b.behavior === 'wander') b.wanderYaw = lerpYaw(b.wanderYaw, leader.wanderYaw, dt * 0.5);
    }

    // --- detour: when blocked by cliffs/water, steer around (alternating sides as it keeps failing)
    if (b.stuck > 2 && (dirX || dirZ)) {
      const ang = Math.min(1.6, b.stuck * 0.25) * ((b.stuck >> 3) % 2 ? -1 : 1);
      const c = Math.cos(ang), sn = Math.sin(ang);
      const rx = dirX * c - dirZ * sn, rz = dirX * sn + dirZ * c;
      dirX = rx; dirZ = rz;
    }

    // --- integrate
    const dl = Math.hypot(dirX, dirZ);
    if (dl > 1e-4) { dirX /= dl; dirZ /= dl; }
    // Turn toward the desired heading at the species' turn rate.
    if (dl > 1e-4) {
      const want = Math.atan2(-dirX, -dirZ);
      const diff = angleDiff(e.yaw, want);
      const maxTurn = sp.turnRate * dt * (b.behavior === 'flee' || b.behavior === 'attack' ? 1.4 : 1);
      e.yaw += clamp(diff, -maxTurn, maxTurn);
      // Move mostly along the facing (no crab-walking), slowing in sharp turns.
      const align = Math.max(0, Math.cos(diff));
      speed *= 0.25 + 0.75 * align;
    }
    b.speed = lerp(b.speed, speed, clamp(dt * (speed > b.speed ? 2.5 : 5), 0, 1));
    const vx = -Math.sin(e.yaw) * b.speed, vz = -Math.cos(e.yaw) * b.speed;
    this.integrate(b, vx, vz, dt, moveState);
    if (lookAt) e.anim.lookAt = lookAt;
    else if (e.anim.lookAt && b.tamedBy === undefined) e.anim.lookAt = undefined;
  }

  /** Physics: medium-aware position update with ground following, slopes, water and gravity. */
  private integrate(b: Brain, vx: number, vz: number, dt: number, moveState: MoveState) {
    const ctx = this.ctx;
    const e = b.e;
    const sp = b.sp;
    const p = e.pos;
    const ox = p[0], oy = p[1], oz = p[2];
    let nx = ox + vx * dt, nz = oz + vz * dt, ny = oy;
    const gAcc = ctx.gravityAt(p);
    const wl = this.waterLevel(p);

    if (b.behavior === 'burrowed') {
      // Underground: invisible below the surface, resurface when time is up.
      const gy = this.ground(ox, oy + 3, oz);
      if (ctx.time.now < b.until) { ny = (Number.isFinite(gy) ? gy : oy) - e.height * 1.6 - 0.5; nx = ox; nz = oz; }
      else {
        // Pop up a few meters away.
        const a = b.rng.range(0, Math.PI * 2), d = b.rng.range(3, 10);
        nx = ox + Math.cos(a) * d; nz = oz + Math.sin(a) * d;
        const ng = this.ground(nx, oy + e.height * 2 + 4, nz);
        ny = Number.isFinite(ng) ? ng : oy;
        this.setBehavior(b, 'alert', 2);
        ctx.broadcast({ type: 'fx', fx: 'dust', pos: [nx, ny, nz], radius: e.radius * 2 }, [nx, ny, nz], 60);
      }
      this.commit(b, nx, ny, nz, dt, 'idle');
      return;
    }

    if (sp.medium === 'water') {
      // Swim inside water: between bed + margin and surface − margin.
      const bed = this.ground(nx, oy + 2, nz);
      const top = wl - Math.max(0.4, e.height * 0.6);
      const bottom = (Number.isFinite(bed) ? bed : oy - 5) + Math.max(0.3, e.height * 0.6);
      if (!Number.isFinite(bed) || bed > top - 0.2) {
        // Too shallow ahead: turn around.
        nx = ox; nz = oz;
        b.wanderYaw += Math.PI * 0.7;
        b.speed *= 0.3;
      }
      const depthGoal = lerp(bottom, top, 0.35 + 0.3 * Math.sin(ctx.time.now * 0.2 + e.id));
      ny = oy + clamp(depthGoal - oy, -1, 1) * dt * 0.8;
      ny = clamp(ny, Math.min(bottom, top), top);
      this.commit(b, nx, ny, nz, dt, 'swim');
      e.flags |= EntFlag.Swimming;
      return;
    }

    if (sp.medium === 'float') {
      const gy = this.ground(nx, oy, nz);
      const alt = this.floatAltitude(b);
      const goal = (Number.isFinite(gy) ? gy : oy - alt) + alt;
      // Buoyant bobbing: low gravity lets them rise faster.
      b.vy += (clamp(goal - oy, -3, 3) * 0.6 - b.vy * 0.8) * dt * clamp(9.81 / gAcc, 0.5, 2);
      ny = oy + b.vy * dt;
      if (Number.isFinite(gy) && ny < gy + e.height * 0.5) ny = gy + e.height * 0.5;
      if (ctx.terrain.density(nx, ny + e.height * 0.5, nz) > 0) { nx = ox; nz = oz; b.wanderYaw += 2; }
      this.commit(b, nx, ny, nz, dt, 'fly');
      return;
    }

    if (sp.medium === 'air' && b.airborne) {
      const gy = this.ground(nx, oy, nz);
      const landing = b.behavior === 'land' || b.behavior === 'sleep' || b.behavior === 'rest' || b.behavior === 'graze' || b.behavior === 'drink';
      const alt = landing ? 0 : sp.altitude * (b.behavior === 'flee' ? 1.4 : 1) * (0.7 + 0.3 * Math.sin(ctx.time.now * 0.13 + e.id));
      const goal = (Number.isFinite(gy) ? gy : oy - 20) + alt;
      const climb = clamp(goal - oy, -4, 3);
      b.vy = lerp(b.vy, climb, dt * 1.5);
      ny = oy + b.vy * dt;
      if (Number.isFinite(gy) && ny <= gy + 0.05) {
        ny = gy;
        if (landing) { b.airborne = false; b.vy = 0; }
      }
      if (ctx.terrain.density(nx, ny + e.height, nz) > 0) { nx = ox; nz = oz; b.vy = 2; b.wanderYaw += 2.2; }
      const glide = b.vy < -0.6 && Math.hypot(vx, vz) > sp.walkSpeed * 2;
      this.commit(b, nx, ny, nz, dt, b.airborne ? (glide ? 'glide' : 'fly') : moveState);
      return;
    }

    // ---- walkers (ground, amphibious, burrow, climb, landed flyers)
    let gy = this.ground(nx, oy + Math.max(1.2, e.height), nz);
    const climber = sp.medium === 'climb';
    let state = moveState;
    if (Number.isFinite(gy)) {
      const step = gy - oy;
      const horiz = Math.hypot(nx - ox, nz - oz);
      const slope = horiz > 1e-4 ? step / horiz : 0;
      const maxSlope = climber ? 50 : 1.25 + (sp.limbs.pairs >= 3 ? 0.8 : 0);
      const water = gy < wl - Math.max(0.5, e.height * 0.7);
      const avoidWater = water && !sp.swims && b.behavior !== 'flee';
      if ((slope > maxSlope && step > 0.25) || avoidWater || step > Math.max(1.5, e.height * 2)) {
        // Blocked: slide back and pick another heading.
        nx = ox; nz = oz;
        gy = this.ground(ox, oy + 1, oz);
        b.stuck++;
        b.wanderYaw += (b.rng.chance(0.5) ? 1 : -1) * (0.8 + b.stuck * 0.2);
        if (b.behavior === 'flee' || b.behavior === 'hunt' || b.behavior === 'attack') e.yaw += (b.rng.chance(0.5) ? 1 : -1) * 0.6;
        b.speed *= 0.5;
      } else b.stuck = Math.max(0, b.stuck - 1);
      if (climber && slope > 1.4 && b.speed > 0.1) state = 'climb';
      if (water && sp.swims && gy < wl - e.height) {
        // Swimming land animal: float at the surface.
        ny = wl - e.height * 0.55;
        e.flags |= EntFlag.Swimming;
        this.commit(b, nx, ny, nz, dt, 'swim');
        return;
      }
    }
    e.flags &= ~EntFlag.Swimming;
    // Gravity: leaps & falls.
    if (Number.isFinite(gy) && (oy > gy + 0.3 || b.vy > 0)) {
      b.vy -= gAcc * dt;
      ny = oy + b.vy * dt;
      if (ny <= gy) { ny = gy; b.vy = 0; e.grounded = true; }
      else { e.grounded = false; if (b.vy < -2) state = 'fall'; }
    } else if (Number.isFinite(gy)) {
      // Smoothly follow the ground (avoid jitter on steps).
      ny = gy > oy ? gy : lerp(oy, gy, clamp(dt * 12, 0, 1));
      b.vy = 0;
      e.grounded = true;
    } else {
      b.vy -= gAcc * dt;
      ny = oy + b.vy * dt;
      e.grounded = false;
      state = 'fall';
    }
    this.commit(b, nx, ny, nz, dt, state);
  }

  private commit(b: Brain, nx: number, ny: number, nz: number, dt: number, state: MoveState) {
    const e = b.e;
    const p = e.pos;
    const vx = (nx - p[0]) / dt, vy = (ny - p[1]) / dt, vz = (nz - p[2]) / dt;
    const moved = Math.abs(nx - p[0]) + Math.abs(ny - p[1]) + Math.abs(nz - p[2]) > 1e-4;
    p[0] = nx; p[1] = ny; p[2] = nz;
    e.vel[0] = vx; e.vel[1] = clamp(vy, -40, 40); e.vel[2] = vz;
    const sp = Math.hypot(vx, vz);
    let move: MoveState = state;
    if ((state === 'walk' || state === 'run' || state === 'sprint') && sp < 0.05) move = 'idle';
    else if (state === 'walk' && sp > b.sp.walkSpeed * 1.6) move = 'run';
    if (e.anim.move !== move) { e.anim = { ...e.anim, move }; }
    if (moved) this.ctx.entities.reindex(e);
    e.dirty = true;
  }

  private fallCorpse(b: Brain, dt: number) {
    const e = b.e;
    if (b.sp.medium === 'water') {
      // Dead fish drift to the surface.
      const top = this.waterLevel(e.pos) - 0.1;
      e.pos[1] = Math.min(top, e.pos[1] + dt * 0.5);
      e.vel = [0, e.pos[1] >= top ? 0 : 0.5, 0];
    } else {
      const gy = this.ground(e.pos[0], e.pos[1] + 1, e.pos[2]);
      b.vy -= this.ctx.gravityAt(e.pos) * dt;
      e.pos[1] += b.vy * dt;
      if (!Number.isFinite(gy) || e.pos[1] <= gy) {
        if (Number.isFinite(gy)) e.pos[1] = gy;
        e.vel = [0, 0, 0];
        b.vy = 0;
      } else e.vel = [0, b.vy, 0];
    }
    this.ctx.entities.reindex(e);
    e.dirty = true;
  }

  // ================================================================ combat

  private attack(b: Brain, target: ServerEntity, kind: AttackKind) {
    const e = b.e;
    const dur = ACTION_DUR[kind] ?? 0.8;
    this.startAction(e, kind, dur);
    b.attackCd = dur + b.rng.range(0.6, 1.4) * (b.boss ? 0.7 : 1);
    b.pendingHit = { at: this.ctx.time.now + dur * (kind === 'pounce' ? 0.55 : kind === 'charge' ? 0.6 : 0.5), target: target.id, kind };
    if (kind === 'pounce' || kind === 'charge') {
      // Leap/charge impulse (gravity-aware).
      const g = this.ctx.gravityAt(e.pos);
      if (kind === 'pounce') b.vy = Math.sqrt(2 * g * Math.max(0.5, b.sp.hipHeight * 1.2));
      b.speed = b.sp.runSpeed * 1.3;
    }
    if (kind === 'spit') this.ctx.broadcast({ type: 'fx', fx: 'spit', pos: [e.pos[0], e.pos[1] + e.height * 0.7, e.pos[2]], dir: [target.pos[0] - e.pos[0], target.pos[1] - e.pos[1], target.pos[2] - e.pos[2]], target: target.id, color: b.sp.colors.glow }, e.pos);
    this.ctx.broadcast({ type: 'sound', sound: 'creature_' + kind, pos: e.pos, volume: clamp(e.mass / 150, 0.3, 1.4) }, e.pos, 50);
  }

  private resolveHit(b: Brain) {
    const ph = b.pendingHit!;
    b.pendingHit = null;
    const e = b.e;
    const t = this.ctx.entities.get(ph.target);
    if (!t || !t.alive || !e.alive) return;
    const sp = b.sp;
    const scale = individualScale(sp, e.creature!.seed, e.creature!.growth) * e.scale;
    const d = Math.hypot(t.pos[0] - e.pos[0], t.pos[1] - e.pos[1], t.pos[2] - e.pos[2]);
    const reach = (ph.kind === 'spit' ? 12 : sp.reach * scale + (ph.kind === 'pounce' ? 1.5 : 0.6)) + t.radius + e.radius * 0.3;
    if (d > reach) return;
    const mult = ph.kind === 'charge' ? 1.4 : ph.kind === 'pounce' ? 1.3 : ph.kind === 'spit' ? 0.7 : ph.kind === 'claw' ? 0.9 : 1;
    const type: DamageType = ph.kind === 'sting' || ph.kind === 'spit' ? 'poison' : ph.kind === 'charge' ? 'blunt' : ph.kind === 'claw' ? 'slash' : (sp.damageType as DamageType);
    const amount = Math.max(1, Math.round(sp.damage * mult * b.dmgMul * b.rng.range(0.8, 1.2)));
    const combat = this.ctx.services.combat;
    combat.damage(t, amount, type, e, { pos: [t.pos[0], t.pos[1] + t.height * 0.5, t.pos[2]], knockback: ph.kind === 'charge' ? 6 : ph.kind === 'pounce' ? 3 : 0 });
    if (ph.kind === 'charge' || (ph.kind === 'pounce' && e.mass > t.mass)) {
      const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
      const dl = Math.hypot(dx, dz) || 1;
      const k = clamp(e.mass / Math.max(20, t.mass), 0.5, 4) * 3;
      combat.knockback(t, [(dx / dl) * k, k * 0.5, (dz / dl) * k]);
    }
    if ((ph.kind === 'sting' || ph.kind === 'spit') && sp.damageType === 'poison') combat.applyEffect(t, 'poison', Math.max(1, sp.damage * 0.2), 6, e);
    if (!t.alive && t.kind === 'creature') {
      // Kill: stay and eat.
      b.target = t.id;
      b.goal = [t.pos[0], t.pos[1], t.pos[2]];
      this.setBehavior(b, 'eat', 10);
    }
  }

  private onDamage(target: ServerEntity, source: ServerEntity | undefined, amount: number) {
    const b = this.brains.get(target.id);
    if (b && target.alive) {
      const now = this.ctx.time.now;
      b.hurtAt = now;
      if (source && source.id !== target.id) {
        b.target = source.id;
        b.awareOf = source.id;
        b.aware = 1;
        const frac = amount / Math.max(1, target.maxHp);
        const brave = b.sp.temperament === 'aggressive' || b.sp.temperament === 'territorial' || b.boss || b.tamedBy !== undefined;
        if (brave) b.anger = clamp(b.anger + 0.5 + frac, 0, 1);
        else b.fear = clamp(b.fear + 0.5 + frac * 2, 0, 1);
        const g = this.groups.get(b.group);
        if (g) { g.alarm = 1; if (b.sp.sociality === 'pack' || brave) g.target = source.id; }
        if (b.behavior === 'sleep') this.setBehavior(b, 'alert', 0.5);
        b.thinkAt = now; // react immediately
      }
      if (!target.anim.action || now > target.anim.action.t0 + target.anim.action.dur) this.startAction(target, 'flinch');
    }
    // Tamed companions defend their owner & help with the owner's fights.
    if (source && source.alive) {
      for (const c of this.brains.values()) {
        if (c.tamedBy === undefined || !c.e.alive) continue;
        if (target.id === c.tamedBy && source.id !== c.e.id) { c.target = source.id; c.thinkAt = 0; }
        else if (source.id === c.tamedBy && target.kind !== 'player' && c.target === undefined) { c.target = target.id; c.thinkAt = 0; }
      }
    }
  }

  private onDeath(entity: ServerEntity, killer?: ServerEntity) {
    const b = this.brains.get(entity.id);
    if (!b) {
      // A prey/target died: hunters stop chasing it.
      for (const o of this.brains.values()) if (o.target === entity.id && o.behavior !== 'eat') { o.target = undefined; o.until = 0; }
      return;
    }
    const e = entity;
    b.behavior = 'dead';
    b.pendingHit = null;
    e.flags &= ~(EntFlag.Hostile | EntFlag.InCombat | EntFlag.Sleeping);
    e.anim = { move: 'dead', action: { id: 'die', t0: this.ctx.time.now, dur: ACTION_DUR.die } };
    if (e.creature) e.creature.behavior = 'dead';
    e.light = undefined;
    e.vel = [0, -0.01, 0];
    e.dirty = true;
    for (const o of this.brains.values()) if (o.target === e.id && o.behavior !== 'eat') { o.target = undefined; o.until = 0; }
    void killer; // loot is dropped by the item system on the same bus event (see loot:* tags)
  }

}

function lerpYaw(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * clamp(t, 0, 1);
}

void tmpV;
