/**
 * Local server: POST /mcp (Streamable HTTP, stateless) and GET /health.
 * Bound to 127.0.0.1 by default, with Host and Origin checks against DNS rebinding.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createApp, createStateStore, log, routeStore, SERVER_NAME, SERVER_VERSION, viewSource } from './app.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const extraOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const app = createApp(undefined, await createStateStore());
const { runtimes } = app;
const nodeHandlers = new Map([...runtimes].map(([id, rt]) => [id, toNodeHandler(rt.handler)]));

function originAllowed(origin: string): boolean {
  if (extraOrigins.includes(origin)) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function hostAllowed(req: IncomingMessage): boolean {
  if (!LOOPBACK.has(HOST)) return true; // behind a proxy / public bind: the proxy owns Host checks
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return LOOPBACK.has(host);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;

  if (!hostAllowed(req)) return json(res, 403, { error: 'host not allowed' });
  if (origin) {
    if (!originAllowed(origin)) return json(res, 403, { error: 'origin not allowed' });
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id, x-user-id');
    res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  if (url.pathname === '/health') {
    const stores = [...runtimes.values()].map(({ store }) => ({ id: store.id, name: store.name, url: store.url, mcp: `/stores/${store.id}/mcp` }));
    return json(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, stores, view: viewSource() });
  }

  // Demo sign-in: a signed session for a demo profile. Alexa+ would use account linking instead.
  if (url.pathname === '/auth/demo-login' && req.method === 'POST') {
    let body: { profile?: unknown } | undefined;
    try { body = (await readBody(req)) as typeof body; } catch { return json(res, 400, { error: 'bad body' }); }
    const session = app.demoLogin(body?.profile);
    if (!session) return json(res, 400, { error: 'unknown profile', profiles: ['maya', 'sam', 'guest'] });
    log('demo_login', { profile: session.profile, user: session.user_id });
    return json(res, 200, session);
  }

  const rt = routeStore(url.pathname, runtimes);
  if (!rt) return json(res, 404, { error: 'not found' });

  // A forged, foreign-secret or expired session is refused outright (never silently "anonymous").
  const who = app.identify((n) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; });
  if (!who.ok) {
    res.setHeader('www-authenticate', `Bearer error="invalid_token", error_description="session ${who.reason}"`);
    return json(res, 401, { error: `session ${who.reason}`, login: '/auth/demo-login' });
  }

  let parsed: unknown;
  if (req.method === 'POST') {
    try {
      parsed = await readBody(req);
    } catch (err) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${(err as Error).message}` } });
    }
    const user = who.userId;
    for (const m of (Array.isArray(parsed) ? parsed : [parsed]) as { method?: string; id?: unknown; params?: { name?: string } }[]) {
      if (!m?.method) continue;
      const tool = m.method === 'tools/call' ? ` ${m.params?.name}` : '';
      log('rpc', { store: rt.store.id, method: m.method + tool, id: m.id ?? null, user });
    }
  }
  await nodeHandlers.get(rt.store.id)!(req, res, parsed);
});

server.listen(PORT, HOST, () => {
  log('listening', { url: `http://${HOST}:${PORT}/mcp`, stores: [...runtimes.keys()], view: viewSource() });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
