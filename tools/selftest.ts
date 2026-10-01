/**
 * Headless integration smoke test: boots a GameServer in Node, joins a player,
 * walks around, uses messages of every domain and checks invariants.
 * Run: npm test   (or npx tsx tools/selftest.ts [seed])
 */
import { GameServer } from '../src/server/GameServer';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { randomAppearance } from '../src/humanoid/appearance';
import { WorldGenerator } from '../src/world/generator';
import { meshChunk } from '../src/world/mesher';
import { mergeCycle, rankTargets, stepCycle } from '../src/client/targetRules';
import { readFileSync } from 'node:fs';
import { Biome } from '../src/world/biomes';
import {
  parseManifest, stemTuningPolicy, stemWorldFlavor, preferredVariation, StemSelector, createStemContext, RACE_STEM_SET, SPECIAL_SETS,
} from '../src/audio/stemRouting';

const seed = Number(process.argv[2] ?? 1234);
const failures: string[] = [];
const check = (cond: unknown, msg: string) => {
  if (!cond) failures.push(msg);
};

// ---- world generation determinism
{
  const a = new WorldGenerator(seed), b = new WorldGenerator(seed);
  const ca = a.fillChunk(64, 0, -32, 0), cb = b.fillChunk(64, 0, -32, 0);
  let same = ca.uniform === cb.uniform;
  for (let i = 0; i < ca.density.length && same; i++) if (ca.density[i] !== cb.density[i]) same = false;
  check(same, 'chunk generation is not deterministic');
  const m = ca.uniform ? null : meshChunk(ca, 0);
  check(ca.uniform || (m && m.vertexCount % 3 === 0), 'mesher produced invalid vertex count');
  const other = new WorldGenerator(seed + 1);
  check(other.profile.name !== a.profile.name || other.profile.foliageHue !== a.profile.foliageHue, 'different seeds produce identical profiles');
}

// ---- tab-targeting rules (client side, pure)
{
  const order = rankTargets([
    { id: 1, disposition: 'neutral', engaged: false, angle: 0.01, dist: 5 },
    { id: 2, disposition: 'hostile', engaged: false, angle: 0.5, dist: 20 },
    { id: 3, disposition: 'friendly', engaged: false, angle: 0, dist: 3 },
    { id: 4, disposition: 'hostile', engaged: false, angle: 0.1, dist: 10 },
  ]);
  check(order.join() === '4,2,1,3', `target ranking should be hostile (by aim) → neutral → friendly, got ${order.join()}`);
  check(stepCycle(order, null, 1) === 4 && stepCycle(order, null, -1) === 4, 'first Tab / Shift+Tab should pick the best target');
  check(stepCycle(order, 4, 1) === 2 && stepCycle(order, 3, 1) === 4 && stepCycle(order, 4, -1) === 3, 'Tab / Shift+Tab should walk the order and wrap');
  check(mergeCycle([2, 4, 1], [4, 5, 2]).join() === '2,4,5', 'cycle order should stay stable and append newcomers');
  check(stepCycle([], 1, 1) === null, 'no candidates → no target');
}

