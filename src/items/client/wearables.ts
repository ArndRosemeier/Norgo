/**
 * Wearable resolver: maps a worn item (def + rolled visual) to a WearableSpec
 * for the humanoid renderer.
 *
 *  - Soft garments → ShellLayers: body regions (with proximal→distal cuts for
 *    sleeves, trouser legs, boot shafts, glove fingers), push-out offset and
 *    draw layer by garment class, ShellMaterial pattern/colors from the shared
 *    garment look (../client/wear/look.ts), skirts for robes, coats, tunics,
 *    kilts and mail skirts, hoods, trims.
 *  - Hard parts → RigidParts built in socket space (convention documented in
 *    ./wear/fit.ts) and fitted to the body's BodyFit. Each build() returns a
 *    fresh object whose materials are sky-occlusion patched; use
 *    `setItemSkyVis(obj, v)` from ./materials on it.
 *
 * Layer order (inner → outer): 1 shirts/underclothes, 2 tunics/trousers,
 * 3 padded/robes/doublets, 4 mail/leather, 5 scale/lamellar/brigandine,
 * 6 plate, 7 coats, 8 cloaks/hoods.
 */
import * as THREE from 'three';
import type { WearableResolver, WearableSpec, ShellLayer, ShellMaterial, RigidPart, BodyRegion, Socket, BodyFit } from '../wearable';
import type { ItemVisual } from '../types';
import { itemDef } from '../data/catalog';
import { ItemMatKit, attachSky } from './materials';
import { Rng } from '../../core/rng';
import { lookFor, type Look } from './wear/look';
import { mirrorX } from './wear/fit';
import {
  buildHeadwear, buildMask, buildNeckPiece, buildPauldron, buildBracer, buildKnucklePlate, buildRing, buildBelt, buildTasset, buildGreave, buildKneeCop,
  buildBootCuff, buildSabaton, buildSandal, buildBoneRibs, type PartCtx,
} from './wear/rigid';

type Reg = ShellLayer['regions'][number];
type RGB = [number, number, number];

// ------------------------------------------------------------------ region helpers

const TORSO: Reg[] = [{ region: 'chest' }, { region: 'belly' }, { region: 'back' }];
const HIPS: Reg[] = [{ region: 'pelvis' }, { region: 'buttocks' }];

function pair(base: 'upperarm' | 'forearm' | 'thigh' | 'shin' | 'hand' | 'foot', from = 0, to = 1): Reg[] {
  if (to <= from) return [];
  const r = (side: 'L' | 'R') => ({ region: `${base}.${side}` as BodyRegion, ...(from > 0 ? { from } : {}), ...(to < 1 ? { to } : {}) });
  return [r('L'), r('R')];
}

/** Arms: upper arm to `up` (0..1) and forearm to `fore` (0..1, only if the upper arm is fully covered). */
function arms(up: number, fore = 0): Reg[] {
  return [...pair('upperarm', 0, up), ...(up >= 1 ? pair('forearm', 0, fore) : [])];
}

function legs(thigh: number, shin = 0): Reg[] {
  return [...pair('thigh', 0, thigh), ...(thigh >= 1 ? pair('shin', 0, shin) : [])];
}

// ------------------------------------------------------------------ materials

function shellMat(look: Look, v: ItemVisual, over: Partial<ShellMaterial> = {}): ShellMaterial {
  return {
    color: look.color,
    color2: look.color2,
    pattern: look.shellPattern,
    patternScale: look.patternScale,
    roughness: look.roughness,
    metalness: look.metalness,
    sheen: look.sheen,
    glow: v.glow,
    glowColor: v.glowColor,
    wear: v.wear,
    ...over,
  };
}

/** Quilted padding seen under mail / scale / plate. */
function paddedMat(v: ItemVisual): ShellMaterial {
  return {
    color: [0.64, 0.58, 0.46], color2: [0.38, 0.33, 0.26], pattern: 'quilted', patternScale: 10, roughness: 0.92, metalness: 0, sheen: 0.3,
    glow: 0, glowColor: [0, 0, 0], wear: v.wear,
  };
}

