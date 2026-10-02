/**
 * Welcome guide: a docked HUD tab explaining Norgo's concepts. Three states,
 * remembered per browser: open (full guide), collapsed (small tab) and closed
 * (hidden; reopen with H, the touch menu bar or from the pause menu). Sections are
 * individually collapsible. It never captures the mouse — read it, then click back
 * into the world.
 *
 * Every control it mentions comes from the command registry (src/client/commands.ts)
 * through src/ui/controls.ts: key caps with a keyboard & mouse, the touch buttons and
 * gestures on touch screens. It re-renders when the input mode or a key binding changes.
 */
import { h } from '../dom';
import type { ClientContext } from '../../client/context';
import { glyphSvg } from '../icons';
import { command, controlRows, type CommandId } from '../../client/commands';
import { controlsTable, currentOverrides, keyCaps, keyHint } from '../controls';
import { platform } from '../../core/platform';

export type GuideState = 'open' | 'collapsed' | 'closed';
const KEY = 'norgo.guide.state';
const SECTION_KEY = 'norgo.guide.sections';

type Bit = string | HTMLElement;

interface Section {
  id: string;
  title: string;
  body: (ctx: ClientContext, touch: boolean) => Bit[];
}

const p = (...c: Bit[]) => h('p', null, ...c);
const li = (...c: Bit[]) => h('li', null, ...c);

/** A command as it is performed in the current mode: key caps, or the touch button's glyph + name. */
function k(id: CommandId): Bit[] {
  if (platform.inputMode === 'touch') {
    const c = command(id);
    return [h('span', { class: 'n-touch-chip', html: `${glyphSvg(c.glyph, 13)}<span>${c.short}</span>` })];
  }
  return keyCaps(id);
}

/** Lower-case touch instruction of a command ("hold the target button"). */
const touchText = (id: CommandId) => {
  const t = command(id).touch.text;
  return t.charAt(0).toLowerCase() + t.slice(1);
};

/** Movement & camera controls of the current mode, straight from the registry. */
function controlsList(touch: boolean): HTMLElement {
  const rows = controlRows(currentOverrides()).filter((r) => (r.group === 'Movement' || r.group === 'Camera') && (!touch || r.touch.method !== 'none'));
  return h('ul', { class: 'n-guide-controls' }, ...rows.map((r) => (touch
    ? li(h('span', { class: 'n-touch-chip', html: `${glyphSvg(command(r.ids[0]).glyph, 13)}<span>${r.touch.text}</span>` }), ' ', r.label.toLowerCase())
    : li(...r.keys.flatMap((alt, i) => [...(i ? [' / '] : []), ...alt.map((cap) => (cap === '…' ? '…' : h('kbd', { class: 'n-guide-kbd', text: cap })))]), ' ', r.label.toLowerCase()))));
}

