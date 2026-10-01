/**
 * Creature references shared over the network. Species are generated
 * deterministically from the world's fauna seed, so a snapshot only needs the
 * species index and an individual seed.
 */
export interface CreatureRef {
  /** Index into the world's species list. */
  species: number;
  /** Individual variation seed (size, color jitter, scars). */
  seed: number;
  /** 0..1 growth (juveniles are smaller). */
  growth: number;
  /** Current behaviour label (for animation flavour & debug), e.g. "graze", "flee", "hunt". */
  behavior?: string;
}
