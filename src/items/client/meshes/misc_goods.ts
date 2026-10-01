/**
 * Crafted goods: potions & vials, scrolls, books, keys, letters, relics,
 * trinkets and coins. Origin = resting base, +Y up.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../types';
import type { ItemMatKit } from '../materials';
import type { Rng } from '../../../core/rng';
import { styleOf } from '../../data/styles';
import { lathe, mesh, cyl, tube, extrudeOutline, type V2 } from './util';
import { stdMat, glassVessel, cork, glowMat, lumpGeometry, col, leafGeometry, sack, type RGB } from './misc_common';

export function buildGoods(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng): THREE.Object3D | null {
  if (shape.startsWith('potion.')) return potion(shape, v, kit, rng);
  switch (shape) {
    case 'mat.essence': return essence(v, kit, rng);
    case 'scroll': return scroll(v, kit, rng);
    case 'book': return book(v, kit, rng, 'book');
    case 'tome': return book(v, kit, rng, 'tome');
    case 'book.small': return book(v, kit, rng, 'small');
    case 'key': return key(v, kit, rng);
    case 'letter': return letter(v, kit, rng);
    case 'relic': return relic(v, kit, rng);
    case 'trinket.charm': return charm(v, kit, rng);
    case 'trinket.idol': return idol(v, kit, rng);
    case 'trinket.compass': return compass(v, kit, rng);
    case 'trinket.coin': return bigCoin(v, kit, rng);
    case 'trinket.totem': return totem(v, kit, rng);
    case 'trinket.orb': return orb(v, kit, rng);
    case 'trinket.hourglass': return hourglass(v, kit, rng);
    case 'trinket.box': return musicBox(v, kit, rng);
    case 'coins': return coins(v, kit, rng);
  }
  return null;
}

// ------------------------------------------------------------------ potions

function potionProfile(shape: string, rng: Rng): { prof: V2[]; top: number; neckR: number; liquidTop: number } {
  const k = rng.range(0.92, 1.08);
  switch (shape) {
    case 'potion.flask': {
      // Conical alchemist's flask.
      const r = 0.05 * k, h = 0.13 * k;
      return { prof: [[0.001, 0], [r * 0.9, 0], [r, 0.006], [r * 0.95, h * 0.18], [r * 0.38, h * 0.68], [r * 0.3, h * 0.72], [r * 0.3, h * 0.95], [r * 0.38, h], [r * 0.32, h]], top: h, neckR: r * 0.3, liquidTop: h * 0.6 };
    }
    case 'potion.tall': {
      const r = 0.026 * k, h = 0.16 * k;
      return { prof: [[0.001, 0], [r * 0.9, 0], [r, 0.005], [r, h * 0.68], [r * 0.7, h * 0.76], [r * 0.45, h * 0.8], [r * 0.45, h * 0.96], [r * 0.55, h], [r * 0.48, h]], top: h, neckR: r * 0.45, liquidTop: h * 0.72 };
    }
    case 'potion.vial': {
      const r = 0.012 * k, h = 0.09 * k;
      return { prof: [[0.001, 0], [r * 0.7, 0.001], [r, r * 0.6], [r, h * 0.92], [r * 1.25, h * 0.95], [r * 1.2, h], [r, h]], top: h, neckR: r, liquidTop: h * 0.9 };
    }
    case 'potion.bottle': {
      // Wine bottle with punted base and long neck.
      const r = 0.034 * k, h = 0.26 * k;
      return { prof: [[0.001, 0.012], [r * 0.85, 0.002], [r, 0.008], [r, h * 0.6], [r * 0.7, h * 0.7], [r * 0.38, h * 0.78], [r * 0.34, h * 0.95], [r * 0.42, h * 0.97], [r * 0.4, h], [r * 0.32, h]], top: h, neckR: r * 0.34, liquidTop: h * 0.75 };
    }
    default: {
      // potion.round: bulbous flask with narrow neck.
      const r = 0.042 * k, h = 0.12 * k;
      const prof: V2[] = [[0.001, 0.004], [r * 0.5, 0]];
      for (let i = 1; i <= 7; i++) {
        const a = -Math.PI / 2 + (i / 8) * Math.PI * 0.86;
        prof.push([Math.cos(a) * r, r + Math.sin(a) * r]);
      }
      prof.push([r * 0.3, r * 2.05], [r * 0.3, h * 0.95], [r * 0.4, h], [r * 0.32, h]);
      return { prof, top: h, neckR: r * 0.3, liquidTop: r * 1.8 };
    }
  }
}

function potion(shape: string, v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const { prof, top, neckR, liquidTop } = potionProfile(shape, rng);
  const liq = kit.custom('potion', () => new THREE.MeshStandardMaterial({
    color: col(v.primary), roughness: 0.12, transparent: true, opacity: 0.9, emissive: col(v.glow > 0 ? v.glowColor : v.primary), emissiveIntensity: 0.06 + v.glow * 0.45,
  }));
  g.add(glassVessel(kit, prof, shape === 'potion.bottle' ? 0.9 : rng.range(0.75, 0.95), liquidTop, 18, liq));
  // Stopper: cork for most, wax-dipped for bottles.
  const ck = cork(kit, neckR * 1.05, top - 0.004, shape === 'potion.vial' ? 0.014 : 0.022);
  g.add(ck);
  if (shape === 'potion.bottle') {
    const wax = stdMat(kit, 'wax', [0.55, 0.05, 0.06], { roughness: 0.3 });
    g.add(mesh(lathe([[neckR * 1.25, top - 0.03], [neckR * 1.3, top - 0.005], [neckR * 1.2, top + 0.016], [0.001, top + 0.02]], 12), wax));
  } else if (rng.chance(0.6) && shape !== 'potion.vial') {
    // Wax drip seal over the cork.
    const wax = stdMat(kit, 'dripwax', v.accent, { roughness: 0.35 });
    g.add(mesh(lathe([[neckR * 1.15, top - 0.008], [neckR * 1.18, top + 0.008], [neckR * 0.9, top + 0.02], [0.001, top + 0.021]], 10), wax));
  }
  // Paper label around the belly (shapes with a straight wall).
  if (shape === 'potion.tall' || shape === 'potion.bottle' || shape === 'potion.flask') {
    const paper = kit.get('paper');
    const r = shape === 'potion.flask' ? prof[3][0] * 0.98 : prof[3][0];
    const y0 = shape === 'potion.flask' ? top * 0.12 : top * 0.25;
    const lab = mesh(new THREE.CylinderGeometry(r + 0.0015, r + 0.0015, top * 0.18, 16, 1, true, -0.7, 1.4), paper, 0, y0 + top * 0.09, 0);
    g.add(lab);
  } else if (shape === 'potion.round') {
    // String tied around the neck with a small tag.
    const tw = stdMat(kit, 'twine', [0.55, 0.45, 0.3], { roughness: 0.9 });
    g.add(mesh(new THREE.TorusGeometry(neckR * 1.05, 0.0018, 4, 12), tw, 0, top * 0.82, 0, Math.PI / 2));
    g.add(mesh(new THREE.PlaneGeometry(0.02, 0.014), kit.get('paper'), neckR + 0.012, top * 0.72, 0.006, 0, 0.4, 0.3));
  }
  if (v.glow > 0.2) {
    const halo = mesh(new THREE.SphereGeometry(prof.reduce((m, p) => Math.max(m, p[0]), 0) * 1.4, 12, 8), glowMat(kit, 'halo', v.glowColor, 1.2), 0, liquidTop * 0.5, 0);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.06 * v.glow;
    halo.castShadow = false;
    g.add(halo);
  }
  return g;
}

function essence(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = potion('potion.vial', v, kit, rng);
  // A tiny wire cage and a strong inner glow: bottled raw magic.
  const wire = kit.get('trim');
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    g.add(mesh(cyl(0.0012, 0.0012, 0.0, 0.085, 4), wire, Math.cos(a) * 0.0135, 0, Math.sin(a) * 0.0135));
  }
  g.add(mesh(new THREE.TorusGeometry(0.0135, 0.0012, 4, 16), wire, 0, 0.03, 0, Math.PI / 2));
  g.add(mesh(new THREE.TorusGeometry(0.0135, 0.0012, 4, 16), wire, 0, 0.065, 0, Math.PI / 2));
  const core = mesh(new THREE.SphereGeometry(0.007, 8, 6), glowMat(kit, 'core', v.glowColor, 3), 0, 0.04, 0);
  core.castShadow = false;
  g.add(core);
  return g;
}

// ------------------------------------------------------------------ scrolls, letters

function scroll(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const paper = kit.get('paper');
  const len = rng.range(0.18, 0.22), r = 0.018;
  // Roll lying along X plus a slightly unrolled tongue of parchment.
  const roll = mesh(new THREE.CylinderGeometry(r, r, len, 16, 1, true), paper, 0, r, 0, 0, 0, Math.PI / 2);
  g.add(roll);
  // Spiral end caps (visible layers).
  for (const sx of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2 * 3.2;
      const rr = r * (0.2 + 0.8 * (i / 40));
      pts.push(new THREE.Vector3(sx * len / 2, r + Math.sin(a) * rr, Math.cos(a) * rr));
    }
    g.add(mesh(tube(pts, 0.0012, 3, false, 60), paper));
  }
  const tongue = new THREE.PlaneGeometry(len * 0.96, 0.06, 1, 6);
  const tp = tongue.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) + 0.03; // 0..0.06
    tp.setXYZ(i, tp.getX(i), Math.max(0.001, 0.012 - y * 0.6 + y * y * 4), r + y);
  }
  tongue.computeVertexNormals();
  g.add(mesh(tongue, paper));
  // Ribbon and wax seal in the accent colour.
  const ribbon = kit.custom('ribbon', () => new THREE.MeshStandardMaterial({ color: col(v.accent), roughness: 0.5 }));
  g.add(mesh(new THREE.TorusGeometry(r + 0.0015, 0.0035, 4, 20), ribbon, 0, r, 0, 0, Math.PI / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(0.008, 0.002, 0.05), ribbon, 0.006, 0.001, r + 0.03, 0, 0.3, 0));
  g.add(mesh(new THREE.BoxGeometry(0.008, 0.002, 0.045), ribbon, -0.006, 0.001, r + 0.028, 0, -0.25, 0));
  const wax = stdMat(kit, 'sealwax', [0.6, 0.06, 0.06], { roughness: 0.3 });
  const seal = mesh(lathe([[0.012, 0], [0.013, 0.002], [0.011, 0.004], [0.007, 0.0045], [0.001, 0.004]], 12), wax, 0, r * 2 - 0.002, 0.004, -0.3, 0, 0);
  g.add(seal);
  // Glowing rune on the tongue for magical scrolls.
  if (v.glow > 0.05) {
    const rune = glowMat(kit, 'rune', v.accent, 2.5);
    const runeG = new THREE.Group();
    const r0 = 0.012;
    runeG.add(mesh(new THREE.RingGeometry(r0 * 0.85, r0, 20), rune));
    for (let i = 0; i < 3; i++) runeG.add(mesh(new THREE.PlaneGeometry(0.0018, r0 * 1.8), rune, 0, 0, 0, 0, 0, (i * Math.PI) / 3));
    runeG.position.set(len * 0.25, 0.012, r + 0.036);
    runeG.rotation.x = -Math.PI / 2 + 0.25;
    g.add(runeG);
  }
  g.rotation.y = rng.range(-0.4, 0.4);
  return g;
}

function letter(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const paper = kit.tinted('paper', v.primary, 'letter');
  const body = new THREE.BoxGeometry(0.15, 0.006, 0.1);
  g.add(mesh(body, paper, 0, 0.003, 0));
  // Folded flap: a triangle on top.
  const flap = extrudeOutline([[-0.075, 0], [0.075, 0], [0, -0.055]], 0.0015);
  g.add(mesh(flap, paper, 0, 0.0068, 0.05, Math.PI / 2, 0, 0));
  const wax = stdMat(kit, 'sealwax', [0.6, 0.06, 0.06], { roughness: 0.3 });
  g.add(mesh(lathe([[0.012, 0], [0.013, 0.002], [0.011, 0.004], [0.007, 0.0045], [0.001, 0.004]], 12), wax, 0, 0.0075, -0.003));
  const tw = stdMat(kit, 'twine', [0.55, 0.45, 0.3], { roughness: 0.9 });
  g.add(mesh(new THREE.BoxGeometry(0.152, 0.008, 0.003), tw, 0, 0.003, -0.02));
  g.rotation.y = rng.range(-0.5, 0.5);
  return g;
}

function relic(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const stone = kit.get('stone');
  // A broken carved shard: an extruded jagged slab, standing at a tilt.
  const pts: V2[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = (i % 2 ? 0.055 : 0.075) * rng.range(0.75, 1.15);
    pts.push([Math.cos(a) * rr * 0.75, Math.sin(a) * rr + 0.06]);
  }
  const slab = extrudeOutline(pts, 0.035, 0.004);
  const m = mesh(slab, stone, 0, 0.024, 0, -0.18, rng.range(0, 6), 0);
  g.add(m);
  // Carved glowing glyph band on the face.
  const rune = glowMat(kit, 'relic', v.glow > 0 ? v.glowColor : [0.6, 0.8, 1], 2);
  const glyph = new THREE.Group();
  glyph.add(mesh(new THREE.RingGeometry(0.018, 0.022, 6), rune));
  glyph.add(mesh(new THREE.PlaneGeometry(0.003, 0.05), rune));
  glyph.add(mesh(new THREE.PlaneGeometry(0.03, 0.003), rune, 0, 0.012, 0));
  m.add(glyph);
  glyph.position.set(0, 0.06, 0.0186);
  // Same carving on the back face.
  const back = glyph.clone();
  back.position.z = -0.0186;
  back.rotation.y = Math.PI;
  m.add(back);
  return g;
}

// ------------------------------------------------------------------ books

function book(v: ItemVisual, kit: ItemMatKit, rng: Rng, kind: 'book' | 'tome' | 'small') {
  const g = new THREE.Group();
  const W = kind === 'tome' ? 0.2 : kind === 'small' ? 0.1 : 0.15;
  const D = kind === 'tome' ? 0.27 : kind === 'small' ? 0.14 : 0.21;
  const T = kind === 'tome' ? 0.075 : kind === 'small' ? 0.022 : 0.042;
  const ct = kind === 'tome' ? 0.007 : 0.004;
  const cover = kit.custom('cover', () => {
    const m = kit.get('leather') as THREE.MeshStandardMaterial;
    const c = m.clone();
    c.color = col(v.primary);
    return c;
  });
  const pages = kit.get('paper');
  // Covers (bottom & top) and rounded spine on -X.
  g.add(mesh(new THREE.BoxGeometry(W, ct, D), cover, 0, ct / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(W, ct, D), cover, 0, T - ct / 2, 0));
  const spine = new THREE.CylinderGeometry(T / 2, T / 2, D, 12, 1, false, Math.PI, Math.PI);
  g.add(mesh(spine, cover, -W / 2, T / 2, 0, Math.PI / 2, 0, 0));
  // Spine bands.
  for (let i = -1; i <= 1; i++) {
    const band = new THREE.CylinderGeometry(T / 2 + 0.002, T / 2 + 0.002, 0.008, 12, 1, true, Math.PI, Math.PI);
    g.add(mesh(band, cover, -W / 2, T / 2, i * D * 0.28, Math.PI / 2, 0, 0));
  }
  // Page block with gentle fore-edge curve.
  const pg = new THREE.BoxGeometry(W - 0.008, T - ct * 2, D - 0.012, 4, 1, 1);
  const pp = pg.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pp.count; i++) if (pp.getX(i) > 0) pp.setX(i, pp.getX(i) - Math.abs(pp.getY(i)) * 0.15);
  pg.computeVertexNormals();
  g.add(mesh(pg, pages, 0.002, T / 2, 0));
  const trim = kit.get('trim');
  const style = styleOf(v.style);
  if (kind !== 'small') {
    // Corner protectors.
    for (const sx of [1]) for (const sz of [-1, 1]) for (const y of [ct / 2, T - ct / 2]) {
      const c = extrudeOutline([[0, 0], [-0.03, 0], [0, -0.03]], ct + 0.002);
      g.add(mesh(c, trim, sx * W / 2 + 0.001, y, sz * (D / 2 + 0.001), sz > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0));
    }
    // Clasp: leather strap over the fore edge with a metal catch.
    g.add(mesh(new THREE.BoxGeometry(0.02, T + 0.004, 0.016), kit.get('grip'), W / 2 + 0.002, T / 2, 0));
    g.add(mesh(new THREE.BoxGeometry(0.03, 0.004, 0.022), trim, W / 2 - 0.012, T + 0.001, 0));
  } else {
    // Small journals tie shut with a cord.
    const cord = stdMat(kit, 'twine', [0.5, 0.36, 0.22], { roughness: 0.9 });
    g.add(mesh(new THREE.BoxGeometry(W + 0.004, T + 0.003, 0.004), cord, 0, T / 2, 0));
  }
  // Embossed culture motif on the front cover.
  const motif = new THREE.Group();
  motif.position.set(0.006, T + 0.0005, 0);
  addMotif(motif, style.motif, kit, kind === 'small' ? 0.6 : kind === 'tome' ? 1.25 : 1, rng);
  g.add(motif);
  if (kind === 'tome') {
    // Metal bosses: four corners + centre ring.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.008, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), trim, sx * W * 0.32, T, sz * D * 0.36));
  }
  if (v.glow > 0.05) {
    const glyph = mesh(new THREE.RingGeometry(0.02, 0.024, 24), glowMat(kit, 'bookrune', v.glowColor, 2), 0.006, T + 0.003, 0, -Math.PI / 2);
    g.add(glyph);
  }
  g.rotation.y = rng.range(-0.5, 0.5);
  return g;
}

/** Small raised ornament (lies in XZ plane, raised along +Y) for book covers, boxes and coins. */
export function addMotif(parent: THREE.Object3D, motif: string, kit: ItemMatKit, s: number, rng: Rng) {
  const trim = kit.get('trim');
  const add = (geo: THREE.BufferGeometry, x = 0, z = 0, ry = 0) => {
    const m = mesh(geo, trim, x * s, 0, z * s, 0, ry, 0);
    m.scale.setScalar(s);
    parent.add(m);
  };
  const flat = (pts: V2[]) => {
    const g = extrudeOutline(pts, 0.002);
    g.rotateX(-Math.PI / 2);
    return g;
  };
  switch (motif) {
    case 'knotwork': {
      const t = new THREE.TorusKnotGeometry(0.02, 0.0022, 48, 4, 2, 3);
      t.scale(1, 1, 0.12);
      t.rotateX(-Math.PI / 2);
      add(t);
      break;
    }
    case 'leafvine': {
      for (let i = 0; i < 5; i++) {
        const l = leafGeometry(0.03, 0.009);
        l.rotateX(-Math.PI / 2);
        add(l, 0, 0, (i / 5) * Math.PI * 2);
      }
      break;
    }
    case 'runic':
      for (let i = 0; i < 4; i++) {
        add(new THREE.BoxGeometry(0.003, 0.002, 0.03), (i - 1.5) * 0.012, 0, rng.range(-0.3, 0.3));
        add(new THREE.BoxGeometry(0.01, 0.002, 0.003), (i - 1.5) * 0.012 + 0.003, rng.range(-0.01, 0.01), 0.7);
      }
      add(new THREE.BoxGeometry(0.06, 0.002, 0.003), 0, -0.02);
      add(new THREE.BoxGeometry(0.06, 0.002, 0.003), 0, 0.02);
      break;
    case 'spikes':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(flat([[-0.004, 0], [0.004, 0], [0, 0.022]]), Math.cos(a) * 0.006, Math.sin(a) * 0.006, -a + Math.PI / 2);
      }
      add(new THREE.CylinderGeometry(0.007, 0.008, 0.003, 8));
      break;
    case 'scales':
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) add(new THREE.CylinderGeometry(0.007, 0.007, 0.002, 10, 1, false, 0, Math.PI), (c - 1) * 0.013 + (r % 2) * 0.0065, (r - 1) * 0.011);
      break;
    case 'crescent':
      add(flat(Array.from({ length: 17 }, (_, i) => {
        const a = -Math.PI * 0.8 + (i / 16) * Math.PI * 1.6;
        return [Math.cos(a) * 0.022, Math.sin(a) * 0.022] as V2;
      }).concat(Array.from({ length: 17 }, (_, i) => {
        const a = Math.PI * 0.8 - (i / 16) * Math.PI * 1.6;
        return [Math.cos(a) * 0.017 + 0.007, Math.sin(a) * 0.017] as V2;
      }))));
      break;
    case 'megalith':
      for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.008, 0.002, 0.022 + (i === 1 ? 0.008 : 0)), (i - 1) * 0.013, 0);
      add(new THREE.BoxGeometry(0.036, 0.002, 0.006), 0, -0.016);
      break;
    case 'rough':
      add(new THREE.BoxGeometry(0.04, 0.002, 0.004), 0, 0, 0.7);
      add(new THREE.BoxGeometry(0.04, 0.002, 0.004), 0, 0, -0.7);
      break;
    default: // geometric
      add(flat([[0, 0.024], [0.016, 0], [0, -0.024], [-0.016, 0]]));
      break;
  }
}

