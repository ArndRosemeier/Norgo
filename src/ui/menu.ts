/**
 * Title screen & new-game flow:
 *   Title → New World (seed + live preview) → Character Creator → resolve
 *   Title → Continue / Load (localStorage saves) → resolve with save
 *   Title → Settings / Credits
 * `showMainMenu(container)` resolves with the player's NewGameChoice and removes itself.
 */
import './styles/base.css';
import './styles/menu.css';
import './styles/touch.css';
import type { NewGameChoice } from './UI';
import { h } from './dom';
import { frame, confirmModal } from './widgets';
import { MenuBackdrop } from './menu/backdrop';
import { WorldPreview, randomSeedText } from './menu/worldPreview';
import { CharacterCreator } from './menu/creator';
import { SettingsView } from './settingsView';
import { listSaves, readSave, deleteSave, type SaveSlot } from './saves';
import { settingsStore, applyInterfaceScale } from './settings';
import { raceDef } from './data';
import { glyphSvg } from './icons';

type Screen = 'title' | 'world' | 'creator' | 'load' | 'settings' | 'credits';

export const GAME_VERSION = '0.1.0';

export function showMainMenu(container: HTMLElement): Promise<NewGameChoice> {
  return new Promise((resolve) => {
    const root = h('div', { class: 'nmenu' });
    const canvas = h('canvas', { class: 'n-menu-bg' });
    const stage = h('div', { class: 'n-menu-stage' });
    root.append(canvas, h('div', { class: 'n-menu-grain' }), stage);
    container.appendChild(root);
    applyInterfaceScale(root, settingsStore.get().interface);
    const offSettings = settingsStore.on((s) => applyInterfaceScale(root, s.interface));
    const backdrop = new MenuBackdrop(canvas);

    let screen: Screen = 'title';
    let world: WorldPreview | null = null;
    let creator: CharacterCreator | null = null;
    let seedText = randomSeedText();

    const finish = (choice: NewGameChoice) => {
      root.classList.add('n-leaving');
      window.removeEventListener('keydown', onKey);
      offSettings();
      setTimeout(() => {
        world?.dispose();
        creator?.dispose();
        backdrop.dispose();
        root.remove();
      }, 650);
      resolve(choice);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('.n-modal-back')) return;
        if (screen === 'creator') go('world');
        else if (screen !== 'title') go('title');
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && screen === 'title') {
        const btns = [...stage.querySelectorAll<HTMLButtonElement>('.n-title-menu button:not(:disabled)')];
        if (!btns.length) return;
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[n].focus();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);

    const header = (title: string, sub: string, back: Screen) =>
      h('div', { class: 'n-screen-head' },
        h('button', { class: 'n-btn ghost small', html: `← Back`, onclick: () => go(back) }),
        h('div', null, h('h2', { class: 'n-screen-title', text: title }), h('div', { class: 'n-screen-sub', text: sub })),
      );

    function go(next: Screen) {
      if (screen === 'world' && next !== 'creator' && next !== 'world') {
        world?.dispose();
        world = null;
        backdrop.setProfile(null);
      }
      if (screen === 'creator' && next !== 'creator') {
        creator?.dispose();
        creator = null;
      }
      screen = next;
      stage.classList.remove('n-in');
      void stage.offsetWidth; // restart entrance animation
      stage.classList.add('n-in');
      stage.dataset.screen = next;
      switch (next) {
        case 'title': return renderTitle();
        case 'world': return renderWorld();
        case 'creator': return renderCreator();
        case 'load': return renderLoad();
        case 'settings': return renderSettings();
        case 'credits': return renderCredits();
      }
    }

    function continueSlot(slot: SaveSlot) {
      const data = readSave(slot.meta.seedText, slot.meta.name);
      if (!data) return;
      finish({ seed: slot.meta.seedText, name: slot.meta.name, appearance: slot.meta.appearance, save: data });
    }

    function renderTitle() {
      const saves = listSaves();
      const last = saves[0];
      const item = (label: string, glyph: string, onclick: () => void, sub?: string, disabled = false) =>
        h('button', { class: 'n-title-item', attrs: { type: 'button', disabled }, onclick },
          h('span', { class: 'n-title-glyph', html: glyphSvg(glyph, 18) }),
          h('span', { class: 'n-title-label' }, label, sub ? h('small', { text: sub }) : null),
        );
      stage.replaceChildren(
        h('div', { class: 'n-title' },
          h('div', { class: 'n-logo' },
            h('div', { class: 'n-logo-orn', html: ornament() }),
            h('h1', { class: 'n-logo-text', text: 'NORGO' }),
            h('div', { class: 'n-logo-tag', text: 'Worlds without end' }),
          ),
          h('nav', { class: 'n-title-menu', attrs: { 'aria-label': 'Main menu' } },
            last ? item('Continue', 'hourglass', () => continueSlot(last), `${last.meta.name} · ${last.meta.worldName}${last.meta.savedAt ? ` · ${timeAgo(last.meta.savedAt)}` : ''}`) : null,
            item('New World', 'sparkle', () => go('world'), 'Forge a seed, shape a hero'),
            item('Load', 'book', () => go('load'), saves.length ? `${saves.length} saved journey${saves.length > 1 ? 's' : ''}` : 'No saved journeys', !saves.length),
            item('Settings', 'key', () => go('settings')),
            item('Credits', 'scroll', () => go('credits')),
          ),
          h('div', { class: 'n-title-foot' }, h('span', { text: `v${GAME_VERSION}` }), h('span', { text: '↑↓ to choose · Enter to select' })),
        ),
      );
      (stage.querySelector('.n-title-item') as HTMLButtonElement | null)?.focus();
    }

    function renderWorld() {
      if (!world) {
        world = new WorldPreview(seedText);
        world.onProfile = (p) => backdrop.setProfile(p);
        backdrop.setProfile(world.profile);
      }
      const w = world;
      stage.replaceChildren(
        h('div', { class: 'n-screen n-screen-world' },
          header('A New World', 'Every seed births a different world.', 'title'),
          w.el,
          h('div', { class: 'n-screen-foot' },
            h('span', { class: 'n-faint', text: 'Tip: share a seed with a friend — you will both walk the same lands.' }),
            h('button', {
              class: 'n-btn primary', html: `Forge your hero ${glyphSvg('arrow', 14)}`,
              onclick: () => {
                seedText = w.seedText;
                go('creator');
              },
            }),
          ),
        ),
      );
      w.input.focus();
      w.input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          seedText = w.seedText;
          go('creator');
        }
      };
    }

    function renderCreator() {
      if (!creator) creator = new CharacterCreator();
      const c = creator;
      const begin = () => {
        const choice = c.getChoice();
        finish({ seed: world?.seedText ?? seedText, name: choice.name, appearance: choice.appearance });
      };
      stage.replaceChildren(
        h('div', { class: 'n-screen n-screen-creator' },
          header('Forge Your Hero', `Bound for ${world?.profile.name ?? 'a new world'}`, 'world'),
          c.el,
          h('div', { class: 'n-screen-foot' },
            h('span', { class: 'n-faint', text: 'Your skills grow by use — no classes, no limits.' }),
            h('button', { class: 'n-btn primary n-begin', html: `Begin the journey ${glyphSvg('arrow', 14)}`, onclick: begin }),
          ),
        ),
      );
    }

    function renderLoad() {
      const saves = listSaves();
      const list = h('div', { class: 'n-saves' });
      const draw = () => {
        const cur = listSaves();
        list.replaceChildren(
          ...(cur.length
            ? cur.map((s) =>
              h('div', { class: 'n-save', attrs: { tabindex: 0, role: 'button' }, onclick: () => continueSlot(s), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && continueSlot(s) },
                h('div', { class: 'n-save-sigil', html: glyphSvg('rune', 26, '#d4af6a') }),
                h('div', { class: 'n-save-main' },
                  h('div', { class: 'n-save-name', text: s.meta.name }),
                  h('div', { class: 'n-save-sub', text: `${s.meta.partial ? 'Traveller' : raceDef(s.meta.appearance.race).name}${s.meta.level ? ` · level ${s.meta.level}` : ''} · ${s.meta.worldName}${s.meta.location ? ` · ${s.meta.location}` : ''}` }),
                  h('div', { class: 'n-save-meta', text: `Seed “${s.meta.seedText}” · ${s.meta.day !== undefined ? `Day ${s.meta.day} · ` : ''}${s.meta.savedAt ? new Date(s.meta.savedAt).toLocaleString() : 'quick save'} · ${Math.max(1, Math.round(s.size / 1024))} KB` }),
                ),
                h('button', {
                  class: 'n-btn small danger', text: 'Delete',
                  onclick: async (e: MouseEvent) => {
                    e.stopPropagation();
                    if (await confirmModal('Delete save?', `${s.meta.name} in ${s.meta.worldName} will be lost forever.`, 'Delete', true)) {
                      deleteSave(s.meta.seedText, s.meta.name);
                      draw();
                    }
                  },
                }),
              ))
            : [h('div', { class: 'n-empty', text: 'No saved journeys yet.' })]),
        );
      };
      draw();
      stage.replaceChildren(h('div', { class: 'n-screen n-screen-narrow' }, header('Load Journey', `${saves.length} saved`, 'title'), frame('n-card', list)));
    }

    function renderSettings() {
      const view = new SettingsView();
      stage.replaceChildren(h('div', { class: 'n-screen n-screen-narrow' }, header('Settings', 'Saved automatically', 'title'), frame('n-card', view.el)));
    }

    function renderCredits() {
      stage.replaceChildren(
        h('div', { class: 'n-screen n-screen-narrow' },
          header('Credits', 'With gratitude', 'title'),
          frame('n-card n-credits',
            h('h3', { class: 'n-serif n-gold', text: 'Norgo' }),
            h('p', { text: 'A seed-driven open world of many peoples, strange lands and living stories — built with TypeScript and three.js.' }),
            h('div', { class: 'n-heading', text: 'Human bodies' }),
            h('p', { html: 'Base human mesh, morph targets and proxies from <b>MakeHuman</b> (makehumancommunity.org), released under <b>CC0 1.0 Universal</b> (public domain). Thank you to the MakeHuman team and community.' }),
            h('div', { class: 'n-heading', text: 'Technology' }),
            h('p', { html: '<b>three.js</b> — MIT License · <b>Vite</b> — MIT License · <b>TypeScript</b> — Apache 2.0' }),
            h('div', { class: 'n-heading', text: 'Typography' }),
            h('p', { html: '<b>Cinzel</b> by Natanael Gama and <b>Inter</b> by Rasmus Andersson — SIL Open Font License 1.1' }),
            h('div', { class: 'n-heading', text: 'Everything else' }),
            h('p', { text: 'Terrain, skies, creatures, flora, settlements, items, icons, music and sound are generated procedurally from each world’s seed.' }),
          ),
        ),
      );
    }

    go('title');
  });
}

function timeAgo(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function ornament(): string {
  return `<svg viewBox="0 0 400 40" width="400" height="40" fill="none" stroke="#d4af6a" stroke-width="1.2">
<path d="M10 20H160M240 20H390" stroke-opacity=".6"/><path d="M160 20c10-12 25-12 40 0 15-12 30-12 40 0-10 12-25 12-40 0-15 12-30 12-40 0z"/>
<circle cx="200" cy="20" r="4" fill="#f3d58f"/><circle cx="150" cy="20" r="2" fill="#d4af6a"/><circle cx="250" cy="20" r="2" fill="#d4af6a"/></svg>`;
}
