/** Accessor for per-player data owned by the PlayerSystem (journal, cooldowns, reputation, gravity, home). */
import type { ServerContext } from '../context';
import type { EntityId } from '../../shared/types';
import type { PlayerData, PlayerSystem } from './PlayerSystem';

export function getPlayerData(ctx: ServerContext, id: EntityId): PlayerData | undefined {
  return (ctx as unknown as { playerSys: PlayerSystem }).playerSys.playerData(id);
}
