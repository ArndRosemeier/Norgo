/**
 * Full-screen world map: pan (drag / WASD / arrows), zoom (wheel / +−) around the
 * cursor, progressive worker-rendered terrain tiles with coarse fallbacks,
 * roads, settlements, discovered POIs, quest objectives, GM locations, player
 * marker and a placeable waypoint (double-click / right-click).
 */
import { Panel, type UiHost } from '../host';
import { h } from '../dom';
import { MapRenderer, drawMapTiles, type MapLayer } from './MapRenderer';
import { drawSite, drawPoi, drawPlayer, drawQuest, drawWaypoint, drawLabel, POI_LABEL, SITE_LABEL } from './markers';
import { cameraHeading } from '../hud/hud';
import { tooltip, segmented, toggle } from '../widgets';
import { raceDef } from '../data';
import { fmtDist, cap } from '../format';
import { BIOMES } from '../../world/biomes';
import type { PoiKind } from '../../world/sites';
import type { RaceId } from '../../humanoid/types';
import { glyphSvg } from '../icons';

interface Hit {
  x: number;
  y: number;
  r: number;
  title: string;
  sub: string;
}

export class WorldMapPanel extends Panel {
  readonly id = 'map' as const;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private cx = 0;
  private cz = 0;
  private mpp = 6;
  private follow = true;
  private layer: MapLayer = 'surface';
  private hits: Hit[] = [];
  private dirty = true;
  private coords: HTMLElement;
  private progress: HTMLElement;
  private layers = { sites: true, pois: true, quests: true, roads: true };
  private keys = new Set<string>();
  private offTile: () => void;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private hoverHit: Hit | null = null;

  constructor(host: UiHost, private renderer: MapRenderer) {
    super(host, 'World Map', 'n-map-panel', '');
    this.canvas = h('canvas', { class: 'n-map-canvas', attrs: { tabindex: 0, 'aria-label': 'World map' } });
    this.g = this.canvas.getContext('2d')!;
    this.coords = h('div', { class: 'n-map-coords' });
    this.progress = h('div', { class: 'n-map-progress' });
    const layerSeg = segmented<MapLayer>([{ id: 'surface', label: 'Surface' }, { id: 'under', label: 'Underworld' }], 'surface', (v) => {
      this.layer = v;
      this.dirty = true;
    });
    const filters = h('div', { class: 'n-map-filters' },
      toggle('Settlements', true, (v) => { this.layers.sites = v; this.dirty = true; }),
      toggle('Roads', true, (v) => { this.layers.roads = v; this.dirty = true; }),
      toggle('Discoveries', true, (v) => { this.layers.pois = v; this.dirty = true; }),
      toggle('Quests', true, (v) => { this.layers.quests = v; this.dirty = true; }),
    );
    const side = h('div', { class: 'n-map-side n-frame' },
      h('div', { class: 'n-map-world', text: host.ctx.profile.name }),
      layerSeg,
      h('div', { class: 'n-rule' }),
      filters,
      h('div', { class: 'n-rule' }),
      h('div', { class: 'n-map-btns' },
        h('button', { class: 'n-btn small', html: `${glyphSvg('arrow', 13)} Center on me`, onclick: () => this.centerOnPlayer() }),
        h('button', { class: 'n-btn small ghost', text: 'Clear waypoint', onclick: () => host.setWaypoint(null) }),
      ),
      h('div', { class: 'n-map-help n-faint' },
        h('div', null, 'Drag or ', h('span', { class: 'n-key', text: 'WASD' }), ' to pan · wheel to zoom'),
        h('div', null, 'Double-click to set a waypoint'),
        h('div', null, h('span', { class: 'n-key', text: 'M' }), ' / ', h('span', { class: 'n-key', text: 'Esc' }), ' to close'),
      ),
    );
    this.body.classList.add('n-map-body');
    this.body.append(h('div', { class: 'n-map-stage' }, this.canvas, h('div', { class: 'n-map-vignette' }), this.coords, this.progress), side);
    this.offTile = renderer.onTile(() => (this.dirty = true));
    this.bindInput();
  }

