/**
 * Point-of-interest structures, one distinct atmospheric set piece per
 * PoiKind: collapsed keeps with crypt entrances, pillared shrines, bandit
 * camps, monster lairs under giant rib cages, sacred groves, rune-lit
 * monoliths, lone wizard towers, battlefields, sky-ship crash sites, old
 * wells, wayshrines and obelisks.
 *
 * Everything is built in POI-local space (y = 0 at the POI centre height,
 * +z = POI front) as destructible pieces with supports & colliders.
 * Foundations reach ~1.5 m below the lowest ground sample so slopes never
 * leave structures floating. The few anchors that NPC spots depend on (fire,
 * altar, tower door...) come from `poiPlan`, shared by `poiSpots` and the
 * builder so spots always match the geometry.
 */
import type { PoiInfo } from '../../world/sites';
import type { Heraldry, PoiLayout, PropInfo, PropKind, SmartSpot } from '../types';
import type { LayoutTerrain } from '../layout';
import { Rng, deriveSeed } from '../../core/rng';
import { Kit, Surf, jitter, rotXZ, scaleHex, yawToward, type PieceKind, type PieceMat } from './kit';
import { buildProp, figure } from './props';
import { buildRound } from './round';
import { heraldicPanel } from './heraldry';
import { makeHeraldry } from '../names';

// ------------------------------------------------------------------ plan shared by spots & builder

interface Plan {
  rng: Rng;
  /** Local anchor points (x, z) by name. */
  at: Record<string, [number, number]>;
  /** Integer/real parameters by name. */
  n: Record<string, number>;
}

function poiPlan(l: PoiLayout): Plan {
  const rng = new Rng(deriveSeed(l.structure.seed, 'plan'));
  const R = l.structure.size[0] / 2;
  const at: Plan['at'] = {};
  const n: Plan['n'] = {};
  switch (l.kind) {
    case 'ruin':
      n.w = Math.min(18, R * 0.62) * rng.range(0.85, 1.1);
      n.d = n.w * rng.range(0.65, 0.85);
      at.crypt = [n.w * 0.15, -n.d * 0.15];
      break;
    case 'shrine':
      n.cols = rng.pick([4, 6, 8]);
      n.round = rng.chance(0.5) ? 1 : 0;
      at.altar = [0, -0.8];
      break;
    case 'camp':
      n.tents = rng.int(2, 4);
      at.fire = [0, 0];
      break;
    case 'lair':
      at.mouth = [0, -R * 0.35];
      at.nest = [R * 0.2, R * 0.1];
      break;
    case 'grove':
      n.trees = rng.int(5, 7);
      at.altar = [0, 0];
      break;
    case 'monolith':
      n.h = rng.range(9, 14);
      n.stones = rng.int(6, 9);
      break;
    case 'tower':
      n.r = rng.range(3.3, 4.3);
      n.floors = rng.int(4, 5);
      n.ruined = rng.chance(0.55) ? 1 : 0;
      n.storey = 3.2;
      break;
    case 'battlefield':
      n.count = rng.int(28, 38);
      break;
    case 'crashsite':
      n.crater = rng.range(8, 11);
      break;
    case 'wayshrine':
      at.shrine = [0, 0];
      break;
    default:
      break;
  }
  return { rng, at, n };
}

/** World position (with terrain height) of a POI-local point. */
function worldAt(l: PoiLayout, t: LayoutTerrain, x: number, z: number): [number, number, number] {
  const [ox, oz] = rotXZ(x, z, l.structure.yaw);
  const wx = l.center[0] + ox, wz = l.center[2] + oz;
  return [wx, t.heightAt(wx, wz), wz];
}

/** Spot yaw (looks toward −Z convention) facing from local a toward local b. */
function faceYaw(l: PoiLayout, ax: number, az: number, bx: number, bz: number): number {
  const [dx, dz] = rotXZ(bx - ax, bz - az, l.structure.yaw);
  return yawToward(dx, dz);
}

export function poiSpots(l: PoiLayout, t: LayoutTerrain): SmartSpot[] {
  const plan = poiPlan(l);
  const id = l.structure.id;
  const out: SmartSpot[] = [];
  let i = 0;
  const add = (kind: SmartSpot['kind'], x: number, z: number, tx: number, tz: number, y?: number) => {
    const p = worldAt(l, t, x, z);
    if (y !== undefined) p[1] = l.center[1] + y;
    out.push({ id: `${id}:s${i++}`, kind, pos: p, yaw: faceYaw(l, x, z, tx, tz), building: id });
  };
  switch (l.kind) {
    case 'shrine': {
      const [ax, az] = plan.at.altar;
      for (const u of [-0.9, 0, 0.9]) add('pray', ax + u, az + 2.0, ax, az, 0.45);
      break;
    }
    case 'wayshrine':
      add('pray', 0, 1.4, 0, 0);
      add('idle', 2.5, 2.5, 0, 0);
      break;
    case 'camp':
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const x = Math.cos(a) * 2.6, z = Math.sin(a) * 2.6;
        add(k === 0 ? 'cook' : 'seat', x, z, 0, 0);
      }
      add('guard', 0, 9, 0, 20);
      break;
    case 'tower':
      add('guard', 0, plan.n.r + 2, 0, plan.n.r + 10);
      add('read', 0, 0, 0, -1, plan.n.storey * 2);
      break;
    case 'grove':
      add('pray', 0, 2.2, 0, 0);
      add('idle', -3, 3, 0, 0);
      break;
    case 'monolith':
    case 'obelisk':
      add('pray', 0, 4.5, 0, 0);
      break;
    case 'well':
      add('idle', 1.8, 0.6, 0, 0);
      break;
    case 'ruin':
      add('idle', 0, plan.n.d / 2 + 2, 0, 0);
      add('guard', plan.at.crypt[0], plan.at.crypt[1] + 2.5, plan.at.crypt[0], plan.at.crypt[1]);
      break;
    case 'lair':
      add('idle', plan.at.nest[0], plan.at.nest[1], 0, 0);
      break;
    default:
      add('idle', 2, 2, 0, 0);
  }
  return out;
}

const DESCRIPTIONS: Record<string, string[]> = {
  ruin: [
    'Broken walls of a forgotten keep stand roofless against the sky, ivy pouring through empty windows.',
    'A chapel lies in ruin here; its arch still stands, and a stair below the rubble leads into the dark.',
    'Tumbled stones and fallen columns mark where a proud hall once stood before fire took it.',
  ],
  shrine: [
    'A quiet pillared shrine, its altar heaped with candles and small offerings left by passing pilgrims.',
    'Weathered columns ring an old altar where a stone saint keeps watch over the land.',
  ],
  camp: [
    'A rough camp of hide tents around a smouldering fire — someone is living out here, and not openly.',
    'Racks of weapons and a crooked banner mark a camp of hard folk who do not welcome strangers.',
  ],
  lair: [
    'The bones of something enormous arch over a gnawed den; the air reeks of old blood.',
    'A cave mouth of piled boulders, scored by claws, with picked-clean bones scattered before it.',
  ],
  grove: [
    'Ancient trees stand in a perfect ring here, glowing fungi pulsing softly at their roots.',
    'A sacred grove whose mossy altar stone hums faintly when the wind is still.',
  ],
  monolith: [
    'A towering black stone, carved with runes that glow when no one is watching closely.',
    'A monolith older than any kingdom rises from a ring of lesser stones, faintly warm to the touch.',
  ],
  tower: [
    'A lone tower watches over the wilds; a light still burns in one high window.',
    'The shell of a wizard\'s tower, its crown broken open, stairs spiralling up into the wind.',
  ],
  battlefield: [
    'Broken spears and rotting banners litter a field where two armies met and neither won.',
    'Cairns and burnt wagons mark an old battlefield; crows still circle it out of habit.',
  ],
  crashsite: [
    'Something fell from the sky here: a crater of shattered rock, twisted ribs of a hull and crystals that glow with stolen starlight.',
    'The wreck of a sky-ship lies in a smoking crater, its crystal heart cracked and bleeding light.',
  ],
  well: [
    'An old stone well, roof half fallen, its water still cold and sweet.',
    'A forgotten well overgrown with ivy; travellers say a coin dropped in brings good roads.',
  ],
  wayshrine: [
    'A small roadside shrine with a guttering candle, where travellers pause for a blessing.',
    'A weathered wayshrine on its post, a tiny saint gazing down the road.',
  ],
  obelisk: [
    'A slender obelisk on a stepped plinth, glyph bands glowing along its length.',
    'An obelisk of dark stone points at the sky, its inscriptions shifting in the corner of the eye.',
  ],
};

