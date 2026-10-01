/**
 * AudioSystem — Norgo's procedural audio client module (implements AudioAPI).
 *
 * Wires the engine (buses, reverb, HRTF voices), the sound catalog, the
 * listener probe, ambience and generative music to the game:
 *  - listener follows ctx.camera every frame; reverb space, muffling and air
 *    absorption follow the probed environment,
 *  - game events (damage, death, fx, impact, sound, xp, unlock, loot, notify,
 *    heal, shake, gravity, knockback), dialog views, object destruction and
 *    terrain edits trigger sounds,
 *  - entity snapshots drive creature vocalizations, NPC gibberish speech &
 *    barks, other entities' footsteps/actions, projectile & burning loops,
 *  - combat intensity (damage near the player, hostiles targeting them)
 *    feeds the music,
 *  - the adaptive stem layer (stems.ts) is mixed from the same mood plus
 *    settlement culture, boss fights and player movement; the generative score
 *    (music.ts) steps back to in-key accents while pitched stems play.
 * The client core calls `play()` / `footstep()` for the local player.
 */
import type { AudioAPI, ClientContext, ClientModule } from '../client/context';
import type { ActionAnim, EntityId, Vec3 } from '../shared/types';
import { EntFlag } from '../shared/types';
import type { EntitySnapshot, GameEvent } from '../shared/protocol';
import type { DialogView } from '../dialog/types';
import { matDef, Mat, MATERIALS } from '../world/materials';
import { BIOMES } from '../world/biomes';
import { SEA_LEVEL } from '../world/constants';
import { hash32, hashString } from '../core/rng';
import { clamp } from '../core/math';
import { AudioEngine, VolumeSettings, Voice, SoundDef, PlayOpts } from './engine';
import { SoundCatalog, soundForFx, GLOBAL_SOUNDS } from './catalog';
import { SPACES } from './reverb';
import { EnvProbe, AudioEnv } from './probe';
import { Ambience } from './ambience';
import { MusicDirector } from './music';
import { StemMusic } from './stems';
import { createStemContext, stemTuningPolicy, stemWorldFlavor, StemContext } from './stemRouting';
import { creatureCallDef, CallSituation } from './creatureVoice';
import { speechVoice, syllabify, speak, barkScript, BarkKind, SpeechStyle, Mood } from './speech';
import { sd } from './sounds/common';
import { noiseBuffers } from './dsp';
import type { StepFamily } from './sounds/foley';

export type { VolumeSettings, BusName } from './engine';
export { DEFAULT_VOLUMES } from './engine';
export type { StepFamily } from './sounds/foley';
export type { CallSituation, CallKind } from './creatureVoice';
export { setSpeciesVoiceHint } from './creatureVoice';
export type { BarkKind } from './speech';
export type { AudioEnv } from './probe';
export type { StemStatus } from './stems';

/** Settings → Audio → Music style. */
export type MusicStyle = 'adaptive' | 'generative';

/** Per-entity audio state. */
interface Track {
  kind: string;
  seen: number;
  lastAction: number;
  prevMove: string;
  stepAcc: number;
  swimAcc: number;
  nextIdle: number;
  idleArmed: boolean;
  lastSpeech: string;
  voice: Voice | null;
  talkEnd: number;
  queue: { text: string; mood?: Mood }[];
  loop: Voice | null;
  burn: Voice | null;
  lastPain: number;
  dead: boolean;
}

const SPEECH_DEF: SoundDef = sd({ dur: 0, render: () => {}, variants: 0, bus: 'voice', group: 'speech', gain: 1, ref: 2.2, range: 50, reverb: 0.9, priority: 1.8 });
const LOOP_DEF: SoundDef = sd({ dur: 0, render: () => {}, variants: 0, bus: 'sfx', group: 'loop', gain: 0.6, ref: 2, range: 60, reverb: 0.8, priority: 1.1 });

/** Damage type → body sound. */
const DTYPE_SOUND: Record<string, string> = {
  slash: 'hit_flesh', pierce: 'hit_flesh', blunt: 'hit_flesh', fire: 'fire_impact', frost: 'frost_impact', shock: 'shock_impact',
  force: 'force_impact', poison: 'poison_impact', radiant: 'light_impact', shadow: 'shadow_impact', psychic: 'arcane_impact', fall: 'land_heavy',
};

/** Terrain material name → footstep/impact sound family. */
const MAT_FAMILY = new Map<string, string>(MATERIALS.map((m) => [m.name, m.sound]));

const GIBBER = ['ka', 'lo', 'mi', 'ra', 'tu', 'ven', 'sha', 'do', 'ri', 'bel', 'no', 'ta', 'esh', 'or', 'pa', 'qui', 'zo', 'la', 'em', 'hu', 'gar', 'sen'];

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();

export class AudioSystem implements ClientModule, AudioAPI {
  readonly name = 'audio';
  readonly engine = new AudioEngine();
  readonly catalog = new SoundCatalog();
  private ctx: ClientContext | null = null;
  probe: EnvProbe = new EnvProbe(null);
  ambience: Ambience | null = null;
  music: MusicDirector | null = null;
  /** Adaptive stem layer (console: norgo.audio.stems.status() / .force('combat') / .force(null)). */
  stems: StemMusic | null = null;
  private stemCtx: StemContext = createStemContext();
  private musicStyle: MusicStyle = 'adaptive';
  private lastStemCat = '';
  /** A boss is fighting the local player (from EntFlag.Boss in snapshots). */
  private bossFight = false;
  private tracks = new Map<EntityId, Track>();
  private frame = 0;
  private combat = 0;
  /** Sandbox: force a combat level (null = automatic). */
  combatOverride: number | null = null;
  private offs: (() => void)[] = [];
  private dialogSession = '';
  private dialogLines = 0;
  private dialogOpen = false;
  private timers: { at: number; fn: () => void }[] = [];
  private lastXp = 0;
  private wasUnderwater = false;
  private catalogVersion = 0;
  private faunaSeed = 0;
  private weird = 0;
  /** Sandbox: fixed listener instead of the camera. */
  listenerOverride: { pos: Vec3; fwd: Vec3; up: Vec3 } | null = null;

