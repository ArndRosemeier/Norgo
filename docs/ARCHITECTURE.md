# Norgo — Architecture

Norgo is a TypeScript/three.js web app: a vast, seed-driven, streamed, destructible
open world with a client/server split (the server is a local mock running in a Web
Worker, built so a real multiplayer server can replace it later).

## Golden rules

1. **Seed-driven determinism.** Everything procedural derives from the world seed via
   `src/core/rng.ts` (`deriveSeed`, `Rng`, `hash*`) and `src/core/noise.ts`. Never use
   `Math.random()` for world content (only for cosmetic, non-replicated jitter on the
   client). Two clients with the same seed must generate identical worlds, species,
   settlements, NPCs and loot tables. A *different* seed must look wildly different —
   pull per-world parameters from `WorldProfile` (`src/world/profile.ts`).
2. **Server authority.** Clients send *intents* (`ClientMessage` in
   `src/shared/protocol.ts`); the server (`src/server/GameServer.ts`) owns state and
   replicates via snapshots/events. The only client-authoritative thing is local player
   movement (validated by the server).
3. **Message boundary.** Server code must never import three.js or DOM APIs. Client
   code must never import server internals (`src/**/server/**`). Shared logic lives in
   domain folders outside `server/` and `client/` subfolders.
4. **Performance.** Allocation-free hot loops, typed arrays, instancing, workers for
   heavy generation. Target 60 fps on a mid-range desktop GPU.

## Coordinates & units

Meters, Y up, right-handed (three.js). Yaw 0 faces −Z; yaw rotates counter-clockwise
looking down (three.js `rotation.y`). Terrain density `> 0` = solid.

## Directory map & ownership

| Path | Contents |
| --- | --- |
| `src/core/` | rng, noise, math, events, platform (device & capabilities), budgets (device resource limits) (lead) |
| `src/world/` | profile, biomes, materials, generator (density), sites/roads/POIs, mesher, chunk workers, streamer (octree LOD), collider, edits, terrain material/textures (lead) |
| `src/render/` | RenderCore, Environment (sun, moons, sky, fog, weather visuals), water, sky occlusion (lead) |
| `src/shared/` | protocol + shared types (lead) |
| `src/server/` | GameServer, ServerContext/services contracts, entity store, PlayerSystem, WorldSystem, worker entry (lead) |
| `src/net/` | transports (lead) |
| `src/client/` | Game loop, input, camera, player controller, net client, interpolation, entity view manager, static colliders, debris physics, focus/interaction (lead) |
| `src/flora/` | vegetation, rocks, small props: worker scatter, client rendering, server ObjectSystem (destructible objects) |
| `src/creatures/` | species generator, procedural meshes & locomotion, ecology spawning, behaviour AI |
| `src/humanoid/` | MakeHuman-based body pipeline, races, appearance generation, skin/eyes/hair, procedural animation, equipment fitting |
| `src/items/` | item database, materials, affixes, loot, crafting, inventory ops, item meshes, wearables, icons |
| `src/gameplay/` | skills, abilities, magic schools, effects, stats, combat, projectiles, FX |
| `src/npc/`, `src/dialog/` | NPC agendas/needs/schedules/memory, dialog system (+ LLM-ready brain interface) |
| `src/gm/` | virtual game master, pacing, events, quests, journal |
| `src/settlements/` | settlement layouts, architecture styles, buildings, props, POI structures, destructible pieces |
| `src/ui/` | menus, character creator, HUD, inventory, skills, dialog, journal, map, trade, settings |
| `src/audio/` | procedural WebAudio sound and ambience, generative score + adaptive stem layer |
| `tools/` | Node scripts (asset conversion, benchmarks) |
| `public/assets/` | generated binary assets (human base mesh etc.) |
| `sandbox/` | per-domain dev pages (`/sandbox/<domain>.html`) |

## Runtime overview

```
main.ts → menu (UI) → Game (src/client/Game.ts)
  ├─ WorkerTransport ──postMessage──► server.worker.ts → GameServer (20 Hz)
  │                                     systems: world, players, gameplay, items, objects,
  │                                     settlements, npcs, creatures, dialog, gm
  ├─ RenderCore (WebGL2, reversed-Z, HDR + bloom + SMAA)
  ├─ Environment (SunLight w/ CSM, hemisphere, fog, sky, water)
  ├─ TerrainStreamer (octree LOD, chunk workers, edits, collider grids, scatter events)
  ├─ Client modules: flora, settlements, creatures/humanoid/item views, fx, audio, ui
  └─ Player controller (client-predicted), camera, input, interaction focus
```

