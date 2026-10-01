/**
 * Can this browser decode the adaptive score's stems (Ogg Opus) with `decodeAudioData`?
 *
 * `canPlayType` answers for the <audio> element, not for WebAudio decoding, and WebKit's
 * answers have changed between releases — so on WebKit (every iOS/iPadOS browser, Safari
 * on macOS) or whenever `canPlayType` says no, one real stem is decoded once, off the main
 * AudioContext (an OfflineAudioContext needs no user gesture). Chromium and Firefox decode
 * Ogg Opus reliably and are trusted without the test.
 *
 * The verdict is cached per user agent in localStorage, so a browser update re-tests.
 * A network failure is "unavailable for this session" (not cached): the stems would fail
 * the same way and the game simply stays generative.
 */
import { platform, DEBUG_CAPS } from '../core/platform';

export type CodecVerdict = 'ok' | 'unsupported' | 'unavailable';

export interface CodecResult {
  verdict: CodecVerdict;
  /** How the verdict was reached. */
  how: 'trusted' | 'decode-test' | 'cached' | 'forced';
  /** canPlayType('audio/ogg; codecs="opus"') !== '' */
  canPlayType: boolean;
  /** Decode test time (ms) when one ran. */
  ms?: number;
  /** Decoded duration (s) of the test file. */
  seconds?: number;
  error?: string;
}

const CACHE_KEY = 'norgo.codec.oggOpus';
let pending: Promise<CodecResult> | null = null;

function readCache(): boolean | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { ua?: string; ok?: boolean };
    return v.ua === navigator.userAgent && typeof v.ok === 'boolean' ? v.ok : null;
  } catch {
    return null;
  }
}

function writeCache(ok: boolean) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ua: navigator.userAgent, ok }));
  } catch {
    /* private mode / quota: re-test next session */
  }
}

/**
 * Decode one encoded file with an OfflineAudioContext (no gesture needed). Resolves with the
 * decoded duration; rejects with the browser's error. Shared with the `?diag` page.
 */
export async function testDecode(url: string, timeoutMs = 20000): Promise<{ seconds: number; ms: number; bytes: number }> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { network: true });
  const data = await res.arrayBuffer();
  const bytes = data.byteLength;
  const Ctor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext })
    .OfflineAudioContext ?? (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) throw new Error('no OfflineAudioContext');
  const ctx = new Ctor(2, 128, 48000);
  // Callback form too: older WebKit only supports callbacks and never settles the promise.
  const buf = await new Promise<AudioBuffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('decode timed out')), timeoutMs);
    const done = (b: AudioBuffer) => (clearTimeout(timer), resolve(b));
    const fail = (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e ?? 'decode failed'))));
    try {
      const p = ctx.decodeAudioData(data, done, fail);
      if (p && typeof p.then === 'function') p.then(done, fail);
    } catch (e) {
      fail(e);
    }
  });
  if (DEBUG_CAPS.has('noopus')) throw new Error('forced failure (?caps=noopus)');
  return { seconds: buf.duration, ms: performance.now() - t0, bytes };
}

/** Run (once per session) the Ogg Opus check, using `sampleUrl` when a decode test is needed. */
export function probeOggOpus(sampleUrl: string): Promise<CodecResult> {
  if (pending) return pending;
  const canPlayType = platform.audio.oggOpus;
  const finish = (r: CodecResult) => {
    platform.note('stemCodec', r);
    if (r.verdict !== 'ok') console.info(`[audio] adaptive stems unavailable (${r.how}: ${r.error ?? r.verdict}); the generative score plays alone.`);
    return r;
  };
  pending = (async (): Promise<CodecResult> => {
    if (DEBUG_CAPS.has('noopus')) return finish({ verdict: 'unsupported', how: 'forced', canPlayType, error: '?caps=noopus' });
    if (canPlayType && !platform.info.webkit) return finish({ verdict: 'ok', how: 'trusted', canPlayType });
    const cached = readCache();
    if (cached !== null) return finish({ verdict: cached ? 'ok' : 'unsupported', how: 'cached', canPlayType });
    try {
      const r = await testDecode(sampleUrl);
      const ok = r.seconds > 0.5;
      writeCache(ok);
      return finish({ verdict: ok ? 'ok' : 'unsupported', how: 'decode-test', canPlayType, ms: Math.round(r.ms), seconds: +r.seconds.toFixed(3) });
    } catch (e) {
      const err = e as Error & { network?: boolean };
      // fetch() rejects with a TypeError on network failure; our HTTP errors carry `network`.
      const network = err.network === true || err instanceof TypeError;
      if (!network) writeCache(false);
      return finish({ verdict: network ? 'unavailable' : 'unsupported', how: 'decode-test', canPlayType, error: err?.message ?? String(e) });
    }
  })();
  return pending;
}

/** The finished verdict, if the probe has completed (diagnostics). */
export function codecResult(): CodecResult | null {
  return (platform.notes.stemCodec as CodecResult | undefined) ?? null;
}
