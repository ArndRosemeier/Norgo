/**
 * Character creator: name, race cards (lore + bonuses), mixed heritage, body &
 * face sliders, coloration, race features (horns, tusks, tail, skin patterns)
 * and a live HumanoidPreview turntable with body/face focus.
 */
import type { HumanoidAppearance, RaceId } from '../../humanoid/types';
import * as appearanceMod from '../../humanoid/appearance';
import { randomAppearance } from '../../humanoid/appearance';
import { HumanoidPreview } from '../../humanoid/client/preview';
import { Rng } from '../../core/rng';
import { h, setChildren } from '../dom';
import { frame, slider, toggle, segmented, tabs } from '../widgets';
import { touchMode } from '../gestures';
import { raceDef, raceIds, skillOrStub } from '../data';
import { rgbHex, hexRgb, statLine, titleize } from '../format';
import { glyphSvg } from '../icons';

type FaceKey = keyof HumanoidAppearance['face'];
type BodyKey = keyof HumanoidAppearance['body'];

const FACE: [FaceKey, string][] = [
  ['headRound', 'Head shape'], ['foreheadSlope', 'Forehead'], ['browRidge', 'Brow ridge'], ['eyeSize', 'Eye size'], ['eyeSpacing', 'Eye spacing'],
  ['noseSize', 'Nose size'], ['noseWidth', 'Nose width'], ['noseBridge', 'Nose bridge'], ['cheekbones', 'Cheekbones'], ['jaw', 'Jaw'],
  ['chin', 'Chin'], ['mouthWidth', 'Mouth width'], ['lipFullness', 'Lips'], ['earSize', 'Ear size'], ['earPoint', 'Ear point'],
];
const BODY: [BodyKey, string][] = [
  ['shoulders', 'Shoulders'], ['chest', 'Chest'], ['waist', 'Waist'], ['hips', 'Hips'], ['belly', 'Belly'], ['neck', 'Neck'],
  ['armLength', 'Arm length'], ['legLength', 'Leg length'], ['hands', 'Hands'], ['feet', 'Feet'],
];

function optList(name: string, fallback: string[]): string[] {
  const v = (appearanceMod as unknown as Record<string, unknown>)[name];
  if (Array.isArray(v) && v.length) return v.map(String);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length) return keys;
  }
  return fallback;
}

const HAIR = optList('HAIR_STYLES', ['bald', 'buzz', 'short', 'cropped', 'tousled', 'undercut', 'mohawk', 'ponytail', 'topknot', 'bun', 'braids', 'long', 'wild', 'curly', 'dreadlocks']);
const BEARD = optList('BEARD_STYLES', ['none', 'stubble', 'goatee', 'moustache', 'short', 'full', 'braided', 'long', 'mutton']);
const BROW = optList('BROW_STYLES', ['normal', 'thin', 'thick', 'arched', 'straight', 'bushy', 'none']);
const PATTERNS: HumanoidAppearance['skinPattern'][] = ['none', 'freckles', 'scales', 'bark', 'spots', 'tattoos', 'veins', 'stripes', 'crystals'];
const HORNS: HumanoidAppearance['horns']['style'][] = ['none', 'ram', 'straight', 'swept', 'antler', 'crown'];
const TAILS: HumanoidAppearance['tail']['style'][] = ['none', 'reptile', 'furred', 'thin'];
const PUPILS: HumanoidAppearance['pupil'][] = ['round', 'slit', 'goat', 'none'];

/** Which race add-ons make sense to offer (union across both heritage races). */
const FEATURES: Partial<Record<RaceId, { horns?: boolean; tusks?: boolean; tail?: boolean }>> = {
  orc: { tusks: true }, goblin: { tusks: true }, giantkin: { tusks: true, horns: true }, drakeborn: { horns: true, tail: true },
  umbral: { horns: true, tail: true }, sylvan: { horns: true },
};

