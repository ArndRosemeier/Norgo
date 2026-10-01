/**
 * Tools & light sources: pickaxe, shovel, sickle, fishing rod, smith's
 * hammer, knife, lockpicks, torch and lanterns (with flame + light hooks).
 * Weapon space (+Y handle, +X working edge/face), origin at the grip; the
 * lantern hangs below its bail (origin = bail top); lockpicks rest on y = 0.
 */
import * as THREE from 'three';
import { mesh, lathe, cyl, extrudeOutline, bladeGeometry, wrappedGrip, type V2 } from './util';
import { type WCtx, smoothShade, sweep, deform, mergeAll, place, rod, smooth, haft } from './weapons_parts';

const V = THREE.Vector3;
const Z = new V(0, 0, 1);

/** Teardrop flame: outer and inner core, registered for flicker animation. */
function flame(c: WCtx, x: number, y: number, z: number, s: number): THREE.Object3D {
  const f = new THREE.Group();
  f.position.set(x, y, z);
  const outer = lathe([[0, 0], [s * 0.42, s * 0.2], [s * 0.5, s * 0.5], [s * 0.38, s * 0.85], [s * 0.18, s * 1.25], [0, s * 1.7]], 12);
  // Own flame materials: warm, softer than the saturated shared 'flame' role.
  const outerMat = c.kit.adopt('flameouter', new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 0.42, 0.08), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  const om = new THREE.Mesh(outer, outerMat);
  om.renderOrder = 4;
  f.add(om);
  const coreMat = c.kit.adopt('flamecore', new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.05, 0.4), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  const core = new THREE.Mesh(lathe([[0, 0], [s * 0.22, s * 0.2], [s * 0.18, s * 0.5], [0, s * 0.9]], 8), coreMat);
  core.renderOrder = 5;
  f.add(core);
  // Side tongues.
  for (let i = 0; i < 2; i++) {
    const t = new THREE.Mesh(lathe([[0, 0], [s * 0.2, s * 0.25], [s * 0.14, s * 0.55], [0, s * 0.95]], 8), outerMat);
    t.position.set(Math.cos(i * 3.1) * s * 0.18, s * 0.2, Math.sin(i * 3.1) * s * 0.18);
    t.rotation.z = (i ? 1 : -1) * 0.35;
    t.renderOrder = 4;
    f.add(t);
  }
  c.g.add(f);
  const list = (c.g.userData.flames ??= []) as THREE.Object3D[];
  list.push(f);
  return f;
}

function lightHook(c: WCtx, x: number, y: number, z: number, color: [number, number, number], intensity: number, distance: number) {
  const anchor = new THREE.Object3D();
  anchor.name = 'lightAnchor';
  anchor.position.set(x, y, z);
  c.g.add(anchor);
  c.g.userData.light = { color, intensity, distance, anchor };
}

