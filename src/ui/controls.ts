/**
 * UI access to the command registry (src/client/commands.ts) with the player's settings
 * applied: current key overrides (rebinds), key caps, and mode-aware "how do I do this"
 * chips for help texts — key caps with a mouse & keyboard, glyph + gesture text on touch.
 * HUD hints, the guide, the settings table and the pause menu all render through here.
 */
import { h } from './dom';
import { glyphSvg } from './icons';
import { settingsStore } from './settings';
import { COMMANDS, COMMAND_GROUPS, command, controlRows, keyMap, keysOf, keyParts, overridesFromControls, type BindingOverrides, type CommandId } from '../client/commands';
import { platform, type InputMode } from '../core/platform';

/** Key overrides from the persisted control settings. */
export function currentOverrides(): BindingOverrides {
  return overridesFromControls(settingsStore.get().controls);
}

/** Binding string → commands of one scope, with the current overrides. */
export function currentKeyMap(scope: 'game' | 'ui') {
  return keyMap(scope, currentOverrides());
}

/** Key caps for a command's primary binding (Shift + Tab → two caps). */
export function keyCaps(id: CommandId, cls = 'n-guide-kbd'): HTMLElement[] {
  const k = keysOf(id, currentOverrides())[0];
  if (!k) return [];
  return keyParts(k).flatMap((p, i) => (i ? ['+', h('kbd', { class: cls, text: p })] : [h('kbd', { class: cls, text: p })])) as HTMLElement[];
}

/**
 * How to perform a command in the current input mode, as inline content for help texts:
 * key caps (keyboard & mouse) or a glyph with the touch instruction.
 */
export function how(id: CommandId, cls = 'n-guide-kbd'): (HTMLElement | string)[] {
  const c = command(id);
  if (platform.inputMode === 'touch' && c.touch.method !== 'none') {
    return [h('span', { class: 'n-touch-chip', html: `${glyphSvg(c.glyph, 13)}<span>${c.touch.text}</span>` })];
  }
  return keyCaps(id, cls);
}

/** Plain-text variant of `how` for tooltips and notifications ("Tab", "the target button"). */
export function howText(id: CommandId): string {
  const c = command(id);
  if (platform.inputMode === 'touch' && c.touch.method !== 'none') return c.touch.text.charAt(0).toLowerCase() + c.touch.text.slice(1);
  const k = keysOf(id, currentOverrides())[0];
  return k ? keyParts(k).join('+') : c.short;
}

/** " (J)" after a feature name in mouse & keyboard mode; nothing on touch (buttons carry glyphs). */
export function keyHint(id: CommandId): string {
  if (platform.inputMode === 'touch') return '';
  const k = keysOf(id, currentOverrides())[0];
  return k ? ` (${keyParts(k).join('+')})` : '';
}

/** Key caps for one binding alternative (["Shift", "Tab"] → Shift + Tab). */
function caps(parts: string[]): HTMLElement[] {
  return parts.map((k) => (k === '…' ? h('span', { class: 'n-faint', text: '…' }) : h('span', { class: 'n-key', text: k })));
}

/**
 * Controls list for a mode: key caps for keyboard & mouse, gestures and buttons for touch.
 * Generated from the command registry (debug commands only with `debug`).
 */
export function controlsTable(mode: InputMode = platform.inputMode, opts: { debug?: boolean } = {}): HTMLElement {
  const rows = controlRows(currentOverrides(), { debug: opts.debug ?? mode === 'mouse' });
  const touch = mode === 'touch';
  return h('div', { class: `n-keybinds${touch ? ' touch' : ''}` },
    ...COMMAND_GROUPS.map((g) => {
      const list = rows.filter((r) => r.group === g && (!touch || r.touch.method !== 'none'));
      if (!list.length) return null;
      return h('div', { class: 'n-keybind-group' },
        h('div', { class: 'n-heading', text: g }),
        ...list.map((r) => h('div', { class: 'n-keybind' },
          h('span', { text: r.label }),
          touch
            ? h('span', { class: 'n-touch-how', html: `${glyphSvg(COMMANDS.find((c) => c.id === r.ids[0])!.glyph, 14)}<span>${r.touch.text}</span>` })
            : h('span', { class: 'n-keys' }, ...r.keys.flatMap((alt, i) => [...(i ? [h('span', { class: 'n-faint', text: '/' })] : []), ...caps(alt)])),
        )),
      );
    }),
  );
}