  constructor() {
    this.engine.installUnlock();
    this.engine.onStart(() => this.preloadCommon());
  }

  // ================================================================ lifecycle

  init(ctx: ClientContext): void {
    this.ctx = ctx;
    const p = ctx.profile;
    this.faunaSeed = p.faunaSeed;
    this.weird = p.lifeWeirdness;
    this.music = new MusicDirector(this.engine, p);
    // Stems: per-world flavour (variations, rate shift, weird remaps) + tuning policy from the theme.
    this.stems = new StemMusic(this.engine, stemWorldFlavor(p), stemTuningPolicy(this.music.theme.tuning));
    this.stems.setEnabled(this.musicStyle === 'adaptive');
    this.music.setAccompaniment(this.stems.acc);
    this.catalog.rebuild(this.music.theme.tuning);
    this.catalogVersion++;
    this.ambience = new Ambience(this.engine, p.faunaSeed, p.lifeWeirdness, this.music.theme.tuning);
    this.probe = new EnvProbe(ctx);
    const ev = ctx.events;
    this.offs.push(
      ev.on('gameEvent', (e) => this.onGameEvent(e)),
      ev.on('dialog', (d) => this.onDialog(d)),
      ev.on('entityRemoved', ({ id }) => {
        const tr = this.tracks.get(id);
        if (tr) this.dropTrack(id, tr);
      }),
      ev.on('entityAdded', ({ id, snap }) => {
        // Fresh tracks start with the current action so we don't replay stale ones.
        this.tracks.set(id, this.newTrack(snap));
      }),
    );
    if (this.engine.ctx) this.preloadCommon();
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs = [];
    for (const [id, tr] of this.tracks) this.dropTrack(id, tr);
    this.ambience?.dispose();
    this.music?.dispose();
    this.stems?.dispose();
    this.engine.dispose();
  }

  /** Warm the most frequent banks right after the context starts. */
  private preloadCommon(): void {
    const names = [
      'step_stone', 'step_soil', 'step_grass', 'step_sand', 'step_snow', 'step_wood', 'step_water', 'jump', 'land', 'cloth',
      'swing', 'swing_light', 'swing_heavy', 'hit_flesh', 'hit_metal', 'hit_wood', 'hit_stone', 'block', 'ui_hover', 'ui_click', 'ui_open', 'ui_close', 'pickup',
    ];
    for (const n of names) this.engine.preload(this.catalog.defs[n], this.keyOf(n));
  }

  private keyOf(name: string): string {
    return name + '#' + this.catalogVersion;
  }

  // ================================================================ public API

  /** Play a named procedural sound at a world position (or as UI/2D sound if pos is undefined). */
  play(sound: string, pos?: Vec3, opts?: { volume?: number; pitch?: number }): void {
    const name = this.catalog.resolve(sound);
    const def = this.catalog.defs[name] ?? this.catalog.defs.drop;
    this.engine.play(def, this.keyOf(name), { pos, volume: opts?.volume, pitch: opts?.pitch });
  }

  /** Lower-level play with full options (delay, lowpass, bus...). */
  playEx(sound: string, o: PlayOpts): Voice | null {
    const name = this.catalog.resolve(sound);
    return this.engine.play(this.catalog.defs[name], this.keyOf(name), o);
  }

  /** Footstep on a terrain material id (MaterialDef.sound picks the family; water detected). */
  footstep(material: number, pos: Vec3, intensity: number): void {
    this.footstepFamily(this.familyFor(material, pos), pos, intensity);
  }

  /** Footstep with an explicit family (e.g. 'wood' floors, 'metal' grates, 'leaves'). */
  footstepFamily(family: StepFamily, pos: Vec3, intensity: number): void {
    const i = clamp(intensity, 0, 1.5);
    const name = 'step_' + family;
    this.engine.play(this.catalog.defs[name], this.keyOf(name), { pos, volume: 0.3 + 0.7 * i, lowpass: 2500 + 16000 * Math.min(1, i) });
  }

  setVolumes(v: Partial<VolumeSettings>): void {
    this.engine.setVolumes(v);
  }

  getVolumes(): VolumeSettings {
    return { ...this.engine.volumes };
  }

  setMuted(m: boolean): void {
    this.engine.setMuted(m);
  }

  /** "Adaptive score" (stems + generative accents) or "Generative only". */
  setMusicStyle(style: MusicStyle): void {
    this.musicStyle = style === 'generative' ? 'generative' : 'adaptive';
    this.stems?.setEnabled(this.musicStyle === 'adaptive');
  }

  getMusicStyle(): MusicStyle {
    return this.musicStyle;
  }

  /** Lines for the F3 debug overlay. */
  debugLines(): string[] {
    const out: string[] = [];
    if (this.music) out.push('music ' + this.music.debug());
    if (this.stems) out.push(this.stems.debugLine());
    return out;
  }

  /** Explicitly start audio (call from a click handler if desired; gestures also unlock it). */
  start(): void {
    this.engine.start();
  }

  /** All catalog sound names usable with play(). */
  soundNames(): string[] {
    return this.catalog.names();
  }

  /** Speak gibberish for `text` at a position with a race's voice. */
  speakText(text: string, pos: Vec3 | undefined, race = 'human', o: { mood?: Mood; style?: SpeechStyle; seed?: number; appearance?: EntitySnapshot['humanoid'] } = {}): number {
    const v = speechVoice(o.appearance?.race ?? race, o.appearance, o.seed ?? 0);
    return this.speakWith(v, syllabify(text, v.accent, o.style === 'shout' ? 14 : 36), pos, o.mood ?? 'neutral', o.style ?? 'say', 1, null);
  }

  /** Nonverbal vocal bark (pain, laugh, cheer, death...). */
  bark(kind: BarkKind, pos: Vec3 | undefined, race = 'human', o: { seed?: number; appearance?: EntitySnapshot['humanoid'] } = {}): number {
    const v = speechVoice(o.appearance?.race ?? race, o.appearance, o.seed ?? 0);
    const b = barkScript(kind);
    return this.speakWith({ ...v, rate: v.rate * b.rateMul }, b.syls, pos, b.mood, b.style, 1, null);
  }

