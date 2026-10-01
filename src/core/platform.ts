/**
 * Platform & capabilities: the single place that knows what device and browser
 * the game runs on and what it can do. Everything else asks here instead of
 * sniffing user agents or probing features on its own.
 *
 *  - Device:   form factor (desktop / tablet / phone), iPad (iPadOS reports a Mac
 *              user agent, so touch points decide), Safari/WebKit, Android.
 *  - Input:    touch, fine pointer (mouse/trackpad), hover; plus the *live* input
 *              mode — whatever the player used last — so touch controls can appear
 *              when the screen is touched and fade when a mouse or keyboard is used.
 *  - Hardware: CPU cores, device memory hint, pixel ratio, screen size.
 *  - Graphics: WebGL2 extensions that matter for the renderer (attached once the
 *              renderer's context exists: `attachGL`).
 *  - Audio:    which compressed formats the browser says it can decode.
 *
 * Browser-only module (no-op safe defaults when `window` is missing, e.g. in workers
 * or Node tests).
 *
 * Testing fallbacks without the device: `?caps=<flag,flag…>` pretends capabilities are
 * missing (see `DEBUG_CAPS`), e.g. `?caps=noclip,nohalf,noparallel,noopus,tablet`. GL
 * extensions are hidden from the context itself (so three.js takes its real fallback
 * paths too), not just from this module's report.
 */

export type FormFactor = 'desktop' | 'tablet' | 'phone';
export type InputMode = 'touch' | 'mouse';

export interface GpuCaps {
  webgl2: boolean;
  /** EXT_clip_control: needed for three's reversed depth buffer. */
  clipControl: boolean;
  /**
   * Rendering into half-float targets (HDR output buffer / effects): the extension is
   * advertised *and* an RGBA16F framebuffer actually reports complete.
   */
  colorBufferHalfFloat: boolean;
  colorBufferFloat: boolean;
  /** OES_texture_float_linear: linear filtering of 32-bit float textures. */
  floatLinear: boolean;
  /** KHR_parallel_shader_compile: background shader compiles. */
  parallelCompile: boolean;
  maxTextureSize: number;
  maxSamples: number;
  /** Unmasked GPU name when the browser exposes it ('' otherwise). */
  renderer: string;
  /**
   * Apple GPU (iPad/iPhone/Apple-silicon Mac, via ANGLE-Metal). Tile-based; Metal has no
   * 24-bit depth format there, so depth buffers are 32-bit float already.
   */
  apple: boolean;
}

/**
 * Debug capability overrides (`?caps=a,b`), for testing fallbacks on a desktop:
 *  noclip       hide EXT_clip_control            → standard depth buffer
 *  nohalf       hide EXT_color_buffer_(half_)float → 8-bit output, no bloom/SMAA
 *  noparallel   hide KHR_parallel_shader_compile → paced shader gate
 *  nofloatlinear hide OES_texture_float_linear   → half-float data textures
 *  nofloatdepth keep the default 24-bit scene depth (no float depth upgrade)
 *  noopus       canPlayType + decode test fail for Ogg Opus → generative-only score
 *  nowakelock / nofullscreen  pretend those APIs are missing
 *  tablet / phone             pretend the form factor (device profile + budgets)
 */
export const DEBUG_CAPS: ReadonlySet<string> = new Set(
  typeof location !== 'undefined'
    ? (new URLSearchParams(location.search).get('caps') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [],
);

const HIDDEN_GL_EXTENSIONS: Record<string, string[]> = {
  noclip: ['EXT_clip_control'],
  nohalf: ['EXT_color_buffer_half_float', 'EXT_color_buffer_float'],
  noparallel: ['KHR_parallel_shader_compile'],
  nofloatlinear: ['OES_texture_float_linear'],
};

/** Hide extensions from every WebGL context (debug only; installed before any context exists). */
function installGlOverrides() {
  const hidden = new Set<string>();
  for (const [flag, names] of Object.entries(HIDDEN_GL_EXTENSIONS)) if (DEBUG_CAPS.has(flag)) names.forEach((n) => hidden.add(n));
  if (!hidden.size || typeof WebGL2RenderingContext === 'undefined') return;
  type ExtApi = { getExtension(name: string): unknown; getSupportedExtensions(): string[] | null };
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype] as unknown as ExtApi[]) {
    const get = proto.getExtension;
    const list = proto.getSupportedExtensions;
    proto.getExtension = function (this: ExtApi, name: string) {
      return hidden.has(name) ? null : get.call(this, name);
    };
    proto.getSupportedExtensions = function (this: ExtApi) {
      return list.call(this)?.filter((n) => !hidden.has(n)) ?? null;
    };
  }
  console.info('[platform] debug: hiding GL extensions', [...hidden].join(', '));
}
installGlOverrides();

