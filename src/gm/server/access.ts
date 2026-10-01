/**
 * Narrow accessors from the game master to lead-owned server systems, mirroring
 * `src/server/systems/playerData.ts`: the GameServer exposes `worldSys` and
 * `playerSys`; we reach them through one documented cast in one place instead
 * of sprinkling `(ctx as any)` around the GM.
 */
import type { ServerContext } from '../../server/context';
import type { ServerEntity } from '../../server/entity';
import type { ClientMessage } from '../../shared/protocol';
import type { WeatherState } from '../../shared/types';
import type { WorldSystem } from '../../server/systems/WorldSystem';
import type { PlayerSystem } from '../../server/systems/PlayerSystem';

export { getPlayerData } from '../../server/systems/playerData';

function worldSystem(ctx: ServerContext): WorldSystem | undefined {
  return (ctx as unknown as { worldSys?: WorldSystem }).worldSys;
}

/** Force the weather (locks the random weather roll for `lockSeconds`). */
export function setWeather(ctx: ServerContext, w: WeatherState, lockSeconds: number): boolean {
  const ws = worldSystem(ctx);
  if (!ws) return false;
  ws.setWeather(w, lockSeconds);
  return true;
}

/** Seconds until the world system may roll weather again (0 if unlocked). */
export function weatherLockedFor(ctx: ServerContext): number {
  const ws = worldSystem(ctx);
  return ws ? Math.max(0, ws.lockedUntil - ctx.time.now) : 0;
}

/** Real seconds per in-game day. */
export function dayLength(ctx: ServerContext): number {
  return worldSystem(ctx)?.dayLength ?? ctx.gen.profile.dayLengthSec;
}

type DebugHandler = (player: ServerEntity, args: unknown[]) => void;

/**
 * The PlayerSystem consumes every `{t:'debug'}` message before later systems
 * see it. To receive our own debug command (`gmLlmConfig`) without editing the
 * lead's file, we wrap its `onMessage` once and route matching commands to
 * `handler` first. Wrappers chain, so other domains can use the same trick.
 * If the lead later lets unknown debug commands fall through, the GM's own
 * `onMessage` handles them too and this wrapper simply never fires twice
 * (the wrapper consumes the message).
 */
export function interceptDebug(ctx: ServerContext, cmd: string, handler: DebugHandler): boolean {
  const ps = (ctx as unknown as { playerSys?: PlayerSystem }).playerSys;
  if (!ps) return false;
  const prev = ps.onMessage.bind(ps);
  ps.onMessage = (player: ServerEntity, msg: ClientMessage): boolean => {
    if (msg.t === 'debug' && msg.cmd === cmd) {
      handler(player, msg.args ?? []);
      return true;
    }
    return prev(player, msg);
  };
  return true;
}
