// "Alexa brain" proxy: the browser simulator sends the conversation + MCP tool list here,
// this process adds the system prompt and calls Claude Haiku (Anthropic Messages API, tool use).
// It does NOT execute tools: tool_use blocks go back to the browser, which runs them through its
// real MCP client (so every call shows up in the JSON-RPC log) and sends tool_result back.
//
// - The API key lives only here: env ANTHROPIC_API_KEY (or apps/echo-sim/.env). Never sent to the browser.
// - Every call is appended to server/usage.jsonl with tokens and cost.
// - Hard daily limit (DAILY_LIMIT_USD, default 0.50). Over the limit, or without a key, the proxy answers
//   {fallback:true} and the simulator switches to its no-LLM keyword router, so the demo always works.
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, systemPrompt } from '../../../skills/shop-counter/system-prompt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(here, '../.env'));

const PORT = Number(process.env.BRAIN_PORT ?? 8788);
const MODEL = process.env.BRAIN_MODEL ?? 'claude-haiku-5-5';
const LIMIT = Number(process.env.DAILY_LIMIT_USD ?? 0.5);
const USAGE = resolve(here, 'usage.jsonl');
// USD per 1M tokens for claude-haiku-5-5, prompts up to 100K (claude-api skill table, cached 2026-10-06).
// Cache writes 1.25x input, cache reads 0.1x input.
const PRICE = { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 };
const KEY = process.env.ANTHROPIC_API_KEY?.trim() || '';
const client = KEY ? new Anthropic({ apiKey: KEY, maxRetries: 1, timeout: 30_000 }) : null;

// System prompt = short Alexa persona + the Agent Skill (skills/shop-counter/SKILL.md). Built by the shared
// skills/shop-counter/system-prompt.mjs, so this proxy and the Bedrock brain on Lambda send the same bytes.
export const SKILL_PATH = process.env.SKILL_PATH ?? resolve(here, '../../../skills/shop-counter/SKILL.md');
export { loadSkill };

const skill = loadSkill(SKILL_PATH);
export const SYSTEM = systemPrompt(skill);

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function costOf(u = {}) {
  const c =
    ((u.input_tokens ?? 0) * PRICE.input +
      (u.output_tokens ?? 0) * PRICE.output +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cache_write +
      (u.cache_read_input_tokens ?? 0) * PRICE.cache_read) /
    1e6;
  return Math.round(c * 1e7) / 1e7;
}

const today = () => new Date().toISOString().slice(0, 10); // UTC day
export function spentToday(file = USAGE) {
  if (!existsSync(file)) return 0;
  const d = today();
  let sum = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const r = JSON.parse(line);
      if (r.ts?.startsWith(d)) sum += r.cost_usd ?? 0;
    } catch { /* skip broken line */ }
  }
  return Math.round(sum * 1e6) / 1e6;
}

function status() {
  const spent = spentToday();
  const reason = !KEY ? 'no_key' : spent >= LIMIT ? 'daily_limit' : null;
  return { llm: !reason, reason, model: MODEL, spent_today: spent, limit_usd: LIMIT, skill: skill?.name ?? null, system_chars: SYSTEM.length };
}

// MCP tool -> Anthropic tool. Keep order stable so the prompt cache prefix stays identical.
function toAnthropicTools(tools) {
  const out = (Array.isArray(tools) ? tools : []).slice(0, 32).map((t) => ({
    name: String(t.name).slice(0, 64),
    description: String(t.description ?? t.title ?? '').slice(0, 1000),
    input_schema: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  }));
  if (out.length) out[out.length - 1].cache_control = { type: 'ephemeral' };
  return out;
}

async function readJson(req, max = 400_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function turn(body) {
  const st = status();
  if (!st.llm) return [st.reason === 'no_key' ? 503 : 429, { fallback: true, ...st }];
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length) return [400, { error: 'messages required' }];
  const started = Date.now();
  try {
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: toAnthropicTools(body.tools),
      output_config: { effort: 'low' },
      messages,
    });
    const cost = costOf(r.usage);
    const rec = { ts: new Date().toISOString(), model: r.model, stop_reason: r.stop_reason, ms: Date.now() - started, ...r.usage, cost_usd: cost };
    appendFileSync(USAGE, JSON.stringify(rec) + '\n');
    console.log(`[brain] ${r.stop_reason} in=${r.usage.input_tokens} out=${r.usage.output_tokens} cache_r=${r.usage.cache_read_input_tokens ?? 0} $${cost} (today $${spentToday()})`);
    return [200, { content: r.content, stop_reason: r.stop_reason, usage: r.usage, cost_usd: cost, spent_today: spentToday(), limit_usd: LIMIT, model: r.model }];
  } catch (e) {
    const code = e instanceof Anthropic.APIError ? e.status ?? 502 : 502;
    console.error('[brain] API error', code, e.message);
    // any API trouble -> let the simulator fall back to the router for this turn
    return [code === 400 ? 400 : 503, { fallback: true, reason: 'api_error', status: code, message: String(e.message).slice(0, 300) }];
  }
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/brain/, '') || '/';
    if (req.method === 'GET' && path === '/health') return send(res, 200, status());
    if (req.method === 'POST' && path === '/turn') {
      const [code, body] = await turn(await readJson(req));
      return send(res, code, body);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status ?? 500, { error: String(e.message) });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    const st = status();
    console.log(`[brain] skill: ${skill ? `${skill.name} (${SKILL_PATH}, ${skill.body.length} chars)` : 'NOT FOUND, base prompt only'}`);
    console.log(`[brain] http://127.0.0.1:${PORT}  model=${MODEL}  llm=${st.llm}${st.reason ? ` (${st.reason}, simulator will use the keyword router)` : ''}  spent today $${st.spent_today} / $${LIMIT}`);
  });
}
