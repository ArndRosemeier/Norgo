/**
 * Hafted weapons: axes, maces, hammers, flail, polearms, staves and wands.
 * Weapon space: +Y along the haft, +X = edge/striking face, grip at origin.
 */
import * as THREE from 'three';
import { mesh, lathe, cyl, extrudeOutline, bladeGeometry, wrappedGrip, type V2 } from './util';
import { type WCtx, smoothShade, sweep, deform, mergeAll, place, spike, sphereDirs, smooth, haft, runeStrip, rod } from './weapons_parts';

const V = THREE.Vector3;

// ------------------------------------------------------------------ axe heads

/** Smooth edge arc points from (x,yb) to (x,yt) bulging by `bulge` along +X. */
function edgeArc(x: number, yb: number, yt: number, bulge: number, n = 8): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = yb + (yt - yb) * t;
    out.push([x + bulge * Math.sin(Math.PI * t), y]);
  }
  return out;
}

/**
 * Extrude an axe-head outline and wedge it: full thickness at the eye,
 * tapering to a keen edge toward |x| = edgeX.
 */
function axeHead(outline: V2[], thick: number, eyeX: number, edgeX: number): THREE.BufferGeometry {
  const g = extrudeOutline(outline, thick, Math.min(0.002, thick * 0.1));
  deform(g, (p) => {
    const k = smooth(eyeX, edgeX, Math.abs(p.x));
    p.z *= 1 - 0.86 * k;
  });
  return smoothShade(g);
}

function mirrorX(ol: V2[]): V2[] {
  return ol.map(([x, y]) => [-x, y] as V2).reverse();
}

/** Eye/socket collar around the haft at the head. */
function socket(c: WCtx, y: number, r: number, h: number) {
  c.g.add(mesh(cyl(r * 1.55, r * 1.55, y - h / 2, y + h / 2, 10), c.kit.get('blade')));
  c.g.add(mesh(cyl(r * 1.7, r * 1.7, y - h / 2 - 0.006, y - h / 2 + 0.002, 10), c.kit.get('dark')));
}

