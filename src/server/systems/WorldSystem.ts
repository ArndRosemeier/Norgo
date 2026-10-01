/** Time of day, calendar and weather simulation. */
import type { ServerContext, ServerSystem } from '../context';
import type { WeatherKind, WeatherState } from '../../shared/types';
import { Biome } from '../../world/biomes';

export class WorldSystem implements ServerSystem {
  readonly name = 'world';
  private ctx!: ServerContext;
  private lastHour = -1;
  private weatherTimer = 120;
  private broadcastTimer = 0;
  /** Seconds of real time per in-game day. */
  dayLength = 1800;
  /** Game master may lock weather for a while. */
  lockedUntil = 0;

  init(ctx: ServerContext) {
    this.ctx = ctx;
    this.dayLength = ctx.gen.profile.dayLengthSec;
  }

  tick(dt: number) {
    const t = this.ctx.time;
    t.timeOfDay += dt / this.dayLength;
    if (t.timeOfDay >= 1) {
      t.timeOfDay -= 1;
      t.day++;
    }
    t.hour = t.timeOfDay * 24;
    const h = Math.floor(t.hour);
    if (h !== this.lastHour) {
      this.lastHour = h;
      this.ctx.bus.emit('timeOfDay', { hour: h, day: t.day });
    }
  }

  slowTick(dt: number) {
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0 && this.ctx.time.now > this.lockedUntil) {
      this.weatherTimer = 180 + Math.random() * 420;
      this.rollWeather();
    }
    this.broadcastTimer -= dt;
    if (this.broadcastTimer <= 0) {
      this.broadcastTimer = 5;
      this.pushWorld();
    }
  }

  /** Force weather (game master / spells). */
  setWeather(w: WeatherState, lockSeconds = 0) {
    this.ctx.weather = w;
    this.lockedUntil = this.ctx.time.now + lockSeconds;
    this.ctx.bus.emit('weatherChanged', { weather: w });
    this.pushWorld();
  }

  private pushWorld() {
    for (const p of this.ctx.players()) {
      this.ctx.send(p.id, { t: 'world', timeOfDay: this.ctx.time.timeOfDay, day: this.ctx.time.day, weather: this.ctx.weather });
    }
  }

  /** Weather depends on the biome around the (first) player. */
  private rollWeather() {
    const p = this.ctx.players()[0];
    let biome = Biome.Grassland;
    if (p) biome = this.ctx.gen.biomeAt(p.pos[0], p.pos[2]);
    const opts: [WeatherKind, number][] = [['clear', 4], ['cloudy', 3], ['rain', 1.5], ['storm', 0.5], ['fog', 0.8]];
    switch (biome) {
      case Biome.Desert:
      case Biome.SaltFlats:
      case Biome.Badlands:
        opts.splice(0, opts.length, ['clear', 6], ['cloudy', 1], ['storm', 0.3]);
        break;
      case Biome.Tundra:
      case Biome.Glacier:
      case Biome.Taiga:
        opts.push(['snow', 3]);
        break;
      case Biome.Volcanic:
        opts.push(['ashfall', 4]);
        break;
      case Biome.FungalGrove:
        opts.push(['sporefall', 3]);
        break;
      case Biome.Swamp:
      case Biome.Jungle:
        opts.push(['rain', 3], ['fog', 2]);
        break;
    }
    let total = 0;
    for (const o of opts) total += o[1];
    let r = Math.random() * total;
    let kind: WeatherKind = 'clear';
    for (const o of opts) {
      r -= o[1];
      if (r <= 0) {
        kind = o[0];
        break;
      }
    }
    const a = Math.random() * Math.PI * 2;
    this.setWeather({ kind, intensity: kind === 'clear' ? 0 : 0.35 + Math.random() * 0.65, windX: Math.cos(a), windZ: Math.sin(a) });
  }

  save() {
    return { weather: this.ctx.weather };
  }

  load(d: unknown) {
    const data = d as { weather?: WeatherState };
    if (data.weather) this.ctx.weather = data.weather;
  }
}
