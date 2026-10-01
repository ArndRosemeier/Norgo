/**
 * In-game UI module (ClientModule). Owns all DOM overlays: HUD (vitals, hotbar,
 * compass, minimap, status, effects, crosshair/prompt, quest tracker, feeds),
 * world-anchored nameplates & floating numbers, the death screen, the F3 debug
 * overlay and every panel (inventory, skills, journal, map, Game Master,
 * dialog, trade, crafting, settings, pause). Panel toggles are handled here;
 * movement/combat/hotbar activation stay in the client core.
 *
 * Core integration:
 *   ui.isOpen()                       true while a mouse-capturing panel is open
 *   ui.setDebugInfo(lines)            F3 overlay content
 *   ui.onGraphicsChange(cb)           graphics settings (called immediately + on change)
 *   ui.onSettingsChange(cb)           full settings (audio, controls, interface…)
 *   ui.onQuit = () => …               "Quit to title" (default: reload the page)
 *   ui.open(panel, data) / ui.close() programmatic control (also via ctx.events 'uiOpen')
 */
import './styles/base.css';
import './styles/hud.css';
import './styles/panels.css';
import './styles/touch.css';
import type { ClientContext, ClientModule, TargetInfo } from '../client/context';
import { bindingOfEvent, hotbarSlot, type CommandId, type UiCommand } from '../client/commands';
import { platform } from '../core/platform';
import { currentKeyMap, keyHint } from './controls';
import { TouchControls } from './hud/touch';
import './gestures';
import type { HumanoidAppearance } from '../humanoid/types';
import type { GameEvent, PlayerState, ServerMessage } from '../shared/protocol';
import type { GmMessage, QuestView } from '../gm/types';
import type { Vec3 } from '../shared/types';
import { h, isTyping } from './dom';
import { closeContextMenu, tooltip } from './widgets';
import { Panel, type PanelId, type UiHost } from './host';
import { settingsStore, applyInterfaceScale, type GameSettings, type GraphicsSettings, type LlmSettings } from './settings';
import { loadItemData, raceDef } from './data';
import { Vitals, Hotbar, EffectsBar, StatusCluster, Crosshair, QuestTracker } from './hud/hud';
import { Compass } from './hud/compass';
import { Notifications, Banners, XpFeed, AreaToast, Narration } from './hud/feed';
import { Nameplates, FloatingNumbers } from './hud/world';
import { DeathScreen, DebugOverlay } from './hud/overlays';
import { WelcomeGuide } from './hud/welcome';
import { TargetFrame } from './hud/target';
import { Minimap } from './map/Minimap';
import { WorldMapPanel } from './map/WorldMapPanel';
import { acquireMapRenderer, releaseMapRenderer, type MapRenderer } from './map/MapRenderer';
import { InventoryPanel } from './panels/InventoryPanel';
import { SkillsPanel } from './panels/SkillsPanel';
import { DialogPanel } from './panels/DialogPanel';
import { TradePanel } from './panels/TradePanel';
import { CraftingPanel } from './panels/CraftingPanel';
import { JournalPanel } from './panels/JournalPanel';
import { GmPanel, SettingsPanel, PausePanel } from './panels/MiscPanels';
import { writeSave, findSaveKeyByData, seedTextFromKey, saveKey } from './saves';
import { BIOMES } from './../world/biomes';
import { UNDERWORLD_CEIL } from '../world/constants';
import { SITE_LABEL, POI_LABEL } from './map/markers';
import type { PoiKind } from '../world/sites';
import type { RaceId } from '../humanoid/types';
import { skillOrStub } from './data';

export interface NewGameChoice {
  seed: string;
  name: string;
  appearance: HumanoidAppearance;
  /** Serialized save to continue, if any. */
  save?: string;
}

export type { GameSettings, GraphicsSettings } from './settings';
export { loadSettings, settingsStore } from './settings';

const STATION_RE = /craft|forge|anvil|smith|workbench|bench|alchemy|loom|cook|kitchen|tannery|kiln|cauldron|furnace|altar/i;

