/**
 * Procedural particle sprite atlas (4×4 cells, generated once on a canvas).
 * No external assets: every sprite is drawn with 2D canvas primitives and a
 * little seeded noise so effects stay crisp at any resolution.
 */
import * as THREE from 'three';

export const enum Sprite {
  Glow = 0,
  Spark = 1,
  Smoke = 2,
  Flame = 3,
  Snow = 4,
  Shard = 5,
  Ring = 6,
  Rune = 7,
  Leaf = 8,
  Streak = 9,
  Star = 10,
  Wisp = 11,
  Chunk = 12,
  Heart = 13,
  Zzz = 14,
  Hex = 15,
}

export const ATLAS_CELLS = 4;
const CELL = 128;

/** Small deterministic PRNG for drawing (cosmetic only). */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function radial(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, stops: [number, string][]) {
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [o, c] of stops) grd.addColorStop(o, c);
  g.fillStyle = grd;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
}

type Painter = (g: CanvasRenderingContext2D, rnd: () => number) => void;

const C = CELL / 2;
const PAINTERS: Painter[] = [
  // Glow: soft gaussian-ish falloff.
  (g) => radial(g, C, C, C, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [0.6, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]),
  // Spark: hard hot core.
  (g) => {
    radial(g, C, C, C * 0.55, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
    radial(g, C, C, C, [[0, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
  },
  // Smoke: clustered soft blobs.
  (g, rnd) => {
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * C * 0.45;
      const r = C * (0.25 + rnd() * 0.3);
      radial(g, C + Math.cos(a) * d, C + Math.sin(a) * d, r, [[0, `rgba(255,255,255,${0.16 + rnd() * 0.1})`], [1, 'rgba(255,255,255,0)']]);
    }
  },
  // Flame: teardrop with a hot base.
  (g, rnd) => {
    for (let i = 0; i < 14; i++) {
      const y = C * (1.35 - i * 0.07), w = C * (0.5 - i * 0.028) * (0.8 + rnd() * 0.4);
      radial(g, C + (rnd() - 0.5) * 8, y, Math.max(4, w), [[0, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
    }
    radial(g, C, C * 1.25, C * 0.42, [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
  },
  // Snowflake: six arms with branches.
  (g) => {
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 5;
    g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const ex = C + Math.cos(a) * C * 0.8, ey = C + Math.sin(a) * C * 0.8;
      g.beginPath();
      g.moveTo(C, C);
      g.lineTo(ex, ey);
      for (const k of [0.45, 0.65]) {
        const bx = C + Math.cos(a) * C * 0.8 * k, by = C + Math.sin(a) * C * 0.8 * k;
        for (const s of [-1, 1]) {
          g.moveTo(bx, by);
          g.lineTo(bx + Math.cos(a + s * 0.8) * C * 0.22, by + Math.sin(a + s * 0.8) * C * 0.22);
        }
      }
      g.stroke();
    }
    radial(g, C, C, C * 0.3, [[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]);
  },
  // Shard: angular crystal splinter with a bright edge.
  (g) => {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.moveTo(C, 6);
    g.lineTo(C + C * 0.34, C * 0.9);
    g.lineTo(C + C * 0.12, CELL - 8);
    g.lineTo(C - C * 0.3, C * 1.1);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    g.moveTo(C, 6);
    g.lineTo(C + C * 0.08, C);
    g.lineTo(C - C * 0.3, C * 1.1);
    g.closePath();
    g.fill();
  },
  // Ring.
  (g) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 7;
    g.shadowColor = 'white';
    g.shadowBlur = 14;
    g.beginPath();
    g.arc(C, C, C * 0.78, 0, Math.PI * 2);
    g.stroke();
  },
  // Rune: angular glyph strokes.
  (g, rnd) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.shadowColor = 'white';
    g.shadowBlur = 10;
    g.beginPath();
    g.moveTo(C, 16);
    g.lineTo(C, CELL - 16);
    for (let i = 0; i < 3; i++) {
      const y = 28 + rnd() * (CELL - 56);
      const s = rnd() < 0.5 ? -1 : 1;
      g.moveTo(C, y);
      g.lineTo(C + s * (22 + rnd() * 18), y + (rnd() - 0.5) * 40);
    }
    g.stroke();
  },
  // Leaf: almond with a vein.
  (g) => {
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.moveTo(C, 10);
    g.quadraticCurveTo(CELL - 14, C, C, CELL - 10);
    g.quadraticCurveTo(14, C, C, 10);
    g.fill();
    g.strokeStyle = 'rgba(120,120,120,0.6)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(C, 14);
    g.lineTo(C, CELL - 14);
    g.stroke();
  },
  // Streak: soft capsule filling the whole cell width (rain, speed lines;
  // stretched by velocity). It must span the cell: thin quads sample coarse
  // mips, which would average a thin line away.
  (g) => {
    const v = g.createLinearGradient(0, 0, 0, CELL);
    v.addColorStop(0, 'rgba(255,255,255,0)');
    v.addColorStop(0.35, 'rgba(255,255,255,1)');
    v.addColorStop(0.65, 'rgba(255,255,255,1)');
    v.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = v;
    g.fillRect(0, 0, CELL, CELL);
    g.globalCompositeOperation = 'destination-in';
    const h = g.createLinearGradient(0, 0, CELL, 0);
    h.addColorStop(0, 'rgba(255,255,255,0)');
    h.addColorStop(0.5, 'rgba(255,255,255,1)');
    h.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = h;
    g.fillRect(0, 0, CELL, CELL);
    g.globalCompositeOperation = 'source-over';
  },
  // Star: four-pointed twinkle.
  (g) => {
    radial(g, C, C, C * 0.35, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    g.fillStyle = 'rgba(255,255,255,0.95)';
    for (const [w, h] of [[6, C * 0.95], [C * 0.95, 6]]) {
      g.beginPath();
      g.ellipse(C, C, w, h, 0, 0, Math.PI * 2);
      g.fill();
    }
  },
  // Wisp: curling smoky tendril.
  (g, rnd) => {
    let x = C * 0.5, y = CELL - 12;
    for (let i = 0; i < 40; i++) {
      x += Math.sin(i * 0.35) * 3 + (rnd() - 0.5) * 2;
      y -= 2.6;
      radial(g, x + i * 0.6, y, 12 - i * 0.18, [[0, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]);
    }
  },
  // Chunk: irregular solid rock fragment with shading.
  (g, rnd) => {
    g.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, r = C * (0.55 + rnd() * 0.35);
      const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    const grd = g.createLinearGradient(0, 0, CELL, CELL);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(150,150,150,1)');
    g.fillStyle = grd;
    g.fill();
  },
  // Heart.
  (g) => {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    g.moveTo(C, CELL * 0.82);
    g.bezierCurveTo(-C * 0.1, C * 0.9, C * 0.3, 0, C, C * 0.5);
    g.bezierCurveTo(CELL - C * 0.3, 0, CELL + C * 0.1, C * 0.9, C, CELL * 0.82);
    g.fill();
  },
  // Zzz.
  (g) => {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.font = `bold ${CELL * 0.7}px serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('z', C, C);
  },
  // Hex shield cell.
  (g) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 6;
    g.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = C + Math.cos(a) * C * 0.8, y = C + Math.sin(a) * C * 0.8;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    radial(g, C, C, C * 0.8, [[0, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]);
  },
];

let atlas: THREE.CanvasTexture | null = null;

/** Shared particle atlas texture (created lazily, never disposed). */
export function particleAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL * ATLAS_CELLS;
  const g = canvas.getContext('2d')!;
  PAINTERS.forEach((paint, i) => {
    g.save();
    g.translate((i % ATLAS_CELLS) * CELL, Math.floor(i / ATLAS_CELLS) * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    paint(g, mulberry(1337 + i * 7919));
    g.restore();
  });
  atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.anisotropy = 2;
  return atlas;
}

let glowTex: THREE.CanvasTexture | null = null;

/** Standalone radial glow texture for sprites (projectile cores, orbs). */
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!;
  radial(g, 32, 32, 32, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.85)'], [0.45, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]);
  glowTex = new THREE.CanvasTexture(canvas);
  glowTex.colorSpace = THREE.NoColorSpace;
  return glowTex;
}