  private bindInput() {
    const c = this.canvas;
    let drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false };
      c.focus();
    });
    c.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.cx = drag.cx - dx * this.mpp;
        this.cz = drag.cz - dy * this.mpp;
        this.follow = false;
        this.dirty = true;
        tooltip.hide(c);
        return;
      }
      this.hover(e);
    });
    c.addEventListener('pointerup', () => (drag = null));
    c.addEventListener('pointerleave', () => tooltip.hide(c));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.deltaY > 0 ? 1.25 : 0.8, e.offsetX, e.offsetY);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => this.placeWaypoint(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.placeWaypoint(e);
    });
  }

  private screenToWorld(sx: number, sy: number): [number, number] {
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    return [this.cx + (sx - w / 2) * this.mpp, this.cz + (sy - hgt / 2) * this.mpp];
  }

  private placeWaypoint(e: MouseEvent) {
    const [x, z] = this.screenToWorld(e.offsetX, e.offsetY);
    this.host.setWaypoint([x, this.host.ctx.gen.heightAt(x, z), z]);
    this.host.sound('ui.waypoint');
    this.dirty = true;
  }

  private zoomAt(f: number, sx: number, sy: number) {
    const [wx, wz] = this.screenToWorld(sx, sy);
    const next = Math.max(0.75, Math.min(256, this.mpp * f));
    // Keep the point under the cursor fixed.
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    this.cx = wx - (sx - w / 2) * next;
    this.cz = wz - (sy - hgt / 2) * next;
    this.mpp = next;
    if (f !== 1) this.follow = false;
    this.dirty = true;
  }

  private centerOnPlayer() {
    const p = this.host.ctx.playerPos();
    this.cx = p[0];
    this.cz = p[2];
    this.follow = true;
    this.dirty = true;
  }

  /** Centre the map on a world position (journal "show on map"). */
  focusOn(x: number, z: number, mpp = 3) {
    this.cx = x;
    this.cz = z;
    this.mpp = mpp;
    this.follow = false;
    this.dirty = true;
  }

  private hover(e: PointerEvent) {
    let best: Hit | null = null, bd = Infinity;
    for (const hh of this.hits) {
      const d = Math.hypot(hh.x - e.offsetX, hh.y - e.offsetY);
      if (d < hh.r && d < bd) { best = hh; bd = d; }
    }
    const [wx, wz] = this.screenToWorld(e.offsetX, e.offsetY);
    const b = BIOMES[this.host.ctx.gen.biomeAt(wx, wz)];
    const pp = this.host.ctx.playerPos();
    this.coords.textContent = `${Math.round(wx)}, ${Math.round(wz)} · ${b?.name ?? ''} · ${fmtDist(Math.hypot(wx - pp[0], wz - pp[2]))} away`;
    if (best !== this.hoverHit) {
      this.hoverHit = best;
      if (best) tooltip.show(this.canvas, [h('div', { class: 'n-tip-title n-gold', text: best.title }), h('div', { class: 'n-tip-sub', style: 'text-transform:none;letter-spacing:0', text: best.sub })]);
      else tooltip.hide(this.canvas);
    }
  }

  protected override onOpen(data?: unknown) {
    const d = data as { x?: number; z?: number } | undefined;
    if (d && typeof d.x === 'number' && typeof d.z === 'number') this.focusOn(d.x, d.z);
    else this.centerOnPlayer();
    this.resize();
    setTimeout(() => this.canvas.focus());
  }

  protected override onClose() {
    tooltip.hide();
    this.keys.clear();
  }

  override onKey(e: KeyboardEvent): boolean {
    const k = e.code;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
      if (e.type === 'keydown') this.keys.add(k);
      else this.keys.delete(k);
      return true;
    }
    if (e.type === 'keydown' && (e.key === '+' || e.key === '=')) {
      this.zoomAt(0.8, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
      return true;
    }
    if (e.type === 'keydown' && (e.key === '-' || e.key === '_')) {
      this.zoomAt(1.25, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
      return true;
    }
    if (e.type === 'keydown' && k === 'KeyC') {
      this.centerOnPlayer();
      return true;
    }
    return false;
  }

  private resize() {
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * this.dpr) || this.canvas.height !== Math.round(hgt * this.dpr)) {
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(hgt * this.dpr);
    }
    this.dirty = true;
  }

  override update(dt: number) {
    let pan = 0;
    const sp = 600 * dt;
    for (const k of this.keys) {
      if (k === 'KeyW' || k === 'ArrowUp') { this.cz -= sp * this.mpp; pan++; }
      if (k === 'KeyS' || k === 'ArrowDown') { this.cz += sp * this.mpp; pan++; }
      if (k === 'KeyA' || k === 'ArrowLeft') { this.cx -= sp * this.mpp; pan++; }
      if (k === 'KeyD' || k === 'ArrowRight') { this.cx += sp * this.mpp; pan++; }
    }
    if (pan) { this.follow = false; this.dirty = true; }
    if (this.follow) {
      const p = this.host.ctx.playerPos();
      if (Math.abs(p[0] - this.cx) > this.mpp * 0.5 || Math.abs(p[2] - this.cz) > this.mpp * 0.5) {
        this.cx = p[0];
        this.cz = p[2];
        this.dirty = true;
      }
    }
    if (this.canvas.clientWidth * this.dpr !== this.canvas.width) this.resize();
    // The player arrow turns with the camera even when nothing else changes.
    this.draw();
  }

  private draw() {
    const g = this.g, ctx = this.host.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = this.layer === 'under' ? '#0a090c' : '#1d1912';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    const missing = drawMapTiles(g, this.renderer, this.layer, this.cx, this.cz, this.mpp, W / 2, H / 2);
    g.restore();
    this.progress.style.opacity = missing ? '1' : '0';
    this.hits = [];
    const sx = (x: number) => W / 2 + (x - this.cx) / this.mpp;
    const sy = (z: number) => H / 2 + (z - this.cz) / this.mpp;
    const range = Math.hypot(W, H) * 0.5 * this.mpp;
    // Settlements & roads (only on the surface layer; skip at continental zoom).
    if (this.layer === 'surface' && this.mpp <= 24) {
      // Slightly larger query so roads leaving the view still find their far end.
      const sites = ctx.gen.sites.sitesNear(this.cx, this.cz, range * 1.4);
      const byId = new Map(sites.map((s) => [s.id, s]));
      if (this.layers.roads && this.mpp > 2.5) {
        g.save();
        g.lineCap = 'round';
        for (const pass of [0, 1]) {
          g.strokeStyle = pass ? 'rgba(196,160,108,0.85)' : 'rgba(40,28,16,0.55)';
          g.lineWidth = pass ? 1.6 : 3.4;
          g.setLineDash(pass && this.mpp > 12 ? [4, 4] : []);
          g.beginPath();
          for (const s of sites)
            for (const l of s.links) {
              const o = byId.get(l);
              if (!o || o.id < s.id) continue;
              g.moveTo(sx(s.x), sy(s.z));
              g.lineTo(sx(o.x), sy(o.z));
            }
          g.stroke();
        }
        g.restore();
      }
      if (this.layers.sites) {
        const k = Math.max(0.75, Math.min(1.5, 6 / Math.sqrt(this.mpp)));
        for (const s of sites) {
          const x = sx(s.x), y = sy(s.z);
          if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
          drawSite(g, x, y, s.size, s.walled, k);
          const big = s.size === 'city' || s.size === 'town';
          if (big || (s.size === 'village' && this.mpp < 14) || this.mpp < 5) drawLabel(g, s.name, x, y + 10 * k, big ? 14 : 12);
          const race = raceDef(s.race as RaceId).name;
          this.hits.push({ x, y, r: 14 * k, title: s.name, sub: `${SITE_LABEL[s.size]}${s.walled ? ' (walled)' : ''} · ${race}${s.race2 ? ` & ${raceDef(s.race2 as RaceId).name}` : ''} · ${BIOMES[s.biome]?.name ?? ''}` });
        }
      }
    }
    const j = ctx.state.player?.journal;
    if (this.layers.pois && j) {
      for (const d of j.discoveries) {
        const x = sx(d.pos[0]), y = sy(d.pos[2]);
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        drawPoi(g, x, y, d.kind as PoiKind, 1.1);
        if (this.mpp < 4) drawLabel(g, d.name, x, y + 10, 11, '#e6dcff', 'Inter, sans-serif');
        this.hits.push({ x, y, r: 12, title: d.name, sub: POI_LABEL[d.kind as PoiKind] ?? cap(d.kind) });
      }
    }
    if (this.layers.quests && j) {
      for (const q of j.quests) {
        if (q.status !== 'active') continue;
        const tracked = q.id === this.host.trackedQuest;
        for (const o of q.objectives) {
          if (!o.pos || o.done) continue;
          const x = sx(o.pos[0]), y = sy(o.pos[2]);
          drawQuest(g, x, y, tracked ? 1.3 : 1, tracked);
          this.hits.push({ x, y, r: 12, title: q.title, sub: o.text });
        }
      }
      const now = this.host.serverNow();
      for (const m of j.log) {
        if (!m.pos || now - m.t > 600) continue;
        const x = sx(m.pos[0]), y = sy(m.pos[2]);
        g.beginPath();
        g.arc(x, y, 7 + Math.sin(performance.now() / 300) * 1.5, 0, Math.PI * 2);
        g.strokeStyle = '#ff9f6a';
        g.lineWidth = 2;
        g.stroke();
        this.hits.push({ x, y, r: 10, title: 'Game Master', sub: m.text });
      }
    }
    const wp = this.host.waypoint;
    if (wp) {
      const x = sx(wp[0]), y = sy(wp[2]);
      drawWaypoint(g, x, y, 1.3);
      this.hits.push({ x, y: y - 9, r: 12, title: 'Waypoint', sub: `${fmtDist(Math.hypot(wp[0] - ctx.playerPos()[0], wp[2] - ctx.playerPos()[2]))} away — right-click elsewhere to move` });
    }
    const pp = ctx.playerPos();
    drawPlayer(g, sx(pp[0]), sy(pp[2]), cameraHeading(ctx.camera), 1.25);
    this.hits.push({ x: sx(pp[0]), y: sy(pp[2]), r: 12, title: ctx.state.player?.name ?? 'You', sub: 'You are here' });
    this.drawScale(W, H);
    this.dirty = false;
  }

  private drawScale(W: number, H: number) {
    const g = this.g;
    // Pick a round distance ≈ 120 px long.
    const target = 120 * this.mpp;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    const px = nice / this.mpp;
    const x0 = 24, y0 = H - 26;
    g.fillStyle = 'rgba(20,14,8,.7)';
    g.fillRect(x0 - 8, y0 - 22, px + 16, 34);
    g.fillStyle = '#f3d58f';
    g.fillRect(x0, y0, px, 3);
    g.fillRect(x0, y0 - 5, 2, 8);
    g.fillRect(x0 + px - 2, y0 - 5, 2, 8);
    g.font = '600 11px Inter, sans-serif';
    g.textAlign = 'center';
    g.fillText(fmtDist(nice), x0 + px / 2, y0 - 8);
    void W;
  }

  dispose() {
    this.offTile();
  }
}
