/**
 * Animated title-screen backdrop: a painted alien sky (stars, aurora, rings,
 * phased moons) over layered mountain ridges with drifting fog and rising motes.
 * When a seed is previewed, the sky & ridges morph toward that world's profile.
 */
import { Rng } from '../../core/rng';
import type { WorldProfile, RGB } from '../../world/profile';

const LAYERS = 5;
const POINTS = 160;

interface Palette {
  zenith: RGB;
  horizon: RGB;
  fog: RGB;
  ridge: RGB;
  ring: RGB;
  aurora: RGB;
  sun: RGB;
}

interface Moon {
  x: number;
  y: number;
  r: number;
  color: RGB;
  phase: number;
}

const DEFAULT: Palette = {
  zenith: [0.03, 0.04, 0.09],
  horizon: [0.32, 0.2, 0.22],
  fog: [0.42, 0.3, 0.32],
  ridge: [0.05, 0.045, 0.07],
  ring: [0.8, 0.72, 0.6],
  aurora: [0.3, 0.9, 0.6],
  sun: [1, 0.75, 0.5],
};

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function css(c: RGB, a = 1) {
  return `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
}

function ridgeHeights(seed: number): Float32Array[] {
  const rng = new Rng(seed);
  const out: Float32Array[] = [];
  for (let l = 0; l < LAYERS; l++) {
    const arr = new Float32Array(POINTS);
    const oct = [rng.range(3, 6), rng.range(8, 14), rng.range(20, 34), rng.range(50, 70)];
    const ph = oct.map(() => rng.range(0, Math.PI * 2));
    const amp = [1, 0.45, 0.2, 0.08];
    const sharp = rng.range(0.8, 1.6);
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      let v = 0;
      for (let o = 0; o < oct.length; o++) v += Math.abs(Math.sin(t * oct[o] + ph[o] + l * 1.7)) ** sharp * amp[o];
      arr[i] = v / 1.73;
    }
    out.push(arr);
  }
  return out;
}

export class MenuBackdrop {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private t = 0;
  private last = performance.now();
  private pal: Palette = { ...DEFAULT };
  private target: Palette = { ...DEFAULT };
  private ridges = ridgeHeights(7);
  private ridgeTarget = this.ridges;
  private ridgeFrom = this.ridges;
  private morph = 1;
  private stars: Float32Array;
  private motes: Float32Array;
  private moons: Moon[] = [{ x: 0.78, y: 0.2, r: 0.045, color: [0.92, 0.88, 0.8], phase: 0.3 }];
  private moonsTarget = this.moons;
  private rings = 0;
  private ringsTarget = 0;
  private ringTilt = -0.25;
  private aurora = 0.6;
  private auroraTarget = 0.6;
  private mx = 0;
  private my = 0;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private onMove = (e: PointerEvent) => {
    this.mx = e.clientX / window.innerWidth - 0.5;
    this.my = e.clientY / window.innerHeight - 0.5;
  };
  private onResize = () => this.resize();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    const rng = new Rng(99);
    this.stars = new Float32Array(420 * 4);
    for (let i = 0; i < 420; i++) {
      this.stars[i * 4] = rng.float();
      this.stars[i * 4 + 1] = Math.pow(rng.float(), 1.6) * 0.75;
      this.stars[i * 4 + 2] = rng.range(0.3, 1.6);
      this.stars[i * 4 + 3] = rng.range(0, Math.PI * 2);
    }
    this.motes = new Float32Array(90 * 4);
    for (let i = 0; i < 90; i++) {
      this.motes[i * 4] = rng.float();
      this.motes[i * 4 + 1] = rng.float();
      this.motes[i * 4 + 2] = rng.range(0.004, 0.02);
      this.motes[i * 4 + 3] = rng.range(0, Math.PI * 2);
    }
    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.loop();
  }

  private resize() {
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.hgt = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.hgt * this.dpr);
  }

  /** Morph toward a world's look (null = default title mood). */
  setProfile(p: WorldProfile | null): void {
    if (!p) {
      this.target = { ...DEFAULT };
      this.ringsTarget = 0;
      this.auroraTarget = 0.6;
      this.retarget(ridgeHeights(7));
      this.moonsTarget = [{ x: 0.78, y: 0.2, r: 0.045, color: [0.92, 0.88, 0.8], phase: 0.3 }];
      return;
    }
    // Dusk-graded version of the world's sky: deep zenith, glowing horizon.
    this.target = {
      zenith: mix(p.skyZenith, [0.01, 0.01, 0.03], 0.72),
      horizon: mix(mix(p.skyHorizon, p.sunColor, 0.45), [0.05, 0.03, 0.05], 0.42),
      fog: mix(p.fogColor, [0.1, 0.07, 0.08], 0.5),
      ridge: mix(p.rockTint, [0.02, 0.02, 0.03], 0.88),
      ring: p.ringColor,
      aurora: mix(p.crystalTint, [0.3, 0.9, 0.6], 0.3),
      sun: p.sunColor,
    };
    this.ringsTarget = p.hasRings ? 1 : 0;
    this.ringTilt = p.ringTilt * 0.6;
    this.auroraTarget = p.auroraStrength;
    this.retarget(ridgeHeights(p.seed));
    const rng = new Rng(p.seed ^ 0x5eed);
    this.moonsTarget = p.moons.map((m, i) => ({
      x: 0.15 + ((i * 0.31 + m.phase * 0.5 + rng.float() * 0.2) % 0.75),
      y: 0.1 + rng.float() * 0.25,
      r: 0.012 + m.size * 0.55,
      color: m.color,
      phase: m.phase,
    }));
  }

  private retarget(r: Float32Array[]) {
    // Freeze the current interpolated state as the new start.
    this.ridgeFrom = this.ridges;
    this.ridgeTarget = r;
    this.morph = 0;
    this.moons = this.moons.length ? this.moons : this.moonsTarget;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.step(dt);
    this.draw();
  };

  private step(dt: number) {
    const k = 1 - Math.exp(-dt * 2.2);
    for (const key of Object.keys(this.pal) as (keyof Palette)[]) this.pal[key] = mix(this.pal[key], this.target[key], k);
    this.rings += (this.ringsTarget - this.rings) * k;
    this.aurora += (this.auroraTarget - this.aurora) * k;
    if (this.morph < 1) {
      this.morph = Math.min(1, this.morph + dt * 1.1);
      const e = this.morph * this.morph * (3 - 2 * this.morph);
      this.ridges = this.ridgeTarget.map((tgt, l) => {
        const from = this.ridgeFrom[l];
        const out = new Float32Array(POINTS);
        for (let i = 0; i < POINTS; i++) out[i] = from[i] + (tgt[i] - from[i]) * e;
        return out;
      });
      if (this.morph >= 1) this.ridges = this.ridgeTarget;
    }
    // Moons glide toward their new places.
    if (this.moons !== this.moonsTarget) {
      const n = this.moonsTarget.length;
      const next: Moon[] = [];
      for (let i = 0; i < n; i++) {
        const tg = this.moonsTarget[i];
        const cur = this.moons[i] ?? { ...tg, r: 0 };
        next.push({ x: cur.x + (tg.x - cur.x) * k, y: cur.y + (tg.y - cur.y) * k, r: cur.r + (tg.r - cur.r) * k, color: mix(cur.color, tg.color, k), phase: cur.phase + (tg.phase - cur.phase) * k });
      }
      // Fade out surplus moons.
      for (let i = n; i < this.moons.length; i++) {
        const m = this.moons[i];
        if (m.r > 0.002) next.push({ ...m, r: m.r * (1 - k) });
      }
      this.moons = next;
    }
  }

  private draw() {
    const { ctx, dpr } = this;
    const W = this.w, H = this.hgt, p = this.pal, t = this.t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Sky.
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, css(p.zenith));
    sky.addColorStop(0.55, css(mix(p.zenith, p.horizon, 0.55)));
    sky.addColorStop(0.78, css(p.horizon));
    sky.addColorStop(1, css(p.fog));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // Sun glow below the horizon line.
    const sg = ctx.createRadialGradient(W * 0.5 - this.mx * 30, H * 0.8, 0, W * 0.5, H * 0.8, W * 0.55);
    sg.addColorStop(0, css(p.sun, 0.35));
    sg.addColorStop(1, css(p.sun, 0));
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, H);

    // Stars.
    const px = -this.mx * 12, py = -this.my * 8;
    for (let i = 0; i < this.stars.length; i += 4) {
      const y = this.stars[i + 1] * H;
      const a = (0.45 + 0.55 * Math.sin(t * this.stars[i + 2] * 1.3 + this.stars[i + 3])) * (1 - this.stars[i + 1] * 1.1);
      if (a <= 0.02) continue;
      ctx.fillStyle = `rgba(255,248,230,${a.toFixed(3)})`;
      const s = this.stars[i + 2] * 0.9;
      ctx.fillRect(this.stars[i] * W + px, y + py, s, s);
    }

    // Aurora ribbons.
    if (this.aurora > 0.03) {
      ctx.globalCompositeOperation = 'lighter';
      for (let r = 0; r < 3; r++) {
        ctx.beginPath();
        const base = H * (0.16 + r * 0.06);
        for (let i = 0; i <= 60; i++) {
          const x = (i / 60) * W;
          const y = base + Math.sin(i * 0.18 + t * 0.35 + r * 2) * 26 + Math.sin(i * 0.05 - t * 0.2 + r) * 40;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        // Layered soft strokes instead of a blur filter (cheap every frame).
        const c = mix(p.aurora, [0.6, 0.3, 0.9], r * 0.3);
        for (const [lw, a] of [[70, 0.025], [40, 0.035], [16, 0.05]]) {
          ctx.lineWidth = lw - r * 8;
          ctx.strokeStyle = css(c, a * this.aurora);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Planetary rings.
    if (this.rings > 0.02) {
      ctx.save();
      ctx.translate(W * 0.5 + px * 1.5, H * 0.95 + py);
      ctx.rotate(this.ringTilt);
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, W * (0.75 + i * 0.05), H * (0.48 + i * 0.03), 0, Math.PI * 1.04, Math.PI * 1.96);
        ctx.lineWidth = 14 - i * 3;
        ctx.strokeStyle = css(p.ring, (0.38 - i * 0.07) * this.rings);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Moons with phase shadow.
    for (const m of this.moons) {
      const r = m.r * Math.min(W, H) * 1.6;
      if (r < 0.5) continue;
      const x = m.x * W + px * 2, y = m.y * H + py * 2;
      const glow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 3.2);
      glow.addColorStop(0, css(m.color, 0.18));
      glow.addColorStop(1, css(m.color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(x - r * 3.2, y - r * 3.2, r * 6.4, r * 6.4);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      const mg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      mg.addColorStop(0, css(mix(m.color, [1, 1, 1], 0.3)));
      mg.addColorStop(1, css(mix(m.color, [0.2, 0.2, 0.25], 0.35)));
      ctx.fillStyle = mg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.beginPath();
      const off = (m.phase - 0.5) * 2 * r * 1.6;
      ctx.arc(x + off, y - r * 0.08, r * 1.02, 0, Math.PI * 2);
      ctx.fillStyle = css(mix(p.zenith, [0, 0, 0], 0.2), 0.88);
      ctx.fill();
      ctx.restore();
    }

    // Mountain ridges, far to near, with fog between layers.
    for (let l = 0; l < LAYERS; l++) {
      const depth = l / (LAYERS - 1); // 0 far .. 1 near
      const baseY = H * (0.5 + depth * 0.36);
      const amp = H * (0.12 + depth * 0.2);
      const par = (depth * 0.9 + 0.1) * 46;
      const drift = (t * (2 + depth * 6)) % W;
      const col = mix(mix(p.horizon, p.fog, 0.4), p.ridge, 0.35 + depth * 0.65);
      const arr = this.ridges[l];
      ctx.beginPath();
      ctx.moveTo(-60, H);
      const step = (W + 120) / (POINTS - 1);
      for (let i = 0; i < POINTS; i++) {
        const x = -60 + i * step - this.mx * par;
        const y = baseY - arr[i] * amp + this.my * par * 0.3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W + 60, H);
      ctx.closePath();
      ctx.fillStyle = css(col);
      ctx.fill();
      // Rim light on the farthest layers.
      if (l < 2) {
        ctx.strokeStyle = css(p.sun, 0.12);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Fog band in front of the layer.
      const fy = baseY - amp * 0.15;
      const fg = ctx.createLinearGradient(0, fy - 60, 0, fy + 90);
      fg.addColorStop(0, css(p.fog, 0));
      fg.addColorStop(0.5, css(p.fog, 0.16 - depth * 0.06));
      fg.addColorStop(1, css(p.fog, 0));
      ctx.fillStyle = fg;
      ctx.save();
      ctx.translate(-drift * 0.1, 0);
      ctx.fillRect(-W, fy - 60, W * 3, 150);
      ctx.restore();
    }

    // Rising motes / embers.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.motes.length; i += 4) {
      let y = this.motes[i + 1] - t * this.motes[i + 2];
      y = ((y % 1) + 1) % 1;
      const x = this.motes[i] + Math.sin(t * 0.6 + this.motes[i + 3]) * 0.01;
      const a = Math.sin(y * Math.PI) * 0.7;
      const r = 1 + this.motes[i + 2] * 90;
      ctx.fillStyle = css(mix(p.sun, [1, 0.85, 0.6], 0.5), a * 0.55);
      ctx.beginPath();
      ctx.arc(x * W - this.mx * 60, (0.35 + y * 0.7) * H, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Vignette.
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('resize', this.onResize);
  }
}
