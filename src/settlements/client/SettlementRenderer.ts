/**
 * Client settlement renderer: streams settlements and POI structures around
 * the camera with progressive, budgeted construction.
 *
 *  - Far (≤ ~1.6 km): one merged silhouette mesh per settlement (box + roof per
 *    building, lit windows at night) with the cheap far material.
 *  - Mid (≤ ~420 m): per 48 m tile, a merged exterior mesh (structure +
 *    exterior detail) in a single draw call; doors, windmill sails and banners
 *    as separate animated meshes; streets, plaza and fields with crops.
 *  - Near (≤ ~110 m): interiors (furniture, stairs, ceilings) and colliders
 *    (walls & boxes solid, doors Open/Close, furniture Sit/Sleep/Read/Pray).
 *
 * Destruction: ObjectStates for `B:`/`P:` piece ids collapse the piece's
 * vertex ranges in place, remove its colliders and throw debris (recent
 * events only). Doors animate client-side; the server replicates door state
 * as `fx` events (`door_open` / `door_close` at the hinge position).
 * Lights (hearths, lanterns, braziers, crystals) share a small pooled set of
 * point lights assigned to the candidates nearest to the camera.
 */
import * as THREE from 'three';
import type { ClientContext, ClientModule, StaticCollider } from '../../client/context';
import type { ObjectState, GameEvent } from '../../shared/protocol';
import type { Vec3 } from '../../shared/types';
import type { SettlementLayout, PoiLayout } from '../types';
import { SettlementCache, worldFromGenerator, type SettlementWorld, type Unit } from '../cache';
import { silhouetteFor } from '../build/blueprint';
import { Surf, rotXZ, type Blueprint, type Piece } from '../build/kit';
import { STYLES } from '../build/styles';
import { parsePieceId } from '../pieces';
import { createSettlementMaterial, createSettlementFarMaterial, type SettlementMaterialHandle } from './material';
import { MeshBuilder, collapseRange, restoreRange, tintRange, type PieceRange } from './mesher';
import { cropMesh } from './crops';
import { SmokeSystem } from './smoke';
import { smoothstep } from '../../core/math';
import { budgets } from '../../core/budgets';

const TILE = 48;
const NEAR = 110;
const MID = 420;
const FAR = 1650;
const POI_MID = 800;
const LIGHTS = 6;
const BUDGET_MS = 4;

interface Special {
  piece: number;
  root: THREE.Group;
  pivot: THREE.Object3D;
  kind: 'door' | 'spin' | 'sway';
  axis: THREE.Vector3;
  angle: number;
  target: number;
  speed: number;
  hinge: Vec3;
}

interface UnitView {
  unit: Unit;
  bp: Blueprint;
  /** Exterior / interior ranges per piece (in the tile meshes). */
  ext: (PieceRange | null)[];
  int: (PieceRange | null)[];
  specials: Map<number, Special>;
}

interface Tile {
  key: string;
  cx: number;
  cz: number;
  ox: number;
  oy: number;
  oz: number;
  r: number;
  units: Unit[];
  level: number;
  /** Built geometry level (0 none, 1 exterior, 2 + interior). */
  built: number;
  group: THREE.Group | null;
  ext: THREE.Mesh | null;
  int: THREE.Mesh | null;
  views: Map<string, UnitView>;
  colliders: boolean;
  lights: { x: number; y: number; z: number; color: THREE.Color; intensity: number; radius: number; night: boolean; flicker: number; piece: string }[];
  smoke: { key: string; x: number; y: number; z: number; piece: string }[];
}

interface Place {
  id: string;
  kind: 'site' | 'poi';
  cx: number;
  cy: number;
  cz: number;
  extent: number;
  layout: SettlementLayout | null;
  poi: PoiLayout | null;
  tiles: Map<string, Tile>;
  far: THREE.Mesh | null;
  farRanges: Map<string, PieceRange>;
  farOrig: Float32Array | null;
  farWanted: boolean;
  ground: THREE.Group | null;
  groundWanted: boolean;
  lastSeen: number;
}

