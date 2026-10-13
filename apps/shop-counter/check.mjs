// Live end-to-end check against the REAL Satechi storefront.
// Starts dist/http.mjs, talks to it as a real MCP client over Streamable HTTP, then cross-checks
// every price / stock flag / evidence quote in the answers against an independently fetched raw feed.
// Run: npm run check   (builds first; runs under tsx so it can import the shelf-to-alexa source)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { DEFAULT_USER_AGENT, findDevices, htmlToText, signOrderToken } from 'shelf-to-alexa';

// A free port, so the check never talks to some other process (or a dev server on 8787).
const PORT = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const STORE_URL = 'https://satechi.net';
const SECRET = randomBytes(24).toString('hex');
const STATE_DIR = mkdtempSync(join(tmpdir(), 'shop-counter-check-'));
// The shopper id comes from a signed demo session (POST /auth/demo-login), set once the server is up.
let USER = '';
let TOKEN = '';

let failed = 0;
let passed = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); cond ? passed++ : failed++; };
const spoken = []; // every content[0].text we got, for the speech checks
const seenProducts = []; // every Product object in any structuredContent, for the honesty check
const seenEvidence = [];

function collect(sc) {
  if (!sc || typeof sc !== 'object') return;
  const add = (p) => p && typeof p === 'object' && 'price' in p && seenProducts.push(p);
  (sc.products ?? []).forEach(add);
  add(sc.product);
  (sc.alternatives ?? []).forEach(add);
  (sc.items ?? []).forEach((l) => add(l.product));
  (sc.order?.items ?? []).forEach((l) => add(l.product));
  (sc.orders ?? []).forEach((o) => o.items.forEach((l) => add(l.product)));
  if (sc.evidence) seenEvidence.push({ product: sc.product, evidence: sc.evidence });
  (sc.also ?? []).forEach((a) => a.evidence && seenEvidence.push({ product: sc.product, evidence: a.evidence }));
}

async function connect(userId) {
  const headers = userId ? { authorization: `Bearer ${TOKEN}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: 'shop-counter-check', version: '0.1.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    spoken.push({ tool: name, text });
    collect(r.structuredContent);
    return { text, sc: r.structuredContent, isError: r.isError === true };
  };
  return { client, transport, call };
}

const show = (label, r) => console.log(`\n> ${label}\n  says: "${r.text}"${r.isError ? '  [isError]' : ''}`);
const brief = (p) => `${p.title}${p.variant ? ` (${p.variant})` : ''} | $${p.price}${p.compare_at_price ? ` was $${p.compare_at_price}` : ''} | ${p.available ? 'in stock' : 'OUT'} | id ${p.id}`;

async function fetchRawFeed() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${STORE_URL}/products.json?limit=250&page=${page}`, { headers: { 'user-agent': DEFAULT_USER_AGENT } });
    if (!res.ok) throw new Error(`raw feed HTTP ${res.status}`);
    const { products } = await res.json();
    all.push(...products);
    if (products.length < 250) break;
  }
  return all;
}

