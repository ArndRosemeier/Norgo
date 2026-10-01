/**
 * The client game: connects to the (local) server, owns rendering, terrain
 * streaming, the predicted local player, the camera, entity views, input,
 * interaction and all client modules.
 */
import * as THREE from 'three';
import { RenderCore } from '../render/renderCore';
import { Environment } from '../render/environment';
import { estimateSkyVis } from '../render/skyOcclusion';
import { WorldGenerator } from '../world/generator';
import { TerrainStreamer } from '../world/streamer';
import { createTerrainMaterial, createTerrainTextures } from '../world/terrainMaterial';
import { synthesizeInWorker } from '../world/textureLoader';
import { matDef } from '../world/materials';
import { parseSeed } from '../core/rng';
import { Emitter } from '../core/events';
import { clamp } from '../core/math';
import { WorkerTransport, Transport } from '../net/transport';
import type { ClientMessage, EntitySnapshot, GameEvent, PlayerState, ServerMessage } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';
import type { EntityId, Vec3 } from '../shared/types';
import type {
  AudioAPI, ClientContext, ClientEvents, ClientModule, ClientState, EntityView, EntityViewFactory, FocusTarget,
} from './context';
import { StaticColliderStore } from './staticColliders';
import { DebrisSystem } from './debris';
import { Input } from './input';
import { PlayerController, MoveInput, Modifiers } from './playerController';
import { CameraRig } from './cameraRig';
import { SnapshotBuffer } from './interpolation';
import { LightManager } from './lights';
import { FrameProfiler } from './profiler';
import { AbilityInput, abilityTargeting, type AimInfo } from '../gameplay/client/abilityClient';
import { TargetSystem } from './targeting';
import { FloraSystem } from '../flora/client/FloraSystem';
import { SettlementRenderer } from '../settlements/client/SettlementRenderer';
import { HumanoidViews } from '../humanoid/client/HumanoidViews';
import { CreatureViews } from '../creatures/client/CreatureViews';
import { ItemViews } from '../items/client/ItemViews';
import { FxSystem } from '../gameplay/client/FxSystem';
import { AudioSystem } from '../audio/AudioSystem';
import { UI, NewGameChoice } from '../ui/UI';
import type { ItemInstance } from '../items/types';

const SEND_RATE = 20;

export class Game implements ClientContext {
  readonly seed: number;
  readonly gen: WorldGenerator;
  readonly core: RenderCore;
  readonly env: Environment;
  streamer!: TerrainStreamer;
  readonly colliders = new StaticColliderStore();
  debris!: DebrisSystem;
  readonly events = new Emitter<ClientEvents>();
  readonly views = new Map<EntityId, EntityView>();
  state!: ClientState;
  readonly audio: AudioAPI & ClientModule;
  readonly uiRoot: HTMLElement;
  private transport!: Transport;
  private input: Input;
  private player!: PlayerController;
  private cam!: CameraRig;
  private snaps = new SnapshotBuffer();
  private lights: LightManager;
  private modules: ClientModule[] = [];
  private factories: EntityViewFactory[] = [];
  private ui: UI;
  private clock = 0;
  private sendAcc = 0;
  private seq = 0;
  private running = false;
  private focus: FocusTarget | null = null;
  private skyVisCache = new Map<EntityId, { v: number; t: number }>();
  private localAction: EntitySnapshot['anim']['action'] | undefined;
  private blocking = false;
  private abilityInput = new AbilityInput();
  /** Tab targeting (selection is client-side; attacks/abilities send it as a lock the server validates). */
  private targeting = new TargetSystem(this);
  /** Until this clock time the character turns toward the tab target (just attacked / cast). */
  private faceTargetUntil = 0;
  /** Range within which the current action soft-faces the target (short for melee swings). */
  private faceTargetRange = 0;
  /** Frame profiler (console: norgo.prof.report()). */
  readonly prof = new FrameProfiler();
  /** Sitting or sleeping on furniture (server-confirmed). */
  private seated: 'sit' | 'sleep' | null = null;
  private lastFrame = performance.now();
  private autosaveTimer = 300;
  private uiCapturedFlag = false;
  private debugTimer = 0;
  private fps = 60;

  constructor(private container: HTMLElement, private choice: NewGameChoice) {
    this.seed = parseSeed(choice.seed);
    this.gen = new WorldGenerator(this.seed);
    this.core = new RenderCore(container);
    this.env = new Environment(this.core.scene, this.gen);
    this.input = new Input(this.core.canvas);
    this.lights = new LightManager(this.core.scene);
    this.audio = new AudioSystem();
    this.ui = new UI();
    const ui = document.getElementById('ui') ?? document.body;
    this.uiRoot = ui;
  }

  // ---------------------------------------------------------------- ClientContext getters

  get profile() {
    return this.gen.profile;
  }
  get scene() {
    return this.core.scene;
  }
  get camera() {
    return this.core.camera;
  }
  get terrain() {
    return this.streamer.collider;
  }
  get uiCaptured() {
    return this.uiCapturedFlag;
  }

  send(msg: ClientMessage) {
    this.transport.send(msg);
  }

  playerPos(): Vec3 {
    return [this.player.pos.x, this.player.pos.y, this.player.pos.z];
  }

