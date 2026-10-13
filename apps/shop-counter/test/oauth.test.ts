// Account linking (OAuth 2.1 after MCP Authorization 2025-11-25), end to end through the Lambda entry.
// Offline: no network; the Client ID Metadata Document case uses an injected fetch.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStateStore } from 'shelf-to-alexa';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'shop-counter-oauth-'));
process.env.SHOP_COUNTER_SECRET = 'test-secret';
process.env.SHOP_COUNTER_STATE_DIR = dir;
process.env.SHOP_COUNTER_CACHE_DIR = join(dir, 'cache');
delete process.env.PUBLIC_BASE_URL;
globalThis.fetch = async () => { throw new Error('offline test: no network'); };
const { handler } = await import('../src/lambda.js');
const { createOAuth, pkceChallenge, privateAddress } = await import('../src/oauth.js');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOST = 'shop.example.aws';
const ORIGIN = `https://${HOST}`;
const REDIRECT = 'http://localhost:5180/';

type Res = Awaited<ReturnType<typeof handler>>;
const call = (method: string, path: string, opts: { query?: Record<string, string>; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> =>
  handler({
    rawPath: path,
    rawQueryString: opts.query ? new URLSearchParams(opts.query).toString() : undefined,
    headers: {
      ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.form ? new URLSearchParams(opts.form).toString() : opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    requestContext: { http: { method }, domainName: HOST },
  });
const body = (r: Res) => JSON.parse(r.body);
const rpc = (method: string, params: unknown, headers: Record<string, string> = {}, path = '/mcp') =>
  call('POST', path, {
    json: { jsonrpc: '2.0', id: 1, method, params },
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers },
  });
const sc = (r: Res) => JSON.parse(r.body.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).result.structuredContent;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(redirect = REDIRECT) {
  const r = await call('POST', '/register', { json: { client_name: 'Echo Show simulator', redirect_uris: [redirect], token_endpoint_auth_method: 'none' } });
  expect(r.statusCode).toBe(201);
  return body(r).client_id as string;
}

/** Consent as `shopper` and return the code from the redirect. */
async function getCode(clientId: string, opts: { resource?: string; shopper?: string; redirect?: string } = {}) {
  const { verifier, challenge } = pkce();
  const params: Record<string, string> = {
    response_type: 'code', client_id: clientId, redirect_uri: opts.redirect ?? REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-1', scope: 'shopper', resource: opts.resource ?? `${ORIGIN}/mcp`,
  };
  const page = await call('GET', '/authorize', { query: params });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('Link Shop Counter to Alexa');
  const r = await call('POST', '/authorize', { form: { ...params, shopper: opts.shopper ?? 'maya', decision: 'allow' } });
  expect(r.statusCode).toBe(302);
  const loc = new URL(r.headers.location);
  expect(loc.searchParams.get('state')).toBe('st-1');
  expect(loc.searchParams.get('iss')).toBe(ORIGIN);
  return { code: loc.searchParams.get('code')!, verifier, params };
}

const exchange = (form: Record<string, string>) => call('POST', '/token', { form: { grant_type: 'authorization_code', redirect_uri: REDIRECT, ...form } });

describe('account linking (OAuth 2.1)', () => {
  it('publishes protected resource and authorization server metadata', async () => {
    const root = body(await call('GET', '/.well-known/oauth-protected-resource'));
    expect(root).toMatchObject({ resource: ORIGIN, authorization_servers: [ORIGIN], scopes_supported: ['shopper'] });
    expect(body(await call('GET', '/.well-known/oauth-protected-resource/mcp')).resource).toBe(`${ORIGIN}/mcp`);
    expect(body(await call('GET', '/.well-known/oauth-protected-resource/stores/roborock/mcp')).resource).toBe(`${ORIGIN}/stores/roborock/mcp`);
    expect((await call('GET', '/.well-known/oauth-protected-resource/stores/nope/mcp')).statusCode).toBe(404);
    const as = body(await call('GET', '/.well-known/oauth-authorization-server'));
    expect(as).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register`,
      code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('full flow: register -> authorize -> token -> tools/call as the linked shopper, then refresh', async () => {
    const clientId = await registerClient();
    const { code, verifier } = await getCode(clientId, { shopper: 'sam' });
    const t = await exchange({ client_id: clientId, code, code_verifier: verifier, resource: `${ORIGIN}/mcp` });
    expect(t.statusCode).toBe(200);
    expect(t.headers['cache-control']).toBe('no-store');
    const tok = body(t);
    expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'shopper', resource: `${ORIGIN}/mcp`, user_id: 'demo-sam' });
    const auth = { authorization: `Bearer ${tok.access_token}` };
    expect(sc(await rpc('tools/call', { name: 'remember_my_devices', arguments: { devices: ['Roborock Q7 M5'] } }, auth)).devices).toContain('Roborock Q7 M5');
    expect(sc(await rpc('tools/call', { name: 'my_devices', arguments: {} }, auth)).devices).toContain('Roborock Q7 M5');

    // refresh: a new pair; the old refresh token is spent (rotation)
    const r1 = await call('POST', '/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tok.refresh_token } });
    expect(r1.statusCode).toBe(200);
    expect(body(r1).refresh_token).not.toBe(tok.refresh_token);
    const r2 = await call('POST', '/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tok.refresh_token } });
    expect(body(r2)).toMatchObject({ error: 'invalid_grant' });
  });

  it('a whole-server token works at every store; a store token only at its store', async () => {
    const clientId = await registerClient();
    const all = await getCode(clientId, { resource: ORIGIN, shopper: 'guest' });
    const tAll = body(await exchange({ client_id: clientId, code: all.code, code_verifier: all.verifier, resource: ORIGIN }));
    expect(tAll.user_id).toMatch(/^guest-/);
    for (const path of ['/mcp', '/stores/roborock/mcp']) {
      expect((await rpc('tools/call', { name: 'my_devices', arguments: {} }, { authorization: `Bearer ${tAll.access_token}` }, path)).statusCode).toBe(200);
    }
    const robo = await getCode(clientId, { resource: `${ORIGIN}/stores/roborock/mcp` });
    const tRobo = body(await exchange({ client_id: clientId, code: robo.code, code_verifier: robo.verifier }));
    const auth = { authorization: `Bearer ${tRobo.access_token}` };
    expect((await rpc('tools/call', { name: 'my_devices', arguments: {} }, auth, '/stores/roborock/mcp')).statusCode).toBe(200);
    const wrong = await rpc('tools/call', { name: 'my_devices', arguments: {} }, auth, '/mcp');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(wrong.headers['www-authenticate']).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('refuses a wrong code_verifier, a foreign redirect_uri, a replayed code and an expired code', async () => {
    const clientId = await registerClient();
    // wrong verifier
    const a = await getCode(clientId);
    expect(body(await exchange({ client_id: clientId, code: a.code, code_verifier: pkce().verifier }))).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('PKCE') });
    // the code was not spent by the failed attempt, the right verifier still works once...
    expect((await exchange({ client_id: clientId, code: a.code, code_verifier: a.verifier })).statusCode).toBe(200);
    // ...and only once
    expect(body(await exchange({ client_id: clientId, code: a.code, code_verifier: a.verifier }))).toMatchObject({ error: 'invalid_grant', error_description: 'authorization code already used' });

    // a redirect_uri the client did not register: an error page, never a redirect
    const evil = await call('GET', '/authorize', { query: { ...a.params, redirect_uri: 'https://evil.example/cb' } });
    expect(evil.statusCode).toBe(400);
    expect(evil.headers.location).toBeUndefined();
    expect(evil.body).toContain('not registered');
    // same at the token endpoint
    const b = await getCode(clientId);
    expect(body(await exchange({ client_id: clientId, code: b.code, code_verifier: b.verifier, redirect_uri: 'http://localhost:9999/' }))).toMatchObject({ error: 'invalid_grant' });
    // another client cannot redeem it
    const other = await registerClient('http://localhost:5181/');
    expect(body(await exchange({ client_id: other, code: b.code, code_verifier: b.verifier }))).toMatchObject({ error: 'invalid_grant' });

    // expired (60 s TTL)
    const c = await getCode(clientId);
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    try {
      expect(body(await exchange({ client_id: clientId, code: c.code, code_verifier: c.verifier }))).toMatchObject({ error: 'invalid_grant', error_description: 'authorization code expired' });
    } finally { vi.useRealTimers(); }
  });

  it('validates the authorization request: PKCE S256 required, resource must be ours, deny goes back with access_denied', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const base = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' };
    const err = async (q: Record<string, string>) => {
      const r = await call('GET', '/authorize', { query: q });
      expect(r.statusCode).toBe(302);
      return new URL(r.headers.location).searchParams.get('error');
    };
    expect(await err({ ...base, code_challenge_method: 'plain' })).toBe('invalid_request');
    expect(await err({ ...base, code_challenge: '' })).toBe('invalid_request');
    expect(await err({ ...base, resource: 'https://other.example/mcp' })).toBe('invalid_target');
    expect(await err({ ...base, resource: `${ORIGIN}/stores/nope/mcp` })).toBe('invalid_target');
    expect(await err({ ...base, scope: 'admin' })).toBe('invalid_scope');
    const deny = await call('POST', '/authorize', { form: { ...base, shopper: 'maya', decision: 'deny' } });
    expect(new URL(deny.headers.location).searchParams.get('error')).toBe('access_denied');
    // unknown client: error page
    expect((await call('GET', '/authorize', { query: { ...base, client_id: 'dcr.forged.sig' } })).statusCode).toBe(400);
    // registration refuses non-https, non-localhost redirect URIs
    expect((await call('POST', '/register', { json: { redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400);
  });

  it('keeps anonymous search, adds resource_metadata to every 401, and can require a token', async () => {
    const anon = await rpc('tools/call', { name: 'my_devices', arguments: {} });
    expect(anon.statusCode).toBe(200);
    expect(sc(anon)).toMatchObject({ kind: 'error', code: 'anonymous' });
    const bad = await rpc('tools/list', {}, { authorization: 'Bearer nope.nope' }, '/stores/roborock/mcp');
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toBe(`Bearer error="invalid_token", error_description="session invalid", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/stores/roborock/mcp", scope="shopper"`);
    process.env.SHOP_COUNTER_REQUIRE_AUTH = '1';
    try {
      const r = await rpc('tools/list', {});
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="shopper"`);
    } finally { delete process.env.SHOP_COUNTER_REQUIRE_AUTH; }
  });

  it('demo-login sessions still work everywhere (fallback for the judges curl)', async () => {
    const s = body(await call('POST', '/auth/demo-login', { json: { profile: 'guest' } }));
    for (const path of ['/mcp', '/stores/roborock/mcp']) {
      expect((await rpc('tools/call', { name: 'my_devices', arguments: {} }, { authorization: `Bearer ${s.token}` }, path)).statusCode).toBe(200);
    }
  });
});

describe('Client ID Metadata Documents', () => {
  const CID = 'https://alexa.example.com/oauth/client.json';
  const doc = { client_id: CID, client_name: 'Alexa+', redirect_uris: ['https://alexa.example.com/cb'], token_endpoint_auth_method: 'none' };
  const make = (served: unknown) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(served), { status: 200 }));
    const oauth = createOAuth({
      secret: 's', state: new MemoryStateStore(), storeIds: ['satechi'], signAccess: (u, a) => `tok:${u}:${a}`,
      shopperFor: (c) => (c === 'maya' ? 'demo-maya' : null), fetchFn: fetchFn as unknown as typeof fetch,
    });
    return { oauth, fetchFn };
  };
  const req = (method: string, path: string, q: Record<string, string>, form?: Record<string, string>) => ({
    method, path, query: new URLSearchParams(q), header: (n: string) => (n === 'content-type' && form ? 'application/x-www-form-urlencoded' : undefined),
    body: form ? new URLSearchParams(form).toString() : '', origin: ORIGIN,
  });

  it('uses an https client_id document: name on the consent page, its redirect URIs only', async () => {
    const { oauth, fetchFn } = make(doc);
    const verifier = randomBytes(32).toString('base64url');
    const q = { response_type: 'code', client_id: CID, redirect_uri: 'https://alexa.example.com/cb', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` };
    const page = await oauth.handle(req('GET', '/authorize', q));
    expect(page!.body).toContain('Alexa+');
    expect(page!.body).toContain('alexa.example.com');
    const r = await oauth.handle(req('POST', '/authorize', {}, { ...q, shopper: 'maya', decision: 'allow' }));
    const code = new URL(r!.headers.location).searchParams.get('code')!;
    const t = await oauth.handle(req('POST', '/token', {}, { grant_type: 'authorization_code', client_id: CID, code, code_verifier: verifier, redirect_uri: 'https://alexa.example.com/cb' }));
    expect(JSON.parse(t!.body).access_token).toBe(`tok:demo-maya:${ORIGIN}/mcp`);
    expect(fetchFn).toHaveBeenCalledTimes(1); // cached
    const evil = await oauth.handle(req('GET', '/authorize', { ...q, redirect_uri: 'https://evil.example/cb' }));
    expect(evil!.status).toBe(400);
  });

  it('refuses a document whose client_id does not match its URL, and non-public URLs', async () => {
    const { oauth } = make({ ...doc, client_id: 'https://other.example/x.json' });
    const q = { response_type: 'code', client_id: CID, redirect_uri: 'https://alexa.example.com/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' };
    expect((await oauth.handle(req('GET', '/authorize', q)))!.body).toContain('does not match');
    for (const bad of ['https://127.0.0.1/c.json', 'https://localhost/c.json', 'https://example.com/']) {
      expect((await oauth.handle(req('GET', '/authorize', { ...q, client_id: bad })))!.status).toBe(400);
    }
  });
  it('refuses hosts that resolve to private addresses, and bodies over 5 KB without buffering them', async () => {
    const q = { response_type: 'code', client_id: CID, redirect_uri: 'https://alexa.example.com/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' };
    const base = { secret: 's', state: new MemoryStateStore(), storeIds: ['satechi'], signAccess: (u: string, a: string) => `tok:${u}:${a}`, shopperFor: () => null };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 }));
    const rebind = createOAuth({ ...base, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: async () => ['93.184.216.34', '10.0.0.5'] });
    expect((await rebind.handle(req('GET', '/authorize', q)))!.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(4096)); } });
    const big = createOAuth({ ...base, lookupFn: async () => ['93.184.216.34'], fetchFn: (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch });
    expect((await big.handle(req('GET', '/authorize', q)))!.body).toContain('too large');
    expect(pulled).toBeLessThan(5);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(privateAddress(ip)).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(privateAddress(ip)).toBe(false);
  });
});
