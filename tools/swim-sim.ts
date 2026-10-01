/**
 * Swimming check with the real PlayerController: deep water (sea level 0) over a
 * sloping beach. Swims forward, stops to tread water, then swims to the shore.
 *
 *  - front crawl: the hips (pivot of the horizontal body, ~0.54·height above the
 *    feet) float just under the surface, so the body is not fully submerged;
 *  - treading water: head and shoulders out (feet ~0.72·height under water);
 *  - the swimming state never flickers on/off in open water;
 *  - the player can walk out of the water at the beach.
 *
 *   npx tsx tools/swim-sim.ts
 */
import { PlayerController, type MoveInput, type Modifiers } from '../src/client/playerController';
import { StaticColliderStore } from '../src/client/staticColliders';

// Seabed: 12 m deep for z > 40, rising to 2 m above sea level at z = 0 (beach towards −z).
const bed = (z: number) => (z > 40 ? -12 : z < 0 ? 2 : 2 - (z / 40) * 14);
const terrain = {
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) {
    if (dy >= 0) return null;
    const g = bed(oz);
    if (oy < g) return null;
    const t = (oy - g) / -dy;
    return t <= max ? { x: ox, y: g, z: oz, nx: 0, ny: 1, nz: 0, dist: t } : null;
  },
  sphereContact(x: number, y: number, z: number, r: number) {
    const depth = r - (y - bed(z));
    return depth > 0 ? { px: 0, py: depth, pz: 0, nx: 0, ny: 1, nz: 0, depth } : null;
  },
};
const gen = { cachedColumn: (_x: number, z: number) => ({ height: bed(z) }), isUnderworld: () => false };

const pc = new PlayerController(terrain as never, gen as never, new StaticColliderStore() as never, () => 9.81);
const H = 1.75;
pc.teleport(0, -1.2, 120);
const input: MoveInput = { forward: 0, right: 0, jump: false, jumpPressed: false, sprint: false, crouch: false, walk: false, camYaw: 0, camPitch: 0, faceCamera: false };
const mods: Modifiers = { moveSpeed: 1, jump: 1, gravityMul: 1, effects: new Set(), stamina: 100, scale: 1 };

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${detail}`);
};

function run(seconds: number, forward: number, until?: () => boolean) {
  let flips = 0, prev = pc.swimming;
  const ys: number[] = [];
  for (let f = 0; f < seconds * 60; f++) {
    input.forward = forward;
    pc.update(1 / 60, input, mods);
    if (pc.swimming !== prev) flips++;
    prev = pc.swimming;
    ys.push(pc.pos.y);
    if (until?.()) break;
  }
  const tail = ys.slice(-60);
  return { flips, y: tail.reduce((a, b) => a + b, 0) / tail.length };
}

// Settle in deep water, then swim forward (towards −z) in open water.
run(3, 0);
const crawl = run(4, 1, () => pc.pos.z < 60);
const hips = crawl.y + 0.54 * H - 0.15; // Animator.swim lowers the root 0.15 m while crawling
check('front crawl floats near the surface', pc.swimming && hips > -0.3 && hips < 0.05, `hips ${hips.toFixed(2)} m relative to the water`);
check('no swim state flicker while crawling', crawl.flips === 0, `${crawl.flips} flips`);
// Stop and tread water.
pc.teleport(0, crawl.y, 100);
const tread = run(4, 0);
const head = tread.y + H * 0.93;
check('treading water keeps the head out', pc.swimming && head > 0.15 && head < 0.7, `head ${head.toFixed(2)} m above the water`);
check('no swim state flicker while treading', tread.flips === 0, `${tread.flips} flips`);
// Swim to the beach and walk out.
const shore = run(60, 1, () => pc.pos.z < -2);
check('walks out at the beach', !pc.swimming && pc.pos.z < 5 && pc.pos.y > -0.05, `z ${pc.pos.z.toFixed(1)}, y ${pc.pos.y.toFixed(2)}, swimming ${pc.swimming}, flips ${shore.flips}`);
check('leaves the water cleanly (≤ 2 state changes)', shore.flips <= 2, `${shore.flips} changes`);
process.exit(failures ? 1 : 0);