  /** Creature call by species (deterministic voice from the world's fauna seed). */
  creatureCall(species: number, size: number, situation: CallSituation, pos: Vec3, o: { volume?: number; pitch?: number } = {}): void {
    const { key, def } = creatureCallDef(this.faunaSeed, species, size, situation, this.weird);
    this.engine.play(def, key, { pos, volume: o.volume, pitch: o.pitch });
  }

  /** Sandbox: override probed environment fields. */
  setEnvOverride(o: Partial<AudioEnv> | null): void {
    this.probe.override = o;
  }

  /** Current probed environment (debug/UI). */
  get env(): AudioEnv {
    return this.probe.env;
  }

  /** Current combat intensity 0..1 (debug/UI). */
  get combatLevel(): number {
    return this.combat;
  }

  // ================================================================ frame update

  update(dt: number, _time?: number): void {
    this.frame++;
    const eng = this.engine;
    if (!eng.running) {
      eng.update();
      return;
    }
    const ctx = this.ctx;
    // ---- listener
    let pos: Vec3;
    if (this.listenerOverride) {
      const l = this.listenerOverride;
      eng.setListener(l.pos, l.fwd, l.up);
      pos = l.pos;
    } else if (ctx) {
      const m = ctx.camera.matrixWorld.elements;
      pos = [m[12], m[13], m[14]];
      const fl = Math.hypot(m[8], m[9], m[10]) || 1;
      const ul = Math.hypot(m[4], m[5], m[6]) || 1;
      eng.setListener(pos, [-m[8] / fl, -m[9] / fl, -m[10] / fl], [m[4] / ul, m[5] / ul, m[6] / ul]);
    } else pos = eng.listener;

    // ---- environment → reverb, muffling, air
    const env = this.probe.update(dt, pos);
    eng.reverb.setSpace(env.space, 1.5);
    eng.reverb.setWet(SPACES[env.space].wet * (1 - env.snow * 0.35) * 1.6, 0.8);
    eng.setMuffle(env.underwater ? 650 : env.snow > 0 ? 20000 - env.snow * 9000 : 20000, env.underwater ? 0.05 : 0.6);
    eng.airDistance = 160 * (1 - env.fog * 0.35 - env.rain * 0.25 - env.snow * 0.3);
    if (env.underwater !== this.wasUnderwater) {
      this.wasUnderwater = env.underwater;
      this.play(env.underwater ? 'water_enter' : 'water_exit', undefined, { volume: 0.7 });
    }

    // ---- world sound
    this.ambience?.update(dt, env, pos);
    if (ctx) {
      this.scanEntities(dt);
    }
    this.runTimers();
    this.updateCombat(dt);
    if (this.music) {
      this.music.setMood({
        day: env.day, underground: env.cave, underworld: env.underworld, combat: this.combat, biome: env.dominant, storm: env.storm, indoor: env.indoor,
      });
      if (this.stems) this.updateStems(dt, env);
      this.music.update(dt);
    }
    eng.setDuck('music', this.dialogOpen ? 0.55 : 1, 0.6);
    eng.setDuck('ambience', this.dialogOpen ? 0.7 : 1, 0.6);
    eng.update();
  }

  /** Fill the (reused) stem context and advance the stem layer. */
  private updateStems(dt: number, env: AudioEnv) {
    const c = this.stemCtx;
    c.day = env.day;
    c.cave = env.cave;
    c.underworld = env.underworld;
    c.biome = env.dominant;
    c.alpine = env.alpine;
    c.storm = env.storm;
    c.indoor = env.indoor;
    c.underwater = env.underwater;
    c.settlement = env.settlement;
    c.siteRace = env.siteRace;
    c.combat = this.combat;
    c.boss = this.bossFight;
    c.episode = this.music!.playing;
    let move = 0;
    const ctx = this.ctx;
    if (ctx) {
      const me = ctx.state.entities.get(ctx.state.playerId);
      if (me) {
        const mv = me.anim.move;
        move = mv === 'sprint' ? 1 : mv === 'run' ? 0.7 : mv === 'walk' || mv === 'swim' || mv === 'climb' ? 0.35 : 0;
        if (Math.abs(me.vel[0]) + Math.abs(me.vel[2]) < 0.4) move = 0;
      }
    }
    c.move = move;
    const stems = this.stems!;
    stems.update(dt, c);
    // Arrival cue: entering a settlement or the underworld may end a long silence early.
    const cat = stems.selector.current === null ? '' : stems.selector.category;
    if (cat !== this.lastStemCat) {
      if (cat === 'settlement' || cat === 'under') this.music!.requestEpisode(20);
      this.lastStemCat = cat;
    }
  }

  private runTimers() {
    if (!this.timers.length) return;
    const now = this.engine.now;
    const due = this.timers.filter((t) => t.at <= now);
    if (!due.length) return;
    this.timers = this.timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  }

  private after(sec: number, fn: () => void) {
    this.timers.push({ at: this.engine.now + sec, fn });
  }

  private updateCombat(dt: number) {
    if (this.combatOverride !== null) {
      this.combat = this.combatOverride;
      return;
    }
    const ctx = this.ctx;
    let floor = 0;
    let boss = false;
    if (ctx) {
      const pid = ctx.state.playerId;
      const me = ctx.state.entities.get(pid);
      if (me && me.flags & EntFlag.InCombat) floor = 0.45;
      const pp = me ? me.pos : ctx.playerPos();
      for (const s of ctx.state.entities.values()) {
        if (s.kind !== 'creature' && s.kind !== 'npc') continue;
        if (s.anim.move === 'dead' || s.hp <= 0) continue;
        if (s.target === pid || (s.flags & EntFlag.Hostile && s.flags & EntFlag.InCombat)) {
          const d = Math.hypot(s.pos[0] - pp[0], s.pos[1] - pp[1], s.pos[2] - pp[2]);
          if (d < 35) floor = Math.max(floor, s.target === pid ? 0.6 : 0.35);
          if (s.flags & EntFlag.Boss && d < 60) boss = true;
        }
      }
    }
    this.bossFight = boss;
    this.combat = Math.max(floor, this.combat - dt * 0.05);
  }