// ------------------------------------------------------------------ keys

function key(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const metal = kit.get('metal');
  const L = rng.range(0.085, 0.11);
  const r = 0.004;
  // Lying flat on the ground along X: bow (ring) at -X, bit at +X.
  const bowR = rng.range(0.013, 0.018);
  g.add(mesh(new THREE.TorusGeometry(bowR, 0.0035, 6, 18), metal, -L / 2, r, 0, Math.PI / 2, 0, 0));
  if (rng.chance(0.6)) {
    // Ornate trefoil bow.
    for (let i = 0; i < 3; i++) {
      const a = Math.PI + (i - 1) * 1.1;
      g.add(mesh(new THREE.TorusGeometry(bowR * 0.45, 0.0022, 5, 12), metal, -L / 2 + Math.cos(a) * bowR * 1.1, r, Math.sin(a) * bowR * 1.1, Math.PI / 2, 0, 0));
    }
  }
  g.add(mesh(cyl(r, r, 0, L - bowR, 8), metal, -L / 2 + bowR, r, 0, 0, 0, -Math.PI / 2));
  // Collar & bit with wards.
  g.add(mesh(new THREE.TorusGeometry(r * 1.3, 0.0016, 5, 10), metal, -L / 2 + bowR + 0.008, r, 0, 0, Math.PI / 2, 0));
  const bitW = 0.018;
  g.add(mesh(new THREE.BoxGeometry(bitW, 0.003, 0.016), metal, L / 2 - bitW / 2, r * 0.7, 0.008));
  for (let i = 0; i < 2; i++) g.add(mesh(new THREE.BoxGeometry(0.003, 0.0032, 0.007), kit.get('dark'), L / 2 - 0.005 - i * 0.007, r * 0.7, 0.012 + i * 0.002));
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

// ------------------------------------------------------------------ trinkets

function charm(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const furish = v.material === 'fur';
  const wire = kit.tinted('trim', [0.75, 0.45, 0.25], 'copper');
  if (furish && v.primary[2] < v.primary[0] + 0.05) {
    // Rabbit's foot: furry lump with toes, a copper cap and a ring.
    const fur = kit.get('fur');
    const foot = lumpGeometry(rng, 1, 0.08, false, [0.05, 0.022, 0.024]);
    g.add(mesh(foot, fur));
    for (let i = 0; i < 3; i++) g.add(mesh(new THREE.SphereGeometry(0.009, 6, 5), fur, 0.045, 0.012, (i - 1) * 0.011));
    g.add(mesh(cyl(0.013, 0.011, 0, 0.012, 10), wire, -0.05, 0.02, 0, 0, 0, Math.PI / 2));
    g.add(mesh(new THREE.TorusGeometry(0.009, 0.0018, 5, 12), wire, -0.068, 0.02, 0, 0, 0, 0));
  } else {
    // Feather charm: three bright feathers bound by a copper wire wrap.
    const feather = kit.custom('feather', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.75, side: THREE.DoubleSide }));
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Group();
      f.add(mesh(leafGeometry(0.09, 0.012, 0.05), feather));
      f.add(mesh(cyl(0.0012, 0.0008, -0.01, 0.09, 4), kit.get('bone')));
      f.rotation.set(-Math.PI / 2 + 0.06, 0, (i - 1) * 0.3);
      f.position.set(0, 0.006 + i * 0.002, 0.02);
      g.add(f);
    }
    g.add(mesh(cyl(0.006, 0.006, 0, 0.018, 8), wire, 0, 0.007, 0.002, Math.PI / 2, 0, 0));
    const bead = kit.get('gem');
    g.add(mesh(new THREE.SphereGeometry(0.006, 8, 6), bead, 0, 0.007, 0.026));
    g.add(mesh(new THREE.TorusGeometry(0.008, 0.0015, 5, 12), wire, 0, 0.006, 0.04, Math.PI / 2, 0, 0));
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function idol(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const body = kit.get('primary');
  const h = rng.range(0.1, 0.13);
  // Squat seated figure: pedestal, belly, arms, head with gem eyes.
  g.add(mesh(cyl(0.035, 0.038, 0, 0.012, 8), body));
  g.add(mesh(lathe([[0.03, 0.012], [0.036, h * 0.3], [0.03, h * 0.55], [0.018, h * 0.62], [0.001, h * 0.63]], 12), body));
  const head = lumpGeometry(rng, 1, 0.06, false, [0.026, 0.024, 0.024]);
  g.add(mesh(head, body, 0, h * 0.58, 0));
  for (const sx of [-1, 1]) g.add(mesh(new THREE.CapsuleGeometry(0.008, 0.03, 2, 6), body, sx * 0.03, h * 0.36, 0.012, 0.9, 0, sx * 0.25));
  const eye = kit.get('gem');
  for (const sx of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.0055, 8, 6), eye, sx * 0.01, h * 0.58 + 0.026, 0.021));
  // Grinning mouth.
  g.add(mesh(new THREE.TorusGeometry(0.009, 0.0018, 4, 10, Math.PI), kit.get('dark'), 0, h * 0.58 + 0.014, 0.023, 0, 0, Math.PI));
  if (v.glow > 0.05) {
    const halo = mesh(new THREE.SphereGeometry(0.06, 10, 8), glowMat(kit, 'idol', v.glowColor, 1), 0, h * 0.5, 0);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.1;
    halo.castShadow = false;
    g.add(halo);
  }
  return g;
}