export interface AudioCaps {
  oggOpus: boolean;
  webmOpus: boolean;
  mp4Aac: boolean;
}

const hasWindow = typeof window !== 'undefined' && typeof navigator !== 'undefined';

function mq(q: string): boolean {
  return hasWindow && typeof matchMedia === 'function' ? matchMedia(q).matches : false;
}

function detect() {
  const ua = hasWindow ? navigator.userAgent : '';
  const touchPoints = hasWindow ? navigator.maxTouchPoints || 0 : 0;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const iphone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  const ios = ipad || iphone;
  const touch = touchPoints > 0 || mq('(any-pointer: coarse)');
  const finePointer = mq('(any-pointer: fine)');
  const hover = mq('(any-hover: hover)');
  const sw = hasWindow ? Math.min(screen.width, screen.height) : 1080;
  let formFactor: FormFactor = ipad || (touch && !finePointer && sw >= 600) ? 'tablet' : (iphone || (android && sw < 600) ? 'phone' : 'desktop');
  if (DEBUG_CAPS.has('tablet')) formFactor = 'tablet';
  else if (DEBUG_CAPS.has('phone')) formFactor = 'phone';
  return {
    ua,
    ipad,
    ios,
    android,
    /** Safari or any iOS/iPadOS browser (all use WebKit there). */
    webkit: webkit || ios,
    touch,
    finePointer,
    hover,
    formFactor,
    cores: hasWindow ? navigator.hardwareConcurrency || 4 : 4,
    /** Rough device memory in GB (Chrome only; undefined on Safari). */
    memoryGB: hasWindow ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined,
    pixelRatio: hasWindow ? window.devicePixelRatio || 1 : 1,
    /** Running as an installed web app (home-screen / standalone). */
    standalone: mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || (hasWindow && (navigator as Navigator & { standalone?: boolean }).standalone === true),
  };
}

function audioCaps(): AudioCaps {
  if (!hasWindow || typeof document === 'undefined') return { oggOpus: true, webmOpus: true, mp4Aac: true };
  const a = document.createElement('audio');
  const ok = (t: string) => a.canPlayType(t) !== '';
  const noOpus = DEBUG_CAPS.has('noopus');
  return { oggOpus: !noOpus && ok('audio/ogg; codecs="opus"'), webmOpus: !noOpus && ok('audio/webm; codecs="opus"'), mp4Aac: ok('audio/mp4; codecs="mp4a.40.2"') };
}

/** Does an RGBA16F colour attachment really work? (Extension strings have lied before.) Restores bindings. */
function halfFloatRenderable(gl: WebGL2RenderingContext): boolean {
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
  }
}

class Platform {
  readonly info = detect();
  readonly audio: AudioCaps = audioCaps();
  gpu: GpuCaps | null = null;
  private mode: InputMode;
  private listeners = new Set<(m: InputMode) => void>();