  private bumpCombat(v: number) {
    this.combat = clamp(this.combat + v, 0, 1);
  }

  // ================================================================ entities

  private newTrack(snap: EntitySnapshot): Track {
    return {
      kind: snap.kind, seen: this.frame, lastAction: snap.anim.action?.t0 ?? -1, prevMove: snap.anim.move, stepAcc: 0, swimAcc: 0,
      nextIdle: rr(2, 20), idleArmed: false, lastSpeech: snap.speech?.text ?? '', voice: null, talkEnd: 0, queue: [], loop: null, burn: null, lastPain: 0,
      dead: snap.anim.move === 'dead',
    };
  }

  private dropTrack(id: EntityId, tr: Track) {
    tr.loop?.stop(0.15);
    tr.burn?.stop(0.3);
    tr.voice?.stop(0.1);
    this.tracks.delete(id);
  }

  private scanEntities(dt: number) {
    const ctx = this.ctx!;
    const st = ctx.state;
    const L = this.engine.listener;
    const pid = st.playerId;
    const now = this.engine.now;
    for (const [id, snap] of st.entities) {
      let tr = this.tracks.get(id);
      if (!tr) {
        tr = this.newTrack(snap);
        this.tracks.set(id, tr);
      }
      tr.seen = this.frame;
      const d = Math.hypot(snap.pos[0] - L[0], snap.pos[1] - L[1], snap.pos[2] - L[2]);
      if (snap.kind === 'projectile') {
        this.projectileLoop(tr, snap, d);
        continue;
      }
      if (snap.kind === 'item' || snap.kind === 'effect') continue;
      // Burning loop
      const burning = (snap.flags & EntFlag.Burning) !== 0 && d < 40;
      if (burning && !tr.burn) tr.burn = this.makeLoop('fire', snap.pos, 0.5);
      else if (!burning && tr.burn) {
        tr.burn.stop(0.5);
        tr.burn = null;
      }
      tr.burn?.setPosition(snap.pos);
      const act = snap.anim.action;
      if (d > 90) {
        // Out of earshot: keep state current so nothing stale fires on approach.
        if (act) tr.lastAction = act.t0;
        tr.prevMove = snap.anim.move;
        continue;
      }
      const isLocal = id === pid;
      if (act && act.t0 !== tr.lastAction) {
        tr.lastAction = act.t0;
        if (st.serverTime - act.t0 < 1.0) this.onAction(id, tr, snap, act, isLocal);
      }
      if (!isLocal) this.locomotion(tr, snap, d, dt);
      tr.prevMove = snap.anim.move;
      if (snap.kind === 'creature') this.creatureTick(id, tr, snap, d, dt);
      else if (snap.kind === 'npc' || (snap.kind === 'player' && !isLocal)) this.humanoidTick(id, tr, snap, d, now);
    }
    for (const [id, tr] of this.tracks) if (tr.seen !== this.frame && tr.seen < this.frame - 2) this.dropTrack(id, tr);
  }

  /** Body size estimate (m) from the view (falls back to scale/growth). */
  private sizeOf(id: EntityId, snap: EntitySnapshot): number {
    const view = this.ctx?.views.get(id);
    let s = view ? Math.max(view.headHeight * 0.75, view.radius * 1.6) : 1;
    if (!view && snap.creature) s *= 0.4 + 0.6 * snap.creature.growth;
    return Math.max(0.08, s * (view ? 1 : snap.scale ?? 1));
  }

  /** Ground sound family at a position (terrain material under the feet, water, roads). */
  private familyAt(pos: Vec3): StepFamily {
    const ctx = this.ctx;
    if (!ctx) return 'soil';
    const col = ctx.gen.cachedColumn(pos[0], pos[2]);
    if (pos[1] < SEA_LEVEL + 0.15 && col.height < SEA_LEVEL && pos[1] > col.height - 2) return 'water';
    let m: number = Mat.Air;
    try {
      m = ctx.terrain.material(pos[0], pos[1] - 0.3, pos[2]);
    } catch {
      m = Mat.Air;
    }
    if (m === Mat.Air) {
      if (pos[1] < col.height - 3) return 'stone';
      m = col.road > 0.5 ? Mat.Path : col.height > col.snowLine ? Mat.Snow : BIOMES[col.biome].top;
    }
    return matDef(m).sound;
  }

  private familyFor(material: number, pos: Vec3): StepFamily {
    const ctx = this.ctx;
    if (ctx) {
      const col = ctx.gen.cachedColumn(pos[0], pos[2]);
      if (pos[1] < SEA_LEVEL + 0.15 && col.height < SEA_LEVEL && pos[1] > col.height - 2) return 'water';
    }
    if (material === Mat.ForestFloor && R() < 0.5) return 'leaves';
    return matDef(material).sound;
  }