/** Map an interaction label onto the items module's station ids. */
function stationOf(label: string): string {
  const l = label.toLowerCase();
  if (/forge|anvil|smith|furnace|smelt/.test(l)) return 'forge';
  if (/alchem|cauldron|brew/.test(l)) return 'alchemy';
  if (/loom|weav|tannery/.test(l)) return 'loom';
  if (/fire|cook|kitchen|hearth|oven|kiln/.test(l)) return 'fire';
  return 'workbench';
}

export class UI implements ClientModule, UiHost {
  readonly name = 'ui';
  ctx!: ClientContext;
  /** Called by "Quit to title" after saving. Override from the core. */
  onQuit: () => void = () => location.assign(location.pathname);

  trackedQuest: string | null = null;
  waypoint: Vec3 | null = null;

  private root!: HTMLElement;
  private renderer!: MapRenderer;
  private panels = new Map<PanelId, Panel>();
  private active: Panel | null = null;
  private stack: PanelId[] = [];
  private offs: (() => void)[] = [];
  private graphicsCbs = new Set<(g: GraphicsSettings) => void>();
  private settingsCbs = new Set<(s: GameSettings) => void>();

  private vitals!: Vitals;
  private hotbar!: Hotbar;
  private effects!: EffectsBar;
  private status!: StatusCluster;
  private crosshair!: Crosshair;
  private tracker!: QuestTracker;
  private compass!: Compass;
  private minimap!: Minimap;
  private notes!: Notifications;
  private banners!: Banners;
  private xp!: XpFeed;
  private area!: AreaToast;
  private narration!: Narration;
  private plates!: Nameplates;
  private floaters!: FloatingNumbers;
  private death!: DeathScreen;
  private guide!: WelcomeGuide;
  private targetFrame!: TargetFrame;
  /** Current tab target (kept in sync by ClientEvents.target). */
  private target: TargetInfo | null = null;
  /** When Esc last cleared the target instead of pausing (pointer-lock release follows it). */
  private escClearedAt = -1e9;
  private escHints = 0;
  private debug!: DebugOverlay;
  private hudEl!: HTMLElement;
  private touch!: TouchControls;
  /** Key bindings from the command registry (rebuilt when the settings change). */
  private uiKeys = new Map<string, CommandId[]>();
  private gameKeys = new Map<string, CommandId[]>();

  private dialog!: DialogPanel;
  private trade!: TradePanel;
  private gm!: GmPanel;
  private map!: WorldMapPanel;

  private serverTimeSeen = 0;
  private serverWall = 0;
  private areaT = 0;
  private lastSite: string | null = null;
  private biomeCandidate = '';
  private biomeStable = '';
  private biomeHits = 0;
  private knownQuests = new Map<string, string>();
  private knownDiscoveries = new Set<string>();
  private questsPrimed = false;
  private lastKiller: string | undefined;
  private pointerWasLocked = false;
  private pendingQuit = false;
  private initialized = false;

  // ---------------------------------------------------------------- public API

  /** True while a panel that needs the mouse is open (gameplay input suspended). */
  isOpen(): boolean {
    return !!this.active && this.active.captures;
  }

  /** Lines for the F3 overlay (fps, position, biome, chunk stats…). */
  setDebugInfo(lines: string[]): void {
    this.debug?.set(lines);
  }

  /** Register for graphics settings; called immediately with the current values. */
  onGraphicsChange(cb: (g: GraphicsSettings) => void): () => void {
    this.graphicsCbs.add(cb);
    cb(settingsStore.get().graphics);
    return () => this.graphicsCbs.delete(cb);
  }

  /** Register for any settings change; called immediately. */
  onSettingsChange(cb: (s: GameSettings) => void): () => void {
    this.settingsCbs.add(cb);
    cb(settingsStore.get());
    return () => this.settingsCbs.delete(cb);
  }

  getSettings(): GameSettings {
    return settingsStore.get();
  }

  // ---------------------------------------------------------------- UiHost