### Terrain
* `WorldGenerator.density(x,y,z)` combines a 2D column (`Column`) with 3D features:
  overhangs, arches, karst pillars, crystal spires, floating islands, spaghetti caves,
  caverns, shafts, and the underworld layer (`UNDERWORLD_CEIL..FLOOR`) with its own
  biomes. `fillChunk` produces 36³ grids per chunk; `meshChunk` runs surface nets.
* Chunks are streamed by `TerrainStreamer`: `ChunkEntry.group` is the parent object
  for everything belonging to that chunk (attach flora there so it LODs with terrain).
* `streamer.events`: `chunkScatter` (first generation; deterministic `ScatterBatch[]`
  from `src/flora/scatter.ts` which runs **inside the chunk worker**), `chunkDisposed`.
* Deformation: `TerrainEdit` (sphere dig/fill, radius ≤ 3 m). Server applies via
  `ctx.editTerrain`, replicates to clients, streamer regenerates affected chunks.
* Collision: `TerrainCollider` (`density`, `raycast`, `sphereContact`, `groundBelow`).
* Sky occlusion: all lit materials must call `patchSkyOcclusion(material, mode)` from
  `src/render/skyOcclusion.ts` so caves are dark (sun + sky light scaled by visibility;
  point lights unaffected). Dynamic objects: `'uniform'` mode and set the value from
  `estimateSkyVis(y, gen.heightAt(x,z))` (views get `setSkyVis(v)` called by the core).

### Gravity
`WorldGenerator.gravityAt(x,y,z)` returns local gravity magnitude (always −Y). Skyreach
(floating island) regions are light, anomalies can be heavy. Effects can modify it
(`gravity_low`, `gravity_high`, `levitate`, `featherfall`) and the server can broadcast
temporary gravity fields (`GameEvent` type `gravity`). Creatures, NPCs, projectiles and
debris must use it.

### Server systems
Implement `ServerSystem` (`src/server/context.ts`) and the domain's service interface.
Cross-system calls only through `ctx.services.*`; reactions through `ctx.bus` events.
Keep per-entity private state in your own `Map<EntityId, ...>`. Persist via
`save()/load()` (JSON-safe). The server is single-threaded at 20 Hz: budget ≤ 2 ms per
system per tick at typical load; do expensive work in `slowTick` or amortize.

Systems & where they live (class names are fixed — `GameServer.ts` imports them):

| Service | Class | File |
| --- | --- | --- |
| combat + skills | `GameplaySystem` | `src/gameplay/server/GameplaySystem.ts` |
| items | `ItemSystem` | `src/items/server/ItemSystem.ts` |
| objects | `ObjectSystem` | `src/flora/server/ObjectSystem.ts` |
| settlements | `SettlementSystem` | `src/settlements/server/SettlementSystem.ts` |
| npcs | `NpcSystem` | `src/npc/server/NpcSystem.ts` |
| creatures | `CreatureSystem` | `src/creatures/server/CreatureSystem.ts` |
| dialog | `DialogSystem` | `src/dialog/server/DialogSystem.ts` |
| gm | `GameMaster` | `src/gm/server/GameMaster.ts` |

Message routing: `GameServer.connect` passes every `ClientMessage` to systems in order
(`world, players, gameplay, items, objects, settlements, npcs, creatures, dialog, gm`);
the first that returns `true` consumes it. Ownership of message types:

* players: `move`, `respawn`, `hotbar`, `debug`, `chat`
* gameplay: `ability`, `abilityRelease`, `attack`, `block`, `dig`
* items: `equip`, `unequip`, `useItem`, `dropItem`, `pickup`, `trade`, `craft`, `place`
* objects: `harvest`
* npcs/dialog: `talk`, `dialogChoice`, `dialogText`, `dialogEnd`
* gm: `gmAsk`, `questAction`
* `interact` is generic: each system checks whether the target is theirs (item entity →
  items pickup, npc → dialog, object → objects/settlements (doors), etc.).