  /** Footsteps, landings, swimming and water transitions of other entities. */
  private locomotion(tr: Track, snap: EntitySnapshot, d: number, dt: number) {
    const mv = snap.anim.move;
    const prev = tr.prevMove;
    const speed = Math.hypot(snap.vel[0], snap.vel[2]);
    const id = snap.id;
    const size = snap.kind === 'creature' ? this.sizeOf(id, snap) : 1.7 * (snap.scale ?? 1);
    if (d < 40) {
      if ((prev === 'fall' || prev === 'jump') && (mv === 'idle' || mv === 'walk' || mv === 'run' || mv === 'sprint')) {
        this.play(size > 2.5 ? 'land_heavy' : 'land', snap.pos, { volume: clamp(size / 2, 0.3, 1.2), pitch: clamp(1.4 - size * 0.2, 0.6, 1.3) });
      }
      if (mv === 'swim' && prev !== 'swim') this.play(size > 2 ? 'splash_big' : 'splash', snap.pos, { volume: 0.7 });
      if (prev === 'swim' && mv !== 'swim' && mv !== 'dead') this.play('water_exit', snap.pos, { volume: 0.5 });
    }
    if (d > 35) return;
    if (mv === 'swim') {
      tr.swimAcc += dt;
      if (tr.swimAcc > 1.1 && speed > 0.3) {
        tr.swimAcc = 0;
        this.play('swim', snap.pos, { volume: 0.6 });
      }
      return;
    }
    if (mv === 'climb' && speed > 0.2) {
      tr.stepAcc += dt;
      if (tr.stepAcc > 0.6) {
        tr.stepAcc = 0;
        this.play('cloth', snap.pos, { volume: 0.6 });
      }
      return;
    }
    if (mv !== 'walk' && mv !== 'run' && mv !== 'sprint' && mv !== 'crouch') return;
    if (speed < 0.3 || size < 0.35) return;
    tr.stepAcc += speed * dt;
    const human = snap.kind !== 'creature';
    const stride = human ? (mv === 'sprint' ? 1.25 : mv === 'run' ? 1.05 : 0.75) * (snap.scale ?? 1) : 0.35 + size * 0.5;
    if (tr.stepAcc < stride) return;
    tr.stepAcc = 0;
    const fam = this.familyAt(snap.pos);
    const sneak = mv === 'crouch' || (snap.flags & EntFlag.Sneaking) !== 0;
    const intensity = sneak ? 0.2 : mv === 'sprint' ? 1 : mv === 'run' ? 0.75 : 0.5;
    const name = 'step_' + fam;
    const pitch = human ? 1 / Math.pow(snap.scale ?? 1, 0.3) : clamp(1.5 - Math.log2(size + 1) * 0.35, 0.45, 1.6);
    const vol = (0.3 + 0.7 * intensity) * (human ? 1 : clamp(size * 0.6, 0.3, 2.2));
    this.engine.play(this.catalog.defs[name], this.keyOf(name), { pos: snap.pos, volume: vol, pitch, lowpass: 2500 + 16000 * intensity });
    // Giants shake the ground.
    if (size > 3) this.play('land_heavy', snap.pos, { volume: clamp((size - 3) * 0.3, 0.2, 1), pitch: 0.6 });
    // Armor jingle for armored humanoids on the move.
    if (human && snap.equipment && R() < (mv === 'walk' ? 0.25 : 0.5)) this.play(R() < 0.5 ? 'armor_light' : 'cloth', snap.pos, { volume: 0.5 });
  }

  /** One-shot action animations of entities (local player: only non-combat actions; the core plays swings). */
  private onAction(id: EntityId, tr: Track, snap: EntitySnapshot, act: ActionAnim, isLocal: boolean) {
    const p = snap.pos;
    const a = act.id;
    if (snap.kind === 'creature') {
      const size = this.sizeOf(id, snap);
      switch (a) {
        case 'roar':
          this.callFor(id, snap, 'attack', 1.3);
          break;
        case 'bite':
        case 'claw':
        case 'pounce':
        case 'sting':
        case 'spit':
        case 'charge':
          if (R() < 0.65) this.callFor(id, snap, 'attack', 1);
          this.play(size > 1.5 ? 'swing_heavy' : 'swing_light', p, { volume: clamp(size * 0.5, 0.3, 1), pitch: clamp(1.3 - size * 0.15, 0.6, 1.4) });
          break;
        case 'flinch':
          this.callFor(id, snap, 'pain', 0.9);
          break;
        case 'die':
          if (!tr.dead) {
            tr.dead = true;
            this.callFor(id, snap, 'death', 1);
          }
          break;
        case 'graze':
          this.play('eat', p, { volume: 0.4, pitch: clamp(1.2 - size * 0.15, 0.6, 1.3) });
          break;
        case 'drink':
          this.play('drink', p, { volume: 0.4 });
          break;
      }
      return;
    }
    const race = snap.humanoid?.race ?? 'human';
    const combatAnim = ['swing_1h', 'swing_2h', 'stab', 'slam', 'punch', 'kick', 'block', 'shoot_bow', 'throw'];
    if (isLocal && combatAnim.includes(a)) return;
    switch (a) {
      case 'swing_1h': this.play('swing', p); break;
      case 'swing_2h': case 'slam': this.play('swing_heavy', p); break;
      case 'stab': case 'punch': this.play('swing_light', p); break;
      case 'kick': this.play('swing_light', p, { pitch: 0.8 }); break;
      case 'block': this.play('cloth', p); break;
      case 'shoot_bow': this.play('bow_release', p); break;
      case 'throw': this.play('throw', p); break;
      case 'cast_forward': case 'cast_up': case 'cast_ground': case 'cast_self': case 'channel':
        this.play('spell_charge', p, { volume: 0.5 });
        break;
      // Tool contact sounds come from the server (impact events) and flora; here only the swing.
      case 'dig': case 'chop': case 'mine': this.play('swing', p, { volume: 0.45, pitch: 0.85 }); break;
      case 'harvest': this.play('cloth', p, { volume: 0.6 }); break;
      case 'pickup': this.play('pickup', p, { volume: 0.7 }); break;
      case 'eat': this.play('eat', p); break;
      case 'drink': this.play('drink', p); break;
      case 'work_hammer': {
        const n = Math.max(1, Math.round(act.dur / 0.7));
        for (let i = 0; i < n; i++) this.after(0.35 + i * 0.7, () => this.play('hammer', p, { volume: 0.8 }));
        break;
      }
      case 'work_saw': this.play('saw', p); break;
      case 'cheer': if (!isLocal) this.bark('cheer', p, race, { appearance: snap.humanoid }); break;
      case 'gesture_wave': if (!isLocal && R() < 0.6) this.bark('greet', p, race, { appearance: snap.humanoid }); break;
      case 'gesture_shrug': if (!isLocal && R() < 0.5) this.bark('hmm', p, race, { appearance: snap.humanoid }); break;
      case 'flinch': if (!isLocal) this.painBark(tr, snap); break;
      case 'stagger': if (!isLocal) this.bark('effort', p, race, { appearance: snap.humanoid }); break;
      case 'bow': case 'sit': case 'pray': case 'dance': this.play('cloth', p, { volume: 0.5 }); break;
      case 'die':
        if (!tr.dead && !isLocal) {
          tr.dead = true;
          this.bark('death', p, race, { appearance: snap.humanoid });
        }
        break;
    }
  }

