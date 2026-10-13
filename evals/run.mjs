// Shopper eval: real shopper requests against the REAL Shop Counter server, through a real MCP client.
//
//   npm run eval                      # all cases, store snapshot from apps/shop-counter/cache
//   npm run eval -- --case rob-02     # cases whose id starts with "rob-02"
//   npm run eval -- --json out.json   # also write a machine-readable report
//   npm run eval -- --live            # refetch both store feeds first (polite: 1 request per page, 1 s pause)
//
// Two layers are checked for every case:
//   1. Server behaviour: the tool calls a good assistant would make (`steps`) and what the server answers
//      (structuredContent + the spoken line), against the case's `expect` block.
//   2. The offline agent: the simulator's no-LLM router (apps/echo-sim/src/router.ts) must pick the right
//      tool (or an honest line) for the utterance, given what is on screen (`router`).
// Plus an honesty audit over EVERY answer: price, stock, compare-at, title, listed devices and evidence
// quotes vs the raw Shopify feed; every dollar amount spoken must be a real number from the feed or the
// answer; "yes, it works" only with status confirmed. Any mismatch = a fabricated fact.
// Since round 3 the audit also checks MEANING for models outside the device dictionary: a confirmed quote
// must list this model (not "Qrevo Curv" for a Qrevo, not "Upgraded from X"), a robot is never "listed"
// for another robot, and "X only" is never read as a no for X.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { deviceMatch, findDevices, htmlToText, loadRawFeed, cacheFileFor, parseDevice } from 'shelf-to-alexa';
import { route } from '../apps/echo-sim/src/router.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'shop-counter');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = opt('--case');
const JSON_OUT = opt('--json');
const LIVE = args.includes('--live');
const VERBOSE = args.includes('--verbose');

const STORES = { satechi: 'https://satechi.net', roborock: 'https://us.roborock.com' };
const suite = JSON.parse(readFileSync(join(ROOT, 'evals', 'shopper_cases.json'), 'utf8'));
const cases = suite.cases.filter((c) => !ONLY || c.id.startsWith(ONLY));

/* ---------- 0. a frozen copy of each store feed, so every run sees the same catalog ---------- */
const WORK = mkdtempSync(join(tmpdir(), 'shop-counter-eval-'));
const CACHE = join(WORK, 'cache');
const STATE = join(WORK, 'state');
mkdirSync(CACHE, { recursive: true });
const raw = {};
for (const [id, url] of Object.entries(STORES)) {
  const file = cacheFileFor(url);
  const src = join(APP, 'cache', file);
  if (LIVE || !existsSync(src)) {
    const feed = await loadRawFeed(url, { cacheDir: join(APP, 'cache'), force: true });
    console.log(`fetched ${id}: ${feed.products.length} products`);
  }
  copyFileSync(src, join(CACHE, file));
  const feed = JSON.parse(readFileSync(join(CACHE, file), 'utf8'));
  const snapshotAt = feed.fetched_at;
  feed.fetched_at = new Date().toISOString(); // fresh for the server's 6 h TTL: no network during the run
  writeFileSync(join(CACHE, file), JSON.stringify(feed));
  const variants = new Map();
  const prices = new Set();
  for (const p of feed.products) {
    for (const v of p.variants) {
      variants.set(String(v.id), { p, v });
      prices.add(Number(v.price));
      if (v.compare_at_price) prices.add(Number(v.compare_at_price));
    }
  }
  const skus = new Set(feed.products.flatMap((p) => p.variants.map((v) => v.sku).filter((s) => s && s.length >= 5)));
  raw[id] = { feed, variants, prices, skus, snapshotAt };
}