Player state replication: call `ctx.markPlayerDirty(id, key...)` with keys `vitals`,
`stats`, `skills`, `inventory`, `equipment`, `effects`, `cooldowns`, `journal`,
`reputation`, `gravity`, `appearance`. Data the PlayerSystem doesn't own
(`cooldowns`, `journal`, `reputation`, `gravityMul`) lives in
`PlayerSystem.playerData(id)` (access via `(ctx as GameServer).playerSys` is **not**
allowed — use the `players` system through the documented accessor
`getPlayerData(ctx, id)` in `src/server/systems/playerData.ts`).

Snapshots: entities within 170 m are sent at 10 Hz (`snapshotOf`). Set `e.dirty`
liberally; keep entity counts sane (despawn far creatures, simulate distant NPCs
abstractly).

### Client modules
Implement `ClientModule` and/or `EntityViewFactory` (`src/client/context.ts`).
Fixed classes the Game imports:

| Class | File | Role |
| --- | --- | --- |
| `FloraSystem` | `src/flora/client/FloraSystem.ts` | vegetation/rocks/props + colliders + destruction visuals |
| `SettlementRenderer` | `src/settlements/client/SettlementRenderer.ts` | buildings/props near camera + colliders |
| `HumanoidViews` | `src/humanoid/client/HumanoidViews.ts` | views for `player`/`npc` |
| `CreatureViews` | `src/creatures/client/CreatureViews.ts` | views for `creature` |
| `ItemViews` | `src/items/client/ItemViews.ts` | views for `item` (+ `buildItemObject`) |
| `FxSystem` | `src/gameplay/client/FxSystem.ts` | particles, projectiles/effects views, impact fx |
| `AudioSystem` | `src/audio/AudioSystem.ts` | implements `AudioAPI` |
| `UI` | `src/ui/UI.ts` | all DOM UI; plus `showMainMenu()` in `src/ui/menu.ts` |

The Game calls `view.update(interpolatedSnap, dt, time)` every frame, `onEvent` for
events targeting the entity, `setSkyVis` when the sky visibility changes. Views are
added to `ctx.scene` by the core (do not add them yourself).

World objects (trees, rocks, building pieces, doors, chests) register a
`StaticCollider` in `ctx.colliders` with `objectId` (server id) + `interact` prompt; the
core uses them for player collision, raycasts and the interaction focus. Destroyed
objects arrive as `ObjectState` via `ctx.events.on('objects', ...)`.

### Tab targeting
`src/client/targeting.ts` (`TargetSystem`, rules in `targetRules.ts`) keeps the local player's
selected target. Selection is client-side only; `attack` messages and `AbilityUse` carry the id
with `lock: true`, and the server (`MeleeSim.lockedTarget`) re-validates it (alive, ≤ 52 m, terrain
line of sight) before aiming swings, shots (led + drop-compensated) and aimed abilities at it.
Invalid locks silently fall back to the crosshair aim. The HUD listens to `ClientEvents.target`;
`targetRequest` lets the UI clear it (Esc).

### Commands & input (keyboard, mouse, touch)
`src/client/commands.ts` is the single list of player commands (id, label, glyph, group, kind,
default keys, rebind field, touch method). Everything derives from it: `Input`'s key map, the
UI's panel/guide/pause keys (`UI.runCommand`), Settings → Controls (table + rebind rows), the
pause menu, welcome guide, HUD key hints (via `src/ui/controls.ts`), the touch controls and the
README controls table (`tools/commands-check.ts --write`; `npm test` fails when it is stale).
`Input` (`src/client/input.ts`) is source-agnostic: keys, mouse and the on-screen controls
(`ctx.controls: VirtualControls` — stick axes, button holds, look, zoom) feed the same actions;
movement axes are analog. `src/core/platform.ts` decides the live input mode; touch controls
(`src/ui/hud/touch.ts`) show only in touch mode. Mouse/touch interaction rules for widgets
(long-press = right-click, double-tap = double-click, tooltips on hold, drag vs. hold,
on-screen keyboard) live in `src/ui/gestures.ts` — use `onSecondary` / `onDouble` /
`tooltip.bind` instead of raw `contextmenu` / `dblclick` / hover listeners.

### Player controller (lead) understands
* `PlayerState.stats.moveSpeed` (multiplier), `stats.jump` (multiplier),
  `gravityMul`, and effect ids `haste, slow, root, stun, featherfall, levitate,
  waterwalk, gravity_low, gravity_high, climb_boost, swim_boost, leap_boost, glide,
  phase`.
