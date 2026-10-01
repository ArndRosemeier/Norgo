/**
 * Persistent player settings (localStorage `norgo.settings`). The UI edits them;
 * the client core reads them at startup (`loadSettings()`) and reacts to changes
 * through `UI.onGraphicsChange` / `UI.onSettingsChange` or `settingsStore.on`.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

export interface GraphicsSettings {
  preset: QualityPreset;
  /** Internal resolution multiplier (0.5..1.5) relative to devicePixelRatio-capped size. */
  renderScale: number;
  /** Terrain/streaming view distance in meters. */
  viewDistance: number;
  shadows: 'off' | 'low' | 'high';
  bloom: boolean;
  antialias: boolean;
  /** Vegetation density multiplier 0.25..1.5. */
  vegetation: number;
  /** Volumetric fog/weather particles. */
  weatherFx: boolean;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Cap framerate (0 = uncapped / vsync). */
  maxFps: number;
}

/** 'adaptive' = recorded stems mixed live + generative accents; 'generative' = fully synthesized score. */
export type MusicStyleSetting = 'adaptive' | 'generative';

export interface AudioSettings {
  master: number;
  music: number;
  effects: number;
  ambience: number;
  voice: number;
  ui: number;
  musicStyle: MusicStyleSetting;
}

export interface ControlSettings {
  /** Radians per pixel multiplier (1 = default). */
  mouseSensitivity: number;
  invertY: boolean;
  /** Toggle (true) or hold (false) to sprint. */
  toggleSprint: boolean;
  toggleCrouch: boolean;
  /** KeyboardEvent.code that cycles tab targets (Shift + it cycles backwards). */
  targetKey: string;
}

/**
 * Keys the interface itself owns (panel toggles, guide, debug, pause). Rebindable gameplay
 * actions may not take them. Keep in sync with UI.onKey / TOGGLE_KEYS.
 */
export const UI_KEY_CODES: readonly string[] = ['KeyI', 'KeyK', 'KeyJ', 'KeyM', 'KeyG', 'KeyH', 'F3', 'Escape'];

/** Short human label for a KeyboardEvent.code ("KeyT" → "T", "Digit4" → "4", "Backquote" → "`"). */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
  const named: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps', Backspace: 'Bksp', Enter: 'Enter', Tab: 'Tab', IntlBackslash: '<',
    ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', AltRight: 'AltGr',
    Insert: 'Ins', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
    NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
  };
  return named[code] ?? code;
}

export interface InterfaceSettings {
  /** Overall UI scale 0.8..1.3. */
  scale: number;
  minimap: boolean;
  compass: boolean;
  damageNumbers: boolean;
  nameplateDistance: number;
  /** Show GM narration on screen. */
  narration: boolean;
  crosshair: 'dot' | 'cross' | 'circle' | 'none';
}

export interface LlmSettings {
  enabled: boolean;
  /** OpenAI-compatible chat completions endpoint. */
  endpoint: string;
  model: string;
  apiKey: string;
  temperature: number;
}

export interface GameSettings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  interface: InterfaceSettings;
  /** NPC dialog brain. */
  llm: LlmSettings;
  /** Game master brain. */
  gmLlm: LlmSettings;
}

export const GRAPHICS_PRESETS: Record<Exclude<QualityPreset, 'custom'>, Omit<GraphicsSettings, 'preset' | 'fov' | 'maxFps'>> = {
  low: { renderScale: 0.7, viewDistance: 600, shadows: 'off', bloom: false, antialias: false, vegetation: 0.4, weatherFx: false },
  medium: { renderScale: 0.85, viewDistance: 1100, shadows: 'low', bloom: true, antialias: true, vegetation: 0.75, weatherFx: true },
  high: { renderScale: 1, viewDistance: 1800, shadows: 'high', bloom: true, antialias: true, vegetation: 1, weatherFx: true },
  ultra: { renderScale: 1.25, viewDistance: 2800, shadows: 'high', bloom: true, antialias: true, vegetation: 1.4, weatherFx: true },
};

const LLM_DEFAULT: LlmSettings = { enabled: false, endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1', apiKey: '', temperature: 0.8 };

export function defaultSettings(): GameSettings {
  return {
    graphics: { preset: 'high', ...GRAPHICS_PRESETS.high, fov: 70, maxFps: 0 },
    audio: { master: 0.8, music: 0.6, effects: 0.9, ambience: 0.7, voice: 0.9, ui: 0.6, musicStyle: 'adaptive' },
    controls: { mouseSensitivity: 1, invertY: false, toggleSprint: false, toggleCrouch: true, targetKey: 'Tab' },
    interface: { scale: 1, minimap: true, compass: true, damageNumbers: true, nameplateDistance: 38, narration: true, crosshair: 'dot' },
    llm: { ...LLM_DEFAULT },
    gmLlm: { ...LLM_DEFAULT },
  };
}

const KEY = 'norgo.settings';

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    const bv = out[k], ov = (over as Record<string, unknown>)[k];
    if (ov === undefined) continue;
    if (bv && typeof bv === 'object' && !Array.isArray(bv)) out[k] = merge(bv, ov);
    else if (typeof ov === typeof bv) out[k] = ov;
  }
  return out as T;
}

/** Read settings from storage (always returns a complete object). */
export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(defaultSettings(), JSON.parse(raw));
  } catch {
    /* storage unavailable or corrupt → defaults */
  }
  return defaultSettings();
}

type Listener = (s: GameSettings, section: keyof GameSettings) => void;

export class SettingsStore {
  private data: GameSettings = loadSettings();
  private listeners = new Set<Listener>();

  get(): GameSettings {
    return this.data;
  }

  /** Patch one section and persist. */
  update<K extends keyof GameSettings>(section: K, patch: Partial<GameSettings[K]>): void {
    this.data = { ...this.data, [section]: { ...this.data[section], ...patch } };
    if (section === 'graphics' && !('preset' in patch)) {
      // Any manual tweak that diverges from a preset marks the profile as custom.
      const g = this.data.graphics;
      const p = g.preset !== 'custom' ? GRAPHICS_PRESETS[g.preset] : null;
      if (p && (Object.keys(p) as (keyof typeof p)[]).some((k) => p[k] !== g[k])) this.data.graphics = { ...g, preset: 'custom' };
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* quota / private mode: settings remain in memory */
    }
    for (const l of [...this.listeners]) l(this.data, section);
  }

  applyPreset(p: Exclude<QualityPreset, 'custom'>): void {
    this.update('graphics', { preset: p, ...GRAPHICS_PRESETS[p] });
  }

  reset(section: keyof GameSettings): void {
    this.update(section, defaultSettings()[section] as never);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Process-wide settings store shared by menu and in-game UI. */
export const settingsStore = new SettingsStore();

export function applyInterfaceScale(root: HTMLElement, s: InterfaceSettings): void {
  root.style.setProperty('--ui-scale', String(s.scale));
}