  open(id: PanelId, data?: unknown): void {
    const p = this.panels.get(id);
    if (!p) return;
    if (this.active === p) {
      p.reopen(data);
      return;
    }
    if (this.active) {
      // Panels opened from the pause menu (or trade from dialog) return there on close.
      if (this.active.id === 'pause' || (this.active.id === 'dialog' && id === 'trade')) this.stack.push(this.active.id);
      if (this.active.id === 'dialog' && id === 'trade') this.dialog.suspend();
      this.active.hide();
    }
    this.active = p;
    p.show(data);
    this.root.dataset.panel = id;
    if (p.captures) {
      tooltip.hide();
      this.ctx.setUiCapture(true);
      if (document.pointerLockElement) document.exitPointerLock();
    }
    this.sound('ui.open');
  }

  close(id?: PanelId): void {
    const p = this.active;
    if (!p || (id && p.id !== id)) {
      if (id) this.panels.get(id)?.hide();
      return;
    }
    p.hide();
    this.active = null;
    delete this.root.dataset.panel;
    tooltip.hide();
    closeContextMenu();
    const back = this.stack.pop();
    if (back === 'dialog' && this.dialog.view && !this.dialog.view.ended) {
      this.dialog.resume();
      this.open('dialog');
      return;
    }
    if (back === 'pause') {
      this.open('pause');
      return;
    }
    this.stack = [];
    if (back === 'dialog') this.dialog.endSuspended();
    this.ctx.setUiCapture(false);
    this.sound('ui.close');
  }

  toggle(id: PanelId): void {
    if (this.active?.id === id) this.close(id);
    else this.open(id);
  }

  isPanelOpen(id: PanelId): boolean {
    return this.active?.id === id;
  }

  notify(text: string, tone: 'info' | 'good' | 'bad' | 'warn' = 'info', icon?: string): void {
    this.notes?.push(text, tone, icon);
  }

  sound(name: string): void {
    try {
      this.ctx.audio.play(name);
    } catch {
      /* audio optional */
    }
  }

  setTrackedQuest(id: string | null): void {
    this.trackedQuest = id;
    this.persist('track', id);
    this.tracker?.refresh();
  }

  setWaypoint(p: Vec3 | null): void {
    this.waypoint = p;
    this.persist('waypoint', p);
  }

  serverNow(): number {
    const st = this.ctx.state.serverTime;
    const now = performance.now();
    if (st !== this.serverTimeSeen) {
      this.serverTimeSeen = st;
      this.serverWall = now;
    }
    return st + Math.min(0.5, (now - this.serverWall) / 1000);
  }

  // ---------------------------------------------------------------- lifecycle

