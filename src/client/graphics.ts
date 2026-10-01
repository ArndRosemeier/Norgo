/**
 * Graphics settings → engine: the one place that maps the player-facing quality settings
 * (`src/ui/settings.ts`, presets incl. the device profile) onto renderer, terrain streamer,
 * environment and module knobs. Used by the Game and by the `?diag` benchmark, so the
 * benchmark measures exactly what a preset does in game.
 */
import { clamp } from '../core/math';
import { budgets } from '../core/budgets';
import type { RenderCore } from '../render/renderCore';
import type { Environment } from '../render/environment';
import type { TerrainStreamer } from '../world/streamer';
import type { GraphicsSettings } from '../ui/settings';

export interface GraphicsTargets {
  core: RenderCore;
  streamer: TerrainStreamer;
  env: Environment;
  /** Element the canvas fills (for resizing). */
  container: HTMLElement;
}

/** Apply graphics settings; cheap when nothing changed (only differing knobs are touched). */
export function applyGraphicsSettings(g: GraphicsSettings, t: GraphicsTargets): void {
  const vd = g.viewDistance;
  const so = t.streamer.opts;
  so.splitFactor = clamp((vd / 1800) * 1.6, 1.15, 2.2);
  so.rootRadius = vd < 900 ? 1 : vd < 2200 ? 2 : 3;
  so.shadowLod = g.shadows === 'high' ? 3 : 2;
  // Shorter view distances hide the streaming edge with denser fog.
  t.env.fogScale = clamp(1800 / vd, 0.7, 2.5);
  // Render scale is relative to the device pixel ratio, capped per device class.
  const base = Math.min(window.devicePixelRatio || 1, budgets.maxPixelRatio);
  const next = { pixelRatio: base * g.renderScale, bloom: g.bloom, antialias: g.antialias, shadows: g.shadows !== 'off', viewDistance: so.splitFactor };
  const cur = t.core.settings;
  // Read live by FloraSystem (newly streamed chunks) and the weather FX (every frame).
  cur.vegetation = clamp(g.vegetation, 0.25, 1);
  cur.weatherFx = g.weatherFx;
  if (cur.pixelRatio !== next.pixelRatio || cur.bloom !== next.bloom || cur.antialias !== next.antialias || cur.shadows !== next.shadows) {
    t.core.updateSettings(next, t.container);
  }
  const ms = g.shadows === 'high' ? 2048 : 1024;
  const shadow = t.env.sun.shadow;
  if (shadow.mapSize.x !== ms) {
    shadow.mapSize.set(ms, ms);
    shadow.map?.dispose();
    (shadow as { map: unknown }).map = null;
  }
}
