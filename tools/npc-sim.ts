/**
 * Headless NPC simulation: boots a GameServer in Node, joins a player next to
 * a settlement, prints the generated population (families, jobs, schedules,
 * personalities, bios), simulates a few in-game hours of agenda decisions
 * (activities, goals, gossip, barks), runs a scripted conversation through the
 * dialog system and verifies save/load.
 *
 *   npx tsx tools/npc-sim.ts [seed] [hours] [--quiet] [--town] [--fast] [--llm]
 *
 * --llm starts a local mock OpenAI-compatible endpoint and routes free-text
 * dialog through the LLM brain (configured via the `/llm {json}` channel).
 */
import { GameServer } from '../src/server/GameServer';
import type { ServerMessage } from '../src/shared/protocol';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { randomAppearance } from '../src/humanoid/appearance';
import type { NpcSystem } from '../src/npc/server/NpcSystem';
import type { DialogView } from '../src/dialog/types';
import { traitWords, JOB_NOUN } from '../src/npc/culture';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const quiet = process.argv.includes('--quiet');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seed = Number(args[0] ?? 1337);
const hours = Number(args[1] ?? 8);

const server = new GameServer(seed);
// --fast: compressed days (1 in-game hour = 10 s). Walking then lags behind schedules, so prefer real time.
if (process.argv.includes('--fast')) server.worldSys.dayLength = 240;
const npcs = server.services.npcs as unknown as NpcSystem;

const dialogs: DialogView[] = [];
const send = (m: ServerMessage) => {
  if (m.t === 'dialog') dialogs.push(m.view);
};
const handle = server.connect(send);
handle({ t: 'hello', version: PROTOCOL_VERSION, name: 'Tester', appearance: randomAppearance('human', 7) });
const player = server.players()[0];
// --town picks the largest settlement within 4 km instead of the spawn hamlet.
const wantTown = process.argv.includes('--town');
const order = { hamlet: 0, village: 1, town: 2, city: 3 };
const site = wantTown
  ? server.gen.sites.sitesNear(player.pos[0], player.pos[2], 4000).sort((a, b) => order[b.size] - order[a.size])[0]
  : server.gen.siteAt(player.pos[0], player.pos[2]) ?? server.gen.sites.sitesNear(player.pos[0], player.pos[2], 600)[0];
if (!site) throw new Error('no settlement near spawn');
// Stand in the plaza.
handle({ t: 'debug', cmd: 'tp', args: [site.x + 6, NaN, site.z + 6] });
console.log(`World ${server.gen.profile.name} (seed ${seed}) — ${site.name}, a ${site.race}${site.race2 ? '/' + site.race2 : ''} ${site.size} at (${site.x.toFixed(0)}, ${site.z.toFixed(0)})`);

const t0 = performance.now();
for (let i = 0; i < 40; i++) server.tick();
console.log(`activation: ${(performance.now() - t0).toFixed(0)} ms, live NPCs: ${npcs.liveCount()}`);

const dbg = npcs.debugSite(site.id)!;
console.log(`layout: ${dbg.synthetic ? 'synthetic fallback' : 'settlement module'}; population ${dbg.people.length}\n`);
for (const { rec, st } of dbg.people) {
  const rels = Object.entries(rec.relations).slice(0, 4).map(([id, r]) => `${r.kind}:${dbg.people.find((p) => p.rec.id === id)?.rec.given ?? id}`).join(', ');
  console.log(`• ${rec.name} — ${rec.age}y ${rec.race}${rec.race2 ? '/' + rec.race2 : ''} ${JOB_NOUN[rec.job]}${rec.captain ? ' (captain)' : ''}${rec.leader ? ' (leader)' : ''} — "${rec.title}" — ${traitWords(rec.traits).join(', ')} — coins ${st.coins}`);
  if (!quiet) {
    console.log(`    rel: ${rels || '—'} | factions: ${rec.factions.join(', ')}`);
    console.log(`    day: ${rec.schedule.map(([h, a]) => `${h.toFixed(1)} ${a}`).join(' → ')}`);
    console.log(`    bio: ${rec.bio}`);
  }
}