// ---- adaptive score routing (pure: manifest contract, tuning policy, context → set hysteresis)
{
  const mf = parseManifest({
    version: 1, sampleRate: 48000,
    sets: {
      meadow: { tonic: 'D', mode: 'dorian', tonicHz: 146.83, scaleCents: [0, 200, 300, 500, 700, 900, 1000], safeCents: [0, 200, 300, 500, 700, 1000], bpm: 76, beatsPerBar: 4, bars: 12, loopSeconds: 37.89, layers: { drone: ['meadow/drone_0.ogg'], perc: ['meadow/perc_0.ogg'] } },
      combat: { tonicHz: 146.83, scaleCents: [0, 200], bpm: 132, beatsPerBar: 4, bars: 20, loopSeconds: 36.36, layers: { drone: ['combat/drone_0.ogg'] } },
      night: { tonicHz: 138.59, scaleCents: [0], bpm: 60, beatsPerBar: 4, bars: 8, loopSeconds: 32, layers: { drone: ['night/drone_0.ogg'] } },
      broken: { tonicHz: 'x', layers: { drone: ['a.ogg'] } },
      nodrone: { tonicHz: 100, scaleCents: [0], bpm: 60, beatsPerBar: 4, bars: 8, loopSeconds: 32, layers: { melody: ['m.ogg'] } },
      escape: { tonicHz: 100, scaleCents: [0], bpm: 60, beatsPerBar: 4, bars: 8, loopSeconds: 32, layers: { drone: ['../../secret.ogg'] } },
    },
  });
  check(mf && Object.keys(mf.sets).sort().join() === 'combat,meadow,night', `manifest validation kept the wrong sets: ${mf && Object.keys(mf.sets)}`);
  check(mf?.sets.meadow.layers.texture.length === 0 && mf?.sets.meadow.safeCents.length === 6 && mf?.sets.combat.safeCents.length === 2, 'manifest layers/safeCents defaults');
  check(parseManifest(null) === null && parseManifest('<!doctype html>') === null && parseManifest({ version: 2, sets: {} }) === null, 'malformed manifests must be rejected');
  // Every set id the routing can produce must exist in the asset pipeline's set list.
  try {
    const real = parseManifest(JSON.parse(readFileSync('public/assets/audio/music/manifest.json', 'utf8')));
    if (real) {
      const ids = new Set(Object.keys(real.sets));
      const fl = stemWorldFlavor({ seed, weirdness: 0 });
      const routed = new Set([...fl.biomeSet, ...Object.values(RACE_STEM_SET), ...Object.values(SPECIAL_SETS)]);
      const missing = [...routed].filter((id) => !ids.has(id));
      check(!missing.length, `stem routing targets missing from the manifest: ${missing.join(', ')}`);
    }
  } catch {
    /* no assets in this checkout: the game runs generative-only */
  }
  check(stemTuningPolicy({ scale: [0, 200, 300, 500, 700, 900, 1000], octave: 1200 }) === 'full', '12-TET mode should allow pitched stems');
  check(stemTuningPolicy({ scale: [0, 200, 400], octave: 1215 }) === 'perc', 'stretched octave must be perc-only');
  check(stemTuningPolicy({ scale: [0, 1902 / 13 * 2], octave: 1902 }) === 'perc', 'Bohlen-Pierce must be perc-only');
  check(stemTuningPolicy({ scale: [0, 1200 / 19 * 3, 1200 / 19 * 7], octave: 1200 }) === 'perc', 'n-EDO must be perc-only');
  const fa = stemWorldFlavor({ seed, weirdness: 0.9 }), fb = stemWorldFlavor({ seed, weirdness: 0.9 }), fc = stemWorldFlavor({ seed: seed + 7, weirdness: 0.9 });
  check(fa.rate === fb.rate && fa.biomeSet.join() === fb.biomeSet.join(), 'stem world flavour must be deterministic');
  check(fa.rate !== fc.rate && Math.abs(fa.semitones) <= 1 && Math.abs(fa.semitones) >= 0.35, 'stem rate shift should differ per seed and stay within ±1 semitone');
  check(preferredVariation(fa, 'meadow', 'melody', 3) === preferredVariation(fb, 'meadow', 'melody', 3), 'preferred variation must be deterministic');
  // Selector: biome dwell/hysteresis, combat fast in / held out, night.
  const has = (id: string) => ['meadow', 'woodland', 'combat', 'night', 'hearth', 'cave'].includes(id);
  const sel = new StemSelector(stemWorldFlavor({ seed, weirdness: 0 }));
  const c = createStemContext();
  const run = (sec: number) => {
    for (let t = 0; t < sec; t += 0.1) sel.update(0.1, c, has);
    return sel.current;
  };
  c.biome = Biome.Grassland;
  check(run(1) === 'meadow', 'grassland should play meadow');
  c.biome = Biome.TemperateForest;
  check(run(3) === 'meadow', 'a biome change must not switch the set before the dwell/stability time');
  c.biome = Biome.Grassland;
  run(0.5);
  c.biome = Biome.TemperateForest;
  check(run(25) === 'woodland', 'a stable biome change should switch the set');
  c.combat = 0.6;
  check(run(0.1) === 'combat', 'combat should switch immediately');
  c.combat = 0.1;
  check(run(2) === 'combat', 'combat exit should be held');
  check(run(5) === 'woodland', 'combat should end after the hold');
  c.siteRace = 'dwarf';
  c.settlement = 0.6;
  check(run(5) === 'woodland', 'missing settlement set should fall back to the biome set');
  c.siteRace = 'halfling';
  check(run(5) === 'hearth', 'halfling settlement should play hearth');
  c.settlement = 0;
  c.siteRace = null;
  c.day = 0.1;
  check(run(6) === 'night', 'night should play the night set');
  c.day = 0.4;
  check(run(6) === 'night', 'night exit needs hysteresis');
  c.underworld = 1;
  c.biome = Biome.MagmaDepths;
  check(run(5) === 'cave', 'missing underdread should fall back to cave');
}

