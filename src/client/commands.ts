/**
 * Command registry: the single, declarative list of everything the player can do with
 * keyboard, mouse or touch. Every consumer derives from it:
 *
 *  - `Input` (src/client/input.ts) builds its key → action map from the `game` commands,
 *  - the UI (src/ui/UI.ts) dispatches the `ui` commands (panel toggles, guide, pause…),
 *  - Settings → Controls (key table + rebind rows), the pause menu's controls list, the
 *    welcome guide, HUD key hints and the README controls section (tools/commands-check.ts)
 *    render it,
 *  - the touch controls (src/ui/hud/touch.ts) build their buttons and menu bar from it.
 *
 * Adding a command here makes it show up everywhere; wire its effect in the client core
 * (`game` scope, Game.handleActions) or in `UI.runCommand` (`ui` scope).
 *
 * Binding strings: a `KeyboardEvent.code` ('KeyW', 'Space', 'Tab'), a mouse binding
 * ('Mouse0' left, 'Mouse2' right, 'MouseMove', 'Wheel'), optionally with a modifier
 * prefix ('Shift+Tab').
 *
 * Pure data + helpers: no DOM, safe to import from Node tools.
 */

/** Gameplay actions the client core reads from `Input` every frame. */
export type GameAction =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'walk' | 'interact'
  | 'attack' | 'block' | 'hot1' | 'hot2' | 'hot3' | 'hot4' | 'hot5' | 'hot6' | 'hot7' | 'hot8' | 'hot9' | 'hot0'
  | 'camera' | 'freecam' | 'target' | 'targetPrev';

/** Interface commands the UI dispatches (`UI.runCommand`). Panel commands share the panel's id. */
export type UiCommand = 'targetClear' | 'inventory' | 'skills' | 'journal' | 'map' | 'gm' | 'guide' | 'pause' | 'debug';

/** Camera axes driven by the pointer (described for help texts; read as look/zoom deltas). */
export type ViewCommand = 'look' | 'zoom';

export type CommandId = GameAction | UiCommand | ViewCommand;

export type CommandGroup = 'Movement' | 'Camera' | 'Combat' | 'Hotbar' | 'Interface';

/**
 * hold   – active while held (sprint, block, hotbar charge)
 * press  – fires once on press (interact, attack, target)
 * toggle – flips a state on each press (panels, first-person view)
 * axis   – continuous value (movement, look, zoom)
 */
export type CommandKind = 'hold' | 'press' | 'toggle' | 'axis';

/** How a command is offered on touch screens. */
export type TouchMethod =
  | 'stick'   // the floating thumb-stick (movement, walk = small push, sprint = outer ring)
  | 'drag'    // drag on free screen space (look)
  | 'pinch'   // two-finger pinch (zoom)
  | 'button'  // a button in the action cluster
  | 'hotbar'  // tap / hold a hotbar slot
  | 'menu'    // a button in the top menu bar
  | 'gesture' // a gesture on another control (see `touch.text`)
  | 'none';   // not available on touch

export interface TouchSpec {
  method: TouchMethod;
  /** How to do it on a touch screen (help texts). */
  text: string;
  /** Behaviour of the touch button when it differs from `kind` (crouch latches on touch). */
  kind?: CommandKind;
  /** `gesture` commands: performed on this command's button … */
  on?: CommandId;
  /** … with this gesture (a plain tap stays the button's own command). */
  gesture?: 'hold' | 'swipeLeft';
  /** `button` commands shown only while it makes sense: something in reach (`focus`). */
  when?: 'focus';
}

export interface CommandDef {
  id: CommandId;
  /** Full description ("Interact / talk / pick up"). */
  label: string;
  /** Short caption for buttons and compact lists. */
  short: string;
  /** Glyph name from src/ui/icons.ts. */
  glyph: string;
  group: CommandGroup;
  kind: CommandKind;
  /** Who handles it: the client core (`Input` action), the UI, or the camera (pointer axes). */
  scope: 'game' | 'ui' | 'view';
  /** Default bindings (see file comment). */
  keys: readonly string[];
  /** Rebindable: the ControlSettings field holding the player's key (KeyboardEvent.code). */
  rebind?: 'targetKey';
  /** Binding derived from another command's current key (Shift + target key = previous target). */
  follows?: { command: CommandId; modifier: 'Shift' };
  /** Commands sharing a row id are listed as one line (W A S D, 1 … 0). */
  row?: { id: string; label: string };
  touch: TouchSpec;
  /** Developer command: listed apart, never offered on touch. */
  debug?: boolean;
}

