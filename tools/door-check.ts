/**
 * Doorway check: builds every settlement building around the origin for a few
 * seeds and verifies that nothing intrudes into a doorway's walk-through volume
 * (the hole in the wall plus a little space in front of it): neither colliders
 * (physically blocking) nor axis-aligned visual parts (beams/posts that look
 * blocking). Door leaves themselves are ignored (they open).
 *
 *   npx tsx tools/door-check.ts [seeds=6] [radius=2500]
 */
import { WorldGenerator } from '../src/world/generator';
import { layoutSettlement, terrainFromGenerator } from '../src/settlements/layout';
import { blueprintFor } from '../src/settlements/build/blueprint';

const seeds = Number(process.argv[2] ?? 6);
const radius = Number(process.argv[3] ?? 2500);

function rot(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

let doors = 0, blockedCols = 0, blockedPrims = 0, buildings = 0;
const examples: string[] = [];
for (let seed = 1; seed <= seeds; seed++) {
  const gen = new WorldGenerator(seed * 7919);
  const terrain = terrainFromGenerator(gen);
  for (const site of gen.sites.sitesNear(0, 0, radius)) {
    const layout = layoutSettlement(site, terrain);
    for (const b of layout.buildings) {
      const bp = blueprintFor(b);
      buildings++;
      bp.pieces.forEach((door, di) => {
        if (!door.door) return;
        doors++;
        const d = door.door;
        // Door frame: hinge at the leaf's left edge, leaf along local +x, outside = local +z.
        const [ax, az] = rot(d.width / 2, 0, d.yaw);
        const cx = d.x + ax, cz = d.z + az;
        // Point (building frame) → doorway coords: u along the door, v outward, y up.
        const toDoor = (x: number, z: number): [number, number] => rot(x - cx, z - cz, -d.yaw);
        const inside = (u: number, v: number, y: number) =>
          Math.abs(u) < d.width / 2 - 0.08 && v > -0.2 && v < 0.6 && y > 0.25 && y < d.height - 0.2;
        bp.pieces.forEach((pc, pi) => {
          if (pi === di || pc.kind === 'door') return;
          for (const c of pc.cols) {
            if (!c.solid) continue;
            // Sample the collider box on a coarse grid.
            let hit = false;
            for (let i = 0; i <= 4 && !hit; i++)
              for (let j = 0; j <= 4 && !hit; j++)
                for (let k = 0; k <= 4 && !hit; k++) {
                  const [lx, lz] = rot(c.hx * (i / 2 - 1), c.hz * (k / 2 - 1), c.yaw);
                  const [u, v] = toDoor(c.x + lx, c.z + lz);
                  if (inside(u, v, c.y + c.hy * (j / 2 - 1))) hit = true;
                }
            if (hit) {
              blockedCols++;
              if (examples.length < 12) examples.push(`collider ${pc.kind} in ${b.role}/${b.style ?? ''} door (seed ${seed} ${site.name})`);
            }
          }
          for (const p of pc.prims) {
            if (p.shape !== 0 || Math.abs(p.rx) > 1e-3 || Math.abs(p.rz) > 1e-3) continue; // axis-aligned boxes only
            let hit = false;
            for (let i = 0; i <= 4 && !hit; i++)
              for (let j = 0; j <= 4 && !hit; j++)
                for (let k = 0; k <= 4 && !hit; k++) {
                  const [lx, lz] = rot((p.a / 2) * (i / 2 - 1), (p.b / 2) * (k / 2 - 1), p.ry);
                  const [u, v] = toDoor(p.x + lx, p.z + lz);
                  if (inside(u, v, p.y + (p.h * j) / 4)) hit = true;
                }
            if (hit) {
              blockedPrims++;
              if (examples.length < 12) examples.push(`part of ${pc.kind} (w ${p.a.toFixed(2)} h ${p.h.toFixed(2)} d ${p.b.toFixed(2)} y ${p.y.toFixed(2)} v ${toDoor(p.x, p.z)[1].toFixed(2)} surf ${p.surf}) in ${b.role}/${b.style ?? ''} door (seed ${seed} ${site.name})`);
              break;
            }
          }
        });
      });
    }
  }
}
console.log(`${buildings} buildings, ${doors} doors: ${blockedCols} blocking colliders, ${blockedPrims} pieces with parts in a doorway`);
for (const e of examples) console.log('  ' + e);
process.exit(blockedCols + blockedPrims > 0 ? 1 : 0);
