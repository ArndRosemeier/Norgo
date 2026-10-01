# Norgo

A seed-driven, streamed, destructible fantasy open world for the browser, written in
TypeScript on three.js.

* **Not a height map.** Voxel density terrain meshed with surface nets: overhangs, natural
  arches, karst towers, crystal spires, floating islands, spaghetti caves, caverns, shafts
  and a continent-wide **underworld** with its own biomes and a lightless sea.
* **Vast & streamed.** Octree LOD from 1 m voxels near you to 2 km chunks at the horizon,
  generated and meshed in worker threads, ~7 km view distance.
* **Every seed is a different world.** A world "genome" (`WorldProfile`) decides palettes
  (foliage can be teal, crimson, gold...), sky, moons, rings, aurora, which of 16 surface
  biomes exist and how they're shaped, gravity, flora & fauna genomes, races and cultures.
* **Variable gravity.** Light Skyreach regions, gravity anomalies, gravity magic.
* **Destructible & deformable.** Trees fall, rocks and buildings shatter into debris, the
  ground can be dug, cratered and raised a little (realistically).
* **Living world.** Procedural creatures with ecology, NPCs with needs, schedules, goals and
  memories, settlements of ten fantasy races with distinct and mixed architecture.
* **Humanoids** are built on the CC0 MakeHuman base mesh, morph targets and skeleton,
  with everything on top (races, skin, hair, gear, animation) procedural.
* **Use-based skills** with thresholds unlocking physical, magical (ten schools) and
  utility abilities. Wearable items with stats, affixes and visuals.
* **Virtual Game Master** that observes, paces, narrates, creates quests and answers you.
* **Server-authoritative architecture.** The game server runs in a Web Worker behind a
  message protocol, ready to be moved to a real multiplayer server.

## Running

```bash
npm install
npm run dev          # http://localhost:5173
```

URL options: `?quick=<seed>` skip the menu, `&fresh` ignore saves, `&race=elf`,
`?viewer&seed=<seed>` free-fly terrain viewer, `&bgtick` keep simulating in hidden tabs.

Other scripts: `npm run typecheck`, `npm test` (headless server/worldgen self test),
`npm run assets` (rebuild the human assets from MakeHuman data), `npm run build`.

## Controls

| | |
| --- | --- |
| WASD / Space / Shift / C / Alt | move, jump, sprint, crouch/sneak, walk |
| Mouse / wheel | look, zoom (wheel all the way in → first person) |
| LMB / RMB | attack or use tool (dig with a pick, chop with an axe) / block |
| E | interact (talk, pick up, gather, open) |
| 1–0 | hotbar abilities & items |
| Tab / Shift+Tab | next / previous target (foes first; attacks & spells aim at it; Esc clears; rebindable) |
| I / K / J / M / G | inventory, skills, journal, map, ask the Game Master |
| Esc / F3 | menu / debug overlay |

## Development aids

* Sandboxes per system: `/sandbox/{flora,creatures,humanoid,items,gameplay,settlements,ui,audio}.html`.
* Headless tools (`npx tsx tools/<name>.ts`): `selftest`, `gen-bench`, `chunkjob-sweep`,
  `npc-sim`, `npc-scenarios`, `gm-sim`, `gm-lore`, `gameplay-selftest`, `items-check`,
  `items-server-test`, `creatures-sim`, `creatures-fight`, `flora-servertest`, `settlements-check`.
* In-game (dev console, `window.norgo` is the running game): send server debug commands with
  `norgo.send({t:'debug', cmd, args})`, e.g. `tp [x,y,z]` (y = NaN → ground), `time [0..1]`,
  `weather ['storm', 0.9]`, `give ['axe_great', 1]`, `xp ['pyromancy', 5000]`, `heal`,
  `spawn [species]`, `home`. Errors and warnings are collected in `window.norgoErrors`.
* Adaptive score (stems): `norgo.audio.stems.status()`, `norgo.audio.stems.force('combat')` /
  `.force(null)`, `norgo.audio.stems.loadManifest()`, `norgo.audio.setMusicStyle('generative')`;
  `norgo.audio.music.debug()` shows the generative score. F3 shows a `music` and a `stems` line.
  `spawn [species, true]` spawns a boss (boss music). The audio sandbox has a stem section
  (force set, style, settlement race). Stems are built offline by `tools/music/build_stems.py`.
* Optional LLM brains for NPC dialog and the Game Master: Settings → AI (OpenAI-compatible,
  Anthropic or Ollama endpoints). Scripted brains are the default and the fallback.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, contracts and
conventions.

## Credits

Human base mesh, targets, skeleton and weights: [MakeHuman](http://www.makehumancommunity.org)
assets, released under CC0 1.0. Everything else is procedural.
