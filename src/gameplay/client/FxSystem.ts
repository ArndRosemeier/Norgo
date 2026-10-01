/**
 * Client FX module: GPU particles, beams, ground decals, flash lights and
 * animated effect meshes for spells, impacts, damage, deaths, terrain edits,
 * status auras and weather; plus entity views for 'projectile' and 'effect'
 * entities.
 *
 * Inputs (all replicated by the server):
 *  - GameEvents: fx (named effects), damage, heal, death, impact, gravity, knockback
 *  - terrainEdits messages (dust & debris where the ground changed)
 *  - EntitySnapshot.fx "a:<aura>" tags, projectile/effect entity snapshots
 *  - ctx.env.weather for precipitation and lightning
 */
import * as THREE from 'three';
import type { ClientContext, ClientModule, EntityView, EntityViewFactory } from '../../client/context';
import type { EntitySnapshot, GameEvent, ServerMessage } from '../../shared/protocol';
import type { EntityKind } from '../../shared/types';
import type { TerrainEdit } from '../../world/edits';
import { MATERIALS } from '../../world/materials';
import { estimateSkyVis } from '../../render/skyOcclusion';
import { ParticlePool } from './particles';
import { BeamPool, DecalKind, DecalPool, FlashLights, MeshFxPool } from './pools';
import { FxLibrary, opts, STYLES, type FxHost, type RGB } from './fxLibrary';
import { AuraEmitter } from './auras';
import { WeatherFx } from './weather';
import { ProjectileView, ZoneView, setFxSkyVis } from './views';

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const FAR2 = 180 * 180;

/** Ichor tints for creatures (deterministic per species). */
const ICHOR: RGB[] = [[0.35, 0.01, 0.01], [0.25, 0.32, 0.02], [0.05, 0.12, 0.35], [0.3, 0.2, 0.02], [0.22, 0.03, 0.28]];

export class FxSystem implements ClientModule, EntityViewFactory {
  readonly name = 'fx';
  readonly kinds: EntityKind[] = ['projectile', 'effect'];
  private ctx!: ClientContext;
  lib!: FxLibrary;
  auras!: AuraEmitter;
  weather!: WeatherFx;
  private offs: (() => void)[] = [];
  private editMessages = 0;
  private skyT = 0;
  private time = 0;
  private gravityDecals: { until: number; d: ReturnType<DecalPool['spawn']> }[] = [];

  init(ctx: ClientContext) {
    this.ctx = ctx;
    const add = new ParticlePool(24576, true, 11);
    const alpha = new ParticlePool(32768, false, 10);
    const lights = new FlashLights(ctx.scene, 3);
    const beams = new BeamPool(28);
    const decals = new DecalPool(48);
    const meshes = new MeshFxPool();
    for (const o of [add.mesh, alpha.mesh, beams.group, decals.group, meshes.group]) ctx.scene.add(o);
    const host: FxHost = {
      groundY: (x, y, z) => ctx.terrain.groundBelow(x, y, z, 40),
      normalAt: (x, y, z, out) => {
        const n = ctx.terrain.normal(x, y, z);
        return out.set(n[0], n[1], n[2]);
      },
      objectOf: (id) => ctx.views.get(id)?.object,
      camera: ctx.camera,
    };
    this.lib = new FxLibrary(add, alpha, lights, beams, decals, meshes, host);
    this.auras = new AuraEmitter(this.lib);
    this.weather = new WeatherFx(this.lib, ctx.scene, ctx.gen);
    this.weather.onThunder = (x, y, z, volume) => ctx.audio.play('thunder', [x, y, z], { volume });
    this.offs.push(ctx.events.on('gameEvent', (ev) => this.onEvent(ev)));
    this.offs.push(ctx.events.on('serverMessage', (m) => this.onMessage(m)));
    this.offs.push(ctx.events.on('entityRemoved', ({ id }) => this.auras.forget(id)));
  }

  // ------------------------------------------------------------------ events

  private near(p: ArrayLike<number>): boolean {
    const c = this.ctx.camera.position;
    return (p[0] - c.x) ** 2 + (p[1] - c.y) ** 2 + (p[2] - c.z) ** 2 < FAR2;
  }

