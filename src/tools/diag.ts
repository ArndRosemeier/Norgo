/**
 * Device diagnostics (`/?diag`): what this browser/device can do and how fast it is, as a
 * page and as a JSON report to paste into a bug report.
 *
 *  - Platform report (device, input, form factor, budgets, notes from the engine).
 *  - WebGL: a RenderCore created exactly like the game's (same capability decisions:
 *    depth mode, HDR output, shader gate mode), real depth attachment format, limits,
 *    extensions.
 *  - Audio: canPlayType matrix, an actual decode of one music stem (OfflineAudioContext,
 *    no gesture needed), the stem codec verdict the game would use, and a tap-to-test
 *    AudioContext unlock (iOS: must start inside the tap).
 *  - Memory hints and worker support.
 *  - Benchmark (button, ~30 s): world-generator speed on the main thread, chunk streaming
 *    through the real worker pool, shader warm-up, and rendering the real terrain + sky +
 *    water + flora with the graphics settings the game would use here.
 */
import * as THREE from 'three';
import { platform } from '../core/platform';
import { budgets } from '../core/budgets';
import { RenderCore } from '../render/renderCore';
import { Environment } from '../render/environment';
import { WorldGenerator, Column } from '../world/generator';
import { TerrainStreamer } from '../world/streamer';
import { createTerrainMaterial, createTerrainTextures } from '../world/terrainMaterial';
import { synthesizeInWorker } from '../world/textureLoader';
import { CHUNK_SIZE } from '../world/constants';
import { Emitter } from '../core/events';
import { StaticColliderStore } from '../client/staticColliders';
import { FloraSystem } from '../flora/client/FloraSystem';
import { applyGraphicsSettings } from '../client/graphics';
import { appShell } from '../client/appShell';
import { loadSettings, deviceGraphicsDefaults } from '../ui/settings';
import { testDecode, probeOggOpus } from '../audio/codecProbe';
import type { ClientContext, ClientEvents } from '../client/context';

type Json = Record<string, unknown>;

const report: Json = { version: 1, time: new Date().toISOString(), url: location.href };

// ---------------------------------------------------------------- page

