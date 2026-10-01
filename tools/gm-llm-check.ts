/**
 * Verify the Game Master's LLM brain wiring: `npx tsx tools/gm-llm-check.ts`
 *
 * Starts a local mock endpoint per provider format (Anthropic Messages, OpenAI-
 * compatible chat completions, Ollama chat), points the Oracle's LlmBrain at it
 * and checks that requests carry the persona, facts and scripted answer and that
 * responses are parsed. Also checks the scripted fallback when the endpoint fails.
 *
 * To try a real endpoint instead:
 *   npx tsx tools/gm-llm-check.ts --real <provider> <endpoint> <model> [apiKey]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LlmBrain, type AskContext, type LlmConfig } from '../src/gm/server/Oracle';
import { createProfile } from '../src/world/profile';
import { loreSummary } from '../src/gm/lore';

const ctx: AskContext = {
  question: 'Where should I go?',
  intent: 'where',
  scripted: 'The Ruins of Kelvar lie to the northeast, some 300 paces off.',
  facts: ['World: Testworld. Player is in the Old Forest.', 'Nearby place: the Ruins of Kelvar (ruin), to the northeast, some 300 paces off, unexplored.'],
  lore: loreSummary(createProfile(5)),
  history: [],
  playerName: 'Aria',
};

async function withMock(handler: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => void; seen: Record<string, unknown>[] }> {
  const seen: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      seen.push({ ...body, __headers: req.headers });
      handler(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), seen };
}

function json(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--real') {
    const [, provider, endpoint, model, apiKey] = args;
    const brain = new LlmBrain({ provider: provider as LlmConfig['provider'], endpoint, model, apiKey });
    console.log(brain.name, '→', await brain.answer(ctx));
    return;
  }

  // Anthropic Messages format.
  {
    const m = await withMock((_b, _q, res) => json(res, 200, { content: [{ type: 'text', text: 'Northeast, through the ferns — the Ruins of Kelvar await.' }], stop_reason: 'end_turn' }));
    const brain = new LlmBrain({ provider: 'anthropic', endpoint: m.url, apiKey: 'test-key' });
    const a = await brain.answer(ctx);
    const req = m.seen[0] as { model?: string; system?: string; messages?: { content: string }[]; __headers: Record<string, string> };
    check('anthropic: parses text blocks', a === 'Northeast, through the ferns — the Ruins of Kelvar await.', String(a));
    check('anthropic: default model', req.model === 'claude-opus-5-5', String(req.model));
    check('anthropic: headers', req.__headers['x-api-key'] === 'test-key' && req.__headers['anthropic-version'] === '2023-06-01');
    check('anthropic: grounded prompt', !!req.system?.includes('LORE:') && !!req.messages?.[0].content.includes('SCRIPTED ANSWER'));
    m.close();
  }
  // Anthropic refusal → null (Oracle falls back to the script).
  {
    const m = await withMock((_b, _q, res) => json(res, 200, { content: [], stop_reason: 'refusal' }));
    const a = await new LlmBrain({ provider: 'anthropic', endpoint: m.url }).answer(ctx);
    check('anthropic: refusal → fallback', a === null);
    m.close();
  }
  // OpenAI-compatible chat completions.
  {
    const m = await withMock((_b, _q, res) => json(res, 200, { choices: [{ message: { content: 'Head northeast to Kelvar.' } }] }));
    const a = await new LlmBrain({ provider: 'openai', endpoint: m.url, model: 'local-model', apiKey: 'k' }).answer(ctx);
    const req = m.seen[0] as { messages?: { role: string }[]; __headers: Record<string, string> };
    check('openai: parses choices', a === 'Head northeast to Kelvar.', String(a));
    check('openai: bearer + system message', req.__headers.authorization === 'Bearer k' && req.messages?.[0].role === 'system');
    m.close();
  }
  // Ollama chat.
  {
    const m = await withMock((_b, _q, res) => json(res, 200, { message: { content: 'Kelvar calls from the northeast.' } }));
    const a = await new LlmBrain({ provider: 'ollama', endpoint: m.url, model: 'llama3.1' }).answer(ctx);
    check('ollama: parses message', a === 'Kelvar calls from the northeast.', String(a));
    m.close();
  }
  // HTTP error → null.
  {
    const m = await withMock((_b, _q, res) => json(res, 500, { error: 'boom' }));
    const a = await new LlmBrain({ provider: 'openai', endpoint: m.url, model: 'x' }).answer(ctx);
    check('http error → fallback', a === null);
    m.close();
  }
  console.log(failures ? `${failures} check(s) failed` : 'all LLM brain checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
