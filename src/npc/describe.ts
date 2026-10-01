/**
 * Spatial phrasing shared by NPC goals, barks and dialog: compass directions,
 * culture-flavoured distance phrases ("a short walk", "about 600 paces",
 * "half a day on foot").
 */
import type { Vec3 } from '../shared/types';
import type { RaceId } from '../humanoid/types';

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Compass word from a to b. North is −Z (yaw 0 faces −Z), east is +X. */
export function compass(from: Vec3, to: Vec3): string {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  // Angle clockwise from north.
  const a = Math.atan2(dx, -dz);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS[i];
}

/** Distance phrase; races measure differently (dwarves in tunnels' lengths, elves in leagues...). */
export function distancePhrase(meters: number, race?: RaceId): string {
  if (meters < 60) return 'just over there';
  if (meters < 250) return race === 'goblin' ? 'a quick scurry away' : race === 'halfling' ? 'a short stroll, no more than a song' : 'a short walk';
  const paces = Math.round(meters / 0.8 / 50) * 50;
  if (meters < 1500) {
    switch (race) {
      case 'dwarf': return `about ${Math.round(meters / 100) * 100} strides of good stone`;
      case 'elf': return `some ${paces} paces, no more`;
      case 'giantkin': return `${Math.max(1, Math.round(meters / 300))} giant-steps... many of yours`;
      case 'orc': return `${paces} paces. Walk fast`;
      default: return `about ${paces} paces`;
    }
  }
  const hours = meters / 4500;
  if (hours < 1) return race === 'elf' ? 'less than a league' : 'under an hour on foot';
  if (hours < 4) return `${Math.round(hours)} hour${hours >= 1.5 ? 's' : ''} on foot`;
  if (hours < 8) return 'half a day on foot';
  return `${Math.max(1, Math.round(hours / 8))} day${hours >= 12 ? 's' : ''} of hard walking`;
}

export function describeWay(from: Vec3, to: Vec3, race?: RaceId): { dir: string; dist: string; meters: number } {
  const m = Math.hypot(to[0] - from[0], to[2] - from[2]);
  return { dir: compass(from, to), dist: distancePhrase(m, race), meters: m };
}
