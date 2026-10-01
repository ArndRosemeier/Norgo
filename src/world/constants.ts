/** World dimensions & streaming constants (meters, Y is up). */

/** Voxels per chunk edge (cells). A chunk at LOD l spans CHUNK_SIZE * 2^l meters. */
export const CHUNK_SIZE = 32;
/** Extra samples on each side of a chunk grid: 2 below, 2 above (see surface nets). */
export const CHUNK_PAD = 2;
/** Samples per grid axis. */
export const GRID_N = CHUNK_SIZE + CHUNK_PAD * 2;

export const SEA_LEVEL = 0;
export const WORLD_MIN_Y = -416;
export const WORLD_MAX_Y = 832;
/** Hard rock floor: nothing below can be dug. */
export const BEDROCK_Y = WORLD_MIN_Y + 24;

/** Underworld band: a vast cavern layer beneath every continent. */
export const UNDERWORLD_CEIL = -130;
export const UNDERWORLD_FLOOR = -330;
export const UNDERWORLD_SEA_LEVEL = -292;

/** Number of LOD levels (0 = 1m voxels). LOD 6 chunks are 2048 m wide. */
export const MAX_LOD = 6;

/** LOD levels at or above this skip carving caves (they are not visible from afar). */
export const CAVE_LOD_LIMIT = 2;

/** Max radius of a single terrain deformation (keeps deformation "realistic"). */
export const MAX_EDIT_RADIUS = 3.0;
