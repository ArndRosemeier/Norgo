/**
 * Quest forge: the game master's own quest writer. Builds QuestSpecs grounded
 * in the lore and the actual world around the player:
 *
 *   POIs        ruin → explore & recover the relic (guardians optional)
 *               lair → slay the named beast        camp → scatter the bandits
 *               shrine/wayshrine/monolith/obelisk → riddles & pilgrimages
 *               tower → a mage's request (notes → deliver to a settlement)
 *               battlefield → lay the dead to rest (night vigil)
 *               crashsite → investigate the fallen thing   well → the legend
 *               grove → listen at dusk
 *   settlements their current trouble becomes a request
 *   world events the fallen star of a meteor shower
 *   personal arcs a three-stage story chosen by the player's playstyle
 *
 * Every objective is completable with the services available: spawn plans
 * degrade into searches, linger zones and riddles are run by the GM itself.
 */
import type { ServerEntity } from '../../server/entity';
import type { QuestObjectiveSpec, QuestSpec } from '../types';
import type { PoiInfo, SiteInfo } from '../../world/sites';
import type { Vec3 } from '../../shared/types';
import type { Rng } from '../../core/rng';
import { poiLore, siteLore, powerOf, personName, raceAdjective, monsterName, type PoiLore } from '../lore';
import { bearing, cap, compass } from '../text';
import type { GmHost, ObjectiveRuntime, ArcState } from './state';
import type { CreateOpts } from './QuestBook';
import { powerLevel, type Playstyle } from './PlayerModel';
import { poiById, shaftsNear } from './Scout';
import { skillDef } from '../../gameplay/data/catalog';

export interface ForgedQuest {
  spec: QuestSpec;
  opts: CreateOpts;
}

type Aux = ObjectiveRuntime['aux'];

type SkillCat = 'combat' | 'magic' | 'utility' | 'craft' | 'social' | 'survival';

/**
 * The skill XP should go to: the player's most practised skill in the quest's
 * flavour category (combat quests train combat skills, pilgrimages survival...),
 * falling back to their best skill overall. Uses the shared gameplay catalog.
 */
function bestSkill(p: ServerEntity, cats: SkillCat[] = []): string | undefined {
  let best: string | undefined, lvl = -1;
  let bestCat: string | undefined, lvlCat = -1;
  for (const [id, s] of Object.entries(p.skills?.skills ?? {})) {
    if (s.level > lvl) {
      lvl = s.level;
      best = id;
    }
    const cat = skillDef(id)?.category;
    if (cat && cats.includes(cat) && s.level > lvlCat) {
      lvlCat = s.level;
      bestCat = id;
    }
  }
  return bestCat ?? best;
}

function coinsFor(p: ServerEntity, base: number, r: Rng): number {
  return Math.round((base + powerLevel(p) * base * 0.35) * r.range(0.85, 1.2) / 5) * 5;
}

function xpFor(p: ServerEntity, amount: number, ...cats: SkillCat[]): Record<string, number> | undefined {
  const s = bestSkill(p, cats);
  return s ? { [s]: Math.round(amount * (1 + powerLevel(p) * 0.15)) } : undefined;
}

/** The nearest settlement to a point (for reputation & deliveries). */
function nearestSite(host: GmHost, x: number, z: number, range = 1600): SiteInfo | null {
  let best: SiteInfo | null = null;
  let bd = Infinity;
  for (const s of host.ctx.gen.sites.sitesNear(x, z, range)) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best && bd <= range ? best : null;
}

function predatorFor(host: GmHost, poi: { x: number; z: number; biome: number }, boss: boolean, r: Rng): number | undefined {
  const cs = host.ctx.services.creatures;
  const uw = false;
  let list = boss ? cs.speciesFor(poi.biome, 'boss', uw) : [];
  if (!list.length) list = cs.speciesFor(poi.biome, 'predator', uw);
  return list.length ? r.pick(list) : undefined;
}

function poiPos(poi: PoiInfo): Vec3 {
  return [poi.x, poi.y, poi.z];
}

// ------------------------------------------------------------------ POI quests

