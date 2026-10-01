/**
 * Weather particles around the camera, driven by ctx.env.weather (server
 * authoritative): rain with ground splashes, snow, volcanic ash with embers,
 * glowing spores, rolling fog banks, and storm lightning (bolt ribbons,
 * branching, a sky flash light and distance-delayed thunder).
 *
 * Particles die where they meet the ground: a small ring-buffer height cache
 * around the camera (filled incrementally from the generator's cached 2D
 * surface) gives each drop its exact lifetime. No precipitation reaches the
 * camera underground or in the underworld.
 */
import * as THREE from 'three';
import type { WeatherState } from '../../shared/types';
import type { WorldGenerator } from '../../world/generator';
import { estimateSkyVis } from '../../render/skyOcclusion';
import { P, resetP } from './particles';
import { Sprite } from './sprites';
import { BeamKind } from './pools';
import type { FxLibrary } from './fxLibrary';

const GN = 32;
const CELL = 4;
const MAX_PER_FRAME = 700;

export class WeatherFx {
  private heights = new Float32Array(GN * GN);
  private keys = new Int32Array(GN * GN).fill(0x7fffffff);
  private fillCursor = 0;
  private acc = new Float32Array(6);
  private sky: THREE.HemisphereLight;
  private flash = 0;
  private flicker = 0;
  private nextBolt = 6;
  private thunder: { t: number; x: number; y: number; z: number; vol: number }[] = [];
  /** Smoothed precipitation strength (fades in/out with weather changes). */
  private level = 0;
  private kind: WeatherState['kind'] = 'clear';
  /** Live estimate for the debug HUD. */
  spawnedLastFrame = 0;
  /**
   * Particle density 0..1: graphics setting (weather particles off → 0) × device budget.
   * Set by FxSystem every frame; lightning and thunder are unaffected.
   */
  density = 1;
  /** Called when a bolt's thunder reaches the camera (position, volume 0..1). */
  onThunder: ((x: number, y: number, z: number, volume: number) => void) | null = null;

  constructor(private lib: FxLibrary, scene: THREE.Scene, private gen: WorldGenerator) {
    // A cold sky light used for lightning flashes (kept in the scene at 0 so the
    // light count never changes).
    this.sky = new THREE.HemisphereLight(0xc8d8ff, 0x404860, 0);
    this.sky.name = 'fx.lightning';
    scene.add(this.sky);
  }

  /** Surface height near the camera (NaN while that cell is not cached yet). */
  private ground(x: number, z: number): number {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const slot = (((cx % GN) + GN) % GN) + (((cz % GN) + GN) % GN) * GN;
    return this.keys[slot] === ((cx * 73856093) ^ (cz * 19349663)) ? this.heights[slot] : NaN;
  }

  /** Fill a slice of the height cache around the camera each frame. */
  private fill(camX: number, camZ: number, budget: number) {
    const c0x = Math.floor(camX / CELL) - GN / 2, c0z = Math.floor(camZ / CELL) - GN / 2;
    for (let n = 0, scanned = 0; n < budget && scanned < GN * GN; scanned++) {
      const i = this.fillCursor;
      this.fillCursor = (this.fillCursor + 1) % (GN * GN);
      const cx = c0x + (i % GN), cz = c0z + Math.floor(i / GN);
      const slot = (((cx % GN) + GN) % GN) + (((cz % GN) + GN) % GN) * GN;
      const key = (cx * 73856093) ^ (cz * 19349663);
      if (this.keys[slot] === key) continue;
      this.heights[slot] = this.gen.cachedColumn(cx * CELL + CELL / 2, cz * CELL + CELL / 2).height;
      this.keys[slot] = key;
      n++;
    }
  }

