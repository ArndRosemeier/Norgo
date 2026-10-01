/**
 * Canvas pattern textures for apparel display models (ground items, icons).
 * Mirrors the ShellMaterial pattern vocabulary of the humanoid shell shader
 * (plain, stripes, checks, quilted, chainmail, scales, leather, fur,
 * embroidered, patchwork, silk, plates, runes) plus display-only variants
 * (lamellar, studded, straw).
 *
 * Textures are color-baked (base/secondary/accent) and cached in a small
 * LRU keyed by pattern + colors, so many identical ground items share one.
 * The same texture doubles as bump map (luminance relief).
 */
import * as THREE from 'three';
import { Rng } from '../../../core/rng';

export type DisplayPattern =
  | 'plain' | 'stripes' | 'checks' | 'quilted' | 'chainmail' | 'scales' | 'leather' | 'fur' | 'embroidered' | 'patchwork' | 'silk'
  | 'plates' | 'runes' | 'lamellar' | 'studded' | 'straw';

type RGB = [number, number, number];

const S = 256;
const cache = new Map<string, { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture | null }>();
const MAX_CACHE = 48;

const css = (c: RGB, mul = 1, a = 1) =>
  `rgba(${Math.round(Math.min(1, c[0] * mul) * 255)},${Math.round(Math.min(1, c[1] * mul) * 255)},${Math.round(Math.min(1, c[2] * mul) * 255)},${a})`;

function makeCanvas(): [HTMLCanvasElement | OffscreenCanvas, CanvasRenderingContext2D] {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
  return [c, c.getContext('2d') as CanvasRenderingContext2D];
}

/** Fine grain noise over the whole canvas (keeps flat colors from looking plastic). */
function grain(g: CanvasRenderingContext2D, rng: Rng, amount: number) {
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.float() - 0.5) * amount * 255;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

/** Draw `fn` wrapped at all 9 tile offsets so shapes near edges tile seamlessly. */
function wrapDraw(fn: (ox: number, oy: number) => void) {
  for (let oy = -S; oy <= S; oy += S) for (let ox = -S; ox <= S; ox += S) fn(ox, oy);
}

export interface PatternTex {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture | null;
}

/**
 * Pattern texture for a garment. `wear` darkens/scuffs; `glow` > 0 with
 * pattern 'runes' (or embroidered + glow) yields an emissive map too.
 */
