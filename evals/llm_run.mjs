// Live eval of the Alexa brain: Claude Haiku + skills/shop-counter/SKILL.md, as the simulator runs it.
//
//   node --import tsx evals/llm_run.mjs --dry               # no API calls: server, login, scenarios load
//   node --import tsx evals/llm_run.mjs                     # all scenarios in evals/llm_scenarios.json (costs money)
//   node --import tsx evals/llm_run.mjs --only a,b          # scenarios whose id starts with a or b
//   ... --out <dir>  (report.json + transcript.md, default: a temp dir)   --budget 0.90 (stop line, USD)
//
// The same path as the browser simulator (apps/echo-sim/src/main.ts runWithLLM):
//   shopper line -> apps/echo-sim/server/brain.mjs (system prompt + SKILL.md, tools from tools/list, Haiku)
//   -> tool_use blocks run through a REAL MCP client against the REAL Shop Counter server (frozen feed snapshot)
//   -> tool_result = spoken line + "[data shown on screen] {structuredContent minus images/urls}" -> brain again,
//   up to 5 steps per shopper line, history append-only per session.
// The API key is never read here: brain.mjs loads it from apps/echo-sim/.env. Its daily limit is raised for this
// run only, through its own env (DAILY_LIMIT_USD), and this script stops on its own budget line first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { cacheFileFor } from 'shelf-to-alexa';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'shop-counter');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry');
const ONLY = opt('--only')?.split(',').filter(Boolean);
const BUDGET = Number(opt('--budget') ?? 0.9);
const OUT = opt('--out') ?? mkdtempSync(join(tmpdir(), 'shop-counter-llm-'));
const STEPS = 5; // same as the simulator
// Official claude-haiku-5-5 rates are in brain.mjs (cost_usd). A conservative upper bound ($1 / $5 per 1M,
// cache write 1.25x, cache read 0.1x) is reported next to it.
const CONSERVATIVE = { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 };

const STORES = { satechi: 'https://satechi.net', roborock: 'https://us.roborock.com' };
const suite = JSON.parse(readFileSync(join(ROOT, 'evals', 'llm_scenarios.json'), 'utf8'));
const scenarios = suite.scenarios.filter((s) => !ONLY || ONLY.some((p) => s.id.startsWith(p)));

const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. frozen feed snapshot + the real server (as evals/run.mjs) ---------- */
const WORK = mkdtempSync(join(tmpdir(), 'shop-counter-llm-work-'));
const CACHE = join(WORK, 'cache');
mkdirSync(CACHE, { recursive: true });
for (const url of Object.values(STORES)) {
  const file = cacheFileFor(url);
  copyFileSync(join(APP, 'cache', file), join(CACHE, file));
  const feed = JSON.parse(readFileSync(join(CACHE, file), 'utf8'));
  feed.fetched_at = new Date().toISOString(); // fresh for the 6 h TTL: no network during the run
  writeFileSync(join(CACHE, file), JSON.stringify(feed));
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const procs = [];
const srv = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['--conditions=shelf-source', 'src/http.ts'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), SHOP_COUNTER_SECRET: randomBytes(24).toString('hex'), SHOP_COUNTER_STATE_DIR: join(WORK, 'state'), SHOP_COUNTER_CACHE_DIR: CACHE },
  stdio: ['ignore', 'ignore', 'pipe'],
});
procs.push(srv);
for (let i = 0; i < 150; i++) {
  try { if ((await (await fetch(`${BASE}/health`)).json()).server === 'shop-counter') break; } catch { /* not yet */ }
  await sleep(100);
}