function compass(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const brass = kit.get('metal');
  const R = 0.032;
  g.add(mesh(lathe([[0.001, 0], [R * 0.95, 0], [R, 0.004], [R, 0.013], [R * 0.92, 0.014], [R * 0.9, 0.006], [0.001, 0.006]], 24), brass));
  // Dial face with cardinal ticks.
  const face = kit.get('paper');
  g.add(mesh(new THREE.CircleGeometry(R * 0.9, 24), face, 0, 0.0065, 0, -Math.PI / 2));
  const ink = stdMat(kit, 'ink', [0.08, 0.06, 0.05]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const L = i % 2 ? 0.004 : 0.008;
    g.add(mesh(new THREE.BoxGeometry(0.0012, 0.0005, L), ink, Math.sin(a) * R * 0.72, 0.0068, Math.cos(a) * R * 0.72, 0, a, 0));
  }
  // Needle (red north, steel south).
  const needle = new THREE.Group();
  needle.add(mesh(extrudeOutline([[-0.004, 0], [0.004, 0], [0, 0.024]], 0.0015), stdMat(kit, 'red', [0.75, 0.08, 0.06], { metalness: 0.3, roughness: 0.4 }), 0, 0, 0, -Math.PI / 2, 0, 0));
  needle.add(mesh(extrudeOutline([[-0.004, 0], [0.004, 0], [0, -0.024]], 0.0015), kit.get('dark'), 0, 0, 0, -Math.PI / 2, 0, 0));
  needle.position.y = 0.009;
  needle.rotation.y = rng.range(-0.4, 0.4);
  g.add(needle);
  g.add(mesh(new THREE.SphereGeometry(0.0025, 6, 4), brass, 0, 0.0095, 0));
  // Glass lid & hinge bail.
  const glass = mesh(new THREE.CircleGeometry(R * 0.92, 24), kit.get('glass'), 0, 0.0128, 0, -Math.PI / 2);
  glass.renderOrder = 2;
  g.add(glass);
  g.add(mesh(new THREE.TorusGeometry(0.008, 0.0022, 6, 14), brass, 0, 0.008, R + 0.007, 0, Math.PI / 2, 0));
  g.add(mesh(cyl(0.004, 0.004, 0, 0.006, 8), brass, 0, 0.004, R + 0.001, Math.PI / 2, 0, 0));
  return g;
}