function mailMat(v: ItemVisual, color: RGB = [0.55, 0.56, 0.58]): ShellMaterial {
  return { color, color2: [0.3, 0.3, 0.32], pattern: 'chainmail', patternScale: 40, roughness: 0.4, metalness: 0.85, sheen: 0, glow: 0, glowColor: [0, 0, 0], wear: v.wear };
}

function shell(regions: Reg[], offset: number, layer: number, material: ShellMaterial, extra: Partial<ShellLayer> = {}): ShellLayer {
  return { kind: 'shell', regions, offset, layer, material, ...extra };
}

// ------------------------------------------------------------------ rigid parts

type Builder = (c: PartCtx) => THREE.Object3D | null;

function rigid(defId: string, v: ItemVisual, socket: Socket, build: Builder, mirror = false): RigidPart {
  return {
    kind: 'rigid',
    socket,
    build(fit: BodyFit) {
      const kit = new ItemMatKit(v);
      const c: PartCtx = { kit, look: lookFor(defId, v), fit, rng: new Rng((v.seed >>> 0) || 1) };
      const obj = build(c) ?? new THREE.Group();
      const root = new THREE.Group();
      root.name = `wear:${defId}:${socket}`;
      root.add(mirror ? mirrorX(obj) : obj);
      attachSky(root, kit);
      return root;
    },
  };
}

/** Left + mirrored right parts on paired sockets. */
function rigidPair(defId: string, v: ItemVisual, base: 'shoulder' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'foot', build: Builder): RigidPart[] {
  return [rigid(defId, v, `${base}.L` as Socket, build), rigid(defId, v, `${base}.R` as Socket, build, true)];
}

// ------------------------------------------------------------------ resolver

const HELM_HIDES: Record<string, { hair: boolean; beard: boolean }> = {
  'cap.leather': { hair: true, beard: false },
  'helm.nasal': { hair: true, beard: false },
  'helm.horned': { hair: true, beard: false },
  'helm.kettle': { hair: true, beard: false },
  'helm.barbute': { hair: true, beard: true },
  'helm.great': { hair: true, beard: true },
  'helm.skull': { hair: true, beard: false },
  'hat.straw': { hair: false, beard: false },
  'hat.wide': { hair: true, beard: false },
  'hat.pointed': { hair: true, beard: false },
  circlet: { hair: false, beard: false },
  crown: { hair: false, beard: false },
};

