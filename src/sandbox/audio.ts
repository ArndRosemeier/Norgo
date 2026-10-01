/**
 * Audio sandbox: trigger every procedural sound, footsteps, creature voices,
 * gibberish speech, ambience scenarios (biome/time/weather/space) and the
 * generative score for any world seed. Uses a minimal fake ClientContext so
 * the real AudioSystem (event hooks + entity scanning included) is exercised.
 */
import * as THREE from 'three';
import { AudioSystem } from '../audio/AudioSystem';
import { BUS_NAMES } from '../audio/engine';
import type { ClientContext, ClientEvents } from '../client/context';
import type { EntitySnapshot, GameEvent } from '../shared/protocol';
import type { Vec3, WeatherKind } from '../shared/types';
import { Emitter } from '../core/events';
import { WorldGenerator } from '../world/generator';
import { BIOMES, BIOME_COUNT, Biome } from '../world/biomes';
import { parseSeed } from '../core/rng';
import { STEP_FAMILIES } from '../audio/sounds/foley';
import { CALL_KINDS, creatureVoice, CallSituation } from '../audio/creatureVoice';
import { BARK_KINDS, BarkKind, Mood, SpeechStyle } from '../audio/speech';
import type { SpaceKind } from '../audio/reverb';
import { SPACES } from '../audio/reverb';
import { RACE_IDS } from '../humanoid/types';
import type { AudioEnv } from '../audio/probe';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $('main');

let sys: AudioSystem;
let ctx: ClientContext;
let gen: WorldGenerator;
const L: Vec3 = [0, 20, 0];

function makeContext(seed: number): ClientContext {
  gen = new WorldGenerator(seed);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const events = new Emitter<ClientEvents>();
  const envObj = {
    timeOfDay: 0.3,
    weather: { kind: 'clear' as WeatherKind, intensity: 0, windX: 3, windZ: 1 },
    biomeName: () => 'sandbox',
  };
  const state = {
    playerId: 1, player: {} as never, serverTime: 0, entities: new Map<number, EntitySnapshot>(), objects: new Map(), timeOfDay: 0.3, day: 0,
  };
  const c = {
    seed, gen, profile: gen.profile, camera, scene: new THREE.Scene(), env: envObj, events, state, views: new Map(),
    terrain: { raycast: () => null, material: () => 0, density: () => -1 },
    colliders: { add() {}, remove() {}, removeOwner() {}, query: () => [], raycast: () => null },
    audio: null as never, core: null as never, streamer: null as never, debris: null as never,
    send() {}, playerPos: () => L, findItem: () => undefined, uiRoot: document.body, setUiCapture() {}, uiCaptured: false,
  };
  return c as unknown as ClientContext;
}

function boot(seed: number) {
  sys?.dispose();
  ctx = makeContext(seed);
  sys = new AudioSystem();
  (ctx as unknown as { audio: AudioSystem }).audio = sys;
  sys.init(ctx);
  sys.listenerOverride = { pos: L, fwd: [0, 0, -1], up: [0, 1, 0] };
  applyEnv();
  // Expose for console experiments.
  (window as unknown as { norgoAudio: unknown }).norgoAudio = { sys, ctx, gen };
  const th = sys.music!.theme;
  $('worldinfo').textContent = `${gen.profile.name} · weirdness ${gen.profile.weirdness.toFixed(2)} · ${th.scaleName} · ${th.tempo.toFixed(0)} bpm · ${th.meter}/x · lead ${th.leadDay}/${th.leadNight}/${th.leadDeep}`;
  buildSoundGrid();
}

// ------------------------------------------------------------------ UI helpers

