/**
 * Standalone turntable preview for the character creator / paper doll:
 * its own renderer on the given canvas, studio lighting (key, fill, rim,
 * soft environment), a single full-detail humanoid with equipment, focus
 * presets (body / face) with smooth camera moves, and pose presets.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { HumanoidAppearance } from '../types';
import type { EquipmentVisuals } from '../../items/types';
import type { AnimState, MoveState } from '../../shared/types';
import { BodyService } from './BodyService';
import { HumanoidRig } from './HumanoidRig';
import { ACTIONS } from './anim/actions';

/** Pose presets understood by setPose (any action id from the animation set also works, looped). */
const POSES: Record<string, { move: MoveState; speed?: number; action?: string; combat?: boolean; mood?: AnimState['mood'] }> = {
  idle: { move: 'idle' },
  walk: { move: 'walk', speed: 1.4 },
  run: { move: 'run', speed: 4.2 },
  combat: { move: 'idle', combat: true, mood: 'focused' },
  cast: { move: 'idle', action: 'channel', mood: 'focused' },
  wave: { move: 'idle', action: 'gesture_wave', mood: 'happy' },
  cheer: { move: 'idle', action: 'cheer', mood: 'happy' },
  sit: { move: 'sit' },
  crouch: { move: 'crouch' },
  dance: { move: 'idle', action: 'dance', mood: 'happy' },
  talk: { move: 'idle', action: 'talk' },
};

export class HumanoidPreview {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.03, 50);
  private rig: HumanoidRig | null = null;
  private app: HumanoidAppearance | null = null;
  private equipment: EquipmentVisuals | undefined;
  private focus: 'body' | 'face' = 'body';
  private yaw = 0;
  private pose = 'idle';
  private poseT0 = 0;
  private time = 0;
  private raf = 0;
  private clock = new THREE.Clock();
  private camPos = new THREE.Vector3(0, 1.2, -4);
  private camTarget = new THREE.Vector3(0, 1, 0);
  private lookTarget = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3();
  private ro: ResizeObserver | null = null;
  private disposed = false;

  constructor(readonly canvas: HTMLCanvasElement) {}

  /** Must be awaited once before use (loads human assets). */
  async ready(): Promise<void> {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    const key = new THREE.DirectionalLight(0xfff0e0, 2.8);
    key.position.set(-2.5, 4, -3.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.8);
    fill.position.set(3, 2, -2);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(1.5, 3, 4);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xd8e4ff, 0x40362c, 0.5));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 48), new THREE.ShadowMaterial({ opacity: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.resize();
    await BodyService.get().ready();
    this.loop();
  }

  setAppearance(a: HumanoidAppearance) {
    this.app = a;
    if (!this.rig) {
      this.rig = new HumanoidRig(a, { fixedLod: 0, alwaysDrawn: true, castShadow: true });
      this.rig.setEquipment(this.equipment);
      this.scene.add(this.rig.object);
    } else void this.rig.setAppearance(a);
  }

  setEquipment(e: EquipmentVisuals) {
    this.equipment = e;
    this.rig?.setEquipment(e);
  }

  /** Camera focus: whole body or face close-up. */
  setFocus(f: 'body' | 'face') {
    this.focus = f;
  }

  /** Rotate model (radians). */
  setYaw(y: number) {
    this.yaw = y;
  }

  /** Play an idle/pose animation by id. */
  setPose(p: string) {
    this.pose = p;
    this.poseT0 = this.time;
  }

  private resize() {
    const r = this.renderer;
    if (!r) return;
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    const rig = this.rig;
    if (rig) {
      const preset = POSES[this.pose] ?? { move: 'idle' as MoveState, action: ACTIONS[this.pose] ? this.pose : undefined };
      const dur = preset.action ? (ACTIONS[preset.action]?.loop ? 2.5 : 2.2) : 0;
      const t0 = preset.action ? this.poseT0 + Math.floor((this.time - this.poseT0) / (dur + 0.6)) * (dur + 0.6) : 0;
      const sp = preset.speed ?? 0;
      // Treadmill: velocity along the facing direction, position fixed.
      const vx = -Math.sin(this.yaw) * sp, vz = -Math.cos(this.yaw) * sp;
      const h = rig.height;
      const lookAt: [number, number, number] = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
      rig.update({
        pos: [0, 0, 0], vel: [vx, 0, vz], yaw: this.yaw, flags: preset.combat ? 4 : 0,
        anim: { move: preset.move, action: preset.action ? { id: preset.action, t0, dur } : undefined, mood: preset.mood, lookAt: this.focus === 'face' ? lookAt : undefined },
      }, dt, this.time);
      // Aspect-aware framing: fit a box (height × width, centred at cy) in both
      // the vertical and horizontal field of view.
      let boxH: number, boxW: number, cy: number;
      const headBone = rig.char?.bone('head');
      if (this.focus === 'face' && headBone) {
        headBone.getWorldPosition(this.tmp);
        const neckToTop = Math.max(0.12, h - this.tmp.y);
        // Head, neck and the top of the shoulders (horns/hair add a little headroom).
        boxH = neckToTop * 2.3;
        boxW = neckToTop * 1.55;
        cy = this.tmp.y + neckToTop * 0.38;
      } else {
        boxH = h * 1.1;
        boxW = h * 0.62;
        cy = h * 0.5;
      }
      const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const d = Math.max(boxH / 2 / tanV, boxW / 2 / (tanV * Math.max(0.2, this.camera.aspect)));
      this.camTarget.set(0, cy, 0);
      this.camPos.set(Math.sin(0.12) * d, cy + d * 0.04, -Math.cos(0.12) * d);
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(this.camPos, k);
    this.lookTarget.lerp(this.camTarget, k);
    this.camera.lookAt(this.lookTarget);
    this.renderer?.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.rig?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }
}