export function poiDescription(p: PoiInfo): string {
  const list = DESCRIPTIONS[p.kind] ?? [`A ${p.kind} stands here.`];
  return list[(p.seed >>> 4) % list.length];
}

// ------------------------------------------------------------------ builder helpers

interface Ctx {
  k: Kit;
  l: PoiLayout;
  plan: Plan;
  r: Rng;
  R: number;
  /** Lowest ground offset below y = 0 (foundations go 1.5 m deeper). */
  g: number;
  her: Heraldry;
  stone: number;
  propN: number;
}

function piece(c: Ctx, kind: PieceKind, mat: PieceMat, sup: number[] = [], need = sup.length ? 1 : 0) {
  return c.k.piece(kind, mat, sup, need);
}

function prop(c: Ctx, kind: PropKind, x: number, z: number, yaw: number, scale = 1, extra: Partial<PropInfo> = {}): number {
  const p: PropInfo = { id: `${c.l.structure.id}:x${c.propN++}`, kind, pos: [x, 0, z], yaw, scale, seed: deriveSeed(c.l.structure.seed, 'prop', c.propN), style: 'ruined', ...extra };
  return buildProp(c.k, p, x, 0, z, c.her);
}

/** A rough boulder (one piece unless `into` is given). */
function boulder(c: Ctx, x: number, y: number, z: number, s: number, col = c.stone, into?: number) {
  if (into === undefined) piece(c, 'deco', 'stone');
  else c.k.use(into);
  c.k.sphere(x, y, z, s * c.r.range(0.9, 1.3), s * c.r.range(0.6, 0.9), s * c.r.range(0.85, 1.2), Surf.Rubble, jitter(col, c.r, 0.08), { seg: 7, ry: c.r.range(0, 6.28), smooth: false });
  c.k.col(x, y - s * 0.5, z, s * 1.6, s * 1.4, s * 1.6, true);
}

function rubblePile(c: Ctx, x: number, z: number, r: number) {
  piece(c, 'deco', 'stone');
  const n = Math.round(4 + r * 3);
  for (let i = 0; i < n; i++) {
    const a = c.r.range(0, Math.PI * 2), d = c.r.range(0, r);
    const s = c.r.range(0.18, 0.5);
    if (c.r.chance(0.5)) c.k.box(x + Math.cos(a) * d, -0.15, z + Math.sin(a) * d, s * 1.6, s, s * 1.1, Surf.StoneBrick, jitter(c.stone, c.r, 0.1), { ry: c.r.range(0, 6.28), rz: c.r.range(-0.3, 0.3) });
    else c.k.sphere(x + Math.cos(a) * d, 0, z + Math.sin(a) * d, s, s * 0.7, s, Surf.Rubble, jitter(c.stone, c.r, 0.1), { seg: 6, smooth: false });
  }
  c.k.col(x, -0.2, z, r * 1.4, 0.7, r * 1.4, true);
}

/** Ivy draped down a wall face (frame: wall face at z, spanning x0..x1). */
function ivy(c: Ctx, x: number, top: number, z: number, w: number) {
  const n = Math.max(1, Math.round(w / 0.6));
  for (let i = 0; i < n; i++) {
    const h = c.r.range(0.6, top * 0.8);
    c.k.box(x - w / 2 + (i + 0.5) * (w / n), top - h, z, w / n * 1.1, h, 0.08, Surf.Leaf, jitter(0x3e6a2e, c.r, 0.15), { lod: 1 });
  }
}

function tree(c: Ctx, x: number, z: number, h: number, r: number) {
  const k = c.k;
  const trunk = piece(c, 'tree', 'wood');
  const bark = jitter(0x5a4a38, c.r, 0.1);
  k.cyl(x, c.g - 1, z, r * 1.25, r * 0.55, h * 0.7 - c.g + 1, Surf.Bark, bark, { seg: 9 });
  k.col(x, c.g - 1, z, r * 1.8, h * 0.7 - c.g + 1, r * 1.8, true);
  // Buttress roots.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + c.r.range(-0.3, 0.3);
    k.pole(x + Math.cos(a) * r * 0.6, 1.2 + c.r.range(0, 1), z + Math.sin(a) * r * 0.6, x + Math.cos(a) * r * 2.6, -0.4, z + Math.sin(a) * r * 2.6, r * 0.35, r * 0.12, Surf.Bark, scaleHex(bark, 0.92), { seg: 5 });
  }
  // Boughs.
  for (let i = 0; i < 4; i++) {
    const a = c.r.range(0, Math.PI * 2);
    const y0 = h * c.r.range(0.45, 0.65);
    k.pole(x, y0, z, x + Math.cos(a) * h * 0.3, y0 + h * 0.2, z + Math.sin(a) * h * 0.3, r * 0.4, r * 0.15, Surf.Bark, bark, { seg: 5 });
  }
  piece(c, 'tree', 'plant', [trunk], 1);
  for (let i = 0; i < 6; i++) {
    const a = c.r.range(0, Math.PI * 2), d = c.r.range(0, h * 0.28);
    const s = h * c.r.range(0.18, 0.28);
    k.sphere(x + Math.cos(a) * d, h * c.r.range(0.72, 0.95), z + Math.sin(a) * d, s, s * 0.7, s, Surf.Leaf, jitter(0x3e6e32, c.r, 0.15), { seg: 9 });
  }
}

// ------------------------------------------------------------------ per-kind builders

