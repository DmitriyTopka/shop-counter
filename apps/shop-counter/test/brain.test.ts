// The Bedrock brain without AWS: the model call is a mock, counters are in memory or a fake DynamoDB.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';
import {
  anthropicParams, brainRoute, configFromEnv, costOf, createBrain, DynamoDbCounter, fromConverse, MemoryCounter, SYSTEM, toConverse,
  type BrainConfig, type CallFn, type TurnRequest,
} from '../src/brain.js';
import { serveSim } from '../src/hosted.js';
import { BASE, loadSkill, systemPrompt } from '../../../skills/shop-counter/system-prompt.mjs';

const TOOLS = [
  { name: 'find_products', description: 'Find products', inputSchema: { type: 'object', properties: { need: { type: 'string' } } } },
  { name: 'check_compatibility', description: 'Check fit', inputSchema: { type: 'object', properties: { product_id: { type: 'string' } } } },
];
const USER = [{ role: 'user', content: [{ type: 'text', text: 'Find a charger for my iPhone 15' }] }];
const cfg = (o: Partial<BrainConfig> = {}): BrainConfig => ({ provider: 'anthropic', model: 'anthropic.claude-haiku-5-5', limitUsd: 0.5, ipTurnsPerHour: 60, ...o });

/** Mock model: records requests, answers with a fixed usage. */
function mockCall(usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 }) {
  const seen: TurnRequest[] = [];
  const call: CallFn = async (req) => {
    seen.push(req);
    return { content: [{ type: 'tool_use', id: 'toolu_1', name: 'find_products', input: { need: 'charger' } }], stop_reason: 'tool_use', usage, model: req.model };
  };
  return { call, seen };
}

describe('system prompt: one source for brain.mjs and the Lambda brain', () => {
  it('Lambda SYSTEM is the shared persona + SKILL.md, same bytes as the local proxy builds', () => {
    const skill = loadSkill(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'shop-counter', 'SKILL.md'));
    expect(skill?.name).toBe('shop-counter');
    expect(SYSTEM).toBe(systemPrompt(skill));
    expect(SYSTEM.startsWith(BASE)).toBe(true);
    expect(SYSTEM).toContain('<skill name="shop-counter">');
  });
});

