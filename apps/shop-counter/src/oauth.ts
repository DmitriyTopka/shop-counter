/**
 * Account linking: a minimal OAuth 2.1 authorization server built into the shop server, after the
 * MCP Authorization spec 2025-11-25.
 *
 * - Protected Resource Metadata (RFC 9728): /.well-known/oauth-protected-resource[/mcp | /stores/<id>/mcp]
 * - Authorization Server Metadata (RFC 8414): /.well-known/oauth-authorization-server
 * - Client registration: Client ID Metadata Documents (an https URL as client_id, the spec's SHOULD)
 *   and Dynamic Client Registration (RFC 7591, POST /register). DCR is stateless: the client_id is
 *   the signed registration itself, so nothing is stored.
 * - /authorize: a consent page ("Link Shop Counter to Alexa": Maya / Sam / new guest), PKCE S256 only,
 *   exact redirect_uri match, resource indicator (RFC 8707).
 * - /token: authorization_code (+ code_verifier) and refresh_token (rotated).
 *
 * Codes and tokens are HMAC-signed structures, so the server keeps no session table. One-time use
 * of codes and refresh tokens is recorded in the state store (DynamoDB conditional put on Lambda),
 * under "oauth-used:<shopper>". The access token is the shop's signed session with an audience.
 * Framework-free: http.ts and lambda.ts both call `handle()`.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { StateStore } from 'shelf-to-alexa';

export const SCOPE = 'shopper';
export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX = 'shop-counter.oauth.v1.'; // domain separation from sessions and order tokens

export interface OAuthRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  body: string;
  /** Public origin of this server, e.g. https://xyz.lambda-url.us-east-1.on.aws (see `publicOrigin`). */
  origin: string;
}