// ---- server session
const server = new GameServer(seed);
const inbox: ServerMessage[] = [];
const send = server.connect((m) => inbox.push(m));
const msg = (m: ClientMessage) => send(m);
msg({ t: 'hello', version: PROTOCOL_VERSION, name: 'Tester', appearance: randomAppearance('human', 7) });
const welcome = inbox.find((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }> | undefined;
check(welcome, 'no welcome message');
if (welcome) {
  const pos = [...welcome.spawn] as [number, number, number];
  let seq = 0;
  const t0 = performance.now();
  for (let i = 0; i < 20 * 60; i++) {
    // Walk in a slow circle for one simulated minute.
    if (i % 2 === 0) {
      pos[0] += Math.cos(i / 200) * 0.25;
      pos[2] += Math.sin(i / 200) * 0.25;
      const g = server.gen.findGround(pos[0], pos[1] + 4, pos[2], 20);
      if (!Number.isNaN(g)) pos[1] = g;
      msg({ t: 'move', seq: ++seq, pos: [...pos], vel: [0, 0, 0], yaw: 0, move: 'walk', grounded: true });
    }
    if (i === 100) msg({ t: 'attack', dir: [0, 0, -1] });
    // A stale / bogus tab-target lock must be ignored (crosshair aim), never crash the server.
    if (i === 150) msg({ t: 'attack', dir: [0, 0, -1], target: 987654, lock: true });
    if (i === 160) msg({ t: 'ability', use: { ability: 'power_strike', dir: [0, 0, -1], target: 987654, lock: true } });
    if (i === 200) msg({ t: 'dig', point: [pos[0], pos[1] - 0.2, pos[2] - 1], normal: [0, 1, 0], tool: 'pick_iron' });
    if (i === 300) msg({ t: 'gmAsk', text: 'Where am I?' });
    if (i === 400) msg({ t: 'save' });
    server.tick();
  }
  const ms = performance.now() - t0;
  const snaps = inbox.filter((m) => m.t === 'snapshot').length;
  check(snaps > 100, `too few snapshots (${snaps})`);
  check(inbox.some((m) => m.t === 'saved'), 'save produced no data');
  const kinds = new Map<string, number>();
  for (const m of inbox) kinds.set(m.t, (kinds.get(m.t) ?? 0) + 1);
  console.log(`world ${server.gen.profile.name} (seed ${seed}) — simulated 60 s in ${ms.toFixed(0)} ms (${(ms / 1200).toFixed(2)} ms/tick)`);
  console.log('messages:', Object.fromEntries(kinds));
  console.log('entities:', server.entities.all.size, 'kinds:', Object.fromEntries([...server.entities.all.values()].reduce((m, e) => m.set(e.kind, (m.get(e.kind) ?? 0) + 1), new Map<string, number>())));
  check(ms / 1200 < 10, 'server tick too slow');
  const saved = inbox.find((m) => m.t === 'saved') as Extract<ServerMessage, { t: 'saved' }> | undefined;
  if (saved) {
    const s2 = new GameServer(seed);
    try {
      s2.load(JSON.parse(saved.data));
    } catch (e) {
      failures.push('save failed to load: ' + (e as Error).message);
    }
  }
}

if (failures.length) {
  console.error('FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('selftest OK');
