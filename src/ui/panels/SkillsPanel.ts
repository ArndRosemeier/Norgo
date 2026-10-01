/**
 * Skill book: categories (magic grouped by school), levels & XP bars, the
 * unlock timeline per skill, and ability cards that can be dragged onto the
 * hotbar (or assigned with a click on a free slot).
 */
import { Panel, type UiHost } from '../host';
import { h, setChildren } from '../dom';
import { tooltip, drag, tabs } from '../widgets';
import { abilityCard } from '../tooltips';
import { SKILL_CATEGORIES, skillOrStub, abilityOrStub, xpForLevel } from '../data';
import { SKILLS } from '../../gameplay/data/catalog';
import { abilityIcon, skillIcon, skillLook, CATEGORY_COLOR } from '../icons';
import { fmtDuration, fmtNum, titleize } from '../format';
import type { SkillCategory, SkillDef } from '../../gameplay/types';
import type { PlayerState } from '../../shared/protocol';

type Tab = SkillCategory | 'known';

export class SkillsPanel extends Panel {
  readonly id = 'skills' as const;
  private list: HTMLElement;
  private detail: HTMLElement;
  private tabs: ReturnType<typeof tabs<Tab>>;
  private selected: string | null = null;
  private sig = '';

  constructor(host: UiHost) {
    super(host, 'Skills & Abilities', 'n-skills-panel', 'Grow by doing');
    this.dim = true;
    this.list = h('div', { class: 'n-skill-list n-list' });
    this.detail = h('div', { class: 'n-skill-detail' });
    this.tabs = tabs<Tab>([...SKILL_CATEGORIES.map((c) => ({ id: c.id as Tab, label: c.name })), { id: 'known', label: 'Abilities' }], 'combat', () => {
      this.selected = null;
      this.render();
    });
    this.body.classList.add('n-skills-body');
    this.body.append(this.tabs.el, h('div', { class: 'n-skills-cols' }, this.list, this.detail));
  }

  private player(): PlayerState | undefined {
    return this.host.ctx.state.player;
  }

  /** All skills to show: catalog plus any the player has that the catalog lacks. */
  private allSkills(): SkillDef[] {
    const p = this.player();
    const known = new Set(SKILLS.map((s) => s.id));
    const extra = Object.keys(p?.skills?.skills ?? {}).filter((id) => !known.has(id)).map(skillOrStub);
    return [...SKILLS, ...extra];
  }

  protected override onOpen(data?: unknown) {
    const d = data as { skill?: string } | undefined;
    if (d?.skill) {
      const def = skillOrStub(d.skill);
      this.tabs.set(def.category);
      this.selected = d.skill;
    }
    this.sig = '';
    this.refresh();
  }

  protected override onClose() {
    tooltip.hide();
  }

