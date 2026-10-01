/**
 * Job catalog: where each profession works, how its day is structured, what
 * it animates while working, which tags/flags its entity carries, and which
 * long-term goals it tends to pursue. Pure data + small helpers (server-safe).
 */
import type { BuildingRole, SmartSpot } from '../settlements/types';
import type { NpcJob, NpcTraits } from './types';

/** What an NPC is doing right now (drives locomotion targets, animation and dialog flavour). */
export type ActivityKind =
  | 'sleep' | 'eat' | 'work' | 'socialize' | 'tavern' | 'pray' | 'patrol' | 'guard' | 'market' | 'wander'
  | 'play' | 'study' | 'home' | 'shelter' | 'beg' | 'prowl' | 'travel' | 'goal' | 'flee' | 'fight' | 'talk' | 'dead';

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  sleep: 'asleep', eat: 'having a meal', work: 'at work', socialize: 'chatting with neighbours', tavern: 'at the tavern',
  pray: 'at prayer', patrol: 'on patrol', guard: 'standing watch', market: 'at the market', wander: 'out for a stroll',
  play: 'playing', study: 'studying', home: 'at home', shelter: 'sheltering from the weather', beg: 'begging',
  prowl: 'slinking about', travel: 'travelling', goal: 'busy with an errand', flee: 'fleeing', fight: 'fighting',
  talk: 'in conversation', dead: 'dead',
};

/** Goal archetypes a job can pursue (see goals.ts). */
export type GoalKind =
  | 'restock' | 'tradeRun' | 'hunt' | 'investigate' | 'clearCamp' | 'protectFields' | 'courtship' | 'rivalry'
  | 'repayDebt' | 'ambition' | 'rebuild' | 'pilgrimage' | 'avenge' | 'heal' | 'gatherHerbs' | 'feast' | 'recruit';

export interface JobDef {
  id: NpcJob;
  /** Buildings this job works in (first match wins). */
  workRoles: BuildingRole[];
  /** Preferred smart spot kinds at work. */
  spotKinds: SmartSpot['kind'][];
  /** Animations cycled while working. */
  workAnims: string[];
  /** Works outside the settlement core (fields, woods, mines, shore, pastures). */
  outskirts?: 'fields' | 'woods' | 'mine' | 'shore' | 'pasture' | 'wilds';
  /** Typical day (hour → activity), before personality offsets. Must start at 0. */
  schedule: [number, ActivityKind][];
  tags: string[];
  merchant?: boolean;
  /** Base personal wealth 0..1 (scaled by settlement wealth). */
  wealth: number;
  /** Fighting competence 0..1 (guards, hunters, bandits...). */
  combat: number;
  /** Long-term goals this job gravitates to (personal goals like courtship are added independently). */
  goals: GoalKind[];
  /** Trait nudges applied at generation (jobs self-select personalities). */
  traitBias?: Partial<NpcTraits>;
  /** Skill levels for dialog checks / services (persuasion, barter, lore...). */
  skills: Record<string, number>;
  /** Goods the job produces / consumes, used by trade & restock goals. */
  produces?: string[];
  needs?: string[];
}

const DAY: [number, ActivityKind][] = [[0, 'sleep'], [6, 'eat'], [7, 'work'], [12, 'eat'], [13, 'work'], [18, 'eat'], [19, 'socialize'], [22, 'sleep']];