export const resolveWearable: WearableResolver = (defId: string, visual: ItemVisual): WearableSpec | null => {
  const def = itemDef(defId);
  if (!def) return null;
  const slot = def.slots[0];
  if (!slot || slot === 'mainhand' || slot === 'offhand' || slot === 'trinket') return null;
  const v = visual;
  const shape = v.shape || def.visual.shape;
  const look = lookFor(defId, v);
  const mat = shellMat(look, v);
  const trim = { width: 0.012, color: look.metallic ? look.accent : look.accent };
  const L: (ShellLayer | RigidPart)[] = [];
  const spec: WearableSpec = { layers: L };

  switch (shape) {
    // ---------------------------------------------------------- head
    case 'hood':
      L.push(shell([{ region: 'scalp' }, { region: 'neck' }], 0.012, 8, mat, { hood: true, trim }));
      spec.hideHair = true;
      break;
    case 'coif.mail':
      L.push(shell([{ region: 'scalp' }, { region: 'neck' }], 0.008, 4, mat));
      L.push(shell([{ region: 'neck' }], 0.005, 3, paddedMat(v)));
      spec.hideHair = true;
      break;
    case 'cap.leather': case 'helm.nasal': case 'helm.horned': case 'helm.kettle': case 'helm.barbute': case 'helm.great': case 'helm.skull':
    case 'hat.straw': case 'hat.wide': case 'hat.pointed': case 'circlet': case 'crown': {
      L.push(rigid(defId, v, 'head', (c) => buildHeadwear(shape, c)));
      const h = HELM_HIDES[shape];
      spec.hideHair = h.hair;
      spec.hideBeard = h.beard;
      // Closed helms sit over a mail aventail or padded coif.
      if (shape === 'helm.great' || shape === 'helm.barbute') L.push(shell([{ region: 'neck' }], 0.007, 4, mailMat(v)));
      break;
    }
    // ---------------------------------------------------------- face
    case 'mask.cloth': case 'mask.leather': case 'mask.bone': case 'mask.metal': case 'veil':
      L.push(rigid(defId, v, 'head', (c) => buildMask(shape, c)));
      spec.hideBeard = shape === 'mask.cloth' || shape === 'mask.bone' || shape === 'mask.metal';
      break;
    // ---------------------------------------------------------- neck
    case 'gorget': case 'torc': case 'amulet': case 'pendant':
      L.push(rigid(defId, v, 'neck', (c) => buildNeckPiece(shape, c)));
      break;
    case 'scarf':
      L.push(shell([{ region: 'neck' }], 0.016, 6, mat));
      L.push(rigid(defId, v, 'neck', (c) => buildNeckPiece('scarf', c)));
      break;
    // ---------------------------------------------------------- shoulders
    case 'mantle.fur':
      L.push(rigid(defId, v, 'neck', (c) => buildNeckPiece('mantle.fur', c)));
      break;
    case 'pauldron.leather': case 'pauldron.scale': case 'pauldron.plate': case 'pauldron.bone':
      L.push(...rigidPair(defId, v, 'shoulder', (c) => buildPauldron(shape, c)));
      break;
    // ---------------------------------------------------------- chest
    case 'shirt':
      L.push(shell([...TORSO, ...arms(1, 1)], 0.003, 1, mat, { trim: { width: 0.006, color: look.color2 } }));
      break;
    case 'tunic':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 0.15)], 0.005, 2, mat, { skirt: { length: 0.3, flare: 0.35, slits: 2 }, trim }));
      break;
    case 'vest':
      L.push(shell([...TORSO], 0.008, 3, mat, { trim: { width: 0.008, color: look.accent } }));
      break;
    case 'doublet':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.009, 3, mat, { skirt: { length: 0.08, flare: 0.2 }, trim }));
      break;
    case 'robe.short':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.009, 3, mat, { skirt: { length: 0.32, flare: 0.4, slits: 2 }, trim: { width: 0.02, color: look.accent } }));
      break;
    case 'robe.long':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.01, 3, mat, { skirt: { length: 0.95, flare: 0.45, slits: 2 }, trim: { width: 0.025, color: look.accent } }));
      break;
    case 'robe.gown':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.008, 3, mat, { skirt: { length: 1.0, flare: 0.7 }, trim: { width: 0.02, color: look.accent } }));
      break;
    case 'coat.long':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.022, 7, mat, { skirt: { length: 0.75, flare: 0.3, slits: 3 }, trim }));
      break;
    case 'gambeson':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.01, 3, mat, { skirt: { length: 0.18, flare: 0.2, slits: 2 } }));
      break;
    case 'jerkin':
      L.push(shell([...TORSO, ...HIPS, ...arms(0.15)], 0.013, 4, mat, { skirt: { length: 0.13, flare: 0.15, slits: 2 }, trim }));
      break;
    case 'brigandine':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.009, 3, paddedMat(v), { skirt: { length: 0.22, flare: 0.2, slits: 2 } }));
      L.push(shell([...TORSO, ...HIPS], 0.017, 5, mat, { skirt: { length: 0.15, flare: 0.15, slits: 2 }, trim }));
      break;
    case 'hide':
      L.push(shell([...TORSO, ...HIPS, ...arms(0.4)], 0.018, 5, mat, { skirt: { length: 0.22, flare: 0.3, slits: 4 } }));
      break;
    case 'hauberk':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 1)], 0.009, 3, paddedMat(v), { skirt: { length: 0.43, flare: 0.25, slits: 2 } }));
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 0.5)], 0.014, 4, mat, { skirt: { length: 0.38, flare: 0.25, slits: 2 } }));
      break;
    case 'scale':
    case 'lamellar':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 0.9)], 0.009, 3, paddedMat(v), { skirt: { length: 0.32, flare: 0.25, slits: 2 } }));
      L.push(shell([...TORSO, ...HIPS, ...arms(0.45)], 0.017, 5, mat, { skirt: { length: shape === 'scale' ? 0.26 : 0.3, flare: 0.25, slits: shape === 'scale' ? 2 : 4 }, trim }));
      break;
    case 'cuirass':
      L.push(shell([...TORSO, ...HIPS, ...arms(1, 0.4)], 0.012, 4, mailMat(v), { skirt: { length: 0.3, flare: 0.25, slits: 2 } }));
      L.push(shell([...TORSO, { region: 'pelvis' }], 0.022, 6, mat, { skirt: { length: 0.1, flare: 0.3 }, trim: { width: 0.01, color: look.accent } }));
      break;
    case 'harness.bone':
      L.push(shell([...TORSO, ...HIPS], 0.012, 4, shellMat(look, v, { pattern: 'leather', color: [0.36, 0.24, 0.15], color2: [0.2, 0.13, 0.08], metalness: 0, roughness: 0.7, patternScale: 4 }), { skirt: { length: 0.15, flare: 0.2, slits: 4 } }));
      L.push(rigid(defId, v, 'chest', (c) => buildBoneRibs(c)));
      break;
    // ---------------------------------------------------------- back
    case 'cloak':
    case 'cloak.fur':
      L.push(shell([{ region: 'back' }, { region: 'neck' }, ...arms(0.3)], 0.03, 8, mat, { skirt: { length: 0.62, flare: 0.5 }, hood: shape === 'cloak', trim: shape === 'cloak' ? trim : undefined }));
      L.push(rigid(defId, v, 'neck', (c) => buildNeckPiece(shape === 'cloak.fur' ? 'mantle.fur' : 'clasp', c)));
      break;
    case 'cape':
      L.push(shell([{ region: 'back' }, ...arms(0.25)], 0.028, 8, mat, { trim }));
      L.push(rigid(defId, v, 'neck', (c) => buildNeckPiece('clasp', c)));
      break;
    // ---------------------------------------------------------- wrists & hands
    case 'wraps':
      L.push(shell([...pair('forearm', 0.4, 1), ...pair('hand', 0, 0.35)], 0.006, 4, mat));
      break;
    case 'bracers.leather': case 'bracers.metal': case 'vambraces':
      L.push(...rigidPair(defId, v, 'forearm', (c) => buildBracer(shape, c)));
      break;
    case 'gloves.cloth':
      L.push(shell([...pair('hand', 0, 0.62)], 0.004, 4, mat));
      break;
    case 'gloves.leather':
      L.push(shell([...pair('hand'), ...pair('forearm', 0.86, 1)], 0.004, 4, mat));
      L.push(...rigidPair(defId, v, 'forearm', (c) => buildBracer('gauntlet.cuff.leather', c)));
      break;
    case 'gauntlets.mail':
      L.push(shell([...pair('hand'), ...pair('forearm', 0.8, 1)], 0.006, 4, mat));
      break;
    case 'gauntlets.plate':
      L.push(shell([...pair('hand')], 0.007, 5, mat));
      L.push(...rigidPair(defId, v, 'forearm', (c) => buildBracer('gauntlet.cuff', c)));
      L.push(...rigidPair(defId, v, 'hand', (c) => buildKnucklePlate(c)));
      break;
    // ---------------------------------------------------------- waist
    case 'belt.rope': case 'belt.leather': case 'belt.pouches': case 'sash':
      L.push(rigid(defId, v, 'pelvis', (c) => buildBelt(shape, c)));
      break;
    case 'belt.plated':
      L.push(rigid(defId, v, 'pelvis', (c) => buildBelt(shape, c)));
      L.push(...rigidPair(defId, v, 'thigh', (c) => buildTasset(c)));
      break;
    // ---------------------------------------------------------- legs
    case 'trousers':
      L.push(shell([...HIPS, ...legs(1, 1)], 0.004, 1, mat, { trim: { width: 0.006, color: look.color2 } }));
      break;
    case 'breeches':
      L.push(shell([...HIPS, ...legs(1, 0.3)], 0.006, 2, mat, { trim }));
      break;
    case 'kilt':
      L.push(shell([...HIPS, ...pair('thigh', 0, 0.12)], 0.01, 3, mat, { skirt: { length: 0.42, flare: 0.45 } }));
      break;
    case 'leggings.padded':
      L.push(shell([...HIPS, ...legs(1, 1)], 0.007, 2, mat));
      break;
    case 'leggings.leather':
      L.push(shell([...HIPS, ...legs(1, 1)], 0.008, 3, mat));
      L.push(...rigidPair(defId, v, 'shin', (c) => buildKneeCop(c, 'leather')));
      break;
    case 'chausses':
      L.push(shell([...HIPS, ...legs(1, 1)], 0.006, 2, paddedMat(v)));
      L.push(shell([...HIPS, ...legs(1, 1)], 0.011, 4, mat));
      break;
    case 'leggings.scale':
      L.push(shell([...HIPS, ...legs(1, 1)], 0.006, 2, paddedMat(v)));
      L.push(shell([...pair('thigh')], 0.014, 5, mat));
      L.push(...rigidPair(defId, v, 'shin', (c) => {
        const g = new THREE.Group();
        g.add(buildKneeCop(c, 'metal'), buildGreave(c, 'metal'));
        return g;
      }));
      break;
    case 'legplates':
      L.push(shell([...HIPS, ...legs(1, 1)], 0.008, 3, mailMat(v)));
      L.push(shell([...pair('thigh')], 0.016, 6, mat));
      L.push(...rigidPair(defId, v, 'shin', (c) => {
        const g = new THREE.Group();
        g.add(buildKneeCop(c, 'metal'), buildGreave(c, 'metal'));
        return g;
      }));
      break;
    // ---------------------------------------------------------- feet
    case 'sandals':
      L.push(...rigidPair(defId, v, 'foot', (c) => buildSandal(c)));
      break;
    case 'shoes':
      L.push(shell([...pair('foot')], 0.006, 4, mat));
      break;
    case 'boots.leather':
      L.push(shell([...pair('foot'), ...pair('shin', 0.52, 1)], 0.008, 4, mat, { trim: { width: 0.01, color: look.color2 } }));
      break;
    case 'boots.tall':
      L.push(shell([...pair('foot'), ...pair('shin', 0.08, 1)], 0.008, 4, mat));
      L.push(...rigidPair(defId, v, 'shin', (c) => buildBootCuff(c, 0.06, false)));
      break;
    case 'boots.fur':
      L.push(shell([...pair('foot'), ...pair('shin', 0.45, 1)], 0.012, 4, mat));
      L.push(...rigidPair(defId, v, 'shin', (c) => buildBootCuff(c, 0.42, true)));
      break;
    case 'sabatons':
      L.push(shell([...pair('foot'), ...pair('shin', 0.8, 1)], 0.008, 5, mat));
      L.push(...rigidPair(defId, v, 'foot', (c) => buildSabaton(c)));
      break;
    // ---------------------------------------------------------- rings
    case 'ring.band': case 'ring.signet': case 'ring.gem':
      // Rings attach to the right hand's ring finger; the humanoid module may
      // re-target slot ring1 to 'hand.L' (the part is symmetric enough to reuse).
      L.push(rigid(defId, v, 'hand.R', (c) => buildRing(shape, c)));
      break;
    default:
      return null;
  }
  return spec;
};
