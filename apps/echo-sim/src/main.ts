// Echo Show / Alexa+ simulator.
// - Real MCP client over Streamable HTTP (via the Vite proxy at /mcp). The shopper signs in through the
//   server's demo login and every request carries `Authorization: Bearer <signed session>`.
// - The shopper and the store are picked separately: the device closet belongs to the shopper and is
//   shared by every store (Maya's iPhone saved at Satechi is known at Roborock).
// - "Alexa" = Claude Haiku through the local brain proxy (/brain), or the keyword router when the proxy says fallback.
// - Tool results with _meta.ui are drawn by the MCP App view in a sandboxed iframe (AppBridge).
// - Every JSON-RPC message (server and view) and every brain turn goes to the MCP activity panel.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { AppHost } from './apphost';
import { LoggingTransport } from './logging-transport';
import { route, type ScreenProduct, type ScreenState } from './router';
import { canListen, listen, setMuted, speak, stopSpeaking } from './voice';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const __SIM_CONFIG__: { mcpUrl: string; profiles: { id: string; name: string; blurb: string; store?: string; mcpPath?: string; try: string[] }[] };
const CFG = __SIM_CONFIG__;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- state ----------------
const params = new URLSearchParams(location.search);
let profile = CFG.profiles.find((p) => p.id === params.get('user')) ?? CFG.profiles[0];
// Stores come from the profiles' home stores (Satechi at /mcp, Roborock at /stores/roborock/mcp).
const STORES = CFG.profiles
  .filter((p) => p.store && p.mcpPath)
  .map((p) => ({ name: p.store!, path: p.mcpPath! }))
  .filter((s, i, a) => a.findIndex((x) => x.path === s.path) === i);
const storeFor = (name: string | null | undefined) => STORES.find((s) => s.name.toLowerCase() === (name ?? '').toLowerCase());
let store = storeFor(params.get('store')) ?? storeFor(profile.store) ?? STORES[0];
const session: { profile?: string; token?: string; user?: string } = {};
let client: Client | null = null;
let tools: any[] = [];
let history: any[] = []; // Anthropic messages (append-only within a session)
const screen: ScreenState = { products: [] };
let llm = { ok: false, reason: 'checking', spent: 0, limit: 0.5 };
let busy = false;