const SKIN_SWATCHES: Record<string, string[]> = {
  natural: ['#f6dcc8', '#eac2a1', '#d9a47c', '#bf8560', '#9c6644', '#7a4b2f', '#5a3522', '#3f2519'],
  orc: ['#7f9a5a', '#6a8a4f', '#5a7348', '#8c9a74', '#6f7b62', '#4f5a44', '#8a7f62', '#5f6e5a'],
  goblin: ['#9bb35a', '#7fa04a', '#b5b35e', '#6e8f50', '#a0a878', '#5f7a3a', '#c2b070', '#7a8a66'],
  sylvan: ['#7a6248', '#5f7348', '#8a7a5a', '#4f6a4a', '#9a8a68', '#6a5a40', '#7f8f6a', '#5a4a38'],
  drakeborn: ['#9a3a2a', '#b5652e', '#7a5a3a', '#3a4a5a', '#2a2a32', '#6a2a3a', '#c09040', '#3f6a4a'],
  umbral: ['#c8c8d8', '#a8a8c0', '#8a90b0', '#b0a0c8', '#7a7a9a', '#9ab0c0', '#d8d0e0', '#6a6080'],
};
const EYE_SWATCHES = ['#3b6fa0', '#5a8a4a', '#6a4a2a', '#3a2a1a', '#8a8a9a', '#c8a040', '#a03030', '#8a40c0', '#40c0c0', '#e0e0f0'];
const HAIR_SWATCHES = ['#0f0c0a', '#2a1c12', '#4a2f1c', '#7a4f2a', '#b07a40', '#d8b878', '#e8e0d0', '#8a8a8a', '#9a3020', '#3a5a8a', '#5a3a7a', '#2a6a4a'];

const NAMES: Record<string, [string[], string[]]> = {
  human: [['Al', 'Bran', 'Ced', 'Ed', 'Gar', 'Hal', 'Mar', 'Ro', 'Wil', 'Is', 'El', 'Ma', 'Ca', 'Lin'], ['ric', 'den', 'wyn', 'mund', 'ard', 'bel', 'la', 'nor', 'ton', 'ra', 'ette', 'is']],
  elf: [['Ae', 'Cae', 'Ela', 'Fae', 'Gal', 'Ith', 'Lae', 'Sil', 'Thal', 'Yl'], ['dren', 'lith', 'rion', 'wen', 'nor', 'thas', 'riel', 'vyre', 'aran', 'iel']],
  dwarf: [['Bal', 'Bor', 'Dur', 'Gim', 'Gor', 'Kil', 'Thor', 'Ul', 'Bru', 'Hil'], ['din', 'grim', 'li', 'mund', 'rak', 'in', 'dra', 'gar', 'dis', 'na']],
  orc: [['Gro', 'Ug', 'Mok', 'Thra', 'Zug', 'Kra', 'Ruk', 'Sha', 'Gul', 'Ur'], ['nak', 'gash', 'tor', 'mog', 'za', 'rok', 'ka', 'th', 'dush', 'gra']],
  halfling: [['Bil', 'Fro', 'Mer', 'Pip', 'Sam', 'Ros', 'Dai', 'Lob', 'Tod', 'Mil'], ['bo', 'do', 'ry', 'pin', 'wise', 'ie', 'sy', 'elia', 'lo', 'wick']],
  goblin: [['Snik', 'Grik', 'Nub', 'Zib', 'Skab', 'Rat', 'Mug', 'Fizz', 'Kip', 'Nix'], ['', 'le', 'it', 'ix', 'nok', 'zag', 'wort', 'grub', 'bit', 'sy']],
  sylvan: [['Moss', 'Fern', 'Ash', 'Bryn', 'Lich', 'Root', 'Wil', 'Thistle', 'Rowan', 'Sedge'], ['', 'whisper', 'song', 'bloom', 'heart', 'en', 'a', 'shade', 'dew', 'ling']],
  drakeborn: [['Vyr', 'Skal', 'Rhaz', 'Ix', 'Thyr', 'Kae', 'Zar', 'Mor', 'Syr', 'Dra'], ['ax', 'kesh', 'thar', 'ion', 'vex', 'rath', 'ia', 'ys', 'gon', 'issa']],
  umbral: [['Nyx', 'Vel', 'Sha', 'Eth', 'Qeth', 'Ul', 'Mor', 'Ves', 'Ise', 'Zae'], ['ara', 'en', 'is', 'vael', 'thir', 'ne', 'oth', 'ari', 'lune', 'ys']],
  giantkin: [['Hrim', 'Jot', 'Ymr', 'Brok', 'Stor', 'Fjal', 'Gund', 'Thrym', 'Ska', 'Bera'], ['ir', 'unn', 'gar', 'vald', 'mar', 'a', 'heim', 'rik', 'dis', 'ulf']],
};