function buildRuin(c: Ctx) {
  const { k, plan } = c;
  const W = plan.n.w, D = plan.n.d;
  const t = 0.9;
  const found = piece(c, 'foundation', 'stone');
  k.solid(0, c.g - 1.5, 0, W + 0.6, -c.g + 1.5, D + 0.6, Surf.Rubble, scaleHex(c.stone, 0.9));
  k.box(0, 0, 0, W - 2 * t, 0.04, D - 2 * t, Surf.Cobble, jitter(0x6e6a62, c.r, 0.05), { lod: 1 });
  // Perimeter walls in ~3 m sections with broken, staggered tops.
  const sides: [number, number, number, number][] = [
    [0, D / 2 - t / 2, W, 0],
    [0, -D / 2 + t / 2, W, Math.PI],
    [W / 2 - t / 2, 0, D - 2 * t, Math.PI / 2],
    [-W / 2 + t / 2, 0, D - 2 * t, -Math.PI / 2],
  ];
  const archX = c.r.range(-W * 0.2, W * 0.2);
  sides.forEach(([sx, sz, L, yaw], side) => {
    k.push(sx, 0, sz, yaw);
    const n = Math.max(2, Math.round(L / 3));
    const sec = L / n;
    for (let i = 0; i < n; i++) {
      const x = -L / 2 + (i + 0.5) * sec;
      if (side === 0 && Math.abs(x - archX) < sec * 0.7) continue; // arch gap
      if (c.r.chance(0.18)) continue; // fully collapsed section
      piece(c, 'wall', 'stone', [found], 1);
      const H = c.r.range(1.2, 6.5) * (side === 1 ? 1.15 : 1);
      // Broken top: a few blocks of varied height.
      const blocks = 3;
      for (let b = 0; b < blocks; b++) {
        const bw = sec / blocks;
        const bh = Math.max(0.6, H * c.r.range(0.65, 1.05));
        k.solid(x - sec / 2 + (b + 0.5) * bw, 0, 0, bw + 0.01, bh, t, Surf.StoneBrick, jitter(c.stone, c.r, 0.05));
      }
      if (H > 3 && c.r.chance(0.6)) k.box(x, H * 0.45, 0, 0.5, 1.3, t + 0.04, Surf.Window, 0x0c0c0e, { lod: 1 });
      if (c.r.chance(0.5)) ivy(c, x, H * 0.95, t / 2 + 0.05, sec * 0.8);
    }
    k.pop();
  });
  // The intact arch: two piers + voussoir ring + keystone lintel.
  const pierL = piece(c, 'pillar', 'stone', [found], 1);
  k.solid(archX - 1.7, 0, D / 2 - t / 2, 0.9, 4.2, t + 0.2, Surf.StoneBrick, c.stone);
  const pierR = piece(c, 'pillar', 'stone', [found], 1);
  k.solid(archX + 1.7, 0, D / 2 - t / 2, 0.9, 4.2, t + 0.2, Surf.StoneBrick, c.stone);
  piece(c, 'beam', 'stone', [pierL, pierR], 2);
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    k.boxC(archX + Math.cos(a) * 1.5, 4.2 + Math.sin(a) * 1.5, D / 2 - t / 2, 0.55, 0.45, t + 0.15, Surf.StoneBrick, jitter(scaleHex(c.stone, 0.92), c.r, 0.05), { rz: a - Math.PI / 2 });
  }
  k.box(archX, 5.45, D / 2 - t / 2, 0.6, 0.7, t + 0.25, Surf.Carved, scaleHex(c.stone, 0.85));
  k.col(archX, 4.2, D / 2 - t / 2, 3.8, 1.9, t, true);
  // Columns: a standing pair with a lintel fragment, others fallen.
  const nCol = c.r.int(3, 5);
  for (let i = 0; i < nCol; i++) {
    const x = -W / 2 + 2 + (i * (W - 4)) / Math.max(1, nCol - 1);
    const z = c.r.range(-D * 0.2, D * 0.2);
    if (i < 2 && c.r.chance(0.7)) {
      piece(c, 'pillar', 'stone', [found], 1);
      const h = c.r.range(2.5, 4.5);
      k.cyl(x, 0, z, 0.38, 0.33, h, Surf.Marble, jitter(0xb8b2a4, c.r, 0.05), { seg: 10 });
      k.box(x, 0, z, 0.9, 0.3, 0.9, Surf.StoneBrick, c.stone);
      k.col(x, 0, z, 0.8, h, 0.8, true);
    } else {
      piece(c, 'pillar', 'stone');
      const a = c.r.range(0, Math.PI);
      const L = c.r.range(2, 3.5);
      const segs = c.r.int(2, 3);
      for (let s = 0; s < segs; s++) {
        const off = (s - (segs - 1) / 2) * (L / segs + 0.15);
        k.cyl(x + Math.cos(a) * off - Math.sin(a) * (L / segs / 2) * 0, 0.33, z + Math.sin(a) * off, 0.34, 0.34, L / segs, Surf.Marble, jitter(0xb0aa9c, c.r, 0.06), { rz: Math.PI / 2, ry: -a + c.r.range(-0.1, 0.1), seg: 10 });
      }
      k.col(x, 0, z, L, 0.7, 0.8, true, -a);
    }
  }
  // Rubble.
  for (let i = 0; i < 5; i++) rubblePile(c, c.r.range(-W * 0.6, W * 0.6), c.r.range(-D * 0.7, D * 0.7), c.r.range(0.8, 1.8));
  for (let i = 0; i < 6; i++) boulder(c, c.r.range(-W, W) * 0.7, 0.1, c.r.range(-D, D) * 0.9, c.r.range(0.3, 0.7));
  // Crypt entrance: low stone frame over steps descending into darkness.
  const [cx, cz] = plan.at.crypt;
  piece(c, 'deco', 'stone', [found], 1);
  for (const sx of [-1, 1]) k.solid(cx + sx * 1.1, 0, cz, 0.4, 1.4, 2.6, Surf.StoneBrick, scaleHex(c.stone, 0.9));
  k.solid(cx, 1.4, cz - 1.1, 2.6, 0.45, 0.5, Surf.Carved, scaleHex(c.stone, 0.8));
  for (let i = 0; i < 5; i++) k.box(cx, -0.05 - i * 0.18, cz + 1.0 - i * 0.4, 1.8, 0.06, 0.4, Surf.StoneBrick, scaleHex(c.stone, 0.75 - i * 0.1));
  k.box(cx, -1.05, cz - 0.9, 1.8, 1.0, 0.4, Surf.Window, 0x040405);
  k.box(cx, 0.02, cz - 0.5, 1.8, 0.02, 1.2, Surf.Window, 0x060607, { lod: 1 });
  k.light(cx, 0.4, cz - 0.6, 0x6080ff, 1.5, 4, true, 0.4);
}

function buildShrine(c: Ctx) {
  const { k, plan } = c;
  const marble = jitter(0xd8d2c4, c.r, 0.04);
  const R = 3.4;
  const plinth = piece(c, 'foundation', 'stone');
  for (let s = 0; s < 3; s++) {
    const rr = R + 1.2 - s * 0.45;
    if (plan.n.round) k.cyl(0, s === 0 ? c.g - 1.5 : s * 0.22 - 0.22, 0, rr, rr, s === 0 ? -c.g + 1.5 + 0.0 : 0.22, Surf.StoneBrick, scaleHex(marble, 0.92 - s * 0.03), { seg: 16 });
    else k.box(0, s === 0 ? c.g - 1.5 : s * 0.22 - 0.22, 0, rr * 2, s === 0 ? -c.g + 1.5 : 0.22, rr * 2, Surf.StoneBrick, scaleHex(marble, 0.92 - s * 0.03));
  }
  k.col(0, c.g - 1.5, 0, (R + 1.2) * 2, -c.g + 1.5 + 0.44, (R + 1.2) * 2, true);
  const top = 0.44;
  const cols: number[] = [];
  const nc = plan.n.cols;
  const ch = 3.6;
  for (let i = 0; i < nc; i++) {
    const a = (i / nc) * Math.PI * 2 + Math.PI / nc;
    const x = Math.sin(a) * R, z = Math.cos(a) * R;
    cols.push(piece(c, 'pillar', 'stone', [plinth], 1));
    k.box(x, top, z, 0.7, 0.25, 0.7, Surf.Marble, marble);
    k.cyl(x, top + 0.25, z, 0.26, 0.22, ch - 0.5, Surf.Marble, marble, { seg: 10 });
    k.box(x, top + ch - 0.25, z, 0.7, 0.25, 0.7, Surf.Marble, marble);
    k.col(x, top, z, 0.6, ch, 0.6, true);
  }
  piece(c, 'roof', 'stone', cols, Math.ceil(nc / 2));
  const ry = top + ch;
  if (plan.n.round) {
    k.cyl(0, ry, 0, R + 0.5, R + 0.5, 0.45, Surf.Marble, scaleHex(marble, 0.95), { seg: 16 });
    k.sphere(0, ry + 0.45, 0, R + 0.3, R * 0.7, R + 0.3, Surf.Slate, jitter(0x5a7a8a, c.r, 0.1), { lat0: 0, lat1: Math.PI / 2, seg: 16 });
    k.cyl(0, ry + 0.45 + R * 0.7 - 0.1, 0, 0.12, 0, 1.2, Surf.Metal, 0xc0a040, { seg: 6 });
  } else {
    k.box(0, ry, 0, (R + 0.5) * 2, 0.45, (R + 0.5) * 2, Surf.Marble, scaleHex(marble, 0.95));
    k.frustum(0, ry + 0.45, 0, (R + 0.8) * 2, (R + 0.8) * 2, 0, 0, R * 0.9, Surf.ClayTile, jitter(0x9a5a3a, c.r, 0.08));
  }
  // Altar, statue, candles, offerings.
  const [ax, az] = plan.at.altar;
  piece(c, 'furniture', 'stone', [plinth], 1);
  k.box(ax, top, az, 1.8, 0.9, 0.9, Surf.Marble, marble);
  k.box(ax, top + 0.9, az, 2.0, 0.08, 1.0, Surf.Marble, scaleHex(marble, 0.92));
  k.box(ax, top + 0.98, az, 0.5, 0.02, 1.15, Surf.Cloth, c.r.pick([0x8a2a2a, 0x2a4a7a, 0x6a2a6a]));
  for (let i = 0; i < 7; i++) {
    const x = ax + c.r.range(-0.85, 0.85), z = az + c.r.range(-0.35, 0.35);
    const h = c.r.range(0.08, 0.3);
    k.cyl(x, top + 0.98, z, 0.035, 0.035, h, Surf.Cloth, 0xf0e8d0, { seg: 5, lod: 1 });
    k.sphere(x, top + 1.0 + h + 0.03, z, 0.02, 0.035, 0.02, Surf.Fire, 0xffc060, { emit: 0xffa040, emitI: 4, seg: 4, lod: 1 });
  }
  for (let i = 0; i < 3; i++) k.cyl(ax - 0.6 + i * 0.6, top + 0.98, az + 0.3, 0.1, 0.07, 0.06, Surf.ClayTile, 0xa06040, { seg: 7, lod: 1 });
  k.col(ax, top, az, 1.8, 1.0, 0.9, true);
  k.light(ax, top + 1.5, az + 0.5, 0xffb060, 3.5, 7, false, 0.5);
  piece(c, 'deco', 'stone', [plinth], 1);
  k.box(ax, top, az - 1.2, 0.9, 0.7, 0.9, Surf.Marble, scaleHex(marble, 0.9));
  k.push(ax, top + 0.7, az - 1.2, 0);
  figure(k, 1.0, jitter(0xcac4b6, c.r, 0.04), c.r);
  k.pop();
  k.col(ax, top, az - 1.2, 0.9, 2.8, 0.9, true);
  // Flowers & offerings around the steps.
  piece(c, 'deco', 'plant');
  for (let i = 0; i < 10; i++) {
    const a = c.r.range(0, Math.PI * 2), d = R + c.r.range(1.3, 2.2);
    k.sphere(Math.cos(a) * d, 0.12, Math.sin(a) * d, 0.18, 0.14, 0.18, Surf.Leaf, c.r.pick([0xd04050, 0xe0c040, 0xc060c0, 0x4a8a3a, 0xf0f0f0]), { seg: 6, lod: 1 });
  }
}