  init(ctx: ClientContext): void {
    this.ctx = ctx;
    this.trackedQuest = this.restore<string>('track');
    this.waypoint = this.restore<Vec3>('waypoint');
    this.root = h('div', { class: 'nui' });
    ctx.uiRoot.appendChild(this.root);
    this.renderer = acquireMapRenderer(ctx.seed);

    // HUD
    this.vitals = new Vitals(this);
    this.hotbar = new Hotbar(this);
    this.effects = new EffectsBar(this);
    this.status = new StatusCluster(this);
    this.crosshair = new Crosshair(this);
    this.tracker = new QuestTracker(this);
    this.compass = new Compass(this);
    this.minimap = new Minimap(this, this.renderer);
    this.notes = new Notifications();
    this.banners = new Banners();
    this.xp = new XpFeed(this);
    this.area = new AreaToast();
    this.narration = new Narration();
    this.plates = new Nameplates(this);
    this.floaters = new FloatingNumbers(this);
    this.death = new DeathScreen(this);
    this.guide = new WelcomeGuide(ctx);
    this.targetFrame = new TargetFrame(this);
    this.debug = new DebugOverlay(() => [`ui map tiles pending ${this.renderer.pending}`, `ui panel ${this.active?.id ?? '-'}`]);
    this.touch = new TouchControls(this);

    this.hudEl = h('div', { class: 'n-hud' },
      // First child: the touch layer sits under every other HUD element.
      this.touch.el,
      this.plates.el,
      this.floaters.el,
      this.vitals.hurtOverlay,
      h('div', { class: 'n-top' }, this.compass.el, this.targetFrame.el, this.narration.el),
      h('div', { class: 'n-tr' }, this.minimap.el, this.status.el, this.tracker.el),
      h('div', { class: 'n-bl' }, this.effects.el, this.vitals.el),
      h('div', { class: 'n-bc' }, this.xp.el, this.hotbar.el),
      this.notes.el,
      this.crosshair.el,
      this.area.el,
      this.banners.el,
      this.guide.el,
    );
    this.root.append(this.hudEl);

    // Panels
    this.dialog = new DialogPanel(this);
    this.trade = new TradePanel(this);
    this.gm = new GmPanel(this);
    this.map = new WorldMapPanel(this, this.renderer);
    const all: Panel[] = [
      new InventoryPanel(this), new SkillsPanel(this), new JournalPanel(this), this.map, this.gm, this.dialog, this.trade, new CraftingPanel(this),
      new SettingsPanel(this, (w, cfg) => this.applyLlm(w, cfg)),
      new PausePanel(this, { save: () => this.save(), quit: () => this.quit() }),
    ];
    for (const p of all) {
      this.panels.set(p.id, p);
      this.root.append(p.root);
    }
    this.root.append(this.death.el, this.debug.el);

    this.bindEvents();
    this.applySettings(settingsStore.get());
    this.offs.push(settingsStore.on((s, section) => {
      this.applySettings(s);
      if (section === 'graphics') for (const cb of this.graphicsCbs) cb(s.graphics);
      for (const cb of this.settingsCbs) cb(s);
    }));
    // Push stored LLM configuration to the (fresh) server.
    const s = settingsStore.get();
    if (s.llm.enabled) this.applyLlm('llm', s.llm);
    if (s.gmLlm.enabled) this.applyLlm('gmLlm', s.gmLlm);
    loadItemData().then(() => {
      if (this.ctx.state.player) this.onPlayer(this.ctx.state.player);
    });
    if (ctx.state.player) this.onPlayer(ctx.state.player);
    this.initialized = true;
  }

