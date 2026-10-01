/**
 * Walks the real PlayerController up a house's front steps (same geometry as
 * settlements/build/shell.ts: 0.2 m rises stacked in front of a raised floor)
 * on flat ground, for several floor heights and approach offsets. Fails if the
 * player gets stuck, bounces (repeatedly loses the ground), or starts climbing.
 *
 *   npx tsx tools/stairs-sim.ts
 */
import { PlayerController, type MoveInput, type Modifiers } from '../src/client/playerController';
import { StaticColliderStore } from '../src/client/staticColliders';

const G = 100; // ground level (well above sea level)
const terrain = {
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) {
    if (dy >= 0 || oy < G) return null;
    const t = (oy - G) / -dy;
    return t <= max ? { x: ox + dx * t, y: G, z: oz + dz * t, nx: 0, ny: 1, nz: 0, dist: t } : null;
  },
  sphereContact(x: number, y: number, z: number, r: number) {
    const depth = r - (y - G);
    return depth > 0 ? { px: 0, py: depth, pz: 0, nx: 0, ny: 1, nz: 0, depth } : null;
  },
};
const gen = { cachedColumn: () => ({ height: G }), isUnderworld: () => false };

let failures = 0;
for (const floor of (process.env.DBG ? [1.0] : [0.4, 1.0, 1.8])) {
  for (const offset of (process.env.DBG ? [0] : [0, 0.35, -0.5])) {
    const cols = new StaticColliderStore();
    const d = 6, w = 5, doorW = 1.1;
    const add = (id: string, x: number, y0: number, z: number, sx: number, sy: number, sz: number) =>
      cols.add({ id, owner: 'house', shape: 'box', pos: [x, y0 + sy / 2, z], half: [sx / 2, sy / 2, sz / 2], yaw: 0, solid: true });
    // Raised floor / foundation, house centred at z = 0, front face at z = d/2.
    add('found', 0, G - 0.6, 0, w, floor + 0.6, d);
    // Front steps (shell.ts): n rises of ≤0.2 m, each 0.3 m deeper than the one above.
    const n = Math.min(12, Math.ceil(floor / 0.2));
    const sh = floor / n;
    for (let i = 0; i < n; i++) {
      const y = -floor + i * sh;
      const depth = (n - i) * 0.3;
      add('step' + i, 0, G + floor + y - 0.3, d / 2 + 0.05 + depth / 2, doorW + 0.7, sh + 0.3, depth);
    }
    const pc = new PlayerController(terrain as never, gen as never, cols as never, () => 9.81);
    pc.teleport(offset, G, d / 2 + n * 0.3 + 2.5);
    const input: MoveInput = { forward: 1, right: 0, jump: false, jumpPressed: false, sprint: false, crouch: false, walk: false, camYaw: 0, camPitch: 0, faceCamera: false };
    const mods: Modifiers = { moveSpeed: 1, jump: 1, gravityMul: 1, effects: new Set(), stamina: 100, scale: 1 };
    let climbed = false, airFrames = 0, prevGround = true, groundLosses = 0;
    for (let f = 0; f < 60 * 5; f++) {
      pc.update(1 / 60, input, mods);
      if (pc.climbing) climbed = true;
      if (!pc.grounded) airFrames++;
      if (prevGround && !pc.grounded) groundLosses++;
      prevGround = pc.grounded;
      if (process.env.DBG && f % 6 === 0 && pc.pos.z < 6.2) { const q: unknown[] = []; cols.query(pc.pos.x - 1, pc.pos.y - 1, pc.pos.z - 1, pc.pos.x + 1, pc.pos.y + 2, pc.pos.z + 1, q as never); console.log(f, pc.pos.z.toFixed(3), (pc.pos.y - G).toFixed(3), pc.grounded, 'vel', pc.vel.z.toFixed(2), pc.vel.y.toFixed(2), 'near', q.length); }
      if (pc.pos.z < d / 2 - 1) break; // inside the house
    }
    const inside = pc.pos.z < d / 2 - 0.5 && Math.abs(pc.pos.y - (G + floor)) < 0.1;
    const ok = inside && !climbed && groundLosses <= 1;
    if (!ok) failures++;
    console.log(`up   floor ${floor.toFixed(1)} m, offset ${offset.toFixed(2)}: ${ok ? 'OK ' : 'FAIL'} z=${pc.pos.z.toFixed(2)} y=${(pc.pos.y - G).toFixed(2)} climbed=${climbed} airFrames=${airFrames} groundLosses=${groundLosses}`);
    // And back out, down the steps (walking backwards relative to the camera).
    input.forward = -1;
    let downAir = 0;
    for (let f = 0; f < 60 * 5; f++) {
      pc.update(1 / 60, input, mods);
      if (!pc.grounded) downAir++;
      if (pc.pos.z > d / 2 + n * 0.3 + 1.5) break;
    }
    const out = pc.pos.z > d / 2 + n * 0.3 + 1 && Math.abs(pc.pos.y - G) < 0.05;
    // Short airborne moments stepping down are fine (≤ 0.15 s total); falling off each step is not.
    const okDown = out && downAir <= 9;
    if (!okDown) failures++;
    console.log(`down floor ${floor.toFixed(1)} m, offset ${offset.toFixed(2)}: ${okDown ? 'OK ' : 'FAIL'} z=${pc.pos.z.toFixed(2)} y=${(pc.pos.y - G).toFixed(2)} airFrames=${downAir}`);
  }
}
process.exit(failures ? 1 : 0);