function coinGeometry(r: number, t: number, hole: boolean): THREE.BufferGeometry {
  // Rim, slightly sunken field, raised centre — lathe gives crisp edges.
  const inner = hole ? r * 0.22 : 0.0005;
  const prof: V2[] = [[inner, 0], [r * 0.97, 0], [r, t * 0.15], [r, t * 0.85], [r * 0.97, t], [r * 0.86, t], [r * 0.84, t * 0.8], [r * 0.4, t * 0.8], [r * 0.36, t * 0.95], [inner + 0.0003, t * 0.95]];
  if (hole) prof.push([inner, t * 0.5], [inner, 0]);
  return lathe(prof, 24);
}

function bigCoin(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const gold = kit.get('metal');
  const coin = mesh(coinGeometry(0.028, 0.004, true), gold);
  g.add(coin);
  // Worn embossed profile marks around the field.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.add(mesh(new THREE.BoxGeometry(0.002, 0.0006, 0.004), gold, Math.cos(a) * 0.019, 0.0034, Math.sin(a) * 0.019, 0, -a, 0));
  }
  g.rotation.y = rng.range(0, 6.28);
  return g;
}

function coins(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const gold = kit.get('metal');
  const silver = kit.tinted('metal', v.secondary, 'silver');
  const copper = kit.tinted('metal', v.accent, 'copper');
  const geos = [coinGeometry(0.012, 0.0022, false), coinGeometry(0.0105, 0.002, false), coinGeometry(0.009, 0.0019, true)];
  const mats = [gold, silver, copper];
  // A short stack plus scattered coins.
  const stack = rng.int(3, 6);
  for (let i = 0; i < stack; i++) g.add(mesh(geos[0], gold, rng.range(-0.0015, 0.0015), i * 0.0022, rng.range(-0.0015, 0.0015), 0, rng.range(0, 6), 0));
  const loose = rng.int(5, 10);
  for (let i = 0; i < loose; i++) {
    const k = rng.int(0, 2);
    const a = rng.range(0, 6.28), d = rng.range(0.018, 0.045);
    const tilted = rng.chance(0.35);
    g.add(mesh(geos[k], mats[k], Math.cos(a) * d, tilted ? 0.004 : rng.chance(0.3) ? 0.002 : 0, Math.sin(a) * d, tilted ? rng.range(0.2, 0.5) : 0, rng.range(0, 6), tilted ? rng.range(-0.3, 0.3) : 0));
  }
  return g;
}

