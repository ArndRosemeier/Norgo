/**
 * Tab-target frame (top centre, under the compass): name tinted by disposition, species/role
 * line, health bar with numbers, a threat estimate for anything that can fight, distance and
 * a status tag (attacking you / asleep / out of sight / dead). Fed by ClientEvents.target; the
 * TargetInfo object is updated in place by the core, so update() just reads it each frame and
 * touches the DOM only when something visible changed.
 */
import type { TargetInfo } from '../../client/context';
import type { EntitySnapshot } from '../../shared/protocol';
import { EntFlag } from '../../shared/types';
import { isEngaged } from '../../client/targetRules';
import { speciesList, type FaunaRole, type Species, type Temperament } from '../../creatures/species';
import type { UiHost } from '../host';
import { h } from '../dom';
import { fmtDist } from '../format';
import { platform } from '../../core/platform';
import { glyphSvg } from '../icons';
import { howText } from '../controls';
import { command } from '../../client/commands';

const ROLE_LABEL: Record<FaunaRole, string> = {
  smallcritter: 'Critter', grazer: 'Grazer', predator: 'Predator', bird: 'Bird', insect: 'Insect', fish: 'Fish',
  amphibian: 'Amphibian', burrower: 'Burrower', climber: 'Climber', floater: 'Floater', construct: 'Construct',
  cavecritter: 'Cave dweller', apex: 'Apex predator',
};
const TEMPER_LABEL: Record<Temperament, string> = { skittish: 'Skittish', docile: 'Docile', curious: 'Curious', territorial: 'Territorial', aggressive: 'Aggressive' };
const THREAT: { max: number; label: string }[] = [
  { max: 0.04, label: 'Trivial' },
  { max: 0.15, label: 'Weak' },
  { max: 0.5, label: 'Fair fight' },
  { max: 1.5, label: 'Strong' },
  { max: Infinity, label: 'Deadly' },
];

export class TargetFrame {
  readonly el: HTMLElement;
  private name = h('span', { class: 'n-tf-name' });
  private sub = h('span', { class: 'n-tf-sub' });
  private dist = h('span', { class: 'n-tf-dist' });
  private tag = h('span', { class: 'n-tf-tag' });
  private fill = h('i', { class: 'n-tf-fill' });
  private trail = h('i', { class: 'n-tf-trail' });
  private hpText = h('span', { class: 'n-tf-hptext' });
  private threat = h('div', { class: 'n-tf-threat' });
  private hint = h('div', { class: 'n-tf-hint' });
  private info: TargetInfo | null = null;
  private key = '';
  private hpKey = '';
  private distKey = '';
  private tagKey = '';
  private threatKey = '';
  private trailV = 1;
  private hpV = 1;
  private threatT = 0;

  constructor(private host: UiHost) {
    this.el = h('div', { class: 'n-tf', attrs: { 'aria-live': 'polite' } },
      h('div', { class: 'n-tf-head' }, this.name, this.dist),
      h('div', { class: 'n-tf-row' }, this.sub, this.tag),
      h('div', { class: 'n-tf-bar' }, this.trail, this.fill, h('i', { class: 'n-tf-gloss' }), this.hpText),
      h('div', { class: 'n-tf-row' }, this.threat, this.hint),
    );
    this.el.dataset.state = 'off';
  }

  set(t: TargetInfo | null) {
    const changed = t?.id !== this.info?.id;
    this.info = t;
    if (!t) {
      this.el.dataset.state = 'off';
      return;
    }
    if (changed) {
      this.key = this.hpKey = this.distKey = this.tagKey = this.threatKey = '';
      this.threatT = 0;
      const f = t.snap.maxHp > 0 ? Math.max(0, Math.min(1, t.snap.hp / t.snap.maxHp)) : 0;
      this.trailV = this.hpV = f;
      // Restart the entry animation.
      this.el.dataset.state = 'off';
      void this.el.offsetWidth;
    }
    this.el.dataset.state = 'on';
    this.update(0);
  }

  /** "Esc clears · Shift+Tab back" — or the touch gestures — from the command registry. */
  refreshHint() {
    if (platform.inputMode === 'touch') {
      const g = (id: 'targetClear' | 'targetPrev') => (command(id).touch.gesture === 'swipeLeft' ? 'swipe left' : command(id).touch.gesture ?? '');
      this.hint.innerHTML = `${glyphSvg(command('target').glyph, 11)} ${g('targetClear')}: clear · ${g('targetPrev')}: back`;
    }
    else this.hint.textContent = `${howText('targetClear')} clears · ${howText('targetPrev')} back`;
  }

