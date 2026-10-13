/**
 * The "Alexa brain" on AWS Lambda: the hosted Echo Show simulator sends the conversation + MCP tool list to
 * POST /brain/turn, this module adds the system prompt and calls a model on Amazon Bedrock with the function's
 * IAM role (no API keys anywhere). Same wire format as apps/echo-sim/server/brain.mjs (Anthropic messages with
 * tool_use / tool_result blocks), so the simulator does not care which brain answers. Tools are NOT executed
 * here: tool_use goes back to the browser, which runs it through its real MCP client.
 *
 * Providers (BRAIN_PROVIDER):
 *   claude-api          Claude Haiku 5.5 through the Anthropic API with ANTHROPIC_API_KEY (Lambda env). Default on our
 *                       account: Bedrock answers "not available for this account" for every model (checked 2026-10-13).
 *   anthropic (default) Claude Haiku 5.5 through "Claude in Amazon Bedrock" (Messages API at bedrock-mantle,
 *                       SigV4 via @anthropic-ai/bedrock-sdk AnthropicBedrockMantle). Native format, no translation.
 *   nova                Amazon Nova Lite through the Bedrock Converse API, translated to and from the Anthropic
 *                       format (toConverse / fromConverse below). Fallback if Anthropic model access is not granted.
 *   off                 no model: every turn answers {fallback:true}, the simulator uses its keyword router.
 *
 * Spend guards, both counted in DynamoDB (table shop-counter-state, atomic ADD, items expire by TTL):
 *   - daily budget: key "brain:YYYY-MM-DD" (UTC), micro-dollars; at or over DAILY_LIMIT_USD (default 0.50) -> fallback
 *   - per caller:   key "brain-ip:<sha256(ip)[0..16]>:YYYY-MM-DDTHH", turns; over BRAIN_IP_TURNS_PER_HOUR (60) -> fallback
 */
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadSkill, systemPrompt } from '../../../skills/shop-counter/system-prompt.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Provider = 'claude-api' | 'anthropic' | 'nova' | 'off';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * USD per 1M tokens. Checked 2026-10-13.
 * - Claude Haiku 5.5: $0.10 in / $0.50 out for prompts up to 100K tokens; cache write 1.25x, cache read 0.1x
 *   (Anthropic model table in the claude-api skill, cached 2026-10-06; same base rate listed for Bedrock at
 *   llmreference.com/model/claude-haiku-5-5/aws-bedrock). Claude in Amazon Bedrock adds 10% on a regional
 *   endpoint (platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock, "Regions"). We call the
 *   us-east-1 endpoint and cannot prove it is billed as global, so we count the regional rate: x1.1. Our
 *   prompts stay far under 100K tokens.
 * - Amazon Nova Lite: $0.06 in / $0.24 out (aws.amazon.com/bedrock/pricing, $0.00006 / $0.00024 per 1K, as
 *   quoted by bigdataboutique.com/blog/aws-bedrock-pricing-guide). We send no cache points to Nova.
 * Over-counting is the safe side: the daily cap trips a little early, never late.
 */
export const PRICES: Record<Exclude<Provider, 'off'>, { input: number; output: number; cache_write: number; cache_read: number }> = {
  'claude-api': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
  anthropic: { input: 0.11, output: 0.55, cache_write: 0.1375, cache_read: 0.011 },
  nova: { input: 0.06, output: 0.24, cache_write: 0.06, cache_read: 0.015 },
};

export const DEFAULT_MODEL: Record<Exclude<Provider, 'off'>, string> = {
  'claude-api': 'claude-haiku-5-5',
  anthropic: 'anthropic.claude-haiku-5-5',
  nova: 'amazon.nova-lite-v1:0',
};

const LABEL: Record<Provider, string> = { 'claude-api': 'Claude Haiku 5.5 (Anthropic API)', anthropic: 'Claude Haiku 5.5 on Amazon Bedrock', nova: 'Amazon Nova Lite on Amazon Bedrock', off: 'keyword router' };

export function costOf(provider: Provider, u: Usage = {}): number {
  if (provider === 'off') return 0;
  const p = PRICES[provider];
  const c = ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_creation_input_tokens ?? 0) * p.cache_write + (u.cache_read_input_tokens ?? 0) * p.cache_read) / 1e6;
  return Math.round(c * 1e7) / 1e7;
}