export function buildToolMesh(shape: string, c: WCtx): boolean {
  const { kit, rng, g } = c;
  switch (shape) {
    case 'pick': {
      haft(c, -0.12, 0.74, 0.016, { wrap: [-0.1, 0.06] });
      const hy = 0.68;
      // Curved head: point on +X, chisel on −X.
      const pts: THREE.Vector3[] = [];
      for (let i = -6; i <= 6; i++) {
        const s = i / 6;
        pts.push(new V(s * 0.25, hy - 0.06 * s * s, 0));
      }
      const head = sweep(pts, (t) => {
        const s = t * 2 - 1;
        const taper = 1 - Math.abs(s) * 0.85;
        return [0.016 * taper + 0.001, (s < 0 ? 0.02 * (1 - Math.abs(s) * 0.3) : 0.014 * taper) + 0.001];
      }, { segs: 26, radial: 6, plane: Z });
      const hm = mesh(head, kit.get('blade'));
      g.add(hm);
      c.heads.push(hm);
      g.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.038), kit.get('blade'), 0, hy, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.04, 6), kit.get('dark'), 0, hy + 0.02, 0, Math.PI / 2));
      return true;
    }
    case 'shovel': {
      haft(c, -0.45, 0.62, 0.016, { butt: 'none' });
      // D-handle: an arch below the shaft closed by a cross grip.
      g.add(mesh(new THREE.TorusGeometry(0.055, 0.009, 6, 14, Math.PI), kit.get('wood'), 0, -0.505, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 8), kit.get('grip'), 0, -0.505, 0, 0, 0, Math.PI / 2));
      // Blade: dished spade plate with a socket strap.
      const ol: V2[] = [[-0.11, 0], [0.11, 0], [0.12, 0.2], [0.07, 0.29], [0, 0.31], [-0.07, 0.29], [-0.12, 0.2]];
      const blade = extrudeOutline(ol, 0.004, 0.001);
      deform(blade, (p) => { p.z += 0.03 * (p.x / 0.12) ** 2; });
      const bm = mesh(smoothShade(blade), kit.get('blade'), 0, 0.63, 0);
      g.add(bm);
      c.heads.push(bm);
      g.add(mesh(lathe([[0.02, 0], [0.022, 0.02], [0.03, 0.06], [0.04, 0.07]], 8), kit.get('blade'), 0, 0.57, 0));
      // Foot treads.
      g.add(mesh(new THREE.BoxGeometry(0.22, 0.012, 0.03), kit.get('blade'), 0, 0.635, 0.008));
      return true;
    }
    case 'sickle': {
      g.add(mesh(lathe([[0.012, -0.07], [0.017, -0.06], [0.016, 0.0], [0.018, 0.06], [0.014, 0.075]], 10), kit.get('wood')));
      g.add(mesh(cyl(0.017, 0.017, 0.075, 0.09, 10), kit.get('dark')));
      // Crescent blade sweeping out to +X and curling back.
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 14; i++) {
        const a = Math.PI * 1.05 - (i / 14) * Math.PI * 1.15;
        pts.push(new V(0.1 + Math.cos(a) * 0.1, 0.09 + Math.sin(a) * 0.13 + 0.0, 0));
      }
      pts[0].set(0, 0.09, 0);
      const blade = sweep(pts, (t) => [0.013 * (1 - t * 0.85) + 0.001, 0.0025 * (1 - t * 0.6) + 0.0005], { segs: 30, radial: 6, plane: Z });
      const bm = mesh(blade, kit.get('blade'));
      g.add(bm);
      c.heads.push(bm);
      return true;
    }
    case 'rod.fishing': {
      // Tapered, slightly bent rod with cork grip, line guides, line and float.
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        pts.push(new V(-0.12 * t * t, -0.3 + t * 2.2, 0));
      }
      g.add(mesh(sweep(pts, (t) => { const r = 0.012 * (1 - t * 0.8); return [r, r]; }, { segs: 30, radial: 7, plane: Z }), kit.get('wood')));
      g.add(mesh(wrappedGrip(0.016, -0.25, 0.12, 4, 10), kit.tinted('leather', [0.7, 0.55, 0.38], 'cork')));
      const curve = new THREE.CatmullRomCurve3(pts);
      const guides: THREE.BufferGeometry[] = [];
      for (const t of [0.35, 0.55, 0.72, 0.86, 0.97]) {
        const p = curve.getPointAt(t);
        const ring = new THREE.TorusGeometry(0.006, 0.0012, 4, 8);
        ring.rotateY(Math.PI / 2);
        ring.translate(p.x + 0.01, p.y, 0);
        guides.push(ring);
      }
      g.add(mesh(mergeAll(guides), kit.get('dark')));
      const tip = curve.getPointAt(1);
      const fx = tip.x + 0.12, fy = 1.2;
      g.add(mesh(sweep([tip, new V(tip.x + 0.05, tip.y - 0.3, 0), new V(fx, fy + 0.1, 0), new V(fx, fy, 0)], () => [0.0006, 0.0006], { segs: 20, radial: 3 }), kit.get('string')));
      g.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), kit.tinted('cloth', [0.85, 0.1, 0.08], 'float'), fx, fy, 0));
      g.add(mesh(new THREE.SphereGeometry(0.0121, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), kit.tinted('cloth', [0.95, 0.95, 0.9], 'float2'), fx, fy, 0));
      g.add(mesh(rod(new V(fx, fy - 0.01, 0), new V(fx, fy - 0.12, 0), 0.0005, 3), kit.get('string')));
      g.add(mesh(new THREE.TorusGeometry(0.007, 0.0012, 4, 10, Math.PI * 1.4), kit.get('dark'), fx + 0.007, fy - 0.125, 0, 0, 0, Math.PI));
      return true;
    }
    case 'hammer.smith': {
      haft(c, -0.12, 0.3, 0.014, { wrap: [-0.09, 0.05] });
      const hy = 0.27;
      const face = new THREE.CylinderGeometry(0.02, 0.022, 0.07, 10);
      face.rotateZ(-Math.PI / 2);
      face.translate(0.035, 0, 0);
      // Cross peen: wedge toward −X with its edge vertical.
      const peen = extrudeOutline([[0, -0.02], [0, 0.02], [-0.055, 0.016], [-0.06, 0.0], [-0.055, -0.016]], 0.034, 0.002);
      deform(peen, (p) => { p.z *= 1 - 0.8 * smooth(-0.01, -0.06, p.x); });
      peen.rotateX(Math.PI / 2);
      const head = mesh(mergeAll([face, peen, new THREE.BoxGeometry(0.03, 0.036, 0.036)]), kit.get('blade'), 0, hy, 0);
      g.add(head);
      c.heads.push(head);
      g.add(mesh(new THREE.BoxGeometry(0.006, 0.006, 0.036), kit.get('dark'), 0, hy + 0.019, 0));
      return true;
    }
    case 'knife': {
      // Wooden scales riveted to a full tang, bolster and a single-edged blade.
      const handle = extrudeOutline([[-0.011, -0.055], [0.011, -0.058], [0.013, 0.0], [0.011, 0.05], [-0.01, 0.05], [-0.012, 0.0]], 0.02, 0.004);
      g.add(mesh(handle, kit.get('wood')));
      g.add(mesh(new THREE.BoxGeometry(0.024, 0.11, 0.004), kit.get('dark'), 0, -0.004, 0));
      for (const ry of [-0.035, 0.0, 0.03]) g.add(mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.024, 6), kit.get('trim'), 0, ry, 0, Math.PI / 2));
      g.add(mesh(new THREE.BoxGeometry(0.026, 0.012, 0.016), kit.get('metal'), 0, 0.056, 0));
      const st: [number, number, number][] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const w = 0.012 * (t > 0.7 ? Math.sqrt(1 - ((t - 0.7) / 0.3) ** 2) : 1);
        st.push([0.06 + t * 0.12, i === 10 ? 0 : Math.max(0.0015, w), -0.004 * t]);
      }
      const bm = mesh(bladeGeometry(st, 0.18, { single: true }), kit.get('blade'));
      g.add(bm);
      c.heads.push(bm);
      return true;
    }
    case 'lockpick': {
      // Ring with picks and a tension wrench, standing on its tips.
      g.add(mesh(new THREE.TorusGeometry(0.018, 0.0018, 5, 16), kit.get('dark'), 0, 0.105, 0));
      const picks: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const a = -0.35 + i * 0.23;
        const top = new V(Math.sin(a) * 0.018, 0.105 - Math.cos(a) * 0.018, 0);
        const bot = new V(top.x + Math.sin(a) * 0.02, 0.005, (i - 1.5) * 0.002);
        picks.push(rod(top, bot, 0.0011, 4));
        // Pick tips: hook / rake / diamond.
        const tip = new THREE.BoxGeometry(i % 2 ? 0.006 : 0.003, 0.004, 0.0012);
        place(tip, bot.x + 0.002, bot.y + 0.002, bot.z, 0, 0, i * 0.4);
        picks.push(tip);
        picks.push(place(new THREE.BoxGeometry(0.006, 0.03, 0.002), top.x + Math.sin(a) * 0.004, top.y - 0.02, top.z, 0, 0, a));
      }
      g.add(mesh(mergeAll(picks), kit.get('metal')));
      g.add(mesh(sweep([new V(0.014, 0.1, 0.004), new V(0.03, 0.06, 0.004), new V(0.03, 0.01, 0.004), new V(0.04, 0.005, 0.004)], () => [0.0016, 0.0008], { segs: 10, radial: 4 }), kit.get('dark')));
      g.add(mesh(new THREE.BoxGeometry(0.03, 0.04, 0.004), kit.get('leather'), -0.02, 0.06, -0.01, 0, 0, 0.2));
      return true;
    }
    case 'torch': {
      // Stick, pitch-soaked rag head with bindings, live flame.
      const stick = lathe([[0.013, -0.18], [0.015, -0.1], [0.016, 0.2], [0.02, 0.33]], 8);
      deform(stick, (p) => { p.x += Math.sin(p.y * 9) * 0.002; });
      g.add(mesh(stick, kit.get('wood')));
      const head = wrappedGrip(0.028, 0.3, 0.44, 5, 10);
      deform(head, (p) => { const k = 1 + 0.25 * Math.sin(((p.y - 0.3) / 0.14) * Math.PI); p.x *= k; p.z *= k; });
      g.add(mesh(head, kit.tinted('cloth', [0.16, 0.12, 0.08], 'pitch')));
      for (const by of [0.31, 0.43]) g.add(mesh(new THREE.TorusGeometry(0.027, 0.0025, 4, 12), kit.get('string'), 0, by, 0, Math.PI / 2));
      g.add(mesh(lathe([[0.03, 0], [0.025, 0.012], [0.012, 0.02], [0, 0.022]], 8), kit.tinted('cloth', [0.05, 0.04, 0.03], 'char'), 0, 0.44, 0));
      flame(c, 0, 0.445, 0, 0.075);
      lightHook(c, 0, 0.53, 0, [1, 0.6, 0.25], 6, 10);
      return true;
    }
    case 'lantern': {
      const crystalLit = c.v.glow > 0 && c.v.glowColor[2] > c.v.glowColor[0];
      const lc: [number, number, number] = c.v.glow > 0 ? [c.v.glowColor[0], c.v.glowColor[1], c.v.glowColor[2]] : [1, 0.7, 0.4];
      // Bail handle (origin at its top).
      g.add(mesh(new THREE.TorusGeometry(0.045, 0.003, 5, 16, Math.PI), kit.get('dark'), 0, -0.045, 0, 0, 0, 0));
      g.add(mesh(new THREE.TorusGeometry(0.007, 0.002, 4, 8), kit.get('dark'), 0, -0.002, 0, Math.PI / 2, 0, 0));
      // Vented cap.
      g.add(mesh(lathe([[0.07, -0.11], [0.072, -0.1], [0.05, -0.075], [0.02, -0.06], [0.012, -0.045], [0, -0.042]], 4, Math.PI / 4), kit.get('metal')));
      g.add(mesh(lathe([[0.016, -0.06], [0.016, -0.05], [0.008, -0.04]], 8), kit.get('dark'), 0, -0.01, 0));
      // Frame: top & bottom rings, corner posts.
      const frame: THREE.BufferGeometry[] = [];
      const top = -0.11, bot = -0.3, R = 0.06;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
        frame.push(rod(new V(Math.cos(a) * R, bot, Math.sin(a) * R), new V(Math.cos(a) * R, top, Math.sin(a) * R), 0.004, 4));
      }
      g.add(mesh(mergeAll(frame), kit.get('metal')));
      g.add(mesh(lathe([[0.072, bot - 0.035], [0.075, bot - 0.02], [0.07, bot], [0.0, bot]], 4, Math.PI / 4), kit.get('metal')));
      g.add(mesh(lathe([[0.04, bot - 0.035], [0.05, bot - 0.045], [0, bot - 0.045]], 8), kit.get('dark')));
      // Horn/glass panes.
      const panes = lathe([[R * 0.98, bot], [R * 0.98, top]], 4, Math.PI / 4);
      const pm = mesh(panes, kit.adopt('pane', new THREE.MeshStandardMaterial({ color: new THREE.Color(1, 0.92, 0.75), roughness: 0.3, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, emissive: new THREE.Color().setRGB(...lc, THREE.SRGBColorSpace), emissiveIntensity: 0.25 })));
      pm.castShadow = false;
      g.add(pm);
      // Cross bars on the panes.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        g.add(mesh(new THREE.BoxGeometry(0.003, 0.003, 0.085), kit.get('dark'), Math.cos(a) * R * 0.71, (top + bot) / 2, Math.sin(a) * R * 0.71, 0, -a, 0));
      }
      if (crystalLit) {
        const cr = mesh(lathe([[0, -0.03], [0.018, -0.01], [0.016, 0.03], [0, 0.06]], 6), kit.get('crystal'), 0, bot + 0.04, 0);
        g.add(cr);
        const halo = mesh(new THREE.SphereGeometry(0.03, 10, 8), kit.get('glow'), 0, bot + 0.08, 0, 0, 0, 0, false);
        g.add(halo);
        lightHook(c, 0, bot + 0.08, 0, lc, 5, 16);
      } else {
        g.add(mesh(cyl(0.013, 0.012, bot, bot + 0.06, 8), kit.tinted('string', [0.95, 0.92, 0.8], 'wax')));
        g.add(mesh(rod(new V(0, bot + 0.06, 0), new V(0, bot + 0.07, 0), 0.0012, 3), kit.tinted('cloth', [0.05, 0.05, 0.05], 'wick')));
        flame(c, 0, bot + 0.066, 0, 0.025);
        lightHook(c, 0, bot + 0.09, 0, lc, 4.5, 14);
      }
      return true;
    }
    default:
      return false;
  }
}