describe('cost and prices', () => {
  it('Haiku 5.5 on Bedrock counts the regional rate (x1.1 of $0.10 / $0.50 per 1M)', () => {
    expect(costOf('anthropic', { input_tokens: 1_000_000 })).toBeCloseTo(0.11, 6);
    expect(costOf('anthropic', { output_tokens: 1_000_000 })).toBeCloseTo(0.55, 6);
    expect(costOf('anthropic', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.011, 6);
    expect(costOf('nova', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.3, 6);
    expect(costOf('off', { input_tokens: 5 })).toBe(0);
  });
  it('env config: anthropic by default, nova and off by flag, model ids per provider', () => {
    expect(configFromEnv({})).toMatchObject({ provider: 'anthropic', model: 'anthropic.claude-haiku-5-5', limitUsd: 0.5, ipTurnsPerHour: 60, region: 'us-east-1' });
    expect(configFromEnv({ BRAIN_PROVIDER: 'nova' })).toMatchObject({ provider: 'nova', model: 'amazon.nova-lite-v1:0' });
    expect(configFromEnv({ BRAIN_PROVIDER: 'off' }).provider).toBe('off');
    expect(configFromEnv({ BRAIN_PROVIDER: 'nonsense', DAILY_LIMIT_USD: '0.2' })).toMatchObject({ provider: 'anthropic', limitUsd: 0.2 });
  });
});

describe('limits', () => {
  it('a turn returns the model content and adds its cost to the day counter', async () => {
    const counter = new MemoryCounter();
    const { call, seen } = mockCall();
    const b = createBrain({ config: cfg(), call, counter, system: 'SYS', now: () => new Date('2026-10-20T10:00:00Z') });
    const [code, out] = await b.turn({ messages: USER, tools: TOOLS }, '1.2.3.4');
    expect(code).toBe(200);
    expect(out.stop_reason).toBe('tool_use');
    expect((out.content as any[])[0].name).toBe('find_products');
    expect(seen[0]).toMatchObject({ system: 'SYS', model: 'anthropic.claude-haiku-5-5' });
    const cost = costOf('anthropic', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 8000 });
    expect(out.cost_usd).toBe(cost);
    expect(await counter.get('brain:2026-10-20')).toBe(Math.ceil(cost * 1e6));
    expect((await b.status()).spent_today).toBeCloseTo(cost, 5); // counted in whole micro-dollars, rounded up
  });

  it('at the daily limit: {fallback:true, reason daily_limit}, the model is not called', async () => {
    const counter = new MemoryCounter();
    await counter.add('brain:2026-10-20', 500_000, 1); // $0.50 already spent
    const { call, seen } = mockCall();
    const b = createBrain({ config: cfg(), call, counter, now: () => new Date('2026-10-20T23:59:00Z') });
    expect((await b.status())).toMatchObject({ llm: false, reason: 'daily_limit', spent_today: 0.5 });
    const [code, out] = await b.turn({ messages: USER, tools: TOOLS }, '1.2.3.4');
    expect(code).toBe(429);
    expect(out).toMatchObject({ fallback: true, reason: 'daily_limit' });
    expect(seen).toHaveLength(0);
    // next UTC day starts from zero
    const next = createBrain({ config: cfg(), call, counter, now: () => new Date('2026-10-21T00:01:00Z') });
    expect((await next.status()).llm).toBe(true);
  });

  it('a turn that crosses the limit is the last one', async () => {
    const counter = new MemoryCounter();
    const { call } = mockCall({ input_tokens: 4_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }); // $0.44
    const b = createBrain({ config: cfg(), call, counter, now: () => new Date('2026-10-20T10:00:00Z') });
    expect((await b.turn({ messages: USER }, 'a'))[0]).toBe(200);
    expect((await b.turn({ messages: USER }, 'a'))[0]).toBe(200); // $0.88 now
    const [code, out] = await b.turn({ messages: USER }, 'a');
    expect(code).toBe(429);
    expect(out.reason).toBe('daily_limit');
  });

  it('per caller: 60 turns an hour, then fallback for that IP only; the next hour is fresh', async () => {
    const counter = new MemoryCounter();
    const { call, seen } = mockCall({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    let now = new Date('2026-10-20T10:05:00Z');
    const b = createBrain({ config: cfg({ ipTurnsPerHour: 3 }), call, counter, now: () => now });
    for (let i = 0; i < 3; i++) expect((await b.turn({ messages: USER }, '9.9.9.9'))[0]).toBe(200);
    const [code, out] = await b.turn({ messages: USER }, '9.9.9.9');
    expect(code).toBe(429);
    expect(out).toMatchObject({ fallback: true, reason: 'ip_limit', llm: false });
    expect((await b.turn({ messages: USER }, '8.8.8.8'))[0]).toBe(200);
    expect(seen).toHaveLength(4);
    now = new Date('2026-10-20T11:00:00Z');
    expect((await b.turn({ messages: USER }, '9.9.9.9'))[0]).toBe(200);
  });

  it('BRAIN_PROVIDER=off and model errors both answer fallback, so the router takes over', async () => {
    const off = createBrain({ config: cfg({ provider: 'off' }), call: mockCall().call, counter: new MemoryCounter() });
    expect(await off.turn({ messages: USER }, 'x')).toEqual([503, expect.objectContaining({ fallback: true, reason: 'disabled' })]);
    const denied: CallFn = async () => { throw Object.assign(new Error('not authorized to perform bedrock-mantle:CreateInference'), { status: 403 }); };
    const b = createBrain({ config: cfg(), call: denied, counter: new MemoryCounter() });
    const [code, out] = await b.turn({ messages: USER }, 'x');
    expect(code).toBe(503);
    expect(out).toMatchObject({ fallback: true, reason: 'api_error', status: 403 });
    const awsErr: CallFn = async () => { throw Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429 } }); };
    expect((await createBrain({ config: cfg({ provider: 'nova' }), call: awsErr, counter: new MemoryCounter() }).turn({ messages: USER }, 'x'))[1]).toMatchObject({ fallback: true, status: 429 });
  });

  it('DynamoDB counter: atomic ADD with a TTL, consistent read', async () => {
    const sent: any[] = [];
    const db = { send: async (c: any) => { sent.push(c); return c instanceof UpdateCommand ? { Attributes: { n: 42 } } : { Item: { pk: 'k', n: 7 } }; } };
    const c = new DynamoDbCounter(db, 'shop-counter-state', { Get: GetCommand, Update: UpdateCommand });
    expect(await c.add('brain:2026-10-20', 5, 3600)).toBe(42);
    expect(await c.get('brain:2026-10-20')).toBe(7);
    const u = sent[0].input;
    expect(u).toMatchObject({ TableName: 'shop-counter-state', Key: { pk: 'brain:2026-10-20' }, UpdateExpression: 'ADD #n :by SET #exp = if_not_exists(#exp, :exp)', ReturnValues: 'UPDATED_NEW' });
    expect(u.ExpressionAttributeValues[':by']).toBe(5);
    expect(u.ExpressionAttributeValues[':exp']).toBeGreaterThan(Date.now() / 1000);
    expect(sent[1].input).toMatchObject({ Key: { pk: 'brain:2026-10-20' }, ConsistentRead: true });
  });
});