/* ---------------- system prompt (shared with brain.mjs) ---------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
/** Next to the bundle on Lambda (/var/task/SKILL.md, copied by scripts/build.mjs), else the repo copy. */
const SKILL_CANDIDATES = [process.env.SKILL_PATH, join(HERE, 'SKILL.md'), resolve(HERE, '..', '..', '..', 'skills', 'shop-counter', 'SKILL.md')];
const skill = loadSkill(SKILL_CANDIDATES.find((p) => p && existsSync(p)));
export const SYSTEM = systemPrompt(skill);

/* ---------------- request shaping ---------------- */

export interface McpTool { name: string; description?: string; title?: string; inputSchema?: any }
export interface TurnRequest { system: string; tools: McpTool[]; messages: any[]; model: string }
export interface TurnResult { content: any[]; stop_reason: string | null; usage: Usage; model: string }

/** MCP tool -> Anthropic tool. Stable order; cache breakpoint on the last tool (as brain.mjs). */
export function toAnthropicTools(tools: unknown): any[] {
  const out = (Array.isArray(tools) ? tools : []).slice(0, 32).map((t: any) => ({
    name: String(t.name).slice(0, 64),
    description: String(t.description ?? t.title ?? '').slice(0, 1000),
    input_schema: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  }));
  if (out.length) (out[out.length - 1] as any).cache_control = { type: 'ephemeral' };
  return out;
}

/** The Messages API body, identical to what brain.mjs sends to the Anthropic API (explicit cache breakpoints). */
export function anthropicParams(req: TurnRequest) {
  return {
    model: req.model,
    max_tokens: 1024,
    system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
    tools: toAnthropicTools(req.tools),
    output_config: { effort: 'low' as const },
    messages: req.messages,
  };
}

const THINKING_TAGS = /<thinking>[\s\S]*?<\/thinking>\s*/g;

function converseBlocks(content: unknown): any[] {
  if (typeof content === 'string') return content.trim() ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: any[] = [];
  for (const b of content as any[]) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ text: b.text });
    else if (b?.type === 'tool_use') out.push({ toolUse: { toolUseId: String(b.id), name: String(b.name), input: b.input ?? {} } });
    else if (b?.type === 'tool_result') {
      const text = typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
      out.push({ toolResult: { toolUseId: String(b.tool_use_id), content: [{ text: text || '(empty)' }], status: b.is_error ? 'error' : 'success' } });
    }
    // thinking / redacted_thinking / anything else: Anthropic-only, dropped for Converse
  }
  return out;
}

/** Anthropic messages + MCP tools -> a Bedrock Converse request (roles alternate, starts with the user). */
export function toConverse(req: TurnRequest) {
  const messages: { role: 'user' | 'assistant'; content: any[] }[] = [];
  for (const m of req.messages) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = converseBlocks(m?.content);
    if (!content.length) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const tools = (Array.isArray(req.tools) ? req.tools : []).slice(0, 32).map((t) => ({
    toolSpec: {
      name: String(t.name).slice(0, 64),
      description: String(t.description ?? t.title ?? t.name).slice(0, 1000) || String(t.name),
      inputSchema: { json: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} } },
    },
  }));
  return {
    modelId: req.model,
    system: [{ text: req.system }],
    messages,
    ...(tools.length ? { toolConfig: { tools } } : {}),
    inferenceConfig: { maxTokens: 1024 },
  };
}

const STOP: Record<string, string> = { tool_use: 'tool_use', end_turn: 'end_turn', max_tokens: 'max_tokens', stop_sequence: 'stop_sequence' };

/** Converse response -> Anthropic-shaped turn. Nova's <thinking> notes are removed from spoken text. */
export function fromConverse(out: any, model: string): TurnResult {
  const content: any[] = [];
  for (const b of out?.output?.message?.content ?? []) {
    if (typeof b?.text === 'string') {
      const text = b.text.replace(THINKING_TAGS, '').trim();
      if (text) content.push({ type: 'text', text });
    } else if (b?.toolUse) {
      content.push({ type: 'tool_use', id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {} });
    }
  }
  const u = out?.usage ?? {};
  return {
    content,
    stop_reason: STOP[out?.stopReason] ?? out?.stopReason ?? null,
    usage: { input_tokens: u.inputTokens ?? 0, output_tokens: u.outputTokens ?? 0, cache_read_input_tokens: u.cacheReadInputTokens ?? 0, cache_creation_input_tokens: u.cacheWriteInputTokens ?? 0 },
    model,
  };
}

