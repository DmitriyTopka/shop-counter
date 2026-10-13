/**
 * AWS Lambda entry for a Function URL (payload format 2.0, InvokeMode BUFFERED).
 * Same stateless handlers as the local server. Shopper memory lives in DynamoDB when
 * STATE_STORE=dynamodb (deploy/deploy_lambda.sh sets it); otherwise /tmp, best-effort only.
 * CORS is handled by the Function URL config, not here.
 */
import { createApp, createStateStore, routeStore, SERVER_NAME, SERVER_VERSION, type App } from './app.js';
import { hostedRoute } from './hosted.js';
import { challenge, publicOrigin } from './oauth.js';

interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string }; domainName?: string };
}

interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

let app: Promise<App> | null = null;

const jsonResult = (statusCode: number, body: unknown, headers: Record<string, string> = {}): FunctionUrlResult =>
  ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), isBase64Encoded: false });

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  // The hosted simulator (/sim/) and its Bedrock brain (/brain/...) share this origin with /mcp (hosted.ts).
  const hosted = await hostedRoute(event);
  if (hosted) return hosted;
  app ??= createStateStore().then((state) => createApp(undefined, state));
  const { runtimes, identify, demoLogin, oauth } = await app;
  const method = event.requestContext.http.method;
  if (event.rawPath === '/health') {
    return jsonResult(200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, stores: [...runtimes.keys()] });
  }
  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  if (event.rawPath === '/auth/demo-login' && method === 'POST') {
    let profile: unknown;
    try { profile = (JSON.parse(rawBody || '{}') as { profile?: unknown }).profile; } catch { return jsonResult(400, { error: 'bad body' }); }
    const session = demoLogin(profile);
    return session ? jsonResult(200, session) : jsonResult(400, { error: 'unknown profile', profiles: ['maya', 'sam', 'guest'] });
  }
  const lower = Object.fromEntries(Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const origin = publicOrigin({ env: process.env.PUBLIC_BASE_URL?.trim() || undefined, lambdaDomain: event.requestContext.domainName, host: lower.host });
  // Account linking (OAuth 2.1, see oauth.ts): metadata, /authorize, /token, /register.
  const linked = await oauth.handle({ method, path: event.rawPath, query: new URLSearchParams(event.rawQueryString ?? ''), header: (n) => lower[n], body: rawBody, origin });
  if (linked) return { statusCode: linked.status, headers: linked.headers, body: linked.body, isBase64Encoded: false };

  const rt = routeStore(event.rawPath, runtimes);
  if (!rt) return jsonResult(404, { error: 'not found' });
  const who = identify((n) => lower[n], { origin, path: event.rawPath });
  if (!who.ok) {
    const description = who.reason === 'audience' ? 'token was issued for another resource' : `session ${who.reason}`;
    return jsonResult(401, { error: description, login: '/auth/demo-login', resource_metadata: `${origin}/.well-known/oauth-protected-resource${event.rawPath}` },
      { 'www-authenticate': challenge(origin, event.rawPath, { code: 'invalid_token', description }) });
  }
  if (who.via === 'none' && process.env.SHOP_COUNTER_REQUIRE_AUTH === '1') {
    return jsonResult(401, { error: 'sign in: link your Shop Counter account', resource_metadata: `${origin}/.well-known/oauth-protected-resource${event.rawPath}` },
      { 'www-authenticate': challenge(origin, event.rawPath) });
  }

  const host = event.requestContext.domainName ?? event.headers.host ?? 'localhost';
  const url = `https://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
  const body = rawBody || undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v);

  const res = await rt.handler.fetch(new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body }));
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { outHeaders[k] = v; });
  return { statusCode: res.status, headers: outHeaders, body: await res.text(), isBase64Encoded: false };
}