const CSS = `
.dg{position:fixed;inset:0;overflow:auto;z-index:20;background:#07080b;color:#e8e2d4;font:14px/1.45 Inter,system-ui,sans-serif;
  padding:calc(16px + var(--safe-top,0px)) calc(16px + var(--safe-right,0px)) calc(32px + var(--safe-bottom,0px)) calc(16px + var(--safe-left,0px));
  touch-action:pan-x pan-y;-webkit-user-select:text;user-select:text;overscroll-behavior:contain}
.dg h1{font:700 26px Cinzel,serif;letter-spacing:.18em;color:#d9b56a;margin:0 0 4px}
.dg h2{font:600 13px Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#a79f8c;margin:26px 0 8px;border-bottom:1px solid #2a2830;padding-bottom:6px}
.dg .sub{color:#a79f8c;margin:0 0 14px}
.dg table{border-collapse:collapse;width:100%;max-width:900px}
.dg td{padding:3px 10px 3px 0;vertical-align:top;border-bottom:1px solid #15151b}
.dg td:first-child{color:#a79f8c;white-space:nowrap;width:1%}
.dg .ok{color:#8fd18b}.dg .warn{color:#e6c46a}.dg .bad{color:#ec8a7c}
.dg button,.dg a.btn{display:inline-block;font:600 14px Inter,sans-serif;color:#07080b;background:#d9b56a;border:0;border-radius:8px;padding:10px 16px;margin:0 8px 8px 0;cursor:pointer;text-decoration:none;touch-action:manipulation}
.dg button.ghost,.dg a.btn.ghost{background:#1d1b24;color:#e8e2d4;border:1px solid #3a3644}
.dg button:disabled{opacity:.5}
.dg pre,.dg textarea{width:100%;max-width:900px;box-sizing:border-box;background:#0f0f14;color:#cfc8b8;border:1px solid #2a2830;border-radius:8px;padding:10px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.dg textarea{height:220px}
.dg .stage-note{position:fixed;left:50%;top:calc(14px + var(--safe-top,0px));transform:translateX(-50%);z-index:30;background:rgba(7,8,11,.85);border:1px solid #3a3644;border-radius:8px;padding:8px 14px;font:600 13px Inter,sans-serif;color:#d9b56a}
#dg-stage{position:fixed;inset:0;z-index:5;visibility:hidden}
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);
const stage = document.createElement('div');
stage.id = 'dg-stage';
document.body.appendChild(stage);
const root = document.createElement('div');
root.className = 'dg';
document.body.appendChild(root);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const fmt = (v: unknown): string => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function table(rows: [string, unknown, ('ok' | 'warn' | 'bad')?][]): HTMLTableElement {
  const t = el('table');
  for (const [k, v, tone] of rows) {
    const tr = el('tr');
    tr.append(el('td', k), el('td', fmt(v), tone ?? ''));
    t.append(tr);
  }
  return t;
}
function section(title: string): HTMLElement {
  const s = el('section');
  s.append(el('h2', title));
  root.append(s);
  return s;
}
const yes = (b: boolean, warnIfNo = true): ['ok' | 'warn' | 'bad'] => [b ? 'ok' : warnIfNo ? 'warn' : 'bad'];

root.append(el('h1', 'Norgo diagnostics'));
root.append(el('p', 'Capabilities, budgets and a short benchmark of this device. "Copy report" puts everything on the clipboard as JSON.', 'sub'));
const actions = el('div');
root.append(actions);
const runBtn = el('button', 'Run benchmark (≈ 30 s)');
const copyBtn = el('button', 'Copy report', 'ghost');
const dlBtn = el('button', 'Download JSON', 'ghost');
const toneBtn = el('button', 'Test audio (tap)', 'ghost');
const back = el('a', 'Back to the game', 'btn ghost');
back.href = location.pathname;
actions.append(runBtn, copyBtn, dlBtn, toneBtn, back);

// ---------------------------------------------------------------- summary & platform

const pr = platform.report();
report.platform = pr;
const recommended = deviceGraphicsDefaults();
const configured = loadSettings().graphics;
report.deviceClass = budgets.deviceClass;
report.graphics = { recommended, configured };
{
  const s = section('Device');
  const i = platform.info;
  s.append(table([
    ['Device class', budgets.deviceClass],
    ['Form factor', i.formFactor],
    ['iPad / iOS / Android', `${i.ipad} / ${i.ios} / ${i.android}`],
    ['WebKit', i.webkit],
    ['Touch / fine pointer / hover', `${i.touch} / ${i.finePointer} / ${i.hover}`],
    ['Input mode', platform.inputMode],
    ['CPU cores (reported)', i.cores],
    ['Device memory (GB, Chromium only)', i.memoryGB],
    ['Screen', `${screen.width}×${screen.height} CSS px @ ${devicePixelRatio}× (window ${innerWidth}×${innerHeight})`],
    ['Installed (standalone)', i.standalone],
    ['Secure context', window.isSecureContext, ...yes(window.isSecureContext)],
    ['Debug caps (?caps=)', pr.debugCaps.join(', ') || 'none'],
    ['Recommended preset', `${recommended.preset} (render scale ${recommended.renderScale}, view ${recommended.viewDistance} m, shadows ${recommended.shadows}, vegetation ${recommended.vegetation}, cap ${recommended.maxFps || 'off'} fps)`],
    ['Configured preset', `${configured.preset}${configured.preset === recommended.preset ? '' : ' (saved setting)'}`],
    ['User agent', i.ua],
  ]));
  const b = section('Budgets');
  b.append(table(Object.entries(budgets).map(([k, v]) => [k, /Bytes$/.test(k) ? `${Math.round((v as number) / 1048576)} MB` : v] as [string, unknown])));
}

// ---------------------------------------------------------------- WebGL (a RenderCore like the game's)

let core: RenderCore | null = null;
{
  const s = section('Graphics (WebGL)');
  try {
    core = new RenderCore(stage);
    const gl = core.renderer.getContext() as WebGL2RenderingContext;
    // One frame so three's targets exist, then read back what the depth attachment really is.
    core.render();
    const depth = core.depthInfo();
    const caps = core.caps;
    const p = (n: number) => gl.getParameter(n);
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const timer = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const webgl: Json = {
      version: p(gl.VERSION), glsl: p(gl.SHADING_LANGUAGE_VERSION), vendor: p(gl.VENDOR), renderer: p(gl.RENDERER), unmasked: caps.renderer,
      caps, depthMode: core.depthMode, depthAttachment: depth, hdrOutput: core.hdr, effects: core.effectsAvailable, shaderGate: core.shaders.paced ? 'paced' : 'parallel',
      maxTextureSize: p(gl.MAX_TEXTURE_SIZE), maxRenderbufferSize: p(gl.MAX_RENDERBUFFER_SIZE), maxSamples: p(gl.MAX_SAMPLES),
      maxVertexUniformVectors: p(gl.MAX_VERTEX_UNIFORM_VECTORS), maxFragmentUniformVectors: p(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
      maxVaryingVectors: p(gl.MAX_VARYING_VECTORS), maxTextureImageUnits: p(gl.MAX_TEXTURE_IMAGE_UNITS), maxCombinedTextureImageUnits: p(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      maxDrawBuffers: p(gl.MAX_DRAW_BUFFERS), maxViewportDims: Array.from(p(gl.MAX_VIEWPORT_DIMS) as Int32Array),
      highpFragment: hp ? { precision: hp.precision, rangeMin: hp.rangeMin, rangeMax: hp.rangeMax } : null,
      contextAttributes: gl.getContextAttributes(), timerQuery: timer, extensions: gl.getSupportedExtensions(),
    };
    report.webgl = webgl;
    s.append(table([
      ['GPU', caps.renderer || `${webgl.vendor} ${webgl.renderer}`],
      ['WebGL', `${webgl.version} · ${webgl.glsl}`],
      ['Apple GPU (tile-based, float depth)', caps.apple],
      ['EXT_clip_control (reversed-Z)', caps.clipControl, ...yes(caps.clipControl)],
      ['Depth', `${core.depthMode} · attachment ${depth.type} ${depth.bits}-bit`],
      ['Half-float render targets (HDR)', caps.colorBufferHalfFloat, ...yes(caps.colorBufferHalfFloat)],
      ['Bloom / SMAA available', core.effectsAvailable, ...yes(core.effectsAvailable)],
      ['Float texture linear filtering', caps.floatLinear, ...yes(caps.floatLinear)],
      ['KHR_parallel_shader_compile', caps.parallelCompile, ...yes(caps.parallelCompile)],
      ['Shader gate', core.shaders.paced ? 'paced (one object per frame)' : 'parallel'],
      ['GPU timer queries', timer],
      ['Max texture / samples', `${webgl.maxTextureSize} / ${webgl.maxSamples}`],
      ['Extensions', (webgl.extensions as string[] | null)?.length ?? 0],
    ]));
    const ext = el('pre', ((webgl.extensions as string[] | null) ?? []).join('  '));
    s.append(ext);
  } catch (err) {
    report.webgl = { error: String((err as Error)?.message ?? err) };
    s.append(table([['WebGL', 'failed: ' + (err as Error)?.message, 'bad']]));
  }
}

// ---------------------------------------------------------------- audio

const audioSec = section('Audio');
const audio: Json = {};
report.audio = audio;
{
  const a = document.createElement('audio');
  const types: Record<string, string> = {
    'ogg opus': 'audio/ogg; codecs="opus"', 'ogg vorbis': 'audio/ogg; codecs="vorbis"', 'webm opus': 'audio/webm; codecs="opus"',
    'mp4 aac': 'audio/mp4; codecs="mp4a.40.2"', 'mp4 opus': 'audio/mp4; codecs="opus"', mp3: 'audio/mpeg', 'wav pcm': 'audio/wav; codecs="1"', flac: 'audio/flac',
  };
  const can: Record<string, string> = {};
  for (const [k, t] of Object.entries(types)) can[k] = a.canPlayType(t) || 'no';
  audio.canPlayType = can;
  const session = (navigator as unknown as { audioSession?: { type?: string } }).audioSession;
  audio.audioSession = session ? session.type ?? 'present' : 'unsupported';
  audio.webAudio = typeof AudioContext !== 'undefined' || 'webkitAudioContext' in window;
  audio.offlineAudioContext = typeof OfflineAudioContext !== 'undefined';
  audioSec.append(table([
    ...Object.entries(can).map(([k, v]) => [`canPlayType ${k}`, v, v === 'no' ? 'warn' : 'ok'] as [string, unknown, 'ok' | 'warn']),
    ['Web Audio', audio.webAudio, ...yes(!!audio.webAudio, false)],
    ['navigator.audioSession', audio.audioSession],
  ]));
}
const decodeOut = el('div');
audioSec.append(decodeOut);
const toneOut = el('div');
audioSec.append(toneOut);

async function stemSample(): Promise<string | null> {
  try {
    const base = (import.meta.env.BASE_URL ?? '/') + 'assets/audio/music/';
    const m = (await (await fetch(base + 'manifest.json', { cache: 'no-cache' })).json()) as { sets?: Record<string, { layers?: Record<string, string[]> }> };
    const first = Object.values(m.sets ?? {})[0];
    const p = first?.layers?.drone?.[0] ?? first?.layers?.perc?.[0];
    return p ? base + p : null;
  } catch {
    return null;
  }
}

async function audioTests() {
  decodeOut.textContent = 'Decoding one music stem…';
  const url = await stemSample();
  if (!url) {
    audio.decode = { error: 'no stem manifest' };
    decodeOut.replaceChildren(table([['Stem decode test', 'no music manifest found', 'warn']]));
    return;
  }
  let dec: Json;
  try {
    const r = await testDecode(url);
    dec = { ok: true, file: url, ms: Math.round(r.ms), seconds: +r.seconds.toFixed(3), kb: Math.round(r.bytes / 1024) };
  } catch (e) {
    dec = { ok: false, file: url, error: String((e as Error)?.message ?? e) };
  }
  audio.decode = dec;
  const verdict = await probeOggOpus(url);
  audio.stemVerdict = verdict;
  decodeOut.replaceChildren(table([
    ['Ogg Opus decode (real stem)', dec.ok ? `ok · ${dec.seconds} s decoded in ${dec.ms} ms (${dec.kb} KB)` : `failed: ${dec.error}`, dec.ok ? 'ok' : 'bad'],
    ['Adaptive score here', verdict.verdict === 'ok' ? `available (${verdict.how})` : `generative only (${verdict.how}: ${verdict.error ?? verdict.verdict})`, verdict.verdict === 'ok' ? 'ok' : 'warn'],
  ]));
}
void audioTests();

toneBtn.addEventListener('click', () => {
  // Everything up to resume()/start() runs synchronously inside the tap (iOS requirement).
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    toneOut.replaceChildren(table([['AudioContext', 'unsupported', 'bad']]));
    return;
  }
  const ctx = new Ctor({ latencyHint: 'interactive' });
  const before = ctx.state;
  void ctx.resume();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
  g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
  o.frequency.value = 440;
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.4);
  setTimeout(() => {
    const r = { stateBefore: before, stateAfter: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: (ctx as AudioContext & { outputLatency?: number }).outputLatency };
    audio.unlockTest = r;
    toneOut.replaceChildren(table([
      ['AudioContext after tap', `${r.stateBefore} → ${r.stateAfter}`, r.stateAfter === 'running' ? 'ok' : 'bad'],
      ['Sample rate / latency', `${r.sampleRate} Hz · base ${(r.baseLatency * 1000).toFixed(1)} ms · output ${r.outputLatency !== undefined ? (r.outputLatency * 1000).toFixed(1) + ' ms' : '—'}`],
    ]));
    void ctx.close();
  }, 500);
});

// ---------------------------------------------------------------- memory & workers

{
  const s = section('Memory & workers');
  const pm = (performance as Performance & { memory?: { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number } }).memory;
  const mem: Json = {
    deviceMemoryGB: platform.info.memoryGB ?? null,
    jsHeap: pm ? { limitMB: Math.round(pm.jsHeapSizeLimit / 1048576), totalMB: Math.round(pm.totalJSHeapSize / 1048576), usedMB: Math.round(pm.usedJSHeapSize / 1048576) } : null,
  };
  const workers: Json = {
    worker: typeof Worker !== 'undefined', offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined', crossOriginIsolated: !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null, chunkWorkers: budgets.chunkWorkers,
    wakeLock: appShell.wakeLockSupported, fullscreen: appShell.fullscreenSupported,
  };
  report.memory = mem;
  report.workers = workers;
  const rows: [string, unknown, ('ok' | 'warn' | 'bad')?][] = [
    ['Device memory hint', mem.deviceMemoryGB === null ? 'not exposed (Safari/Firefox)' : `${mem.deviceMemoryGB} GB`],
    ['JS heap (Chromium only)', pm ? `${(mem.jsHeap as Json).usedMB} / ${(mem.jsHeap as Json).limitMB} MB` : 'not exposed'],
    ['Web Workers', workers.worker, ...yes(!!workers.worker, false)],
    ['OffscreenCanvas', workers.offscreenCanvas],
    ['SharedArrayBuffer / cross-origin isolated', `${workers.sharedArrayBuffer} / ${workers.crossOriginIsolated}`],
    ['Chunk workers (budget)', workers.chunkWorkers],
    ['Screen Wake Lock', workers.wakeLock ? 'available' : window.isSecureContext ? 'unsupported' : 'needs https', ...yes(!!workers.wakeLock)],
    ['Element fullscreen', workers.fullscreen ? 'available' : 'unavailable (Add to Home Screen instead)', ...yes(!!workers.fullscreen)],
  ];
  const moduleWorker = el('div');
  s.append(table(rows), moduleWorker);
  // Module workers (the game's chunk/server workers are ES modules).
  try {
    const t0 = performance.now();
    const url = URL.createObjectURL(new Blob(['self.onmessage = (e) => self.postMessage(e.data * 2); export {};'], { type: 'text/javascript' }));
    const w = new Worker(url, { type: 'module' });
    const done = (ok: boolean, info: string) => {
      workers.moduleWorker = { ok, info };
      moduleWorker.replaceChildren(table([['Module worker round trip', info, ok ? 'ok' : 'bad']]));
      w.terminate();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => done(false, 'no answer within 5 s'), 5000);
    w.onmessage = (e) => (clearTimeout(timer), done(e.data === 42, `${(performance.now() - t0).toFixed(1)} ms`));
    w.onerror = (e) => (clearTimeout(timer), done(false, 'error: ' + e.message));
    w.postMessage(21);
  } catch (e) {
    workers.moduleWorker = { ok: false, info: String(e) };
  }
}

// ---------------------------------------------------------------- benchmark

const benchSec = section('Benchmark');
benchSec.append(el('p', 'Generates the world near a spawn point on the main thread and in the chunk workers, warms up the shaders, then renders the real terrain, sky, water and vegetation for 6 s with the graphics settings the game uses on this device.', 'sub'));
const benchOut = el('div');
benchSec.append(benchOut);

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const avg = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { n: s.length, avg: +avg.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +(s[s.length - 1] ?? 0).toFixed(2) };
};
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

async function benchmark(): Promise<Json> {
  if (!core) throw new Error('no WebGL renderer');
  const out: Json = {};
  const note = el('div', 'Starting…', 'stage-note');
  const say = (t: string) => {
    note.textContent = t;
    benchOut.textContent = t;
  };
  document.body.append(note);
  try {
    // --- CPU: world generator on the main thread
    say('World generator (main thread)…');
    await new Promise((r) => setTimeout(r, 30)); // let the note paint
    const seed = 1234;
    let t0 = performance.now();
    const gen = new WorldGenerator(seed);
    const genInit = performance.now() - t0;
    const spawn = gen.findSpawn();
    const col = new Column();
    t0 = performance.now();
    const N = 3000;
    for (let i = 0; i < N; i++) gen.column(spawn[0] + (i % 60) * 7.3, spawn[2] + Math.floor(i / 60) * 7.3, col);
    const colMs = performance.now() - t0;
    t0 = performance.now();
    const D = 20000;
    let acc = 0;
    for (let i = 0; i < D; i++) acc += gen.density(spawn[0] + (i % 40) * 1.7, spawn[1] - 20 + ((i / 40) % 25) * 1.9, spawn[2] + Math.floor(i / 1000) * 1.3);
    const denMs = performance.now() - t0;
    t0 = performance.now();
    const C = 3;
    for (let i = 0; i < C; i++) gen.fillChunk(Math.floor(spawn[0] / CHUNK_SIZE) * CHUNK_SIZE + i * CHUNK_SIZE, Math.floor(spawn[1] / CHUNK_SIZE) * CHUNK_SIZE, Math.floor(spawn[2] / CHUNK_SIZE) * CHUNK_SIZE, 0);
    const fillMs = (performance.now() - t0) / C;
    out.cpu = {
      generatorInitMs: Math.round(genInit), columnsPerSec: Math.round(N / (colMs / 1000)), densityPerSec: Math.round(D / (denMs / 1000)),
      fillChunkMs: +fillMs.toFixed(1), checksum: Math.round(acc) % 1000,
    };

    // --- streaming through the real worker pool
    say('Terrain textures and chunk workers…');
    t0 = performance.now();
    const tex = createTerrainTextures(await synthesizeInWorker(seed));
    const texMs = performance.now() - t0;
    const env = new Environment(core.scene, gen);
    env.timeOfDay = 0.36;
    const streamer = new TerrainStreamer(gen, createTerrainMaterial(tex));
    core.scene.add(streamer.root);
    await streamer.whenReady();
    const settings = configured;
    applyGraphicsSettings(settings, { core, streamer, env, container: stage });
    // Real flora on the streamed chunks (minimal client context, like the flora sandbox).
    const flora = new FloraSystem();
    try {
      const ctx = {
        seed, gen, profile: gen.profile, core, scene: core.scene, camera: core.camera, env, streamer, terrain: streamer.collider,
        colliders: new StaticColliderStore(), debris: { gravityAt: () => -9.81 }, audio: { play() {}, footstep() {} },
        events: new Emitter<ClientEvents>(), state: { objects: new Map(), serverTime: 0, entities: new Map() },
        playerPos: () => [core!.camera.position.x, core!.camera.position.y, core!.camera.position.z],
      } as unknown as ClientContext;
      flora.init(ctx);
    } catch (e) {
      out.floraError = String(e);
    }
    const cam = core.camera;
    cam.position.set(spawn[0], spawn[1] + 6, spawn[2]);
    cam.rotation.set(-0.12, 0, 0, 'YXZ');
    cam.updateMatrixWorld();
    let meshed = 0;
    const offMeshed = streamer.events.on('chunkMeshed', () => meshed++);
    t0 = performance.now();
    while (performance.now() - t0 < 40000) {
      streamer.update(cam, true);
      const s = streamer.stats;
      say(`Streaming terrain… ${s.drawn}/${s.leaves} chunks drawn, ${s.pending} pending`);
      if (streamer.isDetailedAt(spawn[0], spawn[1] - 1, spawn[2]) && s.pending < 40) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const streamMs = performance.now() - t0;
    out.streaming = {
      textureSynthMs: Math.round(texMs), workers: streamer.pool.size, untilPlayableMs: Math.round(streamMs), chunksMeshed: meshed,
      chunksPerSec: +(meshed / (streamMs / 1000)).toFixed(1), avgJobMs: +streamer.pool.avgMs.toFixed(1), timedOut: streamMs >= 40000,
    };

    // --- shader warm-up (what the loading screen does)
    say('Compiling shaders…');
    stage.style.visibility = 'visible';
    root.style.visibility = 'hidden';
    t0 = performance.now();
    await core.precompile(core.scene, 30000);
    out.shaderWarmupMs = Math.round(performance.now() - t0);

    // --- render (needs a visible page: hidden tabs get no animation frames)
    if (document.hidden) {
      say('Waiting for the page to be visible…');
      await new Promise<void>((r) => {
        const on = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', on);
          r();
        };
        document.addEventListener('visibilitychange', on);
      });
    }
    const gl =core.renderer.getContext() as WebGL2RenderingContext;
    const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    const gpuMs: number[] = [];
    const pendingQ: WebGLQuery[] = [];
    const frames: number[] = [];
    let last = performance.now();
    let world = 0;
    const T = 6000;
    const start = performance.now();
    let calls = 0, tris = 0;
    while (performance.now() - start < T) {
      const now = await nextFrame();
      const dt = Math.min(0.1, (now - last) / 1000);
      if (now - start > 400) frames.push(now - last); // skip the first frames (residual compiles)
      last = now;
      world += dt;
      const a = ((now - start) / T) * Math.PI * 2;
      cam.position.set(spawn[0] + Math.sin(a) * 6, spawn[1] + 7, spawn[2] + Math.cos(a) * 6);
      cam.rotation.set(-0.15, a + Math.PI, 0, 'YXZ');
      cam.updateMatrixWorld();
      streamer.update(cam);
      env.update(cam, dt, world);
      flora.update(dt, world);
      let q: WebGLQuery | null = null;
      if (tq) {
        q = gl.createQuery();
        if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
      }
      // Count the whole frame (scene + post passes): three resets info on every inner render() call.
      core.renderer.info.autoReset = false;
      core.renderer.info.reset();
      core.render();
      core.renderer.info.autoReset = true;
      if (tq && q) {
        gl.endQuery(tq.TIME_ELAPSED_EXT);
        pendingQ.push(q);
      }
      for (let i = pendingQ.length - 1; i >= 0; i--) {
        const pq = pendingQ[i];
        if (gl.getQueryParameter(pq, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(tq!.GPU_DISJOINT_EXT)) gpuMs.push((gl.getQueryParameter(pq, gl.QUERY_RESULT) as number) / 1e6);
          gl.deleteQuery(pq);
          pendingQ.splice(i, 1);
        }
      }
      calls = core.renderer.info.render.calls;
      tris = core.renderer.info.render.triangles;
      note.textContent = `Rendering… ${Math.ceil((T - (now - start)) / 1000)} s`;
    }
    for (const pq of pendingQ) gl.deleteQuery(pq);
    const ft = stats(frames);
    const size = new THREE.Vector2();
    core.renderer.getDrawingBufferSize(size);
    out.render = {
      settings: { preset: settings.preset, renderScale: settings.renderScale, viewDistance: settings.viewDistance, shadows: settings.shadows, bloom: settings.bloom, antialias: settings.antialias, vegetation: settings.vegetation },
      drawingBuffer: `${size.x}×${size.y}`, megapixels: +((size.x * size.y) / 1e6).toFixed(2), frameMs: ft, fps: +(1000 / Math.max(1e-3, ft.avg)).toFixed(1),
      gpuMs: gpuMs.length ? stats(gpuMs) : 'timer queries unavailable', drawCalls: calls, triangles: tris, depth: core.depthMode, hdr: core.hdr,
    };
    offMeshed();
    flora.dispose();
    streamer.dispose_all();
    core.scene.remove(streamer.root);
    return out;
  } finally {
    note.remove();
    stage.style.visibility = 'hidden';
    root.style.visibility = 'visible';
  }
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  try {
    const r = await benchmark();
    report.benchmark = r;
    const cpu = r.cpu as Json, st = r.streaming as Json, rd = r.render as Json, fm = rd.frameMs as Json;
    benchOut.replaceChildren(table([
      ['Generator init', `${cpu.generatorInitMs} ms`],
      ['Columns / s (main thread)', cpu.columnsPerSec],
      ['Density samples / s', cpu.densityPerSec],
      ['fillChunk (LOD 0)', `${cpu.fillChunkMs} ms`],
      ['Texture synthesis', `${st.textureSynthMs} ms`],
      ['Streaming until playable', `${(st.untilPlayableMs as number / 1000).toFixed(1)} s · ${st.chunksMeshed} chunks · ${st.chunksPerSec}/s · job ${st.avgJobMs} ms · ${st.workers} workers${st.timedOut ? ' (timed out)' : ''}`, st.timedOut ? 'warn' : undefined],
      ['Shader warm-up', `${r.shaderWarmupMs} ms`],
      ['Render settings', `${(rd.settings as Json).preset} · ${rd.drawingBuffer} (${rd.megapixels} MP)`],
      ['Frame time', `avg ${fm.avg} ms · p50 ${fm.p50} · p95 ${fm.p95} · max ${fm.max} → ${rd.fps} fps`, (rd.fps as number) >= 50 ? 'ok' : (rd.fps as number) >= 28 ? 'warn' : 'bad'],
      ['GPU time', typeof rd.gpuMs === 'string' ? rd.gpuMs : `avg ${(rd.gpuMs as Json).avg} ms · p95 ${(rd.gpuMs as Json).p95} ms`],
      ['Draw calls / triangles', `${rd.drawCalls} / ${Math.round((rd.triangles as number) / 1000)}k`],
      ...(r.floraError ? [['Flora', r.floraError, 'warn'] as [string, unknown, 'warn']] : []),
    ]));
  } catch (e) {
    report.benchmark = { error: String((e as Error)?.message ?? e) };
    benchOut.replaceChildren(table([['Benchmark', 'failed: ' + (e as Error)?.message, 'bad']]));
  } finally {
    runBtn.disabled = false;
  }
});

// ---------------------------------------------------------------- report

const reportSec = section('Report');
const area = el('textarea');
area.readOnly = true;
reportSec.append(area);
const json = () => {
  report.platform = platform.report();
  return JSON.stringify(report, null, 2);
};
const refresh = () => (area.value = json());
setInterval(refresh, 1500);
refresh();

copyBtn.addEventListener('click', async () => {
  const text = json();
  area.value = text;
  try {
    // Clipboard API needs a secure context (not available over http on the LAN).
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = 'Copied ✓';
  } catch {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand?.('copy');
    copyBtn.textContent = ok ? 'Copied ✓' : 'Select the text below and copy it';
  }
  setTimeout(() => (copyBtn.textContent = 'Copy report'), 2500);
});

dlBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
  a.download = `norgo-diag-${budgets.deviceClass}-${Date.now()}.json`;
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
});

(window as unknown as { norgoDiag: unknown }).norgoDiag = { report, core, json };