/* ---------------- providers (real AWS calls, loaded lazily) ---------------- */

export type CallFn = (req: TurnRequest) => Promise<TurnResult>;

export function bedrockCall(provider: Provider, region: string): CallFn {
  if (provider === 'claude-api') {
    let client: any = null;
    return async (req) => {
      const key = process.env.ANTHROPIC_API_KEY?.trim();
      if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client ??= new Anthropic({ apiKey: key, maxRetries: 1, timeout: 25_000 });
      const r = await client.messages.create(anthropicParams(req) as any);
      return { content: r.content, stop_reason: r.stop_reason, usage: r.usage, model: r.model ?? req.model };
    };
  }
  if (provider === 'anthropic') {
    let client: any = null;
    return async (req) => {
      const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
      client ??= new AnthropicBedrockMantle({ awsRegion: region, maxRetries: 1, timeout: 25_000 });
      const r = await client.messages.create(anthropicParams(req) as any);
      return { content: r.content, stop_reason: r.stop_reason, usage: r.usage, model: r.model ?? req.model };
    };
  }
  if (provider === 'nova') {
    let client: any = null;
    return async (req) => {
      const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
      client ??= new BedrockRuntimeClient({ region, maxAttempts: 2 });
      const out = await client.send(new ConverseCommand(toConverse(req) as any));
      return fromConverse(out, req.model);
    };
  }
  return async () => { throw new Error('brain is off'); };
}

/* ---------------- counters ---------------- */

export interface Counter {
  get(key: string): Promise<number>;
  /** Atomic add; returns the new value. The item expires `ttlSec` from now (DynamoDB TTL, best effort). */
  add(key: string, by: number, ttlSec: number): Promise<number>;
}

export class MemoryCounter implements Counter {
  private m = new Map<string, number>();
  async get(key: string) { return this.m.get(key) ?? 0; }
  async add(key: string, by: number, _ttlSec = 0) { void _ttlSec; const v = (this.m.get(key) ?? 0) + by; this.m.set(key, v); return v; }
}

/** The one method we use, so tests can pass a fake (same pattern as dynamo.ts). */
export interface DocSender { send(command: any): Promise<any> }

export class DynamoDbCounter implements Counter {
  constructor(private readonly db: DocSender, private readonly table: string, private readonly cmds: { Get: any; Update: any }) {}

  static async create(table: string): Promise<DynamoDbCounter> {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    return new DynamoDbCounter(DynamoDBDocumentClient.from(new DynamoDBClient({})), table, { Get: GetCommand, Update: UpdateCommand });
  }

  async get(key: string): Promise<number> {
    const out = await this.db.send(new this.cmds.Get({ TableName: this.table, Key: { pk: key }, ConsistentRead: true }));
    return Number(out?.Item?.n ?? 0);
  }