  findItem(uid: string): ItemInstance | undefined {
    const p = this.state?.player;
    if (!p) return;
    return p.inventory.items.find((i) => i.uid === uid) ?? Object.values(p.equipment).find((i) => i?.uid === uid);
  }

  setUiCapture(captured: boolean) {
    this.uiCapturedFlag = captured;
    this.input.setEnabled(!captured);
  }

  // ---------------------------------------------------------------- boot

  async start(onProgress: (stage: string, frac: number) => void) {
    this.prof.startSession(`${this.seed >>> 0}`);
    (window as unknown as { norgoBoot: Game }).norgoBoot = this;
    onProgress('Weaving the world palette', 0.05);
    const texData = await synthesizeInWorker(this.seed);
    const tex = createTerrainTextures(texData);
    const mat = createTerrainMaterial(tex);
    this.streamer = new TerrainStreamer(this.gen, mat, { splitFactor: this.core.settings.viewDistance });
    this.core.scene.add(this.streamer.root);
    this.streamer.timing = (label, ms) => this.prof.add('async:' + label, ms);
    this.debris = new DebrisSystem(this.streamer.collider, this.gen, this.colliders);
    this.core.scene.add(this.debris.group);
    this.player = new PlayerController(this.streamer.collider, this.gen, this.colliders, (x, y, z) => this.debris.gravityAt(x, y, z));
    this.cam = new CameraRig(this.core.camera, this.streamer.collider, this.colliders);
    await this.streamer.whenReady();

    onProgress('Waking the world server', 0.2);
    const save = this.choice.save;
    const wt = new WorkerTransport(this.seed, save);
    this.transport = wt;
    await wt.ready;
    const welcome = await new Promise<Extract<ServerMessage, { t: 'welcome' }>>((resolve) => {
      this.transport.onMessage((m) => {
        const t0 = performance.now();
        if (m.t === 'welcome') resolve(m);
        else if (this.running || this.state) this.onServerMessage(m);
        else this.early.push(m);
        this.prof.add('async:net:' + m.t, performance.now() - t0);
      });
      this.send({ t: 'hello', version: PROTOCOL_VERSION, name: this.choice.name, appearance: this.choice.appearance });
    });
    this.state = {
      playerId: welcome.playerId,
      player: welcome.player,
      serverTime: welcome.serverTime,
      entities: new Map(),
      objects: new Map(),
      timeOfDay: 0.3,
      day: 0,
    };
    this.player.teleport(welcome.spawn[0], welcome.spawn[1], welcome.spawn[2]);
    this.player.yaw = 0;
    for (const m of this.early.splice(0)) this.onServerMessage(m);

    onProgress('Raising the land', 0.3);
    // Modules.
    const flora = new FloraSystem();
    const settlements = new SettlementRenderer();
    const humanoids = new HumanoidViews();
    const creatures = new CreatureViews();
    const items = new ItemViews();
    const fx = new FxSystem();
    this.modules = [this.audio, flora, settlements, humanoids, creatures, items, fx, this.ui];
    this.factories = [humanoids, creatures, items, fx];
    for (const m of this.modules) {
      const t = performance.now();
      onProgress('Preparing ' + m.name, 0.3);
      try {
        // A slow module must never block the game from starting.
        const p = Promise.resolve(m.init?.(this));
        const timedOut = await Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 20000))]);
        if (timedOut) console.warn('[client] module init still pending after 20 s, continuing:', m.name);
      } catch (err) {
        console.error('[client] module init failed', m.name, err);
      }
      console.info('[client] init', m.name, (performance.now() - t).toFixed(0) + ' ms');
    }

    this.hookSettings();

    // Stream terrain around the spawn before handing control to the player.
    const t0 = performance.now();
    while (performance.now() - t0 < 25000) {
      this.core.camera.position.set(this.player.pos.x, this.player.pos.y + 2, this.player.pos.z);
      this.core.camera.updateMatrixWorld();
      this.streamer.update(this.core.camera, true);
      const ready = this.streamer.isDetailedAt(this.player.pos.x, this.player.pos.y - 1, this.player.pos.z);
      const s = this.streamer.stats;
      onProgress('Raising the land', 0.3 + 0.65 * Math.min(1, s.drawn / Math.max(1, s.leaves)));
      if (ready && s.pending < 40) break;
      // Wake on the next finished chunk (worker messages are not throttled in hidden tabs) or a short timer.
      await new Promise<void>((r) => {
        const off = this.streamer.events.on('chunkMeshed', () => {
          off();
          r();
        });
        setTimeout(() => {
          off();
          r();
        }, 60);
      });
    }
    // Compile everything around the spawn before play starts (parallel, non-blocking compile).
    onProgress('Preparing shaders', 0.97);
    await this.core.precompile(this.core.scene, 15000);
    // From here on, anything new waits for its shaders instead of stalling a frame.
    this.core.shaders.enabled = true;
    // Settle onto the ground.
    const gy = this.streamer.collider.groundBelow(this.player.pos.x, this.player.pos.y + 3, this.player.pos.z, 30);
    if (!Number.isNaN(gy)) this.player.pos.y = gy + 0.05;
    this.cam.yaw = this.player.yaw;
    onProgress('Ready', 1);
    this.running = true;
    this.lastFrame = performance.now();
    this.frame();
    (window as unknown as { norgo: Game }).norgo = this;
  }

  private early: ServerMessage[] = [];

  // ---------------------------------------------------------------- server messages

  private onServerMessage(m: ServerMessage) {
    this.events.emit('serverMessage', m);
    switch (m.t) {
      case 'snapshot': {
        this.state.serverTime = m.time;
        this.snaps.push(m.time, this.clock, m.entities);
        for (const s of m.entities) {
          if (!this.state.entities.has(s.id)) this.events.emit('entityAdded', { id: s.id, snap: s });
          this.state.entities.set(s.id, s);
        }
        for (const id of m.removed) this.removeEntity(id);
        break;
      }
      case 'terrainEdits':
        for (const e of m.edits) {
          this.streamer.applyEdit(e);
          this.debris?.wake([e.x, e.y, e.z], e.radius * 2.5, e.op === 'dig' ? 3 : 0);
        }
        break;
      case 'objects':
        for (const s of m.states) this.state.objects.set(s.id, s);
        this.events.emit('objects', m.states);
        break;
      case 'events':
        for (const ev of m.events) this.onGameEvent(ev);
        break;
      case 'player':
        Object.assign(this.state.player, m.state);
        this.events.emit('playerState', this.state.player);
        break;
      case 'dialog':
        this.events.emit('dialog', m.view);
        break;
      case 'gm':
        this.events.emit('gm', m.messages);
        break;
      case 'world':
        this.state.timeOfDay = m.timeOfDay;
        this.state.day = m.day;
        this.env.timeOfDay = m.timeOfDay;
        this.env.dayCount = m.day;
        this.env.weather = m.weather;
        break;
      case 'correct':
        this.seated = m.reason === 'sit' || m.reason === 'sleep' ? m.reason : null;
        this.player.correct(m.pos[0], m.pos[1], m.pos[2]);
        if (m.vel) this.player.vel.set(m.vel[0], m.vel[1], m.vel[2]);
        break;
      case 'trade':
        this.events.emit('trade', m);
        break;
      case 'saved':
        try {
          localStorage.setItem(`norgo.save.${this.choice.seed}.${this.choice.name}`, m.data);
          localStorage.setItem('norgo.lastSave', JSON.stringify({ seed: this.choice.seed, name: this.choice.name, t: Date.now() }));
          this.events.emit('notify', { text: 'Game saved', tone: 'good' });
        } catch (err) {
          console.error('save failed', err);
          this.events.emit('notify', { text: 'Saving failed (storage full?)', tone: 'bad' });
        }
        break;
      case 'error':
        console.error('[server]', m.message);
        break;
    }
  }

  private onGameEvent(ev: GameEvent) {
    this.events.emit('gameEvent', ev);
    const target = 'target' in ev ? (ev.target as EntityId | undefined) : undefined;
    if (target !== undefined) this.views.get(target)?.onEvent?.(ev);
    switch (ev.type) {
      case 'knockback':
        if (ev.target === this.state.playerId) this.player.applyImpulse(ev.impulse[0], ev.impulse[1], ev.impulse[2]);
        break;
      case 'shake': {
        const d = Math.hypot(ev.pos[0] - this.player.pos.x, ev.pos[1] - this.player.pos.y, ev.pos[2] - this.player.pos.z);
        this.cam.addShake(ev.strength * clamp(1 - d / 60, 0, 1));
        break;
      }
      case 'gravity':
        this.debris.fields.push({ pos: ev.pos, radius: ev.radius, factor: ev.factor, until: this.debris.time + Math.max(0, ev.until - this.state.serverTime) });
        break;
      case 'damage':
        if (ev.target === this.state.playerId) this.cam.addShake(Math.min(0.8, ev.amount / 40));
        break;
      case 'impact':
        this.debris.wake(ev.pos, 4, ev.force * 0.5);
        break;
    }
  }

  private removeEntity(id: EntityId) {
    if (id === this.state.playerId) return;
    this.snaps.remove(id);
    this.state.entities.delete(id);
    const v = this.views.get(id);
    if (v) {
      this.core.scene.remove(v.object);
      v.dispose();
      this.views.delete(id);
    }
    this.skyVisCache.delete(id);
    this.events.emit('entityRemoved', { id });
  }

  private createView(snap: EntitySnapshot): EntityView | null {
    for (const f of this.factories) {
      if (!f.kinds.includes(snap.kind)) continue;
      try {
        const v = f.create(snap, this);
        if (v) return v;
      } catch (err) {
        console.error('[client] view creation failed', snap.kind, err);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- frame

  /** Keep ticking in hidden tabs (automation / background testing via ?bgtick). */
  private readonly bgTick = new URLSearchParams(location.search).has('bgtick');

  private bgTicker: Worker | null = null;
  private rafActive = false;

  private frame = () => {
    if (!this.running) return;
    if (this.bgTick && document.hidden) {
      // Hidden tabs throttle timers & rAF; a worker heartbeat keeps the simulation running.
      if (!this.bgTicker) {
        const src = 'setInterval(() => postMessage(0), 33);';
        this.bgTicker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        this.bgTicker.onmessage = () => {
          if (document.hidden || !this.rafActive) this.frame();
        };
      }
      this.rafActive = false;
    } else {
      this.rafActive = true;
      requestAnimationFrame(this.frame);
    }
    const now = performance.now();
    if (this.maxFps > 0 && now - this.lastRendered < 1000 / this.maxFps - 1) return;
    this.lastRendered = now;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.clock += dt;
    this.fps = this.fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05;
    this.prof.beginFrame();
    try {
      this.tick(dt);
    } catch (err) {
      console.error('[client] frame error', err);
    }
    this.prof.endFrame();
    this.input.endFrame();
  };

  private tick(dt: number) {
    const p = this.state.player;
    const alive = p.hp > 0;
    const serverNow = this.snaps.serverNow(this.clock);
    this.state.serverTime = serverNow;

    // --- camera control
    if (!this.uiCapturedFlag) {
      this.cam.rotate(this.input.mouseDX, this.input.mouseDY, this.input.sensitivity, this.input.invertY);
      if (this.input.wheel) this.cam.zoom(this.input.wheel);
    }

    // --- player movement
    const effects = new Set(p.effects.map((e) => e.id));
    const mods: Modifiers = {
      moveSpeed: (p.stats?.moveSpeed ?? 1) * (this.blocking ? 0.55 : 1),
      jump: p.stats?.jump ?? 1,
      gravityMul: p.gravityMul ?? 1,
      effects,
      stamina: p.stamina,
      scale: p.appearance?.scale ?? 1,
    };
    const inp = this.input;
    const mi: MoveInput = {
      forward: alive ? (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0) : 0,
      right: alive ? (inp.isDown('right') ? 1 : 0) - (inp.isDown('left') ? 1 : 0) : 0,
      jump: alive && inp.isDown('jump'),
      jumpPressed: alive && inp.wasPressed('jump'),
      sprint: inp.isDown('sprint'),
      crouch: inp.isDown('crouch'),
      walk: inp.isDown('walk'),
      camYaw: this.cam.yaw,
      camPitch: this.cam.pitch,
      faceCamera: this.blocking || !!this.localAction || this.cam.firstPerson,
    };
    // Soft-face the tab target right after attacking/casting at it.
    if (this.clock < this.faceTargetUntil && !this.cam.firstPerson) {
      const fy = this.targeting.yawFrom(this.player.pos.x, this.player.pos.z, this.faceTargetRange);
      if (fy !== undefined) {
        mi.faceCamera = true;
        mi.faceYaw = fy;
      }
    }
    const wasGrounded = this.player.grounded;
    this.prof.mark('player');
    this.player.update(dt, mi, mods);
    if (mi.jumpPressed && wasGrounded && !this.player.grounded && this.player.vel.y > 1) this.audio.play('jump', this.playerPos(), { volume: 0.6 });
    if (!alive) this.player.move = 'dead';
    else if (this.seated) {
      // Seated/sleeping until the player moves or jumps.
      if (mi.forward || mi.right || mi.jumpPressed) this.seated = null;
      else this.player.move = this.seated;
    }

    // Footsteps & landings.
    const stride = this.player.move === 'sprint' ? 2.3 : this.player.move === 'run' ? 1.9 : 1.3;
    if (this.player.stepDistance > stride) {
      this.player.stepDistance = 0;
      this.audio.footstep(this.player.groundMaterial, this.playerPos(), this.player.move === 'sprint' ? 1 : this.player.move === 'crouch' ? 0.3 : 0.7);
    }
    if (this.player.landingSpeed > 3) {
      this.audio.play('land', this.playerPos(), { volume: clamp(this.player.landingSpeed / 15, 0.2, 1) });
      if (this.player.landingSpeed > 9) this.cam.addShake(Math.min(1, (this.player.landingSpeed - 9) / 10));
    }
    this.player.landingSpeed = 0;
    if (this.clock % 0.25 < dt) {
      const m = this.streamer.collider.material(this.player.pos.x, this.player.pos.y - 0.3, this.player.pos.z);
      this.player.groundMaterial = m;
    }

    // --- send movement
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_RATE) {
      this.sendAcc = 0;
      this.send({
        t: 'move', seq: ++this.seq,
        pos: [this.player.pos.x, this.player.pos.y, this.player.pos.z],
        vel: [this.player.vel.x, this.player.vel.y, this.player.vel.z],
        yaw: this.player.yaw, move: this.player.move, grounded: this.player.grounded,
        aim: [this.cam.aimOrigin.x + this.cam.aimDir.x * 30, this.cam.aimOrigin.y + this.cam.aimDir.y * 30, this.cam.aimOrigin.z + this.cam.aimDir.z * 30],
      });
    }

    // --- camera
    const head = new THREE.Vector3(this.player.pos.x, this.player.pos.y + this.player.height * (this.player.move === 'crouch' ? 0.62 : 0.9), this.player.pos.z);
    this.cam.update(dt, head);

    // --- terrain & world
    this.prof.mark('streamer');
    this.streamer.update(this.core.camera);

    // --- actions
    if (alive && !this.uiCapturedFlag) this.handleActions(serverNow);
    if (this.localAction && serverNow > this.localAction.t0 + this.localAction.dur) this.localAction = undefined;

    // --- entities
    this.prof.mark('views');
    this.updateViews(dt, serverNow);

    // --- focus
    this.prof.mark('focus');
    this.updateFocus();
    this.prof.mark('target');
    this.targeting.update(dt, alive);

    // --- environment & systems
    this.prof.mark('env');
    this.env.update(this.core.camera, dt, this.clock);
    this.prof.mark('debris');
    this.debris.update(dt);
    for (const m of this.modules) {
      try {
        this.prof.mark('mod:' + m.name);
        m.update?.(dt, this.clock);
      } catch (err) {
        console.error('[client] module update failed', m.name, err);
      }
    }
    const lightEntries: { id: EntityId; snap: EntitySnapshot; view?: EntityView }[] = [];
    for (const [id, s] of this.state.entities) lightEntries.push({ id, snap: s, view: this.views.get(id) });
    this.prof.mark('lights');
    this.lights.update(dt, this.core.camera.position, lightEntries);

    // --- autosave
    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) {
      this.autosaveTimer = 300;
      this.send({ t: 'save' });
    }

    // --- debug info
    this.debugTimer -= dt;
    if (this.debugTimer <= 0) {
      this.debugTimer = 0.25;
      const s = this.streamer.stats;
      const pp = this.player.pos;
      const g = this.debris.gravityAt(pp.x, pp.y, pp.z);
      const lines = [
        `${this.gen.profile.name} — seed ${this.seed}`,
        `fps ${this.fps.toFixed(0)}  calls ${this.core.renderer.info.render.calls}  tris ${(this.core.renderer.info.render.triangles / 1000).toFixed(0)}k`,
        `pos ${pp.x.toFixed(1)} ${pp.y.toFixed(1)} ${pp.z.toFixed(1)}  ${this.player.move}${this.player.grounded ? ' (ground)' : ''}`,
        `biome ${this.env.biomeName(pp.x, pp.y, pp.z)}  gravity ${g.toFixed(2)} (${this.gen.gravityLabel(g)})`,
        `chunks ${s.entries} drawn ${s.drawn} pending ${s.pending} job ${this.streamer.pool.avgMs.toFixed(1)}ms`,
        `entities ${this.state.entities.size} views ${this.views.size} debris ${this.debris.count} colliders ${this.colliders.size}`,
        ...((this.audio as unknown as { debugLines?(): string[] }).debugLines?.() ?? []),
      ];
      (this.ui as unknown as { setDebugInfo?(l: string[]): void }).setDebugInfo?.(lines);
    }

    this.prof.mark('render');
    this.core.render();
    this.prof.notePrograms(this.core.renderer.info.programs as { name: string; cacheKey: string }[] | undefined);
  }

  private updateViews(dt: number, serverNow: number) {
    const pid = this.state.playerId;
    // Local player snapshot from prediction + server-side data.
    const serverSelf = this.state.entities.get(pid);
    const p = this.state.player;
    const self: EntitySnapshot = {
      ...(serverSelf ?? { id: pid, kind: 'player', flags: 0, maxHp: p.stats?.maxHp ?? 100 }),
      id: pid,
      kind: 'player',
      pos: [this.player.pos.x, this.player.pos.y, this.player.pos.z],
      vel: [this.player.vel.x, this.player.vel.y, this.player.vel.z],
      yaw: this.player.yaw,
      hp: p.hp,
      maxHp: p.stats?.maxHp ?? serverSelf?.maxHp ?? 100,
      name: p.name,
      humanoid: p.appearance,
      anim: {
        ...(serverSelf?.anim ?? {}),
        move: this.player.move,
        action: this.localAction ?? serverSelf?.anim.action,
        lookAt: this.headLookAt(),
      },
    };
    this.state.entities.set(pid, self);
    this.ensureView(pid, self, dt, serverNow);

    for (const id of [...this.snaps.ids()]) {
      if (id === pid) continue;
      const s = this.snaps.sample(id, this.clock);
      if (!s) continue;
      this.state.entities.set(id, s);
      this.ensureView(id, s, dt, serverNow);
    }
    const selfView = this.views.get(pid);
    selfView?.setVisible?.(!this.cam.firstPerson);
  }

  /**
   * Where the local character looks. Standing or aiming: the camera's aim point. While moving,
   * only follow the camera when it's roughly ahead; otherwise look along the direction of travel
   * (a head twisted toward a sideways camera looks wrong while running).
   */
  private headLookAt(): Vec3 {
    const o = this.cam.aimOrigin, d = this.cam.aimDir;
    const aim: Vec3 = [o.x + d.x * 20, o.y + d.y * 20, o.z + d.z * 20];
    const moving = this.player.speed > 1.2 && !this.blocking && !this.localAction;
    if (!moving) return aim;
    const fx = -Math.sin(this.player.yaw), fz = -Math.cos(this.player.yaw);
    const hl = Math.hypot(d.x, d.z) || 1;
    if ((d.x * fx + d.z * fz) / hl > Math.cos(0.8)) return aim;
    const p = this.player.pos;
    return [p.x + fx * 20, p.y + this.player.height * 0.9, p.z + fz * 20];
  }

  private ensureView(id: EntityId, s: EntitySnapshot, dt: number, serverNow: number) {
    let v = this.views.get(id);
    if (!v) {
      v = this.createView(s) ?? undefined;
      if (!v) return;
      this.views.set(id, v);
      // Other views appear once their shaders are compiled (core.shaders); the player never waits.
      if (id === this.state.playerId) v.object.userData.noShaderGate = true;
      this.core.scene.add(v.object);
    }
    try {
      v.update(s, dt, serverNow);
    } catch (err) {
      console.error('[client] view update failed', s.kind, err);
    }
    // Sky visibility (caves) refreshed a few times per second per entity.
    const c = this.skyVisCache.get(id);
    if (!c || this.clock - c.t > 0.4) {
      const sv = estimateSkyVis(s.pos[1], this.gen.heightAt(s.pos[0], s.pos[2]));
      if (!c || Math.abs(c.v - sv) > 0.02) v.setSkyVis?.(sv);
      this.skyVisCache.set(id, { v: sv, t: this.clock });
    }
  }

  // ---------------------------------------------------------------- focus & interaction

  private updateFocus() {
    const o = this.cam.aimOrigin, d = this.cam.aimDir;
    const reach = 4.5 + this.cam.distance;
    let best: FocusTarget | null = null;
    // Entities (sphere tests).
    for (const [id, v] of this.views) {
      if (id === this.state.playerId) continue;
      const s = this.state.entities.get(id);
      if (!s) continue;
      const cy = s.pos[1] + v.headHeight * 0.55;
      const ox = s.pos[0] - o.x, oy = cy - o.y, oz = s.pos[2] - o.z;
      const t = ox * d.x + oy * d.y + oz * d.z;
      if (t < 0 || t > reach) continue;
      const px = o.x + d.x * t - s.pos[0], py = o.y + d.y * t - cy, pz = o.z + d.z * t - s.pos[2];
      const r = Math.max(v.radius, v.headHeight * 0.5);
      if (px * px + py * py + pz * pz > r * r) continue;
      const distFromPlayer = Math.hypot(s.pos[0] - this.player.pos.x, s.pos[2] - this.player.pos.z);
      if (distFromPlayer > 4.5 + v.radius) continue;
      if (!best || t < best.dist) best = { kind: 'entity', id, snap: s, dist: t, prompt: this.promptFor(s) };
    }
    const ch = this.colliders.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], reach, (c) => !!c.interact);
    if (ch && (!best || ch.dist < best.dist)) {
      const dp = Math.hypot(ch.point[0] - this.player.pos.x, ch.point[1] - this.player.pos.y - 1, ch.point[2] - this.player.pos.z);
      if (dp < 4.5) best = { kind: 'object', collider: ch.collider, point: ch.point, dist: ch.dist, prompt: ch.collider.interact ?? '' };
    }
    const th = this.streamer.collider.raycast(o.x, o.y, o.z, d.x, d.y, d.z, reach);
    if (th && (!best || th.dist < best.dist - 0.05)) {
      const dp = Math.hypot(th.x - this.player.pos.x, th.y - this.player.pos.y - 1, th.z - this.player.pos.z);
      if (dp < 4.5) {
        const mat = this.streamer.collider.material(th.x - th.nx * 0.3, th.y - th.ny * 0.3, th.z - th.nz * 0.3);
        best = { kind: 'terrain', point: [th.x, th.y, th.z], normal: [th.nx, th.ny, th.nz], material: mat, dist: th.dist, prompt: this.hasDigTool() ? `Dig ${matDef(mat).name}` : '' };
      } else if (best && best.kind === 'object') {
        // terrain occludes far colliders
      }
    }
    const changed = (best?.kind ?? null) !== (this.focus?.kind ?? null) ||
      (best?.kind === 'entity' && this.focus?.kind === 'entity' && best.id !== this.focus.id) ||
      (best?.kind === 'object' && this.focus?.kind === 'object' && best.collider.id !== this.focus.collider.id) ||
      (best?.kind === 'terrain' && this.focus?.kind === 'terrain' && best.prompt !== this.focus.prompt);
    this.focus = best;
    if (changed) this.events.emit('focus', best);
  }

  private promptFor(s: EntitySnapshot): string {
    if (s.kind === 'item') return `Pick up ${s.item?.name ?? 'item'}${(s.item?.count ?? 1) > 1 ? ` ×${s.item!.count}` : ''}`;
    if (s.kind === 'npc') return s.hp <= 0 ? `Search ${s.name ?? ''}` : `Talk to ${s.name ?? 'stranger'}`;
    if (s.kind === 'creature') return s.hp <= 0 ? `Harvest ${s.name ?? 'carcass'}` : s.name ?? '';
    if (s.kind === 'player') return s.name ?? '';
    return '';
  }

  private equippedDef(slot: 'mainhand' | 'offhand'): string | null {
    return this.state.player.equipment[slot]?.defId ?? null;
  }

  private hasDigTool(): boolean {
    const d = this.equippedDef('mainhand') ?? '';
    return /pick|shovel|mattock/.test(d);
  }

  private handleActions(serverNow: number) {
    const inp = this.input;
    const f = this.focus;
    const aimPoint = (): Vec3 => {
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      const th = this.streamer.collider.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 120);
      if (th) return [th.x, th.y, th.z];
      return [o.x + d.x * 60, o.y + d.y * 60, o.z + d.z * 60];
    };
    const dir: Vec3 = [this.cam.aimDir.x, this.cam.aimDir.y, this.cam.aimDir.z];

    // Tab targeting: the key cycles forward, with Shift backward (Esc clears via the UI).
    if (inp.wasPressed('target')) this.targeting.cycleTargets(inp.wasPressedShift('target') ? -1 : 1);
    const lock = this.targeting.lockId;

    if (inp.wasPressed('interact') && f) {
      if (f.kind === 'entity') {
        if (f.snap.kind === 'item') this.send({ t: 'pickup', entity: f.id });
        else if (f.snap.kind === 'npc' && f.snap.hp > 0) this.send({ t: 'talk', npc: f.id });
        else this.send({ t: 'interact', target: f.id });
      } else if (f.kind === 'object') {
        const c = f.collider;
        if (c.objectId !== undefined && /chop|mine|gather|pick|harvest|cut/i.test(c.interact ?? '')) {
          this.send({ t: 'harvest', object: c.objectId, point: f.point });
          this.playAction(serverNow, /chop/i.test(c.interact ?? '') ? 'chop' : /mine/i.test(c.interact ?? '') ? 'mine' : 'harvest', 0.9);
        } else this.send({ t: 'interact', object: c.objectId ?? c.id, point: f.point });
        this.events.emit('uiOpen', { panel: 'interactObject', data: c });
      }
    }

    if (inp.wasPressed('attack')) {
      const main = this.equippedDef('mainhand') ?? '';
      if (f?.kind === 'terrain' && this.hasDigTool()) {
        this.send({ t: 'dig', point: f.point, normal: f.normal, tool: main });
        this.playAction(serverNow, 'dig', 0.7);
      } else if (f?.kind === 'object' && f.collider.objectId !== undefined && ((/axe/.test(main) && /chop/i.test(f.collider.interact ?? '')) || (/pick/.test(main) && /mine/i.test(f.collider.interact ?? '')))) {
        this.send({ t: 'harvest', object: f.collider.objectId, point: f.point });
        this.playAction(serverNow, /chop/i.test(f.collider.interact ?? '') ? 'chop' : 'mine', 0.8);
      } else {
        // A tab target wins over the crosshair focus; the server validates it (`lock`).
        const target = lock ?? (f?.kind === 'entity' ? f.id : undefined);
        this.send({ t: 'attack', dir, point: aimPoint(), target, heavy: inp.isDown('sprint'), lock: lock !== undefined ? true : undefined });
        const twoHanded = /great|halberd|glaive|maul|staff/.test(main);
        const shoots = /bow|crossbow|sling/.test(main);
        const anim = !main ? 'punch' : shoots ? 'shoot_bow' : /spear|glaive|halberd|dagger|knife/.test(main) ? 'stab' : twoHanded ? 'swing_2h' : 'swing_1h';
        // Melee only turns toward a target that is close enough to be struck.
        const faceRange = shoots || /javelin|throwing/.test(main) ? 50 : 6;
        if (lock !== undefined) this.faceTarget(faceRange);
        this.playAction(serverNow, anim, twoHanded ? 0.95 : 0.6, lock !== undefined ? this.targetAimDir(faceRange) : undefined);
        this.audio.play('swing', this.playerPos(), { volume: 0.6 });
      }
    }
    if (inp.wasPressed('block')) {
      this.blocking = true;
      this.send({ t: 'block', on: true });
    }
    if (inp.wasReleased('block') && this.blocking) {
      this.blocking = false;
      this.send({ t: 'block', on: false });
    }

    // Hotbar: press/release (charged abilities fire on release, channels end on release).
    const hot = ['hot1', 'hot2', 'hot3', 'hot4', 'hot5', 'hot6', 'hot7', 'hot8', 'hot9', 'hot0'] as const;
    const aimInfo = (): AimInfo => {
      const sy = Math.sin(this.cam.yaw), cy = Math.cos(this.cam.yaw);
      const fwd = (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0);
      const rgt = (inp.isDown('right') ? 1 : 0) - (inp.isDown('left') ? 1 : 0);
      const mx = -sy * fwd + cy * rgt, mz = -cy * fwd - sy * rgt;
      const ml = Math.hypot(mx, mz);
      return {
        aimOrigin: [this.cam.aimOrigin.x, this.cam.aimOrigin.y, this.cam.aimOrigin.z],
        aimDir: dir,
        aimPoint: aimPoint(),
        focusEntity: lock ?? (f?.kind === 'entity' ? f.id : undefined),
        focusObject: f?.kind === 'object' ? f.collider.objectId : undefined,
        moveDir: ml > 0 ? [mx / ml, 0, mz / ml] : undefined,
        self: this.state.playerId,
        lock: lock !== undefined ? true : undefined,
        lockPoint: lock !== undefined ? this.targeting.lockPoint() : undefined,
      };
    };
    for (let i = 0; i < hot.length; i++) {
      const pressed = inp.wasPressed(hot[i]), released = inp.wasReleased(hot[i]);
      if (!pressed && !released) continue;
      const entry = this.state.player.skills?.hotbar[i];
      if (!entry) continue;
      if (entry.startsWith('item:')) {
        if (pressed) this.send({ t: 'useItem', uid: entry.slice(5) });
        continue;
      }
      const msgs = pressed ? this.abilityInput.press(entry, aimInfo(), serverNow) : this.abilityInput.release(entry, aimInfo(), serverNow);
      for (const m of msgs) this.send(m);
      // Aimed abilities turn the character toward the tab target (self/aura ones don't).
      const tg = abilityTargeting(entry);
      if (lock !== undefined && (pressed || msgs.length) && tg && tg !== 'self' && tg !== 'aura' && tg !== 'passive') this.faceTarget(50);
    }
  }

  private playAction(serverNow: number, id: string, dur: number, aim?: Vec3) {
    this.localAction = { id, t0: serverNow, dur, aim: aim ?? [this.cam.aimDir.x, this.cam.aimDir.y, this.cam.aimDir.z] };
  }

  /** Turn toward the tab target for a moment (it must be within `range` m). */
  private faceTarget(range: number) {
    this.faceTargetUntil = this.clock + 0.7;
    this.faceTargetRange = range;
  }

  /** Unit direction from the player's eye to the tab target's chest, if within `range` m. */
  private targetAimDir(range: number): Vec3 | undefined {
    const c = this.targeting.lockChest();
    if (!c) return;
    const p = this.player.pos;
    const dx = c[0] - p.x, dy = c[1] - (p.y + this.player.height * 0.85), dz = c[2] - p.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.05 || d > range) return;
    return [dx / d, dy / d, dz / d];
  }

  // ---------------------------------------------------------------- settings & teardown

  private maxFps = 0;
  private lastRendered = 0;

  /** Bridge the UI's settings store into renderer, streamer, camera, input and audio. */
  private hookSettings() {
    const ui = this.ui as unknown as {
      onSettingsChange?(cb: (s: import('../ui/UI').GameSettings) => void): () => void;
      onQuit?: () => void;
    };
    ui.onSettingsChange?.((st) => {
      const g = st.graphics;
      const vd = g.viewDistance;
      this.streamer.opts.splitFactor = clamp((vd / 1800) * 1.6, 1.15, 2.2);
      this.streamer.opts.rootRadius = vd < 900 ? 1 : vd < 2200 ? 2 : 3;
      this.streamer.opts.shadowLod = g.shadows === 'high' ? 3 : 2;
      // Shorter view distances hide the streaming edge with denser fog.
      this.env.fogScale = clamp(1800 / vd, 0.7, 2.5);
      const base = Math.min(window.devicePixelRatio || 1, 1.5);
      const next = { pixelRatio: base * g.renderScale, bloom: g.bloom, antialias: g.antialias, shadows: g.shadows !== 'off', viewDistance: this.streamer.opts.splitFactor };
      const cur = this.core.settings;
      if (cur.pixelRatio !== next.pixelRatio || cur.bloom !== next.bloom || cur.antialias !== next.antialias || cur.shadows !== next.shadows) this.core.updateSettings(next, this.container);
      const ms = g.shadows === 'high' ? 2048 : 1024;
      if (this.env.sun.shadow.mapSize.x !== ms) {
        this.env.sun.shadow.mapSize.set(ms, ms);
        this.env.sun.shadow.map?.dispose();
        (this.env.sun.shadow as { map: unknown }).map = null;
      }
      this.cam.fov = g.fov;
      this.maxFps = g.maxFps;
      this.input.sensitivity = 0.0022 * st.controls.mouseSensitivity;
      this.input.invertY = st.controls.invertY;
      this.input.setBinding('target', st.controls.targetKey);
      const a = st.audio;
      (this.audio as unknown as { setVolumes?(v: Record<string, number>): void }).setVolumes?.({ master: a.master, music: a.music, sfx: a.effects, ambience: a.ambience, voice: a.voice, ui: a.ui });
      (this.audio as unknown as { setMusicStyle?(s: string): void }).setMusicStyle?.(a.musicStyle);
      // LLM brains (server side) receive their configuration through debug commands.
      if (st.llm.enabled) this.send({ t: 'debug', cmd: 'llmConfig', args: [st.llm] });
      if (st.gmLlm.enabled) this.send({ t: 'debug', cmd: 'gmLlmConfig', args: [st.gmLlm] });
    });
    if (ui.onQuit !== undefined) {
      ui.onQuit = () => {
        this.send({ t: 'save' });
        setTimeout(() => location.assign(location.pathname), 600);
      };
    }
  }


  applyGraphics(s: Partial<RenderCore['settings']>) {
    this.core.updateSettings(s, this.container);
    if (s.viewDistance) this.streamer.opts.splitFactor = s.viewDistance;
  }

  setMouseSensitivity(v: number) {
    this.input.sensitivity = v;
  }

  setFov(v: number) {
    this.cam.fov = v;
  }

  dispose() {
    this.running = false;
    for (const m of this.modules) m.dispose?.();
    this.targeting.dispose();
    this.transport.close();
    this.streamer.dispose_all();
    this.core.renderer.dispose();
  }

  get playerState(): PlayerState {
    return this.state.player;
  }
}