function buildCamp(c: Ctx) {
  const { k, plan } = c;
  prop(c, 'campfire', 0, 0, 0, 1.1);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    prop(c, 'bench', Math.cos(a) * 2.6, Math.sin(a) * 2.6, -a + Math.PI / 2 + Math.PI, 0.8, { style: 'orcish' });
  }
  // Tents: A-frame hide tents & conical ones, opening toward the fire.
  for (let i = 0; i < plan.n.tents; i++) {
    const a = (i / plan.n.tents) * Math.PI * 2 + c.r.range(-0.3, 0.3);
    const d = c.r.range(6.5, 8.5);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const yaw = Math.atan2(-x, -z);
    const hide = jitter(0x8a7050, c.r, 0.12);
    if (c.r.chance(0.5)) {
      const poles = piece(c, 'deco', 'wood');
      k.push(x, 0, z, yaw);
      const L = 3.6, W = 2.6, H = 2.0;
      for (const sz of [-L / 2, L / 2]) {
        k.beam(-W / 2, 0, sz, 0, H, sz, 0.08, Surf.Bark, 0x5a4430);
        k.beam(W / 2, 0, sz, 0, H, sz, 0.08, Surf.Bark, 0x5a4430);
      }
      k.box(0, H - 0.05, 0, 0.1, 0.1, L + 0.4, Surf.Bark, 0x5a4430);
      k.pop();
      piece(c, 'deco', 'cloth', [poles], 1);
      k.push(x, 0, z, yaw);
      const sl = Math.hypot(W / 2, H);
      const ang = Math.atan2(W / 2, H);
      for (const sx of [-1, 1]) k.boxC((sx * W) / 4, H / 2, 0, 0.05, sl, L, Surf.Hide, scaleHex(hide, sx > 0 ? 1 : 0.92), { rz: sx * ang });
      k.box(0, 0.02, -L / 2 + 0.1, W * 0.8, 0.02, 0.4, Surf.Cloth, 0x6a3a2a, { lod: 2 });
      k.col(0, 0, 0, W, H, L, true);
      k.pop();
    } else {
      prop(c, 'tent', x, z, yaw, c.r.range(0.9, 1.2));
    }
  }
  // Racks, crates, barrels, a banner and a ring of sharpened stakes facing outward.
  prop(c, 'rack', -3.5, 4.2, 0.3);
  prop(c, 'banner', 4.2, -3.6, 0.6, 1.0);
  for (let i = 0; i < 4; i++) prop(c, c.r.pick(['crate', 'barrel', 'sacks'] as const), c.r.range(-5, 5), c.r.range(4, 6) * (c.r.chance(0.5) ? 1 : -1), c.r.range(0, 6.28));
  prop(c, 'woodpile', 5.5, 2, 1.2);
  piece(c, 'fence', 'wood');
  const ns = 14;
  for (let i = 0; i < ns; i++) {
    const a = (i / ns) * Math.PI * 1.6 + 1.0;
    const rr = 11;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    k.pole(x, -0.6, z, x + Math.cos(a) * 0.7, 1.6, z + Math.sin(a) * 0.7, 0.15, 0.0, Surf.Bark, jitter(0x8a6a48, c.r, 0.1), { seg: 6 });
    k.col(x, -0.2, z, 0.3, 1.4, 0.3, true);
  }
  k.smoke(0, 1.5, 0);
}

function buildLair(c: Ctx) {
  const { k, plan, R } = c;
  const [mx, mz] = plan.at.mouth;
  const dark = 0x7a746a;
  // Cave mouth: a dark interior hemisphere under an arch of piled boulders.
  const back = piece(c, 'foundation', 'stone');
  k.sphere(mx, -0.5, mz - 2, 6, 5.2, 4.5, Surf.Rubble, jitter(dark, c.r, 0.06), { seg: 14, lat0: 0, lat1: Math.PI / 2 + 0.2, smooth: false });
  k.col(mx, -0.5, mz - 2, 11, 5, 8, true);
  k.box(mx, 0, mz + 1.7, 4.2, 3.4, 0.4, Surf.Window, 0x030303);
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    piece(c, 'deco', 'stone', [back], 1);
    const s = c.r.range(0.9, 1.4);
    k.sphere(mx + Math.cos(a) * 3.2, Math.sin(a) * 3.6, mz + 2.1, s, s * 0.8, s, Surf.Rubble, jitter(0x6a665c, c.r, 0.08), { seg: 7, smooth: false, ry: c.r.range(0, 6) });
    k.col(mx + Math.cos(a) * 3.2, Math.sin(a) * 3.6 - s, mz + 2.1, s * 1.6, s * 1.6, s * 1.6, true);
  }
  // The skeleton of something enormous: a spine arching overhead, ribs curving down to the ground.
  const spineLen = R * 0.7;
  const bone = jitter(0xe0d6bc, c.r, 0.05);
  const z0 = R * 0.22;
  const spineY = (x: number) => 2.2 + 3.2 * Math.sin(((x + spineLen / 2) / spineLen) * Math.PI * 0.85);
  const spine = piece(c, 'deco', 'stone');
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const x0 = -spineLen / 2 + (i * spineLen) / segs, x1 = x0 + spineLen / segs;
    k.pole(x0, spineY(x0), z0, x1, spineY(x1), z0, 0.42 - i * 0.02, 0.4 - i * 0.02, Surf.Bone, bone, { seg: 7 });
    k.sphere(x1, spineY(x1) + 0.25, z0, 0.32, 0.45, 0.3, Surf.Bone, scaleHex(bone, 0.95), { seg: 6 });
  }
  // Tail dragging on the ground, skull lying at the head end.
  k.pole(-spineLen / 2, spineY(-spineLen / 2), z0, -spineLen / 2 - 5, 0.2, z0 + 1.5, 0.35, 0.1, Surf.Bone, bone, { seg: 6 });
  const hx = spineLen / 2 + 2.2;
  k.sphere(hx, 1.0, z0, 1.9, 1.2, 1.3, Surf.Bone, bone, { seg: 10 });
  k.frustum(hx + 1.6, 0.0, z0, 2.4, 1.6, 1.4, 0.9, 0.7, Surf.Bone, scaleHex(bone, 0.95), { rz: -Math.PI / 2 + 0.3 });
  for (const sz of [-0.6, 0.6]) {
    k.sphere(hx + 0.4, 1.35, z0 + sz * 1.3, 0.38, 0.38, 0.3, Surf.Window, 0x080606, { seg: 6 });
    k.pole(hx - 0.6, 1.8, z0 + sz * 1.0, hx - 2.4, 3.2, z0 + sz * 2.4, 0.3, 0.05, Surf.Bone, scaleHex(bone, 0.9), { seg: 6 });
  }
  k.col(0, 0, z0, spineLen + 4, 6, 1.2, false);
  k.col(hx, 0, z0, 3.8, 2.2, 2.6, true);
  const ribs = 7;
  for (let i = 0; i < ribs; i++) {
    const x = -spineLen / 2 + (i + 0.7) * (spineLen / ribs);
    const ys = spineY(x);
    const w = 1.6 + ys * 0.55;
    for (const sz of [-1, 1]) {
      if (c.r.chance(0.12)) continue; // a few ribs are broken away
      piece(c, 'deco', 'stone', [spine], 1);
      const p1: [number, number, number] = [x, ys, z0];
      const p2: [number, number, number] = [x + 0.2, ys * 0.92, z0 + sz * w * 0.6];
      const p3: [number, number, number] = [x + 0.4, ys * 0.55, z0 + sz * w];
      const p4: [number, number, number] = [x + 0.5, -0.2, z0 + sz * w * 0.85];
      k.pole(...p1, ...p2, 0.26, 0.24, Surf.Bone, bone, { seg: 6 });
      k.pole(...p2, ...p3, 0.24, 0.2, Surf.Bone, bone, { seg: 6 });
      k.pole(...p3, ...p4, 0.2, 0.1, Surf.Bone, bone, { seg: 6 });
      k.col(x + 0.4, 0, z0 + sz * w * 0.9, 0.6, ys * 0.6, 0.6, true);
    }
  }
  // Nest of branches & straw, egg or two.
  const [nx, nz] = plan.at.nest;
  piece(c, 'deco', 'plant');
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    k.pole(nx + Math.cos(a) * 2.4, 0.1, nz + Math.sin(a) * 2.4, nx + Math.cos(a + 1.2) * 2.2, c.r.range(0.4, 0.8), nz + Math.sin(a + 1.2) * 2.2, 0.08, 0.05, Surf.Bark, jitter(0x5a4a38, c.r, 0.15), { seg: 4 });
  }
  k.cyl(nx, -0.1, nz, 2.3, 2.0, 0.4, Surf.Straw, jitter(0xa08a50, c.r, 0.08), { seg: 12 });
  for (let i = 0; i < c.r.int(1, 3); i++) k.sphere(nx + c.r.range(-0.8, 0.8), 0.6, nz + c.r.range(-0.8, 0.8), 0.35, 0.45, 0.35, Surf.Marble, jitter(0xb8c0a0, c.r, 0.1), { seg: 8 });
  k.col(nx, 0, nz, 4.6, 0.7, 4.6, false);
  // Bone piles and skulls.
  for (let p = 0; p < 4; p++) {
    piece(c, 'deco', 'stone');
    const bx = c.r.range(-R * 0.6, R * 0.6), bz = c.r.range(-R * 0.5, R * 0.6);
    for (let i = 0; i < 8; i++) {
      const a = c.r.range(0, Math.PI * 2);
      k.pole(bx + c.r.range(-0.6, 0.6), 0.1, bz + c.r.range(-0.6, 0.6), bx + Math.cos(a), c.r.range(0.05, 0.4), bz + Math.sin(a), 0.06, 0.05, Surf.Bone, bone, { seg: 4, lod: 1 });
    }
    k.sphere(bx, 0.2, bz, 0.25, 0.22, 0.3, Surf.Bone, bone, { seg: 7 });
    k.sphere(bx + 0.07, 0.25, bz + 0.22, 0.06, 0.06, 0.03, Surf.Window, 0x050404, { seg: 4, lod: 1 });
    k.sphere(bx - 0.07, 0.25, bz + 0.22, 0.06, 0.06, 0.03, Surf.Window, 0x050404, { seg: 4, lod: 1 });
  }
  // Claw-raked rocks.
  for (let i = 0; i < 4; i++) {
    const x = c.r.range(-R * 0.7, R * 0.7), z = c.r.range(-R * 0.3, R * 0.7);
    const s = c.r.range(0.8, 1.4);
    boulder(c, x, s * 0.4, z, s, 0x6a665c);
    for (let j = 0; j < 3; j++) k.boxC(x + (j - 1) * 0.18, s * 0.6, z + s * 0.95, 0.05, s * 0.9, 0.04, Surf.Window, 0x1a1816, { rz: 0.35, lod: 1 });
  }
}