export interface OAuthResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OAuthDeps {
  secret: string;
  state: StateStore;
  /** Store ids: "/mcp" is the first store, every store is also "/stores/<id>/mcp". */
  storeIds: string[];
  /** Store names for the consent page ("Satechi, Roborock"); defaults to the ids. */
  storeNames?: string[];
  /** Signs an access token (the shop session) for a shopper and an audience. */
  signAccess: (userId: string, audience: string, ttlMs: number) => string;
  /** Makes the shopper id for a consent choice ("maya" -> "demo-maya", "guest" -> fresh id). */
  shopperFor: (choice: string) => string | null;
  /** Fetch for Client ID Metadata Documents (injectable for tests). */
  fetchFn?: typeof fetch;
  /** DNS lookup for the CIMD host (injectable for tests). Default: the system resolver; skipped when only fetchFn is injected. */
  lookupFn?: (host: string) => Promise<string[]>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Origin the clients see: PUBLIC_BASE_URL, else the Lambda domain (https), else the Host header (http). */
export function publicOrigin(opts: { env?: string; lambdaDomain?: string; host?: string; proto?: string }): string {
  if (opts.env) return new URL(opts.env).origin;
  if (opts.lambdaDomain) return `https://${opts.lambdaDomain.toLowerCase()}`;
  return `${opts.proto === 'https' ? 'https' : 'http'}://${(opts.host ?? 'localhost').toLowerCase()}`;
}

/** Path part of the PRM URL for an MCP endpoint path ("/mcp" -> "/.well-known/oauth-protected-resource/mcp"). */
export const prmUrl = (origin: string, mcpPath: string) => `${origin}/.well-known/oauth-protected-resource${mcpPath}`;

/** WWW-Authenticate for a 401 at an MCP endpoint (RFC 6750 + RFC 9728 resource_metadata). */
export function challenge(origin: string, mcpPath: string, error?: { code: string; description: string }): string {
  const attrs: string[] = [];
  if (error) attrs.push(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`);
  attrs.push(`resource_metadata="${prmUrl(origin, mcpPath)}"`, `scope="${SCOPE}"`);
  return `Bearer ${attrs.join(', ')}`;
}

/** Canonical resource URI (RFC 8707 / MCP): lowercase scheme+host, no fragment, no query, no trailing slash. */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.hash || u.search || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

/** Is `audience` valid at this MCP endpoint? The whole server (origin) or exactly this endpoint. */
export function audienceAllows(audience: string, origin: string, mcpPath: string): boolean {
  return audience === origin || audience === `${origin}${mcpPath}`;
}

/* ---------------- signed blobs ---------------- */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(kind: string, body: string, secret: string) {
  return createHmac('sha256', secret).update(`${PREFIX}${kind}.${body}`).digest('base64url');
}
function seal(kind: string, payload: Record<string, unknown>, secret: string): string {
  const body = b64(payload);
  return `${body}.${sign(kind, body, secret)}`;
}
function unseal<T>(kind: string, token: string | undefined | null, secret: string): T | null {
  if (!token || token.length > 4096) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(kind, body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
}

interface CodePayload { j: string; c: string; r: string; ch: string; a: string; u: string; s: string; e: number }
interface RefreshPayload { j: string; c: string; a: string; u: string; s: string; e: number }
interface DcrPayload { n: string; r: string[] }
interface Client { client_id: string; name: string; redirect_uris: string[]; kind: 'cimd' | 'dcr' }

/* ---------------- helpers ---------------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const json = (status: number, body: unknown, extra: Record<string, string> = {}): OAuthResponse => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body),
});
const oauthError = (status: number, error: string, description: string) => json(status, { error, error_description: description });
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", // no form-action: Chrome applies it to the redirect back to the client
  // not no-referrer: that makes the consent form POST with "Origin: null", which the local server refuses
  'referrer-policy': 'same-origin',
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_CIMD = 5000;

/** DNS lookup for https.request that refuses private addresses and hands the socket the address it checked. */
function vettedLookup(hostname: string, opts: any, cb: (...a: any[]) => void): void {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) {
      return cb(Object.assign(new Error('client_id host resolves to a private address'), { code: 'EPRIVATE' }));
    }
    if (opts?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/** Minimal GET over https with vettedLookup, returned as a web Response (only what fetchCimd uses). */
async function pinnedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'GET', lookup: vettedLookup as any, signal: init?.signal ?? undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.destroy(); return reject(new Error('redirects are not followed')); }
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
      resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream, { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and IPv6 ULA / mapped-private addresses. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9')
      || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
  }
  return true;
}
/** MCP spec: redirect URIs are https or localhost. No fragments. */
function redirectUriOk(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 512) return false;
  try {
    const u = new URL(raw);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch { return false; }
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function parseForm(req: OAuthRequest): URLSearchParams {
  const ct = (req.header('content-type') ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const o = JSON.parse(req.body || '{}') as Record<string, unknown>;
      return new URLSearchParams(Object.entries(o).filter(([, v]) => typeof v === 'string') as [string, string][]);
    } catch { return new URLSearchParams(); }
  }
  return new URLSearchParams(req.body);
}

/* ---------------- the server ---------------- */

export interface OAuthServer {
  /** Answers OAuth paths; null for anything else. */
  handle(req: OAuthRequest): Promise<OAuthResponse | null>;
  /** Is this a valid resource of ours? Returns the canonical form. */
  ourResource(raw: string, origin: string): string | null;
}

export function createOAuth(deps: OAuthDeps): OAuthServer {
  const { secret, state } = deps;
  // Production fetch is pinned (pinnedFetch): the address vetted as public is the one the socket connects to.
  const fetchFn = deps.fetchFn ?? pinnedFetch;
  const lookupFn = deps.lookupFn ?? null;
  const log = deps.log ?? (() => {});
  const mcpPaths = ['/mcp', ...deps.storeIds.map((id) => `/stores/${id}/mcp`)];
  const cimdCache = new Map<string, { client: Client; until: number }>();

  function ourResource(raw: string, origin: string): string | null {
    const c = canonicalResource(raw);
    if (!c) return null;
    if (c === origin) return c; // the whole server: every store (one link, like one Alexa account)
    return mcpPaths.some((p) => c === `${origin}${p}`) ? c : null;
  }

  function prm(origin: string, mcpPath: string | null) {
    const resource = mcpPath ? `${origin}${mcpPath}` : origin;
    const store = mcpPath === '/mcp' ? deps.storeIds[0] : mcpPath?.split('/')[2];
    return {
      resource,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: store ? `Shop Counter (${store})` : 'Shop Counter (all stores)',
    };
  }

  function asMetadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /* -------- clients -------- */

  async function resolveClient(clientId: string | null): Promise<Client | { error: string }> {
    if (!clientId) return { error: 'client_id is missing' };
    const dcr = clientId.startsWith('dcr.') ? unseal<DcrPayload>('client', clientId.slice(4), secret) : null;
    if (clientId.startsWith('dcr.')) {
      return dcr && Array.isArray(dcr.r) ? { client_id: clientId, name: dcr.n, redirect_uris: dcr.r, kind: 'dcr' } : { error: 'unknown client_id' };
    }
    if (clientId.startsWith('https://')) return fetchCimd(clientId);
    return { error: 'unknown client_id (use an https Client ID Metadata Document URL or POST /register)' };
  }

  /** Client ID Metadata Document: https only, no IP-literal or local hosts, 3 s, 5 KB, no redirects, cached 5 min. */
  async function fetchCimd(url: string): Promise<Client | { error: string }> {
    const hit = cimdCache.get(url);
    if (hit && hit.until > Date.now()) return hit.client;
    let u: URL;
    try { u = new URL(url); } catch { return { error: 'client_id is not a URL' }; }
    const host = u.hostname;
    if (u.protocol !== 'https:' || u.pathname === '/' || u.hash || LOOPBACK.has(host) || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.local') || host.endsWith('.internal')) {
      return { error: 'client_id must be a public https URL with a path' };
    }
    try {
      // SSRF guard. In production pinnedFetch resolves, rejects private addresses and connects to the vetted address
      // in one step (no DNS rebinding window). lookupFn is the same check for tests with an injected fetch.
      if (lookupFn) {
        const addrs = await lookupFn(host);
        if (!addrs.length || addrs.some(privateAddress)) return { error: 'client_id must be a public https URL with a path' };
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      let text = '';
      try {
        const res = await fetchFn(url, { redirect: 'error', signal: ctl.signal, headers: { accept: 'application/json', 'accept-encoding': 'identity' } });
        if (!res.ok) return { error: 'client metadata document could not be fetched' };
        if (Number(res.headers?.get?.('content-length') ?? 0) > MAX_CIMD) return { error: 'client metadata document too large' };
        // Read at most MAX_CIMD bytes, then stop the download: a huge body never gets buffered.
        const reader = res.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_CIMD) { ctl.abort(); return { error: 'client metadata document too large' }; }
            chunks.push(value);
          }
          text = Buffer.concat(chunks).toString('utf8');
        } else {
          text = await res.text();
          if (text.length > MAX_CIMD) return { error: 'client metadata document too large' };
        }
      } finally { clearTimeout(timer); }
      const doc = JSON.parse(text) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
      if (doc.client_id !== url) return { error: 'client metadata document: client_id does not match its URL' };
      if (typeof doc.client_name !== 'string' || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || !doc.redirect_uris.every(redirectUriOk)) {
        return { error: 'client metadata document: needs client_name and https/localhost redirect_uris' };
      }
      const client: Client = { client_id: url, name: doc.client_name.slice(0, 80), redirect_uris: doc.redirect_uris as string[], kind: 'cimd' };
      cimdCache.set(url, { client, until: Date.now() + 5 * 60_000 });
      return client;
    } catch (e) {
      log('oauth_cimd_failed', { client_id: url, error: (e as Error).message });
      return { error: 'client metadata document could not be fetched' };
    }
  }

  function register(req: OAuthRequest): OAuthResponse {
    let meta: { redirect_uris?: unknown; client_name?: unknown };
    try { meta = JSON.parse(req.body || '{}'); } catch { return oauthError(400, 'invalid_client_metadata', 'body must be JSON'); }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(redirectUriOk)) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris: 1 to 5 https or localhost URIs, no fragments');
    }
    const name = typeof meta.client_name === 'string' && meta.client_name.trim() ? meta.client_name.trim().slice(0, 80) : 'MCP client';
    const clientId = `dcr.${seal('client', { n: name, r: uris }, secret)}`;
    log('oauth_register', { name, redirect_hosts: uris.map((x: string) => new URL(x).host) });
    // Public client: any requested auth method is replaced by "none" (RFC 7591 lets the server decide).
    return json(201, {
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE,
    });
  }

  /* -------- authorize -------- */

  type AuthParams = { client: Client; redirect_uri: string; state: string | null; challenge: string; resource: string; scope: string };

  /** Validates an authorization request. `fatal` errors are shown on the page (never redirected). */
  async function checkAuthorize(p: URLSearchParams, origin: string): Promise<{ ok: AuthParams } | { fatal: string } | { redirect: string }> {
    const client = await resolveClient(p.get('client_id'));
    if ('error' in client) return { fatal: client.error };
    const redirectUri = p.get('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return { fatal: 'redirect_uri is not registered for this client' };
    const st = p.get('state');
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (st) u.searchParams.set('state', st);
      u.searchParams.set('iss', origin);
      return { redirect: u.href };
    };
    if (p.get('response_type') !== 'code') return back('unsupported_response_type', 'only response_type=code');
    const challengeValue = p.get('code_challenge');
    if (!challengeValue || !/^[A-Za-z0-9_-]{43}$/.test(challengeValue)) return back('invalid_request', 'PKCE code_challenge (S256) is required');
    if (p.get('code_challenge_method') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    const rawResource = p.get('resource') ?? origin; // RFC 8707: absent -> this whole server
    const resource = ourResource(rawResource, origin);
    if (!resource) return back('invalid_target', 'resource is not served here');
    const scopes = (p.get('scope') ?? SCOPE).split(/\s+/).filter(Boolean);
    if (scopes.some((s) => s !== SCOPE)) return back('invalid_scope', `only scope "${SCOPE}"`);
    return { ok: { client, redirect_uri: redirectUri, state: st, challenge: challengeValue, resource, scope: SCOPE } };
  }

  function consentPage(p: URLSearchParams, a: AuthParams, origin: string): OAuthResponse {
    const redirectHost = new URL(a.redirect_uri).host;
    const local = LOOPBACK.has(new URL(a.redirect_uri).hostname);
    const keep = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope']
      .filter((k) => p.get(k) !== null)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(p.get(k)!)}">`).join('');
    const storeLine = a.resource === origin ? `every Shop Counter store (${esc((deps.storeNames ?? deps.storeIds).join(', '))})` : `only ${esc(a.resource.replace(origin, '') || '/')}`;
    const who = [
      ['maya', 'Maya', 'demo shopper, iPhone 15'],
      ['sam', 'Sam', 'demo shopper, Roborock Saros 10R'],
      ['guest', 'New guest', 'a fresh private shopper, nothing remembered yet'],
    ].map(([v, n, d], i) => `<label class="opt"><input type="radio" name="shopper" value="${v}"${i === 0 ? ' checked' : ''}><span><b>${n}</b><small>${d}</small></span></label>`).join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Shop Counter to Alexa</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1622;color:#e8f1f8;font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(440px,calc(100vw - 32px));background:#132433;border-radius:20px;padding:28px 24px;box-shadow:0 10px 40px #0008}
.ring{width:44px;height:44px;border-radius:50%;border:5px solid #1ecbe1;box-shadow:0 0 18px #1ecbe1aa;margin-bottom:14px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 14px;color:#b8c9d6}.who{color:#e8f1f8;font-weight:600}
.opt{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid #2a4256;border-radius:12px;margin:8px 0;cursor:pointer}
.opt:has(input:checked){border-color:#1ecbe1;background:#173447}.opt small{display:block;color:#9fb3c2}
.note{font-size:13px;color:#9fb3c2;border-left:3px solid #f2b84b;padding-left:10px;margin:14px 0}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;font:inherit;font-weight:600;border:0;border-radius:999px;padding:12px}
.allow{background:#1ecbe1;color:#04202a}.deny{background:#2a4256;color:#e8f1f8}</style></head><body><main>
<div class="ring" aria-hidden="true"></div><h1>Link Shop Counter to Alexa</h1>
<p><span class="who">${esc(a.client.name)}</span> wants to use your Shop Counter account: your saved devices and your orders, at ${storeLine}.</p>
<form method="post" action="/authorize">${keep}<p>Sign in as</p>${who}
<p class="note">After you allow, you go back to <b>${esc(redirectHost)}</b>${local ? ' (an app on this computer)' : ''}. Demo only: no password, no real payments.</p>
<div class="row"><button class="deny" name="decision" value="deny">Cancel</button><button class="allow" name="decision" value="allow">Allow</button></div>
</form></main></body></html>`;
    return { status: 200, headers: PAGE_HEADERS, body: html };
  }

  const errorPage = (msg: string): OAuthResponse => ({
    status: 400, headers: PAGE_HEADERS,
    body: `<!doctype html><meta charset="utf-8"><title>Cannot link</title><body style="font:16px system-ui;background:#0b1622;color:#e8f1f8;padding:32px"><h1>Cannot link this app</h1><p>${esc(msg)}</p></body>`,
  });

  async function authorize(req: OAuthRequest): Promise<OAuthResponse> {
    const p = req.method === 'POST' ? parseForm(req) : req.query;
    const check = await checkAuthorize(p, req.origin);
    if ('fatal' in check) return errorPage(check.fatal);
    if ('redirect' in check) return { status: 302, headers: { location: check.redirect, 'cache-control': 'no-store' }, body: '' };
    const a = check.ok;
    if (req.method !== 'POST') return consentPage(p, a, req.origin);

    const u = new URL(a.redirect_uri);
    if (a.state) u.searchParams.set('state', a.state);
    u.searchParams.set('iss', req.origin);
    if (p.get('decision') !== 'allow') {
      u.searchParams.set('error', 'access_denied');
      return { status: 302, headers: { location: u.href, 'cache-control': 'no-store' }, body: '' };
    }
    const user = deps.shopperFor(p.get('shopper') ?? '');
    if (!user) return errorPage('pick a shopper');
    const code = seal('code', {
      j: randomBytes(12).toString('base64url'), c: a.client.client_id, r: a.redirect_uri, ch: a.challenge, a: a.resource, u: user, s: a.scope,
      e: Date.now() + CODE_TTL_MS,
    } satisfies CodePayload, secret);
    u.searchParams.set('code', code);
    log('oauth_consent', { client: a.client.name, kind: a.client.kind, user, resource: a.resource });
    return { status: 302, headers: { location: u.href, 'cache-control': 'no-store' }, body: '' };
  }

  /* -------- token -------- */

  /** One-time use, shared by all instances: the state store is the arbiter (DynamoDB conditional put). */
  async function spend(user: string, jti: string, expires: number): Promise<boolean> {
    let fresh = false;
    await state.update(`oauth-used:${user}`, (s) => {
      const now = Date.now();
      const used = Object.fromEntries(Object.entries(s.used_tokens).filter(([, v]) => v.expires > now));
      fresh = !used[jti];
      if (fresh) used[jti] = { order_id: 'oauth', expires };
      return { ...s, used_tokens: used };
    });
    return fresh;
  }

  async function issue(user: string, client: string, audience: string, scope: string) {
    const refresh = seal('refresh', { j: randomBytes(12).toString('base64url'), c: client, a: audience, u: user, s: scope, e: Date.now() + REFRESH_TTL_MS } satisfies RefreshPayload, secret);
    return json(200, {
      access_token: deps.signAccess(user, audience, ACCESS_TTL_MS), token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh, scope, resource: audience, user_id: user,
    });
  }

  async function token(req: OAuthRequest): Promise<OAuthResponse> {
    if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'POST only');
    const p = parseForm(req);
    const grant = p.get('grant_type');
    const clientId = p.get('client_id');
    if (req.header('authorization')) return oauthError(401, 'invalid_client', 'public clients only (token_endpoint_auth_method none)');
    const reqResource = p.get('resource');

    if (grant === 'authorization_code') {
      const c = unseal<CodePayload>('code', p.get('code'), secret);
      if (!c) return oauthError(400, 'invalid_grant', 'unknown authorization code');
      if (c.e <= Date.now()) return oauthError(400, 'invalid_grant', 'authorization code expired');
      if (clientId !== c.c) return oauthError(400, 'invalid_grant', 'code was issued to another client');
      if (p.get('redirect_uri') !== c.r) return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      const verifier = p.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkceChallenge(verifier) !== c.ch) return oauthError(400, 'invalid_grant', 'PKCE code_verifier does not match');
      if (reqResource !== null && canonicalResource(reqResource) !== c.a) return oauthError(400, 'invalid_target', 'resource differs from the authorization request');
      if (!(await spend(c.u, `code:${c.j}`, c.e))) {
        log('oauth_code_replay', { user: c.u });
        return oauthError(400, 'invalid_grant', 'authorization code already used');
      }
      log('oauth_token', { grant, user: c.u, resource: c.a });
      return issue(c.u, c.c, c.a, c.s);
    }

    if (grant === 'refresh_token') {
      const r = unseal<RefreshPayload>('refresh', p.get('refresh_token'), secret);
      if (!r || r.e <= Date.now()) return oauthError(400, 'invalid_grant', 'refresh token is invalid or expired');
      if (clientId !== r.c) return oauthError(400, 'invalid_grant', 'refresh token was issued to another client');
      let audience = r.a;
      if (reqResource !== null) {
        const want = canonicalResource(reqResource);
        // a narrower audience is fine (whole server -> one store), a different one is not
        if (!want || !(want === r.a || (r.a === req.origin && ourResource(want, req.origin)))) return oauthError(400, 'invalid_target', 'resource is outside the original grant');
        audience = want;
      }
      if (!(await spend(r.u, `refresh:${r.j}`, r.e))) return oauthError(400, 'invalid_grant', 'refresh token already used');
      return issue(r.u, r.c, audience, r.s);
    }
    return oauthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
  }

  /* -------- routing -------- */

  async function handle(req: OAuthRequest): Promise<OAuthResponse | null> {
    const { path, origin } = req;
    const PRM = '/.well-known/oauth-protected-resource';
    if (path === PRM) return json(200, prm(origin, null), { 'cache-control': 'max-age=300' });
    if (path.startsWith(`${PRM}/`)) {
      const mcpPath = path.slice(PRM.length);
      return mcpPaths.includes(mcpPath) ? json(200, prm(origin, mcpPath), { 'cache-control': 'max-age=300' }) : json(404, { error: 'not found' });
    }
    if (path === '/.well-known/oauth-authorization-server') return json(200, asMetadata(origin), { 'cache-control': 'max-age=300' });
    if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) return authorize(req);
    if (path === '/token') return token(req);
    if (path === '/register' && req.method === 'POST') return register(req);
    return null;
  }

  return { handle, ourResource };
}