function section(title: string, wide = false): HTMLElement {
  const s = document.createElement('section');
  if (wide) s.className = 'wide';
  const h = document.createElement('h2');
  h.textContent = title;
  s.appendChild(h);
  main.appendChild(s);
  return s;
}
function btn(parent: HTMLElement, label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => {
    sys.start();
    fn();
  };
  parent.appendChild(b);
  return b;
}
function slider(parent: HTMLElement, label: string, min: number, max: number, val: number, step: number, fn: (v: number) => void): HTMLInputElement {
  const l = document.createElement('label');
  l.textContent = label;
  const i = document.createElement('input');
  i.type = 'range';
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(val);
  const out = document.createElement('span');
  out.textContent = String(val);
  i.oninput = () => {
    out.textContent = i.value;
    fn(Number(i.value));
  };
  l.append(i, out);
  parent.appendChild(l);
  return i;
}
function select<T extends string | number>(parent: HTMLElement, label: string, opts: [T, string][], val: T, fn: (v: T) => void): HTMLSelectElement {
  const l = document.createElement('label');
  l.textContent = label;
  const s = document.createElement('select');
  for (const [v, t] of opts) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = t;
    if (v === val) o.selected = true;
    s.appendChild(o);
  }
  s.onchange = () => fn((typeof val === 'number' ? Number(s.value) : s.value) as T);
  l.appendChild(s);
  parent.appendChild(l);
  return s;
}
const grid = (p: HTMLElement) => {
  const d = document.createElement('div');
  d.className = 'grid';
  p.appendChild(d);
  return d;
};

// ------------------------------------------------------------------ position mode

let posMode: 'ui' | 'front' | 'orbit' | 'far' = 'orbit';
function soundPos(): Vec3 | undefined {
  if (posMode === 'ui') return undefined;
  if (posMode === 'front') return [L[0], L[1], L[2] - 3];
  const a = Math.random() * Math.PI * 2;
  const d = posMode === 'far' ? 40 + Math.random() * 60 : 3 + Math.random() * 12;
  return [L[0] + Math.cos(a) * d, L[1] + Math.random() * 2 - 0.5, L[2] + Math.sin(a) * d];
}

// ------------------------------------------------------------------ sections

const top = section('Mixer & placement', true);
for (const b of BUS_NAMES) slider(top, b, 0, 1, 0.8, 0.01, (v) => sys.setVolumes({ [b]: v }));
select(top, 'Position', [['orbit', 'orbit 3-15 m'], ['front', 'in front'], ['far', 'far 40-100 m'], ['ui', '2D / UI']], posMode, (v) => (posMode = v));

const soundsSec = section('All sounds (play(name))', true);
const soundGrid = grid(soundsSec);
function buildSoundGrid() {
  soundGrid.innerHTML = '';
  let group = '';
  for (const n of sys.soundNames()) {
    const g = n.split('_')[0];
    if (g !== group && soundGrid.childElementCount) soundGrid.appendChild(document.createElement('br'));
    group = g;
    btn(soundGrid, n, () => sys.play(n, n.startsWith('ui_') || /level_up|unlock|quest_|notify|xp_tick|discovery|death_sting/.test(n) ? undefined : soundPos()));
  }
}

const steps = section('Footsteps');
let stepInt = 0.6;
slider(steps, 'intensity', 0.05, 1.2, stepInt, 0.05, (v) => (stepInt = v));
const sg = grid(steps);
let walking: StepFamilyName | null = null;
type StepFamilyName = (typeof STEP_FAMILIES)[number];
let walkT = 0;
let walkSide = 1;
for (const f of STEP_FAMILIES) btn(sg, f, () => sys.footstepFamily(f, [L[0] + 0.2, L[1] - 1.6, L[2] - 1], stepInt));
const wg = grid(steps);
for (const f of STEP_FAMILIES) {
  const b = btn(wg, 'walk ' + f, () => {
    walking = walking === f ? null : f;
    wg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    if (walking) b.classList.add('on');
  });
}
const mv = grid(steps);
for (const n of ['jump', 'land', 'land_heavy', 'swim', 'splash', 'cloth', 'armor_light', 'armor_heavy']) btn(mv, n, () => sys.play(n, [L[0], L[1] - 1, L[2] - 1.5]));