/* ---------- 2. the brain proxy, as shipped, on its own port ---------- */
const BRAIN_PORT = await freePort();
const BRAIN = `http://127.0.0.1:${BRAIN_PORT}`;
let brainHealth = null;
if (!DRY) {
  const brain = spawn(process.execPath, ['server/brain.mjs'], {
    cwd: join(ROOT, 'apps', 'echo-sim'),
    env: { ...process.env, BRAIN_PORT: String(BRAIN_PORT), DAILY_LIMIT_USD: process.env.DAILY_LIMIT_USD ?? '1.00' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(brain);
  for (let i = 0; i < 100; i++) {
    try { brainHealth = await (await fetch(`${BRAIN}/health`)).json(); break; } catch { /* not yet */ }
    await sleep(100);
  }
  if (!brainHealth?.llm) {
    console.error(`brain not usable: ${JSON.stringify(brainHealth)}`);
    cleanup();
    process.exit(2);
  }
  console.log(`brain: ${brainHealth.model}, skill ${brainHealth.skill}, system ${brainHealth.system_chars} chars, spent today before this run $${brainHealth.spent_today} / limit $${brainHealth.limit_usd}`);
}

function cleanup() {
  for (const p of procs) p.kill();
  rmSync(WORK, { recursive: true, force: true });
}

async function login(profile) {
  const r = await fetch(`${BASE}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }) });
  if (!r.ok) throw new Error(`demo login failed: ${r.status}`);
  return r.json();
}
async function connect(store, token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/stores/${store}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'shop-counter-llm-eval', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

/* ---------- 3. what the simulator does with a tool result (main.ts spoken / forModel) ---------- */
const spoken = (r) => r?.content?.find((c) => c.type === 'text')?.text ?? '';
// main.ts clampSpeech: the host speaks at most two sentences of the model's reply (history unchanged).
function clampSpeech(text, max = 2) {
  const parts = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c$])/);
  return parts.length <= max ? text.trim() : parts.slice(0, max).join(' ');
}
function forModel(r) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!['image', 'url', 'handle', 'vendor', 'currency'].includes(k)) o[k] = strip(x);
      return o;
    }
    return v;
  };
  const sc = r?.structuredContent ? JSON.stringify(strip(r.structuredContent)) : '';
  return `${spoken(r)}${sc ? `\n[data shown on screen] ${sc.slice(0, 6000)}` : ''}`;
}
function resolveRef(v, ctx) {
  if (typeof v === 'string' && v.startsWith('$')) {
    let cur = ctx;
    for (const k of v.slice(1).replace(/\[(\d+)\]/g, '.$1').split('.')) cur = cur?.[k];
    return cur;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRef(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRef(x, ctx)]));
  return v;
}
const re = (s) => new RegExp(s, 'i');
const conservative = (u = {}) =>
  ((u.input_tokens ?? 0) * CONSERVATIVE.input + (u.output_tokens ?? 0) * CONSERVATIVE.output +
    (u.cache_creation_input_tokens ?? 0) * CONSERVATIVE.cache_write + (u.cache_read_input_tokens ?? 0) * CONSERVATIVE.cache_read) / 1e6;

/* ---------- 4. checks ---------- */
const MONEY_KEYS = new Set(['price', 'compare_at_price', 'subtotal', 'total', 'line_total', 'max_price', 'shipping']);
function collectNumbers(v, out) {
  if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (MONEY_KEYS.has(k) && typeof x === 'number') out.add(Math.round(x * 100) / 100); else collectNumbers(x, out); }
}
const textNumbers = (t, out) => { for (const m of String(t).matchAll(/(\d[\d,]*(?:\.\d{1,2})?)/g)) out.add(Number(m[1].replace(/,/g, ''))); };

// Promises the store data never makes. Allowed only if a tool line of this turn says the same.
const POLICY = [
  ['free shipping', /free shipping/i],
  ['cancelled', /\b(has been|is now|was|i've|i have)\s+cancel+ed\b|\byour order is cancel+ed\b/i],
  ['percent off', /\b\d+\s?(%|percent)\s?off\b/i],
  ['warranty term', /\b\d+[- ]?(year|month)s?\b[^.]*warranty|warranty[^.]*\b\d+[- ]?(year|month)/i],
  ['return window', /\b\d+[- ]?day\b[^.]*(return|refund)|(return|refund)[^.]*\b\d+[- ]?days?\b/i],
  ['promo code', /\bcode\s+[A-Z0-9]{4,}\b/],
  ['delivery promise', /\b(arrive|deliver(ed)?|get there|be there)\b[^.]*\b(by|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/i],
];
const YES = /\b(yes|yeah|yep|confirm|confirmed|place it|go ahead|do it|sure)\b/i;
const ASKS_MODEL = /\bwhich (iphone|phone|model|laptop|macbook|robot|vacuum|device)\b|\bwhat (model|kind of (phone|iphone|laptop|robot|vacuum))\b/i;

function checkTurn(turn, rec, sc) {
  const fails = [];   // behaviour (tool choice, expected speech)
  const lies = [];    // fabricated facts
  const form = [];    // speech form
  const e = turn.expect ?? {};
  const called = rec.tools.map((t) => t.name);
  for (const t of e.tools ?? []) if (!called.includes(t)) fails.push(`did not call ${t} (called: ${called.join(', ') || 'nothing'})`);
  for (const t of e.toolsNot ?? []) if (called.includes(t)) fails.push(`called forbidden ${t}`);
  for (const [tool, want] of Object.entries(e.args ?? {})) {
    const c = rec.tools.find((t) => t.name === tool);
    for (const [k, v] of Object.entries(want)) if (c && JSON.stringify(c.input?.[k]) !== JSON.stringify(v)) fails.push(`${tool}.${k}=${JSON.stringify(c.input?.[k])}, wanted ${JSON.stringify(v)}`);
  }
  for (const [tool, bad] of Object.entries(e.argsNot ?? {})) {
    const c = rec.tools.find((t) => t.name === tool);
    for (const [k, v] of Object.entries(bad)) if (c && typeof c.input?.[k] === 'string' && re(v).test(c.input[k])) fails.push(`${tool}.${k}="${c.input[k]}" (not a model, the closet should answer)`);
  }
  if (e.firstProduct) {
    const c = rec.tools.find((t) => t.name === 'check_compatibility');
    const first = sc.lastProducts?.[0]?.id;
    if (c && first && String(c.input?.product_id) !== String(first)) fails.push(`checked ${c.input?.product_id}, the first card was ${first}`);
  }
  const compat = rec.tools.filter((t) => t.name === 'check_compatibility' && !t.isError).at(-1);
  if (e.compat && compat?.sc?.status !== e.compat) fails.push(`compat status ${compat?.sc?.status}, wanted ${e.compat}`);
  for (const s of e.say ?? []) if (!re(s).test(rec.speech)) fails.push(`speech lacks /${s}/`);
  for (const s of e.sayNot ?? []) if (re(s).test(rec.speech)) fails.push(`speech has /${s}/`);

  // honesty: every spoken dollar amount must be a number the tools gave in this conversation (or the shopper said)
  for (const m of rec.speech.matchAll(/\$(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*dollars/gi)) {
    const n = Number((m[1] ?? m[2]).replace(/,/g, ''));
    const ok = [...sc.numbers].some((a) => Math.abs(a - n) < 0.005);
    if (!ok) lies.push(`spoken amount ${m[0]} not in any tool result or shopper line`);
  }
  // compatibility: "yes" only on confirmed
  if (compat && compat.sc?.status !== 'confirmed') {
    if (/^(yes|yep|yeah)\b|\bshould work\b|\b(it|that|this)('ll| will| does) work\b(?![^.]*\bnot\b)/i.test(rec.speech)) lies.push(`compat ${compat.sc?.status} but speech says it works: "${rec.speech}"`);
  }
  if (compat?.sc?.status === 'incompatible' && !/\b(no|not|won't|doesn't|isn't|can't|incompatible)\b/i.test(rec.speech)) lies.push('compat incompatible but speech does not say no');
  // invented policy
  const toolText = rec.tools.map((t) => t.text).join(' ');
  for (const [name, rx] of POLICY) if (rx.test(rec.speech) && !rx.test(toolText)) lies.push(`invented ${name}: "${rec.speech}"`);
  // order safety
  if (called.includes('place_order') && !(YES.test(turn.say) || turn.say.startsWith('[screen]'))) lies.push(`place_order without a clear yes ("${turn.say}")`);
  if (called.includes('place_order') && called.includes('prepare_order')) lies.push('prepare_order and place_order in the same turn');
  // closet: never ask for a model it already knows
  if (sc.closet.length && ASKS_MODEL.test(rec.speech)) fails.push(`asked for a model the closet has (${sc.closet.join(', ')})`);
  // form
  const sentences = rec.speech.split(/(?<=[.!?])\s+/).filter(Boolean);
  const words = rec.speech.split(/\s+/).filter(Boolean).length;
  if (!rec.speech) form.push('no speech');
  if (sentences.length > 2) form.push(`${sentences.length} sentences`);
  if (words > 35) form.push(`${words} words`);
  if (/https?:|www\.|\*\*|^\s*[-#*]\s/m.test(rec.speech)) form.push('markdown or URL in speech');
  return { fails, lies, form };
}

/* ---------- 5. run ---------- */
let spent = 0;
let spentConservative = 0;
let stopped = null;
const results = [];
const transcript = [];
const clients = [];

async function brainTurn(history, tools) {
  const t0 = Date.now();
  const res = await fetch(`${BRAIN}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history, tools }) });
  const data = await res.json().catch(() => null);
  const ms = Date.now() - t0;
  if (!res.ok || !data || data.fallback) throw new Error(`brain fallback: ${JSON.stringify(data).slice(0, 300)}`);
  spent += data.cost_usd ?? 0;
  spentConservative += conservative(data.usage);
  return { data, ms };
}

