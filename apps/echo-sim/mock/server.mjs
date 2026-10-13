// STAND-IN MCP server for developing the simulator while apps/shop-counter is being built.
// It follows docs/CONTRACT.md (v1) on top of the view fixtures (real Satechi / Roborock items,
// snapshot 12.10.2026). It is NOT the product server: the real one is apps/shop-counter on :8787.
//   node mock/server.mjs            -> http://127.0.0.1:8797/mcp   (MOCK_PORT to change)
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const viewDir = resolve(here, '../../../packages/view');
const PORT = Number(process.env.MOCK_PORT ?? 8797);
const UI = 'ui://shop-counter/view.html';
const VIEW_HTML = () => readFileSync(resolve(viewDir, 'dist/view.html'), 'utf8'); // re-read: picks up view rebuilds

const fx = Object.fromEntries(
  readdirSync(resolve(viewDir, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(resolve(viewDir, 'fixtures', f), 'utf8'))]),
);
const CHARGERS = fx.products.products.concat(fx.compat_not_listed.product);
const VACUUMS = fx.products_vacuum.products;
const CATALOG = new Map([...CHARGERS, ...VACUUMS].map((p) => [p.id, p]));

// per-shopper memory (in-process; the real server persists it)
const SEED = {
  maya: { devices: ['iPhone 15', 'MacBook Air M2'], home: {} },
  sam: { devices: ['Echo Show 8'], home: { pets: ['cat'], notes: 'Small apartment, about 600 sq ft' } },
};
const users = new Map();
const user = (id) => {
  if (!users.has(id)) users.set(id, { ...structuredClone(SEED[id] ?? { devices: [], home: {} }), orders: [] });
  return users.get(id);
};
const als = new AsyncLocalStorage();
const uid = () => als.getStore() ?? 'anonymous';
const SECRET = 'mock-only-secret';
const money = (v) => `$${v.toFixed(2)}`;
const short = (t) => t.replace(/\s*\(.*?\)\s*/g, ' ').replace(/ with .*$/i, '').trim();
const ok = (text, sc) => ({ content: [{ type: 'text', text }], structuredContent: sc });
const fail = (code, message) => ({ isError: true, content: [{ type: 'text', text: message }], structuredContent: { kind: 'error', code, message } });