// ------------------------------------------------------------ simulate
console.log(`\n=== simulating ${hours} in-game hours ===`);
const seenSpeech = new Map<number, string>();
const goalSeen = new Map<string, string>();
let tickMs = 0, ticks = 0, maxTick = 0;
const ticksPerHour = Math.round(server.worldSys.dayLength / 24 * 20);
for (let h = 0; h < hours; h++) {
  const barks: string[] = [];
  for (let i = 0; i < ticksPerHour; i++) {
    const a = performance.now();
    server.tick();
    const d = performance.now() - a;
    tickMs += d;
    maxTick = Math.max(maxTick, d);
    ticks++;
    for (const e of server.entities.all.values()) {
      if (e.kind !== 'npc' || !e.speech) continue;
      if (seenSpeech.get(e.id) !== e.speech.text) {
        seenSpeech.set(e.id, e.speech.text);
        barks.push(`${e.name}: “${e.speech.text}”`);
      }
    }
    // Stroll the player around the plaza so barks & look-at trigger.
    if (i % 100 === 0) {
      const a2 = (h * 24 + i / 100) * 0.7;
      handle({ t: 'move', seq: ticks, pos: [site.x + Math.cos(a2) * 12, player.pos[1], site.z + Math.sin(a2) * 12], vel: [0, 0, 0], yaw: 0, move: 'walk', grounded: true });
    }
  }
  const d2 = npcs.debugSite(site.id)!;
  const acts = new Map<string, number>();
  for (const p of d2.people) acts.set(p.act, (acts.get(p.act) ?? 0) + 1);
  console.log(`\n[day ${server.time.day + 1} ${server.time.hour.toFixed(1)}h, ${server.weather.kind}] ${[...acts].map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  for (const p of d2.people) {
    const g = p.st.goals[p.st.goals.length - 1];
    if (!g) continue;
    const key = `${g.id}:${g.status}:${g.step}`;
    if (goalSeen.get(p.rec.id) === key) continue;
    goalSeen.set(p.rec.id, key);
    console.log(`  ⚑ ${p.rec.given} (${p.rec.job}) goal "${g.desc}" — ${g.status}, plan [${g.plan.join(' → ')}] step ${g.step + 1}${g.help ? ' (wants help)' : ''}`);
  }
  for (const b of barks.slice(0, quiet ? 3 : 8)) console.log('  💬 ' + b);
  const mems = d2.people.reduce((s, p) => s + p.st.mem.length, 0);
  console.log(`  memories in town: ${mems}`);
}
console.log(`\nperf: ${ticks} ticks, avg ${(tickMs / ticks).toFixed(2)} ms/tick (whole server), max ${maxTick.toFixed(1)} ms, entities ${server.entities.all.size}`);

// ------------------------------------------------------------ dialog
console.log('\n=== dialog ===');
const npcEnt = [...server.entities.all.values()].filter((e) => e.kind === 'npc' && e.alive).sort((a, b) => Math.hypot(a.pos[0] - player.pos[0], a.pos[2] - player.pos[2]) - Math.hypot(b.pos[0] - player.pos[0], b.pos[2] - player.pos[2]))[0];
if (npcEnt) {
  handle({ t: 'debug', cmd: 'tp', args: [npcEnt.pos[0] + 1.5, npcEnt.pos[1], npcEnt.pos[2]] });
  for (let i = 0; i < 3; i++) server.tick();
  const show = (v: DialogView | undefined) => {
    if (!v) return;
    for (const l of v.lines) console.log(`  ${l.speaker || '(story)'}${l.mood ? ` [${l.mood}]` : ''}: ${l.text}`);
    if (!v.ended) console.log(`    choices: ${v.choices.map((c) => `${c.id}${c.check ? `(${Math.round(c.check.chance * 100)}%)` : ''}`).join(', ')}`);
    console.log(`    — ${v.npcTitle}; disposition ${v.disposition}${v.ended ? ' (ended)' : ''}`);
  };
  handle({ t: 'interact', target: npcEnt.id });
  show(dialogs[dialogs.length - 1]);
  for (const choice of ['about', 'mood', 'rumors', 'place', 'people', 'person:0', 'directions', 'dir:0', 'agenda', 'qaccept', 'persuade', 'compliment']) {
    const v = dialogs[dialogs.length - 1];
    if (!v || v.ended) break;
    if (!v.choices.some((c) => c.id === choice)) continue;
    console.log(`> ${choice}`);
    handle({ t: 'dialogChoice', session: v.sessionId, choice });
    show(dialogs[dialogs.length - 1]);
  }
  for (const text of ['Where is the tavern?', 'Have you heard any gossip?', 'you are an idiot']) {
    const v = dialogs[dialogs.length - 1];
    if (!v || v.ended) break;
    console.log(`> "${text}"`);
    handle({ t: 'dialogText', session: v.sessionId, text });
    show(dialogs[dialogs.length - 1]);
  }
  if (process.argv.includes('--llm')) {
    // Mock OpenAI-compatible endpoint: echoes a structured in-character reply and logs the prompt size.
    let lastPrompt = '';
    const http = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body) as { messages: { role: string; content: string }[] };
        lastPrompt = j.messages[0].content;
        const user = j.messages[j.messages.length - 1].content;
        const reply = { lines: [{ text: `You ask "${user}"? Hmph. Ask me again after supper.`, mood: 'focused' }], suggestions: ['What is for supper?', 'Sorry to bother you.'], actions: [{ type: 'disposition', delta: 2, reason: 'was curious' }, { type: 'gesture', anim: 'gesture_shrug' }] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      });
    });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    let v = dialogs[dialogs.length - 1];
    if (v?.ended) {
      handle({ t: 'interact', target: npcEnt.id });
      v = dialogs[dialogs.length - 1];
    }
    if (v && !v.ended) {
      handle({ t: 'dialogText', session: v.sessionId, text: `/llm ${JSON.stringify({ endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'mock', provider: 'openai' })}` });
      console.log('> (LLM) "What do you think of the weather?"');
      handle({ t: 'dialogText', session: v.sessionId, text: 'What do you think of the weather?' });
      show(dialogs[dialogs.length - 1]);
      for (let i = 0; i < 50 && dialogs[dialogs.length - 1].thinking; i++) await new Promise((r) => setTimeout(r, 20));
      show(dialogs[dialogs.length - 1]);
      console.log(`    (system prompt: ${lastPrompt.length} chars; first line: ${lastPrompt.split('\n')[0].slice(0, 90)}...)`);
    }
    http.close();
  }
  const v = dialogs[dialogs.length - 1];
  if (v && !v.ended) {
    handle({ t: 'dialogEnd', session: v.sessionId });
    show(dialogs[dialogs.length - 1]);
  }
}

// ------------------------------------------------------------ persistence
const saved = server.save();
const json = JSON.stringify(saved);
const s2 = new GameServer(seed);
s2.load(JSON.parse(json));
const n2 = s2.services.npcs as unknown as NpcSystem;
const d3 = n2.debugSite(site.id)!;
const d4 = npcs.debugSite(site.id)!;
const sameMinds = d3.people.every((p, i) => p.st.mem.length === d4.people[i].st.mem.length && p.st.goals.length === d4.people[i].st.goals.length && p.rec.name === d4.people[i].rec.name);
console.log(`\nsave: ${(json.length / 1024).toFixed(1)} KiB; reload regenerates identical people & minds: ${sameMinds ? 'yes' : 'NO'}`);