export function poiQuest(host: GmHost, p: ServerEntity, poi: PoiInfo, r: Rng): ForgedQuest | null {
  const profile = host.ctx.gen.profile;
  const pl: PoiLore = poiLore(profile, poi);
  const site = nearestSite(host, poi.x, poi.z);
  const rep: Record<string, number> = {};
  const sitePower = site ? powerOf(profile, site.race) : undefined;
  if (sitePower) rep[sitePower.id] = 5;
  const pos = poiPos(poi);
  const origin = poi.id;
  const lvl = powerLevel(p);
  const name = cap(pl.name);
  const giver = site ? `the folk of ${site.name}` : undefined;
  const base = (spec: Omit<QuestSpec, 'source'>, opts: CreateOpts = {}): ForgedQuest => ({ spec: { source: 'poi', ...spec }, opts: { origin, sequential: true, ...opts } });

  switch (poi.kind) {
    case 'ruin': {
      const guardians = predatorFor(host, poi, false, r);
      const objectives: QuestObjectiveSpec[] = [
        { kind: 'discover', text: `Reach ${pl.name}`, poi: poi.id },
        { kind: 'custom', text: `Search the ruins for ${pl.relic}`, event: `search:${poi.id}`, count: 1 },
        { kind: 'kill', text: 'Drive off what guards the ruins (optional)', count: Math.min(3, 1 + Math.floor(lvl / 5)), pos },
      ];
      const aux: Aux[] = [undefined, { linger: { pos, radius: poi.radius * 0.7, secs: 10, acc: 0, hint: 'You begin to sift through rubble and fallen stones...' } }, guardians !== undefined ? { spawn: { kind: 'creature', species: guardians, count: objectives[2].kind === 'kill' ? objectives[2].count : 1, pos, ids: [], seed: poi.seed } } : undefined];
      if (guardians === undefined) objectives.pop();
      return base({
        title: cap(pl.relic ?? `the relic of ${pl.name}`), giver, summary: `${pl.legend} ${pl.hook}`, objectives,
        rewards: { coins: coinsFor(p, 40, r), xp: xpFor(p, 120, 'survival', 'utility'), reputation: rep, text: pl.relic ? `the legend of ${pl.relic}` : undefined }, meta: { lootTable: 'chest.ruin', poi: poi.id },
      }, { aux, optional: guardians !== undefined ? [2] : [] });
    }
    case 'lair': {
      const species = predatorFor(host, poi, true, r);
      const beast = pl.ownerName ?? 'the beast';
      return base({
        title: `Slay ${beast}`, giver, summary: `${pl.legend} ${pl.hook}`,
        objectives: [{ kind: 'goto', text: `Find the lair ${bearing({ x: p.pos[0], z: p.pos[2] }, poi)}`, pos, radius: 45 }, { kind: 'kill', text: `Slay ${beast}`, count: 1, pos }],
        rewards: { coins: coinsFor(p, 80, r), xp: xpFor(p, 220, 'combat'), reputation: rep }, meta: { lootTable: 'creature.boss', poi: poi.id },
      }, { aux: [undefined, { spawn: { kind: 'creature', species, count: 1, pos, boss: true, name: beast, title: 'Terror of the wilds', ids: [], seed: poi.seed } }] });
    }
    case 'camp': {
      const gang = pl.ownerName ?? 'the bandits';
      const n = Math.min(5, 2 + Math.floor(lvl / 4));
      return base({
        title: `Break ${gang.split(' of ')[1] ?? 'the Camp'}`, giver, summary: `${pl.legend} ${pl.hook}`,
        objectives: [{ kind: 'goto', text: 'Find the bandit camp', pos, radius: 50 }, { kind: 'kill', text: 'Defeat the bandits', count: n, pos }],
        rewards: { coins: coinsFor(p, 60, r), xp: xpFor(p, 160, 'combat'), reputation: { ...rep, ...(site ? { [`site.${site.id}`]: 10 } : {}) } }, meta: { lootTable: 'npc.bandit', poi: poi.id },
      }, { aux: [undefined, { spawn: { kind: 'wanderer', wanderer: 'bandit', count: n, pos, ids: [], seed: poi.seed, name: gang.split(' of ')[0] } }] });
    }
    case 'shrine':
    case 'monolith':
    case 'obelisk': {
      const rd = pl.riddle;
      if (!rd) return null;
      const deity = pl.deity?.name;
      return base({
        title: poi.kind === 'shrine' ? `The Riddle of ${deity ?? 'the Shrine'}` : `The Words on ${name.replace(/^The /, 'the ')}`,
        summary: `${pl.legend} Carved into the stone: “${rd[0]}” Speak your answer to the Game Master while standing before it.`,
        objectives: [{ kind: 'discover', text: `Stand before ${pl.name}`, poi: poi.id }, { kind: 'custom', text: 'Answer the riddle (ask the Game Master)', event: `riddle:${poi.id}`, count: 1 }],
        rewards: { coins: coinsFor(p, 25, r), xp: xpFor(p, 140, 'magic', 'social'), text: poi.kind === 'shrine' ? `${deity}'s blessing` : 'a glimpse of the old world' }, meta: { poi: poi.id },
      }, { aux: [undefined, { riddle: { answers: rd[1], pos, question: rd[0] } }] });
    }
    case 'wayshrine': {
      // Pilgrimage: this wayshrine, then up to two more along the old ways.
      const others = host.ctx.gen.sites.poisNear(poi.x, poi.z, 1400).filter((q) => q.id !== poi.id && (q.kind === 'wayshrine' || q.kind === 'shrine'));
      others.sort((a, b) => Math.hypot(a.x - poi.x, a.z - poi.z) - Math.hypot(b.x - poi.x, b.z - poi.z));
      const stops = others.slice(0, 2);
      const objectives: QuestObjectiveSpec[] = [{ kind: 'custom', text: `Pray at ${pl.name}`, event: `pray:${poi.id}`, count: 1 }];
      const aux: Aux[] = [{ linger: { pos, radius: 12, secs: 6, acc: 0, hint: 'You kneel and murmur the pilgrim\'s prayer...' } }];
      for (const s of stops) {
        const sl = poiLore(host.ctx.gen.profile, s);
        objectives.push({ kind: 'custom', text: `Pray at ${sl.name}, ${compass(s.x - poi.x, s.z - poi.z)} of the first`, event: `pray:${s.id}`, count: 1 });
        aux.push({ linger: { pos: poiPos(s), radius: 12, secs: 6, acc: 0, hint: 'You kneel and murmur the pilgrim\'s prayer...' } });
      }
      return base({
        title: `The Pilgrim's Road of ${pl.deity?.name ?? 'the Old Ways'}`, summary: `${pl.legend} ${pl.hook}`, objectives,
        rewards: { coins: coinsFor(p, 20 * objectives.length, r), xp: xpFor(p, 80 * objectives.length, 'survival'), text: `the protection of ${pl.deity?.name ?? 'the road'}` },
      }, { aux });
    }
    case 'tower': {
      const deliverTo = site;
      const objectives: QuestObjectiveSpec[] = [
        { kind: 'discover', text: `Reach ${pl.name}`, poi: poi.id },
        { kind: 'custom', text: `Search the tower for the notes of ${pl.ownerName ?? 'its master'}`, event: `search:${poi.id}`, count: 1 },
      ];
      const aux: Aux[] = [undefined, { linger: { pos, radius: poi.radius, secs: 8, acc: 0, hint: 'Dust, broken glass, a smell of old ozone... you search the shelves.' } }];
      if (deliverTo) {
        objectives.push({ kind: 'goto', text: `Bring the notes to a scholar in ${deliverTo.name}`, pos: [deliverTo.x, deliverTo.plateau, deliverTo.z], radius: deliverTo.radius * 0.7 });
        aux.push(undefined);
      }
      return base({
        title: `The Notes of ${pl.ownerName?.split(' ')[0] ?? 'the Tower'}`, giver: deliverTo ? `a scholar of ${deliverTo.name}` : undefined, summary: `${pl.legend} ${pl.hook}`, objectives,
        rewards: { coins: coinsFor(p, 45, r), xp: xpFor(p, 180, 'magic'), reputation: rep }, meta: { lootTable: 'chest.tower', poi: poi.id },
      }, { aux });
    }
    case 'battlefield': {
      const restless = predatorFor(host, poi, false, r);
      const objectives: QuestObjectiveSpec[] = [
        { kind: 'discover', text: `Walk ${pl.name}`, poi: poi.id },
        { kind: 'custom', text: 'Keep a vigil for the fallen through the night', event: `vigil:${poi.id}`, count: 1 },
      ];
      const aux: Aux[] = [undefined, { linger: { pos, radius: poi.radius, secs: 25, night: true, acc: 0, hint: 'You stand among the old graves and speak the words of rest...' } }];
      if (restless !== undefined) {
        objectives.push({ kind: 'kill', text: 'Put the restless to rest (optional)', count: 2, pos });
        aux.push({ spawn: { kind: 'creature', species: restless, count: 2, pos, ids: [], seed: poi.seed + 7 } });
      }
      return base({
        title: `Rest for the Fallen of ${name.split(' at ')[1] ?? name}`, summary: `${pl.legend} ${pl.hook}`, objectives,
        rewards: { coins: coinsFor(p, 30, r), xp: xpFor(p, 150, 'magic', 'survival'), reputation: rep, text: 'the gratitude of the dead' },
      }, { aux, optional: restless !== undefined ? [2] : [] });
    }
    case 'crashsite':
      return fallenThingQuest(host, p, pos, pl.name, `${pl.legend} ${pl.hook}`, poi.id, r);
    case 'well':
      return base({
        title: `The Legend of ${name.replace(/^The /, 'the ')}`, summary: `${pl.legend} ${pl.hook}`,
        objectives: [{ kind: 'discover', text: `Find ${pl.name}`, poi: poi.id }, { kind: 'custom', text: 'Drop a coin and make a wish', event: `wish:${poi.id}`, count: 1 }],
        rewards: { coins: coinsFor(p, 35, r), xp: xpFor(p, 90, 'utility', 'social'), text: 'whatever the well decides you are owed' }, meta: { lootTable: 'chest.ruin', poi: poi.id },
      }, { aux: [undefined, { linger: { pos, radius: 8, secs: 4, acc: 0, hint: 'The coin falls a long, long way before you hear the splash...' } }] });
    case 'grove':
      return base({
        title: `What ${name.replace(/^The /, 'the ')} Remembers`, summary: `${pl.legend} ${pl.hook}`,
        objectives: [{ kind: 'discover', text: `Find ${pl.name}`, poi: poi.id }, { kind: 'custom', text: 'Sit beneath the eldest tree after dusk and listen', event: `listen:${poi.id}`, count: 1 }],
        rewards: { xp: xpFor(p, 160, 'survival', 'magic'), coins: coinsFor(p, 15, r), text: 'a secret of the land' },
      }, { aux: [undefined, { linger: { pos, radius: poi.radius, secs: 15, night: true, acc: 0, hint: 'You sit very still. The leaves begin to whisper...' } }] });
  }
}