function axe(shape: string, c: WCtx): boolean {
  const { kit, rng } = c;
  const b = Math.sqrt(c.st.broad);
  const motif = c.st.motif;
  let haftTop: number, haftBot: number, r: number, headY: number;
  let ol: V2[];
  let thick: number, edgeX: number;
  let double = false;
  switch (shape) {
    case 'axe.hand':
      haftBot = -0.12; haftTop = 0.36; r = 0.014; headY = 0.32;
      ol = [[-0.03, -0.024], [0.02, -0.024], [0.05, -0.034], [0.085, -0.055], ...edgeArc(0.095 * b, -0.06, 0.05, 0.012), [0.07, 0.04], [0.035, 0.026], [-0.03, 0.026], [-0.045, 0.012], [-0.045, -0.012]];
      thick = 0.032; edgeX = 0.095 * b;
      break;
    case 'axe.bearded':
      haftBot = -0.2; haftTop = 0.48; r = 0.015; headY = 0.43;
      ol = [[-0.032, -0.028], [0.02, -0.03], [0.045, -0.06], [0.06, -0.12], ...edgeArc(0.1 * b, -0.15, 0.05, 0.02, 10), [0.08, 0.046], [0.04, 0.03], [-0.032, 0.03], [-0.05, 0.015], [-0.05, -0.015]];
      thick = 0.034; edgeX = 0.105 * b;
      break;
    case 'axe.battle':
      haftBot = -0.25; haftTop = 0.5; r = 0.016; headY = 0.43;
      ol = [[0, -0.03], [0.03, -0.03], [0.07, -0.07], ...edgeArc(0.12 * b, -0.09, 0.09, 0.025, 10), [0.07, 0.07], [0.03, 0.03], [0, 0.03]];
      ol = [...ol, ...mirrorX(ol)];
      thick = 0.036; edgeX = 0.125 * b; double = true;
      break;
    case 'axe.great':
      haftBot = -0.55; haftTop = 0.95; r = 0.019; headY = 0.84;
      double = motif === 'runic' || motif === 'megalith' || rng.chance(0.3);
      ol = [[0, -0.035], [0.04, -0.035], [0.08, -0.08], [0.13, -0.17], ...edgeArc(0.2 * b, -0.19, 0.17, 0.035, 12), [0.15, 0.13], [0.09, 0.06], [0.04, 0.035], [0, 0.035]];
      if (double) ol = [...ol, ...mirrorX(ol)];
      else ol = [...ol, [-0.04, 0.03], [-0.065, 0.02], [-0.065, -0.02], [-0.04, -0.03]];
      thick = 0.04; edgeX = 0.21 * b;
      break;
    case 'throw.axe':
      haftBot = -0.13; haftTop = 0.24; r = 0.012; headY = 0.2;
      ol = [[-0.025, -0.02], [0.02, -0.02], [0.05, -0.03], [0.075, -0.045], ...edgeArc(0.085, -0.04, 0.075, 0.012), [0.06, 0.06], [0.03, 0.03], [-0.025, 0.022], [-0.035, 0]];
      thick = 0.026; edgeX = 0.09;
      break;
    case 'axe.wood':
      haftBot = -0.15; haftTop = 0.72; r = 0.016; headY = 0.67;
      ol = [[-0.05, -0.028], [0.02, -0.028], [0.06, -0.04], ...edgeArc(0.105, -0.055, 0.055, 0.012), [0.06, 0.04], [0.02, 0.028], [-0.05, 0.028]];
      thick = 0.042; edgeX = 0.11;
      break;
    default:
      return false;
  }
  // Haft: slight belly curve for axes, leather wrap at the grip.
  haft(c, haftBot, haftTop, r, { wrap: shape === 'axe.wood' ? undefined : [-0.06, 0.07], butt: shape === 'axe.great' ? 'spike' : 'cap' });
  if (shape === 'axe.great') c.g.add(mesh(wrappedGrip(r * 1.12, 0.3, 0.42, 9, 10), kit.get('grip')));
  if (motif === 'spikes' || motif === 'rough') {
    // Crude chipped/serrated edge: notch outline points along the bit.
    ol = ol.map(([x, y], i) => (Math.abs(x) > edgeX * 0.85 && i % 2 ? [x - 0.007 * Math.sign(x), y] : [x, y]) as V2);
  }
  const headGeo = axeHead(ol, thick, 0.025, edgeX);
  const head = mesh(headGeo, kit.get('blade'), 0, headY, 0);
  c.g.add(head);
  c.heads.push(head);
  socket(c, headY, r, thick * 1.5);
  // Top spike for dwarven/orc greataxes & battle axes.
  if (shape === 'axe.great' || (shape === 'axe.battle' && rng.chance(0.5))) c.g.add(mesh(spike(new V(0, headY + thick * 0.7, 0), new V(0, 1, 0), 0.07, 0.012, 4), kit.get('blade')));
  // Langets riveted down the haft.
  if (shape !== 'axe.hand' && shape !== 'throw.axe') {
    for (const sz of [1, -1]) c.g.add(mesh(new THREE.BoxGeometry(0.012, 0.12, 0.003), kit.get('dark'), 0, headY - thick - 0.06, sz * r * 1.05));
  }
  // Runes / enchantment along the cheek.
  const zAt = (_y: number) => thick * 0.5 * (1 - 0.86 * smooth(0.025, edgeX, 0.05)) + 0.0006;
  if (c.v.glow > 0.05) runeStrip(c, headY - 0.03, headY + 0.03, 0.014, zAt, kit.get('glow'), () => 0.05);
  else if (motif === 'runic') runeStrip(c, headY - 0.03, headY + 0.03, 0.014, zAt, kit.get('trim'), () => 0.05);
  if (double && motif === 'scales') c.g.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), kit.get('gem'), 0, headY, thick * 0.55));
  return true;
}

// ------------------------------------------------------------------ blunt