export function patternTexture(pattern: DisplayPattern, color: RGB, color2: RGB, accent: RGB, seed: number, wear = 0, glowColor: RGB | null = null): PatternTex {
  const key = [pattern, ...color.map((x) => x.toFixed(2)), ...color2.map((x) => x.toFixed(2)), ...accent.map((x) => x.toFixed(2)), seed & 7, wear.toFixed(1), glowColor ? glowColor.join() : ''].join('|');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const rng = new Rng(seed ^ 0x51ab);
  const [cv, g] = makeCanvas();
  g.fillStyle = css(color);
  g.fillRect(0, 0, S, S);
  let emissive: THREE.CanvasTexture | null = null;
  switch (pattern) {
    case 'plain':
      break;
    case 'stripes': {
      const n = 4 + (seed & 3) * 2;
      for (let i = 0; i < n; i++) {
        if (i % 2) continue;
        g.fillStyle = css(color2);
        g.fillRect(0, (i * S) / n, S, S / n);
      }
      g.fillStyle = css(accent, 1, 0.8);
      for (let i = 0; i < n; i += 2) g.fillRect(0, (i * S) / n - 2, S, 3);
      break;
    }
    case 'checks': {
      // Tartan: overlapping translucent bands in two directions + thin accent lines.
      const n = 4;
      for (let i = 0; i < n; i++) {
        g.fillStyle = css(color2, 1, 0.55);
        g.fillRect((i * S) / n, 0, S / n / 2, S);
        g.fillRect(0, (i * S) / n, S, S / n / 2);
        g.fillStyle = css(accent, 1, 0.7);
        g.fillRect((i * S) / n + S / n * 0.72, 0, 3, S);
        g.fillRect(0, (i * S) / n + S / n * 0.72, S, 3);
      }
      break;
    }
    case 'quilted': {
      // Diamond quilting: stitched seams + pillowy shading in each cell.
      const n = 6, cs = S / n;
      for (let j = -1; j <= n; j++)
        for (let i = -1; i <= n; i++) {
          const cx = i * cs + ((j & 1) ? cs / 2 : 0), cy = j * cs * 0.5 + cs / 2;
          const grd = g.createRadialGradient(cx, cy, 2, cx, cy, cs * 0.6);
          grd.addColorStop(0, css(color, 1.15));
          grd.addColorStop(1, css(color, 0.75));
          g.fillStyle = grd;
          g.beginPath();
          g.moveTo(cx, cy - cs / 2);
          g.lineTo(cx + cs / 2, cy);
          g.lineTo(cx, cy + cs / 2);
          g.lineTo(cx - cs / 2, cy);
          g.closePath();
          g.fill();
        }
      g.strokeStyle = css(color2, 0.8);
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      for (let k = -n; k <= n * 2; k++) {
        g.beginPath();
        g.moveTo(k * cs, 0);
        g.lineTo(k * cs + S, S);
        g.stroke();
        g.beginPath();
        g.moveTo(k * cs, 0);
        g.lineTo(k * cs - S, S);
        g.stroke();
      }
      g.setLineDash([]);
      break;
    }
    case 'chainmail': {
      // Rows of interlinked rings: dark gaps, bright ring tops.
      g.fillStyle = css(color, 0.25);
      g.fillRect(0, 0, S, S);
      const n = 16, cs = S / n;
      for (let j = 0; j <= n * 2; j++)
        for (let i = 0; i <= n; i++) {
          const cx = i * cs + ((j & 1) ? cs / 2 : 0), cy = j * cs * 0.5;
          g.lineWidth = cs * 0.24;
          g.strokeStyle = css(color, 0.65);
          g.beginPath();
          g.ellipse(cx, cy, cs * 0.42, cs * 0.36, 0, 0, Math.PI * 2);
          g.stroke();
          g.lineWidth = cs * 0.1;
          g.strokeStyle = css(color, 1.35);
          g.beginPath();
          g.ellipse(cx, cy - cs * 0.04, cs * 0.42, cs * 0.34, 0, Math.PI * 1.1, Math.PI * 1.9);
          g.stroke();
        }
      break;
    }
    case 'scales': {
      // Overlapping rounded scales, each shaded with a gradient and rim.
      const n = 8, cs = S / n;
      g.fillStyle = css(color, 0.3);
      g.fillRect(0, 0, S, S);
      for (let j = n * 2; j >= -1; j--)
        for (let i = -1; i <= n; i++) {
          const cx = i * cs + ((j & 1) ? cs / 2 : 0), cy = j * cs * 0.55;
          const grd = g.createLinearGradient(cx, cy - cs * 0.2, cx, cy + cs * 0.6);
          grd.addColorStop(0, css(color, 1.3));
          grd.addColorStop(1, css(color, 0.6));
          g.fillStyle = grd;
          g.beginPath();
          g.moveTo(cx - cs / 2, cy - cs * 0.15);
          g.lineTo(cx + cs / 2, cy - cs * 0.15);
          g.quadraticCurveTo(cx + cs / 2, cy + cs * 0.55, cx, cy + cs * 0.7);
          g.quadraticCurveTo(cx - cs / 2, cy + cs * 0.55, cx - cs / 2, cy - cs * 0.15);
          g.fill();
          g.strokeStyle = css(color2, 0.7, 0.7);
          g.lineWidth = 1.2;
          g.stroke();
        }
      break;
    }
    case 'lamellar': {
      // Narrow vertical plates in rows, laced together with colored cord.
      const rows = 6, cols = 14, rh = S / rows, cw = S / cols;
      g.fillStyle = css(color, 0.25);
      g.fillRect(0, 0, S, S);
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const x = i * cw + ((j & 1) ? cw / 2 : 0), y = j * rh;
          wrapDraw((ox) => {
            const grd = g.createLinearGradient(x + ox, 0, x + ox + cw, 0);
            grd.addColorStop(0, css(color, 0.75));
            grd.addColorStop(0.5, css(color, 1.25));
            grd.addColorStop(1, css(color, 0.8));
            g.fillStyle = grd;
            g.fillRect(x + ox + 1, y + 1, cw - 2, rh * 0.86);
          });
        }
      g.fillStyle = css(accent);
      for (let j = 0; j < rows; j++) {
        g.fillRect(0, j * rh + rh * 0.86, S, 3);
        g.fillRect(0, j * rh + rh * 0.3, S, 2);
      }
      break;
    }
    case 'plates': {
      // Horizontal lames with dark overlaps, highlights and rivets.
      const n = 5, h = S / n;
      for (let j = 0; j < n; j++) {
        const grd = g.createLinearGradient(0, j * h, 0, (j + 1) * h);
        grd.addColorStop(0, css(color, 1.35));
        grd.addColorStop(0.35, css(color, 1.05));
        grd.addColorStop(0.9, css(color, 0.7));
        grd.addColorStop(1, css(color, 0.3));
        g.fillStyle = grd;
        g.fillRect(0, j * h, S, h);
        g.fillStyle = css(accent, 1);
        for (let i = 0; i < 8; i++) {
          g.beginPath();
          g.arc((i + 0.5) * (S / 8), j * h + h * 0.18, 3, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    }
    case 'studded': {
      // Leather faced with a grid of riveted plates (brigandine).
      leather(g, rng, color);
      const n = 9, cs = S / n;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const cx = (i + 0.5) * cs + ((j & 1) ? cs / 2 : 0), cy = (j + 0.5) * cs;
          wrapDraw((ox) => {
            const grd = g.createRadialGradient(cx + ox - 1.5, cy - 1.5, 0.5, cx + ox, cy, 5);
            grd.addColorStop(0, css(accent, 1.6));
            grd.addColorStop(1, css(accent, 0.5));
            g.fillStyle = grd;
            g.beginPath();
            g.arc(cx + ox, cy, 4.5, 0, Math.PI * 2);
            g.fill();
          });
        }
      break;
    }
    case 'leather':
      leather(g, rng, color);
      // Saddle stitching seams.
      g.strokeStyle = css(color2, 1.6, 0.8);
      g.lineWidth = 1.5;
      g.setLineDash([4, 3]);
      for (const y of [S * 0.08, S * 0.92]) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(S, y);
        g.stroke();
      }
      g.setLineDash([]);
      break;
    case 'fur': {
      for (let i = 0; i < 5000; i++) {
        const x = rng.float() * S, y = rng.float() * S, l = 6 + rng.float() * 10;
        const t = rng.float();
        g.strokeStyle = t < 0.5 ? css(color, 0.6 + rng.float() * 0.6) : css(color2, 0.7 + rng.float() * 0.5, 0.8);
        g.lineWidth = 1 + rng.float();
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rng.float() - 0.5) * 4, y + l);
        g.stroke();
      }
      break;
    }
    case 'embroidered': {
      // Borders of repeating motifs at the top and bottom, plus a scatter of small flowers.
      for (const by of [S * 0.04, S * 0.82]) {
        g.fillStyle = css(color2);
        g.fillRect(0, by, S, S * 0.14);
        g.strokeStyle = css(accent, 1.2);
        g.lineWidth = 2;
        for (let i = 0; i < 8; i++) {
          const cx = (i + 0.5) * (S / 8), cy = by + S * 0.07;
          g.beginPath();
          g.moveTo(cx - 10, cy);
          g.quadraticCurveTo(cx - 5, cy - 10, cx, cy);
          g.quadraticCurveTo(cx + 5, cy + 10, cx + 10, cy);
          g.stroke();
          g.beginPath();
          g.arc(cx, cy, 3, 0, Math.PI * 2);
          g.stroke();
        }
      }
      g.fillStyle = css(accent, 1, 0.85);
      for (let i = 0; i < 18; i++) {
        const x = rng.float() * S, y = S * 0.25 + rng.float() * S * 0.5;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          g.beginPath();
          g.arc(x + Math.cos(a) * 3, y + Math.sin(a) * 3, 1.6, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    }
    case 'patchwork': {
      const n = 4, cs = S / n;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const t = rng.float();
          const c: RGB = t < 0.33 ? color : t < 0.66 ? color2 : [color[0] * 0.8 + accent[0] * 0.2, color[1] * 0.8 + accent[1] * 0.2, color[2] * 0.8 + accent[2] * 0.2];
          g.fillStyle = css(c, 0.85 + rng.float() * 0.3);
          g.fillRect(i * cs, j * cs, cs, cs);
        }
      g.strokeStyle = css(color2, 0.5);
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      for (let k = 0; k <= n; k++) {
        g.beginPath();
        g.moveTo(k * cs, 0);
        g.lineTo(k * cs, S);
        g.stroke();
        g.beginPath();
        g.moveTo(0, k * cs);
        g.lineTo(S, k * cs);
        g.stroke();
      }
      g.setLineDash([]);
      break;
    }
    case 'silk': {
      // Soft sheen bands and a damask-like tone-on-tone motif.
      for (let y = 0; y < S; y++) {
        const s = 0.9 + Math.sin((y / S) * Math.PI * 6) * 0.08;
        g.fillStyle = css(color, s);
        g.fillRect(0, y, S, 1);
      }
      g.strokeStyle = css(color2, 1, 0.25);
      g.lineWidth = 2;
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const cx = (i + 0.5) * (S / 4) + ((j & 1) ? S / 8 : 0), cy = (j + 0.5) * (S / 4);
          g.beginPath();
          g.ellipse(cx, cy, 12, 20, 0, 0, Math.PI * 2);
          g.stroke();
          g.beginPath();
          g.ellipse(cx, cy, 20, 8, 0, 0, Math.PI * 2);
          g.stroke();
        }
      break;
    }
    case 'straw': {
      for (let y = 0; y < S; y += 3) {
        g.fillStyle = css(color, 0.8 + rng.float() * 0.4);
        g.fillRect(0, y, S, 2);
      }
      g.fillStyle = css(color2, 0.8, 0.5);
      for (let y = 0; y < S; y += 24) g.fillRect(0, y, S, 2);
      break;
    }
    case 'runes':
      break;
  }
  // Glowing runes (enchanted cloth): drawn into an emissive map, faintly into the color map.
  if (glowColor && (pattern === 'runes' || pattern === 'embroidered')) {
    const [ec, eg] = makeCanvas();
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, S, S);
    for (const ctx of [eg, g]) {
      ctx.strokeStyle = ctx === eg ? css(glowColor) : css(glowColor, 0.8, 0.6);
      ctx.lineWidth = 2;
      const r2 = new Rng(seed ^ 0x77);
      for (let i = 0; i < 10; i++) {
        const x = 16 + (i % 5) * 48, y = i < 5 ? S * 0.45 : S * 0.6;
        ctx.beginPath();
        ctx.moveTo(x, y - 10);
        for (let k = 0; k < 3; k++) ctx.lineTo(x + (r2.float() - 0.5) * 16, y + (r2.float() - 0.5) * 20);
        ctx.stroke();
      }
    }
    emissive = new THREE.CanvasTexture(ec as HTMLCanvasElement);
    emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
    emissive.colorSpace = THREE.SRGBColorSpace;
  }
  // Wear: grime toward the bottom edge + random scuffs.
  if (wear > 0.05) {
    const grd = g.createLinearGradient(0, S * 0.6, 0, S);
    grd.addColorStop(0, 'rgba(40,30,20,0)');
    grd.addColorStop(1, `rgba(40,30,20,${wear * 0.45})`);
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < wear * 30; i++) {
      g.fillStyle = `rgba(30,25,20,${0.08 + rng.float() * 0.12})`;
      g.beginPath();
      g.arc(rng.float() * S, rng.float() * S, 2 + rng.float() * 8, 0, Math.PI * 2);
      g.fill();
    }
  }
  grain(g, rng, pattern === 'plates' || pattern === 'chainmail' ? 0.05 : 0.08);
  const map = new THREE.CanvasTexture(cv as HTMLCanvasElement);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const out = { map, emissive };
  cache.set(key, out);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value as string;
    cache.delete(first);
  }
  return out;
}

function leather(g: CanvasRenderingContext2D, rng: Rng, color: RGB) {
  for (let i = 0; i < 900; i++) {
    g.fillStyle = css(color, 0.8 + rng.float() * 0.35, 0.35);
    g.beginPath();
    g.arc(rng.float() * S, rng.float() * S, 1 + rng.float() * 4, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 25; i++) {
    g.strokeStyle = css(color, 0.6, 0.35);
    g.lineWidth = 1;
    g.beginPath();
    const x = rng.float() * S, y = rng.float() * S;
    g.moveTo(x, y);
    g.quadraticCurveTo(x + rng.float() * 30 - 15, y + rng.float() * 30 - 15, x + rng.float() * 40 - 20, y + rng.float() * 40 - 20);
    g.stroke();
  }
}
