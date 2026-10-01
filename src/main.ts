/**
 * Norgo entry point: title menu → world creation → game.
 * `?quick=<seed>` skips the menu (development), `?viewer` opens the free-fly terrain viewer,
 * `?diag` the device diagnostics page (capabilities, benchmarks, copyable report).
 */
import './style.css';
import './ui/styles/platform.css';
import { appShell } from './client/appShell';
import { Game } from './client/Game';
import { showMainMenu } from './ui/menu';
import type { NewGameChoice } from './ui/UI';
import { randomAppearance } from './humanoid/appearance';
import { parseSeed } from './core/rng';

const params = new URLSearchParams(location.search);

// Dev aid: keep a log of errors & warnings for automation (window.norgoErrors).
if (import.meta.env.DEV) {
  const log: string[] = [];
  (window as unknown as { norgoErrors: string[] }).norgoErrors = log;
  const push = (kind: string, args: unknown[]) => {
    if (log.length < 300) log.push(kind + ' ' + args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'object' ? JSON.stringify(a)?.slice(0, 300) : String(a))).join(' '));
  };
  const oe = console.error.bind(console), ow = console.warn.bind(console);
  console.error = (...a: unknown[]) => (push('E', [...a, (new Error().stack ?? '').split('\n').slice(2, 7).join(' | ')]), oe(...a));
  console.warn = (...a: unknown[]) => (push('W', a), ow(...a));
  addEventListener('error', (e) => push('X', [e.message, e.filename + ':' + e.lineno]));
  addEventListener('unhandledrejection', (e) => push('R', [e.reason]));
}
const app = document.getElementById('app')!;

function loadingScreen() {
  const el = document.createElement('div');
  el.className = 'norgo-loading';
  el.innerHTML = `<div class="norgo-loading-inner"><div class="norgo-loading-title">Norgo</div><div class="norgo-loading-stage"></div><div class="norgo-loading-bar"><div></div></div></div>`;
  document.body.appendChild(el);
  const stage = el.querySelector('.norgo-loading-stage') as HTMLElement;
  const bar = el.querySelector('.norgo-loading-bar > div') as HTMLElement;
  return {
    set(text: string, frac: number) {
      stage.textContent = text;
      bar.style.width = `${Math.round(frac * 100)}%`;
    },
    done() {
      el.classList.add('done');
      setTimeout(() => el.remove(), 900);
    },
  };
}

async function boot() {
  if (params.has('diag')) {
    await import('./tools/diag');
    return;
  }
  // App behaviour on tablets/phones: lifecycle, wake lock, fullscreen, rotate hint.
  appShell.install();
  if (params.has('viewer')) {
    await import('./tools/viewer');
    return;
  }
  let choice: NewGameChoice;
  const quick = params.get('quick');
  if (quick !== null) {
    const seed = quick || '1234';
    choice = { seed, name: params.get('name') ?? 'Wanderer', appearance: randomAppearance((params.get('race') as never) ?? 'human', parseSeed(seed + 'hero')) };
    const save = localStorage.getItem(`norgo.save.${seed}.${choice.name}`);
    if (save && !params.has('fresh')) choice.save = save;
  } else {
    choice = await showMainMenu(document.getElementById('ui') ?? document.body);
  }
  const loading = loadingScreen();
  const game = new Game(app, choice);
  try {
    await game.start((s, f) => loading.set(s, f));
  } catch (err) {
    console.error(err);
    loading.set('Failed to start: ' + (err as Error).message, 0);
    return;
  }
  loading.done();
}

boot();