function buildGrove(c: Ctx) {
  const { k, plan } = c;
  const n = plan.n.trees;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + c.r.range(-0.15, 0.15);
    const d = c.r.range(8.5, 10.5);
    tree(c, Math.cos(a) * d, Math.sin(a) * d, c.r.range(14, 20), c.r.range(0.9, 1.3));
  }
  // Mossy altar stone with a glowing rune ring around it.
  const base = piece(c, 'foundation', 'stone');
  k.frustum(0, c.g - 1.5, 0, 3.4, 2.0, 3.0, 1.7, -c.g + 1.5 + 1.2, Surf.Rubble, jitter(0x7a7a6a, c.r, 0.06));
  k.box(0, 1.2, 0, 3.1, 0.14, 1.8, Surf.Turf, 0x5a8a3a);
  for (const sx of [-1, 1]) k.frustum(sx * 1.9, -0.2, -0.4, 0.9, 0.8, 0.5, 0.5, 2.6, Surf.Carved, jitter(0x7a7a6a, c.r, 0.05));
  k.box(0, 2.4, -0.4, 4.6, 0.5, 0.8, Surf.Carved, jitter(0x6e6e60, c.r, 0.05));
  k.col(0, c.g - 1.5, 0, 3.4, -c.g + 2.8, 2.0, true);
  piece(c, 'deco', 'crystal', [base], 1);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.box(Math.cos(a) * 3.2, 0.02, Math.sin(a) * 3.2, 0.5, 0.05, 0.15, Surf.Glow, 0x80ffd0, { ry: -a, emit: 0x60ffc0, emitI: 1.6 });
  }
  k.light(0, 1.6, 0, 0x80ffd0, 3, 9, true, 0.1);
  // Glowing mushrooms between the roots.
  for (let i = 0; i < 9; i++) {
    const a = c.r.range(0, Math.PI * 2), d = c.r.range(4, 12);
    prop(c, 'mushroom', Math.cos(a) * d, Math.sin(a) * d, c.r.range(0, 6.28), c.r.range(0.6, 1.3), { style: 'sylvan' });
  }
  // Ferns / undergrowth.
  piece(c, 'deco', 'plant');
  for (let i = 0; i < 16; i++) {
    const a = c.r.range(0, Math.PI * 2), d = c.r.range(3, 13);
    k.sphere(Math.cos(a) * d, 0.1, Math.sin(a) * d, c.r.range(0.4, 0.9), 0.35, c.r.range(0.4, 0.9), Surf.Leaf, jitter(0x4a7a36, c.r, 0.15), { seg: 6, lod: 1 });
  }
}

function buildMonolith(c: Ctx) {
  const { k, plan } = c;
  const H = plan.n.h;
  const glow = c.r.pick([0x9a60ff, 0x60c0ff, 0x60ffb0]);
  const base = piece(c, 'foundation', 'stone');
  k.cyl(0, c.g - 1.5, 0, 3.4, 3.2, -c.g + 1.5 + 0.35, Surf.Basalt, 0x2a2a2e, { seg: 10 });
  k.col(0, c.g - 1.5, 0, 5.6, -c.g + 1.85, 5.6, true);
  const mono = piece(c, 'spire', 'stone', [base], 1);
  k.frustum(0, 0.35, 0, 2.2, 1.5, 1.2, 0.8, H, Surf.Basalt, 0x1e1c22, { rz: c.r.range(-0.03, 0.03) });
  k.frustum(0, 0.35 + H, 0, 1.2, 0.8, 0.0, 0.0, 1.4, Surf.Basalt, 0x24222a);
  k.col(0, 0.35, 0, 2.2, H + 1.2, 1.5, true);
  void mono;
  // Rune bands on the faces (emissive, always on, brighter at night via bloom).
  for (let i = 0; i < 6; i++) {
    const y = 1.4 + i * (H - 2) / 5;
    const f = 1 - (y - 0.35) / H;
    const w = 2.2 * f + 1.2 * (1 - f), d = 1.5 * f + 0.8 * (1 - f);
    for (let j = 0; j < 4; j++) {
      const gx = (j - 1.5) * (w / 5);
      k.box(gx, y + c.r.range(-0.2, 0.2), d / 2 + 0.01, w / 7, c.r.range(0.25, 0.55), 0.03, Surf.Glow, glow, { emit: glow, emitI: 1.8 });
      k.box(gx, y + c.r.range(-0.2, 0.2), -d / 2 - 0.01, w / 7, c.r.range(0.25, 0.55), 0.03, Surf.Glow, glow, { emit: glow, emitI: 1.8 });
    }
  }
  k.light(0, 2.5, 1.8, glow, 3, 10, false, 0.15);
  k.light(0, H * 0.7, -1.8, glow, 2.5, 10, true, 0.15);
  // Ring of lesser stones.
  for (let i = 0; i < plan.n.stones; i++) {
    const a = (i / plan.n.stones) * Math.PI * 2;
    prop(c, 'standing_stone', Math.cos(a) * 9, Math.sin(a) * 9, -a + Math.PI / 2, c.r.range(0.7, 1.05));
  }
}