const hot = (n: number): CommandDef => ({
  id: `hot${n % 10}` as GameAction,
  label: `Hotbar slot ${n === 10 ? 10 : n}`,
  short: String(n % 10),
  glyph: 'star',
  group: 'Hotbar',
  kind: 'hold',
  scope: 'game',
  keys: [`Digit${n % 10}`],
  row: { id: 'hotbar', label: 'Hotbar abilities & items (hold to charge)' },
  touch: { method: 'hotbar', text: 'Tap a hotbar slot — hold it to charge' },
});

/** Every player command, in display order. */
export const COMMANDS: readonly CommandDef[] = [
  // Movement
  { id: 'forward', label: 'Move forward', short: 'Forward', glyph: 'footsteps', group: 'Movement', kind: 'axis', scope: 'game', keys: ['KeyW', 'ArrowUp'], row: { id: 'move', label: 'Move' }, touch: { method: 'stick', text: 'Thumb-stick on the left: push to walk, further to run' } },
  { id: 'left', label: 'Move left', short: 'Left', glyph: 'footsteps', group: 'Movement', kind: 'axis', scope: 'game', keys: ['KeyA', 'ArrowLeft'], row: { id: 'move', label: 'Move' }, touch: { method: 'stick', text: 'Thumb-stick on the left: push to walk, further to run' } },
  { id: 'back', label: 'Move back', short: 'Back', glyph: 'footsteps', group: 'Movement', kind: 'axis', scope: 'game', keys: ['KeyS', 'ArrowDown'], row: { id: 'move', label: 'Move' }, touch: { method: 'stick', text: 'Thumb-stick on the left: push to walk, further to run' } },
  { id: 'right', label: 'Move right', short: 'Right', glyph: 'footsteps', group: 'Movement', kind: 'axis', scope: 'game', keys: ['KeyD', 'ArrowRight'], row: { id: 'move', label: 'Move' }, touch: { method: 'stick', text: 'Thumb-stick on the left: push to walk, further to run' } },
  { id: 'jump', label: 'Jump / swim up', short: 'Jump', glyph: 'up', group: 'Movement', kind: 'hold', scope: 'game', keys: ['Space'], touch: { method: 'button', text: 'Jump button (hold to swim up)' } },
  { id: 'sprint', label: 'Sprint (with attack: heavy attack)', short: 'Sprint', glyph: 'wind', group: 'Movement', kind: 'hold', scope: 'game', keys: ['ShiftLeft', 'ShiftRight'], touch: { method: 'stick', text: 'Push the thumb-stick past its outer ring' } },
  { id: 'crouch', label: 'Crouch / sneak / dive', short: 'Sneak', glyph: 'down', group: 'Movement', kind: 'hold', scope: 'game', keys: ['KeyC', 'ControlLeft'], touch: { method: 'button', text: 'Sneak button (tap to toggle)', kind: 'toggle' } },
  { id: 'walk', label: 'Walk', short: 'Walk', glyph: 'footsteps', group: 'Movement', kind: 'hold', scope: 'game', keys: ['AltLeft'], touch: { method: 'stick', text: 'Push the thumb-stick only a little' } },
  { id: 'interact', label: 'Interact / talk / pick up', short: 'Use', glyph: 'hand', group: 'Movement', kind: 'press', scope: 'game', keys: ['KeyE', 'KeyF'], touch: { method: 'button', when: 'focus', text: 'Hand button — appears when something is in reach' } },
  // Camera
  { id: 'look', label: 'Look around', short: 'Look', glyph: 'eye', group: 'Camera', kind: 'axis', scope: 'view', keys: ['MouseMove'], touch: { method: 'drag', text: 'Drag anywhere on the right side' } },
  { id: 'zoom', label: 'Zoom (all the way in: first person)', short: 'Zoom', glyph: 'eye', group: 'Camera', kind: 'axis', scope: 'view', keys: ['Wheel'], touch: { method: 'pinch', text: 'Pinch with two fingers' } },
  { id: 'camera', label: 'First / third person', short: 'View', glyph: 'cam', group: 'Camera', kind: 'toggle', scope: 'game', keys: ['KeyV'], touch: { method: 'button', text: 'View button (figure icon)' } },
  { id: 'freecam', label: 'Free camera', short: 'Free cam', glyph: 'eye', group: 'Camera', kind: 'toggle', scope: 'game', keys: ['F8'], debug: true, touch: { method: 'none', text: '' } },
  // Combat
  { id: 'attack', label: 'Attack / use tool (dig, chop, mine)', short: 'Attack', glyph: 'sword', group: 'Combat', kind: 'press', scope: 'game', keys: ['Mouse0'], touch: { method: 'button', text: 'Sword button' } },
  { id: 'block', label: 'Block', short: 'Block', glyph: 'shield', group: 'Combat', kind: 'hold', scope: 'game', keys: ['Mouse2'], touch: { method: 'button', text: 'Shield button (hold)' } },
  { id: 'target', label: 'Next target (attacks & spells aim at it)', short: 'Target', glyph: 'reticle', group: 'Combat', kind: 'press', scope: 'game', keys: ['Tab'], rebind: 'targetKey', touch: { method: 'button', text: 'Target button: tap for the next target' } },
  { id: 'targetPrev', label: 'Previous target', short: 'Previous', glyph: 'reticle', group: 'Combat', kind: 'press', scope: 'game', keys: ['Shift+Tab'], follows: { command: 'target', modifier: 'Shift' }, touch: { method: 'gesture', on: 'target', gesture: 'swipeLeft', text: 'Swipe left on the target button' } },
  { id: 'targetClear', label: 'Clear target', short: 'Clear', glyph: 'reticle', group: 'Combat', kind: 'press', scope: 'ui', keys: ['Escape'], touch: { method: 'gesture', on: 'target', gesture: 'hold', text: 'Hold the target button' } },
  // Hotbar
  hot(1), hot(2), hot(3), hot(4), hot(5), hot(6), hot(7), hot(8), hot(9), hot(10),
  // Interface
  { id: 'inventory', label: 'Inventory & equipment', short: 'Bag', glyph: 'bag', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['KeyI'], touch: { method: 'menu', text: 'Bag button (top left)' } },
  { id: 'skills', label: 'Skills & abilities', short: 'Skills', glyph: 'star', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['KeyK'], touch: { method: 'menu', text: 'Star button (top left)' } },
  { id: 'journal', label: 'Journal & quests', short: 'Journal', glyph: 'scroll', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['KeyJ'], touch: { method: 'menu', text: 'Scroll button (top left)' } },
  { id: 'map', label: 'World map', short: 'Map', glyph: 'mountain', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['KeyM'], touch: { method: 'menu', text: 'Mountain button (top left)' } },
  { id: 'gm', label: 'Ask the Game Master', short: 'Ask', glyph: 'speech', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['KeyG'], touch: { method: 'menu', text: 'Speech button (top left)' } },
  { id: 'guide', label: 'Welcome guide', short: 'Guide', glyph: 'book', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['KeyH'], touch: { method: 'menu', text: 'Book button (top left)' } },
  { id: 'pause', label: 'Pause / close panel', short: 'Menu', glyph: 'menu', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['Escape'], touch: { method: 'menu', text: 'Menu button (top left); panels close with ✕' } },
  { id: 'debug', label: 'Debug overlay', short: 'Debug', glyph: 'rune', group: 'Interface', kind: 'toggle', scope: 'ui', keys: ['F3'], debug: true, touch: { method: 'none', text: '' } },
];

