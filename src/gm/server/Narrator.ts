/**
 * Narrator: turns world observations into second-person narration with
 * variety and restraint. Each trigger has its own throttle so the GM speaks at
 * meaningful moments (first visits, transitions, milestones) rather than
 * constantly, and every line pulls world-specific vocabulary from the lore and
 * the world's palette.
 */
import type { ServerEntity } from '../../server/entity';
import type { WeatherState } from '../../shared/types';
import type { PoiInfo, SiteInfo } from '../../world/sites';
import { Biome, BIOMES } from '../../world/biomes';
import { biomeLegend, poiLore, siteLore, getLore } from '../lore';
import * as N from '../narration';
import { compass, hourWords, list, expand } from '../text';
import type { GmHost, PlayerGm } from './state';
import { getPlayerData } from './access';
import { humanize } from './QuestBook';
import { skillDef, abilityDef } from '../../gameplay/data/catalog';

export class Narrator {
  constructor(private host: GmHost) {}

  private compose(p: ServerEntity, key: string, pool: N.Pool, extra: Record<string, string | number | undefined> = {}): string {
    const g = this.host.state(p);
    return g.variety.compose(key, pool, this.host.rng(g, 'narr', key), { ...this.host.vars(p), ...extra });
  }

  // ------------------------------------------------------------ places

