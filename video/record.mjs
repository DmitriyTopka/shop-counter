// Records the demo flows in the Echo Show simulator (same approach as apps/echo-sim/scripts/shoot.mjs):
// headless Chrome drives window.sim.say(), screenshots go to video/frames/raw, every turn's real reply
// (what the shopper said, what Alexa said, which tools ran) goes to video/capture/transcript.json.
// Needs: simulator on :5180 (MCP_URL = live Lambda), brain on :8788, PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs
// Usage: node video/record.mjs [maya|sam|all]
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
const base = 'http://localhost:5180';
const tfile = join(CAP, 'transcript.json');
const transcript = existsSync(tfile) ? JSON.parse(readFileSync(tfile, 'utf8')) : {};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);
const snap = async (name) => { await page.screenshot({ path: join(RAW, `${name}.png`) }); };
const device = async () => page.locator('#device').boundingBox();

async function open(q) {
  await page.goto(`${base}/?mute&video&${q}`);
  await page.waitForFunction(() => window.sim && document.getElementById('proto').textContent.includes('protocol'));
  await wait(800);
}

// One shopper turn: frame while Alexa thinks, frame with Alexa's spoken line, frame with the clean screen.
async function turn(flow, key, text) {
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
  await wait(4200);
  await snap(`${key}_c_clean`);
  const rec = { key, shopper: text, alexa: info.said, model_text: info.full, tools: info.tools, llm_ok: info.llm.ok };
  flow.push(rec);
  console.log(key, '|', text, '->', info.tools.map((t) => t.name).join(','), '|', info.said);
  return rec;
}

if (which === 'maya' || which === 'all') {
  const flow = [];
  await open('user=maya&store=satechi&device=show15');
  await snap('maya_00_home');
  await turn(flow, 'maya_01', 'I just got an iPhone 15 and a MacBook Air');
  await turn(flow, 'maya_02', 'Find me a charger');
  await turn(flow, 'maya_03', 'Will this charger work with my phone?');
  await turn(flow, 'maya_04', 'Order it');
  await turn(flow, 'maya_05', 'Yes, confirm');
  await page.click('#new-session');
  await wait(1500);
  await snap('maya_06_newsession');
  await turn(flow, 'maya_07', "Where's my order?");
  await page.keyboard.press('l'); // the MCP activity panel, once, for the "how it's built" part
  await wait(800);
  await snap('maya_08_log');
  transcript.maya = { device: await device(), flow };
}

if (which === 'sam' || which === 'all') {
  const flow = [];
  await open('user=sam&store=satechi&device=show15');
  await snap('sam_00_home');
  await turn(flow, 'sam_01', 'I have a Roborock Saros 10R and a cat');
  await page.selectOption('#store', '/stores/roborock/mcp');
  await wait(2500);
  await snap('sam_02_store_switched');
  await turn(flow, 'sam_03', 'What devices do I have?');
  await turn(flow, 'sam_04', 'Will the Accessories Pack for Saros 10 fit my robot?');
  transcript.sam = { device: await device(), flow };
}

writeFileSync(tfile, JSON.stringify(transcript, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
