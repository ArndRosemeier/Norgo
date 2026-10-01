/**
 * Item meshes: weapons, shields, tools, lights and ammunition.
 *
 * Builders work in *weapon space* (+Y along handle/blade, +X = edge/forward,
 * Z = flat thickness) and the result is rotated so +X becomes item-space +Z
 * (the edge/front direction of the shared convention). Shields are built
 * directly in item space with the painted face toward +Z.
 *
 * Origins: grip point (where the hand closes) for held items; nock for
 * arrows/bolts; the bail top for lanterns; resting base for stones/lockpicks.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { styleOf } from '../../data/styles';
import { mesh, bladeGeometry } from './util';
import { type WCtx, guard, pommel, grip, hiltStyles, runeStrip, addHalos, type GuardStyle, type PommelStyle } from './weapons_parts';
import { buildHafted } from './weapons_hafted';
import { buildRanged } from './weapons_ranged';
import { buildToolMesh } from './weapons_tools';
import { buildShield } from './shields';

/** Blade silhouette families. */
type BladeKind = 'straight' | 'leaf' | 'wide' | 'needle' | 'clip';

interface SwordCfg {
  bladeLen: number;
  hw: number;
  gripLen: number;
  gripR: number;
  kind: BladeKind;
  single?: boolean;
  curve?: number;
  fuller?: number;
  thick?: number;
  guard?: GuardStyle;
  guardW?: number;
  pommel?: PommelStyle;
  pommelS?: number;
  ricasso?: number;
  noGuard?: boolean;
}

/**
 * Blade stations [y, halfWidth, xOffset]. Culture & rng shape the silhouette:
 * orcs serrate, goblins notch, elves leaf, dwarves/giantkin broaden.
 */
function bladeStations(c: WCtx, cfg: SwordCfg, y0: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const motif = c.st.motif;
  const serrate = motif === 'spikes' && !cfg.single ? 1 : motif === 'spikes' ? 0.5 : 0;
  const notch = motif === 'rough';
  const n = serrate ? 26 : 16;
  const L = cfg.bladeLen;
  const tipStart = cfg.kind === 'needle' ? 0.75 : cfg.kind === 'clip' ? 0.8 : cfg.kind === 'leaf' ? 0.7 : 0.84;
  const ric = cfg.ricasso ?? 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let w: number;
    switch (cfg.kind) {
      case 'leaf': w = cfg.hw * (0.78 + 0.42 * Math.sin(Math.PI * Math.min(1, t / 0.95) * 0.85)); break;
      case 'wide': w = cfg.hw * (0.75 + 0.65 * t); break;
      case 'needle': w = cfg.hw * (1 - 0.55 * t); break;
      case 'clip': w = cfg.hw * (1 - 0.1 * t); break;
      default: w = cfg.hw * (1 - 0.28 * t);
    }
    if (t < ric) w *= 0.72;
    if (t > tipStart) {
      const k = (t - tipStart) / (1 - tipStart);
      // Ogive point: convex taper to the tip.
      w *= Math.sqrt(Math.max(0, 1 - k * k)) * (cfg.kind === 'clip' ? 1 - k * 0.3 : 1);
    }
    if (serrate && t > 0.12 && t < tipStart && i % 2 === 1) w *= 0.8;
    if (notch && t > 0.2 && t < tipStart && c.rng.chance(0.3)) w *= 0.86 + c.rng.float() * 0.08;
    const xo = -(cfg.curve ?? 0) * t * t * L + (cfg.single ? -w * 0.0 : 0);
    out.push([y0 + t * L, i === n ? 0 : Math.max(0.0015, w), xo]);
  }
  return out;
}

/** Full sword/dagger/knife assembly: pommel, grip, guard, blade, engravings. */
function sword(c: WCtx, cfg: SwordCfg) {
  const { g, kit } = c;
  const gy0 = -cfg.gripLen / 2, gy1 = cfg.gripLen / 2;
  grip(c, gy0, gy1, cfg.gripR);
  const styles = hiltStyles(c);
  pommel(c, cfg.pommel ?? styles.pommel, gy0, cfg.pommelS ?? cfg.gripR * 1.5);
  let by = gy1;
  if (!cfg.noGuard) {
    const gs = cfg.guard ?? styles.guard;
    by = gy1 + guard(c, gs, gy1 + 0.009, cfg.guardW ?? cfg.hw * 3.6, 0.018, cfg.gripR * 1.5) + 0.009;
  }
  const st = bladeStations(c, cfg, by - 0.004);
  const thick = cfg.thick ?? (cfg.single ? 0.2 : 0.14);
  const blade = mesh(bladeGeometry(st, thick, { fuller: cfg.fuller ?? 0, fullerEnd: 0.65, single: cfg.single }), kit.get('blade'));
  g.add(blade);
  c.heads.push(blade);
  // Engravings: dwarven runes always, others when enchanted.
  const L = cfg.bladeLen;
  const zAt = (y: number) => {
    const t = (y - by) / L;
    let hw = cfg.hw;
    for (let i = 1; i < st.length; i++) if (st[i][0] >= y) { hw = st[i][1]; break; }
    const f = cfg.fuller && t < 0.65 ? 1 - cfg.fuller * Math.min(1, (0.65 - t) * 8) : 1;
    return hw * thick * f;
  };
  const xo = (y: number) => -(cfg.curve ?? 0) * Math.pow((y - by) / L, 2) * L - (cfg.single ? cfg.hw * 0.25 : 0);
  const cell = Math.max(0.012, cfg.hw * 0.7);
  if (c.v.glow > 0.05) runeStrip(c, by + L * 0.08, by + L * 0.55, cell, zAt, kit.get('glow'), xo);
  else if (c.st.motif === 'runic' || c.st.motif === 'megalith') runeStrip(c, by + L * 0.06, by + L * 0.35, cell, zAt, kit.get('dark'), xo);
  // Elven/sylvan leaf etching near the guard, umbral crescent inlay.
  if ((c.st.motif === 'leafvine' || c.st.motif === 'crescent') && c.v.glow <= 0.05) {
    const y = by + L * 0.12;
    const r = cfg.hw * 0.45;
    for (const sz of [1, -1]) {
      const m = mesh(new THREE.TorusGeometry(r, r * 0.12, 4, 12, c.st.motif === 'crescent' ? Math.PI * 1.3 : Math.PI * 2), kit.get('trim'), xo(y), y, sz * (zAt(y) + 0.0004), 0, 0, Math.PI * 0.35);
      m.scale.set(1, c.st.motif === 'leafvine' ? 1.8 : 1, 0.2);
      g.add(m);
    }
  }
  // Gem in the guard for rich items.
  if (c.v.glow > 0.2 || c.rng.chance(0.25)) {
    for (const sz of [1, -1]) g.add(mesh(new THREE.SphereGeometry(0.0065, 8, 6), kit.get('gem'), 0, gy1 + 0.009, sz * cfg.gripR * 1.15));
  }
}

