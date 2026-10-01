/**
 * Dialog brains: who decides what an NPC says in response to free text.
 *
 *  - `ScriptedBrain` (default): keyword/intent matching onto the scripted
 *    topic system (templated, voice-aware lines).
 *  - `LlmBrain`: builds a grounded prompt from the NPC's profile, needs,
 *    memories, goals, relations, disposition, world facts and the conversation
 *    so far, calls an OpenAI- or Anthropic-compatible HTTP endpoint with
 *    `fetch` (works inside the server Web Worker), and maps a JSON-structured
 *    reply onto dialog lines, suggested player replies and game actions.
 *
 * The LLM is disabled unless configured at runtime (ClientMessage
 * `{t:'debug', cmd:'llmConfig', args:[{endpoint, apiKey, model, provider}]}`).
 * Any failure falls back to the scripted brain, so dialog never dead-ends.
 */
import type { DialogLine } from './types';
import { matchIntent, type Intent } from './intent';

export type Mood = NonNullable<DialogLine['mood']>;
const MOODS: Mood[] = ['neutral', 'happy', 'angry', 'sad', 'afraid', 'surprised', 'disgusted', 'focused', 'pain'];

export type BrainAction =
  | { type: 'topic'; topic: Intent; nameHit: number }
  | { type: 'disposition'; delta: number; reason: string }
  | { type: 'remember'; text: string; importance: number }
  | { type: 'offerQuest' }
  | { type: 'trade' }
  | { type: 'gesture'; anim: string }
  | { type: 'end' };

export interface BrainReply {
  lines: { text: string; mood?: Mood }[];
  /** Suggested player replies (sent back as free text when chosen). */
  suggestions?: string[];
  actions: BrainAction[];
  brain: string;
}

/** Everything a brain may use to ground its answer. Built by the DialogSystem. */
export interface BrainContext {
  npcName: string;
  playerName: string;
  /** One-paragraph persona: race, job, age, personality, voice notes, bio. */
  persona: string;
  /** Situational facts (time, weather, place, leader, current activity...). */
  facts: Record<string, string>;
  memories: string[];
  needs: string;
  goal: string | null;
  relations: string[];
  disposition: number;
  dispositionReasons: string[];
  canTrade: boolean;
  questAvailable: string | null;
  history: { who: 'player' | 'npc'; text: string }[];
  /** Names of people and places the NPC knows (for the intent matcher). */
  names: string[];
}

export interface DialogBrain {
  readonly id: string;
  respond(ctx: BrainContext, text: string): BrainReply | Promise<BrainReply>;
}

/** Default brain: intent matching onto scripted topics (the DialogSystem renders them). */
export class ScriptedBrain implements DialogBrain {
  readonly id = 'scripted';
  respond(ctx: BrainContext, text: string): BrainReply {
    const m = matchIntent(text, ctx.names);
    return { lines: [], actions: [{ type: 'topic', topic: m.intent, nameHit: m.nameHit }], brain: this.id };
  }
}

export interface LlmConfig {
  /** Full URL, e.g. https://api.openai.com/v1/chat/completions or https://api.anthropic.com/v1/messages (or a local proxy). */
  endpoint: string;
  apiKey?: string;
  model: string;
  /** 'openai' (chat completions schema, also most local servers) or 'anthropic' (messages schema). */
  provider?: 'openai' | 'anthropic';
  temperature?: number;
  maxTokens?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export function parseLlmConfig(x: unknown): LlmConfig | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.endpoint !== 'string' || !o.endpoint || typeof o.model !== 'string' || !o.model) return null;
  const provider = o.provider === 'anthropic' || /anthropic/i.test(o.endpoint) ? 'anthropic' : 'openai';
  return {
    endpoint: o.endpoint, apiKey: typeof o.apiKey === 'string' ? o.apiKey : undefined, model: o.model, provider,
    temperature: typeof o.temperature === 'number' ? o.temperature : 0.85, maxTokens: typeof o.maxTokens === 'number' ? o.maxTokens : 500,
    timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : 20000,
  };
}