function blunt(shape: string, c: WCtx): boolean {
  const { kit, rng, g } = c;
  switch (shape) {
    case 'mace.club': {
      // Knotted hardwood tapering to a heavy head, iron-banded and studded.
      const top = 0.62;
      const geo = lathe([[0.016, -0.12], [0.017, 0.05], [0.022, 0.25], [0.034, 0.45], [0.042, 0.56], [0.036, top], [0.0, top + 0.012]], 12);
      const seed = rng.float() * 100;
      deform(geo, (p) => {
        const k = 1 + 0.12 * Math.sin(p.y * 37 + seed) * Math.sin(Math.atan2(p.z, p.x) * 3 + p.y * 9) + 0.08 * Math.sin(p.y * 91 + seed * 2);
        p.x *= k;
        p.z *= k;
      });
      const head = mesh(geo, kit.get('wood'));
      g.add(head);
      c.heads.push(head);
      g.add(mesh(wrappedGrip(0.018, -0.1, 0.06, 8, 10), kit.get('grip')));
      for (const by of [0.42, 0.55]) g.add(mesh(cyl(0.041 * (by > 0.5 ? 1.08 : 1), 0.043, by - 0.012, by + 0.012, 12), kit.get('dark')));
      const studs: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 10; i++) {
        const a = i * 2.4 + rng.float(), y = 0.45 + rng.float() * 0.12;
        studs.push(spike(new V(Math.cos(a) * 0.036, y, Math.sin(a) * 0.036), new V(Math.cos(a), 0.15, Math.sin(a)), c.st.motif === 'spikes' ? 0.035 : 0.01, 0.006, 4));
      }
      g.add(mesh(mergeAll(studs), kit.get('dark')));
      return true;
    }
    case 'mace.flanged': {
      haft(c, -0.18, 0.46, 0.013, { mat: kit.get('metal'), wrap: [-0.08, 0.08], butt: 'knob', rings: [0.12] });
      const hy = 0.44;
      const n = c.st.motif === 'runic' ? 8 : rng.pick([6, 7, 8]);
      const flange: V2[] = [[0.012, 0], [0.04, 0.018], [0.05, 0.06], [0.047, 0.1], [0.03, 0.125], [0.012, 0.13]];
      if (c.st.motif === 'spikes') flange.splice(3, 0, [0.065, 0.075]);
      const geos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const f = extrudeOutline(flange, 0.006, 0.001);
        place(f, 0, 0, 0, 0, (i / n) * Math.PI * 2, 0);
        geos.push(f);
      }
      geos.push(cyl(0.016, 0.016, 0, 0.13, 10));
      const head = mesh(mergeAll(geos), kit.get('blade'), 0, hy, 0);
      g.add(head);
      c.heads.push(head);
      g.add(mesh(lathe([[0.016, 0], [0.022, 0.01], [0.012, 0.035], [0, 0.04]], 10), kit.get('trim'), 0, hy + 0.13, 0));
      return true;
    }
    case 'mace.morningstar': {
      haft(c, -0.2, 0.48, 0.017, { wrap: [-0.08, 0.08], rings: [0.44, 0.2] });
      const hy = 0.55, R = 0.055;
      const ball = new THREE.IcosahedronGeometry(R, 2);
      const sp: THREE.BufferGeometry[] = [ball];
      for (const d of sphereDirs(16)) if (d.y > -0.75) sp.push(spike(d.clone().multiplyScalar(R * 0.92), d, c.st.motif === 'spikes' ? 0.06 : 0.042, 0.011, 5));
      const head = mesh(mergeAll(sp), kit.get('blade'), 0, hy, 0);
      g.add(head);
      c.heads.push(head);
      g.add(mesh(cyl(0.022, 0.03, hy - R - 0.03, hy - R * 0.6, 10), kit.get('dark')));
      return true;
    }
    case 'hammer.war': {
      haft(c, -0.2, 0.52, 0.014, { mat: rng.chance(0.5) ? kit.get('metal') : kit.get('wood'), wrap: [-0.08, 0.08], rings: [0.15] });
      const hy = 0.47;
      const geos: THREE.BufferGeometry[] = [];
      // Striking face (+X): flared octagonal block with checkered face.
      const face = lathe([[0.02, 0], [0.024, 0.06], [0.03, 0.075], [0.028, 0.085], [0, 0.085]], 8);
      place(face, 0, 0, 0, 0, 0, -Math.PI / 2);
      geos.push(face);
      // Back spike (−X), curved down.
      const back = sweep([new V(-0.01, 0, 0), new V(-0.06, -0.005, 0), new V(-0.11, -0.02, 0), new V(-0.14, -0.045, 0)], (t) => [0.016 * (1 - t) + 0.001, 0.012 * (1 - t) + 0.001], { segs: 10, radial: 4, plane: new V(0, 0, 1) });
      geos.push(back);
      geos.push(new THREE.BoxGeometry(0.04, 0.05, 0.036));
      const head = mesh(mergeAll(geos), kit.get('blade'), 0, hy, 0);
      g.add(head);
      c.heads.push(head);
      g.add(mesh(spike(new V(0, hy + 0.02, 0), new V(0, 1, 0), 0.08, 0.012, 4), kit.get('blade')));
      for (const sz of [1, -1]) g.add(mesh(new THREE.BoxGeometry(0.01, 0.14, 0.003), kit.get('dark'), 0, hy - 0.09, sz * 0.015));
      return true;
    }
    case 'hammer.maul': {
      haft(c, -0.55, 0.95, 0.019, { wrap: [-0.1, 0.1], rings: [0.6], butt: 'knob' });
      const hy = 0.9;
      const w = 0.12 * Math.sqrt(c.st.broad);
      const ol: V2[] = [[-w, -0.05], [w, -0.05], [w + 0.01, -0.035], [w + 0.01, 0.035], [w, 0.05], [-w, 0.05], [-w - 0.01, 0.035], [-w - 0.01, -0.035]];
      const head = mesh(extrudeOutline(ol, 0.1, 0.008, 2), c.st.motif === 'megalith' ? kit.get('stone') : kit.get('blade'), 0, hy, 0);
      g.add(head);
      c.heads.push(head);
      for (const bx of [-w * 0.75, w * 0.75]) g.add(mesh(new THREE.BoxGeometry(0.014, 0.108, 0.108), kit.get('dark'), bx, hy, 0));
      if (c.st.motif === 'runic' || c.v.glow > 0.05) runeStrip(c, hy - 0.035, hy + 0.035, 0.02, () => 0.0505, c.v.glow > 0.05 ? kit.get('glow') : kit.get('trim'), () => 0);
      return true;
    }
    case 'flail': {
      haft(c, -0.15, 0.3, 0.016, { wrap: [-0.08, 0.08], rings: [0.28] });
      g.add(mesh(new THREE.TorusGeometry(0.012, 0.004, 6, 10), kit.get('dark'), 0, 0.318, 0));
      // Chain of alternating links arcing forward.
      const links = 6;
      const path = new THREE.CatmullRomCurve3([new V(0, 0.33, 0), new V(0.05, 0.42, 0), new V(0.13, 0.47, 0), new V(0.21, 0.46, 0)]);
      const lg: THREE.BufferGeometry[] = [];
      for (let i = 0; i < links; i++) {
        const t = (i + 0.5) / links;
        const p = path.getPointAt(t), tan = path.getTangentAt(t);
        const link = new THREE.TorusGeometry(0.011, 0.0028, 5, 10);
        link.scale(0.7, 1.3, 1);
        if (i % 2) link.rotateY(Math.PI / 2);
        link.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), tan));
        link.translate(p.x, p.y, p.z);
        lg.push(link);
      }
      g.add(mesh(mergeAll(lg), kit.get('dark')));
      const end = path.getPointAt(1);
      const R = 0.042;
      const sp: THREE.BufferGeometry[] = [new THREE.IcosahedronGeometry(R, 1)];
      for (const d of sphereDirs(12)) sp.push(spike(d.clone().multiplyScalar(R * 0.9), d, 0.03, 0.009, 4));
      const head = mesh(mergeAll(sp), kit.get('blade'), end.x + R, end.y - 0.01, 0);
      g.add(head);
      c.heads.push(head);
      return true;
    }
    default:
      return false;
  }
}