export function randomName(race: string, rng = new Rng((Math.random() * 2 ** 32) >>> 0)): string {
  const p = NAMES[race] ?? NAMES.human;
  const n = rng.pick(p[0]) + rng.pick(p[1]);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function ageYears(age: number, lifespan: number): number {
  // MakeHuman: 0 → 1y, 0.1875 → 11y, 0.5 → 25y, 1 → 90y (human scale), stretched by race lifespan.
  const human = age < 0.1875 ? 1 + (age / 0.1875) * 10 : age < 0.5 ? 11 + ((age - 0.1875) / 0.3125) * 14 : 25 + ((age - 0.5) / 0.5) * 65;
  return Math.round(human * (lifespan / 80));
}

export class CharacterCreator {
  readonly el: HTMLElement;
  appearance: HumanoidAppearance;
  name: string;
  private preview: HumanoidPreview | null = null;
  private canvas: HTMLCanvasElement;
  private yaw = 0.35;
  private raf = 0;
  private dirty = true;
  private nameInput: HTMLInputElement;
  private raceGrid: HTMLElement;
  private raceInfo: HTMLElement;
  private editor: HTMLElement;
  private editorTabs: ReturnType<typeof tabs<'body' | 'face' | 'colors' | 'features' | 'heritage'>>;
  private focus: 'body' | 'face' = 'body';
  private focusSeg: HTMLElement;
  private previewOk = false;
  private autoName = true;

  constructor() {
    const race = raceIds()[0] ?? 'human';
    const seed = (Math.random() * 2 ** 32) >>> 0;
    this.appearance = randomAppearance(race, seed, { gender: Math.random() < 0.5 ? 0.15 : 0.85, age: 0.42 });
    this.name = randomName(race);

    this.nameInput = h('input', { class: 'n-input n-name-input', attrs: { type: 'text', maxlength: 24, spellcheck: 'false', 'aria-label': 'Character name' } });
    this.nameInput.value = this.name;
    this.nameInput.addEventListener('input', () => {
      this.name = this.nameInput.value.trim();
      this.autoName = false;
    });

    this.canvas = h('canvas', { class: 'n-cc-canvas', attrs: { width: 520, height: 760, 'aria-label': 'Character preview' } });
    this.bindRotate();
    this.raceGrid = h('div', { class: 'n-race-grid', attrs: { role: 'listbox', 'aria-label': 'Race' } });
    this.raceInfo = h('div', { class: 'n-race-info' });
    this.editor = h('div', { class: 'n-cc-editor' });
    this.editorTabs = tabs(
      [{ id: 'body', label: 'Body' }, { id: 'face', label: 'Face' }, { id: 'colors', label: 'Colors' }, { id: 'features', label: 'Features' }, { id: 'heritage', label: 'Heritage' }],
      'body',
      (id) => {
        this.renderEditor();
        this.setFocus(id === 'face' || id === 'colors' ? 'face' : 'body');
      },
    );
    this.focusSeg = h('div');

    this.el = h('div', { class: 'n-cc' },
      frame('n-cc-left',
        h('div', { class: 'n-label', text: 'Name' }),
        h('div', { class: 'n-seed-row' }, this.nameInput,
          h('button', { class: 'n-btn icon', title: 'Random name', html: glyphSvg('scroll', 16), attrs: { type: 'button', 'aria-label': 'Random name' }, onclick: () => this.setName(randomName(this.appearance.race)) })),
        h('div', { class: 'n-label', style: 'margin-top:14px', text: 'Race' }),
        this.raceGrid,
        this.raceInfo,
      ),
      h('div', { class: 'n-cc-stage' },
        h('div', { class: 'n-cc-halo' }),
        this.canvas,
        h('div', { class: 'n-cc-stage-bar' },
          this.focusSeg,
          h('button', { class: 'n-btn small', html: `${glyphSvg('star', 14)} Randomize`, onclick: () => this.randomize(false) }),
          h('button', { class: 'n-btn small ghost', title: 'Random race, body and name', html: `${glyphSvg('sparkle', 14)} Surprise me`, onclick: () => this.randomize(true) }),
        ),
        h('div', { class: 'n-cc-hint n-faint', text: touchMode() ? 'Drag to rotate' : 'Drag to rotate · scroll to switch focus' }),
      ),
      frame('n-cc-right', this.editorTabs.el, this.editor),
    );
    this.renderFocus();
    this.renderRaces();
    this.renderEditor();
    this.initPreview();
  }

  private setName(n: string) {
    this.name = n;
    this.autoName = true;
    this.nameInput.value = n;
  }

  private async initPreview() {
    try {
      this.preview = new HumanoidPreview(this.canvas);
      await this.preview.ready();
      this.previewOk = true;
      this.preview.setFocus(this.focus);
      this.preview.setPose('idle');
      this.dirty = true;
    } catch (e) {
      console.warn('HumanoidPreview unavailable', e);
    }
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (this.dirty && this.preview && this.previewOk) {
        this.dirty = false;
        this.preview.setAppearance(this.appearance);
        this.preview.setYaw(this.yaw);
      }
    };
    tick();
  }

  private bindRotate() {
    let dragging = false, lastX = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.yaw += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
      this.preview?.setYaw(this.yaw);
    });
    this.canvas.addEventListener('pointerup', () => (dragging = false));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setFocus(e.deltaY < 0 ? 'face' : 'body');
    }, { passive: false });
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.yaw -= 0.2;
      else if (e.key === 'ArrowRight') this.yaw += 0.2;
      else return;
      this.preview?.setYaw(this.yaw);
      e.preventDefault();
    });
  }

  private setFocus(f: 'body' | 'face') {
    if (f === this.focus) return;
    this.focus = f;
    this.preview?.setFocus(f);
    this.renderFocus();
  }

  private renderFocus() {
    this.focusSeg.replaceChildren(segmented([{ id: 'body', label: 'Body' }, { id: 'face', label: 'Face' }], this.focus, (v) => this.setFocus(v)));
  }

  private changed() {
    this.dirty = true;
  }

  private renderRaces() {
    const ids = raceIds();
    this.raceGrid.replaceChildren(
      ...ids.map((id) => {
        const d = raceDef(id);
        const card = h('button', {
          class: `n-race-card ${id === this.appearance.race ? 'active' : ''}`,
          attrs: { type: 'button', role: 'option', 'aria-selected': id === this.appearance.race },
          onclick: () => this.pickRace(id),
        }, h('span', { class: 'n-race-sigil', html: glyphSvg(RACE_GLYPH[id] ?? 'rune', 20) }), h('span', { text: d.name }));
        return card;
      }),
    );
    const d = raceDef(this.appearance.race);
    const bonuses = Object.entries(d.skillBonus).map(([k, v]) => `${skillOrStub(k).name} +${v}`);
    const mods = Object.entries(d.statMods).map(([k, v]) => statLine(k, v).reverse().join(' '));
    setChildren(this.raceInfo,
      h('div', { class: 'n-race-title', text: d.name }),
      h('p', { class: 'n-race-desc', text: d.description }),
      bonuses.length || mods.length
        ? h('div', { class: 'n-race-bonus' }, ...bonuses.map((b) => h('span', { class: 'n-pill', text: b })), ...mods.map((m) => h('span', { class: 'n-pill n-pill-stat', text: m })))
        : null,
      h('div', { class: 'n-faint', style: 'font-size:11px;margin-top:6px', text: `Lifespan ~${d.lifespan} years` }),
    );
  }

  private pickRace(id: RaceId) {
    if (id === this.appearance.race) return;
    const a = this.appearance;
    // A new race starts pure: heritage mixing is opt-in from the Heritage tab.
    const next = randomAppearance(id, a.seed, { gender: a.gender, age: a.age, race2: null });
    next.raceMix = 0;
    this.appearance = next;
    // Only replace names the player didn't type themselves.
    if (this.autoName || !this.name) this.setName(randomName(id));
    this.renderRaces();
    this.renderEditor();
    this.changed();
  }

  private randomize(all: boolean) {
    const rng = new Rng((Math.random() * 2 ** 32) >>> 0);
    const race = all ? rng.pick(raceIds()) : this.appearance.race;
    const race2 = all && rng.chance(0.2) ? rng.pick(raceIds().filter((r) => r !== race)) : all ? null : this.appearance.race2;
    const a = randomAppearance(race, rng.nextU32(), { gender: rng.chance(0.5) ? rng.range(0.05, 0.25) : rng.range(0.75, 0.95), age: rng.range(0.3, 0.75), race2 });
    if (race2) a.raceMix = all ? rng.range(0.2, 0.5) : this.appearance.raceMix;
    this.appearance = a;
    if (all) this.setName(randomName(race, rng));
    this.renderRaces();
    this.renderEditor();
    this.changed();
  }

  private renderEditor() {
    const a = this.appearance;
    const lifespan = raceDef(a.race).lifespan || 80;
    const set = <K extends keyof HumanoidAppearance>(k: K, v: HumanoidAppearance[K]) => {
      this.appearance = { ...this.appearance, [k]: v };
      this.changed();
    };
    const sec = (title: string, ...kids: (Node | null)[]) => h('section', { class: 'n-cc-sec' }, h('div', { class: 'n-heading', text: title }), ...kids);
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const signed = (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100);
    let body: Node[] = [];
    switch (this.editorTabs.value) {
      case 'body': {
        const ageEl = slider('Age', a.age, { min: 0.2, max: 1, step: 0.005, format: (v) => `${ageYears(v, lifespan)} y`, onInput: (v) => set('age', v) });
        body = [
          sec('Build',
            slider('Femininity ↔ Masculinity', a.gender, { min: 0, max: 1, format: pct, onInput: (v) => set('gender', v) }),
            ageEl,
            slider('Height', a.height, { min: 0, max: 1, format: pct, onInput: (v) => set('height', v) }),
            slider('Muscle', a.muscle, { min: 0, max: 1, format: pct, onInput: (v) => set('muscle', v) }),
            slider('Weight', a.weight, { min: 0, max: 1, format: pct, onInput: (v) => set('weight', v) }),
            slider('Proportions', a.proportions, { min: 0, max: 1, format: pct, onInput: (v) => set('proportions', v) }),
          ),
          sec('Shape', ...BODY.map(([k, label]) =>
            slider(label, a.body[k], { min: -1, max: 1, format: signed, onInput: (v) => { this.appearance = { ...this.appearance, body: { ...this.appearance.body, [k]: v } }; this.changed(); } }),
          )),
          sec('Ancestry', ...this.ethnicSliders()),
        ];
        break;
      }
      case 'face':
        body = [sec('Features', ...FACE.map(([k, label]) =>
          slider(label, a.face[k], { min: -1, max: 1, format: signed, onInput: (v) => { this.appearance = { ...this.appearance, face: { ...this.appearance.face, [k]: v } }; this.changed(); } }),
        ))];
        break;
      case 'colors': {
        const skinSet = SKIN_SWATCHES[a.race] ?? SKIN_SWATCHES.natural;
        body = [
          sec('Skin', swatches(skinSet, a.skinTone, (c) => set('skinTone', c))),
          sec('Eyes',
            swatches(EYE_SWATCHES, a.eyeColor, (c) => set('eyeColor', c)),
            slider('Iris glow', a.eyeGlow, { min: 0, max: 1, format: pct, onInput: (v) => set('eyeGlow', v) }),
            selectRow('Pupil', PUPILS, a.pupil, (v) => set('pupil', v as HumanoidAppearance['pupil'])),
          ),
          sec('Hair',
            swatches(HAIR_SWATCHES, a.hairColor, (c) => set('hairColor', c)),
            selectRow('Hair style', withCurrent(HAIR, a.hairStyle), a.hairStyle, (v) => set('hairStyle', v)),
            selectRow('Beard', withCurrent(BEARD, a.beardStyle), a.beardStyle, (v) => set('beardStyle', v)),
            selectRow('Brows', withCurrent(BROW, a.browStyle), a.browStyle, (v) => set('browStyle', v)),
          ),
        ];
        break;
      }
      case 'features': {
        const f = { ...(FEATURES[a.race] ?? {}), ...(a.race2 ? FEATURES[a.race2] ?? {} : {}) };
        const kids: Node[] = [
          sec('Markings',
            selectRow('Pattern', PATTERNS, a.skinPattern, (v) => set('skinPattern', v as HumanoidAppearance['skinPattern'])),
            slider('Pattern strength', a.patternStrength, { min: 0, max: 1, format: pct, onInput: (v) => set('patternStrength', v) }),
            colorRow('Pattern color', a.skinAccent, (c) => set('skinAccent', c)),
          ),
        ];
        if (f.horns || a.horns.style !== 'none')
          kids.push(sec('Horns',
            selectRow('Style', HORNS, a.horns.style, (v) => set('horns', { ...this.appearance.horns, style: v as HumanoidAppearance['horns']['style'] })),
            slider('Size', a.horns.size, { min: 0, max: 1, format: pct, onInput: (v) => set('horns', { ...this.appearance.horns, size: v }) }),
            colorRow('Color', a.horns.color, (c) => set('horns', { ...this.appearance.horns, color: c })),
          ));
        if (f.tusks || a.tusks > 0)
          kids.push(sec('Tusks', slider('Tusk size', a.tusks, { min: 0, max: 1, format: pct, onInput: (v) => set('tusks', v) })));
        if (f.tail || a.tail.style !== 'none')
          kids.push(sec('Tail',
            selectRow('Style', TAILS, a.tail.style, (v) => set('tail', { ...this.appearance.tail, style: v as HumanoidAppearance['tail']['style'] })),
            slider('Length', a.tail.length, { min: 0, max: 1, format: pct, onInput: (v) => set('tail', { ...this.appearance.tail, length: v }) }),
          ));
        if (kids.length === 1) kids.push(h('p', { class: 'n-faint', style: 'font-size:12px', text: `${raceDef(a.race).plural} have no horns, tusks or tails — but mixed heritage might change that.` }));
        body = kids;
        break;
      }
      case 'heritage': {
        const others = raceIds().filter((r) => r !== a.race);
        const mixed = !!a.race2;
        body = [
          sec('Mixed heritage',
            h('p', { class: 'n-faint', style: 'font-size:12px;margin:0 0 8px', text: 'Blend a second lineage into your features. The primary race decides your starting bonuses.' }),
            toggle('Mixed heritage', mixed, (v) => {
              this.appearance = { ...this.appearance, race2: v ? others[0] : null, raceMix: v ? 0.35 : 0 };
              this.renderEditor();
              this.changed();
            }),
            mixed ? selectRow('Second lineage', others, a.race2!, (v) => { set('race2', v as RaceId); this.renderEditor(); }, (r) => raceDef(r as RaceId).name) : null,
            mixed ? slider('Blend', a.raceMix, { min: 0.05, max: 0.95, format: (v) => `${Math.round((1 - v) * 100)}/${Math.round(v * 100)}`, onInput: (v) => set('raceMix', v) }) : null,
          ),
        ];
        break;
      }
    }
    this.editor.replaceChildren(...body);
  }

  private ethnicSliders(): Node[] {
    const keys: ['african' | 'asian' | 'caucasian', string][] = [['african', 'Lineage I'], ['asian', 'Lineage II'], ['caucasian', 'Lineage III']];
    const els: ReturnType<typeof slider>[] = [];
    keys.forEach(([k, label]) => {
      els.push(slider(label, this.appearance[k], {
        min: 0, max: 1, format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => {
          // Keep the three weights summing to 1 by rescaling the other two.
          const a = { ...this.appearance };
          const others = keys.map((x) => x[0]).filter((x) => x !== k);
          const rest = others.reduce((s, o) => s + a[o], 0);
          a[k] = v;
          for (const o of others) a[o] = rest > 1e-4 ? (a[o] / rest) * (1 - v) : (1 - v) / 2;
          this.appearance = a;
          keys.forEach(([kk], i) => kk !== k && els[i].setValue(a[kk]));
          this.changed();
        },
      }));
    });
    return els;
  }

  getChoice(): { name: string; appearance: HumanoidAppearance } {
    const name = this.name.trim() || randomName(this.appearance.race);
    return { name, appearance: structuredClone(this.appearance) };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.preview?.dispose();
    this.preview = null;
  }
}