function buildTower(c: Ctx) {
  const { k, plan } = c;
  const stone = jitter(0x8a867c, c.r, 0.06);
  const glow = c.r.pick([0xb080ff, 0xffb060, 0x80c0ff]);
  const ruined = plan.n.ruined === 1;
  const out = buildRound(k, {
    r: plan.n.r,
    floors: plan.n.floors,
    storey: plan.n.storey,
    wallT: 0.7,
    scale: 1,
    ground: c.l.structure.ground ?? [0, 0, 0, 0],
    plinth: 0.4,
    baseSurf: Surf.Rubble,
    baseCol: scaleHex(stone, 0.85),
    walls: [{ surf: Surf.StoneBrick, col: stone }],
    floorSurf: Surf.Planks,
    floorCol: 0x6a5038,
    door: { x: 0, w: 1.2, h: 2.3, surf: Surf.Planks, col: 0x4a3424, frameSurf: Surf.StoneBrick, frameCol: scaleHex(stone, 0.85), arch: true, bands: true },
    win: { shape: 'arch', w: 0.6, h: 1.3, sill: 1.2, spacing: 3, frameSurf: Surf.StoneBrick, frameCol: scaleHex(stone, 0.8), shutterCol: null, glassCol: 0x5a6878, glow, lit: ruined ? 1.6 : 3, flowerbox: false },
    roof: { kind: ruined ? 'flat' : 'conical', pitch: 1.8, overhang: 0.5, surf: Surf.Slate, col: jitter(0x3e4458, c.r, 0.08), thick: 0.2, trimSurf: Surf.Carved, trimCol: scaleHex(stone, 0.8), dormers: 0, finial: !ruined, crenel: true },
    seg: 12,
    taper: 0.9,
    stairs: true,
    platform: false,
  });
  if (ruined) {
    // Broken crown: jagged wall stubs and fallen masonry around the base.
    piece(c, 'wall', 'stone', out.walls[out.walls.length - 1], 1);
    const rt = plan.n.r * 0.9;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const h = c.r.chance(0.35) ? 0 : c.r.range(0.4, 2.6);
      if (!h) continue;
      k.push(Math.sin(a) * (rt - 0.35), out.wallTop + 0.3, Math.cos(a) * (rt - 0.35), a);
      k.solid(0, 0, 0, 2 * rt * Math.sin(Math.PI / 12) + 0.05, h, 0.7, Surf.StoneBrick, stone);
      k.pop();
    }
    for (let i = 0; i < 5; i++) {
      const a = c.r.range(0, Math.PI * 2);
      rubblePile(c, Math.cos(a) * (plan.n.r + c.r.range(1.5, 4)), Math.sin(a) * (plan.n.r + c.r.range(1.5, 4)), c.r.range(0.8, 1.5));
    }
    piece(c, 'deco', 'plant');
    for (let i = 0; i < 6; i++) {
      const a = c.r.range(0, Math.PI * 2);
      k.push(Math.sin(a) * (plan.n.r + 0.02), 0, Math.cos(a) * (plan.n.r + 0.02), a);
      ivy(c, 0, c.r.range(4, out.wallTop), 0, c.r.range(1, 2));
      k.pop();
    }
  } else {
    // Wizard's study: a glowing orb atop the roof spire and a lit lantern by the door.
    k.use(out.roof);
    k.sphere(0, out.ridge + 0.9, 0, 0.3, 0.3, 0.3, Surf.Crystal, glow, { emit: glow, emitI: 4, seg: 8 });
    k.light(0, out.ridge + 1.0, 0, glow, 4, 14, true, 0.2);
  }
  // Furnish the floors: desk & bookcase on the second storey, bed above.
  const desk = piece(c, 'furniture', 'wood', [out.slabs[0] ?? out.found], 1);
  const y1 = plan.n.storey;
  k.box(0, y1, -1.2, 1.3, 0.75, 0.7, Surf.Planks, 0x6a5038, { lod: 2 });
  k.box(-1.2, y1, -0.5, 0.45, 2.0, 1.3, Surf.Planks, 0x5a4430, { lod: 2 });
  k.sphere(0.3, y1 + 0.9, -1.2, 0.14, 0.14, 0.14, Surf.Crystal, glow, { emit: glow, emitI: 3, seg: 6, lod: 2 });
  k.light(0, y1 + 1.5, 0, glow, 3, 7, false, 0.15);
  void desk;
}

function buildBattlefield(c: Ctx) {
  const { k, plan, R } = c;
  const pos = () => {
    const a = c.r.range(0, Math.PI * 2), d = Math.sqrt(c.r.float()) * R * 0.85;
    return [Math.cos(a) * d, Math.sin(a) * d] as [number, number];
  };
  for (let i = 0; i < plan.n.count; i++) {
    const [x, z] = pos();
    const what = c.r.int(0, 7);
    if (what <= 2) {
      // Weapons stuck in the ground at angles.
      piece(c, 'deco', 'metal');
      for (let j = 0; j < c.r.int(2, 5); j++) {
        const ox = x + c.r.range(-1.2, 1.2), oz = z + c.r.range(-1.2, 1.2);
        const lean = c.r.range(-0.4, 0.4), ry = c.r.range(0, 6.28);
        if (c.r.chance(0.5)) {
          // Spear.
          k.cyl(ox, -0.3, oz, 0.03, 0.03, 2.6, Surf.Timber, 0x5a4430, { rz: lean, ry, seg: 5 });
        } else {
          // Sword: blade + crossguard + grip.
          k.push(ox, 0, oz, ry);
          k.boxC(0, 0.35, 0, 0.07, 1.0, 0.02, Surf.Metal, 0x9a9a9e, { rz: lean });
          k.boxC(-Math.sin(lean) * 0.9, 0.85 + 0.0, 0, 0.32, 0.05, 0.05, Surf.Metal, 0x6a5a40, { rz: lean });
          k.boxC(-Math.sin(lean) * 1.05, 1.0, 0, 0.04, 0.2, 0.04, Surf.Hide, 0x3a2a1e, { rz: lean });
          k.pop();
        }
      }
      k.col(x, 0, z, 2, 1.6, 2, false);
    } else if (what === 3) {
      // Fallen shields.
      piece(c, 'deco', 'wood');
      for (let j = 0; j < c.r.int(1, 3); j++) k.cyl(x + c.r.range(-1, 1), 0.02, z + c.r.range(-1, 1), 0.38, 0.38, 0.05, Surf.Planks, jitter(c.her.field, c.r, 0.2), { seg: 10, rx: c.r.range(-0.4, 0.4), rz: c.r.range(-0.4, 0.4) });
    } else if (what === 4) {
      // Cairn.
      piece(c, 'deco', 'stone');
      for (let j = 0; j < 7; j++) k.sphere(x + c.r.range(-0.4, 0.4), 0.15 + j * 0.18, z + c.r.range(-0.4, 0.4), 0.45 - j * 0.04, 0.22, 0.4 - j * 0.04, Surf.Rubble, jitter(0x8a867c, c.r, 0.1), { seg: 6, smooth: false });
      k.col(x, 0, z, 1, 1.4, 1, true);
    } else if (what === 5) {
      prop(c, 'grave', x, z, c.r.range(0, 6.28));
    } else if (what === 6) {
      // Shattered palisade: a few leaning stakes.
      piece(c, 'fence', 'wood');
      const a = c.r.range(0, Math.PI);
      for (let j = 0; j < 6; j++) {
        const ox = x + Math.cos(a) * (j - 2.5) * 0.5, oz = z + Math.sin(a) * (j - 2.5) * 0.5;
        const h = c.r.range(0.6, 2.4);
        k.cyl(ox, -0.4, oz, 0.13, c.r.chance(0.6) ? 0.11 : 0.0, h, Surf.Bark, jitter(0x4e3c2a, c.r, 0.1), { seg: 5, rz: c.r.range(-0.5, 0.5), rx: c.r.range(-0.3, 0.3) });
      }
      k.col(x, 0, z, 3, 1.5, 0.5, true, -a);
    } else {
      // Burnt wreckage with smouldering embers.
      piece(c, 'deco', 'wood');
      for (let j = 0; j < 6; j++) k.boxC(x + c.r.range(-1.2, 1.2), 0.15, z + c.r.range(-1.2, 1.2), c.r.range(1, 2.4), 0.15, 0.25, Surf.Planks, jitter(0x1e1a16, c.r, 0.2), { ry: c.r.range(0, 6.28), rz: c.r.range(-0.3, 0.3) });
      k.box(x, 0, z, 0.8, 0.05, 0.8, Surf.Fire, 0xff6a20, { emit: 0xff3a10, emitI: 1.2 });
      k.smoke(x, 0.6, z);
      k.light(x, 0.5, z, 0xff6020, 1.5, 4, true, 1);
      k.col(x, 0, z, 2.4, 0.5, 2.4, false);
    }
  }
  // Scorched earth where fires burned.
  piece(c, 'deco', 'stone');
  for (let i = 0; i < 6; i++) {
    const [x, z] = pos();
    k.cyl(x, -0.05, z, c.r.range(1.5, 3.5), c.r.range(1.5, 3.5), 0.1, Surf.Soil, 0x241e18, { seg: 10, sx: c.r.range(0.7, 1.3), lod: 1 });
  }
  // A wrecked catapult: frame, broken throwing arm, a shattered wheel.
  {
    const [x, z] = pos();
    const wood = jitter(0x4e3a28, c.r, 0.1);
    piece(c, 'deco', 'wood');
    k.push(x, 0, z, c.r.range(0, 6.28));
    for (const sx of [-1, 1]) {
      k.box(sx * 1.0, 0.3, 0, 0.3, 0.3, 4.2, Surf.Timber, wood);
      k.beam(sx * 1.0, 0.6, -0.6, sx * 0.4, 2.4, 0.2, 0.22, Surf.Timber, wood);
    }
    k.box(0, 0.45, 1.6, 2.3, 0.25, 0.3, Surf.Timber, wood);
    k.box(0, 2.3, 0.2, 2.3, 0.3, 0.3, Surf.Timber, wood);
    k.beam(0, 2.3, 0.2, 0.4, 0.2, 3.6, 0.25, Surf.Timber, scaleHex(wood, 0.8));
    k.cyl(1.25, 0.6, -1.4, 0.65, 0.65, 0.15, Surf.Planks, wood, { rz: Math.PI / 2, seg: 10 });
    k.cyl(-1.9, 0.08, -1.0, 0.65, 0.65, 0.15, Surf.Planks, scaleHex(wood, 0.7), { seg: 10, rx: 0.1 });
    k.col(0, 0, 0, 2.6, 2.5, 4.4, true);
    k.pop();
  }
  // Broken carts and impaled banners.
  for (let i = 0; i < 2; i++) {
    const [x, z] = pos();
    prop(c, 'cart', x, z, c.r.range(0, 6.28));
  }
  for (let i = 0; i < 5; i++) {
    const [x, z] = pos();
    piece(c, 'deco', 'cloth');
    const lean = c.r.range(-0.3, 0.3);
    k.push(x, 0, z, c.r.range(0, 6.28));
    k.cyl(0, -0.5, 0, 0.06, 0.05, 4.2, Surf.Timber, 0x4a3828, { rz: lean, seg: 5 });
    k.push(-Math.sin(lean) * 3.2, 3.6, 0.1, 0);
    heraldicPanel(k, i % 2 ? c.her : { ...c.her, field: 0x2a2a2a, field2: 0x6a1a1a }, 0.9, 1.4, -1.4, 0.03, 0);
    k.pop();
    k.pop();
    k.col(x, 0, z, 0.3, 3.8, 0.3, true);
  }
}