export const JOBS: Record<NpcJob, JobDef> = {
  farmer: {
    id: 'farmer', workRoles: ['farm', 'barn', 'mill'], spotKinds: ['farm', 'work'], workAnims: ['harvest', 'dig', 'pickup'], outskirts: 'fields',
    schedule: [[0, 'sleep'], [5, 'eat'], [6, 'work'], [12, 'eat'], [13, 'work'], [19, 'eat'], [20, 'socialize'], [21.5, 'sleep']],
    tags: ['farmer'], wealth: 0.3, combat: 0.15, goals: ['protectFields', 'feast', 'ambition'], skills: { lore: 10, barter: 15 },
    traitBias: { conscientiousness: 0.2 }, produces: ['grain', 'vegetables'], needs: ['tools'],
  },
  smith: {
    id: 'smith', workRoles: ['smithy', 'workshop'], spotKinds: ['forge', 'work'], workAnims: ['work_hammer', 'work_hammer', 'pickup'],
    schedule: DAY, tags: ['smith', 'crafter'], merchant: true, wealth: 0.55, combat: 0.35, goals: ['restock', 'ambition', 'recruit'],
    skills: { barter: 30, lore: 15 }, traitBias: { conscientiousness: 0.25, courage: 0.2 }, produces: ['tools', 'weapons'], needs: ['ore', 'charcoal'],
  },
  merchant: {
    id: 'merchant', workRoles: ['market', 'warehouse'], spotKinds: ['market', 'counter'], workAnims: ['gesture_wave', 'talk', 'gesture_point'],
    schedule: [[0, 'sleep'], [6.5, 'eat'], [7.5, 'market'], [12, 'eat'], [12.75, 'market'], [18, 'eat'], [19, 'tavern'], [22.5, 'sleep']],
    tags: ['merchant', 'trader'], merchant: true, wealth: 0.7, combat: 0.1, goals: ['tradeRun', 'restock', 'ambition', 'repayDebt'],
    skills: { barter: 45, persuasion: 30, lore: 15 }, traitBias: { greed: 0.35, extraversion: 0.2 }, produces: ['goods'], needs: ['goods'],
  },
  innkeeper: {
    id: 'innkeeper', workRoles: ['tavern'], spotKinds: ['counter', 'drink', 'cook'], workAnims: ['talk', 'pickup', 'drink'],
    schedule: [[0, 'work'], [1, 'sleep'], [8, 'eat'], [9, 'work'], [15, 'eat'], [15.5, 'work']],
    tags: ['innkeeper', 'merchant'], merchant: true, wealth: 0.55, combat: 0.2, goals: ['feast', 'restock', 'ambition'],
    skills: { barter: 35, persuasion: 25, lore: 25 }, traitBias: { extraversion: 0.35, agreeableness: 0.2 }, produces: ['ale', 'meals'], needs: ['grain', 'meat'],
  },
  guard: {
    id: 'guard', workRoles: ['barracks', 'watchtower', 'gate', 'wall'], spotKinds: ['guard', 'idle'], workAnims: ['block', 'gesture_point'],
    schedule: [[0, 'sleep'], [6, 'eat'], [7, 'patrol'], [11, 'guard'], [13, 'eat'], [14, 'patrol'], [18, 'eat'], [19, 'tavern'], [22, 'sleep']],
    tags: ['guard', 'watch'], wealth: 0.35, combat: 0.7, goals: ['clearCamp', 'avenge', 'ambition'],
    skills: { intimidation: 35, persuasion: 10 }, traitBias: { courage: 0.45, conscientiousness: 0.15 },
  },
  priest: {
    id: 'priest', workRoles: ['temple', 'shrine'], spotKinds: ['pray', 'read'], workAnims: ['pray', 'cast_up', 'channel'],
    schedule: [[0, 'sleep'], [5, 'pray'], [7, 'eat'], [8, 'work'], [12, 'eat'], [13, 'work'], [17, 'pray'], [19, 'eat'], [20, 'socialize'], [21.5, 'sleep']],
    tags: ['priest', 'healer'], wealth: 0.4, combat: 0.2, goals: ['pilgrimage', 'heal', 'recruit'],
    skills: { lore: 45, persuasion: 35 }, traitBias: { piety: 0.7, agreeableness: 0.25 },
  },
  hunter: {
    id: 'hunter', workRoles: ['stable', 'hut'], spotKinds: ['work', 'idle'], workAnims: ['shoot_bow', 'pickup', 'harvest'], outskirts: 'wilds',
    schedule: [[0, 'sleep'], [4.5, 'eat'], [5, 'work'], [14, 'eat'], [15, 'market'], [17, 'eat'], [18, 'tavern'], [21.5, 'sleep']],
    tags: ['hunter'], merchant: true, wealth: 0.35, combat: 0.6, goals: ['hunt', 'protectFields', 'avenge'],
    skills: { lore: 30, barter: 20, intimidation: 20 }, traitBias: { courage: 0.35, extraversion: -0.2 }, produces: ['meat', 'hides'],
  },
  scholar: {
    id: 'scholar', workRoles: ['library', 'mage_tower', 'hall'], spotKinds: ['read', 'seat', 'work'], workAnims: ['talk', 'channel', 'gesture_point'],
    schedule: [[0, 'study'], [1.5, 'sleep'], [8.5, 'eat'], [9, 'study'], [13, 'eat'], [14, 'study'], [18, 'eat'], [19, 'tavern'], [21, 'study']],
    tags: ['scholar'], wealth: 0.45, combat: 0.05, goals: ['investigate', 'ambition'],
    skills: { lore: 65, persuasion: 25 }, traitBias: { openness: 0.6, extraversion: -0.25 },
  },
  mage: {
    id: 'mage', workRoles: ['mage_tower', 'library'], spotKinds: ['read', 'work'], workAnims: ['channel', 'cast_forward', 'cast_up', 'cast_self'],
    schedule: [[0, 'study'], [2, 'sleep'], [9, 'eat'], [10, 'study'], [14, 'eat'], [15, 'study'], [19, 'eat'], [20, 'wander'], [22, 'study']],
    tags: ['mage', 'caster'], merchant: true, wealth: 0.65, combat: 0.6, goals: ['investigate', 'gatherHerbs', 'ambition'],
    skills: { lore: 70, persuasion: 20, intimidation: 30 }, traitBias: { openness: 0.5, agreeableness: -0.15 }, produces: ['scrolls'], needs: ['reagents'],
  },
  miner: {
    id: 'miner', workRoles: ['workshop', 'warehouse'], spotKinds: ['work'], workAnims: ['mine', 'mine', 'pickup'], outskirts: 'mine',
    schedule: [[0, 'sleep'], [5, 'eat'], [6, 'work'], [12, 'eat'], [12.5, 'work'], [18, 'eat'], [19, 'tavern'], [22, 'sleep']],
    tags: ['miner'], wealth: 0.3, combat: 0.3, goals: ['ambition', 'repayDebt'], skills: { lore: 15, intimidation: 15 }, produces: ['ore'],
    traitBias: { conscientiousness: 0.1, courage: 0.15 },
  },
  woodcutter: {
    id: 'woodcutter', workRoles: ['mill', 'workshop'], spotKinds: ['work'], workAnims: ['chop', 'chop', 'pickup'], outskirts: 'woods',
    schedule: [[0, 'sleep'], [5.5, 'eat'], [6.5, 'work'], [12, 'eat'], [13, 'work'], [18, 'eat'], [19, 'tavern'], [21.5, 'sleep']],
    tags: ['woodcutter'], wealth: 0.25, combat: 0.3, goals: ['ambition', 'protectFields'], skills: { lore: 10 }, produces: ['timber', 'charcoal'],
  },
  fisher: {
    id: 'fisher', workRoles: ['hut', 'warehouse'], spotKinds: ['work', 'seat'], workAnims: ['throw', 'pickup', 'sit'], outskirts: 'shore',
    schedule: [[0, 'sleep'], [4, 'eat'], [4.5, 'work'], [11, 'market'], [13, 'eat'], [14, 'work'], [18, 'eat'], [19, 'tavern'], [21, 'sleep']],
    tags: ['fisher'], merchant: true, wealth: 0.25, combat: 0.15, goals: ['tradeRun', 'ambition'], skills: { barter: 20, lore: 20 }, produces: ['fish'],
  },
  healer: {
    id: 'healer', workRoles: ['temple', 'workshop', 'house'], spotKinds: ['work', 'read', 'seat'], workAnims: ['cast_self', 'pickup', 'harvest'],
    schedule: DAY, tags: ['healer'], merchant: true, wealth: 0.45, combat: 0.1, goals: ['heal', 'gatherHerbs', 'ambition'],
    skills: { lore: 45, persuasion: 30 }, traitBias: { agreeableness: 0.45 }, produces: ['potions'], needs: ['herbs'],
  },
  bard: {
    id: 'bard', workRoles: ['tavern'], spotKinds: ['seat', 'drink', 'idle'], workAnims: ['dance', 'cheer', 'talk', 'bow'],
    schedule: [[0, 'tavern'], [2, 'sleep'], [10, 'eat'], [11, 'wander'], [14, 'socialize'], [17, 'eat'], [18, 'work']],
    tags: ['bard', 'entertainer'], wealth: 0.3, combat: 0.15, goals: ['courtship', 'ambition', 'investigate'],
    skills: { persuasion: 50, lore: 40 }, traitBias: { extraversion: 0.6, openness: 0.4 },
  },
  child: {
    id: 'child', workRoles: [], spotKinds: ['idle', 'seat'], workAnims: ['cheer', 'dance', 'gesture_wave'],
    schedule: [[0, 'sleep'], [7, 'eat'], [8, 'study'], [11, 'play'], [12, 'eat'], [13, 'play'], [18, 'eat'], [19, 'home'], [20.5, 'sleep']],
    tags: ['child'], wealth: 0, combat: 0, goals: [], skills: {},
  },
  elder: {
    id: 'elder', workRoles: ['hall', 'temple'], spotKinds: ['seat', 'idle'], workAnims: ['talk', 'gesture_point', 'sit'],
    schedule: [[0, 'sleep'], [6, 'eat'], [7, 'socialize'], [10, 'work'], [12, 'eat'], [13, 'sleep'], [14.5, 'socialize'], [18, 'eat'], [19, 'home'], [21, 'sleep']],
    tags: ['elder'], wealth: 0.45, combat: 0.05, goals: ['feast', 'recruit', 'pilgrimage'], skills: { lore: 50, persuasion: 35 },
    traitBias: { conscientiousness: 0.15, openness: -0.1 },
  },
  noble: {
    id: 'noble', workRoles: ['hall', 'mage_tower'], spotKinds: ['seat', 'counter', 'read'], workAnims: ['talk', 'gesture_point', 'bow'],
    schedule: [[0, 'sleep'], [8, 'eat'], [9, 'work'], [13, 'eat'], [14, 'socialize'], [16, 'work'], [19, 'eat'], [20, 'socialize'], [23, 'sleep']],
    tags: ['noble'], wealth: 0.95, combat: 0.3, goals: ['ambition', 'clearCamp', 'feast', 'rivalry'], skills: { persuasion: 45, intimidation: 40, lore: 35, barter: 30 },
    traitBias: { greed: 0.2, agreeableness: -0.1 },
  },
  beggar: {
    id: 'beggar', workRoles: [], spotKinds: ['idle', 'seat'], workAnims: ['gesture_wave', 'sit'],
    schedule: [[0, 'sleep'], [7, 'beg'], [12, 'eat'], [13, 'beg'], [19, 'tavern'], [21, 'sleep']],
    tags: ['beggar'], wealth: 0.02, combat: 0.05, goals: ['ambition', 'repayDebt'], skills: { persuasion: 25, lore: 30 },
  },
  thief: {
    id: 'thief', workRoles: [], spotKinds: ['idle', 'seat'], workAnims: ['pickup', 'gesture_shrug'],
    schedule: [[0, 'prowl'], [3.5, 'sleep'], [11, 'eat'], [12, 'market'], [16, 'tavern'], [20, 'eat'], [21, 'prowl']],
    tags: ['thief', 'rogue'], merchant: true, wealth: 0.3, combat: 0.4, goals: ['repayDebt', 'rivalry', 'ambition'],
    skills: { persuasion: 35, barter: 35, intimidation: 25 }, traitBias: { greed: 0.5, agreeableness: -0.3, conscientiousness: -0.3 },
  },
  bandit: {
    id: 'bandit', workRoles: ['camp', 'tent'], spotKinds: ['idle', 'seat', 'guard'], workAnims: ['swing_1h', 'gesture_point', 'cheer'],
    schedule: [[0, 'sleep'], [7, 'eat'], [8, 'guard'], [12, 'eat'], [13, 'patrol'], [19, 'socialize'], [23, 'sleep']],
    tags: ['bandit', 'hostile'], wealth: 0.3, combat: 0.6, goals: [], skills: { intimidation: 45, persuasion: 15 },
    traitBias: { agreeableness: -0.5, courage: 0.2, greed: 0.4 },
  },
  adventurer: {
    id: 'adventurer', workRoles: ['tavern'], spotKinds: ['seat', 'drink'], workAnims: ['swing_1h', 'gesture_point', 'cheer'],
    schedule: [[0, 'sleep'], [7, 'eat'], [8, 'travel'], [19, 'tavern'], [23, 'sleep']],
    tags: ['adventurer'], wealth: 0.4, combat: 0.65, goals: ['investigate', 'clearCamp', 'hunt'], skills: { persuasion: 25, intimidation: 30, lore: 30 },
    traitBias: { courage: 0.5, openness: 0.4 },
  },
  pilgrim: {
    id: 'pilgrim', workRoles: ['temple', 'shrine'], spotKinds: ['pray'], workAnims: ['pray', 'bow'],
    schedule: [[0, 'sleep'], [5, 'pray'], [6, 'travel'], [19, 'pray'], [20, 'sleep']],
    tags: ['pilgrim'], wealth: 0.15, combat: 0.1, goals: ['pilgrimage'], skills: { lore: 35, persuasion: 25 }, traitBias: { piety: 0.8 },
  },
  herder: {
    id: 'herder', workRoles: ['stable', 'barn', 'farm'], spotKinds: ['farm', 'work', 'idle'], workAnims: ['gesture_wave', 'harvest', 'pickup'], outskirts: 'pasture',
    schedule: [[0, 'sleep'], [5, 'eat'], [5.5, 'work'], [12, 'eat'], [13, 'work'], [19, 'eat'], [20, 'socialize'], [21.5, 'sleep']],
    tags: ['herder'], wealth: 0.25, combat: 0.25, goals: ['protectFields', 'hunt', 'tradeRun'], skills: { lore: 15, barter: 20 }, produces: ['wool', 'milk'],
  },
  cook: {
    id: 'cook', workRoles: ['tavern', 'hall'], spotKinds: ['cook', 'work', 'counter'], workAnims: ['work_hammer', 'pickup', 'eat'],
    schedule: [[0, 'sleep'], [5.5, 'eat'], [6, 'work'], [14, 'eat'], [15, 'socialize'], [16.5, 'work'], [21, 'tavern'], [23, 'sleep']],
    tags: ['cook'], merchant: true, wealth: 0.3, combat: 0.1, goals: ['restock', 'feast', 'ambition'], skills: { barter: 20, lore: 15 }, produces: ['meals'], needs: ['meat', 'grain'],
  },
  tailor: {
    id: 'tailor', workRoles: ['workshop', 'market'], spotKinds: ['work', 'counter', 'seat'], workAnims: ['pickup', 'work_saw', 'gesture_point'],
    schedule: DAY, tags: ['tailor', 'crafter'], merchant: true, wealth: 0.45, combat: 0.05, goals: ['restock', 'ambition', 'courtship'],
    skills: { barter: 35, persuasion: 25 }, produces: ['clothing'], needs: ['wool', 'hides'],
  },
  alchemist: {
    id: 'alchemist', workRoles: ['workshop', 'mage_tower', 'library'], spotKinds: ['work', 'read'], workAnims: ['channel', 'pickup', 'drink'],
    schedule: [[0, 'sleep'], [7.5, 'eat'], [8, 'work'], [13, 'eat'], [13.5, 'work'], [19, 'eat'], [20, 'study'], [23.5, 'sleep']],
    tags: ['alchemist', 'crafter'], merchant: true, wealth: 0.55, combat: 0.15, goals: ['gatherHerbs', 'investigate', 'restock'],
    skills: { lore: 55, barter: 30 }, traitBias: { openness: 0.4 }, produces: ['potions'], needs: ['herbs', 'reagents'],
  },
  carpenter: {
    id: 'carpenter', workRoles: ['workshop', 'mill', 'barn'], spotKinds: ['work'], workAnims: ['work_saw', 'work_hammer', 'pickup'],
    schedule: DAY, tags: ['carpenter', 'crafter', 'builder'], merchant: true, wealth: 0.4, combat: 0.15, goals: ['rebuild', 'restock', 'ambition'],
    skills: { barter: 25, lore: 15 }, produces: ['furniture'], needs: ['timber'],
  },
  mason: {
    id: 'mason', workRoles: ['workshop', 'wall', 'monument'], spotKinds: ['work'], workAnims: ['work_hammer', 'mine', 'pickup'],
    schedule: DAY, tags: ['mason', 'crafter', 'builder'], wealth: 0.4, combat: 0.2, goals: ['rebuild', 'restock', 'ambition'],
    skills: { barter: 20, lore: 20 }, produces: ['stonework'], needs: ['stone'],
  },
};