const srv = spawn(process.execPath, ['dist/http.mjs'], {
  env: { ...process.env, PORT: String(PORT), SHOP_COUNTER_SECRET: SECRET, SHOP_COUNTER_STATE_DIR: STATE_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
srv.stdout.on('data', (d) => serverLog.push(...d.toString().trim().split('\n')));
srv.stderr.on('data', (d) => serverLog.push(...d.toString().trim().split('\n').map((l) => `ERR ${l}`)));

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await (await fetch(`${BASE}/health`)).json()).server === 'shop-counter') break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log(`health: ${JSON.stringify(health)}`);

  console.log('\n=== 0. Raw Satechi feed (independent fetch, for the honesty check) ===');
  const raw = await fetchRawFeed();
  const rawVariant = new Map();
  for (const p of raw) for (const v of p.variants) rawVariant.set(String(v.id), { p, v });
  const skus = new Set(raw.flatMap((p) => p.variants.map((v) => v.sku).filter((s) => s && s.length >= 5)));
  console.log(`raw feed: ${raw.length} products, ${rawVariant.size} variants`);

  console.log('\n=== 1. initialize / tools/list / resources/read ===');
  const login = await (await fetch(`${BASE}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"profile":"guest"}' })).json();
  USER = login.user_id;
  TOKEN = login.token;
  assert(/^guest-/.test(USER) && TOKEN.includes('.'), `demo login issues a signed session (${USER})`);
  const A = await connect(USER);
  const pv = A.client.getNegotiatedProtocolVersion();
  console.log(`negotiated protocolVersion = ${pv}`);
  console.log(`server = ${JSON.stringify(A.client.getServerVersion())}, session id = ${A.transport.sessionId ?? '(none, stateless)'}`);
  assert(pv === '2025-11-25', 'protocolVersion is 2025-11-25');

  const { tools } = await A.client.listTools();
  for (const t of tools) console.log(`  - ${t.name.padEnd(20)} ui=${getToolUiResourceUri(t) ?? '-'}`);
  const contract = ['find_products', 'compare_products', 'check_compatibility', 'remember_my_devices', 'my_devices', 'prepare_order', 'place_order', 'order_status', 'talk_to_staff'];
  assert(contract.every((n) => tools.some((t) => t.name === n)) && tools.length === contract.length, `tools/list has exactly the ${contract.length} contract tools`);
  const uiTools = ['find_products', 'compare_products', 'check_compatibility', 'prepare_order', 'place_order', 'order_status'];
  assert(uiTools.every((n) => getToolUiResourceUri(tools.find((t) => t.name === n)) === 'ui://shop-counter/view.html'), '[UI] tools carry _meta.ui.resourceUri = ui://shop-counter/view.html');
  const res = await A.client.readResource({ uri: 'ui://shop-counter/view.html' });
  console.log(`resources/read -> mimeType=${res.contents[0].mimeType} size=${(res.contents[0].text.length / 1024).toFixed(1)} KB (from ${health.view})`);
  assert(res.contents[0].mimeType === 'text/html;profile=mcp-app', 'view resource is text/html;profile=mcp-app');

  console.log('\n=== 2. find_products on the live catalog ===');
  const found = await A.call('find_products', { need: 'charger for my iPhone 15 and MacBook Air', max_price: 120 });
  show('find_products("charger for my iPhone 15 and MacBook Air", max_price=120)', found);
  for (const p of found.sc.products) console.log(`  * ${brief(p)}\n    why: ${p.why.join(' / ')}\n    highlights: ${p.highlights.join(' / ')}`);
  console.log(`  more_available: ${found.sc.more_available}, for_devices: ${found.sc.for_devices.join(', ')}`);
  assert(found.sc.kind === 'products' && found.sc.products.length >= 2, 'find_products returns at least 2 products');
  assert(found.sc.products.every((p) => p.available && p.price <= 120), 'all results in stock and within $120');

  console.log('\n=== 3. compare_products ===');
  const [p1, p2] = found.sc.products;
  const cmp = await A.call('compare_products', { ids: [p1.id, p2.id] });
  show(`compare_products([${p1.id}, ${p2.id}])`, cmp);
  for (const r of cmp.sc.rows) console.log(`  ${r.label.padEnd(24)} ${r.values.map((v) => v ?? '-').join('  |  ')}`);
  assert(cmp.sc.kind === 'compare' && cmp.sc.rows.length >= 3, 'compare returns rows and a verdict');

  console.log('\n=== 4. check_compatibility ===');
  const compat = await A.call('check_compatibility', { product_id: p1.id, device: 'iPhone 15' });
  show(`check_compatibility(${p1.id}, "iPhone 15")`, compat);
  console.log(`  status=${compat.sc.status} evidence=${JSON.stringify(compat.sc.evidence)}`);
  assert(compat.sc.status === 'confirmed' && compat.sc.evidence?.quote, 'first pick is confirmed for iPhone 15 with a quote');
  const lightning = raw.find((p) => /\bto Lightning\b/i.test(p.title));
  if (lightning) {
    const lid = String(lightning.variants[0].id);
    const inc = await A.call('check_compatibility', { product_id: lid, device: 'iPhone 15 Pro' });
    show(`check_compatibility("${lightning.title}", "iPhone 15 Pro")`, inc);
    assert(inc.sc.status === 'incompatible', 'Lightning cable is incompatible with a USB-C iPhone');
  }

  console.log('\n=== 5. remember_my_devices -> my_devices in a NEW session ===');
  const rem = await A.call('remember_my_devices', { devices: ['iPhone 15', 'MacBook Air M2'], home: { pets: ['cat'] } });
  show('remember_my_devices', rem);
  await A.client.close();
  const B = await connect(USER);
  const mine = await B.call('my_devices');
  show('my_devices (new HTTP connection, same signed session)', mine);
  assert(JSON.stringify(mine.sc.devices) === JSON.stringify(['iPhone 15', 'MacBook Air M2']), 'closet survives into a new session');
  const fromCloset = await B.call('find_products', { need: 'wall charger', max_price: 120 });
  show('find_products("wall charger") with no devices named: uses the closet', fromCloset);
  assert(fromCloset.sc.for_devices.length === 2, 'find_products falls back to the remembered devices');

  console.log('\n=== 6. prepare_order -> place_order -> order_status in a NEW session ===');
  const prev = await B.call('prepare_order', { items: [{ id: p1.id, qty: 1 }] });
  show(`prepare_order(${p1.id} x1)`, prev);
  console.log(`  total=${prev.sc.total} shipping=${prev.sc.shipping} expires_at=${prev.sc.expires_at}`);
  const placed = await B.call('place_order', { confirmation_token: prev.sc.confirmation_token });
  show('place_order', placed);
  assert(placed.sc.kind === 'order' && placed.sc.order.status === 'confirmed', 'order placed');
  const replay = await B.call('place_order', { confirmation_token: prev.sc.confirmation_token });
  show('place_order again with the same token', replay);
  assert(replay.sc.already_placed === true && replay.sc.order.id === placed.sc.order.id, 'replayed token does not create a second order');
  await B.client.close();
  const C = await connect(USER);
  const status = await C.call('order_status');
  show('order_status (new HTTP connection)', status);
  assert(status.sc.orders[0]?.id === placed.sc.order.id && status.sc.orders.length === 1, 'order visible in a new session, exactly once');

  console.log('\n=== 7. Negative paths ===');
  const tamper = (t) => t.slice(0, -3) + (t.endsWith('AAA') ? 'BBB' : 'AAA');
  const bad = await C.call('place_order', { confirmation_token: tamper(prev.sc.confirmation_token) });
  show('place_order(broken token)', bad);
  assert(bad.isError && bad.sc.code === 'token_invalid', 'broken token -> token_invalid');
  const expiredTok = signOrderToken({ v: 1, u: USER, s: 'satechi', i: [[p1.id, 1]], t: Math.round(p1.price * 100), e: Date.now() - 60_000, n: 'expired' }, SECRET);
  const exp = await C.call('place_order', { confirmation_token: expiredTok });
  show('place_order(expired token, correctly signed)', exp);
  assert(exp.isError && exp.sc.code === 'token_expired', 'expired token -> token_expired');
  const otherTok = signOrderToken({ v: 1, u: 'someone-else', s: 'satechi', i: [[p1.id, 1]], t: Math.round(p1.price * 100), e: Date.now() + 60_000, n: 'other' }, SECRET);
  const other = await C.call('place_order', { confirmation_token: otherTok });
  show("place_order(another shopper's token)", other);
  assert(other.isError && other.sc.code === 'token_wrong_user', "another shopper's token -> token_wrong_user");
  const oos = [...rawVariant.values()].find(({ v }) => v.available === false);
  const oosR = await C.call('prepare_order', { items: [{ id: String(oos.v.id), qty: 1 }] });
  show(`prepare_order(out of stock: ${oos.p.title} / ${oos.v.title})`, oosR);
  assert(oosR.isError && oosR.sc.code === 'out_of_stock', 'out-of-stock item -> out_of_stock');
  const unk = await C.call('prepare_order', { items: [{ id: '1', qty: 1 }] });
  show('prepare_order(unknown id "1")', unk);
  assert(unk.isError && unk.sc.code === 'not_found', 'unknown id -> not_found');
  const unkC = await C.call('check_compatibility', { product_id: 'nope', device: 'iPhone 15' });
  assert(unkC.isError && unkC.sc.code === 'not_found', 'unknown id in check_compatibility -> not_found');
  const after = await C.call('order_status');
  assert(after.sc.orders.length === 1, 'negative paths placed nothing');
  const staff = await C.call('talk_to_staff', { reason: 'Question about warranty on my order' });
  show('talk_to_staff', staff);
  assert(staff.sc.kind === 'handoff' && /^T-/.test(staff.sc.ticket_id), 'talk_to_staff returns a ticket');
  await C.client.close();
  const anon = await connect(undefined);
  const anonR = await anon.call('order_status');
  show('order_status without a session', anonR);
  assert(anonR.isError && anonR.sc.code === 'anonymous', 'no session -> anonymous, no orders');
  await anon.client.close();

  console.log('\n=== 8. Honesty: every price / stock flag / quote vs the raw feed ===');
  let mismatches = 0;
  const unique = new Map(seenProducts.map((p) => [`${p.id}`, p]));
  for (const p of seenProducts) {
    const r = rawVariant.get(String(p.id));
    const problems = [];
    if (!r) problems.push('id not in raw feed');
    else {
      const rawPrice = Number(r.v.price);
      const rawCap = r.v.compare_at_price ? Number(r.v.compare_at_price) : null;
      if (p.price !== rawPrice) problems.push(`price ${p.price} vs raw ${rawPrice}`);
      if (p.available !== r.v.available) problems.push(`available ${p.available} vs raw ${r.v.available}`);
      const expectCap = rawCap !== null && rawCap > rawPrice ? rawCap : null;
      if (p.compare_at_price !== expectCap) problems.push(`compare_at ${p.compare_at_price} vs raw ${rawCap}`);
      if (p.title !== r.p.title) problems.push('title differs');
      for (const d of p.compatible_with) {
        const hay = [r.p.title, ...r.p.tags, htmlToText(r.p.body_html), ...r.p.options.flatMap((o) => o.values)];
        const literal = hay.some((h) => h.toLowerCase().includes(d.toLowerCase()));
        const parsed = hay.some((h) => findDevices(h).some((m) => m.device.name === d));
        if (!literal && !parsed) problems.push(`compatible_with "${d}" not found in raw data`);
      }
    }
    if (problems.length) { mismatches++; console.log(`  MISMATCH ${p.id} ${p.title}: ${problems.join('; ')}`); }
  }
  let badQuotes = 0;
  for (const { product, evidence } of seenEvidence) {
    const r = rawVariant.get(String(product.id));
    const src = { tags: r.p.tags, title: [r.p.title], description: [htmlToText(r.p.body_html)], options: r.p.options.flatMap((o) => o.values) }[evidence.source] ?? [];
    const ok = evidence.source === 'tags' ? src.includes(evidence.quote) : src.some((s) => s.includes(evidence.quote));
    if (!ok) { badQuotes++; console.log(`  BAD QUOTE ${product.id}: ${JSON.stringify(evidence)}`); }
  }
  console.log(`checked ${seenProducts.length} product objects (${unique.size} unique variants), ${seenEvidence.length} evidence quotes`);
  console.log(`price/stock/compare_at/title/compatible_with mismatches: ${mismatches}; quotes not literally in store data: ${badQuotes}`);
  assert(mismatches === 0, '0 mismatches between answers and the raw feed');
  assert(badQuotes === 0, 'every evidence quote is a literal substring of store data');

  console.log('\n=== 9. Speech: short, no URLs, no SKUs ===');
  const speechProblems = spoken.filter(({ text }) => {
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    return !text || sentences.length > 2 || /https?:|www\.|\.com\b|\.net\b/i.test(text) || [...skus].some((s) => text.includes(s));
  });
  for (const s of speechProblems) console.log(`  BAD SPEECH [${s.tool}] ${s.text}`);
  console.log(`checked ${spoken.length} spoken answers`);
  assert(speechProblems.length === 0, 'every spoken answer is 1-2 sentences with no URL or SKU');

  console.log('\n=== 10. Lambda entry (dist/lambda.mjs) with a fake Function URL event ===');
  process.env.SHOP_COUNTER_SECRET = SECRET;
  process.env.SHOP_COUNTER_STATE_DIR = STATE_DIR;
  const { handler } = await import('./dist/lambda.mjs');
  const ev = (body, extra = {}) => ({
    rawPath: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: 'abc.lambda-url.us-east-1.on.aws', ...extra },
    body: JSON.stringify(body), isBase64Encoded: false,
    requestContext: { http: { method: 'POST' }, domainName: 'abc.lambda-url.us-east-1.on.aws' },
  });
  const l1 = await handler(ev({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lambda-check', version: '0' } } }));
  const l2 = await handler(ev({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'order_status', arguments: {} } }, { authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-11-25' }));
  console.log(`lambda initialize -> ${l1.statusCode} ${l1.body.match(/"protocolVersion":"[^"]+"/)?.[0]}`);
  console.log(`lambda order_status -> ${l2.statusCode} ${l2.body.match(/"text":"[^"]+"/)?.[0]}`);
  assert(l1.statusCode === 200 && l1.body.includes('"protocolVersion":"2025-11-25"'), 'lambda answers initialize with 2025-11-25');
  assert(l2.statusCode === 200 && l2.body.includes(placed.sc.order.id), 'lambda sees the same order for the same signed session');
} catch (e) {
  failed++;
  console.log(`FAIL  unexpected error: ${e.stack ?? e}`);
} finally {
  srv.kill();
  rmSync(STATE_DIR, { recursive: true, force: true });
  const rpc = serverLog.filter((l) => l.includes('"msg":"rpc"')).length;
  const errs = serverLog.filter((l) => l.startsWith('ERR') || l.includes('tool_error') || l.includes('mcp_error'));
  console.log(`\nserver log: ${rpc} JSON-RPC requests, ${errs.length} error lines`);
  for (const l of errs.slice(0, 10)) console.log(`  ${l}`);
}

console.log(`\n${failed ? 'CHECK FAILED' : 'ALL CHECKS PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
