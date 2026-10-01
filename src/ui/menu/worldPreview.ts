/**
 * New-world screen content: seed input + live world "almanac" (name, weirdness,
 * biomes, races, gravity, moons, rings, day length) computed from the profile,
 * plus a cartographic preview rendered progressively in the map worker.
 */
import { parseSeed, Rng } from '../../core/rng';
import { createProfile, type WorldProfile } from '../../world/profile';
import { WorldGenerator } from '../../world/generator';
import { BIOMES } from '../../world/biomes';
import { h } from '../dom';
import { frame } from '../widgets';
import { MapRenderer } from '../map/MapRenderer';
import { buildPalette } from '../map/palette';
import { drawSite, drawLabel } from '../map/markers';
import { raceDef } from '../data';
import { rgbCss, fmtNum } from '../format';
import { glyphSvg } from '../icons';
import type { RaceId } from '../../humanoid/types';

const WORDS_A = ['amber', 'ashen', 'azure', 'bleak', 'bright', 'cinder', 'crimson', 'drowned', 'ember', 'feral', 'gilded', 'hollow', 'iron', 'ivory', 'jade', 'lunar', 'misty', 'molten', 'obsidian', 'pale', 'quiet', 'restless', 'rusted', 'silver', 'sunken', 'thorned', 'umber', 'verdant', 'violet', 'whispering', 'wild', 'withered'];
const WORDS_B = ['abyss', 'bloom', 'crown', 'dawn', 'drift', 'dusk', 'echo', 'fen', 'fjord', 'gale', 'glade', 'grove', 'harbor', 'hearth', 'hollow', 'isle', 'marsh', 'mire', 'moor', 'peak', 'reach', 'rift', 'shore', 'spire', 'steppe', 'tide', 'vale', 'veil', 'waste', 'wilds'];

export function randomSeedText(): string {
  const r = new Rng((Math.random() * 2 ** 32) >>> 0);
  return `${r.pick(WORDS_A)}-${r.pick(WORDS_B)}-${r.int(1, 999)}`;
}

export function weirdLabel(w: number): string {
  return w < 0.15 ? 'Mundane' : w < 0.35 ? 'Uncanny' : w < 0.55 ? 'Strange' : w < 0.75 ? 'Eldritch' : 'Utterly alien';
}

function gravityLabel(g: number): string {
  const r = g / 9.81;
  return r < 0.8 ? 'Light' : r < 0.95 ? 'Gentle' : r < 1.06 ? 'Earthlike' : r < 1.2 ? 'Heavy' : 'Crushing';
}

const MAP_PX = 288;
const MPP = 36;
const STRIPS = 9;

export class WorldPreview {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private info: HTMLElement;
  private canvas: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private renderer: MapRenderer | null = null;
  private timer = 0;
  private token = 0;
  private progress: HTMLElement;
  profile: WorldProfile;
  seedText: string;
  onProfile: (p: WorldProfile) => void = () => {};

  constructor(initialSeed: string) {
    this.seedText = initialSeed;
    this.profile = createProfile(parseSeed(initialSeed));
    this.input = h('input', { class: 'n-input n-seed-input', attrs: { type: 'text', spellcheck: 'false', maxlength: 64, 'aria-label': 'World seed', placeholder: 'Any word, phrase or number' } });
    this.input.value = initialSeed;
    this.input.addEventListener('input', () => this.schedule());
    const dice = h('button', {
      class: 'n-btn icon', title: 'Random seed', html: glyphSvg('star', 16),
      attrs: { type: 'button', 'aria-label': 'Random seed' },
      onclick: () => {
        this.input.value = randomSeedText();
        this.schedule(0);
      },
    });
    this.canvas = h('canvas', { class: 'n-preview-map', attrs: { width: MAP_PX, height: MAP_PX } });
    this.mapCtx = this.canvas.getContext('2d')!;
    this.progress = h('div', { class: 'n-preview-progress' });
    this.info = h('div', { class: 'n-almanac' });
    this.el = h('div', { class: 'n-world-screen' },
      frame('n-world-card',
        h('div', { class: 'n-label', text: 'World seed' }),
        h('div', { class: 'n-seed-row' }, this.input, dice),
        h('div', { class: 'n-faint', style: 'font-size:12px;margin-top:6px', text: 'Every seed is a different world: its land, skies, peoples and laws of nature.' }),
        h('div', { class: 'n-world-body' },
          h('div', { class: 'n-preview-wrap' }, this.canvas, this.progress, h('div', { class: 'n-preview-compass', text: 'N' })),
          this.info,
        ),
      ),
    );
    this.update();
  }

