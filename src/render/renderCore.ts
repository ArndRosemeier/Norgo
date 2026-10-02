/**
 * WebGL renderer, scene graph, camera and post effects.
 *
 * Capability-driven setup (decided once from `platform.probeGL()` before the renderer
 * exists, recorded with `platform.attachGL()` afterwards; see docs/ARCHITECTURE.md
 * "Rendering performance rules" → "Capabilities & fallbacks"):
 *  - Depth: reversed-Z (EXT_clip_control) with a 32-bit float scene depth where the GPU
 *    lacks one by default; without clip control the standard depth range with the same
 *    near/far (see `RenderCore.depthMode`).
 *  - Colour: HDR half-float output buffer (tone mapping in the final pass, bloom + SMAA as
 *    `setEffects`) when RGBA16F is renderable; otherwise an 8-bit path with tone mapping in
 *    the materials and no post effects.
 *  - Shader gate: parallel compiles with KHR_parallel_shader_compile, else paced (one
 *    object per frame within a small time budget) so the gate never bunches stalls.
 *  - Context loss (iOS reclaims GPU memory of background tabs): rendering pauses until the
 *    context is restored; modules re-create GPU-only content via `onContextRestored`.
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { platform, DEBUG_CAPS, type GpuCaps } from '../core/platform';
import { budgets } from '../core/budgets';

export interface GraphicsSettings {
  pixelRatio: number;
  bloom: boolean;
  shadows: boolean;
  shadowMapSize: number;
  viewDistance: number; // splitFactor scale for terrain
  antialias: boolean;
  /** Ground-cover density 0.25..1 (read by FloraSystem when chunks are scattered). */
  vegetation: number;
  /** Weather particles on/off (read by the weather FX every frame). */
  weatherFx: boolean;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  pixelRatio: Math.min(window.devicePixelRatio || 1, budgets.maxPixelRatio),
  bloom: true,
  shadows: true,
  shadowMapSize: 2048,
  viewDistance: 1.6,
  antialias: true,
  vegetation: 1,
  weatherFx: true,
};