const SECTIONS: Section[] = [
  {
    id: 'move',
    title: 'Getting around',
    body: (_ctx, touch) => [
      controlsList(touch),
      h('ul', null,
        touch
          ? li('Touch the left side for the thumb-stick, drag anywhere else to look around. Buttons sit under your right thumb; the bar at the top left opens your bag, skills, journal, map and menu.')
          : li('Click the world to capture the mouse, ', ...k('pause'), ' to free it.'),
        li('Push against steep rock to climb (costs stamina). Deep water means swimming; look down to dive.'),
        li(...k('interact'), touch ? ' appears when something is in reach: talk, pick up, gather, open doors, sit or sleep.' : ' interacts: talk, pick up, gather, open doors, sit or sleep.'),
      ),
    ],
  },
  {
    id: 'grow',
    title: 'You grow by doing',
    body: (_ctx, touch) => [
      p('There are no classes and no experience levels. Every skill improves when you use it: swing a blade for Blades, sneak near beasts for Stealth, swim for Swimming, chop for Woodcutting, haggle for Barter.'),
      p('When a skill crosses a threshold it unlocks a new ability, which lands on your hotbar automatically. Open the skill book with ', ...k('skills'), ' to see thresholds and drag abilities onto ',
        ...(touch ? ['hotbar slots — tap a slot to use it.'] : ['slots ', ...keyCaps('hot1'), '–', ...keyCaps('hot0'), '.'])),
    ],
  },
  {
    id: 'magic',
    title: 'Abilities & magic',
    body: (_ctx, touch) => [
      p('Abilities are physical or magical, for fighting and for everything else: dodging, climbing faster, picking locks, persuading, taming animals, finding ore.'),
      p('Magic comes in ten schools — fire, frost, earth shaping, gravity, healing, light, shadow, force, beasts and runes. Earth magic and explosions really dig and raise the ground; gravity spells change how things fall.'),
      p(...k('attack'), ' attacks with what you hold, ', ...k('block'), ' blocks. Some abilities charge while you hold their ', touch ? 'hotbar slot.' : 'key.'),
      touch
        ? p(...k('target'), ' picks a target nearby — foes first, then the closest to your view; tap again for the next, ', touchText('targetPrev'), ' to go back, ', touchText('targetClear'), ' to let go. Swings, shots and spells then aim at it for you; ranged attacks at your target always hit, and if one cannot (out of range, no line of sight) you are told why.')
        : p(...k('target'), ' picks a target nearby — foes first, then the closest to your crosshair; press again for the next, ', ...k('targetPrev'), ' to go back, ', ...k('targetClear'), ' to let go. Swings, shots and spells then aim at it for you; ranged attacks at your target always hit, and if one cannot (out of range, no line of sight) you are told why.'),
    ],
  },
  {
    id: 'gear',
    title: 'Gear, gathering & crafting',
    body: (_ctx, touch) => [
      p('Everything you wear shows on your character and changes your stats. Inventory and equipment: ', ...k('inventory'), '.'),
      p('Trees can be felled with an axe, rock and ore mined with a pick, and the ground itself dug a little with a pick or shovel — aim at it and ', ...(touch ? ['press ', ...k('attack')] : ['click']), '. Herbs, mushrooms and crystals are gathered with ', ...k('interact'), '.'),
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
      p('Ask it anything with ', ...k('gm'), ' — where to go, who rules here, what the legends say, or for a challenge. Quests and the story so far live in the journal (', ...k('journal'), '); the world map is on ', ...k('map'), '.'),
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
    body: () => [p('The journey autosaves every few minutes. Save any time from the pause menu (', ...k('pause'), '); continue from the title screen.')],
  },
  {
    id: 'controls',
    title: 'All controls',
    body: () => [controlsTable()],
  },
];

export class WelcomeGuide {
  readonly el: HTMLElement;
  private state: GuideState;
  private openSections: Set<string>;
  private body: HTMLElement;
  private titleBtn: HTMLButtonElement;
  private collapseBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private tab: HTMLButtonElement;
  /** Signature of what the content depends on (input mode, bindings) to skip needless rebuilds. */
  private sig = '';

  constructor(private ctx: ClientContext) {
    this.state = readState();
    this.openSections = readSections();
    this.titleBtn = h('button', { class: 'n-guide-title', onclick: () => this.setState(this.state === 'open' ? 'collapsed' : 'open') },
      h('span', { class: 'n-guide-glyph', text: '❖' }),
      h('span', { class: 'n-guide-name', text: `Welcome to ${ctx.profile.name}` }),
    );
    this.collapseBtn = h('button', { class: 'n-guide-btn', text: '–', onclick: () => this.setState('collapsed') });
    this.closeBtn = h('button', { class: 'n-guide-btn', text: '×', onclick: () => this.setState('closed') });
    const header = h('div', { class: 'n-guide-head' }, this.titleBtn, this.collapseBtn, this.closeBtn);
    this.body = h('div', { class: 'n-guide-body' });
    this.tab = h('button', { class: 'n-guide-tab', onclick: () => this.setState('open') });
    this.el = h('div', { class: 'n-guide' }, h('div', { class: 'n-guide-panel' }, header, this.body), this.tab);
    this.render();
    this.apply();
  }

  /** Rebuild the content for the current input mode and key bindings. */
  render() {
    const touch = platform.inputMode === 'touch';
    const sig = `${platform.inputMode}|${JSON.stringify(currentOverrides())}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const hk = keyHint('guide');
    this.titleBtn.title = `Collapse / expand${hk}`;
    this.collapseBtn.title = `Collapse${hk}`;
    this.closeBtn.title = touch ? 'Close — reopen from the menu bar' : `Close — reopen with${hk.replace(/[()]/g, '')} or from the pause menu`;
    this.tab.replaceChildren(h('span', { class: 'n-guide-glyph', text: '❖' }), 'Guide ', ...(touch ? [] : keyCaps('guide')));
    this.tab.title = `Open the guide${hk}`;
    this.body.replaceChildren(
      touch
        ? p('A few pointers for your first steps. Sections fold open and closed; tap ', ...k('guide'), ' in the menu bar to tuck the guide away.')
        : p('A few pointers for your first steps. Sections fold open and closed; press ', ...k('guide'), ' to tuck the guide away.'),
      ...SECTIONS.map((s) => {
        const d = h('details', { class: 'n-guide-sec' },
          h('summary', { text: s.title }),
          h('div', { class: 'n-guide-text' }, ...s.body(this.ctx, touch)),
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
  }

  /** Guide command: open ↔ collapsed; a closed guide reopens. */
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