function totem(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.get('wood');
  const h = 0.16;
  g.add(mesh(cyl(0.024, 0.026, 0, 0.012, 8), wood));
  // Two stacked carved faces.
  const dark = stdMat(kit, 'carve', [0.12, 0.08, 0.05], { roughness: 1 });
  for (let i = 0; i < 2; i++) {
    const y0 = 0.012 + i * 0.055;
    g.add(mesh(cyl(0.02, 0.022, y0, y0 + 0.052, 8), wood));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.008, 0.005, 0.004), dark, sx * 0.008, y0 + 0.034, 0.02));
    g.add(mesh(new THREE.BoxGeometry(0.014, 0.004, 0.004), dark, 0, y0 + 0.016, 0.021));
    g.add(mesh(new THREE.ConeGeometry(0.004, 0.012, 4), wood, 0, y0 + 0.025, 0.024, Math.PI / 2, 0, 0));
  }
  // Spread wings on top.
  const paint = kit.custom('paint', () => new THREE.MeshStandardMaterial({ color: col(v.accent[0] > 0.6 ? [0.7, 0.2, 0.12] : v.accent), roughness: 0.8 }));
  for (const sx of [-1, 1]) {
    const w = extrudeOutline([[0, 0], [0.045, 0.02], [0.05, 0.008], [0.035, -0.004], [0, -0.008]], 0.006);
    g.add(mesh(w, paint, 0, h - 0.035, 0, 0, sx > 0 ? 0 : Math.PI, 0));
  }
  g.add(mesh(lumpGeometry(rng, 1, 0.05, false, [0.02, 0.018, 0.02]), wood, 0, h - 0.04, 0));
  g.add(mesh(new THREE.ConeGeometry(0.006, 0.016, 4), stdMat(kit, 'beak', [0.85, 0.6, 0.2]), 0, h - 0.022, 0.022, Math.PI / 2, 0, 0));
  // Feathers tied at the base.
  const fcol: RGB[] = [[0.9, 0.85, 0.75], [0.25, 0.2, 0.15], [0.7, 0.2, 0.12]];
  for (let i = 0; i < 3; i++) {
    const f = mesh(leafGeometry(0.05, 0.007), stdMat(kit, 'tf' + i, fcol[i], { side: THREE.DoubleSide }), 0.024, 0.02, (i - 1) * 0.01, 0, Math.PI / 2, -2.6 + i * 0.15);
    g.add(f);
  }
  return g;
}

