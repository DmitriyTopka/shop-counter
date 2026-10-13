/**
 * Shop Counter wiring: stores -> catalog + state + secret -> one stateless MCP handler per store.
 * Shared by the local HTTP server (http.ts) and the AWS Lambda entry (lambda.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import {
  ANONYMOUS, createShelfServer, emptyState, FALLBACK_VIEW_HTML, FileStateStore, sanitizeUserId, ShelfService, shopifyCatalog,
  type Notifier, type ShopperState, type StateStore, type StoreConfig,
} from 'shelf-to-alexa';
import { STORES } from './stores.js';

export const SERVER_NAME = 'shop-counter';
export const SERVER_VERSION = '0.1.0';

/** apps/shop-counter, whether we run from src/ (tsx) or dist/ (bundle). */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const onLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

const env = (k: string) => process.env[k]?.trim() || undefined;
export const STATE_DIR = env('SHOP_COUNTER_STATE_DIR') ?? (onLambda ? '/tmp/state' : join(APP_ROOT, 'data', 'state'));
export const CACHE_DIR = env('SHOP_COUNTER_CACHE_DIR') ?? (onLambda ? '/tmp/cache' : join(APP_ROOT, 'cache'));

export function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
}

/** Which state store backs shopper memory: "dynamodb" (TABLE_NAME) on AWS, files otherwise. */
export async function createStateStore(): Promise<StateStore> {
  if ((env('STATE_STORE') ?? '').toLowerCase() === 'dynamodb') {
    const table = env('TABLE_NAME');
    if (!table) throw new Error('STATE_STORE=dynamodb needs TABLE_NAME');
    const { DynamoDbStateStore } = await import('./dynamo.js'); // loaded only when used: local dev never needs the AWS SDK
    return DynamoDbStateStore.create(table);
  }
  return new FileStateStore(STATE_DIR);
}