// ------------------------------------------------------------------ polearms

/** Socketed spearhead with leaf blade, socket rings and langets. */
function spearHead(c: WCtx, y: number, L: number, hw: number, r: number, kind: 'leaf' | 'bodkin' | 'barbed') {
  const { kit, g } = c;
  g.add(mesh(lathe([[r * 1.05, -0.02], [r * 1.25, 0], [r * 0.9, 0.07], [r * 0.7, 0.1]], 10), kit.get('blade'), 0, y, 0));
  g.add(mesh(cyl(r * 1.35, r * 1.35, y + 0.004, y + 0.012, 10), kit.get('trim')));
  const st: [number, number, number][] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let w = kind === 'bodkin' ? hw * (1 - t) : hw * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) * (1 - t * 0.25);
    if (kind === 'barbed' && t < 0.3) w = hw * (0.4 + t * 2.4);
    st.push([y + 0.09 + t * L, i === n ? 0 : Math.max(0.003, w), 0]);
  }
  const blade = mesh(bladeGeometry(st, kind === 'bodkin' ? 0.6 : 0.2, { fuller: kind === 'leaf' ? 0.0 : 0 }), kit.get('blade'));
  g.add(blade);
  c.heads.push(blade);
  // Midrib.
  g.add(mesh(bladeGeometry([[y + 0.09, r * 0.6, 0], [y + 0.09 + L * 0.9, 0.001, 0]], 1.4), kit.get('blade')));
  if (kind === 'barbed') for (const sx of [1, -1]) g.add(mesh(spike(new V(sx * hw * 1.0, y + 0.09 + L * 0.28, 0), new V(sx * 0.3, -1, 0), 0.04, 0.006, 4), kit.get('blade')));
  for (const sz of [1, -1]) g.add(mesh(new THREE.BoxGeometry(0.008, 0.16, 0.0025), kit.get('dark'), 0, y - 0.09, sz * r * 0.98));
}

