/** WebGL renderer, scene graph, camera and post effects. */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export interface GraphicsSettings {
  pixelRatio: number;
  bloom: boolean;
  shadows: boolean;
  shadowMapSize: number;
  viewDistance: number; // splitFactor scale for terrain
  antialias: boolean;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
  bloom: true,
  shadows: true,
  shadowMapSize: 2048,
  viewDistance: 1.6,
  antialias: true,
};

/**
 * Shader programs are released by three.js when the last material using them is
 * disposed. Entities (creatures, NPCs, items, effects) spawn and despawn all the
 * time, so their programs got deleted and recompiled again and again — on Windows
 * (ANGLE/D3D) each compile stalls a frame for 0.2–0.8 s. Disposal is deferred
 * through a bounded graveyard so recently used programs stay alive; materials
 * hold no large GPU resources themselves (textures/geometry are disposed normally).
 */
function installMaterialGraveyard(limit = 400) {
  const proto = THREE.Material.prototype as THREE.Material & { __norgoGraveyard?: boolean };
  if (proto.__norgoGraveyard) return;
  proto.__norgoGraveyard = true;
  const realDispose = proto.dispose;
  const graveyard: THREE.Material[] = [];
  const buried = new WeakSet<THREE.Material>();
  proto.dispose = function (this: THREE.Material) {
    if (buried.has(this)) return;
    buried.add(this);
    graveyard.push(this);
    if (graveyard.length > limit) realDispose.call(graveyard.shift()!);
  };
}

/** Layer that neither the camera nor the shadow pass renders: objects wait here for their shaders. */
const GATE_LAYER = 31;
const GATE_MASK = 1 << GATE_LAYER;
const SHADOW_SIDE: Record<number, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
type Drawable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite;
const isDrawable = (o: THREE.Object3D): o is Drawable =>
  !!((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite);
const materialsOf = (o: Drawable): THREE.Material[] => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);

let activeGate: ShaderGate | null = null;
let addPatched = false;

/**
 * Shaders are never essential for a frame: anything that joins the scene with a
 * material whose program isn't compiled yet is parked on a hidden layer (skipped
 * by the camera and the shadow pass) while its programs — including the shadow
 * depth variant, which three would otherwise compile synchronously in the shadow
 * pass — compile in parallel (KHR_parallel_shader_compile). It appears as soon as
 * they are ready, usually a few frames later, instead of freezing the frame.
 *
 * Objects flagged `userData.noShaderGate` (the local player) are never parked.
 */
export class ShaderGate {
  /** Off during loading (the warm-up compiles everything up front). */
  enabled = false;
  private readyMain = new WeakSet<THREE.Material>();
  private readyDepth = new WeakSet<THREE.Material>();
  /** Stand-ins for three's internal shadow depth material (same program key). */
  private depthStandIns = new WeakMap<THREE.Material, THREE.MeshDepthMaterial>();
  /**
   * Stand-in render target for compiling. Programs bake the target into their key:
   * drawing into a target means linear output and no tone mapping. Shadow maps always
   * render into one, and so does the main scene whenever three's output buffer is in use
   * (tone mapping or effects): it draws the scene into an internal HDR target and applies
   * tone mapping and colour conversion only in the final pass.
   */
  private offscreen = new THREE.WebGLRenderTarget(1, 1);