function buildCrash(c: Ctx) {
  const { k, plan } = c;
  const C = plan.n.crater;
  const glow = c.r.pick([0x60e0ff, 0xb070ff, 0x70ffb0]);
  // Crater floor and rim of thrown-up rock slabs tilted outward.
  const floor = piece(c, 'foundation', 'stone');
  k.cyl(0, -0.9, 0, C * 0.8, C * 0.95, 0.75, Surf.Rubble, 0x3a3632, { seg: 18 });
  k.cyl(0, -0.02, 0, C * 0.85, C * 0.85, 0.08, Surf.Soil, 0x2a2420, { seg: 18, lod: 1 });
  k.cyl(0, 0.0, 0, C * 0.45, C * 0.45, 0.1, Surf.Basalt, 0x161212, { seg: 16, lod: 1 });
  // Ejecta berm: a ring of flattened earth mounds outside the rim.
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const rr = C + 1.4 + c.r.range(-0.4, 0.4);
    const s0 = c.r.range(1.6, 2.2);
    k.sphere(Math.cos(a) * rr, -0.25, Math.sin(a) * rr, s0, c.r.range(0.6, 0.95), s0, Surf.Soil, jitter(0x6a5844, c.r, 0.06), { seg: 9 });
  }
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + c.r.range(-0.1, 0.1);
    piece(c, 'deco', 'stone');
    const s = c.r.range(0.9, 1.8);
    k.push(Math.cos(a) * C, 0, Math.sin(a) * C, -a + Math.PI / 2);
    k.boxC(0, s * 0.45, 0, s * 1.6, s * 1.3, s * 0.5, Surf.Rubble, jitter(0x6a6660, c.r, 0.1), { rx: c.r.range(0.25, 0.6), rz: c.r.range(-0.25, 0.25) });
    k.col(0, 0, 0, s * 1.6, s * 0.9, s, true);
    k.pop();
  }
  // Twisted hull ribs of a sky-ship, half buried and tilted.
  const hull = piece(c, 'deco', 'metal', [floor], 1);
  const tilt = c.r.range(0.2, 0.45);
  k.push(0, 0, 0, c.r.range(0, 6.28));
  k.pole(-6, 0.2, 0, 5, 1.4 + tilt * 4, 0, 0.35, 0.3, Surf.Planks, 0x4a3828, { seg: 7 });
  for (let i = 0; i < 7; i++) {
    const x = -5 + i * 1.6;
    const yb = 0.2 + (i / 7) * tilt * 5;
    const bend = c.r.range(-0.5, 0.5);
    for (const sz of [-1, 1]) {
      if (c.r.chance(0.2)) continue;
      k.pole(x, yb, 0, x + bend, yb + 2.4, sz * 2.0, 0.22, 0.18, Surf.Timber, jitter(0x5a4430, c.r, 0.12), { seg: 6 });
      k.pole(x + bend, yb + 2.4, sz * 2.0, x + bend * 1.6, yb + 3.6 + c.r.range(-1, 1), sz * 1.0, 0.18, 0.08, Surf.Metal, jitter(0x8a6a40, c.r, 0.15), { seg: 6 });
    }
  }
  // Torn hull plating & a snapped mast with tattered sail.
  for (let i = 0; i < 5; i++) k.boxC(c.r.range(-5, 4), c.r.range(0.5, 2.5), c.r.range(-1.8, 1.8), c.r.range(1.2, 2.4), 0.06, c.r.range(0.8, 1.6), Surf.Planks, jitter(0x5a4430, c.r, 0.12), { rx: c.r.range(-1, 1), rz: c.r.range(-1, 1) });
  k.pole(1, 1, 0, 3.5, 6.5, 1.5, 0.18, 0.12, Surf.Timber, 0x4a3424, { seg: 6 });
  k.boxC(3.0, 5.0, 1.0, 0.04, 2.5, 2.2, Surf.Cloth, 0xc8bca0, { rz: 0.4, rx: 0.2 });
  k.col(0, 0, 0, 12, 3, 4.5, true);
  k.pop();
  // The cracked crystal heart and scattered glowing shards.
  piece(c, 'deco', 'crystal', [hull], 0);
  for (let i = 0; i < 5; i++) {
    const a = c.r.range(0, Math.PI * 2), d = i === 0 ? 0 : c.r.range(0.4, 1.1);
    k.cyl(Math.cos(a) * d, -0.3, Math.sin(a) * d, 0.35, 0, i === 0 ? 3.2 : c.r.range(1.2, 2.2), Surf.Crystal, glow, { seg: 6, rx: i ? c.r.range(-0.5, 0.5) : 0.15, rz: i ? c.r.range(-0.5, 0.5) : -0.1, emit: glow, emitI: 3.5 });
  }
  k.col(0, 0, 0, 1.6, 3, 1.6, true);
  k.light(0, 1.6, 0, glow, 8, 18, false, 0.25);
  for (let i = 0; i < 10; i++) {
    const a = c.r.range(0, Math.PI * 2), d = c.r.range(2, C * 1.4);
    piece(c, 'deco', 'crystal');
    k.cyl(Math.cos(a) * d, -0.2, Math.sin(a) * d, c.r.range(0.08, 0.2), 0, c.r.range(0.4, 1.1), Surf.Crystal, glow, { seg: 5, rx: c.r.range(-0.6, 0.6), rz: c.r.range(-0.6, 0.6), emit: glow, emitI: 3 });
  }
  k.smoke(-2, 2, 0.5);
  k.smoke(2.5, 1.5, -0.6);
}