function createServer() {
  const s = new McpServer({ name: 'shop-counter-mock', version: '0.1.0' });
  const meta = { ui: { resourceUri: UI } };

  registerAppTool(s, 'find_products', {
    title: 'Find products',
    description: 'Pick up to 3 products for what the shopper needs, within budget, explaining why each fits. Uses the shopper\'s remembered devices.',
    inputSchema: z.object({ need: z.string(), max_price: z.number().positive().optional(), category: z.string().optional(), must_have: z.array(z.string()).optional(), for_devices: z.array(z.string()).optional() }),
    annotations: { readOnlyHint: true }, _meta: meta,
  }, async ({ need, max_price }) => {
    const pool = /vacuum|robot|mop|cat|pet|fur|hair/i.test(need) ? VACUUMS : CHARGERS.slice(0, 3);
    const items = pool.filter((p) => !max_price || p.price <= max_price).slice(0, 3);
    const store = pool === VACUUMS ? 'Roborock' : 'Satechi';
    if (!items.length) return ok(`I found nothing under ${money(max_price)} at ${store}.`, { kind: 'products', store, need, products: [], more_available: 0 });
    const text = `Here are ${items.length} picks. The ${short(items[0].title)} at ${money(items[0].price)} fits best. Want to compare them?`;
    return ok(text, { kind: 'products', store, need, products: items, more_available: pool === VACUUMS ? 2 : 9 });
  });

  registerAppTool(s, 'compare_products', {
    title: 'Compare products', description: 'Compare 2 or 3 products side by side and give a verdict.',
    inputSchema: z.object({ ids: z.array(z.string()).min(2).max(3) }), annotations: { readOnlyHint: true }, _meta: meta,
  }, async ({ ids }) => {
    const ps = ids.map((i) => CATALOG.get(i)).filter(Boolean);
    if (ps.length < 2) return fail('unknown_product', 'I could not find those products. Ask me to search again.');
    if (ps.every((p) => VACUUMS.includes(p))) {
      const rows = fx.compare.rows.map((r) => ({ label: r.label, values: ps.map((p) => r.values[VACUUMS.indexOf(p)]) }));
      return ok('Here they are side by side. With a cat, I would take the Q10 S5+, it empties itself.', { kind: 'compare', products: ps, rows, verdict: fx.compare.verdict });
    }
    const rows = [
      { label: 'Price', values: ps.map((p) => money(p.price)) },
      { label: 'Charges', values: ps.map((p) => p.highlights?.[1] ?? null) },
      { label: 'iPhone power', values: ps.map((p) => p.highlights?.[0] ?? null) },
    ];
    return ok('Here they are side by side.', { kind: 'compare', products: ps, rows, verdict: `The ${short(ps[0].title)} does the most; the ${short(ps[1].title)} is the cheaper one.` });
  });

  registerAppTool(s, 'check_compatibility', {
    title: 'Check compatibility', description: 'Check whether a product works with a device. Confirmed only with a literal quote from the store data; never guesses.',
    inputSchema: z.object({ product_id: z.string(), device: z.string().optional() }), annotations: { readOnlyHint: true }, _meta: meta,
  }, async ({ product_id, device }) => {
    const p = CATALOG.get(product_id);
    if (!p) return fail('unknown_product', 'I could not find that product.');
    const dev = device || user(uid()).devices[0] || 'your device';
    const hit = (p.compatible_with ?? []).find((d) => d.toLowerCase() === dev.toLowerCase());
    if (hit) return ok(`Yes. The store lists ${hit} as compatible with the ${short(p.title)}.`, { kind: 'compat', product: p, device: dev, status: 'confirmed', evidence: { source: 'tags', quote: hit }, alternatives: [] });
    const alts = CHARGERS.filter((x) => x.id !== p.id && (x.compatible_with ?? []).some((d) => d.toLowerCase() === dev.toLowerCase())).slice(0, 2);
    return ok(`The store does not list ${dev} for this one, so I won't guess.${alts.length ? ' Here are options it does confirm.' : ''}`, { kind: 'compat', product: p, device: dev, status: 'not_listed', evidence: null, alternatives: alts });
  });

  const closetOut = () => { const u = user(uid()); return { kind: 'closet', devices: u.devices, home: u.home }; };
  s.registerTool('remember_my_devices', {
    title: 'Remember my devices', description: 'Save devices the shopper owns and home facts (pets, space) for future sessions.',
    inputSchema: z.object({ devices: z.array(z.string()).optional(), home: z.object({ pets: z.array(z.string()).optional(), notes: z.string().optional() }).optional(), forget: z.array(z.string()).optional() }),
  }, async ({ devices = [], home, forget = [] }) => {
    const u = user(uid());
    u.devices = [...new Set([...u.devices, ...devices])].filter((d) => !forget.some((f) => f.toLowerCase() === d.toLowerCase()));
    if (home) u.home = { ...u.home, ...home, pets: [...new Set([...(u.home.pets ?? []), ...(home.pets ?? [])])] };
    return ok(`Got it. I'll remember ${[...devices, ...(home?.pets ?? []).map((p) => `your ${p}`)].join(' and ') || 'that'}.`, closetOut());
  });
  s.registerTool('my_devices', { title: 'My devices', description: 'List the devices and home facts remembered for this shopper.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => { const c = closetOut(); return ok(c.devices.length ? `You have ${c.devices.join(', ')}.` : 'I do not know your devices yet.', c); });

  registerAppTool(s, 'prepare_order', {
    title: 'Prepare order', description: 'Step 1 of 2: price the cart and return a confirmation token valid for 10 minutes. Nothing is ordered yet.',
    inputSchema: z.object({ items: z.array(z.object({ id: z.string(), qty: z.number().int().positive().max(5) })).min(1) }), _meta: meta,
  }, async ({ items }) => {
    const lines = [];
    for (const it of items) {
      const p = CATALOG.get(it.id);
      if (!p) return fail('unknown_product', 'I could not find that product.');
      if (!p.available) return fail('unavailable', `The ${short(p.title)} is out of stock right now.`);
      lines.push({ product: p, qty: it.qty, line_total: Math.round(p.price * it.qty * 100) / 100 });
    }
    const subtotal = lines.reduce((a, l) => a + l.line_total, 0);
    const shipping = null; // like the real stores: policy unknown, total before shipping and tax (contract v1.1)
    const total = Math.round(subtotal * 100) / 100;
    const exp = Date.now() + 10 * 60_000;
    const body = Buffer.from(JSON.stringify({ u: uid(), items, total, exp })).toString('base64url');
    const token = `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 22)}`;
    return ok(`That's ${money(total)} before shipping and tax. Say confirm to place the order.`, { kind: 'order_preview', items: lines, subtotal, shipping, total, currency: 'USD', confirmation_token: token, expires_at: new Date(exp).toISOString() });
  });

  registerAppTool(s, 'place_order', {
    title: 'Place order', description: 'Step 2 of 2: place the order with the confirmation token from prepare_order. Payment is simulated.',
    inputSchema: z.object({ confirmation_token: z.string() }), _meta: meta,
  }, async ({ confirmation_token }) => {
    const [body, sig] = confirmation_token.split('.');
    if (!body || sig !== createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 22)) return fail('bad_token', 'That confirmation is not valid. Nothing was ordered.');
    const t = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (t.u !== uid()) return fail('bad_token', 'That confirmation belongs to someone else. Nothing was ordered.');
    if (Date.now() > t.exp) return fail('token_expired', "That confirmation expired. Say 'order it again' and I'll make a fresh one.");
    const u = user(uid());
    const items = t.items.map((it) => { const p = CATALOG.get(it.id); return { product: p, qty: it.qty, line_total: Math.round(p.price * it.qty * 100) / 100 }; });
    const eta = new Date(Date.now() + 4 * 86400_000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const order = { id: `SC-${randomUUID().slice(0, 5).toUpperCase()}`, status: 'confirmed', created_at: new Date().toISOString(), eta, items, total: t.total, currency: 'USD', payment: 'simulated (Amazon Wallet style)' };
    u.orders.unshift(order);
    return ok(`Done. Your order is placed and should arrive ${eta}.`, { kind: 'order', order });
  });

  registerAppTool(s, 'order_status', {
    title: 'Order status', description: "Where is my order: the shopper's orders, latest first. Works across sessions.",
    inputSchema: z.object({ order_id: z.string().optional() }), annotations: { readOnlyHint: true }, _meta: meta,
  }, async ({ order_id }) => {
    const all = user(uid()).orders;
    const orders = order_id ? all.filter((o) => o.id === order_id) : all;
    if (!orders.length) return ok('I do not see any orders for you yet.', { kind: 'orders', orders: [] });
    return ok(`Your latest order is ${orders[0].status} and should arrive ${orders[0].eta}.`, { kind: 'orders', orders });
  });

  s.registerTool('talk_to_staff', { title: 'Talk to staff', description: 'Hand the conversation to a human at the store.', inputSchema: z.object({ reason: z.string(), contact: z.string().optional() }) },
    async () => ok('I have asked a person from the store to reach out. They usually reply within 15 minutes.', { kind: 'handoff', ticket_id: `H-${randomUUID().slice(0, 4).toUpperCase()}`, message: 'A store teammate will reach out within 15 minutes.' }));

  registerAppResource(s, 'Shop Counter view', UI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: VIEW_HTML(), _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ['https://cdn.shopify.com'] } } } }],
  }));
  return s;
}

const handler = toNodeHandler(createMcpHandler(() => createServer(), { legacy: 'stateless', responseMode: 'json', onerror: (e) => console.error('[mock] error', e.message) }));
createHttp(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') return void res.writeHead(200).end('ok');
  if (!url.pathname.endsWith('/mcp')) return void res.writeHead(404).end('not found'); // /mcp and /stores/<id>/mcp
  const id = String(req.headers['x-user-id'] ?? 'anonymous').slice(0, 64);
  als.run(id, () => handler(req, res));
}).listen(PORT, '127.0.0.1', () => console.log(`[mock] Shop Counter MOCK MCP on http://127.0.0.1:${PORT}/mcp (stand-in for apps/shop-counter)`));
