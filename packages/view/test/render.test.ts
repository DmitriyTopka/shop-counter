// Render tests on fixtures: every kind draws its key facts, buttons call the right tool with the right args,
// and store text never becomes markup.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderResult } from '../src/render';
import type { ToolResultLike, ViewHost } from '../src/types';

const FIX = resolve(__dirname, '../fixtures');
const fx = (name: string) => JSON.parse(readFileSync(resolve(FIX, `${name}.json`), 'utf8'));
const res = (sc: unknown, text = 'spoken'): ToolResultLike => ({ content: [{ type: 'text', text }], structuredContent: sc });

function mkHost(reply: ToolResultLike = res({ kind: 'closet', devices: [] })) {
  const host: ViewHost & { shown: ToolResultLike[] } = {
    shown: [],
    callTool: vi.fn(async () => reply),
    show(r) { host.shown.push(r); },
  };
  return host;
}
function draw(sc: unknown, host = mkHost()) {
  const el = renderResult(res(sc), host);
  document.body.replaceChildren(el);
  return { el, host, text: el.textContent ?? '' };
}
const click = async (el: Element | null) => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); };

describe('every fixture renders without throwing', () => {
  for (const f of readdirSync(FIX).filter((n) => n.endsWith('.json'))) {
    it(f, () => {
      const { el } = draw(JSON.parse(readFileSync(resolve(FIX, f), 'utf8')));
      expect(el.tagName).toBe('SECTION');
      expect(el.textContent!.length).toBeGreaterThan(10);
    });
  }
});