* Server `GameEvent` `knockback` (impulse) and `correct` (teleport) messages.
* Swimming below `SEA_LEVEL` / `UNDERWORLD_SEA_LEVEL`, climbing steep terrain
  (costs stamina), crouch/sneak, sprint, jump, falling with fall damage on the server.

### Animation ids (ActionAnim.id) — shared vocabulary
Humanoids: `swing_1h`, `swing_2h`, `stab`, `slam`, `punch`, `kick`, `block`, `shoot_bow`,
`throw`, `cast_forward`, `cast_up`, `cast_ground`, `cast_self`, `channel`, `dig`,
`chop`, `mine`, `harvest`, `pickup`, `eat`, `drink`, `gesture_wave`, `gesture_point`,
`gesture_shrug`, `bow`, `talk`, `work_hammer`, `work_saw`, `pray`, `sit`, `sleep`,
`dance`, `cheer`, `flinch`, `stagger`, `die`. Creatures: `bite`, `claw`, `charge`,
`roar`, `pounce`, `sting`, `spit`, `graze`, `drink`, `sleep`, `flinch`, `die`.

### Adaptive score (stems + generative)
The score has two layers. `MusicDirector` (`src/audio/music.ts`) is the generative,
seed-derived score: it plays episodes with silences between them. `StemMusic`
(`src/audio/stems.ts`) mixes pre-generated loops live on top of it. Settings → Audio →
Music style switches between "Adaptive score" (the default) and "Generative only".
* **Assets pipeline.** `tools/music/` (its own uv env, Stable Audio; `sets.py` defines the sets,
  `build_stems.py` generates them, checks key/tempo, cuts seamless loops and writes Ogg Opus) →
  `public/assets/audio/music/<set>/<layer>_<i>.ogg` + `manifest.json`. The game never generates stems.
* **Manifest contract.** `{version:1, sampleRate, sets:{id:{tonic, mode, tonicHz, scaleCents,
  safeCents, bpm, beatsPerBar, bars, loopSeconds, layers:{drone|texture|melody|perc: [path…]}}}}`.
  Every file in a set is exactly `loopSeconds` long and loops seamlessly. `texture` and `perc`
  sit on the beat grid starting at t=0, while `drone` and `melody` are free-time in the set's key.
  `drone` always exists. A layer can have any number of variations (≥ 1) or be missing.
  Validation is in `parseManifest`, which drops bad sets. A missing or malformed manifest
  leaves the game generative-only.
* **Routing.** `src/audio/stemRouting.ts` is the single place for routing: the biome → set
  table, the settlement race → set table, cave/underworld/night/combat/boss sets and the
  fallbacks for missing sets. Its `StemSelector` adds hysteresis and dwell times: a biome
  change needs 20 s on the current set plus 6 s of stability, night needs 4 s, places need
  2.5 s, combat starts immediately and needs 3.5 s of calm before it ends. Each world
  (`stemWorldFlavor`) picks preferred variations and a ±0.35–1 semitone playback-rate shift
  that applies to every stem, so tempo shifts with it and sync holds. Weird worlds remap some
  biomes to other exploration sets.
* **Mixing.** All layers of a set start on one context time (`AudioBufferSourceNode`, whole-buffer
  loop). Layers that load late join phase-aligned. Gains only move with `setTargetAtTime`.
  The drone is the bed. The texture enters after a couple of bars and occasionally rests for
  a loop. The melody plays in phrases: it is on for 1–2 loops, then off for 45–100 s, and
  picks a random variation each time. Perc depends on context: in exploration it plays the
  occasional loop plus more while running or sprinting, in settlements it is mostly on, and
  in combat or boss fights it is full. Night, storm, indoors and underwater shape the gains
  and a bus lowpass. Exploration stems follow the director's episodes, while combat and boss
  always play. Exploration crossfades take about 5–7 s. Combat enters on the next beat of
  the current set in about 1.2 s and leaves with a 6 s fade. The player preloads combat and
  the likely next set (dusk → night, cave mouth, settlement edge). Residency follows the
  device budget (`budgets.stemSets/stemBytes/stemMelodies/stemLoads`): desktops keep 3 sets
  (≈ 60–90 MB decoded each) under 240 MB, tablets 2 sets under ≈ 130 MB with one melody
  variation and one decode at a time, evicted LRU.
