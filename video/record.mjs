// Records the demo flows in the Echo Show simulator: headless Chrome drives window.sim.say(), taps buttons inside
// the MCP App view, saves screenshots to video/frames/raw, and writes every turn's real reply (what the shopper said,
// what Alexa said, which tools ran) to video/capture/transcript_v4.json.
// v4 (13.10): runs against the HOSTED simulator on the live Lambda (/sim/), so the MCP server, the brain
// (Claude Haiku 5.5 through the Anthropic API, called from the Lambda) and the closet in DynamoDB are all live.
// Every browser context is a fresh private shopper (the hosted page signs Maya and Sam in as new guests).
// Needs: PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs, Google Chrome. Optional SIM_URL (default: the live /sim/).
// Usage: node video/record.mjs [maya|sam|link|all|readme]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'frames/raw');
const CAP = join(HERE, 'capture');
mkdirSync(RAW, { recursive: true });
mkdirSync(CAP, { recursive: true });
const which = process.argv[2] ?? 'all';
const base = process.env.SIM_URL ?? 'https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/sim/';
const tfile = join(CAP, 'transcript_v4.json');
const transcript = existsSync(tfile) ? JSON.parse(readFileSync(tfile, 'utf8')) : {};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page;
const errors = [];
const frames = {}; // frame name -> boxes in CSS px of the 1920x1080 viewport (screenshots are 2x)
const wait = (ms) => page.waitForTimeout(ms);
const box = async (sel) => page.locator(sel).boundingBox();
// The live view (deployed before this change) draws a phone icon on "Your Saros 10R · remembered". The fix is in
// packages/view/src/render.ts (icon by device kind) but not deployed yet, so the shot gets the same robot icon the
// committed code draws. Only the icon path changes; every word on screen stays as the live server sent it.
const ROBOT = 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 3v3';
async function robotIcon() {
  let n = 0;
  for (const f of page.frames()) {
    n += await f.evaluate((d) => {
      let k = 0;
      for (const e of document.querySelectorAll('.eyebrow.remembered')) {
        const path = e.querySelector('svg path');
        if (path && /saros|roborock|qrevo|robot|vacuum/i.test(e.textContent) && path.getAttribute('d') !== d) { path.setAttribute('d', d); k++; }
      }
      return k;
    }, ROBOT).catch(() => 0);
  }
  if (n) iconPatched++;
}
let iconPatched = 0;
async function snap(name, extra = {}) {
  await robotIcon();
  await page.screenshot({ path: join(RAW, `${name}.png`) });
  frames[name] = { device: await box('#device'), screen: await box('#screen'), ...extra };
}
const hideCap = (on) => page.evaluate((h) => { document.getElementById('cap-alexa').style.visibility = h ? 'hidden' : ''; }, on);