function buildWell(c: Ctx) {
  const { k } = c;
  const stone = jitter(0x8a867c, c.r, 0.06);
  const ring = piece(c, 'foundation', 'stone');
  k.cyl(0, c.g - 1.5, 0, 1.15, 1.15, -c.g + 1.5 + 0.95, Surf.Rubble, stone, { seg: 12 });
  k.cyl(0, 0.95, 0, 1.25, 1.25, 0.14, Surf.StoneBrick, scaleHex(stone, 0.9), { seg: 12 });
  k.cyl(0, 0.5, 0, 0.9, 0.9, 0.05, Surf.Window, 0x0e1a20, { seg: 12 });
  k.col(0, c.g - 1.5, 0, 2.3, -c.g + 2.6, 2.3, true);
  // One post standing, one leaning; roof slab fallen beside.
  const post = piece(c, 'pillar', 'wood', [ring], 1);
  k.box(-1.15, 0.9, 0, 0.16, 1.9, 0.16, Surf.Timber, 0x4a3828);
  k.boxC(1.3, 1.6, 0.1, 0.16, 1.9, 0.16, Surf.Timber, 0x4a3828, { rz: -0.35 });
  k.cyl(-1.1, 2.4, 0, 0.08, 0.08, 1.4, Surf.Timber, 0x4a3828, { rz: -Math.PI / 2 - 0.12, seg: 6 });
  k.box(-0.2, 1.3, 0, 0.02, 1.0, 0.02, Surf.Rope, 0x8a6a3a, { lod: 1 });
  piece(c, 'roof', 'wood', [post], 1);
  // Half the roof slumped from the standing post down to the ground.
  k.boxC(0.35, 1.5, 0.25, 3.6, 0.08, 1.4, Surf.Shingle, jitter(0x5a4a3a, c.r, 0.1), { rz: -0.72, rx: 0.12 });
  piece(c, 'deco', 'wood');
  k.boxC(2.3, 0.3, 1.4, 2.6, 0.08, 1.3, Surf.Shingle, jitter(0x5a4a3a, c.r, 0.1), { rx: 0.15, rz: 0.4, ry: 0.6 });
  k.cyl(1.6, 0, -1.2, 0.18, 0.22, 0.28, Surf.Planks, 0x6a5038, { seg: 8, rz: 1.4 });
  // Ivy and undergrowth.
  piece(c, 'deco', 'plant');
  for (let i = 0; i < 8; i++) {
    const a = c.r.range(0, Math.PI * 2);
    k.sphere(Math.cos(a) * 1.3, c.r.range(0.2, 0.8), Math.sin(a) * 1.3, 0.35, c.r.range(0.25, 0.5), 0.3, Surf.Leaf, jitter(0x3e6a2e, c.r, 0.15), { seg: 6, lod: 1 });
  }
  for (let i = 0; i < 6; i++) {
    const a = c.r.range(0, Math.PI * 2), d = c.r.range(1.8, 3.5);
    k.sphere(Math.cos(a) * d, 0.1, Math.sin(a) * d, c.r.range(0.3, 0.6), 0.3, c.r.range(0.3, 0.6), Surf.Leaf, jitter(0x4a7a36, c.r, 0.15), { seg: 6, lod: 1 });
  }
}

function buildWayshrine(c: Ctx) {
  const { k } = c;
  const stone = c.r.chance(0.5);
  const base = piece(c, 'foundation', 'stone');
  k.box(0, c.g - 1.2, 0, 1.0, -c.g + 1.2 + 0.25, 1.0, Surf.Rubble, jitter(0x8a867c, c.r, 0.06));
  k.col(0, c.g - 1.2, 0, 1.0, -c.g + 1.45, 1.0, true);
  const post = piece(c, 'pillar', stone ? 'stone' : 'wood', [base], 1);
  if (stone) k.box(0, 0.25, 0, 0.45, 1.5, 0.45, Surf.StoneBrick, jitter(0x9a948a, c.r, 0.05));
  else k.box(0, 0.25, 0, 0.22, 1.5, 0.22, Surf.Timber, 0x4a3828);
  k.col(0, 0.25, 0, 0.45, 1.5, 0.45, true);
  piece(c, 'deco', 'wood', [post], 1);
  // Niche box with a little roof, saint statuette, candle.
  k.box(0, 1.75, 0, 0.9, 0.08, 0.7, Surf.Planks, 0x5a4430);
  for (const sx of [-1, 1]) k.box(sx * 0.42, 1.83, 0, 0.06, 0.8, 0.6, Surf.Planks, 0x5a4430);
  k.box(0, 1.83, -0.3, 0.9, 0.8, 0.06, Surf.Planks, 0x4e3a28);
  for (const sz of [1, -1]) k.boxC(0, 2.75, sz * 0.25, 1.15, 0.06, 0.65, Surf.Shingle, jitter(0x6a4e38, c.r, 0.1), { rx: sz * 0.7 });
  k.push(0, 1.83, -0.08, 0);
  figure(k, 0.3, jitter(0xd8d0c0, c.r, 0.05), c.r);
  k.pop();
  k.cyl(0.25, 1.83, 0.18, 0.025, 0.025, 0.12, Surf.Cloth, 0xf0e8d0, { seg: 5 });
  k.sphere(0.25, 1.98, 0.18, 0.015, 0.03, 0.015, Surf.Fire, 0xffc060, { emit: 0xffa040, emitI: 5, seg: 4 });
  k.light(0.25, 2.05, 0.3, 0xffb060, 2, 5, true, 0.6);
  // Offering bowl & flowers at the foot.
  piece(c, 'deco', 'stone', [base], 1);
  k.cyl(0, 0.25, 0.65, 0.2, 0.14, 0.12, Surf.ClayTile, 0xa06040, { seg: 8 });
  for (let i = 0; i < 6; i++) k.sphere(c.r.range(-0.6, 0.6), 0.12, c.r.range(0.4, 0.9), 0.1, 0.1, 0.1, Surf.Leaf, c.r.pick([0xd04050, 0xe0c040, 0xc060c0, 0xf0f0f0]), { seg: 5, lod: 1 });
}

function buildObelisk(c: Ctx) {
  const { k } = c;
  const stone = c.r.pick([0x2a2830, 0x8a8478, 0x5a4a3e]);
  const glow = c.r.pick([0xffc060, 0x70d0ff, 0xb080ff]);
  const base = piece(c, 'foundation', 'stone');
  for (let s = 0; s < 3; s++) {
    const w = 4.6 - s * 1.1;
    k.box(0, s === 0 ? c.g - 1.5 : s * 0.5 - 0.5 + 0.0, 0, w, s === 0 ? -c.g + 1.5 + 0.5 : 0.5, w, Surf.StoneBrick, scaleHex(stone, 1.15 - s * 0.05));
  }
  k.col(0, c.g - 1.5, 0, 4.6, -c.g + 1.5 + 1.5, 4.6, true);
  piece(c, 'spire', 'stone', [base], 1);
  const H = c.r.range(9, 13);
  k.frustum(0, 1.5, 0, 1.3, 1.3, 0.7, 0.7, H, Surf.Marble, stone);
  k.frustum(0, 1.5 + H, 0, 0.7, 0.7, 0, 0, 0.9, Surf.Metal, 0xc0a040);
  k.col(0, 1.5, 0, 1.3, H + 0.9, 1.3, true);
  for (let i = 0; i < 5; i++) {
    const y = 2.5 + i * (H - 2) / 5;
    const f = (y - 1.5) / H;
    const w = 1.3 * (1 - f) + 0.7 * f;
    for (let side = 0; side < 4; side++) {
      k.push(0, 0, 0, (side * Math.PI) / 2);
      k.box(0, y, w / 2 + 0.01, w * 0.7, 0.35, 0.02, Surf.Glow, glow, { emit: glow, emitI: 2 });
      k.pop();
    }
  }
  k.light(0, 3, 1.4, glow, 3, 9, true, 0.1);
}

// ------------------------------------------------------------------ entry

export function buildPoiStructure(k: Kit, l: PoiLayout) {
  const plan = poiPlan(l);
  const g = Math.min(0, ...(l.structure.ground ?? [0, 0, 0, 0]));
  const c: Ctx = {
    k, l, plan, r: k.rng, R: l.structure.size[0] / 2, g, her: makeHeraldry(k.rng.pick(['human', 'orc', 'dwarf', 'elf'] as const), new Rng(deriveSeed(l.structure.seed, 'her'))),
    stone: jitter(0x8a867c, k.rng, 0.06), propN: 0,
  };
  switch (l.kind) {
    case 'ruin':
      return buildRuin(c);
    case 'shrine':
      return buildShrine(c);
    case 'camp':
      return buildCamp(c);
    case 'lair':
      return buildLair(c);
    case 'grove':
      return buildGrove(c);
    case 'monolith':
      return buildMonolith(c);
    case 'tower':
      return buildTower(c);
    case 'battlefield':
      return buildBattlefield(c);
    case 'crashsite':
      return buildCrash(c);
    case 'well':
      return buildWell(c);
    case 'wayshrine':
      return buildWayshrine(c);
    case 'obelisk':
      return buildObelisk(c);
    default:
      return buildMonolith(c);
  }
}
