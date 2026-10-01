/**
 * Welcome guide: a docked HUD tab explaining Norgo's concepts. Three states,
 * remembered per browser: open (full guide), collapsed (small tab) and closed
 * (hidden; reopen with H or from the pause menu). Sections are individually
 * collapsible. It never captures the mouse — read it, then click back into
 * the world.
 */
import { h } from '../dom';
import type { ClientContext } from '../../client/context';
import { keyLabel, settingsStore } from '../settings';

export type GuideState = 'open' | 'collapsed' | 'closed';
const KEY = 'norgo.guide.state';
const SECTION_KEY = 'norgo.guide.sections';

interface Section {
  id: string;
  title: string;
  body: (ctx: ClientContext) => (string | HTMLElement)[];
}

const kbd = (k: string) => h('kbd', { class: 'n-guide-kbd', text: k });
const p = (...c: (string | HTMLElement)[]) => h('p', null, ...c);
const li = (...c: (string | HTMLElement)[]) => h('li', null, ...c);
const targetKey = () => keyLabel(settingsStore.get().controls.targetKey || 'Tab');

const SECTIONS: Section[] = [
  {
    id: 'move',
    title: 'Getting around',
    body: () => [
      h('ul', null,
        li(kbd('W A S D'), ' move, ', kbd('Shift'), ' sprint, ', kbd('Alt'), ' walk, ', kbd('C'), ' sneak, ', kbd('Space'), ' jump.'),
        li('Mouse looks around, the wheel zooms — all the way in for first person. Click the world to capture the mouse, ', kbd('Esc'), ' to free it.'),
        li('Push against steep rock to climb (costs stamina). Deep water means swimming; look down to dive.'),
        li(kbd('E'), ' interacts: talk, pick up, gather, open doors, sit or sleep.'),
      ),
    ],
  },
  {
    id: 'grow',
    title: 'You grow by doing',
    body: () => [
      p('There are no classes and no experience levels. Every skill improves when you use it: swing a blade for Blades, sneak near beasts for Stealth, swim for Swimming, chop for Woodcutting, haggle for Barter.'),
      p('When a skill crosses a threshold it unlocks a new ability, which lands on your hotbar automatically. Open the skill book with ', kbd('K'), ' to see thresholds and drag abilities onto slots ', kbd('1'), '–', kbd('0'), '.'),
    ],
  },
  {
    id: 'magic',
    title: 'Abilities & magic',
    body: () => [
      p('Abilities are physical or magical, for fighting and for everything else: dodging, climbing faster, picking locks, persuading, taming animals, finding ore.'),
      p('Magic comes in ten schools — fire, frost, earth shaping, gravity, healing, light, shadow, force, beasts and runes. Earth magic and explosions really dig and raise the ground; gravity spells change how things fall.'),
      p(kbd('LMB'), ' attacks with what you hold, ', kbd('RMB'), ' blocks. Some abilities charge while you hold their key.'),
      p(kbd(targetKey()), ' picks a target nearby — foes first, then the closest to your crosshair; press again for the next, ', kbd('Shift'), '+', kbd(targetKey()), ' to go back, ', kbd('Esc'), ' to let go. Swings, shots and spells then aim at it for you.'),
    ],
  },
  {
    id: 'gear',
    title: 'Gear, gathering & crafting',
    body: () => [
      p('Everything you wear shows on your character and changes your stats. Inventory and equipment: ', kbd('I'), '.'),
      p('Trees can be felled with an axe, rock and ore mined with a pick, and the ground itself dug a little with a pick or shovel — aim at it and click. Herbs, mushrooms and crystals are gathered with ', kbd('E'), '.'),
      p('Craft at the right station: forges in smithies, cooking fires, alchemy benches, looms.'),
    ],
  },
  {
    id: 'people',
    title: 'A living world',
    body: () => [
      p('Townsfolk have homes, jobs, needs and goals of their own. They remember what you do and gossip about it. Talk to them for news, directions, trade and work; some of their troubles become quests.'),
      p('Wild creatures graze, hunt, sleep and defend their territory. Most leave you alone unless you get too close — or hit them first.'),
    ],
  },
  {
    id: 'gm',
    title: 'The Game Master',
    body: () => [
      p('An unseen Game Master watches over your journey: it narrates, paces danger and calm, offers quests from ruins, shrines and lairs, and reacts to what you do.'),
      p('Ask it anything with ', kbd('G'), ' — where to go, who rules here, what the legends say, or for a challenge. Quests and the story so far live in the journal (', kbd('J'), '); the world map is on ', kbd('M'), '.'),
    ],
  },
  {
    id: 'world',
    title: 'This world',
    body: (ctx) => {
      const pr = ctx.profile;
      return [
        p(`You walk ${pr.name}. Every seed is a different world — its skies, colours, lands, creatures and peoples.`),
        p('Gravity varies: some regions float almost weightless among sky islands, others press down hard. Watch the gravity readout under the minimap.'),
        p('Below the land lie caves and, deeper still, a vast underworld with its own biomes. It is dark down there — carry a torch or learn a light spell.'),
      ];
    },
  },
  {
    id: 'save',
    title: 'Saving',
    body: () => [p('The journey autosaves every few minutes. Save any time from the pause menu (', kbd('Esc'), '); continue from the title screen.')],
  },
];