  async add(key: string, by: number, ttlSec: number): Promise<number> {
    const out = await this.db.send(new this.cmds.Update({
      TableName: this.table,
      Key: { pk: key },
      UpdateExpression: 'ADD #n :by SET #exp = if_not_exists(#exp, :exp)',
      ExpressionAttributeNames: { '#n': 'n', '#exp': 'expires_at' },
      ExpressionAttributeValues: { ':by': by, ':exp': Math.floor(Date.now() / 1000) + ttlSec },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(out?.Attributes?.n ?? by);
  }
}

/* ---------------- the brain ---------------- */

export interface BrainConfig { provider: Provider; model: string; limitUsd: number; ipTurnsPerHour: number }

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BrainConfig & { region: string } {
  const raw = (env.BRAIN_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const provider: Provider = raw === 'nova' || raw === 'off' || raw === 'claude-api' ? raw : 'anthropic';
  return {
    provider,
    model: env.BRAIN_MODEL?.trim() || (provider === 'off' ? '' : DEFAULT_MODEL[provider]),
    limitUsd: Number(env.DAILY_LIMIT_USD ?? 0.5),
    ipTurnsPerHour: Number(env.BRAIN_IP_TURNS_PER_HOUR ?? 60),
    region: env.BRAIN_REGION ?? env.AWS_REGION ?? 'us-east-1',
  };
}

const MICRO = 1e6;
const dayKey = (d: Date) => `brain:${d.toISOString().slice(0, 10)}`;
const ipKey = (ip: string, d: Date) => `brain-ip:${createHash('sha256').update(ip).digest('hex').slice(0, 16)}:${d.toISOString().slice(0, 13)}`;

export function createBrain(deps: { config: BrainConfig; call: CallFn; counter: Counter; system?: string; now?: () => Date; log?: (msg: string, extra?: Record<string, unknown>) => void }) {
  const { config, call, counter } = deps;
  const system = deps.system ?? SYSTEM;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  async function status() {
    const spent = Math.round(await counter.get(dayKey(now()))) / MICRO;
    const reason = config.provider === 'off' ? 'disabled' : spent >= config.limitUsd ? 'daily_limit' : null;
    return {
      llm: !reason, reason, provider: config.provider, model: config.model, label: LABEL[config.provider],
      spent_today: spent, limit_usd: config.limitUsd, ip_turns_per_hour: config.ipTurnsPerHour,
      skill: skill?.name ?? null, system_chars: system.length,
    };
  }

  async function turn(body: any, ip: string): Promise<[number, Record<string, unknown>]> {
    const st = await status();
    if (!st.llm) return [st.reason === 'disabled' ? 503 : 429, { fallback: true, ...st }];
    const messages = Array.isArray(body?.messages) ? body.messages.slice(-40) : [];
    if (!messages.length) return [400, { error: 'messages required' }];
    const t = now();
    const turns = await counter.add(ipKey(ip || 'unknown', t), 1, 2 * 3600);
    if (turns > config.ipTurnsPerHour) return [429, { fallback: true, ...st, llm: false, reason: 'ip_limit' }];
    const started = Date.now();
    try {
      const r = await call({ system, tools: Array.isArray(body?.tools) ? body.tools : [], messages, model: config.model });
      const cost = costOf(config.provider, r.usage);
      const spentMicro = await counter.add(dayKey(t), Math.ceil(cost * MICRO), 3 * 86400);
      const spent = spentMicro / MICRO;
      log('brain_turn', { provider: config.provider, stop: r.stop_reason, ms: Date.now() - started, in: r.usage.input_tokens, out: r.usage.output_tokens, cache_r: r.usage.cache_read_input_tokens ?? 0, cost, spent });
      return [200, { content: r.content, stop_reason: r.stop_reason, usage: r.usage, cost_usd: cost, spent_today: spent, limit_usd: config.limitUsd, model: r.model, provider: config.provider }];
    } catch (e: any) {
      const code = Number(e?.status ?? e?.$metadata?.httpStatusCode ?? 502);
      log('brain_error', { provider: config.provider, status: code, name: e?.name, message: String(e?.message).slice(0, 300) });
      // any model trouble -> the simulator falls back to its keyword router for this turn
      return [code === 400 ? 400 : 503, { fallback: true, reason: 'api_error', status: code, message: String(e?.message).slice(0, 300) }];
    }
  }

  return { status, turn };
}

/* ---------------- HTTP route (used by lambda.ts through hosted.ts) ---------------- */

let brain: ReturnType<typeof createBrain> | null = null;

async function defaultBrain() {
  const cfg = configFromEnv();
  const table = process.env.TABLE_NAME?.trim();
  const counter = (process.env.STATE_STORE ?? '').toLowerCase() === 'dynamodb' && table ? await DynamoDbCounter.create(table) : new MemoryCounter();
  const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
  return createBrain({ config: cfg, call: bedrockCall(cfg.provider, cfg.region), counter, log });
}

/** GET /brain/health (alias /brain/status) and POST /brain/turn (alias POST /brain). */
export async function brainRoute(method: string, path: string, rawBody: string, ip: string, b?: ReturnType<typeof createBrain>): Promise<{ status: number; body: unknown }> {
  const br = b ?? (brain ??= await defaultBrain());
  if (method === 'GET' && (path === '/brain/health' || path === '/brain/status')) return { status: 200, body: await br.status() };
  if (method === 'POST' && (path === '/brain/turn' || path === '/brain')) {
    if (rawBody.length > 400_000) return { status: 413, body: { error: 'body too large' } };
    let body: unknown;
    try { body = JSON.parse(rawBody || '{}'); } catch { return { status: 400, body: { error: 'bad json' } }; }
    const [status, out] = await br.turn(body, ip);
    return { status, body: out };
  }
  return { status: 404, body: { error: 'not found' } };
}