  update(dt: number, cam: THREE.Vector3, w: WeatherState, time: number) {
    const lib = this.lib;
    this.spawnedLastFrame = 0;
    // Thunder rolls in later than the flash (speed of sound): `onThunder` lets
    // the audio layer play it in sync with the bolt.
    for (let i = this.thunder.length - 1; i >= 0; i--) {
      const t = this.thunder[i];
      if ((t.t -= dt) <= 0) {
        this.onThunder?.(t.x, t.y, t.z, t.vol);
        this.thunder.splice(i, 1);
      }
    }
    // Lightning flash light decay with a double flicker.
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 6);
      this.flicker += dt;
      this.sky.intensity = this.flash * (this.flicker > 0.07 && this.flicker < 0.12 ? 0.25 : 1) * 3.2;
    } else this.sky.intensity = 0;

    const surface = this.gen.heightAt(cam.x, cam.z);
    const outdoors = estimateSkyVis(cam.y, surface) > 0.5 && !this.gen.isUnderworld(cam.x, cam.y, cam.z);
    const target = outdoors && w.kind !== 'clear' && w.kind !== 'cloudy' ? w.intensity : 0;
    if (w.kind !== this.kind) {
      if (this.level < 0.05) this.kind = w.kind;
      else {
        // Fade the old weather out before switching particle type.
        this.level = Math.max(0, this.level - dt * 0.8);
        return;
      }
    }
    this.level += (target - this.level) * Math.min(1, dt * 0.6);
    const L = this.level;
    if (L < 0.01 && w.kind !== 'storm') return;
    this.fill(cam.x, cam.z, 40);
    const wx = w.windX, wz = w.windZ;
    const S = this.density;
    let budget = Math.round(MAX_PER_FRAME * Math.min(1, S));
    switch (this.kind) {
      case 'rain':
        budget = this.rain(dt, cam, surface, 6500 * L * S, false, wx, wz, budget);
        break;
      case 'storm':
        budget = this.rain(dt, cam, surface, 9500 * L * S, true, wx, wz, budget);
        this.storm(dt, cam, L, time);
        break;
      case 'snow': {
        this.acc[2] += 2600 * L * S * dt;
        let n = Math.min(budget, Math.floor(this.acc[2]));
        this.acc[2] -= n;
        const p = resetP();
        while (n-- > 0) {
          const a = Math.random() * 6.2832, r = 30 * Math.sqrt(Math.random());
          const x = cam.x + Math.cos(a) * r - wx * 6, z = cam.z + Math.sin(a) * r - wz * 6;
          let g = this.ground(x, z);
          if (Number.isNaN(g)) g = surface;
          const y = Math.max(cam.y, g) + 4 + Math.random() * 12;
          const vy = -(0.9 + Math.random() * 0.6);
          p.x = x; p.y = y; p.z = z;
          p.vx = wx * 0.9; p.vy = vy; p.vz = wz * 0.9;
          p.life = Math.min(16, (y - g) / -vy);
          p.size0 = p.size1 = 0.05 + Math.random() * 0.05;
          p.rot = Math.random() * 6.28; p.spin = (Math.random() - 0.5) * 2;
          p.r0 = p.r1 = p.g0 = p.g1 = 0.95; p.b0 = p.b1 = 1; p.a0 = 0.9; p.a1 = 0.8;
          p.sprite = Sprite.Snow;
          p.turb = 0.5;
          lib.alpha.spawn(p);
        }
        break;
      }
      case 'ashfall': {
        this.acc[3] += 1400 * L * S * dt;
        let n = Math.min(budget, Math.floor(this.acc[3]));
        this.acc[3] -= n;
        while (n-- > 0) {
          const p = resetP();
          const a = Math.random() * 6.2832, r = 30 * Math.sqrt(Math.random());
          const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
          let g = this.ground(x, z);
          if (Number.isNaN(g)) g = surface;
          const y = Math.max(cam.y, g) + 3 + Math.random() * 12;
          const ember = Math.random() < 0.06;
          p.x = x; p.y = y; p.z = z;
          p.vx = wx * 0.8; p.vy = ember ? -0.3 : -(0.6 + Math.random() * 0.5); p.vz = wz * 0.8;
          p.life = Math.min(14, (y - g) / -p.vy);
          p.turb = 0.7;
          if (ember) {
            p.size0 = 0.04; p.size1 = 0.01;
            p.r0 = 5; p.g0 = 1.6; p.b0 = 0.3; p.a0 = 1; p.r1 = 1.5; p.g1 = 0.2; p.b1 = 0; p.a1 = 0;
            p.sprite = Sprite.Spark;
            lib.add.spawn(p);
          } else {
            p.size0 = p.size1 = 0.03 + Math.random() * 0.04;
            p.r0 = p.r1 = 0.09; p.g0 = p.g1 = 0.085; p.b0 = p.b1 = 0.08; p.a0 = 0.85; p.a1 = 0.6;
            p.sprite = Sprite.Chunk;
            p.spin = (Math.random() - 0.5) * 4;
            lib.alpha.spawn(p);
          }
        }
        break;
      }
      case 'sporefall': {
        this.acc[4] += 500 * L * S * dt;
        let n = Math.min(budget, Math.floor(this.acc[4]));
        this.acc[4] -= n;
        const p = resetP();
        while (n-- > 0) {
          const a = Math.random() * 6.2832, r = 26 * Math.sqrt(Math.random());
          const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
          let g = this.ground(x, z);
          if (Number.isNaN(g)) g = surface;
          p.x = x; p.y = g + Math.random() * 8; p.z = z;
          p.vx = wx * 0.4; p.vy = 0.15 + Math.random() * 0.2; p.vz = wz * 0.4;
          p.life = 5 + Math.random() * 4;
          p.size0 = 0.03 + Math.random() * 0.04; p.size1 = p.size0 * 0.5;
          const cyan = Math.random() < 0.5;
          p.r0 = cyan ? 0.4 : 0.8; p.g0 = cyan ? 1.8 : 1.6; p.b0 = cyan ? 1.6 : 0.3; p.a0 = 0.9;
          p.r1 = p.r0 * 0.5; p.g1 = p.g0 * 0.5; p.b1 = p.b0 * 0.5; p.a1 = 0;
          p.sprite = Sprite.Glow;
          p.turb = 1.1;
          lib.add.spawn(p);
        }
        break;
      }
      case 'fog': {
        this.acc[5] += 28 * L * S * dt;
        let n = Math.min(budget, Math.floor(this.acc[5]));
        this.acc[5] -= n;
        const p = resetP();
        while (n-- > 0) {
          const a = Math.random() * 6.2832, r = 8 + 40 * Math.sqrt(Math.random());
          const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
          let g = this.ground(x, z);
          if (Number.isNaN(g)) g = surface;
          p.x = x; p.y = g + 0.6 + Math.random() * 3; p.z = z;
          p.vx = wx * 0.5 + (Math.random() - 0.5) * 0.3; p.vy = 0; p.vz = wz * 0.5 + (Math.random() - 0.5) * 0.3;
          p.life = 9 + Math.random() * 6;
          p.size0 = 5 + Math.random() * 5; p.size1 = p.size0 * 1.4;
          p.rot = Math.random() * 6.28; p.spin = (Math.random() - 0.5) * 0.1;
          p.r0 = p.r1 = 0.82; p.g0 = p.g1 = 0.85; p.b0 = p.b1 = 0.88; p.a0 = 0.09 * L; p.a1 = 0;
          p.sprite = Sprite.Smoke;
          lib.alpha.spawn(p);
        }
        break;
      }
    }
    this.spawnedLastFrame = Math.round(MAX_PER_FRAME * Math.min(1, S)) - budget;
  }

  /** Rain streaks and ground splashes. Returns the remaining spawn budget. */
  private rain(dt: number, cam: THREE.Vector3, surface: number, rate: number, storm: boolean, wx: number, wz: number, budget: number): number {
    const lib = this.lib;
    this.acc[0] += rate * dt;
    let n = Math.min(budget, Math.floor(this.acc[0]));
    this.acc[0] -= n;
    budget -= n;
    const p = resetP();
    while (n-- > 0) {
      const a = Math.random() * 6.2832, r = 38 * Math.sqrt(Math.random());
      // Spawn upwind so slanted rain still covers the camera.
      const x = cam.x + Math.cos(a) * r - wx * 4, z = cam.z + Math.sin(a) * r - wz * 4;
      let g = this.ground(x, z);
      if (Number.isNaN(g)) g = surface;
      const y = Math.max(cam.y, g) + 10 + Math.random() * 14;
      const vy = -(14 + Math.random() * 4) * (storm ? 1.15 : 1);
      p.x = x; p.y = y; p.z = z;
      p.vx = wx * (storm ? 3.5 : 2); p.vy = vy; p.vz = wz * (storm ? 3.5 : 2);
      p.life = Math.max(0.05, (y - g) / -vy);
      p.size0 = p.size1 = 0.012 + Math.random() * 0.008;
      p.r0 = p.r1 = 0.75; p.g0 = p.g1 = 0.8; p.b0 = p.b1 = 0.9; p.a0 = 0.42; p.a1 = 0.35;
      p.sprite = Sprite.Streak;
      p.stretch = 0.03;
      lib.alpha.spawn(p);
    }
    // Splashes: tiny droplets and a short-lived ring on the ground.
    this.acc[1] += rate * 0.22 * dt;
    let m = Math.min(budget, Math.floor(this.acc[1]));
    this.acc[1] -= m;
    budget -= m;
    while (m-- > 0) {
      const a = Math.random() * 6.2832, r = 22 * Math.sqrt(Math.random());
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      const g = this.ground(x, z);
      if (Number.isNaN(g)) continue;
      resetP();
      P.x = x; P.y = g + 0.04; P.z = z;
      P.life = 0.22;
      P.size0 = 0.03; P.size1 = 0.16;
      P.r0 = P.g0 = P.b0 = 0.8; P.a0 = 0.35; P.r1 = P.g1 = P.b1 = 0.8; P.a1 = 0;
      P.sprite = Sprite.Ring;
      lib.alpha.spawn(P);
      P.vx = (Math.random() - 0.5) * 1.2; P.vy = 1.6 + Math.random(); P.vz = (Math.random() - 0.5) * 1.2;
      P.size0 = P.size1 = 0.015; P.life = 0.3; P.gravity = 12; P.sprite = Sprite.Glow; P.a0 = 0.5;
      lib.alpha.spawn(P);
    }
    return budget;
  }

  private storm(dt: number, cam: THREE.Vector3, L: number, _time: number) {
    this.nextBolt -= dt;
    if (this.nextBolt > 0) return;
    this.nextBolt = 3 + Math.random() * (12 - 8 * L);
    const a = Math.random() * 6.2832, d = 70 + Math.random() * 260;
    const x = cam.x + Math.cos(a) * d, z = cam.z + Math.sin(a) * d;
    const g = this.gen.cachedColumn(x, z).height;
    this.bolt(x, g, z, cam.y + 160 + Math.random() * 80);
    this.thunder.push({ t: d / 340, x, y: g, z, vol: Math.max(0.25, 1 - d / 400) });
  }

  /** A lightning strike from `top` down to the ground at (x, g, z). Public for the sandbox. */
  bolt(x: number, g: number, z: number, top: number) {
    const lib = this.lib;
    const from = new THREE.Vector3(x + (Math.random() - 0.5) * 30, top, z + (Math.random() - 0.5) * 30);
    const to = new THREE.Vector3(x, g, z);
    lib.beams.spawn(from, to, BeamKind.Lightning, [5, 5.5, 8], 1.6, 0.32);
    // Branches.
    const mid = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      mid.lerpVectors(from, to, 0.2 + Math.random() * 0.5);
      const end = mid.clone().add(new THREE.Vector3((Math.random() - 0.5) * 50, -20 - Math.random() * 30, (Math.random() - 0.5) * 50));
      lib.beams.spawn(mid, end, BeamKind.Lightning, [3, 3.5, 5.5], 0.7, 0.22);
    }
    lib.lights.flash(x, g + 15, z, [0.8, 0.85, 1], 900, 400, 0.35);
    this.flash = 1;
    this.flicker = 0;
  }

  dispose() {
    this.sky.removeFromParent();
  }
}
