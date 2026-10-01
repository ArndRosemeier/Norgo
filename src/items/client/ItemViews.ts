/**
 * Ground item views: procedural item meshes hovering just above the ground
 * with a gentle bob and spin, long items laid flat, a soft contact shadow,
 * and rarity cues — a coloured light beam and ground ring for uncommon+,
 * plus a real point light for epic and better. Placed light sources
 * (torches, lanterns) stand planted upright, flicker and light the world.
 *
 * Also re-exports `buildItemObject` (held weapons, previews, icons).
 */
import * as THREE from 'three';
import type { ClientContext, ClientModule, EntityView, EntityViewFactory } from '../../client/context';
import type { EntitySnapshot } from '../../shared/protocol';
import type { Rarity } from '../types';
import { buildItemObject, animateItem } from './buildItem';
import { setItemSkyVis, disposeItemObject } from './materials';
import { itemDef } from '../data/catalog';
import { RARITY_COLORS } from '../gen/generate';
import { patchSkyOcclusion } from '../../render/skyOcclusion';

export { buildItemObject, attachItemLight, animateItem } from './buildItem';
export { setItemSkyVis, disposeItemObject } from './materials';

// ------------------------------------------------------------------ shared beam / ring resources

let beamGeo: THREE.BufferGeometry | null = null;
let ringGeo: THREE.BufferGeometry | null = null;
let shadowGeo: THREE.BufferGeometry | null = null;
let gradTex: THREE.Texture | null = null;
let radialTex: THREE.Texture | null = null;

function gradientTexture(): THREE.Texture {
  if (gradTex) return gradTex;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 128);
  gradTex = new THREE.CanvasTexture(c);
  return gradTex;
}

function radialTexture(): THREE.Texture {
  if (radialTex) return radialTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  radialTex = new THREE.CanvasTexture(c);
  return radialTex;
}

const RARITY_RANK: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, unique: 5 };

// ------------------------------------------------------------------ view

class GroundItemView implements EntityView {
  readonly object = new THREE.Group();
  readonly headHeight: number;
  readonly radius = 0.4;
  private item: THREE.Object3D;
  private spinner = new THREE.Group();
  private planted: boolean;
  private phase: number;
  private beamMats: THREE.Material[] = [];
  private shadowMat: THREE.MeshBasicMaterial | null = null;
  private hoverY: number;

  constructor(snap: EntitySnapshot) {
    const info = snap.item!;
    const def = itemDef(info.defId);
    this.item = buildItemObject(info.defId, info.visual);
    this.phase = (snap.id * 0.618) % (Math.PI * 2);
    this.planted = !!snap.light && !!def?.light;

    // Normalise pose: centre on the bounding box, lay long things flat.
    const box = new THREE.Box3().setFromObject(this.item);
    const size = box.getSize(new THREE.Vector3());
    const holder = new THREE.Group();
    holder.add(this.item);
    if (this.planted) {
      // Torches/lanterns stand on the ground, grip end down.
      this.item.position.y = -box.min.y + (def?.id === 'torch' ? -0.12 : 0);
      this.hoverY = 0;
    } else {
      const long = size.y > 0.45 && size.y > 1.6 * Math.max(size.x, size.z);
      const centre = box.getCenter(new THREE.Vector3());
      this.item.position.sub(centre);
      if (long) holder.rotation.z = Math.PI / 2;
      // Tiny items get a mild scale-up so they stay readable on the ground.
      const r = Math.max(size.x, size.y, size.z) / 2;
      if (r < 0.1) holder.scale.setScalar(0.1 / Math.max(0.02, r));
      this.hoverY = (long ? Math.max(size.x, size.z) / 2 : size.y / 2) * holder.scale.x + 0.18;
    }
    this.spinner.add(holder);
    this.object.add(this.spinner);
    this.headHeight = this.hoverY + 0.45;

    // Contact shadow blob (soft, cheap).
    shadowGeo ??= new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadowMat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
    const shadow = new THREE.Mesh(shadowGeo, this.shadowMat);
    shadow.scale.setScalar(Math.max(0.35, Math.min(1.2, Math.max(size.x, size.z, size.y * 0.6) * 1.2)));
    shadow.position.y = 0.02;
    shadow.renderOrder = -1;
    if (!this.planted) this.object.add(shadow);

    // Rarity: beam + ring (uncommon+), point light (epic+).
    const rank = RARITY_RANK[info.rarity as Rarity] ?? 0;
    if (rank >= 1 && !this.planted) {
      const col = new THREE.Color().setRGB(...RARITY_COLORS[info.rarity as Rarity], THREE.SRGBColorSpace);
      beamGeo ??= new THREE.CylinderGeometry(0.05, 0.11, 1, 12, 1, true).translate(0, 0.5, 0);
      const beamMat = new THREE.MeshBasicMaterial({ map: gradientTexture(), color: col.clone().multiplyScalar(1.4 + rank * 0.3), transparent: true, opacity: 0.25 + rank * 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.scale.set(1, 0.8 + rank * 0.55, 1);
      beam.renderOrder = 2;
      this.object.add(beam);
      ringGeo ??= new THREE.RingGeometry(0.22, 0.42, 32).rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: col.clone().multiplyScalar(1.2), transparent: true, opacity: 0.4 + rank * 0.08, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.03;
      this.object.add(ring);
      this.beamMats.push(beamMat, ringMat);
      // No per-item point lights: adding lights changes the scene's light count and forces
      // every material to recompile. The beam and ring carry the rarity glow instead.
    }
    // Planted torches/lanterns are lit by the core's pooled LightManager (snapshot.light).
    this.object.position.set(snap.pos[0], snap.pos[1], snap.pos[2]);
  }

  update(s: EntitySnapshot, _dt: number, time: number) {
    this.object.position.set(s.pos[0], s.pos[1], s.pos[2]);
    if (!this.planted) {
      const t = time + this.phase;
      this.spinner.position.y = this.hoverY + Math.sin(t * 1.6) * 0.035;
      this.spinner.rotation.y = t * 0.6;
    }
    animateItem(this.item, time);
  }

  setSkyVis(v: number) {
    setItemSkyVis(this.item, v);
    if (this.shadowMat) this.shadowMat.opacity = 0.35 * v;
  }

  dispose() {
    disposeItemObject(this.item);
    for (const m of this.beamMats) m.dispose();
    this.shadowMat?.dispose();
  }
}

export class ItemViews implements EntityViewFactory, ClientModule {
  readonly name = 'items';
  readonly kinds = ['item' as const];

  create(snap: EntitySnapshot, _ctx: ClientContext): EntityView | null {
    if (!snap.item) return null;
    return new GroundItemView(snap);
  }
}

/** Patch an externally created material for sky occlusion (helper for other item renderers). */
export function patchItemMaterial(m: THREE.Material) {
  return patchSkyOcclusion(m, 'uniform', 1);
}