const RACE_GLYPH: Partial<Record<RaceId, string>> = {
  human: 'sun', elf: 'leaf', dwarf: 'hammer', orc: 'axe', halfling: 'apple', goblin: 'key', sylvan: 'tree', drakeborn: 'flame', umbral: 'moon', giantkin: 'mountain',
};

function withCurrent(list: string[], cur: string): string[] {
  return cur && !list.includes(cur) ? [cur, ...list] : list;
}

function selectRow(label: string, options: string[], value: string, onChange: (v: string) => void, name: (v: string) => string = titleize): HTMLElement {
  const sel = h('select', { class: 'n-select', attrs: { 'aria-label': label } }, ...options.map((o) => h('option', { text: name(o), attrs: { value: o } })));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return h('label', { class: 'n-slider n-select-row' }, h('span', { text: label }), sel, h('span'));
}

function colorRow(label: string, value: [number, number, number], onChange: (c: [number, number, number]) => void): HTMLElement {
  const input = h('input', { class: 'n-color', attrs: { type: 'color', 'aria-label': label } });
  input.value = rgbHex(value);
  input.addEventListener('input', () => onChange(hexRgb(input.value)));
  return h('label', { class: 'n-slider n-select-row' }, h('span', { text: label }), input, h('span'));
}

function swatches(list: string[], value: [number, number, number], onChange: (c: [number, number, number]) => void): HTMLElement {
  const cur = rgbHex(value);
  const custom = h('input', { class: 'n-color', attrs: { type: 'color', title: 'Custom color', 'aria-label': 'Custom color' } });
  custom.value = cur;
  const wrap = h('div', { class: 'n-swatches' });
  const pick = (hex: string) => {
    for (const b of wrap.querySelectorAll('.n-swatch')) b.classList.toggle('active', (b as HTMLElement).dataset.c === hex);
    custom.value = hex;
    onChange(hexRgb(hex));
  };
  wrap.append(
    ...list.map((c) => h('button', { class: `n-swatch ${c === cur ? 'active' : ''}`, dataset: { c }, style: { background: c }, attrs: { type: 'button', 'aria-label': c }, onclick: () => pick(c) })),
    custom,
  );
  custom.addEventListener('input', () => pick(custom.value));
  return wrap;
}