  private callFor(id: EntityId, snap: EntitySnapshot, sit: CallSituation, vol: number) {
    if (!snap.creature) return;
    const size = this.sizeOf(id, snap);
    const indiv = 1 + ((hash32(snap.creature.seed) & 255) / 255 - 0.5) * 0.12;
    this.creatureCall(snap.creature.species, size, sit, [snap.pos[0], snap.pos[1] + size * 0.6, snap.pos[2]], { volume: vol, pitch: indiv });
  }

  private creatureTick(id: EntityId, tr: Track, snap: EntitySnapshot, d: number, dt: number) {
    if (snap.anim.move === 'dead' || snap.hp <= 0 || (snap.flags & EntFlag.Sleeping) || d > 80) return;
    tr.nextIdle -= dt;
    if (tr.nextIdle > 0) return;
    const beh = (snap.creature?.behavior ?? '').toLowerCase();
    const pid = this.ctx!.state.playerId;
    let sit: CallSituation = 'idle';
    let interval = rr(9, 30);
    if (/flee|scare|panic|escape/.test(beh)) {
      sit = 'alert';
      interval = rr(2, 5);
    } else if (/hunt|attack|chase|aggr|fight|stalk/.test(beh) || ((snap.flags & EntFlag.Hostile) && snap.target === pid)) {
      sit = 'attack';
      interval = rr(4, 10);
    } else if (/alert|warn|threat|guard/.test(beh)) {
      sit = 'alert';
      interval = rr(4, 9);
    } else if (/sleep|rest/.test(beh)) {
      interval = rr(20, 40);
      sit = 'idle';
    }
    tr.nextIdle = interval;
    // First trigger only arms the timer (avoids a burst of calls when many creatures stream in).
    if (tr.idleArmed) this.callFor(id, snap, sit, sit === 'idle' ? 0.6 : 0.9);
    tr.idleArmed = true;
  }

  private humanoidTick(id: EntityId, tr: Track, snap: EntitySnapshot, d: number, now: number) {
    const st = this.ctx!.state;
    const sp = snap.speech;
    if (sp && sp.text !== tr.lastSpeech) {
      tr.lastSpeech = sp.text;
      if (sp.until > st.serverTime && d < 50 && sp.style !== 'think') {
        // Barks preempt babble.
        tr.queue.unshift({ text: sp.text, mood: snap.anim.mood });
        if (tr.voice && now < tr.talkEnd) {
          tr.voice.stop(0.08);
          tr.talkEnd = 0;
        }
      }
    }
    const speaking = now < tr.talkEnd;
    if (tr.voice && speaking) tr.voice.setPosition([snap.pos[0], snap.pos[1] + 1.6 * (snap.scale ?? 1), snap.pos[2]]);
    if (speaking || d > 40) return;
    let item = tr.queue.shift();
    if (!item && snap.anim.talking) item = { text: this.gibberish(), mood: snap.anim.mood };
    if (!item) return;
    const style: SpeechStyle = sp && sp.text === item.text ? sp.style ?? 'say' : 'say';
    const v = speechVoice(snap.humanoid?.race ?? 'human', snap.humanoid, id);
    const head: Vec3 = [snap.pos[0], snap.pos[1] + 1.6 * (snap.scale ?? 1), snap.pos[2]];
    this.speakWith(v, syllabify(item.text, v.accent, style === 'shout' ? 14 : 30), head, item.mood ?? 'neutral', style, 1, tr);
    // Small pause between utterances while chatting.
    tr.talkEnd += rr(0.15, 0.6);
  }

  /** Synthesize an utterance into a (spatial) speech voice. */
  private speakWith(v: ReturnType<typeof speechVoice>, syls: ReturnType<typeof syllabify>, pos: Vec3 | undefined, mood: Mood, style: SpeechStyle, vol: number, tr: Track | null): number {
    const eng = this.engine;
    if (!eng.ctx || !eng.running || !syls.length || style === 'think') return 0;
    const voice = eng.openVoice(SPEECH_DEF, { pos, volume: vol * (style === 'shout' ? 1.3 : style === 'whisper' ? 0.6 : 1), bus: 'voice' });
    if (!voice) return 0;
    const t0 = eng.now + 0.03;
    const dur = speak(eng.ctx, voice.input, t0, v, syls, mood, style);
    voice.end = t0 + dur + 0.3;
    if (tr) {
      tr.voice = voice;
      tr.talkEnd = t0 + dur;
    }
    return dur;
  }

  private gibberish(): string {
    const words = 2 + Math.floor(R() * 5);
    const out: string[] = [];
    for (let i = 0; i < words; i++) {
      let w = '';
      const n = 1 + Math.floor(R() * 3);
      for (let k = 0; k < n; k++) w += GIBBER[Math.floor(R() * GIBBER.length)];
      out.push(w);
    }
    return out.join(' ') + (R() < 0.25 ? '?' : R() < 0.15 ? '!' : '.');
  }

  private painBark(tr: Track, snap: EntitySnapshot) {
    const now = this.engine.now;
    if (now - tr.lastPain < 0.7) return;
    tr.lastPain = now;
    this.bark('pain', [snap.pos[0], snap.pos[1] + 1.6, snap.pos[2]], snap.humanoid?.race ?? 'human', { appearance: snap.humanoid, seed: snap.id });
  }

  // ---------------------------------------------------------------- loops