  update(dt: number) {
    const t = this.info;
    if (!t) return;
    const s = t.snap;
    const pid = this.host.ctx.state.playerId;
    const dead = s.hp <= 0;
    // Identity line (name / role / colour) — rarely changes.
    const key = `${s.id}|${s.name}|${s.title}|${t.disposition}|${dead}|${s.flags & (EntFlag.Merchant | EntFlag.Questgiver)}`;
    if (key !== this.key) {
      this.key = key;
      this.el.dataset.disp = dead ? 'dead' : t.disposition;
      const icon = s.flags & EntFlag.Questgiver ? ' !' : s.flags & EntFlag.Merchant ? ' ¤' : '';
      this.name.textContent = (s.name ?? (s.kind === 'creature' ? 'Creature' : 'Stranger')) + icon;
      this.sub.textContent = this.subtitle(s);
    }
    // Health: fill snaps, the pale trail eases down behind it.
    const frac = s.maxHp > 0 ? Math.max(0, Math.min(1, s.hp / s.maxHp)) : 0;
    if (frac > this.trailV) this.trailV = frac;
    else this.trailV += (frac - this.trailV) * Math.min(1, dt * 2.5);
    const hpKey = `${frac.toFixed(3)}|${this.trailV.toFixed(3)}`;
    if (hpKey !== this.hpKey) {
      this.hpKey = hpKey;
      this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      this.trail.style.transform = `scaleX(${this.trailV.toFixed(3)})`;
      this.hpText.textContent = dead ? 'Dead' : `${Math.ceil(s.hp)} / ${Math.round(s.maxHp)}`;
      if (frac < this.hpV - 0.001) {
        this.el.classList.remove('hit');
        void this.el.offsetWidth;
        this.el.classList.add('hit');
      }
      this.hpV = frac;
    }
    this.el.classList.toggle('fresh', t.age < 3.5);
    const dk = fmtDist(t.dist);
    if (dk !== this.distKey) this.dist.textContent = this.distKey = dk;
    const tag = dead ? 'Dead' : !t.visible ? 'Out of sight' : isEngaged(s, pid) ? 'Attacking you' : s.flags & EntFlag.Sleeping ? 'Asleep' : s.flags & EntFlag.InCombat ? 'In combat' : '';
    if (tag !== this.tagKey) {
      this.tagKey = tag;
      this.tag.textContent = tag;
      this.tag.dataset.kind = tag === 'Attacking you' || tag === 'In combat' ? 'danger' : tag ? 'muted' : '';
      this.el.classList.toggle('hidden-target', !t.visible && !dead);
    }
    // Threat depends on the player's gear & skills too: refresh about once a second.
    this.threatT -= dt;
    if (this.threatT <= 0) {
      this.threatT = 1;
      const th = this.threatOf(s, t.disposition === 'hostile');
      const tk = th ? `${th.pips}|${th.label}` : '';
      if (tk !== this.threatKey) {
        this.threatKey = tk;
        this.threat.replaceChildren();
        if (th) {
          this.threat.append(h('span', { class: 'n-tf-threat-label', text: 'Threat' }));
          for (let i = 0; i < 5; i++) this.threat.append(h('i', { class: i < th.pips ? 'on' : '' }));
          this.threat.append(h('span', { text: th.label }));
          this.threat.dataset.level = String(th.pips);
        }
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private species(s: EntitySnapshot): Species | undefined {
    if (!s.creature) return;
    return speciesList(this.host.ctx.profile)[s.creature.species];
  }

  private subtitle(s: EntitySnapshot): string {
    if (s.kind === 'player') return 'Traveller';
    const sp = this.species(s);
    if (sp) {
      const parts: string[] = [];
      if (s.title) parts.push(s.title);
      else if (s.name !== sp.name) parts.push(sp.name);
      parts.push(ROLE_LABEL[sp.role] ?? sp.role);
      if (!s.title) parts.push(TEMPER_LABEL[sp.temperament] ?? sp.temperament);
      if ((s.flags & EntFlag.Tamed) !== 0) parts.push('Tamed');
      return parts.join(' · ');
    }
    return s.title ?? (s.kind === 'npc' ? 'Wanderer' : '');
  }

  /**
   * Rough "who wins" estimate: how long the player needs to fell it versus how long it needs to
   * fell the player (weapon damage & skill vs. its health and bite). Only for things that fight.
   */
  private threatOf(s: EntitySnapshot, hostile: boolean): { pips: number; label: string } | null {
    if (s.kind === 'player' || s.hp <= 0) return null;
    const sp = this.species(s);
    let dmg: number;
    if (sp) {
      const growth = s.creature?.growth ?? 1;
      // Bosses carry several times their species' health and hit twice as hard.
      const boss = s.maxHp > sp.hp * 2.5;
      dmg = sp.damage * (boss ? 2 : 0.4 + 0.6 * growth);
    } else if (hostile) dmg = 9;
    else return null;
    const p = this.host.ctx.state.player;
    const w = p.equipment?.mainhand?.weapon;
    const lvl = w ? p.skills?.skills?.[w.skill]?.level ?? 0 : p.skills?.skills?.unarmed?.level ?? 0;
    const myDps = Math.max(2, ((w?.damage ?? 6) * (1 + lvl * 0.012)) / (0.6 / Math.max(0.3, w?.speed ?? 1.3)));
    const theirDps = Math.max(0.1, dmg / 1.6);
    const myHp = Math.max(1, p.stats?.maxHp ?? 100);
    const ratio = (s.maxHp / myDps) / (myHp / theirDps);
    const i = THREAT.findIndex((t) => ratio < t.max);
    return { pips: i + 1, label: THREAT[i].label };
  }
}
