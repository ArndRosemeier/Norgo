/**
 * Heading compass strip with markers for the tracked quest, the custom waypoint,
 * nearby settlements, discovered points of interest and recent GM locations.
 * Markers are pooled and positioned with transforms only.
 */
import type { Vec3 } from '../../shared/types';
import type { UiHost } from '../host';
import { h } from '../dom';
import { cameraHeading } from './hud';
import { glyphSvg } from '../icons';
import { fmtDist } from '../format';

const SPAN = Math.PI * 0.9; // visible half-angle * 2 ≈ 162°
const WIDTH = 560;

interface Marker {
  key: string;
  pos: Vec3;
  glyph: string;
  color: string;
  label?: string;
  showDist?: boolean;
  priority: number;
}

interface MarkerEl {
  el: HTMLElement;
  dist: HTMLElement;
  lastDist: string;
  lastX: number;
  seen: boolean;
}

export class Compass {
  readonly el: HTMLElement;
  private strip: HTMLElement;
  private markersEl: HTMLElement;
  private pool = new Map<string, MarkerEl>();
  private list: Marker[] = [];
  private scanT = 0;
  private lastHead = 999;

  constructor(private host: UiHost) {
    // Ticks for 0..360 drawn twice so the strip can wrap seamlessly.
    this.strip = h('div', { class: 'n-compass-strip' });
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let rep = 0; rep < 3; rep++) {
      for (let d = 0; d < 360; d += 15) {
        const x = ((rep * 360 + d) / 360) * (WIDTH * (2 * Math.PI / SPAN));
        const lab = labels[d];
        this.strip.append(h('span', { class: `n-tick ${lab ? (lab.length === 1 ? 'card' : 'inter') : ''}`, style: { left: `${x}px` }, text: lab ?? '' }));
      }
    }
    this.markersEl = h('div', { class: 'n-compass-markers' });
    this.el = h('div', { class: 'n-compass n-scaled' }, h('div', { class: 'n-compass-window' }, this.strip, this.markersEl), h('i', { class: 'n-compass-needle' }));
  }

  private collect() {
    const ctx = this.host.ctx;
    const pp = ctx.playerPos();
    const out: Marker[] = [];
    const j = ctx.state.player?.journal;
    const q = j?.quests.find((x) => x.id === this.host.trackedQuest);
    if (q) {
      for (const o of q.objectives) if (o.pos && !o.done) out.push({ key: `q:${q.id}:${o.id}`, pos: o.pos, glyph: 'star', color: '#ffcf4a', label: o.text, showDist: true, priority: 0 });
    }
    // Untracked active quests: faint markers.
    for (const qq of j?.quests ?? []) {
      if (qq.status !== 'active' || qq.id === this.host.trackedQuest) continue;
      for (const o of qq.objectives) if (o.pos && !o.done) out.push({ key: `q:${qq.id}:${o.id}`, pos: o.pos, glyph: 'star', color: '#b8a070', priority: 3 });
    }
    if (this.host.waypoint) out.push({ key: 'wp', pos: this.host.waypoint, glyph: 'arrow', color: '#7fd0ff', label: 'Waypoint', showDist: true, priority: 1 });
    for (const s of ctx.gen.sites.sitesNear(pp[0], pp[2], 1400)) {
      const d = Math.hypot(s.x - pp[0], s.z - pp[2]);
      if (d < s.radius || d > 1400) continue;
      out.push({ key: `s:${s.id}`, pos: [s.x, s.plateau, s.z], glyph: s.walled || s.size === 'city' ? 'shield' : 'tree', color: '#e8d7b0', label: s.name, showDist: d < 900, priority: 2 });
    }
    for (const dsc of j?.discoveries ?? []) {
      const d = Math.hypot(dsc.pos[0] - pp[0], dsc.pos[2] - pp[2]);
      if (d < 15 || d > 700) continue;
      out.push({ key: `d:${dsc.id}`, pos: dsc.pos, glyph: 'rune', color: '#c9b6ff', label: dsc.name, priority: 4 });
    }
    const now = this.host.serverNow();
    for (const m of j?.log ?? []) {
      if (!m.pos || now - m.t > 240) continue;
      out.push({ key: `g:${m.id}`, pos: m.pos, glyph: 'eye', color: '#ff9f6a', label: 'Something stirs', showDist: true, priority: 1 });
    }
    this.list = out;
  }

  update(dt: number) {
    const ctx = this.host.ctx;
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.5;
      this.collect();
    }
    const head = cameraHeading(ctx.camera);
    const pxPerRad = WIDTH / SPAN;
    if (Math.abs(head - this.lastHead) > 1e-4) {
      // Strip origin: heading 0 at the centre of the middle repetition.
      const x = -((head + 2 * Math.PI) % (2 * Math.PI)) * pxPerRad - 2 * Math.PI * pxPerRad + WIDTH / 2;
      this.strip.style.transform = `translateX(${x.toFixed(1)}px)`;
      this.lastHead = head;
    }
    const pp = ctx.playerPos();
    for (const m of this.pool.values()) m.seen = false;
    for (const m of this.list) {
      const dx = m.pos[0] - pp[0], dz = m.pos[2] - pp[2];
      const bearing = Math.atan2(dx, -dz);
      let rel = bearing - head;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      const tracked = m.priority <= 1;
      // Tracked markers stick to the edge when out of view.
      if (Math.abs(rel) > SPAN / 2) {
        if (!tracked) continue;
        rel = Math.sign(rel) * SPAN / 2;
      }
      let me = this.pool.get(m.key);
      if (!me) {
        const dist = h('span', { class: 'n-cm-dist' });
        const el = h('div', { class: `n-cm p${m.priority}`, title: m.label ?? '', style: { color: m.color } }, h('span', { class: 'n-cm-icon', html: glyphSvg(m.glyph, 14, m.color) }), dist);
        me = { el, dist, lastDist: '', lastX: NaN, seen: true };
        this.pool.set(m.key, me);
        this.markersEl.append(el);
      }
      me.seen = true;
      const x = Math.round(WIDTH / 2 + rel * pxPerRad);
      if (x !== me.lastX) {
        me.el.style.transform = `translateX(${x}px)`;
        me.lastX = x;
      }
      if (m.showDist) {
        const d = fmtDist(Math.hypot(dx, dz));
        if (d !== me.lastDist) {
          me.dist.textContent = d;
          me.lastDist = d;
        }
      }
    }
    for (const [k, me] of this.pool)
      if (!me.seen) {
        me.el.remove();
        this.pool.delete(k);
      }
  }
}
