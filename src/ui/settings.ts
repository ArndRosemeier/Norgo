/**
 * Persistent player settings (localStorage `norgo.settings`). The UI edits them;
 * the client core reads them at startup (`loadSettings()`) and reacts to changes
 * through `UI.onGraphicsChange` / `UI.onSettingsChange` or `settingsStore.on`.
 */

import { budgets, type DeviceClass } from '../core/budgets';

/** Quality presets. 'tablet' is tuned for iPads/Android tablets (high-DPR, thermally limited). */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'tablet' | 'custom';

export interface GraphicsSettings {
  preset: QualityPreset;
  /** Internal resolution multiplier (0.5..1.5) relative to devicePixelRatio-capped size. */
  renderScale: number;
  /** Terrain/streaming view distance in meters. */
  viewDistance: number;
  shadows: 'off' | 'low' | 'high';
  bloom: boolean;
  antialias: boolean;
  /** Ground-cover density 0.25..1 (grass and small plants; applies to newly streamed terrain). */
  vegetation: number;
  /** Volumetric fog/weather particles. */
  weatherFx: boolean;
  /** Vertical field of view in degrees. */
  fov: number;
  /**
   * Cap framerate (0 = uncapped / vsync). Tablets default to 60 (ProMotion displays would
   * otherwise run at 120 Hz); 30 is the battery/thermal saver.
   */
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
  /** Set once the toggle switches took effect (migration marker, see loadSettings). */
  togglesLive?: boolean;
  /** KeyboardEvent.code that cycles tab targets (Shift + it cycles backwards). */
  targetKey: string;
}

// Key labels and which keys are taken live in the command registry (single source of truth).
export { keyLabel } from '../client/commands';

/** On-screen controls (touch devices). */
export interface TouchSettings {
  /** Touch look sensitivity multiplier (1 = default). Invert-Y follows `controls.invertY`. */
  lookSensitivity: number;
  /** Thumb-stick size multiplier 0.7..1.5. */
  stickSize: number;
  /** Mirror the layout: stick on the right, buttons on the left. */
  leftHanded: boolean;
  /** Opacity of the on-screen buttons 0.3..1. */
  opacity: number;
  /** Pushing the stick past its outer ring sprints. */
  sprintRing: boolean;
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
  touch: TouchSettings;
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
  ultra: { renderScale: 1.25, viewDistance: 2800, shadows: 'high', bloom: true, antialias: true, vegetation: 1, weatherFx: true },
  /*
   * Tablet: iPad-class GPUs on 2×-DPR screens. Render scale 0.75 of the 1.5-capped pixel ratio
   * (≈ 1.1 device px per CSS px: ~1.8 MP on a 12.9" iPad Pro, ~1.2 MP on an iPad Air) keeps
   * fill rate in check; medium-ish view distance and 1024² shadows; thinner ground cover
   * (vertex + overdraw cost on a tile-based GPU). Bloom and SMAA stay: cheap at this size.
   */
  tablet: { renderScale: 0.75, viewDistance: 1100, shadows: 'low', bloom: true, antialias: true, vegetation: 0.6, weatherFx: true },
};

/** Preset choices for the settings UI, in display order. */
export const PRESET_OPTIONS: { id: QualityPreset; label: string }[] = [
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'ultra', label: 'Ultra' },
  { id: 'tablet', label: 'Tablet' }, { id: 'custom', label: 'Custom' },
];

/**
 * Graphics defaults for this device (used on first run, and by "Restore defaults"):
 * tablets get the tablet profile with a 60 fps cap, phones 'low', desktops 'high' — or
 * 'medium' when the hardware hints are modest (≤ 4 cores or ≤ 4 GB).
 */
export function deviceGraphicsDefaults(c: DeviceClass = budgets.deviceClass): GraphicsSettings {
  const preset: Exclude<QualityPreset, 'custom'> = c === 'tablet' ? 'tablet' : c === 'phone' ? 'low' : c === 'desktop-low' ? 'medium' : 'high';
  return { preset, ...GRAPHICS_PRESETS[preset], fov: 70, maxFps: c === 'tablet' || c === 'phone' ? 60 : 0 };
}

const LLM_DEFAULT: LlmSettings = { enabled: false, endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1', apiKey: '', temperature: 0.8 };

export function defaultSettings(): GameSettings {
  return {
    graphics: deviceGraphicsDefaults(),
    audio: { master: 0.8, music: 0.6, effects: 0.9, ambience: 0.7, voice: 0.9, ui: 0.6, musicStyle: 'adaptive' },
    controls: { mouseSensitivity: 1, invertY: false, toggleSprint: false, toggleCrouch: false, targetKey: 'Tab' },
    touch: { lookSensitivity: 1, stickSize: 1, leftHanded: false, opacity: 0.85, sprintRing: true },
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
    if (raw) {
      const saved = JSON.parse(raw);
      const s = merge(defaultSettings(), saved);
      // "Toggle crouch" defaulted to on while it had no effect; now that it works, settings saved
      // before it did are reset to hold-to-crouch so nobody's controls change silently.
      if (!saved.controls?.togglesLive) s.controls.toggleCrouch = false;
      s.controls.togglesLive = true;
      // Vegetation used to go up to 1.5 (ultra 1.4) although only thinning exists: clamp old saves.
      s.graphics.vegetation = Math.min(1, Math.max(0.25, s.graphics.vegetation));
      if (!(s.graphics.preset in GRAPHICS_PRESETS) && s.graphics.preset !== 'custom') s.graphics.preset = 'custom';
      return s;
    }
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