describe('request formats', () => {
  const req: TurnRequest = { system: 'SYS', tools: TOOLS, model: 'm', messages: [] };

  it('Anthropic on Bedrock gets the same body as brain.mjs: cache breakpoints, low effort, tools as input_schema', () => {
    const p = anthropicParams({ ...req, messages: USER });
    expect(p.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.tools.map((t) => t.name)).toEqual(['find_products', 'check_compatibility']);
    expect(p.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(p.tools[0].input_schema.properties.need.type).toBe('string');
    expect(p.messages).toBe(USER);
  });

  it('Anthropic -> Converse: tool_use/tool_result kept, thinking dropped, roles merged, starts with the user', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'stray' }] }, // dropped: Converse must start with user
      { role: 'user', content: [{ type: 'text', text: '[screen] 2 marked' }] },
      { role: 'user', content: 'Will it fit?' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_9', name: 'check_compatibility', input: { product_id: 'p1' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'The store lists your iPhone 15.' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }, // empty after dropping thinking
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'boom' }], is_error: true }] },
    ];
    const c = toConverse({ ...req, messages });
    expect(c.modelId).toBe('m');
    expect(c.system).toEqual([{ text: 'SYS' }]);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(c.messages[0].content).toEqual([{ text: '[screen] 2 marked' }, { text: 'Will it fit?' }]);
    expect(c.messages[1].content).toEqual([{ text: 'Checking.' }, { toolUse: { toolUseId: 'toolu_9', name: 'check_compatibility', input: { product_id: 'p1' } } }]);
    expect(c.messages[2].content).toEqual([
      { toolResult: { toolUseId: 'toolu_9', content: [{ text: 'The store lists your iPhone 15.' }], status: 'success' } },
      { toolResult: { toolUseId: 'x', content: [{ text: 'boom' }], status: 'error' } },
    ]);
    expect(c.toolConfig?.tools[0]).toEqual({ toolSpec: { name: 'find_products', description: 'Find products', inputSchema: { json: TOOLS[0].inputSchema } } });
    expect(c.inferenceConfig).toEqual({ maxTokens: 1024 });
  });

  it('Converse -> Anthropic: toolUse becomes tool_use, Nova <thinking> notes are not spoken, usage renamed', () => {
    const r = fromConverse({
      output: { message: { role: 'assistant', content: [
        { text: '<thinking>The shopper wants a charger.</thinking>\nLet me look.' },
        { toolUse: { toolUseId: 'tooluse_abc', name: 'find_products', input: { need: 'charger' } } },
      ] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240 },
    }, 'amazon.nova-lite-v1:0');
    expect(r.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'tooluse_abc', name: 'find_products', input: { need: 'charger' } },
    ]);
    expect(r.stop_reason).toBe('tool_use');
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(fromConverse({ output: { message: { content: [{ text: '<thinking>x</thinking>' }] } }, stopReason: 'end_turn' }, 'm').content).toEqual([]);
  });
});