  constructor(private core: RenderCore) {
    activeGate = this;
    if (addPatched) return;
    addPatched = true;
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
      const r = add.apply(this, objects);
      if (activeGate?.enabled) activeGate.onAdded(this, objects);
      return r;
    };
  }

  private onAdded(parent: THREE.Object3D, objects: THREE.Object3D[]) {
    let root = parent;
    while (root.parent) root = root.parent;
    if (root !== this.core.scene) return;
    for (const o of objects) if (o && o !== parent && o.parent === parent) this.admit(o);
  }

  /**
   * Safety net before each frame: catches what the add hook can't see — materials
   * swapped on objects already in the scene (LOD switches, effects), objects
   * made visible later, shadows switched on. Visible subtrees only; ~0.3 ms.
   */
  scan(o: THREE.Object3D = this.core.scene) {
    if (!o.visible || o.userData.noShaderGate) return;
    if (isDrawable(o) && o.layers.mask !== GATE_MASK && this.needs(o)) {
      this.park([o], o);
      return;
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) this.scan(ch[i]);
  }

  private needs(o: Drawable) {
    const m = o.material;
    if (!Array.isArray(m)) return !!m && (!this.readyMain.has(m) || (this.castsShadow(o) && !this.readyDepth.has(m)));
    for (const x of m) if (!this.readyMain.has(x) || (this.castsShadow(o) && !this.readyDepth.has(x))) return true;
    return false;
  }

  /** Hide drawables until `root`'s programs are compiled, then restore their layers. */
  private park(drawables: Drawable[], root: THREE.Object3D) {
    const saved = drawables.map((d) => d.layers.mask);
    for (const d of drawables) d.layers.mask = GATE_MASK;
    this.compile(root).then(() => {
      drawables.forEach((d, i) => {
        if (d.layers.mask === GATE_MASK) d.layers.mask = saved[i];
      });
    });
  }

  private castsShadow(o: THREE.Object3D) {
    return o.castShadow && this.core.renderer.shadowMap.enabled;
  }

  /** Park an object until its programs are compiled (no-op when they already are). */
  admit(obj: THREE.Object3D) {
    const drawables: Drawable[] = [];
    let needed = false;
    let skip = false;
    obj.traverse((o) => {
      if (o.userData.noShaderGate) skip = true;
      if (!isDrawable(o) || o.layers.mask === GATE_MASK) return;
      drawables.push(o);
      if (!needed && this.needs(o)) needed = true;
    });
    // Park the whole subtree, so no half-built object (armour without body) shows.
    if (needed && !skip) this.park(drawables, obj);
  }

  /** Compile all programs (main and shadow depth) for an object, in parallel. */
  compile(obj: THREE.Object3D, timeoutMs = 3000): Promise<void> {
    const r = this.core.renderer;
    const main: THREE.Material[] = [];
    const depth: THREE.Material[] = [];
    const proxies = new THREE.Group();
    const seen = new Set<string>();
    obj.traverse((o) => {
      if (!isDrawable(o)) return;
      for (const m of materialsOf(o)) {
        main.push(m);
        if (!this.castsShadow(o) || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) continue;
        const d = this.depthMaterialFor(o, m);
        const im = o as THREE.InstancedMesh;
        const key = `${d.uuid}|${!!im.isInstancedMesh}|${!!im.instanceColor}|${!!(o as THREE.SkinnedMesh).isSkinnedMesh}|${!!(o as THREE.Mesh).morphTargetInfluences}`;
        depth.push(m);
        if (seen.has(key)) continue;
        seen.add(key);
        // A stand-in that shares everything with the real object except its material.
        const proxy = Object.create(o) as THREE.Mesh;
        proxy.material = d;
        proxy.children = [];
        proxy.parent = proxies;
        proxies.children.push(proxy);
      }
    });
    // Main programs: compiled for whatever the scene really renders into (see `offscreen`).
    const jobs: Promise<unknown>[] = [];
    {
      const prev = r.getRenderTarget();
      if (this.core.usesOutputBuffer()) r.setRenderTarget(this.offscreen);
      try {
        jobs.push(r.compileAsync(obj, this.core.camera, this.core.scene));
      } finally {
        r.setRenderTarget(prev);
      }
    }
    if (proxies.children.length) {
      // The shadow pass draws without a scene: no fog, and into a render target.
      const scene = this.core.scene;
      const prev = r.getRenderTarget();
      const fog = scene.fog;
      r.setRenderTarget(this.offscreen);
      scene.fog = null;
      try {
        jobs.push(r.compileAsync(proxies, this.core.camera, scene));
      } finally {
        scene.fog = fog;
        r.setRenderTarget(prev);
      }
    }
    const done = Promise.all(jobs).then(() => undefined, () => undefined);
    // Marked ready even after a timeout or error, so nothing is parked over and over.
    return Promise.race([done, new Promise<void>((res) => setTimeout(res, timeoutMs))]).then(() => {
      for (const m of main) this.readyMain.add(m);
      for (const m of depth) this.readyDepth.add(m);
    });
  }

  /** The material three's shadow pass will draw this object with, configured the same way. */
  private depthMaterialFor(o: THREE.Object3D, m: THREE.Material): THREE.Material {
    let d: THREE.Material | undefined = o.customDepthMaterial;
    if (!d) {
      d = this.depthStandIns.get(m);
      if (!d) this.depthStandIns.set(m, (d = new THREE.MeshDepthMaterial()) as THREE.MeshDepthMaterial);
    }
    const src = m as THREE.MeshStandardMaterial;
    const dst = d as THREE.MeshDepthMaterial;
    dst.visible = m.visible;
    dst.wireframe = !!src.wireframe;
    dst.side = m.shadowSide ?? SHADOW_SIDE[m.side];
    dst.alphaMap = src.alphaMap ?? null;
    dst.alphaTest = m.alphaToCoverage ? 0.5 : m.alphaTest;
    dst.map = src.map ?? null;
    dst.clipShadows = m.clipShadows;
    dst.clippingPlanes = m.clippingPlanes;
    dst.clipIntersection = m.clipIntersection;
    dst.displacementMap = src.displacementMap ?? null;
    dst.displacementScale = src.displacementScale ?? 1;
    dst.displacementBias = src.displacementBias ?? 0;
    return d;
  }
}