function orb(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const stand = kit.get('dark');
  // Three-clawed stand.
  g.add(mesh(cyl(0.022, 0.026, 0, 0.012, 12), stand));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const pts = [new THREE.Vector3(Math.cos(a) * 0.016, 0.01, Math.sin(a) * 0.016), new THREE.Vector3(Math.cos(a) * 0.026, 0.025, Math.sin(a) * 0.026), new THREE.Vector3(Math.cos(a) * 0.022, 0.042, Math.sin(a) * 0.022)];
    g.add(mesh(tube(pts, 0.0025, 5), stand));
  }
  const R = 0.034;
  const glass = kit.custom('orbglass', () => new THREE.MeshStandardMaterial({ color: col(v.primary), roughness: 0.03, metalness: 0, transparent: true, opacity: 0.45, depthWrite: false }));
  const ball = mesh(new THREE.SphereGeometry(R, 24, 16), glass, 0, 0.018 + R, 0);
  ball.renderOrder = 2;
  g.add(ball);
  // Swirling inner mist: a few twisted translucent ribbons + a glowing core.
  const mist = glowMat(kit, 'mist', v.glow > 0 ? v.glowColor : v.primary, 1.2);
  for (let i = 0; i < 3; i++) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      const a = t * Math.PI * 2 * 1.5 + i * 2.1;
      const rr = R * 0.55 * Math.sin(t * Math.PI);
      pts.push(new THREE.Vector3(Math.cos(a) * rr, (t - 0.5) * R * 1.3, Math.sin(a) * rr));
    }
    const m = mesh(tube(pts, 0.003, 4), mist, 0, 0.018 + R, 0, rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5));
    m.castShadow = false;
    g.add(m);
  }
  const core = mesh(new THREE.SphereGeometry(0.007, 8, 6), glowMat(kit, 'orbcore', v.glow > 0 ? v.glowColor : [0.7, 0.85, 1], 2.5), 0, 0.018 + R, 0);
  core.castShadow = false;
  g.add(core);
  return g;
}