  /** Feed one GameEvent (the sandbox calls this directly). */
  onEvent(ev: GameEvent) {
    const lib = this.lib, ctx = this.ctx;
    switch (ev.type) {
      case 'fx':
        if (this.near(ev.pos)) lib.play(ev.fx, ev.pos, ev.dir, ev.radius, ev.color, ev.duration, ev.target);
        break;
      case 'damage': {
        if (!this.near(ev.pos)) break;
        const snap = ctx.state.entities.get(ev.target);
        const src = ev.source !== undefined ? ctx.state.entities.get(ev.source) : undefined;
        let dir: THREE.Vector3 | null = null;
        if (src && ev.source !== ev.target) dir = tmp.set(ev.pos[0] - src.pos[0], 0, ev.pos[2] - src.pos[2]).normalize();
        const creature = snap?.kind === 'creature';
        const ichor = creature && snap?.creature ? ICHOR[snap.creature.species % ICHOR.length] : null;
        lib.damage(ev.pos[0], ev.pos[1], ev.pos[2], ev.amount, ev.dtype, !!ev.crit, dir, creature, ichor);
        break;
      }
      case 'heal':
        if (this.near(ev.pos)) lib.heal(ev.pos[0], ev.pos[1], ev.pos[2], [0.5, 1.6, 0.6], Math.min(1.5, ev.amount / 25));
        break;
      case 'death': {
        const obj = ctx.views.get(ev.target)?.object;
        const snap = ctx.state.entities.get(ev.target);
        const p = obj ? obj.position : snap ? tmp.set(snap.pos[0], snap.pos[1], snap.pos[2]) : null;
        if (p && this.near([p.x, p.y, p.z])) lib.death(p.x, p.y, p.z, snap?.kind === 'creature');
        break;
      }
      case 'impact':
        if (this.near(ev.pos)) lib.impact(ev.pos[0], ev.pos[1], ev.pos[2], ev.normal, ev.material, ev.force);
        break;
      case 'gravity': {
        if (!this.near(ev.pos)) break;
        const life = Math.max(0.5, ev.until - ctx.state.serverTime);
        const strong = Math.abs(ev.factor - 1);
        const col: RGB = ev.factor < 1 ? [0.7, 0.9, 2] : [1.3, 0.6, 2.4];
        const d = lib.decals.spawn(tmp.set(ev.pos[0], ev.pos[1], ev.pos[2]), ev.radius, DecalKind.Vortex, col, life, { alpha: Math.min(0.6, 0.25 + strong * 0.15) });
        this.gravityDecals.push({ until: this.time + life, d });
        lib.shockwave(ev.pos[0], ev.pos[1], ev.pos[2], ev.radius, col, false);
        break;
      }
      case 'knockback': {
        const obj = ctx.views.get(ev.target)?.object;
        if (!obj || !this.near([obj.position.x, obj.position.y, obj.position.z])) break;
        const k = Math.hypot(ev.impulse[0], ev.impulse[2]);
        if (k < 3) break;
        const o = opts();
        o.speed = 1.5; o.spread = 0.3; o.flat = true; o.dx = -ev.impulse[0] / k; o.dy = 0.3; o.dz = -ev.impulse[2] / k; o.focus = 0.5;
        lib.emit(STYLES.dust, obj.position.x, obj.position.y + 0.1, obj.position.z, Math.min(14, Math.round(k)), o);
        break;
      }
    }
  }

  private onMessage(m: ServerMessage) {
    if (m.t !== 'terrainEdits') return;
    // The first message after joining replays every edit in the world: no fx.
    if (this.editMessages++ === 0 && m.edits.length > 8) return;
    if (m.edits.length > 80) return;
    for (const e of m.edits) this.terrainEdit(e);
  }

  /** Dust & debris for one terrain edit (the sandbox calls this too). */
  terrainEdit(e: TerrainEdit) {
    if (!this.near([e.x, e.y, e.z])) return;
    let mat: string;
    if (e.op === 'fill') mat = MATERIALS[e.mat ?? 3]?.name ?? 'dirt';
    else {
      const m = this.ctx.terrain.material(e.x, e.y - e.radius - 0.3, e.z);
      mat = MATERIALS[m]?.name ?? 'stone';
    }
    this.lib.terrainEdit(e.op, e.x, e.y, e.z, e.radius, e.strength, mat);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, time: number) {
    const ctx = this.ctx;
    this.time += dt;
    const cam = ctx.camera.position;
    this.skyT -= dt;
    if (this.skyT <= 0) {
      this.skyT = 0.25;
      const v = estimateSkyVis(cam.y, ctx.gen.heightAt(cam.x, cam.z));
      setFxSkyVis(v);
      this.lib.meshes.setSkyVis(v);
    }
    if (this.gravityDecals.length) {
      for (let i = this.gravityDecals.length - 1; i >= 0; i--) if (this.gravityDecals[i].until <= this.time) this.gravityDecals.splice(i, 1);
    }
    this.auras.update(dt, ctx.state.entities, ctx.views, cam, ctx.state.playerId);
    this.weather.update(dt, cam, ctx.env.weather, time);
    this.lib.update(dt, time, tmp2.copy(cam));
  }

  create(snap: EntitySnapshot): EntityView {
    if (snap.kind === 'projectile') return new ProjectileView(snap, this.lib);
    return new ZoneView(snap, this.lib, () => this.ctx.state.playerId);
  }

  /** Debug numbers for HUDs. */
  stats() {
    return { additive: this.lib.add.spawned, alpha: this.lib.alpha.spawned, weather: this.weather.spawnedLastFrame };
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs.length = 0;
    const l = this.lib;
    for (const o of [l.add.mesh, l.alpha.mesh, l.beams.group, l.decals.group, l.meshes.group]) o.removeFromParent();
    l.add.dispose();
    l.alpha.dispose();
    l.beams.dispose();
    l.decals.dispose();
    l.meshes.dispose();
    l.lights.dispose();
    this.weather.dispose();
  }
}