function polearm(shape: string, c: WCtx): boolean {
  const { kit, rng, g } = c;
  switch (shape) {
    case 'spear': {
      haft(c, -0.85, 1.1, 0.015, { butt: 'spike', rings: [0.3] });
      g.add(mesh(wrappedGrip(0.017, -0.08, 0.1, 8, 10), kit.get('grip')));
      spearHead(c, 1.1, rng.range(0.22, 0.3), 0.026 * c.st.broad, 0.015, c.st.motif === 'spikes' || c.st.motif === 'rough' ? 'barbed' : 'leaf');
      if (rng.chance(0.4) || c.st.motif === 'leafvine' || c.st.motif === 'spikes') {
        // Hanging tassel / feathers below the head.
        const col = c.st.motif === 'spikes' ? [0.15, 0.12, 0.1] as [number, number, number] : c.v.accent;
        for (let i = 0; i < 3; i++) g.add(mesh(new THREE.ConeGeometry(0.008, 0.07, 4), kit.tinted('cloth', col, 'tassel'), Math.cos(i * 2.1) * 0.012, 1.02, Math.sin(i * 2.1) * 0.012, Math.PI));
      }
      return true;
    }
    case 'javelin':
      haft(c, -0.6, 0.52, 0.011, { butt: 'cap' });
      g.add(mesh(wrappedGrip(0.012, -0.05, 0.06, 6, 8), kit.get('grip')));
      spearHead(c, 0.52, 0.16, 0.011, 0.011, 'bodkin');
      return true;
    case 'glaive': {
      haft(c, -0.85, 1.05, 0.017, { butt: 'spike', wrap: [-0.08, 0.1], rings: [0.45] });
      const y = 1.05;
      const st: [number, number, number][] = [];
      const L = rng.range(0.45, 0.55);
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        const w = 0.034 * c.st.broad * (0.75 + 0.5 * Math.sin(Math.PI * t * 0.8)) * (t > 0.82 ? Math.sqrt(1 - ((t - 0.82) / 0.18) ** 2) : 1);
        st.push([y + 0.08 + t * L, i === 14 ? 0 : Math.max(0.002, w), -(0.08 + c.st.curve * 0.05) * t * t * L]);
      }
      const blade = mesh(bladeGeometry(st, 0.18, { single: true, fuller: 0.3 }), kit.get('blade'));
      g.add(blade);
      c.heads.push(blade);
      g.add(mesh(lathe([[0.019, -0.02], [0.022, 0], [0.02, 0.08], [0.012, 0.09]], 10), kit.get('dark'), 0, y, 0));
      // Back spike/fluke.
      g.add(mesh(spike(new V(-0.03, y + 0.15, 0), new V(-1, 0.4, 0), 0.06, 0.01, 4), kit.get('blade')));
      if (c.v.glow > 0.05) runeStrip(c, y + 0.12, y + 0.08 + L * 0.6, 0.014, () => 0.034 * 0.18 + 0.0004, kit.get('glow'), () => -0.005);
      return true;
    }
    case 'halberd': {
      haft(c, -0.9, 1.1, 0.017, { butt: 'spike', wrap: [-0.08, 0.1], rings: [0.5] });
      const y = 1.0;
      // Top spike.
      const st: [number, number, number][] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        st.push([y + 0.1 + t * 0.32, i === 8 ? 0 : 0.016 * (1 - t * 0.6), 0]);
      }
      const sp = mesh(bladeGeometry(st, 0.5), kit.get('blade'));
      g.add(sp);
      // Axe blade (+X) and hook (−X) as one wedged plate.
      const ol: V2[] = [[-0.02, -0.06], [0.03, -0.06], [0.08, -0.1], ...edgeArc(0.17 * c.st.broad, -0.12, 0.1, 0.03, 10), [0.08, 0.06], [0.03, 0.1], [-0.02, 0.1],
        [-0.05, 0.06], [-0.1, 0.07], [-0.15, 0.1], [-0.13, 0.05], [-0.08, 0.0], [-0.04, -0.03]];
      const head = mesh(axeHead(ol, 0.022, 0.03, 0.17 * c.st.broad), kit.get('blade'), 0, y, 0);
      g.add(head);
      c.heads.push(head, sp);
      socket(c, y + 0.02, 0.017, 0.2);
      for (const sz of [1, -1]) g.add(mesh(new THREE.BoxGeometry(0.01, 0.2, 0.003), kit.get('dark'), 0, y - 0.18, sz * 0.017));
      // Decorative piercings via trim rivets.
      for (const [rx, ry] of [[0.06, -0.03], [0.06, 0.03], [-0.07, 0.06]]) g.add(mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.026, 6), kit.get('trim'), rx, y + ry, 0, Math.PI / 2));
      return true;
    }
    case 'staff.quarter': {
      haft(c, -0.9, 0.9, 0.017, { butt: 'cap', rings: [-0.8, 0.8] });
      g.add(mesh(lathe([[0.019, 0.86], [0.02, 0.9], [0.014, 0.915], [0, 0.918]], 10), kit.get('dark')));
      g.add(mesh(wrappedGrip(0.019, -0.15, 0.15, 14, 10), kit.get('grip')));
      return true;
    }
    default:
      return false;
  }
}