/** Human-readable descriptions of goods used in goals and dialog. */
export const GOODS_NAME: Record<string, string> = {
  grain: 'grain', vegetables: 'vegetables', tools: 'tools', weapons: 'weapons', ore: 'iron ore', charcoal: 'charcoal',
  goods: 'trade goods', ale: 'ale', meals: 'hot meals', meat: 'fresh meat', hides: 'hides', scrolls: 'scrolls',
  reagents: 'arcane reagents', timber: 'timber', fish: 'fish', potions: 'potions', herbs: 'healing herbs', wool: 'wool',
  milk: 'milk', clothing: 'clothing', furniture: 'furniture', stonework: 'dressed stone', stone: 'building stone',
};

/** Item definition ids the items module is expected to know (used in quest specs; collect/deliver). */
export const GOODS_ITEM: Record<string, string> = {
  ore: 'ore_iron', charcoal: 'charcoal', herbs: 'herb_healing', reagents: 'reagent_arcane', timber: 'wood_log', stone: 'stone_block',
  meat: 'meat_raw', hides: 'hide', wool: 'wool', grain: 'grain', goods: 'trade_goods', fish: 'fish_raw',
};

/** Jobs that a role supplies, with relative headcount weight (first = principal). */
export const ROLE_JOBS: Partial<Record<BuildingRole, [NpcJob, number][]>> = {
  smithy: [['smith', 1], ['smith', 0.5]],
  tavern: [['innkeeper', 1], ['cook', 0.8], ['bard', 0.6]],
  market: [['merchant', 1], ['merchant', 0.8], ['tailor', 0.5]],
  temple: [['priest', 1], ['healer', 0.7], ['priest', 0.3]],
  shrine: [['priest', 0.7]],
  barracks: [['guard', 1], ['guard', 1], ['guard', 0.8], ['guard', 0.5]],
  watchtower: [['guard', 1]],
  gate: [['guard', 0.8]],
  farm: [['farmer', 1], ['farmer', 0.6]],
  barn: [['herder', 0.8]],
  mill: [['farmer', 0.7], ['woodcutter', 0.5]],
  workshop: [['carpenter', 0.8], ['tailor', 0.5], ['alchemist', 0.4], ['mason', 0.5]],
  library: [['scholar', 1], ['scholar', 0.4]],
  mage_tower: [['mage', 1], ['alchemist', 0.6]],
  stable: [['herder', 0.8], ['hunter', 0.4]],
  warehouse: [['merchant', 0.8], ['miner', 0.3]],
  hall: [['noble', 1], ['elder', 0.8], ['cook', 0.4], ['scholar', 0.3]],
  camp: [['hunter', 0.5]],
  monument: [['mason', 0.3]],
};