/** Compose the system prompt. Exported for tests & tools. */
export function buildSystemPrompt(c: BrainContext): string {
  const facts = Object.entries(c.facts).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return [
    `You are ${c.npcName}, a character in a living fantasy world. Stay strictly in character; never mention being an AI, a game or a model.`,
    `PERSONA: ${c.persona}`,
    `WORLD FACTS:\n${facts}`,
    `YOUR NEEDS RIGHT NOW: ${c.needs}`,
    `YOUR CURRENT GOAL: ${c.goal ?? 'nothing pressing'}${c.questAvailable ? ` (you would welcome help: "${c.questAvailable}")` : ''}`,
    `PEOPLE YOU KNOW:\n${c.relations.map((r) => `- ${r}`).join('\n') || '- (nobody close)'}`,
    `THINGS YOU REMEMBER (most important first):\n${c.memories.map((m) => `- ${m}`).join('\n') || '- (nothing notable)'}`,
    `YOUR ATTITUDE TO ${c.playerName}: ${c.disposition} on a -100..100 scale${c.dispositionReasons.length ? ` because they ${c.dispositionReasons.join('; ')}` : ''}.`,
    `RULES: Speak in 1-3 short sentences in your own voice (dialect, temperament). Only state facts consistent with the lists above; when unsure, be vague or say you don't know. You may refuse, lie if it fits your personality, or end the talk if offended.${c.canTrade ? ' You are a trader and may offer to trade.' : ''}`,
    `OUTPUT: reply with ONLY a JSON object, no prose around it:`,
    `{"lines":[{"text":"...","mood":"neutral|happy|angry|sad|afraid|surprised|disgusted|focused"}],"suggestions":["up to 3 short things the player might say next"],"actions":[{"type":"disposition","delta":-10,"reason":"insulted me"},{"type":"remember","text":"fact worth remembering about the player","importance":0.5},{"type":"offerQuest"},{"type":"trade"},{"type":"gesture","anim":"gesture_wave|gesture_shrug|gesture_point|bow|cheer"},{"type":"end"}]}`,
    `Use actions sparingly: disposition only for meaningful changes (|delta| <= 15); offerQuest only when the player offers help or asks for work and you have a goal; trade only if they want to trade; end only when the conversation is over.`,
  ].join('\n\n');
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Validate & clamp a model reply into a BrainReply (never trusts the model's structure). */
export function normalizeReply(raw: unknown, fallbackText: string): BrainReply {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines: BrainReply['lines'] = [];
  if (Array.isArray(o.lines)) {
    for (const l of o.lines.slice(0, 4)) {
      const text = typeof l === 'string' ? l : typeof (l as { text?: unknown })?.text === 'string' ? (l as { text: string }).text : '';
      const mood = MOODS.includes((l as { mood?: Mood })?.mood as Mood) ? (l as { mood: Mood }).mood : undefined;
      if (text.trim()) lines.push({ text: text.trim().slice(0, 400), mood });
    }
  }
  if (!lines.length && fallbackText.trim()) lines.push({ text: fallbackText.trim().slice(0, 400) });
  const suggestions = Array.isArray(o.suggestions) ? o.suggestions.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 3).map((s) => s.slice(0, 120)) : [];
  const actions: BrainAction[] = [];
  if (Array.isArray(o.actions)) {
    for (const a of o.actions.slice(0, 6)) {
      const t = (a as { type?: string })?.type;
      const x = a as Record<string, unknown>;
      if (t === 'disposition' && typeof x.delta === 'number') actions.push({ type: 'disposition', delta: Math.max(-15, Math.min(15, Math.round(x.delta))), reason: String(x.reason ?? 'said something').slice(0, 80) });
      else if (t === 'remember' && typeof x.text === 'string') actions.push({ type: 'remember', text: x.text.slice(0, 160), importance: Math.max(0, Math.min(1, Number(x.importance ?? 0.4))) });
      else if (t === 'offerQuest') actions.push({ type: 'offerQuest' });
      else if (t === 'trade') actions.push({ type: 'trade' });
      else if (t === 'end') actions.push({ type: 'end' });
      else if (t === 'gesture' && typeof x.anim === 'string' && /^(gesture_wave|gesture_shrug|gesture_point|bow|cheer|talk)$/.test(x.anim)) actions.push({ type: 'gesture', anim: x.anim });
    }
  }
  return { lines, suggestions, actions, brain: 'llm' };
}

export class LlmBrain implements DialogBrain {
  readonly id = 'llm';
  constructor(readonly config: LlmConfig) {}

  async respond(ctx: BrainContext, text: string): Promise<BrainReply> {
    const c = this.config;
    const system = buildSystemPrompt(ctx);
    const turns = ctx.history.slice(-12).map((h) => ({ role: h.who === 'player' ? 'user' : 'assistant', content: h.text }));
    turns.push({ role: 'user', content: text });
    // Providers require alternating roles starting with the user: merge neighbours.
    const msgs: { role: string; content: string }[] = [];
    for (const t of turns) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === t.role) last.content += '\n' + t.content;
      else msgs.push({ ...t });
    }
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), c.timeoutMs ?? 20000) : null;
    try {
      let body: unknown;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (c.provider === 'anthropic') {
        body = { model: c.model, max_tokens: c.maxTokens ?? 500, temperature: c.temperature, system, messages: msgs };
        if (c.apiKey) headers['x-api-key'] = c.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      } else {
        body = { model: c.model, temperature: c.temperature, max_tokens: c.maxTokens ?? 500, messages: [{ role: 'system', content: system }, ...msgs], response_format: { type: 'json_object' } };
        if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
      }
      const res = await fetch(c.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl?.signal });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      let out = '';
      if (c.provider === 'anthropic') {
        const content = data.content as { type: string; text?: string }[] | undefined;
        out = content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') ?? '';
      } else {
        const choices = data.choices as { message?: { content?: string } }[] | undefined;
        out = choices?.[0]?.message?.content ?? '';
      }
      const parsed = extractJson(out);
      return normalizeReply(parsed, parsed ? '' : out);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