export const COMMAND_GROUPS: readonly CommandGroup[] = ['Movement', 'Camera', 'Combat', 'Hotbar', 'Interface'];

const BY_ID = new Map<CommandId, CommandDef>(COMMANDS.map((c) => [c.id, c]));

export function command(id: CommandId): CommandDef {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown command ${id}`);
  return c;
}

/** The ten hotbar actions in slot order (slot 0 = key 1 … slot 9 = key 0). */
export const HOTBAR_ACTIONS: readonly GameAction[] = ['hot1', 'hot2', 'hot3', 'hot4', 'hot5', 'hot6', 'hot7', 'hot8', 'hot9', 'hot0'];

/** Hotbar slot index of an action (-1 if it is not a hotbar action). */
export function hotbarSlot(id: CommandId): number {
  return HOTBAR_ACTIONS.indexOf(id as GameAction);
}

// ------------------------------------------------------------------ bindings

/** Player key overrides for rebindable commands (command id → KeyboardEvent.code). */
export type BindingOverrides = Partial<Record<CommandId, string>>;

/** Overrides from the persisted control settings (`controls.targetKey` …). */
export function overridesFromControls(controls: object): BindingOverrides {
  const out: BindingOverrides = {};
  for (const c of COMMANDS) {
    if (!c.rebind) continue;
    const v = (controls as Record<string, unknown>)[c.rebind];
    if (typeof v === 'string' && v) out[c.id] = v;
  }
  return out;
}

/**
 * Current bindings of a command. A rebindable command uses the override when it is valid
 * (not owned by another command), otherwise its defaults; derived commands follow their source.
 */
export function keysOf(id: CommandId, over: BindingOverrides = {}): string[] {
  const c = command(id);
  if (c.follows) return keysOf(c.follows.command, over).map((k) => `${c.follows!.modifier}+${k}`);
  const o = over[id];
  if (c.rebind && o && isFreeFor(o, id)) return [o];
  return [...c.keys];
}

/** Commands whose *default* bindings include this binding string. */
function defaultOwners(binding: string): CommandDef[] {
  return COMMANDS.filter((c) => c.keys.includes(binding));
}

/** Can `code` be given to command `id` (nothing else uses it by default)? */
export function isFreeFor(code: string, id: CommandId): boolean {
  return defaultOwners(code).every((c) => c.id === id || c.follows?.command === id);
}

/** Which command (other than `id`) already uses `code` — for "already used by …" messages. */
export function keyConflict(code: string, id: CommandId): CommandDef | null {
  return defaultOwners(code).find((c) => c.id !== id && c.follows?.command !== id) ?? null;
}

/** Binding string → commands, for one scope, with the player's overrides applied. */
export function keyMap(scope: CommandDef['scope'], over: BindingOverrides = {}): Map<string, CommandId[]> {
  const m = new Map<string, CommandId[]>();
  for (const c of COMMANDS) {
    if (c.scope !== scope) continue;
    for (const k of keysOf(c.id, over)) {
      const list = m.get(k);
      if (list) list.push(c.id);
      else m.set(k, [c.id]);
    }
  }
  return m;
}

/** Binding string for a key event ('Shift+Tab' when Shift is held, else the code). */
export function bindingOfEvent(e: { code: string; shiftKey: boolean }, map: Map<string, unknown>): string {
  if (e.shiftKey && !e.code.startsWith('Shift')) {
    const s = `Shift+${e.code}`;
    if (map.has(s)) return s;
  }
  return e.code;
}

// ------------------------------------------------------------------ labels

const NAMED: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps', Backspace: 'Bksp', Enter: 'Enter', Tab: 'Tab', IntlBackslash: '<',
  ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', AltRight: 'AltGr',
  Insert: 'Ins', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
  Escape: 'Esc', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', MouseMove: 'Mouse', Wheel: 'Wheel',
};

/** Short human label for a binding ("KeyT" → "T", "Digit4" → "4", "Shift+Tab" → "Shift+Tab", "Mouse0" → "LMB"). */
export function keyLabel(code: string): string {
  const plus = code.indexOf('+', 1);
  if (plus > 0) return `${code.slice(0, plus)}+${keyLabel(code.slice(plus + 1))}`;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
  return NAMED[code] ?? code;
}

/** Label parts of a binding (["Shift", "Tab"]) for rendering as separate key caps. */
export function keyParts(binding: string): string[] {
  const plus = binding.indexOf('+', 1);
  if (plus > 0) return [binding.slice(0, plus), keyLabel(binding.slice(plus + 1))];
  return [keyLabel(binding)];
}

/** Primary key label of a command ("E", "Tab", "LMB"). */
export function primaryKey(id: CommandId, over: BindingOverrides = {}): string {
  const k = keysOf(id, over)[0];
  return k ? keyLabel(k) : '';
}

export interface ControlRow {
  /** Commands on this row (one, or several merged by `row`). */
  ids: CommandId[];
  label: string;
  group: CommandGroup;
  /**
   * Key alternatives (E / F), each a list of caps shown side by side: a combination
   * (Shift Tab), a merged set (W A S D) or a range with '…' (1 … 0).
   */
  keys: string[][];
  touch: TouchSpec;
}

/**
 * Rows for control tables and help texts: merged rows (WASD, 1 … 0) and one row per other
 * command. Debug commands are included only when asked for.
 */
export function controlRows(over: BindingOverrides = {}, opts: { debug?: boolean } = {}): ControlRow[] {
  const rows: ControlRow[] = [];
  const merged = new Map<string, ControlRow>();
  for (const c of COMMANDS) {
    if (c.debug && !opts.debug) continue;
    const keys = keysOf(c.id, over);
    if (c.row) {
      const r = merged.get(c.row.id);
      if (r) {
        r.ids.push(c.id);
        r.keys[0].push(keyLabel(keys[0]));
        continue;
      }
      const row: ControlRow = { ids: [c.id], label: c.row.label, group: c.group, keys: [[keyLabel(keys[0])]], touch: c.touch };
      merged.set(c.row.id, row);
      rows.push(row);
      continue;
    }
    rows.push({ ids: [c.id], label: c.label, group: c.group, keys: keys.map(keyParts), touch: c.touch });
  }
  // Long merged rows read better as a range: 1 … 0.
  for (const r of merged.values()) {
    const k = r.keys[0];
    if (k.length > 4) r.keys = [[k[0], '…', k[k.length - 1]]];
  }
  return rows;
}