/** Residential building roles. */
export const HOME_ROLES: BuildingRole[] = ['house', 'hut', 'longhouse', 'burrow', 'tent', 'hall', 'tavern', 'farm', 'barracks'];

/** Schedule activity at an hour, from a template sorted by hour. */
export function activityAt(schedule: [number, ActivityKind][], hour: number): ActivityKind {
  let a = schedule[schedule.length - 1][1];
  for (const [h, act] of schedule) if (hour >= h) a = act;
  return a;
}

/**
 * Build a personalized schedule: early birds shift the day forward, extraverts
 * trade evening home time for the tavern, the devout insert prayer, night-watch
 * guards invert their day. Pure function of record data → deterministic.
 */
export function personalSchedule(job: NpcJob, t: NpcTraits, opts: { nightShift?: boolean; hasTavern: boolean; hasTemple: boolean; jitter: number }): [number, ActivityKind][] {
  const base = JOBS[job].schedule;
  if (opts.nightShift) {
    return [[0, 'guard'], [3, 'patrol'], [6, 'eat'], [7, 'sleep'], [15, 'eat'], [16, 'socialize'], [19, 'eat'], [20, 'patrol']];
  }
  const shift = -t.conscientiousness * 0.75 + opts.jitter * 0.5;
  const out: [number, ActivityKind][] = [];
  for (const [h, a] of base) {
    let act: ActivityKind = a;
    if (act === 'socialize' && t.extraversion > 0.35 && opts.hasTavern) act = 'tavern';
    if (act === 'tavern' && !opts.hasTavern) act = 'socialize';
    if (act === 'tavern' && t.extraversion < -0.5) act = 'home';
    if (act === 'socialize' && t.extraversion < -0.55) act = 'home';
    if (act === 'pray' && !opts.hasTemple) act = 'pray'; // prays at home shrine / plaza
    const hh = h === 0 ? 0 : Math.min(23.9, Math.max(0.1, h + shift));
    out.push([hh, act]);
  }
  // The devout attend prayer before work.
  if (t.piety > 0.45 && job !== 'priest' && job !== 'child') {
    const workIdx = out.findIndex(([, a]) => a === 'work' || a === 'market' || a === 'patrol');
    if (workIdx > 0) out.splice(workIdx, 0, [Math.max(0.2, out[workIdx][0] - 0.75), 'pray']);
  }
  // Curious, open folk take an evening stroll.
  if (t.openness > 0.5 && job !== 'child') {
    const i = out.findIndex(([h, a]) => h > 17 && (a === 'socialize' || a === 'home'));
    if (i > 0) out.splice(i + 1, 0, [out[i][0] + 1, 'wander']);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}
