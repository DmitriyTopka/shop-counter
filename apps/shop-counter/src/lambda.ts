/**
 * AWS Lambda entry for a Function URL (payload format 2.0, InvokeMode BUFFERED).
 * Same stateless handlers as the local server. Shopper memory lives in DynamoDB when
 * STATE_STORE=dynamodb (deploy/deploy_lambda.sh sets it); otherwise /tmp, best-effort only.
 * CORS is handled by the Function URL config, not here.
 */
import { createApp, createStateStore, routeStore, SERVER_NAME, SERVER_VERSION, type App } from './app.js';

interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; domainName?: string };
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
  app ??= createStateStore().then((state) => createApp(undefined, state));
  const { runtimes, identify, demoLogin } = await app;
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
  const rt = routeStore(event.rawPath, runtimes);
  if (!rt) return jsonResult(404, { error: 'not found' });
  const lower = Object.fromEntries(Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const who = identify((n) => lower[n]);
  if (!who.ok) {
    return jsonResult(401, { error: `session ${who.reason}`, login: '/auth/demo-login' }, { 'www-authenticate': `Bearer error="invalid_token", error_description="session ${who.reason}"` });
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
