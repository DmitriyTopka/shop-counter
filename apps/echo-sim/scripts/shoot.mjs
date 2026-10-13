// Drives the simulator in headless Chrome and saves screenshots. Usage: node scripts/shoot.mjs screenshots [http://localhost:5180]
// Needs playwright-core (not a dependency on purpose): PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs
// and a Chrome binary (CHROME_PATH, default macOS Google Chrome). Simulator must run with the server up.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const out = process.argv[2];
const base = process.argv[3] ?? 'http://localhost:5180';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const wait = (ms) => page.waitForTimeout(ms);
const say = async (t) => { await page.evaluate((t) => window.sim.say(t), t); };
const snap = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('saved', name); };
const view = () => page.frameLocator('#app-layer iframe');
const capText = () => page.locator('#cap-alexa').textContent();

async function open(q) { await page.goto(`${base}/?mute&${q}`); await page.waitForFunction(() => window.sim && document.getElementById('proto').textContent.includes('protocol')); await wait(600); }

// Sam: vacuum flow
await open('user=sam');
await snap('01_home_show8');
await say('Find a robot vacuum under $300, I have a cat');
await view().locator('.card').nth(2).waitFor();
await wait(1200); await snap('02_products_with_caption');
await wait(6500); await snap('03_products');
// compare via the view: pick card 1 and 3, then tray
await view().locator('.card').nth(0).locator('.btn.ghost').click();
await view().locator('.card').nth(2).locator('.btn.ghost').click();
await wait(400); await snap('04_products_compare_picked');
await view().locator('.tray button').click(); // tap 'Compare 2' inside the MCP App
await view().locator('table.cmp').waitFor(); await wait(6500); await snap('05_compare_2_from_tap');
await say('find a robot vacuum under $300');
await view().locator('.card').nth(2).waitFor();
await say('Compare them');
await view().locator('table.cmp thead th:nth-child(4)').waitFor(); await wait(6500); await snap('05b_compare_3_by_voice');
await say('Order the third one');
await view().locator('.kind-order_preview').waitFor(); await wait(7000); await snap('06_order_preview');
// tap "Place order" inside the MCP App (view -> AppBridge -> MCP server)
await view().locator('.kind-order_preview .btn.primary').click();
await view().locator('.kind-order').waitFor(); await wait(1200); await snap('07_order_placed');
console.log('alexa said:', await capText());
// new session, memory across sessions
await page.click('#new-session'); await wait(800);
await say("Where's my order?");
await view().locator('.kind-orders').waitFor(); await wait(7000); await snap('08_orders_new_session');

// Maya: compatibility on Echo Show 15
await open('user=maya&device=show15');
await say('Find a wireless charger for my iPhone 15');
await view().locator('.card').nth(2).waitFor();
await say('Will the second one work with my iPhone 15?');
await view().locator('.kind-compat').waitFor(); await wait(7000); await snap('09_compat_confirmed_show15');
await say('Will the second one work with my Galaxy S24?');
await view().locator('.kind-compat.warn').waitFor(); await wait(7000); await snap('10_compat_not_listed_show15');
await say('What devices do I have?'); await wait(1500); await snap('11_router_no_ui_answer');
// panel hidden for video
await open('user=sam&nolog');
await say('Find a robot vacuum under $300, I have a cat');
await view().locator('.card').nth(2).waitFor(); await wait(7500); await snap('12_products_video_mode');
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