// ---------------- activity log ----------------
type Channel = 'mcp' | 'ui' | 'llm' | 'sys';
const logEl = $('log');
function log(channel: Channel, dir: string, msg: any) {
  const li = document.createElement('li');
  li.className = `ev ch-${channel} ${dir === '!!' ? 'err' : ''}`;
  const method = msg?.method ?? (msg?.result !== undefined ? 'result' : msg?.error ? 'error' : msg?.note ?? '');
  const name = msg?.params?.name ? ` ${msg.params.name}` : msg?.params?.uri ? ` ${msg.params.uri}` : '';
  const id = msg?.id !== undefined ? `#${msg.id}` : '';
  const t = new Date();
  const ts = t.toTimeString().slice(0, 8);
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.innerHTML = `<span class="ts"></span><span class="dir"></span><span class="m"></span><span class="id"></span>`;
  (sum.children[0] as HTMLElement).textContent = ts;
  (sum.children[1] as HTMLElement).textContent = dir;
  (sum.children[2] as HTMLElement).textContent = `${method}${name}`;
  (sum.children[3] as HTMLElement).textContent = id;
  const pre = document.createElement('pre');
  const json = JSON.stringify(msg, (k, v) => (k === 'text' && typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}… (${v.length} chars)` : v), 2);
  pre.textContent = json.length > 12000 ? `${json.slice(0, 12000)}\n…` : json;
  det.append(sum, pre);
  li.append(det);
  logEl.append(li);
  while (logEl.children.length > 400) logEl.firstElementChild?.remove();
  logEl.scrollTop = logEl.scrollHeight;
}
const mcpLog = (d: any, m: any) => log('mcp', d, m);
const uiLog = (d: any, m: any) => log('ui', d, m);

// ---------------- screen helpers ----------------
const bar = $('lightbar');
type BarState = 'idle' | 'listening' | 'thinking' | 'speaking';
const setBar = (s: BarState) => (bar.dataset.state = s);

function caption(who: 'user' | 'alexa', text: string) {
  const el = $(who === 'user' ? 'cap-user' : 'cap-alexa');
  el.textContent = text;
  el.hidden = !text;
  el.classList.remove('gone');
  if (who === 'alexa') clearTimeout(capTimer);
  if (text) $('home').hidden = true;
}

function showHome() {
  $('home').hidden = false;
  $('app-area').hidden = true;
  syncLayer();
  caption('user', '');
  caption('alexa', '');
  $('home').hidden = false;
}

function tick() {
  const d = new Date();
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  $('clock').textContent = t;
  $('home-time').textContent = t;
}

function renderProfileUi() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('home-hi').textContent = `${part}, ${profile.name}`;
  const tiles = $('home-tiles');
  tiles.replaceChildren(
    ...profile.try.slice(0, 2).map((t, i) => {
      const d = document.createElement('div');
      d.className = 'tile';
      d.innerHTML = `<span class="tile-k"></span><span class="tile-v"></span>`;
      (d.children[0] as HTMLElement).textContent = i === 0 ? 'Try saying' : 'Then';
      (d.children[1] as HTMLElement).textContent = `“Alexa, ${t.charAt(0).toLowerCase()}${t.slice(1)}”`;
      return d;
    }),
  );
  const tries = $('tries');
  tries.replaceChildren(
    ...profile.try.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'try';
      b.textContent = t;
      b.addEventListener('click', () => handleUtterance(t));
      return b;
    }),
  );
}

function setMode() {
  const el = $('mode');
  if (llm.ok) {
    el.textContent = `Claude Haiku · $${llm.spent.toFixed(4)} / $${llm.limit.toFixed(2)} today`;
    el.className = 'badge llm';
    el.title = 'Alexa is played by Claude Haiku through the local brain proxy';
  } else {
    el.textContent = 'Offline router';
    el.className = 'badge router';
    el.title = `No LLM (${llm.reason}). Keyword router picks the tool, so the demo still works.`;
  }
}

// ---------------- MCP ----------------
// Context the view pushed (marked cards). Sent to the brain with the next utterance, used by the router now.
let viewContext: string | null = null;
const host = new AppHost($('app-layer'), {
  log: uiLog,
  onViewToolCall: viewToolCall,
  onModelContext: (p) => {
    const ids = p.structuredContent?.selected_ids;
    screen.selected = Array.isArray(ids) ? ids.map(String) : [];
    viewContext = (p.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ') || null;
    log('sys', '··', { note: `view context: ${screen.selected.length} marked`, selected: screen.selected });
  },
});

async function connect() {
  if (client) { try { await client.close(); } catch { /* ignore */ } }
  client = null;
  host.reset();
  const url = new URL(store?.path ?? profile.mcpPath ?? '/mcp', location.href);
  if (session.profile !== profile.id || !session.token) {
    // Demo sign-in. On Alexa+ this is account linking; here the server signs a session for the profile.
    const r = await fetch('/auth/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: profile.id }) });
    if (!r.ok) throw new Error(`demo login failed (${r.status})`);
    const s = await r.json();
    Object.assign(session, { profile: profile.id, token: s.token, user: s.user_id });
    log('sys', '··', { note: `signed in as ${profile.name} (${s.user_id}), session until ${s.expires_at}` });
  }
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${session.token}` } } });
  const c = new Client(
    { name: 'echo-show-simulator', version: '0.1.0' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } as any },
  );
  log('sys', '··', { note: `connect ${new URL(CFG.mcpUrl).origin}${url.pathname} as ${session.user} (signed session)` });
  await c.connect(new LoggingTransport(transport, mcpLog) as any);
  tools = (await c.listTools()).tools;
  client = c;
  $('proto').textContent = `protocol ${c.getNegotiatedProtocolVersion()} · ${tools.length} tools · ${store?.name ?? ''} ${url.pathname} · ${session.user}`;
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (!client) await connect();
  const r: any = await client!.callTool({ name, arguments: args });
  remember(r);
  return r;
}

