/**
 * Blueprint dispatch & caches. `blueprintFor(building, heraldry)` returns the
 * deterministic piece list for any building (style builders, fortifications,
 * infrastructure), `propGroupBlueprint` does the same for groups of free-
 * standing props, and `silhouetteFor` produces the cheap far-LOD shape.
 * Blueprints are cached per thread (server worker / client main thread).
 */
import type { ArchStyle, BuildingInfo, Heraldry, PropInfo, SettlementLayout } from '../types';
import type { Vec3 } from '../../shared/types';
import { deriveSeed } from '../../core/rng';
import { Kit, Surf, jitter, scaleHex, type Blueprint } from './kit';
import { makeCtx, type StyleBuilder, type BuildCtx } from './common';
import { buildTimber } from './styleTimber';
import { buildWall, buildGate, buildFortTower } from './fort';
import { buildWell, buildBridge, buildDock } from './infra';
import { buildProp } from './props';
import { STYLES } from './styles';
import { STYLE_BUILDERS, STYLE_SILHOUETTES } from './registry';

const DEFAULT_HERALDRY: Heraldry = { field: 0x2a4ab0, field2: 0xd0a020, charge: 0xf0f0e8, division: 'plain', emblem: 'star' };

const cache = new Map<string, Blueprint>();
const CACHE_MAX = 900;

function remember(key: string, bp: Blueprint) {
  cache.set(key, bp);
  if (cache.size > CACHE_MAX) {
    const it = cache.keys();
    for (let i = 0; i < CACHE_MAX / 4; i++) cache.delete(it.next().value as string);
  }
}

/** Builder used for a style (dedicated builders register in registry.ts; timber is the generic fallback). */
export function builderFor(style: ArchStyle): StyleBuilder {
  return STYLE_BUILDERS[style] ?? buildTimber;
}

export function blueprintFor(b: BuildingInfo, her: Heraldry = DEFAULT_HERALDRY): Blueprint {
  const key = b.id + '#' + b.seed;
  const hit = cache.get(key);
  if (hit) return hit;
  const k = new Kit(deriveSeed(b.seed, 'kit'));
  const c = makeCtx(b, her);
  let interior: Blueprint['interior'];
  switch (b.role) {
    case 'wall':
      interior = buildWall(k, c);
      break;
    case 'gate':
      interior = buildGate(k, c);
      break;
    case 'well':
      interior = buildWell(k, c);
      break;
    case 'bridge':
      interior = buildBridge(k, c);
      break;
    case 'dock':
      interior = buildDock(k, c);
      break;
    default:
      interior = b.role === 'watchtower' && b.fortification ? buildFortTower(k, c) : builderFor(b.style)(k, c);
  }
  const bp = k.finish(interior);
  remember(key, bp);
  return bp;
}

// ------------------------------------------------------------------ prop groups

export interface PropGroup {
  /** Group building id `B:<siteId>:p<n>`. */
  id: string;
  pos: Vec3;
  props: PropInfo[];
}

const groupCache = new WeakMap<SettlementLayout, PropGroup[]>();

/** Props grouped by their id token (`B:<site>:p<n>:<i>` → group `B:<site>:p<n>`, piece i). */
export function propGroups(l: SettlementLayout): PropGroup[] {
  const hit = groupCache.get(l);
  if (hit) return hit;
  const m = new Map<string, PropGroup>();
  for (const p of l.props ?? []) {
    const gid = p.id.slice(0, p.id.lastIndexOf(':'));
    let g = m.get(gid);
    if (!g) m.set(gid, (g = { id: gid, pos: [p.pos[0], p.pos[1], p.pos[2]], props: [] }));
    g.props.push(p);
  }
  const out = [...m.values()];
  groupCache.set(l, out);
  return out;
}

export function propGroupBlueprint(g: PropGroup, her: Heraldry = DEFAULT_HERALDRY): Blueprint {
  const key = g.id + '#' + g.props.length;
  const hit = cache.get(key);
  if (hit) return hit;
  const k = new Kit(deriveSeed(g.props[0]?.seed ?? 1, 'props'));
  for (const p of g.props) buildProp(k, p, p.pos[0] - g.pos[0], p.pos[1] - g.pos[1], p.pos[2] - g.pos[2], her);
  const bp = k.finish(null);
  remember(key, bp);
  return bp;
}

// ------------------------------------------------------------------ far LOD silhouettes

