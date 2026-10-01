/**
 * Canvas marker drawing shared by the world map, minimap and menu preview:
 * settlements, points of interest, player arrow, quest objectives, waypoint.
 */
import type { PoiKind, SiteInfo } from '../../world/sites';

const INK = '#2a2018';
const GOLD = '#f3d58f';

export const POI_LABEL: Record<PoiKind, string> = {
  ruin: 'Ruins', shrine: 'Shrine', camp: 'Camp', lair: 'Lair', grove: 'Sacred Grove', monolith: 'Monolith', tower: 'Tower',
  battlefield: 'Battlefield', crashsite: 'Crash Site', well: 'Old Well', wayshrine: 'Wayshrine', obelisk: 'Obelisk',
};

export const SITE_LABEL: Record<SiteInfo['size'], string> = { hamlet: 'Hamlet', village: 'Village', town: 'Town', city: 'City' };

function outline(ctx: CanvasRenderingContext2D, fill: string, lw = 1.6) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

/** Settlement icon; size by importance. */
export function drawSite(ctx: CanvasRenderingContext2D, x: number, y: number, size: SiteInfo['size'], walled: boolean, s = 1): void {
  const k = (size === 'city' ? 1.45 : size === 'town' ? 1.2 : size === 'village' ? 1 : 0.8) * s;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  if (walled || size === 'city') {
    // Keep with crenellations.
    ctx.beginPath();
    ctx.moveTo(-7, 6); ctx.lineTo(-7, -4); ctx.lineTo(-5, -4); ctx.lineTo(-5, -7); ctx.lineTo(-2, -7); ctx.lineTo(-2, -4);
    ctx.lineTo(2, -4); ctx.lineTo(2, -7); ctx.lineTo(5, -7); ctx.lineTo(5, -4); ctx.lineTo(7, -4); ctx.lineTo(7, 6); ctx.closePath();
    outline(ctx, '#e8d7b0');
    ctx.beginPath();
    ctx.rect(-1.6, 1, 3.2, 5);
    ctx.fillStyle = INK;
    ctx.fill();
  } else {
    // Cottage.
    ctx.beginPath();
    ctx.moveTo(-6.5, 6); ctx.lineTo(-6.5, -1); ctx.lineTo(0, -7); ctx.lineTo(6.5, -1); ctx.lineTo(6.5, 6); ctx.closePath();
    outline(ctx, '#ead9b4');
    ctx.beginPath();
    ctx.moveTo(-8, -0.5); ctx.lineTo(0, -8); ctx.lineTo(8, -0.5);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8c3b2a';
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPoi(ctx: CanvasRenderingContext2D, x: number, y: number, kind: PoiKind, s = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  switch (kind) {
    case 'tower': case 'obelisk': case 'monolith':
      ctx.moveTo(-2.5, 6); ctx.lineTo(-1.6, -6); ctx.lineTo(0, -8); ctx.lineTo(1.6, -6); ctx.lineTo(2.5, 6); ctx.closePath();
      outline(ctx, kind === 'monolith' ? '#b9a6e0' : '#d8cbb0');
      break;
    case 'shrine': case 'wayshrine':
      ctx.moveTo(0, -7); ctx.lineTo(6, -2); ctx.lineTo(4, -2); ctx.lineTo(4, 6); ctx.lineTo(-4, 6); ctx.lineTo(-4, -2); ctx.lineTo(-6, -2); ctx.closePath();
      outline(ctx, '#f0e0a0');
      break;
    case 'camp':
      ctx.moveTo(-7, 6); ctx.lineTo(0, -6); ctx.lineTo(7, 6); ctx.closePath();
      outline(ctx, '#d9a76a');
      break;
    case 'lair':
      ctx.arc(0, 1, 6, Math.PI, 0); ctx.lineTo(6, 5); ctx.lineTo(-6, 5); ctx.closePath();
      outline(ctx, '#7a5a4a');
      ctx.beginPath(); ctx.arc(0, 3, 2.6, Math.PI, 0); ctx.fillStyle = INK; ctx.fill();
      break;
    case 'grove':
      ctx.arc(0, -1.5, 5.5, 0, Math.PI * 2);
      outline(ctx, '#7fbf6a');
      ctx.beginPath(); ctx.rect(-1, 3, 2, 4); ctx.fillStyle = INK; ctx.fill();
      break;
    case 'ruin':
      ctx.rect(-6, -2, 3, 8); ctx.rect(-1.5, -6, 3, 12); ctx.rect(3, 0, 3, 6);
      outline(ctx, '#cbbfa6');
      break;
    case 'battlefield':
      ctx.moveTo(-6, -6); ctx.lineTo(6, 6); ctx.moveTo(6, -6); ctx.lineTo(-6, 6);
      ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = '#d8d0c0'; ctx.stroke();
      break;
    case 'crashsite':
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2, r = i % 2 ? 3 : 7.5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      outline(ctx, '#ff9f5a');
      break;
    case 'well':
      ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      outline(ctx, '#a8c8e0');
      ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, Math.PI * 2); ctx.fillStyle = '#2a4a6a'; ctx.fill();
      break;
    default:
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      outline(ctx, '#ddd');
  }
  ctx.restore();
}

/** Player arrow pointing along heading (radians, 0 = north/up, clockwise). */
export function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, s = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = GOLD;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

export function drawQuest(ctx: CanvasRenderingContext2D, x: number, y: number, s = 1, tracked = true): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(0, 9); ctx.lineTo(-7, 0); ctx.closePath();
  outline(ctx, tracked ? '#ffcf4a' : '#c9b27a');
  ctx.fillStyle = INK;
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 0, 0.5);
  ctx.restore();
}

export function drawWaypoint(ctx: CanvasRenderingContext2D, x: number, y: number, s = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-6, -7, -6, -14, 0, -14);
  ctx.bezierCurveTo(6, -14, 6, -7, 0, 0);
  outline(ctx, '#7fd0ff');
  ctx.beginPath(); ctx.arc(0, -9.5, 2.2, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill();
  ctx.restore();
}

/** Label with dark halo for legibility over terrain. */
export function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 12, color = '#f6ecd2', font = 'Cinzel, serif'): void {
  ctx.font = `600 ${size}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = 'rgba(20,14,8,.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