  private bindEvents() {
    const ev = this.ctx.events;
    this.offs.push(
      ev.on('playerState', (p) => this.onPlayer(p)),
      ev.on('gameEvent', (e) => this.onGameEvent(e)),
      ev.on('dialog', (v) => {
        this.dialog.setView(v);
        if (!v.ended || this.isPanelOpen('dialog')) {
          if (!this.isPanelOpen('trade')) this.open('dialog');
        }
      }),
      ev.on('gm', (msgs) => this.onGm(msgs)),
      ev.on('trade', (m) => {
        this.trade.setTrade(m);
        if (!this.isPanelOpen('trade')) this.open('trade');
      }),
      ev.on('focus', (f) => {
        this.crosshair.setFocus(f);
        this.touch.setFocus(f);
      }),
      ev.on('target', (t) => {
        this.target = t;
        this.targetFrame.set(t);
        this.touch.setTarget(t);
        this.plates.targetId = t?.id ?? null;
      }),
      // Help texts and key hints follow the input mode (keys ↔ touch gestures).
      platform.onInputMode(() => {
        this.guide.render();
        this.crosshair.setFocus(this.crosshair.current);
        this.targetFrame.refreshHint();
      }),
      ev.on('notify', (n) => this.notify(n.text, n.tone)),
      ev.on('uiOpen', ({ panel, data }) => this.onUiOpen(panel, data)),
      ev.on('serverMessage', (m) => this.onServerMessage(m)),
    );
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    const onLock = () => {
      const locked = !!document.pointerLockElement;
      const lost = this.pointerWasLocked && !locked;
      this.pointerWasLocked = locked;
      if (!lost || this.active || this.death.shown) return;
      // Esc already handled as "clear target" (keydown arrived first) → no pause menu.
      if (performance.now() - this.escClearedAt < 700) return;
      if (!this.target) {
        // Pointer lock lost by the browser (Esc) while playing → pause menu.
        this.open('pause');
        return;
      }
      // Browsers release the pointer on Esc and often swallow the key itself. With a tab target
      // that Esc means "clear the target" — unless the window lost focus (alt-tab etc.).
      setTimeout(() => {
        if (this.active || this.death.shown || document.pointerLockElement) return;
        if (performance.now() - this.escClearedAt < 700) return;
        if (!document.hasFocus() || document.hidden || !this.target) this.open('pause');
        else this.clearTargetByEsc();
      }, 80);
    };
    document.addEventListener('pointerlockchange', onLock);
    this.offs.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      document.removeEventListener('pointerlockchange', onLock);
    });
  }

  /** Keyboard → interface commands, all bindings from the command registry. */
  private onKey(e: KeyboardEvent) {
    if (!this.initialized) return;
    if (document.querySelector('.n-modal-back')) return;
    const down = e.type === 'keydown';
    const cmds = this.uiKeys.get(e.code) ?? [];
    if (cmds.includes('pause')) {
      if (!down) return;
      if (closeContextMenu()) return;
      // With a tab target, the first Esc clears it; the next one pauses as usual.
      if (cmds.includes('targetClear') && !this.active && this.target && !this.death.shown && !e.repeat) {
        this.clearTargetByEsc();
        e.preventDefault();
        return;
      }
      // A held Esc that just cleared the target must not go on to open the pause menu.
      if (e.repeat && performance.now() - this.escClearedAt < 1500) return;
      this.runCommand('pause');
      e.preventDefault();
      return;
    }
    if (isTyping(e)) return;
    if (this.active && this.active.onKey(e)) {
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (cmds.includes('debug')) {
      this.debug.toggle();
      e.preventDefault();
      return;
    }
    if (e.repeat) return;
    const cmd = cmds[0] as UiCommand | undefined;
    if (cmd) {
      this.runCommand(cmd);
      return;
    }
    const slot = hotbarSlot(this.gameKeys.get(bindingOfEvent(e, this.gameKeys))?.[0] ?? 'look');
    if (!this.active && slot >= 0) this.hotbar.flash(slot);
  }

  /** Run an interface command (keyboard, touch menu bar, touch gestures). */
  runCommand(id: UiCommand): void {
    switch (id) {
      case 'targetClear':
        this.ctx.events.emit('targetRequest', { op: 'clear' });
        return;
      case 'pause':
        if (this.active) this.close();
        else if (!this.death.shown) this.open('pause');
        return;
      case 'debug':
        this.debug.toggle();
        return;
      case 'guide':
        if (!this.death.shown) this.guide.toggle();
        return;
      default:
        if (this.death.shown) return;
        // Gameplay keys should not toggle from inside text-heavy panels.
        if (this.active?.id === 'dialog' && id !== 'inventory') return;
        this.toggle(id);
    }
  }

  private clearTargetByEsc() {
    this.escClearedAt = performance.now();
    this.ctx.events.emit('targetRequest', { op: 'clear' });
    // The browser also released the mouse on that Esc: say how to get it back (first few times).
    setTimeout(() => {
      if (document.pointerLockElement || this.active || this.death.shown || this.escHints >= 3) return;
      this.escHints++;
      this.notify('Target cleared — click to take control again', 'info');
    }, 200);
  }

  private onUiOpen(panel: string, data: unknown) {
    if (panel === 'guide') {
      this.guide.show();
      return;
    }
    if (panel === 'interactObject') {
      // The core reports every object interaction; crafting stations open the crafting panel.
      const c = data as { interact?: string } | undefined;
      const label = c?.interact ?? '';
      if (STATION_RE.test(label)) this.open('crafting', { station: stationOf(label) });
      return;
    }
    if (panel === 'death') {
      this.death.show();
      return;
    }
    if (this.panels.has(panel as PanelId)) this.open(panel as PanelId, data);
  }

  private onServerMessage(m: ServerMessage) {
    if (m.t === 'world') this.status.weatherState = m.weather;
    else if (m.t === 'saved') this.onSaved(m.data);
    else if (m.t === 'error') this.notify(m.message, 'bad');
  }

  // ---------------------------------------------------------------- player state

  private onPlayer(p: PlayerState) {
    if (!p) return;
    this.hotbar.refresh(p);
    this.effects.refresh(p);
    this.checkJournal(p);
    this.tracker.refresh();
    for (const id of ['inventory', 'skills', 'journal', 'crafting'] as const) (this.panels.get(id) as unknown as { refresh?(): void })?.refresh?.();
    this.trade.refresh();
    if (p.hp <= 0) this.death.show(this.lastKiller);
    else if (this.death.shown) {
      this.death.hide();
      this.lastKiller = undefined;
    }
  }

  private checkJournal(p: PlayerState) {
    const j = p.journal;
    if (!j) return;
    const quests = j.quests ?? [];
    // The server is authoritative for tracking when it reports it.
    const serverTracked = quests.find((q) => q.tracked && q.status === 'active');
    if (serverTracked && serverTracked.id !== this.trackedQuest) this.setTrackedQuest(serverTracked.id);
    if (!this.questsPrimed) {
      for (const q of quests) this.knownQuests.set(q.id, q.status);
      for (const d of j.discoveries ?? []) this.knownDiscoveries.add(d.id);
      this.questsPrimed = true;
      if (!this.trackedQuest) this.autoTrack(quests);
      return;
    }
    for (const q of quests) {
      const prev = this.knownQuests.get(q.id);
      if (prev === q.status) continue;
      this.knownQuests.set(q.id, q.status);
      if (!prev && (q.status === 'active' || q.status === 'offered')) {
        this.banners.show('quest', q.title, q.status === 'offered' ? `A new quest is offered — see your journal${keyHint('journal')}` : 'New quest');
        this.sound('ui.quest');
        if (q.status === 'active' && !this.trackedQuest) this.setTrackedQuest(q.id);
      } else if (q.status === 'active' && prev === 'offered') {
        if (!this.trackedQuest) this.setTrackedQuest(q.id);
      } else if (q.status === 'completed') {
        this.banners.show('quest', q.title, 'Quest complete');
        this.sound('ui.questComplete');
        if (this.trackedQuest === q.id) this.autoTrack(quests.filter((x) => x.id !== q.id));
      } else if (q.status === 'failed') {
        this.notify(`Quest failed: ${q.title}`, 'bad');
        if (this.trackedQuest === q.id) this.autoTrack(quests.filter((x) => x.id !== q.id));
      }
    }
    for (const d of j.discoveries ?? []) {
      if (this.knownDiscoveries.has(d.id)) continue;
      this.knownDiscoveries.add(d.id);
      this.banners.show('discover', d.name, POI_LABEL[d.kind as PoiKind] ?? d.kind);
      this.sound('ui.discover');
    }
  }

  private autoTrack(quests: QuestView[]) {
    const next = quests.find((q) => q.status === 'active');
    this.setTrackedQuest(next?.id ?? null);
  }

  // ---------------------------------------------------------------- events

  private onGameEvent(e: GameEvent) {
    const pid = this.ctx.state.playerId;
    switch (e.type) {
      case 'damage': {
        const self = e.target === pid;
        const txt = Math.round(e.amount).toString();
        if (self) this.floaters.spawn(e.pos, `−${txt}`, 'self', e.dtype);
        else if (e.source === pid || this.ctx.state.entities.has(e.target)) this.floaters.spawn(e.pos, e.crit ? `${txt}!` : txt, e.crit ? 'crit' : 'damage', e.dtype);
        if (self && e.source !== undefined) this.lastKiller = this.ctx.state.entities.get(e.source)?.name ?? this.lastKiller;
        break;
      }
      case 'heal':
        if (e.amount >= 1) this.floaters.spawn(e.pos, `+${Math.round(e.amount)}`, 'heal');
        break;
      case 'death':
        if (e.target === pid) {
          if (e.killer !== undefined) this.lastKiller = this.ctx.state.entities.get(e.killer)?.name ?? this.lastKiller;
          this.death.show(this.lastKiller);
          if (this.active && this.active.id !== 'pause') this.close();
        }
        break;
      case 'xp':
        this.xp.gain(e.skill, e.amount, e.level);
        if (e.leveled) {
          this.xp.levelUp(e.skill, e.level, this.banners);
          this.sound('ui.levelup');
        }
        break;
      case 'unlock':
        this.xp.unlock(e.ability, this.banners);
        this.sound('ui.unlock');
        break;
      case 'loot': {
        const inv = this.ctx.state.player?.inventory.items ?? [];
        for (const it of e.items) {
          const item = inv.find((i) => i.uid === it);
          this.notify(item ? `Looted ${item.name}${item.count > 1 ? ` ×${item.count}` : ''}` : `Looted ${it}`, 'good');
        }
        break;
      }
      case 'notify':
        this.notify(e.text, e.tone);
        break;
      case 'gravity':
        this.status.fields.push({ pos: e.pos, radius: e.radius, factor: e.factor, until: e.until });
        break;
    }
  }

  private onGm(msgs: GmMessage[]) {
    this.gm.onGm(msgs);
    const now = this.serverNow();
    for (const m of msgs) {
      // Old messages replayed on join (journal log) shouldn't be narrated again.
      if (now - m.t > 30) continue;
      if (m.kind === 'reply' && this.isPanelOpen('gm')) continue;
      this.narration.push(m);
    }
  }

  // ---------------------------------------------------------------- saving

  private save() {
    this.ctx.send({ t: 'save' });
  }

  private onSaved(data: string) {
    const p = this.ctx.state.player;
    const name = p?.name ?? 'Wanderer';
    // The core stores the save under the typed seed; find it to attach metadata.
    setTimeout(() => {
      let key = findSaveKeyByData(name, data);
      let seedText = key ? seedTextFromKey(key, name) : String(this.ctx.seed >>> 0);
      if (!key) {
        if (!writeSave(this.meta(seedText, name, p), data)) {
          this.notify('Saving failed — browser storage is full.', 'bad');
          return;
        }
        key = saveKey(seedText, name);
        this.notify('Journey saved', 'good');
      } else writeSave(this.meta(seedText, name, p), null);
      if (this.pendingQuit) {
        this.pendingQuit = false;
        this.onQuit();
      }
    });
  }

  private meta(seedText: string, name: string, p: PlayerState | undefined) {
    const pp = this.ctx.playerPos();
    const site = this.ctx.gen.siteAt(pp[0], pp[2]);
    const levels = Object.values(p?.skills?.skills ?? {}).map((s) => s.level).sort((a, b) => b - a);
    const level = levels.length ? Math.round(levels.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, levels.length)) : undefined;
    return {
      seedText, name, worldName: this.ctx.profile.name, appearance: p?.appearance ?? ({} as HumanoidAppearance), savedAt: Date.now(),
      day: this.ctx.state.day + 1, location: site?.name ?? BIOMES[this.ctx.gen.biomeAt(pp[0], pp[2])]?.name, level,
    };
  }

  private quit() {
    this.pendingQuit = true;
    this.save();
    // Don't hang if the server never answers.
    setTimeout(() => {
      if (this.pendingQuit) {
        this.pendingQuit = false;
        this.onQuit();
      }
    }, 3000);
  }

  private applyLlm(which: 'llm' | 'gmLlm', cfg: LlmSettings) {
    this.ctx.send({ t: 'debug', cmd: which === 'llm' ? 'llmConfig' : 'gmLlmConfig', args: [cfg] });
  }

  // ---------------------------------------------------------------- settings

  private applySettings(s: GameSettings) {
    applyInterfaceScale(this.root, s.interface);
    this.uiKeys = currentKeyMap('ui');
    this.gameKeys = currentKeyMap('game');
    this.touch.applySettings(s.touch);
    this.hotbar.refreshKeys();
    this.guide.render();
    this.targetFrame.refreshHint();
    this.minimap.el.classList.toggle('n-hidden', !s.interface.minimap);
    this.compass.el.classList.toggle('n-hidden', !s.interface.compass);
    this.floaters.enabled = s.interface.damageNumbers;
    this.narration.enabled = s.interface.narration;
    this.plates.maxDist = s.interface.nameplateDistance;
    this.crosshair.setStyle(s.interface.crosshair);
  }

  private persist(key: string, v: unknown) {
    try {
      localStorage.setItem(`norgo.ui.${key}.${this.ctx.seed >>> 0}`, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }

  private restore<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(`norgo.ui.${key}.${this.ctx.seed >>> 0}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, _time?: number): void {
    if (!this.initialized || !this.ctx.state.player) return;
    this.vitals.update(dt);
    this.hotbar.update();
    this.effects.update();
    this.status.update();
    this.tracker.update(dt);
    if (!this.compass.el.classList.contains('n-hidden')) this.compass.update(dt);
    if (!this.minimap.el.classList.contains('n-hidden')) this.minimap.update(dt);
    this.plates.update();
    this.targetFrame.update(dt);
    this.floaters.update(dt);
    this.debug.update(dt);
    this.active?.update(dt);
    this.areaT -= dt;
    if (this.areaT <= 0) {
      this.areaT = 0.5;
      this.checkArea();
    }
    // HUD fades while full-screen panels are open.
    this.hudEl.classList.toggle('dimmed', !!this.active && this.active.id !== 'dialog');
    // Touch controls: touch mode only, and never over panels, dialogs or the death screen.
    this.touch.setVisible(platform.inputMode === 'touch' && !this.active && !this.death.shown);
    this.touch.update();
  }

  private checkArea() {
    const gen = this.ctx.gen;
    const [x, y, z] = this.ctx.playerPos();
    const site = gen.siteAt(x, z);
    if ((site?.id ?? null) !== this.lastSite) {
      const entering = site && this.lastSite !== null ? true : !!site;
      this.lastSite = site?.id ?? null;
      if (site && entering) {
        const race = raceDef(site.race as RaceId);
        this.area.show(site.name, `${SITE_LABEL[site.size]} of the ${race.plural}${site.race2 ? ` and ${raceDef(site.race2 as RaceId).plural}` : ''}`);
      }
    }
    let biome: string;
    let sub: string;
    if (y < UNDERWORLD_CEIL + 10 && gen.isUnderworld(x, y, z)) {
      biome = BIOMES[gen.cachedColumn(x, z).uwBiome]?.name ?? 'The Deep';
      sub = 'The Underworld';
    } else {
      biome = BIOMES[gen.biomeAt(x, z)]?.name ?? '';
      sub = this.ctx.profile.name;
    }
    this.minimap.setLabel(site?.name ?? biome);
    if (biome === this.biomeStable) {
      this.biomeHits = 0;
      return;
    }
    // Hysteresis: require the new biome on consecutive checks so borders don't spam.
    if (biome === this.biomeCandidate) this.biomeHits++;
    else {
      this.biomeCandidate = biome;
      this.biomeHits = 1;
    }
    if (this.biomeHits >= 3) {
      const first = !this.biomeStable;
      this.biomeStable = biome;
      if (!site && !first) this.area.show(biome, sub);
      else if (first && !site) this.area.show(biome, sub);
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    for (const p of this.panels.values()) (p as unknown as { dispose?(): void }).dispose?.();
    releaseMapRenderer(this.renderer);
    this.root?.remove();
    tooltip.hide();
    closeContextMenu();
    this.initialized = false;
  }
}

/** Skill display name (re-exported for the core's notifications). */
export function skillName(id: string): string {
  return skillOrStub(id).name;
}