/** keep what is on screen so the router (and the user's "the second one") can refer to it */
function remember(r: any) {
  const sc = r?.structuredContent;
  if (!sc?.kind) return;
  const slim = (p: any): ScreenProduct => ({ id: p.id, title: p.title, price: p.price, available: p.available });
  if (sc.kind === 'products') {
    screen.products = (sc.products ?? []).map(slim);
    screen.need = sc.need;
    screen.selected = []; // a new carousel starts with nothing marked
    viewContext = null;
  }
  if (sc.kind === 'orders') screen.products = (sc.orders?.[0]?.items ?? []).map((l: any) => slim(l.product));
  if (sc.kind === 'compare') screen.products = (sc.products ?? []).map(slim);
  if (sc.kind === 'compat') screen.products = [sc.product, ...(sc.alternatives ?? [])].filter(Boolean).map(slim);
  if (sc.kind === 'order_preview') screen.token = sc.confirmation_token;
  if (sc.kind === 'order') screen.token = undefined;
}

async function display(name: string, args: Record<string, unknown>, result: any) {
  const tool = tools.find((t) => t.name === name);
  const uri = tool ? getToolUiResourceUri(tool) : undefined;
  if (!uri) return;
  $('home').hidden = true;
  $('app-area').hidden = false;
  syncLayer();
  await host.show(client!, uri, args, result);
}

const spoken = (r: any) => r?.content?.find((c: any) => c.type === 'text')?.text ?? '';

/** compact copy of a tool result for the model: drop images/urls, keep ids, prices, facts */
function forModel(r: any): string {
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, x] of Object.entries(v)) if (!['image', 'url', 'handle', 'vendor', 'currency'].includes(k)) o[k] = strip(x);
      return o;
    }
    return v;
  };
  const sc = r?.structuredContent ? JSON.stringify(strip(r.structuredContent)) : '';
  return `${spoken(r)}${sc ? `\n[data shown on screen] ${sc.slice(0, 6000)}` : ''}`;
}

// A button inside the view called a tool.
async function viewToolCall(name: string, args: Record<string, unknown>) {
  setBar('thinking');
  try {
    const r = await callTool(name, args);
    const text = spoken(r);
    // tell the brain what happened on screen, so "confirm" or "the second one" keeps working by voice
    history.push({ role: 'user', content: [{ type: 'text', text: `[screen] The shopper tapped a button: ${name} ${JSON.stringify(args)}. Result: ${forModel(r)}` }] });
    say(text);
    return r;
  } catch (e: any) {
    setBar('idle');
    throw e;
  }
}

// ---------------- Alexa ----------------
let capTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string) {
  caption('alexa', text);
  speak(text, () => setBar('speaking'), () => {
    setBar('idle');
    // like Alexa: the spoken line fades away so the screen belongs to the app again
    if (!$('app-area').hidden) capTimer = setTimeout(() => $('cap-alexa').classList.add('gone'), 1500);
  });
}

async function brainTurn(): Promise<any | null> {
  const t0 = performance.now();
  const body = { messages: history, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  log('llm', '->', { note: 'brain turn', messages: history.length, last: history[history.length - 1] });
  const res = await fetch('/brain/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  const data = res ? await res.json().catch(() => null) : null;
  if (!res || !res.ok || !data || data.fallback) {
    llm = { ...llm, ok: false, reason: data?.reason ?? (res ? `http ${res.status}` : 'proxy offline') };
    log('llm', '!!', { note: 'brain unavailable, using keyword router', ...(data ?? {}) });
    setMode();
    return null;
  }
  llm = { ok: true, reason: '', spent: data.spent_today, limit: data.limit_usd };
  setMode();
  log('llm', '<-', { note: `${data.stop_reason} in ${Math.round(performance.now() - t0)} ms, $${data.cost_usd}`, usage: data.usage, content: data.content });
  return data;
}

// Like the server's clampSpeech (packages/shelf/src/service.ts): the host speaks at most two sentences of the
// model's reply, cut between sentences. The history keeps the reply unchanged (append-only, thinking blocks intact).
function clampSpeech(text: string, max = 2): string {
  const parts = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c$])/);
  return parts.length <= max ? text.trim() : parts.slice(0, max).join(' ');
}