export class SettlementRenderer implements ClientModule {
  readonly name = 'settlements';
  private ctx!: ClientContext;
  private world!: SettlementWorld;
  cache!: SettlementCache;
  readonly root = new THREE.Group();
  private near!: SettlementMaterialHandle;
  private far!: SettlementMaterialHandle;
  private places = new Map<string, Place>();
  private lights: THREE.PointLight[] = [];
  private smoke = new SmokeSystem();
  private mb = new MeshBuilder();
  private scanT = 0;
  private lightT = 0;
  private time = 0;
  /** Desired tile work, refreshed on scan. */
  private queue: { place: Place; tile: Tile | null; d: number; job: 'tile' | 'far' | 'ground' }[] = [];
  /** Piece id → unit view lookup for loaded tiles. */
  private loaded = new Map<string, { tile: Tile; view: UnitView; place: Place }>();
  /** Night factor 0..1 (exposed for sandboxes). */
  night = 0;
  stats = { places: 0, tiles: 0, triangles: 0, colliders: 0 };

  constructor(opts: { world?: SettlementWorld } = {}) {
    if (opts.world) this.world = opts.world;
  }

  init(ctx: ClientContext) {
    this.ctx = ctx;
    if (!this.world) this.world = worldFromGenerator(ctx.gen);
    this.cache = new SettlementCache(this.world);
    this.cache.max = budgets.settlementLayouts;
    this.near = createSettlementMaterial();
    this.far = createSettlementFarMaterial();
    this.root.name = 'settlements';
    ctx.scene.add(this.root);
    this.root.add(this.smoke.points);
    for (let i = 0; i < LIGHTS; i++) {
      // Always visible (intensity 0 when idle): toggling visibility changes the scene's
      // light count, which forces every material to recompile its shader.
      const l = new THREE.PointLight(0xffaa66, 0, 10, 1.7);
      this.lights.push(l);
      this.root.add(l);
    }
    ctx.events.on('objects', (states) => this.onObjects(states));
    ctx.events.on('gameEvent', (ev) => this.onGameEvent(ev));
    ctx.events.on('uiOpen', (e) => {
      if (e.panel !== 'interactObject') return;
      const c = e.data as StaticCollider | undefined;
      if (c?.objectId !== undefined) this.toggleDoor(String(c.objectId), null);
    });
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, time = 0) {
    if (!this.ctx) return;
    this.time += dt;
    const cam = this.ctx.camera.position;
    const sunY = this.ctx.env?.sunDir?.y ?? 1;
    this.night = 1 - smoothstep(-0.1, 0.12, sunY);
    this.near.uniforms.uNight.value = this.far.uniforms.uNight.value = this.night;
    this.near.uniforms.uTime.value = this.far.uniforms.uTime.value = time || this.time;

    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.35;
      this.scan(cam.x, cam.z);
    }
    // Progressive construction within a time budget.
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < BUDGET_MS) {
      const job = this.queue.shift()!;
      if (job.job === 'far') this.buildFar(job.place);
      else if (job.job === 'ground') this.buildGround(job.place);
      else if (job.tile) this.buildTile(job.place, job.tile);
    }
    this.animate(dt);
    this.lightT -= dt;
    if (this.lightT <= 0) {
      this.lightT = 0.25;
      this.assignLights(cam);
    }
    this.flickerLights();
    this.updateSmoke(dt, cam);
  }

  // ---------------------------------------------------------------- streaming

  private scan(x: number, z: number) {
    const seen = new Set<string>();
    // New places cost a layout (up to ~80 ms for a city): create the nearest few per scan only.
    const t0 = performance.now();
    const sites = this.world.sitesNear(x, z, FAR).map((s) => ({ s, d: Math.hypot(s.x - x, s.z - z) })).sort((a, b) => a.d - b.d);
    for (const { s, d } of sites) {
      if (d > FAR + s.radius * 2) continue;
      let p = this.places.get(s.id);
      if (!p) {
        if (performance.now() - t0 > 6 && this.places.size) continue;
        const l = this.cache.layout(s);
        p = this.makePlace(s.id, 'site', l.center, l.extent ?? s.radius * 2, l, null);
      }
      seen.add(s.id);
      p.lastSeen = this.time;
    }
    for (const poi of this.world.poisNear(x, z, POI_MID + 50)) {
      let p = this.places.get(poi.id);
      if (!p) {
        if (performance.now() - t0 > 8) continue;
        const l = this.cache.poi(poi);
        p = this.makePlace(poi.id, 'poi', l.center, l.extent, null, l);
      }
      seen.add(poi.id);
      p.lastSeen = this.time;
    }
    // Dispose places out of range.
    for (const [id, p] of this.places) if (!seen.has(id)) this.disposePlace(p);

    // Desired levels per tile & build queue.
    this.queue.length = 0;
    let tiles = 0;
    for (const p of this.places.values()) {
      const dc = Math.hypot(p.cx - x, p.cz - z);
      p.farWanted = p.kind === 'site' && dc < FAR + p.extent;
      if (p.farWanted && !p.far) this.queue.push({ place: p, tile: null, d: dc + 200, job: 'far' });
      if (!p.farWanted && p.far) this.disposeFar(p);
      p.groundWanted = p.kind === 'site' && dc < MID + p.extent;
      if (p.groundWanted && !p.ground) this.queue.push({ place: p, tile: null, d: Math.max(0, dc - p.extent), job: 'ground' });
      if (!p.groundWanted && p.ground) this.disposeGround(p);
      const mid = p.kind === 'poi' ? POI_MID : MID;
      for (const t of p.tiles.values()) {
        const d = Math.max(0, Math.hypot(t.cx - x, t.cz - z) - t.r);
        // Hysteresis: keep the current level a bit longer.
        const hyst = t.built ? 25 : 0;
        t.level = d < NEAR + hyst ? 2 : d < mid + hyst ? 1 : 0;
        if (t.level !== t.built || (t.level >= 1 && !t.colliders)) {
          if (t.level === 0) this.disposeTile(p, t);
          else this.queue.push({ place: p, tile: t, d, job: 'tile' });
        }
        if (t.built) tiles++;
      }
    }
    this.queue.sort((a, b) => a.d - b.d);
    this.stats.places = this.places.size;
    this.stats.tiles = tiles;
  }

  private makePlace(id: string, kind: Place['kind'], c: Vec3, extent: number, layout: SettlementLayout | null, poi: PoiLayout | null): Place {
    const p: Place = {
      id, kind, cx: c[0], cy: c[1], cz: c[2], extent, layout, poi, tiles: new Map(), far: null, farRanges: new Map(), farOrig: null,
      farWanted: false, ground: null, groundWanted: false, lastSeen: this.time,
    };
    const units = this.cache.unitsOf(id);
    if (units) {
      for (const u of units.values()) {
        const tx = Math.floor(u.pos[0] / TILE), tz = Math.floor(u.pos[2] / TILE);
        const key = `${tx},${tz}`;
        let t = p.tiles.get(key);
        if (!t) {
          t = {
            key, cx: (tx + 0.5) * TILE, cz: (tz + 0.5) * TILE, ox: (tx + 0.5) * TILE, oy: u.pos[1], oz: (tz + 0.5) * TILE, r: TILE * 0.71,
            units: [], level: 0, built: 0, group: null, ext: null, int: null, views: new Map(), colliders: false, lights: [], smoke: [],
          };
          p.tiles.set(key, t);
        }
        t.units.push(u);
        // Long buildings (bridges, wall runs) widen the tile's reach.
        if (u.building) t.r = Math.max(t.r, Math.hypot(u.pos[0] - t.cx, u.pos[2] - t.cz) + Math.hypot(u.building.size[0], u.building.size[1]) / 2);
      }
    }
    this.places.set(id, p);
    return p;
  }

  // ---------------------------------------------------------------- tiles

  private stateOf(id: string): ObjectState | undefined {
    return this.ctx.state?.objects?.get(id);
  }

  private buildTile(place: Place, t: Tile) {
    const want = t.level;
    if (want === 0) return;
    if (!t.group) {
      t.group = new THREE.Group();
      t.group.position.set(t.ox, t.oy, t.oz);
      t.group.matrixAutoUpdate = false;
      t.group.updateMatrix();
      this.root.add(t.group);
    }
    // Exterior.
    if (t.built === 0) {
      const mb = this.mb;
      mb.reset();
      for (const u of t.units) {
        const bp = u.blueprint();
        const view: UnitView = { unit: u, bp, ext: [], int: [], specials: new Map() };
        t.views.set(u.id, view);
        mb.setFrame(u.pos[0] - t.ox, u.pos[1] - t.oy, u.pos[2] - t.oz, u.yaw, bp.interior);
        bp.pieces.forEach((pc, i) => {
          const pid = `${u.id}:${i}`;
          const st = this.stateOf(pid);
          if (st?.state === 'destroyed') {
            view.ext.push(null);
            return;
          }
          this.loaded.set(pid, { tile: t, view, place });
          if (pc.door || pc.spin || pc.sway) {
            view.ext.push(null);
            this.makeSpecial(t, view, pc, i);
            return;
          }
          view.ext.push(mb.addPiece(pc, 0, 1));
        });
        // Lights & smoke anchors (world).
        bp.pieces.forEach((pc, i) => {
          const pid = `${u.id}:${i}`;
          for (const l of pc.lights) {
            const [wx, wz] = rotXZ(l.x, l.z, u.yaw);
            t.lights.push({ x: u.pos[0] + wx, y: u.pos[1] + l.y, z: u.pos[2] + wz, color: new THREE.Color(l.color), intensity: l.intensity, radius: l.radius, night: l.night, flicker: l.flicker, piece: pid });
          }
          for (const s of pc.smoke) {
            const [wx, wz] = rotXZ(s[0], s[2], u.yaw);
            t.smoke.push({ key: pid + s[1], x: u.pos[0] + wx, y: u.pos[1] + s[1], z: u.pos[2] + wz, piece: pid });
          }
        });
      }
      const g = mb.build();
      if (g) {
        t.ext = new THREE.Mesh(g, this.near.material);
        t.ext.castShadow = true;
        t.ext.receiveShadow = true;
        t.ext.matrixAutoUpdate = false;
        t.group.add(t.ext);
        this.stats.triangles += g.index!.count / 3;
      }
      t.built = 1;
      // Damaged tint for already-damaged pieces.
      for (const v of t.views.values())
        v.ext.forEach((r, i) => {
          if (r && this.stateOf(`${v.unit.id}:${i}`)?.state === 'damaged' && t.ext) tintRange(t.ext.geometry, r, 0.72);
        });
      this.setFarHidden(place, t, true);
    }
    // Interior.
    if (want === 2 && t.built === 1) {
      const mb = this.mb;
      mb.reset();
      for (const v of t.views.values()) {
        const u = v.unit;
        mb.setFrame(u.pos[0] - t.ox, u.pos[1] - t.oy, u.pos[2] - t.oz, u.yaw, v.bp.interior);
        v.int = v.bp.pieces.map((pc, i) => (this.stateOf(`${u.id}:${i}`)?.state === 'destroyed' || pc.door || pc.spin || pc.sway ? null : mb.addPiece(pc, 2, 2)));
      }
      const g = mb.build();
      if (g) {
        t.int = new THREE.Mesh(g, this.near.material);
        t.int.receiveShadow = true;
        t.int.castShadow = true;
        t.int.matrixAutoUpdate = false;
        t.group.add(t.int);
      }
      t.built = 2;
    } else if (want === 1 && t.built === 2) {
      if (t.int) {
        t.group.remove(t.int);
        t.int.geometry.dispose();
        t.int = null;
      }
      t.built = 1;
    }
    // Colliders: registered as soon as the exterior exists (mid range), not only with the
    // interior mesh at near range — otherwise a player arriving before the near build
    // (teleport, busy build queue) fell through floors onto the terrain beneath.
    if (want >= 1 && !t.colliders) this.addColliders(t);
    else if (want < 1 && t.colliders) this.removeColliders(t);
  }

  private makeSpecial(t: Tile, v: UnitView, pc: Piece, i: number) {
    const u = v.unit;
    const mb = new MeshBuilder();
    let pivotL: [number, number, number];
    let kind: Special['kind'];
    const axis = new THREE.Vector3(0, 1, 0);
    let speed = 0;
    if (pc.door) {
      kind = 'door';
      pivotL = [pc.door.x, 0, pc.door.z];
    } else if (pc.spin) {
      kind = 'spin';
      pivotL = [pc.spin.x, pc.spin.y, pc.spin.z];
      axis.set(Math.sin(pc.spin.yaw + u.yaw), 0, Math.cos(pc.spin.yaw + u.yaw));
      speed = pc.spin.speed;
    } else {
      kind = 'sway';
      pivotL = [pc.sway!.x, pc.sway!.y, pc.sway!.z];
      axis.set(Math.cos(u.yaw), 0, -Math.sin(u.yaw));
    }
    const [px, pz] = rotXZ(pivotL[0], pivotL[2], u.yaw);
    const hinge: Vec3 = [u.pos[0] + px, u.pos[1] + pivotL[1], u.pos[2] + pz];
    mb.setFrame(u.pos[0] - hinge[0], u.pos[1] - hinge[1], u.pos[2] - hinge[2], u.yaw, v.bp.interior);
    mb.addPiece(pc, 0, 2);
    const g = mb.build();
    if (!g) return;
    const mesh = new THREE.Mesh(g, this.near.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const root = new THREE.Group();
    root.position.set(hinge[0] - t.ox, hinge[1] - t.oy, hinge[2] - t.oz);
    const pivot = new THREE.Group();
    pivot.add(mesh);
    root.add(pivot);
    t.group!.add(root);
    v.specials.set(i, { piece: i, root, pivot, kind, axis, angle: 0, target: 0, speed, hinge });
  }

  private addColliders(t: Tile) {
    let n = 0;
    for (const v of t.views.values()) {
      const u = v.unit;
      v.bp.pieces.forEach((pc, i) => {
        const pid = `${u.id}:${i}`;
        if (this.stateOf(pid)?.state === 'destroyed') return;
        n += this.addPieceColliders(t, u, pc, pid, v.specials.get(i));
      });
    }
    t.colliders = true;
    this.stats.colliders += n;
  }

  private addPieceColliders(t: Tile, u: Unit, pc: Piece, pid: string, sp?: Special): number {
    const open = sp?.kind === 'door' && sp.target > 0.5;
    pc.cols.forEach((c, j) => {
      const [wx, wz] = rotXZ(c.x, c.z, u.yaw);
      this.ctx.colliders.add({
        id: `${pid}#${j}`,
        owner: `settlement:${t.key}:${u.owner}`,
        shape: 'box',
        pos: [u.pos[0] + wx, u.pos[1] + c.y, u.pos[2] + wz],
        half: [c.hx, c.hy, c.hz],
        yaw: c.yaw + u.yaw,
        objectId: pid,
        interact: pc.door ? (open ? 'Close' : 'Open') : pc.interact,
        material: pc.mat,
        solid: c.solid && !open,
      });
    });
    return pc.cols.length;
  }

  private removeColliders(t: Tile) {
    const owners = new Set<string>();
    for (const v of t.views.values()) owners.add(`settlement:${t.key}:${v.unit.owner}`);
    for (const o of owners) this.ctx.colliders.removeOwner(o);
    t.colliders = false;
  }

  private disposeTile(place: Place, t: Tile) {
    if (t.colliders) this.removeColliders(t);
    if (t.group) {
      t.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          this.stats.triangles -= m === t.ext && m.geometry.index ? m.geometry.index.count / 3 : 0;
          m.geometry.dispose();
        }
      });
      this.root.remove(t.group);
    }
    for (const v of t.views.values()) v.bp.pieces.forEach((_, i) => this.loaded.delete(`${v.unit.id}:${i}`));
    t.group = null;
    t.ext = t.int = null;
    t.views.clear();
    t.lights.length = 0;
    t.smoke.length = 0;
    if (t.built) this.setFarHidden(place, t, false);
    t.built = 0;
  }

  // ---------------------------------------------------------------- far silhouettes

  private buildFar(p: Place) {
    if (p.far || !p.layout) return;
    const mb = this.mb;
    mb.reset();
    const her = p.layout.heraldry;
    for (const b of p.layout.buildings) {
      const bp = silhouetteFor(b, her);
      mb.setFrame(b.pos[0] - p.cx, b.pos[1] - p.cy, b.pos[2] - p.cz, b.yaw, null);
      const start = mb.nv;
      for (const pc of bp.pieces) mb.addPiece(pc, 0, 2);
      p.farRanges.set(b.id, { start, count: mb.nv - start });
    }
    const g = mb.build();
    if (!g) return;
    p.farOrig = (g.getAttribute('position').array as Float32Array).slice();
    p.far = new THREE.Mesh(g, this.far.material);
    p.far.position.set(p.cx, p.cy, p.cz);
    p.far.matrixAutoUpdate = false;
    p.far.updateMatrix();
    p.far.receiveShadow = true;
    this.root.add(p.far);
    // Hide silhouettes of buildings already shown in detail or mostly destroyed.
    for (const t of p.tiles.values()) if (t.built) this.setFarHidden(p, t, true);
  }

  private setFarHidden(p: Place, t: Tile, hidden: boolean) {
    if (!p.far || !p.farOrig) return;
    for (const u of t.units) {
      const r = p.farRanges.get(u.id);
      if (!r) continue;
      if (hidden) collapseRange(p.far.geometry, r);
      else restoreRange(p.far.geometry, r, p.farOrig);
    }
  }

  private disposeFar(p: Place) {
    if (!p.far) return;
    this.root.remove(p.far);
    p.far.geometry.dispose();
    p.far = null;
    p.farOrig = null;
    p.farRanges.clear();
  }

  // ---------------------------------------------------------------- streets, plaza, fields

  private buildGround(p: Place) {
    if (p.ground || !p.layout) return;
    const l = p.layout;
    const H = (x: number, z: number) => this.world.terrain.heightAt(x, z);
    const mb = this.mb;
    mb.reset();
    const st = STYLES[l.style ?? 'timber'];
    const paved = st.id === 'timber' || st.id === 'stonekeep' || st.id === 'elven' || st.id === 'drakeborn' || st.id === 'umbral';
    const big = l.buildings.length > 40;
    const streetSurf = paved || big ? Surf.Cobble : Surf.Soil;
    const streetCol = st.id === 'elven' ? 0xc8c4b8 : st.id === 'drakeborn' || st.id === 'umbral' ? 0x4a4448 : paved ? 0x8a847a : 0x8a7458;
    l.streets.forEach((s, i) => {
      const kind = l.streetKinds?.[i] ?? 'side';
      const surf = kind === 'main' || kind === 'ring' ? streetSurf : paved && big ? Surf.Cobble : Surf.Soil;
      mb.ribbon(s.points.map((q) => [q[0], q[2]] as [number, number]), s.width, surf, surf === Surf.Soil ? 0x7a6650 : streetCol, H, p.cx, p.cy, p.cz, kind === 'main' ? 0.08 : 0.1);
    });
    mb.patch(l.plaza[0], l.plaza[2], 0, (l.plazaRadius ?? 10) * 2, 0, paved || big ? Surf.Cobble : Surf.Soil, paved ? streetCol : 0x7a6650, H, p.cx, p.cy, p.cz, true, 0.12);
    for (const f of l.fields ?? []) mb.patch(f.pos[0], f.pos[2], f.yaw, f.w, f.d, Surf.Soil, f.crop === 'fallow' ? 0x6a7a40 : 0x6a5038, H, p.cx, p.cy, p.cz, false, 0.05);
    const g = mb.build();
    const group = new THREE.Group();
    group.position.set(p.cx, p.cy, p.cz);
    if (g) {
      const m = new THREE.Mesh(g, this.near.material);
      m.receiveShadow = true;
      // Ribbons are lifted a few cm above the analytic terrain height (see mesher.ribbon).
      m.renderOrder = 1;
      group.add(m);
    }
    for (const f of l.fields ?? []) {
      const cm = cropMesh(f, this.near.material, H, p.cx, p.cy, p.cz);
      if (cm) {
        cm.castShadow = true;
        cm.receiveShadow = true;
        group.add(cm);
      }
    }
    this.root.add(group);
    p.ground = group;
  }

  private disposeGround(p: Place) {
    if (!p.ground) return;
    p.ground.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.root.remove(p.ground);
    p.ground = null;
  }

  private disposePlace(p: Place) {
    for (const t of p.tiles.values()) this.disposeTile(p, t);
    this.disposeFar(p);
    this.disposeGround(p);
    this.places.delete(p.id);
  }

  // ---------------------------------------------------------------- destruction

  private onObjects(states: ObjectState[]) {
    const now = this.ctx.state?.serverTime ?? 0;
    for (const s of states) {
      if (typeof s.id !== 'string' || !(s.id.startsWith('B:') || s.id.startsWith('P:'))) continue;
      const hit = this.loaded.get(s.id);
      if (!hit) continue;
      const ref = parsePieceId(s.id);
      if (!ref) continue;
      const { tile, view } = hit;
      const i = ref.piece;
      if (s.state === 'damaged') {
        const r = view.ext[i];
        if (r && tile.ext) tintRange(tile.ext.geometry, r, 0.72);
        continue;
      }
      // Destroyed / felled.
      const recent = Math.abs(now - s.t) < 6;
      if (recent) this.spawnDebris(view, i, s.dir);
      const r = view.ext[i];
      if (r && tile.ext) collapseRange(tile.ext.geometry, r);
      const ri = view.int[i];
      if (ri && tile.int) collapseRange(tile.int.geometry, ri);
      view.ext[i] = null;
      view.int[i] = null;
      const sp = view.specials.get(i);
      if (sp) {
        sp.root.removeFromParent();
        sp.root.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
        view.specials.delete(i);
      }
      view.bp.pieces[i].cols.forEach((_, j) => this.ctx.colliders.remove(`${s.id}#${j}`));
      tile.lights = tile.lights.filter((l) => l.piece !== s.id);
      tile.smoke = tile.smoke.filter((l) => l.piece !== s.id);
      this.loaded.delete(s.id);
    }
  }

  private spawnDebris(view: UnitView, i: number, dir?: Vec3) {
    const pc = view.bp.pieces[i];
    const u = view.unit;
    const [cx, cz] = rotXZ(pc.cx, pc.cz, u.yaw);
    const c: Vec3 = [u.pos[0] + cx, u.pos[1] + pc.cy, u.pos[2] + cz];
    const mb = new MeshBuilder();
    mb.setFrame(u.pos[0] - c[0], u.pos[1] - c[1], u.pos[2] - c[2], u.yaw, null);
    mb.addPiece(pc, 0, 2);
    const g = mb.build();
    if (!g) return;
    const mesh = new THREE.Mesh(g, this.near.material);
    mesh.position.set(c[0], c[1], c[2]);
    mesh.castShadow = true;
    const origin: Vec3 = dir ? [c[0] - dir[0], c[1] - dir[1], c[2] - dir[2]] : [c[0], c[1] + pc.r * 0.5, c[2]];
    const pieces = Math.max(3, Math.min(14, Math.round(pc.r * 4)));
    this.ctx.debris.shatter(mesh, origin, 2 + Math.min(4, pc.r), pieces, 9);
    this.ctx.audio?.play(pc.mat === 'wood' ? 'wood_break' : pc.mat === 'crystal' ? 'glass_break' : 'stone_break', c, { volume: Math.min(1, 0.4 + pc.r * 0.2) });
  }

  // ---------------------------------------------------------------- doors

  private onGameEvent(ev: GameEvent) {
    if (ev.type !== 'fx' || (ev.fx !== 'door_open' && ev.fx !== 'door_close')) return;
    // Find the door whose hinge matches.
    for (const [, hit] of this.loaded) {
      for (const sp of hit.view.specials.values()) {
        if (sp.kind !== 'door') continue;
        if (Math.abs(sp.hinge[0] - ev.pos[0]) < 0.3 && Math.abs(sp.hinge[2] - ev.pos[2]) < 0.3 && Math.abs(sp.hinge[1] - ev.pos[1]) < 1) {
          this.setDoor(hit.tile, hit.view, sp, ev.fx === 'door_open');
          return;
        }
      }
    }
  }

  /** Toggle (open = null) or set a door's state client-side. */
  private toggleDoor(pid: string, open: boolean | null) {
    const hit = this.loaded.get(pid);
    if (!hit) return;
    const ref = parsePieceId(pid);
    const sp = ref ? hit.view.specials.get(ref.piece) : undefined;
    if (!sp || sp.kind !== 'door') return;
    this.setDoor(hit.tile, hit.view, sp, open ?? sp.target < 0.5);
  }

  private setDoor(t: Tile, v: UnitView, sp: Special, open: boolean) {
    const target = open ? 1 : 0;
    if (sp.target === target) return;
    sp.target = target;
    const pc = v.bp.pieces[sp.piece];
    if (t.colliders) this.addPieceColliders(t, v.unit, pc, `${v.unit.id}:${sp.piece}`, sp);
  }

  private animate(dt: number) {
    const wind = this.ctx.env?.wind;
    const q = new THREE.Quaternion();
    for (const p of this.places.values())
      for (const t of p.tiles.values()) {
        if (!t.built) continue;
        for (const v of t.views.values())
          for (const sp of v.specials.values()) {
            if (sp.kind === 'door') {
              if (Math.abs(sp.angle - sp.target) < 1e-3) continue;
              sp.angle += Math.sign(sp.target - sp.angle) * Math.min(Math.abs(sp.target - sp.angle), dt * 2.2);
              const pc = v.bp.pieces[sp.piece];
              const e = sp.angle * sp.angle * (3 - 2 * sp.angle);
              q.setFromAxisAngle(sp.axis, e * (pc.door?.swing ?? 1.6));
              sp.pivot.quaternion.copy(q);
            } else if (sp.kind === 'spin') {
              const w = wind ? 0.5 + wind.strength * 1.5 : 1;
              sp.angle += dt * sp.speed * w;
              sp.pivot.quaternion.setFromAxisAngle(sp.axis, sp.angle);
            } else {
              const s = wind ? wind.strength : 0.3;
              sp.angle = Math.sin(this.time * 1.7 + sp.hinge[0] * 0.3) * 0.08 * (0.4 + s);
              sp.pivot.quaternion.setFromAxisAngle(sp.axis, sp.angle);
            }
          }
      }
  }

  // ---------------------------------------------------------------- lights & smoke

  private assignLights(cam: THREE.Vector3) {
    const cands: { d: number; l: Tile['lights'][number] }[] = [];
    for (const p of this.places.values())
      for (const t of p.tiles.values()) {
        if (t.built < 1 || Math.hypot(t.cx - cam.x, t.cz - cam.z) > 120) continue;
        for (const l of t.lights) {
          if (l.night && this.night < 0.3) continue;
          const d = (l.x - cam.x) ** 2 + (l.y - cam.y) ** 2 + (l.z - cam.z) ** 2;
          if (d < 90 * 90) cands.push({ d: d / (l.intensity * l.radius), l });
        }
      }
    cands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < LIGHTS; i++) {
      const L = this.lights[i];
      const c = cands[i];
      if (!c) {
        L.intensity = 0;
        L.userData.src = null;
        continue;
      }
      L.position.set(c.l.x, c.l.y, c.l.z);
      L.color.copy(c.l.color);
      L.distance = c.l.radius;
      L.userData.src = c.l;
    }
  }

  private flickerLights() {
    for (let i = 0; i < LIGHTS; i++) {
      const L = this.lights[i];
      const l = L.userData.src as Tile['lights'][number] | null;
      if (!l) continue;
      const f = 1 - l.flicker * 0.18 * (0.5 + 0.5 * Math.sin(this.time * 11 + i * 2.1) * Math.sin(this.time * 6.3 + i));
      const gate = l.night ? smoothstep(0.3, 0.6, this.night) : 1;
      L.intensity = l.intensity * f * gate;
    }
  }

  private updateSmoke(dt: number, cam: THREE.Vector3) {
    const anchors: { key: string; x: number; y: number; z: number; rate: number }[] = [];
    for (const p of this.places.values())
      for (const t of p.tiles.values()) {
        if (t.built < 1) continue;
        if (Math.hypot(t.cx - cam.x, t.cz - cam.z) > 260) continue;
        for (const s of t.smoke) anchors.push({ ...s, rate: 1.4 });
      }
    const w = this.ctx.env?.wind;
    this.smoke.update(dt, anchors.slice(0, 80), { x: (w?.dir.x ?? 1) * (w?.strength ?? 0.3), z: (w?.dir.y ?? 0) * (w?.strength ?? 0.3) }, 1 - this.night * 0.85);
  }

  dispose() {
    for (const p of [...this.places.values()]) this.disposePlace(p);
    this.smoke.dispose();
    this.root.removeFromParent();
  }
}