/** How depth is stored (diagnostics; see RenderCore constructor for the reasoning). */
export type DepthMode = 'reversed-float32' | 'reversed' | 'standard';

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
  /**
   * Without KHR_parallel_shader_compile every compile+link blocks wherever the driver first
   * needs the result. The gate then *paces* instead: compiles queue up and `pump()` runs
   * them before the frame — at least one object per frame, more while under PACE_MS — and
   * forces each link right there (`getUniforms()`), so the cost lands in a controlled
   * place, spread over frames, and the object appears already linked. Total compile time
   * is unchanged (that's the driver); the gate never adds a stall of its own nor bunches
   * several programs into one frame.
   */
  readonly paced: boolean;
  private queue: (() => void)[] = [];
  private static readonly PACE_MS = 6;

  constructor(private core: RenderCore, parallel: boolean) {
    this.paced = !parallel;
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

  /** Run queued (paced) compiles: called by RenderCore before each frame. */
  pump() {
    if (!this.queue.length) return;
    const t0 = performance.now();
    do this.queue.shift()!();
    while (this.queue.length && performance.now() - t0 < ShaderGate.PACE_MS);
  }

  /** Queued compiles waiting for `pump()` (diagnostics). */
  get pending() {
    return this.queue.length;
  }

  /** Forget compiled state (after a WebGL context loss every program is gone). */
  reset() {
    this.readyMain = new WeakSet();
    this.readyDepth = new WeakSet();
    const q = this.queue;
    this.queue = [];
    for (const job of q) job(); // settle waiting promises; programs are rebuilt on demand
  }

  /**
   * Compile all programs (main and shadow depth) for an object: in parallel when the driver
   * can, otherwise paced through `pump()` once the gate is live (during the loading screen
   * everything compiles at once — nothing is on screen to stall).
   */
  compile(obj: THREE.Object3D, timeoutMs = 3000): Promise<void> {
    if (!this.enabled) return this.compileNow(obj, timeoutMs);
    if (!this.paced) {
      // Parallel compiles still run on the driver's threads: a burst (a new settlement view plus
      // its neighbours, a dozen programs at once) stalled ANGLE/D3D for ~0.6 s. Cap the jobs in
      // flight; objects whose programs already exist finish at once, so the queue moves quickly.
      return new Promise<void>((resolve) => {
        const start = () => {
          this.inflight++;
          this.compileNow(obj, timeoutMs).then(() => {
            this.inflight--;
            resolve();
            this.waiting.shift()?.();
          });
        };
        if (this.inflight < ShaderGate.MAX_PARALLEL_JOBS) start();
        else this.waiting.push(start);
      });
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.compileNow(obj, timeoutMs).then(resolve);
      });
    });
  }

  /** Concurrent compile jobs on the parallel path (see compile). */
  static readonly MAX_PARALLEL_JOBS = 2;
  private inflight = 0;
  private waiting: (() => void)[] = [];

  /**
   * Start compiling `obj` for `scene`. Parallel: three's compileAsync polls completion.
   * Paced: plain compile() — the link is forced right after (compileAsync would only add a
   * 10 ms timer and a "KHR_parallel_shader_compile not supported" warning).
   */
  private compileOne(obj: THREE.Object3D, scene: THREE.Scene): Promise<unknown> {
    const r = this.core.renderer;
    if (!this.paced) return r.compileAsync(obj, this.core.camera, scene);
    r.compile(obj, this.core.camera, scene);
    return Promise.resolve();
  }

  private compileNow(obj: THREE.Object3D, timeoutMs: number): Promise<void> {
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
        jobs.push(this.compileOne(obj, this.core.scene));
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
        jobs.push(this.compileOne(proxies, scene));
      } finally {
        scene.fog = fog;
        r.setRenderTarget(prev);
      }
    }
    if (this.paced) {
      // No background compilation: take the link stall now (inside pump's budget), not mid-frame.
      const props = r.properties;
      const link = (m: THREE.Material) => {
        const p = props.get(m) as { currentProgram?: { getUniforms(): unknown } };
        try {
          p.currentProgram?.getUniforms();
        } catch {
          /* compile errors are reported by three on first use */
        }
      };
      for (const m of main) link(m);
      for (const proxy of proxies.children) for (const m of materialsOf(proxy as Drawable)) link(m);
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
  private smaa: SMAAPass | null = null;
  settings: GraphicsSettings;
  /** Capabilities of the live context (platform.attachGL). */
  readonly caps: GpuCaps;
  /** Depth storage in use (see the constructor for why). */
  readonly depthMode: DepthMode;
  /**
   * HDR half-float output buffer in use. Without it the scene renders straight to the
   * canvas (8-bit, tone mapping in each material) and bloom / SMAA are unavailable.
   */
  readonly hdr: boolean;
  /** The WebGL context is lost (iOS background tab); rendering is paused until restored. */
  contextLost = false;
  private contextLosses = 0;
  private restoreHandlers = new Set<() => void>();

  constructor(container: HTMLElement, settings: Partial<GraphicsSettings> = {}) {
    installMaterialGraveyard();
    this.settings = { ...DEFAULT_GRAPHICS, ...settings };
    // Decide the renderer's constructor options from a capability probe (they can't change later).
    const probe = platform.probeGL();
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      // Without EXT_clip_control three would fall back on its own (with a warning); asking only
      // when it's there keeps the decision visible here and the console clean.
      reversedDepthBuffer: probe.clipControl,
      outputBufferType: probe.colorBufferHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    } as THREE.WebGLRendererParameters);
    this.caps = platform.attachGL(this.renderer.getContext());
    this.canvas = this.renderer.domElement;
    const reversed = this.renderer.capabilities.reversedDepthBuffer;
    this.hdr = probe.colorBufferHalfFloat;
    /*
     * Depth precision with a 0.15 m near plane and a 16 km far plane:
     *  - Reversed-Z only pays off with a *float* depth buffer (float precision is densest near
     *    0, where reversed-Z puts the far range). Apple GPUs (Metal has no 24-bit depth there,
     *    ANGLE allocates Depth32Float) already have one. Elsewhere (D3D: D24) three's scene
     *    target gets a 32F depth texture instead of its D24 renderbuffer (`useFloatDepth`):
     *    error at 5 km ≈ centimetres instead of ≈ 10 m.
     *  - Without EXT_clip_control: the standard depth range with the same near/far. With 24-bit
     *    or float depth that's ≈ z²·6e-8/near → ~0.4 m at 1 km, ~10 m at 5 km — the precision
     *    the D24 desktop path always had (reversed-Z on a D24 buffer is no better than
     *    standard). Distant terrain is a single surface per LOD (no coplanar layers), so this
     *    is acceptable. Not chosen: logarithmic depth writes gl_FragDepth, which disables
     *    early-Z and — on tile-based GPUs like the iPad's — hidden-surface removal for every
     *    material, a large fill-rate cost with dense foliage; a bigger near plane clips the
     *    third-person camera into walls.
     */
    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.sceneTarget = this.captureSceneTarget(() => this.renderer.setSize(container.clientWidth, container.clientHeight));
    const floatDepth = reversed && !this.caps.apple && !DEBUG_CAPS.has('nofloatdepth') && this.useFloatDepth();
    this.depthMode = reversed ? (floatDepth || this.caps.apple ? 'reversed-float32' : 'reversed') : 'standard';
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.canvas);
    this.camera = new THREE.PerspectiveCamera(62, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.15, 16000);
    this.scene.add(this.camera);
    this.applyEffects(container.clientWidth, container.clientHeight);
    window.addEventListener('resize', () => this.resize(container));
    this.shaders = new ShaderGate(this, this.caps.parallelCompile);
    this.canvas.addEventListener('webglcontextlost', () => {
      this.contextLost = true;
      this.contextLosses++;
      this.noteRender();
      console.warn('[render] WebGL context lost; waiting for the browser to restore it');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      // three re-initialises its GL state and re-uploads buffers/textures from their CPU copies;
      // programs must be rebuilt and GPU-only content (render-target captures) redrawn.
      this.contextLost = false;
      this.shaders.reset();
      for (const fn of this.restoreHandlers) {
        try {
          fn();
        } catch (err) {
          console.error('[render] context restore handler failed', err);
        }
      }
      this.noteRender();
      console.info('[render] WebGL context restored');
    });
    this.noteRender();
  }

  /** Run `fn` after a WebGL context loss was restored (re-render GPU-only content). Returns an unsubscribe. */
  onContextRestored(fn: () => void): () => void {
    this.restoreHandlers.add(fn);
    return () => this.restoreHandlers.delete(fn);
  }

  /** three's internal HDR scene target (WebGLOutput), when there is one. */
  private sceneTarget: THREE.WebGLRenderTarget | null = null;

  /**
   * three doesn't expose its output-buffer scene target; it is recognised while `sizing`
   * resizes it (renderer.setSize → WebGLOutput.setSize): the only half-float target with a
   * depth buffer at that point. Null on the 8-bit path (or if three's internals change).
   */
  private captureSceneTarget(sizing: () => void): THREE.WebGLRenderTarget | null {
    const proto = THREE.WebGLRenderTarget.prototype;
    const setSize = proto.setSize;
    let target: THREE.WebGLRenderTarget | null = null;
    proto.setSize = function (this: THREE.WebGLRenderTarget, w: number, h: number, d?: number) {
      if (!target && this.depthBuffer && !this.depthTexture && this.texture.type === THREE.HalfFloatType) target = this;
      return setSize.call(this, w, h, d);
    };
    try {
      sizing();
    } finally {
      proto.setSize = setSize;
    }
    return this.hdr ? target : null;
  }

  /**
   * Give the scene target a 32-bit float depth texture instead of three's default
   * DEPTH_COMPONENT24 renderbuffer — before its first use, so three builds the framebuffer
   * with it and resizes it along with the target. False (nothing changed) when the target
   * isn't available or already initialised.
   */
  private useFloatDepth(): boolean {
    const t = this.sceneTarget;
    if (!t || this.renderer.properties.has(t)) return false;
    const depth = new THREE.DepthTexture(t.width, t.height, THREE.FloatType);
    depth.format = t.stencilBuffer ? THREE.DepthStencilFormat : THREE.DepthFormat;
    t.depthTexture = depth;
    return true;
  }

  private noteRender() {
    platform.note('render', {
      depth: this.depthMode, hdr: this.hdr, effects: this.effectCount, shaderGate: this.shaders?.paced ? 'paced' : 'parallel',
      pixelRatio: this.renderer.getPixelRatio(), contextLost: this.contextLost, contextLosses: this.contextLosses,
    });
  }

  private effectCount = 0;

  /**
   * Whether three renders the scene through its output buffer (an internal HDR target,
   * tone-mapped in a final pass) rather than straight to the canvas. Mirrors
   * WebGLOutput.begin(): used whenever tone mapping is on or any effect is set.
   */
  usesOutputBuffer(): boolean {
    // No HDR output buffer (8-bit fallback): three draws straight to the canvas.
    if (!this.hdr) return false;
    return this.renderer.toneMapping !== THREE.NoToneMapping || this.effectCount > 0;
  }

  /** Bloom and SMAA run as output-buffer effects; unavailable on the 8-bit fallback. */
  get effectsAvailable(): boolean {
    return this.hdr;
  }

  private applyEffects(w: number, h: number) {
    // Rebuilding on every settings change: release the previous passes' render targets first.
    this.bloom?.dispose();
    this.smaa?.dispose();
    this.bloom = null;
    this.smaa = null;
    if (!this.hdr) {
      this.effectCount = 0;
      this.noteRender();
      return;
    }
    const effects: unknown[] = [];
    if (this.settings.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.6, 0.92);
      effects.push(this.bloom);
    }
    if (this.settings.antialias) effects.push((this.smaa = new SMAAPass()));
    (this.renderer as unknown as { setEffects(e: unknown[]): void }).setEffects(effects);
    this.effectCount = effects.length;
    this.noteRender();
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
    // Mid-rotation / hidden layouts can report 0 for a moment; keep the last good size.
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    if (this.contextLost) return;
    if (this.shaders.enabled) {
      this.shaders.pump();
      this.shaders.scan();
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * What the scene's depth attachment really is (diagnostics): asks GL for the component type
   * and size of the target the scene renders into (three's HDR target, or the canvas).
   * Call after at least one frame was rendered.
   */
  depthInfo(): { type: 'float' | 'unorm' | 'unknown'; bits: number } {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const t = this.sceneTarget;
    if (!t || !this.renderer.properties.has(t)) return { type: 'unknown', bits: gl.getParameter(gl.DEPTH_BITS) as number };
    const prev = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(t);
      const q = (p: number) => gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, p) as number;
      const type = q(gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
      return { type: type === gl.FLOAT ? 'float' : type === gl.UNSIGNED_NORMALIZED ? 'unorm' : 'unknown', bits: q(gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE) };
    } catch {
      return { type: 'unknown', bits: 0 };
    } finally {
      this.renderer.setRenderTarget(prev);
    }
  }

  /**
   * Compile an object's shaders (including shadow variants) without stalling,
   * using the scene's lights. Resolves when they are ready (or after a timeout).
   */
  precompile(object: THREE.Object3D, timeoutMs = 4000): Promise<void> {
    return this.shaders.compile(object, timeoutMs);
  }
}