const cre = section('Creature voices (species from world fauna seed)');
let species = 0;
let csize = 1;
let csit: CallSituation = 'idle';
const cinfo = document.createElement('pre');
const showVoice = () => {
  const v = creatureVoice(gen.profile.faunaSeed, species, csize, gen.profile.lifeWeirdness);
  cinfo.textContent = `species ${species}: primary ${v.primary}, aggressive ${v.aggressive}, pitch×${v.pitchMul.toFixed(2)} formant×${v.formantMul.toFixed(2)} rough ${v.rough.toFixed(2)} breath ${v.breath.toFixed(2)} wave ${v.wave}${v.fmIndex ? ' FM ' + v.fmRatio : ''}`;
};
const spIn = slider(cre, 'species', 0, 40, 0, 1, (v) => { species = v; showVoice(); });
slider(cre, 'size m', 0.1, 6, 1, 0.05, (v) => { csize = v; showVoice(); });
select(cre, 'situation', (['idle', 'alert', 'attack', 'pain', 'death'] as CallSituation[]).map((s) => [s, s]), csit, (v) => (csit = v));
const cg = grid(cre);
btn(cg, 'Call', () => sys.creatureCall(species, csize, csit, soundPos() ?? [L[0], L[1], L[2] - 4]));
btn(cg, 'Random species', () => {
  species = Math.floor(Math.random() * 40);
  spIn.value = String(species);
  showVoice();
  sys.creatureCall(species, csize, csit, soundPos() ?? [L[0], L[1], L[2] - 4]);
});
btn(cg, 'Size sweep', () => {
  [0.15, 0.4, 1, 2.2, 5].forEach((s, i) => setTimeout(() => sys.creatureCall(species, s, csit, [L[0] + (i - 2) * 3, L[1], L[2] - 5]), i * 900));
});
cre.appendChild(cinfo);
const kinds = document.createElement('pre');
kinds.textContent = 'Call kinds: ' + CALL_KINDS.join(', ');
cre.appendChild(kinds);

const sp = section('NPC speech (gibberish) & barks');
let race = 'human';
let mood: Mood = 'neutral';
let style: SpeechStyle = 'say';
let gender = 1;
let age = 0.5;
select(sp, 'race', RACE_IDS.map((r) => [r, r] as [string, string]), race, (v) => (race = v));
select(sp, 'mood', (['neutral', 'happy', 'angry', 'sad', 'afraid', 'surprised', 'disgusted', 'focused', 'pain'] as Mood[]).map((m) => [m, m]), mood, (v) => (mood = v));
select(sp, 'style', (['say', 'shout', 'whisper'] as SpeechStyle[]).map((m) => [m, m]), style, (v) => (style = v));
slider(sp, 'gender', 0, 1, gender, 0.05, (v) => (gender = v));
slider(sp, 'age', 0.1, 1, age, 0.05, (v) => (age = v));
const txt = document.createElement('input');
txt.type = 'text';
txt.size = 48;
txt.value = 'Well met, traveller! Have you come about the wolves in the old forest?';
sp.appendChild(txt);
const appearance = () => ({ race, race2: null, raceMix: 0, seed: 7, gender, age, scale: race === 'giantkin' ? 1.6 : race === 'halfling' || race === 'goblin' ? 0.7 : 1 }) as never;
btn(sp, 'Speak', () => sys.speakText(txt.value, [L[0] + 1, L[1], L[2] - 2], race, { mood, style, appearance: appearance() }));
const bg = grid(sp);
for (const b of BARK_KINDS) btn(bg, b, () => sys.bark(b as BarkKind, [L[0] + 1, L[1], L[2] - 2], race, { appearance: appearance() }));
btn(bg, 'Race roll call', () => {
  RACE_IDS.forEach((r, i) => setTimeout(() => sys.speakText('Hello there, friend.', [L[0] + (i - 5) * 1.5, L[1], L[2] - 3], r, { seed: i }), i * 1700));
});

// ------------------------------------------------------------------ ambience scenario