/** Investigate something that fell from the sky (crash sites & meteor showers). */
export function fallenThingQuest(host: GmHost, p: ServerEntity, pos: Vec3, name: string, summary: string, origin: string, r: Rng): ForgedQuest {
  const site = nearestSite(host, pos[0], pos[2]);
  const objectives: QuestObjectiveSpec[] = [
    { kind: 'goto', text: `Reach ${name}`, pos, radius: 30 },
    { kind: 'custom', text: 'Investigate the impact', event: `search:${origin}`, count: 1 },
  ];
  const aux: Aux[] = [undefined, { linger: { pos, radius: 18, secs: 8, acc: 0, hint: 'The ground is still warm. Strange metal glints in the furrow...' } }];
  if (site) {
    objectives.push({ kind: 'goto', text: `Show your findings to the smiths of ${site.name}`, pos: [site.x, site.plateau, site.z], radius: site.radius * 0.7 });
    aux.push(undefined);
  }
  return {
    spec: {
      source: 'gm', title: `The ${cap(name.replace(/^the /i, ''))}`, summary, objectives, giver: site ? `the smiths of ${site.name}` : undefined,
      rewards: { coins: coinsFor(p, 50, r), xp: xpFor(p, 150, 'craft', 'utility'), reputation: site ? { [powerOf(host.ctx.gen.profile, site.race)?.id ?? `site.${site.id}`]: 4 } : undefined },
      meta: { lootTable: 'chest.ruin' }, category: 'event',
    },
    opts: { origin, sequential: true, aux, offerTtl: 900 },
  };
}