async function runWithLLM(): Promise<boolean> {
  for (let step = 0; step < 5; step++) {
    const data = await brainTurn();
    if (!data) return false;
    history.push({ role: 'assistant', content: data.content }); // full content, thinking blocks included, unchanged
    const uses = data.content.filter((b: any) => b.type === 'tool_use');
    const text = data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
    if (!uses.length) {
      if (text) log('llm', '··', { note: 'spoken reply', said: clampSpeech(text), ...(clampSpeech(text) !== text ? { trimmed_from: text } : {}) });
      say(clampSpeech(text) || 'Okay.');
      return true;
    }
    const results: any[] = [];
    let lastUi: { name: string; args: any; r: any } | null = null;
    for (const u of uses) {
      try {
        const r = await callTool(u.name, u.input ?? {});
        results.push({ type: 'tool_result', tool_use_id: u.id, content: forModel(r), ...(r.isError ? { is_error: true } : {}) });
        if (tools.find((t) => t.name === u.name && getToolUiResourceUri(t))) lastUi = { name: u.name, args: u.input, r };
      } catch (e: any) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: `Tool failed: ${e?.message ?? e}`, is_error: true });
      }
    }
    history.push({ role: 'user', content: results });
    if (lastUi) await display(lastUi.name, lastUi.args, lastUi.r);
  }
  say('Sorry, that took too many steps. Could you say it another way?');
  return true;
}

async function runWithRouter(text: string) {
  const r = route(text, screen);
  if ('say' in r) {
    say(r.say);
    return;
  }
  log('sys', '··', { note: `router -> ${r.tool}`, args: r.args });
  const res = await callTool(r.tool, r.args);
  await display(r.tool, r.args, res);
  say(spoken(res) || 'Done.');
}

async function handleUtterance(raw: string) {
  const text = raw.trim();
  if (!text || busy) return;
  busy = true;
  stopSpeaking();
  caption('user', text);
  caption('alexa', '');
  setBar('thinking');
  try {
    if (!client) await connect();
    // Like an MCP Apps host: the view's latest context rides along with the next user message.
    const content: any[] = [{ type: 'text', text }];
    if (viewContext) content.unshift({ type: 'text', text: `[screen] ${viewContext}` });
    history.push({ role: 'user', content });
    const done = llm.ok || llm.reason === 'checking' ? await runWithLLM() : false;
    if (!done) await runWithRouter(text);
  } catch (e: any) {
    log('sys', '!!', { error: String(e?.message ?? e) });
    say(String(e?.message ?? '').includes('fetch') ? "I can't reach the store right now." : 'Sorry, something went wrong.');
  } finally {
    busy = false;
  }
}

// ---------------- device frame ----------------
function fit() {
  const scr = $('screen');
  const inner = $('screen-inner');
  // CSS zoom (not transform): the screen keeps device pixels (1280 wide) and the app iframe still
  // receives real pointer coordinates. With transform: scale, clicks inside the iframe miss.
  const scale = scr.clientWidth / 1280;
  inner.style.zoom = String(scale);
  syncLayer();
}