/* ---------- 1. the server, as shipped (source, not a stale bundle) ---------- */
const PORT = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['--conditions=shelf-source', 'src/http.ts'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), SHOP_COUNTER_SECRET: randomBytes(24).toString('hex'), SHOP_COUNTER_STATE_DIR: STATE, SHOP_COUNTER_CACHE_DIR: CACHE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
srv.stdout.on('data', (d) => serverLog.push(...d.toString().trim().split('\n')));
srv.stderr.on('data', (d) => serverLog.push(...d.toString().trim().split('\n').map((l) => `ERR ${l}`)));
for (let i = 0; i < 150; i++) {
  try { if ((await (await fetch(`${BASE}/health`)).json()).server === 'shop-counter') break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

/** A signed demo session, the only way the server accepts a shopper (fresh "guest" id per case). */
async function login(profile = 'guest') {
  const r = await fetch(`${BASE}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }) });
  if (!r.ok) throw new Error(`demo login failed: ${r.status}`);
  return r.json();
}

/** Headers for a step's identity: the case's session, none, a bare x-user-id, a forged token, or another shopper. */
async function authHeaders(kind, session) {
  if (!kind || kind === 'session') return { authorization: `Bearer ${session.token}` };
  if (kind === 'none') return {};
  if (kind === 'x-user-id') return { 'x-user-id': session.user_id };
  if (kind === 'other') return { authorization: `Bearer ${(await login()).token}` };
  if (kind === 'forged') {
    // Same signature, payload swapped for the demo shopper Maya: must be refused, never "become" Maya.
    const sig = session.token.split('.')[1];
    return { authorization: `Bearer ${Buffer.from(JSON.stringify({ u: 'demo-maya', e: Date.now() + 3_600_000 })).toString('base64url')}.${sig}` };
  }
  throw new Error(`unknown auth kind ${kind}`);
}

async function connect(store, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/stores/${store}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: 'shop-counter-eval', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

/* ---------- helpers ---------- */
/** "$s0.products[1].id" -> value from the step results. */
function resolveRef(v, ctx) {
  // "@title:REGEX" -> variant id of the first feed product whose title matches (US variant preferred).
  // Used for products a search would never offer (out of stock), e.g. "can I order the 240W one?".
  if (typeof v === 'string' && v.startsWith('@title:')) {
    const rx = re(v.slice(7));
    const p = raw[ctx.__store].feed.products.find((x) => rx.test(x.title));
    if (!p) throw new Error(`no feed product matches ${v}`);
    return String((p.variants.find((x) => [x.option1, x.option2, x.option3].includes('US')) ?? p.variants[0]).id);
  }
  // "$cheaper:s0" -> one cent under the cheapest product of that result ("anything cheaper?").
  if (typeof v === 'string' && v.startsWith('$cheaper:')) {
    const prods = ctx[v.slice(9)]?.products ?? [];
    return money(Math.min(...prods.map((p) => p.price)) - 0.01);
  }
  if (typeof v === 'string' && v.startsWith('$')) {
    const path = v.slice(1).replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = ctx;
    for (const k of path) cur = cur?.[k];
    return cur;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRef(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRef(x, ctx)]));
  return v;
}
const re = (s) => new RegExp(s, 'i');
const money = (n) => Math.round(n * 100) / 100;

function productsIn(sc) {
  const out = [];
  if (!sc || typeof sc !== 'object') return out;
  const add = (p) => p && typeof p === 'object' && 'price' in p && out.push(p);
  (sc.products ?? []).forEach(add);
  add(sc.product);
  (sc.alternatives ?? []).forEach(add);
  (sc.items ?? []).forEach((l) => add(l.product));
  (sc.order?.items ?? []).forEach((l) => add(l.product));
  (sc.orders ?? []).forEach((o) => o.items.forEach((l) => add(l.product)));
  add(sc.suggestion?.product);
  return out;
}

/* ---------- meaning audit for models outside the device dictionary (round 3, 2026-10-13) ----------
 * The quote being literally in the feed is not enough: "Qrevo" is literally inside "for Qrevo Curv Series",
 * and "S8 MaxV Ultra" is literally inside "(Upgraded from S8 MaxV Ultra)". Written separately from
 * packages/shelf on purpose, so the audit does not share the server's blind spots. */
const GENERIC_AFTER = /^(only|and|or|with|for|in|series|models?|robot|robots|vacuum|cleaner|mop|dock|lds|extended|warranty|replacement|main|side|brush(es)?|cover|filters?|cloths?|bags?|roller|bracket|cordless|wet|dry|stick|white|black)$/i;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does `text` name `device` as a model the product is for (not a longer model, a predecessor, a comparison or a negation)? */
function namesAsListing(text, device) {
  for (const m of text.matchAll(new RegExp(`(?<![\\w-])${esc(device)}(?![\\w-])`, 'gi'))) {
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    const after = text.slice(m.index + m[0].length);
    if (/\b(not\s+(compatible|designed|suitable)\s+(with|for)|incompatible\s+with|(does\s+not|doesn't|won't)\s+(fit|work))\b[^.;:!?]*$/i.test(before) && !/\bother\b[^.;:!?]*$/i.test(before)) continue;
    if (/\b(upgraded?\s+from|replaces|vs\.?|versus|compared\s+(to|with)|than|successor\s+(to|of))\s+(the\s+)?(\w+\s+)?$/i.test(before)) continue;
    if (after.startsWith('+')) continue;
    const next = /^[ \t]+([A-Za-z0-9][\w+]*)/.exec(after)?.[1];
    if (next && /^\d+$/.test(next) && !/^[ \t]+\d+\s+years?\b/i.test(after)) continue;
    if (next && !/^\d+$/.test(next) && /^[A-Z]|\d/.test(next) && !GENERIC_AFTER.test(next)) continue;
    return true;
  }
  return false;
}
const isWholeDevice = (p) => /\bvacuums?\b/i.test(p.product_type ?? '') && !/accessor|warrant|trade|point/i.test(p.product_type ?? '');
const offStoreBrand = (store, name) => name.replace(new RegExp(`^${esc(store)}\\s+`, 'i'), '');

/** Honesty audit of one answer. Returns a list of fabricated facts (empty = honest). */
function audit(store, r, input) {
  const R = raw[store];
  const bad = [];
  const sc = r.sc ?? {};
  const prods = productsIn(sc);
  for (const p of prods) {
    const hit = R.variants.get(String(p.id));
    if (!hit) { bad.push(`unknown product id ${p.id}`); continue; }
    const price = Number(hit.v.price);
    const cap = hit.v.compare_at_price ? Number(hit.v.compare_at_price) : null;
    if (p.price !== price) bad.push(`${p.title}: price ${p.price} vs feed ${price}`);
    if (p.available !== hit.v.available) bad.push(`${p.title}: available ${p.available} vs feed ${hit.v.available}`);
    if (p.compare_at_price !== (cap !== null && cap > price ? cap : null)) bad.push(`${p.title}: compare_at ${p.compare_at_price} vs feed ${cap}`);
    if (p.title !== hit.p.title) bad.push(`title "${p.title}" vs feed "${hit.p.title}"`);
    const hay = [hit.p.title, ...hit.p.tags, htmlToText(hit.p.body_html), ...hit.p.options.flatMap((o) => o.values)];
    const listed = hay.flatMap((h) => findDevices(h).map((m) => m.device));
    for (const d of p.compatible_with ?? []) {
      if (!hay.some((h) => h.toLowerCase().includes(d.toLowerCase())) && !listed.some((x) => x.name === d)) bad.push(`${p.title}: lists "${d}", feed does not`);
    }
    // "Store lists it for your X and Y" in a why line must be true for every X.
    for (const w of p.why ?? []) {
      const m = /^Store lists it for your (.+?)(?:, but not for your .+)?$/.exec(w);
      if (!m) continue;
      for (const name of m[1].split(/, | and /)) {
        const dev = parseDevice(name);
        const literal = hay.some((h) => { const i = h.toLowerCase().indexOf(name.toLowerCase()); return i >= 0 && !/\b(not|n't)\s+\w+\s+(with|for)?[^.;]*$/i.test(h.slice(Math.max(0, i - 80), i)); });
        if (!listed.some((x) => deviceMatch(dev, x)) && !(dev.known === false && literal)) bad.push(`${p.title}: claims it is listed for ${name}`);
        if (dev.known === false) {
          const n = offStoreBrand(store, name);
          if (isWholeDevice(hit.p)) bad.push(`${p.title}: claims a device is listed for ${name}`);
          else if (!hay.some((h) => namesAsListing(h, n) || new RegExp(`(?<![\\w-])${esc(n)}\\s+series\\b`, 'i').test(h))) bad.push(`${p.title}: listed for ${name} only by substring`);
        }
      }
    }
  }
  for (const [product, e] of [[sc.product, sc.evidence], [sc.suggestion?.product, sc.suggestion?.evidence]]) {
    if (!product || !e) continue;
    const hit = R.variants.get(String(product.id));
    const src = hit ? { tags: hit.p.tags, title: [hit.p.title], description: [htmlToText(hit.p.body_html)], options: hit.p.options.flatMap((o) => o.values) }[e.source] ?? [] : [];
    if (!(e.source === 'tags' ? src.includes(e.quote) : src.some((s) => s.includes(e.quote)))) bad.push(`evidence quote not in feed: ${JSON.stringify(e)}`);
  }
  // A "confirmed" verdict needs a quote that really says so: it names the device, is not a negation
  // ("Not compatible with Saros 10R"), and a tag counts only when the tag IS the device (not "magsafe charger").
  const verdicts = sc.kind === 'compat' ? [{ device: sc.device, status: sc.status, evidence: sc.evidence }, ...(sc.also ?? [])] : [];
  for (const v of verdicts) {
    if (v.status !== 'confirmed' || !v.evidence) continue;
    const q = v.evidence.quote;
    const dev = parseDevice(v.device);
    const named = (text) => text.toLowerCase().includes(v.device.toLowerCase()) || findDevices(text).some((m) => deviceMatch(dev, m.device));
    if (!named(q)) bad.push(`confirmed ${v.device} with a quote that does not name it: "${q}"`);
    if (/\b(not|n't)\s+(compatible|work|fit)\w*\s+(with|for|on)?\b|\bincompatible\b/i.test(q) && new RegExp(`(not|n't)\\s+\\w+\\s+(with|for|on)?[^.;]*${v.device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(q)) {
      bad.push(`confirmed ${v.device} from a negation: "${q}"`);
    }
    // Meaning, not just a literal quote: for a model outside the dictionary the quote must list THIS model.
    if (!dev.known) {
      const n = offStoreBrand(store, v.device);
      const feedP = R.variants.get(String(sc.product?.id))?.p;
      if (feedP && isWholeDevice(feedP)) bad.push(`confirmed ${v.device} for a product that is itself a device: "${feedP.title}"`);
      else if (!namesAsListing(q, n) && !new RegExp(`(?<![\\w-])${esc(n)}\\s+series\\b`, 'i').test(q)) bad.push(`confirmed ${v.device} from a quote that names another model or no fit: "${q}"`);
    }
    if (v.evidence.source === 'tags') {
      const tag = q.replace(/^device:\s*/i, '').trim().toLowerCase();
      const m = findDevices(q.replace(/^device:\s*/i, ''));
      if (tag !== v.device.toLowerCase() && !(m.length === 1 && /^[\s\w]*$/.test(tag.slice(m[0].raw.length)))) bad.push(`confirmed ${v.device} from a merchandising tag "${q}"`);
    }
  }
  // A "no" must be the store's no for THIS model: "X only (Incompatible with other models ...)" is a yes for X.
  for (const v of verdicts) {
    if (v.status !== 'incompatible' || !v.evidence) continue;
    const n = offStoreBrand(store, v.device);
    if (new RegExp(`(?<![\\w-])${esc(n)}\\s+only\\b`, 'i').test(v.evidence.quote)) bad.push(`incompatible ${v.device} from a quote that says "${n} only": "${v.evidence.quote}"`);
  }
  // Spoken "yes" about compatibility only with a confirmed status.
  if (sc.kind === 'compat' && sc.status !== 'confirmed' && /^(yes|it (will|does) work|that works)/i.test(r.text)) bad.push(`says yes with status ${sc.status}`);
  // Every dollar amount spoken must be a real number: a feed price, an input budget, or a number in this answer.
  const allowed = new Set([...R.prices]);
  const ps = prods.map((p) => p.price);
  for (const p of prods) if (p.compare_at_price) allowed.add(money(p.compare_at_price - p.price));
  for (const a of ps) for (const b of ps) allowed.add(money(Math.abs(a - b)));
  for (const k of ['subtotal', 'total', 'max_price']) if (typeof sc[k] === 'number') allowed.add(sc[k]);
  if (sc.order) { allowed.add(sc.order.total); allowed.add(sc.order.subtotal); }
  for (const o of sc.orders ?? []) allowed.add(o.total);
  for (const l of sc.items ?? []) allowed.add(l.line_total);
  if (typeof input?.max_price === 'number') allowed.add(input.max_price);
  const need = typeof input?.need === 'string' ? input.need : '';
  for (const m of need.matchAll(/\$?(\d+(?:\.\d+)?)/g)) allowed.add(Number(m[1]));
  for (const m of `${r.text} ${sc.verdict ?? ''}`.matchAll(/\$(\d[\d,]*(?:\.\d{1,2})?)/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (![...allowed].some((a) => Math.abs(a - n) < 0.005)) bad.push(`spoken amount $${m[1]} is not in the feed or the answer`);
  }
  // Speech form: short, no URL, no SKU.
  const sentences = r.text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!r.text || sentences.length > 2) bad.push(`speech is ${sentences.length} sentences`);
  if (/https?:|www\.|\.com\b|\.net\b/i.test(r.text)) bad.push('speech has a URL');
  if ([...R.skus].some((s) => r.text.includes(s))) bad.push('speech has a SKU');
  return bad;
}

/** Behaviour checks for one step. Returns failure strings (empty = pass). */
function check(exp = {}, r, ctx) {
  const f = [];
  const sc = r.sc ?? {};
  const prods = sc.products ?? [];
  const titles = prods.map((p) => p.title);
  const e = resolveRef(exp, ctx);
  if (e.kind && sc.kind !== e.kind) f.push(`kind ${sc.kind} != ${e.kind}`);
  if (e.isError !== undefined && r.isError !== e.isError) f.push(`isError ${r.isError} != ${e.isError}`);
  if (e.code && sc.code !== e.code) f.push(`code ${sc.code} != ${e.code}`);
  if (e.minProducts !== undefined && prods.length < e.minProducts) f.push(`${prods.length} products < ${e.minProducts}`);
  if (e.maxProducts !== undefined && prods.length > e.maxProducts) f.push(`${prods.length} products > ${e.maxProducts}`);
  for (const s of [].concat(e.say ?? [])) if (!re(s).test(r.text)) f.push(`speech lacks /${s}/`);
  for (const s of [].concat(e.sayNot ?? [])) if (re(s).test(r.text)) f.push(`speech has /${s}/`);
  if (e.titlesNone) for (const t of titles) if (re(e.titlesNone).test(t)) f.push(`unwanted product "${t}"`);
  if (e.titlesAll) for (const t of titles) if (!re(e.titlesAll).test(t)) f.push(`off-target product "${t}"`);
  if (e.topTitle && !(titles[0] && re(e.topTitle).test(titles[0]))) f.push(`top is "${titles[0]}", wanted /${e.topTitle}/`);
  if (e.anyTitle && !titles.some((t) => re(e.anyTitle).test(t))) f.push(`no product matches /${e.anyTitle}/`);
  if (e.allAvailable && prods.some((p) => !p.available)) f.push('an out-of-stock product is offered');
  if (e.priceMax !== undefined) for (const p of prods) if (p.price > e.priceMax) f.push(`${p.title} $${p.price} > $${e.priceMax}`);
  if (e.priceBelow !== undefined) for (const p of prods) if (!(p.price < e.priceBelow)) f.push(`${p.title} $${p.price} not below $${e.priceBelow}`);
  if (e.status && ![].concat(e.status).includes(sc.status)) f.push(`status ${sc.status} != ${e.status}`);
  if (e.compareIds) {
    const got = (sc.products ?? []).map((p) => p.id).sort().join(',');
    if (got !== [...e.compareIds].sort().join(',')) f.push(`compared ${got}, wanted ${e.compareIds}`);
  }
  if (e.alreadyPlaced !== undefined && Boolean(sc.already_placed) !== e.alreadyPlaced) f.push(`already_placed ${sc.already_placed}`);
  if (e.orderId && sc.order?.id !== e.orderId && sc.orders?.[0]?.id !== e.orderId) f.push(`order id ${sc.order?.id ?? sc.orders?.[0]?.id} != ${e.orderId}`);
  if (e.ordersCount !== undefined && (sc.orders ?? []).length !== e.ordersCount) f.push(`${(sc.orders ?? []).length} orders != ${e.ordersCount}`);
  for (const d of [].concat(e.devicesHas ?? [])) if (!(sc.devices ?? []).includes(d)) f.push(`closet lacks "${d}": ${JSON.stringify(sc.devices)}`);
  if (e.devicesCount !== undefined && (sc.devices ?? []).length !== e.devicesCount) f.push(`closet has ${(sc.devices ?? []).length} devices != ${e.devicesCount}`);
  if (e.suggestionTitle && !(sc.suggestion && re(e.suggestionTitle).test(sc.suggestion.product.title))) f.push(`suggestion "${sc.suggestion?.product?.title}", wanted /${e.suggestionTitle}/`);
  if (e.deviceSource && sc.device_source !== e.deviceSource) f.push(`device_source ${sc.device_source} != ${e.deviceSource}`);
  if (e.rejected !== undefined && Boolean(r.rejected) !== e.rejected) f.push(`rejected ${Boolean(r.rejected)} != ${e.rejected}`);
  return f;
}

/** The offline agent: same router the simulator uses without an LLM. */
function checkRouter(spec, ctx) {
  const f = [];
  const s = resolveRef(spec, ctx);
  const screen = { products: [], ...(s.screen ? { products: [].concat(s.screen.products ?? []).map((p) => ({ id: p.id, title: p.title, price: p.price, available: p.available })) } : {}) };
  if (s.screen?.need) screen.need = s.screen.need;
  if (s.selected) screen.selected = s.selected;
  if (s.token) screen.token = s.token;
  const out = route(s.utterance, screen);
  const e = s.expect ?? {};
  if (e.tool && out.tool !== e.tool) f.push(`router -> ${out.tool ?? `say "${out.say}"`}, wanted ${e.tool}`);
  if (e.notTool && [].concat(e.notTool).includes(out.tool)) f.push(`router -> ${out.tool} (forbidden)`);
  if (e.say) { if (!out.say) f.push(`router -> ${out.tool}, wanted an honest line`); else if (!re(e.say).test(out.say)) f.push(`router says "${out.say}", wanted /${e.say}/`); }
  for (const [k, v] of Object.entries(e.args ?? {})) {
    const got = out.args?.[k];
    const ok = typeof v === 'string' && typeof got === 'string' ? re(v).test(got) : JSON.stringify(got) === JSON.stringify(v);
    if (!ok) f.push(`router arg ${k}=${JSON.stringify(got)}, wanted ${JSON.stringify(v)}`);
  }
  return { f, out };
}

/* ---------- 2. run ---------- */
const results = [];
let fabricated = 0;
let answers = 0;
const clients = [];
try {
  for (const c of cases) {
    const session = await login();
    const client = await connect(c.store, await authHeaders('session', session));
    clients.push(client);
    const ctx = { __store: c.store };
    const failures = [];
    const lies = [];
    const call = async (tool, a) => {
      const res = await client.callTool({ name: tool, arguments: a });
      const r = { text: res.content?.[0]?.text ?? '', sc: res.structuredContent ?? {}, isError: res.isError === true };
      answers++;
      for (const b of audit(c.store, r, a)) lies.push(`[${tool}] ${b}`);
      return r;
    };
    try {
      for (const [i, s] of (c.setup ?? []).entries()) ctx[`setup${i}`] = (await call(s.tool, resolveRef(s.args ?? {}, ctx))).sc;
      for (const [i, s] of (c.steps ?? []).entries()) {
        // A fresh connection = a new session: memory must come from the store, not the transport.
        // A step may switch store (same shopper) or identity (auth: none | x-user-id | forged | other).
        const store = s.store ?? c.store;
        const fresh = s.newSession || s.store || s.auth;
        const a = resolveRef(s.args ?? {}, ctx);
        let r;
        try {
          const cl = fresh ? await connect(store, await authHeaders(s.auth, session)) : client;
          if (fresh) clients.push(cl);
          const res = await cl.callTool({ name: s.tool, arguments: a });
          r = { text: res.content?.[0]?.text ?? '', sc: res.structuredContent ?? {}, isError: res.isError === true };
        } catch (err) {
          // The server refused the connection (HTTP 401 for a bad session): nothing was answered.
          if (err?.code !== 401 && !/\b401\b|unauthori[sz]ed|invalid_token|session (invalid|expired)/i.test(String(err?.message ?? err))) throw err;
          r = { text: '', sc: {}, isError: true, rejected: true };
        }
        answers++;
        if (!r.rejected) for (const b of audit(store, r, a)) lies.push(`[${s.tool}] ${b}`);
        ctx[`s${i}`] = r.sc;
        ctx[`t${i}`] = r.text;
        for (const x of check(s.expect, r, ctx)) failures.push(`step ${i} ${s.tool}: ${x}`);
        if (VERBOSE) console.log(`    ${c.id} ${s.tool}(${JSON.stringify(a)}) -> "${r.text}" ${(r.sc.products ?? []).map((p) => `| ${p.title} $${p.price}`).join(' ')}`);
      }
      if (c.router) {
        const { f, out } = checkRouter({ utterance: c.utterance, ...c.router }, ctx);
        failures.push(...f);
        if (VERBOSE) console.log(`    ${c.id} router -> ${JSON.stringify(out)}`);
      }
    } catch (err) {
      failures.push(`error: ${err.message}`);
    }
    fabricated += lies.length;
    const pass = failures.length === 0 && lies.length === 0;
    results.push({ id: c.id, store: c.store, holdout: c.holdout === true, trap: c.trap, utterance: c.utterance, pass, failures, lies });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(30)} ${c.utterance}`);
    for (const x of failures) console.log(`        - ${x}`);
    for (const x of lies) console.log(`        ! ${x}`);
  }
} finally {
  for (const cl of clients) await cl.close().catch(() => {});
  srv.kill();
  rmSync(WORK, { recursive: true, force: true });
}

const passed = results.filter((r) => r.pass).length;
const behaviour = results.filter((r) => r.failures.length === 0).length;
const honestCases = results.filter((r) => r.lies.length === 0).length;
const errs = serverLog.filter((l) => l.startsWith('ERR') || l.includes('mcp_error'));
console.log('\n=== Shop Counter shopper eval ===');
console.log(`snapshot: ${Object.entries(raw).map(([k, v]) => `${k} ${v.feed.products.length} products @ ${v.snapshotAt}`).join(', ')}`);
console.log(`cases: ${results.length} (satechi ${results.filter((r) => r.store === 'satechi').length}, roborock ${results.filter((r) => r.store === 'roborock').length}), tool answers audited: ${answers}`);
console.log(`behaviour: ${behaviour}/${results.length} = ${((100 * behaviour) / Math.max(1, results.length)).toFixed(1)}%  (target >= 90%)`);
console.log(`honesty:   ${honestCases}/${results.length} cases clean, fabricated facts: ${fabricated}  (target 0)`);
const ho = results.filter((r) => r.holdout);
if (ho.length) console.log(`held-out:  ${ho.filter((r) => r.pass).length}/${ho.length} (added after the fixes; first run 9/12, 2 expectations corrected, 1 router fix)`);
console.log(`overall:   ${passed}/${results.length} = ${((100 * passed) / Math.max(1, results.length)).toFixed(1)}%`);
console.log(`server log: ${errs.length} error lines`);
for (const l of errs.slice(0, 5)) console.log(`  ${l}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), behaviour, honest: honestCases, fabricated, total: results.length, results }, null, 2));
const ok = fabricated === 0 && behaviour / Math.max(1, results.length) >= 0.9;
process.exit(ok ? 0 : 1);