  /** Sustained looping voice (projectiles, burning entities). */
  private makeLoop(kind: string, pos: Vec3, vol = 1): Voice | null {
    const eng = this.engine;
    const c = eng.ctx;
    if (!c) return null;
    const v = eng.openVoice(LOOP_DEF, { pos, volume: vol });
    if (!v) return null;
    const src = (buf: AudioBuffer) => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(c.currentTime, R() * 2);
      v.sources.push(s);
      return s;
    };
    const filt = (type: BiquadFilterType, f: number, q: number) => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const osc = (type: OscillatorType, f: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start();
      v.sources.push(o);
      return o;
    };
    const gainN = (g: number) => {
      const n = c.createGain();
      n.gain.value = g;
      return n;
    };
    const nb = noiseBuffers(c.sampleRate);
    switch (kind) {
      case 'fire': {
        // Roar + flickering crackle band.
        const a = src(nb.brown);
        const lp = filt('lowpass', 500, 0.8);
        a.connect(lp);
        lp.connect(v.input);
        const b = src(nb.white);
        const bp = filt('bandpass', 3000, 1.2);
        const am = gainN(0.2);
        const lfo = osc('square', 13);
        lfo.connect(gainN(0.2)).connect(am.gain);
        b.connect(bp);
        bp.connect(am);
        am.connect(v.input);
        break;
      }
      case 'frost': {
        for (const f of [3100, 4150, 5230]) {
          const o = osc('sine', f * rr(0.97, 1.03));
          const g = gainN(0.03);
          const trem = osc('sine', rr(5, 9));
          trem.connect(gainN(0.03)).connect(g.gain);
          o.connect(g);
          g.connect(v.input);
        }
        const n = src(nb.pink);
        const hp = filt('highpass', 4000, 0.7);
        n.connect(hp);
        hp.connect(gainN(0.25)).connect(v.input);
        break;
      }
      case 'shock': {
        const o = osc('sawtooth', 110);
        const hp = filt('highpass', 800, 0.7);
        const am = gainN(0.1);
        const lfo = osc('square', 37);
        lfo.connect(gainN(0.1)).connect(am.gain);
        o.connect(hp);
        hp.connect(am);
        am.connect(v.input);
        break;
      }
      case 'whistle': {
        const n = src(nb.white);
        const bp = filt('bandpass', 2600, 9);
        n.connect(bp);
        bp.connect(gainN(0.6)).connect(v.input);
        break;
      }
      default: {
        // Generic magic hum with wobble.
        const o = osc('sine', 220);
        const mod = osc('sine', 3.3);
        mod.connect(gainN(12)).connect(o.frequency);
        const o2 = osc('triangle', 331);
        const g = gainN(0.12);
        o.connect(g);
        o2.connect(gainN(0.05)).connect(v.input);
        g.connect(v.input);
        const n = src(nb.pink);
        const bp = filt('bandpass', 1500, 2);
        n.connect(bp);
        bp.connect(gainN(0.1)).connect(v.input);
      }
    }
    // Fade in to avoid clicks.
    const now = c.currentTime;
    const target = v.out.gain.value;
    v.out.gain.setValueAtTime(0, now);
    v.out.gain.linearRampToValueAtTime(target, now + 0.08);
    return v;
  }

  private projectileLoop(tr: Track, snap: EntitySnapshot, d: number) {
    if (d > 60) {
      if (tr.loop) {
        tr.loop.stop(0.2);
        tr.loop = null;
      }
      return;
    }
    if (!tr.loop) {
      const fx = (snap.projectile?.fx ?? '').toLowerCase();
      const kind = /fire|flame|ember|magma/.test(fx) ? 'fire'
        : /frost|ice|cold/.test(fx) ? 'frost'
        : /shock|lightning|spark/.test(fx) ? 'shock'
        : /arrow|bolt|spear|rock|stone|throw|dart|knife|axe/.test(fx) ? 'whistle'
        : 'magic';
      tr.loop = this.makeLoop(kind, snap.pos, kind === 'whistle' ? 0.5 : 0.7);
    } else tr.loop.setPosition(snap.pos);
  }

  // ================================================================ events

  private onGameEvent(ev: GameEvent): void {
    const ctx = this.ctx;
    if (!ctx || !this.engine.running) return;
    const st = ctx.state;
    const pid = st.playerId;
    switch (ev.type) {
      case 'damage': {
        const tgt = st.entities.get(ev.target);
        const vol = clamp(0.55 + ev.amount / 40, 0.5, 1.3);
        const base = DTYPE_SOUND[ev.dtype] ?? 'hit_flesh';
        const fleshy = !tgt || tgt.kind === 'creature' || tgt.kind === 'npc' || tgt.kind === 'player';
        const physical = ev.dtype === 'slash' || ev.dtype === 'pierce' || ev.dtype === 'blunt';
        if (physical && tgt?.equipment && R() < 0.35) this.play('hit_metal', ev.pos, { volume: vol * 0.6 });
        this.play(physical && !fleshy ? 'hit_stone' : base, ev.pos, { volume: physical ? vol : vol * 0.5, pitch: ev.dtype === 'blunt' ? 0.85 : ev.dtype === 'pierce' ? 1.15 : 1 });
        if (ev.crit) this.play('hit_crit', ev.pos, { volume: vol });
        if (tgt) {
          const tr = this.tracks.get(ev.target);
          if (tgt.kind === 'creature' && tr && this.engine.now - tr.lastPain > 0.6 && R() < 0.85) {
            tr.lastPain = this.engine.now;
            this.callFor(ev.target, tgt, 'pain', 0.9);
          } else if ((tgt.kind === 'npc' || tgt.kind === 'player') && tr && (ev.target !== pid || R() < 0.6)) this.painBark(tr, tgt);
        }
        if (ev.target === pid || ev.source === pid) this.bumpCombat(ev.crit ? 0.45 : 0.3);
        else if (Math.hypot(ev.pos[0] - this.engine.listener[0], ev.pos[2] - this.engine.listener[2]) < 30) this.bumpCombat(0.08);
        break;
      }
      case 'heal':
        this.play('heal_impact', ev.pos, { volume: clamp(0.4 + ev.amount / 50, 0.4, 1) });
        break;
      case 'death': {
        const tgt = st.entities.get(ev.target);
        const tr = this.tracks.get(ev.target);
        if (ev.target === pid) {
          this.play('death_sting');
          this.music?.silence();
          this.stems?.silence();
          this.combat = 0;
        } else if (tgt && tr && !tr.dead) {
          tr.dead = true;
          if (tgt.kind === 'creature') this.callFor(ev.target, tgt, 'death', 1.1);
          else if (tgt.kind === 'npc' || tgt.kind === 'player') this.bark('death', [tgt.pos[0], tgt.pos[1] + 1.5, tgt.pos[2]], tgt.humanoid?.race ?? 'human', { appearance: tgt.humanoid, seed: tgt.id });
          this.after(0.5, () => this.play('land', tgt.pos, { volume: 0.8, pitch: 0.8 }));
        }
        if (ev.killer === pid) this.bumpCombat(-0.15);
        break;
      }
      case 'fx': {
        const name = soundForFx(this.catalog, ev.fx);
        if (!name) break;
        if (GLOBAL_SOUNDS.has(name)) {
          // Sky-wide events (aurora, eclipse) are heard everywhere, not at a point.
          this.play(name);
          break;
        }
        const r = Math.min(ev.radius ?? 1, 30);
        this.play(name, ev.pos, { volume: clamp(0.6 + r * 0.08, 0.5, 1.4), pitch: clamp(1.1 - r * 0.03, 0.75, 1.1) });
        if (r > 4 && name.endsWith('_impact')) this.play('debris', ev.pos, { volume: 0.5 });
        break;
      }
      case 'impact': {
        // material is a terrain MaterialDef name ("dirt", "forest floor"...) or an object material; force 0..1.
        const m = ev.material.toLowerCase();
        const f = clamp(ev.force, 0, 1.5);
        const vol = 0.45 + f * 0.6;
        const fam = MAT_FAMILY.get(m);
        let name: string;
        if (m === 'water') name = f > 0.7 ? 'splash_big' : 'splash';
        else if (fam) name = fam === 'stone' ? 'hit_stone' : fam === 'crystal' ? 'hit_crystal' : fam === 'ice' ? 'hit_ice' : fam === 'wood' ? 'hit_wood' : 'hit_soil';
        else name = 'hit_' + (['metal', 'wood', 'stone', 'flesh', 'crystal', 'ice', 'plant', 'cloth'].find((k) => m.includes(k)) ?? 'stone');
        this.play(name, ev.pos, { volume: vol });
        if (f > 0.8 && (fam === 'stone' || fam === 'crystal')) this.play(fam === 'crystal' ? 'pebble' : 'debris', ev.pos, { volume: 0.4 });
        break;
      }
      case 'sound': {
        if (ev.sound.startsWith('creature_')) {
          // Creature calls arrive as action anims too (with the species' own voice) — only
          // fall back to a generic call when no creature is replicated at that spot.
          let near = false;
          for (const sn of st.entities.values()) {
            if (sn.kind === 'creature' && Math.hypot(sn.pos[0] - ev.pos[0], sn.pos[2] - ev.pos[2]) < 4) {
              near = true;
              break;
            }
          }
          if (!near) this.creatureCall(hashString(ev.sound) % 64, clamp((ev.volume ?? 1) * 1.5, 0.3, 3), /roar|alert/.test(ev.sound) ? 'alert' : 'attack', ev.pos, { volume: ev.volume });
          break;
        }
        const g = GLOBAL_SOUNDS.has(this.catalog.resolve(ev.sound));
        this.play(ev.sound, g ? undefined : ev.pos, { volume: ev.volume });
        break;
      }
      case 'xp':
        // Level-ups/unlocks are voiced by the UI (ui.levelup / ui.unlock); we add the small tick.
        if (!ev.leveled && this.engine.now - this.lastXp > 0.8) {
          this.lastXp = this.engine.now;
          this.play('xp_tick', undefined, { volume: 0.6 });
        }
        break;
      case 'loot':
        this.play(ev.items.some((i) => /gold|coin|silver|copper/.test(i)) ? 'coins' : 'pickup', ctx.playerPos(), { volume: 0.8 });
        break;
      case 'notify':
        this.play(ev.tone === 'good' ? 'notify_good' : ev.tone === 'bad' ? 'notify_bad' : ev.tone === 'warn' ? 'notify_warn' : 'notify');
        break;
      case 'shake':
        if (ev.strength > 0.3) this.play('rumble', ev.pos, { volume: clamp(ev.strength, 0.3, 1.2) });
        break;
      case 'gravity':
        this.play('gravity_cast', ev.pos, { volume: clamp(ev.radius / 10, 0.5, 1.2), pitch: ev.factor > 1 ? 0.8 : 1.15 });
        break;
      case 'knockback':
        if (ev.target === pid) this.play('swing_heavy', ctx.playerPos(), { volume: 0.7, pitch: 0.8 });
        break;
    }
  }

  private onDialog(view: DialogView): void {
    if (view.sessionId !== this.dialogSession) {
      this.dialogSession = view.sessionId;
      this.dialogLines = 0;
    }
    this.dialogOpen = !view.ended;
    const fresh = view.lines.slice(this.dialogLines);
    this.dialogLines = view.lines.length;
    const ctx = this.ctx;
    if (!ctx) return;
    const snap = ctx.state.entities.get(view.npcId);
    for (const line of fresh) {
      const fromNpc = line.speakerId === view.npcId || (line.speakerId === undefined && line.speaker === view.npcName);
      if (!fromNpc) continue;
      if (snap) {
        let tr = this.tracks.get(view.npcId);
        if (!tr) {
          tr = this.newTrack(snap);
          this.tracks.set(view.npcId, tr);
        }
        tr.queue.push({ text: line.text, mood: line.mood });
      } else {
        // NPC not replicated (edge case): speak in front of the listener.
        this.speakText(line.text, undefined, 'human', { mood: line.mood, seed: view.npcId });
      }
    }
    if (view.ended) {
      const tr = this.tracks.get(view.npcId);
      if (tr) tr.queue.length = 0;
    }
  }
}