  constructor() {
    // Start in touch mode on touch-first devices (no mouse attached), else mouse.
    this.mode = this.info.touch && !this.info.finePointer ? 'touch' : 'mouse';
    if (!hasWindow) return;
    const set = (m: InputMode) => {
      if (m === this.mode) return;
      this.mode = m;
      document.documentElement.dataset.input = m;
      for (const l of this.listeners) l(m);
    };
    document.documentElement.dataset.input = this.mode;
    document.documentElement.dataset.form = this.info.formFactor;
    addEventListener('pointerdown', (e) => set(e.pointerType === 'touch' || e.pointerType === 'pen' ? 'touch' : 'mouse'), { capture: true, passive: true });
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) set('mouse');
    }, { capture: true, passive: true });
    addEventListener('keydown', (e) => {
      // A hardware keyboard means desktop-style play (ignore the on-screen keyboard's Enter etc.).
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) set('mouse');
    }, { capture: true });
  }

  /** Current input mode: what the player used last. */
  get inputMode(): InputMode {
    return this.mode;
  }

  /** Subscribe to input-mode changes; returns an unsubscribe function. */
  onInputMode(fn: (m: InputMode) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Touch-first device (tablet or phone without a mouse attached at start). */
  get touchFirst(): boolean {
    return this.info.touch && !this.info.finePointer;
  }

  /** Record the renderer's WebGL capabilities (called once by RenderCore with its live context). */
  attachGL(gl: WebGL2RenderingContext | WebGLRenderingContext): GpuCaps {
    this.gpu = Platform.readCaps(gl);
    return this.gpu;
  }

  /**
   * GPU capabilities *before* a renderer exists (the renderer's constructor options depend
   * on them: reversed depth, output buffer type). Uses a throwaway WebGL2 context that is
   * released right away; returns the attached caps instead once a renderer reported them.
   */
  probeGL(): GpuCaps {
    if (this.gpu) return this.gpu;
    if (this.probed) return this.probed;
    let caps: GpuCaps | null = null;
    if (hasWindow && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const gl = canvas.getContext('webgl2', { antialias: false, depth: true, powerPreference: 'high-performance' });
      if (gl) {
        caps = Platform.readCaps(gl);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
    this.probed = caps ?? {
      webgl2: false, clipControl: false, colorBufferHalfFloat: false, colorBufferFloat: false, floatLinear: false,
      parallelCompile: false, maxTextureSize: 4096, maxSamples: 0, renderer: '', apple: false,
    };
    return this.probed;
  }
  private probed: GpuCaps | null = null;

  private static readCaps(gl: WebGL2RenderingContext | WebGLRenderingContext): GpuCaps {
    const ext = (n: string) => !!gl.getExtension(n);
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const halfExt = ext('EXT_color_buffer_half_float') || ext('EXT_color_buffer_float');
    return {
      webgl2,
      clipControl: ext('EXT_clip_control'),
      colorBufferHalfFloat: halfExt && webgl2 && halfFloatRenderable(gl as WebGL2RenderingContext),
      colorBufferFloat: ext('EXT_color_buffer_float'),
      floatLinear: ext('OES_texture_float_linear'),
      parallelCompile: ext('KHR_parallel_shader_compile'),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxSamples: webgl2 ? (gl.getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES) as number) : 0,
      renderer,
      // Safari reports "Apple GPU"; Chrome on Apple silicon "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 …)".
      apple: /\bApple\b/.test(renderer) || (!renderer && /iPad|iPhone|Macintosh/.test(hasWindow ? navigator.userAgent : '') && /AppleWebKit/.test(hasWindow ? navigator.userAgent : '')),
    };
  }

  /**
   * Decisions and states other modules report for diagnostics (renderer path, stem codec,
   * budgets, context losses…). Keeps this module free of imports from the rest of the game.
   */
  readonly notes: Record<string, unknown> = {};
  note(key: string, value: unknown): void {
    this.notes[key] = value;
  }

  /** Plain snapshot for diagnostics / bug reports. */
  report() {
    return {
      ...this.info,
      inputMode: this.mode,
      debugCaps: [...DEBUG_CAPS],
      secureContext: hasWindow ? window.isSecureContext : false,
      audio: this.audio,
      gpu: this.gpu ?? this.probed,
      notes: this.notes,
    };
  }
}

/** The platform singleton. */
export const platform = new Platform();
