/**
 * Procedural app icons (PWA manifest, apple-touch-icon, favicon) — no external assets.
 *
 *   npx tsx tools/make-icons.ts      → public/icons/*.png
 *
 * The emblem: a gold compass star (the long north–south points of a four-point astroid star
 * over a dimmer diagonal one) inside a gold ring, on the game's dark radial background.
 * Rendered analytically with 4×4 supersampling and written as RGBA PNG with node:zlib.
 *
 *  - icon-32 / icon-192 / icon-512: rounded square with transparent corners ("any").
 *  - icon-maskable-512: full-bleed background, emblem inside the 80 % safe zone.
 *  - apple-touch-icon (180): full-bleed and opaque (iOS applies its own corner mask and
 *    would fill transparency with black).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type RGBA = [number, number, number, number];

const hex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
const BG_IN = hex('#1d1b24');
const BG_OUT = hex('#07080b');
const GOLD_HI = hex('#f3d792');
const GOLD_LO = hex('#b3843a');
const GOLD_DIM = hex('#7d6233');
const INK = hex('#07080b');

const mix = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
/** Source-over compositing of a straight-alpha colour with coverage `c`. */
function over(dst: RGBA, src: RGBA, c: number): RGBA {
  const a = src[3] * c;
  const oa = a + dst[3] * (1 - a);
  if (oa <= 0) return [0, 0, 0, 0];
  const ch = (i: number) => (src[i] * a + dst[i] * dst[3] * (1 - a)) / oa;
  return [ch(0), ch(1), ch(2), oa];
}

/** Four-point star (astroid): (|x|/rx)^(2/3) + (|y|/ry)^(2/3) ≤ 1. */
function astroid(x: number, y: number, rx: number, ry: number): boolean {
  return Math.pow(Math.abs(x) / rx, 2 / 3) + Math.pow(Math.abs(y) / ry, 2 / 3) <= 1;
}

interface Layout {
  /** Emblem scale (1 = fills the icon). */
  scale: number;
  /** Rounded-square corner radius as a fraction of the size (0 = full bleed square). */
  corner: number;
}

/** Colour of one sample at icon coordinates u, v ∈ [0,1). */
function sample(u: number, v: number, L: Layout): RGBA {
  // Background (rounded square or full bleed).
  const cx = u - 0.5, cy = v - 0.5;
  if (L.corner > 0) {
    const r = L.corner, qx = Math.abs(cx) - (0.5 - r), qy = Math.abs(cy) - (0.5 - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) > r;
    if (outside) return [0, 0, 0, 0];
  }
  let c = mix(BG_IN, BG_OUT, Math.min(1, Math.hypot(cx, cy * 1.1) / 0.62));
  // Emblem space: centred, y up.
  const x = cx / L.scale, y = -cy / L.scale;
  const d = Math.hypot(x, y);
  // Ring with a faint inner line.
  if (Math.abs(d - 0.405) < 0.022) c = over(c, mix(GOLD_HI, GOLD_LO, 0.5 - y), 1);
  if (Math.abs(d - 0.36) < 0.0055) c = over(c, GOLD_DIM, 0.9);
  // Diagonal star (rotated 45°), dimmer.
  const rx = (x + y) * Math.SQRT1_2, ry = (y - x) * Math.SQRT1_2;
  if (astroid(rx, ry, 0.25, 0.25)) c = over(c, GOLD_DIM, 1);
  // Main compass star: long north–south points, lit from the top.
  if (astroid(x, y, 0.2, 0.36)) {
    // Facets: the left/upper half brighter, like a bevelled metal star.
    const lit = (x < 0 ? 0.25 : 0) + (y > 0 ? 0.35 : 0);
    c = over(c, mix(GOLD_LO, GOLD_HI, 0.3 + lit), 1);
  }
  // Centre pin.
  if (d < 0.05) c = over(c, INK, 1);
  if (Math.abs(d - 0.05) < 0.012) c = over(c, GOLD_HI, 1);
  return c;
}

function render(size: number, L: Layout): Buffer {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const s = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, L);
          // Average premultiplied, un-premultiply at the end.
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const o = (j * size + i) * 4;
      const n = SS * SS;
      const A = a / n;
      px[o] = A > 0 ? Math.round(Math.min(1, r / a) * 255) : 0;
      px[o + 1] = A > 0 ? Math.round(Math.min(1, g / a) * 255) : 0;
      px[o + 2] = A > 0 ? Math.round(Math.min(1, b / a) * 255) : 0;
      px[o + 3] = Math.round(A * 255);
    }
  }
  return png(size, size, px);
}

// ---------------------------------------------------------------- minimal PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w: number, h: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- outputs

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
const ROUNDED: Layout = { scale: 1, corner: 0.2 };
const FULL: Layout = { scale: 1, corner: 0 };
const MASKABLE: Layout = { scale: 0.78, corner: 0 };
const jobs: [string, number, Layout][] = [
  ['icon-32.png', 32, ROUNDED],
  ['icon-192.png', 192, ROUNDED],
  ['icon-512.png', 512, ROUNDED],
  ['icon-maskable-512.png', 512, MASKABLE],
  ['apple-touch-icon.png', 180, FULL],
];
for (const [name, size, layout] of jobs) {
  const file = join(out, name);
  writeFileSync(file, render(size, layout));
  console.log('wrote', file);
}