/** A handful of primitives approximating the building from afar (with lit windows at night). */
export function silhouetteFor(b: BuildingInfo, her: Heraldry = DEFAULT_HERALDRY): Blueprint {
  const key = 'sil:' + b.id + '#' + b.seed;
  const hit = cache.get(key);
  if (hit) return hit;
  const k = new Kit(deriveSeed(b.seed, 'sil'));
  k.piece('wall', 'stone');
  const custom = STYLE_SILHOUETTES[b.style];
  if (custom && !(b.role === 'wall' || b.role === 'gate' || b.role === 'bridge' || b.role === 'dock' || b.role === 'well' || b.fortification)) custom(k, makeCtx(b, her));
  else genericSilhouette(k, makeCtx(b, her));
  const bp = k.finish(null);
  remember(key, bp);
  return bp;
}

export function genericSilhouette(k: Kit, c: BuildCtx) {
  const b = c.b;
  const st = STYLES[b.style] ?? STYLES.timber;
  const w = b.size[0], d = b.size[1];
  const gmin = Math.min(...(b.ground ?? [0, 0, 0, 0]));
  const wall = c.wall, roof = c.roof;
  const glow = st.glow;
  switch (b.role) {
    case 'wall':
      k.box(0, gmin, 0, w, b.size[2] - gmin + 0.8, d, wall.surf, scaleHex(wall.col, 0.95));
      return;
    case 'gate':
      k.box(0, gmin, 0, w, b.size[2] + 2.5 - gmin, d, wall.surf, wall.col);
      return;
    case 'bridge':
      k.box(0, -0.6, 0, w, 1.4, d, Surf.StoneBrick, 0x8a847a);
      return;
    case 'dock':
      k.box(0, -0.3, 0, w, 0.3, d, Surf.Planks, 0x7a5a3a);
      return;
    case 'well':
      k.cyl(0, 0, 0, 1, 1, 1, Surf.Rubble, 0x9a968c, { seg: 6 });
      return;
  }
  const floors = b.floors ?? 1;
  const storey = st.storey * c.s * (b.role === 'temple' ? 1.9 : b.role === 'hall' ? 1.6 : 1);
  const H = b.fortification ? b.size[2] : floors * storey;
  const lit = (deriveSeed(b.seed, 'lit') & 255) < 190;
  if (b.round) {
    const r = w / 2;
    k.cyl(0, gmin, 0, r, r * (b.role === 'mill' ? 0.82 : 1), H - gmin, wall.surf, wall.col, { seg: 8 });
    if (b.roof === 'dome') k.sphere(0, H, 0, r + 0.3, Math.max(1.2, r * 0.8), r + 0.3, roof.surf, roof.col, { lat0: 0, lat1: Math.PI / 2, seg: 8 });
    else k.cyl(0, H - 0.1, 0, r + 0.4, 0, (r + 0.4) * (b.role === 'mage_tower' ? 2.2 : 1.3), roof.surf, roof.col, { seg: 8 });
  } else {
    k.box(0, gmin, 0, w, H - gmin, d, wall.surf, wall.col);
    const along = w >= d;
    const span = along ? d : w;
    const rise = span * 0.5 * (st.pitch[0] + st.pitch[1]) * 0.5;
    if (b.roof === 'flat') k.box(0, H, 0, w + 0.2, 0.8, d + 0.2, roof.surf, roof.col);
    else if (along) k.frustum(0, H - 0.2, 0, w + 0.8, d + 0.8, b.roof === 'hip' ? Math.max(0.1, w - d) : w + 0.8, 0, rise, roof.surf, roof.col);
    else k.frustum(0, H - 0.2, 0, w + 0.8, d + 0.8, 0, b.roof === 'hip' ? Math.max(0.1, d - w) : d + 0.8, rise, roof.surf, roof.col);
  }
  if (lit && !b.fortification && b.role !== 'barn' && b.role !== 'stable' && b.role !== 'warehouse') {
    // Two glowing windows per facade row (only visible at night).
    const r = b.round ? w / 2 : 0;
    for (let f = 0; f < Math.min(floors, 4); f++) {
      const y = f * storey + 1.2 * c.s;
      if (b.round) {
        for (const a of [0.4, 2.6, 4.4]) k.box(Math.sin(a) * r, y, Math.cos(a) * r, 0.6, 0.8, 0.6, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true, ry: a });
      } else {
        for (const sx of [-0.25, 0.25]) {
          k.box(sx * w, y, d / 2 + 0.02, 0.7, 0.9, 0.06, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true });
          k.box(sx * w, y, -d / 2 - 0.02, 0.7, 0.9, 0.06, Surf.Window, 0x30384a, { emit: glow, emitI: 2.2, night: true });
        }
      }
    }
  }
  void jitter;
}