function blades(shape: string, c: WCtx): boolean {
  const r = c.rng;
  const b = c.st.broad;
  const cv = c.st.curve;
  const kindFor = (dflt: BladeKind): BladeKind => (c.st.motif === 'leafvine' && r.chance(0.7) ? 'leaf' : dflt);
  switch (shape) {
    case 'dagger':
      sword(c, { bladeLen: r.range(0.2, 0.26), hw: 0.016 * b, gripLen: 0.095, gripR: 0.012, kind: kindFor(r.pick(['straight', 'leaf', 'needle'])), fuller: r.chance(0.5) ? 0.4 : 0, guardW: 0.045 * b, pommelS: 0.015 });
      return true;
    case 'dagger.curved':
      sword(c, { bladeLen: r.range(0.2, 0.25), hw: 0.017 * b, gripLen: 0.095, gripR: 0.012, kind: 'clip', single: true, curve: -0.25 - cv * 0.2, guard: c.st.motif === 'crescent' ? 'crescent' : 'curved', guardW: 0.04, pommelS: 0.014 });
      return true;
    case 'knife':
      return false;
    case 'throw.knife':
      sword(c, { bladeLen: 0.13, hw: 0.013, gripLen: 0.08, gripR: 0.008, kind: 'leaf', noGuard: true, pommel: 'ring', pommelS: 0.011, thick: 0.18 });
      return true;
    case 'sword.short':
      sword(c, { bladeLen: r.range(0.5, 0.6), hw: 0.025 * b, gripLen: 0.1, gripR: 0.0135, kind: kindFor(r.pick(['straight', 'leaf'])), fuller: r.chance(0.6) ? 0.45 : 0, guardW: 0.075 * b });
      return true;
    case 'sword.long':
      sword(c, { bladeLen: r.range(0.84, 0.94), hw: 0.024 * b, gripLen: r.range(0.17, 0.22), gripR: 0.0135, kind: kindFor('straight'), fuller: r.range(0.35, 0.6), guardW: r.range(0.09, 0.12) * Math.sqrt(b) });
      return true;
    case 'sword.great':
      sword(c, { bladeLen: r.range(1.1, 1.22), hw: 0.029 * b, gripLen: r.range(0.28, 0.34), gripR: 0.015, kind: kindFor('straight'), fuller: r.range(0.35, 0.55), ricasso: 0.1, guardW: r.range(0.14, 0.18) * Math.sqrt(b), pommelS: 0.024 });
      return true;
    case 'sword.sabre':
      sword(c, { bladeLen: r.range(0.78, 0.84), hw: 0.017 * b, gripLen: 0.12, gripR: 0.013, kind: 'clip', single: true, curve: 0.07 + cv * 0.05, fuller: 0.35, guard: c.st.motif === 'leafvine' ? 'wings' : 'knuckle', guardW: 0.05, pommel: r.pick(['scent', 'ball']) });
      return true;
    case 'sword.scimitar':
      sword(c, { bladeLen: r.range(0.72, 0.8), hw: 0.022 * b, gripLen: 0.12, gripR: 0.013, kind: 'wide', single: true, curve: 0.16 + cv * 0.08, guard: c.st.motif === 'crescent' ? 'crescent' : r.pick(['curved', 'bar']), guardW: 0.065, pommel: r.pick(['scent', 'spike', 'claw']) });
      return true;
    case 'sword.rapier':
      sword(c, { bladeLen: r.range(0.92, 1.0), hw: 0.011, gripLen: 0.11, gripR: 0.012, kind: 'needle', thick: 0.42, guard: 'swept', guardW: 0.07, pommel: r.pick(['scent', 'ball', 'faceted']) });
      return true;
    default:
      return false;
  }
}

/** Build any weapon/shield/tool/light/ammo mesh, or null for other shapes. */
export function buildWeaponsMesh(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  if (shape.startsWith('shield.')) return buildShield(shape, v, kit, rng);
  const g = new THREE.Group();
  const c: WCtx = { v, kit, rng, st: styleOf(v.style), g, heads: [] };
  const ok = blades(shape, c) || buildHafted(shape, c) || buildRanged(shape, c) || buildToolMesh(shape, c);
  if (!ok) return null;
  addHalos(c);
  // Weapon space (+X edge) → item space (+Z edge).
  g.rotation.y = -Math.PI / 2;
  const root = new THREE.Group();
  root.add(g);
  if (g.userData.light) root.userData.light = g.userData.light;
  if (g.userData.flames) root.userData.flames = g.userData.flames;
  return root;
}