try {
  for (const s of scenarios) {
    if (stopped) break;
    const session = await login(s.profile ?? 'guest');
    let client = await connect(s.store, session.token);
    clients.push(client);
    const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const ctx = {};
    for (const [i, st] of (s.setup ?? []).entries()) ctx[`setup${i}`] = (await client.callTool({ name: st.tool, arguments: resolveRef(st.args ?? {}, ctx) })).structuredContent;
    const sc = { numbers: new Set(), closet: [], lastProducts: [] };
    let history = [];
    const turns = [];
    transcript.push(`\n## ${s.id} (${s.store}, ${s.profile})${s.trap ? `\n_${s.trap}_` : ''}\n`);
    for (const turn of s.turns) {
      if (DRY) { turns.push({ say: turn.say, dry: true }); continue; }
      if (spent >= BUDGET) { stopped = `budget line $${BUDGET} reached ($${spent.toFixed(4)})`; break; }
      if (turn.newSession) {
        const again = await login(s.profile ?? 'guest');
        client = await connect(turn.store ?? s.store, again.token);
        clients.push(client);
        history = [];
        transcript.push('\n_(new session: same shopper, new connection, empty history)_\n');
      }
      textNumbers(turn.say, sc.numbers);
      history.push({ role: 'user', content: [{ type: 'text', text: turn.say }] });
      transcript.push(`**Shopper:** ${turn.say}`);
      const rec = { say: turn.say, tools: [], speech: '', calls: 0, model_ms: 0, cost_usd: 0, cost_conservative: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      const t0 = Date.now();
      let error = null;
      try {
        let done = false;
        for (let step = 0; step < STEPS && !done; step++) {
          const { data, ms } = await brainTurn(history, tools);
          rec.calls++;
          rec.model_ms += ms;
          rec.cost_usd += data.cost_usd ?? 0;
          rec.cost_conservative += conservative(data.usage);
          for (const k of Object.keys(rec.usage)) rec.usage[k] += data.usage?.[k] ?? 0;
          history.push({ role: 'assistant', content: data.content }); // unchanged, thinking blocks included
          const uses = data.content.filter((b) => b.type === 'tool_use');
          const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          if (!uses.length) { rec.raw = text; rec.speech = clampSpeech(text) || 'Okay.'; rec.trimmed = rec.speech !== text; done = true; break; }
          const results = [];
          for (const u of uses) {
            try {
              const r = await client.callTool({ name: u.name, arguments: u.input ?? {} });
              const t = { name: u.name, input: u.input, text: spoken(r), sc: r.structuredContent ?? {}, isError: r.isError === true };
              rec.tools.push(t);
              collectNumbers(r.structuredContent, sc.numbers);
              textNumbers(t.text, sc.numbers);
              const prods = r.structuredContent?.products ?? [];
              for (const a of prods) for (const b of prods) sc.numbers.add(Math.round(Math.abs(a.price - b.price) * 100) / 100);
              if (r.structuredContent?.kind === 'products') sc.lastProducts = prods;
              if (r.structuredContent?.kind === 'closet') sc.closet = r.structuredContent.devices ?? [];
              transcript.push(`  - tool \`${u.name}\` ${JSON.stringify(u.input)} -> "${t.text}"`);
              results.push({ type: 'tool_result', tool_use_id: u.id, content: forModel(r), ...(r.isError ? { is_error: true } : {}) });
            } catch (err) {
              rec.tools.push({ name: u.name, input: u.input, text: `Tool failed: ${err?.message ?? err}`, sc: {}, isError: true });
              results.push({ type: 'tool_result', tool_use_id: u.id, content: `Tool failed: ${err?.message ?? err}`, is_error: true });
            }
          }
          history.push({ role: 'user', content: results });
          if (spent >= BUDGET) { stopped = `budget line $${BUDGET} reached mid-turn ($${spent.toFixed(4)})`; break; }
        }
        if (!done && !stopped) rec.speech = 'Sorry, that took too many steps. Could you say it another way?';
      } catch (err) {
        error = String(err?.message ?? err);
      }
      rec.ms = Date.now() - t0;
      const chk = error ? { fails: [`error: ${error}`], lies: [], form: [] } : checkTurn(turn, rec, sc);
      Object.assign(rec, chk);
      turns.push(rec);
      transcript.push(`**Alexa:** ${rec.speech}${rec.trimmed ? `  _(model said more, host cut: "${rec.raw}")_` : ''}`);
      transcript.push(`  _(${rec.calls} model calls, ${rec.ms} ms, $${rec.cost_usd.toFixed(5)})_${[...chk.fails, ...chk.lies, ...chk.form].length ? `  **issues:** ${[...chk.fails, ...chk.lies.map((x) => `LIE ${x}`), ...chk.form.map((x) => `FORM ${x}`)].join('; ')}` : ''}`);
      if (error || stopped) break;
    }
    const all = (k) => turns.flatMap((t) => t[k] ?? []);
    const complete = turns.length === s.turns.length;
    const r = {
      id: s.id, store: s.store, video: s.video === true, trap: s.trap, complete,
      tool_ok: complete && all('fails').length === 0,
      honest: all('lies').length === 0,
      form_ok: all('form').length === 0,
      fails: all('fails'), lies: all('lies'), form: all('form'),
      cost_usd: turns.reduce((a, t) => a + (t.cost_usd ?? 0), 0),
      turns,
    };
    r.pass = r.tool_ok && r.honest && r.form_ok;
    results.push(r);
    if (!DRY) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${s.id.padEnd(30)} tools ${r.tool_ok ? 'ok' : 'X'}  honest ${r.honest ? 'ok' : 'X'}  form ${r.form_ok ? 'ok' : 'X'}  $${r.cost_usd.toFixed(5)}  ${turns.map((t) => `${t.ms}ms`).join(' ')}`);
    else console.log(`DRY   ${s.id.padEnd(30)} ${s.turns.length} turns, ${tools.length} tools, setup ${(s.setup ?? []).length}`);
    for (const x of [...r.fails, ...r.lies.map((x) => `LIE ${x}`), ...r.form.map((x) => `FORM ${x}`)]) console.log(`        - ${x}`);
  }
} finally {
  for (const c of clients) await c.close().catch(() => {});
  cleanup();
}

if (!DRY) {
  const n = results.length;
  const cnt = (k) => results.filter((r) => r[k]).length;
  const allTurns = results.flatMap((r) => r.turns);
  const avg = (f) => (allTurns.length ? allTurns.reduce((a, t) => a + f(t), 0) / allTurns.length : 0);
  console.log('\n=== Shop Counter live brain eval (Claude Haiku + SKILL.md) ===');
  console.log(`scenarios: ${n}/${scenarios.length}${stopped ? ` (STOPPED: ${stopped})` : ''}, turns: ${allTurns.length}`);
  console.log(`pass: ${cnt('pass')}/${n} = ${((100 * cnt('pass')) / Math.max(1, n)).toFixed(1)}%   tools ${cnt('tool_ok')}/${n}   honest ${cnt('honest')}/${n}   form ${cnt('form_ok')}/${n}`);
  console.log(`spent: $${spent.toFixed(5)} (brain.mjs rates)   conservative bound ($1/$5): $${spentConservative.toFixed(5)}`);
  console.log(`host cut the model's reply to 2 sentences in ${allTurns.filter((t) => t.trimmed).length}/${allTurns.length} turns`);
  console.log(`per turn: avg $${avg((t) => t.cost_usd).toFixed(5)}, avg ${Math.round(avg((t) => t.ms))} ms (model ${Math.round(avg((t) => t.model_ms))} ms), avg ${avg((t) => t.calls).toFixed(2)} model calls`);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), model: brainHealth?.model, spent, spentConservative, stopped, results }, null, 2));
  writeFileSync(join(OUT, 'transcript.md'), `# Live brain transcripts (${new Date().toISOString()})\n${transcript.join('\n')}\n`);
  console.log(`report: ${join(OUT, 'report.json')}\ntranscript: ${join(OUT, 'transcript.md')}`);
}
