/**
 * Settings editor shared by the title menu and the in-game panel: graphics
 * presets & details, audio mix, controls (sensitivity, FOV, key bindings),
 * interface options and LLM brain endpoints for NPC dialog and the game master.
 */
import { h } from './dom';
import { slider, toggle, segmented, tabs } from './widgets';
import { settingsStore, keyLabel, UI_KEY_CODES, type GameSettings, type LlmSettings, type MusicStyleSetting, type QualityPreset } from './settings';
import { glyphSvg } from './icons';
import { DEFAULT_KEYS } from '../client/input';

export interface KeyBind {
  /** Key labels; a function for rebindable keys (read from the settings when drawn). */
  keys: string[] | (() => string[]);
  action: string;
  group: 'Movement' | 'Combat' | 'Interface';
}

const targetKey = () => keyLabel(settingsStore.get().controls.targetKey || 'Tab');

export const KEYBINDS: KeyBind[] = [
  { keys: ['W', 'A', 'S', 'D'], action: 'Move', group: 'Movement' },
  { keys: ['Space'], action: 'Jump / swim up', group: 'Movement' },
  { keys: ['Shift'], action: 'Sprint', group: 'Movement' },
  { keys: ['C'], action: 'Crouch / sneak', group: 'Movement' },
  { keys: ['E'], action: 'Interact / talk / pick up', group: 'Movement' },
  { keys: ['LMB'], action: 'Attack / use', group: 'Combat' },
  { keys: ['RMB'], action: 'Block / aim', group: 'Combat' },
  { keys: ['1', '…', '0'], action: 'Hotbar abilities & items', group: 'Combat' },
  { keys: () => [targetKey()], action: 'Next target (attacks & spells aim at it)', group: 'Combat' },
  { keys: () => ['Shift', targetKey()], action: 'Previous target', group: 'Combat' },
  { keys: ['Esc'], action: 'Clear target', group: 'Combat' },
  { keys: ['I'], action: 'Inventory & equipment', group: 'Interface' },
  { keys: ['K'], action: 'Skills & abilities', group: 'Interface' },
  { keys: ['J'], action: 'Journal & quests', group: 'Interface' },
  { keys: ['M'], action: 'World map', group: 'Interface' },
  { keys: ['G'], action: 'Ask the Game Master', group: 'Interface' },
  { keys: ['Esc'], action: 'Pause / close panel', group: 'Interface' },
  { keys: ['F3'], action: 'Debug overlay', group: 'Interface' },
];

export function keybindTable(): HTMLElement {
  const groups = ['Movement', 'Combat', 'Interface'] as const;
  return h('div', { class: 'n-keybinds' },
    ...groups.map((g) => h('div', { class: 'n-keybind-group' },
      h('div', { class: 'n-heading', text: g }),
      ...KEYBINDS.filter((k) => k.group === g).map((k) => h('div', { class: 'n-keybind' },
        h('span', { text: k.action }),
        h('span', { class: 'n-keys' }, ...(typeof k.keys === 'function' ? k.keys() : k.keys).map((key) => (key === '…' ? h('span', { class: 'n-faint', text: '…' }) : h('span', { class: 'n-key', text: key })))),
      )),
    )),
  );
}

/**
 * A "press a key" binding row. Listens in the capture phase so the key never reaches the game
 * or the panel (Esc cancels instead of closing the settings). Keys owned by the interface or by
 * another gameplay action are refused with a short explanation.
 */
function rebindRow(label: string, code: string, action: string, onSet: (code: string) => void): HTMLElement {
  const btn = h('button', { class: 'n-btn small n-rebind', text: keyLabel(code), attrs: { type: 'button', title: 'Click, then press the new key (Esc cancels)' } });
  const note = h('span', { class: 'n-rebind-note' });
  let listening = false;
  const stop = () => {
    listening = false;
    btn.classList.remove('listening');
    btn.textContent = keyLabel(code);
    window.removeEventListener('keydown', onKey, true);
    btn.removeEventListener('blur', stop);
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') {
      note.textContent = '';
      stop();
      return;
    }
    const owner = DEFAULT_KEYS[e.code];
    if (UI_KEY_CODES.includes(e.code) || (owner && owner !== action)) {
      note.textContent = `${keyLabel(e.code)} is already used${owner ? ` (${owner})` : ' by the interface'}.`;
      return;
    }
    note.textContent = '';
    code = e.code;
    stop();
    onSet(e.code);
  };
  btn.addEventListener('click', () => {
    if (listening) return stop();
    listening = true;
    note.textContent = '';
    btn.classList.add('listening');
    btn.textContent = 'Press a key…';
    window.addEventListener('keydown', onKey, true);
    btn.addEventListener('blur', stop);
  });
  return h('div', { class: 'n-keybind n-rebind-row' }, h('span', { text: label }), h('span', { class: 'n-keys' }, note, btn));
}

type Section = 'graphics' | 'audio' | 'controls' | 'interface' | 'ai';