// ------------------------------------------------------------------ settlement requests

export function siteRequest(host: GmHost, p: ServerEntity, site: SiteInfo, r: Rng): ForgedQuest | null {
  const profile = host.ctx.gen.profile;
  const sl = siteLore(profile, site);
  const power = powerOf(profile, site.race);
  const rep = { [power?.id ?? `site.${site.id}`]: 6, [`site.${site.id}`]: 8 };
  const giver = `${sl.rulerTitle} ${sl.ruler}`;
  const center: Vec3 = [site.x, site.plateau, site.z];
  const t = sl.trouble;
  const origin = `req:${site.id}`;
  const cats: SkillCat[] = /wolves|livestock|dragon|bandits/.test(t) ? ['combat'] : /sickness|harvest/.test(t) ? ['survival', 'craft'] : /haunted|missing|tremors|lights/.test(t) ? ['survival', 'utility'] : ['social'];
  const mk = (title: string, objectives: QuestObjectiveSpec[], aux: Aux[], extra: Partial<QuestSpec> = {}): ForgedQuest => ({
    spec: { source: 'settlement', title, giver, summary: `${giver} of ${site.name} asks for help with ${t}.`, objectives, rewards: { coins: coinsFor(p, 45, r), xp: xpFor(p, 130, ...cats), reputation: rep }, ...extra },
    opts: { origin, sequential: true, aux },
  });
  const outskirts = (): Vec3 => {
    const a = r.range(0, Math.PI * 2);
    const d = site.radius * 1.6 + 40;
    const x = site.x + Math.cos(a) * d, z = site.z + Math.sin(a) * d;
    return [x, host.ctx.gen.heightAt(x, z), z];
  };
  if (/wolves|livestock|dragon/.test(t)) {
    const pos = outskirts();
    const sp = host.ctx.services.creatures.speciesFor(host.ctx.gen.biomeAt(pos[0], pos[2]), 'predator', false);
    return mk(`Night Raiders of ${site.name}`, [{ kind: 'goto', text: 'Follow the tracks out of town', pos, radius: 30 }, { kind: 'kill', text: 'Kill the raiders', count: 2, pos }], [undefined, { spawn: { kind: 'creature', species: sp.length ? r.pick(sp) : undefined, count: 2, pos, ids: [], seed: site.seed } }]);
  }
  if (/bandits/.test(t)) {
    const pos = outskirts();
    return mk(`Safe Roads for ${site.name}`, [{ kind: 'goto', text: 'Patrol the road out of town', pos, radius: 30 }, { kind: 'kill', text: 'Deal with the highwaymen', count: 3, pos }], [undefined, { spawn: { kind: 'wanderer', wanderer: 'bandit', count: 3, pos, ids: [], seed: site.seed } }]);
  }
  if (/sickness|harvest/.test(t)) {
    const groves = host.ctx.gen.sites.poisNear(site.x, site.z, 1200).filter((q) => q.kind === 'grove' || q.kind === 'shrine' || q.kind === 'wayshrine');
    const objectives: QuestObjectiveSpec[] = [{ kind: 'harvest', text: 'Gather herbs and plants for a remedy', objectKind: '*', count: 5 }];
    const aux: Aux[] = [undefined];
    if (groves.length) {
      const gr = groves[0];
      const gl = poiLore(profile, gr);
      objectives.push({ kind: 'custom', text: `Ask for a blessing at ${gl.name}`, event: `bless:${gr.id}`, count: 1 });
      aux.push({ linger: { pos: poiPos(gr), radius: 14, secs: 6, acc: 0, hint: 'You lay the herbs down and ask for a blessing...' } });
    }
    objectives.push({ kind: 'goto', text: `Return to ${site.name}`, pos: center, radius: site.radius * 0.6 });
    aux.push(undefined);
    return mk(`A Remedy for ${site.name}`, objectives, aux);
  }
  if (/haunted|missing/.test(t)) {
    const pois = host.ctx.gen.sites.poisNear(site.x, site.z, 900).filter((q) => q.kind === 'ruin' || q.kind === 'battlefield' || q.kind === 'well');
    const target: Vec3 = pois.length ? poiPos(pois[0]) : outskirts();
    const placeName = pois.length ? poiLore(profile, pois[0]).name : 'the old mill';
    return mk(t.includes('missing') ? `The Lost Children of ${site.name}` : `The Haunting of ${site.name}`, [
      { kind: 'goto', text: `Go to ${placeName}`, pos: target, radius: 35 },
      { kind: 'custom', text: t.includes('missing') ? 'Search for the children after dark' : 'Watch for the haunting after dark', event: `search:${origin}`, count: 1 },
      { kind: 'goto', text: `Report back to ${site.name}`, pos: center, radius: site.radius * 0.6 },
    ], [undefined, { linger: { pos: target, radius: 25, secs: 12, night: true, acc: 0, hint: 'You wait in the dark, listening...' } }, undefined]);
  }
  if (/tremors|strange lights/.test(t)) {
    const sh = shaftsNear(host.ctx.gen, site.x, site.z, 2400)[0];
    const pos: Vec3 = sh ? [sh.x, sh.y, sh.z] : outskirts();
    return mk(`Lights Below ${site.name}`, [
      { kind: 'goto', text: sh ? 'Find the great shaft and look down' : 'Find where the lights come from', pos, radius: (sh?.radius ?? 10) + 25 },
      { kind: 'custom', text: 'Watch the depths for a while', event: `search:${origin}`, count: 1 },
      { kind: 'goto', text: `Tell ${site.name} what you saw`, pos: center, radius: site.radius * 0.6 },
    ], [undefined, { linger: { pos, radius: (sh?.radius ?? 10) + 30, secs: 10, acc: 0, hint: 'Far below, something glimmers and moves...' } }, undefined]);
  }
  // Feuds, taxes, debts: talk it through with the townsfolk.
  return mk(`Bad Blood in ${site.name}`, [
    { kind: 'custom', text: `Hear out the people of ${site.name} (talk to 3 townsfolk)`, event: `talk:${site.id}`, count: 3 },
    { kind: 'goto', text: `Bring your judgement to the ${sl.rulerTitle.toLowerCase()}`, pos: center, radius: site.radius * 0.4 },
  ], [undefined, undefined]);
}