function hourglass(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const frame = kit.get('metal');
  const H = 0.12, R = 0.032;
  const plate = mesh(cyl(R * 1.15, R * 1.15, 0, 0.008, 6), frame);
  g.add(plate);
  g.add(mesh(cyl(R * 1.15, R * 1.15, H - 0.008, H, 6), frame));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    g.add(mesh(cyl(0.0025, 0.0025, 0.008, H - 0.008, 6), frame, Math.cos(a) * R * 1.0, 0, Math.sin(a) * R * 1.0));
  }
  // Glass bulbs (two lobes joined at a narrow waist).
  const prof: V2[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const s = 0.12 + 0.88 * (t < 0.5 ? t * 2 : (1 - t) * 2);
    prof.push([Math.max(0.0025, R * 0.8 * Math.sin(Math.PI * s)), 0.008 + t * (H - 0.016)]);
  }
  const bulbs = mesh(lathe(prof, 16), kit.get('glass'));
  bulbs.renderOrder = 2;
  g.add(bulbs);
  // Sand: a mound below, a funnel above (deterministic "time remaining").
  const sand = stdMat(kit, 'sand', [0.88, 0.75, 0.5], { roughness: 1 });
  const rem = rng.range(0.25, 0.75);
  const mid = H / 2;
  g.add(mesh(lathe([[R * 0.6, 0.01], [R * 0.4, 0.01 + (1 - rem) * 0.03], [0.001, 0.012 + (1 - rem) * 0.04]], 12), sand));
  g.add(mesh(lathe([[0.001, mid + 0.004], [R * 0.6 * rem + 0.004, mid + 0.006 + rem * 0.03], [0.001, mid + 0.006 + rem * 0.03]], 12), sand));
  g.add(mesh(cyl(0.0008, 0.0008, 0.012, mid, 4), sand));
  return g;
}