export class WelcomeGuide {
  readonly el: HTMLElement;
  private state: GuideState;
  private openSections: Set<string>;

  constructor(private ctx: ClientContext) {
    this.state = readState();
    this.openSections = readSections();
    const header = h('div', { class: 'n-guide-head' },
      h('button', { class: 'n-guide-title', title: 'Collapse / expand (H)', onclick: () => this.setState(this.state === 'open' ? 'collapsed' : 'open') },
        h('span', { class: 'n-guide-glyph', text: '❖' }),
        h('span', { class: 'n-guide-name', text: `Welcome to ${ctx.profile.name}` }),
      ),
      h('button', { class: 'n-guide-btn', title: 'Collapse (H)', text: '–', onclick: () => this.setState('collapsed') }),
      h('button', { class: 'n-guide-btn', title: 'Close — reopen with H or from the pause menu', text: '×', onclick: () => this.setState('closed') }),
    );
    const body = h('div', { class: 'n-guide-body' },
      p('A few pointers for your first steps. Sections fold open and closed; press ', kbd('H'), ' to tuck the guide away.'),
      ...SECTIONS.map((s) => {
        const d = h('details', { class: 'n-guide-sec' },
          h('summary', { text: s.title }),
          h('div', { class: 'n-guide-text' }, ...s.body(ctx)),
        );
        d.open = this.openSections.has(s.id);
        d.addEventListener('toggle', () => {
          if (d.open) this.openSections.add(s.id);
          else this.openSections.delete(s.id);
          try {
            localStorage.setItem(SECTION_KEY, JSON.stringify([...this.openSections]));
          } catch {
            /* storage unavailable: state just isn't remembered */
          }
        });
        return d;
      }),
    );
    const tab = h('button', { class: 'n-guide-tab', title: 'Open the guide (H)', onclick: () => this.setState('open') },
      h('span', { class: 'n-guide-glyph', text: '❖' }), 'Guide ', kbd('H'));
    this.el = h('div', { class: 'n-guide' }, h('div', { class: 'n-guide-panel' }, header, body), tab);
    this.apply();
  }

  /** H key: open ↔ collapsed; a closed guide reopens. */
  toggle() {
    this.setState(this.state === 'open' ? 'collapsed' : 'open');
  }

  show() {
    this.setState('open');
  }

  setState(s: GuideState) {
    this.state = s;
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* storage unavailable */
    }
    this.apply();
  }

  private apply() {
    this.el.dataset.state = this.state;
  }
}

function readState(): GuideState {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'open' || v === 'collapsed' || v === 'closed') return v;
  } catch {
    /* storage unavailable */
  }
  return 'open';
}

function readSections(): Set<string> {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    if (v) return new Set(JSON.parse(v) as string[]);
  } catch {
    /* storage unavailable */
  }
  // First visit: the basics are unfolded.
  return new Set(['move', 'grow']);
}