describe('HTTP routes on the Lambda', () => {
  it('GET /brain/health and /brain/status, POST /brain/turn and /brain, bad JSON, 404', async () => {
    const { call } = mockCall();
    const b = createBrain({ config: cfg(), call, counter: new MemoryCounter() });
    expect((await brainRoute('GET', '/brain/health', '', 'ip', b))).toMatchObject({ status: 200, body: { llm: true, provider: 'anthropic', label: 'Claude Haiku 5.5 on Amazon Bedrock' } });
    expect((await brainRoute('GET', '/brain/status', '', 'ip', b)).status).toBe(200);
    expect((await brainRoute('POST', '/brain/turn', JSON.stringify({ messages: USER, tools: TOOLS }), 'ip', b)).status).toBe(200);
    expect((await brainRoute('POST', '/brain', JSON.stringify({ messages: USER }), 'ip', b)).status).toBe(200);
    expect((await brainRoute('POST', '/brain/turn', '{oops', 'ip', b)).status).toBe(400);
    expect((await brainRoute('POST', '/brain/turn', '{}', 'ip', b)).status).toBe(400);
    expect((await brainRoute('GET', '/brain/nope', '', 'ip', b)).status).toBe(404);
  });

  const dir = mkdtempSync(join(tmpdir(), 'sim-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<script src="./assets/a.js"></script>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'p.png'), Buffer.from([137, 80, 78, 71]));

  it('static simulator: / and /sim redirect to /sim/, index fresh, hashed assets cached, png as base64, no escape', () => {
    expect(serveSim('/', dir)).toMatchObject({ statusCode: 302, headers: { location: '/sim/' } });
    expect(serveSim('/sim', dir).headers.location).toBe('/sim/');
    const idx = serveSim('/sim/', dir);
    expect(idx).toMatchObject({ statusCode: 200, isBase64Encoded: false, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    expect(idx.body).toContain('./assets/a.js');
    expect(serveSim('/sim/assets/a.js', dir)).toMatchObject({ statusCode: 200, body: 'console.log(1)', headers: { 'cache-control': 'public, max-age=31536000, immutable' } });
    expect(serveSim('/sim/assets/p.png', dir)).toMatchObject({ statusCode: 200, isBase64Encoded: true, body: Buffer.from([137, 80, 78, 71]).toString('base64') });
    expect(serveSim('/sim/../../package.json', dir).statusCode).toBe(404);
    expect(serveSim('/sim/%2e%2e/%2e%2e/package.json', dir).statusCode).toBe(404);
    expect(serveSim('/sim/nope.js', dir).statusCode).toBe(404);
  });
});

describe('real Bedrock SDK clients, network mocked', () => {
  it('anthropic: AnthropicBedrockMantle signs with SigV4 for bedrock-mantle and posts the Messages body to us-east-1', async () => {
    const { bedrockCall } = await import('../src/brain.js');
    const keep = { ...process.env };
    const realFetch = globalThis.fetch;
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secretexample', AWS_SESSION_TOKEN: 'tokenexample' });
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_PROFILE;
    const seen: { url: string; headers: Headers; body: any }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'anthropic.claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'Here are three chargers.' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const r = await bedrockCall('anthropic', 'us-east-1')({ system: 'SYS', tools: TOOLS, messages: USER, model: 'anthropic.claude-haiku-5-5' });
      expect(r.content).toEqual([{ type: 'text', text: 'Here are three chargers.' }]);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
      expect(seen[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/);
      expect(seen[0].headers.get('x-amz-security-token')).toBe('tokenexample');
      expect(seen[0].body).toMatchObject({ model: 'anthropic.claude-haiku-5-5', max_tokens: 1024, output_config: { effort: 'low' } });
      expect(seen[0].body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    } finally {
      globalThis.fetch = realFetch;
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
    }
  });
});