function musicBox(v: ItemVisual, kit: ItemMatKit, rng: Rng) {
  const g = new THREE.Group();
  const wood = kit.get('primary');
  const trim = kit.get('trim');
  const W = 0.1, D = 0.07, H = 0.045;
  g.add(mesh(new THREE.BoxGeometry(W, H, D), wood, 0, H / 2, 0));
  // Lid hinged at the back, tilted open.
  const lid = new THREE.Group();
  lid.add(mesh(new THREE.BoxGeometry(W + 0.004, 0.01, D + 0.004), wood, 0, 0.005, D / 2));
  const motif = new THREE.Group();
  motif.position.set(0, 0.0105, D / 2);
  addMotif(motif, styleOf(v.style).motif, kit, 0.7, rng);
  lid.add(motif);
  lid.position.set(0, H, -D / 2);
  lid.rotation.x = -rng.range(0.4, 0.9);
  g.add(lid);
  // Brass corners, comb & drum visible inside, winding key at the side.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.008, H + 0.002, 0.008), trim, sx * (W / 2), H / 2, sz * (D / 2)));
  g.add(mesh(new THREE.BoxGeometry(W - 0.01, 0.002, D - 0.01), stdMat(kit, 'velvet', [0.45, 0.05, 0.1], { roughness: 0.9 }), 0, H - 0.003, 0));
  g.add(mesh(cyl(0.008, 0.008, -0.025, 0.025, 12), trim, 0, H + 0.004, -0.01, 0, 0, Math.PI / 2));
  for (let i = 0; i < 6; i++) g.add(mesh(new THREE.BoxGeometry(0.003, 0.0015, 0.02), trim, -0.02 + i * 0.008, H + 0.002, 0.012));
  g.add(mesh(cyl(0.002, 0.002, 0, 0.01, 6), trim, W / 2, H * 0.5, 0, 0, 0, -Math.PI / 2));
  g.add(mesh(new THREE.TorusGeometry(0.006, 0.0018, 5, 10), trim, W / 2 + 0.014, H * 0.5, 0, 0, Math.PI / 2, 0));
  g.rotation.y = rng.range(-0.4, 0.4);
  return g;
}

/** Re-exported for the materials module (pouches of dust share the sack builder). */
export { sack };