describe('products', () => {
  it('shows 3 cards with photo, title, price, stock and 2 reasons', () => {
    const { el, text } = draw(fx('products'));
    const cards = el.querySelectorAll('.card');
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelector('img')!.getAttribute('src')).toMatch(/^https:\/\/cdn\.shopify\.com\//);
    expect(text).toContain('3-in-1 Foldable Wireless Charging Stand with Qi2 25W');
    expect(text).toContain('$129.99');
    expect(text).toContain('In stock');
    expect(cards[0].querySelectorAll('.why li')).toHaveLength(2);
    expect(text).toContain('My top 3 picks');
    expect(text).toContain('+9 more');
  });
  it('shows the discount when compare_at_price is higher', () => {
    const { text } = draw(fx('products_vacuum'));
    expect(text).toContain('$249.99');
    expect(text).toContain('Save $50');
  });
  it('Add to cart calls prepare_order with that product and shows the result', async () => {
    const { el, host } = draw(fx('products'), mkHost(res(fx('order_preview'))));
    await click(el.querySelectorAll('.card')[1].querySelector('.btn.primary'));
    expect(host.callTool).toHaveBeenCalledWith('prepare_order', { items: [{ id: '40908702089304', qty: 1 }] });
    expect(host.shown[0].structuredContent).toMatchObject({ kind: 'order_preview' });
  });
  it('Compare: picking 2 cards reveals the tray, which calls compare_products with both ids', async () => {
    const { el, host } = draw(fx('products_vacuum'), mkHost(res(fx('compare'))));
    const tray = el.querySelector('.tray') as HTMLElement;
    expect(tray.hidden).toBe(true);
    const cards = el.querySelectorAll('.card');
    await click(cards[0].querySelector('.btn.ghost'));
    expect(tray.hidden).toBe(true);
    await click(cards[2].querySelector('.btn.ghost'));
    expect(tray.hidden).toBe(false);
    expect(cards[2].querySelector('.btn.ghost')!.getAttribute('aria-pressed')).toBe('true');
    await click(tray.querySelector('button'));
    expect(host.callTool).toHaveBeenCalledWith('compare_products', { ids: ['42419567493238', '42224142909558'] });
  });
  it('marking cards tells the host which ones (so "compare them" by voice uses the same cards)', async () => {
    const host = Object.assign(mkHost(), { select: vi.fn() });
    const { el } = draw(fx('products_vacuum'), host);
    const cards = el.querySelectorAll('.card');
    await click(cards[0].querySelector('.btn.ghost'));
    await click(cards[2].querySelector('.btn.ghost'));
    expect(host.select).toHaveBeenLastCalledWith([expect.objectContaining({ id: '42419567493238' }), expect.objectContaining({ id: '42224142909558' })]);
    await click(cards[0].querySelector('.btn.ghost'));
    expect(host.select).toHaveBeenLastCalledWith([expect.objectContaining({ id: '42224142909558' })]);
  });
  it('out-of-stock product cannot be added', () => {
    const sc = fx('products');
    sc.products[0].available = false;
    const { el } = draw(sc);
    const b = el.querySelector('.card .btn.primary') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(el.textContent).toContain('Out of stock');
  });
  it('store text is never parsed as HTML', () => {
    const sc = fx('products');
    sc.products[0].title = '<img src=x onerror=alert(1)>Evil';
    const { el } = draw(sc);
    expect(el.querySelector('img[src="x"]')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>Evil');
  });
});

describe('compare', () => {
  it('draws a table with one column per product, rows, and the verdict', () => {
    const { el, text } = draw(fx('compare'));
    expect(el.querySelectorAll('thead th')).toHaveLength(4);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(text).toContain('10,000 Pa');
    expect(text).toContain('Q10 S5+ is the easy pick');
    expect(el.querySelector('tbody tr.same')!.textContent).toContain('Pet hair');
  });
  it('null value reads as "Not listed", never a guess', () => {
    const sc = fx('compare');
    sc.rows[1].values[1] = null;
    expect(draw(sc).text).toContain('Not listed');
  });
});

describe('compat', () => {
  it('confirmed shows the literal quote and its source', () => {
    const { el, text } = draw(fx('compat'));
    expect(el.classList.contains('ok')).toBe(true);
    expect(text).toContain('Listed for iPhone 15');
    expect(text).toContain('The store lists it');
    expect(text).not.toMatch(/Confirmed by the store/);
    expect(el.querySelector('blockquote')!.textContent).toBe('iPhone 15');
    expect(text).toContain('store compatibility tags');
  });
  it('not_listed says it will not guess and offers confirmed alternatives', async () => {
    const { el, text, host } = draw(fx('compat_not_listed'));
    expect(el.classList.contains('warn')).toBe(true);
    expect(text).toContain('Not confirmed for Galaxy S24');
    expect(text).toContain('No line in the store data');
    expect(el.querySelectorAll('.alt')).toHaveLength(2);
    await click(el.querySelector('.alt .btn'));
    expect(host.callTool).toHaveBeenCalledWith('prepare_order', { items: [{ id: '40908702089304', qty: 1 }] });
  });
  it('family_only says the store lists the series, not this model', () => {
    const sc = { ...fx('compat'), device: 'iPhone 17 Pro', device_source: 'closet', status: 'family_only', evidence: { source: 'tags', quote: 'iPhone 17' }, alternatives: [] };
    const { el, text } = draw(sc);
    expect(el.classList.contains('warn')).toBe(true);
    expect(text).toContain('Not listed for your iPhone 17 Pro specifically');
    expect(text).toContain('The store lists iPhone 17, not this exact model');
    expect(el.querySelector('.actions')).toBeNull(); // no Add to cart on a series-only listing
  });
  it('incompatible is red', () => {
    expect(draw(fx('compat_incompatible')).el.classList.contains('bad')).toBe(true);
  });
});

describe('order flow', () => {
  it('order_preview shows lines, totals and one Place order button that sends the token', async () => {
    const { el, text, host } = draw(fx('order_preview'), mkHost(res(fx('order'))));
    expect(text).toContain('Say “confirm” to buy');
    expect(text).toContain('Not ordered yet');
    expect(text).not.toMatch(/placed/i);
    expect(text).toContain('$279.99');
    expect(text).toContain('Free');
    expect(text).toContain('Nothing is charged');
    const primaries = el.querySelectorAll('.btn.primary');
    expect(primaries).toHaveLength(1);
    await click(primaries[0]);
    expect(host.callTool).toHaveBeenCalledWith('place_order', { confirmation_token: 'demo.eyJ1IjoibWF5YSJ9.sig' });
    expect(host.shown[0].structuredContent).toMatchObject({ kind: 'order' });
  });
  it('a failed call re-enables the button and says so', async () => {
    const host = mkHost();
    (host.callTool as any).mockRejectedValueOnce(new Error('boom'));
    const { el } = draw(fx('order_preview'), host);
    const b = el.querySelector('.btn.primary') as HTMLButtonElement;
    await click(b);
    expect(b.disabled).toBe(false);
    expect(el.querySelector('.status')!.textContent).toMatch(/went wrong/);
  });
  it('order shows id, status and ETA', () => {
    const { text } = draw(fx('order'));
    expect(text).toContain('Order placed');
    expect(text).toContain('#SC-10482');
    expect(text).toContain('Fri, Oct 16');
    expect(text).toContain('store estimate (demo)');
  });
  it('orders lists latest first with status pills', () => {
    const { el, text } = draw(fx('orders'));
    expect(el.querySelectorAll('.order')).toHaveLength(2);
    expect(text).toContain('On the way');
    expect(el.querySelector('.order')!.textContent).toContain('SC-10482');
  });
});

describe('contract v1.1 fields', () => {
  it('unknown shipping (null) is never shown as free', () => {
    const sc = fx('order_preview');
    sc.shipping = null;
    const { text } = draw(sc);
    expect(text).not.toContain('Free');
    expect(text).toContain('Set by the store');
    expect(text).toContain('Total before shipping & tax');
  });
  it('variant shows under the title', () => {
    const sc = fx('products');
    sc.products[1].variant = 'Black';
    expect(draw(sc).el.querySelectorAll('.card')[1].querySelector('.variant')!.textContent).toBe('Black');
  });
  it('eyebrow names the closet devices and budget', () => {
    const sc = fx('products');
    sc.for_devices = ['iPhone 15', 'MacBook Air'];
    sc.max_price = 120;
    expect(draw(sc).el.querySelector('.eyebrow')!.textContent).toBe('Satechi · for your iPhone 15 + MacBook Air · under $120');
  });
  it('compat note and also-list for other closet devices', () => {
    const sc = fx('compat');
    sc.note = 'Listed by the store for iPhone 15.';
    sc.also = [{ device: 'MacBook Air M2', status: 'not_listed', evidence: null }];
    const { el, text } = draw(sc);
    expect(text).toContain('Listed by the store for iPhone 15.');
    expect(el.querySelector('.also .st-not_listed')!.textContent).toContain('MacBook Air M2');
  });
  it('replayed token says already placed', () => {
    const sc = fx('order');
    sc.already_placed = true;
    expect(draw(sc).text).toContain('Already placed');
  });
  it('empty products shows the spoken reason', () => {
    const el = renderResult(res({ kind: 'products', store: 'Satechi', products: [] }, 'Nothing under $5 at Satechi.'), mkHost());
    expect(el.textContent).toContain('Nothing under $5 at Satechi.');
  });
});

describe('other kinds', () => {
  it('closet lists devices and home notes', () => {
    const { el, text } = draw(fx('closet'));
    expect(el.querySelectorAll('.devices li')).toHaveLength(4);
    expect(text).toContain('My devices');
    expect(text).toContain('Pets: cat');
  });
  it('closet icons follow the device kind', () => {
    const sc = { ...fx('closet'), devices: ['iPhone 17 Pro', 'MacBook Pro 2017 Intel', 'Roborock Saros 10R'], items: [{ name: 'iPhone 17 Pro', kind: 'phone' }, { name: 'MacBook Pro 2017 Intel', kind: 'laptop' }, { name: 'Roborock Saros 10R', kind: 'robot' }] };
    const icons = [...draw(sc).el.querySelectorAll('.devices li')].map((li) => li.getAttribute('data-icon'));
    expect(icons).toEqual(['device', 'laptop', 'robot']);
    // Older answers without kinds: guessed from the name, a vacuum never gets a phone icon.
    expect([...draw(fx('closet')).el.querySelectorAll('.devices li')].map((li) => li.getAttribute('data-icon'))).toEqual(['device', 'laptop', 'earbuds', 'plug']);
  });
  it('device_ambiguous asks which one and lists the options', () => {
    const el = renderResult(res({ kind: 'error', code: 'device_ambiguous', message: 'Which phone should I check: your iPhone 15 or Galaxy S24?', options: ['iPhone 15', 'Galaxy S24'] }), mkHost());
    expect(el.textContent).toContain('Which one?');
    expect(el.querySelectorAll('.devices li')).toHaveLength(2);
  });
  it('closet tip shows the store quote and adds that product to the cart', async () => {
    const p = fx('products').products[0];
    const sc = { ...fx('closet'), store: 'Roborock', suggestion: { device: 'Q7 M5', product: p, evidence: { source: 'title', quote: p.title } } };
    const { el, text, host } = draw(sc, mkHost(res(fx('order_preview'))));
    expect(text).toContain('shared with every store, now Roborock');
    expect(text).toContain('Roborock lists this for your Q7 M5');
    expect(el.querySelector('.tip blockquote')!.textContent).toBe(p.title);
    await click(el.querySelector('.tip .btn'));
    expect(host.callTool).toHaveBeenCalledWith('prepare_order', { items: [{ id: p.id, qty: 1 }] });
  });
  it('compat from the closet says it is your remembered device', () => {
    const sc = { ...fx('compat'), device: 'iPhone 15', device_source: 'closet' };
    const { text } = draw(sc);
    expect(text).toContain('Listed for your iPhone 15');
    expect(text).toContain('Your iPhone 15 · remembered');
  });
  it('the remembered-device line on a verdict carries the device icon (a robot for a robot vacuum)', () => {
    const robot = draw({ ...fx('compat'), device: 'Saros 10R', device_source: 'closet', status: 'incompatible' });
    expect(robot.el.querySelector('.eyebrow.remembered')!.getAttribute('data-icon')).toBe('robot');
    const phone = draw({ ...fx('compat'), device: 'iPhone 15', device_source: 'closet' });
    expect(phone.el.querySelector('.eyebrow.remembered')!.getAttribute('data-icon')).toBe('device');
  });
  it('refurbished cards carry a badge (stores reuse the new unit photo)', () => {
    const sc = fx('products');
    sc.products[0].title = '【Certified Refurbished 90% New】Roborock Q7 M5+ Robot Vacuum';
    const { el } = draw(sc);
    expect(el.querySelectorAll('.card')[0].querySelector('.tag-refurb')!.textContent).toBe('Refurbished');
    expect(el.querySelectorAll('.card')[1].querySelector('.tag-refurb')).toBeNull();
  });
  it('error shows a friendly message', () => {
    expect(draw(fx('error')).text).toContain('confirmation expired');
  });
  it('no structuredContent falls back to the spoken text', () => {
    const el = renderResult({ content: [{ type: 'text', text: 'Hello there' }] }, mkHost());
    expect(el.textContent).toBe('Hello there');
  });
});