* **Codec gate.** Stems are Ogg Opus. `src/audio/codecProbe.ts` decides once per session (cached
  per user agent): Chromium/Firefox are trusted; on WebKit (all iOS/iPadOS browsers, Safari) or
  when `canPlayType` says no, one real stem is decoded with an `OfflineAudioContext` (no gesture
  needed) as soon as the manifest is in. If that fails the stem layer stays silent for the
  session — no fetches, no retries, no manifest re-polls — the generative score plays alone, and
  the verdict shows in F3 (`stems unavailable: …`), `stems.status().codec` and `?diag`.
* **Tuning policy.** `stemTuningPolicy(theme.tuning)`. A world is 12-TET-compatible when its
  octave is exactly 1200 cents and every degree is a whole semitone. Those worlds get all
  layers ('full'), and the director steps back: its drone, pad, arpeggio, bass, choir and
  percussion are muted. Only sparse lead and bells remain, at the set's `accent` level, retuned
  to `tonicHz × rate` and `safeCents`. The chord stays on the tonic, and the lead rests while
  the stem melody plays. Every other tuning gets 'perc' only: n-EDO, harmonic/just,
  Bohlen-Pierce, slendro, pelog and stretched octaves (≈ 40 % of seeds, mostly mildly
  stretched octaves). Pitched stems would clash there, so only the unpitched perc layer plays,
  and only in combat, boss fights and settlements. The full generative score stays on, with
  its percussion yielding to the stems. In both modes the director's beat clock locks to the
  stem grid while a beat-locked set plays.
* **Boss flag.** Bosses carry `EntFlag.Boss` in snapshots (set at spawn by `CreatureSystem`). The
  client plays the boss set while a boss within 60 m is fighting the player.

## Conventions
* TS strict, ES2022 modules, no default exports, file-top doc comment, comment *why*.
* Domain `types.ts` files are contracts others depend on: extend compatibly (add optional
  fields), never remove/rename without the lead.
* Assets: no external downloads at runtime; everything procedural except the CC0
  MakeHuman base data converted by `tools/build-human-assets.ts` into `public/assets/human/`.
* Dev pages: `sandbox/<domain>.html` + `src/sandbox/<domain>.ts`, served by Vite at
  `http://localhost:5173/sandbox/<domain>.html`.
* Typecheck: `npx tsc --noEmit`. Benchmarks/tests in Node: `npx tsx tools/<script>.ts`.

## Rendering performance rules
Shader compiles are the main source of hitches (0.2–1.5 s each on Windows/ANGLE), so:
* **Shader gate** (`RenderCore.shaders`, `src/render/renderCore.ts`): anything that joins the scene,
  or is visible with a material whose program (incl. its shadow-depth variant) isn't compiled yet,
  is parked on a hidden layer and compiled in parallel; it appears a few frames later instead of
  freezing the frame. Nothing to do in modules. Flag `userData.noShaderGate` for objects that must
  never wait (the local player). The gate is enabled after the loading-screen warm-up compile.
* **Materials are disposed lazily**: `Material.dispose()` goes through a bounded graveyard so
  programs of despawned entities survive. Still dispose materials normally.
* **Constant light count**: light count is part of the program key. Pool lights and set
  intensity 0 instead of toggling `visible` or adding/removing lights.
* Prefer shared materials (or few variants) over per-object materials with distinct defines.
* `?prof` logs slow frames with their section breakdown and the programs compiled in them;
  `norgo.prof.report()` in the console.

### Capabilities & fallbacks
`RenderCore` decides its setup from `platform.probeGL()` (a throwaway context, because the
renderer's constructor options can't change later) and records the live context with
`platform.attachGL()`. Test every fallback on a desktop with `?caps=…` (see `src/core/platform.ts`);
`?diag` shows what a device really does.
* **Depth.** With EXT_clip_control: reversed-Z. Reversed-Z only helps with a *float* depth buffer,
  so where the scene target would get D24 (D3D/ANGLE on Windows) RenderCore gives three's internal
  HDR scene target a 32F `DepthTexture` before its first use (error at 5 km: centimetres instead of
  ~10 m). Apple GPUs need nothing — Metal has no 24-bit depth there, ANGLE allocates Depth32Float.
  Without clip control: the standard depth range with the same 0.15 m / 16 km planes — the
  precision the D24 desktop path always had (≈ 0.4 m at 1 km, ≈ 10 m at 5 km; distant terrain is
  one surface per LOD, so no visible fighting). Rejected: logarithmic depth (writes gl_FragDepth →
  no early-Z and no hidden-surface removal on tile-based GPUs like the iPad's — a big fill-rate
  cost under foliage) and a larger near plane (third-person camera clips into walls).
  `core.depthMode` / `core.depthInfo()` report it.
