/**
 * Rotating circular minimap: worker-rendered terrain tiles (surface or the
 * underworld band when the player is down there), settlements, POIs, quest
 * objectives & waypoint (clamped to the rim), and live entity dots.
 */
import { EntFlag } from '../../shared/types';
import type { UiHost } from '../host';
import { h } from '../dom';
import { MapRenderer, drawMapTiles, type MapLayer } from './MapRenderer';
import { drawSite, drawPoi, drawPlayer, drawQuest, drawWaypoint } from './markers';
import { cameraHeading } from '../hud/hud';
import type { PoiKind } from '../../world/sites';
import { UNDERWORLD_CEIL } from '../../world/constants';

const SIZE = 210;
const ZOOMS = [0.6, 1.2, 2.4, 4.8];

export class Minimap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private zoom = 1;
  private north: HTMLElement;
  private label: HTMLElement;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private frame = 0;
  private layer: MapLayer = 'surface';
  private layerT = 0;

  constructor(private host: UiHost, private renderer: MapRenderer) {
    this.canvas = h('canvas', { class: 'n-minimap-canvas', attrs: { width: SIZE * this.dpr, height: SIZE * this.dpr } });
    this.g = this.canvas.getContext('2d')!;
    this.north = h('span', { class: 'n-minimap-north', text: 'N' });
    this.label = h('div', { class: 'n-minimap-label' });
    const zoomBtn = (txt: string, d: number) =>
      h('button', { class: 'n-minimap-zoom n-interactive', text: txt, attrs: { 'aria-label': d > 0 ? 'Zoom out' : 'Zoom in' }, onclick: () => (this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, this.zoom + d))) });
    this.el = h('div', { class: 'n-minimap n-scaled' },
      h('div', { class: 'n-minimap-disc' }, this.canvas, h('div', { class: 'n-minimap-glass' })),
      h('div', { class: 'n-minimap-ring' }, this.north),
      h('div', { class: 'n-minimap-zooms' }, zoomBtn('+', -1), zoomBtn('−', 1)),
      this.label,
    );
  }

  setLabel(text: string) {
    if (this.label.textContent !== text) this.label.textContent = text;
  }

  update(dt: number) {
    // 30 Hz is plenty for a minimap.
    if (++this.frame % 2) return;
    const ctx = this.host.ctx;
    const pp = ctx.playerPos();
    this.layerT -= dt * 2;
    if (this.layerT <= 0) {
      this.layerT = 0.5;
      this.layer = pp[1] < UNDERWORLD_CEIL + 10 && ctx.gen.isUnderworld(pp[0], pp[1], pp[2]) ? 'under' : 'surface';
    }
    const mpp = ZOOMS[this.zoom];
    const head = cameraHeading(ctx.camera);
    const g = this.g;
    const R = SIZE / 2;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = this.layer === 'under' ? '#0c0a10' : '#1a1712';
    g.fillRect(0, 0, SIZE, SIZE);
    g.save();
    g.translate(R, R);
    g.rotate(-head);
    // Rotated square must cover the disc: half-extent R·√2.
    drawMapTiles(g, this.renderer, this.layer, pp[0], pp[2], mpp, R * 1.42, R * 1.42, -2);

    const toScreen = (x: number, z: number): [number, number] => [(x - pp[0]) / mpp, (z - pp[2]) / mpp];
    const range = R * 1.45 * mpp;
    // Settlements & discovered POIs (icons stay upright: counter-rotate).
    for (const s of ctx.gen.sites.sitesNear(pp[0], pp[2], range)) {
      const [x, y] = toScreen(s.x, s.z);
      if (Math.hypot(x, y) > R + 10) continue;
      this.upright(x, y, head, () => drawSite(g, 0, 0, s.size, s.walled, 0.8));
    }
    const j = ctx.state.player?.journal;
    for (const d of j?.discoveries ?? []) {
      const [x, y] = toScreen(d.pos[0], d.pos[2]);
      if (Math.hypot(x, y) > R) continue;
      this.upright(x, y, head, () => drawPoi(g, 0, 0, (d.kind as PoiKind) ?? 'ruin', 0.75));
    }
    // Entities.
    const now = this.host.serverNow();
    for (const e of ctx.state.entities.values()) {
      if (e.id === ctx.state.playerId || e.kind === 'projectile' || e.kind === 'effect') continue;
      const [x, y] = toScreen(e.pos[0], e.pos[2]);
      if (x * x + y * y > (R - 4) * (R - 4)) continue;
      const hostile = (e.flags & EntFlag.Hostile) !== 0;
      let col = '#d8d0b8', r = 2.2;
      if (e.kind === 'item') { col = '#f3d58f'; r = 1.6; }
      else if (e.kind === 'npc') { col = e.flags & EntFlag.Questgiver ? '#ffcf4a' : e.flags & EntFlag.Merchant ? '#e8b060' : hostile ? '#ff5a4a' : '#9fe08a'; r = 2.8; }
      else if (e.kind === 'creature') { col = hostile ? '#ff5a4a' : '#d8c8a0'; r = 2.4; }
      else if (e.kind === 'player') { col = '#7fd0ff'; r = 3; }
      if (e.hp <= 0 && e.kind !== 'item') col = '#6a6058';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = col;
      g.fill();
      if (hostile && e.flags & EntFlag.InCombat) {
        g.lineWidth = 1;
        g.strokeStyle = `rgba(255,90,74,${0.5 + 0.5 * Math.sin(now * 8)})`;
        g.stroke();
      }
    }
    // Tracked objectives & waypoint, clamped to the rim.
    const q = j?.quests.find((x) => x.id === this.host.trackedQuest);
    const pins: [number, number, 'q' | 'w'][] = [];
    for (const o of q?.objectives ?? []) if (o.pos && !o.done) pins.push([o.pos[0], o.pos[2], 'q']);
    if (this.host.waypoint) pins.push([this.host.waypoint[0], this.host.waypoint[2], 'w']);
    for (const [wx, wz, kind] of pins) {
      let [x, y] = toScreen(wx, wz);
      const d = Math.hypot(x, y);
      const edge = R - 12;
      if (d > edge) { x *= edge / d; y *= edge / d; }
      this.upright(x, y, head, () => (kind === 'q' ? drawQuest(g, 0, 0, 0.8) : drawWaypoint(g, 0, 7, 0.8)));
    }
    g.restore();
    // Player arrow points along the facing direction, which is always "up".
    drawPlayer(g, R, R, 0, 0.85);
    // Underground (but not in the mapped underworld band): dim the surface map.
    if (this.layer === 'surface' && pp[1] < ctx.gen.heightAt(pp[0], pp[2]) - 12) {
      g.fillStyle = 'rgba(8,6,10,0.55)';
      g.fillRect(0, 0, SIZE, SIZE);
    }
    // North marker orbits the rim.
    const nx = Math.sin(-head) * (R + 3), ny = -Math.cos(-head) * (R + 3);
    this.north.style.transform = `translate(${(nx).toFixed(1)}px, ${(ny).toFixed(1)}px)`;
  }

  private upright(x: number, y: number, head: number, draw: () => void) {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.rotate(head);
    draw();
    g.restore();
  }
}