export class RenderCore {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly shaders: ShaderGate;
  private bloom: UnrealBloomPass | null = null;
  settings: GraphicsSettings;

  constructor(container: HTMLElement, settings: Partial<GraphicsSettings> = {}) {
    installMaterialGraveyard();
    this.settings = { ...DEFAULT_GRAPHICS, ...settings };
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: true,
      outputBufferType: THREE.HalfFloatType,
    } as THREE.WebGLRendererParameters);
    this.canvas = this.renderer.domElement;
    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.canvas);
    this.camera = new THREE.PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.15, 16000);
    this.scene.add(this.camera);
    this.applyEffects(container.clientWidth, container.clientHeight);
    window.addEventListener('resize', () => this.resize(container));
    this.shaders = new ShaderGate(this);
  }

  private effectCount = 0;

  /**
   * Whether three renders the scene through its output buffer (an internal HDR target,
   * tone-mapped in a final pass) rather than straight to the canvas. Mirrors
   * WebGLOutput.begin(): used whenever tone mapping is on or any effect is set.
   */
  usesOutputBuffer(): boolean {
    return this.renderer.toneMapping !== THREE.NoToneMapping || this.effectCount > 0;
  }

  private applyEffects(w: number, h: number) {
    const effects: unknown[] = [];
    if (this.settings.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.6, 0.92);
      effects.push(this.bloom);
    } else this.bloom = null;
    if (this.settings.antialias) effects.push(new SMAAPass());
    (this.renderer as unknown as { setEffects(e: unknown[]): void }).setEffects(effects);
    this.effectCount = effects.length;
  }

  setBloomStrength(s: number) {
    if (this.bloom) this.bloom.strength = s;
  }

  updateSettings(s: Partial<GraphicsSettings>, container: HTMLElement) {
    this.settings = { ...this.settings, ...s };
    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.resize(container);
    this.applyEffects(container.clientWidth, container.clientHeight);
  }

  resize(container: HTMLElement) {
    const w = container.clientWidth, h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    if (this.shaders.enabled) this.shaders.scan();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Compile an object's shaders (including shadow variants) without stalling,
   * using the scene's lights. Resolves when they are ready (or after a timeout).
   */
  precompile(object: THREE.Object3D, timeoutMs = 4000): Promise<void> {
    return this.shaders.compile(object, timeoutMs);
  }
}