// ------------------------------------------------------------------ magic

/** Faceted crystal (hex prism with pointed ends). */
function crystal(len: number, r: number, sides = 6): THREE.BufferGeometry {
  return lathe([[0, -len * 0.3], [r, -len * 0.12], [r * 0.95, len * 0.4], [0, len * 0.7]], sides);
}

function glowBall(c: WCtx, x: number, y: number, z: number, r: number) {
  const m = mesh(new THREE.SphereGeometry(r, 12, 8), c.kit.get('glow'), x, y, z, 0, 0, 0, false);
  m.renderOrder = 3;
  c.g.add(m);
}

function magic(shape: string, c: WCtx): boolean {
  const { kit, rng, g } = c;
  switch (shape) {
    case 'staff.gnarled': {
      // Wandering, twisted root with knots and a curled crook at the top.
      const pts: THREE.Vector3[] = [];
      const top = 1.0;
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        pts.push(new V((rng.float() - 0.5) * 0.03, -0.85 + t * (top + 0.85), (rng.float() - 0.5) * 0.03));
      }
      const knots = [rng.float(), rng.float(), rng.float(), rng.float()];
      const shaft = sweep(pts, (t) => {
        let k = 0.019 * (1.1 - t * 0.25);
        for (const kt of knots) k *= 1 + 0.45 * Math.exp(-(((t - kt) / 0.018) ** 2));
        return [k, k * 0.92];
      }, { segs: 48, radial: 9, twist: 6 });
      g.add(mesh(shaft, kit.get('wood')));
      // Crook: spiral curl.
      const curl: THREE.Vector3[] = [pts[pts.length - 2].clone(), pts[pts.length - 1].clone()];
      const cx = 0.05, cy = top + 0.07;
      for (let i = 1; i <= 9; i++) {
        const a = Math.PI - (i / 9) * Math.PI * 1.6;
        const rr = 0.07 * (1 - i / 14);
        curl.push(new V(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0));
      }
      g.add(mesh(sweep(curl, (t) => { const k = 0.016 * (1 - t * 0.7); return [k, k]; }, { segs: 24, radial: 8 }), kit.get('wood')));
      // A held stone/crystal in the curl.
      const gem = mesh(crystal(0.05, 0.016), c.v.glow > 0.05 ? kit.get('crystal') : kit.get('gem'), cx, cy - 0.005, 0, 0, 0, 0.3);
      g.add(gem);
      c.heads.push(gem);
      if (c.v.glow > 0.05) glowBall(c, cx, cy, 0, 0.03);
      g.add(mesh(wrappedGrip(0.022, -0.05, 0.1, 6, 10), kit.get('grip')));
      return true;
    }
    case 'staff.crystal': {
      haft(c, -0.85, 1.0, 0.016, { butt: 'cap', rings: [0.95, 0.88, -0.6] });
      g.add(mesh(wrappedGrip(0.018, -0.06, 0.12, 8, 10), kit.get('grip')));
      const y = 1.0;
      g.add(mesh(lathe([[0.016, 0], [0.028, 0.02], [0.024, 0.04], [0.014, 0.05]], 12), kit.get('trim'), 0, y, 0));
      // Cage prongs.
      const n = rng.pick([3, 4, 5]);
      const pr: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        pr.push(sweep([new V(ca * 0.018, y + 0.04, sa * 0.018), new V(ca * 0.05, y + 0.1, sa * 0.05), new V(ca * 0.045, y + 0.18, sa * 0.045), new V(ca * 0.012, y + 0.24, sa * 0.012)], (t) => [0.005 * (1 - t * 0.6), 0.005 * (1 - t * 0.6)], { segs: 14, radial: 5 }));
      }
      g.add(mesh(mergeAll(pr), kit.get('trim')));
      const cr = mesh(crystal(0.16, 0.03), kit.get('crystal'), 0, y + 0.1, 0, 0, rng.float(), 0);
      g.add(cr);
      c.heads.push(cr);
      glowBall(c, 0, y + 0.13, 0, 0.01 + c.v.glow * 0.008);
      // Floating motes.
      for (let i = 0; i < 3; i++) g.add(mesh(new THREE.OctahedronGeometry(0.006, 0), kit.get('crystal'), Math.cos(i * 2.1) * 0.07, y + 0.11 + i * 0.03, Math.sin(i * 2.1) * 0.07));
      return true;
    }
    case 'staff.antler': {
      haft(c, -0.85, 0.95, 0.017, { butt: 'cap', rings: [0.9] });
      g.add(mesh(wrappedGrip(0.019, -0.06, 0.12, 8, 10), kit.get('grip')));
      const y = 0.95;
      const ant: THREE.BufferGeometry[] = [];
      const tips: THREE.Vector3[] = [];
      for (const side of [1, -1]) {
        const beam = [new V(0, y - 0.02, 0), new V(side * 0.04, y + 0.06, 0.01), new V(side * 0.1, y + 0.13, 0.02), new V(side * 0.12, y + 0.24, 0.0), new V(side * 0.1, y + 0.32, -0.01)];
        ant.push(sweep(beam, (t) => { const k = 0.013 * (1 - t * 0.75); return [k, k]; }, { segs: 16, radial: 6 }));
        tips.push(beam[2]);
        for (const tt of [0.35, 0.6, 0.8]) {
          const curve = new THREE.CatmullRomCurve3(beam);
          const p = curve.getPointAt(tt);
          const tine = [p, p.clone().add(new V(-side * 0.02, 0.04, 0.02)), p.clone().add(new V(-side * 0.025, 0.08, 0.035))];
          ant.push(sweep(tine, (t) => { const k = 0.008 * (1 - t * 0.8); return [k, k]; }, { segs: 8, radial: 5 }));
        }
      }
      g.add(mesh(mergeAll(ant), kit.get('bone')));
      // Hanging charms: cords with beads, feathers and small bones.
      for (let i = 0; i < 4; i++) {
        const side = i % 2 ? 1 : -1;
        const top = new V(side * (0.05 + i * 0.012), y + 0.09 + i * 0.01, 0.015);
        const len = 0.06 + rng.float() * 0.06;
        g.add(mesh(rod(top, top.clone().add(new V(0, -len, 0)), 0.0012, 4), kit.get('string')));
        const by = top.y - len;
        const kind = rng.int(0, 2);
        if (kind === 0) g.add(mesh(new THREE.SphereGeometry(0.008, 8, 6), kit.get('gem'), top.x, by, top.z));
        else if (kind === 1) {
          const f = mesh(extrudeOutline([[0, 0], [0.008, -0.02], [0.006, -0.045], [0, -0.055], [-0.006, -0.045], [-0.008, -0.02]], 0.001), kit.tinted('cloth', c.v.accent, 'feather'), top.x, by, top.z);
          g.add(f);
        } else g.add(mesh(cyl(0.003, 0.003, by - 0.025, by, 5), kit.get('bone'), top.x, 0, top.z));
      }
      if (c.v.glow > 0.05) glowBall(c, 0, y + 0.18, 0, 0.025);
      return true;
    }
    case 'wand': {
      // Tapered rod with carved rings and a gem tip held by small prongs.
      const geo = lathe([[0, -0.07], [0.008, -0.068], [0.01, -0.05], [0.009, -0.02], [0.0075, 0.06], [0.0055, 0.2], [0.0045, 0.24]], 10);
      g.add(mesh(geo, kit.get('wood')));
      for (const ry of [-0.045, 0.03, 0.15]) g.add(mesh(new THREE.TorusGeometry(0.0085 - ry * 0.012, 0.0018, 5, 12), kit.get('trim'), 0, ry, 0, Math.PI / 2));
      g.add(mesh(wrappedGrip(0.0095, -0.04, 0.025, 4, 8), kit.get('grip')));
      const gem = mesh(crystal(0.03, 0.009), c.v.glow > 0.05 ? kit.get('crystal') : kit.get('gem'), 0, 0.255, 0);
      g.add(gem);
      c.heads.push(gem);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        g.add(mesh(sweep([new V(0, 0.238, 0), new V(Math.cos(a) * 0.009, 0.252, Math.sin(a) * 0.009), new V(Math.cos(a) * 0.005, 0.268, Math.sin(a) * 0.005)], () => [0.0012, 0.0012], { segs: 6, radial: 4 }), kit.get('trim')));
      }
      if (c.v.glow > 0.05) glowBall(c, 0, 0.262, 0, 0.012);
      return true;
    }
    default:
      return false;
  }
}

export function buildHafted(shape: string, c: WCtx): boolean {
  return axe(shape, c) || blunt(shape, c) || polearm(shape, c) || magic(shape, c);
}