const amb = section('Ambience scenario (environment override)', true);
const scen = {
  biome: Biome.TemperateForest as number, tod: 0.3, weather: 'clear' as WeatherKind, intensity: 0.7, forest: 0.8, coast: 0, river: 0, settlement: 0,
  cave: 0, indoor: 0, underwater: false, altitude: 20, override: true, space: 'auto' as SpaceKind | 'auto',
  siteRace: 'human', alpine: 0,
};
function applyEnv() {
  if (!sys) return;
  const e = ctx.env as unknown as { timeOfDay: number; weather: { kind: WeatherKind; intensity: number; windX: number; windZ: number } };
  e.timeOfDay = scen.tod;
  e.weather.kind = scen.weather;
  e.weather.intensity = scen.weather === 'clear' ? 0 : scen.intensity;
  if (!scen.override) {
    sys.setEnvOverride(null);
    return;
  }
  const w = new Float32Array(BIOME_COUNT);
  w[scen.biome] = 1;
  const uw = BIOMES[scen.biome].underworld ? 1 : 0;
  const tod = scen.tod;
  const day = Math.min(1, Math.max(0, (tod - 0.21) / 0.08)) * (1 - Math.min(1, Math.max(0, (tod - 0.71) / 0.08)));
  const k = (kind: WeatherKind) => (scen.weather === kind ? scen.intensity : 0);
  const o: Partial<AudioEnv> = {
    biomeW: w, underworld: uw, cave: uw ? 0 : scen.cave, enclosure: uw || scen.cave > 0.5 ? 0.9 : scen.forest * 0.2, roomSize: uw ? 40 : scen.cave > 0.5 ? 12 : 48,
    indoor: scen.indoor, altitude: scen.altitude, aboveGround: 2, alpine: scen.alpine, siteRace: scen.settlement > 0 ? scen.siteRace : null, coast: scen.coast, river: scen.river, forest: scen.forest, settlement: scen.settlement,
    underwater: scen.underwater, day, dawn: Math.exp(-Math.pow((tod - 0.255) / 0.035, 2)), dusk: Math.exp(-Math.pow((tod - 0.745) / 0.035, 2)), night: 1 - day,
    weather: scen.weather, rain: k('rain') + k('storm'), storm: k('storm'), snow: k('snow'), fog: k('fog'), ash: k('ashfall'), spores: k('sporefall'),
    wind: 0.3 + k('storm') * 0.7 + k('snow') * 0.3, temp: (BIOMES[scen.biome].temp ?? 0),
  };
  if (scen.space !== 'auto') o.space = scen.space;
  sys.setEnvOverride(o);
}
select(amb, 'biome', BIOMES.map((b) => [b.id as number, b.name + (b.underworld ? ' (underworld)' : '')] as [number, string]), scen.biome, (v) => { scen.biome = v; applyEnv(); });
slider(amb, 'time of day', 0, 1, scen.tod, 0.005, (v) => { scen.tod = v; applyEnv(); });
select(amb, 'weather', (['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'ashfall', 'sporefall'] as WeatherKind[]).map((w) => [w, w]), scen.weather, (v) => { scen.weather = v; applyEnv(); });
slider(amb, 'intensity', 0, 1, scen.intensity, 0.05, (v) => { scen.intensity = v; applyEnv(); });
for (const key of ['forest', 'coast', 'river', 'settlement', 'cave', 'indoor'] as const) slider(amb, key, 0, 1, scen[key], 0.05, (v) => { scen[key] = v; applyEnv(); });
slider(amb, 'altitude', -20, 500, scen.altitude, 5, (v) => { scen.altitude = v; applyEnv(); });
const uwb = btn(amb, 'underwater', () => { scen.underwater = !scen.underwater; uwb.classList.toggle('on', scen.underwater); applyEnv(); });
select(amb, 'reverb space', [['auto', 'auto'], ...(Object.keys(SPACES) as SpaceKind[]).map((s) => [s, s] as [SpaceKind, string])] as [SpaceKind | 'auto', string][], scen.space, (v) => { scen.space = v; applyEnv(); });
const presets: [string, Partial<typeof scen>][] = [
  ['Dawn forest', { biome: Biome.TemperateForest, tod: 0.255, weather: 'clear', forest: 0.9, coast: 0, cave: 0, settlement: 0 }],
  ['Night meadow', { biome: Biome.Grassland, tod: 0.9, weather: 'clear', forest: 0.2, coast: 0, cave: 0 }],
  ['Jungle noon', { biome: Biome.Jungle, tod: 0.5, weather: 'clear', forest: 1 }],
  ['Swamp dusk', { biome: Biome.Swamp, tod: 0.75, forest: 0.5, river: 0.3 }],
  ['Stormy coast', { biome: Biome.Ocean, tod: 0.6, weather: 'storm', coast: 1, forest: 0 }],
  ['Glacier blizzard', { biome: Biome.Glacier, tod: 0.45, weather: 'snow', altitude: 380, forest: 0 }],
  ['Ashlands', { biome: Biome.Volcanic, tod: 0.4, weather: 'ashfall', forest: 0 }],
  ['Crystal wastes', { biome: Biome.CrystalWastes, tod: 0.6, forest: 0 }],
  ['Fungal grove', { biome: Biome.FungalGrove, tod: 0.8, weather: 'sporefall', forest: 0.6 }],
  ['Cave', { biome: Biome.Taiga, cave: 1, forest: 0 }],
  ['Glow caverns', { biome: Biome.GlowCaverns, forest: 0, cave: 0 }],
  ['Magma depths', { biome: Biome.MagmaDepths, forest: 0, cave: 0 }],
  ['Bone hollows', { biome: Biome.BoneHollows, forest: 0, cave: 0 }],
  ['Village day', { biome: Biome.Grassland, tod: 0.45, settlement: 1, forest: 0.2 }],
  ['Tavern (indoor rain)', { biome: Biome.Grassland, tod: 0.85, weather: 'rain', settlement: 0.8, indoor: 1 }],
];
const pg = grid(amb);
for (const [n, p] of presets) btn(pg, n, () => {
  Object.assign(scen, { coast: 0, river: 0, settlement: 0, cave: 0, indoor: 0, underwater: false, altitude: 20, weather: 'clear', intensity: 0.7 }, p);
  applyEnv();
});
const ambInfo = document.createElement('pre');
amb.appendChild(ambInfo);

// ------------------------------------------------------------------ music & events

const mus = section('Music');
const fp = btn(mus, 'Force play', () => { sys.music!.forcePlay = !sys.music!.forcePlay; fp.classList.toggle('on', sys.music!.forcePlay); });
slider(mus, 'combat', 0, 1, 0, 0.05, (v) => (sys.combatOverride = v > 0 ? v : null));
const musInfo = document.createElement('pre');
mus.appendChild(musInfo);

// Adaptive stems (public/assets/audio/music, see docs/ARCHITECTURE.md → Adaptive score).
const stemSec = section('Adaptive stems');
const STEM_SETS = ['auto', 'meadow', 'woodland', 'jungle', 'highland', 'desert', 'coast', 'wonder', 'ember', 'night', 'cave', 'underglow', 'underdread', 'hearth', 'sylvan', 'forge', 'wild', 'combat', 'boss'];
select(stemSec, 'force set', STEM_SETS.map((id) => [id, id] as [string, string]), 'auto', (v) => {
  sys.start();
  sys.stems?.force(v === 'auto' ? null : v);
});
select(stemSec, 'music style', [['adaptive', 'Adaptive score'], ['generative', 'Generative only']] as [string, string][], 'adaptive', (v) => sys.setMusicStyle(v === 'generative' ? 'generative' : 'adaptive'));
select(stemSec, 'settlement race', ['human', 'elf', 'dwarf', 'orc', 'halfling', 'goblin', 'sylvan', 'drakeborn', 'umbral', 'giantkin'].map((r) => [r, r] as [string, string]), 'human', (v) => {
  scen.siteRace = v;
  applyEnv();
});
slider(stemSec, 'alpine', 0, 1, 0, 0.05, (v) => {
  scen.alpine = v;
  applyEnv();
});
const stemInfo = document.createElement('pre');
stemSec.appendChild(stemInfo);
let stemInfoT = 0;

const evs = section('Game events (through ctx.events)');
const emit = (e: GameEvent) => ctx.events.emit('gameEvent', e);
const eg = grid(evs);
btn(eg, 'damage slash', () => emit({ type: 'damage', target: 99, amount: 12, dtype: 'slash', pos: soundPos() ?? L }));
btn(eg, 'damage crit', () => emit({ type: 'damage', target: 1, source: 99, amount: 30, dtype: 'blunt', crit: true, pos: [L[0], L[1], L[2] - 2] }));
btn(eg, 'damage fire', () => emit({ type: 'damage', target: 99, amount: 15, dtype: 'fire', pos: soundPos() ?? L }));
btn(eg, 'fx fireball_impact', () => emit({ type: 'fx', fx: 'fireball_impact', pos: soundPos() ?? L, radius: 3 }));
btn(eg, 'fx frost_nova', () => emit({ type: 'fx', fx: 'frost_nova', pos: soundPos() ?? L, radius: 5 }));
btn(eg, 'fx earth_spike', () => emit({ type: 'fx', fx: 'earth_spike', pos: soundPos() ?? L, radius: 2 }));
btn(eg, 'fx explosion', () => emit({ type: 'fx', fx: 'explosion', pos: soundPos() ?? L, radius: 6 }));
btn(eg, 'impact wood', () => emit({ type: 'impact', pos: soundPos() ?? L, normal: [0, 1, 0], material: 'wood', force: 6 }));
btn(eg, 'impact stone big', () => emit({ type: 'impact', pos: soundPos() ?? L, normal: [0, 1, 0], material: 'stone', force: 20 }));
btn(eg, 'sound "chop"', () => emit({ type: 'sound', sound: 'chop', pos: soundPos() ?? L }));
btn(eg, 'xp', () => emit({ type: 'xp', skill: 'swords', amount: 5, level: 3, leveled: false }));
btn(eg, 'level up', () => emit({ type: 'xp', skill: 'swords', amount: 5, level: 4, leveled: true }));
btn(eg, 'unlock', () => emit({ type: 'unlock', ability: 'fireball', skill: 'fire' }));
btn(eg, 'loot gold', () => emit({ type: 'loot', items: ['gold_coin'] }));
btn(eg, 'notify bad', () => emit({ type: 'notify', text: 'x', tone: 'bad' }));
btn(eg, 'shake', () => emit({ type: 'shake', pos: soundPos() ?? L, strength: 0.8 }));
btn(eg, 'gravity field', () => emit({ type: 'gravity', pos: soundPos() ?? L, radius: 8, factor: 0.3, until: 0 }));
btn(eg, 'player death', () => emit({ type: 'death', target: 1 }));

// ------------------------------------------------------------------ fake entities

const ents = section('Fake entities (entity scanning)');
let nextId = 100;
const actors: { id: number; ang: number; r: number; speed: number }[] = [];
const eg2 = grid(ents);
btn(eg2, 'Talking NPC (orbiting)', () => {
  const id = nextId++;
  const r = RACE_IDS[Math.floor(Math.random() * RACE_IDS.length)];
  const snap: EntitySnapshot = {
    id, kind: 'npc', pos: [L[0] + 3, L[1] - 1.6, L[2]], vel: [0, 0, 0], yaw: 0, anim: { move: 'walk', talking: true, mood: 'happy' }, hp: 10, maxHp: 10, flags: 0,
    humanoid: { race: r, race2: null, raceMix: 0, seed: id, gender: Math.random(), age: 0.4, scale: 1 } as never,
  };
  ctx.state.entities.set(id, snap);
  actors.push({ id, ang: 0, r: 4, speed: 0.35 });
});
btn(eg2, 'Creature herd (5)', () => {
  for (let i = 0; i < 5; i++) {
    const id = nextId++;
    const sp = Math.floor(Math.random() * 30);
    const snap: EntitySnapshot = {
      id, kind: 'creature', pos: [L[0] + 8, L[1] - 1.6, L[2]], vel: [0, 0, 0], yaw: 0, anim: { move: 'walk' }, hp: 10, maxHp: 10, flags: 0,
      creature: { species: sp, seed: id * 7, growth: 0.5 + Math.random() * 0.5, behavior: 'graze' }, scale: 0.4 + Math.random() * 2.5,
    };
    ctx.state.entities.set(id, snap);
    actors.push({ id, ang: Math.random() * 6, r: 6 + Math.random() * 10, speed: 0.1 + Math.random() * 0.2 });
  }
});
btn(eg2, 'Fire projectile', () => {
  const id = nextId++;
  ctx.state.entities.set(id, { id, kind: 'projectile', pos: [L[0] - 20, L[1], L[2] - 3], vel: [14, 0, 0], yaw: 0, anim: { move: 'fly' }, hp: 1, maxHp: 1, flags: 0, projectile: { fx: 'fireball', owner: 9 } });
  actors.push({ id, ang: -1, r: 0, speed: 0 });
});
btn(eg2, 'Creatures: roar!', () => {
  for (const s of ctx.state.entities.values()) if (s.kind === 'creature') s.anim = { move: 'idle', action: { id: 'roar', t0: ctx.state.serverTime, dur: 1.5 } };
});
btn(eg2, 'Clear', () => {
  for (const a of actors) {
    ctx.state.entities.delete(a.id);
    ctx.events.emit('entityRemoved', { id: a.id });
  }
  actors.length = 0;
});

// ------------------------------------------------------------------ loop

$('start').onclick = () => sys.start();
$('reseed').onclick = () => {
  boot(parseSeed($<HTMLInputElement>('seed').value));
  sys.start();
};
boot(parseSeed($<HTMLInputElement>('seed').value));

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  ctx.state.serverTime += dt;
  // Move fake actors
  for (const a of actors) {
    const s = ctx.state.entities.get(a.id);
    if (!s) continue;
    if (s.kind === 'projectile') {
      s.pos = [s.pos[0] + s.vel[0] * dt, s.pos[1], s.pos[2]];
      if (s.pos[0] > L[0] + 25) {
        ctx.state.entities.delete(a.id);
        ctx.events.emit('entityRemoved', { id: a.id });
        sys.play('fire_impact', s.pos);
      }
      continue;
    }
    a.ang += a.speed * dt;
    const nx = L[0] + Math.cos(a.ang) * a.r, nz = L[2] + Math.sin(a.ang) * a.r;
    s.vel = [(nx - s.pos[0]) / dt, 0, (nz - s.pos[2]) / dt];
    s.pos = [nx, L[1] - 1.6, nz];
  }
  if (walking) {
    walkT += dt;
    const interval = 0.62 - stepInt * 0.25;
    if (walkT > interval) {
      walkT = 0;
      walkSide = -walkSide;
      sys.footstepFamily(walking, [L[0] + 0.15 * walkSide, L[1] - 1.6, L[2] - 0.6], stepInt * (0.9 + Math.random() * 0.2));
    }
  }
  sys.update(dt, now / 1000);
  if (sys.music) musInfo.textContent = sys.music.debug();
  if (sys.stems && now - stemInfoT > 250) {
    stemInfoT = now;
    const st = sys.stems.status();
    stemInfo.textContent = `${sys.stems.debugLine()}
${JSON.stringify({ active: st.active, fading: st.fading, resident: st.resident, loading: st.loading }, null, 1)}`;
  }
  const e = sys.env;
  const rates = sys.ambience ? Object.entries(sys.ambience.rates).filter(([, v]) => v > 0.05).map(([k, v]) => `${k}:${v.toFixed(1)}/min`).join('  ') : '';
  ambInfo.textContent = `space ${e.space} · dominant ${BIOMES[e.dominant]?.name} · day ${e.day.toFixed(2)} dawn ${e.dawn.toFixed(2)} · wind ${e.wind.toFixed(2)}\nemitters: ${rates}`;
  $('stats').textContent = `voices ${sys.engine.activeVoices()} · ctx ${sys.engine.ctx?.state ?? 'not started'}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