  refresh() {
    if (!this.isOpen) return;
    const p = this.player();
    const sig = JSON.stringify([p?.skills?.skills, p?.skills?.abilities, this.tabs.value, this.selected]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.render();
  }

  private render() {
    const p = this.player();
    if (!p) return;
    const all = this.allSkills();
    for (const c of SKILL_CATEGORIES) this.tabs.setCount(c.id, all.filter((s) => s.category === c.id).length);
    this.tabs.setCount('known', p.skills.abilities.length);
    if (this.tabs.value === 'known') return this.renderKnown(p);
    const cat = this.tabs.value as SkillCategory;
    const skills = all.filter((s) => s.category === cat).sort((a, b) => (p.skills.skills[b.id]?.level ?? 0) - (p.skills.skills[a.id]?.level ?? 0) || a.name.localeCompare(b.name));
    if (!this.selected || !skills.some((s) => s.id === this.selected)) this.selected = skills[0]?.id ?? null;
    const rows: HTMLElement[] = [];
    let lastSchool = '';
    for (const s of cat === 'magic' ? skills.slice().sort((a, b) => (a.school ?? '').localeCompare(b.school ?? '')) : skills) {
      if (cat === 'magic' && s.school && s.school !== lastSchool) {
        lastSchool = s.school;
        rows.push(h('div', { class: 'n-school', style: { color: skillLook(s)[1] }, text: titleize(s.school) }));
      }
      const prog = p.skills.skills[s.id] ?? { level: 0, xp: 0 };
      const need = xpForLevel(prog.level);
      rows.push(h('div', {
        class: `n-row n-skill-row ${s.id === this.selected ? 'active' : ''} ${prog.level === 0 && prog.xp === 0 ? 'untrained' : ''}`,
        attrs: { tabindex: 0, role: 'button' },
        onclick: () => { this.selected = s.id; this.render(); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { this.selected = s.id; this.render(); } },
      },
        h('img', { class: 'n-skill-icon', attrs: { src: skillIcon(s), alt: '' } }),
        h('div', { class: 'n-skill-main' },
          h('div', { class: 'n-skill-name' }, h('span', { text: s.name }), h('b', { text: String(prog.level) })),
          h('div', { class: 'n-xpbar' }, h('i', { style: { transform: `scaleX(${Math.min(1, prog.xp / Math.max(1, need)).toFixed(3)})` } })),
        ),
      ));
    }
    if (!rows.length) rows.push(h('div', { class: 'n-empty', text: 'No skills of this kind are known in this world.' }));
    this.list.replaceChildren(...rows);
    this.renderDetail(p);
  }

  private renderDetail(p: PlayerState) {
    if (!this.selected) {
      setChildren(this.detail, h('div', { class: 'n-empty', text: 'Select a skill.' }));
      return;
    }
    const s = skillOrStub(this.selected);
    const prog = p.skills.skills[s.id] ?? { level: 0, xp: 0 };
    const need = xpForLevel(prog.level);
    const [, color] = skillLook(s);
    const unlocks = s.unlocks.slice().sort((a, b) => a.level - b.level);
    const maxLvl = Math.max(prog.level + 5, ...unlocks.map((u) => u.level), 10);
    const timeline = h('div', { class: 'n-timeline', style: { '--c': color } },
      h('div', { class: 'n-tl-track' }, h('i', { style: { width: `${Math.min(100, ((prog.level + prog.xp / Math.max(1, need)) / maxLvl) * 100)}%` } })),
      ...unlocks.map((u) => {
        const unlocked = p.skills.abilities.includes(u.ability) || prog.level >= u.level;
        const def = abilityOrStub(u.ability);
        const node = h('div', { class: `n-tl-node ${unlocked ? 'on' : ''}`, style: { left: `${(u.level / maxLvl) * 100}%` } },
          h('img', { attrs: { src: abilityIcon(def, s, !unlocked), alt: '' } }),
          h('span', { text: String(u.level) }),
        );
        tooltip.bind(node, () => abilityCard(def, { unlocked, unlockLevel: u.level }));
        return node;
      }),
    );
    const cards = unlocks.map((u) => this.abilityCardEl(u.ability, p, u.level));
    setChildren(this.detail,
      h('div', { class: 'n-sd-head' },
        h('img', { class: 'n-sd-icon', attrs: { src: skillIcon(s), alt: '' } }),
        h('div', null,
          h('div', { class: 'n-sd-name', text: s.name }),
          h('div', { class: 'n-sd-sub', style: { color: s.school ? color : CATEGORY_COLOR[s.category] }, text: [s.school ? titleize(s.school) : '', titleize(s.category)].filter(Boolean).join(' · ') }),
        ),
        h('div', { class: 'n-sd-level' }, h('span', { text: 'Level' }), h('b', { text: String(prog.level) })),
      ),
      s.description ? h('p', { class: 'n-sd-desc', text: s.description }) : null,
      h('div', { class: 'n-sd-xp' },
        h('div', { class: 'n-xpbar big' }, h('i', { style: { transform: `scaleX(${Math.min(1, prog.xp / Math.max(1, need)).toFixed(3)})` } })),
        h('span', { class: 'n-dim', text: `${fmtNum(Math.floor(prog.xp))} / ${fmtNum(need)} XP to level ${prog.level + 1}` }),
      ),
      unlocks.length ? h('div', { class: 'n-heading', text: 'Path of mastery' }) : null,
      unlocks.length ? timeline : null,
      unlocks.length ? h('div', { class: 'n-ab-cards' }, ...cards) : h('div', { class: 'n-empty', text: 'This skill improves passively — practise it to grow stronger.' }),
    );
  }

  private abilityCardEl(id: string, p: PlayerState, level?: number): HTMLElement {
    const def = abilityOrStub(id);
    const skill = skillOrStub(def.skill || this.selected || '');
    const unlocked = p.skills.abilities.includes(id);
    const cdLeft = (p.cooldowns?.[id] ?? 0) - this.host.serverNow();
    const onBar = p.skills.hotbar.indexOf(id);
    const cost = [def.cost.mana ? `${def.cost.mana} mana` : '', def.cost.stamina ? `${def.cost.stamina} stamina` : '', def.cost.hp ? `${def.cost.hp} health` : ''].filter(Boolean).join(' · ');
    const el = h('div', { class: `n-ab-card ${unlocked ? 'n-interactive' : 'locked'}`, attrs: { tabindex: unlocked ? 0 : -1 } },
      h('img', { class: 'n-ab-icon', attrs: { src: abilityIcon(def, skill, !unlocked), alt: '', draggable: 'false' } }),
      h('div', { class: 'n-ab-main' },
        h('div', { class: 'n-ab-name' }, h('span', { text: def.name }), onBar >= 0 ? h('span', { class: 'n-key', text: String((onBar + 1) % 10) }) : null),
        h('div', { class: 'n-ab-meta', text: unlocked ? [cost, def.cooldown ? `${fmtDuration(def.cooldown)} cd` : '', def.targeting !== 'passive' ? titleize(def.targeting) : 'Passive'].filter(Boolean).join(' · ') : `Unlocks at level ${level ?? '?'}` }),
        def.description ? h('div', { class: 'n-ab-desc', text: def.description }) : null,
      ),
    );
    tooltip.bind(el, () => abilityCard(def, { unlocked, unlockLevel: level, cooldownLeft: cdLeft, hint: unlocked && def.targeting !== 'passive' ? 'Drag onto the hotbar, or press Enter to place it in the first free slot' : undefined }));
    if (unlocked && def.targeting !== 'passive') {
      drag.source(el, () => ({ kind: 'ability', id }), () => abilityIcon(def, skill));
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const hb = p.skills.hotbar;
        let slot = -1;
        for (let i = 0; i < 10; i++) if (!hb[i]) { slot = i; break; }
        if (slot >= 0) this.host.ctx.send({ t: 'hotbar', slot, value: id });
        else this.host.notify('Your hotbar is full — drag the ability onto a slot to replace it.', 'warn');
      });
    }
    return el;
  }

  private renderKnown(p: PlayerState) {
    const ids = p.skills.abilities;
    this.list.replaceChildren(h('div', { class: 'n-faint', style: 'padding:6px 4px;font-size:12px', text: 'Every ability you have unlocked. Drag them onto your hotbar.' }));
    if (!ids.length) {
      setChildren(this.detail, h('div', { class: 'n-empty', text: 'No abilities unlocked yet. Use skills to grow — new abilities awaken at milestones.' }));
      return;
    }
    const bySkill = new Map<string, string[]>();
    for (const id of ids) {
      const s = abilityOrStub(id).skill || 'other';
      bySkill.set(s, [...(bySkill.get(s) ?? []), id]);
    }
    setChildren(this.detail, ...[...bySkill].map(([s, list]) => h('div', null,
      h('div', { class: 'n-heading', text: s === 'other' ? 'Other' : skillOrStub(s).name }),
      h('div', { class: 'n-ab-cards' }, ...list.map((id) => this.abilityCardEl(id, p))),
    )));
  }
}
