/**
 * Server ItemSystem — authoritative items, inventory, equipment, loot,
 * crafting and trade.
 *
 * Responsibilities:
 *  - ItemService for other systems: create / rollLoot / give / take / drop /
 *    equip / outfitFor / valueOf / def.
 *  - Client intents: equip, unequip, useItem, dropItem, pickup (+ generic
 *    `interact` on item entities), trade, craft (incl. "repair:<uid>"), place.
 *  - Ground items: physics settle, lifetime, merging of identical stacks,
 *    placed torches that light the world and burn out.
 *  - Light sources: equipped torches/lanterns drive `entity.light` and burn fuel.
 *  - Durability: weapons wear on hits, armor when struck, tools when used;
 *    broken gear is unequipped and can be repaired at a forge/workbench.
 *  - Death drops: creatures drop table loot by size, NPCs drop their purse,
 *    pack and a piece or two of worn gear.
 *  - Merchants (entity tag 'merchant'): stock per job/settlement wealth,
 *    restocked daily; prices from disposition + barter skill.
 *
 * After any inventory/equipment change: skills.recomputeStats(entity),
 * markPlayerDirty(id, 'inventory' | 'equipment' | 'stats'), bus events.
 *
 * Server code: no three.js / DOM.
 */
import type { ItemService, ServerContext, ServerSystem, ServerBusEvents } from '../../server/context';
import { makeEntity, type ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import type { EntityId, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { EquipSlot, ItemDef, ItemInstance } from '../types';
import { EQUIP_SLOTS } from '../types';
import { itemDef } from '../data/catalog';
import { materialDef, GEMS } from '../data/materials';
import { recipeDef, type RecipeDef } from '../data/recipes';
import { createItem, itemWeight, pickMaterial, type CreateOpts } from '../gen/generate';
import { rollLootTable } from '../gen/loot';
import { outfitPlan } from '../gen/outfit';
import { buyPrice, merchantStock, sellPrice, type PriceContext } from '../gen/trade';
import { addItem, carriedWeight, consumeDef, countOf, equippedLight, planEquip, removeItem } from '../inventory';
import { getPlayerData } from '../../server/systems/playerData';
import { SEA_LEVEL } from '../../world/constants';
import { clamp } from '../../core/math';
import { Rng, deriveSeed, hashString } from '../../core/rng';

/** Ground-item bookkeeping. */
interface GroundState {
  expires: number;
  vel: Vec3;
  resting: boolean;
  /** Placed deliberately (torches, markers): no merging, persistent. */
  placed: boolean;
  /** Fuel-burning placed light. */
  burning: boolean;
}

interface MerchantState {
  day: number;
  stock: ItemInstance[];
  coins: number;
  table: string;
  wealth: number;
  level: number;
  style: string;
  job: string;
}

interface SavedState {
  seq: number;
  uniques: string[];
  ground: { item: ItemInstance; pos: Vec3; burning: boolean }[];
}

const PICKUP_RANGE = 3.2;
const TRADE_RANGE = 7;
const PLACE_RANGE = 6;
const LOOT_LIFETIME = 600;
const DROP_LIFETIME = 900;
const MAX_GROUND = 500;
const CONSUME_COOLDOWN = 0.8;

export class ItemSystem implements ServerSystem, ItemService {
  readonly name = 'items';
  private ctx!: ServerContext;
  private seq = 1;
  private ground = new Map<EntityId, GroundState>();
  private merchants = new Map<EntityId, MerchantState>();
  /** Unique artifacts that already exist in this world. */
  private uniquesOut = new Set<string>();
  private consumeReady = new Map<EntityId, number>();
  /** Players whose equipment durability/fuel changed (flushed once per second). */
  private wearDirty = new Set<EntityId>();
  private pendingGround: SavedState['ground'] = [];

  // ================================================================ lifecycle

  init(ctx: ServerContext) {
    this.ctx = ctx;
    ctx.bus.on('death', ({ entity, killer }) => this.onDeath(entity, killer));
    ctx.bus.on('damage', ({ target, source, amount }) => this.onDamage(target, source, amount));
    ctx.bus.on('harvest', ({ entity }) => this.wearTool(entity, 0.5));
    ctx.bus.on('terrainEdited', ({ source }) => source && this.wearTool(source, 0.3));
  }

  private uid(): string {
    return 'i' + (this.seq++).toString(36);
  }

  // ================================================================ ItemService

  create(defId: string, opts: { count?: number; level?: number; rarity?: string; material?: string; seed?: number; style?: string } & Partial<CreateOpts> = {}): ItemInstance {
    const seed = opts.seed ?? deriveSeed(this.ctx.seed, 'item', defId, this.seq);
    const it = createItem(defId, { ...opts, seed, uid: this.uid() });
    if (it.rarity === 'unique' && it.data?.unique) this.uniquesOut.add(String(it.data.unique));
    return it;
  }

  rollLoot(table: string, level: number, seed: number): ItemInstance[] {
    const items = rollLootTable(table, level, deriveSeed(this.ctx.seed, seed), { uid: () => this.uid(), excludeUniques: this.uniquesOut, style: this.styleAt(undefined, seed) });
    return items;
  }

  give(entity: ServerEntity, item: ItemInstance, how: ServerBusEvents['itemAcquired']['how'] = 'gift'): boolean {
    const inv = (entity.inventory ??= { items: [], capacity: 60, coins: 0 });
    // Hard cap: refuse beyond 150% capacity and drop at the entity's feet instead.
    const cap = this.capacityOf(entity);
    if (item.defId !== 'coins' && carriedWeight(inv, entity.equipment) + itemWeight(item) * item.count > cap * 1.5) {
      this.drop([entity.pos[0], entity.pos[1] + 0.5, entity.pos[2]], item);
      if (entity.kind === 'player') this.notify(entity, `Too heavy to carry: ${item.name} dropped.`, 'warn');
      return false;
    }
    const snapshot = { ...item };
    addItem(inv, item);
    if (entity.kind === 'player') {
      this.ctx.markPlayerDirty(entity.id, 'inventory');
      this.ctx.send(entity.id, { t: 'events', events: [{ type: 'loot', items: [snapshot.count > 1 ? `${snapshot.count}× ${snapshot.name}` : snapshot.name] }] });
    }
    this.ctx.bus.emit('itemAcquired', { entity, item: snapshot, how });
    return true;
  }

  take(entity: ServerEntity, uid: string, count?: number): ItemInstance | null {
    const inv = entity.inventory;
    if (!inv) return null;
    const it = removeItem(inv, uid, count, this.uid());
    if (it && entity.kind === 'player') this.ctx.markPlayerDirty(entity.id, 'inventory');
    return it;
  }

  drop(pos: Vec3, item: ItemInstance, vel?: Vec3): ServerEntity {
    return this.spawnGround(pos, item, vel, false, DROP_LIFETIME);
  }

  equip(entity: ServerEntity, uid: string, slot?: string): boolean {
    const inv = entity.inventory;
    if (!inv) return false;
    let it = inv.items.find((x) => x.uid === uid);
    if (!it) return false;
    const d = itemDef(it.defId);
    if (!d || !d.slots.length) return false;
    if (it.durability <= 0 && it.maxDurability > 0 && !d.light) {
      if (entity.kind === 'player') this.notify(entity, `${it.name} is broken. Repair it first.`, 'warn');
      return false;
    }
    const eq = (entity.equipment ??= {});
    const plan = planEquip(d, eq, slot as EquipSlot | undefined);
    if (!plan) return false;
    // Stacks (torches, throwing knives): equip a split of one... except thrown weapons, which equip whole.
    if (it.count > 1 && !d.weapon?.ranged) it = removeItem(inv, uid, 1, this.uid())!;
    else inv.items.splice(inv.items.indexOf(it), 1);
    for (const s of plan.clear) {
      const old = eq[s];
      if (old) {
        delete eq[s];
        addItem(inv, old);
      }
    }
    eq[plan.slot] = it;
    this.afterGearChange(entity);
    this.ctx.bus.emit('itemEquipped', { entity, item: it });
    return true;
  }

  outfitFor(entity: ServerEntity, job: string, wealth: number, seed: number): void {
    const race = entity.humanoid?.race ?? 'human';
    entity.inventory ??= { items: [], capacity: 80, coins: 0 };
    entity.equipment ??= {};
    const rng = new Rng(seed);
    for (const p of outfitPlan(race, job, wealth, seed)) {
      let it: ItemInstance;
      try {
        it = createItem(p.defId, { level: p.level, style: race, material: p.material, source: 'outfit', seed: rng.nextU32(), uid: this.uid() });
      } catch {
        continue;
      }
      const d = itemDef(it.defId)!;
      const plan = planEquip(d, entity.equipment);
      if (!plan || plan.clear.length) {
        addItem(entity.inventory, it);
        continue;
      }
      entity.equipment[plan.slot] = it;
    }
    // Purse & pack (what they would drop or what a thief could lift).
    const pack = rollLootTable(`npc.${job}`, Math.round(1 + wealth * 12), seed, { uid: () => this.uid(), style: race, source: 'outfit' });
    for (const it of pack) addItem(entity.inventory, it);
    entity.inventory.coins += Math.round(wealth * 30 * rng.float());
    this.afterGearChange(entity);
  }

  valueOf(item: ItemInstance): number {
    return item.value;
  }

  def(defId: string): ItemDef | undefined {
    return itemDef(defId);
  }

  // ================================================================ messages

  onMessage(p: ServerEntity, msg: ClientMessage): boolean {
    switch (msg.t) {
      case 'equip':
        if (p.alive && !this.equip(p, msg.uid, msg.slot)) this.notify(p, 'You cannot equip that.', 'warn');
        return true;
      case 'unequip':
        this.unequip(p, msg.slot);
        return true;
      case 'useItem':
        if (p.alive) this.useItem(p, msg.uid);
        return true;
      case 'dropItem':
        this.dropFromInventory(p, msg.uid, msg.count);
        return true;
      case 'pickup':
        this.pickup(p, msg.entity);
        return true;
      case 'interact': {
        const e = msg.target !== undefined ? this.ctx.entities.get(msg.target) : undefined;
        if (e && e.kind === 'item') {
          this.pickup(p, e.id);
          return true;
        }
        return false;
      }
      case 'trade':
        this.trade(p, msg.npc, msg.buy, msg.sell);
        return true;
      case 'craft':
        this.craft(p, msg.recipe);
        return true;
      case 'place':
        this.place(p, msg.itemUid, msg.point);
        return true;
    }
    return false;
  }

  onPlayerJoin(p: ServerEntity) {
    if (p.inventory) p.inventory.knownRecipes ??= [];
    this.updateLight(p);
  }

  // ================================================================ equipment

  unequip(e: ServerEntity, slot: EquipSlot): boolean {
    const eq = e.equipment;
    const it = eq?.[slot];
    if (!eq || !it) return false;
    delete eq[slot];
    addItem((e.inventory ??= { items: [], capacity: 60, coins: 0 }), it);
    this.afterGearChange(e);
    return true;
  }

  /** Stats, light, snapshot & replication after equipment changed. */
  private afterGearChange(e: ServerEntity) {
    try {
      this.ctx.services.skills.recomputeStats(e);
    } catch (err) {
      this.ctx.log('[items] recomputeStats failed', err);
    }
    this.updateLight(e);
    e.dirty = true;
    if (e.kind === 'player') this.ctx.markPlayerDirty(e.id, 'equipment', 'inventory', 'stats');
  }

  /** Entity light from equipped torch/lantern or a light effect. */
  private updateLight(e: ServerEntity) {
    const l = equippedLight(e.equipment);
    let light: ServerEntity['light'];
    if (l) {
      const glowing = l.item.visual.glow > 0.3;
      const color = (glowing ? l.item.visual.glowColor : l.def.light!.color) as [number, number, number];
      light = { color, intensity: 1, radius: l.def.light!.radius + (l.item.mods.lightRadius ?? 0) - (l.def.baseMods?.lightRadius ?? 0) };
    } else {
      const fx = e.effects.find((x) => x.id === 'light' && x.until > this.ctx.time.now);
      if (fx) light = { color: [1, 0.95, 0.8], intensity: 0.9, radius: fx.magnitude || 10 };
    }
    const prev = e.light;
    if (prev?.radius !== light?.radius || prev?.color !== light?.color) {
      e.light = light;
      e.dirty = true;
    }
  }

  // ================================================================ use

  private useItem(p: ServerEntity, uid: string) {
    const inv = p.inventory;
    if (!inv) return;
    let it = inv.items.find((x) => x.uid === uid);
    let equippedSlot: EquipSlot | undefined;
    if (!it && p.equipment) for (const s of EQUIP_SLOTS) if (p.equipment[s]?.uid === uid) ((it = p.equipment[s]), (equippedSlot = s));
    if (!it) return;
    const d = itemDef(it.defId);
    if (!d) return;
    const now = this.ctx.time.now;

    // Lanterns: refuel with wax or resin.
    if (d.light && !d.stackable && d.light.fuel && it.durability < it.maxDurability) {
      const fuel = countOf(inv, 'wax') ? 'wax' : countOf(inv, 'resin') ? 'resin' : null;
      if (!fuel) return this.notify(p, `${it.name} needs wax or resin to refuel.`, 'warn');
      consumeDef(inv, fuel, 1);
      it.durability = it.maxDurability;
      this.notify(p, `You refuel the ${it.name.toLowerCase()}.`, 'good');
      this.afterGearChange(p);
      return;
    }
    // Equippables: toggle.
    if (d.slots.length && !d.consumable) {
      if (equippedSlot) this.unequip(p, equippedSlot);
      else this.equip(p, uid);
      return;
    }
    if (d.book) return this.readBook(p, it, d);
    if (!d.consumable) return;
    if ((this.consumeReady.get(p.id) ?? 0) > now) return;
    this.consumeReady.set(p.id, now + CONSUME_COOLDOWN);

    // Waterskins: refill in water, otherwise drink a charge.
    if (d.charges) {
      if (this.nearWater(p) && it.durability < it.maxDurability) {
        it.durability = it.maxDurability;
        this.notify(p, 'You refill the waterskin.', 'good');
        this.ctx.markPlayerDirty(p.id, 'inventory');
        return;
      }
      if (it.durability <= 0) return this.notify(p, 'The waterskin is empty. Refill it at a lake or river.', 'warn');
      it.durability--;
    } else {
      const used = removeItem(inv, uid, 1, this.uid());
      if (used) this.ctx.bus.emit('itemLost', { entity: p, item: used, how: 'consume' });
    }
    const drink = d.tags?.includes('potion') || d.visual.shape.startsWith('potion') || d.id === 'waterskin' || d.id === 'ale' || d.id === 'wine';
    const scroll = d.tags?.includes('scroll');
    p.anim = { ...p.anim, action: { id: scroll ? 'cast_self' : drink ? 'drink' : 'eat', t0: now, dur: scroll ? 1 : 1.4 } };
    p.dirty = true;
    for (const fx of d.consumable.effects) this.applyConsumableEffect(p, fx.id, fx.magnitude, fx.duration, it);
    this.ctx.broadcast({ type: 'sound', sound: scroll ? 'scroll_read' : drink ? 'drink' : 'eat', pos: p.pos }, p.pos, 25);
    if (d.category === 'food') this.grantXp(p, 'cooking', 1);
    if (d.tags?.includes('potion')) this.grantXp(p, 'alchemy', 1);
    this.ctx.markPlayerDirty(p.id, 'inventory', 'vitals', 'effects');
  }

  /**
   * Consumable effects. `restore_*`, `cure_poison`, `recall`, `firestorm`
   * resolve here; everything else becomes a timed status effect handled by
   * the gameplay module (regen_*, well_fed, resist_*, haste, featherfall,
   * levitate, waterwalk, swim_boost, water_breathing, leap_boost,
   * night_vision, invisibility, strength, fortitude, clarity, luck,
   * fortify_armor, reveal, courage, clumsy, poison, light).
   */
  private applyConsumableEffect(p: ServerEntity, id: string, mag: number, dur: number, item: ItemInstance) {
    const ctx = this.ctx;
    const combat = ctx.services.combat;
    switch (id) {
      case 'restore_hp':
        combat.heal(p, mag, p);
        return;
      case 'restore_stamina':
        p.stamina = Math.min(p.stats?.maxStamina ?? 100, p.stamina + mag);
        return;
      case 'restore_mana':
        p.mana = Math.min(p.stats?.maxMana ?? 100, p.mana + mag);
        return;
      case 'cure_poison':
        p.effects = p.effects.filter((e) => e.id !== 'poison' && e.id !== 'poisoned');
        ctx.markPlayerDirty(p.id, 'effects');
        return;
      case 'recall': {
        const pd = p.kind === 'player' ? getPlayerData(ctx, p.id) : undefined;
        if (!pd) return;
        p.pos = [pd.home[0], pd.home[1] + 0.5, pd.home[2]];
        p.vel = [0, 0, 0];
        p.tags.add('teleportGrace');
        ctx.entities.reindex(p);
        ctx.send(p.id, { t: 'correct', pos: p.pos, vel: [0, 0, 0], reason: 'recall' });
        ctx.broadcast({ type: 'fx', fx: 'recall', pos: p.pos, color: [0.6, 0.8, 1], duration: 1.5 }, p.pos, 80);
        return;
      }
      case 'firestorm': {
        ctx.broadcast({ type: 'fx', fx: 'firestorm', pos: p.pos, radius: 7, color: [1, 0.45, 0.1], duration: 1.5 }, p.pos, 120);
        ctx.broadcast({ type: 'shake', pos: p.pos, strength: 0.6 }, p.pos, 60);
        for (const t of ctx.entities.near(p.pos, 7, (e) => e !== p && e.alive && (e.kind === 'creature' || e.kind === 'npc'))) {
          if (!combat.isHostile(p, t) && t.kind === 'npc') continue;
          combat.damage(t, mag, 'fire', p, { ability: 'scroll_firestorm', pos: t.pos, knockback: 4 });
          combat.applyEffect(t, 'burning', 4, 4, p);
        }
        return;
      }
      default:
        combat.applyEffect(p, id, mag, dur, p);
        if (id === 'light') {
          // Light effect is mirrored to the entity light immediately (refreshed in slowTick).
          p.light = { color: [1, 0.95, 0.8], intensity: 0.9, radius: mag || 10 };
          p.dirty = true;
        }
        void item;
    }
  }

  private readBook(p: ServerEntity, it: ItemInstance, d: ItemDef) {
    const data = (it.data ??= {});
    const title = String(data.title ?? it.name);
    if (d.book!.kind === 'skill' && data.skill) {
      if (data.read) return this.notify(p, `You leaf through “${title}” again. Nothing new to learn.`, 'info');
      data.read = true;
      this.grantXp(p, String(data.skill), Number(data.xp ?? 200));
      this.notify(p, `You study “${title}”. Your ${String(data.skill).replace('_', ' ')} improves.`, 'good');
    } else if (d.book!.kind === 'recipe' && data.recipe) {
      const r = recipeDef(String(data.recipe));
      const known = (p.inventory!.knownRecipes ??= []);
      if (!r) return;
      if (known.includes(r.id)) return this.notify(p, `You already know how to make ${r.name}.`, 'info');
      known.push(r.id);
      removeItem(p.inventory!, it.uid, 1);
      this.ctx.bus.emit('itemLost', { entity: p, item: it, how: 'consume' });
      this.notify(p, `Recipe learned: ${r.name}.`, 'good');
    } else {
      if (!data.read) {
        data.read = true;
        this.grantXp(p, 'speech', 5);
      }
      this.notify(p, `You read “${title}”${data.author ? ` by ${data.author}` : ''}.`, 'info');
    }
    p.anim = { ...p.anim, action: { id: 'channel', t0: this.ctx.time.now, dur: 1.5 } };
    p.dirty = true;
    this.ctx.markPlayerDirty(p.id, 'inventory');
  }

  private nearWater(p: ServerEntity): boolean {
    if (p.flags & EntFlag.Swimming) return true;
    const [x, y, z] = p.pos;
    if (y > SEA_LEVEL + 2.5) return false;
    for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const g = this.ctx.groundAt(x + dx, y + 2, z + dz, 6);
      if (Number.isFinite(g) && g < SEA_LEVEL - 0.2) return true;
    }
    return false;
  }

  // ================================================================ drop / pickup / place

  private dropFromInventory(p: ServerEntity, uid: string, count?: number) {
    const it = this.take(p, uid, count);
    if (!it) return;
    const f: Vec3 = [-Math.sin(p.yaw), 0, -Math.cos(p.yaw)];
    const pos: Vec3 = [p.pos[0] + f[0] * 0.8, p.pos[1] + 1.1, p.pos[2] + f[2] * 0.8];
    this.drop(pos, it, [f[0] * 2.5, 2, f[2] * 2.5]);
    this.ctx.bus.emit('itemLost', { entity: p, item: it, how: 'drop' });
  }

  private pickup(p: ServerEntity, id: EntityId) {
    const e = this.ctx.entities.get(id);
    if (!e || e.kind !== 'item' || !e.item || !p.alive) return;
    const dx = e.pos[0] - p.pos[0], dz = e.pos[2] - p.pos[2], dy = e.pos[1] - (p.pos[1] + 0.9);
    if (dx * dx + dz * dz > PICKUP_RANGE * PICKUP_RANGE || Math.abs(dy) > 3) return this.notify(p, 'Too far away.', 'warn');
    const it = e.item;
    const cap = this.capacityOf(p);
    if (it.defId !== 'coins' && carriedWeight(p.inventory, p.equipment) + itemWeight(it) * it.count > cap * 1.5) return this.notify(p, 'You are carrying too much.', 'warn');
    this.ground.delete(e.id);
    this.ctx.despawn(e.id);
    if (it.defId === 'coins') {
      p.inventory!.coins += it.count;
      this.ctx.markPlayerDirty(p.id, 'inventory');
      this.ctx.send(p.id, { t: 'events', events: [{ type: 'loot', items: [`${it.count} coins`] }] });
      this.ctx.broadcast({ type: 'sound', sound: 'coins', pos: e.pos }, e.pos, 20);
      return;
    }
    p.anim = { ...p.anim, action: { id: 'pickup', t0: this.ctx.time.now, dur: 0.7 } };
    p.dirty = true;
    this.give(p, it, 'pickup');
    this.ctx.broadcast({ type: 'sound', sound: 'item_pickup', pos: e.pos }, e.pos, 20);
  }

  private place(p: ServerEntity, uid: string, point: Vec3) {
    const dx = point[0] - p.pos[0], dy = point[1] - p.pos[1], dz = point[2] - p.pos[2];
    if (dx * dx + dy * dy + dz * dz > PLACE_RANGE * PLACE_RANGE) return this.notify(p, 'Too far away.', 'warn');
    const it = this.take(p, uid, 1);
    if (!it) return;
    const d = itemDef(it.defId);
    const burning = !!d?.light;
    const e = this.spawnGround([point[0], point[1] + 0.02, point[2]], it, [0, 0, 0], true, Infinity);
    const g = this.ground.get(e.id)!;
    g.resting = true;
    g.burning = burning;
    if (burning && d?.light) e.light = { color: d.light.color, intensity: 1, radius: d.light.radius };
    p.anim = { ...p.anim, action: { id: 'pickup', t0: this.ctx.time.now, dur: 0.7 } };
    p.dirty = true;
    this.ctx.bus.emit('itemLost', { entity: p, item: it, how: 'drop' });
  }

  private spawnGround(pos: Vec3, item: ItemInstance, vel: Vec3 | undefined, placed: boolean, lifetime: number): ServerEntity {
    const ctx = this.ctx;
    // Keep the world tidy: retire the oldest non-placed ground items past the cap.
    if (this.ground.size >= MAX_GROUND) {
      let oldest: EntityId | undefined, t = Infinity;
      for (const [id, g] of this.ground) if (!g.placed && g.expires < t) ((t = g.expires), (oldest = id));
      if (oldest !== undefined) this.despawnGround(oldest);
    }
    const e = makeEntity(ctx.newEntityId(), 'item', pos, 'items', ctx.time.now);
    e.item = item;
    e.name = item.count > 1 ? `${item.name} ×${item.count}` : item.name;
    e.radius = 0.3;
    e.height = 0.3;
    e.mass = Math.max(0.05, itemWeight(item));
    e.persistent = placed || item.rarity === 'unique' || itemDef(item.defId)?.category === 'quest';
    e.yaw = (hashString(item.uid) % 628) / 100;
    ctx.spawn(e);
    this.ground.set(e.id, {
      expires: e.persistent ? Infinity : ctx.time.now + lifetime,
      vel: vel ? [vel[0], vel[1], vel[2]] : [0, 0, 0],
      resting: false,
      placed,
      burning: false,
    });
    return e;
  }

  private despawnGround(id: EntityId) {
    this.ground.delete(id);
    this.ctx.despawn(id);
  }

  onEntityRemoved(e: ServerEntity) {
    this.ground.delete(e.id);
    this.merchants.delete(e.id);
    this.consumeReady.delete(e.id);
  }

  // ================================================================ trade

  private priceCtx(p: ServerEntity, npc: ServerEntity, m: MerchantState): PriceContext {
    let disposition = 0;
    try {
      disposition = this.ctx.services.npcs.disposition(npc.id, p.id);
    } catch {
      disposition = 0;
    }
    return { disposition, barter: this.skillLevel(p, 'barter'), table: m.table, wealth: m.wealth };
  }

  private merchantFor(npc: ServerEntity): MerchantState {
    const day = this.ctx.time.day;
    let m = this.merchants.get(npc.id);
    if (m && m.day === day) return m;
    let job = 'merchant';
    try {
      job = this.ctx.services.npcs.profile(npc.id)?.job ?? job;
    } catch {
      /* npc service unavailable: general goods */
    }
    let wealth = 0.5;
    try {
      const site = this.ctx.services.settlements.siteAt(npc.pos);
      if (site) wealth = this.ctx.services.settlements.layout(site.id)?.wealth ?? wealth;
    } catch {
      /* settlement service unavailable */
    }
    const style = npc.humanoid?.race ?? 'human';
    const level = clamp(Math.round(3 + wealth * 14 + this.dangerLevel(npc.pos) * 0.5), 1, 35);
    const mseed = hashString(`${npc.name}|${Math.round(npc.pos[0])}|${Math.round(npc.pos[2])}`) ^ this.ctx.seed;
    const s = merchantStock(job, mseed, day, level, wealth, style, () => this.uid());
    // Keep items the player sold today? A new day brings a fresh stall.
    m = { day, stock: s.items, coins: s.coins, table: s.table, wealth, level, style, job };
    this.merchants.set(npc.id, m);
    return m;
  }

  private sendTrade(p: ServerEntity, npc: ServerEntity, m: MerchantState) {
    const pc = this.priceCtx(p, npc, m);
    const prices: Record<string, number> = {};
    for (const it of m.stock) prices[it.uid] = buyPrice(it, pc, 1);
    const sellPrices: Record<string, number> = {};
    for (const it of p.inventory?.items ?? []) sellPrices[it.uid] = sellPrice(it, pc, 1);
    this.ctx.send(p.id, { t: 'trade', npc: npc.id, stock: m.stock, prices, sellPrices });
  }

  /** Trade request: no buy/sell → open (send stock); otherwise execute. Entries may be "uid" or "uid:count". */
  private trade(p: ServerEntity, npcId: EntityId, buy?: string[], sell?: string[]) {
    const npc = this.ctx.entities.get(npcId);
    if (!npc || !npc.alive || !(npc.tags.has('merchant') || npc.flags & EntFlag.Merchant)) return this.notify(p, 'They have nothing to trade.', 'warn');
    const dx = npc.pos[0] - p.pos[0], dz = npc.pos[2] - p.pos[2];
    if (dx * dx + dz * dz > TRADE_RANGE * TRADE_RANGE) return this.notify(p, 'You are too far away to trade.', 'warn');
    const m = this.merchantFor(npc);
    const inv = p.inventory!;
    const pc = this.priceCtx(p, npc, m);
    let traded = 0;
    const parse = (s: string): [string, number | undefined] => {
      const i = s.lastIndexOf(':');
      return i > 0 ? [s.slice(0, i), Math.max(1, Math.floor(Number(s.slice(i + 1)) || 1))] : [s, undefined];
    };
    for (const entry of sell ?? []) {
      const [uid, count] = parse(entry);
      const it = inv.items.find((x) => x.uid === uid);
      if (!it) continue;
      if (itemDef(it.defId)?.category === 'quest') {
        this.notify(p, `${npc.name} won't take ${it.name}.`, 'warn');
        continue;
      }
      const n = Math.min(count ?? it.count, it.count);
      const price = sellPrice(it, pc, n);
      if (price > m.coins) {
        this.notify(p, `${npc.name} cannot afford that.`, 'warn');
        continue;
      }
      const sold = removeItem(inv, uid, n, this.uid())!;
      m.coins -= price;
      inv.coins += price;
      sold.visual.wear = Math.max(sold.visual.wear, 0.05);
      m.stock.push(sold);
      traded += price;
      this.ctx.bus.emit('itemLost', { entity: p, item: sold, how: 'sell' });
    }
    for (const entry of buy ?? []) {
      const [uid, count] = parse(entry);
      const idx = m.stock.findIndex((x) => x.uid === uid);
      if (idx < 0) continue;
      const it = m.stock[idx];
      const n = Math.min(count ?? it.count, it.count);
      const price = buyPrice(it, pc, n);
      if (price > inv.coins) {
        this.notify(p, `You cannot afford ${it.name}.`, 'warn');
        continue;
      }
      let bought: ItemInstance;
      if (n >= it.count) {
        m.stock.splice(idx, 1);
        bought = it;
      } else {
        it.count -= n;
        bought = { ...it, uid: this.uid(), count: n, mods: { ...it.mods }, affixes: it.affixes.slice(), visual: { ...it.visual } };
      }
      inv.coins -= price;
      m.coins += price;
      traded += price;
      this.give(p, bought, 'buy');
    }
    if (traded > 0) {
      this.grantXp(p, 'barter', Math.max(1, Math.round(traded / 25)));
      try {
        this.ctx.services.npcs.adjustDisposition(npc.id, p.id, Math.min(3, traded / 200), 'trade');
      } catch {
        /* npc service unavailable */
      }
      this.ctx.broadcast({ type: 'sound', sound: 'coins', pos: p.pos }, p.pos, 15);
      this.ctx.markPlayerDirty(p.id, 'inventory');
    }
    this.sendTrade(p, npc, m);
  }

  // ================================================================ crafting

  private craft(p: ServerEntity, recipeId: string) {
    if (!p.alive || !p.inventory) return;
    if (recipeId.startsWith('repair:')) return this.repair(p, recipeId.slice(7));
    const r = recipeDef(recipeId);
    if (!r) return this.notify(p, 'Unknown recipe.', 'warn');
    const inv = p.inventory;
    if (r.learnable && !(inv.knownRecipes ?? []).includes(r.id)) return this.notify(p, `You have not learned how to make ${r.name}.`, 'warn');
    const skill = this.skillLevel(p, r.skill);
    if (skill < r.level) return this.notify(p, `${r.name} requires ${r.skill.replace('_', ' ')} ${r.level} (you have ${Math.floor(skill)}).`, 'warn');
    const station = this.stationCheck(p, r.station);
    if (!station.ok) return this.notify(p, station.why, 'warn');
    for (const i of r.inputs) if (countOf(inv, i.id) < i.count) return this.notify(p, `Missing ${i.count}× ${itemDef(i.id)?.name ?? i.id}.`, 'warn');
    for (const i of r.inputs) {
      const used = consumeDef(inv, i.id, i.count);
      for (const u of used ?? []) this.ctx.bus.emit('itemLost', { entity: p, item: u, how: 'consume' });
    }
    const out = this.craftOutput(p, r, skill);
    p.anim = { ...p.anim, action: { id: r.station === 'forge' ? 'work_hammer' : r.group === 'woodworking' ? 'work_saw' : r.station === 'fire' ? 'harvest' : 'channel', t0: this.ctx.time.now, dur: 2 } };
    p.dirty = true;
    this.give(p, out, 'craft');
    this.grantXp(p, r.skill, r.xp);
    this.ctx.broadcast({ type: 'sound', sound: r.station === 'forge' ? 'anvil' : r.station === 'fire' ? 'sizzle' : 'craft', pos: p.pos }, p.pos, 30);
    this.notify(p, `Crafted ${out.count > 1 ? out.count + '× ' : ''}${out.name}.`, 'good');
  }

  private craftOutput(p: ServerEntity, r: RecipeDef, skill: number): ItemInstance {
    const seed = deriveSeed(this.ctx.seed, 'craft', p.id, this.seq);
    const style = p.humanoid?.race ?? 'human';
    let defId = r.output.id;
    if (r.randomGem) {
      const rng = new Rng(seed);
      defId = 'gem_' + rng.weighted(GEMS, (g) => (g.tier * 20 > skill + 20 ? 0.05 : 1 + g.tier * (skill / 50))).id;
    }
    const d = itemDef(defId)!;
    let material = r.output.material;
    if (!material && d.matClass && !d.stackable) material = pickMaterial(new Rng(seed ^ 0x51), d, Math.max(1, skill / 2.5), style).id;
    return createItem(defId, { count: r.output.count, material, seed, style, source: 'crafted', craftSkill: skill, level: Math.max(1, Math.round(skill / 2.5)), uid: this.uid() });
  }

  /** Repair an item (inventory or equipped) with one unit of its material. */
  private repair(p: ServerEntity, uid: string) {
    let it = p.inventory!.items.find((x) => x.uid === uid);
    if (!it && p.equipment) it = Object.values(p.equipment).find((x) => x?.uid === uid);
    if (!it) return;
    const d = itemDef(it.defId);
    if (!d || it.durability >= it.maxDurability || d.light || d.charges) return this.notify(p, 'That does not need repairing.', 'info');
    const mat = materialDef(it.material);
    const cls = d.matClass ?? 'metal';
    const need = cls === 'metal' ? (itemDef(`${it.material}_ingot`) ? `${it.material}_ingot` : 'iron_ingot') : cls === 'leather' ? 'leather' : cls === 'cloth' ? 'thread' : cls === 'wood' ? 'plank' : cls === 'bone' ? 'bone' : cls === 'gem' ? `${it.material}_ingot` : 'stone';
    const station = this.stationCheck(p, cls === 'metal' || cls === 'gem' ? 'forge' : null);
    if (!station.ok) return this.notify(p, station.why, 'warn');
    if (!consumeDef(p.inventory!, need, 1)) return this.notify(p, `Repairing needs 1× ${itemDef(need)?.name ?? need}.`, 'warn');
    it.durability = it.maxDurability;
    if (it.data?.broken) delete it.data.broken;
    const skill = cls === 'metal' || cls === 'gem' ? 'smithing' : cls === 'wood' ? 'woodcutting' : 'tailoring';
    this.grantXp(p, skill, 4 + (mat?.tier ?? 0) * 2);
    p.anim = { ...p.anim, action: { id: 'work_hammer', t0: this.ctx.time.now, dur: 1.5 } };
    p.dirty = true;
    this.notify(p, `${it.name} repaired.`, 'good');
    this.ctx.markPlayerDirty(p.id, 'inventory', 'equipment');
  }

  /**
   * Station checks (lenient): a forge means a smithy/forge spot nearby; a fire
   * is a hearth/cook spot, a tavern or house, a placed burning torch, or a lit
   * torch in hand; alchemy/workbench/loom accept any settlement workshop-like
   * building nearby (or, for workbench/loom, any building at all).
   */
  private stationCheck(p: ServerEntity, station: RecipeDef['station']): { ok: boolean; why: string } {
    if (!station) return { ok: true, why: '' };
    let buildings: ReturnType<ServerContext['services']['settlements']['buildingsNear']> = [];
    try {
      buildings = this.ctx.services.settlements.buildingsNear(p.pos, 25);
    } catch {
      buildings = [];
    }
    const near = (pos: Vec3, r: number) => {
      const dx = pos[0] - p.pos[0], dz = pos[2] - p.pos[2];
      return dx * dx + dz * dz <= r * r;
    };
    const hasSpot = (kinds: string[], r: number) => buildings.some((b) => b.spots.some((s) => kinds.includes(s.kind) && near(s.pos, r)));
    const hasRole = (roles: string[], r: number) => buildings.some((b) => roles.includes(b.role) && near(b.pos, r + Math.max(b.size[0], b.size[2]) / 2));
    switch (station) {
      case 'forge':
        return hasSpot(['forge'], 8) || hasRole(['smithy'], 6) ? { ok: true, why: '' } : { ok: false, why: 'You need a forge — find a smithy.' };
      case 'fire': {
        if (hasSpot(['cook', 'forge'], 6) || hasRole(['tavern', 'house', 'longhouse', 'hut', 'camp', 'smithy'], 4)) return { ok: true, why: '' };
        const l = equippedLight(p.equipment);
        if (l && l.def.id === 'torch') return { ok: true, why: '' };
        for (const e of this.ctx.entities.near(p.pos, 4, (x) => x.kind === 'item' && this.ground.get(x.id)?.burning === true)) if (e) return { ok: true, why: '' };
        return { ok: false, why: 'You need a fire: a hearth, a placed torch, or a lit torch in hand.' };
      }
      case 'alchemy':
        return hasRole(['workshop', 'mage_tower', 'temple', 'library', 'tavern', 'market'], 10) || hasSpot(['work', 'read'], 8) ? { ok: true, why: '' } : { ok: false, why: 'You need an alchemy bench — try a workshop, temple or mage tower.' };
      case 'workbench':
      case 'loom':
        return buildings.length > 0 ? { ok: true, why: '' } : { ok: false, why: `You need a ${station} — find a settlement.` };
    }
    return { ok: true, why: '' };
  }

  // ================================================================ durability & combat hooks

  private onDamage(target: ServerEntity, source: ServerEntity | undefined, amount: number) {
    if (amount <= 0) return;
    if (source?.equipment?.mainhand) this.wear(source, 'mainhand', 0.25);
    if (target.equipment) {
      const armored = (['chest', 'head', 'legs', 'shoulders', 'hands', 'feet', 'offhand'] as EquipSlot[]).filter((s) => target.equipment![s]?.mods.armor);
      // Deterministic piece choice from (target, time) so replays/servers agree.
      if (armored.length) this.wear(target, armored[hashString(`${target.id}:${this.ctx.time.now}`) % armored.length], Math.min(2, 0.15 + amount / 40));
    }
  }

  private wearTool(e: ServerEntity, amount: number) {
    if (e.equipment?.mainhand && itemDef(e.equipment.mainhand.defId)?.tool) this.wear(e, 'mainhand', amount);
  }

  private wear(e: ServerEntity, slot: EquipSlot, amount: number) {
    const it = e.equipment?.[slot];
    if (!it || it.maxDurability <= 0) return;
    const d = itemDef(it.defId);
    if (!d || d.light || d.charges) return;
    it.durability = Math.max(0, Math.round((it.durability - amount) * 100) / 100);
    if (e.kind === 'player') this.wearDirty.add(e.id);
    if (it.durability <= 0) {
      (it.data ??= {}).broken = true;
      this.unequip(e, slot);
      if (e.kind === 'player') this.notify(e, `${it.name} breaks!`, 'bad');
      this.ctx.broadcast({ type: 'sound', sound: 'item_break', pos: e.pos }, e.pos, 30);
      this.ctx.bus.emit('itemLost', { entity: e, item: it, how: 'break' });
    }
  }

  // ================================================================ death drops

  private onDeath(e: ServerEntity, killer?: ServerEntity) {
    if (e.kind === 'player') return;
    const level = clamp(Math.round(e.maxHp / 12), 1, 40);
    const seed = deriveSeed(this.ctx.seed, 'death', e.id);
    const items: ItemInstance[] = [];
    if (e.kind === 'creature') {
      const table = e.tags.has('boss') ? 'creature.boss' : e.mass < 15 ? 'creature.small' : e.mass < 150 ? 'creature.medium' : 'creature.large';
      items.push(...rollLootTable(table, level, seed, { uid: () => this.uid(), excludeUniques: this.uniquesOut, luck: killer?.kind === 'player' ? 1 : 0.7 }));
    } else if (e.kind === 'npc') {
      const inv = e.inventory;
      if (inv) {
        items.push(...inv.items.splice(0));
        if (inv.coins > 0) items.push(createItem('coins', { count: inv.coins, uid: this.uid(), seed }));
        inv.coins = 0;
      } else {
        let job = 'default';
        try {
          job = this.ctx.services.npcs.profile(e.id)?.job ?? job;
        } catch {
          /* no profile */
        }
        items.push(...rollLootTable(`npc.${job}`, level, seed, { uid: () => this.uid() }));
      }
      // A piece or two of worn gear falls too (weapons first).
      const rng = new Rng(seed);
      if (e.equipment) {
        const slots = (Object.keys(e.equipment) as EquipSlot[]).filter((s) => e.equipment![s]);
        slots.sort((a, b) => (a === 'mainhand' ? -1 : b === 'mainhand' ? 1 : 0));
        for (const s of slots.slice(0, rng.int(1, 2))) {
          const it = e.equipment[s]!;
          if (s !== 'mainhand' && !rng.chance(0.5)) continue;
          delete e.equipment[s];
          it.visual.wear = Math.min(1, it.visual.wear + 0.2);
          items.push(it);
        }
        e.dirty = true;
      }
    }
    const rng = new Rng(seed ^ 0x9e37);
    for (const it of items) {
      const a = rng.float() * Math.PI * 2;
      const s = rng.range(1, 2.5);
      this.spawnGround([e.pos[0], e.pos[1] + Math.max(0.5, e.height * 0.6), e.pos[2]], it, [Math.cos(a) * s, rng.range(2, 4), Math.sin(a) * s], false, LOOT_LIFETIME);
    }
  }

  // ================================================================ ticks

  tick(dt: number) {
    const ctx = this.ctx;
    for (const [id, g] of this.ground) {
      if (g.resting) continue;
      const e = ctx.entities.get(id);
      if (!e) {
        this.ground.delete(id);
        continue;
      }
      const grav = ctx.gravityAt(e.pos);
      g.vel[1] -= grav * dt;
      g.vel[0] *= 1 - Math.min(1, dt * 0.6);
      g.vel[2] *= 1 - Math.min(1, dt * 0.6);
      const nx = e.pos[0] + g.vel[0] * dt, ny = e.pos[1] + g.vel[1] * dt, nz = e.pos[2] + g.vel[2] * dt;
      const gy = ctx.groundAt(nx, e.pos[1] + 0.5, nz, 8);
      if (Number.isFinite(gy) && ny <= gy) {
        // Land with a small bounce, then rest.
        e.pos = [nx, gy, nz];
        if (Math.abs(g.vel[1]) > 3) {
          g.vel = [g.vel[0] * 0.4, -g.vel[1] * 0.25, g.vel[2] * 0.4];
        } else {
          g.vel = [0, 0, 0];
          g.resting = true;
        }
      } else if (!Number.isFinite(gy) && ny < e.pos[1] - 30) {
        // Fell into the void / deep water column: rest where it is.
        g.resting = true;
      } else e.pos = [nx, ny, nz];
      e.vel = g.resting ? [0, 0, 0] : [g.vel[0], g.vel[1], g.vel[2]];
      e.dirty = true;
      ctx.entities.reindex(e);
    }
  }

  slowTick(dt: number) {
    const ctx = this.ctx;
    const now = ctx.time.now;
    // Ground items: expiry, burning placed lights, merging stacks.
    for (const [id, g] of this.ground) {
      const e = ctx.entities.get(id);
      if (!e || !e.item) {
        this.ground.delete(id);
        continue;
      }
      if (g.expires < now) {
        this.despawnGround(id);
        continue;
      }
      if (g.burning) {
        e.item.durability -= dt;
        if (e.item.durability <= 0) {
          ctx.broadcast({ type: 'fx', fx: 'smoke_puff', pos: e.pos, duration: 2 }, e.pos, 60);
          this.despawnGround(id);
        }
        continue;
      }
      if (!g.resting || g.placed) continue;
      const d = itemDef(e.item.defId);
      if (!d?.stackable) continue;
      for (const o of ctx.entities.near(e.pos, 1.5, (x) => x !== e && x.kind === 'item' && !!x.item && x.item.defId === e.item!.defId)) {
        const og = this.ground.get(o.id);
        if (!og || !og.resting || og.placed || !o.item || o.item.material !== e.item.material || o.item.rarity !== e.item.rarity) continue;
        if (e.item.count + o.item.count > d.maxStack) continue;
        e.item.count += o.item.count;
        e.name = `${e.item.name} ×${e.item.count}`;
        g.expires = Math.max(g.expires, og.expires);
        e.dirty = true;
        this.despawnGround(o.id);
      }
    }
    // Equipped lights burn fuel (players); refresh light from effects.
    for (const p of ctx.players()) {
      const l = equippedLight(p.equipment);
      if (l && l.def.light?.fuel && l.item.maxDurability > 0) {
        l.item.durability = Math.max(0, l.item.durability - dt);
        if (Math.floor(l.item.durability) % 15 === 0) this.wearDirty.add(p.id);
        if (l.item.durability <= 0) this.burnOut(p, l.item, l.def);
      }
      this.updateLight(p);
    }
    for (const id of this.wearDirty) ctx.markPlayerDirty(id, 'equipment');
    this.wearDirty.clear();
  }

  /** A torch burns out (destroyed, next torch lit); a lantern just goes dark. */
  private burnOut(p: ServerEntity, it: ItemInstance, d: ItemDef) {
    const eq = p.equipment!;
    const slot = (Object.keys(eq) as EquipSlot[]).find((s) => eq[s] === it);
    if (!slot) return;
    if (d.stackable) {
      delete eq[slot];
      this.ctx.bus.emit('itemLost', { entity: p, item: it, how: 'consume' });
      const next = p.inventory?.items.find((x) => x.defId === it.defId);
      if (next) {
        this.equip(p, next.uid, slot);
        this.notify(p, `Your ${d.name.toLowerCase()} burns out. You light another.`, 'info');
      } else {
        this.notify(p, `Your ${d.name.toLowerCase()} burns out.`, 'warn');
        this.afterGearChange(p);
      }
    } else {
      this.notify(p, `Your ${it.name.toLowerCase()} gutters out. Refuel it with wax or resin.`, 'warn');
      this.afterGearChange(p);
    }
  }

  // ================================================================ helpers

  private capacityOf(e: ServerEntity): number {
    const inv = e.inventory;
    const base = inv?.capacity ?? 60;
    return Math.max(base, e.stats?.carry ?? 0);
  }

  private skillLevel(e: ServerEntity, skill: string): number {
    try {
      return this.ctx.services.skills.level(e, skill) || 0;
    } catch {
      return 0;
    }
  }

  private grantXp(e: ServerEntity, skill: string, amount: number) {
    if (e.kind !== 'player') return;
    try {
      this.ctx.services.skills.grantXp(e, skill, amount);
    } catch {
      /* gameplay service unavailable */
    }
  }

  private notify(p: ServerEntity, text: string, tone: 'info' | 'good' | 'bad' | 'warn' = 'info') {
    if (p.kind === 'player') this.ctx.send(p.id, { t: 'events', events: [{ type: 'notify', text, tone }] });
  }

  /** Culture style for loot near a position (settlement race), else a world race. */
  private styleAt(pos: Vec3 | undefined, seed: number): string {
    if (pos) {
      try {
        const site = this.ctx.services.settlements.siteAt(pos);
        if (site) return site.race;
      } catch {
        /* no settlements */
      }
    }
    const races = this.ctx.gen.profile?.races;
    if (races?.length) return new Rng(seed).weighted(races, (r) => r.weight).id;
    return 'human';
  }

  /** Rough danger band from distance to the world origin/spawn (deeper = higher level). */
  private dangerLevel(pos: Vec3): number {
    const d = Math.hypot(pos[0], pos[2]);
    return clamp(d / 400 + (pos[1] < -120 ? 10 : 0), 0, 30);
  }

  // ================================================================ persistence

  save(): SavedState {
    const ground: SavedState['ground'] = [];
    for (const [id, g] of this.ground) {
      const e = this.ctx.entities.get(id);
      if (e?.item && e.persistent) ground.push({ item: e.item, pos: e.pos, burning: g.burning });
    }
    return { seq: this.seq, uniques: [...this.uniquesOut], ground };
  }

  load(data: unknown) {
    const s = data as SavedState | undefined;
    if (!s) return;
    this.seq = Math.max(this.seq, s.seq ?? 1);
    for (const u of s.uniques ?? []) this.uniquesOut.add(u);
    this.pendingGround = s.ground ?? [];
    // Respawn persistent ground items (placed torches, quest items, uniques).
    for (const gi of this.pendingGround) {
      const e = this.spawnGround(gi.pos, gi.item, [0, 0, 0], true, Infinity);
      const g = this.ground.get(e.id)!;
      g.resting = true;
      g.burning = gi.burning;
      const d = itemDef(gi.item.defId);
      if (gi.burning && d?.light) e.light = { color: d.light.color, intensity: 1, radius: d.light.radius };
    }
    this.pendingGround = [];
  }
}