// The app iframe is NOT inside the zoomed screen: it sits in an unscaled layer over #app-area, so pointer
// events map 1:1 (scaled iframes break hit-testing for automation and screen recorders). The view fits
// itself to its width (see packages/view/src/main.ts).
function syncLayer() {
  const area = $('app-area');
  const layer = $('app-layer');
  if (area.hidden) { layer.hidden = true; return; }
  const s = $('screen').getBoundingClientRect();
  const r = area.getBoundingClientRect();
  Object.assign(layer.style, { left: `${r.left - s.left}px`, top: `${r.top - s.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  layer.hidden = false;
}

function setDevice(kind: string) {
  $('device').className = `device ${kind}`;
  document.querySelectorAll<HTMLButtonElement>('[data-device]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.device === kind)));
  requestAnimationFrame(fit);
}

// ---------------- wiring ----------------
function initUi() {
  const sel = $<HTMLSelectElement>('profile');
  for (const p of CFG.profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name} - ${p.blurb}`;
    sel.append(o);
  }
  sel.value = profile.id;
  sel.addEventListener('change', async () => {
    profile = CFG.profiles.find((p) => p.id === sel.value)!;
    store = storeFor(profile.store) ?? store;
    storeSel.value = store.path;
    await newSession();
  });
  // Store picker, next to the shopper: same shopper, another store, same remembered devices.
  const storeSel = document.createElement('select');
  storeSel.id = 'store';
  storeSel.setAttribute('aria-label', 'Store');
  for (const s of STORES) {
    const o = document.createElement('option');
    o.value = s.path;
    o.textContent = s.name;
    storeSel.append(o);
  }
  storeSel.value = store.path;
  storeSel.addEventListener('change', async () => {
    store = STORES.find((s) => s.path === storeSel.value) ?? store;
    await newSession();
  });
  const storeField = document.createElement('label');
  storeField.className = 'field';
  const storeLabel = document.createElement('span');
  storeLabel.textContent = 'Store';
  storeField.append(storeLabel, storeSel);
  sel.closest('.field')?.after(storeField);
  document.querySelectorAll<HTMLButtonElement>('[data-device]').forEach((b) => b.addEventListener('click', () => setDevice(b.dataset.device!)));
  if (params.get('device')) setDevice(params.get('device')!);
  $('new-session').addEventListener('click', () => newSession());
  const toggleLog = () => {
    const on = document.body.classList.toggle('no-log');
    $('toggle-log').setAttribute('aria-pressed', String(!on));
    requestAnimationFrame(fit);
  };
  $('toggle-log').addEventListener('click', toggleLog);
  // The JSON-RPC log is for developers: folded by default (L or ?log opens it). ?video = clean frame.
  if (!params.has('log') || params.has('nolog') || params.has('video')) toggleLog();
  document.body.classList.toggle('video', params.has('video'));
  $('clear-log').addEventListener('click', () => logEl.replaceChildren());
  $('remote').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>('say');
    const v = inp.value;
    inp.value = '';
    handleUtterance(v);
  });

  // voice in
  const mic = $('mic');
  if (!canListen) {
    mic.classList.add('off');
    mic.title = 'Voice input needs Chrome (Web Speech API). Typing works everywhere.';
  }
  let stop: (() => void) | null = null;
  const startListening = () => {
    if (!canListen || stop || busy) return;
    stopSpeaking();
    setBar('listening');
    mic.classList.add('on');
    caption('user', '…');
    stop = listen({
      interim: (t) => caption('user', t || '…'),
      final: (t) => { stop = null; mic.classList.remove('on'); handleUtterance(t); },
      end: () => { stop = null; mic.classList.remove('on'); if (bar.dataset.state === 'listening') { setBar('idle'); if ($('cap-user').textContent === '…') caption('user', ''); } },
      error: (err) => log('sys', '!!', { note: `speech recognition: ${err}` }),
    });
  };
  mic.addEventListener('click', () => (stop ? stop() : startListening()));
  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT';
    if (e.code === 'Space' && !typing && !e.repeat) { e.preventDefault(); startListening(); }
    if (e.key.toLowerCase() === 'l' && !typing) toggleLog();
    if (e.key.toLowerCase() === 'm' && !typing) { const m = !document.body.classList.toggle('sound'); setMuted(m); }
  });
  document.body.classList.toggle('sound', !params.has('mute'));

  new ResizeObserver(fit).observe($('screen'));
  new ResizeObserver(syncLayer).observe($('app-area'));
  tick();
  setInterval(tick, 15_000);
}

async function newSession() {
  history = [];
  screen.products = [];
  screen.token = undefined;
  screen.selected = [];
  screen.need = undefined;
  viewContext = null;
  stopSpeaking();
  setBar('idle');
  renderProfileUi();
  showHome();
  log('sys', '··', { note: `new session for ${profile.name} at ${store?.name} (conversation cleared; devices are remembered per shopper, orders per store)` });
  try {
    await connect();
  } catch (e: any) {
    log('sys', '!!', { error: `MCP connect failed: ${e?.message ?? e}. Is the server running at ${CFG.mcpUrl}?` });
    $('proto').textContent = `cannot reach ${CFG.mcpUrl}`;
  }
}

async function checkBrain() {
  const st = await fetch('/brain/health').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  llm = st ? { ok: st.llm, reason: st.reason ?? '', spent: st.spent_today, limit: st.limit_usd } : { ok: false, reason: 'proxy offline', spent: 0, limit: 0.5 };
  log('llm', '··', { note: st ? `brain: ${st.llm ? `${st.model}, $${st.spent_today} of $${st.limit_usd} today` : `no LLM (${st.reason})`}` : 'brain proxy offline, keyword router active' });
  setMode();
}

initUi();
renderProfileUi();
await Promise.all([checkBrain(), newSession()]);
fit();
(window as any).sim = { say: handleUtterance, state: () => ({ screen, history, llm }) }; // handy for demos/tests