* **Colour.** HDR half-float output buffer (tone mapping in three's final pass, bloom + SMAA via
  `setEffects`) when an RGBA16F framebuffer is really complete; otherwise an 8-bit path: tone
  mapping in the materials, no post effects (`core.hdr`, `core.effectsAvailable`). Data textures
  that need linear filtering use half floats when OES_texture_float_linear is missing (water).
* **Shader gate without KHR_parallel_shader_compile.** Compiles block wherever the driver first
  needs them, so the gate *paces*: parked objects queue and `pump()` compiles them before the frame
  (at least one object per frame, more while under 6 ms), forcing the link there. Total compile
  time is the driver's; the gate never adds a stall nor bunches programs into one frame.
* **Context loss** (iOS reclaims GPU memory of background tabs): rendering pauses until the browser
  restores the context; three re-uploads buffers/textures from CPU copies, the gate forgets its
  compiled state, and GPU-only content is redrawn via `core.onContextRestored(fn)` (flora impostor
  atlas). Keep CPU copies of geometry and data textures (don't free arrays after upload).

## Platform, budgets & app shell
* **`src/core/platform.ts`** — the only place that sniffs the device: form factor (iPadOS reports a
  Mac UA; touch points decide), WebKit, touch/pointer and the live input mode, cores, memory, GPU
  caps, audio formats, `notes` (engine decisions for diagnostics) and `report()`. Don't probe
  features or user agents anywhere else.
* **`src/core/budgets.ts`** — device class (`desktop`, `desktop-low`, `tablet`, `phone`) → one
  table of limits: chunk/body worker counts, streamer chunk cache, collider grids, stem residency,
  pattern textures, blueprint/POI/settlement caches, server object-chunk cache, pixel-ratio cap,
  weather particle density. Read the value at use time. Workers can't see the device: the server
  worker gets the class in its init message (`applyDeviceClass`). Tablet numbers are small on
  purpose: iPadOS kills a Safari tab (workers included) far below the device's RAM.
* **Graphics settings → engine** go through `applyGraphicsSettings` (`src/client/graphics.ts`), used
  by the Game and the `?diag` benchmark. Presets live in `src/ui/settings.ts`; first run (no saved
  settings) and "Restore defaults" use `deviceGraphicsDefaults()`: *Tablet* (render scale 0.75 of
  the 1.5-capped DPR, 1.1 km, low shadows, 60 % ground cover, 60 fps cap) on tablets, *Low* on
  phones, *Medium* on modest desktops, *High* otherwise. `vegetation` thins id-less ground cover
  when chunks are scattered; `weatherFx` × the budget scales weather particles.
* **`src/client/appShell.ts`** — app behaviour: one background/foreground signal
  (visibilitychange, pagehide/pageshow, freeze/resume), Screen Wake Lock while playing outside
  menus (secure contexts only), fullscreen on the first tap of a touch-first device (standard or
  webkit-prefixed; otherwise a one-time "Add to Home Screen" hint on iOS), and the rotate-to-
  landscape overlay. On background the Game saves (≤ every 30 s) and opens the pause menu.
* **Shell files**: `index.html` (viewport-fit=cover, no page zoom, Apple web-app metas),
  `public/manifest.webmanifest`, `public/icons/` (generated by `tools/make-icons.ts`), and
  `src/ui/styles/platform.css` (no overscroll/pinch/callouts on the game surface, inputs stay
  selectable, `--safe-top/right/bottom/left` for the HUD).
* **Audio unlock**: `AudioEngine.installUnlock` keeps gesture listeners (touchend, click,
  pointerup, keydown…) for the whole session and resumes inside the handler — iOS needs that
  after interruptions ('interrupted' state) as well as at first start.