  onBiome(p: ServerEntity, biome: Biome) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    const first = !g.visitedBiomes.has(biome);
    // Biome borders can flicker; only narrate a biome after a pause, unless new.
    if (!first && g.throttle(`biome:${biome}`, now, 600)) return;
    if (first) g.flags[`biome:${biome}`] = now;
    g.visitedBiomes.add(biome);
    if (first) g.model.onDiscover('biome');
    const pool = N.BIOME_ARRIVAL[biome];
    if (!pool) return;
    const name = BIOMES[biome].name;
    let text = this.compose(p, `biome.${biome}`, pool, { biome: name });
    const lead = first ? this.compose(p, 'biome.first', N.BIOME_FIRST, { biome: name }) : '';
    if (first) {
      const leg = biomeLegend(this.host.ctx.gen.profile, biome);
      if (leg && this.host.rng(g, 'leg').chance(0.6)) text += ' ' + leg.text;
    }
    this.host.say(p, 'narration', lead ? `${lead} ${text}` : text, { title: name, priority: first ? 'normal' : 'ambient', tone: 'wonder' });
    if (first) g.beat(`First set foot in the ${name}.`, now, this.host.ctx.time.day);
  }

  onUnderworld(p: ServerEntity, entering: boolean) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    if (g.throttle(entering ? 'uw:in' : 'uw:out', now, 240)) return;
    const first = entering && !g.flags['uw:ever'];
    if (entering) {
      g.flags['uw:ever'] = now;
      if (first) {
        g.model.onDiscover('underworld');
        g.beat(`Descended into ${this.host.lore.underworldName} for the first time.`, now, this.host.ctx.time.day);
      }
    }
    this.host.say(p, 'narration', this.compose(p, entering ? 'uw.in' : 'uw.out', entering ? N.UNDERWORLD_ENTER : N.UNDERWORLD_LEAVE), {
      title: entering ? this.cap(this.host.lore.underworldName) : undefined, tone: entering ? 'dread' : 'calm', priority: 'normal',
    });
  }

  onGravity(p: ServerEntity, band: -1 | 0 | 1, prev: -1 | 0 | 1) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    if (band === 0) {
      if (g.throttle('grav:normal', now, 90)) return;
      this.host.say(p, 'narration', this.compose(p, 'grav.n', N.GRAVITY_NORMAL), { priority: 'ambient' });
      return;
    }
    if (g.throttle(band < 0 ? 'grav:low' : 'grav:high', now, 180)) return;
    if (!g.flags['grav:ever']) {
      g.flags['grav:ever'] = now;
      g.beat(`Felt the pull of the world change in one of the ${this.host.lore.anomalyName}.`, now, this.host.ctx.time.day);
      g.model.bump('explorer', 1);
    }
    this.host.say(p, 'narration', this.compose(p, band < 0 ? 'grav.l' : 'grav.h', band < 0 ? N.GRAVITY_LOW : N.GRAVITY_HIGH), { tone: 'wonder', priority: 'normal' });
  }

  onSite(p: ServerEntity, site: SiteInfo, first: boolean) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    if (!first && g.throttle(`site:${site.id}`, now, 900)) return;
    if (first) g.flags[`site:${site.id}`] = now;
    const sl = siteLore(this.host.ctx.gen.profile, site);
    const vars = { name: site.name, line: sl.line, inn: sl.inn, people: this.peopleOf(site) };
    let text = first ? this.compose(p, 'site.first', N.SITE_FIRST, vars) : this.compose(p, 'site.again', N.SITE_AGAIN, vars);
    const power = sl.power;
    if (power && (g.bounty[power.id] ?? 0) > 0) text += ' ' + this.compose(p, 'site.wanted', N.SITE_WANTED, vars);
    else {
      const rep = getPlayerData(this.host.ctx, p.id)?.reputation ?? {};
      if ((rep[`site.${site.id}`] ?? 0) + (power ? rep[power.id] ?? 0 : 0) >= 20) text += ' ' + this.compose(p, 'site.hero', N.SITE_HERO, vars);
    }
    if (first) {
      text += ` Folk here speak of ${sl.trouble}.`;
      g.model.onDiscover('site');
      g.beat(`Arrived at ${site.name}.`, now, this.host.ctx.time.day);
    }
    this.host.say(p, 'narration', text, { title: site.name, priority: first ? 'normal' : 'ambient', pos: [site.x, site.plateau, site.z] });
  }

  private peopleOf(site: SiteInfo): string {
    const names: Record<string, string> = { human: 'Farmers', elf: 'Elves', dwarf: 'Dwarves', orc: 'Orcs', halfling: 'Halflings', goblin: 'Goblins', sylvan: 'Sylvans', drakeborn: 'Scaled drakeborn', umbral: 'Hooded umbrals', giantkin: 'Towering giantkin' };
    return names[site.race] ?? 'Locals';
  }

  onPoi(p: ServerEntity, poi: PoiInfo) {
    const g = this.host.state(p);
    const pl = poiLore(this.host.ctx.gen.profile, poi);
    g.model.onDiscover('poi');
    const text = this.compose(p, 'poi', N.POI_DISCOVER, { poiname: pl.name, legend: pl.legend });
    // Urgent: a discovery is a key moment, and any quest it spawns should follow it.
    this.host.say(p, 'narration', text, { title: this.cap(pl.name), pos: [poi.x, poi.y, poi.z], tone: 'wonder', priority: 'urgent' });
    g.beat(`Discovered ${pl.name}.`, this.host.ctx.time.now, this.host.ctx.time.day);
  }

  // ------------------------------------------------------------ time & weather

  onHour(p: ServerEntity, hour: number) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    const underground = g.live.underworld;
    if (hour === 20 && !underground && !g.throttle('nightfall', now, 300)) {
      const moonless = this.host.lore.moons.length === 0;
      this.host.say(p, 'narration', this.compose(p, 'night', moonless ? N.NIGHTFALL_MOONLESS : N.NIGHTFALL), { tone: 'tense', priority: 'ambient' });
    } else if (hour === 6 && !underground && !g.throttle('dawn', now, 300)) {
      this.host.say(p, 'narration', this.compose(p, 'dawn', N.DAWN), { tone: 'calm', priority: 'ambient' });
    }
  }

  onWeather(p: ServerEntity, w: WeatherState) {
    const g = this.host.state(p);
    if (g.live.underworld) return;
    if (g.throttle(`weather:${w.kind}`, this.host.ctx.time.now, 240)) return;
    if (w.kind === 'cloudy' && this.host.rng(g, 'cloud').chance(0.5)) return;
    const wind = compass(w.windX, w.windZ);
    this.host.say(p, 'narration', this.compose(p, `weather.${w.kind}`, N.WEATHER[w.kind], { wind }), { priority: 'ambient', tone: w.kind === 'storm' ? 'tense' : undefined });
  }

  // ------------------------------------------------------------ growth

  onLevel(p: ServerEntity, skill: string, level: number) {
    const g = this.host.state(p);
    const name = skillDef(skill)?.name ?? humanize(skill);
    const milestone = level % 10 === 0 && level > 0;
    // Low levels come fast; narrate every level early on, then milestones and every 5th.
    if (!milestone && level > 5 && level % 5 !== 0) return;
    const text = this.compose(p, milestone ? 'lvl.m' : 'lvl', milestone ? N.LEVEL_MILESTONE : N.LEVEL_UP, { skill: name, level });
    this.host.say(p, 'narration', text, { priority: milestone ? 'urgent' : 'normal', tone: milestone ? 'triumph' : undefined });
    if (milestone) g.beat(`Reached level ${level} in ${name}.`, this.host.ctx.time.now, this.host.ctx.time.day);
  }

  onUnlock(p: ServerEntity, ability: string) {
    const g = this.host.state(p);
    const name = abilityDef(ability)?.name ?? humanize(ability);
    this.host.say(p, 'narration', this.compose(p, 'unlock', N.UNLOCK, { ability: name }), { priority: 'urgent', tone: 'triumph' });
    g.beat(`Learned ${name}.`, this.host.ctx.time.now, this.host.ctx.time.day);
  }

  // ------------------------------------------------------------ danger & death

  onNearDeath(p: ServerEntity) {
    const g = this.host.state(p);
    if (g.throttle('neardeath', this.host.ctx.time.now, 75)) return;
    this.host.say(p, 'narration', this.compose(p, 'nd', N.NEAR_DEATH), { priority: 'urgent', tone: 'dread', noLog: true });
  }

  onDeath(p: ServerEntity, killerName: string | null) {
    const g = this.host.state(p);
    const text = killerName ? this.compose(p, 'death.by', N.DEATH_BY, { killer: killerName }) : this.compose(p, 'death', N.DEATH);
    this.host.say(p, 'narration', text, { priority: 'urgent', tone: 'grief' });
    g.beat(killerName ? `Fell to ${killerName}.` : 'Died, and came back.', this.host.ctx.time.now, this.host.ctx.time.day);
  }

  onKill(p: ServerEntity, label: string, boss: boolean, nemesis: boolean, bossName: string) {
    const g = this.host.state(p);
    const now = this.host.ctx.time.now;
    if (nemesis) {
      this.host.say(p, 'narration', this.compose(p, 'kill.nem', N.NEMESIS_KILL, { name: bossName }), { priority: 'urgent', tone: 'triumph' });
      g.beat(`Ended the feud with ${bossName}.`, now, this.host.ctx.time.day);
      return;
    }
    if (boss && bossName) {
      this.host.say(p, 'narration', this.compose(p, 'kill.boss', N.BOSS_KILL, { name: bossName }), { priority: 'urgent', tone: 'triumph' });
      g.beat(`Slew ${bossName}.`, now, this.host.ctx.time.day);
      return;
    }
    if (!g.seenSpecies.has(label)) {
      g.seenSpecies.add(label);
      if (g.throttle('firstkill', now, 20)) return;
      this.host.say(p, 'narration', this.compose(p, 'kill.first', N.FIRST_KILL, { what: label }), { priority: 'normal' });
      if (g.model.history.kills <= 1) g.beat(`Took a first life: a ${label}.`, now, this.host.ctx.time.day);
    }
  }

  // ------------------------------------------------------------ recaps

  /**
   * "Previously on..." — summarises the story beats, open quests and how the
   * world sees the player. Used after long absences, on return from a save,
   * and when the player asks for it.
   */
  recap(p: ServerEntity, reason: 'return' | 'idle' | 'asked'): string {
    const g = this.host.state(p);
    const lore = getLore(this.host.ctx.gen.profile);
    const r = this.host.rng(g, 'recap');
    const parts: string[] = [];
    parts.push(g.variety.compose('recap.open', N.RECAP_OPEN, r, this.host.vars(p)));
    const beats = g.beats.slice(-6);
    if (beats.length) {
      const lines = beats.map((b) => b.text.replace(/\.$/, ''));
      parts.push(`You ${list(lines.map((l) => this.toPast(l)))}.`);
    } else parts.push(`Your story in ${lore.worldName} has barely begun.`);
    const active = g.quests.filter((q) => q.status === 'active');
    if (active.length) {
      const tracked = active.find((q) => q.tracked) ?? active[0];
      parts.push(`Unfinished: ${list(active.slice(0, 3).map((q) => q.spec.title))}.${tracked ? ` Most pressing is ${tracked.spec.title}.` : ''}`);
    }
    const bountyTotal = Object.values(g.bounty).reduce((a, b) => a + b, 0);
    if (bountyTotal > 0) parts.push(`There is still a price of ${Math.round(bountyTotal)} coins on your head.`);
    const nem = g.nemeses.find((n) => !n.defeated);
    if (nem) parts.push(`${nem.name} is still out there, and it remembers you.`);
    const style = g.model.dominant();
    const styleLine: Record<string, string> = {
      explorer: 'The world knows you as one who goes where maps run out.', fighter: 'Your name is spoken with a certain wariness — they say you settle things with steel.',
      socializer: 'People talk about you, and mostly kindly; you have a way with words.', crafter: 'Folk say you have clever hands and an eye for good materials.',
      mage: 'Rumours say the old powers answer when you call.', sneak: 'Few have seen you coming. That is how you like it.',
    };
    if (g.model.confidence() > 0.06 && g.model.history.playTime > 600) parts.push(styleLine[style]);
    if (reason === 'return') parts.push(expand('{It is $time in $world.|In $world it is $time.}', r, { time: hourWords(this.host.ctx.time.hour), world: lore.worldName }));
    return parts.join(' ');
  }

  /** "Arrived at X" → "arrived at X" for list joining (beats are already past tense). */
  private toPast(l: string): string {
    return l.charAt(0).toLowerCase() + l.slice(1);
  }

  private cap(s: string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  ambientIdle(p: ServerEntity, g: PlayerGm) {
    const legend = this.host.rng(g, 'idle').pick(this.host.lore.legends).text;
    this.host.say(p, 'narration', this.compose(p, 'idle', N.IDLE, { legend }), { priority: 'ambient' });
  }
}