export interface SettingsViewOpts {
  /** In-game: apply LLM config to the server. */
  applyLlm?: (which: 'llm' | 'gmLlm', cfg: LlmSettings) => void;
}

export class SettingsView {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: ReturnType<typeof tabs<Section>>;

  constructor(private opts: SettingsViewOpts = {}) {
    this.body = h('div', { class: 'n-settings-body' });
    this.tabs = tabs<Section>(
      [{ id: 'graphics', label: 'Graphics' }, { id: 'audio', label: 'Audio' }, { id: 'controls', label: 'Controls' }, { id: 'interface', label: 'Interface' }, { id: 'ai', label: 'AI Brains' }],
      'graphics',
      () => this.render(),
    );
    this.el = h('div', { class: 'n-settings' }, this.tabs.el, this.body);
    this.render();
  }

  private render() {
    const s = settingsStore.get();
    const sec = (title: string, ...kids: (Node | null)[]) => h('section', { class: 'n-set-sec' }, h('div', { class: 'n-heading', text: title }), ...kids);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    let kids: Node[] = [];
    switch (this.tabs.value) {
      case 'graphics': {
        const g = s.graphics;
        const up = (patch: Partial<GameSettings['graphics']>) => settingsStore.update('graphics', patch);
        kids = [
          sec('Quality preset',
            segmented<QualityPreset>(
              [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'ultra', label: 'Ultra' }, { id: 'custom', label: 'Custom' }],
              g.preset,
              (v) => {
                if (v !== 'custom') settingsStore.applyPreset(v);
                this.render();
              },
            ),
          ),
          sec('Detail',
            slider('Render scale', g.renderScale, { min: 0.5, max: 1.5, step: 0.05, format: pct, onInput: (v) => up({ renderScale: v }) }),
            slider('View distance', g.viewDistance, { min: 300, max: 4000, step: 50, format: (v) => `${(v / 1000).toFixed(1)} km`, onInput: (v) => up({ viewDistance: v }) }),
            slider('Vegetation', g.vegetation, { min: 0.25, max: 1.5, step: 0.05, format: pct, onInput: (v) => up({ vegetation: v }) }),
            h('div', { class: 'n-slider n-select-row' }, h('span', { text: 'Shadows' }),
              segmented([{ id: 'off', label: 'Off' }, { id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], g.shadows, (v) => up({ shadows: v })), h('span')),
            toggle('Bloom', g.bloom, (v) => up({ bloom: v })),
            toggle('Anti-aliasing', g.antialias, (v) => up({ antialias: v })),
            toggle('Weather particles & volumetrics', g.weatherFx, (v) => up({ weatherFx: v })),
          ),
          sec('Display',
            slider('Field of view', g.fov, { min: 55, max: 110, step: 1, format: (v) => `${Math.round(v)}°`, onInput: (v) => up({ fov: v }) }),
            slider('Frame cap', g.maxFps, { min: 0, max: 240, step: 10, format: (v) => (v === 0 ? 'Off' : `${v}`), onInput: (v) => up({ maxFps: v }) }),
          ),
        ];
        break;
      }
      case 'audio': {
        const a = s.audio;
        const up = (patch: Partial<GameSettings['audio']>) => settingsStore.update('audio', patch);
        kids = [
          sec('Volume',
            slider('Master', a.master, { min: 0, max: 1, format: pct, onInput: (v) => up({ master: v }) }),
            slider('Music', a.music, { min: 0, max: 1, format: pct, onInput: (v) => up({ music: v }) }),
            slider('Effects', a.effects, { min: 0, max: 1, format: pct, onInput: (v) => up({ effects: v }) }),
            slider('Ambience', a.ambience, { min: 0, max: 1, format: pct, onInput: (v) => up({ ambience: v }) }),
            slider('Voices', a.voice, { min: 0, max: 1, format: pct, onInput: (v) => up({ voice: v }) }),
            slider('Interface', a.ui, { min: 0, max: 1, format: pct, onInput: (v) => up({ ui: v }) }),
          ),
          sec('Music',
            h('div', { class: 'n-slider n-select-row' }, h('span', { text: 'Music style' }),
              segmented<MusicStyleSetting>(
                [{ id: 'adaptive', label: 'Adaptive score' }, { id: 'generative', label: 'Generative only' }],
                a.musicStyle === 'generative' ? 'generative' : 'adaptive',
                (v) => {
                  up({ musicStyle: v });
                  this.render();
                },
              ), h('span')),
            h('p', { class: 'n-faint', text: a.musicStyle === 'generative'
              ? 'Fully synthesized score, derived from the world seed (its own scales and tunings).'
              : 'Recorded stems mixed live by place, time, settlements and combat, with in-key generative accents.' }),
          ),
        ];
        break;
      }
      case 'controls': {
        const c = s.controls;
        const up = (patch: Partial<GameSettings['controls']>) => settingsStore.update('controls', patch);
        kids = [
          sec('Mouse',
            slider('Sensitivity', c.mouseSensitivity, { min: 0.2, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => up({ mouseSensitivity: v }) }),
            toggle('Invert vertical look', c.invertY, (v) => up({ invertY: v })),
          ),
          sec('Movement',
            toggle('Toggle sprint (instead of hold)', c.toggleSprint, (v) => up({ toggleSprint: v })),
            toggle('Toggle crouch (instead of hold)', c.toggleCrouch, (v) => up({ toggleCrouch: v })),
          ),
          sec('Rebind',
            rebindRow('Cycle targets (Shift + key: backwards)', c.targetKey || 'Tab', 'target', (code) => {
              up({ targetKey: code });
              this.render();
            }),
          ),
          sec('Key bindings', keybindTable()),
        ];
        break;
      }
      case 'interface': {
        const i = s.interface;
        const up = (patch: Partial<GameSettings['interface']>) => settingsStore.update('interface', patch);
        kids = [
          sec('Layout',
            slider('Interface scale', i.scale, { min: 0.8, max: 1.3, step: 0.05, format: pct, onInput: (v) => up({ scale: v }) }),
            h('div', { class: 'n-slider n-select-row' }, h('span', { text: 'Crosshair' }),
              segmented([{ id: 'dot', label: 'Dot' }, { id: 'cross', label: 'Cross' }, { id: 'circle', label: 'Ring' }, { id: 'none', label: 'None' }], i.crosshair, (v) => up({ crosshair: v })), h('span')),
          ),
          sec('Heads-up display',
            toggle('Minimap', i.minimap, (v) => up({ minimap: v })),
            toggle('Compass', i.compass, (v) => up({ compass: v })),
            toggle('Floating damage numbers', i.damageNumbers, (v) => up({ damageNumbers: v })),
            toggle('Game Master narration', i.narration, (v) => up({ narration: v })),
            slider('Nameplate distance', i.nameplateDistance, { min: 10, max: 80, step: 1, format: (v) => `${Math.round(v)} m`, onInput: (v) => up({ nameplateDistance: v }) }),
          ),
        ];
        break;
      }
      case 'ai':
        kids = [
          h('p', { class: 'n-faint', style: 'font-size:12.5px;margin:0 0 12px', text: 'Optionally connect an OpenAI-compatible chat endpoint (e.g. a local Ollama or LM Studio server). NPCs gain free-form conversation; the Game Master improvises narration and answers. Without it, both use their built-in procedural brains.' }),
          this.llmSection('llm', 'NPC dialog brain', s.llm),
          this.llmSection('gmLlm', 'Game Master brain', s.gmLlm),
        ];
        break;
    }
    const reset = this.tabs.value !== 'ai'
      ? h('div', { class: 'n-set-foot' }, h('button', {
        class: 'n-btn small ghost', text: 'Restore defaults',
        onclick: () => {
          const sec = this.tabs.value as Exclude<Section, 'ai'>;
          settingsStore.reset(sec);
          this.render();
        },
      }))
      : null;
    this.body.replaceChildren(...kids, ...(reset ? [reset] : []));
  }

