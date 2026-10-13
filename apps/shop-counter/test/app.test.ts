// Offline: the network is cut below. Closet tools try the catalog for an accessory tip; with no
// catalog they answer without one (suggestion null), which this suite also proves.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryStateStore } from 'shelf-to-alexa';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'shop-counter-test-'));
process.env.SHOP_COUNTER_SECRET = 'test-secret';
process.env.SHOP_COUNTER_STATE_DIR = dir;
process.env.SHOP_COUNTER_CACHE_DIR = join(dir, 'cache');
delete process.env.SHOP_COUNTER_DEV_USER_HEADER;
globalThis.fetch = async () => { throw new Error('offline test: no network'); };
const { handler } = await import('../src/lambda.js');
const { routeStore, createApp, signSession, storeScopedState, verifySession } = await import('../src/app.js');
const { DynamoDbStateStore } = await import('../src/dynamo.js');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rpc = (method: string, params: unknown, headers: Record<string, string> = {}, path = '/mcp') =>
  handler({
    rawPath: path,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    requestContext: { http: { method: 'POST' }, domainName: 'test.local' },
  });
const tool = (name: string, args: unknown, headers: Record<string, string> = {}, path = '/mcp') => rpc('tools/call', { name, arguments: args }, headers, path);

/** Stateless legacy responses come back as one SSE event; pull the JSON out. */
const payload = (body: string) => JSON.parse(body.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
const sc = (r: { body: string }) => payload(r.body).result.structuredContent;

async function login(profile: string) {
  const r = await handler({ rawPath: '/auth/demo-login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }), requestContext: { http: { method: 'POST' } } });
  expect(r.statusCode).toBe(200);
  const s = JSON.parse(r.body);
  return { ...s, auth: { authorization: `Bearer ${s.token}` } };
}

describe('shop-counter app', () => {
  it('routes /mcp to the first store and /stores/<id>/mcp to each store', () => {
    const { runtimes } = createApp();
    expect(routeStore('/mcp', runtimes)?.store.id).toBe('satechi');
    expect(routeStore('/stores/roborock/mcp', runtimes)?.store.id).toBe('roborock');
    expect(routeStore('/stores/nope/mcp', runtimes)).toBeNull();
    expect(routeStore('/mcp/extra', runtimes)).toBeNull();
  });

  it('answers initialize with 2025-11-25 and no session id', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(r.statusCode).toBe(200);
    expect(payload(r.body).result.protocolVersion).toBe('2025-11-25');
    expect(r.headers['mcp-session-id']).toBeUndefined();
  });

  it('shares the device closet across stores, keeps orders per store', async () => {
    const tess = await login('guest');
    expect(tess.user_id).toMatch(/^guest-[0-9a-f]{12}$/);
    expect(sc(await tool('remember_my_devices', { devices: ['iPhone 16 Pro'] }, tess.auth)).devices).toEqual(['iPhone 16 Pro']);
    // a new request = a new session; the closet comes from the store, not the transport
    expect(sc(await tool('my_devices', {}, tess.auth)).devices).toEqual(['iPhone 16 Pro']);
    // saved while talking to Satechi, known to Roborock: the closet belongs to the shopper
    const robo = sc(await tool('my_devices', {}, tess.auth, '/stores/roborock/mcp'));
    expect(robo).toMatchObject({ kind: 'closet', devices: ['iPhone 16 Pro'], store: 'Roborock', suggestion: null });
    expect(sc(await tool('remember_my_devices', { devices: ['Roborock Q7 M5'] }, tess.auth, '/stores/roborock/mcp')).devices).toEqual(['iPhone 16 Pro', 'Roborock Q7 M5']);
    expect(sc(await tool('my_devices', {}, tess.auth)).devices).toEqual(['iPhone 16 Pro', 'Roborock Q7 M5']);
    // someone else sees nothing
    const other = await login('guest');
    expect(sc(await tool('my_devices', {}, other.auth, '/stores/roborock/mcp')).devices).toEqual([]);
  });

  it('takes the shopper only from a signed session', async () => {
    const maya = await login('maya');
    expect(maya.user_id).toBe('demo-maya');
    await tool('remember_my_devices', { devices: ['iPhone 15'] }, maya.auth);
    // a bare x-user-id is ignored (anonymous), even with Maya's id
    expect(sc(await tool('my_devices', {}, { 'x-user-id': 'demo-maya' }))).toMatchObject({ kind: 'error', code: 'anonymous' });
    // forged payload with a valid-looking signature from another token
    const [, sig] = maya.token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ u: 'demo-sam', e: Date.now() + 60_000 })).toString('base64url');
    for (const bad of [`${forgedBody}.${sig}`, signSession('demo-maya', 'other-secret'), signSession('demo-maya', 'test-secret', Date.now() - 2 * 86_400_000), 'garbage', `${maya.token}.x`]) {
      const r = await tool('my_devices', {}, { authorization: `Bearer ${bad}` });
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toMatch(/invalid_token/);
    }
    expect((await tool('my_devices', {}, { authorization: 'Basic abc' })).statusCode).toBe(401);
    // Sam's real token sees Sam, never Maya
    const sam = await login('sam');
    expect(sc(await tool('my_devices', {}, sam.auth)).devices).not.toContain('iPhone 15');
    expect(verifySession(maya.token, 'test-secret')).toMatchObject({ ok: true, userId: 'demo-maya' });
  });

  it('refuses unknown demo profiles', async () => {
    const r = await handler({ rawPath: '/auth/demo-login', headers: {}, body: '{"profile":"admin"}', requestContext: { http: { method: 'POST' } } });
    expect(r.statusCode).toBe(400);
  });

  it('serves health and 404', async () => {
    const h = await handler({ rawPath: '/health', headers: {}, requestContext: { http: { method: 'GET' } } });
    expect(JSON.parse(h.body)).toMatchObject({ ok: true, server: 'shop-counter' });
    const n = await handler({ rawPath: '/nope', headers: {}, requestContext: { http: { method: 'GET' } } });
    expect(n.statusCode).toBe(404);
  });
});