  private schedule(delay = 260) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), delay);
  }

  private update() {
    this.seedText = this.input.value.trim() || '0';
    const seed = parseSeed(this.seedText);
    this.profile = createProfile(seed);
    this.renderInfo(this.profile);
    this.onProfile(this.profile);
    this.renderMap(seed);
  }

  private renderInfo(p: WorldProfile) {
    const pal = buildPalette(p);
    const biomes = p.biomes.filter((b) => b && b.weight > 0 && b.id !== 0).sort((a, b) => b.weight - a.weight);
    const races = p.races.slice().sort((a, b) => b.weight - a.weight);
    const total = races.reduce((s, r) => s + r.weight, 0);
    const days = p.dayLengthSec / 60;
    this.info.replaceChildren(
      h('div', { class: 'n-world-name', text: p.name }),
      h('div', { class: 'n-world-sub', text: `Seed ${p.seed >>> 0}` }),
      h('div', { class: 'n-weird' },
        h('div', { class: 'n-weird-bar' }, h('i', { style: { left: `${p.weirdness * 100}%` } })),
        h('div', { class: 'n-weird-labels' }, h('span', { text: 'Mundane' }), h('b', { text: weirdLabel(p.weirdness) }), h('span', { text: 'Alien' })),
      ),
      h('div', { class: 'n-facts' },
        fact('gravity', 'Gravity', `${p.baseGravity.toFixed(2)} m/s²`, gravityLabel(p.baseGravity)),
        fact('moon', 'Moons', p.moons.length ? String(p.moons.length) : 'None', p.moons.length ? '' : 'starlit nights'),
        fact('orb', 'Rings', p.hasRings ? 'Ringed sky' : 'None', ''),
        fact('sun', 'Day', `${fmtNum(+days.toFixed(0))} min`, p.auroraStrength > 0 ? 'auroras' : ''),
      ),
      h('div', { class: 'n-label', style: 'margin-top:12px', text: 'Lands' }),
      h('div', { class: 'n-chips' },
        biomes.slice(0, 10).map((b) => h('span', { class: 'n-chip' }, h('i', { style: { background: rgbCss([pal.biome[b.id * 3], pal.biome[b.id * 3 + 1], pal.biome[b.id * 3 + 2]]) } }), BIOMES[b.id]?.name ?? '?')),
      ),
      h('div', { class: 'n-label', style: 'margin-top:12px', text: 'Peoples' }),
      h('div', { class: 'n-races' },
        races.map((r) => h('div', { class: 'n-race-share' }, h('span', { text: raceDef(r.id as RaceId).plural }), h('div', { class: 'n-share' }, h('i', { style: { width: `${(r.weight / total) * 100}%` } })))),
      ),
    );
  }

  private renderMap(seed: number) {
    const token = ++this.token;
    if (!this.renderer) this.renderer = new MapRenderer(seed, 2, 0);
    else this.renderer.setSeed(seed);
    const r = this.renderer;
    const ctx = this.mapCtx;
    ctx.fillStyle = '#16121a';
    ctx.fillRect(0, 0, MAP_PX, MAP_PX);
    this.progress.style.transform = 'scaleX(0)';
    this.progress.classList.remove('done');
    const half = (MAP_PX / 2) * MPP;
    const rows = MAP_PX / STRIPS;
    let done = 0;
    // Strips from the centre outward so the heart of the world appears first.
    const order = Array.from({ length: STRIPS }, (_, i) => i).sort((a, b) => Math.abs(a - (STRIPS - 1) / 2) - Math.abs(b - (STRIPS - 1) / 2));
    for (const i of order) {
      r.region({ layer: 'surface', x0: -half, z0: -half + i * rows * MPP, mpp: MPP, w: MAP_PX, h: rows }, Math.abs(i - STRIPS / 2)).then((bmp) => {
        if (token !== this.token) return bmp.close();
        ctx.drawImage(bmp, 0, i * rows);
        bmp.close();
        done++;
        this.progress.style.transform = `scaleX(${done / STRIPS})`;
        if (done === STRIPS) {
          this.progress.classList.add('done');
          this.drawSites(seed, token);
        }
      });
    }
  }

  private drawSites(seed: number, token: number) {
    // Settlements are cheap to compute on the main thread (lazy per cell).
    const gen = new WorldGenerator(seed);
    if (token !== this.token) return;
    const ctx = this.mapCtx;
    const half = (MAP_PX / 2) * MPP;
    const sites = gen.sites.sitesNear(0, 0, half);
    ctx.save();
    ctx.strokeStyle = 'rgba(70,45,25,.65)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    const byId = new Map(sites.map((s) => [s.id, s]));
    for (const s of sites) {
      for (const l of s.links) {
        const o = byId.get(l);
        if (!o || o.id < s.id) continue;
        ctx.beginPath();
        ctx.moveTo(MAP_PX / 2 + s.x / MPP, MAP_PX / 2 + s.z / MPP);
        ctx.lineTo(MAP_PX / 2 + o.x / MPP, MAP_PX / 2 + o.z / MPP);
        ctx.stroke();
      }
    }
    ctx.restore();
    const big = sites.filter((s) => s.size === 'city' || s.size === 'town').slice(0, 4);
    for (const s of sites) {
      const x = MAP_PX / 2 + s.x / MPP, y = MAP_PX / 2 + s.z / MPP;
      if (x < 4 || y < 4 || x > MAP_PX - 4 || y > MAP_PX - 4) continue;
      drawSite(ctx, x, y, s.size, s.walled, 0.7);
    }
    for (const s of big) {
      const x = MAP_PX / 2 + s.x / MPP, y = MAP_PX / 2 + s.z / MPP;
      if (x < 30 || x > MAP_PX - 30 || y < 10 || y > MAP_PX - 20) continue;
      drawLabel(ctx, s.name, x, y + 7, 10);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.token++;
    this.renderer?.dispose();
    this.renderer = null;
  }
}

function fact(glyph: string, label: string, value: string, note: string): HTMLElement {
  return h('div', { class: 'n-fact' },
    h('span', { class: 'n-fact-icon', html: glyphSvg(glyph, 18, '#d4af6a') }),
    h('div', null, h('div', { class: 'n-fact-label', text: label }), h('div', { class: 'n-fact-value', text: value }), note ? h('div', { class: 'n-fact-note', text: note }) : null),
  );
}