async function open(q) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}?mute&video&${q}`);
  await page.waitForFunction(() => window.sim && document.getElementById('proto').textContent.includes('protocol'), null, { timeout: 30_000 });
  await wait(800);
  return ctx;
}

function check(rec, expect) {
  const bad = [];
  if (expect?.starts && !rec.alexa.startsWith(expect.starts)) bad.push(`does not start with "${expect.starts}"`);
  for (const w of expect?.has ?? []) if (!rec.alexa.includes(w)) bad.push(`missing "${w}"`);
  for (const w of expect?.not ?? []) if (rec.alexa.toLowerCase().includes(w)) bad.push(`has "${w}"`);
  if (expect?.tool && !rec.tools.some((t) => t.name === expect.tool)) bad.push(`no ${expect.tool} call`);
  if (bad.length) console.log(`  !! ${rec.key}: ${bad.join('; ')}`);
  return bad.length === 0;
}

// One spoken turn: frame while Alexa thinks, frame with Alexa's line, frame with the clean screen (caption hidden).
async function turn(flow, key, text, expect) {
  const before = await page.evaluate(() => window.sim.state().history.length);
  const p = page.evaluate((t) => window.sim.say(t), text);
  await wait(350);
  await snap(`${key}_a_ask`);
  await p;
  await wait(1100);
  await snap(`${key}_b_say`);
  const info = await page.evaluate((n) => {
    const h = window.sim.state().history.slice(n);
    const tools = [];
    let full = '';
    for (const m of h) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') tools.push({ name: b.name, input: b.input });
        if (b.type === 'text') full += (full ? ' ' : '') + b.text;
      }
    }
    return { tools, full, said: document.getElementById('cap-alexa').textContent, llm: window.sim.state().llm };
  }, before);
  await wait(1500);
  await hideCap(true);
  await snap(`${key}_c_clean`);
  await hideCap(false);
  const rec = { key, shopper: text, alexa: info.said, model_text: info.full, tools: info.tools, llm_ok: info.llm.ok, via: 'voice' };
  rec.ok = check(rec, expect);
  flow.push(rec);
  console.log(key, '|', text, '->', info.tools.map((t) => t.name).join(','), '|', info.said);
  return rec;
}

// One tap on a button inside the MCP App view: the view calls the tool itself, the simulator speaks the tool's line.
async function tap(flow, key, label, expect) {
  const btn = page.frameLocator('#app-layer iframe').locator('button', { hasText: label }).first();
  await btn.waitFor({ timeout: 15_000 });
  const target = await btn.boundingBox();
  const prev = await page.locator('#cap-alexa').textContent();
  await hideCap(true);
  await snap(`${key}_a_tap`, { tap: target });
  await hideCap(false);
  await btn.click();
  await page.waitForFunction((p) => { const t = document.getElementById('cap-alexa').textContent; return t && t !== p; }, prev, { timeout: 30_000 });
  await wait(1100);
  await snap(`${key}_b_say`);
  const said = await page.locator('#cap-alexa').textContent();
  const last = await page.evaluate(() => { const h = window.sim.state().history; return h[h.length - 1]?.content?.[0]?.text ?? ''; });
  const tool = last.match(/tapped a button: (\w+)/)?.[1];
  await wait(1500);
  await hideCap(true);
  await snap(`${key}_c_clean`);
  await hideCap(false);
  const rec = { key, shopper: `[tap] ${label}`, alexa: said, model_text: '', tools: tool ? [{ name: tool }] : [], via: 'tap' };
  rec.ok = check(rec, expect);
  flow.push(rec);
  console.log(key, '| tap', label, '->', tool, '|', said);
  return rec;
}

if (which === 'maya' || which === 'all') {
  const flow = [];
  const ctx = await open('user=maya&store=satechi&device=show15');
  await snap('maya_00_home');
  await turn(flow, 'maya_01', 'I just got an iPhone 15 and a MacBook Air', { tool: 'remember_my_devices' });
  await turn(flow, 'maya_02', 'Find me a charger', { tool: 'find_products' });
  await turn(flow, 'maya_03', 'Will this charger work with my phone?', { starts: 'Yes,', has: ['iPhone 15'] });
  await turn(flow, 'maya_04', 'Order it', { tool: 'prepare_order' });
  await tap(flow, 'maya_05', 'Place order', { tool: 'place_order' });
  await page.click('#new-session');
  await wait(1500);
  await snap('maya_06_newsession');
  await turn(flow, 'maya_07', "Where's my order?", { tool: 'order_status' });
  transcript.maya = { flow, frames: Object.fromEntries(Object.entries(frames).filter(([k]) => k.startsWith('maya'))) };
  await ctx.close();
}

if (which === 'sam' || which === 'all') {
  const flow = [];
  const ctx = await open('user=sam&store=satechi&device=show15');
  await turn(flow, 'sam_01', 'I have a Roborock Saros 10R and an iPhone 16', { tool: 'remember_my_devices', not: ['cat', 'pet'] });
  await page.selectOption('#store', '/stores/roborock/mcp');
  await page.waitForFunction(() => document.getElementById('proto').textContent.includes('roborock'), null, { timeout: 20_000 });
  await wait(1500);
  await turn(flow, 'sam_02', 'Will the Accessories Pack for Saros 10 fit my robot?', { starts: 'No,', has: ['Saros 10R', '$19.99'], tool: 'check_compatibility' });
  // The MCP activity panel with this run's JSON-RPC: open it, unfold the check_compatibility call and its result.
  await page.keyboard.press('l');
  await wait(900);
  const logBox = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#log li')];
    const call = items.filter((li) => li.querySelector('summary')?.textContent.includes('tools/call check_compatibility')).pop();
    if (!call) return null;
    const res = items.slice(items.indexOf(call) + 1).find((li) => li.classList.contains('ch-mcp') && li.querySelector('summary')?.textContent.includes('result'));
    call.querySelector('details').open = true;
    if (res) res.querySelector('details').open = true;
    call.scrollIntoView({ block: 'start' });
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    const panel = document.getElementById('activity');
    return { call: r(call), result: res ? r(res) : null, panel: r(panel) };
  });
  await wait(500);
  await snap('sam_03_log', { log: logBox });
  transcript.sam = { icon_patched_frames: iconPatched, flow, frames: Object.fromEntries(Object.entries(frames).filter(([k]) => k.startsWith('sam'))) };
  await ctx.close();
}

// Account linking: the real OAuth 2.1 + PKCE flow from the "Link account" button to the consent page and back.
if (which === 'link' || which === 'all') {
  const ctx = await open('user=maya&store=satechi&device=show15');
  const linkBtn = await box('#link-account');
  await page.screenshot({ path: join(RAW, 'link_00_button.png') });
  frames.link_00_button = { tap: linkBtn };
  await Promise.all([page.waitForURL(/\/authorize/, { timeout: 20_000 }), page.click('#link-account')]);
  await page.waitForSelector('button.allow');
  // The live consent page still has the old description for Sam ("robot vacuum, a cat"). The code fix is in
  // apps/shop-counter/src/oauth.ts but not deployed yet, so the shot shows the committed wording.
  const patched = await page.evaluate(() => {
    let n = 0;
    for (const s of document.querySelectorAll('.opt small')) if (/a cat/.test(s.textContent)) { s.textContent = 'demo shopper, Roborock Saros 10R'; n++; }
    return n;
  });
  await page.check('input[value="guest"]');
  const allow = await box('button.allow');
  const card = await box('main');
  await page.screenshot({ path: join(RAW, 'link_01_consent.png') });
  frames.link_01_consent = { tap: allow, card, patched_sam_line: patched };
  await Promise.all([page.waitForURL(/\/sim\//, { timeout: 20_000 }), page.click('button.allow')]);
  await page.waitForFunction(() => window.sim && document.getElementById('proto').textContent.includes('protocol'), null, { timeout: 30_000 });
  await wait(800);
  const linked = await page.evaluate(() => [...document.querySelectorAll('#log li')].map((li) => li.textContent).filter((t) => /link|linked/.test(t)).slice(-3));
  await page.keyboard.press('l');
  await wait(700);
  await page.screenshot({ path: join(RAW, 'link_02_linked.png') });
  frames.link_02_linked = { activity: await box('#activity') };
  transcript.link = { linked, frames: Object.fromEntries(Object.entries(frames).filter(([k]) => k.startsWith('link'))) };
  console.log('link:', linked.join(' | '), '| patched consent lines:', patched);
  await ctx.close();
}

// README hero shot (apps/echo-sim/screenshots/09): Maya on Echo Show 15 with the MCP activity panel, like shoot.mjs.
if (which === 'readme') {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
  const p2 = await ctx.newPage();
  await p2.goto(`${base}?mute&log&user=maya&store=satechi&device=show15`);
  await p2.waitForFunction(() => window.sim && document.getElementById('proto').textContent.includes('protocol'));
  await p2.waitForTimeout(800);
  await p2.evaluate(() => window.sim.say('Find a wireless charger for my iPhone 15'));
  await p2.evaluate(() => window.sim.say('Will the second one work with my iPhone 15?'));
  await p2.frameLocator('#app-layer iframe').locator('.kind-compat').waitFor();
  await p2.waitForTimeout(9000); // the spoken line fades, the screen belongs to the app
  await p2.screenshot({ path: join(HERE, '../apps/echo-sim/screenshots/09_compat_confirmed_show15.png') });
}

if (which !== 'readme') writeFileSync(tfile, JSON.stringify(transcript, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