/** HMAC secret: env in production; in dev a random one, kept in data/state so tokens survive restarts. */
function loadSecret(): string {
  const fromEnv = env('SHOP_COUNTER_SECRET');
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production' || onLambda) throw new Error('SHOP_COUNTER_SECRET is required in production');
  const file = join(STATE_DIR, '.dev-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(STATE_DIR, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  log('dev_secret_generated', { file });
  return secret;
}

/**
 * The MCP App view. Uses the real build from packages/view when present (next to the bundle on
 * Lambda, or in the monorepo locally), else a minimal placeholder. Re-read when the file changes.
 */
const VIEW_CANDIDATES = [
  env('SHOP_COUNTER_VIEW_HTML'),
  join(APP_ROOT, 'dist', 'view.html'),
  resolve(APP_ROOT, '..', '..', 'packages', 'view', 'dist', 'view.html'),
].filter((p): p is string => Boolean(p));

/**
 * The env override wins; otherwise the NEWEST build. (A stale copy in dist/ from the last server build
 * used to shadow a fresh packages/view build: the simulator showed yesterday's view.)
 */
function pickView(): { path: string; mtime: number } | null {
  const found = VIEW_CANDIDATES.flatMap((path) => { try { return [{ path, mtime: statSync(path).mtimeMs }]; } catch { return []; } });
  if (!found.length) return null;
  const override = env('SHOP_COUNTER_VIEW_HTML');
  return found.find((f) => f.path === override) ?? found.reduce((a, b) => (b.mtime > a.mtime ? b : a));
}

let viewCache: { path: string; mtime: number; html: string } | null = null;
export function viewHtml(): string {
  const pick = pickView();
  if (!pick) return FALLBACK_VIEW_HTML;
  if (viewCache?.path !== pick.path || viewCache.mtime !== pick.mtime) viewCache = { ...pick, html: readFileSync(pick.path, 'utf8') };
  return viewCache.html;
}
export const viewSource = () => pickView()?.path ?? '(built-in placeholder)';

/** Staff handoff. Telegram comes later; for now a structured log line (contact masked). */
const notify: Notifier = ({ store, user, ticket }) => {
  const contact = ticket.contact ? `***${ticket.contact.slice(-4)}` : null;
  log('handoff', { store, user, ticket: ticket.ticket_id, reason: ticket.reason, contact });
};

export interface StoreRuntime {
  store: StoreConfig;
  service: ShelfService;
  handler: McpHttpHandler;
}

export interface App {
  runtimes: Map<string, StoreRuntime>;
  /** Who is calling: from a signed session token only (see `identify`). */
  identify: (header: (name: string) => string | null | undefined) => Identity;
  /** Demo sign-in: a signed session for a demo profile (or a fresh guest). */
  demoLogin: (profile: unknown) => { token: string; user_id: string; profile: string; expires_at: string } | null;
}

export function createApp(stores: StoreConfig[] = STORES, state: StateStore = new FileStateStore(STATE_DIR)): App {
  const secret = loadSecret();
  const runtimes = new Map<string, StoreRuntime>();
  const identify = (header: (name: string) => string | null | undefined) => identifyCaller(header, secret);
  for (const store of stores) {
    const service = new ShelfService({
      catalog: shopifyCatalog(store, { cacheDir: CACHE_DIR }),
      state: storeScopedState(state, store.id),
      secret,
      notify,
      log,
    });
    const handler = createMcpHandler(
      (ctx) => {
        // Bad tokens never reach here (the HTTP layer answers 401), so a failure is just "anonymous".
        const who = identify((n) => ctx.requestInfo?.headers.get(n));
        return createShelfServer(
          { service, name: SERVER_NAME, version: SERVER_VERSION, view: { html: viewHtml }, log },
          { userId: who.ok ? who.userId : undefined },
        );
      },
      { legacy: 'stateless', onerror: (e) => log('mcp_error', { store: store.id, error: e.message }) },
    );
    runtimes.set(store.id, { store, service, handler });
  }
  return { runtimes, identify, demoLogin: (profile) => demoLogin(profile, secret) };
}

/**
 * The device closet belongs to the SHOPPER and is shared by every store ("shopper:<user>"):
 * an iPhone saved while talking to Satechi is known to Roborock too. Orders, tickets and used
 * confirmation tokens stay per store ("<store>:<user>"). Locks are always taken store first, then
 * shopper, so two stores updating one shopper cannot deadlock.
 */
export function storeScopedState(inner: StateStore, storeId: string): StateStore {
  const own = (u: string) => `${storeId}:${u}`;
  const shared = (u: string) => `shopper:${u}`;
  const merge = (mine: ShopperState, sh: ShopperState): ShopperState => ({ ...mine, closet: sh.closet });
  return {
    get: async (userId) => merge(await inner.get(own(userId)), await inner.get(shared(userId))),
    update: (userId, fn) => {
      let out: ShopperState | undefined;
      return inner
        .update(own(userId), async (mine) => {
          await inner.update(shared(userId), async (sh) => {
            out = await fn(merge(mine, sh));
            return { ...emptyState(), closet: out.closet };
          });
          return { ...out!, closet: emptyState().closet };
        })
        .then(() => out!);
    },
  };
}

/* ---------------- signed shopper session ---------------- */

/**
 * Demo sign-in. Alexa+ would hand us the shopper through account linking (OAuth); here a demo
 * profile gets an HMAC-signed session token, and the server takes the shopper id ONLY from it.
 * Maya and Sam are the demo shoppers; "guest" gets a fresh private id (one per judge / browser).
 */
export const DEMO_PROFILES = ['maya', 'sam', 'guest'] as const;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_PREFIX = 'shop-counter.session.v1.'; // domain separation: an order token is never a session

export type Identity = { ok: true; userId: string; via: 'session' | 'dev-header' | 'none' } | { ok: false; reason: 'invalid' | 'expired' };

function sessionSig(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(SESSION_PREFIX + body).digest();
}

export function signSession(userId: string, secret: string, now = Date.now(), ttl = SESSION_TTL_MS): string {
  const body = Buffer.from(JSON.stringify({ u: userId, e: now + ttl })).toString('base64url');
  return `${body}.${sessionSig(body, secret).toString('base64url')}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): Identity {
  const [body, sig, extra] = token.trim().split('.');
  if (!body || !sig || extra !== undefined || token.length > 2048) return { ok: false, reason: 'invalid' };
  const want = sessionSig(body, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'invalid' };
  let p: { u?: unknown; e?: unknown };
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'invalid' }; }
  if (typeof p.u !== 'string' || typeof p.e !== 'number' || sanitizeUserId(p.u) === ANONYMOUS) return { ok: false, reason: 'invalid' };
  if (p.e <= now) return { ok: false, reason: 'expired' };
  return { ok: true, userId: p.u, via: 'session' };
}

/** Bearer session -> that shopper; no credentials -> anonymous; `x-user-id` only with the explicit dev flag. */
export function identifyCaller(header: (name: string) => string | null | undefined, secret: string): Identity {
  const auth = header('authorization');
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return m ? verifySession(m[1], secret) : { ok: false, reason: 'invalid' };
  }
  const devUser = header('x-user-id');
  if (devUser && env('SHOP_COUNTER_DEV_USER_HEADER') === '1' && !onLambda) return { ok: true, userId: devUser, via: 'dev-header' };
  return { ok: true, userId: ANONYMOUS, via: 'none' };
}

function demoLogin(profile: unknown, secret: string) {
  if (typeof profile !== 'string' || !(DEMO_PROFILES as readonly string[]).includes(profile)) return null;
  const userId = profile === 'guest' ? `guest-${randomBytes(6).toString('hex')}` : `demo-${profile}`;
  const now = Date.now();
  return { token: signSession(userId, secret, now), user_id: userId, profile, expires_at: new Date(now + SESSION_TTL_MS).toISOString() };
}

/** "/mcp" -> default store, "/stores/<id>/mcp" -> that store. */
export function routeStore(pathname: string, runtimes: Map<string, StoreRuntime>): StoreRuntime | null {
  if (pathname === '/mcp') return runtimes.values().next().value ?? null;
  const m = /^\/stores\/([a-z0-9-]+)\/mcp$/.exec(pathname);
  return m ? runtimes.get(m[1]) ?? null : null;
}
