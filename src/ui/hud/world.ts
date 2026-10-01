/**
 * World-anchored overlays: nameplates with health bars & speech bubbles, and
 * floating damage/heal numbers. Pooled DOM elements positioned purely with
 * transforms each frame (no layout reads in the loop).
 */
import * as THREE from 'three';
import type { EntitySnapshot } from '../../shared/protocol';
import type { DamageType, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { UiHost } from '../host';
import { h } from '../dom';
import { DAMAGE_COLOR, RARITY_COLOR } from '../format';
import type { Rarity } from '../../items/types';

const v = new THREE.Vector3();

interface Plate {
  el: HTMLElement;
  name: HTMLElement;
  title: HTMLElement;
  hpWrap: HTMLElement;
  hp: HTMLElement;
  bubble: HTMLElement;
  icon: HTMLElement;
  key: string;
  speech: string;
  hpv: number;
  visible: boolean;
}

const MAX_PLATES = 28;

export class Nameplates {
  readonly el = h('div', { class: 'n-plates' });
  private plates: Plate[] = [];
  private cand: { s: EntitySnapshot; d: number }[] = [];
  maxDist = 38;
  /** Tab target: its plate gets brackets and always shows health. */
  targetId: number | null = null;

  constructor(private host: UiHost) {
    for (let i = 0; i < MAX_PLATES; i++) {
      const name = h('span', { class: 'n-plate-name' });
      const title = h('span', { class: 'n-plate-title' });
      const hp = h('i');
      const hpWrap = h('div', { class: 'n-plate-hp' }, hp);
      const bubble = h('div', { class: 'n-bubble' });
      const icon = h('span', { class: 'n-plate-icon' });
      const el = h('div', { class: 'n-plate' }, bubble, h('div', { class: 'n-plate-label' }, icon, name), title, hpWrap);
      el.style.display = 'none';
      this.plates.push({ el, name, title, hpWrap, hp, bubble, icon, key: '', speech: '', hpv: -1, visible: false });
      this.el.append(el);
    }
  }

  update() {
    const ctx = this.host.ctx;
    const cam = ctx.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const cp = cam.position;
    const now = this.host.serverNow();
    const cand = this.cand;
    cand.length = 0;
    const pid = ctx.state.playerId;
    const speechRange = Math.max(45, this.maxDist);
    for (const s of ctx.state.entities.values()) {
      if (s.id === pid || s.kind === 'projectile' || s.kind === 'effect') continue;
      if (s.flags & EntFlag.Invisible) continue;
      const d = Math.hypot(s.pos[0] - cp.x, s.pos[1] - cp.y, s.pos[2] - cp.z);
      const talking = s.speech && s.speech.until > now;
      const limit = s.kind === 'item' ? 9 : s.id === this.targetId ? Math.max(this.maxDist, 52) : talking ? speechRange : this.maxDist;
      if (d > limit) continue;
      cand.push({ s, d });
    }
    const tid = this.targetId;
    cand.sort((a, b) => (a.s.id === tid ? -1 : b.s.id === tid ? 1 : a.d - b.d));
    let used = 0;
    for (let i = 0; i < cand.length && used < MAX_PLATES; i++) {
      const { s, d } = cand[i];
      const view = ctx.views.get(s.id);
      const head = (view?.headHeight ?? (s.kind === 'item' ? 0.3 : 1.8)) + 0.32;
      v.set(s.pos[0], s.pos[1] + head, s.pos[2]).project(cam);
      if (v.z > 1 || v.z < -1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.3) continue;
      const p = this.plates[used++];
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      const scale = Math.max(0.62, Math.min(1.05, 14 / (d + 6)));
      p.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%) scale(${scale.toFixed(3)})`;
      const fade = d > this.maxDist * 0.75 && s.kind !== 'item' && s.id !== this.targetId ? Math.max(0, 1 - (d - this.maxDist * 0.75) / (this.maxDist * 0.25)) : 1;
      p.el.style.opacity = (s.kind === 'item' ? Math.max(0, 1 - d / 9) : Math.max(fade, s.speech && s.speech.until > now ? 1 : 0)).toFixed(2);
      if (!p.visible) {
        p.el.style.display = '';
        p.visible = true;
      }
      this.fill(p, s, now);
    }
    for (let i = used; i < MAX_PLATES; i++) {
      const p = this.plates[i];
      if (p.visible) {
        p.el.style.display = 'none';
        p.visible = false;
        p.key = '';
      }
    }
  }

  private fill(p: Plate, s: EntitySnapshot, now: number) {
    const hostile = (s.flags & EntFlag.Hostile) !== 0;
    const combat = (s.flags & EntFlag.InCombat) !== 0;
    const dead = s.hp <= 0 && s.kind !== 'item';
    let name = s.name ?? '';
    let color = '';
    if (s.kind === 'item' && s.item) {
      name = s.item.name + (s.item.count > 1 ? ` ×${s.item.count}` : '');
      color = RARITY_COLOR[s.item.rarity as Rarity] ?? '';
    }
    const cls = s.kind === 'item' ? 'item' : dead ? 'dead' : hostile ? 'hostile' : s.flags & EntFlag.Merchant ? 'merchant' : s.kind === 'player' ? 'player' : 'friendly';
    const icon = s.flags & EntFlag.Questgiver ? '!' : s.flags & EntFlag.Merchant ? '¤' : s.flags & EntFlag.Sleeping ? 'z' : '';
    const targeted = s.id === this.targetId;
    const key = `${s.id}|${name}|${s.title ?? ''}|${cls}|${icon}|${color}|${targeted}`;
    if (key !== p.key) {
      p.key = key;
      p.name.textContent = name;
      p.name.style.color = color;
      p.title.textContent = s.kind === 'item' ? '' : s.title ?? '';
      p.icon.textContent = icon;
      p.icon.style.display = icon ? '' : 'none';
      p.el.className = `n-plate ${cls}${targeted ? ' targeted' : ''}`;
      p.hpv = -1;
    }
    const showHp = s.kind !== 'item' && !dead && (s.hp < s.maxHp || hostile || combat || targeted);
    const frac = s.maxHp > 0 ? Math.max(0, Math.min(1, s.hp / s.maxHp)) : 0;
    if (showHp !== (p.hpWrap.style.display !== 'none') || frac !== p.hpv) {
      p.hpWrap.style.display = showHp ? '' : 'none';
      p.hp.style.transform = `scaleX(${frac.toFixed(3)})`;
      p.hpv = frac;
    }
    const speech = s.speech && s.speech.until > now ? s.speech : null;
    const sk = speech ? `${speech.style ?? 'say'}|${speech.text}` : '';
    if (sk !== p.speech) {
      p.speech = sk;
      if (speech) {
        p.bubble.textContent = speech.text;
        p.bubble.className = `n-bubble show ${speech.style ?? 'say'}`;
      } else p.bubble.className = 'n-bubble';
    }
  }
}

interface Floater {
  el: HTMLElement;
  pos: Vec3;
  vx: number;
  vy: number;
  age: number;
  life: number;
  active: boolean;
}

const MAX_FLOATERS = 48;

export class FloatingNumbers {
  readonly el = h('div', { class: 'n-floaters' });
  private pool: Floater[] = [];
  private next = 0;
  enabled = true;

  constructor(private host: UiHost) {
    for (let i = 0; i < MAX_FLOATERS; i++) {
      const el = h('div', { class: 'n-float' });
      el.style.display = 'none';
      this.pool.push({ el, pos: [0, 0, 0], vx: 0, vy: 0, age: 0, life: 1, active: false });
      this.el.append(el);
    }
  }

  spawn(pos: Vec3, text: string, kind: 'damage' | 'heal' | 'self' | 'crit' | 'xp', dtype?: DamageType) {
    if (!this.enabled && kind !== 'self') return;
    const f = this.pool[this.next];
    this.next = (this.next + 1) % MAX_FLOATERS;
    f.pos = [pos[0], pos[1] + 1.6, pos[2]];
    f.vx = (Math.random() - 0.5) * 70;
    f.vy = -55 - Math.random() * 25;
    f.age = 0;
    f.life = kind === 'crit' ? 1.5 : 1.15;
    f.active = true;
    f.el.textContent = text;
    f.el.className = `n-float ${kind}`;
    f.el.style.color = kind === 'damage' || kind === 'crit' ? DAMAGE_COLOR[dtype ?? 'slash'] : '';
    f.el.style.display = '';
  }

  update(dt: number) {
    const cam = this.host.ctx.camera;
    const W = window.innerWidth, H = window.innerHeight;
    for (const f of this.pool) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.active = false;
        f.el.style.display = 'none';
        continue;
      }
      v.set(f.pos[0], f.pos[1], f.pos[2]).project(cam);
      if (v.z > 1) {
        f.el.style.opacity = '0';
        continue;
      }
      const t = f.age / f.life;
      // Pop, then drift up and sideways in screen space with easing.
      const ease = 1 - Math.pow(1 - t, 2.2);
      const x = (v.x * 0.5 + 0.5) * W + f.vx * ease;
      const y = (-v.y * 0.5 + 0.5) * H + f.vy * ease;
      const s = t < 0.12 ? 0.6 + (t / 0.12) * 0.7 : 1.3 - Math.min(0.3, (t - 0.12) * 0.6);
      f.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-50%) scale(${s.toFixed(3)})`;
      f.el.style.opacity = (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1).toFixed(2);
    }
  }
}