// ------------------------------------------------------------------ personal arcs

/** Arc themes by playstyle. Each arc has three stages. */
const ARC_BY_STYLE: Record<Playstyle, string> = {
  explorer: 'navigator', fighter: 'beastlord', socializer: 'crown', crafter: 'forge', mage: 'astrolabe', sneak: 'ledger',
};

const ARC_CATS: Record<string, SkillCat[]> = {
  navigator: ['survival', 'utility'], beastlord: ['combat'], crown: ['social'], forge: ['craft'], astrolabe: ['magic'], ledger: ['utility', 'social'],
};

export function startArc(host: GmHost, p: ServerEntity, style: Playstyle, r: Rng): ArcState {
  const lore = host.lore;
  const id = ARC_BY_STYLE[style];
  const fig = lore.figures.find((f) => (id === 'navigator' && f.role === 'wanderer') || (id === 'astrolabe' && f.role === 'sage') || (id === 'beastlord' && f.role === 'hero') || (id === 'crown' && f.role === 'tyrant') || (id === 'forge' && f.role === 'builder') || (id === 'ledger' && f.role === 'traitor')) ?? r.pick(lore.figures);
  const race = host.ctx.gen.profile.races.length ? r.pick(host.ctx.gen.profile.races).id : 'human';
  return {
    id, style, stage: 0, done: false,
    data: { figure: `${fig.name} ${fig.epithet}`, figureShort: fig.name, relic: fig.relic, villain: personName(race, r.fork('villain'), true), beast: monsterName(r.fork('beast'), 'beasts'), race: raceAdjective(race) },
  };
}