  private llmSection(which: 'llm' | 'gmLlm', title: string, cfg: LlmSettings): HTMLElement {
    const draft = { ...cfg };
    const field = (label: string, key: 'endpoint' | 'model' | 'apiKey', type = 'text', placeholder = '') => {
      const input = h('input', { class: 'n-input', attrs: { type, placeholder, spellcheck: 'false', autocomplete: 'off' } });
      input.value = String(draft[key]);
      input.addEventListener('input', () => (draft[key] = input.value.trim()));
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return h('div', { class: 'n-field' }, h('label', { text: label }), input);
    };
    const status = h('span', { class: 'n-faint', style: 'font-size:12px' });
    return h('section', { class: 'n-set-sec' },
      h('div', { class: 'n-heading', html: `${glyphSvg(which === 'llm' ? 'speech' : 'eye', 14)} ${title}` }),
      toggle('Enabled', draft.enabled, (v) => (draft.enabled = v)),
      field('Endpoint URL', 'endpoint', 'url', 'http://localhost:11434/v1/chat/completions'),
      h('div', { class: 'n-grid2' }, field('Model', 'model', 'text', 'llama3.1'), field('API key (optional)', 'apiKey', 'password', 'sk-…')),
      slider('Creativity', draft.temperature, { min: 0, max: 1.5, step: 0.05, format: (v) => v.toFixed(2), onInput: (v) => (draft.temperature = v) }),
      h('div', { class: 'n-set-foot' },
        status,
        h('button', {
          class: 'n-btn small primary', text: 'Apply',
          onclick: () => {
            settingsStore.update(which, draft);
            this.opts.applyLlm?.(which, { ...draft });
            status.textContent = this.opts.applyLlm ? 'Applied to this world.' : 'Saved — applied when the world loads.';
          },
        }),
      ),
    );
  }
}