describe('storeScopedState', () => {
  it('keeps one closet per shopper and orders per store, with concurrent updates', async () => {
    const inner = new MemoryStateStore();
    const a = storeScopedState(inner, 'a');
    const b = storeScopedState(inner, 'b');
    await Promise.all([
      a.update('u', (s) => ({ ...s, closet: { ...s.closet, devices: [...s.closet.devices, 'X'] } })),
      b.update('u', (s) => ({ ...s, closet: { ...s.closet, devices: [...s.closet.devices, 'Y'] } })),
      a.update('u', (s) => ({ ...s, tickets: [{ ticket_id: 'T-1', created_at: '', reason: 'r', contact: null }] })),
    ]);
    expect((await b.get('u')).closet.devices.sort()).toEqual(['X', 'Y']);
    expect((await a.get('u')).tickets).toHaveLength(1);
    expect((await b.get('u')).tickets).toHaveLength(0);
    expect((await inner.get('a:u')).closet.devices).toEqual([]); // the closet is not duplicated per store
  });
});

/** In-memory fake of the DynamoDB document client: Get + conditional Put, like the real service. */
function fakeDynamo() {
  const items = new Map<string, Record<string, any>>();
  let puts = 0;
  let raceOnce = false;
  return {
    items,
    get puts() { return puts; },
    race() { raceOnce = true; },
    async send(cmd: GetCommand | PutCommand) {
      if (cmd instanceof GetCommand) {
        const it = items.get(cmd.input.Key!.pk as string);
        return { Item: it ? structuredClone(it) : undefined };
      }
      puts++;
      const item = cmd.input.Item as Record<string, any>;
      if (raceOnce) { // someone else wrote between our read and our write
        raceOnce = false;
        const cur = items.get(item.pk);
        items.set(item.pk, { ...(cur ?? { pk: item.pk, doc: {} }), ver: (cur?.ver ?? 0) + 1 });
      }
      const cur = items.get(item.pk);
      const expected = cmd.input.ExpressionAttributeValues![':v'];
      if (cur && cur.ver !== expected) throw new ConditionalCheckFailedException({ message: 'conditional', $metadata: {} });
      items.set(item.pk, structuredClone(item));
      return {};
    },
  };
}

describe('DynamoDbStateStore', () => {
  it('reads an empty shopper, writes with a version, and retries a lost race', async () => {
    const db = fakeDynamo();
    const store = new DynamoDbStateStore(db, 'shop-counter-state');
    expect(await store.get('u1')).toMatchObject({ closet: { devices: [] }, orders: [] });
    await store.update('u1', (s) => ({ ...s, closet: { ...s.closet, devices: ['iPhone 15'] } }));
    expect(db.items.get('u1')).toMatchObject({ pk: 'u1', ver: 1, doc: { closet: { devices: ['iPhone 15'] } } });
    db.race();
    const before = db.puts;
    await store.update('u1', (s) => ({ ...s, closet: { ...s.closet, devices: [...s.closet.devices, 'MacBook Air M2'] } }));
    expect(db.puts - before).toBe(2); // first put lost the race, the retry re-read and won
    expect((await store.get('u1')).closet.devices).toEqual(['iPhone 15', 'MacBook Air M2']);
  });

  it('gives up after repeated conflicts instead of looping', async () => {
    const db = { send: async (c: GetCommand | PutCommand) => { if (c instanceof GetCommand) return { Item: { pk: 'u', ver: 3, doc: {} } }; throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} }); } };
    await expect(new DynamoDbStateStore(db, 't').update('u', (s) => s)).rejects.toThrow();
  });

  it('serves the app through STATE_STORE=dynamodb (selected by env)', async () => {
    const { createStateStore } = await import('../src/app.js');
    process.env.STATE_STORE = 'dynamodb';
    delete process.env.TABLE_NAME;
    await expect(createStateStore()).rejects.toThrow(/TABLE_NAME/);
    process.env.TABLE_NAME = 'shop-counter-state';
    expect(await createStateStore()).toBeInstanceOf(DynamoDbStateStore);
    delete process.env.STATE_STORE;
    delete process.env.TABLE_NAME;
  });
});