/** Build the quest for the arc's current stage (anchored to real places near the player). */
export function arcQuest(host: GmHost, p: ServerEntity, arc: ArcState, r: Rng): ForgedQuest | null {
  const gen = host.ctx.gen;
  const d = arc.data;
  const here = { x: p.pos[0], z: p.pos[2] };
  const pois = gen.sites.poisNear(p.pos[0], p.pos[2], 1500).sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
  const far = pois.filter((q) => Math.hypot(q.x - here.x, q.z - here.z) > 250);
  const pick = (kinds: string[]) => far.find((q) => kinds.includes(q.kind)) ?? far[0] ?? pois[0];
  const stage = arc.stage;
  const title = (t: string) => `${t} (${['I', 'II', 'III'][stage] ?? stage + 1})`;
  const opts = (aux: Aux[], optional: number[] = []): CreateOpts => ({ origin: `arc:${arc.id}:${stage}`, sequential: true, arc: { id: arc.id, stage }, aux, optional });
  const spec = (t: string, summary: string, objectives: QuestObjectiveSpec[], rewardBase: number, extra: Partial<QuestSpec> = {}): QuestSpec => ({
    source: 'gm', title: title(t), summary, objectives, category: 'arc', rewards: { coins: coinsFor(p, rewardBase, r), xp: xpFor(p, rewardBase * 3, ...ARC_CATS[arc.id]) }, meta: { lootTable: stage === 2 ? 'chest.boss' : 'chest.ruin' }, ...extra,
  });
  const target = pick(['ruin', 'tower', 'obelisk', 'monolith', 'battlefield']);
  if (!target) return null;
  const tl = poiLore(gen.profile, target);
  const tpos = poiPos(target);
  const search = (text: string, secs = 10, night = false): [QuestObjectiveSpec, Aux] => [
    { kind: 'custom', text, event: `search:arc:${arc.id}:${stage}`, count: 1 },
    { linger: { pos: tpos, radius: Math.max(14, target.radius * 0.7), secs, night, acc: 0, hint: 'You search carefully...' } },
  ];

  if (stage === 0) {
    const [o2, a2] = search(`Search ${tl.name} for a sign of ${d.figureShort}`);
    const opening: Record<string, string> = {
      navigator: `A torn map comes into your hands, signed by ${d.figure}. Its marks point to ${tl.name}, ${bearing(here, target)}.`,
      beastlord: `Hunters speak of a beast-lord that gathers the predators of the land — and of ${d.figure}, who once fought its kind. Their trail begins at ${tl.name}.`,
      crown: `A sealed letter reaches you: someone named ${d.villain} is buying loyalties across the land, in the name of ${d.figure}'s old crown. The trail starts at ${tl.name}.`,
      forge: `A smith shows you a shard of impossible metal: part of ${d.relic}, forged by ${d.figure}. More may lie at ${tl.name}.`,
      astrolabe: `The stars shift strangely tonight. ${d.figure} once read the world's end in them, and their notes were hidden at ${tl.name}.`,
      ledger: `A dying courier presses a ledger page into your hand: debts, names, and ${d.villain}'s seal. The page mentions ${tl.name}.`,
    };
    return { spec: spec(arcName(arc), opening[arc.id], [{ kind: 'discover', text: `Find ${tl.name}`, poi: target.id }, o2], 40), opts: opts([undefined, a2]) };
  }
  if (stage === 1) {
    const sp = host.ctx.services.creatures.speciesFor(target.biome, 'predator', false);
    const objs: QuestObjectiveSpec[] = [{ kind: 'goto', text: `Travel to ${tl.name}, ${bearing(here, target)}`, pos: tpos, radius: 40 }];
    const aux: Aux[] = [undefined];
    if (arc.id === 'navigator') {
      const sh = shaftsNear(gen, p.pos[0], p.pos[2], 2500)[0];
      if (sh) {
        objs.push({ kind: 'goto', text: `Descend the great shaft toward ${host.lore.underworldName}`, pos: [sh.x, sh.y - 60, sh.z], radius: 50 });
        aux.push(undefined);
      }
    }
    if (arc.id === 'astrolabe') {
      objs.push({ kind: 'ability', text: 'Channel your power where the stars point (use any ability there)', ability: '*', count: 3 });
      aux.push(undefined);
    }
    const [o3, a3] = search(arc.id === 'astrolabe' ? 'Read the night sky from this place' : `Recover the second piece of ${d.relic}`, 12, arc.id === 'astrolabe');
    objs.push(o3);
    aux.push(a3);
    const optional: number[] = [];
    if (arc.id === 'beastlord' || arc.id === 'crown' || arc.id === 'ledger') {
      objs.push({ kind: 'kill', text: arc.id === 'beastlord' ? 'Defeat the beast-lord\'s heralds' : `Defeat ${d.villain}'s agents`, count: 2, pos: tpos });
      aux.push(arc.id === 'beastlord' ? { spawn: { kind: 'creature', species: sp.length ? r.pick(sp) : undefined, count: 2, pos: tpos, ids: [], seed: target.seed } } : { spawn: { kind: 'wanderer', wanderer: 'bandit', count: 2, pos: tpos, ids: [], seed: target.seed } });
    }
    return { spec: spec(arcName(arc), `The trail of ${d.figure} leads on. ${tl.legend}`, objs, 70), opts: opts(aux, optional) };
  }
  // Stage 2: the confrontation / revelation.
  const villain = arc.id === 'beastlord' ? String(d.beast ?? 'the Beast-Lord') : String(d.villain);
  const objs: QuestObjectiveSpec[] = [{ kind: 'goto', text: `Go to ${tl.name}, ${bearing(here, target)}`, pos: tpos, radius: 40 }];
  const aux: Aux[] = [undefined];
  if (arc.id === 'beastlord' || arc.id === 'crown' || arc.id === 'ledger') {
    const bossSp = host.ctx.services.creatures.speciesFor(target.biome, 'boss', false);
    objs.push({ kind: 'kill', text: `Defeat ${villain}`, count: 1, pos: tpos });
    aux.push(arc.id === 'beastlord'
      ? { spawn: { kind: 'creature', species: bossSp.length ? r.pick(bossSp) : undefined, count: 1, pos: tpos, boss: true, name: villain, title: 'Lord of Beasts', ids: [], seed: target.seed + 3 } }
      : { spawn: { kind: 'wanderer', wanderer: 'bandit', count: 1, pos: tpos, name: villain, title: 'Schemer', ids: [], seed: target.seed + 3 } });
  }
  const [o3, a3] = search(`Claim ${d.relic}`, 8);
  objs.push(o3);
  aux.push(a3);
  return { spec: spec(arcName(arc), `It ends at ${tl.name}. ${d.figure}'s legacy waits there — and so does ${villain}.`, objs, 120, { rewards: { coins: coinsFor(p, 120, r), xp: xpFor(p, 400, ...ARC_CATS[arc.id]), text: String(d.relic) } }), opts: opts(aux) };
}

export function arcName(arc: ArcState): string {
  const d = arc.data;
  switch (arc.id) {
    case 'navigator': return `The Map of ${d.figureShort}`;
    case 'beastlord': return 'The Beast-Lord';
    case 'crown': return `The Crown of ${d.figureShort}`;
    case 'forge': return `${cap(String(d.relic).replace(/^the /, ''))} Reforged`;
    case 'astrolabe': return `The Star-Reader's Warning`;
    case 'ledger': return `The Ledger of ${String(d.villain).split(' ')[0]}`;
    default: return 'A Personal Tale';
  }
}

/** Short reason text for an arc beat in narration. */
export function arcBlurb(arc: ArcState): string {
  return `${arcName(arc)} — a tale that began with ${arc.data.figure}`;
}

export { poiById };
